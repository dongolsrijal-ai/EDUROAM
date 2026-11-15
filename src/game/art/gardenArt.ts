// VILLAGE GARDEN ART (Emory Hacks-inspired spring garden), all original pixel art drawn on
// whole pixels: ground tileset, trees, cottage, rocks, plants and the ambient insects.
// Colors come from GARDEN in config.ts. Texture keys are reused by world/objectTypes.ts and
// world/critters.ts; to swap in real art, load an image under the same key in Boot.preload.

import type { Scene } from 'phaser';
import { GARDEN as G, TILE } from '../config';
import { ascii, disc, rect, type Ctx, type Palette } from './pixel';

// ---------------------------------------------------------------- ground tileset

/** Tile indices inside the 'ground' tileset. PATH..PATH+15 are path tiles with a grass edge on
 *  the sides in their bitmask (N = 1, E = 2, S = 4, W = 8), so paths get soft, grassy borders. */
export const GROUND = {
    GRASS: 0,
    GRASS_LIGHT: 1,
    GRASS_DARK: 2,
    CLOVER: 3,
    TINY_FLOWERS: 4,
    LEAVES: 5,
    MUSHROOM: 6,
    WATER: 7,
    WATER_LILY: 8,
    PATH_PEBBLES: 9,
    PATH: 10,
} as const;

export const PATH_EDGE = { N: 1, E: 2, S: 4, W: 8 } as const;
const TILE_COUNT = GROUND.PATH + 16;

/** Ground tiles the player cannot walk on. */
export const SOLID_GROUND = [GROUND.WATER, GROUND.WATER_LILY];

export const isPathTile = (index: number) =>
    index === GROUND.PATH_PEBBLES || (index >= GROUND.PATH && index < GROUND.PATH + 16);

// ---------------------------------------------------------------- helpers

function texture (scene: Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void)
{
    if (scene.textures.exists(key)) return null;
    const tex = scene.textures.createCanvas(key, w, h);
    if (!tex) throw new Error(`Could not create texture "${key}"`);
    draw(tex.getContext());
    tex.refresh();
    return tex;
}

/** A horizontal strip of equally sized frames drawn from ASCII art (frame i = index i). */
function sheet (scene: Scene, key: string, w: number, h: number, frames: string[][], palette: Palette)
{
    const tex = texture(scene, key, w * frames.length, h, (ctx) => frames.forEach((rows, i) => ascii(ctx, rows, palette, i * w, 0)));
    frames.forEach((_, i) => tex?.add(i, 0, i * w, 0, w, h));
}

/** Mirrors a left half around a centre column (for symmetric insects). */
const sym = (left: string, centre: string) => left + centre + [...left].reverse().join('');

/** Shifts the given rows one pixel right (a gentle "sway" frame). */
const sway = (rows: string[], from: number, to: number) =>
    rows.map((row, i) => (i >= from && i <= to ? `.${row.slice(0, -1)}` : row));

// ---------------------------------------------------------------- textures

export function drawGarden (scene: Scene)
{
    for (const [key, style] of Object.entries(PATH_TILESETS)) groundTileset(scene, key, style);
    trees(scene);
    cottage(scene);
    rock(scene);
    plants(scene);
    insects(scene);
}

/** How path tiles are drawn: colours + an optional paving pattern over the base fill. */
interface PathStyle
{
    base: string;
    dark: string;
    light: string;
    pave?: (ctx: Ctx, px: number) => void;
}

const DIRT_PATH: PathStyle = { base: G.dirt, dark: G.dirtDark, light: G.dirtLight };

/** Rounded stones in a brick-like bond with `grout` showing between them. */
const cobbles = (stone: string, hi: string, grout: string, moss?: string) => (ctx: Ctx, px: number) =>
{
    rect(ctx, px, 0, TILE, TILE, grout);
    for (let row = 0; row < 4; row++)
    {
        for (let x = (row % 2 ? -4 : 0); x < TILE; x += 8)
        {
            const left = Math.max(0, x);
            const width = Math.min(TILE, x + 7) - left;
            rect(ctx, px + left, row * 4, width, 3, stone);
            if (width > 2) rect(ctx, px + left, row * 4, width - 1, 1, hi);
        }
    }
    if (moss) for (const [x, y] of [[3, 3], [11, 7], [6, 11], [14, 15], [0, 7]]) { rect(ctx, px + x, y, 2, 1, moss); rect(ctx, px + x, y - 1, 1, 1, moss); }
};

/** Village path styles sold in the crystal shop (tileset key -> style). 'ground' is the default dirt. */
export const PATH_TILESETS: Record<string, PathStyle> = {
    ground: DIRT_PATH,
    'ground-cobble': { base: G.stone, dark: G.stoneDark, light: G.stoneLight, pave: cobbles(G.stone, G.stoneLight, G.stoneDark) },
    'ground-mossy': { base: '#b9c2a4', dark: '#8f9a80', light: '#d3dabf', pave: cobbles('#b9c2a4', '#d3dabf', '#7fa56a', G.moss) },
};

function groundTileset (scene: Scene, key = 'ground', path: PathStyle = DIRT_PATH)
{
    texture(scene, key, TILE * TILE_COUNT, TILE, (ctx) =>
    {
        const at = (index: number) => index * TILE;
        const tuft = (ox: number, x: number, y: number, color: string = G.grassDeep) =>
        {
            rect(ctx, ox + x, y + 1, 1, 1, color);
            rect(ctx, ox + x + 1, y, 1, 1, color);
            rect(ctx, ox + x + 2, y + 1, 1, 1, color);
        };
        const grass = (index: number, base: string, accent: string) =>
        {
            const ox = at(index);
            rect(ctx, ox, 0, TILE, TILE, base);
            tuft(ox, 2, 3, accent);
            tuft(ox, 10, 10, accent);
            rect(ctx, ox + 7, 13, 1, 1, G.grassLight);
            return ox;
        };

        grass(GROUND.GRASS, G.grass, G.grassDeep);
        grass(GROUND.GRASS_LIGHT, G.grassLight, G.grassDark);
        grass(GROUND.GRASS_DARK, G.grassDark, G.grassDeep);

        // Clovers
        let ox = grass(GROUND.CLOVER, G.grass, G.grassDark);
        for (const [x, y] of [[3, 3], [10, 9]])
        {
            rect(ctx, ox + x, y, 2, 2, G.clover);
            rect(ctx, ox + x + 2, y, 2, 2, G.clover);
            rect(ctx, ox + x + 1, y + 2, 2, 2, G.clover);
            rect(ctx, ox + x, y, 1, 1, G.cloverLight);
            rect(ctx, ox + x + 3, y, 1, 1, G.cloverLight);
        }

        // Tiny flowers (also used as flower borders along paths)
        ox = grass(GROUND.TINY_FLOWERS, G.grass, G.grassDark);
        for (const [x, y, petal] of [[4, 5, G.pink], [11, 10, G.cream], [8, 13, G.pinkLight]] as [number, number, string][])
        {
            for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) rect(ctx, ox + x + dx, y + dy, 1, 1, petal);
            rect(ctx, ox + x, y, 1, 1, G.yellow);
        }

        // Fallen leaves
        ox = grass(GROUND.LEAVES, G.grass, G.grassDark);
        for (const [x, y, color] of [[3, 5, G.peach], [10, 10, G.coral]] as [number, number, string][])
        {
            rect(ctx, ox + x, y, 3, 2, color);
            rect(ctx, ox + x + 1, y - 1, 2, 1, color);
            rect(ctx, ox + x + 1, y, 2, 1, G.coralDark);
        }

        // A tiny mushroom
        ox = grass(GROUND.MUSHROOM, G.grass, G.grassDark);
        rect(ctx, ox + 6, 13, 6, 1, G.grassDeep);
        rect(ctx, ox + 7, 9, 3, 4, G.cream);
        rect(ctx, ox + 6, 5, 5, 1, G.coral);
        rect(ctx, ox + 5, 6, 7, 3, G.coral);
        rect(ctx, ox + 5, 8, 7, 1, G.coralDark);
        rect(ctx, ox + 7, 6, 1, 1, G.cream);
        rect(ctx, ox + 9, 7, 1, 1, G.cream);

        // Water + lily pad
        for (const index of [GROUND.WATER, GROUND.WATER_LILY])
        {
            ox = at(index);
            rect(ctx, ox, 0, TILE, TILE, G.water);
            rect(ctx, ox + 2, 4, 4, 1, G.waterLight);
            rect(ctx, ox + 9, 11, 4, 1, G.waterLight);
            rect(ctx, ox + 12, 3, 1, 1, G.waterDark);
        }
        ox = at(GROUND.WATER_LILY);
        disc(ctx, ox + 8, 8, 4, G.lilyDark);
        disc(ctx, ox + 8, 8, 3, G.lily);
        rect(ctx, ox + 8, 6, 3, 2, G.water);
        rect(ctx, ox + 6, 8, 2, 2, G.pinkLight);
        rect(ctx, ox + 6, 8, 1, 1, G.pink);

        // Paths: warm dirt + pebbles; edge variants grow grass along the sides that touch grass.
        const dirt = (index: number, pebbles: boolean) =>
        {
            const px = at(index);
            rect(ctx, px, 0, TILE, TILE, path.base);
            if (path.pave) path.pave(ctx, px);
            else
            {
                for (const [x, y] of [[3, 4], [11, 9], [7, 13]]) rect(ctx, px + x, y, 1, 1, path.dark);
                for (const [x, y] of [[5, 10], [12, 3]]) rect(ctx, px + x, y, 1, 1, path.light);
            }
            if (pebbles && !path.pave)
            {
                for (const [x, y] of [[4, 6], [10, 11]])
                {
                    rect(ctx, px + x, y, 2, 1, G.pebble);
                    rect(ctx, px + x, y + 1, 2, 1, G.pebbleDark);
                }
                rect(ctx, px + 12, 5, 1, 1, G.pebble);
            }
            return px;
        };
        dirt(GROUND.PATH_PEBBLES, true);
        for (let mask = 0; mask < 16; mask++)
        {
            const px = dirt(GROUND.PATH + mask, mask === 0 ? false : (mask & 1) === 0);
            for (let i = 0; i < TILE; i++)
            {
                const depth = 2 + ((i * 7 + 3) % 3 === 0 ? 1 : 0); // bumpy, organic edge
                const blade = i % 5 === 2;                         // the odd blade reaching further in
                if (mask & PATH_EDGE.N) { rect(ctx, px + i, 0, 1, depth, G.grass); rect(ctx, px + i, depth, 1, 1, blade ? G.grassDeep : path.dark); }
                if (mask & PATH_EDGE.S) { rect(ctx, px + i, TILE - depth, 1, depth, G.grass); rect(ctx, px + i, TILE - depth - 1, 1, 1, blade ? G.grassDeep : path.dark); }
                if (mask & PATH_EDGE.W) { rect(ctx, px, i, depth, 1, G.grass); rect(ctx, px + depth, i, 1, 1, blade ? G.grassDeep : path.dark); }
                if (mask & PATH_EDGE.E) { rect(ctx, px + TILE - depth, i, depth, 1, G.grass); rect(ctx, px + TILE - depth - 1, i, 1, 1, blade ? G.grassDeep : path.dark); }
            }
        }
    });
}

/** 32x40 trees with round, layered crowns (same size + trunk position as before, so collisions match). */
function trees (scene: Scene)
{
    const draw = (blossom: [string, string] | null, hanging = false) => (ctx: Ctx) =>
    {
        rect(ctx, 6, 37, 20, 3, G.shadow);
        // Trunk with little roots
        rect(ctx, 12, 24, 8, 15, G.outline);
        rect(ctx, 13, 24, 6, 14, G.trunk);
        rect(ctx, 17, 24, 2, 14, G.trunkDark);
        rect(ctx, 10, 36, 3, 2, G.outline);
        rect(ctx, 19, 36, 3, 2, G.outline);

        const clusters: [number, number, number][] = [[16, 15, 11], [8, 18, 6], [24, 18, 6], [11, 8, 7], [21, 8, 7]];
        for (const [x, y, r] of clusters) disc(ctx, x, y, r + 1, G.outline);
        for (const [x, y, r] of clusters) disc(ctx, x, y, r, G.leafDark);
        for (const [x, y, r] of clusters) disc(ctx, x - 1, y - 1, r - 1, G.leafMid);
        for (const [x, y, r] of clusters) disc(ctx, x - 1, y - 2, Math.max(1, r - 3), G.leaf);
        for (const [x, y] of [[9, 5], [18, 5], [12, 12], [5, 16], [21, 15]]) disc(ctx, x, y, 1, G.leafHi);

        if (blossom)
        {
            for (const [x, y] of [[7, 9], [14, 5], [22, 7], [25, 14], [18, 12], [10, 15], [5, 20], [15, 20], [23, 21], [12, 22], [19, 3], [27, 18]])
            {
                rect(ctx, x, y, 2, 2, blossom[0]);
                rect(ctx, x, y, 1, 1, blossom[1]);
                if (hanging) { rect(ctx, x, y + 2, 1, 2, blossom[0]); rect(ctx, x + 1, y + 2, 1, 1, blossom[1]); }
            }
        }
    };
    texture(scene, 'tree', 32, 40, draw(null));
    texture(scene, 'tree-blossom', 32, 40, draw([G.pink, G.pinkLight]));
    texture(scene, 'tree-wisteria', 32, 40, draw([G.lavender, '#e6dcff'], true)); // crystal shop decoration
}

/** Home customization bought in the crystal shop (see world/villageLook.ts). */
export interface HouseStyle
{
    /** 0 = cottage, 1 = second storey, 2 = manor (second storey + attic gable + turret). */
    tier: 0 | 1 | 2;
    roof: 'coral' | 'slate';
    door: 'wood' | 'blue';
    shutters: boolean;
}

export const DEFAULT_HOUSE: HouseStyle = { tier: 0, roof: 'coral', door: 'wood', shutters: false };

/** The original cottage keeps the key 'house'; every other style gets its own texture. */
export const houseTextureKey = ({ tier, roof, door, shutters }: HouseStyle) =>
    (tier === 0 && roof === 'coral' && door === 'wood' && !shutters ? 'house' : `house-${tier}-${roof}-${door}-${shutters ? 1 : 0}`);

/**
 * Draws the home for a style (once per style) and returns its texture key. Every style is 64 px
 * wide with the SAME ground floor, door and footprint as the cottage; upgrades only add height
 * above it, so the collider and door position never change (Hub lifts the taller sprite).
 */
export function drawHouse (scene: Scene, style: HouseStyle = DEFAULT_HOUSE): string
{
    const key = houseTextureKey(style);
    const storey = style.tier ? 16 : 0;       // extra wall height
    const top = style.tier === 2 ? 10 : 0;    // room above the roof for the turret
    const g = top + storey;                   // y offset of the ground floor
    const roof = style.roof === 'slate'
        ? { main: '#7f9bd1', dark: '#5f7cb8', hi: '#a9c0ea' }
        : { main: G.coral, dark: G.coralDark, hi: G.peach };

    texture(scene, key, 64, 64 + g, (ctx) =>
    {
        rect(ctx, 4, 60 + g, 58, 4, G.shadow);

        // Stone chimney (behind the roof)
        rect(ctx, 46, top, 8, 10, G.outline);
        rect(ctx, 47, top + 1, 6, 9, G.stoneDark);
        rect(ctx, 47, top + 1, 6, 2, G.stone);

        // Walls
        rect(ctx, 5, 30 + top, 54, 32 + storey, G.outline);
        rect(ctx, 6, 31 + top, 52, 30 + storey, G.cream);
        rect(ctx, 6, 31 + top, 3, 30 + storey, G.creamDark);
        rect(ctx, 55, 31 + top, 3, 30 + storey, G.creamDark);
        rect(ctx, 6, 57 + g, 52, 4, G.stone);
        for (const x of [12, 24, 36, 48]) rect(ctx, x, 57 + g, 1, 4, G.stoneDark);

        // Second storey: a timber beam and three small windows
        if (storey)
        {
            rect(ctx, 6, 31 + g, 52, 2, G.woodDark);
            rect(ctx, 6, 31 + g, 52, 1, G.wood);
            for (const wx of [14, 28, 42])
            {
                rect(ctx, wx - 1, 37 + top, 10, 9, G.outline);
                rect(ctx, wx, 38 + top, 8, 7, G.sky);
                rect(ctx, wx + 1, 39 + top, 2, 2, G.cream);
                rect(ctx, wx + 3, 38 + top, 2, 7, G.outline);
            }
        }

        // Windows with flower boxes (+ shutters and fuller boxes when upgraded)
        for (const wx of [13, 41])
        {
            rect(ctx, wx - 1, 37 + g, 12, 12, G.outline);
            rect(ctx, wx, 38 + g, 10, 10, G.sky);
            rect(ctx, wx + 1, 39 + g, 2, 2, G.cream);
            rect(ctx, wx + 4, 38 + g, 2, 10, G.outline);
            rect(ctx, wx, 42 + g, 10, 1, G.outline);
            rect(ctx, wx - 1, 49 + g, 12, 3, G.woodDark);
            for (let i = 0; i < 5; i++) rect(ctx, wx + i * 2, 48 + g, 1, 1, i % 2 ? G.yellow : G.pink);
            if (style.shutters)
            {
                for (const sx of [wx - 4, wx + 11])
                {
                    rect(ctx, sx, 37 + g, 3, 12, G.outline);
                    rect(ctx, sx, 38 + g, 2, 10, G.leafDark);
                    for (let y = 39; y < 48; y += 2) rect(ctx, sx, y + g, 2, 1, G.leafMid);
                }
                for (let i = 0; i < 6; i++) { rect(ctx, wx - 1 + i * 2, 47 + g, 2, 2, i % 2 ? G.coral : G.lavender); rect(ctx, wx - 1 + i * 2, 47 + g, 1, 1, G.butter); }
                rect(ctx, wx - 1, 49 + g, 12, 1, G.leaf);
            }
        }

        // Round-topped door (painted blue with a brass knocker when upgraded)
        const blue = style.door === 'blue';
        rect(ctx, 26, 42 + g, 12, 20, G.outline);
        rect(ctx, 27, 40 + g, 10, 2, G.outline);
        rect(ctx, 27, 43 + g, 10, 18, blue ? G.skyDark : G.wood);
        rect(ctx, 28, 41 + g, 8, 2, blue ? G.skyDark : G.wood);
        rect(ctx, 31, 43 + g, 1, 18, blue ? '#4f86c9' : G.woodDark);
        rect(ctx, 34, 51 + g, 2, 2, G.yellow);
        if (blue) { rect(ctx, 29, 45 + g, 4, 1, G.sky); rect(ctx, 31, 47 + g, 2, 2, G.yellow); rect(ctx, 28, 58 + g, 8, 1, '#4f86c9'); }

        // Scalloped roof
        rect(ctx, 1, 4 + top, 62, 31, G.outline);
        rect(ctx, 2, 5 + top, 60, 29, roof.main);
        for (let y = 9, row = 0; y < 34; y += 5, row++)
        {
            for (let x = 2 + (row % 2) * 3; x < 62; x += 6) rect(ctx, x, y + top, 4, 1, roof.dark);
        }
        rect(ctx, 2, 5 + top, 60, 2, roof.hi);
        rect(ctx, 6, 35 + top, 52, 2, G.creamDark);

        if (style.tier === 2)
        {
            // Attic gable with a round window
            rect(ctx, 23, 12 + top, 18, 18, G.outline);
            rect(ctx, 24, 13 + top, 16, 17, G.cream);
            for (let i = 0; i < 6; i++) rect(ctx, 21 + i * 2, 12 + top - i, 22 - i * 4, 2, i ? roof.dark : G.outline);
            rect(ctx, 21, 12 + top, 22, 1, G.outline);
            disc(ctx, 32, 21 + top, 4, G.outline);
            disc(ctx, 32, 21 + top, 3, G.sky);
            rect(ctx, 32, 18 + top, 1, 7, G.outline);

            // Turret on the left corner with a pointed cap and a gold finial
            rect(ctx, 3, 9, 15, 30, G.outline);
            rect(ctx, 4, 10, 13, 29, G.cream);
            rect(ctx, 4, 10, 2, 29, G.creamDark);
            rect(ctx, 8, 16, 5, 8, G.outline);
            rect(ctx, 9, 17, 3, 6, G.sky);
            for (let i = 0; i < 9; i++) { rect(ctx, 9 - i, 1 + i, 2 * i + 3, 1, roof.main); rect(ctx, 9 - i, 1 + i, 1, 1, G.outline); rect(ctx, 11 + i, 1 + i, 1, 1, G.outline); }
            rect(ctx, 1, 10, 19, 1, G.outline);
            rect(ctx, 10, 0, 1, 2, G.yellow);
        }

        // Climbing vine with pink blossoms on the left wall (it grows with the house)
        for (let y = 56 + g; y > 35 + (style.tier === 2 ? g : top); y -= 3)
        {
            const x = ((56 + g - y) / 3) % 2 ? 8 : 7;
            rect(ctx, x, y, 2, 3, G.leafMid);
            rect(ctx, x + 1, y, 1, 1, G.leaf);
        }
        for (const [x, y] of [[9, 52], [6, 45], [10, 39]]) { rect(ctx, x, y + g, 2, 2, G.pink); rect(ctx, x, y + g, 1, 1, G.pinkLight); }
    });
    return key;
}

const cottage = (scene: Scene) => { drawHouse(scene); };

function rock (scene: Scene)
{
    texture(scene, 'rock', 16, 16, (ctx) =>
    {
        rect(ctx, 2, 14, 12, 2, G.shadow);
        disc(ctx, 9, 10, 5, G.outline);
        disc(ctx, 4, 12, 3, G.outline);
        disc(ctx, 9, 10, 4, G.stone);
        disc(ctx, 4, 12, 2, G.stone);
        disc(ctx, 8, 9, 2, G.stoneLight);
        rect(ctx, 11, 12, 2, 1, G.stoneDark);
        rect(ctx, 3, 13, 2, 1, G.stoneDark);
        for (const [x, y] of [[7, 6], [8, 6], [9, 6], [10, 7], [6, 7]]) rect(ctx, x, y, 1, 1, G.moss);
    });
}

function plants (scene: Scene)
{
    // Flower clusters (2-frame gentle sway). Keys kept from before: pink + cream varieties.
    const cluster = [
        '................',
        '................',
        '...p............',
        '..pyp.......p...',
        '...p.......pyp..',
        '...g........p...',
        '...g.....p..g...',
        '..lg....pyp.g...',
        '...g.....p.gl...',
        '...g.....g..g...',
        '...gl...lg..g...',
        '....g....g.g....',
        '....g...gg.g....',
        '.....g..g.g.....',
        '......ggggg.....',
        '................',
    ];
    for (const [key, petal] of [['flowers-red', G.pink], ['flowers-white', G.cream]] as [string, string][])
    {
        sheet(scene, key, 16, 16, [cluster, sway(cluster, 2, 8)], { p: petal, y: G.yellow, g: G.leafMid, l: G.leaf });
    }

    const sunflower = [
        '................',
        '.....oooooo.....',
        '....oYYYYYYo....',
        '...oYYbbbbYYo...',
        '...oYbBBBBbYo...',
        '...oYbBBBBbYo...',
        '...oYbBBBBbYo...',
        '...oYYbbbbYYo...',
        '....oYYYYYYo....',
        '.....oooooo.....',
        '.......gg.......',
        '.......gg..ll...',
        '...ll..gg.lLl...',
        '..lLl..gg.ll....',
        '...ll..gg.......',
        '.......gg.......',
        '.......gg..ll...',
        '.......gg.lLl...',
        '.......gg..ll...',
        '.......gg.......',
        '.......gg.......',
        '......gggg......',
        '.....ssssss.....',
        '................',
    ];
    sheet(scene, 'sunflower', 16, 24, [sunflower, sway(sunflower, 0, 9)], {
        o: G.outlineSoft, Y: G.yellow, b: G.trunk, B: G.trunkDark, g: G.leafMid, l: G.leaf, L: G.leafHi, s: G.shadow,
    });

    const bush = (flowers: boolean) => (ctx: Ctx) =>
    {
        rect(ctx, 2, 14, 12, 2, G.shadow);
        const blobs: [number, number, number][] = [[5, 10, 4], [11, 10, 4], [8, 7, 5]];
        for (const [x, y, r] of blobs) disc(ctx, x, y, r + 1, G.outline);
        for (const [x, y, r] of blobs) disc(ctx, x, y, r, G.leafDark);
        for (const [x, y, r] of blobs) disc(ctx, x - 1, y - 1, r - 1, G.leafMid);
        disc(ctx, 6, 5, 1, G.leafHi);
        disc(ctx, 3, 9, 1, G.leaf);
        if (flowers) for (const [x, y] of [[4, 8], [9, 4], [12, 9], [7, 11]]) { rect(ctx, x, y, 2, 2, G.pink); rect(ctx, x, y, 1, 1, G.pinkLight); }
    };
    texture(scene, 'bush', 16, 16, bush(false));
    texture(scene, 'bush-flower', 16, 16, bush(true));

    // 32x16 raised flower bed with a wooden border
    texture(scene, 'flower-bed', 32, 16, (ctx) =>
    {
        rect(ctx, 1, 14, 30, 2, G.shadow);
        rect(ctx, 0, 6, 32, 9, G.outline);
        rect(ctx, 1, 7, 30, 7, G.wood);
        rect(ctx, 3, 8, 26, 4, G.dirtDark);
        for (const x of [8, 16, 24]) rect(ctx, x, 12, 1, 2, G.woodDark);
        const heads = [G.pink, G.yellow, G.lavender, G.cream, G.coral, G.pink, G.yellow];
        heads.forEach((color, i) =>
        {
            const x = 4 + i * 4;
            const y = 3 + (i % 2);
            rect(ctx, x + 1, y + 3, 1, 4, G.leafMid);
            rect(ctx, x, y, 3, 3, color);
            rect(ctx, x + 1, y + 1, 1, 1, G.butter);
            rect(ctx, x + 2, y + 5, 1, 1, G.leaf);
        });
    });

    texture(scene, 'fern', 16, 16, (ctx) => ascii(ctx, [
        '................',
        '................',
        '.......l........',
        '..l...lgl...l...',
        '...l..lgl..l....',
        '.l.ll.lgl.ll.l..',
        '..llg.lgl.gll...',
        '....lglgllgl....',
        '.lll.lgggl.lll..',
        '...lllgggllll...',
        '.....lggggl.....',
        '...llllgglll....',
        '.......gg.......',
        '......ssss......',
    ], { l: G.leafMid, g: G.leafDark, s: G.shadow }));
}

// ---------------------------------------------------------------- insects (ambient, 2-frame sheets)

function insects (scene: Scene)
{
    const open = [
        sym('...a.', '.'), sym('.oo.a', '.'), sym('oWWo.', 'b'), sym('oWwWo', 'b'), sym('oWWWo', 'b'),
        sym('.oPPo', 'b'), sym('.oPPo', 'b'), sym('..oo.', 'b'), sym('.....', '.'),
    ];
    const folded = [
        sym('...a.', '.'), sym('...oa', '.'), sym('..oWo', 'b'), sym('..oWW', 'b'), sym('..oWW', 'b'),
        sym('...oP', 'b'), sym('...oP', 'b'), sym('....o', 'b'), sym('.....', '.'),
    ];
    const wings: [string, string, string][] = [
        ['butterfly-blue', G.sky, G.skyDark],
        ['butterfly-pink', G.pinkLight, G.pink],
        ['butterfly-yellow', G.butter, G.yellow],
    ];
    for (const [key, light, main] of wings)
    {
        sheet(scene, key, 11, 9, [open, folded], { a: G.outline, o: G.outline, W: main, w: G.cream, P: light, b: G.trunkDark });
    }

    sheet(scene, 'bee', 10, 8, [
        ['...ww.....', '..wwww....', '..oooooo..', '.oYKYKYYo.', 'soYKYKYEYo', '.oYKYKYYo.', '..oooooo..', '..........'],
        ['..........', '...ww.....', '..owwooo..', '.oYKYKYYo.', 'soYKYKYEYo', '.oYKYKYYo.', '..oooooo..', '..........'],
    ], { w: '#e3f4ff', o: G.outline, Y: G.yellow, K: G.trunkDark, E: G.outline, s: G.outline });

    sheet(scene, 'ladybug', 7, 8, [
        ['.a...a.', '..aKa..', '.oRoRo.', 'kDRoRDk', 'oRRoRRo', 'oRDoDRo', '.oRoRo.', '..ooo..'],
        ['.a...a.', '..aKa..', '.oRoRo.', 'oDRoRDo', 'kRRoRRk', 'oRDoDRo', '.oRoRo.', '..ooo..'],
    ], { a: G.outline, K: G.outline, o: G.outline, k: G.outline, R: '#ef5a4c', D: G.outline });

    sheet(scene, 'snail', 12, 9, [
        ['....oooo..a.', '...oSSSSo.a.', '..oSssssSoP.', '..oSsSSsSoPP', '..oSsoSsSoPP', '..oSSssSSoP.', '.PPPPPPPPPP.', '.oooooooooo.', '............'],
        ['....oooo...a', '...oSSSSo..a', '..oSssssSo.P', '..oSsSSsSoPP', '..oSsoSsSoPP', '..oSSssSSoPP', 'PPPPPPPPPPP.', 'ooooooooooo.', '............'],
    ], { o: G.outlineSoft, a: G.outlineSoft, S: '#c98b7a', s: '#a1665a', P: G.peach });

    sheet(scene, 'caterpillar', 13, 6, [
        ['..........a.a', '.ooooooooooo.', 'oGgGgGgGgGGGo', 'oGgGgGgGgGeGo', '.ofofofofooo.', '.............'],
        ['..........a.a', '.ooooooooooo.', 'oGgGgGgGgGGGo', 'oGgGgGgGgGeGo', '.oofofofofoo.', '.............'],
    ], { a: G.outline, o: G.lilyDark, G: G.cloverLight, g: G.clover, e: G.outline, f: G.lilyDark });

    texture(scene, 'leaf', 5, 4, (ctx) => ascii(ctx, ['.pp..', 'pPPp.', '.pPPp', '..pp.'], { p: G.coral, P: G.peach }));
    texture(scene, 'petal', 3, 3, (ctx) => ascii(ctx, ['.p.', 'pPp', '.p.'], { p: G.pink, P: G.pinkLight }));
}

/** Looping 2-frame animations for swaying plants and insects (created once, in Boot). */
export function createGardenAnimations (scene: Scene)
{
    const loops: [string, number][] = [
        ['flowers-red', 1.4], ['flowers-white', 1.2], ['sunflower', 1.1],
        ['butterfly-blue', 8], ['butterfly-pink', 8], ['butterfly-yellow', 8],
        ['bee', 14], ['ladybug', 6], ['snail', 2], ['caterpillar', 3],
    ];
    for (const [key, frameRate] of loops)
    {
        if (scene.anims.exists(`${key}-anim`) || !scene.textures.exists(key)) continue;
        scene.anims.create({ key: `${key}-anim`, frames: [{ key, frame: 0 }, { key, frame: 1 }], frameRate, repeat: -1 });
    }
}
