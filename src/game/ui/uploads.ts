// Attachment + upload widgets shared by the chat composer and the NPC editor:
//   AttachmentTray - one "+" button, multi-select, drag-and-drop, pasted screenshots, and
//                    compact chips (preview / icon, name, state, remove). Same look everywhere.
//   UploadQueue    - runs uploads one by one, showing progress / processing / ready / error,
//                    with Retry for failed files (the file is kept, nothing is lost).

import { ACCEPT_ATTRIBUTE, checkUpload, type DocumentVisibility } from '../../../supabase/functions/_shared/documentRules';
import { uploadDocument, type CourseworkMeta, type MaterialRow, type RemoteNpc } from '../services/tutorApi';
import { el, gameButton } from './dom';

/** Small line icons (stroke = currentColor), so controls are not emoji. */
export const ICONS = {
    plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
    close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

/** An icon-only button with an accessible name. */
export function iconButton (className: string, icon: keyof typeof ICONS, label: string, onClick: () => void)
{
    const button = gameButton(`icon-only ${className}`, onClick);
    button.innerHTML = ICONS[icon];
    button.setAttribute('aria-label', label);
    button.title = label;
    return button;
}

const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Opens the system file dialog / accepts dropped files; reports only files that pass the rules. */
export function fileInput (onFiles: (files: File[]) => void)
{
    const input = el('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ACCEPT_ATTRIBUTE;
    input.className = 'visually-hidden';
    input.tabIndex = -1;
    input.addEventListener('change', () =>
    {
        const files = [...(input.files ?? [])];
        input.value = '';
        if (files.length) onFiles(files);
    });
    return input;
}

/** Makes `target` a drop zone. */
export function acceptDrops (target: HTMLElement, onFiles: (files: File[]) => void)
{
    let depth = 0;
    target.addEventListener('dragenter', (event) => { event.preventDefault(); depth++; target.classList.add('is-dragging'); });
    target.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
    target.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; target.classList.remove('is-dragging'); } });
    target.addEventListener('drop', (event) =>
    {
        event.preventDefault();
        depth = 0;
        target.classList.remove('is-dragging');
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length) onFiles(files);
    });
}

export type AttachmentState = 'pending' | 'uploading' | 'processing' | 'ready' | 'failed';

export interface Attachment
{
    id: string;
    file: File;
    isImage: boolean;
    /** Object URL for image thumbnails (revoked on remove / clear). */
    previewUrl: string | null;
    state: AttachmentState;
    progress: number;
    /** Set once the file is stored + processed, so a retry never uploads it twice. */
    documentId: string | null;
    error: string;
}

export interface TrayOptions
{
    /** Max files at once. */
    max: number;
    /** Chat: images up to this size are sent with the message instead of uploaded. 0 = never. */
    inlineImageBytes: number;
    /** One line under the chips explaining where the files go (privacy). */
    note: (items: readonly Attachment[]) => string;
    onChange?: () => void;
}

const STATE_TEXT: Record<AttachmentState, string> = { pending: '', uploading: 'Uploading', processing: 'Reading…', ready: 'Ready', failed: 'Failed' };
const extension = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? 'file').toUpperCase();

/**
 * Pending attachments next to a composer / form: "+" opens the file dialog (multi-select);
 * drops and pasted screenshots land here too. Validation uses the same rules as the server.
 */
export class AttachmentTray
{
    readonly root: HTMLElement;
    readonly button: HTMLButtonElement;
    private input: HTMLInputElement;
    private list = el('ul', 'attach-list');
    private noteEl = el('p', 'attach-note');
    private errorEl = el('p', 'attach-error');
    private items: Attachment[] = [];
    private locked = false;

    constructor (private options: TrayOptions)
    {
        this.input = fileInput((files) => this.add(files));
        this.button = iconButton('attach-btn', 'plus', 'Attach files or images', () => this.input.click());
        this.list.setAttribute('aria-label', 'Attachments');
        this.errorEl.setAttribute('role', 'alert');
        this.root = el('div', 'attach hidden', this.list, this.noteEl, this.errorEl, this.input);
    }

    get all (): readonly Attachment[] { return this.items; }
    /** Opens the file dialog (for a labelled button elsewhere). */
    pick () { if (!this.locked) this.input.click(); }
    get isEmpty () { return this.items.length === 0; }

    /** While sending: chips cannot be removed and nothing can be added. */
    setLocked (locked: boolean)
    {
        this.locked = locked;
        this.button.disabled = locked;
        this.render();
    }

    add (files: readonly File[])
    {
        if (this.locked) return;
        const problems: string[] = [];
        for (const raw of files)
        {
            // Pasted screenshots have no name; give them one the upload rules accept.
            const file = raw.name ? raw : new File([raw], `screenshot-${Date.now()}.png`, { type: raw.type || 'image/png' });
            const check = checkUpload(file.name, file.type, file.size);
            if (!check.ok) { problems.push(`${file.name}: ${check.error}`); continue; }
            if (this.items.length >= this.options.max) { problems.push(`At most ${this.options.max} files at once.`); break; }
            if (this.items.some((a) => a.file.name === file.name && a.file.size === file.size)) continue;
            const isImage = check.fileType === 'png' || check.fileType === 'jpeg' || check.fileType === 'webp' || check.fileType === 'heic';
            this.items.push({
                id: crypto.randomUUID(), file, isImage, previewUrl: isImage && check.fileType !== 'heic' ? URL.createObjectURL(file) : null,
                state: 'pending', progress: 0, documentId: null, error: '',
            });
        }
        this.errorEl.textContent = problems.join(' ');
        this.render();
    }

    /** True if this image is sent with the message (not uploaded). */
    isInline (a: Attachment)
    {
        return a.isImage && this.options.inlineImageBytes > 0 && a.file.size <= this.options.inlineImageBytes;
    }

    update (id: string, patch: Partial<Attachment>)
    {
        const item = this.items.find((a) => a.id === id);
        if (item) Object.assign(item, patch);
        this.render();
    }

    remove (id: string)
    {
        const item = this.items.find((a) => a.id === id);
        if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
        this.items = this.items.filter((a) => a.id !== id);
        this.errorEl.textContent = '';
        this.render();
    }

    clear ()
    {
        for (const item of this.items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        this.items = [];
        this.errorEl.textContent = '';
        this.locked = false;
        this.button.disabled = false;
        this.render();
    }

    showError (text: string)
    {
        this.errorEl.textContent = text;
        this.root.classList.toggle('hidden', !text && this.isEmpty);
    }

    private render ()
    {
        this.list.replaceChildren(...this.items.map((a) =>
        {
            const thumb = a.previewUrl
                ? Object.assign(el('img', 'attach-chip__thumb'), { src: a.previewUrl, alt: '' })
                : el('span', 'attach-chip__icon', extension(a.file.name));
            const state = a.state === 'uploading' ? `Uploading ${Math.round(a.progress * 100)}%`
                : a.state === 'failed' ? `Failed: ${a.error || 'could not be processed'}` : STATE_TEXT[a.state] || formatSize(a.file.size);
            const remove = iconButton('attach-chip__remove', 'close', `Remove ${a.file.name}`, () => this.remove(a.id));
            remove.disabled = this.locked;
            const chip = el('li', `attach-chip is-${a.state}`, thumb,
                el('span', 'attach-chip__text', el('span', 'attach-chip__name', a.file.name), el('span', 'attach-chip__state', state)),
                remove);
            chip.title = a.file.name;
            return chip;
        }));
        this.noteEl.textContent = this.items.length ? this.options.note(this.items) : '';
        this.root.classList.toggle('hidden', this.isEmpty && !this.errorEl.textContent);
        this.options.onChange?.();
    }
}

type RowState = 'queued' | 'uploading' | 'processing' | 'ready' | 'failed';

const STATUS_TEXT: Record<RowState, string> = {
    queued: 'Waiting…', uploading: 'Uploading', processing: 'Reading document…', ready: 'Ready', failed: 'Failed',
};

/** Upload progress list. Uploads run one at a time so status stays readable. */
export class UploadQueue
{
    readonly root = el('ul', 'file-list upload-queue hidden');
    private chain: Promise<unknown> = Promise.resolve();
    private active = 0;

    constructor (private onSettled: (row: MaterialRow | null) => void = () => {})
    {}

    get busy ()
    {
        return this.active > 0;
    }

    /** Queues files for `npc`. `resolveNpc` runs right before upload (e.g. after sign-in / sync). */
    add (files: readonly File[], visibility: DocumentVisibility, resolveNpc: () => Promise<RemoteNpc>, meta: CourseworkMeta = {})
    {
        for (const file of files)
        {
            const status = el('span', 'file-row__status');
            const bar = el('span', 'progress__fill');
            const progress = el('span', 'progress', bar);
            const dismiss = gameButton('btn btn--small', () => row.remove(), 'Dismiss');
            dismiss.classList.add('hidden');
            // A failed file stays listed with Retry: it is never silently lost.
            const retry = gameButton('btn btn--small', () => { row.remove(); this.add([file], visibility, resolveNpc, meta); }, 'Retry');
            retry.classList.add('hidden');
            const row = el('li', 'file-row', el('span', 'file-row__name', file.name), status, progress, retry, dismiss);
            const set = (state: RowState, fraction = 0, detail = '') =>
            {
                row.dataset.state = state;
                status.textContent = state === 'uploading' ? `${STATUS_TEXT.uploading} ${Math.round(fraction * 100)}%` : (detail || STATUS_TEXT[state]);
                bar.style.width = `${Math.round((state === 'processing' || state === 'ready' ? 1 : fraction) * 100)}%`;
                progress.classList.toggle('hidden', state === 'ready' || state === 'failed' || state === 'queued');
                dismiss.classList.toggle('hidden', state !== 'ready' && state !== 'failed');
                retry.classList.toggle('hidden', state !== 'failed');
            };
            set('queued');
            this.root.append(row);
            this.root.classList.remove('hidden');
            this.active++;

            this.chain = this.chain.then(async () =>
            {
                let result: MaterialRow | null = null;
                try
                {
                    const npc = await resolveNpc();
                    result = await uploadDocument(npc, file, visibility, (phase, fraction) => set(phase, fraction), meta);
                    if (result.status === 'ready') set('ready', 1, result.needsReview ? 'Ready · check the transcription' : result.error ? `Ready (${result.error})` : `Ready · ${result.chunkCount} sections`);
                    else set('failed', 0, result.error ?? 'Could not be processed.');
                }
                catch (err)
                {
                    set('failed', 0, err instanceof Error ? err.message : 'Upload failed.');
                }
                finally
                {
                    this.active--;
                    this.onSettled(result);
                }
            });
        }
    }

    whenIdle ()
    {
        return this.chain;
    }
}
