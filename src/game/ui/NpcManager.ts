// Teacher / developer tool (top-right): create, edit, move and delete NPCs + their buildings.
// Talks to the active world scene through WorldHost and to data through npcStore
// (which also enforces the NPC / class limits).

import { BUILDING_FOR_APPEARANCE, BUILDING_TYPES } from '../buildings/buildingTypes';
import { LIMITS, npcStore, type MapId, type NpcRecord, type Placement, type VillageEntry } from '../data/npcStore';
import { APPEARANCE_IDS, APPEARANCES, type AppearanceId } from '../npcs/appearances';
import { backendConfigured, getSession, onSessionChange } from '../services/backend';
import { loadAccountVillage, saveNpc } from '../services/npcSync';
import { compareNpcRoster, deleteRemoteNpc, deleteRemoteNpcById, loadNpcRoster, pasteCoursework, syncNpc, type NpcRoster } from '../services/tutorApi';
import type { CourseworkLibrary } from './CourseworkLibrary';
import { el, gameButton, keyHints } from './dom';
import { SignInBox } from './SignInBox';
import { acceptDrops, AttachmentTray, UploadQueue } from './uploads';
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
    private bar: HTMLElement;
    private limitNote = el('div', 'manager__note hidden');
    /** Account village loading / failed state (with Retry), shown even while the list is closed. */
    private syncNote = el('div', 'manager__note manager__sync hidden');
    /** NPCs whose latest change is being saved to the account. */
    private saving = new Set<string>();
    private list = el('div', 'npc-list panel hidden');

    private backdrop: HTMLElement;
    private heading = el('h2');
    private usage = el('div', 'usage');
    private nameInput = el('input');
    private subjectInput = el('input');
    private subjects = el('datalist');
    private subjectHint = el('span', 'field__hint');
    /** Starting class materials: same chips + "+" flow as the chat composer. */
    private materials = new AttachmentTray({ max: 10, inlineImageBytes: 0, note: () => 'Shared with everyone in this class: used for tutoring and mini-games.' });
    private materialsBox = el('div', 'materials-box');
    private nameError = el('span', 'field__error');
    private subjectError = el('span', 'field__error');
    /** Set by the Ui once the shared Coursework Library exists. */
    library: CourseworkLibrary | null = null;
    private pasteTitle = el('input');
    private pasteText = el('textarea');
    private pasteBox = el('details', 'paste-box');
    private libraryButton = el('div', 'materials-library hidden');
    private materialsSignIn = new SignInBox('Sign in to upload class materials. They are stored privately for this class.');
    private signedIn = false;
    private ownerId: string | null = null;
    private roster: NpcRoster | null = null;
    private serverCount: number | null = null;
    private rosterRequest = 0;
    private deleting = new Set<string>();
    private report = el('pre', 'npc-list__report');
    private reportBox = el('details', 'npc-list__comparison');
    /** "Delete All My NPCs": typed confirmation, sequential server deletion, retry of what is left. */
    private bulkBox = el('details', 'npc-bulk');
    private bulkInput = el('input');
    private bulkButton = el('button', 'btn btn--small btn--danger');
    private bulkStatus = el('p', 'npc-bulk__status');
    private bulkDeleting = false;
    /** End the matching active call before asking the server to delete its teacher. */
    beforeDelete: (npcId: string) => Promise<void> = async () => {};
    private lookInputs = new Map<AppearanceId, { input: HTMLInputElement; img: HTMLImageElement }>();
    private buildingImg = el('img', 'building-preview__img');
    private buildingName = el('strong');
    private buildingText = el('span');
    private error = el('p', 'form-error');
    private submitButton = el('button', 'btn btn--primary');

    private banner: HTMLElement;
    private bannerText = el('span');

    /** Floating status for class-material uploads that continue after the form closes. */
    private uploadPanel = el('section', 'uploads-panel panel hidden');
    private uploadTitle = el('strong');
    private uploadQueue = new UploadQueue((row) =>
    {
        if (row?.status === 'ready') this.toasts.show(`"${row.title}" is ready as class material.`, 'reward');
    });

    constructor (parent: HTMLElement, private toasts: Toasts)
    {
        this.addButton = gameButton('btn btn--primary', () => this.openForm(null), '+ Add NPC');
        this.listButton = gameButton('btn', () => this.toggleList(), 'NPCs');
        this.listButton.setAttribute('aria-expanded', 'false');
        parent.append(el('div', 'manager',
            this.bar = el('div', 'manager__bar', this.addButton, this.listButton),
            this.syncNote,
            this.limitNote,
            this.list));

        this.backdrop = this.buildForm();
        parent.append(this.backdrop);

        this.banner = el('div', 'banner panel hidden', this.bannerText, keyHints([['Esc', 'cancel']]),
            gameButton('btn btn--small', () => this.host?.cancelPlacement(), 'Cancel'));
        parent.append(this.banner);

        this.uploadPanel.append(
            el('div', 'uploads-panel__head', this.uploadTitle, gameButton('btn btn--small', () => this.uploadPanel.classList.add('hidden'), 'Hide')),
            this.uploadQueue.root);
        this.uploadPanel.setAttribute('aria-label', 'Class material uploads');
        parent.append(this.uploadPanel);
        this.setSignedIn(false);
        if (backendConfigured)
        {
            void getSession().then((session) => this.setSignedIn(Boolean(session), session?.user.id ?? null));
            onSessionChange((session) => this.setSignedIn(Boolean(session), session?.user.id ?? null));
            window.addEventListener('focus', () => { if (this.ownerId) void this.refreshRoster(); });
        }
        this.reportBox.append(el('summary', '', 'Compare with server (read-only)'),
            gameButton('btn btn--small', () => void this.refreshRoster(), 'Refresh comparison'), this.report);
        this.buildBulkDelete();

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

    /** The account button sits first in the bar; its panel opens under it, like the NPC list. */
    mountAccount (button: HTMLElement, panel: HTMLElement)
    {
        this.bar.prepend(button);
        this.bar.after(panel);
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
        if (this.signedIn) return `Server NPCs: ${this.serverCount ?? 'checking'} / ${u.maxNpcs} · In this village: ${u.npcs}`;
        return `NPCs: ${u.npcs} / ${u.maxNpcs}  ·  Classes: ${u.classes} / ${u.maxClasses}`;
    }

    private toggleList ()
    {
        const open = this.list.classList.toggle('hidden') === false;
        this.listButton.setAttribute('aria-expanded', String(open));
        if (open && this.signedIn) void this.refreshRoster();
    }

    private renderList ()
    {
        const npcs = npcStore.all();
        const u = npcStore.usage();
        const count = this.serverCount ?? u.npcs;
        const full = Math.max(count, u.npcs) >= u.maxNpcs;
        const sync = npcStore.syncStatus();
        const blocked = !npcStore.editable();
        this.syncNote.classList.toggle('hidden', !blocked);
        this.syncNote.classList.toggle('is-error', sync.state === 'error');
        if (sync.state === 'loading') this.syncNote.replaceChildren('Loading your NPCs from your account…');
        else if (sync.state === 'error') this.syncNote.replaceChildren(el('span', '', `${sync.message} Editing is paused so nothing is lost.`), gameButton('btn btn--small', () => void this.loadVillage(), 'Retry'));

        this.listButton.textContent = `NPCs ${count}/${u.maxNpcs}`;
        this.listButton.disabled = !this.host;
        this.addButton.disabled = !this.host || full || (this.signedIn && !this.roster) || this.bulkDeleting || blocked;
        this.addButton.title = full ? `NPC limit reached (${u.maxNpcs}). Edit or delete an NPC to make room.` : 'Create a new NPC and their building';
        this.limitNote.textContent = `NPC limit reached (${u.maxNpcs}/${u.maxNpcs}). You can still edit, move or delete NPCs.`;
        this.limitNote.classList.toggle('hidden', !full);

        const header = el('div', 'npc-list__usage', this.usageText());
        if (this.signedIn) header.append(this.reportBox, this.bulkBox);
        if (!npcs.length)
        {
            this.list.replaceChildren(header, el('div', 'npc-list__empty', blocked ? 'Loading your NPCs…' : 'No NPCs yet. Use "+ Add NPC" to create one.'));
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
            const actions = el('div', 'npc-row__actions',
                gameButton('btn btn--small', () => this.openForm(npc), 'Edit'),
                gameButton('btn btn--small', () => this.move(npc), 'Move here'),
                gameButton('btn btn--small btn--danger', () => void this.remove(npc), this.deleting.has(npc.id) ? 'Deleting…' : this.saving.has(npc.id) ? 'Saving…' : 'Delete'));
            for (const button of actions.querySelectorAll('button')) button.disabled = this.deleting.has(npc.id) || this.saving.has(npc.id) || this.bulkDeleting || blocked;
            return el('div', 'npc-row',
                portrait,
                el('div', '', el('div', 'npc-row__name', npc.name), el('div', 'npc-row__meta', meta)),
                actions);
        }));
    }

    private async remove (npc: NpcRecord)
    {
        if (this.deleting.has(npc.id)) return;
        const building = npcStore.buildingOf(npc.id);
        const what = building ? `${npc.name} and their ${BUILDING_TYPES[building.type].label}` : npc.name;
        if (!window.confirm(`Permanently delete ${what}? Their private tutoring history, memories, voice sessions and private uploads will be removed. Shared class materials and other teachers will stay. Any active call with this teacher will end. This cannot be undone.`)) return;
        const ownerId = this.ownerId;
        this.deleting.add(npc.id);
        this.renderList();
        try
        {
            if (backendConfigured && !ownerId) throw new Error('Sign in to delete this teacher permanently. The village was not changed.');
            await this.beforeDelete(npc.id);
            if (backendConfigured)
            {
                const result = await deleteRemoteNpc(npc.id, ownerId!);
                if (this.ownerId !== ownerId) throw new Error('The teacher was deleted on the previous account. Refresh this account before changing its village.');
                this.serverCount = result.npc_count;
                npcStore.rememberRemoteDeletions(ownerId!, [npc.id]);
                // Keep the old local configuration hidden by an account-scoped tombstone;
                // never erase a different account's local save. Server completion is authoritative.
            }
            else npcStore.remove(npc.id);
            this.toasts.show(`${what} permanently removed.`);
            if (backendConfigured) await this.refreshRoster();
        }
        catch (err)
        {
            this.toasts.show(err instanceof Error ? err.message : 'Deletion failed. The teacher was kept; retry from the NPC list.', 'error');
        }
        finally { this.deleting.delete(npc.id); this.renderList(); }
    }

    private buildBulkDelete ()
    {
        const phrase = 'DELETE ALL';
        this.bulkInput.placeholder = phrase;
        this.bulkInput.autocomplete = 'off';
        this.bulkInput.spellcheck = false;
        this.bulkInput.setAttribute('aria-label', `Type ${phrase} to confirm`);
        this.bulkButton.type = 'button';
        this.bulkButton.textContent = 'Delete All My NPCs';
        this.bulkStatus.setAttribute('role', 'status');
        const sync = () => { this.bulkButton.disabled = this.bulkDeleting || this.bulkInput.value.trim() !== phrase; };
        this.bulkInput.addEventListener('input', sync);
        this.bulkButton.addEventListener('click', () => void this.deleteAll().finally(sync));
        sync();
        this.bulkBox.append(el('summary', '', 'Delete All My NPCs'),
            el('p', 'field__hint', `Permanently deletes every NPC on this account, including ones not in this village, with their private coursework, memories, conversations and voice sessions. Classes, progress, crystals and shared class materials stay. Type ${phrase} to confirm.`),
            el('div', 'npc-bulk__row', this.bulkInput, this.bulkButton), this.bulkStatus);
    }

    /** Deletes, one at a time, every NPC this account owns on the server (plus local-only ones). */
    private async deleteAll ()
    {
        const ownerId = this.ownerId;
        if (this.bulkDeleting || !ownerId) return;
        this.bulkDeleting = true;
        this.bulkButton.disabled = true;
        this.bulkStatus.classList.remove('is-error');
        this.bulkStatus.textContent = 'Loading your NPCs from the server…';
        this.renderList();
        let done = 0;
        let total = 0;
        try
        {
            // Fresh, owner-scoped list: retries only see what is still left.
            const roster = await loadNpcRoster();
            if (roster.ownerId !== ownerId || this.ownerId !== ownerId) throw new Error('Your account changed. Refresh before deleting.');
            const serverIds = new Set(roster.npcs.map((n) => n.game_npc_id));
            const localOnly = npcStore.all().filter((n) => !serverIds.has(n.id));
            total = roster.npcs.length + localOnly.length;
            const step = async (gameNpcId: string, name: string, run: () => Promise<{ npc_count: number }>) =>
            {
                this.bulkStatus.textContent = `Deleting ${name}… (deleted ${done} of ${total})`;
                await this.beforeDelete(gameNpcId);
                const result = await run();
                if (this.ownerId !== ownerId) throw new Error('Your account changed during deletion. Refresh this account.');
                done++;
                this.serverCount = result.npc_count;
                npcStore.rememberRemoteDeletions(ownerId, [gameNpcId]);
                this.bulkStatus.textContent = `Deleted ${done} of ${total}`;
            };
            for (const npc of roster.npcs) await step(npc.game_npc_id, npc.name, () => deleteRemoteNpcById(npc.id, ownerId));
            for (const npc of localOnly) await step(npc.id, npc.name, () => deleteRemoteNpc(npc.id, ownerId));

            await this.refreshRoster();
            const serverCount = this.roster?.ownerId === ownerId ? this.roster.npcs.length : null;
            const localCount = npcStore.all().length;
            const ok = serverCount === 0 && localCount === 0;
            this.bulkStatus.classList.toggle('is-error', !ok);
            this.bulkStatus.textContent = ok
                ? `Deleted ${done} of ${total}. Server NPCs: 0 · In this village: 0 · NPCs 0/${npcStore.usage().maxNpcs}.`
                : `Deleted ${done} of ${total}, but the check found server NPCs: ${serverCount ?? 'unknown'}, in this village: ${localCount}. Press the button again to retry.`;
            if (ok) this.bulkInput.value = '';
        }
        catch (err)
        {
            this.bulkStatus.classList.add('is-error');
            const message = err instanceof Error ? err.message : 'Deletion failed.';
            this.bulkStatus.textContent = `Stopped after deleting ${done} of ${total || '?'}: ${message} The remaining NPCs were kept. Press the button again to retry them.`;
            void this.refreshRoster();
        }
        finally
        {
            this.bulkDeleting = false;
            this.renderList();
        }
    }

    private async refreshRoster ()
    {
        const request = ++this.rosterRequest;
        const ownerId = this.ownerId;
        if (!ownerId) return;
        try
        {
            const roster = await loadNpcRoster();
            if (request !== this.rosterRequest || this.ownerId !== ownerId || roster.ownerId !== ownerId) return;
            this.roster = roster;
            this.serverCount = roster.npcs.length;
            npcStore.rememberRemoteDeletions(ownerId, roster.deletions.filter((d) => d.completed_at).map((d) => d.game_npc_id));
            this.report.textContent = JSON.stringify(compareNpcRoster(npcStore.all(), roster), null, 2);
        }
        catch (err)
        {
            if (request !== this.rosterRequest || this.ownerId !== ownerId) return;
            this.report.textContent = `Could not refresh the server roster: ${err instanceof Error ? err.message : 'Connection failed'}. Use Refresh comparison to retry. No records were deleted.`;
        }
        this.renderList();
    }

    private move (npc: NpcRecord)
    {
        const host = this.host;
        if (!host) return;
        this.startPlacement(npc.name, npc.appearance, npc.id, (placement) =>
        {
            const before = npcStore.entry(npc.id);
            const result = npcStore.relocate(npc.id, placement);
            if (!result.ok) { this.toasts.show(result.error, 'error'); return; }
            void this.persist(npc.id, before, `${npc.name} moved to the ${host.title}.`);
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

        this.pasteTitle.maxLength = 120;
        this.pasteTitle.placeholder = 'Title, e.g. Lecture 1 notes';
        this.pasteTitle.setAttribute('aria-label', 'Pasted notes title');
        this.pasteText.rows = 5;
        this.pasteText.placeholder = 'Paste lecture notes, textbook sections, homework questions…';
        this.pasteText.setAttribute('aria-label', 'Pasted notes');
        this.pasteBox.append(el('summary', '', 'Paste notes instead'), this.pasteTitle, this.pasteText);
        this.libraryButton.append(gameButton('btn btn--small btn--link', () => this.openLibrary(), 'Manage this class\'s coursework'));
        this.materialsBox.append(
            el('div', 'materials-box__row',
                gameButton('btn btn--small', () => this.materials.pick(), '+ Add files'),
                el('span', 'field__hint', 'PDF, DOCX, TXT or images, up to 10 MB each. You can also drop files here.')),
            this.materials.root, this.pasteBox);
        acceptDrops(this.materialsBox, (files) => this.materials.add(files));
        for (const [input, error] of [[this.nameInput, this.nameError], [this.subjectInput, this.subjectError]] as const)
        {
            input.addEventListener('input', () => { error.textContent = ''; input.removeAttribute('aria-invalid'); });
        }

        this.submitButton.type = 'submit';
        const form = el('form', 'npc-form panel',
            el('div', 'npc-form__head', this.heading, this.usage),
            el('div', 'form-row form-row--even',
                el('label', 'field', el('span', 'field__label', 'NPC name'), this.nameInput, this.nameError),
                el('label', 'field', el('span', 'field__label', 'Class / subject'), this.subjectInput, this.subjectError, this.subjectHint)),
            this.subjects,
            el('div', 'field', el('span', 'field__label', 'Appearance'), looks),
            el('div', 'field', el('span', 'field__label', 'Building'), buildingPreview),
            // No greeting / personality / instructions to write: every teacher introduces itself
            // and teaches from its name + class, and students personalise it in chat.
            el('p', 'field__hint npc-form__note', 'No setup needed: your teacher introduces themselves and adapts when students ask in chat.'),
            ...(backendConfigured ? [
                el('div', 'field materials-field',
                    el('span', 'field__label', 'Starting materials', el('span', 'field__hint', ' (optional)')),
                    this.materialsSignIn.root,
                    this.materialsBox,
                    this.libraryButton),
            ] : []),
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
            ? `Class limit reached: pick an existing class${editingId ? ' or keep this one' : ''}.`
            : 'Teachers can share a class.';
    }

    private openForm (npc: NpcRecord | null)
    {
        if (!this.host || this.placing) return;
        if (!npcStore.editable())
        {
            this.toasts.show('Your NPCs are still loading from your account. Try again in a moment.', 'error');
            return;
        }
        const { npcs, maxNpcs } = npcStore.usage();
        if (!npc && npcs >= maxNpcs)
        {
            this.toasts.show(`NPC limit reached (${maxNpcs}/${maxNpcs}). Delete an NPC to add a new one.`, 'error');
            return;
        }

        this.editingId = npc?.id ?? null;
        this.heading.textContent = npc ? `Edit ${npc.name}` : 'Create an NPC';
        this.usage.textContent = this.usageText();
        this.submitButton.textContent = npc ? 'Save changes' : 'Create & place building';
        this.nameInput.value = npc?.name ?? '';
        this.subjectInput.value = npc?.subject ?? '';
        this.materials.clear();
        this.pasteTitle.value = '';
        this.pasteText.value = '';
        this.pasteBox.open = false;
        // Existing NPCs manage their whole library in the Coursework Library panel.
        this.libraryButton.classList.toggle('hidden', !npc || !this.signedIn);
        this.materialsSignIn.refresh();
        for (const [id, { input, img }] of this.lookInputs)
        {
            input.checked = id === (npc?.appearance ?? 'scientist');
            img.src = this.host.portraitUrl(id);
        }
        this.renderSubjectChoices(this.editingId);
        this.renderBuildingPreview();
        this.error.textContent = '';
        for (const [input, error] of [[this.nameInput, this.nameError], [this.subjectInput, this.subjectError]] as const)
        {
            error.textContent = '';
            input.removeAttribute('aria-invalid');
        }

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
        const invalid = (input: HTMLInputElement, error: HTMLElement, message: string) =>
        {
            error.textContent = message;
            input.setAttribute('aria-invalid', 'true');
        };
        if (!name) invalid(this.nameInput, this.nameError, 'Give your teacher a name.');
        if (!subject) invalid(this.subjectInput, this.subjectError, 'Enter the class or subject they teach.');
        if (!name || !subject) { (name ? this.subjectInput : this.nameInput).focus(); return; }
        if (!this.editingId && this.signedIn && (this.serverCount === null || this.serverCount >= 10))
        {
            this.error.textContent = 'The server roster is full or unavailable. Check NPCs → Compare with server before creating another teacher.';
            return;
        }
        // Same rules the store enforces, checked early so the user can fix the form.
        const limit = npcStore.checkLimits(subject, this.editingId ?? undefined);
        if (limit)
        {
            invalid(this.subjectInput, this.subjectError, limit);
            this.subjectInput.focus();
            return;
        }

        const appearance = this.selectedAppearance();
        // Only these fields are edited. An update merges into the stored record, so older NPCs
        // keep their saved greeting, personality, teaching instructions and mini-game.
        const fields = { name, subject, appearance };
        const files = this.materials.all.map((a) => a.file);
        const paste = this.pasteText.value.trim() ? { title: this.pasteTitle.value.trim() || 'Pasted notes', text: this.pasteText.value.trim() } : null;
        if (paste && paste.text.length < 20) { this.error.textContent = 'Paste at least a few sentences of notes, or clear the box.'; return; }
        if ((files.length || paste) && !this.signedIn)
        {
            this.error.textContent = 'Sign in under Starting materials to upload them, or remove them to continue.';
            return;
        }

        const editingId = this.editingId;
        if (editingId)
        {
            const before = npcStore.entry(editingId);
            const result = npcStore.update(editingId, fields);
            if (!result.ok) { this.error.textContent = result.error; return; }
            this.closeForm();
            void this.persist(editingId, before, `Saved ${name}.`).then((ok) => { if (ok) this.uploadMaterials(result.value, files, paste); });
            return;
        }

        this.closeForm();
        this.startPlacement(name, appearance, null, (placement) =>
        {
            const result = npcStore.create({ ...fields, dialogue: [], minigameType: null }, placement);
            if (result.ok)
            {
                // Signed in, the NPC only stays once Supabase has it (the server enforces the limits).
                void this.persist(result.value.id, null, `${name} and their ${buildingLabel(appearance)} joined the ${host.title}!`, 'reward').then((ok) =>
                {
                    if (!ok) { this.reopenDraft('The teacher was not saved to your account. Check the message, then try again.'); return; }
                    this.materials.clear();
                    this.uploadMaterials(result.value, files, paste);
                });
            }
            else
            {
                // Nothing was created: bring the form back with everything still filled in.
                this.toasts.show(result.error, 'error');
                this.reopenDraft(result.error);
            }
        }, () => this.reopenDraft(''));
    }

    // ------------------------------------------------------------ class materials

    private setSignedIn (signedIn: boolean, ownerId: string | null = null)
    {
        this.signedIn = signedIn;
        if (ownerId !== this.ownerId)
        {
            this.ownerId = ownerId;
            this.roster = null;
            this.serverCount = null;
            this.rosterRequest++;
            this.closeForm();
            if (this.placing) this.host?.cancelPlacement();
            npcStore.useAccount(ownerId);
            if (ownerId) void this.loadVillage();
        }
        else if (ownerId) void this.refreshRoster();
        this.materialsSignIn.root.classList.toggle('hidden', signedIn);
        this.materialsBox.classList.toggle('hidden', !signedIn);
        this.renderList();
    }

    /** Loads the signed-in account's village from Supabase (edits stay paused until it succeeds). */
    private async loadVillage ()
    {
        const ownerId = this.ownerId;
        if (!ownerId) return;
        this.renderList();
        try
        {
            const result = await loadAccountVillage(ownerId);
            if (this.ownerId !== ownerId) return;
            if (result.imported) this.toasts.show(`Saved ${result.imported} NPC${result.imported === 1 ? '' : 's'} from this browser to your account.`, 'reward');
            for (const warning of result.warnings) this.toasts.show(warning, 'error');
        }
        catch (err)
        {
            if (this.ownerId === ownerId) this.toasts.show(err instanceof Error ? `Could not load your NPCs: ${err.message}` : 'Could not load your NPCs.', 'error');
        }
        if (this.ownerId === ownerId) await this.refreshRoster();
    }

    /**
     * Saves an NPC change to the account. If Supabase refuses it, the NPC is put back exactly
     * as before (or removed again, for a new one) so the village never shows unsaved teachers.
     */
    private async persist (id: string, before: VillageEntry | null, done: string, kind: 'info' | 'reward' = 'info'): Promise<boolean>
    {
        const ownerId = this.ownerId;
        this.saving.add(id);
        this.renderList();
        try
        {
            await saveNpc(id);
            this.toasts.show(done, kind);
            if (ownerId) void this.refreshRoster();
            return true;
        }
        catch (err)
        {
            if (npcStore.activeAccount() === ownerId) npcStore.restore(id, before);
            this.toasts.show(`Not saved to your account: ${err instanceof Error ? err.message : 'connection failed'}. The change was undone.`, 'error');
            return false;
        }
        finally
        {
            this.saving.delete(id);
            this.renderList();
        }
    }

    /** Uploads teacher material for the NPC's class (after the NPC exists, so it has a class). */
    private uploadMaterials (npc: NpcRecord, files: File[], paste: { title: string; text: string } | null = null)
    {
        // Sync right before uploading so the backend NPC + class match the saved record.
        let synchronized: ReturnType<typeof syncNpc> | null = null;
        const remote = () => synchronized ??= syncNpc(npcStore.get(npc.id) ?? npc).then(async (result) =>
        {
            await this.refreshRoster();
            return result;
        });
        if (paste)
        {
            void remote().then((r) => pasteCoursework(r, paste.title, paste.text, 'class'))
                .then((row) => this.toasts.show(row.status === 'ready' ? `"${row.title}" saved to the Coursework Library.` : `"${row.title}" could not be processed: ${row.error ?? ''}`, row.status === 'ready' ? 'reward' : 'error'))
                .catch((err) => this.toasts.show(`Notes not saved: ${err instanceof Error ? err.message : 'error'}`, 'error'));
        }
        if (!files.length) return;
        this.uploadTitle.textContent = `Class materials for ${npc.name}`;
        this.uploadPanel.classList.remove('hidden');
        this.uploadQueue.add(files, 'class', remote);
    }

    private openLibrary ()
    {
        const npc = this.editingId ? npcStore.get(this.editingId) : null;
        if (!npc || !this.library) return;
        this.closeForm();
        this.syncInput();
        this.host?.setInputEnabled(false);
        this.library.open(npc, 'class', () => this.host?.setInputEnabled(true));
    }

    // ------------------------------------------------------------ placement

    /** Back to the create form after a cancelled / failed placement, keeping what was entered. */
    private reopenDraft (error: string)
    {
        if (!this.host) return;
        this.error.textContent = error;
        this.backdrop.classList.remove('hidden');
        this.formOpen = true;
        this.syncInput();
        this.submitButton.focus();
    }

    private startPlacement (name: string, appearance: AppearanceId, ignoreId: string | null, onPlace: (placement: Placement) => void, onCancel?: () => void)
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
        host.beginPlacement(appearance, ignoreId, (placement) => { end(); onPlace(placement); }, () => { end(); onCancel?.(); });
    }

    private syncInput ()
    {
        this.host?.setInputEnabled(!this.formOpen && !this.placing);
    }
}
