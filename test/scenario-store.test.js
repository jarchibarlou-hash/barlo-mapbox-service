const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");
const { createFakeSupabase } = require("./fake-supabase");

const LEAD = {
  lead_id: "TEST-STORE", site_area: 250, envelope_w: 12, envelope_d: 18, zoning_type: "URBAIN",
  program_main: "Usage mixte (logement + activité)", target_units: 3, input_typologies: "T3=2, COMMERCE=1",
  standing_level: "ECONOMIQUE", layout_mode: "SUPERPOSE",
};

function fresh() {
  const fake = createFakeSupabase();
  const S = loadServer(["getOrComputeScenarioSet", "scenarioModelView"], { supabase: fake.client });
  return { S, fake };
}

test("1er calcul : enregistré, 3 suggestions avec rôle et état SUGGESTED", async () => {
  const { S, fake } = fresh();
  const r = await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  assert.equal(r.fromStore, false);
  assert.equal(fake.tables.sb_scenario_sets.length, 1);
  const rows = fake.tables.sb_scenarios;
  assert.equal(rows.length, 3);
  const A = rows.find(x => x.scenario === "A");
  assert.equal(A.role, "CLIENT_INTENT");
  assert.equal(A.status, "SUGGESTED");
  assert.equal(A.suggested.cost_per_m2.value, 250000);
});

test("2e appel avec les mêmes entrées : résultat relu, pas recalculé", async () => {
  const { S } = fresh();
  await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  const r2 = await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  assert.equal(r2.fromStore, true);
  assert.equal(r2.scenarios.A.role_v12, "CLIENT_INTENT");
});

test("coût/m² saisi : recalcul effectif, suggestion BARLO intacte, état EDITING", async () => {
  const { S, fake } = fresh();
  await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  // Simule la saisie utilisateur (ce que fait la route /override)
  const A = fake.tables.sb_scenarios.find(x => x.scenario === "A");
  A.overrides = { cost_per_m2: { value: 400000, source: "USER_OVERRIDE", at: "2026-09-23T12:00:00Z" } };
  A.status = "EDITING";
  const r = await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  assert.equal(r.fromStore, false, "les entrées ont changé");
  assert.equal(r.scenarios.A.cost_per_m2, 400000, "calcul effectif avec la saisie");
  const Aafter = fake.tables.sb_scenarios.find(x => x.scenario === "A");
  assert.equal(Aafter.suggested.cost_per_m2.value, 250000, "suggestion BARLO jamais contaminée");
  assert.equal(Aafter.overrides.cost_per_m2.value, 400000, "saisie jamais écrasée");
  assert.equal(Aafter.status, "EDITING");
  const view = S.scenarioModelView("A", Aafter, r.scenarios.A);
  assert.deepEqual(view.effective.cost_per_m2, { value: 400000, source: "USER_OVERRIDE" });
  assert.ok(view.effective.engine.cost_total_fcfa > 0);
});

test("scénario validé puis nouvelle suggestion différente : passe en OUTDATED", async () => {
  const { S, fake } = fresh();
  await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  fake.tables.sb_scenarios.forEach(r => { r.status = "VALIDATED"; });
  await S.getOrComputeScenarioSet(Object.assign({}, LEAD, { target_units: 5, input_typologies: "T3=4, COMMERCE=1" }));
  const A = fake.tables.sb_scenarios.find(x => x.scenario === "A");
  assert.equal(A.status, "OUTDATED");
});

test("incident du 23/09 rejoué : client Supabase impossible à créer → calcul direct, pas de plantage", async () => {
  const S = loadServer(["getOrComputeScenarioSet"], { supabaseThrows: "Node.js 20 detected without native WebSocket support" });
  const r = await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  assert.equal(r.fromStore, false);
  assert.equal(r.scenarios.A.role_v12, "CLIENT_INTENT");
});

test("sans Supabase : calcul direct, rien ne casse", async () => {
  const S = loadServer(["getOrComputeScenarioSet"]);
  const r = await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  assert.equal(r.fromStore, false);
  assert.equal(r.scenarios.C.role_v12, "PRUDENT");
});
