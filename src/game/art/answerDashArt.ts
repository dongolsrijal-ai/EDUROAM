// Answer Dash textures, drawn in the same palette as the village garden (config GARDEN).
// Only track-specific pieces are new; bushes, flower beds, insects and the player sprite
// are the existing village textures.

import type { Scene } from 'phaser';
import { GARDEN as G } from '../config';
import { disc, rect, type Ctx } from './pixel';

export const DASH = { lane: 40, lanes: 4, side: 56, tile: 32 } as const;
export const DASH_WIDTH = DASH.lane * DASH.lanes + DASH.side * 2;

function texture (scene: Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void)
{
    if (scene.textures.exists(key)) return;
    const tex = scene.textures.createCanvas(key, w, h);
    if (!tex) throw new Error(`Could not create texture "${key}"`);
    draw(tex.getContext());
    tex.refresh();
}

export function createAnswerDashTextures (scene: Scene)
{
    // Soft grass with tufts, clover and tiny pastel flowers (tiles seamlessly).
    texture(scene, 'dash-grass', DASH.tile, DASH.tile, (ctx) =>
    {
        rect(ctx, 0, 0, 32, 32, G.grass);
        for (const [x, y] of [[3, 5], [19, 2], [11, 14], [26, 17], [6, 25], [21, 28]]) { rect(ctx, x, y, 1, 2, G.grassDeep); rect(ctx, x + 2, y + 1, 1, 1, G.grassDeep); }
        for (const [x, y] of [[14, 6], [29, 9], [2, 18]]) rect(ctx, x, y, 2, 2, G.grassLight);
        rect(ctx, 24, 6, 1, 1, G.pinkLight); rect(ctx, 8, 21, 1, 1, G.butter); rect(ctx, 16, 26, 1, 1, G.lavender);
    });

    // Cream path: one lane wide, with pebbles and a faint dashed lane divider on the left edge.
    texture(scene, 'dash-path', DASH.lane, DASH.tile, (ctx) =>
    {
        rect(ctx, 0, 0, DASH.lane, 32, G.cream);
        for (const [x, y] of [[9, 4], [27, 11], [15, 21], [31, 27], [5, 15]]) { rect(ctx, x, y, 2, 1, G.pebble); rect(ctx, x, y + 1, 2, 1, G.creamDark); }
        for (let y = 2; y < 32; y += 8) rect(ctx, 0, y, 1, 4, G.creamDark);
    });

    // Grass edge where the path meets the lawn.
    texture(scene, 'dash-edge', 4, DASH.tile, (ctx) =>
    {
        rect(ctx, 0, 0, 4, 32, G.grassDark);
        for (let y = 0; y < 32; y += 4) rect(ctx, (y / 4) % 2 ? 1 : 2, y, 2, 2, G.clover);
    });

    // Wooden floral arch spanning one lane.
    texture(scene, 'dash-gate', DASH.lane, 30, (ctx) =>
    {
        const w = DASH.lane;
        rect(ctx, 2, 6, 4, 24, G.woodDark); rect(ctx, 3, 6, 2, 24, G.wood);
        rect(ctx, w - 6, 6, 4, 24, G.woodDark); rect(ctx, w - 5, 6, 2, 24, G.wood);
        rect(ctx, 1, 4, w - 2, 5, G.woodDark); rect(ctx, 2, 5, w - 4, 2, G.wood);
        const flowers = [G.coral, G.pink, G.yellow, G.lavender, G.coral, G.pinkLight];
        flowers.forEach((color, i) =>
        {
            const x = 5 + Math.round(i * (w - 10) / (flowers.length - 1));
            disc(ctx, x, 4, 2, color);
            rect(ctx, x, 4, 1, 1, G.butter);
        });
        for (const x of [3, w - 4]) { rect(ctx, x - 1, 14, 3, 2, G.leaf); rect(ctx, x, 22, 2, 2, G.leafMid); }
    });

    // Small sparkle for correct answers.
    texture(scene, 'dash-sparkle', 5, 5, (ctx) =>
    {
        rect(ctx, 2, 0, 1, 5, G.butter); rect(ctx, 0, 2, 5, 1, G.butter); rect(ctx, 2, 2, 1, 1, '#ffffff');
    });
}
