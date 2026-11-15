// Tower progression + difficulty scaling (pure logic, no Phaser).
// Run: npm test

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

type ScalingModule = typeof import('../src/game/combat/scaling.ts');
type TowerModule = typeof import('../src/game/state/tower.ts');

const ROOT = fileURLToPath(new URL('..', import.meta.url));

class MemoryStorage
{
    data = new Map<string, string>();
    get length () { return this.data.size; }
    key (i: number) { return [...this.data.keys()][i] ?? null; }
    getItem (key: string) { return this.data.get(key) ?? null; }
    setItem (key: string, value: string) { this.data.set(key, String(value)); }
    removeItem (key: string) { this.data.delete(key); }
    clear () { this.data.clear(); }
}

let server: ViteDevServer;
const runners: ReturnType<typeof createServerModuleRunner>[] = [];

before(async () =>
{
    server = await createServer({
        configFile: false, root: ROOT, logLevel: 'error', appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] },
    });
});
after(async () =>
{
    await Promise.all(runners.map((r) => r.close()));
    await server.close();
});
afterEach(async () => { await Promise.all(runners.splice(0).map((r) => r.close())); });

async function load<T> (path: string, storage = new MemoryStorage()): Promise<T>
{
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
    const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    runners.push(runner);
    return runner.import(path) as Promise<T>;
}

test('scaling: tower level 1 / floor 1 is unscaled; formula matches the design', async () =>
{
    const { enemyMultipliers, scaleStats } = await load<ScalingModule>('/src/game/combat/scaling.ts');
    assert.deepEqual(enemyMultipliers({ towerLevel: 1, floorIndex: 1 }), { hp: 1, damage: 1 });
    const m = enemyMultipliers({ towerLevel: 5, floorIndex: 2 });
    assert.ok(Math.abs(m.hp - (1 + 0.06 * 4 + 0.08 * 1)) < 1e-9);
    assert.ok(Math.abs(m.damage - (1 + 0.04 * 4 + 0.05 * 1)) < 1e-9);
    assert.deepEqual(scaleStats({ hp: 16, damage: 5 }, { towerLevel: 1, floorIndex: 1 }), { hp: 16, damage: 5 });
});

test('scaling: capped, never impossible, no huge jumps between runs', async () =>
{
    const { enemyMultipliers, scaleStats, damageAfterArmor } = await load<ScalingModule>('/src/game/combat/scaling.ts');
    assert.deepEqual(enemyMultipliers({ towerLevel: 500, floorIndex: 3 }), { hp: 2.5, damage: 2 });
    const boss = enemyMultipliers({ towerLevel: 500, floorIndex: 3 }, true);
    assert.ok(boss.hp <= 2.6 && boss.damage <= 1.8);
    for (let level = 1; level < 30; level++)
    {
        const a = enemyMultipliers({ towerLevel: level, floorIndex: 1 }).hp;
        const b = enemyMultipliers({ towerLevel: level + 1, floorIndex: 1 }).hp;
        assert.ok(b - a <= 0.061, `HP jump between level ${level} and ${level + 1}`);
    }
    // No one-hit kills: the strongest ordinary hit (giant slam, 8) at a very high level, no armor.
    const giant = scaleStats({ hp: 45, damage: 8 }, { towerLevel: 50, floorIndex: 3 });
    assert.ok(damageAfterArmor(giant.damage, 0) <= 16, 'needs at least 4 hits to kill a 50 HP player without armor');
});

test('scaling: tower level 1 is fair against starter gear (cloth armor, wooden sword)', async () =>
{
    const { scaleStats, damageAfterArmor } = await load<ScalingModule>('/src/game/combat/scaling.ts');
    const ctx = { towerLevel: 1, floorIndex: 1 };
    const zombie = scaleStats({ hp: 16, damage: 5 }, ctx);
    assert.equal(damageAfterArmor(zombie.damage, 2), 3, 'zombie hit = 3 HP of 50');
    assert.equal(Math.ceil(zombie.hp / 5), 4, 'zombie dies in 4 sword hits');
    assert.equal(Math.ceil(scaleStats({ hp: 3, damage: 2 }, ctx).hp / 3), 1, 'skeletons die to one hit of either starter weapon');
    assert.equal(damageAfterArmor(1, 5), 1, 'armor never reduces damage below 1');
});

test('scaling: boss stays killable in a reasonable number of hits', async () =>
{
    const { scaleStats } = await load<ScalingModule>('/src/game/combat/scaling.ts');
    const hades1 = scaleStats({ hp: 150, damage: 8 }, { towerLevel: 1, floorIndex: 3 }, true);
    assert.ok(Math.ceil(hades1.hp / 5) <= 30, 'about 30 wooden-sword hits at tower level 1');
    const hades10 = scaleStats({ hp: 150, damage: 8 }, { towerLevel: 10, floorIndex: 3 }, true);
    assert.ok(Math.ceil(hades10.hp / 10) <= 25, 'iron sword at tower level 10 needs at most 25 hits');
});

test('tower: completion raises the level once per run, survives reload', async () =>
{
    const storage = new MemoryStorage();
    let { tower } = await load<TowerModule>('/src/game/state/tower.ts', storage);
    assert.equal(tower.state.towerLevel, 1);
    assert.equal(tower.recordCompletion('run_a'), true);
    assert.equal(tower.recordCompletion('run_a'), false, 'same run never counts twice');
    assert.equal(tower.state.towerLevel, 2);
    tower.setLastBiome('crypt');

    ({ tower } = await load<TowerModule>('/src/game/state/tower.ts', storage));
    assert.equal(tower.state.towerLevel, 2);
    assert.equal(tower.recordCompletion('run_a'), false, 'still not after a reload');
    assert.equal(tower.recordCompletion('run_b'), true);
    assert.deepEqual({ level: tower.state.towerLevel, runs: tower.state.runsCompleted, biome: tower.state.lastBiome }, { level: 3, runs: 2, biome: 'crypt' });
});

test('tower: unreadable save is backed up, not silently lost', async (t) =>
{
    t.mock.method(console, 'warn', () => {});
    const storage = new MemoryStorage();
    storage.setItem('eduroam.tower', '{broken');
    const { tower } = await load<TowerModule>('/src/game/state/tower.ts', storage);
    assert.equal(tower.state.towerLevel, 1);
    assert.equal(storage.getItem('eduroam.tower.backup'), '{broken');
    tower.setLevel(0);
    assert.equal(tower.state.towerLevel, 1, 'level is clamped');
});

type LootModule = typeof import('../src/game/items/lootTables.ts');
type BalanceModule = typeof import('../src/game/progression/balance.ts');
type ItemsModule = typeof import('../src/game/items/itemDefs.ts');
type GenModule = typeof import('../src/game/world/dungeon/generate.ts');
type EncModule = typeof import('../src/game/world/dungeon/encounters.ts');
type BiomeModule = typeof import('../src/game/world/dungeon/biomes.ts');
type EnemyModule = typeof import('../src/game/combat/enemyTypes.ts');

test('rewards: every dungeon chest pays 10 crystals (village currency), never combat gear', async () =>
{
    const { chestReward } = await load<LootModule>('/src/game/items/lootTables.ts');
    const { ITEM_DEFS } = await load<ItemsModule>('/src/game/items/itemDefs.ts');
    for (let i = 0; i < 20; i++) assert.deepEqual(chestReward(), { itemId: 'number_crystal', qty: 10 });
    assert.ok(10 <= ITEM_DEFS.number_crystal.maxStack, 'one chest fits one slot');
    assert.ok(!Object.values(ITEM_DEFS).some((d) => d.category === 'weapon'), 'no weapon items exist');
});

/**
 * Rough pacing model (not a simulation): enemy HP to chew through at the gear a player has at that
 * tower level, plus per-room / per-wave / boss overheads. Guards the ~10 minute dungeon target
 * against content changes making runs far longer or trivially short.
 */
test('pacing: a run lands near the 10 minute target at early, mid and later tower levels', async () =>
{
    const { planFloor, floorSeed } = await load<GenModule>('/src/game/world/dungeon/generate.ts');
    const { rollRoomWaves } = await load<EncModule>('/src/game/world/dungeon/encounters.ts');
    const { BIOMES, BIOME_IDS } = await load<BiomeModule>('/src/game/world/dungeon/biomes.ts');
    const { ENEMY_TYPES } = await load<EnemyModule>('/src/game/combat/enemyTypes.ts');
    const { scaleStats } = await load<ScalingModule>('/src/game/combat/scaling.ts');

    // Effective DPS: sword DPS x ~45 % uptime (moving, dodging, telegraphs), with the sword points a
    // player typically has at that tower level (~1 player level per tower level, 3 points per level,
    // about half of them in the sword). Ranged weapons add burst on top; the sword is the baseline.
    const { WEAPON, weaponDamage } = await load<BalanceModule>('/src/game/progression/balance.ts');
    const swordDps = (points: number) => weaponDamage('sword', points) / (WEAPON.sword.cooldownMs / 1000);
    const gear = { 1: swordDps(0), 5: swordDps(6), 10: swordDps(14) } as Record<number, number>;
    const ROOM_S = 14, WAVE_S = 3, BOSS_S = 25;
    const results: string[] = [];

    for (const towerLevel of [1, 5, 10])
    {
        for (const floorCount of [2, 3])
        {
            let total = 0;
            const samples = 30;
            for (let s = 0; s < samples; s++)
            {
                const seed = 1000 + s * 7919;
                const biome = BIOMES[BIOME_IDS[s % BIOME_IDS.length]];
                let hp = 0, overhead = 0;
                for (let floorIndex = 1; floorIndex <= floorCount; floorIndex++)
                {
                    const plan = planFloor({ seed, biomeId: biome.id, floorIndex, floorCount });
                    const ctx = { towerLevel, floorIndex };
                    overhead += plan.rooms.length * ROOM_S;
                    for (const room of plan.rooms.filter((r) => r.role === 'combat'))
                    {
                        const waves = rollRoomWaves(floorSeed(seed, floorIndex), room.id, biome, ctx, 8);
                        overhead += waves.length * WAVE_S;
                        for (const wave of waves) for (const id of wave) hp += scaleStats({ hp: ENEMY_TYPES[id].hp, damage: 1 }, ctx).hp;
                    }
                    if (floorIndex === floorCount)
                    {
                        hp += scaleStats({ hp: ENEMY_TYPES.hades.hp, damage: 1 }, ctx, true).hp;
                        overhead += BOSS_S;
                    }
                }
                total += (hp / (gear[towerLevel] * 0.45) + overhead) / 60;
            }
            const minutes = total / samples;
            results.push(`TL${towerLevel} ${floorCount}F ${minutes.toFixed(1)}m`);
            assert.ok(minutes >= 4.5 && minutes <= 13, `TL${towerLevel} ${floorCount} floors: ${minutes.toFixed(1)} min`);
        }
    }
    console.log('[pacing]', results.join(', '));
});
