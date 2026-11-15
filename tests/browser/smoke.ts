// Real Phaser + DOM integration in an isolated browser profile. Never uses a player's profile.
import StartGame from '../../src/game/main';
import { devHooks } from '../../src/game/dev/devHooks';
import { dungeonRun } from '../../src/game/state/dungeonRun';
import { tower } from '../../src/game/state/tower';
import { pomodoro } from '../../src/game/state/pomodoro';
import { player } from '../../src/game/state/playerState';
import { npcStore } from '../../src/game/data/npcStore';
import { npcService } from '../../src/game/services/npcService';

const result = document.getElementById('smoke-result')!;
let manualClock = false;
let simulatedTime = 0;
function check (value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until (predicate: () => unknown, label: string)
{
    for (let i = 0; i < 400; i++)
    {
        if (manualClock) game.step(simulatedTime += 25, 25);
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out: ${label}; scene=${devHooks.scene?.sceneKey}; TL=${dungeonRun.state.towerLevel}; errors=${(window as any).smokeErrors.join('\n')}`);
}
function click (label: string)
{
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
    check(button, `Missing button: ${label}`);
    button.click();
}
const game = StartGame('game-container');

try
{
    await until(() => game.scene.isActive('Hub') && devHooks.scene?.sceneKey === 'Hub', 'hub boot');
    await until(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Next Tower'), 'DEV panel loaded');
    // Chromium's virtual-time mode may throttle requestAnimationFrame. Drive the actual
    // Phaser step explicitly so scene queues, physics, clocks and tweens advance reliably.
    game.loop.stop();
    simulatedTime = performance.now();
    manualClock = true;
    const saved = localStorage.getItem('smoke.expected');
    if (saved)
    {
        const expected = JSON.parse(saved);
        check(tower.state.towerLevel === expected.level, 'reload must not level up twice');
        check(tower.state.runsCompleted === 1, 'exactly one completed run after reload');
        check(JSON.stringify(player.inventory) === expected.inventory, 'inventory/rewards survive reload exactly');
        check(pomodoro.state.phase === 'focus', 'reload returns to studying');
        result.textContent = 'PASS: real Phaser hub, focus gate, room gates/waves, floor portal, Next Tower twice, cleanup, boss, chest rewards, completion and reload';
    }
    else
    {
        // Create NPC: only name, class, appearance, building (+ materials). No greeting /
        // personality / teaching-instruction fields to fill in.
        click('+ Add NPC');
        const labels = [...document.querySelectorAll('.npc-form .field__label')].map((l) => l.firstChild?.textContent?.trim() ?? '');
        check(['NPC name', 'Class / subject', 'Appearance', 'Building'].every((l) => labels.includes(l)), `NPC form fields: ${labels.join(', ')}`);
        check(!labels.some((l) => /Greeting|Personality|Teaching instructions/i.test(l)), `removed NPC form fields are gone: ${labels.join(', ')}`);
        click('Cancel');
        const spot = { map: 'hub' as const, x: 64, y: 64, npcX: 96, npcY: 120 };
        const maple = npcStore.create({ name: 'Professor Maple', subject: '5th Grade Mathematics', appearance: 'scientist', dialogue: [], minigameType: null }, spot);
        check(maple.ok, 'NPC created without greeting / personality / instructions');
        const hello = (await npcService.dialogue({ playerId: 'p', npcId: maple.value.id, source: 'game', moment: 'greeting' })).lines.map((l) => l.text).join(' ');
        check(/I'm Professor Maple, your 5th Grade Mathematics teacher/.test(hello), `natural self-introduction: ${hello}`);
        // Editing an older NPC through the form keeps its saved greeting / persona / instructions.
        const old = npcStore.create({ name: 'Old Prof', subject: 'History', appearance: 'scientist', dialogue: ['Hail, scholar!'], minigameType: null, personality: 'Grumpy', teachingInstructions: 'Dates first' }, spot);
        check(old.ok, 'legacy NPC');
        click(`NPCs ${npcStore.usage().npcs}/${npcStore.usage().maxNpcs}`);
        const row = [...document.querySelectorAll('.npc-row')].find((r) => r.textContent?.includes('Old Prof'));
        check(row, 'legacy NPC listed');
        [...row.querySelectorAll('button')].find((b) => b.textContent === 'Edit')!.click();
        const nameInput = document.querySelector<HTMLInputElement>('.npc-form input[maxlength="32"]')!;
        nameInput.value = 'Old Prof Renamed';
        click('Save changes');
        const kept = npcStore.get(old.value.id)!;
        check(kept.name === 'Old Prof Renamed' && kept.personality === 'Grumpy' && kept.teachingInstructions === 'Dates first' && kept.dialogue[0] === 'Hail, scholar!', 'legacy settings preserved on edit');
        npcStore.remove(maple.value.id);
        npcStore.remove(old.value.id);

        check(!pomodoro.canEnterDungeon(), 'new player must study first');
        const inventory = JSON.stringify(player.inventory);
        click('Finish focus now');
        check(pomodoro.state.phase === 'ready', 'finish focus opens tower');
        click('Next Tower');
        await until(() => game.scene.isActive('Dungeon') && devHooks.scene?.sceneKey === 'Dungeon', 'first tower');
        check(tower.state.towerLevel === 2, 'Next Tower advances exactly one');
        check(dungeonRun.state.hp === 50, 'full 50 HP');
        const firstId = dungeonRun.state.runId;
        const first = game.scene.getScene('Dungeon') as any;
        const floors = dungeonRun.state.floorCount;
        check(floors === 2 || floors === 3, 'runs have 2–3 floors');
        check(!first.combatCleared && !first.portal.visible, 'next floor stays locked before combat');
        for (const room of first.rooms.filter((r: any) => r.room.role === 'combat'))
        {
            const slot = room.slots[0];
            first.player.setPosition(slot.x, slot.y);
            first.player.body.reset(slot.x, slot.y);
            await until(() => room.locked, 'room gates close');
            check(room.gates.length > 0, 'room has physical gates');
            for (let wave = 0; wave < room.waves.length; wave++)
            {
                await until(() => !room.incoming && [...room.alive].some((e: any) => e.alive), 'room wave spawns');
                click('Kill all');
                await until(() => dungeonRun.isRoomCleared(room.room.id) || room.wave > wave, 'wave defeated');
            }
            check(dungeonRun.isRoomCleared(room.room.id) && !room.locked, 'room clears and gates reopen');
        }
        check(first.portal.visible, 'all combat rooms unlock the next floor');
        const climb = first.interactables.find((item: any) => item.prompt()?.startsWith('Press E to Climb'));
        check(climb, 'floor portal exists');
        const floorCombat = first.combat;
        climb.interact();
        await until(() => dungeonRun.state.floorIndex === 2 && first.combat !== floorCombat, 'floor portal regenerates next floor');
        check(dungeonRun.state.runId === firstId && dungeonRun.state.floorCount === floors, 'floor climb retains run identity');
        check(tower.state.towerLevel === 2 && tower.state.runsCompleted === 0, 'floor climb never completes the tower');
        const oldCombat = first.combat;
        const enemy = oldCombat.spawnEnemy('zombie', first.player.x + 50, first.player.y);
        oldCombat.context.fireProjectile({ x: first.player.x + 50, y: first.player.y }, 0, 10, 2, 'spell-orb');
        const shot = oldCombat.shots.getChildren()[0];
        const arrow = oldCombat.arrows.create(first.player.x + 40, first.player.y, 'arrow');
        arrow.setData('start', { x: arrow.x, y: arrow.y }).setData('damage', 3);
        dungeonRun.damage(10);
        click('Next Tower');
        await until(() => dungeonRun.state.runId !== firstId && first.combat !== oldCombat, 'tower restart');
        check(tower.state.towerLevel === 3 && dungeonRun.state.towerLevel === 3, 'second skip advances once');
        check(!enemy.active && !shot.active && !arrow.active, 'old enemies, shots and arrows destroyed');
        check(dungeonRun.state.hp === 50, 'skip heals');
        check(JSON.stringify(player.inventory) === inventory, 'skip grants no items');
        check(tower.state.runsCompleted === 0, 'skip grants no completion');
        check(document.querySelector('.dev__info')?.textContent?.includes('HP ×1.12'), 'panel displays current scaling');

        const beforeBossTest = dungeonRun.state.runId;
        click('Boss test (final floor)');
        await until(() => dungeonRun.state.runId !== beforeBossTest && first.boss?.alive, 'boss test intro');
        check(document.querySelector('.boss-intro')?.classList.contains('hidden') === false, 'boss intro visible');
        await until(() => first.boss && first.time.now >= first.boss.activeAt, 'boss activated');
        const boss = first.boss;
        boss.takeDamage(Math.floor(boss.stats.maxHp / 2) + 1, 0);
        check(boss.phase === 2, 'Hades phase 2');
        check(document.querySelector('.boss')?.classList.contains('is-enraged'), 'boss phase UI');
        click('Kill all');
        await until(() => dungeonRun.state.guardianDefeated, 'Hades defeat saved');
        for (const item of first.interactables)
        {
            if (item.prompt() === 'Press E to Open Chest') item.interact();
        }
        check(dungeonRun.state.finalChestOpened && dungeonRun.state.exitUnlocked, 'boss reward opens exit');
        const portal = first.interactables.find((item: any) => item.prompt() === 'Press E to Return to Village');
        check(portal, 'return portal exists');
        portal.interact();
        await until(() => game.scene.isActive('Hub') && devHooks.scene?.sceneKey === 'Hub', 'return to study');
        check(tower.state.towerLevel === 4 && tower.state.runsCompleted === 1, 'completion advances once');
        check(pomodoro.state.phase === 'focus' && pomodoro.state.completedSessions === 1, 'next study session');
        localStorage.setItem('smoke.expected', JSON.stringify({ level: 4, inventory: JSON.stringify(player.inventory) }));
        location.reload();
    }
}
catch (error)
{
    result.textContent = `FAIL: ${error instanceof Error ? error.stack : error}\n${(window as any).smokeErrors.join('\n')}`;
}
