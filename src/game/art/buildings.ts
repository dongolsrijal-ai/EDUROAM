// Placeholder art for NPC buildings (64x56) in the village garden style (GARDEN palette,
// soft brown outlines). Shared shell + per-theme details. The footprint, door position and
// side-prop area (x 50..63) match buildings/buildingTypes.ts, so collisions are unchanged.

import type { Scene } from 'phaser';
import { BUILDING_H, BUILDING_TYPES, BUILDING_W, type BuildingType } from '../buildings/buildingTypes';
import { GARDEN as G } from '../config';
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
    rect(ctx, 2, 52, 48, 4, G.shadow);

    rect(ctx, 2, 22, 46, 32, G.outline);
    rect(ctx, 3, 23, 44, 30, s.wall);
    rect(ctx, 3, 49, 44, 4, s.wallDark);

    // Round-topped door
    rect(ctx, 18, 34, 12, 20, G.outline);
    rect(ctx, 19, 33, 10, 1, G.outline);
    rect(ctx, 19, 35, 10, 18, s.door);
    rect(ctx, 20, 34, 8, 1, s.door);
    rect(ctx, 26, 43, 2, 2, G.yellow);

    // Soft scalloped roof
    rect(ctx, 0, 4, 50, 22, G.outline);
    rect(ctx, 1, 5, 48, 20, s.roof);
    for (let y = 9, row = 0; y < 25; y += 4, row++)
    {
        for (let x = 1 + (row % 2) * 3; x < 49; x += 6) rect(ctx, x, y, 4, 1, s.roofDark);
    }
    rect(ctx, 1, 5, 48, 2, s.roofLight);
    rect(ctx, 3, 26, 44, 2, s.wallDark);
}

function window (ctx: Ctx, x: number, y: number, glass: string, frame = G.outline)
{
    rect(ctx, x - 1, y - 1, 10, 10, frame);
    rect(ctx, x, y, 8, 8, glass);
    rect(ctx, x + 1, y + 1, 2, 2, G.cream);
    rect(ctx, x + 3, y, 2, 8, frame);
}

/** Flower box under a window. */
function flowerBox (ctx: Ctx, x: number, y: number, colors = [G.pink, G.yellow, G.pinkLight])
{
    rect(ctx, x - 1, y, 10, 3, G.woodDark);
    for (let i = 0; i < 4; i++) rect(ctx, x + i * 2, y - 1, 1, 1, colors[i % colors.length]);
    rect(ctx, x + 1, y - 2, 1, 1, G.leaf);
    rect(ctx, x + 6, y - 2, 1, 1, G.leaf);
}

/** A climbing vine with blossoms. */
function vine (ctx: Ctx, points: [number, number][], blossom = G.pink)
{
    for (const [x, y] of points)
    {
        rect(ctx, x, y, 2, 3, G.leafMid);
        rect(ctx, x + 1, y, 1, 1, G.leaf);
    }
    points.forEach(([x, y], i) => { if (i % 3 === 1) { rect(ctx, x + 1, y + 1, 2, 2, blossom); rect(ctx, x + 1, y + 1, 1, 1, G.pinkLight); } });
}

const DRAW: Record<BuildingType, (ctx: Ctx) => void> = {
    trainingHall (ctx)
    {
        shell(ctx, { wall: G.stone, wallDark: G.stoneDark, roof: G.wood, roofDark: G.woodDark, roofLight: G.peach, door: G.woodDark });
        // Soft stone blocks
        for (const y of [31, 37, 43]) rect(ctx, 3, y, 44, 1, G.stoneDark);
        for (const [x, y] of [[9, 28], [40, 28], [12, 38], [36, 38], [8, 44], [42, 44]]) rect(ctx, x, y, 1, 5, G.stoneDark);
        // Shields + little banners
        for (const [cx, color] of [[10, G.coral], [39, G.sky]] as [number, string][])
        {
            disc(ctx, cx, 36, 5, G.outline);
            disc(ctx, cx, 36, 4, color);
            rect(ctx, cx - 1, 33, 2, 6, G.yellow);
            rect(ctx, cx - 3, 35, 6, 2, G.yellow);
        }
        for (const x of [14, 33])
        {
            rect(ctx, x, 27, 3, 6, G.coral);
            rect(ctx, x + 1, 33, 1, 1, G.coral);
            rect(ctx, x, 27, 3, 1, G.yellow);
        }
        vine(ctx, [[3, 46], [4, 43], [3, 40], [4, 37], [3, 34], [4, 31], [3, 28]]);
        vine(ctx, [[45, 46], [44, 43], [45, 40], [44, 37], [45, 34]], G.lavender);
        // Training dummy
        rect(ctx, 56, 34, 3, 20, G.woodDark);
        rect(ctx, 50, 38, 14, 2, G.wood);
        disc(ctx, 57, 42, 4, G.outline);
        disc(ctx, 57, 42, 3, G.yellow);
        disc(ctx, 57, 32, 3, G.outline);
        disc(ctx, 57, 32, 2, G.yellow);
        rect(ctx, 52, 53, 11, 2, G.shadow);
    },

    clinic (ctx)
    {
        shell(ctx, { wall: G.cream, wallDark: G.creamDark, roof: '#a9d6f2', roofDark: '#86bfe3', roofLight: '#d3ecfb', door: '#86bfe3' });
        window(ctx, 7, 31, '#cdeaff');
        window(ctx, 35, 31, '#cdeaff');
        flowerBox(ctx, 7, 40);
        flowerBox(ctx, 35, 40, [G.sky, G.pinkLight, G.yellow]);
        // Medical sign on the roof
        rect(ctx, 18, 8, 13, 13, G.outline);
        rect(ctx, 19, 9, 11, 11, '#ffffff');
        rect(ctx, 23, 10, 3, 9, G.coral);
        rect(ctx, 20, 13, 9, 3, G.coral);
        // Patient bed with a pastel blanket
        rect(ctx, 50, 38, 13, 12, G.outline);
        rect(ctx, 51, 39, 11, 10, '#ffffff');
        rect(ctx, 51, 43, 11, 6, '#a9d6f2');
        rect(ctx, 51, 49, 2, 4, G.outline);
        rect(ctx, 60, 49, 2, 4, G.outline);
        rect(ctx, 50, 53, 13, 2, G.shadow);
    },

    laboratory (ctx)
    {
        // Chimney with soft green steam (drawn before the roof)
        rect(ctx, 37, 0, 7, 8, G.outline);
        rect(ctx, 38, 1, 5, 7, G.stoneDark);
        shell(ctx, { wall: '#d9e4ea', wallDark: '#b5c6cf', roof: G.lavender, roofDark: '#a892e6', roofLight: '#e3d8ff', door: '#a892e6' });
        // Large glass windows framed by potted plants
        for (const x of [5, 33])
        {
            rect(ctx, x - 1, 29, 13, 14, G.outline);
            rect(ctx, x, 30, 11, 12, G.sky);
            rect(ctx, x + 2, 32, 1, 4, '#ffffff');
            rect(ctx, x + 3, 31, 1, 2, '#ffffff');
            rect(ctx, x, 43, 3, 3, G.coral);            // flower pot
            rect(ctx, x, 41, 3, 2, G.leafMid);
            rect(ctx, x + 1, 40, 1, 1, G.leaf);
        }
        vine(ctx, [[16, 44], [16, 41], [16, 38], [16, 35]], G.butter);
        disc(ctx, 44, 2, 2, '#bff0a8');
        disc(ctx, 48, 0, 1, '#bff0a8');
        // Beaker table
        rect(ctx, 50, 42, 14, 3, G.outline);
        rect(ctx, 51, 43, 12, 1, G.wood);
        rect(ctx, 51, 45, 2, 8, G.outline);
        rect(ctx, 61, 45, 2, 8, G.outline);
        for (const [x, color] of [[51, '#9be88a'], [55, G.sky], [59, G.pink]] as [number, string][])
        {
            rect(ctx, x, 35, 4, 7, G.outline);
            rect(ctx, x + 1, 38, 2, 3, color);
            rect(ctx, x + 1, 36, 2, 2, '#eef9ff');
        }
        rect(ctx, 50, 53, 14, 2, G.shadow);
    },

    farmhouse (ctx)
    {
        shell(ctx, { wall: G.wood, wallDark: G.woodDark, roof: G.coral, roofDark: G.coralDark, roofLight: G.peach, door: G.woodDark });
        // Wooden planks
        for (let x = 6; x < 47; x += 5) rect(ctx, x, 28, 1, 21, G.woodDark);
        window(ctx, 7, 31, G.sky);
        window(ctx, 35, 31, G.sky);
        flowerBox(ctx, 7, 40);
        flowerBox(ctx, 35, 40, [G.yellow, G.coral, G.butter]);
        // Little fence along the front corner
        rect(ctx, 1, 50, 14, 1, G.cream);
        for (const x of [1, 5, 9, 13]) rect(ctx, x, 47, 2, 6, G.cream);
        // Crop patch with sprouts and a pumpkin
        rect(ctx, 50, 30, 14, 24, G.outline);
        rect(ctx, 51, 31, 12, 22, G.dirtDark);
        for (let y = 33; y < 52; y += 5)
        {
            for (const x of [53, 57, 61]) { rect(ctx, x, y, 1, 2, G.leafMid); rect(ctx, x - 1, y, 1, 1, G.leafHi); }
        }
        disc(ctx, 57, 48, 2, G.coral);
        rect(ctx, 57, 45, 1, 1, G.leafMid);
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
