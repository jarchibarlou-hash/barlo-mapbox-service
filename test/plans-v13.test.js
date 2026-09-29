const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const G = require("../lib/site-geometry");
const { loadServer, sansInsecables } = require("./harness");

// v13.1 — planche plan du RDC + axonométrie + coupe, et programme par unité sur la slide volumétrie
const S = loadServer(["buildPlansV13", "computeSmartScenarios", "scenarioEngineInputs", "buildTemplateTexts"]);
const FMM4 = "4.0450260,9.6953230|4.0451076,9.6953619|4.0450701,9.6954531|4.0449738,9.6954183|4.0449444,9.6954236|4.0448360,9.6953700|4.0448494,9.6953512";
const sq = [{ x: -3, y: -3 }, { x: 3, y: -3 }, { x: 3, y: 3 }, { x: -3, y: 3 }];
const segments = Array.from({ length: 7 }, (_, i) => ({ index: i, type: i === 1 ? "rue" : "libre", retrait_m: i === 1 ? 5 : 3 }));

test("planche : parcelle, zone constructible, côtés et altitudes des unités (même calcul que la 3D)", () => {
  const units = { A: [
    { type: "BUREAU", name: "Cabinet", polygon: sq },
    { type: "T2", name: "Logement", polygon: sq, niveau_depart_etage: 1, hauteur_niveau: 3.5, etages_unit: 1 },
    { type: "T3", name: "Pilotis", polygon: sq, pilotis: true },
  ], B: [{ type: "T3", name: "Ancien", polygon: [{ x_m: 0, y_m: 0 }, { x_m: 1, y_m: 0 }, { x_m: 1, y_m: 1 }] }], C: [] };
  const p = S.buildPlansV13(FMM4, segments, units);
  assert.ok(p.A && !p.B && !p.C, "B (ancien format de polygone) et C (vide) gardent l'ancien plan");
  assert.equal(p.A.parcel.length, 7);
  assert.ok(p.A.buildable.length >= 3);
  assert.equal(p.A.sides[1].type, "rue");
  assert.equal(p.A.sides[1].retrait_m, 5);
  const [cab, log, pil] = p.A.units;
  assert.deepEqual([cab.base_m, cab.top_m, cab.start_level], [0, 3, 0]);
  assert.deepEqual([log.ground_m, log.base_m, log.top_m, log.start_level, log.floors], [3.5, 3.5, 10.5, 1, 2]);
  assert.deepEqual([pil.ground_m, pil.base_m, pil.top_m, pil.start_level], [0, 3, 6, 1]);
  assert.equal(cab.color, "#8B5CF6");
});

test("slide volumétrie : une ligne par unité dessinée, avec son nom et son niveau", () => {
  const body = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "ppt_fmm4", "body.json"), "utf8"));
  const lead = Object.assign({}, body, { lead_id: "T" });
  const mk = (n, t, lv) => ({ unit_name: n, unit_type: t, polygon: sq, etages_unit: 0, niveau_depart_etage: lv });
  const actual = G.scenarioActual([mk("Cabinet médical", "COMMERCE", 0), mk("Co-working", "BUREAU", 1)], { site_polygon: FMM4, site_area: 250, cos_sol: 0.6 });
  const sc = S.computeSmartScenarios(S.scenarioEngineInputs(lead, {}, null, { A: { actual } }));
  const flat = { rec_scenario: sc.diagnostic.recommandation.scenario, A_sdp: String(sc.A.sdp_m2), A_units: "2", A_levels: "1" };
  const t = sansInsecables(S.buildTemplateTexts(flat, sc));
  const txt = t.scenario_A_summary_text || "";
  assert.match(txt, /\*\*Cabinet médical\*\* · RDC · \*\*36 m²\*\*/);
  assert.match(txt, /\*\*Co-working\*\* · R\+1/);
  assert.ok(txt.indexOf("Cabinet médical") < txt.indexOf("Co-working"), "rangées du RDC vers les étages");
});
