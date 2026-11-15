// Permanent teacher deletion. The JWT supplies the owner, never the request body.
// Storage and LiveKit are external systems: retain a durable manifest until both succeed,
// then atomically preserve shared coursework and let the existing NPC cascades run.
import { RoomServiceClient } from 'npm:livekit-server-sdk@2.19.2';
import { adminClient, authenticate, HttpError, json, readJson, serve } from '../_shared/http.ts';
import { livekitHttpUrl, secretMatches } from '../_shared/voice.ts';

type DeletionJob = { npc_id: string; file_paths: string[]; room_names: string[]; completed_at: string | null; cleanup_until: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) =>
{
    const admin = adminClient();
    const raw = await readJson(req);
    const body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    if (body.action === 'sweep')
    {
        // Cron's secret lives in Vault and Edge secrets, never in the browser or source.
        if (!(await secretMatches(req.headers.get('x-npc-cleanup-secret') ?? '', Deno.env.get('NPC_CLEANUP_SECRET') ?? '')))
            throw new HttpError(401, 'unauthenticated', 'Cleanup authorization required.');
        const jobs = await admin.from('npc_deletions').select('*').not('completed_at', 'is', null)
            .lte('next_cleanup_at', new Date().toISOString()).order('next_cleanup_at').limit(20);
        if (jobs.error) throw jobs.error;
        let cleaned = 0;
        for (const job of jobs.data as DeletionJob[])
        {
            try
            {
                await cleanup(job);
                // Only retire the schedule after a successful pass at/after the horizon.
                const next = Date.now() >= Date.parse(job.cleanup_until!) ? null : new Date(Date.now() + 5 * 60_000).toISOString();
                const result = await admin.from('npc_deletions').update({ next_cleanup_at: next }).eq('npc_id', job.npc_id);
                if (result.error) throw result.error;
                cleaned++;
            }
            catch
            {
                console.error('[npc-lifecycle] cleanup retry required', job.npc_id);
                // Rotate failed jobs instead of starving newer manifests behind them.
                await admin.from('npc_deletions').update({ next_cleanup_at: new Date(Date.now() + 5 * 60_000).toISOString() }).eq('npc_id', job.npc_id);
            }
        }
        return json(200, { cleaned, attempted: jobs.data.length });
    }
    const { userId } = await authenticate(req, admin);
    // Check BEFORE looking up, marking or removing any teacher. Auth may change between
    // the confirmation dialog and the HTTP request (including in another browser tab).
    if (body.expected_owner_id !== userId) throw new HttpError(409, 'account_changed', 'Your account changed. Refresh before deleting this teacher.');
    let deleted: string;
    if (body?.action === 'discard_local' && typeof body.game_npc_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.game_npc_id))
    {
        const { data, error } = await admin.rpc('discard_local_npc', { p_owner_id: userId, p_game_npc_id: body.game_npc_id });
        if (error) throw new HttpError(409, 'sync_changed', error.message);
        deleted = data;
    }
    else if (body?.action === 'delete' && typeof body.npc_id === 'string' && UUID.test(body.npc_id))
    {
        const args = { p_owner_id: userId, p_npc_id: body.npc_id };
        const prepared = await admin.rpc('prepare_npc_deletion', args);
        if (prepared.error)
        {
            if (prepared.error.code === 'P0002') throw new HttpError(404, 'npc_not_found', 'That teacher could not be found on your account.');
            throw prepared.error;
        }
        const job = prepared.data as DeletionJob;
        await cleanup(job);
        const finished = await admin.rpc('finish_npc_deletion', args);
        if (finished.error) throw finished.error;
        deleted = job.npc_id;
    }
    else throw new HttpError(400, 'bad_request', 'Choose a teacher to delete using its stable identity.');

    const { count, error } = await admin.from('npcs').select('id', { head: true, count: 'exact' }).eq('owner_id', userId);
    if (error) throw error;
    return json(200, { deleted, owner_id: userId, npc_count: count });

    async function cleanup (job: DeletionJob)
    {
        if (job.room_names.length)
        {
            const url = Deno.env.get('LIVEKIT_URL');
            const key = Deno.env.get('LIVEKIT_API_KEY');
            const secret = Deno.env.get('LIVEKIT_API_SECRET');
            if (!url || !key || !secret) throw new HttpError(503, 'call_cleanup_failed', 'Could not end this teacher’s voice sessions. The teacher was kept; retry deletion once voice is available.');
            const rooms = new RoomServiceClient(livekitHttpUrl(url), key, secret);
            for (const name of job.room_names)
            {
                try { await rooms.deleteRoom(name); }
                catch (err)
                {
                    const error = err as { status?: number; code?: string };
                    if (error.status !== 404 && error.code !== 'not_found') throw new HttpError(503, 'call_cleanup_failed', 'Could not end the voice call. The teacher was kept; retry deletion.');
                }
            }
        }
        // Use the Storage API, never DELETE storage.objects (which only deletes metadata).
        // Keep this repeatable even for completed jobs: retries can remove a late upload.
        for (let i = 0; i < job.file_paths.length; i += 100)
        {
            const { error } = await admin.storage.from('class-materials').remove(job.file_paths.slice(i, i + 100));
            if (error) throw new HttpError(503, 'cleanup_failed', 'Private file cleanup failed. The teacher was kept; retry deletion from the NPC list.');
        }
    }
});
