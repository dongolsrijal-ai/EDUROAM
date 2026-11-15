// Progression formulas + a local balance simulation over REAL dungeon content (the same floor
// planner, builder and seeded encounter roller the Dungeon scene uses).
//
// The simulation prints a table (run with `node --test tests/progression.test.mts`) and checks the
// targets: about 1000-1200 XP per early successful study + dungeon cycle, ~1 cycle per level early,
// ~1.3-1.6 mid game, ~1.6-2 later.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';
import {
    addXp, ARROWS, burstDps, combatStats, damageMultiplier, DUNGEON_COMPLETION_XP, ENEMY_XP, killBaseXp, MANA, XP, maxHpFor, minigameReward,
    pointsEarned, scaledXp, SPLASH, sustainableDps, timeToKill, towerXpBonus, WEAPON, weaponDamage, xpMultiplier, xpToNext,
} from '../src/game/progression/balance.ts';

// Canonical path: a drive-letter case mismatch would load one module twice (two player states).
const ROOT = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));

// ---------------------------------------------------------------- formulas

test('XP to next level: 1000 + 100 per level', () =>
{
    assert.deepEqual([1, 2, 3, 4, 10, 20].map(xpToNext), [1000, 1100, 1200, 1300, 1900, 2900]);
});

test('XP multiplier: +3 % per level, capped at 1.75x', () =>
{
    assert.deepEqual([1, 5, 10, 15, 20].map((l) => Math.round(xpMultiplier(l) * 100) / 100), [1, 1.12, 1.27, 1.42, 1.57]);
    assert.equal(xpMultiplier(26), 1.75);
    assert.equal(xpMultiplier(80), 1.75);
    assert.equal(scaledXp(75, 10), Math.round(75 * 1.27));
});

test('tower bonus is dungeon-only, small and capped', () =>
{
    assert.equal(towerXpBonus(1), 0);
    assert.ok(towerXpBonus(5) <= 0.02 * 4 + 1e-9);
    assert.ok(towerXpBonus(500) <= 0.2);
    assert.equal(scaledXp(100, 1, 11), Math.round(100 * (1 + towerXpBonus(11))));
    assert.equal(scaledXp(100, 1), 100, 'no tower level = no bonus (mini-games)');
});

test('XP carries over through several level-ups and is never discarded', () =>
{
    assert.deepEqual(addXp({ level: 1, xp: 900 }, 150), { level: 2, xp: 50, levelsGained: 1 });
    // 1000 + 1100 + 1200 = 3300 to reach level 4; 3350 leaves 50 toward level 5.
    assert.deepEqual(addXp({ level: 1, xp: 0 }, 3350), { level: 4, xp: 50, levelsGained: 3 });
    assert.deepEqual(addXp({ level: 3, xp: 10 }, 0), { level: 3, xp: 10, levelsGained: 0 });
});

test('kill XP: full inside the per-run budget, a small share after it', () =>
{
    assert.equal(killBaseXp(25, 0), 25);
    assert.equal(killBaseXp(50, XP.killBudgetPerRun - 20), 20 + 30 * XP.afterBudget);
    assert.equal(killBaseXp(20, XP.killBudgetPerRun + 500), 20 * XP.afterBudget);
});

test('enemy XP follows threat; skeletons give none; Hades 100; completion 500', () =>
{
    assert.ok(ENEMY_XP.zombie < ENEMY_XP.giant && ENEMY_XP.giant < ENEMY_XP.reaper);
    assert.deepEqual(ENEMY_XP, { zombie: 20, goblin: 25, wizard: 35, giant: 50, reaper: 65, hades: 100, skeleton: 0 });
    assert.equal(DUNGEON_COMPLETION_XP, 500);
});

test('mini-game rewards by accuracy; crystals 1-5 and never level-scaled', () =>
{
    const rows = [0, 0.19, 0.2, 0.39, 0.4, 0.59, 0.6, 0.7999, 0.8, 1].map((a) => [minigameReward(a).baseXp, minigameReward(a).crystals]);
    assert.deepEqual(rows, [[20, 1], [20, 1], [30, 2], [30, 2], [45, 3], [45, 3], [60, 4], [60, 4], [75, 5], [75, 5]]);
    assert.deepEqual(minigameReward(Number.NaN), { baseXp: 20, crystals: 1 });
    assert.deepEqual(minigameReward(7), { baseXp: 75, crystals: 5 });
});

test('stats: 3 points per level, +5 HP per Health point, capped diminishing weapon multiplier', () =>
{
    assert.deepEqual([1, 2, 5].map(pointsEarned), [0, 3, 12]);
    assert.deepEqual([0, 1, 10].map(maxHpFor), [50, 55, 100]);
    assert.equal(damageMultiplier(0), 1);
    assert.equal(Math.round(damageMultiplier(10) * 100) / 100, 1.3);
    assert.equal(Math.round(damageMultiplier(20) * 100) / 100, 1.6);
    assert.equal(Math.round(damageMultiplier(30) * 100) / 100, 1.7);
    assert.equal(damageMultiplier(1000), 2.25);
});

test('each weapon stat changes only its own weapon', () =>
{
    const base = combatStats({ health: 0, sword: 0, bow: 0, staff: 0 });
    assert.deepEqual([base.maxHp, base.swordDamage, base.bowDamage, base.staffDamage], [50, 12, 14, 9]);
    const sword = combatStats({ health: 0, sword: 10, bow: 0, staff: 0 });
    assert.ok(sword.swordDamage > base.swordDamage && sword.bowDamage === base.bowDamage && sword.staffDamage === base.staffDamage);
    const bow = combatStats({ health: 0, sword: 0, bow: 10, staff: 0 });
    assert.ok(bow.bowDamage > base.bowDamage && bow.swordDamage === base.swordDamage && bow.staffDamage === base.staffDamage);
    const staff = combatStats({ health: 0, sword: 0, bow: 0, staff: 10 });
    assert.ok(staff.staffDamage > base.staffDamage && staff.swordDamage === base.swordDamage && staff.bowDamage === base.bowDamage);
    assert.equal(combatStats({ health: 4, sword: 0, bow: 0, staff: 0 }).maxHp, 70);
});

// ---------------------------------------------------------------- combat balance

test('combat roles hold at every allocation: bow beats staff on one target, staff wins on groups', () =>
{
    for (const points of [0, 5, 10, 20, 40, 200])
    {
        const bow = weaponDamage('bow', points);
        const staff = weaponDamage('staff', points);
        const sword = weaponDamage('sword', points);
        // Single target: per hit, burst and sustainable.
        assert.ok(bow > staff, `bow per-hit > staff at ${points}`);
        assert.ok(burstDps(bow, WEAPON.bow.cooldownMs) > burstDps(staff, WEAPON.staff.cooldownMs));
        const bowSus = sustainableDps(bow, WEAPON.bow.cooldownMs, ARROWS.regenPerSecond, ARROWS.cost);
        const staffSus = sustainableDps(staff, WEAPON.staff.cooldownMs, MANA.regenPerSecond, MANA.cost);
        assert.ok(bowSus > staffSus, `bow sustained ${bowSus} > staff ${staffSus} at ${points}`);
        // Groups of 4: one staff cast out-damages one arrow.
        const castOnGroup = staff + Math.min(3, SPLASH.maxSecondary) * staff * SPLASH.ratio;
        assert.ok(castOnGroup > bow, `staff on a group > bow at ${points}`);
        // The sword (unlimited, close range) has the best sustained single-target DPS but no reach.
        assert.ok(burstDps(sword, WEAPON.sword.cooldownMs) > bowSus);
    }
});

// ---------------------------------------------------------------- simulation over real dungeon content

let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
before(async () =>
{
    server = await createServer({
        configFile: false, root: ROOT, logLevel: 'error', appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] },
    });
    runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
});
after(async () => { await runner.close(); await server.close(); });

type Gen = typeof import('../src/game/world/dungeon/generate.ts');
type Build = typeof import('../src/game/world/dungeon/build.ts');
type Enc = typeof import('../src/game/world/dungeon/encounters.ts');
type Biomes = typeof import('../src/game/world/dungeon/biomes.ts');
type Types = typeof import('../src/game/combat/enemyTypes.ts');
type Scaling = typeof import('../src/game/combat/scaling.ts');

async function content ()
{
    const [gen, build, enc, biomes, types, scaling] = await Promise.all([
        runner.import('/src/game/world/dungeon/generate.ts') as Promise<Gen>,
        runner.import('/src/game/world/dungeon/build.ts') as Promise<Build>,
        runner.import('/src/game/world/dungeon/encounters.ts') as Promise<Enc>,
        runner.import('/src/game/world/dungeon/biomes.ts') as Promise<Biomes>,
        runner.import('/src/game/combat/enemyTypes.ts') as Promise<Types>,
        runner.import('/src/game/combat/scaling.ts') as Promise<Scaling>,
    ]);
    /** Enemy type ids of every wave, per floor, exactly as the Dungeon scene rolls them. */
    const runEnemies = (seed: number, towerLevel: number) =>
    {
        const biomeId = biomes.BIOME_IDS[seed % biomes.BIOME_IDS.length];
        const floorCount = seed % 100 < 35 ? 2 : 3;
        const floors: string[][] = [];
        for (let floorIndex = 1; floorIndex <= floorCount; floorIndex++)
        {
            const plan = gen.planFloor({ seed, biomeId, floorIndex, floorCount });
            const dungeon = build.buildDungeon(plan, gen.floorSeed(seed, floorIndex));
            const slots = new Map<string, number>();
            for (const m of dungeon.markers) if (m.type === 'enemySlot') slots.set(m.roomId, (slots.get(m.roomId) ?? 0) + 1);
            const enemies: string[] = [];
            for (const room of dungeon.rooms)
            {
                if (room.role !== 'combat') continue;
                for (const wave of enc.rollRoomWaves(gen.floorSeed(seed, floorIndex), room.id, biomes.BIOMES[biomeId], { towerLevel, floorIndex }, slots.get(room.id) ?? 0)) enemies.push(...wave);
            }
            floors.push(enemies);
        }
        return floors;
    };
    return { runEnemies, types, scaling };
}

interface Student { name: string; accuracy: number; minigames: number; successRate: number }

/** Plays cycles (study block of mini-games + one dungeon) and records cycles spent per level. */
function simulate (student: Student, runEnemies: (seed: number, towerLevel: number) => string[][], cycles = 60)
{
    let state = { level: 1, xp: 0 };
    let towerLevel = 1;
    let successes = 0;
    const cyclesPerLevel: number[] = [];
    let since = 0;
    const firstCycleXp: number[] = [];
    let enemyCount = 0;
    for (let c = 0; c < cycles; c++)
    {
        const before = { ...state };
        let gained = 0;
        const give = (xp: number) => { const next = addXp(state, xp); gained += xp; state = { level: next.level, xp: next.xp }; for (let i = 0; i < next.levelsGained; i++) { cyclesPerLevel.push(since + 1); since = 0; } };

        const { baseXp } = minigameReward(student.accuracy);
        for (let m = 0; m < student.minigames; m++) give(scaledXp(baseXp, state.level));

        const seed = 1009 * (c + 1) + Math.round(student.accuracy * 100);
        const floors = runEnemies(seed, towerLevel);
        // Deterministic success pattern with the student's success rate.
        const success = (c * student.successRate) % 1 + student.successRate >= 1 || student.successRate === 1;
        let runKill = 0;
        floors.forEach((enemies, i) =>
        {
            const finalFloor = i === floors.length - 1;
            // A failed run dies on the final floor after clearing half of it (kills kept, no bonus).
            const cleared = success || !finalFloor ? enemies : enemies.slice(0, Math.floor(enemies.length / 2));
            for (const id of cleared)
            {
                const base = ENEMY_XP[id as keyof typeof ENEMY_XP];
                give(scaledXp(killBaseXp(base, runKill), state.level, towerLevel));
                runKill += base;
                enemyCount++;
            }
        });
        if (success)
        {
            give(scaledXp(ENEMY_XP.hades, state.level, towerLevel));
            give(scaledXp(DUNGEON_COMPLETION_XP, state.level, towerLevel));
            successes++;
            towerLevel = successes + 1;
        }
        since += state.level === before.level ? 1 : 0;
        if (c < 3) firstCycleXp.push(gained);
    }
    return { finalLevel: state.level, cyclesPerLevel, firstCycleXp, avgEnemies: enemyCount / cycles };
}

const STUDENTS: Student[] = [
    { name: 'high accuracy', accuracy: 0.9, minigames: 3, successRate: 1 },
    { name: 'typical', accuracy: 0.65, minigames: 3, successRate: 1 },
    { name: 'low accuracy', accuracy: 0.25, minigames: 2, successRate: 1 },
    { name: 'fails half the runs', accuracy: 0.65, minigames: 3, successRate: 0.5 },
];

test('progression simulation over real dungeon content hits the playtime targets', async () =>
{
    const { runEnemies } = await content();
    const rows: string[] = [];
    const results = new Map<string, ReturnType<typeof simulate>>();
    for (const s of STUDENTS)
    {
        const r = simulate(s, runEnemies);
        results.set(s.name, r);
        const at = (lv: number) => r.cyclesPerLevel[lv - 1]?.toFixed(0) ?? '-';
        const avg = (from: number, to: number) => { const slice = r.cyclesPerLevel.slice(from - 1, to); return slice.length ? (slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2) : '-'; };
        rows.push(`${s.name.padEnd(20)} cycle1 XP ${String(r.firstCycleXp[0]).padStart(5)}  enemies/run ${r.avgEnemies.toFixed(1).padStart(4)}  `
            + `cycles/level L1 ${at(1)} L5 ${at(5)} L10 ${at(10)} L15 ${at(15)} L20 ${at(20)}  avg L1-4 ${avg(1, 4)} L8-12 ${avg(8, 12)} L16-24 ${avg(16, 24)}  level after 60 cycles ${r.finalLevel}`);
    }
    console.log(`\n${rows.join('\n')}\n`);

    const typical = results.get('typical')!;
    assert.ok(typical.firstCycleXp[0] >= 1000 && typical.firstCycleXp[0] <= 1250, `early cycle XP ${typical.firstCycleXp[0]} (target 1000-1200)`);
    assert.equal(typical.cyclesPerLevel[0], 1, 'first level after one successful cycle');
    const avg = (r: ReturnType<typeof simulate>, from: number, to: number) => r.cyclesPerLevel.slice(from - 1, to).reduce((a, b) => a + b, 0) / (to - from + 1);
    const mid = avg(typical, 8, 12);
    const late = avg(typical, 16, 24);
    assert.ok(mid >= 1.2 && mid <= 1.7, `mid game ${mid.toFixed(2)} cycles/level (target ~1.3-1.6)`);
    assert.ok(late >= 1.5 && late <= 2.1, `late game ${late.toFixed(2)} cycles/level (target ~1.6-2)`);
    // Accuracy and success still matter, without stalling anyone.
    assert.ok(results.get('high accuracy')!.finalLevel >= typical.finalLevel);
    assert.ok(results.get('low accuracy')!.finalLevel < typical.finalLevel && results.get('low accuracy')!.finalLevel >= typical.finalLevel - 6);
    assert.ok(results.get('fails half the runs')!.finalLevel < typical.finalLevel);
});

test('time to kill at level 1 / 5 / 10, tower 1 and 6: no weapon dominates every case', async () =>
{
    const { types, scaling } = await content();
    const rows: string[] = [];
    const allocations = {
        'L1 fresh': { health: 0, sword: 0, bow: 0, staff: 0 },
        'L5 even': { health: 3, sword: 3, bow: 3, staff: 3 },
        'L10 sword spec': { health: 6, sword: 21, bow: 0, staff: 0 },
        'L10 bow spec': { health: 6, sword: 0, bow: 21, staff: 0 },
        'L10 staff spec': { health: 6, sword: 0, bow: 0, staff: 21 },
    };
    for (const towerLevel of [1, 6])
    {
        for (const [name, alloc] of Object.entries(allocations))
        {
            const s = combatStats(alloc);
            const cells: string[] = [];
            for (const id of ['zombie', 'giant', 'hades'] as const)
            {
                const kind = types.ENEMY_TYPES[id];
                const hp = scaling.scaleStats({ hp: kind.hp, damage: kind.damage }, { towerLevel, floorIndex: id === 'hades' ? 3 : 2 }, id === 'hades').hp;
                const sword = timeToKill(hp, s.swordDamage, WEAPON.sword.cooldownMs);
                const bow = timeToKill(hp, s.bowDamage, WEAPON.bow.cooldownMs, ARROWS);
                const staff = timeToKill(hp, s.staffDamage, WEAPON.staff.cooldownMs, MANA);
                cells.push(`${id} ${hp}hp sw ${sword.toFixed(1)}s bow ${bow.toFixed(1)}s st ${staff.toFixed(1)}s`);
                // Single target, EQUAL investment: the bow always finishes before the staff.
                const p = Math.max(alloc.bow, alloc.staff);
                const bowSame = timeToKill(hp, weaponDamage('bow', p), WEAPON.bow.cooldownMs, ARROWS);
                const staffSame = timeToKill(hp, weaponDamage('staff', p), WEAPON.staff.cooldownMs, MANA);
                assert.ok(bowSame <= staffSame, `${name} T${towerLevel} ${id}: bow ${bowSame} vs staff ${staffSame} at ${p} points`);
            }
            rows.push(`T${towerLevel} ${name.padEnd(15)} ${cells.join(' | ')}`);
        }
    }
    console.log(`\n${rows.join('\n')}\n`);
    // Groups: one full mana bar on 4 clustered zombies vs the same mana time with arrows.
    const z = types.ENEMY_TYPES.zombie.hp;
    const s = combatStats({ health: 0, sword: 0, bow: 0, staff: 0 });
    const staffGroupDamage = (MANA.max / MANA.cost) * (s.staffDamage + 3 * s.staffSplashDamage);
    const bowGroupDamage = (ARROWS.max / ARROWS.cost) * s.bowDamage;
    assert.ok(staffGroupDamage > bowGroupDamage, `full staff bar on a group ${staffGroupDamage} > full quiver ${bowGroupDamage}`);
    assert.ok(staffGroupDamage >= 4 * z * 0.8, 'a full mana bar nearly clears a pack of four zombies');
});
