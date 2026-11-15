// Procedural dungeon generation: connectivity, reachability and fairness across many seeds.
// Run: npm test

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

type Gen = typeof import('../src/game/world/dungeon/generate.ts');
type Build = typeof import('../src/game/world/dungeon/build.ts');
type Tiles = typeof import('../src/game/world/dungeon/tiles.ts');
type Biomes = typeof import('../src/game/world/dungeon/biomes.ts');
type Enc = typeof import('../src/game/world/dungeon/encounters.ts');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let server: ViteDevServer;
let runner: ReturnType<typeof createServerModuleRunner>;
let gen: Gen, build: Build, tiles: Tiles, biomes: Biomes, enc: Enc;

before(async () =>
{
    server = await createServer({
        configFile: false, root: ROOT, logLevel: 'error', appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] },
    });
    runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    gen = await runner.import('/src/game/world/dungeon/generate.ts');
    build = await runner.import('/src/game/world/dungeon/build.ts');
    tiles = await runner.import('/src/game/world/dungeon/tiles.ts');
    biomes = await runner.import('/src/game/world/dungeon/biomes.ts');
    enc = await runner.import('/src/game/world/dungeon/encounters.ts');
});
after(async () =>
{
    await runner.close();
    await server.close();
});

/** Every floor of every tested run. */
function* floors (seeds = 300)
{
    for (let seed = 1; seed <= seeds; seed++)
    {
        for (const biomeId of biomes.BIOME_IDS)
        {
            for (const floorCount of [2, 3])
            {
                for (let floorIndex = 1; floorIndex <= floorCount; floorIndex++)
                {
                    const plan = gen.planFloor({ seed: seed * 7919, biomeId, floorIndex, floorCount });
                    yield { plan, built: build.buildDungeon(plan, gen.floorSeed(seed, floorIndex)) };
                }
            }
        }
    }
}

test('every generated floor is connected, non-overlapping and has the right rooms', () =>
{
    let count = 0;
    for (const { plan } of floors())
    {
        count++;
        const where = `seed ${plan.seed} ${plan.biomeId} ${plan.floorIndex}/${plan.floorCount}`;
        for (const [i, a] of plan.rooms.entries()) for (const b of plan.rooms.slice(i + 1))
        {
            const apart = a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y;
            assert.ok(apart, `rooms ${a.id} and ${b.id} overlap (${where})`);
        }
        const byId = new Map(plan.rooms.map((r) => [r.id, r]));
        for (const [a, b] of plan.links)
        {
            const ra = byId.get(a)!, rb = byId.get(b)!;
            const cx = (r: typeof ra) => r.x + (r.w - 1) / 2, cy = (r: typeof ra) => r.y + (r.h - 1) / 2;
            const horizontal = ra.x + ra.w <= rb.x || rb.x + rb.w <= ra.x;
            if (horizontal)
            {
                assert.equal(cy(ra), cy(rb), 'linked rooms not aligned');
                assert.equal(Math.max(ra.x, rb.x) - Math.min(ra.x + ra.w, rb.x + rb.w), gen.CORRIDOR, 'corridor length');
            }
            else
            {
                assert.equal(cx(ra), cx(rb), 'linked rooms not aligned');
                assert.equal(Math.max(ra.y, rb.y) - Math.min(ra.y + ra.h, rb.y + rb.h), gen.CORRIDOR, 'corridor length');
            }
        }
        // Bigger rooms: combat rooms >= 40 % larger per side than the old 15x11; boss arena >= 4x area.
        for (const r of plan.rooms.filter((room) => room.role === 'combat'))
        {
            assert.ok(r.w >= 21 && r.h >= 15, `combat room too small: ${r.template} ${r.w}x${r.h}`);
        }
        for (const r of plan.rooms.filter((room) => room.role === 'boss')) assert.ok(r.w * r.h >= 4 * 15 * 11, 'boss arena not large');
        // Compact footprint: not mostly void.
        const roomArea = plan.rooms.reduce((n, r) => n + r.w * r.h, 0);
        const boxW = Math.max(...plan.rooms.map((r) => r.x + r.w)) - Math.min(...plan.rooms.map((r) => r.x));
        const boxH = Math.max(...plan.rooms.map((r) => r.y + r.h)) - Math.min(...plan.rooms.map((r) => r.y));
        assert.ok(boxW * boxH <= roomArea * 4, `footprint too sparse (${where})`);
        // Room graph connected from the start room.
        const seen = new Set([plan.mainPath[0]]);
        const queue = [plan.mainPath[0]];
        while (queue.length)
        {
            const id = queue.shift()!;
            for (const [a, b] of plan.links)
            {
                const other = a === id ? b : b === id ? a : null;
                if (other && !seen.has(other)) { seen.add(other); queue.push(other); }
            }
        }
        assert.equal(seen.size, plan.rooms.length, 'unreachable room');
        const roles = plan.rooms.map((r) => r.role);
        assert.equal(byId.get(plan.mainPath[0])!.role, 'start');
        const last = byId.get(plan.mainPath[plan.mainPath.length - 1])!.role;
        assert.equal(last, plan.floorIndex === plan.floorCount ? 'boss' : 'exit');
        assert.equal(roles.filter((r) => r === 'boss').length, plan.floorIndex === plan.floorCount ? 1 : 0);
        // Fewer, meaningful rooms: combat count per floor plan, treasure on every non-final floor.
        assert.equal(roles.filter((r) => r === 'combat').length, gen.combatRoomCount(plan.floorIndex, plan.floorCount));
        const isFinal = plan.floorIndex === plan.floorCount;
        const meaningful = roles.filter((r) => r === 'combat' || r === 'treasure' || r === 'shrine').length;
        assert.ok(roles.filter((r) => r === 'treasure').length <= 1);
        if (!isFinal) assert.ok(meaningful >= 2 && meaningful <= 5, `meaningful rooms ${meaningful}`);
        else assert.ok(meaningful >= 1 && meaningful <= 4);
        assert.ok(plan.rooms.length <= 7, `${plan.rooms.length} rooms`);
    }
    assert.ok(count > 2000, `tested ${count} floors`);
});

test('tiles: spawn, exit, boss, chests, shrine and every enemy slot are reachable; doors open onto floor', () =>
{
    for (const { plan, built } of floors())
    {
        const { grid, markers, rooms, cols, rows } = built;
        const solid = new Set(markers.filter((m) => build.SOLID_MARKERS.includes(m.type)).map((m) => `${m.x},${m.y}`));
        const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && tiles.isWalkableTile(grid[y][x]) && !solid.has(`${x},${y}`);
        const spawn = markers.filter((m) => m.type === 'spawn');
        assert.equal(spawn.length, 1, 'exactly one player spawn');
        assert.ok(walk(spawn[0].x, spawn[0].y), 'player spawns inside a wall / object');

        const reached = new Set([`${spawn[0].x},${spawn[0].y}`]);
        const queue = [[spawn[0].x, spawn[0].y]];
        while (queue.length)
        {
            const [x, y] = queue.pop()!;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
            {
                const k = `${x + dx},${y + dy}`;
                if (!reached.has(k) && walk(x + dx, y + dy)) { reached.add(k); queue.push([x + dx, y + dy]); }
            }
        }
        const reachable = (x: number, y: number) => reached.has(`${x},${y}`);
        const nextTo = (x: number, y: number) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => reachable(x + dx, y + dy));
        const where = `seed ${plan.seed} ${plan.biomeId} floor ${plan.floorIndex}/${plan.floorCount}`;

        for (const m of markers)
        {
            if (m.type === 'portal' || m.type === 'guardian' || m.type === 'enemySlot') assert.ok(reachable(m.x, m.y), `${m.type} unreachable (${where})`);
            if (m.type === 'chest' || m.type === 'finalChest' || m.type === 'shrine') assert.ok(nextTo(m.x, m.y), `${m.type} inaccessible (${where})`);
            if (m.type === 'enemySlot') assert.ok(!solid.has(`${m.x},${m.y}`), 'enemy slot inside an obstacle');
            if (m.type === 'door') assert.ok(reachable(m.x, m.y), `door leads into a wall (${where})`);
        }
        for (const room of rooms)
        {
            let any = false;
            for (let y = room.y + 1; y < room.y + room.h - 1 && !any; y++) for (let x = room.x + 1; x < room.x + room.w - 1; x++) if (reachable(x, y)) { any = true; break; }
            assert.ok(any, `room ${room.id} (${room.role}) unreachable (${where})`);
            if (room.role !== 'start') assert.ok(room.doors.length > 0, 'room without a door');
        }
        const portals = markers.filter((m) => m.type === 'portal').length;
        assert.equal(portals, 1, 'exactly one exit portal');
        if (plan.floorIndex === plan.floorCount)
        {
            assert.equal(markers.filter((m) => m.type === 'guardian').length, 1);
            assert.equal(markers.filter((m) => m.type === 'finalChest').length, 1);
        }
    }
});

test('generation is deterministic per seed and varied across seeds', () =>
{
    const a = gen.planFloor({ seed: 1234, biomeId: 'crypt', floorIndex: 2, floorCount: 3 });
    const b = gen.planFloor({ seed: 1234, biomeId: 'crypt', floorIndex: 2, floorCount: 3 });
    assert.deepEqual(a, b);
    assert.deepEqual(build.buildDungeon(a, 9).grid, build.buildDungeon(b, 9).grid);
    const shapes = new Set<string>();
    for (let seed = 1; seed <= 60; seed++)
    {
        const p = gen.planFloor({ seed: seed * 104729, biomeId: 'ruins', floorIndex: 1, floorCount: 3 });
        shapes.add(p.rooms.map((r) => `${r.role}@${r.x},${r.y}:${r.template}`).join('|'));
    }
    assert.ok(shapes.size >= 45, `only ${shapes.size} distinct layouts in 60 seeds`);
});

test('biomes never repeat back to back when another exists', () =>
{
    let rnd = 0;
    const random = () => (rnd = (rnd + 0.37) % 1);
    let last: string | null = null;
    for (let i = 0; i < 50; i++)
    {
        const next = biomes.pickBiome(random, last);
        assert.notEqual(next, last);
        last = next;
    }
});

test('encounters: beginner-only at tower level 1 floor 1, variety unlocks later, waves stay small', () =>
{
    const crypt = biomes.BIOMES.crypt;
    for (let seed = 1; seed <= 200; seed++)
    {
        const early = enc.rollRoomWaves(seed, 'r1', crypt, { towerLevel: 1, floorIndex: 1 }, 8);
        assert.ok(early.flat().every((id) => id === 'zombie' || id === 'goblin'), `tower 1 floor 1 rolled ${early.flat()}`);
        for (const wave of early) assert.ok(wave.length >= 1 && wave.length <= enc.MAX_WAVE_SIZE);
        const late = enc.rollRoomWaves(seed, 'r1', crypt, { towerLevel: 8, floorIndex: 3 }, 8);
        assert.ok(late.flat().every((id) => id !== 'skeleton' && id !== 'hades'), 'summons/bosses never rolled');
        assert.deepEqual(enc.rollRoomWaves(seed, 'r1', crypt, { towerLevel: 1, floorIndex: 1 }, 8), early, 'same seed, same fight');
    }
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) enc.rollRoomWaves(seed, 'r2', crypt, { towerLevel: 4, floorIndex: 3 }, 8).flat().forEach((k) => kinds.add(k));
    for (const k of ['wizard', 'giant', 'reaper']) assert.ok(kinds.has(k), `${k} never appears on later floors`);
});

test('boss arena: open centre around Hades, entrance clear, chest + exit reachable; spawns never at doors', () =>
{
    for (const { plan, built } of floors(80))
    {
        const where = `seed ${plan.seed} ${plan.biomeId} ${plan.floorIndex}/${plan.floorCount}`;
        const solids = built.markers.filter((m) => build.SOLID_MARKERS.includes(m.type));
        for (const room of built.rooms)
        {
            const doors = room.doors;
            for (const slot of built.markers.filter((m) => m.type === 'enemySlot' && m.roomId === room.id))
            {
                assert.ok(doors.every((d) => Math.abs(d.x - slot.x) + Math.abs(d.y - slot.y) >= 4), `enemy slot next to a door (${where})`);
            }
            // Nothing solid directly inside a doorway's approach.
            for (const d of doors)
            {
                assert.ok(!solids.some((s) => Math.abs(s.x - d.x) + Math.abs(s.y - d.y) <= 2), `prop blocks a doorway (${where})`);
            }
            if (room.role !== 'boss') continue;
            const g = built.markers.find((m) => m.type === 'guardian')!;
            const clear = solids.filter((s) => s.roomId === room.id && Math.abs(s.x - g.x) <= 7 && Math.abs(s.y - g.y) <= 5);
            assert.equal(clear.length, 0, `obstacles crowd Hades (${where})`);
            assert.ok(room.w >= 31 && room.h >= 23, 'boss arena size');
        }
    }
});

test('rendered room templates keep door lanes clear and match their declared size', async () =>
{
    const rooms = await runner.import('/src/game/world/dungeon/rooms.ts') as typeof import('../src/game/world/dungeon/rooms.ts');
    for (const id of Object.keys(rooms.ROOM_SPECS) as (keyof typeof rooms.ROOM_SPECS)[])
    {
        const spec = rooms.ROOM_SPECS[id];
        for (let s = 0; s < 20; s++)
        {
            let n = s;
            const rows = rooms.renderRoom(id, () => ((n = (n * 9301 + 49297) % 233280) / 233280));
            assert.equal(rows.length, spec.h);
            assert.ok(rows.every((r) => r.length === spec.w), `${id} width`);
            rows.forEach((row, y) => [...row].forEach((ch, x) =>
            {
                if (rooms.inDoorLane(spec, x, y) && x > 0 && y > 0 && x < spec.w - 1 && y < spec.h - 1) assert.ok(ch === '.' || ch === 'd', `${id}: "${ch}" in a door lane at ${x},${y}`);
            }));
        }
    }
});
