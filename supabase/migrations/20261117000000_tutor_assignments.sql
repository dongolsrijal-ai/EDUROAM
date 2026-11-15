-- AI tutor, phase 2: assignments + study tasks + the student's timezone.
-- Expand-only (new tables, one nullable column): nothing existing is altered or dropped.
--
-- assignments   one student's work for one class. A due date is either a SUGGESTION (from the tutor
--               or a deadline found in an uploaded file) or CONFIRMED by the student. Deleting is
--               soft (deleted_at) so reminders can tell "deleted" from "never existed".
-- study_tasks   planned study sessions (optionally for an assignment), created by the student or by
--               the tutor with the student's approval.
-- Both are owner-only under RLS; the voice-agent Edge Function (service role) writes them only for
-- the student of an authorised voice session, and a trigger re-checks class access for every writer.

alter table public.players add column if not exists timezone text
    check (timezone is null or char_length(timezone) between 1 and 64);

create table public.assignments (
    id                 uuid primary key default gen_random_uuid(),
    player_id          uuid not null references public.players (id) on delete cascade,
    class_id           uuid references public.classes (id) on delete set null,
    npc_id             uuid references public.npcs (id) on delete set null,
    title              text not null check (char_length(title) between 1 and 160),
    description        text not null default '' check (char_length(description) <= 2000),
    source_document_id uuid references public.class_documents (id) on delete set null,
    due_at             timestamptz,
    due_timezone       text check (due_timezone is null or char_length(due_timezone) between 1 and 64),
    due_status         text not null default 'none' check (due_status in ('none', 'suggested', 'confirmed')),
    status             text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
    estimated_minutes  int check (estimated_minutes is null or estimated_minutes between 5 and 6000),
    study_plan         jsonb not null default '[]'::jsonb check (jsonb_typeof(study_plan) = 'array' and pg_column_size(study_plan) <= 16384),
    reminder_prefs     jsonb not null default '{}'::jsonb check (jsonb_typeof(reminder_prefs) = 'object' and pg_column_size(reminder_prefs) <= 4096),
    last_notified_at   timestamptz,
    created_by         text not null default 'student' check (created_by in ('student', 'tutor')),
    deleted_at         timestamptz,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    check (due_status = 'none' or due_at is not null)
);
create index assignments_player_due_idx on public.assignments (player_id, due_at) where deleted_at is null;
create trigger assignments_updated_at before update on public.assignments
    for each row execute function public.set_updated_at();

create table public.study_tasks (
    id               uuid primary key default gen_random_uuid(),
    player_id        uuid not null references public.players (id) on delete cascade,
    assignment_id    uuid references public.assignments (id) on delete cascade,
    class_id         uuid references public.classes (id) on delete set null,
    npc_id           uuid references public.npcs (id) on delete set null,
    title            text not null check (char_length(title) between 1 and 160),
    notes            text not null default '' check (char_length(notes) <= 1000),
    starts_at        timestamptz,
    duration_minutes int not null default 30 check (duration_minutes between 5 and 600),
    status           text not null default 'planned' check (status in ('planned', 'done', 'skipped', 'cancelled')),
    created_by       text not null default 'student' check (created_by in ('student', 'tutor')),
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);
create index study_tasks_player_start_idx on public.study_tasks (player_id, starts_at);
create trigger study_tasks_updated_at before update on public.study_tasks
    for each row execute function public.set_updated_at();

-- Every writer (browser or service role): the class / NPC / document / assignment must be one this
-- student may use. auth.uid() is not used, so the check holds for server writes too.
create or replace function public.check_student_work () returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    v_class uuid := new.class_id;
    v_new jsonb := to_jsonb(new);
    v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
begin
    -- Status / text / date edits keep working even if the student later left the class.
    if tg_op = 'UPDATE' and new.player_id = old.player_id
        and (v_new -> 'class_id') is not distinct from (v_old -> 'class_id')
        and (v_new -> 'npc_id') is not distinct from (v_old -> 'npc_id')
        and (v_new -> 'assignment_id') is not distinct from (v_old -> 'assignment_id')
        and (v_new -> 'source_document_id') is not distinct from (v_old -> 'source_document_id')
    then
        return new;
    end if;
    -- Fields that exist on only one of the two tables are read through jsonb.
    if (v_new ->> 'assignment_id') is not null then
        select a.class_id into v_class from public.assignments a
            where a.id = (v_new ->> 'assignment_id')::uuid and a.player_id = new.player_id and a.deleted_at is null;
        if not found then raise exception 'assignment not found' using errcode = 'P0002'; end if;
        new.class_id := coalesce(new.class_id, v_class);
        v_class := new.class_id;
    end if;
    if v_class is not null and not exists (
        select 1 from public.classes c where c.id = v_class and c.owner_id = new.player_id
        union all
        select 1 from public.class_members m where m.class_id = v_class and m.player_id = new.player_id)
    then
        raise exception 'class not accessible' using errcode = '42501';
    end if;
    if new.npc_id is not null and not exists (select 1 from public.npcs n where n.id = new.npc_id and n.class_id = v_class) then
        raise exception 'npc does not belong to this class' using errcode = '42501';
    end if;
    if (v_new ->> 'source_document_id') is not null and not exists (
        select 1 from public.class_documents d where d.id = (v_new ->> 'source_document_id')::uuid and d.class_id = v_class
            and (d.visibility = 'class' or d.uploaded_by = new.player_id))
    then
        raise exception 'document not accessible' using errcode = '42501';
    end if;
    return new;
end $$;
revoke all on function public.check_student_work () from public, anon, authenticated;

create trigger assignments_check before insert or update on public.assignments
    for each row execute function public.check_student_work();
create trigger study_tasks_check before insert or update on public.study_tasks
    for each row execute function public.check_student_work();

alter table public.assignments enable row level security;
alter table public.study_tasks enable row level security;
revoke all on public.assignments, public.study_tasks from anon;
grant select, insert, update, delete on public.assignments, public.study_tasks to authenticated;

create policy assignments_own on public.assignments for all to authenticated
    using (player_id = (select auth.uid())) with check (player_id = (select auth.uid()));
create policy study_tasks_own on public.study_tasks for all to authenticated
    using (player_id = (select auth.uid())) with check (player_id = (select auth.uid()));

-- The student may set their own timezone (the game sends the browser's IANA zone).
grant update (timezone) on public.players to authenticated;
