// Crystal shop art: the market stall and every village decoration it sells (bench, fountain,
// fences, lamps...). Original pixel art in the village garden palette (config GARDEN). Texture
// keys are used by world/objectTypes.ts; the upgraded homes and paths are drawn in gardenArt.ts.

import type { Scene } from 'phaser';
import { GARDEN as G } from '../config';
import { disc, rect, type Ctx } from './pixel';

const GLOW = 'rgba(255, 226, 137, 0.4)';

function texture (scene: Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void)
{
    if (scene.textures.exists(key)) return;
    const tex = scene.textures.createCanvas(key, w, h);
    if (!tex) throw new Error(`Could not create texture "${key}"`);
    draw(tex.getContext());
    tex.refresh();
}

export function drawVillageShopArt (scene: Scene)
{
    // Market stall: striped purple awning, wooden counter, crystals on display.
    texture(scene, 'shop-stall', 48, 44, (ctx) =>
    {
        rect(ctx, 3, 40, 43, 4, G.shadow);
        for (const x of [3, 42]) { rect(ctx, x, 12, 4, 30, G.outline); rect(ctx, x + 1, 12, 2, 29, G.wood); }
        // Counter
        rect(ctx, 5, 26, 38, 16, G.outline);
        rect(ctx, 6, 27, 36, 14, G.wood);
        rect(ctx, 6, 27, 36, 3, G.dirtLight);
        for (const x of [14, 24, 34]) rect(ctx, x, 30, 1, 11, G.woodDark);
        // Awning
        rect(ctx, 0, 2, 48, 13, G.outline);
        for (let i = 0; i < 8; i++) rect(ctx, 1 + i * 6, 3, i === 7 ? 4 : 6, 11, i % 2 ? G.cream : G.lavender);
        rect(ctx, 1, 3, 46, 1, '#e6dcff');
        for (let i = 0; i < 8; i++) { rect(ctx, 1 + i * 6, 14, 5, 2, i % 2 ? G.creamDark : '#9b7bea'); rect(ctx, 2 + i * 6, 16, 3, 1, i % 2 ? G.creamDark : '#9b7bea'); }
        // Crystals on the counter
        for (const [x, c, hi] of [[11, '#a77bf0', '#e6d6ff'], [22, '#4fc3f7', '#e0fbff'], [32, '#a77bf0', '#e6d6ff']] as [number, string, string][])
        {
            rect(ctx, x, 21, 5, 6, G.outline);
            rect(ctx, x + 1, 20, 3, 1, G.outline);
            rect(ctx, x + 1, 21, 3, 5, c);
            rect(ctx, x + 1, 21, 1, 3, hi);
        }
        // Hanging sign with a crystal
        rect(ctx, 19, 0, 10, 5, G.outline);
        rect(ctx, 20, 1, 8, 3, G.butter);
        rect(ctx, 23, 1, 2, 3, '#7446c2');
    });

    texture(scene, 'bench', 24, 14, (ctx) =>
    {
        rect(ctx, 2, 12, 20, 2, G.shadow);
        rect(ctx, 1, 1, 22, 6, G.outline);
        rect(ctx, 2, 2, 20, 1, G.wood); rect(ctx, 2, 4, 20, 2, G.wood);
        rect(ctx, 0, 7, 24, 4, G.outline);
        rect(ctx, 1, 8, 22, 2, G.dirtLight);
        for (const x of [2, 19]) { rect(ctx, x, 10, 3, 4, G.outline); rect(ctx, x + 1, 10, 1, 3, G.woodDark); }
    });

    texture(scene, 'fountain', 32, 32, (ctx) =>
    {
        rect(ctx, 3, 28, 26, 4, G.shadow);
        // Basin
        rect(ctx, 1, 16, 30, 13, G.outline);
        rect(ctx, 2, 17, 28, 11, G.stone);
        rect(ctx, 2, 17, 28, 2, G.stoneLight);
        rect(ctx, 4, 19, 24, 6, G.water);
        rect(ctx, 6, 20, 5, 1, G.waterLight); rect(ctx, 19, 22, 6, 1, G.waterLight);
        for (const x of [8, 16, 24]) rect(ctx, x, 26, 1, 2, G.stoneDark);
        // Pillar + bowl
        rect(ctx, 13, 8, 6, 14, G.outline);
        rect(ctx, 14, 9, 4, 12, G.stone);
        rect(ctx, 14, 9, 1, 12, G.stoneLight);
        rect(ctx, 9, 6, 14, 4, G.outline);
        rect(ctx, 10, 7, 12, 2, G.stoneLight);
        // Water jet and falling streams
        rect(ctx, 15, 1, 2, 6, G.waterLight);
        rect(ctx, 14, 2, 1, 2, G.water); rect(ctx, 17, 2, 1, 2, G.water);
        for (const x of [10, 21]) { rect(ctx, x, 9, 1, 10, G.waterLight); rect(ctx, x, 12, 1, 2, G.water); }
        rect(ctx, 5, 24, 1, 1, G.moss); rect(ctx, 26, 27, 2, 1, G.moss);
    });

    texture(scene, 'potted-plant', 10, 14, (ctx) =>
    {
        rect(ctx, 1, 13, 8, 1, G.shadow);
        rect(ctx, 1, 8, 8, 2, G.outline);
        rect(ctx, 2, 9, 6, 5, G.coralDark);
        rect(ctx, 2, 8, 6, 1, G.coral);
        rect(ctx, 3, 10, 1, 3, G.coral);
        disc(ctx, 5, 4, 3, G.leafDark);
        disc(ctx, 4, 4, 2, G.leafMid);
        rect(ctx, 3, 2, 2, 2, G.pink); rect(ctx, 6, 3, 2, 2, G.yellow); rect(ctx, 5, 0, 2, 2, G.lavender);
    });

    // Vegetable plot: tilled rows with sprouts, a pumpkin and a little marker.
    texture(scene, 'garden-patch', 32, 24, (ctx) =>
    {
        rect(ctx, 0, 2, 32, 22, G.outlineSoft);
        rect(ctx, 1, 3, 30, 20, G.dirtDark);
        for (let y = 5; y < 22; y += 5)
        {
            rect(ctx, 2, y, 28, 2, G.dirt);
            for (let x = 4; x < 29; x += 5) { rect(ctx, x, y - 2, 1, 2, G.leafMid); rect(ctx, x - 1, y - 2, 1, 1, G.leaf); rect(ctx, x + 1, y - 3, 1, 1, G.leaf); }
        }
        disc(ctx, 25, 18, 3, G.coralDark); disc(ctx, 24, 17, 2, G.coral); rect(ctx, 25, 14, 1, 2, G.leafDark);
        rect(ctx, 6, 13, 3, 3, G.coral); rect(ctx, 7, 12, 1, 1, G.leafMid);
        rect(ctx, 28, 0, 1, 6, G.woodDark); rect(ctx, 26, 0, 5, 3, G.cream);
    });

    texture(scene, 'barrels', 26, 22, (ctx) =>
    {
        rect(ctx, 1, 19, 24, 3, G.shadow);
        // Crate
        rect(ctx, 13, 8, 13, 13, G.outline);
        rect(ctx, 14, 9, 11, 11, G.dirtLight);
        rect(ctx, 14, 9, 11, 2, G.wood); rect(ctx, 14, 18, 11, 2, G.wood);
        for (let i = 0; i < 9; i++) rect(ctx, 15 + i, 10 + i, 2, 1, G.woodDark);
        // Barrel
        rect(ctx, 1, 4, 12, 17, G.outline);
        rect(ctx, 2, 5, 10, 15, G.wood);
        rect(ctx, 2, 5, 3, 15, G.dirtLight);
        rect(ctx, 10, 5, 2, 15, G.woodDark);
        for (const y of [7, 16]) rect(ctx, 1, y, 12, 2, G.stoneDark);
        rect(ctx, 3, 3, 8, 2, G.outline); rect(ctx, 4, 3, 6, 1, G.woodDark);
        // Small sack on the crate
        disc(ctx, 20, 5, 3, G.outlineSoft); disc(ctx, 20, 5, 2, G.cream); rect(ctx, 19, 1, 2, 2, G.outlineSoft);
    });

    texture(scene, 'signpost', 16, 22, (ctx) =>
    {
        rect(ctx, 4, 20, 9, 2, G.shadow);
        rect(ctx, 7, 3, 3, 18, G.outline);
        rect(ctx, 8, 3, 1, 17, G.wood);
        rect(ctx, 1, 4, 14, 5, G.outline); rect(ctx, 2, 5, 12, 3, G.dirtLight); rect(ctx, 14, 5, 1, 3, G.dirtLight); rect(ctx, 15, 6, 1, 1, G.outline);
        rect(ctx, 4, 6, 6, 1, G.woodDark);
        rect(ctx, 1, 11, 13, 5, G.outline); rect(ctx, 2, 12, 11, 3, G.dirtLight); rect(ctx, 0, 13, 1, 1, G.outline);
        rect(ctx, 5, 13, 6, 1, G.woodDark);
    });

    // Lanterns: a single lamp post and a taller twin-arm street light, both softly glowing.
    const lantern = (ctx: Ctx, x: number, y: number) =>
    {
        disc(ctx, x + 2, y + 3, 5, GLOW);
        rect(ctx, x, y, 5, 7, G.outline);
        rect(ctx, x + 1, y + 1, 3, 5, G.butter);
        rect(ctx, x + 2, y + 2, 1, 3, '#ffffff');
        rect(ctx, x, y - 1, 5, 1, G.outline); rect(ctx, x + 1, y - 2, 3, 1, G.outline);
    };
    texture(scene, 'lamp-post', 12, 30, (ctx) =>
    {
        rect(ctx, 2, 28, 8, 2, G.shadow);
        rect(ctx, 5, 10, 2, 19, G.outline);
        rect(ctx, 3, 27, 6, 2, G.outline);
        lantern(ctx, 3, 4);
    });
    texture(scene, 'street-light', 22, 36, (ctx) =>
    {
        rect(ctx, 6, 34, 10, 2, G.shadow);
        rect(ctx, 10, 6, 2, 29, G.outline);
        rect(ctx, 10, 6, 1, 29, G.stoneDark);
        rect(ctx, 7, 33, 8, 2, G.outline);
        rect(ctx, 3, 8, 16, 2, G.outline);
        rect(ctx, 9, 3, 4, 3, G.outline); rect(ctx, 10, 2, 2, 1, G.yellow);
        lantern(ctx, 0, 12);
        lantern(ctx, 17, 12);
        rect(ctx, 2, 10, 1, 2, G.outline); rect(ctx, 19, 10, 1, 2, G.outline);
    });

    // Fences: one tile per segment. '-h' runs east-west, '-v' runs north-south.
    texture(scene, 'fence-wood-h', 16, 16, (ctx) =>
    {
        rect(ctx, 0, 7, 16, 2, G.woodDark); rect(ctx, 0, 11, 16, 2, G.woodDark);
        for (const x of [1, 6, 11])
        {
            rect(ctx, x, 3, 4, 13, G.outline);
            rect(ctx, x + 1, 4, 2, 11, G.cream);
            rect(ctx, x + 1, 2, 2, 2, G.outline); rect(ctx, x + 1, 3, 2, 1, G.cream);
        }
    });
    texture(scene, 'fence-wood-v', 16, 16, (ctx) =>
    {
        rect(ctx, 6, 0, 4, 16, G.outline);
        rect(ctx, 7, 0, 2, 16, G.cream);
        for (const y of [2, 10]) { rect(ctx, 5, y, 6, 4, G.outline); rect(ctx, 6, y + 1, 4, 2, G.creamDark); }
    });
    const stones = (ctx: Ctx, x: number, y: number, w: number, h: number) =>
    {
        rect(ctx, x, y, w, h, G.outlineSoft);
        rect(ctx, x + 1, y + 1, w - 2, h - 2, G.stone);
        rect(ctx, x + 1, y + 1, w - 2, 1, G.stoneLight);
    };
    texture(scene, 'fence-stone-h', 16, 16, (ctx) =>
    {
        rect(ctx, 0, 14, 16, 2, G.shadow);
        stones(ctx, 0, 6, 8, 5); stones(ctx, 8, 6, 8, 5);
        stones(ctx, -4, 10, 8, 5); stones(ctx, 4, 10, 8, 5); stones(ctx, 12, 10, 8, 5);
        rect(ctx, 0, 5, 16, 1, G.outlineSoft);
        rect(ctx, 3, 5, 3, 1, G.moss); rect(ctx, 11, 6, 2, 1, G.moss);
    });
    texture(scene, 'fence-stone-v', 16, 16, (ctx) =>
    {
        stones(ctx, 4, 0, 8, 6); stones(ctx, 4, 5, 8, 6); stones(ctx, 4, 10, 8, 6);
        rect(ctx, 5, 4, 2, 1, G.moss); rect(ctx, 9, 11, 2, 1, G.moss);
    });
}
