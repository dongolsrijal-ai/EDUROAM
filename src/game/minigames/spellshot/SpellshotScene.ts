// Spellshot: a 60-second spell drill in a garden clearing. A prompt from the class coursework
// shows at the top; its answers float past on spirit wisps. The student clicks / taps a wisp
// (or presses its number) to cast a bolt from their staff. The FIRST shot per prompt is
// graded by the server: right => the wisp bursts and the combo grows; wrong => a small
// penalty and the right wisp glows gold. Then the next prompt's wisps appear. Wisps speed
// up with the combo and as the clock runs down. The round ends at 0:00 (or when every prompt
// is answered). Launched over the paused world scene; everything is torn down on stop.

import { GameObjects, Scene } from 'phaser';
import { createSpellshotTextures, MAGIC_TINT } from '../../art/spellshotArt';
import { pixelZoom } from '../../display';
import type { DashAnswer, DashPack, DashResult, SpellshotSpeed } from '../../services/minigameApi';
import type { ShotReviewItem, SpellshotHud } from '../../ui/SpellshotHud';
import { afterMiss, bandCenters, clock, pointsFor, ROUND_MS, speedFor, targetKey, wrapX } from './spellshotLogic';

export interface ShotHost
{
    pack: DashPack;
    hud: SpellshotHud;
    speed: SpellshotSpeed;
    answer (index: number, choice: number): Promise<DashAnswer>;
    finish (): Promise<DashResult>;
    describeResults (result: DashResult): { title: string; stats: [string, string][]; notes: string[] };
    exit (reason: 'npc' | 'again'): void;
}

type Phase = 'intro' | 'aiming' | 'casting' | 'feedback' | 'finishing' | 'results';

interface Wisp
{
    sprite: GameObjects.Image;
    x: number;
    dir: 1 | -1;
    bob: number;
    alive: boolean;
    frozen: boolean;
}

const LABEL_CSS = { max: 190, min: 110, viewportShare: 0.42 };
const FLYERS = ['butterfly-blue-anim', 'butterfly-pink-anim', 'butterfly-yellow-anim'];
const DECOR = ['flower-bed', 'bush-flower', 'flowers-red', 'flowers-white', 'sunflower', 'bush', 'shot-mushroom', 'shot-mushroom-lav'];
const STAFF_LENGTH = 28;
/** Labels hang just below their wisp (world px), so the glowing orb stays visible above. */
const LABEL_DROP = 15;

export class Spellshot extends Scene
{
    private host!: ShotHost;
    private phase: Phase = 'intro';
    private paused = false;
    private index = 0;
    private score = 0;
    private streak = 0;
    private remaining = ROUND_MS;
    private elapsed = 0;
    private review: ShotReviewItem[] = [];
    private wisps: Wisp[] = [];
    private nextTimer: Phaser.Time.TimerEvent | null = null;

    private zoomLevel = 1;
    private viewW = 0;
    private viewH = 0;
    private cssPerWorld = 1;
    private fieldTop = 40;
    private fieldBottom = 200;
    private labelHalfW = 30;

    private grass!: GameObjects.TileSprite;
    private caster!: GameObjects.Sprite;
    private staff!: GameObjects.Image;
    private rune!: GameObjects.Image;
    private decor: GameObjects.GameObject[] = [];

    constructor ()
    {
        super('Spellshot');
    }

    init (data: { host: ShotHost })
    {
        this.host = data.host;
        Object.assign(this, {
            phase: 'intro', paused: false, index: 0, score: 0, streak: 0, remaining: ROUND_MS, elapsed: 0,
            review: [], wisps: [], nextTimer: null, decor: [],
        });
    }

    create ()
    {
        createSpellshotTextures(this);
        this.cameras.main.setBackgroundColor('#a3d67c');
        this.grass = this.add.tileSprite(0, 0, 10, 10, 'dash-grass').setOrigin(0, 0).setDepth(0);
        this.rune = this.add.image(0, 0, 'shot-rune').setDepth(4).setAlpha(0.85);
        this.caster = this.add.sprite(0, 0, 'player', 0).setOrigin(0.5, 1).setScale(2).setDepth(5);
        if (this.anims.exists('player-walk-up')) { this.caster.play('player-walk-up'); this.caster.anims.stop(); }
        this.staff = this.add.image(0, 0, 'shot-staff').setOrigin(0.5, 0.95).setDepth(6);
        this.tweens.add({ targets: this.rune, alpha: 0.45, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

        this.layout();
        this.scale.on('resize', this.layout, this);
        document.addEventListener('visibilitychange', this.onVisibility);
        this.input.keyboard?.on('keydown', this.onKey, this);
        this.input.on('pointerdown', this.onPointer, this);
        this.events.once('shutdown', () =>
        {
            this.scale.off('resize', this.layout, this);
            document.removeEventListener('visibilitychange', this.onVisibility);
            this.input.keyboard?.off('keydown', this.onKey, this);
            this.input.off('pointerdown', this.onPointer, this);
            this.nextTimer?.remove();
            this.time.paused = false;
        });

        const { hud } = this.host;
        hud.open({
            onShoot: (target) => this.shoot(target),
            onPause: () => this.setPaused(!this.paused),
            onResume: () => this.setPaused(false),
            onExit: () => this.host.exit('npc'),
            onPlayAgain: () => this.host.exit('again'),
        });
        hud.setStats(0, 0);
        hud.setClock(this.remaining, ROUND_MS, clock(this.remaining));
        this.showPrompt();
        hud.showBanner('Ready…');
        this.time.delayedCall(800, () => hud.showBanner('Cast!', 'good'));
        this.time.delayedCall(1200, () =>
        {
            if (this.phase !== 'intro') return;
            hud.showBanner('');
            this.phase = 'aiming';
        });
    }

    // ------------------------------------------------------------ layout + input

    private layout ()
    {
        const { width, height } = this.scale;
        this.zoomLevel = pixelZoom(width, height);
        const camera = this.cameras.main;
        camera.setZoom(this.zoomLevel);
        this.viewW = width / this.zoomLevel;
        this.viewH = height / this.zoomLevel;
        camera.centerOn(this.viewW / 2, this.viewH / 2);
        this.grass.setPosition(-32, -32).setSize(Math.ceil(this.viewW) + 64, Math.ceil(this.viewH) + 64);

        const casterY = this.viewH - 10;
        this.caster.setPosition(Math.round(this.viewW / 2), casterY);
        this.rune.setPosition(Math.round(this.viewW / 2), casterY - 2);
        this.staff.setPosition(Math.round(this.viewW / 2) + 10, casterY - 8);
        this.fieldBottom = casterY - 66;
        this.measureField();
        this.placeDecor();
    }

    /** Converts the HUD card + label size (CSS) into world units for the flight bands. */
    private measureField ()
    {
        const canvasRect = this.game.canvas.getBoundingClientRect();
        this.cssPerWorld = (canvasRect.width / this.game.canvas.width) * this.zoomLevel || 1;
        const labelW = Math.max(LABEL_CSS.min, Math.min(LABEL_CSS.max, canvasRect.width * LABEL_CSS.viewportShare));
        this.labelHalfW = labelW / 2 / this.cssPerWorld;
        const overlayTop = this.host.hud.rect().top;
        const cardBottom = this.host.hud.cardBottom() + (overlayTop - canvasRect.top);
        this.fieldTop = Math.min(this.fieldBottom - 30, cardBottom / this.cssPerWorld + 20);
    }

    /** Flowers, mushrooms and bushes around the clearing's edge; butterflies drift over it. */
    private placeDecor ()
    {
        this.decor.forEach((d) => d.destroy());
        this.decor = [];
        const keys = DECOR.filter((key) => this.textures.exists(key));
        const spots: [number, number][] = [];
        for (let x = 8; x < this.viewW; x += 22 + Math.random() * 18) spots.push([x, this.viewH - 2 - Math.random() * 8]);
        for (let y = this.fieldTop; y < this.viewH - 30; y += 26 + Math.random() * 20)
        {
            spots.push([6 + Math.random() * 10, y], [this.viewW - 6 - Math.random() * 10, y]);
        }
        for (const [x, y] of spots)
        {
            if (Math.abs(x - this.viewW / 2) < 34 && y > this.viewH - 30) continue; // keep the caster clear
            const key = keys[Math.floor(Math.random() * keys.length)];
            if (!key) break;
            const obj = this.anims.exists(`${key}-anim`) ? this.add.sprite(x, y, key).play(`${key}-anim`) : this.add.image(x, y, key);
            this.decor.push(obj.setOrigin(0.5, 1).setDepth(2));
        }
        const flyers = FLYERS.filter((key) => this.anims.exists(key));
        for (let i = 0; i < 3 && flyers.length; i++)
        {
            const fly = this.add.sprite(Math.random() * this.viewW, this.fieldTop + Math.random() * (this.viewH - this.fieldTop), '__DEFAULT')
                .setDepth(3).play(flyers[i % flyers.length]);
            this.tweens.add({
                targets: fly, x: Math.random() * this.viewW, y: this.fieldTop + Math.random() * (this.viewH - this.fieldTop - 20),
                duration: 5000 + Math.random() * 4000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
            });
            this.decor.push(fly);
        }
    }

    private onKey (event: KeyboardEvent)
    {
        const key = event.key.toLowerCase();
        if (key === 'escape') return this.setPaused(!this.paused);
        const target = targetKey(key, this.wisps.length);
        if (target === null) return;
        event.preventDefault();
        this.shoot(target);
    }

    /** Clicks on the canvas hit the nearest wisp under the pointer (labels are buttons too). */
    private onPointer (pointer: Phaser.Input.Pointer)
    {
        let best = -1;
        let bestDist = 22;
        this.wisps.forEach((w, i) =>
        {
            const d = Math.hypot(pointer.worldX - w.sprite.x, pointer.worldY - w.sprite.y);
            if (w.alive && d < bestDist) { best = i; bestDist = d; }
        });
        if (best >= 0) this.shoot(best);
    }

    private onVisibility = () =>
    {
        if (document.hidden && !this.paused) this.setPaused(true);
    };

    private setPaused (paused: boolean)
    {
        if (this.phase === 'results' || this.phase === 'finishing' || paused === this.paused) return;
        this.paused = paused;
        this.host.hud.setPaused(paused);
        this.time.paused = paused;
        if (paused) { this.tweens.pauseAll(); this.anims.pauseAll(); }
        else { this.tweens.resumeAll(); this.anims.resumeAll(); }
    }

    // ------------------------------------------------------------ prompts + shots

    private showPrompt ()
    {
        const { pack, hud } = this.host;
        const q = pack.questions[this.index];
        hud.setPrompt(q.question, this.index, pack.questions.length, q.topic, q.source?.title ?? null);
        hud.setTargets(q.choices);
        this.wisps.forEach((w) => w.sprite.destroy());
        const offset = Math.random();
        const firstDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
        const bands = bandCenters(this.fieldTop, this.fieldBottom, q.choices.length);
        this.wisps = q.choices.map((_, i) =>
        {
            const x = this.viewW * (0.22 + 0.56 * ((offset + i * 0.38) % 1));
            const sprite = this.add.image(x, bands[i], 'shot-wisp').setDepth(7).setScale(0);
            this.tweens.add({ targets: sprite, scale: 1, duration: 200, delay: i * 40, ease: 'Back.easeOut' });
            return { sprite, x, dir: (i % 2 ? -firstDir : firstDir) as 1 | -1, bob: Math.random() * Math.PI * 2, alive: true, frozen: false };
        });
        if (this.phase !== 'intro') this.phase = 'aiming';
    }

    private shoot (target: number)
    {
        const wisp = this.wisps[target];
        if (this.phase !== 'aiming' || this.paused || !wisp?.alive) return;
        this.phase = 'casting';
        this.host.hud.lockTargets();
        wisp.frozen = true;

        // Aim the staff and fire a bolt from its crystal to the (now held) wisp.
        const dx = wisp.sprite.x - this.staff.x;
        const dy = wisp.sprite.y - this.staff.y;
        const rotation = Math.max(-1.2, Math.min(1.2, Math.atan2(dy, dx) + Math.PI / 2));
        this.tweens.killTweensOf(this.staff);
        this.staff.setRotation(rotation);
        this.tweens.add({ targets: this.staff, rotation: 0, duration: 380, delay: 160, ease: 'Sine.easeOut' });
        this.caster.setTint(MAGIC_TINT.gold);
        this.time.delayedCall(90, () => this.caster.clearTint());
        const tipX = this.staff.x + Math.sin(rotation) * STAFF_LENGTH;
        const tipY = this.staff.y - Math.cos(rotation) * STAFF_LENGTH;
        const bolt = this.add.image(tipX, tipY, 'shot-bolt').setDepth(8).setRotation(Math.atan2(wisp.sprite.y - tipY, wisp.sprite.x - tipX));
        const flight = Math.min(260, 90 + Math.hypot(wisp.sprite.x - tipX, wisp.sprite.y - tipY) * 0.9);
        const arrived = new Promise<void>((resolve) => this.tweens.add({
            targets: bolt, x: wisp.sprite.x, y: wisp.sprite.y, duration: flight, ease: 'Quad.easeIn',
            onComplete: () => { bolt.destroy(); resolve(); },
        }));
        this.tweens.add({ targets: wisp.sprite, scale: 1.12, duration: 120, yoyo: true, repeat: -1 });
        void this.resolveShot(target, arrived);
    }

    /** Waits for the bolt and the server's grade (retryable; the first answer is kept). */
    private async resolveShot (target: number, arrived: Promise<void>)
    {
        const index = this.index;
        let result: DashAnswer;
        try
        {
            [result] = await Promise.all([this.host.answer(index, target), arrived]);
        }
        catch (err)
        {
            if (!this.sys.isActive() && !this.sys.isPaused()) return;
            this.host.hud.setStatus(`${err instanceof Error ? err.message : 'Could not check that shot.'}`, () =>
            {
                this.host.hud.setStatus('Checking…');
                void this.resolveShot(target, Promise.resolve());
            });
            return;
        }
        if (!this.sys.isActive() && !this.sys.isPaused()) return;
        this.host.hud.setStatus('');
        const q = this.host.pack.questions[index];
        const hit = this.wisps[result.choice] ?? this.wisps[target];
        this.tweens.killTweensOf(hit.sprite);
        this.host.hud.markShot(result.choice, result.correctIndex);
        this.phase = 'feedback';
        if (result.correct)
        {
            const points = pointsFor(this.streak);
            this.score += points;
            this.streak++;
            this.explode(hit);
            this.wisps.forEach((w) => { if (w !== hit) this.vanish(w); });
            this.host.hud.showBanner(this.streak > 1 ? `+${points}  Combo ×${this.streak}!` : `+${points}`, 'good');
            this.queueNext(420);
        }
        else
        {
            this.score = afterMiss(this.score);
            this.streak = 0;
            this.fizzle(hit);
            const right = this.wisps[result.correctIndex];
            if (right) this.reveal(right);
            this.cameras.main.shake(140, 0.004);
            const answer = q.choices[result.correctIndex] ?? '';
            this.review.push({ prompt: q.question, answer, explanation: result.explanation });
            this.host.hud.showBanner(`−40 · Answer: ${answer}`, 'bad');
            this.queueNext(1200);
        }
        this.host.hud.setStats(this.score, this.streak);
    }

    private queueNext (ms: number)
    {
        this.nextTimer?.remove();
        this.nextTimer = this.time.delayedCall(ms, () =>
        {
            this.nextTimer = null;
            if (this.phase !== 'feedback') return;
            this.host.hud.showBanner('');
            this.index++;
            if (this.index >= this.host.pack.questions.length) return void this.finish('cleared');
            this.showPrompt();
        });
    }

    private async finish (reason: 'time' | 'cleared')
    {
        if (this.phase === 'finishing' || this.phase === 'results') return;
        this.phase = 'finishing';
        this.nextTimer?.remove();
        this.nextTimer = null;
        this.host.hud.lockTargets();
        this.host.hud.showBanner(reason === 'time' ? "Time's up!" : 'Every prompt answered!', 'info');
        this.wisps.forEach((w) => this.vanish(w));
        await this.saveResults();
    }

    private async saveResults ()
    {
        this.host.hud.setStatus('Saving your results…');
        try
        {
            const result = await this.host.finish();
            if (!this.scene.isActive()) return;
            this.phase = 'results';
            this.host.hud.setStatus('');
            this.host.hud.showResults(this.host.describeResults(result), this.review);
        }
        catch (err)
        {
            if (!this.scene.isActive()) return;
            this.host.hud.setStatus(`${err instanceof Error ? err.message : 'Could not save the results.'}`, () => void this.saveResults());
        }
    }

    // ------------------------------------------------------------ frame

    update (time: number, delta: number)
    {
        if (this.paused) return;
        if (this.phase === 'aiming' || this.phase === 'feedback')
        {
            this.remaining = Math.max(0, this.remaining - delta);
            this.elapsed += delta;
            this.host.hud.setClock(this.remaining, ROUND_MS, clock(this.remaining));
            if (this.remaining <= 0) void this.finish('time');
        }

        this.measureField();
        const bands = bandCenters(this.fieldTop, this.fieldBottom, Math.max(1, this.wisps.length));
        const speed = speedFor(this.host.speed, this.streak, this.elapsed) * (delta / 1000);
        this.wisps.forEach((w, i) =>
        {
            if (!w.alive) return;
            if (!w.frozen && this.phase !== 'finishing' && this.phase !== 'results')
            {
                w.x = wrapX(w.x + w.dir * speed, this.viewW, this.labelHalfW);
            }
            w.sprite.setPosition(w.x, bands[i] + Math.sin(time / 520 + w.bob) * 3);
        });
        this.placeLabels();
    }

    private placeLabels ()
    {
        // World -> CSS pixels via the camera's real view (as AnswerDash does).
        const camera = this.cameras.main;
        const canvasRect = this.game.canvas.getBoundingClientRect();
        const overlayRect = this.host.hud.rect();
        const scale = (canvasRect.width / this.game.canvas.width) * camera.zoom;
        const view = camera.worldView;
        const ox = canvasRect.left - overlayRect.left;
        const oy = canvasRect.top - overlayRect.top;
        const live = this.phase !== 'finishing' && this.phase !== 'results';
        this.host.hud.placeTargets(this.wisps.map((w) => ({
            x: ox + (w.sprite.x - view.x) * scale,
            y: oy + (w.sprite.y + LABEL_DROP - view.y) * scale,
            visible: live && (w.alive || w.frozen),
        })), this.labelHalfW * 2 * scale);
    }

    // ------------------------------------------------------------ effects

    /** Correct: the wisp bursts into gold + violet pixels with a shockwave ring. */
    private explode (wisp: Wisp)
    {
        wisp.alive = false;
        const { x, y } = wisp.sprite;
        this.tweens.add({ targets: wisp.sprite, scale: 1.6, alpha: 0, duration: 180, onComplete: () => wisp.sprite.setVisible(false) });
        const ring = this.add.image(x, y, 'shot-ring').setDepth(9).setScale(0.3);
        this.tweens.add({ targets: ring, scale: 1.8, alpha: 0, duration: 420, ease: 'Quad.easeOut', onComplete: () => ring.destroy() });
        for (let i = 0; i < 20; i++)
        {
            const key = i % 5 === 0 && this.textures.exists('petal') ? 'petal' : i % 2 ? 'shot-spark-violet' : 'shot-spark-gold';
            const bit = this.add.image(x, y, key).setDepth(9);
            const angle = (Math.PI * 2 * i) / 20 + Math.random() * 0.3;
            const dist = 16 + Math.random() * 16;
            this.tweens.add({
                targets: bit, x: x + Math.cos(angle) * dist, y: y + Math.sin(angle) * dist + 4, alpha: 0,
                duration: 480 + Math.random() * 200, ease: 'Quad.easeOut', onComplete: () => bit.destroy(),
            });
        }
    }

    /** Wrong: the wisp greys out and sinks away in a puff. */
    private fizzle (wisp: Wisp)
    {
        wisp.alive = false;
        wisp.frozen = true;
        const { x, y } = wisp.sprite;
        wisp.sprite.setTint(MAGIC_TINT.ash).setScale(1);
        this.tweens.add({ targets: wisp.sprite, y: y + 10, alpha: 0, duration: 600, ease: 'Quad.easeIn' });
        for (let i = 0; i < 6; i++)
        {
            const puff = this.add.image(x + (Math.random() - 0.5) * 16, y + (Math.random() - 0.5) * 10, 'shot-puff').setDepth(9);
            this.tweens.add({ targets: puff, y: puff.y - 8, alpha: 0, duration: 500, onComplete: () => puff.destroy() });
        }
    }

    /** After a miss, the right wisp stops and glows gold so the answer is learned. */
    private reveal (wisp: Wisp)
    {
        wisp.frozen = true;
        wisp.sprite.setTint(MAGIC_TINT.gold);
        this.tweens.add({ targets: wisp.sprite, scale: 1.2, duration: 220, yoyo: true, repeat: 2 });
    }

    /** Other wisps of a solved prompt fade out. */
    private vanish (wisp: Wisp)
    {
        if (!wisp.alive) return;
        wisp.alive = false;
        this.tweens.add({ targets: wisp.sprite, scale: 0, alpha: 0, duration: 200, ease: 'Back.easeIn' });
    }
}
