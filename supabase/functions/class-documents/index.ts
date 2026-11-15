// POST /functions/v1/class-documents — the one ingestion pipeline for the Coursework Library.
//
//   create  { npc_id, visibility, file_name, mime_type, size_bytes, topic?, chapter? }
//           -> validates type/size/ownership, 'pending' row, one-time signed upload URL
//   paste   { npc_id, visibility, title, text, topic?, chapter? }
//           -> stores the text as a .txt original and processes it immediately
//   website { npc_id, visibility, url, title?, topic?, chapter? }
//           -> checks the URL is public HTTPS, Gemini URL context reads it ONCE, and only if
//              the page was really read: study notes + short excerpts + source URL are saved
//              and processed like pasted notes (nothing is saved for an unreadable page)
//   process { document_id } -> checks bytes, extracts (PDF/DOCX/TXT text; images via Gemini
//           vision: text, math, figure descriptions, uncertain parts flagged), chunks, 'ready'
//   update  { document_id, title?, topic?, chapter? }   rename / organise
//   correct { document_id, text }   replace extracted text (e.g. fix a flagged image transcription)
//   view    { document_id }   short-lived signed URL of the original + extracted text preview
//   delete  { document_id }
//
// visibility 'class'   = teacher material for the NPC's class (class owner / teachers only).
// visibility 'private' = the caller's own upload, used only for them and only by that NPC.

import { GoogleGenAI } from 'npm:@google/genai@3.3.0';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import {
    isImageType, MAX_DOCUMENT_BYTES, MAX_DOCUMENTS_PER_NPC, storageFileName, type DocumentFileType,
} from '../_shared/documentRules.ts';
import { extractPages } from '../_shared/extract.ts';
import { DEFAULT_GEMINI_MODEL, generateStructured, thinkingFor, TutorModelError } from '../_shared/gemini.ts';
import { adminClient, authenticate, HttpError, json, rateLimit, readJson, serve } from '../_shared/http.ts';
import { resolveNpcIdentity, type NpcIdentity } from '../_shared/npcContext.ts';
import { chunkPages, matchesSignature, type PageText } from '../_shared/textProcessing.ts';
import { parseDocumentRequest, type DocumentRequest } from '../_shared/validation.ts';
import { buildImageExtractionRequest, IMAGE_EXTRACTION_SCHEMA, imageToPages, parseImageExtraction } from '../_shared/vision.ts';
import {
    readWebPage, websiteNotesText,
} from '../_shared/website.ts';

const BUCKET = 'class-materials';
const DOCUMENT_COLUMNS = 'id, class_id, npc_id, uploaded_by, title, topic, chapter, file_path, file_type, mime_type, visibility, processing_status, processing_error, chunk_count, extraction, created_at';
/** A 'processing' row older than this is treated as an interrupted run and may be retried. */
const STALE_PROCESSING_MS = 5 * 60_000;
let gemini: GoogleGenAI | null = null;

serve(async (req) =>
{
    const admin = adminClient();
    const { userId, db } = await authenticate(req, admin);
    const parsed = parseDocumentRequest(await readJson(req, 420_000));
    if (!parsed.ok) throw new HttpError(400, 'bad_request', parsed.error);
    const request = parsed.value;

    if (request.action === 'create' || request.action === 'paste' || request.action === 'website')
    {
        await rateLimit(admin, userId, 'documents:hour', 120, 3600);
        const npc = await resolveNpcIdentity(db, userId, request.npcId);
        if (request.visibility === 'class' && !(await canManageClass(admin, userId, npc)))
        {
            throw new HttpError(403, 'forbidden', "Only this class's teacher can add class materials. Your upload can be private instead.");
        }
        const { count, error: countError } = await admin.from('class_documents')
            .select('id', { count: 'exact', head: true }).eq('npc_id', npc.id);
        if (countError) throw countError;
        if ((count ?? 0) >= MAX_DOCUMENTS_PER_NPC)
        {
            throw new HttpError(409, 'too_many_documents', `This teacher already has ${MAX_DOCUMENTS_PER_NPC} documents. Remove one first.`);
        }

        if (request.action === 'website')
        {
            await rateLimit(admin, userId, 'documents:website', 15, 3600);
            return json(201, { document: await addWebsite(admin, userId, npc, request) });
        }

        const id = crypto.randomUUID();
        const isPaste = request.action === 'paste';
        const fileName = isPaste ? `${request.title}.txt` : request.title;
        const path = `${userId}/${id}/${storageFileName(fileName)}`;
        const bytes = isPaste ? new TextEncoder().encode(request.text) : null;
        const { data: document, error } = await admin.from('class_documents').insert({
            id, class_id: npc.classId, npc_id: npc.id, uploaded_by: userId, title: request.title, file_path: path,
            topic: request.topic, chapter: request.chapter,
            file_type: request.action === 'paste' ? 'text' : request.fileType, mime_type: request.action === 'paste' ? 'text/plain' : request.mime,
            size_bytes: request.action === 'paste' ? bytes!.length : request.sizeBytes, visibility: request.visibility, processing_status: 'pending',
        }).select(DOCUMENT_COLUMNS).single();
        if (error) throw error;

        if (bytes)
        {
            // Pasted coursework is kept as a real original file, then processed like any upload.
            const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: 'text/plain', upsert: false });
            if (uploadError) { await admin.from('class_documents').delete().eq('id', id); throw uploadError; }
            return json(201, { document: await processDocument(admin, document) });
        }
        const { data: upload, error: uploadError } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
        if (uploadError || !upload)
        {
            await admin.from('class_documents').delete().eq('id', id);
            throw uploadError ?? new Error('Could not create upload URL');
        }
        return json(201, { document, upload: { url: upload.signedUrl, mime: request.action === 'create' ? request.mime : 'text/plain' } });
    }

    // Everything else: the document must be visible to the caller (RLS) ...
    const { data: document, error } = await db.from('class_documents').select(DOCUMENT_COLUMNS)
        .eq('id', request.documentId).maybeSingle();
    if (error) throw error;
    if (!document) throw new HttpError(404, 'document_not_found', 'That document could not be found.');
    // ... and changes need ownership (uploader, or a teacher of the class for class material).
    const canChange = async () => document.uploaded_by === userId
        || (document.visibility === 'class' && await canManageClassId(admin, userId, document.class_id));

    switch (request.action)
    {
        case 'view':
        {
            const [{ data: signed }, { data: chunks }] = await Promise.all([
                admin.storage.from(BUCKET).createSignedUrl(document.file_path, 300),
                db.from('document_chunks').select('chunk_text').eq('document_id', document.id).order('chunk_index').limit(40),
            ]);
            const text = (chunks ?? []).map((c) => c.chunk_text).join('\n\n').slice(0, 30_000);
            return json(200, { document, url: signed?.signedUrl ?? null, text, can_edit: await canChange() });
        }
        case 'delete':
        {
            if (!(await canChange())) throw new HttpError(403, 'forbidden', 'You can only remove documents you uploaded.');
            await admin.storage.from(BUCKET).remove([document.file_path]);
            const { error: deleteError } = await admin.from('class_documents').delete().eq('id', document.id);
            if (deleteError) throw deleteError;
            return json(200, { deleted: document.id });
        }
        case 'update':
        {
            if (!(await canChange())) throw new HttpError(403, 'forbidden', 'You can only edit documents you uploaded.');
            const fields: Record<string, string> = {};
            if (request.title !== undefined) fields.title = request.title;
            if (request.topic !== undefined) fields.topic = request.topic;
            if (request.chapter !== undefined) fields.chapter = request.chapter;
            const { data, error: updateError } = await admin.from('class_documents').update(fields).eq('id', document.id).select(DOCUMENT_COLUMNS).single();
            if (updateError) throw updateError;
            return json(200, { document: data });
        }
        case 'correct':
        {
            if (!(await canChange())) throw new HttpError(403, 'forbidden', 'You can only correct documents you uploaded.');
            const { chunks } = chunkPages([{ text: request.text }]);
            if (!chunks.length) throw new HttpError(400, 'bad_request', 'The corrected text is empty.');
            await replaceChunks(admin, document, chunks);
            const extraction = { ...(document.extraction ?? {}), needs_review: false, corrected: true, uncertain: [] };
            const { data, error: updateError } = await admin.from('class_documents').update({
                processing_status: 'ready', processing_error: null, chunk_count: chunks.length, extraction,
            }).eq('id', document.id).select(DOCUMENT_COLUMNS).single();
            if (updateError) throw updateError;
            return json(200, { document: data });
        }
        case 'process':
        {
            if (document.uploaded_by !== userId) throw new HttpError(403, 'forbidden', 'Only the uploader can process this document.');
            await rateLimit(admin, userId, 'documents:process', 150, 3600);
            return json(200, { document: await processDocument(admin, document) });
        }
    }
});

async function canManageClassId (admin: SupabaseClient, userId: string, classId: string)
{
    const { data: cls } = await admin.from('classes').select('owner_id').eq('id', classId).maybeSingle();
    if (cls?.owner_id === userId) return true;
    const { data: member } = await admin.from('class_members').select('role')
        .eq('class_id', classId).eq('player_id', userId).eq('role', 'teacher').maybeSingle();
    return Boolean(member);
}

const canManageClass = (admin: SupabaseClient, userId: string, npc: NpcIdentity) =>
    npc.ownerId === userId ? Promise.resolve(true) : canManageClassId(admin, userId, npc.classId);

interface DocumentRow
{
    id: string;
    class_id: string;
    npc_id: string | null;
    title: string;
    file_path: string;
    file_type: DocumentFileType;
    mime_type: string;
    processing_status: string;
    extraction: Record<string, unknown> | null;
}

async function replaceChunks (admin: SupabaseClient, document: DocumentRow, chunks: { index: number; text: string; source: Record<string, unknown> }[], source: Record<string, unknown> = {})
{
    const { error } = await admin.rpc('replace_document_chunks', {
        p_document_id: document.id,
        p_chunks: chunks.map((chunk) => ({ chunk_index: chunk.index, chunk_text: chunk.text, source: { ...chunk.source, ...source } })),
    });
    if (error) throw error;
}

function toBase64 (bytes: Uint8Array)
{
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

async function processDocument (admin: SupabaseClient, document: DocumentRow)
{
    if (document.processing_status === 'ready') return document;

    // Claim the row so two requests never process the same document at once.
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
    const { data: claimed, error: claimError } = await admin.from('class_documents')
        .update({ processing_status: 'processing', processing_error: null })
        .eq('id', document.id)
        .or(`processing_status.in.(pending,failed),and(processing_status.eq.processing,updated_at.lt."${staleBefore}")`)
        .select('id');
    if (claimError) throw claimError;
    if (!claimed?.length) throw new HttpError(409, 'already_processing', 'This document is already being processed.');

    const finish = async (fields: Record<string, unknown>) =>
    {
        const { data, error } = await admin.from('class_documents').update(fields).eq('id', document.id)
            .select(DOCUMENT_COLUMNS).single();
        if (error) throw error;
        return data;
    };
    const fail = (message: string) => finish({ processing_status: 'failed', processing_error: message });

    try
    {
        const { data: blob, error: downloadError } = await admin.storage.from(BUCKET).download(document.file_path);
        if (downloadError || !blob) return await fail('The upload did not finish. Please upload the file again.');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES) return await fail('The file is empty or larger than 10 MB.');
        if (!matchesSignature(document.file_type, bytes)) return await fail(`This is not a valid ${document.file_type.toUpperCase()} file.`);

        let pages: PageText[];
        // Website notes keep their source metadata (set when the row was created).
        let extraction: Record<string, unknown> = document.extraction?.kind === 'website'
            ? document.extraction
            : { kind: document.file_type === 'text' ? 'pasted' : 'file' };
        if (isImageType(document.file_type))
        {
            const apiKey = Deno.env.get('GEMINI_API_KEY');
            if (!apiKey) return await fail('Image reading is not set up yet (GEMINI_API_KEY missing).');
            gemini ??= new GoogleGenAI({ apiKey });
            const request = buildImageExtractionRequest(toBase64(bytes), document.mime_type, document.title);
            let result;
            try
            {
                result = await generateStructured(gemini, { ...request, schema: IMAGE_EXTRACTION_SCHEMA, parse: parseImageExtraction },
                    { model: Deno.env.get('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL, timeoutMs: 60_000, maxOutputTokens: 8000, thinkingLevel: thinkingFor('extraction', Deno.env.get('GEMINI_THINKING')) });
            }
            catch (err)
            {
                if (!(err instanceof TutorModelError)) throw err;
                console.error('[class-documents] image reading failed', document.id, err.code);
                return await fail(err.code === 'rate_limited' ? 'Image reading is busy right now. Try processing again in a minute.' : 'The image could not be read. Try a clearer photo or paste the text.');
            }
            pages = imageToPages(result);
            extraction = {
                kind: 'image', needs_review: result.needsReview, uncertain: result.uncertain, figures: result.figures.length,
                questions: result.questions.length, suggested_title: result.title,
            };
        }
        else
        {
            pages = await extractPages(document.file_type, bytes);
        }

        const { chunks, truncated } = chunkPages(pages);
        if (!chunks.length) return await fail('No readable content was found in this file.');
        await replaceChunks(admin, document, chunks, isImageType(document.file_type) ? { image: true } : {});
        return await finish({
            processing_status: 'ready', chunk_count: chunks.length, size_bytes: bytes.length, extraction,
            processing_error: truncated ? 'Very long document: only the first part is used.' : null,
        });
    }
    catch (err)
    {
        // Log ids/codes only: coursework content is never written to logs.
        console.error('[class-documents] processing failed', document.id, err instanceof Error ? err.name : 'error');
        // Chunk replacement is atomic; a failed write retains the previous shared content.
        return await fail('The document could not be read. Try saving it again as PDF or TXT, or paste the text.');
    }
}

// ------------------------------------------------------------------ website coursework

type WebsiteRequest = Extract<DocumentRequest, { action: 'website' }>;

const FAILURE_STATUS = { invalid: 400, missing: 422, private: 422, unreadable: 422, busy: 429, error: 502 } as const;

async function addWebsite (admin: SupabaseClient, userId: string, npc: NpcIdentity, request: WebsiteRequest)
{
    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) throw new HttpError(503, 'ai_not_configured', 'Website reading is not set up yet (GEMINI_API_KEY missing).');
    gemini ??= new GoogleGenAI({ apiKey });

    // Same reader as links in chat: saved only if the page was really read.
    const page = await readWebPage(gemini, request.url, {
        model: Deno.env.get('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL, timeoutMs: 60_000,
        thinkingLevel: thinkingFor('extraction', Deno.env.get('GEMINI_THINKING')),
        resolveDns: (host, type) => Deno.resolveDns(host, type), meta: { title: request.title, topic: request.topic || request.chapter },
    });
    if (page.status === 'failed')
    {
        const hint = page.code === 'unreadable' ? ' Try a public page, or paste the text instead.' : '';
        throw new HttpError(FAILURE_STATUS[page.code], page.code === 'busy' ? 'rate_limited' : 'website_unreadable', `${page.reason}${hint}`);
    }
    const notes = page.notes;

    const id = crypto.randomUUID();
    const title = (request.title || notes.title || request.host).slice(0, 120);
    const path = `${userId}/${id}/${storageFileName(`${title}.txt`)}`;
    const savedAt = new Date();
    const bytes = new TextEncoder().encode(websiteNotesText(notes, request.url, savedAt).map((p) => p.text).join('\n'));
    const { data: document, error } = await admin.from('class_documents').insert({
        id, class_id: npc.classId, npc_id: npc.id, uploaded_by: userId, title, file_path: path,
        topic: request.topic, chapter: request.chapter, file_type: 'text', mime_type: 'text/plain',
        size_bytes: bytes.length, visibility: request.visibility, processing_status: 'pending',
        extraction: { kind: 'website', url: request.url, site: request.host, saved_at: savedAt.toISOString(), page_title: notes.title },
    }).select(DOCUMENT_COLUMNS).single();
    if (error) throw error;
    const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: 'text/plain', upsert: false });
    if (uploadError) { await admin.from('class_documents').delete().eq('id', id); throw uploadError; }
    return await processDocument(admin, document);
}
