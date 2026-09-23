const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/site-geometry");

// Parcelle réelle BARLO-FMM4 (251 m², zone constructible 74 m² avec 3 m partout)
const FMM4 = "4.0450260,9.6953230|4.0451076,9.6953619|4.0450701,9.6954531|4.0449738,9.6954183|4.0449444,9.6954236|4.0448360,9.6953700|4.0448494,9.6953512";
const buildable = G.siteBuildable(FMM4, null, 0).buildable;
const cx = buildable.reduce((s, p) => s + p.x, 0) / buildable.length;
const cy = buildable.reduce((s, p) => s + p.y, 0) / buildable.length;
const square = (x, y, s) => [{ x: x - s / 2, y: y - s / 2 }, { x: x + s / 2, y: y - s / 2 }, { x: x + s / 2, y: y + s / 2 }, { x: x - s / 2, y: y + s / 2 }];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg} : ${a} au lieu de ~${b}`);
const ctx = { site_polygon: FMM4, segments: null, site_area: 250, cos_sol: 0.6 };

test("unité dans la zone constructible : SDP = surface × niveaux, pilotis non comptés", () => {
  // (la zone constructible de FMM4 est une bande étroite : unité de 2 m × 2 m au centre)
  const a = G.scenarioActual([{ unit_name: "T3", unit_type: "T3", polygon: square(cx, cy, 2), etages_unit: 2, pilotis: true }], ctx);
  assert.equal(a.units_count, 1);
  near(a.units[0].area_m2, 4, 0.1, "surface");
  assert.equal(a.units[0].floors, 3, "R+2 = 3 niveaux");
  near(a.sdp_m2, 12, 0.5, "SDP");
  near(a.emprise_sol_m2, 4, 0.3, "emprise au sol");
  assert.equal(a.levels_max, 4, "pilotis (1 niveau de poteaux) + 3 niveaux");
  assert.equal(a.checks.filter(c => c.level === "error").length, 0);
});

test("unité qui dépasse les retraits : débord mesuré et signalé", () => {
  const a = G.scenarioActual([{ unit_name: "Commerce", unit_type: "COMMERCE", polygon: square(cx, cy, 14) }], ctx);
  assert.ok(a.outside_buildable_m2 > 50, `débord ${a.outside_buildable_m2} m²`);
  assert.ok(a.checks.some(c => c.code === "HORS_ZONE_CONSTRUCTIBLE"));
});

test("superposition au même niveau signalée ; unités empilées sur des niveaux différents acceptées", () => {
  const same = G.scenarioActual([
    { unit_name: "A", unit_type: "T2", polygon: square(cx, cy, 4) },
    { unit_name: "B", unit_type: "T2", polygon: square(cx + 2, cy, 4) },
  ], ctx);
  assert.equal(same.overlaps.length, 1);
  near(same.overlaps[0].m2, 8, 1, "8 m² en commun");
  near(same.emprise_sol_m2, 24, 1, "emprise = union, pas la somme");
  const stacked = G.scenarioActual([
    { unit_name: "Commerce", unit_type: "COMMERCE", polygon: square(cx, cy, 4), etages_unit: 0 },
    { unit_name: "T3 étage", unit_type: "T3", polygon: square(cx, cy, 4), etages_unit: 0, niveau_depart_etage: 1 },
  ], ctx);
  assert.equal(stacked.overlaps.length, 0, "commerce au RDC, logement au-dessus : pas de conflit");
  near(stacked.sdp_m2, 32, 1, "2 niveaux de 16 m²");
  near(stacked.emprise_sol_m2, 16, 1);
});

test("COS dépassé signalé ; sous-sols comptés à part", () => {
  const big = G.scenarioActual([{ unit_name: "Bloc", unit_type: "T4", polygon: square(cx, cy, 13), sous_sols: 1 }], Object.assign({}, ctx, { cos_sol: 0.3 }));
  near(big.emprise_sol_m2, 169, 2, "emprise");
  assert.ok(big.checks.some(c => c.code === "COS_DEPASSE"), "169 m² > 30 % de 250 m²");
  near(big.sous_sols_m2, 169, 2, "sous-sol");
  near(big.sdp_m2, 169, 2, "le sous-sol n'entre pas dans la SDP");
});
