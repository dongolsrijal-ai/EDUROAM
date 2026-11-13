// Compact dialogue panel: portrait, name + subject, text, optional choices on the last line.

import { el, gameButton, isConfirm, isDown, isUp, keyHints, type Modal } from './dom';

export interface Speaker
{
    name: string;
    subtitle?: string;
    portrait?: string;
}

/** Called with the chosen option index, or null if closed without choosing. */
type OnDone = (choice: number | null) => void;

export class DialogueBox implements Modal
{
    private root: HTMLElement;
    private portrait = el('img', 'portrait');
    private name = el('span', 'dialogue__name');
    private subject = el('span', 'tag');
    private text = el('p', 'dialogue__text');
    private choicesEl = el('div', 'choices');
    private hint = el('div');

    private lines: string[] = [];
    private index = 0;
    private choices: string[] = [];
    private choiceButtons: HTMLButtonElement[] = [];
    private selected = 0;
    private onDone: OnDone | null = null;

    constructor (parent: HTMLElement)
    {
        this.portrait.alt = '';
        this.text.setAttribute('aria-live', 'polite');
        this.root = el('section', 'dialogue panel hidden',
            this.portrait,
            el('div', '', el('div', 'dialogue__header', this.name, this.subject), this.text, this.choicesEl, this.hint));
        this.root.setAttribute('role', 'dialog');
        this.root.setAttribute('aria-label', 'Conversation');
        parent.append(this.root);
    }

    open (speaker: Speaker, lines: string[], choices: string[], onDone: OnDone)
    {
        this.lines = lines.length ? lines : ['...'];
        this.choices = choices;
        this.index = 0;
        this.selected = 0;
        this.onDone = onDone;

        this.name.textContent = speaker.name;
        this.subject.textContent = speaker.subtitle ?? '';
        this.subject.classList.toggle('hidden', !speaker.subtitle);
        this.portrait.classList.toggle('hidden', !speaker.portrait);
        if (speaker.portrait) this.portrait.src = speaker.portrait;

        this.root.classList.remove('hidden');
        this.render();
    }

    handleKey (key: string)
    {
        if (key === 'escape') return this.close(null);

        if (this.showingChoices())
        {
            const n = this.choices.length;
            const digit = Number(key);
            if (isUp(key)) this.select((this.selected + n - 1) % n);
            else if (isDown(key)) this.select((this.selected + 1) % n);
            else if (digit >= 1 && digit <= n) this.close(digit - 1);
            else if (isConfirm(key)) this.close(this.selected);
            return;
        }

        if (isConfirm(key)) this.advance();
    }

    private advance ()
    {
        if (this.index < this.lines.length - 1)
        {
            this.index++;
            this.render();
        }
        else
        {
            this.close(null);
        }
    }

    private showingChoices ()
    {
        return this.choices.length > 0 && this.index === this.lines.length - 1;
    }

    private render ()
    {
        this.text.textContent = this.lines[this.index];

        const showChoices = this.showingChoices();
        this.choiceButtons = showChoices
            ? this.choices.map((label, i) => gameButton('choice', () => this.close(i), el('span', 'key', String(i + 1)), label))
            : [];
        this.choiceButtons.forEach((button, i) => button.addEventListener('mouseenter', () => this.select(i)));
        this.choicesEl.replaceChildren(...this.choiceButtons);
        this.choicesEl.classList.toggle('hidden', !showChoices);
        this.select(this.selected);

        this.hint.replaceChildren(showChoices
            ? keyHints([['1-' + this.choices.length, 'choose'], ['Esc', 'close']])
            : keyHints([['E', this.index < this.lines.length - 1 ? 'next' : 'close'], ['Esc', 'close']]));
    }

    private select (index: number)
    {
        this.selected = index;
        this.choiceButtons.forEach((button, i) => button.classList.toggle('is-selected', i === index));
    }

    private close (choice: number | null)
    {
        this.root.classList.add('hidden');
        const done = this.onDone;
        this.onDone = null;
        done?.(choice);
    }
}
