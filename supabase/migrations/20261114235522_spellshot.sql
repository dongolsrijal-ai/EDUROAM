-- Spellshot mini-game. Additive: allows the new game type and lets a question have 3-5 answer
-- choices (Spellshot's difficulty setting). Answer keys stay hidden exactly as before.

alter table public.minigame_sessions drop constraint minigame_sessions_game_type_check;
alter table public.minigame_sessions add constraint minigame_sessions_game_type_check
    check (game_type in ('answer_dash', 'spellshot'));

-- Same contract as before (first answer wins, own active session only), but the valid choice
-- range now comes from the stored question itself instead of a fixed 0-3.
create or replace function public.record_minigame_answer (p_session_id uuid, p_player_id uuid, p_index int, p_choice int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_answers jsonb;
begin
    update public.minigame_sessions
       set answers = answers || jsonb_build_object(p_index::text, p_choice)
     where id = p_session_id and player_id = p_player_id and status = 'active'
       and p_index >= 0 and p_index < jsonb_array_length(questions)
       and p_choice >= 0 and p_choice < coalesce(jsonb_array_length(questions -> p_index -> 'choices'), 0)
       and not (answers ? p_index::text);
    select answers into v_answers from public.minigame_sessions where id = p_session_id and player_id = p_player_id;
    return v_answers;
end $$;
revoke execute on function public.record_minigame_answer (uuid, uuid, int, int) from public, anon, authenticated;
grant execute on function public.record_minigame_answer (uuid, uuid, int, int) to service_role;
