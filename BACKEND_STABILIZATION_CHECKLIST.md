# Backend stabilization checklist

Legend: [x] done + verified live (or by the named test) · [~] done, verified locally only · [ ] open / blocked

## Live project (EDUROAM, ref horhkariflujndhttrhr)
- [x] CLI authenticated + linked (npx-cache CLI v3.1.0)
- [x] Migration 20261114000000 applied
- [x] Migration 20261114010000 (classes SELECT policy fix) applied (dry run first)
- [x] Migration 20261114020000 (helpers → `private`, trigger fns revoked) applied (dry run first)
- [x] Security advisors re-run: no SECURITY DEFINER exposure left (only anonymous-sign-in notices + leaked-password protection)
- [x] npc-chat v2 + class-documents v2 ACTIVE
- [x] Both functions reject missing JWT, invalid JWT, publishable key as bearer (401)
- [ ] GEMINI_API_KEY secret set — **BLOCKED: user must run `supabase secrets set`**
- [ ] Configured model (default `gemini-3.5-flash-lite`) answers a real request — blocked by the above

## Auth
- [~] Email 6-digit OTP in-game (browser test with fake Auth API; live wrong-code → 403 otp_expired confirmed)
- [~] 429 handling: no cooldown on rejection, Retry-After honoured, no auto-retry
- [x] Guest sign-in (anonymous enabled in project; live E2E signs in 2 guests, player rows created)
- [~] Guest button only shown when project allows anonymous sign-ins
- [~] Session restore on reload, SIGNED_IN unlocks open panel, sign-out locks it
- [~] RLS denial (42501) shown as explained retryable error, not as "signed out"
- [ ] Email template uses `{{ .Token }}` + custom SMTP — dashboard (user)

## Classes / NPCs
- [x] Upsert ... RETURNING works live; re-sync creates no duplicates
- [x] Mathematics + Science NPCs in separate classes owned by the auth user id
- [x] Cross-user: cannot read, forge owner, or chat with another player's NPC
- [~] 10-NPC limit (PGlite test)

## Documents
- [x] Live: PDF upload via signed URL → processed → ready with chunks
- [x] Live: retrieval returns the real PDF text + title; Science NPC gets none of it
- [x] Live: invalid file type rejected; other player cannot see/download/process/upload
- [x] Live: private worksheet invisible to another player
- [~] DOCX/TXT extraction (Deno tests)

## Gemini / memory
- [~] Error/timeout/retry/blocked handling (unit tests)
- [x] npc-chat reachable and authorises NPC before AI config (live 503 ai_not_configured)
- [x] Live grounded reply with source refs (liveE2E 38/38 after GEMINI_API_KEY was set)
- [x] Memory + atomic turn save + per-NPC isolation (PGlite + liveE2E 38/38)

## Gameplay / tests
- [x] runLifecycle 4 failures fixed (Windows path-casing duplicate modules in the test harness, not game code)
- [x] tsc, npm test 82/82, build, browser smoke, browser auth (3 phases), Deno 4/4

## Answer Dash
- [x] Mini-game dropdown removed from Create/Edit NPC (browser test)
- [x] Dialogue: Chat & Study, Mini-games, Goodbye (browser test)
- [x] Picker with source choice, no-materials + Gemini-error states (browser test + live 409)
- [x] Four-lane runner: keys, taps, edge clamping, gate labels = choices, feedback, results (browser test)
- [x] Return to NPC restores village input/position; reopen = single instance; pause + exit (browser test)
- [x] Live Gemini pack grounded in uploaded PDF, private Science doc never used by Math NPC
- [x] Server-side grading, keys hidden, first answer wins, idempotent finish, no cross-player access (live + PGlite)
- [x] Memory + class progress updated after finish (live)
- [~] Study (Pomodoro) feedback + daily reward once per NPC (unit/browser path; reward amount 2 Number Crystals)
