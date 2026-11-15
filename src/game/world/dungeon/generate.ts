// PROCEDURAL FLOOR LAYOUT (no Phaser): places room templates as tile rectangles.
//
//   main path   start -> combat rooms -> exit (or boss arena on the final floor), a random walk
//               so every floor has a guaranteed route from entrance to exit
//   branches    a treasure room and sometimes a rest shrine hang off the combat rooms
//
// Rooms are fewer and larger than before and packed compactly: each new room sits next to its
// neighbour with a short CORRIDOR (centres aligned, so doors face each other), never overlapping
// another room or corridor. Everything comes from the run seed + floor index, so a run can be
// replayed exactly (DungeonPlan is what build.ts turns into tiles).

import { seededRandom } from '../../random';
import { BIOMES, type BiomeId } from './biomes';
import { ROOM_SPECS, type RoomRole, type RoomTemplateId } from './rooms';

export interface PlanRoom
{
    id: string;
    role: RoomRole;
    template: RoomTemplateId;
    /** Tile rect (walls included). */
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface DungeonPlan
{
    rooms: PlanRoom[];
    /** Pairs of room ids joined by a door + corridor (always facing each other, centres aligned). */
    links: [string, string][];
}

export interface FloorPlan extends DungeonPlan
{
    seed: number;
    biomeId: BiomeId;
    floorIndex: number;
    floorCount: number;
    /** Room ids from start to exit / boss. */
    mainPath: string[];
}

export interface FloorOptions
{
    seed: number;
    biomeId: BiomeId;
    /** 1-based. */
    floorIndex: number;
    floorCount: number;
}

/** Corridor length (tiles of floor between two facing walls). Short: no long empty walks. */
export const CORRIDOR = 3;

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

/** Mixes the run seed with the floor so each floor of a run differs but replays identically. */
export const floorSeed = (seed: number, floorIndex: number) => ((seed >>> 0) ^ Math.imul(floorIndex + 1, 0x9e3779b1)) >>> 0;

/**
 * Combat rooms on the main path. Rooms are ~40-55 % larger per side than before, so floors have
 * fewer of them; the final floor is the shortest (the boss arena is the finale). 2-floor runs
 * get one more fight per floor so every run lands near the ~10 minute dungeon target.
 */
export function combatRoomCount (floorIndex: number, floorCount: number)
{
    const short = floorCount <= 2;
    if (floorIndex === floorCount) return short ? 2 : 1;
    return short ? 3 : 2;
}

interface Rect { x: number; y: number; w: number; h: number }
const overlaps = (a: Rect, b: Rect, margin = 1) =>
    a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;

/** Where a room of size w x h goes next to `from` in direction (dx, dy), plus its corridor. */
function placeBeside (from: Rect, w: number, h: number, dx: number, dy: number)
{
    const cx = from.x + (from.w - 1) / 2;
    const cy = from.y + (from.h - 1) / 2;
    let room: Rect;
    let corridor: Rect;
    if (dx !== 0)
    {
        const x = dx > 0 ? from.x + from.w + CORRIDOR : from.x - CORRIDOR - w;
        room = { x, y: cy - (h - 1) / 2, w, h };
        corridor = { x: dx > 0 ? from.x + from.w : x + w, y: cy - 2, w: CORRIDOR, h: 5 };
    }
    else
    {
        const y = dy > 0 ? from.y + from.h + CORRIDOR : from.y - CORRIDOR - h;
        room = { x: cx - (w - 1) / 2, y, w, h };
        corridor = { x: cx - 2, y: dy > 0 ? from.y + from.h : y + h, w: 5, h: CORRIDOR };
    }
    return { room, corridor };
}

export function planFloor ({ seed, biomeId, floorIndex, floorCount }: FloorOptions): FloorPlan
{
    const rand = seededRandom(floorSeed(seed, floorIndex));
    const biome = BIOMES[biomeId];
    const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
    const isFinal = floorIndex === floorCount;

    const roles: RoomRole[] = ['start', ...Array<RoomRole>(combatRoomCount(floorIndex, floorCount)).fill('combat'), isFinal ? 'boss' : 'exit'];
    // Different combat templates in a row: every room should feel different.
    const templates: RoomTemplateId[] = [];
    for (const role of roles)
    {
        const options = biome.rooms[role].filter((t) => t !== templates[templates.length - 1]);
        templates.push(pick(options.length ? options : biome.rooms[role]));
    }

    for (let attempt = 0; attempt < 200; attempt++)
    {
        const rooms: PlanRoom[] = [];
        const corridors: Rect[] = [];
        const links: [string, string][] = [];
        const add = (role: RoomRole, template: RoomTemplateId, rect: Rect) =>
        {
            const room: PlanRoom = { id: `r${rooms.length}`, role, template, ...rect };
            rooms.push(room);
            return room;
        };

        // 1. Main path as a random walk of real rectangles.
        const first = ROOM_SPECS[templates[0]];
        add(roles[0], templates[0], { x: 0, y: 0, w: first.w, h: first.h });
        let ok = true;
        for (let i = 1; i < roles.length && ok; i++)
        {
            const spec = ROOM_SPECS[templates[i]];
            const prev = rooms[i - 1];
            const dirs = [...DIRS].sort(() => rand() - 0.5);
            ok = false;
            for (const [dx, dy] of dirs)
            {
                const { room, corridor } = placeBeside(prev, spec.w, spec.h, dx, dy);
                // The corridor may touch only its own two rooms.
                const others = rooms.filter((r) => r !== prev);
                if (!rooms.every((o) => !overlaps(o, room)) || !others.every((o) => !overlaps(o, corridor, 0)) || !corridors.every((c) => !overlaps(c, room, 0) && !overlaps(c, corridor, 0))) continue;
                const added = add(roles[i], templates[i], room);
                corridors.push(corridor);
                links.push([prev.id, added.id]);
                ok = true;
                break;
            }
        }
        if (!ok) continue;
        const mainPath = rooms.map((r) => r.id);

        // 2. Branches off combat rooms: treasure (not on the boss floor of long runs), a rest
        //    shrine on later floors / sometimes. Skipped silently if there is no room for it.
        const branch = (role: RoomRole) =>
        {
            const template = pick(biome.rooms[role]);
            const spec = ROOM_SPECS[template];
            const hosts = rooms.filter((r) => r.role === 'combat');
            for (let tries = 0; tries < 24 && hosts.length; tries++)
            {
                const host = pick(hosts);
                const [dx, dy] = pick(DIRS);
                const { room, corridor } = placeBeside(host, spec.w, spec.h, dx, dy);
                const others = rooms.filter((r) => r !== host);
                if (!rooms.every((o) => !overlaps(o, room)) || !others.every((o) => !overlaps(o, corridor, 0)) || !corridors.every((c) => !overlaps(c, room, 0) && !overlaps(c, corridor, 0))) continue;
                const added = add(role, template, room);
                corridors.push(corridor);
                links.push([host.id, added.id]);
                return true;
            }
            return false;
        };
        if (!isFinal || floorCount <= 2 || rand() < 0.5) branch('treasure');
        if (floorIndex > 1 || rand() < 0.4) branch('shrine');

        // 3. Normalise to a 1-tile margin around the footprint.
        const minX = Math.min(...rooms.map((r) => r.x)) - 1;
        const minY = Math.min(...rooms.map((r) => r.y)) - 1;
        for (const r of rooms) { r.x -= minX; r.y -= minY; }
        return { seed, biomeId, floorIndex, floorCount, rooms, links, mainPath };
    }
    throw new Error(`Could not lay out floor ${floorIndex} for seed ${seed}`);
}
