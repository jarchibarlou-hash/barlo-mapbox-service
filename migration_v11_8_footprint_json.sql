-- v11.8-P0.3 — persistance géométrie unités
--
-- Contexte : le POST /api/lead-units/:ref recevait 17 champs riches
-- (polygon, offset_x_m, offset_y_m, rotation_deg, width_m, height_m,
-- pilotis, sous_sols, etages_unit, terrasse, balcon, parking_ss,
-- notes_tech, shape_mode, ...) mais ne persistait que 6 champs de base.
-- Résultat : au reload d'un lead depuis Supabase, TOUTES les éditions
-- Revit (drag vertex, offset, trim, corner, rotation, ...) étaient perdues.
-- Le seul chemin par où la géométrie atteignait le PPTX était le body
-- du /generate-pptx transmis à chaque requête.
--
-- Ce fix ajoute une colonne JSONB additive (non-destructive) qui stocke
-- l'objet unité complet côté frontend, permettant restauration exacte
-- au reload. Le schéma des 6 colonnes de base est conservé pour rétro-
-- compatibilité (queries existantes non impactées).
--
-- Application : à exécuter dans le SQL editor Supabase.

BEGIN;

ALTER TABLE IF EXISTS public.sb_lead_units
  ADD COLUMN IF NOT EXISTS footprint_json JSONB NULL;

COMMENT ON COLUMN public.sb_lead_units.footprint_json IS
  'v11.8-P0.3 — snapshot complet unité côté frontend : polygon (mètres locaux y+=Nord origine centroïde parcelle), offset_x_m, offset_y_m, rotation_deg, width_m, height_m, shape_mode, pilotis, sous_sols, etages_unit, terrasse, balcon, parking_ss, notes_tech. Format : voir studio.html:7317-7336. Permet restauration exacte au reload lead. Nullable pour rétro-compat.';

-- Index GIN pour requêtes JSONB futures (ex: leads avec pilotis, unités R+2, etc.)
CREATE INDEX IF NOT EXISTS idx_sb_lead_units_footprint_json
  ON public.sb_lead_units USING GIN (footprint_json);

-- Timestamp updated_at pour détection de désync (optionnel mais utile)
ALTER TABLE IF EXISTS public.sb_lead_units
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE OR REPLACE FUNCTION touch_sb_lead_units_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sb_lead_units_updated_at ON public.sb_lead_units;
CREATE TRIGGER trg_sb_lead_units_updated_at
BEFORE UPDATE ON public.sb_lead_units
FOR EACH ROW
EXECUTE FUNCTION touch_sb_lead_units_updated_at();

COMMIT;

-- Vérification post-migration :
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'sb_lead_units' ORDER BY ordinal_position;
--
-- Résultat attendu (nouvelles colonnes en fin) :
--   lead_ref            text
--   scenario            text
--   unit_index          integer
--   unit_type           text
--   unit_name           text
--   unit_size_m2        numeric
--   placement_sector    text
--   notes               text
--   footprint_json      jsonb    ← NOUVEAU
--   updated_at          timestamptz  ← NOUVEAU
