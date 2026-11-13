// Tiny DOM helpers for the HTML overlay UI. User-provided text is always set via textContent.

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap> (tag: K, className = '', ...children: Child[])
{
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const child of children) if (child) node.append(child);
    return node;
}

/**
 * A button that never steals keyboard focus, so pressing Enter/E afterwards goes to the
 * game's key handling instead of re-clicking the button.
 */
export function gameButton (className: string, onClick: () => void, ...children: Child[])
{
    const button = el('button', className, ...children);
    button.type = 'button';
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', onClick);
    return button;
}

/** "[E] next  [Esc] close" style hint row. */
export function keyHints (pairs: [string, string][])
{
    return el('div', 'keys', ...pairs.map(([key, label]) => el('span', '', el('span', 'key', key), label)));
}

/** Interface every modal UI implements so the scene can route game keys to it. */
export interface Modal
{
    /** `key` is KeyboardEvent.key lower-cased ('e', 'enter', 'escape', 'arrowup', '1', ...). */
    handleKey (key: string): void;
}

export const isConfirm = (key: string) => key === 'e' || key === 'enter' || key === ' ';
export const isUp = (key: string) => key === 'arrowup' || key === 'w';
export const isDown = (key: string) => key === 'arrowdown' || key === 's';
