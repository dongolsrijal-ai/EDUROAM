-- Only public identity/deletion status belongs in the player roster report. Private
-- paths and room manifests may include other students' uploads and remain server-only.
revoke select on public.npc_deletions from authenticated;
grant select (npc_id, owner_id, game_npc_id, completed_at) on public.npc_deletions to authenticated;
