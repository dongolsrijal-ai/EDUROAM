# EDUROAM backend handoff

Last updated: 2026-11-14 (Answer Dash added; see bottom section)

## Architecture (short)
Phaser game (local saves in localStorage) → Supabase Auth (email 6-digit OTP or guest) →
tables with RLS (classes, npcs, class_documents, document_chunks, conversations, messages,
npc_memories, class_progress, …) + private Storage bucket `class-materials` → Edge Functions
`class-documents` (upload/process/delete) and `npc-chat` (context → Gemini → save turn).
Full design: `docs/ai-tutoring-backend.md`. Reusable channel operations (future LiveKit/Chert):
`supabase/functions/_shared/npcContext.ts`.

## Live project
EDUROAM, ref `horhkariflujndhttrhr`. CLI: v3.1.0 from the npx cache
(`C:\Users\dongo\AppData\Local\npm-cache\_npx\a2642d082f752488\node_modules\@supabase\cli-windows-x64\bin\supabase.exe`),
already logged in and linked. Hosted commands need `--remote` and `--yes`.

## Migration status (remote = local)
- 20261114000000_npc_tutoring.sql — applied
- 20261114010000_fix_classes_select_policy.sql — applied this session (fixes RLS error on class upsert)
- 20261114020000_harden_function_exposure.sql — applied this session (helpers moved to `private`, trigger fns not executable by API roles)

## Deployment status
- npc-chat v2 ACTIVE (this session: NPC authorised before Gemini config check)
- class-documents v2 ACTIVE (redeployed with current code)
- verify_jwt=false on both by design: every request is verified with `auth.getUser(token)`;
  live test confirms 401 for missing/invalid JWT and for the publishable key as bearer.
- Secrets: **GEMINI_API_KEY is NOT set** → npc-chat returns 503 `ai_not_configured`.

## Live verification (tests/live/liveE2E.mjs): 34/34 passed
Auth rejection, guest sign-in, trigger, class/NPC upsert, no duplicates, PDF upload → ready →
retrieval of real text, class isolation, cross-user isolation (read, retrieve, download, process,
upload, chat), private worksheet privacy, privileged RPC removed. Gemini reply: BLOCKED (secret).
Each run creates 2 guest users with game_npc_id `e2e_math` / `e2e_science`.

## Next commands
```sh
SB=/c/Users/dongo/AppData/Local/npm-cache/_npx/a2642d082f752488/node_modules/@supabase/cli-windows-x64/bin/supabase.exe
"$SB" secrets set GEMINI_API_KEY=<key>      # user must run; never paste keys into chat
node tests/live/liveE2E.mjs                  # then Gemini checks run instead of BLOCKED
```

## Changes this session
- Applied migrations 0100 + 0200 to production (dry run reviewed first; non-destructive).
- `supabase/migrations/20261114020000_harden_function_exposure.sql` (new).
- `supabase/functions/npc-chat/index.ts`: resolve/authorise NPC before Gemini-key check; deployed v2.
- `class-documents` redeployed (v2) with current code.
- `src/game/services/tutorApi.ts`: RLS 42501 → retryable "forbidden" error (no longer shows sign-in while signed in).
- `src/game/services/backend.ts` + `src/game/ui/SignInBox.ts`: guest button only when `/auth/v1/settings` reports anonymous sign-ins.
- `tests/runLifecycle.test.mts`: canonical Vite root (fixed the 4 long-standing failures; game code unchanged).
- `tests/backendDb.test.mts`: hardening test; `tests/live/liveE2E.mjs` (new); auth browser test checks guest gating.
- Earlier in this workstream (already in repo): email OTP + 429/Retry-After handling, session lifecycle, classes RLS fix.

## Working (verified)
Auth rejection on both functions; guest sign-in; player trigger; class/NPC sync without RLS error or
duplicates; PDF → ready → retrieval; class and cross-player isolation; private uploads; storage
privacy; privileged helpers not callable via API. Local: OTP UI flow, reload restore, 429 handling,
memory/turn-save SQL, Gemini error handling, extraction, gameplay smoke.

## Active problems / blockers
1. **GEMINI_API_KEY not set** → no live AI replies, so live memory persistence is also unverified.
   The default model id `gemini-3.5-flash-lite` (from current docs) is unverified against this key;
   override with secret `GEMINI_MODEL` if the API returns 404/400 (function maps it to `config`).
2. Email OTP delivery: built-in SMTP quota is tiny; template must contain `{{ .Token }}` (dashboard).
3. Advisor: "leaked password protection" off (passwords unused; optional).
4. Live test data: each `liveE2E.mjs` run leaves 2 guest users + e2e NPCs/docs (run 1 done this session).
   Clean-up (SQL editor, only test data): `delete from public.npcs where game_npc_id like 'e2e_%';`
   then delete the anonymous test users in Auth → Users (filter anonymous, created today) if desired.

## Test results (end of session)
tsc OK · npm test 82/82 · build OK · browser smoke PASS · browser auth 3/3 PASS · Deno 4/4 ·
live E2E 34/34 (Gemini step BLOCKED).

## How to resume
1. Read this file + BACKEND_STABILIZATION_CHECKLIST.md + docs/ai-tutoring-backend.md.
2. User sets the secret: `"$SB" secrets set GEMINI_API_KEY=<key>` (optional `GEMINI_MODEL=...`).
3. `node tests/live/liveE2E.mjs` → Gemini, source refs, memory and per-NPC checks run live.
4. If model errors: check Dashboard → Edge Functions → npc-chat → Logs (function logs were not inspected this session).
5. Dashboard (user): email templates `{{ .Token }}`, custom SMTP, Site URL/redirects for the hosted URL.


## Answer Dash mini-game (added 2026-11-14)
- NPC dialogue: Chat & Study / Mini-games / Goodbye (`src/game/npcs/conversation.ts`); the Create/Edit NPC
  Mini-game dropdown is gone (saved `minigameType` kept; such NPCs list their old quiz in the picker).
- Picker: `src/game/ui/MinigamePanel.ts`. Game: Phaser scene `src/game/minigames/answerDash/AnswerDashScene.ts`
  (launched over the PAUSED world scene) + DOM overlay `src/game/ui/AnswerDashHud.ts`; art `src/game/art/answerDashArt.ts`;
  results/study/daily reward `minigames/answerDash/results.ts` (`claimRewardOnce` in playerState).
- Backend: Edge Function `answer-dash` (start/answer/finish), pure logic `_shared/questionPack.ts`,
  `generateStructured` in `_shared/gemini.ts`. Migration `20261114030000_minigame_sessions.sql` (applied):
  `minigame_sessions` (answer keys in a column players cannot SELECT), `record_minigame_answer` (service only, first answer wins).
- Deployed: answer-dash v1 ACTIVE. GEMINI_API_KEY + GEMINI_MODEL secrets are set (Gemini verified live).
- Tests: `tests/answerDashPack.test.mts`, DB test in `tests/backendDb.test.mts`, browser phase `tests/browser/dashPhase.ts`
  (run by `npm run test:browser:auth`), live `node tests/live/liveAnswerDash.mjs` -> 26/26 (pack in ~4 s, grounded in the PDF).
- Results this session: tsc OK, npm test 91/91, build OK, smoke PASS, browser auth+dash 4/4 phases, Deno 4/4,
  live tutoring 38/38, live Answer Dash 26/26.
- Live tests create guest accounts + `e2e_*` NPCs each run (clean-up note above also covers `e2e_dash_*`).
- Not done / ideas: more mini-games (Sorting Garden etc. intentionally not built); abandoned sessions stay `active`
  (harmless; could be swept); phone-width layout verified via CSS + iframe auth test, not a dedicated dash iframe test.

## Coursework Library, images, document-only mini-games (added 2026-11-14)
- Migration `20261114040000_coursework_library.sql` (APPLIED after dry run): `class_documents.file_type` now also
  png/jpeg/webp/heic/text (pasted); new `topic`, `chapter`, `extraction` (jsonb: kind, needs_review, uncertain[], figures,
  corrected); bucket `class-materials` stays private, 10 MB, MIME list adds PNG/JPEG/WEBP/HEIC/HEIF.
- `class-documents` v7: create/paste/process/update/correct/view/delete. Images are read by Gemini vision
  (`_shared/vision.ts`: text, math, figure descriptions; unreadable parts -> `[?]` + needs_review). Pasted text is stored
  as a real .txt original and runs through the same chunking pipeline. `view` returns a 5-min signed URL + extracted text.
  Logs contain ids/codes only (no coursework content).
- `npc-chat` v7: optional image per message (<=5 MB, signature-checked), sent to Gemini for that turn only; history stores
  "[Image attached] <question>"; saving to the library is an explicit, separate private upload from the UI.
- `answer-dash` v2: NO general/subject mode (400). Source = 'all' or a list of document ids. Batched retrieval
  (bounded chunks per document, round-robin `sampleAcrossDocuments`). Prompt prefers short conceptual questions; a
  question may set `figure` only to an (IMAGE) excerpt -> served with a 30-min signed URL; bad figure labels reject the question.
- UI: `src/game/ui/CourseworkLibrary.ts` (upload files incl. images, Paste Text with title/topic/chapter, group by
  topic/chapter/type, statuses, Preview w/ original image + correctable transcription, Edit, Replace, Delete).
  Entry points: NPC editor (Create: files + "Paste notes instead"; Edit: "Open Coursework Library"), Chat & Study
  "Class Materials", mini-game picker ("Add Coursework" when nothing is ready; multi-select checkboxes).
  Chat: 📷 attach or paste screenshot, preview, opt-in "Also save to my Coursework Library".
  Answer Dash HUD shows figures (click to enlarge).
- Tests: `tests/coursework.test.mts` (new), DB migration test, browser dash phase (no general mode, Add Coursework ->
  paste, multi-select, Gemini error, figure + lightbox, chat image attach), live `node tests/live/liveCoursework.mjs`
  (fixtures in tests/live/fixtures) -> 23/23 on 2nd run. First run: one whole-library pack returned no questions
  (error not captured; did not recur) - watch for `bad_pack`/timeouts with large mixed libraries.
- Results: tsc OK, npm test 100/100, build OK, smoke PASS, browser 4/4 phases, Deno 4/4, live tutoring 38/38,
  live coursework 23/23. `tests/live/liveAnswerDash.mjs` updated (subject mode now expects 400; not re-run this session).
- Limits/notes: 80 documents per NPC; pasted text <= 200k chars; HEIC accepted (Gemini supports it) but not live-tested;
  browsers may not preview HEIC thumbnails. Live tests add guest users + `e2e_cw_*` NPCs each run.

## Combat crash fix, death state, dungeon layout + Hades revamp (2026-11-14)
- CRASH ROOT CAUSE (CombatController.update, "reading 'x'"): the enemy-shot loop iterates a COPY of the
  shots group; a lethal soul-fire hit ran die() -> shots.clear(true,true), destroying the remaining shots in
  that copy; Phaser drops a destroyed object's data, so getData('start') was undefined -> TypeError inside the
  rAF callback -> Phaser's loop stopped (frozen game, wall-clock timer kept running).
  Fix: loops skip destroyed entries and stop after death; die() idempotent; boss defeat clears its soul-fire
  and warnings; same-moment deaths resolve deterministically (player death wins, no guardian/boss reward).
  Regression tests in tests/combat.test.mts reproduce the exact error before the fix (test Phaser stub now
  drops data on destroy, like Phaser).
- Death state: overlay has Retry Dungeon (same run, current floor, full HP; claimed chests stay claimed) and
  Return to Village (run abandoned: no boss reward, no tower advance; break ends -> next focus). Dungeon clock
  is frozen while dead (pomodoro.hold/release, persisted `heldAt`); a run saved at 0 HP reopens the death
  screen on load (CombatController.killPlayer()).
- Dungeon generation: rooms are specs rendered to ASCII (src/game/world/dungeon/rooms.ts: standard 21x15,
  large 23x17, ranged arena 23x15, summoner arena 21x17, treasure/rest/exit/start 15x11, boss 31x23) with
  clear door lanes; generate.ts places tile rectangles with 3-tile corridors (no overlaps, aligned doors);
  fewer rooms (non-final floors: 2 combat [3 on 2-floor runs] + treasure + optional shrine; final: 1-2
  combat + boss arena). build.ts carves walled corridors. Floor detail tiles reduced for readability.
  tests/dungeonGen.test.mts validates ~2,400 floors per run: overlaps, alignment, counts, sizes, compact
  footprint, flood-fill reachability of spawn/exit/boss/chests/shrine/slots/doors, boss-centre clearance,
  spawn-to-door distance, door lanes in every template.
- Hades art: 5-frame 16x16@3x sheet (idle x2, cast, summon, collapse) - crown, hooded skull, violet collar,
  tattered robe, cursed staff with soul-fire; subtle aura + embers (Hades.ambience, destroyed with him).
  Hurtbox unchanged (32x42, body cols 1-12; staff is outside it).
- answer-dash 502 ROOT CAUSE (production logs): Gemini 503 "model is currently experiencing high demand";
  the function retried once immediately and returned 502. Now: up to 3 attempts with 1.5 s/3 s backoff,
  falls back to the default stable model on overload when GEMINI_MODEL differs, and reports overload as a
  retryable 503 with a clear message. Shared Gemini retry backoff for overload raised to 1.5 s.
  Deployed: answer-dash v3, npc-chat v8 (not live-retested this session; overload is intermittent).
- Results: tsc OK, npm test 105/105, build OK, browser smoke PASS (hub, gates/waves, portal, Next Tower,
  Hades, chests, completion, reload), browser auth+dash 4/4.
- Not done: no dedicated multi-tower-level visual Hades playtest beyond tests (scaling code unchanged);
  void space now biome-tinted and much smaller (compact layout), camera logic unchanged.

## NPC limit fix + orphaned NPC records (2026-11-15)

**Root cause of "NPC limit reached (10/10)" on FaceTime Tutor / chat:** `syncNpc` saves NPCs with
`INSERT ... ON CONFLICT (owner_id, game_npc_id) DO UPDATE`. BEFORE INSERT triggers run before the
conflict is detected and the payload has a fresh id, so `enforce_npc_limits` counted 10 existing
rows + 1 = 11 and aborted what was only an update of an existing NPC. Any account with exactly 10
backend NPCs could no longer re-sync any of them (each page load re-syncs before chat or a call).
Fixed by migration `20261114080000_npc_limit_upsert.sql` (applied): upserts of an existing NPC /
class are not counted; real inserts are limited exactly as before. Voice calls no longer sync at
all: `findRemoteNpc` is a read-only lookup (an unsynced teacher gets a clear message).

**Why an account has backend NPCs that are not in the village:** NPCs deleted in-game while signed
out, a cleared browser / other device (new local ids), or test NPCs. The backend copy (with its
coursework, conversations and memories) stays. Nothing deletes these automatically.

Review (read-only; run in the SQL editor, replace the owner id):
```sql
select n.id, n.game_npc_id, n.name, n.subject, n.created_at, n.updated_at,
  (select count(*) from public.class_documents d where d.npc_id = n.id) as documents,
  (select count(*) from public.conversations c where c.npc_id = n.id) as conversations,
  (select count(*) from public.npc_memories m where m.npc_id = n.id) as memories
from public.npcs n where n.owner_id = '<owner uuid>' order by n.created_at;
```
Compare `game_npc_id` with the village (browser devtools: `JSON.parse(localStorage.getItem('eduroam.npcs'))`
or the NPCs list). Cleanup ONLY for ids the owner explicitly approves. Deleting an NPC also
deletes its conversations, memories and NPC-specific documents/chunks (cascade); the stored
files then need removing from the `class-materials` bucket (paths in `class_documents.file_path`,
collected BEFORE the delete):
```sql
begin;
select file_path from public.class_documents where npc_id in ('<approved id>', ...);  -- save this list
delete from public.npcs where owner_id = '<owner uuid>' and id in ('<approved id>', ...);
-- check the row count, then: commit;  (or rollback;)
```

## Accounts + Supabase-backed village (2026-11-16)

- **Sign-in:** email + password (sign in / create account with email confirmation), Play as guest
  (anonymous), and the existing one-time email code as the fallback for a forgotten / unset password.
  Account button at the top right (manager bar). A guest keeps everything by adding an email
  (`updateUser({ email })` -> confirm via link or `email_change` code -> set a password): the
  account id never changes, so NPCs, classes, coursework, memories and scores all stay.
- **Source of truth:** `npcs.game_state` (migration `20261116000000_npc_game_state.sql`, additive)
  holds placement, building, dialogue, mini-game and completion. `services/npcSync.ts` loads the
  account's village on login; `npcStore` keeps a per-account cache (`eduroam.npcs.account.<id>`)
  and refuses edits until the first load succeeds. Signed out, the village is this device's own
  save (`eduroam.npcs`), untouched by sign-in.
- **One-time import:** the first account to sign in on a browser gets that browser's signed-out NPCs
  (`eduroam.npcs.legacyClaimedBy` records who). Never tombstoned ones; never the built-in defaults.
  A brand-new account (no NPCs, no deletions) is seeded with the default NPC.
- **Auth settings to check in the dashboard:** email confirmations are ON (sign-up needs the email);
  add the game's URL(s) to Auth -> URL Configuration -> Redirect URLs so confirmation links return to
  the game; the built-in email sender is rate-limited (set up SMTP for real use). For the code-entry
  option, the "Confirm signup" and "Change email address" templates must include `{{ .Token }}`
  (the links work either way).

## LiveKit + Chert FaceTime (one agent, one shared line) — 2026-11-16

### How it works
- **One agent** `eduroam-tutor` (agent/agent.py, Python, Gemini Live) serves every teacher. It joins every room with
  participant identity `eduroam-tutor` (`JobRequest.accept(identity=...)`), which Chert's bridge must name exactly.
- **In-game call** ("FaceTime Tutor" -> "Call in game"): `voice-session` authorises the student + NPC, creates a single-use
  pairing, dispatches `eduroam-tutor` with only the pairing id; the agent `resolve`s it at `voice-agent` before speaking.
  Mic + optional camera (Gemini Live video input, `RoomOptions(video_input=True)`, default sampling ~1 fps while speaking).
- **Shared Chert line** ("Call on FaceTime"): Chert **Bring Your Own Room**. `voice-session` (mode `facetime`) returns a
  single-use 6-digit code (5 min, hash stored) + the real line address from `CHERT_FACETIME_ADDRESS`. Chert posts
  `call.incoming` to `chert-webhook`, which creates room `eduroam-ft-<uuid>`, dispatches `eduroam-tutor` with
  `{"facetime_call": <id>}` and accepts with a room-scoped bridge token (integer nbf/exp, <= 2 h). The agent starts
  **locked** (generic greeting, no teacher, no coursework), asks for the code, `voice-agent pair` checks it (5 tries per
  call, single use, newest code per student) and only then becomes that teacher. Caller audio/video arrive as the
  bridge's `facetime-remote-audio` / `facetime-remote-video` tracks (video only if caller capture is enabled on the line).
- **Tools** (all through the protected `voice-agent` endpoint, `Authorization: Bearer VOICE_AGENT_SECRET`):
  `pair_with_code`, `get_npc_context`, `search_coursework`, `get_learning_progress`, `save_session_summary`.
  End of call: summary saved once to that student's `npc_memories` (channel `facetime`), so Chat & Study remembers it.
  No audio, video or transcript is stored.
- Why BYOR and not `chert dev` / the open-source connector: `chert dev` (managed-line CLI) is macOS/Linux only and its
  waiting rooms carry no EDUROAM pairing; the open-source connector (`npx @trychert/facetime-opensource`) is tested only
  on macOS and needs a FaceTime link + iPhone per call. BYOR runs entirely on Supabase + LiveKit Cloud (works from Windows).

### Deploy (in order)
1. **Database** (additive): apply `20261116000000_npc_game_state.sql` and `20261116010000_facetime_pairing.sql`
   (`npx supabase@3.1.0 db push`, or paste them into the SQL editor). Both were blocked for me by the permission check.
2. **Secrets** (Supabase Dashboard -> Edge Functions -> Secrets; never VITE_ / browser):
   - `VOICE_AGENT_SECRET` = a new random value (e.g. `openssl rand -hex 32`) — **missing today**
   - `CHERT_WEBHOOK_KEY` = another random value (goes in the webhook URL below) — missing
   - `CHERT_FACETIME_ADDRESS` = the assigned line's FaceTime address exactly as the Chert dashboard shows it — missing
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — **present** (set 2026-11-15)
3. **Functions**: `npx supabase@3.1.0 functions deploy voice-session voice-agent chert-webhook --remote=horhkariflujndhttrhr --use-api`
4. **Agent** (LiveKit Cloud): open Agents -> `eduroam-tutor` (Agent Builder) and note its model, voice and greeting;
   **Download code** and copy its `livekit.toml` into `agent/` so the deploy updates the SAME agent (same name, no second
   agent). Install the CLI (`winget install LiveKit.LiveKitCLI`), `lk cloud auth`, then in `agent/`:
   `lk agent update-secrets --secrets GOOGLE_API_KEY=... VOICE_AGENT_SECRET=... EDUROAM_VOICE_AGENT_URL=https://horhkariflujndhttrhr.supabase.co/functions/v1/voice-agent GEMINI_VOICE=<builder voice>`
   and `lk agent deploy`. (Agent Builder cannot do vision, so the code agent replaces it.)
   Local test first if you like: `agent/.env.local` from `.env.example`, `uv run agent.py dev` with
   `LIVEKIT_AGENT_NAME_OVERRIDE=eduroam-tutor-dev` so the deployed agent keeps production dispatches.
5. **Chert**: Workers & Lines -> Integration: Bring Your Own Room, decision mode `customer_decides`, **no default
   Assistant**, webhook `https://horhkariflujndhttrhr.supabase.co/functions/v1/chert-webhook?key=<CHERT_WEBHOOK_KEY>`.
   Ask Chert to confirm caller-camera capture on the line if you want worksheets over FaceTime.

### Verification (actual results, 2026-11-16)
| Stage | Result |
|---|---|
| A Login | Local browser tests pass (register/confirm, password, guest upgrade, switch, refresh, other browser). Live needs migration 1. |
| B Session | **Live: PASS** — voice-session authenticates, refuses other students' NPCs (404), creates the pairing. |
| C Dispatch | **Live: PASS** — voice-session returned 201 with a join token (it returns 502 if LiveKit refuses the `eduroam-tutor` dispatch). |
| D–F, H | Pending: agent code is written and unit-tested (11 Python tests) but not deployed (no LiveKit CLI login / `GOOGLE_API_KEY` / `VOICE_AGENT_SECRET` here; installing the SDK locally was blocked). |
| G Switching NPCs | DB + live auth checks: each pairing resolves only its own student + NPC; agent `resolve` live check (`tests/live/liveVoice.mjs agent`) needs VOICE_AGENT_SECRET. |
| I–M FaceTime | Pending Chert BYOR configuration + secrets above. Webhook/token/pairing logic unit- and DB-tested (no simulated call). |
| N–O Memory | `end` saves once to npc_memories (existing DB/live tests); Chat & Study reads the same memory. Live pending secret. |
| P No duplicates | Browser tests: starting a call (either mode) writes 0 NPC rows; each call gets a fresh pairing / room. |
| Q Isolation | **Live: PASS** cross-student refusals; DB tests: a code opens only its own student's NPC, once, 5 tries max. |

## Sign-in gate + keyboard isolation (2026-11-16)
- `src/main.ts` -> `game/app.ts startApp`: full-screen gate (`ui/AuthGate.ts`) first; the Phaser game is created only
  after `verifiedSession()` (getSession + getUser on the Auth server) confirms a non-guest account. Reload with a valid
  session goes straight in; a rejected/expired one is signed out locally and the login is shown. Sign-out (any tab)
  closes an active call, locks input, pauses the game and reloads the page (local saves are kept).
- No guest button any more. An existing guest session gets "Keep your guest progress" (same account id) or can sign out.
- Password reset: `resetPasswordForEmail` (link back to the game, or the code from the email) -> "Choose a new password"
  before the game starts. The "Reset Password" email template needs `{{ .Token }}` for the code option; links work as is.
- Progress is per account on a browser: `eduroam.player|dungeon|tower|conversations` become `<key>.account.<userId>`
  (`data/storage.ts scopedKey`). A game saved before accounts is OFFERED once after sign-in ("Add To My Account" copies
  it, originals kept; "Start Fresh" copies nothing). npcSync imports browser NPCs only after that explicit choice.
- Keyboard: `input/inputGuard.ts` disables Phaser's KeyboardManager (no key handling, no key capture) and releases held
  keys whenever any text field has focus or the gate is up; window-level shortcuts check `gameKeysAllowed(event)`.

## In-game voice tutor: root cause + fix (2026-11-15)

**Root cause (confirmed live, 2026-11-15).** voice-session works: it authenticates the student, checks NPC
access, creates a `voice_sessions` pairing and dispatches the agent name `eduroam-tutor` with the pairing id
as metadata. The only worker registered under that name is the **Agent Builder** deployment
`CA_DsfmFTRP5ir5` (renamed from `Hackathon`; production version `D7oWfRw56Syz`, attribute
`agent_builder_version`). Its generated entrypoint accepts the job and talks on LiveKit Inference with
its own fixed prompt. It never reads the metadata and never calls voice-agent. Evidence: every
`voice_sessions` row has `claimed_at = null`, voice-agent has no requests in the function logs, and
the agent logs show "received job request" followed straight by a session with no backend calls.
Agent Builder cannot do this job anyway. Its variables need JSON metadata, it has no pre-session
claim step, and it does not support vision (docs.livekit.io/agents/start/builder, "Limitations").
The custom Python agent (agent/agent.py), which does all of this, was never running.

**Fix.** The custom agent runs **self-hosted** under its own dispatch name, so it doesn't need the
Cloud agent slot (1/1, held by Builder). Server dispatches follow the Supabase secret
`VOICE_AGENT_NAME` (voice-session + chert-webhook). Unset it and the Builder agent gets calls again.
The Builder agent stays untouched.

Other changes:
- Voice prompt: a fixed identity rule ("your name is <NPC>", never Gemini, Hackathon or an assistant).
- Search: says when nothing was found or a file is still processing; the document list marks
  files that aren't processed yet.
- Search responses carry `not_ready` and `note`.
- The game ends a call after 30 s if no tutor joins ("the voice tutor is offline"). It no longer
  shows "Waiting…" forever.

**Run it (Windows PowerShell)**: see the final report of this task. Short form:
`agent/.env.local` (LIVEKIT_*, GOOGLE_API_KEY, VOICE_AGENT_SECRET = the Supabase value,
LIVEKIT_AGENT_NAME_OVERRIDE=eduroam-tutor-code) → `python agent.py start` →
`npx supabase secrets set VOICE_AGENT_NAME=eduroam-tutor-code` → deploy voice-session, voice-agent
and chert-webhook. A permanent LiveKit Cloud deployment needs the slot: delete the Builder agent
(owner's decision) or a higher plan, then `lk agent create` from agent/.

**Tests**:
- agent/test_agent.py (8; needs the SDK): persona per NPC, NPC switch, search, progress, summary,
  locked or expired pairing, camera, and the override.
- tests/voice.test.mts (+3).
- Live: `node tests/live/liveVoice.mjs setup|agent` (needs VOICE_AGENT_SECRET).

## Email codes + password reset (2026-11-15)

**Root causes (from the live auth logs and settings).**
- **"Send Code" emailed a link.** `signInWithOtp` sends whatever the project's email template contains, and the
  default **Magic link** and **Confirm signup** templates contain only `{{ .ConfirmationURL }}`. The code also used
  `shouldCreateUser: true`: an unknown address silently got a NEW account and a "confirm signup" (join) email.
- **Password reset.** The reset email had only a single-use link, while the game asked for a code. The logs show the
  link opened once from another device/IP (06:05:39 UTC). That used up the token, so every later click failed with
  `403 One-time token not found`. The game also ignored the `?error_code=otp_expired` redirect and just showed the
  sign-in form with no explanation. Recovery state was in memory only, so a refresh skipped "choose a new password".
- Site URL is still the default `http://localhost:3000`. localhost:8080/8081/5173 are already allowed redirects
  (checked with invalid-token probes, no email sent).

**Now.**
- **Sign-in code:** `signInWithOtp({ shouldCreateUser: false })` then `verifyOtp({ type: 'email' })`. Unknown
  addresses get the same answer and no account. There's a 60 s resend cooldown that also honours Supabase's
  "after N seconds" limit and Retry-After. Expired, wrong, rate-limit and delivery errors each get a clear message.
- **Reset:** `resetPasswordForEmail(redirectTo: this page)`, then EITHER the 6-digit code (`verifyOtp({ type: 'recovery' })`)
  OR the link (`PASSWORD_RECOVERY`; also matched by access token on load). That marks a per-account reset in
  progress (localStorage, account id only), so a refresh stays on "Choose a new password". `updateUser({ password })`
  runs only for that account. A normal sign-in clears any stale marker.
- Templates: `supabase/templates/*.html` (local `config.toml` uses them; the hosted project needs the dashboard).

**Dashboard (hosted project, not applied by code).**
1. Authentication → Emails → Templates: paste subject + body from `supabase/templates/` into **Magic link**
   (`magic_link.html`), **Confirm sign up** (`confirmation.html`), **Reset password** (`recovery.html`) and
   **Change email address** (`email_change.html`).
2. Authentication → Sign In / Providers → Email: keep **Confirm email** on; **Email OTP Length = 6**;
   **Email OTP Expiration = 3600**.
3. Authentication → URL Configuration: **Site URL** `http://localhost:8080` (or the deployed URL). Keep the localhost
   redirect URLs; add `https://<deployed-host>/**` when deployed.
4. Built-in email is for testing only (very low hourly limit). For students: Authentication → Emails → SMTP Settings.

**Tests (mocked Supabase, no email sent).** Browser phases `gate-code`, `gate-reset`, `gate-reset-reload`,
`gate-reset-login`, `gate-link`, `gate-link-expired`; unit tests in `tests/authFlow.test.mts`.
`EDUROAM_PHASES=gate-code node tests/browserAuth.mjs` runs selected phases.

## Agent Builder metadata for in-game calls (2026-11-15)

voice-session now dispatches the hosted Builder agent `eduroam-tutor` with JSON metadata holding its six
registered fields: `npc_name`, `subject`, `personality`, `teaching_style`, `coursework` and `learning_memory`.
- The values come from `loadBuilderMetadata` (npcContext.ts), using the student's own RLS-scoped client:
  resolveNpcIdentity, then retrieveStudentMemory, then loadClassKnowledge.
- Each field is capped; the whole JSON stays under 6 KB. No ids or tokens are included.
- If the Supabase secret `VOICE_AGENT_NAME` is set to anything else (e.g. `eduroam-tutor-code`), the old
  opaque pairing id is sent for the Python worker instead.
- The Builder agent never claims the pairing, so voice-agent search and the end-of-call memory save are
  not used on Builder calls.
- Deployed as voice-session v16: a single esbuild bundle of the function and its `_shared` modules,
  with the `npm:` imports kept external.
- Tests: `supabase/functions/tests/voice_builder_test.ts` (`npm run test:edge`).

## AI tutor: phases 1-3 (2026-11-15)

**Phase 1.** Audit plus the Git checkpoint `checkpoint-pre-ai-tutor` (c721988, deployed state).
- Python worker: claimed 3 real in-game calls.
- Builder `eduroam-tutor` (`CA_DsfmFTRP5ir5`) redeployed 08:20 UTC.
- No assignment, calendar or reminder tables existed.

**Phase 2 (code + tests; NOT deployed).**
- Migration `20261117000000_tutor_assignments.sql` (expand-only):
  - `assignments` (suggested or confirmed due dates, soft delete), `study_tasks` and `players.timezone`.
  - Owner-only RLS; the trigger `check_student_work` re-checks class, NPC, document and assignment
    access for every writer, including the service role.
- `_shared/schedule.ts`:
  - IANA timezones and DST-correct conversion;
  - deadline SUGGESTIONS from documents (never invented);
  - the tutor's change rules (confirmed dates protected);
  - a deterministic study planner.
- `_shared/tutorTools.ts`: memory search/save (preferences only with consent), progress plus quizzes,
  assignments, tasks (approval required), study plan (proposal only), and public web search (grounded,
  real links, no private data).
- voice-agent actions: `memory_search`, `memory_save`, `assignments`, `assignment_save`, `tasks`,
  `study_plan`, `web`. All need a claimed, unexpired session and are rate-limited (40/min).
- voice-session stores the browser timezone; the context sent at call start includes upcoming deadlines.
- `agent.py` tools: `search_coursework`, `search_learning_memory`, `save_learning_memory`,
  `get_student_progress`, `get_assignments`, `save_assignment`, `create_study_plan`,
  `manage_study_tasks`, `search_public_web`, `analyze_camera`, `save_session_summary`.
  - Arguments are sanitised, outputs capped at 3.5 KB, backend timeout 8 s (web 15 s).
  - Fix: instructions are no longer rewritten on camera changes. Gemini Live (Gemini API) appends each
    update as a model turn.
- Calendar and reminder tools are deliberately NOT registered until phase 6 works end to end.

**Phase 3 (prepared and tested locally).**
- Pinned requirements (BOM removed); Dockerfile HEALTHCHECK on 8081; tests kept out of the image.
- `railway.json`; limits for call length, idle processes, job memory and drain.
- `agent/DEPLOY.md`: the rollout and rollback steps.
- Verified in a Linux container: the worker registered, health 200, and a test job reached voice-agent
  and Gemini Live.

**Deploy order (owner):**
1. Apply the migration.
2. Deploy voice-agent, then voice-session.
3. Railway staging.
4. Smoke test.
5. Switch `VOICE_AGENT_NAME`.
