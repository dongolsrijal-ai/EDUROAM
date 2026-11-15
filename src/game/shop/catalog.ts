// THE CRYSTAL SHOP CATALOG: everything the permanent village shop sells. The shop is
// DECORATION-ONLY: crystals never buy combat power (weapons improve through stat points, see
// progression/balance.ts). No UI and no storage here: playerState.ts owns the saved progress,
// ui/ShopPanel.ts shows it, scenes/Hub.ts draws the village from it.
//
// Add content by adding a VILLAGE_ITEMS entry (+ its drawing in world/villageLook.ts).

import type { ItemId } from '../items/itemDefs';

/** The item spent in the shop (the purple crystal counter in the HUD). */
export const CURRENCY: ItemId = 'number_crystal';

// ---------------------------------------------------------------- village

/**
 * Fixed customization slots. A slot shows at most one item; `null` = the village's original
 * look. Decorations each have their own slot, so they simply toggle on and off.
 */
export type VillageGroup = 'Home' | 'Yard & Roads' | 'Decorations';

export interface VillageItemDef
{
    name: string;
    description: string;
    price: number;
    group: VillageGroup;
    slot: string;
}

export const VILLAGE_ITEMS = {
    // Home (the cottage itself)
    house_two_storey: { name: 'House Upgrade I', description: 'Adds a second storey to your cottage.', price: 70, group: 'Home', slot: 'house' },
    house_manor: { name: 'House Upgrade II', description: 'A grand manor: second storey, attic gable and a turret.', price: 140, group: 'Home', slot: 'house' },
    roof_slate: { name: 'Slate Roof', description: 'Cool blue slate tiles instead of coral.', price: 30, group: 'Home', slot: 'roof' },
    door_blue: { name: 'Painted Door', description: 'A sky-blue door with a brass knocker.', price: 15, group: 'Home', slot: 'door' },
    windows_shutters: { name: 'Window Shutters', description: 'Green shutters and fuller flower boxes.', price: 25, group: 'Home', slot: 'windows' },

    // Yard & roads (one style per slot)
    lamp_post: { name: 'Lamp Posts', description: 'Warm lanterns by your path and along the road.', price: 20, group: 'Yard & Roads', slot: 'lamps' },
    street_light: { name: 'Street Lights', description: 'Tall twin-lantern lights for the whole village.', price: 35, group: 'Yard & Roads', slot: 'lamps' },
    path_cobble: { name: 'Cobblestone Paths', description: 'Paves every village path with grey cobbles.', price: 40, group: 'Yard & Roads', slot: 'path' },
    path_mossy: { name: 'Mossy Paths', description: 'Old stone paths with moss between the slabs.', price: 40, group: 'Yard & Roads', slot: 'path' },

    // Decorations (toggle each on / off)
    bench: { name: 'Small Bench', description: 'A place to sit by the square.', price: 12, group: 'Decorations', slot: 'bench' },
    flower_beds: { name: 'Flower Beds', description: 'Two beds of spring flowers along the fence line.', price: 10, group: 'Decorations', slot: 'flower_beds' },
    potted_plants: { name: 'Potted Plants', description: 'Terracotta pots either side of your door.', price: 8, group: 'Decorations', slot: 'potted_plants' },
    fountain: { name: 'Fountain', description: 'A stone fountain for the village square.', price: 60, group: 'Decorations', slot: 'fountain' },
    garden_patch: { name: 'Garden Patch', description: 'A little vegetable plot behind the house.', price: 18, group: 'Decorations', slot: 'garden_patch' },
    bush_cluster: { name: 'Bush Cluster', description: 'Flowering bushes beside the yard.', price: 10, group: 'Decorations', slot: 'bush_cluster' },
    wisteria_tree: { name: 'Wisteria Tree', description: 'A lavender-blossom tree for the garden.', price: 22, group: 'Decorations', slot: 'wisteria_tree' },
    barrels: { name: 'Barrels & Crates', description: 'Market stock stacked beside the shop.', price: 12, group: 'Decorations', slot: 'barrels' },
    signpost: { name: 'Signpost', description: 'Points the way at the crossroads.', price: 8, group: 'Decorations', slot: 'signpost' },
} satisfies Record<string, VillageItemDef>;

export type VillageItemId = keyof typeof VILLAGE_ITEMS;
export const VILLAGE_ITEM_IDS = Object.keys(VILLAGE_ITEMS) as VillageItemId[];
export const VILLAGE_GROUPS: VillageGroup[] = ['Home', 'Yard & Roads', 'Decorations'];
export const villageItem = (id: VillageItemId): VillageItemDef => VILLAGE_ITEMS[id];

// ---------------------------------------------------------------- saved progress

/** Everything bought in the shop (saved inside the player document, see playerState.ts). */
export interface ShopProgress
{
    /** Village items owned forever. */
    villageUnlocks: VillageItemId[];
    /** What each slot currently shows (missing / null = original look). */
    villageSelections: Record<string, VillageItemId | null>;
}

export function emptyProgress (): ShopProgress
{
    return { villageUnlocks: [], villageSelections: {} };
}

const has = (map: object, key: unknown): boolean => typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key);

/** Rebuilds progress from untrusted saved JSON: unknown ids dropped, selections must be owned. */
export function sanitizeProgress (raw: unknown): ShopProgress
{
    const progress = emptyProgress();
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const list = (value: unknown) => (Array.isArray(value) ? value : []);

    progress.villageUnlocks = [...new Set(list(r.villageUnlocks).filter((id): id is VillageItemId => has(VILLAGE_ITEMS, id)))];

    const selections = (r.villageSelections && typeof r.villageSelections === 'object' ? r.villageSelections : {}) as Record<string, unknown>;
    for (const id of progress.villageUnlocks)
    {
        const { slot } = VILLAGE_ITEMS[id];
        if (selections[slot] === id) progress.villageSelections[slot] = id;
    }
    return progress;
}

/**
 * Crystals spent in the short-lived weapon section of the shop (Apprentice Staff unlock + upgrade
 * levels), refunded once when such a save loads: weapons are permanent now and improve through
 * stat points, so those purchases must not be lost. Sword / bow purchases cannot be told apart
 * from the starter kit and are not refunded.
 */
const LEGACY_WEAPON_PRICES = {
    staff: 35,
    levels: { sword: [20, 45, 80], bow: [20, 45, 80], staff: [25, 55, 95], quickHands: [40, 90], sharperAim: [35, 80], arcaneFocus: [45, 100] } as Record<string, number[]>,
};

export function legacyWeaponRefund (raw: unknown): number
{
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    let refund = Array.isArray(r.weaponUnlocks) && r.weaponUnlocks.includes('staff') ? LEGACY_WEAPON_PRICES.staff : 0;
    const levels = (r.weaponUpgradeLevels && typeof r.weaponUpgradeLevels === 'object' ? r.weaponUpgradeLevels : {}) as Record<string, unknown>;
    for (const [track, costs] of Object.entries(LEGACY_WEAPON_PRICES.levels))
    {
        const level = Number.isInteger(levels[track]) ? Math.max(0, Math.min(costs.length, levels[track] as number)) : 0;
        refund += costs.slice(0, level).reduce((sum, c) => sum + c, 0);
    }
    return refund;
}

/** Item shown in a village slot, or null for the original look. */
export function villageSelection (progress: ShopProgress, slot: string): VillageItemId | null
{
    return progress.villageSelections[slot] ?? null;
}
