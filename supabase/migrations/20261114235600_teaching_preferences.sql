-- Chat-based teacher personalisation (additive, non-destructive).
--
-- npc_memories.learning_preferences now holds the student's CONFIRMED teaching preferences for
-- one NPC ("use short explanations"). The model can only propose one; the proposal waits in
-- pending_preference and is saved on the next turn only if the student confirms it.
-- Existing values are kept as-is.

alter table public.npc_memories
    add column if not exists pending_preference text not null default ''
        check (char_length(pending_preference) <= 200);

-- Same signature as before (CREATE OR REPLACE keeps the service-role-only grants); it now
-- also stores p_memory.pending_preference.
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

    insert into public.npc_memories as m (player_id, npc_id, summary, current_topic, topics_studied, learning_preferences, pending_preference, channels_used)
    values (
        p_player_id, p_npc_id,
        coalesce(p_memory ->> 'summary', ''),
        coalesce(p_memory ->> 'current_topic', ''),
        coalesce(array(select jsonb_array_elements_text(p_memory -> 'topics_studied')), '{}'),
        coalesce(array(select jsonb_array_elements_text(p_memory -> 'learning_preferences')), '{}'),
        left(coalesce(p_memory ->> 'pending_preference', ''), 200),
        array[p_channel])
    on conflict (player_id, npc_id) do update set
        summary = excluded.summary,
        current_topic = excluded.current_topic,
        topics_studied = excluded.topics_studied,
        learning_preferences = excluded.learning_preferences,
        pending_preference = excluded.pending_preference,
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

-- The signed-in student removes one saved teaching preference (p_preference) or all of them
-- (null) for one NPC. Only ever touches the caller's own memory row (auth.uid()).
create or replace function public.forget_teaching_preference (p_npc_id uuid, p_preference text default null)
returns text[]
language plpgsql security definer set search_path = '' as $$
declare
    v_prefs text[];
begin
    if (select auth.uid()) is null then raise exception 'Not signed in' using errcode = '42501'; end if;
    update public.npc_memories
    set learning_preferences = case when p_preference is null then '{}'::text[]
            else array(select x from unnest(learning_preferences) as x where lower(x) <> lower(p_preference)) end,
        pending_preference = '',
        updated_at = now()
    where player_id = (select auth.uid()) and npc_id = p_npc_id
    returning learning_preferences into v_prefs;
    return coalesce(v_prefs, '{}'::text[]);
end $$;

revoke execute on function public.forget_teaching_preference (uuid, text) from public, anon;
grant execute on function public.forget_teaching_preference (uuid, text) to authenticated;
