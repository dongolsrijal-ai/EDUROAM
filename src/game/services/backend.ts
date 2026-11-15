// Supabase client for the browser: persistent player identity (Supabase Auth) and the
// publishable key only. Secrets (Gemini key, secret API key) live in Edge Function secrets.
//
// Sign-in: email + password, or a one-time 6-digit email CODE typed into the game (signInWithOtp
// with shouldCreateUser: false + verifyOtp type "email"), which works when the email is read on
// another device. Password reset: resetPasswordForEmail, then the 6-digit code from that email
// (verifyOtp type "recovery") or its link (PASSWORD_RECOVERY), then updateUser({ password }).
// The email templates decide whether an email shows a code ({{ .Token }}) or only a link
// (supabase/templates/, BACKEND_HANDOFF.md "Email codes + password reset").
// The Supabase Auth user id is the account id; the game's local "player_..." id is separate
// and only recorded on the player row (players.legacy_local_id).
//
// Configure VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local
// (see .env.example and docs/ai-tutoring-backend.md). Without them the game runs fully local.

import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { getPlayerIdentity, linkAuthUser } from '../data/playerIdentity';
import {
    cooldownRemaining, describeAuthError, describeCodeError, describePasswordError, describeRedirectError, formatWait, frequencyWaitSeconds,
    isNoAccountForCode, isValidEmail, isValidOtp, normalizeEmail, normalizeOtp, OTP_ENTRY_WINDOW_MS, parseRetryAfter, passwordProblem,
    readAuthCallback, type AuthCallback, type AuthErrorLike,
} from './authFlow';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const backendConfigured = Boolean(url && publishableKey);
export const publicConfig = { url: url ?? '', publishableKey: publishableKey ?? '' };

type SessionListener = (session: Session | null, event: AuthChangeEvent) => void;

let client: SupabaseClient | null = null;
let current: Session | null = null;
const listeners = new Set<SessionListener>();
/** A password-reset link (or code) signed the player in to choose a new password. */
const recoveryListeners = new Set<() => void>();
/** Same account, changed profile (a guest became a permanent account, email confirmed). */
const profileListeners = new Set<(session: Session | null) => void>();
let linkedUserId: string | null = null;
let callback: AuthCallback | null = null;

/** The shared client (one per page). */
export function supabase (): SupabaseClient
{
    if (!backendConfigured) throw new Error('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).');
    if (!client)
    {
        // Read before the client consumes it: an email link / OAuth redirect may carry tokens.
        callback = typeof window !== 'undefined' ? readAuthCallback(window.location.href) : null;
        client = createClient(url!, publishableKey!, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'eduroam.auth' },
            global: { fetch: fetchNotingRetryAfter },
        });
        client.auth.onAuthStateChange(handleAuthEvent);
    }
    return client;
}

/**
 * INITIAL_SESSION  restored from storage on load (or null)   -> notify
 * SIGNED_IN        code verified / other tab signed in         -> notify if the user changed
 * TOKEN_REFRESHED  same user, new access token                 -> keep state, no UI reset
 * USER_UPDATED     same user, new profile data                 -> keep state
 * SIGNED_OUT       session ended (here or in another tab)      -> notify
 */
function handleAuthEvent (event: AuthChangeEvent, session: Session | null)
{
    const previousUser = current?.user.id ?? null;
    const previousProfile = `${current?.user.email ?? ''}|${current?.user.is_anonymous === true}`;
    current = session;
    const user = session?.user.id ?? null;
    // Deferred: Supabase calls inside this callback would wait on the auth lock.
    if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) setTimeout(() => void linkLocalPlayer(session), 0);
    if (event === 'SIGNED_OUT') { linkedUserId = null; clearRecovery(); }
    if (event === 'PASSWORD_RECOVERY' && session)
    {
        // A reset link or reset code signed this account in: no village until a new password is saved.
        markRecovery(session.user.id);
        setTimeout(() => recoveryListeners.forEach((fn) => fn()), 0);
    }
    if (event === 'INITIAL_SESSION' || user !== previousUser)
    {
        listeners.forEach((fn) => fn(session, event));
    }
    if (`${session?.user.email ?? ''}|${session?.user.is_anonymous === true}` !== previousProfile) profileListeners.forEach((fn) => fn(session));
}

/** Called when the same account's email / guest status changes (e.g. after a guest upgrade). */
export function onProfileChange (fn: (session: Session | null) => void)
{
    profileListeners.add(fn);
    return () => { profileListeners.delete(fn); };
}

/** True while signed in with a guest (anonymous) account. */
export function isGuest (): boolean
{
    return current?.user.is_anonymous === true;
}

export interface InitResult
{
    signedIn: boolean;
    /** An auth redirect was present in the URL (old email link / future OAuth). */
    fromRedirect: boolean;
    redirectError: string | null;
}

/**
 * Starts auth early: restores a saved session and finishes any redirect, then cleans the URL.
 * A password-reset link is recognised only when the restored session is the one that link
 * created (same access token), so an older saved session is never mistaken for a reset.
 */
export async function initBackend (): Promise<InitResult | null>
{
    if (!backendConfigured) return null;
    const { data } = await supabase().auth.getSession(); // waits for initialisation (incl. URL detection)
    // supabase-js delivers a link's PASSWORD_RECOVERY just after initialising: let it land first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const session = data.session;
    if (session && callback?.type === 'recovery' && callback.accessToken && session.access_token === callback.accessToken) markRecovery(session.user.id);
    const result = {
        signedIn: Boolean(session), fromRedirect: Boolean(callback?.present),
        redirectError: callback?.present ? describeRedirectError(callback) : null,
    };
    if (callback?.present) window.history.replaceState(window.history.state, '', callback.cleanUrl);
    if (callback) callback.accessToken = null;
    return result;
}

export async function getSession (): Promise<Session | null>
{
    if (!backendConfigured) return null;
    const { data } = await supabase().auth.getSession();
    return data.session;
}

export function currentUserEmail (): string | null
{
    return current?.user.email ?? (current?.user.is_anonymous ? 'guest' : null);
}

/** Called with the session whenever the signed-in account changes (and once on load). */
export function onSessionChange (fn: SessionListener)
{
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export type AuthResult = { ok: true; message: string } | { ok: false; error: string };

// ------------------------------------------------------------------ email one-time codes

const PENDING_KEY = 'eduroam.authCode';

export interface PendingCode
{
    email: string;
    sentAt: number;
    /** What the emailed code is for (older records have none: a sign-in code). */
    kind?: 'signin' | 'reset' | 'signup';
}

/** The last email request, however old (null if none). */
function lastRequest (): PendingCode | null
{
    try
    {
        const raw = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null');
        if (raw && typeof raw.email === 'string' && typeof raw.sentAt === 'number') return raw;
        return null;
    }
    catch { return memoryPending; }
}

/** The last code request (kept across reloads so the resend cooldown and code entry survive). */
export function pendingCode (): PendingCode | null
{
    const raw = lastRequest();
    return raw && Date.now() - raw.sentAt < OTP_ENTRY_WINDOW_MS ? raw : null;
}

/** When the code being typed for `email` was requested (to tell an expired code from a wrong one). */
function codeSentAt (email: string, kind: PendingCode['kind']): number | null
{
    const raw = lastRequest();
    return raw && raw.email === email && (raw.kind ?? 'signin') === kind ? raw.sentAt : null;
}

function setPending (value: PendingCode | null)
{
    try
    {
        if (value) localStorage.setItem(PENDING_KEY, JSON.stringify(value));
        else localStorage.removeItem(PENDING_KEY);
    }
    catch { /* storage unavailable: cooldown only lasts for this page */ }
    memoryPending = value;
}
let memoryPending: PendingCode | null = null;

/** Set only when Supabase rejected a code request WITH a Retry-After header. */
const BLOCKED_KEY = 'eduroam.authRetryAt';
let lastOtpRetryAfter: number | null = null;

/** supabase-js errors don't carry headers, so note Retry-After on the OTP endpoint here. */
const fetchNotingRetryAfter: typeof fetch = async (input, init) =>
{
    const response = await fetch(input, init);
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (response.status === 429 && /\/auth\/v1\/(otp|recover|resend)/.test(target)) lastOtpRetryAfter = parseRetryAfter(response.headers.get('Retry-After'));
    return response;
};

function retryAt (): number
{
    try { return Number(localStorage.getItem(BLOCKED_KEY)) || 0; }
    catch { return memoryRetryAt; }
}
function setRetryAt (at: number)
{
    memoryRetryAt = at;
    try { if (at) localStorage.setItem(BLOCKED_KEY, String(at)); else localStorage.removeItem(BLOCKED_KEY); }
    catch { /* memory only */ }
}
let memoryRetryAt = 0;

/**
 * Seconds before another code may be requested: the 60 s resend cooldown after a code was
 * ACCEPTED, or the server's Retry-After after a rejection. A rejection without Retry-After
 * starts no countdown (a fake 60 s wait would not lift an hourly quota).
 */
export function resendCooldown (): number
{
    const last = lastRequest(); // storage, or memory only when storage is unavailable
    const resend = last ? cooldownRemaining(last.sentAt) : 0;
    const server = Math.max(0, Math.ceil((retryAt() - Date.now()) / 1000));
    return Math.max(resend, server);
}

/**
 * A rejected email request: no email exists, so no code-entry step and no resend cooldown, except
 * a wait the server stated (Retry-After, or "only request this after N seconds"), for that long.
 */
function rejectedEmail (error: AuthErrorLike, describe: (error: AuthErrorLike, retryAfter: number | null) => string): AuthResult
{
    const retryAfter = (error.status === 429 ? lastOtpRetryAfter : null) ?? frequencyWaitSeconds(error);
    if (retryAfter) setRetryAt(Date.now() + retryAfter * 1000);
    return { ok: false, error: describe(error, retryAfter) };
}

function emailSent (email: string, kind: NonNullable<PendingCode['kind']>)
{
    setRetryAt(0);
    setPending({ email, sentAt: Date.now(), kind });
}

/**
 * Emails a 6-digit sign-in code to an EXISTING account (never creates one). Never retried
 * automatically; respects the resend cooldown. An address without an account gets the same
 * answer as one with an account, so this screen never reveals who is registered.
 */
export async function sendEmailCode (email: string): Promise<AuthResult>
{
    const address = normalizeEmail(email);
    if (!isValidEmail(address)) return { ok: false, error: 'Please enter a valid email address.' };
    const wait = resendCooldown();
    if (wait > 0) return { ok: false, error: `Please wait ${formatWait(wait)} before requesting another code.` };

    lastOtpRetryAfter = null;
    const { error } = await supabase().auth.signInWithOtp({
        email: address,
        // Sign in only. The redirect is used only if the template still contains a link.
        options: { shouldCreateUser: false, emailRedirectTo: returnUrl() },
    });
    if (error && !isNoAccountForCode(error)) return rejectedEmail(error, (e, retryAfter) => describeAuthError(e, 'send', retryAfter));
    emailSent(address, 'signin');
    return { ok: true, message: `If ${address} has an EDUROAM account, a 6-digit sign-in code is on its way. It can take a minute to arrive.` };
}

/** Verifies the sign-in code; on success Supabase stores the session and fires SIGNED_IN. */
export async function verifyEmailCode (email: string, code: string): Promise<AuthResult>
{
    const address = normalizeEmail(email);
    const token = normalizeOtp(code);
    if (!isValidOtp(token)) return { ok: false, error: 'Enter the 6-digit code from the email.' };
    const { data, error } = await supabase().auth.verifyOtp({ email: address, token, type: 'email' });
    if (error || !data.session) return { ok: false, error: describeCodeError(error ?? { message: 'No session returned.' }, codeSentAt(address, 'signin')) };
    setPending(null);
    clearRecovery();
    return { ok: true, message: `Signed in as ${address}.` };
}

let guestEnabled: Promise<boolean> | null = null;

/** Whether the project allows anonymous (guest) sign-ins, from the public Auth settings. */
export function guestSignInEnabled (): Promise<boolean>
{
    if (!backendConfigured) return Promise.resolve(false);
    guestEnabled ??= fetch(`${url}/auth/v1/settings`, { headers: { apikey: publishableKey! } })
        .then((res) => (res.ok ? res.json() : null))
        .then((settings) => settings?.external?.anonymous_users === true)
        .catch(() => false);
    return guestEnabled;
}

/** Guest account (needs "Anonymous sign-ins" enabled in Supabase Auth). Not merged with email accounts. */
export async function signInAsGuest (): Promise<AuthResult>
{
    const { error } = await supabase().auth.signInAnonymously();
    if (error)
    {
        return { ok: false, error: /anonymous/i.test(error.message) ? 'Guest accounts are turned off for this game. Sign in with an email code instead.' : describeAuthError(error, 'send') };
    }
    return { ok: true, message: 'Signed in as a guest.' };
}

// ------------------------------------------------------------------ email + password

/** Where confirmation links return to: this game page (must be an allowed redirect URL in Supabase Auth). */
const returnUrl = () => window.location.origin + window.location.pathname;

/** Signs in with email + password. */
export async function signInWithPassword (email: string, password: string): Promise<AuthResult>
{
    const address = normalizeEmail(email);
    if (!isValidEmail(address)) return { ok: false, error: 'Please enter a valid email address.' };
    if (!password) return { ok: false, error: 'Enter your password.' };
    const { data, error } = await supabase().auth.signInWithPassword({ email: address, password });
    if (error || !data.session) return { ok: false, error: describePasswordError(error ?? { message: 'No session returned.' }, 'signin') };
    clearRecovery(); // they know their password: no half-finished reset applies any more
    return { ok: true, message: `Signed in as ${address}.` };
}

export type RegisterResult = AuthResult & { confirm?: boolean };

/**
 * Creates an email + password account. With email confirmation on (this project), no session
 * is returned: the player confirms with the emailed link or code (confirmSignUp).
 */
export async function registerAccount (email: string, password: string, confirm: string): Promise<RegisterResult>
{
    const address = normalizeEmail(email);
    if (!isValidEmail(address)) return { ok: false, error: 'Please enter a valid email address.' };
    const problem = passwordProblem(password, confirm);
    if (problem) return { ok: false, error: problem };
    const { data, error } = await supabase().auth.signUp({ email: address, password, options: { emailRedirectTo: returnUrl() } });
    if (error) return { ok: false, error: describePasswordError(error, 'signup') };
    if (data.session) return { ok: true, message: `Account created. Signed in as ${address}.` };
    // Supabase answers an already-registered email with a user that has no identities (no email sent).
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0)
    {
        return { ok: false, error: 'That email already has an account. Sign in instead, or use "Email me a sign-in code".' };
    }
    emailSent(address, 'signup');
    return { ok: true, confirm: true, message: `Almost done: we emailed ${address}. Type the 6-digit code from that email here (or open its link).` };
}

/** Finishes sign-up with the code from the confirmation email (the link works too). */
export async function confirmSignUp (email: string, code: string): Promise<AuthResult>
{
    const token = normalizeOtp(code);
    if (!isValidOtp(token)) return { ok: false, error: 'Enter the code from the email (or open its link).' };
    const { data, error } = await supabase().auth.verifyOtp({ email: normalizeEmail(email), token, type: 'email' });
    if (error || !data.session) return { ok: false, error: describeCodeError(error ?? { message: 'No session returned.' }, codeSentAt(normalizeEmail(email), 'signup')) };
    setPending(null);
    return { ok: true, message: `Email confirmed. Signed in as ${normalizeEmail(email)}.` };
}

/** Sends the sign-up confirmation email again (respects the resend cooldown). */
export async function resendSignUp (email: string): Promise<AuthResult>
{
    const address = normalizeEmail(email);
    const wait = resendCooldown();
    if (wait > 0) return { ok: false, error: `Please wait ${formatWait(wait)} before requesting another email.` };
    lastOtpRetryAfter = null;
    const { error } = await supabase().auth.resend({ type: 'signup', email: address, options: { emailRedirectTo: returnUrl() } });
    if (error) return rejectedEmail(error, (e) => describePasswordError(e, 'signup'));
    emailSent(address, 'signup');
    return { ok: true, message: 'Sent again. It can take a minute to arrive.' };
}

// ------------------------------------------------------------------ guest -> permanent account

const UPGRADE_KEY = 'eduroam.upgradeEmail';

/** The email a guest asked to save their account to (waiting for confirmation), if any. */
export function pendingUpgrade (): string | null
{
    try { return localStorage.getItem(UPGRADE_KEY); }
    catch { return null; }
}
function setPendingUpgrade (email: string | null)
{
    try { if (email) localStorage.setItem(UPGRADE_KEY, email); else localStorage.removeItem(UPGRADE_KEY); }
    catch { /* storage unavailable */ }
}

/**
 * Step 1 of keeping a guest's progress: attach an email to the SAME user (updateUser), so every
 * NPC, class, conversation, memory and score already owned by the guest id stays theirs.
 * Supabase emails a confirmation link / code; the password is set once the email is confirmed.
 */
export async function upgradeGuest (email: string): Promise<AuthResult>
{
    if (!isGuest()) return { ok: false, error: 'Only guest accounts need this.' };
    const address = normalizeEmail(email);
    if (!isValidEmail(address)) return { ok: false, error: 'Please enter a valid email address.' };
    const { error } = await supabase().auth.updateUser({ email: address }, { emailRedirectTo: returnUrl() });
    if (error) return { ok: false, error: describePasswordError(error, 'upgrade') };
    setPendingUpgrade(address);
    return { ok: true, message: `We emailed ${address}. Open the link in it, or type its code here, to keep this guest progress.` };
}

/** Step 2: confirm the email with the code from that email (the link does the same). */
export async function confirmGuestUpgrade (code: string): Promise<AuthResult>
{
    const email = pendingUpgrade();
    if (!email) return { ok: false, error: 'Start again: enter the email to save your progress to.' };
    const token = normalizeOtp(code);
    if (!isValidOtp(token)) return { ok: false, error: 'Enter the code from the email (or open its link).' };
    const { error } = await supabase().auth.verifyOtp({ email, token, type: 'email_change' });
    if (error) return { ok: false, error: describeAuthError(error, 'verify') };
    await supabase().auth.refreshSession();
    return { ok: true, message: 'Email confirmed. Now choose a password.' };
}

export function cancelGuestUpgrade ()
{
    setPendingUpgrade(null);
}

/** Sets (after an upgrade or an email-code sign-in) or changes the account password. */
export async function setAccountPassword (password: string, confirm: string): Promise<AuthResult>
{
    const problem = passwordProblem(password, confirm);
    if (problem) return { ok: false, error: problem };
    if (!current || isGuest()) return { ok: false, error: 'Confirm your email first, then choose a password.' };
    const { error } = await supabase().auth.updateUser({ password });
    if (error) return { ok: false, error: describePasswordError(error, 'password') };
    setPendingUpgrade(null);
    return { ok: true, message: 'Password saved. You can sign in with it on any device.' };
}

/** Signs out this browser only (other devices stay signed in). Local game saves are untouched. */
export async function signOut ()
{
    await supabase().auth.signOut({ scope: 'local' });
}

/** Links the browser's local player id to the account once per session (local saves are untouched). */
async function linkLocalPlayer (session: Session)
{
    const userId = session.user.id;
    if (linkedUserId === userId) return;
    linkedUserId = userId;
    linkAuthUser(userId);
    const { error } = await supabase().from('players')
        .update({ legacy_local_id: getPlayerIdentity().playerId })
        .eq('id', userId);
    if (error) console.warn('[backend] Could not link local player to account.', error.message);
}

// ------------------------------------------------------------------ session check + password reset

export type SessionCheck = { session: Session } | { session: null; error?: string };

/**
 * The session only counts once Supabase confirms it (getUser asks the Auth server, so a revoked,
 * expired-and-unrefreshable or deleted account is not let in). A rejected session is removed
 * from this browser; a network failure is reported so the gate can offer Retry.
 */
export async function verifiedSession (): Promise<SessionCheck>
{
    if (!backendConfigured) return { session: null, error: 'Accounts are not configured for this build (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).' };
    const { data } = await supabase().auth.getSession();
    if (!data.session) return { session: null };
    const { data: user, error } = await supabase().auth.getUser();
    if (user?.user && user.user.id === data.session.user.id) return { session: data.session };
    if (error && (error.status === 0 || /fetch|network/i.test(error.message)))
    {
        return { session: null, error: 'Could not reach the account server. Check your connection and try again.' };
    }
    await supabase().auth.signOut({ scope: 'local' });
    return { session: null, error: 'Your session expired. Please sign in again.' };
}

// A password reset in progress, per account: set when a reset link or reset code signs the
// account in, cleared once the new password is saved or on any other sign-in / sign-out. Kept
// in localStorage (an account id only, nothing secret) so a refresh does not skip the new
// password step, and tied to the account so a normal sign-in is never treated as a reset.
const RECOVERY_KEY = 'eduroam.passwordRecovery';
let memoryRecovery: string | null = null;

function markRecovery (userId: string)
{
    memoryRecovery = userId;
    try { localStorage.setItem(RECOVERY_KEY, userId); }
    catch { /* memory only */ }
}

function clearRecovery ()
{
    memoryRecovery = null;
    try { localStorage.removeItem(RECOVERY_KEY); }
    catch { /* memory only */ }
}

/** True while `userId` signed in through a password reset and has not chosen a new password yet. */
export function inPasswordRecovery (userId: string | null | undefined): boolean
{
    if (!userId) return false;
    try { return localStorage.getItem(RECOVERY_KEY) === userId; }
    catch { return memoryRecovery === userId; }
}

export function onPasswordRecovery (fn: () => void)
{
    recoveryListeners.add(fn);
    return () => { recoveryListeners.delete(fn); };
}

/**
 * Emails a password reset (a 6-digit code and/or a link, as the template says) to this page.
 * Same answer whether or not the account exists; respects the resend cooldown.
 */
export async function requestPasswordReset (email: string): Promise<AuthResult>
{
    const address = normalizeEmail(email);
    if (!isValidEmail(address)) return { ok: false, error: 'Please enter a valid email address.' };
    const wait = resendCooldown();
    if (wait > 0) return { ok: false, error: `Please wait ${formatWait(wait)} before requesting another email.` };
    lastOtpRetryAfter = null;
    const { error } = await supabase().auth.resetPasswordForEmail(address, { redirectTo: returnUrl() });
    if (error) return rejectedEmail(error, (e) => describePasswordError(e, 'password'));
    emailSent(address, 'reset');
    return { ok: true, message: `If ${address} has an EDUROAM account, we emailed it a 6-digit reset code. It can take a minute to arrive.` };
}

/** The 6-digit code from the reset email: signs that account in, ONLY to choose a new password. */
export async function verifyPasswordResetCode (email: string, code: string): Promise<AuthResult>
{
    const address = normalizeEmail(email);
    const token = normalizeOtp(code);
    if (!isValidOtp(token)) return { ok: false, error: 'Enter the 6-digit code from the reset email.' };
    const { data, error } = await supabase().auth.verifyOtp({ email: address, token, type: 'recovery' });
    if (error || !data.session) return { ok: false, error: describeCodeError(error ?? { message: 'No session returned.' }, codeSentAt(address, 'reset')) };
    markRecovery(data.session.user.id); // also set by the PASSWORD_RECOVERY event; never lost to timing
    setPending(null);
    return { ok: true, message: 'Code accepted. Choose a new password.' };
}

/** Saves the new password, only for the account a reset link / code signed in. */
export async function finishPasswordReset (password: string, confirm: string): Promise<AuthResult>
{
    const problem = passwordProblem(password, confirm);
    if (problem) return { ok: false, error: problem };
    const { data } = await supabase().auth.getSession();
    if (!data.session || !inPasswordRecovery(data.session.user.id))
    {
        return { ok: false, error: 'This password reset is no longer active. Request a new reset email.' };
    }
    const { error } = await supabase().auth.updateUser({ password });
    if (error) return { ok: false, error: describePasswordError(error, 'password') };
    clearRecovery();
    return { ok: true, message: 'Password changed. Use it the next time you sign in.' };
}
