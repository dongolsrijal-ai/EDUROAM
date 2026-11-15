// Small overlay widgets: HUD (location, crystals, level, dungeon health + arrows / mana +
// objective), toasts,
// floating combat text, the interaction tag and the death screen.

import { onPlayerStateChange, player } from '../state/playerState';
import { el, gameButton, isConfirm, keyHints, type Modal } from './dom';

export class Hud
{
    private location = el('div', 'chip');
    private crystals = el('div', 'chip chip--crystal');
    private healthFill = el('div', 'health__fill');
    private healthLag = el('div', 'health__lag');
    private healthText = el('div', 'health__text');
    private health = el('div', 'health hidden', el('div', 'health__bar', this.healthLag, this.healthFill), this.healthText);
    private objective = el('div', 'objective hidden');
    private hints = el('div', 'move-hint chip');
    private level = el('div', 'chip chip--level');
    private arrows = new ResourceBar('ARROWS', 'resource--arrows');
    private mana = new ResourceBar('MANA', 'resource--mana');
    private resources = el('div', 'resources hidden', this.arrows.root, this.mana.root);
    private row = el('div', 'hud__row', this.location, this.crystals, this.level);

    constructor (parent: HTMLElement)
    {
        this.crystals.title = 'Number Crystals';
        this.health.setAttribute('role', 'meter');
        this.health.setAttribute('aria-label', 'Health');
        parent.append(
            el('div', 'hud', this.row, this.health, this.resources, this.objective),
            this.hints,
        );
        this.level.title = 'Level and unspent stat points (press I)';
        this.renderCrystals();
        this.setCombat(false);
        onPlayerStateChange(() => this.renderCrystals());
    }

    /** Extra chip in the top row (e.g. the Pomodoro timer). */
    addChip (chip: HTMLElement)
    {
        this.row.append(chip);
    }

    setLocation (name: string)
    {
        this.location.textContent = name;
    }

    /** Health bar, objective and combat key hints only exist in combat areas (the dungeon). */
    setCombat (combat: boolean)
    {
        this.health.classList.toggle('hidden', !combat);
        this.resources.classList.toggle('hidden', !combat);
        if (!combat) this.setObjective(null);
        this.hints.replaceChildren(combat
            ? keyHints([['WASD', 'move/aim'], ['J', 'sword'], ['K', 'bow'], ['L', 'staff'], ['F', 'heal'], ['E', 'use'], ['I', 'stats']])
            : keyHints([['WASD', 'move'], ['E', 'talk'], ['I', 'bag & stats']]));
        // Restart the fade-out animation for the new hints.
        this.hints.classList.remove('move-hint');
        void this.hints.offsetWidth;
        this.hints.classList.add('move-hint');
    }

    setHealth (hp: number, max: number)
    {
        const pct = `${Math.max(0, Math.min(100, (hp / max) * 100))}%`;
        this.healthFill.style.width = pct;
        this.healthLag.style.width = pct; // trails behind (slower transition) to show damage taken
        this.healthText.textContent = `HP: ${Math.max(0, Math.ceil(hp))} / ${max}`;
        this.health.setAttribute('aria-valuenow', String(Math.ceil(hp)));
        this.health.setAttribute('aria-valuemax', String(max));
        this.health.classList.toggle('is-low', hp / max <= 0.3);
    }

    /** Arrow + mana pools (bars + "ARROWS 6/8", "MANA 24/30"). */
    setResources (r: { arrows: number; maxArrows: number; mana: number; maxMana: number })
    {
        this.arrows.set(r.arrows, r.maxArrows);
        this.mana.set(r.mana, r.maxMana);
    }

    setObjective (text: string | null)
    {
        this.objective.textContent = text ? `Objective: ${text}` : '';
        this.objective.classList.toggle('hidden', !text);
    }

    private renderCrystals ()
    {
        this.crystals.textContent = String(player.count('number_crystal'));
        const { level, unspent } = player.progress;
        this.level.textContent = unspent ? `Lv ${level} · ${unspent} pts` : `Lv ${level}`;
        this.level.classList.toggle('has-points', unspent > 0);
    }
}

/** A small labelled bar with a whole-number count, e.g. "ARROWS 6/8". */
class ResourceBar
{
    readonly root: HTMLElement;
    private fill = el('div', 'resource__fill');
    private text = el('div', 'resource__text');

    constructor (private label: string, modifier: string)
    {
        this.root = el('div', `resource ${modifier}`, el('div', 'resource__bar', this.fill), this.text);
        this.root.setAttribute('role', 'meter');
        this.root.setAttribute('aria-label', label);
    }

    set (value: number, max: number)
    {
        const whole = Math.floor(value);
        this.fill.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
        this.text.textContent = `${this.label} ${whole}/${max}`;
        this.root.setAttribute('aria-valuenow', String(whole));
        this.root.setAttribute('aria-valuemax', String(max));
        this.root.classList.toggle('is-empty', whole === 0);
    }
}

export class Toasts
{
    private root = el('div', 'toasts');

    constructor (parent: HTMLElement)
    {
        this.root.setAttribute('role', 'status');
        parent.append(this.root);
    }

    show (message: string, kind: 'info' | 'reward' | 'error' = 'info', icon?: string)
    {
        let image: HTMLImageElement | null = null;
        if (icon)
        {
            image = el('img', 'toast__icon');
            image.src = icon;
            image.alt = '';
        }
        const toast = el('div', `toast toast--${kind}`, image, message);
        this.root.append(toast);
        window.setTimeout(() => toast.classList.add('is-leaving'), 3000);
        window.setTimeout(() => toast.remove(), 3500);
    }
}

/** Rising combat text ("-5", "+20 HP") at a CSS-pixel position. */
export class Floaters
{
    private root = el('div', 'floaters');

    constructor (parent: HTMLElement)
    {
        parent.append(this.root);
    }

    spawn (text: string, x: number, y: number, kind: 'damage' | 'hurt' | 'heal' | 'info' = 'damage')
    {
        const node = el('div', `floater floater--${kind}`, text);
        node.style.left = `${Math.round(x)}px`;
        node.style.top = `${Math.round(y)}px`;
        this.root.append(node);
        window.setTimeout(() => node.remove(), 900);
    }
}

/** Positioned above the nearest NPC (name + subject) or interactable object (prompt). */
export class TalkTag
{
    private name = el('span', 'talk-tag__name');
    private subject = el('span', 'talk-tag__subject');
    private root = el('div', 'talk-tag hidden', this.name, this.subject, el('span', 'key', 'E'));

    constructor (parent: HTMLElement)
    {
        parent.append(this.root);
    }

    show (name: string, subject: string, x: number, y: number)
    {
        if (this.name.textContent !== name) this.name.textContent = name;
        if (this.subject.textContent !== subject) this.subject.textContent = subject;
        this.root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, calc(-100% - 6px))`;
        this.root.classList.remove('hidden');
    }

    /** Object prompt such as "Press E to Open Chest". */
    showPrompt (prompt: string, x: number, y: number)
    {
        this.show(prompt, '', x, y);
    }

    hide ()
    {
        this.root.classList.add('hidden');
    }
}

/** "You Died" overlay with a Retry button (E / Enter also retry). */
export class DeathScreen implements Modal
{
    private root: HTMLElement;
    private onRetry: (() => boolean | void) | null = null;
    private onReturn: (() => boolean | void) | null = null;

    constructor (parent: HTMLElement)
    {
        const retry = gameButton('btn btn--primary death__retry', () => this.choose(this.onRetry), 'Retry Dungeon');
        const leave = gameButton('btn death__return', () => this.choose(this.onReturn), 'Return to Village');
        this.root = el('div', 'death hidden',
            el('div', 'death__card',
                el('h2', 'death__title', 'You Died'),
                el('p', '', 'The dungeon claims another adventurer... for now. Your gear and earlier rewards are safe. The dungeon timer is paused.'),
                el('div', 'death__actions', leave, retry),
                keyHints([['E', 'retry'], ['V', 'village']])));
        this.root.setAttribute('role', 'alertdialog');
        this.root.setAttribute('aria-label', 'You died');
        parent.append(this.root);
    }

    open (onRetry: () => boolean | void, onReturn?: () => boolean | void)
    {
        this.onRetry = onRetry;
        this.onReturn = onReturn ?? null;
        this.root.classList.remove('hidden');
    }

    handleKey (key: string)
    {
        if (isConfirm(key)) this.choose(this.onRetry);
        else if (key === 'v') this.choose(this.onReturn);
    }

    private choose (action: (() => boolean | void) | null)
    {
        if (!action) return;
        if (action() === false) return;
        this.close();
    }

    close ()
    {
        this.onRetry = null;
        this.onReturn = null;
        this.root.classList.add('hidden');
    }
}

/** Boss name + health bar (top centre) with an introduction banner. */
export class BossBar
{
    private name = el('div', 'boss__name');
    private fill = el('div', 'boss__fill');
    private lag = el('div', 'boss__lag');
    private root = el('div', 'boss hidden', this.name, el('div', 'boss__bar', this.lag, this.fill));
    private banner = el('div', 'boss-intro hidden');

    constructor (parent: HTMLElement)
    {
        this.root.setAttribute('role', 'meter');
        parent.append(this.root, this.banner);
    }

    /** Big name card, then the bar appears. */
    intro (title: string, subtitle: string, ms = 1800)
    {
        this.banner.replaceChildren(el('div', 'boss-intro__title', title), el('div', 'boss-intro__sub', subtitle));
        this.banner.classList.remove('hidden');
        window.setTimeout(() => this.banner.classList.add('hidden'), ms);
    }

    show (name: string)
    {
        this.name.textContent = name;
        this.root.classList.remove('hidden', 'is-enraged');
        this.root.setAttribute('aria-label', name);
    }

    setHp (hp: number, max: number)
    {
        const pct = `${Math.max(0, Math.min(100, (hp / max) * 100))}%`;
        this.fill.style.width = pct;
        this.lag.style.width = pct;
        this.root.setAttribute('aria-valuenow', String(Math.ceil(hp)));
    }

    enrage ()
    {
        this.root.classList.add('is-enraged');
    }

    hide ()
    {
        this.root.classList.add('hidden');
        this.banner.classList.add('hidden');
    }
}
