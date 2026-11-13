// Player combat for combat-enabled maps (dungeons only; the village never creates one).
//   Left click  = melee with the equipped melee weapon (hold to keep swinging)
//   Right click = ranged with the equipped ranged weapon (hold to keep firing)
//   F           = drink the equipped healing item
// Damage, attack speed, defense and healing all come from the shared equipment stats
// (player.stats()) and the run's HP (dungeonRun), so new gear works automatically.

import { GameObjects, Input, Math as PMath, Physics, Scene, Tilemaps } from 'phaser';
import { itemDef } from '../items/itemDefs';
import type { Player } from '../objects/Player';
import { dungeonRun } from '../state/dungeonRun';
import { player as playerState } from '../state/playerState';
import { Enemy } from './Enemy';

type Attack = 'melee' | 'ranged';

const MELEE_REACH = 30;              // px from the player's centre
const MELEE_ARC = 1.3;               // radians either side of the aim direction
const ARROW_SPEED = 250;             // px/s
const ARROW_RANGE = 260;             // px before it drops
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
}

export class CombatController
{
    /** Mouse buttons currently held, in press order (last = active attack). */
    private held: Attack[] = [];
    private nextAttackAt: Record<Attack, number> = { melee: 0, ranged: 0 };
    private nextHintAt = 0;
    private swingSide = 1;
    private invulnerableUntil = 0;
    private arrows: Physics.Arcade.Group;
    private enemies: Enemy[] = [];
    dead = false;

    constructor (private host: CombatHost)
    {
        const { scene, ground, obstacles } = host;
        scene.input.mouse?.disableContextMenu(); // right click = shoot, only on the game canvas

        this.arrows = scene.physics.add.group({ allowGravity: false });
        const dropArrow = (a: unknown, b: unknown) => this.arrowFrom(a, b)?.destroy();
        scene.physics.add.collider(this.arrows, ground, dropArrow);
        scene.physics.add.collider(this.arrows, obstacles, dropArrow);

        scene.input.on('pointerdown', this.onPointerDown);
        scene.input.on('pointerup', this.onPointerUp);
        scene.input.on('pointerupoutside', this.onPointerUp);
        window.addEventListener('blur', this.releaseAll);
        document.addEventListener('visibilitychange', this.releaseAll);
    }

    addEnemy (enemy: Enemy)
    {
        const { scene, player, ground, obstacles } = this.host;
        this.enemies.push(enemy);
        const colliders = [
            scene.physics.add.collider(enemy, ground),
            scene.physics.add.collider(enemy, obstacles),
            scene.physics.add.collider(player, enemy, () =>
            {
                if (enemy.tryContact(scene.time.now)) this.damagePlayer(enemy.def.contactDamage, enemy.center);
            }),
            scene.physics.add.overlap(this.arrows, enemy, (a, b) =>
            {
                const arrow = this.arrowFrom(a, b);
                if (!arrow?.active || !enemy.alive) return;
                enemy.takeDamage(arrow.getData('damage'), arrow.rotation);
                arrow.destroy();
            }),
        ];
        enemy.once('destroy', () => colliders.forEach((c) => c.destroy()));
    }

    update (time: number)
    {
        const { player } = this.host;
        this.enemies = this.enemies.filter((e) => e.active);
        // Enemies walk toward the player's FEET (both use feet hitboxes), so they actually make contact.
        const feet = { x: player.x, y: (player.body as Physics.Arcade.Body).bottom };
        for (const enemy of this.enemies) enemy.tick(time, this.dead ? null : feet);

        // Arrows fall after their range.
        for (const arrow of this.arrows.getChildren() as Physics.Arcade.Image[])
        {
            const start = arrow.getData('start') as { x: number; y: number };
            if (Math.hypot(arrow.x - start.x, arrow.y - start.y) > ARROW_RANGE) arrow.destroy();
        }

        if (this.dead || !this.host.canAct()) return;

        // Re-sync with the real mouse state (a release outside the window must not leave a button "held").
        const pointer = this.host.scene.input.activePointer;
        if (!pointer.leftButtonDown()) this.release('melee');
        if (!pointer.rightButtonDown()) this.release('ranged');

        const attack = this.held[this.held.length - 1];
        if (attack && time >= this.nextAttackAt[attack])
        {
            if (attack === 'melee') this.melee(time);
            else this.shoot(time);
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

    private aim ()
    {
        const { scene, player } = this.host;
        const pointer = scene.input.activePointer;
        const world = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const from = player.center;
        return { from, angle: Math.atan2(world.y - from.y, world.x - from.x) };
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
        const weapon = playerState.inventory.equipment.melee;
        if (!weapon)
        {
            this.nextAttackAt.melee = time + 500;
            return this.hint('No melee weapon equipped', time);
        }
        const stats = playerState.stats();
        this.nextAttackAt.melee = time + stats.meleeCooldownMs;

        const { from, angle } = this.aim();
        player.faceAngle(angle);

        // Swing the equipped weapon's own sprite through an arc toward the cursor.
        // Icons point up-right (-45deg), so +PI/4 lines the blade up with `angle`.
        const side = (this.swingSide *= -1);
        const sword = scene.add.image(from.x, from.y, `item-${weapon.itemId}`)
            .setOrigin(0.12, 0.88)
            .setDepth(player.depth + (Math.sin(angle) < -0.3 ? -1 : 1));
        const start = angle + Math.PI / 4 - side * 1.2;
        sword.setRotation(start);
        scene.tweens.add({
            targets: sword,
            rotation: start + side * 2.4,
            duration: Math.min(170, stats.meleeCooldownMs * 0.5),
            ease: 'Cubic.easeOut',
            onUpdate: () => sword.setPosition(player.center.x, player.center.y),
            onComplete: () => scene.tweens.add({ targets: sword, alpha: 0, duration: 60, onComplete: () => sword.destroy() }),
        });

        // Hit every enemy inside the swing arc.
        for (const enemy of this.enemies)
        {
            if (!enemy.alive) continue;
            const c = enemy.center;
            const dist = Math.hypot(c.x - from.x, c.y - from.y);
            const diff = Math.abs(PMath.Angle.Wrap(Math.atan2(c.y - from.y, c.x - from.x) - angle));
            if (dist <= MELEE_REACH + enemy.def.radius && diff <= MELEE_ARC) enemy.takeDamage(stats.meleeDamage, angle);
        }
    }

    // ------------------------------------------------------------ ranged

    private shoot (time: number)
    {
        const { scene, player } = this.host;
        const weapon = playerState.inventory.equipment.ranged;
        if (!weapon)
        {
            this.nextAttackAt.ranged = time + 500;
            return this.hint('No ranged weapon equipped', time);
        }
        const stats = playerState.stats();
        this.nextAttackAt.ranged = time + stats.rangedCooldownMs;

        const { from, angle } = this.aim();
        player.faceAngle(angle);

        // Show the equipped bow in front of the player, drawn back then released.
        // The bow icon faces left (PI), so rotate by angle - PI.
        const dir = { x: Math.cos(angle), y: Math.sin(angle) };
        const bow = scene.add.image(from.x + dir.x * 7, from.y + dir.y * 7, `item-${weapon.itemId}`)
            .setRotation(angle - Math.PI)
            .setDepth(player.depth + (dir.y < -0.3 ? -1 : 1));
        scene.tweens.add({
            targets: bow, x: from.x + dir.x * 4, y: from.y + dir.y * 4, duration: 90, yoyo: true,
            onComplete: () => scene.tweens.add({ targets: bow, alpha: 0, duration: 120, delay: 80, onComplete: () => bow.destroy() }),
        });

        // The arrow itself.
        const startPos = { x: from.x + dir.x * 10, y: from.y + dir.y * 10 };
        const arrow = this.arrows.create(startPos.x, startPos.y, 'arrow') as Physics.Arcade.Image;
        arrow.setRotation(angle).setDepth(player.depth + 1);
        arrow.setData('start', startPos).setData('damage', stats.rangedDamage).setData('arrow', true);
        (arrow.body as Physics.Arcade.Body).setSize(4, 4).setVelocity(dir.x * ARROW_SPEED, dir.y * ARROW_SPEED);
    }

    private arrowFrom (a: unknown, b: unknown): Physics.Arcade.Image | null
    {
        for (const candidate of [a, b])
        {
            if (candidate instanceof GameObjects.GameObject && candidate.getData('arrow')) return candidate as Physics.Arcade.Image;
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

        // Healing effect: green flash + expanding ring.
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

        const damage = Math.max(1, raw - playerState.stats().defense);
        const hp = dungeonRun.damage(damage);
        this.host.float(`-${damage}`, player.x, player.y - 16, 'hurt');
        player.setTint(0xff6b6b);
        scene.time.delayedCall(160, () => { if (!this.dead) player.clearTint(); });
        scene.cameras.main.shake(120, 0.004);

        // Small knockback away from the enemy.
        const angle = Math.atan2(player.y - from.y, player.x - from.x);
        player.setPosition(player.x + Math.cos(angle) * 4, player.y + Math.sin(angle) * 4);

        if (hp <= 0) this.die();
    }

    private die ()
    {
        const { scene, player } = this.host;
        this.dead = true;
        this.held = [];
        player.halt();
        player.setTint(0x777777);
        scene.tweens.add({ targets: player, alpha: 0.4, angle: 90, duration: 500 });
        for (const arrow of this.arrows.getChildren()) arrow.destroy();
        scene.time.delayedCall(550, () => this.host.onPlayerDied());
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
    }
}
