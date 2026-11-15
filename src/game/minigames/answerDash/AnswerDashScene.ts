// Answer Dash: a four-lane garden runner. The player auto-runs up a cream garden path; each
// question's answers ride on a row of floral gates. Whatever lane the player is in when the
// gates reach them is their answer (graded by the server). Launched over the paused world
// scene, so the village, NPC and player position are untouched; everything here is torn
// down when the scene stops.

import { GameObjects, Scene } from 'phaser';
import { createAnswerDashTextures, DASH, DASH_WIDTH } from '../../art/answerDashArt';
import { pixelZoom } from '../../display';
import type { DashAnswer, DashPack, DashResult } from '../../services/minigameApi';
import type { AnswerDashHud } from '../../ui/AnswerDashHud';
import { laneAt, laneKey, LANES, moveLane, pointsFor } from './dashLogic';

export interface DashHost
{
    pack: DashPack;
    hud: AnswerDashHud;
    answer (index: number, lane: number): Promise<DashAnswer>;
    finish (): Promise<DashResult>;
    /** Text for the results screen (study progress, reward). */
    describeResults (result: DashResult): { title: string; stats: [string, string][]; notes: string[] };
    exit (reason: 'npc' | 'again'): void;
}

type Phase = 'intro' | 'running' | 'waiting' | 'feedback' | 'finishing' | 'results';

const GATE_SECONDS = 8;
const SLOW = { factor: 0.55, ms: 2500 };
const DECOR = ['bush', 'bush-flower', 'flower-bed', 'sunflower', 'flowers-red', 'flowers-white'];
const FLYERS = ['butterfly-blue-anim', 'butterfly-pink-anim', 'butterfly-yellow-anim', 'bee-anim'];
const trackLeft = DASH.side;
const laneCenter = (lane: number) => trackLeft + DASH.lane * lane + DASH.lane / 2;

export class AnswerDash extends Scene
{
    private host!: DashHost;
    private phase: Phase = 'intro';
    private paused = false;
    private index = 0;
    private lane = 1;
    private score = 0;
    private streak = 0;
    private slowUntil = 0;
    private zoomLevel = 1;
    private viewW = 0;
    private viewH = 0;
    private playerY = 0;
    private gateY = 0;
    private nextDecorAt = 0;
    private continueTimer: Phaser.Time.TimerEvent | null = null;

    private grass!: GameObjects.TileSprite;
    private path!: GameObjects.TileSprite;
    private edges: GameObjects.TileSprite[] = [];
    private gates: GameObjects.Container | null = null;
    private player!: GameObjects.Sprite;
    private decor: { obj: GameObjects.Sprite | GameObjects.Image; drift: number }[] = [];

    constructor ()
    {
        super('AnswerDash');
    }

    init (data: { host: DashHost })
    {
        this.host = data.host;
        Object.assign(this, { phase: 'intro', paused: false, index: 0, lane: 1, score: 0, streak: 0, slowUntil: 0, nextDecorAt: 0, decor: [], gates: null, edges: [], continueTimer: null });
    }

    create ()
    {
        createAnswerDashTextures(this);
        this.cameras.main.setBackgroundColor('#a3d67c');
        this.grass = this.add.tileSprite(0, 0, 10, 10, 'dash-grass').setOrigin(0, 0).setDepth(0);
        this.path = this.add.tileSprite(trackLeft, 0, DASH.lane * LANES, 10, 'dash-path').setOrigin(0, 0).setDepth(1);
        this.edges = [trackLeft - 4, trackLeft + DASH.lane * LANES].map((x) => this.add.tileSprite(x, 0, 4, 10, 'dash-edge').setOrigin(0, 0).setDepth(2));
        this.player = this.add.sprite(laneCenter(this.lane), 0, 'player', 0).setOrigin(0.5, 1).setScale(2).setDepth(6);
        if (this.anims.exists('player-walk-up')) this.player.play('player-walk-up');
        this.player.anims.timeScale = 1.6;

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
            this.continueTimer?.remove();
        });

        const { hud } = this.host;
        hud.open({
            onLane: (lane) => this.setLane(lane),
            onMove: (step) => this.setLane(moveLane(this.lane, step)),
            onContinue: () => this.nextQuestion(),
            onPause: () => this.setPaused(!this.paused),
            onResume: () => this.setPaused(false),
            onExit: () => this.host.exit('npc'),
            onPlayAgain: () => this.host.exit('again'),
        });
        hud.setStats(0, 0);
        hud.select(this.lane);
        for (let i = 0; i < 10; i++) this.spawnDecor(Math.random() * this.viewH);
        this.showQuestion();
    }

    // ------------------------------------------------------------ layout + input

    private layout ()
    {
        const { width, height } = this.scale;
        this.zoomLevel = Math.max(1, Math.min(pixelZoom(width, height), Math.floor(width / DASH_WIDTH) || 1));
        const camera = this.cameras.main;
        camera.setZoom(this.zoomLevel);
        this.viewW = width / this.zoomLevel;
        this.viewH = height / this.zoomLevel;
        camera.centerOn(DASH_WIDTH / 2, this.viewH / 2);
        const left = DASH_WIDTH / 2 - this.viewW / 2;
        this.grass.setPosition(Math.floor(left) - 32, -32).setSize(Math.ceil(this.viewW) + 64, Math.ceil(this.viewH) + 64);
        this.path.setSize(DASH.lane * LANES, Math.ceil(this.viewH) + 32).setY(-16);
        this.edges.forEach((e) => e.setSize(4, Math.ceil(this.viewH) + 32).setY(-16));
        this.playerY = this.viewH - 26;
        this.player.setY(this.playerY);
    }

    private onKey (event: KeyboardEvent)
    {
        const key = event.key.toLowerCase();
        if (key === 'escape') return this.setPaused(!this.paused);
        if (this.paused) return;
        if ((key === ' ' || key === 'enter' || key === 'e') && this.phase === 'feedback') return this.nextQuestion();
        const move = laneKey(key);
        if (!move) return;
        event.preventDefault();
        this.setLane('step' in move ? moveLane(this.lane, move.step) : move.lane);
    }

    private onPointer (pointer: Phaser.Input.Pointer)
    {
        if (this.paused) return;
        const lane = laneAt(pointer.worldX, trackLeft, DASH.lane);
        if (lane !== null) this.setLane(lane);
        else this.setLane(moveLane(this.lane, pointer.worldX < trackLeft ? -1 : 1));
    }

    private onVisibility = () =>
    {
        if (document.hidden && !this.paused && this.phase !== 'results') this.setPaused(true);
    };

    private setLane (lane: number)
    {
        if (this.paused || this.phase === 'finishing' || this.phase === 'results' || lane === this.lane) return;
        this.lane = lane;
        this.host.hud.select(lane);
        this.tweens.killTweensOf(this.player);
        this.tweens.add({ targets: this.player, x: laneCenter(lane), duration: 110, ease: 'Sine.easeOut' });
    }

    private setPaused (paused: boolean)
    {
        if (this.phase === 'results' || this.phase === 'finishing') return;
        this.paused = paused;
        this.host.hud.setPaused(paused);
        if (paused) { this.tweens.pauseAll(); this.anims.pauseAll(); this.continueTimer && (this.continueTimer.paused = true); }
        else { this.tweens.resumeAll(); this.anims.resumeAll(); this.continueTimer && (this.continueTimer.paused = false); }
    }

    // ------------------------------------------------------------ questions

    private showQuestion ()
    {
        const { pack, hud } = this.host;
        const q = pack.questions[this.index];
        hud.setQuestion(q.question, this.index, pack.questions.length, q.topic, q.source?.title ?? null, q.figure ?? null);
        hud.setChoices(q.choices);
        hud.hideFeedback();
        hud.setStatus('');
        this.gates?.destroy();
        this.gates = this.add.container(0, 0, Array.from({ length: LANES }, (_, i) =>
            this.add.image(trackLeft + DASH.lane * i, 0, 'dash-gate').setOrigin(0, 1))).setDepth(5);
        this.gateY = -10;
        this.phase = this.index === 0 ? 'intro' : 'running';
        if (this.phase === 'intro') this.time.delayedCall(900, () => { if (this.phase === 'intro') this.phase = 'running'; });
    }

    private async resolve ()
    {
        this.phase = 'waiting';
        const lane = this.lane;
        const index = this.index;
        const q = this.host.pack.questions[index];
        this.host.hud.setStatus('Checking…');
        let result: DashAnswer;
        try
        {
            result = await this.host.answer(index, lane);
        }
        catch (err)
        {
            if (!this.sys.isActive() && !this.sys.isPaused()) return;
            this.host.hud.setStatus(`${err instanceof Error ? err.message : 'Could not check the answer.'}`, () => void this.resolve());
            return;
        }
        if (!this.scene.isActive() && !this.sys.isPaused()) return;
        this.host.hud.setStatus('');
        const points = result.correct ? pointsFor(this.streak) : 0;
        if (result.correct)
        {
            this.score += points;
            this.streak++;
            this.burst(laneCenter(result.choice), this.playerY - 18);
        }
        else
        {
            this.streak = 0;
            this.slowUntil = this.time.now + SLOW.ms;
            this.cameras.main.shake(140, 0.004);
            this.tweens.add({ targets: this.player, alpha: 0.4, duration: 120, yoyo: true, repeat: 2 });
        }
        this.host.hud.setStats(this.score, this.streak);
        this.host.hud.showFeedback({ correct: result.correct, points, correctText: q.choices[result.correctIndex], explanation: result.explanation }, result.choice, result.correctIndex);
        this.phase = 'feedback';
        this.continueTimer = this.time.delayedCall(9000, () => this.nextQuestion());
    }

    private nextQuestion ()
    {
        if (this.phase !== 'feedback' || this.paused) return;
        this.continueTimer?.remove();
        this.continueTimer = null;
        this.index++;
        if (this.index < this.host.pack.questions.length) return this.showQuestion();
        void this.finish();
    }

    private async finish ()
    {
        this.phase = 'finishing';
        this.host.hud.hideFeedback();
        this.host.hud.setStatus('Saving your results…');
        try
        {
            const result = await this.host.finish();
            if (!this.scene.isActive()) return;
            this.phase = 'results';
            this.host.hud.setStatus('');
            this.host.hud.showResults(this.host.describeResults(result));
        }
        catch (err)
        {
            if (!this.scene.isActive()) return;
            this.phase = 'feedback'; // allow retry via the status button
            this.index--;
            this.host.hud.setStatus(`${err instanceof Error ? err.message : 'Could not save the results.'}`, () => { this.index++; void this.finish(); });
        }
    }

    // ------------------------------------------------------------ world

    update (time: number, delta: number)
    {
        if (this.paused) return;
        const slow = time < this.slowUntil ? SLOW.factor : 1;
        const travel = this.playerY + 10;
        const speed = (travel / GATE_SECONDS) * slow * (this.phase === 'finishing' || this.phase === 'results' ? 0.4 : 1);
        const dy = speed * (delta / 1000);

        this.grass.tilePositionY -= dy;
        this.path.tilePositionY -= dy;
        this.edges.forEach((e) => { e.tilePositionY -= dy; });

        for (const item of this.decor)
        {
            item.obj.y += dy + item.drift * (delta / 1000);
            item.obj.x += Math.sin((time + item.obj.y * 20) / 400) * item.drift * 0.004 * delta;
        }
        this.decor = this.decor.filter(({ obj }) => (obj.y < this.viewH + 40 ? true : (obj.destroy(), false)));
        if (time >= this.nextDecorAt)
        {
            this.spawnDecor(-20);
            this.nextDecorAt = time + 420 / slow;
        }

        if (this.gates && this.phase !== 'intro')
        {
            this.gateY += dy;
            this.gates.setY(this.gateY);
            if (this.phase === 'running' && this.gateY >= this.playerY - 4) void this.resolve();
            if (this.gateY > this.viewH + 40) { this.gates.destroy(); this.gates = null; }
        }
        this.placeLabels();
    }

    private placeLabels ()
    {
        // World -> CSS pixels via the camera's real view (as WorldScene.worldToCss does).
        // Measured on screen (canvas rect vs. overlay rect), so CSS scaling of either never skews it.
        const camera = this.cameras.main;
        const canvasRect = this.game.canvas.getBoundingClientRect();
        const overlayRect = this.host.hud.rect();
        const cssX = (canvasRect.width / this.game.canvas.width) * camera.zoom;
        const cssY = (canvasRect.height / this.game.canvas.height) * camera.zoom;
        const view = camera.worldView;
        const ox = canvasRect.left - overlayRect.left;
        const oy = canvasRect.top - overlayRect.top;
        const visible = Boolean(this.gates) && (this.phase === 'intro' || this.phase === 'running' || this.phase === 'waiting' || this.phase === 'feedback');
        // Label bottom sits just above the flowers on top of the gate (gate is 30 px tall).
        const y = oy + (Math.min(this.gateY, this.playerY) - 31 - view.y) * cssY;
        this.host.hud.placeLanes(Array.from({ length: LANES }, (_, i) => ox + (laneCenter(i) - view.x) * cssX), (DASH.lane - 3) * cssX, y, visible);
    }

    private spawnDecor (y: number)
    {
        const leftSide = Math.random() < 0.5;
        const x = leftSide ? trackLeft - 10 - Math.random() * (DASH.side - 18) : trackLeft + DASH.lane * LANES + 10 + Math.random() * (DASH.side - 18);
        if (Math.random() < 0.18)
        {
            const anim = FLYERS.filter((key) => this.anims.exists(key))[Math.floor(Math.random() * FLYERS.length)];
            if (anim)
            {
                const flyer = this.add.sprite(x, y, '__DEFAULT').setDepth(7).play(anim);
                this.decor.push({ obj: flyer, drift: 6 + Math.random() * 10 });
                return;
            }
        }
        const keys = DECOR.filter((key) => this.textures.exists(key));
        if (!keys.length) return;
        const key = keys[Math.floor(Math.random() * keys.length)];
        const obj = this.anims.exists(`${key}-anim`) ? this.add.sprite(x, y, key).play(`${key}-anim`) : this.add.image(x, y, key);
        obj.setOrigin(0.5, 1).setDepth(3);
        if (Math.random() < 0.15 && this.anims.exists('ladybug-anim'))
        {
            this.decor.push({ obj: this.add.sprite(x + 6, y + 2, 'ladybug').setDepth(4).play('ladybug-anim'), drift: 0 });
        }
        this.decor.push({ obj, drift: 0 });
    }

    private burst (x: number, y: number)
    {
        for (let i = 0; i < 14; i++)
        {
            const key = i % 3 === 0 && this.textures.exists('petal') ? 'petal' : 'dash-sparkle';
            const bit = this.add.image(x, y, key).setDepth(8);
            const angle = (Math.PI * 2 * i) / 14;
            this.tweens.add({
                targets: bit, x: x + Math.cos(angle) * (14 + Math.random() * 10), y: y + Math.sin(angle) * (12 + Math.random() * 8) - 6,
                alpha: 0, duration: 520, ease: 'Quad.easeOut', onComplete: () => bit.destroy(),
            });
        }
    }
}
