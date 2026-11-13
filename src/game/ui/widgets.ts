// Small overlay widgets: HUD (location, crystals, dungeon health + objective), toasts,
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

    constructor (parent: HTMLElement)
    {
        this.crystals.title = 'Number Crystals';
        this.health.setAttribute('role', 'meter');
        this.health.setAttribute('aria-label', 'Health');
        parent.append(
            el('div', 'hud', el('div', 'hud__row', this.location, this.crystals), this.health, this.objective),
            this.hints,
        );
        this.renderCrystals();
        this.setCombat(false);
        onPlayerStateChange(() => this.renderCrystals());
    }

    setLocation (name: string)
    {
        this.location.textContent = name;
    }

    /** Health bar, objective and combat key hints only exist in combat areas (the dungeon). */
    setCombat (combat: boolean)
    {
        this.health.classList.toggle('hidden', !combat);
        if (!combat) this.setObjective(null);
        this.hints.replaceChildren(combat
            ? keyHints([['WASD', 'move'], ['LMB', 'melee'], ['RMB', 'bow'], ['F', 'heal'], ['E', 'use'], ['I', 'bag']])
            : keyHints([['WASD', 'move'], ['E', 'talk'], ['I', 'bag']]));
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

    setObjective (text: string | null)
    {
        this.objective.textContent = text ? `Objective: ${text}` : '';
        this.objective.classList.toggle('hidden', !text);
    }

    private renderCrystals ()
    {
        this.crystals.textContent = String(player.count('number_crystal'));
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
    private onRetry: (() => void) | null = null;

    constructor (parent: HTMLElement)
    {
        const retry = gameButton('btn btn--primary death__retry', () => this.retry(), 'Retry Dungeon');
        this.root = el('div', 'death hidden',
            el('div', 'death__card',
                el('h2', 'death__title', 'You Died'),
                el('p', '', 'The dungeon claims another adventurer... for now. Your gear and earlier rewards are safe.'),
                retry,
                keyHints([['E', 'retry']])));
        this.root.setAttribute('role', 'alertdialog');
        this.root.setAttribute('aria-label', 'You died');
        parent.append(this.root);
    }

    open (onRetry: () => void)
    {
        this.onRetry = onRetry;
        this.root.classList.remove('hidden');
    }

    handleKey (key: string)
    {
        if (isConfirm(key)) this.retry();
    }

    private retry ()
    {
        if (!this.onRetry) return;
        const done = this.onRetry;
        this.onRetry = null;
        this.root.classList.add('hidden');
        done();
    }
}
