// DUNGEON BIOMES as data (no Phaser). Add a biome by adding an entry here plus its textures in
// art/dungeonBiomes.ts. Each run picks one at random, never the same as the last run when another
// biome exists.

import type { EnemyTypeId } from '../../combat/enemyTypes';
import type { RoomRole, RoomTemplateId } from './rooms';

export type BiomeId = 'crypt' | 'ruins';

export interface BiomeDef
{
    id: BiomeId;
    name: string;
    /** Tileset texture key (DUNGEON tile order, see tiles.ts). */
    tileset: string;
    /** Camera background + overlay tint (CSS colour, hex). */
    colors: { background: string; vignette: string };
    /** Texture keys for template props. */
    props: { pillar: string; obstacle: string; decor: string[]; gate: string; arena: string };
    /** Templates each room role may use. */
    rooms: Record<RoomRole, RoomTemplateId[]>;
    /** Relative spawn weights for rollable enemies (missing = never in this biome). */
    enemyWeights: Partial<Record<EnemyTypeId, number>>;
    /** Optional environmental hazards (none yet; kept so future biomes can add them). */
    hazards: { kind: string; chance: number }[];
}

export const BIOMES: Record<BiomeId, BiomeDef> = {
    crypt: {
        id: 'crypt',
        name: 'Haunted Crypt',
        tileset: 'dungeon-crypt',
        colors: { background: '#0f0c15', vignette: 'rgba(20, 8, 40, 0.8)' },
        props: { pillar: 'crypt-pillar', obstacle: 'tombstone', decor: ['bones', 'candles'], gate: 'gate-crypt', arena: 'arena-crypt' },
        rooms: {
            start: ['start'],
            // Crypt: columns, grave rows, reaper (summoner) halls.
            combat: ['combatPillars', 'combatTombs', 'summonerArena', 'combatLarge', 'rangedArena'],
            treasure: ['treasure'],
            shrine: ['shrine'],
            exit: ['exit'],
            boss: ['boss'],
        },
        enemyWeights: { zombie: 5, goblin: 2, wizard: 3, giant: 2, reaper: 3 },
        hazards: [],
    },
    ruins: {
        id: 'ruins',
        name: 'Overgrown Ruins',
        tileset: 'dungeon-ruins',
        colors: { background: '#0c140f', vignette: 'rgba(8, 26, 14, 0.78)' },
        props: { pillar: 'broken-column', obstacle: 'mossy-block', decor: ['vines', 'ferns'], gate: 'gate-ruins', arena: 'arena-ruins' },
        rooms: {
            start: ['start'],
            // Ruins: overgrown courtyards, broken colonnades, open ranged plazas.
            combat: ['combatGarden', 'combatBroken', 'rangedArena', 'combatLarge'],
            treasure: ['treasure'],
            shrine: ['shrine'],
            exit: ['exit'],
            boss: ['boss'],
        },
        enemyWeights: { zombie: 2, goblin: 5, wizard: 3, giant: 3, reaper: 2 },
        hazards: [],
    },
};

export const BIOME_IDS = Object.keys(BIOMES) as BiomeId[];

export const isBiomeId = (value: unknown): value is BiomeId =>
    typeof value === 'string' && (BIOME_IDS as string[]).includes(value);

/** Random biome, avoiding `last` when another biome exists. */
export function pickBiome (random: () => number, last: string | null): BiomeId
{
    const pool = BIOME_IDS.filter((id) => id !== last);
    const choices = pool.length ? pool : BIOME_IDS;
    return choices[Math.floor(random() * choices.length)];
}
