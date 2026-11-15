// Deno test: the AI tutor's tools (_shared/tutorTools.ts) over an in-memory database that applies the
// filters each query asks for, so a missing player / class filter shows up as leaked rows.
// Run: npm run test:edge

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import type { NpcIdentity } from '../_shared/npcContext.ts';
import { listAssignments, manageTasks, memorySave, memorySearch, saveAssignment, studyPlan, webSearch, type ToolContext } from '../_shared/tutorTools.ts';

function assert (condition: unknown, message: string): asserts condition
{
    if (!condition) throw new Error(message);
}
async function rejects (fn: () => Promise<unknown>, pattern: RegExp, message: string)
{
    try { await fn(); }
    catch (err) { assert(pattern.test(String((err as Error).message)), `${message}: got "${(err as Error).message}"`); return; }
    throw new Error(`${message}: did not reject`);
}

const ANA = '11111111-0000-4000-8000-00000000000a';
const BEN = '11111111-0000-4000-8000-00000000000b';
const BIO = '22222222-0000-4000-8000-000000000001';
const ART = '22222222-0000-4000-8000-000000000002';
const MAPLE = '33333333-0000-4000-8000-000000000001';
const NY = 'America/New_York';
const NOW = new Date('2026-11-17T14:00:00Z'); // 9 AM in New York

type Row = Record<string, unknown>;

function database ()
{
    const tables: Record<string, Row[]> = {
        npc_memories: [
            { player_id: ANA, npc_id: MAPLE, summary: 'Ana practised osmosis.', current_topic: 'osmosis', topics_studied: ['osmosis'], learning_preferences: ['Use diagrams'], pending_preference: '', channels_used: ['game'] },
            { player_id: BEN, npc_id: MAPLE, summary: 'Ben struggled with mitosis.', current_topic: 'mitosis', topics_studied: ['mitosis'], learning_preferences: [], pending_preference: '', channels_used: [] },
        ],
        class_progress: [
            { player_id: ANA, class_id: BIO, topics_mastered: ['cells'], topics_needing_practice: ['osmosis'] },
            { player_id: BEN, class_id: BIO, topics_mastered: [], topics_needing_practice: ['mitosis'] },
        ],
        conversations: [{ id: 'conv-ana', player_id: ANA, npc_id: MAPLE, updated_at: '2026-11-16' }, { id: 'conv-ben', player_id: BEN, npc_id: MAPLE, updated_at: '2026-11-16' }],
        messages: [
            { conversation_id: 'conv-ana', role: 'player', content: 'Can you explain osmosis with a potato?', created_at: '2026-11-16T15:00:00Z' },
            { conversation_id: 'conv-ben', role: 'player', content: 'Secret: Ben asked about osmosis too', created_at: '2026-11-16T16:00:00Z' },
        ],
        assignments: [
            { id: 'a-ana', player_id: ANA, class_id: BIO, title: 'Lab report', description: '', due_at: '2026-11-19T04:59:00Z', due_timezone: NY, due_status: 'confirmed', status: 'todo', estimated_minutes: 90, source_document_id: null, deleted_at: null },
            { id: 'a-ana-art', player_id: ANA, class_id: ART, title: 'Art portfolio', description: '', due_at: '2026-11-18T04:59:00Z', due_timezone: NY, due_status: 'confirmed', status: 'todo', estimated_minutes: 60, source_document_id: null, deleted_at: null },
            { id: 'a-ben', player_id: BEN, class_id: BIO, title: 'Ben essay', description: '', due_at: '2026-11-20T04:59:00Z', due_timezone: NY, due_status: 'confirmed', status: 'todo', estimated_minutes: 60, source_document_id: null, deleted_at: null },
            { id: 'a-gone', player_id: ANA, class_id: BIO, title: 'Deleted quiz', description: '', due_at: '2026-11-18T04:59:00Z', due_timezone: NY, due_status: 'confirmed', status: 'todo', estimated_minutes: 30, source_document_id: null, deleted_at: '2026-11-16' },
        ],
        class_documents: [
            { id: 'doc-syl', class_id: BIO, title: 'Syllabus.pdf', processing_status: 'ready', visibility: 'class', uploaded_by: 'teacher', npc_id: null },
            { id: 'doc-ben', class_id: BIO, title: 'Ben notes.txt', processing_status: 'ready', visibility: 'private', uploaded_by: BEN, npc_id: MAPLE },
        ],
        document_chunks: [
            { document_id: 'doc-syl', class_id: BIO, chunk_text: 'Unit 3 test is due Nov 24 at 9 am. Bring a calculator.' },
            { document_id: 'doc-ben', class_id: BIO, chunk_text: 'Ben private: extra credit due Nov 21.' },
        ],
        study_tasks: [],
        minigame_sessions: [],
    };
    const writes: { table: string; op: string; row: Row }[] = [];

    const matches = (r: Row, filters: ((r: Row) => boolean)[]) => filters.every((f) => f(r));
    const db = {
        rpc: (name: string) => Promise.resolve({ data: name === 'consume_rate_limit' ? true : null, error: null }),
        from (table: string)
        {
            const filters: ((r: Row) => boolean)[] = [];
            let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select';
            let payload: Row | null = null;
            let limit = Infinity;
            const run = () =>
            {
                const list = tables[table] ??= [];
                if (mode === 'insert') { const row = { id: `${table}-${list.length + 1}`, ...payload }; list.push(row); writes.push({ table, op: 'insert', row }); return [row]; }
                if (mode === 'upsert') { writes.push({ table, op: 'upsert', row: payload! }); return [payload!]; }
                const hit = list.filter((r) => matches(r, filters)).slice(0, limit);
                if (mode === 'update') { for (const r of hit) Object.assign(r, payload); hit.forEach((r) => writes.push({ table, op: 'update', row: r })); }
                return hit;
            };
            const q: Record<string, unknown> = {
                select: () => q, order: () => q,
                limit: (n: number) => { limit = n; return q; },
                eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
                neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return q; },
                is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
                in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
                gte: (c: string, v: string) => { filters.push((r) => String(r[c] ?? '') >= v); return q; },
                or: (expr: string) =>
                {
                    const player = /uploaded_by\.eq\.([0-9a-f-]+)/.exec(expr)?.[1];
                    if (player) filters.push((r) => r.visibility === 'class' || r.uploaded_by === player);
                    else filters.push((r) => /due|deadline|submit/i.test(String(r.chunk_text)));
                    return q;
                },
                insert: (row: Row) => { mode = 'insert'; payload = row; return q; },
                update: (row: Row) => { mode = 'update'; payload = row; return q; },
                upsert: (row: Row) => { writes.push({ table, op: 'upsert', row }); return Promise.resolve({ data: null, error: null }); },
                maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
                single: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
                then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
                {
                    const rows = run();
                    return Promise.resolve({ data: rows, error: null, count: rows.length }).then(ok, ko);
                },
            };
            return q;
        },
    } as unknown as SupabaseClient;
    return { db, tables, writes };
}

const maple: NpcIdentity = { id: MAPLE, ownerId: 'teacher', classId: BIO, gameNpcId: 'npc_maple', name: 'Professor Maple', appearance: 'scientist', subject: 'Biology', personality: '', teachingInstructions: '', className: 'Biology', classDescription: '' };
const ctxFor = (playerId: string, db: SupabaseClient): ToolContext => ({ admin: db, playerId, npc: maple, tz: NY, now: NOW });

Deno.test('memory search: only this student, this teacher (memory, progress, earlier chat lines)', async () =>
{
    const { db } = database();
    const ana = await memorySearch(ctxFor(ANA, db), { action: 'memory_search', pairingId: 'p', query: 'osmosis' });
    assert(ana.memory.summary === 'Ana practised osmosis.' && ana.progress.needs_practice.join() === 'osmosis', 'Ana\'s memory + progress');
    assert(ana.earlier_chat.length === 1 && /potato/.test(ana.earlier_chat[0].text), `Ana\'s chat line only: ${JSON.stringify(ana.earlier_chat)}`);
    assert(!JSON.stringify(ana).includes('Ben'), 'nothing of Ben');
    const ben = await memorySearch(ctxFor(BEN, db), { action: 'memory_search', pairingId: 'p', query: '' });
    assert(ben.memory.summary === 'Ben struggled with mitosis.' && !JSON.stringify(ben).includes('potato'), 'Ben sees only Ben');
});

Deno.test('memory save after a conversation: merged for this student only; preferences only when confirmed', async () =>
{
    const { db, writes } = database();
    await memorySave(ctxFor(ANA, db), { action: 'memory_save', pairingId: 'p', summary: 'Explained osmosis with a potato; Ana got it right twice.', topics: ['osmosis'], mastered: ['osmosis'], needsPractice: ['diffusion'], preference: '' });
    const memory = writes.find((w) => w.table === 'npc_memories')!.row;
    const progress = writes.find((w) => w.table === 'class_progress')!.row;
    assert(memory.player_id === ANA && memory.npc_id === MAPLE && /potato/.test(String(memory.summary)), 'memory row for Ana + Maple');
    assert((memory.learning_preferences as string[]).join() === 'Use diagrams', 'existing preference kept, none added');
    assert((memory.channels_used as string[]).includes('voice') && (memory.channels_used as string[]).includes('game'), 'channel recorded, old kept');
    assert(progress.player_id === ANA && progress.class_id === BIO, 'progress for Ana in Biology');
    assert((progress.topics_mastered as string[]).includes('osmosis') && !(progress.topics_needing_practice as string[]).includes('osmosis'), 'osmosis moved to mastered');
    assert((progress.topics_needing_practice as string[]).includes('diffusion'), 'new weak topic');
    assert(!writes.some((w) => w.row.player_id === BEN), 'Ben untouched');
});

Deno.test('assignments: this student and class only; deadlines in files are suggestions (never other students\' files)', async () =>
{
    const { db } = database();
    const out = await listAssignments(ctxFor(ANA, db));
    assert(out.assignments.map((a) => a.title).join() === 'Lab report', `only Ana's live Biology work: ${out.assignments.map((a) => a.title)}`);
    assert(/due tomorrow at 11:59 PM/.test(out.assignments[0].due), `spoken in local time: ${out.assignments[0].due}`);
    assert(out.found_in_documents.length === 1 && /Unit 3 test/.test(out.found_in_documents[0].text) && out.found_in_documents[0].due_local === '2026-11-24 09:00', `syllabus suggestion: ${JSON.stringify(out.found_in_documents)}`);
    assert(!JSON.stringify(out).includes('Ben'), 'Ben\'s private file and essay are invisible');
});

Deno.test('save_assignment: tutor dates are suggestions; confirmed dates protected; other students\' work unreachable', async () =>
{
    const { db, writes } = database();
    const created = await saveAssignment(ctxFor(ANA, db), { action: 'assignment_save', pairingId: 'p', assignmentId: null, title: 'Unit 3 test', due: '2026-11-24 09:00', studentConfirmedDue: false });
    const row = writes.find((w) => w.op === 'insert')!.row;
    assert(row.player_id === ANA && row.class_id === BIO && row.npc_id === MAPLE && row.created_by === 'tutor' && row.due_status === 'suggested', `scoped tutor suggestion: ${JSON.stringify(row)}`);
    assert(row.due_at === '2026-11-24T14:00:00.000Z' && /not confirmed/.test(created.assignment.due), 'stored in UTC, labelled unconfirmed');
    await rejects(() => saveAssignment(ctxFor(ANA, db), { action: 'assignment_save', pairingId: 'p', assignmentId: 'a-ana', due: '2026-11-30', studentConfirmedDue: false }), /confirmed by the student/, 'confirmed date protected');
    await rejects(() => saveAssignment(ctxFor(ANA, db), { action: 'assignment_save', pairingId: 'p', assignmentId: 'a-ben', status: 'done', studentConfirmedDue: false }), /No such assignment/, 'Ben\'s work unreachable');
    await rejects(() => saveAssignment(ctxFor(ANA, db), { action: 'assignment_save', pairingId: 'p', assignmentId: 'a-ana-art', status: 'done', studentConfirmedDue: false }), /No such assignment/, 'another class unreachable from Maple');
    const done = await saveAssignment(ctxFor(ANA, db), { action: 'assignment_save', pairingId: 'p', assignmentId: 'a-ana', status: 'done', studentConfirmedDue: false });
    assert(done.assignment.status === 'done', 'status follows the student');
});

Deno.test('study tasks need the student\'s approval; the plan is only a proposal', async () =>
{
    const { db, writes } = database();
    await rejects(() => manageTasks(ctxFor(ANA, db), { action: 'tasks', pairingId: 'p', op: 'create', taskId: null, assignmentId: 'a-ana', title: 'Draft', starts: '2026-11-17 18:00', minutes: 30, studentApproved: false }), /Ask the student first/, 'no task without approval');
    const made = await manageTasks(ctxFor(ANA, db), { action: 'tasks', pairingId: 'p', op: 'create', taskId: null, assignmentId: 'a-ana', title: 'Draft', starts: '2026-11-17 18:00', minutes: 30, studentApproved: true });
    assert('task' in made && /6:00 PM/.test(made.task?.when ?? ''), 'saved at 6 PM local');
    const before = writes.length;
    const plan = await studyPlan(ctxFor(ANA, db), { action: 'study_plan', pairingId: 'p', dailyMinutes: 60 });
    assert(writes.length === before, 'planning writes nothing');
    assert(plan.sessions.length > 0 && plan.sessions.every((s) => s.assignment_id !== 'a-ben' && s.assignment_id !== 'a-ana-art'), 'only Ana\'s Biology work is planned');
});

Deno.test('web search sends only the query and returns real source links; no sources = unverified', async () =>
{
    const { db } = database();
    const sent: unknown[] = [];
    const fake = (chunks: { web: { uri: string; title: string } }[]) => ({ models: { generateContent: (req: unknown) => { sent.push(req); return Promise.resolve({ text: '{"answer":"The 2026 AP Biology exam is on May 11."}', candidates: [{ groundingMetadata: { groundingChunks: chunks } }] }); } } });
    const out = await webSearch(ctxFor(ANA, db), { action: 'web', pairingId: 'p', query: 'When is the AP Biology exam?' }, fake([{ web: { uri: 'https://apstudents.collegeboard.org/x', title: 'College Board' } }]) as never);
    assert(out.sources.length === 1 && out.sources[0].url.startsWith('https://') && /not the student coursework/.test(out.note), 'source link + separated from coursework');
    assert(!JSON.stringify(sent).includes('osmosis') && !JSON.stringify(sent).includes(ANA), 'no private data in the request');
    const none = await webSearch(ctxFor(ANA, db), { action: 'web', pairingId: 'p', query: 'x y z' }, fake([]) as never);
    assert(none.sources.length === 0 && /could not verify/.test(none.note), 'unverified without sources');
    await rejects(() => webSearch(ctxFor(ANA, db), { action: 'web', pairingId: 'p', query: 'q' }, null), /not set up/, 'no key, clear error');
});
