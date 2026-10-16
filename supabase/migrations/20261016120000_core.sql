-- Treecord core schema: shared types, profiles, devices, species, campaigns, slots, trees.
-- See docs/database.md for which component writes each table.

-- ---------------------------------------------------------------------------
-- Domains
-- ---------------------------------------------------------------------------

-- Lowercase 0x-prefixed 20-byte address.
create domain public.eth_address as text
  check (value ~ '^0x[0-9a-f]{40}$');

-- Lowercase 0x-prefixed 32-byte value (tx hashes, keccak hashes, block hashes).
create domain public.hex32 as text
  check (value ~ '^0x[0-9a-f]{64}$');

-- Unsigned 256-bit integer: USDC base units, carbon units, nonces.
-- PostgREST returns numeric as a JSON number. Read these columns with a ::text cast and parse as bigint.
create domain public.uint256 as numeric(78, 0)
  check (value >= 0);

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.user_role as enum ('donor', 'planter', 'auditor', 'operator');
create type public.campaign_status as enum ('funding', 'active', 'refunding', 'completed');
create type public.slot_kind as enum ('anchor', 'open');
create type public.slot_status as enum ('open', 'claimed', 'planted', 'anchor');
create type public.tree_status as enum ('alive', 'flagged', 'dead', 'removed', 'completed');
create type public.tree_event_kind as enum (
  'planted', 'check_in', 'died', 'replanted', 'removed', 'flagged', 'flag_resolved', 'completed'
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles and devices
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  privy_user_id text not null unique,
  wallet_address public.eth_address unique,
  role public.user_role not null default 'donor',
  display_name text check (char_length(display_name) between 1 and 80),
  is_buyer boolean not null default false,
  -- Hash of the accepted planter agreement version that assigns carbon rights to the platform.
  carbon_rights_agreement_hash public.hex32,
  carbon_rights_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint planters_accept_carbon_agreement
    check (role <> 'planter' or carbon_rights_agreement_hash is not null)
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  public_key_jwk jsonb not null,
  -- RFC 7638 SHA-256 thumbprint, base64url. Matches deviceKey in the signed evidence payload.
  thumbprint text not null unique check (thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  label text check (char_length(label) between 1 and 64),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint public_p256_key_only check (
    public_key_jwk ->> 'kty' = 'EC'
    and public_key_jwk ->> 'crv' = 'P-256'
    and not (public_key_jwk ? 'd')
  )
);

create index devices_profile_active_idx on public.devices (profile_id) where revoked_at is null;

-- A planter may have at most 3 active devices (PRODUCT_KNOWLEDGE.md section 3, prompt 7).
create function public.enforce_device_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  active_count integer;
begin
  if new.revoked_at is not null then
    return new;
  end if;
  select count(*) into active_count
  from public.devices
  where profile_id = new.profile_id
    and revoked_at is null
    and id <> new.id;
  if active_count >= 3 then
    raise exception 'device_limit_reached' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger devices_limit before insert or update of revoked_at, profile_id on public.devices
  for each row execute function public.enforce_device_limit();

-- ---------------------------------------------------------------------------
-- Species reference data (rows in seed.sql)
-- ---------------------------------------------------------------------------

create table public.species (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  scientific_name text not null,
  local_name text not null,
  english_name text not null,
  -- Pre-certification planning figure for one mature tree. Not a methodology value.
  est_kg_co2_per_year_mature numeric(10, 2) not null check (est_kg_co2_per_year_mature > 0),
  years_to_maturity smallint not null check (years_to_maturity > 0)
);

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------

-- Off-chain metadata uploaded by a donor before calling the factory. Its id becomes the metadataURI.
create table public.campaign_metadata (
  id uuid primary key default gen_random_uuid(),
  creator_profile_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 3 and 120),
  description text not null default '' check (char_length(description) <= 5000),
  species_code text not null references public.species (code),
  region_name text not null,
  region_center_lat double precision not null check (region_center_lat between -90 and 90),
  region_center_lon double precision not null check (region_center_lon between -180 and 180),
  region_radius_m integer not null check (region_radius_m between 100 and 100000),
  image_urls text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- Mirror of on-chain campaigns plus metadata. Chain is the source of truth for money and status.
create table public.campaigns (
  address public.eth_address primary key,
  chain_id integer not null,
  creator_address public.eth_address not null,
  creator_profile_id uuid references public.profiles (id) on delete set null,
  metadata_id uuid references public.campaign_metadata (id) on delete set null,
  status public.campaign_status not null default 'funding',
  title text,
  description text,
  species_code text,
  species_name text,
  region_name text,
  region_center_lat double precision,
  region_center_lon double precision,
  region_radius_m integer not null,
  region_geohash text not null,
  tree_target integer not null check (tree_target > 0),
  anchor_slots integer not null check (anchor_slots >= 0),
  open_slots integer not null check (open_slots >= 0),
  per_planter_cap integer not null check (per_planter_cap > 0),
  funding_target public.uint256 not null,
  funded_amount public.uint256 not null default 0,
  funding_deadline timestamptz not null,
  claim_deadline timestamptz not null,
  commitment_units integer not null check (commitment_units >= 36),
  time_unit_seconds bigint not null check (time_unit_seconds > 0),
  -- {"incentivesBps":7000,"seedlingsBps":1000,"verificationBps":500,"reserveBps":1000,"feeBps":500}
  split jsonb not null,
  incentive_pool public.uint256,
  reserve_amount public.uint256,
  per_tree_incentive public.uint256,
  refund_pool public.uint256,
  activated_at timestamptz,
  completed_at timestamptz,
  -- Pre-certification carbon estimate in on-chain carbon units (1000 = 1 tCO2e).
  estimated_amount public.uint256,
  metadata_uri text not null,
  created_block bigint not null,
  created_tx public.hex32 not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint slots_add_up check (anchor_slots + open_slots = tree_target),
  constraint funded_within_target check (funded_amount <= funding_target)
);

create index campaigns_status_idx on public.campaigns (status);
create index campaigns_species_idx on public.campaigns (species_code);
create index campaigns_creator_idx on public.campaigns (creator_address);

create trigger campaigns_updated_at before update on public.campaigns
  for each row execute function public.set_updated_at();

create table public.contributions (
  id uuid primary key default gen_random_uuid(),
  campaign_address public.eth_address not null references public.campaigns (address) on delete cascade,
  contributor_address public.eth_address not null,
  amount public.uint256 not null,
  total_raised_after public.uint256 not null,
  block_number bigint not null,
  block_time timestamptz not null,
  tx_hash public.hex32 not null,
  log_index integer not null,
  unique (tx_hash, log_index)
);

create index contributions_campaign_idx on public.contributions (campaign_address);
create index contributions_contributor_idx on public.contributions (contributor_address);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  campaign_address public.eth_address not null references public.campaigns (address) on delete cascade,
  contributor_address public.eth_address not null,
  amount public.uint256 not null,
  block_number bigint not null,
  block_time timestamptz not null,
  tx_hash public.hex32 not null,
  log_index integer not null,
  unique (tx_hash, log_index)
);

create index refunds_campaign_idx on public.refunds (campaign_address);

-- ---------------------------------------------------------------------------
-- Slots and trees
-- ---------------------------------------------------------------------------

create table public.slots (
  campaign_address public.eth_address not null references public.campaigns (address) on delete cascade,
  slot_id integer not null check (slot_id > 0),
  planter_address public.eth_address,
  kind public.slot_kind not null,
  status public.slot_status not null default 'open',
  claimed_at timestamptz,
  claimed_tx public.hex32,
  tree_id bigint,
  updated_at timestamptz not null default now(),
  primary key (campaign_address, slot_id),
  constraint claimed_slots_have_planter
    check (status in ('open', 'anchor') or planter_address is not null)
);

create index slots_planter_idx on public.slots (planter_address);

create trigger slots_updated_at before update on public.slots
  for each row execute function public.set_updated_at();

create table public.trees (
  tree_id bigint primary key check (tree_id > 0),
  campaign_address public.eth_address not null references public.campaigns (address) on delete cascade,
  slot_id integer not null,
  planter_address public.eth_address not null,
  status public.tree_status not null default 'alive',
  planted_at timestamptz not null,
  -- Public precision-7 geohash. Exact coordinates below never go on-chain.
  geohash text not null,
  -- Exact GPS of the planting submission. Visible only to the planter, operators and auditors.
  exact_lat double precision,
  exact_lon double precision,
  replant_deadline timestamptz,
  -- Seconds added to the milestone schedule by dismissed flags (PRODUCT_KNOWLEDGE.md section 15, rule 2).
  paused_seconds bigint not null default 0 check (paused_seconds >= 0),
  latest_evidence_hash public.hex32 not null,
  check_in_count integer not null default 0 check (check_in_count >= 0),
  planted_tx public.hex32 not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_address, slot_id),
  constraint exact_location_pair check ((exact_lat is null) = (exact_lon is null))
);

create index trees_campaign_idx on public.trees (campaign_address);
create index trees_planter_idx on public.trees (planter_address);
create index trees_status_idx on public.trees (status);

create trigger trees_updated_at before update on public.trees
  for each row execute function public.set_updated_at();

alter table public.slots
  add constraint slots_tree_fk foreign key (tree_id) references public.trees (tree_id) on delete set null;

-- Tree timeline for GET /api/trees/:treeId, one row per on-chain event.
create table public.tree_events (
  id uuid primary key default gen_random_uuid(),
  tree_id bigint not null references public.trees (tree_id) on delete cascade,
  kind public.tree_event_kind not null,
  evidence_hash public.hex32,
  data jsonb not null default '{}',
  block_number bigint not null,
  block_time timestamptz not null,
  tx_hash public.hex32 not null,
  log_index integer not null,
  unique (tx_hash, log_index)
);

create index tree_events_tree_idx on public.tree_events (tree_id, block_number, log_index);
