import { Boot } from './scenes/Boot';
import { Hub } from './scenes/Hub';
import { Dungeon } from './scenes/Dungeon';
import { AnswerDash } from './minigames/answerDash/AnswerDashScene';
import { Spellshot } from './minigames/spellshot/SpellshotScene';
import { AUTO, Game, Scale, Types } from 'phaser';
import { COLORS } from './config';
import { deviceCanvasSize, keepCanvasSharp } from './display';
import { attachGame } from './input/inputGuard';

const StartGame = (parent: string) => {
    const { width, height, zoom } = deviceCanvasSize();

    // Find out more information about the Game Config at:
    // https://docs.phaser.io/api-documentation/typedef/types-core#gameconfig
    const config: Types.Core.GameConfig = {
        type: AUTO,
        parent,
        backgroundColor: COLORS.background,
        pixelArt: true,      // nearest-neighbour sampling, no blur
        roundPixels: true,   // avoid sub-pixel shimmer while the camera scrolls
        physics: {
            default: 'arcade',
            arcade: { debug: false }, // set true to see collision boxes
        },
        // Canvas = real device pixels; cameras apply a whole-number zoom (see display.ts).
        scale: {
            mode: Scale.NONE,
            width,
            height,
            zoom,
        },
        scene: [Boot, Hub, Dungeon, AnswerDash, Spellshot],
    };

    const game = new Game(config);
    keepCanvasSharp(game);
    // Typing in any text field (or the login gate) blocks every game key: see input/inputGuard.ts.
    attachGame(game);
    return game;
}

export default StartGame;
