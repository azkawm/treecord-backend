-- Treecord seed data. Runs after migrations on `supabase db reset`.
-- For a cloud project, push it with `supabase db push --include-seed`.

-- Species reference rows. est_kg_co2_per_year_mature is a rough pre-certification planning figure for one
-- mature tree, used only for the labeled pre-certification estimate. Certified tonnage always comes from the
-- registry methodology, never from this table.
insert into public.species (code, scientific_name, local_name, english_name, est_kg_co2_per_year_mature, years_to_maturity)
values
  ('SWIETENIA_MACROPHYLLA', 'Swietenia macrophylla', 'Mahoni', 'Big-leaf mahogany', 30.00, 20),
  ('DURIO_ZIBETHINUS', 'Durio zibethinus', 'Durian', 'Durian', 25.00, 15),
  ('RHIZOPHORA_MUCRONATA', 'Rhizophora mucronata', 'Bakau', 'Loop-root mangrove', 28.00, 15),
  ('FALCATARIA_FALCATA', 'Falcataria falcata', 'Sengon', 'Sengon (white albizia)', 40.00, 8),
  ('PERSEA_AMERICANA', 'Persea americana', 'Alpukat', 'Avocado', 20.00, 10)
on conflict (code) do update set
  scientific_name = excluded.scientific_name,
  local_name = excluded.local_name,
  english_name = excluded.english_name,
  est_kg_co2_per_year_mature = excluded.est_kg_co2_per_year_mature,
  years_to_maturity = excluded.years_to_maturity;
