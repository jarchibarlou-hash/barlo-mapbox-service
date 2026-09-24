const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");

const S = loadServer(["computeSmartScenarios", "scenarioEngineInputs", "enrichFlatForTemplates", "buildTemplateTexts", "validateProjectAnalysisV12"]);
const FMM4 = "4.0450260,9.6953230|4.0451076,9.6953619|4.0450701,9.6954531|4.0449738,9.6954183|4.0449444,9.6954236|4.0448360,9.6953700|4.0448494,9.6953512";
// Cas FMM4 : scénario A validé avec des unités qui empiètent sur les retraits → A non conforme
const LEAD = { site_area: 250, envelope_w: 9, envelope_d: 30, zoning_type: "URBAIN", program_main: "Usage mixte (logement + activité)",
  standing_level: "ECONOMIQUE", layout_mode: "SPLIT_AV_AR", input_typologies: "T1=1", target_units: 3, city: "Douala",
  budget_range: "⭕ 50 000 – 100 000 € (~33–66 M FCFA)", site_polygon: FMM4 };
const ROWS = { A: { status: "VALIDATED", actual: {
  units_count: 3, sdp_m2: 119, sous_sols_m2: 0, emprise_sol_m2: 119, levels_max: 1,
  units: [{ type: "COMMERCE", area_m2: 36 }, { type: "T3", area_m2: 48 }, { type: "T3", area_m2: 35 }],
  checks: [{ code: "HORS_ZONE_CONSTRUCTIBLE", level: "error", message: "« Commerce » empiète de 19 m² sur les retraits côté G–A (retrait 3 m) : ajuste la forme" }],
} } };

function texts(lead) {
  const sc = S.computeSmartScenarios(S.scenarioEngineInputs(lead, {}, null, ROWS));
  const flat = { rec_scenario: sc.diagnostic.recommandation.scenario };
  S.enrichFlatForTemplates(flat, lead, sc);
  return { sc, flat, texts: S.buildTemplateTexts(flat, sc) };
}

test("constats : faits vérifiés, triés du bloquant à l'info", () => {
  const { sc } = texts(LEAD);
  const c = sc.diagnostic.constats_v12;
  assert.ok(c.length > 0);
  assert.ok(c.some(x => x.code === "HORS_ZONE_CONSTRUCTIBLE" && x.portee === "A"), "A empiète sur les retraits");
  assert.ok(c.some(x => x.code === "FACADE_RUE_NON_INDIQUEE"));
  const ordre = { bloquant: 0, attention: 1, atout: 2, info: 3 };
  for (let i = 1; i < c.length; i++) assert.ok(ordre[c[i - 1].niveau] <= ordre[c[i].niveau], "tri par gravité");
});

test("rédaction : aucune affirmation contredite par les constats, aucune donnée manquante", () => {
  const { texts: t, flat } = texts(LEAD);
  const gate = S.validateProjectAnalysisV12(t, texts(LEAD).sc);
  assert.deepEqual(gate.issues, [], JSON.stringify(gate.issues));
  assert.doesNotMatch(t.slide_5_text, /Quartier dense|voirie irrégulière/, "rien d'inventé sur le quartier");
  assert.match(t.slide_5_text, /Aucune mitoyenneté indiquée/, "pas de « mitoyenneté sur 0 côtés »");
  assert.match(t.slide_4_text, /irrégulière à 7 côtés/, "forme réelle de la parcelle");
  assert.doesNotMatch(t.strategic_arbitrage_text, /arbitrage est rentable/);
  assert.doesNotMatch(t.invisible_financial_text + t.success_financial_text, /5 ?(à|-) ?8 ?%/);
  assert.equal(flat.site_nb_cotes, "7");
});

test("contrôle final : une affirmation contraire aux constats est détectée", () => {
  const { sc } = texts(LEAD);
  const rec = sc.diagnostic.recommandation.scenario;
  const gate = S.validateProjectAnalysisV12({ conclusion_positioning_text: "Pourquoi ? Conformité urbanistique solide et budget maîtrisé.", x: "Coût undefined" }, sc);
  assert.ok(gate.issues.some(i => i.key === "x"), "donnée manquante détectée");
  if (!sc[rec].score_detail || sc[rec].score_detail.cos_conformity.score < 0.5) {
    assert.ok(gate.issues.some(i => /conformité/.test(i.message)), "conformité affirmée à tort détectée");
  }
});
