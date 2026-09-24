const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");

// Relecture du PPT FMM4 (24/09) : chaque test correspond à une erreur réellement trouvée dans le PPT généré
const S = loadServer(["computeSmartScenarios", "scenarioEngineInputs", "enrichFlatForTemplates", "buildTemplateTexts",
  "validateProjectAnalysisV12", "retraitAvantLabel", "cosSolLabel"]);
const FMM4 = "4.0450260,9.6953230|4.0451076,9.6953619|4.0450701,9.6954531|4.0449738,9.6954183|4.0449444,9.6954236|4.0448360,9.6953700|4.0448494,9.6953512";
const LEAD = { site_area: 250, envelope_w: 3, envelope_d: 22, zoning_type: "URBAIN", program_main: "Usage mixte (logement + activité)",
  standing_level: "ECONOMIQUE", layout_mode: "SPLIT_AV_AR", input_typologies: "T1=1", target_units: 3, target_surface_m2: 225,
  feasibility_posture: "CONSERVATIVE", city: "Douala", budget_range: "⭕ 50 000 – 100 000 € (~33–66 M FCFA)", site_polygon: FMM4 };
// A dessiné de plain-pied (1 commerce + 2 T3) et validé, avec des débords sur les retraits
const ROWS = { A: { status: "VALIDATED", actual: { units_count: 3, sdp_m2: 119, sous_sols_m2: 0, emprise_sol_m2: 119, levels_max: 1,
  units: [{ type: "COMMERCE", area_m2: 36, name: "Commerce" }, { type: "T3", area_m2: 48, name: "Logt 2" }, { type: "T3", area_m2: 35, name: "Logt 3" }],
  checks: [["Commerce", 19], ["Logt 2", 13], ["Logt 3", 15]].map(([n, m]) => ({ code: "HORS_ZONE_CONSTRUCTIBLE", level: "error",
    message: `« ${n} » empiète de ${m} m² sur les retraits côté G–A (retrait 3 m) : ajuste la forme` })) } } };

// Même flat que la route /generate-pptx (champs lus par la rédaction)
function render() {
  const sc = S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, {}, null, ROWS));
  const diag = sc.diagnostic, r = diag.retraits_reglementaires || {};
  const flat = { rec_scenario: diag.recommandation.scenario, rec_score: Math.round(diag.recommandation.score * 100),
    retrait_avant: S.retraitAvantLabel(r), retrait_lateral: `${r.lateral_m || 0}m`, retrait_arriere: `${r.arriere_m || 0}m`,
    retrait_mitoyennete: String(r.mitoyennete_cotes || 0), retrait_emprise_constructible: `${r.emprise_constructible_m2 || 0} m²`,
    site_cos_regl: S.cosSolLabel(diag.site), site_emprise_max: `${(diag.site || {}).emprise_max_m2 || 0} m²`, profil_posture: "CONSERVATIVE" };
  for (const k of "ABC") {
    const s = sc[k];
    Object.assign(flat, { [`${k}_fp`]: String(s.fp_m2), [`${k}_levels`]: String(Math.max(0, (s.levels || 1) - 1)), [`${k}_sdp`]: String(s.sdp_m2),
      [`${k}_units`]: String(s.total_units), [`${k}_unit_summary`]: s.unit_mix_detail, [`${k}_has_pilotis`]: String(!!s.has_pilotis),
      [`${k}_cost_total`]: `${Math.round(s.cost_total_fcfa / 1e6)}M FCFA`, [`${k}_cost_m2`]: `${Math.round(s.cost_per_m2_sdp / 1000)}k FCFA/m²`,
      [`${k}_budget_fit`]: s.budget_fit, [`${k}_cos_pct`]: String(s.cos_ratio_pct), [`${k}_cos_compliance`]: s.cos_compliance,
      [`${k}_parking_places`]: String((s.parking_detail || {}).places_disponibles || 0), [`${k}_parking_deficit`]: String((s.parking_detail || {}).deficit || 0),
      [`${k}_cost_unit`]: `${Math.round(s.cost_per_unit / 1e6)}M FCFA`, [`${k}_duree_chantier`]: `${s.duree_chantier_mois} mois` });
  }
  S.enrichFlatForTemplates(flat, LEAD, sc);
  return { sc, t: S.buildTemplateTexts(flat, sc) };
}

test("terrain : la surface du terrain, pas une enveloppe rectangulaire", () => {
  const { t } = render();
  assert.doesNotMatch(t.slide_4_text, /brut|3 × 22|66 m²/);
  assert.match(t.slide_4_text, /sur les 250 m² du terrain, \*\*7\d m²\*\* sont constructibles/);
  assert.match(t.slide_4_text, /réduisent la surface constructible au sol de 7\d %/);
  assert.doesNotMatch(t.slide_3_intro_text, /Enveloppe|0 côtés|economique/);
});

test("scénario de plain-pied décrit comme tel", () => {
  const { t } = render();
  const a = t.scenario_A_summary_text;
  assert.match(a, /de plain-pied/);
  assert.doesNotMatch(a, /aux étages|RDC \+ 0|1 niveaux|INTENSIFICATION/);
  assert.match(a, /dont 36 m² de commerce/);
});

test("surfaces des logements : même critère que le score, commerces exclus", () => {
  const { t } = render();
  for (const k of ["B", "C"]) assert.doesNotMatch(t[`scenario_${k}_risk_text`], /refus de permis|trop exigus/, `${k} cohérent avec le standing`);
  assert.match(t.scenario_A_risk_text, /42 m² en moyenne/, "A : (48 + 35) / 2, sans le commerce");
  assert.match(t.scenario_B_summary_text, /Surface moyenne par logement : 29 m² contre 42 m²/);
});

test("coquilles et renvois fragiles", () => {
  const { t } = render();
  const all = Object.values(t).join("\n");
  assert.doesNotMatch(all, /\/m²\/m²|en slide \d|slide 1\d\)|unité\(s\)|economique|equilibree/);
  assert.match(t.scenario_A_risk_text, /3 unités empiètent sur les retraits/);
});

test("recommandation à égalité : dite, pas « meilleur score »", () => {
  const { sc, t } = render();
  const rec = sc.diagnostic.recommandation.scenario;
  const reco = sc.diagnostic.constats_v12.find(c => c.code === "RECOMMANDATION");
  if (reco.chiffres.egalite_avec.length) {
    assert.doesNotMatch(t.conclusion_positioning_text, /Meilleur score/);
    assert.match(t.conclusion_positioning_text, /à égalité avec/);
  }
  assert.match(t.slide_5_text, new RegExp(`programme de \\*\\*${sc[rec].total_units} unité`), "unités du scénario recommandé");
  assert.deepEqual(S.validateProjectAnalysisV12(t, sc).issues, []);
});

test("A dessiné avec un autre programme : signalé, et B / C présentés comme variantes", () => {
  const { sc, t } = render();
  assert.ok(sc.diagnostic.constats_v12.some(c => c.code === "PROGRAMME_A_DIFFERENT"));
  assert.match(t.scenario_B_summary_text, /variante équilibrée/);
  assert.doesNotMatch(t.scenario_B_summary_text, /conserve le même programme/);
});
