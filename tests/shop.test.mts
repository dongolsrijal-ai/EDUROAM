// Crystal shop (decoration-only): catalog size + prices, village unlock / apply / remove,
// persistence across reloads, failed saves charging nothing, and the one-time crystal refund of
// the removed weapon section.
//
// Run: npm test. Every boot() is a fresh page load on the same storage (as in chestRewards).

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';
import { emptyProgress, legacyWeaponRefund, sanitizeProgress, VILLAGE_ITEM_IDS, VILLAGE_ITEMS } from '../src/game/shop/catalog.ts';

type PlayerModule = typeof import('../src/game/state/playerState.ts');
type LookModule = typeof import('../src/game/world/villageLook.ts');

// Canonical path: a drive-letter case mismatch would load one module twice (two player states).
const ROOT = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
const PLAYER_KEY = 'eduroam.player';

class MemoryStorage
{
    data = new Map<string, string>();
    fail = false;
    get length () { return this.data.size; }
    key (i: number) { return [...this.data.keys()][i] ?? null; }
    getItem (key: string) { return this.data.get(key) ?? null; }
    setItem (key: string, value: string)
    {
        if (this.fail) throw new Error('QuotaExceededError (simulated)');
        this.data.set(key, String(value));
    }
    removeItem (key: string) { this.data.delete(key); }
    clear () { this.data.clear(); }
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
after(async () => { await Promise.all(runners.map((r) => r.close())); await server.close(); });
afterEach(async () => { await Promise.all(runners.splice(0).map((r) => r.close())); });

/** A page load: a fresh playerState on top of `storage`, optionally with crystals granted. */
async function boot (storage: MemoryStorage, crystals = 0)
{
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
    const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    runners.push(runner);
    const state: PlayerModule = await runner.import('/src/game/state/playerState.ts');
    const look: LookModule = await runner.import('/src/game/world/villageLook.ts');
    if (crystals) assert.equal(state.player.addItem('number_crystal', crystals), 0);
    return { player: state.player, onChange: state.onPlayerStateChange, villageLook: look.villageLook };
}
const savedShop = (s: MemoryStorage) => JSON.parse(s.getItem(PLAYER_KEY) ?? 'null')?.shop;

test('catalog: decoration-only, 18 village items at fair prices', () =>
{
    assert.equal(VILLAGE_ITEM_IDS.length, 18);
    for (const id of VILLAGE_ITEM_IDS) assert.ok(VILLAGE_ITEMS[id].price >= 8 && VILLAGE_ITEMS[id].price <= 150, `${id} price`);
    assert.ok(!VILLAGE_ITEM_IDS.some((id) => /sword|bow|staff|weapon/i.test(id)), 'no combat power for crystals');
});

test('saved progress is sanitized: unknown ids dropped, selections must be owned, weapon fields gone', () =>
{
    const p = sanitizeProgress({
        weaponUnlocks: ['staff'], weaponUpgradeLevels: { sword: 2 },
        villageUnlocks: ['bench', 'castle', 'lamp_post'],
        villageSelections: { bench: 'bench', lamps: 'street_light', fountain: 'fountain', path: 'bench' },
    });
    assert.deepEqual(Object.keys(p).sort(), ['villageSelections', 'villageUnlocks']);
    assert.deepEqual(p.villageUnlocks, ['bench', 'lamp_post']);
    assert.deepEqual(p.villageSelections, { bench: 'bench' });
    assert.deepEqual(sanitizeProgress(null), emptyProgress());
    assert.deepEqual(sanitizeProgress('nonsense'), emptyProgress());
});

test('weapon shop purchases from the earlier build are refunded in crystals exactly once', async () =>
{
    assert.equal(legacyWeaponRefund({ weaponUnlocks: ['staff'], weaponUpgradeLevels: { sword: 2, staff: 1, quickHands: 1, hack: 9 } }), 35 + 20 + 45 + 25 + 40);
    assert.equal(legacyWeaponRefund({ weaponUpgradeLevels: { sword: 99 } }), 20 + 45 + 80, 'levels clamp to what existed');
    assert.equal(legacyWeaponRefund(null), 0);

    const storage = new MemoryStorage();
    await boot(storage, 7);
    const old = JSON.parse(storage.getItem(PLAYER_KEY)!);
    old.shop = { weaponUnlocks: ['staff'], weaponUpgradeLevels: { sword: 1 }, villageUnlocks: ['bench'], villageSelections: { bench: 'bench' } };
    storage.setItem(PLAYER_KEY, JSON.stringify(old));

    let { player } = await boot(storage);
    assert.equal(player.crystals, 7 + 35 + 20);
    assert.deepEqual(player.shop.villageUnlocks, ['bench'], 'decorations kept');
    assert.ok(!('weaponUnlocks' in savedShop(storage)), 'refund recorded by dropping the old fields');
    ({ player } = await boot(storage));
    assert.equal(player.crystals, 7 + 35 + 20, 'no second refund after reload');
});

test('village items: buy once, shown at once, apply / remove, one style per slot, persisted', async () =>
{
    const storage = new MemoryStorage();
    let game = await boot(storage, 400);
    const { player } = game;
    const look = () => game.villageLook(game.player.shop);

    assert.deepEqual(look(), { house: { tier: 0, roof: 'coral', door: 'wood', shutters: false }, tileset: 'ground', objects: [] });
    assert.equal(player.applyVillage('bench', 'bench'), 'locked', 'cannot show an item that is not owned');

    assert.equal(player.buyVillageItem('lamp_post'), 'ok');
    assert.equal(player.crystals, 380);
    assert.equal(player.buyVillageItem('lamp_post'), 'owned');
    assert.ok(look().objects.length === 4 && look().objects.every((o) => o.kind.startsWith('lampPost')));

    // Buying the other fence style replaces the first in the slot; both stay owned.
    assert.equal(player.buyVillageItem('street_light'), 'ok');
    assert.ok(look().objects.every((o) => o.kind.startsWith('streetLight')));
    assert.equal(player.applyVillage('lamps', 'lamp_post'), 'ok');
    assert.ok(look().objects.every((o) => o.kind.startsWith('lampPost')));
    assert.equal(player.applyVillage('lamps', null), 'ok');
    assert.deepEqual(look().objects, []);
    assert.equal(player.applyVillage('path', 'lamp_post'), 'locked', 'wrong slot');
    assert.equal(player.crystals, 345, 'applying and removing is free');

    for (const id of ['house_manor', 'roof_slate', 'door_blue', 'windows_shutters', 'path_cobble', 'bench', 'fountain'] as const) assert.equal(player.buyVillageItem(id), 'ok', id);
    assert.equal(player.crystals, 345 - 140 - 30 - 15 - 25 - 40 - 12 - 60);
    assert.equal(player.buyVillageItem('house_two_storey'), 'poor');

    game = await boot(storage);
    assert.equal(game.player.crystals, 23);
    assert.deepEqual(look().house, { tier: 2, roof: 'slate', door: 'blue', shutters: true });
    assert.equal(look().tileset, 'ground-cobble');
    assert.deepEqual(look().objects.map((o) => o.kind).sort(), ['bench', 'fountain']);
    assert.deepEqual([...game.player.shop.villageUnlocks].sort(), ['bench', 'door_blue', 'fountain', 'house_manor', 'lamp_post', 'path_cobble', 'roof_slate', 'street_light', 'windows_shutters']);
    assert.equal(savedShop(storage).villageSelections.lamps ?? null, null, 'a cleared slot stays cleared');
});

test('a failed save charges nothing and unlocks nothing', async () =>
{
    const storage = new MemoryStorage();
    const { player } = await boot(storage, 100);
    const before = storage.getItem(PLAYER_KEY);
    storage.fail = true;
    assert.equal(player.buyVillageItem('bench'), 'saveFailed');
    assert.equal(player.buyVillageItem('fountain'), 'saveFailed');
    assert.equal(player.crystals, 100);
    assert.deepEqual(player.shop.villageUnlocks, []);
    assert.equal(storage.getItem(PLAYER_KEY), before);
    storage.fail = false;
    assert.equal(player.buyVillageItem('fountain'), 'ok');
    assert.equal(player.crystals, 40);
});

test('saves from before the shop load with empty shop progress', async () =>
{
    const storage = new MemoryStorage();
    await boot(storage, 5);
    const old = JSON.parse(storage.getItem(PLAYER_KEY)!);
    delete old.shop;
    storage.setItem(PLAYER_KEY, JSON.stringify(old));
    const { player } = await boot(storage);
    assert.equal(player.crystals, 5);
    assert.deepEqual(player.shop, emptyProgress());
});
