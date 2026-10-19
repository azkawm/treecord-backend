-- Operators set the inventory price of an issued batch through the API (POST /api/operator/carbon/price).
-- The worker sends CarbonLedger.setPrice from the operator wallet.
alter type public.relayer_job_kind add value if not exists 'set_price';
