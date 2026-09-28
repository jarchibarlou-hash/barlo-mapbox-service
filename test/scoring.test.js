const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");
const { createFakeSupabase } = require("./fake-supabase");

// v13 — grille de notation BARLO du 28/09/2026 : 7 critères distincts, échelles continues, conformité exigée
const S = loadServer(["scoreScenariosV12", "pickRecommendedV12", "computeSmartScenarios", "scenarioEngineInputs", "getOrComputeScenarioSet",
  "SCORE_WEIGHTS_V13", "CRITERES_V13"], { supabase: createFakeSupabase().client });
const CTX = { feasibility_posture: "BALANCED", target_units: 4, target_surface_m2: 260, standing_level: "ECONOMIQUE", phase_score: 0,
  budget_range: { min: 60e6, max: 90e6 }, floor_height: 3 };
const sc = o => Object.assign({ budget_fit: "DANS_BUDGET", levels: 2, cos_compliance: "CONFORME", cos_ratio_pct: 60, sdp_m2: 260,
  total_units: 4, cost_total_fcfa: 55e6, budget_needed_fcfa: 55e6, unit_mix_detail: "4×T3(65m²)" }, o);
const geom = o => Object.assign({
  debord: { total_m2: 0, rue_m2: 0, limite_m2: 0, hors_parcelle_m2: 0, pct_emprise: 0, a_corriger: false, facade_aveugle: false, rue_indiquee: true, cotes: [] },
  appui: { etages_m2: 60, porte_a_faux_m2: 0, part_portee: 1 }, niveaux_decales: [], hauteur_min_m: 3, cos_ratio_pct: 60,
  units: [{ type: "T3", area_m2: 65, sdp_m2: 65, floors: 1, start_level: 0 }, { type: "T3", area_m2: 65, sdp_m2: 65, floors: 1, start_level: 1 }],
}, o);
const validated = (g, o) => sc(Object.assign({ _v12_validated: true, geom_v12: g }, o || {}));

test("7 critères, chacun expliqué ; poids de la grille = 100 % pour chaque posture", () => {
  const rr = { A: sc({}), B: sc({}), C: sc({}) };
  S.scoreScenariosV12(rr, CTX);
  const keys = S.CRITERES_V13.map(c => c.key);
  assert.equal(keys.length, 7);
  assert.deepEqual(Object.keys(rr.A.score_detail).filter(k => k !== "total").sort(), [...keys].sort());
  for (const k of keys) assert.ok(rr.A.score_detail[k].explication, `explication ${k}`);
  for (const p of Object.keys(S.SCORE_WEIGHTS_V13)) {
    const sum = Object.values(S.SCORE_WEIGHTS_V13[p]).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `poids ${p} = ${sum}`);
  }
});

test("le score suit le contenu du scénario, jamais sa lettre", () => {
  const X = sc({ budget_fit: "HORS_BUDGET", cost_total_fcfa: 110e6, budget_needed_fcfa: 110e6 });
  const Y = sc({});
  const rr1 = { A: sc({}), B: JSON.parse(JSON.stringify(X)), C: JSON.parse(JSON.stringify(Y)) };
  const rr2 = { A: sc({}), B: JSON.parse(JSON.stringify(Y)), C: JSON.parse(JSON.stringify(X)) };
  S.scoreScenariosV12(rr1, CTX);
  S.scoreScenariosV12(rr2, CTX);
  assert.equal(rr1.B.recommendation_score, rr2.C.recommendation_score, "même contenu, même score");
  assert.equal(rr1.C.recommendation_score, rr2.B.recommendation_score);
  assert.ok(rr1.C.recommendation_score > rr1.B.recommendation_score, "le scénario dans le budget l'emporte");
});

test("échelles continues : un détail de dessin ne fait pas sauter la note", () => {
  const d = pct => validated(geom({ debord: { total_m2: pct, rue_m2: 0, limite_m2: pct, hors_parcelle_m2: 0, pct_emprise: pct, a_corriger: false, facade_aveugle: pct > 2, rue_indiquee: true, cotes: [] } }));
  const rr = { A: d(1.9), B: d(2.0), C: d(2.1) };
  S.scoreScenariosV12(rr, CTX);
  const s = l => rr[l].score_detail.setback_encroachment.score;
  assert.ok(Math.abs(s("A") - s("B")) <= 0.02, `1,9 % → 2,0 % : ${s("A")} / ${s("B")}`);
  // au-delà de la tolérance, la façade doit être aveugle : note plus basse, mais pas d'effondrement
  assert.ok(s("C") < s("B") && s("C") >= 0.6, `2,1 % aveugle : ${s("C")}`);
  const budget = n => { const r = { A: sc({ budget_needed_fcfa: n }) }; S.scoreScenariosV12(r, CTX); return r.A.score_detail.budget_fit.score; };
  assert.ok(Math.abs(budget(89.9e6) - budget(90.1e6)) < 0.02, "haut de fourchette franchi sans saut");
  assert.equal(budget(60e6), 1);
  assert.equal(budget(90e6), 0.6);
  assert.equal(budget(117e6), 0);
});

test("débord côté rue ou hors parcelle : à corriger, jamais recommandé ; côté latéral : légal si façade aveugle", () => {
  const rue = validated(geom({ debord: { total_m2: 12, rue_m2: 12, limite_m2: 0, hors_parcelle_m2: 0, pct_emprise: 9, a_corriger: true, facade_aveugle: false, rue_indiquee: true, cotes: [] } }));
  const aveugle = validated(geom({ debord: { total_m2: 12, rue_m2: 0, limite_m2: 12, hors_parcelle_m2: 0, pct_emprise: 9, a_corriger: false, facade_aveugle: true, rue_indiquee: true, cotes: [{ cote: "B–C", type: "libre", m2: 12 }] } }));
  const net = validated(geom({}));
  const rr = { A: rue, B: aveugle, C: net };
  S.scoreScenariosV12(rr, CTX);
  assert.equal(rr.A.eligible_v13, false);
  assert.match(rr.A.a_corriger_v13[0], /rue/);
  assert.equal(rr.B.eligible_v13, true, "façade aveugle : légal");
  assert.equal(rr.B.facade_aveugle_v13, true);
  assert.match(rr.B.score_detail.setback_encroachment.explication, /aveugle/);
  assert.ok(rr.B.score_detail.setback_encroachment.score < rr.C.score_detail.setback_encroachment.score, "l'aveugle coûte des points");
  // A a le meilleur budget possible mais reste à corriger : il n'est pas recommandé
  rr.A.score_detail.budget_fit.score = 1; rr.A.recommendation_score = 0.99;
  assert.notEqual(S.pickRecommendedV12(rr, "AGGRESSIVE"), "A");
  assert.ok(rr.C.recommandation_v13 || rr.B.recommandation_v13);
});

test("aucun scénario conforme : recommandation sous réserve", () => {
  const rue = () => validated(geom({ debord: { total_m2: 12, rue_m2: 12, limite_m2: 0, hors_parcelle_m2: 0, pct_emprise: 9, a_corriger: true, facade_aveugle: false, rue_indiquee: true, cotes: [] } }));
  const rr = { A: rue(), B: rue(), C: rue() };
  S.scoreScenariosV12(rr, CTX);
  const rec = S.pickRecommendedV12(rr, "BALANCED");
  assert.equal(rr[rec].recommandation_v13.sous_reserve, true);
});

test("COS : au-delà de 102 % à corriger ; 85 % vaut mieux que 99 %", () => {
  const rr = { A: sc({ cos_ratio_pct: 85 }), B: sc({ cos_ratio_pct: 99 }), C: sc({ cos_ratio_pct: 110 }) };
  S.scoreScenariosV12(rr, CTX);
  assert.equal(rr.A.score_detail.cos_conformity.score, 1);
  assert.ok(rr.B.score_detail.cos_conformity.score < 1 && rr.B.eligible_v13);
  assert.equal(rr.C.eligible_v13, false);
});

test("scores proches (< 3 points) : la posture départage ; écart net : le meilleur l'emporte", () => {
  const rr = { A: sc({}), B: sc({}), C: sc({}) };
  S.scoreScenariosV12(rr, CTX);
  assert.equal(S.pickRecommendedV12(rr, "CONSERVATIVE"), "C");
  assert.equal(S.pickRecommendedV12(rr, "AGGRESSIVE"), "A");
  assert.equal(S.pickRecommendedV12(rr, "BALANCED"), "B");
  assert.deepEqual(rr.B.recommandation_v13.proches, ["A", "C"]);
  // A nettement devant (budget 1 contre 0) : il l'emporte même pour une posture prudente
  const rr2 = { A: sc({}), B: sc({ budget_needed_fcfa: 110e6 }), C: sc({ budget_needed_fcfa: 110e6 }) };
  S.scoreScenariosV12(rr2, Object.assign({}, CTX, { feasibility_posture: "CONSERVATIVE" }));
  assert.equal(S.pickRecommendedV12(rr2, "CONSERVATIVE"), "A");
  assert.equal(rr2.A.recommandation_v13.robuste, true, "écart net : choix stable quand chaque poids bouge de 5 points");
});

test("la posture déplace des poids, jamais les notes des critères", () => {
  const rr1 = { A: sc({ budget_needed_fcfa: 80e6 }) }, rr2 = { A: sc({ budget_needed_fcfa: 80e6 }) };
  S.scoreScenariosV12(rr1, CTX);
  S.scoreScenariosV12(rr2, Object.assign({}, CTX, { feasibility_posture: "CONSERVATIVE" }));
  for (const c of S.CRITERES_V13) assert.equal(rr1.A.score_detail[c.key].score, rr2.A.score_detail[c.key].score, c.key);
  assert.notEqual(rr1.A.recommendation_score, rr2.A.recommendation_score);
});

test("critère sans donnée : non noté, son poids est réparti sur les autres", () => {
  const rr = { A: sc({ unit_mix_detail: "2×BUREAU(60m²)" }) };
  S.scoreScenariosV12(rr, CTX);
  const d = rr.A.score_detail;
  assert.equal(d.standing_match.score, null);
  assert.equal(d.standing_match.poids, 0);
  const sum = S.CRITERES_V13.reduce((s, c) => s + d[c.key].poids, 0);
  assert.ok(Math.abs(sum - 1) < 0.005, `poids effectifs ${sum}`);
});

test("structure : porte-à-faux et niveaux décalés font baisser la note ; superposition = à corriger", () => {
  const rr = {
    A: validated(geom({})),
    B: validated(geom({ appui: { etages_m2: 60, porte_a_faux_m2: 12, part_portee: 0.8 }, niveaux_decales: [{ a: "x", b: "y" }] })),
    C: validated(geom({}), { geometry_checks_v12: [{ code: "SUPERPOSITION", level: "error", message: "x" }] }),
  };
  S.scoreScenariosV12(rr, CTX);
  assert.equal(rr.A.score_detail.structure_simplicity.score, 1);
  assert.ok(Math.abs(rr.B.score_detail.structure_simplicity.score - 0.4) < 0.01, `${rr.B.score_detail.structure_simplicity.score}`);
  assert.equal(rr.C.eligible_v13, false);
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
  assert.equal(r1.scenarios.B.score_detail.setback_encroachment.score, 0, "les erreurs de la géométrie validée pèsent");
  assert.equal(r1.scenarios.B.eligible_v13, false);
  assert.notEqual(r1.scenarios.B.recommendation_score, scoreBefore, "score recalculé sur la géométrie validée");
  assert.equal(r1.scenarios.diagnostic.recommandation.scenario === "B", false, "un scénario non conforme n'est pas recommandé");
});
