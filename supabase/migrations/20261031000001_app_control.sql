-- Puts the app under the Dashboard's control: ad placements as the app really
-- uses them, scheduled publishing, drafts with no prompt yet, prompt stats, and
-- text and links that change without an app update.

-- ------------------------------------------------------------ settings

-- Existing values win over these defaults, so nothing already set is lost.
update public.app_config
set value = '{
    "generate_prompt_ad_enabled": true,
    "generate_prompt_every_n": 1,
    "category_tap_ad_enabled": true,
    "category_tap_every_n": 1,
    "saved_tab_ad_enabled": true,
    "saved_tab_every_n": 1,
    "detail_native_ad_enabled": true,
    "native_first_after_cards": 4
  }'::jsonb || (value - 'rewarded_enabled' - 'rewarded_unit_id')
where key = 'ads';

update public.app_config
set value = '{
    "media_base_url": "",
    "announcement_url": "",
    "home_subtitle": "",
    "default_home_view": "all",
    "onboarding": [
      {"title": "", "body": ""},
      {"title": "", "body": ""},
      {"title": "", "body": ""}
    ]
  }'::jsonb || value
where key = 'app';

-- ---------------------------------------------------------------- columns

alter table public.videos
  add column publish_at timestamptz,
  add column generate_count bigint not null default 0 check (generate_count >= 0),
  add column copy_count bigint not null default 0 check (copy_count >= 0);

-- ------------------------------------------------- what counts as live

-- Published, and any scheduled time has passed. No job runs at that moment: the
-- rule below is checked on every read, so an item simply starts appearing.
create function public.is_live(published boolean, publish_time timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select published and (publish_time is null or publish_time <= now());
$$;

drop policy "public reads published videos" on public.videos;
create policy "public reads live videos" on public.videos
  for select using (public.is_live(is_published, publish_at));

-- An item with no prompt would show Generate Prompt with nothing behind it.
create function public.require_prompt_to_publish()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_published and not old.is_published and not exists (
    select 1 from public.prompts where video_id = new.id
  ) then
    raise exception 'prompt_missing' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.require_prompt_to_publish() from public;

create trigger videos_require_prompt before update on public.videos
  for each row execute function public.require_prompt_to_publish();

-- ------------------------------------------------------- public functions

-- Same as before, for live items only, and it counts each prompt handed out.
create or replace function public.get_prompt(vid uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  headers json := nullif(current_setting('request.headers', true), '')::json;
  ip text := coalesce(
    headers ->> 'cf-connecting-ip',
    split_part(headers ->> 'x-forwarded-for', ',', 1)
  );
  per_minute int := coalesce(
    (select (value ->> 'prompt_per_minute_per_ip')::int
     from public.app_config where key = 'limits'),
    300
  );
  bucket timestamptz := date_trunc('minute', now());
  ip_key text;
  used int;
  result text;
begin
  if coalesce(ip, '') <> '' then
    ip_key := encode(extensions.digest(ip, 'sha256'), 'hex');
    insert into public.prompt_rate_limits (ip_hash, window_start, hits)
      values (ip_key, bucket, 1)
      on conflict (ip_hash, window_start)
      do update set hits = public.prompt_rate_limits.hits + 1
      returning hits into used;
    if used > per_minute then
      raise exception 'rate_limited' using errcode = 'P0001';
    end if;
    -- Old windows are useless; clear them now and then instead of on a schedule.
    if random() < 0.01 then
      delete from public.prompt_rate_limits
        where window_start < now() - interval '1 hour';
    end if;
  end if;

  select p.prompt_text into result
  from public.prompts p
  join public.videos v on v.id = p.video_id
  where p.video_id = vid and public.is_live(v.is_published, v.publish_at);

  if result is not null then
    update public.videos set generate_count = generate_count + 1 where id = vid;
  end if;
  return result;
end;
$$;

create function public.record_copy(vid uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.videos set copy_count = copy_count + 1
  where id = vid and public.is_live(is_published, publish_at);
$$;

revoke all on function public.record_copy(uuid) from public;
grant execute on function public.record_copy(uuid) to anon, authenticated;

create or replace function public.record_views(vids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ids uuid[];
begin
  if coalesce(cardinality(vids), 0) = 0 or cardinality(vids) > 50 then
    return;
  end if;
  select array_agg(v.id) into ids
    from public.videos v
    where public.is_live(v.is_published, v.publish_at) and v.id = any (vids);
  if ids is null then
    return;
  end if;

  update public.videos v
    set view_count = v.view_count + c.n
    from (select x as id, count(*) as n from unnest(vids) x group by x) c
    where v.id = c.id and v.id = any (ids);

  insert into public.video_daily_views (video_id, views)
    select c.id, c.n
    from (select x as id, count(*) as n from unnest(vids) x group by x) c
    where c.id = any (ids)
    on conflict (video_id, day)
    do update set views =
      public.video_daily_views.views + excluded.views;
end;
$$;

create or replace function public.get_trending(
  p_type text default 'video',
  p_limit int default 20,
  p_offset int default 0
)
returns table (
  id uuid,
  title text,
  content_type text,
  category_name text,
  tags text[],
  media_path text,
  thumb_path text,
  duration_sec int,
  view_count bigint,
  week_views bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.title, v.content_type, c.name, v.tags, v.media_path,
    v.thumb_path, v.duration_sec, v.view_count,
    coalesce(w.views, 0)::bigint as week_views, v.created_at
  from public.videos v
  left join public.categories c on c.id = v.category_id
  left join lateral (
    select sum(d.views) as views
    from public.video_daily_views d
    where d.video_id = v.id and d.day > current_date - 7
  ) w on true
  where public.is_live(v.is_published, v.publish_at) and v.content_type = p_type
  order by week_views desc, v.view_count desc, v.created_at desc
  limit least(greatest(p_limit, 1), 50)
  offset greatest(p_offset, 0);
$$;

create or replace function public.report_content(vid uuid, p_reason text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  headers json := nullif(current_setting('request.headers', true), '')::json;
  ip text := coalesce(
    headers ->> 'cf-connecting-ip',
    split_part(headers ->> 'x-forwarded-for', ',', 1)
  );
begin
  if not exists (
    select 1 from public.videos
    where id = vid and public.is_live(is_published, publish_at)
  ) then
    return;
  end if;
  insert into public.content_reports (video_id, reason, note, ip_hash)
    values (
      vid,
      p_reason,
      left(nullif(trim(p_note), ''), 300),
      case when coalesce(ip, '') = '' then null
        else encode(extensions.digest(ip, 'sha256'), 'hex') end
    )
    on conflict (video_id, ip_hash, day) do nothing;
end;
$$;

-- -------------------------------------------------------- admin functions

drop function public.save_video(
  uuid, text, text, uuid, text[], text, text, int, text, boolean, bigint
);

-- A blank prompt is allowed only while the item is hidden, which is how bulk
-- uploads wait for their prompts. The prompt is written first, so publishing a
-- draft and adding its prompt can happen in one save.
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
  p_publish_at timestamptz default null
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
  if blank and p_is_published then
    raise exception 'prompt_missing' using errcode = 'P0001';
  end if;

  if p_id is null then
    insert into public.videos (
      title, content_type, category_id, tags, media_path, thumb_path,
      duration_sec, is_published, media_bytes, publish_at
    ) values (
      p_title, p_content_type, p_category_id, coalesce(p_tags, '{}'),
      p_media_path, p_thumb_path, p_duration_sec, p_is_published, p_media_bytes,
      p_publish_at
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
      media_bytes = coalesce(p_media_bytes, media_bytes)
    where id = p_id;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;

  return saved_id;
end;
$$;

revoke all on function public.save_video(
  uuid, text, text, uuid, text[], text, text, int, text, boolean, bigint, timestamptz
) from public;
grant execute on function public.save_video(
  uuid, text, text, uuid, text[], text, text, int, text, boolean, bigint, timestamptz
) to authenticated;

-- ---------------------------------------------------------- activity log

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
  -- View counts and other non-admin changes are not admin activity.
  if auth.uid() is null or not public.is_admin() then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'videos' then
    label := coalesce(new.title, old.title);
    if tg_op <> 'DELETE' and new.is_published and new.publish_at > now() and (
      tg_op = 'INSERT' or new.publish_at is distinct from old.publish_at
        or not old.is_published
    ) then
      verb := 'scheduled';
    elsif tg_op = 'UPDATE' and new.is_published is distinct from old.is_published then
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
    'no_thumb', count(*) filter (where thumb_path is null),
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
