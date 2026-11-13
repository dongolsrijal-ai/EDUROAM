// Regression tests: dungeon chest rewards are durable and idempotent across interrupted saves,
// refreshes, death retries and legacy saves.
//
// Run: npm test   (node --test; Node strips the types, Vite's SSR module runner loads the game
// modules). Every boot() is a fresh page load: new module instances reading the same storage.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

type DungeonModule = typeof import('../src/game/state/dungeonRun.ts');
type PlayerModule = typeof import('../src/game/state/playerState.ts');
type ItemId = Parameters<PlayerModule['player']['count']>[0];

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLAYER_KEY = 'eduroam.player';
const DUNGEON_KEY = 'eduroam.dungeon';
const FLOOR = 'floor-1';
const SIDE = 'floor-1:side:3,4';
const FINAL = 'floor-1:vault:9,9';

/** localStorage stand-in that can fail writes and report each successful write. */
class MemoryStorage
{
    data = new Map<string, string>();
    failKeys = new Set<string>();
    onSet: ((key: string) => void) | null = null;

    get length () { return this.data.size; }
    key (i: number) { return [...this.data.keys()][i] ?? null; }
    getItem (key: string) { return this.data.get(key) ?? null; }
    setItem (key: string, value: string)
    {
        if (this.failKeys.has(key)) throw new Error(`QuotaExceededError (simulated) for ${key}`);
        this.data.set(key, String(value));
        this.onSet?.(key);
    }
    removeItem (key: string) { this.data.delete(key); }
    clear () { this.data.clear(); }

    clone ()
    {
        const copy = new MemoryStorage();
        for (const [k, v] of this.data) copy.data.set(k, v);
        return copy;
    }
}

let server: ViteDevServer;
const runners: ReturnType<typeof createServerModuleRunner>[] = [];

before(async () =>
{
    server = await createServer({
        configFile: false, root: ROOT, logLevel: 'error', appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
    });
});

after(async () =>
{
    await Promise.all(runners.map((r) => r.close()));
    await server.close();
});

/** A page load: fresh dungeonRun / playerState module instances on top of `storage`. */
async function boot (storage: MemoryStorage)
{
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
    const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    runners.push(runner);
    const run: DungeonModule = await runner.import('/src/game/state/dungeonRun.ts');
    const state: PlayerModule = await runner.import('/src/game/state/playerState.ts');
    return {
        dungeonRun: run.dungeonRun, player: state.player,
        isChallengeClaimed: state.isChallengeClaimed, onPlayerStateChange: state.onPlayerStateChange,
    };
}

/** A loot roll that counts how often it was used. */
function roller (itemId: ItemId, qty: number)
{
    const r = { calls: 0, roll: () => { r.calls++; return { itemId, qty }; } };
    return r;
}
const noReroll = () => { throw new Error('the chest reward was rolled again'); };

const saved = (s: MemoryStorage, key: string) => JSON.parse(s.getItem(key) ?? 'null');
const savedChest = (s: MemoryStorage, chestId: string) => saved(s, DUNGEON_KEY)?.chests?.[chestId];
const savedReceipts = (s: MemoryStorage): Record<string, { itemId: string; total: number; delivered: number }> =>
    saved(s, PLAYER_KEY)?.chestReceipts ?? {};
const savedReceipt = (s: MemoryStorage, runId: string, chestId: string) => savedReceipts(s)[`${runId}/${chestId}`];

const EMPTY_EQUIPMENT = { armor: null, melee: null, ranged: null, healing: null };
const emptyBackpack = () => Array.from({ length: 54 }, () => null as { itemId: string; qty: number } | null);

/** Calls `fn` with a copy of the storage taken right after the next successful write of `key`. */
function snapshotAfterWrite (s: MemoryStorage, key: string, fn: () => void): MemoryStorage
{
    let snapshot = null as MemoryStorage | null;
    s.onSet = (k) => { if (k === key && !snapshot) snapshot = s.clone(); };
    fn();
    s.onSet = null;
    assert.ok(snapshot, `${key} was never written`);
    return snapshot;
}

test('normal delivery is saved with a receipt; repeated E and refresh never redeliver', async () =>
{
    const s = new MemoryStorage();
    let { dungeonRun, player } = await boot(s);
    dungeonRun.start(FLOOR);
    const runId = dungeonRun.state.runId;
    const loot = roller('magic_crystal', 3);

    const first = dungeonRun.openChest(SIDE, false, loot.roll);
    assert.equal(first.status, 'opened');
    assert.equal(first.status === 'opened' && first.grantedQty, 3);
    assert.equal(player.count('magic_crystal'), 3);
    assert.deepEqual(savedReceipt(s, runId, SIDE), { itemId: 'magic_crystal', total: 3, delivered: 3 });
    assert.deepEqual(savedChest(s, SIDE), { itemId: 'magic_crystal', total: 3, qty: 0, granted: true });

    for (let i = 0; i < 3; i++)
    {
        const again = dungeonRun.openChest(SIDE, false, noReroll);
        assert.equal(again.status === 'opened' && again.grantedQty, 0);
    }
    assert.equal(player.count('magic_crystal'), 3);

    ({ dungeonRun, player } = await boot(s));
    dungeonRun.start(FLOOR);
    assert.equal(dungeonRun.state.runId, runId, 'refresh keeps the run identity');
    const afterReload = dungeonRun.openChest(SIDE, false, noReroll);
    assert.equal(afterReload.status === 'opened' && afterReload.grantedQty, 0);
    assert.equal(player.count('magic_crystal'), 3);
    assert.equal(loot.calls, 1);
});

test('interruption after the player save but before the dungeon save neither duplicates nor loses the reward', async () =>
{
    const s = new MemoryStorage();
    let { dungeonRun, player } = await boot(s);
    dungeonRun.start(FLOOR);
    dungeonRun.defeatGuardian();
    const runId = dungeonRun.state.runId;

    const crashed = snapshotAfterWrite(s, PLAYER_KEY, () => dungeonRun.openChest(FINAL, true, roller('large_health_potion', 2).roll));
    // What the crashed page left behind: items + receipt saved, chest still pending.
    assert.deepEqual(savedChest(crashed, FINAL), { itemId: 'large_health_potion', total: 2, qty: 2, granted: false });
    assert.equal(saved(crashed, DUNGEON_KEY).finalChestOpened, false);
    assert.deepEqual(savedReceipt(crashed, runId, FINAL), { itemId: 'large_health_potion', total: 2, delivered: 2 });

    ({ dungeonRun, player } = await boot(crashed));
    dungeonRun.start(FLOOR);
    assert.equal(player.count('large_health_potion'), 2, 'reward not lost');
    assert.equal(dungeonRun.state.exitUnlocked, false);

    // The player drinks both potions before pressing E again: delivery must not be inferred from counts.
    const index = player.inventory.backpack.findIndex((slot) => slot?.itemId === 'large_health_potion');
    assert.equal(player.move({ area: 'backpack', index }, { area: 'equipment', slot: 'healing' }), 'swapped');
    assert.ok(player.consumeEquipped('healing') && player.consumeEquipped('healing'));
    assert.equal(player.count('large_health_potion'), 0);

    const retry = dungeonRun.openChest(FINAL, true, noReroll);
    assert.equal(retry.status === 'opened' && retry.grantedQty, 0, 'not duplicated');
    assert.equal(player.count('large_health_potion'), 0);
    assert.deepEqual(savedChest(crashed, FINAL), { itemId: 'large_health_potion', total: 2, qty: 0, granted: true }, 'chest record repaired');
    assert.equal(dungeonRun.state.finalChestOpened, true);
    assert.equal(dungeonRun.state.exitUnlocked, true, 'completion still works after repair');
});

test('partial delivery survives the same interruption; only the remainder is collectible', async () =>
{
    const s = new MemoryStorage();
    const backpack = emptyBackpack().map(() => ({ itemId: 'iron_sword', qty: 1 }));
    backpack[53] = { itemId: 'magic_crystal', qty: 97 }; // room for 2 more crystals only
    s.data.set(PLAYER_KEY, JSON.stringify({
        version: 3, inventory: { backpack, equipment: EMPTY_EQUIPMENT }, claimedChallenges: [], starterKitGranted: true,
    }));
    let { dungeonRun, player } = await boot(s);
    dungeonRun.start(FLOOR);
    const runId = dungeonRun.state.runId;

    const crashed = snapshotAfterWrite(s, PLAYER_KEY, () => dungeonRun.openChest(SIDE, false, roller('magic_crystal', 4).roll));
    assert.deepEqual(savedReceipt(crashed, runId, SIDE), { itemId: 'magic_crystal', total: 4, delivered: 2 });
    assert.deepEqual(savedChest(crashed, SIDE), { itemId: 'magic_crystal', total: 4, qty: 4, granted: false });

    ({ dungeonRun, player } = await boot(crashed));
    dungeonRun.start(FLOOR);
    assert.equal(player.count('magic_crystal'), 99);

    // Bag still full: nothing new, but the chest now shows the true remainder.
    const full = dungeonRun.openChest(SIDE, false, noReroll);
    assert.equal(full.status === 'opened' && full.grantedQty, 0);
    assert.deepEqual(savedChest(crashed, SIDE), { itemId: 'magic_crystal', total: 4, qty: 2, granted: false });
    assert.equal(player.count('magic_crystal'), 99);

    // Make room (equip a sword), then collect: exactly the 2 still owed.
    assert.equal(player.move({ area: 'backpack', index: 0 }, { area: 'equipment', slot: 'melee' }), 'moved');
    const rest = dungeonRun.openChest(SIDE, false, noReroll);
    assert.equal(rest.status === 'opened' && rest.grantedQty, 2);
    assert.equal(player.count('magic_crystal'), 101);
    assert.deepEqual(savedReceipt(crashed, runId, SIDE), { itemId: 'magic_crystal', total: 4, delivered: 4 });
    assert.deepEqual(savedChest(crashed, SIDE), { itemId: 'magic_crystal', total: 4, qty: 0, granted: true });

    const done = dungeonRun.openChest(SIDE, false, noReroll);
    assert.equal(done.status === 'opened' && done.grantedQty, 0);
    assert.equal(player.count('magic_crystal'), 101);
});

test('a failed initial roll save awards nothing and does not unlock the exit', async (t) =>
{
    t.mock.method(console, 'error', () => {});
    const s = new MemoryStorage();
    const { dungeonRun, player } = await boot(s);
    dungeonRun.start(FLOOR);
    dungeonRun.defeatGuardian();
    const playerBefore = s.getItem(PLAYER_KEY);
    const dungeonBefore = s.getItem(DUNGEON_KEY);

    s.failKeys.add(DUNGEON_KEY);
    const result = dungeonRun.openChest(FINAL, true, roller('hunter_bow', 1).roll);
    assert.deepEqual(result, { status: 'saveFailed' });
    assert.equal(dungeonRun.state.chests[FINAL], undefined, 'unsaved roll is forgotten');
    assert.equal(player.count('hunter_bow'), 0);
    assert.equal(dungeonRun.state.exitUnlocked, false);
    assert.equal(s.getItem(PLAYER_KEY), playerBefore);
    assert.equal(s.getItem(DUNGEON_KEY), dungeonBefore);

    s.failKeys.clear();
    const retry = dungeonRun.openChest(FINAL, true, roller('hunter_bow', 1).roll);
    assert.equal(retry.status === 'opened' && retry.grantedQty, 1);
    assert.equal(player.count('hunter_bow'), 1);
    assert.equal(dungeonRun.state.exitUnlocked, true);
});

test('a failed player save leaves inventory and receipts unchanged; retry delivers the saved roll', async (t) =>
{
    t.mock.method(console, 'error', () => {});
    const s = new MemoryStorage();
    const page = await boot(s);
    let { dungeonRun, player } = page;
    dungeonRun.start(FLOOR);
    dungeonRun.defeatGuardian();
    const runId = dungeonRun.state.runId;
    const playerBefore = s.getItem(PLAYER_KEY);
    let notified = 0;
    page.onPlayerStateChange(() => notified++);

    s.failKeys.add(PLAYER_KEY);
    const loot = roller('magic_crystal', 3);
    const result = dungeonRun.openChest(FINAL, true, loot.roll);
    assert.deepEqual(result, { status: 'saveFailed' });
    assert.equal(player.count('magic_crystal'), 0, 'no unsaved award in live inventory');
    assert.equal(notified, 0, 'no inventory change published');
    assert.equal(s.getItem(PLAYER_KEY), playerBefore);
    assert.equal(dungeonRun.state.finalChestOpened, false);
    assert.equal(dungeonRun.state.exitUnlocked, false);
    assert.deepEqual(savedChest(s, FINAL), { itemId: 'magic_crystal', total: 3, qty: 3, granted: false }, 'roll is durable');

    // Still failing: still nothing.
    assert.deepEqual(dungeonRun.openChest(FINAL, true, noReroll), { status: 'saveFailed' });
    assert.equal(player.count('magic_crystal'), 0);

    // Storage recovers (after a refresh, too): the same roll is delivered once.
    s.failKeys.clear();
    ({ dungeonRun, player } = await boot(s));
    dungeonRun.start(FLOOR);
    const retry = dungeonRun.openChest(FINAL, true, noReroll);
    assert.equal(retry.status === 'opened' && retry.grantedQty, 3);
    assert.equal(player.count('magic_crystal'), 3);
    assert.deepEqual(savedReceipt(s, runId, FINAL), { itemId: 'magic_crystal', total: 3, delivered: 3 });
    assert.equal(loot.calls, 1);
});

test('a dungeon save that fails after the player save is repaired from the receipt', async (t) =>
{
    t.mock.method(console, 'error', () => {});
    const s = new MemoryStorage();
    let { dungeonRun, player } = await boot(s);
    dungeonRun.start(FLOOR);

    s.onSet = (key) => { if (key === PLAYER_KEY) s.failKeys.add(DUNGEON_KEY); };
    const result = dungeonRun.openChest(SIDE, false, roller('reinforced_armor', 1).roll);
    s.onSet = null;
    s.failKeys.clear();
    assert.equal(result.status === 'opened' && result.grantedQty, 1, 'items were durably saved');
    assert.equal(savedChest(s, SIDE).granted, false, 'dungeon save is stale');

    ({ dungeonRun, player } = await boot(s));
    dungeonRun.start(FLOOR);
    assert.equal(player.count('reinforced_armor'), 1);
    const retry = dungeonRun.openChest(SIDE, false, noReroll);
    assert.equal(retry.status === 'opened' && retry.grantedQty, 0);
    assert.equal(player.count('reinforced_armor'), 1);
    assert.equal(savedChest(s, SIDE).granted, true);
});

test('claimed chests stay claimed after death retry (also after refreshing while dead)', async () =>
{
    const s = new MemoryStorage();
    let { dungeonRun, player } = await boot(s);
    dungeonRun.start(FLOOR);
    const runId = dungeonRun.state.runId;
    dungeonRun.defeatGuardian();
    dungeonRun.openChest(FINAL, true, roller('hunter_bow', 1).roll);
    assert.equal(dungeonRun.state.exitUnlocked, true);

    dungeonRun.damage(1000);
    ({ dungeonRun, player } = await boot(s));
    dungeonRun.start(FLOOR); // dead + refreshed -> retry
    assert.equal(dungeonRun.state.runId, runId);
    assert.equal(dungeonRun.state.stats.deaths, 1);
    assert.equal(dungeonRun.state.guardianDefeated, false);
    assert.equal(dungeonRun.state.exitUnlocked, false);

    dungeonRun.retryAfterDeath();
    assert.equal(dungeonRun.state.runId, runId);
    assert.equal(dungeonRun.state.chests[FINAL].granted, true);

    dungeonRun.defeatGuardian();
    const again = dungeonRun.openChest(FINAL, true, noReroll);
    assert.equal(again.status === 'opened' && again.grantedQty, 0);
    assert.equal(player.count('hunter_bow'), 1);
    assert.equal(dungeonRun.state.exitUnlocked, true);
});

test('a genuinely new run gets a new identity and its own chest rewards', async () =>
{
    const s = new MemoryStorage();
    let { dungeonRun, player } = await boot(s);
    dungeonRun.start(FLOOR);
    const firstRun = dungeonRun.state.runId;
    dungeonRun.openChest(SIDE, false, roller('magic_crystal', 2).roll);
    dungeonRun.defeatGuardian();
    dungeonRun.openChest(FINAL, true, roller('iron_sword', 1).roll);
    assert.ok(dungeonRun.complete());

    ({ dungeonRun, player } = await boot(s));
    dungeonRun.start(FLOOR);
    const secondRun = dungeonRun.state.runId;
    assert.notEqual(secondRun, firstRun);
    assert.deepEqual(dungeonRun.state.chests, {});

    const loot = roller('magic_crystal', 3);
    const result = dungeonRun.openChest(SIDE, false, loot.roll);
    assert.equal(result.status === 'opened' && result.grantedQty, 3);
    assert.equal(loot.calls, 1);
    assert.equal(player.count('magic_crystal'), 5);
    assert.equal(player.count('iron_sword'), 1);
    assert.deepEqual(Object.keys(savedReceipts(s)), [`${secondRun}/${SIDE}`], 'finished run receipts are pruned');
});

test('legacy saves load without reset; legacy granted chests stay paid, pending ones are kept', async () =>
{
    const s = new MemoryStorage();
    const backpack = emptyBackpack();
    backpack[0] = { itemId: 'magic_crystal', qty: 5 };
    backpack[1] = { itemId: 'iron_sword', qty: 1 };
    const equipment = {
        armor: { itemId: 'cloth_armor', qty: 1 }, melee: { itemId: 'wooden_sword', qty: 1 },
        ranged: null, healing: { itemId: 'small_health_potion', qty: 2 },
    };
    s.data.set(PLAYER_KEY, JSON.stringify({
        version: 3, inventory: { backpack, equipment }, claimedChallenges: ['intro-math'], starterKitGranted: true,
    }));
    const PAID = 'floor-1:a:1,1';
    const PENDING = 'floor-1:b:2,2';
    s.data.set(DUNGEON_KEY, JSON.stringify({
        version: 1, floorId: FLOOR, active: true, completed: false, guardianDefeated: true, finalChestOpened: false,
        exitUnlocked: false, hp: 60, stats: { runs: 2, deaths: 1, completions: 1 },
        chests: {
            [PAID]: { itemId: 'iron_sword', qty: 0, granted: true },
            [PENDING]: { itemId: 'magic_crystal', qty: 3, granted: false },
        },
    }));

    let { dungeonRun, player, isChallengeClaimed } = await boot(s);
    assert.equal(player.count('magic_crystal'), 5);
    assert.equal(player.count('iron_sword'), 1);
    assert.equal(player.count('cloth_armor'), 1, 'starter kit not granted again');
    assert.equal(player.count('training_bow'), 0, 'starter kit not granted again');
    assert.deepEqual(player.inventory.equipment.healing, { itemId: 'small_health_potion', qty: 2 });
    assert.ok(isChallengeClaimed('intro-math'));
    assert.deepEqual(saved(s, PLAYER_KEY).chestReceipts, {});

    assert.equal(dungeonRun.state.guardianDefeated, true);
    assert.equal(dungeonRun.state.hp, 60);
    assert.deepEqual(dungeonRun.state.stats, { runs: 2, deaths: 1, completions: 1 });
    assert.deepEqual(dungeonRun.state.chests[PAID], { itemId: 'iron_sword', total: 0, qty: 0, granted: true });
    assert.deepEqual(dungeonRun.state.chests[PENDING], { itemId: 'magic_crystal', total: 3, qty: 3, granted: false });

    dungeonRun.start(FLOOR); // resumes the legacy run
    const runId = dungeonRun.state.runId;
    assert.ok(runId && !runId.includes('/'));
    assert.equal(saved(s, DUNGEON_KEY).runId, runId);

    const paid = dungeonRun.openChest(PAID, false, noReroll);
    assert.equal(paid.status === 'opened' && paid.grantedQty, 0);
    assert.equal(player.count('iron_sword'), 1);

    const pending = dungeonRun.openChest(PENDING, false, noReroll);
    assert.equal(pending.status === 'opened' && pending.grantedQty, 3);
    assert.equal(player.count('magic_crystal'), 8);
    assert.deepEqual(savedReceipt(s, runId, PENDING), { itemId: 'magic_crystal', total: 3, delivered: 3 });

    ({ dungeonRun, player } = await boot(s));
    dungeonRun.start(FLOOR);
    assert.equal(dungeonRun.state.runId, runId);
    const again = dungeonRun.openChest(PENDING, false, noReroll);
    assert.equal(again.status === 'opened' && again.grantedQty, 0);
    assert.equal(player.count('magic_crystal'), 8);
    assert.equal(player.count('cloth_armor'), 1);
});

test('existing v1 / v2 player migrations still work and never duplicate the starter kit', async () =>
{
    const v2 = new MemoryStorage();
    v2.data.set(PLAYER_KEY, JSON.stringify({
        version: 2, inventory: { backpack: [], equipment: EMPTY_EQUIPMENT, hotbar: [{ itemId: 'number_crystal', qty: 4 }] },
        claimedChallenges: ['old-quiz'], starterKitGranted: true,
    }));
    let { player, isChallengeClaimed } = await boot(v2);
    assert.equal(player.count('number_crystal'), 4);
    assert.equal(player.count('cloth_armor'), 0, 'kit was already granted in this save');
    assert.ok(isChallengeClaimed('old-quiz'));
    assert.ok(v2.getItem(`${PLAYER_KEY}.v2-backup`));
    assert.equal(saved(v2, PLAYER_KEY).version, 3);
    ({ player } = await boot(v2));
    assert.equal(player.count('number_crystal'), 4);

    const v1 = new MemoryStorage();
    v1.data.set(PLAYER_KEY, JSON.stringify({ version: 1, inventory: { numberCrystals: 7 }, claimedChallenges: ['intro'] }));
    ({ player, isChallengeClaimed } = await boot(v1));
    assert.equal(player.count('number_crystal'), 7);
    assert.equal(player.count('cloth_armor'), 1);
    assert.ok(isChallengeClaimed('intro'));
    assert.ok(v1.getItem(`${PLAYER_KEY}.v1-backup`));
    ({ player } = await boot(v1));
    assert.equal(player.count('cloth_armor'), 1, 'starter kit granted exactly once');
    assert.equal(player.count('number_crystal'), 7);
});
