// Data-driven NPCs and their buildings. Every NPC (built-in or teacher-made) is an
// NpcRecord here; each building is a BuildingRecord pointing at its NPC (npcId).
//
// Persistence: localStorage { version: 2, npcs: NpcRecord[], buildings: BuildingRecord[] }.
// SIGNED OUT the village is this device's own save (LEGACY_KEY). SIGNED IN (email or guest)
// Supabase is the source of truth: services/npcSync.ts loads the account's NPCs (with their
// placement in npcs.game_state) and the copy kept here under accountKey(ownerId) is only a
// per-account cache. Until that first load finishes the store refuses changes (editable()).
// Flat JSON with stable string ids + ISO timestamps maps 1:1 onto future Supabase tables
// (npcs, buildings with npc_id foreign key). Version 1 saves are migrated on load and the
// original text is kept in "eduroam.npcs.v1-backup".
//
// LIMITS are enforced here (not just in the UI): MAX_NPCS NPCs and MAX_CLASSES distinct subjects.
//
// NPC IDENTITY: `id` is created once ("npc_<uuid>", or a fixed id for built-in NPCs) and
// never changes on rename, appearance change, move or reload. It is the key shared with the
// backend, Supabase and Chert (see services/contracts.ts). NPC config lives here only;
// npcs/Npc.ts renders it and services/npcService.ts exposes it to dialogue / AI.

import { BUILDING_FOR_APPEARANCE, isBuildingType, type BuildingType } from '../buildings/buildingTypes';
import { isAppearanceId, type AppearanceId } from '../npcs/appearances';
import { isMinigameId, type MinigameId } from '../minigames';
import { DEFAULT_NPCS, LEGACY_SIR_POSITION, SIR_PLACEMENT } from '../npcs/defaultNpcs';
import { backupText, readText, writeJson } from './storage';

export type MapId = 'hub' | 'dungeon';
const MAP_IDS: MapId[] = ['hub', 'dungeon'];

export const MAX_NPCS = 10;
export const MAX_CLASSES = 10;

/** Optional custom lines for the challenge flow (defaults live in npcs/conversation.ts). */
export interface NpcReactions
{
    declined?: string[];
    passed?: string[];
    failed?: string[];
    completed?: string[];
}

export interface NpcRecord
{
    id: string;
    name: string;
    /** School subject / class. Independent of appearance. */
    subject: string;
    appearance: AppearanceId;
    /** Which map the NPC lives on, and its HOME spot there (feet, world pixels). It roams around it. */
    map: MapId;
    x: number;
    y: number;
    /** Greeting lines. Empty = a default greeting built from name + subject. */
    dialogue: string[];
    reactions?: NpcReactions;
    /** Mini-game offered after the greeting, or null for chat only. */
    minigameType: MinigameId | null;
    /** AI tutor persona and teacher instructions (optional; synced to the tutoring backend). */
    personality?: string;
    teachingInstructions?: string;
    /** True once the player has passed this NPC's challenge. */
    completed: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface BuildingRecord
{
    id: string;
    npcId: string;
    type: BuildingType;
    map: MapId;
    /** Top-left corner in world pixels. */
    x: number;
    y: number;
    createdAt: string;
    updatedAt: string;
}

/** Where a new / moved NPC and their building go (building top-left + NPC home spot). */
export interface Placement
{
    map: MapId;
    x: number;
    y: number;
    npcX: number;
    npcY: number;
}

export type NpcInput = Omit<NpcRecord, 'id' | 'map' | 'x' | 'y' | 'completed' | 'createdAt' | 'updatedAt'> & { id?: string };
export type NpcPatch = Partial<Omit<NpcRecord, 'id' | 'map' | 'x' | 'y' | 'createdAt' | 'updatedAt'>>;
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Input limits (also used by the editor form). */
export const LIMITS = { name: 32, subject: 32, line: 200, lines: 8, personality: 300, instructions: 600 };

/** This device's own village (signed out), and every save made before accounts existed. */
export const LEGACY_KEY = 'eduroam.npcs';
const accountKey = (ownerId: string) => `eduroam.npcs.account.${ownerId}`;
const SCHEMA_VERSION = 2;
const GAME_STATE_VERSION = 1;

/** local = signed out (device save); loading / error = account village not loaded yet; ready = loaded from Supabase. */
export type SyncStatus = { state: 'local' | 'loading' | 'ready' } | { state: 'error'; message: string };
export interface VillageEntry { npc: NpcRecord; building: BuildingRecord | null }

/** Game-side NPC state stored in npcs.game_state (see the 20261116000000 migration). */
export interface NpcGameState
{
    v: number;
    map: MapId;
    x: number;
    y: number;
    dialogue: string[];
    reactions: NpcReactions;
    minigameType: MinigameId | null;
    completed: boolean;
    building: { id: string; type: BuildingType; map: MapId; x: number; y: number } | null;
}

/** The columns of a server npcs row that the village is rebuilt from. */
export interface ServerNpcRow
{
    game_npc_id: string;
    name: string;
    subject: string;
    appearance: string;
    personality?: string | null;
    teaching_instructions?: string | null;
    created_at?: string;
    updated_at?: string;
    game_state?: unknown;
}

const NOT_READY = 'Your NPCs are still loading from your account. Try again in a moment.';

type Listener = (status: { saved: boolean }) => void;
const listeners = new Set<Listener>();
let npcs: NpcRecord[] = [];
let buildings: BuildingRecord[] = [];
let activeAccount: string | null = null;
let storageKey = LEGACY_KEY;
let sync: SyncStatus = { state: 'local' };
let remoteDeleted = new Set<string>();
const deletionKey = (ownerId: string) => `eduroam.npc-deletions.${ownerId}`;
const visible = (npc: NpcRecord) => !remoteDeleted.has(npc.id);

const classKey = (subject: string) => subject.trim().toLowerCase();

export const npcStore = {
    all: (): readonly NpcRecord[] => npcs.filter(visible),
    get: (id: string) => npcs.find((n) => n.id === id && visible(n)),
    buildings: (): readonly BuildingRecord[] => buildings.filter((b) => !remoteDeleted.has(b.npcId)),
    buildingOf: (npcId: string) => remoteDeleted.has(npcId) ? undefined : buildings.find((b) => b.npcId === npcId),

    /**
     * Switches the village to this account (its cached copy until Supabase answers) or, for
     * null, to this device's own save. Each account's placements live under its own key, so
     * switching accounts never mixes or overwrites villages. Tombstones are account-scoped too.
     */
    useAccount (ownerId: string | null)
    {
        if (ownerId === activeAccount) return;
        activeAccount = ownerId;
        storageKey = ownerId ? accountKey(ownerId) : LEGACY_KEY;
        load(storageKey, !ownerId);
        sync = ownerId ? { state: 'loading' } : { state: 'local' };
        let ids: unknown = [];
        try { ids = JSON.parse(ownerId ? readText(deletionKey(ownerId)) ?? '[]' : '[]'); }
        catch { /* The server refresh restores the authoritative markers. */ }
        remoteDeleted = new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
        listeners.forEach((fn) => fn({ saved: true }));
    },

    activeAccount: () => activeAccount,
    syncStatus: (): SyncStatus => sync,
    /** Changes are refused until the signed-in account's village has been loaded. */
    editable: () => sync.state === 'local' || sync.state === 'ready',

    setSyncStatus (ownerId: string | null, status: SyncStatus)
    {
        if (ownerId !== activeAccount) return;
        sync = status;
        listeners.forEach((fn) => fn({ saved: true }));
    },

    /** Replaces the account's village with the server's copy (the source of truth). */
    replaceFromServer (ownerId: string, entries: VillageEntry[]): boolean
    {
        if (ownerId !== activeAccount) return false;
        npcs = entries.map((e) => e.npc);
        buildings = entries.flatMap((e) => (e.building ? [e.building] : []));
        sync = { state: 'ready' };
        commit();
        return true;
    },

    /** Puts one NPC (and building) back exactly as it was, or removes it (null): undo after a failed save. */
    restore (id: string, entry: VillageEntry | null)
    {
        npcs = entry ? (npcs.some((n) => n.id === id) ? npcs.map((n) => (n.id === id ? entry.npc : n)) : [...npcs, entry.npc]) : npcs.filter((n) => n.id !== id);
        buildings = [...buildings.filter((b) => b.npcId !== id), ...(entry?.building ? [entry.building] : [])];
        commit();
    },

    /** The NPC as stored right now (for undo), including their building. */
    entry (id: string): VillageEntry | null
    {
        const npc = npcs.find((n) => n.id === id);
        return npc ? { npc, building: buildings.find((b) => b.npcId === id) ?? null } : null;
    },

    /** What is written to npcs.game_state for this NPC. */
    gameStateFor (record: NpcRecord): NpcGameState
    {
        const b = buildings.find((x) => x.npcId === record.id);
        return {
            v: GAME_STATE_VERSION, map: record.map, x: record.x, y: record.y,
            dialogue: record.dialogue, reactions: record.reactions ?? {}, minigameType: record.minigameType, completed: record.completed,
            building: b ? { id: b.id, type: b.type, map: b.map, x: b.x, y: b.y } : null,
        };
    },

    rememberRemoteDeletions (ownerId: string, ids: string[])
    {
        if (ownerId !== activeAccount) return;
        ids.forEach((id) => remoteDeleted.add(id));
        const saved = writeJson(deletionKey(ownerId), [...remoteDeleted]);
        listeners.forEach((fn) => fn({ saved }));
    },

    /** Distinct classes (first spelling wins), for the creator UI. */
    classes (): string[]
    {
        const seen = new Map<string, string>();
        for (const n of npcStore.all()) if (!seen.has(classKey(n.subject))) seen.set(classKey(n.subject), n.subject);
        return [...seen.values()];
    },

    usage: () => ({ npcs: npcStore.all().length, maxNpcs: MAX_NPCS, classes: npcStore.classes().length, maxClasses: MAX_CLASSES }),

    /** Why an NPC with this subject cannot be created / given this subject, or null if allowed. */
    checkLimits (subject: string, editingId?: string): string | null
    {
        if (!editingId && npcStore.all().length >= MAX_NPCS)
        {
            return `NPC limit reached (${MAX_NPCS}/${MAX_NPCS}). Delete an NPC to add a new one.`;
        }
        const key = classKey(subject);
        const otherClasses = new Set(npcStore.all().filter((n) => n.id !== editingId).map((n) => classKey(n.subject)));
        if (!otherClasses.has(key) && otherClasses.size >= MAX_CLASSES)
        {
            return `Class limit reached (${MAX_CLASSES}/${MAX_CLASSES}). Pick an existing class: ${npcStore.classes().join(', ')}.`;
        }
        return null;
    },

    create (input: NpcInput, placement: Placement): Result<NpcRecord>
    {
        if (!npcStore.editable()) return { ok: false, error: NOT_READY };
        const limit = npcStore.checkLimits(input.subject);
        if (limit) return { ok: false, error: limit };

        const now = new Date().toISOString();
        const record = sanitizeNpc({
            ...input, id: input.id ?? newId('npc'), map: placement.map, x: placement.npcX, y: placement.npcY,
            completed: false, createdAt: now, updatedAt: now,
        });
        if (!record) return { ok: false, error: 'Please enter a name and a class.' };

        npcs = [...npcs, record];
        buildings = [...buildings, makeBuilding(record, placement, now)];
        commit();
        return { ok: true, value: record };
    },

    update (id: string, patch: NpcPatch): Result<NpcRecord>
    {
        if (!npcStore.editable()) return { ok: false, error: NOT_READY };
        const current = npcs.find((n) => n.id === id);
        if (!current) return { ok: false, error: 'That NPC no longer exists.' };
        if (patch.subject !== undefined)
        {
            const limit = npcStore.checkLimits(patch.subject, id);
            if (limit) return { ok: false, error: limit };
        }

        const now = new Date().toISOString();
        const record = sanitizeNpc({ ...current, ...patch, id, updatedAt: now });
        if (!record) return { ok: false, error: 'Please enter a name and a class.' };
        npcs = npcs.map((n) => (n.id === id ? record : n));

        // The building's theme follows the NPC's appearance.
        const type = BUILDING_FOR_APPEARANCE[record.appearance];
        buildings = buildings.map((b) => (b.npcId === id && b.type !== type ? { ...b, type, updatedAt: now } : b));
        commit();
        return { ok: true, value: record };
    },

    /** Moves an NPC home + building together (creates the building if they had none). */
    relocate (id: string, placement: Placement): Result<NpcRecord>
    {
        if (!npcStore.editable()) return { ok: false, error: NOT_READY };
        const current = npcs.find((n) => n.id === id);
        if (!current) return { ok: false, error: 'That NPC no longer exists.' };
        const now = new Date().toISOString();
        const record = { ...current, map: placement.map, x: Math.round(placement.npcX), y: Math.round(placement.npcY), updatedAt: now };
        npcs = npcs.map((n) => (n.id === id ? record : n));
        const existing = buildings.find((b) => b.npcId === id);
        buildings = [
            ...buildings.filter((b) => b.npcId !== id),
            { ...makeBuilding(record, placement, now), id: existing?.id ?? newId('bld'), createdAt: existing?.createdAt ?? now },
        ];
        commit();
        return { ok: true, value: record };
    },

    /** Deletes an NPC and their building. */
    remove (id: string)
    {
        npcs = npcs.filter((n) => n.id !== id);
        buildings = buildings.filter((b) => b.npcId !== id);
        commit();
    },

    /** Called after every change with whether it reached storage. Returns an unsubscribe function. */
    subscribe (fn: Listener)
    {
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    },
};

function makeBuilding (npc: NpcRecord, placement: Placement, now: string): BuildingRecord
{
    return {
        id: newId('bld'), npcId: npc.id, type: BUILDING_FOR_APPEARANCE[npc.appearance],
        map: placement.map, x: Math.round(placement.x), y: Math.round(placement.y), createdAt: now, updatedAt: now,
    };
}

function commit ()
{
    const saved = persist();
    listeners.forEach((fn) => fn({ saved }));
}

function persist (): boolean
{
    return writeJson(storageKey, { version: SCHEMA_VERSION, npcs, buildings });
}

/** Reads a save without touching the live village (null if missing / unreadable). */
export function readSave (key: string): VillageEntry[] | null
{
    const text = readText(key);
    if (!text) return null;
    try
    {
        const save = parseSave(text);
        return save.npcs.map((npc) => ({ npc, building: save.buildings.find((b) => b.npcId === npc.id) ?? null }));
    }
    catch { return null; }
}

/** A new NPC + building exactly as create() would make them (used for defaults on a new account). */
export function newEntry (input: NpcInput, placement: Placement): VillageEntry | null
{
    const now = new Date().toISOString();
    const npc = sanitizeNpc({ ...input, id: input.id ?? newId('npc'), map: placement.map, x: placement.npcX, y: placement.npcY, completed: false, createdAt: now, updatedAt: now });
    return npc ? { npc, building: makeBuilding(npc, placement, now) } : null;
}

/**
 * Rebuilds a village entry from a server row. Columns are authoritative for identity and
 * persona; game_state for placement. A row without usable game_state (made before placements
 * were stored) takes it from `fallback` (a local copy of the same NPC) or a default spot;
 * `needsState` tells the caller to write it back.
 */
export function entryFromServer (row: ServerNpcRow, fallback: VillageEntry | null, defaultSpot: { map: MapId; x: number; y: number }): (VillageEntry & { needsState: boolean }) | null
{
    const raw = row.game_state && typeof row.game_state === 'object' ? row.game_state as Record<string, unknown> : {};
    const placed = MAP_IDS.includes(raw.map as MapId) && finite(raw.x) && finite(raw.y);
    const base: Record<string, unknown> = placed ? raw : fallback ? { ...fallback.npc } : { ...defaultSpot, dialogue: [], minigameType: null, completed: false };
    const npc = sanitizeNpc({
        ...base,
        id: row.game_npc_id, name: row.name, subject: row.subject, appearance: row.appearance,
        personality: row.personality ?? '', teachingInstructions: row.teaching_instructions ?? '',
        createdAt: row.created_at, updatedAt: row.updated_at,
    });
    if (!npc) return null;
    // The building theme always follows the appearance (as update() keeps it).
    const type = BUILDING_FOR_APPEARANCE[npc.appearance];
    let building: BuildingRecord | null = null;
    if (placed && raw.building && typeof raw.building === 'object')
    {
        building = sanitizeBuilding({ ...(raw.building as object), type, npcId: npc.id, createdAt: npc.createdAt, updatedAt: npc.updatedAt });
    }
    else if (!placed && fallback?.building) building = { ...fallback.building, type, npcId: npc.id };
    return { npc, building, needsState: !placed };
}

function backup (key: string, suffix: string, text: string)
{
    backupText(key, suffix, text);
}

function parseSave (text: string): { npcs: NpcRecord[]; buildings: BuildingRecord[]; migrated: boolean }
{
    const data = JSON.parse(text);
    if (!Array.isArray(data?.npcs)) throw new Error('Missing npcs list');
    const loadedNpcs: NpcRecord[] = data.npcs.map(sanitizeNpc).filter((n: NpcRecord | null): n is NpcRecord => n !== null);

    if (data.version === 1)
    {
        // v1 had no buildings. Sir Sum-a-Lot moves into his training hall if he was never moved;
        // other NPCs keep their spot and can get a building with "Move".
        let list = loadedNpcs;
        const built: BuildingRecord[] = [];
        const sir = list.find((n) => n.id === 'sir-sum-a-lot');
        if (sir && sir.map === 'hub' && sir.x === LEGACY_SIR_POSITION.x && sir.y === LEGACY_SIR_POSITION.y)
        {
            const now = new Date().toISOString();
            const moved = { ...sir, x: SIR_PLACEMENT.npcX, y: SIR_PLACEMENT.npcY, updatedAt: now };
            list = list.map((n) => (n.id === sir.id ? moved : n));
            built.push(makeBuilding(moved, SIR_PLACEMENT, now));
        }
        return { npcs: list, buildings: built, migrated: true };
    }
    if (data.version !== SCHEMA_VERSION) throw new Error(`Unsupported data version ${data.version}`);

    const ids = new Set(loadedNpcs.map((n) => n.id));
    const seen = new Set<string>();
    const loadedBuildings = (Array.isArray(data.buildings) ? data.buildings : [])
        .map(sanitizeBuilding)
        .filter((b: BuildingRecord | null): b is BuildingRecord =>
        {
            // Drop orphans and duplicates (one building per NPC).
            if (!b || !ids.has(b.npcId) || seen.has(b.npcId)) return false;
            seen.add(b.npcId);
            return true;
        });
    return { npcs: loadedNpcs, buildings: loadedBuildings, migrated: false };
}

/** Loads a save into the live village. `seed`: a missing device save gets the default NPCs. */
function load (key: string, seed: boolean)
{
    const text = readText(key);
    npcs = [];
    buildings = [];
    // undefined = storage blocked (e.g. privacy mode): run in memory; null = first launch.
    if (text === undefined || text === null)
    {
        if (seed) seedDefaults();
        return;
    }
    try
    {
        const save = parseSave(text);
        npcs = save.npcs;
        buildings = save.buildings;
        if (save.migrated)
        {
            backup(key, 'v1-backup', text);
            persist();
        }
        if (npcs.length > MAX_NPCS) console.warn(`[npcStore] ${npcs.length} NPCs saved (limit ${MAX_NPCS}); new NPCs are blocked until some are deleted.`);
    }
    catch (err)
    {
        // Never silently drop teacher data: keep the unreadable copy before resetting.
        console.warn(`[npcStore] Saved NPCs could not be read. A copy was kept in "${key}.backup".`, err);
        backup(key, 'backup', text);
        if (seed) seedDefaults();
    }
}

function seedDefaults ()
{
    const now = new Date().toISOString();
    npcs = [];
    buildings = [];
    for (const { npc, placement } of DEFAULT_NPCS)
    {
        const record = sanitizeNpc({ ...npc, map: placement.map, x: placement.npcX, y: placement.npcY, completed: false, createdAt: now, updatedAt: now });
        if (!record) continue;
        npcs.push(record);
        buildings.push(makeBuilding(record, placement, now));
    }
}

function newId (prefix: string)
{
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}_${random}`;
}

// ---------------------------------------------------------------- validation (storage is untrusted)

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const lines = (value: unknown) => (Array.isArray(value) ? value : [])
    .map((line) => text(line, LIMITS.line))
    .filter(Boolean)
    .slice(0, LIMITS.lines);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function sanitizeNpc (raw: unknown): NpcRecord | null
{
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;

    const id = text(r.id, 64);
    const name = text(r.name, LIMITS.name);
    const map = MAP_IDS.find((m) => m === r.map);
    if (!id || !name || !map || !finite(r.x) || !finite(r.y)) return null;

    let reactions: NpcReactions | undefined;
    if (r.reactions && typeof r.reactions === 'object')
    {
        const src = r.reactions as Record<string, unknown>;
        reactions = {};
        for (const key of ['declined', 'passed', 'failed', 'completed'] as const)
        {
            const value = lines(src[key]);
            if (value.length) reactions[key] = value;
        }
    }

    const now = new Date().toISOString();
    const personality = text(r.personality, LIMITS.personality);
    const teachingInstructions = text(r.teachingInstructions, LIMITS.instructions);
    return {
        id,
        name,
        subject: text(r.subject, LIMITS.subject) || 'General Studies',
        appearance: isAppearanceId(r.appearance) ? r.appearance : 'knight',
        map,
        x: Math.round(r.x),
        y: Math.round(r.y),
        dialogue: lines(r.dialogue),
        reactions,
        minigameType: isMinigameId(r.minigameType) ? r.minigameType : null,
        ...(personality ? { personality } : {}),
        ...(teachingInstructions ? { teachingInstructions } : {}),
        completed: r.completed === true,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
    };
}

function sanitizeBuilding (raw: unknown): BuildingRecord | null
{
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const id = text(r.id, 64);
    const npcId = text(r.npcId, 64);
    const map = MAP_IDS.find((m) => m === r.map);
    if (!id || !npcId || !map || !isBuildingType(r.type) || !finite(r.x) || !finite(r.y)) return null;
    const now = new Date().toISOString();
    return {
        id, npcId, type: r.type, map, x: Math.round(r.x), y: Math.round(r.y),
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
    };
}

// Load last: the validation helpers above must be initialised first.
load(LEGACY_KEY, true);
