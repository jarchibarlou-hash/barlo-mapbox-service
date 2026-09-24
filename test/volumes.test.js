const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");

const S = loadServer(["computeSmartScenarios", "scenarioEngineInputs"]);
const FMM4 = "4.0450260,9.6953230|4.0451076,9.6953619|4.0450701,9.6954531|4.0449738,9.6954183|4.0449444,9.6954236|4.0448360,9.6953700|4.0448494,9.6953512";
// Cas réel FMM4 : mixte, commerce + T1, volumes séparés demandés, zone constructible de 74 m²
const LEAD = { site_area: 250, envelope_w: 9, envelope_d: 30, zoning_type: "URBAIN", program_main: "Usage mixte (logement + activité)",
  standing_level: "ECONOMIQUE", layout_mode: "SPLIT_AV_AR", input_typologies: "T1=1", target_units: 3, target_surface_m2: 225,
  city: "Douala", budget_range: "⭕ 50 000 – 100 000 € (~33–66 M FCFA)", site_polygon: FMM4 };

test("volumes suggérés : l'emprise au sol reste dans la zone constructible", () => {
  const sc = S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, {}, null, {}));
  for (const l of ["A", "B", "C"]) {
    const s = sc[l], zone = s.sdp_limits_v12.buildable_area;
    assert.ok(zone > 60 && zone < 90, `zone constructible FMM4 ≈ 74 m² (${zone})`);
    assert.ok(s.emprise_sol_m2 <= zone + 0.5, `${l} : emprise ${s.emprise_sol_m2} m² ≤ zone ${zone} m²`);
    assert.ok(!sc.diagnostic.constats_v12.some(c => c.code === "EMPRISE_HORS_ZONE" && c.portee === l), `${l} sans dépassement`);
    const cap = s.fp_rdc_m2 + s.fp_etages_m2 * Math.max(0, s.levels - 1);
    assert.ok(cap >= s.sdp_m2 - 1, `${l} : le volume (${cap} m²) contient la surface de plancher (${s.sdp_m2} m²)`);
  }
});

test("volumes séparés impossibles : commerce au RDC, logements à l'étage, et c'est dit", () => {
  const sc = S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, {}, null, {}));
  assert.equal(sc.B.split_layout, null);
  assert.ok(sc.B.split_refused_v12);
  assert.ok(sc.diagnostic.constats_v12.some(c => c.code === "VOLUMES_SUPERPOSES" && c.portee === "B"));
});

test("écart entre le programme saisi et le besoin déclaré : signalé, pas inventé", () => {
  const sc = S.computeSmartScenarios(S.scenarioEngineInputs(LEAD, {}, null, {}));
  const c = sc.diagnostic.constats_v12.find(x => x.code === "PROGRAMME_ECART_BESOIN");
  assert.ok(c, "constat présent");
  assert.match(c.message, /1 T1 \+ 1 commerce, soit 2 unités/);
  assert.match(c.message, /3 unités, 225 m²/);
  const ok = S.computeSmartScenarios(S.scenarioEngineInputs(Object.assign({}, LEAD, { input_typologies: "T1=2" }), {}, null, {}));
  assert.ok(!ok.diagnostic.constats_v12.some(x => x.code === "PROGRAMME_ECART_BESOIN"), "pas de constat quand le programme couvre le besoin");
});

test("grand terrain : les deux volumes séparés restent possibles", () => {
  const big = Object.assign({}, LEAD, { site_area: 600, envelope_w: 20, envelope_d: 30, site_polygon: "" });
  const sc = S.computeSmartScenarios(S.scenarioEngineInputs(big, {}, null, {}));
  assert.ok(sc.B.split_layout && sc.B.split_layout.mode === "SPLIT_AV_AR");
  assert.ok(sc.B.emprise_sol_m2 <= sc.B.sdp_limits_v12.emprise_max + 0.5);
});
