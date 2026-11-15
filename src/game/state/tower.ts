// PERSISTENT TOWER PROGRESS (separate from the current run's floor).
//
//   towerLevel   1 for a new player; +1 every time a dungeon run is completed through the exit
//   lastBiome    so the next run picks a different biome when one exists
//
// Completion is recorded by run id, so replaying it (refresh, double interaction, boot
// reconciliation) can never raise the level twice. Saved in localStorage "eduroam.tower".

import { readText, scopedKey, writeJson } from '../data/storage';

/** This account's own copy (see data/storage.ts ACCOUNT_SCOPED_KEYS). */
const STORAGE_KEY = scopedKey('eduroam.tower');
const SCHEMA_VERSION = 1;

export interface TowerState
{
    towerLevel: number;
    highestLevel: number;
    runsCompleted: number;
    lastBiome: string | null;
    lastCompletedRunId: string | null;
}

type Listener = (s: Readonly<TowerState>) => void;
const listeners = new Set<Listener>();
let state: TowerState = load();

export const tower = {
    get state (): Readonly<TowerState>
    {
        return state;
    },

    /** Records a completed run once. Returns true if the tower level went up. */
    recordCompletion (runId: string, completedLevel = state.towerLevel): boolean
    {
        if (!runId || runId === state.lastCompletedRunId) return false;
        const towerLevel = Math.max(state.towerLevel, completedLevel + 1);
        return commit({
            ...state,
            towerLevel,
            highestLevel: Math.max(state.highestLevel, towerLevel),
            runsCompleted: state.runsCompleted + 1,
            lastCompletedRunId: runId,
        });
    },

    setLastBiome (biomeId: string)
    {
        if (state.lastBiome === biomeId) return;
        commit({ ...state, lastBiome: biomeId });
    },

    /** Development override (dev panel / tests). */
    setLevel (level: number)
    {
        const towerLevel = Math.max(1, Math.floor(Number.isFinite(level) ? level : 1));
        return commit({ ...state, towerLevel, highestLevel: Math.max(state.highestLevel, towerLevel) });
    },

    subscribe (fn: Listener)
    {
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    },
};

function commit (next: TowerState)
{
    if (!writeJson(STORAGE_KEY, { version: SCHEMA_VERSION, ...next })) return false;
    state = next;
    listeners.forEach((fn) => fn(state));
    return true;
}

function load (): TowerState
{
    const fresh: TowerState = { towerLevel: 1, highestLevel: 1, runsCompleted: 0, lastBiome: null, lastCompletedRunId: null };
    const text = readText(STORAGE_KEY);
    if (!text) return fresh;
    try
    {
        const r = JSON.parse(text);
        if (r?.version !== SCHEMA_VERSION) throw new Error(`Unsupported version ${r?.version}`);
        const int = (v: unknown, min: number) => (Number.isInteger(v) && (v as number) >= min ? v as number : min);
        const towerLevel = int(r.towerLevel, 1);
        return {
            towerLevel,
            highestLevel: Math.max(towerLevel, int(r.highestLevel, 1)),
            runsCompleted: int(r.runsCompleted, 0),
            lastBiome: typeof r.lastBiome === 'string' ? r.lastBiome : null,
            lastCompletedRunId: typeof r.lastCompletedRunId === 'string' ? r.lastCompletedRunId : null,
        };
    }
    catch (err)
    {
        console.warn(`[tower] Saved tower progress could not be read; kept a copy in "${STORAGE_KEY}.backup".`, err);
        try { localStorage.setItem(`${STORAGE_KEY}.backup`, text); } catch { /* ignore */ }
        return fresh;
    }
}
