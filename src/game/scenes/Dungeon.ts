// TOWER FLOOR: one procedural floor of the current tower run (see world/dungeon/generate.ts).
//   - Combat rooms lock their doors when you step in, spawn seeded waves (telegraphed), and
//     unlock once every wave is defeated (remembered in dungeonRun.clearedRooms).
//   - Treasure rooms hold a tier-scaled chest; shrines heal once per floor.
//   - Non-final floors end in a portal to the next floor; the final floor ends with Hades,
//     the final chest and the portal home (run complete -> tower level up).

import { GameObjects, Tilemaps } from 'phaser';
import { TILE } from '../config';
import { SOLID_DUNGEON } from '../art/textures';
import type { Enemy } from '../combat/Enemy';
import type { EnemyTypeId } from '../combat/enemyTypes';
import type { Hades } from '../combat/Hades';
import { itemIconUrl } from '../items/icons';
import { itemDef } from '../items/itemDefs';
import { chestReward } from '../items/lootTables';
import { player as playerState } from '../state/playerState';
import { dungeonRun } from '../state/dungeonRun';
import { pomodoro } from '../state/pomodoro';
import { tower } from '../state/tower';
import { getUi } from '../ui';
import { BIOMES, isBiomeId, type BiomeDef } from '../world/dungeon/biomes';
import { buildDungeon, type BuiltRoom, type Marker } from '../world/dungeon/build';
import { rollRoomWaves } from '../world/dungeon/encounters';
import { floorSeed, planFloor } from '../world/dungeon/generate';
import { beginTowerRun, chestIdForMarker, TOWER_RUN } from '../world/dungeon/runOptions';
import type { Rect } from '../world/objectTypes';
import { WorldScene, type WorldLayout } from './WorldScene';

export const DUNGEON_MESSAGES = {
    sealed: 'The way back is sealed. Reach the top of the tower to escape.',
    guardianDefeated: 'Hades has fallen! Open the final chest.',
    treasureClaimed: 'Treasure claimed! The portal home has opened.',
    chestLocked: 'Hades guards this chest. Defeat him first!',
    portalLocked: 'The portal is dormant. Clear every combat room first.',
    rewardNotSaved: 'Your reward could not be saved (browser storage is full or blocked). Nothing was lost: press E to try again.',
    rewardAlreadyCollected: 'You already collected this reward.',
};

const SHRINE_HEAL = 30;
const SPAWN_TELEGRAPH_MS = 650;
const BOSS_INTRO_MS = 1900;

interface Point { x: number; y: number }

interface RoomState
{
    room: BuiltRoom;
    /** Enemy spawn points (feet, world px). */
    slots: Point[];
    waves: EnemyTypeId[][];
    wave: number;
    /** Wave enemies still alive (summons are not tracked: they crumble with their summoner). */
    alive: Set<Enemy>;
    /** Enemies announced by a telegraph but not spawned yet. */
    incoming: number;
    locked: boolean;
    gates: GameObjects.GameObject[];
}

export class Dungeon extends WorldScene
{
    readonly mapId = 'dungeon';
    title = 'Tower';
    protected readonly dark = true;
    protected readonly combatEnabled = true;

    private biome: BiomeDef = BIOMES.crypt;
    private rooms: RoomState[] = [];
    private doorways: Rect[] = [];
    private portal: GameObjects.Image | null = null;
    private bossSpawn: Point | null = null;
    private bossRoom: RoomState | null = null;
    private boss: Hades | null = null;
    private bossShownHp = -1;
    private isFinal = false;

    constructor ()
    {
        super('Dungeon');
    }

    protected isProtectedArea (area: Rect)
    {
        return this.doorways.some((d) => area.x < d.x + d.w && area.x + area.w > d.x && area.y < d.y + d.h && area.y + area.h > d.y);
    }

    // ------------------------------------------------------------ build

    protected buildWorld (): WorldLayout
    {
        // Normally the Hub started the run; a refresh (or an old single-floor save) lands here directly.
        if (!dungeonRun.state.active) beginTowerRun();
        else dungeonRun.start(dungeonRun.state.floorId);

        const run = dungeonRun.state;
        this.biome = BIOMES[isBiomeId(run.biomeId) ? run.biomeId : 'crypt'];
        this.isFinal = run.floorIndex >= run.floorCount;
        this.title = `${this.biome.name} · Floor ${run.floorIndex}/${run.floorCount}`;
        this.cameras.main.setBackgroundColor(this.biome.colors.background);

        const plan = planFloor({ seed: run.seed, biomeId: this.biome.id, floorIndex: run.floorIndex, floorCount: run.floorCount });
        const dungeon = buildDungeon(plan, floorSeed(run.seed, run.floorIndex));
        const map = this.make.tilemap({ data: dungeon.grid, tileWidth: TILE, tileHeight: TILE });
        const ground = map.createLayer(0, map.addTilesetImage(this.biome.tileset, this.biome.tileset)!, 0, 0) as Tilemaps.TilemapLayer;
        ground.setCollision(SOLID_DUNGEON);

        this.rooms = dungeon.rooms.map((room) => ({ room, slots: [], waves: [], wave: 0, alive: new Set(), incoming: 0, locked: false, gates: [] }));
        this.doorways = [];
        this.portal = null;
        this.bossSpawn = null;
        this.boss = null;
        this.bossShownHp = -1;
        this.bossRoom = this.rooms.find((r) => r.room.role === 'boss') ?? null;
        const roomOf = (id: string) => this.rooms.find((r) => r.room.id === id)!;
        let start = { x: TILE * 2, y: TILE * 2 };
        const { props } = this.biome;

        for (const marker of dungeon.markers)
        {
            const { x, y } = marker;
            switch (marker.type)
            {
                case 'torch':
                    this.placeObject({ kind: 'torch', x, y });
                    break;
                case 'pillar':
                    this.placeObject({ kind: 'pillar', x, y: y - 0.5, texture: props.pillar });
                    break;
                case 'obstacle':
                    this.placeObject({ kind: 'obstacle', x, y, texture: props.obstacle });
                    break;
                case 'decor':
                    // Flat floor detail: under everything, never blocks.
                    this.placeObject({ kind: 'decor', x, y, texture: props.decor[(x * 7 + y * 3) % props.decor.length] }).image.setDepth(1);
                    break;
                case 'stairs':
                    this.addSealedStairs(x, y);
                    break;
                case 'chest':
                case 'finalChest':
                    this.addChest(marker);
                    break;
                case 'guardian':
                    this.bossSpawn = { x: x * TILE + TILE / 2, y: (y + 1) * TILE };
                    break;
                case 'portal':
                    this.addPortal(x, y);
                    break;
                case 'shrine':
                    this.addShrine(marker);
                    break;
                case 'door':
                    this.doorways.push({ x: (x - 1) * TILE, y: (y - 1) * TILE, w: TILE * 3, h: TILE * 3 });
                    break;
                case 'spawn':
                    start = { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
                    break;
                case 'enemySlot':
                    roomOf(marker.roomId).slots.push({ x: x * TILE + TILE / 2, y: (y + 1) * TILE - 1 });
                    break;
            }
        }

        if (this.bossRoom)
        {
            const { x, y, w, h } = this.bossRoom.room;
            this.add.image((x + w / 2) * TILE, (y + h / 2) * TILE, props.arena).setDepth(1).setAlpha(0.9);
        }

        // Seeded waves per combat room (same fight after a refresh or a death retry).
        const ctx = this.scaleContext();
        for (const r of this.rooms)
        {
            if (r.room.role !== 'combat') continue;
            r.waves = rollRoomWaves(floorSeed(run.seed, run.floorIndex), r.room.id, this.biome, ctx, r.slots.length);
        }

        return { ground, width: dungeon.cols * TILE, height: dungeon.rows * TILE, spawns: { start } };
    }

    protected onWorldReady ()
    {
        const ui = getUi();
        const run = dungeonRun.state;
        ui.bossBar.hide();
        document.getElementById('app')?.style.setProperty('--dungeon-vignette', this.biome.colors.vignette);

        // A run saved at 0 HP (page closed on the death screen, or during the crash this fixes)
        // reopens the death screen instead of leaving a living player with no health.
        if (run.active && run.hp <= 0) this.combat?.killPlayer();

        const showObjective = () => ui.hud.setObjective(this.objective());
        showObjective();
        const unsubscribe = dungeonRun.subscribe(showObjective);
        const onPhase = () =>
        {
            ui.bossBar.enrage();
            ui.toasts.show('Hades is enraged! His attacks quicken.', 'error');
        };
        this.events.on('boss-phase', onPhase);
        this.events.once('shutdown', () =>
        {
            unsubscribe();
            this.events.off('boss-phase', onPhase);
            ui.bossBar.hide();
        });

        ui.toasts.show(`${this.biome.name}, floor ${run.floorIndex} of ${run.floorCount}${this.isFinal ? ': Hades awaits' : ''}.  Tower level ${run.towerLevel}`);
    }

    private objective (): string
    {
        const s = dungeonRun.state;
        const combat = this.rooms.filter((r) => r.room.role === 'combat');
        const left = combat.filter((r) => !dungeonRun.isRoomCleared(r.room.id)).length;
        if (left) return `Clear the rooms (${combat.length - left}/${combat.length})`;
        if (!this.isFinal) return `Take the portal to floor ${s.floorIndex + 1}`;
        if (!s.guardianDefeated) return 'Defeat Hades';
        if (!s.finalChestOpened) return 'Open the final chest';
        return 'Return home through the portal';
    }

    private get combatCleared ()
    {
        return this.rooms.every((r) => r.room.role !== 'combat' || dungeonRun.isRoomCleared(r.room.id));
    }

    // ------------------------------------------------------------ room director

    update (time: number, delta: number)
    {
        super.update(time, delta);
        if (!this.combat || this.combat.dead) return;

        const room = this.roomAt(this.player.x, this.player.y);
        if (room && !room.locked)
        {
            if (room.room.role === 'combat' && !dungeonRun.isRoomCleared(room.room.id)) this.lockRoom(room);
            else if (room === this.bossRoom && !dungeonRun.state.guardianDefeated) this.startBoss(room);
        }

        if (this.boss && this.boss.hp !== this.bossShownHp)
        {
            this.bossShownHp = this.boss.hp;
            getUi().bossBar.setHp(this.boss.hp, this.boss.stats.maxHp);
        }
    }

    /** Room whose interior (one tile in from its walls) contains this point. */
    private roomAt (px: number, py: number): RoomState | null
    {
        const tx = Math.floor(px / TILE);
        const ty = Math.floor(py / TILE);
        return this.rooms.find(({ room: r }) => tx >= r.x + 2 && tx < r.x + r.w - 2 && ty >= r.y + 2 && ty < r.y + r.h - 2) ?? null;
    }

    /** Gates slam shut on every doorway of the room. */
    private closeGates (r: RoomState)
    {
        r.locked = true;
        for (const door of r.room.doors)
        {
            const px = door.x * TILE;
            const py = door.y * TILE;
            const gate = this.add.image(px, py, this.biome.props.gate).setOrigin(0, 0).setDepth(py + TILE).setAlpha(0);
            this.tweens.add({ targets: gate, alpha: 1, duration: 160 });
            const zone = this.add.zone(px, py, TILE, TILE).setOrigin(0, 0);
            this.obstacles.add(zone);
            r.gates.push(gate, zone);
        }
        this.cameras.main.shake(120, 0.003);
    }

    private openGates (r: RoomState)
    {
        for (const g of r.gates)
        {
            if (g instanceof GameObjects.Image) this.tweens.add({ targets: g, alpha: 0, duration: 250, onComplete: () => g.destroy() });
            else g.destroy();
        }
        r.gates = [];
    }

    private lockRoom (r: RoomState)
    {
        this.closeGates(r);
        r.wave = 0;
        this.time.delayedCall(350, () => this.spawnWave(r));
    }

    /** Telegraphs each spawn point (rune), then the enemies appear there. */
    private spawnWave (r: RoomState)
    {
        const wave = r.waves[r.wave] ?? [];
        // Spawn away from the player so nothing appears on top of them.
        const slots = [...r.slots].sort((a, b) =>
            Math.hypot(b.x - this.player.x, b.y - this.player.y) - Math.hypot(a.x - this.player.x, a.y - this.player.y));
        const far = slots.slice(0, Math.max(wave.length, Math.ceil(slots.length * 0.6)));
        // Deterministic shuffle of the far half per wave, so groups don't always stack the same way.
        const offset = (r.wave * 3 + r.room.id.length) % Math.max(1, far.length);
        r.incoming += wave.length;

        wave.forEach((typeId, i) =>
        {
            const slot = far[(i + offset) % far.length] ?? { x: this.player.x, y: this.player.y - 48 };
            const rune = this.add.image(slot.x, slot.y - 4, 'spawn-rune').setDepth(2).setAlpha(0).setScale(0.6);
            this.tweens.add({ targets: rune, alpha: 1, scale: 1, angle: 90, duration: SPAWN_TELEGRAPH_MS, ease: 'Quad.easeOut' });
            // Stable kill id: a death retry respawns the same enemy with the same id, so it never pays twice.
            const run = dungeonRun.state;
            const rewardId = `${run.runId}/f${run.floorIndex}/${r.room.id}/w${r.wave}/${i}`;
            this.time.delayedCall(SPAWN_TELEGRAPH_MS + i * 90, () =>
            {
                rune.destroy();
                r.incoming--;
                if (!this.combat || this.combat.dead) return;
                const spot = this.combat.context.freeSpotNear(slot.x, slot.y) ?? slot;
                r.alive.add(this.combat.spawnEnemy(typeId, spot.x, spot.y, null, rewardId));
            });
        });
        if (!wave.length) this.time.delayedCall(10, () => this.checkRoom(r));
    }

    protected onEnemyDefeated (enemy: Enemy)
    {
        this.payKillXp(enemy);
        if (enemy === this.boss) return this.onBossDefeated();
        const r = this.rooms.find((room) => room.alive.has(enemy));
        if (!r) return;
        r.alive.delete(enemy);
        this.checkRoom(r);
    }

    /** XP for a legitimate kill: once per stable kill id, only in runs that pay XP (no dev runs). */
    private payKillXp (enemy: Enemy)
    {
        const run = dungeonRun.state;
        if (!enemy.rewardId || !run.paysXp) return;
        const award = playerState.awardKill(run.runId, enemy.rewardId, enemy.kind.id, run.towerLevel);
        this.announceXp(award, { x: enemy.center.x, y: enemy.hurtbox.y - 10 });
    }

    private checkRoom (r: RoomState)
    {
        if (!r.locked || r.alive.size || r.incoming) return;
        if (r.wave + 1 < r.waves.length)
        {
            r.wave++;
            this.time.delayedCall(700, () => this.spawnWave(r));
            return;
        }
        dungeonRun.clearRoom(r.room.id);
        this.openGates(r);
        r.locked = false;
        getUi().toasts.show(this.combatCleared ? (this.isFinal ? 'All rooms cleared! Find the boss chamber.' : 'Floor cleared! The portal is awake.') : 'Room cleared!', 'reward');
    }

    // ------------------------------------------------------------ boss

    private startBoss (r: RoomState)
    {
        if (!this.bossSpawn || !this.combat || this.boss) return;
        this.closeGates(r);
        const ui = getUi();
        ui.bossBar.intro('HADES', 'King of the Dead', BOSS_INTRO_MS);
        this.cameras.main.shake(400, 0.006);

        const run = dungeonRun.state;
        const hades = this.combat.spawnEnemy('hades', this.bossSpawn.x, this.bossSpawn.y, null, `${run.runId}/f${run.floorIndex}/boss`) as Hades;
        hades.activeAt = this.time.now + BOSS_INTRO_MS;
        hades.setAlpha(0);
        this.tweens.add({ targets: hades, alpha: 1, duration: 900 });
        this.boss = hades;
        this.time.delayedCall(BOSS_INTRO_MS - 300, () =>
        {
            if (!hades.alive) return;
            ui.bossBar.show('Hades, King of the Dead');
            ui.bossBar.setHp(hades.hp, hades.stats.maxHp);
        });
    }

    private onBossDefeated ()
    {
        const ui = getUi();
        const at = this.boss ? { x: this.boss.x, y: this.boss.y - 24 } : null;
        this.boss = null;
        dungeonRun.defeatGuardian();
        ui.bossBar.hide();
        ui.toasts.show(DUNGEON_MESSAGES.guardianDefeated, 'reward');
        this.cameras.main.flash(500, 200, 160, 255);
        this.cameras.main.shake(500, 0.008);
        if (at)
        {
            // Soul burst: wisps rise out of the fallen king.
            for (let i = 0; i < 24; i++)
            {
                const angle = (i / 24) * Math.PI * 2;
                const wisp = this.add.image(at.x, at.y, 'soul-fire').setDepth(100000).setScale(0.6);
                this.tweens.add({
                    targets: wisp, x: at.x + Math.cos(angle) * 46, y: at.y + Math.sin(angle) * 30 - 20, alpha: 0, scale: 0.2,
                    duration: 900 + (i % 4) * 120, ease: 'Quad.easeOut', onComplete: () => wisp.destroy(),
                });
            }
        }
        if (this.bossRoom) { this.openGates(this.bossRoom); this.bossRoom.locked = false; }
    }

    // ------------------------------------------------------------ dev panel (dev builds only)

    devSpawn (id: EnemyTypeId)
    {
        const combat = this.combat;
        if (!combat) return false;
        // Try several directions; never fall back to an unchecked spot (could be inside a wall).
        for (let i = 0; i < 8; i++)
        {
            const angle = Math.random() * Math.PI * 2;
            const spot = combat.context.freeSpotNear(this.player.x + Math.cos(angle) * 56, this.player.y + Math.sin(angle) * 40);
            if (spot) { dungeonRun.markDev(); combat.spawnEnemy(id, spot.x, spot.y); return true; } // no reward id: 0 XP
        }
        return false;
    }

    devKillAll ()
    {
        const enemies = [...(this.combat?.liveEnemies ?? [])];
        if (enemies.length) dungeonRun.markDev(); // dev kills never pay XP, and neither does this run's victory
        for (const e of enemies) if (e.active && e.alive) { e.rewardId = null; e.takeDamage(99999, 0); }
        return enemies.length;
    }

    /** Teleports into the boss chamber (final floor only). */
    devToBoss ()
    {
        if (!this.bossRoom) return getUi().toasts.show('No boss on this floor: start a boss test from the dev panel.', 'error');
        dungeonRun.markDev();
        const { x, y, w, h } = this.bossRoom.room;
        const px = (x + w / 2) * TILE - 40;
        const py = (y + h / 2) * TILE + 48;
        this.player.setPosition(px, py);
        (this.player.body as { reset (x: number, y: number): void }).reset(px, py);
    }

    // ------------------------------------------------------------ objects

    /** The way back down is barred during a run. */
    private addSealedStairs (x: number, y: number)
    {
        const { interactPoint } = this.placeObject({ kind: 'sealedStairs', x, y });
        this.addInteractable({
            ...interactPoint!,
            prompt: () => 'Sealed: reach the top of the tower',
            interact: () => getUi().toasts.show(DUNGEON_MESSAGES.sealed, 'error'),
        });
    }

    private addChest (marker: Marker)
    {
        const isFinal = marker.type === 'finalChest';
        const run = dungeonRun.state;
        const chestId = chestIdForMarker(run, marker);
        const { image, interactPoint } = this.placeObject({ kind: 'chest', x: marker.x, y: marker.y });
        const record = () => dungeonRun.state.chests[chestId];
        if (record()) image.setTexture('chest-open');

        this.addInteractable({
            ...interactPoint!,
            prompt: () =>
            {
                const r = record();
                if (r) return r.granted ? null : 'Press E to Collect Reward';
                if (isFinal && !dungeonRun.state.guardianDefeated) return 'Locked: defeat Hades';
                return 'Press E to Open Chest';
            },
            interact: () =>
            {
                const ui = getUi();
                if (isFinal && !dungeonRun.state.guardianDefeated) return ui.toasts.show(DUNGEON_MESSAGES.chestLocked, 'error');
                const firstOpen = !record();
                const result = dungeonRun.openChest(chestId, isFinal, chestReward);
                if (firstOpen && record()) this.playChestOpen(image); // no record = the roll was not saved
                if (result.status === 'saveFailed') return ui.toasts.show(DUNGEON_MESSAGES.rewardNotSaved, 'error');

                const { record: chest, grantedQty } = result;
                const name = itemDef(chest.itemId).name;
                if (grantedQty > 0) ui.toasts.show(`You found: ${name}${grantedQty > 1 ? ` ×${grantedQty}` : ''}`, 'reward', itemIconUrl(chest.itemId));
                else if (chest.granted) ui.toasts.show(DUNGEON_MESSAGES.rewardAlreadyCollected); // delivered before an interrupted save
                if (!chest.granted) ui.toasts.show(`Your bag is full! Press I and discard something you don't need, then press E here to collect the ${name}.`, 'error');
                if (isFinal && chest.granted && dungeonRun.state.exitUnlocked) this.revealPortal(true);
            },
        });
    }

    private playChestOpen (image: GameObjects.Image)
    {
        // Squash, pop open, sparkle.
        this.tweens.add({
            targets: image, scaleY: 0.85, duration: 90, yoyo: true,
            onYoyo: () => image.setTexture('chest-open'),
        });
        const cx = image.x + 8;
        const cy = image.y + 6;
        for (let i = 0; i < 8; i++)
        {
            const angle = -Math.PI / 2 + (i - 3.5) * 0.35;
            const spark = this.add.rectangle(cx, cy, 2, 2, i % 2 ? 0xf2c14e : 0xfff1a8).setDepth(image.depth + 1);
            this.tweens.add({
                targets: spark, x: cx + Math.cos(angle) * 18, y: cy + Math.sin(angle) * 18, alpha: 0,
                duration: 500, ease: 'Quad.easeOut', onComplete: () => spark.destroy(),
            });
        }
    }

    /** Heals once per floor (also after a refresh; a death retry resets the floor). */
    private addShrine (marker: Marker)
    {
        const key = `shrine:${marker.roomId}`;
        const { image, interactPoint } = this.placeObject({ kind: 'shrine', x: marker.x, y: marker.y - 0.5 });
        if (dungeonRun.isRoomCleared(key)) image.setTexture('shrine-used');
        this.addInteractable({
            ...interactPoint!,
            prompt: () => (dungeonRun.isRoomCleared(key) ? null : 'Press E to Pray (heal)'),
            interact: () =>
            {
                if (dungeonRun.isRoomCleared(key)) return;
                const healed = dungeonRun.heal(SHRINE_HEAL);
                dungeonRun.clearRoom(key);
                image.setTexture('shrine-used');
                this.floatText(healed ? `+${healed} HP` : 'Full HP', this.player.x, this.player.y - 16, 'heal');
                getUi().toasts.show(healed ? 'The shrine mends your wounds.' : 'The shrine fades; you were already at full health.', 'reward');
            },
        });
    }

    private addPortal (x: number, y: number)
    {
        const px = x * TILE + TILE / 2;
        const py = (y + 1) * TILE + 6;
        this.portal = this.add.image(px, py, 'portal').setOrigin(0.5, 1).setDepth(py).setVisible(false);
        this.tweens.add({ targets: this.portal, scaleX: 1.08, scaleY: 0.95, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
        const open = () => (this.isFinal ? dungeonRun.state.exitUnlocked : this.combatCleared);
        if (open()) this.revealPortal(false);
        const unsubscribe = dungeonRun.subscribe(() => { if (open()) this.revealPortal(true); });
        this.events.once('shutdown', unsubscribe);

        this.addInteractable({
            x: px, y: py, range: 28,
            prompt: () =>
            {
                if (!open()) return this.isFinal ? null : 'Portal dormant: clear the rooms';
                return this.isFinal ? 'Press E to Return to Village' : `Press E to Climb to Floor ${dungeonRun.state.floorIndex + 1}`;
            },
            interact: () =>
            {
                const ui = getUi();
                if (!open()) return ui.toasts.show(DUNGEON_MESSAGES.portalLocked, 'error');
                if (!this.isFinal)
                {
                    if (dungeonRun.advanceFloor()) this.warpTo({ scene: 'Dungeon', spawn: 'start' });
                    else ui.toasts.show(DUNGEON_MESSAGES.rewardNotSaved, 'error');
                    return;
                }
                const runId = dungeonRun.state.runId;
                const completedLevel = dungeonRun.state.floorId === TOWER_RUN ? dungeonRun.state.towerLevel : tower.state.towerLevel;
                if (!dungeonRun.complete()) return ui.toasts.show(DUNGEON_MESSAGES.rewardNotSaved, 'error');
                // Victory confirmed and saved: the completion bonus (once per run; never for dev runs).
                if (dungeonRun.state.paysXp) this.announceXp(playerState.awardDungeonCompletion(runId, completedLevel), null, 'Dungeon victory');
                const levelled = tower.recordCompletion(runId, completedLevel);
                pomodoro.finishDungeon(); // rewards in hand: the next focus session starts now
                ui.toasts.show(levelled ? `Tower conquered! Tower level ${tower.state.towerLevel} unlocked.` : 'Tower conquered! Welcome back to the village.', 'reward');
                this.warpTo({ scene: 'Hub', spawn: 'fromDungeon' });
            },
        });
    }

    private revealPortal (announce: boolean)
    {
        if (!this.portal || this.portal.visible) return;
        this.portal.setVisible(true).setAlpha(0);
        this.tweens.add({ targets: this.portal, alpha: 1, duration: 600 });
        if (announce && this.isFinal) getUi().toasts.show(DUNGEON_MESSAGES.treasureClaimed, 'reward');
    }
}
