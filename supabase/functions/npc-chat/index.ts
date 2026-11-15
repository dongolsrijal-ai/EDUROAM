// POST /functions/v1/npc-chat  { npc_id, conversation_id?, message, client_message_id?, images?, attachment_ids? }
//
// 1. authenticate the player (JWT)   3. verify access to the NPC (class owner or member)
// 2. validate + rate-limit           4. runTutorTurn (shared with future voice channels):
//                                       memory, history, coursework retrieval, optional Google
//                                       Search, Gemini (server-side key), save turn atomically
// 5. return reply + verified coursework refs + web sources from grounding metadata

import { GoogleGenAI } from 'npm:@google/genai@3.3.0';
import { TutorModelError } from '../_shared/gemini.ts';
import { adminClient, authenticate, HttpError, json, rateLimit, readJson, serve } from '../_shared/http.ts';
import { resolveNpcIdentity } from '../_shared/npcContext.ts';
import { runTutorTurn } from '../_shared/tutorService.ts';
import { parseChatRequest } from '../_shared/validation.ts';
import { matchesSignature } from '../_shared/textProcessing.ts';

/** True if the base64 data starts like a PNG / JPEG / WEBP / HEIC file (checked on the first bytes). */
function matchesImage (base64: string)
{
    const head = Uint8Array.from(atob(base64.slice(0, 64)), (c) => c.charCodeAt(0));
    return (['png', 'jpeg', 'webp', 'heic'] as const).some((type) => matchesSignature(type, head));
}

const CHANNEL = 'game' as const;
let gemini: GoogleGenAI | null = null;

serve(async (req) =>
{
    const admin = adminClient();
    const { userId, db } = await authenticate(req, admin);

    // Up to ~5 MB image attachments arrive base64-encoded in the body.
    const parsed = parseChatRequest(await readJson(req, 7_200_000));
    if (!parsed.ok) throw new HttpError(400, 'bad_request', parsed.error);
    const { npcId, conversationId, message, clientMessageId, images, attachmentIds } = parsed.value;
    if (images.some((image) => !matchesImage(image.data)))
    {
        throw new HttpError(400, 'bad_request', 'The attached file is not a valid image.');
    }

    await rateLimit(admin, userId, 'npc-chat:minute', 12, 60);
    await rateLimit(admin, userId, 'npc-chat:day', 400, 86_400);

    // Authorise the NPC first, so a wrong/foreign NPC is always a 404 regardless of AI config.
    const npc = await resolveNpcIdentity(db, userId, npcId);

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) throw new HttpError(503, 'ai_not_configured', 'The AI teacher is not set up yet (GEMINI_API_KEY secret missing).');
    gemini ??= new GoogleGenAI({ apiKey });

    let turn;
    try
    {
        turn = await runTutorTurn({ admin, db, gemini, env: (name) => Deno.env.get(name), resolveDns: (host, type) => Deno.resolveDns(host, type) }, {
            playerId: userId, npc, conversationId, channel: CHANNEL, message, clientMessageId, images, attachmentIds,
        });
    }
    catch (err)
    {
        if (!(err instanceof TutorModelError)) throw err;
        console.error('[npc-chat] gemini error', err.code, err.detail ?? err.message);
        // Nothing is saved for a failed turn, so the student can simply resend.
        return json(err.httpStatus, { error: { code: err.code, message: err.message, retryable: err.retryable } });
    }

    return json(200, {
        conversation_id: turn.conversationId,
        reply: turn.reply,
        sources: turn.sources,
        web_sources: turn.webSources,
        pages: turn.pages,
        knowledge: turn.knowledge,
        web_search: turn.webSearch,
        search_suggestions: turn.searchSuggestions,
        preference: turn.preference,
        memory: { current_topic: turn.memory.currentTopic, teaching_preferences: turn.memory.learningPreferences },
        progress: { topics_mastered: turn.progress.topicsMastered, topics_needing_practice: turn.progress.topicsNeedingPractice },
        materials: turn.materials.map((m) => ({ id: m.id, title: m.title, status: m.status })),
    });
});
