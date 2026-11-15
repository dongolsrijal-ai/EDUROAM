import { Scene } from 'phaser';
import { generateTextures } from '../art/textures';
import { createGardenAnimations } from '../art/gardenArt';
import { createEnemyAnimations } from '../art/enemyArt';
import { APPEARANCES } from '../npcs/appearances';
import { itemIconCanvas, weaponIconCanvas } from '../items/icons';
import { ITEM_DEFS, type ItemId } from '../items/itemDefs';
import { Player } from '../objects/Player';
import { dungeonRun } from '../state/dungeonRun';
import { pomodoro } from '../state/pomodoro';
import { reconcileTowerProgress } from '../world/dungeon/runOptions';
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
        createGardenAnimations(this);
        createEnemyAnimations(this);
        // Item icons as textures too, plus the permanent Sword / Bow drawn in the player's hands.
        for (const id of Object.keys(ITEM_DEFS) as ItemId[]) this.textures.addCanvas(`item-${id}`, itemIconCanvas(id));
        for (const id of ['sword', 'bow'] as const) if (!this.textures.exists(`weapon-${id}`)) this.textures.addCanvas(`weapon-${id}`, weaponIconCanvas(id));

        const placeholders = Object.values(APPEARANCES).filter((a) => !a.asset).map((a) => a.label);
        if (placeholders.length)
        {
            console.info(`[assets] Using placeholder NPC art for: ${placeholders.join(', ')} (no sprite files in public/assets).`);
        }

        // A run finished through the portal always levels the tower, even if the page closed right
        // between the two saves (recordCompletion is idempotent per run id).
        const run = dungeonRun.state;
        reconcileTowerProgress();
        pomodoro.syncWithRun(run.active);

        getUi();
        // A dungeon run in progress resumes there: the entrance is sealed until it is completed.
        this.scene.start(dungeonRun.state.active ? 'Dungeon' : 'Hub');
    }
}
