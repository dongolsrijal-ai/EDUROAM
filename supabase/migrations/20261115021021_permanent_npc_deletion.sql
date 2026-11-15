-- Durable cleanup manifests also act as account-scoped tombstones. Never delete existing
-- teachers here. Only the authenticated lifecycle endpoint may prepare/finalize a deletion.
create table public.npc_deletions (
    npc_id uuid primary key,
    owner_id uuid not null references public.players(id) on delete cascade,
    game_npc_id text not null,
    file_paths text[] not null default '{}',
    room_names text[] not null default '{}',
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    next_cleanup_at timestamptz,
    cleanup_until timestamptz,
    unique(owner_id, game_npc_id)
);
alter table public.npc_deletions enable row level security;
revoke all on public.npc_deletions from anon, authenticated;
grant select on public.npc_deletions to authenticated;
grant all on public.npc_deletions to service_role;
create policy npc_deletions_read_own on public.npc_deletions for select to authenticated
    using (owner_id = (select auth.uid()));
-- A direct browser DELETE would skip the Storage cleanup and shared-material preservation.
revoke delete on public.npcs from anon, authenticated;

create function public.prepare_npc_deletion(p_owner_id uuid, p_npc_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_npc public.npcs;
    v_job public.npc_deletions;
begin
    -- Same lock as NPC synchronization/limit enforcement. Authorize BEFORE recording intent.
    perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));
    select * into v_job from public.npc_deletions where npc_id=p_npc_id and owner_id=p_owner_id;
    if found then return to_jsonb(v_job); end if;
    select * into v_npc from public.npcs where id=p_npc_id and owner_id=p_owner_id for update;
    if not found then raise exception 'NPC not found' using errcode='P0002'; end if;
    insert into public.npc_deletions(npc_id,owner_id,game_npc_id,file_paths,room_names)
    values (v_npc.id,p_owner_id,v_npc.game_npc_id,
        array(select file_path from public.class_documents where npc_id=p_npc_id and visibility='private' order by file_path),
        array(select room_name from public.voice_sessions where npc_id=p_npc_id and ended_at is null order by room_name))
    returning * into v_job;
    return to_jsonb(v_job);
end $$;

create function public.finish_npc_deletion(p_owner_id uuid, p_npc_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_job public.npc_deletions;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));
    select * into v_job from public.npc_deletions where npc_id=p_npc_id and owner_id=p_owner_id for update;
    if not found then raise exception 'NPC not found' using errcode='P0002'; end if;
    if v_job.completed_at is not null then return; end if;
    -- Use the same lock order as atomic chunk replacement (document, then chunks).
    perform 1 from public.class_documents where npc_id=p_npc_id for update;
    -- Shared coursework belongs to the class, even if originally uploaded via this teacher.
    -- Both FKs must be detached before the NPC cascade runs. Keep the class and its progress.
    update public.document_chunks c set npc_id=null from public.class_documents d
        where c.document_id=d.id and d.npc_id=p_npc_id and d.visibility='class';
    update public.class_documents set npc_id=null where npc_id=p_npc_id and visibility='class';
    delete from public.npcs where id=p_npc_id and owner_id=p_owner_id;
    -- Signed upload URLs already issued by Storage remain valid for two hours. Sweep
    -- through that horizon and a grace period; failed sweeps remain due until successful.
    update public.npc_deletions set completed_at=now(), next_cleanup_at=now()+interval '5 minutes',
        cleanup_until=now()+interval '2 hours 15 minutes' where npc_id=p_npc_id;
end $$;
revoke execute on function public.prepare_npc_deletion(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.finish_npc_deletion(uuid,uuid) from public, anon, authenticated;
grant execute on function public.prepare_npc_deletion(uuid,uuid) to service_role;
grant execute on function public.finish_npc_deletion(uuid,uuid) to service_role;

-- A teacher created offline may never have had a remote row. Record its stable game id
-- only after proving there is no owned row; a concurrent sync is serialized by this lock.
create function public.discard_local_npc(p_owner_id uuid, p_game_npc_id text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
    if p_game_npc_id is null or p_game_npc_id !~ '^[A-Za-z0-9_-]{1,64}$' then
        raise exception 'Invalid NPC identity' using errcode='22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));
    if exists(select 1 from public.npcs where owner_id=p_owner_id and game_npc_id=p_game_npc_id) then
        raise exception 'Teacher was synchronized. Refresh and retry deletion using its database ID.' using errcode='P0001';
    end if;
    insert into public.npc_deletions(npc_id,owner_id,game_npc_id,completed_at)
    values(gen_random_uuid(),p_owner_id,p_game_npc_id,now())
    on conflict(owner_id,game_npc_id) do update set game_npc_id=excluded.game_npc_id
    returning npc_id into v_id;
    return v_id;
end $$;
revoke execute on function public.discard_local_npc(uuid,text) from public,anon,authenticated;
grant execute on function public.discard_local_npc(uuid,text) to service_role;

-- No stale tab/save/upsert may recreate an identity once deletion has been requested.
create function private.reject_deleted_npc_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 0));
    if exists(select 1 from public.npc_deletions where owner_id=new.owner_id and game_npc_id=new.game_npc_id) then
        raise exception 'This teacher was permanently deleted or is being deleted. Refresh the NPC list.' using errcode='P0001';
    end if;
    return new;
end $$;
create trigger npcs_deletion_guard before insert or update on public.npcs
    for each row execute function private.reject_deleted_npc_sync();

-- Coordinate new uploads and calls with preparation's FOR UPDATE lock. An upload/call
-- either precedes the manifest snapshot, or is refused. No new private files escape cleanup.
create function private.reject_deleting_npc_use() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if tg_table_name='class_documents' and tg_op='UPDATE' then
        -- Existing shared originals are retained. Let an in-flight extractor finish;
        -- its chunk replacement derives the current, possibly detached document scope.
        if old.visibility='class' and new.visibility='class'
            and new.npc_id is not distinct from old.npc_id and new.file_path=old.file_path then
            return new;
        end if;
    end if;
    if new.npc_id is not null then
        perform 1 from public.npcs where id=new.npc_id for key share;
        if exists(select 1 from public.npc_deletions where npc_id=new.npc_id) then
            raise exception 'This teacher is being deleted. Finish deletion from the NPC list.' using errcode='P0001';
        end if;
    end if;
    return new;
end $$;
create trigger class_documents_deletion_guard before insert or update on public.class_documents
    for each row execute function private.reject_deleting_npc_use();
create trigger voice_sessions_deletion_guard before insert on public.voice_sessions
    for each row execute function private.reject_deleting_npc_use();
revoke execute on function private.reject_deleted_npc_sync() from public,anon,authenticated;
revoke execute on function private.reject_deleting_npc_use() from public,anon,authenticated;

-- Extraction may have started before its teacher was deleted. Derive canonical scope
-- under the document lock instead of reinserting a cached, now-deleted NPC identity.
create function public.replace_document_chunks(p_document_id uuid, p_chunks jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_document public.class_documents;
begin
    if jsonb_typeof(p_chunks) <> 'array' or jsonb_array_length(p_chunks)>400 then
        raise exception 'Invalid document chunks' using errcode='22023';
    end if;
    select * into v_document from public.class_documents where id=p_document_id for update;
    if not found then raise exception 'Document not found' using errcode='P0002'; end if;
    if v_document.visibility='private' and exists(select 1 from public.npc_deletions where npc_id=v_document.npc_id) then
        raise exception 'This teacher is being deleted' using errcode='P0001';
    end if;
    delete from public.document_chunks where document_id=p_document_id;
    insert into public.document_chunks(document_id,class_id,npc_id,chunk_index,chunk_text,source)
        select p_document_id,v_document.class_id,v_document.npc_id,x.chunk_index,x.chunk_text,coalesce(x.source,'{}'::jsonb)
        from jsonb_to_recordset(p_chunks) as x(chunk_index int,chunk_text text,source jsonb);
end $$;
revoke execute on function public.replace_document_chunks(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.replace_document_chunks(uuid,jsonb) to service_role;

-- Hosted Supabase provides these native extensions; the PGlite test shim does not.
-- Credentials/URL are provisioned separately into Vault and Edge secrets, never source.
do $schedule$
begin
    if exists(select 1 from pg_available_extensions where name='pg_cron') then
        create extension if not exists pg_cron with schema pg_catalog;
        create extension if not exists pg_net with schema extensions;
        perform cron.schedule('npc-private-file-cleanup','*/5 * * * *', $command$
            select net.http_post(
                url := (select decrypted_secret from vault.decrypted_secrets where name='npc_cleanup_url'),
                headers := jsonb_build_object('Content-Type','application/json','x-npc-cleanup-secret',
                    (select decrypted_secret from vault.decrypted_secrets where name='npc_cleanup_secret')),
                body := '{"action":"sweep"}'::jsonb, timeout_milliseconds := 20000)
            where exists(select 1 from public.npc_deletions where completed_at is not null and next_cleanup_at<=now())
              and exists(select 1 from vault.decrypted_secrets where name='npc_cleanup_secret')
              and exists(select 1 from vault.decrypted_secrets where name='npc_cleanup_url');
        $command$);
    end if;
end $schedule$;
