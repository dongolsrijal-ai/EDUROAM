// The ONE place that decides whether the game may read the keyboard.
//
// Game keys are blocked while
//   - a text-entry element has focus (any <input>, <textarea>, <select> or contenteditable in the
//     page: login, NPC creation / editing, Chat & Study, coursework notes, search, dev panel...), or
//   - something holds a lock (the full-screen login gate while signed out).
//
// Blocking = Phaser's KeyboardManager is disabled, so it neither reacts to keys nor preventDefault()s
// them (its key capture is what used to swallow W/S/Space while typing), and every scene's held keys
// are released so a W pressed before focusing a field cannot keep the player walking. Window-level
// shortcut handlers ask gameKeysAllowed(event) before acting. Typing, selection, copy/paste, Tab
// and form submission are untouched: nothing here ever cancels a DOM event.

import type { Game } from 'phaser';

let game: Game | null = null;
const locks = new Set<string>();
const listeners = new Set<(allowed: boolean) => void>();
let lastAllowed: boolean | null = null;

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit']);

/** True for elements that take typed text (so game shortcuts must not fire while they have focus). */
export function isTextEntry (target: EventTarget | Element | null | undefined): boolean
{
    if (!target || typeof (target as Element).tagName !== 'string') return false;
    const el = target as HTMLElement;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return tag === 'INPUT' && !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
}

/** Whether game shortcuts may act now (and, given an event, whether THIS key event is for the game). */
export function gameKeysAllowed (event?: Event): boolean
{
    if (locks.size) return false;
    if (event && isTextEntry(event.target)) return false;
    return !isTextEntry(typeof document === 'undefined' ? null : document.activeElement);
}

/** Holds (on = true) or releases a named lock, e.g. 'auth-gate'. */
export function setInputLock (reason: string, on: boolean)
{
    if (on) locks.add(reason);
    else locks.delete(reason);
    apply();
}

export const inputLocked = (reason?: string) => (reason ? locks.has(reason) : locks.size > 0);

/** Called once the Phaser game exists. */
export function attachGame (instance: Game)
{
    game = instance;
    lastAllowed = null;
    apply();
}

/** Notified when game keys become allowed / blocked. Returns an unsubscribe function. */
export function onGameKeysChange (fn: (allowed: boolean) => void)
{
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

function apply ()
{
    const allowed = gameKeysAllowed();
    const keyboard = game?.input?.keyboard;
    if (keyboard) keyboard.enabled = allowed;
    if (!allowed && game)
    {
        // Release keys held at the moment typing started (no stuck "W is down").
        for (const scene of game.scene.getScenes(false)) scene.input?.keyboard?.resetKeys();
    }
    if (allowed !== lastAllowed)
    {
        lastAllowed = allowed;
        listeners.forEach((fn) => fn(allowed));
    }
}

if (typeof document !== 'undefined')
{
    document.addEventListener('focusin', apply, true);
    // focusout fires before the next element is focused: decide once focus has settled.
    document.addEventListener('focusout', () => setTimeout(apply, 0), true);
    // Hidden / removed fields lose focus without a focusout in some browsers.
    window.addEventListener('blur', () => setTimeout(apply, 0));
}
