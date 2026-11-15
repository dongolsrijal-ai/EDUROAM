// AI tutoring panel for one NPC: the conversation first, with one "+" attachment flow in the
// composer; history, preferences and materials are quiet tabs. Opened from the NPC's dialogue
// ("Chat & Study"). Replies come from the npc-chat Edge Function (Gemini, server-side);
// history and memory live in Supabase.
//
// Attachments belong to the message they are sent with: images go inline (that message only),
// documents are stored PRIVATELY for this student + NPC, processed, and then sent as the
// message's attachment ids. Nothing a student attaches here is ever shared with the class.

import type { NpcRecord } from '../data/npcStore';
import { currentUserEmail, getSession, onSessionChange, signOut } from '../services/backend';
import {
    addWebsite, deleteDocument, forgetTeachingPreference, listConversations, listMaterials, loadLearningState, loadMessages,
    loadTeachingPreferences, sendChat, syncNpc, TutorApiError, uploadDocument, type ChatMessage, type RemoteNpc, type SourceRef, type WebPageRef,
} from '../services/tutorApi';
import { wantsWebSearch } from '../../../supabase/functions/_shared/tutorRouting';
import { findUrls } from '../../../supabase/functions/_shared/website';
import { el, gameButton, keyHints, type Modal } from './dom';
import { SignInBox } from './SignInBox';
import type { CourseworkLibrary } from './CourseworkLibrary';
import { checkUpload } from '../../../supabase/functions/_shared/documentRules';
import { acceptDrops, AttachmentTray, iconButton, type Attachment } from './uploads';

/** Images up to this size travel with the message; larger ones are uploaded and read first. */
const INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

type View = 'chat' | 'materials' | 'history' | 'preferences' | 'signin' | 'loading';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');
const newId = () => crypto.randomUUID();
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export class TutorPanel implements Modal
{
    private root: HTMLElement;
    private portrait = el('img', 'portrait');
    private nameEl = el('span', 'dialogue__name');
    /** One quiet line: the subject, plus the class name only when it differs. */
    private subtitle = el('span', 'tutor__subtitle');
    private account = el('div', 'tutor__account hidden');
    private status = el('div', 'tutor__status');
    private log = el('div', 'tutor__log');
    private materials = el('div', 'tutor__pane');
    private history = el('div', 'tutor__pane');
    private preferences = el('div', 'tutor__pane');
    private signin = new SignInBox('Sign in to chat with your teacher. Conversations and progress are saved to your account.');
    private loading = el('div', 'tutor__pane tutor__loading', 'Connecting…');
    private input = el('textarea', 'tutor__input');
    private sendButton: HTMLButtonElement;
    private tabButtons: Record<'chat' | 'history' | 'preferences' | 'materials', HTMLButtonElement>;
    /** Set by the Ui once the shared Coursework Library exists. */
    library: CourseworkLibrary | null = null;
    private tray: AttachmentTray;
    /** client_message_id of the current draft: reused by a retry so nothing is saved twice. */
    private draft: { id: string; signature: string } | null = null;
    /** Object URLs of images shown in sent bubbles (revoked when the log is cleared). */
    private bubbleUrls: string[] = [];

    private record: NpcRecord | null = null;
    private remote: RemoteNpc | null = null;
    private conversationId: string | null = null;
    private pending = false;
    private view: View = 'loading';
    /** Increments on every open so late async results for a previous NPC are ignored. */
    private generation = 0;
    /** Increments on every connect so an older connect (e.g. before sign-in) can't overwrite a newer one. */
    private connectSeq = 0;
    private onClose: (() => void) | null = null;

    constructor (parent: HTMLElement)
    {
        this.portrait.alt = '';
        this.input.rows = 2;
        this.input.maxLength = 2000;
        this.input.placeholder = 'Ask a question, e.g. "Quiz me on Chapter 3"';
        this.input.setAttribute('aria-label', 'Message');
        this.input.addEventListener('keydown', (event) =>
        {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.submit(); }
        });
        this.sendButton = gameButton('btn btn--primary tutor__send', () => this.submit(), 'Send');

        this.tabButtons = {
            chat: gameButton('tutor-tab', () => this.show('chat'), 'Chat'),
            history: gameButton('tutor-tab', () => void this.openHistory(), 'History'),
            preferences: gameButton('tutor-tab', () => void this.openPreferences(), 'Preferences'),
            materials: gameButton('tutor-tab', () => this.openLibrary(), 'Materials'),
        };
        this.tabButtons.preferences.title = 'How this teacher has been asked to teach you';
        this.tabButtons.materials.title = 'Your coursework library for this teacher';

        this.tray = new AttachmentTray({
            max: 5, inlineImageBytes: INLINE_IMAGE_BYTES,
            note: (items) => attachmentNote(items, this.tray, this.record?.name ?? 'this teacher'),
            onChange: () => this.syncComposer(),
        });
        this.log.setAttribute('aria-live', 'polite');
        this.log.setAttribute('role', 'log');
        // Paste screenshots (or copied files) straight into the message box.
        this.input.addEventListener('paste', (event) =>
        {
            const files = [...(event.clipboardData?.files ?? [])];
            if (files.length && this.remote && !this.pending) { event.preventDefault(); this.tray.add(files); }
        });
        const close = iconButton('tutor__close', 'close', 'Close chat (Esc)', () => this.close());
        const composer = el('div', 'tutor__composer', this.tray.button, this.input, this.sendButton);
        this.root = el('section', 'tutor panel hidden',
            el('header', 'tutor__head',
                this.portrait,
                el('div', 'tutor__title', this.nameEl, this.subtitle),
                close),
            el('nav', 'tutor__tabs', this.tabButtons.chat, this.tabButtons.history, this.tabButtons.preferences, this.tabButtons.materials),
            el('div', 'tutor__body', this.log, this.materials, this.history, this.preferences, this.signin.root, this.loading),
            this.status,
            this.tray.root,
            composer,
            el('footer', 'tutor__foot', keyHints([['Enter', 'send'], ['Shift+Enter', 'new line'], ['Esc', 'close']]), this.account));
        this.root.setAttribute('role', 'dialog');
        this.root.setAttribute('aria-label', 'Chat with teacher');
        acceptDrops(this.root, (files) => { if (this.remote && !this.pending) { this.show('chat'); this.tray.add(files); } });
        parent.append(this.root);

        window.addEventListener('keydown', (event) =>
        {
            if (event.key === 'Escape' && this.record) { event.preventDefault(); this.close(); }
        });
        // React to the account changing while the panel is open (code verified, other tab,
        // sign-out, switching accounts). Token refreshes keep the same user and are ignored.
        onSessionChange((session) =>
        {
            if (!this.record) return;
            if (session && this.remote?.ownerId === session.user.id) return;
            if (!session)
            {
                this.remote = null;
                this.conversationId = null;
                this.connectSeq++;
                this.log.replaceChildren();
                this.renderAccount();
                this.show('signin');
                this.setStatus('You are signed out. Sign in to keep studying.');
                return;
            }
            this.remote = null;
            void this.connect();
        });
    }

    get isOpen ()
    {
        return this.record !== null;
    }

    open (record: NpcRecord, portrait: string, onClose: () => void)
    {
        this.generation++;
        this.record = record;
        this.remote = null;
        this.conversationId = null;
        this.pending = false;
        this.onClose = onClose;
        this.portrait.src = portrait;
        this.nameEl.textContent = record.name;
        this.subtitle.textContent = record.subject;
        // A different teacher never inherits the previous draft or attachments.
        this.tray.clear();
        this.draft = null;
        this.input.value = '';
        this.clearLog();
        this.setStatus('');
        this.root.classList.remove('hidden');
        void this.connect();
    }

    handleKey (key: string)
    {
        if (key === 'escape') this.close();
    }

    close ()
    {
        if (!this.record) return;
        this.generation++;
        this.record = null;
        this.root.classList.add('hidden');
        const done = this.onClose;
        this.onClose = null;
        done?.();
    }

    // ------------------------------------------------------------ connect + views

    private async connect ()
    {
        const generation = this.generation;
        const seq = ++this.connectSeq;
        const stale = () => generation !== this.generation || seq !== this.connectSeq;
        const record = this.record;
        if (!record) return;
        this.show('loading');
        this.setStatus('');
        try
        {
            if (!(await getSession()))
            {
                if (stale()) return;
                this.renderAccount();
                this.show('signin');
                this.signin.focus();
                return;
            }
            // Creates/updates this account's class + NPC rows (owner = the Supabase Auth user).
            const remote = await syncNpc(record);
            const [state, conversations] = await Promise.all([loadLearningState(remote), listConversations(remote)]);
            const latest = conversations.find((c) => c.channel === 'game');
            const messages = latest ? await loadMessages(latest.id) : [];
            if (stale()) return;

            this.remote = remote;
            this.subtitle.textContent = remote.className.toLowerCase() === record.subject.toLowerCase() ? record.subject : `${record.subject} · ${remote.className}`;
            this.conversationId = latest?.id ?? null;
            this.clearLog();
            if (messages.length) messages.forEach((m) => this.addMessage(m));
            else this.addMessage({ role: 'npc', content: this.greeting(record, state.currentTopic), sources: [], createdAt: '' });
            this.renderAccount();
            this.show('chat');
            this.input.focus();
        }
        catch (err)
        {
            if (stale()) return;
            if (err instanceof TutorApiError && err.code === 'unauthenticated')
            {
                // No valid account session: nothing is created until the player signs in.
                this.show('signin');
                this.setStatus(err.message, true);
                return;
            }
            this.show('chat');
            this.setStatus(errorText(err), true, () => void this.connect());
        }
    }

    private renderAccount ()
    {
        const email = currentUserEmail();
        this.account.replaceChildren(...(email ? [
            el('span', '', email === 'guest' ? 'Signed in as guest' : `Signed in as ${email}`),
            gameButton('btn btn--small btn--link', () => void signOut(), 'Sign out'),
        ] : []));
        this.account.classList.toggle('hidden', !email);
    }

    /** Local opener (no AI call). Never pushes the student back to an old topic. */
    private greeting (record: NpcRecord, topic: string)
    {
        return topic
            ? 'Welcome back! What would you like to work on today?'
            : `Hi, I'm ${record.name}. Ask me anything, or tap + to share notes, a worksheet or a photo.`;
    }

    private show (view: View)
    {
        this.view = view;
        this.log.classList.toggle('hidden', view !== 'chat');
        this.materials.classList.toggle('hidden', view !== 'materials');
        this.history.classList.toggle('hidden', view !== 'history');
        this.preferences.classList.toggle('hidden', view !== 'preferences');
        this.signin.root.classList.toggle('hidden', view !== 'signin');
        this.loading.classList.toggle('hidden', view !== 'loading');
        const ready = Boolean(this.remote);
        for (const [name, button] of Object.entries(this.tabButtons))
        {
            button.classList.toggle('is-active', name === view);
            button.disabled = !ready;
        }
        this.input.disabled = !ready || view !== 'chat' || this.pending;
        this.syncComposer();
        if (view === 'chat') this.scrollLog();
    }

    private syncComposer ()
    {
        const disabled = !this.remote || this.view !== 'chat' || this.pending;
        this.sendButton.disabled = disabled;
        this.tray.button.disabled = disabled;
    }

    private clearLog ()
    {
        for (const url of this.bubbleUrls) URL.revokeObjectURL(url);
        this.bubbleUrls = [];
        this.log.replaceChildren();
    }

    private setStatus (text: string, isError = false, retry?: () => void)
    {
        this.status.replaceChildren(text, ...(retry ? [gameButton('btn btn--small', retry, 'Retry')] : []));
        this.status.classList.toggle('is-error', isError);
        this.status.classList.toggle('hidden', !text);
    }

    // ------------------------------------------------------------ chat

    private submit ()
    {
        if (this.pending || !this.remote) return;
        const typed = this.input.value.trim();
        const items = this.tray.all;
        if (!typed && !items.length) return;
        // Attachment-only: a sensible default request about the files.
        const text = typed || (items.length === 1 ? 'Please look at this and explain it.' : 'Please look at these and explain them.');
        // Same draft (text + attachments) => same message id, so a retry is never saved twice.
        const signature = `${typed}\u0000${items.map((a) => a.id).join(',')}`;
        if (this.draft?.signature !== signature) this.draft = { id: newId(), signature };
        void this.send(text, typed, this.draft.id);
    }

    private openLibrary ()
    {
        if (!this.record || !this.library) return void this.openMaterials();
        if (this.pending) return;
        const record = this.record;
        this.root.classList.add('hidden');
        this.library.open(record, 'private', () =>
        {
            if (this.record !== record) return;
            this.root.classList.remove('hidden');
            this.input.focus();
        });
    }

    private static async toBase64 (file: File)
    {
        const url = await new Promise<string>((resolve, reject) =>
        {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error('Could not read the image.'));
            reader.readAsDataURL(file);
        });
        return url.slice(url.indexOf(',') + 1);
    }

    /**
     * Sends one message with its attachments. Documents (and large images) are uploaded
     * privately and processed FIRST; the message is sent only once their content is ready.
     * On failure the draft text and attachments stay in the composer (already processed files
     * are not uploaded again) and the optimistic bubble is removed.
     */
    private async send (text: string, typed: string, clientMessageId: string)
    {
        const remote = this.remote;
        if (!remote) return;
        const generation = this.generation;
        const stale = () => generation !== this.generation;
        const items = [...this.tray.all];
        this.input.value = '';
        const bubble = this.addMessage({ role: 'player', content: typed || text, sources: [], createdAt: new Date().toISOString() });
        if (items.length) bubble.prepend(this.attachmentPreview(items));
        const reading = findUrls(text).length > 0;
        const researching = reading || wantsWebSearch(text);
        const uploading = items.some((a) => !this.tray.isInline(a) && !a.documentId);
        const thinking = el('div', 'msg msg--npc msg--thinking',
            `${this.record?.name ?? 'Teacher'} is ${uploading ? 'reading your files' : reading ? 'reading the link' : researching ? 'researching online' : 'thinking'}…`);
        this.log.append(thinking);
        this.scrollLog();
        this.pending = true;
        this.tray.setLocked(true);
        this.show('chat');
        this.setStatus('');
        try
        {
            for (const a of items)
            {
                if (this.tray.isInline(a) || a.documentId) continue;
                this.tray.update(a.id, { state: 'uploading', progress: 0, error: '' });
                const row = await uploadDocument(remote, a.file, 'private', (phase, progress) => { if (!stale()) this.tray.update(a.id, { state: phase, progress }); });
                if (stale()) return;
                if (row.status !== 'ready')
                {
                    // Don't leave a broken copy in the library; the file stays here to fix or remove.
                    void deleteDocument(row.id).catch(() => undefined);
                    this.tray.update(a.id, { state: 'failed', error: row.error ?? 'could not be read' });
                    throw new TutorApiError('attachment_failed', `"${a.file.name}" could not be read (${row.error ?? 'unreadable'}). Remove it or try a different file.`, false);
                }
                this.tray.update(a.id, { state: 'ready', documentId: row.id });
            }
            const images = await Promise.all(items.filter((a) => this.tray.isInline(a)).map(async (a) =>
            {
                // HEIC files often report an empty type: the extension decides (same rule as uploads).
                const checked = checkUpload(a.file.name, a.file.type, a.file.size);
                return { mimeType: checked.ok ? checked.mime : 'image/png', data: await TutorPanel.toBase64(a.file) };
            }));
            const attachmentIds = items.map((a) => a.documentId).filter((id): id is string => Boolean(id));
            const reply = await sendChat(remote, this.conversationId, text, clientMessageId, { images, attachmentIds });
            if (stale()) return;
            this.conversationId = reply.conversationId;
            thinking.remove();
            this.tray.clear();
            this.draft = null;
            this.addMessage({
                role: 'npc', content: reply.reply, sources: reply.sources, webSources: reply.webSources, knowledge: reply.knowledge,
                pageSources: reply.pages.filter((p) => p.status === 'read').map((p) => ({ kind: 'page', url: p.url, title: p.title })),
                failedPages: reply.pages.filter((p) => p.status === 'failed'),
                webSearch: reply.webSearch, searchSuggestions: reply.searchSuggestions, createdAt: new Date().toISOString(),
            });
            if (reply.preference.saved) this.addSystemLine(`Saved to your preferences: "${reply.preference.saved}".`);
        }
        catch (err)
        {
            if (stale()) return;
            thinking.remove();
            bubble.remove();
            if (err instanceof TutorApiError && err.code === 'duplicate_message')
            {
                // The server already saved this exact message (e.g. the reply was lost): show it.
                this.tray.clear();
                this.draft = null;
                void this.connect();
                return;
            }
            this.input.value = typed;
            const retryable = !(err instanceof TutorApiError) || err.retryable;
            this.setStatus(`Not sent: ${errorText(err)}`, true, retryable ? () => this.submit() : undefined);
        }
        finally
        {
            if (!stale())
            {
                this.pending = false;
                this.tray.setLocked(false);
                this.show(this.view);
                this.input.focus();
            }
        }
    }

    /** Thumbnails / file names shown on the sent message. */
    private attachmentPreview (items: readonly Attachment[])
    {
        return el('div', 'msg__files', ...items.map((a) =>
        {
            if (!a.previewUrl) return el('span', 'msg__file', a.file.name);
            const url = URL.createObjectURL(a.file);
            this.bubbleUrls.push(url);
            return Object.assign(el('img', 'msg__image'), { src: url, alt: a.file.name });
        }));
    }

    private addMessage (message: ChatMessage)
    {
        const bubble = el('div', `msg msg--${message.role}`, message.content);
        if (message.role === 'npc' && message.createdAt) bubble.append(...replyFooter(message, (page) => this.savePage(page)));
        this.log.append(bubble);
        this.scrollLog();
        return bubble;
    }

    /** Saves a page the teacher read to the student's coursework, only when they ask. */
    private async savePage (page: WebPageRef)
    {
        const remote = this.remote;
        if (!remote) return;
        this.addSystemLine(`Saving "${page.title}" to your Coursework Library…`);
        try
        {
            const row = await addWebsite(remote, page.url, 'private', { title: page.title });
            this.addSystemLine(row.status === 'ready' ? `"${row.title}" saved to your Coursework Library.` : `"${row.title}" could not be processed: ${row.error ?? ''}`);
        }
        catch (err)
        {
            this.setStatus(`Not saved: ${errorText(err)}`, true);
        }
    }

    private addSystemLine (text: string)
    {
        this.addMessage({ role: 'system', content: text, sources: [], createdAt: '' });
    }

    private scrollLog ()
    {
        this.log.scrollTop = this.log.scrollHeight;
    }

    // ------------------------------------------------------------ uploads + materials

    private async openMaterials ()
    {
        const remote = this.remote;
        if (!remote) return;
        const generation = this.generation;
        this.show('materials');
        this.materials.replaceChildren(el('p', 'tutor__empty', 'Loading class materials…'));
        try
        {
            const rows = await listMaterials(remote);
            if (generation !== this.generation) return;
            const list = rows.map((row) =>
            {
                const status = row.status === 'ready' ? `Ready · ${row.chunkCount} sections` : row.status === 'failed' ? `Failed: ${row.error ?? 'unreadable'}` : 'Processing…';
                return el('li', `file-row file-row--${row.status}`,
                    el('span', 'file-row__name', row.title),
                    el('span', 'tag', row.visibility === 'private' ? 'Your upload (private)' : 'Class material'),
                    el('span', 'file-row__status', status),
                    row.mine ? gameButton('btn btn--small btn--danger', () => void this.removeDocument(row.id, row.title), 'Remove') : null);
            });
            this.materials.replaceChildren(
                el('div', 'tutor__pane-head', el('strong', '', `${remote.className} materials`),
                    gameButton('btn btn--small', () => { this.show('chat'); this.tray.button.click(); }, 'Attach files')),
                list.length ? el('ul', 'file-list', ...list) : el('p', 'tutor__empty', 'No materials yet. Upload notes, homework or a worksheet (PDF, TXT, DOCX).'),
                el('p', 'field__hint', 'Your uploads stay private to you and this teacher. Teachers add shared class material in the NPC editor.'));
        }
        catch (err)
        {
            if (generation === this.generation) this.materials.replaceChildren(el('p', 'form-error', errorText(err)));
        }
    }

    private async removeDocument (id: string, title: string)
    {
        if (!window.confirm(`Remove "${title}"? ${this.record?.name ?? 'The teacher'} will no longer use it.`)) return;
        try
        {
            await deleteDocument(id);
        }
        catch (err)
        {
            this.setStatus(errorText(err), true);
        }
        void this.openMaterials();
    }

    // ------------------------------------------------------------ teaching preferences

    private async openPreferences ()
    {
        const remote = this.remote;
        const record = this.record;
        if (!remote || !record) return;
        const generation = this.generation;
        this.show('preferences');
        this.preferences.replaceChildren(el('p', 'tutor__empty', 'Loading your preferences…'));
        try
        {
            const { saved, pending } = await loadTeachingPreferences(remote);
            if (generation !== this.generation) return;
            const forget = async (preference: string | null) =>
            {
                if (preference === null && !window.confirm(`Reset all of ${record.name}'s saved teaching preferences for you?`)) return;
                try { await forgetTeachingPreference(remote, preference); }
                catch (err) { this.setStatus(errorText(err), true); }
                if (generation === this.generation) void this.openPreferences();
            };
            this.preferences.replaceChildren(
                el('div', 'tutor__pane-head', el('strong', '', `How ${record.name} teaches you`),
                    saved.length ? gameButton('btn btn--small btn--danger', () => void forget(null), 'Reset all') : null),
                saved.length
                    ? el('ul', 'file-list', ...saved.map((p) => el('li', 'file-row',
                        el('span', 'file-row__name', p), gameButton('btn btn--small', () => void forget(p), 'Forget'))))
                    : el('p', 'tutor__empty', 'No saved preferences yet.'),
                ...(pending ? [el('p', 'field__hint', `Waiting for your answer in chat: should ${record.name} remember "${pending}"?`)] : []),
                el('p', 'field__hint', `Just ask in chat, e.g. "Please use simpler examples" or "Quiz me after each explanation". ${record.name} adapts right away and asks before remembering anything for future lessons. Preferences are private to you and this teacher.`));
        }
        catch (err)
        {
            if (generation === this.generation) this.preferences.replaceChildren(el('p', 'form-error', errorText(err)));
        }
    }

    // ------------------------------------------------------------ history

    private async openHistory ()
    {
        const remote = this.remote;
        if (!remote) return;
        const generation = this.generation;
        this.show('history');
        this.history.replaceChildren(el('p', 'tutor__empty', 'Loading conversations…'));
        try
        {
            const conversations = await listConversations(remote);
            if (generation !== this.generation) return;
            const rows = conversations.map((c) => el('li', `file-row${c.id === this.conversationId ? ' is-current' : ''}`,
                el('span', 'file-row__name', c.preview || '(empty)'),
                el('span', 'file-row__meta', `${when(c.updatedAt)}${c.channel !== 'game' ? ` · ${c.channel}` : ''}`),
                c.channel === 'game' ? gameButton('btn btn--small', () => void this.continueConversation(c.id), c.id === this.conversationId ? 'Current' : 'Continue') : null));
            this.history.replaceChildren(
                el('div', 'tutor__pane-head', el('strong', '', 'Conversation history'),
                    gameButton('btn btn--small', () => this.startNewConversation(), 'New conversation')),
                rows.length ? el('ul', 'file-list', ...rows) : el('p', 'tutor__empty', 'No conversations yet.'));
        }
        catch (err)
        {
            if (generation === this.generation) this.history.replaceChildren(el('p', 'form-error', errorText(err)));
        }
    }

    private async continueConversation (id: string)
    {
        const generation = this.generation;
        try
        {
            const messages = await loadMessages(id);
            if (generation !== this.generation) return;
            this.conversationId = id;
            this.log.replaceChildren();
            messages.forEach((m) => this.addMessage(m));
            this.show('chat');
        }
        catch (err)
        {
            this.setStatus(errorText(err), true);
        }
    }

    private startNewConversation ()
    {
        if (!this.record) return;
        this.conversationId = null;
        this.log.replaceChildren();
        this.addMessage({ role: 'npc', content: `New page! What would you like to study in ${this.record.subject}?`, sources: [], createdAt: '' });
        this.show('chat');
        this.input.focus();
    }
}

/**
 * Under a teacher reply: which knowledge it used, coursework references, website citations
 * (links from Google Search grounding only) and, for grounded answers, Google's Search
 * Suggestions in a sandboxed frame (required display; no scripts, links open a new tab).
 */
function replyFooter (message: ChatMessage, savePage: (page: WebPageRef) => void): HTMLElement[]
{
    const web = message.webSources ?? [];
    const pages = message.pageSources ?? [];
    // Saved history has no model flag: labels there come only from stored evidence.
    const attached = message.sources.filter((s) => s.attached);
    const coursework = message.sources.filter((s) => !s.attached);
    const knowledge = message.knowledge ?? { attachment: attached.length > 0, coursework: coursework.length > 0, webPage: pages.length > 0, search: web.length > 0, general: false };
    const parts: HTMLElement[] = [];
    const labels: [string, string][] = [];
    if (knowledge.attachment) labels.push(['Your files', 'attach']);
    if (knowledge.coursework) labels.push(['Class Materials', 'class']);
    if (knowledge.webPage) labels.push(['Web Source', 'page']);
    if (knowledge.search) labels.push(['Google Search', 'web']);
    if (knowledge.general) labels.push(['General Knowledge', 'general']);
    if (labels.length) parts.push(el('div', 'msg__basis', ...labels.map(([text, kind]) => el('span', `tag tag--basis tag--${kind}`, text))));
    if (attached.length) parts.push(el('div', 'msg__sources', 'Used: ', ...attached.map((s) => el('span', 'tag tag--source', s.title))));
    if (coursework.length)
    {
        parts.push(el('div', 'msg__sources', 'From your coursework: ', ...coursework.map((s) => el('span', 'tag tag--source', sourceLabel(s)))));
    }
    const link = (url: string, text: string) => Object.assign(el('a', '', text), { href: url, target: '_blank', rel: 'noopener noreferrer' });
    if (pages.length)
    {
        parts.push(el('div', 'msg__web', el('strong', '', 'Web Source'), el('ul', 'msg__links', ...pages.map((p) => el('li', '',
            link(p.url, p.title), ' ', gameButton('btn btn--small btn--link', () => savePage(p), 'Save to Coursework'))))));
    }
    for (const failed of message.failedPages ?? [])
    {
        parts.push(el('div', 'msg__note', `Couldn't read ${failed.title}${failed.reason ? `: ${failed.reason}` : ''}`));
    }
    if (web.length)
    {
        parts.push(el('div', 'msg__web', el('strong', '', 'Google Search sources'), el('ol', 'msg__links', ...web.map((s) => el('li', '', link(s.url, s.title))))));
    }
    if (message.webSearch === 'failed') parts.push(el('div', 'msg__note', 'Could not verify current information online, so this answer may be out of date.'));
    if (message.webSearch === 'unavailable') parts.push(el('div', 'msg__note', 'Online research limit reached for today; answered without checking the web.'));
    if (message.searchSuggestions)
    {
        const frame = el('iframe', 'msg__suggestions');
        frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
        frame.title = 'Google Search suggestions';
        frame.srcdoc = `<!doctype html><base target="_blank"><body style="margin:0">${message.searchSuggestions}</body>`;
        parts.push(frame);
    }
    return parts;
}

function sourceLabel (source: SourceRef)
{
    if (!source.page_start) return source.title;
    const pages = source.page_end && source.page_end !== source.page_start ? `pp. ${source.page_start}-${source.page_end}` : `p. ${source.page_start}`;
    return `${source.title} (${pages})`;
}

/** Where the pending attachments go: said once, plainly, under the chips. */
function attachmentNote (items: readonly Attachment[], tray: AttachmentTray, teacher: string)
{
    const stored = items.some((a) => !tray.isInline(a));
    const inline = items.some((a) => tray.isInline(a));
    return [
        inline ? 'Images are used for this message only.' : '',
        stored ? `Files are saved privately to your coursework (only you and ${teacher}).` : '',
    ].filter(Boolean).join(' ');
}
