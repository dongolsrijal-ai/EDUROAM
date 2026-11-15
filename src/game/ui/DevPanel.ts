// DEV TEST MODE (dev builds only; loaded through a DEV-guarded dynamic import, so production builds
// never contain it). Toggle with the DEV button or the ` key.
//   timer    finish focus now, short focus length, restart focus
//   tower    tower level override, biome / floors / start floor / seed replay, direct dungeon entry
//   combat   spawn any enemy, kill all, boss test, hitbox overlay, full HP

import { gameKeysAllowed } from '../input/inputGuard';
import { ENEMY_TYPES, type EnemyTypeId } from '../combat/enemyTypes';
import { enemyMultipliers } from '../combat/scaling';
import { DEV, devFlags } from '../dev/devFlags';
import { devHooks } from '../dev/devHooks';
import { nextTower } from '../dev/nextTower';
import { dungeonRun } from '../state/dungeonRun';
import { player } from '../state/playerState';
import { pomodoro } from '../state/pomodoro';
import { tower } from '../state/tower';
import { BIOME_IDS, BIOMES, type BiomeId } from '../world/dungeon/biomes';
import { beginTowerRun, type RunOverrides } from '../world/dungeon/runOptions';
import { el, gameButton } from './dom';
import type { Toasts } from './widgets';

const select = (options: [string, string][], value = '') =>
{
    const s = el('select', 'dev__input');
    for (const [v, label] of options) s.append(new Option(label, v, false, v === value));
    return s;
};
const input = (type: string, value: string, placeholder = '') =>
{
    const i = el('input', 'dev__input');
    i.type = type;
    i.value = value;
    i.placeholder = placeholder;
    return i;
};
const button = (label: string, onClick: () => void) =>
{
    return gameButton('dev__btn', onClick, label);
};
const row = (...children: (HTMLElement | string)[]) => el('div', 'dev__row', ...children);

export class DevPanel
{
    private root = el('div', 'dev hidden');
    private info = el('div', 'dev__info');
    private biome = select([['', 'Random biome'], ...BIOME_IDS.map((id): [string, string] => [id, BIOMES[id].name])]);
    private floors = select([['', 'Random floors'], ['2', '2 floors'], ['3', '3 floors']]);
    private startFloor = select([['1', 'Start floor 1'], ['2', 'Start floor 2'], ['3', 'Start floor 3']]);
    private seed = input('text', '', 'Seed (blank = random)');
    private level = input('number', String(tower.state.towerLevel));
    private playerLevel = input('number', '1');
    private focus = input('number', String(devFlags.get('focusSeconds') || ''), 'sec');
    private breakLength = input('number', String(devFlags.get('dungeonSeconds') || ''), 'sec');
    private enemy = select((Object.keys(ENEMY_TYPES) as EnemyTypeId[]).map((id) => [id, ENEMY_TYPES[id].name]));
    private hitboxes = input('checkbox', '');

    constructor (parent: HTMLElement, private toasts: Toasts)
    {
        if (!DEV) return;
        this.level.min = '1';
        this.level.max = '99';
        this.focus.setAttribute('aria-label', 'Study duration in seconds');
        this.breakLength.setAttribute('aria-label', 'Dungeon break duration in seconds');
        this.hitboxes.checked = devFlags.get('hitboxes');
        this.hitboxes.addEventListener('change', () => devFlags.set('hitboxes', this.hitboxes.checked));

        const toggle = button('DEV', () => this.toggle());
        toggle.className = 'dev-toggle';
        toggle.title = 'Dev test mode (`)';

        this.root.append(
            el('div', 'dev__title', 'Dev test mode'),
            this.info,
            el('div', 'dev__section', 'Player progression (XP here is dev-only)'),
            row(button('+100 XP', () => this.xp(100)), button('+1000 XP', () => this.xp(1000))),
            row(this.playerLevel, button('Set player level', () =>
                this.note(player.devSetLevel(Number(this.playerLevel.value) || 1) ? `Level ${player.progress.level}, ${player.progress.unspent} unspent points.` : 'Could not save.'))),
            row(button('+3 stat points', () => this.note(player.devGivePoints(3) ? `${player.progress.unspent} unspent points.` : 'Could not save.')),
                button('Reset stats (refund)', () => this.note(player.devResetStats() ? `Refunded: ${player.progress.unspent} unspent points.` : 'Could not save.'))),
            row(button('Refill arrows', () => this.note(devHooks.scene?.devRefill?.('arrows') ? 'Arrows full.' : 'Only in the dungeon.')),
                button('Refill mana', () => this.note(devHooks.scene?.devRefill?.('mana') ? 'Mana full.' : 'Only in the dungeon.'))),
            el('div', 'dev__section', 'Crystal shop'),
            row(button('+50 crystals', () => this.note(player.addItem('number_crystal', 50) ? 'Bag full: some crystals did not fit.' : `Crystals: ${player.crystals}.`))),
            el('div', 'dev__section', 'Study timer'),
            row(button('Finish focus now', () => { pomodoro.skipFocus(); this.note('Focus finished: tower open.'); }),
                button('Restart focus', () => { pomodoro.restartFocus(); this.note('Focus restarted.'); })),
            row(this.focus, button('Set focus length (s, 0 = 25 min)', () =>
            {
                devFlags.set('focusSeconds', Math.max(0, Math.floor(Number(this.focus.value) || 0)));
                pomodoro.restartFocus();
                this.note(`Focus length ${devFlags.get('focusSeconds') || 1500}s.`);
            })),
            row(this.breakLength, button('Set break length (s, 0 = 10 min)', () =>
            {
                devFlags.set('dungeonSeconds', Math.max(0, Math.floor(Number(this.breakLength.value) || 0)));
                this.note(`Dungeon break ${devFlags.get('dungeonSeconds') || 600}s.`);
            })),
            el('div', 'dev__section', 'Tower'),
            row(button('Next Tower', () =>
            {
                if (!devHooks.scene) return this.note('Wait for the world to load.');
                if (!nextTower()) return this.note('Run could not be saved; tower was not skipped.');
                devHooks.scene.devGoTo('Dungeon');
                this.level.value = String(tower.state.towerLevel);
                this.note(`Skipped to tower ${dungeonRun.state.towerLevel}. No rewards granted.`);
            })),
            row(this.level, button('Set tower level', () =>
            {
                tower.setLevel(Number(this.level.value) || 1);
                this.note(`Tower level ${tower.state.towerLevel} (applies to the next run).`);
            })),
            row(this.biome, this.floors),
            row(this.startFloor, this.seed),
            row(button('Start run (enter dungeon)', () => this.startRun(false)),
                button('Replay current seed', () => { this.seed.value = String(dungeonRun.state.seed); this.startRun(false); })),
            el('div', 'dev__section', 'Combat (dungeon)'),
            row(this.enemy, button('Spawn', () => this.inDungeon((s) =>
                this.note(s.devSpawn?.(this.enemy.value as EnemyTypeId) ? `Spawned ${this.enemy.value}.` : 'No free spot near you to spawn.')))),
            row(button('Kill all', () => this.inDungeon((s) => this.note(`Defeated ${s.devKillAll?.() ?? 0} enemies.`))),
                button('Full HP', () => this.inDungeon(() =>
                {
                    if (dungeonRun.state.hp <= 0) return this.note('You are dead: use Retry on the death screen.');
                    dungeonRun.heal(999);
                    this.note(`HP ${dungeonRun.state.hp}.`);
                }))),
            row(button('Boss test (final floor)', () => this.startRun(true)),
                button('Go to boss room', () => this.inDungeon((s) => s.devToBoss?.()))),
            el('label', 'dev__row dev__check', this.hitboxes, 'Hitbox overlay (bodies / hurtboxes / attacks)'),
        );
        parent.append(this.root, toggle);

        // Typing in the panel never reaches the game: input/inputGuard.ts blocks game keys while any field has focus.
        window.addEventListener('keydown', (e) =>
        {
            if (e.key === '`' && gameKeysAllowed(e)) this.toggle();
        });
        window.setInterval(() => { if (!this.root.classList.contains('hidden')) this.renderInfo(); }, 500);
    }

    private toggle ()
    {
        this.root.classList.toggle('hidden');
        this.level.value = String(tower.state.towerLevel);
        this.renderInfo();
    }

    private renderInfo ()
    {
        const r = dungeonRun.state;
        const p = pomodoro.state;
        const scaling = enemyMultipliers({ towerLevel: r.towerLevel, floorIndex: r.floorIndex });
        const bossScaling = enemyMultipliers({ towerLevel: r.towerLevel, floorIndex: r.floorIndex }, true);
        this.info.textContent = [
            `Tower level ${tower.state.towerLevel} · runs ${tower.state.runsCompleted}`,
            r.active ? `Run: ${r.biomeId} · floor ${r.floorIndex}/${r.floorCount} · TL ${r.towerLevel} · seed ${r.seed}` : 'No active run',
            ...(r.active ? [`Enemies: HP ×${scaling.hp.toFixed(2)} · damage ×${scaling.damage.toFixed(2)}`,
                `Hades: HP ×${bossScaling.hp.toFixed(2)} · damage ×${bossScaling.damage.toFixed(2)}`] : []),
            `Timer: ${p.phase} · session ${p.session}`,
            `Scene: ${devHooks.scene?.sceneKey ?? '-'}`,
        ].join('\n');
    }

    private xp (amount: number)
    {
        const r = player.devAddXp(amount);
        const p = player.progress;
        this.note(r.status === 'awarded' ? `+${r.xp} XP: level ${p.level} (${p.xp}/${p.xpToNext}), ${p.unspent} unspent.` : 'Could not save.');
    }

    private note (text: string)
    {
        this.toasts.show(`[dev] ${text}`);
        this.renderInfo();
    }

    private inDungeon (fn: (scene: NonNullable<typeof devHooks.scene>) => void)
    {
        const scene = devHooks.scene;
        if (!scene || scene.sceneKey !== 'Dungeon') return this.note('Enter the dungeon first.');
        fn(scene);
    }

    /** New run with the chosen overrides (bypasses the focus timer), optionally straight to the boss. */
    private startRun (bossTest: boolean)
    {
        const overrides: RunOverrides = {};
        if (this.biome.value) overrides.biomeId = this.biome.value as BiomeId;
        if (this.floors.value) overrides.floorCount = Number(this.floors.value) as 2 | 3;
        const seed = Number.parseInt(this.seed.value, 10);
        if (Number.isFinite(seed)) overrides.seed = seed >>> 0;

        if (!devHooks.scene) return this.note('Wait for the world to load.');
        if (!beginTowerRun(overrides)) return this.note('Run could not be saved.');
        const target = bossTest ? dungeonRun.state.floorCount : Math.min(Number(this.startFloor.value) || 1, dungeonRun.state.floorCount);
        while (dungeonRun.state.floorIndex < target && dungeonRun.advanceFloor()) { /* jump ahead */ }
        pomodoro.skipFocus();
        pomodoro.enterDungeon();

        const previous = devHooks.scene;
        previous.devGoTo('Dungeon');
        // Boss test: teleport once the NEW dungeon scene has registered (not the old one).
        if (bossTest)
        {
            const started = Date.now();
            const wait = window.setInterval(() =>
            {
                const scene = devHooks.scene;
                const ready = scene && scene.sceneKey === 'Dungeon' && (scene !== previous || previous.sceneKey !== 'Dungeon' || Date.now() - started > 600);
                if (ready) { window.clearInterval(wait); scene.devToBoss?.(); }
                else if (Date.now() - started > 8000) { window.clearInterval(wait); this.note('Boss test: dungeon did not load.'); }
            }, 100);
        }
        const r = dungeonRun.state;
        this.note(`Run ${r.biomeId} · ${r.floorCount} floors · floor ${r.floorIndex} · seed ${r.seed} · TL ${r.towerLevel}`);
    }
}
