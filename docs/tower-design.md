# Dungeon Tower: research notes, audit and plan

## 1. Research (documentation only)

The Soul Knight fandom wiki pages in the brief return HTTP 402/403 to automated fetches, so they
could not be read directly. Findings come from public search summaries of fan wikis (fandom
"Bosses"/"Boss Rush" pages, NamuWiki, TV Tropes). **No game binaries or packages were inspected**:
there is no authorized Soul Knight installation here, and REA is meant for that kind of target, so
this is design research only. No code, assets, names or layouts are reused.

Confirmed by the sources reached:
- **Levels are made of rooms with 1-3 enemy waves**; a chest appears after a combat room is cleared.
- **Bosses sit on the last level of each area** (x-5), whose boss room replaces the portal; a
  gold chest spawns after the boss.
- A portal leads from level to level; areas get harder as you go (floor-3 bosses have far denser
  patterns than early ones).
- Some bosses lean on summoned minions rather than pure projectile spam.

Not confirmed by the sources reached (treated as our own design choice): doors closing while a
room's waves are active.

## 2. Principles we adopt (our own implementation)

1. **Templates + procedural layout**: hand-designed rooms snapped onto a grid by a seeded generator
   (never per-tile noise), so every floor reads well and is always completable.
2. **Main path + side branches**: start -> combat rooms -> exit/boss on a guaranteed path;
   treasure/special rooms hang off it as optional branches.
3. **Rooms lock while a fight is on**: entering an uncleared combat room seals its doorways until
   the last wave dies; then they open and stay open. A clear moment of pressure, then release.
4. **Short waves, readable enemies**: few enemies at once, archetypes that ask different things of
   the player (chase, kite, telegraphed slam, summoner), every attack dodgeable with a visible tell.
5. **Escalation by variety first, stats second**: later floors and higher tower levels mix in
   tougher archetypes; HP/damage multipliers are gentle and capped.
6. **Biomes as data**: tileset, props, colors, room pool, enemy weights; picked per run, never the
   same twice in a row when another exists.
7. **Boss = finale**: name bar, intro, phases with clearer/faster patterns below 50 %, recovery
   windows, then a reward chest and the exit.
8. **Replayability**: seed (layout + biome + floor count + encounters) differs every run; stored
   with the run for debugging and replay.

## 3. Audit of what already exists

| Area | Existing | Gap |
|---|---|---|
| Layout | `world/dungeon/rooms.ts` templates, `build.ts` grid builder, one hand-made plan | No generator, no room roles, one biome |
| Run state | `state/dungeonRun.ts`: runId, chest receipts (anti-duplication), death retry, exit gating | Single floor, no seed/biome/floor index |
| Combat | `CombatController`: melee arc, directional arrows, F heal, armor = flat reduction (min 1), death | Arrows only hit the enemy's 18x10 **feet body**, melee uses a centre circle: upper body is unhittable (the hurtbox bug) |
| Enemies | `Enemy`: chase + contact damage, one def (Stone Guardian) | No archetypes, projectiles, telegraphs, summons, boss phases |
| Player | 100 HP, defense 2 (cloth) / 5 (reinforced), sword 5 dmg @420 ms, bow 3 @650 ms | - |
| Loop | Village is peaceful; E enters dungeon any time | No Pomodoro gating, no tower level |

## 4. Plan (in order, each validated before the next)

1. **Hurtboxes**: `combat/hitboxes.ts`. Enemies keep a small feet body for movement plus a separate
   hurtbox (visible body) used by melee and arrows; dev-only debug overlay draws bodies, hurtboxes
   and attack hitboxes.
2. **Tower progression + scaling**: `state/tower.ts` (persistent `towerLevel`, last biome, reconciled
   from the completed run id so it can't double count); `combat/scaling.ts` holds every formula.
3. **Procedural floors**: phaser-free `world/dungeon/{tiles,biomes,rooms,generate,build}.ts`; seeded
   2-3 floor runs; locked combat rooms; node tests for connectivity/reachability over many seeds.
4. **Enemies**: zombie, goblin, wizard (projectiles), giant (telegraphed slam), soul reaper
   (capped skeleton summons), all data-driven in `combat/enemyTypes.ts`.
5. **Hades**: boss behaviour with Soul Fire, Reaper Summon, Death Sweep, two phases, intro, boss bar.
6. **Pomodoro**: `state/pomodoro.ts` (wall-clock focus timer that survives refresh), HUD timer,
   dungeon gated until focus is done, run return starts the next session.
7. **Rewards + balance**: tier-scaled loot, tower level up on completion, full-bag safety
   (pending rewards never block the exit), target ~10 min runs.
8. **Dev mode** (`import.meta.env.DEV` only): timers, direct entry, tower level, biome, floor, seed,
   spawn enemies, hitboxes, boss test.
