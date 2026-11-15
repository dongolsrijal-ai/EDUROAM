// POST /functions/v1/voice-agent   (called ONLY by the LiveKit agent "eduroam-tutor")
//   Authorization: Bearer <VOICE_AGENT_SECRET>      (shared secret, server-side on both ends)
//
//   resolve  { pairing_id }                 -> claims the pairing ONCE; returns the NPC's name, class,
//                                              teaching preferences, student memory, coursework and
//                                              ready-made voice instructions          (in-game calls)
//   pair     { call_id, code }              -> FaceTime: the 6-digit code the caller said, for this call
//                                              (max 5 tries); on success the same context + pairing_id
//   search   { pairing_id, query }          -> coursework excerpts for THIS student + NPC only
//   progress { pairing_id }                 -> that student's memory + progress with this NPC
//   end      { pairing_id, summary, topics? } -> saves a short learning summary to npc_memories (once)
//   call_ended { call_id }                  -> FaceTime call over: frees the shared line
//
// The pairing id is the only identifier accepted; player and NPC come from the session row the
// voice-session function created after authorising the student. All queries filter by that
// player explicitly (this function uses the service-role client).

import { adminClient, HttpError, json, readJson, serve, withinRateLimit } from '../_shared/http.ts';
import { loadClassKnowledge, resolveNpcIdentity, retrieveStudentMemory } from '../_shared/npcContext.ts';
import { buildVoiceInstructions, hashPairingCode, memoryAfterCall, parseAgentRequest, searchResponse, secretMatches, SESSION_MAX_SECONDS } from '../_shared/voice.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';

/** Everything the agent may know for one authorised student + NPC session. */
async function sessionContext (admin: SupabaseClient, playerId: string, npcId: string, room: string)
{
    // Re-verifies the student may still use this NPC (explicit owner/member check).
    const npc = await resolveNpcIdentity(admin, playerId, npcId);
    const { memory, progress } = await retrieveStudentMemory(admin, playerId, npc);
    // Opening coursework: what they last studied, else the newest material for the subject.
    const knowledge = await loadClassKnowledge(admin, playerId, npc, memory.currentTopic || npc.subject, 4);
    const materials = knowledge.materials.map((m) => (m.status === 'ready' ? m.title : `${m.title} (${m.status}, not searchable yet)`));
    return {
        room,
        npc: { name: npc.name, subject: npc.subject, class_name: npc.className },
        teaching_preferences: memory.learningPreferences,
        memory: { summary: memory.summary, current_topic: memory.currentTopic, topics_studied: memory.topicsStudied },
        progress: { topics_mastered: progress.topicsMastered, topics_needing_practice: progress.topicsNeedingPractice },
        coursework: {
            documents: knowledge.materials.map((m) => ({ title: m.title, status: m.status, mine: m.visibility === 'private' })),
            excerpts: knowledge.chunks.map((c) => ({ title: c.title, text: c.text, page: c.pageStart ?? null })),
        },
        instructions: buildVoiceInstructions(npc, memory, progress, materials),
    };
}

serve(async (req) =>
{
    const secret = Deno.env.get('VOICE_AGENT_SECRET') ?? '';
    if (!secret) throw new HttpError(503, 'voice_not_configured', 'The voice agent endpoint is not set up (VOICE_AGENT_SECRET missing).');
    const provided = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1] ?? '';
    if (!(await secretMatches(provided, secret))) throw new HttpError(401, 'unauthorized', 'Unknown caller.');

    const parsed = parseAgentRequest(await readJson(req, 8_192));
    if (!parsed.ok) throw new HttpError(400, 'bad_request', parsed.error);
    const request = parsed.value;
    const admin = adminClient();

    if (request.action === 'resolve')
    {
        const { data, error } = await admin.rpc('claim_voice_session', { p_session_id: request.pairingId });
        if (error) throw new Error(error.message);
        const claimed = (Array.isArray(data) ? data[0] : data) as { player_id: string; npc_id: string; room_name: string } | undefined;
        if (!claimed) throw new HttpError(404, 'pairing_invalid', 'This pairing is unknown, expired or already used.');

        return json(200, await sessionContext(admin, claimed.player_id, claimed.npc_id, claimed.room_name));
    }

    if (request.action === 'pair')
    {
        const { data, error } = await admin.rpc('pair_facetime_call', { p_call_id: request.callId, p_code_hash: await hashPairingCode(request.code) });
        if (error)
        {
            if (error.code === 'P0002') throw new HttpError(404, 'call_inactive', 'This FaceTime call is not active.');
            if (error.code === 'P0001') throw new HttpError(429, 'pairing_locked', /paired/.test(error.message) ? 'This call is already paired.' : 'Too many wrong codes on this call. Hang up and start again from EDUROAM.');
            throw new Error(error.message);
        }
        const row = (Array.isArray(data) ? data[0] : data) as { session_id: string | null; player_id: string; npc_id: string; room_name: string; attempts_left: number } | undefined;
        if (!row?.session_id) return json(200, { paired: false, attempts_left: Math.max(0, row?.attempts_left ?? 0) });
        return json(200, { paired: true, pairing_id: row.session_id, ...(await sessionContext(admin, row.player_id, row.npc_id, row.room_name)) });
    }

    if (request.action === 'call_ended')
    {
        const { error } = await admin.from('facetime_calls').update({ ended_at: new Date().toISOString() }).eq('id', request.callId).is('ended_at', null);
        if (error) throw new Error(error.message);
        return json(200, { ok: true });
    }

    // search / progress / end: only for a session that was claimed recently and has not ended.
    const { data: session, error } = await admin.from('voice_sessions').select('id, player_id, npc_id, claimed_at, ended_at')
        .eq('id', request.pairingId).not('claimed_at', 'is', null).maybeSingle();
    if (error) throw new Error(error.message);
    const active = session && !session.ended_at && Date.now() - new Date(session.claimed_at).getTime() < SESSION_MAX_SECONDS * 1000;

    if (request.action === 'progress')
    {
        if (!active) throw new HttpError(404, 'session_inactive', 'This voice session is not active.');
        const npc = await resolveNpcIdentity(admin, session.player_id, session.npc_id);
        const { memory, progress } = await retrieveStudentMemory(admin, session.player_id, npc);
        return json(200, {
            memory: { summary: memory.summary, current_topic: memory.currentTopic, topics_studied: memory.topicsStudied },
            progress: { topics_mastered: progress.topicsMastered, topics_needing_practice: progress.topicsNeedingPractice },
        });
    }

    if (request.action === 'search')
    {
        if (!active) throw new HttpError(404, 'session_inactive', 'This voice session is not active.');
        if (!(await withinRateLimit(admin, session.player_id, 'voice-search:minute', 20, 60))) throw new HttpError(429, 'rate_limited', 'Too many searches; try again in a moment.');
        const npc = await resolveNpcIdentity(admin, session.player_id, session.npc_id);
        const { materials, chunks } = await loadClassKnowledge(admin, session.player_id, npc, request.query, 5);
        return json(200, searchResponse(materials, chunks));
    }

    // end: the first call saves the summary; repeats (or calls after the window) save nothing.
    if (!session) throw new HttpError(404, 'session_inactive', 'This voice session is not active.');
    const { data: ended, error: endError } = await admin.from('voice_sessions').update({ ended_at: new Date().toISOString() })
        .eq('id', session.id).is('ended_at', null).select('id');
    if (endError) throw new Error(endError.message);
    if (!ended?.length) return json(200, { saved: false, reason: 'already_ended' });
    if (!active || (!request.summary && !request.topics.length)) return json(200, { saved: false, reason: active ? 'empty_summary' : 'session_expired' });

    const npc = await resolveNpcIdentity(admin, session.player_id, session.npc_id);
    const { memory, progress } = await retrieveStudentMemory(admin, session.player_id, npc);
    const next = memoryAfterCall(memory, progress, request.summary, request.topics);
    const { data: row } = await admin.from('npc_memories').select('channels_used').eq('player_id', session.player_id).eq('npc_id', npc.id).maybeSingle();
    const { error: saveError } = await admin.from('npc_memories').upsert({
        player_id: session.player_id, npc_id: npc.id, summary: next.summary, current_topic: next.currentTopic,
        topics_studied: next.topicsStudied, learning_preferences: next.learningPreferences,
        channels_used: [...new Set([...(row?.channels_used ?? []), 'facetime'])], updated_at: new Date().toISOString(),
    }, { onConflict: 'player_id,npc_id' });
    if (saveError) throw new Error(saveError.message);
    return json(200, { saved: true });
});

