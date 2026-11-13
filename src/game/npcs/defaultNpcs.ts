// NPCs created on first launch (when nothing is saved yet). After that they live in the
// NPC store like any teacher-made NPC and can be edited, moved or deleted.

import { NPC_HOME_OFFSET } from '../buildings/buildingTypes';
import { TILE } from '../config';
import type { NpcInput, Placement } from '../data/npcStore';

/** Sir Sum-a-Lot's spot before NPCs had buildings (Task 2-3 saves). Used by the save migration. */
export const LEGACY_SIR_POSITION = { x: 30 * TILE + TILE / 2, y: 11 * TILE };

/** His training hall: east of the path below the village house (tile 33, 12). */
const SIR_HALL = { x: 33 * TILE, y: 12 * TILE };

export const SIR_PLACEMENT: Placement = {
    map: 'hub',
    x: SIR_HALL.x,
    y: SIR_HALL.y,
    npcX: SIR_HALL.x + NPC_HOME_OFFSET.x,
    npcY: SIR_HALL.y + NPC_HOME_OFFSET.y,
};

export const DEFAULT_NPCS: { npc: NpcInput; placement: Placement }[] = [{
    placement: SIR_PLACEMENT,
    npc: {
        id: 'sir-sum-a-lot',
        name: 'Sir Sum-a-Lot',
        subject: 'Mathematics',
        appearance: 'knight',
        minigameType: 'math',
        dialogue: [
            'Greetings, traveler! I am Sir Sum-a-Lot, defender of numbers and destroyer of GPAs.',
            'I have guarded this village from rogue fractions for forty-two years. Exactly forty-two. I counted.',
            "Think you've got enough braincells to survive my math challenge?",
        ],
        reactions: {
            declined: [
                'Retreating? Wise. Even I fear long division.',
                'Return when your brain has finished loading.',
            ],
            passed: [
                'Huzzah! Your arithmetic is sharper than my sword. Admittedly, my sword is decorative.',
            ],
            failed: [
                'Alas! The numbers have bested you this time.',
                'Fear not. I once believed 7 x 8 was 54. Dark times. Come back and try again!',
            ],
            completed: [
                'Ah, my favourite mathematician returns!',
                'You have already claimed my crystals, but a knight never refuses a rematch. Practice round?',
            ],
        },
    },
}];
