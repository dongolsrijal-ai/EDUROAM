# EDUROAM continuation handoff

## Recovered work (2026-11-13)

Inspected working tree, recent commits, GAME_PLAN.md, DEVELOPMENT_STATUS.md, and
docs/tower-design.md. No CLAUDE.md or AGENTS.md is present. All inherited changes
are preserved, including garden art and inventory improvements outside this task.

Claude implemented seeded connected dungeon floors, three biomes, persisted run
parameters and tower progression, gradual capped scaling, five enemy archetypes,
Hades abilities/phases/bar, visible-body hurtboxes, chest receipts, inventory
discard/full-bag recovery, Pomodoro gating/HUD, and a development panel.

Baseline: 33 tests pass; `npx tsc --noEmit` passes. Tests cover generation,
scaling/pacing, timer persistence, inventory migration, and chest interruption
recovery. Runtime enemy behavior, hit detection, and Next Tower lacked coverage.

## Completed continuation

1. Player maximum HP is 50. Small/large potions heal 10/25, changed only in
   item definitions; no extra reduction or inventory migration. Loaded HP is
   clamped to 50. Summoned skeletons always have 1 HP, independent of scaling.
2. Run starts, replacements, floor advances, retries, completions, and tower
   progression publish only after successful persistence. Completion requires
   an active final floor and cannot count twice. Interrupted completion/skip
   saves reconcile on boot. Failed reconciliation retains the recovery record.
3. Legacy active runs retain run IDs, HP, inventory, chest rolls and receipts.
   Their single floor uses the current generator; old chest identities remain
   attached to the corresponding side/final chests, so pending rewards remain
   collectible and paid rewards cannot duplicate. Fresh runs have 2–3 floors.
4. DEV panel now has Next Tower, current biome/floor/level, ordinary/boss
   scaling, and both study/break duration overrides. Next Tower uses the existing
   generator, refills HP, restarts the scene and never invokes success/rewards.
   Scene cleanup removes enemies/arrows/spells and closes inventory/death UI.
   Fixed the real Phaser shutdown ordering crash when groups were already gone.
5. Melee tests sector boundaries against visible-body rectangles, repairing
   misses along large enemy edges. Regression tests exercise actual combat
   damage to Hades's upper body, all enemy behaviors, and Hades's abilities and
   transition strictly below 50% HP. Existing reward/full-bag tests are retained.
6. Added `typecheck` and `test:browser` scripts. Test module runners close per
   test, removing the inherited listener warnings. No dependencies were added.

## Final validation

- `npm run typecheck`: PASS.
- `npm test`: **51 passed, 0 failed**, no listener warnings.
- `npm run build-nolog`: PASS (same production Vite config as `build`). Windows
  sandbox denied esbuild configuration access; approved unsandboxed retry passed.
- Production artifact scan: DEV panel/Next Tower controls excluded.
- `node tests/browserSmoke.mjs` (`npm run test:browser`): PASS with installed
  headless Edge in a new temporary profile. Exercises real Phaser hub/focus gate,
  combat room gates/waves, floor portal, two Next Tower clicks, old enemy/arrow/
  spell cleanup, Hades phase/bar/defeat, chest rewards, return to focus, and reload
  without duplicated progression/items. The test drives Phaser's real frame
  step explicitly to avoid headless browser animation-frame throttling.
- `git diff --check`: PASS. No commits, pushes, deployments, destructive Git
  operations, or changes to the user's browser save data were performed.

## Remaining limitations

No requested implementation remains open. The 10-minute break retains Claude's
documented pacing-target behavior: overtime is allowed and studying resumes after
the completed run. The browser test uses development controls; subjective combat
feel, visual polish and a full human-paced starter-gear playthrough remain manual
checks. Browser automation uses Edge by default; `EDUROAM_BROWSER` can select
another Chromium executable. The user's normal browser profile is never used.
