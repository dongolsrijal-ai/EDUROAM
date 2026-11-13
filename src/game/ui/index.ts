// The HTML overlay UI (one shared instance for all scenes). Mounted into #ui in index.html.

import './ui.css';
import { DialogueBox } from './DialogueBox';
import { InventoryPanel } from './InventoryPanel';
import { ItemInteractions } from './itemSlots';
import { NpcManager } from './NpcManager';
import { QuizPanel } from './QuizPanel';
import { DeathScreen, Floaters, Hud, TalkTag, Toasts } from './widgets';

/** What the player is doing; CSS uses it to show/hide HUD pieces. */
export type UiMode = 'play' | 'talk' | 'inventory' | 'dead';

export class Ui
{
    readonly hud: Hud;
    readonly talkTag: TalkTag;
    readonly floaters: Floaters;
    readonly dialogue: DialogueBox;
    readonly quiz: QuizPanel;
    readonly inventory: InventoryPanel;
    readonly death: DeathScreen;
    readonly toasts: Toasts;
    readonly manager: NpcManager;
    readonly items: ItemInteractions;

    constructor (private root: HTMLElement)
    {
        // Order = stacking order (later elements draw on top).
        this.hud = new Hud(root);
        this.talkTag = new TalkTag(root);
        this.floaters = new Floaters(root);
        this.dialogue = new DialogueBox(root);
        this.quiz = new QuizPanel(root);
        this.inventory = new InventoryPanel(root);
        this.death = new DeathScreen(root);
        this.toasts = new Toasts(root);
        this.manager = new NpcManager(root, this.toasts);
        this.items = new ItemInteractions(
            root,
            (ref) => this.inventory.select(ref),
            (message) => this.toasts.show(message, 'error'),
        );
        this.setMode('play');
    }

    setMode (mode: UiMode)
    {
        this.root.dataset.mode = mode;
        if (mode !== 'inventory') this.items.hideTooltip();
    }

    /** Darker, vignetted look for dungeons. */
    setDark (dark: boolean)
    {
        document.getElementById('app')?.classList.toggle('is-dark', dark);
    }
}

let instance: Ui | null = null;

export function getUi (): Ui
{
    if (!instance)
    {
        const root = document.getElementById('ui');
        if (!root) throw new Error('Missing #ui element in index.html');
        instance = new Ui(root);
    }
    return instance;
}
