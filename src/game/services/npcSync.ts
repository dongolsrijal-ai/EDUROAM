// Account village sync. Signed in (email or guest), Supabase is the source of truth for NPCs:
// each npcs row carries the NPC's placement and building in game_state, so any browser that
// signs in rebuilds the same village. The local copy (npcStore, per-account key) is a cache.
//
// Load order for an account:
//   1. Supabase rows (owner-scoped) -> the village. Rows saved before placements were stored
//      take their spot from a local copy of the same NPC (stable game id) and are written back.
//   2. Only if the player EXPLICITLY chose "add this browser's saved game to my account"
//      (services/deviceSave.ts): NPCs made here while signed out are added once (never ones the
//      server has tombstoned; the server's deletion guard refuses them too; never the built-in
//      defaults every new device save starts with). Nothing is ever copied silently.
//   3. A brand-new account (no NPCs, nothing ever deleted) gets the default NPCs.
// Nothing here deletes server data; deletions only go through npc-lifecycle.

import { entryFromServer, LEGACY_KEY, MAX_NPCS, newEntry, npcStore, readSave, type MapId, type VillageEntry } from '../data/npcStore';
import { readText, writeJson } from '../data/storage';
import { DEFAULT_NPCS, SIR_PLACEMENT } from '../npcs/defaultNpcs';
import { loadNpcRoster, syncNpc, type NpcRoster } from './tutorApi';

/** The account the player explicitly gave this browser's signed-out save to (set by deviceSave.ts). */
export const LEGACY_CLAIM_KEY = 'eduroam.npcs.legacyClaimedBy';
/** Set once that account has actually received those NPCs (they move only once). */
export const LEGACY_IMPORTED_KEY = 'eduroam.npcs.legacyImportedBy';

const readOwner = (key: string) =>
{
    try { const v = JSON.parse(readText(key) ?? 'null'); return typeof v === 'string' ? v : null; }
    catch { return null; }
};

/** Where an NPC without any saved spot stands (beside the village path; "Move" gives them a building). */
const DEFAULT_SPOT: { map: MapId; x: number; y: number } = { map: 'hub', x: SIR_PLACEMENT.npcX - 96, y: SIR_PLACEMENT.npcY + 64 };

export interface VillageLoad
{
    roster: NpcRoster;
    /** NPCs brought over from this browser's signed-out save. */
    imported: number;
    /** Default NPCs given to a brand-new account. */
    seeded: number;
    /** Problems that did not stop the load (shown to the player). */
    warnings: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : 'Connection failed');

/** Loads this account's village from Supabase into the store. Edits stay blocked until it succeeds. */
export async function loadAccountVillage (ownerId: string): Promise<VillageLoad>
{
    npcStore.setSyncStatus(ownerId, { state: 'loading' });
    try
    {
        const roster = await loadNpcRoster();
        if (roster.ownerId !== ownerId) throw new Error('Your account changed while loading. Refresh the page.');
        const deleted = new Set(roster.deletions.map((d) => d.game_npc_id));
        const legacy = readSave(LEGACY_KEY) ?? [];
        const legacyById = new Map(legacy.map((e) => [e.npc.id, e]));

        const entries: VillageEntry[] = [];
        const backfill: string[] = [];
        for (const row of roster.npcs)
        {
            const fallback = npcStore.entry(row.game_npc_id) ?? legacyById.get(row.game_npc_id) ?? null;
            const entry = entryFromServer(row, fallback, DEFAULT_SPOT);
            if (!entry) continue;
            entries.push({ npc: entry.npc, building: entry.building });
            if (entry.needsState) backfill.push(entry.npc.id);
        }

        // Built-in NPCs are seeded into every new device save, so they are never "imported"
        // (that would re-add them to accounts that never had them on a new browser).
        const defaults = new Set(DEFAULT_NPCS.map((d) => d.npc.id));
        const granted = readOwner(LEGACY_CLAIM_KEY) === ownerId && readOwner(LEGACY_IMPORTED_KEY) !== ownerId;
        const fresh: VillageEntry[] = !granted ? [] : legacy.filter((e) => !defaults.has(e.npc.id) && !deleted.has(e.npc.id) && !entries.some((x) => x.npc.id === e.npc.id));
        let imported = fresh.length;
        let seeded = 0;
        if (!roster.npcs.length && !roster.deletions.length)
        {
            // A brand-new account gets the default NPCs (with this browser's progress only if the player chose to add it).
            const seeds = DEFAULT_NPCS.map((d) => (granted && legacyById.get(d.npc.id ?? '')) || newEntry(d.npc, d.placement)).filter((e): e is VillageEntry => Boolean(e));
            fresh.unshift(...seeds);
            seeded = seeds.length;
        }
        const warnings: string[] = [];
        if (entries.length + fresh.length > MAX_NPCS)
        {
            const skipped = fresh.splice(Math.max(0, MAX_NPCS - entries.length));
            imported = Math.max(0, imported - skipped.length);
            warnings.push(`${skipped.length} NPC(s) from this browser were not added: your account already has ${entries.length} of ${MAX_NPCS}.`);
        }

        if (!npcStore.replaceFromServer(ownerId, [...entries, ...fresh])) throw new Error('Your account changed while loading.');
        if (granted) writeJson(LEGACY_IMPORTED_KEY, ownerId);

        // Write back what the server is missing. One at a time: each is a normal owner-scoped
        // upsert keyed by the stable game id (limits and the deletion guard still apply).
        for (const entry of fresh)
        {
            try { await syncNpc(entry.npc); }
            catch (err)
            {
                if (npcStore.activeAccount() !== ownerId) break;
                npcStore.restore(entry.npc.id, null);
                if (defaults.has(entry.npc.id)) seeded--;
                else imported--;
                warnings.push(`${entry.npc.name} could not be saved to your account: ${message(err)}`);
            }
        }
        for (const id of backfill)
        {
            const record = npcStore.get(id);
            if (record && npcStore.activeAccount() === ownerId) await syncNpc(record).catch((err) => warnings.push(`${record.name}'s spot could not be saved: ${message(err)}`));
        }
        return { roster, imported, seeded, warnings };
    }
    catch (err)
    {
        npcStore.setSyncStatus(ownerId, { state: 'error', message: `Could not load your NPCs: ${message(err)}` });
        throw err;
    }
}

/**
 * Saves one NPC's current state to the signed-in account (no-op when signed out: the
 * device save is already up to date). Throws so the caller can undo and explain.
 */
export async function saveNpc (id: string): Promise<void>
{
    if (!npcStore.activeAccount()) return;
    const record = npcStore.get(id);
    if (record) await syncNpc(record);
}
