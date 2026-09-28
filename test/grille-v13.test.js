const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/site-geometry");

// v13 — mesures de la grille de notation sur une parcelle carrée de 20 m × 20 m
// côtés : 0 = sud (SO → SE), 1 = est, 2 = nord, 3 = ouest ; retraits 3 m, 5 m côté rue
const lat0 = 4.05, lon0 = 9.7, dLat = 10 / 111320, dLon = 10 / (111320 * Math.cos(lat0 * Math.PI / 180));
const PARCELLE = [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([sy, sx]) => `${(lat0 + sy * dLat).toFixed(8)},${(lon0 + sx * dLon).toFixed(8)}`).join("|");
const RUE_SUD = [{ index: 0, type: "rue", retrait_m: 5 }, { index: 1, type: "libre", retrait_m: 3 }, { index: 2, type: "fond", retrait_m: 3 }, { index: 3, type: "libre", retrait_m: 3 }];
const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const ctx = segments => ({ site_polygon: PARCELLE, segments, site_area: 400, cos_sol: 0.6 });
const codes = a => a.checks.map(c => `${c.level}:${c.code}`);

test("débord côté rue : à corriger, même avec une façade aveugle", () => {
  const a = G.scenarioActual([{ unit_name: "Commerce", unit_type: "COMMERCE", polygon: rect(-3, -8, 3, -2) }], ctx(RUE_SUD));
  assert.equal(a.debord.a_corriger, true);
  assert.ok(a.debord.rue_m2 > 15, `débord rue ${a.debord.rue_m2}`);
  assert.ok(codes(a).includes("error:HORS_ZONE_CONSTRUCTIBLE"));
});

test("débord sur un côté latéral : légal si la façade reste aveugle, signalé comme tel", () => {
  const a = G.scenarioActual([{ unit_name: "Logement", unit_type: "T3", polygon: rect(2, -2, 9, 4) }], ctx(RUE_SUD));
  assert.equal(a.debord.a_corriger, false);
  assert.equal(a.debord.facade_aveugle, true);
  assert.ok(Math.abs(a.debord.limite_m2 - 12) < 0.6, `débord ${a.debord.limite_m2}`);
  assert.ok(codes(a).includes("warning:FACADE_AVEUGLE"));
  assert.ok(!codes(a).some(c => c.startsWith("error:")));
  assert.match(a.checks.find(c => c.code === "FACADE_AVEUGLE").message, /aveugle/);
});

test("côté rue non indiqué : un débord ne peut pas être déclaré légal", () => {
  const a = G.scenarioActual([{ unit_name: "Logement", unit_type: "T3", polygon: rect(2, -2, 9, 4) }], ctx(null));
  assert.equal(a.debord.a_corriger, true);
  assert.equal(a.debord.rue_indiquee, false);
  assert.match(a.checks.find(c => c.code === "HORS_ZONE_CONSTRUCTIBLE").message, /indique le côté rue/);
});

test("débord minime : dans la tolérance de dessin de 2 %, ni erreur ni façade aveugle", () => {
  const a = G.scenarioActual([{ unit_name: "Logement", unit_type: "T3", polygon: rect(0, 0, 7.1, 6) }], ctx(RUE_SUD));
  assert.ok(a.debord.pct_emprise > 0 && a.debord.pct_emprise <= 2, `${a.debord.pct_emprise} %`);
  assert.equal(a.debord.a_corriger, false);
  assert.equal(a.debord.facade_aveugle, false);
  assert.deepEqual(codes(a), ["info:DEBORD_TOLERE"]);
});

test("étage plus grand que le rez-de-chaussée : porte-à-faux mesuré ; pilotis : structure prévue", () => {
  const pf = G.scenarioActual([
    { unit_name: "RDC", unit_type: "BUREAU", polygon: rect(-2, -2, 2, 2) },
    { unit_name: "Étage", unit_type: "T3", polygon: rect(-2, -2, 4, 2), niveau_depart_etage: 1 },
  ], ctx(RUE_SUD));
  assert.ok(Math.abs(pf.appui.part_portee - 16 / 24) < 0.03, `part portée ${pf.appui.part_portee}`);
  assert.ok(codes(pf).includes("warning:PORTE_A_FAUX"));
  const pil = G.scenarioActual([{ unit_name: "Logement", unit_type: "T3", polygon: rect(-2, -2, 2, 2), pilotis: true }], ctx(RUE_SUD));
  assert.equal(pil.appui.part_portee, 1);
});

test("unités empilées avec des hauteurs d'étage différentes : niveaux décalés signalés", () => {
  const a = G.scenarioActual([
    { unit_name: "Cabinet", unit_type: "BUREAU", polygon: rect(-2, -2, 2, 2), hauteur_niveau: 3 },
    { unit_name: "Logement", unit_type: "T3", polygon: rect(-2, -2, 2, 2), niveau_depart_etage: 1, hauteur_niveau: 3.5 },
  ], ctx(RUE_SUD));
  assert.equal(a.niveaux_decales.length, 1);
  assert.ok(codes(a).includes("warning:NIVEAUX_DECALES"));
  assert.equal(a.hauteur_min_m, 3);
  assert.equal(a.geometry_version, 13);
});
