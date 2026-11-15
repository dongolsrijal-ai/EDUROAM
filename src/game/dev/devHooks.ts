// The active world scene, as seen by the dev panel (dev builds only; WorldScene registers itself).

import type { EnemyTypeId } from '../combat/enemyTypes';

export interface DevScene
{
    readonly sceneKey: string;
    setInputEnabled (enabled: boolean): void;
    devGoTo (key: 'Hub' | 'Dungeon'): void;
    /** Dungeon only. */
    /** False if no safe spot was found. */
    devSpawn? (id: EnemyTypeId): boolean;
    /** Number of enemies defeated. */
    devKillAll? (): number;
    devToBoss? (): void;
    /** Refill the arrow or mana pool (combat maps). False outside combat. */
    devRefill? (pool: 'arrows' | 'mana'): boolean;
}

export const devHooks: { scene: DevScene | null } = { scene: null };
