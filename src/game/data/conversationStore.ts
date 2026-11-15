// LOCAL repository for player-specific NPC data: conversation history (all channels),
// private NPC memory and learning progress. Everything is keyed by (playerId, npcId), the
// same composite key the Supabase tables use (see docs/npc-ai-architecture.md).
//
// localStorage "eduroam.conversations" = { version, messages, memories, learning }.
// Only services/npcService.ts should use this module; swapping to Supabase replaces it.

import type { ConversationMessage, ConversationSource, LearningRecord, NpcMemory } from '../services/contracts';
import { backupText, readText, scopedKey, writeJson } from './storage';

/** This account's own copy (see data/storage.ts ACCOUNT_SCOPED_KEYS). */
const STORAGE_KEY = scopedKey('eduroam.conversations');
const SCHEMA_VERSION = 1;
/** Local history kept per player + NPC (the backend keeps everything). */
const MAX_MESSAGES_PER_THREAD = 100;

interface Doc
{
    messages: ConversationMessage[];
    memories: NpcMemory[];
    learning: LearningRecord[];
}

let doc: Doc = load();

const sameThread = (playerId: string, npcId: string) =>
    (r: { playerId: string; npcId: string }) => r.playerId === playerId && r.npcId === npcId;

export const conversationStore = {
    appendMessage (message: ConversationMessage)
    {
        doc.messages.push(message);
        const thread = doc.messages.filter(sameThread(message.playerId, message.npcId));
        if (thread.length > MAX_MESSAGES_PER_THREAD)
        {
            const drop = new Set(thread.slice(0, thread.length - MAX_MESSAGES_PER_THREAD));
            doc.messages = doc.messages.filter((m) => !drop.has(m));
        }
        touchMemory(message.playerId, message.npcId, message.source, message.createdAt);
        save();
    },

    history (playerId: string, npcId: string, limit = 50): ConversationMessage[]
    {
        return doc.messages.filter(sameThread(playerId, npcId)).slice(-limit);
    },

    memory (playerId: string, npcId: string): NpcMemory | null
    {
        return doc.memories.find(sameThread(playerId, npcId)) ?? null;
    },

    learning (playerId: string, npcId?: string): LearningRecord[]
    {
        return doc.learning.filter((r) => r.playerId === playerId && (!npcId || r.npcId === npcId));
    },

    recordLearning (entry: Omit<LearningRecord, 'attempts' | 'bestScore'>)
    {
        const existing = doc.learning.find((r) => sameThread(entry.playerId, entry.npcId)(r) && r.challengeId === entry.challengeId);
        if (existing)
        {
            Object.assign(existing, entry, {
                attempts: existing.attempts + 1,
                bestScore: Math.max(existing.bestScore, entry.lastScore),
                passed: existing.passed || entry.passed,
            });
        }
        else
        {
            doc.learning.push({ ...entry, attempts: 1, bestScore: entry.lastScore });
        }
        save();
    },
};

/** Keeps the memory record's bookkeeping current; summary/facts are written by the AI later. */
function touchMemory (playerId: string, npcId: string, source: ConversationSource, at: string)
{
    let memory = doc.memories.find(sameThread(playerId, npcId));
    if (!memory)
    {
        memory = { playerId, npcId, summary: '', facts: [], channelsUsed: [], lastInteractionAt: at };
        doc.memories.push(memory);
    }
    if (!memory.channelsUsed.includes(source)) memory.channelsUsed.push(source);
    memory.lastInteractionAt = at;
}

function save ()
{
    writeJson(STORAGE_KEY, { version: SCHEMA_VERSION, ...doc });
}

function load (): Doc
{
    const empty: Doc = { messages: [], memories: [], learning: [] };
    const text = readText(STORAGE_KEY);
    if (!text) return empty;
    try
    {
        const raw = JSON.parse(text);
        if (raw?.version !== SCHEMA_VERSION) throw new Error(`Unsupported version ${raw?.version}`);
        return {
            messages: Array.isArray(raw.messages) ? raw.messages : [],
            memories: Array.isArray(raw.memories) ? raw.memories : [],
            learning: Array.isArray(raw.learning) ? raw.learning : [],
        };
    }
    catch (err)
    {
        console.warn(`[conversationStore] Saved conversations could not be read; kept a copy in "${STORAGE_KEY}.backup".`, err);
        backupText(STORAGE_KEY, 'backup', text);
        return empty;
    }
}
