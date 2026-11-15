// Coursework Library rules: image uploads, signatures, pasted text, vision parsing, figure
// grounding in Answer Dash, multi-document sampling, and no general-practice mode.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkUpload, isImageType } from '../supabase/functions/_shared/documentRules.ts';
import { parsePack, sampleAcrossDocuments } from '../supabase/functions/_shared/questionPack.ts';
import { matchesSignature } from '../supabase/functions/_shared/textProcessing.ts';
import type { RetrievedChunk } from '../supabase/functions/_shared/tutorPrompt.ts';
import { buildTutorPrompt, EMPTY_MEMORY, EMPTY_PROGRESS } from '../supabase/functions/_shared/tutorPrompt.ts';
import { parseChatRequest, parseDashRequest, parseDocumentRequest } from '../supabase/functions/_shared/validation.ts';
import { buildImageExtractionRequest, imageToPages, parseImageExtraction } from '../supabase/functions/_shared/vision.ts';

const NPC = '20000000-0000-4000-8000-000000000001';
const DOC = '30000000-0000-4000-8000-000000000001';
const bytes = (...values: (number | string)[]) => new Uint8Array(values.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])));

test('image coursework types are accepted (PNG, JPEG, WEBP, HEIC) with MIME/extension agreement', () =>
{
    for (const [name, mime, type] of [['hw.png', 'image/png', 'png'], ['notes.JPG', 'image/jpeg', 'jpeg'], ['slide.jpeg', '', 'jpeg'], ['board.webp', 'image/webp', 'webp'], ['photo.HEIC', '', 'heic'], ['photo.heif', 'image/heif', 'heic']])
    {
        const check = checkUpload(name, mime, 1000);
        assert.ok(check.ok && check.fileType === type, `${name}: ${JSON.stringify(check)}`);
    }
    assert.equal(checkUpload('photo.HEIC', '', 10).ok && (checkUpload('photo.HEIC', '', 10) as { mime: string }).mime, 'image/heic', 'empty MIME gets the canonical type');
    assert.equal(checkUpload('fake.png', 'image/jpeg', 10).ok, false);
    assert.equal(checkUpload('anim.gif', 'image/gif', 10).ok, false);
    assert.equal(checkUpload('big.png', 'image/png', 11 * 1024 * 1024).ok, false);
    assert.ok(isImageType('png') && !isImageType('pdf'));
});

test('real file signatures are required for images', () =>
{
    assert.ok(matchesSignature('png', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0)));
    assert.ok(matchesSignature('jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)));
    assert.ok(matchesSignature('webp', bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')));
    assert.ok(matchesSignature('heic', bytes(0, 0, 0, 24, 'ftypheic', 0)));
    assert.ok(!matchesSignature('png', bytes(0xff, 0xd8, 0xff)));
    assert.ok(!matchesSignature('webp', bytes('RIFF', 0, 0, 0, 0, 'WAVEfmt ')));
    assert.ok(!matchesSignature('heic', bytes(0, 0, 0, 24, 'ftypisom')));
    assert.ok(matchesSignature('text', new TextEncoder().encode('pasted notes')));
});

test('pasted coursework, renames and corrections are validated', () =>
{
    const paste = parseDocumentRequest({ action: 'paste', npc_id: NPC, visibility: 'class', title: 'Lecture 3', text: 'Quadratics: ax^2 + bx + c = 0. '.repeat(3), topic: ' Quadratics ', chapter: 'Ch 4' });
    assert.ok(paste.ok && paste.value.action === 'paste' && paste.value.topic === 'Quadratics' && paste.value.chapter === 'Ch 4');
    assert.equal(parseDocumentRequest({ action: 'paste', npc_id: NPC, visibility: 'class', title: '', text: 'x'.repeat(50) }).ok, false, 'needs a title');
    assert.equal(parseDocumentRequest({ action: 'paste', npc_id: NPC, visibility: 'class', title: 'a', text: 'too short' }).ok, false);
    assert.equal(parseDocumentRequest({ action: 'paste', npc_id: NPC, visibility: 'public', title: 'a', text: 'x'.repeat(50) }).ok, false);
    assert.equal(parseDocumentRequest({ action: 'paste', npc_id: NPC, visibility: 'class', title: 'a', text: 'x'.repeat(200_001) }).ok, false);
    const update = parseDocumentRequest({ action: 'update', document_id: DOC, title: 'Renamed', topic: 'Functions' });
    assert.ok(update.ok && update.value.action === 'update' && update.value.title === 'Renamed' && update.value.chapter === undefined);
    assert.equal(parseDocumentRequest({ action: 'update', document_id: DOC, title: '  ' }).ok, false);
    assert.ok(parseDocumentRequest({ action: 'view', document_id: DOC }).ok);
    assert.equal(parseDocumentRequest({ action: 'correct', document_id: DOC, text: '' }).ok, false);
});

test('vision extraction: uncertain content is flagged, never silently accepted', () =>
{
    const clean = parseImageExtraction(JSON.stringify({ title: 'Worksheet', text: 'Solve 2x + 3 = 9', figures: ['Right triangle with legs 3 and 4'], questions: ['1) Solve 2x + 3 = 9'], uncertain: [], needs_review: false }));
    assert.ok(clean && !clean.needsReview);
    assert.match(imageToPages(clean)[0].text, /Solve 2x \+ 3 = 9[\s\S]*Figure 1: Right triangle with legs 3 and 4/);
    const unsure = parseImageExtraction(JSON.stringify({ title: '', text: 'x = [?] + 4', figures: [], questions: [], uncertain: [], needs_review: false }));
    assert.equal(unsure?.needsReview, true, '[?] markers force review even if the model said otherwise');
    const listed = parseImageExtraction(JSON.stringify({ title: '', text: 'notes', figures: [], questions: [], uncertain: ['last line smudged'], needs_review: false }));
    assert.equal(listed?.needsReview, true);
    assert.equal(parseImageExtraction(JSON.stringify({ title: '', text: '', figures: [], questions: [], uncertain: [], needs_review: false })), null, 'nothing extracted = failure, not an empty document');
    const request = buildImageExtractionRequest('QUJD', 'image/png', 'hw.png');
    assert.deepEqual(request.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: 'QUJD' } });
    assert.match(request.systemInstruction, /NEVER guess or invent/);
});

const chunk = (i: number, doc: string, text: string, isImage = false): RetrievedChunk => ({ chunkId: `c${i}`, documentId: doc, title: `${doc}.${isImage ? 'png' : 'pdf'}`, visibility: 'class', chunkIndex: i, text, isImage });

test('Answer Dash figures must point at real uploaded images; text-only questions stay figure-free', () =>
{
    const chunks = [chunk(0, 'notes', 'Pythagoras: a^2 + b^2 = c^2'), chunk(1, 'diagram', 'Figure 1: right triangle, legs 6 and 8', true)];
    const q = (over: Record<string, unknown>) => ({ question: 'What is the hypotenuse in the figure?', choices: ['10', '12', '14', '7'], correct_index: 0, explanation: '6-8-10 triangle.', topic: 'Pythagoras', difficulty: 'standard', source: 'S2', figure: '', ...over });
    const out = parsePack(JSON.stringify({ questions: [
        q({ figure: 'S2' }),
        q({ question: 'Which formula relates the sides of a right triangle?', choices: ['a^2+b^2=c^2', 'a+b=c', 'ab=c', 'a^2=b+c'], source: 'S1', figure: 'S1' }), // S1 is not an image
        q({ question: 'State the Pythagorean theorem for legs a, b and hypotenuse c.', choices: ['a^2+b^2=c^2', 'a+b=c', 'ab=c', 'a^2=b+c'], source: 'S1' }),
    ] }), 'documents', chunks);
    assert.ok(out);
    assert.equal(out.questions.length, 2);
    assert.deepEqual(out.questions[0].figure, { document_id: 'diagram', title: 'diagram.png', chunk_index: 1 });
    assert.equal(out.questions[1].figure, null);
    assert.equal(out.rejected, 1, 'a figure label pointing at non-image text is rejected');
});

test('large libraries: every selected document contributes, within a size budget', () =>
{
    const many = ['a', 'b', 'c', 'd'].flatMap((doc) => Array.from({ length: 30 }, (_, i) => ({ documentId: doc, text: `${doc}${i} `.repeat(20) })));
    const picked = sampleAcrossDocuments(many, 12, 50_000);
    assert.equal(picked.length, 12);
    assert.deepEqual([...new Set(picked.map((c) => c.documentId))].sort(), ['a', 'b', 'c', 'd']);
    assert.ok(sampleAcrossDocuments(many, 40, 1000).reduce((n, c) => n + c.text.length, 0) <= 1000 + 200);
});

test('mini-games have no general-practice mode; multiple documents can be selected', () =>
{
    assert.equal(parseDashRequest({ action: 'start', npc_id: NPC, source: 'subject' }).ok, false);
    const multi = parseDashRequest({ action: 'start', npc_id: NPC, source: [DOC, DOC.replace('1', '2'), DOC] });
    assert.ok(multi.ok && multi.value.action === 'start' && multi.value.source !== 'all' && multi.value.source.documentIds.length === 2);
    assert.equal(parseDashRequest({ action: 'start', npc_id: NPC, source: [] }).ok, false);
    assert.equal(parseDashRequest({ action: 'start', npc_id: NPC, source: ['nope'] }).ok, false);
});

test('chat image attachments: validated, used for the turn, never treated as instructions', () =>
{
    const ok = parseChatRequest({ npc_id: NPC, message: 'Explain this', image: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } });
    assert.ok(ok.ok && ok.value.images[0]?.mimeType === 'image/png', 'the older single-image field still parses');
    assert.equal(parseChatRequest({ npc_id: NPC, message: 'x', image: { mime_type: 'image/gif', data: 'R0lG' } }).ok, false);
    assert.equal(parseChatRequest({ npc_id: NPC, message: 'x', image: { mime_type: 'image/png', data: 'not base64!' } }).ok, false);
    assert.equal(parseChatRequest({ npc_id: NPC, message: 'x', image: { mime_type: 'image/png', data: 'A'.repeat(7_000_001) } }).ok, false);
    const npc = { id: 'n', name: 'Sir Sum', subject: 'Mathematics', personality: '', teachingInstructions: '', className: 'Calculus', classDescription: '' };
    const prompt = buildTutorPrompt({ npc, memory: EMPTY_MEMORY, progress: EMPTY_PROGRESS, materials: [], chunks: [], history: [], message: 'Explain how to solve this.', channel: 'game', image: { mimeType: 'image/png', data: 'iVBOR' } });
    const parts = prompt.contents.at(-1)!.parts;
    assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/png', data: 'iVBOR' } });
    assert.match((parts[0] as { text: string }).text, /attached an IMAGE[\s\S]*not instructions/);
});
