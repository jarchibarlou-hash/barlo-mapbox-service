const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/site-geometry");

// Rectangle 9 m × 30 m (x vers l'Est, y vers le Nord), sens trigonométrique
const RECT = [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 30 }, { x: 0, y: 30 }];
const FMM4 = "4.0450260,9.6953230|4.0451076,9.6953619|4.0450701,9.6954531|4.0449738,9.6954183|4.0449444,9.6954236|4.0448360,9.6953700|4.0448494,9.6953512";

test("règle de Jeremy : 5 m rue, 3 m ailleurs, 0 m mitoyen", () => {
  assert.deepEqual({ ...G.SETBACK_BY_TYPE }, { rue: 5, libre: 3, fond: 3, mitoyen: 0 });
});

test("zone constructible d'un rectangle, retraits par côté", () => {
  // arêtes : 0 = sud (rue, 5 m), 1 = est (mitoyen, 0), 2 = nord (fond, 3), 3 = ouest (libre, 3)
  const b = G.buildablePolygon(RECT, [5, 0, 3, 3], 0);
  assert.ok(Math.abs(G.polygonArea(b) - (9 - 3) * (30 - 5 - 3)) < 1e-6, "6 m × 22 m = 132 m²");
  const all3 = G.buildablePolygon(RECT, [3, 3, 3, 3], 0);
  assert.ok(Math.abs(G.polygonArea(all3) - 3 * 24) < 1e-6);
  const prudent = G.buildablePolygon(RECT, [5, 0, 3, 3], 1);
  assert.ok(Math.abs(G.polygonArea(prudent) - (9 - 3 - 2) * (30 - 5 - 3 - 2)) < 1e-6, "+1 m sur chaque côté");
});

test("sens de parcours indifférent (horaire ou trigonométrique)", () => {
  const cw = RECT.slice().reverse();
  const b = G.buildablePolygon(cw, [3, 3, 3, 3], 0);
  assert.ok(Math.abs(G.polygonArea(b) - 72) < 1e-6);
});

test("retraits trop grands : zone constructible vide, pas d'erreur", () => {
  assert.deepEqual(G.buildablePolygon(RECT, [5, 5, 5, 5], 0), []);
});

// Référence : échantillonnage des points à distance >= retrait de chaque côté (définition du recul)
// (centres de cellules : pas de biais sur les bords)
function exactArea(parcel, dists, step = 0.1) {
  const xs = parcel.map(p => p.x), ys = parcel.map(p => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const nx = Math.ceil((Math.max(...xs) - x0) / step), ny = Math.ceil((Math.max(...ys) - y0) / step);
  let n = 0;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const pt = { x: x0 + (i + 0.5) * step, y: y0 + (j + 0.5) * step };
      if (G.pointInPolygon(pt, parcel) && parcel.every((a, i) => G.distToSegment(pt, a, parcel[(i + 1) % parcel.length]) >= dists[i])) n++;
    }
  return n * step * step;
}

test("parcelle en L (angle rentrant) : pas de sur-découpe", () => {
  const L = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
  const d = [3, 3, 3, 3, 3, 3];
  const got = G.polygonArea(G.buildablePolygon(L, d, 0));
  const ref = exactArea(L, d);
  assert.ok(got <= ref + 0.5 && got >= ref * 0.97, `onglet ${got.toFixed(1)} vs exact ${ref.toFixed(1)}`);
  assert.ok(G.polygonArea(G.halfPlaneBuildable(L, d)) < got * 0.5, "l'ancienne méthode retirait plus de la moitié");
});

test("parcelle réelle BARLO-FMM4 : aire proche de 250 m², retraits par défaut 3 m", () => {
  const s = G.siteBuildable(FMM4, null, 0);
  assert.equal(s.segments_count, 7);
  assert.ok(Math.abs(s.parcel_area_m2 - 251) <= 3, `aire parcelle ${s.parcel_area_m2}`);
  const parcel = G.toLocalMeters(G.parsePolygon(FMM4));
  const ref = exactArea(parcel, new Array(7).fill(3));
  assert.ok(Math.abs(s.buildable_area_m2 - ref) <= 1.5, `constructible ${s.buildable_area_m2} vs exact ${ref.toFixed(1)}`);
  assert.equal(s.has_street, false, "façade rue non précisée");
  const segs = G.defaultSegments(G.toLocalMeters(G.parsePolygon(FMM4)));
  segs[1].type = "mitoyen"; segs[1].retrait_m = 0;
  const withMit = G.siteBuildable(FMM4, segs, 0);
  assert.ok(withMit.buildable_area_m2 > s.buildable_area_m2, "la mitoyenneté agrandit la zone constructible");
});

test("retraits effectifs : valeur saisie, sinon règle du type", () => {
  const r = G.retraitsFromSegments([{ index: 0, type: "rue" }, { index: 1, type: "mitoyen", retrait_m: 0 }, { index: 2, type: "libre", retrait_m: 4.5 }], 4);
  assert.deepEqual(r, [5, 0, 4.5, 3]);
});
