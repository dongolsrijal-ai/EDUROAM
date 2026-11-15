// THE single source of player progress: inventory (backpack + equipment), claimed rewards, the
// crystal shop, and RPG progression (level, XP, stat points). Saved to localStorage; the rest of
// the game reads and changes it here.
//
// Save format (version 3):
//   { version, inventory: { backpack, equipment }, claimedChallenges: string[], starterKitGranted: boolean,
//     chestReceipts?: { [rewardId]: { itemId, total, delivered } } }
// `chestReceipts` is an additive, optional field (saves without it load with no receipts, and
// older builds simply ignore it), so it needs no version bump. So are:
//   shop         crystal shop progress (shop/catalog.ts ShopProgress): village unlocks + selections.
//                The crystal balance is the Number Crystals in the backpack.
//   progression  { level, xp, alloc: { health, sword, bow, staff }, bonusPoints, claims, runKill }
//                Unspent stat points are DERIVED (3 per level + dev bonus - allocated), never stored,
//                so they can never be duplicated by a reload. `claims` are reward ids already paid
//                (enemy kills, dungeon victories, mini-game sessions): each pays XP exactly once.
// Weapon migration (same version): the removed weapon items are dropped from the inventory, the
// shop's short-lived weapon purchases are refunded in crystals, and allocations of removed stats
// (Defense / Speed) become unspent points. The pre-migration text is kept as "...weapons-backup".
// Older saves are migrated automatically and the original text is kept as a backup:
//   v1 (Task 3: crystal counter)  -> "eduroam.player.v1-backup"
//   v2 (Task 4: had a hotbar; its items move into the backpack) -> "eduroam.player.v2-backup"


import { scopedKey, writeJson } from '../data/storage';
import { DEV } from '../dev/devFlags';
import {
    addItem, consumeEquipped, countItem, createEmptyInventory, discardItem, equipmentStats, firstEmptySlot, grantStarterKit,
    moveStack, removeItem, sanitizeInventory, type InventoryState, type ItemStack, type MoveResult, type SlotRef,
} from '../items/inventory';
import {
    addXp, combatStats, DUNGEON_COMPLETION_XP, ENEMY_XP, killBaseXp, MINIGAME_MIN_ANSWERED, minigameReward, pointsEarned, scaledXp,
    STAT_IDS, xpForLevel, xpToNext, type Allocation, type StatId,
} from '../progression/balance';
import { CURRENCY, emptyProgress, legacyWeaponRefund, sanitizeProgress, VILLAGE_ITEMS, type ShopProgress, type VillageItemId } from '../shop/catalog';
import type { EnemyTypeId } from '../combat/enemyTypes';
import { isItemId, isLegacyWeaponItem, type EquipSlot, type ItemId } from '../items/itemDefs';
import type { Challenge } from '../minigames/challenge';

/** This account's own copy (see data/storage.ts ACCOUNT_SCOPED_KEYS). */
const STORAGE_KEY = scopedKey('eduroam.player');
const SCHEMA_VERSION = 3;

/** How much of one dungeon chest reward has been put into the inventory (saved with the inventory). */
export interface ChestReceipt
{
    itemId: ItemId;
    /** Reward quantity owed by the chest. */
    total: number;
    /** Quantity already added to the inventory (never more than `total`). */
    delivered: number;
}

interface PlayerData
{
    inventory: InventoryState;
    claimedChallenges: Set<string>;
    starterKitGranted: boolean;
    /** Dungeon chest deliveries for the current run, by reward id (see chestRewardId). */
    chestReceipts: Record<string, ChestReceipt>;
    /** Crystal shop purchases (village items and selections). */
    shop: ShopProgress;
    progression: Progression;
}

interface Progression
{
    level: number;
    /** XP toward the next level (never lifetime XP). */
    xp: number;
    alloc: Allocation;
    /** Extra points from the DEV panel (counted like earned ones, so resets refund them). */
    bonusPoints: number;
    /** Reward ids already paid. Kill ids belong to one run and are dropped when the next run pays. */
    claims: string[];
    /** Kill XP of the current run in base units (the per-run kill budget, see balance.ts). */
    runKill: { runId: string; base: number };
}

/**
 * Outcome of a shop action. 'poor' = not enough crystals, 'owned' = already bought,
 * 'locked' = not owned / wrong slot, 'saveFailed' = storage refused the write (nothing was charged).
 */
export type ShopResult = 'ok' | 'poor' | 'owned' | 'locked' | 'saveFailed';

/** Result of an XP reward. 'claimed' = this reward id was already paid (nothing happens). */
export type XpAward =
    | { status: 'awarded'; xp: number; crystals: number; crystalsLost: number; level: number; levelsGained: number }
    | { status: 'claimed' | 'none' | 'saveFailed' };

const MAX_CLAIMS = 400;
const freshProgression = (): Progression => ({
    level: 1, xp: 0, alloc: { health: 0, sword: 0, bow: 0, staff: 0 }, bonusPoints: 0, claims: [], runKill: { runId: '', base: 0 },
});
const allocated = (a: Allocation) => a.health + a.sword + a.bow + a.staff;
const unspentOf = (p: Progression) => pointsEarned(p.level) + p.bonusPoints - allocated(p.alloc);

const listeners = new Set<() => void>();
let data: PlayerData;

/** Inventory access + actions. Read with `player.inventory`; change only through these methods. */
export const player = {
    get inventory (): Readonly<InventoryState>
    {
        return data.inventory;
    },

    move (from: SlotRef, to: SlotRef): MoveResult
    {
        const result = moveStack(data.inventory, from, to);
        if (result !== 'rejected' && result !== 'noop') commit();
        return result;
    },

    /** Moves an item into the first free bag slot. Returns false if the bag is full. */
    stash (from: SlotRef): boolean
    {
        const to = firstEmptySlot(data.inventory);
        return !!to && player.move(from, to) !== 'rejected';
    },

    /** Returns how many items did not fit. */
    addItem (itemId: ItemId, qty: number): number
    {
        const left = addItem(data.inventory, itemId, qty);
        if (left < qty) commit();
        return left;
    },

    /**
     * Discards `qty` items from the backpack stack at `ref` (see discardItem: equipped items and
     * stale confirmations are rejected). Staged on a copy and only made live once saved, so a
     * failed write keeps the item. Chest receipts are untouched: discarded rewards stay claimed.
     */
    discard (ref: SlotRef, expected: ItemStack, qty: number): 'discarded' | 'rejected' | 'saveFailed'
    {
        const inventory = structuredClone(data.inventory);
        if (!discardItem(inventory, ref, expected, qty)) return 'rejected';
        const next: PlayerData = { ...data, inventory };
        if (!save(next)) return 'saveFailed';
        data = next;
        listeners.forEach((fn) => fn());
        return 'discarded';
    },

    count: (itemId: ItemId) => countItem(data.inventory, itemId),

    /** Uses one item from an equipment slot (e.g. a potion). Returns false if the slot is empty. */
    consumeEquipped (slot: EquipSlot): boolean
    {
        const ok = consumeEquipped(data.inventory, slot);
        if (ok) commit();
        return ok;
    },

    /** Shared stats: equipment (armor defense, healing) + stat points (max HP, weapon damage). */
    stats: () => ({ ...equipmentStats(data.inventory), ...combatStats(data.progression.alloc) }),

    // ------------------------------------------------------------ progression

    get progress ()
    {
        const p = data.progression;
        return { level: p.level, xp: p.xp, xpToNext: xpToNext(p.level), unspent: unspentOf(p), alloc: { ...p.alloc } as Readonly<Allocation> };
    },

    isRewardClaimed: (id: string) => data.progression.claims.includes(id),

    /** Spends one unspent point on a stat. The effect (max HP, weapon damage) is immediate. */
    spendPoint (stat: StatId): 'ok' | 'none' | 'saveFailed'
    {
        if (!STAT_IDS.includes(stat) || unspentOf(data.progression) <= 0) return 'none';
        return stage((d) => { d.progression.alloc[stat]++; }) ? 'ok' : 'saveFailed';
    },

    /** XP for one defeated enemy, once per kill id. Summons (0 base XP) and dev kills never call this with XP. */
    awardKill (runId: string, killId: string, type: EnemyTypeId, towerLevel: number): XpAward
    {
        const base = ENEMY_XP[type] ?? 0;
        if (!base || !runId) return { status: 'none' };
        const id = `kill:${killId}`;
        return grant(id, (d) =>
        {
            // A new run: forget the previous run's kill ids and restart the kill budget.
            if (d.progression.runKill.runId !== runId)
            {
                d.progression.claims = d.progression.claims.filter((c) => !c.startsWith('kill:'));
                d.progression.runKill = { runId, base: 0 };
            }
            const xp = scaledXp(killBaseXp(base, d.progression.runKill.base), d.progression.level, towerLevel);
            d.progression.runKill.base += base;
            return { xp, crystals: 0 };
        });
    },

    /** The dungeon victory bonus, once per run (only called after the portal home completed the run). */
    awardDungeonCompletion (runId: string, towerLevel: number): XpAward
    {
        if (!runId) return { status: 'none' };
        return grant(`run:${runId}`, (d) => ({ xp: scaledXp(DUNGEON_COMPLETION_XP, d.progression.level, towerLevel), crystals: 0 }));
    },

    /**
     * XP + crystals for a finished, server-graded mini-game session, once per session id. Needs
     * meaningful participation (MINIGAME_MIN_ANSWERED). Crystals (1-5) never scale with level.
     */
    awardMinigame (sessionId: string, accuracy: number, answered: number): XpAward | { status: 'tooShort' }
    {
        if (!sessionId) return { status: 'none' };
        if (!(answered >= MINIGAME_MIN_ANSWERED)) return { status: 'tooShort' };
        const { baseXp, crystals } = minigameReward(accuracy);
        return grant(`minigame:${sessionId}`, (d) => ({ xp: scaledXp(baseXp, d.progression.level), crystals }));
    },

    // DEV panel only (no-ops in production builds): never part of the normal reward path.
    devAddXp (amount: number): XpAward
    {
        if (!DEV) return { status: 'none' };
        return grant(null, () => ({ xp: Math.max(0, Math.floor(amount)), crystals: 0 }));
    },

    devSetLevel (level: number): boolean
    {
        if (!DEV) return false;
        return stage((d) =>
        {
            d.progression.level = Math.max(1, Math.min(200, Math.floor(level) || 1));
            d.progression.xp = 0;
            if (unspentOf(d.progression) < 0) d.progression.alloc = { health: 0, sword: 0, bow: 0, staff: 0 }; // refund
        });
    },

    devGivePoints (points: number): boolean
    {
        if (!DEV) return false;
        return stage((d) => { d.progression.bonusPoints += Math.max(0, Math.floor(points)); });
    },

    /** Refunds every allocated point (they become unspent again; nothing is destroyed). */
    devResetStats (): boolean
    {
        if (!DEV) return false;
        return stage((d) => { d.progression.alloc = { health: 0, sword: 0, bow: 0, staff: 0 }; });
    },

    // ------------------------------------------------------------ crystal shop

    /** Crystal balance (Number Crystals in the bag). */
    get crystals (): number
    {
        return countItem(data.inventory, CURRENCY);
    },

    get shop (): Readonly<ShopProgress>
    {
        return data.shop;
    },

    /** Unlocks a village item forever and shows it right away. */
    buyVillageItem (id: VillageItemId): ShopResult
    {
        if (data.shop.villageUnlocks.includes(id)) return 'owned';
        const { price, slot } = VILLAGE_ITEMS[id];
        return transact(price, (draft) =>
        {
            draft.shop.villageUnlocks.push(id);
            draft.shop.villageSelections[slot] = id;
            return 'ok';
        });
    },

    /** Shows an owned item in its slot, or `null` to go back to the slot's original look. */
    applyVillage (slot: string, id: VillageItemId | null): ShopResult
    {
        if (id && (!data.shop.villageUnlocks.includes(id) || VILLAGE_ITEMS[id].slot !== slot)) return 'locked';
        if ((data.shop.villageSelections[slot] ?? null) === id) return 'ok';
        return transact(0, (draft) => { draft.shop.villageSelections[slot] = id; return 'ok'; });
    },
};

/**
 * One shop action: pay `cost` crystals and apply `change`, staged on a copy and made live only
 * once saved in ONE write. So a refused save never takes crystals, and a reload can never see
 * the purchase without the payment (or the payment without the purchase).
 */
function transact (cost: number, change: (draft: PlayerData) => ShopResult): ShopResult
{
    const draft = copy();
    if (!removeItem(draft.inventory, CURRENCY, cost)) return 'poor';
    const result = change(draft);
    if (result !== 'ok') return result;
    return publish(draft) ? 'ok' : 'saveFailed';
}

/** A working copy of the whole player document (changes stay invisible until published). */
const copy = (): PlayerData => ({
    ...data, inventory: structuredClone(data.inventory), shop: structuredClone(data.shop), progression: structuredClone(data.progression),
});

/** Saves `draft` in ONE write and only then makes it live. False = nothing changed. */
function publish (draft: PlayerData): boolean
{
    if (!save(draft)) return false;
    data = draft;
    listeners.forEach((fn) => fn());
    return true;
}

const stage = (change: (draft: PlayerData) => void) => { const d = copy(); change(d); return publish(d); };

/**
 * Pays an XP (+ crystal) reward at most once per `claimId` (null = untracked, dev only). XP is
 * computed from the level at THIS moment, carries over through any number of level-ups, and is
 * saved together with the claim in one write: a reload can never pay it twice or lose it.
 */
function grant (claimId: string | null, compute: (draft: PlayerData) => { xp: number; crystals: number }): XpAward
{
    if (claimId && data.progression.claims.includes(claimId)) return { status: 'claimed' };
    const draft = copy();
    const { xp, crystals } = compute(draft);
    const next = addXp(draft.progression, xp);
    draft.progression.level = next.level;
    draft.progression.xp = next.xp;
    if (claimId)
    {
        draft.progression.claims.push(claimId);
        // Bounded history: the current run's kill ids always stay; older non-kill ids roll off.
        const kills = draft.progression.claims.filter((c) => c.startsWith('kill:'));
        const others = draft.progression.claims.filter((c) => !c.startsWith('kill:')).slice(-MAX_CLAIMS);
        draft.progression.claims = [...others, ...kills];
    }
    const crystalsLost = crystals ? addItem(draft.inventory, CURRENCY, crystals) : 0;
    if (!publish(draft)) return { status: 'saveFailed' };
    return { status: 'awarded', xp, crystals: crystals - crystalsLost, crystalsLost, level: next.level, levelsGained: next.levelsGained };
}

export const isChallengeClaimed = (id: string) => data.claimedChallenges.has(id);

/**
 * Grants a challenge reward once. If the inventory has no room at all, nothing is claimed
 * so the player can make space and earn it later.
 */
export function claimChallengeReward (challenge: Challenge): { granted: number; full: boolean }
{
    return claimRewardOnce(challenge.id, challenge.reward);
}

/**
 * Grants a reward at most once per id (challenge ids, or e.g. one Answer Dash reward per NPC
 * per day). Shares the claimed-ids set with challenges, so claims are never duplicated.
 */
export function claimRewardOnce (id: string, reward: { item: ItemId; amount: number }): { granted: number; full: boolean }
{
    if (data.claimedChallenges.has(id)) return { granted: 0, full: false };
    const { item, amount } = reward;
    const left = addItem(data.inventory, item, amount);
    if (left === amount) return { granted: 0, full: true };
    data.claimedChallenges.add(id);
    commit();
    return { granted: amount - left, full: left > 0 };
}

/** Identity of one chest's reward in one dungeon run. Run ids never contain "/". */
export const chestRewardId = (runId: string, chestId: string) => `${runId}/${chestId}`;

export type ChestClaim =
    /** Nothing was added: the save failed, so inventory and receipts are unchanged. Safe to retry. */
    | { ok: false }
    /** `added` went into the inventory now; `delivered` is the running total for this reward. */
    | { ok: true; added: number; delivered: number };

/**
 * Idempotent dungeon chest delivery. Adds only what the receipt says is still owed (as much as
 * fits), and saves the new inventory together with the updated receipt in ONE write, so a
 * reload can never see the items without the receipt (or the receipt without the items).
 * The change is staged on a copy and only becomes live once that write succeeded.
 * Receipts of other runs are dropped in the same write: once a run's chest is being paid, the
 * dungeon save already belongs to that run and older runs can never be resumed.
 */
export function claimChestReward (reward: { runId: string; chestId: string; itemId: ItemId; total: number }): ChestClaim
{
    const id = chestRewardId(reward.runId, reward.chestId);
    const delivered = data.chestReceipts[id]?.delivered ?? 0;
    const owed = reward.total - delivered;
    if (owed <= 0) return { ok: true, added: 0, delivered };

    const inventory = structuredClone(data.inventory);
    const added = owed - addItem(inventory, reward.itemId, owed);
    if (added === 0) return { ok: true, added: 0, delivered }; // bag full: nothing to save

    const prefix = chestRewardId(reward.runId, '');
    const chestReceipts = Object.fromEntries(Object.entries(data.chestReceipts).filter(([key]) => key.startsWith(prefix)));
    chestReceipts[id] = { itemId: reward.itemId, total: reward.total, delivered: delivered + added };

    const next: PlayerData = { ...data, inventory, chestReceipts };
    if (!save(next)) return { ok: false };
    data = next;
    listeners.forEach((fn) => fn());
    return { ok: true, added, delivered: delivered + added };
}

export function onPlayerStateChange (fn: () => void)
{
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

function commit ()
{
    save();
    listeners.forEach((fn) => fn());
}

/** Writes the whole player document. Returns false if storage is full / blocked. */
function save (snapshot: PlayerData = data): boolean
{
    return writeJson(STORAGE_KEY, {
        version: SCHEMA_VERSION,
        inventory: snapshot.inventory,
        claimedChallenges: [...snapshot.claimedChallenges],
        starterKitGranted: snapshot.starterKitGranted,
        chestReceipts: snapshot.chestReceipts,
        shop: snapshot.shop,
        progression: snapshot.progression,
    });
}

function backup (suffix: string, text: string)
{
    try { localStorage.setItem(`${STORAGE_KEY}.${suffix}`, text); }
    catch { /* best effort */ }
}

const claimedFrom = (value: unknown) =>
    new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);

/** Valid receipts only (storage is untrusted). Saves from before receipts existed have none. */
function receiptsFrom (value: unknown): Record<string, ChestReceipt>
{
    const receipts: Record<string, ChestReceipt> = {};
    if (!value || typeof value !== 'object') return receipts;
    const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
    for (const [id, r] of Object.entries(value as Record<string, unknown>))
    {
        const rec = r as Record<string, unknown> | null;
        if (!rec || !isItemId(rec.itemId) || !count(rec.total) || !count(rec.delivered)) continue;
        receipts[id] = { itemId: rec.itemId, total: rec.total, delivered: Math.min(rec.delivered, rec.total) };
    }
    return receipts;
}

/** Saves made before weapons became permanent (weapon items, weapon shop purchases, old stats). */
function hasLegacyWeapons (raw: Record<string, unknown>)
{
    const inv = (raw.inventory ?? {}) as { backpack?: unknown[]; equipment?: Record<string, unknown> };
    const stacks = [...(Array.isArray(inv.backpack) ? inv.backpack : []), ...Object.values(inv.equipment ?? {})];
    const shop = (raw.shop ?? {}) as Record<string, unknown>;
    const alloc = ((raw.progression ?? {}) as { alloc?: Record<string, unknown> }).alloc ?? {};
    return stacks.some((st) => isLegacyWeaponItem((st as { itemId?: unknown } | null)?.itemId))
        || 'weaponUnlocks' in shop || 'weaponUpgradeLevels' in shop || 'defense' in alloc || 'speed' in alloc;
}

/**
 * Progression from untrusted saved JSON. Points of removed stats (Defense, Speed) or impossible
 * allocations are refunded as unspent points; XP beyond the level's requirement carries over.
 */
function progressionFrom (raw: unknown): Progression
{
    const p = freshProgression();
    if (!raw || typeof raw !== 'object') return p;
    const r = raw as Record<string, unknown>;
    const int = (v: unknown, min: number, max: number, fallback: number) => (Number.isInteger(v) ? Math.max(min, Math.min(max, v as number)) : fallback);
    p.level = int(r.level, 1, 200, 1);
    const carried = addXp({ level: p.level, xp: 0 }, int(r.xp, 0, xpForLevel(201), 0));
    p.level = Math.min(200, carried.level);
    p.xp = carried.xp;
    p.bonusPoints = int(r.bonusPoints, 0, 600, 0);
    const alloc = (r.alloc && typeof r.alloc === 'object' ? r.alloc : {}) as Record<string, unknown>;
    for (const stat of STAT_IDS) p.alloc[stat] = int(alloc[stat], 0, 600, 0);
    if (unspentOf(p) < 0) p.alloc = { health: 0, sword: 0, bow: 0, staff: 0 }; // corrupt: refund everything
    p.claims = Array.isArray(r.claims) ? [...new Set(r.claims.filter((c): c is string => typeof c === 'string'))].slice(-MAX_CLAIMS * 2) : [];
    const kill = (r.runKill && typeof r.runKill === 'object' ? r.runKill : {}) as Record<string, unknown>;
    p.runKill = { runId: typeof kill.runId === 'string' ? kill.runId : '', base: int(kill.base, 0, 1_000_000, 0) };
    return p;
}

function load (): PlayerData
{
    const fresh = (): PlayerData => ({
        inventory: createEmptyInventory(), claimedChallenges: new Set(), starterKitGranted: false, chestReceipts: {},
        shop: emptyProgress(),
        progression: freshProgression(),
    });
    let result = fresh();
    let text: string | null = null;

    try { text = localStorage.getItem(STORAGE_KEY); }
    catch { /* storage blocked: play in memory */ }

    if (text)
    {
        try
        {
            const raw = JSON.parse(text);
            if (raw?.version === 3 || raw?.version === 2)
            {
                if (raw.version === 2) backup('v2-backup', text); // hotbar items move to the backpack
                if (hasLegacyWeapons(raw)) backup('weapons-backup', text);
                result = {
                    inventory: sanitizeInventory(raw.inventory),
                    claimedChallenges: claimedFrom(raw.claimedChallenges),
                    starterKitGranted: raw.starterKitGranted === true,
                    chestReceipts: receiptsFrom(raw.chestReceipts),
                    shop: sanitizeProgress(raw.shop),
                    progression: progressionFrom(raw.progression),
                };
                // Crystals spent on the removed weapon shop come back (once: the next save drops those fields).
                const refund = legacyWeaponRefund(raw.shop);
                if (refund) addItem(result.inventory, CURRENCY, refund);
            }
            else if (raw?.version === 1)
            {
                // Migrate: keep claimed rewards and turn the old crystal counter into item stacks.
                backup('v1-backup', text);
                result.claimedChallenges = claimedFrom(raw.claimedChallenges);
                const crystals = raw.inventory?.numberCrystals;
                if (Number.isInteger(crystals) && crystals > 0 && isItemId('number_crystal'))
                {
                    addItem(result.inventory, 'number_crystal', crystals);
                }
            }
            else
            {
                throw new Error(`Unsupported save version ${raw?.version}`);
            }
        }
        catch (err)
        {
            console.warn(`[playerState] Saved progress could not be read; a copy was kept in "${STORAGE_KEY}.backup".`, err);
            backup('backup', text);
            result = fresh();
        }
    }

    // Starter kit: exactly once per save, never duplicated on reload.
    if (!result.starterKitGranted)
    {
        grantStarterKit(result.inventory);
        result.starterKitGranted = true;
    }
    return result;
}

data = load();
save(); // persist migrations / starter kit immediately
