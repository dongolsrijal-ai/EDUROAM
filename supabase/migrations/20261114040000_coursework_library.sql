-- Coursework Library: image uploads, pasted text, organisation metadata. Non-destructive:
-- existing rows keep their values; the file_type CHECK is only widened (dropped and re-added
-- with a superset of the old values in one transaction); new columns have defaults.

alter table public.class_documents drop constraint if exists class_documents_file_type_check;
alter table public.class_documents add constraint class_documents_file_type_check
    check (file_type in ('pdf', 'txt', 'docx', 'png', 'jpeg', 'webp', 'heic', 'text'));

alter table public.class_documents
    add column if not exists topic text not null default '' check (char_length(topic) <= 80),
    add column if not exists chapter text not null default '' check (char_length(chapter) <= 80),
    -- Processing metadata, e.g. images: { kind, needs_review, uncertain[], figures, corrected }.
    add column if not exists extraction jsonb not null default '{}'::jsonb;

create index if not exists class_documents_class_topic_idx on public.class_documents (class_id, topic, chapter);

-- Same private bucket and 10 MB limit; additionally accept image coursework.
update storage.buckets
   set allowed_mime_types = array[
        'application/pdf',
        'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'],
       public = false
 where id = 'class-materials';
