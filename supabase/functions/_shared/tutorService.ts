// ONE tutoring turn, independent of the channel. npc-chat (game text chat) calls it today; a
// future voice / FaceTime agent calls the same function with a player id its verified channel
// pairing resolved, so every channel shares the same knowledge, search rules, teaching
// preferences and memory. Authentication and NPC authorisation happen BEFORE this is called
// (resolveNpcIdentity); every query here filters by that player.
//
//   memory + history + class knowledge -> links in the message read via URL context (real
//   retrieval status) -> search budget -> thinking level -> Gemini -> verified coursework refs,
//   read pages, Google Search refs (grounding metadata only) -> preference confirmation
//   -> save turn + memory + progress atomically (links are never saved as coursework here)

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import {
    DEFAULT_GEMINI_MODEL, generateTutorTurn, thinkingFor, type GenerateContentClient,
} from './gemini.ts';
import { withinRateLimit } from './http.ts';
import {
    loadAttachments, loadClassKnowledge, retrieveConversationContext, retrieveStudentMemory, saveConversationTurn, type NpcIdentity,
} from './npcContext.ts';
import {
    buildTutorPrompt, mergeLearning, resolveAttachmentRefs, resolvePreference, resolveSourceRefs, webSourcesFrom,
    type Channel, type MaterialStatus, type PageContext, type SourceRef, type TutorMemory, type TutorProgress, type WebPageRef,
    type WebSearchMode, type WebSourceRef,
} from './tutorPrompt.ts';
import { tutoringTask, wantsWebSearch } from './tutorRouting.ts';
import { readWebPage, referencedUrls, websiteNotesText } from './website.ts';

// Google Search budget per student, shared by text chat and the voice tutor (defined in tutorPrompt.ts).
import { SEARCH_LIMITS } from './tutorPrompt.ts';
export { SEARCH_LIMITS };
/** Links read in chat (URL context): bounded the same way. */
export const PAGE_LIMITS = { perMessage: 2, perMinute: 4, perDay: 40 } as const;
/** Output budget for one tutoring turn (the old 1200 truncated long answers / medium thinking). */
export const TUTOR_MAX_OUTPUT_TOKENS = 4096;

export interface TutorDeps
{
    /** Service-role client: writes the turn atomically, counts rate limits. */
    admin: SupabaseClient;
    /** Caller-scoped client (RLS) for reads; a server agent may pass the admin client. */
    db: SupabaseClient;
    gemini: GenerateContentClient;
    /** Server configuration lookup (Deno.env.get). */
    env: (name: string) => string | undefined;
    /** DNS lookup used to refuse links that point at private addresses (Deno.resolveDns). */
    resolveDns: (host: string, type: 'A' | 'AAAA') => Promise<string[]>;
}

export interface TutorTurnRequest
{
    playerId: string;
    npc: NpcIdentity;
    conversationId: string | null;
    channel: Channel;
    message: string;
    clientMessageId: string | null;
    /** Images used for this turn only, never stored. */
    images?: { mimeType: string; data: string }[];
    /** Processed coursework documents attached to this message. */
    attachmentIds?: string[];
}

/** used = grounded web results shown; failed = search attempted / requested but nothing verified. */
export type WebSearchOutcome = 'used' | 'failed' | 'unavailable' | 'off';

export interface TutorTurnResult
{
    conversationId: string;
    reply: string;
    sources: SourceRef[];
    /** Google Search citations. */
    webSources: WebSourceRef[];
    /** Every link the message was about, with its real retrieval status. */
    pages: { url: string; title: string; status: 'read' | 'failed'; reason?: string }[];
    /** Labels: Your files / Class Materials / Web Source (page read) / Google Search (grounding ran) / General Knowledge. */
    knowledge: { attachment: boolean; coursework: boolean; webPage: boolean; search: boolean; general: boolean };
    webSearch: WebSearchOutcome;
    /** Google's Search Suggestions HTML (must be shown with grounded answers), or null. */
    searchSuggestions: string | null;
    memory: TutorMemory;
    progress: TutorProgress;
    materials: MaterialStatus[];
    preference: { saved: string | null; pending: string };
}

export async function runTutorTurn (deps: TutorDeps, request: TutorTurnRequest): Promise<TutorTurnResult>
{
    const { admin, db, gemini, env } = deps;
    const { playerId, npc, conversationId, channel, message } = request;
    const images = request.images ?? [];

    const [{ memory, progress }, history, { materials, chunks }, attachments] = await Promise.all([
        retrieveStudentMemory(db, playerId, npc),
        retrieveConversationContext(db, playerId, npc.id, conversationId, channel),
        loadClassKnowledge(db, playerId, npc, message),
        loadAttachments(db, playerId, npc, request.attachmentIds ?? []),
    ]);

    const pages = await readLinkedPages(deps, playerId, referencedUrls(message, history, PAGE_LIMITS.perMessage));

    // Search only when the message calls for it, and only within the student's budget.
    let webSearch: WebSearchMode = 'off';
    if (wantsWebSearch(message) && env('TUTOR_WEB_SEARCH') !== 'off')
    {
        const allowed = await withinRateLimit(admin, playerId, 'tutor-search:minute', SEARCH_LIMITS.perMinute, 60)
            && await withinRateLimit(admin, playerId, 'tutor-search:day', SEARCH_LIMITS.perDay, 86_400);
        webSearch = allowed ? 'offered' : 'unavailable';
    }

    const prompt = buildTutorPrompt({ npc, memory, progress, materials, chunks, history, message, channel, images, attachments, webSearch, pages });
    const { output, metadata, dropped } = await generateTutorTurn(gemini, prompt, {
        model: env('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL,
        thinkingLevel: thinkingFor(tutoringTask(message, images.length > 0 || attachments.length > 0), env('GEMINI_THINKING')),
        timeoutMs: images.length || attachments.length ? 40_000 : webSearch === 'offered' ? 35_000 : 25_000,
        // Room for a full explanation + the memory JSON, and for thinking (counted in this budget).
        maxOutputTokens: TUTOR_MAX_OUTPUT_TOKENS,
        ...(webSearch === 'offered' ? {
            tools: [{ googleSearch: {} }],
            toolFallbackNote: 'UPDATE: web search failed for this message. Say briefly that you could not verify current information online, then answer from what you know and note it may be out of date. Never claim web verification.',
        } : {}),
    });

    const attachedRefs = resolveAttachmentRefs(output.usedSources, attachments);
    // Files attached to the message are its subject: cited even if the model forgot the label.
    for (const a of attachments) if (a.status === 'ready' && !attachedRefs.some((r) => r.document_id === a.documentId)) attachedRefs.push({ kind: 'document', document_id: a.documentId, title: a.title, chunk_index: 0, attached: true });
    const sources = [...attachedRefs, ...resolveSourceRefs(output.usedSources, chunks).filter((r) => !attachedRefs.some((a) => a.document_id === r.document_id))];
    const searched = webSearch === 'offered' && !dropped.includes('tools');
    const webSources = searched ? webSourcesFrom(metadata.groundingMetadata) : [];
    let outcome: WebSearchOutcome = webSearch === 'offered' ? 'off' : webSearch;
    if (webSearch === 'offered')
    {
        const queried = (metadata.groundingMetadata?.webSearchQueries?.length ?? 0) > 0;
        // The model may decide no search is needed; that is fine and shown as a normal answer.
        if (webSources.length) outcome = 'used';
        else if (!searched || queried) outcome = 'failed';
    }

    // Read pages are the subject of the message: always cited (only ones actually retrieved).
    const pageRefs: WebPageRef[] = pages.filter((p) => p.status === 'read').map((p) => ({ kind: 'page', url: p.url, title: p.title }));

    const preference = resolvePreference(memory.pendingPreference ?? '', output.preference);
    const merged = mergeLearning(memory, progress, { ...output.memory, learningPreferences: preference.saved ? [preference.saved] : [] });
    merged.memory.pendingPreference = preference.pending;

    const savedConversationId = await saveConversationTurn(admin, {
        playerId, npcId: npc.id, conversationId, channel,
        playerMessage: savedMessage(message, images.length, attachments.map((a) => a.title)), clientMessageId: request.clientMessageId,
        reply: output.reply, sources: [...sources, ...pageRefs, ...webSources],
        memory: merged.memory, progress: merged.progress,
    });

    return {
        conversationId: savedConversationId,
        reply: output.reply,
        sources,
        webSources,
        pages: pages.map((p) => ({ url: p.url, title: p.title, status: p.status, ...(p.reason ? { reason: p.reason } : {}) })),
        knowledge: {
            attachment: attachedRefs.length > 0 || images.length > 0, coursework: sources.some((r) => !r.attached),
            webPage: pageRefs.length > 0, search: webSources.length > 0, general: output.generalKnowledge,
        },
        webSearch: outcome,
        searchSuggestions: webSources.length ? metadata.groundingMetadata?.searchEntryPoint?.renderedContent?.slice(0, 20_000) ?? null : null,
        memory: merged.memory,
        progress: merged.progress,
        materials,
        preference,
    };
}

/**
 * Reads the links a message is about (bounded per message / minute / day). Over budget, a
 * link is reported as not read rather than guessed at. Never saves anything.
 */
async function readLinkedPages (deps: TutorDeps, playerId: string, urls: string[]): Promise<PageContext[]>
{
    const out: PageContext[] = [];
    for (const url of urls)
    {
        const allowed = await withinRateLimit(deps.admin, playerId, 'tutor-page:minute', PAGE_LIMITS.perMinute, 60)
            && await withinRateLimit(deps.admin, playerId, 'tutor-page:day', PAGE_LIMITS.perDay, 86_400);
        if (!allowed)
        {
            out.push({ url, status: 'failed', title: url, reason: 'link reading limit reached for now' });
            continue;
        }
        const page = await readWebPage(deps.gemini, url, {
            model: deps.env('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL, timeoutMs: 30_000,
            thinkingLevel: thinkingFor('extraction', deps.env('GEMINI_THINKING')), resolveDns: deps.resolveDns,
        });
        out.push(page.status === 'read'
            ? { url: page.url, status: 'read', title: page.title, text: websiteNotesText(page.notes, page.url, new Date())[0].text }
            : { url: page.url, status: 'failed', title: page.host || page.url, reason: page.reason });
    }
    return out;
}

/** The stored player message notes what was attached (images themselves are never stored). */
function savedMessage (message: string, imageCount: number, files: string[])
{
    const parts = [...(imageCount ? [imageCount === 1 ? 'Image attached' : `${imageCount} images attached`] : []), ...(files.length ? [`Attached: ${files.join(', ')}`] : [])];
    return parts.length ? `[${parts.join(' · ')}] ${message}` : message;
}
