// FaceTime Tutor (LiveKit voice) pure pieces: request validation (only a pairing id identifies a
// session; browser-supplied player/NPC ids are ignored), the agent secret check, LiveKit URL,
// voice instructions from the same tutoring rules, and the end-of-call memory merge.
// The pairing database rules are tested in backendDb.test.mts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_PROGRESS } from '../supabase/functions/_shared/tutorPrompt.ts';
import {
    AGENT_IDENTITY, buildVoiceInstructions, hashPairingCode, livekitHttpUrl, memoryAfterCall, mintRoomToken, newPairingCode, normalizeSpokenCode,
    parseAgentRequest, parseChertEvent, parseVoiceStart, searchResponse, secretMatches, VOICE_AGENT_NAME, voiceAgentName,
} from '../supabase/functions/_shared/voice.ts';

const NPC = '20000000-0000-4000-8000-000000000001';
const PAIRING = '50000000-0000-4000-8000-000000000001';

test('the game can only ASK for a call with an NPC id; nothing else is read from the browser', () =>
{
    const ok = parseVoiceStart({ action: 'start', npc_id: NPC.toUpperCase(), player_id: 'attacker', room: 'eduroam-x' });
    assert.deepEqual(ok, { ok: true, value: { npcId: NPC, mode: 'browser' } });
    assert.deepEqual(parseVoiceStart({ action: 'start', npc_id: NPC, mode: 'facetime' }), { ok: true, value: { npcId: NPC, mode: 'facetime' } });
    assert.equal(parseVoiceStart({ action: 'start', npc_id: NPC, mode: 'phone' }).ok, false);
    assert.equal(parseVoiceStart({ action: 'start', npc_id: 'sir-sum' }).ok, false);
    assert.equal(parseVoiceStart({ npc_id: NPC }).ok, false);
});

test('the agent identifies a session only by the opaque pairing id', () =>
{
    assert.deepEqual(parseAgentRequest({ action: 'resolve', pairing_id: PAIRING, player_id: 'x', npc_id: NPC }), { ok: true, value: { action: 'resolve', pairingId: PAIRING } });
    assert.equal(parseAgentRequest({ action: 'resolve', npc_id: NPC }).ok, false, 'an NPC id is not a pairing');
    assert.equal(parseAgentRequest({ action: 'search', pairing_id: PAIRING, query: '   ' }).ok, false);
    const search = parseAgentRequest({ action: 'search', pairing_id: PAIRING, query: 'photosynthesis\n'.repeat(100) });
    assert.ok(search.ok && search.value.action === 'search' && search.value.query.length <= 300);
    const end = parseAgentRequest({ action: 'end', pairing_id: PAIRING, summary: 'Practised the chain rule.\u0007', topics: ['chain rule', '', 5, 'x'.repeat(500)] });
    assert.ok(end.ok && end.value.action === 'end');
    assert.equal(end.value.summary, 'Practised the chain rule.');
    assert.deepEqual(end.value.topics.map((t) => t.length), ['chain rule'.length, 120]);
    assert.equal(parseAgentRequest({ action: 'drop', pairing_id: PAIRING }).ok, false);
});

test('agent secret: exact match only, constant-time, empty never matches', async () =>
{
    assert.equal(await secretMatches('s3cret-value', 's3cret-value'), true);
    assert.equal(await secretMatches('s3cret-valuf', 's3cret-value'), false);
    assert.equal(await secretMatches('s3cret', 's3cret-value'), false);
    assert.equal(await secretMatches('', ''), false, 'an unset secret never authorises anything');
    assert.equal(await secretMatches('x', ''), false);
});

test('LiveKit server API URL and agent name', () =>
{
    assert.equal(livekitHttpUrl('wss://eduroam-abc.livekit.cloud/'), 'https://eduroam-abc.livekit.cloud');
    assert.equal(livekitHttpUrl('https://eduroam-abc.livekit.cloud'), 'https://eduroam-abc.livekit.cloud');
    assert.equal(VOICE_AGENT_NAME, 'eduroam-tutor');
});

test('voice instructions carry the real NPC, preferences and memory, phrased for speech', () =>
{
    const npc = { id: NPC, name: 'Professor Bob', subject: 'Biology', personality: '', teachingInstructions: '', className: 'Year 9 Biology', classDescription: '' };
    const text = buildVoiceInstructions(npc, { summary: 'Working on photosynthesis.', currentTopic: 'photosynthesis', topicsStudied: [], learningPreferences: ['Use short explanations'] },
        { topicsMastered: [], topicsNeedingPractice: ['cell respiration'] }, ['Photosynthesis.pdf']);
    for (const expected of [/You are Professor Bob, a warm, patient Biology tutor/, /Class: Year 9 Biology/, /- Use short explanations/, /Working on photosynthesis/,
        /- Photosynthesis\.pdf/, /search_coursework tool/, /The student decides the topic/, /No lists, symbols, markdown or URLs/, /mention only if asked/])
    {
        assert.match(text, expected);
    }
});

test('end-of-call summary merges into the existing NPC memory (preferences kept)', () =>
{
    const before = { summary: 'Old summary.', currentTopic: 'cells', topicsStudied: ['cells'], learningPreferences: ['Use short explanations'], pendingPreference: '' };
    const after = memoryAfterCall(before, EMPTY_PROGRESS, 'Talked through the chain rule with two examples.', ['chain rule']);
    assert.equal(after.summary, 'Talked through the chain rule with two examples.');
    assert.equal(after.currentTopic, 'chain rule');
    assert.deepEqual(after.topicsStudied, ['chain rule', 'cells']);
    assert.deepEqual(after.learningPreferences, ['Use short explanations']);
    assert.equal(memoryAfterCall(before, EMPTY_PROGRESS, '', []).summary, 'Old summary.', 'an empty summary never wipes memory');
});

test('FaceTime pairing codes: spoken digits are understood, codes are random 6 digits, only hashes are stored', async () =>
{
    assert.equal(normalizeSpokenCode('4 8 2 9 1 3'), '482913');
    assert.equal(normalizeSpokenCode('four eight two, nine one three'), '482913');
    assert.equal(normalizeSpokenCode('oh one two-three four five'), '012345');
    assert.equal(normalizeSpokenCode('48291'), '', 'too short');
    assert.equal(normalizeSpokenCode('my code is banana'), '');
    const codes = new Set(Array.from({ length: 200 }, () => newPairingCode()));
    assert.ok([...codes].every((c) => /^\d{6}$/.test(c)) && codes.size > 190, 'random 6-digit codes');
    const hash = await hashPairingCode('482913');
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(hash, await hashPairingCode('482914'));
    assert.ok(!hash.includes('482913'));
});

test('FaceTime agent requests name the call (not a player or NPC) and need a 6-digit code', () =>
{
    const CALL = '60000000-0000-4000-8000-000000000001';
    assert.deepEqual(parseAgentRequest({ action: 'pair', call_id: CALL, code: 'four 8 2 9 1 3', player_id: 'x', npc_id: NPC }), { ok: true, value: { action: 'pair', callId: CALL, code: '482913' } });
    assert.equal(parseAgentRequest({ action: 'pair', call_id: CALL, code: '12' }).ok, false);
    assert.equal(parseAgentRequest({ action: 'pair', call_id: 'room-1', code: '123456' }).ok, false);
    assert.deepEqual(parseAgentRequest({ action: 'progress', pairing_id: PAIRING }), { ok: true, value: { action: 'progress', pairingId: PAIRING } });
    assert.deepEqual(parseAgentRequest({ action: 'call_ended', call_id: CALL }), { ok: true, value: { action: 'call_ended', callId: CALL } });
});

test('Chert bridge token: one room, join/publish/subscribe, integer nbf/exp within 2 h, signed with the API secret', async () =>
{
    const now = Date.UTC(2026, 10, 16, 12);
    const token = await mintRoomToken({ apiKey: 'APIkey', apiSecret: 'secret-value', identity: 'chert-bridge-1', room: 'eduroam-ft-x', seconds: 99_999, now });
    const [header, payload, signature] = token.split('.');
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    assert.deepEqual(decode(header), { alg: 'HS256', typ: 'JWT' });
    const claims = decode(payload);
    assert.equal(claims.iss, 'APIkey');
    assert.equal(claims.sub, 'chert-bridge-1');
    assert.notEqual(claims.sub, AGENT_IDENTITY, 'bridge identity differs from the agent');
    assert.ok(Number.isInteger(claims.nbf) && Number.isInteger(claims.exp) && claims.nbf <= now / 1000 && claims.exp - claims.nbf <= 7200);
    assert.deepEqual(claims.video, { room: 'eduroam-ft-x', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false });
    const { createHmac } = await import('node:crypto');
    assert.equal(signature, createHmac('sha256', 'secret-value').update(`${header}.${payload}`).digest('base64url'), 'valid HS256 signature');
    assert.ok(!token.includes('secret-value'));
});

test('Chert webhook events: call.incoming (documented shape), call end, anything else ignored', () =>
{
    const incoming = { event_id: 'e1', type: 'call.incoming', data: { call_id: 'c7161775-cd89-44e4-b1b1-93cc9c346b21', line_id: 'line-1', media: { audio: true, video: true }, from_handle_hash: null } };
    assert.deepEqual(parseChertEvent(incoming), { ok: true, value: { kind: 'incoming', eventId: 'e1', callId: 'c7161775-cd89-44e4-b1b1-93cc9c346b21', lineId: 'line-1' } });
    assert.equal(parseChertEvent({ type: 'call.incoming', data: {} }).ok, false);
    assert.deepEqual(parseChertEvent({ type: 'call.ended', data: { call_id: 'abc' } }), { ok: true, value: { kind: 'ended', callId: 'abc' } });
    assert.deepEqual(parseChertEvent({ type: 'line.ready', data: {} }), { ok: true, value: { kind: 'other', type: 'line.ready' } });
    assert.equal(parseChertEvent('nope').ok, false);
});

test('voice instructions cover the camera honestly and the end-of-call summary', () =>
{
    const text = buildVoiceInstructions({ id: NPC, name: 'Professor Maple', subject: 'Mathematics', className: 'Maths', personality: '', teachingInstructions: '' } as any,
        { summary: '', currentTopic: '', topicsStudied: [], learningPreferences: [] } as any, EMPTY_PROGRESS, []);
    assert.match(text, /You are Professor Maple/);
    assert.match(text, /never claim to see anything when no camera image is coming in/);
    assert.match(text, /save_session_summary/);
});

test('each call speaks as the selected NPC: name, class, personality and teacher instructions; never a generic assistant', () =>
{
    const memory = (summary: string, prefs: string[]) => ({ summary, currentTopic: '', topicsStudied: [], learningPreferences: prefs, pendingPreference: '' });
    const newton = buildVoiceInstructions(
        { id: NPC, name: 'Professor Newton', subject: 'Physics', className: 'Year 11 Physics', personality: 'Dry wit, loves apples and thought experiments.', teachingInstructions: 'Always ask for units.' } as any,
        memory('Studied Newton’s second law; mixed up mass and weight.', ['Use worked examples']), EMPTY_PROGRESS, ['Forces worksheet.pdf']);
    const curie = buildVoiceInstructions(
        { id: '20000000-0000-4000-8000-000000000002', name: 'Madame Curie', subject: 'Chemistry', className: 'Chem 101', personality: 'Calm and precise.', teachingInstructions: 'Use the periodic table.' } as any,
        memory('', []), EMPTY_PROGRESS, ['Atoms (processing, not searchable yet)']);

    for (const expected of [/You are Professor Newton, a warm, patient Physics tutor/, /Class: Year 11 Physics/, /Dry wit, loves apples/, /Always ask for units/,
        /Your name is Professor Newton/, /Never call yourself Gemini, Hackathon, an AI model/, /mixed up mass and weight/, /- Use worked examples/, /- Forces worksheet\.pdf/])
    {
        assert.match(newton, expected);
    }
    assert.match(curie, /You are Madame Curie/);
    assert.match(curie, /Class: Chem 101/);
    assert.match(curie, /Calm and precise/);
    assert.match(curie, /\(first conversation\)/);
    assert.match(curie, /Atoms \(processing, not searchable yet\)/);
    // No context leaks between NPCs.
    for (const other of [/Newton/, /Physics/, /apples/, /units/, /mass and weight/, /Forces worksheet/]) assert.doesNotMatch(curie, other);
    for (const other of [/Curie/, /Chem 101/, /periodic table/]) assert.doesNotMatch(newton, other);
});

test('search_coursework results name their document; empty, processing and missing coursework say so plainly', () =>
{
    const doc = (title: string, status: 'ready' | 'processing' | 'pending' | 'failed') => ({ id: title, title, status, visibility: 'class' as const });
    const chunk = { chunkId: 'c1', documentId: 'd1', title: 'Homework 3.pdf', visibility: 'private' as const, chunkIndex: 0, text: 'Q2: a 2 kg cart accelerates at 3 m/s^2.', pageStart: 2 };

    const hit = searchResponse([doc('Homework 3.pdf', 'ready'), doc('Lab.pdf', 'processing')], [chunk]);
    assert.deepEqual(hit.results, [{ title: 'Homework 3.pdf', text: chunk.text, page: 2, mine: true }]);
    assert.deepEqual(hit.not_ready, [{ title: 'Lab.pdf', status: 'processing' }]);
    assert.match(hit.note, /name the document/);

    assert.match(searchResponse([doc('Homework 3.pdf', 'ready')], []).note, /could not find it in their notes/);
    assert.match(searchResponse([doc('Lab.pdf', 'pending')], []).note, /still being processed/);
    assert.match(searchResponse([], []).note, /No coursework has been uploaded/);
    assert.deepEqual(searchResponse([], []).results, []);
});

test('the dispatched agent name is a server setting (falls back to the default; junk is ignored)', () =>
{
    assert.equal(voiceAgentName(undefined), VOICE_AGENT_NAME);
    assert.equal(voiceAgentName('  '), VOICE_AGENT_NAME);
    assert.equal(voiceAgentName(' eduroam-tutor-code '), 'eduroam-tutor-code');
    assert.equal(voiceAgentName('bad name; drop'), VOICE_AGENT_NAME);
});
