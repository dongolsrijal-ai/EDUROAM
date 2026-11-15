// Picks the fixed parameters of a new tower run (no Phaser): seed, biome, number of floors.
// Dev overrides (biome / floors / seed) come from the dev panel.

import { dungeonRun, type DungeonRunState, type RunOptions } from '../../state/dungeonRun';
import { player } from '../../state/playerState';
import { tower } from '../../state/tower';
import { pickBiome, type BiomeId } from './biomes';
import type { Marker } from './build';

export interface RunOverrides
{
    seed?: number;
    biomeId?: BiomeId;
    floorCount?: 2 | 3;
}

/** Share of runs that are short (2 floors instead of 3). */
export const TWO_FLOOR_CHANCE = 0.35;

export function newRunOptions (random: () => number, lastBiome: string | null, towerLevel: number, overrides: RunOverrides = {}): RunOptions
{
    return {
        seed: overrides.seed ?? Math.floor(random() * 2 ** 31),
        biomeId: overrides.biomeId ?? pickBiome(random, lastBiome),
        floorCount: overrides.floorCount ?? (random() < TWO_FLOOR_CHANCE ? 2 : 3),
        towerLevel,
    };
}

/** dungeonRun floor id of procedural tower runs (older single-floor saves used 'floor-1'). */
export const TOWER_RUN = 'tower';

/** Repair a closed-tab interruption between the run save and the tower save. */
export function reconcileTowerProgress ()
{
    const run = dungeonRun.state;
    if (run.active && run.floorId === TOWER_RUN && run.towerLevel > tower.state.towerLevel) return tower.setLevel(run.towerLevel);
    // The victory XP is paid once per run id: repairs a tab closed right after the portal.
    if (!run.active && run.completed && run.paysXp) player.awardDungeonCompletion(run.runId, run.floorId === TOWER_RUN ? run.towerLevel : tower.state.towerLevel);
    if (!run.active && run.completed && run.runId !== tower.state.lastCompletedRunId)
    {
        return tower.recordCompletion(run.runId, run.floorId === TOWER_RUN ? run.towerLevel : tower.state.towerLevel);
    }
    return true;
}

/** Legacy single-floor rewards retain the exact identity stored in their delivery receipts. */
export function chestIdForMarker (run: Readonly<DungeonRunState>, marker: Marker)
{
    if (run.floorId === 'floor-1')
    {
        const prefix = marker.type === 'finalChest' ? 'floor-1:treasure:' : 'floor-1:pillars:';
        return Object.keys(run.chests).find((id) => id.startsWith(prefix))
            ?? `${prefix}${marker.type === 'finalChest' ? '37,13' : '28,1'}`;
    }
    return `floor${run.floorIndex}:${marker.roomId}:${marker.x},${marker.y}`;
}

/**
 * Starts a new tower run (random seed / biome / length at the current tower level) or resumes the
 * active one. `overrides` (dev panel) always start a fresh run.
 */
export function beginTowerRun (overrides?: RunOverrides)
{
    const run = dungeonRun.state;
    // Keep a completed run's recovery record until its tower progression is saved.
    // Active-run recovery belongs to Boot; explicit dev level overrides must still apply here.
    if (!run.active && !reconcileTowerProgress()) return false;
    // Legacy active runs keep their identity and pending chest receipts as well.
    if (run.active && !overrides) return dungeonRun.start(run.floorId);
    const options = newRunOptions(Math.random, tower.state.lastBiome, tower.state.towerLevel, overrides);
    const started = overrides ? dungeonRun.replace(TOWER_RUN, options) : dungeonRun.start(TOWER_RUN, options);
    if (!started) return false;
    tower.setLastBiome(options.biomeId);
    return true;
}
