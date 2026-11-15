// Full-screen sign-in gate. EDUROAM shows this BEFORE the village: sign in or create an account
// (Supabase Auth). The game starts only after Supabase confirms the session (game/app.ts).
// Views: checking, sign in (password), sign in with an email code (send -> enter the 6-digit
// code), create account, confirm email, reset password (send -> 6-digit code or the email's link),
// choose a new password, guest upgrade (old guest sessions only), "add this browser's saved
// game?", error. Every successful step hands over to game/app.ts (onAuthenticated), which decides
// what comes next, so the new-password step can never be skipped or shown twice.
//
// Every view is a real <form>: Enter submits that form only, Tab moves between fields, and while the
// gate is up input/inputGuard.ts keeps every game key switched off. The gate cannot be closed.

import './ui.css';
import {
    confirmGuestUpgrade, confirmSignUp, finishPasswordReset, pendingCode, pendingUpgrade, registerAccount, requestPasswordReset, resendCooldown,
    resendSignUp, sendEmailCode, setAccountPassword, signInWithPassword, signOut, upgradeGuest, verifyEmailCode, verifyPasswordResetCode, type AuthResult,
} from '../services/backend';
import { formatWait, MIN_PASSWORD, passwordProblem } from '../services/authFlow';
import type { DeviceSave } from '../services/deviceSave';
import { el } from './dom';

type Kind = 'email' | 'password' | 'new-password' | 'code';

interface Field { input: HTMLInputElement; error: HTMLElement; row: HTMLElement }

let fieldIds = 0;

function field (label: string, kind: Kind): Field
{
    const id = `gate-field-${++fieldIds}`;
    const input = el('input', 'gate__input');
    input.id = id;
    input.name = kind === 'code' ? 'code' : kind === 'email' ? 'email' : 'password';
    if (kind === 'email') { input.type = 'email'; input.autocomplete = 'email'; input.inputMode = 'email'; input.placeholder = 'you@school.org'; input.maxLength = 254; }
    else if (kind === 'code') { input.type = 'text'; input.autocomplete = 'one-time-code'; input.inputMode = 'numeric'; input.placeholder = '123456'; input.maxLength = 12; }
    else { input.type = 'password'; input.autocomplete = kind === 'password' ? 'current-password' : 'new-password'; input.maxLength = 72; }
    input.spellcheck = false;
    input.autocapitalize = 'off';
    const error = el('span', 'gate__error');
    error.id = `${id}-error`;
    error.setAttribute('aria-live', 'polite');
    input.setAttribute('aria-describedby', error.id);
    input.addEventListener('input', () => setError({ input, error, row }, ''));
    const labelEl = el('label', 'gate__label', label);
    labelEl.htmlFor = id;
    let control: HTMLElement = input;
    if (kind === 'password' || kind === 'new-password')
    {
        const toggle = el('button', 'gate__reveal', 'Show');
        toggle.type = 'button';
        toggle.setAttribute('aria-controls', id);
        toggle.setAttribute('aria-pressed', 'false');
        toggle.setAttribute('aria-label', `Show ${label.toLowerCase()}`);
        toggle.addEventListener('click', () =>
        {
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            toggle.textContent = show ? 'Hide' : 'Show';
            toggle.setAttribute('aria-pressed', String(show));
            toggle.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${label.toLowerCase()}`);
            input.focus();
        });
        control = el('div', 'gate__password', input, toggle);
    }
    const row = el('div', 'gate__field', labelEl, control, error);
    return { input, error, row };
}

function setError (f: Field, text: string)
{
    f.error.textContent = text;
    f.input.toggleAttribute('aria-invalid', Boolean(text));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailProblem = (value: string) => (!value.trim() ? 'Enter your email address.' : EMAIL.test(value.trim()) ? '' : 'That email address looks incomplete.');

/** A small pixel-art sprig, drawn with crisp squares (no image assets needed before the game loads). */
function sprig (className: string)
{
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const px: [number, number, string][] = [
        [7, 15, '#5b7a3a'], [7, 14, '#5b7a3a'], [7, 13, '#5b7a3a'], [7, 12, '#5b7a3a'], [7, 11, '#5b7a3a'], [7, 10, '#5b7a3a'], [7, 9, '#5b7a3a'], [7, 8, '#5b7a3a'],
        [8, 7, '#5b7a3a'], [8, 6, '#5b7a3a'], [9, 5, '#5b7a3a'],
        [4, 10, '#7fae5a'], [5, 10, '#7fae5a'], [5, 11, '#6f9a4c'], [6, 11, '#6f9a4c'], [4, 9, '#9cc873'], [5, 9, '#7fae5a'], [6, 10, '#6f9a4c'],
        [9, 9, '#7fae5a'], [10, 9, '#7fae5a'], [9, 8, '#6f9a4c'], [10, 8, '#9cc873'], [11, 8, '#9cc873'], [8, 9, '#6f9a4c'],
        [5, 6, '#7fae5a'], [6, 6, '#7fae5a'], [6, 7, '#6f9a4c'], [7, 7, '#6f9a4c'], [5, 5, '#9cc873'],
        [10, 4, '#f2c14e'], [11, 4, '#f2c14e'], [10, 3, '#f2c14e'], [11, 3, '#e9a83a'], [9, 4, '#e9a83a'], [10, 5, '#e9a83a'],
    ];
    for (const [x, y, fill] of px)
    {
        const r = document.createElementNS(ns, 'rect');
        r.setAttribute('x', String(x)); r.setAttribute('y', String(y)); r.setAttribute('width', '1'); r.setAttribute('height', '1'); r.setAttribute('fill', fill);
        svg.append(r);
    }
    return svg;
}

export class AuthGate
{
    readonly root = el('div', 'gate');
    private card = el('main', 'gate__card');
    private body = el('div', 'gate__body');
    private status = el('p', 'gate__status');
    private email = '';
    private busy = false;
    private deviceChoice: ((adopt: boolean) => void) | null = null;
    /** Buttons of the current view that wait for the resend cooldown ("Resend code (42s)"). */
    private watchers: (() => void)[] = [];
    private ticker: ReturnType<typeof setInterval> | null = null;

    /** `onAuthenticated` runs after every successful sign-in step (app.ts then verifies and routes). */
    constructor (parent: HTMLElement = document.body, private readonly onAuthenticated: () => void = () => {})
    {
        this.root.id = 'auth-gate';
        this.status.setAttribute('role', 'status');
        this.status.setAttribute('aria-live', 'polite');
        this.card.setAttribute('aria-labelledby', 'gate-title');
        const title = el('h1', 'gate__title', 'EDUROAM');
        title.id = 'gate-title';
        this.card.append(
            el('div', 'gate__sprigs', sprig('gate__sprig gate__sprig--left'), sprig('gate__sprig gate__sprig--right')),
            title, el('p', 'gate__tagline', 'Your study adventure starts here.'),
            this.body, this.status);
        this.root.append(this.card);
        parent.append(this.root);
    }

    get visible ()
    {
        return !this.root.classList.contains('is-hidden');
    }

    hide ()
    {
        this.stopWatching();
        this.root.classList.add('is-hidden');
        this.root.setAttribute('aria-hidden', 'true');
        this.body.replaceChildren();
    }

    private open ()
    {
        this.root.classList.remove('is-hidden');
        this.root.removeAttribute('aria-hidden');
    }

    private setStatus (text: string, kind: 'info' | 'error' | 'busy' = 'info')
    {
        this.status.textContent = text;
        this.status.className = `gate__status${kind === 'error' ? ' is-error' : kind === 'busy' ? ' is-busy' : ''}`;
    }

    /** Builds a <form> view; `submit` runs with the button disabled and a spinner. */
    private form (heading: string, fields: Field[], submitLabel: string, submit: () => Promise<void> | void, ...extra: HTMLElement[])
    {
        this.stopWatching();
        const button = el('button', 'btn btn--primary gate__submit', submitLabel);
        button.type = 'submit';
        const leads = extra.filter((node) => node.classList.contains('gate__lead'));
        const rest = extra.filter((node) => !leads.includes(node));
        const form = el('form', 'gate__form', el('h2', 'gate__heading', heading), ...leads, ...fields.map((f) => f.row), button, ...rest);
        form.noValidate = true;
        form.addEventListener('submit', (event) =>
        {
            event.preventDefault();
            if (this.busy || button.disabled) return;
            this.busy = true;
            button.disabled = true;
            button.classList.add('is-busy');
            this.refreshWatchers();
            void Promise.resolve(submit()).finally(() =>
            {
                this.busy = false;
                button.disabled = false;
                button.classList.remove('is-busy');
                this.refreshWatchers();
            });
        });
        this.open();
        this.body.replaceChildren(form);
        this.setStatus('');
        (fields.find((f) => !f.input.value) ?? fields[0])?.input.focus();
        return form;
    }

    private link (text: string, onClick: () => void, prefix = '')
    {
        const button = el('button', 'gate__link', text);
        button.type = 'button';
        button.addEventListener('click', onClick);
        return el('p', 'gate__switch', prefix, button);
    }

    /** A link that sends an email again: one request at a time, disabled during the resend cooldown. */
    private resendLink (text: string, send: () => Promise<AuthResult>, onSent: () => void)
    {
        const row = this.link(text, () =>
        {
            if (this.busy || resendCooldown() > 0) return;
            this.busy = true;
            this.refreshWatchers();
            void this.run(send).then((result) => { if (result.ok) onSent(); }).finally(() =>
            {
                this.busy = false;
                this.refreshWatchers();
            });
        });
        return { row, button: row.querySelector('button')! };
    }

    /** Keeps `button` disabled with a countdown while another email may not be requested yet. */
    private watchCooldown (button: HTMLButtonElement, label: string)
    {
        const update = () =>
        {
            const wait = resendCooldown();
            button.disabled = this.busy || wait > 0;
            button.textContent = wait > 0 ? `${label} (${formatWait(wait)})` : label;
        };
        this.watchers.push(update);
        update();
        this.ticker ??= setInterval(() => this.refreshWatchers(), 1000);
    }

    private refreshWatchers ()
    {
        this.watchers.forEach((update) => update());
    }

    private stopWatching ()
    {
        this.watchers = [];
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = null;
    }

    /** A sign-in step succeeded: keep the screen busy while app.ts checks the session and routes. */
    private signedIn (text: string)
    {
        this.loading(text);
        this.onAuthenticated();
    }

    private async run (action: () => Promise<AuthResult>, onError?: (error: string) => void): Promise<AuthResult>
    {
        this.setStatus('One moment…', 'busy');
        let result: AuthResult;
        try { result = await action(); }
        catch (err) { result = { ok: false, error: err instanceof Error ? err.message : 'Something went wrong. Please try again.' }; }
        if (result.ok) this.setStatus(result.message);
        else { this.setStatus(result.error, 'error'); onError?.(result.error); }
        return result;
    }

    // ------------------------------------------------------------------ views

    loading (text = 'Checking your account…')
    {
        this.stopWatching();
        this.open();
        this.body.replaceChildren(el('div', 'gate__loading', el('span', 'gate__spinner'), el('span', '', text)));
        this.setStatus('');
    }

    failure (message: string, retry: () => void)
    {
        this.stopWatching();
        this.open();
        const button = el('button', 'btn btn--primary gate__submit', 'Try again');
        button.type = 'button';
        button.addEventListener('click', retry);
        this.body.replaceChildren(el('div', 'gate__form', el('p', 'gate__lead', message), button));
        this.setStatus('');
        button.focus();
    }

    signIn (notice = '')
    {
        const email = field('Email', 'email');
        const password = field('Password', 'password');
        email.input.value = this.email;
        this.form('Sign in', [email, password], 'Sign In', async () =>
        {
            this.email = email.input.value.trim();
            const problem = emailProblem(email.input.value);
            if (problem) { setError(email, problem); email.input.focus(); return; }
            if (!password.input.value) { setError(password, 'Enter your password.'); password.input.focus(); return; }
            // Success continues in game/app.ts (SIGNED_IN -> session check -> load the player).
            const result = await this.run(() => signInWithPassword(email.input.value, password.input.value));
            if (!result.ok)
            {
                // Registered but never confirmed: go straight to entering the confirmation code.
                if (/Confirm your email first/.test(result.error)) { this.email = email.input.value.trim().toLowerCase(); this.confirmEmail(result.error); return; }
                if (/password/i.test(result.error)) { setError(password, result.error); password.input.select(); }
                else setError(email, result.error);
            }
            else this.signedIn('Signed in. Loading your village…');
        },
        this.link('Email me a sign-in code instead', () => { this.email = email.input.value.trim(); this.codeRequest(); }),
        this.link('Forgot your password?', () => { this.email = email.input.value.trim(); this.resetRequest(); }),
        this.link('Create one.', () => { this.email = email.input.value.trim(); this.register(); }, 'Don\'t have an account? '));
        if (notice) this.setStatus(notice, /expired|could not|failed|invalid|already used|did not work/i.test(notice) ? 'error' : 'info');
    }

    /** Passwordless sign-in for an EXISTING account: a 6-digit code by email (never creates an account). */
    codeRequest ()
    {
        const email = field('Email', 'email');
        email.input.value = this.email;
        const waiting = pendingCode();
        const resume = waiting && (waiting.kind ?? 'signin') === 'signin' ? waiting : null;
        const form = this.form('Sign in with an email code', [email], 'Send Code', async () =>
        {
            const problem = emailProblem(email.input.value);
            if (problem) { setError(email, problem); email.input.focus(); return; }
            this.email = email.input.value.trim().toLowerCase();
            const result = await this.run(() => sendEmailCode(email.input.value), (error) => setError(email, error));
            if (result.ok) this.codeEntry(result.message);
        },
        el('p', 'gate__lead', 'We will email a 6-digit code to the address of your EDUROAM account. No password needed.'),
        ...(resume ? [this.link('I already have a code', () => { this.email = resume.email; this.codeEntry(''); })] : []),
        this.link('Back to sign in', () => { this.email = email.input.value.trim(); this.signIn(); }));
        this.watchCooldown(form.querySelector<HTMLButtonElement>('.gate__submit')!, 'Send Code');
    }

    /** Type the emailed sign-in code. */
    private codeEntry (message: string)
    {
        const code = field('Code from the email', 'code');
        const resend = this.resendLink('Resend code', () => sendEmailCode(this.email), () => { code.input.value = ''; code.input.focus(); });
        this.form('Enter your code', [code], 'Sign In', async () =>
        {
            const result = await this.run(() => verifyEmailCode(this.email, code.input.value), (error) => setError(code, error));
            if (result.ok) this.signedIn('Signed in. Loading your village…');
            else code.input.select();
        },
        el('p', 'gate__lead', 'Type the 6-digit code from the email sent to ', el('strong', '', this.email), '. You can read it on any device; check your spam folder if it does not arrive.'),
        resend.row,
        this.link('Use a different email', () => this.codeRequest()),
        this.link('Back to sign in', () => this.signIn()));
        this.watchCooldown(resend.button, 'Resend code');
        if (message) this.setStatus(message);
    }

    register ()
    {
        const email = field('Email', 'email');
        const password = field(`Password (${MIN_PASSWORD}+ characters)`, 'new-password');
        const confirm = field('Confirm Password', 'new-password');
        email.input.value = this.email;
        this.form('Create an account', [email, password, confirm], 'Create Account', async () =>
        {
            this.email = email.input.value.trim();
            const problem = emailProblem(email.input.value);
            if (problem) { setError(email, problem); email.input.focus(); return; }
            const pw = passwordProblem(password.input.value);
            if (pw) { setError(password, pw); password.input.focus(); return; }
            const match = passwordProblem(password.input.value, confirm.input.value);
            if (match) { setError(confirm, match); confirm.input.focus(); return; }
            const result = await this.run(() => registerAccount(email.input.value, password.input.value, confirm.input.value), (error) => setError(email, error));
            if (!result.ok) return;
            // Email confirmation is on: an account that still needs its email is NOT signed in.
            if ('confirm' in result && result.confirm) this.confirmEmail();
            else this.signedIn('Account created. Loading your village…');
        },
        this.link('Sign in.', () => { this.email = email.input.value.trim(); this.signIn(); }, 'Already have an account? '));
    }

    confirmEmail (notice = '')
    {
        const code = field('Code from the email', 'code');
        const resend = this.resendLink('Send it again', () => resendSignUp(this.email), () => { code.input.value = ''; code.input.focus(); });
        this.form('Confirm your email', [code], 'Confirm', async () =>
        {
            const result = await this.run(() => confirmSignUp(this.email, code.input.value), (error) => setError(code, error));
            if (result.ok) this.signedIn('Email confirmed. Loading your village…');
        },
        el('p', 'gate__lead', 'We sent a confirmation email to ', el('strong', '', this.email), '. Type the 6-digit code from it here, or open its link.'),
        resend.row,
        this.link('Back to sign in', () => this.signIn()));
        this.watchCooldown(resend.button, 'Send it again');
        if (notice) this.setStatus(notice);
    }

    resetRequest ()
    {
        const email = field('Email', 'email');
        email.input.value = this.email;
        const form = this.form('Reset your password', [email], 'Send Reset Email', async () =>
        {
            const problem = emailProblem(email.input.value);
            if (problem) { setError(email, problem); return; }
            this.email = email.input.value.trim().toLowerCase();
            const result = await this.run(() => requestPasswordReset(email.input.value), (error) => setError(email, error));
            if (result.ok) this.resetCode(result.message);
        },
        el('p', 'gate__lead', 'Enter the email of your EDUROAM account. We will email you a 6-digit code (and a link) to choose a new password.'),
        this.link('Back to sign in', () => this.signIn()));
        this.watchCooldown(form.querySelector<HTMLButtonElement>('.gate__submit')!, 'Send Reset Email');
    }

    private resetCode (message: string)
    {
        const code = field('Code from the email', 'code');
        const resend = this.resendLink('Send a new code', () => requestPasswordReset(this.email), () => { code.input.value = ''; code.input.focus(); });
        this.form('Check your email', [code], 'Continue', async () =>
        {
            const result = await this.run(() => verifyPasswordResetCode(this.email, code.input.value), (error) => setError(code, error));
            // app.ts sees the reset session and shows "Choose a new password" (no village before that).
            if (result.ok) this.signedIn('Code accepted. One moment…');
            else code.input.select();
        },
        el('p', 'gate__lead', 'Type the 6-digit code from the reset email sent to ', el('strong', '', this.email), ', or open the link in that email on this device.'),
        resend.row,
        this.link('Use a different email', () => this.resetRequest()),
        this.link('Back to sign in', () => this.signIn()));
        this.watchCooldown(resend.button, 'Send a new code');
        this.setStatus(message);
    }

    /** After a reset link / code: the game waits until a new password is saved. */
    newPassword (onDone: () => void)
    {
        const password = field(`New password (${MIN_PASSWORD}+ characters)`, 'new-password');
        const confirm = field('Confirm Password', 'new-password');
        this.form('Choose a new password', [password, confirm], 'Save Password', async () =>
        {
            const pw = passwordProblem(password.input.value);
            if (pw) { setError(password, pw); return; }
            const match = passwordProblem(password.input.value, confirm.input.value);
            if (match) { setError(confirm, match); return; }
            const result = await this.run(() => finishPasswordReset(password.input.value, confirm.input.value), (error) => setError(password, error));
            if (result.ok) { this.loading('Password changed. Loading your village…'); onDone(); }
        },
        el('p', 'gate__lead', 'Choose a new password for your account. You will use it the next time you sign in.'),
        this.link('Cancel and sign out', () => void signOut()));
    }

    /**
     * An older GUEST session (no email): it can become a real account (same id, so its NPCs and
     * progress stay), or the player can leave it and sign in normally.
     */
    guest (onUpgraded: () => void)
    {
        const pending = pendingUpgrade();
        const leave = this.link('Sign out of the guest account', () => void this.leaveGuest(), 'Have an account already? ');
        if (pending)
        {
            const code = field('Code from the email', 'code');
            this.form('Confirm your email', [code], 'Confirm', async () =>
            {
                const result = await this.run(() => confirmGuestUpgrade(code.input.value), (error) => setError(code, error));
                if (result.ok) this.guestPassword(onUpgraded);
            },
            el('p', 'gate__lead', 'Open the link we emailed to ', el('strong', '', pending), ', or type its code here.'), leave);
            return;
        }
        const email = field('Email', 'email');
        this.form('Keep your guest progress', [email], 'Create Account', async () =>
        {
            const problem = emailProblem(email.input.value);
            if (problem) { setError(email, problem); return; }
            const result = await this.run(() => upgradeGuest(email.input.value), (error) => setError(email, error));
            if (result.ok) this.guest(onUpgraded);
        },
        el('p', 'gate__lead', 'You were playing as a guest. EDUROAM now needs an account: add your email to keep this guest\'s NPCs and progress.'), leave);
    }

    guestPassword (onDone: () => void)
    {
        const password = field(`Password (${MIN_PASSWORD}+ characters)`, 'new-password');
        const confirm = field('Confirm Password', 'new-password');
        this.form('Choose a password', [password, confirm], 'Save Password', async () =>
        {
            const pw = passwordProblem(password.input.value);
            if (pw) { setError(password, pw); return; }
            const match = passwordProblem(password.input.value, confirm.input.value);
            if (match) { setError(confirm, match); return; }
            const result = await this.run(() => setAccountPassword(password.input.value, confirm.input.value), (error) => setError(password, error));
            if (result.ok) { this.loading('Account ready. Loading your village…'); onDone(); }
        });
    }

    private async leaveGuest ()
    {
        if (!window.confirm('Sign out of this guest account? It cannot be signed back into, so its NPCs and progress will no longer be reachable. Add your email first to keep them.')) return;
        await signOut();
    }

    /** "Add this browser's saved game to your account?" Resolves true (add) or false (start fresh). */
    offerDeviceSave (save: DeviceSave, email: string): Promise<boolean>
    {
        return new Promise((resolve) =>
        {
            this.deviceChoice = resolve;
            const parts = [save.npcs.length ? `${save.npcs.length} teacher${save.npcs.length === 1 ? '' : 's'} (${save.npcs.slice(0, 3).join(', ')}${save.npcs.length > 3 ? '…' : ''})` : '', save.progress ? 'game progress (crystals, items, tower)' : ''].filter(Boolean);
            const fresh = el('button', 'btn gate__submit', 'Start Fresh');
            fresh.type = 'button';
            fresh.addEventListener('click', () => this.chooseDevice(false));
            this.form('A saved game was found', [], 'Add To My Account', () => this.chooseDevice(true),
                el('p', 'gate__lead', `This browser has ${parts.join(' and ')} from before you signed in. Add it to `, el('strong', '', email), '? Your account\'s own saves are never overwritten, and nothing is deleted.'),
                fresh);
        });
    }

    private chooseDevice (adopt: boolean)
    {
        const done = this.deviceChoice;
        this.deviceChoice = null;
        this.loading('Loading your village…');
        done?.(adopt);
    }
}
