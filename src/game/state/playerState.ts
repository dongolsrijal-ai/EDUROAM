// THE single source of player progress: inventory (backpack + equipment) and claimed
// challenge rewards. Saved to localStorage; the rest of the game reads and changes it here.
//
// Save format (version 3):
//   { version, inventory: { backpack, equipment }, claimedChallenges: string[], starterKitGranted: boolean,
//     chestReceipts?: { [rewardId]: { itemId, total, delivered } } }
// `chestReceipts` is an additive, optional field (saves without it load with no receipts, and
// older builds simply ignore it), so it needs no version bump.
// Older saves are migrated automatically and the original text is kept as a backup:
//   v1 (Task 3: crystal counter)  -> "eduroam.player.v1-backup"
//   v2 (Task 4: had a hotbar; its items move into the backpack) -> "eduroam.player.v2-backup"


import { writeJson } from '../data/storage';
import {
    addItem, consumeEquipped, countItem, createEmptyInventory, equipmentStats, firstEmptySlot, grantStarterKit,
    moveStack, sanitizeInventory, type InventoryState, type MoveResult, type SlotRef,
} from '../items/inventory';
import { isItemId, type EquipSlot, type ItemId } from '../items/itemDefs';
import type { Challenge } from '../minigames/challenge';

const STORAGE_KEY = 'eduroam.player';
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
}

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

    count: (itemId: ItemId) => countItem(data.inventory, itemId),

    /** Uses one item from an equipment slot (e.g. a potion). Returns false if the slot is empty. */
    consumeEquipped (slot: EquipSlot): boolean
    {
        const ok = consumeEquipped(data.inventory, slot);
        if (ok) commit();
        return ok;
    },

    /** Shared stats from equipment (defense, damage, attack speed, healing). */
    stats: () => equipmentStats(data.inventory),
};

export const isChallengeClaimed = (id: string) => data.claimedChallenges.has(id);

/**
 * Grants a challenge reward once. If the inventory has no room at all, nothing is claimed
 * so the player can make space and earn it later.
 */
export function claimChallengeReward (challenge: Challenge): { granted: number; full: boolean }
{
    if (data.claimedChallenges.has(challenge.id)) return { granted: 0, full: false };
    const { item, amount } = challenge.reward;
    const left = addItem(data.inventory, item, amount);
    if (left === amount) return { granted: 0, full: true };
    data.claimedChallenges.add(challenge.id);
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

function load (): PlayerData
{
    const fresh = (): PlayerData => ({
        inventory: createEmptyInventory(), claimedChallenges: new Set(), starterKitGranted: false, chestReceipts: {},
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
                result = {
                    inventory: sanitizeInventory(raw.inventory),
                    claimedChallenges: claimedFrom(raw.claimedChallenges),
                    starterKitGranted: raw.starterKitGranted === true,
                    chestReceipts: receiptsFrom(raw.chestReceipts),
                };
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
