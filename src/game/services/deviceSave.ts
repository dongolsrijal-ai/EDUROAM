// A game saved in this browser BEFORE signing in (no account) is never copied into an account
// silently. After sign-in the login gate asks once: "Add this browser's saved game to <account>?"
//
//   adopt   -> copies the browser's progress (crystals, inventory, tower, dungeon run, chat history)
//              into this account's own keys where the account has none yet, and lets npcSync add
//              the NPCs made here (minus anything the server tombstoned). The originals are kept.
//   decline -> nothing is copied; this account is not asked again. The browser save stays as is.
// Only one account can adopt a browser save (it is not duplicated into several accounts).

import { DEFAULT_NPCS } from '../npcs/defaultNpcs';
import { LEGACY_KEY, readSave } from '../data/npcStore';
import { ACCOUNT_SCOPED_KEYS, readText, scopedKey } from '../data/storage';
import { LEGACY_CLAIM_KEY } from './npcSync';

const declinedKey = (ownerId: string) => `eduroam.deviceSave.declined.${ownerId}`;
const defaults = new Set(DEFAULT_NPCS.map((d) => d.npc.id));

export interface DeviceSave
{
    /** Teacher-made NPCs saved in this browser without an account. */
    npcs: string[];
    /** Whether game progress (crystals, inventory, tower, ...) is saved without an account. */
    progress: boolean;
}

function owner (key: string): string | null
{
    try { const v = JSON.parse(readText(key) ?? 'null'); return typeof v === 'string' ? v : null; }
    catch { return null; }
}

/** What this browser has saved without an account (null = nothing worth offering). */
export function deviceSave (): DeviceSave | null
{
    const npcs = (readSave(LEGACY_KEY) ?? []).filter((e) => !defaults.has(e.npc.id)).map((e) => e.npc.name);
    const progress = ACCOUNT_SCOPED_KEYS.some((key) => Boolean(readText(key)));
    return npcs.length || progress ? { npcs, progress } : null;
}

/** Ask this account? Only if there is a browser save nobody adopted yet and this account did not say no. */
export function shouldOfferDeviceSave (ownerId: string): DeviceSave | null
{
    if (owner(LEGACY_CLAIM_KEY)) return null;
    try { if (localStorage.getItem(declinedKey(ownerId))) return null; }
    catch { return null; }
    return deviceSave();
}

/** The player chose to add the browser save to this account. Never overwrites the account's own saves. */
export function adoptDeviceSave (ownerId: string)
{
    for (const base of ACCOUNT_SCOPED_KEYS)
    {
        const text = readText(base);
        if (!text || readText(scopedKey(base, ownerId))) continue;
        try { localStorage.setItem(scopedKey(base, ownerId), text); }
        catch (err) { console.warn(`[deviceSave] could not copy ${base}`, err); }
    }
    try { localStorage.setItem(LEGACY_CLAIM_KEY, JSON.stringify(ownerId)); }
    catch { /* storage blocked: nothing was adopted */ }
}

export function declineDeviceSave (ownerId: string)
{
    try { localStorage.setItem(declinedKey(ownerId), '1'); }
    catch { /* asked again next time */ }
}
