// Pure Answer Dash rules (unit-tested). Points mirror the server's grading so the live score
// matches the saved one; the server result is still the one that is saved and shown last.

export const LANES = 4;
export const POINTS = { correct: 100, streakBonus: 25, maxBonusSteps: 4 };

/** One lane left/right, never leaving the track. */
export function moveLane (lane: number, step: number): number
{
    return Math.max(0, Math.min(LANES - 1, lane + step));
}

/** Lane movement for a key (KeyboardEvent.key, lower case): step, direct lane, or null. */
export function laneKey (key: string): { step: -1 | 1 } | { lane: number } | null
{
    if (key === 'a' || key === 'arrowleft') return { step: -1 };
    if (key === 'd' || key === 'arrowright') return { step: 1 };
    const n = Number(key);
    if (Number.isInteger(n) && n >= 1 && n <= LANES) return { lane: n - 1 };
    return null;
}

/** Points for a correct answer given the streak BEFORE it. */
export function pointsFor (streakBefore: number): number
{
    return POINTS.correct + POINTS.streakBonus * Math.min(streakBefore, POINTS.maxBonusSteps);
}

/** Which lane a world x falls in (track starts at `left`), or null outside the track. */
export function laneAt (x: number, left: number, laneWidth: number): number | null
{
    const lane = Math.floor((x - left) / laneWidth);
    return lane >= 0 && lane < LANES ? lane : null;
}
