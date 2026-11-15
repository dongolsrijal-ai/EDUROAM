// LIVE Coursework Library check (real project + Gemini; NOT part of npm test). Controlled usage:
// 3 image readings + 2 question packs + 1 image chat. Run: node tests/live/liveCoursework.mjs
// Two guest accounts; Mathematics + Science NPCs tagged game_npc_id "e2e_cw_*".

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const results = [];
const check = (ok, label, detail = '') => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  -> ${detail}` : ''}`); };
const client = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function call (name, token, body)
{
    const res = await fetch(`${URL_}/functions/v1/${name}`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); }
    catch { /* empty */ }
    return { status: res.status, json };
}

async function guest ()
{
    const db = client();
    const { data, error } = await db.auth.signInAnonymously();
    if (error) throw new Error(error.message);
    return { db, token: data.session.access_token, id: data.user.id };
}

async function npc (user, subject, gameId)
{
    const cls = await user.db.from('classes').upsert({ owner_id: user.id, name: subject, subject }, { onConflict: 'owner_id,name_key' }).select('id').single();
    const row = await user.db.from('npcs').upsert({ owner_id: user.id, class_id: cls.data.id, game_npc_id: gameId, name: `${subject} Teacher`, appearance: 'scientist', subject }, { onConflict: 'owner_id,game_npc_id' }).select('id').single();
    return row.data.id;
}

async function upload (user, npcId, name, mime, bytes, extra = {})
{
    const created = await call('class-documents', user.token, { action: 'create', npc_id: npcId, visibility: 'class', file_name: name, mime_type: mime, size_bytes: bytes.length, ...extra });
    if (created.status !== 201) return { created };
    await fetch(created.json.upload.url, { method: 'PUT', headers: { 'Content-Type': mime, 'x-upsert': 'false', apikey: KEY }, body: bytes });
    const processed = await call('class-documents', user.token, { action: 'process', document_id: created.json.document.id });
    return { created, doc: processed.json?.document ?? created.json.document, status: processed.status };
}

function pdf (lines)
{
    const o = [];
    o[1] = '<< /Type /Catalog /Pages 2 0 R >>'; o[2] = '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'; o[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    const st = `BT /F1 11 Tf 60 740 Td 15 TL ${lines.map((t) => `(${t}) '`).join(' ')} ET`;
    o[4] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>';
    o[5] = `<< /Length ${st.length} >>\nstream\n${st}\nendstream`;
    let out = '%PDF-1.4\n'; const off = [];
    for (let i = 1; i < o.length; i++) { off[i] = out.length; out += `${i} 0 obj\n${o[i]}\nendobj\n`; }
    const x = out.length;
    out += `xref\n0 ${o.length}\n0000000000 65535 f \n${off.slice(1).map((v) => `${String(v).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${o.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

const NOTES = `Lecture 7: Derivatives and the Power Rule

The derivative of a function measures its instantaneous rate of change. Geometrically, f'(a) is the slope of the tangent line to y = f(x) at x = a.

Power rule: if f(x) = x^n, then f'(x) = n x^(n-1). For example, the derivative of x^5 is 5x^4, and the derivative of x^2 is 2x.

Constant multiple rule: the derivative of c f(x) is c f'(x). The derivative of a constant is 0. Sum rule: (f + g)' = f' + g'.

Example: if f(x) = 3x^4 - 2x + 7, then f'(x) = 12x^3 - 2.`;

try
{
    const a = await guest();
    const b = await guest();
    const math = await npc(a, 'Mathematics', 'e2e_cw_math');
    const science = await npc(a, 'Science', 'e2e_cw_science');

    // ---- pasted notes
    const paste = await call('class-documents', a.token, { action: 'paste', npc_id: math, visibility: 'class', title: 'Lecture 7 - Derivatives', text: NOTES, topic: 'Derivatives', chapter: 'Chapter 3' });
    check(paste.status === 201 && paste.json.document.processing_status === 'ready' && paste.json.document.file_type === 'text', 'pasted notes saved and processed', `${paste.status} ${JSON.stringify(paste.json)?.slice(0, 200)}`);
    const notesId = paste.json?.document?.id;
    const again = await client().auth.setSession ? await a.db.from('class_documents').select('id, title, topic, chapter').eq('id', notesId).single() : null;
    check(again?.data?.title === 'Lecture 7 - Derivatives' && again.data.topic === 'Derivatives' && again.data.chapter === 'Chapter 3', 'pasted notes persist with topic + chapter (re-read from Supabase)');

    // ---- multiple PDFs, each with its own status
    const [p1, p2] = await Promise.all([
        upload(a, math, 'Unit 1 Limits.pdf', 'application/pdf', pdf(['Limits: lim x->2 of (x^2 - 4)/(x - 2) = 4.', 'A limit describes the value a function approaches.'])),
        upload(a, math, 'Unit 2 Continuity.pdf', 'application/pdf', pdf(['A function is continuous at a if lim f(x) = f(a).'])),
    ]);
    check(p1.doc?.processing_status === 'ready' && p2.doc?.processing_status === 'ready' && p1.doc.id !== p2.doc.id, 'two PDFs uploaded, each processed separately');

    // ---- images (Gemini vision)
    const worksheet = await upload(a, math, 'Quadratics worksheet.png', 'image/png', fixture('worksheet.png'), { topic: 'Quadratics' });
    const ws = worksheet.doc;
    check(ws?.processing_status === 'ready' && ws.file_type === 'png' && ws.extraction?.kind === 'image', 'PNG worksheet processed by image understanding', JSON.stringify(ws)?.slice(0, 300));
    const wsView = await call('class-documents', a.token, { action: 'view', document_id: ws?.id });
    check(/x\^?2\s*-\s*5x\s*\+\s*6/i.test(wsView.json?.text ?? '') && /quadratic/i.test(wsView.json?.text ?? ''), 'worksheet text + math extracted from the screenshot', wsView.json?.text?.slice(0, 200));
    const img = wsView.json?.url ? await fetch(wsView.json.url) : null;
    check(img?.status === 200 && (img.headers.get('content-type') ?? '').startsWith('image/png'), 'original image kept; short-lived signed URL works');

    const triangle = await upload(a, math, 'Triangle diagram.jpg', 'image/jpeg', fixture('triangle.jpg'));
    const triView = await call('class-documents', a.token, { action: 'view', document_id: triangle.doc?.id });
    check(triangle.doc?.processing_status === 'ready' && /6\s*cm/.test(triView.json?.text ?? '') && /8\s*cm/.test(triView.json?.text ?? '') && /triangle/i.test(triView.json?.text ?? ''), 'JPEG diagram understood (right triangle, legs 6 cm and 8 cm)', triView.json?.text?.slice(0, 300));

    const blurry = await upload(a, math, 'Blurry notes.png', 'image/png', fixture('blurry.png'));
    const flagged = blurry.doc?.extraction?.needs_review === true || blurry.doc?.processing_status === 'failed';
    check(flagged, `ambiguous image flagged for review (status ${blurry.doc?.processing_status}, needs_review ${blurry.doc?.extraction?.needs_review})`);
    if (blurry.doc?.processing_status === 'ready')
    {
        const fix = await call('class-documents', a.token, { action: 'correct', document_id: blurry.doc.id, text: 'Integral of 3x^2 dx = x^3 + C. Evaluated from 1 to 2 the result is 7.' });
        check(fix.status === 200 && fix.json.document.extraction.needs_review === false, 'student correction clears the review flag');
    }

    const renamed = await call('class-documents', a.token, { action: 'update', document_id: ws?.id, title: 'Worksheet 3 (quadratics)', chapter: 'Chapter 2' });
    check(renamed.json?.document?.title === 'Worksheet 3 (quadratics)' && renamed.json.document.chapter === 'Chapter 2', 'rename + organise');

    // ---- privacy
    check((await call('class-documents', b.token, { action: 'view', document_id: ws?.id })).status === 404, 'another player cannot view the images');
    check(((await b.db.from('document_chunks').select('id').eq('document_id', ws?.id)).data ?? []).length === 0, 'another player cannot read extracted image text');
    check((await call('class-documents', b.token, { action: 'update', document_id: notesId, title: 'hacked' })).status === 404, 'another player cannot rename coursework');

    // ---- Answer Dash only from coursework
    check((await call('answer-dash', a.token, { action: 'start', npc_id: math, source: 'subject' })).status === 400, 'general practice mode is gone');
    const empty = await call('answer-dash', a.token, { action: 'start', npc_id: science, source: 'all' });
    check(empty.status === 409 && empty.json?.error?.code === 'no_materials', 'no coursework -> refuses to start (no generic questions)');
    const fromNotes = await call('answer-dash', a.token, { action: 'start', npc_id: math, source: [notesId] });
    const nq = fromNotes.json?.questions ?? [];
    check(fromNotes.status === 200 && nq.length >= 8 && nq.every((q) => q.choices.length === 4), `pack from pasted notes (${nq.length} questions)`, JSON.stringify(fromNotes.json)?.slice(0, 200));
    check(nq.every((q) => q.source?.title === 'Lecture 7 - Derivatives'), 'every question cites the pasted notes');
    check(nq.filter((q) => /deriv|power rule|slope|tangent|rate of change|x\^|f'/i.test(`${q.question} ${q.topic} ${q.choices.join(' ')}`)).length >= Math.ceil(nq.length * 0.7), 'questions are about derivatives (the pasted content)');
    console.log(`  sample: ${nq[0]?.question} [${nq[0]?.choices.join(' | ')}]`);
    const all = await call('answer-dash', a.token, { action: 'start', npc_id: math, source: 'all' });
    if (all.status !== 200) console.log(`  whole-library start: ${all.status} ${JSON.stringify(all.json)?.slice(0, 300)}`);
    const aq = all.json?.questions ?? [];
    const figures = aq.filter((q) => q.figure);
    check(all.status === 200 && aq.length >= 8 && new Set(aq.map((q) => q.source?.title)).size >= 2, `pack from the whole library draws on several documents (${[...new Set(aq.map((q) => q.source?.title))].join('; ')})`);
    let figuresOk = true;
    for (const q of figures) figuresOk = figuresOk && Boolean(q.figure.url) && (await fetch(q.figure.url)).status === 200;
    check(figuresOk, `figure questions carry a working image (${figures.length} with figures)`);

    // ---- image in chat (used for this turn only)
    // A NEW picture (not in the library): the reply can only come from the attachment itself.
    const chat = await call('npc-chat', a.token, { npc_id: math, message: 'Explain how to solve this problem.', image: { mime_type: 'image/png', data: fixture('triangle-5-12.png').toString('base64') } });
    const reply = chat.json?.reply ?? '';
    check(chat.status === 200 && /\b5\b/.test(reply) && /\b12\b/.test(reply) && /pythag|squared|\^2|hypotenuse/i.test(reply), 'NPC explains the attached image (legs 5 m and 12 m, Pythagoras)', reply.slice(0, 300) || JSON.stringify(chat.json));
    console.log(`  reply: ${reply.slice(0, 220)}`);
    const stored = await a.db.from('messages').select('content').eq('conversation_id', chat.json?.conversation_id).eq('role', 'player').single();
    check(stored.data?.content.startsWith('[Image attached]'), 'chat image not stored, only noted in history');
    const docsAfter = await a.db.from('class_documents').select('id').eq('npc_id', math);
    check(docsAfter.data?.length === 6, `chat image was not added to the library (${docsAfter.data?.length} documents)`);
}
catch (err)
{
    check(false, 'unexpected error', err?.message ?? String(err));
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} live coursework checks passed`);
process.exitCode = failed ? 1 : 0;
