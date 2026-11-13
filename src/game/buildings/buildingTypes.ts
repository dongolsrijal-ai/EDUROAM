// NPC building types. Every NPC owns one building whose theme follows their appearance.
// All buildings share one footprint so placement / collision logic is identical; the art
// (art/buildings.ts) makes them distinct. No building sprites exist in public/assets yet,
// so all four use generated placeholder textures.

import type { AppearanceId } from '../npcs/appearances';
import type { Rect } from '../world/objectTypes';

export type BuildingType = 'trainingHall' | 'clinic' | 'laboratory' | 'farmhouse';

export interface BuildingTypeDef
{
    label: string;
    description: string;
    texture: string;
    /** Collision boxes relative to the sprite's top-left (building body + side prop). */
    colliders: Rect[];
}

/** Shared sprite size in pixels (building body 48px wide + a 16px themed side prop). */
export const BUILDING_W = 64;
export const BUILDING_H = 56;

/** Where the resident NPC stands (feet), relative to the building's top-left: beside the door. */
export const NPC_HOME_OFFSET = { x: 40, y: 66 };

/** Strip in front of the building that must stay walkable (door access + NPC spot). */
export const FRONT_CLEARANCE = 14;

const SHARED_COLLIDERS: Rect[] = [
    { x: 2, y: 20, w: 46, h: 34 },  // building body
    { x: 50, y: 30, w: 13, h: 24 }, // side prop
];

export const BUILDING_TYPES: Record<BuildingType, BuildingTypeDef> = {
    trainingHall: {
        label: 'Training Hall',
        description: 'Stone walls, wooden roof, shields and a training dummy. Great for history.',
        texture: 'building-trainingHall',
        colliders: SHARED_COLLIDERS,
    },
    clinic: {
        label: 'Clinic',
        description: 'White and light-blue clinic with a medical sign and a patient bed. Great for biology.',
        texture: 'building-clinic',
        colliders: SHARED_COLLIDERS,
    },
    laboratory: {
        label: 'Laboratory',
        description: 'Glass windows, a bubbling chimney and a beaker table. Great for chemistry or physics.',
        texture: 'building-laboratory',
        colliders: SHARED_COLLIDERS,
    },
    farmhouse: {
        label: 'Farmhouse',
        description: 'Wooden farmhouse with a crop patch. Great for environmental science.',
        texture: 'building-farmhouse',
        colliders: SHARED_COLLIDERS,
    },
};

export const BUILDING_FOR_APPEARANCE: Record<AppearanceId, BuildingType> = {
    knight: 'trainingHall',
    doctor: 'clinic',
    scientist: 'laboratory',
    farmer: 'farmhouse',
};

export const BUILDING_TYPE_IDS = Object.keys(BUILDING_TYPES) as BuildingType[];

export const isBuildingType = (value: unknown): value is BuildingType =>
    typeof value === 'string' && (BUILDING_TYPE_IDS as string[]).includes(value);
