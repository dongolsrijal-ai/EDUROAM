// Base class for every explorable map (village hub, dungeon floors, future maps).
// Subclasses only build their ground + objects; everything else is shared here:
// player, NPCs + their buildings, collisions, camera, interactions (E), inventory (I),
// NPC/building placement and, on combat maps only, the combat controller.

import { GameObjects, Input, Physics, Scene, Tilemaps } from 'phaser';
import { CHARACTER_SIZE } from '../config';
import { CombatController, type FloatKind } from '../combat/CombatController';
import { pixelZoom } from '../display';
import { Building } from '../buildings/Building';
import { BUILDING_FOR_APPEARANCE, BUILDING_H, BUILDING_TYPES, BUILDING_W, FRONT_CLEARANCE, NPC_HOME_OFFSET } from '../buildings/buildingTypes';
import { npcStore, type MapId, type NpcRecord, type Placement } from '../data/npcStore';
import { APPEARANCES, textureDataUrl, type AppearanceId } from '../npcs/appearances';
import { runConversation } from '../npcs/conversation';
import { currentPlayerId } from '../data/playerIdentity';
import { Npc, npcFootprint, TALK_RANGE } from '../npcs/Npc';
import { Player } from '../objects/Player';
import { claimChallengeReward } from '../state/playerState';
import { dungeonRun } from '../state/dungeonRun';
import type { Modal } from '../ui/dom';
import { getUi } from '../ui';
import type { WorldHost } from '../ui/NpcManager';
import { spawnObject, type PlacedObject, type Rect, type SpawnedObject, type Warp } from '../world/objectTypes';

export interface Point { x: number; y: number }

export interface WorldLayout
{
    ground: Tilemaps.TilemapLayer;
    /** World size in pixels (physics + camera boundary). */
    width: number;
    height: number;
    /** Named player spawn points in world pixels; 'start' is required. */
    spawns: { start: Point } & Record<string, Point>;
}

/** Something the player can use with E (doors, chests, portals...). */
export interface Interactable
{
    x: number;
    y: number;
    /** Max distance (px) from the player's centre. */
    range?: number;
    /** Text for the "Press E" tag, or null when it can't be used right now (hidden). */
    prompt (): string | null;
    interact (): void;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

type AnyBody = Physics.Arcade.Body | Physics.Arcade.StaticBody;

export abstract class WorldScene extends Scene implements WorldHost
{
    abstract readonly mapId: MapId;
    /** Shown in the HUD. */
    abstract readonly title: string;
    /** Dungeon-style darker presentation. */
    protected readonly dark: boolean = false;
    /** Combat maps get left/right-click attacks, F to heal and the health bar. The village stays peaceful. */
    protected readonly combatEnabled: boolean = false;

    /** Build ground + objects (use this.placeObject). Called at the start of create(). */
    protected abstract buildWorld (): WorldLayout;

    /** Called at the end of create(), once the player exists (spawn enemies, show messages...). */
    protected onWorldReady (): void
    {
        // optional
    }

    /** Areas buildings may not cover (paths, doorways). Override per map. */
    protected isProtectedArea (_area: Rect): boolean
    {
        return false;
    }

    protected player!: Player;
    protected obstacles!: Physics.Arcade.StaticGroup;
    protected layout!: WorldLayout;
    private npcs: Npc[] = [];
    private buildings: Building[] = [];
    private npcColliders: Physics.Arcade.Collider[] = [];
    private interactables: Interactable[] = [];
    private noPlacement: Rect[] = [];
    protected combat: CombatController | null = null;
    private modal: Modal | null = null;
    private talkingTo: Npc | null = null;
    /** Waiting for NPC lines (instant when scripted; an AI reply may take a moment). */
    private dialoguePending = false;
    private inputEnabled = true;
    private warping = false;
    private placement: { cleanup: () => void; onCancel: () => void } | null = null;

    create (data: { spawn?: string } = {})
    {
        // Scenes are reused when revisited, so reset per-visit state here.
        this.npcs = [];
        this.buildings = [];
        this.npcColliders = [];
        this.interactables = [];
        this.noPlacement = [];
        this.combat = null;
        this.modal = null;
        this.talkingTo = null;
        this.dialoguePending = false;
        this.inputEnabled = true;
        this.warping = false;
        this.placement = null;
        this.obstacles = this.physics.add.staticGroup();

        this.layout = this.buildWorld();
        const { ground, width, height, spawns } = this.layout;

        // Player + collisions
        const spawn = spawns[data.spawn ?? 'start'] ?? spawns.start;
        this.player = new Player(this, spawn.x, spawn.y);
        this.physics.add.collider(this.player, ground);
        this.physics.add.collider(this.player, this.obstacles);
        this.syncResidents();

        // Boundaries + camera (whole-number zoom keeps pixels crisp)
        this.physics.world.setBounds(0, 0, width, height);
        const camera = this.cameras.main;
        camera.startFollow(this.player, true);
        const applyZoom = () =>
        {
            const zoom = pixelZoom(this.scale.width, this.scale.height);
            camera.setZoom(zoom);
            // Maps smaller than the view are centred instead of pinned to the top-left.
            const viewW = this.scale.width / zoom;
            const viewH = this.scale.height / zoom;
            camera.setBounds(Math.min(0, (width - viewW) / 2), Math.min(0, (height - viewH) / 2),
                Math.max(width, viewW), Math.max(height, viewH));
        };
        applyZoom();
        this.scale.on('resize', applyZoom);
        camera.fadeIn(250, 0, 0, 0);

        // Overlay UI
        const ui = getUi();
        ui.hud.setLocation(this.title);
        ui.hud.setCombat(this.combatEnabled);
        ui.setDark(this.dark);
        ui.setMode('play');
        ui.manager.setHost(this);
        const unsubscribe = npcStore.subscribe(() => this.syncResidents());

        // Combat (dungeons only)
        let unsubscribeRun = () => {};
        if (this.combatEnabled)
        {
            this.combat = new CombatController({
                scene: this,
                player: this.player,
                ground,
                obstacles: this.obstacles,
                canAct: () => !this.modal && !this.dialoguePending && this.inputEnabled && !this.warping,
                float: (text, x, y, kind) => this.floatText(text, x, y, kind),
                onPlayerDied: () => this.onPlayerDied(),
            });
            const showHealth = () => ui.hud.setHealth(dungeonRun.state.hp, dungeonRun.maxHp);
            showHealth();
            unsubscribeRun = dungeonRun.subscribe(showHealth);
        }

        const keyboard = this.input.keyboard!;
        keyboard.on('keydown', this.onKeyDown);

        this.events.once('shutdown', () =>
        {
            this.cancelPlacement();
            unsubscribe();
            unsubscribeRun();
            this.combat?.destroy();
            this.scale.off('resize', applyZoom);
            keyboard.off('keydown', this.onKeyDown);
            keyboard.enableGlobalCapture();
            ui.manager.setHost(null);
            ui.talkTag.hide();
        });

        this.onWorldReady();
    }

    update (time: number, delta: number)
    {
        const ui = getUi();
        for (const npc of this.npcs) npc.tick(delta);
        this.combat?.update(time);

        // Conversation finished: let that NPC roam again.
        if (this.talkingTo && !this.dialoguePending && this.modal !== ui.dialogue && this.modal !== ui.quiz)
        {
            this.talkingTo.setTalking(false);
            this.talkingTo = null;
        }

        if (this.modal || this.dialoguePending || !this.inputEnabled || this.warping || this.combat?.dead)
        {
            this.player.halt();
            ui.talkTag.hide();
            return;
        }

        this.player.update();

        // "Press E" tag above whatever is closest: an NPC or an interactive object.
        const target = this.nearestInteraction();
        if (!target) return ui.talkTag.hide();
        const [x, y] = this.worldToCss(target.x, target.y);
        if (target.npc) ui.talkTag.show(target.npc.record.name, target.npc.record.subject, x, y);
        else ui.talkTag.showPrompt(target.prompt, x, y);
    }

    /** World pixels -> CSS pixels of the overlay UI. */
    protected worldToCss (x: number, y: number): [number, number]
    {
        const camera = this.cameras.main;
        const cssScale = camera.zoom / this.scale.displayScale.x;
        return [(x - camera.worldView.x) * cssScale, (y - camera.worldView.y) * cssScale];
    }

    protected floatText (text: string, x: number, y: number, kind: FloatKind)
    {
        const [cx, cy] = this.worldToCss(x, y);
        getUi().floaters.spawn(text, cx, cy, kind);
    }

    /** Spawns a map object and registers its no-placement area (and torch flicker). */
    protected placeObject (obj: PlacedObject): SpawnedObject
    {
        const spawned = spawnObject(this, this.obstacles, obj);
        if (spawned.noPlacement) this.noPlacement.push(spawned.noPlacement);
        if (obj.kind === 'torch')
        {
            this.tweens.add({
                targets: spawned.image, alpha: 0.7, duration: 260 + Math.round((obj.x * 37 + obj.y * 13) % 200),
                yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
            });
        }
        return spawned;
    }

    /** Registers something usable with E. */
    protected addInteractable (interactable: Interactable)
    {
        this.interactables.push(interactable);
        return interactable;
    }

    /** Closest NPC or usable object in range (NPC tag sits above the head, objects at their anchor). */
    private nearestInteraction (): { x: number; y: number; npc?: Npc; prompt: string; use: () => void } | null
    {
        let best: { x: number; y: number; npc?: Npc; prompt: string; use: () => void } | null = null;
        let bestDistance = Infinity;
        const npc = this.nearbyNpc();
        if (npc)
        {
            bestDistance = npc.distanceTo(this.player);
            best = { x: npc.x, y: npc.y - CHARACTER_SIZE - 2, npc, prompt: '', use: () => this.talkTo(npc) };
        }
        for (const item of this.interactables)
        {
            const d = Math.hypot(item.x - this.player.x, item.y - this.player.center.y);
            if (d > (item.range ?? 26) || d >= bestDistance) continue;
            const prompt = item.prompt();
            if (!prompt) continue;
            best = { x: item.x, y: item.y - 18, prompt, use: () => item.interact() };
            bestDistance = d;
        }
        return best;
    }

    // ------------------------------------------------------------ NPCs, buildings, talking

    /** Rebuilds NPCs + buildings on this map from the store (on start and whenever data changes). */
    private syncResidents ()
    {
        const talkingId = this.talkingTo?.record.id;
        for (const collider of this.npcColliders) collider.destroy();
        for (const npc of this.npcs) npc.destroy();
        for (const building of this.buildings) building.remove();

        this.buildings = npcStore.buildings()
            .filter((b) => b.map === this.mapId)
            .map((b) => new Building(this, b, this.obstacles));

        const canStand = (x: number, y: number, self: Npc) => this.canStandAt(x, y, [self]);
        this.npcs = npcStore.all()
            .filter((record) => record.map === this.mapId)
            .map((record) => new Npc(this, record, canStand));
        this.npcColliders = this.npcs.map((npc) => this.physics.add.collider(this.player, npc));

        // Data can change mid-conversation (e.g. "completed"): keep that NPC frozen.
        this.talkingTo = this.npcs.find((npc) => npc.record.id === talkingId) ?? null;
        this.talkingTo?.setTalking(true);
    }

    private nearbyNpc ()
    {
        let best: Npc | undefined;
        let bestDistance = TALK_RANGE;
        for (const npc of this.npcs)
        {
            const d = npc.distanceTo(this.player);
            if (d < bestDistance) { best = npc; bestDistance = d; }
        }
        return best;
    }

    private setModal (modal: Modal | null)
    {
        this.modal = modal;
        const ui = getUi();
        ui.setMode(!modal ? 'play' : modal === ui.inventory ? 'inventory' : 'talk');
    }

    /** Single key router: open UI gets the key; otherwise E interacts, I opens the bag, F heals (combat maps). */
    private onKeyDown = (event: KeyboardEvent) =>
    {
        if (event.repeat || !this.inputEnabled || this.warping) return;
        const key = event.key.toLowerCase();
        if (this.modal) return this.modal.handleKey(key);
        if (this.combat?.dead || this.dialoguePending) return;

        if (key === 'e')
        {
            this.nearestInteraction()?.use();
        }
        else if (key === 'i')
        {
            const ui = getUi();
            this.combat?.releaseAll();
            this.setModal(ui.inventory);
            ui.inventory.open(() => this.setModal(null));
        }
        else if (key === 'f')
        {
            this.combat?.heal(); // no combat controller in the village: F does nothing there
        }
    };

    /** Death screen; retrying restarts this run from the entrance (see dungeonRun.retryAfterDeath). */
    private onPlayerDied ()
    {
        const ui = getUi();
        this.setModal(ui.death);
        ui.setMode('dead');
        ui.death.open(() =>
        {
            dungeonRun.retryAfterDeath();
            this.setModal(null);
            this.scene.restart({ spawn: 'start' });
        });
    }

    private talkTo (npc: Npc)
    {
        this.combat?.releaseAll();
        const ui = getUi();
        const record: NpcRecord = npc.record;
        const speaker = { name: record.name, subtitle: record.subject, portrait: this.portraitUrl(record.appearance) };
        npc.setTalking(true);
        this.talkingTo = npc;

        runConversation(record, currentPlayerId(), {
            wait: async (work) =>
            {
                this.dialoguePending = true;
                try { return await work; }
                finally { this.dialoguePending = false; }
            },
            say: (lines, choices = [], onDone) =>
            {
                this.setModal(ui.dialogue);
                ui.dialogue.open(speaker, lines, choices, (choice) => { this.setModal(null); onDone?.(choice); });
            },
            quiz: (challenge, rewardAvailable, onDone) =>
            {
                this.setModal(ui.quiz);
                ui.quiz.open(challenge, rewardAvailable, (score) => { this.setModal(null); onDone(score); });
            },
            passed: (challenge) =>
            {
                const { granted, full } = claimChallengeReward(challenge);
                const { label } = challenge.reward;
                if (granted) ui.toasts.show(`Challenge Complete!  +${granted} ${label}`, 'reward');
                if (full) ui.toasts.show(granted ? 'Bag full: some of the reward was lost.' : 'Your bag is full! Make space, then win again to claim the reward.', 'error');
                if (!record.completed) npcStore.update(record.id, { completed: true });
            },
        });
    }

    protected warpTo (warp: Warp)
    {
        if (this.warping || this.modal || !this.inputEnabled) return;
        this.warping = true;
        this.player.halt();
        const camera = this.cameras.main;
        camera.fadeOut(250, 0, 0, 0);
        camera.once('camerafadeoutcomplete', () => this.scene.start(warp.scene, { spawn: warp.spawn }));
    }

    // ------------------------------------------------------------ WorldHost (NPC manager)

    setInputEnabled (enabled: boolean)
    {
        this.inputEnabled = enabled;
        const keyboard = this.input.keyboard!;
        keyboard.enabled = enabled;
        // Global capture swallows keys like W/S/space, which would break typing in the form.
        if (enabled) keyboard.enableGlobalCapture();
        else keyboard.disableGlobalCapture();
        keyboard.resetKeys();
    }

    textureUrl (key: string)
    {
        return textureDataUrl(this.textures, key);
    }

    portraitUrl (appearance: AppearanceId)
    {
        return this.textureUrl(APPEARANCES[appearance].texture);
    }

    /** Ghost building + NPC follow the pointer; a click on a valid spot calls onPlace. */
    beginPlacement (appearance: AppearanceId, ignoreNpcId: string | null, onPlace: (placement: Placement) => void, onCancel: () => void)
    {
        this.cancelPlacement();

        const building = BUILDING_TYPES[BUILDING_FOR_APPEARANCE[appearance]];
        const top = Number.MAX_SAFE_INTEGER; // ghosts always draw above the world
        const ghostBuilding = this.add.image(0, 0, building.texture).setOrigin(0, 0).setAlpha(0.75).setDepth(top - 1).setVisible(false);
        const ghostNpc = this.add.image(0, 0, APPEARANCES[appearance].texture).setOrigin(0.5, 1).setAlpha(0.85).setDepth(top).setVisible(false);
        const current = { x: 0, y: 0, valid: false };

        const move = (pointer: Input.Pointer) =>
        {
            const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
            // Building top-left on the tile grid, centred on the pointer.
            current.x = Math.round((world.x - BUILDING_W / 2) / 16) * 16;
            current.y = Math.round((world.y - BUILDING_H / 2) / 16) * 16;
            current.valid = this.canPlaceBuildingAt(current.x, current.y, ignoreNpcId);
            ghostBuilding.setPosition(current.x, current.y).setVisible(true);
            ghostNpc.setPosition(current.x + NPC_HOME_OFFSET.x, current.y + NPC_HOME_OFFSET.y).setVisible(true);
            for (const ghost of [ghostBuilding, ghostNpc])
            {
                if (current.valid) ghost.clearTint();
                else ghost.setTint(0xff5a5a);
            }
        };
        const down = (pointer: Input.Pointer) =>
        {
            move(pointer);
            if (!current.valid)
            {
                getUi().toasts.show("Can't build there: keep clear of paths, buildings, trees and water.", 'error');
                return;
            }
            cleanup();
            onPlace({
                map: this.mapId, x: current.x, y: current.y,
                npcX: current.x + NPC_HOME_OFFSET.x, npcY: current.y + NPC_HOME_OFFSET.y,
            });
        };
        const cleanup = () =>
        {
            this.placement = null;
            this.input.off('pointermove', move);
            this.input.off('pointerdown', down);
            ghostBuilding.destroy();
            ghostNpc.destroy();
        };

        this.input.on('pointermove', move);
        this.input.on('pointerdown', down);
        this.placement = { cleanup, onCancel };
    }

    cancelPlacement ()
    {
        const placement = this.placement;
        if (!placement) return;
        placement.cleanup();
        placement.onCancel();
    }

    // ------------------------------------------------------------ space queries

    /** Physics bodies overlapping a rect, minus the ignored game objects. */
    private bodiesIn (r: Rect, ignore: GameObjects.GameObject[])
    {
        const bodies = this.physics.overlapRect(r.x, r.y, r.w, r.h, true, true) as AnyBody[];
        return bodies.filter((body) => !ignore.includes(body.gameObject));
    }

    private solidTilesIn (r: Rect)
    {
        return this.layout.ground.getTilesWithinWorldXY(r.x, r.y, r.w, r.h, { isColliding: true }).length > 0;
    }

    /** True if a character's feet fit at (x, y): inside the map, off walls/water, touching nothing solid. */
    canStandAt (x: number, y: number, ignore: GameObjects.GameObject[] = [])
    {
        const { width, height } = this.layout;
        const feet = npcFootprint(x, y);
        if (feet.x < 0 || feet.y < 0 || feet.x + feet.w > width || y > height) return false;
        if (this.solidTilesIn(feet)) return false;
        return this.bodiesIn(feet, ignore).length === 0;
    }

    /** Building at (x, y) top-left + its NPC home spot: everything must be free and off paths. */
    private canPlaceBuildingAt (x: number, y: number, ignoreNpcId: string | null)
    {
        const { width, height } = this.layout;
        const area = { x, y, w: BUILDING_W, h: BUILDING_H };
        const front = { x, y: y + BUILDING_H, w: BUILDING_W, h: FRONT_CLEARANCE };
        if (x < 0 || y < 0 || x + BUILDING_W > width || front.y + front.h > height) return false;

        // The NPC (and building) being moved don't block their own new spot.
        const ownBuilding = this.buildings.find((b) => b.record.npcId === ignoreNpcId);
        const ownNpc = this.npcs.find((n) => n.record.id === ignoreNpcId);
        const ignore: GameObjects.GameObject[] = [...(ownBuilding?.zones ?? []), ...(ownNpc ? [ownNpc] : [])];
        const blocked = [...this.noPlacement, ...this.buildings.filter((b) => b !== ownBuilding).map((b) => b.area)];

        if (blocked.some((r) => overlaps(r, area) || overlaps(r, front))) return false;
        if (this.isProtectedArea(area)) return false;
        if (this.solidTilesIn(area) || this.solidTilesIn(front)) return false;
        if (this.bodiesIn(area, ignore).length || this.bodiesIn(front, ignore).length) return false;
        return this.canStandAt(x + NPC_HOME_OFFSET.x, y + NPC_HOME_OFFSET.y, ignore);
    }
}
