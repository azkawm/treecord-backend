-- Audit workspace, challenges, indexer cursor, relayer job queue.

create type public.audit_session_status as enum ('open', 'closed');
create type public.audit_finding as enum ('ok', 'issue', 'needs_followup');
create type public.relayer_job_kind as enum (
  'attestation', 'claim', 'anchor_assign', 'issue', 'estimate', 'score', 'resolve_flag'
);
create type public.relayer_job_status as enum ('pending', 'processing', 'sent', 'confirmed', 'failed');

-- ---------------------------------------------------------------------------
-- Audit sessions
-- ---------------------------------------------------------------------------

create table public.audit_sessions (
  id uuid primary key default gen_random_uuid(),
  auditor_profile_id uuid not null references public.profiles (id) on delete restrict,
  campaign_address public.eth_address not null references public.campaigns (address) on delete restrict,
  -- seed = keccak256(sessionId, blockHash). Stored with its inputs so anyone can reproduce the sample.
  seed public.hex32 not null,
  seed_block_number bigint not null,
  seed_block_hash public.hex32 not null,
  sample_size integer not null check (sample_size > 0),
  status public.audit_session_status not null default 'open',
  report jsonb,
  report_hash public.hex32,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint closed_sessions_have_report check (
    (status = 'open' and closed_at is null)
    or (status = 'closed' and closed_at is not null and report is not null and report_hash is not null)
  )
);

create index audit_sessions_auditor_idx on public.audit_sessions (auditor_profile_id);
create index audit_sessions_campaign_idx on public.audit_sessions (campaign_address);

create table public.audit_samples (
  session_id uuid not null references public.audit_sessions (id) on delete cascade,
  tree_id bigint not null references public.trees (tree_id) on delete restrict,
  -- Order in the reproducible sample.
  position integer not null check (position >= 0),
  finding public.audit_finding,
  notes text check (char_length(notes) <= 5000),
  recorded_at timestamptz,
  primary key (session_id, tree_id),
  unique (session_id, position)
);

-- Every evidence access by an auditor. Append only.
create table public.audit_access_log (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.audit_sessions (id) on delete restrict,
  auditor_profile_id uuid not null references public.profiles (id) on delete restrict,
  resource text not null,
  accessed_at timestamptz not null default now()
);

create index audit_access_log_session_idx on public.audit_access_log (session_id, accessed_at);

create function public.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append only', tg_table_name using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_access_log_append_only before update or delete on public.audit_access_log
  for each row execute function public.reject_mutation();
create trigger audit_access_log_no_truncate before truncate on public.audit_access_log
  for each statement execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- "Prove it now" challenges
-- ---------------------------------------------------------------------------

create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  tree_id bigint not null references public.trees (tree_id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9]{4}$'),
  issued_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  audit_session_id uuid references public.audit_sessions (id) on delete set null,
  expires_at timestamptz not null,
  fulfilled_submission_id uuid references public.submissions (id) on delete set null,
  created_at timestamptz not null default now()
);

create index challenges_tree_open_idx on public.challenges (tree_id, expires_at)
  where fulfilled_submission_id is null;

alter table public.submissions
  add constraint submissions_challenge_fk
  foreign key (challenge_id) references public.challenges (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Indexer cursor
-- ---------------------------------------------------------------------------

create table public.chain_cursor (
  name text primary key,
  last_block bigint not null check (last_block >= 0),
  updated_at timestamptz not null default now()
);

create trigger chain_cursor_updated_at before update on public.chain_cursor
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Relayer jobs
-- ---------------------------------------------------------------------------

create table public.relayer_jobs (
  id uuid primary key default gen_random_uuid(),
  kind public.relayer_job_kind not null,
  payload jsonb not null,
  status public.relayer_job_status not null default 'pending',
  tx_hash public.hex32,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  last_error text,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  -- Idempotency-Key header of the API request that created the job, when given.
  idempotency_key text unique check (char_length(idempotency_key) between 1 and 200),
  created_by_profile_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attestation_jobs_have_nonce check (kind <> 'attestation' or payload ? 'nonce')
);

-- An attestation nonce can only be queued once.
create unique index relayer_jobs_attestation_nonce_idx on public.relayer_jobs ((payload ->> 'nonce'))
  where kind = 'attestation';
create index relayer_jobs_pending_idx on public.relayer_jobs (kind, next_attempt_at) where status = 'pending';
create index relayer_jobs_status_idx on public.relayer_jobs (status);

create trigger relayer_jobs_updated_at before update on public.relayer_jobs
  for each row execute function public.set_updated_at();

-- Claims up to p_limit due jobs of the given kinds for one worker, safely under concurrency
-- (FOR UPDATE SKIP LOCKED). Also reclaims jobs stuck in `processing` longer than p_stale_after,
-- for example after a worker crash. Claiming counts as an attempt.
create function public.claim_relayer_jobs(
  p_kinds public.relayer_job_kind[],
  p_limit integer,
  p_worker text,
  p_stale_after interval default interval '5 minutes'
)
returns setof public.relayer_jobs
language sql
set search_path = ''
as $$
  with due as (
    select id
    from public.relayer_jobs
    where kind = any (p_kinds)
      and attempts < max_attempts
      and (
        (status = 'pending' and next_attempt_at <= now())
        or (status = 'processing' and locked_at < now() - p_stale_after)
      )
    order by next_attempt_at, created_at
    for update skip locked
    limit greatest(p_limit, 0)
  )
  update public.relayer_jobs as job
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker,
      attempts = job.attempts + 1
  from due
  where job.id = due.id
  returning job.*;
$$;
