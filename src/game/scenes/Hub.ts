import { Tilemaps } from 'phaser';
import { TILE } from '../config';
import { GROUND, SOLID_GROUND } from '../art/textures';
import type { Rect } from '../world/objectTypes';
import { dungeonRun } from '../state/dungeonRun';
import { buildGround, DUNGEON_ENTRANCE, DUNGEON_RETURN, MAP_HEIGHT, MAP_WIDTH, PLAYER_START, VILLAGE_OBJECTS } from '../world/village';
import { WorldScene, type WorldLayout } from './WorldScene';

const tileCenter = (t: { x: number; y: number }) => ({ x: t.x * TILE + TILE / 2, y: t.y * TILE + TILE / 2 });

/** The village: the roguelite's safe starting hub (no combat here). */
export class Hub extends WorldScene
{
    readonly mapId = 'hub';
    readonly title = 'Village Hub';

    constructor ()
    {
        super('Hub');
    }

    /** Buildings may not sit on the village paths. */
    protected isProtectedArea (area: Rect)
    {
        return this.layout.ground.getTilesWithinWorldXY(area.x, area.y, area.w, area.h)
            .some((tile) => tile.index === GROUND.PATH || tile.index === GROUND.PATH_PEBBLE);
    }

    protected buildWorld (): WorldLayout
    {
        const map = this.make.tilemap({ data: buildGround(), tileWidth: TILE, tileHeight: TILE });
        const ground = map.createLayer(0, map.addTilesetImage('ground')!, 0, 0) as Tilemaps.TilemapLayer;
        ground.setCollision(SOLID_GROUND);

        for (const obj of VILLAGE_OBJECTS)
        {
            const spawned = this.placeObject(obj);
            if (obj.kind === 'dungeonEntrance' && obj.x === DUNGEON_ENTRANCE.x && spawned.interactPoint)
            {
                this.addInteractable({
                    ...spawned.interactPoint,
                    range: 30,
                    prompt: () => 'Press E to Enter Dungeon',
                    interact: () =>
                    {
                        dungeonRun.start('floor-1');
                        this.warpTo({ scene: 'Dungeon', spawn: 'start' });
                    },
                });
            }
        }

        return {
            ground,
            width: MAP_WIDTH * TILE,
            height: MAP_HEIGHT * TILE,
            spawns: { start: tileCenter(PLAYER_START), fromDungeon: tileCenter(DUNGEON_RETURN) },
        };
    }
}
