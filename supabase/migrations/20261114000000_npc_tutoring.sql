-- EDUROAM AI tutoring backend: players, classes, NPCs, class materials, chat history,
-- per-player NPC memory, class progress, rate limits and (future) channel pairings.
--
-- Trust model
--   * Browser (publishable key + user JWT): may read what RLS allows, and may only write
--     its own classes / NPC definitions (teacher config) and its own display name.
--   * Edge Functions (secret key): write documents, chunks, messages, memory and progress
--     after verifying the caller, so a client can never forge NPC replies, mark a document
--     "ready" or edit another player's memory.

create extension if not exists vector with schema extensions;

-- ------------------------------------------------------------------ helpers

create or replace function public.set_updated_at () returns trigger
language plpgsql set search_path = '' as $$
begin
    new.updated_at = now();
    return new;
end $$;

-- ------------------------------------------------------------------ players

create table public.players (
    id              uuid primary key references auth.users (id) on delete cascade,
    display_name    text not null default 'Adventurer' check (char_length(btrim(display_name)) between 1 and 40),
    -- The browser's pre-auth local id ("player_<uuid>"), kept so earlier local progress stays linked.
    legacy_local_id text check (legacy_local_id ~ '^player_[A-Za-z0-9-]{6,64}$'),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create trigger players_updated_at before update on public.players
    for each row execute function public.set_updated_at();

-- Every auth user gets a player row.
create or replace function public.handle_new_auth_user () returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    insert into public.players (id) values (new.id) on conflict (id) do nothing;
    return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
    for each row execute function public.handle_new_auth_user();
insert into public.players (id) select id from auth.users on conflict (id) do nothing;

-- ------------------------------------------------------------------ classes + membership

create table public.classes (
    id          uuid primary key default gen_random_uuid(),
    owner_id    uuid not null references public.players (id) on delete cascade,
    name        text not null check (char_length(btrim(name)) between 1 and 32),
    name_key    text generated always as (lower(btrim(name))) stored,
    subject     text not null check (char_length(btrim(subject)) between 1 and 32),
    description text not null default '' check (char_length(description) <= 500),
    created_at  timestamptz not null default now(),
    unique (owner_id, name_key),
    unique (id, owner_id)
);

-- Students/co-teachers of a class (enrollment UI comes later; rows are written server-side).
create table public.class_members (
    class_id   uuid not null references public.classes (id) on delete cascade,
    player_id  uuid not null references public.players (id) on delete cascade,
    role       text not null default 'student' check (role in ('student', 'teacher')),
    created_at timestamptz not null default now(),
    primary key (class_id, player_id)
);
create index class_members_player_idx on public.class_members (player_id);

-- SECURITY DEFINER so policies can call them without recursive RLS evaluation.
create or replace function public.can_access_class (p_class_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.classes c where c.id = p_class_id and c.owner_id = (select auth.uid()))
        or exists (select 1 from public.class_members m where m.class_id = p_class_id and m.player_id = (select auth.uid()));
$$;

create or replace function public.can_manage_class (p_class_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.classes c where c.id = p_class_id and c.owner_id = (select auth.uid()))
        or exists (select 1 from public.class_members m
                   where m.class_id = p_class_id and m.player_id = (select auth.uid()) and m.role = 'teacher');
$$;

-- ------------------------------------------------------------------ NPCs

create table public.npcs (
    id                    uuid primary key default gen_random_uuid(),
    owner_id              uuid not null references public.players (id) on delete cascade,
    class_id              uuid not null,
    -- The game's stable NPC id ("npc_<uuid>" or a built-in id such as "sir-sum-a-lot").
    game_npc_id           text not null check (game_npc_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    name                  text not null check (char_length(btrim(name)) between 1 and 32),
    appearance            text not null check (char_length(appearance) between 1 and 32),
    subject               text not null check (char_length(btrim(subject)) between 1 and 32),
    personality           text not null default '' check (char_length(personality) <= 300),
    teaching_instructions text not null default '' check (char_length(teaching_instructions) <= 600),
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    unique (owner_id, game_npc_id),
    unique (id, class_id),
    -- An NPC can only be assigned to a class its owner owns.
    foreign key (class_id, owner_id) references public.classes (id, owner_id) on delete restrict
);
create index npcs_class_idx on public.npcs (class_id);
create trigger npcs_updated_at before update on public.npcs
    for each row execute function public.set_updated_at();

-- Server-side copy of the game's limits: 10 NPCs and 10 distinct classes per owner.
create or replace function public.enforce_npc_limits () returns trigger
language plpgsql set search_path = '' as $$
declare
    v_npcs int;
    v_classes int;
begin
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 0));
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
create trigger npcs_limits before insert or update of class_id on public.npcs
    for each row execute function public.enforce_npc_limits();

create or replace function public.enforce_class_limit () returns trigger
language plpgsql set search_path = '' as $$
begin
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 1));
    if (select count(*) from public.classes where owner_id = new.owner_id) >= 50 then
        raise exception 'Too many classes for this account' using errcode = 'P0001';
    end if;
    return new;
end $$;
create trigger classes_limit before insert on public.classes
    for each row execute function public.enforce_class_limit();

-- ------------------------------------------------------------------ class materials

create table public.class_documents (
    id                uuid primary key default gen_random_uuid(),
    class_id          uuid not null references public.classes (id) on delete cascade,
    -- null = shared with every NPC of the class; otherwise scoped to one NPC.
    npc_id            uuid,
    uploaded_by       uuid not null references public.players (id) on delete cascade,
    title             text not null check (char_length(btrim(title)) between 1 and 120),
    file_path         text not null unique,
    file_type         text not null check (file_type in ('pdf', 'txt', 'docx')),
    mime_type         text not null,
    size_bytes        int not null check (size_bytes > 0 and size_bytes <= 10485760),
    -- 'class'   = teacher material, readable by people with access to the class.
    -- 'private' = a student's own upload, readable only by the uploader, only via that NPC.
    visibility        text not null check (visibility in ('class', 'private')),
    processing_status text not null default 'pending'
                      check (processing_status in ('pending', 'processing', 'ready', 'failed')),
    processing_error  text check (char_length(processing_error) <= 300),
    chunk_count       int not null default 0,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    unique (id, class_id),
    check (visibility = 'class' or npc_id is not null),
    -- The NPC must belong to the same class; documents follow an NPC whose class changes.
    foreign key (npc_id, class_id) references public.npcs (id, class_id) on delete cascade on update cascade
);
create index class_documents_class_idx on public.class_documents (class_id, created_at desc);
create index class_documents_npc_idx on public.class_documents (npc_id);
create index class_documents_uploader_idx on public.class_documents (uploaded_by);
create trigger class_documents_updated_at before update on public.class_documents
    for each row execute function public.set_updated_at();

create or replace function public.can_read_document (p_document_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (
        select 1 from public.class_documents d
        where d.id = p_document_id
          and (d.uploaded_by = (select auth.uid())
               or (d.visibility = 'class' and public.can_access_class(d.class_id))));
$$;

create table public.document_chunks (
    id          uuid primary key default gen_random_uuid(),
    document_id uuid not null,
    class_id    uuid not null,
    npc_id      uuid references public.npcs (id) on delete cascade,
    chunk_index int not null check (chunk_index >= 0),
    chunk_text  text not null check (char_length(chunk_text) between 1 and 8000),
    embedding   extensions.vector(768),
    source      jsonb not null default '{}'::jsonb,
    search      tsvector generated always as (to_tsvector('english', chunk_text)) stored,
    created_at  timestamptz not null default now(),
    unique (document_id, chunk_index),
    foreign key (document_id, class_id) references public.class_documents (id, class_id)
        on delete cascade on update cascade
);
create index document_chunks_search_idx on public.document_chunks using gin (search);
create index document_chunks_class_idx on public.document_chunks (class_id);

-- Chunks one NPC may use for the CALLING player: ready class material for that NPC/class,
-- plus the caller's own private uploads to that NPC. SECURITY INVOKER: RLS still applies.
-- Words are OR-ed; with no match the newest material comes first ("explain this worksheet").
-- p_player_id is only honoured for server callers (no JWT, e.g. a future voice agent that
-- resolved the player through a verified pairing); a signed-in caller is always auth.uid().
create or replace function public.match_npc_chunks (p_npc_id uuid, p_query text, p_limit int default 6, p_player_id uuid default null)
returns table (
    chunk_id uuid, document_id uuid, title text, visibility text,
    chunk_index int, chunk_text text, source jsonb, rank real
)
language sql stable security invoker set search_path = '' as $$
    with npc as (select n.id, n.class_id from public.npcs n where n.id = p_npc_id),
    q as (
        select nullif(replace(plainto_tsquery('english', left(coalesce(p_query, ''), 500))::text, ' & ', ' | '), '')::tsquery as tsq
    )
    select c.id, c.document_id, d.title, d.visibility, c.chunk_index, c.chunk_text, c.source,
           coalesce(ts_rank_cd(c.search, q.tsq), 0)::real as rank
    from public.document_chunks c
    join public.class_documents d on d.id = c.document_id
    join npc on npc.class_id = c.class_id
    cross join q
    where d.processing_status = 'ready'
      and ((d.visibility = 'class' and (d.npc_id is null or d.npc_id = npc.id))
        or (d.visibility = 'private' and d.npc_id = npc.id
            and d.uploaded_by = coalesce((select auth.uid()), p_player_id)))
    order by rank desc, d.created_at desc, c.chunk_index
    limit least(greatest(coalesce(p_limit, 6), 1), 12);
$$;

-- ------------------------------------------------------------------ conversations

create table public.conversations (
    id         uuid primary key default gen_random_uuid(),
    player_id  uuid not null references public.players (id) on delete cascade,
    npc_id     uuid not null references public.npcs (id) on delete cascade,
    -- Class at the time of the conversation (kept if the class is later removed).
    class_id   uuid references public.classes (id) on delete set null,
    channel    text not null default 'game' check (channel in ('game', 'facetime', 'imessage')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index conversations_player_npc_idx on public.conversations (player_id, npc_id, updated_at desc);
create trigger conversations_updated_at before update on public.conversations
    for each row execute function public.set_updated_at();

create table public.messages (
    id                uuid primary key default gen_random_uuid(),
    conversation_id   uuid not null references public.conversations (id) on delete cascade,
    role              text not null check (role in ('player', 'npc', 'system')),
    content           text not null check (char_length(content) between 1 and 8000),
    source_refs       jsonb not null default '[]'::jsonb,
    client_message_id uuid,
    created_at        timestamptz not null default now(),
    unique (conversation_id, client_message_id)
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);

-- ------------------------------------------------------------------ memory + progress

create table public.npc_memories (
    id                   uuid primary key default gen_random_uuid(),
    player_id            uuid not null references public.players (id) on delete cascade,
    npc_id               uuid not null references public.npcs (id) on delete cascade,
    summary              text not null default '' check (char_length(summary) <= 1500),
    current_topic        text not null default '' check (char_length(current_topic) <= 120),
    topics_studied       text[] not null default '{}',
    learning_preferences text[] not null default '{}',
    channels_used        text[] not null default '{}',
    updated_at           timestamptz not null default now(),
    unique (player_id, npc_id)
);

create table public.class_progress (
    id                      uuid primary key default gen_random_uuid(),
    player_id               uuid not null references public.players (id) on delete cascade,
    class_id                uuid not null references public.classes (id) on delete cascade,
    topics_mastered         text[] not null default '{}',
    topics_needing_practice text[] not null default '{}',
    last_activity           timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    unique (player_id, class_id)
);

-- ------------------------------------------------------------------ rate limits (server only)

create table public.api_rate_limits (
    user_id      uuid not null,
    bucket       text not null,
    window_start timestamptz not null,
    hits         int not null default 0,
    primary key (user_id, bucket, window_start)
);
create index api_rate_limits_window_idx on public.api_rate_limits (window_start);

create or replace function public.consume_rate_limit (p_user_id uuid, p_bucket text, p_max int, p_window_seconds int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
    v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
    v_hits int;
begin
    insert into public.api_rate_limits as r (user_id, bucket, window_start, hits)
    values (p_user_id, p_bucket, v_window, 1)
    on conflict (user_id, bucket, window_start) do update set hits = r.hits + 1
    returning r.hits into v_hits;
    if random() < 0.02 then
        delete from public.api_rate_limits where window_start < now() - interval '2 days';
    end if;
    return v_hits <= p_max;
end $$;

-- ------------------------------------------------------------------ atomic chat turn (server only)

-- Saves one player message + NPC reply, and the merged memory/progress, in one transaction.
-- Used by every channel (game chat now; FaceTime / iMessage agents later).
create or replace function public.save_tutor_turn (
    p_player_id uuid, p_npc_id uuid, p_conversation_id uuid, p_channel text,
    p_player_message text, p_client_message_id uuid, p_reply text, p_source_refs jsonb,
    p_memory jsonb, p_progress jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_class_id uuid;
    v_conversation_id uuid := p_conversation_id;
begin
    select class_id into v_class_id from public.npcs where id = p_npc_id;
    if v_class_id is null then raise exception 'Unknown NPC' using errcode = 'P0002'; end if;

    if v_conversation_id is null then
        insert into public.conversations (player_id, npc_id, class_id, channel)
        values (p_player_id, p_npc_id, v_class_id, p_channel) returning id into v_conversation_id;
    else
        update public.conversations set updated_at = now()
        where id = v_conversation_id and player_id = p_player_id and npc_id = p_npc_id and channel = p_channel;
        if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;
    end if;

    insert into public.messages (conversation_id, role, content, client_message_id, created_at)
    values (v_conversation_id, 'player', p_player_message, p_client_message_id, clock_timestamp());
    insert into public.messages (conversation_id, role, content, source_refs, created_at)
    values (v_conversation_id, 'npc', p_reply, coalesce(p_source_refs, '[]'::jsonb), clock_timestamp());

    insert into public.npc_memories as m (player_id, npc_id, summary, current_topic, topics_studied, learning_preferences, channels_used)
    values (
        p_player_id, p_npc_id,
        coalesce(p_memory ->> 'summary', ''),
        coalesce(p_memory ->> 'current_topic', ''),
        coalesce(array(select jsonb_array_elements_text(p_memory -> 'topics_studied')), '{}'),
        coalesce(array(select jsonb_array_elements_text(p_memory -> 'learning_preferences')), '{}'),
        array[p_channel])
    on conflict (player_id, npc_id) do update set
        summary = excluded.summary,
        current_topic = excluded.current_topic,
        topics_studied = excluded.topics_studied,
        learning_preferences = excluded.learning_preferences,
        channels_used = (select array(select distinct unnest(m.channels_used || excluded.channels_used))),
        updated_at = now();

    insert into public.class_progress as p (player_id, class_id, topics_mastered, topics_needing_practice, last_activity)
    values (
        p_player_id, v_class_id,
        coalesce(array(select jsonb_array_elements_text(p_progress -> 'topics_mastered')), '{}'),
        coalesce(array(select jsonb_array_elements_text(p_progress -> 'topics_needing_practice')), '{}'),
        now())
    on conflict (player_id, class_id) do update set
        topics_mastered = excluded.topics_mastered,
        topics_needing_practice = excluded.topics_needing_practice,
        last_activity = now(),
        updated_at = now();

    return v_conversation_id;
end $$;

-- ------------------------------------------------------------------ future channel pairing

-- A player starts pairing in game (one-time code, stored hashed); the trusted Chert/LiveKit
-- webhook later proves the caller entered that code and stores an HMAC of their verified
-- external identity. A phone number alone never identifies a player. Server-only writes.
create table public.channel_pairings (
    id                     uuid primary key default gen_random_uuid(),
    player_id              uuid not null references public.players (id) on delete cascade,
    npc_id                 uuid not null references public.npcs (id) on delete cascade,
    channel                text not null check (channel in ('facetime', 'imessage')),
    code_hash              text not null,
    expires_at             timestamptz not null,
    external_identity_hash text,
    verified_at            timestamptz,
    revoked_at             timestamptz,
    created_at             timestamptz not null default now()
);
create unique index channel_pairings_active_identity_idx on public.channel_pairings (channel, external_identity_hash)
    where verified_at is not null and revoked_at is null;
create index channel_pairings_player_idx on public.channel_pairings (player_id);

-- ------------------------------------------------------------------ row level security

alter table public.players enable row level security;
alter table public.classes enable row level security;
alter table public.class_members enable row level security;
alter table public.npcs enable row level security;
alter table public.class_documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.npc_memories enable row level security;
alter table public.class_progress enable row level security;
alter table public.api_rate_limits enable row level security;
alter table public.channel_pairings enable row level security;

-- Nothing here is for signed-out visitors.
revoke all on all tables in schema public from anon;

create policy players_select_own on public.players for select to authenticated
    using (id = (select auth.uid()));
create policy players_update_own on public.players for update to authenticated
    using (id = (select auth.uid())) with check (id = (select auth.uid()));
revoke insert, update, delete on public.players from authenticated;
grant update (display_name, legacy_local_id) on public.players to authenticated;

create policy classes_select_member on public.classes for select to authenticated
    using (public.can_access_class(id));
create policy classes_insert_own on public.classes for insert to authenticated
    with check (owner_id = (select auth.uid()));
create policy classes_update_own on public.classes for update to authenticated
    using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy classes_delete_own on public.classes for delete to authenticated
    using (owner_id = (select auth.uid()));

create policy class_members_select on public.class_members for select to authenticated
    using (player_id = (select auth.uid()) or public.can_manage_class(class_id));
revoke insert, update, delete on public.class_members from authenticated;

create policy npcs_select_member on public.npcs for select to authenticated
    using (public.can_access_class(class_id));
create policy npcs_insert_own on public.npcs for insert to authenticated
    with check (owner_id = (select auth.uid()));
create policy npcs_update_own on public.npcs for update to authenticated
    using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy npcs_delete_own on public.npcs for delete to authenticated
    using (owner_id = (select auth.uid()));

create policy class_documents_select on public.class_documents for select to authenticated
    using (uploaded_by = (select auth.uid())
           or (visibility = 'class' and public.can_access_class(class_id)));
revoke insert, update, delete on public.class_documents from authenticated;

create policy document_chunks_select on public.document_chunks for select to authenticated
    using (public.can_read_document(document_id));
revoke insert, update, delete on public.document_chunks from authenticated;

create policy conversations_select_own on public.conversations for select to authenticated
    using (player_id = (select auth.uid()));
revoke insert, update, delete on public.conversations from authenticated;

create policy messages_select_own on public.messages for select to authenticated
    using (exists (select 1 from public.conversations c
                   where c.id = conversation_id and c.player_id = (select auth.uid())));
revoke insert, update, delete on public.messages from authenticated;

create policy npc_memories_select_own on public.npc_memories for select to authenticated
    using (player_id = (select auth.uid()));
revoke insert, update, delete on public.npc_memories from authenticated;

create policy class_progress_select_own on public.class_progress for select to authenticated
    using (player_id = (select auth.uid()));
revoke insert, update, delete on public.class_progress from authenticated;

revoke all on public.api_rate_limits from authenticated;

create policy channel_pairings_select_own on public.channel_pairings for select to authenticated
    using (player_id = (select auth.uid()));
revoke insert, update, delete on public.channel_pairings from authenticated;

-- Server-only functions.
revoke execute on function public.consume_rate_limit (uuid, text, int, int) from public, anon, authenticated;
revoke execute on function public.save_tutor_turn (uuid, uuid, uuid, text, text, uuid, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.consume_rate_limit (uuid, text, int, int) to service_role;
grant execute on function public.save_tutor_turn (uuid, uuid, uuid, text, text, uuid, text, jsonb, jsonb, jsonb) to service_role;
revoke execute on function public.match_npc_chunks (uuid, text, int, uuid) from public, anon;
grant execute on function public.match_npc_chunks (uuid, text, int, uuid) to authenticated, service_role;
revoke execute on function public.can_access_class (uuid) from public, anon;
revoke execute on function public.can_manage_class (uuid) from public, anon;
revoke execute on function public.can_read_document (uuid) from public, anon;
grant execute on function public.can_access_class (uuid) to authenticated, service_role;
grant execute on function public.can_manage_class (uuid) to authenticated, service_role;
grant execute on function public.can_read_document (uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ private storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('class-materials', 'class-materials', false, 10485760, array[
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Objects live at "<uploader uid>/<document id>/<file name>". Uploads use one-time signed
-- URLs issued by the class-documents function, so no client insert/update policy exists.
create policy class_materials_read_own on storage.objects for select to authenticated
    using (bucket_id = 'class-materials' and (storage.foldername(name))[1] = (select auth.uid())::text);
