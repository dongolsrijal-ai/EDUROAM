// Reusable dungeon ROOM TEMPLATES. Every template is exactly ROOM_W x ROOM_H characters.
// Doors are NOT drawn here: build.ts carves them in the middle of whichever walls connect
// to a neighbouring room, so any template can sit anywhere in a layout (or in a generator later).
//
// Legend
//   #  wall               .  floor
//   T  wall with a torch  P  pillar (solid)
//   C  loot chest         F  final treasure chest (needs the guardian defeated)
//   G  guardian / boss    X  exit portal (appears when the floor is complete)
//   S  entrance stairs (sealed during a run)                @  player spawn
//   M  monster spawn slot (future)   N  NPC encounter slot (future)

export const ROOM_W = 15;
export const ROOM_H = 11;

export const ROOM_TEMPLATES = {
    entrance: [
        '###T#######T###',
        '#.............#',
        '#.S...........#',
        '#.............#',
        '#.............#',
        '#.....@.......#',
        '#.............#',
        '#.............#',
        '#.............#',
        '#.............#',
        '###############',
    ],
    pillars: [
        '###T#######T###',
        '#...........C.#',
        '#..P.......P..#',
        '#.............#',
        '#.............#',
        '#......M......#',
        '#.............#',
        '#.............#',
        '#..P.......P..#',
        '#.............#',
        '###############',
    ],
    hall: [
        '###T#######T###',
        '#.............#',
        '#.............#',
        '#...P.....P...#',
        '#.............#',
        '#......N......#',
        '#.............#',
        '#...P.....P...#',
        '#.............#',
        '#.............#',
        '###############',
    ],
    treasure: [
        '###T#######T###',
        '#.............#',
        '#......F......#',
        '#.............#',
        '#.............#',
        '#......G......#',
        '#.............#',
        '#.............#',
        '#..........X..#',
        '#.............#',
        '###############',
    ],
} satisfies Record<string, string[]>;

export type RoomTemplateId = keyof typeof ROOM_TEMPLATES;
