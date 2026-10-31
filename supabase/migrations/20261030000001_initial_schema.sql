-- Prompt Lab backend schema.
--
-- App users never sign in, so they use the anon role. Only people listed in
-- `admins` can change anything. Media files live in Cloudflare R2; these tables
-- hold their paths and the text.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 1 and 40),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 120),
  content_type text not null default 'video'
    check (content_type in ('video', 'image')),
  category_id uuid references public.categories (id) on delete set null,
  tags text[] not null default '{}',
  -- The R2 key of the video file, or of the full image.
  media_path text not null,
  thumb_path text,
  duration_sec int check (duration_sec is null or duration_sec >= 0),
  -- New rows stay hidden until the prompt is saved with them.
  is_published boolean not null default false,
  view_count bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index videos_feed_idx
  on public.videos (content_type, created_at desc) where is_published;
create index videos_category_idx on public.videos (category_id);

-- Prompts are separate so the public feed can never expose them.
create table public.prompts (
  video_id uuid primary key references public.videos (id) on delete cascade,
  prompt_text text not null check (length(trim(prompt_text)) > 0),
  updated_at timestamptz not null default now()
);

-- One row per video per day, so "this week" can be computed.
create table public.video_daily_views (
  video_id uuid not null references public.videos (id) on delete cascade,
  day date not null default current_date,
  views bigint not null default 0,
  primary key (video_id, day)
);
create index video_daily_views_day_idx on public.video_daily_views (day);

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- Settings the app reads, so they can change without an app update.
create table public.app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.prompt_rate_limits (
  ip_hash text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (ip_hash, window_start)
);

-- --------------------------------------------------------- admin check

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- --------------------------------------------------------------- policies

alter table public.categories enable row level security;
alter table public.videos enable row level security;
alter table public.prompts enable row level security;
alter table public.video_daily_views enable row level security;
alter table public.admins enable row level security;
alter table public.app_config enable row level security;
alter table public.prompt_rate_limits enable row level security;

create policy "public reads active categories" on public.categories
  for select using (is_active);
create policy "admins manage categories" on public.categories
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "public reads published videos" on public.videos
  for select using (is_published);
create policy "admins manage videos" on public.videos
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Deliberately no public read: prompts leave only through get_prompt.
create policy "admins manage prompts" on public.prompts
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "admins read daily views" on public.video_daily_views
  for select to authenticated using (public.is_admin());

create policy "admins read own row" on public.admins
  for select to authenticated using (user_id = auth.uid());

create policy "public reads config" on public.app_config
  for select using (true);
create policy "admins manage config" on public.app_config
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- prompt_rate_limits has no policies: only the functions below touch it.

-- Defense in depth on top of RLS: the anon role cannot even name these.
revoke all on public.prompts, public.admins, public.video_daily_views,
  public.prompt_rate_limits from anon;
revoke all on public.prompt_rate_limits from authenticated;

-- -------------------------------------------------------------- triggers

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger videos_touch before update on public.videos
  for each row execute function public.touch_updated_at();
create trigger prompts_touch before update on public.prompts
  for each row execute function public.touch_updated_at();
create trigger app_config_touch before update on public.app_config
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------- public functions

-- The only way the app gets a prompt. Rate limited per IP. This cannot prove an
-- ad was watched (interstitials give no server-side proof), so it only makes
-- copying the whole catalog slow. The limit is high because many mobile users
-- can share one carrier IP.
create function public.get_prompt(vid uuid)
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
  where p.video_id = vid and v.is_published;
  return result;
end;
$$;

-- The app sends views in batches to save requests.
create function public.record_views(vids uuid[])
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
    where v.is_published and v.id = any (vids);
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

-- The Trending page: most viewed in the last 7 days, all-time views as the
-- tiebreak so a new catalog with no recent views still has an order.
create function public.get_trending(
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
  where v.is_published and v.content_type = p_type
  order by week_views desc, v.view_count desc, v.created_at desc
  limit least(greatest(p_limit, 1), 50)
  offset greatest(p_offset, 0);
$$;

-- -------------------------------------------------------- admin functions

-- Saves a video and its prompt together, so a failure can never leave a
-- published video with no prompt. Pass p_id to update an existing one.
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
  p_is_published boolean
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
      duration_sec, is_published
    ) values (
      p_title, p_content_type, p_category_id, coalesce(p_tags, '{}'),
      p_media_path, p_thumb_path, p_duration_sec, p_is_published
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
      is_published = p_is_published
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

-- --------------------------------------------------------- function access

revoke all on function public.is_admin() from public;
revoke all on function public.get_prompt(uuid) from public;
revoke all on function public.record_views(uuid[]) from public;
revoke all on function public.get_trending(text, int, int) from public;
revoke all on function public.save_video(
  uuid, text, text, uuid, text[], text, text, int, text, boolean
) from public;
revoke all on function public.touch_updated_at() from public;

grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.get_prompt(uuid) to anon, authenticated;
grant execute on function public.record_views(uuid[]) to anon, authenticated;
grant execute on function public.get_trending(text, int, int)
  to anon, authenticated;
grant execute on function public.save_video(
  uuid, text, text, uuid, text[], text, text, int, text, boolean
) to authenticated;

-- ---------------------------------------------------------- starting data

insert into public.categories (name, sort_order) values
  ('Laugh', 10),
  ('Cinematic', 20),
  ('Fashion', 30),
  ('Dance', 40),
  ('Formal', 50),
  ('Baby', 60);

insert into public.app_config (key, value) values
  ('ads', '{
    "generate_prompt_every_n": 1,
    "category_tap_every_n": 1,
    "back_to_list_every_n": 3,
    "interstitial_min_gap_sec": 90,
    "interstitial_max_per_session": 4,
    "app_open_min_gap_hours": 4,
    "native_every_n_cards": 6,
    "grace_period_sec": 60
  }'),
  ('limits', '{"prompt_per_minute_per_ip": 300}');
