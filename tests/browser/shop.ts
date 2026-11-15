// Real Phaser + DOM test of the crystal shop in an isolated browser profile (run by
// tests/browserShop.mjs): stall interaction, buying / upgrading with crystals, the village
// changing live, persistence across a real page reload, and the staff in the dungeon.
//   ?shot=1  stops with everything bought and the canvas frozen, for a screenshot.
import StartGame from '../../src/game/main';
import { devHooks } from '../../src/game/dev/devHooks';
import { player } from '../../src/game/state/playerState';

const result = document.getElementById('smoke-result')!;
const shot = new URLSearchParams(location.search).get('shot');
let simulatedTime = performance.now();
function check (value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until (predicate: () => unknown, label: string)
{
    for (let i = 0; i < 400; i++)
    {
        // Headless virtual time may throttle requestAnimationFrame: drive Phaser explicitly once booted.
        if (game.isRunning)
        {
            if (game.loop.running) game.loop.stop();
            game.step(simulatedTime += 25, 25);
        }
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const scenes = game.scene.getScenes(false).map((x: any) => `${x.scene.key}:${x.sys.settings.status}`).join(',');
    throw new Error(`Timed out: ${label}; booted=${game.isBooted} running=${game.isRunning} scenes=${scenes} dev=${devHooks.scene?.sceneKey}; errors=${(window as any).smokeErrors.join('\n')}`);
}
const q = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s);
const all = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const visible = (s: string) => { const n = q(s); return Boolean(n && n.offsetParent !== null); };
const row = (name: string) =>
{
    const found = all('.shop-row').find((r) => r.querySelector('strong')?.textContent === name);
    check(found, `No shop row "${name}": ${all('.shop-row strong').map((s) => s.textContent).join(' | ')}`);
    return found;
};
const press = (name: string, label: string) =>
{
    const button = [...row(name).querySelectorAll('button')].find((b) => b.textContent === label);
    check(button && !button.disabled, `"${label}" not available on "${name}": ${row(name).textContent}`);
    button.click();
};
const crystals = () => Number(q('.shop__crystals')!.textContent);
const game = StartGame('game-container');

/** Freezes the game with the canvas copied into an <img> (headless screenshots miss WebGL). */
async function freeze ()
{
    for (let i = 0; i < 20; i++) await until(() => true, 'settle');
    const canvas = game.canvas;
    const rect = canvas.getBoundingClientRect();
    game.renderer.snapshot((img) =>
    {
        Object.assign((img as HTMLImageElement).style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        canvas.style.visibility = 'hidden';
        canvas.parentElement!.append(img as HTMLImageElement);
    });
    await until(() => true, 'render snapshot');
    await new Promise(() => undefined);
}

try
{
    await until(() => game.scene.isActive('Hub') && devHooks.scene?.sceneKey === 'Hub', 'hub boot');
    const hub = game.scene.getScene('Hub') as any;

    if (localStorage.getItem('shop.reloaded'))
    {
        // ---- after a real reload: everything bought is still there and drawn.
        check(player.crystals === Number(localStorage.getItem('shop.crystals')), `crystals persisted: ${player.crystals}`);
        check(player.progress.alloc.sword === 1 && player.progress.unspent === 2, `stat allocation persisted: ${JSON.stringify(player.progress)}`);
        check(hub.house.image.texture.key === 'house-1-slate-wood-0', `home style persisted: ${hub.house.image.texture.key}`);
        check(hub.tileset.image.key === 'ground-cobble', `path style persisted: ${hub.tileset.image.key}`);
        check(hub.lookObjects.some((o: any) => o.image.texture.key === 'fountain') && hub.lookObjects.some((o: any) => o.image.texture.key === 'street-light'), 'decor persisted');
        check(!hub.lookObjects.some((o: any) => o.image.texture.key === 'bench'), 'a removed decoration stays removed');

        // ---- dungeon: keyboard weapons + arrow / mana HUD; dev kills never pay XP.
        const click = (label: string) => all('button').find((b) => b.textContent === label)!.click();
        await until(() => all('button').some((b) => b.textContent === 'Next Tower'), 'DEV panel loaded');
        click('Finish focus now');
        click('Next Tower');
        await until(() => game.scene.isActive('Dungeon') && devHooks.scene?.sceneKey === 'Dungeon', 'dungeon');
        const dungeon = game.scene.getScene('Dungeon') as any;
        await until(() => dungeon.combat && /ARROWS 8\/8/.test(q('.hud')?.textContent ?? '') && /MANA 30\/30/.test(q('.hud')?.textContent ?? ''), 'arrow + mana bars');
        check(/J\s*sword/.test(q('.move-hint')?.textContent ?? '') && /L\s*staff/.test(q('.move-hint')?.textContent ?? ''), `keyboard weapon hints: ${q('.move-hint')?.textContent}`);
        const hold = (code: string, key: string, keyCode: number) =>
        {
            window.dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode } as KeyboardEventInit));
            return () => window.dispatchEvent(new KeyboardEvent('keyup', { key, code, keyCode } as KeyboardEventInit));
        };
        let release = hold('KeyK', 'k', 75);
        await until(() => /ARROWS [0-7]\/8/.test(q('.hud')?.textContent ?? ''), 'K shoots an arrow (bar drains)');
        release();
        release = hold('KeyL', 'l', 76);
        await until(() => dungeon.combat.arrows.getChildren().some((a: any) => a.texture.key === 'magic-bolt') || /MANA ([0-9]|1[0-9]|2[0-4])\/30/.test(q('.hud')?.textContent ?? ''), 'L casts the staff');
        release();
        const lifetime = () => player.progress.level * 100000 + player.progress.xp;
        const xpBefore = lifetime();
        check(dungeon.devSpawn('zombie'), 'dev spawn');
        click('Kill all');
        await until(() => dungeon.combat.liveEnemies.length === 0, 'dev kill');
        for (let i = 0; i < 10; i++) await until(() => true, 'settle');
        check(lifetime() === xpBefore, 'dev spawns / kills grant no XP');
        result.textContent = 'PASS: stall, decorations applied live, toggle, reload persistence, stats panel, keyboard weapons, arrow/mana HUD, no dev XP';
    }
    else
    {
        check(player.addItem('number_crystal', shot === 'manor' ? 900 : 600) === 0, 'grant test crystals');
        const start = player.crystals;

        // ---- the stall is a real interactable next to the square.
        const stall = hub.interactables.find((i: any) => i.prompt() === 'Press E to Shop');
        check(stall, 'shop stall is interactable');
        hub.player.setPosition(stall.x, stall.y + 8);
        hub.player.body.reset(stall.x, stall.y + 8);
        await until(() => hub.nearestInteraction()?.prompt === 'Press E to Shop', 'Press E prompt at the stall');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', keyCode: 69 } as KeyboardEventInit));
        await until(() => visible('.shop'), 'shop opens with E');
        check(crystals() === start, `crystals shown: ${crystals()}`);

        // ---- decoration-only: no weapon tab, no weapon rows.
        check(!all('.shop .tab').length && !all('.shop-row strong').some((n) => /Sword|Bow|Staff|Upgrade I+$/.test(n.textContent ?? '') && !/House/.test(n.textContent ?? '')), 'no weapon items in the shop');
        // ---- village: buying shows the item at once; apply / remove toggles it.
        check(all('.shop-row').length === 18, `18 village items: ${all('.shop-row').length}`);
        const kinds = () => hub.lookObjects.map((o: any) => o.image.texture.key);
        press('Fountain', 'Buy');
        await until(() => kinds().includes('fountain'), 'fountain appears in the village');
        const zonesWithFountain = hub.obstacles.getLength();
        press('Fountain', 'Remove');
        await until(() => !kinds().includes('fountain') && hub.obstacles.getLength() < zonesWithFountain, 'fountain and its collider removed');
        press('Fountain', 'Apply');
        await until(() => kinds().includes('fountain'), 'fountain back');
        press('Lamp Posts', 'Buy');
        press('Street Lights', 'Buy');
        await until(() => kinds().includes('street-light') && !kinds().includes('lamp-post'), 'one fence style per slot');
        press('House Upgrade I', 'Buy');
        press('Slate Roof', 'Buy');
        await until(() => hub.house.image.texture.key === 'house-1-slate-wood-0', 'home restyled');
        check(hub.house.image.y + hub.house.image.height === 6 * 16 + 64, 'taller home keeps its footprint');
        press('Cobblestone Paths', 'Buy');
        await until(() => hub.tileset.image.key === 'ground-cobble', 'paths repaved');
        press('Small Bench', 'Buy');
        press('Small Bench', 'Remove');
        if (shot)
        {
            for (const name of ['Lamp Posts', 'Potted Plants', 'Garden Patch', 'Bush Cluster', 'Wisteria Tree', 'Barrels & Crates', 'Signpost', 'Flower Beds', 'Window Shutters', 'Painted Door']) press(name, 'Buy');
            press('Small Bench', 'Apply');
            if (shot === 'manor') { press('House Upgrade II', 'Buy'); press('Street Lights', 'Buy'); press('Mossy Paths', 'Buy'); press('Lamp Posts', 'Apply'); }
            if (shot !== 'panel') q<HTMLButtonElement>('.shop .icon-btn')!.click();
            hub.player.setPosition(29 * 16, 15 * 16);
            hub.player.body.reset(29 * 16, 15 * 16);
            await freeze();
        }

        // ---- cannot overspend; closing returns control to the village.
        const left = crystals();
        check(left === player.crystals && left < start, 'HUD and state agree');
        localStorage.setItem('shop.crystals', String(left));
        q<HTMLButtonElement>('.shop .icon-btn')!.click();
        await until(() => !visible('.shop'), 'shop closes');
        check(hub.modal === null, 'village input restored');
        // ---- stats panel (press I): spend one dev-granted point on the Sword.
        check(player.devGivePoints(3), 'dev points');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', keyCode: 73 } as KeyboardEventInit));
        await until(() => visible('.inventory') && /Unspent points: 3/.test(q('.stats')?.textContent ?? ''), 'stats panel shows points');
        const swordRow = all('.stat-row').find((r) => r.querySelector('.stat-row__name')?.textContent === 'Sword')!;
        swordRow.querySelector('button')!.click();
        await until(() => /Unspent points: 2/.test(q('.stats')?.textContent ?? '') && player.stats().swordDamage > 12, 'point spent, sword damage up');
        check(!/Defense\s*\d+\s*$/.test(swordRow.textContent ?? '') && all('.stat-row').length === 4, 'exactly four stats: Health, Sword, Bow, Staff');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', keyCode: 73 } as KeyboardEventInit));
        await until(() => !visible('.inventory'), 'inventory closes');
        localStorage.setItem('shop.reloaded', '1');
        location.reload();
    }
}
catch (error)
{
    result.textContent = `FAIL: ${error instanceof Error ? error.stack : String(error)}`;
}
