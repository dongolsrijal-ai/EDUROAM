// In-page stand-in for the Supabase HTTP API used by the auth browser test. Installed on
// window.fetch BEFORE the game loads, so the real supabase-js client, real session storage
// and real onAuthStateChange events are exercised without sending email or touching a project.

export const USER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const VALID_CODE = '123456';

export interface StubLog
{
    otpRequests: { email: string; redirect?: string; createUser?: boolean }[];
    /** resetPasswordForEmail requests (POST /recover). */
    recoverRequests: { email: string; redirect?: string }[];
    /** Account ids whose password was changed (PUT /user with a password). */
    passwordUpdates: string[];
    verifyRequests: { email: string; token: string; type: string }[];
    classOwners: string[];
    legacyIds: string[];
    chats: number;
    dash: { starts: { source: unknown; game?: string; choices?: number }[]; answers: { index: number; choice: number }[]; finishes: number };
    pastes: { title: string; text: string }[];
    chatImages: string[];
    /** attachment_ids each chat request carried. */
    chatAttachments: string[][];
    /** Documents uploaded through the chat composer / editor. */
    uploads: { name: string; visibility: string }[];
    deletes: string[];
    chatMessageIds: string[];
    voiceStarts: Record<string, unknown>[];
    /** INSERT / UPSERT requests to the npcs table. */
    npcWrites: number;
    lifecycle: Record<string, unknown>[];
    npcBodies: Record<string, any>[];
    signups: string[];
    emailChanges: string[];
    passwordLogins: string[];
}

export const log: StubLog = { otpRequests: [], recoverRequests: [], passwordUpdates: [], verifyRequests: [], classOwners: [], legacyIds: [], chats: 0, dash: { starts: [], answers: [], finishes: 0 }, pastes: [], chatImages: [], chatAttachments: [], uploads: [], deletes: [], chatMessageIds: [], voiceStarts: [], npcWrites: 0, lifecycle: [], npcBodies: [], signups: [], emailChanges: [], passwordLogins: [] };

/** Tiny PNG used as an Answer Dash figure. */
export const FIGURE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Answer key used by the fake answer-dash function: question i's correct lane. */
export const DASH_KEY = (i: number) => (i + 2) % 4;
export const DASH_QUESTIONS = 8;
/** Fake Spellshot pack: prompt i's correct target with n visible targets. */
export const SHOT_KEY = (i: number, n: number) => (i + 1) % n;
export const SHOT_QUESTIONS = 20;
const SHOT_SESSION = 'eeeeeeee-0000-4000-8000-000000000002';

const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Fake Auth users (persisted like the rest of the fake server): id -> account. */
export interface StubUser { id: string; email: string; password?: string; confirmed: boolean; anonymous: boolean; newEmail?: string }
const users = (): Record<string, StubUser> => JSON.parse(localStorage.getItem('stub.users') ?? 'null') ?? { [USER_ID]: { id: USER_ID, email: 'student@school.org', confirmed: true, anonymous: false } };
const saveUser = (user: StubUser) => localStorage.setItem('stub.users', JSON.stringify({ ...users(), [user.id]: user }));
const userByEmail = (email: string) => Object.values(users()).find((u) => u.email === email);
/** Pre-creates a confirmed email + password account on the fake server. */
export function stubAccount (id: string, email: string, password: string) { saveUser({ id, email, password, confirmed: true, anonymous: false }); }
function newUser (fields: Omit<StubUser, 'id'>)
{
    const user = { id: `aaaaaaaa-0000-4000-8000-${String(Object.keys(users()).length + 10).padStart(12, '0')}`, ...fields };
    saveUser(user);
    return user;
}
const userJson = (u: StubUser) => ({ id: u.id, email: u.email || undefined, new_email: u.newEmail, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: u.anonymous ? 'anonymous' : 'email' }, user_metadata: {}, identities: u.anonymous ? [] : [{ id: u.id, provider: 'email' }], created_at: new Date().toISOString(), email_confirmed_at: u.confirmed ? new Date().toISOString() : null, is_anonymous: u.anonymous });

function sessionFor (user: StubUser)
{
    const now = Math.floor(Date.now() / 1000);
    const access = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', is_anonymous: user.anonymous, exp: now + 3600, iat: now, session_id: 's1' })}.sig`;
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: `refresh:${user.id}`, user: userJson(user) };
}

/** The URL fragment Supabase redirects a password-reset LINK to (implicit flow, type=recovery). */
export function recoveryLink (userId: string)
{
    const t = sessionFor(users()[userId]);
    return `#access_token=${t.access_token}&expires_at=${t.expires_at}&expires_in=3600&refresh_token=${t.refresh_token}&token_type=bearer&type=recovery`;
}

/** The email-code flow: student@school.org is USER_ID; other addresses get (or create) their own account. */
function session (email: string)
{
    return sessionFor(userByEmail(email) ?? newUser({ email, confirmed: true, anonymous: false }));
}

/** The signed-in user behind a request's access token (the fake server's auth.uid()). */
function subOf (request: Request): string | null
{
    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
    try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub ?? null; }
    catch { return null; }
}

/** Codes the fake server emailed: "email:<address>" / "recovery:<address>" -> sent at (ms). Single use, 1 h. */
const codes = (): Record<string, number> => JSON.parse(localStorage.getItem('stub.codes') ?? '{}');
const issue = (kind: string, email: string) => localStorage.setItem('stub.codes', JSON.stringify({ ...codes(), [`${kind}:${email}`]: Date.now() }));
function redeem (kind: string, email: string, token: string): boolean
{
    const sentAt = codes()[`${kind}:${email}`];
    if (token !== VALID_CODE || !sentAt || Date.now() - sentAt > 3600_000) return false;
    const rest = codes();
    delete rest[`${kind}:${email}`];
    localStorage.setItem('stub.codes', JSON.stringify(rest));
    return true;
}

const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
});

const store = {
    get: (key: string) => JSON.parse(localStorage.getItem(`stub.${key}`) ?? 'null'),
    set: (key: string, value: unknown) => localStorage.setItem(`stub.${key}`, JSON.stringify(value)),
};

/** Signed-URL uploads use XHR (for progress): answer them locally, like Storage would. */
class FakeUploadXhr extends EventTarget
{
    status = 0;
    responseText = '';
    readonly upload = new EventTarget();
    open () {}
    setRequestHeader () {}
    send (file: File)
    {
        setTimeout(() =>
        {
            this.upload.dispatchEvent(Object.assign(new Event('progress'), { lengthComputable: true, loaded: file.size, total: file.size }));
            this.status = 200;
            this.dispatchEvent(new Event('load'));
        }, 10);
    }
}

export function installStub (base: string)
{
    (window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeUploadXhr;
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    {
        const request = new Request(input, init);
        if (!request.url.startsWith(base)) return original(input, init);
        const url = new URL(request.url);
        const path = url.pathname;
        const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.clone().text().then((t) => (t ? JSON.parse(t) : null)).catch(() => null);
        const authed = /^Bearer .+\..+\..+$/.test(request.headers.get('Authorization') ?? '');

        if (path === '/auth/v1/otp')
        {
            log.otpRequests.push({ email: body.email, redirect: url.searchParams.get('redirect_to') ?? undefined, createUser: body.create_user });
            // Hourly email quota exhausted (Supabase sends no Retry-After for this today).
            if (String(body.email).startsWith('limit')) return reply(429, { error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
            // A 429 that does carry Retry-After.
            if (String(body.email).startsWith('retry')) return reply(429, { error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }, { 'Retry-After': '120' });
            // Like Supabase: shouldCreateUser false + unknown address -> no email, no account.
            if (body.create_user === false && !userByEmail(body.email)) return reply(422, { error_code: 'otp_disabled', msg: 'Signups not allowed for otp' });
            issue('email', body.email);
            return reply(200, {});
        }
        if (path === '/auth/v1/recover')
        {
            log.recoverRequests.push({ email: body.email, redirect: url.searchParams.get('redirect_to') ?? undefined });
            // Same answer for unknown addresses (no email is sent to them).
            if (userByEmail(body.email)) issue('recovery', body.email);
            return reply(200, {});
        }
        if (path === '/auth/v1/resend') { issue('email', body.email); return reply(200, {}); }
        if (path === '/auth/v1/verify')
        {
            log.verifyRequests.push({ email: body.email, token: body.token, type: body.type });
            const invalid = () => reply(403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
            if (body.type === 'recovery')
            {
                const user = userByEmail(body.email);
                if (!user || !redeem('recovery', body.email, body.token)) return invalid();
                return reply(200, sessionFor(user));
            }
            if (body.token !== VALID_CODE || !['email', 'email_change'].includes(body.type)) return invalid();
            if (body.type === 'email' && !redeem('email', body.email, body.token)) return invalid();
            if (body.type === 'email_change')
            {
                // A guest confirming the email they asked to keep their account under: SAME user id.
                const guest = Object.values(users()).find((u) => u.newEmail === body.email);
                if (!guest) return reply(403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
                const upgraded = { ...guest, email: body.email, newEmail: undefined, confirmed: true, anonymous: false };
                saveUser(upgraded);
                return reply(200, sessionFor(upgraded));
            }
            const pending = userByEmail(body.email);
            if (pending && !pending.confirmed) saveUser({ ...pending, confirmed: true });
            return reply(200, session(body.email));
        }
        if (path === '/auth/v1/signup')
        {
            if (!body?.email)
            {
                // signInAnonymously(): a guest account.
                return reply(200, sessionFor(newUser({ email: '', confirmed: false, anonymous: true })));
            }
            const existing = userByEmail(body.email);
            // Supabase (email confirmation on): an existing address gets an identity-less user and no email.
            if (existing?.confirmed) return reply(200, { ...userJson(existing), id: crypto.randomUUID(), identities: [] });
            const user = existing ?? newUser({ email: body.email, password: body.password, confirmed: false, anonymous: false });
            log.signups.push(body.email);
            issue('email', body.email);
            return reply(200, userJson(user));
        }
        if (path === '/auth/v1/settings') return reply(200, { external: { email: true, anonymous_users: localStorage.getItem('stub.guests') === '1' } });
        if (path === '/auth/v1/user')
        {
            const me = users()[subOf(request) ?? ''];
            // A revoked / deleted account: the saved session must not let anyone in.
            if (localStorage.getItem('stub.rejectUser') && request.method === 'GET') return reply(403, { error_code: 'user_not_found', msg: 'User from sub claim in JWT does not exist' });
            if (!authed || !me) return reply(401, { msg: 'no session' });
            if (request.method === 'PUT')
            {
                if (body.email)
                {
                    if (userByEmail(body.email)) return reply(422, { error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
                    saveUser({ ...me, newEmail: body.email });
                    log.emailChanges.push(body.email);
                }
                if (body.password)
                {
                    if (me.anonymous) return reply(422, { error_code: 'validation_failed', msg: 'Confirm your email first' });
                    saveUser({ ...users()[me.id], password: body.password });
                    log.passwordUpdates.push(me.id);
                }
                return reply(200, userJson(users()[me.id]));
            }
            return reply(200, userJson(me));
        }
        if (path === '/auth/v1/token')
        {
            if (url.searchParams.get('grant_type') === 'password')
            {
                const user = userByEmail(body.email);
                if (!user || user.password !== body.password) return reply(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
                if (!user.confirmed) return reply(400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
                log.passwordLogins.push(body.email);
                return reply(200, sessionFor(user));
            }
            const id = String(body?.refresh_token ?? '').replace(/^refresh:/, '');
            return reply(200, sessionFor(users()[id] ?? users()[USER_ID]));
        }
        if (path === '/auth/v1/logout') return reply(204);

        if (!authed) return reply(401, { message: 'JWT required' });
        const sub = subOf(request) ?? USER_ID;
        const single = (request.headers.get('Accept') ?? '').includes('vnd.pgrst.object');
        if (path === '/rest/v1/players') { log.legacyIds.push(body?.legacy_local_id); return reply(204); }
        if (path === '/rest/v1/classes')
        {
            if (request.method !== 'GET')
            {
                log.classOwners.push(body.owner_id);
                store.set('class', { id: 'class-1', name: body.name });
            }
            const cls = store.get('class');
            return reply(request.method === 'GET' ? 200 : 201, single ? cls : cls ? [cls] : []);
        }
        if (path === '/rest/v1/npc_deletions')
        {
            const id = url.searchParams.get('game_npc_id')?.replace(/^eq\./, '');
            const rows = (store.get('npcDeletions') ?? []).filter((n: any) => (n.owner_id ?? USER_ID) === sub && (!id || n.game_npc_id === id));
            return reply(200, single ? rows[0] ?? null : rows);
        }
        if (path === '/rest/v1/npcs')
        {
            let rows = store.get('npcs') ?? [];
            const mine = (n: any) => (n.owner_id ?? USER_ID) === sub;
            if (request.method !== 'GET')
            {
                if (localStorage.getItem('stub.failNpcWrite')) return reply(503, { message: 'Database unavailable' });
                log.npcWrites++;
                log.npcBodies.push(body);
                const id = url.searchParams.get('id')?.replace(/^eq\./, '');
                const existing = rows.find((n: any) => mine(n) && (id ? n.id === id : n.game_npc_id === body.game_npc_id));
                // Like the deletion guard trigger: a tombstoned game id can never be recreated.
                if (!existing && (store.get('npcDeletions') ?? []).some((d: any) => (d.owner_id ?? USER_ID) === sub && d.game_npc_id === body.game_npc_id))
                {
                    return reply(400, { code: 'P0001', message: 'This NPC was permanently deleted' });
                }
                const row = { id: existing?.id ?? `bbbbbbbb-0000-4000-8000-${String(rows.length + 1).padStart(12, '0')}`, class_id: 'class-1', classes: { name: 'Mathematics' }, game_state: {}, ...existing, ...body, owner_id: existing?.owner_id ?? sub };
                rows = [...rows.filter((n: any) => n.id !== row.id), row];
                store.set('npcs', rows);
                return reply(201, single ? row : [row]);
            }
            if (localStorage.getItem('stub.slowNpcs') && !url.searchParams.get('game_npc_id')) await new Promise((resolve) => setTimeout(resolve, Number(localStorage.getItem('stub.slowNpcs'))));
            const id = url.searchParams.get('game_npc_id')?.replace(/^eq\./, '');
            const matches = rows.filter((n: any) => mine(n) && (!id || n.game_npc_id === id));
            return reply(200, single ? matches[0] ?? null : matches);
        }
        if (path === '/functions/v1/npc-lifecycle')
        {
            await new Promise((resolve) => setTimeout(resolve, 200));
            log.lifecycle.push(body);
            if (localStorage.getItem('stub.failNpcDeleteAtCall') === String(log.lifecycle.length))
            {
                localStorage.removeItem('stub.failNpcDeleteAtCall');
                return reply(503, { error: { code: 'cleanup_failed', message: 'Private file cleanup failed. The teacher was kept; retry deletion.' } });
            }
            if (localStorage.getItem('stub.failNpcDelete')) return reply(503, { error: { code: 'cleanup_failed', message: 'Private file cleanup failed. The teacher was kept; retry deletion.' } });
            const rows = store.get('npcs') ?? [];
            const npc = rows.find((n: any) => n.id === body.npc_id && (n.owner_id ?? USER_ID) === sub);
            if (body.action === 'delete' && !npc) return reply(404, { error: { code: 'npc_not_found', message: 'That teacher could not be found on your account.' } });
            const gameId = npc?.game_npc_id ?? body.game_npc_id;
            store.set('npcs', rows.filter((n: any) => n.id !== body.npc_id));
            store.set('npcDeletions', [...(store.get('npcDeletions') ?? []), { npc_id: body.npc_id, owner_id: sub, game_npc_id: gameId, completed_at: new Date().toISOString() }]);
            return reply(200, { deleted: body.npc_id, owner_id: sub, npc_count: store.get('npcs').filter((n: any) => (n.owner_id ?? USER_ID) === sub).length });
        }
        if (path === '/rest/v1/npc_memories' || path === '/rest/v1/class_progress') return reply(200, []);
        if (path === '/functions/v1/class-documents' && body.action === 'paste')
        {
            log.pastes.push({ title: body.title, text: body.text });
            localStorage.removeItem('stub.noDocs');
            return reply(201, { document: { id: 'dddddddd-0000-4000-8000-000000000009', title: body.title, topic: body.topic ?? '', chapter: '', file_type: 'text', visibility: body.visibility, processing_status: 'ready', processing_error: null, chunk_count: 2, extraction: {}, uploaded_by: USER_ID, created_at: new Date().toISOString() } });
        }
        if (path === '/functions/v1/class-documents' && body.action === 'create')
        {
            const id = `ffffffff-0000-4000-8000-${String(log.uploads.length + 1).padStart(12, '0')}`;
            log.uploads.push({ name: body.file_name, visibility: body.visibility });
            const document = { id, title: body.file_name, topic: '', chapter: '', file_type: 'pdf', visibility: body.visibility, processing_status: 'pending', processing_error: null, chunk_count: 0, extraction: {}, uploaded_by: USER_ID, created_at: new Date().toISOString() };
            store.set(`doc.${id}`, document);
            return reply(201, { document, upload: { url: `${base}/storage/v1/object/upload/sign/x?token=t`, mime: body.mime_type } });
        }
        if (path === '/functions/v1/class-documents' && body.action === 'process')
        {
            const document = store.get(`doc.${body.document_id}`);
            // A file named "broken..." cannot be read (exercises the failed state).
            const broken = /^broken/i.test(document.title);
            return reply(200, { document: { ...document, processing_status: broken ? 'failed' : 'ready', processing_error: broken ? 'No readable content was found in this file.' : null, chunk_count: broken ? 0 : 3 } });
        }
        if (path === '/functions/v1/class-documents' && body.action === 'delete') { log.deletes.push(body.document_id); return reply(200, { deleted: body.document_id }); }
        if (path === '/rest/v1/class_documents' && localStorage.getItem('stub.noDocs')) return reply(200, []);
        if (path === '/rest/v1/class_documents') return reply(200, [{ id: 'dddddddd-0000-4000-8000-000000000001', title: 'Algebra worksheet.pdf', file_type: 'pdf', visibility: 'class', processing_status: 'ready', processing_error: null, chunk_count: 4, uploaded_by: USER_ID, created_at: new Date().toISOString() }]);
        if (path === '/functions/v1/answer-dash')
        {
            if (body.action === 'start')
            {
                log.dash.starts.push({ source: body.source, game: body.game, choices: body.choices });
                // A specific document selection simulates a Gemini outage.
                if (Array.isArray(body.source)) return reply(503, { error: { code: 'ai_not_configured', message: 'The AI teacher is not set up yet (GEMINI_API_KEY secret missing).', retryable: false } });
                if (body.game === 'spellshot')
                {
                    const n = body.choices as number;
                    return reply(200, {
                        session_id: SHOT_SESSION, game: 'spellshot', mode: 'documents', documents: ['Algebra worksheet.pdf'],
                        questions: Array.from({ length: SHOT_QUESTIONS }, (_, i) => ({
                            question: `Which term means ${i + 1}?`, topic: 'vocabulary', difficulty: 'intro', figure: null,
                            choices: Array.from({ length: n }, (_, c) => (c === SHOT_KEY(i, n) ? `Right ${i}` : `Term ${c}-${i}`)),
                            source: { document_id: 'dddddddd-0000-4000-8000-000000000001', title: 'Algebra worksheet.pdf', chunk_index: i },
                        })),
                    });
                }
                return reply(200, {
                    session_id: 'eeeeeeee-0000-4000-8000-000000000001', mode: 'documents', documents: ['Algebra worksheet.pdf'],
                    questions: Array.from({ length: DASH_QUESTIONS }, (_, i) => ({
                        question: `Solve ${i + 2}x = ${(i + 2) * 3}. What is x?`, topic: i % 2 ? 'linear equations' : 'slope', difficulty: 'standard',
                        figure: i === 0 ? { document_id: 'dddddddd-0000-4000-8000-000000000002', title: 'Graph.png', url: FIGURE_PNG } : null,
                        choices: [0, 1, 2, 3].map((c) => (c === DASH_KEY(i) ? 'x = 3' : `x = ${c + 4 + i}`)),
                        source: { document_id: 'dddddddd-0000-4000-8000-000000000001', title: 'Algebra worksheet.pdf', chunk_index: i },
                    })),
                });
            }
            if (body.action === 'answer')
            {
                const first = log.dash.answers.find((a) => a.index === body.index);
                const choice = first ? first.choice : body.choice;
                if (!first) log.dash.answers.push({ index: body.index, choice });
                if (body.session_id === SHOT_SESSION)
                {
                    const key = SHOT_KEY(body.index, log.dash.starts.at(-1)?.choices ?? 4);
                    return reply(200, { index: body.index, choice, correct: choice === key, correct_index: key, explanation: 'Right answers start with Right.' });
                }
                return reply(200, { index: body.index, choice, correct: choice === DASH_KEY(body.index), correct_index: DASH_KEY(body.index), explanation: 'Divide both sides by the coefficient.' });
            }
            log.dash.finishes++;
            if (body.session_id === SHOT_SESSION)
            {
                const n = log.dash.starts.at(-1)?.choices ?? 4;
                const hits = log.dash.answers.filter((a) => a.choice === SHOT_KEY(a.index, n)).length;
                const answered = log.dash.answers.length;
                return reply(200, { session_id: SHOT_SESSION, score: Math.max(0, hits * 100 - (answered - hits) * 40), correct: hits, incorrect: answered - hits, total: SHOT_QUESTIONS, answered,
                    accuracy: hits / Math.max(1, answered), best_streak: 1, topic_performance: { vocabulary: { correct: hits, incorrect: answered - hits } }, weak_topics: ['vocabulary'], mastered_topics: [] });
            }
            const correct = log.dash.answers.filter((a) => a.choice === DASH_KEY(a.index)).length;
            return reply(200, { session_id: 'eeeeeeee-0000-4000-8000-000000000001', score: correct * 100, correct, incorrect: log.dash.answers.length - correct, total: DASH_QUESTIONS,
                accuracy: correct / Math.max(1, log.dash.answers.length), best_streak: 1, topic_performance: { slope: { correct: 1, incorrect: 0 } }, weak_topics: ['linear equations'], mastered_topics: [] });
        }
        if (path === '/rest/v1/conversations') return reply(200, store.get('conversation') ? [store.get('conversation')] : []);
        if (path === '/rest/v1/messages') return reply(200, [...(store.get('messages') ?? [])].reverse());
        if (path === '/functions/v1/voice-session')
        {
            log.voiceStarts.push(body);
            if (body.mode === 'facetime')
            {
                const line = localStorage.getItem('stub.facetimeLine');
                if (!line) return reply(503, { error: { code: 'facetime_not_configured', message: 'The FaceTime line is not set up yet. Use "Call in game" instead.' } });
                return reply(201, { mode: 'facetime', code: '482913', expires_at: new Date(Date.now() + 300_000).toISOString(), line, line_busy: false, npc: { name: 'Sir Sum-a-Lot' } });
            }
            return reply(503, { error: { code: 'voice_not_configured', message: 'FaceTime Tutor is not set up yet.' } });
        }
        if (path === '/functions/v1/npc-chat')
        {
            log.chats++;
            log.chatImages.push(body.images?.[0]?.mime_type ?? body.image?.mime_type ?? '');
            log.chatAttachments.push(body.attachment_ids ?? []);
            log.chatMessageIds.push(body.client_message_id);
            // One-time outage to exercise the retry path (draft + attachments must survive).
            if (localStorage.getItem('stub.failChatOnce')) { localStorage.removeItem('stub.failChatOnce'); return reply(503, { error: { code: 'unavailable', message: 'The AI teacher is unavailable right now. Please try again.', retryable: true } }); }
            const now = new Date().toISOString();
            store.set('conversation', { id: 'cccccccc-0000-4000-8000-000000000001', channel: 'game', created_at: now, updated_at: now, messages: [{ content: body.message }] });
            store.set('messages', [
                { role: 'player', content: body.message, source_refs: [], created_at: now },
                { role: 'npc', content: 'Great question! What is 3/4 + 1/4?', source_refs: [], created_at: now },
            ]);
            const attached = (body.attachment_ids ?? []).map((id: string) => ({ kind: 'document', document_id: id, title: store.get(`doc.${id}`)?.title ?? 'file', chunk_index: 0, attached: true }));
            return reply(200, {
                conversation_id: 'cccccccc-0000-4000-8000-000000000001', reply: 'Great question! What is 3/4 + 1/4?', sources: attached, pages: [],
                knowledge: { attachment: attached.length > 0 || Boolean(body.images?.length), coursework: false, webPage: false, search: false, general: !attached.length },
                memory: { current_topic: 'fractions' },
            });
        }
        return reply(404, { message: `stub: no route for ${request.method} ${path}` });
    };
}
