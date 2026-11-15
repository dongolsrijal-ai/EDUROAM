-- Fix: "new row violates row-level security policy for table classes" when the game
-- upserts a class with .upsert(...).select() (INSERT ... ON CONFLICT ... RETURNING).
--
-- Postgres applies the SELECT policy to rows returned by INSERT/UPSERT. The old policy only
-- called can_access_class(id), which looks the class up in public.classes with the
-- statement's snapshot - the row being inserted is not visible there, so the check failed
-- even for the rightful owner. Checking ownership on the row itself fixes that; access for
-- class members is unchanged (still via can_access_class / class_members).

drop policy if exists classes_select_member on public.classes;
create policy classes_select_member on public.classes for select to authenticated
    using (owner_id = (select auth.uid()) or public.can_access_class(id));
