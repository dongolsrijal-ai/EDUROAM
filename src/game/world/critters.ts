// AMBIENT CRITTERS: friendly decorative insects + drifting leaves for the village.
// No physics bodies, health or combat: they never block the player or NPCs. Movement is
// tween-driven and stays within a small radius of each critter's home spot. Tweens and
// timers belong to the scene, so they are cleaned up automatically when the scene changes.

import { GameObjects, Math as PMath, Scene } from 'phaser';
import { TILE } from '../config';

export type CritterKind =
    | 'butterflyBlue' | 'butterflyPink' | 'butterflyYellow'
    | 'bee' | 'ladybug' | 'snail' | 'caterpillar';

/** A critter's home spot in TILE coordinates (fractions allowed). */
export interface CritterSpawn
{
    kind: CritterKind;
    x: number;
    y: number;
}

interface CritterType
{
    texture: string;
    flies: boolean;
    /** How far (px) it wanders from home. */
    radius: number;
    /** Movement speed (px/s). */
    speed: number;
    /** Pause between moves (ms range). */
    rest: [number, number];
    /** Crawlers prefer moving sideways (snails, caterpillars). */
    horizontal?: boolean;
}

const TYPES: Record<CritterKind, CritterType> = {
    butterflyBlue: { texture: 'butterfly-blue', flies: true, radius: 30, speed: 16, rest: [0, 400] },
    butterflyPink: { texture: 'butterfly-pink', flies: true, radius: 30, speed: 15, rest: [0, 400] },
    butterflyYellow: { texture: 'butterfly-yellow', flies: true, radius: 26, speed: 17, rest: [0, 400] },
    bee: { texture: 'bee', flies: true, radius: 16, speed: 24, rest: [300, 1200] },
    ladybug: { texture: 'ladybug', flies: false, radius: 12, speed: 5, rest: [1500, 4000] },
    snail: { texture: 'snail', flies: false, radius: 20, speed: 2.5, rest: [2000, 5000], horizontal: true },
    caterpillar: { texture: 'caterpillar', flies: false, radius: 18, speed: 4, rest: [1500, 3500], horizontal: true },
};

/** Fliers hover above everything in the world (but under UI ghosts / overlays). */
const FLYING_DEPTH = 90_000;

export function spawnCritters (scene: Scene, spawns: CritterSpawn[])
{
    for (const spawn of spawns)
    {
        const type = TYPES[spawn.kind];
        const home = { x: spawn.x * TILE, y: spawn.y * TILE };
        const sprite = scene.add.sprite(home.x, home.y, type.texture, 0);
        sprite.play({ key: `${type.texture}-anim`, delay: Math.random() * 600 });
        sprite.setDepth(type.flies ? FLYING_DEPTH : home.y - 6);
        wander(scene, sprite, type, home);
    }
}

/** Move to a random nearby spot, rest, repeat. */
function wander (scene: Scene, sprite: GameObjects.Sprite, type: CritterType, home: { x: number; y: number })
{
    const angle = Math.random() * Math.PI * 2;
    const dist = type.radius * Math.sqrt(Math.random());
    const x = home.x + Math.cos(angle) * dist;
    const y = home.y + Math.sin(angle) * dist * (type.horizontal ? 0.25 : type.flies ? 0.7 : 1);
    const travel = PMath.Distance.Between(sprite.x, sprite.y, x, y);

    if (Math.abs(x - sprite.x) > 0.5) sprite.setFlipX(x < sprite.x);
    if (!type.flies) sprite.anims.resume();

    scene.tweens.add({
        targets: sprite,
        x,
        y,
        duration: Math.max(300, (travel / type.speed) * 1000),
        ease: type.flies ? 'Sine.easeInOut' : 'Linear',
        onUpdate: () => { if (!type.flies) sprite.setDepth(sprite.y - 6); },
        onComplete: () =>
        {
            if (!sprite.active) return;
            if (!type.flies) sprite.anims.pause();
            scene.time.delayedCall(PMath.Between(...type.rest), () => { if (sprite.active) wander(scene, sprite, type, home); });
        },
    });
}

/** Now and then a leaf or petal drifts down across the view (kept to a handful at once). */
export function startLeafDrift (scene: Scene, maxActive = 5)
{
    let active = 0;
    scene.time.addEvent({
        delay: 1600,
        loop: true,
        callback: () =>
        {
            if (active >= maxActive) return;
            const view = scene.cameras.main.worldView;
            const leaf = scene.add.image(view.x + Math.random() * view.width, view.y - 4, Math.random() < 0.5 ? 'leaf' : 'petal')
                .setDepth(FLYING_DEPTH + 1)
                .setAlpha(0.9);
            active++;
            const duration = PMath.Between(4500, 7000);
            scene.tweens.add({
                targets: leaf,
                y: leaf.y + PMath.Between(70, 120),
                x: leaf.x + PMath.Between(20, 50),
                angle: PMath.Between(-120, 120),
                duration,
                ease: 'Sine.easeInOut',
            });
            scene.tweens.add({
                targets: leaf, alpha: 0, delay: duration * 0.6, duration: duration * 0.4,
                onComplete: () => { leaf.destroy(); active--; },
            });
        },
    });
}
