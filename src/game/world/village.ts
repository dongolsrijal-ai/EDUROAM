// The starting village map: size, ground layout and object placements.
// New maps can copy this file's shape (size + buildGround + objects + start point).
// All coordinates here are in TILES (multiply by TILE for pixels).
//
// Look: a cozy spring garden (Emory Hacks-inspired). The paths, pond, buildings and every
// collidable object keep their original positions; the garden decor and critters are extra.

import { GROUND, PATH_EDGE } from '../art/gardenArt';
import type { PlacedObject } from './objectTypes';
import type { CritterSpawn } from './critters';
import { seededRandom } from '../random';

/** MAP DIMENSIONS in tiles. The physics/camera boundary follows these automatically. */
export const MAP_WIDTH = 60;
export const MAP_HEIGHT = 40;

/** The player's home (4 x 4 tiles). The crystal shop restyles it, see world/villageLook.ts. */
export const HOUSE = { x: 27, y: 6 };

/** Where the player appears (tile coordinates). */
export const PLAYER_START = { x: 29, y: 18 };

/** The dungeon entrance arch (3x3 tiles) at the east end of the road. */
export const DUNGEON_ENTRANCE = { x: 54, y: 18 };

/** The permanent crystal shop: a market stall (3 x 2.75 tiles) on the square west of the house road. */
export const SHOP_STALL = { x: 24, y: 16.5 };

/** Where the player appears when coming back from the dungeon (on the road in front of the arch). */
export const DUNGEON_RETURN = { x: 55, y: 22 };

type Terrain = 'grass' | 'path' | 'water';

/** Smooth 0..1 noise (bilinear value noise) so grass tones form soft patches, not speckle. */
function valueNoise (rand: () => number, cell: number)
{
    const cols = Math.ceil(MAP_WIDTH / cell) + 2;
    const rows = Math.ceil(MAP_HEIGHT / cell) + 2;
    const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, rand));
    const smooth = (t: number) => t * t * (3 - 2 * t);
    return (x: number, y: number) =>
    {
        const gx = x / cell, gy = y / cell;
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const tx = smooth(gx - x0), ty = smooth(gy - y0);
        const top = grid[y0][x0] * (1 - tx) + grid[y0][x0 + 1] * tx;
        const bottom = grid[y0 + 1][x0] * (1 - tx) + grid[y0 + 1][x0 + 1] * tx;
        return top * (1 - ty) + bottom * ty;
    };
}

/** Returns a [row][column] grid of GROUND tile indices. */
export function buildGround (): number[][]
{
    const terrain: Terrain[][] = Array.from({ length: MAP_HEIGHT }, () => Array<Terrain>(MAP_WIDTH).fill('grass'));
    const fill = (x: number, y: number, w: number, h: number, t: Terrain) =>
    {
        for (let row = y; row < Math.min(y + h, MAP_HEIGHT); row++)
        {
            for (let col = x; col < Math.min(x + w, MAP_WIDTH); col++) terrain[row][col] = t;
        }
    };

    // Paths: fill(x, y, width, height, ...)
    fill(2, 21, 56, 2, 'path');   // main east-west road
    fill(28, 10, 2, 28, 'path');  // road from the house door going south
    fill(12, 23, 2, 4, 'path');   // short path down to the pond

    // Pond (water tiles are solid, see SOLID_GROUND) with rounded corners
    fill(8, 27, 8, 6, 'water');
    for (const [col, row] of [[8, 27], [15, 27], [8, 32], [15, 32]]) terrain[row][col] = 'grass';

    const rand = seededRandom(1);
    const tone = valueNoise(seededRandom(7), 6);
    const at = (x: number, y: number): Terrain | null => terrain[y]?.[x] ?? null;
    const isPath = (x: number, y: number) => at(x, y) === 'path';

    return terrain.map((row, y) => row.map((t, x) =>
    {
        if (t === 'water') return rand() < 0.14 ? GROUND.WATER_LILY : GROUND.WATER;

        if (t === 'path')
        {
            // Grass grows along every side that does not continue the path (map edges count as path).
            const edge = (dx: number, dy: number) => at(x + dx, y + dy) !== null && !isPath(x + dx, y + dy);
            const mask = (edge(0, -1) ? PATH_EDGE.N : 0) | (edge(1, 0) ? PATH_EDGE.E : 0)
                | (edge(0, 1) ? PATH_EDGE.S : 0) | (edge(-1, 0) ? PATH_EDGE.W : 0);
            if (mask === 0) return rand() < 0.18 ? GROUND.PATH_PEBBLES : GROUND.PATH;
            return GROUND.PATH + mask;
        }

        // Grass: soft tone patches + sparse clovers, tiny flowers (borders along paths), leaves, mushrooms.
        const nearPath = isPath(x, y - 1) || isPath(x + 1, y) || isPath(x, y + 1) || isPath(x - 1, y);
        const flowers = nearPath ? 0.16 : 0.035;
        const r = rand();
        if (r < flowers) return GROUND.TINY_FLOWERS;
        if (r < flowers + 0.05) return GROUND.CLOVER;
        if (r < flowers + 0.065) return GROUND.LEAVES;
        if (r < flowers + 0.071) return GROUND.MUSHROOM;
        const n = tone(x, y);
        return n > 0.66 ? GROUND.GRASS_LIGHT : n < 0.3 ? GROUND.GRASS_DARK : GROUND.GRASS;
    }));
}

/** Trees around the edge so the map boundary reads visually (every 4th one blossoms). */
function borderTrees (): PlacedObject[]
{
    const trees: PlacedObject[] = [];
    const kind = (i: number) => (i % 4 === 2 ? 'treeBlossom' : 'tree');
    for (let x = 0, i = 0; x < MAP_WIDTH; x += 2, i++)
    {
        trees.push({ kind: kind(i), x, y: -1 }, { kind: kind(i + 1), x, y: MAP_HEIGHT - 2 });
    }
    for (let y = 1, i = 0; y < MAP_HEIGHT - 2; y += 2, i++)
    {
        trees.push({ kind: kind(i), x: 0, y }, { kind: kind(i + 3), x: MAP_WIDTH - 2, y });
    }
    return trees;
}

/** OBJECT POSITIONS: move, add or remove entries here. */
export const VILLAGE_OBJECTS: PlacedObject[] = [
    { kind: 'house', ...HOUSE },
    // Hub.ts makes it interactive: "Press E to Shop".
    { kind: 'shopStall', ...SHOP_STALL },

    // Dungeon entrance at the east end of the road, with a torch on each pillar
    // (Hub.ts makes it interactive: "Press E to Enter Dungeon").
    { kind: 'dungeonEntrance', ...DUNGEON_ENTRANCE },
    { kind: 'torch', x: DUNGEON_ENTRANCE.x - 2 / 16, y: DUNGEON_ENTRANCE.y + 1, depthBias: 20 },
    { kind: 'torch', x: DUNGEON_ENTRANCE.x + 34 / 16, y: DUNGEON_ENTRANCE.y + 1, depthBias: 20 },

    { kind: 'tree', x: 10, y: 8 },
    { kind: 'treeBlossom', x: 13, y: 10 },
    { kind: 'tree', x: 8, y: 12 },
    { kind: 'tree', x: 44, y: 8 },
    { kind: 'treeBlossom', x: 47, y: 10 },
    { kind: 'tree', x: 20, y: 28 },
    { kind: 'treeBlossom', x: 42, y: 28 },
    { kind: 'tree', x: 46, y: 31 },
    { kind: 'tree', x: 50, y: 26 },
    { kind: 'treeBlossom', x: 37, y: 3 },
    { kind: 'treeBlossom', x: 18, y: 4 },
    { kind: 'tree', x: 52, y: 5 },

    { kind: 'rock', x: 24, y: 15 },
    { kind: 'rock', x: 36, y: 26 },
    { kind: 'rock', x: 17, y: 24 },
    { kind: 'rock', x: 52, y: 18 },
    { kind: 'rock', x: 6, y: 18 },

    { kind: 'flowersRed', x: 25, y: 11 },
    { kind: 'flowersWhite', x: 32, y: 12 },
    { kind: 'flowersRed', x: 20, y: 18 },
    { kind: 'flowersWhite', x: 38, y: 17 },
    { kind: 'flowersRed', x: 10, y: 24 },
    { kind: 'flowersWhite', x: 48, y: 23 },
    { kind: 'flowersRed', x: 35, y: 33 },

    // Garden decor (kept off paths, doors, Sir's hall and his roaming area)
    { kind: 'flowerBed', x: 24, y: 8 },
    { kind: 'flowerBed', x: 32, y: 9 },
    { kind: 'flowerBed', x: 17, y: 30 },
    { kind: 'sunflower', x: 33, y: 7 },
    { kind: 'sunflower', x: 34, y: 7 },
    { kind: 'sunflower', x: 49, y: 16 },
    { kind: 'sunflower', x: 50, y: 16 },
    { kind: 'sunflower', x: 4, y: 26 },
    { kind: 'sunflower', x: 5, y: 26 },
    { kind: 'bush', x: 5, y: 15 },
    { kind: 'bush', x: 22, y: 13 },
    { kind: 'bush', x: 42, y: 13 },
    { kind: 'bush', x: 51, y: 14 },
    { kind: 'bush', x: 17, y: 20 },
    { kind: 'bush', x: 40, y: 24 },
    { kind: 'bush', x: 32, y: 25 },
    { kind: 'bush', x: 24, y: 33 },
    { kind: 'bush', x: 52, y: 33 },
    { kind: 'bush', x: 45, y: 19 },
    { kind: 'bushFlower', x: 6, y: 24 },
    { kind: 'bushFlower', x: 40, y: 20 },
    { kind: 'bushFlower', x: 22, y: 19 },
    { kind: 'bushFlower', x: 11, y: 14 },
    { kind: 'fern', x: 7, y: 16 },
    { kind: 'fern', x: 19, y: 26 },
    { kind: 'fern', x: 45, y: 26 },
    { kind: 'fern', x: 38, y: 34 },
    { kind: 'fern', x: 26, y: 26 },
    { kind: 'fern', x: 55, y: 30 },

    ...borderTrees(),
];

/** Friendly ambient insects and their home spots (see world/critters.ts). */
export const VILLAGE_CRITTERS: CritterSpawn[] = [
    { kind: 'butterflyBlue', x: 25.5, y: 11.5 },
    { kind: 'butterflyPink', x: 20.5, y: 18.5 },
    { kind: 'butterflyYellow', x: 33.5, y: 7.5 },
    { kind: 'butterflyBlue', x: 38.5, y: 17.5 },
    { kind: 'butterflyPink', x: 17.5, y: 30 },
    { kind: 'butterflyYellow', x: 10.5, y: 24.5 },
    { kind: 'butterflyBlue', x: 48.5, y: 23.5 },
    { kind: 'butterflyPink', x: 24.5, y: 8 },
    { kind: 'bee', x: 25, y: 8.5 },
    { kind: 'bee', x: 32.5, y: 9.5 },
    { kind: 'bee', x: 18, y: 30.5 },
    { kind: 'bee', x: 34, y: 7.5 },
    { kind: 'bee', x: 50, y: 16.5 },
    { kind: 'ladybug', x: 22.5, y: 14.3 },
    { kind: 'ladybug', x: 5.5, y: 16.3 },
    { kind: 'ladybug', x: 42.5, y: 14.3 },
    { kind: 'ladybug', x: 19.5, y: 27.2 },
    { kind: 'snail', x: 11, y: 34 },
    { kind: 'snail', x: 6, y: 28 },
    { kind: 'snail', x: 44, y: 35 },
    { kind: 'caterpillar', x: 35, y: 30 },
    { kind: 'caterpillar', x: 23, y: 24 },
    { kind: 'caterpillar', x: 8, y: 20 },
    { kind: 'caterpillar', x: 50, y: 30 },
];
