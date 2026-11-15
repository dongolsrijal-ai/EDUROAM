// One enemy in a dungeon room. Data comes from combat/enemyTypes.ts (scaled by combat/scaling.ts);
// behaviour is picked by `type.behavior`:
//   chaser    walk at the player, hurt on contact (zombie, goblin, skeleton)
//   caster    keep distance, visible cast, slow dodgeable orb (wizard)
//   tank      slow chase, telegraphed slam circle, long recovery (giant)
//   summoner  float at range, visible cast, capped skeleton summons (soul reaper)
//   boss      see Hades.ts
// Hit areas: a small feet BODY for movement, a separate HURTBOX (visible body) for attacks.

import { GameObjects, Math as PMath, Physics, Scene, TintModes } from 'phaser';
import type { EnemyType, EnemyTypeId } from './enemyTypes';
import type { Rect } from './hitboxes';

/** What an enemy may ask of the combat system (provided by CombatController). */
export interface EnemyContext
{
    /** The player's feet (chasing) and body centre (aiming); null while the player is dead. */
    playerFeet (): { x: number; y: number } | null;
    playerCenter (): { x: number; y: number } | null;
    fireProjectile (from: { x: number; y: number }, angle: number, speed: number, damage: number, texture: string): void;
    summon (by: Enemy, type: EnemyTypeId, x: number, y: number): Enemy | null;
    activeSummons (by: Enemy): number;
    /** Damage the player if their body is inside the circle / sector right now. */
    hurtInCircle (x: number, y: number, radius: number, damage: number): void;
    hurtInSector (x: number, y: number, angle: number, reach: number, arc: number, damage: number): void;
    /** Visual warnings (telegraphs) that last `ms`. */
    warnCircle (x: number, y: number, radius: number, ms: number): void;
    warnSector (x: number, y: number, angle: number, reach: number, arc: number, ms: number): void;
    /** A free floor spot near (x, y) for a summon, or null. */
    freeSpotNear (x: number, y: number): { x: number; y: number } | null;
}

export interface EnemyHooks
{
    onDamaged (enemy: Enemy, amount: number): void;
    onDefeated (enemy: Enemy): void;
}

export interface EnemyStats
{
    maxHp: number;
    damage: number;
    contactDamage: number;
}

type Mode = 'move' | 'windup' | 'recover';

export class Enemy extends Physics.Arcade.Sprite
{
    hp: number;
    readonly stats: EnemyStats;
    alive = true;
    /** Dev / tests: stand still (no moving, attacking or knockback). */
    frozen = false;
    /** The enemy that summoned this one (skeletons), if any. */
    summonedBy: Enemy | null = null;
    /**
     * Stable XP reward id (run + floor + room + wave + slot, or the floor's boss). null = pays no XP:
     * summons, dev-spawned enemies and enemies removed by dev tools.
     */
    rewardId: string | null = null;

    protected mode: Mode = 'move';
    protected modeUntil = 0;
    protected nextActionAt = 0;
    protected pending: (() => void) | null = null;
    private readonly bar: GameObjects.Graphics | null;
    private nextContactAt = 0;
    private knockbackUntil = 0;

    constructor (scene: Scene, x: number, y: number, readonly kind: EnemyType, stats: EnemyStats, readonly id: string,
        protected ctx: EnemyContext, private hooks: EnemyHooks)
    {
        super(scene, x, y, kind.texture, 0);
        this.stats = stats;
        this.hp = stats.maxHp;
        this.setOrigin(0.5, 1).setDepth(y);
        scene.add.existing(this);
        scene.physics.add.existing(this);

        const body = this.body as Physics.Arcade.Body;
        body.setSize(kind.body.w, kind.body.h, false).setOffset(kind.body.x, kind.body.y);
        body.pushable = !kind.heavy;

        this.bar = kind.behavior === 'boss' ? null : scene.add.graphics();
        this.nextActionAt = scene.time.now + 900 + Math.random() * 600; // don't attack the instant you appear
        this.anims.play(`${kind.texture}-walk`, true);
        this.drawBar();
    }

    /** Centre of the sprite, used for floating numbers and aiming. */
    get center ()
    {
        return { x: this.x, y: this.y - this.height / 2 };
    }

    /** World-space hurtbox (visible body). Attacks test against this, never the feet body. */
    get hurtbox (): Rect
    {
        const { w, h, bottom = 0 } = this.kind.hurtbox;
        return { x: this.x - w / 2, y: this.y - bottom - h, w, h };
    }

    get busy ()
    {
        return this.mode !== 'move';
    }

    tick (time: number)
    {
        if (!this.alive) return;
        const body = this.body as Physics.Arcade.Body;

        if (this.frozen)
        {
            body.setVelocity(0, 0);
        }
        else if (time < this.knockbackUntil)
        {
            // keep the knockback velocity
        }
        else if (this.mode !== 'move')
        {
            body.setVelocity(0, 0);
            if (time >= this.modeUntil)
            {
                const action = this.pending;
                this.pending = null;
                if (this.mode === 'windup' && action)
                {
                    action();
                }
                else
                {
                    this.mode = 'move';
                    this.setFrame(0);
                    this.anims.play(`${this.kind.texture}-walk`, true);
                }
            }
        }
        else
        {
            this.think(time);
        }

        this.setDepth(this.y);
        this.drawBar();
    }

    /** Behaviour while free to act. Subclasses (bosses) override. */
    protected think (time: number)
    {
        const feet = this.ctx.playerFeet();
        const centre = this.ctx.playerCenter();
        if (!feet || !centre) return this.moveToward(null);

        switch (this.kind.behavior)
        {
            case 'caster': return this.thinkCaster(time, centre);
            case 'tank': return this.thinkTank(time, feet);
            case 'summoner': return this.thinkSummoner(time, centre);
            default: return this.moveToward(feet);
        }
    }

    private thinkCaster (time: number, target: { x: number; y: number })
    {
        const c = this.kind.caster!;
        const me = this.center;
        const dist = PMath.Distance.Between(me.x, me.y, target.x, target.y);
        if (time >= this.nextActionAt && dist <= c.maxRange + 30)
        {
            // Visible cast, then a slow orb at where the player WAS (step aside to dodge).
            this.startWindup(c.castMs, () =>
            {
                const from = this.center;
                const now = this.ctx.playerCenter() ?? target;
                this.ctx.fireProjectile(from, Math.atan2(now.y - from.y, now.x - from.x), c.projectileSpeed, this.stats.damage, 'spell-orb');
                this.startRecover(350);
                this.nextActionAt = this.scene.time.now + c.cooldownMs;
            });
            return;
        }
        const away = Math.atan2(me.y - target.y, me.x - target.x);
        if (dist < c.minRange) this.moveAngle(away);
        else if (dist > c.maxRange) this.moveAngle(away + Math.PI);
        else this.moveAngle(away + Math.PI / 2, 0.5); // strafe
    }

    private thinkTank (time: number, feet: { x: number; y: number })
    {
        const t = this.kind.tank!;
        const dist = PMath.Distance.Between(this.x, this.y, feet.x, feet.y);
        if (time >= this.nextActionAt && dist <= t.triggerRange + 6)
        {
            const x = this.x, y = this.y - 6;
            this.ctx.warnCircle(x, y, t.radius, t.windupMs);
            this.startWindup(t.windupMs, () =>
            {
                this.ctx.hurtInCircle(x, y, t.radius, this.stats.damage);
                this.scene.cameras.main.shake(140, 0.006);
                this.startRecover(t.recoverMs);
                this.nextActionAt = this.scene.time.now + t.recoverMs + t.cooldownMs;
            });
            return;
        }
        this.moveToward(feet);
    }

    private thinkSummoner (time: number, target: { x: number; y: number })
    {
        const s = this.kind.summoner!;
        if (time >= this.nextActionAt && this.ctx.activeSummons(this) < s.maxActive)
        {
            const spots = Array.from({ length: s.perCast }, (_, i) =>
                this.ctx.freeSpotNear(this.x + (i % 2 ? 22 : -22), this.y + 8)).filter((p): p is { x: number; y: number } => !!p);
            for (const p of spots) this.ctx.warnCircle(p.x, p.y - 4, 7, s.castMs);
            this.startWindup(s.castMs, () =>
            {
                for (const p of spots)
                {
                    if (this.ctx.activeSummons(this) >= s.maxActive) break;
                    this.ctx.summon(this, 'skeleton', p.x, p.y);
                }
                this.startRecover(400);
                this.nextActionAt = this.scene.time.now + s.cooldownMs;
            });
            return;
        }
        // Drift around at a distance.
        const me = this.center;
        const dist = PMath.Distance.Between(me.x, me.y, target.x, target.y);
        const away = Math.atan2(me.y - target.y, me.x - target.x);
        this.moveAngle(dist < 80 ? away : dist > 130 ? away + Math.PI : away + Math.PI / 2, 0.6);
    }

    protected moveToward (goal: { x: number; y: number } | null, factor = 1)
    {
        const body = this.body as Physics.Arcade.Body;
        if (!goal || PMath.Distance.Between(this.x, this.y, goal.x, goal.y) <= 2)
        {
            body.setVelocity(0, 0);
            return;
        }
        this.moveAngle(Math.atan2(goal.y - this.y, goal.x - this.x), factor);
    }

    protected moveAngle (angle: number, factor = 1)
    {
        const body = this.body as Physics.Arcade.Body;
        body.setVelocity(Math.cos(angle) * this.kind.speed * factor, Math.sin(angle) * this.kind.speed * factor);
        if (Math.abs(Math.cos(angle)) > 0.2) this.setFlipX(Math.cos(angle) < 0);
    }

    /** Freeze in the action frame (cast / wind-up) for `ms`, then run `action`. */
    protected startWindup (ms: number, action: () => void)
    {
        this.mode = 'windup';
        this.modeUntil = this.scene.time.now + ms;
        this.pending = action;
        this.anims.stop();
        this.setFrame(2);
    }

    protected startRecover (ms: number)
    {
        this.mode = 'recover';
        this.modeUntil = this.scene.time.now + ms;
        this.pending = null;
        this.setFrame(0);
    }

    /** True (and starts the cooldown) if a contact hit may land now. */
    tryContact (time: number)
    {
        if (!this.alive || this.frozen || time < this.nextContactAt) return false;
        this.nextContactAt = time + this.kind.contactCooldownMs;
        return true;
    }

    takeDamage (amount: number, fromAngle: number)
    {
        if (!this.alive) return;
        this.hp = Math.max(0, this.hp - amount);
        this.hooks.onDamaged(this, amount);

        // Hit feedback: white flash + small knockback (heavy enemies and bosses don't budge).
        this.setTint(0xffffff).setTintMode(TintModes.FILL);
        this.scene.time.delayedCall(70, () => { if (this.active && this.alive) this.clearTint().setTintMode(TintModes.MULTIPLY); });
        if (!this.frozen && !this.kind.heavy)
        {
            const body = this.body as Physics.Arcade.Body;
            body.setVelocity(Math.cos(fromAngle) * 90, Math.sin(fromAngle) * 90);
            this.knockbackUntil = this.scene.time.now + 120;
        }

        this.drawBar();
        if (this.hp <= 0) this.defeat();
    }

    /** Dies without a fight (e.g. skeletons when their reaper falls). */
    crumble ()
    {
        if (this.alive) this.defeat();
    }

    protected defeat ()
    {
        this.alive = false;
        this.pending = null;
        const body = this.body as Physics.Arcade.Body;
        body.setVelocity(0, 0);
        body.enable = false;
        this.bar?.destroy();
        this.anims.stop();

        // Defeat: flash, collapse, a puff of particles.
        this.setTint(0xffffff).setTintMode(TintModes.FILL);
        const { x, y } = this.center;
        for (let i = 0; i < 10; i++)
        {
            const angle = (i / 10) * Math.PI * 2;
            const chip = this.scene.add.rectangle(x, y, 2, 2, i % 2 ? 0xd9d2c0 : 0x9b7be0).setDepth(this.depth + 1);
            this.scene.tweens.add({
                targets: chip, x: x + Math.cos(angle) * 18, y: y + Math.sin(angle) * 14, alpha: 0,
                duration: 450, ease: 'Quad.easeOut', onComplete: () => chip.destroy(),
            });
        }
        this.scene.tweens.add({
            targets: this, alpha: 0, scaleX: 1.2, scaleY: 0.5, duration: 380, ease: 'Quad.easeIn',
            onComplete: () => { this.hooks.onDefeated(this); this.destroy(); },
        });
    }

    private drawBar ()
    {
        if (!this.bar) return;
        const w = Math.max(14, Math.min(24, this.kind.hurtbox.w));
        const x = Math.round(this.x - w / 2);
        const y = Math.round(this.hurtbox.y - 5);
        this.bar.clear();
        if (this.hp >= this.stats.maxHp) return; // only shown once damaged
        this.bar.fillStyle(0x120708).fillRect(x - 1, y - 1, w + 2, 4);
        this.bar.fillStyle(0x3a1215).fillRect(x, y, w, 2);
        this.bar.fillStyle(0xe53935).fillRect(x, y, Math.round((w * this.hp) / this.stats.maxHp), 2);
        this.bar.setDepth(this.y + 1000);
    }

    destroy (fromScene?: boolean)
    {
        this.alive = false;
        this.pending = null;
        this.bar?.destroy();
        super.destroy(fromScene);
    }
}
