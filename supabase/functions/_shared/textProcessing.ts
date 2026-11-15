// Document ingestion helpers: file signature checks, DOCX/TXT text extraction and chunking.
// Pure TypeScript (PDF parsing itself lives in the Edge Function, which imports unpdf).

import type { DocumentFileType } from './documentRules.ts';

export interface PageText
{
    text: string;
    /** 1-based page number for PDFs; undefined for TXT/DOCX. */
    page?: number;
}

export interface TextChunk
{
    index: number;
    text: string;
    source: { page_start?: number; page_end?: number };
}

const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((b, i) => bytes[i] === b);

/** Checks the bytes really are the declared type (the browser's MIME type is only a hint). */
export function matchesSignature (fileType: DocumentFileType, bytes: Uint8Array): boolean
{
    switch (fileType)
    {
        case 'pdf': return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
        case 'docx': return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]); // ZIP container
        case 'txt':
        case 'text': return decodePlainText(bytes) !== null;
        case 'png': return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        case 'jpeg': return startsWith(bytes, [0xff, 0xd8, 0xff]);
        case 'webp': return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
        case 'heic':
        {
            // ISO-BMFF: "ftyp" box at offset 4 with an HEIF/HEIC brand.
            if (String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') return false;
            return /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(String.fromCharCode(...bytes.subarray(8, 12)));
        }
    }
}

/** UTF-8 (optionally with BOM) or UTF-16 text; null if the bytes are binary. */
export function decodePlainText (bytes: Uint8Array): string | null
{
    try
    {
        if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
        if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return text.includes('\u0000') ? null : text.replace(/^﻿/, '');
    }
    catch
    {
        return null;
    }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities (text: string)
{
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) =>
    {
        if (entity[0] === '#')
        {
            const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        }
        return ENTITIES[entity.toLowerCase()] ?? match;
    });
}

/** Text of a DOCX "word/document.xml": runs in reading order, paragraphs on new lines. */
export function docxXmlToText (xml: string): string
{
    const out: string[] = [];
    const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>|<\/w:p>/g;
    for (const match of xml.matchAll(token))
    {
        if (match[1] !== undefined) out.push(decodeXmlEntities(match[1]));
        else if (match[0] === '<w:tab/>') out.push('\t');
        else out.push('\n');
    }
    return out.join('');
}

/** Collapses runs of spaces, keeps paragraph breaks, drops control characters. */
export function normalizeText (text: string): string
{
    return text
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .replace(/[ \t ]+/g, ' ')
        .split('\n').map((line) => line.trim()).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export interface ChunkOptions
{
    /** Target characters per chunk. */
    size?: number;
    /** Characters repeated from the previous chunk, so ideas split at a boundary stay findable. */
    overlap?: number;
    maxChunks?: number;
}

/**
 * Splits pages into ~size-character chunks on paragraph / sentence boundaries. Each chunk
 * records the page range it came from, for source references.
 */
export function chunkPages (pages: PageText[], options: ChunkOptions = {}): { chunks: TextChunk[]; truncated: boolean }
{
    const size = options.size ?? 1200;
    const overlap = Math.min(options.overlap ?? 150, Math.floor(size / 3));
    const maxChunks = options.maxChunks ?? 400;

    // Units no longer than `size`, each tagged with its page.
    const units: { text: string; page?: number }[] = [];
    for (const { text, page } of pages)
    {
        for (const paragraph of normalizeText(text).split(/\n{2,}|\n(?=[-•*\d]+[.)]?\s)/))
        {
            const clean = paragraph.replace(/\n/g, ' ').trim();
            if (!clean) continue;
            for (const piece of splitLong(clean, size)) units.push({ text: piece, page });
        }
    }

    const chunks: TextChunk[] = [];
    let current = '';
    let pageStart: number | undefined;
    let pageEnd: number | undefined;
    const flush = () =>
    {
        if (!current.trim()) return;
        chunks.push({ index: chunks.length, text: current.trim(), source: pageRange(pageStart, pageEnd) });
    };

    for (const unit of units)
    {
        if (current && current.length + unit.text.length + 2 > size)
        {
            flush();
            if (chunks.length >= maxChunks) return { chunks, truncated: true };
            const tail = overlapTail(current, overlap);
            current = tail;
            pageStart = tail ? pageEnd : unit.page;
        }
        if (!current) pageStart = unit.page;
        current = current ? `${current}\n\n${unit.text}` : unit.text;
        pageEnd = unit.page;
    }
    flush();
    return { chunks: chunks.slice(0, maxChunks), truncated: chunks.length > maxChunks };
}

function pageRange (start?: number, end?: number)
{
    return start === undefined ? {} : { page_start: start, page_end: end ?? start };
}

function splitLong (text: string, size: number): string[]
{
    if (text.length <= size) return [text];
    const sentences = text.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) ?? [text];
    const out: string[] = [];
    let current = '';
    for (const sentence of sentences)
    {
        if (sentence.length > size)
        {
            if (current) { out.push(current.trim()); current = ''; }
            for (let i = 0; i < sentence.length; i += size) out.push(sentence.slice(i, i + size).trim());
            continue;
        }
        if (current.length + sentence.length > size) { out.push(current.trim()); current = ''; }
        current += sentence;
    }
    if (current.trim()) out.push(current.trim());
    return out.filter(Boolean);
}

function overlapTail (text: string, overlap: number)
{
    if (overlap <= 0 || text.length <= overlap) return '';
    const tail = text.slice(-overlap);
    const space = tail.indexOf(' ');
    return (space >= 0 ? tail.slice(space + 1) : tail).trim();
}
