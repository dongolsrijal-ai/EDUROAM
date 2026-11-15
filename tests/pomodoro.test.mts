// Pomodoro study loop (pure logic, no Phaser). Run: npm test

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';

type PomodoroModule = typeof import('../src/game/state/pomodoro.ts');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIN = 60_000;

class MemoryStorage
{
    data = new Map<string, string>();
    get length () { return this.data.size; }
    key (i: number) { return [...this.data.keys()][i] ?? null; }
    getItem (key: string) { return this.data.get(key) ?? null; }
    setItem (key: string, value: string) { this.data.set(key, String(value)); }
    removeItem (key: string) { this.data.delete(key); }
    clear () { this.data.clear(); }
}

let server: ViteDevServer;
const runners: ReturnType<typeof createServerModuleRunner>[] = [];

before(async () =>
{
    server = await createServer({
        configFile: false, root: ROOT, logLevel: 'error', appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] },
    });
});
after(async () =>
{
    await Promise.all(runners.map((r) => r.close()));
    await server.close();
});
afterEach(async () => { await Promise.all(runners.splice(0).map((r) => r.close())); });

/** Fresh module instance (= a page load) over the given storage. */
async function load (storage = new MemoryStorage()): Promise<PomodoroModule>
{
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
    const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    runners.push(runner);
    return runner.import('/src/game/state/pomodoro.ts') as Promise<PomodoroModule>;
}

test('pomodoro: 25 min focus gates the tower, then it opens', async () =>
{
    const { pomodoro, FOCUS_MS } = await load();
    const t0 = pomodoro.state.phaseStartedAt;
    assert.equal(FOCUS_MS, 25 * MIN);
    assert.equal(pomodoro.state.phase, 'focus');
    assert.equal(pomodoro.state.session, 1);
    assert.equal(pomodoro.remaining(t0), 25 * MIN);
    assert.equal(pomodoro.canEnterDungeon(t0 + 24 * MIN), false);
    assert.equal(pomodoro.enterDungeon(t0 + 24 * MIN), false, 'no dungeon during focus');
    assert.equal(pomodoro.remaining(t0 + 24 * MIN), MIN);
    assert.equal(pomodoro.tick(t0 + 25 * MIN), true);
    assert.equal(pomodoro.state.phase, 'ready');
    assert.equal(pomodoro.remaining(t0 + 40 * MIN), 0, 'ready waits as long as needed');
    assert.equal(pomodoro.canEnterDungeon(t0 + 40 * MIN), true);
});

test('pomodoro: dungeon time is a pacing target (overtime, never forced), finishing starts the next session', async () =>
{
    const { pomodoro, DUNGEON_MS } = await load();
    const t0 = pomodoro.state.phaseStartedAt;
    assert.equal(pomodoro.enterDungeon(t0 + 26 * MIN), true);
    assert.equal(pomodoro.state.phase, 'dungeon');
    assert.equal(DUNGEON_MS, 10 * MIN);
    assert.equal(pomodoro.remaining(t0 + 26 * MIN), 10 * MIN);
    assert.equal(pomodoro.remaining(t0 + 38 * MIN), -2 * MIN, 'overtime is negative, not a defeat');
    assert.equal(pomodoro.tick(t0 + 60 * MIN), false, 'nothing ends the dungeon phase by itself');
    assert.equal(pomodoro.state.phase, 'dungeon');
    assert.equal(pomodoro.enterDungeon(t0 + 61 * MIN), true, 'resuming a run is allowed');

    assert.equal(pomodoro.finishDungeon(t0 + 62 * MIN), true);
    assert.deepEqual({ ...pomodoro.state }, { phase: 'focus', session: 2, phaseStartedAt: t0 + 62 * MIN, completedSessions: 1 });
    assert.equal(pomodoro.finishDungeon(t0 + 63 * MIN), false, 'double finish does not skip a session');
    assert.equal(pomodoro.state.session, 2);
});

test('pomodoro: survives a page refresh (wall-clock anchored)', async () =>
{
    const storage = new MemoryStorage();
    const first = await load(storage);
    // Anchor in the past: a saved start time in the future is clamped to "now" on load (clock changes).
    const t0 = Date.now() - 3 * 60 * MIN;
    first.pomodoro.restartFocus(t0);
    first.pomodoro.tick(t0 + 25 * MIN);
    first.pomodoro.enterDungeon(t0 + 30 * MIN);

    const second = await load(storage);
    assert.equal(second.pomodoro.state.phase, 'dungeon');
    assert.equal(second.pomodoro.state.phaseStartedAt, t0 + 30 * MIN);
    assert.equal(second.pomodoro.remaining(t0 + 33 * MIN), 7 * MIN);

    second.pomodoro.finishDungeon(t0 + 35 * MIN);
    const third = await load(storage);
    assert.equal(third.pomodoro.state.session, 2);
    assert.equal(third.pomodoro.remaining(t0 + 45 * MIN), 15 * MIN, 'focus keeps counting while the page is closed');
});

test('pomodoro: dev focus override + skip', async () =>
{
    const storage = new MemoryStorage();
    storage.setItem('eduroam.dev', JSON.stringify({ focusSeconds: 30 }));
    const { pomodoro, focusMs } = await load(storage);
    const t0 = pomodoro.state.phaseStartedAt;
    assert.equal(focusMs(), 30_000);
    assert.equal(pomodoro.remaining(t0), 30_000);
    assert.equal(pomodoro.tick(t0 + 30_000), true);
    pomodoro.restartFocus(t0 + 40_000);
    assert.equal(pomodoro.state.phase, 'focus');
    pomodoro.skipFocus(t0 + 41_000);
    assert.equal(pomodoro.state.phase, 'ready');
});

test('pomodoro: configurable development break and ready cannot count as a completed run', async () =>
{
    const storage = new MemoryStorage();
    storage.setItem('eduroam.dev', JSON.stringify({ dungeonSeconds: 15 }));
    const { pomodoro, dungeonMs } = await load(storage);
    const t0 = pomodoro.state.phaseStartedAt;
    assert.equal(dungeonMs(), 15_000);
    pomodoro.skipFocus(t0);
    assert.equal(pomodoro.finishDungeon(t0), false);
    assert.equal(pomodoro.state.completedSessions, 0);
    pomodoro.enterDungeon(t0);
    assert.equal(pomodoro.remaining(t0 + 10_000), 5000);
    assert.equal(pomodoro.remaining(t0 + 20_000), -5000);
});

test('pomodoro: boot reconciliation with the dungeon run', async () =>
{
    const { pomodoro } = await load();
    const t0 = pomodoro.state.phaseStartedAt;
    // Save from before the timer existed: a run is in progress -> dungeon phase.
    pomodoro.syncWithRun(true, t0 + 1000);
    assert.equal(pomodoro.state.phase, 'dungeon');
    pomodoro.syncWithRun(true, t0 + 2000);
    assert.equal(pomodoro.state.phaseStartedAt, t0 + 1000, 'idempotent');
    // The run ended but the page closed before the session was finished.
    pomodoro.syncWithRun(false, t0 + 3000);
    assert.equal(pomodoro.state.phase, 'focus');
    assert.equal(pomodoro.state.session, 2);
    pomodoro.syncWithRun(false, t0 + 4000);
    assert.equal(pomodoro.state.session, 2, 'no extra sessions');
});

test('pomodoro: unreadable save is backed up; formatClock', async (t) =>
{
    t.mock.method(console, 'warn', () => {});
    const storage = new MemoryStorage();
    storage.setItem('eduroam.pomodoro', '{oops');
    const { pomodoro, formatClock } = await load(storage);
    assert.equal(pomodoro.state.phase, 'focus');
    assert.equal(storage.getItem('eduroam.pomodoro.backup'), '{oops');
    assert.equal(formatClock(25 * MIN), '25:00');
    assert.equal(formatClock(61_000), '01:01');
    assert.equal(formatClock(-90_000), '01:30');
    assert.equal(formatClock(500), '00:01');
});

test('death screen freezes the dungeon clock; release resumes without counting the frozen time; survives reload', async () =>
{
    const storage = new MemoryStorage();
    const { pomodoro } = await load(storage);
    const t0 = pomodoro.state.phaseStartedAt;
    pomodoro.skipFocus(t0);
    assert.equal(pomodoro.enterDungeon(t0), true);
    const start = pomodoro.state.phaseStartedAt;
    // Times stay <= Date.now(): saved times in the future are clamped on load (clock changes).
    const before = pomodoro.remaining(start);
    pomodoro.hold(start);
    pomodoro.hold(start + 2 * MIN); // idempotent: the first hold time counts
    assert.equal(pomodoro.remaining(start + 5 * MIN), before, 'frozen while dead');
    const reloaded = (await load(storage)).pomodoro;
    assert.equal(reloaded.remaining(start + 7 * MIN), before, 'still frozen after a refresh');
    reloaded.release(start + 7 * MIN);
    assert.equal(reloaded.remaining(start + 8 * MIN), before - MIN, 'counts again after release, frozen time excluded');
});
