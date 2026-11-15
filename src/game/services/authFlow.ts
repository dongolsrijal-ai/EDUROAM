// Pure helpers for the email one-time-code sign-in (no Supabase / DOM imports, unit-tested).

/** Supabase's default email rate limit allows one code per address every 60 s. */
export const OTP_RESEND_SECONDS = 60;
/** A code request older than this is no longer offered for entry (Supabase default expiry: 1 h). */
export const OTP_ENTRY_WINDOW_MS = 60 * 60 * 1000;
/** Supabase "Email OTP Expiration" (Authentication > Sign In / Providers > Email), default 3600 s. */
export const OTP_EXPIRY_SECONDS = 3600;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail (email: string): string
{
    return email.trim().toLowerCase();
}

export function isValidEmail (email: string): boolean
{
    const value = normalizeEmail(email);
    return value.length <= 254 && EMAIL.test(value);
}

/** Digits only (people paste "123 456" or "123-456"). Supabase codes are 6 digits by default (6-10 configurable). */
export function normalizeOtp (code: string): string
{
    return code.replace(/[\s-]/g, '');
}

export function isValidOtp (code: string): boolean
{
    return /^\d{6,10}$/.test(normalizeOtp(code));
}

/** Seconds until another code may be requested. */
export function cooldownRemaining (sentAt: number, now = Date.now(), seconds = OTP_RESEND_SECONDS): number
{
    return Math.max(0, Math.ceil((sentAt + seconds * 1000 - now) / 1000));
}

export interface AuthErrorLike
{
    status?: number;
    code?: string;
    message?: string;
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date); null if absent/invalid. */
export function parseRetryAfter (header: string | null | undefined, now = Date.now()): number | null
{
    if (!header) return null;
    const value = header.trim();
    if (/^\d+$/.test(value)) return Number(value);
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

/** "45s", "12 min", "2 h" for waits shown on buttons and messages. */
export function formatWait (seconds: number): string
{
    if (seconds < 90) return `${seconds}s`;
    if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} min`;
    return `${Math.ceil(seconds / 3600)} h`;
}

/**
 * Supabase's per-address limit ("For security purposes, you can only request this after 42 seconds."):
 * the seconds to wait, or null. Sign-in codes, reset emails and confirmations share it.
 */
export function frequencyWaitSeconds (error: AuthErrorLike): number | null
{
    const match = /only request this after (\d+) seconds?/i.exec(error.message ?? '');
    return match ? Number(match[1]) : null;
}

/** The project's email-sending quota is used up (not fixed by waiting a minute). */
export function isEmailQuotaError (error: AuthErrorLike): boolean
{
    if (frequencyWaitSeconds(error) !== null) return false;
    return error.code === 'over_email_send_rate_limit' || /email rate limit/i.test(error.message ?? '');
}

/**
 * signInWithOtp({ shouldCreateUser: false }) for an address without an account. The game answers it
 * exactly like a sent code, so the screen never reveals which addresses are registered.
 */
export function isNoAccountForCode (error: AuthErrorLike): boolean
{
    return error.code === 'otp_disabled' || /signups not allowed for otp/i.test(error.message ?? '');
}

/** The Auth server could not hand the email to its mail provider (SMTP failure). */
export function isEmailDeliveryError (error: AuthErrorLike): boolean
{
    return /error sending .*email|smtp/i.test(error.message ?? '');
}

/** Player-facing text for a Supabase Auth error while sending or verifying a code. */
export function describeAuthError (error: AuthErrorLike, phase: 'send' | 'verify', retryAfterSeconds: number | null = null): string
{
    const code = error.code ?? '';
    const message = error.message ?? '';
    const retry = retryAfterSeconds ? ` Try again in about ${formatWait(retryAfterSeconds)}.` : '';
    const frequency = frequencyWaitSeconds(error);
    if (frequency !== null)
    {
        return `An email was sent to this address less than a minute ago. Please wait ${formatWait(Math.max(1, frequency))}, then try again.`;
    }
    if (phase === 'send' && isEmailDeliveryError(error))
    {
        return 'The email could not be sent right now. Please try again in a few minutes.';
    }
    if (phase === 'send' && isEmailQuotaError(error))
    {
        return `No code was sent: the game's hourly sign-in email limit has been reached.${retry || ' Please try again later (the limit resets within the hour).'}`
            + ' If this keeps happening, the game owner needs to set up custom email (SMTP) in Supabase.';
    }
    if (error.status === 429 || /rate.?limit/i.test(code) || /rate limit|too many/i.test(message))
    {
        return phase === 'send'
            ? `No code was sent: too many requests from this device.${retry || ' Please try again in a few minutes.'}`
            : `Too many attempts.${retry || ' Please wait a few minutes, then try the code again.'}`;
    }
    if (code === 'otp_expired' || /expired|invalid/i.test(message) && phase === 'verify')
    {
        return 'That code is wrong or has expired. Check the newest email, or send a new code.';
    }
    if (code === 'email_address_not_authorized' || /not authorized/i.test(message))
    {
        return 'This game can only email its team members until custom email (SMTP) is set up in Supabase.';
    }
    if (code === 'email_address_invalid' || code === 'validation_failed') return 'Please check the email address.';
    if (code === 'signup_disabled' || code === 'otp_disabled') return 'New sign-ups are turned off for this game.';
    if (error.status === 0 || /failed to fetch|network/i.test(message)) return 'Could not reach the sign-in server. Check your connection.';
    return message || 'Sign-in failed. Please try again.';
}

/**
 * A rejected code. Supabase answers wrong, used and expired codes with the same error, so the time
 * the code was requested tells an expired code apart from a mistyped or replaced one.
 */
export function describeCodeError (error: AuthErrorLike, sentAt: number | null, now = Date.now(), expirySeconds = OTP_EXPIRY_SECONDS): string
{
    const rejected = error.code === 'otp_expired' || /expired|invalid/i.test(error.message ?? '');
    if (rejected && sentAt !== null && now - sentAt >= expirySeconds * 1000)
    {
        return `That code has expired (codes last ${formatWait(expirySeconds)}). Send a new code.`;
    }
    return describeAuthError(error, 'verify');
}

/** Minimum password length asked by the game (Supabase's own minimum is 6; it may be raised there). */
export const MIN_PASSWORD = 8;

/** Why a new password is not acceptable, or null. Checked before any request is sent. */
export function passwordProblem (password: string, confirm?: string): string | null
{
    if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for your password.`;
    if (password.length > 72) return 'Use at most 72 characters for your password.';
    if (/^\s|\s$/.test(password)) return 'Your password cannot start or end with a space.';
    if (confirm !== undefined && confirm !== password) return 'The two passwords do not match.';
    return null;
}

/** Player-facing text for a Supabase Auth error during password sign-in, sign-up or account upgrade. */
export function describePasswordError (error: AuthErrorLike, phase: 'signin' | 'signup' | 'upgrade' | 'password'): string
{
    const code = error.code ?? '';
    const message = error.message ?? '';
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) return 'Wrong email or password. Check both, or use "Email me a sign-in code" instead.';
    if (code === 'email_not_confirmed' || /email not confirmed/i.test(message)) return 'Confirm your email first: open the link we emailed you, then sign in.';
    if (code === 'user_already_exists' || code === 'email_exists' || /already (been )?registered|already exists/i.test(message))
    {
        return phase === 'upgrade'
            ? 'That email already has an account. Sign in to it instead (your guest NPCs stay with the guest account).'
            : 'That email already has an account. Sign in instead.';
    }
    if (code === 'weak_password' || /password should|weak password/i.test(message)) return message || 'Please choose a stronger password.';
    if (code === 'same_password') return 'That is already your password.';
    if (code === 'reauthentication_needed') return 'For security, sign in again (or use an email code), then change your password.';
    if (isEmailQuotaError(error)) return "No email was sent: the game's hourly email limit has been reached. Please try again later.";
    return describeAuthError(error, phase === 'signin' ? 'verify' : 'send');
}

export interface AuthCallback
{
    /** The URL carried Supabase auth parameters (email link / OAuth redirect). */
    present: boolean;
    error: string | null;
    /** Supabase's error_code for a failed link (e.g. "otp_expired" for a used or expired link). */
    errorCode: string | null;
    /** The link's purpose ("recovery" for a password-reset link), from the implicit-flow fragment. */
    type: string | null;
    /** The access token the link carried (kept in memory only, to match the session it created). */
    accessToken: string | null;
    /** The same URL with the auth parameters removed (game URL stays clean). */
    cleanUrl: string;
}

const AUTH_PARAMS = ['access_token', 'refresh_token', 'expires_at', 'expires_in', 'token_type', 'type', 'provider_token', 'provider_refresh_token', 'error', 'error_code', 'error_description', 'code', 'sb'];

/** Detects an auth redirect (hash tokens, PKCE ?code=, or ?error=) without consuming it. */
export function readAuthCallback (href: string): AuthCallback
{
    const url = new URL(href);
    const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
    const query = url.searchParams;
    const present = hash.has('access_token') || hash.has('error_description') || query.has('error_description')
        || (query.has('code') && /^[0-9a-f-]{20,}$/i.test(query.get('code') ?? ''));
    const error = hash.get('error_description') ?? query.get('error_description');
    const errorCode = hash.get('error_code') ?? query.get('error_code');
    const type = hash.get('type') ?? (present ? query.get('type') : null);
    const accessToken = hash.get('access_token');
    if (present)
    {
        for (const key of AUTH_PARAMS) { hash.delete(key); query.delete(key); }
        url.hash = hash.toString();
        url.search = query.toString();
    }
    return { present, error: error ? error.replace(/\+/g, ' ') : null, errorCode, type, accessToken, cleanUrl: url.toString() };
}

/** What the sign-in screen says after an email link failed (null when the link worked). */
export function describeRedirectError (callback: Pick<AuthCallback, 'error' | 'errorCode'>): string | null
{
    if (!callback.error && !callback.errorCode) return null;
    if (callback.errorCode === 'otp_expired' || /invalid or has expired|expired/i.test(callback.error ?? ''))
    {
        return 'That email link has expired or was already used (each link works once). Request a new email, or type the 6-digit code from the newest one.';
    }
    return `That email link did not work: ${callback.error ?? callback.errorCode}. Please request a new email.`;
}
