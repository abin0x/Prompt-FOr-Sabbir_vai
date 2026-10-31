-- Pinned items, storage use, user reports, an activity log, an announcement, and
-- ad settings changed to follow Google's ad rules.

-- ------------------------------------------------------------ ad settings

-- Google Play lists "after a user has clicked on a button, and before the action
-- intended by the button click has taken effect" as a violation, so full-screen
-- ads on Generate Prompt and category taps are gone. Prompts can use a rewarded
-- ad instead, which the user chooses to watch.
update public.app_config
set value = (value
    - 'generate_prompt_ad_enabled' - 'generate_prompt_every_n'
    - 'category_tap_ad_enabled' - 'category_tap_every_n')
  || '{"rewarded_enabled": true, "rewarded_unit_id": ""}'::jsonb
where key = 'ads';

update public.app_config
set value = value || '{"announcement_enabled": false, "announcement_text": ""}'::jsonb
where key = 'app';

-- ---------------------------------------------------------------- columns

alter table public.videos
  add column is_featured boolean not null default false,
  add column media_bytes bigint check (media_bytes is null or media_bytes >= 0);

drop function public.save_video(
  uuid, text, text, uuid, text[], text, text, int, text, boolean
);

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
  p_media_bytes bigint default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  saved_id uuid := p_id;
begin
  if not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  if p_id is null then
    insert into public.videos (
      title, content_type, category_id, tags, media_path, thumb_path,
      duration_sec, is_published, media_bytes
    ) values (
      p_title, p_content_type, p_category_id, coalesce(p_tags, '{}'),
      p_media_path, p_thumb_path, p_duration_sec, p_is_published, p_media_bytes
    ) returning id into saved_id;
  else
    update public.videos set
      title = p_title,
      content_type = p_content_type,
      category_id = p_category_id,
      tags = coalesce(p_tags, '{}'),
      media_path = p_media_path,
      thumb_path = p_thumb_path,
      duration_sec = p_duration_sec,
      is_published = p_is_published,
      -- Null means the file was not replaced.
      media_bytes = coalesce(p_media_bytes, media_bytes)
    where id = p_id;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;

  insert into public.prompts (video_id, prompt_text)
    values (saved_id, p_prompt_text)
    on conflict (video_id)
    do update set prompt_text = excluded.prompt_text;

  return saved_id;
end;
$$;

revoke all on function public.save_video(
  uuid, text, text, uuid, text[], text, text, int, text, boolean, bigint
) from public;
grant execute on function public.save_video(
  uuid, text, text, uuid, text[], text, text, int, text, boolean, bigint
) to authenticated;

-- ---------------------------------------------------------- user reports

create table public.content_reports (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  reason text not null check (
    reason in ('sexual', 'violence', 'child_safety', 'copyright', 'other')
  ),
  note text check (note is null or length(note) <= 300),
  ip_hash text,
  day date not null default current_date,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now()
);
-- One report per person, per item, per day.
create unique index content_reports_once_idx
  on public.content_reports (video_id, ip_hash, day);
create index content_reports_status_idx
  on public.content_reports (status, created_at desc);

alter table public.content_reports enable row level security;
revoke all on public.content_reports from anon;
create policy "admins manage reports" on public.content_reports
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- How the app sends a report. Users do not sign in, so this is open to everyone,
-- but only for live items and only once a day per IP address.
create function public.report_content(vid uuid, p_reason text, p_note text default null)
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
    select 1 from public.videos where id = vid and is_published
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

revoke all on function public.report_content(uuid, text, text) from public;
grant execute on function public.report_content(uuid, text, text)
  to anon, authenticated;

-- ---------------------------------------------------------- activity log

create table public.admin_activity (
  id bigint generated always as identity primary key,
  actor_email text,
  action text not null,
  target_type text not null,
  target_label text,
  created_at timestamptz not null default now()
);
create index admin_activity_time_idx on public.admin_activity (created_at desc);

alter table public.admin_activity enable row level security;
revoke all on public.admin_activity from anon;
create policy "admins read activity" on public.admin_activity
  for select to authenticated using (public.is_admin());

create function public.log_admin_activity()
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

revoke all on function public.log_admin_activity() from public;

create trigger videos_activity after insert or update or delete on public.videos
  for each row execute function public.log_admin_activity();
create trigger categories_activity after insert or update or delete on public.categories
  for each row execute function public.log_admin_activity();
create trigger app_config_activity after insert or update on public.app_config
  for each row execute function public.log_admin_activity();

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
    'live', count(*) filter (where is_published),
    'hidden', count(*) filter (where not is_published),
    'videos', count(*) filter (where content_type = 'video'),
    'images', count(*) filter (where content_type = 'image'),
    'no_thumb', count(*) filter (where thumb_path is null),
    'no_category', count(*) filter (where category_id is null),
    'no_views', count(*) filter (where is_published and view_count = 0),
    'total_views', coalesce(sum(view_count), 0),
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
        where v.is_published
        order by week_views desc, v.view_count desc
        limit 5
      ) t
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(to_jsonb(r))
      from (
        select id, title, content_type, thumb_path, is_published, created_at
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
