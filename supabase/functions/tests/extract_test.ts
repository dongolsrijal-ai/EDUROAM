// Deno test: the real ingestion pipeline (signature check -> extraction -> chunking) on a
// generated two-page PDF, a DOCX and TXT files. Run: npm run test:edge

import { zipSync, strToU8 } from 'npm:fflate@0.8.3';
import { extractPages } from '../_shared/extract.ts';
import { chunkPages, matchesSignature } from '../_shared/textProcessing.ts';

function assert (condition: unknown, message: string): asserts condition
{
    if (!condition) throw new Error(message);
}

/** A minimal valid PDF with one line of text per page (correct xref offsets). */
function makePdf (pages: string[]): Uint8Array
{
    const objects: string[] = [];
    const pageIds = pages.map((_, i) => 4 + i * 2);
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    pages.forEach((text, i) =>
    {
        const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
        objects[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
        objects[pageIds[i] + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id++)
    {
        offsets[id] = out.length;
        out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(out);
}

function makeDocx (paragraphs: string[]): Uint8Array
{
    const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('');
    return zipSync({
        '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
        'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    });
}

Deno.test('PDF: text is extracted per page and chunks keep page numbers', async () =>
{
    const bytes = makePdf(['Photosynthesis converts light energy into chemical energy.', 'Chapter 3: The Calvin cycle fixes carbon dioxide.']);
    assert(matchesSignature('pdf', bytes), 'PDF signature recognised');
    const pages = await extractPages('pdf', bytes);
    assert(pages.length === 2, `two pages, got ${pages.length}`);
    assert(/Photosynthesis converts light/.test(pages[0].text), `page 1 text: ${pages[0].text}`);
    assert(/Calvin cycle/.test(pages[1].text), `page 2 text: ${pages[1].text}`);
    const { chunks } = chunkPages(pages, { size: 60, overlap: 0 });
    assert(chunks.length === 2, `one chunk per page, got ${chunks.length}`);
    assert(chunks[1].source.page_start === 2, 'page range recorded');
});

Deno.test('DOCX: paragraphs and entities are extracted', async () =>
{
    const bytes = makeDocx(['Worksheet: Cells & Energy', 'Question 5: Why are leaves green?']);
    assert(matchesSignature('docx', bytes), 'DOCX (zip) signature recognised');
    const [page] = await extractPages('docx', bytes);
    assert(page.text.includes('Cells & Energy'), page.text);
    assert(page.text.includes('Question 5: Why are leaves green?'), page.text);
});

Deno.test('Invalid files are rejected before extraction', async () =>
{
    const fakePdf = new TextEncoder().encode('just some text pretending to be a pdf');
    assert(!matchesSignature('pdf', fakePdf), 'text is not a PDF');
    assert(!matchesSignature('docx', fakePdf), 'text is not a DOCX');
    assert(!matchesSignature('txt', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00])), 'binary is not TXT');
    let threw = false;
    try { await extractPages('docx', zipSync({ 'other.xml': strToU8('<x/>') })); }
    catch { threw = true; }
    assert(threw, 'a zip without word/document.xml is rejected');
});

Deno.test('TXT: UTF-8 with BOM', async () =>
{
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Notes: mitosis has four phases.')]);
    assert(matchesSignature('txt', bytes), 'utf-8 text accepted');
    const [page] = await extractPages('txt', bytes);
    assert(page.text === 'Notes: mitosis has four phases.', page.text);
});
