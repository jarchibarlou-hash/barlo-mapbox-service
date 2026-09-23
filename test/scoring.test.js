const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");
const { createFakeSupabase } = require("./fake-supabase");

const S = loadServer(["scoreScenariosV12", "pickRecommendedV12", "computeSmartScenarios", "scenarioEngineInputs", "getOrComputeScenarioSet"],
  { supabase: createFakeSupabase().client });
const CTX = { feasibility_posture: "BALANCED", target_units: 4, standing_level: "ECONOMIQUE", phase_score: 0 };
const sc = o => Object.assign({ budget_fit: "DANS_BUDGET", levels: 2, cos_compliance: "CONFORME", cos_ratio_pct: 60,
  total_units: 4, cost_total_fcfa: 80e6, unit_mix_detail: "4×T3(65m²)" }, o);

test("le score suit le contenu du scénario, jamais sa lettre", () => {
  // A (programme du client) fixe : il définit la tension budgétaire ; on échange B et C
  const X = sc({ budget_fit: "HORS_BUDGET", levels: 5, cost_total_fcfa: 120e6 });
  const Y = sc({});
  const A = () => sc({ budget_fit: "BUDGET_TENDU", cost_total_fcfa: 100e6 });
  const rr1 = { A: A(), B: JSON.parse(JSON.stringify(X)), C: JSON.parse(JSON.stringify(Y)) };
  const rr2 = { A: A(), B: JSON.parse(JSON.stringify(Y)), C: JSON.parse(JSON.stringify(X)) };
  S.scoreScenariosV12(rr1, CTX);
  S.scoreScenariosV12(rr2, CTX);
  assert.equal(rr1.B.recommendation_score, rr2.C.recommendation_score, "même contenu, même score, quelle que soit la lettre");
  assert.equal(rr1.C.recommendation_score, rr2.B.recommendation_score);
  assert.ok(rr1.C.recommendation_score > rr1.B.recommendation_score, "le scénario dans le budget et moins haut l'emporte");
  assert.equal(Object.keys(rr1.B.score_detail).length, 8, "7 critères + total");
  for (const k of Object.keys(rr1.B.score_detail).filter(k => k !== "total")) assert.ok(rr1.B.score_detail[k].explication, `explication ${k}`);
});

test("géométrie validée avec erreurs : conformité basse, expliquée", () => {
  const rr = { A: sc({ _v12_validated: true, geometry_checks_v12: [{ level: "error", code: "HORS_ZONE_CONSTRUCTIBLE", message: "x" }] }), B: sc({}), C: sc({}) };
  S.scoreScenariosV12(rr, CTX);
  assert.equal(rr.A.score_detail.cos_conformity.score, 0.1);
  assert.match(rr.A.score_detail.cos_conformity.explication, /geometrie validee/);
  assert.equal(rr.B.score_detail.cos_conformity.score, 1);
});

test("égalité : la posture du client départage, pas l'ordre alphabétique", () => {
  const rr = { A: sc({}), B: sc({}), C: sc({}) };
  for (const k of ["A", "B", "C"]) rr[k].recommendation_score = 0.9;
  assert.equal(S.pickRecommendedV12(rr, "CONSERVATIVE"), "C");
  assert.equal(S.pickRecommendedV12(rr, "AGGRESSIVE"), "A");
  assert.equal(S.pickRecommendedV12(rr, "BALANCED"), "B");
  assert.equal(rr.B.recommended, true);
});

test("recommandation du moteur : suit le budget réel (serré → C ; confortable → pas C d'office)", () => {
  const base = { lead_id: "T", site_area: 250, envelope_w: 12, envelope_d: 18, zoning_type: "URBAIN", program_main: "Usage mixte (logement + activité)",
    standing_level: "ECONOMIQUE", layout_mode: "SUPERPOSE", input_typologies: "T3=3, T4=1, COMMERCE=1", target_units: 5, feasibility_posture: "BALANCED" };
  const tight = S.computeSmartScenarios(S.scenarioEngineInputs(Object.assign({}, base, { budget_range: "40 000 - 50 000 €" }), {}));
  assert.equal(tight.diagnostic.recommandation.scenario, "C");
  const rich = S.computeSmartScenarios(S.scenarioEngineInputs(Object.assign({}, base, { budget_range: "⭕ 200 000 – 300 000 € (~131–197 M FCFA)" }), {}));
  assert.notEqual(rich.diagnostic.recommandation.scenario, "C", "budget confortable : le programme complet n'est pas écarté");
  assert.equal(rich.A.recommended || rich.B.recommended || rich.C.recommended, true);
});

test("scénario validé : le score et la recommandation sont recalculés sur la géométrie validée", async () => {
  const fake = createFakeSupabase();
  const S2 = loadServer(["getOrComputeScenarioSet"], { supabase: fake.client });
  const lead = { lead_id: "TEST-SCORE", site_area: 250, envelope_w: 12, envelope_d: 18, zoning_type: "URBAIN", program_main: "Usage mixte (logement + activité)",
    standing_level: "ECONOMIQUE", layout_mode: "SUPERPOSE", input_typologies: "T3=3, COMMERCE=1", target_units: 4, feasibility_posture: "BALANCED",
    budget_range: "⭕ 200 000 – 300 000 € (~131–197 M FCFA)" };
  const r0 = await S2.getOrComputeScenarioSet(Object.assign({}, lead));
  const scoreBefore = r0.scenarios.B.recommendation_score;
  Object.assign(fake.tables.sb_scenarios.find(x => x.scenario === "B"), { status: "VALIDATED", actual: {
    units_count: 4, sdp_m2: 400, sous_sols_m2: 0, emprise_sol_m2: 200, levels_max: 2,
    units: [{ type: "COMMERCE", area_m2: 100 }, { type: "T3", area_m2: 100 }, { type: "T3", area_m2: 100 }, { type: "T3", area_m2: 100 }],
    checks: [{ code: "HORS_ZONE_CONSTRUCTIBLE", level: "error", message: "« T3 » empiète de 40 m² sur les retraits" }],
  } });
  const r1 = await S2.getOrComputeScenarioSet(Object.assign({}, lead));
  assert.equal(r1.scenarios.B.score_detail.cos_conformity.score, 0.1, "les erreurs de la géométrie validée pèsent");
  assert.notEqual(r1.scenarios.B.recommendation_score, scoreBefore, "score recalculé sur la géométrie validée");
  assert.equal(r1.scenarios.diagnostic.recommandation.scenario === "B", false, "un scénario non conforme n'est pas recommandé");
});
