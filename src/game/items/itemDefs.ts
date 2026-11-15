// DATA-DRIVEN ITEM DEFINITIONS. Add armor, consumables or materials by adding an entry (and an
// icon in items/icons.ts). Item ids are stable: they are what saves store.
//
// Weapons are NOT items: every player permanently has the Sword, Bow and Staff, improved by stat
// points (progression/balance.ts). The old weapon items are listed in LEGACY_WEAPON_ITEMS so old
// saves migrate cleanly (they are dropped from inventories; their chest records stay paid).

export type ItemCategory = 'weapon' | 'armor' | 'consumable' | 'material' | 'quest';
export type EquipSlot = 'armor' | 'healing';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

/** Stats read by future combat / healing systems. */
export interface ItemStats
{
    defense?: number;
    /** HP restored per use. */
    heal?: number;
}

export interface ItemDef
{
    name: string;
    description: string;
    category: ItemCategory;
    rarity: Rarity;
    /** 1 = not stackable (weapons, armor). */
    maxStack: number;
    /** Equipment slot this item can go in, if any. */
    equipSlot?: EquipSlot;
    stats?: ItemStats;
}

export const ITEM_DEFS = {
    cloth_armor: {
        name: 'Cloth Armor',
        description: 'Padded cloth that softens a blow or two. Better than nothing!',
        category: 'armor', rarity: 'common', maxStack: 1, equipSlot: 'armor',
        stats: { defense: 2 },
    },
    small_health_potion: {
        name: 'Small Health Potion',
        description: 'A fizzy red tonic. Tastes like strawberries and homework.',
        category: 'consumable', rarity: 'common', maxStack: 10, equipSlot: 'healing',
        stats: { heal: 10 },
    },
    number_crystal: {
        name: 'Number Crystal',
        description: 'Earned from mini-games and dungeon chests. Spend them on village decorations at the Crystal Shop.',
        category: 'material', rarity: 'uncommon', maxStack: 99,
    },

    // Earlier dungeon loot (kept so existing saves keep their items)
    reinforced_armor: {
        name: 'Reinforced Armor',
        description: 'Riveted plates over thick padding. Shrugs off clumsy hits.',
        category: 'armor', rarity: 'rare', maxStack: 1, equipSlot: 'armor',
        stats: { defense: 5 },
    },
    large_health_potion: {
        name: 'Large Health Potion',
        description: 'A big bottle of bubbling berry tonic.',
        category: 'consumable', rarity: 'uncommon', maxStack: 10, equipSlot: 'healing',
        stats: { heal: 25 },
    },
    magic_crystal: {
        name: 'Magic Crystal',
        description: 'Hums with arcane energy. A future crafting resource.',
        category: 'material', rarity: 'epic', maxStack: 99,
    },

    warden_plate: {
        name: 'Warden Plate',
        description: 'Armor of the tower wardens. Heavy, but nothing gets through easily.',
        category: 'armor', rarity: 'epic', maxStack: 1, equipSlot: 'armor',
        stats: { defense: 8 },
    },
} satisfies Record<string, ItemDef>;

export type ItemId = keyof typeof ITEM_DEFS;

export const itemDef = (id: ItemId): ItemDef => ITEM_DEFS[id];

export const isItemId = (value: unknown): value is ItemId =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(ITEM_DEFS, value);

/** Given to every new player once, equipped automatically. */
export const STARTER_KIT: { itemId: ItemId; qty: number }[] = [
    { itemId: 'cloth_armor', qty: 1 },
    { itemId: 'small_health_potion', qty: 3 },
];

/** Removed weapon items (rarity tiers): migrated away from saves, see the header. */
export const LEGACY_WEAPON_ITEMS = ['wooden_sword', 'training_bow', 'iron_sword', 'hunter_bow', 'soulsteel_sword', 'spirit_longbow'] as const;
export const isLegacyWeaponItem = (value: unknown) => typeof value === 'string' && (LEGACY_WEAPON_ITEMS as readonly string[]).includes(value);

export const CATEGORY_LABELS: Record<ItemCategory, string> = {
    weapon: 'Weapon', armor: 'Armor', consumable: 'Consumable', material: 'Material', quest: 'Quest Item',
};

export const EQUIP_SLOT_LABELS: Record<EquipSlot, string> = {
    armor: 'Armor', healing: 'Healing',
};
