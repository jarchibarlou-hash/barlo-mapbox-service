const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");
const { createFakeSupabase } = require("./fake-supabase");

// Lead réel BARLO-FMM4 (parcelle à 7 côtés, 251 m², un angle rentrant)
const LEAD = {
  lead_id: "TEST-SITE", site_area: 250, envelope_w: 9, envelope_d: 30, zoning_type: "URBAIN",
  program_main: "Usage mixte (logement + activité)", target_units: 2, input_typologies: "T1=1, COMMERCE=1",
  standing_level: "STANDARD", layout_mode: "SUPERPOSE",
  site_polygon: "4.0450260,9.6953230|4.0451076,9.6953619|4.0450701,9.6954531|4.0449738,9.6954183|4.0449444,9.6954236|4.0448360,9.6953700|4.0448494,9.6953512",
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg} : ${a} au lieu de ~${b}`);

function fresh() {
  const fake = createFakeSupabase();
  const S = loadServer(["getOrComputeScenarioSet", "cleanSiteSegments"], { supabase: fake.client });
  return { S, fake };
}

test("sans réglage : règle 3 m partout sur la vraie parcelle, C avec +1 m", async () => {
  const { S } = fresh();
  const r = await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  const A = r.scenarios.A.sdp_limits_v12, C = r.scenarios.C.sdp_limits_v12;
  assert.equal(A.emprise_source, "PARCELLE_RETRAITS");
  near(A.buildable_area, 74, 1, "zone constructible A");
  near(C.buildable_area, 35, 1, "zone constructible C (retraits +1 m)");
  assert.equal(r.site.source, "BARLO_RULE");
  assert.equal(r.site.has_street, false, "façade rue à préciser");
});

test("retraits réglés dans le cockpit : pris par le moteur, recalcul déclenché", async () => {
  const { S, fake } = fresh();
  await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  const segs = S.cleanSiteSegments([
    { type: "libre" }, { type: "mitoyen" }, { type: "libre" }, { type: "libre" },
    { type: "libre" }, { type: "libre" }, { type: "libre" },
  ]);
  assert.equal(segs[1].retrait_m, 0, "mitoyen : 0 m par défaut");
  assert.equal(segs[0].retrait_m, 3, "libre : 3 m par défaut");
  fake.tables.sb_lead_rules = [{ lead_ref: "TEST-SITE", rules: { segments: segs } }];
  const r = await S.getOrComputeScenarioSet(Object.assign({}, LEAD));
  assert.equal(r.fromStore, false, "les retraits font partie des entrées du moteur");
  near(r.scenarios.A.sdp_limits_v12.buildable_area, 89, 1, "zone constructible avec mitoyenneté");
  assert.equal(r.site.source, "USER_OVERRIDE");
});

test("validation des retraits : type inconnu ou valeur absurde refusés", () => {
  const { S } = fresh();
  assert.throws(() => S.cleanSiteSegments([{ type: "rue" }, { type: "voisin" }, { type: "libre" }]), /type de côté inconnu/);
  assert.throws(() => S.cleanSiteSegments([{ type: "rue", retrait_m: -1 }, { type: "libre" }, { type: "libre" }]), /entre 0 et 50/);
  assert.equal(S.cleanSiteSegments([{ type: "rue" }, { type: "libre" }, { type: "fond" }])[0].retrait_m, 5, "rue : 5 m");
});

test("lead sans polygone : ancienne estimation par enveloppe, signalée comme telle", async () => {
  const { S } = fresh();
  const p = Object.assign({}, LEAD, { lead_id: "TEST-NOPOLY" });
  delete p.site_polygon;
  const r = await S.getOrComputeScenarioSet(p);
  assert.equal(r.scenarios.A.sdp_limits_v12.emprise_source, "ENVELOPPE_ESTIMEE");
  assert.equal(r.site, null);
});
