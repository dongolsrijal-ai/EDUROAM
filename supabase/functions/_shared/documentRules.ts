// Upload rules shared by the game client (early feedback) and the Edge Functions (enforced).
// Pure TypeScript: no Deno or browser APIs, so Vite, Deno and node --test can all import it.

/** 'text' = coursework pasted into the library (stored as a UTF-8 .txt original). */
export type DocumentFileType = 'pdf' | 'txt' | 'docx' | 'png' | 'jpeg' | 'webp' | 'heic' | 'text';
export type UploadFileType = Exclude<DocumentFileType, 'text'>;
export type DocumentVisibility = 'class' | 'private';
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_NPC = 80;
export const MAX_PASTE_CHARS = 200_000;

export const DOCUMENT_TYPES: Record<UploadFileType, { mimes: string[]; extensions: string[]; label: string; image: boolean }> = {
    pdf: { mimes: ['application/pdf'], extensions: ['.pdf'], label: 'PDF', image: false },
    txt: { mimes: ['text/plain'], extensions: ['.txt'], label: 'TXT', image: false },
    docx: { mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], extensions: ['.docx'], label: 'DOCX', image: false },
    png: { mimes: ['image/png'], extensions: ['.png'], label: 'PNG', image: true },
    jpeg: { mimes: ['image/jpeg'], extensions: ['.jpg', '.jpeg'], label: 'JPEG', image: true },
    webp: { mimes: ['image/webp'], extensions: ['.webp'], label: 'WEBP', image: true },
    heic: { mimes: ['image/heic', 'image/heif'], extensions: ['.heic', '.heif'], label: 'HEIC', image: true },
};

export const IMAGE_FILE_TYPES: DocumentFileType[] = ['png', 'jpeg', 'webp', 'heic'];
export const isImageType = (type: string) => (IMAGE_FILE_TYPES as string[]).includes(type);

export const ACCEPT_ATTRIBUTE = Object.values(DOCUMENT_TYPES).flatMap((t) => [...t.extensions, ...t.mimes]).join(',');

/** Browsers report an empty or generic type for some files; the extension decides then. */
const GENERIC_MIME = new Set(['', 'application/octet-stream']);

export type UploadCheck =
    | { ok: true; fileType: UploadFileType; mime: string; title: string }
    | { ok: false; error: string };

export function checkUpload (fileName: string, mime: string, sizeBytes: number): UploadCheck
{
    const title = documentTitle(fileName);
    if (!title) return { ok: false, error: 'The file needs a name.' };
    const lower = title.toLowerCase();
    const entry = (Object.entries(DOCUMENT_TYPES) as [UploadFileType, typeof DOCUMENT_TYPES.pdf][])
        .find(([, type]) => type.extensions.some((ext) => lower.endsWith(ext)));
    if (!entry) return { ok: false, error: `"${title}" is not a supported file (PDF, DOCX, TXT, PNG, JPG, WEBP or HEIC).` };
    const [fileType, type] = entry;
    const reported = (mime || '').split(';')[0].trim().toLowerCase();
    if (!GENERIC_MIME.has(reported) && !type.mimes.includes(reported))
    {
        return { ok: false, error: `"${title}" looks like ${reported}, not a ${type.label} file.` };
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return { ok: false, error: `"${title}" is empty.` };
    if (sizeBytes > MAX_DOCUMENT_BYTES)
    {
        return { ok: false, error: `"${title}" is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.` };
    }
    return { ok: true, fileType, mime: GENERIC_MIME.has(reported) ? type.mimes[0] : reported, title };
}

/** Display title: the bare file name, without folders or control characters, max 120 chars. */
export function documentTitle (fileName: string): string
{
    const base = String(fileName ?? '').split(/[\\/]/).pop() ?? '';
    // eslint-disable-next-line no-control-regex
    return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(-120);
}

/** Object name inside the bucket: ASCII-safe, keeps the extension. */
export function storageFileName (title: string): string
{
    const safe = title.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '');
    return (safe || 'document').slice(-80);
}

/** Short free-text label (topic / chapter): single line, max 80 chars. */
export function cleanLabel (value: unknown): string
{
    // eslint-disable-next-line no-control-regex
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}
