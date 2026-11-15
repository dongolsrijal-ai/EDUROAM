-- Security hardening (Supabase advisor: SECURITY DEFINER functions callable through the API).
--
-- 1. The RLS helper functions move from `public` (exposed by PostgREST as /rpc/...) to a
--    non-exposed `private` schema. Policies still call them as the querying role, so
--    `authenticated` keeps EXECUTE + USAGE; they just can't be called as RPC endpoints.
-- 2. Trigger functions are not meant to be called directly: EXECUTE is revoked from API
--    roles (Postgres checks it when a trigger is created, not when it fires, so the
--    player-creation trigger, limits and updated_at triggers keep working).
-- Non-destructive: no table or data changes; policies keep the same logic.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create or replace function private.can_access_class (p_class_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.classes c where c.id = p_class_id and c.owner_id = (select auth.uid()))
        or exists (select 1 from public.class_members m where m.class_id = p_class_id and m.player_id = (select auth.uid()));
$$;

create or replace function private.can_manage_class (p_class_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.classes c where c.id = p_class_id and c.owner_id = (select auth.uid()))
        or exists (select 1 from public.class_members m
                   where m.class_id = p_class_id and m.player_id = (select auth.uid()) and m.role = 'teacher');
$$;

create or replace function private.can_read_document (p_document_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (
        select 1 from public.class_documents d
        where d.id = p_document_id
          and (d.uploaded_by = (select auth.uid())
               or (d.visibility = 'class' and private.can_access_class(d.class_id))));
$$;

revoke execute on all functions in schema private from public, anon;
grant execute on function private.can_access_class (uuid), private.can_manage_class (uuid), private.can_read_document (uuid)
    to authenticated, service_role;

-- Same rules, now referencing the private helpers. Ownership is checked on the row itself
-- first (also needed for INSERT ... RETURNING, see 20261114010000).
alter policy classes_select_member on public.classes
    using (owner_id = (select auth.uid()) or private.can_access_class(id));
alter policy class_members_select on public.class_members
    using (player_id = (select auth.uid()) or private.can_manage_class(class_id));
alter policy npcs_select_member on public.npcs
    using (owner_id = (select auth.uid()) or private.can_access_class(class_id));
alter policy class_documents_select on public.class_documents
    using (uploaded_by = (select auth.uid()) or (visibility = 'class' and private.can_access_class(class_id)));
alter policy document_chunks_select on public.document_chunks
    using (private.can_read_document(document_id));

drop function public.can_read_document (uuid);
drop function public.can_manage_class (uuid);
drop function public.can_access_class (uuid);

revoke execute on function public.handle_new_auth_user () from public, anon, authenticated;
revoke execute on function public.set_updated_at () from public, anon, authenticated;
revoke execute on function public.enforce_npc_limits () from public, anon, authenticated;
revoke execute on function public.enforce_class_limit () from public, anon, authenticated;
