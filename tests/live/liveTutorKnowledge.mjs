// LIVE check of the Gemini tutoring foundation against the real Supabase project in .env.local
// (NOT part of npm test). Run AFTER applying migration 20261114060000 and deploying npc-chat,
// class-documents and answer-dash:
//   node tests/live/liveTutorKnowledge.mjs
// Uses ~16 Gemini requests (1 Google Search, ~5 URL-context reads) to stay inside free quotas.
// Creates one guest account tagged game_npc_id "e2e_maple". Prints PASS/FAIL lines only.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const results = [];
const check = (ok, label, detail = '') => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  -> ${detail}` : ''}`); };

async function call (name, token, body)
{
    // Stay under the free-tier Gemini per-minute quota and npc-chat's own 12/minute limit.
    if (name === 'npc-chat' || body?.action === 'website') await new Promise((r) => setTimeout(r, Number(process.env.LIVE_PAUSE_MS ?? 6000)));
    const res = await fetch(`${URL_}/functions/v1/${name}`, {
        method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); }
    catch { /* empty */ }
    return { status: res.status, json };
}
const short = (r) => `${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`;
/** Prints the teacher's actual words (for judging tone), plus labels and page status. */
const show = (label, r) => console.log(`   [${label}] ${String(r.json?.reply ?? r.json?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 320)}${r.json?.knowledge ? `  {${Object.entries(r.json.knowledge).filter(([, v]) => v).map(([k]) => k).join(',')}}` : ''}${r.json?.pages?.length ? `  pages=${r.json.pages.map((p) => p.status).join(',')}` : ''}`);

try
{
    const db = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error } = await db.auth.signInAnonymously();
    check(!error && auth.session, 'guest sign-in', error?.message);
    const token = auth.session.access_token;
    const userId = auth.user.id;

    // NPC created with only name + class (no greeting / personality / instructions).
    const cls = await db.from('classes').upsert({ owner_id: userId, name: '5th Grade Mathematics', subject: '5th Grade Mathematics' }, { onConflict: 'owner_id,name_key' }).select('id').single();
    const npc = await db.from('npcs').upsert({ owner_id: userId, class_id: cls.data?.id, game_npc_id: 'e2e_maple', name: 'Professor Maple', appearance: 'scientist', subject: '5th Grade Mathematics' }, { onConflict: 'owner_id,game_npc_id' }).select('id').single();
    check(npc.data?.id, 'NPC without personality / instructions', npc.error?.message);
    const npcId = npc.data.id;
    const chat = (message, conversationId = null) => call('npc-chat', token, { npc_id: npcId, conversation_id: conversationId, message });

    // 1) Natural introduction + 2) general knowledge without any uploaded files.
    const hi = await chat('Hi! Who are you?');
    check(hi.status === 200 && /maple/i.test(hi.json?.reply ?? ''), 'introduces itself naturally', short(hi));
    show('hi', hi);
    const conv = hi.json?.conversation_id;
    const dna = await chat('What is DNA? I know it is not math, but I am curious.', conv);
    check(dna.status === 200 && /gene|genetic|molecule|helix/i.test(dna.json?.reply ?? '') && !/not in your (documents|notes)/i.test(dna.json?.reply ?? ''), 'answers a general question without coursework', short(dna));
    check(dna.json?.knowledge?.general === true && dna.json?.web_search === 'off', 'labelled General Knowledge, no web search for a basic question', JSON.stringify(dna.json?.knowledge));

    // 2b) The exact regression conversation (fresh conversation).
    const KHAN = 'https://www.khanacademy.org/math/differential-calculus/dc-diff-intro';
    const t1 = await chat(KHAN);
    show('khan-1', t1);
    const read = (t1.json?.pages ?? [])[0];
    check(t1.status === 200 && /calculus|derivative|rate of change|slope/i.test(t1.json?.reply ?? '') && !/probability/i.test(t1.json?.reply ?? ''),
        'Khan link: replies about calculus, no unrelated topic', short(t1));
    check(read && (read.status === 'read' ? t1.json.knowledge?.webPage === true : /couldn't|could not|unable/i.test(t1.json.reply)),
        `Khan link retrieval reported honestly (status: ${read?.status}${read?.reason ? `, ${read.reason}` : ''})`, short(t1));
    const t2 = await chat('can we not use the link to study', t1.json?.conversation_id);
    check(t2.status === 200 && !/skip|without the link/i.test(t2.json?.reply ?? '') && /calculus|derivative|lesson|link|rate|slope|\?/i.test(t2.json?.reply ?? ''),
        '"can we not use the link to study" -> studies with the link (or asks briefly)', short(t2));
    show('khan-2', t2);
    const t3 = await chat('wdym probability', t2.json?.conversation_id);
    show('khan-3', t3);
    check(t3.status === 200 && /calculus|derivative|link|lesson|mistake|sorry|not relevant|didn'?t mean/i.test(t3.json?.reply ?? ''),
        '"wdym probability" -> acknowledges / returns to calculus', short(t3));
    const login = await chat('Can you explain this? https://www.facebook.com/settings', t3.json?.conversation_id);
    check(login.status === 200 && (login.json?.pages ?? [])[0]?.status === 'failed' && !login.json?.knowledge?.webPage, 'login-only link reported as not read', short(login));
    const broken = await chat('https://this-domain-does-not-exist-eduroam-check.com/lesson', t3.json?.conversation_id);
    check(broken.status === 200 && (broken.json?.pages ?? [])[0]?.status === 'failed', 'broken link fails safely, chat still works', short(broken));

    // 2c) Natural conversation: casual chat, a direct explanation, and a topic switch after the link.
    const casual = await chat('lol thanks, how is your day going?', t3.json?.conversation_id);
    show('casual', casual);
    check(casual.status === 200 && (casual.json?.reply ?? '').length < 400 && !/EDUROAM/i.test(casual.json?.reply ?? '') && !/I'm Professor Maple/i.test(casual.json?.reply ?? ''),
        'casual chat: short, natural, no re-introduction or game talk', short(casual));
    const direct = await chat('Just tell me the derivative of x^3 + 2x and briefly why.', t3.json?.conversation_id);
    show('direct', direct);
    check(direct.status === 200 && /3x\^?2|3x²/.test(direct.json?.reply ?? '') && /\+ ?2\b/.test(direct.json?.reply ?? ''), 'direct explanation request gets the answer (3x^2 + 2)', short(direct));
    const switched = await chat('Different topic: what causes the seasons on Earth?', t3.json?.conversation_id);
    show('switch', switched);
    check(switched.status === 200 && /tilt|axis/i.test(switched.json?.reply ?? '') && !/probability/i.test(switched.json?.reply ?? ''), 'topic switch followed, no probability', short(switched));

    // 2d) "Explain this" with a PRIVATE attached file (the real chat flow: upload, process, send ids).
    const notes = 'Chain rule worksheet. Q1: Differentiate (3x + 1)^5. The chain rule says d/dx f(g(x)) = f\'(g(x)) * g\'(x). Q2: Differentiate sin(x^2).';
    const created = await call('class-documents', token, { action: 'create', npc_id: npcId, visibility: 'private', file_name: 'Chain rule worksheet.txt', mime_type: 'text/plain', size_bytes: Buffer.byteLength(notes) });
    const put = created.status === 201 ? await fetch(created.json.upload.url, { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'x-upsert': 'false', apikey: KEY }, body: notes }) : { status: 0 };
    const processed = await call('class-documents', token, { action: 'process', document_id: created.json?.document?.id });
    const docId = processed.json?.document?.id;
    check(processed.json?.document?.processing_status === 'ready' && processed.json.document.visibility === 'private', 'attachment uploaded privately and processed', `${short(created)} put=${put.status} ${short(processed)}`);
    const explain = await call('npc-chat', token, { npc_id: npcId, conversation_id: t3.json?.conversation_id, message: 'explain this', attachment_ids: [docId] });
    show('attachment', explain);
    check(explain.status === 200 && /chain rule|\(3x ?\+ ?1\)|sin\(x\^?2\)/i.test(explain.json?.reply ?? '') && explain.json?.knowledge?.attachment === true
        && (explain.json?.sources ?? []).some((s) => s.document_id === docId && s.attached), '"explain this" answers from the attached file and cites it', short(explain));
    // Another student can neither see nor use that private attachment.
    const other = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const otherAuth = await other.auth.signInAnonymously();
    const peek = await other.from('class_documents').select('id').eq('id', docId);
    check(!peek.error && peek.data.length === 0, 'private attachment invisible to another student');
    const steal = await call('npc-chat', otherAuth.data.session.access_token, { npc_id: npcId, message: 'explain this', attachment_ids: [docId] });
    check(steal.status === 404, 'another student cannot chat with this NPC or borrow the file', short(steal));

    // 3) Current events: real Google Search grounding with valid citations.
    const news = await chat('Can you search online for the latest news about NASA Artemis missions?', conv);
    check(news.status === 200, 'search turn succeeds (or degrades) without breaking chat', short(news));
    show('news', news);
    const web = news.json?.web_sources ?? [];
    check(news.json?.web_search === 'used' ? web.length > 0 && web.every((s) => /^https:\/\//.test(s.url) && s.title) : news.json?.web_search === 'failed',
        `web search outcome "${news.json?.web_search}" with ${web.length} https citation(s)`, JSON.stringify(web).slice(0, 300));

    // 4) Personalisation: proposed, not saved until confirmed.
    const ask = await chat('From now on, please remember to always use short explanations.', conv);
    const pending = ask.json?.preference?.pending ?? '';
    check(ask.status === 200 && pending && !ask.json?.preference?.saved, 'asks before remembering a lasting preference', short(ask));
    let prefs = await db.from('npc_memories').select('learning_preferences, pending_preference').eq('npc_id', npcId).maybeSingle();
    check((prefs.data?.learning_preferences ?? []).length === 0, 'nothing saved before confirmation');
    const yes = await chat('Yes, please remember that.', conv);
    check(yes.json?.preference?.saved === pending, 'saved after the student confirms', short(yes));
    prefs = await db.from('npc_memories').select('learning_preferences').eq('npc_id', npcId).maybeSingle();
    check(prefs.data?.learning_preferences?.includes(pending), 'preference stored on this student + NPC');
    const forget = await db.rpc('forget_teaching_preference', { p_npc_id: npcId, p_preference: null });
    check(!forget.error && forget.data.length === 0, 'student can reset saved preferences', forget.error?.message);

    // 5) Website coursework: public page saved + retrievable; private / invalid rejected.
    const site = await call('class-documents', token, { action: 'website', npc_id: npcId, visibility: 'class', url: 'https://en.wikipedia.org/wiki/Fraction', topic: 'Fractions' });
    check(site.status === 201 && site.json?.document?.processing_status === 'ready' && site.json.document.extraction?.kind === 'website', 'public website processed and saved as coursework', short(site));
    const found = await db.rpc('match_npc_chunks', { p_npc_id: npcId, p_query: 'fraction numerator denominator', p_limit: 5 });
    check((found.data ?? []).some((c) => c.document_id === site.json?.document?.id), 'website notes are retrievable for future sessions', found.error?.message);
    for (const bad of ['http://en.wikipedia.org/wiki/Fraction', 'https://127.0.0.1/', 'https://localhost/admin', 'https://169.254.169.254/latest/meta-data'])
    {
        const r = await call('class-documents', token, { action: 'website', npc_id: npcId, visibility: 'class', url: bad });
        check(r.status === 400, `rejected without fetching: ${bad}`, short(r));
    }
    const missing = await call('class-documents', token, { action: 'website', npc_id: npcId, visibility: 'class', url: 'https://this-domain-does-not-exist-eduroam-check.com/page' });
    check(missing.status === 422, 'non-existent site fails safely (nothing saved)', short(missing));

    // 6) Coursework questions prioritise the saved material.
    const course = await chat('According to my saved coursework, what is a fraction?', conv);
    check(course.status === 200 && (course.json?.sources ?? []).length > 0 && course.json?.knowledge?.coursework, 'coursework question cites the saved material', short(course));
}
catch (err)
{
    check(false, 'unexpected error', err instanceof Error ? err.message : String(err));
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
