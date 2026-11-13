// THE single source of player progress: inventory (backpack + equipment) and claimed
// challenge rewards. Saved to localStorage; the rest of the game reads and changes it here.
//
// Save format (version 3):
//   { version, inventory: { backpack, equipment }, claimedChallenges: string[], starterKitGranted: boolean }
// Older saves are migrated automatically and the original text is kept as a backup:
//   v1 (Task 3: crystal counter)  -> "eduroam.player.v1-backup"
//   v2 (Task 4: had a hotbar; its items move into the backpack) -> "eduroam.player.v2-backup"


import {
    addItem, consumeEquipped, countItem, createEmptyInventory, equipmentStats, firstEmptySlot, grantStarterKit,
    moveStack, sanitizeInventory, type InventoryState, type MoveResult, type SlotRef,
} from '../items/inventory';
import { isItemId, type EquipSlot, type ItemId } from '../items/itemDefs';
import type { Challenge } from '../minigames/challenge';

const STORAGE_KEY = 'eduroam.player';
const SCHEMA_VERSION = 3;

interface PlayerData
{
    inventory: InventoryState;
    claimedChallenges: Set<string>;
    starterKitGranted: boolean;
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

function save ()
{
    const json = {
        version: SCHEMA_VERSION,
        inventory: data.inventory,
        claimedChallenges: [...data.claimedChallenges],
        starterKitGranted: data.starterKitGranted,
    };
    try
    {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
    }
    catch (err)
    {
        console.warn('[playerState] Progress could not be saved (storage unavailable).', err);
    }
}

function backup (suffix: string, text: string)
{
    try { localStorage.setItem(`${STORAGE_KEY}.${suffix}`, text); }
    catch { /* best effort */ }
}

const claimedFrom = (value: unknown) =>
    new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);

function load (): PlayerData
{
    const fresh = (): PlayerData => ({ inventory: createEmptyInventory(), claimedChallenges: new Set(), starterKitGranted: false });
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
