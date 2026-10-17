-- Prompt 10: inputs the impact report and the audit reproduction need.

-- How the pre-certification estimate was computed (species figures, tree count, maturity curve). Written by
-- POST /api/operator/carbon/estimate next to estimated_amount, shown in the campaign impact report.
alter table public.campaigns add column estimate_method jsonb;

-- The trees the audit sample was drawn from, in ascending id order, frozen at session creation. Together
-- with the seed inputs this lets anyone recompute the sample, even after more trees are planted.
alter table public.audit_sessions
  add column population_tree_ids bigint[] not null default '{}';
