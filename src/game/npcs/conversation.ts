// Shared in-game talk flow for every NPC: greeting -> Chat & Study | Mini-games | Goodbye.
//
// WHAT the NPC says comes from npcService (scripted lines).
// WHAT HAPPENS (quiz scoring, rewards, completion) is decided here and in the scene's
// game logic; the result is then reported to npcService as an event for the NPC's memory.

import type { NpcRecord } from '../data/npcStore';
import type { Challenge } from '../minigames/challenge';
import { MINIGAMES } from '../minigames';
import type { DialogueMoment } from '../services/contracts';
import { npcService } from '../services/npcService';
import { isChallengeClaimed } from '../state/playerState';

export interface ConversationIO
{
    say (lines: string[], choices?: string[], onDone?: (choice: number | null) => void): void;
    quiz (challenge: Challenge, rewardAvailable: boolean, onDone: (score: number | null) => void): void;
    /** Called when the player passes; the scene grants rewards / marks completion (authoritative). */
    passed (challenge: Challenge): void;
    /** Wraps service calls so the scene can hold the player still while lines load (AI may be slow). */
    wait<T> (work: Promise<T>): Promise<T>;
    /** Opens the AI tutor chat (absent when the tutoring backend is not configured). */
    chat?: () => void;
    /** Starts a FaceTime Tutor voice call (absent when the tutoring backend is not configured). */
    call?: () => void;
    /**
     * Opens the mini-game picker. `legacyChallenge` is this NPC's original quiz challenge
     * (older saves), offered there as an extra game, or null.
     */
    minigames (legacyChallenge: { label: string; play: () => void } | null): void;
}

export const CHOICES = { chat: 'Chat & Study', call: 'FaceTime Tutor', minigames: 'Mini-games', goodbye: 'Goodbye' } as const;

export async function runConversation (npc: NpcRecord, playerId: string, io: ConversationIO)
{
    const lines = async (moment: DialogueMoment, facts?: Record<string, number | boolean>) =>
    {
        const turn = await io.wait(npcService.dialogue({ playerId, npcId: npc.id, source: 'game', moment, facts }));
        return turn.lines.map((line) => line.text);
    };

    const entry = npc.minigameType ? MINIGAMES[npc.minigameType] : null;
    const challenge = entry?.challenge ?? null;

    const playChallenge = (c: Challenge) =>
    {
        npcService.recordEvent(playerId, npc.id, 'game', { type: 'challenge_offered', challengeId: c.id });
        io.quiz(c, !isChallengeClaimed(c.id), async (score) =>
        {
            if (score === null) return; // quit the quiz

            // Game logic decides the outcome and rewards...
            const total = c.questions.length;
            const passed = score >= c.passScore;
            if (passed) io.passed(c);
            // ...then the NPC is told what happened (memory + learning progress).
            npcService.recordEvent(playerId, npc.id, 'game', { type: 'challenge_result', challengeId: c.id, score, total, passed });
            io.say(await lines(passed ? 'passed' : 'failed', { score, total }));
        });
    };

    const choices = [...(io.chat ? [CHOICES.chat] : []), ...(io.call ? [CHOICES.call] : []), CHOICES.minigames, CHOICES.goodbye];
    const greeting = await lines(challenge && isChallengeClaimed(challenge.id) ? 'returning' : 'greeting');
    io.say(greeting, choices, (choice) =>
    {
        const picked = choice === null ? null : choices[choice];
        if (picked === CHOICES.chat) io.chat?.();
        else if (picked === CHOICES.call) io.call?.();
        else if (picked === CHOICES.minigames) io.minigames(challenge && entry ? { label: entry.label, play: () => playChallenge(challenge) } : null);
    });
}
