// The permanent crystal shop (village stall, press E). DECORATION-ONLY: unlock decorations and
// home upgrades once with crystals, then show / hide them in fixed slots. Crystals never buy combat
// power (weapons improve through stat points: press I).
// Pure view: reads playerState, asks it to buy / apply, and re-renders when it changes. The
// village behind the panel updates live (scenes/Hub.ts listens to the same state).

import { VILLAGE_GROUPS, VILLAGE_ITEM_IDS, villageItem, villageSelection, type VillageItemId } from '../shop/catalog';
import { onPlayerStateChange, player, type ShopResult } from '../state/playerState';
import { el, gameButton, keyHints, type Modal } from './dom';

const FAILURES: Record<Exclude<ShopResult, 'ok'>, string> = {
    poor: 'Not enough crystals.',
    owned: 'You already own that.',
    locked: 'You need to own that first.',
    saveFailed: 'Could not save. Free browser storage and try again (no crystals were spent).',
};

interface Row
{
    name: string;
    description: string;
    /** Small status tag: "Owned", "Owned · Shown"... */
    status?: string;
    /** Price of the next purchase, or null when there is nothing left to buy. */
    price: number | null;
    action?: { label: string; primary?: boolean; disabled?: string; run: () => ShopResult; done: string };
}

export class ShopPanel implements Modal
{
    private backdrop: HTMLElement;
    private crystals = el('span', 'chip chip--crystal shop__crystals');
    private list = el('div', 'shop__list');
    private notice = el('div', 'shop__notice hidden');
    private onClose: (() => void) | null = null;

    constructor (parent: HTMLElement)
    {
        this.notice.setAttribute('role', 'status');
        this.crystals.title = 'Your crystals';
        const close = gameButton('icon-btn', () => this.close(), '✕');
        close.setAttribute('aria-label', 'Close shop');
        close.title = 'Close (E or Esc)';

        const panel = el('section', 'shop panel',
            el('header', 'inventory__head', el('h2', '', 'Crystal Shop'), keyHints([['Esc', 'close']]), this.crystals, close),
            el('p', 'shop__intro', 'Decorate your village. Weapons grow stronger with stat points (press I), not crystals.'),
            this.notice, this.list);
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Crystal Shop');

        this.backdrop = el('div', 'shop-backdrop hidden', panel);
        this.backdrop.addEventListener('mousedown', (event) => { if (event.target === this.backdrop) this.close(); });
        parent.append(this.backdrop);

        onPlayerStateChange(() => { if (this.isOpen) this.render(); });
    }

    get isOpen ()
    {
        return !this.backdrop.classList.contains('hidden');
    }

    open (onClose: () => void)
    {
        this.onClose = onClose;
        this.setNotice('');
        this.backdrop.classList.remove('hidden');
        this.render();
    }

    close ()
    {
        if (!this.isOpen) return;
        this.backdrop.classList.add('hidden');
        const done = this.onClose;
        this.onClose = null;
        done?.();
    }

    handleKey (key: string)
    {
        if (key === 'escape' || key === 'e') this.close();
    }

    private setNotice (text: string, error = false)
    {
        this.notice.textContent = text;
        this.notice.classList.toggle('is-error', error);
        this.notice.classList.toggle('hidden', !text);
    }

    // ------------------------------------------------------------ rows

    private villageRow (id: VillageItemId): Row
    {
        const { name, description, price, slot } = villageItem(id);
        const owned = player.shop.villageUnlocks.includes(id);
        if (!owned)
        {
            return { name, description, price, action: { label: 'Buy', primary: true, run: () => player.buyVillageItem(id), done: `${name} unlocked and placed in the village!` } };
        }
        const shown = villageSelection(player.shop, slot) === id;
        return {
            name, description, status: shown ? 'Owned · Shown' : 'Owned', price: null,
            action: shown
                ? { label: 'Remove', run: () => player.applyVillage(slot, null), done: `${name} put away.` }
                : { label: 'Apply', primary: true, run: () => player.applyVillage(slot, id), done: `${name} applied.` },
        };
    }

    // ------------------------------------------------------------ render

    private rowElement (row: Row)
    {
        const poor = row.price !== null && row.price > player.crystals;
        const action = row.action;
        const blocked = action?.disabled ?? (poor ? 'Not enough crystals' : '');
        const button = action ? gameButton(`btn btn--small${action.primary ? ' btn--primary' : ''}`, () =>
        {
            const result = action.run();
            // A successful purchase re-renders through the player-state listener.
            this.setNotice(result === 'ok' ? action.done : FAILURES[result], result !== 'ok');
            if (result !== 'ok') this.render();
        }, action.label) : null;
        if (button && blocked) { button.disabled = true; button.title = blocked; }

        return el('article', `shop-row${row.price === null && !action ? ' is-done' : ''}`,
            el('div', 'shop-row__text',
                el('div', 'shop-row__title', el('strong', '', row.name), row.status ? el('span', 'tag tag--muted', row.status) : null),
                el('p', 'shop-row__desc', row.description),
                blocked && action ? el('p', 'shop-row__blocked', blocked) : null),
            el('div', 'shop-row__buy',
                row.price !== null ? el('span', `shop-row__price${poor ? ' is-poor' : ''}`, String(row.price)) : null,
                button));
    }

    private render ()
    {
        this.crystals.textContent = String(player.crystals);

        const section = (title: string, rows: Row[]) => [el('h3', 'shop__section', title), ...rows.map((row) => this.rowElement(row))];
        const scroll = this.list.scrollTop;
        this.list.replaceChildren(...VILLAGE_GROUPS.flatMap((group) => section(group, VILLAGE_ITEM_IDS.filter((id) => villageItem(id).group === group).map((id) => this.villageRow(id)))));
        this.list.scrollTop = scroll;
    }
}
