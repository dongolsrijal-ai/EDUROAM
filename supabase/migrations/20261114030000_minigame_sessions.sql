-- Mini-game sessions (Answer Dash first). Additive only: one new table + one server function.
--
-- * `questions` holds the generated pack INCLUDING answer keys; players may read their own
--   session rows but NOT that column (column-level grant), so keys never reach the browser
--   before a question is answered.
-- * All writes go through the `answer-dash` Edge Function (service role): answers are
--   recorded once per question (first answer wins, retries are idempotent) and results are
--   graded server-side, so scores cannot be forged.

create table public.minigame_sessions (
    id                  uuid primary key default gen_random_uuid(),
    player_id           uuid not null references public.players (id) on delete cascade,
    npc_id              uuid not null references public.npcs (id) on delete cascade,
    class_id            uuid references public.classes (id) on delete set null,
    game_type           text not null check (game_type in ('answer_dash')),
    source_mode         text not null check (source_mode in ('documents', 'subject')),
    source_document_ids uuid[] not null default '{}',
    pack_hash           text not null,
    questions           jsonb not null check (jsonb_typeof(questions) = 'array'),
    answers             jsonb not null default '{}'::jsonb,
    status              text not null default 'active' check (status in ('active', 'completed')),
    correct_count       int not null default 0,
    incorrect_count     int not null default 0,
    score               int not null default 0,
    best_streak         int not null default 0,
    topic_performance   jsonb not null default '{}'::jsonb,
    created_at          timestamptz not null default now(),
    completed_at        timestamptz
);
create index minigame_sessions_player_npc_idx on public.minigame_sessions (player_id, npc_id, created_at desc);
create index minigame_sessions_npc_idx on public.minigame_sessions (npc_id);
create index minigame_sessions_class_idx on public.minigame_sessions (class_id);

alter table public.minigame_sessions enable row level security;
revoke all on public.minigame_sessions from anon, authenticated;
grant select (id, player_id, npc_id, class_id, game_type, source_mode, source_document_ids, pack_hash, status,
              correct_count, incorrect_count, score, best_streak, topic_performance, created_at, completed_at)
    on public.minigame_sessions to authenticated;
create policy minigame_sessions_select_own on public.minigame_sessions for select to authenticated
    using (player_id = (select auth.uid()));

-- Records the player's FIRST answer to one question of their own active session and returns
-- the stored answers (so a retry returns the original choice instead of overwriting it).
create or replace function public.record_minigame_answer (p_session_id uuid, p_player_id uuid, p_index int, p_choice int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_answers jsonb;
begin
    update public.minigame_sessions
       set answers = answers || jsonb_build_object(p_index::text, p_choice)
     where id = p_session_id and player_id = p_player_id and status = 'active'
       and p_index >= 0 and p_index < jsonb_array_length(questions)
       and p_choice between 0 and 3
       and not (answers ? p_index::text);
    select answers into v_answers from public.minigame_sessions where id = p_session_id and player_id = p_player_id;
    return v_answers;
end $$;
revoke execute on function public.record_minigame_answer (uuid, uuid, int, int) from public, anon, authenticated;
grant execute on function public.record_minigame_answer (uuid, uuid, int, int) to service_role;
