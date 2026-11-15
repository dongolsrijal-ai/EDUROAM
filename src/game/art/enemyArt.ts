// ORIGINAL pixel art for the tower's enemies, Hades and their projectiles. 16x16 art drawn at
// 1.5x (24 px characters, same as the player), 2x (Giant, 32 px) or 3x (Hades, 48 px), always on
// whole pixels. Frames per sheet: [walk A, walk B, action] (action = cast / wind-up).

import type { Scene } from 'phaser';
import { ascii, asciiCharacter, asciiScaled, disc, rect, type Ctx, type Palette } from './pixel';

type Draw = (ctx: Ctx, rows: string[], palette: Palette, ox: number) => void;

function sheet (scene: Scene, key: string, size: number, frames: string[][], palette: Palette, draw: Draw)
{
    if (scene.textures.exists(key)) return;
    const tex = scene.textures.createCanvas(key, size * frames.length, size);
    if (!tex) throw new Error(`Could not create texture "${key}"`);
    const ctx = tex.getContext();
    frames.forEach((rows, i) => draw(ctx, rows, palette, i * size));
    tex.refresh();
    frames.forEach((_, i) => tex.add(i, 0, i * size, 0, size, size));
}

const at24: Draw = (ctx, rows, palette, ox) => asciiCharacter(ctx, rows, palette, ox, 0);
const at2x: Draw = (ctx, rows, palette, ox) => asciiScaled(ctx, rows, palette, 2, ox, 0);
const at3x: Draw = (ctx, rows, palette, ox) => asciiScaled(ctx, rows, palette, 3, ox, 0);

/** body = rows 0..12, then one of two leg sets (walk cycle). */
const walk = (body: string[], legsA: string[], legsB: string[], action?: string[]) =>
    [[...body, ...legsA], [...body, ...legsB], action ?? [...body, ...legsA]];

const LEGS_A = ['...oppo..oppo...', '...oppo..oppo...', '...obbo..obbo...'];
const LEGS_B = ['...oppo..oppo...', '...obbo..oppo...', '.........obbo...'];

export function drawEnemyArt (scene: Scene)
{
    // ---------------------------------------------------------------- Zombie (slow, arms out)
    const zombie = [
        '................',
        '.....oooooo.....',
        '....ohhhhhho....',
        '...ohhGhhhhho...',
        '...ogggggggGo...',
        '...ogRggggRgo...',
        '...oggggggggo...',
        '...oggmmmmggo...',
        '....ooggggoo....',
        '.oggoccCcccoggo.',
        '.ogo.occccCo.go.',
        '..o..oCcccco..o.',
        '...oppppppppo...',
    ];
    sheet(scene, 'enemy-zombie', 24, walk(zombie, LEGS_A, LEGS_B), {
        o: '#2b1d14', h: '#3d4a2a', G: '#5f8f45', g: '#8fbf6a', R: '#ff4d4d', m: '#3b1d1d',
        c: '#7a6a58', C: '#5a4c3e', p: '#4a4a6a', b: '#2b1d14',
    }, at24);

    // ---------------------------------------------------------------- Goblin (small, big ears, dagger)
    const goblin = [
        '................',
        '................',
        '.....oooooo.....',
        '....obbbbbbo....',
        'o..obbbbbbbbo..o',
        'oo.oggggggggo.oo',
        '.ogoYggggggYogo.',
        '..ogggggggggo...',
        '....oggmmggo....',
        '...oLLLLLLLLo.w.',
        '..ogLLLLLLLLgow.',
        '..oo.oLLLLo.ooo.',
        '....oppppppo....',
    ];
    sheet(scene, 'enemy-goblin', 24, walk(goblin, ['....oppoppo.....', '....oppoppo.....', '....obbobbo.....'], ['....oppoppo.....', '...oppo.oppo....', '...obbo.obbo....']), {
        o: '#22180f', b: '#7a4a2a', g: '#7fcf5a', Y: '#ffe14a', m: '#2b1d14', L: '#8a5a32',
        p: '#4a3a2a', w: '#dfe5ea',
    }, at24);

    // ---------------------------------------------------------------- Wizard (robe, hat, staff; 3rd frame = casting)
    const wizard = (glow: boolean) => [
        '.......o........',
        '......oHo.......',
        '.....oHHHo......',
        '....oHHyHHo.....',
        '...oHHHHHHHo..s.',
        '..ooooooooooo.s.',
        '...ossssssso..s.',
        '...osessssesoss.',
        '...owwwwwwwwo.s.',
        '...oRRwwwwRRo.s.',
        '..oRRRwwwwRRRos.',
        '..oRRRRRRRRRRos.',
        '..oRRRrRRrRRRo..',
        ...(glow ? ['..oRRRRRRRRRRo**', '...oRRRRRRRRo.**', '....oooooooo....'] : ['..oRRRRRRRRRRo..', '...oRRRRRRRRo...', '....oooooooo....']),
    ];
    sheet(scene, 'enemy-wizard', 24, [wizard(false), wizard(false).map((r, i) => (i >= 13 ? r.replace('oRRRRRRRRo', 'oRRRrrRRRo') : r)), wizard(true)].map((rows, f) =>
        f === 2 ? rows.map((r, i) => (i === 4 || i === 5 ? r.replace(/s/g, '*') : r)) : rows), {
        o: '#1d1530', H: '#6a3fb0', y: '#ffe14a', s: '#8a5a32', e: '#2b1d14', w: '#eeeeee', R: '#7b4fd0', r: '#5a35a0',
        '*': '#ff9bf0',
    }, at24);

    // ---------------------------------------------------------------- Skeleton (summoned)
    const skeleton = [
        '................',
        '.....oooooo.....',
        '....owwwwwwo....',
        '...owwwwwwwwo...',
        '...owKKwwKKwo...',
        '...owKKwwKKwo...',
        '...owwwwwwwwo...',
        '....owkwkwko....',
        '.....oooooo.....',
        '....owwkwwo.....',
        '...ow.wkw.wo....',
        '...o.owkwo.o....',
        '.....owwwo......',
    ];
    sheet(scene, 'enemy-skeleton', 24, walk(skeleton, ['.....ow.wo......', '.....ow.wo......', '....oww.wwo.....'], ['.....ow.wo......', '....ow...wo.....', '...oww...wwo....']), {
        o: '#2b2430', w: '#f1ecdf', K: '#2b2430', k: '#b9b1a0',
    }, at24);

    // ---------------------------------------------------------------- Soul Reaper (floating hood + scythe; 3rd frame = summoning)
    const reaper = (eyes: string, hem: string) => [
        '..........sss...',
        '.....oooo.s..s..',
        '....oKKKKo....s.',
        '...oKKKKKKo...s.',
        '...oKkkkkKo...s.',
        `...oK${eyes}kk${eyes}Ko...s.`,
        '...oKkkkkKo..o..',
        '..oKKKKKKKKoo...',
        '..oKKKKKKKKKo...',
        '.oKKKKKKKKKKo...',
        '.oKKKKKKKKKKo...',
        '.oKKKKKKKKKKo...',
        hem,
        '................',
        '....ssssss......',
        '................',
    ];
    sheet(scene, 'enemy-reaper', 24, [
        reaper('E', '.oK.KK.KK.Ko....'),
        reaper('E', '.o.KK.KK.KK.o...'),
        reaper('*', '.oK.KK.KK.Ko....'),
    ], {
        o: '#120c18', K: '#2c2140', k: '#120c18', E: '#7be3ff', '*': '#ff6bf0', s: '#9aa3b5',
    }, (ctx, rows, palette, ox) =>
    {
        disc(ctx, ox + 12, 22, 4, 'rgba(0, 0, 0, 0.25)'); // floating shadow
        asciiCharacter(ctx, rows.map((r, i) => (i === 14 ? '................' : r)), palette, ox, 0);
    });

    // ---------------------------------------------------------------- Giant (2x, club; 3rd frame = slam wind-up)
    const giant = (club: string[]) => [
        '.....oooooo.....',
        '....oSSSSSSo....',
        '....oSeSSeSo....',
        '....oSSmmSSo....',
        '..oooSSSSSSooo..',
        '.oSSoBBBBBBoSSo.',
        '.oSSBBBBBBBBSSo.',
        '.oSSBBBBBBBBSSo.',
        '.ooSBBbbbbBBSoo.',
        '..ooBBBBBBBBoo..',
        '...oBBBBBBBBo...',
        '...oPPPoPPPPo...',
        ...club,
    ];
    sheet(scene, 'enemy-giant', 32, [
        giant(['...oPPo..oPPo...', '...oPPo..oPPo...', '..oFFFo..oFFFo..', '................']),
        giant(['...oPPo..oPPo...', '..oPPo....oPPo..', '..oFFo....oFFo..', '................']),
        giant(['...oPPo..oPPo...', '...oPPo..oPPo...', '..oFFFo..oFFFo..', '................']).map((r, i) => (i === 4 ? 'cc.ooSSSSSSoo.cc' : i === 5 ? 'cc.oBBBBBBBBo.cc' : r)),
    ], {
        o: '#2a1c14', S: '#b58a6a', e: '#ff5a3c', m: '#5a2a1a', B: '#6b5a4a', b: '#4a3a2c', P: '#5a4a3a', F: '#3a2a1c', c: '#8a5a32',
    }, at2x);

    // ---------------------------------------------------------------- Hades, King of the Dead (3x)
    // Undead necromancer king: spiked gold crown on a hooded skull, high violet collar, soul
    // amulet, tattered robe, and a cursed staff crowned with soul-fire (cols 13-15, outside the
    // hurtbox). Body silhouette = cols 1-12, rows 0-14 (matches hurtbox 32x42 at 3x).
    // Frames: 0-1 idle (flame flicker, hem sway), 2 cast (staff raised, eyes flare, soul-fire in
    // hand), 3 summon (arms spread, runes at the hem), 4 collapse (defeat).
    const hadesBody = (top: string[], hem: string) => [
        ...top,
        '.oKSSSSSSSKo..f.',
        '.oKSE.S.ESKo..s.',
        '.oKSoSoSoSKo..s.',
        'oMMoKKKKKoMMo.s.',
        'oMRRRRARRRRMohs.',
        'oRRrRAWARrRRo.s.',
        'oRRrRRARRrRRo.s.',
        '.oRrRRRRRrRo..s.',
        '.oRrRMRMRrRo..s.',
        'oRRrRRMRRrRRo.s.',
        'oRrRrRRRrRrRo.s.',
        hem,
        '................',
    ];
    sheet(scene, 'boss-hades', 48, [
        hadesBody(['..y.y.Y.y.y...f.', '..yyyyYyyyy..fFf', '..oKKKKKKKo..fWf'], '.o.oRo.oRo.o.ss.'),
        hadesBody(['..y.y.Y.y.y..f..', '..yyyyYyyyy.fFf.', '..oKKKKKKKo.fWFf'], 'o.oRo.oRo.o.o.s.'),
        [
            '..y.y.Y.y.y..fFf', '..yyyyYyyyy.fWWF', '..oKKKKKKKo..fFf', '.oKSSSSSSSKo.hf.',
            '.oKS*.S.*SKo.hs.', '.oKSoSoSoSKo..s.', 'oMMoKKKKKoMMo.s.', 'xhRRRRARRRRMo.s.',
            'xxRrRAWARrRRo.s.', 'oRRrRRARRrRRo.s.', '.oRrRRRRRrRo..s.', '.oRrRMRMRrRo..s.',
            'oRRrRRMRRrRRo.s.', 'oRrRrRRRrRrRo.s.', '.o.oRo.oRo.o.ss.', '................',
        ],
        [
            '..y.y.Y.y.y...f.', '..yyyyYyyyy..fFf', '..oKKKKKKKo..fWf', '.oKSSSSSSSKo..f.',
            '.oKS*.S.*SKo..s.', 'xhKSoSoSoSKohxs.', 'xMMoKKKKKoMMhxs.', 'oMRRRRARRRRMo.s.',
            'oRRrRAWARrRRo.s.', 'oRRrRRARRrRRo.s.', '.oRrRRRRRrRo..s.', '.oRrRMRMRrRo..s.',
            'oRRrRRMRRrRRo.s.', 'oRrRrRRRrRrRo.s.', 'x.oRo.oRo.o.x.s.', '.x.x.x..x.x.x...',
        ],
        [
            '................', '................', '................', '.......y.y......',
            '..oKKKKKKyy.....', '.oKSSSSSSSKo....', '.oKSo.S.oSKo....', 'oMMoSoSoSoMMo...',
            'oMRRRRARRRRMo...', 'oRRrRRRRRrRRo...', 'oRrRrRRRrRrRo...', 'oRRRRRRRRRRRo...',
            '.oRrRRRRRrRo.ss.', 'ooRRRRRRRRRoosss', '.oooooooooooo.s.', '................',
        ],
    ], {
        y: '#ffd34d', Y: '#ff5ad1', o: '#0e0818', K: '#2a1d45', S: '#d9d2c0', E: '#a07bff', '*': '#ff6bf0',
        M: '#8f5bff', R: '#4b2a7a', r: '#2f1a52', A: '#b98bff', W: '#f3e6ff', h: '#d9d2c0',
        s: '#7a6a8a', f: '#8f5bff', F: '#c9a6ff', x: '#b56bff',
    }, at3x);

    // ---------------------------------------------------------------- projectiles + effects
    if (!scene.textures.exists('spell-orb'))
    {
        const tex = scene.textures.createCanvas('spell-orb', 8, 8)!;
        const ctx = tex.getContext();
        disc(ctx, 4, 4, 3, '#b56bff');
        disc(ctx, 4, 4, 2, '#ff9bf0');
        rect(ctx, 3, 3, 1, 1, '#ffffff');
        tex.refresh();
    }
    if (!scene.textures.exists('soul-fire'))
    {
        const tex = scene.textures.createCanvas('soul-fire', 10, 10)!;
        const ctx = tex.getContext();
        disc(ctx, 5, 5, 4, '#4b6bff');
        disc(ctx, 5, 5, 3, '#7be3ff');
        disc(ctx, 5, 5, 1, '#ffffff');
        tex.refresh();
    }
    if (!scene.textures.exists('spawn-rune'))
    {
        const tex = scene.textures.createCanvas('spawn-rune', 16, 16)!;
        ascii(tex.getContext(), [
            '................',
            '.....pppppp.....',
            '...pp......pp...',
            '..p...pppp...p..',
            '..p..p....p..p..',
            '.p..p..pp..p..p.',
            '.p..p.pPPp.p..p.',
            '.p..p.pPPp.p..p.',
            '.p..p..pp..p..p.',
            '..p..p....p..p..',
            '..p...pppp...p..',
            '...pp......pp...',
            '.....pppppp.....',
        ], { p: '#b56bff', P: '#ff9bf0' });
        tex.refresh();
    }
}

/** Looping walk animations (frames 0-1) for every enemy sheet. */
export function createEnemyAnimations (scene: Scene)
{
    for (const [key, rate] of [['enemy-zombie', 3], ['enemy-goblin', 8], ['enemy-wizard', 3], ['enemy-skeleton', 7], ['enemy-reaper', 3], ['enemy-giant', 2], ['boss-hades', 3]] as [string, number][])
    {
        if (scene.anims.exists(`${key}-walk`) || !scene.textures.exists(key)) continue;
        scene.anims.create({ key: `${key}-walk`, frames: [{ key, frame: 0 }, { key, frame: 1 }], frameRate: rate, repeat: -1 });
    }
}
