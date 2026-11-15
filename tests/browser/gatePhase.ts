// Full-screen sign-in gate through the REAL start-up (game/app.ts startApp), one browser profile:
//   gate          signed out: login first, no village, game keys dead while typing, wrong password,
//                 register (confirmation needed = NOT signed in), "add this browser's save?" -> village,
//                 in-game typing in NPC creation / chat never moves the player or opens dialogue
//   gate-reload   refresh keeps the login (no form), village restored; sign out -> call closed, input
//                 stopped, page restart requested
//   gate-switch   a revoked session is refused; another account sees only its own NPCs + progress
//   gate-back     the first account signs back in: its village and progress are back
import { startApp } from '../../src/game/app';
import { npcStore } from '../../src/game/data/npcStore';
import { inputLocked } from '../../src/game/input/inputGuard';
import { log, recoveryLink, stubAccount, VALID_CODE } from './authStub';
import { runRecoveryPhase } from './recoveryPhase';

type Until = (fn: () => unknown, label: string) => Promise<void>;
type Check = (v: unknown, message: string) => void;

const GINA = 'gina@school.org';
const GINA_PASSWORD = 'Gina pa$$ w0rd!';
const BEA_ID = 'aaaaaaaa-0000-4000-8000-0000000000be';

const gate = () => document.getElementById('auth-gate');
const gateUp = () => Boolean(gate() && !gate()!.classList.contains('is-hidden'));
const form = () => gate()?.querySelector('form') ?? null;
const heading = () => form()?.querySelector('h2')?.textContent ?? '';
const input = (label: RegExp) => [...(form()?.querySelectorAll<HTMLInputElement>('input') ?? [])].find((i) => label.test(gate()!.querySelector(`label[for="${i.id}"]`)?.textContent ?? ''))!;
const errors = () => [...(form()?.querySelectorAll('.gate__error') ?? [])].map((e) => e.textContent).join(' | ');
const status = () => gate()?.querySelector('.gate__status')?.textContent ?? '';
const submit = () => form()!.requestSubmit();
const linkButton = (text: string) => [...gate()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const game = () => (window as any).eduroamGame;
const hub = () => game()?.scene.getScene('Hub');
const canvas = () => document.querySelector('#game-container canvas');
const key = (target: EventTarget, k: string, code: string, keyCode: number) =>
{
    for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, { key: k, code, keyCode, bubbles: true, cancelable: true } as KeyboardEventInit));
};
const GAME_KEYS: [string, string, number][] = [['w', 'KeyW', 87], ['a', 'KeyA', 65], ['s', 'KeyS', 83], ['d', 'KeyD', 68], ['e', 'KeyE', 69], ['f', 'KeyF', 70], ['i', 'KeyI', 73], ['Escape', 'Escape', 27], [' ', 'Space', 32], ['1', 'Digit1', 49], ['Enter', 'Enter', 13]];

async function stepFrames (n: number)
{
    for (let i = 0; i < n; i++) { game()?.step(performance.now() + i * 25, 25); await new Promise((r) => setTimeout(r, 0)); }
}

async function enterVillage (until: Until)
{
    await until(() => !gateUp() && game() && hub()?.player && npcStore.syncStatus().state === 'ready', 'gate gone, village loaded');
}

async function signIn (until: Until, email: string, password: string)
{
    await until(() => /Sign in/.test(heading()), 'sign-in form');
    input(/^Email/).value = email;
    input(/^Password/).value = password;
    submit();
}

export async function runGatePhase (phase: string, until: Until, check: Check)
{
    let reloads = 0;
    window.confirm = () => true;

    if (/^gate-(code|reset|link)/.test(phase)) return runRecoveryPhase(phase, until, check, { recoveryLink });

    if (phase === 'gate')
    {
        // A game saved in this browser before accounts existed (must be offered, never silently copied).
        localStorage.setItem('eduroam.npcs', JSON.stringify({ version: 2, npcs: [{ id: 'npc_device', name: 'Device Teacher', subject: 'Art', appearance: 'scientist', map: 'hub', x: 1120, y: 700, dialogue: [], minigameType: null, completed: false, createdAt: '', updatedAt: '' }], buildings: [] }));
        localStorage.setItem('eduroam.tower', JSON.stringify({ version: 1, towerLevel: 3 }));
        void startApp('game-container', { reload: () => { reloads++; } });
        check(gateUp(), 'the gate is up immediately');
        await until(() => /Sign in/.test(heading()), 'signed out: the login screen');
        check(!canvas() && !game(), 'no village (no game at all) behind the login screen');
        check(inputLocked('auth-gate'), 'game input locked while signed out');
        check(!document.body.textContent?.includes('Play as guest'), 'no guest option');

        // Typing game keys into the form: nothing but typing.
        const email = input(/^Email/);
        email.focus();
        for (const [k, code, kc] of GAME_KEYS) key(email, k, code, kc);
        check(gateUp() && /Sign in/.test(heading()), 'W A S D E F I Esc Space 1 Enter do not close or change the login screen');
        const password = input(/^Password/);
        const tricky = 'wasd E f i 1 2 3 !@#$%^&*()_+-=[]{};:\'",.<>/?`~ é ü 漢字 ';
        password.value = tricky;
        linkButton('Show').click();
        check(password.type === 'text' && password.value === tricky, 'show password keeps every character');
        linkButton('Hide').click();
        check(password.type === 'password', 'hide password');
        check(gate()!.querySelectorAll('form').length === 1, 'exactly one form, so Enter submits only it');

        // Inline validation, then wrong credentials.
        email.value = 'gina@school';
        submit();
        await until(() => /incomplete/.test(errors()), 'invalid email shown inline');
        check(log.passwordLogins.length === 0, 'nothing sent for an invalid form');
        stubAccount('aaaaaaaa-0000-4000-8000-0000000000aa', 'olly@school.org', 'right password 1');
        email.value = 'olly@school.org';
        password.value = 'wrong password 1';
        submit();
        await until(() => /Wrong email or password/.test(errors() + status()), 'wrong credentials explained');
        check(gateUp() && !game(), 'still locked out');

        // Register: confirmation needed -> NOT signed in.
        linkButton('Create one.').click();
        await until(() => /Create an account/.test(heading()), 'registration form');
        input(/^Email/).value = GINA;
        input(/^Password/).value = GINA_PASSWORD;
        input(/^Confirm Password/).value = 'something else 1';
        submit();
        await until(() => /do not match/.test(errors()), 'password mismatch inline');
        input(/^Confirm Password/).value = GINA_PASSWORD;
        submit();
        await until(() => /Confirm your email/.test(heading()), 'confirm email step');
        check(!game() && gateUp(), 'a new account that still needs its email is not signed in');
        input(/^Code/).value = VALID_CODE;
        submit();

        // The browser's old save is offered explicitly.
        await until(() => /saved game was found/.test(heading()), 'device save offered');
        check(/1 teacher \(Device Teacher\)/.test(form()!.textContent ?? '') && /game progress/.test(form()!.textContent ?? ''), `offer lists what is saved: ${form()!.textContent}`);
        submit(); // Add To My Account
        await enterVillage(until);
        const gina = npcStore.activeAccount()!;
        check(localStorage.getItem(`eduroam.tower.account.${gina}`) && localStorage.getItem('eduroam.tower'), 'progress copied to the account, original kept');
        await until(() => npcStore.all().some((n) => n.name === 'Device Teacher'), 'device NPC added to the account');
        check(!inputLocked('auth-gate'), 'game input released after sign-in');
        check([...document.querySelectorAll('.manager__bar button')].some((b) => b.textContent === GINA), 'account control shows the email');

        // In the village: typing in game text inputs never drives the game.
        const scene = hub();
        await stepFrames(5);
        const start = { x: scene.player.x, y: scene.player.y };
        [...document.querySelectorAll<HTMLButtonElement>('.manager__bar button')].find((b) => b.textContent === '+ Add NPC')!.click();
        const nameInput = document.querySelector<HTMLInputElement>('.npc-form input')!;
        nameInput.focus();
        for (let i = 0; i < 20; i++) { key(nameInput, 'd', 'KeyD', 68); key(nameInput, 'w', 'KeyW', 87); key(nameInput, 'e', 'KeyE', 69); await stepFrames(1); }
        check(Math.abs(scene.player.x - start.x) < 1 && Math.abs(scene.player.y - start.y) < 1, `typing in NPC creation does not move the player (${scene.player.x - start.x}, ${scene.player.y - start.y})`);
        check(!document.querySelector('.dialogue:not(.hidden)'), 'E in a field does not talk to anyone');
        check(game().input.keyboard.enabled === false, 'Phaser keyboard off while a field has focus');
        nameInput.blur();
        await new Promise((r) => setTimeout(r, 10));
        check(game().input.keyboard.enabled === true, 'Phaser keyboard back on after leaving the field');
        check(reloads === 0, 'no page restart');
        return;
    }

    if (phase === 'gate-reload')
    {
        void startApp('game-container', { reload: () => { reloads++; } });
        await enterVillage(until);
        check(!gate()?.querySelector('form'), 'refresh: no login form, the saved session was verified');
        check(npcStore.all().some((n) => n.name === 'Device Teacher'), 'village restored from the account');
        const writes = log.npcBodies.length;
        check(writes === 0, 'loading writes no NPCs');
        // Sign out from the in-game account control.
        [...document.querySelectorAll<HTMLButtonElement>('.manager__bar button')].find((b) => b.textContent === GINA)!.click();
        [...document.querySelectorAll<HTMLButtonElement>('.account button')].find((b) => b.textContent === 'Sign out')!.click();
        await until(() => reloads === 1, 'sign out restarts the page (no account data left in memory)');
        check(gateUp() && inputLocked('auth-gate'), 'gate back up, game input stopped');
        check(game().isPaused, 'game paused');
        check(localStorage.getItem('eduroam.npcs')?.includes('Device Teacher'), 'local saves are not wiped by signing out');
        return;
    }

    if (phase === 'gate-switch')
    {
        localStorage.setItem('stub.rejectUser', '1');
        stubAccount(BEA_ID, 'bea@school.org', 'bea password 1');
        localStorage.setItem('stub.npcs', JSON.stringify([...JSON.parse(localStorage.getItem('stub.npcs') ?? '[]'), { id: 'bbbbbbbb-0000-4000-8000-0000000000be', owner_id: BEA_ID, game_npc_id: 'npc_bea', name: 'Bea Teacher', subject: 'History', appearance: 'scientist', class_id: 'class-1',
            game_state: { v: 1, map: 'hub', x: 1000, y: 600, dialogue: [], reactions: {}, minigameType: null, completed: false, building: null } }]));
        void startApp('game-container', { reload: () => { reloads++; } });
        await until(() => /Sign in/.test(heading()), 'a session the server rejects is not let in');
        check(!game(), 'no game for a rejected session');
        localStorage.removeItem('stub.rejectUser');
        await signIn(until, 'bea@school.org', 'bea password 1');
        await enterVillage(until);
        check(JSON.stringify(npcStore.all().map((n) => n.name)) === JSON.stringify(['Bea Teacher']), `only Bea's NPCs: ${npcStore.all().map((n) => n.name)}`);
        check(!localStorage.getItem(`eduroam.tower.account.${BEA_ID}`) || !localStorage.getItem(`eduroam.tower.account.${BEA_ID}`)!.includes('"towerLevel":3'), 'Bea does not get the browser save (Gina adopted it)');
        return;
    }

    if (phase === 'gate-back')
    {
        // Bea's session is saved: sign out first (the gate restarts the page in real life).
        void startApp('game-container', { reload: () => { reloads++; } });
        await enterVillage(until);
        [...document.querySelectorAll<HTMLButtonElement>('.manager__bar button')].find((b) => b.textContent === 'bea@school.org')!.click();
        [...document.querySelectorAll<HTMLButtonElement>('.account button')].find((b) => b.textContent === 'Sign out')!.click();
        await until(() => reloads === 1, 'signed out');
        return;
    }

    if (phase === 'gate-return')
    {
        void startApp('game-container', { reload: () => { reloads++; } });
        await signIn(until, GINA, GINA_PASSWORD);
        await enterVillage(until);
        const gina = npcStore.activeAccount()!;
        check(npcStore.all().some((n) => n.name === 'Device Teacher') && !npcStore.all().some((n) => n.name === 'Bea Teacher'), `Gina's village is back, nothing of Bea's: ${npcStore.all().map((n) => n.name)}`);
        check(localStorage.getItem(`eduroam.tower.account.${gina}`)?.includes('"towerLevel":3'), 'Gina own progress is back');
        check(!form(), 'no device-save question again');
        check(log.npcBodies.length === 0, 'signing back in writes no NPCs');
    }
}
