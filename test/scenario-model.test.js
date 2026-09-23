const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../lib/scenario-model");

test("A/B/C portent un rôle explicite", () => {
  assert.equal(M.roleOf("A"), "CLIENT_INTENT");
  assert.equal(M.roleOf("b"), "BALANCED");
  assert.equal(M.roleOf("C"), "PRUDENT");
  assert.throws(() => M.roleOf("D"));
});

test("grille coût/m² de Jeremy", () => {
  assert.equal(M.suggestedCostPerM2("ECONOMIQUE", "CLIENT_INTENT").value, 250000);
  assert.equal(M.suggestedCostPerM2("ECONOMIQUE", "BALANCED").value, 200000);
  assert.equal(M.suggestedCostPerM2("ECONOMIQUE", "PRUDENT").value, 175000);
  assert.equal(M.suggestedCostPerM2("STANDARD", "PRUDENT").value, 275000);
  assert.equal(M.suggestedCostPerM2("HAUT", "BALANCED").value, 450000);
  assert.equal(M.suggestedCostPerM2("CONFORT", "CLIENT_INTENT").value, 500000, "alias CONFORT = HAUT");
  assert.equal(M.suggestedCostPerM2("PREMIUM", "CLIENT_INTENT").source, "BARLO_SUGGESTION");
  assert.equal(M.suggestedCostPerM2("PREMIUM", "BALANCED").source, "HYPOTHESIS", "valeur déduite, pas dictée");
  const unknown = M.suggestedCostPerM2("", "BALANCED");
  assert.equal(unknown.value, null);
  assert.equal(unknown.source, "UNKNOWN");
});

test("une surcharge utilisateur n'est jamais écrasée par la suggestion", () => {
  let ov = M.setOverride({}, "cost_per_m2", 400000, "2026-09-23T10:00:00Z");
  const sugg = M.suggestedCostPerM2("STANDARD", "CLIENT_INTENT");
  assert.deepEqual(M.effective(ov, "cost_per_m2", sugg), { value: 400000, source: "USER_OVERRIDE" });
  ov = M.setOverride(ov, "cost_per_m2", null);
  assert.equal(M.effective(ov, "cost_per_m2", sugg).value, 350000);
  assert.equal(M.effective(ov, "cost_per_m2", sugg).source, "BARLO_SUGGESTION");
  assert.equal(M.effective({}, "x", undefined).source, "UNKNOWN");
});

test("états : une validation devient OUTDATED après modification ou nouvelle suggestion", () => {
  assert.equal(M.statusAfterEdit("SUGGESTED"), "EDITING");
  assert.equal(M.statusAfterEdit("VALIDATED"), "OUTDATED");
  assert.equal(M.statusAfterEdit("ANALYZED"), "OUTDATED");
  assert.equal(M.statusAfterNewSuggestion("ANALYZED"), "OUTDATED");
  assert.equal(M.statusAfterNewSuggestion("EDITING"), "EDITING");
  assert.equal(M.statusAfterNewSuggestion(undefined), "SUGGESTED");
});

test("empreinte des entrées stable quel que soit l'ordre des clés", () => {
  assert.equal(M.hashInputs({ a: 1, b: { c: 2, d: [1, 2] } }), M.hashInputs({ b: { d: [1, 2], c: 2 }, a: 1 }));
  assert.notEqual(M.hashInputs({ a: 1 }), M.hashInputs({ a: 2 }));
});

test("programme lu depuis unit_mix_detail", () => {
  assert.deepEqual(M.parseUnitMixDetail("1×COMMERCE(60m²) + 2×T3(65m²)"), [
    { type: "COMMERCE", count: 1, size_m2: 60 },
    { type: "T3", count: 2, size_m2: 65 },
  ]);
  assert.deepEqual(M.parseUnitMixDetail(""), []);
});

test("suggestion normalisée : COS et CES calculés, rôle posé", () => {
  const s = M.normalizeSuggestion("B", {
    sdp_m2: 180, fp_m2: 90, levels: 2, total_units: 3, unit_mix_detail: "1×COMMERCE(60m²) + 2×T3(55m²)",
    cost_total_fcfa: 37800000, market_cost_per_m2: 200000, layout_mode: "SUPERPOSE",
  }, { site_area: 250 });
  assert.equal(s.role, "BALANCED");
  assert.equal(s.cos.value, 0.72);
  assert.equal(s.ces.value, 0.36);
  assert.equal(s.total_units, 3);
  assert.equal(s.orientation.source, "UNKNOWN", "pas d'orientation inventée");
  const noSite = M.normalizeSuggestion("A", { sdp_m2: 100 }, {});
  assert.equal(noSite.cos.value, null);
  assert.equal(noSite.cos.source, "UNKNOWN");
});
