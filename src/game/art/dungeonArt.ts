// Placeholder art for the dungeon entrance, sealed stairs, opened chest, exit portal,
// arrows and the Stone Guardian. Drawn on whole pixels like every other texture.

import type { Scene } from 'phaser';
import { COLORS as C } from '../config';
import { asciiScaled, disc, rect, type Ctx } from './pixel';

function texture (scene: Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void)
{
    if (scene.textures.exists(key)) return;
    const tex = scene.textures.createCanvas(key, w, h);
    if (!tex) throw new Error(`Could not create texture "${key}"`);
    draw(tex.getContext());
    tex.refresh();
}

export function drawDungeonArt (scene: Scene)
{
    // Village -> dungeon: 48x48 stone archway with stairs descending into darkness.
    texture(scene, 'dungeon-entrance', 48, 48, (ctx) =>
    {
        rect(ctx, 0, 41, 48, 7, 'rgba(0, 0, 0, 0.32)');               // ground shadow
        disc(ctx, 24, 22, 22, C.outline);                             // arch silhouette
        rect(ctx, 2, 22, 44, 23, C.outline);
        disc(ctx, 24, 22, 21, C.stone);
        rect(ctx, 3, 22, 42, 22, C.stone);
        for (const y of [9, 16, 23, 30, 37]) rect(ctx, 3, y, 42, 1, C.stoneDark);   // block rows
        for (const [x, y] of [[9, 10], [38, 10], [6, 17], [16, 17], [31, 17], [42, 17], [10, 24], [37, 24], [6, 31], [41, 31], [11, 38], [36, 38]])
        {
            rect(ctx, x, y, 1, 6, C.stoneDark);                         // block joints
        }
        rect(ctx, 21, 1, 6, 7, C.outline);                            // keystone
        rect(ctx, 22, 2, 4, 5, C.dWallLight);
        for (const [x, y] of [[5, 26], [6, 27], [6, 28], [7, 29], [40, 12], [41, 13], [41, 14], [42, 15], [43, 33], [42, 34]])
        {
            rect(ctx, x, y, 1, 1, C.dWallDark);                         // cracks
        }

        disc(ctx, 24, 25, 12, C.outline);                             // opening
        rect(ctx, 12, 25, 24, 20, C.outline);
        disc(ctx, 24, 25, 11, C.dVoid);
        rect(ctx, 13, 25, 22, 20, C.dVoid);
        const steps = [C.dWallLight, C.dWall, C.dWallDark, '#2a2335', '#1c1724'];
        steps.forEach((color, i) => rect(ctx, 13 + i, 42 - i * 4, 22 - i * 2, 3, color));  // stairs into the dark

        for (const [x, y] of [[4, 20], [5, 20], [3, 21], [10, 4], [11, 4], [12, 5], [36, 4], [37, 5], [43, 22], [44, 21], [3, 41], [4, 42], [44, 42], [43, 43]])
        {
            rect(ctx, x, y, 1, 1, C.moss);                              // moss
        }
        disc(ctx, 3, 45, 2, C.outline);                               // small rocks
        disc(ctx, 3, 45, 1, C.rock);
        disc(ctx, 45, 44, 2, C.outline);
        disc(ctx, 45, 44, 1, C.rock);
        rect(ctx, 8, 45, 2, 2, C.rockDark);
    });

    // The dungeon's original stairs, now barred shut until the floor is completed.
    texture(scene, 'stairs-sealed', 16, 16, (ctx) =>
    {
        rect(ctx, 0, 0, 16, 16, C.outline);
        [C.dWallLight, C.stone, C.dWall, C.dWallDark].forEach((color, i) => rect(ctx, 1, 1 + i * 4, 14, 3, color));
        for (const x of [2, 6, 10, 13]) rect(ctx, x, 0, 1, 16, '#5b5e66');
        rect(ctx, 0, 3, 16, 1, '#5b5e66');
        rect(ctx, 0, 12, 16, 1, '#5b5e66');
        rect(ctx, 6, 6, 4, 4, C.gold);                                // padlock
        rect(ctx, 7, 7, 2, 2, C.outline);
    });

    // Opened chest (lid up, gold glint inside).
    texture(scene, 'chest-open', 16, 16, (ctx) =>
    {
        rect(ctx, 1, 14, 15, 2, C.shadow);
        rect(ctx, 1, 0, 14, 6, C.outline);
        rect(ctx, 2, 1, 12, 4, C.chestDark);
        rect(ctx, 1, 6, 14, 9, C.outline);
        rect(ctx, 2, 7, 12, 3, '#1a1208');
        rect(ctx, 4, 7, 2, 1, C.gold);
        rect(ctx, 9, 8, 2, 1, C.gold);
        rect(ctx, 2, 10, 12, 4, C.chest);
        rect(ctx, 2, 10, 12, 1, C.chestDark);
    });

    // Exit portal (32x32 swirl).
    texture(scene, 'portal', 32, 32, (ctx) =>
    {
        rect(ctx, 4, 28, 24, 4, 'rgba(0, 0, 0, 0.3)');
        disc(ctx, 16, 16, 15, '#2b145e');
        disc(ctx, 16, 16, 13, '#5b2fc0');
        disc(ctx, 16, 16, 10, '#8a5cff');
        disc(ctx, 16, 16, 7, '#b99bff');
        disc(ctx, 16, 16, 4, '#efe6ff');
        for (const [x, y] of [[6, 9], [24, 7], [27, 19], [8, 24], [17, 3], [15, 29]]) rect(ctx, x, y, 2, 2, '#e8dcff');
    });

    // Arrow pointing right (rotated in flight).
    texture(scene, 'arrow', 12, 5, (ctx) =>
    {
        rect(ctx, 0, 0, 2, 1, '#f4ecd8');
        rect(ctx, 0, 4, 2, 1, '#f4ecd8');
        rect(ctx, 1, 1, 2, 3, '#f4ecd8');
        rect(ctx, 2, 2, 7, 1, C.trunk);
        rect(ctx, 9, 1, 2, 3, '#c9ced6');
        rect(ctx, 11, 2, 1, 1, '#c9ced6');
    });

    // Stone Guardian: 16x16 art at 2x -> crisp 32x32 sprite.
    texture(scene, 'guardian', 32, 32, (ctx) => asciiScaled(ctx, [
        '................',
        '....oooooooo....',
        '...oSSSSSSSSo...',
        '...oSsSSSSsSo...',
        '...oSggSSggSo...',
        '...oSSSSSSSSo...',
        '.oooSSdddddSooo.',
        '.oSSoSSSSSSoSSo.',
        '.oSSSSSrrSSSSSo.',
        '.oSSoSSrrSSoSSo.',
        '.oSSoSSSSSSoSSo.',
        '..ooSSSSSSSSoo..',
        '...oSSSooSSSo...',
        '...oSSo..oSSo...',
        '..oSSSo..oSSSo..',
        '..oooo....oooo..',
    ], { o: C.outline, S: '#7d7891', s: '#a29cb8', g: '#ffd34d', d: C.dWallDark, r: '#7be3ff' }, 2));
}
