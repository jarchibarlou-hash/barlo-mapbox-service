-- v12 — SÉCURITÉ : réactive la Row Level Security sur les tables utilisées par le seul serveur BARLO.
--
-- ⚠️ À EXÉCUTER UNIQUEMENT APRÈS avoir vérifié que
--    https://barlo-mapbox-service.onrender.com/health affiche
--    "supabase_key_role":"service_role"  (ou "secret (serveur)").
--    Avec une clé anon, le serveur ne pourrait plus lire ni écrire ces tables.
--
-- Effet : RLS activée sans aucune règle = la clé publique (anon) ne peut plus rien lire
-- ni écrire dans ces tables. Le serveur, avec la clé service_role, n'est pas concerné
-- (cette clé passe outre la RLS). Les données des clients ne sont plus exposées.
--
-- Non modifié volontairement : polygon_drafts (écrite par l'outil de dessin de parcelle
-- côté navigateur) et le bucket massing-images (lecture publique nécessaire aux images du PPT).
--
-- Idempotent. SQL editor Supabase, projet massing-storage.

BEGIN;

ALTER TABLE IF EXISTS public.sb_lead_units            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sb_lead_moteur_feedback  ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sb_scenarios             ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sb_scenario_sets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sb_scenario_revisions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sb_lead_rules            ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Vérification (doit afficher rowsecurity = true pour les 6 tables) :
-- SELECT tablename, rowsecurity FROM pg_tables
--  WHERE schemaname = 'public' AND tablename IN
--  ('sb_lead_units','sb_lead_moteur_feedback','sb_scenarios','sb_scenario_sets','sb_scenario_revisions','sb_lead_rules');
