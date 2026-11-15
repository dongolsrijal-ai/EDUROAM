// Account village sync (services/npcSync.ts): Supabase is the source of truth for NPCs.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';
import { createClient } from '@supabase/supabase-js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
let server: ViteDevServer;
before(async () =>
{
    server = await createServer({ configFile: false, root: realpathSync.native(fileURLToPath(new URL('..', import.meta.url))), logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
        plugins: [{ name: 'npc-sync-test', enforce: 'pre', resolveId(id, importer) { if (id === './backend' && importer?.replaceAll('\\', '/').endsWith('/services/tutorApi.ts')) return '\0npc-sync-test'; },
            load(id) { if (id === '\0npc-sync-test') return 'export const supabase=()=>globalThis.__sync.db; export const getSession=async()=>({user:{id:globalThis.__sync.owner}}); export const publicConfig={};'; } }],
    });
});
after(async () => { await server.close(); });

interface Row { id: string; owner_id: string; game_npc_id: string; name: string; subject: string; appearance: string; class_id: string; game_state: any; personality?: string; teaching_instructions?: string }

/** A tiny owner-scoped PostgREST fake: npcs, classes, npc_deletions. */
function fakeDb (owner: string, rows: Row[], deletions: { game_npc_id: string }[] = [], opts: { failGet?: boolean; failWrite?: (body: any) => boolean } = {})
{
    const writes: { method: string; body: any }[] = [];
    const eq = (url: URL, key: string) => url.searchParams.get(key)?.replace(/^eq\./, '');
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const one = request.headers.get('accept')?.includes('vnd.pgrst.object');
        const reply = (data: unknown[], status = 200) => Response.json(one ? data[0] ?? null : data, { status });
        const body = request.method === 'GET' ? null : await request.json();
        if (url.pathname.endsWith('/npc_deletions')) return reply(deletions.filter((d) => !eq(url, 'game_npc_id') || d.game_npc_id === eq(url, 'game_npc_id')).map((d) => ({ ...d, npc_id: 'x', completed_at: 'now' })));
        if (url.pathname.endsWith('/classes')) return reply([{ id: 'class-1', name: body?.name ?? 'Math' }], body ? 201 : 200);
        if (url.pathname.endsWith('/npcs'))
        {
            if (request.method === 'GET')
            {
                if (opts.failGet) return Response.json({ message: 'Database unavailable' }, { status: 503 });
                return reply(rows.filter((r) => r.owner_id === owner && (!eq(url, 'game_npc_id') || r.game_npc_id === eq(url, 'game_npc_id'))));
            }
            writes.push({ method: request.method, body });
            if (opts.failWrite?.(body)) return Response.json({ message: 'NPC limit reached (10/10)', code: 'P0001' }, { status: 400 });
            const id = eq(url, 'id');
            const existing = rows.find((r) => (id ? r.id === id : r.game_npc_id === body.game_npc_id && r.owner_id === owner));
            const row = { ...(existing ?? { id: `remote-${rows.length + 1}`, owner_id: owner, class_id: 'class-1' }), ...body } as Row;
            rows.splice(0, rows.length, ...rows.filter((r) => r !== existing), row);
            return reply([row], 201);
        }
        return Response.json({}, { status: 404 });
    };
    const client = createClient('https://test.supabase.co', 'fake', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch } });
    client.auth.getUser = async () => ({ data: { user: { id: owner } }, error: null }) as any;
    return { db: client, writes };
}

async function load (storage: Map<string, string>, owner: string, db: ReturnType<typeof fakeDb>)
{
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
        getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
    } });
    (globalThis as any).__sync = { db: db.db, owner };
    const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    const { npcStore } = await runner.import('/src/game/data/npcStore.ts');
    const sync = await runner.import('/src/game/services/npcSync.ts');
    npcStore.useAccount(owner);
    return { npcStore, sync, close: () => runner.close() };
}

const placed = (x: number) => ({ v: 1, map: 'hub', x, y: 400, dialogue: ['hi'], reactions: {}, minigameType: null, completed: true, building: { id: `bld_${x}`, type: 'lab', map: 'hub', x: x - 32, y: 360 } });
const row = (owner: string, id: string, game_state: any = {}): Row => ({ id: `r-${id}`, owner_id: owner, game_npc_id: id, name: id, subject: 'Math', appearance: 'scientist', class_id: 'class-1', game_state });
const localSave = (...ids: string[]) => JSON.stringify({ version: 2, npcs: ids.map((id, i) => ({ id, name: id, subject: 'Math', appearance: 'scientist', map: 'hub', x: 700 + i, y: 500, dialogue: [], minigameType: null, completed: false, createdAt: '', updatedAt: '' })), buildings: [] });

test('login restores the account\'s NPCs, buildings and positions from Supabase without writing anything', async () =>
{
    const storage = new Map([['eduroam.npcs.legacyClaimedBy', '"someone"']]);
    const db = fakeDb(A, [row(A, 'npc_bob', placed(900)), row(B, 'npc_other', placed(100))]);
    const s = await load(storage, A, db);
    try
    {
        assert.equal(s.npcStore.editable(), false, 'editing is blocked until the first sync finishes');
        await s.sync.loadAccountVillage(A);
        assert.equal(s.npcStore.editable(), true);
        assert.deepEqual(s.npcStore.all().map((n: any) => [n.id, n.x, n.y, n.completed, n.dialogue[0]]), [['npc_bob', 900, 400, true, 'hi']], 'only this account\'s NPCs, at their saved spot');
        const building = s.npcStore.buildingOf('npc_bob');
        assert.deepEqual([building.id, building.x, building.y], ['bld_900', 868, 360]);
        assert.equal(db.writes.length, 0, 'a normal login never inserts or updates NPCs');
        assert.ok(storage.get(`eduroam.npcs.account.${A}`)?.includes('npc_bob'), 'cached under this account only');
        assert.equal(storage.get('eduroam.npcs'), undefined, 'the signed-out device save is not touched');
    }
    finally { await s.close(); }
});

test('rows saved before placements existed take their spot from the local copy and are written back (update, no insert)', async () =>
{
    const storage = new Map([['eduroam.npcs', localSave('npc_old')], ['eduroam.npcs.legacyClaimedBy', `"${A}"`]]);
    const db = fakeDb(A, [row(A, 'npc_old')]);
    const s = await load(storage, A, db);
    try
    {
        await s.sync.loadAccountVillage(A);
        assert.equal(s.npcStore.get('npc_old').x, 700);
        assert.equal(db.writes.length, 1);
        assert.equal(db.writes[0].method, 'PATCH', 'existing row is updated by its id');
        assert.equal(db.writes[0].body.game_state.x, 700);
    }
    finally { await s.close(); }
});

test('without an explicit choice by the player, signed-out NPCs of a browser are never copied into an account', async () =>
{
    const storage = new Map([['eduroam.npcs', localSave('npc_local')]]);
    const db = fakeDb(A, [row(A, 'npc_bob', placed(900))]);
    const s = await load(storage, A, db);
    try
    {
        const result = await s.sync.loadAccountVillage(A);
        assert.equal(result.imported, 0);
        assert.deepEqual(s.npcStore.all().map((n: any) => n.id), ['npc_bob']);
        assert.equal(db.writes.length, 0);
        assert.ok(storage.get('eduroam.npcs')?.includes('npc_local'), 'the browser save is kept');
    }
    finally { await s.close(); }
});

test('after the player chose "add to my account": signed-out NPCs come over once; deleted ones are never recreated; other accounts get nothing', async () =>
{
    const storage = new Map([['eduroam.npcs', localSave('npc_keep', 'npc_deleted', 'sir-sum-a-lot')], ['eduroam.npcs.legacyClaimedBy', `"${A}"`]]);
    const dbA = fakeDb(A, [], [{ game_npc_id: 'npc_deleted' }]);
    let s = await load(storage, A, dbA);
    try
    {
        const result = await s.sync.loadAccountVillage(A);
        assert.equal(result.imported, 1);
        assert.deepEqual(s.npcStore.all().map((n: any) => n.id), ['npc_keep']);
        assert.deepEqual(dbA.writes.map((w) => w.body.game_npc_id), ['npc_keep'], 'the tombstoned NPC is never sent; nor the built-in default every device save starts with');
        assert.equal(dbA.writes[0].body.game_state.x, 700, 'its placement goes with it');
        assert.equal(storage.get('eduroam.npcs.legacyImportedBy'), `"${A}"`);
        await s.sync.loadAccountVillage(A);
        assert.equal(dbA.writes.length, 1, 'they come over only once');
    }
    finally { await s.close(); }

    const dbB = fakeDb(B, [], [{ game_npc_id: 'sir-sum-a-lot' }]);
    s = await load(storage, B, dbB);
    try
    {
        const result = await s.sync.loadAccountVillage(B);
        assert.equal(result.imported, 0, 'the signed-out NPCs moved to account A only');
        assert.equal(result.seeded, 0, 'an account that deleted NPCs before is not re-seeded');
        assert.equal(s.npcStore.all().length, 0);
        assert.equal(dbB.writes.length, 0);
    }
    finally { await s.close(); }
});

test('a brand-new account gets the default NPCs saved to Supabase; a refused save is undone and explained', async () =>
{
    // Unclaimed device save: the new account's Sir keeps this browser's progress (completed, moved).
    const device = JSON.parse(localSave('sir-sum-a-lot'));
    device.npcs[0] = { ...device.npcs[0], name: 'Sir Sum-a-Lot', completed: true };
    const storage = new Map([['eduroam.npcs', JSON.stringify(device)], ['eduroam.npcs.legacyClaimedBy', `"${A}"`]]);
    let db = fakeDb(A, []);
    let s = await load(storage, A, db);
    try
    {
        const result = await s.sync.loadAccountVillage(A);
        assert.equal(result.seeded, 1);
        assert.deepEqual(s.npcStore.all().map((n: any) => n.id), ['sir-sum-a-lot']);
        assert.equal(db.writes[0].body.game_npc_id, 'sir-sum-a-lot');
        assert.equal(db.writes[0].body.game_state.completed, true, 'progress from this browser kept');
        assert.equal(db.writes.length, 1, 'seeded once, not also imported');
    }
    finally { await s.close(); }

    db = fakeDb(B, [], [], { failWrite: () => true });
    s = await load(new Map([['eduroam.npcs.legacyClaimedBy', '"someone"']]), B, db);
    try
    {
        const result = await s.sync.loadAccountVillage(B);
        assert.equal(s.npcStore.all().length, 0, 'nothing the server refused stays in the village');
        assert.match(result.warnings[0], /could not be saved to your account: NPC limit reached/);
    }
    finally { await s.close(); }
});

test('a failed load leaves editing paused with the error; saveNpc writes the current placement', async () =>
{
    const db = fakeDb(A, [row(A, 'npc_bob', placed(900))], [], { failGet: true });
    const s = await load(new Map([['eduroam.npcs.legacyClaimedBy', '"x"']]), A, db);
    try
    {
        await assert.rejects(s.sync.loadAccountVillage(A));
        assert.equal(s.npcStore.editable(), false);
        assert.match(s.npcStore.syncStatus().message, /Could not load your NPCs/);
        assert.equal(s.npcStore.create({ name: 'x', subject: 'Math', appearance: 'scientist', dialogue: [], minigameType: null }, { map: 'hub', x: 1, y: 1, npcX: 1, npcY: 1 }).ok, false, 'no edits on top of an unloaded village');
    }
    finally { await s.close(); }

    const ok = fakeDb(A, [row(A, 'npc_bob', placed(900))]);
    const t = await load(new Map([['eduroam.npcs.legacyClaimedBy', '"x"']]), A, ok);
    try
    {
        await t.sync.loadAccountVillage(A);
        assert.equal(t.npcStore.relocate('npc_bob', { map: 'hub', x: 1200, y: 600, npcX: 1232, npcY: 650 }).ok, true);
        await t.sync.saveNpc('npc_bob');
        const sent = ok.writes.at(-1)!.body.game_state;
        assert.deepEqual([sent.x, sent.y, sent.building.x, sent.building.y, sent.building.id], [1232, 650, 1200, 600, 'bld_900'], 'stable building id, new spot');
    }
    finally { await t.close(); }
});
