// Progression inside the real save: XP rewards paid once per stable id (kills, victories,
// mini-game sessions), dev runs paying nothing, the kill budget, level-ups with carry-over,
// exactly three stat points per level, Health / weapon effects, persistence and save migration.
//
// Run: npm test. Every boot() is a fresh page load on the same storage.

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite';
import { ENEMY_XP, scaledXp, XP, xpForLevel, xpMultiplier } from '../src/game/progression/balance.ts';

type PlayerModule = typeof import('../src/game/state/playerState.ts');
type RunModule = typeof import('../src/game/state/dungeonRun.ts');
type OptionsModule = typeof import('../src/game/world/dungeon/runOptions.ts');

// Canonical path: a drive-letter case mismatch would load one module twice (two player states).
const ROOT = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
const PLAYER_KEY = 'eduroam.player';

class MemoryStorage
{
    data = new Map<string, string>();
    fail = false;
    get length () { return this.data.size; }
    key (i: number) { return [...this.data.keys()][i] ?? null; }
    getItem (key: string) { return this.data.get(key) ?? null; }
    setItem (key: string, value: string) { if (this.fail) throw new Error('QuotaExceededError (simulated)'); this.data.set(key, String(value)); }
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
after(async () => { await Promise.all(runners.map((r) => r.close())); await server.close(); });
afterEach(async () => { await Promise.all(runners.splice(0).map((r) => r.close())); });

async function boot (storage: MemoryStorage)
{
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
    const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    runners.push(runner);
    const state: PlayerModule = await runner.import('/src/game/state/playerState.ts');
    const run: RunModule = await runner.import('/src/game/state/dungeonRun.ts');
    const options: OptionsModule = await runner.import('/src/game/world/dungeon/runOptions.ts');
    return { player: state.player, dungeonRun: run.dungeonRun, beginTowerRun: options.beginTowerRun, reconcile: options.reconcileTowerProgress };
}
const award = (r: { status: string; xp?: number }) => (r.status === 'awarded' ? r.xp : r.status);
/** Lifetime XP (level-ups move XP out of `xp`). */
const lifetime = (p: { level: number; xp: number }) => xpForLevel(p.level) + p.xp;

test('enemy XP: once per kill id, threat-based, skeletons and dev kills pay nothing, kept after death', async () =>
{
    const storage = new MemoryStorage();
    let { player, dungeonRun, beginTowerRun } = await boot(storage);
    assert.ok(beginTowerRun());
    const run = dungeonRun.state;
    assert.equal(run.paysXp, true, 'a normal new run pays XP');

    assert.equal(award(player.awardKill(run.runId, `${run.runId}/f1/r1/w0/0`, 'zombie', 1)), 20);
    assert.equal(award(player.awardKill(run.runId, `${run.runId}/f1/r1/w0/0`, 'zombie', 1)), 'claimed', 'same enemy never pays twice');
    assert.equal(award(player.awardKill(run.runId, `${run.runId}/f1/r1/w0/1`, 'giant', 1)), 50);
    assert.equal(award(player.awardKill(run.runId, `${run.runId}/f1/r1/w0/2`, 'skeleton', 1)), 'none', 'summons give 0 XP');
    assert.equal(award(player.awardKill(run.runId, `${run.runId}/f3/boss`, 'hades', 1)), 100);
    assert.equal(player.progress.xp, 170);

    // Death retry respawns the same enemies with the same ids: nothing new; XP already earned stays.
    dungeonRun.damage(999);
    assert.ok(dungeonRun.retryAfterDeath());
    ({ player, dungeonRun } = await boot(storage));
    assert.equal(player.progress.xp, 170, 'kill XP persisted through death + reload');
    assert.equal(award(player.awardKill(run.runId, `${run.runId}/f1/r1/w0/1`, 'giant', 1)), 'claimed');
});

test('kill budget per run: full XP until 300 base, then 5 %; a new run starts a fresh budget and drops old kill ids', async () =>
{
    const storage = new MemoryStorage();
    const { player } = await boot(storage);
    for (let i = 0; i < 15; i++) assert.equal(player.awardKill('run_a', `run_a/k${i}`, 'goblin', 1).status, 'awarded');
    // 15 goblins x 25 = 375 base: 300 at full XP + 75 at 5 % (rounded per kill) = 300 + 3 x 1.
    assert.equal(player.progress.xp, 303);
    assert.equal(award(player.awardKill('run_b', 'run_b/k0', 'goblin', 1)), 25, 'next run: full XP again');
    assert.ok(!player.isRewardClaimed('kill:run_a/k0'), 'old run kill ids are dropped (bounded history)');
    assert.ok(XP.killBudgetPerRun === 300 && XP.afterBudget === 0.05);
});

test('dungeon victory: 500 XP once per run, never for dev runs; tower bonus small; a closed tab is repaired once', async () =>
{
    const storage = new MemoryStorage();
    let game = await boot(storage);
    assert.ok(game.beginTowerRun());
    const runId = game.dungeonRun.state.runId;
    assert.equal(award(game.player.awardDungeonCompletion(runId, 1)), 500);
    assert.equal(award(game.player.awardDungeonCompletion(runId, 1)), 'claimed');
    assert.equal(scaledXp(500, 1, 11), Math.round(500 * 1.05), 'tower 11: +5 % (cap)');

    // A dev-started run (Next Tower / dev overrides) pays nothing, and markDev() taints a normal run.
    assert.ok(game.beginTowerRun({ seed: 5 }));
    assert.equal(game.dungeonRun.state.paysXp, false);
    assert.ok(game.beginTowerRun({ seed: 6 }));
    game.dungeonRun.abandon();
    assert.ok(game.beginTowerRun());
    assert.equal(game.dungeonRun.state.paysXp, true);
    game.dungeonRun.markDev();
    assert.equal(game.dungeonRun.state.paysXp, false, 'teleports / kill-all / spawns stop XP for the run');

    // Normal run completed, tab closed before the bonus was paid: boot repairs it exactly once.
    game.dungeonRun.abandon();
    assert.ok(game.beginTowerRun({ floorCount: 2 }) && game.dungeonRun.replace('tower', { seed: 9, biomeId: 'crypt', floorCount: 1, towerLevel: 1 }));
    // Rebuild a normal (paying) single-floor run by hand.
    const saved = JSON.parse(storage.getItem('eduroam.dungeon')!);
    saved.paysXp = true; saved.guardianDefeated = true; saved.finalChestOpened = true;
    storage.setItem('eduroam.dungeon', JSON.stringify(saved));
    game = await boot(storage);
    assert.ok(game.dungeonRun.complete());
    const xpBefore = lifetime(game.player.progress);
    game = await boot(storage);
    game.reconcile();
    assert.equal(lifetime(game.player.progress), xpBefore + 500, 'missing victory bonus paid on boot');
    game.reconcile();
    game = await boot(storage);
    game.reconcile();
    assert.equal(lifetime(game.player.progress), xpBefore + 500, 'never twice');
});

test('a completed run from before XP existed is never paid retroactively', async () =>
{
    const storage = new MemoryStorage();
    let game = await boot(storage);
    assert.ok(game.beginTowerRun());
    const saved = JSON.parse(storage.getItem('eduroam.dungeon')!);
    delete saved.paysXp; // pre-update save
    Object.assign(saved, { active: false, completed: true });
    storage.setItem('eduroam.dungeon', JSON.stringify(saved));
    game = await boot(storage);
    game.reconcile();
    assert.equal(game.player.progress.xp, 0);
});

test('mini-games: XP by accuracy x level multiplier, crystals 1-5 only, once per session, real participation', async () =>
{
    const storage = new MemoryStorage();
    let { player } = await boot(storage);
    const crystals0 = player.crystals;
    let r = player.awardMinigame('sess-1', 0.9, 10);
    assert.ok(r.status === 'awarded' && r.xp === 75 && r.crystals === 5);
    assert.equal(player.crystals, crystals0 + 5);
    assert.equal(player.awardMinigame('sess-1', 0.9, 10).status, 'claimed', 'no duplicate claim (replayed results / reload)');
    assert.equal(player.awardMinigame('sess-2', 1, 4).status, 'tooShort', 'abandoned / tiny sessions earn nothing');
    r = player.awardMinigame('sess-3', 0.1, 6);
    assert.ok(r.status === 'awarded' && r.xp === 20 && r.crystals === 1);

    // Same accuracy at level 10: more XP, the same crystals.
    assert.ok(player.devSetLevel(10));
    r = player.awardMinigame('sess-4', 0.65, 8);
    assert.ok(r.status === 'awarded' && r.xp === Math.round(60 * xpMultiplier(10)) && r.crystals === 4);
    ({ player } = await boot(storage));
    assert.equal(player.awardMinigame('sess-4', 0.65, 8).status, 'claimed', 'claims survive reload');
});

test('levels: carry-over, multiple level-ups from one reward, exactly 3 points per level, no duplicates on reload', async () =>
{
    const storage = new MemoryStorage();
    let { player } = await boot(storage);
    const r = player.devAddXp(3350); // 1000 + 1100 + 1200 = 3300 -> level 4 with 50 XP
    assert.ok(r.status === 'awarded' && r.levelsGained === 3 && r.level === 4);
    assert.deepEqual([player.progress.level, player.progress.xp, player.progress.xpToNext, player.progress.unspent], [4, 50, 1300, 9]);
    ({ player } = await boot(storage));
    assert.equal(player.progress.unspent, 9, 'reload does not duplicate points');
    for (let i = 0; i < 9; i++) assert.equal(player.spendPoint(i % 2 ? 'bow' : 'sword'), 'ok');
    assert.equal(player.spendPoint('staff'), 'none', 'cannot overspend');
    ({ player } = await boot(storage));
    assert.deepEqual(player.progress.alloc, { health: 0, sword: 5, bow: 4, staff: 0 });
    assert.equal(player.progress.unspent, 0);
});

test('stats: Health raises max HP without healing; refunds clamp HP; each weapon point changes only its weapon', async () =>
{
    const storage = new MemoryStorage();
    let { player, dungeonRun, beginTowerRun } = await boot(storage);
    assert.ok(player.devSetLevel(3)); // 6 points
    assert.ok(beginTowerRun());
    assert.equal(dungeonRun.maxHp, 50);
    dungeonRun.damage(10);
    assert.equal(player.spendPoint('health'), 'ok');
    assert.equal(player.spendPoint('health'), 'ok');
    assert.equal(dungeonRun.maxHp, 60);
    assert.equal(dungeonRun.state.hp, 40, 'spending Health does not heal');
    assert.equal(dungeonRun.heal(100), 20);
    assert.equal(dungeonRun.state.hp, 60);

    const before = player.stats();
    assert.equal(player.spendPoint('staff'), 'ok');
    const after = player.stats();
    assert.ok(after.staffDamage > before.staffDamage && after.swordDamage === before.swordDamage && after.bowDamage === before.bowDamage, 'one point is always visible');

    assert.ok(player.devResetStats());
    assert.equal(player.progress.unspent, 6, 'reset refunds every point');
    assert.equal(dungeonRun.maxHp, 50);
    assert.equal(dungeonRun.state.hp, 50, 'HP clamped to the lower maximum');
    ({ player, dungeonRun } = await boot(storage));
    assert.equal(dungeonRun.state.hp, 50);
});

test('save migration: removed Defense / Speed points become unspent; impossible allocations refunded; XP carried', async () =>
{
    const storage = new MemoryStorage();
    await boot(storage);
    const doc = JSON.parse(storage.getItem(PLAYER_KEY)!);
    doc.progression = { level: 3, xp: 50, alloc: { health: 1, sword: 1, defense: 2, speed: 2 }, claims: ['minigame:old'] };
    storage.setItem(PLAYER_KEY, JSON.stringify(doc));
    let { player } = await boot(storage);
    assert.deepEqual(player.progress.alloc, { health: 1, sword: 1, bow: 0, staff: 0 });
    assert.equal(player.progress.unspent, 4, '6 earned - 2 kept = 4 (the Defense + Speed points)');
    assert.ok(player.isRewardClaimed('minigame:old'));
    assert.match(storage.getItem(`${PLAYER_KEY}.weapons-backup`) ?? '', /defense/);

    doc.progression = { level: 2, xp: 2500, alloc: { health: 9, sword: 9, bow: 0, staff: 0 } };
    storage.setItem(PLAYER_KEY, JSON.stringify(doc));
    ({ player } = await boot(storage));
    // 2500 XP at level 2 carries: 1100 -> level 3, 1200 -> level 4, 200 left.
    assert.deepEqual([player.progress.level, player.progress.xp], [4, 200]);
    assert.deepEqual(player.progress.alloc, { health: 0, sword: 0, bow: 0, staff: 0 }, '18 allocated > 9 earned: refunded, not deleted');
    assert.equal(player.progress.unspent, 9);
});

test('a failed save pays nothing and claims nothing', async () =>
{
    const storage = new MemoryStorage();
    const { player } = await boot(storage);
    storage.fail = true;
    assert.equal(player.awardMinigame('s', 1, 10).status, 'saveFailed');
    assert.equal(player.awardKill('r', 'r/k', 'zombie', 1).status, 'saveFailed');
    storage.fail = false;
    assert.equal(player.progress.xp, 0);
    assert.equal(award(player.awardMinigame('s', 1, 10)), 75, 'retry after the failure still pays');
    assert.equal(ENEMY_XP.zombie, 20);
});
