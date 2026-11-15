// Kinds of objects that can be placed on a map, and how they collide.
// Add a new decoration/building by drawing a texture in art/textures.ts and adding an entry here.

import { GameObjects, Physics, Scene } from 'phaser';
import { TILE } from '../config';

export interface Rect { x: number; y: number; w: number; h: number }

export type ObjectKind =
    | 'tree' | 'treeBlossom' | 'house' | 'rock' | 'flowersRed' | 'flowersWhite'
    | 'bush' | 'bushFlower' | 'flowerBed' | 'sunflower' | 'fern'
    | 'dungeonEntrance' | 'sealedStairs' | 'pillar' | 'chest' | 'torch'
    | 'obstacle' | 'decor' | 'shrine'
    // Crystal shop: the stall itself and the village items it sells (world/villageLook.ts)
    | 'shopStall' | 'bench' | 'fountain' | 'pottedPlant' | 'gardenPatch' | 'barrels' | 'signpost' | 'treeWisteria'
    | 'lampPost' | 'streetLight' | 'fenceWoodH' | 'fenceWoodV' | 'fenceStoneH' | 'fenceStoneV';

interface ObjectType
{
    texture: string;
    /**
     * COLLISION BOUNDARIES in pixels, relative to the sprite's top-left corner.
     * Usually only the base (trunk, walls) so the player can walk "behind" the top.
     * Omit to make the object walk-through.
     */
    colliders?: Rect[];
    /** Where the "Press E" interaction is anchored (relative to the top-left), for interactive objects. */
    interactAt?: { x: number; y: number };
    /** NPC buildings may not be placed over this sprite (houses, arches, tree canopies...). */
    blocksPlacement?: boolean;
    /** Looping animation key (2-frame sway for plants, see art/gardenArt.ts). */
    anim?: string;
}

export const OBJECT_TYPES: Record<ObjectKind, ObjectType> = {
    tree: { texture: 'tree', colliders: [{ x: 11, y: 30, w: 10, h: 9 }], blocksPlacement: true },
    treeBlossom: { texture: 'tree-blossom', colliders: [{ x: 11, y: 30, w: 10, h: 9 }], blocksPlacement: true },
    house: { texture: 'house', colliders: [{ x: 2, y: 24, w: 60, h: 38 }], blocksPlacement: true },
    rock: { texture: 'rock', colliders: [{ x: 3, y: 7, w: 10, h: 7 }] },
    flowersRed: { texture: 'flowers-red', blocksPlacement: true, anim: 'flowers-red-anim' },
    flowersWhite: { texture: 'flowers-white', blocksPlacement: true, anim: 'flowers-white-anim' },
    // Garden decor: bushes and flower beds are solid (low colliders); sunflowers and ferns are walk-through.
    bush: { texture: 'bush', colliders: [{ x: 2, y: 9, w: 12, h: 6 }], blocksPlacement: true },
    bushFlower: { texture: 'bush-flower', colliders: [{ x: 2, y: 9, w: 12, h: 6 }], blocksPlacement: true },
    flowerBed: { texture: 'flower-bed', colliders: [{ x: 1, y: 8, w: 30, h: 7 }], blocksPlacement: true },
    sunflower: { texture: 'sunflower', blocksPlacement: true, anim: 'sunflower-anim' },
    fern: { texture: 'fern', blocksPlacement: true },
    dungeonEntrance: {
        texture: 'dungeon-entrance',
        colliders: [{ x: 1, y: 8, w: 46, h: 36 }], // solid: enter with E, not by walking in
        interactAt: { x: 24, y: 46 },
        blocksPlacement: true,
    },
    sealedStairs: { texture: 'stairs-sealed', colliders: [{ x: 0, y: 0, w: 16, h: 16 }], interactAt: { x: 8, y: 18 }, blocksPlacement: true },
    pillar: { texture: 'pillar', colliders: [{ x: 1, y: 12, w: 14, h: 11 }], blocksPlacement: true },
    chest: { texture: 'chest', colliders: [{ x: 1, y: 5, w: 14, h: 10 }], interactAt: { x: 8, y: 18 }, blocksPlacement: true },
    torch: { texture: 'torch' },
    // Dungeon biome props (texture chosen per biome via PlacedObject.texture)
    obstacle: { texture: 'tombstone', colliders: [{ x: 2, y: 4, w: 12, h: 11 }], blocksPlacement: true },
    decor: { texture: 'bones' },
    shrine: { texture: 'shrine', colliders: [{ x: 3, y: 14, w: 10, h: 9 }], interactAt: { x: 8, y: 26 }, blocksPlacement: true },

    // Crystal shop stall ("Press E to Shop") and bought village decor. Small decor is walk-through.
    shopStall: { texture: 'shop-stall', colliders: [{ x: 3, y: 26, w: 42, h: 15 }], interactAt: { x: 24, y: 46 }, blocksPlacement: true },
    bench: { texture: 'bench', colliders: [{ x: 1, y: 6, w: 22, h: 6 }], blocksPlacement: true },
    fountain: { texture: 'fountain', colliders: [{ x: 2, y: 17, w: 28, h: 11 }], blocksPlacement: true },
    pottedPlant: { texture: 'potted-plant' },
    gardenPatch: { texture: 'garden-patch', blocksPlacement: true },
    barrels: { texture: 'barrels', colliders: [{ x: 1, y: 10, w: 24, h: 10 }], blocksPlacement: true },
    signpost: { texture: 'signpost', colliders: [{ x: 6, y: 16, w: 5, h: 5 }] },
    treeWisteria: { texture: 'tree-wisteria', colliders: [{ x: 11, y: 30, w: 10, h: 9 }], blocksPlacement: true },
    lampPost: { texture: 'lamp-post', colliders: [{ x: 4, y: 25, w: 4, h: 4 }] },
    streetLight: { texture: 'street-light', colliders: [{ x: 9, y: 31, w: 4, h: 4 }] },
    fenceWoodH: { texture: 'fence-wood-h', colliders: [{ x: 0, y: 9, w: 16, h: 6 }] },
    fenceWoodV: { texture: 'fence-wood-v', colliders: [{ x: 6, y: 0, w: 4, h: 16 }] },
    fenceStoneH: { texture: 'fence-stone-h', colliders: [{ x: 0, y: 8, w: 16, h: 7 }] },
    fenceStoneV: { texture: 'fence-stone-v', colliders: [{ x: 4, y: 0, w: 8, h: 16 }] },
};

/** Moves the player to another scene. `spawn` names a spawn point in that scene. */
export interface Warp
{
    scene: string;
    spawn: string;
}

/** An object placed on a map. x / y are TILE coordinates of its top-left corner (fractions allowed). */
export interface PlacedObject
{
    kind: ObjectKind;
    x: number;
    y: number;
    /** Added to the normal y-sort depth (e.g. torches mounted on the front of an arch). */
    depthBias?: number;
    /** Use this texture instead of the kind's default (biome variants of the same prop). */
    texture?: string;
}

export interface SpawnedObject
{
    image: GameObjects.Image | GameObjects.Sprite;
    /** World-pixel interaction anchor, if the type is interactive. */
    interactPoint: { x: number; y: number } | null;
    /** World-pixel rect where NPC buildings may not be placed, if any. */
    noPlacement: Rect | null;
    /** The object's collision zones (inside `obstacles`); remove these to take the object away again. */
    zones: GameObjects.Zone[];
}

export function spawnObject (scene: Scene, obstacles: Physics.Arcade.StaticGroup, obj: PlacedObject): SpawnedObject
{
    const type = OBJECT_TYPES[obj.kind];
    const px = Math.round(obj.x * TILE);
    const py = Math.round(obj.y * TILE);

    const image = type.anim
        ? scene.add.sprite(px, py, obj.texture ?? type.texture, 0).setOrigin(0, 0).play({ key: type.anim, delay: Math.random() * 900 })
        : scene.add.image(px, py, obj.texture ?? type.texture).setOrigin(0, 0);
    // Y-sort: things lower on screen draw in front.
    image.setDepth(py + image.height + (obj.depthBias ?? 0));

    const zones = (type.colliders ?? []).map(({ x, y, w, h }) =>
    {
        const zone = scene.add.zone(px + x, py + y, w, h).setOrigin(0, 0);
        obstacles.add(zone);
        return zone;
    });

    return {
        image,
        interactPoint: type.interactAt ? { x: px + type.interactAt.x, y: py + type.interactAt.y } : null,
        noPlacement: type.blocksPlacement ? { x: px, y: py, w: image.width, h: image.height } : null,
        zones,
    };
}
