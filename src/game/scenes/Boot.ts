import { Scene } from 'phaser';
import { generateTextures } from '../art/textures';
import { APPEARANCES } from '../npcs/appearances';
import { itemIconCanvas } from '../items/icons';
import { ITEM_DEFS, type ItemId } from '../items/itemDefs';
import { Player } from '../objects/Player';
import { dungeonRun } from '../state/dungeonRun';
import { getUi } from '../ui';

/** Loads / generates shared assets and the overlay UI, then starts the village (or the active dungeon run). */
export class Boot extends Scene
{
    constructor ()
    {
        super('Boot');
    }

    preload ()
    {
        // Real NPC sprites (if configured) replace the generated placeholders.
        this.load.setPath('assets');
        for (const { texture, asset } of Object.values(APPEARANCES))
        {
            if (asset) this.load.image(texture, asset);
        }
    }

    create ()
    {
        generateTextures(this);
        Player.createAnimations(this);
        // Item icons as textures too, so equipped weapons can be drawn in the player's hands.
        for (const id of Object.keys(ITEM_DEFS) as ItemId[]) this.textures.addCanvas(`item-${id}`, itemIconCanvas(id));

        const placeholders = Object.values(APPEARANCES).filter((a) => !a.asset).map((a) => a.label);
        if (placeholders.length)
        {
            console.info(`[assets] Using placeholder NPC art for: ${placeholders.join(', ')} (no sprite files in public/assets).`);
        }

        getUi();
        // A dungeon run in progress resumes there: the entrance is sealed until it is completed.
        this.scene.start(dungeonRun.state.active ? 'Dungeon' : 'Hub');
    }
}
