// Hit detection shared by every enemy and attack.
//
//   movement body  small physics box at the feet (walls, other bodies) - lives on the sprite
//   hurtbox        rectangle covering the visible body; the ONLY thing attacks test against
//   attack hitbox  a melee arc, an arrow point, a slam circle... tested against hurtboxes
//
// Keeping the hurtbox separate from the movement body is what lets the player hit the upper half
// of tall enemies and bosses, from any side.

import type { GameObjects, Scene } from 'phaser';
import { DEV, devFlags } from '../dev/devFlags';

export interface Rect { x: number; y: number; w: number; h: number }

export const rectContains = (r: Rect, x: number, y: number, pad = 0) =>
    x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;

export const circleHitsRect = (r: Rect, cx: number, cy: number, radius: number) =>
{
    const px = Math.max(r.x, Math.min(cx, r.x + r.w));
    const py = Math.max(r.y, Math.min(cy, r.y + r.h));
    return Math.hypot(px - cx, py - cy) <= radius;
};

/**
 * True if a melee swing (a pie slice of `reach` px around `angle`, +-`arc` rad) touches the rect.
 * Tests corners, the closest point, and both boundary rays, including hits along a tall flat edge.
 */
export function sectorHitsRect (r: Rect, from: { x: number; y: number }, angle: number, reach: number, arc: number): boolean
{
    if (rectContains(r, from.x, from.y)) return true;
    const px = Math.max(r.x, Math.min(from.x, r.x + r.w));
    const py = Math.max(r.y, Math.min(from.y, r.y + r.h));
    if (Math.hypot(px - from.x, py - from.y) > reach) return false;
    // Any of: closest point, centre, or the near corners inside the arc counts.
    const points = [[px, py], [r.x + r.w / 2, r.y + r.h / 2], [r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
    if (points.some(([x, y]) =>
    {
        if (Math.hypot(x - from.x, y - from.y) > reach) return false;
        const diff = Math.atan2(y - from.y, x - from.x) - angle;
        return Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff))) <= arc;
    })) return true;
    return [angle - arc, angle + arc].some((a) => segmentHitsRect(r, from,
        { x: from.x + Math.cos(a) * reach, y: from.y + Math.sin(a) * reach }));
}

/** Finite line segment against an axis-aligned rectangle. */
export function segmentHitsRect (r: Rect, from: { x: number; y: number }, to: { x: number; y: number }): boolean
{
    let enter = 0, exit = 1;
    for (const [start, delta, min, max] of [
        [from.x, to.x - from.x, r.x, r.x + r.w],
        [from.y, to.y - from.y, r.y, r.y + r.h],
    ])
    {
        if (Math.abs(delta) < 1e-10)
        {
            if (start < min || start > max) return false;
            continue;
        }
        const a = (min - start) / delta, b = (max - start) / delta;
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
        if (enter > exit) return false;
    }
    return true;
}

/** What the debug overlay draws each frame. */
export interface DebugShapes
{
    bodies: Rect[];
    hurtboxes: Rect[];
    attacks: { kind: 'sector'; x: number; y: number; angle: number; reach: number; arc: number }[];
    circles: { x: number; y: number; r: number }[];
    points: { x: number; y: number }[];
}

/** Dev-only overlay: green = movement bodies, red = hurtboxes, yellow = attack hitboxes. */
export class HitboxDebug
{
    private g: GameObjects.Graphics | null = null;

    constructor (private scene: Scene) {}

    static get enabled ()
    {
        return DEV && devFlags.get('hitboxes');
    }

    draw (shapes: DebugShapes)
    {
        if (!HitboxDebug.enabled)
        {
            this.g?.clear();
            return;
        }
        this.g ??= this.scene.add.graphics().setDepth(1_000_000);
        const g = this.g.clear();
        g.lineStyle(1, 0x40ff60, 1);
        for (const r of shapes.bodies) g.strokeRect(r.x, r.y, r.w, r.h);
        g.lineStyle(1, 0xff3b3b, 1);
        for (const r of shapes.hurtboxes) g.strokeRect(r.x, r.y, r.w, r.h);
        g.lineStyle(1, 0xffe14a, 1);
        for (const a of shapes.attacks)
        {
            g.beginPath();
            g.moveTo(a.x, a.y);
            g.arc(a.x, a.y, a.reach, a.angle - a.arc, a.angle + a.arc);
            g.closePath();
            g.strokePath();
        }
        for (const c of shapes.circles) g.strokeCircle(c.x, c.y, c.r);
        g.fillStyle(0xffe14a, 1);
        for (const p of shapes.points) g.fillRect(p.x - 1, p.y - 1, 2, 2);
    }

    destroy ()
    {
        this.g?.destroy();
    }
}
