-- Imports from an old website. Every imported item remembers the set it came in,
-- so one switch in the Dashboard puts the whole set live or hides it again. An
-- import may also give each row its place in the order, because the app lists
-- items newest first.

-- ---------------------------------------------------------------- columns

alter table public.videos
  add column import_batch text
    check (import_batch is null or length(trim(import_batch)) between 1 and 60);

create index videos_import_batch_idx on public.videos (import_batch)
  where import_batch is not null;

-- --------------------------------------------------------------- activity

-- As before, but silent while a whole set changes, so the log gets one line
-- for the set instead of one per item.
create or replace function public.log_admin_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  label text;
  verb text;
  email text;
begin
  if coalesce(current_setting('app.quiet_activity', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  -- View counts and other non-admin changes are not admin activity.
  if auth.uid() is null or not public.is_admin() then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'videos' then
    label := coalesce(new.title, old.title);
    if tg_op = 'UPDATE' and new.is_published is distinct from old.is_published then
      verb := case when new.is_published then 'published' else 'hid' end;
    elsif tg_op = 'UPDATE' and new.is_featured is distinct from old.is_featured then
      verb := case when new.is_featured then 'pinned' else 'unpinned' end;
    end if;
  elsif tg_table_name = 'categories' then
    label := coalesce(new.name, old.name);
  else
    if coalesce(new.key, old.key) = 'launch_checklist' then
      return coalesce(new, old);
    end if;
    label := coalesce(new.key, old.key);
  end if;

  verb := coalesce(verb, case tg_op
    when 'INSERT' then 'created'
    when 'UPDATE' then 'edited'
    else 'deleted'
  end);

  select u.email into email from auth.users u where u.id = auth.uid();
  insert into public.admin_activity (actor_email, action, target_type, target_label)
    values (email, verb, tg_table_name, label);

  if random() < 0.01 then
    delete from public.admin_activity where created_at < now() - interval '180 days';
  end if;
  return coalesce(new, old);
end;
$$;

-- One line in the activity log for something done to a whole set.
create function public.log_set_activity(p_action text, p_label text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  insert into public.admin_activity (actor_email, action, target_type, target_label)
    select u.email, p_action, 'videos', p_label
    from auth.users u where u.id = auth.uid();
end;
$$;

revoke all on function public.log_set_activity(text, text) from public;
-- Called from import_items and set_batch_live, which run as the signed-in admin.
grant execute on function public.log_set_activity(text, text) to authenticated;

-- -------------------------------------------------------------- import rows

-- As before, plus two keys: "import_batch" names the set the row belongs to,
-- and "created_at" places a new row in the order. Rows that carry a set are
-- logged as one line per request.
create or replace function public.import_items(p_items jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  item jsonb;
  results jsonb := '[]'::jsonb;
  saved_id uuid;
  prompt text;
  publish boolean;
  batch text;
  saved_count int := 0;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) > 200 then
    raise exception 'send_up_to_200_rows' using errcode = '22023';
  end if;

  select max(nullif(value ->> 'import_batch', ''))
    into batch
    from jsonb_array_elements(p_items);
  if batch is not null then
    perform set_config('app.quiet_activity', 'on', true);
  end if;

  for item in select value from jsonb_array_elements(p_items) loop
    begin
      saved_id := nullif(item ->> 'id', '')::uuid;
      prompt := nullif(trim(coalesce(item ->> 'prompt', '')), '');
      publish := coalesce((item ->> 'publish')::boolean, false);

      if saved_id is null then
        if publish and nullif(item ->> 'media_path', '') is null then
          raise exception 'media_missing';
        end if;
        if publish and prompt is null then
          raise exception 'prompt_missing';
        end if;
        insert into public.videos (
          title, content_type, category_id, tags, media_path, thumb_path,
          duration_sec, media_bytes, source_name, is_published, import_batch,
          created_at
        ) values (
          item ->> 'title',
          coalesce(item ->> 'content_type', 'image'),
          nullif(item ->> 'category_id', '')::uuid,
          coalesce(array(select jsonb_array_elements_text(item -> 'tags')), '{}'),
          nullif(item ->> 'media_path', ''),
          nullif(item ->> 'thumb_path', ''),
          (item ->> 'duration_sec')::int,
          (item ->> 'media_bytes')::bigint,
          nullif(item ->> 'source_name', ''),
          publish,
          nullif(item ->> 'import_batch', ''),
          coalesce(nullif(item ->> 'created_at', '')::timestamptz, now())
        ) returning id into saved_id;
        if prompt is not null then
          insert into public.prompts (video_id, prompt_text) values (saved_id, prompt);
        end if;
      else
        if not exists (select 1 from public.videos where id = saved_id) then
          raise exception 'not_found';
        end if;
        -- The prompt first, so a draft can get its prompt and go live in one row.
        if prompt is not null then
          insert into public.prompts (video_id, prompt_text)
            values (saved_id, prompt)
            on conflict (video_id)
            do update set prompt_text = excluded.prompt_text;
        end if;
        update public.videos v set
          title = case when item ? 'title' then item ->> 'title' else v.title end,
          content_type = case when item ? 'content_type'
            then item ->> 'content_type' else v.content_type end,
          category_id = case when item ? 'category_id'
            then nullif(item ->> 'category_id', '')::uuid else v.category_id end,
          tags = case when item ? 'tags'
            then coalesce(array(select jsonb_array_elements_text(item -> 'tags')), '{}')
            else v.tags end,
          media_path = case when item ? 'media_path'
            then nullif(item ->> 'media_path', '') else v.media_path end,
          thumb_path = case when item ? 'thumb_path'
            then nullif(item ->> 'thumb_path', '') else v.thumb_path end,
          duration_sec = case when item ? 'duration_sec'
            then (item ->> 'duration_sec')::int else v.duration_sec end,
          media_bytes = case when item ? 'media_bytes'
            then (item ->> 'media_bytes')::bigint else v.media_bytes end,
          source_name = case when item ? 'source_name'
            then nullif(item ->> 'source_name', '') else v.source_name end,
          import_batch = case when item ? 'import_batch'
            then nullif(item ->> 'import_batch', '') else v.import_batch end,
          is_published = v.is_published or publish,
          publish_at = case when publish then null else v.publish_at end
        where v.id = saved_id;
        if not found then
          raise exception 'not_found';
        end if;
      end if;
      results := results || jsonb_build_array(jsonb_build_object('id', saved_id));
      saved_count := saved_count + 1;
    exception when others then
      results := results || jsonb_build_array(jsonb_build_object('error', sqlerrm));
    end;
  end loop;

  if batch is not null then
    perform set_config('app.quiet_activity', 'off', true);
    if saved_count > 0 then
      perform public.log_set_activity(
        'imported', format('%s items into %s', saved_count, batch)
      );
    end if;
  end if;
  return results;
end;
$$;

-- ------------------------------------------------------------------ sets

-- Each imported set with its counts, for the switches in the Library.
create function public.import_batches()
returns table (
  batch text,
  total bigint,
  live bigint,
  ready bigint,
  video_items bigint,
  image_items bigint
)
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  return query
    select v.import_batch,
      count(*),
      count(*) filter (where v.is_published),
      count(*) filter (
        where v.media_path is not null
          and exists (select 1 from public.prompts p where p.video_id = v.id)
      ),
      count(*) filter (where v.content_type = 'video'),
      count(*) filter (where v.content_type = 'image')
    from public.videos v
    where v.import_batch is not null
    group by v.import_batch
    order by v.import_batch;
end;
$$;

-- Puts every item of a set live, or hides them all. Items without a file or a
-- prompt cannot go live; they stay hidden and are counted as skipped.
create function public.set_batch_live(p_batch text, p_live boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  changed int;
  skipped int := 0;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  perform set_config('app.quiet_activity', 'on', true);
  if p_live then
    update public.videos v set is_published = true, publish_at = null
    where v.import_batch = p_batch
      and not v.is_published
      and v.media_path is not null
      and exists (select 1 from public.prompts p where p.video_id = v.id);
    get diagnostics changed = row_count;
    select count(*) into skipped
    from public.videos v
    where v.import_batch = p_batch and not v.is_published;
  else
    update public.videos v set is_published = false, publish_at = null
    where v.import_batch = p_batch and v.is_published;
    get diagnostics changed = row_count;
  end if;
  perform set_config('app.quiet_activity', 'off', true);

  if changed > 0 then
    perform public.log_set_activity(
      case when p_live then 'published' else 'hid' end,
      format('%s items of %s', changed, p_batch)
    );
  end if;
  return jsonb_build_object('changed', changed, 'skipped', skipped);
end;
$$;

revoke all on function public.import_batches() from public;
revoke all on function public.set_batch_live(text, boolean) from public;
grant execute on function public.import_batches() to authenticated;
grant execute on function public.set_batch_live(text, boolean) to authenticated;
