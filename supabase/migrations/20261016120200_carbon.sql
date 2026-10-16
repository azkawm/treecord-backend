-- Carbon credit mirror. Amounts are on-chain carbon units with 3 decimals (1000 = 1 tCO2e).

create type public.registry_retirement_status as enum ('pending', 'done');

create table public.carbon_reservations (
  campaign_address public.eth_address not null references public.campaigns (address) on delete cascade,
  holder_address public.eth_address not null,
  reserved_amount public.uint256 not null,
  allocated_amount public.uint256 not null default 0,
  declined boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (campaign_address, holder_address),
  constraint allocation_within_reservation check (allocated_amount <= reserved_amount)
);

create index carbon_reservations_holder_idx on public.carbon_reservations (holder_address);

create trigger carbon_reservations_updated_at before update on public.carbon_reservations
  for each row execute function public.set_updated_at();

create table public.carbon_batches (
  batch_id bigint primary key check (batch_id > 0),
  campaign_address public.eth_address not null references public.campaigns (address) on delete restrict,
  registry text not null,
  serial_start text not null,
  serial_end text not null,
  vintage smallint not null,
  amount public.uint256 not null,
  -- USDC base units per whole tonne. Null until set.
  price_usdc_per_tonne public.uint256,
  issued_block bigint not null,
  issued_tx public.hex32 not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index carbon_batches_campaign_idx on public.carbon_batches (campaign_address);

create trigger carbon_batches_updated_at before update on public.carbon_batches
  for each row execute function public.set_updated_at();

-- Allocated events: issuance to a reservation holder or to platform inventory (the ledger address).
create table public.carbon_allocations (
  id uuid primary key default gen_random_uuid(),
  batch_id bigint not null references public.carbon_batches (batch_id) on delete cascade,
  holder_address public.eth_address not null,
  amount public.uint256 not null,
  block_number bigint not null,
  tx_hash public.hex32 not null,
  log_index integer not null,
  unique (tx_hash, log_index)
);

create index carbon_allocations_holder_idx on public.carbon_allocations (holder_address);

create table public.carbon_purchases (
  id uuid primary key default gen_random_uuid(),
  batch_id bigint not null references public.carbon_batches (batch_id) on delete cascade,
  buyer_address public.eth_address not null,
  amount public.uint256 not null,
  usdc_paid public.uint256 not null,
  block_number bigint not null,
  block_time timestamptz not null,
  tx_hash public.hex32 not null,
  log_index integer not null,
  unique (tx_hash, log_index)
);

create index carbon_purchases_buyer_idx on public.carbon_purchases (buyer_address);

-- Current balances per batch and holder (mirror of ERC-1155 balanceOf).
create table public.carbon_balances (
  batch_id bigint not null references public.carbon_batches (batch_id) on delete cascade,
  holder_address public.eth_address not null,
  amount public.uint256 not null,
  updated_block bigint not null,
  primary key (batch_id, holder_address)
);

create index carbon_balances_holder_idx on public.carbon_balances (holder_address);

create table public.retirements (
  retirement_id bigint primary key check (retirement_id > 0),
  batch_id bigint not null references public.carbon_batches (batch_id) on delete restrict,
  holder_address public.eth_address not null,
  amount public.uint256 not null,
  beneficiary text not null,
  purpose text not null,
  retired_at timestamptz not null,
  tx_hash public.hex32 not null,
  log_index integer not null,
  -- The matching retirement in the registry (SRN PPI or Verra) happens off-chain.
  registry_retirement_status public.registry_retirement_status not null default 'pending',
  registry_reference text,
  updated_at timestamptz not null default now(),
  unique (tx_hash, log_index)
);

create index retirements_holder_idx on public.retirements (holder_address);

create trigger retirements_updated_at before update on public.retirements
  for each row execute function public.set_updated_at();
