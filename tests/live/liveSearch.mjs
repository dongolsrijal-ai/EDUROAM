// LIVE: one Google Search tutoring turn (NOT part of npm test). Either real grounded citations,
// or an honest "could not verify" answer when search is unavailable; chat must never break.
//   node tests/live/liveSearch.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: auth } = await db.auth.signInAnonymously();
const userId = auth.user.id;
const cls = await db.from('classes').upsert({ owner_id: userId, name: 'Science', subject: 'Science' }, { onConflict: 'owner_id,name_key' }).select('id').single();
const npc = await db.from('npcs').upsert({ owner_id: userId, class_id: cls.data.id, game_npc_id: 'e2e_search', name: 'Dr Fern', appearance: 'scientist', subject: 'Science' }, { onConflict: 'owner_id,game_npc_id' }).select('id').single();
const res = await fetch(`${env.VITE_SUPABASE_URL}/functions/v1/npc-chat`, {
    method: 'POST', headers: { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json', Authorization: `Bearer ${auth.session.access_token}` },
    body: JSON.stringify({ npc_id: npc.data.id, message: 'Can you search online for the latest news about NASA Artemis missions?' }),
});
const json = await res.json();
const web = json.web_sources ?? [];
console.log(`status ${res.status} · web_search=${json.web_search} · ${web.length} citation(s)`);
console.log(`reply: ${String(json.reply ?? json.error?.message).replace(/\s+/g, ' ').slice(0, 400)}`);
for (const s of web) console.log(`  - ${s.title} -> ${s.url.slice(0, 80)}`);
const ok = res.status === 200 && (json.web_search === 'used' ? web.length > 0 && web.every((s) => /^https:\/\//.test(s.url)) : json.web_search === 'failed' && !web.length);
console.log(ok ? 'PASS  search turn: grounded citations or honest failure, chat intact' : 'FAIL  search turn');
process.exit(ok ? 0 : 1);
