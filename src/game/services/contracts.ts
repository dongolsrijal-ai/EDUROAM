// SHARED DATA CONTRACTS for NPC conversations, memory and learning progress.
//
// These shapes are used by the game today (local mode) AND are the JSON the future
// FastAPI backend sends/receives, so the game, the backend and Chert all agree.
// See docs/npc-ai-architecture.md for endpoints, Supabase tables and flows.

import type { AppearanceId } from '../npcs/appearances';
import type { MinigameId } from '../minigames';

/** Where a message was sent / received. */
export type ConversationSource = 'game' | 'imessage';

/** Who wrote a line: hand-written NPC content, the AI, the game itself, or the player (human). */
export type DialogueOrigin = 'scripted' | 'ai' | 'system' | 'human';

export type MessageRole = 'player' | 'npc' | 'event';

/** Moments in the in-game talk flow where an NPC speaks. Scripted today, AI-generated later. */
export type DialogueMoment = 'greeting' | 'returning' | 'declined' | 'passed' | 'failed' | 'reply';

export interface DialogueLine
{
    text: string;
    origin: DialogueOrigin;
}

/**
 * What an NPC may *suggest* alongside its lines. The game validates and decides; there is
 * deliberately no "grant item", "add score" or "complete quest" action. Rewards, scores and
 * inventory changes are decided only by game logic (playerState / dungeonRun / quiz scoring).
 */
export type SuggestedAction =
    | { type: 'offer_challenge'; minigameType: MinigameId }
    | { type: 'end_conversation' };

export interface DialogueTurn
{
    npcId: string;
    lines: DialogueLine[];
    suggestions: SuggestedAction[];
}

/** Things that happened in the game, recorded in the history so the NPC "remembers" them. */
export type GameEvent =
    | { type: 'challenge_offered' | 'challenge_declined'; challengeId: string }
    | { type: 'challenge_result'; challengeId: string; score: number; total: number; passed: boolean };

/** One entry of the per-player, per-NPC conversation history (both channels share it). */
export interface ConversationMessage
{
    id: string;
    playerId: string;
    npcId: string;
    role: MessageRole;
    text: string;
    source: ConversationSource;
    origin: DialogueOrigin;
    createdAt: string;
    event?: GameEvent;
}

/** Long-term, PRIVATE memory one NPC keeps about one player (summarised by the AI later). */
export interface NpcMemory
{
    playerId: string;
    npcId: string;
    /** Short AI-written summary of past conversations (empty until AI is connected). */
    summary: string;
    /** Durable facts, e.g. "struggles with times tables", "prefers short answers". */
    facts: string[];
    channelsUsed: ConversationSource[];
    lastInteractionAt: string;
}

/** Learning progress per player, NPC and challenge (written by game logic, read by the AI). */
export interface LearningRecord
{
    playerId: string;
    npcId: string;
    subject: string;
    challengeId: string;
    attempts: number;
    lastScore: number;
    bestScore: number;
    total: number;
    passed: boolean;
    lastAttemptAt: string;
}

/** The NPC as the AI / backend sees it (no rendering data like positions). */
export interface CharacterProfile
{
    npcId: string;
    name: string;
    subject: string;
    appearance: AppearanceId;
    /** Teacher-written greeting lines: seed for the AI persona. */
    greeting: string[];
    minigameType: MinigameId | null;
}

/** Who is playing. Local and anonymous today; linked to a Supabase auth user later. */
export interface PlayerIdentity
{
    /** Stable id used as the key for all player-specific data. */
    playerId: string;
    /** Supabase auth user id once signed in (null = anonymous local player). */
    authUserId: string | null;
    /** Phone linking for Chert. The number itself is never stored in the browser. */
    phone: { linked: boolean; verified: boolean; messagingOptIn: boolean };
    createdAt: string;
}

// ------------------------------------------------------------ backend API (future FastAPI)

/** POST /v1/npcs/{npcId}/messages  (game client, authenticated player). */
export interface SendMessageRequest
{
    playerId: string;
    npcId: string;
    /** Always 'game' from the client. 'imessage' only ever comes from the Chert webhook on the server. */
    source: ConversationSource;
    text: string;
    /** Client-generated id so retries don't create duplicate messages. */
    clientMessageId: string;
}

export interface SendMessageResponse
{
    playerMessage: ConversationMessage;
    reply: DialogueTurn;
}

/** POST /v1/npcs/{npcId}/dialogue  (scripted-or-AI lines for a talk-flow moment). */
export interface DialogueRequest
{
    playerId: string;
    npcId: string;
    source: ConversationSource;
    moment: DialogueMoment;
    /** Game facts the AI may mention (e.g. the quiz score). Read-only context. */
    facts?: Record<string, string | number | boolean>;
}

/**
 * A Chert (iMessage) message AFTER the backend verified it: the sender's phone is linked and
 * verified for `playerId`, the player opted in, and the Chert thread maps to `npcId`.
 * The browser never creates these in production.
 */
export interface VerifiedChannelMessage
{
    playerId: string;
    npcId: string;
    source: 'imessage';
    text: string;
    externalMessageId: string;
    receivedAt: string;
}
