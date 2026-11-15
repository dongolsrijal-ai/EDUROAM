// Runs the REAL Supabase migration in PGlite (Postgres compiled to WASM) and checks the
// security model: RLS isolation, class/NPC scoped retrieval, private uploads, server-only
// writes, limits, atomic chat-turn saving and rate limiting.
// Supabase-specific pieces (auth.uid, roles, storage) come from tests/support/supabaseShim.sql.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

const file = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const TEACHER = '00000000-0000-4000-8000-00000000000a';
const STUDENT = '00000000-0000-4000-8000-00000000000b';
const OUTSIDER = '00000000-0000-4000-8000-00000000000c';
const BIO_CLASS = '10000000-0000-4000-8000-000000000001';
const HIST_CLASS = '10000000-0000-4000-8000-000000000002';
const BIO_NPC = '20000000-0000-4000-8000-000000000001';
const BIO_NPC_2 = '20000000-0000-4000-8000-000000000003';
const HIST_NPC = '20000000-0000-4000-8000-000000000002';
const BIO_DOC = '30000000-0000-4000-8000-000000000001';
const HIST_DOC = '30000000-0000-4000-8000-000000000002';
const PRIVATE_DOC = '30000000-0000-4000-8000-000000000003';
const PENDING_DOC = '30000000-0000-4000-8000-000000000004';
const OTHER_NPC_DOC = '30000000-0000-4000-8000-000000000005';

let db: PGlite;

type Who = string | 'service';

/** Runs `fn` as a signed-in user (RLS applies) or as the server (service_role). */
async function as<T> (who: Who, fn: (tx: Transaction) => Promise<T>): Promise<T>
{
    return db.transaction(async (tx) =>
    {
        if (who === 'service') await tx.exec('set local role service_role');
        else
        {
            await tx.exec('set local role authenticated');
            await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who]);
        }
        return fn(tx);
    });
}

const rows = async <T = Record<string, unknown>>(who: Who, sql: string, params: unknown[] = []) =>
    as(who, async (tx) => (await tx.query<T>(sql, params)).rows);

const ids = (list: { [k: string]: unknown }[], key = 'id') => list.map((r) => String(r[key])).sort();

test('permanent NPC deletion: owner authorization, retry manifest, cascades, shared files, tombstone and freed slot', async () =>
{
    const owner = crypto.randomUUID();
    const cls = crypto.randomUUID();
    const npc = crypto.randomUUID();
    const peer = crypto.randomUUID();
    const privateDoc = crypto.randomUUID();
    const sharedDoc = crypto.randomUUID();
    const conversation = crypto.randomUUID();
    await db.query('insert into auth.users(id) values ($1)', [owner]);
    await as(owner, async (tx) =>
    {
        await tx.query("insert into public.classes(id,owner_id,name,subject) values ($1,$2,'Deletion test','Math')", [cls, owner]);
        for (let i = 0; i < 10; i++) await tx.query("insert into public.npcs(id,owner_id,class_id,game_npc_id,name,appearance,subject) values ($1,$2,$3,$4,'Teacher','scientist','Math')", [i === 0 ? npc : i === 1 ? peer : crypto.randomUUID(), owner, cls, `delete_test_${i}`]);
    });
    await as('service', async (tx) =>
    {
        for (const [id, visibility] of [[privateDoc, 'private'], [sharedDoc, 'class']])
        {
            await tx.query("insert into public.class_documents(id,class_id,npc_id,uploaded_by,title,file_path,file_type,mime_type,size_bytes,visibility,processing_status) values ($1,$2,$3,$4,'Notes',$5,'txt','text/plain',30,$6,'ready')", [id, cls, npc, owner, `${owner}/${id}/notes.txt`, visibility]);
            await tx.query("insert into public.document_chunks(document_id,class_id,npc_id,chunk_index,chunk_text) values ($1,$2,$3,0,'Coursework survives when shared')", [id, cls, npc]);
        }
        await tx.query("insert into public.conversations(id,player_id,npc_id,channel) values ($1,$2,$3,'game')", [conversation, owner, npc]);
        await tx.query("insert into public.messages(conversation_id,role,content) values ($1,'npc','Saved lesson')", [conversation]);
        await tx.query("insert into public.npc_memories(player_id,npc_id,summary) values ($1,$2,'Keep until confirmed')", [owner, npc]);
        await tx.query('select * from public.create_voice_session($1,$2)', [owner, npc]);
    });
    await assert.rejects(as('service', (tx) => tx.query('select public.prepare_npc_deletion($1,$2)', [OUTSIDER, npc])), /NPC not found/);
    await assert.rejects(as(owner, (tx) => tx.query('select public.prepare_npc_deletion($1,$2)', [owner, npc])), /permission denied/);
    await assert.rejects(as(owner, (tx) => tx.query('delete from public.npcs where id=$1', [npc])), /permission denied/);
    const prepared = await rows<{ job: { file_paths: string[]; room_names: string[] } }>('service', 'select public.prepare_npc_deletion($1,$2) as job', [owner, npc]);
    assert.deepEqual(prepared[0].job.file_paths, [`${owner}/${privateDoc}/notes.txt`]);
    await assert.rejects(as(owner, (tx) => tx.query('select file_paths from public.npc_deletions')), /permission denied/, 'private upload paths are server-only, even for the teacher owner');
    assert.equal(prepared[0].job.room_names.length, 1);
    assert.equal((await rows(owner, 'select id from public.npcs where id=$1', [npc])).length, 1, 'cleanup failure retains local/server NPC and history for retry');
    assert.equal((await rows(owner, 'select summary from public.npc_memories where npc_id=$1', [npc])).length, 1);
    assert.deepEqual(await rows('service', 'select public.prepare_npc_deletion($1,$2) as job', [owner, npc]), prepared, 'retry retains the cleanup manifest');
    await assert.rejects(as('service', (tx) => tx.query('select * from public.create_voice_session($1,$2)', [owner, npc])), /delet/i);
    await assert.rejects(as(owner, (tx) => tx.query("update public.npcs set name='Stale update' where id=$1", [npc])), /delet/i);
    await assert.rejects(as('service', (tx) => tx.query("insert into public.class_documents(class_id,npc_id,uploaded_by,title,file_path,file_type,mime_type,size_bytes,visibility) values ($1,$2,$3,'Late','late.txt','txt','text/plain',30,'private')", [cls, npc, owner])), /delet/i);
    await rows('service', 'select public.finish_npc_deletion($1,$2)', [owner, npc]);
    await rows('service', 'select public.finish_npc_deletion($1,$2)', [owner, npc]);
    for (const table of ['npcs', 'npc_memories', 'conversations', 'voice_sessions'])
        assert.equal((await rows('service', `select * from public.${table} where ${table === 'npcs' ? 'id' : 'npc_id'}=$1`, [npc])).length, 0, table);
    assert.equal((await rows('service', 'select id from public.messages where conversation_id=$1', [conversation])).length, 0);
    assert.equal((await rows('service', 'select id from public.class_documents where id=$1', [privateDoc])).length, 0);
    assert.equal((await rows(owner, 'select id from public.classes where id=$1', [cls])).length, 1);
    assert.equal((await rows(owner, 'select id from public.npcs where id=$1', [peer])).length, 1);
    assert.equal((await rows(owner, 'select npc_id from public.class_documents where id=$1', [sharedDoc]))[0].npc_id, null);
    assert.equal((await rows(owner, 'select npc_id from public.document_chunks where document_id=$1', [sharedDoc]))[0].npc_id, null);
    // An extractor that started before deletion must derive the document's CURRENT scope.
    await rows('service', 'select public.replace_document_chunks($1,$2::jsonb)', [sharedDoc, JSON.stringify([{ chunk_index: 0, chunk_text: 'Coursework still usable after an in-flight extraction', source: {} }])]);
    assert.equal((await rows(owner, 'select npc_id from public.document_chunks where document_id=$1', [sharedDoc]))[0].npc_id, null);
    assert.equal((await rows(owner, "select * from public.match_npc_chunks($1,'Coursework',6)", [peer])).length, 1, 'remaining teacher can use shared coursework');
    await assert.rejects(as(owner, (tx) => tx.query("insert into public.npcs(owner_id,class_id,game_npc_id,name,appearance,subject) values ($1,$2,'delete_test_0','Resurrected','scientist','Math')", [owner, cls])), /permanently deleted/);
    await as(owner, (tx) => tx.query("insert into public.npcs(owner_id,class_id,game_npc_id,name,appearance,subject) values ($1,$2,'replacement','Replacement','scientist','Math')", [owner, cls]));
    assert.equal((await rows(owner, 'select id from public.npcs where owner_id=$1', [owner])).length, 10);
    await assert.rejects(as(owner, (tx) => tx.query("insert into public.npcs(owner_id,class_id,game_npc_id,name,appearance,subject) values ($1,$2,'eleventh','No room','scientist','Math')", [owner, cls])), /NPC limit reached/);
    await rows('service', 'select public.discard_local_npc($1,$2)', [owner, 'offline_teacher']);
    await assert.rejects(as(owner, (tx) => tx.query("insert into public.npcs(owner_id,class_id,game_npc_id,name,appearance,subject) values ($1,$2,'offline_teacher','Stale offline','scientist','Math')", [owner, cls])), /permanently deleted/);
    assert.equal((await rows(OUTSIDER, 'select npc_id from public.npc_deletions where owner_id=$1', [owner])).length, 0, 'tombstones are account-private');
    await assert.rejects(as('service', (tx) => tx.query('select public.finish_npc_deletion($1,$2)', [OUTSIDER, npc])), /NPC not found/);
});

before(async () =>
{
    db = new PGlite({ extensions: { vector } });
    await db.exec(file('./support/supabaseShim.sql'));
    // Every migration, in order (as `supabase db push` applies them).
    for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort())
    {
        await db.exec(file(`../supabase/migrations/${name}`));
    }

    // Auth users (players rows come from the trigger).
    await db.query(`insert into auth.users (id) values ($1), ($2), ($3)`, [TEACHER, STUDENT, OUTSIDER]);

    // Teacher config through the browser path (RLS insert policies).
    await as(TEACHER, async (tx) =>
    {
        await tx.query(`insert into public.classes (id, owner_id, name, subject) values ($1, $3, 'Biology', 'Biology'), ($2, $3, 'History', 'History')`, [BIO_CLASS, HIST_CLASS, TEACHER]);
        await tx.query(`insert into public.npcs (id, owner_id, class_id, game_npc_id, name, appearance, subject) values
            ($1, $4, $5, 'npc_bio', 'Professor Bob', 'scientist', 'Biology'),
            ($2, $4, $5, 'npc_bio2', 'Doctor Fern', 'scientist', 'Biology'),
            ($3, $4, $6, 'npc_hist', 'Lady Chronos', 'knight', 'History')`, [BIO_NPC, BIO_NPC_2, HIST_NPC, TEACHER, BIO_CLASS, HIST_CLASS]);
    });

    // Server-side writes (the class-documents function after verifying the caller).
    await as('service', async (tx) =>
    {
        await tx.query(`insert into public.class_members (class_id, player_id) values ($1, $2)`, [BIO_CLASS, STUDENT]);
        const doc = `insert into public.class_documents (id, class_id, npc_id, uploaded_by, title, file_path, file_type, mime_type, size_bytes, visibility, processing_status)
            values ($1, $2, $3, $4, $5, $6, 'pdf', 'application/pdf', 1000, $7, $8)`;
        await tx.query(doc, [BIO_DOC, BIO_CLASS, BIO_NPC, TEACHER, 'Photosynthesis.pdf', `${TEACHER}/${BIO_DOC}/p.pdf`, 'class', 'ready']);
        await tx.query(doc, [HIST_DOC, HIST_CLASS, HIST_NPC, TEACHER, 'Rome.pdf', `${TEACHER}/${HIST_DOC}/r.pdf`, 'class', 'ready']);
        await tx.query(doc, [PRIVATE_DOC, BIO_CLASS, BIO_NPC, STUDENT, 'My worksheet.pdf', `${STUDENT}/${PRIVATE_DOC}/w.pdf`, 'private', 'ready']);
        await tx.query(doc, [PENDING_DOC, BIO_CLASS, BIO_NPC, TEACHER, 'Cells.pdf', `${TEACHER}/${PENDING_DOC}/c.pdf`, 'class', 'pending']);
        await tx.query(doc, [OTHER_NPC_DOC, BIO_CLASS, BIO_NPC_2, TEACHER, 'Fern notes.pdf', `${TEACHER}/${OTHER_NPC_DOC}/f.pdf`, 'class', 'ready']);
        const chunk = `insert into public.document_chunks (document_id, class_id, npc_id, chunk_index, chunk_text) values ($1, $2, $3, $4, $5)`;
        await tx.query(chunk, [BIO_DOC, BIO_CLASS, BIO_NPC, 0, 'Photosynthesis converts light energy into chemical energy in the chloroplast.']);
        await tx.query(chunk, [BIO_DOC, BIO_CLASS, BIO_NPC, 1, 'Mitochondria release energy through cellular respiration.']);
        await tx.query(chunk, [HIST_DOC, HIST_CLASS, HIST_NPC, 0, 'The Roman Republic became an empire under Augustus; photosynthesis is not history.']);
        await tx.query(chunk, [PRIVATE_DOC, BIO_CLASS, BIO_NPC, 0, 'Question 5: explain why leaves are green during photosynthesis.']);
        await tx.query(chunk, [PENDING_DOC, BIO_CLASS, BIO_NPC, 0, 'Cells pending chunk photosynthesis (should never be used).']);
        await tx.query(chunk, [OTHER_NPC_DOC, BIO_CLASS, BIO_NPC_2, 0, "Fern's own photosynthesis notes for her NPC only."]);
    });
});

const match = (who: Who, npc: string, query: string, playerId: string | null = null) =>
    rows<{ document_id: string; title: string }>(who, `select * from public.match_npc_chunks($1, $2, 12, $3)`, [npc, query, playerId]);

test('retrieval returns only the NPC class, ready documents and the caller\'s own private uploads', async () =>
{
    const teacher = await match(TEACHER, BIO_NPC, 'photosynthesis light');
    assert.deepEqual([...new Set(teacher.map((r) => r.document_id))].sort(), [BIO_DOC]);
    assert.match(teacher[0].title, /Photosynthesis/);

    const student = await match(STUDENT, BIO_NPC, 'photosynthesis');
    assert.deepEqual([...new Set(student.map((r) => r.document_id))].sort(), [BIO_DOC, PRIVATE_DOC].sort());

    // History NPC never sees biology material and vice versa.
    const history = await match(TEACHER, HIST_NPC, 'photosynthesis');
    assert.deepEqual([...new Set(history.map((r) => r.document_id))], [HIST_DOC]);

    // Another NPC of the same class does not get Professor Bob's NPC-scoped material.
    const fern = await match(TEACHER, BIO_NPC_2, 'photosynthesis');
    assert.deepEqual([...new Set(fern.map((r) => r.document_id))], [OTHER_NPC_DOC]);
});

test('relevant chunks rank first; unrelated queries fall back to the newest material', async () =>
{
    const energy = await rows<{ chunk_text: string }>(TEACHER, `select chunk_text from public.match_npc_chunks($1, 'cellular respiration mitochondria', 12)`, [BIO_NPC]);
    assert.match(energy[0].chunk_text, /Mitochondria/);
    const vague = await match(TEACHER, BIO_NPC, 'explain this');
    assert.ok(vague.length > 0, 'still returns material for vague requests');
});

test('a signed-in caller cannot borrow another player\'s private uploads via p_player_id', async () =>
{
    const spoofed = await match(TEACHER, BIO_NPC, 'photosynthesis', STUDENT);
    assert.ok(!spoofed.some((r) => r.document_id === PRIVATE_DOC));
    // A server agent (no JWT) that resolved the player through a verified pairing does get them.
    const server = await match('service', BIO_NPC, 'photosynthesis', STUDENT);
    assert.ok(server.some((r) => r.document_id === PRIVATE_DOC));
});

test('outsiders see no NPCs, classes, documents or chunks', async () =>
{
    assert.equal((await rows(OUTSIDER, 'select id from public.npcs')).length, 0);
    assert.equal((await rows(OUTSIDER, 'select id from public.classes')).length, 0);
    assert.equal((await rows(OUTSIDER, 'select id from public.class_documents')).length, 0);
    assert.equal((await rows(OUTSIDER, 'select id from public.document_chunks')).length, 0);
    assert.equal((await match(OUTSIDER, BIO_NPC, 'photosynthesis')).length, 0);
});

test('class members see class material but a teacher never sees a student\'s private upload', async () =>
{
    const teacherDocs = ids(await rows(TEACHER, 'select id from public.class_documents'));
    assert.ok(!teacherDocs.includes(PRIVATE_DOC));
    const studentDocs = ids(await rows(STUDENT, 'select id from public.class_documents'));
    assert.deepEqual(studentDocs, [BIO_DOC, PRIVATE_DOC, PENDING_DOC, OTHER_NPC_DOC].sort());
    assert.ok(!studentDocs.includes(HIST_DOC), 'student is not in the History class');
});

test('browsers cannot write documents, chunks, messages or memory, nor mark documents ready', async () =>
{
    await assert.rejects(as(STUDENT, (tx) => tx.query(
        `insert into public.class_documents (class_id, npc_id, uploaded_by, title, file_path, file_type, mime_type, size_bytes, visibility, processing_status)
         values ($1, $2, $3, 'x', 'x', 'txt', 'text/plain', 1, 'private', 'ready')`, [BIO_CLASS, BIO_NPC, STUDENT])), /permission denied/);
    await assert.rejects(as(TEACHER, (tx) => tx.query(`update public.class_documents set processing_status = 'ready' where id = $1`, [PENDING_DOC])), /permission denied/);
    await assert.rejects(as(STUDENT, (tx) => tx.query(`insert into public.document_chunks (document_id, class_id, chunk_index, chunk_text) values ($1, $2, 9, 'x')`, [BIO_DOC, BIO_CLASS])), /permission denied/);
    await assert.rejects(as(STUDENT, (tx) => tx.query(`insert into public.npc_memories (player_id, npc_id) values ($1, $2)`, [STUDENT, BIO_NPC])), /permission denied/);
    await assert.rejects(as(STUDENT, (tx) => tx.query(`select public.save_tutor_turn($1, $2, null, 'game', 'hi', null, 'fake reply', '[]', '{}', '{}')`, [STUDENT, BIO_NPC])), /permission denied/);
    await assert.rejects(as(STUDENT, (tx) => tx.query(`select public.consume_rate_limit($1, 'x', 1, 60)`, [STUDENT])), /permission denied/);
});

test('players can only create NPCs for themselves, in their own classes', async () =>
{
    await assert.rejects(as(STUDENT, (tx) => tx.query(
        `insert into public.npcs (owner_id, class_id, game_npc_id, name, appearance, subject) values ($1, $2, 'x', 'Spy', 'knight', 'Biology')`, [TEACHER, BIO_CLASS])), /row-level security/);
    // Own row, but someone else's class: blocked by the (class_id, owner_id) foreign key.
    await assert.rejects(as(STUDENT, (tx) => tx.query(
        `insert into public.npcs (owner_id, class_id, game_npc_id, name, appearance, subject) values ($1, $2, 'x', 'Spy', 'knight', 'Biology')`, [STUDENT, BIO_CLASS])), /foreign key/);
    await assert.rejects(as(STUDENT, (tx) => tx.query(`update public.npcs set name = 'Hacked' where id = $1 returning id`, [BIO_NPC]).then((r) =>
    {
        if (!r.rows.length) throw new Error('no rows updated');
    })), /no rows updated/);
});

test('the 10-NPC limit is enforced server-side', async () =>
{
    const owner = '00000000-0000-4000-8000-0000000000dd';
    await db.query('insert into auth.users (id) values ($1)', [owner]);
    await as(owner, async (tx) =>
    {
        for (let i = 0; i < 11; i++) await tx.query(`insert into public.classes (owner_id, name, subject) values ($1, $2, $2)`, [owner, `Class ${i}`]);
    });
    const classes = await rows<{ id: string }>(owner, 'select id from public.classes order by name');
    const addNpc = (i: number, classId: string) => as(owner, (tx) => tx.query(
        `insert into public.npcs (owner_id, class_id, game_npc_id, name, appearance, subject) values ($1, $2, $3, $3, 'knight', 'x')`, [owner, classId, `n${i}`]));
    for (let i = 0; i < 9; i++) await addNpc(i, classes[i].id);
    await assert.rejects(addNpc(9, classes[10].id).then(() => addNpc(10, classes[0].id)), /NPC limit reached/);
    const count = await rows(owner, 'select id from public.npcs');
    assert.equal(count.length, 10);
    // Editing an existing NPC at the limit still works.
    await as(owner, (tx) => tx.query(`update public.npcs set name = 'Renamed' where game_npc_id = 'n0'`));
});

test('chat turns save atomically and memory stays private per player and NPC', async () =>
{
    const memory = JSON.stringify({ summary: 'Studied photosynthesis.', current_topic: 'photosynthesis', topics_studied: ['photosynthesis'], learning_preferences: ['short answers'] });
    const progress = JSON.stringify({ topics_mastered: ['chlorophyll'], topics_needing_practice: ['light reactions'] });
    const conversationId = (await rows<{ id: string }>('service',
        `select public.save_tutor_turn($1, $2, null, 'game', 'What is photosynthesis?', $3, 'Plants turn light into sugar!', $4, $5, $6) as id`,
        [STUDENT, BIO_NPC, '40000000-0000-4000-8000-000000000001', JSON.stringify([{ document_id: BIO_DOC, title: 'Photosynthesis.pdf', chunk_index: 0 }]), memory, progress]))[0].id;

    // Continue the same conversation from another channel later (e.g. FaceTime) => new conversation, same memory row.
    await rows('service', `select public.save_tutor_turn($1, $2, $3, 'game', 'And chlorophyll?', null, 'It absorbs light.', '[]', $4, $5)`,
        [STUDENT, BIO_NPC, conversationId, memory, progress]);
    await rows('service', `select public.save_tutor_turn($1, $2, null, 'facetime', 'Quiz me', null, 'Sure!', '[]', $3, $4)`,
        [STUDENT, BIO_NPC, memory, progress]);

    const messages = await rows<{ role: string; content: string; source_refs: unknown[] }>(STUDENT,
        `select m.role, m.content, m.source_refs from public.messages m where m.conversation_id = $1 order by m.created_at`, [conversationId]);
    assert.deepEqual(messages.map((m) => m.role), ['player', 'npc', 'player', 'npc']);
    assert.equal(messages[1].source_refs.length, 1);

    const mem = await rows<{ summary: string; channels_used: string[] }>(STUDENT, `select summary, channels_used from public.npc_memories where npc_id = $1`, [BIO_NPC]);
    assert.equal(mem.length, 1);
    assert.deepEqual(mem[0].channels_used.sort(), ['facetime', 'game']);
    const prog = await rows<{ topics_mastered: string[] }>(STUDENT, `select topics_mastered from public.class_progress where class_id = $1`, [BIO_CLASS]);
    assert.deepEqual(prog[0].topics_mastered, ['chlorophyll']);

    // Nobody else can read them, including the teacher who owns the NPC.
    for (const who of [TEACHER, OUTSIDER])
    {
        assert.equal((await rows(who, 'select id from public.messages')).length, 0);
        assert.equal((await rows(who, 'select id from public.conversations')).length, 0);
        assert.equal((await rows(who, 'select id from public.npc_memories')).length, 0);
        assert.equal((await rows(who, 'select id from public.class_progress')).length, 0);
    }

    // A conversation can't be continued under another player or NPC.
    await assert.rejects(rows('service', `select public.save_tutor_turn($1, $2, $3, 'game', 'x', null, 'y', '[]', '{}', '{}')`, [TEACHER, BIO_NPC, conversationId]), /Conversation not found/);
    await assert.rejects(rows('service', `select public.save_tutor_turn($1, $2, $3, 'game', 'x', null, 'y', '[]', '{}', '{}')`, [STUDENT, HIST_NPC, conversationId]), /Conversation not found/);
    // Duplicate client message ids are rejected (no double-saved retries) and nothing partial is written.
    await assert.rejects(rows('service', `select public.save_tutor_turn($1, $2, $3, 'game', 'dup', $4, 'y', '[]', '{}', '{}')`,
        [STUDENT, BIO_NPC, conversationId, '40000000-0000-4000-8000-000000000001']), /duplicate key/);
    assert.equal((await rows(STUDENT, `select id from public.messages where conversation_id = $1`, [conversationId])).length, 4);
});

test('rate limits allow up to the maximum per window', async () =>
{
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await rows<{ ok: boolean }>('service', `select public.consume_rate_limit($1, 'test', 3, 60) as ok`, [STUDENT]))[0].ok);
    assert.deepEqual(results, [true, true, true, false]);
});

test('private documents must be NPC-scoped and NPC documents must match the NPC class', async () =>
{
    await assert.rejects(rows('service', `insert into public.class_documents (class_id, npc_id, uploaded_by, title, file_path, file_type, mime_type, size_bytes, visibility)
        values ($1, null, $2, 't', 'p1', 'txt', 'text/plain', 1, 'private')`, [BIO_CLASS, STUDENT]), /check constraint/);
    await assert.rejects(rows('service', `insert into public.class_documents (class_id, npc_id, uploaded_by, title, file_path, file_type, mime_type, size_bytes, visibility)
        values ($1, $2, $3, 't', 'p2', 'txt', 'text/plain', 1, 'class')`, [HIST_CLASS, BIO_NPC, TEACHER]), /foreign key/);
});

test('players can rename themselves but not change their id; storage reads are limited to own folder', async () =>
{
    await as(STUDENT, (tx) => tx.query(`update public.players set display_name = 'Ada' where id = $1`, [STUDENT]));
    assert.equal((await rows<{ display_name: string }>(STUDENT, 'select display_name from public.players'))[0].display_name, 'Ada');
    await assert.rejects(as(STUDENT, (tx) => tx.query(`update public.players set id = $1 where id = $2`, [OUTSIDER, STUDENT])), /permission denied/);
    assert.equal((await rows(STUDENT, 'select id from public.players')).length, 1, 'only own player row is visible');

    await rows('service', `insert into storage.objects (bucket_id, name) values ('class-materials', $1), ('class-materials', $2)`,
        [`${STUDENT}/${PRIVATE_DOC}/w.pdf`, `${TEACHER}/${BIO_DOC}/p.pdf`]);
    const visible = await rows<{ name: string }>(STUDENT, 'select name from storage.objects');
    assert.deepEqual(visible.map((o) => o.name), [`${STUDENT}/${PRIVATE_DOC}/w.pdf`]);
    const bucket = (await rows<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>('service', `select * from storage.buckets where id = 'class-materials'`))[0];
    assert.equal(bucket.public, false);
    assert.equal(Number(bucket.file_size_limit), 10 * 1024 * 1024);
    assert.ok(bucket.allowed_mime_types.includes("application/pdf"));
});

test('moving an NPC to another class takes its documents and chunks along', async () =>
{
    const owner = '00000000-0000-4000-8000-0000000000ff';
    const [classA, classB, npc, doc] = ['50000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-00000000000b', '50000000-0000-4000-8000-00000000000c', '50000000-0000-4000-8000-00000000000d'];
    await db.query('insert into auth.users (id) values ($1)', [owner]);
    await as(owner, async (tx) =>
    {
        await tx.query(`insert into public.classes (id, owner_id, name, subject) values ($1, $3, 'Chem', 'Chem'), ($2, $3, 'Physics', 'Physics')`, [classA, classB, owner]);
        await tx.query(`insert into public.npcs (id, owner_id, class_id, game_npc_id, name, appearance, subject) values ($1, $2, $3, 'm', 'M', 'knight', 'Chem')`, [npc, owner, classA]);
    });
    await rows('service', `insert into public.class_documents (id, class_id, npc_id, uploaded_by, title, file_path, file_type, mime_type, size_bytes, visibility, processing_status)
        values ($1, $2, $3, $4, 'Atoms', 'pa', 'txt', 'text/plain', 1, 'class', 'ready')`, [doc, classA, npc, owner]);
    await rows('service', `insert into public.document_chunks (document_id, class_id, npc_id, chunk_index, chunk_text) values ($1, $2, $3, 0, 'atoms and electrons')`, [doc, classA, npc]);
    await as(owner, (tx) => tx.query(`update public.npcs set class_id = $1, subject = 'Physics' where id = $2`, [classB, npc]));
    assert.equal((await match(owner, npc, 'atoms')).length, 1);
    assert.equal((await rows<{ class_id: string }>('service', 'select class_id from public.document_chunks where document_id = $1', [doc]))[0].class_id, classB);
});

test('signed-in browser upserts (INSERT ... RETURNING) create a Mathematics class + NPC owned by the auth user', async () =>
{
    // Exactly what supabase-js .upsert(...).select() sends through PostgREST, as the signed-in user.
    const mathTeacher = '00000000-0000-4000-8000-0000000000a1';
    const otherPlayer = '00000000-0000-4000-8000-0000000000b1';
    await db.query('insert into auth.users (id) values ($1), ($2)', [mathTeacher, otherPlayer]);
    const upsertClass = `insert into public.classes (owner_id, name, subject) values ($1, 'Mathematics', 'Mathematics')
        on conflict (owner_id, name_key) do update set owner_id = excluded.owner_id, name = excluded.name, subject = excluded.subject
        returning id, name`;
    const [cls] = await rows<{ id: string; name: string }>(mathTeacher, upsertClass, [mathTeacher]);
    assert.equal(cls.name, 'Mathematics');
    // Re-syncing the same NPC later (conflict path) also passes RLS and keeps the same class.
    assert.equal((await rows<{ id: string }>(mathTeacher, upsertClass, [mathTeacher]))[0].id, cls.id);

    const upsertNpc = `insert into public.npcs (owner_id, class_id, game_npc_id, name, appearance, subject, personality, teaching_instructions)
        values ($1, $2, 'npc_math', 'Sir Sum-a-Lot', 'knight', 'Mathematics', '', '')
        on conflict (owner_id, game_npc_id) do update set class_id = excluded.class_id, name = excluded.name
        returning id, class_id`;
    const [npc] = await rows<{ id: string; class_id: string }>(mathTeacher, upsertNpc, [mathTeacher, cls.id]);
    assert.equal(npc.class_id, cls.id);

    // The class is owned by the verified auth user, never a local "player_..." id.
    const owner = await rows<{ owner_id: string }>('service', 'select owner_id from public.classes where id = $1', [cls.id]);
    assert.equal(owner[0].owner_id, mathTeacher);

    // A browser can't create a class for someone else (RLS still blocks it), nor without signing in.
    await assert.rejects(rows(otherPlayer, upsertClass, [mathTeacher]), /row-level security/);
    await assert.rejects(db.transaction(async (tx) =>
    {
        await tx.exec('set local role anon');
        await tx.query(upsertClass, [mathTeacher]);
    }), /permission denied/);

    // Class document upload (class-documents function, after it verified the teacher).
    const doc = '60000000-0000-4000-8000-000000000001';
    await rows('service', `insert into public.class_documents (id, class_id, npc_id, uploaded_by, title, file_path, file_type, mime_type, size_bytes, visibility, processing_status)
        values ($1, $2, $3, $4, 'Fractions.pdf', $5, 'pdf', 'application/pdf', 100, 'class', 'ready')`, [doc, cls.id, npc.id, mathTeacher, `${mathTeacher}/${doc}/Fractions.pdf`]);
    await rows('service', `insert into public.document_chunks (document_id, class_id, npc_id, chunk_index, chunk_text) values ($1, $2, $3, 0, 'To add fractions, find a common denominator.')`, [doc, cls.id, npc.id]);

    const own = await rows<{ title: string }>(mathTeacher, 'select title from public.match_npc_chunks($1, $2, 6)', [npc.id, 'add fractions']);
    assert.deepEqual(own.map((r) => r.title), ['Fractions.pdf']);
    // Another player (not enrolled) sees nothing of this class.
    assert.equal((await rows(otherPlayer, 'select id from public.classes where id = $1', [cls.id])).length, 0);
    assert.equal((await rows(otherPlayer, 'select id from public.npcs where id = $1', [npc.id])).length, 0);
    assert.equal((await rows(otherPlayer, 'select id from public.class_documents where id = $1', [doc])).length, 0);
    assert.equal((await rows(otherPlayer, 'select id from public.document_chunks where document_id = $1', [doc])).length, 0);
    assert.equal((await rows(otherPlayer, 'select * from public.match_npc_chunks($1, $2, 6)', [npc.id, 'fractions'])).length, 0);
});

test('privileged helper functions are not callable through the API, yet RLS and triggers still work', async () =>
{
    // The old public RPC endpoints are gone; the private schema is not usable by anon.
    await assert.rejects(rows(STUDENT, 'select public.can_access_class($1)', [BIO_CLASS]), /does not exist/);
    await assert.rejects(db.transaction(async (tx) =>
    {
        await tx.exec('set local role anon');
        await tx.query('select private.can_access_class($1)', [BIO_CLASS]);
    }), /permission denied/);
    // Trigger functions cannot be invoked directly by API roles...
    for (const fn of ['handle_new_auth_user', 'set_updated_at', 'enforce_npc_limits', 'enforce_class_limit'])
    {
        const granted = await rows<{ ok: boolean }>('service', `select has_function_privilege('authenticated', 'public.${fn}()', 'execute') as ok`);
        assert.equal(granted[0].ok, false, `${fn} not executable by authenticated`);
    }
    // ...but they still fire: a new auth user gets a player row, and an authenticated update runs triggers.
    const fresh = '00000000-0000-4000-8000-0000000000f1';
    await db.query('insert into auth.users (id) values ($1)', [fresh]);
    assert.equal((await rows('service', 'select id from public.players where id = $1', [fresh])).length, 1);
    await as(TEACHER, (tx) => tx.query(`update public.npcs set name = 'Professor Robert' where id = $1`, [BIO_NPC]));
    // Membership-based access (through the private helpers) is unchanged.
    assert.deepEqual(ids(await rows(STUDENT, 'select id from public.classes')), [BIO_CLASS]);
});

test('mini-game sessions: answer keys hidden, own rows only, first answer wins, no browser writes', async () =>
{
    const questions = JSON.stringify([
        { question: 'Q1?', choices: ['a', 'b', 'c', 'd'], correctIndex: 2, explanation: 'because', topic: 't', difficulty: 'intro', source: null },
        { question: 'Q2?', choices: ['a', 'b', 'c', 'd'], correctIndex: 0, explanation: 'because', topic: 't', difficulty: 'intro', source: null },
    ]);
    const [{ id }] = await rows<{ id: string }>('service', `insert into public.minigame_sessions (player_id, npc_id, class_id, game_type, source_mode, pack_hash, questions)
        values ($1, $2, $3, 'answer_dash', 'documents', 'h', $4) returning id`, [STUDENT, BIO_NPC, BIO_CLASS, questions]);

    // Own row visible (summary columns), answer keys not readable, others see nothing.
    assert.equal((await rows(STUDENT, 'select id, score, status from public.minigame_sessions')).length, 1);
    await assert.rejects(rows(STUDENT, 'select questions from public.minigame_sessions'), /permission denied/);
    await assert.rejects(rows(STUDENT, 'select answers from public.minigame_sessions'), /permission denied/);
    assert.equal((await rows(TEACHER, 'select id from public.minigame_sessions')).length, 0);
    assert.equal((await rows(OUTSIDER, 'select id from public.minigame_sessions')).length, 0);

    // Browsers cannot forge results or call the server function.
    await assert.rejects(rows(STUDENT, `update public.minigame_sessions set score = 9999 where id = $1`, [id]), /permission denied/);
    await assert.rejects(rows(STUDENT, `insert into public.minigame_sessions (player_id, npc_id, game_type, source_mode, pack_hash, questions) values ($1, $2, 'answer_dash', 'subject', 'x', '[]')`, [STUDENT, BIO_NPC]), /permission denied/);
    await assert.rejects(rows(STUDENT, 'select public.record_minigame_answer($1, $2, 0, 1)', [id, STUDENT]), /permission denied/);

    // Server records the FIRST answer only; wrong player or out-of-range index changes nothing.
    const answer = (player: string, index: number, choice: number) =>
        rows<{ a: Record<string, number> | null }>('service', 'select public.record_minigame_answer($1, $2, $3, $4) as a', [id, player, index, choice]).then((r) => r[0].a);
    assert.deepEqual(await answer(STUDENT, 0, 2), { 0: 2 });
    assert.deepEqual(await answer(STUDENT, 0, 1), { 0: 2 }, 'retry cannot change the first answer');
    assert.deepEqual(await answer(STUDENT, 5, 1), { 0: 2 }, 'no such question');
    assert.equal(await answer(TEACHER, 1, 0), null, 'another player cannot answer this session');
    assert.deepEqual(await answer(STUDENT, 1, 4), { 0: 2 }, 'choice outside a 4-choice question');
    await rows('service', `update public.minigame_sessions set status = 'completed' where id = $1`, [id]);
    assert.deepEqual(await answer(STUDENT, 1, 0), { 0: 2 }, 'completed sessions accept no answers');

    // Spellshot: its own game type; the valid choice range comes from each stored question.
    const shotQuestions = JSON.stringify([
        { question: 'S1?', choices: ['a', 'b', 'c', 'd', 'e'], correctIndex: 4, explanation: 'e', topic: 't', difficulty: 'intro', source: null },
        { question: 'S2?', choices: ['a', 'b', 'c'], correctIndex: 1, explanation: 'e', topic: 't', difficulty: 'intro', source: null },
    ]);
    const [{ id: shotId }] = await rows<{ id: string }>('service', `insert into public.minigame_sessions (player_id, npc_id, class_id, game_type, source_mode, pack_hash, questions)
        values ($1, $2, $3, 'spellshot', 'documents', 'h', $4) returning id`, [STUDENT, BIO_NPC, BIO_CLASS, shotQuestions]);
    const shoot = (index: number, choice: number) =>
        rows<{ a: Record<string, number> | null }>('service', 'select public.record_minigame_answer($1, $2, $3, $4) as a', [shotId, STUDENT, index, choice]).then((r) => r[0].a);
    assert.deepEqual(await shoot(0, 4), { 0: 4 }, 'fifth target is valid on a 5-choice question');
    assert.deepEqual(await shoot(1, 3), { 0: 4 }, 'out of range on a 3-choice question');
    assert.deepEqual(await shoot(1, 2), { 0: 4, 1: 2 });
    await assert.rejects(rows('service', `insert into public.minigame_sessions (player_id, npc_id, game_type, source_mode, pack_hash, questions)
        values ($1, $2, 'blast', 'documents', 'h', '[]')`, [STUDENT, BIO_NPC]), /check constraint/);
});

test('coursework library migration: image + pasted types allowed, metadata defaults, bucket stays private', async () =>
{
    const insert = (type: string, path: string) => rows('service', `insert into public.class_documents (class_id, npc_id, uploaded_by, title, file_path, file_type, mime_type, size_bytes, visibility)
        values ($1, $2, $3, 't', $4, $5, 'image/png', 1, 'private') returning topic, chapter, extraction`, [BIO_CLASS, BIO_NPC, STUDENT, path, type]);
    for (const type of ['png', 'jpeg', 'webp', 'heic', 'text']) assert.equal((await insert(type, `p-${type}`)).length, 1);
    const [row] = await insert('pdf', 'p-pdf') as { topic: string; chapter: string; extraction: unknown }[];
    assert.deepEqual([row.topic, row.chapter, row.extraction], ['', '', {}]);
    await assert.rejects(insert('exe', 'p-exe'), /check constraint/);
    const bucket = (await rows<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>('service', `select * from storage.buckets where id = 'class-materials'`))[0];
    assert.equal(bucket.public, false);
    assert.equal(Number(bucket.file_size_limit), 10 * 1024 * 1024);
    assert.ok(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/pdf'].every((m) => bucket.allowed_mime_types.includes(m)));
});

test('teaching preferences: pending proposal is stored, and only the student can forget their own', async () =>
{
    const progress = JSON.stringify({ topics_mastered: [], topics_needing_practice: [] });
    const save = (player: string, prefs: string[], pending: string) => rows('service',
        `select public.save_tutor_turn($1, $2, null, 'game', 'hi', null, 'hello', '[]', $3, $4)`,
        [player, BIO_NPC_2, JSON.stringify({ summary: '', current_topic: '', topics_studied: [], learning_preferences: prefs, pending_preference: pending }), progress]);
    await save(STUDENT, ['Use short explanations', 'Use Minecraft examples'], 'Teach more slowly');
    await save(OUTSIDER, ['Be energetic'], '');
    const mine = () => rows<{ learning_preferences: string[]; pending_preference: string }>(STUDENT, 'select learning_preferences, pending_preference from public.npc_memories where npc_id = $1', [BIO_NPC_2]);
    assert.deepEqual((await mine())[0], { learning_preferences: ['Use short explanations', 'Use Minecraft examples'], pending_preference: 'Teach more slowly' });

    // Older saves (memory without the new field) still work and clear the proposal.
    await rows('service', `select public.save_tutor_turn($1, $2, null, 'game', 'hi', null, 'hello', '[]', $3, $4)`,
        [STUDENT, BIO_NPC_2, JSON.stringify({ summary: '', current_topic: '', topics_studied: [], learning_preferences: ['Use short explanations', 'Use Minecraft examples'] }), progress]);
    assert.equal((await mine())[0].pending_preference, '');

    const left = await rows<{ p: string[] }>(STUDENT, 'select public.forget_teaching_preference($1, $2) as p', [BIO_NPC_2, 'use SHORT explanations']);
    assert.deepEqual(left[0].p, ['Use Minecraft examples'], 'case-insensitive removal of one preference');
    // Another player's "reset all" never touches this student's row.
    await rows(OUTSIDER, 'select public.forget_teaching_preference($1, null)', [BIO_NPC_2]);
    assert.deepEqual((await mine())[0].learning_preferences, ['Use Minecraft examples']);
    const outsider = await rows<{ learning_preferences: string[] }>('service', 'select learning_preferences from public.npc_memories where player_id = $1 and npc_id = $2', [OUTSIDER, BIO_NPC_2]);
    assert.deepEqual(outsider[0].learning_preferences, []);
    await rows(STUDENT, 'select public.forget_teaching_preference($1, null)', [BIO_NPC_2]);
    assert.deepEqual((await mine())[0].learning_preferences, []);
    // The browser still cannot write memory directly, nor call the server-only save.
    await assert.rejects(rows(STUDENT, `update public.npc_memories set learning_preferences = '{x}' where npc_id = $1 returning id`, [BIO_NPC_2]).then((r) => { if (!r.length) throw new Error('no rows: blocked'); }));
    await assert.rejects(rows(STUDENT, `select public.save_tutor_turn($1, $2, null, 'game', 'hi', null, 'x', '[]', '{}', '{}')`, [STUDENT, BIO_NPC_2]), /permission denied/);
});

test('FaceTime Tutor pairing: access-checked, single-use, server-only, class + student scoped coursework', async () =>
{
    const create = (player: string, npc: string, ttl = 120) =>
        rows<{ id: string; room_name: string }>('service', 'select * from public.create_voice_session($1, $2, $3)', [player, npc, ttl]).then((r) => r[0]);
    const claim = (id: string) => rows<{ player_id: string; npc_id: string; room_name: string }>('service', 'select * from public.claim_voice_session($1)', [id]);

    // Student A (Biology member) -> Biology NPC; Student B (the teacher account) -> History NPC.
    const bio = await create(STUDENT, BIO_NPC);
    const hist = await create(TEACHER, HIST_NPC);
    assert.match(bio.room_name, /^eduroam-[0-9a-f-]{36}$/);
    assert.notEqual(bio.room_name, hist.room_name, 'a unique room per session');
    // No access => no session, whatever ids the browser sends.
    await assert.rejects(create(STUDENT, HIST_NPC), /NPC not found/, 'Biology student cannot pair with the History NPC');
    await assert.rejects(create(OUTSIDER, BIO_NPC), /NPC not found/, 'outsider cannot pair with a class NPC');

    // Browsers can neither read sessions nor call the server-only functions.
    await assert.rejects(rows(STUDENT, 'select id from public.voice_sessions'), /permission denied/);
    await assert.rejects(rows(STUDENT, 'select * from public.create_voice_session($1, $2)', [STUDENT, BIO_NPC]), /permission denied/);
    await assert.rejects(rows(STUDENT, 'select * from public.claim_voice_session($1)', [bio.id]), /permission denied/);

    // Single use: the first claim returns the session's own player + NPC; later claims nothing.
    assert.deepEqual(await claim(bio.id), [{ player_id: STUDENT, npc_id: BIO_NPC, room_name: bio.room_name }]);
    assert.deepEqual(await claim(bio.id), [], 'a pairing id cannot be claimed twice');
    assert.deepEqual(await claim('99999999-0000-4000-8000-000000000000'), [], 'unknown pairing id');
    const late = await create(STUDENT, BIO_NPC, 30);
    await rows('service', `update public.voice_sessions set expires_at = now() - interval '1 second' where id = $1`, [late.id]);
    assert.deepEqual(await claim(late.id), [], 'an expired pairing cannot be claimed');
    assert.deepEqual(await claim(hist.id), [{ player_id: TEACHER, npc_id: HIST_NPC, room_name: hist.room_name }]);

    // The agent's coursework search runs as the server with the SESSION's player id:
    const titles = async (npc: string, player: string) => [...new Set((await match('service', npc, 'photosynthesis Rome', player)).map((r) => r.title))].sort();
    assert.deepEqual(await titles(BIO_NPC, STUDENT), ['My worksheet.pdf', 'Photosynthesis.pdf'], 'Biology call: class material + the student\'s own private upload');
    assert.deepEqual(await titles(HIST_NPC, TEACHER), ['Rome.pdf'], 'History call: only History material');
    assert.ok(!(await titles(BIO_NPC, TEACHER)).includes('My worksheet.pdf'), 'another student never gets this student\'s private worksheet');
    assert.ok(!(await titles(BIO_NPC, STUDENT)).includes('Fern notes.pdf'), 'another NPC\'s material is not included');
});

test('re-syncing an EXISTING NPC at the 10-NPC limit works (upsert), real 11th NPC / class still refused', async () =>
{
    // A fresh account (the outsider) with exactly 10 NPCs, created through the browser path.
    const cls = await rows<{ id: string }>(OUTSIDER, `insert into public.classes (owner_id, name, subject) values ($1, 'Maths', 'Maths') returning id`, [OUTSIDER]);
    for (let i = 0; i < 10; i++)
    {
        await rows(OUTSIDER, `insert into public.npcs (owner_id, class_id, game_npc_id, name, appearance, subject) values ($1, $2, $3, $3, 'knight', 'Maths')`, [OUTSIDER, cls[0].id, `limit_${i}`]);
    }
    // Exactly what syncNpc sends: INSERT ... ON CONFLICT (owner_id, game_npc_id) DO UPDATE ... RETURNING.
    const sync = (gameId: string, classId: string, name = 'bob') => rows<{ id: string }>(OUTSIDER,
        `insert into public.npcs (owner_id, class_id, game_npc_id, name, appearance, subject) values ($1, $2, $3, $4, 'knight', 'Maths')
         on conflict (owner_id, game_npc_id) do update set name = excluded.name, class_id = excluded.class_id returning id, class_id`, [OUTSIDER, classId, gameId, name]);
    const before = await rows<{ id: string }>(OUTSIDER, `select id from public.npcs where game_npc_id = 'limit_9'`);
    const again = await sync('limit_9', cls[0].id);
    assert.equal(again[0].id, before[0].id, 'the existing record is reused (same id)');
    assert.equal((await sync('limit_9', cls[0].id, 'bob renamed'))[0].id, before[0].id, 'repeat syncs stay idempotent');
    assert.equal((await rows(OUTSIDER, 'select id from public.npcs')).length, 10, 'no extra NPC row');
    // The limit itself is unchanged.
    await assert.rejects(sync('limit_new', cls[0].id), /NPC limit reached/, 'a genuinely new 11th NPC is still refused');
    const classUpsert = () => rows(OUTSIDER, `insert into public.classes (owner_id, name, subject) values ($1, ' maths ', 'Maths')
        on conflict (owner_id, name_key) do update set subject = excluded.subject returning id`, [OUTSIDER]);
    assert.equal((await classUpsert())[0] && (await rows(OUTSIDER, 'select id from public.classes')).length, 1, 'class upsert reuses the existing class');
});

test('village placement (npcs.game_state): owner-only, object-shaped, size-capped, tombstones still win', async () =>
{
    const owner = crypto.randomUUID();
    const other = crypto.randomUUID();
    const cls = crypto.randomUUID();
    await db.query('insert into auth.users(id) values ($1), ($2)', [owner, other]);
    await rows(owner, "insert into public.classes(id,owner_id,name,subject) values ($1,$2,'Village','Math')", [cls, owner]);
    const state = { v: 1, map: 'hub', x: 900, y: 400, dialogue: ['hi'], reactions: {}, minigameType: null, completed: true, building: { id: 'bld_1', type: 'lab', map: 'hub', x: 868, y: 360 } };
    // The browser's syncNpc upsert, with placement.
    const save = (who: string, gameId: string, gameState: unknown) => rows<{ id: string }>(who,
        `insert into public.npcs (owner_id, class_id, game_npc_id, name, appearance, subject, game_state) values ($1, $2, $3, 'Bob', 'scientist', 'Math', $4)
         on conflict (owner_id, game_npc_id) do update set game_state = excluded.game_state returning id`, [who, cls, gameId, JSON.stringify(gameState)]);
    const first = await save(owner, 'npc_village', state);
    const moved = await save(owner, 'npc_village', { ...state, x: 1200 });
    assert.equal(moved[0].id, first[0].id, 'moving keeps the stable row');
    const stored = await rows<{ game_state: { x: number; building: { id: string } } }>(owner, "select game_state from public.npcs where game_npc_id='npc_village'");
    assert.deepEqual([stored[0].game_state.x, stored[0].game_state.building.id], [1200, 'bld_1'], 'another browser reads back the same placement');
    assert.equal((await rows(other, "select id from public.npcs where game_npc_id='npc_village'")).length, 0, 'another account cannot read it');
    assert.equal((await rows(other, "update public.npcs set game_state='{}' where game_npc_id='npc_village' returning id")).length, 0, 'or change it');
    await assert.rejects(save(owner, 'npc_village', ['not', 'an', 'object']), /npcs_game_state_shape/);
    await assert.rejects(save(owner, 'npc_village', { dialogue: ['x'.repeat(17000)] }), /npcs_game_state_shape/);
    const legacy = await rows<{ game_state: unknown }>(owner, "insert into public.npcs (owner_id, class_id, game_npc_id, name, appearance, subject) values ($1, $2, 'npc_legacy', 'Old', 'scientist', 'Math') returning game_state", [owner, cls]);
    assert.deepEqual(legacy[0].game_state, {}, 'rows from before placements default to {} (the game places them)');
    await rows('service', 'select public.discard_local_npc($1,$2)', [owner, 'npc_stale']);
    await assert.rejects(save(owner, 'npc_stale', state), /permanently deleted/, 'a stale browser save can never recreate a deleted NPC');
});

test('FaceTime pairing (one shared line): code -> exactly one call, 5 tries, single use, server-only, no cross-student access', async () =>
{
    const [maya, sam] = [crypto.randomUUID(), crypto.randomUUID()];
    const [mayaClass, samClass] = [crypto.randomUUID(), crypto.randomUUID()];
    const [mathNpc, bioNpc] = [crypto.randomUUID(), crypto.randomUUID()];
    await db.query('insert into auth.users(id) values ($1), ($2)', [maya, sam]);
    await rows(maya, "insert into public.classes(id,owner_id,name,subject) values ($1,$2,'FT Maths','Maths')", [mayaClass, maya]);
    await rows(maya, "insert into public.npcs(id,owner_id,class_id,game_npc_id,name,appearance,subject) values ($1,$2,$3,'ft_maple','Professor Maple','scientist','Maths')", [mathNpc, maya, mayaClass]);
    await rows(sam, "insert into public.classes(id,owner_id,name,subject) values ($1,$2,'FT Bio','Biology')", [samClass, sam]);
    await rows(sam, "insert into public.npcs(id,owner_id,class_id,game_npc_id,name,appearance,subject) values ($1,$2,$3,'ft_bio','Dr Moss','scientist','Biology')", [bioNpc, sam, samClass]);
    const hash = (n: number) => n.toString(16).padStart(64, '0');
    const create = (player: string, npc: string, h: string) => rows<{ id: string }>('service', 'select * from public.create_facetime_pairing($1,$2,$3)', [player, npc, h]);
    const call = async () => (await rows<{ id: string }>('service', "insert into public.facetime_calls(chert_call_id, room_name) values ($1, $2) returning id", [crypto.randomUUID(), `eduroam-ft-${crypto.randomUUID()}`]))[0].id;
    const pair = (callId: string, h: string) => rows<{ session_id: string | null; player_id: string; npc_id: string; attempts_left: number }>('service', 'select * from public.pair_facetime_call($1,$2)', [callId, h]);

    await assert.rejects(create(maya, bioNpc, hash(1)), /NPC not found/, 'a student cannot get a code for someone else\'s NPC');
    const mayaSession = (await create(maya, mathNpc, hash(111111)))[0].id;
    await assert.rejects(create(sam, bioNpc, hash(111111)), /code collision/, 'two live codes never collide');
    const samSession = (await create(sam, bioNpc, hash(222222)))[0].id;

    // Browsers can never see or use any of it.
    await assert.rejects(as(maya, (tx) => tx.query('select * from public.facetime_calls')), /permission denied/);
    await assert.rejects(as(maya, (tx) => tx.query('select public.pair_facetime_call($1,$2)', [crypto.randomUUID(), hash(111111)])), /permission denied/);
    await assert.rejects(as(maya, (tx) => tx.query('select pair_code_hash from public.voice_sessions')), /permission denied/);

    // A call with a wrong code learns nothing; the right code pairs THAT student's NPC only.
    const first = await call();
    const wrong = await pair(first, hash(999999));
    assert.equal(wrong[0].session_id, null);
    assert.equal(wrong[0].attempts_left, 4);
    const right = await pair(first, hash(111111));
    assert.deepEqual([right[0].session_id, right[0].player_id, right[0].npc_id], [mayaSession, maya, mathNpc]);
    await assert.rejects(pair(first, hash(222222)), /already paired/, 'one call = one student');
    // Single use: Maya's code cannot be reused on another call; Sam's code still opens only Sam's NPC.
    const second = await call();
    assert.equal((await pair(second, hash(111111)))[0].session_id, null, 'a used code is dead');
    const sams = await pair(second, hash(222222));
    assert.deepEqual([sams[0].session_id, sams[0].player_id, sams[0].npc_id], [samSession, sam, bioNpc]);

    // Brute force: 5 attempts per call, then locked.
    const third = await call();
    for (let i = 0; i < 5; i++) assert.equal((await pair(third, hash(300000 + i)))[0].session_id, null);
    await assert.rejects(pair(third, hash(300009)), /too many attempts/);
    // An ended call cannot be paired; a newer code retires the student's older unused one.
    const old = (await create(maya, mathNpc, hash(444444)))[0].id;
    await create(maya, mathNpc, hash(555555));
    const fourth = await call();
    assert.equal((await pair(fourth, hash(444444)))[0].session_id, null, 'the older code was retired');
    assert.ok((await rows<{ ended_at: string | null }>('service', 'select ended_at from public.voice_sessions where id=$1', [old]))[0].ended_at);
    await rows('service', 'update public.facetime_calls set ended_at=now() where id=$1', [fourth]);
    await assert.rejects(pair(fourth, hash(555555)), /call not active/);
});
