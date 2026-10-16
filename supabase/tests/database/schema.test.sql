-- Database rule tests. Run with: pnpm db:test (supabase test db).
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from pg_tables where schemaname = 'public' and not rowsecurity),
  0,
  'every public table has row level security enabled'
);

select is(
  (select count(*)::int
   from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee in ('anon', 'authenticated')
     and table_name not like 'v\_public\_%'),
  0,
  'client roles have no grants on tables'
);

select hasnt_column('public', 'v_public_trees', 'exact_lat', 'public tree view hides exact latitude');
select hasnt_column('public', 'v_public_trees', 'exact_lon', 'public tree view hides exact longitude');
select hasnt_column('public', 'v_public_campaigns', 'creator_profile_id', 'public campaign view hides profile ids');

select ok(
  not exists (select 1 from storage.buckets where id in ('evidence', 'keyframes') and public),
  'evidence and keyframes buckets are private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'evidence'),
  26214400::bigint,
  'evidence bucket caps uploads at 25 MB'
);

select ok(
  not has_function_privilege('anon', 'public.claim_relayer_jobs(public.relayer_job_kind[], integer, text, interval)', 'execute'),
  'anon cannot call claim_relayer_jobs'
);
select ok(
  has_function_privilege('service_role', 'public.claim_relayer_jobs(public.relayer_job_kind[], integer, text, interval)', 'execute'),
  'service_role can call claim_relayer_jobs'
);

-- ---------------------------------------------------------------------------
-- Domains
-- ---------------------------------------------------------------------------

select lives_ok($$ select '0xabc0000000000000000000000000000000000001'::public.eth_address $$, 'lowercase address accepted');
select throws_ok(
  $$ select '0xABC0000000000000000000000000000000000001'::public.eth_address $$,
  '23514', null, 'uppercase address rejected'
);
select throws_ok($$ select (-1)::public.uint256 $$, '23514', null, 'negative uint256 rejected');
select lives_ok(
  $$ select '115792089237316195423570985008687907853269984665640564039457584007913129639935'::public.uint256 $$,
  'max uint256 fits'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into public.profiles (id, privy_user_id, wallet_address, role, carbon_rights_agreement_hash)
values
  ('00000000-0000-4000-8000-000000000001', 'did:privy:planter', '0x1000000000000000000000000000000000000001', 'planter',
   '0x' || repeat('a', 64)),
  ('00000000-0000-4000-8000-000000000002', 'did:privy:auditor', '0x1000000000000000000000000000000000000002', 'auditor', null);

insert into public.campaigns (
  address, chain_id, creator_address, region_radius_m, region_geohash, tree_target, anchor_slots, open_slots,
  per_planter_cap, funding_target, funding_deadline, claim_deadline, commitment_units, time_unit_seconds, split,
  metadata_uri, created_block, created_tx
) values (
  '0x2000000000000000000000000000000000000001', 84532, '0x1000000000000000000000000000000000000002', 5000, 'qqguwvt',
  8, 2, 6, 3, 1000000000, now() + interval '1 day', now() + interval '2 days', 36, 60,
  '{"incentivesBps":7000,"seedlingsBps":1000,"verificationBps":500,"reserveBps":1000,"feeBps":500}',
  'treecord://metadata/x', 1, '0x' || repeat('1', 64)
);

insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash, exact_lat, exact_lon,
  latest_evidence_hash, planted_tx)
values (1, '0x2000000000000000000000000000000000000001', 3, '0x1000000000000000000000000000000000000001', now(),
  'qqguwvt', -6.2, 106.816666, '0x' || repeat('2', 64), '0x' || repeat('3', 64));

-- ---------------------------------------------------------------------------
-- Profiles and devices
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ insert into public.profiles (privy_user_id, role) values ('did:privy:no-agreement', 'planter') $$,
  '23514', null, 'planters must accept the carbon rights agreement'
);

prepare add_device(text) as
  insert into public.devices (profile_id, public_key_jwk, thumbprint)
  values ('00000000-0000-4000-8000-000000000001',
          '{"kty":"EC","crv":"P-256","x":"AAAA","y":"BBBB"}', rpad($1, 43, 'x'));

select lives_ok($$ execute add_device('d1') $$, 'first device');
select lives_ok($$ execute add_device('d2') $$, 'second device');
select lives_ok($$ execute add_device('d3') $$, 'third device');
select throws_ok($$ execute add_device('d4') $$, '23514', 'device_limit_reached', 'fourth active device rejected');

update public.devices set revoked_at = now() where thumbprint = rpad('d1', 43, 'x');
select lives_ok($$ execute add_device('d5') $$, 'revoking a device frees a slot');
select throws_ok(
  $$ update public.devices set revoked_at = null where thumbprint = rpad('d1', 43, 'x') $$,
  '23514', 'device_limit_reached', 'un-revoking past the limit is rejected'
);

select throws_ok(
  $$ insert into public.devices (profile_id, public_key_jwk, thumbprint)
     values ('00000000-0000-4000-8000-000000000002', '{"kty":"EC","crv":"P-256","x":"A","y":"B","d":"SECRET"}', rpad('p', 43, 'x')) $$,
  '23514', null, 'private keys cannot be stored'
);

-- ---------------------------------------------------------------------------
-- Submissions
-- ---------------------------------------------------------------------------

prepare add_checkin(text, public.submission_status) as
  insert into public.submissions (profile_id, campaign_address, tree_id, kind, milestone, video_sha256, status)
  values ('00000000-0000-4000-8000-000000000001', '0x2000000000000000000000000000000000000001', 1, 'ALIVE', 1,
          rpad($1, 64, '0'), $2);

select lives_ok($$ execute add_checkin('a1', 'attested') $$, 'attested check-in for milestone 1');
select lives_ok($$ execute add_checkin('a2', 'rejected') $$, 'rejected retries do not count');
select throws_ok($$ execute add_checkin('a3', 'passed') $$, '23505', null, 'second accepted check-in for the same milestone rejected');
select throws_ok($$ execute add_checkin('a1', 'queued') $$, '23505', null, 'same video hash cannot be submitted twice');

select throws_ok(
  $$ insert into public.submissions (profile_id, campaign_address, slot_id, tree_id, kind, milestone, video_sha256)
     values ('00000000-0000-4000-8000-000000000001', '0x2000000000000000000000000000000000000001', 3, 1, 'PLANTED', 0,
             rpad('b1', 64, '0')) $$,
  '23514', null, 'PLANTED submissions cannot reference a tree'
);

-- ---------------------------------------------------------------------------
-- Audit log is append only
-- ---------------------------------------------------------------------------

insert into public.audit_sessions (id, auditor_profile_id, campaign_address, seed, seed_block_number, seed_block_hash, sample_size)
values ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-000000000002',
        '0x2000000000000000000000000000000000000001', '0x' || repeat('4', 64), 10, '0x' || repeat('5', 64), 1);
insert into public.audit_access_log (session_id, auditor_profile_id, resource)
values ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-000000000002', 'tree:1');

select throws_ok($$ update public.audit_access_log set resource = 'x' $$, '42501', null, 'access log rows cannot be updated');
select throws_ok($$ delete from public.audit_access_log $$, '42501', null, 'access log rows cannot be deleted');

-- ---------------------------------------------------------------------------
-- Relayer jobs
-- ---------------------------------------------------------------------------

insert into public.relayer_jobs (kind, payload) values ('attestation', '{"nonce":"7"}'), ('claim', '{"count":2}');
select throws_ok(
  $$ insert into public.relayer_jobs (kind, payload) values ('attestation', '{"nonce":"7"}') $$,
  '23505', null, 'an attestation nonce is queued only once'
);

select is(
  (select count(*)::int from public.claim_relayer_jobs(array['attestation']::public.relayer_job_kind[], 10, 'worker-1')),
  1,
  'claim returns only the requested kinds'
);
select is(
  (select status::text || ':' || attempts || ':' || locked_by from public.relayer_jobs where kind = 'attestation'),
  'processing:1:worker-1',
  'claimed job is processing, counted, and locked'
);
select is(
  (select count(*)::int from public.claim_relayer_jobs(array['attestation']::public.relayer_job_kind[], 10, 'worker-2')),
  0,
  'a processing job is not claimed again while fresh'
);

select * from finish();
rollback;
