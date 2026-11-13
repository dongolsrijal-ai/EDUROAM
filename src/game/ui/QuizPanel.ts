// Compact multiple-choice quiz card: question -> feedback + explanation -> ... -> results.
// Works with any Challenge (see minigames/challenge.ts).

import type { Challenge } from '../minigames/challenge';
import { el, gameButton, isConfirm, isDown, isUp, keyHints, type Modal } from './dom';

/** Called with the final score, or null if the player quit with Escape. */
type OnDone = (score: number | null) => void;

export class QuizPanel implements Modal
{
    private root: HTMLElement;
    private title = el('div', 'quiz__title');
    private scoreEl = el('div', 'quiz__score');
    private dots = el('div', 'dots');
    private body = el('div');
    private hint = el('div');
    private next: HTMLButtonElement;

    private challenge!: Challenge;
    private rewardAvailable = false;
    private phase: 'answer' | 'feedback' | 'summary' = 'answer';
    private qIndex = 0;
    private selected = 0;
    private results: boolean[] = [];
    private optionButtons: HTMLButtonElement[] = [];
    private onDone: OnDone | null = null;

    constructor (parent: HTMLElement)
    {
        this.next = gameButton('btn btn--primary', () => this.handleKey('enter'), 'Next');
        this.root = el('section', 'quiz panel hidden',
            el('div', 'quiz__head', this.title, this.scoreEl),
            this.dots,
            this.body,
            el('div', 'quiz__foot', this.hint, this.next));
        this.root.setAttribute('role', 'dialog');
        this.root.setAttribute('aria-label', 'Challenge');
        parent.append(this.root);
    }

    /** rewardAvailable only changes the results text; the scene decides whether to grant the reward. */
    open (challenge: Challenge, rewardAvailable: boolean, onDone: OnDone)
    {
        this.challenge = challenge;
        this.rewardAvailable = rewardAvailable;
        this.onDone = onDone;
        this.phase = 'answer';
        this.qIndex = 0;
        this.selected = 0;
        this.results = [];
        this.title.textContent = challenge.title;
        this.root.classList.remove('hidden');
        this.render();
    }

    handleKey (key: string)
    {
        if (key === 'escape') return this.close(null);

        if (this.phase === 'answer')
        {
            const digit = Number(key);
            if (isUp(key)) this.select((this.selected + 3) % 4);
            else if (isDown(key)) this.select((this.selected + 1) % 4);
            else if (digit >= 1 && digit <= 4) this.submit(digit - 1);
            else if (isConfirm(key)) this.submit(this.selected);
            return;
        }

        if (!isConfirm(key)) return;
        if (this.phase === 'summary') return this.close(this.score());

        this.qIndex++;
        this.selected = 0;
        this.phase = this.qIndex < this.challenge.questions.length ? 'answer' : 'summary';
        this.render();
    }

    private score ()
    {
        return this.results.filter(Boolean).length;
    }

    private submit (choice: number)
    {
        this.selected = choice;
        this.results.push(choice === this.challenge.questions[this.qIndex].answer);
        this.phase = 'feedback';
        this.render();
    }

    private select (index: number)
    {
        this.selected = index;
        this.optionButtons.forEach((b, i) => b.classList.toggle('is-selected', i === index));
    }

    private render ()
    {
        const { questions, passScore, reward } = this.challenge;
        const total = questions.length;

        this.scoreEl.textContent = `Score ${this.score()}/${total}`;
        this.dots.replaceChildren(...questions.map((_, i) =>
        {
            const state = i < this.results.length ? (this.results[i] ? 'is-right' : 'is-wrong') : i === this.qIndex ? 'is-current' : '';
            return el('span', `dot ${state}`);
        }));

        if (this.phase === 'summary')
        {
            const passed = this.score() >= passScore;
            const rewardLine = !passed
                ? el('p', '', `You need ${passScore} correct answers to win. Try again soon!`)
                : this.rewardAvailable
                    ? el('p', 'reward', `+${reward.amount} ${reward.label}`)
                    : el('p', '', 'Reward already claimed. Great practice!');
            this.body.replaceChildren(el('div', 'summary',
                el('div', `summary__title ${passed ? 'is-right' : 'is-wrong'}`, passed ? 'Challenge Complete!' : 'Challenge Failed'),
                el('p', '', `You answered ${this.score()} of ${total} correctly.`),
                rewardLine));
            this.optionButtons = [];
            this.next.textContent = 'Continue';
            this.next.classList.remove('hidden');
            this.hint.replaceChildren(keyHints([['E', 'continue']]));
            return;
        }

        const q = questions[this.qIndex];
        const answered = this.phase === 'feedback';

        this.optionButtons = q.options.map((option, i) =>
        {
            const button = gameButton('option', () => { if (this.phase === 'answer') this.submit(i); },
                el('span', 'key', String(i + 1)), option);
            if (answered)
            {
                button.disabled = true;
                if (i === q.answer) button.classList.add('is-right');
                else if (i === this.selected) button.classList.add('is-wrong');
            }
            else
            {
                button.addEventListener('mouseenter', () => this.select(i));
            }
            return button;
        });

        const children: Node[] = [el('div', 'quiz__question', q.prompt), el('div', 'options', ...this.optionButtons)];
        if (answered)
        {
            const correct = this.results[this.qIndex];
            children.push(el('div', `feedback ${correct ? 'is-right' : 'is-wrong'}`,
                el('strong', '', correct ? 'Correct!' : `Not quite. The answer is ${q.options[q.answer]}.`),
                el('span', '', q.explanation)));
        }
        this.body.replaceChildren(...children);
        if (!answered) this.select(this.selected);

        this.next.textContent = this.qIndex === total - 1 ? 'See results' : 'Next';
        this.next.classList.toggle('hidden', !answered);
        this.hint.replaceChildren(answered
            ? keyHints([['E', 'next'], ['Esc', 'quit']])
            : keyHints([['1-4', 'answer'], ['Esc', 'quit']]));
    }

    private close (score: number | null)
    {
        this.root.classList.add('hidden');
        const done = this.onDone;
        this.onDone = null;
        done?.(score);
    }
}
