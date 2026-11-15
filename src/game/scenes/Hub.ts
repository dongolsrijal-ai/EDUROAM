import { Tilemaps } from 'phaser';
import { TILE } from '../config';
import { drawHouse } from '../art/gardenArt';
import { isPathTile, SOLID_GROUND } from '../art/textures';
import { spawnCritters, startLeafDrift } from '../world/critters';
import { spawnObject, type Rect, type SpawnedObject } from '../world/objectTypes';
import { dungeonRun } from '../state/dungeonRun';
import { onPlayerStateChange, player as playerState } from '../state/playerState';
import { villageLook } from '../world/villageLook';
import { formatClock, pomodoro } from '../state/pomodoro';
import { getUi } from '../ui';
import { beginTowerRun } from '../world/dungeon/runOptions';
import { buildGround, DUNGEON_ENTRANCE, DUNGEON_RETURN, MAP_HEIGHT, MAP_WIDTH, PLAYER_START, VILLAGE_CRITTERS, VILLAGE_OBJECTS } from '../world/village';
import { WorldScene, type WorldLayout } from './WorldScene';

const tileCenter = (t: { x: number; y: number }) => ({ x: t.x * TILE + TILE / 2, y: t.y * TILE + TILE / 2 });

/** The village: the roguelite's safe starting hub (no combat here). */
export class Hub extends WorldScene
{
    readonly mapId = 'hub';
    readonly title = 'Village Hub';

    private tileset!: Tilemaps.Tileset;
    private house: SpawnedObject | null = null;
    /** Sprites + colliders of the bought village items currently shown. */
    private lookObjects: SpawnedObject[] = [];
    /** Signature of the applied look, so unrelated player-state changes do nothing. */
    private lookKey = '';

    constructor ()
    {
        super('Hub');
    }

    /**
     * Draws the crystal shop's village customization (home style, path style, fences, lamps,
     * decorations) from the saved selections. Called on entry and again whenever a selection
     * changes, so the village updates behind the open shop.
     */
    private applyVillageLook ()
    {
        const look = villageLook(playerState.shop);
        const key = JSON.stringify(look);
        if (key === this.lookKey) return;
        this.lookKey = key;

        // Home: taller styles keep the cottage's footprint, so the sprite is lifted, not moved.
        if (this.house)
        {
            const { image } = this.house;
            const bottom = image.y + image.height;
            image.setTexture(drawHouse(this, look.house));
            image.setY(bottom - image.height);
        }

        // Paths: same tiles, different tileset image.
        this.tileset.setImage(this.textures.get(look.tileset));

        for (const old of this.lookObjects)
        {
            old.image.destroy();
            for (const zone of old.zones) this.obstacles.remove(zone, true, true);
        }
        this.lookObjects = look.objects.map((obj) => spawnObject(this, this.obstacles, obj));
    }

    /** Buildings may not sit on the village paths. */
    /** Focus block finished (or a run is already in progress). */
    private dungeonOpen ()
    {
        return dungeonRun.state.active || pomodoro.canEnterDungeon();
    }

    protected isProtectedArea (area: Rect)
    {
        return this.layout.ground.getTilesWithinWorldXY(area.x, area.y, area.w, area.h)
            .some((tile) => isPathTile(tile.index));
    }

    protected buildWorld (): WorldLayout
    {
        const map = this.make.tilemap({ data: buildGround(), tileWidth: TILE, tileHeight: TILE });
        this.tileset = map.addTilesetImage('ground')!;
        const ground = map.createLayer(0, this.tileset, 0, 0) as Tilemaps.TilemapLayer;
        ground.setCollision(SOLID_GROUND);
        this.house = null;
        this.lookObjects = [];
        this.lookKey = '';

        for (const obj of VILLAGE_OBJECTS)
        {
            const spawned = this.placeObject(obj);
            if (obj.kind === 'house') this.house = spawned;
            if (obj.kind === 'shopStall' && spawned.interactPoint)
            {
                this.addInteractable({ ...spawned.interactPoint, range: 30, prompt: () => 'Press E to Shop', interact: () => this.openShop() });
            }
            if (obj.kind === 'dungeonEntrance' && obj.x === DUNGEON_ENTRANCE.x && spawned.interactPoint)
            {
                this.addInteractable({
                    ...spawned.interactPoint,
                    range: 30,
                    // Pomodoro: the tower opens after each focus block (a run already in progress always resumes).
                    prompt: () => (this.dungeonOpen() ? 'Press E to Enter Dungeon' : `Focus time: tower opens in ${formatClock(pomodoro.remaining())}`),
                    interact: () =>
                    {
                        if (!this.dungeonOpen())
                        {
                            getUi().toasts.show(`Keep studying! The tower opens in ${formatClock(pomodoro.remaining())}.`, 'error');
                            return;
                        }
                        if (!beginTowerRun())
                        {
                            getUi().toasts.show('The run could not be saved. Free browser storage and try again.', 'error');
                            return;
                        }
                        pomodoro.enterDungeon();
                        this.warpTo({ scene: 'Dungeon', spawn: 'start' });
                    },
                });
            }
        }

        // Crystal shop customization, kept in sync with purchases / applied styles.
        this.applyVillageLook();
        this.events.once('shutdown', onPlayerStateChange(() => this.applyVillageLook()));

        // Ambient garden life: friendly insects + the odd drifting leaf (decorative only, no collisions).
        spawnCritters(this, VILLAGE_CRITTERS);
        startLeafDrift(this);

        return {
            ground,
            width: MAP_WIDTH * TILE,
            height: MAP_HEIGHT * TILE,
            spawns: { start: tileCenter(PLAYER_START), fromDungeon: tileCenter(DUNGEON_RETURN) },
        };
    }
}
