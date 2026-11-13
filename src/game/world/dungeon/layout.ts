// The current (hand-made) dungeon floor: which templates go where and which rooms connect.
// A procedural generator only needs to output this same DungeonPlan shape.

import type { RoomTemplateId } from './rooms';

export interface DungeonPlan
{
    /** Rooms on a grid; gx / gy are grid cells (one cell = one room). */
    rooms: { id: string; template: RoomTemplateId; gx: number; gy: number }[];
    /** Pairs of room ids that get a door between them (must be grid neighbours). */
    links: [string, string][];
}

export const FLOOR_1: DungeonPlan = {
    rooms: [
        { id: 'entrance', template: 'entrance', gx: 0, gy: 0 },
        { id: 'pillars', template: 'pillars', gx: 1, gy: 0 },
        { id: 'hall', template: 'hall', gx: 1, gy: 1 },
        { id: 'treasure', template: 'treasure', gx: 2, gy: 1 },
    ],
    links: [
        ['entrance', 'pillars'],
        ['pillars', 'hall'],
        ['hall', 'treasure'],
    ],
};
