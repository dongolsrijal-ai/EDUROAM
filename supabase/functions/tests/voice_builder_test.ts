// Deno test: the LiveKit Agent Builder dispatch metadata voice-session sends, built by the real
// resolveNpcIdentity -> retrieveStudentMemory -> loadClassKnowledge path (loadBuilderMetadata) over
// an in-memory database that applies the same filters the queries ask for. Run: npm run test:edge

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import { loadBuilderMetadata, resolveNpcIdentity } from '../_shared/npcContext.ts';
import { BUILDER_LIMITS, builderMetadata, usesBuilderMetadata, VOICE_AGENT_NAME, voiceAgentName } from '../_shared/voice.ts';

function assert (condition: unknown, message: string): asserts condition
{
    if (!condition) throw new Error(message);
}

const OWNER = '11111111-0000-4000-8000-000000000001';   // teacher who owns the classes
const STUDENT_A = '11111111-0000-4000-8000-00000000000a';
const STUDENT_B = '11111111-0000-4000-8000-00000000000b';
const OUTSIDER = '11111111-0000-4000-8000-00000000000c';
const PHYSICS = '22222222-0000-4000-8000-000000000001';
const ART = '22222222-0000-4000-8000-000000000002';
const NEWTON = '33333333-0000-4000-8000-000000000001';
const CURIE = '33333333-0000-4000-8000-000000000002';
const MONET = '33333333-0000-4000-8000-000000000003';

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
    npcs: [
        { id: NEWTON, owner_id: OWNER, class_id: PHYSICS, game_npc_id: 'npc_newton', name: 'Professor Newton', appearance: 'scientist', subject: 'Physics',
            personality: 'Dry wit; loves thought experiments about falling apples.', teaching_instructions: 'Always ask for units before the answer.',
            classes: { name: 'Year 11 Physics', description: '', owner_id: OWNER } },
        { id: CURIE, owner_id: OWNER, class_id: PHYSICS, game_npc_id: 'npc_curie', name: 'Madame Curie', appearance: 'scientist', subject: 'Chemistry',
            personality: 'Calm, precise and quietly proud of careful lab work.', teaching_instructions: 'Use the periodic table in every explanation.',
            classes: { name: 'Year 11 Physics', description: '', owner_id: OWNER } },
        { id: MONET, owner_id: OWNER, class_id: ART, game_npc_id: 'npc_monet', name: 'Monsieur Monet', appearance: 'artist', subject: 'Art',
            personality: null, teaching_instructions: null, classes: { name: 'Art Studio', description: '', owner_id: OWNER } },
    ],
    class_members: [
        { class_id: PHYSICS, player_id: STUDENT_A }, { class_id: PHYSICS, player_id: STUDENT_B },
        { class_id: ART, player_id: STUDENT_A },
    ],
    npc_memories: [
        { player_id: STUDENT_A, npc_id: NEWTON, summary: 'Worked through F = ma with two carts; confused mass and weight.', current_topic: 'forces',
            topics_studied: ['forces', 'acceleration'], learning_preferences: ['Use worked examples'], pending_preference: '' },
        { player_id: STUDENT_B, npc_id: NEWTON, summary: 'Practised projectile motion; strong at graphs.', current_topic: 'projectiles',
            topics_studied: ['projectiles'], learning_preferences: ['Keep explanations short'], pending_preference: '' },
    ],
    class_progress: [
        { player_id: STUDENT_A, class_id: PHYSICS, topics_mastered: ['velocity'], topics_needing_practice: ['mass vs weight'] },
        { player_id: STUDENT_B, class_id: PHYSICS, topics_mastered: ['graphs'], topics_needing_practice: [] },
    ],
    class_documents: [
        { id: 'doc-1', class_id: PHYSICS, npc_id: null, title: 'Forces worksheet.pdf', processing_status: 'ready', visibility: 'class', uploaded_by: OWNER },
        { id: 'doc-2', class_id: PHYSICS, npc_id: NEWTON, title: 'A homework photo.jpg', processing_status: 'ready', visibility: 'private', uploaded_by: STUDENT_A },
        { id: 'doc-3', class_id: PHYSICS, npc_id: NEWTON, title: 'B private notes.txt', processing_status: 'ready', visibility: 'private', uploaded_by: STUDENT_B },
        { id: 'doc-4', class_id: PHYSICS, npc_id: null, title: 'Lab handout.pdf', processing_status: 'processing', visibility: 'class', uploaded_by: OWNER },
    ],
    chunks: [
        { document_id: 'doc-1', npc_id: null, class_id: PHYSICS, title: 'Forces worksheet.pdf', visibility: 'class', uploaded_by: OWNER, chunk_text: 'Q2: a 2 kg cart accelerates at 3 m/s^2. Find the net force.', source: { page_start: 1 } },
        { document_id: 'doc-2', npc_id: NEWTON, class_id: PHYSICS, title: 'A homework photo.jpg', visibility: 'private', uploaded_by: STUDENT_A, chunk_text: 'Student A homework: 5 kg box pushed with 20 N.', source: {} },
        { document_id: 'doc-3', npc_id: NEWTON, class_id: PHYSICS, title: 'B private notes.txt', visibility: 'private', uploaded_by: STUDENT_B, chunk_text: 'Student B secret notes about orbits.', source: {} },
    ],
};

/** Minimal PostgREST-shaped fake: eq filters, the npcDocumentScope `or` filter and match_npc_chunks. */
function fakeDb (): SupabaseClient
{
    return {
        from (table: string)
        {
            const filters: [string, unknown][] = [];
            let scopePlayer: string | null = null;
            const rows = () => (tables[table] ?? [])
                .filter((r) => filters.every(([c, v]) => r[c] === v))
                .filter((r) => !scopePlayer || r.visibility === 'class' || r.uploaded_by === scopePlayer);
            const query = {
                select: () => query,
                eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
                or: (scope: string) => { scopePlayer = /uploaded_by\.eq\.([0-9a-f-]+)/.exec(scope)?.[1] ?? null; return query; },
                order: () => query,
                limit: () => query,
                maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
                then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
            };
            return query;
        },
        rpc (name: string, params: Record<string, unknown>)
        {
            assert(name === 'match_npc_chunks', `unexpected rpc ${name}`);
            const npc = tables.npcs.find((n) => n.id === params.p_npc_id)!;
            const data = tables.chunks
                .filter((c) => c.class_id === npc.class_id && (c.visibility === 'class' ? c.npc_id === null || c.npc_id === npc.id : c.npc_id === npc.id && c.uploaded_by === params.p_player_id))
                .slice(0, Number(params.p_limit))
                .map((c, i) => ({ chunk_id: `c${i}`, document_id: c.document_id, title: c.title, visibility: c.visibility, chunk_index: i, chunk_text: c.chunk_text, source: c.source }));
            return Promise.resolve({ data, error: null });
        },
    } as unknown as SupabaseClient;
}

async function metadataFor (playerId: string, npcId: string)
{
    const db = fakeDb();
    return await loadBuilderMetadata(db, playerId, await resolveNpcIdentity(db, playerId, npcId));
}

const KEYS = ['npc_name', 'subject', 'personality', 'teaching_style', 'coursework', 'learning_memory'];

Deno.test('Builder metadata: exactly the six registered string fields, each NPC with its own personality', async () =>
{
    const newton = await metadataFor(STUDENT_A, NEWTON);
    const curie = await metadataFor(STUDENT_A, CURIE);
    for (const meta of [newton, curie])
    {
        assert(JSON.stringify(Object.keys(meta).sort()) === JSON.stringify([...KEYS].sort()), `keys: ${Object.keys(meta)}`);
        assert(Object.values(meta).every((v) => typeof v === 'string' && v.length > 0), 'all values are non-empty strings');
    }
    assert(newton.npc_name === 'Professor Newton' && newton.subject === 'Physics', 'Newton identity');
    assert(/falling apples/.test(newton.personality) && /ask for units/.test(newton.teaching_style), 'Newton personality + teaching style');
    assert(curie.npc_name === 'Madame Curie' && curie.subject === 'Chemistry', 'Curie identity');
    assert(/Calm, precise/.test(curie.personality) && /periodic table/.test(curie.teaching_style), 'Curie personality + teaching style');
    assert(!/Newton|apples|units/.test(JSON.stringify(curie)), 'nothing of Newton leaks into Curie');
    assert(/Forces worksheet\.pdf/.test(newton.coursework) && /net force/.test(newton.coursework), 'class document title + excerpt');
    assert(/Lab handout\.pdf \(still processing/.test(newton.coursework), 'unfinished files are marked, not quoted');
});

Deno.test('Builder metadata: each student gets only their own memory and private uploads', async () =>
{
    const a = await metadataFor(STUDENT_A, NEWTON);
    const b = await metadataFor(STUDENT_B, NEWTON);
    assert(/confused mass and weight/.test(a.learning_memory) && /Current topic: forces/.test(a.learning_memory), `A memory: ${a.learning_memory}`);
    assert(/Strengths: velocity/.test(a.learning_memory) && /mass vs weight/.test(a.learning_memory) && /worked examples/.test(a.learning_memory), 'A progress + preferences');
    assert(/projectile motion/.test(b.learning_memory) && /Strengths: graphs/.test(b.learning_memory), `B memory: ${b.learning_memory}`);
    assert(!/mass and weight|velocity|worked examples/.test(b.learning_memory), 'B never sees A\'s memory');
    assert(/A homework photo/.test(a.coursework) && !/B private notes|orbits/.test(a.coursework), 'A sees own private upload, not B\'s');
    assert(/B private notes/.test(b.coursework) && !/A homework|20 N/.test(b.coursework), 'B sees own private upload, not A\'s');
    const ids = [OWNER, STUDENT_A, STUDENT_B, NEWTON, PHYSICS];
    assert(!ids.some((id) => JSON.stringify(a).includes(id) || JSON.stringify(b).includes(id)), 'no player / NPC / class ids in metadata');
});

Deno.test('Builder metadata: empty coursework, personality and memory get honest fallbacks', async () =>
{
    const monet = await metadataFor(STUDENT_A, MONET);
    assert(monet.npc_name === 'Monsieur Monet' && monet.subject === 'Art', 'identity');
    assert(/No coursework has been uploaded for this class yet/.test(monet.coursework) && /Do not invent/.test(monet.coursework), `coursework fallback: ${monet.coursework}`);
    assert(/warm, patient, encouraging Art teacher/.test(monet.personality), `personality fallback: ${monet.personality}`);
    assert(/step by step/.test(monet.teaching_style), 'teaching style fallback');
    assert(/First conversation with this student/.test(monet.learning_memory), 'memory fallback');
});

Deno.test('Builder metadata: an NPC the student may not use is refused before any context is read', async () =>
{
    let rejected: unknown = null;
    try { await metadataFor(OUTSIDER, NEWTON); }
    catch (err) { rejected = err; }
    assert(rejected && (rejected as { status?: number }).status === 404, `outsider gets 404, got ${String(rejected)}`);
});

Deno.test('Builder metadata stays small; the Python worker keeps the opaque pairing id format', () =>
{
    const huge = 'x'.repeat(10_000);
    const meta = builderMetadata(
        { id: NEWTON, name: huge, subject: huge, personality: huge, teachingInstructions: huge, className: huge, classDescription: '' },
        { summary: huge, currentTopic: huge, topicsStudied: Array(50).fill(huge), learningPreferences: Array(50).fill(huge) },
        { topicsMastered: Array(50).fill(huge), topicsNeedingPractice: Array(50).fill(huge) },
        Array(40).fill({ id: 'd', title: huge, status: 'ready', visibility: 'class' }),
        Array(10).fill({ chunkId: 'c', documentId: 'd', title: huge, visibility: 'class', chunkIndex: 0, text: huge }),
    );
    for (const key of KEYS) assert(meta[key as keyof typeof meta].length <= BUILDER_LIMITS[key as keyof typeof BUILDER_LIMITS], `${key} capped`);
    assert(new TextEncoder().encode(JSON.stringify(meta)).length < 6000, 'whole metadata under 6 KB');
    assert(!/[\u0000-\u001f]/.test(JSON.stringify(builderMetadata({ id: NEWTON, name: 'A\u0007B', subject: 'S\nT', personality: '', teachingInstructions: '', className: '', classDescription: '' },
        { summary: '', currentTopic: '', topicsStudied: [], learningPreferences: [] }, { topicsMastered: [], topicsNeedingPractice: [] }, [], []))), 'control characters removed');

    assert(voiceAgentName(undefined) === VOICE_AGENT_NAME && usesBuilderMetadata(voiceAgentName(undefined)), 'default agent eduroam-tutor -> Builder JSON');
    assert(!usesBuilderMetadata(voiceAgentName('eduroam-tutor-code')), 'VOICE_AGENT_NAME=eduroam-tutor-code -> legacy pairing id');
});
