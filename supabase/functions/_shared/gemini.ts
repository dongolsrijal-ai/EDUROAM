// Gemini service: one structured generateContent call with timeout, a single retry for
// transient errors, task-based thinking, optional built-in tools (Google Search, URL context)
// and errors mapped to stable codes the game can show.
// The client is passed in (the official @google/genai GoogleGenAI instance in production),
// so this module stays free of SDK imports and is unit-tested with a fake client.

import { parseTutorOutput, TUTOR_RESPONSE_SCHEMA, type TutorModelOutput, type TutorPrompt } from './tutorPrompt.ts';

/** Default model: stable, fast and cost-effective (override with the GEMINI_MODEL secret). */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

/** Grounding / URL-context metadata of the first candidate (only the fields used here). */
export interface CandidateMetadata
{
    groundingMetadata?: {
        groundingChunks?: { web?: { uri?: string; title?: string } }[];
        webSearchQueries?: string[];
        searchEntryPoint?: { renderedContent?: string };
    };
    urlContextMetadata?: { urlMetadata?: { retrievedUrl?: string; urlRetrievalStatus?: string }[] };
}

export interface GenerateContentResponse
{
    text?: string;
    promptFeedback?: { blockReason?: string };
    candidates?: CandidateMetadata[];
}

/** The subset of GoogleGenAI used here. */
export interface GenerateContentClient
{
    models: {
        generateContent (params: {
            model: string;
            contents: TutorPrompt['contents'];
            config: Record<string, unknown>;
        }): Promise<GenerateContentResponse>;
    };
}

// ------------------------------------------------------------------ thinking by activity

export type ThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
/** What a Gemini call is for: decides how much the model thinks (latency vs reasoning). */
export type GeminiTask = 'casual' | 'tutoring' | 'complex' | 'minigame' | 'extraction';

/**
 * Backend defaults (never chosen by the student). Casual chat stays fast; multi-step math /
 * science gets a bounded MEDIUM; HIGH is never used by default. Thoughts are never requested.
 */
export const DEFAULT_THINKING: Record<GeminiTask, ThinkingLevel> = {
    casual: 'MINIMAL', tutoring: 'LOW', complex: 'MEDIUM', minigame: 'LOW', extraction: 'LOW',
};

const LEVELS: ThinkingLevel[] = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];

/**
 * Thinking level for a task. `override` is the optional GEMINI_THINKING secret, JSON like
 * {"tutoring":"medium"}; invalid entries are ignored.
 */
export function thinkingFor (task: GeminiTask, override?: string | null): ThinkingLevel
{
    if (override)
    {
        try
        {
            const value = String((JSON.parse(override) as Record<string, unknown>)[task] ?? '').toUpperCase();
            if ((LEVELS as string[]).includes(value)) return value as ThinkingLevel;
        }
        catch { /* bad override: keep the default */ }
    }
    return DEFAULT_THINKING[task];
}

// ------------------------------------------------------------------ errors

export type TutorErrorCode = 'rate_limited' | 'timeout' | 'unavailable' | 'blocked' | 'bad_response' | 'config';

export class TutorModelError extends Error
{
    readonly code: TutorErrorCode;
    readonly retryable: boolean;
    readonly detail: unknown;

    constructor (code: TutorErrorCode, message: string, retryable: boolean, detail?: unknown)
    {
        super(message);
        this.name = 'TutorModelError';
        this.code = code;
        this.retryable = retryable;
        this.detail = detail;
    }

    /** HTTP status the Edge Function returns for this error. */
    get httpStatus ()
    {
        switch (this.code)
        {
            case 'rate_limited': return 429;
            case 'timeout': return 504;
            case 'config': return 500;
            default: return 502;
        }
    }
}

/** Maps SDK / network errors (ApiError has a numeric `status`) to a TutorModelError. */
export function classifyGeminiError (err: unknown): TutorModelError
{
    if (err instanceof TutorModelError) return err;
    const e = err as { name?: string; status?: number; message?: string } | undefined;
    const status = typeof e?.status === 'number' ? e.status : undefined;
    const message = String(e?.message ?? err ?? '');
    if (e?.name === 'AbortError' || /aborted|timed? ?out|deadline/i.test(message))
    {
        return new TutorModelError('timeout', 'The teacher took too long to answer. Please try again.', true, err);
    }
    if (status === 429 || /resource.?exhausted|quota/i.test(message))
    {
        return new TutorModelError('rate_limited', 'The teacher is answering a lot of questions right now. Try again in a minute.', true, err);
    }
    if (status === 401 || status === 403 || /api key/i.test(message))
    {
        return new TutorModelError('config', 'The AI service is not configured correctly.', false, err);
    }
    if (status === 400 || status === 404)
    {
        return new TutorModelError('config', 'The AI service rejected the request (check GEMINI_MODEL).', false, err);
    }
    return new TutorModelError('unavailable', 'The AI teacher is unavailable right now. Please try again.', status === undefined || status >= 500, err);
}

// ------------------------------------------------------------------ structured calls

export interface GenerateOptions
{
    model?: string;
    timeoutMs?: number;
    retries?: number;
    maxOutputTokens?: number;
    /** Thinking effort (thinkingConfig.thinkingLevel). Omitted = the model's default. */
    thinkingLevel?: ThinkingLevel;
    /** Built-in tools, e.g. [{ googleSearch: {} }] or [{ urlContext: {} }]. */
    tools?: Record<string, unknown>[];
    /**
     * Set when the tools are OPTIONAL: if the model rejects the request settings (HTTP 400) the
     * call is retried once without them, with this note appended to the system instruction.
     * Without it the tools are required (answering without them would be wrong).
     */
    toolFallbackNote?: string;
    /** Injected for tests. */
    sleep?: (ms: number) => Promise<void>;
}

export interface StructuredRequest<T>
{
    systemInstruction: string;
    contents: TutorPrompt['contents'];
    /** JSON Schema passed as responseJsonSchema. */
    schema: unknown;
    /** Returns null when the text is not a usable answer (counts as a retryable bad response). */
    parse: (text: string | undefined) => T | null;
}

export interface StructuredResult<T>
{
    output: T;
    metadata: CandidateMetadata;
    /** Settings dropped after the model rejected them. */
    dropped: ('tools' | 'thinking')[];
}

/**
 * One structured (JSON) Gemini call with timeout, a bounded retry for transient errors and
 * unreadable output, and errors mapped to TutorModelError codes. Shared by tutoring, website
 * reading, image reading and mini-game question packs.
 *
 * Unsupported settings degrade gracefully: a 400 while thinking (or optional tools) is set is
 * retried exactly once without them. Never a loop.
 */
export async function generateStructuredResult<T> (client: GenerateContentClient, request: StructuredRequest<T>, options: GenerateOptions = {})
    : Promise<StructuredResult<T>>
{
    const { model = DEFAULT_GEMINI_MODEL, timeoutMs = 25_000, retries = 1, maxOutputTokens = 1200 } = options;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let thinkingLevel = options.thinkingLevel;
    let tools = options.tools?.length ? options.tools : undefined;
    let systemInstruction = request.systemInstruction;
    const dropped: StructuredResult<T>['dropped'] = [];
    let degraded = false;

    for (let attempt = 0; ; attempt++)
    {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try
        {
            const response = await client.models.generateContent({
                model,
                contents: request.contents,
                config: {
                    systemInstruction,
                    responseMimeType: 'application/json',
                    responseJsonSchema: request.schema,
                    maxOutputTokens,
                    ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
                    ...(tools ? { tools } : {}),
                    abortSignal: controller.signal,
                    httpOptions: { timeout: timeoutMs },
                },
            });
            if (response.promptFeedback?.blockReason)
            {
                throw new TutorModelError('blocked', "The teacher can't answer that message. Try asking another way.", false);
            }
            const output = request.parse(response.text);
            if (output === null) throw new TutorModelError('bad_response', 'The teacher gave an unreadable answer. Please try again.', true);
            return { output, metadata: response.candidates?.[0] ?? {}, dropped };
        }
        catch (err)
        {
            const error = classifyGeminiError(controller.signal.aborted ? Object.assign(new Error('aborted'), { name: 'AbortError' }) : err);
            const optionalTools = Boolean(tools && options.toolFallbackNote !== undefined);
            const status = (err as { status?: number } | undefined)?.status;
            // 400: a setting is unsupported. 429 with optional tools: the tool's own quota (Google
            // Search grounding has a separate, smaller one) must not take the whole answer down.
            if (!degraded && ((status === 400 && (thinkingLevel || optionalTools)) || (status === 429 && optionalTools)))
            {
                degraded = true;
                if (status === 400 && thinkingLevel) { thinkingLevel = undefined; dropped.push('thinking'); }
                if (optionalTools)
                {
                    tools = undefined;
                    dropped.push('tools');
                    systemInstruction = `${systemInstruction}\n\n${options.toolFallbackNote}`;
                }
                console.warn('[gemini] request settings rejected; retrying once without', dropped.join(' + '));
                continue;
            }
            if (!error.retryable || attempt >= retries || error.code === 'timeout') throw error;
            // Model overload ("high demand" 503s) needs more than a blink before retrying.
            await sleep((error.code === 'unavailable' ? 1500 : 400) * (attempt + 1));
        }
        finally
        {
            clearTimeout(timer);
        }
    }
}

/** generateStructuredResult, output only. */
export async function generateStructured<T> (client: GenerateContentClient, request: StructuredRequest<T>, options: GenerateOptions = {})
    : Promise<T>
{
    return (await generateStructuredResult(client, request, options)).output;
}

export function generateTutorTurn (client: GenerateContentClient, prompt: TutorPrompt, options: GenerateOptions = {})
    : Promise<StructuredResult<TutorModelOutput>>
{
    return generateStructuredResult(client, {
        systemInstruction: prompt.systemInstruction, contents: prompt.contents, schema: TUTOR_RESPONSE_SCHEMA, parse: parseTutorOutput,
    }, options);
}
