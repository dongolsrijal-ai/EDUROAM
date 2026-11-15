// Edge Function plumbing (Deno): CORS, JSON responses, Supabase clients and caller auth.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';

export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export class HttpError extends Error
{
    constructor (readonly status: number, readonly code: string, message: string)
    {
        super(message);
    }
}

export function json (status: number, body: unknown, extra: Record<string, string> = {})
{
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extra },
    });
}

export function errorResponse (err: unknown)
{
    if (err instanceof HttpError) return json(err.status, { error: { code: err.code, message: err.message } });
    console.error('[edge] unexpected error', err);
    return json(500, { error: { code: 'internal', message: 'Something went wrong on the server.' } });
}

/** First key of a SUPABASE_*_KEYS JSON dictionary, falling back to the legacy variable. */
function key (dictionaryVar: string, legacyVar: string)
{
    const dictionary = Deno.env.get(dictionaryVar);
    if (dictionary)
    {
        try
        {
            const first = Object.values(JSON.parse(dictionary) as Record<string, string>)[0];
            if (first) return first;
        }
        catch { /* fall back */ }
    }
    const legacy = Deno.env.get(legacyVar);
    if (!legacy) throw new HttpError(500, 'config', `Server is missing ${dictionaryVar}.`);
    return legacy;
}

const url = () => Deno.env.get('SUPABASE_URL') ?? (() => { throw new HttpError(500, 'config', 'Server is missing SUPABASE_URL.'); })();

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** Bypasses RLS. Only used for writes after the caller has been verified. */
export function adminClient (): SupabaseClient
{
    return createClient(url(), key('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), noSession);
}

export interface Caller
{
    userId: string;
    /** Acts as the caller: every read is filtered by RLS. */
    db: SupabaseClient;
}

/** Verifies the bearer token with Supabase Auth. The player id comes only from here. */
export async function authenticate (req: Request, admin: SupabaseClient): Promise<Caller>
{
    const header = req.headers.get('Authorization') ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    if (!token) throw new HttpError(401, 'unauthenticated', 'Sign in to talk to your teachers.');
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, 'unauthenticated', 'Your session has expired. Please sign in again.');

    const db = createClient(url(), key('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'), {
        ...noSession,
        global: { headers: { Authorization: `Bearer ${token}` } },
    });
    // Accounts created before the migration have no player row yet.
    await admin.from('players').upsert({ id: data.user.id }, { onConflict: 'id', ignoreDuplicates: true });
    return { userId: data.user.id, db };
}

/** Counts one use of `bucket`; false once the window's budget is spent. */
export async function withinRateLimit (admin: SupabaseClient, userId: string, bucket: string, max: number, windowSeconds: number)
{
    const { data, error } = await admin.rpc('consume_rate_limit', {
        p_user_id: userId, p_bucket: bucket, p_max: max, p_window_seconds: windowSeconds,
    });
    if (error) throw error;
    return data === true;
}

export async function rateLimit (admin: SupabaseClient, userId: string, bucket: string, max: number, windowSeconds: number)
{
    if (!(await withinRateLimit(admin, userId, bucket, max, windowSeconds)))
    {
        throw new HttpError(429, 'rate_limited', 'Slow down a little! Try again in a minute.');
    }
}

export async function readJson (req: Request, maxBytes = 16_384): Promise<unknown>
{
    const text = await req.text();
    if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'Request is too large.');
    try { return JSON.parse(text); }
    catch { throw new HttpError(400, 'bad_request', 'Request body must be JSON.'); }
}

/** Shared request wrapper: CORS preflight, POST only, uniform errors. */
export function serve (handler: (req: Request) => Promise<Response>)
{
    Deno.serve(async (req) =>
    {
        if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
        if (req.method !== 'POST') return json(405, { error: { code: 'method_not_allowed', message: 'Use POST.' } });
        try { return await handler(req); }
        catch (err) { return errorResponse(err); }
    });
}
