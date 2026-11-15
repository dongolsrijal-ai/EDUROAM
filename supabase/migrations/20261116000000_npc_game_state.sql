-- Supabase becomes the source of truth for the village: each NPC row also carries its
-- game-side state (home spot, building, greeting lines, mini-game, completion), so signing in
-- on any browser restores the same village. Non-destructive: one new column with a default;
-- existing rows keep everything and get '{}' (the game then places them and fills it in).
--
-- Shape written by the game (validated again in the browser on every load):
--   { "v": 1, "map": "hub", "x": 1080, "y": 420, "dialogue": [], "reactions": {},
--     "minigameType": null, "completed": false,
--     "building": { "id": "bld_...", "type": "hall", "map": "hub", "x": 1056, "y": 384 } | null }

alter table public.npcs
    add column if not exists game_state jsonb not null default '{}'::jsonb;

alter table public.npcs
    drop constraint if exists npcs_game_state_shape,
    add constraint npcs_game_state_shape
        check (jsonb_typeof(game_state) = 'object' and octet_length(game_state::text) <= 16384);

comment on column public.npcs.game_state is
    'Game-side NPC state (placement, building, dialogue, mini-game, completion). Written by the owner; validated by the client on load.';
