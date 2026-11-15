// FaceTime Tutor (LiveKit voice): the pure pieces shared by the voice-session (game) and
// voice-agent (LiveKit agent) Edge Functions. No SDK imports, unit-tested with node --test.
//
// Trust model: the game never chooses the player (JWT) and its npc_id is only a request that
// the server authorises. The agent never sees a player or NPC id from the browser: it gets an
// opaque pairing id as dispatch metadata and trades it ONCE, with a server-side shared secret,
// for the context of the session the server created.

import { isUuid, type Parsed } from './validation.ts';
import { validTimeZone } from './schedule.ts';
import { mergeLearning, subjectFocus, type MaterialStatus, type RetrievedChunk, type TutorMemory, type TutorNpc, type TutorProgress } from './tutorPrompt.ts';

/** The deployed LiveKit Cloud agent (explicit dispatch by name). */
export const VOICE_AGENT_NAME = 'eduroam-tutor';

/**
 * Which agent server receives dispatches: the Supabase secret VOICE_AGENT_NAME when set (for example
 * the custom Python agent self-hosted as "eduroam-tutor-code" while the Agent Builder deployment keeps
 * "eduroam-tutor"), else VOICE_AGENT_NAME. Unset the secret to go back.
 */
export function voiceAgentName (configured: string | undefined)
{
    const name = configured?.trim() ?? '';
    return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : VOICE_AGENT_NAME;
}
/** The agent must claim the pairing within this time after the student starts the call. */
export const PAIRING_TTL_SECONDS = 120;
/** A claimed session accepts tool calls / the end summary for at most this long. */
export const SESSION_MAX_SECONDS = 2 * 60 * 60;
/** The student's join token: only long enough to connect. */
export const JOIN_TOKEN_TTL = '10m';
/** The agent's participant identity in every room (Chert's bridge must name it exactly). */
export const AGENT_IDENTITY = 'eduroam-tutor';
/** A FaceTime pairing code is valid this long after the student asks for it. */
export const FACETIME_CODE_TTL_SECONDS = 300;
/** Chert's bridge token: Chert requires exp - nbf <= 7200 s. */
export const BRIDGE_TOKEN_SECONDS = 2 * 60 * 60;

export const LIMITS = { query: 300, summary: 1500, topic: 120, topics: 10 } as const;

/** LiveKit server API wants https://; LIVEKIT_URL is usually the wss:// URL clients use. */
export function livekitHttpUrl (url: string)
{
    return url.trim().replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
}

// eslint-disable-next-line no-control-regex
const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Game -> voice-session. mode "browser" = call in the game (LiveKit); "facetime" = a code for the shared Chert line. */
export function parseVoiceStart (body: unknown): Parsed<{ npcId: string; mode: 'browser' | 'facetime'; timezone: string | null }>
{
    const r = body && typeof body === 'object' ? body as Record<string, unknown> : null;
    if (!r || r.action !== 'start') return { ok: false, error: 'action must be "start".' };
    if (!isUuid(r.npc_id)) return { ok: false, error: 'npc_id must be a UUID.' };
    if (r.mode !== undefined && r.mode !== 'browser' && r.mode !== 'facetime') return { ok: false, error: 'mode must be "browser" or "facetime".' };
    // The browser's IANA timezone (deadlines are spoken in the student's local time); invalid = ignored.
    return { ok: true, value: { npcId: r.npc_id.toLowerCase(), mode: r.mode === 'facetime' ? 'facetime' : 'browser', timezone: validTimeZone(r.timezone) } };
}

export type AgentRequest =
    | { action: 'resolve'; pairingId: string }
    | { action: 'pair'; callId: string; code: string }
    | { action: 'search'; pairingId: string; query: string }
    | { action: 'progress'; pairingId: string }
    | { action: 'end'; pairingId: string; summary: string; topics: string[] }
    | { action: 'call_ended'; callId: string }
    | { action: 'memory_search'; pairingId: string; query: string }
    | { action: 'memory_save'; pairingId: string; summary: string; topics: string[]; mastered: string[]; needsPractice: string[]; preference: string }
    | { action: 'assignments'; pairingId: string }
    | { action: 'assignment_save'; pairingId: string; assignmentId: string | null; title?: string; description?: string; due?: string; studentConfirmedDue: boolean; status?: 'todo' | 'in_progress' | 'done'; estimatedMinutes?: number }
    | { action: 'tasks'; pairingId: string; op: 'list' | 'create' | 'update'; taskId: string | null; assignmentId: string | null; title?: string; starts?: string; minutes?: number; status?: 'planned' | 'done' | 'skipped' | 'cancelled'; studentApproved: boolean }
    | { action: 'study_plan'; pairingId: string; dailyMinutes?: number; startHour?: number; days?: number }
    | { action: 'web'; pairingId: string; query: string };

/** Optional integer within [min, max]; undefined if absent; null if present but invalid. */
function intIn (value: unknown, min: number, max: number): number | undefined | null
{
    if (value === undefined || value === null || value === '') return undefined;
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : null;
}
const topicList = (value: unknown) => (Array.isArray(value) ? value : []).map((t) => clean(t, LIMITS.topic)).filter(Boolean).slice(0, LIMITS.topics);
const optionalText = (value: unknown, max: number) => (value === undefined || value === null ? undefined : clean(value, max));
const optionalUuid = (value: unknown): string | null | false => (value === undefined || value === null || value === '' ? null : isUuid(value) ? value.toLowerCase() : false);

/** LiveKit agent -> voice-agent. Only a pairing id identifies the session. */
export function parseAgentRequest (body: unknown): Parsed<AgentRequest>
{
    const r = body && typeof body === 'object' ? body as Record<string, unknown> : null;
    if (!r) return { ok: false, error: 'Expected a JSON object.' };
    // FaceTime calls start without a pairing: they name the call (from dispatch metadata) instead.
    if (r.action === 'pair' || r.action === 'call_ended')
    {
        if (!isUuid(r.call_id)) return { ok: false, error: 'call_id must be the UUID from the dispatch metadata.' };
        const callId = r.call_id.toLowerCase();
        if (r.action === 'call_ended') return { ok: true, value: { action: 'call_ended', callId } };
        const code = normalizeSpokenCode(r.code);
        if (!code) return { ok: false, error: 'code must be the 6 digits shown in EDUROAM.' };
        return { ok: true, value: { action: 'pair', callId, code } };
    }
    if (!isUuid(r.pairing_id)) return { ok: false, error: 'pairing_id must be the UUID from the dispatch metadata.' };
    const pairingId = r.pairing_id.toLowerCase();
    switch (r.action)
    {
        case 'resolve':
            return { ok: true, value: { action: 'resolve', pairingId } };
        case 'search':
        {
            const query = clean(r.query, LIMITS.query);
            if (!query) return { ok: false, error: 'query is empty.' };
            return { ok: true, value: { action: 'search', pairingId, query } };
        }
        case 'progress':
            return { ok: true, value: { action: 'progress', pairingId } };
        case 'assignments':
            return { ok: true, value: { action: 'assignments', pairingId } };
        case 'memory_search':
            return { ok: true, value: { action: 'memory_search', pairingId, query: clean(r.query, LIMITS.query) } };
        case 'memory_save':
        {
            // A learning preference is written only when the student agreed to it in this call.
            const preference = r.preference_confirmed === true ? clean(r.preference, LIMITS.topic) : '';
            const value = { action: 'memory_save' as const, pairingId, summary: clean(r.summary, LIMITS.summary), topics: topicList(r.topics), mastered: topicList(r.mastered), needsPractice: topicList(r.needs_practice), preference };
            if (!value.summary && !value.topics.length && !value.mastered.length && !value.needsPractice.length && !value.preference) return { ok: false, error: 'Nothing to save.' };
            return { ok: true, value };
        }
        case 'web':
        {
            const query = clean(r.query, LIMITS.query);
            if (!query) return { ok: false, error: 'query is empty.' };
            return { ok: true, value: { action: 'web', pairingId, query } };
        }
        case 'assignment_save':
        {
            const assignmentId = optionalUuid(r.assignment_id);
            if (assignmentId === false) return { ok: false, error: 'assignment_id must be a UUID from get_assignments.' };
            const estimatedMinutes = intIn(r.estimated_minutes, 5, 6000);
            if (estimatedMinutes === null) return { ok: false, error: 'estimated_minutes must be a whole number from 5 to 6000.' };
            if (r.status !== undefined && r.status !== null && !['todo', 'in_progress', 'done'].includes(String(r.status))) return { ok: false, error: 'status must be todo, in_progress or done.' };
            return { ok: true, value: {
                action: 'assignment_save', pairingId, assignmentId, title: optionalText(r.title, 160), description: optionalText(r.description, 2000),
                due: optionalText(r.due, 16) || undefined, studentConfirmedDue: r.student_confirmed_due === true,
                status: r.status ? String(r.status) as 'todo' | 'in_progress' | 'done' : undefined, estimatedMinutes,
            } };
        }
        case 'tasks':
        {
            const op = r.op === 'create' || r.op === 'update' ? r.op : r.op === undefined || r.op === 'list' ? 'list' : null;
            if (!op) return { ok: false, error: 'op must be list, create or update.' };
            const taskId = optionalUuid(r.task_id);
            const assignmentId = optionalUuid(r.assignment_id);
            if (taskId === false || assignmentId === false) return { ok: false, error: 'task_id / assignment_id must be UUIDs from earlier results.' };
            if (op === 'update' && !taskId) return { ok: false, error: 'update needs task_id.' };
            const minutes = intIn(r.minutes, 5, 600);
            if (minutes === null) return { ok: false, error: 'minutes must be 5-600.' };
            if (r.status !== undefined && r.status !== null && !['planned', 'done', 'skipped', 'cancelled'].includes(String(r.status))) return { ok: false, error: 'status must be planned, done, skipped or cancelled.' };
            return { ok: true, value: {
                action: 'tasks', pairingId, op, taskId, assignmentId, title: optionalText(r.title, 160), starts: optionalText(r.starts, 16) || undefined, minutes,
                status: r.status ? String(r.status) as 'planned' | 'done' | 'skipped' | 'cancelled' : undefined, studentApproved: r.student_approved === true,
            } };
        }
        case 'study_plan':
        {
            const dailyMinutes = intIn(r.daily_minutes, 15, 240);
            const startHour = intIn(r.start_hour, 6, 22);
            const days = intIn(r.days, 1, 21);
            if (dailyMinutes === null || startHour === null || days === null) return { ok: false, error: 'daily_minutes 15-240, start_hour 6-22, days 1-21.' };
            return { ok: true, value: { action: 'study_plan', pairingId, dailyMinutes, startHour, days } };
        }
        case 'end':
        {
            const topics = (Array.isArray(r.topics) ? r.topics : []).map((t) => clean(t, LIMITS.topic)).filter(Boolean).slice(0, LIMITS.topics);
            return { ok: true, value: { action: 'end', pairingId, summary: clean(r.summary, LIMITS.summary), topics } };
        }
        default:
            return { ok: false, error: 'unknown action.' };
    }
}

// ------------------------------------------------------------------ FaceTime pairing codes

const SPOKEN_DIGITS: Record<string, string> = { zero: '0', oh: '0', o: '0', one: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4', five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9' };

/** "4 8 2-9 1 3", "four eight two nine one three" -> "482913"; anything else -> "". */
export function normalizeSpokenCode (value: unknown): string
{
    if (typeof value !== 'string' || value.length > 80) return '';
    const digits = value.toLowerCase().split(/[\s,.-]+/).filter(Boolean).map((w) => (/^\d+$/.test(w) ? w : SPOKEN_DIGITS[w] ?? 'x')).join('');
    return /^\d{6}$/.test(digits) ? digits : '';
}

/** A uniformly random 6-digit code (rejection sampling, no modulo bias). */
export function newPairingCode (): string
{
    const buf = new Uint32Array(1);
    for (;;)
    {
        crypto.getRandomValues(buf);
        if (buf[0] < 4_294_000_000) return String(buf[0] % 1_000_000).padStart(6, '0');
    }
}

/** What is stored / compared: never the code itself. */
export async function hashPairingCode (code: string): Promise<string>
{
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`eduroam-facetime:${code}`)));
    return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ LiveKit tokens (HS256, explicit nbf/exp)

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64json = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * A room-scoped LiveKit access token with integer nbf/exp (Chert's bridge requires them and
 * exp - nbf <= 7200). Grants join/publish/subscribe to exactly one room.
 */
export async function mintRoomToken (opts: { apiKey: string; apiSecret: string; identity: string; name?: string; room: string; seconds: number; now?: number })
{
    const nbf = Math.floor((opts.now ?? Date.now()) / 1000) - 10;
    const payload = {
        iss: opts.apiKey, sub: opts.identity, name: opts.name ?? opts.identity, nbf, exp: nbf + Math.min(opts.seconds, BRIDGE_TOKEN_SECONDS),
        video: { room: opts.room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false },
    };
    const body = `${b64json({ alg: 'HS256', typ: 'JWT' })}.${b64json(payload)}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(opts.apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    return `${body}.${b64url(signature)}`;
}

// ------------------------------------------------------------------ Chert webhook events

export type ChertEvent =
    | { kind: 'incoming'; eventId: string; callId: string; lineId: string | null }
    | { kind: 'ended'; callId: string }
    | { kind: 'other'; type: string };

/** Parses Chert's call webhooks (documented shape: { event_id, type, data: { call_id, line_id, ... } }). */
export function parseChertEvent (body: unknown): Parsed<ChertEvent>
{
    const r = body && typeof body === 'object' ? body as Record<string, unknown> : null;
    const type = typeof r?.type === 'string' ? r.type : '';
    if (!r || !type) return { ok: false, error: 'Expected a Chert event with a type.' };
    const data = r.data && typeof r.data === 'object' ? r.data as Record<string, unknown> : {};
    const callId = typeof data.call_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.call_id) ? data.call_id : '';
    if (type === 'call.incoming')
    {
        if (!callId) return { ok: false, error: 'call.incoming without a valid data.call_id.' };
        const lineId = typeof data.line_id === 'string' && data.line_id.length <= 128 ? data.line_id : null;
        return { ok: true, value: { kind: 'incoming', eventId: typeof r.event_id === 'string' ? r.event_id.slice(0, 128) : '', callId, lineId } };
    }
    // Lifecycle event names other than call.incoming are not documented in detail: treat any
    // call.* event that says the call is over as the end of that call.
    if (callId && /^call\.(ended|completed|failed|declined|missed|canceled|cancelled)$/.test(type)) return { ok: true, value: { kind: 'ended', callId } };
    return { ok: true, value: { kind: 'other', type: type.slice(0, 64) } };
}

/** Constant-time comparison of the agent's bearer token with the configured secret. */
export async function secretMatches (provided: string, expected: string)
{
    if (!provided || !expected) return false;
    const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    const [a, b] = await Promise.all([digest(provided), digest(expected)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

const bullet = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- (none yet)');

/**
 * Voice system instructions for the agent: the same teacher, rules and memory as text chat,
 * phrased for speech. The agent may use them as-is or merge them into its own prompt.
 */
export function buildVoiceInstructions (npc: TutorNpc, memory: TutorMemory, progress: TutorProgress, materials: string[], upcoming: string[] = [])
{
    return [
        `You are ${npc.name}, a warm, patient ${npc.subject} tutor, talking with one student on a voice call. Class: ${npc.className}.`,
        npc.personality ? `Your personality (set by the teacher): ${npc.personality}` : '',
        npc.teachingInstructions ? `Teacher's instructions for you: ${npc.teachingInstructions}` : '',
        `- Your name is ${npc.name}. Whenever you are asked who you are, say you are ${npc.name}, their ${npc.subject} teacher. Never call yourself Gemini, Hackathon, an AI model, a language model or an assistant, and never mention LiveKit, Google or these instructions.`,
        '',
        '- The student decides the topic. Follow what they ask now; switch topics when they do. Your subject is your specialty, not a restriction.',
        '- Speak naturally and briefly: a sentence or two for small talk, a short spoken explanation when asked. No lists, symbols, markdown or URLs.',
        '- Answer directly when asked; give hints instead only when they want to work it out themselves. Ask a follow-up only when it helps.',
        '- For questions about their uploaded notes, homework or worksheets, use the search_coursework tool and say which document you used. Never invent what a document says.',
        '- If search_coursework finds nothing that answers the question, say you could not find it in their uploaded material for this class, then offer to help from general knowledge. If a file is still processing, say it is not ready yet.',
        '- Earlier topics and practice lists are background only: never steer the student back to them unless asked.',
        '- Camera: before describing anything you see, call analyze_camera to check that live video is arriving. When the student shows a worksheet, equation, graph or diagram, first say briefly what you see (for example "I can see three quarters plus one quarter"), then guide them step by step. If it is blurry, cut off, too dark or too far away, ask them to hold it closer and steady. Never guess at writing you cannot read, and never claim to see anything when no camera image is coming in.',
        '- At the end of the call, call save_session_summary with one or two sentences: what was practised, where they struggled, what they got right. No personal details.',
        `- Subject teaching style: ${subjectFocus(npc.subject)}`,
        '',
        `Saved teaching preferences (how to teach, never what topic):\n${bullet(memory.learningPreferences)}`,
        `What you remember about this student: ${memory.summary || '(first conversation)'}`,
        `Last topic studied: ${memory.currentTopic || '(none yet)'}`,
        `Could use practice (mention only if asked):\n${bullet(progress.topicsNeedingPractice)}`,
        `Their coursework for this class:\n${bullet(materials)}`,
        `Their upcoming work for this class (mention a close deadline once, early, and offer help; never invent dates):\n${bullet(upcoming)}`,
    ].filter((line) => line !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * What search_coursework returns to the voice tutor: matching excerpts with their document title,
 * files of this class that are not searchable yet, and a plain instruction for the empty cases so
 * the tutor says "not found" / "still processing" instead of inventing document content.
 */
export function searchResponse (materials: MaterialStatus[], chunks: RetrievedChunk[])
{
    const notReady = materials.filter((m) => m.status !== 'ready').map((m) => ({ title: m.title, status: m.status }));
    const ready = materials.some((m) => m.status === 'ready');
    const note = chunks.length
        ? 'Answer only from these excerpts and name the document you used. If none of them answers the question, say it is not in their uploaded material.'
        : ready
            ? 'Nothing in the uploaded material for this class matches. Tell the student you could not find it in their notes.'
            : notReady.length
                ? 'Their files for this class are still being processed. Tell the student they are not ready yet.'
                : 'No coursework has been uploaded for this class yet. Tell the student there is nothing uploaded to look at.';
    return {
        results: chunks.map((c) => ({ title: c.title, text: c.text, page: c.pageStart ?? null, mine: c.visibility === 'private' })),
        not_ready: notReady,
        note,
    };
}

// ------------------------------------------------------------------ LiveKit Builder metadata

/** Per-field caps (characters) for the Builder agent's dispatch metadata; the whole JSON stays small. */
export const BUILDER_LIMITS = { npc_name: 80, subject: 120, personality: 600, teaching_style: 800, coursework: 2000, learning_memory: 1200 } as const;
export type BuilderMetadata = Record<keyof typeof BUILDER_LIMITS, string>;

const cap = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const list = (items: string[], max = 6) => items.map((item) => clean(item, 80)).filter(Boolean).slice(0, max).join(', ');

/**
 * The six fields the hosted Agent Builder agent "eduroam-tutor" registers as metadata variables
 * ({{metadata.npc_name}} ...), filled from THIS student's authorised Supabase data: the NPC, its
 * class material (titles + short excerpts, the student's own private uploads included) and the
 * student's own memory/progress with that NPC. No ids, tokens or other students' data.
 */
export function builderMetadata (npc: TutorNpc, memory: TutorMemory, progress: TutorProgress, materials: MaterialStatus[], chunks: RetrievedChunk[]): BuilderMetadata
{
    const subject = clean(npc.subject, BUILDER_LIMITS.subject) || clean(npc.className, BUILDER_LIMITS.subject) || 'General studies';
    const name = clean(npc.name, BUILDER_LIMITS.npc_name) || 'your EDUROAM teacher';

    const documents = materials.slice(0, 8).map((m) => (m.status === 'ready' ? clean(m.title, 80) : `${clean(m.title, 80)} (still processing, not readable yet)`));
    const excerpts = chunks.slice(0, 3).map((c) => `[${clean(c.title, 80)}${c.pageStart ? `, p. ${c.pageStart}` : ''}] ${clean(c.text, 320)}`);
    const coursework = documents.length
        ? [`Class: ${clean(npc.className, 80) || subject}.`, `Documents: ${documents.join('; ')}.`, excerpts.length ? `Excerpts: ${excerpts.join(' ')}` : 'No readable excerpts yet.',
            'Only quote what these excerpts say; name the document you use; never invent document contents.'].join(' ')
        : `Class: ${clean(npc.className, 80) || subject}. No coursework has been uploaded for this class yet. Do not invent document contents; teach from general ${subject} knowledge.`;

    const parts = [
        memory.summary && `Summary: ${clean(memory.summary, 500)}`,
        memory.currentTopic && `Current topic: ${clean(memory.currentTopic, 120)}`,
        memory.topicsStudied.length && `Topics studied: ${list(memory.topicsStudied)}`,
        progress.topicsMastered.length && `Strengths: ${list(progress.topicsMastered)}`,
        progress.topicsNeedingPractice.length && `Needs practice (mention only if asked): ${list(progress.topicsNeedingPractice)}`,
        memory.learningPreferences.length && `How they like to learn: ${list(memory.learningPreferences, 5)}`,
    ].filter(Boolean) as string[];

    return {
        npc_name: name,
        subject,
        personality: cap(clean(npc.personality, 2000) || `A warm, patient, encouraging ${subject} teacher.`, BUILDER_LIMITS.personality),
        teaching_style: cap(clean(npc.teachingInstructions, 2000)
            || `Explain step by step in short spoken sentences, check understanding with a quick question, and give hints before full answers. ${subjectFocus(npc.subject)}`, BUILDER_LIMITS.teaching_style),
        coursework: cap(coursework, BUILDER_LIMITS.coursework),
        learning_memory: cap(parts.length ? `${parts.join('. ')}.` : 'First conversation with this student: no saved memory yet.', BUILDER_LIMITS.learning_memory),
    };
}

/**
 * Dispatch metadata for the configured agent: the hosted Builder agent (default name) gets the
 * six JSON fields; any other agent name (the self-hosted Python worker, e.g. "eduroam-tutor-code")
 * keeps the original opaque pairing id, which it trades at voice-agent.
 */
export function usesBuilderMetadata (agentName: string)
{
    return agentName === VOICE_AGENT_NAME;
}

/**
 * The end-of-call learning summary merged into the student's NPC memory (the same merge text
 * chat uses): a non-empty summary replaces the old one, topics are added, preferences kept.
 */
export function memoryAfterCall (memory: TutorMemory, progress: TutorProgress, summary: string, topics: string[])
{
    return mergeLearning(memory, progress, {
        summary, currentTopic: topics[0] ?? '', topicsStudied: topics, topicsMastered: [], topicsNeedingPractice: [],
    }).memory;
}
