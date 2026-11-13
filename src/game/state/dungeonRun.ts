// DUNGEON RUN STATE: progress through a dungeon floor, shared by every floor/boss.
//
// Completion framework (same for future floors):
//   1. start()            entering starts (or resumes) a run; the entrance seals behind you
//   2. defeatGuardian()   the floor's guardian/boss is beaten
//   3. openChest(final)   the final treasure chest is opened (reward granted once)
//   4. exitUnlocked       = guardianDefeated && finalChestOpened -> exit portal appears
//   5. complete()         leaving through the portal marks the floor completed
// Death -> retryAfterDeath(): HP refilled, guardian back, but already-claimed chests stay
// claimed (no duplicate rewards) and nothing is awarded for dying.
//
// Saved in localStorage "eduroam.dungeon" so a page refresh resumes the run (the dungeon
// stays sealed) and opened chests are never re-rolled.

import { PLAYER_MAX_HP } from '../config';
import { isItemId, type ItemId } from '../items/itemDefs';
import { player } from './playerState';

const STORAGE_KEY = 'eduroam.dungeon';
const SCHEMA_VERSION = 1;

export interface ChestRecord
{
    itemId: ItemId;
    /** Items still waiting to go into the bag (0 once fully granted). */
    qty: number;
    /** False while the reward is rolled but not yet in the bag (e.g. bag full). */
    granted: boolean;
}

export interface DungeonRunState
{
    floorId: string;
    /** A run is in progress: the player belongs in the dungeon until it is completed. */
    active: boolean;
    /** The last run on this floor was finished through the exit. */
    completed: boolean;
    guardianDefeated: boolean;
    finalChestOpened: boolean;
    exitUnlocked: boolean;
    /** Player health during the run. */
    hp: number;
    /** Opened chests this run, by chest id. */
    chests: Record<string, ChestRecord>;
    stats: { runs: number; deaths: number; completions: number };
}

type Listener = (state: Readonly<DungeonRunState>) => void;
const listeners = new Set<Listener>();
let state: DungeonRunState = load();

const freshRun = (floorId: string, previous: DungeonRunState): DungeonRunState => ({
    floorId,
    active: true,
    completed: false,
    guardianDefeated: false,
    finalChestOpened: false,
    exitUnlocked: false,
    hp: PLAYER_MAX_HP,
    chests: {},
    stats: { ...previous.stats, runs: previous.stats.runs + 1 },
});

export const dungeonRun = {
    get state (): Readonly<DungeonRunState>
    {
        return state;
    },

    maxHp: PLAYER_MAX_HP,

    /** Starts a new run, or resumes the active one (e.g. after a page refresh). */
    start (floorId: string)
    {
        if (!state.active || state.floorId !== floorId) state = freshRun(floorId, state);
        else if (state.hp <= 0) return dungeonRun.retryAfterDeath(); // died, then refreshed
        commit();
    },

    defeatGuardian ()
    {
        if (state.guardianDefeated) return;
        state.guardianDefeated = true;
        updateExit();
        commit();
    },

    /**
     * Opens a chest once. The reward is rolled and saved BEFORE it is added to the bag, so a
     * refresh can never roll it twice; if the bag was full it stays pending (granted: false)
     * and opening again just retries the grant.
     */
    openChest (chestId: string, isFinal: boolean, roll: () => { itemId: ItemId; qty: number }):
        { record: ChestRecord; grantedQty: number }
    {
        let record = state.chests[chestId];
        if (!record)
        {
            const reward = roll();
            record = { ...reward, granted: false };
            state.chests[chestId] = record;
            commit();
        }
        const grantedQty = grant(record);
        if (isFinal && record.granted) state.finalChestOpened = true;
        updateExit();
        commit();
        return { record, grantedQty };
    },

    damage (amount: number): number
    {
        state.hp = Math.max(0, state.hp - amount);
        commit();
        return state.hp;
    },

    /** Returns HP actually restored (never above max). */
    heal (amount: number): number
    {
        const before = state.hp;
        state.hp = Math.min(PLAYER_MAX_HP, state.hp + amount);
        commit();
        return state.hp - before;
    },

    /** Same run continues from the entrance: full HP, guardian back, claimed chests stay claimed. */
    retryAfterDeath ()
    {
        state.hp = PLAYER_MAX_HP;
        state.guardianDefeated = false;
        state.stats.deaths++;
        updateExit();
        commit();
    },

    /** Left through the exit portal: floor completed, the next visit is a fresh run. */
    complete ()
    {
        if (!state.exitUnlocked) return false;
        state = { ...state, active: false, completed: true, stats: { ...state.stats, completions: state.stats.completions + 1 } };
        commit();
        return true;
    },

    subscribe (fn: Listener)
    {
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    },
};

/** Moves a chest's pending items into the bag. Returns how many went in (0 if the bag is full). */
function grant (record: ChestRecord): number
{
    if (record.granted) return 0;
    const left = player.addItem(record.itemId, record.qty);
    const granted = record.qty - left;
    record.qty = left;
    record.granted = left === 0;
    return granted;
}

function updateExit ()
{
    state.exitUnlocked = state.guardianDefeated && state.finalChestOpened;
}

function commit ()
{
    try
    {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, ...state }));
    }
    catch (err)
    {
        console.warn('[dungeonRun] Dungeon progress could not be saved.', err);
    }
    listeners.forEach((fn) => fn(state));
}

function load (): DungeonRunState
{
    const empty: DungeonRunState = {
        floorId: '', active: false, completed: false, guardianDefeated: false, finalChestOpened: false,
        exitUnlocked: false, hp: PLAYER_MAX_HP, chests: {}, stats: { runs: 0, deaths: 0, completions: 0 },
    };
    let text: string | null = null;
    try { text = localStorage.getItem(STORAGE_KEY); }
    catch { return empty; }
    if (!text) return empty;

    try
    {
        const r = JSON.parse(text);
        if (r?.version !== SCHEMA_VERSION) throw new Error(`Unsupported version ${r?.version}`);
        const bool = (v: unknown) => v === true;
        const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

        const chests: Record<string, ChestRecord> = {};
        for (const [id, c] of Object.entries(r.chests && typeof r.chests === 'object' ? r.chests : {}))
        {
            const rec = c as Record<string, unknown>;
            if (isItemId(rec?.itemId) && num(rec.qty, 0) >= 0) chests[id] = { itemId: rec.itemId, qty: Math.floor(num(rec.qty, 0)), granted: bool(rec.granted) };
        }
        const loaded: DungeonRunState = {
            floorId: typeof r.floorId === 'string' ? r.floorId : '',
            active: bool(r.active),
            completed: bool(r.completed),
            guardianDefeated: bool(r.guardianDefeated),
            finalChestOpened: bool(r.finalChestOpened),
            exitUnlocked: false,
            hp: Math.min(PLAYER_MAX_HP, Math.max(0, num(r.hp, PLAYER_MAX_HP))),
            chests,
            stats: {
                runs: num(r.stats?.runs, 0), deaths: num(r.stats?.deaths, 0), completions: num(r.stats?.completions, 0),
            },
        };
        loaded.exitUnlocked = loaded.guardianDefeated && loaded.finalChestOpened;
        return loaded;
    }
    catch (err)
    {
        console.warn(`[dungeonRun] Saved dungeon progress could not be read; kept a copy in "${STORAGE_KEY}.backup".`, err);
        try { localStorage.setItem(`${STORAGE_KEY}.backup`, text); } catch { /* ignore */ }
        return empty;
    }
}
