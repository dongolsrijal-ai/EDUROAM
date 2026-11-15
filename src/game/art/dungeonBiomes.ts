// ORIGINAL pixel art for the dungeon biomes (Haunted Crypt, Overgrown Ruins): tilesets in the
// DUNGEON tile order (world/dungeon/tiles.ts) and the props each biome's templates use.
// Darker and more dangerous than the cozy village, same 16 px grid.

import type { Scene } from 'phaser';
import { DUNGEON, DUNGEON_TILE_COUNT } from '../world/dungeon/tiles';
import { ascii, disc, rect, type Ctx, type Palette } from './pixel';

function texture (scene: Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void)
{
    if (scene.textures.exists(key)) return;
    const tex = scene.textures.createCanvas(key, w, h);
    if (!tex) throw new Error(`Could not create texture "${key}"`);
    draw(tex.getContext());
    tex.refresh();
}

const art = (scene: Scene, key: string, w: number, h: number, rows: string[], palette: Palette) =>
    texture(scene, key, w, h, (ctx) => ascii(ctx, rows, palette));

interface TilePalette
{
    floor: string; floorDark: string; floorLight: string;
    wall: string; wallDark: string; wallLight: string;
    void: string; accent: string; accentLight: string;
}

function tileset (scene: Scene, key: string, c: TilePalette, detail: (ctx: Ctx, ox: number) => void, alt: (ctx: Ctx, ox: number) => void)
{
    texture(scene, key, 16 * DUNGEON_TILE_COUNT, 16, (ctx) =>
    {
        const floor = (ox: number) =>
        {
            rect(ctx, ox, 0, 16, 16, c.floor);
            rect(ctx, ox, 0, 16, 1, c.floorDark);
            rect(ctx, ox, 8, 16, 1, c.floorDark);
            rect(ctx, ox, 0, 1, 8, c.floorDark);
            rect(ctx, ox + 8, 8, 1, 8, c.floorDark);
            rect(ctx, ox + 2, 2, 2, 1, c.floorLight);
            rect(ctx, ox + 10, 10, 2, 1, c.floorLight);
        };
        floor(DUNGEON.FLOOR * 16);
        floor(DUNGEON.FLOOR_ALT * 16);
        alt(ctx, DUNGEON.FLOOR_ALT * 16);
        floor(DUNGEON.FLOOR_DETAIL * 16);
        detail(ctx, DUNGEON.FLOOR_DETAIL * 16);

        const w = DUNGEON.WALL * 16;
        rect(ctx, w, 0, 16, 16, c.wall);
        rect(ctx, w, 0, 16, 2, c.wallLight);
        rect(ctx, w, 5, 16, 1, c.wallDark);
        rect(ctx, w, 10, 16, 1, c.wallDark);
        rect(ctx, w + 4, 2, 1, 3, c.wallDark);
        rect(ctx, w + 12, 6, 1, 4, c.wallDark);
        rect(ctx, w + 8, 11, 1, 3, c.wallDark);
        rect(ctx, w, 14, 16, 2, c.wallDark);
        rect(ctx, w + 2, 7, 2, 2, c.accent); // biome accent (rune / moss)

        rect(ctx, DUNGEON.VOID * 16, 0, 16, 16, c.void);
    });
}

export function drawDungeonBiomes (scene: Scene)
{
    // ---------------------------------------------------------------- Haunted Crypt
    tileset(scene, 'dungeon-crypt', {
        floor: '#34303f', floorDark: '#26222f', floorLight: '#45405a',
        wall: '#504763', wallDark: '#352e44', wallLight: '#6a5f82',
        void: '#0f0c15', accent: '#6b4fa0', accentLight: '#9b7be0',
    }, (ctx, ox) =>
    {
        // bones on the floor
        rect(ctx, ox + 3, 6, 6, 2, '#d9d2c0');
        rect(ctx, ox + 2, 5, 2, 2, '#d9d2c0');
        rect(ctx, ox + 8, 7, 2, 2, '#d9d2c0');
        rect(ctx, ox + 10, 11, 3, 3, '#cfc7b3');
        rect(ctx, ox + 11, 12, 1, 1, '#26222f');
    }, (ctx, ox) =>
    {
        for (const [x, y] of [[3, 3], [4, 4], [5, 4], [6, 5], [6, 6], [12, 11], [11, 12], [13, 12]]) rect(ctx, ox + x, y, 1, 1, '#1d1a26');
    });

    art(scene, 'crypt-pillar', 16, 24, [
        '....oooooooo....',
        '...oSSSSSSSSo...',
        '...oLLLLLLLLo...',
        '....oSSSSSSo....',
        '....oSLSSDSo....',
        '....oSLSSDSo....',
        '....oSLSSDSo....',
        '....oSLKKDSo....',
        '....oSLKKDSo....',
        '....oSLSSDSo....',
        '....oSLSSDSo....',
        '....oSLSSDSo....',
        '....oSLSSDSo....',
        '....oSLSSDSo....',
        '....oSLSSDSo....',
        '....oSLSSDSo....',
        '....oSLSSDSo....',
        '....oSSSSSSo....',
        '...oSSSSSSSSo...',
        '...oDDDDDDDDo...',
        '..oSSSSSSSSSSo..',
        '..oDDDDDDDDDDo..',
        '..ssssssssssss..',
    ], { o: '#1a1522', S: '#6a5f82', L: '#8a7fa6', D: '#4a4060', K: '#9b7be0', s: 'rgba(0,0,0,0.3)' });

    art(scene, 'tombstone', 16, 16, [
        '................',
        '.....oooooo.....',
        '....oSSSSSSo....',
        '...oSSLLLSSSo...',
        '...oSSSLSSSSo...',
        '...oSLLLLLSSo...',
        '...oSSSLSSSSo...',
        '...oSSSLSSSDo...',
        '...oSSSSSSSDo...',
        '...oSSSSSSDDo...',
        '...oDDDDDDDDo...',
        '..ommmmmmmmmmo..',
        '..ommmmmmmmmmo..',
        '..ssssssssssss..',
    ], { o: '#1a1522', S: '#7a7090', L: '#4a4060', D: '#5a5070', m: '#3d4a2a', s: 'rgba(0,0,0,0.3)' });

    art(scene, 'bones', 16, 16, [
        '................',
        '................',
        '................',
        '................',
        '..ww............',
        '.wwwwww.........',
        '..ww..ww........',
        '.......ww.......',
        '..........wwww..',
        '.........wKwwKw.',
        '.........wwwwww.',
        '..........wKKw..',
        '................',
    ], { w: '#d9d2c0', K: '#26222f' });

    art(scene, 'candles', 16, 16, [
        '................',
        '................',
        '....f.......f...',
        '...fYf.....fYf..',
        '....w.......w...',
        '...www.....www..',
        '...www..f..www..',
        '...www.fYf.www..',
        '...www..w..www..',
        '...www.www.www..',
        '..ooooowwwooooo.',
        '.......ooo......',
    ], { f: '#ff9b3d', Y: '#fff1a8', w: '#e8e0d0', o: '#4a4060' });

    art(scene, 'gate-crypt', 16, 16, [
        'oooooooooooooooo',
        'oGGGGGGGGGGGGGGo',
        '.b..b..b..b..b..',
        '.b..b..b..b..b..',
        '.b..b..b..b..b..',
        'oGGGGGGGGGGGGGGo',
        '.b..b..b..b..b..',
        '.b..b..b..b..b..',
        '.b..b..b..b..b..',
        '.b..b..b..b..b..',
        'oGGGGGGGGGGGGGGo',
        '.b..b..b..b..b..',
        '.b..b..b..b..b..',
        '.p..p..p..p..p..',
        '................',
        '................',
    ], { o: '#1a1522', G: '#7a6f96', b: '#8f88a8', p: '#b07be0' });

    texture(scene, 'arena-crypt', 80, 56, (ctx) =>
    {
        // faint rune circle under the boss
        for (const [r, color] of [[26, '#3d2f5c'], [25, '#34303f'], [18, '#3d2f5c'], [17, '#34303f']] as [number, string][])
        {
            for (let a = 0; a < Math.PI * 2; a += 0.02)
            {
                const x = Math.round(40 + Math.cos(a) * r * 1.4);
                const y = Math.round(28 + Math.sin(a) * r);
                rect(ctx, x, y, 1, 1, color);
            }
        }
        for (let i = 0; i < 6; i++)
        {
            const a = (i / 6) * Math.PI * 2;
            rect(ctx, Math.round(40 + Math.cos(a) * 30) - 1, Math.round(28 + Math.sin(a) * 21) - 1, 3, 3, '#6b4fa0');
        }
    });

    // ---------------------------------------------------------------- Overgrown Ruins
    tileset(scene, 'dungeon-ruins', {
        floor: '#3d4a3a', floorDark: '#2c3829', floorLight: '#4f5f4a',
        wall: '#5a6a52', wallDark: '#3c4a36', wallLight: '#758a68',
        void: '#0c140f', accent: '#6fae4a', accentLight: '#9be06a',
    }, (ctx, ox) =>
    {
        // grass tuft growing through the floor
        for (const [x, y] of [[4, 9], [6, 8], [8, 9], [10, 7], [12, 9]]) { rect(ctx, ox + x, y, 1, 3, '#6fae4a'); rect(ctx, ox + x, y, 1, 1, '#9be06a'); }
    }, (ctx, ox) =>
    {
        // moss patch
        for (const [x, y] of [[2, 3], [3, 3], [3, 4], [4, 4], [11, 11], [12, 11], [12, 12], [13, 12], [10, 12]]) rect(ctx, ox + x, y, 1, 1, '#4f7a3a');
    });

    art(scene, 'broken-column', 16, 24, [
        '................',
        '................',
        '.....o.oo.......',
        '....oSoSSo......',
        '....oSSSSSo.....',
        '....oSLSSDSo....',
        '....oSLSSDSo....',
        '....oSLvvDSo....',
        '....oSLSvDSo....',
        '....ovLSSvSo....',
        '....oSvSSDSo....',
        '....oSLSSDvo....',
        '....oSLSSvSo....',
        '....oSvSSDSo....',
        '....oSLSSDSo....',
        '....oSLvSDSo....',
        '....oSLSSDSo....',
        '....oSSSSSSo....',
        '...oSSSSSSSSo...',
        '...oDDDDDDDDo...',
        '..oSSSSSSSSSSo..',
        '..ovDDvDDDvDDo..',
        '..ssssssssssss..',
    ], { o: '#1c2418', S: '#8a9a7a', L: '#a6b494', D: '#5f6f52', v: '#5fa64a', s: 'rgba(0,0,0,0.3)' });

    art(scene, 'mossy-block', 16, 16, [
        '................',
        '................',
        '..oooooooooooo..',
        '.oMMMMvvMMMMMMo.',
        '.oSMMMvSMMMSSSo.',
        '.oSSSSvSSSSSSSo.',
        '.oSLSSSSSSSSDSo.',
        '.oSSSSSSSSSSDSo.',
        '.oSSSSSSSvSSDSo.',
        '.oSSSSSSSvSSDSo.',
        '.oDDDDDDDvDDDDo.',
        '..oooooooooooo..',
        '..ssssssssssss..',
    ], { o: '#1c2418', S: '#7d8a70', L: '#9aa88a', D: '#55624a', M: '#5fa64a', v: '#4f8f3a', s: 'rgba(0,0,0,0.3)' });

    art(scene, 'vines', 16, 16, [
        '................',
        '................',
        '..v.........v...',
        '..vV.......Vv...',
        '...v..v...v.....',
        '..Vv.vVv..vV....',
        '...vv..v.vv.....',
        '....v..vv.......',
        '....vvv.v..v....',
        '......vvvvvV....',
        '.......vv.......',
    ], { v: '#4f8f3a', V: '#7fc45a' });

    art(scene, 'ferns', 16, 16, [
        '................',
        '................',
        '.......l........',
        '..l...lgl...l...',
        '...l..lgl..l....',
        '.l.ll.lgl.ll.l..',
        '..llg.lgl.gll...',
        '....lglgllgl....',
        '.lll.lgggl.lll..',
        '...lllgggllll...',
        '.....lggggl.....',
        '.......gg.......',
    ], { l: '#4f8f3a', g: '#2f5a24' });

    art(scene, 'gate-ruins', 16, 16, [
        'oooooooooooooooo',
        'oWWWWWWWWWWWWWWo',
        '.w..w..w..w..w..',
        '.wv.w..wv.w..wv.',
        '.w..wv.w..wv.w..',
        'oWWWWWWWWWWWWWWo',
        '.wv.w..w..wv.w..',
        '.w..w..wv.w..wv.',
        '.w..wv.w..w..w..',
        '.wv.w..w..wv.w..',
        'oWWWWWWWWWWWWWWo',
        '.w..w..wv.w..w..',
        '.w..wv.w..w..wv.',
        '.v..v..v..v..v..',
    ], { o: '#2a1c12', W: '#8a5a32', w: '#a0703f', v: '#5fa64a' });

    texture(scene, 'arena-ruins', 80, 56, (ctx) =>
    {
        for (let a = 0; a < Math.PI * 2; a += 0.025)
        {
            const r = 25 + Math.round(Math.sin(a * 7) * 1.5);
            rect(ctx, Math.round(40 + Math.cos(a) * r * 1.4), Math.round(28 + Math.sin(a) * r), 2, 1, '#4f6f3a');
        }
        for (let i = 0; i < 8; i++)
        {
            const a = (i / 8) * Math.PI * 2;
            disc(ctx, Math.round(40 + Math.cos(a) * 34), Math.round(28 + Math.sin(a) * 24), 1, '#6fae4a');
        }
    });

    // ---------------------------------------------------------------- shared: healing shrine
    const shrine = (water: string, glow: string) => [
        '................',
        '.......gg.......',
        '......gGGg......',
        '.......gg.......',
        '................',
        '....oooooooo....',
        '...oSSSSSSSSo...',
        '...oSwwwwwwSo...',
        '...oSwWwwWwSo...',
        '...oSwwwwwwSo...',
        '....oSSSSSSo....',
        '.....oSSSSo.....',
        '.....oSLLSo.....',
        '.....oSLLSo.....',
        '.....oSLLSo.....',
        '....oSSSSSSo....',
        '...oDDDDDDDDo...',
        '...ssssssssss...',
    ].map((r) => r.replace(/w/g, water).replace(/g/g, glow));
    art(scene, 'shrine', 16, 24, shrine('w', 'g'), { o: '#1a1522', S: '#8f8a9c', L: '#a8a3b8', D: '#5f5a6d', w: '#4fc3f7', W: '#d6f6ff', g: '#7dff8a', G: '#e6ffe8', s: 'rgba(0,0,0,0.3)' });
    art(scene, 'shrine-used', 16, 24, shrine('d', '.'), { o: '#1a1522', S: '#8f8a9c', L: '#a8a3b8', D: '#5f5a6d', d: '#3a3a4a', W: '#5a5a6a', s: 'rgba(0,0,0,0.3)' });
}
