// In-game account box: Sign in (email + password), Create account (email + password, then
// confirm the email), and a one-time email code as the fallback for a forgotten / never-set
// password. (No guest option: the game requires a verified account, see ui/AuthGate.ts.) Nothing opens a new tab; confirmation emails can be read on
// any device (type the code) or opened here (the link returns to this game page).

import {
    confirmSignUp, pendingCode, registerAccount, resendCooldown, resendSignUp, sendEmailCode,
    signInWithPassword, verifyEmailCode, type AuthResult,
} from '../services/backend';
import { formatWait, MIN_PASSWORD } from '../services/authFlow';
import { el, gameButton } from './dom';

type Mode = 'signin' | 'register';

function passwordInput (label: string, autocomplete: AutoFill)
{
    const input = el('input');
    input.type = 'password';
    input.autocomplete = autocomplete;
    input.maxLength = 72;
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    return input;
}

export class SignInBox
{
    readonly root: HTMLElement;
    private mode: Mode = 'signin';
    private tabs: HTMLElement;
    private tabButtons: Record<Mode, HTMLButtonElement>;
    private emailRow: HTMLElement;
    private signinFields: HTMLElement;
    private registerFields: HTMLElement;
    private codeStep: HTMLElement;
    private confirmStep: HTMLElement;
    private email = el('input');
    private password = passwordInput('Password', 'current-password');
    private newPassword = passwordInput(`New password (${MIN_PASSWORD}+ characters)`, 'new-password');
    private confirmPassword = passwordInput('Repeat password', 'new-password');
    private code = el('input');
    private confirmCode = el('input');
    private sentTo = el('strong');
    private confirmTo = el('strong');
    private message = el('p', 'signin__message');
    private sendButton: HTMLButtonElement;
    private resendButton: HTMLButtonElement;
    private actionButtons: HTMLButtonElement[];
    private pending = false;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor (intro: string)
    {
        this.email.type = 'email';
        this.email.autocomplete = 'email';
        this.email.inputMode = 'email';
        this.email.placeholder = 'you@school.org';
        this.email.setAttribute('aria-label', 'Email address');

        for (const input of [this.code, this.confirmCode])
        {
            input.type = 'text';
            input.inputMode = 'numeric';
            input.autocomplete = 'one-time-code';
            input.maxLength = 12;
            input.placeholder = '123456';
            input.className = 'signin__code';
        }
        this.code.setAttribute('aria-label', 'Sign-in code');
        this.confirmCode.setAttribute('aria-label', 'Confirmation code');

        const signIn = gameButton('btn btn--primary btn--small', () => void this.signIn(), 'Sign in');
        const register = gameButton('btn btn--primary btn--small', () => void this.register(), 'Create account');
        this.sendButton = gameButton('btn btn--small', () => void this.send(), 'Send Code');
        const verify = gameButton('btn btn--primary btn--small', () => void this.verify(), 'Verify');
        this.resendButton = gameButton('btn btn--small', () => void this.send(), 'Resend code');
        const changeEmail = gameButton('btn btn--small', () => this.show('signin'), 'Use a different email');
        const confirm = gameButton('btn btn--primary btn--small', () => void this.confirm(), 'Confirm');
        const resendConfirm = gameButton('btn btn--small', () => void this.run(() => resendSignUp(this.email.value)), 'Resend email');
        const back = gameButton('btn btn--small', () => this.show('signin'), 'Back to sign in');
        this.actionButtons = [signIn, register, verify, changeEmail, confirm, resendConfirm, back];

        this.tabButtons = {
            signin: gameButton('signin__tab', () => this.show('signin'), 'Sign in'),
            register: gameButton('signin__tab', () => this.show('register'), 'Create account'),
        };
        this.tabs = el('div', 'signin__tabs', this.tabButtons.signin, this.tabButtons.register);
        this.tabs.setAttribute('role', 'group');
        this.tabs.setAttribute('aria-label', 'Account');

        const enter = (input: HTMLInputElement, action: () => void) => input.addEventListener('keydown', (event) =>
        {
            if (event.key === 'Enter') { event.preventDefault(); action(); }
        });
        enter(this.email, () => (this.mode === 'register' ? this.newPassword : this.password).focus());
        enter(this.password, () => void this.signIn());
        enter(this.confirmPassword, () => void this.register());
        enter(this.code, () => void this.verify());
        enter(this.confirmCode, () => void this.confirm());
        this.message.setAttribute('role', 'status');
        this.message.setAttribute('aria-live', 'polite');

        this.emailRow = el('div', 'signin__row', this.email);
        this.signinFields = el('div', 'signin__step',
            el('div', 'signin__row', this.password, signIn),
            el('p', 'signin__hint', 'Forgot your password, or never set one? Get a one-time code by email:'),
            el('div', 'signin__row', this.sendButton));
        this.registerFields = el('div', 'signin__step hidden',
            el('div', 'signin__row', this.newPassword),
            el('div', 'signin__row', this.confirmPassword, register));
        this.codeStep = el('div', 'signin__step hidden',
            el('p', 'signin__intro', 'Enter the 6-digit code we emailed to ', this.sentTo, '. You can read the email on any device.'),
            el('div', 'signin__row', this.code, verify),
            el('div', 'signin__row', this.resendButton, changeEmail));
        this.confirmStep = el('div', 'signin__step hidden',
            el('p', 'signin__intro', 'Confirm your email: open the link we sent to ', this.confirmTo, ', or type the code from it here.'),
            el('div', 'signin__row', this.confirmCode, confirm),
            el('div', 'signin__row', resendConfirm, back));

        this.root = el('div', 'signin', el('p', 'signin__intro', intro), this.tabs, this.emailRow,
            this.signinFields, this.registerFields, this.codeStep, this.confirmStep, this.message);
        this.refresh();
    }

    /** Re-reads the pending code request (shared with other sign-in boxes and kept across reloads). */
    refresh ()
    {
        const pending = pendingCode();
        // Only a sign-in code reopens the code step (not a sign-up confirmation or a reset email).
        if (pending && (pending.kind ?? 'signin') === 'signin') this.showCode(pending.email);
        else if (!this.codeStep.classList.contains('hidden')) this.show('signin');
        else this.show(this.mode);
    }

    focus ()
    {
        this.refresh();
        if (!this.codeStep.classList.contains('hidden')) this.code.focus();
        else if (!this.confirmStep.classList.contains('hidden')) this.confirmCode.focus();
        else (this.email.value ? (this.mode === 'register' ? this.newPassword : this.password) : this.email).focus();
    }

    private showOnly (step: HTMLElement | null)
    {
        const entering = step === this.codeStep || step === this.confirmStep;
        this.tabs.classList.toggle('hidden', entering);
        this.emailRow.classList.toggle('hidden', entering);
        for (const s of [this.signinFields, this.registerFields, this.codeStep, this.confirmStep]) s.classList.toggle('hidden', s !== step);
        this.updateButtons();
    }

    private show (mode: Mode)
    {
        this.mode = mode;
        for (const [key, button] of Object.entries(this.tabButtons))
        {
            button.classList.toggle('is-active', key === mode);
            button.setAttribute('aria-pressed', String(key === mode));
        }
        this.showOnly(mode === 'signin' ? this.signinFields : this.registerFields);
    }

    private showCode (email: string)
    {
        this.email.value = email;
        this.sentTo.textContent = email;
        this.showOnly(this.codeStep);
    }

    private async signIn ()
    {
        if (this.pending) return;
        const result = await this.run(() => signInWithPassword(this.email.value, this.password.value));
        if (result.ok) this.password.value = '';
        else this.password.select();
    }

    private async register ()
    {
        if (this.pending) return;
        const result = await this.run(() => registerAccount(this.email.value, this.newPassword.value, this.confirmPassword.value));
        if (!result.ok) return;
        this.newPassword.value = '';
        this.confirmPassword.value = '';
        if ('confirm' in result && result.confirm)
        {
            this.confirmTo.textContent = this.email.value.trim().toLowerCase();
            this.confirmCode.value = '';
            this.showOnly(this.confirmStep);
            this.confirmCode.focus();
        }
    }

    private async confirm ()
    {
        if (this.pending) return;
        const result = await this.run(() => confirmSignUp(this.email.value, this.confirmCode.value));
        if (result.ok) { this.confirmCode.value = ''; this.show('signin'); }
        else this.confirmCode.select();
    }

    private async send ()
    {
        if (this.pending || resendCooldown() > 0) return;
        const result = await this.run(() => sendEmailCode(this.email.value));
        if (result.ok)
        {
            this.code.value = '';
            this.showCode(this.email.value.trim().toLowerCase());
            this.code.focus();
        }
        this.updateButtons();
    }

    private async verify ()
    {
        if (this.pending) return;
        const result = await this.run(() => verifyEmailCode(this.email.value, this.code.value));
        if (result.ok)
        {
            // The panel that owns this box reacts to SIGNED_IN and swaps the box out.
            this.code.value = '';
            this.show('signin');
        }
        else
        {
            this.code.select();
        }
    }

    /** Runs one request at a time; shows success only when the server confirmed it. */
    private async run<T extends AuthResult> (action: () => Promise<T>): Promise<T | AuthResult>
    {
        this.pending = true;
        this.updateButtons();
        this.setMessage('One moment…', false);
        let result: T | AuthResult;
        try
        {
            result = await action();
        }
        catch (err)
        {
            result = { ok: false, error: err instanceof Error ? err.message : 'Sign-in failed.' };
        }
        this.pending = false;
        this.setMessage(result.ok ? result.message : result.error, !result.ok);
        this.updateButtons();
        return result;
    }

    private setMessage (text: string, isError: boolean)
    {
        this.message.textContent = text;
        this.message.classList.toggle('is-error', isError);
    }

    /** Disables buttons while a request runs and counts down the resend cooldown. */
    private updateButtons ()
    {
        const wait = resendCooldown();
        this.sendButton.disabled = this.pending || wait > 0;
        this.sendButton.textContent = wait > 0 ? `Send Code (${formatWait(wait)})` : 'Send Code';
        this.resendButton.disabled = this.pending || wait > 0;
        this.resendButton.textContent = wait > 0 ? `Resend code (${formatWait(wait)})` : 'Resend code';
        this.actionButtons.forEach((b) => { b.disabled = this.pending; });
        Object.values(this.tabButtons).forEach((b) => { b.disabled = this.pending; });

        if (wait > 0 && !this.timer) this.timer = setInterval(() => this.updateButtons(), 1000);
        else if (wait === 0 && this.timer) { clearInterval(this.timer); this.timer = null; }
    }
}
