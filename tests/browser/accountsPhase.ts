// Accounts + Supabase-backed village (run by tests/browserAuth.mjs, one browser profile, in order):
//   accounts               register + confirm, edits blocked while loading, server-confirmed saves
//                          (and undo on failure), logout, password sign-in, switching accounts, delete
//   accounts-reload        refresh: session + village come back from Supabase; a deleted NPC planted in
//                          stale localStorage is NOT recreated
//   accounts-guest         play as guest, then keep the progress with an email + password (same account id)
//   accounts-other-browser no game data in this browser: signing in restores the same village
import { npcStore } from '../../src/game/data/npcStore';
import { saveNpc } from '../../src/game/services/npcSync';
import { signInAsGuest } from '../../src/game/services/backend';
import { log, stubAccount, VALID_CODE } from './authStub';

type Until = (fn: () => unknown, label: string) => Promise<void>;
type Check = (v: unknown, message: string) => void;

const ADA = 'ada@school.org';
const ADA_PASSWORD = 'correct horse 1';
const BEA_ID = 'aaaaaaaa-0000-4000-8000-0000000000be';
const SPOT = { map: 'hub' as const, x: 1088, y: 640, npcX: 1120, npcY: 700 };

const visible = (node: Element | null | undefined): node is HTMLElement => Boolean(node && (node as HTMLElement).offsetParent !== null);
const panel = () => document.querySelector<HTMLElement>('.account')!;
const status = () => panel().querySelector('.signin__message')?.textContent ?? '';
function click (scope: Element, label: string | RegExp)
{
    const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => visible(b) && (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? '')));
    if (!found) throw new Error(`Missing visible button "${label}"`);
    found.click();
}
function fill (scope: Element, placeholder: string | RegExp, value: string)
{
    const input = [...scope.querySelectorAll<HTMLInputElement>('input')].find((i) => visible(i) && (typeof placeholder === 'string' ? i.placeholder === placeholder : placeholder.test(i.placeholder)));
    if (!input) throw new Error(`Missing visible input "${placeholder}"`);
    input.value = value;
}
const bar = () => document.querySelector<HTMLElement>('.manager__bar')!;
/** The visible sign-in step (its action buttons share labels with the tabs). */
const step = () => [...panel().querySelectorAll<HTMLElement>('.signin__step')].find((el) => visible(el))!;
const openAccount = () => { if (panel().classList.contains('hidden')) document.querySelector<HTMLButtonElement>('.manager__bar .account-button')!.click(); };
/** Opens the NPC list if it is closed (editing closes it). */
const openList = () => { if (!visible(document.querySelector('.npc-list'))) click(bar(), /^NPCs/); };
const names = () => npcStore.all().map((n) => n.name).sort();
const serverRows = () => (JSON.parse(localStorage.getItem('stub.npcs') ?? '[]') as any[]);

async function signInWithPassword (until: Until, email: string, password: string)
{
    openAccount();
    click(panel(), 'Sign in');
    fill(panel(), 'you@school.org', email);
    fill(panel(), 'Password', password);
    click(step(), 'Sign in');
    await until(() => npcStore.activeAccount() && npcStore.syncStatus().state === 'ready', `signed in as ${email} and village loaded`);
}

async function signOut (until: Until)
{
    openAccount();
    click(panel(), 'Sign out');
    await until(() => npcStore.activeAccount() === null, 'signed out');
}

export async function runAccountsPhase (phase: string, until: Until, check: Check)
{
    window.confirm = () => true;

    if (phase === 'accounts')
    {
        check(npcStore.activeAccount() === null && npcStore.syncStatus().state === 'local', 'signed out: this device\'s own village');
        check(names().includes('Sir Sum-a-Lot'), 'device village starts with the default NPC');

        // ---- Create account (email confirmation on) -----------------------------------
        openAccount();
        click(panel(), 'Create account');
        fill(panel(), 'you@school.org', ADA);
        fill(panel(), /^New password/, ADA_PASSWORD);
        fill(panel(), 'Repeat password', 'something else');
        click(step(), 'Create account');
        await until(() => /do not match/.test(status()), 'mismatched passwords refused before any request');
        check(log.signups.length === 0, 'nothing sent for an invalid form');
        fill(panel(), 'Repeat password', ADA_PASSWORD);
        click(step(), 'Create account');
        await until(() => /Confirm your email/.test(step()?.textContent ?? ''), 'confirmation step');
        check(log.signups.includes(ADA) && npcStore.activeAccount() === null, `account created, not signed in until confirmed: ${JSON.stringify({ signups: log.signups, active: npcStore.activeAccount(), status: status() })}`);
        fill(panel(), '123456', '000000');
        click(panel(), 'Confirm');
        await until(() => /wrong or has expired/.test(status()), 'wrong confirmation code explained');

        // ---- First sync: loading state blocks editing ----------------------------------
        localStorage.setItem('stub.slowNpcs', '800');
        fill(panel(), '123456', VALID_CODE);
        click(panel(), 'Confirm');
        await until(() => npcStore.activeAccount() !== null, 'signed in after confirming');
        await until(() => visible(document.querySelector('.manager__sync')), 'loading state shown');
        check(/Loading your NPCs/.test(document.querySelector('.manager__sync')!.textContent ?? ''), 'loading message');
        check(!npcStore.editable() && [...bar().querySelectorAll('button')].find((b) => b.textContent === '+ Add NPC')?.disabled, 'NPC editing blocked until the first sync finishes');
        check(!npcStore.create({ name: 'Too early', subject: 'Math', appearance: 'scientist', dialogue: [], minigameType: null }, SPOT).ok, 'store refuses changes while loading');
        await until(() => npcStore.syncStatus().state === 'ready', 'account village loaded');
        localStorage.removeItem('stub.slowNpcs');
        check(!visible(document.querySelector('.manager__sync')), 'loading state cleared');
        const ada = npcStore.activeAccount()!;
        // The seed is written to Supabase right after the village shows (slowNpcs delays that write).
        await until(() => serverRows().find((r) => r.owner_id === ada && r.game_npc_id === 'sir-sum-a-lot')?.game_state?.building, 'brand-new account: default NPC saved to Supabase with its building');
        const sir = serverRows().find((r) => r.owner_id === ada && r.game_npc_id === 'sir-sum-a-lot');

        // ---- Create + save, then a refused save is undone --------------------------------
        const created = npcStore.create({ name: 'Ada Teacher', subject: 'Biology', appearance: 'scientist', dialogue: [], minigameType: null }, SPOT);
        check(created.ok, 'create');
        await saveNpc(created.ok ? created.value.id : '');
        const teacherId = created.ok ? created.value.id : '';
        const saved = serverRows().find((r) => r.owner_id === ada && r.game_npc_id === teacherId);
        check(saved && saved.game_state.x === SPOT.npcX && saved.game_state.building.x === SPOT.x, 'stable game id + placement stored in Supabase');
        const keeper = npcStore.create({ name: 'Ada Keeper', subject: 'Biology', appearance: 'knight', dialogue: [], minigameType: null }, { ...SPOT, x: 600, npcX: 632 });
        await saveNpc(keeper.ok ? keeper.value.id : '');

        // Edit through the NPC manager (server-confirmed; undo when Supabase refuses).
        openList();
        const row = () => [...document.querySelectorAll<HTMLElement>('.npc-row')].find((r) => r.textContent?.includes('Ada Teacher'));
        await until(() => row(), 'NPC list shows the account\'s NPCs');
        localStorage.setItem('stub.failNpcWrite', '1');
        await until(() => !row()?.querySelector('button')?.disabled, 'row buttons enabled');
        click(row()!, 'Edit');
        const form = document.querySelector<HTMLElement>('.npc-form')!;
        form.querySelector<HTMLInputElement>('input')!.value = 'Renamed Unsaved';
        click(form, 'Save changes');
        await until(() => /Not saved to your account.*undone/.test(document.body.textContent ?? ''), 'refused save explained');
        check(npcStore.get(teacherId)?.name === 'Ada Teacher', 'refused edit undone (village never shows unsaved data)');
        localStorage.removeItem('stub.failNpcWrite');
        openList();
        await until(() => row(), 'list again');
        click(row()!, 'Edit');
        form.querySelector<HTMLInputElement>('input')!.value = 'Ada Renamed';
        click(form, 'Save changes');
        await until(() => serverRows().find((r) => r.game_npc_id === teacherId)?.name === 'Ada Renamed', 'edit saved to Supabase by stable id');
        check(serverRows().filter((r) => r.game_npc_id === teacherId).length === 1, 'edits update, never duplicate');

        // ---- Logout: back to the device village ---------------------------------------------
        await signOut(until);
        check(!names().includes('Ada Renamed') && names().includes('Sir Sum-a-Lot'), 'signed out shows the device village, not the account\'s');

        // ---- Switch to another account --------------------------------------------------------
        stubAccount(BEA_ID, 'bea@school.org', 'bea password 1');
        localStorage.setItem('stub.npcs', JSON.stringify([...serverRows(), { id: 'bbbbbbbb-0000-4000-8000-0000000000be', owner_id: BEA_ID, game_npc_id: 'npc_bea', name: 'Bea Teacher', subject: 'History', appearance: 'scientist', class_id: 'class-1',
            game_state: { v: 1, map: 'hub', x: 1000, y: 600, dialogue: [], reactions: {}, minigameType: null, completed: false, building: { id: 'bld_bea', type: 'lab', map: 'hub', x: 968, y: 540 } } }]));
        openAccount();
        click(panel(), 'Sign in');
        fill(panel(), 'you@school.org', 'bea@school.org');
        fill(panel(), 'Password', 'wrong password');
        click(step(), 'Sign in');
        await until(() => /Wrong email or password/.test(status()), 'wrong password explained');
        const writes = log.npcBodies.length;
        await signInWithPassword(until, 'bea@school.org', 'bea password 1');
        check(JSON.stringify(names()) === JSON.stringify(['Bea Teacher']), `only Bea's village: ${names()}`);
        check(npcStore.get('npc_bea')?.x === 1000 && npcStore.buildingOf('npc_bea')?.x === 968, 'Bea\'s NPC and building at their saved spot');
        check(log.npcBodies.length === writes, 'signing in writes nothing');

        // ---- Back to Ada; delete one NPC --------------------------------------------------------
        await signOut(until);
        await signInWithPassword(until, ADA, ADA_PASSWORD);
        check(JSON.stringify(names()) === JSON.stringify(['Ada Keeper', 'Ada Renamed', 'Sir Sum-a-Lot']), `Ada's village is back: ${names()}`);
        openList();
        const renamed = () => [...document.querySelectorAll<HTMLElement>('.npc-row')].find((r) => r.textContent?.includes('Ada Renamed'));
        await until(() => renamed(), 'list');
        click(renamed()!, 'Delete');
        await until(() => !npcStore.get(teacherId), 'deleted (server confirmed)');
        check(!serverRows().some((r) => r.game_npc_id === teacherId), 'row gone from Supabase');
        // A stale copy comes back in this browser's storage (old tab, restored backup...).
        const cacheKey = `eduroam.npcs.account.${ada}`;
        const cache = JSON.parse(localStorage.getItem(cacheKey)!);
        cache.npcs.push({ ...cache.npcs[0], id: teacherId, name: 'Stale Ghost' });
        localStorage.setItem(cacheKey, JSON.stringify(cache));
        localStorage.setItem(`eduroam.npc-deletions.${ada}`, '[]');
        localStorage.setItem('test.deletedId', teacherId);
        return;
    }

    if (phase === 'accounts-reload')
    {
        await until(() => npcStore.activeAccount() && npcStore.syncStatus().state === 'ready', 'session restored and village loaded after refresh');
        const deleted = localStorage.getItem('test.deletedId')!;
        check(JSON.stringify(names()) === JSON.stringify(['Ada Keeper', 'Sir Sum-a-Lot']), `village from Supabase: ${names()}`);
        check(!npcStore.get(deleted), 'deleted NPC in stale localStorage is not shown');
        check(!log.npcBodies.some((b) => b.game_npc_id === deleted) && !serverRows().some((r) => r.game_npc_id === deleted), 'and is never recreated in Supabase');
        check(log.npcBodies.length === 0, 'a refresh writes nothing');
        return;
    }

    if (phase === 'accounts-guest')
    {
        await until(() => npcStore.syncStatus().state === 'ready', 'Ada restored');
        await signOut(until);
        // Guests are no longer offered in the UI; an existing guest session still upgrades safely.
        await signInAsGuest();
        await until(() => npcStore.activeAccount() && npcStore.syncStatus().state === 'ready', 'guest village loaded');
        const guest = npcStore.activeAccount()!;
        check(names().join() === 'Sir Sum-a-Lot', `new guest gets the default NPC only (device NPCs went to Ada once): ${names()}`);
        const made = npcStore.create({ name: 'Guest Teacher', subject: 'Art', appearance: 'scientist', dialogue: [], minigameType: null }, SPOT);
        await saveNpc(made.ok ? made.value.id : '');
        openAccount();
        await until(() => /playing as a guest/.test(panel().textContent ?? ''), 'guest panel');
        fill(panel(), 'you@school.org', ADA);
        click(panel(), 'Save my progress');
        await until(() => /already has an account/.test(status()), 'an email that already has an account is refused');
        fill(panel(), 'you@school.org', 'gus@school.org');
        click(panel(), 'Save my progress');
        await until(() => /Check gus@school.org/.test(panel().textContent ?? ''), 'confirmation requested');
        fill(panel(), 'Code from the email', VALID_CODE);
        click(panel(), 'Confirm');
        await until(() => /Choose a password/.test(panel().textContent ?? ''), 'upgraded: asked for a password');
        check(npcStore.activeAccount() === guest, 'SAME account id after the upgrade');
        check(names().includes('Guest Teacher') && npcStore.editable(), 'guest NPCs kept, no reload needed');
        fill(panel(), /^Choose a password/, 'gus password 1');
        fill(panel(), 'Repeat password', 'gus password 1');
        click(panel(), 'Save password');
        await until(() => /Password saved/.test(status()), 'password set');
        await signOut(until);
        await signInWithPassword(until, 'gus@school.org', 'gus password 1');
        check(npcStore.activeAccount() === guest && names().includes('Guest Teacher'), 'the upgraded account signs in with its password and keeps the guest village');
        await signOut(until);
        await signInWithPassword(until, ADA, ADA_PASSWORD);
        return;
    }

    if (phase === 'accounts-other-browser')
    {
        check(npcStore.activeAccount() === null && names().join() === 'Sir Sum-a-Lot', 'a new browser starts signed out with only the default device village');
        const expected = serverRows().find((r) => r.game_npc_id !== 'sir-sum-a-lot' && r.name === 'Ada Keeper');
        await signInWithPassword(until, ADA, ADA_PASSWORD);
        check(JSON.stringify(names()) === JSON.stringify(['Ada Keeper', 'Sir Sum-a-Lot']), `same village on another browser: ${names()}`);
        const keeper = npcStore.all().find((n) => n.name === 'Ada Keeper')!;
        check(keeper.id === expected.game_npc_id && keeper.x === expected.game_state.x && npcStore.buildingOf(keeper.id)?.x === expected.game_state.building.x, 'same stable id, position and building');
        check(log.npcBodies.length === 0, 'nothing imported or re-seeded from the new browser\'s default save');
    }
}
