// Browser test for the in-game email-code sign-in (run by tests/browserAuth.mjs).
//   ?phase=login    invalid email, send code, repeated request, wrong/short codes, valid code
//                   -> the open NPC panel unlocks without a reload or a second game
//   ?phase=reload   same browser profile: the saved session + conversation history come back
//   ?phase=limit    fresh profile at phone size: HTTP 429 shows a clear error, no "sent" message
import { installStub, log, USER_ID } from './authStub';
import { runDashPhase } from './dashPhase';

const result = document.getElementById('auth-result')!;
const phase = new URLSearchParams(location.search).get('phase');
installStub(import.meta.env.VITE_SUPABASE_URL as string);

function check (value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
let step: (() => void) | null = null;
let frameMs = 25;
const DONE = new Error('done');
async function until (predicate: () => unknown, label: string)
{
    for (let i = 0; i < 600; i++)
    {
        step?.();
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out: ${label}. Status="${text(".tutor__status")}" message="${text(".tutor .signin__message")}" dialogue="${text(".dialogue")}" env=${String(import.meta.env.VITE_SUPABASE_URL)} dbg=${(window as any).dbg?.()}`);
}
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const text = (selector: string) => q(selector)?.textContent?.trim() ?? '';
const visible = (selector: string) => { const node = q(selector); return Boolean(node && node.offsetParent !== null); };
function button (scope: string, label: string)
{
    const found = [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((b) => b.textContent?.includes(label) && b.offsetParent !== null);
    check(found, `Missing visible button "${label}" in ${scope}`);
    return found;
}
function type (selector: string, value: string)
{
    const input = q<HTMLInputElement>(selector);
    check(input && input.offsetParent !== null, `Missing visible input ${selector}`);
    input.value = value;
}
const message = () => text('.tutor .signin__message');

try
{
    // Account phases: guests allowed; "another browser" = same fake server, none of this browser's game data.
    if (phase?.startsWith('accounts')) localStorage.setItem('stub.guests', '1');
    if (phase === 'accounts-other-browser') for (const key of Object.keys(localStorage)) if (key.startsWith('eduroam.')) localStorage.removeItem(key);
    // Screenshot-only: the sign-in gate as a signed-out player first sees it (tests/browserScreens.mjs).
    if (phase?.startsWith('screen-gate'))
    {
        const { startApp } = await import('../../src/game/app');
        void startApp('game-container');
        await until(() => document.querySelector('#auth-gate form'), 'gate form');
        const open = { 'screen-gate-register': 'Create one.', 'screen-gate-code': 'Email me a sign-in code instead', 'screen-gate-reset': 'Forgot your password?' }[phase as string];
        if (open) [...document.querySelectorAll<HTMLButtonElement>('#auth-gate button')].find((b) => b.textContent === open)!.click();
        if (phase === 'screen-gate-code' || phase === 'screen-gate-reset')
        {
            // The next step: the code entry screen with its resend countdown.
            const form = document.querySelector<HTMLFormElement>('#auth-gate form')!;
            form.querySelector<HTMLInputElement>('input[type=email]')!.value = 'student@school.org';
            form.requestSubmit();
            await until(() => /Enter your code|Check your email/.test(document.querySelector('#auth-gate h2')?.textContent ?? ''), 'code step');
        }
        result.textContent = `PASS: ${phase}`;
        result.style.display = 'none';
        throw DONE;
    }
    // The real start-up (sign-in gate first): game/app.ts creates the game itself after sign-in.
    if (phase?.startsWith('gate'))
    {
        step = () => (window as any).eduroamGame?.isRunning && !(window as any).eduroamGame.isPaused && (window as any).eduroamGame.step(performance.now(), frameMs);
        const { runGatePhase } = await import('./gatePhase');
        await runGatePhase(phase, until, check);
        result.textContent = `PASS: ${phase}`;
        throw DONE;
    }
    const { default: StartGame } = await import('../../src/game/main');
    const game = StartGame('game-container');
    (window as any).dbg = () => JSON.stringify({ running: (game as any).isRunning, booted: game.isBooted, scenes: game.scene.getScenes(false).map((x: any) => `${x.scene.key}:${x.sys.settings.status}`), errors: (window as any).authErrors });
    // Headless virtual time may throttle requestAnimationFrame: drive Phaser explicitly once booted.
    let clock = performance.now();
    step = () =>
    {
        if (!game.isRunning) return;
        if (game.loop.running) game.loop.stop();
        game.step(clock += frameMs, frameMs);
    };
    const hub = () => game.scene.getScene('Hub') as any;
    await until(() => game.scene.isActive('Hub') && hub()?.player && hub()?.npcs?.length, 'hub boot');
    const scene = hub();
    const npc = scene.npcs.find((n: any) => n.record.minigameType) ?? scene.npcs[0];
    const before = { x: scene.player.x, y: scene.player.y, canvases: document.querySelectorAll('canvas').length };

    if (phase === 'dash')
    {
        const { getUi } = await import('../../src/game/ui');
        await runDashPhase({ game, scene, npc, ui: getUi(), until, check, setFrameMs: (ms) => { frameMs = ms; } });
        result.textContent = 'PASS: dash';
        throw DONE;
    }
    // Screenshot-only states (tests/browserScreens.mjs): not assertions, just real rendering.
    if (phase === 'npc-delete')
    {
        const { runNpcDeletionPhase } = await import('./npcDeletionPhase');
        const { getUi } = await import('../../src/game/ui');
        await runNpcDeletionPhase(getUi(), until, check);
        result.textContent = 'PASS: npc-delete';
        throw DONE;
    }
    if (phase?.startsWith('accounts'))
    {
        const { runAccountsPhase } = await import('./accountsPhase');
        await runAccountsPhase(phase, until, check);
        result.textContent = `PASS: ${phase}`;
        throw DONE;
    }
    if (phase === 'npc-delete-all')
    {
        const { runNpcDeleteAllPhase } = await import('./npcDeletionPhase');
        await runNpcDeleteAllPhase(until, check);
        result.textContent = 'PASS: npc-delete-all';
        throw DONE;
    }
    const fakeFiles = async () =>
    {
        // A real picture for the thumbnail: the scientist portrait drawn by the game itself.
        const portrait = q<HTMLImageElement>('.look img') ?? q<HTMLImageElement>('.tutor .portrait');
        const png = await (await fetch(portrait?.src || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')).blob();
        return [new File([png], 'worksheet-photo.png', { type: 'image/png' }), new File(['%PDF-1.4 notes'], 'Derivatives - chapter 3 notes.pdf', { type: 'application/pdf' })];
    };
    const drop = (selector: string, files: File[]) =>
    {
        const input = q<HTMLInputElement>(selector)!;
        const transfer = new DataTransfer();
        files.forEach((f) => transfer.items.add(f));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));
    };
    if (phase === 'screen-npc')
    {
        // Editing waits for the account's NPCs to load from Supabase.
        await until(() => !button('.manager', 'Add NPC').disabled, 'NPCs loaded');
        button('.manager', 'Add NPC').click();
        await until(() => visible('.npc-form'), 'NPC form');
        type('.npc-form input[maxlength="32"]', 'Professor Maple');
        button('.npc-form', 'Create & place').click();
        await until(() => [...document.querySelectorAll('.npc-form .field__error')].some((e) => e.textContent), 'inline validation');
        await until(() => visible('.materials-box'), 'materials (signed in)');
        drop('.npc-form .attach input[type=file]', await fakeFiles());
        await until(() => document.querySelectorAll('.npc-form .attach-chip').length === 2, 'material chips');
        result.textContent = 'PASS: screen-npc';
        result.style.display = 'none';
        throw DONE;
    }
    // Real talk flow: dialogue -> "Chat & Study" opens the tutor panel.
    scene.talkTo(npc);
    const { getUi } = await import('../../src/game/ui');
    const hasChat = () => [...document.querySelectorAll('.choice')].some((c) => c.textContent?.includes('Chat & Study'));
    await until(() => visible('.dialogue'), 'greeting');
    for (let i = 0; i < 10 && !hasChat(); i++) getUi().dialogue.handleKey('e'); // advance greeting lines
    await until(hasChat, 'Chat & Study choice');
    ([...document.querySelectorAll<HTMLButtonElement>('.choice')].find((c) => c.textContent?.includes('Chat & Study')))!.click();
    await until(() => visible('.tutor'), 'tutor panel open');

    if (phase === 'screen-chat')
    {
        await until(() => visible('.tutor__log') && !(q<HTMLTextAreaElement>('.tutor__input')!.disabled), 'chat ready');
        drop('.tutor .attach input[type=file]', await fakeFiles());
        await until(() => document.querySelectorAll('.tutor .attach-chip').length === 2, 'chat chips');
        q<HTMLTextAreaElement>('.tutor__input')!.value = 'Can you explain this worksheet?';
        result.textContent = 'PASS: screen-chat';
        result.style.display = 'none';
        throw DONE;
    }
    if (phase === 'login')
    {
        await until(() => visible('.tutor .signin'), 'sign-in form shown when signed out');
        check(button('.tutor__tabs', 'History').disabled, 'tabs are locked while signed out');
        await new Promise((r) => setTimeout(r, 200));
        check(![...document.querySelectorAll<HTMLButtonElement>('.tutor .signin button')].some((x) => x.textContent?.includes('guest') && x.offsetParent !== null), 'guest button hidden when anonymous sign-ins are off');

        type('.tutor .signin input[type=email]', 'not-an-email');
        button('.tutor .signin', 'Send Code').click();
        await until(() => /valid email/.test(message()), 'invalid email message');
        check(log.otpRequests.length === 0, 'invalid email is not sent');

        type('.tutor .signin input[type=email]', 'Student@School.org');
        button('.tutor .signin', 'Send Code').click();
        await until(() => visible('.tutor .signin__code'), 'code entry step');
        check(/student@school\.org has an EDUROAM account, a 6-digit sign-in code is on its way/.test(message()), `success message only after the request succeeded: ${message()}`);
        check(log.otpRequests[0].createUser === false, 'a sign-in code never creates an account');
        check(log.otpRequests.length === 1 && log.otpRequests[0].email === 'student@school.org', 'one OTP request');
        check(!/localhost/.test(log.otpRequests[0].redirect ?? '') || location.hostname === '127.0.0.1' || location.hostname === 'localhost', 'redirect follows the page origin');
        check(log.otpRequests[0].redirect?.startsWith(location.origin), `redirect uses the current origin: ${log.otpRequests[0].redirect}`);

        const resend = button('.tutor .signin', 'Resend code');
        check(resend.disabled && /\(\d+s\)/.test(resend.textContent ?? ''), 'resend is on cooldown');
        resend.click();
        await new Promise((r) => setTimeout(r, 100));
        check(log.otpRequests.length === 1, 'repeated request is blocked by the cooldown');

        type('.tutor .signin__code', '12345');
        button('.tutor .signin', 'Verify').click();
        await until(() => /6-digit code/.test(message()), 'short code message');
        check(log.verifyRequests.length === 0, 'short code is not sent');

        type('.tutor .signin__code', '000000');
        button('.tutor .signin', 'Verify').click();
        await until(() => /wrong or has expired/.test(message()), 'wrong/expired code message');
        check(visible('.tutor .signin'), 'still signed out after a wrong code');

        type('.tutor .signin__code', '123 456');
        button('.tutor .signin', 'Verify').click();
        await until(() => visible('.tutor__log') && !visible('.tutor .signin'), 'panel unlocks after verification');
        await until(() => !button('.tutor__tabs', 'History').disabled, 'tabs unlocked');
        check(log.verifyRequests.at(-1)?.type === 'email' && log.verifyRequests.at(-1)?.token === '123456', 'verifyOtp type "email"');
        check(text('.tutor__subtitle').length > 0 && !/Class: .*Class:/.test(text('.tutor__head')), 'one subject / class line');
        check(text('.tutor__account').includes('student@school.org'), 'account shown');
        await until(() => log.legacyIds.length > 0, 'local player linked');
        check(log.classOwners.length > 0 && log.classOwners.every((id) => id === USER_ID), `class owner is the Supabase user: ${log.classOwners}`);
        check(log.legacyIds[0]?.startsWith('player_'), 'local player id kept separately (legacy_local_id)');
        check(hub() === scene && game.scene.isActive('Hub') && scene.sys.settings.status === 5, 'same scene instance');
        check(document.querySelectorAll('canvas').length === before.canvases, 'no second game');
        check(scene.player.x === before.x && scene.player.y === before.y, 'player position unchanged');

        type('.tutor__input', 'Help me add fractions');
        button('.tutor__composer', 'Send').click();
        await until(() => text('.tutor__log').includes('3/4 + 1/4'), 'tutor reply');
        result.textContent = 'PASS: login';
    }
    else if (phase === 'reload')
    {
        await until(() => /Help me add fractions|Explain how to solve this|Explain this./.test(text('.tutor__log')), 'history restored after reload');
        check(!visible('.tutor .signin'), 'no sign-in needed after reload');
        check(log.otpRequests.length === 0 && log.verifyRequests.length === 0, 'no new email');
        check(text('.tutor__account').includes('student@school.org'), 'account restored');
        button('.tutor__account', 'Sign out').click();
        await until(() => visible('.tutor .signin'), 'sign out locks the panel again');
        check(button('.tutor__tabs', 'Chat').disabled, 'tabs locked after sign-out');
        // A 429 WITH Retry-After blocks sending for exactly that long.
        type('.tutor .signin input[type=email]', 'retry@school.org');
        button('.tutor .signin', 'Send Code').click();
        await until(() => /Try again in about 2 min/.test(message()), 'Retry-After message');
        const blocked = button('.tutor .signin', 'Send Code');
        check(blocked.disabled && /\(2 min\)|\(1\d\ds\)|\(\d+s\)/.test(blocked.textContent ?? ''), `button waits for Retry-After: "${blocked.textContent}"`);
        blocked.click();
        await new Promise((r) => setTimeout(r, 100));
        check(log.otpRequests.length === 1, 'no request while Retry-After is pending');
        check(!visible('.tutor .signin__code'), 'no code step after a rejected request');
        result.textContent = 'PASS: reload';
    }
    else if (phase === 'limit')
    {
        await until(() => visible('.tutor .signin'), 'sign-in form');
        type('.tutor .signin input[type=email]', 'limit@school.org');
        button('.tutor .signin', 'Send Code').click();
        await until(() => /hourly sign-in email limit/.test(message()), 'email-quota message');
        check(!/code is on its way/.test(message()) && !/60s|wait \d+s/.test(message()), `no "sent" text and no fake short wait: ${message()}`);
        check(!visible('.tutor .signin__code'), 'stays on the email step (no code exists)');
        const send = button('.tutor .signin', 'Send Code');
        check(!send.disabled && send.textContent === 'Send Code', `rejected request starts no countdown: "${send.textContent}"`);
        check(log.otpRequests.length === 1, 'no automatic retry');
        // A later accepted request does start the normal 60 s resend cooldown.
        type('.tutor .signin input[type=email]', 'student@school.org');
        button('.tutor .signin', 'Send Code').click();
        await until(() => visible('.tutor .signin__code'), 'code step after an accepted request');
        check(button('.tutor .signin', 'Resend code').disabled, 'cooldown only after success');
        check(log.otpRequests.length === 2, 'exactly one request per click');
        const panel = q('.tutor')!.getBoundingClientRect();
        check(window.innerWidth <= 480, `phone-sized viewport (${window.innerWidth}px)`);
        check(panel.left >= 0 && panel.right <= window.innerWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1, 'panel fits the phone width');
        result.textContent = 'PASS: limit';
    }
    else throw new Error(`Unknown phase ${phase}`);
}
catch (err)
{
    if (err === DONE) { /* phase finished */ }
    else
    result.textContent = `FAIL: ${err instanceof Error ? err.message : String(err)}`;
}
