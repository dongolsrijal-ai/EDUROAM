// Answer Dash question packs: strict validation, grounding, difficulty mix, shuffling, grading.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    buildPackPrompt, difficultyMix, GAMES, gradeSession, packHash, parsePack, sampleChunks, shuffleChoices, toPublic, topicOutcome,
    type PackQuestion,
} from '../supabase/functions/_shared/questionPack.ts';
import type { RetrievedChunk } from '../supabase/functions/_shared/tutorPrompt.ts';
import { parseDashRequest } from '../supabase/functions/_shared/validation.ts';

const chunk = (i: number, text: string): RetrievedChunk => ({ chunkId: `c${i}`, documentId: 'doc-1', title: 'Algebra worksheet.pdf', visibility: 'class', chunkIndex: i, text, pageStart: i + 1 });
const chunks = [chunk(0, 'Solve linear equations: 2x + 3 = 11 gives x = 4.'), chunk(1, 'Slope-intercept form y = mx + b.')];
const q = (over: Record<string, unknown> = {}) => ({
    question: 'Solve 2x + 3 = 11 for x.', choices: ['x = 4', 'x = 7', 'x = 5.5', 'x = 3'], correct_index: 0,
    explanation: 'Subtract 3 then divide by 2.', topic: 'linear equations', difficulty: 'standard', source: 'S1', ...over,
});
const pack = (questions: unknown[]) => JSON.stringify({ questions });

test('valid grounded questions pass and carry the real source document', () =>
{
    const out = parsePack(pack([q(), q({ question: 'What is the slope in y = 3x + 2?', choices: ['3', '2', '5', '1'], source: 'S2', topic: 'slope' })]), 'documents', chunks);
    assert.ok(out);
    assert.equal(out.questions.length, 2);
    assert.deepEqual(out.questions[0].source, { document_id: 'doc-1', title: 'Algebra worksheet.pdf', chunk_index: 0, page_start: 1 });
    assert.equal(out.questions[1].source?.chunk_index, 1);
});

test('invalid questions are rejected, never repaired', () =>
{
    const bad = [
        q({ choices: ['a', 'b', 'c'] }),
        q({ choices: ['x = 4', 'X = 4', 'x = 5', 'x = 6'] }),
        q({ correct_index: 4 }),
        q({ correct_index: 1.5 }),
        q({ difficulty: 'impossible' }),
        q({ explanation: '' }),
        q({ question: 'Why?' }),
        q({ source: 'S9' }),
        q({ source: '' }),
        q({ choices: ['x = 4', 'b', 'c', 'x'.repeat(200)] }),
    ];
    const out = parsePack(pack([...bad, q()]), 'documents', chunks);
    assert.ok(out);
    assert.equal(out.questions.length, 1);
    assert.equal(out.rejected, bad.length);
    assert.equal(parsePack('not json', 'documents', chunks), null);
    assert.equal(parsePack('{"x":1}', 'documents', chunks), null);
});

test('duplicates and recently asked questions are dropped; subject mode has no fake sources', () =>
{
    const out = parsePack(pack([q(), q({ choices: ['1', '2', '3', '4'] }), q({ question: 'Old question here?' })]), 'documents', chunks, ['old question here?']);
    assert.equal(out?.questions.length, 1);
    const subject = parsePack(pack([q({ source: 'S1' })]), 'subject', []);
    assert.equal(subject?.questions[0].source, null, 'subject practice never claims a document');
});

test('difficulty mix defaults to 30/50/20 and shifts gently with recent accuracy', () =>
{
    assert.deepEqual(difficultyMix(10, null), { intro: 3, standard: 5, challenging: 2 });
    assert.deepEqual(difficultyMix(10, 0.95), { intro: 2, standard: 5, challenging: 3 });
    assert.deepEqual(difficultyMix(10, 0.3), { intro: 4, standard: 5, challenging: 1 });
});

test('prompt is grounded in the excerpts, sets the level rule and lists things to avoid', () =>
{
    const npc = { id: 'n', name: 'Sir Sum', subject: 'Mathematics', personality: '', teachingInstructions: '', className: 'Algebra 8', classDescription: '' };
    const p = buildPackPrompt({ npc, mode: 'documents', chunks, count: 10, recentAccuracy: null, weakTopics: ['slope'], avoidQuestions: ['Solve x + 1 = 2'] });
    assert.match(p.systemInstruction, /ONLY about the content/);
    assert.match(p.systemInstruction, /about 8th grade/);
    assert.match(p.systemInstruction, /Never simplify advanced material/);
    const text = p.contents[0].parts[0].text;
    assert.match(text, /\[S1\] "Algebra worksheet.pdf" p\.1:\nSolve linear equations/);
    assert.match(text, /needs practice with: slope/);
    assert.match(text, /AVOID[\s\S]*Solve x \+ 1 = 2/);
    assert.equal(sampleChunks(Array.from({ length: 50 }, (_, i) => ({ text: 'x'.repeat(100), i })), 5).length, 5);
});

test('shuffling keeps the correct answer attached; public questions hide the key', () =>
{
    const base = parsePack(pack([q()]), 'documents', chunks)!.questions[0];
    for (let seed = 0; seed < 20; seed++)
    {
        let s = seed;
        const shuffled = shuffleChoices(base, () => ((s = (s * 9301 + 49297) % 233280) / 233280));
        assert.equal(shuffled.choices[shuffled.correctIndex], 'x = 4');
        assert.equal(new Set(shuffled.choices).size, 4);
    }
    const pub = toPublic(base) as unknown as Record<string, unknown>;
    assert.ok(!('correctIndex' in pub) && !('explanation' in pub));
    assert.equal(packHash([base]), packHash([base]));
});

test('grading uses stored answers only: score, streak bonus, topics', () =>
{
    const qs: PackQuestion[] = ['a', 'a', 'b', 'b', 'c'].map((topic, i) => ({ question: `Q${i}?`, choices: ['1', '2', '3', '4'], correctIndex: 1, explanation: 'e', topic, difficulty: 'standard', source: null }));
    const g = gradeSession(qs, { 0: 1, 1: 1, 2: 0, 3: 1 });
    assert.equal(g.correct, 3);
    assert.equal(g.incorrect, 1);
    assert.equal(g.unanswered, 1);
    assert.equal(g.score, 100 + 125 + 100);
    assert.equal(g.bestStreak, 2);
    assert.deepEqual(topicOutcome(g.topicPerformance), { mastered: ['a'], practice: ['b'] });
});

test('answer-dash requests are validated and never take a player id', () =>
{
    const npc = '20000000-0000-4000-8000-000000000001';
    assert.ok(parseDashRequest({ action: 'start', npc_id: npc, source: 'all' }).ok);
    assert.ok(parseDashRequest({ action: 'start', npc_id: npc, source: npc }).ok);
    assert.equal(parseDashRequest({ action: 'start', npc_id: npc, source: 'everything' }).ok, false);
    assert.equal(parseDashRequest({ action: 'answer', session_id: npc, index: 0, choice: 5 }).ok, false);
    assert.equal(parseDashRequest({ action: 'answer', session_id: npc, index: -1, choice: 0 }).ok, false);
    assert.equal(parseDashRequest({ action: 'finish', session_id: 'x' }).ok, false);
    assert.equal(parseDashRequest({ action: 'grant_score', score: 9999 }).ok, false);
});

// ---------------------------------------------------------------- Spellshot packs

const shot = (over: Record<string, unknown> = {}) => ({
    question: 'Which organelle produces usable energy?', choices: ['Mitochondrion', 'Nucleus', 'Chloroplast', 'Ribosome', 'Vacuole'], correct_index: 0,
    explanation: 'Mitochondria make ATP.', topic: 'cells', difficulty: 'intro', source: 'S1', figure: '', ...over,
});

test('spellshot packs need 5 short choices and never use figures', () =>
{
    const imageChunks = [...chunks, { ...chunk(2, 'Diagram of a cell'), isImage: true }];
    const bad = [
        shot({ choices: ['Mitochondrion', 'Nucleus', 'Chloroplast', 'Ribosome'] }),
        shot({ choices: ['Mitochondrion', 'Nucleus', 'Chloroplast', 'Ribosome', 'x'.repeat(41)] }),
        shot({ correct_index: 5 }),
        shot({ figure: 'S3' }),
        shot({ question: 'x'.repeat(141) }),
    ];
    const out = parsePack(pack([...bad, shot()]), 'documents', imageChunks, [], 'spellshot');
    assert.equal(out?.questions.length, 1);
    assert.equal(out?.rejected, bad.length);
    assert.equal(out?.questions[0].choices.length, 5);
    // Answer Dash rules are unchanged: 5 choices is not a valid Answer Dash question.
    assert.equal(parsePack(pack([shot()]), 'documents', chunks)?.questions.length, 0);
});

test('spellshot prompt asks for quick recognition, not calculations or figures', () =>
{
    const npc = { id: 'n', name: 'Ms Bloom', subject: 'Biology', personality: '', teachingInstructions: '', className: 'Bio 7', classDescription: '' };
    const p = buildPackPrompt({ npc, mode: 'documents', chunks, count: GAMES.spellshot.size, recentAccuracy: null, weakTopics: [], avoidQuestions: [], game: 'spellshot' });
    assert.match(p.systemInstruction, /"Spellshot"/);
    assert.match(p.systemInstruction, /NEVER write calculations/);
    assert.match(p.systemInstruction, /Exactly 5 answer choices/);
    assert.match(p.systemInstruction, /ONLY about the content/);
    assert.match(p.contents[0].parts[0].text, /Write 24 questions/);
});

test('choice trimming keeps the correct answer and the requested number of targets', () =>
{
    const base = parsePack(pack([shot()]), 'documents', chunks, [], 'spellshot')!.questions[0];
    for (const count of [3, 4, 5])
    {
        for (let seed = 1; seed < 15; seed++)
        {
            let s = seed;
            const trimmed = shuffleChoices(base, () => ((s = (s * 9301 + 49297) % 233280) / 233280), count);
            assert.equal(trimmed.choices.length, count);
            assert.equal(trimmed.choices[trimmed.correctIndex], 'Mitochondrion');
            assert.equal(new Set(trimmed.choices).size, count);
            assert.ok(trimmed.choices.every((c) => base.choices.includes(c)));
        }
    }
});

test('spellshot grading: streak bonus, wrong-shot penalty floored at zero, unanswered ignored', () =>
{
    const qs: PackQuestion[] = Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}?`, choices: ['a', 'b', 'c'], correctIndex: 0, explanation: 'e', topic: 't', difficulty: 'intro', source: null }));
    const g = gradeSession(qs, { 0: 1, 1: 0, 2: 0, 3: 2, 4: 0 }, GAMES.spellshot.points);
    // miss at 0 (stays 0), +100, +120, miss (-40), +100
    assert.equal(g.score, 0 + 100 + 120 - 40 + 100);
    assert.deepEqual([g.correct, g.incorrect, g.unanswered, g.bestStreak], [3, 2, 1, 2]);
    assert.equal(gradeSession(qs, { 0: 0 }).score, 100, 'Answer Dash has no penalty');
});

test('spellshot start requests: game + 3-5 choices; Answer Dash stays at 4', () =>
{
    const npc = '20000000-0000-4000-8000-000000000001';
    const start = (extra: Record<string, unknown>) => parseDashRequest({ action: 'start', npc_id: npc, source: 'all', ...extra });
    const ok = start({ game: 'spellshot', choices: 3 });
    assert.ok(ok.ok && ok.value.action === 'start' && ok.value.game === 'spellshot' && ok.value.choices === 3);
    const legacy = start({});
    assert.ok(legacy.ok && legacy.value.action === 'start' && legacy.value.game === 'answer_dash' && legacy.value.choices === 4);
    for (const bad of [{ game: 'spellshot', choices: 2 }, { game: 'spellshot', choices: 6 }, { game: 'spellshot', choices: 3.5 }, { game: 'blast' }, { game: 'answer_dash', choices: 5 }])
    {
        assert.equal(start(bad).ok, false, JSON.stringify(bad));
    }
    assert.ok(parseDashRequest({ action: 'answer', session_id: npc, index: 23, choice: 4 }).ok);
});
