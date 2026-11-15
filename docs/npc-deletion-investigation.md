# NPC deletion investigation and verification

## Confirmed root cause

The old `NpcManager.remove` removed the teacher/building from `npcStore` immediately, then started `deleteRemoteNpc` without awaiting it. The API helper returned silently when signed out, ignored lookup errors, swallowed document cleanup errors, and logged an NPC DELETE failure instead of rejecting it. The visible roster and limit badge counted only `localStorage`; Supabase independently counted surviving account records.

The account shown in the reported issue has **10 distinct stable game NPC IDs**, including bob, across seven classes. They are not ten duplicates of bob's database identity. The screenshot showed one village NPC, while the server retained ten. The broken deletion path explains how the rosters diverge. We cannot establish which older rows were deleted locally versus belong to another browser save, so none were removed automatically.

The separate historical `BEFORE INSERT` upsert-limit defect was already fixed in the live database before this task. Existing records now also use explicit ID-scoped updates in the frontend rather than routinely attempting inserts.

## Implemented behavior

- Deletion is awaited and bound to the account that confirmed it. The server verifies the JWT owner and stable database ID before recording intent. Switching accounts cannot redirect the request to a different owner's teacher.
- The village retains its teacher on server failure. Confirmation explains permanent private-history removal; the matching local voice call is disconnected first. Server cleanup closes that NPC's recorded LiveKit rooms too.
- A durable manifest records authorized private Storage paths and room names. Storage is deleted through its API, not by deleting metadata. Once cleanup succeeds, a transaction detaches shared class documents/chunks, deletes the teacher, and lets existing cascades remove private documents, conversations/messages, memories and sessions. Classes and other teachers are retained.
- A Vault-authenticated cron worker replays completed manifests every five minutes across the two-hour signed-upload window plus a grace period. Failed cleanup remains eligible until successful, including after the horizon. This handles previously issued uploads and delayed room dispatch. It never infers deletion from an absent local record.
- Document chunk replacement locks the parent document and derives its current scope, so an in-flight extractor does not reattach shared coursework to a deleted teacher.
- Account-scoped, permanent server tombstones reject stale inserts/upserts. Local tombstone filtering survives reload and preserves the underlying configuration for other accounts.
- The manager reads authoritative account counts and provides **NPCs → Compare with server (read-only)**, showing database/game IDs, matches, local-only records, server-only records and deletion markers. Signed-in creation also synchronizes the newly created stable identity.

## Safe review of older records

1. Sign in to the intended account and open **NPCs → Compare with server**; refresh the report.
2. Compare stable game IDs, database IDs and class IDs. A server-only row is a review candidate, not proof of an orphan. Check other browser saves, coursework, and private history before deciding.
3. Review a specific proposed removal and obtain explicit approval for that teacher. Use the owner-authorized lifecycle endpoint with its database ID and expected owner, rather than raw SQL DELETE or deleting its class. Do not bulk-remove server-only rows.
4. On cleanup failure, retry the same teacher. Do not create a replacement identity or clear browser storage as a workaround.

Existing account NPCs/classes were not deleted. Its original 10-NPC count is unchanged until the player explicitly deletes a teacher.

## Deployment and proof

Applied migrations `20261115021021_permanent_npc_deletion.sql` and `20261115021941_restrict_npc_cleanup_manifest.sql`; deployed `npc-lifecycle` v1, `class-documents` v10 and `voice-session` v2. Existing deployed dependency bundles were retained; only the intended existing entrypoint changes were published. The scheduled `npc-private-file-cleanup` job is active; its credential is in Vault and Edge secrets. Browser permissions expose deletion identity/status only; private file paths and room manifests remain server-only.

Focused Postgres/client tests cover owner isolation, retryable manifests, cascades, shared document preservation, extraction after deletion, stale-save rejection, existing identity reuse at the cap, and a freed slot accepting a new teacher while refusing an eleventh. Browser checks cover the real manager, delayed failed deletion, visible error, retained teacher, retry, voice isolation and sign-in/reload behavior. TypeScript, Edge checks and production build pass.

Live verification used isolated guests, not the player's account. A new account reached ten teachers, uploaded private/shared coursework, saved a real chat/memory, deleted one teacher (count nine), retained shared originals/chunks/class, rejected stale sync after a fresh client, and created a replacement (count ten). An intentionally late signed upload appeared after deletion; the worker returned HTTP 200 (`cleaned: 1`) and the Storage object count changed from one to zero.

Verification fixtures retained for review:

- Initial guest `2a476a1a-61d3-41c1-a465-50114b2a42ed`: initial test stopped at missing voice configuration; its fixtures remain.
- Completed lifecycle guest `7b1df94c-53d2-491d-9440-b0e8cbd44474`: deleted test teacher `7f85fa25-058e-4878-bc81-bed09a13e3aa`; shared class `61b771a7-e2dc-4dba-8cf6-b51386fc64bb` and other test teachers remain. No test accounts were bulk-cleaned.

## Voice limitation

Repeated live voice requests at the 10-NPC cap pass NPC authorization without inserting teachers or producing the limit error, but return `503 voice_not_configured`. At least one of `LIVEKIT_URL`, `LIVEKIT_API_KEY`, or `LIVEKIT_API_SECRET` is missing. A valid LiveKit room/token and an actual voice connection could not be verified. The user explicitly requested finishing this deletion fix and reporting voice configuration as a separate blocker.
