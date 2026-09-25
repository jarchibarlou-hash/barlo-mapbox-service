const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const { loadServer } = require("./harness");

// v12.22 — masquage des bâtiments voisins : validé une fois pour le terrain, relu à chaque image 3D
const S = loadServer(["cleanMassingMask", "generateMultiUnitMassingHTML"]);
const parcel = [{ lat: 4.05, lon: 9.7 }, { lat: 4.0501, lon: 9.7 }, { lat: 4.0501, lon: 9.7001 }, { lat: 4.05, lon: 9.7001 }];
const units = [{ id: 1, name: "Co-working", type: "BUREAU", polygonGeo: parcel, baseM: 3, topM: 6, groundM: 3, postsGeo: [], labelText: "Co-working\nR+1", floors: 1 }];
const page = (opts) => S.generateMultiUnitMassingHTML({ lat: 4.05005, lon: 9.70005 }, 20, 0, parcel, units, "pk.test", null, null, opts);

test("masquage nettoyé : centres valides seulement", () => {
  const m = S.cleanMassingMask({ hidden: [{ lat: 4.05, lon: 9.7, area_m2: 80.4 }, { lat: "x", lon: 1 }, null], visible: "n'importe quoi" });
  assert.deepEqual(m, { hidden: [{ lat: 4.05, lon: 9.7, area_m2: 80 }], visible: [] });
  assert.equal(S.cleanMassingMask(null), null);
});

test("page 3D : aperçu cliquable, image finale sans numéros, masquage validé embarqué", () => {
  const mask = { hidden: [], visible: [{ lat: 4.05004, lon: 9.70004, area_m2: 20 }] };
  for (const preview of [true, false]) {
    const html = page({ mask, preview });
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new vm.Script(script));
    assert.ok(html.includes(`const PREVIEW = ${preview};`));
    assert.ok(html.includes('"visible":[{"lat":4.05004'));
  }
  // les numéros de bâtiments ne sont ajoutés qu'en aperçu (condition PREVIEW dans la page)
  assert.match(page({ preview: false }), /if \(PREVIEW\) \{\s*const labelFc/);
});
