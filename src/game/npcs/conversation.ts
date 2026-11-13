// Shared in-game talk flow for every NPC: greeting -> (optional) challenge -> reaction.
//
// WHAT the NPC says comes from npcService (scripted today, Gemini later).
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
}

export async function runConversation (npc: NpcRecord, playerId: string, io: ConversationIO)
{
    const lines = async (moment: DialogueMoment, facts?: Record<string, number | boolean>) =>
    {
        const turn = await io.wait(npcService.dialogue({ playerId, npcId: npc.id, source: 'game', moment, facts }));
        return turn.lines.map((line) => line.text);
    };

    const challenge = npc.minigameType ? MINIGAMES[npc.minigameType].challenge : null;
    if (!challenge) return io.say(await lines('greeting'));

    const claimed = isChallengeClaimed(challenge.id);
    io.say(
        await lines(claimed ? 'returning' : 'greeting'),
        [claimed ? 'Practice Again' : 'Accept Challenge', 'Maybe Later'],
        async (choice) =>
        {
            if (choice === 1)
            {
                npcService.recordEvent(playerId, npc.id, 'game', { type: 'challenge_declined', challengeId: challenge.id });
                return io.say(await lines('declined'));
            }
            if (choice !== 0) return; // closed with Escape

            npcService.recordEvent(playerId, npc.id, 'game', { type: 'challenge_offered', challengeId: challenge.id });
            io.quiz(challenge, !isChallengeClaimed(challenge.id), async (score) =>
            {
                if (score === null) return; // quit the quiz

                // Game logic decides the outcome and rewards...
                const total = challenge.questions.length;
                const passed = score >= challenge.passScore;
                if (passed) io.passed(challenge);
                // ...then the NPC is told what happened (memory + learning progress).
                npcService.recordEvent(playerId, npc.id, 'game', { type: 'challenge_result', challengeId: challenge.id, score, total, passed });
                io.say(await lines(passed ? 'passed' : 'failed', { score, total }));
            });
        },
    );
}
