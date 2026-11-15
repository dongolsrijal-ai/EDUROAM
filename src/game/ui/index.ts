// The HTML overlay UI (one shared instance for all scenes). Mounted into #ui in index.html.

import './ui.css';
import { DEV } from '../dev/devFlags';
import { DialogueBox } from './DialogueBox';
import { InventoryPanel } from './InventoryPanel';
import { ItemInteractions } from './itemSlots';
import { NpcManager } from './NpcManager';
import { AccountPanel } from './AccountPanel';
import { PomodoroTimer } from './PomodoroTimer';
import { QuizPanel } from './QuizPanel';
import { TutorPanel } from './TutorPanel';
import { VoicePanel } from './VoicePanel';
import { MinigamePanel } from './MinigamePanel';
import { CourseworkLibrary } from './CourseworkLibrary';
import { AnswerDashHud } from './AnswerDashHud';
import { SpellshotHud } from './SpellshotHud';
import { ShopPanel } from './ShopPanel';
import { initBackend } from '../services/backend';
import { BossBar, DeathScreen, Floaters, Hud, TalkTag, Toasts } from './widgets';

/** What the player is doing; CSS uses it to show/hide HUD pieces. */
export type UiMode = 'play' | 'talk' | 'inventory' | 'dead' | 'minigame';

export class Ui
{
    readonly hud: Hud;
    readonly talkTag: TalkTag;
    readonly floaters: Floaters;
    readonly bossBar: BossBar;
    readonly dialogue: DialogueBox;
    readonly quiz: QuizPanel;
    readonly tutor: TutorPanel;
    readonly voice: VoicePanel;
    readonly minigames: MinigamePanel;
    readonly library: CourseworkLibrary;
    readonly dash: AnswerDashHud;
    readonly shot: SpellshotHud;
    readonly inventory: InventoryPanel;
    readonly shop: ShopPanel;
    readonly death: DeathScreen;
    readonly toasts: Toasts;
    readonly manager: NpcManager;
    readonly account: AccountPanel;
    readonly items: ItemInteractions;
    readonly pomodoro: PomodoroTimer;

    constructor (private root: HTMLElement)
    {
        // Order = stacking order (later elements draw on top).
        this.hud = new Hud(root);
        this.talkTag = new TalkTag(root);
        this.floaters = new Floaters(root);
        this.bossBar = new BossBar(root);
        this.dialogue = new DialogueBox(root);
        this.quiz = new QuizPanel(root);
        this.tutor = new TutorPanel(root);
        this.voice = new VoicePanel(root);
        this.library = new CourseworkLibrary(root);
        this.minigames = new MinigamePanel(root, this.library);
        this.tutor.library = this.library;
        this.dash = new AnswerDashHud(root);
        this.shot = new SpellshotHud(root);
        this.inventory = new InventoryPanel(root);
        this.shop = new ShopPanel(root);
        this.death = new DeathScreen(root);
        this.toasts = new Toasts(root);
        this.pomodoro = new PomodoroTimer(root, this.toasts);
        this.hud.addChip(this.pomodoro.chip);
        this.manager = new NpcManager(root, this.toasts);
        this.manager.library = this.library;
        this.account = new AccountPanel(this.toasts);
        this.manager.mountAccount(this.account.button, this.account.panel);
        this.manager.beforeDelete = async (npcId) => { await this.voice.endForNpc(npcId); };
        this.items = new ItemInteractions(
            root,
            (ref) => this.inventory.select(ref),
            (message) => this.toasts.show(message, 'error'),
        );
        this.setMode('play');
        // Restore a saved session; if this page was opened by an auth redirect (old email link,
        // future OAuth) the same game simply continues from its local save.
        void initBackend().then((result) =>
        {
            if (!result?.fromRedirect) return;
            if (result.redirectError) this.toasts.show(`Sign-in link failed: ${result.redirectError}. Use the email code instead.`, 'error');
            else if (result.signedIn) this.toasts.show('Signed in! If EDUROAM is open in another tab, it is signed in too; you can close one.');
        }).catch((err) => console.warn('[ui] Auth initialisation failed.', err));
        // Dev test mode: the dynamic import keeps the panel out of production builds entirely.
        if (DEV) void import('./DevPanel').then(({ DevPanel }) => new DevPanel(root, this.toasts));
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
