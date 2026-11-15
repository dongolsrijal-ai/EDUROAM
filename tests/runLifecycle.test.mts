import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

class MemoryStorage
{
    data = new Map<string, string>();
    failKeys = new Set<string>();
    getItem (key: string) { return this.data.get(key) ?? null; }
    setItem (key: string, value: string)
    {
        if (this.failKeys.has(key)) throw new Error('Storage unavailable');
        this.data.set(key, String(value));
    }
}

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
before(async () =>
{
    server = await createServer({
        configFile: false,
        // Canonical path: on Windows a drive-letter case mismatch makes Vite load one module twice
        // (e.g. nextTower.ts importing a second copy of tower.ts state).
        root: realpathSync.native(fileURLToPath(new URL('..', import.meta.url))),
        logLevel: 'error', appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
    });
});
after(async () => { await runner?.close(); await server.close(); });

async function boot (storage = new MemoryStorage())
{
    await runner?.close();
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    const { dungeonRun } = await runner.import('/src/game/state/dungeonRun.ts') as typeof import('../src/game/state/dungeonRun.ts');
    const { tower } = await runner.import('/src/game/state/tower.ts') as typeof import('../src/game/state/tower.ts');
    const options = await runner.import('/src/game/world/dungeon/runOptions.ts') as typeof import('../src/game/world/dungeon/runOptions.ts');
    const { player } = await runner.import('/src/game/state/playerState.ts') as typeof import('../src/game/state/playerState.ts');
    return { dungeonRun, tower, player, ...options };
}

test('balance: 50 HP, healing halved exactly once, inventory quantities persist', async () =>
{
    const storage = new MemoryStorage();
    let { dungeonRun, player, beginTowerRun } = await boot(storage);
    beginTowerRun();
    assert.equal(dungeonRun.maxHp, 50);
    assert.equal(dungeonRun.state.hp, 50);
    assert.equal(player.stats().healPerUse, 10);
    assert.equal(player.count('small_health_potion'), 3);
    const { ITEM_DEFS } = await runner.import('/src/game/items/itemDefs.ts') as typeof import('../src/game/items/itemDefs.ts');
    assert.equal(ITEM_DEFS.large_health_potion.stats.heal, 25);
    dungeonRun.damage(30);
    assert.equal(dungeonRun.heal(player.stats().healPerUse), 10);
    ({ dungeonRun, player } = await boot(storage));
    assert.equal(dungeonRun.state.hp, 30);
    assert.equal(player.stats().healPerUse, 10);
    assert.equal(player.count('small_health_potion'), 3);
});

test('completion requires active final floor and can only complete once', async () =>
{
    const { dungeonRun } = await boot();
    dungeonRun.start('tower', { seed: 7, biomeId: 'crypt', floorCount: 2, towerLevel: 4 });
    dungeonRun.defeatGuardian();
    dungeonRun.openChest('final', true, () => ({ itemId: 'magic_crystal', qty: 1 }));
    assert.equal(dungeonRun.complete(), false, 'cannot finish a multi-floor run early');
    dungeonRun.advanceFloor();
    dungeonRun.defeatGuardian();
    dungeonRun.openChest('final2', true, () => ({ itemId: 'magic_crystal', qty: 1 }));
    assert.equal(dungeonRun.complete(), true);
    assert.equal(dungeonRun.complete(), false);
    assert.equal(dungeonRun.state.stats.completions, 1);
});

test('failed run start/completion and tower saves do not publish unsaved progression', async (t) =>
{
    t.mock.method(console, 'error', () => {});
    const storage = new MemoryStorage();
    const { dungeonRun, tower } = await boot(storage);
    storage.failKeys.add('eduroam.dungeon');
    assert.equal(dungeonRun.start('tower'), false);
    assert.equal(dungeonRun.state.active, false);
    storage.failKeys.clear();
    dungeonRun.start('tower');
    dungeonRun.defeatGuardian();
    dungeonRun.openChest('final', true, () => ({ itemId: 'magic_crystal', qty: 1 }));
    storage.failKeys.add('eduroam.dungeon');
    assert.equal(dungeonRun.complete(), false);
    assert.equal(dungeonRun.state.active, true);
    storage.failKeys.add('eduroam.tower');
    assert.equal(tower.recordCompletion(dungeonRun.state.runId), false);
    assert.equal(tower.state.towerLevel, 1);
    storage.failKeys.clear();
    assert.equal(dungeonRun.complete(), true);
    assert.equal(tower.recordCompletion(dungeonRun.state.runId), true);
    assert.equal(tower.state.towerLevel, 2);
});

test('resuming a legacy run keeps its identity, pending rewards, HP and inventory', async () =>
{
    const storage = new MemoryStorage();
    let { dungeonRun, player, tower } = await boot(storage);
    tower.setLevel(8);
    dungeonRun.start('floor-1');
    dungeonRun.damage(12);
    dungeonRun.openChest('floor-1:pillars:28,1', false, () => ({ itemId: 'magic_crystal', qty: 3 }));
    const id = dungeonRun.state.runId;
    const inventory = structuredClone(player.inventory);
    const run = JSON.parse(storage.getItem('eduroam.dungeon')!);
    run.chests['floor-1:treasure:37,13'] = { itemId: 'reinforced_armor', total: 1, qty: 1, granted: false };
    storage.setItem('eduroam.dungeon', JSON.stringify(run));
    const restored = await boot(storage);
    restored.beginTowerRun();
    assert.equal(restored.dungeonRun.state.runId, id);
    assert.equal(restored.dungeonRun.state.hp, 38);
    assert.equal(restored.dungeonRun.state.chests['floor-1:treasure:37,13'].qty, 1);
    assert.deepEqual(restored.player.inventory, inventory);
    assert.equal(restored.tower.state.towerLevel, 8);
    const { chestIdForMarker } = restored;
    const marker = { roomId: 'new-room', x: 10, y: 10 };
    assert.equal(chestIdForMarker(restored.dungeonRun.state, { ...marker, type: 'chest' }), 'floor-1:pillars:28,1');
    assert.equal(chestIdForMarker(restored.dungeonRun.state, { ...marker, type: 'finalChest' }), 'floor-1:treasure:37,13');
    const paid = restored.dungeonRun.openChest(chestIdForMarker(restored.dungeonRun.state, { ...marker, type: 'chest' }), false,
        () => { throw new Error('Legacy chest must not reroll'); });
    assert.equal(paid.status === 'opened' && paid.grantedQty, 0);
    assert.deepEqual(restored.player.inventory, inventory);
});

test('Next Tower leaves the old run intact on storage failure; interrupted tower save recovers once', async (t) =>
{
    t.mock.method(console, 'error', () => {});
    const storage = new MemoryStorage();
    const game = await boot(storage);
    game.tower.setLevel(99);
    game.beginTowerRun();
    const oldId = game.dungeonRun.state.runId;
    const { nextTower } = await runner.import('/src/game/dev/nextTower.ts');
    storage.failKeys.add('eduroam.dungeon');
    assert.equal(nextTower(), false);
    assert.equal(game.tower.state.towerLevel, 99);
    assert.equal(game.dungeonRun.state.runId, oldId);
    storage.failKeys.clear();
    storage.failKeys.add('eduroam.tower');
    assert.equal(nextTower(), true);
    assert.equal(game.dungeonRun.state.towerLevel, 100, 'no level 99 clamp prevents an exact increment');
    storage.failKeys.clear();
    const restored = await boot(storage);
    restored.reconcileTowerProgress();
    restored.reconcileTowerProgress();
    assert.equal(restored.tower.state.towerLevel, 100);
    assert.equal(restored.tower.state.runsCompleted, 0);
});

test('completion interrupted between run and tower saves recovers once before the next run', async () =>
{
    const storage = new MemoryStorage();
    let game = await boot(storage);
    game.tower.setLevel(5);
    game.beginTowerRun({ floorCount: 2 });
    game.dungeonRun.advanceFloor();
    game.dungeonRun.defeatGuardian();
    game.dungeonRun.openChest('final', true, () => ({ itemId: 'reinforced_armor', qty: 1 }));
    assert.equal(game.dungeonRun.complete(), true);
    game = await boot(storage);
    game.beginTowerRun();
    assert.equal(game.tower.state.towerLevel, 6);
    assert.equal(game.tower.state.runsCompleted, 1);
    assert.equal(game.dungeonRun.state.towerLevel, 6);
    assert.equal(game.player.count('reinforced_armor'), 1);
});

test('a failed completion reconciliation keeps the completed run for a later retry', async (t) =>
{
    t.mock.method(console, 'error', () => {});
    const storage = new MemoryStorage();
    const game = await boot(storage);
    game.beginTowerRun({ floorCount: 2 });
    game.dungeonRun.advanceFloor();
    game.dungeonRun.defeatGuardian();
    game.dungeonRun.openChest('final', true, () => ({ itemId: 'magic_crystal', qty: 1 }));
    game.dungeonRun.complete();
    const id = game.dungeonRun.state.runId;
    storage.failKeys.add('eduroam.tower');
    assert.equal(game.beginTowerRun(), false);
    assert.equal(game.dungeonRun.state.runId, id, 'do not overwrite the recovery record');
    assert.equal(game.dungeonRun.state.completed, true);
    storage.failKeys.clear();
    assert.equal(game.beginTowerRun(), true);
    assert.equal(game.dungeonRun.state.towerLevel, 2);
    assert.equal(game.tower.state.runsCompleted, 1);
});

test('explicit development level override applies to the next run', async () =>
{
    const game = await boot();
    game.tower.setLevel(8);
    game.beginTowerRun();
    game.tower.setLevel(1);
    game.beginTowerRun({ seed: 42 });
    assert.equal(game.dungeonRun.state.towerLevel, 1);
});

test('hurtboxes: upper body and narrow edge sectors hit large enemies; off-body attacks miss', async () =>
{
    await boot();
    const { sectorHitsRect, rectContains } = await runner.import('/src/game/combat/hitboxes.ts');
    const boss = { x: 84, y: 56, w: 32, h: 42 };
    assert.equal(rectContains(boss, 100, 60), true, 'arrow at Hades upper body');
    assert.equal(rectContains(boss, 120, 60), false);
    assert.equal(sectorHitsRect(boss, { x: 100, y: 35 }, Math.PI / 2, 30, 0.3), true);
    assert.equal(sectorHitsRect(boss, { x: 100, y: 35 }, -Math.PI / 2, 30, 0.3), false);
    assert.equal(sectorHitsRect({ x: 0, y: 0, w: 100, h: 100 }, { x: -10, y: 50 }, -0.4, 30, 0.01), true,
        'a sector crossing a flat edge cannot miss because its sampled corners are out of reach');
});

test('Next Tower increments one, starts fresh unscaled-to-scaled run, restores HP and grants nothing', async () =>
{
    const storage = new MemoryStorage();
    const game = await boot(storage);
    game.tower.setLevel(7);
    game.beginTowerRun({ seed: 12, biomeId: 'crypt', floorCount: 3 });
    game.dungeonRun.advanceFloor();
    game.dungeonRun.damage(25);
    const oldId = game.dungeonRun.state.runId;
    const oldBiome = game.dungeonRun.state.biomeId;
    const inventory = structuredClone(game.player.inventory);
    const { nextTower } = await runner.import('/src/game/dev/nextTower.ts');
    assert.equal(nextTower(), true);
    const r = game.dungeonRun.state;
    assert.equal(game.tower.state.towerLevel, 8);
    assert.equal(r.towerLevel, 8);
    assert.equal(r.floorIndex, 1);
    assert.equal(r.hp, 50);
    assert.notEqual(r.runId, oldId);
    assert.notEqual(r.biomeId, oldBiome);
    assert.deepEqual(r.chests, {});
    assert.equal(r.stats.completions, 0);
    assert.equal(game.tower.state.runsCompleted, 0);
    assert.deepEqual(game.player.inventory, inventory);
    const restored = await boot(storage);
    assert.equal(restored.tower.state.towerLevel, 8);
    assert.equal(restored.dungeonRun.state.runId, r.runId);
});
