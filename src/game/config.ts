// Global tuning values. Change these first when adjusting the feel of the game.

/** Size of one tile in pixels. All placeholder art is drawn on this grid. */
export const TILE = 16;

/**
 * MINIMUM visible world area in pixels (about 30 x 17 tiles).
 * The canvas always renders at the screen's real resolution and the camera zooms by the
 * largest WHOLE number that still shows at least this much, so pixel art never blurs.
 * Smaller values = bigger sprites.
 */
export const VIEW_WIDTH = 480;
export const VIEW_HEIGHT = 270;

/**
 * CHARACTER SIZE in world pixels (player + NPCs). Character art is drawn on a 16px grid and
 * generated at this size (24 = 1.5x), so sprites stay crisp without fractional scaling.
 */
export const CHARACTER_SIZE = 24;

/** Player movement speed in pixels per second. */
export const PLAYER_SPEED = 80;

/** Player health in combat areas (dungeons). */
export const PLAYER_MAX_HP = 100;

/** NPC ROAMING: walking speed (px/s) and how far (px) they wander from their home spot. */
export const NPC_WALK_SPEED = 26;
export const NPC_ROAM_RADIUS = 56;

/** WORLD COLORS: every placeholder texture is drawn from this palette. */
export const COLORS = {
    background: '#1e2a1a',
    outline: '#2b1d14',
    shadow: 'rgba(0, 0, 0, 0.18)',

    grass: '#6abe30',
    grassDark: '#4b8f2a',
    grassLight: '#8fd650',
    path: '#c8a26a',
    pathDark: '#a7834f',
    pathLight: '#ddbf8a',
    water: '#3f8fd6',
    waterLight: '#8fd0f5',

    trunk: '#7a4b2a',
    trunkDark: '#5a3520',
    leaves: '#3f9b3c',
    leavesDark: '#2c6e2f',
    leavesLight: '#68c450',

    roof: '#c0573d',
    roofDark: '#963f2c',
    roofLight: '#de7a55',
    wall: '#e9d4a7',
    wallDark: '#c4a676',
    window: '#6fb7e0',
    windowLight: '#d4f0ff',
    door: '#6b4426',
    doorKnob: '#f2c14e',

    rock: '#9a9a9a',
    rockDark: '#6f6f6f',
    rockLight: '#c4c4c4',
    flowerRed: '#e05a5a',
    flowerWhite: '#f4f4f4',
    flowerCenter: '#f2c14e',

    skin: '#f2c79b',
    hair: '#5a3420',
    shirt: '#3b6fc4',
    shirtDark: '#2a4f8f',
    pants: '#3a3a5a',
    shoes: '#2b1d14',

    // Sir Sum-a-Lot
    armor: '#b8c2cc',
    armorDark: '#6c7a89',
    plume: '#d23c3c',
    tabard: '#7b4fb0',
    gold: '#f2c14e',
    beard: '#eeeeee',

    // NPC looks (doctor / scientist / farmer)
    coat: '#f4f4f4',
    coatShade: '#c9d3dc',
    scrubs: '#3aa3a0',
    mirror: '#d8e4ee',
    goggles: '#7fd6ff',
    wildHair: '#e0843a',
    straw: '#e8c35a',
    strawDark: '#b8923a',
    overalls: '#4a6fa5',
    overallsDark: '#34507a',
    plaid: '#c94c4c',

    // Dungeon
    dFloor: '#3b3547',
    dFloorDark: '#2e2938',
    dFloorLight: '#4a4359',
    dWall: '#5d5270',
    dWallDark: '#3f3650',
    dWallLight: '#7a6d8f',
    dVoid: '#120f17',
    stone: '#8f8a9c',
    stoneDark: '#5f5a6d',
    moss: '#5a8a3c',
    flame: '#ffb347',
    flameCore: '#fff1a8',
    glow: 'rgba(255, 180, 80, 0.22)',
    chest: '#8a5a2b',
    chestDark: '#5e3b1b',
};
