// Kinds of objects that can be placed on a map, and how they collide.
// Add a new decoration/building by drawing a texture in art/textures.ts and adding an entry here.

import { GameObjects, Physics, Scene } from 'phaser';
import { TILE } from '../config';

export interface Rect { x: number; y: number; w: number; h: number }

export type ObjectKind =
    | 'tree' | 'house' | 'rock' | 'flowersRed' | 'flowersWhite'
    | 'dungeonEntrance' | 'sealedStairs' | 'pillar' | 'chest' | 'torch';

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
}

export const OBJECT_TYPES: Record<ObjectKind, ObjectType> = {
    tree: { texture: 'tree', colliders: [{ x: 11, y: 30, w: 10, h: 9 }], blocksPlacement: true },
    house: { texture: 'house', colliders: [{ x: 2, y: 24, w: 60, h: 38 }], blocksPlacement: true },
    rock: { texture: 'rock', colliders: [{ x: 3, y: 7, w: 10, h: 7 }] },
    flowersRed: { texture: 'flowers-red', blocksPlacement: true },
    flowersWhite: { texture: 'flowers-white', blocksPlacement: true },
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
}

export interface SpawnedObject
{
    image: GameObjects.Image;
    /** World-pixel interaction anchor, if the type is interactive. */
    interactPoint: { x: number; y: number } | null;
    /** World-pixel rect where NPC buildings may not be placed, if any. */
    noPlacement: Rect | null;
}

export function spawnObject (scene: Scene, obstacles: Physics.Arcade.StaticGroup, obj: PlacedObject): SpawnedObject
{
    const type = OBJECT_TYPES[obj.kind];
    const px = Math.round(obj.x * TILE);
    const py = Math.round(obj.y * TILE);

    const image = scene.add.image(px, py, type.texture).setOrigin(0, 0);
    // Y-sort: things lower on screen draw in front.
    image.setDepth(py + image.height + (obj.depthBias ?? 0));

    for (const { x, y, w, h } of type.colliders ?? [])
    {
        obstacles.add(scene.add.zone(px + x, py + y, w, h).setOrigin(0, 0));
    }

    return {
        image,
        interactPoint: type.interactAt ? { x: px + type.interactAt.x, y: py + type.interactAt.y } : null,
        noPlacement: type.blocksPlacement ? { x: px, y: py, w: image.width, h: image.height } : null,
    };
}
