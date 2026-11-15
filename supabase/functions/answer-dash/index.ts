// POST /functions/v1/answer-dash — coursework mini-games (Answer Dash, Spellshot): question
// packs + authoritative grading. The endpoint keeps its first game's name for compatibility.
//
//   { action: 'start', npc_id, source: 'all' | <document id> | <document ids>, game?, choices? }
//       game: 'answer_dash' (default) | 'spellshot'; choices: Spellshot's visible targets (3-5).
//       auth → NPC access → authorised READY documents (class material for this NPC + the
//       caller's own private uploads) → sampled chunks → ONE Gemini call (bounded retry) →
//       strict validation → session stored WITH answer keys → questions returned WITHOUT keys.
//   { action: 'answer', session_id, index, choice }
//       records the first answer per question (idempotent), returns correctness + explanation.
//   { action: 'finish', session_id }
//       grades from stored answers (never from client scores), saves results once, merges
//       weak/mastered topics into class progress and the NPC's memory.

import { GoogleGenAI } from 'npm:@google/genai@3.3.0';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import { DEFAULT_GEMINI_MODEL, generateStructured, thinkingFor, TutorModelError } from '../_shared/gemini.ts';
import { adminClient, authenticate, HttpError, json, rateLimit, readJson, serve } from '../_shared/http.ts';
import { npcDocumentScope, resolveNpcIdentity, retrieveStudentMemory, type NpcIdentity } from '../_shared/npcContext.ts';
import {
    buildPackPrompt, GAMES, gradeSession, PACK_SCHEMA, packHash, parsePack, sampleAcrossDocuments, shuffleChoices,
    toPublic, topicOutcome, type GameType, type PackQuestion, type SourceMode,
} from '../_shared/questionPack.ts';
import { mergeLearning, type RetrievedChunk } from '../_shared/tutorPrompt.ts';
import { isImageDocument, parseDashRequest } from '../_shared/validation.ts';

let gemini: GoogleGenAI | null = null;

serve(async (req) =>
{
    const admin = adminClient();
    const { userId, db } = await authenticate(req, admin);
    const parsed = parseDashRequest(await readJson(req));
    if (!parsed.ok) throw new HttpError(400, 'bad_request', parsed.error);
    const request = parsed.value;

    if (request.action === 'start')
    {
        await rateLimit(admin, userId, 'answer-dash:start', 20, 3600);
        const npc = await resolveNpcIdentity(db, userId, request.npcId);
        return json(200, await startSession(admin, db, userId, npc, request.source, request.game, request.choices));
    }
    if (request.action === 'answer')
    {
        await rateLimit(admin, userId, 'answer-dash:answer', 400, 3600);
        return json(200, await recordAnswer(admin, userId, request.sessionId, request.index, request.choice));
    }
    return json(200, await finishSession(admin, userId, request.sessionId));
});

async function startSession (admin: SupabaseClient, db: SupabaseClient, userId: string, npc: NpcIdentity, source: 'all' | { documentIds: string[] },
    game: GameType, choiceCount: number)
{
    const spec = GAMES[game];
    // Only READY coursework this player may use with THIS NPC (RLS + explicit scope).
    // Questions come exclusively from this library: there is no general-knowledge mode.
    const { data: docs, error } = await db.from('class_documents').select('id, title, file_type, file_path')
        .eq('class_id', npc.classId).eq('processing_status', 'ready').or(npcDocumentScope(npc.id, userId))
        .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;

    const mode: SourceMode = 'documents';
    let documentIds: string[];
    if (source === 'all') documentIds = (docs ?? []).map((d) => d.id);
    else
    {
        const available = new Set((docs ?? []).map((d) => d.id));
        if (!source.documentIds.every((id) => available.has(id))) throw new HttpError(404, 'document_not_found', 'A selected document is not available for this teacher (it may still be processing).');
        documentIds = source.documentIds;
    }
    if (!documentIds.length)
    {
        throw new HttpError(409, 'no_materials', `${spec.label} needs class materials. Add coursework (upload files or paste notes) to this teacher first.`);
    }

    // Batched retrieval: a bounded number of chunks per document, then an even spread across
    // the selection, so large libraries never send everything to Gemini.
    const byId = new Map((docs ?? []).map((d) => [d.id, d]));
    const perDocument = Math.max(4, Math.ceil(240 / documentIds.length));
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < documentIds.length; i += 10)
    {
        const batch = documentIds.slice(i, i + 10);
        const { data, error: chunkError } = await db.from('document_chunks')
            .select('id, document_id, chunk_index, chunk_text, source')
            .in('document_id', batch).lt('chunk_index', perDocument).order('document_id').order('chunk_index').limit(perDocument * batch.length);
        if (chunkError) throw chunkError;
        rows.push(...(data ?? []));
    }
    const chunks: RetrievedChunk[] = sampleAcrossDocuments(rows.map((c) =>
    {
        const doc = byId.get(c.document_id as string);
        return {
            chunkId: c.id as string, documentId: c.document_id as string, title: doc?.title ?? 'Document', visibility: 'class' as const,
            chunkIndex: c.chunk_index as number, text: c.chunk_text as string, pageStart: (c.source as { page_start?: number })?.page_start,
            isImage: isImageDocument(doc?.file_type ?? ''),
        };
    }), 16, 16_000);
    if (!chunks.length) throw new HttpError(409, 'no_materials', 'No readable content was found in the selected materials.');

    // Adapt to recent performance with this NPC and avoid repeating recent questions.
    const [{ data: recent }, { progress }] = await Promise.all([
        admin.from('minigame_sessions').select('questions, correct_count, incorrect_count, status')
            .eq('player_id', userId).eq('npc_id', npc.id).order('created_at', { ascending: false }).limit(3),
        retrieveStudentMemory(db, userId, npc),
    ]);
    const finished = (recent ?? []).filter((s) => s.status === 'completed' && s.correct_count + s.incorrect_count > 0);
    const totals = finished.reduce((t, s) => ({ c: t.c + s.correct_count, n: t.n + s.correct_count + s.incorrect_count }), { c: 0, n: 0 });
    const recentAccuracy = totals.n ? totals.c / totals.n : null;
    const avoid = (recent ?? []).flatMap((s) => (s.questions as PackQuestion[]).map((q) => q.question)).slice(0, 30);

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) throw new HttpError(503, 'ai_not_configured', 'The AI teacher is not set up yet (GEMINI_API_KEY secret missing).');
    gemini ??= new GoogleGenAI({ apiKey });

    // At most three generations; valid questions are pooled (bounded cost). Gemini overload
    // (HTTP 503 "high demand", seen in production logs) gets a backoff and, if a custom
    // GEMINI_MODEL is configured, one try on the default stable model.
    const configured = Deno.env.get('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
    let model = configured;
    const questions: PackQuestion[] = [];
    for (let attempt = 0; attempt < 3 && questions.length < spec.min; attempt++)
    {
        const prompt = buildPackPrompt({
            npc, mode, chunks, count: spec.size, recentAccuracy, weakTopics: progress.topicsNeedingPractice,
            avoidQuestions: [...avoid, ...questions.map((q) => q.question)], game,
        });
        try
        {
            const pack = await generateStructured(gemini, {
                systemInstruction: prompt.systemInstruction, contents: prompt.contents, schema: PACK_SCHEMA,
                parse: (text) => parsePack(text, mode, chunks, [...avoid, ...questions.map((q) => q.question)], game),
            }, { model, timeoutMs: 45_000, maxOutputTokens: game === 'spellshot' ? 9000 : 6000, retries: 0, thinkingLevel: thinkingFor('minigame', Deno.env.get('GEMINI_THINKING')) });
            questions.push(...pack.questions);
        }
        catch (err)
        {
            if (!(err instanceof TutorModelError)) throw err;
            console.error('[answer-dash] gemini error', err.code, model, err.detail ?? err.message);
            if (!err.retryable || attempt === 2)
            {
                if (err.code === 'unavailable' || err.code === 'rate_limited')
                {
                    throw new HttpError(503, err.code, 'The AI teacher is very busy right now. Please try again in a minute.');
                }
                throw new HttpError(err.httpStatus, err.code, err.message);
            }
            if (err.code === 'unavailable' && model !== DEFAULT_GEMINI_MODEL) model = DEFAULT_GEMINI_MODEL;
            await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
        }
    }
    if (questions.length < spec.min)
    {
        throw new HttpError(502, 'bad_pack', 'The teacher could not write enough good questions this time. Please try again.');
    }

    // Spellshot keeps the correct answer + (choices - 1) of its distractors per question.
    const pack = questions.slice(0, spec.size).map((q) => shuffleChoices(q, Math.random, game === 'spellshot' ? choiceCount : q.choices.length));
    const { data: session, error: insertError } = await admin.from('minigame_sessions').insert({
        player_id: userId, npc_id: npc.id, class_id: npc.classId, game_type: game, source_mode: mode,
        source_document_ids: [...new Set(pack.map((q) => q.source?.document_id).filter(Boolean))] as string[],
        pack_hash: packHash(pack), questions: pack,
    }).select('id').single();
    if (insertError) throw insertError;

    // Figures: short-lived signed URLs of the player's authorised images (bucket stays private).
    const figureUrls = new Map<string, string>();
    for (const id of new Set(pack.map((q) => q.figure?.document_id).filter(Boolean) as string[]))
    {
        const doc = byId.get(id);
        const { data } = doc ? await admin.storage.from('class-materials').createSignedUrl(doc.file_path, 1800) : { data: null };
        if (data?.signedUrl) figureUrls.set(id, data.signedUrl);
    }
    return {
        session_id: session.id,
        game,
        mode,
        documents: (docs ?? []).filter((d) => documentIds.includes(d.id)).map((d) => d.title),
        questions: pack.map((q) =>
        {
            const pub = toPublic(q);
            return { ...pub, figure: pub.figure ? { ...pub.figure, url: figureUrls.get(pub.figure.document_id) ?? null } : null };
        }),
    };
}

async function loadSession (admin: SupabaseClient, userId: string, sessionId: string)
{
    const { data, error } = await admin.from('minigame_sessions').select('*').eq('id', sessionId).eq('player_id', userId).maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, 'session_not_found', 'That game session could not be found.');
    return data;
}

async function recordAnswer (admin: SupabaseClient, userId: string, sessionId: string, index: number, choice: number)
{
    const { data: answers, error } = await admin.rpc('record_minigame_answer', {
        p_session_id: sessionId, p_player_id: userId, p_index: index, p_choice: choice,
    });
    if (error) throw error;
    if (!answers) throw new HttpError(404, 'session_not_found', 'That game session could not be found.');
    const session = await loadSession(admin, userId, sessionId);
    const question = (session.questions as PackQuestion[])[index];
    if (!question) throw new HttpError(400, 'bad_request', 'No such question.');
    const stored = (answers as Record<string, number>)[String(index)];
    if (stored === undefined && session.status === 'active') throw new HttpError(400, 'bad_request', 'No such answer choice.');
    if (stored === undefined) throw new HttpError(409, 'session_closed', 'This game session has already finished.');
    return {
        index, choice: stored, correct: stored === question.correctIndex, correct_index: question.correctIndex,
        explanation: question.explanation, source: question.source,
    };
}

function publicResult (s: Record<string, unknown>)
{
    const answered = (s.correct_count as number) + (s.incorrect_count as number);
    const performance = s.topic_performance as Record<string, { correct: number; incorrect: number }>;
    const outcome = topicOutcome(performance);
    return {
        session_id: s.id, score: s.score, correct: s.correct_count, incorrect: s.incorrect_count,
        total: (s.questions as unknown[]).length, answered, accuracy: answered ? (s.correct_count as number) / answered : 0,
        best_streak: s.best_streak, topic_performance: performance, weak_topics: outcome.practice, mastered_topics: outcome.mastered,
    };
}

async function finishSession (admin: SupabaseClient, userId: string, sessionId: string)
{
    const session = await loadSession(admin, userId, sessionId);
    if (session.status === 'completed') return publicResult(session);

    const grade = gradeSession(session.questions as PackQuestion[], session.answers as Record<string, number>, GAMES[session.game_type as GameType].points);
    const { data: closed, error } = await admin.from('minigame_sessions').update({
        status: 'completed', correct_count: grade.correct, incorrect_count: grade.incorrect, score: grade.score,
        best_streak: grade.bestStreak, topic_performance: grade.topicPerformance, completed_at: new Date().toISOString(),
    }).eq('id', sessionId).eq('player_id', userId).eq('status', 'active').select('*');
    if (error) throw error;
    // Another request finished it first: return that saved result (no double counting).
    if (!closed?.length) return publicResult(await loadSession(admin, userId, sessionId));

    await mergeProgress(admin, userId, session.npc_id, session.class_id, grade.topicPerformance);
    return publicResult(closed[0]);
}

/** Adds this session's topics to the NPC memory and class progress without dropping other items. */
async function mergeProgress (admin: SupabaseClient, userId: string, npcId: string, classId: string | null, performance: Record<string, { correct: number; incorrect: number }>)
{
    const outcome = topicOutcome(performance);
    const [memoryRow, progressRow] = await Promise.all([
        admin.from('npc_memories').select('*').eq('player_id', userId).eq('npc_id', npcId).maybeSingle(),
        classId ? admin.from('class_progress').select('*').eq('player_id', userId).eq('class_id', classId).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const merged = mergeLearning(
        {
            summary: memoryRow.data?.summary ?? '', currentTopic: memoryRow.data?.current_topic ?? '',
            topicsStudied: memoryRow.data?.topics_studied ?? [], learningPreferences: memoryRow.data?.learning_preferences ?? [],
        },
        { topicsMastered: progressRow.data?.topics_mastered ?? [], topicsNeedingPractice: progressRow.data?.topics_needing_practice ?? [] },
        { summary: '', currentTopic: '', topicsStudied: Object.keys(performance), learningPreferences: [], topicsMastered: outcome.mastered, topicsNeedingPractice: outcome.practice },
    );
    const writes = [
        admin.from('npc_memories').upsert({
            player_id: userId, npc_id: npcId, summary: merged.memory.summary, current_topic: merged.memory.currentTopic,
            topics_studied: merged.memory.topicsStudied, learning_preferences: merged.memory.learningPreferences,
            channels_used: [...new Set([...(memoryRow.data?.channels_used ?? []), 'game'])], updated_at: new Date().toISOString(),
        }, { onConflict: 'player_id,npc_id' }),
    ];
    if (classId)
    {
        writes.push(admin.from('class_progress').upsert({
            player_id: userId, class_id: classId, topics_mastered: merged.progress.topicsMastered,
            topics_needing_practice: merged.progress.topicsNeedingPractice, last_activity: new Date().toISOString(), updated_at: new Date().toISOString(),
        }, { onConflict: 'player_id,class_id' }));
    }
    for (const { error } of await Promise.all(writes)) if (error) console.error('[answer-dash] progress merge failed', error.message);
}
