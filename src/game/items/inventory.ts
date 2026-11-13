// Inventory DATA + RULES only (no UI, no storage). playerState.ts owns the single live
// instance and persists it; the HTML inventory only reads it and asks for moves.

import { isItemId, itemDef, STARTER_KIT, type EquipSlot, type ItemId } from './itemDefs';

/** Backpack slots (9 per row; the UI shows a few rows and scrolls). */
export const BACKPACK_SIZE = 54;
export const EQUIP_SLOTS: EquipSlot[] = ['armor', 'melee', 'ranged', 'healing'];

export interface ItemStack
{
    itemId: ItemId;
    qty: number;
}

export type Slot = ItemStack | null;

export type SlotRef =
    | { area: 'backpack'; index: number }
    | { area: 'equipment'; slot: EquipSlot };

export interface InventoryState
{
    backpack: Slot[];
    equipment: Record<EquipSlot, Slot>;
}

export type MoveResult = 'moved' | 'merged' | 'swapped' | 'rejected' | 'noop';

export function createEmptyInventory (): InventoryState
{
    return {
        backpack: Array<Slot>(BACKPACK_SIZE).fill(null),
        equipment: { armor: null, melee: null, ranged: null, healing: null },
    };
}

export function getSlot (inv: InventoryState, ref: SlotRef): Slot
{
    return ref.area === 'equipment' ? inv.equipment[ref.slot] : inv.backpack[ref.index] ?? null;
}

function setSlot (inv: InventoryState, ref: SlotRef, value: Slot)
{
    if (ref.area === 'equipment') inv.equipment[ref.slot] = value;
    else inv.backpack[ref.index] = value;
}

/** Equipment slots only accept matching items; the backpack accepts anything. */
export function accepts (ref: SlotRef, stack: Slot): boolean
{
    if (!stack || ref.area !== 'equipment') return true;
    return itemDef(stack.itemId).equipSlot === ref.slot;
}

const sameRef = (a: SlotRef, b: SlotRef) =>
    a.area === b.area && (a.area === 'equipment' ? a.slot === (b as typeof a).slot : a.index === (b as typeof a).index);

/** Moves / merges / swaps the stack at `from` onto `to`, respecting slot rules. */
export function moveStack (inv: InventoryState, from: SlotRef, to: SlotRef): MoveResult
{
    if (sameRef(from, to)) return 'noop';
    const moving = getSlot(inv, from);
    if (!moving) return 'noop';
    const target = getSlot(inv, to);
    if (!accepts(to, moving)) return 'rejected';

    if (target && target.itemId === moving.itemId && itemDef(moving.itemId).maxStack > 1)
    {
        const room = itemDef(moving.itemId).maxStack - target.qty;
        if (room <= 0) return 'noop';
        const amount = Math.min(room, moving.qty);
        target.qty += amount;
        moving.qty -= amount;
        if (moving.qty === 0) setSlot(inv, from, null);
        return 'merged';
    }

    if (target && !accepts(from, target)) return 'rejected';
    setSlot(inv, to, moving);
    setSlot(inv, from, target);
    return target ? 'swapped' : 'moved';
}

/** First empty backpack slot (used for "unequip"). */
export function firstEmptySlot (inv: InventoryState): SlotRef | null
{
    const index = inv.backpack.indexOf(null);
    return index >= 0 ? { area: 'backpack', index } : null;
}

/** Adds items: tops up existing stacks first, then fills empty slots. Returns how many did NOT fit. */
export function addItem (inv: InventoryState, itemId: ItemId, qty: number): number
{
    const { maxStack } = itemDef(itemId);
    let left = qty;

    if (maxStack > 1)
    {
        for (const stack of [...EQUIP_SLOTS.map((s) => inv.equipment[s]), ...inv.backpack])
        {
            if (left === 0) break;
            if (stack?.itemId !== itemId || stack.qty >= maxStack) continue;
            const amount = Math.min(maxStack - stack.qty, left);
            stack.qty += amount;
            left -= amount;
        }
    }

    for (let i = 0; i < inv.backpack.length && left > 0; i++)
    {
        if (inv.backpack[i]) continue;
        const amount = Math.min(maxStack, left);
        inv.backpack[i] = { itemId, qty: amount };
        left -= amount;
    }
    return left;
}

/** Uses up items from an equipment slot (e.g. drinking a potion). Returns false if there are not enough. */
export function consumeEquipped (inv: InventoryState, slot: EquipSlot, qty = 1): boolean
{
    const stack = inv.equipment[slot];
    if (!stack || stack.qty < qty) return false;
    stack.qty -= qty;
    if (stack.qty === 0) inv.equipment[slot] = null;
    return true;
}

export function countItem (inv: InventoryState, itemId: ItemId): number
{
    return [...EQUIP_SLOTS.map((s) => inv.equipment[s]), ...inv.backpack]
        .reduce((sum, stack) => sum + (stack?.itemId === itemId ? stack.qty : 0), 0);
}

/** Totals from equipped items: the shared stats used by combat, healing and the UI. */
export function equipmentStats (inv: InventoryState)
{
    const stat = (slot: EquipSlot) => (inv.equipment[slot] ? itemDef(inv.equipment[slot]!.itemId).stats ?? {} : {});
    const healing = inv.equipment.healing;
    return {
        defense: stat('armor').defense ?? 0,
        meleeDamage: stat('melee').meleeDamage ?? 0,
        meleeCooldownMs: stat('melee').cooldownMs ?? 450,
        rangedDamage: stat('ranged').rangedDamage ?? 0,
        rangedCooldownMs: stat('ranged').cooldownMs ?? 650,
        healPerUse: stat('healing').heal ?? 0,
        healingCharges: healing?.qty ?? 0,
    };
}

/** Equips the starter kit (into empty matching slots, otherwise the backpack). */
export function grantStarterKit (inv: InventoryState)
{
    for (const { itemId, qty } of STARTER_KIT)
    {
        const slot = itemDef(itemId).equipSlot;
        if (slot && !inv.equipment[slot]) inv.equipment[slot] = { itemId, qty };
        else addItem(inv, itemId, qty);
    }
}

/**
 * Rebuilds an inventory from untrusted saved JSON: unknown items dropped, quantities clamped,
 * slots validated. Items from the removed hotbar (older saves) are moved into the backpack.
 */
export function sanitizeInventory (raw: unknown): InventoryState
{
    const inv = createEmptyInventory();
    if (!raw || typeof raw !== 'object') return inv;
    const r = raw as Record<string, unknown>;

    const stack = (value: unknown): Slot =>
    {
        if (!value || typeof value !== 'object') return null;
        const v = value as Record<string, unknown>;
        if (!isItemId(v.itemId) || typeof v.qty !== 'number' || !Number.isFinite(v.qty)) return null;
        const qty = Math.min(Math.floor(v.qty), itemDef(v.itemId).maxStack);
        return qty > 0 ? { itemId: v.itemId, qty } : null;
    };
    const overflow: ItemStack[] = [];

    if (Array.isArray(r.backpack))
    {
        r.backpack.forEach((value, i) =>
        {
            const s = stack(value);
            if (!s) return;
            if (i < BACKPACK_SIZE) inv.backpack[i] = s;
            else overflow.push(s);
        });
    }

    const equipment = (r.equipment && typeof r.equipment === 'object') ? r.equipment as Record<string, unknown> : {};
    for (const slot of EQUIP_SLOTS)
    {
        const s = stack(equipment[slot]);
        if (!s) continue;
        if (accepts({ area: 'equipment', slot }, s)) inv.equipment[slot] = s;
        else overflow.push(s); // wrong slot type: keep the item, move it to the bag
    }

    // Save versions <= 2 had a 10-slot hotbar: keep those items in the backpack.
    if (Array.isArray(r.hotbar))
    {
        for (const value of r.hotbar)
        {
            const s = stack(value);
            if (s) overflow.push(s);
        }
    }

    for (const s of overflow)
    {
        const lost = addItem(inv, s.itemId, s.qty);
        if (lost) console.warn(`[inventory] No room for ${lost} x ${s.itemId} while loading the save.`);
    }
    return inv;
}

// ------------------------------------------------------------ slot keys (for the UI / DOM)

export const refKey = (ref: SlotRef) => (ref.area === 'equipment' ? `equipment:${ref.slot}` : `backpack:${ref.index}`);

export function parseRefKey (key: string): SlotRef | null
{
    const [area, value] = key.split(':');
    if (area === 'equipment' && EQUIP_SLOTS.includes(value as EquipSlot)) return { area, slot: value as EquipSlot };
    const index = Number(value);
    if (area === 'backpack' && Number.isInteger(index) && index >= 0 && index < BACKPACK_SIZE) return { area, index };
    return null;
}
