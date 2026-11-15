// Results screen text for the coursework mini-games (Answer Dash, Spellshot): the
// server-verified score, the study (Pomodoro) status, and the performance reward: XP (scaled by
// the player's level) + 1-5 crystals by accuracy (progression/balance.ts MINIGAME_TIERS). The
// reward is paid once per server session id and only for finished, server-graded sessions with
// meaningful participation, so replays, abandoned sessions and reloads cannot farm it.

import type { NpcRecord } from '../../data/npcStore';
import type { DashPack, DashResult } from '../../services/minigameApi';
import { formatClock, pomodoro } from '../../state/pomodoro';
import { MINIGAME_MIN_ANSWERED } from '../../progression/balance';
import { player } from '../../state/playerState';

export function describeDashResults (npc: NpcRecord, result: DashResult, game: DashPack['game'], sessionId: string)
{
    const pct = Math.round(result.accuracy * 100);
    const notes: string[] = [];
    if (result.weakTopics.length) notes.push(`Practice next: ${result.weakTopics.join(', ')}. ${npc.name} will remember this in Chat & Study.`);
    if (result.masteredTopics.length) notes.push(`Strong today: ${result.masteredTopics.join(', ')}.`);

    // Study time is wall-clock focus time: playing counts as studying but never skips it.
    pomodoro.tick();
    notes.push(pomodoro.state.phase === 'focus'
        ? `Study session: ${formatClock(pomodoro.remaining())} of focus time left before the tower opens.`
        : 'Focus time complete: the tower is open!');

    // Accuracy + answered count come from the server's grading of this session (never the client).
    const reward = player.awardMinigame(sessionId, result.accuracy, result.answered);
    if (reward.status === 'awarded')
    {
        const p = player.progress;
        notes.unshift(`Reward: +${reward.xp} XP and +${reward.crystals} crystal${reward.crystals === 1 ? '' : 's'}. Level ${p.level}: ${p.xp} / ${p.xpToNext} XP.`);
        if (reward.levelsGained) notes.unshift(`Level up! You reached level ${reward.level}: +${3 * reward.levelsGained} stat points (press I in the village).`);
        if (reward.crystalsLost) notes.push(`Your bag is full: ${reward.crystalsLost} crystal${reward.crystalsLost === 1 ? ' was' : 's were'} lost.`);
    }
    else if (reward.status === 'tooShort') notes.unshift(`Answer at least ${MINIGAME_MIN_ANSWERED} questions to earn XP and crystals.`);
    else if (reward.status === 'claimed') notes.unshift('Reward already collected for this session.');
    else if (reward.status === 'saveFailed') notes.unshift('Your reward could not be saved (browser storage full).');

    return {
        title: pct >= 80 ? 'Brilliant run!' : pct >= 50 ? 'Nice run!' : 'Good practice!',
        stats: [
            ['Score', String(result.score)],
            // Spellshot is timed: count what was answered, not the whole pack.
            ['Correct', `${result.correct} / ${game === 'spellshot' ? result.answered : result.total}`],
            ['Accuracy', `${pct}%`],
            ['Best streak', String(result.bestStreak)],
            ['Topics', Object.keys(result.topicPerformance).join(', ') || '-'],
        ] as [string, string][],
        notes,
    };
}
