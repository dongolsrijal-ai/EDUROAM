// DATA-DRIVEN ITEM DEFINITIONS. Add new weapons, armor, rewards or loot by adding an entry
// (and an icon in items/icons.ts). Item ids are stable: they are what saves store.

export type ItemCategory = 'weapon' | 'armor' | 'consumable' | 'material' | 'quest';
export type EquipSlot = 'armor' | 'melee' | 'ranged' | 'healing';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

/** Stats read by future combat / healing systems. */
export interface ItemStats
{
    defense?: number;
    meleeDamage?: number;
    rangedDamage?: number;
    /** HP restored per use. */
    heal?: number;
    /** Time between attacks in ms (weapon attack speed). */
    cooldownMs?: number;
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
    wooden_sword: {
        name: 'Wooden Sword',
        description: 'A sturdy practice sword carved from oak.',
        category: 'weapon', rarity: 'common', maxStack: 1, equipSlot: 'melee',
        stats: { meleeDamage: 5, cooldownMs: 420 },
    },
    training_bow: {
        name: 'Training Bow',
        description: 'A light bow for target practice. Aim small, miss small.',
        category: 'weapon', rarity: 'common', maxStack: 1, equipSlot: 'ranged',
        stats: { rangedDamage: 3, cooldownMs: 650 },
    },
    small_health_potion: {
        name: 'Small Health Potion',
        description: 'A fizzy red tonic. Tastes like strawberries and homework.',
        category: 'consumable', rarity: 'common', maxStack: 10, equipSlot: 'healing',
        stats: { heal: 20 },
    },
    number_crystal: {
        name: 'Number Crystal',
        description: 'Earned by solving math challenges. Will power future crafting.',
        category: 'material', rarity: 'uncommon', maxStack: 99,
    },

    // Dungeon loot (see items/lootTables.ts)
    iron_sword: {
        name: 'Iron Sword',
        description: 'Forged in the dungeon depths. Heavier, sharper, smarter.',
        category: 'weapon', rarity: 'rare', maxStack: 1, equipSlot: 'melee',
        stats: { meleeDamage: 10, cooldownMs: 450 },
    },
    reinforced_armor: {
        name: 'Reinforced Armor',
        description: 'Riveted plates over thick padding. Shrugs off clumsy hits.',
        category: 'armor', rarity: 'rare', maxStack: 1, equipSlot: 'armor',
        stats: { defense: 5 },
    },
    hunter_bow: {
        name: 'Hunter Bow',
        description: 'A taut yew bow strung for long, accurate shots.',
        category: 'weapon', rarity: 'rare', maxStack: 1, equipSlot: 'ranged',
        stats: { rangedDamage: 7, cooldownMs: 520 },
    },
    large_health_potion: {
        name: 'Large Health Potion',
        description: 'A big bottle of bubbling berry tonic.',
        category: 'consumable', rarity: 'uncommon', maxStack: 10, equipSlot: 'healing',
        stats: { heal: 50 },
    },
    magic_crystal: {
        name: 'Magic Crystal',
        description: 'Hums with arcane energy. A future crafting resource.',
        category: 'material', rarity: 'epic', maxStack: 99,
    },
} satisfies Record<string, ItemDef>;

export type ItemId = keyof typeof ITEM_DEFS;

export const itemDef = (id: ItemId): ItemDef => ITEM_DEFS[id];

export const isItemId = (value: unknown): value is ItemId =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(ITEM_DEFS, value);

/** Given to every new player once, equipped automatically. */
export const STARTER_KIT: { itemId: ItemId; qty: number }[] = [
    { itemId: 'cloth_armor', qty: 1 },
    { itemId: 'wooden_sword', qty: 1 },
    { itemId: 'training_bow', qty: 1 },
    { itemId: 'small_health_potion', qty: 3 },
];

export const CATEGORY_LABELS: Record<ItemCategory, string> = {
    weapon: 'Weapon', armor: 'Armor', consumable: 'Consumable', material: 'Material', quest: 'Quest Item',
};

export const EQUIP_SLOT_LABELS: Record<EquipSlot, string> = {
    armor: 'Armor', melee: 'Melee', ranged: 'Ranged', healing: 'Healing',
};
