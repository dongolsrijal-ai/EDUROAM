-- FaceTime Tutor (LiveKit voice) pairing sessions. Additive, non-destructive.
--
-- The game asks the voice-session Edge Function for a call; it verifies the student may use the
-- NPC, creates one row here and dispatches the LiveKit agent with ONLY the row id (an opaque,
-- random pairing id) as metadata. The agent trades that id ONCE (claim) at the voice-agent
-- function for the NPC's context; later tool calls must name a claimed, not-ended session.
-- Server-only: browsers can neither read nor write this table.

create table public.voice_sessions (
    id          uuid primary key default gen_random_uuid(),
    player_id   uuid not null references public.players (id) on delete cascade,
    npc_id      uuid not null references public.npcs (id) on delete cascade,
    room_name   text not null unique check (room_name ~ '^eduroam-[0-9a-f-]{36}$'),
    -- The pairing must be claimed by the agent before this (short-lived).
    expires_at  timestamptz not null,
    claimed_at  timestamptz,
    ended_at    timestamptz,
    created_at  timestamptz not null default now()
);
create index voice_sessions_player_idx on public.voice_sessions (player_id, created_at desc);

alter table public.voice_sessions enable row level security;
revoke all on public.voice_sessions from anon, authenticated;

-- Creates a session only if the player owns the NPC's class or is a member of it (the same
-- rule as resolveNpcIdentity, repeated here so the database itself refuses foreign NPCs).
create or replace function public.create_voice_session (p_player_id uuid, p_npc_id uuid, p_ttl_seconds int default 120)
returns table (id uuid, room_name text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
    v_id uuid := gen_random_uuid();
begin
    if not exists (
        select 1 from public.npcs n join public.classes c on c.id = n.class_id
        where n.id = p_npc_id
          and (c.owner_id = p_player_id
               or exists (select 1 from public.class_members m where m.class_id = c.id and m.player_id = p_player_id))
    ) then
        raise exception 'NPC not found' using errcode = 'P0002';
    end if;
    return query
    insert into public.voice_sessions as s (id, player_id, npc_id, room_name, expires_at)
    values (v_id, p_player_id, p_npc_id, 'eduroam-' || v_id::text, now() + make_interval(secs => least(greatest(p_ttl_seconds, 30), 600)))
    returning s.id, s.room_name, s.expires_at;
end $$;

-- Single use: the first claim of an unexpired, unclaimed, not-ended session wins; any later
-- (or late) claim returns no row.
create or replace function public.claim_voice_session (p_session_id uuid)
returns table (player_id uuid, npc_id uuid, room_name text)
language sql security definer set search_path = '' as $$
    update public.voice_sessions s set claimed_at = now()
    where s.id = p_session_id and s.claimed_at is null and s.ended_at is null and s.expires_at > now()
    returning s.player_id, s.npc_id, s.room_name;
$$;

revoke execute on function public.create_voice_session (uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.claim_voice_session (uuid) from public, anon, authenticated;
grant execute on function public.create_voice_session (uuid, uuid, int) to service_role;
grant execute on function public.claim_voice_session (uuid) to service_role;
