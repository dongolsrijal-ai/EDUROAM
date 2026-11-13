// Renders one BuildingRecord: sprite + collision boxes. Owned by WorldScene.

import { GameObjects, Physics, Scene } from 'phaser';
import type { BuildingRecord } from '../data/npcStore';
import type { Rect } from '../world/objectTypes';
import { BUILDING_H, BUILDING_TYPES, BUILDING_W } from './buildingTypes';

export class Building
{
    readonly image: GameObjects.Image;
    readonly zones: GameObjects.Zone[];
    /** Whole sprite area (nothing else may be placed on it). */
    readonly area: Rect;

    constructor (scene: Scene, readonly record: BuildingRecord, obstacles: Physics.Arcade.StaticGroup)
    {
        const type = BUILDING_TYPES[record.type];
        this.image = scene.add.image(record.x, record.y, type.texture).setOrigin(0, 0);
        // Y-sort like every other world object.
        this.image.setDepth(record.y + BUILDING_H);
        this.area = { x: record.x, y: record.y, w: BUILDING_W, h: BUILDING_H };

        this.zones = type.colliders.map(({ x, y, w, h }) =>
        {
            const zone = scene.add.zone(record.x + x, record.y + y, w, h).setOrigin(0, 0);
            obstacles.add(zone);
            return zone;
        });
    }

    remove ()
    {
        for (const zone of this.zones) zone.destroy();
        this.image.destroy();
    }
}
