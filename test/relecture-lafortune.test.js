const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");

// v13.6 — erreurs relevées dans le PPT final de Lafortune (29/09) : chaque test en rejoue une
const S = loadServer(["computeSmartScenarios", "scenarioEngineInputs", "budgetPositionV13", "surfaceUtileV13"]);
const FMM4 = "4.0450260,9.6953230|4.0451076,9.6953619|4.0450701,9.6954531|4.0449738,9.6954183|4.0449444,9.6954236|4.0448360,9.6953700|4.0448494,9.6953512";
const LEAD = { site_area: 250, envelope_w: 3, envelope_d: 22, zoning_type: "URBAIN", program_main: "Usage mixte (logement + activité)",
  standing_level: "ECONOMIQUE", layout_mode: "SPLIT_AV_AR", input_typologies: "T1=1", target_units: 4, target_surface_m2: 225,
  feasibility_posture: "CONSERVATIVE", city: "Douala", budget_range: "⭕ 50 000 – 100 000 € (~33–66 M FCFA)", site_polygon: FMM4 };

test("emprise d'un scénario dessiné : celle du plan (158 m²), pas surface ÷ niveaux (109 m²)", () => {
  const units = [{ type: "BUREAU", area_m2: 60, name: "Cabinet d'avocat" }, { type: "BUREAU", area_m2: 58, name: "Cabinet médical" },
    { type: "T2", area_m2: 40, name: "logement" }, { type: "BUREAU", area_m2: 60, name: "Co-working" }];
  const ROWS = { A: { status: "VALIDATED", actual: { units_count: 4, sdp_m2: 218, sous_sols_m2: 0, emprise_sol_m2: 158, levels_max: 2, units, checks: [] } } };
  const sc = S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, {}, null, ROWS));
  assert.equal(sc.A.sdp_m2, 218);
  assert.equal(Math.round(sc.A.emprise_sol_m2), 158, "emprise dessinée conservée");
  assert.ok(sc.A.cos_ratio_pct > 100, "158 m² pour 150 m² autorisés : au-delà du maximum");
});

test("position dans la fourchette : bas / milieu / haut calculés, pas « haut » dès le minimum dépassé", () => {
  const P = x => S.budgetPositionV13(x).code;
  const base = { budget_min_fcfa: 33e6, budget_max_fcfa: 66e6, budget_fit: "BUDGET_TENDU" };
  assert.equal(P({ ...base, budget_needed_fcfa: 39e6 }), "BAS", "C de Lafortune : 39 M dans 33–66 M");
  assert.equal(P({ ...base, budget_needed_fcfa: 50e6 }), "MILIEU");
  assert.equal(P({ ...base, budget_needed_fcfa: 60e6 }), "HAUT");
  assert.equal(P({ ...base, budget_fit: "DANS_BUDGET", budget_needed_fcfa: 30e6 }), "BAS");
  assert.equal(P({ ...base, budget_fit: "HORS_BUDGET", budget_needed_fcfa: 70e6 }), "AU_DESSUS");
  assert.equal(S.budgetPositionV13({ ...base, budget_needed_fcfa: 45e6 }).label, "au milieu de votre fourchette", "B de Lafortune : 45 M avec sa réserve");
});

test("surface utile estimée : murs et escalier déduits, jamais égale à la surface de plancher", () => {
  assert.equal(S.surfaceUtileV13({ sdp_m2: 162, levels: 4 }), 114, "C de Lafortune : 4 niveaux de 40 m²");
  assert.equal(S.surfaceUtileV13({ sdp_m2: 119, levels: 1 }), 107, "plain-pied : pas d'escalier");
  assert.ok(S.surfaceUtileV13({ sdp_m2: 218, levels: 2 }) < 218);
});
