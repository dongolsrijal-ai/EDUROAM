// The local player's identity. Every player-specific record (conversation history, NPC
// memory, learning progress) is keyed by `playerId`, so the same keys work in Supabase.
//
// Future sign-in: when a player authenticates, the backend links this local playerId to the
// Supabase auth user (authUserId) so earlier local progress is kept. Phone linking for Chert
// is verified by the backend; the browser only keeps status flags, never the phone number.

import type { PlayerIdentity } from '../services/contracts';
import { readText, writeJson } from './storage';

const STORAGE_KEY = 'eduroam.identity';

let identity: PlayerIdentity | null = null;

function newPlayerId ()
{
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    return `player_${random}`;
}

export function getPlayerIdentity (): Readonly<PlayerIdentity>
{
    if (identity) return identity;

    const text = readText(STORAGE_KEY);
    try
    {
        const raw = text ? JSON.parse(text) : null;
        if (raw && typeof raw.playerId === 'string' && raw.playerId.startsWith('player_'))
        {
            identity = {
                playerId: raw.playerId,
                authUserId: typeof raw.authUserId === 'string' ? raw.authUserId : null,
                phone: {
                    linked: raw.phone?.linked === true,
                    verified: raw.phone?.verified === true,
                    messagingOptIn: raw.phone?.messagingOptIn === true,
                },
                createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
            };
            return identity;
        }
    }
    catch { /* unreadable: create a new identity below */ }

    identity = {
        playerId: newPlayerId(),
        authUserId: null,
        phone: { linked: false, verified: false, messagingOptIn: false },
        createdAt: new Date().toISOString(),
    };
    writeJson(STORAGE_KEY, identity);
    return identity;
}

export const currentPlayerId = () => getPlayerIdentity().playerId;

/** Records the Supabase account this browser's local player is linked to (local progress is kept). */
export function linkAuthUser (authUserId: string)
{
    const current = getPlayerIdentity();
    if (current.authUserId === authUserId) return;
    identity = { ...current, authUserId };
    writeJson(STORAGE_KEY, identity);
}
