const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");
const { createFakeSupabase } = require("./fake-supabase");

// Cas réel BARLO-FMM4 : anciennes saisies PIPELINE (emprise 180 m², RDC, 3 unités) + scénario A validé
const LEAD = {
  lead_id: "TEST-ACTUAL", site_area: 250, envelope_w: 9, envelope_d: 30, zoning_type: "URBAIN",
  program_main: "Usage mixte (logement + activité)", target_units: 3, input_typologies: "T1=1",
  standing_level: "ECONOMIQUE", layout_mode: "SPLIT_AV_AR", budget_range: "⭕ 50 000 – 100 000 € (~33–66 M FCFA)",
  override_fp_A: "180", override_levels_A: "1", override_units_A: "3",
  override_fp_B: "112", override_levels_B: "1", override_units_B: "3",
};
const ACTUAL_A = {
  units_count: 3, sdp_m2: 119, sous_sols_m2: 0, emprise_sol_m2: 119, levels_max: 1, occupation_sol_pct: 48,
  units: [
    { name: "Commerce", type: "COMMERCE", area_m2: 36 },
    { name: "Logt 2", type: "T3", area_m2: 48.2 },
    { name: "Logt 3", type: "T3", area_m2: 35 },
  ],
  checks: [], computed_at: "2026-09-23T22:50:00Z",
};

function fresh() {
  const fake = createFakeSupabase();
  const S = loadServer(["getOrComputeScenarioSet"], { supabase: fake.client });
  return { S, fake };
}

test("scénario validé : le moteur (donc le PPT) prend la géométrie validée, pas les anciennes saisies", async () => {
  const { S, fake } = fresh();
  await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  const before = fake.tables.sb_scenarios.find(r => r.scenario === "A");
  const suggestedBefore = JSON.stringify(before.suggested);
  Object.assign(before, { status: "VALIDATED", actual: ACTUAL_A, revision: 1 });
  const r = await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  assert.equal(r.fromStore, false, "la validation change les entrées du moteur");
  const A = r.scenarios.A;
  assert.equal(A.fp_m2, 119, "emprise validée, pas 180 m²");
  assert.equal(A.sdp_m2, 119);
  assert.equal(A.total_units, 3);
  assert.equal(A.unit_mix_detail, "1×COMMERCE(36m²) + 1×T3(48m²) + 1×T3(35m²)", "unités réellement dessinées");
  assert.equal(A.cost_total_fcfa, Math.round(119 * 250000 * 1.05), "coût des travaux de la géométrie validée");
  assert.equal(A._v12_validated, true);
  const ventil = A.cout_ventilation;
  const lots = ventil.gros_oeuvre_fcfa + ventil.second_oeuvre_fcfa + ventil.lots_techniques_fcfa + ventil.amenagements_ext_fcfa + ventil.vrd_fcfa;
  assert.ok(Math.abs(lots - A.cost_total_fcfa) / A.cost_total_fcfa < 0.12, "ventilation recalée sur le nouveau coût");
  assert.notEqual(r.scenarios.B.fp_m2, 112, "B non validé : suggestion BARLO, les saisies de la première configuration sont ignorées");
  const after = fake.tables.sb_scenarios.find(x => x.scenario === "A");
  assert.equal(JSON.stringify(after.suggested), suggestedBefore, "la suggestion BARLO reste intacte");
  assert.equal(after.status, "VALIDATED", "la validation ne se périme pas toute seule");
});

test("relecture : même géométrie validée → résultat relu, identique", async () => {
  const { S, fake } = fresh();
  await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  Object.assign(fake.tables.sb_scenarios.find(r => r.scenario === "A"), { status: "VALIDATED", actual: ACTUAL_A });
  const r1 = await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  const r2 = await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  assert.equal(r2.fromStore, true);
  assert.equal(r2.scenarios.A.sdp_m2, r1.scenarios.A.sdp_m2);
});
