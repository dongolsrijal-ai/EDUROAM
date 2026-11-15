// Readable text from an uploaded file (Deno: uses unpdf for PDF and fflate for DOCX).

import { unzipSync } from 'npm:fflate@0.8.3';
import { extractText, getDocumentProxy } from 'npm:unpdf@2.1.0';
import type { DocumentFileType } from './documentRules.ts';
import { decodePlainText, docxXmlToText, type PageText } from './textProcessing.ts';

const MAX_DOCX_XML_BYTES = 25 * 1024 * 1024;

export async function extractPages (fileType: DocumentFileType, bytes: Uint8Array): Promise<PageText[]>
{
    switch (fileType)
    {
        case 'txt':
        case 'text':
            return [{ text: decodePlainText(bytes) ?? '' }];
        case 'docx':
        {
            // Only the main document part is inflated, and only if its declared size is sane (zip bombs).
            const files = unzipSync(bytes, { filter: (file) => file.name === 'word/document.xml' && file.originalSize < MAX_DOCX_XML_BYTES });
            const xml = files['word/document.xml'];
            if (!xml || xml.length > MAX_DOCX_XML_BYTES) throw new Error('word/document.xml missing or too large');
            return [{ text: docxXmlToText(new TextDecoder().decode(xml)) }];
        }
        case 'pdf':
        {
            const pdf = await getDocumentProxy(bytes);
            const { text } = await extractText(pdf, { mergePages: false });
            return text.map((pageText, i) => ({ text: pageText, page: i + 1 }));
        }
        default:
            // Images are read by Gemini vision in class-documents, not here.
            throw new Error(`No text extractor for ${fileType}`);
    }
}
