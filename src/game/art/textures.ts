// Procedurally drawn placeholder textures.
// To switch to real art later: load an image/spritesheet with the SAME key in
// scenes/Boot.ts preload() and delete the matching function call below.

import { Scene } from 'phaser';
import { CHARACTER_SIZE, COLORS as C, TILE } from '../config';
import { ascii, asciiCharacter, disc, rect, type Ctx } from './pixel';
import { drawBuildings } from './buildings';
import { drawDungeonArt } from './dungeonArt';
import { APPEARANCES, AppearanceId } from '../npcs/appearances';

/** Tile indices inside the 'ground' tileset (left to right). */
export const GROUND = {
    GRASS: 0,
    GRASS_TUFT: 1,
    PATH: 2,
    PATH_PEBBLE: 3,
    WATER: 4,
    WATER_WAVE: 5,
} as const;

/** Ground tiles the player cannot walk on. */
export const SOLID_GROUND = [GROUND.WATER, GROUND.WATER_WAVE];

/** Tile indices inside the 'dungeon' tileset. */
export const DUNGEON = {
    FLOOR: 0,
    FLOOR_CRACK: 1,
    WALL: 2,
    VOID: 3,
} as const;

export const SOLID_DUNGEON = [DUNGEON.WALL, DUNGEON.VOID];

/** Player spritesheet frame size; frames are [down, down-step, up, up-step, side, side-step]. */
export const PLAYER_FRAME = CHARACTER_SIZE;

export function generateTextures (scene: Scene)
{
    groundTileset(scene);
    tree(scene);
    house(scene);
    rock(scene);
    flowers(scene, 'flowers-red', C.flowerRed);
    flowers(scene, 'flowers-white', C.flowerWhite);
    player(scene);
    dungeonTileset(scene);
    dungeonProps(scene);
    drawBuildings(scene);
    drawDungeonArt(scene);

    // NPC looks: skipped when a real sprite was loaded under the same key (see npcs/appearances.ts).
    for (const id of Object.keys(APPEARANCES) as AppearanceId[])
    {
        const { texture } = APPEARANCES[id];
        if (!scene.textures.exists(texture)) NPC_PLACEHOLDERS[id](scene, texture);
    }
}

// ---------------------------------------------------------------- helpers

export function canvasTexture (scene: Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void)
{
    const tex = scene.textures.createCanvas(key, w, h);
    if (!tex) throw new Error(`Could not create texture "${key}"`);
    draw(tex.getContext());
    tex.refresh();
    return tex;
}

// ---------------------------------------------------------------- textures

function groundTileset (scene: Scene)
{
    canvasTexture(scene, 'ground', TILE * 6, TILE, (ctx) =>
    {
        const tile = (index: number, base: string, dots: [number, number, string][]) =>
        {
            const ox = index * TILE;
            rect(ctx, ox, 0, TILE, TILE, base);
            for (const [x, y, color] of dots) rect(ctx, ox + x, y, 1, 1, color);
        };
        const tuft = (x: number, y: number): [number, number, string][] => [
            [x, y, C.grassDark], [x, y + 1, C.grassDark], [x + 1, y + 1, C.grassDark],
            [x + 2, y, C.grassDark], [x + 2, y + 1, C.grassDark], [x + 1, y, C.grassLight],
        ];

        tile(GROUND.GRASS, C.grass, [[3, 4, C.grassDark], [11, 9, C.grassDark], [7, 13, C.grassLight]]);
        tile(GROUND.GRASS_TUFT, C.grass, [...tuft(2, 3), ...tuft(10, 10)]);
        tile(GROUND.PATH, C.path, [[4, 3, C.pathDark], [12, 7, C.pathDark], [6, 12, C.pathLight]]);
        tile(GROUND.PATH_PEBBLE, C.path, [
            [3, 5, C.pathLight], [4, 5, C.pathLight], [3, 6, C.pathDark], [4, 6, C.pathDark],
            [11, 11, C.pathLight], [12, 11, C.pathDark], [9, 2, C.pathDark],
        ]);
        tile(GROUND.WATER, C.water, [[3, 4, C.waterLight], [4, 4, C.waterLight], [5, 4, C.waterLight]]);
        tile(GROUND.WATER_WAVE, C.water, [
            [9, 10, C.waterLight], [10, 10, C.waterLight], [11, 10, C.waterLight], [2, 13, C.waterLight],
        ]);
    });
}

/** 32x40 tree: canopy on top, trunk at the bottom. */
function tree (scene: Scene)
{
    canvasTexture(scene, 'tree', 32, 40, (ctx) =>
    {
        rect(ctx, 7, 37, 18, 3, C.shadow);
        rect(ctx, 12, 24, 8, 15, C.outline);
        rect(ctx, 13, 24, 6, 14, C.trunk);
        rect(ctx, 17, 24, 2, 14, C.trunkDark);
        disc(ctx, 16, 15, 13, C.outline);
        disc(ctx, 16, 15, 12, C.leavesDark);
        disc(ctx, 15, 13, 10, C.leaves);
        disc(ctx, 12, 9, 4, C.leavesLight);
        rect(ctx, 20, 18, 2, 2, C.leavesDark);
        rect(ctx, 9, 17, 2, 1, C.leavesDark);
    });
}

/** 64x64 (4x4 tiles) cottage with a door at the bottom centre. */
function house (scene: Scene)
{
    canvasTexture(scene, 'house', 64, 64, (ctx) =>
    {
        rect(ctx, 4, 60, 58, 4, C.shadow);

        // Chimney (drawn first so the roof overlaps it)
        rect(ctx, 46, 0, 8, 10, C.outline);
        rect(ctx, 47, 1, 6, 9, C.roofDark);

        // Walls
        rect(ctx, 5, 30, 54, 32, C.outline);
        rect(ctx, 6, 31, 52, 30, C.wall);
        rect(ctx, 6, 31, 3, 30, C.wallDark);
        rect(ctx, 55, 31, 3, 30, C.wallDark);
        rect(ctx, 6, 58, 52, 3, C.wallDark);

        // Windows
        for (const wx of [13, 41])
        {
            rect(ctx, wx - 1, 37, 12, 12, C.outline);
            rect(ctx, wx, 38, 10, 10, C.window);
            rect(ctx, wx + 1, 39, 2, 2, C.windowLight);
            rect(ctx, wx + 4, 38, 2, 10, C.outline);
            rect(ctx, wx, 42, 10, 2, C.outline);
        }

        // Door
        rect(ctx, 26, 41, 12, 21, C.outline);
        rect(ctx, 27, 42, 10, 19, C.door);
        rect(ctx, 34, 51, 2, 2, C.doorKnob);

        // Roof
        rect(ctx, 1, 4, 62, 31, C.outline);
        rect(ctx, 2, 5, 60, 29, C.roof);
        for (let y = 9; y < 34; y += 4) rect(ctx, 2, y, 60, 1, C.roofDark);
        rect(ctx, 2, 5, 60, 2, C.roofLight);
        rect(ctx, 6, 35, 52, 2, C.wallDark);
    });
}

function rock (scene: Scene)
{
    canvasTexture(scene, 'rock', 16, 16, (ctx) => ascii(ctx, [
        '................',
        '................',
        '................',
        '................',
        '................',
        '......oooo......',
        '....oollllo.....',
        '...ollllmmmo....',
        '..ollmmmmmmdo...',
        '..olmmmmmmmdo...',
        '..ommmmmmmddo...',
        '..ommmmmmdddo...',
        '...odddddddo....',
        '....ooooooo.....',
        '..ssssssssss....',
    ], { o: C.outline, l: C.rockLight, m: C.rock, d: C.rockDark, s: C.shadow }));
}

function flowers (scene: Scene, key: string, petal: string)
{
    canvasTexture(scene, key, 16, 16, (ctx) => ascii(ctx, [
        '................',
        '................',
        '...p............',
        '..pyp.......p...',
        '...p.......pyp..',
        '...g........p...',
        '...g.....p..g...',
        '..gg....pyp.g...',
        '.........p.gg...',
        '.........g......',
        '....p...gg......',
        '...pyp..........',
        '....p...........',
        '....g...........',
        '...gg...........',
    ], { p: petal, y: C.flowerCenter, g: C.grassDark }));
}

/** Player spritesheet: 3 directions x 2 frames (left = mirrored side). Drawn on a 16 grid, output 24px. */
function player (scene: Scene)
{
    const head = {
        down: [
            '................',
            '.....oooooo.....',
            '....ohhhhhho....',
            '...ohhhhhhhho...',
            '...ohhhhhhhho...',
            '...ohssssssho...',
            '...osossssoso...',
            '...osssssssso...',
            '....oossssoo....',
        ],
        up: [
            '................',
            '.....oooooo.....',
            '....ohhhhhho....',
            '...ohhhhhhhho...',
            '...ohhhhhhhho...',
            '...ohhhhhhhho...',
            '...ohhhhhhhho...',
            '...ohhhhhhhho...',
            '....oossssoo....',
        ],
        side: [
            '................',
            '.....oooooo.....',
            '....ohhhhhho....',
            '...ohhhhhhhho...',
            '...ohhhhhhhho...',
            '...ohhhhsssso...',
            '...ohhhsssoso...',
            '...ohhsssssso...',
            '....oossssoo....',
        ],
    };
    const frontBody = [
        '...occcccccco...',
        '..ocCccccccCco..',
        '..osCccccccCso..',
        '...oppppppppo...',
    ];
    const sideBody = [
        '....occcccco....',
        '....occcCcco....',
        '....occcscco....',
        '....oppppppo....',
    ];
    const frontLegs = [
        ['...opppoopppo...', '...oppo..oppo...', '...obbo..obbo...'],
        ['...opppoopppo...', '...obbo..oppo...', '.........obbo...'],
    ];
    const sideLegs = [
        ['....opppppo.....', '....oppoppo.....', '....obbobbo.....'],
        ['....opppppo.....', '...oppo.oppo....', '...obbo.obbo....'],
    ];

    const frames = [
        [...head.down, ...frontBody, ...frontLegs[0]], [...head.down, ...frontBody, ...frontLegs[1]],
        [...head.up, ...frontBody, ...frontLegs[0]], [...head.up, ...frontBody, ...frontLegs[1]],
        [...head.side, ...sideBody, ...sideLegs[0]], [...head.side, ...sideBody, ...sideLegs[1]],
    ];
    const palette = {
        o: C.outline, h: C.hair, s: C.skin, c: C.shirt, C: C.shirtDark, p: C.pants, b: C.shoes,
    };

    const tex = canvasTexture(scene, 'player', PLAYER_FRAME * frames.length, PLAYER_FRAME, (ctx) =>
    {
        frames.forEach((rows, i) => asciiCharacter(ctx, rows, palette, i * PLAYER_FRAME, 0));
    });
    frames.forEach((_, i) => tex.add(i, 0, i * PLAYER_FRAME, 0, PLAYER_FRAME, PLAYER_FRAME));
}

// ---------------------------------------------------------------- NPC placeholders (16x16, facing down)

const NPC_PLACEHOLDERS: Record<AppearanceId, (scene: Scene, key: string) => void> = {
    knight, doctor, scientist, farmer,
};

/** Knight (Sir Sum-a-Lot's look): red plume, steel armour, purple tabard. */
function knight (scene: Scene, key: string)
{
    canvasTexture(scene, key, CHARACTER_SIZE, CHARACTER_SIZE, (ctx) => asciiCharacter(ctx, [
        '.......rr.......',
        '......rrr.......',
        '.....oooooo.....',
        '....oaaaaaao....',
        '...oaaaaaaaao...',
        '...oAAAAAAAAo...',
        '...oAoAAAAoAo...',
        '...oassssssao...',
        '....osmmmmso....',
        '...otttyyttto...',
        '..oatttyytttao..',
        '..oattttttttao..',
        '..osttttttttso..',
        '...oaaaaaaaao...',
        '...oaao..oaao...',
        '...obbo..obbo...',
    ], {
        o: C.outline, a: C.armor, A: C.armorDark, r: C.plume, s: C.skin,
        m: C.beard, t: C.tabard, y: C.gold, b: C.shoes,
    }));
}

/** Doctor: head mirror, white coat, stethoscope, teal scrubs. */
function doctor (scene: Scene, key: string)
{
    canvasTexture(scene, key, CHARACTER_SIZE, CHARACTER_SIZE, (ctx) => asciiCharacter(ctx, [
        '................',
        '.....oooooo.....',
        '....ohhhhhho....',
        '...ohhhgghhho...',
        '...ohhhgghhho...',
        '...ohssssssho...',
        '...osossssoso...',
        '...osssssssso...',
        '....oossssoo....',
        '...owwzwwzwwo...',
        '..owwwzwwzwwwo..',
        '..owWwwzzwwWwo..',
        '..oswwwwwwwwso..',
        '...owwwwwwwwo...',
        '...oddo..oddo...',
        '...obbo..obbo...',
    ], {
        o: C.outline, h: C.hair, g: C.mirror, s: C.skin, w: C.coat, W: C.coatShade,
        z: C.scrubs, d: C.scrubs, b: C.shoes,
    }));
}

/** Scientist: wild hair, goggles, lab coat, purple tie. */
function scientist (scene: Scene, key: string)
{
    canvasTexture(scene, key, CHARACTER_SIZE, CHARACTER_SIZE, (ctx) => asciiCharacter(ctx, [
        '...oo.oooo.oo...',
        '..ohhohhhhohho..',
        '..ohhhhhhhhhho..',
        '..ohhhhhhhhhho..',
        '...ohssssssho...',
        '...oGGGooGGGo...',
        '...osssssssso...',
        '....oossssoo....',
        '...owwwkkwwwo...',
        '..owwwwkkwwwwo..',
        '..owWwwkkwwWwo..',
        '..oswwwwwwwwso..',
        '...owwwwwwwwo...',
        '...owwwwwwwwo...',
        '...oppo..oppo...',
        '...obbo..obbo...',
    ], {
        o: C.outline, h: C.wildHair, s: C.skin, G: C.goggles, w: C.coat, W: C.coatShade,
        k: C.tabard, p: C.pants, b: C.shoes,
    }));
}

/** Farmer: straw hat, plaid shirt, overalls. */
function farmer (scene: Scene, key: string)
{
    canvasTexture(scene, key, CHARACTER_SIZE, CHARACTER_SIZE, (ctx) => asciiCharacter(ctx, [
        '.....oooooo.....',
        '....oyyyyyyo....',
        '....oyYYYYyo....',
        '.oyyyyyyyyyyyyo.',
        '..oooooooooooo..',
        '...ohssssssho...',
        '...osossssoso...',
        '...osssssssso...',
        '....oossssoo....',
        '...orruuuurro...',
        '..orrUuuuuUrro..',
        '..osruuuuuurso..',
        '...ouuuuuuuuo...',
        '...ouuuoouuuo...',
        '...ouuo..ouuo...',
        '...obbo..obbo...',
    ], {
        o: C.outline, y: C.straw, Y: C.strawDark, h: C.hair, s: C.skin, r: C.plaid,
        u: C.overalls, U: C.overallsDark, b: C.shoes,
    }));
}

// ---------------------------------------------------------------- dungeon

function dungeonTileset (scene: Scene)
{
    canvasTexture(scene, 'dungeon', TILE * 4, TILE, (ctx) =>
    {
        const floor = (ox: number) =>
        {
            rect(ctx, ox, 0, TILE, TILE, C.dFloor);
            rect(ctx, ox, 0, TILE, 1, C.dFloorDark);
            rect(ctx, ox, 8, TILE, 1, C.dFloorDark);
            rect(ctx, ox, 0, 1, 8, C.dFloorDark);
            rect(ctx, ox + 8, 8, 1, 8, C.dFloorDark);
            rect(ctx, ox + 2, 2, 2, 1, C.dFloorLight);
            rect(ctx, ox + 10, 10, 2, 1, C.dFloorLight);
        };

        floor(DUNGEON.FLOOR * TILE);

        const crack = DUNGEON.FLOOR_CRACK * TILE;
        floor(crack);
        for (const [x, y] of [[3, 3], [4, 4], [5, 4], [6, 5], [6, 6], [12, 11], [11, 12], [13, 12]])
        {
            rect(ctx, crack + x, y, 1, 1, C.dFloorDark);
        }

        const wall = DUNGEON.WALL * TILE;
        rect(ctx, wall, 0, TILE, TILE, C.dWall);
        rect(ctx, wall, 0, TILE, 2, C.dWallLight);
        rect(ctx, wall, 5, TILE, 1, C.dWallDark);
        rect(ctx, wall, 10, TILE, 1, C.dWallDark);
        rect(ctx, wall + 4, 2, 1, 3, C.dWallDark);
        rect(ctx, wall + 12, 6, 1, 4, C.dWallDark);
        rect(ctx, wall + 8, 11, 1, 3, C.dWallDark);
        rect(ctx, wall, 14, TILE, 2, C.dWallDark);

        rect(ctx, DUNGEON.VOID * TILE, 0, TILE, TILE, C.dVoid);
    });
}

function dungeonProps (scene: Scene)
{
    // Exit stairs inside the dungeon (16x16, walk onto them).
    canvasTexture(scene, 'stairs-up', 16, 16, (ctx) =>
    {
        rect(ctx, 0, 0, 16, 16, C.outline);
        [C.dWallLight, C.stone, C.dWall, C.dWallDark].forEach((color, i) => rect(ctx, 1, 1 + i * 4, 14, 3, color));
    });

    // Pillar: 16x24, base collides.
    canvasTexture(scene, 'pillar', 16, 24, (ctx) =>
    {
        rect(ctx, 1, 21, 15, 3, C.shadow);
        rect(ctx, 1, 0, 14, 23, C.outline);
        rect(ctx, 2, 1, 12, 21, C.stone);
        rect(ctx, 2, 1, 12, 2, C.dWallLight);
        rect(ctx, 10, 3, 3, 17, C.stoneDark);
        rect(ctx, 2, 19, 12, 3, C.stoneDark);
    });

    // Loot chest placeholder.
    canvasTexture(scene, 'chest', 16, 16, (ctx) =>
    {
        rect(ctx, 1, 14, 15, 2, C.shadow);
        rect(ctx, 1, 4, 14, 11, C.outline);
        rect(ctx, 2, 5, 12, 9, C.chest);
        rect(ctx, 2, 5, 12, 2, C.chestDark);
        rect(ctx, 2, 9, 12, 1, C.chestDark);
        rect(ctx, 7, 8, 2, 3, C.gold);
    });

    // Wall torch with a soft glow.
    canvasTexture(scene, 'torch', 16, 16, (ctx) =>
    {
        disc(ctx, 8, 6, 6, C.glow);
        rect(ctx, 7, 8, 2, 6, C.outline);
        rect(ctx, 6, 13, 4, 1, C.outline);
        disc(ctx, 8, 6, 2, C.flame);
        rect(ctx, 8, 6, 1, 1, C.flameCore);
    });
}
