// Request body validation for the Edge Functions. Everything from the browser is untrusted:
// ids must be UUIDs, text is length-limited, and identity never comes from the body.

import {
    checkUpload, cleanLabel, documentTitle, IMAGE_FILE_TYPES, MAX_PASTE_CHARS,
    type DocumentVisibility, type UploadFileType,
} from './documentRules.ts';
import { checkWebsiteUrl } from './website.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export const MAX_MESSAGE_CHARS = 2000;
/** Chat image attachments: base64 of at most ~5 MB of image bytes (all images together). */
export const MAX_CHAT_IMAGE_BASE64 = 7_000_000;
/** Per message: images sent inline (used for that message only) and processed file attachments. */
export const MAX_CHAT_IMAGES = 3;
export const MAX_CHAT_ATTACHMENTS = 5;
export const CHAT_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const record = (body: unknown) => (body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null);
// eslint-disable-next-line no-control-regex
const stripControl = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

export interface ChatRequest
{
    npcId: string;
    conversationId: string | null;
    message: string;
    clientMessageId: string | null;
    /** Images used inline for this message only (never stored). */
    images: { mimeType: string; data: string }[];
    /** Coursework documents (already processed) the student attached to this message. */
    attachmentIds: string[];
}

export function parseChatRequest (body: unknown): Parsed<ChatRequest>
{
    const r = record(body);
    if (!r) return { ok: false, error: 'Expected a JSON object.' };
    if (!isUuid(r.npc_id)) return { ok: false, error: 'npc_id must be a UUID.' };
    if (r.conversation_id != null && !isUuid(r.conversation_id)) return { ok: false, error: 'conversation_id must be a UUID or null.' };
    if (r.client_message_id != null && !isUuid(r.client_message_id)) return { ok: false, error: 'client_message_id must be a UUID.' };
    if (typeof r.message !== 'string') return { ok: false, error: 'message must be text.' };
    const message = stripControl(r.message).trim();
    if (!message) return { ok: false, error: 'message is empty.' };
    const ids = r.attachment_ids ?? [];
    if (!Array.isArray(ids) || ids.length > MAX_CHAT_ATTACHMENTS || !ids.every(isUuid)) return { ok: false, error: `attachment_ids must be at most ${MAX_CHAT_ATTACHMENTS} document ids.` };
    if (message.length > MAX_MESSAGE_CHARS) return { ok: false, error: `message is longer than ${MAX_MESSAGE_CHARS} characters.` };

    // `images` (any number up to the cap) or the older single `image` field.
    const rawImages = Array.isArray(r.images) ? r.images : r.image != null ? [r.image] : [];
    if (rawImages.length > MAX_CHAT_IMAGES) return { ok: false, error: `At most ${MAX_CHAT_IMAGES} images per message.` };
    const images: ChatRequest['images'] = [];
    let total = 0;
    for (const raw of rawImages)
    {
        const img = record(raw);
        const mimeType = String(img?.mime_type ?? '').toLowerCase();
        const data = String(img?.data ?? '');
        total += data.length;
        if (!CHAT_IMAGE_MIMES.includes(mimeType)) return { ok: false, error: 'image must be PNG, JPEG, WEBP or HEIC.' };
        if (!data || total > MAX_CHAT_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+=*$/.test(data)) return { ok: false, error: 'Images must be base64 and at most 5 MB together.' };
        images.push({ mimeType, data });
    }
    return {
        ok: true,
        value: {
            npcId: r.npc_id.toLowerCase(),
            conversationId: r.conversation_id ? String(r.conversation_id).toLowerCase() : null,
            message,
            clientMessageId: r.client_message_id ? String(r.client_message_id).toLowerCase() : null,
            images,
            attachmentIds: [...new Set((ids as string[]).map((id) => id.toLowerCase()))],
        },
    };
}

export interface DocumentMeta
{
    topic: string;
    chapter: string;
}

export type DocumentRequest =
    | { action: 'create'; npcId: string; visibility: DocumentVisibility; title: string; fileType: UploadFileType; mime: string; sizeBytes: number } & DocumentMeta
    | { action: 'paste'; npcId: string; visibility: DocumentVisibility; title: string; text: string } & DocumentMeta
    | { action: 'website'; npcId: string; visibility: DocumentVisibility; url: string; host: string; title: string } & DocumentMeta
    | { action: 'update'; documentId: string; title?: string; topic?: string; chapter?: string }
    | { action: 'correct'; documentId: string; text: string }
    | { action: 'process' | 'delete' | 'view'; documentId: string };

export function parseDocumentRequest (body: unknown): Parsed<DocumentRequest>
{
    const r = record(body);
    if (!r) return { ok: false, error: 'Expected a JSON object.' };
    const meta = { topic: cleanLabel(r.topic), chapter: cleanLabel(r.chapter) };
    const visibility = r.visibility;
    switch (r.action)
    {
        case 'create':
        {
            if (!isUuid(r.npc_id)) return { ok: false, error: 'npc_id must be a UUID.' };
            if (visibility !== 'class' && visibility !== 'private') return { ok: false, error: 'visibility must be "class" or "private".' };
            const size = Number(r.size_bytes);
            const check = checkUpload(String(r.file_name ?? ''), String(r.mime_type ?? ''), size);
            if (!check.ok) return check;
            return {
                ok: true,
                value: { action: 'create', npcId: r.npc_id.toLowerCase(), visibility, title: check.title, fileType: check.fileType, mime: check.mime, sizeBytes: size, ...meta },
            };
        }
        case 'paste':
        {
            if (!isUuid(r.npc_id)) return { ok: false, error: 'npc_id must be a UUID.' };
            if (visibility !== 'class' && visibility !== 'private') return { ok: false, error: 'visibility must be "class" or "private".' };
            const title = documentTitle(String(r.title ?? '')).slice(0, 120);
            if (!title) return { ok: false, error: 'Give your notes a title.' };
            const text = typeof r.text === 'string' ? stripControl(r.text).trim() : '';
            if (text.length < 20) return { ok: false, error: 'Paste at least a few sentences of coursework.' };
            if (text.length > MAX_PASTE_CHARS) return { ok: false, error: `Pasted text is longer than ${MAX_PASTE_CHARS.toLocaleString()} characters; split it into parts.` };
            return { ok: true, value: { action: 'paste', npcId: r.npc_id.toLowerCase(), visibility, title, text, ...meta } };
        }
        case 'website':
        {
            if (!isUuid(r.npc_id)) return { ok: false, error: 'npc_id must be a UUID.' };
            if (visibility !== 'class' && visibility !== 'private') return { ok: false, error: 'visibility must be "class" or "private".' };
            const check = checkWebsiteUrl(r.url);
            if (!check.ok) return check;
            const title = typeof r.title === 'string' ? r.title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
            return { ok: true, value: { action: 'website', npcId: r.npc_id.toLowerCase(), visibility, url: check.url, host: check.host, title, ...meta } };
        }
        case 'update':
        {
            if (!isUuid(r.document_id)) return { ok: false, error: 'document_id must be a UUID.' };
            const value: Extract<DocumentRequest, { action: 'update' }> = { action: 'update', documentId: r.document_id.toLowerCase() };
            if (r.title !== undefined)
            {
                const title = documentTitle(String(r.title)).slice(0, 120);
                if (!title) return { ok: false, error: 'The title cannot be empty.' };
                value.title = title;
            }
            if (r.topic !== undefined) value.topic = meta.topic;
            if (r.chapter !== undefined) value.chapter = meta.chapter;
            return { ok: true, value };
        }
        case 'correct':
        {
            if (!isUuid(r.document_id)) return { ok: false, error: 'document_id must be a UUID.' };
            const text = typeof r.text === 'string' ? stripControl(r.text).trim() : '';
            if (!text) return { ok: false, error: 'The corrected text is empty.' };
            if (text.length > MAX_PASTE_CHARS) return { ok: false, error: 'The corrected text is too long.' };
            return { ok: true, value: { action: 'correct', documentId: r.document_id.toLowerCase(), text } };
        }
        case 'process':
        case 'delete':
        case 'view':
            if (!isUuid(r.document_id)) return { ok: false, error: 'document_id must be a UUID.' };
            return { ok: true, value: { action: r.action, documentId: r.document_id.toLowerCase() } };
        default:
            return { ok: false, error: 'Unknown action.' };
    }
}

export const isImageDocument = (fileType: string) => (IMAGE_FILE_TYPES as string[]).includes(fileType);

export type DashGame = 'answer_dash' | 'spellshot';

export type DashRequest =
    | { action: 'start'; npcId: string; source: 'all' | { documentIds: string[] }; game: DashGame; choices: number }
    | { action: 'answer'; sessionId: string; index: number; choice: number }
    | { action: 'finish'; sessionId: string };

/** Visible answer targets a Spellshot round may use (Answer Dash always has 4 gates). */
export const SPELLSHOT_CHOICES = { min: 3, max: 5, default: 4 } as const;

/**
 * answer-dash requests (Answer Dash and Spellshot). Questions come ONLY from class materials
 * (no general practice). Ranges here are coarse; the stored pack bounds index and choice.
 */
export function parseDashRequest (body: unknown): Parsed<DashRequest>
{
    const r = record(body);
    if (!r) return { ok: false, error: 'Expected a JSON object.' };
    const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
    switch (r.action)
    {
        case 'start':
        {
            if (!isUuid(r.npc_id)) return { ok: false, error: 'npc_id must be a UUID.' };
            const npcId = r.npc_id.toLowerCase();
            const game = r.game ?? 'answer_dash';
            if (game !== 'answer_dash' && game !== 'spellshot') return { ok: false, error: 'game must be "answer_dash" or "spellshot".' };
            let choices = 4;
            if (game === 'spellshot')
            {
                choices = (r.choices ?? SPELLSHOT_CHOICES.default) as number;
                if (!int(choices, SPELLSHOT_CHOICES.min, SPELLSHOT_CHOICES.max)) return { ok: false, error: `choices must be ${SPELLSHOT_CHOICES.min}-${SPELLSHOT_CHOICES.max}.` };
            }
            else if (r.choices !== undefined && r.choices !== 4) return { ok: false, error: 'Answer Dash always uses 4 choices.' };
            if (r.source === 'all') return { ok: true, value: { action: 'start', npcId, source: 'all', game, choices } };
            const ids = Array.isArray(r.source) ? r.source : isUuid(r.source) ? [r.source] : null;
            if (!ids || !ids.length || ids.length > 30 || !ids.every(isUuid)) return { ok: false, error: 'source must be "all" or 1-30 document ids from the coursework library.' };
            return { ok: true, value: { action: 'start', npcId, source: { documentIds: [...new Set(ids.map((id) => id.toLowerCase()))] }, game, choices } };
        }
        case 'answer':
            if (!isUuid(r.session_id)) return { ok: false, error: 'session_id must be a UUID.' };
            if (!int(r.index, 0, 29) || !int(r.choice, 0, SPELLSHOT_CHOICES.max - 1)) return { ok: false, error: `index must be 0-29 and choice 0-${SPELLSHOT_CHOICES.max - 1}.` };
            return { ok: true, value: { action: 'answer', sessionId: r.session_id.toLowerCase(), index: r.index as number, choice: r.choice as number } };
        case 'finish':
            if (!isUuid(r.session_id)) return { ok: false, error: 'session_id must be a UUID.' };
            return { ok: true, value: { action: 'finish', sessionId: r.session_id.toLowerCase() } };
        default:
            return { ok: false, error: 'action must be "start", "answer" or "finish".' };
    }
}
