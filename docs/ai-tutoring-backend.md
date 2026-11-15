# AI tutoring backend (Supabase + Gemini)

```
Game UI (Phaser + HTML overlay)
  │  Supabase Auth session (publishable key + user JWT)
  ├─► Supabase tables (RLS)        read: NPCs, materials, history, memory, progress
  │                                write: own classes/NPC definitions only
  ├─► Storage "class-materials"    private bucket, one-time signed upload URLs
  └─► Edge Functions (verify JWT, rate limit, secret key server-side)
        class-documents  create → upload → process (extract, chunk, mark ready)
        npc-chat         NPC context → Gemini → save turn + memory + progress
                           │
                           ▼
                      Gemini API (GEMINI_API_KEY = Edge Function secret)
```

Supabase is the source of truth for players, classes, NPC identities, curriculum
documents, chat history, NPC memory and class progress. The game's own state (inventory,
dungeons, Pomodoro, NPC placement) stays in `localStorage`; nothing local is deleted or
overwritten. The browser never calls Gemini and never holds a secret.

## Files

| Path | Role |
|---|---|
| `supabase/migrations/20261114010000_fix_classes_select_policy.sql`, `20261114020000_harden_function_exposure.sql` | Class upsert RLS fix; RLS helpers moved to non-exposed `private` schema, trigger functions not executable by API roles |
| `tests/live/liveE2E.mjs` | Live check against the real project (2 guest users): auth rejection, RLS isolation, PDF processing, retrieval, npc-chat |
| `supabase/migrations/20261114000000_npc_tutoring.sql` | Tables, constraints, indexes, RLS, private bucket, retrieval (`match_npc_chunks`), `save_tutor_turn`, `consume_rate_limit`, `channel_pairings` |
| `supabase/functions/npc-chat/` | Chat endpoint (11-step flow in the file header) |
| `supabase/functions/class-documents/` | The single document ingestion pipeline |
| `supabase/functions/_shared/npcContext.ts` | **Reusable operations** for every channel: `resolveNpcIdentity`, `loadClassKnowledge`, `retrieveStudentMemory`, `retrieveConversationContext`, `saveConversationTurn` (also updates memory + progress atomically) |
| `supabase/functions/_shared/tutorService.ts` | **`runTutorTurn`**: one tutoring turn for ANY channel (memory, history, coursework, optional Google Search, preferences, Gemini, atomic save). npc-chat calls it; the future voice agent calls the same function |
| `supabase/functions/_shared/tutorRouting.ts` | Per-message rules: when Google Search is offered (`wantsWebSearch`) and the thinking task (`tutoringTask`) |
| `supabase/functions/_shared/website.ts` | Website coursework: URL safety rules, URL-context prompt/schema, retrieval verdict, saved notes text |
| `supabase/migrations/20261114060000_teaching_preferences.sql` | `npc_memories.pending_preference`, `save_tutor_turn` stores it, `forget_teaching_preference` RPC (caller's own row only) |
| `supabase/functions/_shared/gemini.ts` | Gemini service: structured output, task-based thinking, optional tools, one-time graceful fallback, timeout, one retry, error codes |
| `supabase/functions/_shared/tutorPrompt.ts` | Context builder, subject focus, output parsing, source refs, memory merge |
| `supabase/functions/_shared/textProcessing.ts`, `extract.ts` | Signature checks, PDF/DOCX/TXT extraction, chunking |
| `supabase/functions/_shared/documentRules.ts` | Upload rules shared by the browser and the server |
| `src/game/services/backend.ts`, `authFlow.ts` | Supabase client + Auth (6-digit email code, optional guest), session events, links local `playerId` |
| `src/game/ui/SignInBox.ts` | In-game email → code → verify form with resend cooldown |
| `src/game/services/tutorApi.ts` | NPC sync, chat, history, materials, uploads with progress |
| `src/game/ui/TutorPanel.ts` | Chat / Upload Document / Class Materials / History panel |
| `src/game/ui/NpcManager.ts`, `uploads.ts` | "Class Materials" section in Create/Edit NPC |

The local `npcStore` remains the only NPC manager (10-NPC limit, class rules, buildings).
Before tutoring or uploading, `syncNpc` upserts the NPC (keyed by its stable game id) and
its class (= subject) into Supabase. The database repeats the 10-NPC / 10-class limits.

## Security model

- **Identity** comes only from the verified JWT (`supabase.auth.getUser`) inside each
  function. Bodies never carry a player id; NPC/conversation/document ids are UUID-validated
  and access-checked (RLS reads + explicit ownership checks).
- **RLS on every table.** Players read only their own conversations, messages, memories and
  progress (a teacher cannot read a student's chats). Class material is readable by the class
  owner and enrolled `class_members`; a student's private upload only by the uploader.
- **Server-only writes** for documents, chunks, messages, memory and progress, so a client
  cannot forge NPC replies, mark a document ready or touch another player's memory.
- **NPC knowledge isolation.** `match_npc_chunks` returns ready chunks for the NPC's class
  that are class-wide or scoped to *that* NPC, plus the caller's own private uploads to that NPC.
- **Storage.** Private bucket, 10 MB limit, MIME allow-list (PDF/TXT/DOCX) enforced by
  Storage; uploads use one-time signed URLs issued after validation; the server re-checks
  file signatures before extraction. Objects live under `<uploader uid>/<document id>/`.
- **Rate limits**: chat 12/min and 400/day per player; document creation 40/hour.
- Documents become `ready` only after chunks are stored; otherwise `failed` with a reason.
  The model is told which documents are still processing/failed and must not invent them.

## Setup (existing EDUROAM project; no new project)

Prerequisites: a Supabase personal access token (or `npx supabase@3.1.0 login` in a terminal),
the project ref (the subdomain in `VITE_SUPABASE_URL`) and a Gemini API key.

```sh
npx supabase@3.1.0 login                       # or set SUPABASE_ACCESS_TOKEN
npx supabase@3.1.0 link --project-ref <project-ref>
npx supabase@3.1.0 db push                     # applies supabase/migrations
npx supabase@3.1.0 secrets set GEMINI_API_KEY=<key>      # optional: GEMINI_MODEL=gemini-3.8-flash
npx supabase@3.1.0 functions deploy npc-chat class-documents
```

### Sign-in: 6-digit email codes

Flow: email → **Send Code** (`signInWithOtp`) → the player types the code into the same game
panel (`verifyOtp({ type: 'email' })`) → `SIGNED_IN` → the open NPC panel unlocks and syncs
the account's class/NPC rows. No link, no new tab, no reload; the email can be read on any
device. Sessions persist in `localStorage` (`eduroam.auth`) and are restored on reload
(`INITIAL_SESSION`); `TOKEN_REFRESHED` keeps the current state; `SIGNED_OUT` locks the panel.
The account id (`auth.users.id`) stays separate from the game's local `player_...` id, which is
only recorded in `players.legacy_local_id`. Signing into a different account switches accounts;
nothing is merged (including guest → email).

Client safeguards: one request at a time, 60 s resend cooldown (kept across reloads), no
automatic retry, "sent" shown only after Supabase accepted the request, clear messages for
HTTP 429 / `over_email_send_rate_limit`, wrong or expired codes (`otp_expired`) and
`email_address_not_authorized`.

**Dashboard steps (Authentication; do not `supabase config push` — it would overwrite the
hosted auth settings with the local-only values in `supabase/config.toml`):**

1. *Emails → Templates → Magic Link* **and** *Confirm signup*: put the code in the body, e.g.
   `<h2>Your EDUROAM code</h2><p>Enter this code in the game: <strong>{{ .Token }}</strong></p>`
   (new emails get *Confirm signup*, returning ones *Magic Link*; both verify with `type: 'email'`).
   Removing `{{ .ConfirmationURL }}` stops the "opens a second game tab" problem completely.
2. *Sign In / Providers → Email*: Email provider on; **Email OTP Length = 6**; Email OTP
   Expiration e.g. 600-3600 s.
3. *Emails → SMTP Settings*: the built-in email service only delivers to the project's team
   members and allows very few emails per hour. Configure **custom SMTP** (Resend, Postmark,
   SES, SendGrid…) before real players sign in; then raise *Rate Limits → emails per hour*.
4. *URL Configuration*: **Site URL** = the public HTTPS game URL once hosted (e.g.
   `https://eduroam.example.org`), not localhost. **Redirect URLs**: `http://localhost:8080/**`
   and `https://<your-domain>/**`. Codes don't use redirects; these matter only for old links
   still in inboxes and future OAuth. The client always uses the page's own origin.
5. Optional — *Sign In / Providers → Anonymous sign-ins* for "Play as guest" (off today; the
   button then shows a clear "turned off" message).

Phones: the code flow works in any browser that can reach the game. For local testing on a
phone, run `npx vite --config vite/config.dev.mjs --host` and open `http://<computer-LAN-IP>:8080`;
in production host the built game on HTTPS. No OAuth provider is implemented (none existed);
the client already strips auth parameters from the URL after `detectSessionInUrl` restores a
redirect session, so a future Google provider (enable it in *Providers* and add its callback
URL) needs only a `signInWithOAuth` button.

The game works unchanged without any of this: the "Chat & Study" choice and the Class
Materials section only appear when `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`
are set.

## Tutoring knowledge, search, preferences, thinking

**Teachers need only a name + class.** The Create/Edit NPC form no longer has Greeting,
Personality or Teaching instructions. Every teacher introduces itself, teaches at the level the
class name suggests, explains step by step and asks follow-up questions. Older NPCs keep their
saved values (the columns and local fields are untouched and still used in the prompt).

**Three knowledge sources** (`tutorPrompt.ts`):
1. *Class materials*: retrieved excerpts (notes, PDFs, images, saved websites) come first for
   coursework questions and are cited (`sources`, verified against retrieved chunks).
2. *General knowledge*: general educational questions are always answered, never refused for
   missing coursework; the model reports `general_knowledge` and the UI labels it.
3. *Google Search*: offered only when the message asks for research or recent information
   (`wantsWebSearch`); the model then decides automatically whether to query. Basics,
   definitions and arithmetic never trigger it. Citations come only from
   `groundingMetadata.groundingChunks` (https, de-duplicated, max 6); Google's Search
   Suggestions are shown in a sandboxed iframe for grounded answers. Budget: 3/min and
   25/day per student (`SEARCH_LIMITS`); over budget the teacher says it couldn't check
   online. If the model rejects the search request, the turn is retried once without it and
   the reply says current information could not be verified (`web_search: 'failed'`).
   `TUTOR_WEB_SEARCH=off` (secret) disables search entirely.

**Topic control (regression: Khan Academy link -> "probability").** The latest student message
decides the topic. The class is the teacher's specialty, not a restriction. Memory
(`current_topic`, summary) and the class "needs practice" list are labelled background only
and are never used to steer back to old topics or suggest unrequested practice. Coursework
excerpts are marked "may be unrelated" (retrieval falls back to the newest material). The
prompt explains ambiguous phrasing ("can we not use the link" = they want to use it) and
"wdym X" (questioning the tutor's last reply: acknowledge and correct). Follow-up questions
are asked only when they help.

**Links in chat** (`website.ts` `referencedUrls` / `readWebPage`): links in the message (max
2), or the student's most recent link when the message mentions "the link / page / lesson",
are read BEFORE the tutoring call with URL context, so the retrieval status is known:
`[W1] ... READ` (study notes passed in) or `COULD NOT BE READ (reason)`, in which case the
teacher says so, says what the address suggests, offers labelled general-knowledge help and
asks for pasted text / screenshots. Same URL rules as website coursework. Budget: 4/min and
40/day per student. Links are never saved automatically: replies show a "Save to Coursework"
button. Labels come from evidence: Class Materials (verified excerpt refs), Web Source (page
actually read), Google Search (grounding returned sources), General Knowledge (model flag).
Saved history shows only evidence-based labels.

**Chat attachments (one "+" flow).** The composer's + button, drag-and-drop and pasted
screenshots fill one tray (`uploads.ts` `AttachmentTray`, also used for starting materials in
the NPC editor). On Send: images up to 4 MB go inline with that message only (`images`, max 3,
never stored); documents and larger images are uploaded PRIVATELY (student + this NPC),
processed, and only then is the message sent with `attachment_ids` (max 5). The server loads
those documents through RLS plus the NPC/player scope (`loadAttachments`), puts their text in an
`[A1]...` block ("explain this" refers to them), and cites them as "Your files". A failed send
keeps the draft and attachments; processed files are not uploaded again, and the same
`client_message_id` is reused, so a retry never duplicates the message. Unreadable uploads are
deleted and the message is not sent. Chat attachments are never class material.

**Natural behaviour.** Introduce yourself only in the first conversation; reply length matches
the question; answer directly when asked (guided hints only when the student wants them); no
game talk, no "From general knowledge" preambles (the UI shows sources). Tutor turns may use up
to 4096 output tokens (the old 1200 truncated long answers / medium thinking).

**Deployment (2026-11-14):** migrations `20261114050000_spellshot` and
`20261114060000_teaching_preferences` applied; npc-chat, class-documents and answer-dash
deployed with `supabase functions deploy ... --use-api` (verify_jwt stays false: functions verify
the JWT themselves). Live checks: `node tests/live/liveTutorKnowledge.mjs` (paced; set
`LIVE_PAUSE_MS`), `node tests/live/liveSearch.mjs`, `node tests/live/liveAnswerDash.mjs`.
Google Search grounding currently returns 429 "check your plan and billing" for this Gemini key;
search turns then answer without it and say current information could not be verified.

**Teaching preferences through chat.** The model adapts immediately to style requests. For a
lasting one it asks "Should I remember that?" and proposes it (`preference.action = propose`);
the server stores it as `pending_preference`. It is saved to `learning_preferences` only when
the NEXT turn confirms, and the saved text is the stored proposal, never new model text. Any
other turn clears the proposal. The model can no longer write preferences through the memory
update. Students review / forget / reset them in Chat > My Preferences
(`forget_teaching_preference`). Preferences only change teaching style, never the subject,
rules or access.

**Website coursework** (Coursework Library > Add Website, `class-documents` action
`website`): https only, no IPs / localhost / internal / metadata hosts / custom ports /
credentials, DNS must not resolve to private addresses. Google's URL context tool reads the
page once (our servers never fetch it); it counts as read only if `urlContextMetadata` reports
success (paywall / unsafe / error → clear message, nothing saved), and a redirect target must
pass the same URL rules. Stored: study notes in the model's words, key terms, at most 6 quotes
of at most 30 words, and the source URL (`extraction.kind = 'website'`), chunked like pasted
notes so tutoring and mini-games reuse it without re-fetching.

**Thinking** (`DEFAULT_THINKING` in `gemini.ts`, `thinkingConfig.thinkingLevel`): casual
chat MINIMAL, tutoring LOW, multi-step math/science or images MEDIUM, mini-game packs LOW,
image/website reading LOW. Override per task with the `GEMINI_THINKING` secret, e.g.
`{"tutoring":"medium"}`. Thoughts are never requested or shown. A 400 with thinking set is
retried once without it (no retry loops).

**Mini-games stay coursework-only**: Answer Dash / Spellshot never get Google Search; saved
websites count as coursework because they are stored notes.

**Deploy order**: apply `20261114060000_teaching_preferences.sql` (and
`20261114050000_spellshot.sql` if not yet applied) BEFORE deploying npc-chat, class-documents
and answer-dash; npc-chat reads `pending_preference`. Then run
`node tests/live/liveTutorKnowledge.mjs` (≈9 Gemini requests).

## FaceTime Tutor (LiveKit voice)

```
game "FaceTime Tutor" --JWT--> voice-session  (authorise student for NPC, create_voice_session,
                                               createDispatch(room, "eduroam-tutor", metadata = pairing id),
                                               return join-only token)
browser --token--> LiveKit room <-- agent "eduroam-tutor" (deployed on LiveKit Cloud)
agent --Bearer VOICE_AGENT_SECRET--> voice-agent  resolve (once) | search | end
```

- `voice_sessions` (migration `20261114070000`): server-only table; the pairing id is the row's
  random UUID; `create_voice_session` re-checks owner/member access in SQL; `claim_voice_session`
  is single-use and expires 120 s after the call starts. Room = `eduroam-<pairing id>`.
- The browser sends only `{ action: 'start', npc_id }`; the player comes from the JWT and the NPC
  is authorised server-side (foreign NPC = 404). The browser never sees the pairing id or any
  LiveKit secret; its LiveKit identity is random.
- `voice-agent` accepts ONLY a pairing id. `resolve` returns `npc {name, subject, class_name}`,
  `teaching_preferences`, `memory`, `progress`, `coursework {documents, excerpts}` (class material
  + that student's own private uploads for that NPC, never other classes or students) and
  `instructions` (voice prompt from the same tutoring rules). `search {query}` = coursework
  search scoped the same way (claimed, not ended, < 2 h). `end {summary, topics?}` merges the
  summary into `npc_memories` once (channel `facetime`).
- Agent side (its own code, not in this repo): read `ctx.job.metadata` (the pairing id), POST
  `{"action":"resolve","pairing_id":...}` to `https://<project>.supabase.co/functions/v1/voice-agent`
  with headers `Authorization: Bearer <VOICE_AGENT_SECRET>` and `apikey: <publishable key>`,
  use `instructions` (or the fields) as the system prompt, expose a `search_coursework(query)`
  tool that POSTs `action: "search"`, and on shutdown POST `action: "end"` with a 1-3 sentence
  summary of what was learned. Resolve within 2 minutes of dispatch.
- Secrets (Edge Functions): `LIVEKIT_URL` (wss://...), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
  `VOICE_AGENT_SECRET` (same value in the LiveKit agent's environment). Without them
  voice-session / voice-agent answer 503 `voice_not_configured` and nothing is created.
- Tests: `tests/backendDb.test.mts` (pairing rules, single use, Biology vs History scope, two
  students), `tests/voice.test.mts`, browser dash phase (menu + request shape),
  `node tests/live/liveVoice.mjs setup|agent <state.json>` (live, two students / two NPCs).

## Future channels: FaceTime / iMessage (Chert) and LiveKit

Every channel uses the same `npcs` identity, `npc_memories` row per (player, NPC),
`class_progress`, and the operations in `_shared/npcContext.ts`; conversations carry
`channel = 'game' | 'facetime' | 'imessage'`.

**Account pairing (designed, not implemented):**
1. In game, the signed-in player picks an NPC and taps "Link FaceTime". A server function
   creates a `channel_pairings` row with `player_id`, `npc_id`, `channel`, a SHA-256 of a
   short one-time code shown to the player, and `expires_at` (≈10 minutes).
2. The player says or sends that code during a call/message. Chert's **signed** webhook
   (signature verified server-side) submits the code plus the caller's provider identity.
3. The server matches an unexpired, unrevoked row by code hash, stores an HMAC of the
   provider identity (`external_identity_hash`, secret pepper) and `verified_at`.
4. Later calls resolve the HMAC → active pairing → (player, NPC). A caller's phone number
   alone never identifies a player; unverified callers get no access and nothing is stored.
   Players can revoke a pairing (`revoked_at`).

**LiveKit voice agents** run server-side: they resolve the player through a verified pairing
and `resolveNpcIdentity`, then call `runTutorTurn` (`_shared/tutorService.ts`) with
`channel: 'facetime'`, which gives them the same coursework, search, preferences and memory as
text chat. The lower-level operations it uses are `resolveNpcIdentity` → `retrieveStudentMemory` → `loadClassKnowledge` →
`retrieveConversationContext` with the admin client (`match_npc_chunks` accepts
`p_player_id` only when there is no user JWT), and persist each turn or a turn summary with
`saveConversationTurn(..., channel: 'facetime')`. Raw audio never goes through the
document-processing function.

## Tests

| Command | Covers |
|---|---|
| `npm test` (`tests/backendDb.test.mts`) | The real migration in PGlite: RLS isolation, class/NPC-scoped retrieval, private uploads, server-only writes, 10-NPC limit, atomic turn saving, memory separation, rate limits, storage policy, NPC class changes |
| `npm test` (`tests/tutorBackend.test.mts`) | Validation, upload rules, chunking, Gemini context, subject focus, source refs, memory merge, Gemini retries/timeouts/error codes |
| `npm run test:browser:auth` | Real game + supabase-js against an in-page fake Auth API: code login unlocks the open panel without restart, invalid/short/expired codes, resend cooldown, reload restores session + history, sign-out, HTTP 429 at phone width |
| `npm test` (`tests/authFlow.test.mts`) | Email/code validation, cooldown, auth error messages, redirect URL handling |
| `npm run test:edge` | Deno: real PDF/DOCX/TXT extraction + invalid files |
| `npm test` (`tests/tutorKnowledge.test.mts`) | Default teacher behaviour, relaxed knowledge rules, search routing, web citations from grounding only, thinking levels + one-time fallback, preference confirmation, website URL safety + retrieval verdicts |
| `npm test` (`tests/tutorTopicFlow.test.mts`) | The Khan Academy regression conversation: link read via URL context, honest failure wording, "the link" re-read, "wdym probability", topic switching/returning, login/paywall/broken/private/http/redirect links |
| `node tests/live/liveTutorKnowledge.mjs` | LIVE (after deploy): intro, general answer, Google Search citations, preference confirm/reset, website save + retrieval, unsafe URLs rejected |
| `node tests/browserScreens.mjs [outDir]` | Screenshots of the real chat panel and NPC editor (stubbed backend) at 1280x800 and 390x844 |
| `npm run check:edge` | Deno type check of the three Edge Functions |


## Answer Dash (mini-game)

`answer-dash` Edge Function: `start` builds ONE Gemini question pack from the NPC's authorised, ready
documents (sampled chunks; or labelled subject practice), validates it strictly
(`_shared/questionPack.ts`: 4 distinct choices, one correct index, explanation, topic, difficulty,
real source excerpt when grounded), shuffles answer positions and stores the session with keys in
`minigame_sessions.questions` (not selectable by players). The browser gets questions without keys.
`answer` records the first answer per question and returns correctness + explanation; `finish`
grades from stored answers only, saves once, and merges weak/mastered topics into `class_progress`
and the NPC's `npc_memories`. Difficulty: 30/50/20 intro/standard/challenging, shifted one step by
recent accuracy, level taken from the material (8th grade only when unclear).

## Spellshot (mini-game)

Same `answer-dash` function and session table, started with `{ action: 'start', game: 'spellshot',
choices: 3-5 }` (migration `20261114050000_spellshot.sql` adds the game type and bounds each answer by
that question's own choice count). Rules live in `GAMES.spellshot` (`_shared/questionPack.ts`): Gemini
writes 24 short recognition prompts (vocabulary, definitions, "what does X do"; no calculations or
figures) with 5 choices each (max 32 chars); the server keeps the correct answer + `choices - 1`
random distractors and shuffles. Grading: 100 + 20 per combo step (max +100), wrong shot -40 (score
never below 0); unanswered prompts when the 60-second clock ends are not counted. Client: scene
`src/game/minigames/spellshot/SpellshotScene.ts`, overlay `src/game/ui/SpellshotHud.ts`, rules
`spellshotLogic.ts` (wisp speed is client-only: gentle/brisk/swift, ramping with combo and time).
