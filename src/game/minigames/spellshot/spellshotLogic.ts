// Pure Spellshot rules (unit-tested). Points mirror the server's grading (questionPack GAMES
// .spellshot.points) so the live score matches the saved one; the server result is still the
// one that is saved and shown last.

import type { SpellshotSpeed } from '../../services/minigameApi';

export const ROUND_MS = 60_000;
export const POINTS = { correct: 100, streakBonus: 20, maxBonusSteps: 5, wrongPenalty: 40 };

/** Base drift speed of the wisps, in world pixels per second. */
export const BASE_SPEED: Record<SpellshotSpeed, number> = { gentle: 14, brisk: 22, swift: 32 };

/** Target marks: number + shape, so answers never rely on colour alone. */
export const TARGET_MARKS = ['1 ◆', '2 ●', '3 ▲', '4 ★', '5 ✿'];

/** Points for a correct shot given the streak BEFORE it. */
export function pointsFor (streakBefore: number): number
{
    return POINTS.correct + POINTS.streakBonus * Math.min(streakBefore, POINTS.maxBonusSteps);
}

/** Score after a wrong shot (never below zero, as on the server). */
export function afterMiss (score: number): number
{
    return Math.max(0, score - POINTS.wrongPenalty);
}

/**
 * Wisp speed right now: rises with the streak (up to +36%) and as the round runs on (up to
 * +50% at the buzzer), so a good run keeps getting harder.
 */
export function speedFor (speed: SpellshotSpeed, streak: number, elapsedMs: number): number
{
    const streakBoost = 1 + 0.06 * Math.min(streak, 6);
    const timeBoost = 1 + 0.5 * Math.min(1, Math.max(0, elapsedMs / ROUND_MS));
    return BASE_SPEED[speed] * streakBoost * timeBoost;
}

/** Centre y of each horizontal flight band between `top` and `bottom` (one wisp per band). */
export function bandCenters (top: number, bottom: number, count: number): number[]
{
    const height = Math.max(0, bottom - top) / count;
    return Array.from({ length: count }, (_, i) => top + height * (i + 0.5));
}

/** Wrapped horizontal position: leaving one side re-enters from the other (margin = half width). */
export function wrapX (x: number, viewWidth: number, margin: number): number
{
    const span = viewWidth + margin * 2;
    return ((((x + margin) % span) + span) % span) - margin;
}

/** Which target a key fires at (KeyboardEvent.key, lower case), or null. */
export function targetKey (key: string, count: number): number | null
{
    const n = Number(key);
    return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : null;
}

/** "0:42" for the round clock. */
export function clock (ms: number): string
{
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
