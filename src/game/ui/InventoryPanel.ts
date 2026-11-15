// Minecraft-style inventory (press I): the Stats panel (level, XP, stat points for Health /
// Sword / Bow / Staff) and equipment on the left, a scrollable backpack with category tabs on the
// right, and details for the selected item. Pure view: reads playerState and asks it to move
// items or spend points (one point per click; the effect is immediate).

import { BACKPACK_SIZE, EQUIP_SLOTS, getSlot, refKey, type ItemStack, type SlotRef } from '../items/inventory';
import { EQUIP_SLOT_LABELS, itemDef, type EquipSlot, type ItemCategory, type ItemId } from '../items/itemDefs';
import { STAT_IDS, STAT_LABELS, type StatId } from '../progression/balance';
import { onPlayerStateChange, player } from '../state/playerState';
import { el, gameButton, keyHints, type Modal } from './dom';
import { itemDetails, slotElement } from './itemSlots';

type Tab = 'all' | ItemCategory;

const TABS: [Tab, string][] = [
    ['all', 'All Items'], ['weapon', 'Weapons'], ['armor', 'Armor'],
    ['consumable', 'Consumables'], ['material', 'Materials'], ['quest', 'Quest Items'],
];

const EMPTY_TAB_TEXT: Record<Tab, string> = {
    all: 'Your bag is empty.',
    weapon: 'No spare weapons in your bag.',
    armor: 'No spare armor in your bag.',
    consumable: 'No consumables in your bag.',
    material: 'No materials yet. Win challenges to earn some!',
    quest: 'No quest items yet. They will appear as you explore.',
};

/** Faded hint icons for empty equipment slots. */
const EQUIP_HINT: Record<EquipSlot, ItemId> = {
    armor: 'cloth_armor', healing: 'small_health_potion',
};

export class InventoryPanel implements Modal
{
    private backdrop: HTMLElement;
    private equipment = el('div', 'equipment');
    private stats = el('div', 'stats');
    private tabs = el('div', 'tabs');
    private note = el('div', 'bag-note');
    private grid = el('div', 'backpack');
    private details = el('div', 'details');

    private tab: Tab = 'all';
    private selected: SlotRef | null = null;
    /** A discard waiting for "Yes": the exact stack that was shown, so a changed slot cancels it. */
    private confirm: { ref: SlotRef; stack: ItemStack; qty: number } | null = null;
    /** Result of the last discard (shown under the details). */
    private notice: { text: string; error: boolean } | null = null;
    private onClose: (() => void) | null = null;

    constructor (parent: HTMLElement)
    {
        this.tabs.setAttribute('role', 'tablist');
        const close = gameButton('icon-btn', () => this.close(), '✕');
        close.setAttribute('aria-label', 'Close inventory');
        close.title = 'Close (I or Esc)';

        const panel = el('section', 'inventory panel',
            el('header', 'inventory__head', el('h2', '', 'Inventory'), keyHints([['I', 'close'], ['Drag', 'move items']]), close),
            el('div', 'inventory__body',
                el('div', 'inventory__side', el('h3', '', 'Stats'), this.stats, el('h3', '', 'Equipment'), this.equipment),
                el('div', 'inventory__main', this.tabs, this.note, this.grid, this.details)));
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Inventory');

        this.backdrop = el('div', 'inventory-backdrop hidden', panel);
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
        this.backdrop.classList.remove('hidden');
        this.render();
    }

    close ()
    {
        if (!this.isOpen) return;
        this.backdrop.classList.add('hidden');
        this.selected = null;
        this.confirm = null;
        this.notice = null;
        const done = this.onClose;
        this.onClose = null;
        done?.();
    }

    handleKey (key: string)
    {
        if (key === 'escape' && this.confirm)
        {
            this.confirm = null; // Esc first cancels a pending discard
            this.renderDetails();
        }
        else if (key === 'i' || key === 'escape') this.close();
    }

    /** Level, XP bar, unspent points and the four stats with their current effect. */
    private renderStats ()
    {
        const p = player.progress;
        const s = player.stats();
        const effect: Record<StatId, string> = {
            health: `${s.maxHp} max HP`, sword: `${s.swordDamage} dmg`, bow: `${s.bowDamage} dmg`, staff: `${s.staffDamage} dmg + splash`,
        };
        const fill = el('span', 'progress__fill');
        fill.style.width = `${Math.round((p.xp / p.xpToNext) * 100)}%`;
        const bar = el('span', 'progress xp-bar', fill);
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', 'XP to next level');
        bar.setAttribute('aria-valuenow', String(p.xp));
        bar.setAttribute('aria-valuemax', String(p.xpToNext));
        const rows = STAT_IDS.map((stat) =>
        {
            const plus = gameButton('btn btn--small stat-row__plus', () => player.spendPoint(stat), '+');
            plus.disabled = p.unspent <= 0;
            plus.setAttribute('aria-label', `Spend a point on ${STAT_LABELS[stat]}`);
            plus.title = p.unspent > 0 ? `+1 ${STAT_LABELS[stat]}` : 'No unspent points';
            return el('div', 'stat-row',
                el('span', 'stat-row__name', STAT_LABELS[stat]),
                el('strong', 'stat-row__points', String(p.alloc[stat])),
                el('span', 'stat-row__effect', effect[stat]),
                plus);
        });
        this.stats.replaceChildren(
            el('div', 'stats__level', el('strong', '', `Level ${p.level}`), el('span', '', `${p.xp} / ${p.xpToNext} XP`)),
            bar,
            el('div', `stats__points${p.unspent ? ' has-points' : ''}`, `Unspent points: ${p.unspent}`),
            ...rows,
            el('div', 'stats__extra', `Defense ${s.defense} (armor) · Healing ${s.healingCharges ? `${s.healPerUse} HP ×${s.healingCharges}` : 'none'}`));
    }

    /** Called by the shared slot interactions when a slot is clicked or receives a drop. */
    select (ref: SlotRef)
    {
        if (!this.isOpen) return;
        this.selected = getSlot(player.inventory, ref) ? ref : null;
        this.confirm = null;
        this.notice = null;
        this.render();
    }

    private render ()
    {
        const selectedKey = this.selected ? refKey(this.selected) : undefined;
        const inv = player.inventory;

        // Equipment
        this.equipment.replaceChildren(...EQUIP_SLOTS.map((slot) =>
        {
            const ref: SlotRef = { area: 'equipment', slot };
            return el('div', 'equip',
                slotElement(ref, { selected: selectedKey === refKey(ref), placeholder: EQUIP_HINT[slot] }),
                el('div', 'equip__text',
                    el('span', 'equip__label', EQUIP_SLOT_LABELS[slot]),
                    el('span', 'equip__item', inv.equipment[slot] ? itemDef(inv.equipment[slot]!.itemId).name : 'Empty')));
        }));

        this.renderStats();

        // Tabs
        this.tabs.replaceChildren(...TABS.map(([id, label]) =>
        {
            const tab = gameButton(`tab${id === this.tab ? ' is-active' : ''}`, () => { this.tab = id; this.render(); }, label);
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(id === this.tab));
            return tab;
        }));

        // Backpack: in a category tab, show matching items plus empty slots (to drop into).
        const indices = Array.from({ length: BACKPACK_SIZE }, (_, i) => i).filter((i) =>
        {
            const stack = inv.backpack[i];
            return this.tab === 'all' || !stack || itemDef(stack.itemId).category === this.tab;
        });
        const hasItems = indices.some((i) => inv.backpack[i]);
        this.note.textContent = hasItems ? '' : EMPTY_TAB_TEXT[this.tab];
        this.note.classList.toggle('hidden', hasItems);
        const scroll = this.grid.scrollTop;
        this.grid.replaceChildren(...indices.map((index) =>
            slotElement({ area: 'backpack', index }, { selected: selectedKey === `backpack:${index}` })));
        this.grid.scrollTop = scroll;

        this.renderDetails();
    }

    private renderDetails ()
    {
        const ref = this.selected;
        const stack = ref && getSlot(player.inventory, ref);
        const notice: HTMLElement[] = [];
        if (this.notice)
        {
            const line = el('p', `details__notice${this.notice.error ? ' is-error' : ''}`, this.notice.text);
            line.setAttribute('role', 'status');
            notice.push(line);
        }
        if (!ref || !stack)
        {
            this.confirm = null;
            this.details.replaceChildren(el('p', 'details__empty',
                'Select an item to see its details. Drag items between the bag and equipment; gear only fits its matching slot.'), ...notice);
            return;
        }

        // A pending discard only stays valid while the slot still holds exactly the confirmed stack.
        const c = this.confirm;
        if (c && (refKey(c.ref) !== refKey(ref) || c.stack.itemId !== stack.itemId || c.stack.qty !== stack.qty)) this.confirm = null;

        const def = itemDef(stack.itemId);
        if (this.confirm && ref.area === 'backpack')
        {
            const { qty } = this.confirm;
            const what = qty > 1 ? `${qty} × ${def.name}` : def.name;
            const question = el('p', 'details__confirm', `Discard ${what}? This can't be undone.`);
            question.setAttribute('role', 'alert');
            this.details.replaceChildren(itemDetails(stack), question, el('div', 'details__actions',
                gameButton('btn btn--small btn--danger', () => this.discardConfirmed(), 'Yes, discard'),
                gameButton('btn btn--small', () => { this.confirm = null; this.renderDetails(); }, 'Cancel')));
            return;
        }

        const actions: HTMLElement[] = [];
        if (ref.area === 'equipment')
        {
            actions.push(gameButton('btn btn--small', () =>
            {
                if (!player.stash(ref)) return;
                this.selected = null;
                this.render();
            }, 'Unequip'));
            actions.push(el('span', 'details__hint', 'Unequip to discard.'));
        }
        else
        {
            if (def.equipSlot)
            {
                const slot = def.equipSlot;
                actions.push(gameButton('btn btn--small btn--primary', () =>
                {
                    player.move(ref, { area: 'equipment', slot });
                    this.select({ area: 'equipment', slot });
                }, `Equip (${EQUIP_SLOT_LABELS[slot]})`));
            }
            const ask = (qty: number) => () =>
            {
                this.confirm = { ref, stack: { ...stack }, qty };
                this.notice = null;
                this.renderDetails();
            };
            if (stack.qty > 1)
            {
                actions.push(gameButton('btn btn--small btn--danger', ask(1), 'Discard 1'));
                actions.push(gameButton('btn btn--small btn--danger', ask(stack.qty), `Discard All (×${stack.qty})`));
            }
            else actions.push(gameButton('btn btn--small btn--danger', ask(1), 'Discard Item'));
        }
        this.details.replaceChildren(itemDetails(stack), el('div', 'details__actions', ...actions), ...notice);
    }

    private discardConfirmed ()
    {
        const c = this.confirm;
        if (!c) return;
        this.confirm = null;
        const name = itemDef(c.stack.itemId).name;
        const result = player.discard(c.ref, c.stack, c.qty);
        if (result === 'discarded')
        {
            this.notice = { text: `Discarded ${c.qty > 1 ? `${c.qty} × ` : ''}${name}.`, error: false };
            if (!getSlot(player.inventory, c.ref)) this.selected = null;
        }
        else if (result === 'saveFailed')
        {
            this.notice = { text: 'Could not save (browser storage is full or blocked). Nothing was discarded; try again.', error: true };
        }
        else
        {
            this.notice = { text: 'That item changed, so nothing was discarded.', error: true };
        }
        this.render();
    }
}
