import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner } from 'vite';
import { makeScene, Sprite } from './support/phaser.mts';

let server: Awaited<ReturnType<typeof createServer>>;
let runner: ReturnType<typeof createServerModuleRunner>;
let Enemy: typeof import('../src/game/combat/Enemy.ts').Enemy;
let Hades: typeof import('../src/game/combat/Hades.ts').Hades;
let CombatController: typeof import('../src/game/combat/CombatController.ts').CombatController;
let kinds: typeof import('../src/game/combat/enemyTypes.ts').ENEMY_TYPES;
before(async () =>
{
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem () {} }, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
    Object.defineProperty(globalThis, 'document', { value: new EventTarget(), configurable: true });
    server = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
        resolve: { alias: { phaser: fileURLToPath(new URL('./support/phaser.mts', import.meta.url)) } },
        logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
    });
    runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    ({ Enemy } = await runner.import('/src/game/combat/Enemy.ts'));
    ({ Hades } = await runner.import('/src/game/combat/Hades.ts'));
    ({ CombatController } = await runner.import('/src/game/combat/CombatController.ts'));
    ({ ENEMY_TYPES: kinds } = await runner.import('/src/game/combat/enemyTypes.ts'));
});
after(async () => { await runner?.close(); await server?.close(); });

let scene: ReturnType<typeof makeScene>;
let target: { x: number; y: number };
let projectiles: unknown[][];
let summons: unknown[][];
let circles: unknown[][];
let sectors: unknown[][];
let summonCount: number;
let ctx: import('../src/game/combat/Enemy.ts').EnemyContext;
beforeEach(() =>
{
    scene = makeScene(); target = { x: 100, y: 100 };
    projectiles = []; summons = []; circles = []; sectors = []; summonCount = 0;
    ctx = {
        playerFeet: () => target, playerCenter: () => target,
        fireProjectile: (...args) => projectiles.push(args),
        summon: (...args) => { summons.push(args); summonCount++; return null; },
        activeSummons: () => summonCount,
        hurtInCircle: (...args) => circles.push(args), hurtInSector: (...args) => sectors.push(args),
        warnCircle () {}, warnSector () {}, freeSpotNear: (x, y) => ({ x, y }),
    };
});

function enemy (id: keyof typeof kinds)
{
    const k = kinds[id];
    const C = id === 'hades' ? Hades : Enemy;
    return new C(scene, 0, 0, k, { maxHp: k.hp, damage: k.damage, contactDamage: k.contactDamage }, id, ctx,
        { onDamaged () {}, onDefeated () {} });
}
function tick (e: InstanceType<typeof Enemy>, time: number) { scene.advance(time); e.tick(time); }

test('zombie and goblin chase at roster speeds, with health/damage and contact cooldown', () =>
{
    const zombie = enemy('zombie'), goblin = enemy('goblin');
    tick(zombie, 2000); tick(goblin, 2000);
    assert.ok(Math.abs(Math.hypot(zombie.body!.velocity.x, zombie.body!.velocity.y) - 34) < 0.01);
    assert.ok(Math.abs(Math.hypot(goblin.body!.velocity.x, goblin.body!.velocity.y) - 64) < 0.01);
    assert.ok(goblin.hp < zombie.hp);
    assert.equal(zombie.stats.damage, 5);
    assert.equal(zombie.tryContact(2000), true);
    assert.equal(zombie.tryContact(2100), false);
    assert.equal(zombie.tryContact(2900), true);
});

test('wizard winds up before firing a low-damage spell and respects cooldown', () =>
{
    target = { x: 100, y: -12 };
    const wizard = enemy('wizard');
    tick(wizard, 2000);
    assert.equal(projectiles.length, 0);
    tick(wizard, 2650);
    assert.equal(projectiles.length, 1);
    assert.equal(projectiles[0][3], 4);
    assert.equal(projectiles[0][4], 'spell-orb');
    tick(wizard, 3000); tick(wizard, 3100);
    assert.equal(projectiles.length, 1);
});

test('giant warns before slam, has high HP and slow chase, then recovers', () =>
{
    const giant = enemy('giant');
    assert.equal(giant.hp, 90);
    tick(giant, 2000);
    assert.ok(Math.hypot(giant.body!.velocity.x, giant.body!.velocity.y) <= 15.01);
    target = { x: 10, y: 0 };
    tick(giant, 2100);
    assert.equal(circles.length, 0);
    tick(giant, 2950);
    assert.equal(circles.length, 1);
    assert.equal(circles[0][3], 8);
    assert.equal(giant.busy, true);
});

test('soul reaper summons capped skeletons after a visible cast; death cancels pending casts', () =>
{
    const reaper = enemy('reaper');
    tick(reaper, 2000);
    assert.equal(summons.length, 0);
    tick(reaper, 2800);
    assert.equal(summons.length, 2);
    assert.equal(summons[0][1], 'skeleton');
    summonCount = 3;
    tick(reaper, 3300); tick(reaper, 9000);
    assert.equal(summons.length, 2, 'cap prevents another cast');
    const other = enemy('reaper');
    summonCount = 0;
    tick(other, 12000);
    other.takeDamage(999, 0);
    tick(other, 13000);
    assert.equal(summons.length, 2, 'dead reaper never completes its cast');
});

test('Hades introduction, summon, soul fire, sweep and one phase transition below half HP', () =>
{
    const boss = enemy('hades') as InstanceType<typeof Hades>;
    boss.activeAt = 3000;
    tick(boss, 2000);
    assert.equal(boss.busy, false);
    tick(boss, 3000); tick(boss, 3800);
    assert.equal(summons.length, 2);
    summonCount = 3;
    tick(boss, 4300); tick(boss, 5400); tick(boss, 6150);
    assert.equal(projectiles.length, 3);
    tick(boss, 6700);
    target = { x: 10, y: 0 };
    tick(boss, 8000);
    assert.equal(sectors.length, 0);
    tick(boss, 8950);
    assert.equal(sectors.length, 1);
    let phases = 0;
    scene.events.on('boss-phase', () => phases++);
    boss.takeDamage(150, 0);
    assert.equal(boss.phase, 1, 'phase 2 starts strictly below half HP');
    boss.takeDamage(1, 0);
    assert.equal(boss.phase, 2);
    assert.ok(boss.tuning.shotSpeed > 78);
    boss.takeDamage(1, 0);
    assert.equal(phases, 1);
});

test('combat spawns one-hit skeletons at every level and clears all run combat on shutdown', () =>
{
    const player = new Sprite(scene, 0, 0) as any;
    player.center = { x: 0, y: 0 };
    const combat = new CombatController({ scene, player, ground: {} as any, obstacles: {} as any,
        canAct: () => true, float () {}, onPlayerDied () {}, canStandAt: () => true,
        scaleContext: () => ({ towerLevel: 100, floorIndex: 3 }),
    });
    const reaper = combat.spawnEnemy('reaper', 100, 100);
    const skeleton = combat.context.summon(reaper, 'skeleton', 120, 100)!;
    assert.equal(skeleton.hp, 1);
    skeleton.takeDamage(1, 0);
    assert.equal(skeleton.alive, false);
    combat.context.fireProjectile({ x: 10, y: 10 }, 0, 50, 2, 'spell-orb');
    scene.groups[0].create(20, 20, 'arrow');
    combat.destroy();
    assert.equal(combat.liveEnemies.length, 0);
    assert.ok(scene.groups.every((g: any) => g.getChildren().length === 0), 'no old arrows, enemies or spells survive restart');
});

test('real combat arrows and melee damage Hades upper body, away from its feet physics box', () =>
{
    const player = new Sprite(scene, 100, 40) as any;
    player.center = { x: 100, y: 40 };
    player.faceAngle = () => {};
    player.facingAngle = Math.PI / 2; // facing down, toward the boss (attacks follow facing, not the cursor)
    scene.input.activePointer = { x: 100, y: 60, leftButtonDown: () => true, rightButtonDown: () => false };
    scene.cameras.main.getWorldPoint = (x: number, y: number) => ({ x, y });
    const combat = new CombatController({ scene, player, ground: {} as any, obstacles: {} as any,
        canAct: () => true, float () {}, onPlayerDied () {}, canStandAt: () => true,
        scaleContext: () => ({ towerLevel: 1, floorIndex: 1 }),
    });
    const boss = combat.spawnEnemy('hades', 100, 100);
    boss.frozen = true;
    const arrow = scene.groups[0].create(100, 60, 'arrow');
    arrow.setData('start', { x: 100, y: 40 }).setData('damage', 3);
    scene.input.emit('pointerdown', { button: 0 });
    scene.advance(2000);
    combat.update(2000);
    assert.equal(boss.hp, 300 - 3 - 12, '3 arrow + 12 sword (no stat points) damage reach the upper hurtbox');
    assert.equal(arrow.active, false);
    combat.destroy();
});

// Regression: Haunted Crypt Hades crash ("Cannot read properties of undefined (reading 'x')" in
// CombatController.update). A lethal soul-fire hit ran die(), which destroyed every shot while the
// update loop was still iterating its copy; the next destroyed shot had no 'start' data.
function deathHarness ()
{
    const player = new Sprite(scene, 100, 100) as any;
    player.center = { x: 100, y: 100 };
    player.body = { bottom: 112 };
    player.halt = () => {};
    player.setPosition = (x: number, y: number) => { player.x = x; player.y = y; return player; };
    let deaths = 0;
    const defeated: string[] = [];
    const combat = new CombatController({ scene, player, ground: {} as any, obstacles: {} as any,
        canAct: () => true, float () {}, onPlayerDied: () => { deaths++; }, canStandAt: () => true,
        scaleContext: () => ({ towerLevel: 5, floorIndex: 3 }), onEnemyDefeated: (e: any) => defeated.push(e.kind.id ?? 'enemy'),
    } as any);
    return { combat, player, deaths: () => deaths, defeated };
}

test('lethal soul-fire with more shots in flight: no crash, death resolved exactly once', () =>
{
    const { combat, deaths } = deathHarness();
    combat.spawnEnemy('hades', 160, 100).frozen = true;
    for (let i = 0; i < 4; i++) combat.context.fireProjectile({ x: 100, y: 100 }, 0, 10, 999, 'soul-fire');
    scene.advance(1000);
    assert.doesNotThrow(() => combat.update(1000));
    assert.doesNotThrow(() => combat.update(1016), 'next frame is safe too');
    scene.advance(2000);
    assert.equal(deaths(), 1, 'death overlay requested once');
    assert.ok(scene.groups.slice(0, 2).every((g: any) => g.getChildren().length === 0), 'all arrows and shots cleared');
    combat.destroy();
});

test('boss defeat clears its soul-fire; if the player died first, no boss victory is recorded', () =>
{
    const { combat, defeated } = deathHarness();
    const boss = combat.spawnEnemy('hades', 160, 100);
    boss.frozen = true;
    combat.context.fireProjectile({ x: 300, y: 300 }, 0, 10, 2, 'soul-fire');
    boss.takeDamage(99999, 0);
    scene.advance(5000);
    assert.equal(scene.groups[1].getChildren().length, 0, 'boss shots removed with him');
    assert.equal(defeated.length, 1);

    const second = deathHarness();
    const boss2 = second.combat.spawnEnemy('hades', 160, 100);
    boss2.frozen = true;
    boss2.takeDamage(99999, 0);                          // defeat animation running...
    second.combat.damagePlayer(9999, { x: 0, y: 0 });     // ...player dies in the same moment
    scene.advance(10_000);
    assert.equal(second.defeated.length, 0, 'player death wins: guardian not recorded as beaten');
    assert.equal(second.deaths(), 1);
    combat.destroy(); second.combat.destroy();
});

// ---------------------------------------------------------------- weapons: facing aim, arrows, mana, splash

/** A combat controller with a test player that faces `angle`, plus attack keys the test can hold. */
function armed (angle: number, opts: { canAct?: () => boolean } = {})
{
    const keys = { J: { isDown: false }, K: { isDown: false }, L: { isDown: false }, Q: { isDown: false } };
    scene.input.keyboard = { addKeys: () => keys };
    // The cursor sits far to the LEFT: nothing may aim at it.
    scene.input.activePointer = { x: -500, y: 0, leftButtonDown: () => false, rightButtonDown: () => false };
    scene.cameras.main.getWorldPoint = (x: number, y: number) => ({ x, y });
    const player = new Sprite(scene, 100, 40) as any;
    player.center = { x: 100, y: 40 };
    player.facingAngle = angle;
    player.faceAngle = () => { throw new Error('attacks must not turn the player toward the cursor'); };
    const shown: { arrows: number; mana: number }[] = [];
    const combat = new CombatController({ scene, player, ground: {} as any, obstacles: {} as any,
        canAct: opts.canAct ?? (() => true), float () {}, onPlayerDied () {}, canStandAt: () => true,
        scaleContext: () => ({ towerLevel: 1, floorIndex: 1 }),
        onResources: (r) => shown.push({ arrows: r.arrows, mana: r.mana }),
    });
    combat.refill('arrows');
    combat.refill('mana');
    let clock = 0;
    /** Holds a key for one attack, advancing time so the cooldown has passed. */
    const press = (key: keyof typeof keys) => { clock += 1000; keys[key].isDown = true; scene.advance(clock); combat.update(clock, 0); keys[key].isDown = false; };
    const wait = (ms: number) => { const steps = Math.ceil(ms / 50); for (let i = 0; i < steps; i++) { clock += 50; scene.advance(clock); combat.update(clock, 50); } };
    const projectiles = () => scene.groups[0].getChildren() as any[];
    return { combat, player, keys, press, wait, projectiles, shown };
}

test('all three weapons follow the facing direction (never the cursor), from the player body', () =>
{
    for (const [angle, dx, dy] of [[Math.PI / 2, 0, 1], [-Math.PI / 2, 0, -1], [0, 1, 0], [Math.PI, -1, 0]] as const)
    {
        scene = makeScene();
        const { combat, press, projectiles } = armed(angle);
        press('K');
        const arrow = projectiles().at(-1);
        assert.equal(arrow.texture ?? 'arrow', 'arrow');
        assert.ok(Math.sign(Math.round(arrow.body.velocity.x)) === dx && Math.sign(Math.round(arrow.body.velocity.y)) === dy, `arrow flies the facing way ${angle}`);
        assert.ok(Math.abs(arrow.x - (100 + dx * 10)) < 1e-6 && Math.abs(arrow.y - (40 + dy * 10)) < 1e-6, 'arrow starts at the player body');
        press('L');
        const bolt = projectiles().at(-1);
        assert.ok(bolt.getData('splash'), 'staff bolt');
        assert.ok(Math.sign(Math.round(bolt.body.velocity.x)) === dx && Math.sign(Math.round(bolt.body.velocity.y)) === dy, `bolt flies the facing way ${angle}`);
        combat.destroy();
    }

    // Sword: hits the enemy in front (facing down), never the one behind.
    scene = makeScene();
    const { combat, press } = armed(Math.PI / 2);
    const front = combat.spawnEnemy('zombie', 100, 70);
    const behind = combat.spawnEnemy('zombie', 100, 20);
    front.frozen = true; behind.frozen = true;
    press('J');
    assert.equal(front.hp, 32 - 12, 'sword hits in front');
    assert.equal(behind.hp, 32, 'nothing behind the player is hit');
    combat.destroy();
});

test('arrows: 8 max, 1 per shot, none at 0, regenerate 1 per 3.5 s with delta time; paused = no regen; mana separate', () =>
{
    let acting = true;
    const { combat, press, wait, projectiles, shown } = armed(0, { canAct: () => acting });
    for (let i = 0; i < 8; i++) press('K');
    assert.equal(projectiles().length, 8);
    assert.equal(combat.resources.arrows, 0);
    assert.equal(combat.resources.mana, 30, 'shooting never touches mana');
    press('K');
    assert.equal(projectiles().length, 8, 'cannot shoot with 0 arrows');
    assert.ok(shown.some((r) => Math.floor(r.arrows) === 0), 'HUD told about the drain');

    acting = false; // menu open / paused / leaving
    wait(10_000);
    assert.equal(combat.resources.arrows, 0, 'no regeneration while paused');
    acting = true;
    wait(3500);
    assert.ok(Math.abs(combat.resources.arrows - 1) < 0.02, `one arrow back after 3.5 s (${combat.resources.arrows})`);
    wait(60_000);
    assert.equal(combat.resources.arrows, 8, 'never above the maximum');
    combat.destroy();
});

test('mana: 6 per cast, no cast without enough, 2 per second regen; switching weapons never refills', () =>
{
    const { combat, press, wait, projectiles } = armed(0);
    for (let i = 0; i < 5; i++) press('L');
    assert.equal(combat.resources.mana, 0);
    press('L');
    assert.equal(projectiles().length, 5, 'no cast without 6 mana');
    press('K'); press('J'); // switch weapons
    assert.equal(combat.resources.mana, 0, 'switching does not refill mana');
    assert.equal(combat.resources.arrows, 7, 'arrows are their own pool');
    wait(3000);
    assert.ok(Math.abs(combat.resources.mana - 6) < 0.05, `2 mana per second (${combat.resources.mana})`);
    press('L');
    assert.equal(projectiles().length, 6);
    combat.destroy();
});

test('staff splash: full damage to the target, 55 % to nearby enemies, each hit once; bow stronger single-target', () =>
{
    const { combat, press, projectiles } = armed(Math.PI / 2);
    const primary = combat.spawnEnemy('giant', 100, 110);
    const near = combat.spawnEnemy('zombie', 112, 112);
    const far = combat.spawnEnemy('zombie', 200, 110);
    for (const e of [primary, near, far]) e.frozen = true;
    press('L');
    const bolt = projectiles().at(-1);
    bolt.x = 100; bolt.y = 95; // inside the giant's hurtbox
    combat.update(99_999, 0);
    assert.equal(primary.hp, 90 - 9, 'primary: full direct damage, once');
    assert.equal(near.hp, 32 - Math.round(9 * 0.55), 'nearby: splash share, once');
    assert.equal(far.hp, 32, 'outside the radius: untouched');
    assert.equal(bolt.active, false);

    press('K');
    const arrow = projectiles().at(-1);
    arrow.x = 200; arrow.y = 95;
    combat.update(199_999, 0);
    assert.equal(far.hp, 32 - 14, 'an arrow hits harder than the staff on one target');
    assert.equal(near.hp, 32 - 5, 'arrows do not splash');
    combat.destroy();
});
