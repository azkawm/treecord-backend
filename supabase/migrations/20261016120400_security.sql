-- Row level security, public views, function privileges, and storage buckets.
--
-- Model: the API and worker use the service role, which bypasses RLS. Client roles (anon, authenticated)
-- get no table access at all. Public, non-sensitive data is exposed only through the v_public_* views,
-- which run with their owner's rights and select only safe columns.

-- ---------------------------------------------------------------------------
-- RLS on every table, no client policies
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.species enable row level security;
alter table public.campaign_metadata enable row level security;
alter table public.campaigns enable row level security;
alter table public.contributions enable row level security;
alter table public.refunds enable row level security;
alter table public.slots enable row level security;
alter table public.trees enable row level security;
alter table public.tree_events enable row level security;
alter table public.submissions enable row level security;
alter table public.milestone_payouts enable row level security;
alter table public.milestone_forfeits enable row level security;
alter table public.flags enable row level security;
alter table public.carbon_reservations enable row level security;
alter table public.carbon_batches enable row level security;
alter table public.carbon_allocations enable row level security;
alter table public.carbon_purchases enable row level security;
alter table public.carbon_balances enable row level security;
alter table public.retirements enable row level security;
alter table public.audit_sessions enable row level security;
alter table public.audit_samples enable row level security;
alter table public.audit_access_log enable row level security;
alter table public.challenges enable row level security;
alter table public.chain_cursor enable row level security;
alter table public.relayer_jobs enable row level security;

-- Belt and braces: remove the default Data API grants from client roles as well.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Functions: nothing callable by clients. The worker calls claim_relayer_jobs with the service role.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.claim_relayer_jobs(public.relayer_job_kind[], integer, text, interval) to service_role;

-- ---------------------------------------------------------------------------
-- Public views (safe columns only)
-- ---------------------------------------------------------------------------

create view public.v_public_campaigns as
select
  address,
  chain_id,
  creator_address,
  status,
  title,
  description,
  species_code,
  species_name,
  region_name,
  region_center_lat,
  region_center_lon,
  region_radius_m,
  region_geohash,
  tree_target,
  anchor_slots,
  open_slots,
  per_planter_cap,
  funding_target::text as funding_target,
  funded_amount::text as funded_amount,
  funding_deadline,
  claim_deadline,
  commitment_units,
  time_unit_seconds,
  split,
  per_tree_incentive::text as per_tree_incentive,
  activated_at,
  completed_at,
  -- Always labeled pre-certification in the UI.
  estimated_amount::text as estimated_amount,
  metadata_uri,
  created_at
from public.campaigns;

-- Trees without exact GPS. Only the precision-7 geohash is public.
create view public.v_public_trees as
select
  tree_id,
  campaign_address,
  slot_id,
  planter_address,
  status,
  planted_at,
  geohash,
  replant_deadline,
  paused_seconds,
  latest_evidence_hash,
  check_in_count,
  planted_tx
from public.trees;

create view public.v_public_payouts as
select
  tree_id,
  campaign_address,
  milestone,
  planter_address,
  amount::text as amount,
  block_number,
  block_time,
  tx_hash
from public.milestone_payouts;

grant select on public.v_public_campaigns, public.v_public_trees, public.v_public_payouts to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage buckets (private; the API issues signed URLs)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- Path convention: evidence/{profile_id}/{submission_id}.mp4
  ('evidence', 'evidence', false, 26214400, array['video/mp4', 'video/webm', 'video/quicktime']),
  -- Path convention: keyframes/{submission_id}/{index}.jpg
  ('keyframes', 'keyframes', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
