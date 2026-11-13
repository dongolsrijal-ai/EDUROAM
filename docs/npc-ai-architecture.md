# NPC, AI memory and cross-platform messaging: architecture

Status: **prepared, not connected**. The game runs fully locally today (scripted dialogue,
`localStorage`). Gemini, Chert and Supabase plug in behind the seams described here without
rebuilding the NPC system.

```
 Phaser game (in-game talk)            Chert (iMessage)
            │  SendMessageRequest / DialogueRequest      │  webhook
            ▼                                            ▼
        ┌──────────── Shared Python backend (FastAPI) ────────────┐
        │ resolves playerId + npcId, enforces auth / opt-in,       │
        │ builds the prompt, validates AI output                   │
        └───────────────┬───────────────────────────┬─────────────┘
                        ▼                           ▼
                   Gemini API                    Supabase
          (persona, teaching, replies)   (npcs, conversations, memories,
                                          learning progress, players)
```

Both channels use **one NPC identity (`npcId`) and one player identity (`playerId`)**, so they
read and write the same history and the same private memory.

## 1. Layers in the game today

| Layer | File | Owns |
|---|---|---|
| NPC config (data only) | `src/game/data/npcStore.ts` | `NpcRecord` + buildings, stable ids, limits |
| Rendering | `src/game/npcs/Npc.ts`, `buildings/Building.ts` | sprites, roaming, collision (reads data, never stores it) |
| Talk flow (game rules) | `src/game/npcs/conversation.ts` | greeting -> challenge -> result; calls game logic for rewards |
| **NPC service (the seam)** | `src/game/services/npcService.ts` | character data, dialogue lines, events, history, memory |
| Contracts (= API JSON) | `src/game/services/contracts.ts` | shared types for game + backend + Chert |
| Player-specific data | `src/game/data/conversationStore.ts` | history, memory, learning progress keyed by `(playerId, npcId)` |
| Player identity | `src/game/data/playerIdentity.ts` | stable `playerId`, future `authUserId`, phone-link flags |
| Local persistence | `src/game/data/storage.ts` | the only `localStorage` access for NPC data |
| Authoritative game state | `src/game/state/playerState.ts`, `state/dungeonRun.ts` | inventory, rewards, dungeon progress |

`npcService` is the only thing gameplay calls for dialogue. Today it is `LocalNpcService`
(scripted lines + `localStorage`). Later, a `RemoteNpcService` with the same `NpcService`
interface calls the backend. Changing the one exported line in `npcService.ts` switches the game.

## 2. Identity

- **`npcId`**: created once (`npc_<uuid>`, or a fixed id like `sir-sum-a-lot` for built-ins).
  It never changes on rename, appearance change, move or reload. Every table and API call uses it.
- **`playerId`**: `player_<uuid>`, created once per browser (`eduroam.identity`).
  - **After Supabase Auth:** the backend links it to the auth user (`authUserId`), so local progress
    moves to the account. After that, the backend derives `playerId` from the auth token; the
    client-sent value is never trusted.
- **Composite key** for everything personal: `(playerId, npcId)`.

## 3. Dialogue is source-independent

The talk flow asks the service for lines at named **moments**
(`greeting | returning | declined | passed | failed | reply`) and receives a `DialogueTurn`:

```ts
{ npcId, lines: [{ text, origin: 'scripted' | 'ai' | 'system' }], suggestions: SuggestedAction[] }
```

- Scripted today: `LocalNpcService` maps moments to the teacher-written lines in `NpcRecord`.
- Later, the backend generates lines with Gemini (persona = `CharacterProfile` + memory + learning
  progress) and returns the same shape. If Gemini fails, the backend falls back to scripted lines.
- The UI (`DialogueBox`) only ever receives strings, so it is untouched.
- `io.wait(...)` holds the player still while lines load, so slower AI replies need no flow changes.

## 4. Authority rule (AI can't change game state)

- **AI output contains words and suggestions only.** `SuggestedAction` is a closed list
  (`offer_challenge`, `end_conversation`). There is no "grant item", "add score" or "complete quest".
- **Quiz scoring, rewards, inventory and dungeon progress stay in game logic.** That means
  `QuizPanel`, `claimChallengeReward`, `playerState` and `dungeonRun`.
- **Outcomes are reported to the NPC afterwards** as `GameEvent`s (e.g. `challenge_result`). The NPC
  can talk about them but can't cause them.
- **When backend-side quests and rewards exist,** the backend validates them from game events,
  never from model text.

## 5. Data model (Supabase)

```sql
-- Players: one row per person. Phone data is backend-only.
create table players (
  id            text primary key,              -- playerId
  auth_user_id  uuid unique references auth.users(id),
  created_at    timestamptz default now()
);

create table player_phone_links (
  player_id         text primary key references players(id) on delete cascade,
  phone_e164_hash   text not null unique,      -- store a hash; raw number only in Chert/secure store
  verified_at       timestamptz,                -- set after code verification
  messaging_opt_in  boolean not null default false,
  opted_in_at       timestamptz,
  opted_out_at      timestamptz
);

create table npcs (                             -- mirrors NpcRecord (teacher-owned config)
  id text primary key, owner_id uuid references auth.users(id),
  name text not null, subject text not null, appearance text not null,
  greeting jsonb not null default '[]', reactions jsonb, minigame_type text,
  map text not null, x int not null, y int not null,
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table npc_buildings (
  id text primary key, npc_id text not null unique references npcs(id) on delete cascade,
  type text not null, map text not null, x int not null, y int not null
);

create table npc_chert_threads (                -- which Chert conversation talks to which NPC
  npc_id text primary key references npcs(id) on delete cascade,
  chert_handle text not null unique
);

create table conversation_messages (           -- ConversationMessage, both channels
  id text primary key,
  player_id text not null references players(id) on delete cascade,
  npc_id text not null references npcs(id) on delete cascade,
  role text not null check (role in ('player','npc','event')),
  text text not null,
  source text not null check (source in ('game','imessage')),
  origin text not null check (origin in ('scripted','ai','system','human')),
  event jsonb,
  created_at timestamptz default now()
);
create index on conversation_messages (player_id, npc_id, created_at);

create table npc_memories (                    -- NpcMemory, private per player
  player_id text references players(id) on delete cascade,
  npc_id text references npcs(id) on delete cascade,
  summary text not null default '', facts jsonb not null default '[]',
  channels_used text[] not null default '{}', last_interaction_at timestamptz,
  primary key (player_id, npc_id)
);

create table learning_progress (               -- LearningRecord, written from game events only
  player_id text references players(id) on delete cascade,
  npc_id text references npcs(id) on delete cascade,
  challenge_id text not null, subject text not null,
  attempts int not null default 0, last_score int, best_score int, total int,
  passed boolean not null default false, last_attempt_at timestamptz,
  primary key (player_id, npc_id, challenge_id)
);
```

**Privacy (Row Level Security):** `conversation_messages`, `npc_memories` and
`learning_progress` are readable only where `player_id` belongs to `auth.uid()`. Writes go
through the backend (service role), never directly from the browser. Memories are never shared
between players.

## 6. Backend API contract (FastAPI)

All game requests use `Authorization: Bearer <supabase access token>`. Body and response shapes
are the TypeScript types in `src/game/services/contracts.ts`.

| Method | Path | Caller | Body -> Response |
|---|---|---|---|
| GET | `/v1/npcs/{npcId}` | game | -> `CharacterProfile` |
| POST | `/v1/npcs/{npcId}/dialogue` | game | `DialogueRequest` -> `DialogueTurn` |
| POST | `/v1/npcs/{npcId}/messages` | game | `SendMessageRequest` (`source: 'game'`) -> `SendMessageResponse` |
| POST | `/v1/npcs/{npcId}/events` | game | `GameEvent` -> `204` (history + learning progress) |
| GET | `/v1/players/me/npcs/{npcId}/history?limit=` | game | -> `ConversationMessage[]` |
| GET | `/v1/players/me/npcs/{npcId}/memory` | game | -> `NpcMemory` |
| POST | `/v1/players/me/phone/start` | game | `{ phone }` -> sends a verification code |
| POST | `/v1/players/me/phone/verify` | game | `{ code }` -> `{ verified: true }` |
| POST | `/v1/players/me/phone/opt-in` | game | `{ optIn: boolean }` -> `PlayerIdentity.phone` |
| POST | `/v1/chert/webhook` | Chert | signed inbound message -> reply sent back via Chert |

Rules:
- `clientMessageId` / Chert message ids make retries idempotent.
- The server ignores any `playerId` in the body once auth exists, and uses the token's player.
- `source: 'imessage'` is only produced by the webhook handler, never accepted from the game client.

## 7. Two channels, one memory

Both entry points end in the **same pipeline**: `handleMessage(playerId, npcId, source, text)`.

```
In-game                                           Chert / iMessage
POST /v1/npcs/sir-sum-a-lot/messages              POST /v1/chert/webhook (signature checked)
  token -> playerId = player_123                    sender phone -> player_phone_links (hash)
  source = 'game'                                     must be verified AND messaging_opt_in
                                                    thread handle -> npc_chert_threads -> sir-sum-a-lot
                                                    source = 'imessage'
                 \                                 /
                  handleMessage(player_123, sir-sum-a-lot, source, text)
                    1. store player message        (conversation_messages)
                    2. load memory + recent history + learning progress for (player_123, sir-sum-a-lot)
                    3. Gemini: persona + memory + history -> reply (validated; suggestions only)
                    4. store NPC reply              (origin 'ai', same source)
                    5. update npc_memories          (channels_used, summary/facts)
                  -> reply returned to the game, or sent back through Chert
```

Unverified or opted-out phones get no NPC reply, and nothing is stored.

**Local demo today:** `npcService.sendMessage({... source: 'game'})` and
`localChannelBridge.receive({... source: 'imessage'})` (dev-only stand-in for the verified
webhook) both call `LocalNpcService.handleMessage`. The result is one
`(playerId, npcId)` history with both sources, and a memory with `channelsUsed: ['game','imessage']`.

## 8. Switching to the backend later

1. Implement `RemoteNpcService implements NpcService` (fetch calls to section 6) and export it
   from `npcService.ts`.
2. On first sign-in, upload local `eduroam.identity`, `eduroam.npcs` and `eduroam.conversations`
   once (the ids are already stable, so they map 1:1 to rows).
3. Point `npcStore` load/persist at the API (its public functions stay the same).
4. Keep `playerState` / `dungeonRun` authoritative. If they move server-side, the server applies
   the same rules from game events, never from AI text.
