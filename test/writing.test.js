const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");

const S = loadServer(["computeSmartScenarios", "scenarioEngineInputs", "enrichFlatForTemplates", "buildTemplateTexts", "validateProjectAnalysisV12"]);
const FMM4 = "4.0450260,9.6953230|4.0451076,9.6953619|4.0450701,9.6954531|4.0449738,9.6954183|4.0449444,9.6954236|4.0448360,9.6953700|4.0448494,9.6953512";
// Cas FMM4 : anciennes saisies (A 180 m², B 112 m²) hors zone constructible → A et B non conformes
const LEAD = { site_area: 250, envelope_w: 9, envelope_d: 30, zoning_type: "URBAIN", program_main: "Usage mixte (logement + activité)",
  standing_level: "ECONOMIQUE", layout_mode: "SPLIT_AV_AR", input_typologies: "T1=1", target_units: 3, city: "Douala",
  budget_range: "⭕ 50 000 – 100 000 € (~33–66 M FCFA)", site_polygon: FMM4,
  override_fp_A: "180", override_levels_A: "1", override_units_A: "3", override_fp_B: "112", override_levels_B: "1", override_units_B: "3" };

function texts(lead) {
  const sc = S.computeSmartScenarios(S.scenarioEngineInputs(lead, {}));
  const flat = { rec_scenario: sc.diagnostic.recommandation.scenario };
  S.enrichFlatForTemplates(flat, lead, sc);
  return { sc, flat, texts: S.buildTemplateTexts(flat, sc) };
}

test("constats : faits vérifiés, triés du bloquant à l'info", () => {
  const { sc } = texts(LEAD);
  const c = sc.diagnostic.constats_v12;
  assert.ok(c.length > 0);
  assert.ok(c.some(x => x.code === "EMPRISE_HORS_ZONE" && x.portee === "A"), "A hors zone constructible");
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
  const { sc } = texts(Object.assign({}, LEAD, { override_fp_C: "200", override_levels_C: "1", override_units_C: "3" }));
  const rec = sc.diagnostic.recommandation.scenario;
  const gate = S.validateProjectAnalysisV12({ conclusion_positioning_text: "Pourquoi ? Conformité urbanistique solide et budget maîtrisé.", x: "Coût undefined" }, sc);
  assert.ok(gate.issues.some(i => i.key === "x"), "donnée manquante détectée");
  if (!sc[rec].score_detail || sc[rec].score_detail.cos_conformity.score < 0.5) {
    assert.ok(gate.issues.some(i => /conformité/.test(i.message)), "conformité affirmée à tort détectée");
  }
});
