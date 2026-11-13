import { GameObjects, Tilemaps } from 'phaser';
import { COLORS, TILE } from '../config';
import { SOLID_DUNGEON } from '../art/textures';
import { Enemy, STONE_GUARDIAN } from '../combat/Enemy';
import { itemIconUrl } from '../items/icons';
import { itemDef } from '../items/itemDefs';
import { DUNGEON_LOOT, rollLoot } from '../items/lootTables';
import { dungeonRun } from '../state/dungeonRun';
import { getUi } from '../ui';
import { buildDungeon, type Marker } from '../world/dungeon/build';
import { FLOOR_1 } from '../world/dungeon/layout';
import type { Rect } from '../world/objectTypes';
import { WorldScene, type WorldLayout } from './WorldScene';

const FLOOR_ID = 'floor-1';

export const DUNGEON_MESSAGES = {
    sealed: 'The dungeon entrance is sealed. Complete the dungeon to escape.',
    guardianDefeated: 'Guardian defeated! Find the treasure chest.',
    treasureClaimed: 'Treasure claimed! The exit portal has appeared.',
    chestLocked: 'The Stone Guardian protects this chest. Defeat it first!',
};

/** First dungeon floor: template rooms, a guardian, loot chests and a locked exit. */
export class Dungeon extends WorldScene
{
    readonly mapId = 'dungeon';
    readonly title = 'Dungeon · Floor 1';
    protected readonly dark = true;
    protected readonly combatEnabled = true;

    /** Reserved spots from the room templates ('M' monsters, 'N' NPC encounters) for future systems. */
    encounterSlots: Marker[] = [];

    /** Doorways (+1 tile around them) where buildings may not be placed. */
    private doorways: Rect[] = [];
    private guardianSpawn: { x: number; y: number } | null = null;
    private portal: GameObjects.Image | null = null;

    constructor ()
    {
        super('Dungeon');
    }

    protected isProtectedArea (area: Rect)
    {
        return this.doorways.some((d) => area.x < d.x + d.w && area.x + area.w > d.x && area.y < d.y + d.h && area.y + area.h > d.y);
    }

    protected buildWorld (): WorldLayout
    {
        // Entering (or refreshing inside) starts / resumes the run before anything reads its state.
        dungeonRun.start(FLOOR_ID);
        this.cameras.main.setBackgroundColor(COLORS.dVoid);

        const dungeon = buildDungeon(FLOOR_1);
        const map = this.make.tilemap({ data: dungeon.grid, tileWidth: TILE, tileHeight: TILE });
        const ground = map.createLayer(0, map.addTilesetImage('dungeon')!, 0, 0) as Tilemaps.TilemapLayer;
        ground.setCollision(SOLID_DUNGEON);

        let start = { x: TILE * 2, y: TILE * 2 };
        this.encounterSlots = [];
        this.doorways = [];
        this.guardianSpawn = null;
        this.portal = null;

        for (const marker of dungeon.markers)
        {
            const { x, y } = marker;
            switch (marker.type)
            {
                case 'torch':
                    this.placeObject({ kind: 'torch', x, y });
                    break;
                case 'pillar':
                    this.placeObject({ kind: 'pillar', x, y: y - 0.5 });
                    break;
                case 'stairs':
                    this.addSealedStairs(x, y);
                    break;
                case 'chest':
                case 'finalChest':
                    this.addChest(marker);
                    break;
                case 'guardian':
                    this.guardianSpawn = { x: x * TILE + TILE / 2, y: (y + 1) * TILE };
                    break;
                case 'portal':
                    this.addPortal(x, y);
                    break;
                case 'door':
                    this.doorways.push({ x: (x - 1) * TILE, y: (y - 1) * TILE, w: TILE * 3, h: TILE * 3 });
                    break;
                case 'spawn':
                    start = { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
                    break;
                default:
                    this.encounterSlots.push(marker);
            }
        }

        return { ground, width: dungeon.cols * TILE, height: dungeon.rows * TILE, spawns: { start } };
    }

    protected onWorldReady ()
    {
        const ui = getUi();
        const run = dungeonRun.state;

        if (this.guardianSpawn && !run.guardianDefeated)
        {
            const guardian = new Enemy(this, this.guardianSpawn.x, this.guardianSpawn.y, STONE_GUARDIAN, `${FLOOR_ID}:guardian`, {
                onDamaged: (enemy, amount) => this.floatText(`-${amount}`, enemy.center.x, enemy.center.y - 10, 'damage'),
                onDefeated: () =>
                {
                    dungeonRun.defeatGuardian();
                    ui.toasts.show(DUNGEON_MESSAGES.guardianDefeated, 'reward');
                },
            });
            this.combat?.addEnemy(guardian);
        }

        const showObjective = () =>
        {
            const s = dungeonRun.state;
            ui.hud.setObjective(!s.guardianDefeated ? 'Defeat the Stone Guardian'
                : !s.finalChestOpened ? 'Open the treasure chest'
                    : 'Escape through the portal');
        };
        showObjective();
        const unsubscribe = dungeonRun.subscribe(showObjective);
        this.events.once('shutdown', unsubscribe);

        if (!run.exitUnlocked) ui.toasts.show(DUNGEON_MESSAGES.sealed);
    }

    /** The way back up is barred during a run. */
    private addSealedStairs (x: number, y: number)
    {
        const { interactPoint } = this.placeObject({ kind: 'sealedStairs', x, y });
        this.addInteractable({
            ...interactPoint!,
            prompt: () => 'Sealed: complete the dungeon',
            interact: () => getUi().toasts.show(DUNGEON_MESSAGES.sealed, 'error'),
        });
    }

    private addChest (marker: Marker)
    {
        const isFinal = marker.type === 'finalChest';
        const chestId = `${FLOOR_ID}:${marker.roomId}:${marker.x},${marker.y}`;
        const { image, interactPoint } = this.placeObject({ kind: 'chest', x: marker.x, y: marker.y });
        const record = () => dungeonRun.state.chests[chestId];
        if (record()) image.setTexture('chest-open');

        this.addInteractable({
            ...interactPoint!,
            prompt: () =>
            {
                const r = record();
                if (r) return r.granted ? null : 'Press E to Collect Reward';
                if (isFinal && !dungeonRun.state.guardianDefeated) return 'Locked: defeat the Guardian';
                return 'Press E to Open Chest';
            },
            interact: () =>
            {
                const ui = getUi();
                if (isFinal && !dungeonRun.state.guardianDefeated) return ui.toasts.show(DUNGEON_MESSAGES.chestLocked, 'error');
                const firstOpen = !record();
                const { record: chest, grantedQty } = dungeonRun.openChest(chestId, isFinal, () => rollLoot(DUNGEON_LOOT));
                if (firstOpen) this.playChestOpen(image);

                const name = itemDef(chest.itemId).name;
                if (grantedQty > 0) ui.toasts.show(`You found: ${name}${grantedQty > 1 ? ` ×${grantedQty}` : ''}`, 'reward', itemIconUrl(chest.itemId));
                if (!chest.granted) ui.toasts.show(`Your bag is full! Make room, then press E to collect the ${name}.`, 'error');
                if (isFinal && dungeonRun.state.exitUnlocked && grantedQty > 0) this.revealPortal(true);
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

    private addPortal (x: number, y: number)
    {
        const px = x * TILE + TILE / 2;
        const py = (y + 1) * TILE + 6;
        this.portal = this.add.image(px, py, 'portal').setOrigin(0.5, 1).setDepth(py).setVisible(false);
        this.tweens.add({ targets: this.portal, scaleX: 1.08, scaleY: 0.95, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
        if (dungeonRun.state.exitUnlocked) this.revealPortal(false);

        this.addInteractable({
            x: px, y: py, range: 28,
            prompt: () => (dungeonRun.state.exitUnlocked ? 'Press E to Return to Village' : null),
            interact: () =>
            {
                if (!dungeonRun.complete()) return;
                getUi().toasts.show('Dungeon complete! Welcome back to the village.', 'reward');
                this.warpTo({ scene: 'Hub', spawn: 'fromDungeon' });
            },
        });
    }

    private revealPortal (announce: boolean)
    {
        if (!this.portal || this.portal.visible) return;
        this.portal.setVisible(true).setAlpha(0);
        this.tweens.add({ targets: this.portal, alpha: 1, duration: 600 });
        if (announce) getUi().toasts.show(DUNGEON_MESSAGES.treasureClaimed, 'reward');
    }
}
