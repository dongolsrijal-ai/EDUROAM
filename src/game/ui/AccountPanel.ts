// Account button + panel (top right, next to the NPC buttons). Signed out: sign in, create an
// account or play as guest. Guest: save the progress to an email (the SAME account id is kept,
// so NPCs, classes, coursework, memories and scores all stay). Signed in: set / change the
// password, sign out. The village reloads from Supabase whenever the account changes.

import {
    backendConfigured, cancelGuestUpgrade, confirmGuestUpgrade, currentUserEmail, getSession, isGuest, onProfileChange,
    onSessionChange, pendingUpgrade, setAccountPassword, signOut, upgradeGuest, type AuthResult,
} from '../services/backend';
import { MIN_PASSWORD } from '../services/authFlow';
import { el, gameButton } from './dom';
import { SignInBox } from './SignInBox';
import type { Toasts } from './widgets';

function field (type: string, label: string, autocomplete: AutoFill)
{
    const input = el('input');
    input.type = type;
    input.autocomplete = autocomplete;
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    if (type === 'password') input.maxLength = 72;
    return input;
}

export class AccountPanel
{
    readonly button: HTMLButtonElement;
    readonly panel = el('section', 'account panel hidden');
    private body = el('div', 'account__body');
    private message = el('p', 'signin__message');
    private signin = new SignInBox('Sign in to save your NPCs, coursework and progress to your account and open them on any device.');
    private busy = false;

    constructor (private toasts: Toasts)
    {
        this.button = gameButton('btn account-button', () => this.toggle(), 'Sign in');
        this.button.setAttribute('aria-expanded', 'false');
        this.button.classList.toggle('hidden', !backendConfigured);
        this.message.setAttribute('role', 'status');
        this.panel.setAttribute('aria-label', 'Account');
        this.panel.append(el('div', 'account__head', el('strong', '', 'Account'),
            gameButton('btn btn--small', () => this.toggle(false), 'Close')), this.body);
        if (!backendConfigured) return;
        void getSession().then(() => this.render());
        onSessionChange((session, event) =>
        {
            this.render();
            if (session && event === 'SIGNED_IN') this.toggle(false);
        });
        onProfileChange(() =>
        {
            this.render();
            if (!isGuest() && pendingUpgrade()) { this.toggle(true); this.toasts.show('Your guest progress is now saved to your account. Choose a password to finish.', 'reward'); }
        });
    }

    toggle (open = this.panel.classList.contains('hidden'))
    {
        this.panel.classList.toggle('hidden', !open);
        this.button.setAttribute('aria-expanded', String(open));
        if (open) { this.render(); if (!currentUserEmail()) this.signin.focus(); }
    }

    private render ()
    {
        const email = currentUserEmail();
        this.button.textContent = !email ? 'Sign in' : isGuest() ? 'Guest' : email;
        this.button.title = email && !isGuest() ? `Signed in as ${email}` : '';
        this.message.textContent = '';
        if (!email) { this.signin.refresh(); this.body.replaceChildren(this.signin.root); return; }
        this.body.replaceChildren(...(isGuest() ? this.guestView() : this.accountView(email)));
    }

    private guestView (): HTMLElement[]
    {
        const pending = pendingUpgrade();
        const intro = el('p', 'signin__intro', 'You are playing as a guest. Your NPCs and progress are saved, but a guest account only opens in this browser. Add your email to keep everything and sign in anywhere.');
        const signOutButton = gameButton('btn btn--small btn--link', () => void this.signOutGuest(), 'Sign out');
        if (pending)
        {
            const code = field('text', 'Code from the email', 'one-time-code');
            code.inputMode = 'numeric';
            code.className = 'signin__code';
            const confirm = gameButton('btn btn--primary btn--small', () => void this.run(() => confirmGuestUpgrade(code.value)), 'Confirm');
            code.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm.click(); });
            return [intro,
                el('p', 'signin__intro', 'Check ', el('strong', '', pending), ': open the link in the email, or type its code here.'),
                el('div', 'signin__row', code, confirm),
                el('div', 'signin__row', gameButton('btn btn--small', () => { cancelGuestUpgrade(); this.render(); }, 'Use a different email'), signOutButton),
                this.message];
        }
        const email = field('email', 'you@school.org', 'email');
        const save = gameButton('btn btn--primary btn--small', () => void this.run(() => upgradeGuest(email.value)), 'Save my progress');
        email.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
        return [intro, el('div', 'signin__row', email, save), el('div', 'signin__row', signOutButton), this.message];
    }

    private accountView (email: string): HTMLElement[]
    {
        const finishing = Boolean(pendingUpgrade());
        const password = field('password', `${finishing ? 'Choose a' : 'New'} password (${MIN_PASSWORD}+ characters)`, 'new-password');
        const repeat = field('password', 'Repeat password', 'new-password');
        const save = gameButton('btn btn--primary btn--small', () => void this.run(async () =>
        {
            const result = await setAccountPassword(password.value, repeat.value);
            if (result.ok) { password.value = ''; repeat.value = ''; }
            return result;
        }), 'Save password');
        repeat.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
        const passwords = el('details', 'account__password', el('summary', '', finishing ? 'Choose a password' : 'Set or change password'),
            el('div', 'signin__row', password), el('div', 'signin__row', repeat, save));
        passwords.open = finishing;
        return [
            el('p', 'signin__intro', 'Signed in as ', el('strong', '', email), '. Your NPCs and village are saved to this account.'),
            passwords,
            el('div', 'signin__row', gameButton('btn btn--small', () => void signOut(), 'Sign out')),
            this.message,
        ];
    }

    private async signOutGuest ()
    {
        if (!window.confirm('Sign out of this guest account? Guest accounts cannot be signed back into, so its NPCs and progress will no longer be reachable. Add your email first to keep them.')) return;
        await signOut();
    }

    private async run (action: () => Promise<AuthResult>)
    {
        if (this.busy) return;
        this.busy = true;
        this.message.textContent = 'One moment…';
        this.message.classList.remove('is-error');
        let result: AuthResult;
        try { result = await action(); }
        catch (err) { result = { ok: false, error: err instanceof Error ? err.message : 'Something went wrong.' }; }
        this.busy = false;
        this.render();
        this.message.textContent = result.ok ? result.message : result.error;
        this.message.classList.toggle('is-error', !result.ok);
    }
}
