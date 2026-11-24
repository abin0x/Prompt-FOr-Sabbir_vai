-- Bulk work in the Dashboard: drafts that have a prompt but no file yet, the
-- original file name so a sheet of prompts and a folder of files can be matched,
-- and an import that saves many rows in one request.

-- ---------------------------------------------------------------- columns

-- A draft may wait for its file, but it can never go live without one: the app
-- shows every item as a picture or a clip.
alter table public.videos
  alter column media_path drop not null,
  add column source_name text
    check (source_name is null or length(source_name) between 1 and 255),
  add constraint videos_live_needs_media
    check (media_path is not null or not is_published);

create index videos_source_name_idx on public.videos (lower(source_name))
  where source_name is not null;

-- Same rule as the constraint, raised first so the Dashboard can say it plainly.
create or replace function public.require_prompt_to_publish()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_published and not old.is_published then
    if new.media_path is null then
      raise exception 'media_missing' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.prompts where video_id = new.id) then
      raise exception 'prompt_missing' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- -------------------------------------------------------- admin functions

drop function public.save_video(
  uuid, text, text, uuid, text[], text, text, int, text, boolean, bigint, timestamptz
);

-- As before, plus the original file name. Null keeps the name already saved.
create function public.save_video(
  p_id uuid,
  p_title text,
  p_content_type text,
  p_category_id uuid,
  p_tags text[],
  p_media_path text,
  p_thumb_path text,
  p_duration_sec int,
  p_prompt_text text,
  p_is_published boolean,
  p_media_bytes bigint default null,
  p_publish_at timestamptz default null,
  p_source_name text default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  saved_id uuid := p_id;
  blank boolean := length(trim(coalesce(p_prompt_text, ''))) = 0;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if p_is_published and p_media_path is null then
    raise exception 'media_missing' using errcode = 'P0001';
  end if;
  if blank and p_is_published then
    raise exception 'prompt_missing' using errcode = 'P0001';
  end if;

  if p_id is null then
    insert into public.videos (
      title, content_type, category_id, tags, media_path, thumb_path,
      duration_sec, is_published, media_bytes, publish_at, source_name
    ) values (
      p_title, p_content_type, p_category_id, coalesce(p_tags, '{}'),
      p_media_path, p_thumb_path, p_duration_sec, p_is_published, p_media_bytes,
      p_publish_at, p_source_name
    ) returning id into saved_id;
  end if;

  if blank then
    delete from public.prompts where video_id = saved_id;
  else
    insert into public.prompts (video_id, prompt_text)
      values (saved_id, p_prompt_text)
      on conflict (video_id)
      do update set prompt_text = excluded.prompt_text;
  end if;

  if p_id is not null then
    update public.videos set
      title = p_title,
      content_type = p_content_type,
      category_id = p_category_id,
      tags = coalesce(p_tags, '{}'),
      media_path = p_media_path,
      thumb_path = p_thumb_path,
      duration_sec = p_duration_sec,
      is_published = p_is_published,
      publish_at = p_publish_at,
      -- Null means the file was not replaced.
      media_bytes = coalesce(p_media_bytes, media_bytes),
      source_name = coalesce(p_source_name, source_name)
    where id = p_id;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;

  return saved_id;
end;
$$;

-- Items whose original file name is one of these, newest first, so an import can
-- update them instead of making copies.
create function public.match_source_names(p_names text[])
returns table (
  source_name text,
  id uuid,
  title text,
  has_media boolean,
  has_prompt boolean,
  is_published boolean
)
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_names), 0) > 1000 then
    raise exception 'too_many_names' using errcode = '22023';
  end if;
  return query
    select v.source_name, v.id, v.title, v.media_path is not null,
      exists (select 1 from public.prompts p where p.video_id = v.id),
      v.is_published
    from public.videos v
    where lower(v.source_name) in (select lower(n) from unnest(p_names) n)
    order by v.created_at desc;
end;
$$;

-- Saves up to 200 rows from a sheet import or a bulk upload. Each row succeeds or
-- fails on its own, so one bad line does not lose the rest; the result has one
-- entry per row, {"id": ...} or {"error": ...}.
--
-- A row with "id" updates that item and changes only the keys it carries. A row
-- without one creates a hidden item. "publish": true also puts it live, which
-- needs a file and a prompt.
create function public.import_items(p_items jsonb)
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
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) > 200 then
    raise exception 'send_up_to_200_rows' using errcode = '22023';
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
          duration_sec, media_bytes, source_name, is_published
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
          publish
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
          is_published = v.is_published or publish,
          publish_at = case when publish then null else v.publish_at end
        where v.id = saved_id;
        if not found then
          raise exception 'not_found';
        end if;
      end if;
      results := results || jsonb_build_array(jsonb_build_object('id', saved_id));
    exception when others then
      results := results || jsonb_build_array(jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  return results;
end;
$$;

revoke all on function public.save_video(
  uuid, text, text, uuid, text[], text, text, int, text, boolean, bigint,
  timestamptz, text
) from public;
revoke all on function public.match_source_names(text[]) from public;
revoke all on function public.import_items(jsonb) from public;
grant execute on function public.save_video(
  uuid, text, text, uuid, text[], text, text, int, text, boolean, bigint,
  timestamptz, text
) to authenticated;
grant execute on function public.match_source_names(text[]) to authenticated;
grant execute on function public.import_items(jsonb) to authenticated;

-- --------------------------------------------------------------- overview

create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'total', count(*),
    'live', count(*) filter (where public.is_live(is_published, publish_at)),
    'scheduled', count(*) filter (where is_published and publish_at > now()),
    'hidden', count(*) filter (where not is_published),
    'videos', count(*) filter (where content_type = 'video'),
    'images', count(*) filter (where content_type = 'image'),
    'no_thumb', count(*) filter (where thumb_path is null and media_path is not null),
    'no_media', count(*) filter (where media_path is null),
    'no_category', count(*) filter (where category_id is null),
    'no_views', count(*) filter (
      where public.is_live(is_published, publish_at) and view_count = 0
    ),
    'no_prompt', count(*) filter (
      where not exists (select 1 from public.prompts p where p.video_id = videos.id)
    ),
    'total_views', coalesce(sum(view_count), 0),
    'total_generates', coalesce(sum(generate_count), 0),
    'total_copies', coalesce(sum(copy_count), 0),
    'media_bytes', coalesce(sum(media_bytes), 0)
  ) into result
  from public.videos;

  result := result || jsonb_build_object(
    'open_reports', (
      select count(*) from public.content_reports where status = 'open'
    ),
    'views_7d', (
      select coalesce(sum(views), 0) from public.video_daily_views
      where day > current_date - 7
    ),
    'views_prev_7d', (
      select coalesce(sum(views), 0) from public.video_daily_views
      where day > current_date - 14 and day <= current_date - 7
    ),
    'daily', (
      select jsonb_agg(
        jsonb_build_object('day', d.day, 'views', coalesce(s.views, 0))
        order by d.day
      )
      from (
        select (current_date - n)::date as day from generate_series(0, 13) n
      ) d
      left join (
        select day, sum(views) as views from public.video_daily_views
        where day > current_date - 14 group by day
      ) s on s.day = d.day
    ),
    'top', coalesce((
      select jsonb_agg(to_jsonb(t))
      from (
        select v.id, v.title, v.content_type, v.thumb_path, v.view_count,
          coalesce(w.views, 0) as week_views
        from public.videos v
        left join lateral (
          select sum(d.views) as views from public.video_daily_views d
          where d.video_id = v.id and d.day > current_date - 7
        ) w on true
        where public.is_live(v.is_published, v.publish_at)
        order by week_views desc, v.view_count desc
        limit 5
      ) t
    ), '[]'::jsonb),
    'top_prompts', coalesce((
      select jsonb_agg(to_jsonb(t))
      from (
        select id, title, content_type, thumb_path, generate_count, copy_count
        from public.videos
        where generate_count > 0 or copy_count > 0
        order by generate_count desc, copy_count desc
        limit 5
      ) t
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(to_jsonb(r))
      from (
        select id, title, content_type, thumb_path, is_published, publish_at, created_at
        from public.videos
        order by created_at desc
        limit 5
      ) r
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.views desc, c.name)
      from (
        select cat.name, count(v.id) as items,
          coalesce(sum(v.view_count), 0) as views
        from public.categories cat
        left join public.videos v on v.category_id = cat.id
        group by cat.name
      ) c
    ), '[]'::jsonb)
  );

  return result;
end;
$$;
