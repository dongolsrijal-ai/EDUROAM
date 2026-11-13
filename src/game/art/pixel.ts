// Low-level pixel drawing helpers shared by Phaser textures (art/textures.ts) and
// HTML item icons (items/icons.ts). Everything is drawn on whole pixels: no smoothing.

export type Ctx = CanvasRenderingContext2D;
export type Palette = Record<string, string>;

export function rect (ctx: Ctx, x: number, y: number, w: number, h: number, color: string)
{
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
}

/** Pixel-exact filled circle (no anti-aliasing). */
export function disc (ctx: Ctx, cx: number, cy: number, r: number, color: string)
{
    for (let y = -r; y <= r; y++)
    {
        for (let x = -r; x <= r; x++)
        {
            if (x * x + y * y <= r * r + r) rect(ctx, cx + x, cy + y, 1, 1, color);
        }
    }
}

/** Draws ASCII pixel art: each character maps to a palette color, '.' is transparent. */
export function ascii (ctx: Ctx, rows: string[], palette: Palette, ox = 0, oy = 0)
{
    rows.forEach((row, y) => [...row].forEach((ch, x) =>
    {
        const color = palette[ch];
        if (color) rect(ctx, ox + x, oy + y, 1, 1, color);
    }));
}

/**
 * 16 -> 24 pixel mapping used for characters (1.5x). Half of the art pixels become 2 wide,
 * chosen symmetrically around the centre so faces and outlines stay even. The result is a
 * real 24x24 texture, so the camera's whole-number zoom keeps it perfectly crisp.
 */
const SPANS_16_TO_24: [number, number][] = (() =>
{
    const spans: [number, number][] = [];
    let at = 0;
    for (let i = 0; i < 16; i++)
    {
        const doubled = i < 8 ? i % 2 === 1 : i % 2 === 0;
        spans.push([at, doubled ? 2 : 1]);
        at += doubled ? 2 : 1;
    }
    return spans;
})();

/** Draws 16x16 ASCII art as a 24x24 character sprite (see SPANS_16_TO_24). */
export function asciiCharacter (ctx: Ctx, rows: string[], palette: Palette, ox = 0, oy = 0)
{
    rows.forEach((row, y) => [...row].forEach((ch, x) =>
    {
        const color = palette[ch];
        if (!color || x >= 16 || y >= 16) return;
        const [dx, dw] = SPANS_16_TO_24[x];
        const [dy, dh] = SPANS_16_TO_24[y];
        rect(ctx, ox + dx, oy + dy, dw, dh, color);
    }));
}

/** Draws onto a fresh canvas and returns it (used for HTML icons). */
export function drawCanvas (w: number, h: number, draw: (ctx: Ctx) => void)
{
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    draw(canvas.getContext('2d')!);
    return canvas;
}

/** Draws ASCII pixel art at a whole-number scale (e.g. 16x16 art -> 32x32 texture). */
export function asciiScaled (ctx: Ctx, rows: string[], palette: Palette, scale: number, ox = 0, oy = 0)
{
    rows.forEach((row, y) => [...row].forEach((ch, x) =>
    {
        const color = palette[ch];
        if (color) rect(ctx, ox + x * scale, oy + y * scale, scale, scale, color);
    }));
}
