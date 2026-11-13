// Placeholder art for NPC buildings (64x56). Shared shell + per-theme details.

import type { Scene } from 'phaser';
import { BUILDING_H, BUILDING_TYPES, BUILDING_W, type BuildingType } from '../buildings/buildingTypes';
import { COLORS as C } from '../config';
import { disc, rect, type Ctx } from './pixel';

interface Shell
{
    wall: string;
    wallDark: string;
    roof: string;
    roofDark: string;
    roofLight: string;
    door: string;
}

/** Walls, roof, door and shadow common to every building (body spans x 0..50). */
function shell (ctx: Ctx, s: Shell)
{
    rect(ctx, 2, 52, 48, 4, C.shadow);

    rect(ctx, 2, 22, 46, 32, C.outline);
    rect(ctx, 3, 23, 44, 30, s.wall);
    rect(ctx, 3, 49, 44, 4, s.wallDark);

    rect(ctx, 18, 33, 12, 21, C.outline);
    rect(ctx, 19, 34, 10, 19, s.door);
    rect(ctx, 26, 43, 2, 2, C.gold);

    rect(ctx, 0, 4, 50, 22, C.outline);
    rect(ctx, 1, 5, 48, 20, s.roof);
    for (let y = 9; y < 25; y += 4) rect(ctx, 1, y, 48, 1, s.roofDark);
    rect(ctx, 1, 5, 48, 2, s.roofLight);
    rect(ctx, 3, 26, 44, 2, s.wallDark);
}

function window (ctx: Ctx, x: number, y: number, glass: string, frame = C.outline)
{
    rect(ctx, x - 1, y - 1, 10, 10, frame);
    rect(ctx, x, y, 8, 8, glass);
    rect(ctx, x + 1, y + 1, 2, 2, C.windowLight);
    rect(ctx, x + 3, y, 2, 8, frame);
}

const DRAW: Record<BuildingType, (ctx: Ctx) => void> = {
    trainingHall (ctx)
    {
        shell(ctx, { wall: C.stone, wallDark: C.stoneDark, roof: C.trunk, roofDark: C.trunkDark, roofLight: '#9a6a40', door: C.trunkDark });
        // Stone bricks
        for (const y of [31, 37, 43]) rect(ctx, 3, y, 44, 1, C.stoneDark);
        for (const [x, y] of [[9, 28], [40, 28], [12, 38], [36, 38], [8, 44], [42, 44]]) rect(ctx, x, y, 1, 5, C.stoneDark);
        // Shields
        for (const [cx, color] of [[10, '#c0392b'], [39, '#2f6fb3']] as [number, string][])
        {
            disc(ctx, cx, 36, 5, C.outline);
            disc(ctx, cx, 36, 4, color);
            rect(ctx, cx - 1, 33, 2, 6, C.gold);
            rect(ctx, cx - 3, 35, 6, 2, C.gold);
        }
        // Training dummy
        rect(ctx, 56, 34, 3, 20, C.trunkDark);
        rect(ctx, 50, 38, 14, 2, C.trunk);
        disc(ctx, 57, 42, 4, C.outline);
        disc(ctx, 57, 42, 3, C.straw);
        disc(ctx, 57, 32, 3, C.outline);
        disc(ctx, 57, 32, 2, C.straw);
        rect(ctx, 52, 53, 11, 2, C.shadow);
    },

    clinic (ctx)
    {
        shell(ctx, { wall: C.coat, wallDark: C.coatShade, roof: '#8fc7e8', roofDark: '#5f9fc8', roofLight: '#c3e4f5', door: '#5f9fc8' });
        window(ctx, 7, 31, '#bfe6ff');
        window(ctx, 35, 31, '#bfe6ff');
        rect(ctx, 7, 31, 8, 2, '#5f9fc8');
        rect(ctx, 35, 31, 8, 2, '#5f9fc8');
        // Medical sign on the roof
        rect(ctx, 18, 8, 13, 13, C.outline);
        rect(ctx, 19, 9, 11, 11, '#ffffff');
        rect(ctx, 23, 10, 3, 9, '#d94141');
        rect(ctx, 20, 13, 9, 3, '#d94141');
        // Patient bed
        rect(ctx, 50, 38, 13, 12, C.outline);
        rect(ctx, 51, 39, 11, 10, '#ffffff');
        rect(ctx, 51, 43, 11, 6, '#8fc7e8');
        rect(ctx, 51, 49, 2, 4, C.outline);
        rect(ctx, 60, 49, 2, 4, C.outline);
        rect(ctx, 50, 53, 13, 2, C.shadow);
    },

    laboratory (ctx)
    {
        // Chimney with green smoke (drawn before the roof)
        rect(ctx, 37, 0, 7, 8, C.outline);
        rect(ctx, 38, 1, 5, 7, C.stoneDark);
        shell(ctx, { wall: '#b7c4cc', wallDark: '#8e9ea8', roof: '#5b4a8a', roofDark: '#443670', roofLight: '#7a68ad', door: '#443670' });
        // Large glass windows
        for (const x of [5, 33])
        {
            rect(ctx, x - 1, 29, 13, 14, C.outline);
            rect(ctx, x, 30, 11, 12, C.goggles);
            rect(ctx, x + 2, 32, 1, 4, '#ffffff');
            rect(ctx, x + 3, 31, 1, 2, '#ffffff');
        }
        disc(ctx, 44, 2, 2, '#9be37a');
        disc(ctx, 48, 0, 1, '#9be37a');
        // Beaker table
        rect(ctx, 50, 42, 14, 3, C.outline);
        rect(ctx, 51, 43, 12, 1, C.chest);
        rect(ctx, 51, 45, 2, 8, C.outline);
        rect(ctx, 61, 45, 2, 8, C.outline);
        for (const [x, color] of [[51, '#7be36b'], [55, '#6bb8ff'], [59, '#c17bff']] as [number, string][])
        {
            rect(ctx, x, 35, 4, 7, C.outline);
            rect(ctx, x + 1, 38, 2, 3, color);
            rect(ctx, x + 1, 36, 2, 2, '#e6f6ff');
        }
        rect(ctx, 50, 53, 14, 2, C.shadow);
    },

    farmhouse (ctx)
    {
        shell(ctx, { wall: C.chest, wallDark: C.chestDark, roof: C.roof, roofDark: C.roofDark, roofLight: C.roofLight, door: C.chestDark });
        // Wooden planks
        for (let x = 6; x < 47; x += 5) rect(ctx, x, 28, 1, 21, C.chestDark);
        window(ctx, 7, 31, C.window);
        window(ctx, 35, 31, C.window);
        // Flower boxes
        rect(ctx, 6, 40, 10, 2, C.trunkDark);
        rect(ctx, 34, 40, 10, 2, C.trunkDark);
        for (const x of [7, 10, 13, 35, 38, 41]) rect(ctx, x, 39, 1, 1, C.flowerRed);
        // Crop patch
        rect(ctx, 50, 30, 14, 24, C.outline);
        rect(ctx, 51, 31, 12, 22, C.pathDark);
        for (let y = 33; y < 52; y += 5)
        {
            for (const x of [53, 57, 61]) { rect(ctx, x, y, 1, 2, C.leaves); rect(ctx, x - 1, y, 1, 1, C.leavesLight); }
        }
    },
};

export function drawBuildings (scene: Scene)
{
    for (const type of Object.keys(DRAW) as BuildingType[])
    {
        const { texture } = BUILDING_TYPES[type];
        if (scene.textures.exists(texture)) continue; // real art loaded instead
        const tex = scene.textures.createCanvas(texture, BUILDING_W, BUILDING_H);
        if (!tex) throw new Error(`Could not create texture "${texture}"`);
        DRAW[type](tex.getContext());
        tex.refresh();
    }
}
