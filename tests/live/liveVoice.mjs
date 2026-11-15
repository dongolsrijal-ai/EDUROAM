// LIVE FaceTime Tutor pairing checks against the real project (NOT part of npm test).
//   node tests/live/liveVoice.mjs setup <state.json>
//       two guest students, each with their own class + NPC (Biology / History) and a PRIVATE
//       note; checks the student endpoint (voice-session) authorisation; writes ids to state.json
//   node tests/live/liveVoice.mjs agent <state.json>     (needs VOICE_AGENT_SECRET in the env)
//       state.json must also hold pairing ids created by create_voice_session (server side);
//       checks resolve (single use, right NPC/memory/coursework), search isolation and end.
// Prints PASS/FAIL lines only (never tokens or secrets).

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const [mode, statePath] = process.argv.slice(2);
const results = [];
const check = (ok, label, detail = '') => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  -> ${detail}` : ''}`); };
const short = (r) => `${r.status} ${JSON.stringify(r.json)?.slice(0, 260)}`;

async function call (name, bearer, body)
{
    const res = await fetch(`${URL_}/functions/v1/${name}`, {
        method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); }
    catch { /* empty */ }
    return { status: res.status, json };
}

async function student (subject, note)
{
    const db = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data } = await db.auth.signInAnonymously();
    const userId = data.user.id;
    const cls = await db.from('classes').upsert({ owner_id: userId, name: subject, subject }, { onConflict: 'owner_id,name_key' }).select('id').single();
    const npc = await db.from('npcs').upsert({ owner_id: userId, class_id: cls.data.id, game_npc_id: `e2e_voice_${subject.toLowerCase()}`, name: subject === 'Biology' ? 'Professor Bob' : 'Lady Chronos', appearance: 'scientist', subject },
        { onConflict: 'owner_id,game_npc_id' }).select('id').single();
    const paste = await call('class-documents', data.session.access_token, { action: 'paste', npc_id: npc.data.id, visibility: 'private', title: `${subject} private notes`, text: note });
    return { userId, token: data.session.access_token, npcId: npc.data.id, docReady: paste.json?.document?.processing_status === 'ready' };
}

if (mode === 'setup')
{
    const a = await student('Biology', 'Private biology notes: chloroplasts capture light energy; the secret code word is ZEBRAFINCH for this student only.');
    const b = await student('History', 'Private history notes: Augustus became the first Roman emperor; the secret code word is PAPYRUSQUILL for this student only.');
    check(a.docReady && b.docReady, 'two students, each with their own NPC and a private processed note');

    check((await call('voice-session', null, { action: 'start', npc_id: a.npcId })).status === 401, 'voice-session: no JWT -> 401');
    check((await call('voice-session', KEY, { action: 'start', npc_id: a.npcId })).status === 401, 'voice-session: publishable key is not a user -> 401');
    const crossAB = await call('voice-session', a.token, { action: 'start', npc_id: b.npcId });
    check(crossAB.status === 404, 'student A cannot start a call with student B\'s History NPC', short(crossAB));
    const crossBA = await call('voice-session', b.token, { action: 'start', npc_id: a.npcId, player_id: a.userId });
    check(crossBA.status === 404, 'student B cannot start a call with A\'s Biology NPC (even sending A\'s player id)', short(crossBA));
    const own = await call('voice-session', a.token, { action: 'start', npc_id: a.npcId });
    check(own.status === 201 ? Boolean(own.json?.token && own.json?.room && !('pairing_id' in own.json)) : own.json?.error?.code === 'voice_not_configured',
        `student A's own NPC passes authorisation (${own.status === 201 ? 'call created; browser gets only a join token' : 'then: LiveKit not configured'})`, short(own));
    const agentNoSecret = await call('voice-agent', null, { action: 'resolve', pairing_id: '50000000-0000-4000-8000-000000000001' });
    check([401, 503].includes(agentNoSecret.status), `voice-agent without the agent secret is refused (${agentNoSecret.status})`);
    const agentUserJwt = await call('voice-agent', a.token, { action: 'resolve', pairing_id: '50000000-0000-4000-8000-000000000001' });
    check([401, 503].includes(agentUserJwt.status), `a student JWT is not the agent secret (${agentUserJwt.status})`);
    writeFileSync(statePath, JSON.stringify({ a: { userId: a.userId, npcId: a.npcId, token: a.token }, b: { userId: b.userId, npcId: b.npcId, token: b.token } }, null, 2));
}
else if (mode === 'agent')
{
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const secret = process.env.VOICE_AGENT_SECRET;
    const agent = (body) => call('voice-agent', secret, body);
    check((await call('voice-agent', `${secret}x`, { action: 'resolve', pairing_id: state.a.pairing })).status === 401, 'wrong agent secret -> 401');

    const ra = await agent({ action: 'resolve', pairing_id: state.a.pairing });
    const rb = await agent({ action: 'resolve', pairing_id: state.b.pairing });
    check(ra.status === 200 && ra.json.npc.name === 'Professor Bob' && ra.json.npc.class_name === 'Biology', 'A\'s pairing resolves to the Biology NPC', short(ra));
    check(rb.status === 200 && rb.json.npc.name === 'Lady Chronos' && rb.json.npc.class_name === 'History', 'B\'s pairing resolves to the History NPC', short(rb));
    const aText = JSON.stringify(ra.json?.coursework);
    const bText = JSON.stringify(rb.json?.coursework);
    check(/ZEBRAFINCH/.test(aText) && !/PAPYRUSQUILL/.test(aText), 'Biology session gets A\'s own private note and nothing from History / B', aText.slice(0, 200));
    check(/PAPYRUSQUILL/.test(bText) && !/ZEBRAFINCH/.test(bText), 'History session gets B\'s note and nothing from Biology / A', bText.slice(0, 200));
    check(Array.isArray(ra.json?.teaching_preferences) && typeof ra.json?.memory?.summary === 'string' && /Professor Bob/.test(ra.json?.instructions ?? ''), 'returns preferences, memory and voice instructions');
    check((await agent({ action: 'resolve', pairing_id: state.a.pairing })).status === 404, 'a pairing id works only once');

    const sa = await agent({ action: 'search', pairing_id: state.a.pairing, query: 'Augustus Roman emperor PAPYRUSQUILL' });
    check(sa.status === 200 && !/PAPYRUSQUILL|Augustus/.test(JSON.stringify(sa.json)), 'search during A\'s call never returns B\'s History notes', short(sa));
    const sa2 = await agent({ action: 'search', pairing_id: state.a.pairing, query: 'chloroplasts light energy' });
    check(sa2.status === 200 && /ZEBRAFINCH/.test(JSON.stringify(sa2.json)), 'search finds A\'s own coursework', short(sa2));
    check((await agent({ action: 'search', pairing_id: state.unclaimed, query: 'chloroplasts' })).status === 404, 'search needs a claimed session');

    const end = await agent({ action: 'end', pairing_id: state.a.pairing, summary: 'Voice call: explained how chloroplasts capture light energy.', topics: ['chloroplasts'] });
    check(end.status === 200 && end.json?.saved === true, 'end saves the learning summary', short(end));
    check((await agent({ action: 'end', pairing_id: state.a.pairing, summary: 'overwrite attempt' })).json?.reason === 'already_ended', 'end works once');
    check((await agent({ action: 'search', pairing_id: state.a.pairing, query: 'chloroplasts' })).status === 404, 'ended session accepts no more tool calls');

    const dbA = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${state.a.token}` } } });
    const memA = await dbA.from('npc_memories').select('summary, current_topic, channels_used').eq('npc_id', state.a.npcId).maybeSingle();
    check(/chloroplasts capture light/.test(memA.data?.summary ?? '') && memA.data?.channels_used?.includes('facetime'), 'A\'s NPC memory now holds the call summary (channel facetime)', JSON.stringify(memA.data));
    const dbB = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${state.b.token}` } } });
    const memB = await dbB.from('npc_memories').select('summary').eq('npc_id', state.b.npcId).maybeSingle();
    check(!/chloroplasts/.test(memB.data?.summary ?? ''), 'B\'s memory is untouched');
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
