-- Demo data reset for scripts/demo/reset.ts. It removes only campaigns the demo seed marked with is_demo, and
-- only profiles created by wallet sign-in. The chain is untouched. Audit access logs stay append only for
-- every other campaign.

alter table public.campaigns add column is_demo boolean not null default false;

-- Deletes from the access log are allowed only inside reset_demo_data, and only for demo campaigns.
create function public.guard_audit_access_log_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('treecord.demo_reset', true) = 'on' and exists (
    select 1
    from public.audit_sessions s
    join public.campaigns c on c.address = s.campaign_address
    where s.id = old.session_id and c.is_demo
  ) then
    return old;
  end if;
  raise exception '% is append only', tg_table_name using errcode = 'insufficient_privilege';
end;
$$;

drop trigger audit_access_log_append_only on public.audit_access_log;
create trigger audit_access_log_no_update before update on public.audit_access_log
  for each row execute function public.reject_mutation();
create trigger audit_access_log_guard_delete before delete on public.audit_access_log
  for each row execute function public.guard_audit_access_log_delete();

-- Removes the mirror and private rows of demo campaigns and demo profiles. Returns counts and the storage
-- paths of deleted submissions so the caller can remove the files. A profile that other rows still need
-- (for example an audit of a non-demo campaign) is kept and listed in keptProfiles.
create function public.reset_demo_data(p_campaigns text[], p_profile_ids uuid[])
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_campaigns text[];
  v_profiles uuid[];
  v_submissions uuid[];
  v_videos text[];
  v_keyframes text[];
  v_deleted_profiles integer := 0;
  v_kept uuid[] := '{}';
  v_profile uuid;
begin
  select coalesce(array_agg(address::text), '{}') into v_campaigns
  from public.campaigns
  where address::text = any (p_campaigns) and is_demo;

  select coalesce(array_agg(id), '{}') into v_profiles
  from public.profiles
  where id = any (p_profile_ids) and privy_user_id like 'wallet:%';

  perform set_config('treecord.demo_reset', 'on', true);

  delete from public.audit_access_log
  where session_id in (select id from public.audit_sessions where campaign_address::text = any (v_campaigns));
  delete from public.challenges
  where tree_id in (select tree_id from public.trees where campaign_address::text = any (v_campaigns))
     or issued_by_profile_id = any (v_profiles);
  delete from public.audit_sessions where campaign_address::text = any (v_campaigns);

  delete from public.retirements
  where batch_id in (select batch_id from public.carbon_batches where campaign_address::text = any (v_campaigns));
  delete from public.carbon_batches where campaign_address::text = any (v_campaigns);

  select
    coalesce(array_agg(id), '{}'),
    coalesce(array_agg(video_path) filter (where video_path is not null), '{}')
  into v_submissions, v_videos
  from public.submissions
  where campaign_address::text = any (v_campaigns) or profile_id = any (v_profiles);

  select coalesce(array_agg(path), '{}') into v_keyframes
  from public.submissions s, unnest(s.keyframe_paths) as path
  where s.id = any (v_submissions);

  delete from public.submissions where id = any (v_submissions);
  delete from public.relayer_jobs
  where payload ->> 'submissionId' = any (v_submissions::text[])
     or payload ->> 'campaign' = any (v_campaigns)
     or created_by_profile_id = any (v_profiles);

  -- Cascades to contributions, refunds, slots, trees, tree events, payouts, forfeits, flags and reservations.
  delete from public.campaigns where address::text = any (v_campaigns);

  foreach v_profile in array v_profiles loop
    begin
      delete from public.profiles where id = v_profile;
      v_deleted_profiles := v_deleted_profiles + 1;
    exception when foreign_key_violation then
      v_kept := v_kept || v_profile;
    end;
  end loop;

  return jsonb_build_object(
    'campaigns', cardinality(v_campaigns),
    'profiles', v_deleted_profiles,
    'keptProfiles', to_jsonb(v_kept),
    'submissions', cardinality(v_submissions),
    'evidencePaths', to_jsonb(v_videos),
    'keyframePaths', to_jsonb(v_keyframes)
  );
end;
$$;

revoke execute on function public.guard_audit_access_log_delete() from public, anon, authenticated;
revoke execute on function public.reset_demo_data(text[], uuid[]) from public, anon, authenticated;
grant execute on function public.reset_demo_data(text[], uuid[]) to service_role;
