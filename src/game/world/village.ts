// The starting village map: size, ground layout and object placements.
// New maps can copy this file's shape (size + buildGround + objects + start point).
// All coordinates here are in TILES (multiply by TILE for pixels).

import { GROUND } from '../art/textures';
import type { PlacedObject } from './objectTypes';
import { seededRandom } from '../random';

/** MAP DIMENSIONS in tiles. The physics/camera boundary follows these automatically. */
export const MAP_WIDTH = 60;
export const MAP_HEIGHT = 40;

/** Where the player appears (tile coordinates). */
export const PLAYER_START = { x: 29, y: 18 };

/** The dungeon entrance arch (3x3 tiles) at the east end of the road. */
export const DUNGEON_ENTRANCE = { x: 54, y: 18 };

/** Where the player appears when coming back from the dungeon (on the road in front of the arch). */
export const DUNGEON_RETURN = { x: 55, y: 22 };

/** Returns a [row][column] grid of GROUND tile indices. */
export function buildGround (): number[][]
{
    const rand = seededRandom(1);
    const pick = (a: number, b: number, chanceOfB: number) => (rand() < chanceOfB ? b : a);

    const grid = Array.from({ length: MAP_HEIGHT }, () =>
        Array.from({ length: MAP_WIDTH }, () => pick(GROUND.GRASS, GROUND.GRASS_TUFT, 0.15)));

    const fill = (x: number, y: number, w: number, h: number, a: number, b: number) =>
    {
        for (let row = y; row < Math.min(y + h, MAP_HEIGHT); row++)
        {
            for (let col = x; col < Math.min(x + w, MAP_WIDTH); col++) grid[row][col] = pick(a, b, 0.2);
        }
    };

    // Paths: fill(x, y, width, height, ...)
    fill(2, 21, 56, 2, GROUND.PATH, GROUND.PATH_PEBBLE);   // main east-west road
    fill(28, 10, 2, 28, GROUND.PATH, GROUND.PATH_PEBBLE);  // road from the house door going south
    fill(12, 23, 2, 4, GROUND.PATH, GROUND.PATH_PEBBLE);   // short path down to the pond

    // Pond (water tiles are solid, see SOLID_GROUND)
    fill(8, 27, 8, 6, GROUND.WATER, GROUND.WATER_WAVE);
    for (const [col, row] of [[8, 27], [15, 27], [8, 32], [15, 32]]) grid[row][col] = GROUND.GRASS;

    return grid;
}

/** Trees around the edge so the map boundary reads visually. */
function borderTrees (): PlacedObject[]
{
    const trees: PlacedObject[] = [];
    for (let x = 0; x < MAP_WIDTH; x += 2)
    {
        trees.push({ kind: 'tree', x, y: -1 }, { kind: 'tree', x, y: MAP_HEIGHT - 2 });
    }
    for (let y = 1; y < MAP_HEIGHT - 2; y += 2)
    {
        trees.push({ kind: 'tree', x: 0, y }, { kind: 'tree', x: MAP_WIDTH - 2, y });
    }
    return trees;
}

/** OBJECT POSITIONS: move, add or remove entries here. */
export const VILLAGE_OBJECTS: PlacedObject[] = [
    { kind: 'house', x: 27, y: 6 },

    // Dungeon entrance at the east end of the road, with a torch on each pillar
    // (Hub.ts makes it interactive: "Press E to Enter Dungeon").
    { kind: 'dungeonEntrance', ...DUNGEON_ENTRANCE },
    { kind: 'torch', x: DUNGEON_ENTRANCE.x - 2 / 16, y: DUNGEON_ENTRANCE.y + 1, depthBias: 20 },
    { kind: 'torch', x: DUNGEON_ENTRANCE.x + 34 / 16, y: DUNGEON_ENTRANCE.y + 1, depthBias: 20 },

    { kind: 'tree', x: 10, y: 8 },
    { kind: 'tree', x: 13, y: 10 },
    { kind: 'tree', x: 8, y: 12 },
    { kind: 'tree', x: 44, y: 8 },
    { kind: 'tree', x: 47, y: 10 },
    { kind: 'tree', x: 20, y: 28 },
    { kind: 'tree', x: 42, y: 28 },
    { kind: 'tree', x: 46, y: 31 },
    { kind: 'tree', x: 50, y: 26 },

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

    ...borderTrees(),
];
