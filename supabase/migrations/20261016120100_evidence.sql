-- Evidence submissions, milestone payouts and forfeits, flags.

create type public.evidence_kind as enum ('PLANTED', 'ALIVE', 'DEAD', 'REPLANTED');
create type public.submission_status as enum (
  'queued', 'uploaded', 'checking', 'scored', 'passed', 'rejected', 'needs_review', 'attested', 'onchain', 'failed'
);
create type public.policy_decision as enum ('pass', 'reject', 'needs_review');
create type public.flag_status as enum ('pending', 'open', 'upheld', 'dismissed');

-- ---------------------------------------------------------------------------
-- Submissions
-- ---------------------------------------------------------------------------

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete restrict,
  device_id uuid references public.devices (id) on delete set null,
  campaign_address public.eth_address not null references public.campaigns (address) on delete restrict,
  slot_id integer,
  tree_id bigint references public.trees (tree_id) on delete restrict,
  kind public.evidence_kind not null,
  milestone smallint not null check (milestone between 0 and 5),
  -- Storage path inside the private "evidence" bucket: {profile_id}/{submission_id}.mp4
  video_path text,
  video_sha256 text not null unique check (video_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer check (size_bytes > 0 and size_bytes <= 26214400),
  duration_sec numeric(6, 2) check (duration_sec > 0),
  -- The signed payload, the exact canonical string, and the base64url P1363 signature.
  payload jsonb,
  canonical text,
  signature text,
  evidence_hash public.hex32,
  captured_at timestamptz,
  received_at timestamptz not null default now(),
  status public.submission_status not null default 'queued',
  reject_reasons text[] not null default '{}',
  ai_response jsonb,
  -- Paths inside the private "keyframes" bucket, copied from the AI response.
  keyframe_paths text[] not null default '{}',
  policy_decision public.policy_decision,
  policy_score integer check (policy_score between 0 and 10000),
  attestation jsonb,
  -- uint256. Read with a ::text cast.
  attestation_nonce public.uint256 unique,
  challenge_id uuid,
  tx_hash public.hex32,
  error text,
  reviewed_by_profile_id uuid references public.profiles (id) on delete set null,
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint planted_shape check (
    (kind = 'PLANTED' and slot_id is not null and tree_id is null and milestone = 0)
    or (kind <> 'PLANTED' and tree_id is not null and slot_id is null)
  ),
  constraint alive_milestone check (kind <> 'ALIVE' or milestone between 1 and 5)
);

-- One accepted submission per tree per milestone (ALIVE check-ins).
-- DEAD and REPLANTED are excluded on purpose: a tree can die, be replanted, and die again.
create unique index submissions_one_per_milestone_idx on public.submissions (tree_id, milestone)
  where kind = 'ALIVE' and status in ('passed', 'attested', 'onchain');

-- One accepted planting per slot.
create unique index submissions_one_planting_per_slot_idx on public.submissions (campaign_address, slot_id)
  where kind = 'PLANTED' and status in ('passed', 'attested', 'onchain');

create index submissions_profile_idx on public.submissions (profile_id, created_at desc);
create index submissions_tree_idx on public.submissions (tree_id);
create index submissions_status_idx on public.submissions (status);
create index submissions_evidence_hash_idx on public.submissions (evidence_hash);

create trigger submissions_updated_at before update on public.submissions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Milestone payouts and forfeits (mirrors of Campaign events)
-- ---------------------------------------------------------------------------

create table public.milestone_payouts (
  id uuid primary key default gen_random_uuid(),
  campaign_address public.eth_address not null references public.campaigns (address) on delete cascade,
  tree_id bigint not null references public.trees (tree_id) on delete cascade,
  milestone smallint not null check (milestone between 0 and 5),
  planter_address public.eth_address not null,
  amount public.uint256 not null,
  block_number bigint not null,
  block_time timestamptz not null,
  tx_hash public.hex32 not null,
  log_index integer not null,
  unique (tx_hash, log_index),
  unique (tree_id, milestone)
);

create index milestone_payouts_campaign_idx on public.milestone_payouts (campaign_address);
create index milestone_payouts_planter_idx on public.milestone_payouts (planter_address);

create table public.milestone_forfeits (
  id uuid primary key default gen_random_uuid(),
  campaign_address public.eth_address not null references public.campaigns (address) on delete cascade,
  tree_id bigint not null references public.trees (tree_id) on delete cascade,
  milestone smallint not null check (milestone between 0 and 5),
  amount public.uint256 not null,
  block_number bigint not null,
  block_time timestamptz not null,
  tx_hash public.hex32 not null,
  log_index integer not null,
  unique (tx_hash, log_index),
  unique (tree_id, milestone)
);

create index milestone_forfeits_campaign_idx on public.milestone_forfeits (campaign_address);

-- ---------------------------------------------------------------------------
-- Flags
-- ---------------------------------------------------------------------------

-- A row is created when a contributor submits reason text (status pending). The donor then calls
-- TreeRegistry.flag with reason_hash, and the indexer links the event by reason_hash (status open).
create table public.flags (
  id uuid primary key default gen_random_uuid(),
  tree_id bigint not null references public.trees (tree_id) on delete cascade,
  campaign_address public.eth_address not null references public.campaigns (address) on delete cascade,
  flagger_address public.eth_address not null,
  flagger_profile_id uuid references public.profiles (id) on delete set null,
  reason_text text not null check (char_length(reason_text) between 1 and 2000),
  -- keccak256 of reason_text, stored on-chain.
  reason_hash public.hex32 not null,
  status public.flag_status not null default 'pending',
  resolution_note text check (char_length(resolution_note) <= 2000),
  note_hash public.hex32,
  opened_tx public.hex32,
  opened_at timestamptz,
  resolved_tx public.hex32,
  resolved_at timestamptz,
  resolved_by_profile_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active (on-chain) flag per tree, matching TreeRegistry.
create unique index flags_one_open_per_tree_idx on public.flags (tree_id) where status = 'open';
create index flags_reason_hash_idx on public.flags (reason_hash);
create index flags_campaign_idx on public.flags (campaign_address);

create trigger flags_updated_at before update on public.flags
  for each row execute function public.set_updated_at();
