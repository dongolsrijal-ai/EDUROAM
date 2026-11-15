// LIVE end-to-end check against the real Supabase project in .env.local (NOT part of npm test).
//   node tests/live/liveE2E.mjs
// Creates two real guest (anonymous) accounts, each with Mathematics + Science classes/NPCs and
// one small PDF, then checks auth, RLS isolation, document processing, retrieval and npc-chat.
// Needs "Anonymous sign-ins" enabled. Prints PASS/FAIL lines only (never tokens or keys).
// Test data is tagged game_npc_id "e2e_*"; see BACKEND_HANDOFF.md for clean-up SQL.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const fnUrl = (name) => `${URL_}/functions/v1/${name}`;
const results = [];
const check = (ok, label, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  -> ${detail}` : ''}`); };
const client = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function call (name, token, body)
{
    const res = await fetch(fnUrl(name), {
        method: 'POST',
        headers: { apikey: KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); }
    catch { /* empty */ }
    return { status: res.status, json };
}

function makePdf (lines)
{
    const objects = [];
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = '<< /Type /Pages /Kids [4 0 R] /Count 1 >>';
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    const stream = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((t) => `(${t.replace(/[()\\]/g, '\\$&')}) '`).join(' ')} ET`;
    objects[4] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>';
    objects[5] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    let out = '%PDF-1.4\n';
    const offsets = [];
    for (let id = 1; id < objects.length; id++) { offsets[id] = out.length; out += `${id} 0 obj\n${objects[id]}\nendobj\n`; }
    const xref = out.length;
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

async function signUpGuest (label)
{
    const db = client();
    const { data, error } = await db.auth.signInAnonymously();
    check(!error && data.session, `${label}: guest sign-in`, error?.message);
    return { db, token: data.session?.access_token, id: data.user?.id };
}

/** Exactly what the game's syncNpc does: upsert ... select (INSERT ... ON CONFLICT ... RETURNING). */
async function syncNpc (user, subject, gameId)
{
    const cls = await user.db.from('classes').upsert({ owner_id: user.id, name: subject, subject }, { onConflict: 'owner_id,name_key' }).select('id, name').single();
    const npc = cls.error ? { error: cls.error } : await user.db.from('npcs').upsert({
        owner_id: user.id, class_id: cls.data.id, game_npc_id: gameId, name: `${subject} Teacher`, appearance: 'scientist', subject,
        personality: 'Patient and encouraging', teaching_instructions: '',
    }, { onConflict: 'owner_id,game_npc_id' }).select('id, class_id').single();
    return { classId: cls.data?.id, npcId: npc.data?.id, error: cls.error ?? npc.error };
}

async function upload (user, npcId, visibility, name, lines)
{
    const bytes = makePdf(lines);
    const created = await call('class-documents', user.token, { action: 'create', npc_id: npcId, visibility, file_name: name, mime_type: 'application/pdf', size_bytes: bytes.length });
    if (created.status !== 201) return { created };
    const put = await fetch(created.json.upload.url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'false', apikey: KEY }, body: bytes });
    const processed = await call('class-documents', user.token, { action: 'process', document_id: created.json.document.id });
    return { created, putStatus: put.status, processed, doc: processed.json?.document ?? created.json.document };
}

try
{
    // ---- unauthenticated / invalid credentials
    for (const fn of ['npc-chat', 'class-documents'])
    {
        check((await call(fn, null, {})).status === 401, `${fn}: rejects a request without a user JWT`);
        check((await call(fn, 'not.a.jwt', {})).status === 401, `${fn}: rejects an invalid JWT`);
        check((await call(fn, KEY, {})).status === 401, `${fn}: rejects the publishable key as a bearer token`);
    }
    const anon = client();
    const anonRead = await anon.from('classes').select('id').limit(1);
    check(Boolean(anonRead.error) || anonRead.data.length === 0, 'signed-out visitors cannot read classes');

    // ---- two separate guest players
    const a = await signUpGuest('Player A');
    const b = await signUpGuest('Player B');
    check(a.id && b.id && a.id !== b.id, 'two distinct Supabase users');
    const playerRow = await a.db.from('players').select('id').eq('id', a.id).maybeSingle();
    check(playerRow.data?.id === a.id, 'player row created by trigger for the guest');

    const math = await syncNpc(a, 'Mathematics', 'e2e_math');
    check(!math.error && math.classId && math.npcId, 'A: Mathematics class + NPC via upsert ... RETURNING (RLS fix live)', math.error?.message);
    const again = await syncNpc(a, 'Mathematics', 'e2e_math');
    check(again.npcId === math.npcId && again.classId === math.classId, 'A: re-sync keeps the same class + NPC (no duplicates)');
    const science = await syncNpc(a, 'Science', 'e2e_science');
    check(!science.error && science.classId !== math.classId, 'A: Science NPC in its own class', science.error?.message);
    const owner = await a.db.from('classes').select('owner_id').eq('id', math.classId).single();
    check(owner.data?.owner_id === a.id, 'class owner is the authenticated user id');

    // ---- documents
    const mathDoc = await upload(a, math.npcId, 'class', 'Fractions unit.pdf', ['Fractions unit', 'To add fractions, first find a common denominator.', 'Example: 1/4 + 2/4 = 3/4.']);
    check(mathDoc.created.status === 201 && mathDoc.putStatus === 200, 'A: class PDF upload accepted (signed URL)', `${mathDoc.created.status} ${JSON.stringify(mathDoc.created.json)?.slice(0, 200)} put=${mathDoc.putStatus}`);
    check(mathDoc.doc?.processing_status === 'ready' && mathDoc.doc.chunk_count > 0, 'A: PDF processed to ready with chunks', JSON.stringify(mathDoc.processed?.json)?.slice(0, 300));
    const chunks = await a.db.rpc('match_npc_chunks', { p_npc_id: math.npcId, p_query: 'how do I add fractions', p_limit: 5 });
    check(chunks.data?.some((c) => /common denominator/.test(c.chunk_text) && c.title === 'Fractions unit.pdf'), 'A: retrieval returns the real PDF text + title', chunks.error?.message);
    const scienceChunks = await a.db.rpc('match_npc_chunks', { p_npc_id: science.npcId, p_query: 'fractions denominator', p_limit: 5 });
    check(!scienceChunks.error && scienceChunks.data.length === 0, 'A: Science NPC does not see Mathematics material');

    const badFile = await call('class-documents', a.token, { action: 'create', npc_id: math.npcId, visibility: 'class', file_name: 'virus.exe', mime_type: 'application/octet-stream', size_bytes: 10 });
    check(badFile.status === 400, 'invalid file type rejected', String(badFile.status));

    // ---- isolation from player B
    check((await b.db.from('classes').select('id').eq('id', math.classId)).data?.length === 0, 'B cannot see A\'s class');
    check((await b.db.from('npcs').select('id').eq('id', math.npcId)).data?.length === 0, 'B cannot see A\'s NPC');
    check((await b.db.from('class_documents').select('id').eq('id', mathDoc.doc?.id)).data?.length === 0, 'B cannot see A\'s document');
    check(((await b.db.rpc('match_npc_chunks', { p_npc_id: math.npcId, p_query: 'fractions', p_limit: 5 })).data ?? []).length === 0, 'B retrieves no chunks from A\'s NPC');
    const forged = await b.db.from('classes').insert({ owner_id: a.id, name: 'Forged', subject: 'Forged' });
    check(Boolean(forged.error), 'B cannot create a class owned by A', 'insert succeeded');
    const rpc = await b.db.rpc('can_access_class', { p_class_id: math.classId });
    check(Boolean(rpc.error), 'privileged helper is not an API endpoint any more');
    const fakeMsg = await b.db.from('messages').insert({ conversation_id: math.npcId, role: 'npc', content: 'fake' });
    check(Boolean(fakeMsg.error), 'browser cannot write chat messages directly');
    const steal = await b.db.storage.from('class-materials').download(`${a.id}/${mathDoc.doc?.id}/Fractions_unit.pdf`);
    check(Boolean(steal.error), 'B cannot download A\'s stored file');
    check((await call('class-documents', b.token, { action: 'process', document_id: mathDoc.doc?.id })).status === 404, 'B cannot process A\'s document');
    check((await call('class-documents', b.token, { action: 'create', npc_id: math.npcId, visibility: 'private', file_name: 'x.pdf', mime_type: 'application/pdf', size_bytes: 10 })).status === 404, 'B cannot upload to A\'s NPC');
    check((await call('npc-chat', b.token, { npc_id: math.npcId, message: 'hi' })).status === 404, 'B cannot chat with A\'s NPC');

    // ---- private upload stays private (B's own NPC)
    const bMath = await syncNpc(b, 'Mathematics', 'e2e_math');
    const bPrivate = await upload(b, bMath.npcId, 'private', 'My worksheet.pdf', ['Worksheet question 5: what is 2/3 of 9?']);
    check(bPrivate.doc?.processing_status === 'ready', 'B: private worksheet processed', JSON.stringify(bPrivate.processed?.json)?.slice(0, 200));
    check((await a.db.from('class_documents').select('id').eq('id', bPrivate.doc?.id)).data?.length === 0, 'A cannot see B\'s private worksheet');

    // ---- Gemini through npc-chat
    const chat = await call('npc-chat', a.token, { npc_id: math.npcId, message: 'How do I add fractions? Use my unit notes.', client_message_id: crypto.randomUUID() });
    if (chat.status === 200)
    {
        check(typeof chat.json.reply === 'string' && chat.json.reply.length > 0, 'Gemini reply returned through npc-chat');
        check(chat.json.sources?.some((s) => s.title === 'Fractions unit.pdf'), 'reply cites the uploaded PDF', JSON.stringify(chat.json.sources));
        const history = await a.db.from('messages').select('role').eq('conversation_id', chat.json.conversation_id);
        check(history.data?.length === 2, 'turn saved (player + npc)');
        const memory = await a.db.from('npc_memories').select('npc_id').eq('player_id', a.id);
        check(memory.data?.length === 1 && memory.data[0].npc_id === math.npcId, 'memory saved for this NPC only');
        const sci = await call('npc-chat', a.token, { npc_id: science.npcId, message: 'What did we just study?' });
        check(sci.status === 200 && !(sci.json.sources ?? []).length, 'Science NPC answers without Mathematics sources');
    }
    else
    {
        check(chat.status === 503 && chat.json?.error?.code === 'ai_not_configured', `npc-chat reachable; Gemini not configured (status ${chat.status} ${chat.json?.error?.code})`);
        console.log('BLOCKED  Gemini reply: set the GEMINI_API_KEY Edge Function secret, then rerun.');
    }
}
catch (err)
{
    check(false, 'unexpected error', err?.message ?? String(err));
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} live checks passed`);
process.exitCode = failed ? 1 : 0;
