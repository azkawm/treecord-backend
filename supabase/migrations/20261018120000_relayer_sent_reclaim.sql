-- The worker marks a job `sent` while it waits for the receipt. If the worker dies in that window, the job
-- must be picked up again like a stale `processing` job. The worker then checks the stored tx hash before
-- sending anything new.
create or replace function public.claim_relayer_jobs(
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
        or (status in ('processing', 'sent') and locked_at < now() - p_stale_after)
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
