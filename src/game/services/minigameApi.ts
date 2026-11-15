// Game-side client for the answer-dash Edge Function (Answer Dash and Spellshot). The browser
// receives questions WITHOUT answer keys; each answer is graded by the server, and the final
// result is computed there.

import { invoke, type RemoteNpc } from './tutorApi';

/** Questions come only from coursework: the whole library, or chosen documents. */
export type DashSource = 'all' | { documentIds: string[] };

/** Which game to generate a pack for. Spellshot's speed is client-only; `choices` is server-side. */
export type MinigameSetup =
    | { game: 'answer_dash' }
    | { game: 'spellshot'; choices: number; speed: SpellshotSpeed };
export type SpellshotSpeed = 'gentle' | 'brisk' | 'swift';

export interface DashQuestion
{
    question: string;
    choices: string[];
    topic: string;
    difficulty: 'intro' | 'standard' | 'challenging';
    source: { document_id: string; title: string; chunk_index: number; page_start?: number } | null;
    /** Uploaded image the player needs for this question (short-lived signed URL). */
    figure: { document_id: string; title: string; url: string | null } | null;
}

export interface DashPack
{
    game: MinigameSetup['game'];
    sessionId: string;
    mode: 'documents' | 'subject';
    documents: string[];
    questions: DashQuestion[];
}

export interface DashAnswer
{
    index: number;
    choice: number;
    correct: boolean;
    correctIndex: number;
    explanation: string;
}

export interface DashResult
{
    score: number;
    correct: number;
    incorrect: number;
    total: number;
    /** Questions answered before the round ended (Spellshot rounds are timed). */
    answered: number;
    accuracy: number;
    bestStreak: number;
    weakTopics: string[];
    masteredTopics: string[];
    topicPerformance: Record<string, { correct: number; incorrect: number }>;
}

export async function startMinigame (npc: RemoteNpc, source: DashSource, setup: MinigameSetup): Promise<DashPack>
{
    const choices = setup.game === 'spellshot' ? setup.choices : 4;
    const data = await invoke<{ session_id: string; mode: DashPack['mode']; documents: string[]; questions: DashQuestion[] }>('answer-dash', {
        action: 'start', npc_id: npc.id, source: source === 'all' ? 'all' : source.documentIds, game: setup.game,
        ...(setup.game === 'spellshot' ? { choices } : {}),
    });
    if (!Array.isArray(data.questions) || !data.questions.length || data.questions.some((q) => q.choices?.length !== choices)) throw new Error('The question pack was not valid.');
    return { game: setup.game, sessionId: data.session_id, mode: data.mode, documents: data.documents ?? [], questions: data.questions };
}

export async function answerQuestion (sessionId: string, index: number, choice: number): Promise<DashAnswer>
{
    const data = await invoke<{ index: number; choice: number; correct: boolean; correct_index: number; explanation: string }>('answer-dash', {
        action: 'answer', session_id: sessionId, index, choice,
    });
    return { index: data.index, choice: data.choice, correct: data.correct, correctIndex: data.correct_index, explanation: data.explanation };
}

export async function finishAnswerDash (sessionId: string): Promise<DashResult>
{
    const d = await invoke<Record<string, unknown>>('answer-dash', { action: 'finish', session_id: sessionId });
    return {
        score: Number(d.score), correct: Number(d.correct), incorrect: Number(d.incorrect), total: Number(d.total),
        answered: Number(d.answered ?? Number(d.correct) + Number(d.incorrect)),
        accuracy: Number(d.accuracy), bestStreak: Number(d.best_streak),
        weakTopics: (d.weak_topics as string[]) ?? [], masteredTopics: (d.mastered_topics as string[]) ?? [],
        topicPerformance: (d.topic_performance as DashResult['topicPerformance']) ?? {},
    };
}
