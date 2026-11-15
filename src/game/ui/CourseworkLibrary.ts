// Coursework Library for one NPC's class: upload files (PDF, DOCX, TXT, images), paste text,
// add public websites (read once, saved as study notes), organise by topic / chapter / type, preview (original image + extracted text), correct
// flagged image transcriptions, rename, replace and delete. One panel, opened from the NPC
// editor, Chat & Study, Class Materials and the mini-game picker.

import type { NpcRecord } from '../data/npcStore';
import { MAX_PASTE_CHARS, type DocumentVisibility } from '../../../supabase/functions/_shared/documentRules';
import {
    addWebsite, correctDocument, deleteDocument, listMaterials, pasteCoursework, syncNpc, updateDocument, viewDocument,
    type MaterialRow, type RemoteNpc,
} from '../services/tutorApi';
import { el, gameButton, keyHints } from './dom';
import { acceptDrops, fileInput, UploadQueue } from './uploads';

type Grouping = 'topic' | 'chapter' | 'type';

const STATUS: Record<MaterialRow['status'], string> = { pending: 'Uploading…', processing: 'Processing…', ready: 'Ready', failed: 'Failed' };
const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');
const typeLabel = (row: MaterialRow) => (row.sourceUrl ? 'Website' : row.fileType === 'text' ? 'Pasted notes' : row.isImage ? 'Image' : row.fileType.toUpperCase());

export class CourseworkLibrary
{
    private root: HTMLElement;
    private heading = el('h2', 'library__heading');
    private hint = el('p', 'field__hint');
    private status = el('div', 'tutor__status hidden');
    private list = el('div', 'library__list');
    private detail = el('section', 'library__detail hidden');
    private pasteForm: HTMLElement;
    private pasteTitle = el('input');
    private pasteTopic = el('input');
    private pasteChapter = el('input');
    private pasteText = el('textarea');
    private pasteCount = el('span', 'field__hint');
    private uploadTopic = el('input');
    private webForm: HTMLElement;
    private webUrl = el('input');
    private webTitle = el('input');
    private webTopic = el('input');
    private webSave: HTMLButtonElement;
    private groupSelect = el('select');
    private uploads: UploadQueue;
    private picker: HTMLInputElement;
    private replacing: MaterialRow | null = null;

    private record: NpcRecord | null = null;
    private remote: RemoteNpc | null = null;
    private visibility: DocumentVisibility = 'private';
    private rows: MaterialRow[] = [];
    private onClose: (() => void) | null = null;
    private generation = 0;

    constructor (parent: HTMLElement)
    {
        this.uploads = new UploadQueue((row) =>
        {
            if (row && this.replacing && row.status === 'ready')
            {
                // Replace = new version is ready first, then the old one is removed.
                const old = this.replacing;
                this.replacing = null;
                void deleteDocument(old.id).catch(() => undefined).then(() => this.refresh());
                return;
            }
            void this.refresh();
        });
        this.picker = fileInput((files) => this.queue(files));

        this.pasteTitle.maxLength = 120;
        this.pasteTitle.placeholder = 'e.g. Lecture 5: Quadratic functions';
        for (const input of [this.pasteTopic, this.pasteChapter, this.uploadTopic]) input.maxLength = 80;
        this.pasteTopic.placeholder = 'Topic (optional)';
        this.pasteChapter.placeholder = 'Chapter (optional)';
        this.uploadTopic.placeholder = 'Topic for new uploads (optional)';
        this.uploadTopic.setAttribute('aria-label', 'Topic for new uploads');
        this.pasteText.rows = 10;
        this.pasteText.maxLength = MAX_PASTE_CHARS;
        this.pasteText.placeholder = 'Paste lecture notes, textbook sections, homework questions, study guides…';
        this.pasteText.addEventListener('input', () => { this.pasteCount.textContent = `${this.pasteText.value.length.toLocaleString()} characters`; });
        this.pasteForm = el('section', 'library__paste hidden',
            el('h3', '', 'Paste text'),
            el('label', 'field', el('span', 'field__label', 'Title'), this.pasteTitle),
            el('div', 'form-row form-row--even', el('label', 'field', el('span', 'field__label', 'Topic'), this.pasteTopic), el('label', 'field', el('span', 'field__label', 'Chapter'), this.pasteChapter)),
            el('label', 'field', el('span', 'field__label', 'Coursework text ', this.pasteCount), this.pasteText),
            el('div', 'form-actions',
                gameButton('btn', () => this.pasteForm.classList.add('hidden'), 'Cancel'),
                gameButton('btn btn--primary', () => void this.savePaste(), 'Save to Coursework')));

        this.webUrl.type = 'url';
        this.webUrl.maxLength = 2048;
        this.webUrl.placeholder = 'https://www.khanacademy.org/...';
        this.webTitle.maxLength = 120;
        this.webTitle.placeholder = 'Title (optional)';
        this.webTopic.maxLength = 80;
        this.webTopic.placeholder = 'Topic / chapter (optional)';
        this.webSave = gameButton('btn btn--primary', () => void this.saveWebsite(), 'Save to Coursework');
        this.webUrl.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void this.saveWebsite(); } });
        this.webForm = el('section', 'library__paste hidden',
            el('h3', '', 'Add a website'),
            el('p', 'field__hint', 'A public educational page (lesson, reference article, course page, study guide or PDF link). It is read once and saved as study notes with a link to the source. Pages that need a login or are paywalled cannot be added.'),
            el('label', 'field', el('span', 'field__label', 'Website URL'), this.webUrl),
            el('div', 'form-row form-row--even', el('label', 'field', el('span', 'field__label', 'Title'), this.webTitle), el('label', 'field', el('span', 'field__label', 'Topic / chapter'), this.webTopic)),
            el('div', 'form-actions', gameButton('btn', () => this.webForm.classList.add('hidden'), 'Cancel'), this.webSave));

        for (const [value, label] of [['topic', 'Group by topic'], ['chapter', 'Group by chapter'], ['type', 'Group by file type']] as const)
        {
            const option = el('option', '', label);
            option.value = value;
            this.groupSelect.append(option);
        }
        this.groupSelect.setAttribute('aria-label', 'Group coursework');
        this.groupSelect.addEventListener('change', () => this.renderList());

        const zone = el('div', 'dropzone',
            el('span', 'dropzone__text', 'Drop PDF, DOCX, TXT or images (PNG, JPG, WEBP, HEIC), or'),
            gameButton('btn btn--small', () => { this.replacing = null; this.picker.click(); }, 'Upload Files'),
            gameButton('btn btn--small', () => this.openPaste(), 'Paste Text'),
            gameButton('btn btn--small', () => this.openWebsite(), 'Add Website'),
            this.picker);
        acceptDrops(zone, (files) => this.queue(files));

        this.root = el('section', 'library panel hidden',
            el('header', 'library__head', this.heading, gameButton('btn btn--small', () => this.close(), '✕')),
            this.hint, zone, el('div', 'library__tools', this.uploadTopic, this.groupSelect),
            this.uploads.root, this.pasteForm, this.webForm, this.status, this.detail, this.list,
            keyHints([['Esc', 'close']]));
        this.root.setAttribute('role', 'dialog');
        this.root.setAttribute('aria-label', 'Coursework Library');
        parent.append(this.root);
        window.addEventListener('keydown', (event) =>
        {
            if (event.key === 'Escape' && this.isOpen) { event.preventDefault(); event.stopImmediatePropagation(); this.close(); }
        }, true);
    }

    get isOpen ()
    {
        return !this.root.classList.contains('hidden');
    }

    /** `visibility`: 'class' from the NPC editor (teacher material), 'private' from chat / mini-games. */
    open (record: NpcRecord, visibility: DocumentVisibility, onClose?: () => void, startWith?: 'paste')
    {
        this.generation++;
        this.record = record;
        this.remote = null;
        this.visibility = visibility;
        this.onClose = onClose ?? null;
        this.rows = [];
        this.heading.textContent = `Coursework Library · ${record.subject}`;
        this.hint.textContent = visibility === 'class'
            ? `Class material for ${record.name}'s class. Everything here is used for tutoring and mini-games.`
            : `Your coursework for ${record.name}. Your uploads stay private to you and this teacher.`;
        this.detail.classList.add('hidden');
        this.pasteForm.classList.toggle('hidden', startWith !== 'paste');
        this.webForm.classList.add('hidden');
        this.list.replaceChildren(el('p', 'tutor__empty', 'Loading coursework…'));
        this.root.classList.remove('hidden');
        void this.refresh();
    }

    close ()
    {
        if (!this.isOpen) return;
        this.generation++;
        this.root.classList.add('hidden');
        const done = this.onClose;
        this.onClose = null;
        done?.();
    }

    private setStatus (text: string, isError = false)
    {
        this.status.textContent = text;
        this.status.classList.toggle('is-error', isError);
        this.status.classList.toggle('hidden', !text);
    }

    private async ensureRemote ()
    {
        if (!this.remote && this.record) this.remote = await syncNpc(this.record);
        return this.remote!;
    }

    private async refresh ()
    {
        const generation = this.generation;
        try
        {
            const remote = await this.ensureRemote();
            const rows = await listMaterials(remote);
            if (generation !== this.generation) return;
            this.rows = rows;
            this.heading.textContent = `Coursework Library · ${remote.className}`;
            this.renderList();
        }
        catch (err)
        {
            if (generation === this.generation) this.setStatus(errorText(err), true);
        }
    }

    private queue (files: File[])
    {
        const topic = this.uploadTopic.value.trim();
        this.uploads.add(files, this.visibility, () => this.ensureRemote(), { topic: topic || this.replacing?.topic, chapter: this.replacing?.chapter });
    }

    private openPaste ()
    {
        this.pasteForm.classList.remove('hidden');
        this.pasteTitle.focus();
    }

    private openWebsite ()
    {
        this.pasteForm.classList.add('hidden');
        this.webForm.classList.remove('hidden');
        this.webUrl.focus();
    }

    private async saveWebsite ()
    {
        const url = this.webUrl.value.trim();
        if (!/^https:\/\/\S+\.\S+/i.test(url)) return this.setStatus('Paste a full website address starting with https://', true);
        if (this.webSave.disabled) return;
        this.webSave.disabled = true;
        this.setStatus('Reading the website and saving study notes… (this can take up to a minute)');
        const topic = this.webTopic.value.trim();
        try
        {
            const row = await addWebsite(await this.ensureRemote(), url, this.visibility, { title: this.webTitle.value.trim() || undefined, topic });
            this.setStatus(row.status === 'ready' ? `"${row.title}" saved from the website (${row.chunkCount} sections).` : `"${row.title}" could not be processed: ${row.error ?? ''}`, row.status !== 'ready');
            this.webUrl.value = this.webTitle.value = this.webTopic.value = '';
            this.webForm.classList.add('hidden');
            void this.refresh();
        }
        catch (err)
        {
            this.setStatus(errorText(err), true); // nothing was saved; the form keeps the URL
        }
        finally
        {
            this.webSave.disabled = false;
        }
    }

    private async savePaste ()
    {
        const title = this.pasteTitle.value.trim();
        const text = this.pasteText.value.trim();
        if (!title || text.length < 20) return this.setStatus('Add a title and at least a few sentences of coursework.', true);
        this.setStatus('Saving and processing your notes…');
        try
        {
            const row = await pasteCoursework(await this.ensureRemote(), title, text, this.visibility, { topic: this.pasteTopic.value.trim(), chapter: this.pasteChapter.value.trim() });
            this.setStatus(row.status === 'ready' ? `"${row.title}" saved (${row.chunkCount} sections).` : `"${row.title}" saved but processing failed: ${row.error ?? ''}`, row.status !== 'ready');
            this.pasteTitle.value = this.pasteText.value = this.pasteTopic.value = this.pasteChapter.value = '';
            this.pasteForm.classList.add('hidden');
            void this.refresh();
        }
        catch (err)
        {
            this.setStatus(errorText(err), true); // the text stays in the form, nothing is lost
        }
    }

    private renderList ()
    {
        if (!this.rows.length)
        {
            this.list.replaceChildren(el('p', 'tutor__empty', 'No coursework yet. Upload files or paste notes to get started.'));
            return;
        }
        const by = this.groupSelect.value as Grouping;
        const groups = new Map<string, MaterialRow[]>();
        for (const row of this.rows)
        {
            const key = by === 'type' ? typeLabel(row) : (by === 'topic' ? row.topic : row.chapter) || (by === 'topic' ? 'No topic' : 'No chapter');
            (groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
        }
        this.list.replaceChildren(...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, rows]) => el('div', 'library__group',
            el('h4', '', `${name} (${rows.length})`),
            el('ul', 'file-list', ...rows.map((row) => this.renderRow(row))))));
    }

    private renderRow (row: MaterialRow)
    {
        const status = row.status === 'ready' && row.needsReview ? 'Ready · check transcription' : row.status === 'failed' ? `Failed: ${row.error ?? ''}` : STATUS[row.status];
        return el('li', `file-row file-row--${row.status}${row.needsReview ? ' needs-review' : ''}`,
            el('span', 'file-row__name', row.title),
            el('span', 'tag tag--muted', typeLabel(row)),
            row.visibility === 'private' ? el('span', 'tag', 'private') : null,
            el('span', 'file-row__status', status),
            el('span', 'library__actions',
                gameButton('btn btn--small', () => void this.preview(row), 'Preview'),
                row.sourceUrl ? Object.assign(el('a', 'btn btn--small', 'Open site'), { href: row.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }) : null,
                row.mine ? gameButton('btn btn--small', () => this.edit(row), 'Edit') : null,
                row.mine && row.fileType !== 'text' ? gameButton('btn btn--small', () => { this.replacing = row; this.picker.click(); }, 'Replace') : null,
                row.mine ? gameButton('btn btn--small btn--danger', () => void this.remove(row), 'Delete') : null));
    }

    private async preview (row: MaterialRow)
    {
        this.detail.classList.remove('hidden');
        this.detail.replaceChildren(el('p', 'tutor__empty', `Loading "${row.title}"…`));
        try
        {
            const view = await viewDocument(row.id);
            const text = el('textarea', 'library__text');
            text.value = view.text;
            text.rows = 12;
            text.readOnly = !(view.canEdit && view.row.isImage);
            const warn = view.row.needsReview
                ? el('p', 'form-error', `Some parts could not be read with confidence${view.row.uncertain.length ? `: ${view.row.uncertain.join('; ')}` : ''}. Check the text below against the image and correct it.`)
                : null;
            const image = view.row.isImage && view.url ? Object.assign(el('img', 'library__image'), { src: view.url, alt: `Original image: ${view.row.title}` }) : null;
            const parts: (Node | null)[] = [
                el('div', 'library__detail-head', el('strong', '', view.row.title), gameButton('btn btn--small', () => this.detail.classList.add('hidden'), 'Close preview')),
                warn, image,
                el('label', 'field', el('span', 'field__label', view.row.isImage ? 'Extracted content (used for tutoring and questions)' : 'Extracted text'), text),
                !text.readOnly ? el('div', 'form-actions', gameButton('btn btn--primary btn--small', () => void this.saveCorrection(row, text.value), 'Save corrections')) : null,
            ];
            this.detail.replaceChildren(...parts.filter((n): n is Node => n !== null));
        }
        catch (err)
        {
            this.detail.replaceChildren(el('p', 'form-error', errorText(err)));
        }
    }

    private async saveCorrection (row: MaterialRow, text: string)
    {
        try
        {
            await correctDocument(row.id, text);
            this.setStatus(`Corrections saved for "${row.title}".`);
            void this.refresh();
            void this.preview({ ...row, needsReview: false });
        }
        catch (err) { this.setStatus(errorText(err), true); }
    }

    private edit (row: MaterialRow)
    {
        const title = Object.assign(el('input'), { value: row.title, maxLength: 120 });
        const topic = Object.assign(el('input'), { value: row.topic, maxLength: 80, placeholder: 'Topic' });
        const chapter = Object.assign(el('input'), { value: row.chapter, maxLength: 80, placeholder: 'Chapter' });
        this.detail.classList.remove('hidden');
        this.detail.replaceChildren(
            el('strong', '', `Edit "${row.title}"`),
            el('label', 'field', el('span', 'field__label', 'Title'), title),
            el('div', 'form-row form-row--even', el('label', 'field', el('span', 'field__label', 'Topic'), topic), el('label', 'field', el('span', 'field__label', 'Chapter'), chapter)),
            el('div', 'form-actions',
                gameButton('btn btn--small', () => this.detail.classList.add('hidden'), 'Cancel'),
                gameButton('btn btn--primary btn--small', async () =>
                {
                    try
                    {
                        await updateDocument(row.id, { title: title.value.trim(), topic: topic.value.trim(), chapter: chapter.value.trim() });
                        this.detail.classList.add('hidden');
                        void this.refresh();
                    }
                    catch (err) { this.setStatus(errorText(err), true); }
                }, 'Save')));
    }

    private async remove (row: MaterialRow)
    {
        if (!window.confirm(`Delete "${row.title}" from the coursework library?`)) return;
        try { await deleteDocument(row.id); }
        catch (err) { this.setStatus(errorText(err), true); }
        void this.refresh();
    }
}
