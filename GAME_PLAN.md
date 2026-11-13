# Educational Roguelite Hackathon: Master Plan

## Project

Extend the existing Phaser + JavaScript + Vite pixel RPG in this repository.
Do not replace the project or reinstall Phaser.

The game is an educational roguelite. Players visit themed NPC buildings, complete educational mini-games, earn inventory items and equipment, then enter a dungeon for a short combat reward. Longer term, focus sessions follow a Pomodoro-inspired cycle with dungeon combat as the break.

## Current features to preserve

- Village hub, paths, buildings, player movement, and collision.
- Customizable, roaming NPCs and themed buildings. Maximum 10 NPCs and 10 unique classes.
- Educational NPC dialogue and a working introductory math challenge.
- Scrollable inventory with tabs, equipped armor, melee weapon, ranged weapon, and healing item.
- Dungeon with rooms and existing chest graphics.
- Current working save data and item quantities.

## Near-term milestones (order matters)

1. Remove the bottom 10-slot hotbar while preserving items, the inventory, and equipment.
2. Implement dungeon-only melee attacks on left mouse button with a visible equipped sword and correct mouse aiming.
3. Implement dungeon-only ranged attacks on right mouse button with a visible equipped bow, arrow projectiles, and collisions. If both buttons are held, the one pressed most recently determines the current attack. Releasing that button switches to the remaining held button.
4. Keep E as interact with NPCs, entrances, and chests. Use F exclusively for healing in the dungeon. Keep the village peaceful: no attacks or healing there.
5. Add the dungeon-only player HP bar, damage handling with equipped armor, healing consumption, and a simple guardian enemy.
6. Add interactive end-of-dungeon treasure chests that award items into the existing inventory, with durable one-time rewards and no duplication.
7. Lock dungeon return travel until the guardian has been defeated and the final chest opened. Unlock an exit portal afterward. On death, allow retry instead of awarding success.
8. Improve the village dungeon entrance to look like a stone archway with stairs, torches, shadows, and clear interaction prompts.

These are priorities, not an instruction to implement everything in one pass. Plan one small, testable change at a time. Build and review each milestone before the next.

## Input bindings

- WASD / arrow keys: move everywhere.
- E: interact everywhere (never change this to F).
- I: open inventory everywhere.
- Left mouse button: melee, dungeon only.
- Right mouse button: ranged, dungeon only.
- F: use equipped healing item, dungeon only.
- Escape: close menu/dialogue.
- No bottom hotbar.

## Important gameplay rules

- Keep weapons visible during their attack animations.
- Inventory UI, dialogue, and overlays block combat input.
- Health bar appears only in dungeons.
- Dungeon entrance locks after entry. Exit becomes available only after guardian defeat and treasure collection.
- Player death triggers a retry flow rather than a successful exit.
- Treasure must not duplicate on repeated interaction or page refresh.
- Preserve existing item/gear definitions and saved inventory data.

## Later milestones (do not start before the core loop works)

- Better enemies and boss combat.
- Educational quest rewards connected directly to combat gear.
- Pomodoro timing with short reward battles.
- Supabase accounts and persistence.
- Gemini NPC dialogue with player-specific memories.
- Chert messaging that uses the same NPC identity, memories, and game progress outside the game.

## Development standards

- Stay inside the existing repository.
- Keep changes modular, small, and reversible.
- Reuse existing services and components where appropriate.
- Do not expose API secrets in browser code.
- Do not make unrelated changes or replace working scenes.
- Run `npm run build` after implementation. Report any manual gameplay checks still needed.
