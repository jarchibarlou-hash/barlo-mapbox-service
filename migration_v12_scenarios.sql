-- v12 — Source de vérité unique par scénario (BARLO Studio master spec)
--
-- sb_scenarios          : 1 ligne par (lead, scénario A/B/C). Rôle métier explicite,
--                         suggestion BARLO figée, surcharges utilisateur avec provenance,
--                         géométrie/métriques réelles après validation, analyse, état.
-- sb_scenario_revisions : 1 ligne par validation (historique, jamais modifié).
-- sb_lead_rules         : règles du terrain par lead (COS, CES, retraits, façade aveugle…),
--                         chaque valeur avec sa provenance (donnée / hypothèse / inconnue).
-- sb_scenario_sets      : résultat complet du moteur pour un lead + empreinte de ses entrées,
--                         relu par le PPT et les textes au lieu de relancer le moteur.
--
-- Application : SQL editor Supabase. Idempotent (peut être relancé sans risque).

BEGIN;

CREATE TABLE IF NOT EXISTS public.sb_scenarios (
  lead_ref      TEXT        NOT NULL,
  scenario      TEXT        NOT NULL CHECK (scenario IN ('A','B','C')),
  role          TEXT        NOT NULL CHECK (role IN ('CLIENT_INTENT','BALANCED','PRUDENT')),
  status        TEXT        NOT NULL DEFAULT 'SUGGESTED'
                            CHECK (status IN ('SUGGESTED','EDITING','VALIDATED','OUTDATED','ANALYZED')),
  suggested     JSONB       NULL,   -- proposition BARLO (jamais écrasée par l'utilisateur)
  overrides     JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- { champ: { value, source:'USER_OVERRIDE', at } }
  actual        JSONB       NULL,   -- géométrie validée + métriques réelles
  analysis      JSONB       NULL,   -- contraintes, score, constats, textes
  revision      INTEGER     NOT NULL DEFAULT 0,
  suggested_at  TIMESTAMPTZ NULL,
  validated_at  TIMESTAMPTZ NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lead_ref, scenario)
);

CREATE TABLE IF NOT EXISTS public.sb_scenario_revisions (
  id          BIGSERIAL   PRIMARY KEY,
  lead_ref    TEXT        NOT NULL,
  scenario    TEXT        NOT NULL,
  revision    INTEGER     NOT NULL,
  snapshot    JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sb_scenario_revisions_lead
  ON public.sb_scenario_revisions (lead_ref, scenario, revision DESC);

CREATE TABLE IF NOT EXISTS public.sb_lead_rules (
  lead_ref    TEXT        PRIMARY KEY,
  rules       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sb_scenario_sets (
  lead_ref      TEXT        PRIMARY KEY,
  inputs_hash   TEXT        NOT NULL,
  inputs        JSONB       NOT NULL,
  engine_result JSONB       NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Le serveur utilise la clé service_role (RLS contournée), comme pour sb_lead_units.
ALTER TABLE public.sb_scenarios          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sb_scenario_revisions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sb_lead_rules         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sb_scenario_sets      DISABLE ROW LEVEL SECURITY;

COMMIT;

-- Vérification :
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'public' AND table_name IN
--  ('sb_scenarios','sb_scenario_revisions','sb_lead_rules','sb_scenario_sets');
-- → 4 lignes attendues
