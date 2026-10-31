-- Controls added for the admin portal: ad switches and unit IDs, app settings,
-- the launch checklist, and the numbers behind the Overview page.

update public.app_config
set value = '{
    "ads_enabled": true,
    "use_test_ads": true,
    "banner_enabled": true,
    "native_enabled": true,
    "interstitial_enabled": true,
    "app_open_enabled": true,
    "generate_prompt_ad_enabled": true,
    "category_tap_ad_enabled": true,
    "back_to_list_ad_enabled": true,
    "banner_unit_id": "",
    "native_unit_id": "",
    "interstitial_unit_id": "",
    "app_open_unit_id": ""
  }'::jsonb || value
where key = 'ads';

insert into public.app_config (key, value) values
  ('app', '{
    "maintenance_mode": false,
    "maintenance_message": "We are making Prompt Lab better. Please check back soon.",
    "min_supported_version": "",
    "latest_version": "",
    "store_url": "",
    "privacy_url": "",
    "terms_url": "",
    "support_email": ""
  }'),
  ('launch_checklist', '{}');

-- The checklist is an internal note; the app has no reason to read it.
drop policy "public reads config" on public.app_config;
create policy "public reads config" on public.app_config
  for select using (key <> 'launch_checklist');

create function public.admin_overview()
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
    'total_views', coalesce(sum(view_count), 0)
  ) into result
  from public.videos;

  result := result || jsonb_build_object(
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

revoke all on function public.admin_overview() from public;
grant execute on function public.admin_overview() to authenticated;
