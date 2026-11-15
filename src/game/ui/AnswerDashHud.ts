// HTML overlay for Answer Dash (crisp text over the pixel-art track): question card, answer
// labels that ride on the approaching gates, feedback, pause, results and touch controls.
// The Phaser scene (minigames/answerDash) owns timing and lanes and drives this class.

import { el, gameButton, keyHints, type Modal } from './dom';

/** Lane markers: number + shape, so answers never rely on colour alone. */
export const LANE_MARKS = ['1 ◆', '2 ●', '3 ▲', '4 ★'];

export interface DashHudHandlers
{
    onLane (lane: number): void;
    onMove (step: -1 | 1): void;
    onContinue (): void;
    onPause (): void;
    onResume (): void;
    onExit (): void;
    onPlayAgain (): void;
}

export interface DashFeedback
{
    correct: boolean;
    points: number;
    correctText: string;
    explanation: string;
}

export class AnswerDashHud implements Modal
{
    private root: HTMLElement;
    private counter = el('span', 'dash__counter');
    private score = el('span', 'dash__score');
    private streak = el('span', 'dash__streak');
    private progress = el('span', 'progress__fill');
    private topic = el('span', 'tag tag--muted');
    private question = el('p', 'dash__question');
    private source = el('span', 'dash__source');
    private figure = el('button', 'dash__figure hidden');
    private figureImg = el('img');
    private lightbox = el('div', 'dash__lightbox hidden');
    private lanes = el('div', 'dash__lanes');
    private laneEls: HTMLButtonElement[] = [];
    private feedbackEl = el('section', 'dash__feedback panel hidden');
    private status = el('div', 'dash__status panel hidden');
    private pauseEl = el('section', 'dash__overlay panel hidden');
    private resultsEl = el('section', 'dash__overlay dash__results panel hidden');
    private handlers: DashHudHandlers | null = null;

    constructor (parent: HTMLElement)
    {
        for (let i = 0; i < 4; i++)
        {
            const lane = gameButton('dash__lane', () => this.handlers?.onLane(i));
            lane.dataset.lane = String(i);
            this.laneEls.push(lane);
        }
        this.lanes.append(...this.laneEls);
        this.question.setAttribute('aria-live', 'polite');
        this.feedbackEl.setAttribute('aria-live', 'assertive');

        const card = el('section', 'dash__card panel',
            el('div', 'dash__meta', this.counter, this.topic, el('span', 'dash__spacer'), this.streak, this.score,
                gameButton('btn btn--small', () => this.handlers?.onPause(), 'Pause')),
            el('span', 'progress dash__progress', this.progress),
            this.question, this.figure, this.source);
        const touch = el('div', 'dash__touch',
            gameButton('btn dash__arrow', () => this.handlers?.onMove(-1), '◀'),
            gameButton('btn dash__arrow', () => this.handlers?.onMove(1), '▶'));

        // Figures: shown when a question needs an uploaded image; click to enlarge.
        this.figure.type = 'button';
        this.figure.append(this.figureImg);
        this.figure.title = 'Enlarge figure';
        this.figure.addEventListener('click', () => this.lightbox.classList.remove('hidden'));
        this.lightbox.addEventListener('click', () => this.lightbox.classList.add('hidden'));
        this.root = el('div', 'dash hidden', card, this.lightbox, this.lanes, this.feedbackEl, this.status, this.pauseEl, this.resultsEl, touch,
            el('div', 'dash__keys', keyHints([['A/D', 'lane'], ['1-4', 'pick'], ['Esc', 'pause']])));
        this.root.setAttribute('role', 'application');
        this.root.setAttribute('aria-label', 'Answer Dash');
        parent.append(this.root);
    }

    open (handlers: DashHudHandlers)
    {
        this.handlers = handlers;
        this.root.classList.remove('hidden');
        [this.feedbackEl, this.status, this.pauseEl, this.resultsEl].forEach((e) => e.classList.add('hidden'));
    }

    close ()
    {
        this.handlers = null;
        this.root.classList.add('hidden');
    }

    /** Screen rectangle of the overlay (lane labels are positioned inside it). */
    rect ()
    {
        return this.root.getBoundingClientRect();
    }

    handleKey (key: string)
    {
        if (key === 'escape') this.handlers?.onPause();
    }

    setQuestion (text: string, index: number, total: number, topic: string, sourceTitle: string | null, figure: { url: string | null; title: string } | null = null)
    {
        const url = figure?.url ?? null;
        this.figure.classList.toggle('hidden', !url);
        this.lightbox.classList.add('hidden');
        if (url)
        {
            this.figureImg.src = url;
            this.figureImg.alt = `Figure from ${figure!.title}`;
            const big = el('img');
            big.src = url;
            big.alt = this.figureImg.alt;
            this.lightbox.replaceChildren(big, el('span', 'field__hint', 'Click to close'));
        }
        this.question.textContent = text;
        this.counter.textContent = `Question ${index + 1} / ${total}`;
        this.progress.style.width = `${Math.round((index / total) * 100)}%`;
        this.topic.textContent = topic;
        this.source.textContent = sourceTitle ? `From: ${sourceTitle}` : 'Subject practice';
        this.feedbackEl.classList.add('hidden');
        this.laneEls.forEach((lane) => lane.classList.remove('is-correct', 'is-wrong'));
    }

    setChoices (choices: string[])
    {
        this.laneEls.forEach((lane, i) => lane.replaceChildren(el('span', 'dash__mark', LANE_MARKS[i]), el('span', 'dash__choice', choices[i] ?? '')));
    }

    setStats (score: number, streak: number)
    {
        this.score.textContent = `★ ${score}`;
        this.streak.textContent = streak > 1 ? `Streak ×${streak}` : '';
    }

    select (lane: number)
    {
        this.laneEls.forEach((el, i) => { el.classList.toggle('is-selected', i === lane); el.setAttribute('aria-pressed', String(i === lane)); });
    }

    /** Places the answer labels on the gate row (CSS pixels, from the scene camera). */
    placeLanes (centerXs: number[], width: number, y: number, visible: boolean)
    {
        this.lanes.classList.toggle('hidden', !visible);
        this.lanes.style.transform = `translateY(${Math.round(y)}px)`;
        this.laneEls.forEach((lane, i) =>
        {
            lane.style.left = `${Math.round(centerXs[i] - width / 2)}px`;
            lane.style.width = `${Math.round(width)}px`;
        });
    }

    showFeedback (feedback: DashFeedback, chosenLane: number, correctLane: number)
    {
        this.laneEls[correctLane]?.classList.add('is-correct');
        if (!feedback.correct) this.laneEls[chosenLane]?.classList.add('is-wrong');
        this.feedbackEl.classList.toggle('is-correct', feedback.correct);
        this.feedbackEl.replaceChildren(
            el('strong', 'dash__verdict', feedback.correct ? `Correct! +${feedback.points}` : `Not quite: the answer was ${LANE_MARKS[correctLane]} "${feedback.correctText}"`),
            el('p', '', feedback.explanation),
            gameButton('btn btn--primary btn--small', () => this.handlers?.onContinue(), 'Continue'),
            keyHints([['Space', 'continue']]));
        this.feedbackEl.classList.remove('hidden');
    }

    hideFeedback ()
    {
        this.feedbackEl.classList.add('hidden');
    }

    setStatus (text: string, retry?: () => void)
    {
        this.status.replaceChildren(el('span', '', text), ...(retry ? [gameButton('btn btn--small', retry, 'Retry')] : []));
        this.status.classList.toggle('is-error', Boolean(retry));
        this.status.classList.toggle('hidden', !text);
    }

    setPaused (paused: boolean)
    {
        this.pauseEl.replaceChildren(
            el('h2', '', 'Paused'),
            el('p', '', 'Your progress in this run is kept while paused.'),
            el('div', 'form-actions',
                gameButton('btn', () => this.handlers?.onExit(), 'Exit to teacher'),
                gameButton('btn btn--primary', () => this.handlers?.onResume(), 'Resume')));
        this.pauseEl.classList.toggle('hidden', !paused);
    }

    showResults (lines: { title: string; stats: [string, string][]; notes: string[] })
    {
        this.feedbackEl.classList.add('hidden');
        this.lanes.classList.add('hidden');
        this.resultsEl.replaceChildren(
            el('h2', '', lines.title),
            el('dl', 'dash__stats', ...lines.stats.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)])),
            ...lines.notes.map((n) => el('p', 'dash__note', n)),
            el('div', 'form-actions',
                gameButton('btn', () => this.handlers?.onExit(), 'Return to NPC'),
                gameButton('btn btn--primary', () => this.handlers?.onPlayAgain(), 'Play Again')));
        this.resultsEl.classList.remove('hidden');
    }
}
