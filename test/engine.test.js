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

const units = sc => (sc.client_program_v12 ? null : null, sc.total_units);

test("même programme dans A, B, C : B optimise les surfaces, le prix suit", () => {
  const lead = Object.assign({}, LEAD, { budget_range: "" });
  const r = S.computeSmartScenarios(S.scenarioEngineInputs(lead, {}));
  assert.deepEqual(r.B.unit_mix, r.A.unit_mix, "mêmes unités (nombre et types)");
  assert.deepEqual(r.C.unit_mix, r.A.unit_mix, "C aussi, quand rien ne l'oblige à phaser");
  assert.match(r.A.unit_mix_detail, /T3\(65m²\)/, "A : grille économique");
  assert.match(r.B.unit_mix_detail, /T3\(59m²\)/, "B : T3 −10 %");
  assert.match(r.C.unit_mix_detail, /T3\(52m²\)/, "C : T3 −20 %");
  assert.match(r.C.unit_mix_detail, /COMMERCE\(50m²\)/, "commerce inchangé");
  assert.equal(r.B.adaptations_v12.length, 0);
  assert.ok(r.A.cost_total_fcfa > r.B.cost_total_fcfa && r.B.cost_total_fcfa > r.C.cost_total_fcfa, "A > B > C en coût");
  assert.equal(r.B.budget_gap_pct, null, "budget inconnu : aucun écart inventé");
});

test("budget serré : A et B gardent tout le programme et affichent l'écart ; C phase le reste", () => {
  const lead = Object.assign({}, LEAD, { budget_range: "40 000 - 50 000 €", input_typologies: "T3=3, T4=1, COMMERCE=1", target_units: 5 });
  const r = S.computeSmartScenarios(S.scenarioEngineInputs(lead, {}));
  assert.equal(r.A.total_units, 5);
  assert.equal(r.B.total_units, 5, "B ne supprime plus d'unités");
  assert.equal(r.A.adaptations_v12.length, 0);
  assert.equal(r.B.adaptations_v12.length, 0);
  assert.equal(r.B.budget_fit, "HORS_BUDGET", "l'écart est affiché, pas masqué");
  assert.ok(r.B.budget_gap_pct > 0);
  assert.equal(r.B.budget_needed_fcfa, Math.round(r.B.cost_total_fcfa / 0.9), "besoin = coût, réserve 10 % comprise");
  assert.ok(r.C.adaptations_v12.length > 0 && r.C.adaptations_v12.every(a => a.kind === "PHASE_2"));
  assert.equal(r.C.budget_fit, "DANS_BUDGET", "phase 1 de C dans le budget, réserve 20 % comprise");
  const phase1 = r.C.total_units, phase2 = r.C.phase_2_v12.logements.reduce((s, t) => s + t.count, 0) + (r.C.phase_2_v12.commerce || 0);
  assert.equal(phase1 + phase2, 5, "phase 1 + phase 2 = tout le programme");
});

test("fourchette large : C finance sa phase 1 au bas de la fourchette, budgétise la phase 2 et le coût final", () => {
  const lead = Object.assign({}, LEAD, { budget_range: "⭕ 50 000 – 100 000 € (~33–66 M FCFA)", input_typologies: "T3=3, T4=1, COMMERCE=1", target_units: 5 });
  const r = S.computeSmartScenarios(S.scenarioEngineInputs(lead, {}));
  assert.equal(r.C.budget_min_fcfa, 33e6);
  assert.equal(r.C.budget_max_fcfa, 66e6);
  assert.ok(r.C.budget_needed_fcfa <= 33e6, "phase 1 finançable même au bas de la fourchette");
  assert.equal(r.C.budget_fit, "DANS_BUDGET");
  assert.ok(r.C.phase_2_v12.cost_fcfa > 0, "phase 2 chiffrée");
  assert.equal(r.C.cost_final_fcfa, r.C.cost_total_fcfa + r.C.phase_2_v12.cost_fcfa, "coût final = phase 1 + phase 2");
  const wide = S.computeSmartScenarios(S.scenarioEngineInputs(Object.assign({}, lead, { budget_range: "⭕ 100 000 – 200 000 € (~66–131 M FCFA)" }), {}));
  assert.equal(wide.A.budget_fit, "BUDGET_TENDU", "96 M dans 66–131 M : haut de fourchette, pas « dans le budget »");
  assert.equal(wide.B.budget_fit, "BUDGET_TENDU");
});

test("programme impossible même phasé → signalé, jamais masqué", () => {
  const lead = Object.assign({}, LEAD, { budget_range: "10 000 - 20 000 €", input_typologies: "T3=3, T4=1, COMMERCE=1", target_units: 5 });
  const r = S.computeSmartScenarios(S.scenarioEngineInputs(lead, {}));
  assert.equal(r.C.infeasible_v12, true, "même la plus petite phase 1 dépasse le budget");
  assert.equal(r.A.infeasible_v12, false, "A n'est pas dimensionné sur le budget");
  assert.equal(r.B.budget_fit, "HORS_BUDGET");
});

test("règles de rôle : C respecte son plafond de niveaux ; dérogation COS respectée", () => {
  const lead = Object.assign({}, LEAD, { input_typologies: "T3=6, COMMERCE=1", target_units: 7, budget_range: "" });
  const r = S.computeSmartScenarios(S.scenarioEngineInputs(lead, {}));
  assert.ok(r.C.levels <= r.C.sdp_limits_v12.levels_cap, "niveaux C ≤ plafond");
  assert.ok(r.C.sdp_limits_v12.levels_cap <= r.A.sdp_limits_v12.levels_cap);
  assert.equal(r.B.sdp_limits_v12.cos_sol, 0.60, "COS ville = 60 % d'occupation au sol");
  const withDerog = S.computeSmartScenarios(S.scenarioEngineInputs(Object.assign({}, lead, { override_ignore_cos: "Y" }), {}));
  assert.equal(withDerog.B.sdp_limits_v12.cos_sol, null, "COS levé sur dérogation");
  assert.equal(withDerog.B.sdp_limits_v12.emprise_cos, null);
});

test("COS = occupation au sol : conformité calculée sur l'emprise, zone campagne à 30 %", () => {
  const r = S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, {}));
  for (const k of ["A", "B", "C"]) {
    const sc = r[k];
    const allowed = 0.60 * 250;
    assert.equal(sc.cos_ratio_pct, Math.round(sc.emprise_sol_m2 / allowed * 100), `${k} : % de l'emprise permise`);
    assert.equal(sc.cos_compliance, sc.emprise_sol_m2 <= allowed ? "CONFORME" : "AMBITIEUX_HORS_COS");
  }
  assert.equal(r.diagnostic.site.cos_sol_pct, 60);
  const rural = S.computeSmartScenarios(S.scenarioEngineInputs(Object.assign({}, LEAD, { zoning_type: "RURAL" }), {}));
  assert.equal(rural.diagnostic.site.cos_sol_pct, 30);
  assert.equal(rural.B.sdp_limits_v12.cos_sol, 0.30);
});

test("mitoyenneté jamais supposée ; retraits 5/3 m dans toutes les zones", () => {
  for (const zone of ["URBAIN", "PERIURBAIN", "RURAL"]) {
    const r = S.computeSmartScenarios(S.scenarioEngineInputs(Object.assign({}, LEAD, { zoning_type: zone }), {}));
    const retr = r.diagnostic.retraits_reglementaires;
    assert.equal(retr.mitoyennete_cotes, 0, `${zone} : pas de mitoyenneté sans indication`);
    assert.deepEqual([retr.avant_m, retr.lateral_m, retr.arriere_m], [5, 3, 3], `${zone} : 5/3/3 m`);
  }
});

test("C phasé : ce qui ne tient pas est reporté en phase 2, avec la réserve de 20 %", () => {
  const lead = Object.assign({}, LEAD, { budget_range: "40 000 - 50 000 €", input_typologies: "T3=3, T4=1, COMMERCE=1", target_units: 5 });
  const r = S.computeSmartScenarios(S.scenarioEngineInputs(lead, {}));
  assert.equal(r.C.sdp_limits_v12.reserve_pct, 20);
  assert.equal(r.B.sdp_limits_v12.reserve_pct, 10);
  assert.equal(r.A.sdp_limits_v12.reserve_pct, null, "A : pas de réserve, l'écart au budget est affiché");
  if (r.C.adaptations_v12.length) {
    assert.ok(r.C.adaptations_v12.every(a => a.kind === "PHASE_2"), "C reporte, ne réduit pas");
    assert.ok(r.C.phase_2_v12 && r.C.phase_2_v12.sdp_m2 > 0);
  }
});

test("emprise max saisie = plafond : jamais d'emprise agrandie ni de ratios fixes par lettre", () => {
  const lead = Object.assign({}, LEAD, { input_typologies: "T1=1", target_units: 1, budget_range: "",
    override_max_fp_m2: "150", override_lateral_hug: "EAST", override_lateral_gap_m: "3" });
  const inputs = S.scenarioEngineInputs(lead, {});
  const r = S.computeSmartScenarios(inputs);
  S.applyScenarioOverrides(r, lead);
  for (const k of ["A", "B", "C"]) {
    assert.ok(r[k].sdp_m2 < 150, `${k} : SDP du petit programme, pas gonflée à 150 m² × niveaux`);
    assert.ok(!r[k].fp_capped_by_constraint, `${k} : ancien plafond à ratios fixes non appliqué`);
  }
  const tight = S.computeSmartScenarios(S.scenarioEngineInputs(Object.assign({}, LEAD, { override_max_fp_m2: "40" }), {}));
  assert.ok(tight.B.sdp_limits_v12.emprise_max <= 40, "le plafond saisi réduit l'emprise disponible");
});

test("le moteur est déterministe (condition de la relecture du résultat enregistré)", () => {
  const a = JSON.stringify(S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, {})));
  const b = JSON.stringify(S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, {})));
  assert.equal(a, b);
});
