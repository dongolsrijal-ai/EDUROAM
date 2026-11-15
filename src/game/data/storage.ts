// Low-level LOCAL persistence (browser localStorage). Data modules (npcStore,
// conversationStore, playerIdentity) go through here instead of touching localStorage.
//
// Moving to Supabase replaces the *repository* layer (the stores' load/save functions,
// via services/npcService.ts), not the game code that calls those stores.

// ------------------------------------------------------------------ per-account saves

/**
 * Progress saves that belong to ONE account (crystals, inventory, tower, dungeon run, local chat
 * history). The app sets the signed-in account BEFORE the game modules load (game/app.ts), so each
 * store's key resolves to that account's own copy and accounts never share progress on a browser.
 * Without an account (tests, tools) the original device keys are used, unchanged.
 */
export const ACCOUNT_SCOPED_KEYS = ['eduroam.player', 'eduroam.dungeon', 'eduroam.tower', 'eduroam.conversations'] as const;

let accountScope: string | null = null;

export function setAccountScope (ownerId: string | null)
{
    accountScope = ownerId;
}

export const getAccountScope = () => accountScope;

/** The key a progress store uses for the current account. */
export function scopedKey (base: string, ownerId: string | null = accountScope): string
{
    return ownerId ? `${base}.account.${ownerId}` : base;
}

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
