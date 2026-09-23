const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");

const S = loadServer([
  "computeSmartScenarios", "scenarioEngineInputs", "suggestionOnlyInputs",
  "applyScenarioOverrides", "parseLeadConstraints", "V12_ENGINE_VERSION",
]);

// Lead type proche de BARLO-FMM4 : Douala, usage mixte, 3 unités, économique.
const LEAD = {
  lead_id: "TEST-ENGINE", site_area: 250, envelope_w: 12, envelope_d: 18, zoning_type: "URBAIN",
  program_main: "Usage mixte (logement + activité)", target_units: 3, input_typologies: "T3=2, COMMERCE=1",
  standing_level: "ECONOMIQUE", budget_range: "50 000 - 100 000 €", budget_tension: "HIGH",
  feasibility_posture: "CONSERVATIVE", layout_mode: "SUPERPOSE",
};

test("le moteur produit A/B/C avec rôle v12 et coût/m² de la grille de Jeremy", () => {
  const inputs = S.scenarioEngineInputs(LEAD, {});
  const r = S.computeSmartScenarios(inputs);
  assert.equal(r.A.role_v12, "CLIENT_INTENT");
  assert.equal(r.B.role_v12, "BALANCED");
  assert.equal(r.C.role_v12, "PRUDENT");
  assert.equal(r.A.market_cost_per_m2, 250000);
  assert.equal(r.B.market_cost_per_m2, 200000);
  assert.equal(r.C.market_cost_per_m2, 175000);
  assert.equal(r.A.cost_per_m2, 250000);
  assert.equal(r.A.cost_per_m2_source, "BARLO_SUGGESTION");
});

test("un coût/m² saisi remplace la suggestion et se répercute sur le coût total", () => {
  const base = S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, {}));
  const withOv = S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, { A: 400000 }));
  assert.equal(withOv.A.cost_per_m2, 400000);
  assert.equal(withOv.A.cost_per_m2_source, "USER_OVERRIDE");
  assert.equal(withOv.A.market_cost_per_m2, 250000, "la suggestion reste visible");
  assert.equal(withOv.A.cost_per_m2_suggested.value, 250000);
  assert.ok(withOv.A.cost_total_fcfa > base.A.cost_total_fcfa, "coût total recalculé");
  assert.equal(withOv.B.cost_per_m2, base.B.cost_per_m2, "les autres scénarios ne bougent pas");
});

test("la suggestion pure retire les réglages de l'utilisateur mais garde les règles du site", () => {
  const lead = Object.assign({}, LEAD, { override_levels_B: "R+2", override_ignore_setbacks: "Y" });
  const inputs = S.scenarioEngineInputs(lead, { A: 400000 });
  const pure = S.suggestionOnlyInputs(inputs);
  assert.ok(pure, "réglages détectés");
  assert.deepEqual(pure.cost_per_m2_overrides, {});
  assert.deepEqual(pure._leadConstraints.programmatic, {});
  assert.equal(pure._leadConstraints.regulatory.ignore_setbacks, true, "règle du site conservée");
  assert.equal(S.suggestionOnlyInputs(S.scenarioEngineInputs(LEAD, {})), null, "rien à retirer");
});

test("le moteur est déterministe (condition de la relecture du résultat enregistré)", () => {
  const a = JSON.stringify(S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, {})));
  const b = JSON.stringify(S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, {})));
  assert.equal(a, b);
});
