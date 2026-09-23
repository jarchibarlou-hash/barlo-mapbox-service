const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");

const S = loadServer(["actualCostView", "effectiveCostPerM2", "scenarioModelView"]);
const ACTUAL = { sdp_m2: 180, sous_sols_m2: 20, emprise_sol_m2: 90, checks: [] };
const LEAD = { standing_level: "ECONOMIQUE", budget_range: "⭕ 50 000 – 100 000 € (~33–66 M FCFA)", site_area: 250 };

test("coût des travaux de la géométrie validée : (SDP + sous-sols) × coût/m² du rôle × 1,05", () => {
  const v = S.actualCostView(ACTUAL, "BALANCED", 200000, LEAD.budget_range);
  assert.equal(v.cost_travaux_fcfa, Math.round(200 * 200000 * 1.05));
  assert.equal(v.budget_needed_fcfa, Math.round(v.cost_travaux_fcfa / 0.9), "réserve B 10 %");
  assert.equal(v.budget_fit, "BUDGET_TENDU", "46,7 M dans 33–66 M");
  assert.equal(v.reserve_pct, 10);
});

test("coût/m² : la saisie de l'utilisateur prime, sinon la grille de Jeremy", () => {
  assert.equal(S.effectiveCostPerM2(null, "ECONOMIQUE", "PRUDENT"), 175000);
  const row = { overrides: { cost_per_m2: { value: 300000, source: "USER_OVERRIDE" } } };
  assert.equal(S.effectiveCostPerM2(row, "ECONOMIQUE", "PRUDENT"), 300000);
});

test("vue cockpit : la géométrie validée est exposée, coût recalculé avec le coût/m² du moment", () => {
  const row = { status: "VALIDATED", actual: Object.assign({}, ACTUAL, { cost_travaux_fcfa: 1 }),
    overrides: { cost_per_m2: { value: 220000, source: "USER_OVERRIDE" } } };
  const m = S.scenarioModelView("B", row, null, 250, LEAD);
  assert.equal(m.status, "VALIDATED");
  assert.equal(m.actual.cost_per_m2, 220000);
  assert.equal(m.actual.cost_travaux_fcfa, Math.round(200 * 220000 * 1.05), "recalculé, pas la valeur figée");
  assert.equal(m.actual.emprise_sol_m2, 90);
});
