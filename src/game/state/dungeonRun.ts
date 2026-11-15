// DUNGEON RUN STATE: progress through a dungeon run, shared by every floor/boss.
//
// Tower runs (Hub entrance): a seeded run of 2-3 procedural floors in one biome. The seed,
// biome, floor count and tower level are fixed when the run starts and saved, so a refresh or a
// death retry rebuilds exactly the same floor. Cleared combat rooms are remembered per floor.
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
// Max HP comes from the player's Health points (progression/balance.ts maxHpFor) and is read
// live: spending a Health point raises the maximum without healing; refunding points clamps HP.
//
// `paysXp`: only normal runs started by this version pay XP (kills + the victory bonus). Runs
// started or touched by development tools (dev runs, teleports, kill-all, spawns) and runs saved
// before XP existed never pay, so dev shortcuts and old saves cannot grant XP retroactively.
//
// Migration (same version 1, additive fields): saves without `runId` get a new one; chest
// records without `total` use their pending `qty` as what is still owed (granted chests: 0,
// already paid). An interruption that happened before receipts existed (items added, chest
// still pending) cannot be told apart from a genuinely pending reward, so it stays pending.
// Chests that paid a removed weapon item stay opened and paid (recorded as 0 crystals), so a
// migrated save can never open them again.

import { scopedKey, writeJson } from '../data/storage';
import { isItemId, isLegacyWeaponItem, type ItemId } from '../items/itemDefs';
import { maxHpFor } from '../progression/balance';
import { CURRENCY } from '../shop/catalog';
import { claimChestReward, onPlayerStateChange, player } from './playerState';

/** Current maximum HP (50 + 5 per Health point). */
const maxHp = () => maxHpFor(player.progress.alloc.health);

/** This account's own copy (see data/storage.ts ACCOUNT_SCOPED_KEYS). */
const STORAGE_KEY = scopedKey('eduroam.dungeon');
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
    /** Layout seed of this run (replays the same floors). */
    seed: number;
    biomeId: string;
    /** Current floor (1-based) and how many floors this run has. */
    floorIndex: number;
    floorCount: number;
    /** Tower level when the run started (enemy scaling stays fixed for the whole run). */
    towerLevel: number;
    /** Combat rooms already cleared on the current floor. */
    clearedRooms: string[];
    startedAt: number;
    /** Kills and the victory bonus of this run pay XP (false: dev-touched or pre-XP run). */
    paysXp: boolean;
}

/** Fixed when a tower run starts. */
export interface RunOptions
{
    seed: number;
    biomeId: string;
    floorCount: number;
    towerLevel: number;
}

type Listener = (state: Readonly<DungeonRunState>) => void;
const listeners = new Set<Listener>();
let state: DungeonRunState = load();

// Health points changed (spent or refunded): keep HP valid and let the health bar redraw.
let lastMax = maxHp();
onPlayerStateChange(() =>
{
    const max = maxHp();
    if (max === lastMax) return;
    lastMax = max;
    if (state.hp > max) state.hp = max;
    commit();
});

function newRunId ()
{
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    return `run_${random}`;
}

const freshRun = (floorId: string, previous: DungeonRunState, options?: RunOptions, dev = false): DungeonRunState => ({
    runId: newRunId(),
    floorId,
    active: true,
    completed: false,
    guardianDefeated: false,
    finalChestOpened: false,
    exitUnlocked: false,
    hp: maxHp(),
    chests: {},
    stats: { ...previous.stats, runs: previous.stats.runs + 1 },
    seed: options?.seed ?? 1,
    biomeId: options?.biomeId ?? 'crypt',
    floorIndex: 1,
    floorCount: Math.max(1, Math.min(3, options?.floorCount ?? 1)),
    towerLevel: Math.max(1, options?.towerLevel ?? 1),
    clearedRooms: [],
    startedAt: Date.now(),
    paysXp: !dev,
});

export const dungeonRun = {
    get state (): Readonly<DungeonRunState>
    {
        return state;
    },

    get maxHp (): number
    {
        return maxHp();
    },

    /** Starts a new run, or resumes the active one (e.g. after a page refresh). */
    start (floorId: string, options?: RunOptions)
    {
        if (!state.active || state.floorId !== floorId) return publish(freshRun(floorId, state, options));
        if (state.hp <= 0) return dungeonRun.retryAfterDeath(); // died, then refreshed
        return publish(state);
    },

    /** Replaces a run for development without ever completing or rewarding the old one (pays no XP). */
    replace (floorId: string, options: RunOptions)
    {
        return publish(freshRun(floorId, state, options, true));
    },

    /** A dev tool touched this run (teleport, kill-all, spawn): it pays no XP from now on. */
    markDev ()
    {
        if (!state.active || !state.paysXp) return;
        state.paysXp = false;
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

    /** A combat room's waves are all defeated: its doors stay open (also after refresh / retry). */
    clearRoom (roomId: string)
    {
        if (state.clearedRooms.includes(roomId)) return;
        state.clearedRooms = [...state.clearedRooms, roomId];
        commit();
    },

    isRoomCleared: (roomId: string) => state.clearedRooms.includes(roomId),

    /** Took the portal on a non-final floor: next floor, fresh rooms. Returns false on the final floor. */
    advanceFloor (): boolean
    {
        if (!state.active || state.floorIndex >= state.floorCount) return false;
        return publish({ ...state, floorIndex: state.floorIndex + 1, clearedRooms: [],
            guardianDefeated: false, finalChestOpened: false, exitUnlocked: false });
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
        state.hp = Math.min(maxHp(), state.hp + amount);
        commit();
        return state.hp - before;
    },

    /** Same run continues from the current floor's entrance: full HP, its rooms and guardian back,
     *  claimed chests stay claimed (never paid twice). */
    retryAfterDeath ()
    {
        return publish({ ...state, hp: maxHp(), guardianDefeated: false, exitUnlocked: false,
            clearedRooms: [], stats: { ...state.stats, deaths: state.stats.deaths + 1 } });
    },

    /** Left through the exit portal: floor completed, the next visit is a fresh run. */
    complete ()
    {
        if (!state.active || !state.exitUnlocked || state.floorIndex !== state.floorCount) return false;
        return publish({ ...state, active: false, completed: true, stats: { ...state.stats, completions: state.stats.completions + 1 } });
    },

    /** Drops the active run without completing it (dev tools: replay a seed / restart). Rewards
     *  already delivered stay delivered; the next start() is a fresh run with a new runId. */
    abandon ()
    {
        if (!state.active) return;
        state = { ...state, active: false };
        commit();
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

/** Publish lifecycle changes only after they are durable. Failed transitions remain retryable. */
function publish (next: DungeonRunState): boolean
{
    if (!writeJson(STORAGE_KEY, { version: SCHEMA_VERSION, ...next })) return false;
    state = next;
    listeners.forEach((fn) => fn(state));
    return true;
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
        exitUnlocked: false, hp: maxHp(), chests: {}, stats: { runs: 0, deaths: 0, completions: 0 },
        seed: 1, biomeId: 'crypt', floorIndex: 1, floorCount: 1, towerLevel: 1, clearedRooms: [], startedAt: 0, paysXp: false,
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
            // A chest that paid a removed weapon item: keep it opened and paid, never re-openable.
            if (isLegacyWeaponItem(rec?.itemId)) { chests[id] = { itemId: CURRENCY, total: 0, qty: 0, granted: true }; continue; }
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
            hp: Math.min(maxHp(), Math.max(0, num(r.hp, maxHp()))),
            chests,
            stats: {
                runs: num(r.stats?.runs, 0), deaths: num(r.stats?.deaths, 0), completions: num(r.stats?.completions, 0),
            },
            // Tower-run fields (older saves get single-floor defaults).
            seed: Number.isInteger(r.seed) ? r.seed : 1,
            biomeId: typeof r.biomeId === 'string' ? r.biomeId : 'crypt',
            floorCount: Math.max(1, Math.min(3, Number.isInteger(r.floorCount) ? r.floorCount : 1)),
            floorIndex: 1,
            towerLevel: Math.max(1, Number.isInteger(r.towerLevel) ? r.towerLevel : 1),
            clearedRooms: Array.isArray(r.clearedRooms) ? r.clearedRooms.filter((id: unknown): id is string => typeof id === 'string') : [],
            startedAt: num(r.startedAt, 0),
            paysXp: bool(r.paysXp),
        };
        loaded.floorIndex = Math.max(1, Math.min(loaded.floorCount, Number.isInteger(r.floorIndex) ? r.floorIndex : 1));
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
