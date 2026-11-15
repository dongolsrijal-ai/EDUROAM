-- Chert FaceTime (one shared line, Bring Your Own Room) pairing. Additive, non-destructive.
--
-- A FaceTime call carries no EDUROAM identity (and a phone number must never authorise private
-- data), so every call starts LOCKED:
--   1. In the game the student picks a teacher -> "FaceTime Tutor" -> "Call on FaceTime".
--      voice-session authorises student + NPC and creates a facetime voice_session holding the
--      SHA-256 of a random 6-digit code (shown only to that student) for 5 minutes.
--   2. The student calls the shared line. Chert posts call.incoming to the chert-webhook function,
--      which records the call here, creates a fresh room and dispatches "eduroam-tutor" with only
--      this call's opaque id as metadata.
--   3. The agent greets generically and asks for the code. voice-agent "pair" checks it
--      (pair_facetime_call): at most 5 attempts per call, single use, unexpired. Only then are the
--      teacher, coursework and that student's memory released; later tools use the session id.
-- Server-only: browsers can neither read nor write any of this.

alter table public.voice_sessions
    add column if not exists channel text not null default 'browser' check (channel in ('browser', 'facetime')),
    add column if not exists pair_code_hash text check (pair_code_hash is null or pair_code_hash ~ '^[0-9a-f]{64}$'),
    -- The FaceTime call room the session was paired into (room_name stays the session's own id room).
    add column if not exists call_room text;
create index if not exists voice_sessions_facetime_idx on public.voice_sessions (pair_code_hash) where channel = 'facetime' and claimed_at is null;

create table if not exists public.facetime_calls (
    id            uuid primary key default gen_random_uuid(),
    chert_call_id text not null unique check (char_length(chert_call_id) between 1 and 128),
    line_id       text check (line_id is null or char_length(line_id) <= 128),
    room_name     text not null unique check (room_name ~ '^eduroam-ft-[0-9a-f-]{36}$'),
    session_id    uuid references public.voice_sessions (id) on delete set null,
    pair_attempts int not null default 0,
    created_at    timestamptz not null default now(),
    ended_at      timestamptz
);
alter table public.facetime_calls enable row level security;
revoke all on public.facetime_calls from anon, authenticated;

-- Step 1: the student's code (hash only). Same access rule as create_voice_session. An older,
-- still-unused FaceTime code of the same student is retired so only the newest one works.
create or replace function public.create_facetime_pairing (p_player_id uuid, p_npc_id uuid, p_code_hash text, p_ttl_seconds int default 300)
returns table (id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
    v_id uuid := gen_random_uuid();
begin
    if p_code_hash !~ '^[0-9a-f]{64}$' then
        raise exception 'bad code hash' using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.npcs n join public.classes c on c.id = n.class_id
        where n.id = p_npc_id
          and (c.owner_id = p_player_id
               or exists (select 1 from public.class_members m where m.class_id = c.id and m.player_id = p_player_id))
    ) then
        raise exception 'NPC not found' using errcode = 'P0002';
    end if;
    -- Two live codes must never collide (they are matched across students).
    if exists (select 1 from public.voice_sessions s where s.channel = 'facetime' and s.pair_code_hash = p_code_hash
               and s.claimed_at is null and s.ended_at is null and s.expires_at > now()) then
        raise exception 'code collision' using errcode = '23505';
    end if;
    update public.voice_sessions s set ended_at = now()
    where s.player_id = p_player_id and s.channel = 'facetime' and s.claimed_at is null and s.ended_at is null;
    return query
    insert into public.voice_sessions as s (id, player_id, npc_id, room_name, expires_at, channel, pair_code_hash)
    values (v_id, p_player_id, p_npc_id, 'eduroam-' || v_id::text, now() + make_interval(secs => least(greatest(p_ttl_seconds, 60), 600)), 'facetime', p_code_hash)
    returning s.id, s.expires_at;
end $$;

-- Step 3: the code the caller said, for this call. Returns the claimed session, or no row for a
-- wrong / expired / used code. Raises after 5 attempts or when the call is over / already paired.
create or replace function public.pair_facetime_call (p_call_id uuid, p_code_hash text)
returns table (session_id uuid, player_id uuid, npc_id uuid, room_name text, attempts_left int)
language plpgsql security definer set search_path = '' as $$
declare
    v_call public.facetime_calls;
    v_session public.voice_sessions;
begin
    select * into v_call from public.facetime_calls c where c.id = p_call_id for update;
    if not found or v_call.ended_at is not null then
        raise exception 'call not active' using errcode = 'P0002';
    end if;
    if v_call.session_id is not null then
        raise exception 'call already paired' using errcode = 'P0001';
    end if;
    if v_call.pair_attempts >= 5 then
        raise exception 'too many attempts' using errcode = 'P0001';
    end if;
    update public.facetime_calls c set pair_attempts = c.pair_attempts + 1 where c.id = p_call_id;

    update public.voice_sessions s set claimed_at = now(), call_room = v_call.room_name
    where s.id = (
        select s2.id from public.voice_sessions s2
        where s2.channel = 'facetime' and s2.pair_code_hash = p_code_hash
          and s2.claimed_at is null and s2.ended_at is null and s2.expires_at > now()
        order by s2.created_at desc limit 1
        for update skip locked)
    returning s.* into v_session;
    if v_session.id is null then
        return query select null::uuid, null::uuid, null::uuid, null::text, 4 - v_call.pair_attempts;
        return;
    end if;
    update public.facetime_calls c set session_id = v_session.id where c.id = p_call_id;
    return query select v_session.id, v_session.player_id, v_session.npc_id, v_call.room_name, 4 - v_call.pair_attempts;
end $$;

revoke execute on function public.create_facetime_pairing (uuid, uuid, text, int) from public, anon, authenticated;
revoke execute on function public.pair_facetime_call (uuid, text) from public, anon, authenticated;
grant execute on function public.create_facetime_pairing (uuid, uuid, text, int) to service_role;
grant execute on function public.pair_facetime_call (uuid, text) to service_role;
