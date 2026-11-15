// HUD chip for the Pomodoro loop (see state/pomodoro.ts): phase, time left, session number,
// plus a banner when a focus block ends. Ticks once per second in every scene.

import { dungeonMs, focusMs, formatClock, pomodoro, type PomodoroState } from '../state/pomodoro';
import { el } from './dom';
import type { Toasts } from './widgets';

export class PomodoroTimer
{
    private label = el('span', 'pomo__label');
    private time = el('span', 'pomo__time');
    private session = el('span', 'pomo__session');
    readonly chip = el('div', 'chip pomo', el('span', 'pomo__dot'), this.label, this.time, this.session);
    private banner = el('div', 'pomo-banner hidden');
    private lastPhase: PomodoroState['phase'];
    private overtimeShownFor = -1;
    private readonly baseTitle = document.title;

    constructor (parent: HTMLElement, private toasts: Toasts)
    {
        this.chip.setAttribute('role', 'timer');
        this.banner.setAttribute('role', 'status');
        parent.append(this.banner);
        this.lastPhase = pomodoro.state.phase;
        pomodoro.subscribe(() => this.render());
        window.setInterval(() => { pomodoro.tick(); this.render(); }, 1000);
        pomodoro.tick();
        this.render();
    }

    private render ()
    {
        const s = pomodoro.state;
        const left = pomodoro.remaining();
        this.chip.dataset.phase = s.phase;
        this.session.textContent = `Session ${s.session}`;

        if (s.phase === 'focus')
        {
            this.label.textContent = 'Focus';
            this.time.textContent = formatClock(left);
            this.chip.title = `Study time. The tower opens when the ${Math.round(focusMs() / 60000) || '<1'} minute focus block ends.`;
        }
        else if (s.phase === 'ready')
        {
            this.label.textContent = 'Tower open';
            this.time.textContent = '';
            this.chip.title = 'Focus complete! Enter the dungeon in the village.';
        }
        else
        {
            const over = left < 0;
            this.label.textContent = over ? 'Overtime' : 'Dungeon';
            this.time.textContent = `${over ? '+' : ''}${formatClock(left)}`;
            this.chip.title = `${formatClock(dungeonMs())} per run. Finish the run at your own pace; overtime is allowed.`;
            this.chip.dataset.phase = over ? 'overtime' : 'dungeon';
            if (over && this.overtimeShownFor !== s.phaseStartedAt)
            {
                this.overtimeShownFor = s.phaseStartedAt;
                this.toasts.show("Dungeon time is up. No rush: finish the run and your next focus session starts when you're back.");
            }
        }
        this.chip.setAttribute('aria-label', `${this.label.textContent} ${this.time.textContent}, session ${s.session}`);
        document.title = s.phase === 'ready' ? `Tower open! · ${this.baseTitle}` : this.baseTitle;

        if (s.phase !== this.lastPhase)
        {
            const from = this.lastPhase;
            this.lastPhase = s.phase;
            if (from === 'focus' && s.phase === 'ready') this.announce('Focus complete!', `Session ${s.session} studied. The tower is open: head to the dungeon entrance.`);
            if (s.phase === 'focus' && from !== 'focus') this.announce(`Session ${s.session}`, `Time to focus: ${formatClock(focusMs())} of study before the next climb.`);
        }
    }

    private announce (title: string, text: string)
    {
        this.banner.replaceChildren(el('div', 'pomo-banner__title', title), el('div', 'pomo-banner__text', text));
        this.banner.classList.remove('hidden');
        window.setTimeout(() => this.banner.classList.add('hidden'), 4500);
    }
}
