// Email codes + password reset through the REAL start-up (game/app.ts startApp) against the
// in-page fake Supabase (authStub.ts). MOCKED: no email is sent and no real project is used.
//   gate-code          sign in with an emailed 6-digit code: unknown address (neutral answer, no
//                      account created), resend cooldown, wrong code, expired code, correct code
//                      -> the EXISTING account and its NPCs, nothing rewritten
//   gate-reset         forgot password: neutral answer for unknown addresses, reset email, wrong
//                      code, correct code -> "Choose a new password" and no village
//   gate-reset-reload  refresh during the reset keeps "Choose a new password"; saving it -> village
//                      (same account, records unchanged); sign out
//   gate-reset-login   the old password is refused, the new one signs in
//   gate-link          opening the reset LINK -> "Choose a new password" (no village), URL cleaned
//   gate-link-expired  a used / expired link explains itself; a stale reset marker of another
//                      account does not turn a normal sign-in into a reset
import { startApp } from '../../src/game/app';
import { npcStore } from '../../src/game/data/npcStore';
import { inputLocked } from '../../src/game/input/inputGuard';
import { log, stubAccount, VALID_CODE } from './authStub';

type Until = (fn: () => unknown, label: string) => Promise<void>;
type Check = (v: unknown, message: string) => void;

const CODY = { id: 'aaaaaaaa-0000-4000-8000-0000000000c0', email: 'cody@school.org', password: 'cody password 1' };
const RITA = { id: 'aaaaaaaa-0000-4000-8000-0000000000e1', email: 'rita@school.org', old: 'rita old pass 1', next: 'Rita new pa$$ 2' };
const LINA = { id: 'aaaaaaaa-0000-4000-8000-0000000000f1', email: 'lina@school.org', old: 'lina old pass 1', next: 'lina new pass 2' };

const gate = () => document.getElementById('auth-gate');
const gateUp = () => Boolean(gate() && !gate()!.classList.contains('is-hidden'));
const form = () => gate()?.querySelector('form') ?? null;
const heading = () => form()?.querySelector('h2')?.textContent ?? '';
const input = (label: RegExp) => [...(form()?.querySelectorAll<HTMLInputElement>('input') ?? [])].find((i) => label.test(gate()!.querySelector(`label[for="${i.id}"]`)?.textContent ?? ''))!;
const errors = () => [...(form()?.querySelectorAll('.gate__error') ?? [])].map((e) => e.textContent).join(' | ');
const status = () => gate()?.querySelector('.gate__status')?.textContent ?? '';
const said = () => `${errors()} ${status()}`;
const submit = () => form()!.requestSubmit();
const gateButton = (prefix: string) => [...gate()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith(prefix))!;
const game = () => (window as any).eduroamGame;

/** A server-side NPC (with its village placement) owned by `ownerId`: the student's existing records. */
function seedNpc (ownerId: string, name: string)
{
    const rows = JSON.parse(localStorage.getItem('stub.npcs') ?? '[]');
    rows.push({ id: crypto.randomUUID(), owner_id: ownerId, game_npc_id: `npc_${name.split(' ')[0].toLowerCase()}`, name, subject: 'Physics', appearance: 'scientist', class_id: 'class-1',
        game_state: { v: 1, map: 'hub', x: 1000, y: 600, dialogue: [], reactions: {}, minigameType: null, completed: false, building: null } });
    localStorage.setItem('stub.npcs', JSON.stringify(rows));
}
const serverRecords = () => localStorage.getItem('stub.npcs');

/** Pretends the last email was requested `ms` ago (resend cooldown, code age) on both sides. */
function age (email: string, kind: 'email' | 'recovery', ms: number)
{
    const pending = JSON.parse(localStorage.getItem('eduroam.authCode') ?? 'null');
    if (pending) localStorage.setItem('eduroam.authCode', JSON.stringify({ ...pending, sentAt: Date.now() - ms }));
    localStorage.removeItem('eduroam.authRetryAt');
    const codes = JSON.parse(localStorage.getItem('stub.codes') ?? '{}');
    if (codes[`${kind}:${email}`]) codes[`${kind}:${email}`] = Date.now() - ms;
    localStorage.setItem('stub.codes', JSON.stringify(codes));
}

async function village (until: Until, id: string)
{
    await until(() => !gateUp() && game()?.scene.getScene('Hub')?.player && npcStore.syncStatus().state === 'ready', 'gate gone, village loaded');
    if (npcStore.activeAccount() !== id) throw new Error(`signed in as the wrong account: ${npcStore.activeAccount()}`);
}

export async function runRecoveryPhase (phase: string, until: Until, check: Check, ctx: { recoveryLink: (id: string) => string })
{
    let reloads = 0;
    window.confirm = () => true;
    const start = () => void startApp('game-container', { reload: () => { reloads++; } });

    if (phase === 'gate-code')
    {
        stubAccount(CODY.id, CODY.email, CODY.password);
        seedNpc(CODY.id, 'Cody Physics');
        const before = serverRecords();
        start();
        await until(() => /Sign in/.test(heading()), 'login screen');
        gateButton('Email me a sign-in code').click();
        await until(() => /Sign in with an email code/.test(heading()), 'code sign-in view');

        // An address without an account: same answer, code step, but no account and no email.
        input(/^Email/).value = 'nobody@school.org';
        submit();
        await until(() => /Enter your code/.test(heading()), 'code entry after an unknown address');
        check(/If nobody@school\.org has an EDUROAM account, a 6-digit sign-in code is on its way/.test(status()), `neutral answer: ${status()}`);
        check(log.otpRequests.length === 1 && log.otpRequests[0].createUser === false, 'signInWithOtp with shouldCreateUser: false');
        check(!JSON.stringify(JSON.parse(localStorage.getItem('stub.users') ?? '{}')).includes('nobody@school.org'), 'no account was created');

        // Resend cooldown: disabled with a countdown, a click sends nothing.
        const resend = gateButton('Resend code');
        check(resend.disabled && /\(\d+s\)/.test(resend.textContent ?? ''), `resend waits: "${resend.textContent}"`);
        resend.click();
        gateButton('Use a different email').click();
        await until(() => /Sign in with an email code/.test(heading()), 'back to the email step');
        const send = gateButton('Send Code');
        check(send.disabled && /\(\d+s\)/.test(send.textContent ?? ''), `Send Code waits too: "${send.textContent}"`);
        input(/^Email/).value = CODY.email;
        submit();
        await new Promise((r) => setTimeout(r, 50));
        check(log.otpRequests.length === 1, 'no request during the cooldown (button, click and Enter)');
        age('nobody@school.org', 'email', 61_000);
        await until(() => !gateButton('Send Code').disabled && gateButton('Send Code').textContent === 'Send Code', 'cooldown over');
        submit();
        await until(() => /Enter your code/.test(heading()) && log.otpRequests.length === 2, 'code sent to the real account');
        check(log.otpRequests[1].email === CODY.email && log.otpRequests[1].redirect?.startsWith(location.origin), 'one request, redirect to this page');

        // Wrong code, then an expired one.
        input(/^Code/).value = '000000';
        submit();
        await until(() => /wrong or has expired/.test(said()), 'wrong code rejected');
        check(gateUp() && !game(), 'still locked out after a wrong code');
        age(CODY.email, 'email', 2 * 3600_000);
        input(/^Code/).value = VALID_CODE;
        submit();
        await until(() => /That code has expired/.test(said()), 'expired code explained');
        check(!game(), 'still locked out after an expired code');

        // A fresh code (resend is allowed again) signs in to the EXISTING account.
        await until(() => !gateButton('Resend code').disabled, 'resend available');
        gateButton('Resend code').click();
        await until(() => log.otpRequests.length === 3, 'new code requested');
        input(/^Code/).value = '123 456';
        submit();
        await village(until, CODY.id);
        check(log.verifyRequests.at(-1)?.type === 'email' && log.verifyRequests.at(-1)?.token === VALID_CODE, 'verifyOtp type "email" with the typed digits');
        check(npcStore.all().some((n) => n.name === 'Cody Physics'), 'the account\'s own NPC is loaded');
        check(serverRecords() === before && log.npcBodies.length === 0, 'existing records untouched');
        check(!inputLocked('auth-gate'), 'game input released');
        return;
    }

    if (phase === 'gate-reset')
    {
        stubAccount(RITA.id, RITA.email, RITA.old);
        seedNpc(RITA.id, 'Rita Physics');
        localStorage.setItem('reset.records', serverRecords() ?? '');
        start();
        await until(() => /Sign in/.test(heading()), 'login screen');
        gateButton('Forgot your password?').click();
        await until(() => /Reset your password/.test(heading()), 'reset request view');

        input(/^Email/).value = 'ghost@school.org';
        submit();
        await until(() => /Check your email/.test(heading()), 'same answer for an unknown address');
        check(/If ghost@school\.org has an EDUROAM account, we emailed it a 6-digit reset code/.test(status()), `neutral: ${status()}`);
        check(log.recoverRequests.length === 1 && log.recoverRequests[0].redirect?.startsWith(location.origin), 'resetPasswordForEmail with a redirect to this page');
        check(gateButton('Send a new code').disabled, 'resend on cooldown');

        age('ghost@school.org', 'recovery', 61_000);
        gateButton('Use a different email').click();
        await until(() => /Reset your password/.test(heading()) && !gateButton('Send Reset Email').disabled, 'email step, cooldown over');
        input(/^Email/).value = RITA.email;
        submit();
        await until(() => /Check your email/.test(heading()) && log.recoverRequests.length === 2, 'reset email for the real account');

        input(/^Code/).value = '000000';
        submit();
        await until(() => /wrong or has expired/.test(said()), 'wrong reset code rejected');
        input(/^Code/).value = VALID_CODE;
        submit();
        await until(() => /Choose a new password/.test(heading()), 'valid reset code -> choose a new password');
        check(log.verifyRequests.at(-1)?.type === 'recovery', 'verifyOtp type "recovery"');
        check(gateUp() && !game() && inputLocked('auth-gate'), 'no village while the reset is unfinished');
        check(localStorage.getItem('eduroam.passwordRecovery') === RITA.id, 'reset in progress for this account');
        return;
    }

    if (phase === 'gate-reset-reload')
    {
        start();
        await until(() => /Choose a new password/.test(heading()), 'refresh: still "choose a new password"');
        check(!game(), 'refresh did not skip the reset');
        input(/^New password/).value = 'short';
        submit();
        await until(() => /at least 8/.test(errors()), 'too short refused before any request');
        input(/^New password/).value = RITA.next;
        input(/^Confirm Password/).value = 'different 123';
        submit();
        await until(() => /do not match/.test(errors()), 'mismatch refused');
        check(log.passwordUpdates.length === 0, 'nothing sent for an invalid form');
        input(/^Confirm Password/).value = RITA.next;
        submit();
        await village(until, RITA.id);
        check(JSON.stringify(log.passwordUpdates) === JSON.stringify([RITA.id]), 'updateUser({ password }) for this account, once');
        check(!localStorage.getItem('eduroam.passwordRecovery'), 'reset finished');
        check(npcStore.all().some((n) => n.name === 'Rita Physics') && serverRecords() === localStorage.getItem('reset.records') && log.npcBodies.length === 0, 'same account, records unchanged');
        [...document.querySelectorAll<HTMLButtonElement>('.manager__bar button')].find((b) => b.textContent === RITA.email)!.click();
        [...document.querySelectorAll<HTMLButtonElement>('.account button')].find((b) => b.textContent === 'Sign out')!.click();
        await until(() => reloads === 1, 'signed out');
        return;
    }

    if (phase === 'gate-reset-login')
    {
        start();
        await until(() => /Sign in/.test(heading()), 'login screen');
        input(/^Email/).value = RITA.email;
        input(/^Password/).value = RITA.old;
        submit();
        await until(() => /Wrong email or password/.test(said()), 'the old password no longer works');
        input(/^Password/).value = RITA.next;
        submit();
        await village(until, RITA.id);
        check(npcStore.all().some((n) => n.name === 'Rita Physics'), 'the new password opens the same village');
        return;
    }

    if (phase === 'gate-link')
    {
        stubAccount(LINA.id, LINA.email, LINA.old);
        history.replaceState(null, '', `${location.pathname}${location.search}${ctx.recoveryLink(LINA.id)}`);
        start();
        await until(() => /Choose a new password/.test(heading()), 'reset link -> choose a new password');
        check(!game() && inputLocked('auth-gate'), 'no village from a reset link');
        check(!/access_token|type=recovery/.test(location.href), 'tokens removed from the address bar');
        input(/^New password/).value = LINA.next;
        input(/^Confirm Password/).value = LINA.next;
        submit();
        await village(until, LINA.id);
        check(JSON.stringify(log.passwordUpdates) === JSON.stringify([LINA.id]), 'password updated for the link\'s account');
        return;
    }

    if (phase === 'gate-link-expired')
    {
        stubAccount(LINA.id, LINA.email, LINA.old);
        // A reset another account started on this browser earlier: must not hijack this sign-in.
        localStorage.setItem('eduroam.passwordRecovery', RITA.id);
        start();
        await until(() => /Sign in/.test(heading()) && /expired or was already used/.test(status()), 'used / expired link explained');
        check(!game(), 'no village');
        check(!/error_code|error_description/.test(location.href) && /phase=gate-link-expired/.test(location.href), 'error removed from the URL, game URL kept');
        input(/^Email/).value = LINA.email;
        input(/^Password/).value = LINA.old;
        submit();
        await village(until, LINA.id);
        check(log.passwordUpdates.length === 0, 'a normal sign-in is not treated as a password reset');
        check(!localStorage.getItem('eduroam.passwordRecovery'), 'stale reset marker cleared by a real sign-in');
    }
}
