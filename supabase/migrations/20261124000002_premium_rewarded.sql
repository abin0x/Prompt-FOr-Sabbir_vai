-- Premium items open for a while after the user watches a rewarded ad. The unit
-- ID is filled in from the Dashboard (Ad controls). Values already set win over
-- these defaults, so nothing saved before is lost.
update public.app_config
set value = '{
    "rewarded_unit_id": "",
    "premium_unlock_minutes": 60
  }'::jsonb || value
where key = 'ads';
