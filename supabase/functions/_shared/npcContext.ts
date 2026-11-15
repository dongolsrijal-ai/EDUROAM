// Reusable NPC context + memory operations. Game chat (npc-chat) uses them today; future
// FaceTime / iMessage / LiveKit agents call the same functions with a player id that a
// verified channel pairing resolved, so every channel shares one NPC identity and memory.
//
// Every query filters by the player explicitly. With a caller-scoped client RLS applies as
// well; with the admin client (server agents) the explicit filters are the access control.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import { HttpError } from './http.ts';
import type {
    AttachmentContext, Channel, HistoryTurn, MaterialStatus, RetrievedChunk, SourceRef, TutorMemory, TutorNpc, TutorProgress, WebPageRef, WebSourceRef,
} from './tutorPrompt.ts';

export interface NpcIdentity extends TutorNpc
{
    classId: string;
    ownerId: string;
    gameNpcId: string;
    appearance: string;
}

const fail = (error: { message: string } | null) => { if (error) throw new Error(error.message); };

/** Resolve NPC identity + instructions, and verify the player may talk to it. */
export async function resolveNpcIdentity (db: SupabaseClient, playerId: string, npcId: string): Promise<NpcIdentity>
{
    const { data, error } = await db
        .from('npcs')
        .select('id, owner_id, class_id, game_npc_id, name, appearance, subject, personality, teaching_instructions, classes(name, description, owner_id)')
        .eq('id', npcId)
        .maybeSingle();
    fail(error);
    const cls = (Array.isArray(data?.classes) ? data?.classes[0] : data?.classes) as { name: string; description: string; owner_id: string } | undefined;
    if (!data || !cls) throw new HttpError(404, 'npc_not_found', 'That teacher could not be found.');

    if (cls.owner_id !== playerId)
    {
        const { data: member, error: memberError } = await db
            .from('class_members').select('player_id').eq('class_id', data.class_id).eq('player_id', playerId).maybeSingle();
        fail(memberError);
        if (!member) throw new HttpError(404, 'npc_not_found', 'That teacher could not be found.');
    }

    return {
        id: data.id, ownerId: data.owner_id, classId: data.class_id, gameNpcId: data.game_npc_id,
        name: data.name, appearance: data.appearance, subject: data.subject,
        personality: data.personality ?? '', teachingInstructions: data.teaching_instructions ?? '',
        className: cls.name, classDescription: cls.description ?? '',
    };
}

/** PostgREST filter: class material for this NPC + the player's own private uploads to it. */
export const npcDocumentScope = (npcId: string, playerId: string) =>
    `and(visibility.eq.class,npc_id.is.null),and(visibility.eq.class,npc_id.eq.${npcId}),and(visibility.eq.private,npc_id.eq.${npcId},uploaded_by.eq.${playerId})`;

/** Load class knowledge: document statuses plus the chunks most relevant to `query`. */
export async function loadClassKnowledge (db: SupabaseClient, playerId: string, npc: NpcIdentity, query: string, limit = 6)
    : Promise<{ materials: MaterialStatus[]; chunks: RetrievedChunk[] }>
{
    const [docs, matches] = await Promise.all([
        db.from('class_documents')
            .select('id, title, processing_status, visibility')
            .eq('class_id', npc.classId)
            .or(npcDocumentScope(npc.id, playerId))
            .order('created_at', { ascending: false })
            .limit(30),
        db.rpc('match_npc_chunks', { p_npc_id: npc.id, p_query: query, p_limit: limit, p_player_id: playerId }),
    ]);
    fail(docs.error);
    fail(matches.error);

    const materials: MaterialStatus[] = (docs.data ?? []).map((d) => ({
        id: d.id, title: d.title, status: d.processing_status, visibility: d.visibility,
    }));
    const chunks: RetrievedChunk[] = (matches.data ?? []).map((c: Record<string, unknown>) =>
    {
        const source = (c.source ?? {}) as { page_start?: number; page_end?: number };
        return {
            chunkId: String(c.chunk_id), documentId: String(c.document_id), title: String(c.title),
            visibility: c.visibility === 'private' ? 'private' : 'class', chunkIndex: Number(c.chunk_index),
            text: String(c.chunk_text), pageStart: source.page_start, pageEnd: source.page_end,
        };
    });
    return { materials, chunks };
}

/** Retrieve the player's private memory with this NPC and their progress in its class. */
export async function retrieveStudentMemory (db: SupabaseClient, playerId: string, npc: NpcIdentity)
    : Promise<{ memory: TutorMemory; progress: TutorProgress }>
{
    const [memory, progress] = await Promise.all([
        db.from('npc_memories').select('summary, current_topic, topics_studied, learning_preferences, pending_preference')
            .eq('player_id', playerId).eq('npc_id', npc.id).maybeSingle(),
        db.from('class_progress').select('topics_mastered, topics_needing_practice')
            .eq('player_id', playerId).eq('class_id', npc.classId).maybeSingle(),
    ]);
    fail(memory.error);
    fail(progress.error);
    return {
        memory: {
            summary: memory.data?.summary ?? '',
            currentTopic: memory.data?.current_topic ?? '',
            topicsStudied: memory.data?.topics_studied ?? [],
            learningPreferences: memory.data?.learning_preferences ?? [],
            pendingPreference: memory.data?.pending_preference ?? '',
        },
        progress: {
            topicsMastered: progress.data?.topics_mastered ?? [],
            topicsNeedingPractice: progress.data?.topics_needing_practice ?? [],
        },
    };
}

/** Retrieve recent turns of one conversation (verifying it belongs to this player + NPC + channel). */
export async function retrieveConversationContext (
    db: SupabaseClient, playerId: string, npcId: string, conversationId: string | null, channel: Channel, limit = 12,
): Promise<HistoryTurn[]>
{
    if (!conversationId) return [];
    const { data: conversation, error } = await db.from('conversations').select('id')
        .eq('id', conversationId).eq('player_id', playerId).eq('npc_id', npcId).eq('channel', channel).maybeSingle();
    fail(error);
    if (!conversation) throw new HttpError(404, 'conversation_not_found', 'That conversation could not be found.');

    const { data, error: messagesError } = await db.from('messages').select('role, content')
        .eq('conversation_id', conversationId).in('role', ['player', 'npc'])
        .order('created_at', { ascending: false }).limit(limit);
    fail(messagesError);
    return (data ?? []).reverse().map((m) => ({ role: m.role as HistoryTurn['role'], content: m.content }));
}

export interface TurnToSave
{
    playerId: string;
    npcId: string;
    conversationId: string | null;
    channel: Channel;
    playerMessage: string;
    clientMessageId: string | null;
    reply: string;
    sources: (SourceRef | WebSourceRef | WebPageRef)[];
    memory: TutorMemory;
    progress: TutorProgress;
}

/**
 * Save a conversation turn and update memory + student progress in ONE transaction
 * (server only: needs the admin client). Returns the conversation id.
 */
export async function saveConversationTurn (admin: SupabaseClient, turn: TurnToSave): Promise<string>
{
    const { data, error } = await admin.rpc('save_tutor_turn', {
        p_player_id: turn.playerId,
        p_npc_id: turn.npcId,
        p_conversation_id: turn.conversationId,
        p_channel: turn.channel,
        p_player_message: turn.playerMessage,
        p_client_message_id: turn.clientMessageId,
        p_reply: turn.reply,
        p_source_refs: turn.sources,
        p_memory: {
            summary: turn.memory.summary,
            current_topic: turn.memory.currentTopic,
            topics_studied: turn.memory.topicsStudied,
            learning_preferences: turn.memory.learningPreferences,
            pending_preference: turn.memory.pendingPreference ?? '',
        },
        p_progress: {
            topics_mastered: turn.progress.topicsMastered,
            topics_needing_practice: turn.progress.topicsNeedingPractice,
        },
    });
    if (error)
    {
        if (error.code === '23505') throw new HttpError(409, 'duplicate_message', 'That message was already sent.');
        if (error.code === 'P0002') throw new HttpError(404, 'conversation_not_found', error.message);
        throw new Error(error.message);
    }
    return String(data);
}

/** Text budget for files attached to one message (per file / all together). */
export const ATTACHMENT_CHARS = { perFile: 15_000, total: 30_000 } as const;

/**
 * Files the student attached to THIS message: only documents this player may use with this
 * NPC (same scope as retrieval: class material, or their own private upload to it), with
 * their extracted text in reading order. Anything else is reported as unavailable.
 */
export async function loadAttachments (db: SupabaseClient, playerId: string, npc: NpcIdentity, ids: string[]): Promise<AttachmentContext[]>
{
    if (!ids.length) return [];
    const [docs, chunks] = await Promise.all([
        db.from('class_documents').select('id, title, processing_status')
            .in('id', ids).eq('class_id', npc.classId).or(npcDocumentScope(npc.id, playerId)),
        db.from('document_chunks').select('document_id, chunk_index, chunk_text')
            .in('document_id', ids).order('chunk_index').limit(200),
    ]);
    fail(docs.error);
    fail(chunks.error);
    let budget: number = ATTACHMENT_CHARS.total;
    return ids.map((id) =>
    {
        const doc = (docs.data ?? []).find((d) => d.id === id);
        if (!doc || doc.processing_status !== 'ready') return { documentId: id, title: doc?.title ?? 'attachment', status: 'unavailable' as const, text: '' };
        const text = (chunks.data ?? []).filter((c) => c.document_id === id).map((c) => c.chunk_text).join('\n')
            .slice(0, Math.min(ATTACHMENT_CHARS.perFile, Math.max(0, budget)));
        budget -= text.length;
        return { documentId: id, title: doc.title, status: text ? 'ready' as const : 'unavailable' as const, text };
    });
}
