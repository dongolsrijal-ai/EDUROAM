// Registry of mini-games an NPC can offer (NpcRecord.minigameType).
// Add a new one by creating a Challenge file and listing it here.

import type { Challenge } from './challenge';
import { MATH_CHALLENGE } from './mathChallenge';

export const MINIGAMES = {
    math: { label: 'Math challenge (3 questions)', challenge: MATH_CHALLENGE },
} satisfies Record<string, { label: string; challenge: Challenge }>;

export type MinigameId = keyof typeof MINIGAMES;

export const isMinigameId = (value: unknown): value is MinigameId =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(MINIGAMES, value);
