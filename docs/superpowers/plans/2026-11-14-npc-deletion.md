# Permanent NPC deletion implementation plan

> Execute inline using superpowers:executing-plans. Preserve unrelated working tree changes.

Goal: server-confirmed, owner-authorized teacher deletion with private Storage cleanup, shared coursework preservation, stable identity, and no resurrection.

- [x] Add failing Postgres regression tests for deletion preparation/finalization, ownership, cascades, shared documents, deletion markers, and count/limit behavior.
- [x] Add a migration with durable deletion manifests and server-only prepare/finish RPCs. Serialize against sync/uploads; retain shared documents and chunks; deny resurrection and direct client deletion. Use existing cascades for private data.
- [x] Add an authenticated npc-lifecycle endpoint: server-authorized private-file cleanup and active LiveKit room teardown before final deletion. Retry incomplete work without losing its manifest.
- [x] Update tutorApi, npcStore, NpcManager, VoicePanel and UI wiring: stable-ID lookup, awaited deletion, confirmation/error handling, account-scoped authoritative roster/count and read-only comparison; hide only confirmed deleted identities.
- [x] Verify relevant DB/service/UI tests, typecheck/build, deploy the migration/affected endpoints, and run an isolated live lifecycle fixture. Preserve all pre-existing records and report actual live voice/config limitations.

Ruling: review exposed outstanding signed uploads, late room dispatch and shared extraction races. Added a native cron/net/Vault retry worker for authorized deletion manifests, and atomic document chunk replacement. These preserve deletion/file invariants without redesigning voice or ingestion. See docs/npc-deletion-investigation.md for deployment, proof and the user-accepted LiveKit configuration blocker.

Primary files: supabase/migrations, supabase/functions/npc-lifecycle/index.ts, src/game/services/tutorApi.ts, src/game/data/npcStore.ts, src/game/ui/NpcManager.ts, src/game/ui/VoicePanel.ts, src/game/ui/index.ts, tests/backendDb.test.mts, tests/npcLifecycle.test.mts, tests/live/liveNpcDeletion.mjs.
