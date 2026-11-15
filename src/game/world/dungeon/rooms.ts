// Reusable dungeon ROOM TEMPLATES. A template is a size + a feature recipe; renderRoom() turns
// it into ASCII rows (same legend as before), so templates are configurable instead of being
// hand-drawn at one fixed size.
//
// Doors are NOT drawn here: build.ts carves a DOOR_SIZE-wide doorway in the middle of any wall
// that connects to a neighbouring room and runs a short corridor between them. Every template
// keeps a clear DOOR LANE in front of each wall's middle (no props, no spawns) and a clear
// central combat area, so doors never open into solid objects and fights have room to dodge.
// tests/dungeonGen.test.mts checks door lanes, reachability and boss clearance for many seeds.
//
// Legend
//   #  wall               .  floor                 T  wall with a torch
//   P  pillar / column (solid, biome art)          O  obstacle: tombstone / mossy block (solid)
//   d  floor decoration (walkable, biome art)      E  enemy spawn slot
//   C  treasure chest     F  final reward chest    G  boss
//   X  portal (exit / descend)                     S  arrival stairs (sealed during a run)
//   H  healing shrine     @  player spawn

export type RoomRole = 'start' | 'combat' | 'treasure' | 'shrine' | 'exit' | 'boss';

export interface RoomSpec
{
    /** Outer size in tiles, walls included. Odd numbers keep doors exactly centred. */
    w: number;
    h: number;
    /** What the room is for (shown in debug tools, used by tests). */
    purpose: string;
    /** Feature recipe used by renderRoom(). */
    layout: 'start' | 'pillars' | 'tombs' | 'garden' | 'broken' | 'large' | 'ranged' | 'summoner' | 'treasure' | 'shrine' | 'exit' | 'boss';
    /** Walkable decoration density (share of eligible floor cells). */
    decor: number;
}

/** Previous standard room size (15x11); combat rooms are now ~40-55 % larger per side. */
export const LEGACY_ROOM = { w: 15, h: 11 };

export const ROOM_SPECS = {
    start: { w: 15, h: 11, purpose: 'arrival', layout: 'start', decor: 0.03 },
    combatPillars: { w: 21, h: 15, purpose: 'standard combat', layout: 'pillars', decor: 0.025 },
    combatTombs: { w: 21, h: 15, purpose: 'standard combat', layout: 'tombs', decor: 0.03 },
    combatGarden: { w: 21, h: 15, purpose: 'standard combat', layout: 'garden', decor: 0.05 },
    combatBroken: { w: 21, h: 15, purpose: 'standard combat', layout: 'broken', decor: 0.03 },
    combatLarge: { w: 23, h: 17, purpose: 'large combat (room for giants)', layout: 'large', decor: 0.025 },
    rangedArena: { w: 23, h: 15, purpose: 'ranged-enemy arena with low cover', layout: 'ranged', decor: 0.02 },
    summonerArena: { w: 21, h: 17, purpose: 'summoner arena ringed by columns', layout: 'summoner', decor: 0.02 },
    treasure: { w: 15, h: 11, purpose: 'treasure', layout: 'treasure', decor: 0.04 },
    shrine: { w: 15, h: 11, purpose: 'rest / healing', layout: 'shrine', decor: 0.03 },
    exit: { w: 15, h: 11, purpose: 'transition to the next floor', layout: 'exit', decor: 0.03 },
    boss: { w: 31, h: 23, purpose: 'Hades arena', layout: 'boss', decor: 0.02 },
} satisfies Record<string, RoomSpec>;

export type RoomTemplateId = keyof typeof ROOM_SPECS;

/** Kept for code that still asks for "the" template list. */
export const ROOM_TEMPLATES = ROOM_SPECS;

/** Clear distance (tiles) kept in front of each wall's middle for doors. */
const DOOR_LANE = 3;

/** True if (x, y) is inside a door lane or the doorway itself (no props / spawns allowed). */
export function inDoorLane (spec: { w: number; h: number }, x: number, y: number)
{
    const cx = (spec.w - 1) / 2;
    const cy = (spec.h - 1) / 2;
    const nearVertical = Math.abs(x - cx) <= 2 && (y <= DOOR_LANE || y >= spec.h - 1 - DOOR_LANE);
    const nearHorizontal = Math.abs(y - cy) <= 2 && (x <= DOOR_LANE || x >= spec.w - 1 - DOOR_LANE);
    return nearVertical || nearHorizontal;
}

/**
 * ASCII rows for one room. `rand` only places walkable decoration (and torch spacing jitter),
 * so solid geometry, spawns and objectives are fixed per template: predictable, testable.
 */
export function renderRoom (id: RoomTemplateId, rand: () => number = Math.random): string[]
{
    const spec: RoomSpec = ROOM_SPECS[id];
    const { w, h } = spec;
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const g: string[][] = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) =>
        (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.')));
    const set = (x: number, y: number, ch: string) =>
    {
        if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1 || g[y][x] !== '.') return;
        if (ch !== 'd' && inDoorLane(spec, x, y)) return;
        g[y][x] = ch;
    };
    const mirror = (x: number, y: number, ch: string) => { set(x, y, ch); set(w - 1 - x, y, ch); set(x, h - 1 - y, ch); set(w - 1 - x, h - 1 - y, ch); };
    // Spawn slots on a ring around the centre, away from walls and doors.
    const ring = (rx: number, ry: number, count: number) =>
    {
        for (let i = 0; i < count; i++)
        {
            const a = (i / count) * Math.PI * 2 + Math.PI / count;
            set(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), 'E');
        }
    };

    switch (spec.layout)
    {
        case 'start':
            set(Math.round(cx), Math.round(cy), '@');
            set(2, 2, 'S');
            break;
        case 'pillars':
            mirror(4, 3, 'P');
            ring(6, 4, 8);
            break;
        case 'tombs':
            mirror(3, 2, 'O'); mirror(5, 2, 'O');
            ring(6, 4, 8);
            break;
        case 'garden':
            mirror(3, 3, 'O'); mirror(4, 3, 'O'); mirror(3, 4, 'O');
            ring(6, 4, 8);
            for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) set(cx + dx, cy + dy, 'd');
            break;
        case 'broken':
            mirror(3, 3, 'P'); mirror(7, 5, 'P');
            ring(6, 4, 8);
            break;
        case 'large':
            mirror(4, 4, 'P');
            ring(8, 5, 8);
            break;
        case 'ranged':
            // Low cover in two staggered rows: line-of-sight breaks without closing lanes.
            for (const x of [5, 9, 13, 17]) set(x, 5, 'O');
            for (const x of [7, 11, 15]) set(x, h - 6, 'O');
            for (const x of [3, w - 4]) for (const y of [3, h - 4]) set(x, y, 'E');
            for (const x of [Math.round(cx) - 4, Math.round(cx) + 4]) { set(x, 2, 'E'); set(x, h - 3, 'E'); }
            break;
        case 'summoner':
            ring(7, 5, 8);
            for (let i = 0; i < 8; i++)
            {
                const a = (i / 8) * Math.PI * 2;
                set(Math.round(cx + Math.cos(a) * 8), Math.round(cy + Math.sin(a) * 6), 'P');
            }
            break;
        case 'treasure':
            set(Math.round(cx), Math.round(cy), 'C');
            mirror(4, 3, 'd');
            break;
        case 'shrine':
            set(Math.round(cx), Math.round(cy), 'H');
            mirror(3, 3, 'P');
            break;
        case 'exit':
            set(Math.round(cx), Math.round(cy), 'X');
            mirror(3, 3, 'd');
            break;
        case 'boss':
        {
            // Symmetric crypt hall: columns along the walls, grave rows in the corners, the
            // throne end (top) holds the final chest; the open centre is the fight.
            for (let y = 4; y <= h - 5; y += 4) { set(3, y, 'P'); set(w - 4, y, 'P'); }
            for (const x of [6, w - 7]) { set(x, 3, 'P'); set(x, h - 4, 'P'); }
            mirror(2, 2, 'O'); mirror(4, 2, 'O'); mirror(2, 4, 'O');
            set(Math.round(cx), Math.round(cy) - 3, 'G');
            set(Math.round(cx) - 4, 2, 'F');
            set(Math.round(cx) + 4, h - 3, 'X');
            break;
        }
    }

    // Torches on the long walls (not over door middles).
    for (let x = 3; x < w - 3; x += 6) if (Math.abs(x - cx) > 2) { g[0][x] = 'T'; }

    // Controlled walkable decoration: only away from doors, objectives and the centre lane.
    for (let y = 1; y < h - 1; y++)
    {
        for (let x = 1; x < w - 1; x++)
        {
            if (g[y][x] !== '.' || inDoorLane(spec, x, y)) continue;
            if (Math.abs(x - cx) < 3 && Math.abs(y - cy) < 3) continue;
            if (rand() < spec.decor) g[y][x] = 'd';
        }
    }
    return g.map((row) => row.join(''));
}
