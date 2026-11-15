// 16x16 placeholder item icons, drawn once into PNG data URLs for the HTML inventory.
// To use real art later, return an image URL (e.g. 'assets/items/sword.png') here instead.

import { ascii, drawCanvas, type Palette } from '../art/pixel';
import { COLORS as C } from '../config';
import type { ItemId } from './itemDefs';

/** Shared 16x16 shapes; items recolor them with their own palette. */
const SHAPES = {
    tunic: [
        '................',
        '...oooo..oooo...',
        '..occccoocccco..',
        '.occccccccccco..',
        '.occccccccccco..',
        '.ooccccccccoo...',
        '...occccccco....',
        '...obbbbbbbo....',
        '...occccccco....',
        '...occccccco....',
        '...occccccco....',
        '...oCCCCCCCo....',
        '...ooooooooo....',
    ].map((row) => ' ' + row.slice(0, 15)),
    sword: [
            '................',
            '............ooo.',
            '...........owwo.',
            '..........owwo..',
            '.........owwo...',
            '........owwo....',
            '.......owwo.....',
            '..oo..owwo......',
            '..ogooowo.......',
            '...ogggo........',
            '....ogo.........',
            '...ohoggo.......',
            '..ohho.oo.......',
            '.ohho...........',
            '.ooo............',
        ],
    bow: [
            '.........oo.....',
            '........owos....',
            '.......owo.s....',
            '......owo..s....',
            '.....owo...s....',
            '.....owo...s....',
            '....ogo....s....',
            '....ogo....s....',
            '....ogo....s....',
            '.....owo...s....',
            '.....owo...s....',
            '......owo..s....',
            '.......owo.s....',
            '........owos....',
            '.........oo.....',
        ],
    potion: [
            '................',
            '......oooo......',
            '......occo......',
            '......oggo......',
            '......oggo......',
            '.....oggggo.....',
            '....oggggggo....',
            '...orrrrrrrro...',
            '...orRrrrrrro...',
            '...orRrrrrrro...',
            '...orrrrrrrro...',
            '...orrrrrrrro...',
            '....orrrrrro....',
            '.....oooooo.....',
        ],
    crystal: [
            '................',
            '.......oo.......',
            '......oLpo......',
            '.....oLppPo.....',
            '....oLpppPPo....',
            '...oLppppPPPo...',
            '...oLppppPPPo...',
            '...oLppppPPPo...',
            '...oLppppPPPo...',
            '....oLpppPPo....',
            '.....oLppPo.....',
            '......oLpo......',
            '.......oo.......',
        ],
};

const ICONS: Record<ItemId, { rows: string[]; palette: Palette }> = {
    cloth_armor: { rows: SHAPES.tunic, palette: { o: C.outline, c: C.pathLight, C: C.path, b: C.trunkDark } },
    small_health_potion: { rows: SHAPES.potion, palette: { o: C.outline, c: C.trunk, g: '#dff2fb', r: '#d94141', R: '#ff9b9b' } },
    number_crystal: { rows: SHAPES.crystal, palette: { o: C.outline, L: '#e6d6ff', p: '#a77bf0', P: '#7446c2' } },
    reinforced_armor: { rows: SHAPES.tunic, palette: { o: C.outline, c: '#b4bec8', C: '#7c8792', b: C.gold } },
    large_health_potion: { rows: SHAPES.potion, palette: { o: C.outline, c: C.gold, g: '#dff2fb', r: '#c2185b', R: '#f48fb1' } },
    magic_crystal: { rows: SHAPES.crystal, palette: { o: C.outline, L: '#e0fbff', p: '#4fc3f7', P: '#1e88e5' } },
    warden_plate: { rows: SHAPES.tunic, palette: { o: C.outline, c: '#8a93b8', C: '#5a6290', b: '#ffd34d' } },
};

/** The permanent weapons' sprites (Phaser textures 'weapon-sword' / 'weapon-bow', drawn when attacking). */
const WEAPON_ICONS = {
    sword: { rows: SHAPES.sword, palette: { o: C.outline, w: '#dfe5ea', g: C.gold, h: C.trunkDark } },
    bow: { rows: SHAPES.bow, palette: { o: C.outline, w: C.trunk, g: C.trunkDark, s: '#e9e1cf' } },
};

export function weaponIconCanvas (id: keyof typeof WEAPON_ICONS): HTMLCanvasElement
{
    const { rows, palette } = WEAPON_ICONS[id];
    return drawCanvas(16, 16, (ctx) => ascii(ctx, rows, palette));
}

const cache = new Map<ItemId, string>();

/** 16x16 canvas of an item icon (also registered as Phaser texture `item-<id>`). */
export function itemIconCanvas (id: ItemId): HTMLCanvasElement
{
    const { rows, palette } = ICONS[id];
    return drawCanvas(16, 16, (ctx) => ascii(ctx, rows, palette));
}

export function itemIconUrl (id: ItemId): string
{
    let url = cache.get(id);
    if (!url)
    {
        url = itemIconCanvas(id).toDataURL();
        cache.set(id, url);
    }
    return url;
}
