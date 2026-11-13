// Low-level LOCAL persistence (browser localStorage). Data modules (npcStore,
// conversationStore, playerIdentity) go through here instead of touching localStorage.
//
// Moving to Supabase replaces the *repository* layer (the stores' load/save functions,
// via services/npcService.ts), not the game code that calls those stores.

/** Raw saved text; null = nothing saved; undefined = storage unavailable (privacy mode). */
export function readText (key: string): string | null | undefined
{
    try
    {
        return localStorage.getItem(key);
    }
    catch
    {
        return undefined;
    }
}

/** Saves a JSON document. Returns false if storage is full / blocked. */
export function writeJson (key: string, value: unknown): boolean
{
    try
    {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    }
    catch (err)
    {
        console.error(`[storage] Could not save "${key}".`, err);
        return false;
    }
}

/** Keeps a copy of unreadable / pre-migration data instead of losing it. */
export function backupText (key: string, suffix: string, text: string)
{
    try { localStorage.setItem(`${key}.${suffix}`, text); }
    catch { /* best effort */ }
}
