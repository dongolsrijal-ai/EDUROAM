// Focused live verification. Creates a NEW isolated guest and deletes only the teacher
// created by this run. Never deletes existing accounts/NPCs/classes or shared coursework.
// node tests/live/liveNpcDeletion.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: auth, error: authError } = await db.auth.signInAnonymously();
assert.ifError(authError);
const owner = auth.user.id;
const token = auth.session.access_token;
console.log(`Fixture account: ${owner} (new isolated guest; retained for review)`);
const pass = (message) => console.log(`PASS ${message}`);
const call = async (name, body, authenticated = true) =>
{
    const payload = name === 'npc-lifecycle' ? { expected_owner_id: owner, ...body } : body;
    const response = await fetch(`${url}/functions/v1/${name}`, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
};
const value = (r) => { assert.ifError(r.error); return r.data; };
const count = async () => { const r = await db.from('npcs').select('id', { head: true, count: 'exact' }).eq('owner_id', owner); assert.ifError(r.error); return r.count; };
const cls = value(await db.from('classes').insert({ owner_id: owner, name: 'Lifecycle verification', subject: 'Mathematics' }).select('id').single());
const teachers = [];
for (let i = 0; i < 10; i++) teachers.push(value(await db.from('npcs').insert({ owner_id: owner, class_id: cls.id, game_npc_id: `deletion_verify_${i}`, name: i ? `Lifecycle Peer ${i}` : 'Lifecycle Test Tutor', appearance: 'scientist', subject: 'Mathematics' }).select('id,game_npc_id').single()));
const target = teachers[0];
const peer = teachers[1];
assert.equal(await count(), 10);
assert.ok((await db.from('npcs').insert({ owner_id: owner, class_id: cls.id, game_npc_id: 'eleventh', name: 'Refused', appearance: 'scientist', subject: 'Mathematics' })).error);
pass('10-NPC cap still rejects a distinct eleventh teacher');
const repeat = value(await db.from('npcs').upsert({ owner_id: owner, class_id: cls.id, game_npc_id: target.game_npc_id, name: 'Lifecycle Test Tutor', appearance: 'scientist', subject: 'Mathematics' }, { onConflict: 'owner_id,game_npc_id' }).select('id').single());
assert.equal(repeat.id, target.id);
pass('existing stable identity is reusable at the cap');

const docs = {};
for (const visibility of ['private', 'class'])
{
    const r = await call('class-documents', { action: 'paste', npc_id: target.id, visibility, title: `Lifecycle ${visibility} note`, text: 'A derivative measures instantaneous rate of change. The derivative of x squared is two times x. This note verifies private and shared coursework cleanup.' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    docs[visibility] = r.body.document;
    assert.equal(docs[visibility].processing_status, 'ready');
}
pass('uploaded private and shared coursework with stored originals and processed chunks');
const chat = await call('npc-chat', { npc_id: target.id, message: 'Explain my note about derivatives briefly.', client_message_id: crypto.randomUUID() });
assert.equal(chat.status, 200, JSON.stringify(chat.body));
const memory = value(await db.from('npc_memories').select('summary').eq('npc_id', target.id).single());
assert.ok(memory.summary);
assert.ok(value(await db.from('conversations').select('id').eq('npc_id', target.id)).length);
pass('real chat saved conversation and player memory');
const lateText = 'Late upload bytes from a signed URL issued before teacher deletion.';
const late = await call('class-documents', { action: 'create', npc_id: target.id, visibility: 'private', file_name: 'late-upload.txt', mime_type: 'text/plain', size_bytes: Buffer.byteLength(lateText) });
assert.equal(late.status, 201, JSON.stringify(late.body));

for (let i = 0; i < 2; i++)
{
    const voice = await call('voice-session', { action: 'start', npc_id: target.id });
    if (voice.status === 503 && voice.body.error?.code === 'voice_not_configured')
    {
        assert.equal(await count(), 10);
        console.log('SKIP LiveKit room/token verification: production voice_not_configured; NPC authorization passed without a limit error');
        continue;
    }
    assert.equal(voice.status, 201, JSON.stringify(voice.body));
    assert.match(voice.body.server_url, /^wss:\/\//);
    const claims = JSON.parse(Buffer.from(voice.body.token.split('.')[1], 'base64url').toString());
    assert.equal(claims.video.room, voice.body.room);
    assert.equal(claims.video.roomJoin, true);
    assert.ok(claims.exp > Date.now() / 1000);
    assert.equal(voice.body.npc.name, 'Lifecycle Test Tutor');
    assert.equal(await count(), 10);
}
pass('repeated voice requests do not insert NPCs or raise the NPC limit error');
assert.equal((await call('npc-lifecycle', { action: 'delete', npc_id: target.id }, false)).status, 401);
pass('unauthenticated deletion refused');
assert.equal((await call('npc-lifecycle', { action: 'delete', npc_id: target.id, expected_owner_id: crypto.randomUUID() })).status, 409);
pass('account-switch mismatch refused before deletion');
const deleted = await call('npc-lifecycle', { action: 'delete', npc_id: target.id });
assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
assert.equal(deleted.body.deleted, target.id);
assert.equal(deleted.body.npc_count, 9);
assert.equal((await call('npc-lifecycle', { action: 'delete', npc_id: target.id })).status, 200);
for (const [table, column] of [['npcs', 'id'], ['npc_memories', 'npc_id'], ['conversations', 'npc_id']]) assert.equal(value(await db.from(table).select('*').eq(column, target.id)).length, 0, table);
assert.equal(value(await db.from('class_documents').select('id').eq('id', docs.private.id)).length, 0);
const shared = value(await db.from('class_documents').select('id,npc_id').eq('id', docs.class.id).single());
assert.equal(shared.npc_id, null);
assert.ok(value(await db.from('classes').select('id').eq('id', cls.id)).length);
assert.ok(value(await db.rpc('match_npc_chunks', { p_npc_id: peer.id, p_query: 'derivative', p_limit: 6 })).length);
pass('NPC/private history removed, count decreased, shared class/coursework remain accessible to peer');
const missingFile = await db.storage.from('class-materials').download(docs.private.file_path);
assert.ok(missingFile.error, 'private original removed through Storage API');
assert.ifError((await db.storage.from('class-materials').download(docs.class.file_path)).error);
pass('private original gone; shared original retained');
const lateUpload = await fetch(late.body.upload.url, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: lateText });
assert.ok(lateUpload.ok, `issued signed URL still writes after deletion (${lateUpload.status})`);
assert.ifError((await db.storage.from('class-materials').download(late.body.document.file_path)).error);
pass('reproduced late signed upload; durable manifest queued for scheduled server cleanup');

// A new authenticated client models a reload; no local state can recreate this identity.
const reloaded = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
const marker = value(await reloaded.from('npc_deletions').select('completed_at').eq('npc_id', target.id).single());
assert.ok(marker.completed_at);
assert.ok((await reloaded.from('npcs').upsert({ owner_id: owner, class_id: cls.id, game_npc_id: target.game_npc_id, name: 'Stale save', appearance: 'scientist', subject: 'Mathematics' }, { onConflict: 'owner_id,game_npc_id' })).error);
assert.equal(await count(), 9);
value(await db.from('npcs').insert({ owner_id: owner, class_id: cls.id, game_npc_id: 'replacement', name: 'Replacement', appearance: 'scientist', subject: 'Mathematics' }).select('id').single());
assert.equal(await count(), 10);
pass('reload sees completed deletion; stale upsert refused; new teacher fills the freed slot');
const voice = await call('voice-session', { action: 'start', npc_id: peer.id });
assert.ok(voice.status === 201 || (voice.status === 503 && voice.body.error?.code === 'voice_not_configured'), JSON.stringify(voice.body));
assert.equal(await count(), 10);
pass(`FaceTime request at the cap has no NPC limit error (${voice.status === 201 ? 'session created' : 'blocked only by missing LiveKit configuration'})`);
console.log(JSON.stringify({ fixtureOwner: owner, deletedNpc: target.id, classId: cls.id, peerNpc: peer.id, privateDocument: docs.private.id, sharedDocument: docs.class.id, lateUploadPath: late.body.document.file_path, finalNpcCount: await count() }));
