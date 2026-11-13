// Renders one NpcRecord in the world and makes it ROAM around its home spot.
// Every NPC uses this class; what makes them different is their data (data/npcStore.ts).
//
// Movement is deliberately simple: pick a random nearby spot that the scene says is free,
// walk there in a straight line (sliding along obstacles), idle a bit, repeat.
// It never talks to the dialogue system; the scene just calls setTalking().

import { Math as PMath, Physics, Scene } from 'phaser';
import { CHARACTER_SIZE, NPC_ROAM_RADIUS, NPC_WALK_SPEED } from '../config';
import type { NpcRecord } from '../data/npcStore';
import { APPEARANCES } from './appearances';

/** How close (pixels) the player must be to talk. */
export const TALK_RANGE = 30;

/** NPC collision box around a feet position (also used to validate placement and roaming). */
export const npcFootprint = (x: number, y: number) => ({ x: x - 6, y: y - 7, w: 12, h: 7 });

/** Asks the scene whether this NPC's feet may stand at (x, y). */
export type CanStand = (x: number, y: number, self: Npc) => boolean;

const IDLE_MS: [number, number] = [1500, 4500];
const MAX_WALK_MS = 5000;

export class Npc extends Physics.Arcade.Sprite
{
    readonly record: NpcRecord;
    readonly home: { x: number; y: number };

    private mode: 'idle' | 'walk' | 'talk' = 'idle';
    private timer = 0;
    private target = { x: 0, y: 0 };

    constructor (scene: Scene, record: NpcRecord, private canStand: CanStand, private roamRadius = NPC_ROAM_RADIUS)
    {
        // Anchored at the feet so depth sorting matches the player.
        super(scene, record.x, record.y, APPEARANCES[record.appearance].texture);
        this.record = record;
        this.home = { x: record.x, y: record.y };
        this.setOrigin(0.5, 1).setDepth(this.y);
        scene.add.existing(this);
        scene.physics.add.existing(this);

        // Feet-only body. moves=false: we position the NPC ourselves (after checking the spot
        // is free); immovable: the player bumps into it instead of pushing it.
        const body = this.body as Physics.Arcade.Body;
        body.setSize(12, 7, false).setOffset((CHARACTER_SIZE - 12) / 2, CHARACTER_SIZE - 7);
        body.setImmovable(true);
        body.moves = false;

        this.timer = PMath.Between(...IDLE_MS) / 2;
    }

    distanceTo (target: { x: number; y: number })
    {
        return PMath.Distance.Between(this.x, this.y - CHARACTER_SIZE / 2, target.x, target.y);
    }

    /** Freeze while the player talks to this NPC; resume roaming afterwards. */
    setTalking (talking: boolean)
    {
        if (talking) this.mode = 'talk';
        else if (this.mode === 'talk') this.idle();
    }

    tick (deltaMs: number)
    {
        if (this.mode === 'talk') return;
        this.timer -= deltaMs;

        if (this.mode === 'idle')
        {
            if (this.timer <= 0) this.pickDestination();
            return;
        }

        // Walking
        const dx = this.target.x - this.x;
        const dy = this.target.y - this.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1 || this.timer <= 0) return this.idle();

        const step = Math.min(dist, (NPC_WALK_SPEED * deltaMs) / 1000);
        const nx = this.x + (dx / dist) * step;
        const ny = this.y + (dy / dist) * step;

        // Slide along obstacles: try the full step, then each axis on its own.
        if (this.canStand(nx, ny, this)) this.stepTo(nx, ny);
        else if (Math.abs(dx) > 0.5 && this.canStand(nx, this.y, this)) this.stepTo(nx, this.y);
        else if (Math.abs(dy) > 0.5 && this.canStand(this.x, ny, this)) this.stepTo(this.x, ny);
        else this.idle(); // blocked (player, another NPC...): wait and choose again

        if (Math.abs(dx) > 0.5) this.setFlipX(dx < 0);
    }

    private stepTo (x: number, y: number)
    {
        this.setPosition(x, y);
        this.setDepth(y);
    }

    private idle ()
    {
        this.mode = 'idle';
        this.timer = PMath.Between(...IDLE_MS);
    }

    private pickDestination ()
    {
        // Too far from home (e.g. after being blocked a lot)? Head back.
        const away = PMath.Distance.Between(this.x, this.y, this.home.x, this.home.y);
        if (away > this.roamRadius)
        {
            this.walkTo(this.home.x, this.home.y);
            return;
        }

        for (let attempt = 0; attempt < 8; attempt++)
        {
            const angle = Math.random() * Math.PI * 2;
            const radius = this.roamRadius * Math.sqrt(Math.random());
            const x = Math.round(this.home.x + Math.cos(angle) * radius);
            const y = Math.round(this.home.y + Math.sin(angle) * radius);
            if (Math.hypot(x - this.x, y - this.y) > 8 && this.canStand(x, y, this)) return this.walkTo(x, y);
        }
        this.idle();
    }

    private walkTo (x: number, y: number)
    {
        this.mode = 'walk';
        this.target = { x, y };
        this.timer = MAX_WALK_MS;
    }
}
