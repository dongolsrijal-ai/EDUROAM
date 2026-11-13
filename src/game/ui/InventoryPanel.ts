// Minecraft-style inventory (press I): equipment + stats on the left, a scrollable
// backpack with category tabs on the right, and details for the selected item.
// Pure view: reads playerState and asks it to move items.

import { BACKPACK_SIZE, EQUIP_SLOTS, getSlot, refKey, type SlotRef } from '../items/inventory';
import { EQUIP_SLOT_LABELS, itemDef, type EquipSlot, type ItemCategory, type ItemId } from '../items/itemDefs';
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
    armor: 'cloth_armor', melee: 'wooden_sword', ranged: 'training_bow', healing: 'small_health_potion',
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
                el('div', 'inventory__side', el('h3', '', 'Equipment'), this.equipment, this.stats),
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
        const done = this.onClose;
        this.onClose = null;
        done?.();
    }

    handleKey (key: string)
    {
        if (key === 'i' || key === 'escape') this.close();
    }

    /** Called by the shared slot interactions when a slot is clicked or receives a drop. */
    select (ref: SlotRef)
    {
        if (!this.isOpen) return;
        this.selected = getSlot(player.inventory, ref) ? ref : null;
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

        const s = player.stats();
        this.stats.replaceChildren(
            el('div', 'stat', el('span', '', 'Defense'), el('strong', '', String(s.defense))),
            el('div', 'stat', el('span', '', 'Melee'), el('strong', '', String(s.meleeDamage))),
            el('div', 'stat', el('span', '', 'Ranged'), el('strong', '', String(s.rangedDamage))),
            el('div', 'stat', el('span', '', 'Healing'), el('strong', '', s.healingCharges ? `${s.healPerUse} HP ×${s.healingCharges}` : 'None')));

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
        if (!ref || !stack)
        {
            this.details.replaceChildren(el('p', 'details__empty',
                'Select an item to see its details. Drag items between the bag and equipment; gear only fits its matching slot.'));
            return;
        }

        const def = itemDef(stack.itemId);
        const actions: HTMLElement[] = [];
        if (ref.area === 'equipment')
        {
            actions.push(gameButton('btn btn--small', () =>
            {
                if (!player.stash(ref)) return;
                this.selected = null;
                this.render();
            }, 'Unequip'));
        }
        else if (def.equipSlot)
        {
            const slot = def.equipSlot;
            actions.push(gameButton('btn btn--small btn--primary', () =>
            {
                player.move(ref, { area: 'equipment', slot });
                this.select({ area: 'equipment', slot });
            }, `Equip (${EQUIP_SLOT_LABELS[slot]})`));
        }
        this.details.replaceChildren(itemDetails(stack), el('div', 'details__actions', ...actions));
    }
}
