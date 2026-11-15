// What the crystal shop's village items look like ON THE MAP. Customization uses fixed slots
// (no free placement): each item has a hand-picked spot around the home and the square, chosen
// to stay clear of the paths, the existing garden decor and Sir Sum-a-Lot's hall.
//
// Pure data: Hub.ts turns the result into sprites and re-applies it whenever a selection changes.
// All coordinates are in TILES, like world/village.ts.

import type { HouseStyle } from '../art/gardenArt';
import { villageSelection, type ShopProgress, type VillageItemId } from '../shop/catalog';
import type { ObjectKind, PlacedObject } from './objectTypes';
import { HOUSE, SHOP_STALL } from './village';

export interface VillageLook
{
    house: HouseStyle;
    /** Ground tileset key (path style): 'ground' | 'ground-cobble' | 'ground-mossy'. */
    tileset: string;
    objects: PlacedObject[];
}

const lamps = (kind: ObjectKind, lift: number): PlacedObject[] =>
    [[27.2, 15.4], [30.1, 15.4], [15, 18.9], [43, 18.9]].map(([x, y]) => ({ kind, x, y: y - lift }));

/** Objects each item adds when it is shown in its slot. */
const OBJECTS: Partial<Record<VillageItemId, PlacedObject[]>> = {
    lamp_post: lamps('lampPost', 0),
    street_light: lamps('streetLight', 0.4),

    bench: [{ kind: 'bench', x: 26.3, y: 24.8 }],
    fountain: [{ kind: 'fountain', x: 24, y: 23.9 }],
    flower_beds: [{ kind: 'flowerBed', x: 23.5, y: 13.9 }, { kind: 'flowerBed', x: 25.6, y: 13.9 }],
    // On the doorstep, either side of the door (drawn in front of the wall).
    potted_plants: [{ kind: 'pottedPlant', x: HOUSE.x + 0.95, y: HOUSE.y + 3.1, depthBias: 4 }, { kind: 'pottedPlant', x: HOUSE.x + 2.45, y: HOUSE.y + 3.1, depthBias: 4 }],
    garden_patch: [{ kind: 'gardenPatch', x: 24, y: 6.2 }],
    bush_cluster: [{ kind: 'bushFlower', x: 21, y: 7 }, { kind: 'bush', x: 21.7, y: 8.3 }, { kind: 'bushFlower', x: 21, y: 9.6 }],
    wisteria_tree: [{ kind: 'treeWisteria', x: 33.5, y: 2 }],
    barrels: [{ kind: 'barrels', x: SHOP_STALL.x - 1.5, y: SHOP_STALL.y + 1.3 }],
    signpost: [{ kind: 'signpost', x: 30.4, y: 19.3 }],
};

const TILESETS: Partial<Record<VillageItemId, string>> = { path_cobble: 'ground-cobble', path_mossy: 'ground-mossy' };

/** The village's current look from the shop selections (nothing selected = the original village). */
export function villageLook (progress: ShopProgress): VillageLook
{
    const shown = (slot: string) => villageSelection(progress, slot);
    const house = shown('house');
    const path = shown('path');
    const selected = new Set(Object.values(progress.villageSelections));
    return {
        house: {
            tier: house === 'house_manor' ? 2 : house === 'house_two_storey' ? 1 : 0,
            roof: shown('roof') === 'roof_slate' ? 'slate' : 'coral',
            door: shown('door') === 'door_blue' ? 'blue' : 'wood',
            shutters: shown('windows') === 'windows_shutters',
        },
        tileset: (path && TILESETS[path]) || 'ground',
        objects: (Object.keys(OBJECTS) as VillageItemId[]).filter((id) => selected.has(id)).flatMap((id) => OBJECTS[id]!),
    };
}
