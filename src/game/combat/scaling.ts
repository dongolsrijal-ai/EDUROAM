// CENTRAL DIFFICULTY + REWARD SCALING. Every number that grows with progress lives here.
//
// Inputs: the persistent tower level (1, 2, 3... grows by one per completed run) and the floor
// inside the current run (1-based). Multipliers are gentle and capped so enemies never become
// impossible; difficulty mainly rises through enemy VARIETY (see world/dungeon/encounters.ts).
//
// Balance reference (player at tower level 1, no stat points): 50 HP, defense 2 (Cloth Armor:
// damage - 2, min 1), Sword 12 dmg / 450 ms, Bow 14 dmg / 550 ms (8 arrows), Staff 9 dmg + splash
// / 700 ms (30 mana), 3 Small Potions (+10 HP). See progression/balance.ts.

export const SCALING = {
    hp: { perLevel: 0.06, perFloor: 0.08, cap: 2.5 },
    damage: { perLevel: 0.04, perFloor: 0.05, cap: 2.0 },
    boss: { hpPerLevel: 0.07, hpCap: 2.6, damagePerLevel: 0.035, damageCap: 1.8 },
};

export interface ScaleContext
{
    towerLevel: number;
    /** 1-based floor inside the run. */
    floorIndex: number;
}

const clampLevel = (n: number) => Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));

export function enemyMultipliers ({ towerLevel, floorIndex }: ScaleContext, boss = false)
{
    const level = clampLevel(towerLevel) - 1;
    const floor = clampLevel(floorIndex) - 1;
    if (boss)
    {
        // The boss always sits on the final floor, so only the tower level scales it.
        return {
            hp: Math.min(SCALING.boss.hpCap, 1 + SCALING.boss.hpPerLevel * level),
            damage: Math.min(SCALING.boss.damageCap, 1 + SCALING.boss.damagePerLevel * level),
        };
    }
    return {
        hp: Math.min(SCALING.hp.cap, 1 + SCALING.hp.perLevel * level + SCALING.hp.perFloor * floor),
        damage: Math.min(SCALING.damage.cap, 1 + SCALING.damage.perLevel * level + SCALING.damage.perFloor * floor),
    };
}

/** Base stats -> scaled whole numbers (never below 1). */
export function scaleStats (base: { hp: number; damage: number }, ctx: ScaleContext, boss = false)
{
    const m = enemyMultipliers(ctx, boss);
    return { hp: Math.max(1, Math.round(base.hp * m.hp)), damage: Math.max(1, Math.round(base.damage * m.damage)) };
}

/** Damage the player actually takes: flat armor reduction, at least 1 (matches CombatController). */
export const damageAfterArmor = (raw: number, defense: number) => Math.max(1, Math.round(raw) - defense);

/**
 * Threat points one wave may spend on enemies (zombie = 2, goblin = 1, wizard = 3, giant = 6,
 * reaper = 5). Grows slowly with floor and tower level.
 */
export const waveBudget = ({ towerLevel, floorIndex }: ScaleContext) =>
    Math.min(18, 4 + 2 * (clampLevel(floorIndex) - 1) + Math.floor((clampLevel(towerLevel) - 1) / 2));

/** Waves per combat room: 1 on the first floor at low levels, up to 3 later. */
export const wavesPerRoom = ({ towerLevel, floorIndex }: ScaleContext) =>
    Math.min(3, 1 + (floorIndex >= 2 ? 1 : 0) + (towerLevel >= 5 ? 1 : 0));
