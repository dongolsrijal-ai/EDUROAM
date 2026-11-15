// Unit tests for the tutoring backend's pure modules (shared by the Edge Functions):
// request validation, upload rules, chunking, Gemini context building, memory merging,
// source references and Gemini error handling (with a fake client; no network).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkUpload, MAX_DOCUMENT_BYTES, storageFileName } from '../supabase/functions/_shared/documentRules.ts';
import { classifyGeminiError, generateTutorTurn, type GenerateContentClient } from '../supabase/functions/_shared/gemini.ts';
import { chunkPages, docxXmlToText, matchesSignature } from '../supabase/functions/_shared/textProcessing.ts';
import {
    buildTutorPrompt, EMPTY_MEMORY, EMPTY_PROGRESS, mergeLearning, parseTutorOutput, resolveSourceRefs,
    type RetrievedChunk, type TutorTurnInput,
} from '../supabase/functions/_shared/tutorPrompt.ts';
import { parseChatRequest, parseDocumentRequest } from '../supabase/functions/_shared/validation.ts';

const NPC_ID = '20000000-0000-4000-8000-000000000001';

test('chat requests: ids must be UUIDs, text is cleaned and bounded, identity is never read from the body', () =>
{
    assert.equal(parseChatRequest({ npc_id: 'sir-sum-a-lot', message: 'hi' }).ok, false);
    assert.equal(parseChatRequest({ npc_id: NPC_ID, message: '   ' }).ok, false);
    assert.equal(parseChatRequest({ npc_id: NPC_ID, message: 'x'.repeat(2001) }).ok, false);
    assert.equal(parseChatRequest({ npc_id: NPC_ID, conversation_id: 'nope', message: 'hi' }).ok, false);
    assert.equal(parseChatRequest([]).ok, false);
    const ok = parseChatRequest({ npc_id: NPC_ID.toUpperCase(), message: ' Quiz me\u0007 on Chapter 3 ', player_id: 'attacker' });
    assert.ok(ok.ok);
    assert.deepEqual(ok.value, { npcId: NPC_ID, conversationId: null, message: 'Quiz me on Chapter 3', clientMessageId: null, images: [], attachmentIds: [] });
    assert.ok(!('playerId' in ok.value));
});

test('upload rules: only PDF/TXT/DOCX within 10 MB, MIME must agree with the extension', () =>
{
    assert.ok(checkUpload('biology.pdf', 'application/pdf', 1000).ok);
    assert.ok(checkUpload('notes.TXT', '', 10).ok, 'empty browser MIME falls back to the extension');
    assert.ok(checkUpload('hw.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 10).ok);
    assert.equal(checkUpload('virus.exe', 'application/octet-stream', 10).ok, false);
    assert.equal(checkUpload('old.doc', 'application/msword', 10).ok, false);
    assert.equal(checkUpload('fake.pdf', 'image/png', 10).ok, false);
    assert.equal(checkUpload('big.pdf', 'application/pdf', MAX_DOCUMENT_BYTES + 1).ok, false);
    assert.equal(checkUpload('empty.txt', 'text/plain', 0).ok, false);
    const title = checkUpload('C:\\Users\\me\\Chapter 3 – Cells.pdf', 'application/pdf', 5);
    assert.ok(title.ok && title.title === 'Chapter 3 – Cells.pdf');
    assert.equal(storageFileName('../../Chapter 3 – Cells.pdf'), 'Chapter_3_Cells.pdf');

    assert.equal(parseDocumentRequest({ action: 'create', npc_id: NPC_ID, visibility: 'public', file_name: 'a.pdf', mime_type: 'application/pdf', size_bytes: 5 }).ok, false);
    assert.equal(parseDocumentRequest({ action: 'create', npc_id: NPC_ID, visibility: 'private', file_name: 'a.exe', mime_type: '', size_bytes: 5 }).ok, false);
    assert.ok(parseDocumentRequest({ action: 'create', npc_id: NPC_ID, visibility: 'private', file_name: 'a.pdf', mime_type: 'application/pdf', size_bytes: 5 }).ok);
    assert.equal(parseDocumentRequest({ action: 'process', document_id: '1' }).ok, false);
    assert.equal(parseDocumentRequest({ action: 'drop_table' }).ok, false);
});

test('file signatures and DOCX text', () =>
{
    assert.ok(matchesSignature('pdf', new TextEncoder().encode('%PDF-1.7 ...')));
    assert.ok(!matchesSignature('pdf', new TextEncoder().encode('<html>')));
    assert.ok(matchesSignature('docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])));
    assert.ok(!matchesSignature('txt', new Uint8Array([0x00, 0x01, 0x02])));
    const xml = '<w:body><w:p><w:r><w:t>Cells &amp; tissues</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> are alive</w:t></w:r></w:p><w:p><w:r><w:t>Q5&#58; why?</w:t></w:r></w:p></w:body>';
    assert.equal(docxXmlToText(xml), 'Cells & tissues\t are alive\nQ5: why?\n');
});

test('chunking keeps chunks bounded, overlapping and tagged with pages', () =>
{
    const sentence = 'Photosynthesis happens in the chloroplasts of plant cells. ';
    const pages = [{ text: sentence.repeat(30), page: 1 }, { text: `Chapter 3\n\n${'Respiration releases energy. '.repeat(40)}`, page: 2 }];
    const { chunks, truncated } = chunkPages(pages, { size: 400, overlap: 60 });
    assert.equal(truncated, false);
    assert.ok(chunks.length >= 6);
    for (const chunk of chunks) assert.ok(chunk.text.length <= 400 + 60 + 2, `chunk ${chunk.index} is ${chunk.text.length} chars`);
    assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
    assert.equal(chunks[0].source.page_start, 1);
    assert.equal(chunks.at(-1)!.source.page_end, 2);
    // Overlap: the start of chunk 2 repeats the end of chunk 1.
    assert.ok(chunks[0].text.endsWith(chunks[1].text.split('\n\n')[0].slice(-20)));
    assert.equal(chunkPages([{ text: '  \n\n ' }]).chunks.length, 0);
    assert.equal(chunkPages([{ text: 'word '.repeat(5000) }], { size: 100, maxChunks: 3 }).truncated, true);
});

const chunk = (id: string, title: string, text: string, extra: Partial<RetrievedChunk> = {}): RetrievedChunk =>
    ({ chunkId: id, documentId: `doc-${title}`, title, visibility: 'class', chunkIndex: 0, text, ...extra });

const baseInput = (overrides: Partial<TutorTurnInput> = {}): TutorTurnInput => ({
    npc: {
        id: NPC_ID, name: 'Professor Bob', subject: 'Biology', personality: 'Cheerful and patient',
        teachingInstructions: 'Use the photosynthesis unit first.', className: 'Biology', classDescription: '',
    },
    memory: EMPTY_MEMORY,
    progress: EMPTY_PROGRESS,
    materials: [],
    chunks: [],
    history: [],
    message: 'What is photosynthesis?',
    channel: 'game',
    ...overrides,
});

test('Gemini context: persona, class, subject focus, memory, labelled excerpts and document status', () =>
{
    const prompt = buildTutorPrompt(baseInput({
        memory: { summary: 'Learned that plants need light.', currentTopic: 'photosynthesis', topicsStudied: ['photosynthesis'], learningPreferences: ['short answers'] },
        progress: { topicsMastered: ['chlorophyll'], topicsNeedingPractice: ['Calvin cycle'] },
        materials: [
            { id: 'a', title: 'Biology.pdf', status: 'ready', visibility: 'class' },
            { id: 'b', title: 'Homework.docx', status: 'processing', visibility: 'private' },
        ],
        chunks: [chunk('c1', 'Biology.pdf', 'Light reactions happen in the thylakoid.', { pageStart: 4 })],
        history: [{ role: 'npc', content: 'Welcome back!' }, { role: 'player', content: 'Hi' }, { role: 'npc', content: 'Ready?' }],
    }));
    const system = prompt.systemInstruction;
    assert.match(system, /You are Professor Bob, the Biology teacher/);
    assert.match(system, /Cheerful and patient/);
    assert.match(system, /Use the photosynthesis unit first/);
    assert.match(system, /scientific principle/);
    assert.match(system, /ONE question at a time/);
    assert.match(system, /GENERAL KNOWLEDGE/);
    assert.match(system, /Learned that plants need light/);
    assert.match(system, /- Calvin cycle/);

    // History is capped by the caller; a leading model turn is dropped (Gemini wants user first).
    assert.equal(prompt.contents[0].role, 'user');
    const last = prompt.contents.at(-1)!;
    assert.equal(last.role, 'user');
    const text = last.parts[0].text;
    assert.match(text, /\[S1\] "Biology.pdf" p\.4:\nLight reactions happen in the thylakoid\./);
    assert.match(text, /"Homework.docx" \(student's own upload\): still processing/);
    assert.match(text, /STUDENT MESSAGE:\nWhat is photosynthesis\?$/);
});

test('each subject gets its own teaching focus', () =>
{
    const focus = (subject: string) => buildTutorPrompt(baseInput({ npc: { ...baseInput().npc, subject, name: 'T' } })).systemInstruction;
    assert.match(focus('Mathematics'), /problem-solving step by step/);
    assert.match(focus('World History'), /timeline/);
    assert.match(focus('Chemistry'), /scientific principle/);
    assert.match(focus('Underwater Basket Weaving'), /Explain ideas clearly/);
    assert.match(buildTutorPrompt(baseInput({ channel: 'facetime' })).systemInstruction, /spoken aloud/);
});

test('model output parsing and source references only point at retrieved chunks', () =>
{
    const raw = JSON.stringify({
        reply: 'Your notes say light reactions happen in the thylakoid. What do you think comes next?',
        used_sources: ['S1', 'S9', '[S1]', 'S2'],
        memory: { summary: 's', current_topic: 'light reactions', topics_studied: ['light reactions'], learning_preferences: [], topics_mastered: [], topics_needing_practice: ['Calvin cycle'] },
    });
    const parsed = parseTutorOutput(`\`\`\`json\n${raw}\n\`\`\``);
    assert.ok(parsed);
    const chunks = [chunk('c1', 'Notes.pdf', 'x', { pageStart: 2 }), chunk('c2', 'Worksheet.docx', 'y')];
    assert.deepEqual(resolveSourceRefs(parsed.usedSources, chunks), [
        { kind: 'document', document_id: 'doc-Notes.pdf', title: 'Notes.pdf', chunk_index: 0, page_start: 2, page_end: 2 },
        { kind: 'document', document_id: 'doc-Worksheet.docx', title: 'Worksheet.docx', chunk_index: 0 },
    ]);
    assert.equal(parseTutorOutput('not json'), null);
    assert.equal(parseTutorOutput(JSON.stringify({ reply: '' })), null);
    assert.equal(parseTutorOutput(undefined), null);
    assert.deepEqual(resolveSourceRefs(['S1'], []), [], 'no documents => no references, even if the model claims one');
});

test('memory merge keeps unrelated progress and moves topics between mastered and practice', () =>
{
    const memory = { summary: 'Old summary', currentTopic: 'cells', topicsStudied: ['cells', 'DNA'], learningPreferences: ['diagrams'] };
    const progress = { topicsMastered: ['DNA', 'Cells'], topicsNeedingPractice: ['photosynthesis', 'mitosis'] };
    const merged = mergeLearning(memory, progress, {
        summary: '', currentTopic: 'photosynthesis', topicsStudied: ['Photosynthesis'], learningPreferences: ['short answers'],
        topicsMastered: ['photosynthesis'], topicsNeedingPractice: ['cells'],
    });
    assert.equal(merged.memory.summary, 'Old summary', 'empty summary keeps the old one');
    assert.equal(merged.memory.currentTopic, 'photosynthesis');
    assert.deepEqual(merged.memory.topicsStudied, ['Photosynthesis', 'cells', 'DNA']);
    assert.deepEqual(merged.memory.learningPreferences, ['short answers', 'diagrams']);
    assert.deepEqual(merged.progress.topicsMastered, ['photosynthesis', 'DNA']);
    assert.deepEqual(merged.progress.topicsNeedingPractice, ['cells', 'mitosis']);
});

// ------------------------------------------------------------------ Gemini service

const okText = JSON.stringify({ reply: 'Hello!', used_sources: [], memory: { summary: 's', current_topic: 't', topics_studied: [], learning_preferences: [], topics_mastered: [], topics_needing_practice: [] } });

function fakeClient (...responses: (() => Promise<{ text?: string; promptFeedback?: { blockReason?: string } }>)[])
{
    const calls: Parameters<GenerateContentClient['models']['generateContent']>[0][] = [];
    const client: GenerateContentClient = {
        models: {
            generateContent (params)
            {
                calls.push(params);
                const next = responses.shift();
                if (!next) throw new Error('unexpected call');
                return next();
            },
        },
    };
    return { client, calls };
}

const apiError = (status: number, message = 'error') => Object.assign(new Error(message), { status });
const noSleep = async () => {};

test('Gemini: structured request with system instruction, schema and model id', async () =>
{
    const { client, calls } = fakeClient(async () => ({ text: okText }));
    const prompt = buildTutorPrompt(baseInput());
    const out = await generateTutorTurn(client, prompt, { model: 'gemini-test', sleep: noSleep });
    assert.equal(out.output.reply, 'Hello!');
    assert.equal(calls[0].model, 'gemini-test');
    assert.equal(calls[0].config.systemInstruction, prompt.systemInstruction);
    assert.equal(calls[0].config.responseMimeType, 'application/json');
    assert.ok(calls[0].config.responseJsonSchema);
    assert.ok(calls[0].config.abortSignal instanceof AbortSignal);
});

test('Gemini: transient errors retry once; persistent ones surface as clear error codes', async () =>
{
    const prompt = buildTutorPrompt(baseInput());
    const retried = fakeClient(async () => { throw apiError(503); }, async () => ({ text: okText }));
    assert.equal((await generateTutorTurn(retried.client, prompt, { sleep: noSleep })).output.reply, 'Hello!');
    assert.equal(retried.calls.length, 2);

    const limited = fakeClient(async () => { throw apiError(429, 'RESOURCE_EXHAUSTED'); }, async () => { throw apiError(429); });
    await assert.rejects(generateTutorTurn(limited.client, prompt, { sleep: noSleep }), (e: { code: string; httpStatus: number }) => e.code === 'rate_limited' && e.httpStatus === 429);

    const badKey = fakeClient(async () => { throw apiError(403, 'API key not valid'); });
    await assert.rejects(generateTutorTurn(badKey.client, prompt, { sleep: noSleep }), (e: { code: string; retryable: boolean }) => e.code === 'config' && !e.retryable);
    assert.equal(badKey.calls.length, 1, 'configuration errors are not retried');

    const garbage = fakeClient(async () => ({ text: 'I am not JSON' }), async () => ({ text: '{"reply": ""}' }));
    await assert.rejects(generateTutorTurn(garbage.client, prompt, { sleep: noSleep }), (e: { code: string }) => e.code === 'bad_response');

    const blocked = fakeClient(async () => ({ promptFeedback: { blockReason: 'SAFETY' } }));
    await assert.rejects(generateTutorTurn(blocked.client, prompt, { sleep: noSleep }), (e: { code: string }) => e.code === 'blocked');
});

test('Gemini: a hung request times out instead of hanging the function', async () =>
{
    const prompt = buildTutorPrompt(baseInput());
    const hung: GenerateContentClient = {
        models: {
            generateContent: ({ config }) => new Promise((_, reject) =>
            {
                (config.abortSignal as AbortSignal).addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
            }),
        },
    };
    const started = Date.now();
    await assert.rejects(generateTutorTurn(hung, prompt, { timeoutMs: 50, sleep: noSleep }), (e: { code: string; httpStatus: number }) => e.code === 'timeout' && e.httpStatus === 504);
    assert.ok(Date.now() - started < 2000);
    assert.equal(classifyGeminiError(new TypeError('fetch failed')).code, 'unavailable');
});
