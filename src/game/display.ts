// Crisp rendering: the canvas is sized in DEVICE pixels (accounting for Windows/Mac display
// scaling) and shown at exactly the window's CSS size, so the browser never resamples it.
// World cameras then zoom by a whole number (see pixelZoom), so each art pixel becomes an
// exact N x N block of screen pixels.

import type { Game } from 'phaser';
import { VIEW_HEIGHT, VIEW_WIDTH } from './config';

export function deviceCanvasSize ()
{
    const dpr = window.devicePixelRatio || 1;
    return {
        width: Math.round(window.innerWidth * dpr),
        height: Math.round(window.innerHeight * dpr),
        /** Phaser displays the canvas at width * zoom CSS pixels. */
        zoom: 1 / dpr,
    };
}

/** Keeps the canvas matched to the window (and display scaling) as they change. */
export function keepCanvasSharp (game: Game)
{
    window.addEventListener('resize', () =>
    {
        const { width, height, zoom } = deviceCanvasSize();
        game.scale.setZoom(zoom);
        game.scale.resize(width, height);
    });
}

/** Largest whole-number camera zoom that still shows at least VIEW_WIDTH x VIEW_HEIGHT world pixels. */
export function pixelZoom (canvasWidth: number, canvasHeight: number)
{
    return Math.max(1, Math.floor(Math.min(canvasWidth / VIEW_WIDTH, canvasHeight / VIEW_HEIGHT)));
}
