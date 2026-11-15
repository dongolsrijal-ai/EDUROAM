// NPC SERVICE: the one door the game uses for NPC character data, dialogue and
// conversation memory. Gameplay code never knows whether lines come from scripted
// content (today) or Gemini via the backend (later).
//
//   LocalNpcService  (now)   scripted lines + localStorage history/memory
//   RemoteNpcService (later) same interface, calls the FastAPI backend (Gemini + Supabase)
//
// Swap the exported `npcService` below; nothing else in the game changes.
//
// AUTHORITY RULE: the service only produces words and *suggestions*. Rewards, scores and
// inventory are decided by game logic (quiz scoring, playerState, dungeonRun) and are only
// reported to the service afterwards as events.

import { npcStore, type NpcRecord } from '../data/npcStore';
import { conversationStore } from '../data/conversationStore';
import type {
    CharacterProfile, ConversationMessage, ConversationSource, DialogueLine, DialogueMoment, DialogueRequest,
    DialogueTurn, GameEvent, NpcMemory, SendMessageRequest, SendMessageResponse, SuggestedAction, VerifiedChannelMessage,
} from './contracts';

export interface NpcService
{
    /** Character data for prompts / UI (no rendering data). */
    getCharacter (npcId: string): CharacterProfile | null;

    /** Lines for a moment of the in-game talk flow (greeting, quiz reactions...). */
    dialogue (request: DialogueRequest): Promise<DialogueTurn>;

    /** A free-text message from the player (game chat later). */
    sendMessage (request: SendMessageRequest): Promise<SendMessageResponse>;

    /** Something that happened in game (challenge result...), stored in the shared history. */
    recordEvent (playerId: string, npcId: string, source: ConversationSource, event: GameEvent): void;

    getHistory (playerId: string, npcId: string, limit?: number): Promise<ConversationMessage[]>;
    getMemory (playerId: string, npcId: string): Promise<NpcMemory | null>;
}

// ------------------------------------------------------------ scripted content (local mode)

/** Lines used when an NPC has no custom reactions. */
const DEFAULT_REACTIONS = {
    declined: ['No problem! Come back whenever you are ready.'],
    passed: ['Brilliant work! You really know your stuff.'],
    failed: ['Not quite this time, but every mistake is practice. Try again soon!'],
    completed: ['Welcome back! You already earned this reward, but practice makes perfect. Another round?'],
};

function scriptedLines (npc: NpcRecord, moment: DialogueMoment): string[]
{
    const reactions = { ...DEFAULT_REACTIONS, ...npc.reactions };
    switch (moment)
    {
        // Teachers created without a custom greeting introduce themselves from name + class.
        case 'greeting': return npc.dialogue.length ? npc.dialogue : [`Hello! I'm ${npc.name}, your ${npc.subject} teacher.`, 'Ask me anything, and we can go step by step together. What would you like to learn today?'];
        case 'returning': return reactions.completed;
        case 'declined': return reactions.declined;
        case 'passed': return reactions.passed;
        case 'failed': return reactions.failed;
        case 'reply': return [`${npc.name} can't chat freely yet. Once AI is connected, ask me anything about ${npc.subject}!`];
    }
}

const newId = (prefix: string) =>
    `${prefix}_${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)}`;

// ------------------------------------------------------------ local implementation

class LocalNpcService implements NpcService
{
    getCharacter (npcId: string): CharacterProfile | null
    {
        const npc = npcStore.get(npcId);
        if (!npc) return null;
        return {
            npcId: npc.id, name: npc.name, subject: npc.subject, appearance: npc.appearance,
            greeting: npc.dialogue, minigameType: npc.minigameType,
        };
    }

    async dialogue ({ playerId, npcId, source, moment }: DialogueRequest): Promise<DialogueTurn>
    {
        const npc = npcStore.get(npcId);
        if (!npc) return { npcId, lines: [{ text: '...', origin: 'system' }], suggestions: [] };
        const turn: DialogueTurn = {
            npcId,
            lines: scriptedLines(npc, moment).map((text) => ({ text, origin: 'scripted' })),
            suggestions: [],
        };
        this.recordLines(playerId, npcId, source, turn.lines);
        return turn;
    }

    async sendMessage (request: SendMessageRequest): Promise<SendMessageResponse>
    {
        // The game client may only speak for itself; channel messages arrive via receiveVerifiedChannelMessage.
        return this.handleMessage({ ...request, source: 'game' });
    }

    /**
     * Local stand-in for the backend's Chert webhook AFTER verification (phone linked +
     * verified + opted in, thread -> NPC). Same pipeline as in-game messages, so both
     * channels land in the same (playerId, npcId) history and memory.
     */
    async receiveVerifiedChannelMessage (message: VerifiedChannelMessage): Promise<SendMessageResponse>
    {
        return this.handleMessage({
            playerId: message.playerId, npcId: message.npcId, source: message.source,
            text: message.text, clientMessageId: message.externalMessageId,
        });
    }

    recordEvent (playerId: string, npcId: string, source: ConversationSource, event: GameEvent)
    {
        const npc = npcStore.get(npcId);
        const now = new Date().toISOString();
        conversationStore.appendMessage({
            id: newId('msg'), playerId, npcId, role: 'event', text: describeEvent(event),
            source, origin: 'system', createdAt: now, event,
        });
        if (event.type === 'challenge_result' && npc)
        {
            conversationStore.recordLearning({
                playerId, npcId, subject: npc.subject, challengeId: event.challengeId,
                lastScore: event.score, total: event.total, passed: event.passed, lastAttemptAt: now,
            });
        }
    }

    async getHistory (playerId: string, npcId: string, limit?: number)
    {
        return conversationStore.history(playerId, npcId, limit);
    }

    async getMemory (playerId: string, npcId: string)
    {
        return conversationStore.memory(playerId, npcId);
    }

    /** One pipeline for every channel: store player message -> produce reply -> store reply. */
    private handleMessage (request: SendMessageRequest): SendMessageResponse
    {
        const { playerId, npcId, source, text } = request;
        const playerMessage: ConversationMessage = {
            id: request.clientMessageId || newId('msg'), playerId, npcId, role: 'player',
            text: text.slice(0, 1000), source, origin: 'human', createdAt: new Date().toISOString(),
        };
        conversationStore.appendMessage(playerMessage);

        const npc = npcStore.get(npcId);
        const lines: DialogueLine[] = (npc ? scriptedLines(npc, 'reply') : ['...']).map((t) => ({ text: t, origin: 'scripted' as const }));
        const suggestions: SuggestedAction[] = npc?.minigameType ? [{ type: 'offer_challenge', minigameType: npc.minigameType }] : [];
        this.recordLines(playerId, npcId, source, lines);
        return { playerMessage, reply: { npcId, lines, suggestions } };
    }

    private recordLines (playerId: string, npcId: string, source: ConversationSource, lines: DialogueLine[])
    {
        for (const line of lines)
        {
            conversationStore.appendMessage({
                id: newId('msg'), playerId, npcId, role: 'npc', text: line.text,
                source, origin: line.origin, createdAt: new Date().toISOString(),
            });
        }
    }
}

function describeEvent (event: GameEvent): string
{
    switch (event.type)
    {
        case 'challenge_offered': return `Offered challenge ${event.challengeId}`;
        case 'challenge_declined': return `Player declined challenge ${event.challengeId}`;
        case 'challenge_result': return `Challenge ${event.challengeId}: ${event.score}/${event.total} (${event.passed ? 'passed' : 'not passed'})`;
    }
}

const local = new LocalNpcService();

/** The active implementation. Replace with a RemoteNpcService when the backend exists. */
export const npcService: NpcService = local;

/**
 * LOCAL/DEV ONLY: simulates what the backend does after verifying an incoming Chert message.
 * In production this path lives on the server (POST /v1/chert/webhook), never in the browser.
 */
export const localChannelBridge = {
    receive: (message: VerifiedChannelMessage) => local.receiveVerifiedChannelMessage(message),
};
