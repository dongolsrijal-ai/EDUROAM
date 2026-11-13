// Shape of a multiple-choice challenge. Any NPC can offer one (see npcs/).

import type { ItemId } from '../items/itemDefs';

export interface Question
{
    prompt: string;
    /** Exactly four answer options. */
    options: [string, string, string, string];
    /** Index (0-3) of the correct option. */
    answer: number;
    /** Shown after the player answers. */
    explanation: string;
}

export interface Challenge
{
    /** Unique id, used to remember that the reward was claimed. */
    id: string;
    title: string;
    questions: Question[];
    /** Correct answers needed to pass. */
    passScore: number;
    reward: { item: ItemId; amount: number; label: string };
}
