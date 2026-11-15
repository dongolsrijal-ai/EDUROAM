// POMODORO STUDY LOOP: 25 min focus -> tower opens -> ~10 min dungeon run -> rewards -> repeat.
//
//   focus    studying; the dungeon entrance stays closed until the focus time has passed
//   ready    focus finished; the tower is open (waits as long as needed)
//   dungeon  a run is in progress; 10 minutes is a PACING TARGET only (the HUD shows overtime,
//            nothing ever forces a defeat). Leaving through the final portal starts the next focus.
//
// Phases are anchored to wall-clock timestamps, so a refresh (or closing the tab) never resets the
// timer. Saved in localStorage "eduroam.pomodoro". Every function takes `now` for tests.

import { backupText, readText, writeJson } from '../data/storage';
import { devFlags } from '../dev/devFlags';

const STORAGE_KEY = 'eduroam.pomodoro';
const SCHEMA_VERSION = 1;

export const FOCUS_MS = 25 * 60_000;
export const DUNGEON_MS = 10 * 60_000;

export type PomodoroPhase = 'focus' | 'ready' | 'dungeon';

export interface PomodoroState
{
    phase: PomodoroPhase;
    /** Current session number (1-based): one focus block + one dungeon run. */
    session: number;
    /** When the current phase began (ms since epoch). */
    phaseStartedAt: number;
    completedSessions: number;
    /** Dungeon clock frozen since this time (death screen open); undefined = running. */
    heldAt?: number;
}

type Listener = (s: Readonly<PomodoroState>) => void;
const listeners = new Set<Listener>();
let state: PomodoroState = load(Date.now());

/** Focus length, or the dev override (dev builds only). */
export function focusMs ()
{
    const seconds = devFlags.get('focusSeconds');
    return seconds > 0 ? seconds * 1000 : FOCUS_MS;
}

export function dungeonMs ()
{
    const seconds = devFlags.get('dungeonSeconds');
    return seconds > 0 ? seconds * 1000 : DUNGEON_MS;
}

/** "mm:ss" (minutes may exceed 59). Negative values are shown as their absolute value. */
export function formatClock (ms: number)
{
    const total = Math.ceil(Math.abs(ms) / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export const pomodoro = {
    get state (): Readonly<PomodoroState>
    {
        return state;
    },

    /**
     * Time left in the current phase: focus -> until the tower opens; dungeon -> until the pacing
     * target (negative = overtime); ready -> 0.
     */
    remaining (now = Date.now())
    {
        const elapsed = Math.max(0, (state.heldAt ?? now) - state.phaseStartedAt);
        if (state.phase === 'focus') return Math.max(0, focusMs() - elapsed);
        if (state.phase === 'dungeon') return dungeonMs() - elapsed;
        return 0;
    },

    /** Moves focus -> ready once the focus time has passed. Returns true if the phase changed. */
    tick (now = Date.now())
    {
        if (state.phase !== 'focus' || pomodoro.remaining(now) > 0) return false;
        state = { ...state, phase: 'ready', phaseStartedAt: state.phaseStartedAt + focusMs() };
        commit();
        return true;
    },

    /** The dungeon entrance may be used (focus finished, or a run is already going). */
    canEnterDungeon (now = Date.now())
    {
        pomodoro.tick(now);
        return state.phase !== 'focus';
    },

    /** A run starts: the dungeon pacing clock begins. False while still in focus time. */
    enterDungeon (now = Date.now())
    {
        if (!pomodoro.canEnterDungeon(now)) return false;
        if (state.phase === 'ready')
        {
            state = { ...state, phase: 'dungeon', phaseStartedAt: now };
            commit();
        }
        return true;
    },

    /** Freezes the dungeon clock while the death screen is up (idempotent). */
    hold (now = Date.now())
    {
        if (state.phase !== 'dungeon' || state.heldAt !== undefined) return;
        state = { ...state, heldAt: now };
        commit();
    },

    /** Resumes a frozen dungeon clock; the frozen time does not count. */
    release (now = Date.now())
    {
        if (state.heldAt === undefined) return;
        const { heldAt, ...rest } = state;
        state = { ...rest, phaseStartedAt: rest.phaseStartedAt + Math.max(0, now - heldAt) };
        commit();
    },

    /** The run is over (final portal): session complete, the next focus block starts now. */
    finishDungeon (now = Date.now())
    {
        if (state.phase !== 'dungeon') return false;
        state = { phase: 'focus', session: state.session + 1, phaseStartedAt: now, completedSessions: state.completedSessions + 1 };
        commit();
        return true;
    },

    /**
     * Boot reconciliation with the saved dungeon run: a run in progress means the dungeon phase
     * (e.g. a save from before the timer existed); a dungeon phase without a run means the run
     * ended while the page was closing, so the session is finished.
     */
    syncWithRun (runActive: boolean, now = Date.now())
    {
        if (runActive && state.phase !== 'dungeon')
        {
            state = { ...state, phase: 'dungeon', phaseStartedAt: now };
            commit();
        }
        else if (!runActive && state.phase === 'dungeon')
        {
            pomodoro.finishDungeon(now);
        }
    },

    // ---- dev tools

    /** Ends the current focus block immediately. */
    skipFocus (now = Date.now())
    {
        if (state.phase !== 'focus') return;
        state = { ...state, phase: 'ready', phaseStartedAt: now };
        commit();
    },

    /** Restarts the focus block from now (e.g. after changing the dev focus length). */
    restartFocus (now = Date.now())
    {
        state = { ...state, phase: 'focus', phaseStartedAt: now };
        commit();
    },

    subscribe (fn: Listener)
    {
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    },
};

function commit ()
{
    writeJson(STORAGE_KEY, { version: SCHEMA_VERSION, ...state });
    listeners.forEach((fn) => fn(state));
}

function load (now: number): PomodoroState
{
    const fresh: PomodoroState = { phase: 'focus', session: 1, phaseStartedAt: now, completedSessions: 0 };
    const text = readText(STORAGE_KEY);
    if (!text) return fresh;
    try
    {
        const r = JSON.parse(text);
        if (r?.version !== SCHEMA_VERSION) throw new Error(`Unsupported version ${r?.version}`);
        const phase: PomodoroPhase = ['focus', 'ready', 'dungeon'].includes(r.phase) ? r.phase : 'focus';
        const int = (v: unknown, min: number, fallback: number) => (Number.isInteger(v) && (v as number) >= min ? v as number : fallback);
        return {
            phase,
            session: int(r.session, 1, 1),
            // A start time in the future (clock changed) counts from now.
            phaseStartedAt: typeof r.phaseStartedAt === 'number' && Number.isFinite(r.phaseStartedAt) ? Math.min(now, r.phaseStartedAt) : now,
            completedSessions: int(r.completedSessions, 0, 0),
            // A frozen dungeon clock (death screen) survives a refresh.
            ...(phase === 'dungeon' && typeof r.heldAt === 'number' && Number.isFinite(r.heldAt) ? { heldAt: Math.min(now, r.heldAt) } : {}),
        };
    }
    catch (err)
    {
        console.warn(`[pomodoro] Saved timer could not be read; kept a copy in "${STORAGE_KEY}.backup".`, err);
        backupText(STORAGE_KEY, 'backup', text);
        return fresh;
    }
}
