// The AI tutor's tools, run by the voice-agent Edge Function for ONE authorised voice session.
// `ctx` comes from a claimed, unexpired voice_sessions row: the student and NPC were authorised by
// voice-session (JWT + class access) and are re-verified there. These functions use the service-role
// client, so every query filters explicitly by ctx.playerId and, for class data, by the NPC's class:
// one student, one teacher, one class. Outputs are short (they are read aloud).

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import { HttpError, withinRateLimit } from './http.ts';
import { npcDocumentScope, retrieveStudentMemory, type NpcIdentity } from './npcContext.ts';
import { assignmentChange, DEFAULT_TIMEZONE, dueLabel, extractDeadlines, formatLocal, parseLocalDue, planStudy, type AssignmentRow } from './schedule.ts';
import { DEFAULT_GEMINI_MODEL, generateStructuredResult, type GenerateContentClient } from './gemini.ts';
import { mergeLearning, webSourcesFrom } from './tutorPrompt.ts';
import { SEARCH_LIMITS } from './tutorService.ts';
import type { AgentRequest } from './voice.ts';

export interface ToolContext
{
    admin: SupabaseClient;
    playerId: string;
    npc: NpcIdentity;
    /** The student's IANA timezone (players.timezone, else UTC). */
    tz: string;
    now: Date;
}

type Req<A extends AgentRequest['action']> = Extract<AgentRequest, { action: A }>;

const fail = (error: { message: string; code?: string } | null) =>
{
    if (!error) return;
    if (error.code === '42501' || error.code === 'P0002') throw new HttpError(403, 'not_allowed', 'That item does not belong to this student and class.');
    throw new Error(error.message);
};
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The student's timezone, falling back to UTC. */
export async function studentTimezone (admin: SupabaseClient, playerId: string): Promise<string>
{
    const { data } = await admin.from('players').select('timezone').eq('id', playerId).maybeSingle();
    return (data?.timezone as string | null) || DEFAULT_TIMEZONE;
}

// ------------------------------------------------------------------ memory

/** Memory with this teacher + progress in its class + matching lines from earlier text chats with it. */
export async function memorySearch (ctx: ToolContext, req: Req<'memory_search'>)
{
    const { memory, progress } = await retrieveStudentMemory(ctx.admin, ctx.playerId, ctx.npc);
    const { data: convs, error } = await ctx.admin.from('conversations').select('id')
        .eq('player_id', ctx.playerId).eq('npc_id', ctx.npc.id).order('updated_at', { ascending: false }).limit(5);
    fail(error);
    let lines: { who: string; text: string; when: string }[] = [];
    if (convs?.length)
    {
        const { data: msgs, error: msgError } = await ctx.admin.from('messages').select('role, content, created_at')
            .in('conversation_id', convs.map((c) => c.id)).neq('role', 'system').order('created_at', { ascending: false }).limit(80);
        fail(msgError);
        const words = req.query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        const matching = (msgs ?? []).filter((m) => !words.length || words.some((w) => String(m.content).toLowerCase().includes(w)));
        lines = matching.slice(0, 6).map((m) => ({ who: m.role === 'player' ? 'student' : 'you', text: clip(String(m.content).replace(/\s+/g, ' '), 240), when: formatLocal(new Date(m.created_at), ctx.tz) }));
    }
    return {
        memory: { summary: memory.summary, current_topic: memory.currentTopic, topics_studied: memory.topicsStudied, how_they_like_to_learn: memory.learningPreferences },
        progress: { mastered: progress.topicsMastered, needs_practice: progress.topicsNeedingPractice },
        earlier_chat: lines,
        note: lines.length ? 'Earlier text-chat lines with you (most recent first).' : req.query ? 'No earlier chat lines match.' : 'No earlier text chats with this student.',
    };
}

/** Mid-call memory update (does not end the session). Same merge as text chat; preferences only if confirmed. */
export async function memorySave (ctx: ToolContext, req: Req<'memory_save'>)
{
    if (!(await withinRateLimit(ctx.admin, ctx.playerId, 'voice-memory:minute', 6, 60))) throw new HttpError(429, 'rate_limited', 'Saved recently; try again in a minute.');
    const { memory, progress } = await retrieveStudentMemory(ctx.admin, ctx.playerId, ctx.npc);
    const next = mergeLearning(memory, progress, {
        summary: req.summary, currentTopic: req.topics[0] ?? '', topicsStudied: req.topics,
        learningPreferences: req.preference ? [req.preference] : [], topicsMastered: req.mastered, topicsNeedingPractice: req.needsPractice,
    });
    const { data: row } = await ctx.admin.from('npc_memories').select('channels_used').eq('player_id', ctx.playerId).eq('npc_id', ctx.npc.id).maybeSingle();
    const now = ctx.now.toISOString();
    const saved = await ctx.admin.from('npc_memories').upsert({
        player_id: ctx.playerId, npc_id: ctx.npc.id, summary: next.memory.summary, current_topic: next.memory.currentTopic,
        topics_studied: next.memory.topicsStudied, learning_preferences: next.memory.learningPreferences,
        channels_used: [...new Set([...(row?.channels_used ?? []), 'voice'])], updated_at: now,
    }, { onConflict: 'player_id,npc_id' });
    fail(saved.error);
    if (req.mastered.length || req.needsPractice.length)
    {
        const prog = await ctx.admin.from('class_progress').upsert({
            player_id: ctx.playerId, class_id: ctx.npc.classId, topics_mastered: next.progress.topicsMastered,
            topics_needing_practice: next.progress.topicsNeedingPractice, last_activity: now, updated_at: now,
        }, { onConflict: 'player_id,class_id' });
        fail(prog.error);
    }
    return { saved: true, remembered: { summary: next.memory.summary, preference_added: Boolean(req.preference) } };
}

// ------------------------------------------------------------------ progress

/** Mastered / weak topics plus recent quiz (mini-game) results with this teacher. */
export async function studentProgress (ctx: ToolContext)
{
    const { memory, progress } = await retrieveStudentMemory(ctx.admin, ctx.playerId, ctx.npc);
    const { data: games, error } = await ctx.admin.from('minigame_sessions')
        .select('score, correct_count, incorrect_count, topic_performance, completed_at')
        .eq('player_id', ctx.playerId).eq('npc_id', ctx.npc.id).eq('status', 'completed').order('completed_at', { ascending: false }).limit(5);
    fail(error);
    const topics = new Map<string, { correct: number; incorrect: number }>();
    for (const g of games ?? [])
    {
        for (const [topic, p] of Object.entries((g.topic_performance ?? {}) as Record<string, { correct?: number; incorrect?: number }>))
        {
            const t = topics.get(topic) ?? { correct: 0, incorrect: 0 };
            t.correct += Number(p?.correct ?? 0);
            t.incorrect += Number(p?.incorrect ?? 0);
            topics.set(topic, t);
        }
    }
    return {
        mastered: progress.topicsMastered, needs_practice: progress.topicsNeedingPractice, last_topic: memory.currentTopic,
        recent_quizzes: (games ?? []).map((g) => ({ when: g.completed_at ? formatLocal(new Date(g.completed_at), ctx.tz) : null, correct: g.correct_count, incorrect: g.incorrect_count, score: g.score })),
        quiz_topics: [...topics].slice(0, 8).map(([topic, p]) => ({ topic, correct: p.correct, incorrect: p.incorrect })),
    };
}

// ------------------------------------------------------------------ assignments

const ASSIGNMENT_COLUMNS = 'id, title, description, due_at, due_timezone, due_status, status, estimated_minutes, source_document_id';

async function classAssignments (ctx: ToolContext)
{
    const { data, error } = await ctx.admin.from('assignments').select(ASSIGNMENT_COLUMNS)
        .eq('player_id', ctx.playerId).eq('class_id', ctx.npc.classId).is('deleted_at', null)
        .order('due_at', { ascending: true, nullsFirst: false }).limit(20);
    fail(error);
    return (data ?? []) as (AssignmentRow & { source_document_id: string | null })[];
}

const describe = (a: AssignmentRow, ctx: ToolContext) => ({
    id: a.id, title: a.title, description: clip(a.description ?? '', 300), status: a.status,
    due: a.due_at ? `${dueLabel(new Date(a.due_at), ctx.now, ctx.tz)}${a.due_status === 'suggested' ? ' (suggested date, not confirmed by the student)' : ''}` : 'no due date',
    estimated_minutes: a.estimated_minutes,
});

/** This class's assignments for this student, plus deadlines found in its uploaded files (suggestions only). */
export async function listAssignments (ctx: ToolContext)
{
    const assignments = await classAssignments(ctx);
    // Deadlines in this class's material the student may read (class files + their own uploads to this NPC).
    const { data: docs, error } = await ctx.admin.from('class_documents').select('id, title')
        .eq('class_id', ctx.npc.classId).eq('processing_status', 'ready').or(npcDocumentScope(ctx.npc.id, ctx.playerId)).limit(30);
    fail(error);
    const suggestions: ReturnType<typeof extractDeadlines> = [];
    if (docs?.length)
    {
        const titles = new Map(docs.map((d) => [d.id, d.title as string]));
        const { data: chunks, error: chunkError } = await ctx.admin.from('document_chunks').select('document_id, chunk_text')
            .eq('class_id', ctx.npc.classId).in('document_id', [...titles.keys()])
            .or('chunk_text.ilike.*due*,chunk_text.ilike.*deadline*,chunk_text.ilike.*submit*').limit(40);
        fail(chunkError);
        const known = new Set(assignments.filter((a) => a.due_at).map((a) => new Date(a.due_at!).toISOString()));
        for (const c of chunks ?? [])
        {
            for (const s of extractDeadlines(String(c.chunk_text), { id: c.document_id, title: titles.get(c.document_id) ?? 'document' }, ctx.now, ctx.tz, 3))
            {
                if (s.dueAt && (known.has(s.dueAt) || new Date(s.dueAt) < ctx.now)) continue;
                if (suggestions.some((x) => x.dueAt === s.dueAt && x.snippet === s.snippet)) continue;
                suggestions.push(s);
            }
            if (suggestions.length >= 6) break;
        }
    }
    return {
        timezone: ctx.tz,
        now: formatLocal(ctx.now, ctx.tz),
        assignments: assignments.map((a) => describe(a, ctx)),
        found_in_documents: suggestions.map((s) => ({
            text: s.snippet, from: s.documentTitle, document_id: s.documentId,
            date: s.dueAt ? `${formatLocal(new Date(s.dueAt), ctx.tz)}${s.hasTime ? '' : ' (no time written: end of day assumed)'}` : 'date unclear',
            due_local: s.dueAt ? toLocalInput(new Date(s.dueAt), ctx.tz) : null,
        })),
        note: 'Deadlines found in documents are only suggestions: read the sentence to the student and save it with save_assignment only after they confirm it.',
    };
}

/** "YYYY-MM-DD HH:MM" in tz (what save_assignment takes back). */
function toLocalInput (instant: Date, tz: string)
{
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(instant).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Create or update one assignment under the tutor's rules (schedule.assignmentChange). */
export async function saveAssignment (ctx: ToolContext, req: Req<'assignment_save'>)
{
    let existing: AssignmentRow | null = null;
    if (req.assignmentId)
    {
        const { data, error } = await ctx.admin.from('assignments').select(ASSIGNMENT_COLUMNS)
            .eq('id', req.assignmentId).eq('player_id', ctx.playerId).eq('class_id', ctx.npc.classId).is('deleted_at', null).maybeSingle();
        fail(error);
        if (!data) throw new HttpError(404, 'assignment_not_found', 'No such assignment for this student in this class.');
        existing = data as AssignmentRow;
    }
    else
    {
        const { count } = await ctx.admin.from('assignments').select('id', { head: true, count: 'exact' }).eq('player_id', ctx.playerId).is('deleted_at', null);
        if ((count ?? 0) >= 200) throw new HttpError(409, 'too_many', 'This student already has 200 assignments.');
    }
    const change = assignmentChange(existing, {
        title: req.title, description: req.description, dueLocal: req.due, studentConfirmedDue: req.studentConfirmedDue,
        status: req.status, estimatedMinutes: req.estimatedMinutes,
    }, ctx.tz);
    if (!change.ok) throw new HttpError(400, 'not_saved', change.error);
    const query = existing
        ? ctx.admin.from('assignments').update(change.fields).eq('id', existing.id).eq('player_id', ctx.playerId)
        : ctx.admin.from('assignments').insert({ ...change.fields, player_id: ctx.playerId, class_id: ctx.npc.classId, npc_id: ctx.npc.id, created_by: 'tutor' });
    const { data, error } = await query.select(ASSIGNMENT_COLUMNS).single();
    fail(error);
    return { saved: true, assignment: describe(data as AssignmentRow, ctx) };
}

// ------------------------------------------------------------------ study tasks + plan

const TASK_COLUMNS = 'id, title, assignment_id, starts_at, duration_minutes, status';

export async function manageTasks (ctx: ToolContext, req: Req<'tasks'>)
{
    const show = (t: { id: string; title: string; assignment_id: string | null; starts_at: string | null; duration_minutes: number; status: string }) => ({
        id: t.id, title: t.title, assignment_id: t.assignment_id, when: t.starts_at ? formatLocal(new Date(t.starts_at), ctx.tz) : 'not scheduled', minutes: t.duration_minutes, status: t.status,
    });
    if (req.op === 'list')
    {
        const { data, error } = await ctx.admin.from('study_tasks').select(TASK_COLUMNS)
            .eq('player_id', ctx.playerId).eq('class_id', ctx.npc.classId).eq('status', 'planned')
            .gte('starts_at', new Date(ctx.now.getTime() - 86_400_000).toISOString()).order('starts_at').limit(20);
        fail(error);
        return { timezone: ctx.tz, tasks: (data ?? []).map(show) };
    }
    const startsAt = req.starts ? parseLocalDue(req.starts, ctx.tz) : null;
    if (req.starts && !startsAt) throw new HttpError(400, 'not_saved', 'starts must be "YYYY-MM-DD HH:MM" in the student\'s timezone.');
    if (req.op === 'create')
    {
        if (!req.studentApproved) throw new HttpError(400, 'needs_approval', 'Ask the student first, then call again with student_approved=true.');
        if (!req.title) throw new HttpError(400, 'not_saved', 'A study task needs a title.');
        const { count } = await ctx.admin.from('study_tasks').select('id', { head: true, count: 'exact' }).eq('player_id', ctx.playerId).eq('status', 'planned');
        if ((count ?? 0) >= 50) throw new HttpError(409, 'too_many', 'This student already has 50 planned study tasks.');
        const { data, error } = await ctx.admin.from('study_tasks').insert({
            player_id: ctx.playerId, class_id: ctx.npc.classId, npc_id: ctx.npc.id, assignment_id: req.assignmentId, title: req.title,
            starts_at: startsAt?.toISOString() ?? null, duration_minutes: req.minutes ?? 30, created_by: 'tutor',
        }).select(TASK_COLUMNS).single();
        fail(error);
        return { saved: true, task: show(data!) };
    }
    const fields: Record<string, unknown> = {};
    if (req.status) fields.status = req.status;
    if (startsAt || req.minutes)
    {
        if (!req.studentApproved) throw new HttpError(400, 'needs_approval', 'Ask the student before moving a study session, then call again with student_approved=true.');
        if (startsAt) fields.starts_at = startsAt.toISOString();
        if (req.minutes) fields.duration_minutes = req.minutes;
    }
    if (!Object.keys(fields).length) throw new HttpError(400, 'not_saved', 'Nothing to change.');
    const { data, error } = await ctx.admin.from('study_tasks').update(fields)
        .eq('id', req.taskId!).eq('player_id', ctx.playerId).eq('class_id', ctx.npc.classId).select(TASK_COLUMNS).maybeSingle();
    fail(error);
    if (!data) throw new HttpError(404, 'task_not_found', 'No such study task for this student in this class.');
    return { saved: true, task: show(data) };
}

/** A proposed plan (nothing saved): deadlines + estimates + weak topics -> study sessions. */
export async function studyPlan (ctx: ToolContext, req: Req<'study_plan'>)
{
    const [assignments, { progress }] = await Promise.all([classAssignments(ctx), retrieveStudentMemory(ctx.admin, ctx.playerId, ctx.npc)]);
    const plan = planStudy({
        now: ctx.now, tz: ctx.tz, dailyMinutes: req.dailyMinutes, startHour: req.startHour, days: req.days, needsPractice: progress.topicsNeedingPractice,
        assignments: assignments.map((a) => ({ id: a.id, title: a.title, dueAt: a.due_at, dueStatus: a.due_status, status: a.status, estimatedMinutes: a.estimated_minutes })),
    });
    return {
        timezone: ctx.tz,
        sessions: plan.sessions.map((s) => ({ title: s.title, assignment_id: s.assignmentId, when: s.startsLocal, starts: toLocalInput(new Date(s.startsAt), ctx.tz), minutes: s.minutes, why: s.reason })),
        warnings: plan.warnings,
        note: 'This is a proposal. Read it briefly; save only the sessions the student agrees to with manage_study_tasks (op=create, student_approved=true).',
    };
}

// ------------------------------------------------------------------ public web (never private data)

const WEB_SCHEMA = { type: 'object', properties: { answer: { type: 'string', maxLength: 1200 } }, required: ['answer'] };

/**
 * Up-to-date PUBLIC information via Gemini + Google Search grounding (the same budget as text
 * chat's web search). Only the query goes out: no coursework, memory or student details. The
 * links are the sources Google returned; without any, the answer is marked unverified.
 */
export async function webSearch (ctx: ToolContext, req: Req<'web'>, gemini: GenerateContentClient | null, model = DEFAULT_GEMINI_MODEL)
{
    if (!gemini) throw new HttpError(503, 'web_unavailable', 'Web search is not set up (GEMINI_API_KEY).');
    const allowed = await withinRateLimit(ctx.admin, ctx.playerId, 'tutor-search:minute', SEARCH_LIMITS.perMinute, 60)
        && await withinRateLimit(ctx.admin, ctx.playerId, 'tutor-search:day', SEARCH_LIMITS.perDay, 86_400);
    if (!allowed) throw new HttpError(429, 'rate_limited', 'Web search limit reached for now.');
    const { output, metadata } = await generateStructuredResult(gemini, {
        systemInstruction: 'Answer the question with current, factual, public information found by Google Search, for a student, in at most 4 short sentences. Say when sources disagree or nothing reliable was found. Return JSON {"answer": "..."}.',
        contents: [{ role: 'user', parts: [{ text: req.query }] }],
        schema: WEB_SCHEMA,
        parse: (text) => { try { const v = JSON.parse(text ?? ''); return typeof v?.answer === 'string' && v.answer.trim() ? { answer: v.answer.trim().slice(0, 1200) } : null; } catch { return null; } },
    }, { model, timeoutMs: 12_000, retries: 0, maxOutputTokens: 600, tools: [{ googleSearch: {} }] });
    const sources = webSourcesFrom(metadata.groundingMetadata, 4).map((w) => ({ title: w.title, url: w.url }));
    return {
        answer: output.answer, sources,
        note: sources.length
            ? 'Public web information, not the student coursework. Name the source when you use it.'
            : 'No web sources came back: say you could not verify this online.',
    };
}
