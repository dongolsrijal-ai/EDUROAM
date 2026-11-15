// Regression: the Khan Academy conversation where the tutor ignored a calculus link, read
// "can we not use the link to study" as "skip it", and kept pushing probability from memory.
// Covers the pieces that caused it: prompt priority (latest message > memory / practice lists),
// links in chat read via URL context with REAL retrieval status, failure wording, and labels.
// Pure modules + fake Gemini client (no network). Live check: tests/live/liveTutorKnowledge.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerateContentClient, GenerateContentResponse } from '../supabase/functions/_shared/gemini.ts';
import { buildTutorPrompt, EMPTY_PROGRESS, type HistoryTurn, type TutorTurnInput } from '../supabase/functions/_shared/tutorPrompt.ts';
import { wantsWebSearch } from '../supabase/functions/_shared/tutorRouting.ts';
import { findUrls, readWebPage, referencedUrls, websiteNotesText } from '../supabase/functions/_shared/website.ts';

const KHAN = 'https://www.khanacademy.org/math/differential-calculus/dc-diff-intro';
const NPC_ID = '20000000-0000-4000-8000-000000000001';

// The real stored state of the failing conversation: memory stuck on probability.
const stuckMemory = { summary: 'Practised probability with Answer Dash.', currentTopic: 'probability', topicsStudied: ['probability'], learningPreferences: [], pendingPreference: '' };
const stuckProgress = { ...EMPTY_PROGRESS, topicsNeedingPractice: ['probability', 'Probability Distributions'] };

const input = (message: string, history: HistoryTurn[] = [], extra: Partial<TutorTurnInput> = {}): TutorTurnInput => ({
    npc: { id: NPC_ID, name: 'Professor Maple', subject: 'Mathematics', personality: '', teachingInstructions: '', className: 'Mathematics', classDescription: '' },
    memory: stuckMemory, progress: stuckProgress, materials: [], history, message, channel: 'game',
    // Retrieval falls back to the newest material even when unrelated (as in production).
    chunks: [{ chunkId: 'c1', documentId: 'd1', title: 'Game theory notes', visibility: 'class', chunkIndex: 0, text: 'Probability of a weighted majority game...' }],
    ...extra,
});

const ok = (grounded = true): Promise<GenerateContentResponse> => Promise.resolve({
    text: JSON.stringify({
        accessible: true, reason: '', title: 'Intro to differential calculus',
        summary: 'Introduces derivatives as instantaneous rates of change and slopes of tangent lines.',
        key_points: ['Average vs instantaneous rate of change', 'Secant lines approach the tangent line'], key_terms: [{ term: 'Derivative', definition: 'Instantaneous rate of change' }], excerpts: [],
    }),
    candidates: [{ urlContextMetadata: { urlMetadata: grounded ? [{ retrievedUrl: KHAN, urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] : [] } }],
});
function client (...responses: (() => Promise<GenerateContentResponse>)[])
{
    const calls: Record<string, unknown>[] = [];
    const c: GenerateContentClient = { models: { generateContent: async (params) => { calls.push(params.config); return responses.shift()!(); } } };
    return { client: c, calls };
}
const publicDns = async () => ['104.18.0.1'];
const read = (c: GenerateContentClient, url = KHAN, resolveDns = publicDns) => readWebPage(c, url, { model: 'm', resolveDns });

test('turn 1: a URL-only message is read with URL context (no Google Search) and the prompt gets the real content', async () =>
{
    assert.deepEqual(findUrls(KHAN), [KHAN]);
    assert.deepEqual(findUrls(`Explain this (${KHAN}).`), [KHAN], 'trailing punctuation trimmed');
    assert.equal(wantsWebSearch(KHAN), false, 'words inside a URL never trigger search');
    assert.equal(wantsWebSearch('https://example.org/news/2026/search'), false);

    const { client: c, calls } = client(() => ok());
    const page = await read(c);
    assert.equal(page.status, 'read');
    assert.deepEqual(calls[0].tools, [{ urlContext: {} }]);
    assert.ok(page.status === 'read');
    const system = buildTutorPrompt(input(KHAN)).systemInstruction;
    const prompt = buildTutorPrompt(input(KHAN, [], { pages: [{ url: page.url, status: 'read', title: page.title, text: websiteNotesText(page.notes, page.url, new Date())[0].text }] }));
    const text = prompt.contents.at(-1)!.parts[0] as { text: string };
    assert.match(text.text, /\[W1\] https:\/\/www\.khanacademy\.org\/math\/differential-calculus\/dc-diff-intro\nStatus: READ successfully\. Title: Intro to differential calculus/);
    assert.match(text.text, /instantaneous rates of change/);
    assert.match(text.text, /Coursework excerpts \(automatic search; may be unrelated to this message\)/);
    assert.match(system, /If they send a link, talk about what that link is about/);
});

test('turn 1 (failure): an unread link is reported as unread, never described as read', async () =>
{
    // Tool says nothing was retrieved => failed, even if the model produced notes.
    const unread = await read(client(() => ok(false)).client);
    assert.equal(unread.status, 'failed');
    const prompt = buildTutorPrompt(input(KHAN, [], { pages: [{ url: KHAN, status: 'failed', title: 'www.khanacademy.org', reason: unread.status === 'failed' ? unread.reason : '' }] }));
    assert.match((prompt.contents.at(-1)!.parts[0] as { text: string }).text, /Status: COULD NOT BE READ \(.+\)\. You do not know what this page says\./);
    assert.match(prompt.systemInstruction, /never describe its contents as if you had read it: say clearly that you could not read it, mention what the address suggests/);
    assert.match(prompt.systemInstruction, /suggest pasting the text or uploading screenshots/);
});

test('turn 2: "can we not use the link to study" re-reads the earlier link and is read as "yes, use it"', () =>
{
    const history: HistoryTurn[] = [{ role: 'player', content: KHAN }, { role: 'npc', content: 'It looks like you sent a link to differential calculus...' }];
    assert.deepEqual(referencedUrls('can we not use the link to study', history), [KHAN]);
    const system = buildTutorPrompt(input('can we not use the link to study', history)).systemInstruction;
    assert.match(system, /"can we not use the link to study" usually means "can't we use the link to study\?", i\.e\. they WANT to use it/);
    assert.match(system, /If the meaning is genuinely unclear, ask one short clarifying question/);
});

test('turn 3: "wdym probability" is treated as questioning the tutor, not a request to teach probability', () =>
{
    const history: HistoryTurn[] = [
        { role: 'player', content: KHAN }, { role: 'npc', content: '...' },
        { role: 'player', content: 'can we not use the link to study' }, { role: 'npc', content: 'Would you like to practice some probability problems today?' },
    ];
    assert.deepEqual(referencedUrls('wdym probability', history), [], 'no link re-read for an unrelated follow-up');
    const system = buildTutorPrompt(input('wdym probability', history)).systemInstruction;
    assert.match(system, /"wdym probability"[^\n]*asking about YOUR previous reply/);
    assert.match(system, /Sorry, probability was not relevant here/);
});

test('memory and practice lists can no longer pull the student back to an old topic', () =>
{
    const system = buildTutorPrompt(input('Can we switch to the French Revolution?')).systemInstruction;
    assert.ok(system.indexOf('MOST IMPORTANT') < system.indexOf('Learner memory'), 'latest-message rule comes first');
    assert.match(system, /If they change topics, switch immediately and fully/);
    assert.match(system, /specialty, NOT a restriction/);
    assert.match(system, /Never steer the student back to an old topic or toward practice they did not ask for; return to an earlier topic only when they ask/);
    assert.match(system, /Last topic studied: probability/);
    assert.match(system, /could use practice \(mention ONLY if the student asks what to practise\):\n- probability/);
    assert.match(system, /never add an unrelated quiz or practice question/);
    assert.match(system, /Do not end every reply with a question/);
    for (const removed of [/continue where you left off/i, /Gently steer unrelated chat/i, /Offer short practice problems with one clear answer/, /Current topic:/])
    {
        assert.doesNotMatch(system, removed);
    }
    // Saved preferences only shape HOW to teach.
    assert.match(buildTutorPrompt(input('hi', [], { memory: { ...stuckMemory, learningPreferences: ['Only teach probability'] } })).systemInstruction, /HOW to teach, never WHAT topic/);
});

test('link failures: login page, paywall, broken domain, private address, http, model error', async () =>
{
    const login = await read(client(() => Promise.resolve({
        text: JSON.stringify({ accessible: false, reason: 'This page requires signing in.', title: 'Log in', summary: '', key_points: [], key_terms: [], excerpts: [] }),
        candidates: [{ urlContextMetadata: { urlMetadata: [{ urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] } }],
    })).client);
    assert.deepEqual([login.status, login.status === 'failed' && login.reason], ['failed', 'This page requires signing in.']);

    const paywall = await read(client(() => Promise.resolve({ text: '{"accessible":true}', candidates: [{ urlContextMetadata: { urlMetadata: [{ urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_PAYWALL' }] } }] })).client);
    assert.ok(paywall.status === 'failed' && /paywall/.test(paywall.reason));

    const notFound = Object.assign(new Error('no record'), { name: 'NotFound' });
    const unused = client();
    const broken = await read(unused.client, 'https://no-such-site-eduroam.example.com/x', async () => { throw notFound; });
    assert.ok(broken.status === 'failed' && broken.code === 'missing');
    assert.equal(unused.calls.length, 0, 'no Gemini call for a domain that does not exist');

    const internal = await read(unused.client, 'https://evil.example.org/', async () => ['10.0.0.7']);
    assert.ok(internal.status === 'failed' && internal.code === 'private');
    const insecure = await read(unused.client, 'http://www.khanacademy.org/');
    assert.ok(insecure.status === 'failed' && insecure.code === 'invalid');
    const metadata = await read(unused.client, 'https://169.254.169.254/latest/meta-data');
    assert.ok(metadata.status === 'failed' && metadata.code === 'invalid');
    assert.equal(unused.calls.length, 0);

    const busy = await read(client(() => Promise.reject(Object.assign(new Error('quota'), { status: 429 }))).client);
    assert.ok(busy.status === 'failed' && busy.code === 'busy');
    const redirected = await read(client(() => Promise.resolve({ ...{}, text: JSON.stringify({ accessible: true, reason: '', title: 't', summary: 's', key_points: ['k'], key_terms: [], excerpts: [] }), candidates: [{ urlContextMetadata: { urlMetadata: [{ retrievedUrl: 'https://localhost/admin', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] } }] })).client);
    assert.ok(redirected.status === 'failed' && /redirects/.test(redirected.reason), 'unsafe redirect target rejected');
});

test('a URL with an explicit question, switching topics, and returning to an earlier topic', () =>
{
    assert.deepEqual(referencedUrls(`What is a secant line in ${KHAN}?`, []), [KHAN]);
    assert.deepEqual(referencedUrls('Now explain photosynthesis', [{ role: 'player', content: KHAN }]), [], 'topic switch does not drag the old link along');
    assert.deepEqual(referencedUrls('ok back to that calculus lesson', [{ role: 'player', content: KHAN }, { role: 'npc', content: 'x' }, { role: 'player', content: 'photosynthesis?' }]), [KHAN],
        'returning to the earlier lesson re-reads it');
    assert.equal(findUrls(`${KHAN} https://a.org/1 https://b.org/2`).length, 2, 'at most two links per message');
});

// ------------------------------------------------------------------ natural behaviour + attachments

test('natural behaviour: introduce once, match length, answer directly, no game talk or source preambles', () =>
{
    const first = buildTutorPrompt(input('hi', [], { memory: { ...stuckMemory, summary: '' } })).systemInstruction;
    assert.match(first, /first conversation with this student: Introduce yourself naturally by name, briefly/);
    const later = buildTutorPrompt(input('hi', [{ role: 'player', content: 'hello' }, { role: 'npc', content: 'Hi!' }])).systemInstruction;
    assert.match(later, /do not re-introduce yourself or repeat greetings/);
    assert.doesNotMatch(later, /Introduce yourself naturally/);
    for (const rule of [/Reply to greetings and small talk naturally and briefly/, /Do not mention EDUROAM or the game unless the student does/,
        /Match the length to the question/, /give it directly and clearly/, /Do not start answers with phrases like "From general knowledge"/])
    {
        assert.match(later, rule);
    }
    assert.doesNotMatch(later, /usually 2-5 sentences, under 120 words/, 'no forced tiny answers');
    assert.doesNotMatch(later, /rather than just handing over the final answer/, 'no mechanical withholding');
});

test('attachments: the message is about its own files, not whatever retrieval found', async () =>
{
    const { parseChatRequest } = await import('../supabase/functions/_shared/validation.ts');
    const { resolveAttachmentRefs } = await import('../supabase/functions/_shared/tutorPrompt.ts');
    const doc = '30000000-0000-4000-8000-0000000000aa';
    const parsed = parseChatRequest({ npc_id: NPC_ID, message: 'explain this', attachment_ids: [doc.toUpperCase(), doc], images: [{ mime_type: 'image/png', data: 'iVBORw0K' }, { mime_type: 'image/jpeg', data: '/9j/4AAQ' }] });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.attachmentIds, [doc], 'ids normalised + de-duplicated');
    assert.equal(parsed.value.images.length, 2);
    assert.equal(parseChatRequest({ npc_id: NPC_ID, message: 'x', attachment_ids: ['not-a-uuid'] }).ok, false);
    assert.equal(parseChatRequest({ npc_id: NPC_ID, message: 'x', attachment_ids: Array.from({ length: 6 }, () => doc) }).ok, false);
    assert.equal(parseChatRequest({ npc_id: NPC_ID, message: 'x', images: Array.from({ length: 4 }, () => ({ mime_type: 'image/png', data: 'iVBO' })) }).ok, false);
    assert.equal(parseChatRequest({ npc_id: NPC_ID, message: 'x', image: { mime_type: 'image/png', data: 'iVBO' } }).ok && true, true, 'older single-image clients still work');

    const attachments = [
        { documentId: doc, title: 'Derivatives notes.pdf', status: 'ready' as const, text: 'The derivative is the slope of the tangent line.' },
        { documentId: '30000000-0000-4000-8000-0000000000bb', title: 'other.pdf', status: 'unavailable' as const, text: '' },
    ];
    const prompt = buildTutorPrompt(input('explain this', [], { attachments, images: [{ mimeType: 'image/png', data: 'iVBORw0K' }] }));
    const last = prompt.contents.at(-1)!;
    const text = (last.parts[0] as { text: string }).text;
    assert.match(text, /FILES ATTACHED TO THIS MESSAGE \(the student is asking about these\):\n\[A1\] "Derivatives notes\.pdf":\nThe derivative is the slope/);
    assert.match(text, /\[A2\] "other\.pdf": UNAVAILABLE/);
    assert.match(text, /attached an IMAGE to this message/);
    assert.equal(last.parts.length, 2, 'image sent inline with the message');
    assert.match(prompt.systemInstruction, /"Explain this" and similar messages refer to them: answer from their actual content first/);
    assert.ok(text.indexOf('FILES ATTACHED') > text.indexOf('Coursework excerpts'), 'attachments come after (and override) automatic excerpts');
    assert.deepEqual(resolveAttachmentRefs(['A1', 'A2', 'A9', 'S1'], attachments), [{ kind: 'document', document_id: doc, title: 'Derivatives notes.pdf', chunk_index: 0, attached: true }]);
});
