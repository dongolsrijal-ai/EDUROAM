// ENCOUNTER COMPOSITION (no Phaser): which enemies each wave of a combat room spawns.
// Seeded per room so a death retry or refresh replays the same fight. Difficulty grows through
// variety (new archetypes unlock by floor / tower level) and a slowly growing threat budget.

import { ENEMY_TYPES, isUnlocked, ROLLABLE_ENEMIES, type EnemyTypeId } from '../../combat/enemyTypes';
import { waveBudget, wavesPerRoom, type ScaleContext } from '../../combat/scaling';
import { seededRandom } from '../../random';
import type { BiomeDef } from './biomes';

/** Most enemies alive at once from one wave (keeps fights readable). */
export const MAX_WAVE_SIZE = 5;

const hash = (text: string) =>
{
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
};

/** Enemy type ids per wave for one room. */
export function rollRoomWaves (seed: number, roomKey: string, biome: BiomeDef, ctx: ScaleContext, spawnSlots: number): EnemyTypeId[][]
{
    const rand = seededRandom((seed ^ hash(roomKey)) >>> 0);
    const allowed = ROLLABLE_ENEMIES.filter((id) => (biome.enemyWeights[id] ?? 0) > 0 && isUnlocked(ENEMY_TYPES[id], ctx.floorIndex, ctx.towerLevel));
    const maxSize = Math.max(1, Math.min(MAX_WAVE_SIZE, spawnSlots));
    const waves: EnemyTypeId[][] = [];

    for (let w = 0; w < wavesPerRoom(ctx); w++)
    {
        let budget = waveBudget(ctx) + w; // later waves are a little bigger
        const wave: EnemyTypeId[] = [];
        while (wave.length < maxSize)
        {
            const affordable = allowed.filter((id) => ENEMY_TYPES[id].threat <= budget);
            if (!affordable.length) break;
            const total = affordable.reduce((sum, id) => sum + (biome.enemyWeights[id] ?? 0), 0);
            let roll = rand() * total;
            const id = affordable.find((t) => (roll -= biome.enemyWeights[t] ?? 0) < 0) ?? affordable[affordable.length - 1];
            wave.push(id);
            budget -= ENEMY_TYPES[id].threat;
        }
        if (!wave.length) wave.push('zombie');
        waves.push(wave);
    }
    return waves;
}
