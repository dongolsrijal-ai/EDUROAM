// Data-driven NPCs and their buildings. Every NPC (built-in or teacher-made) is an
// NpcRecord here; each building is a BuildingRecord pointing at its NPC (npcId).
//
// Persistence: localStorage STORAGE_KEY = { version: 2, npcs: NpcRecord[], buildings: BuildingRecord[] }.
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
export const LIMITS = { name: 32, subject: 32, line: 200, lines: 8 };

const STORAGE_KEY = 'eduroam.npcs';
const SCHEMA_VERSION = 2;

type Listener = (status: { saved: boolean }) => void;
const listeners = new Set<Listener>();
let npcs: NpcRecord[] = [];
let buildings: BuildingRecord[] = [];

const classKey = (subject: string) => subject.trim().toLowerCase();

export const npcStore = {
    all: (): readonly NpcRecord[] => npcs,
    get: (id: string) => npcs.find((n) => n.id === id),
    buildings: (): readonly BuildingRecord[] => buildings,
    buildingOf: (npcId: string) => buildings.find((b) => b.npcId === npcId),

    /** Distinct classes (first spelling wins), for the creator UI. */
    classes (): string[]
    {
        const seen = new Map<string, string>();
        for (const n of npcs) if (!seen.has(classKey(n.subject))) seen.set(classKey(n.subject), n.subject);
        return [...seen.values()];
    },

    usage: () => ({ npcs: npcs.length, maxNpcs: MAX_NPCS, classes: npcStore.classes().length, maxClasses: MAX_CLASSES }),

    /** Why an NPC with this subject cannot be created / given this subject, or null if allowed. */
    checkLimits (subject: string, editingId?: string): string | null
    {
        if (!editingId && npcs.length >= MAX_NPCS)
        {
            return `NPC limit reached (${MAX_NPCS}/${MAX_NPCS}). Delete an NPC to add a new one.`;
        }
        const key = classKey(subject);
        const otherClasses = new Set(npcs.filter((n) => n.id !== editingId).map((n) => classKey(n.subject)));
        if (!otherClasses.has(key) && otherClasses.size >= MAX_CLASSES)
        {
            return `Class limit reached (${MAX_CLASSES}/${MAX_CLASSES}). Pick an existing class: ${npcStore.classes().join(', ')}.`;
        }
        return null;
    },

    create (input: NpcInput, placement: Placement): Result<NpcRecord>
    {
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
    return writeJson(STORAGE_KEY, { version: SCHEMA_VERSION, npcs, buildings });
}

function backup (suffix: string, text: string)
{
    backupText(STORAGE_KEY, suffix, text);
}

function load ()
{
    const text = readText(STORAGE_KEY);
    // undefined = storage blocked (e.g. privacy mode): run in memory; null = first launch.
    if (text === undefined || text === null) return seedDefaults();

    try
    {
        const data = JSON.parse(text);
        if (!Array.isArray(data?.npcs)) throw new Error('Missing npcs list');
        const loadedNpcs: NpcRecord[] = data.npcs.map(sanitizeNpc).filter((n: NpcRecord | null): n is NpcRecord => n !== null);

        if (data.version === 1)
        {
            // v1 had no buildings. Sir Sum-a-Lot moves into his training hall if he was never moved;
            // other NPCs keep their spot and can get a building with "Move".
            backup('v1-backup', text);
            npcs = loadedNpcs;
            buildings = [];
            const sir = npcs.find((n) => n.id === 'sir-sum-a-lot');
            if (sir && sir.map === 'hub' && sir.x === LEGACY_SIR_POSITION.x && sir.y === LEGACY_SIR_POSITION.y)
            {
                const now = new Date().toISOString();
                const moved = { ...sir, x: SIR_PLACEMENT.npcX, y: SIR_PLACEMENT.npcY, updatedAt: now };
                npcs = npcs.map((n) => (n.id === sir.id ? moved : n));
                buildings.push(makeBuilding(moved, SIR_PLACEMENT, now));
            }
            persist();
            return;
        }
        if (data.version !== SCHEMA_VERSION) throw new Error(`Unsupported data version ${data.version}`);

        npcs = loadedNpcs;
        const ids = new Set(npcs.map((n) => n.id));
        const seen = new Set<string>();
        buildings = (Array.isArray(data.buildings) ? data.buildings : [])
            .map(sanitizeBuilding)
            .filter((b: BuildingRecord | null): b is BuildingRecord =>
            {
                // Drop orphans and duplicates (one building per NPC).
                if (!b || !ids.has(b.npcId) || seen.has(b.npcId)) return false;
                seen.add(b.npcId);
                return true;
            });
        if (npcs.length > MAX_NPCS) console.warn(`[npcStore] ${npcs.length} NPCs saved (limit ${MAX_NPCS}); new NPCs are blocked until some are deleted.`);
    }
    catch (err)
    {
        // Never silently drop teacher data: keep the unreadable copy before resetting.
        console.warn(`[npcStore] Saved NPCs could not be read. A copy was kept in "${STORAGE_KEY}.backup".`, err);
        backup('backup', text);
        seedDefaults();
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
load();
