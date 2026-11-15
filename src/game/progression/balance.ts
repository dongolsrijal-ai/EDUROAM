// PROGRESSION + COMBAT BALANCE: every XP, stat, weapon and resource number in one place, with
// the pure formulas that use them (no Phaser, no storage: unit-tested and simulated in
// tests/progression*.test.mts). Change a constant here and the whole game follows.
//
// Three separate economies:
//   XP          -> player level (mini-games, enemy kills, dungeon victories)
//   stat points -> Health / Sword / Bow / Staff (3 per level)
//   crystals    -> village decorations only (mini-games 1-5, dungeon chests 10)

import type { EnemyTypeId } from '../combat/enemyTypes';

// ---------------------------------------------------------------- XP curve

export const XP = {
    /** XP needed for level 1 -> 2; every next level needs `perLevel` more. */
    firstLevel: 1000,
    perLevel: 100,
    /** Reward multiplier: +3 % per level above 1, capped at 1.75x (reached at level 26). */
    multiplierPerLevel: 0.03,
    multiplierCap: 1.75,
    /** Dungeon-only bonus per tower level above 1, capped (enemy kills + completion only). */
    towerBonusPerLevel: 0.005,
    towerBonusCap: 0.05,
    /**
     * Kill XP budget per dungeon run, in BASE XP (before multipliers). Runs hold ~30 enemies at
     * tower 1 and 50+ later, so uncapped kills would dwarf the study + victory rewards. Kills pay
     * full base XP until the run's kills reach the budget, then `afterBudget` of it.
     * Calibrated with tests/progression.test.mts (Hades + completion are outside the budget).
     */
    killBudgetPerRun: 300,
    afterBudget: 0.05,
    /** Safety cap: one reward event never grants more than this (before carry-over). */
    maxPerEvent: 5000,
} as const;

/** XP required to go from `level` to `level + 1` (not lifetime XP). */
export const xpToNext = (level: number) => XP.firstLevel + XP.perLevel * (Math.max(1, Math.floor(level)) - 1);

/** Reward multiplier at the player's level when the reward happens. */
export const xpMultiplier = (level: number) => Math.min(XP.multiplierCap, 1 + XP.multiplierPerLevel * (Math.max(1, Math.floor(level)) - 1));

/** Small dungeon-only difficulty bonus from the run's tower level. */
export const towerXpBonus = (towerLevel: number) => Math.min(XP.towerBonusCap, XP.towerBonusPerLevel * (Math.max(1, Math.floor(towerLevel)) - 1));

/** FINAL_XP = round(BASE_XP * MULTIPLIER(level) * (1 + dungeon bonus)). */
export function scaledXp (baseXp: number, level: number, towerLevel: number | null = null): number
{
    const bonus = towerLevel === null ? 0 : towerXpBonus(towerLevel);
    return Math.min(XP.maxPerEvent, Math.max(0, Math.round(baseXp * xpMultiplier(level) * (1 + bonus))));
}

export interface LevelState
{
    level: number;
    /** XP earned toward the next level. */
    xp: number;
}

/** Adds XP with carry-over: several level-ups from one event, excess XP never discarded. */
export function addXp (state: LevelState, amount: number): LevelState & { levelsGained: number }
{
    let { level, xp } = state;
    xp += Math.max(0, Math.floor(amount));
    let levelsGained = 0;
    while (xp >= xpToNext(level))
    {
        xp -= xpToNext(level);
        level++;
        levelsGained++;
    }
    return { level, xp, levelsGained };
}

/** Total XP to reach `level` from level 1 (simulation + dev "set level"). */
export const xpForLevel = (level: number) => Array.from({ length: Math.max(0, Math.floor(level) - 1) }, (_, i) => xpToNext(i + 1)).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------- rewards

/**
 * Base XP a kill actually pays given the run's kill XP so far (base units): full XP inside the
 * per-run budget, a small share after it. Split kills straddle the budget exactly.
 */
export function killBaseXp (baseXp: number, runKillBaseSoFar: number)
{
    const room = Math.max(0, XP.killBudgetPerRun - runKillBaseSoFar);
    const inside = Math.min(baseXp, room);
    return inside + (baseXp - inside) * XP.afterBudget;
}

/** Base XP per enemy type (summoned skeletons give nothing). */
export const ENEMY_XP: Record<EnemyTypeId, number> = {
    zombie: 20, goblin: 25, wizard: 35, giant: 50, reaper: 65, hades: 100, skeleton: 0,
};

/** Successful dungeon run (final floor cleared and portal home taken). Hades' kill XP is separate. */
export const DUNGEON_COMPLETION_XP = 500;

/** Mini-game rewards by accuracy (lower bound inclusive). Crystals never scale with level. */
export const MINIGAME_TIERS: { minAccuracy: number; xp: number; crystals: number }[] = [
    { minAccuracy: 0.8, xp: 75, crystals: 5 },
    { minAccuracy: 0.6, xp: 60, crystals: 4 },
    { minAccuracy: 0.4, xp: 45, crystals: 3 },
    { minAccuracy: 0.2, xp: 30, crystals: 2 },
    { minAccuracy: 0, xp: 20, crystals: 1 },
];

/** Meaningful participation: at least this many questions answered in the session. */
export const MINIGAME_MIN_ANSWERED = 5;

export function minigameReward (accuracy: number)
{
    const a = Number.isFinite(accuracy) ? Math.max(0, Math.min(1, accuracy)) : 0;
    // Round to whole percent first so 0.7999 (79.99 %) is not mistaken for 80 %.
    const pct = Math.floor(a * 100 + 1e-9) / 100;
    const tier = MINIGAME_TIERS.find((t) => pct >= t.minAccuracy)!;
    return { baseXp: tier.xp, crystals: tier.crystals };
}

/** Dungeon chests always pay this many crystals. */
export const CHEST_CRYSTALS = 10;

// ---------------------------------------------------------------- stats

export type StatId = 'health' | 'sword' | 'bow' | 'staff';
export const STAT_IDS: StatId[] = ['health', 'sword', 'bow', 'staff'];
export const STAT_LABELS: Record<StatId, string> = { health: 'Health', sword: 'Sword', bow: 'Bow', staff: 'Staff' };

export const STATS = {
    pointsPerLevel: 3,
    baseHp: 50,
    hpPerPoint: 5,
    /** Weapon damage multiplier: +3 % per point up to 20 points, +1 % after, capped. */
    perPointEarly: 0.03,
    earlyPoints: 20,
    perPointLate: 0.01,
    damageCap: 2.25,
} as const;

export const maxHpFor = (healthPoints: number) => STATS.baseHp + STATS.hpPerPoint * Math.max(0, Math.floor(healthPoints));

export function damageMultiplier (points: number)
{
    const p = Math.max(0, Math.floor(points));
    return Math.min(STATS.damageCap, 1 + STATS.perPointEarly * Math.min(p, STATS.earlyPoints) + STATS.perPointLate * Math.max(p - STATS.earlyPoints, 0));
}

/** Stat points a player at `level` has earned in total (dev grants are added separately). */
export const pointsEarned = (level: number) => STATS.pointsPerLevel * (Math.max(1, Math.floor(level)) - 1);

// ---------------------------------------------------------------- weapons

export type WeaponId = 'sword' | 'bow' | 'staff';

/**
 * Base weapon numbers (before stat points). Enemy HP was doubled when these replaced the old
 * item weapons (Wooden Sword 5 dmg / 420 ms), keeping sword time-to-kill close to before.
 */
export const WEAPON = {
    sword: { damage: 12, cooldownMs: 450, reach: 30, arc: 1.3 },
    bow: { damage: 14, cooldownMs: 550, speed: 250, range: 260 },
    staff: { damage: 9, cooldownMs: 700, speed: 210, range: 230 },
} as const;

/** Regenerating ranged resources (no inventory ammo). */
export const ARROWS = { max: 8, cost: 1, regenPerSecond: 1 / 3.5 } as const;
export const MANA = { max: 30, cost: 6, regenPerSecond: 2 } as const;

/** Staff explosion: secondary targets in `radius` px (about 1.5 tiles) take `ratio` of the hit. */
export const SPLASH = { radius: 24, ratio: 0.55, maxSecondary: 4 } as const;

export interface Allocation
{
    health: number;
    sword: number;
    bow: number;
    staff: number;
}

/** Damage to one decimal, so every single stat point changes the weapon (12 -> 12.4 -> 12.7...). */
const tenth = (n: number) => Math.round(n * 10) / 10;

/** Per-hit damage of a weapon with its stat points (at least 1). */
export const weaponDamage = (weapon: WeaponId, points: number) => Math.max(1, tenth(WEAPON[weapon].damage * damageMultiplier(points)));

/** Everything combat reads, from the player's allocation. Only the matching stat changes a weapon. */
export function combatStats (alloc: Allocation)
{
    return {
        maxHp: maxHpFor(alloc.health),
        swordDamage: weaponDamage('sword', alloc.sword),
        bowDamage: weaponDamage('bow', alloc.bow),
        staffDamage: weaponDamage('staff', alloc.staff),
        staffSplashDamage: Math.max(1, tenth(weaponDamage('staff', alloc.staff) * SPLASH.ratio)),
    };
}

// ---------------------------------------------------------------- combat models (balance checks)

/** Damage per second while attacking as fast as possible (resources ignored). */
export const burstDps = (damage: number, cooldownMs: number) => damage / (cooldownMs / 1000);

/** Long-fight DPS of a resource weapon: limited by cooldown or by regeneration, whichever is lower. */
export const sustainableDps = (damage: number, cooldownMs: number, regenPerSecond: number, cost: number) =>
    damage * Math.min(1000 / cooldownMs, regenPerSecond / cost);

/**
 * Seconds to deal `hp` damage, spending the full starting pool at burst speed first, then at the
 * sustainable rate (Infinity regen for the sword).
 */
export function timeToKill (hp: number, damage: number, cooldownMs: number, resource?: { max: number; cost: number; regenPerSecond: number })
{
    const hits = Math.ceil(hp / damage);
    if (!resource) return (hits - 1) * (cooldownMs / 1000);
    const cd = cooldownMs / 1000;
    let t = 0;
    let pool = resource.max;
    for (let i = 0; i < hits; i++)
    {
        if (pool < resource.cost) { const wait = (resource.cost - pool) / resource.regenPerSecond; t += wait; pool += wait * resource.regenPerSecond; }
        pool -= resource.cost;
        if (i < hits - 1) { t += cd; pool = Math.min(resource.max, pool + cd * resource.regenPerSecond); }
    }
    return t;
}
