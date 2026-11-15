// POST /functions/v1/chert-webhook?key=<CHERT_WEBHOOK_KEY>   (Chert FaceTime, Bring Your Own Room)
//
// Configure this URL in Chert: Workers & Lines -> Integration, mode customer_decides, no default
// Assistant. One shared line serves every EDUROAM teacher:
//
//   call.incoming -> record the call, create a fresh LiveKit room, dispatch "eduroam-tutor" with
//                    ONLY this call's opaque id as metadata, and accept with a room-scoped bridge
//                    token (Chert must answer within ~5 s; anything else fails closed = declined).
//   call ended    -> mark the call over (frees the line for the next student).
//
// The call carries no EDUROAM identity, so the agent starts LOCKED: it greets generically and asks
// for the 6-digit code the student sees in the game (voice-agent "pair"). Nothing private is
// released before that. The `key` query parameter keeps strangers from posting fake calls;
// Chert's optional request signing can be added once its header/algorithm are documented.

import { AgentDispatchClient } from 'npm:livekit-server-sdk@2.19.2';
import { adminClient, HttpError, json, readJson, serve, withinRateLimit } from '../_shared/http.ts';
import { AGENT_IDENTITY, BRIDGE_TOKEN_SECONDS, livekitHttpUrl, mintRoomToken, parseChertEvent, secretMatches, voiceAgentName } from '../_shared/voice.ts';

/** Rate-limit bucket owner for the whole line (api_rate_limits.user_id has no foreign key). */
const LINE_BUCKET = '00000000-0000-4000-8000-00000000c4e7';
const decline = () => json(200, { action: 'decline' });

serve(async (req) =>
{
    const key = Deno.env.get('CHERT_WEBHOOK_KEY') ?? '';
    if (!key) throw new HttpError(503, 'facetime_not_configured', 'CHERT_WEBHOOK_KEY is not set.');
    if (!(await secretMatches(new URL(req.url).searchParams.get('key') ?? '', key))) throw new HttpError(401, 'unauthorized', 'Unknown caller.');

    const parsed = parseChertEvent(await readJson(req, 16_384));
    if (!parsed.ok) throw new HttpError(400, 'bad_request', parsed.error);
    const event = parsed.value;
    const admin = adminClient();

    if (event.kind === 'ended')
    {
        const { error } = await admin.from('facetime_calls').update({ ended_at: new Date().toISOString() }).eq('chert_call_id', event.callId).is('ended_at', null);
        if (error) throw new Error(error.message);
        return json(200, { ok: true });
    }
    if (event.kind === 'other') return json(200, { ok: true, ignored: event.type });

    const url = Deno.env.get('LIVEKIT_URL')?.trim();
    const apiKey = Deno.env.get('LIVEKIT_API_KEY');
    const apiSecret = Deno.env.get('LIVEKIT_API_SECRET');
    if (!url || !apiKey || !apiSecret)
    {
        console.error('[chert-webhook] LiveKit is not configured; declining call');
        return decline();
    }
    if (!(await withinRateLimit(admin, LINE_BUCKET, 'chert:incoming:hour', 30, 3600)))
    {
        console.warn('[chert-webhook] incoming-call rate limit reached; declining');
        return decline();
    }

    // Chert may retry the same event: reuse its room (and the agent already dispatched there).
    let { data: call } = await admin.from('facetime_calls').select('id, room_name, ended_at').eq('chert_call_id', event.callId).maybeSingle();
    if (call?.ended_at) return decline();
    if (!call)
    {
        const roomName = `eduroam-ft-${crypto.randomUUID()}`;
        const inserted = await admin.from('facetime_calls').insert({ chert_call_id: event.callId, line_id: event.lineId, room_name: roomName }).select('id, room_name, ended_at').single();
        if (inserted.error)
        {
            if (inserted.error.code !== '23505') throw new Error(inserted.error.message);
            ({ data: call } = await admin.from('facetime_calls').select('id, room_name, ended_at').eq('chert_call_id', event.callId).single());
        }
        else
        {
            call = inserted.data;
            try
            {
                // Explicit dispatch also creates the room. Metadata: this call's id and nothing else.
                await new AgentDispatchClient(livekitHttpUrl(url), apiKey, apiSecret)
                    .createDispatch(call.room_name, voiceAgentName(Deno.env.get('VOICE_AGENT_NAME')), { metadata: JSON.stringify({ facetime_call: call.id }) });
            }
            catch (err)
            {
                console.error('[chert-webhook] dispatch failed', err instanceof Error ? err.message : 'error');
                await admin.from('facetime_calls').delete().eq('id', call.id);
                return decline();
            }
        }
    }
    if (!call) return decline();

    const participantToken = await mintRoomToken({
        apiKey, apiSecret, identity: `chert-bridge-${call.id.slice(0, 8)}`, name: 'FaceTime caller', room: call.room_name, seconds: BRIDGE_TOKEN_SECONDS,
    });
    return json(200, {
        action: 'accept',
        livekit_url: url.replace(/^https?:\/\//i, 'wss://').replace(/\/+$/, ''),
        participant_token: participantToken,
        remote_participant_identity: AGENT_IDENTITY,
    });
});
