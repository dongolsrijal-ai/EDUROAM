// Game-side client for the AI tutoring backend (Supabase tables + Edge Functions).
//
// The local npcStore stays the game's NPC manager. Before an NPC is used for tutoring its
// definition is mirrored (idempotent upsert keyed by the game's stable NPC id) into the
// signed-in player's Supabase classes/npcs rows. Chat and document processing go through
// Edge Functions; the browser never sees the Gemini key and never chooses its player id.

import { npcStore, type NpcRecord, type ServerNpcRow } from '../data/npcStore';
import {
    checkUpload, isImageType, type DocumentStatus, type DocumentVisibility,
} from '../../../supabase/functions/_shared/documentRules';
import { getSession, publicConfig, supabase } from './backend';

export interface RemoteNpc
{
    id: string;
    classId: string;
    className: string;
    ownerId: string;
}

/** A coursework excerpt the reply used. */
export interface SourceRef
{
    kind?: 'document';
    document_id: string;
    title: string;
    chunk_index: number;
    page_start?: number;
    page_end?: number;
    /** The student attached this file to the message. */
    attached?: boolean;
}

/** A website from Google Search grounding (returned by the API, never written by the model). */
export interface WebSourceRef
{
    kind: 'web';
    url: string;
    title: string;
}

/** A link the student shared that was actually read for the reply. */
export interface WebPageRef
{
    kind: 'page';
    url: string;
    title: string;
}

/** Every link a reply was about, with its real retrieval status. */
export interface PageStatus
{
    url: string;
    title: string;
    status: 'read' | 'failed';
    reason?: string;
}

/** used = grounded web results; failed = research was attempted but nothing could be verified. */
export type WebSearchOutcome = 'used' | 'failed' | 'unavailable' | 'off';

/** Labels: Class Materials / Web Source (page read) / Google Search (grounding ran) / General Knowledge. */
export interface Knowledge
{
    /** The reply used files / images attached to the message. */
    attachment?: boolean;
    coursework: boolean;
    webPage: boolean;
    search: boolean;
    general: boolean;
}

export interface ChatMessage
{
    role: 'player' | 'npc' | 'system';
    content: string;
    sources: SourceRef[];
    webSources?: WebSourceRef[];
    pageSources?: WebPageRef[];
    /** Live replies only: links that could not be read (with the reason). */
    failedPages?: PageStatus[];
    /** Live replies only (older saved messages derive labels from their sources). */
    knowledge?: Knowledge;
    webSearch?: WebSearchOutcome;
    searchSuggestions?: string | null;
    createdAt: string;
}

export interface ConversationSummary
{
    id: string;
    channel: string;
    createdAt: string;
    updatedAt: string;
    preview: string;
}

export interface MaterialRow
{
    id: string;
    title: string;
    fileType: string;
    visibility: DocumentVisibility;
    status: DocumentStatus;
    error: string | null;
    chunkCount: number;
    mine: boolean;
    createdAt: string;
    topic: string;
    chapter: string;
    isImage: boolean;
    /** Image transcription had unreadable/uncertain parts: the student should check it. */
    needsReview: boolean;
    uncertain: string[];
    /** Saved from a website: its source address. */
    sourceUrl: string | null;
}

export interface CourseworkMeta
{
    topic?: string;
    chapter?: string;
}

export interface LearningState
{
    currentTopic: string;
    summary: string;
    topicsMastered: string[];
    topicsNeedingPractice: string[];
}

export class TutorApiError extends Error
{
    readonly code: string;
    readonly retryable: boolean;

    constructor (code: string, message: string, retryable = false)
    {
        super(message);
        this.code = code;
        this.retryable = retryable;
    }
}

const SIGN_IN_REQUIRED = 'Sign in to use AI tutoring and class materials.';

/**
 * The verified Supabase Auth user id (never the game's local "player_..." id). Asks the
 * Auth server, so an expired or revoked session is caught before any record is written.
 */
async function requireUserId ()
{
    if (!(await getSession())) throw new TutorApiError('unauthenticated', SIGN_IN_REQUIRED);
    const { data, error } = await supabase().auth.getUser();
    if (error || !data.user) throw new TutorApiError('unauthenticated', 'Your session has expired. Please sign in again.');
    return data.user.id;
}

function dbError (error: { message: string; code?: string }): TutorApiError
{
    if (error.code === 'P0001') return new TutorApiError('limit', error.message);
    // Row level security refused the write: the request was not made as the owning account.
    // Row level security refused the request. The player IS signed in (identity was verified
    // just before), so don't show the sign-in form; explain and offer a retry.
    if (error.code === '42501') return new TutorApiError('forbidden', 'The server refused to save this for your account (permission check failed). Try again; if it keeps happening, sign out and back in.', true);
    return new TutorApiError('database', error.message || 'The server could not save that.', true);
}

/** Calls an Edge Function and unwraps { error: { code, message } } replies. */
export async function invoke<T> (name: string, body: Record<string, unknown>): Promise<T>
{
    const { data, error } = await supabase().functions.invoke(name, { body });
    if (!error) return data as T;
    const context = (error as { context?: Response }).context;
    let payload: { error?: { code?: string; message?: string; retryable?: boolean } } | null = null;
    if (context && typeof context.json === 'function')
    {
        try { payload = await context.clone().json(); }
        catch { /* not JSON */ }
    }
    if (payload?.error?.message) throw new TutorApiError(payload.error.code ?? 'error', payload.error.message, payload.error.retryable ?? false);
    if (context?.status === 404) throw new TutorApiError('not_deployed', `The ${name} server function is not deployed yet.`);
    throw new TutorApiError('network', 'Could not reach the tutoring server. Check your connection and try again.', true);
}

// ------------------------------------------------------------------ NPC + class sync

export interface ServerNpc extends ServerNpcRow
{
    id: string;
    class_id: string;
}

export interface NpcRoster
{
    ownerId: string;
    npcs: ServerNpc[];
    deletions: { npc_id: string; game_npc_id: string; completed_at: string | null }[];
}

/** Authoritative, caller-scoped reads only. Missing locally does not mean safe to delete. */
export async function loadNpcRoster (): Promise<NpcRoster>
{
    const ownerId = await requireUserId();
    const [npcs, deletions] = await Promise.all([
        supabase().from('npcs').select('id, game_npc_id, name, class_id, subject, appearance, personality, teaching_instructions, created_at, updated_at, game_state').eq('owner_id', ownerId).order('created_at'),
        supabase().from('npc_deletions').select('npc_id, game_npc_id, completed_at').eq('owner_id', ownerId),
    ]);
    if (npcs.error) throw dbError(npcs.error);
    if (deletions.error) throw dbError(deletions.error);
    return { ownerId, npcs: npcs.data ?? [], deletions: deletions.data ?? [] };
}

export function compareNpcRoster (local: readonly Pick<NpcRecord, 'id' | 'name'>[], roster: NpcRoster)
{
    const localIds = new Set(local.map((n) => n.id));
    const serverIds = new Set(roster.npcs.map((n) => n.game_npc_id));
    return {
        ownerId: roster.ownerId, localCount: local.length, serverCount: roster.npcs.length,
        matched: roster.npcs.filter((n) => localIds.has(n.game_npc_id)),
        localOnly: local.filter((n) => !serverIds.has(n.id)),
        serverOnly: roster.npcs.filter((n) => !localIds.has(n.game_npc_id)),
        deletions: roster.deletions,
        note: 'Read-only comparison. A server-only teacher may belong to another browser save. Review identity, coursework and history before explicitly deleting any record.',
    };
}

async function assertNpcNotDeleted (ownerId: string, gameNpcId: string)
{
    const { data, error } = await supabase().from('npc_deletions').select('npc_id').eq('owner_id', ownerId).eq('game_npc_id', gameNpcId).maybeSingle();
    if (error) throw dbError(error);
    if (data) throw new TutorApiError('npc_deleted', 'This teacher was deleted or is being deleted. Refresh the NPC list.');
}

/**
 * Saves the NPC (and its class = subject) to Supabase, including its village placement
 * (game_state), keyed by the stable game id; returns the backend ids. Always saves the store's
 * current copy, so a stale record held by a panel never rolls a newer edit or move back.
 */
export async function syncNpc (given: NpcRecord): Promise<RemoteNpc>
{
    const ownerId = await requireUserId();
    const record = npcStore.get(given.id) ?? given;
    const fields = {
        name: record.name, appearance: record.appearance, subject: record.subject,
        personality: record.personality ?? '', teaching_instructions: record.teachingInstructions ?? '',
        game_state: npcStore.gameStateFor(record),
    };
    await assertNpcNotDeleted(ownerId, record.id);

    const db = supabase();
    const existingClass = await db.from('classes').select('id, name').eq('owner_id', ownerId).eq('name_key', record.subject.trim().toLowerCase()).maybeSingle();
    if (existingClass.error) throw dbError(existingClass.error);
    let cls = existingClass.data;
    if (!cls)
    {
        const created = await db.from('classes').upsert({ owner_id: ownerId, name: record.subject, subject: record.subject }, { onConflict: 'owner_id,name_key' }).select('id, name').single();
        if (created.error) throw dbError(created.error);
        cls = created.data;
    }

    const existing = await db.from('npcs').select('id').eq('owner_id', ownerId).eq('game_npc_id', record.id).maybeSingle();
    if (existing.error) throw dbError(existing.error);
    const values = { class_id: cls!.id, ...fields };
    const query = existing.data
        ? db.from('npcs').update(values).eq('id', existing.data.id).eq('owner_id', ownerId)
        : db.from('npcs').upsert({ owner_id: ownerId, game_npc_id: record.id, ...values }, { onConflict: 'owner_id,game_npc_id' });
    const { data: npc, error: npcError } = await query.select('id, class_id').single();
    if (npcError) throw dbError(npcError);

    return { id: npc.id, classId: npc.class_id, className: cls!.name, ownerId };
}

/**
 * READ-ONLY lookup of this account's existing backend copy of a local NPC (by its stable game
 * id). Never inserts or updates anything: used where creating an NPC would be wrong (voice
 * calls). Returns null when the NPC has not been set up on this account yet.
 */
export async function findRemoteNpc (record: NpcRecord): Promise<RemoteNpc | null>
{
    const ownerId = await requireUserId();
    const { data, error } = await supabase().from('npcs').select('id, class_id, classes(name)')
        .eq('owner_id', ownerId).eq('game_npc_id', record.id).maybeSingle();
    if (error) throw dbError(error);
    if (!data) return null;
    const cls = (Array.isArray(data.classes) ? data.classes[0] : data.classes) as { name: string } | null;
    return { id: data.id, classId: data.class_id, className: cls?.name ?? record.subject, ownerId };
}

/** Server-confirmed deletion; errors must reach the UI BEFORE the village is changed. */
export async function deleteRemoteNpc (gameNpcId: string, expectedOwnerId: string)
{
    const ownerId = await requireUserId();
    if (ownerId !== expectedOwnerId) throw new TutorApiError('account_changed', 'Your account changed. Refresh before deleting this teacher.');
    const { data, error } = await supabase().from('npcs').select('id').eq('owner_id', ownerId).eq('game_npc_id', gameNpcId).maybeSingle();
    if (error) throw dbError(error);
    return lifecycleDelete(ownerId, data
        ? { action: 'delete', npc_id: data.id, expected_owner_id: expectedOwnerId }
        : { action: 'discard_local', game_npc_id: gameNpcId, expected_owner_id: expectedOwnerId });
}

/** Deletes one server NPC by its stable database id (Delete All, including server-only NPCs). */
export async function deleteRemoteNpcById (npcId: string, expectedOwnerId: string)
{
    const ownerId = await requireUserId();
    if (ownerId !== expectedOwnerId) throw new TutorApiError('account_changed', 'Your account changed. Refresh before deleting this teacher.');
    return lifecycleDelete(ownerId, { action: 'delete', npc_id: npcId, expected_owner_id: expectedOwnerId });
}

async function lifecycleDelete (ownerId: string, body: Record<string, string>)
{
    const result = await invoke<{ deleted: string; owner_id: string; npc_count: number }>('npc-lifecycle', body);
    if (result.owner_id !== ownerId) throw new TutorApiError('account_changed', 'Your account changed. Refresh before deleting this teacher.');
    return result;
}

// ------------------------------------------------------------------ chat

export interface ChatReply
{
    conversationId: string;
    reply: string;
    sources: SourceRef[];
    webSources: WebSourceRef[];
    pages: PageStatus[];
    knowledge: Knowledge;
    webSearch: WebSearchOutcome;
    searchSuggestions: string | null;
    currentTopic: string;
    /** A preference just saved after the student confirmed it, and one now awaiting a yes / no. */
    preference: { saved: string | null; pending: string };
    teachingPreferences: string[];
}

export interface ChatAttachments
{
    /** Sent inline, used for this message only. */
    images?: { mimeType: string; data: string }[];
    /** Already processed coursework documents (private uploads) this message is about. */
    attachmentIds?: string[];
}

export async function sendChat (npc: RemoteNpc, conversationId: string | null, message: string, clientMessageId: string, attachments: ChatAttachments = {}): Promise<ChatReply>
{
    const data = await invoke<{
        conversation_id: string; reply: string; sources: SourceRef[]; web_sources?: WebSourceRef[]; pages?: PageStatus[]; knowledge?: Knowledge;
        web_search?: WebSearchOutcome; search_suggestions?: string | null; preference?: { saved: string | null; pending: string };
        memory: { current_topic: string; teaching_preferences?: string[] };
    }>('npc-chat', {
        npc_id: npc.id, conversation_id: conversationId, message, client_message_id: clientMessageId,
        ...(attachments.images?.length ? { images: attachments.images.map((i) => ({ mime_type: i.mimeType, data: i.data })) } : {}),
        ...(attachments.attachmentIds?.length ? { attachment_ids: attachments.attachmentIds } : {}),
    });
    const sources = data.sources ?? [];
    const webSources = data.web_sources ?? [];
    const pages = data.pages ?? [];
    return {
        conversationId: data.conversation_id, reply: data.reply, sources, webSources, pages,
        knowledge: data.knowledge ?? { coursework: sources.length > 0, webPage: pages.some((p) => p.status === 'read'), search: webSources.length > 0, general: false },
        webSearch: data.web_search ?? 'off', searchSuggestions: data.search_suggestions ?? null,
        currentTopic: data.memory?.current_topic ?? '',
        preference: data.preference ?? { saved: null, pending: '' },
        teachingPreferences: data.memory?.teaching_preferences ?? [],
    };
}

// ------------------------------------------------------------------ teaching preferences

/** The student's saved teaching preferences for this NPC (their own memory row, via RLS). */
export async function loadTeachingPreferences (npc: RemoteNpc): Promise<{ saved: string[]; pending: string }>
{
    const { data, error } = await supabase().from('npc_memories').select('learning_preferences, pending_preference').eq('npc_id', npc.id).maybeSingle();
    if (error) throw dbError(error);
    return { saved: data?.learning_preferences ?? [], pending: data?.pending_preference ?? '' };
}

/** Forgets one saved preference, or all of them (null). Returns what is still saved. */
export async function forgetTeachingPreference (npc: RemoteNpc, preference: string | null): Promise<string[]>
{
    await requireUserId();
    const { data, error } = await supabase().rpc('forget_teaching_preference', { p_npc_id: npc.id, p_preference: preference });
    if (error) throw dbError(error);
    return (data as string[] | null) ?? [];
}

export async function listConversations (npc: RemoteNpc): Promise<ConversationSummary[]>
{
    const { data, error } = await supabase().from('conversations')
        .select('id, channel, created_at, updated_at, messages(content, role, created_at)')
        .eq('npc_id', npc.id)
        .order('updated_at', { ascending: false })
        .order('created_at', { referencedTable: 'messages', ascending: true })
        .limit(1, { referencedTable: 'messages' })
        .limit(20);
    if (error) throw dbError(error);
    return (data ?? []).map((c) => ({
        id: c.id, channel: c.channel, createdAt: c.created_at, updatedAt: c.updated_at,
        preview: (c.messages as { content: string }[] | null)?.[0]?.content ?? '',
    }));
}

export async function loadMessages (conversationId: string): Promise<ChatMessage[]>
{
    const { data, error } = await supabase().from('messages')
        .select('role, content, source_refs, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(60);
    if (error) throw dbError(error);
    return (data ?? []).reverse().map((m) =>
    {
        const refs: (SourceRef | WebSourceRef | WebPageRef)[] = Array.isArray(m.source_refs) ? m.source_refs : [];
        return {
            role: m.role, content: m.content, createdAt: m.created_at,
            sources: refs.filter((r): r is SourceRef => r.kind !== 'web' && r.kind !== 'page'),
            webSources: refs.filter((r): r is WebSourceRef => r.kind === 'web'),
            pageSources: refs.filter((r): r is WebPageRef => r.kind === 'page'),
        };
    });
}

export async function loadLearningState (npc: RemoteNpc): Promise<LearningState>
{
    const db = supabase();
    const [memory, progress] = await Promise.all([
        db.from('npc_memories').select('current_topic, summary').eq('npc_id', npc.id).maybeSingle(),
        db.from('class_progress').select('topics_mastered, topics_needing_practice').eq('class_id', npc.classId).maybeSingle(),
    ]);
    if (memory.error) throw dbError(memory.error);
    if (progress.error) throw dbError(progress.error);
    return {
        currentTopic: memory.data?.current_topic ?? '',
        summary: memory.data?.summary ?? '',
        topicsMastered: progress.data?.topics_mastered ?? [],
        topicsNeedingPractice: progress.data?.topics_needing_practice ?? [],
    };
}

// ------------------------------------------------------------------ class materials

const DOCUMENT_FIELDS = 'id, title, topic, chapter, file_type, visibility, processing_status, processing_error, chunk_count, extraction, uploaded_by, created_at';

type DocumentRowData = {
    id: string; title: string; file_type: string; visibility: DocumentVisibility; processing_status: DocumentStatus;
    processing_error: string | null; chunk_count: number; uploaded_by: string; created_at: string;
    topic?: string; chapter?: string; extraction?: { needs_review?: boolean; uncertain?: string[]; kind?: string; url?: string } | null;
};

const toMaterial = (d: DocumentRowData, userId: string): MaterialRow => ({
    id: d.id, title: d.title, fileType: d.file_type, visibility: d.visibility, status: d.processing_status,
    error: d.processing_error, chunkCount: d.chunk_count, mine: d.uploaded_by === userId, createdAt: d.created_at,
    topic: d.topic ?? '', chapter: d.chapter ?? '', isImage: isImageType(d.file_type),
    needsReview: d.extraction?.needs_review === true, uncertain: d.extraction?.uncertain ?? [],
    sourceUrl: d.extraction?.kind === 'website' && typeof d.extraction.url === 'string' ? d.extraction.url : null,
});

/** Class material for this NPC plus the player's own private uploads to it (RLS hides others'). */
export async function listMaterials (npc: RemoteNpc): Promise<MaterialRow[]>
{
    const userId = await requireUserId();
    const { data, error } = await supabase().from('class_documents').select(DOCUMENT_FIELDS)
        .eq('class_id', npc.classId)
        .or(`npc_id.is.null,npc_id.eq.${npc.id}`)
        .order('created_at', { ascending: false });
    if (error) throw dbError(error);
    return (data ?? []).map((d) => toMaterial(d as DocumentRowData, userId));
}

export type UploadPhase = 'uploading' | 'processing';

/** Validates, uploads (with progress) and processes one document. Resolves with its final state. */
export async function uploadDocument (
    npc: RemoteNpc, file: File, visibility: DocumentVisibility,
    onPhase: (phase: UploadPhase, progress: number) => void,
    meta: CourseworkMeta = {},
): Promise<MaterialRow>
{
    const check = checkUpload(file.name, file.type, file.size);
    if (!check.ok) throw new TutorApiError('invalid_file', check.error);
    const userId = await requireUserId();

    const created = await invoke<{ document: DocumentRowData; upload: { url: string; mime: string } }>('class-documents', {
        action: 'create', npc_id: npc.id, visibility, file_name: file.name, mime_type: check.mime, size_bytes: file.size, ...meta,
    });
    onPhase('uploading', 0);
    try
    {
        await putWithProgress(created.upload.url, file, created.upload.mime, (p) => onPhase('uploading', p));
    }
    catch (err)
    {
        await invoke('class-documents', { action: 'delete', document_id: created.document.id }).catch(() => undefined);
        throw err;
    }
    onPhase('processing', 1);
    const processed = await invoke<{ document: DocumentRowData }>('class-documents', { action: 'process', document_id: created.document.id });
    return toMaterial(processed.document, userId);
}

export async function deleteDocument (documentId: string)
{
    await invoke('class-documents', { action: 'delete', document_id: documentId });
}

/** Saves pasted notes as a coursework document (stored + processed like an upload). */
export async function pasteCoursework (npc: RemoteNpc, title: string, text: string, visibility: DocumentVisibility, meta: CourseworkMeta = {}): Promise<MaterialRow>
{
    const userId = await requireUserId();
    const data = await invoke<{ document: DocumentRowData }>('class-documents', { action: 'paste', npc_id: npc.id, visibility, title, text, ...meta });
    return toMaterial(data.document, userId);
}

/**
 * Adds a public website as coursework. The server reads it once and saves study notes; it
 * throws (and saves nothing) if the page could not be read.
 */
export async function addWebsite (npc: RemoteNpc, url: string, visibility: DocumentVisibility, meta: { title?: string } & CourseworkMeta = {}): Promise<MaterialRow>
{
    const userId = await requireUserId();
    const data = await invoke<{ document: DocumentRowData }>('class-documents', { action: 'website', npc_id: npc.id, visibility, url, ...meta });
    return toMaterial(data.document, userId);
}

/** Rename / organise (title, topic, chapter). */
export async function updateDocument (documentId: string, fields: { title?: string } & CourseworkMeta): Promise<MaterialRow>
{
    const userId = await requireUserId();
    const data = await invoke<{ document: DocumentRowData }>('class-documents', { action: 'update', document_id: documentId, ...fields });
    return toMaterial(data.document, userId);
}

export interface DocumentPreview
{
    row: MaterialRow;
    /** Short-lived signed URL of the original file (private bucket). */
    url: string | null;
    text: string;
    canEdit: boolean;
}

export async function viewDocument (documentId: string): Promise<DocumentPreview>
{
    const userId = await requireUserId();
    const data = await invoke<{ document: DocumentRowData; url: string | null; text: string; can_edit: boolean }>('class-documents', { action: 'view', document_id: documentId });
    return { row: toMaterial(data.document, userId), url: data.url, text: data.text, canEdit: data.can_edit };
}

/** Replaces the extracted text (e.g. to fix a flagged image transcription). */
export async function correctDocument (documentId: string, text: string): Promise<MaterialRow>
{
    const userId = await requireUserId();
    const data = await invoke<{ document: DocumentRowData }>('class-documents', { action: 'correct', document_id: documentId, text });
    return toMaterial(data.document, userId);
}

/** PUT to the one-time signed Storage URL. XHR (not fetch) so upload progress is visible. */
function putWithProgress (url: string, file: File, mime: string, onProgress: (fraction: number) => void)
{
    return new Promise<void>((resolve, reject) =>
    {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url);
        xhr.setRequestHeader('Content-Type', mime);
        xhr.setRequestHeader('x-upsert', 'false');
        xhr.setRequestHeader('apikey', publicConfig.publishableKey);
        xhr.upload.addEventListener('progress', (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); });
        xhr.addEventListener('load', () =>
        {
            if (xhr.status >= 200 && xhr.status < 300) return resolve();
            let message = `Upload failed (${xhr.status}).`;
            try { message = JSON.parse(xhr.responseText)?.message ?? message; }
            catch { /* keep default */ }
            reject(new TutorApiError('upload_failed', message, xhr.status >= 500));
        });
        xhr.addEventListener('error', () => reject(new TutorApiError('network', 'The upload was interrupted. Check your connection.', true)));
        xhr.send(file);
    });
}

// ------------------------------------------------------------------ FaceTime Tutor (LiveKit voice)

export interface VoiceCall
{
    room: string;
    serverUrl: string;
    /** Join-only token for this one room (short-lived). */
    token: string;
    npcName: string;
}

/**
 * Asks the server for a voice call with this NPC. The server authorises the student for the
 * NPC, creates the single-use pairing and dispatches the tutor agent; the browser only gets
 * a join token (never the pairing id or any LiveKit secret).
 */
/** The browser's IANA timezone, so the tutor speaks deadlines in the student's local time. */
function browserTimezone (): string | undefined
{
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; }
    catch { return undefined; }
}

export async function startVoiceCall (npc: RemoteNpc): Promise<VoiceCall>
{
    await requireUserId();
    const data = await invoke<{ room: string; server_url: string; token: string; npc: { name: string } }>('voice-session', { action: 'start', npc_id: npc.id, timezone: browserTimezone() });
    return { room: data.room, serverUrl: data.server_url, token: data.token, npcName: data.npc.name };
}

export interface FaceTimePairing
{
    /** Say this on the call: the shared line's agent asks for it before it knows who you are. */
    code: string;
    expiresAt: number;
    /** The real Chert line address, from the server's configuration (never made up in the game). */
    line: string;
    lineBusy: boolean;
    npcName: string;
}

/** A single-use code for calling this teacher on the shared Chert FaceTime line. Creates no NPC. */
export async function startFaceTimeCall (npc: RemoteNpc): Promise<FaceTimePairing>
{
    await requireUserId();
    const data = await invoke<{ code: string; expires_at: string; line: string; line_busy: boolean; npc: { name: string } }>('voice-session', { action: 'start', npc_id: npc.id, mode: 'facetime', timezone: browserTimezone() });
    return { code: data.code, expiresAt: Date.parse(data.expires_at), line: data.line, lineBusy: data.line_busy, npcName: data.npc.name };
}
