import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';
import { createClient } from '@supabase/supabase-js';

const owner = 'aaaaaaaa-0000-4000-8000-000000000001';
const remoteId = 'bbbbbbbb-0000-4000-8000-000000000001';
const record = { id: 'npc_bob', name: 'bob', subject: 'Math', appearance: 'scientist', map: 'hub', x: 0, y: 0, dialogue: [], minigameType: null, completed: false, createdAt: '', updatedAt: '' } as const;
const npc = { id: remoteId, game_npc_id: record.id, owner_id: owner, name: 'bob', class_id: 'class-1', classes: { name: 'Math' } };
let server: ViteDevServer;
before(async () =>
{
    server = await createServer({ configFile: false, root: realpathSync.native(fileURLToPath(new URL('..', import.meta.url))), logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
        plugins: [{ name: 'npc-backend-test', enforce: 'pre', resolveId(id, importer) { if (id === './backend' && importer?.replaceAll('\\', '/').endsWith('/services/tutorApi.ts')) return '\0npc-backend-test'; },
            load(id) { if (id === '\0npc-backend-test') return 'export const supabase=()=>globalThis.__npcBackend.db; export const getSession=async()=>({user:{id:globalThis.__npcBackend.owner}}); export const publicConfig={};'; } }],
    });
});
after(async () => { await server.close(); });

async function setup (handler: (request: Request) => Promise<Response>)
{
    const calls: Request[] = [];
    const db = createClient('https://test.supabase.co', 'fake', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) =>
    {
        const request = new Request(input, init); calls.push(request);
        if (new URL(request.url).pathname === '/auth/v1/user') return Response.json({ id: owner });
        return handler(request);
    } } });
    db.auth.getUser = async () => ({ data: { user: { id: owner } }, error: null }) as any;
    (globalThis as any).__npcBackend = { db, owner };
    const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    const api = await runner.import('/src/game/services/tutorApi.ts');
    return { api, calls, close: () => runner.close() };
}
const read = (request: Request, rows: unknown[]) => Response.json(request.headers.get('accept')?.includes('vnd.pgrst.object') ? rows[0] : rows);

test('sync reuses stable remote id; existing NPC/class updates never attempt an INSERT at the limit', async () =>
{
    const s = await setup(async (r) =>
    {
        const path = new URL(r.url).pathname;
        if (r.method === 'POST') return Response.json({ message: 'NPC limit reached (10/10)', code: 'P0001' }, { status: 400 });
        return read(r, path.endsWith('/npc_deletions') ? [] : path.endsWith('/classes') ? [{ id: 'class-1', name: 'Math' }] : [npc]);
    });
    try
    {
        const first = await s.api.syncNpc(record);
        const second = await s.api.syncNpc({ ...record, name: 'bob renamed' });
        assert.equal(first.id, remoteId); assert.equal(second.id, remoteId);
        assert.equal(s.calls.filter((r) => r.method === 'POST').length, 0);
    }
    finally { await s.close(); }
});

test('delete uses the stable DB id and surfaces server cleanup failures without deleting locally', async () =>
{
    const s = await setup(async (r) =>
    {
        if (r.url.includes('/functions/')) return Response.json({ error: { code: 'cleanup_failed', message: 'Storage cleanup failed. Retry deletion.' } }, { status: 503 });
        return read(r, r.url.includes('/npc_deletions') ? [] : [npc]);
    });
    try
    {
        await assert.rejects(s.api.deleteRemoteNpc(record.id, owner), /Storage cleanup failed/);
        const call = s.calls.find((r) => r.url.endsWith('/functions/v1/npc-lifecycle'))!;
        assert.ok(call); assert.deepEqual(await call.json(), { action: 'delete', npc_id: remoteId, expected_owner_id: owner });
        assert.equal(s.calls.filter((r) => r.method === 'DELETE').length, 0);
    }
    finally { await s.close(); }
});

test('deletion is bound to the account that confirmed it before any irreversible request', async () =>
{
    const s = await setup(async (r) => read(r, [npc]));
    try
    {
        await assert.rejects(s.api.deleteRemoteNpc(record.id, 'previous-account'), /account changed/i);
        assert.equal(s.calls.some((r) => r.method !== 'GET'), false);
        assert.equal(s.calls.some((r) => r.url.includes('/npcs')), false);
    }
    finally { await s.close(); }
});

test('completed tombstone blocks stale sync, and read-only roster comparison never labels absent data as safe to delete', async () =>
{
    const s = await setup(async (r) => read(r, r.url.includes('/npc_deletions') ? [{ npc_id: remoteId, game_npc_id: record.id, completed_at: '2026-11-15' }] : [npc]));
    try
    {
        await assert.rejects(s.api.syncNpc(record), /deleted/);
        const roster = await s.api.loadNpcRoster();
        const report = s.api.compareNpcRoster([{ ...record, id: 'local_only' }], roster);
        assert.equal(report.serverCount, 1); assert.equal(report.localOnly.length, 1); assert.equal(report.serverOnly.length, 1);
        assert.equal(s.calls.some((r) => r.method !== 'GET'), false);
    }
    finally { await s.close(); }
});

test('voice lookup rechecks identity on every call and never syncs or resurrects a missing NPC', async () =>
{
    let missing = false;
    const s = await setup(async (r) => read(r, r.url.includes('/npc_deletions') || missing ? [] : [npc]));
    try
    {
        assert.equal((await s.api.findRemoteNpc(record)).id, remoteId);
        missing = true;
        assert.equal(await s.api.findRemoteNpc(record), null);
        assert.equal(s.calls.some((r) => r.method !== 'GET'), false);
    }
    finally { await s.close(); }
});

test('confirmed remote deletions hide stale village saves on reload, scoped to the signed-in account', async () =>
{
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
    } });
    data.set('eduroam.npcs', JSON.stringify({ version: 2, npcs: [record], buildings: [] }));
    // The account's own cached village (each account has its own key since Supabase is the source of truth).
    data.set(`eduroam.npcs.account.${owner}`, JSON.stringify({ version: 2, npcs: [record], buildings: [] }));
    let runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    try
    {
        let { npcStore } = await runner.import('/src/game/data/npcStore.ts');
        npcStore.useAccount(owner);
        npcStore.rememberRemoteDeletions(owner, [record.id]);
        assert.equal(npcStore.all().length, 0);
        assert.equal(npcStore.get(record.id), undefined);
        await runner.close();
        runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
        ({ npcStore } = await runner.import('/src/game/data/npcStore.ts'));
        npcStore.useAccount(owner);
        assert.equal(npcStore.all().length, 0, 'stale local save remains hidden after restart');
        assert.equal(npcStore.editable(), false, 'edits wait for the account village to load from Supabase');
        npcStore.useAccount('another-account');
        assert.equal(npcStore.all().length, 0, 'another account never sees this account village');
        npcStore.useAccount(null);
        assert.equal(npcStore.all()[0].id, record.id, 'the signed-out device save is untouched (tombstones are account-scoped)');
        assert.equal(npcStore.editable(), true);
        assert.equal(JSON.parse(data.get('eduroam.npcs')!).npcs.length, 1, 'reconciliation does not destroy unrelated local saves');
        assert.equal(JSON.parse(data.get(`eduroam.npcs.account.${owner}`)!).npcs.length, 1, 'tombstones hide, they never erase');
    }
    finally { await runner.close(); }
});
