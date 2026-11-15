// Spellshot textures in the village garden palette (config GARDEN) with purple + gold magic.
// The lawn tile is Answer Dash's; flowers, bushes, insects and the player sprite are the
// existing village textures. Everything here is original pixel art.

import type { Scene } from 'phaser';
import { GARDEN as G } from '../config';
import { createAnswerDashTextures } from './answerDashArt';
import { disc, rect } from './pixel';

const MAGIC = {
    violet: '#9b7bea',
    violetDark: '#6f52c4',
    lilac: '#e6dcff',
    gold: '#ffd25e',
    goldDark: '#e0a93a',
    glow: 'rgba(201, 179, 255, 0.28)',
    glowGold: 'rgba(255, 226, 137, 0.35)',
};
export const MAGIC_TINT = { gold: 0xffe189, ash: 0x9c9aa6, violet: 0x9b7bea } as const;

function texture (scene: Scene, key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void)
{
    if (scene.textures.exists(key)) return;
    const tex = scene.textures.createCanvas(key, w, h);
    if (!tex) throw new Error(`Could not create texture "${key}"`);
    draw(tex.getContext());
    tex.refresh();
}

export function createSpellshotTextures (scene: Scene)
{
    createAnswerDashTextures(scene); // dash-grass lawn, dash-sparkle

    // Floating spirit wisp: soft halo, lilac core, white highlight and orbiting motes.
    texture(scene, 'shot-wisp', 40, 34, (ctx) =>
    {
        disc(ctx, 20, 17, 15, MAGIC.glow);
        disc(ctx, 20, 17, 12, MAGIC.glow);
        disc(ctx, 20, 17, 9, G.lavender);
        disc(ctx, 20, 17, 7, MAGIC.lilac);
        disc(ctx, 20, 17, 4, '#ffffff');
        rect(ctx, 15, 12, 2, 2, '#ffffff');
        for (const [x, y, c] of [[4, 9, MAGIC.gold], [35, 24, MAGIC.gold], [33, 6, MAGIC.lilac], [7, 28, MAGIC.lilac]] as const) rect(ctx, x, y, 2, 2, c);
    });

    // Magic bolt (points right; rotated toward the target): gold head, violet trail.
    texture(scene, 'shot-bolt', 14, 7, (ctx) =>
    {
        rect(ctx, 0, 3, 4, 1, MAGIC.violet);
        rect(ctx, 3, 2, 4, 3, MAGIC.violet);
        rect(ctx, 6, 1, 5, 5, MAGIC.gold);
        rect(ctx, 8, 2, 4, 3, '#ffffff');
        rect(ctx, 12, 3, 2, 1, MAGIC.gold);
    });

    // Pixel explosion bits and a shockwave ring.
    texture(scene, 'shot-spark-gold', 3, 3, (ctx) => { rect(ctx, 0, 0, 3, 3, MAGIC.gold); rect(ctx, 1, 1, 1, 1, '#ffffff'); });
    texture(scene, 'shot-spark-violet', 3, 3, (ctx) => { rect(ctx, 0, 0, 3, 3, MAGIC.violet); rect(ctx, 1, 1, 1, 1, MAGIC.lilac); });
    texture(scene, 'shot-puff', 6, 6, (ctx) => { disc(ctx, 3, 3, 2, '#b9b4c4'); rect(ctx, 2, 2, 1, 1, '#e4e1ea'); });
    texture(scene, 'shot-ring', 34, 34, (ctx) =>
    {
        for (let a = 0; a < 64; a++)
        {
            const t = (Math.PI * 2 * a) / 64;
            rect(ctx, Math.round(17 + Math.cos(t) * 15), Math.round(17 + Math.sin(t) * 15), 1, 1, a % 4 ? MAGIC.gold : '#ffffff');
        }
    });

    // The student's staff: wooden shaft, gold prongs, violet crystal.
    texture(scene, 'shot-staff', 9, 30, (ctx) =>
    {
        rect(ctx, 3, 8, 3, 22, G.woodDark);
        rect(ctx, 4, 8, 1, 22, G.wood);
        rect(ctx, 1, 5, 2, 4, MAGIC.goldDark); rect(ctx, 6, 5, 2, 4, MAGIC.goldDark);
        rect(ctx, 2, 0, 5, 7, MAGIC.violetDark);
        rect(ctx, 3, 1, 3, 5, MAGIC.violet);
        rect(ctx, 3, 1, 1, 2, MAGIC.lilac);
    });

    // Glowing rune circle on the grass under the caster.
    texture(scene, 'shot-rune', 56, 20, (ctx) =>
    {
        for (let a = 0; a < 72; a++)
        {
            const t = (Math.PI * 2 * a) / 72;
            const x = Math.round(28 + Math.cos(t) * 26);
            const y = Math.round(10 + Math.sin(t) * 8);
            rect(ctx, x, y, 1, 1, a % 6 === 0 ? MAGIC.gold : MAGIC.violet);
        }
        for (const [x, y] of [[14, 9], [27, 5], [41, 10], [28, 14]]) { rect(ctx, x, y, 2, 1, MAGIC.glowGold); rect(ctx, x, y, 1, 1, MAGIC.gold); }
    });

    // Garden mushrooms (red and lavender caps).
    for (const [key, cap, capDark] of [['shot-mushroom', G.coral, G.coralDark], ['shot-mushroom-lav', G.lavender, MAGIC.violet]] as const)
    {
        texture(scene, key, 10, 10, (ctx) =>
        {
            rect(ctx, 4, 5, 3, 5, G.cream); rect(ctx, 6, 5, 1, 5, G.creamDark);
            rect(ctx, 1, 2, 8, 3, cap); rect(ctx, 2, 1, 6, 1, cap); rect(ctx, 1, 4, 8, 1, capDark);
            rect(ctx, 3, 2, 1, 1, '#ffffff'); rect(ctx, 6, 3, 1, 1, '#ffffff');
        });
    }
}
