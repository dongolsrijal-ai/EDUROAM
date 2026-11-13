// Turns a DungeonPlan into one tile grid + a list of markers (props, spawns, future slots).

import { DUNGEON } from '../../art/textures';
import { seededRandom } from '../../random';
import type { DungeonPlan } from './layout';
import { ROOM_H, ROOM_TEMPLATES, ROOM_W } from './rooms';

/** Width of carved doorways in tiles. */
const DOOR_SIZE = 3;

export type MarkerType = 'torch' | 'pillar' | 'chest' | 'finalChest' | 'guardian' | 'portal' | 'stairs' | 'spawn' | 'monster' | 'npc' | 'door';

export interface Marker
{
    type: MarkerType;
    /** Tile coordinates in the whole dungeon. */
    x: number;
    y: number;
    roomId: string;
}

const LEGEND: Record<string, { wall: boolean; marker?: MarkerType }> = {
    '#': { wall: true },
    'T': { wall: true, marker: 'torch' },
    '.': { wall: false },
    'P': { wall: false, marker: 'pillar' },
    'C': { wall: false, marker: 'chest' },
    'F': { wall: false, marker: 'finalChest' },
    'G': { wall: false, marker: 'guardian' },
    'X': { wall: false, marker: 'portal' },
    'S': { wall: false, marker: 'stairs' },
    '@': { wall: false, marker: 'spawn' },
    'M': { wall: false, marker: 'monster' },
    'N': { wall: false, marker: 'npc' },
};

export function buildDungeon (plan: DungeonPlan, seed = 7)
{
    const rand = seededRandom(seed);
    const floorTile = () => (rand() < 0.12 ? DUNGEON.FLOOR_CRACK : DUNGEON.FLOOR);

    const cols = (Math.max(...plan.rooms.map((r) => r.gx)) + 1) * ROOM_W;
    const rows = (Math.max(...plan.rooms.map((r) => r.gy)) + 1) * ROOM_H;
    const grid: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(DUNGEON.VOID));
    let markers: Marker[] = [];

    for (const room of plan.rooms)
    {
        const template = ROOM_TEMPLATES[room.template];
        const ox = room.gx * ROOM_W;
        const oy = room.gy * ROOM_H;
        if (template.length !== ROOM_H || template.some((row) => row.length !== ROOM_W))
        {
            throw new Error(`Room template "${room.template}" must be ${ROOM_W}x${ROOM_H}`);
        }

        template.forEach((row, y) => [...row].forEach((ch, x) =>
        {
            const cell = LEGEND[ch];
            if (!cell) throw new Error(`Unknown room character "${ch}" in "${room.template}"`);
            grid[oy + y][ox + x] = cell.wall ? DUNGEON.WALL : floorTile();
            if (cell.marker) markers.push({ type: cell.marker, x: ox + x, y: oy + y, roomId: room.id });
        }));
    }

    // Carve a doorway through both facing walls of every linked pair.
    const byId = new Map(plan.rooms.map((r) => [r.id, r]));
    const carve = (x: number, y: number, roomId: string) =>
    {
        grid[y][x] = floorTile();
        markers = markers.filter((m) => !(m.x === x && m.y === y && m.type === 'torch'));
        markers.push({ type: 'door', x, y, roomId });
    };
    const half = Math.floor(DOOR_SIZE / 2);

    for (const [aId, bId] of plan.links)
    {
        const a = byId.get(aId);
        const b = byId.get(bId);
        if (!a || !b) throw new Error(`Link ${aId} -> ${bId} names an unknown room`);
        const dx = b.gx - a.gx;
        const dy = b.gy - a.gy;

        if (Math.abs(dx) + Math.abs(dy) !== 1) throw new Error(`Rooms ${aId} and ${bId} are not neighbours`);

        if (dx !== 0)
        {
            const left = dx > 0 ? a : b;
            const wallX = (left.gx + 1) * ROOM_W - 1;
            const midY = left.gy * ROOM_H + Math.floor(ROOM_H / 2);
            for (let y = midY - half; y <= midY + half; y++) { carve(wallX, y, aId); carve(wallX + 1, y, bId); }
        }
        else
        {
            const top = dy > 0 ? a : b;
            const wallY = (top.gy + 1) * ROOM_H - 1;
            const midX = top.gx * ROOM_W + Math.floor(ROOM_W / 2);
            for (let x = midX - half; x <= midX + half; x++) { carve(x, wallY, aId); carve(x, wallY + 1, bId); }
        }
    }

    return { cols, rows, grid, markers };
}
