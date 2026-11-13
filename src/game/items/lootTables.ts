// LOOT TABLES: weighted pools of item rewards. Add entries (or new tables) freely;
// item ids must exist in itemDefs.ts.

import type { ItemId } from './itemDefs';

export interface LootEntry
{
    itemId: ItemId;
    /** Relative chance (higher = more common). */
    weight: number;
    /** Quantity range [min, max] for stackable items. */
    qty?: [number, number];
}

/** Dungeon chests (side chests and the final treasure chest). */
export const DUNGEON_LOOT: LootEntry[] = [
    { itemId: 'iron_sword', weight: 2 },
    { itemId: 'reinforced_armor', weight: 2 },
    { itemId: 'hunter_bow', weight: 2 },
    { itemId: 'large_health_potion', weight: 3, qty: [1, 2] },
    { itemId: 'magic_crystal', weight: 3, qty: [2, 4] },
];

export function rollLoot (table: LootEntry[], random = Math.random): { itemId: ItemId; qty: number }
{
    const total = table.reduce((sum, e) => sum + e.weight, 0);
    let pick = random() * total;
    const entry = table.find((e) => (pick -= e.weight) < 0) ?? table[table.length - 1];
    const [min, max] = entry.qty ?? [1, 1];
    return { itemId: entry.itemId, qty: min + Math.floor(random() * (max - min + 1)) };
}
