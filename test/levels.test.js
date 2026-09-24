const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/site-geometry");

// v12.19 — Cas Lafortune : une entité par niveau, empilées (médical RDC, avocat R+1, coworking R+2, logement R+3)
const sq = [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 8 }, { x: 0, y: 8 }];
const pile = (etages) => ["Médical", "Avocat", "Coworking", "Logement"].map((n, i) =>
  ({ unit_name: n, unit_type: i === 3 ? "T2" : "BUREAU", polygon: sq, etages_unit: etages, niveau_depart_etage: i, hauteur_niveau: 3 }));

test("unités d'un niveau empilées par niveau de départ : pas de superposition, SDP = somme", () => {
  const a = G.scenarioActual(pile(0), { site_area: 250 });
  assert.equal(a.sdp_m2, 224);
  assert.equal(a.levels_max, 4);
  assert.ok(!a.checks.some(c => c.code === "SUPERPOSITION"));
  assert.equal(a.emprise_sol_m2, 56, "emprise = une seule fois la surface au sol");
});

test("unités de 2 niveaux empilées tous les niveaux : chevauchement signalé et SDP doublée", () => {
  const b = G.scenarioActual(pile(1), { site_area: 250 });
  assert.equal(b.sdp_m2, 448);
  assert.ok(b.checks.some(c => c.code === "SUPERPOSITION"));
});

test("niveau de départ : même hauteur d'étage → niveaux alignés", () => {
  assert.equal(G.unitStartLevel({ niveau_depart_etage: 2, hauteur_niveau: 3 }), 2);
  assert.equal(G.unitStartLevel({ altitude_base_m: 6, hauteur_niveau: 3 }), 2);
  assert.equal(G.unitFloors({ etages_unit: 0 }), 1);
  assert.equal(G.unitFloors({}), 1, "vide = un seul niveau");
});
