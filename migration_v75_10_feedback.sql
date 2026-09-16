-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration BARLO v75.10 (Phase A.2) — Table sb_lead_moteur_feedback
-- ═══════════════════════════════════════════════════════════════════════════════
-- Objectif : logger les deltas entre proposition moteur et choix final utilisateur
-- pour identifier les champs systématiquement modifiés et affiner le moteur.
--
-- Utilisée par :
--   POST /api/lead-feedback/:ref  → insertion des deltas au moment de Enregistrer
--   GET  /api/moteur-feedback/insights → patterns aggregés (>3 leads consecutifs)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sb_lead_moteur_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_ref TEXT NOT NULL,
  scenario CHAR(1) NOT NULL,             -- 'A' / 'B' / 'C'
  field TEXT NOT NULL,                    -- 'cos', 'layout_mode', 'units_count', 'polygon', etc.
  moteur_baseline TEXT,                   -- valeur initiale proposée
  user_final TEXT,                        -- valeur finale saisie
  delta_pct NUMERIC(8,2),                 -- écart en % pour valeurs numériques
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT check_scenario CHECK (scenario IN ('A', 'B', 'C'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_ref ON sb_lead_moteur_feedback(lead_ref);
CREATE INDEX IF NOT EXISTS idx_feedback_field ON sb_lead_moteur_feedback(field);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON sb_lead_moteur_feedback(created_at DESC);

ALTER TABLE sb_lead_moteur_feedback DISABLE ROW LEVEL SECURITY;
