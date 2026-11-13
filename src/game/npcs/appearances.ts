// The four selectable NPC looks. An NPC's look is independent of the subject it teaches.
//
// MISSING ASSETS: public/assets contains no knight / doctor / scientist / farmer sprites
// (only the Phaser template's bg.png and logo.png), so every look below uses a generated
// placeholder from art/textures.ts. To use real art, add a 16x16 front-facing PNG under
// public/assets/ (drawn at 16x16 and shown at 24x24, or a 24x24 PNG) and set `asset`
// to its path relative to that folder. Boot.ts loads it under
// `texture`, and the placeholder is skipped automatically.

import type { Textures } from 'phaser';

export type AppearanceId = 'knight' | 'doctor' | 'scientist' | 'farmer';

interface Appearance
{
    label: string;
    /** Phaser texture key used by the NPC sprite. */
    texture: string;
    /** Path under public/assets/ to a real sprite. Undefined = placeholder art. */
    asset?: string;
}

export const APPEARANCES: Record<AppearanceId, Appearance> = {
    knight: { label: 'Knight', texture: 'npc-knight' },
    doctor: { label: 'Doctor', texture: 'npc-doctor' },
    scientist: { label: 'Scientist', texture: 'npc-scientist' },
    farmer: { label: 'Farmer', texture: 'npc-farmer' },
};

export const APPEARANCE_IDS = Object.keys(APPEARANCES) as AppearanceId[];

export const isAppearanceId = (value: unknown): value is AppearanceId =>
    typeof value === 'string' && (APPEARANCE_IDS as string[]).includes(value);

const urlCache = new Map<string, string>();

/** PNG data URL of a texture's first frame, for HTML previews, portraits and building previews. */
export function textureDataUrl (textures: Textures.TextureManager, key: string): string
{
    const cached = urlCache.get(key);
    if (cached) return cached;

    const frame = textures.getFrame(key);
    const canvas = document.createElement('canvas');
    canvas.width = frame.cutWidth;
    canvas.height = frame.cutHeight;
    canvas.getContext('2d')!.drawImage(
        frame.source.image as CanvasImageSource,
        frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight,
        0, 0, frame.cutWidth, frame.cutHeight,
    );
    const url = canvas.toDataURL();
    urlCache.set(key, url);
    return url;
}
