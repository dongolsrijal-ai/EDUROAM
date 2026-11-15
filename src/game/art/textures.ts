// Procedurally drawn placeholder textures.
// To switch to real art later: load an image/spritesheet with the SAME key in
// scenes/Boot.ts preload() and delete the matching function call below.

import { Scene } from 'phaser';
import { CHARACTER_SIZE, COLORS as C } from '../config';
import { asciiCharacter, disc, rect, type Ctx } from './pixel';
import { drawBuildings } from './buildings';
import { drawDungeonArt } from './dungeonArt';
import { drawGarden } from './gardenArt';
import { drawVillageShopArt } from './villageShopArt';
import { drawEnemyArt } from './enemyArt';
import { drawDungeonBiomes } from './dungeonBiomes';
import { APPEARANCES, AppearanceId } from '../npcs/appearances';

/** Village ground tiles now live in the garden art (re-exported for existing imports). */
export { GROUND, SOLID_GROUND, isPathTile } from './gardenArt';

/** Dungeon tile ids live in the phaser-free world/dungeon/tiles.ts (re-exported here). */
export { DUNGEON, SOLID_DUNGEON } from '../world/dungeon/tiles';

/** Player spritesheet frame size; frames are [down, down-step, up, up-step, side, side-step]. */
export const PLAYER_FRAME = CHARACTER_SIZE;

export function generateTextures (scene: Scene)
{
    drawGarden(scene); // village: ground, trees, cottage, rocks, plants, insects
    drawVillageShopArt(scene); // crystal shop stall + the village decor it sells
    player(scene);
    dungeonProps(scene);
    drawBuildings(scene);
    drawDungeonArt(scene);
    drawDungeonBiomes(scene);
    drawEnemyArt(scene);

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
