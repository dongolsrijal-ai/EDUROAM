// POST /functions/v1/voice-session  { action: 'start', npc_id, mode?: 'browser' | 'facetime' }   (FaceTime Tutor)
//
// mode "facetime" (the shared Chert line): steps 1-2, then a single-use 6-digit code for this
// student + NPC (only its hash is stored) and the line's real address from CHERT_FACETIME_ADDRESS.
// The call itself arrives at chert-webhook; the agent asks for the code before it knows anything.
//
// mode "browser" (default):
// 1. authenticate the student (JWT; the player id comes only from here)
// 2. authorise the NPC (owner or class member; a foreign NPC is a 404)
// 3. create a short-lived single-use pairing + unique room (create_voice_session re-checks access)
// 4. dispatch the LiveKit agent "eduroam-tutor" with ONLY the opaque pairing id as metadata
// 5. return a join-only token for that one room (LiveKit secrets never leave the server)

import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'npm:livekit-server-sdk@2.19.2';
import { adminClient, authenticate, HttpError, json, rateLimit, readJson, serve } from '../_shared/http.ts';
import { resolveNpcIdentity } from '../_shared/npcContext.ts';
import {
    FACETIME_CODE_TTL_SECONDS, hashPairingCode, JOIN_TOKEN_TTL, livekitHttpUrl, newPairingCode, PAIRING_TTL_SECONDS, parseVoiceStart, voiceAgentName,
} from '../_shared/voice.ts';

serve(async (req) =>
{
    const admin = adminClient();
    const { userId, db } = await authenticate(req, admin);
    const parsed = parseVoiceStart(await readJson(req));
    if (!parsed.ok) throw new HttpError(400, 'bad_request', parsed.error);

    await rateLimit(admin, userId, 'voice:minute', 3, 60);
    await rateLimit(admin, userId, 'voice:day', 30, 86_400);
    // RLS-scoped lookup: only an NPC this student may use is found at all.
    const npc = await resolveNpcIdentity(db, userId, parsed.value.npcId);

    if (parsed.value.mode === 'facetime')
    {
        const line = Deno.env.get('CHERT_FACETIME_ADDRESS')?.trim();
        if (!line) throw new HttpError(503, 'facetime_not_configured', 'The FaceTime line is not set up yet. Use "Call in game" instead.');
        for (let attempt = 0; attempt < 3; attempt++)
        {
            const code = newPairingCode();
            const { data, error } = await admin.rpc('create_facetime_pairing', {
                p_player_id: userId, p_npc_id: npc.id, p_code_hash: await hashPairingCode(code), p_ttl_seconds: FACETIME_CODE_TTL_SECONDS,
            });
            if (error?.code === '23505') continue; // another student holds the same live code: draw again
            if (error)
            {
                if (error.code === 'P0002') throw new HttpError(404, 'npc_not_found', 'That teacher could not be found.');
                if (error.code === 'P0001') throw new HttpError(409, 'npc_deleted', 'This teacher is being deleted.');
                throw new Error(error.message);
            }
            const row = (Array.isArray(data) ? data[0] : data) as { expires_at: string };
            // One shared line, one call at a time: tell the student if someone is on it right now.
            const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
            const { count } = await admin.from('facetime_calls').select('id', { head: true, count: 'exact' }).is('ended_at', null).gt('created_at', since);
            return json(201, { mode: 'facetime', code, expires_at: row.expires_at, line, line_busy: (count ?? 0) > 0, npc: { name: npc.name, subject: npc.subject } });
        }
        throw new HttpError(503, 'busy', 'Could not create a code right now. Please try again.');
    }

    const url = Deno.env.get('LIVEKIT_URL');
    const apiKey = Deno.env.get('LIVEKIT_API_KEY');
    const apiSecret = Deno.env.get('LIVEKIT_API_SECRET');
    if (!url || !apiKey || !apiSecret) throw new HttpError(503, 'voice_not_configured', 'FaceTime Tutor is not set up yet.');

    const { data, error } = await admin.rpc('create_voice_session', { p_player_id: userId, p_npc_id: npc.id, p_ttl_seconds: PAIRING_TTL_SECONDS });
    if (error)
    {
        if (error.code === 'P0002') throw new HttpError(404, 'npc_not_found', 'That teacher could not be found.');
        if (error.code === 'P0001') throw new HttpError(409, 'npc_deleted', 'This teacher is being deleted. Finish deletion from the NPC list.');
        throw new Error(error.message);
    }
    const session = (Array.isArray(data) ? data[0] : data) as { id: string; room_name: string; expires_at: string };

    try
    {
        // Explicit dispatch also creates the room. The metadata is the pairing id and nothing else.
        await new AgentDispatchClient(livekitHttpUrl(url), apiKey, apiSecret)
            .createDispatch(session.room_name, voiceAgentName(Deno.env.get('VOICE_AGENT_NAME')), { metadata: session.id });
    }
    catch (err)
    {
        console.error('[voice-session] dispatch failed', err instanceof Error ? err.message : 'error');
        await admin.from('voice_sessions').delete().eq('id', session.id);
        throw new HttpError(502, 'voice_unavailable', 'The tutor could not join the call right now. Please try again.');
    }

    // Deletion may have begun while dispatch was in flight. The session INSERT is guarded
    // in Postgres; this closes the remaining race where dispatch creates its room AFTER
    // the lifecycle endpoint already tried to remove it. Never return a join token then.
    const deletion = await admin.from('npc_deletions').select('npc_id').eq('npc_id', npc.id).maybeSingle();
    if (deletion.error || deletion.data)
    {
        await new RoomServiceClient(livekitHttpUrl(url), apiKey, apiSecret).deleteRoom(session.room_name);
        await admin.from('voice_sessions').delete().eq('id', session.id);
        if (deletion.error) throw deletion.error;
        throw new HttpError(409, 'npc_deleted', 'This teacher is being deleted. The voice call was cancelled.');
    }

    // The student's identity in the room is random: no player or NPC id reaches LiveKit.
    const token = new AccessToken(apiKey, apiSecret, { identity: `student-${crypto.randomUUID()}`, name: 'Student', ttl: JOIN_TOKEN_TTL });
    token.addGrant({ room: session.room_name, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false });

    return json(201, { room: session.room_name, server_url: url, token: await token.toJwt(), npc: { name: npc.name, subject: npc.subject } });
});
