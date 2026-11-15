-- Fix: re-syncing an EXISTING NPC failed with "NPC limit reached (10/10)" once an account had
-- 10 NPC rows. Non-destructive: replaces two trigger functions; limits, tables and data unchanged.
--
-- Cause: the game saves NPCs with INSERT ... ON CONFLICT (owner_id, game_npc_id) DO UPDATE.
-- BEFORE INSERT row triggers run before the conflict is detected, and the upserted row has a
-- fresh id, so enforce_npc_limits counted the existing row PLUS the "new" one (11 > 10) and
-- aborted what would have been an update of that same NPC. The class trigger had the same
-- flaw (at its 50-class cap).
--
-- Now an INSERT that the ON CONFLICT will turn into an update of an existing row is not counted
-- as a new NPC / class. Real inserts are limited exactly as before; the update path still runs
-- the class-limit check through the BEFORE UPDATE OF class_id trigger.

create or replace function public.enforce_npc_limits () returns trigger
language plpgsql set search_path = '' as $$
declare
    v_npcs int;
    v_classes int;
begin
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 0));
    if tg_op = 'INSERT' and exists (
        select 1 from public.npcs where owner_id = new.owner_id and game_npc_id = new.game_npc_id
    ) then
        return new; -- an upsert of an existing NPC: ON CONFLICT updates it (checked on UPDATE)
    end if;
    select count(*), count(distinct class_id) into v_npcs, v_classes
    from (
        select class_id from public.npcs where owner_id = new.owner_id and id <> new.id
        union all select new.class_id
    ) as owned;
    if tg_op = 'INSERT' and v_npcs > 10 then
        raise exception 'NPC limit reached (10/10)' using errcode = 'P0001';
    end if;
    if v_classes > 10 then
        raise exception 'Class limit reached (10/10)' using errcode = 'P0001';
    end if;
    return new;
end $$;

create or replace function public.enforce_class_limit () returns trigger
language plpgsql set search_path = '' as $$
begin
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 1));
    -- name_key is generated (not yet computed in a BEFORE trigger): use the same expression.
    if exists (select 1 from public.classes where owner_id = new.owner_id and name_key = lower(btrim(new.name))) then
        return new; -- an upsert of an existing class: ON CONFLICT updates it
    end if;
    if (select count(*) from public.classes where owner_id = new.owner_id) >= 50 then
        raise exception 'Too many classes for this account' using errcode = 'P0001';
    end if;
    return new;
end $$;

-- CREATE OR REPLACE keeps the existing triggers and grants; restate the hardening anyway.
revoke execute on function public.enforce_npc_limits () from public, anon, authenticated;
revoke execute on function public.enforce_class_limit () from public, anon, authenticated;
