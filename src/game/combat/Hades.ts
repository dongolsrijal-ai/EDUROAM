// HADES, KING OF THE DEAD - final boss of a tower run. Three telegraphed abilities:
//   Soul Fire     wind-up glow, then aimed fans / rings of slow soul-fire (rings always have gaps)
//   Reaper Summon wind-up, then a small, capped wave of skeletons
//   Death Sweep   red warning wedge, damage ONLY inside it, then a long recovery window
// Phase 2 (below 50 % HP): shorter gaps, slightly faster shots, more summons. Nothing unavoidable.

import { GameObjects, Math as PMath } from 'phaser';
import { Enemy } from './Enemy';

interface PhaseTuning
{
    actionGapMs: number;
    fireWindupMs: number;
    shotSpeed: number;
    sweepWindupMs: number;
    sweepRecoverMs: number;
    summonCount: number;
    maxSummons: number;
    summonCooldownMs: number;
}

const PHASES: Record<1 | 2, PhaseTuning> = {
    1: { actionGapMs: 1500, fireWindupMs: 750, shotSpeed: 78, sweepWindupMs: 950, sweepRecoverMs: 1150, summonCount: 2, maxSummons: 3, summonCooldownMs: 9000 },
    2: { actionGapMs: 1000, fireWindupMs: 600, shotSpeed: 92, sweepWindupMs: 750, sweepRecoverMs: 900, summonCount: 3, maxSummons: 5, summonCooldownMs: 6000 },
};

const SWEEP_REACH = 60;
const SWEEP_ARC = 1.15;

export class Hades extends Enemy
{
    phase: 1 | 2 = 1;
    /** No attacks before this time (boss introduction). */
    activeAt = 0;
    private nextSummonAt = 0;
    private volley = 0;
    /** Subtle soul aura under him + rising embers (visual only; removed with him). */
    private aura: GameObjects.Ellipse | null = null;
    private nextEmberAt = 0;

    get tuning ()
    {
        return PHASES[this.phase];
    }

    /** Keeps the aura under his feet and lets a few soul-embers drift up (low density). */
    private ambience (time: number)
    {
        if (!this.aura)
        {
            this.aura = this.scene.add.ellipse(this.x, this.y - 2, 40, 12, 0x8f5bff, 0.2);
            this.scene.tweens.add({ targets: this.aura, alpha: 0.08, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
        }
        this.aura.setPosition(this.x, this.y - 2).setDepth(this.depth - 1);
        if (time < this.nextEmberAt) return;
        this.nextEmberAt = time + (this.phase === 2 ? 260 : 420);
        const ember = this.scene.add.rectangle(this.x + (Math.random() - 0.5) * 26, this.y - 8 - Math.random() * 20, 2, 2, this.phase === 2 ? 0xff6bf0 : 0xb56bff)
            .setDepth(this.depth + 1).setAlpha(0.9);
        this.scene.tweens.add({ targets: ember, y: ember.y - 14, alpha: 0, duration: 900, ease: 'Sine.easeOut', onComplete: () => ember.destroy() });
    }

    protected defeat ()
    {
        this.setFrame(4); // collapse pose, then the shared flash + crumble
        this.aura?.destroy();
        this.aura = null;
        super.defeat();
        this.anims.stop();
        this.setFrame(4);
    }

    destroy (fromScene?: boolean)
    {
        this.aura?.destroy();
        this.aura = null;
        super.destroy(fromScene);
    }

    takeDamage (amount: number, fromAngle: number)
    {
        super.takeDamage(amount, fromAngle);
        if (this.alive && this.phase === 1 && this.hp < this.stats.maxHp / 2)
        {
            this.phase = 2;
            this.scene.events.emit('boss-phase', 2);
            this.scene.cameras.main.flash(250, 120, 60, 200);
        }
    }

    protected think (time: number)
    {
        this.ambience(time);
        const feet = this.ctx.playerFeet();
        const centre = this.ctx.playerCenter();
        if (!feet || !centre || time < this.activeAt) return this.moveToward(null);

        const t = this.tuning;
        const dist = PMath.Distance.Between(this.x, this.y, feet.x, feet.y);
        if (time >= this.nextActionAt)
        {
            if (dist < SWEEP_REACH - 6) return this.deathSweep(feet);
            if (time >= this.nextSummonAt && this.ctx.activeSummons(this) < t.maxSummons) return this.reaperSummon(time);
            return this.soulFire();
        }

        // Keep a menacing middle distance.
        const me = this.center;
        const away = Math.atan2(me.y - centre.y, me.x - centre.x);
        const d = PMath.Distance.Between(me.x, me.y, centre.x, centre.y);
        this.moveAngle(d > 110 ? away + Math.PI : d < 70 ? away : away + Math.PI / 2, 0.7);
    }

    private soulFire ()
    {
        const t = this.tuning;
        const from = { x: this.x, y: this.y - 30 };
        this.ctx.warnCircle(from.x, from.y, 10, t.fireWindupMs);
        this.startWindup(t.fireWindupMs, () =>
        {
            const target = this.ctx.playerCenter();
            const aim = target ? Math.atan2(target.y - from.y, target.x - from.x) : Math.PI / 2;
            const damage = Math.max(1, Math.round(this.stats.damage * 0.75));
            const fan = (count: number, spread: number, offset = 0) =>
            {
                for (let i = 0; i < count; i++)
                {
                    const a = aim + offset + (i - (count - 1) / 2) * spread;
                    this.ctx.fireProjectile(from, a, t.shotSpeed, damage, 'soul-fire');
                }
            };
            const ring = (count: number, gaps: number) =>
            {
                const skip = new Set(Array.from({ length: gaps }, (_, g) => (Math.floor(Math.random() * count) + g * 3) % count));
                for (let i = 0; i < count; i++) if (!skip.has(i)) this.ctx.fireProjectile(from, (i / count) * Math.PI * 2 + aim, t.shotSpeed * 0.8, damage, 'soul-fire');
            };

            const pattern = this.volley++ % 2;
            if (this.phase === 1)
            {
                if (pattern === 0) fan(3, 0.32);
                else ring(10, 2);
            }
            else if (pattern === 0)
            {
                fan(5, 0.28);
                this.scene.time.delayedCall(320, () => { if (this.alive) fan(4, 0.28, 0.14); });
            }
            else
            {
                ring(14, 3);
            }
            this.startRecover(500);
            this.nextActionAt = this.scene.time.now + t.actionGapMs;
        });
    }

    private reaperSummon (time: number)
    {
        const t = this.tuning;
        const spots = Array.from({ length: t.summonCount }, (_, i) =>
        {
            const a = (i / t.summonCount) * Math.PI * 2 + Math.random();
            return this.ctx.freeSpotNear(this.x + Math.cos(a) * 34, this.y + Math.sin(a) * 26);
        }).filter((p): p is { x: number; y: number } => !!p);
        for (const p of spots) this.ctx.warnCircle(p.x, p.y - 4, 8, 800);
        this.nextSummonAt = time + t.summonCooldownMs;
        this.startWindup(800, () =>
        {
            for (const p of spots)
            {
                if (this.ctx.activeSummons(this) >= t.maxSummons) break;
                this.ctx.summon(this, 'skeleton', p.x, p.y);
            }
            this.startRecover(450);
            this.nextActionAt = this.scene.time.now + t.actionGapMs;
        });
        this.setFrame(3); // summon pose (arms spread, runes) instead of the generic cast frame
    }

    private deathSweep (feet: { x: number; y: number })
    {
        const t = this.tuning;
        const origin = { x: this.x, y: this.y - 10 };
        const angle = Math.atan2(feet.y - 6 - origin.y, feet.x - origin.x);
        this.ctx.warnSector(origin.x, origin.y, angle, SWEEP_REACH, SWEEP_ARC, t.sweepWindupMs);
        this.startWindup(t.sweepWindupMs, () =>
        {
            this.ctx.hurtInSector(origin.x, origin.y, angle, SWEEP_REACH, SWEEP_ARC, Math.round(this.stats.damage * 1.5));
            this.scene.cameras.main.shake(160, 0.007);
            this.startRecover(t.sweepRecoverMs); // punish window
            this.nextActionAt = this.scene.time.now + t.sweepRecoverMs + t.actionGapMs * 0.5;
        });
    }
}
