// Teacher / developer tool (top-right): create, edit, move and delete NPCs + their buildings.
// Talks to the active world scene through WorldHost and to data through npcStore
// (which also enforces the NPC / class limits).

import { BUILDING_FOR_APPEARANCE, BUILDING_TYPES } from '../buildings/buildingTypes';
import { LIMITS, npcStore, type MapId, type NpcRecord, type Placement } from '../data/npcStore';
import { APPEARANCE_IDS, APPEARANCES, type AppearanceId } from '../npcs/appearances';
import { isMinigameId, MINIGAMES } from '../minigames';
import { el, gameButton, keyHints } from './dom';
import type { Toasts } from './widgets';

/** What the manager needs from the scene the player is currently in. */
export interface WorldHost
{
    readonly mapId: MapId;
    readonly title: string;
    /** Turns game keyboard handling off while the form is open / placement is active. */
    setInputEnabled (enabled: boolean): void;
    /** Ghost building + NPC follow the pointer; onPlace receives a valid placement. */
    beginPlacement (appearance: AppearanceId, ignoreNpcId: string | null, onPlace: (placement: Placement) => void, onCancel: () => void): void;
    cancelPlacement (): void;
    textureUrl (key: string): string;
    portraitUrl (appearance: AppearanceId): string;
}

const SUBJECT_SUGGESTIONS = [
    'Mathematics', 'Biology', 'Chemistry', 'Physics', 'History', 'Geography',
    'English', 'Computer Science', 'Environmental Science', 'Art', 'Music',
];

const MAP_LABELS: Record<MapId, string> = { hub: 'Village', dungeon: 'Dungeon' };

const buildingLabel = (appearance: AppearanceId) => BUILDING_TYPES[BUILDING_FOR_APPEARANCE[appearance]].label;

export class NpcManager
{
    private host: WorldHost | null = null;
    private formOpen = false;
    private placing = false;
    private editingId: string | null = null;

    private addButton: HTMLButtonElement;
    private listButton: HTMLButtonElement;
    private limitNote = el('div', 'manager__note hidden');
    private list = el('div', 'npc-list panel hidden');

    private backdrop: HTMLElement;
    private heading = el('h2');
    private usage = el('div', 'usage');
    private nameInput = el('input');
    private subjectInput = el('input');
    private subjects = el('datalist');
    private subjectHint = el('span', 'field__hint');
    private greetingInput = el('textarea');
    private minigameSelect = el('select');
    private lookInputs = new Map<AppearanceId, { input: HTMLInputElement; img: HTMLImageElement }>();
    private buildingImg = el('img', 'building-preview__img');
    private buildingName = el('strong');
    private buildingText = el('span');
    private error = el('p', 'form-error');
    private submitButton = el('button', 'btn btn--primary');

    private banner: HTMLElement;
    private bannerText = el('span');

    constructor (parent: HTMLElement, private toasts: Toasts)
    {
        this.addButton = gameButton('btn btn--primary', () => this.openForm(null), '+ Add NPC');
        this.listButton = gameButton('btn', () => this.toggleList(), 'NPCs');
        this.listButton.setAttribute('aria-expanded', 'false');
        parent.append(el('div', 'manager',
            el('div', 'manager__bar', this.addButton, this.listButton),
            this.limitNote,
            this.list));

        this.backdrop = this.buildForm();
        parent.append(this.backdrop);

        this.banner = el('div', 'banner panel hidden', this.bannerText, keyHints([['Esc', 'cancel']]),
            gameButton('btn btn--small', () => this.host?.cancelPlacement(), 'Cancel'));
        parent.append(this.banner);

        window.addEventListener('keydown', (event) =>
        {
            if (event.key !== 'Escape') return;
            if (this.placing) this.host?.cancelPlacement();
            else if (this.formOpen) this.closeForm();
        });

        npcStore.subscribe(({ saved }) =>
        {
            this.renderList();
            if (!saved) this.toasts.show('Could not save NPCs in this browser (storage full or blocked).', 'error');
        });
        this.setHost(null);
    }

    /** Called by world scenes when they start (host) and shut down (null). */
    setHost (host: WorldHost | null)
    {
        if (!host)
        {
            // Scene is going away: drop any half-finished interaction without touching it.
            this.formOpen = false;
            this.placing = false;
            this.backdrop.classList.add('hidden');
            this.banner.classList.add('hidden');
        }
        this.host = host;
        this.renderList();
    }

    // ------------------------------------------------------------ list + limits

    private usageText ()
    {
        const u = npcStore.usage();
        return `NPCs: ${u.npcs} / ${u.maxNpcs}  ·  Classes: ${u.classes} / ${u.maxClasses}`;
    }

    private toggleList ()
    {
        const open = this.list.classList.toggle('hidden') === false;
        this.listButton.setAttribute('aria-expanded', String(open));
    }

    private renderList ()
    {
        const npcs = npcStore.all();
        const u = npcStore.usage();
        const full = u.npcs >= u.maxNpcs;

        this.listButton.textContent = `NPCs ${u.npcs}/${u.maxNpcs}`;
        this.listButton.disabled = !this.host;
        this.addButton.disabled = !this.host || full;
        this.addButton.title = full ? `NPC limit reached (${u.maxNpcs}). Edit or delete an NPC to make room.` : 'Create a new NPC and their building';
        this.limitNote.textContent = `NPC limit reached (${u.maxNpcs}/${u.maxNpcs}). You can still edit, move or delete NPCs.`;
        this.limitNote.classList.toggle('hidden', !full);

        const header = el('div', 'npc-list__usage', this.usageText());
        if (!npcs.length)
        {
            this.list.replaceChildren(header, el('div', 'npc-list__empty', 'No NPCs yet. Use "+ Add NPC" to create one.'));
            return;
        }

        this.list.replaceChildren(header, ...npcs.map((npc) =>
        {
            const portrait = el('img', 'portrait');
            portrait.alt = '';
            if (this.host) portrait.src = this.host.portraitUrl(npc.appearance);

            const building = npcStore.buildingOf(npc.id);
            const home = building ? BUILDING_TYPES[building.type].label : 'No building yet: use Move';
            const meta = `${npc.subject} · ${home} · ${MAP_LABELS[npc.map]}${npc.completed ? ' · ✓' : ''}`;
            return el('div', 'npc-row',
                portrait,
                el('div', '', el('div', 'npc-row__name', npc.name), el('div', 'npc-row__meta', meta)),
                el('div', 'npc-row__actions',
                    gameButton('btn btn--small', () => this.openForm(npc), 'Edit'),
                    gameButton('btn btn--small', () => this.move(npc), 'Move here'),
                    gameButton('btn btn--small btn--danger', () => this.remove(npc), 'Delete')));
        }));
    }

    private remove (npc: NpcRecord)
    {
        const building = npcStore.buildingOf(npc.id);
        const what = building ? `${npc.name} and their ${BUILDING_TYPES[building.type].label}` : npc.name;
        if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return;
        npcStore.remove(npc.id);
        this.toasts.show(`${what} removed.`);
    }

    private move (npc: NpcRecord)
    {
        const host = this.host;
        if (!host) return;
        this.startPlacement(npc.name, npc.appearance, npc.id, (placement) =>
        {
            const result = npcStore.relocate(npc.id, placement);
            this.toasts.show(result.ok ? `${npc.name} moved to the ${host.title}.` : result.error, result.ok ? 'info' : 'error');
        });
    }

    // ------------------------------------------------------------ form

    private buildForm ()
    {
        this.nameInput.maxLength = LIMITS.name;
        this.nameInput.placeholder = 'e.g. Professor Bob';
        this.nameInput.required = true;

        this.subjectInput.maxLength = LIMITS.subject;
        this.subjectInput.placeholder = 'e.g. Biology';
        this.subjectInput.required = true;
        this.subjects.id = 'npc-subjects';
        this.subjectInput.setAttribute('list', this.subjects.id);

        this.greetingInput.rows = 2;
        this.greetingInput.placeholder = 'One message per line. Leave empty for a friendly default.';

        const none = el('option', '', 'None (just chat)');
        none.value = '';
        this.minigameSelect.append(none);
        for (const [id, game] of Object.entries(MINIGAMES))
        {
            const option = el('option', '', game.label);
            option.value = id;
            this.minigameSelect.append(option);
        }

        const looks = el('fieldset', 'looks');
        looks.setAttribute('aria-label', 'Appearance');
        for (const id of APPEARANCE_IDS)
        {
            const input = el('input');
            input.type = 'radio';
            input.name = 'npc-appearance';
            input.value = id;
            input.addEventListener('change', () => this.renderBuildingPreview());
            const img = el('img');
            img.alt = '';
            const appearance = APPEARANCES[id];
            const badge = appearance.asset ? null : el('span', 'look__badge', 'placeholder');
            if (badge) badge.title = `Missing asset: no ${appearance.label.toLowerCase()} sprite in public/assets. Set "asset" in src/game/npcs/appearances.ts once added.`;
            looks.append(el('label', 'look', input, img, appearance.label, badge));
            this.lookInputs.set(id, { input, img });
        }

        this.buildingImg.alt = '';
        const buildingPreview = el('div', 'building-preview', this.buildingImg,
            el('div', 'building-preview__text', this.buildingName, this.buildingText));

        const field = (label: string, control: HTMLElement, hint: HTMLElement | string = '') =>
            el('label', 'field', el('span', 'field__label', label, typeof hint === 'string' ? (hint && el('span', 'field__hint', ` ${hint}`)) : hint), control);

        this.submitButton.type = 'submit';
        const form = el('form', 'npc-form panel',
            el('div', 'npc-form__head', this.heading, this.usage),
            field('NPC name', this.nameInput),
            field('Class / subject', this.subjectInput, this.subjectHint),
            this.subjects,
            el('div', 'field', el('span', 'field__label', 'Appearance'), looks),
            el('div', 'field', el('span', 'field__label', 'Building'), buildingPreview),
            el('div', 'form-row', field('Greeting', this.greetingInput, '(optional)'), field('Mini-game', this.minigameSelect)),
            this.error,
            el('div', 'form-actions', gameButton('btn', () => this.closeForm(), 'Cancel'), this.submitButton));
        form.noValidate = true;
        form.addEventListener('submit', (event) => { event.preventDefault(); this.submit(); });

        const backdrop = el('div', 'backdrop hidden', form);
        backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) this.closeForm(); });
        return backdrop;
    }

    private selectedAppearance (): AppearanceId
    {
        return [...this.lookInputs].find(([, { input }]) => input.checked)?.[0] ?? 'scientist';
    }

    private renderBuildingPreview ()
    {
        const type = BUILDING_TYPES[BUILDING_FOR_APPEARANCE[this.selectedAppearance()]];
        if (this.host) this.buildingImg.src = this.host.textureUrl(type.texture);
        this.buildingName.textContent = type.label;
        this.buildingText.textContent = type.description;
    }

    private renderSubjectChoices (editingId: string | null)
    {
        const classes = npcStore.classes();
        const full = classes.length >= npcStore.usage().maxClasses;
        const options = full ? classes : [...new Set([...classes, ...SUBJECT_SUGGESTIONS])];
        this.subjects.replaceChildren(...options.map((s) => { const o = el('option'); o.value = s; return o; }));
        this.subjectHint.textContent = full
            ? ` (class limit reached: pick an existing class${editingId ? ' or keep this one' : ''})`
            : ' (NPCs may share a class)';
    }

    private openForm (npc: NpcRecord | null)
    {
        if (!this.host || this.placing) return;
        const { npcs, maxNpcs } = npcStore.usage();
        if (!npc && npcs >= maxNpcs)
        {
            this.toasts.show(`NPC limit reached (${maxNpcs}/${maxNpcs}). Delete an NPC to add a new one.`, 'error');
            return;
        }

        this.editingId = npc?.id ?? null;
        this.heading.textContent = npc ? `Edit ${npc.name}` : 'Create an NPC';
        this.usage.textContent = this.usageText();
        this.submitButton.textContent = npc ? 'Save changes' : 'Next: place building';
        this.nameInput.value = npc?.name ?? '';
        this.subjectInput.value = npc?.subject ?? '';
        this.greetingInput.value = npc?.dialogue.join('\n') ?? '';
        this.minigameSelect.value = npc?.minigameType ?? '';
        for (const [id, { input, img }] of this.lookInputs)
        {
            input.checked = id === (npc?.appearance ?? 'scientist');
            img.src = this.host.portraitUrl(id);
        }
        this.renderSubjectChoices(this.editingId);
        this.renderBuildingPreview();
        this.error.textContent = '';

        this.list.classList.add('hidden');
        this.backdrop.classList.remove('hidden');
        this.formOpen = true;
        this.syncInput();
        this.nameInput.focus();
    }

    private closeForm ()
    {
        this.backdrop.classList.add('hidden');
        this.formOpen = false;
        this.syncInput();
    }

    private submit ()
    {
        const host = this.host;
        if (!host) return;

        const name = this.nameInput.value.trim();
        const subject = this.subjectInput.value.trim();
        if (!name || !subject)
        {
            this.error.textContent = 'Please enter both a name and a class / subject.';
            (name ? this.subjectInput : this.nameInput).focus();
            return;
        }
        // Same rules the store enforces, checked early so the user can fix the form.
        const limit = npcStore.checkLimits(subject, this.editingId ?? undefined);
        if (limit)
        {
            this.error.textContent = limit;
            this.subjectInput.focus();
            return;
        }

        const appearance = this.selectedAppearance();
        const dialogue = this.greetingInput.value.split('\n').map((line) => line.trim()).filter(Boolean);
        const minigameType = isMinigameId(this.minigameSelect.value) ? this.minigameSelect.value : null;
        const fields = { name, subject, appearance, dialogue, minigameType };

        const editingId = this.editingId;
        if (editingId)
        {
            const result = npcStore.update(editingId, fields);
            if (!result.ok) { this.error.textContent = result.error; return; }
            this.closeForm();
            this.toasts.show(`Saved ${name}.`);
            return;
        }

        this.closeForm();
        this.startPlacement(name, appearance, null, (placement) =>
        {
            const result = npcStore.create(fields, placement);
            if (result.ok) this.toasts.show(`${name} and their ${buildingLabel(appearance)} joined the ${host.title}!`, 'reward');
            else this.toasts.show(result.error, 'error');
        });
    }

    // ------------------------------------------------------------ placement

    private startPlacement (name: string, appearance: AppearanceId, ignoreId: string | null, onPlace: (placement: Placement) => void)
    {
        const host = this.host;
        if (!host) return;

        this.list.classList.add('hidden');
        this.bannerText.textContent = `Click an open spot for ${name}'s ${buildingLabel(appearance)}`;
        this.banner.classList.remove('hidden');
        this.placing = true;
        this.syncInput();

        const end = () =>
        {
            this.placing = false;
            this.banner.classList.add('hidden');
            this.syncInput();
        };
        host.beginPlacement(appearance, ignoreId, (placement) => { end(); onPlace(placement); }, end);
    }

    private syncInput ()
    {
        this.host?.setInputEnabled(!this.formOpen && !this.placing);
    }
}
