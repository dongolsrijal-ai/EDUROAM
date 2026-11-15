// ENEMY ROSTER as data (no Phaser): stats are the tower level 1 / floor 1 baseline and are scaled
// by combat/scaling.ts. HP was doubled when the permanent Sword / Bow / Staff replaced the old item
// weapons (progression/balance.ts WEAPON): sword time-to-kill stays close to before. XP rewards
// per type live in progression/balance.ts ENEMY_XP. Behaviour code lives in combat/Enemy.ts (+ Hades.ts for the boss).
//
// Hit areas (relative to the sprite, whose origin is its feet):
//   body     small MOVEMENT box at the feet (offset from the sprite's top-left)
//   hurtbox  visible body that attacks must touch (w x h, standing `bottom` px above the feet)

export type EnemyTypeId = 'zombie' | 'goblin' | 'wizard' | 'giant' | 'reaper' | 'skeleton' | 'hades';

export type Behavior = 'chaser' | 'caster' | 'tank' | 'summoner' | 'boss';

export interface EnemyType
{
    id: EnemyTypeId;
    name: string;
    texture: string;
    /** Sprite size (square). */
    size: number;
    behavior: Behavior;
    hp: number;
    /** Main attack damage (spell, slam, sweep...) before scaling and armor. */
    damage: number;
    /** Damage when touching the player. */
    contactDamage: number;
    contactCooldownMs: number;
    /** px / s */
    speed: number;
    /** Encounter cost (see waveBudget). 0 = never rolled directly (summons, bosses). */
    threat: number;
    /** Appears from this floor of a run... */
    minFloor: number;
    /** ...or from this tower level, whichever comes first. */
    minTowerLevel: number;
    body: { w: number; h: number; x: number; y: number };
    hurtbox: { w: number; h: number; bottom?: number };
    /** Heavy enemies are not shoved around by the player or each other. */
    heavy?: boolean;
    caster?: { minRange: number; maxRange: number; castMs: number; cooldownMs: number; projectileSpeed: number };
    tank?: { triggerRange: number; windupMs: number; radius: number; recoverMs: number; cooldownMs: number };
    summoner?: { castMs: number; cooldownMs: number; perCast: number; maxActive: number };
}

const SMALL_BODY = { w: 12, h: 7, x: 6, y: 17 };

export const ENEMY_TYPES: Record<EnemyTypeId, EnemyType> = {
    zombie: {
        id: 'zombie', name: 'Zombie', texture: 'enemy-zombie', size: 24, behavior: 'chaser',
        hp: 32, damage: 5, contactDamage: 5, contactCooldownMs: 900, speed: 34, threat: 2, minFloor: 1, minTowerLevel: 1,
        body: SMALL_BODY, hurtbox: { w: 14, h: 21, bottom: 1 },
    },
    goblin: {
        id: 'goblin', name: 'Goblin', texture: 'enemy-goblin', size: 24, behavior: 'chaser',
        hp: 20, damage: 3, contactDamage: 3, contactCooldownMs: 550, speed: 64, threat: 1, minFloor: 1, minTowerLevel: 1,
        body: SMALL_BODY, hurtbox: { w: 14, h: 18, bottom: 1 },
    },
    wizard: {
        id: 'wizard', name: 'Wizard', texture: 'enemy-wizard', size: 24, behavior: 'caster',
        hp: 24, damage: 4, contactDamage: 2, contactCooldownMs: 900, speed: 24, threat: 3, minFloor: 2, minTowerLevel: 2,
        body: SMALL_BODY, hurtbox: { w: 14, h: 22, bottom: 1 },
        caster: { minRange: 64, maxRange: 130, castMs: 650, cooldownMs: 1900, projectileSpeed: 72 },
    },
    giant: {
        id: 'giant', name: 'Giant', texture: 'enemy-giant', size: 32, behavior: 'tank', heavy: true,
        hp: 90, damage: 8, contactDamage: 3, contactCooldownMs: 1000, speed: 15, threat: 6, minFloor: 2, minTowerLevel: 3,
        body: { w: 18, h: 10, x: 7, y: 21 }, hurtbox: { w: 24, h: 29, bottom: 1 },
        tank: { triggerRange: 30, windupMs: 850, radius: 30, recoverMs: 1100, cooldownMs: 1600 },
    },
    reaper: {
        id: 'reaper', name: 'Soul Reaper', texture: 'enemy-reaper', size: 24, behavior: 'summoner',
        hp: 48, damage: 6, contactDamage: 3, contactCooldownMs: 900, speed: 20, threat: 5, minFloor: 3, minTowerLevel: 3,
        body: SMALL_BODY, hurtbox: { w: 16, h: 21, bottom: 2 },
        summoner: { castMs: 800, cooldownMs: 4800, perCast: 2, maxActive: 3 },
    },
    skeleton: {
        id: 'skeleton', name: 'Skeleton', texture: 'enemy-skeleton', size: 24, behavior: 'chaser',
        hp: 1, damage: 2, contactDamage: 2, contactCooldownMs: 700, speed: 48, threat: 0, minFloor: 99, minTowerLevel: 99,
        body: SMALL_BODY, hurtbox: { w: 12, h: 19, bottom: 1 },
    },
    hades: {
        id: 'hades', name: 'Hades, King of the Dead', texture: 'boss-hades', size: 48, behavior: 'boss', heavy: true,
        hp: 300, damage: 8, contactDamage: 5, contactCooldownMs: 1000, speed: 22, threat: 0, minFloor: 99, minTowerLevel: 99,
        body: { w: 24, h: 12, x: 12, y: 35 }, hurtbox: { w: 32, h: 42, bottom: 2 },
    },
};

/** Enemies that room waves may roll (summons and bosses are excluded). */
export const ROLLABLE_ENEMIES = (Object.keys(ENEMY_TYPES) as EnemyTypeId[]).filter((id) => ENEMY_TYPES[id].threat > 0);

export const isUnlocked = (type: EnemyType, floorIndex: number, towerLevel: number) =>
    floorIndex >= type.minFloor || towerLevel >= type.minTowerLevel;
