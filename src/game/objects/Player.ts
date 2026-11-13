// The controllable character. Uses the 'player' spritesheet (see art/textures.ts);
// replace that texture with a real 16x16 spritesheet using the same frame order to re-skin.

import { Input, Physics, Scene, Types } from 'phaser';
import { PLAYER_SPEED } from '../config';

type Facing = 'down' | 'up' | 'left' | 'right';

/** Spritesheet row per facing (each row = standing frame, stepping frame). Left mirrors 'side'. */
const ANIM: Record<Facing, { name: string; row: number }> = {
    down: { name: 'player-walk-down', row: 0 },
    up: { name: 'player-walk-up', row: 1 },
    left: { name: 'player-walk-side', row: 2 },
    right: { name: 'player-walk-side', row: 2 },
};

export class Player extends Physics.Arcade.Sprite
{
    private cursors: Types.Input.Keyboard.CursorKeys;
    private wasd: Record<'W' | 'A' | 'S' | 'D', Input.Keyboard.Key>;
    private facing: Facing = 'down';

    /** Registers the walk animations. Call once after the 'player' texture exists. */
    static createAnimations (scene: Scene)
    {
        for (const { name, row } of [ANIM.down, ANIM.up, ANIM.right])
        {
            scene.anims.create({
                key: name,
                frames: [{ key: 'player', frame: row * 2 + 1 }, { key: 'player', frame: row * 2 }],
                frameRate: 6,
                repeat: -1,
            });
        }
    }

    constructor (scene: Scene, x: number, y: number)
    {
        super(scene, x, y, 'player', 0);
        scene.add.existing(this);
        scene.physics.add.existing(this);

        // COLLISION BOX: feet only, so the head can overlap things drawn behind it.
        // (sized for the 24px CHARACTER_SIZE sprite: 12x7 at the bottom centre)
        this.setBodySize(12, 7, false).setOffset(6, 17);
        this.setCollideWorldBounds(true);

        const keyboard = scene.input.keyboard!;
        this.cursors = keyboard.createCursorKeys();
        this.wasd = keyboard.addKeys('W,A,S,D') as Player['wasd'];
    }

    update ()
    {
        const { cursors, wasd } = this;
        const dx = Number(cursors.right.isDown || wasd.D.isDown) - Number(cursors.left.isDown || wasd.A.isDown);
        const dy = Number(cursors.down.isDown || wasd.S.isDown) - Number(cursors.up.isDown || wasd.W.isDown);

        if (dx || dy)
        {
            // Normalise so diagonal movement isn't faster.
            const len = Math.hypot(dx, dy);
            this.setVelocity((dx / len) * PLAYER_SPEED, (dy / len) * PLAYER_SPEED);
            this.facing = dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'up' : 'down';
            this.setFlipX(this.facing === 'left');
            this.anims.play(ANIM[this.facing].name, true);
        }
        else
        {
            this.halt();
        }

        // Y-sort against world objects (same rule as world/objectTypes.ts).
        this.setDepth(this.y + this.height / 2);
    }

    /** Stop moving and stand still (used while dialogue / mini-games are open). */
    halt ()
    {
        this.setVelocity(0, 0);
        this.anims.stop();
        this.setFrame(ANIM[this.facing].row * 2);
    }

    /** Turn toward an angle (radians), e.g. where the player attacks. Movement may turn them back. */
    faceAngle (angle: number)
    {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        this.facing = Math.abs(cos) >= Math.abs(sin) ? (cos < 0 ? 'left' : 'right') : (sin < 0 ? 'up' : 'down');
        this.setFlipX(this.facing === 'left');
        if (!this.anims.isPlaying) this.setFrame(ANIM[this.facing].row * 2);
    }

    /** Body centre in world pixels (the sprite origin is its centre; feet are lower). */
    get center ()
    {
        return { x: this.x, y: this.y + 2 };
    }
}
