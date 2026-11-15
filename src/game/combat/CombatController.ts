// Player combat + enemies for combat-enabled maps (dungeons only; the village never creates one).
// Three permanent weapons, ALL aimed the same way: the player's facing direction (last movement
// direction: up / down / left / right). The mouse cursor never aims anything.
//   J or left click   = Sword: melee swing in front of the player (hold to keep swinging)
//   K or right click  = Bow: arrow straight ahead, uses 1 arrow (8 max, regenerates)
//   L or Q            = Staff: magic bolt straight ahead, uses 6 mana (30 max, regenerates),
//                       bursts on impact and splashes nearby enemies
//   F                 = drink the equipped healing item
// Damage comes from stat points (player.stats()), all other numbers from progression/balance.ts.
// Arrows and mana belong to the current run (full at the start of each run, kept across floors
// and weapon switches) and regenerate with delta time only while the player can act. Enemies are spawned here with stats from combat/scaling.ts.
// All hits test HURTBOXES (see hitboxes.ts), never the small movement bodies.

import { GameObjects, Input, Physics, Scene, Tilemaps } from 'phaser';
import { itemDef } from '../items/itemDefs';
import { ARROWS, MANA, SPLASH, WEAPON } from '../progression/balance';
import type { Player } from '../objects/Player';
import { dungeonRun } from '../state/dungeonRun';
import { player as playerState } from '../state/playerState';
import { Enemy, type EnemyContext } from './Enemy';
import { ENEMY_TYPES, type EnemyTypeId } from './enemyTypes';
import { Hades } from './Hades';
import { circleHitsRect, HitboxDebug, rectContains, sectorHitsRect, type DebugShapes, type Rect } from './hitboxes';
import { damageAfterArmor, scaleStats, type ScaleContext } from './scaling';

type Attack = 'melee' | 'ranged' | 'staff';

/** Arrow + mana pools of one run (module-level so floor changes and death retries keep them). */
const pools = { runId: '', arrows: ARROWS.max as number, mana: MANA.max as number };
const SHOT_RANGE = 340;              // enemy projectiles fade after this
const INVULNERABLE_MS = 700;         // after taking a hit

export type FloatKind = 'damage' | 'hurt' | 'heal' | 'info';

export interface CombatHost
{
    scene: Scene;
    player: Player;
    ground: Tilemaps.TilemapLayer;
    obstacles: Physics.Arcade.StaticGroup;
    /** False while menus, dialogue, placement or scene changes are active. */
    canAct (): boolean;
    /** Floating text at a world position. */
    float (text: string, x: number, y: number, kind: FloatKind): void;
    onPlayerDied (): void;
    /** Tower level + floor for enemy scaling. */
    scaleContext (): ScaleContext;
    /** Is (x, y) free floor for a character's feet? (summon placement) */
    canStandAt (x: number, y: number): boolean;
    /** An enemy finished dying (room clearing listens to this). */
    onEnemyDefeated? (enemy: Enemy): void;
    /** Arrow / mana pools changed (HUD bars). */
    onResources? (r: { arrows: number; maxArrows: number; mana: number; maxMana: number }): void;
}

type Warning = { kind: 'circle' | 'sector'; x: number; y: number; r: number; angle: number; arc: number; until: number };

export class CombatController
{
    /** Mouse buttons currently held, in press order (last = active attack). */
    private held: Attack[] = [];
    private nextAttackAt: Record<Attack, number> = { melee: 0, ranged: 0, staff: 0 };
    private keys: Record<Attack, { isDown: boolean }[]> = { melee: [], ranged: [], staff: [] };
    private shownResources = '';
    private nextHintAt = 0;
    private swingSide = 1;
    private invulnerableUntil = 0;
    private arrows: Physics.Arcade.Group;
    private shots: Physics.Arcade.Group;
    private enemyGroup: Physics.Arcade.Group;
    private enemies: Enemy[] = [];
    private debug: HitboxDebug;
    private serial = 0;
    /** Last melee swing, kept briefly for the hitbox overlay. */
    private lastSwing: { x: number; y: number; angle: number; reach: number; until: number } | null = null;
    /** Active telegraphs (also drawn by the hitbox overlay). */
    private warnings: Warning[] = [];
    readonly context: EnemyContext;
    dead = false;

    constructor (private host: CombatHost)
    {
        const { scene, ground, obstacles } = host;
        scene.input.mouse?.disableContextMenu(); // right click = shoot, only on the game canvas

        this.debug = new HitboxDebug(scene);
        this.arrows = scene.physics.add.group({ allowGravity: false });
        this.shots = scene.physics.add.group({ allowGravity: false });
        this.enemyGroup = scene.physics.add.group({ allowGravity: false });
        // A staff bolt that hits a wall or obstacle still bursts there (splash only, no direct hit).
        const drop = (a: unknown, b: unknown) =>
        {
            const projectile = this.projectileFrom(a, b);
            if (!projectile) return;
            if (projectile.getData('splash')) this.explode(projectile, null);
            projectile.destroy();
        };
        scene.physics.add.collider(this.arrows, ground, drop);
        scene.physics.add.collider(this.arrows, obstacles, drop);
        scene.physics.add.collider(this.shots, ground, drop);
        scene.physics.add.collider(this.shots, obstacles, drop);
        scene.physics.add.collider(this.enemyGroup, this.enemyGroup);

        scene.input.on('pointerdown', this.onPointerDown);
        scene.input.on('pointerup', this.onPointerUp);
        scene.input.on('pointerupoutside', this.onPointerUp);
        window.addEventListener('blur', this.releaseAll);
        document.addEventListener('visibilitychange', this.releaseAll);

        // Keyboard attacks (no mouse needed): J sword, K bow, L or Q staff.
        const keyboard = scene.input.keyboard;
        if (keyboard)
        {
            const k = keyboard.addKeys('J,K,L,Q') as Record<'J' | 'K' | 'L' | 'Q', { isDown: boolean }>;
            this.keys = { melee: [k.J], ranged: [k.K], staff: [k.L, k.Q] };
        }

        // A new run starts with full arrows and mana; the same run keeps its pools.
        const runId = dungeonRun.state.runId;
        if (pools.runId !== runId) Object.assign(pools, { runId, arrows: ARROWS.max, mana: MANA.max });
        this.context = this.makeContext();
        this.publishResources();
    }

    /** Current arrow / mana pools (HUD, tests, dev panel). */
    get resources ()
    {
        return { arrows: pools.arrows, maxArrows: ARROWS.max, mana: pools.mana, maxMana: MANA.max };
    }

    /** DEV panel: refill a pool. */
    refill (pool: 'arrows' | 'mana')
    {
        if (pool === 'arrows') pools.arrows = ARROWS.max;
        else pools.mana = MANA.max;
        this.publishResources();
    }

    private publishResources ()
    {
        const r = this.resources;
        const key = `${Math.floor(r.arrows)}/${Math.floor(r.mana)}`;
        if (key === this.shownResources) return;
        this.shownResources = key;
        this.host.onResources?.(r);
    }

    /** Delta-time regeneration (frame-rate independent, never above the maximum). */
    private regenerate (deltaMs: number)
    {
        const dt = Math.max(0, Math.min(deltaMs, 1000)) / 1000;
        pools.arrows = Math.min(ARROWS.max, pools.arrows + ARROWS.regenPerSecond * dt);
        pools.mana = Math.min(MANA.max, pools.mana + MANA.regenPerSecond * dt);
    }

    /** Live enemies (dev panel / tests / rooms). */
    get liveEnemies (): readonly Enemy[]
    {
        return this.enemies.filter((e) => e.alive);
    }

    // ------------------------------------------------------------ enemies

    /** Spawns an enemy with stats scaled for the current tower level / floor. `rewardId`: see Enemy.rewardId. */
    spawnEnemy (typeId: EnemyTypeId, x: number, y: number, summonedBy: Enemy | null = null, rewardId: string | null = null): Enemy
    {
        const kind = ENEMY_TYPES[typeId];
        const boss = kind.behavior === 'boss';
        const scaled = scaleStats({ hp: kind.hp, damage: kind.damage }, this.host.scaleContext(), boss);
        const contact = scaleStats({ hp: 1, damage: kind.contactDamage }, this.host.scaleContext(), boss).damage;
        const stats = { maxHp: typeId === 'skeleton' ? 1 : scaled.hp, damage: scaled.damage, contactDamage: contact };
        const id = `${typeId}-${++this.serial}`;
        const hooks = {
            onDamaged: (enemy: Enemy, amount: number) => this.host.float(`-${Math.round(amount)}`, enemy.center.x, enemy.hurtbox.y - 2, 'damage'),
            onDefeated: (enemy: Enemy) =>
            {
                // A fallen summoner takes its skeletons with it.
                for (const e of [...this.enemies]) if (e.active && e.summonedBy === enemy) e.crumble();
                // The boss's soul-fire and attack warnings vanish with him.
                if (enemy instanceof Hades)
                {
                    if (this.shots.scene) this.shots.clear(true, true);
                    this.warnings = [];
                }
                // Same-moment deaths resolve deterministically: the player's death wins, the floor
                // is retried with its guardian, so no boss progress or reward is recorded.
                if (this.dead) return;
                this.host.onEnemyDefeated?.(enemy);
            },
        };
        const enemy = boss
            ? new Hades(this.host.scene, x, y, kind, stats, id, this.context, hooks)
            : new Enemy(this.host.scene, x, y, kind, stats, id, this.context, hooks);
        enemy.summonedBy = summonedBy;
        enemy.rewardId = summonedBy ? null : rewardId; // summons never pay XP
        this.addEnemy(enemy);
        return enemy;
    }

    private addEnemy (enemy: Enemy)
    {
        const { scene, player, ground, obstacles } = this.host;
        this.enemies.push(enemy);
        this.enemyGroup.add(enemy);
        const body = enemy.body as Physics.Arcade.Body;
        body.pushable = !enemy.kind.heavy; // the group resets body defaults
        const colliders = [
            scene.physics.add.collider(enemy, ground),
            scene.physics.add.collider(enemy, obstacles),
            scene.physics.add.collider(player, enemy, () =>
            {
                if (enemy.tryContact(scene.time.now)) this.damagePlayer(enemy.stats.contactDamage, enemy.center);
            }),
        ];
        enemy.once('destroy', () => colliders.forEach((c) => c.destroy()));
    }

    /** Removes every enemy and projectile immediately (room / run reset). */
    clearEnemies ()
    {
        for (const e of [...this.enemies]) e.destroy();
        this.enemies = [];
        // Phaser may destroy scene-owned groups before our shutdown listener runs.
        if (this.arrows.scene) this.arrows.clear(true, true);
        if (this.shots.scene) this.shots.clear(true, true);
        this.warnings = [];
    }

    private makeContext (): EnemyContext
    {
        const { scene, player } = this.host;
        return {
            playerFeet: () => (this.dead ? null : { x: player.x, y: (player.body as Physics.Arcade.Body).bottom }),
            playerCenter: () => (this.dead ? null : player.center),
            fireProjectile: (from, angle, speed, damage, texture) =>
            {
                const shot = this.shots.create(from.x, from.y, texture) as Physics.Arcade.Image;
                shot.setDepth(100000).setData('shot', true).setData('damage', damage).setData('start', { ...from });
                (shot.body as Physics.Arcade.Body).setSize(4, 4).setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
            },
            summon: (by, type, x, y) => (by.alive ? this.spawnEnemy(type, x, y, by) : null),
            activeSummons: (by) => this.enemies.filter((e) => e.alive && e.summonedBy === by).length,
            hurtInCircle: (x, y, r, damage) => { if (circleHitsRect(this.playerHurtbox(), x, y, r)) this.damagePlayer(damage, { x, y }); },
            hurtInSector: (x, y, angle, reach, arc, damage) =>
            {
                if (sectorHitsRect(this.playerHurtbox(), { x, y }, angle, reach, arc)) this.damagePlayer(damage, { x, y });
            },
            warnCircle: (x, y, r, ms) => this.warn({ kind: 'circle', x, y, r, angle: 0, arc: 0, until: scene.time.now + ms }),
            warnSector: (x, y, angle, reach, arc, ms) => this.warn({ kind: 'sector', x, y, r: reach, angle, arc, until: scene.time.now + ms }),
            freeSpotNear: (x, y) =>
            {
                for (const [dx, dy] of [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10], [16, 16], [-16, 16], [16, -16], [-16, -16]])
                {
                    if (this.host.canStandAt(x + dx, y + dy)) return { x: x + dx, y: y + dy };
                }
                return null;
            },
        };
    }

    /** Red telegraph that grows more solid until the attack lands. */
    private warn (w: Warning)
    {
        const { scene } = this.host;
        this.warnings.push(w);
        const g = scene.add.graphics().setDepth(5000);
        const total = Math.max(1, w.until - scene.time.now);
        const draw = () =>
        {
            const t = 1 - Math.max(0, w.until - scene.time.now) / total;
            g.clear();
            g.fillStyle(0xff3b3b, 0.12 + t * 0.25);
            g.lineStyle(1, 0xff5a5a, 0.6 + t * 0.4);
            if (w.kind === 'circle')
            {
                g.fillCircle(w.x, w.y, w.r);
                g.strokeCircle(w.x, w.y, w.r);
            }
            else
            {
                g.beginPath();
                g.moveTo(w.x, w.y);
                g.arc(w.x, w.y, w.r, w.angle - w.arc, w.angle + w.arc);
                g.closePath();
                g.fillPath();
                g.strokePath();
            }
        };
        draw();
        const timer = scene.time.addEvent({ delay: 30, loop: true, callback: draw });
        scene.time.delayedCall(total, () => { timer.remove(); g.destroy(); });
    }

    private playerHurtbox (): Rect
    {
        const { player } = this.host;
        return { x: player.x - 7, y: player.y - 9, w: 14, h: 21 };
    }

    // ------------------------------------------------------------ frame

    update (time: number, delta = 16)
    {
        this.enemies = this.enemies.filter((e) => e.active);
        // Loops below iterate COPIES: an earlier step in the same frame may destroy later entries
        // (a fallen reaper crumbles its skeletons, a lethal hit clears every shot). Destroyed
        // objects have no data or body any more, so they are skipped, never read.
        for (const enemy of [...this.enemies]) if (enemy.active) enemy.tick(time);
        this.warnings = this.warnings.filter((w) => w.until > time);

        // Arrows: hit the first hurtbox their tip enters; fall after their range.
        for (const arrow of [...this.arrows.getChildren()] as Physics.Arcade.Image[])
        {
            if (!arrow.active) continue;
            const start = arrow.getData('start') as { x: number; y: number };
            if (Math.hypot(arrow.x - start.x, arrow.y - start.y) > (arrow.getData('range') as number)) { arrow.destroy(); continue; }
            const tip = { x: arrow.x + Math.cos(arrow.rotation) * 5, y: arrow.y + Math.sin(arrow.rotation) * 5 };
            const target = this.enemies.find((e) => e.alive && (rectContains(e.hurtbox, tip.x, tip.y, 1) || rectContains(e.hurtbox, arrow.x, arrow.y, 1)));
            if (target)
            {
                if (arrow.getData('splash')) this.explode(arrow, target);
                else target.takeDamage(arrow.getData('damage'), arrow.rotation);
                arrow.destroy();
            }
        }

        // Enemy projectiles: hit the player's body (dodgeable: small, slow, visible).
        const hurt = this.playerHurtbox();
        for (const shot of [...this.shots.getChildren()] as Physics.Arcade.Image[])
        {
            // A lethal hit below runs die(), which destroys ALL shots, including the rest of this
            // copied list. Reading getData('start') of such a destroyed shot was the Hades crash.
            if (this.dead) break;
            if (!shot.active) continue;
            const start = shot.getData('start') as { x: number; y: number };
            if (Math.hypot(shot.x - start.x, shot.y - start.y) > SHOT_RANGE) { shot.destroy(); continue; }
            if (rectContains(hurt, shot.x, shot.y, 1))
            {
                const damage = shot.getData('damage') as number;
                const at = { x: shot.x, y: shot.y };
                shot.destroy();
                this.damagePlayer(damage, at);
            }
        }
        this.drawDebug(time);

        // Paused (menus, dialogue), dead or leaving: no attacks and no regeneration.
        if (this.dead || !this.host.canAct()) return;
        this.regenerate(delta);
        this.publishResources();

        // Re-sync with the real mouse state (a release outside the window must not leave a button "held").
        const pointer = this.host.scene.input.activePointer;
        if (!pointer.leftButtonDown()) this.release('melee');
        if (!pointer.rightButtonDown()) this.release('ranged');

        // Most recent press wins: mouse buttons, then any held attack key.
        const keyAttack = (['melee', 'ranged', 'staff'] as Attack[]).find((a) => this.keys[a].some((k) => k.isDown));
        const attack = this.held[this.held.length - 1] ?? keyAttack;
        if (attack && time >= this.nextAttackAt[attack])
        {
            if (attack === 'melee') this.melee(time);
            else if (attack === 'ranged') this.shoot(time);
            else this.castStaff(time);
        }
    }

    // ------------------------------------------------------------ input

    private onPointerDown = (pointer: Input.Pointer) =>
    {
        const attack: Attack | null = pointer.button === 0 ? 'melee' : pointer.button === 2 ? 'ranged' : null;
        if (!attack || this.dead || !this.host.canAct()) return;
        this.release(attack);
        this.held.push(attack); // most recent press wins
    };

    private onPointerUp = (pointer: Input.Pointer) =>
    {
        if (pointer.button === 0) this.release('melee');
        if (pointer.button === 2) this.release('ranged');
    };

    private release (attack: Attack)
    {
        this.held = this.held.filter((a) => a !== attack);
    }

    /** Window lost focus: forget held buttons so attacks don't continue on their own. */
    releaseAll = () =>
    {
        this.held = [];
    };

    /** Currently active attack (for tests / UI). */
    get activeAttack (): Attack | null
    {
        return this.held[this.held.length - 1] ?? null;
    }

    /** The ONE aiming rule for every weapon: the player's facing direction, from their body centre. */
    private facing ()
    {
        const { player } = this.host;
        const angle = player.facingAngle;
        return { from: player.center, angle, dir: { x: Math.cos(angle), y: Math.sin(angle) } };
    }

    private hint (text: string, time: number)
    {
        if (time < this.nextHintAt) return;
        this.nextHintAt = time + 1200;
        const { x, y } = this.host.player;
        this.host.float(text, x, y - 16, 'info');
    }

    // ------------------------------------------------------------ melee

    private melee (time: number)
    {
        const { scene, player } = this.host;
        const stats = playerState.stats();
        this.nextAttackAt.melee = time + WEAPON.sword.cooldownMs;
        const { from, angle } = this.facing();

        // Swing the sword through an arc in front of the player. The icon points up-right (-45deg),
        // so +PI/4 lines the blade up with `angle`.
        const side = (this.swingSide *= -1);
        const sword = scene.add.image(from.x, from.y, 'weapon-sword')
            .setOrigin(0.12, 0.88)
            .setDepth(player.depth + (Math.sin(angle) < -0.3 ? -1 : 1));
        const start = angle + Math.PI / 4 - side * 1.2;
        sword.setRotation(start);
        scene.tweens.add({
            targets: sword,
            rotation: start + side * 2.4,
            duration: Math.min(170, WEAPON.sword.cooldownMs * 0.5),
            ease: 'Cubic.easeOut',
            onUpdate: () => sword.setPosition(player.center.x, player.center.y),
            onComplete: () => scene.tweens.add({ targets: sword, alpha: 0, duration: 60, onComplete: () => sword.destroy() }),
        });

        // Hit every enemy whose HURTBOX the swing arc touches (any side of a tall body counts).
        this.lastSwing = { x: from.x, y: from.y, angle, reach: WEAPON.sword.reach, until: time + 150 };
        for (const enemy of this.enemies)
        {
            if (enemy.alive && sectorHitsRect(enemy.hurtbox, from, angle, WEAPON.sword.reach, WEAPON.sword.arc)) enemy.takeDamage(stats.swordDamage, angle);
        }
    }

    // ------------------------------------------------------------ ranged

    private shoot (time: number)
    {
        const { scene, player } = this.host;
        if (pools.arrows < ARROWS.cost)
        {
            this.nextAttackAt.ranged = time + 250;
            return this.hint('Out of arrows', time);
        }
        pools.arrows -= ARROWS.cost;
        this.publishResources();
        this.nextAttackAt.ranged = time + WEAPON.bow.cooldownMs;
        const { from, angle, dir } = this.facing();

        // Show the bow in front of the player, drawn back then released (its icon faces left: angle - PI).
        const bow = scene.add.image(from.x + dir.x * 7, from.y + dir.y * 7, 'weapon-bow')
            .setRotation(angle - Math.PI)
            .setDepth(player.depth + (dir.y < -0.3 ? -1 : 1));
        scene.tweens.add({
            targets: bow, x: from.x + dir.x * 4, y: from.y + dir.y * 4, duration: 90, yoyo: true,
            onComplete: () => scene.tweens.add({ targets: bow, alpha: 0, duration: 120, delay: 80, onComplete: () => bow.destroy() }),
        });

        const startPos = { x: from.x + dir.x * 10, y: from.y + dir.y * 10 };
        const arrow = this.arrows.create(startPos.x, startPos.y, 'arrow') as Physics.Arcade.Image;
        arrow.setRotation(angle).setDepth(player.depth + 1);
        arrow.setData('start', startPos).setData('damage', playerState.stats().bowDamage).setData('range', WEAPON.bow.range).setData('arrow', true);
        (arrow.body as Physics.Arcade.Body).setSize(4, 4).setVelocity(dir.x * WEAPON.bow.speed, dir.y * WEAPON.bow.speed);
    }

    // ------------------------------------------------------------ magic (staff)

    /** Staff bolt straight ahead (facing direction). It bursts on the first enemy or wall it reaches. */
    private castStaff (time: number)
    {
        const { scene, player } = this.host;
        if (pools.mana < MANA.cost)
        {
            this.nextAttackAt.staff = time + 250;
            return this.hint('Not enough mana', time);
        }
        pools.mana -= MANA.cost;
        this.publishResources();
        this.nextAttackAt.staff = time + WEAPON.staff.cooldownMs;
        const { from, angle, dir } = this.facing();

        // Raise the staff toward the target for a moment (its art points up, hence + PI/2).
        const staff = scene.add.image(from.x + dir.x * 6, from.y + dir.y * 6, 'staff')
            .setOrigin(0.5, 0.8).setRotation(angle + Math.PI / 2)
            .setDepth(player.depth + (dir.y < -0.3 ? -1 : 1));
        scene.tweens.add({ targets: staff, alpha: 0, duration: 140, delay: 160, onComplete: () => staff.destroy() });

        const stats = playerState.stats();
        const startPos = { x: from.x + dir.x * 12, y: from.y + dir.y * 12 };
        const bolt = this.arrows.create(startPos.x, startPos.y, 'magic-bolt') as Physics.Arcade.Image;
        bolt.setRotation(angle).setDepth(player.depth + 1);
        bolt.setData('start', startPos).setData('damage', stats.staffDamage).setData('splashDamage', stats.staffSplashDamage)
            .setData('range', WEAPON.staff.range).setData('splash', true).setData('arrow', true);
        (bolt.body as Physics.Arcade.Body).setSize(4, 4).setVelocity(dir.x * WEAPON.staff.speed, dir.y * WEAPON.staff.speed);
    }

    /**
     * A staff bolt explodes: the primary target takes full damage, up to SPLASH.maxSecondary other
     * enemies (closest first) inside the radius take the splash share. Every enemy is hit at most
     * once per explosion; a wall impact (`primary` null) only splashes.
     */
    private explode (bolt: Physics.Arcade.Image, primary: Enemy | null)
    {
        if (bolt.getData('exploded')) return;
        bolt.setData('exploded', true);
        const { x, y } = bolt;
        const angle = bolt.rotation;
        const hit = new Set<Enemy>();
        if (primary?.alive) { primary.takeDamage(bolt.getData('damage'), angle); hit.add(primary); }
        const distance = (e: Enemy) => Math.hypot(e.center.x - x, e.center.y - y);
        const secondary = this.enemies
            .filter((e) => e.alive && !hit.has(e) && circleHitsRect(e.hurtbox, x, y, SPLASH.radius))
            .sort((a, b) => distance(a) - distance(b))
            .slice(0, SPLASH.maxSecondary);
        for (const enemy of secondary) { enemy.takeDamage(bolt.getData('splashDamage'), angle); hit.add(enemy); }

        const { scene } = this.host;
        const ring = scene.add.circle(x, y, SPLASH.radius).setStrokeStyle(2, 0xc9b3ff).setFillStyle(0x9b7bea, 0.3).setDepth(100000).setScale(0.3);
        scene.tweens.add({ targets: ring, scale: 1, alpha: 0, duration: 260, ease: 'Quad.easeOut', onComplete: () => ring.destroy() });
        return hit.size;
    }

    private projectileFrom (a: unknown, b: unknown): Physics.Arcade.Image | null
    {
        for (const candidate of [a, b])
        {
            if (candidate instanceof GameObjects.GameObject && (candidate.getData('arrow') || candidate.getData('shot'))) return candidate as Physics.Arcade.Image;
        }
        return null;
    }

    // ------------------------------------------------------------ health

    /** F: drink the equipped healing item (only if it would help). */
    heal ()
    {
        if (this.dead || !this.host.canAct()) return;
        const { scene, player } = this.host;
        const time = scene.time.now;
        const stack = playerState.inventory.equipment.healing;
        if (!stack) return this.hint('No healing item equipped', time);
        if (dungeonRun.state.hp >= dungeonRun.maxHp) return this.hint('Already at full health', time);

        const amount = itemDef(stack.itemId).stats?.heal ?? 0;
        if (!playerState.consumeEquipped('healing')) return;
        const restored = dungeonRun.heal(amount);
        this.host.float(`+${restored} HP`, player.x, player.y - 16, 'heal');

        player.setTint(0x8dff9a);
        scene.time.delayedCall(220, () => player.clearTint());
        const ring = scene.add.circle(player.x, player.y + 6, 6).setStrokeStyle(2, 0x7dff8a).setDepth(player.depth + 1);
        scene.tweens.add({ targets: ring, scale: 2.6, alpha: 0, duration: 450, onComplete: () => ring.destroy() });
    }

    /** Enemy hit: armor reduces damage (min 1), brief invulnerability, death at 0 HP. */
    damagePlayer (raw: number, from: { x: number; y: number })
    {
        const { scene, player } = this.host;
        if (this.dead || scene.time.now < this.invulnerableUntil) return;
        this.invulnerableUntil = scene.time.now + INVULNERABLE_MS;

        const damage = damageAfterArmor(raw, playerState.stats().defense);
        const hp = dungeonRun.damage(damage);
        this.host.float(`-${damage}`, player.x, player.y - 16, 'hurt');
        player.setTint(0xff6b6b);
        scene.time.delayedCall(160, () => { if (!this.dead) player.clearTint(); });
        scene.cameras.main.shake(120, 0.004);

        const angle = Math.atan2(player.y - from.y, player.x - from.x);
        player.setPosition(player.x + Math.cos(angle) * 4, player.y + Math.sin(angle) * 4);

        if (hp <= 0) this.die();
    }

    private die ()
    {
        if (this.dead) return; // death is resolved exactly once
        const { scene, player } = this.host;
        this.dead = true;
        this.warnings = [];
        this.held = [];
        player.halt();
        player.setTint(0x777777);
        scene.tweens.add({ targets: player, alpha: 0.4, angle: 90, duration: 500 });
        this.arrows.clear(true, true);
        this.shots.clear(true, true);
        scene.time.delayedCall(550, () => this.host.onPlayerDied());
    }

    // ------------------------------------------------------------ debug overlay

    /** Dev overlay: movement bodies (green), hurtboxes (red), attack hitboxes (yellow). */
    private drawDebug (time: number)
    {
        if (!HitboxDebug.enabled) return this.debug.draw({ bodies: [], hurtboxes: [], attacks: [], circles: [], points: [] });
        const { player } = this.host;
        const box = (b: Physics.Arcade.Body) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
        const live = this.enemies.filter((e) => e.alive);
        const shapes: DebugShapes = {
            bodies: [box(player.body as Physics.Arcade.Body), ...live.map((e) => box(e.body as Physics.Arcade.Body))],
            hurtboxes: [this.playerHurtbox(), ...live.map((e) => e.hurtbox)],
            attacks: [
                ...(this.lastSwing && time < this.lastSwing.until ? [{ kind: 'sector' as const, ...this.lastSwing, arc: WEAPON.sword.arc }] : []),
                ...this.warnings.filter((w) => w.kind === 'sector').map((w) => ({ kind: 'sector' as const, x: w.x, y: w.y, angle: w.angle, reach: w.r, arc: w.arc })),
            ],
            circles: this.warnings.filter((w) => w.kind === 'circle').map((w) => ({ x: w.x, y: w.y, r: w.r })),
            points: [...this.arrows.getChildren(), ...this.shots.getChildren()].map((a) =>
            {
                const img = a as Physics.Arcade.Image;
                return { x: img.x, y: img.y };
            }),
        };
        this.debug.draw(shapes);
    }

    /** Enters the death state directly (e.g. a run saved at 0 HP and reloaded). Idempotent. */
    killPlayer ()
    {
        this.die();
    }

    destroy ()
    {
        const { scene } = this.host;
        scene.input.off('pointerdown', this.onPointerDown);
        scene.input.off('pointerup', this.onPointerUp);
        scene.input.off('pointerupoutside', this.onPointerUp);
        window.removeEventListener('blur', this.releaseAll);
        document.removeEventListener('visibilitychange', this.releaseAll);
        this.held = [];
        this.clearEnemies();
        this.debug.destroy();
    }
}
