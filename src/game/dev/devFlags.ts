// Development-only switches. `DEV` is false in production builds (Vite), so every dev feature
// guarded by it disappears from `npm run build` output. Flags persist in localStorage so a page
// refresh keeps them while testing.

export const DEV = import.meta.env.DEV;

const KEY = 'eduroam.dev';

type Flags = {
    /** Draw movement bodies, hurtboxes and attack hitboxes. */
    hitboxes: boolean;
    /** Focus (study) length override in seconds, 0 = use the normal 25 minutes. */
    focusSeconds: number;
    /** Dungeon break length override in seconds, 0 = normal 10 minutes. */
    dungeonSeconds: number;
};

const DEFAULTS: Flags = { hitboxes: false, focusSeconds: 0, dungeonSeconds: 0 };

function read (): Flags
{
    if (!DEV) return DEFAULTS;
    try
    {
        const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
        const seconds = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
        return { hitboxes: raw?.hitboxes === true, focusSeconds: seconds(raw?.focusSeconds), dungeonSeconds: seconds(raw?.dungeonSeconds) };
    }
    catch { return DEFAULTS; }
}

export const devFlags = {
    get<K extends keyof Flags> (key: K): Flags[K]
    {
        return read()[key];
    },
    set<K extends keyof Flags> (key: K, value: Flags[K])
    {
        if (!DEV) return;
        try { localStorage.setItem(KEY, JSON.stringify({ ...read(), [key]: value })); }
        catch { /* ignore */ }
    },
};
