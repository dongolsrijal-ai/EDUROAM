// Minimal rendering/physics boundary for deterministic tests of the real combat classes.
// No enemy decisions, damage, attack geometry or run logic are implemented here.
import { EventEmitter } from 'node:events';

export class Body
{
    velocity = { x: 0, y: 0 };
    enable = true;
    pushable = true;
    bottom = 0;
    setSize () { return this; }
    setOffset () { return this; }
    setVelocity (x: number, y: number) { this.velocity = { x, y }; return this; }
}

export class Sprite extends EventEmitter
{
    active = true;
    body = new Body();
    height = 24;
    depth = 0;
    rotation = 0;
    data = new Map<string, unknown>();
    anims = { play () {}, stop () {} };
    scene: any;
    x: number;
    y: number;
    constructor (scene: any, x = 0, y = 0, _texture?: string, _frame?: number) { super(); this.scene = scene; this.x = x; this.y = y; }
    setOrigin () { return this; }
    setDepth (value: number) { this.depth = value; return this; }
    setTint () { return this; }
    setTintMode () { return this; }
    clearTint () { return this; }
    setFlipX () { return this; }
    setFrame () { return this; }
    setRotation (value: number) { this.rotation = value; return this; }
    setData (key: string, value: unknown) { this.data.set(key, value); return this; }
    getData (key: string) { return this.data.get(key); }
    // Like Phaser: a destroyed object loses its data (getData() then returns undefined).
    destroy () { this.active = false; this.data.clear(); this.emit('destroy'); }
}
export const Physics = { Arcade: { Sprite } };
export const GameObjects = { GameObject: Sprite };
export const Math = { Distance: { Between: (x1: number, y1: number, x2: number, y2: number) => globalThis.Math.hypot(x2 - x1, y2 - y1) } };
export const TintModes = { FILL: 1, MULTIPLY: 0 };

export function makeScene ()
{
    const graphics: any = new Proxy({}, { get: () => () => graphics });
    const scheduled: { at: number; callback: () => void }[] = [];
    const groups: any[] = [];
    const scene: any = {
        events: new EventEmitter(), input: new EventEmitter(),
        time: { now: 0,
            delayedCall: (delay: number, callback: () => void) => scheduled.push({ at: scene.time.now + delay, callback }),
            addEvent: () => ({ remove () {} }),
        },
        add: { existing () {}, graphics: () => graphics, rectangle: () => graphics, circle: () => graphics, ellipse: () => graphics, image: () => graphics },
        physics: { add: { existing () {}, collider: () => ({ destroy () {} }), group: () =>
        {
            const children: Sprite[] = [];
            const group = { scene, add: (s: Sprite) => children.push(s),
                create: (x: number, y: number, texture: string) => { const s = new Sprite(scene, x, y, texture); children.push(s); return s; },
                getChildren: () => children.filter((s) => s.active),
                clear: () => { for (const s of children) if (s.active) s.destroy(); children.length = 0; },
            };
            groups.push(group);
            return group;
        } } },
        cameras: { main: { flash () {}, shake () {} } },
        tweens: { add: (config: any) => { if (config.onComplete) scheduled.push({ at: scene.time.now + (config.duration ?? 0), callback: config.onComplete }); } },
        advance: (time: number) =>
        {
            scene.time.now = time;
            for (const task of [...scheduled]) if (task.at <= time) { scheduled.splice(scheduled.indexOf(task), 1); task.callback(); }
        },
        groups,
    };
    return scene;
}
