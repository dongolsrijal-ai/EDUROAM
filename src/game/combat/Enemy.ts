// A simple enemy: idles at home, walks toward the player when close, hurts on contact.
// Data-driven (EnemyDef) so future monsters / bosses reuse the same class.

import { GameObjects, Math as PMath, Physics, Scene, TintModes } from 'phaser';

export interface EnemyDef
{
    name: string;
    texture: string;
    maxHp: number;
    /** Walking speed in px/s. */
    speed: number;
    /** Starts chasing when the player is this close (px). */
    aggroRange: number;
    /** Gives up and walks home beyond this distance from home (px). */
    leashRange: number;
    /** Raw damage per touch, before the player's armor. */
    contactDamage: number;
    contactCooldownMs: number;
    /** Feet collision box (relative to the sprite's top-left). */
    body: { w: number; h: number; x: number; y: number };
    /** Approximate hit radius for melee checks (px). */
    radius: number;
}

export const STONE_GUARDIAN: EnemyDef = {
    name: 'Stone Guardian',
    texture: 'guardian',
    maxHp: 30,
    speed: 26,
    aggroRange: 120,
    leashRange: 170,
    contactDamage: 12,
    contactCooldownMs: 900,
    body: { w: 18, h: 10, x: 7, y: 21 },
    radius: 12,
};

export interface EnemyHooks
{
    onDamaged (enemy: Enemy, amount: number): void;
    onDefeated (enemy: Enemy): void;
}

export class Enemy extends Physics.Arcade.Sprite
{
    hp: number;
    alive = true;
    private readonly home: { x: number; y: number };
    private readonly bar: GameObjects.Graphics;
    private nextContactAt = 0;
    private knockbackUntil = 0;

    constructor (scene: Scene, x: number, y: number, readonly def: EnemyDef, readonly id: string, private hooks: EnemyHooks)
    {
        super(scene, x, y, def.texture);
        this.hp = def.maxHp;
        this.home = { x, y };
        this.setOrigin(0.5, 1).setDepth(y);
        scene.add.existing(this);
        scene.physics.add.existing(this);

        const body = this.body as Physics.Arcade.Body;
        body.setSize(def.body.w, def.body.h, false).setOffset(def.body.x, def.body.y);
        body.pushable = false; // the player can't shove it around

        this.bar = scene.add.graphics();
        this.drawBar();
    }

    /** Centre of the sprite, used for hit checks and floating numbers. */
    get center ()
    {
        return { x: this.x, y: this.y - this.height / 2 };
    }

    tick (time: number, target: { x: number; y: number } | null)
    {
        if (!this.alive) return;
        const body = this.body as Physics.Arcade.Body;

        if (time >= this.knockbackUntil)
        {
            const fromHome = PMath.Distance.Between(this.x, this.y, this.home.x, this.home.y);
            const toTarget = target ? PMath.Distance.Between(this.x, this.y, target.x, target.y) : Infinity;
            let goal: { x: number; y: number } | null = null;
            if (target && toTarget < this.def.aggroRange && fromHome < this.def.leashRange) goal = target;
            else if (fromHome > 4) goal = this.home;

            if (goal && PMath.Distance.Between(this.x, this.y, goal.x, goal.y) > 2)
            {
                const angle = Math.atan2(goal.y - this.y, goal.x - this.x);
                body.setVelocity(Math.cos(angle) * this.def.speed, Math.sin(angle) * this.def.speed);
                if (Math.abs(goal.x - this.x) > 1) this.setFlipX(goal.x < this.x);
            }
            else
            {
                body.setVelocity(0, 0);
            }
        }

        this.setDepth(this.y);
        this.drawBar();
    }

    /** True (and starts the cooldown) if a contact hit may land now. */
    tryContact (time: number)
    {
        if (!this.alive || time < this.nextContactAt) return false;
        this.nextContactAt = time + this.def.contactCooldownMs;
        return true;
    }

    takeDamage (amount: number, fromAngle: number)
    {
        if (!this.alive) return;
        this.hp = Math.max(0, this.hp - amount);
        this.hooks.onDamaged(this, amount);

        // Hit feedback: white flash + small knockback.
        this.setTint(0xffffff).setTintMode(TintModes.FILL);
        this.scene.time.delayedCall(70, () => { if (this.active && this.alive) this.clearTint().setTintMode(TintModes.MULTIPLY); });
        const body = this.body as Physics.Arcade.Body;
        body.setVelocity(Math.cos(fromAngle) * 90, Math.sin(fromAngle) * 90);
        this.knockbackUntil = this.scene.time.now + 120;

        this.drawBar();
        if (this.hp <= 0) this.defeat();
    }

    private defeat ()
    {
        this.alive = false;
        const body = this.body as Physics.Arcade.Body;
        body.setVelocity(0, 0);
        body.enable = false;
        this.bar.destroy();

        // Defeat animation: flash, crumble upward, burst of stone chips.
        this.setTint(0xffffff).setTintMode(TintModes.FILL);
        const { x, y } = this.center;
        for (let i = 0; i < 10; i++)
        {
            const angle = (i / 10) * Math.PI * 2;
            const chip = this.scene.add.rectangle(x, y, 3, 3, i % 2 ? 0x7d7891 : 0x7be3ff).setDepth(this.depth + 1);
            this.scene.tweens.add({
                targets: chip, x: x + Math.cos(angle) * 22, y: y + Math.sin(angle) * 18, alpha: 0,
                duration: 500, ease: 'Quad.easeOut', onComplete: () => chip.destroy(),
            });
        }
        this.scene.tweens.add({
            targets: this, alpha: 0, scaleX: 1.25, scaleY: 0.6, duration: 450, ease: 'Quad.easeIn',
            onComplete: () => { this.hooks.onDefeated(this); this.destroy(); },
        });
    }

    private drawBar ()
    {
        const w = 22;
        const x = Math.round(this.x - w / 2);
        const y = Math.round(this.y - this.height - 5);
        this.bar.clear();
        this.bar.fillStyle(0x120708).fillRect(x - 1, y - 1, w + 2, 5);
        this.bar.fillStyle(0x3a1215).fillRect(x, y, w, 3);
        this.bar.fillStyle(0xe53935).fillRect(x, y, Math.round((w * this.hp) / this.def.maxHp), 3);
        this.bar.setDepth(this.y + 1000);
    }

    destroy (fromScene?: boolean)
    {
        this.bar?.destroy();
        super.destroy(fromScene);
    }
}
