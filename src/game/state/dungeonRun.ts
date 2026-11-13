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
//
// Chest rewards are paid exactly once even if the page dies between two saves:
//   - every run has a saved `runId` (kept on refresh and death retry, new for a new run);
//     a chest's reward identity is runId + chestId.
//   - the rolled item + quantity are saved here BEFORE anything is delivered.
//   - delivery goes through claimChestReward(), which saves the items together with a receipt
//     (how much of that reward was delivered) in the player save. The receipt, not this
//     file's `qty`, decides what is still owed; `qty` / `granted` are repaired from it.
//
// Migration (same version 1, additive fields): saves without `runId` get a new one; chest
// records without `total` use their pending `qty` as what is still owed (granted chests: 0,
// already paid). An interruption that happened before receipts existed (items added, chest
// still pending) cannot be told apart from a genuinely pending reward, so it stays pending.

import { PLAYER_MAX_HP } from '../config';
import { writeJson } from '../data/storage';
import { isItemId, type ItemId } from '../items/itemDefs';
import { claimChestReward } from './playerState';

const STORAGE_KEY = 'eduroam.dungeon';
const SCHEMA_VERSION = 1;

export interface ChestRecord
{
    itemId: ItemId;
    /** Reward quantity owed by this chest (the rolled amount; for pre-receipt saves, what was still owed). */
    total: number;
    /** Items still waiting to go into the bag (0 once fully granted). */
    qty: number;
    /** False while the reward is rolled but not yet in the bag (e.g. bag full). */
    granted: boolean;
}

export type ChestOpenResult =
    /** Nothing was saved or awarded (storage full / blocked); pressing E again retries. */
    | { status: 'saveFailed' }
    /** `grantedQty` items went into the bag this time; `record` is the chest after delivery. */
    | { status: 'opened'; record: ChestRecord; grantedQty: number };

export interface DungeonRunState
{
    /** Identity of this run (chest reward ids are derived from it). */
    runId: string;
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

function newRunId ()
{
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    return `run_${random}`;
}

const freshRun = (floorId: string, previous: DungeonRunState): DungeonRunState => ({
    runId: newRunId(),
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
     * and opening again just retries the grant. Delivery is idempotent (see claimChestReward):
     * a retry after an interrupted save only adds what the receipt says is still owed.
     */
    openChest (chestId: string, isFinal: boolean, roll: () => { itemId: ItemId; qty: number }): ChestOpenResult
    {
        const isNew = !state.chests[chestId];
        if (isNew)
        {
            const { itemId, qty } = roll();
            state.chests[chestId] = { itemId, total: qty, qty, granted: false };
        }
        const record = state.chests[chestId];
        let grantedQty = 0;

        if (!record.granted)
        {
            // The receipt written below names this run + chest: the dungeon save must name them too.
            if (!persist())
            {
                if (isNew) delete state.chests[chestId]; // unsaved roll: forget it, never award it
                return { status: 'saveFailed' };
            }
            const claim = claimChestReward({ runId: state.runId, chestId, itemId: record.itemId, total: record.total });
            if (!claim.ok) return { status: 'saveFailed' };
            grantedQty = claim.added;
            record.qty = Math.max(0, record.total - claim.delivered);
            record.granted = record.qty === 0;
        }

        if (isFinal && record.granted) state.finalChestOpened = true;
        updateExit();
        commit(); // if this write is lost, the receipt repairs the chest on the next interaction
        return { status: 'opened', record, grantedQty };
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

function updateExit ()
{
    state.exitUnlocked = state.guardianDefeated && state.finalChestOpened;
}

/** Returns false if storage is full / blocked. */
function persist (): boolean
{
    return writeJson(STORAGE_KEY, { version: SCHEMA_VERSION, ...state });
}

function commit ()
{
    persist();
    listeners.forEach((fn) => fn(state));
}

function load (): DungeonRunState
{
    const empty: DungeonRunState = {
        runId: newRunId(), floorId: '', active: false, completed: false, guardianDefeated: false, finalChestOpened: false,
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
            if (!isItemId(rec?.itemId) || num(rec.qty, 0) < 0) continue;
            const qty = Math.floor(num(rec.qty, 0));
            // No `total`: saved before receipts existed, so the pending qty is all that is still owed.
            const total = Number.isInteger(rec.total) && (rec.total as number) >= qty ? rec.total as number : qty;
            chests[id] = { itemId: rec.itemId, total, qty, granted: bool(rec.granted) };
        }
        const loaded: DungeonRunState = {
            runId: typeof r.runId === 'string' && r.runId && !r.runId.includes('/') ? r.runId : newRunId(),
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
