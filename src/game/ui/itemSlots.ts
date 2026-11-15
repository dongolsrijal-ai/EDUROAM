// Shared item-slot rendering + mouse interactions (hover tooltip, click to select,
// drag-and-drop) for the inventory panel. Reads the inventory from
// playerState and asks it to move items; it never edits inventory data itself.

import { itemIconUrl } from '../items/icons';
import { accepts, getSlot, parseRefKey, refKey, type ItemStack, type SlotRef } from '../items/inventory';
import { CATEGORY_LABELS, EQUIP_SLOT_LABELS, itemDef, type ItemDef, type ItemId } from '../items/itemDefs';
import { player } from '../state/playerState';
import { el } from './dom';

const RARITY_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

export function statLines (def: ItemDef): string[]
{
    const s = def.stats ?? {};
    return [
        s.defense ? `+${s.defense} Defense` : '',
        s.heal ? `Restores ${s.heal} HP` : '',
    ].filter(Boolean);
}

/** Name, rarity, category, stats, description and quantity of a stack. */
export function itemDetails (stack: ItemStack): HTMLElement
{
    const def = itemDef(stack.itemId);
    const meta = [RARITY_LABEL[def.rarity], CATEGORY_LABELS[def.category], def.equipSlot && `${EQUIP_SLOT_LABELS[def.equipSlot]} slot`]
        .filter(Boolean).join(' · ');
    return el('div', 'item-info',
        el('div', `item-info__name rarity-text-${def.rarity}`, def.name),
        el('div', 'item-info__meta', meta),
        ...statLines(def).map((line) => el('div', 'item-info__stat', line)),
        el('p', 'item-info__desc', def.description),
        el('div', 'item-info__qty', def.maxStack > 1 ? `Quantity: ${stack.qty} / ${def.maxStack}` : 'Not stackable'));
}

export interface SlotOptions
{
    /** Inventory selection highlight. */
    selected?: boolean;
    /** Faded hint icon when empty (equipment slots). */
    placeholder?: ItemId;
}

export function slotElement (ref: SlotRef, opts: SlotOptions = {}): HTMLElement
{
    const stack = getSlot(player.inventory, ref);
    const classes = ['slot'];
    if (opts.selected) classes.push('is-selected');
    classes.push(stack ? `rarity-${itemDef(stack.itemId).rarity}` : 'is-empty');

    const node = el('div', classes.join(' '));
    node.dataset.slot = refKey(ref);

    if (stack)
    {
        const def = itemDef(stack.itemId);
        const icon = el('img', 'slot__icon');
        icon.src = itemIconUrl(stack.itemId);
        icon.alt = '';
        icon.draggable = false;
        node.append(icon);
        if (def.maxStack > 1) node.append(el('span', 'slot__qty', String(stack.qty)));
        node.setAttribute('aria-label', def.maxStack > 1 ? `${def.name}, ${stack.qty}` : def.name);
    }
    else if (opts.placeholder)
    {
        const ghost = el('img', 'slot__icon slot__ghost');
        ghost.src = itemIconUrl(opts.placeholder);
        ghost.alt = '';
        ghost.draggable = false;
        node.append(ghost);
    }
    return node;
}

/** Explains why a drop was refused. */
function rejectMessage (stack: ItemStack, target: SlotRef)
{
    const name = itemDef(stack.itemId).name;
    return target.area === 'equipment'
        ? `${name} can't go in the ${EQUIP_SLOT_LABELS[target.slot]} slot.`
        : `Can't swap ${name} there: the other item doesn't fit its slot.`;
}

/** Delegated pointer handling for every [data-slot] element inside `root`. */
export class ItemInteractions
{
    private tooltip = el('div', 'tooltip hidden');
    private ghost = el('img', 'drag-ghost hidden');
    private press: { ref: SlotRef; stack: ItemStack | null; x: number; y: number } | null = null;
    private dragging = false;

    constructor (private root: HTMLElement, private onSelect: (ref: SlotRef) => void, private onReject: (message: string) => void)
    {
        this.ghost.alt = '';
        root.append(this.ghost, this.tooltip);

        root.addEventListener('pointerdown', this.onDown);
        root.addEventListener('pointerover', this.onOver);
        root.addEventListener('pointerout', this.onOut);
        window.addEventListener('pointermove', this.onMove);
        window.addEventListener('pointerup', this.onUp);
    }

    hideTooltip ()
    {
        this.tooltip.classList.add('hidden');
    }

    private slotAt (target: EventTarget | null): { node: HTMLElement; ref: SlotRef } | null
    {
        const node = (target instanceof Element ? target.closest<HTMLElement>('[data-slot]') : null);
        const ref = node?.dataset.slot ? parseRefKey(node.dataset.slot) : null;
        return node && ref ? { node, ref } : null;
    }

    private onDown = (event: PointerEvent) =>
    {
        if (event.button !== 0) return;
        const hit = this.slotAt(event.target);
        if (!hit) return;
        event.preventDefault(); // no text selection / focus stealing
        this.press = { ref: hit.ref, stack: getSlot(player.inventory, hit.ref), x: event.clientX, y: event.clientY };
    };

    private onMove = (event: PointerEvent) =>
    {
        if (!this.tooltip.classList.contains('hidden')) this.placeFloating(this.tooltip, event.clientX + 14, event.clientY + 16);
        if (!this.press?.stack) return;

        if (!this.dragging)
        {
            if (Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) < 5) return;
            this.startDrag(this.press.ref, this.press.stack);
        }
        this.ghost.style.transform = `translate(${event.clientX - 20}px, ${event.clientY - 20}px)`;
    };

    private onUp = (event: PointerEvent) =>
    {
        const press = this.press;
        this.press = null;
        if (!press) return;

        if (!this.dragging)
        {
            this.onSelect(press.ref);
            return;
        }

        this.endDrag();
        const hit = this.slotAt(document.elementFromPoint(event.clientX, event.clientY));
        if (!hit || !press.stack) return;
        const result = player.move(press.ref, hit.ref);
        if (result === 'rejected') this.onReject(rejectMessage(press.stack, hit.ref));
        else if (result !== 'noop') this.onSelect(hit.ref);
    };

    private startDrag (from: SlotRef, stack: ItemStack)
    {
        this.dragging = true;
        this.hideTooltip();
        this.ghost.src = itemIconUrl(stack.itemId);
        this.ghost.classList.remove('hidden');
        document.body.classList.add('is-dragging-item');

        // Show where the item may go.
        for (const node of this.root.querySelectorAll<HTMLElement>('[data-slot]'))
        {
            const ref = parseRefKey(node.dataset.slot ?? '');
            if (!ref) continue;
            const fits = accepts(ref, stack) && accepts(from, getSlot(player.inventory, ref));
            node.classList.add(fits ? 'can-drop' : 'no-drop');
        }
        this.root.querySelector(`[data-slot="${refKey(from)}"]`)?.classList.add('is-dragging');
    }

    private endDrag ()
    {
        this.dragging = false;
        this.ghost.classList.add('hidden');
        document.body.classList.remove('is-dragging-item');
        for (const node of this.root.querySelectorAll('.can-drop, .no-drop, .is-dragging'))
        {
            node.classList.remove('can-drop', 'no-drop', 'is-dragging');
        }
    }

    private onOver = (event: PointerEvent) =>
    {
        if (this.dragging) return;
        const hit = this.slotAt(event.target);
        const stack = hit && getSlot(player.inventory, hit.ref);
        if (!stack) return this.hideTooltip();
        this.tooltip.replaceChildren(itemDetails(stack));
        this.tooltip.classList.remove('hidden');
        this.placeFloating(this.tooltip, event.clientX + 14, event.clientY + 16);
    };

    private onOut = (event: PointerEvent) =>
    {
        const from = this.slotAt(event.target);
        const to = this.slotAt(event.relatedTarget);
        if (from && from.node !== to?.node) this.hideTooltip();
    };

    /** Positions a floating element near the pointer, kept inside the window. */
    private placeFloating (node: HTMLElement, x: number, y: number)
    {
        const { width, height } = node.getBoundingClientRect();
        const left = Math.min(x, window.innerWidth - width - 8);
        const top = y + height > window.innerHeight - 8 ? y - height - 24 : y;
        node.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
    }
}
