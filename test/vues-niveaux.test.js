const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/site-geometry");
const { loadServer } = require("./harness");

// v13.8 (Jeremy 16/10/2026) : « le R+1 a l'air de flotter au-dessus du RDC » — niveau vide signalé,
// dalles visibles en 3D. v13.9 : « garder le point de vue par défaut et ajouter à la présentation les
// autres points de vue que je coche » (diagonales + nord).
const S = loadServer(["generateMultiUnitMassingHTML", "cleanViewBearings", "massingImagePaths", "extraViewUrls", "withExtraViews"]);
const sq = (cx, cy, h) => [{ x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h }];
const codes = a => a.checks.map(c => c.code);

test("niveau vide : un R+1 laissé vide sous des unités au R+2 est signalé", () => {
  const vide = G.scenarioActual([
    { unit_name: "Boutique", unit_type: "COMMERCE", polygon: sq(0, 0, 4) },
    { unit_name: "Meublé", unit_type: "T2", polygon: sq(0, 0, 4), niveau_depart_etage: 2 },
  ], {});
  const w = vide.checks.find(c => c.code === "NIVEAU_VIDE");
  assert.ok(w, "alerte niveau vide");
  assert.equal(w.level, "warning");
  assert.equal(w.level_index, 1);
  assert.match(w.message, /Aucune unité au R\+1/);
  assert.match(w.message, /niveau de départ » à 1/);

  const pose = G.scenarioActual([
    { unit_name: "Boutique", unit_type: "COMMERCE", polygon: sq(0, 0, 4) },
    { unit_name: "Meublé", unit_type: "T2", polygon: sq(0, 0, 4), niveau_depart_etage: 1 },
  ], {});
  assert.ok(!codes(pose).includes("NIVEAU_VIDE"), "R+1 posé sur le RDC : rien à signaler");

  // une unité de 2 niveaux (RDC + R+1) occupe bien le R+1
  const duplex = G.scenarioActual([
    { unit_name: "Duplex", unit_type: "T4", polygon: sq(0, 0, 4), etages_unit: 1 },
    { unit_name: "Studio", unit_type: "T1", polygon: sq(0, 0, 4), niveau_depart_etage: 2 },
  ], {});
  assert.ok(!codes(duplex).includes("NIVEAU_VIDE"));

  // les poteaux d'une unité sur pilotis occupent le niveau sous elle
  const pilotis = G.scenarioActual([
    { unit_name: "Boutique", unit_type: "COMMERCE", polygon: sq(0, 0, 4) },
    { unit_name: "Logement", unit_type: "T3", polygon: sq(0, 0, 4), niveau_depart_etage: 1, pilotis: true },
  ], {});
  assert.ok(!codes(pilotis).includes("NIVEAU_VIDE"));
});

test("3D : une dalle à chaque plancher, rien pour une unité de plain-pied au sol", () => {
  const poly = [{ lat: 4.045, lon: 9.695 }, { lat: 4.045, lon: 9.6951 }, { lat: 4.0451, lon: 9.6951 }];
  const units = [
    { id: 1, name: "Boutique", type: "COMMERCE", polygonGeo: poly, baseM: 0, topM: 3, groundM: 0, floors: 1, colorHex: "#E07830" },
    { id: 2, name: "Meublé", type: "T2", polygonGeo: poly, baseM: 3, topM: 9, groundM: 3, floors: 2, colorHex: "#3A7AC0" },
  ];
  const html = S.generateMultiUnitMassingHTML({ lat: 4.045, lon: 9.695 }, 18.5, 0, poly, units, "pk.test", null, null, {});
  const m = html.match(/addSource\('unit-slabs', \{ type: 'geojson', data: (\{.*?\}) \}\);/);
  assert.ok(m, "source des dalles présente");
  const slabs = JSON.parse(m[1]).features;
  assert.equal(slabs.length, 2, "Meublé : dalle sous lui (3 m) et entre ses 2 niveaux (6 m) ; Boutique : aucune");
  assert.deepEqual(slabs.map(f => [f.properties.base, f.properties.height]), [[2.85, 3.15], [5.85, 6.15]]);
  assert.match(html, /id: 'units-slabs'/);
  // repère de vue et rotation de caméra disponibles (vue opposée)
  assert.match(html, /drawViewBadge\(0\)/);
  assert.match(html, /window\.__setView = function/);
  assert.match(html, /m\.type === 'set-view'/);
});

test("points de vue : seuls les caps prévus, nom de l'image principale, retrouvés pour le PPT", () => {
  // caps acceptés : depuis le sud-ouest 45, nord-ouest 135, nord 180, nord-est 225, sud-est 315
  assert.deepEqual(S.cleanViewBearings([315, "45", 45, 0, 90, 180, null]), [45, 180, 315]);
  assert.deepEqual(S.cleanViewBearings("45"), []);

  const p = S.massingImagePaths("BARLO-T", "A", 1792000000000, [45, 180]);
  assert.equal(p.main, "hektar/BARLO-T/scenario_A_massing_multi_1792000000000_vues-045-180.png");
  assert.deepEqual(p.extra.map(e => e.path), [
    "hektar/BARLO-T/scenario_A_massing_multi_1792000000000_vue-045.png",
    "hektar/BARLO-T/scenario_A_massing_multi_1792000000000_vue-180.png",
  ]);
  assert.equal(S.massingImagePaths("BARLO-T", "B", 5, []).main, "hektar/BARLO-T/scenario_B_massing_multi_5.png");

  const host = "https://x.supabase.co/storage/v1/object/public/massing-images/";
  const main = host + p.main;
  assert.deepEqual(S.extraViewUrls(main), [
    { bearing: 45, url: host + p.extra[0].path },
    { bearing: 180, url: host + p.extra[1].path },
  ]);
  assert.deepEqual(S.extraViewUrls(host + "hektar/BARLO-T/scenario_A_massing_multi_5.png"), [], "aucune vue cochée");
  assert.deepEqual(S.extraViewUrls(host + "hektar/BARLO-T/scenario_A_massing_multi_5_opposee.png"), [], "essai v13.8 ignoré");

  const imgs = S.withExtraViews({ scenario_A_massing: main, scenario_B_massing: "https://x/autre.png", slide_4_image: "https://x/s4.png" });
  assert.equal(imgs.scenario_A_massing_vue_045, host + p.extra[0].path);
  assert.equal(imgs.scenario_A_massing_vue_180, host + p.extra[1].path);
  assert.ok(!Object.keys(imgs).some(k => k.startsWith("scenario_B_massing_vue_")));
  assert.equal(Object.keys(imgs).length, 5);
  assert.deepEqual(S.withExtraViews(undefined), {});
});
