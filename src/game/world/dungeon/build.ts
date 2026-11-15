// Turns a DungeonPlan into one tile grid + markers (props, spawns, enemy slots) + per-room info
// (bounds, role, own door cells) used for room locking. No Phaser, so tests can run it.

import { seededRandom } from '../../random';
import type { DungeonPlan, PlanRoom } from './generate';
import { renderRoom, ROOM_SPECS, type RoomRole } from './rooms';
import { DUNGEON } from './tiles';

/** Width of carved doorways (and corridors) in tiles. */
const DOOR_SIZE = 3;

export type MarkerType =
    | 'torch' | 'pillar' | 'obstacle' | 'decor' | 'chest' | 'finalChest' | 'guardian' | 'portal'
    | 'stairs' | 'spawn' | 'enemySlot' | 'shrine' | 'door';

export interface Marker
{
    type: MarkerType;
    /** Tile coordinates in the whole dungeon. */
    x: number;
    y: number;
    roomId: string;
}

export interface BuiltRoom
{
    id: string;
    role: RoomRole;
    /** Tile rect of the whole room including its walls. */
    x: number;
    y: number;
    w: number;
    h: number;
    /** Carved doorway cells that belong to this room's walls (where gates close). */
    doors: { x: number; y: number }[];
}

const LEGEND: Record<string, { wall: boolean; marker?: MarkerType }> = {
    '#': { wall: true },
    'T': { wall: true, marker: 'torch' },
    '.': { wall: false },
    'P': { wall: false, marker: 'pillar' },
    'O': { wall: false, marker: 'obstacle' },
    'd': { wall: false, marker: 'decor' },
    'C': { wall: false, marker: 'chest' },
    'F': { wall: false, marker: 'finalChest' },
    'G': { wall: false, marker: 'guardian' },
    'X': { wall: false, marker: 'portal' },
    'S': { wall: false, marker: 'stairs' },
    '@': { wall: false, marker: 'spawn' },
    'E': { wall: false, marker: 'enemySlot' },
    'H': { wall: false, marker: 'shrine' },
};

/** Markers whose tile is blocked by a solid object (tests use this for reachability). */
export const SOLID_MARKERS: MarkerType[] = ['pillar', 'obstacle', 'chest', 'finalChest', 'stairs', 'shrine'];

/** Which side of `a` the room `b` is on (rooms of a link always face each other). */
function side (a: PlanRoom, b: PlanRoom): 'east' | 'west' | 'south' | 'north'
{
    if (a.x + a.w <= b.x) return 'east';
    if (b.x + b.w <= a.x) return 'west';
    if (a.y + a.h <= b.y) return 'south';
    return 'north';
}

export function buildDungeon (plan: DungeonPlan, seed = 7)
{
    const rand = seededRandom(seed);
    // Detail tiles (bones / moss) stay sparse: rooms are larger now, and fights must stay readable.
    const floorTile = () => { const r = rand(); return r < 0.025 ? DUNGEON.FLOOR_DETAIL : r < 0.15 ? DUNGEON.FLOOR_ALT : DUNGEON.FLOOR; };

    const cols = Math.max(...plan.rooms.map((r) => r.x + r.w)) + 1;
    const rows = Math.max(...plan.rooms.map((r) => r.y + r.h)) + 1;
    const grid: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(DUNGEON.VOID));
    let markers: Marker[] = [];
    const rooms = new Map<string, BuiltRoom>();

    for (const room of plan.rooms)
    {
        const spec = ROOM_SPECS[room.template];
        if (spec.w !== room.w || spec.h !== room.h) throw new Error(`Room ${room.id} size does not match template "${room.template}"`);
        const template = renderRoom(room.template, rand);
        rooms.set(room.id, { id: room.id, role: room.role, x: room.x, y: room.y, w: room.w, h: room.h, doors: [] });

        template.forEach((row, y) => [...row].forEach((ch, x) =>
        {
            const cell = LEGEND[ch];
            if (!cell) throw new Error(`Unknown room character "${ch}" in "${room.template}"`);
            grid[room.y + y][room.x + x] = cell.wall ? DUNGEON.WALL : (ch === '.' ? floorTile() : DUNGEON.FLOOR);
            if (cell.marker) markers.push({ type: cell.marker, x: room.x + x, y: room.y + y, roomId: room.id });
        }));
    }

    // Doorways through both facing walls + a walled corridor between them.
    const byId = new Map(plan.rooms.map((r) => [r.id, r]));
    const door = (x: number, y: number, roomId: string) =>
    {
        grid[y][x] = DUNGEON.FLOOR;
        markers = markers.filter((m) => !(m.x === x && m.y === y && m.type === 'torch'));
        markers.push({ type: 'door', x, y, roomId });
        rooms.get(roomId)!.doors.push({ x, y });
    };
    const corridor = (x: number, y: number, wall: boolean) =>
    {
        if (grid[y][x] === DUNGEON.VOID || !wall) grid[y][x] = wall ? DUNGEON.WALL : DUNGEON.FLOOR;
    };
    const half = Math.floor(DOOR_SIZE / 2);

    for (const [aId, bId] of plan.links)
    {
        const a = byId.get(aId);
        const b = byId.get(bId);
        if (!a || !b) throw new Error(`Link ${aId} -> ${bId} names an unknown room`);
        const dir = side(a, b);
        if (dir === 'east' || dir === 'west')
        {
            const [left, right] = dir === 'east' ? [a, b] : [b, a];
            const midY = left.y + (left.h - 1) / 2;
            if (midY !== right.y + (right.h - 1) / 2) throw new Error(`Rooms ${aId} and ${bId} are not aligned`);
            for (let y = midY - half; y <= midY + half; y++) { door(left.x + left.w - 1, y, left.id); door(right.x, y, right.id); }
            for (let x = left.x + left.w; x < right.x; x++)
            {
                for (let y = midY - half; y <= midY + half; y++) corridor(x, y, false);
                corridor(x, midY - half - 1, true);
                corridor(x, midY + half + 1, true);
            }
        }
        else
        {
            const [top, bottom] = dir === 'south' ? [a, b] : [b, a];
            const midX = top.x + (top.w - 1) / 2;
            if (midX !== bottom.x + (bottom.w - 1) / 2) throw new Error(`Rooms ${aId} and ${bId} are not aligned`);
            for (let x = midX - half; x <= midX + half; x++) { door(x, top.y + top.h - 1, top.id); door(x, bottom.y, bottom.id); }
            for (let y = top.y + top.h; y < bottom.y; y++)
            {
                for (let x = midX - half; x <= midX + half; x++) corridor(x, y, false);
                corridor(midX - half - 1, y, true);
                corridor(midX + half + 1, y, true);
            }
        }
    }

    return { cols, rows, grid, markers, rooms: [...rooms.values()] };
}

export type BuiltDungeon = ReturnType<typeof buildDungeon>;
