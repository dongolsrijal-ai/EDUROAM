// Browser test phase for the NPC menu + Answer Dash + Spellshot (run from auth.ts with ?phase=dash, signed in).
import { DASH_KEY, DASH_QUESTIONS, log, SHOT_KEY } from './authStub';

function press (scope: string, label: string)
{
    const selector = /(^|\s)button$/.test(scope) ? scope : `${scope} button`;
    const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((b) => b.textContent === label);
    if (!button) throw new Error(`No "${label}" button in ${scope}: ${[...document.querySelectorAll(selector)].map((b) => b.textContent).join(' | ')}`);
    button.click();
}

const boxes = () => [...document.querySelectorAll<HTMLInputElement>('.mg-source input')];

export interface PhaseKit
{
    game: any;
    scene: any;
    npc: any;
    ui: any;
    until (predicate: () => unknown, label: string): Promise<void>;
    check (value: unknown, message: string): asserts value;
    setFrameMs (ms: number): void;
}

const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
const text = (s: string) => document.querySelector(s)?.textContent ?? '';
const visible = (s: string) => { const n = q(s); return Boolean(n && n.offsetParent !== null); };
const all = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const key = (k: string) =>
{
    const init = { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init)); // real keys always come with a key-up
};

export async function runDashPhase (kit: PhaseKit)
{
    const { game, scene, npc, ui, until, check, setFrameMs } = kit;
    const before = { x: scene.player.x, y: scene.player.y };
    const selectedLane = () => all('.dash__lane').findIndex((l) => l.classList.contains('is-selected'));

    // 1. NPC editor has no Mini-game dropdown any more.
    press('button', '+ Add NPC');
    await until(() => visible('.npc-form'), 'NPC form');
    check(!all('.npc-form .field__label').some((l) => /mini-game/i.test(l.textContent ?? '')), 'no Mini-game field in the NPC form');
    check(all('.npc-form select').length === 0, 'no select in the NPC form');
    press('.npc-form button', 'Cancel');

    // 2. Dialogue offers exactly Chat & Study, Mini-games, Goodbye (in that order).
    const openDialogue = async () =>
    {
        scene.talkTo(scene.npcs.find((n: any) => n.record.id === npc.record.id));
        await until(() => visible('.dialogue'), 'dialogue');
        for (let i = 0; i < 10 && !all('.choice').length; i++) ui.dialogue.handleKey('e');
        await until(() => all('.choice').length > 0, 'choices');
    };
    await openDialogue();
    const labels = all('.choice').map((c) => c.textContent?.replace(/^\d/, '').trim());
    check(JSON.stringify(labels) === JSON.stringify(['Chat & Study', 'FaceTime Tutor', 'Mini-games', 'Goodbye']), `choices: ${JSON.stringify(labels)}`);
    // FaceTime Tutor: the browser sends only the NPC request (no player id); the server decides.
    // Starting a call only LOOKS UP the NPC: it never inserts / upserts one.
    const npcWritesBefore = log.npcWrites;
    all('.choice')[1].click();
    await until(() => visible('.voice') && visible('.voice__choose'), 'call panel offers in-game and FaceTime calls');
    check(log.voiceStarts.length === 0, 'opening the panel starts nothing');
    const voiceButton = (label: string) => (all('.voice button') as HTMLButtonElement[]).find((b) => b.textContent === label && b.offsetParent !== null)!;
    voiceButton('Call in game').click();
    await until(() => /not set up/.test(text('.voice__status')) && visible('.voice__choose'), 'in-game call shows the server answer, choices come back');
    check(log.voiceStarts.length === 1 && JSON.stringify(Object.keys(log.voiceStarts[0]).sort()) === JSON.stringify(['action', 'npc_id']), `voice request body: ${JSON.stringify(log.voiceStarts)}`);
    // The shared Chert line: no address configured -> a clear error, never a made-up number.
    voiceButton('Call on FaceTime').click();
    await until(() => /FaceTime line is not set up/.test(text('.voice__status')), 'FaceTime not configured explained');
    check(!document.querySelector('.voice__line'), 'no line address shown when none is configured');
    localStorage.setItem('stub.facetimeLine', 'tutor-line@example.org');
    voiceButton('Call on FaceTime').click();
    await until(() => visible('.voice__code'), 'FaceTime code shown');
    check(text('.voice__code') === '482 913' && text('.voice__line') === 'tutor-line@example.org', 'the server code and the configured line');
    await until(() => /Code expires in [45]:\d\d/.test(text('.voice__facetime')), 'code countdown');
    check(JSON.stringify(log.voiceStarts[2]) === JSON.stringify({ action: 'start', npc_id: log.voiceStarts[0].npc_id, mode: 'facetime' }), `facetime request: ${JSON.stringify(log.voiceStarts[2])}`);
    localStorage.removeItem('stub.facetimeLine');
    check(log.npcWrites === npcWritesBefore, `starting a call wrote to npcs ${log.npcWrites - npcWritesBefore} time(s)`);
    ui.voice.handleKey('escape');
    await until(() => !visible('.voice'), 'Esc ends the call panel');
    check(scene.inputEnabled === true, 'game input restored after the call panel');
    await openDialogue();
    // 3. No coursework: no general practice, a clear explanation and Add Coursework -> paste notes.
    localStorage.setItem('stub.noDocs', '1');
    all('.choice')[2].click();
    await until(() => visible('.mg') && all('.mg button').some((b) => b.textContent === 'Add Coursework'), 'picker explains coursework is required');
    check(/only asks questions from .* class materials/.test(q('.mg .mg-card__note')?.textContent ?? ''), 'explains materials are required');
    check(!/general|subject practice/i.test(q('.mg')?.textContent ?? ''), 'no general-practice option anywhere');
    check(!all('.mg button').some((b) => b.textContent === 'Start') && all('.mg button').some((b) => b.textContent === 'Add Coursework'), `no Start, Add Coursework shown: ${q('.mg')?.textContent}`);
    press('.mg button', 'Add Coursework');
    await until(() => visible('.library'), 'Coursework Library opens');
    press('.library button', 'Paste Text');
    (q<HTMLInputElement>('.library__paste input')!).value = 'Lecture 2: Linear equations';
    (q<HTMLTextAreaElement>('.library__paste textarea')!).value = 'To solve 3x + 2 = 11, subtract 2 then divide by 3. A linear equation has one variable to the first power.';
    press('.library__paste button', 'Save to Coursework');
    await until(() => log.pastes.length === 1 && /saved/.test(q('.library .tutor__status')?.textContent ?? ''), 'pasted notes saved');
    check(log.pastes[0].title === 'Lecture 2: Linear equations' && /subtract 2/.test(log.pastes[0].text), 'pasted text sent as a document');
    press('.library button', '✕');

    // 4. Back in the picker: ready coursework as checkboxes (multi-select), Answer Dash card.
    await until(() => visible('.mg') && boxes().length > 0, 'picker lists coursework');
    check(boxes().every((b) => b.checked), 'all coursework selected by default');
    check(q('.mg-card__title')?.textContent === 'Answer Dash', 'Answer Dash card');

    // 5. Gemini failure (stub: specific selection -> 503) is shown, game does not start.
    press('.mg button', 'Clear');
    press('.mg button', 'Start');
    await until(() => /at least one document/.test(q('.mg .tutor__status')?.textContent ?? ''), 'needs a selection');
    boxes()[0].checked = true;
    boxes().slice(1).forEach((b) => { b.checked = false; });
    if (boxes().length > 1)
    {
        press('.mg button', 'Start');
        await until(() => /not set up yet/.test(q('.mg .tutor__status')?.textContent ?? ''), 'Gemini error shown');
        check(!game.scene.isActive('AnswerDash'), 'no game started on error');
    }

    // 6. Start with all coursework: runner opens inside the page, village paused.
    press('.mg button', 'Select all');
    press('.mg button', 'Start');
    await until(() => game.scene.isActive('AnswerDash') && visible('.dash__card'), 'Answer Dash running');
    check(game.scene.isPaused(scene.scene.key), 'village scene paused');
    check(location.pathname.endsWith('/tests/browser/auth.html'), 'still on the same page');
    check(/Solve 2x = 6/.test(q('.dash__question')?.textContent ?? ''), 'first question shown');
    check(all('.dash__lane').length === 4 && all('.dash__lane')[DASH_KEY(0)].textContent?.includes('x = 3'), 'gate labels match the choices');
    check(/From: Algebra worksheet\.pdf/.test(q('.dash__source')?.textContent ?? ''), 'source document shown');
    check(visible('.dash__figure') && q<HTMLImageElement>('.dash__figure img')!.src.startsWith('data:image/png'), 'figure shown for a question that needs it');
    q<HTMLButtonElement>('.dash__figure')!.click();
    await until(() => visible('.dash__lightbox'), 'figure enlarges');
    q<HTMLElement>('.dash__lightbox')!.click();

    // 6. Lane movement across four lanes, clamped at the edges, keys + taps.
    setFrameMs(25);
    const lane = async (k: string, expected: number) => { key(k); await until(() => selectedLane() === expected, `lane ${expected} after ${k}`); };
    await lane('d', 2); await lane('d', 3);
    key('d'); await until(() => true, 'tick'); check(selectedLane() === 3, 'cannot leave the track on the right');
    await lane('1', 0);
    key('a'); await until(() => true, 'tick'); check(selectedLane() === 0, 'cannot leave the track on the left');
    all('.dash__lane')[DASH_KEY(0)].click();
    await until(() => selectedLane() === DASH_KEY(0), 'tap selects a lane');

    // 7. Correct answer -> positive feedback; wrong answer -> correct lane shown + explanation.
    setFrameMs(100);
    await until(() => visible('.dash__feedback'), 'feedback for question 1');
    check(/Correct! \+100/.test(q('.dash__feedback')?.textContent ?? ''), `correct feedback: ${q('.dash__feedback')?.textContent}`);
    key(' ');
    await until(() => /Solve 3x/.test(q('.dash__question')?.textContent ?? ''), 'question 2');
    const wrongLane = (DASH_KEY(1) + 1) % 4;
    all('.dash__lane')[wrongLane].click();
    await until(() => visible('.dash__feedback'), 'feedback for question 2');
    check(/Not quite/.test(q('.dash__feedback')?.textContent ?? '') && /Divide both sides/.test(q('.dash__feedback')?.textContent ?? ''), 'wrong feedback explains');
    check(all('.dash__lane')[DASH_KEY(1)].classList.contains('is-correct') && all('.dash__lane')[wrongLane].classList.contains('is-wrong'), 'correct + chosen lanes marked');

    // 8. Play through the rest; results come from the (stub) server's grading.
    for (let i = 2; i < DASH_QUESTIONS; i++)
    {
        key(' ');
        await until(() => q('.dash__question')?.textContent?.includes(`Solve ${i + 2}x`), `question ${i + 1}`);
        await until(() => visible('.dash__feedback'), `feedback ${i + 1}`);
    }
    key(' ');
    await until(() => visible('.dash__results'), 'results screen');
    check(log.dash.answers.length === DASH_QUESTIONS && log.dash.finishes === 1, `answers ${log.dash.answers.length}, finishes ${log.dash.finishes}`);
    check(/Study session|Focus time complete/.test(q('.dash__results')?.textContent ?? ''), 'study progress shown');
    check(/Practice next: linear equations/.test(q('.dash__results')?.textContent ?? ''), 'weak topics shown');
    check(/Reward: \+\d+ XP and \+\d crystals?\./.test(q('.dash__results')?.textContent ?? ''), `XP + crystal reward shown: ${q('.dash__results')?.textContent}`);

    // 9. Return to NPC: runner gone, village resumed, same position, dialogue back.
    press('.dash__results button', 'Return to NPC');
    await until(() => !game.scene.isActive('AnswerDash') && game.scene.isActive(scene.scene.key) && visible('.dialogue'), 'back at the NPC');
    check(!visible('.dash'), 'overlay closed');
    check(scene.player.x === before.x && scene.player.y === before.y, 'player position preserved');
    ui.dialogue.handleKey('escape');
    await until(() => !visible('.dialogue'), 'dialogue closed');
    check(scene.inputEnabled === true && scene.input.keyboard.enabled, 'village input restored');

    // 10. Reopen: one runner instance, pause + exit works, no leftovers.
    log.dash.answers.length = 0;
    await openDialogue();
    all('.choice')[2].click();
    await until(() => visible('.mg') && boxes().length > 0, 'picker again');
    press('.mg button', 'Start');
    await until(() => game.scene.isActive('AnswerDash'), 'second run');
    check(game.scene.getScenes(false).filter((s: any) => s.scene.key === 'AnswerDash').length === 1, 'single scene instance');
    key('Escape');
    await until(() => visible('.dash__overlay'), 'pause overlay');
    press('.dash__overlay button', 'Exit to teacher');
    await until(() => !game.scene.isActive('AnswerDash') && visible('.dialogue'), 'exit returns to the NPC');
    ui.dialogue.handleKey('escape');
    await until(() => !visible('.dialogue'), 'closed');
    check(scene.inputEnabled === true, 'input restored after exit');

    // 10b. Spellshot: settings, moving wisp targets, server-graded shots, timed round, results.
    log.dash.answers.length = 0;
    const finishesBefore = log.dash.finishes;
    await openDialogue();
    all('.choice')[2].click();
    await until(() => visible('.mg') && boxes().length > 0, 'picker for Spellshot');
    check(all('.mg-card__title').map((t) => t.textContent).slice(0, 2).join('|') === 'Answer Dash|Spellshot', 'both game cards');
    q<HTMLInputElement>('.mg-option input[value="3"]')!.click();
    q<HTMLInputElement>('.mg-option input[value="swift"]')!.click();
    q<HTMLButtonElement>('.mg button[aria-label="Start Spellshot"]')!.click();
    await until(() => game.scene.isActive('Spellshot') && visible('.shot__card'), 'Spellshot running');
    check(log.dash.starts.at(-1)?.game === 'spellshot' && log.dash.starts.at(-1)?.choices === 3, `game + choices sent: ${JSON.stringify(log.dash.starts.at(-1))}`);
    check(game.scene.isPaused(scene.scene.key), 'village paused during Spellshot');
    const targets = () => all('.shot__target').filter((t) => !t.classList.contains('hidden'));
    check(/Which term means 1\?/.test(text('.shot__prompt')) && targets().length === 3, `first prompt with 3 targets: ${targets().length}`);
    check(/0:\d\d|1:00/.test(text('.shot__clock')), 'round clock shown');
    setFrameMs(25);
    await until(() => !visible('.shot__banner'), 'countdown over');
    const start = targets()[0].style.transform;
    await until(() => targets()[0].style.transform !== start, 'wisps move');
    targets()[SHOT_KEY(0, 3)].click();
    await until(() => /★ 100/.test(text('.shot .dash__score')), 'correct shot scores');
    await until(() => /Which term means 2\?/.test(text('.shot__prompt')), 'next prompt appears');
    const wrongTarget = (SHOT_KEY(1, 3) + 1) % 3;
    key(String(wrongTarget + 1));
    await until(() => targets()[SHOT_KEY(1, 3)]?.classList.contains('is-correct') && targets()[wrongTarget].classList.contains('is-wrong'), 'miss reveals the right target');
    check(/★ 60/.test(text('.shot .dash__score')), `wrong shot costs 40: ${text('.shot .dash__score')}`);
    check(/Answer: Right 1/.test(text('.shot__banner')), 'answer shown after a miss');
    setFrameMs(250);
    await until(() => visible('.shot__results'), 'round ends when the clock runs out');
    check(log.dash.answers.length === 2 && log.dash.finishes === finishesBefore + 1, `shots ${log.dash.answers.length}, finishes ${log.dash.finishes - finishesBefore}`);
    check(/1 \/ 2/.test(text('.shot__results')) && /Review 1 missed prompt/.test(text('.shot__results')), `results: ${text('.shot__results')}`);
    check(/Answer at least 5 questions to earn XP and crystals/.test(text('.shot__results')), 'two shots is not meaningful participation: no reward');
    press('.shot__results button', 'Return to NPC');
    await until(() => !game.scene.isActive('Spellshot') && game.scene.isActive(scene.scene.key) && visible('.dialogue'), 'Spellshot returns to the NPC');
    check(!visible('.shot'), 'Spellshot overlay closed');
    ui.dialogue.handleKey('escape');
    await until(() => !visible('.dialogue'), 'closed after Spellshot');
    check(scene.inputEnabled === true, 'input restored after Spellshot');

    // 11. Chat attachments: ONE "+" control; image sent inline, PDF stored PRIVATELY and read
    // BEFORE the message is sent with its id; remove works; a failed send keeps the draft and
    // attachments, and the retry neither re-uploads nor duplicates the message.
    await openDialogue();
    all('.choice')[0].click();
    await until(() => visible('.tutor__log') && !(q<HTMLTextAreaElement>('.tutor__input')!.disabled), 'chat ready');
    check(!q('.tutor__image-btn') && !all('.tutor button').some((b) => /Upload Document/.test(b.textContent ?? '')), 'one attachment control, no separate upload / camera buttons');
    const plus = q<HTMLButtonElement>('.tutor__composer .attach-btn');
    check(plus && plus.getAttribute('aria-label') === 'Attach files or images', 'accessible + button');
    const png = await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')).blob();
    const attach = (...files: File[]) =>
    {
        const picker = q<HTMLInputElement>('.tutor .attach input[type=file]')!;
        const transfer = new DataTransfer();
        for (const file of files) transfer.items.add(file);
        picker.files = transfer.files;
        picker.dispatchEvent(new Event('change'));
    };
    const pdf = (name: string) => new File(['%PDF-1.4 fake notes'], name, { type: 'application/pdf' });
    const chips = () => all('.tutor .attach-chip');
    const uploadsBefore = log.uploads.length;
    const repliesBefore = all('.tutor__log .msg--npc').length;
    attach(new File([png], 'calc-problem.png', { type: 'image/png' }), pdf('Derivatives notes.pdf'), pdf('remove-me.pdf'));
    await until(() => chips().length === 3, 'three pending attachments');
    check(/used for this message only/.test(text('.tutor .attach-note')) && /saved privately/.test(text('.tutor .attach-note')), `privacy is stated: ${text('.tutor .attach-note')}`);
    q<HTMLButtonElement>('.tutor [aria-label="Remove remove-me.pdf"]')!.click();
    check(chips().length === 2, 'one attachment removed');

    localStorage.setItem('stub.failChatOnce', '1');
    (q<HTMLTextAreaElement>('.tutor__input')!).value = 'Explain this.';
    press('.tutor__composer button', 'Send');
    await until(() => /Not sent/.test(text('.tutor__status')), 'first send fails');
    check(log.uploads.length === uploadsBefore + 1 && log.uploads.at(-1)!.visibility === 'private' && log.uploads.at(-1)!.name === 'Derivatives notes.pdf', `PDF uploaded once, privately: ${JSON.stringify(log.uploads.slice(uploadsBefore))}`);
    check(chips().length === 2 && q<HTMLTextAreaElement>('.tutor__input')!.value === 'Explain this.', 'draft text and attachments kept after failure');
    check(all('.tutor .attach-chip.is-ready').length === 1, 'processed PDF marked ready');
    check(all('.tutor__log .msg--npc').length === repliesBefore, 'no reply bubble for the failed send');
    const firstId = log.chatMessageIds.at(-1);
    press('.tutor__status button', 'Retry');
    await until(() => all('.tutor__log .msg--npc').length === repliesBefore + 1 && chips().length === 0, 'sent on retry, composer cleared');
    check(log.uploads.length === uploadsBefore + 1, 'retry does not upload the PDF again');
    check(log.chatMessageIds.at(-1) === firstId, 'retry reuses the same client message id (no duplicate)');
    check(log.chatImages.at(-1) === 'image/png' && log.chatAttachments.at(-1)!.length === 1, `message carried the image + PDF id: ${JSON.stringify(log.chatAttachments.at(-1))}`);
    check(visible('.tutor__log .msg__image') && /Your files/.test(text('.tutor__log')) && /Derivatives notes\.pdf/.test(text('.tutor__log')), 'sent message shows the attachments; reply says it used them');

    // A file that cannot be read: the message is NOT sent and no broken copy stays in the library.
    const chatsBefore = log.chats;
    attach(pdf('broken scan.pdf'));
    await until(() => chips().length === 1, 'bad file pending');
    (q<HTMLTextAreaElement>('.tutor__input')!).value = 'What does this say?';
    press('.tutor__composer button', 'Send');
    await until(() => all('.tutor .attach-chip.is-failed').length === 1, 'failed state shown on the chip');
    check(log.chats === chatsBefore, 'message not sent before its file content is available');
    check(/could not be read/.test(text('.tutor__status')) && q<HTMLTextAreaElement>('.tutor__input')!.value === 'What does this say?', 'clear error, draft kept');
    await until(() => log.deletes.length > 0, 'unreadable upload removed from the library');
    q<HTMLButtonElement>('.tutor [aria-label="Remove broken scan.pdf"]')!.click();
    check(chips().length === 0, 'failed attachment removable');

    // Closing mid-draft and reopening never carries attachments or drafts into the next chat.
    attach(pdf('stale draft.pdf'));
    (q<HTMLTextAreaElement>('.tutor__input')!).value = 'half-typed';
    await until(() => chips().length === 1, 'draft attachment');
    q<HTMLButtonElement>('.tutor__close')!.click();
    await until(() => !visible('.tutor'), 'chat closed');
    if (visible('.dialogue')) { ui.dialogue.handleKey('escape'); await until(() => !visible('.dialogue'), 'dialogue closed'); }
    await openDialogue();
    all('.choice')[0].click();
    await until(() => visible('.tutor__log') && !(q<HTMLTextAreaElement>('.tutor__input')!.disabled), 'chat reopened');
    check(chips().length === 0 && q<HTMLTextAreaElement>('.tutor__input')!.value === '', 'reopened chat starts clean');
}
