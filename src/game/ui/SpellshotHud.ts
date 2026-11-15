// HTML overlay for Spellshot (crisp text over the pixel-art clearing): prompt card with the
// round clock, answer labels that ride on the floating wisps (real buttons: click, tap or
// keys 1-5), score pop-ups, pause and results. The Phaser scene (minigames/spellshot) owns
// timing and motion and drives this class.

import { TARGET_MARKS } from '../minigames/spellshot/spellshotLogic';
import { el, gameButton, keyHints, type Modal } from './dom';

export interface ShotHudHandlers
{
    onShoot (target: number): void;
    onPause (): void;
    onResume (): void;
    onExit (): void;
    onPlayAgain (): void;
}

export interface ShotReviewItem
{
    prompt: string;
    answer: string;
    explanation: string;
}

export class SpellshotHud implements Modal
{
    private root: HTMLElement;
    private clockEl = el('span', 'shot__clock');
    private counter = el('span', 'dash__counter');
    private score = el('span', 'dash__score');
    private streak = el('span', 'dash__streak');
    private timeFill = el('span', 'progress__fill');
    private topic = el('span', 'tag tag--muted');
    private prompt = el('p', 'shot__prompt');
    private source = el('span', 'dash__source');
    private card: HTMLElement;
    private targets = el('div', 'shot__targets');
    private targetEls: HTMLButtonElement[] = [];
    private banner = el('div', 'shot__banner hidden');
    private status = el('div', 'dash__status panel hidden');
    private pauseEl = el('section', 'dash__overlay panel hidden');
    private resultsEl = el('section', 'dash__overlay shot__results panel hidden');
    private handlers: ShotHudHandlers | null = null;

    constructor (parent: HTMLElement)
    {
        for (let i = 0; i < TARGET_MARKS.length; i++)
        {
            const target = gameButton('shot__target', () => this.handlers?.onShoot(i));
            target.dataset.target = String(i);
            this.targetEls.push(target);
        }
        this.targets.append(...this.targetEls);
        this.prompt.setAttribute('aria-live', 'polite');
        this.banner.setAttribute('aria-live', 'assertive');
        this.card = el('section', 'dash__card shot__card panel',
            el('div', 'dash__meta', this.clockEl, this.counter, this.topic, el('span', 'dash__spacer'), this.streak, this.score,
                gameButton('btn btn--small', () => this.handlers?.onPause(), 'Pause')),
            el('span', 'progress dash__progress shot__time', this.timeFill),
            this.prompt, this.source);
        this.root = el('div', 'shot hidden', this.card, this.targets, this.banner, this.status, this.pauseEl, this.resultsEl,
            el('div', 'dash__keys', keyHints([['Click / 1-5', 'cast'], ['Esc', 'pause']])));
        this.root.setAttribute('role', 'application');
        this.root.setAttribute('aria-label', 'Spellshot');
        parent.append(this.root);
    }

    open (handlers: ShotHudHandlers)
    {
        this.handlers = handlers;
        this.root.classList.remove('hidden');
        [this.banner, this.status, this.pauseEl, this.resultsEl].forEach((e) => e.classList.add('hidden'));
        this.targets.classList.remove('hidden');
        this.setTargets([]);
    }

    close ()
    {
        this.handlers = null;
        this.root.classList.add('hidden');
    }

    handleKey (key: string)
    {
        if (key === 'escape') this.handlers?.onPause();
    }

    /** Screen rectangle of the overlay (target labels are positioned inside it). */
    rect ()
    {
        return this.root.getBoundingClientRect();
    }

    /** Bottom of the prompt card in overlay CSS pixels (wisps fly below it). */
    cardBottom ()
    {
        return this.card.getBoundingClientRect().bottom - this.root.getBoundingClientRect().top;
    }

    setClock (remainingMs: number, totalMs: number, text: string)
    {
        this.clockEl.textContent = `⏳ ${text}`;
        this.clockEl.classList.toggle('is-low', remainingMs <= 10_000);
        this.timeFill.style.width = `${Math.max(0, Math.min(100, (remainingMs / totalMs) * 100))}%`;
    }

    setPrompt (text: string, index: number, total: number, topic: string, sourceTitle: string | null)
    {
        this.prompt.textContent = text;
        this.counter.textContent = `Prompt ${index + 1} / ${total}`;
        this.topic.textContent = topic;
        this.source.textContent = sourceTitle ? `From: ${sourceTitle}` : '';
    }

    /** One label per wisp for this prompt (the rest are hidden). */
    setTargets (choices: string[])
    {
        this.targetEls.forEach((target, i) =>
        {
            const text = choices[i];
            target.classList.remove('is-correct', 'is-wrong', 'is-spent');
            target.classList.toggle('hidden', text === undefined);
            target.disabled = false;
            target.replaceChildren(el('span', 'shot__mark', TARGET_MARKS[i]), el('span', 'shot__text', text ?? ''));
            target.setAttribute('aria-label', text === undefined ? '' : `Cast at ${i + 1}: ${text}`);
        });
    }

    /** Places the labels on the wisps (CSS pixels, from the scene camera). */
    placeTargets (points: { x: number; y: number; visible: boolean }[], maxWidth: number)
    {
        this.targets.style.setProperty('--shot-label-w', `${Math.round(maxWidth)}px`);
        this.targetEls.forEach((target, i) =>
        {
            const p = points[i];
            if (!p) return;
            target.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -50%)`;
            target.style.visibility = p.visible ? 'visible' : 'hidden';
        });
    }

    /** Marks the shot result on the labels; all targets stop accepting shots. */
    markShot (chosen: number, correct: number)
    {
        this.targetEls.forEach((t) => { t.disabled = true; });
        this.targetEls[correct]?.classList.add('is-correct');
        if (chosen !== correct) this.targetEls[chosen]?.classList.add('is-wrong');
    }

    /** Disables every target (shot in flight). */
    lockTargets ()
    {
        this.targetEls.forEach((t) => { t.disabled = true; });
    }

    setStats (score: number, streak: number)
    {
        this.score.textContent = `★ ${score}`;
        this.streak.textContent = streak > 1 ? `Combo ×${streak}` : '';
    }

    /** Short centre banner ("Ready…", "+140", "Answer: …"); empty text hides it. */
    showBanner (text: string, tone: 'info' | 'good' | 'bad' = 'info')
    {
        this.banner.textContent = text;
        this.banner.dataset.tone = tone;
        this.banner.classList.toggle('hidden', !text);
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
            el('p', '', 'The clock is stopped. Your score in this round is kept.'),
            el('div', 'form-actions',
                gameButton('btn', () => this.handlers?.onExit(), 'Exit to teacher'),
                gameButton('btn btn--primary', () => this.handlers?.onResume(), 'Resume')));
        this.pauseEl.classList.toggle('hidden', !paused);
    }

    showResults (lines: { title: string; stats: [string, string][]; notes: string[] }, review: ShotReviewItem[])
    {
        this.targets.classList.add('hidden');
        this.banner.classList.add('hidden');
        const reviewEl = review.length
            ? el('details', 'shot__review',
                el('summary', '', `Review ${review.length} missed prompt${review.length === 1 ? '' : 's'}`),
                el('ul', '', ...review.map((r) => el('li', '',
                    el('strong', '', r.prompt), el('span', 'shot__answer', `→ ${r.answer}`), el('span', 'shot__why', r.explanation)))))
            : null;
        this.resultsEl.replaceChildren(
            el('h2', '', lines.title),
            el('dl', 'dash__stats', ...lines.stats.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)])),
            ...lines.notes.map((n) => el('p', 'dash__note', n)),
            ...(reviewEl ? [reviewEl] : []),
            el('div', 'form-actions',
                gameButton('btn', () => this.handlers?.onExit(), 'Return to NPC'),
                gameButton('btn btn--primary', () => this.handlers?.onPlayAgain(), 'Play Again')));
        this.resultsEl.classList.remove('hidden');
    }
}
