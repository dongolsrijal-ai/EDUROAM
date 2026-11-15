// Dungeon tile indices (shared by every biome tileset: same order, different art). Phaser-free so
// the generator and its tests can use it.

export const DUNGEON = {
    FLOOR: 0,
    FLOOR_ALT: 1,
    WALL: 2,
    VOID: 3,
    /** Biome floor detail (bones in the crypt, grass in the ruins). Walkable. */
    FLOOR_DETAIL: 4,
} as const;

export const DUNGEON_TILE_COUNT = 5;

export const SOLID_DUNGEON = [DUNGEON.WALL, DUNGEON.VOID];

export const isWalkableTile = (index: number) => index !== DUNGEON.WALL && index !== DUNGEON.VOID;
