// Mini-game picker opened from an NPC's "Mini-games" choice: one shared coursework selection,
// then a card per game (Answer Dash, Spellshot; + the NPC's original quiz challenge for older
// saves). New games are added as further cards.

import type { NpcRecord } from '../data/npcStore';
import { backendConfigured, getSession, onSessionChange } from '../services/backend';
import { startMinigame, type DashPack, type DashSource, type MinigameSetup, type SpellshotSpeed } from '../services/minigameApi';
import { listMaterials, syncNpc, TutorApiError, type MaterialRow, type RemoteNpc } from '../services/tutorApi';
import { el, gameButton, keyHints, type Modal } from './dom';
import type { CourseworkLibrary } from './CourseworkLibrary';
import { SignInBox } from './SignInBox';

export interface MinigameHandlers
{
    onBack (): void;
    onLegacy (play: () => void): void;
    onStart (launch: MinigameLaunch): void;
}

export interface MinigameLaunch
{
    remote: RemoteNpc;
    pack: DashPack;
    source: DashSource;
    setup: MinigameSetup;
}

const SPEEDS: [SpellshotSpeed, string][] = [['gentle', 'Gentle'], ['brisk', 'Brisk'], ['swift', 'Swift']];
const CHOICE_COUNTS = [3, 4, 5];

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

export class MinigamePanel implements Modal
{
    private root: HTMLElement;
    private portrait = el('img', 'portrait');
    private nameEl = el('span', 'dialogue__name');
    private subjectTag = el('span', 'tag');
    private classTag = el('span', 'tag tag--muted');
    private sourceBody = el('div', 'mg-coursework');
    private dashActions = el('div', 'mg-card__actions');
    private shotActions = el('div', 'mg-card__actions');
    private legacyCard = el('article', 'mg-card hidden');
    private status = el('div', 'tutor__status hidden');
    private signin = new SignInBox('Sign in so your teacher can write questions from your class materials and save your scores.');
    private sourceList = el('div', 'mg-sources');
    private sourceBoxes: { id: string; input: HTMLInputElement }[] = [];
    private startButtons: HTMLButtonElement[];
    private shotSetup: { speed: SpellshotSpeed; choices: number } = { speed: 'brisk', choices: 4 };

    private record: NpcRecord | null = null;
    private remote: RemoteNpc | null = null;
    private handlers: MinigameHandlers | null = null;
    private generation = 0;
    private busy = false;

    constructor (parent: HTMLElement, private library: CourseworkLibrary)
    {
        this.portrait.alt = '';
        this.sourceList.setAttribute('role', 'group');
        this.sourceList.setAttribute('aria-label', 'Coursework to use');
        const dashStart = gameButton('btn btn--primary', () => void this.start({ game: 'answer_dash' }), 'Start');
        const shotStart = gameButton('btn btn--primary', () => void this.start({ game: 'spellshot', ...this.shotSetup }), 'Start');
        dashStart.setAttribute('aria-label', 'Start Answer Dash');
        shotStart.setAttribute('aria-label', 'Start Spellshot');
        this.startButtons = [dashStart, shotStart];
        const dashCard = el('article', 'mg-card',
            el('h3', 'mg-card__title', 'Answer Dash'),
            el('p', 'mg-card__desc', 'Run through the garden! Questions come only from this class\'s coursework. Each question shows four answers on the gates ahead: switch lanes (A/D, arrows or tap) to run through the right one before you reach it.'),
            this.dashActions);
        const shotCard = el('article', 'mg-card',
            el('h3', 'mg-card__title', 'Spellshot'),
            el('p', 'mg-card__desc', 'A 60-second spell drill in the garden clearing. Read the prompt, then click or tap the floating wisp with the matching answer (or press its number) before the clock runs out. Streaks score more; wrong shots cost points.'),
            el('div', 'mg-options',
                this.optionGroup('Wisp speed', SPEEDS.map(([value, label]) => [value, label]), this.shotSetup.speed, (v) => { this.shotSetup.speed = v as SpellshotSpeed; }),
                this.optionGroup('Answers', CHOICE_COUNTS.map((n) => [String(n), String(n)]), String(this.shotSetup.choices), (v) => { this.shotSetup.choices = Number(v); })),
            this.shotActions);
        this.root = el('section', 'mg panel hidden',
            el('header', 'tutor__head', this.portrait,
                el('div', 'tutor__title', this.nameEl, el('div', 'tutor__tags', this.subjectTag, this.classTag)),
                gameButton('btn btn--small tutor__close', () => this.back(), '✕')),
            el('h2', 'mg__heading', 'Mini-games'),
            this.sourceBody, dashCard, shotCard, this.legacyCard, this.status,
            el('div', 'form-actions', gameButton('btn', () => this.back(), 'Back')),
            keyHints([['Esc', 'back']]));
        this.root.setAttribute('role', 'dialog');
        this.root.setAttribute('aria-label', 'Mini-games');
        parent.append(this.root);

        window.addEventListener('keydown', (event) =>
        {
            if (event.key === 'Escape' && this.record && !this.root.classList.contains('hidden')) { event.preventDefault(); this.back(); }
        });
        onSessionChange((session) => { if (this.record && session && !this.remote) void this.load(); });
    }

    handleKey (key: string)
    {
        if (key === 'escape') this.back();
    }

    open (record: NpcRecord, portrait: string, legacy: { label: string; play: () => void } | null, handlers: MinigameHandlers,
        autoStart?: { source: DashSource; setup: MinigameSetup })
    {
        this.generation++;
        this.record = record;
        this.remote = null;
        this.handlers = handlers;
        this.busy = false;
        this.portrait.src = portrait;
        this.nameEl.textContent = record.name;
        this.subjectTag.textContent = record.subject;
        this.classTag.textContent = backendConfigured ? 'Class: …' : 'Offline';
        this.legacyCard.classList.toggle('hidden', !legacy);
        if (legacy)
        {
            this.legacyCard.replaceChildren(
                el('h3', 'mg-card__title', legacy.label),
                el('p', 'mg-card__desc', `${record.name}'s classic quiz challenge, with its reward.`),
                el('div', 'mg-card__body', gameButton('btn btn--primary', () => this.handlers?.onLegacy(legacy.play), 'Play')));
        }
        this.setStatus('');
        this.root.classList.remove('hidden');
        void this.load(autoStart);
    }

    close ()
    {
        this.generation++;
        this.record = null;
        this.root.classList.add('hidden');
    }

    private back ()
    {
        if (!this.record) return;
        const handlers = this.handlers;
        this.close();
        handlers?.onBack();
    }

    private setStatus (text: string, isError = false, retry?: () => void)
    {
        this.status.replaceChildren(text, ...(retry ? [gameButton('btn btn--small', retry, 'Retry')] : []));
        this.status.classList.toggle('is-error', isError);
        this.status.classList.toggle('hidden', !text);
    }

    /** A small radio group (segmented buttons) for one Spellshot setting. */
    private optionGroup (label: string, options: [string, string][], selected: string, onPick: (value: string) => void)
    {
        const name = `mg-${label.toLowerCase().replace(/\W+/g, '-')}`;
        const group = el('fieldset', 'mg-option', el('legend', 'field__label', label));
        for (const [value, text] of options)
        {
            const input = el('input');
            input.type = 'radio';
            input.name = name;
            input.value = value;
            input.checked = value === selected;
            input.addEventListener('change', () => { if (input.checked) onPick(value); });
            group.append(el('label', 'mg-option__choice', input, el('span', '', text)));
        }
        return group;
    }

    /** Start buttons exist only while coursework is ready (no general-practice fallback). */
    private showStart (ready: boolean)
    {
        [this.dashActions, this.shotActions].forEach((actions, i) => actions.replaceChildren(...(ready ? [this.startButtons[i]] : [])));
        this.startButtons.forEach((b) => { b.disabled = false; });
    }

    private async load (autoStart?: { source: DashSource; setup: MinigameSetup })
    {
        const generation = this.generation;
        const record = this.record;
        if (!record) return;
        this.showStart(false);
        if (!backendConfigured)
        {
            this.sourceBody.replaceChildren(el('p', 'mg-card__note', 'Mini-games need the online tutoring service, which is not set up in this copy of the game.'));
            return;
        }
        this.sourceBody.replaceChildren(el('p', 'mg-card__note', 'Loading class materials…'));
        try
        {
            if (!(await getSession()))
            {
                if (generation !== this.generation) return;
                this.sourceBody.replaceChildren(this.signin.root);
                this.signin.focus();
                return;
            }
            const remote = await syncNpc(record);
            const materials = await listMaterials(remote);
            if (generation !== this.generation) return;
            this.remote = remote;
            this.classTag.textContent = `Class: ${remote.className}`;
            this.renderSources(materials, record);
            if (autoStart) void this.start(autoStart.setup, autoStart.source);
        }
        catch (err)
        {
            if (generation !== this.generation) return;
            this.sourceBody.replaceChildren(el('p', 'mg-card__note', 'Could not load class materials.'));
            this.setStatus(errorText(err), true, () => void this.load());
        }
    }

    private renderSources (materials: MaterialRow[], record: NpcRecord)
    {
        const ready = materials.filter((m) => m.status === 'ready');
        const pending = materials.filter((m) => m.status === 'pending' || m.status === 'processing').length;
        const addButton = gameButton('btn', () => this.openLibrary(record), 'Add Coursework');
        const notes = [];
        if (pending) notes.push(el('p', 'mg-card__note', `${pending} document${pending === 1 ? ' is' : 's are'} still processing and not included yet.`));
        if (!ready.length)
        {
            // Mini-games never fall back to general questions: coursework is required.
            this.sourceBoxes = [];
            this.sourceBody.replaceChildren(
                el('p', 'mg-card__note', `Each game only asks questions from ${record.name}'s class materials, and there are none ready yet. Add coursework: upload files or paste your notes.`),
                ...notes, el('div', 'mg-card__actions', addButton));
            return;
        }
        this.sourceBoxes = ready.map((m) =>
        {
            const input = el('input');
            input.type = 'checkbox';
            input.checked = true;
            return { id: m.id, input, label: `${m.title}${m.visibility === 'private' ? ' (yours)' : ''}${m.topic ? ` · ${m.topic}` : ''}` };
        }).map(({ id, input, label }) =>
        {
            this.sourceList.append(el('label', 'mg-source', input, el('span', '', label)));
            return { id, input };
        });
        this.sourceList.replaceChildren(...this.sourceBoxes.map(({ input }) => input.parentElement!));
        const all = gameButton('btn btn--small', () => this.sourceBoxes.forEach(({ input }) => { input.checked = true; }), 'Select all');
        const none = gameButton('btn btn--small', () => this.sourceBoxes.forEach(({ input }) => { input.checked = false; }), 'Clear');
        this.sourceBody.replaceChildren(
            el('div', 'field', el('span', 'field__label', `Questions from (${ready.length} ready)`), el('div', 'mg-sources__tools', all, none, el('span', 'dash__spacer'), addButton), this.sourceList),
            ...notes);
        this.showStart(true);
    }

    private openLibrary (record: NpcRecord)
    {
        this.root.classList.add('hidden');
        this.library.open(record, 'class', () =>
        {
            if (this.record !== record) return;
            this.root.classList.remove('hidden');
            void this.load();
        });
    }

    private selectedSource (): DashSource | null
    {
        const picked = this.sourceBoxes.filter(({ input }) => input.checked).map(({ id }) => id);
        if (!picked.length) return null;
        return picked.length === this.sourceBoxes.length ? 'all' : { documentIds: picked };
    }

    private async start (setup: MinigameSetup, picked = this.selectedSource())
    {
        const remote = this.remote;
        if (!remote || this.busy) return;
        if (!picked) return this.setStatus('Pick at least one document.', true);
        const source = picked;
        const generation = this.generation;
        this.busy = true;
        this.startButtons.forEach((b) => { b.disabled = true; });
        this.setStatus(`${this.record?.name ?? 'Your teacher'} is writing your ${setup.game === 'spellshot' ? 'spell prompts' : 'questions'}… (up to ~30 seconds)`);
        try
        {
            const pack = await startMinigame(remote, source, setup);
            if (generation !== this.generation) return;
            const handlers = this.handlers;
            this.close();
            handlers?.onStart({ remote, pack, source, setup });
        }
        catch (err)
        {
            if (generation !== this.generation) return;
            const code = err instanceof TutorApiError ? err.code : '';
            const hint = code === 'no_materials' ? ' Use Add Coursework to upload files or paste notes.' : '';
            this.setStatus(`${errorText(err)}${hint}`, true, code === 'no_materials' ? undefined : () => void this.start(setup, source));
        }
        finally
        {
            if (generation === this.generation) { this.busy = false; this.startButtons.forEach((b) => { b.disabled = false; }); }
        }
    }
}
