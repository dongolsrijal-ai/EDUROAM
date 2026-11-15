// LIVE Answer Dash check against the real project + Gemini (NOT part of npm test).
//   node tests/live/liveAnswerDash.mjs
// Creates two guest accounts (needs anonymous sign-ins), a Mathematics NPC with an algebra PDF,
// a Science NPC with a PRIVATE photosynthesis PDF and an empty History NPC, then plays a real
// session. Prints PASS/FAIL lines (never tokens or keys) plus two sample questions.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const results = [];
const check = (ok, label, detail = '') => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  -> ${detail}` : ''}`); };
const client = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function call (name, token, body)
{
    const res = await fetch(`${URL_}/functions/v1/${name}`, {
        method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
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
    const stream = `BT /F1 11 Tf 60 740 Td 15 TL ${lines.map((t) => `(${t.replace(/[()\\]/g, '\\$&')}) '`).join(' ')} ET`;
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

async function guest ()
{
    const db = client();
    const { data, error } = await db.auth.signInAnonymously();
    if (error) throw new Error(`guest sign-in failed: ${error.message}`);
    return { db, token: data.session.access_token, id: data.user.id };
}

async function npc (user, subject, gameId)
{
    const cls = await user.db.from('classes').upsert({ owner_id: user.id, name: subject, subject }, { onConflict: 'owner_id,name_key' }).select('id').single();
    const row = await user.db.from('npcs').upsert({ owner_id: user.id, class_id: cls.data.id, game_npc_id: gameId, name: `${subject} Teacher`, appearance: 'scientist', subject }, { onConflict: 'owner_id,game_npc_id' }).select('id, class_id').single();
    return { id: row.data.id, classId: row.data.class_id };
}

async function upload (user, npcId, visibility, name, lines)
{
    const bytes = makePdf(lines);
    const created = await call('class-documents', user.token, { action: 'create', npc_id: npcId, visibility, file_name: name, mime_type: 'application/pdf', size_bytes: bytes.length });
    await fetch(created.json.upload.url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'false', apikey: KEY }, body: bytes });
    const processed = await call('class-documents', user.token, { action: 'process', document_id: created.json.document.id });
    return processed.json?.document;
}

const ALGEBRA = [
    'Grade 8 Algebra Worksheet: Linear Equations and Slope',
    'A linear equation in one variable has the form ax + b = c. Solve by inverse operations.',
    'Example: 3x - 7 = 11. Add 7 to both sides: 3x = 18. Divide by 3: x = 6.',
    'Equations with variables on both sides: 5x + 2 = 2x + 14 gives 3x = 12, so x = 4.',
    'Slope of a line through (x1, y1) and (x2, y2): m = (y2 - y1) / (x2 - x1).',
    'Example: the slope through (1, 2) and (4, 11) is (11 - 2) / (4 - 1) = 3.',
    'Slope-intercept form: y = mx + b, where m is the slope and b is the y-intercept.',
    'Example: y = -2x + 5 has slope -2 and y-intercept 5.',
    'Distributive property: 4(x + 3) = 4x + 12. Solve 4(x + 3) = 28: x + 3 = 7, x = 4.',
];

try
{
    check((await call('answer-dash', null, { action: 'start' })).status === 401, 'rejects requests without a user JWT');
    const a = await guest();
    const b = await guest();
    const math = await npc(a, 'Mathematics', 'e2e_dash_math');
    const science = await npc(a, 'Science', 'e2e_dash_science');
    const history = await npc(a, 'History', 'e2e_dash_history');
    const algebra = await upload(a, math.id, 'class', 'Algebra worksheet.pdf', ALGEBRA);
    const bio = await upload(a, science.id, 'private', 'Photosynthesis notes.pdf', ['Photosynthesis happens in the chloroplast.', 'Chlorophyll absorbs red and blue light.']);
    check(algebra?.processing_status === 'ready' && bio?.processing_status === 'ready', 'materials processed (algebra class PDF, private science PDF)');

    // ---- real Gemini question pack from the algebra worksheet
    const t0 = Date.now();
    const start = await call('answer-dash', a.token, { action: 'start', npc_id: math.id, source: 'all' });
    check(start.status === 200, `start (Gemini) returns a pack in ${((Date.now() - t0) / 1000).toFixed(1)}s`, `${start.status} ${JSON.stringify(start.json)?.slice(0, 300)}`);
    if (start.status !== 200) throw new Error('no pack');
    const pack = start.json;
    const qs = pack.questions;
    check(qs.length >= 8 && qs.length <= 10, `8-10 questions (${qs.length})`);
    check(qs.every((q) => q.choices.length === 4 && new Set(q.choices.map((c) => c.toLowerCase())).size === 4), 'every question has 4 distinct choices');
    check(qs.every((q) => !('correct_index' in q) && !('correctIndex' in q) && !('explanation' in q)), 'answer keys and explanations are NOT sent to the browser');
    check(qs.every((q) => q.source?.title === 'Algebra worksheet.pdf'), 'every question cites the algebra worksheet');
    const text = qs.map((q) => `${q.question} ${q.choices.join(' ')} ${q.topic}`).join(' ').toLowerCase();
    check(!/photosynth|chlorophyll|chloroplast/.test(text), 'no Science (private) material leaks into the Math pack');
    const onTopic = qs.filter((q) => /x|slope|equation|intercept|distribut|linear/i.test(`${q.question} ${q.topic}`)).length;
    check(onTopic >= Math.ceil(qs.length * 0.7), `questions match the worksheet topics (${onTopic}/${qs.length} on linear equations / slope)`);
    check(new Set(qs.map((q) => q.difficulty)).size >= 2, `difficulty mix (${[...new Set(qs.map((q) => q.difficulty))].join(', ')})`);
    console.log(`  sample: ${qs[0].question} [${qs[0].choices.join(' | ')}] (${qs[0].difficulty}, ${qs[0].topic})`);
    console.log(`  sample: ${qs[qs.length - 1].question} [${qs[qs.length - 1].choices.join(' | ')}] (${qs[qs.length - 1].difficulty})`);

    // ---- isolation + errors
    check((await call('answer-dash', a.token, { action: 'start', npc_id: math.id, source: bio.id })).status === 404, 'Math NPC cannot use the Science NPC\'s private document');
    const empty = await call('answer-dash', a.token, { action: 'start', npc_id: history.id, source: 'all' });
    check(empty.status === 409 && empty.json?.error?.code === 'no_materials', 'NPC without materials -> clear no_materials error');
    check((await call('answer-dash', b.token, { action: 'start', npc_id: math.id, source: 'all' })).status === 404, 'another player cannot start a pack for A\'s NPC');
    check((await call('answer-dash', b.token, { action: 'answer', session_id: pack.session_id, index: 0, choice: 0 })).status === 404, 'another player cannot answer A\'s session');
    check((await call('answer-dash', b.token, { action: 'finish', session_id: pack.session_id })).status === 404, 'another player cannot finish A\'s session');
    check(((await b.db.from('minigame_sessions').select('id').eq('id', pack.session_id)).data ?? []).length === 0, 'another player cannot read A\'s session');
    check(Boolean((await a.db.from('minigame_sessions').select('questions').eq('id', pack.session_id)).error), 'even the owner cannot read the stored answer keys');
    const forge = await a.db.from('minigame_sessions').update({ score: 99999 }).eq('id', pack.session_id).select('id');
    check(Boolean(forge.error) || !forge.data?.length, 'browser cannot forge a score');

    // ---- play: first answer wins, server grading, idempotent finish
    const first = await call('answer-dash', a.token, { action: 'answer', session_id: pack.session_id, index: 0, choice: 0 });
    const retry = await call('answer-dash', a.token, { action: 'answer', session_id: pack.session_id, index: 0, choice: 1 });
    check(first.status === 200 && retry.json?.choice === 0 && typeof first.json?.explanation === 'string', 'first answer wins; explanation returned after answering');
    let expected = first.json.correct ? 1 : 0;
    for (let i = 1; i < qs.length; i++)
    {
        const r = await call('answer-dash', a.token, { action: 'answer', session_id: pack.session_id, index: i, choice: i % 4 });
        if (r.json?.correct) expected++;
    }
    const done = await call('answer-dash', a.token, { action: 'finish', session_id: pack.session_id });
    const again = await call('answer-dash', a.token, { action: 'finish', session_id: pack.session_id });
    check(done.status === 200 && done.json.correct === expected && done.json.correct + done.json.incorrect === qs.length, `server-graded result (${done.json?.correct}/${qs.length}, score ${done.json?.score})`);
    check(again.json?.score === done.json?.score && again.json?.correct === done.json?.correct, 'finishing twice does not double count');
    const row = await a.db.from('minigame_sessions').select('status, score, player_id, npc_id').eq('id', pack.session_id).single();
    check(row.data?.status === 'completed' && row.data.player_id === a.id && row.data.npc_id === math.id, 'result saved to the right player + NPC');
    const memory = await a.db.from('npc_memories').select('topics_studied').eq('npc_id', math.id).maybeSingle();
    check((memory.data?.topics_studied ?? []).length > 0, 'NPC memory gained the studied topics');
    const progress = await a.db.from('class_progress').select('topics_mastered, topics_needing_practice').eq('class_id', math.classId).maybeSingle();
    check(progress.data && (progress.data.topics_mastered.length + progress.data.topics_needing_practice.length) > 0 || done.json.weak_topics.length + done.json.mastered_topics.length === 0, 'class progress updated with weak/mastered topics');
    const late = await call('answer-dash', a.token, { action: 'answer', session_id: pack.session_id, index: 1, choice: 2 });
    check(late.status === 200 && late.json?.choice === 1, 'after finishing, a re-answer returns the original choice (results cannot change)');

    // ---- subject practice is labelled, never fake-grounded
    const subject = await call('answer-dash', a.token, { action: 'start', npc_id: history.id, source: 'subject' });
    check(subject.status === 400, 'general (subject) practice is rejected: questions come only from coursework');
}
catch (err)
{
    check(false, 'unexpected error', err?.message ?? String(err));
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} live Answer Dash checks passed`);
process.exitCode = failed ? 1 : 0;
