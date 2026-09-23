const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../lib/scenario-rules");

const SIZE = { T1: 30, T2: 45, T3: 65, T4: 80, T5: 95, COMMERCE: 50 };
const sdpOf = p => (p.logements || []).reduce((s, t) => s + t.count * SIZE[t.type] * 1.15, 0) + (p.commerce || 0) * SIZE.COMMERCE;

test("règles par défaut (Jeremy 23/09) : A intact, B réserve 10 %, C phasé réserve 20 %, sans marge de retrait", () => {
  const { CLIENT_INTENT: A, BALANCED: B, PRUDENT: C } = R.DEFAULT_RULES;
  assert.equal(A.adapt_program, false);
  assert.equal(A.budget_target, null);
  assert.equal(B.adapt_program, true);
  assert.equal(B.adapt_mode, "DOWNGRADE");
  assert.equal(B.budget_target, 0.9);
  assert.equal(C.adapt_mode, "PHASE_2");
  assert.equal(C.budget_target, 0.8);
  assert.equal(C.emprise_usage_max, 0.85);
  assert.equal(C.setback_extra_m, 0, "plus de +1 m : pénalisait les petites parcelles");
  assert.ok(C.levels_cap_delta < 0);
  assert.equal(C.compact, true);
  assert.equal(R.RULES_SOURCE, "HYPOTHESIS");
});

test("COS = occupation au sol par zone : ville 60, périphérie 45, campagne 30", () => {
  assert.equal(R.cosSolForZone("URBAIN").value, 0.60);
  assert.equal(R.cosSolForZone("MIXTE").value, 0.60, "mixte = ville");
  assert.equal(R.cosSolForZone("PERIURBAIN").value, 0.45);
  assert.equal(R.cosSolForZone("PAVILLON").value, 0.45, "pavillonnaire = périphérie");
  assert.equal(R.cosSolForZone("RURAL").value, 0.30);
  const unknown = R.cosSolForZone("");
  assert.equal(unknown.value, 0.60);
  assert.equal(unknown.source, "HYPOTHESIS", "zone inconnue : signalée comme hypothèse");
});

test("limites : la plus contraignante s'impose et est nommée ; plus de plafond de plancher inventé", () => {
  const base = { site_area: 250, ces: 0.6, envelope_w: 12, envelope_d: 18, levels_min: 2, levels_max: 4, cost_per_m2: 200000 };
  const b = R.scenarioSdpLimits(Object.assign({}, base, { rules: R.DEFAULT_RULES.BALANCED, budget_fcfa: 20000000 }));
  assert.equal(b.binding, "budget");
  assert.ok(Math.abs(b.sdp_max - 20000000 * 0.9 / (200000 * 1.05)) < 1e-6, "B garde 10 % de réserve");
  assert.equal(b.reserve_pct, 10);
  assert.equal(b.reserve_fcfa, 2000000);
  assert.deepEqual(Object.keys(b.limits).sort(), ["budget", "capacity"], "pas de limite « COS plancher »");
  const noBudget = R.scenarioSdpLimits(Object.assign({}, base, { rules: R.DEFAULT_RULES.BALANCED, budget_fcfa: 0 }));
  assert.equal(noBudget.limits.budget, Infinity, "budget inconnu : pas de limite inventée");
  assert.equal(noBudget.reserve_pct, null);
  const c = R.scenarioSdpLimits(Object.assign({}, base, { rules: R.DEFAULT_RULES.PRUDENT, budget_fcfa: 0 }));
  assert.equal(c.levels_cap, 3, "plafond de niveaux C = raisonnable − 1");
  assert.ok(Math.abs(c.emprise_max - noBudget.emprise_max * 0.85) < 1e-6, "C : 85 % de l'emprise permise");
  const withBuildable = R.scenarioSdpLimits(Object.assign({}, base, { rules: R.DEFAULT_RULES.BALANCED, buildable_area: 74 }));
  assert.equal(withBuildable.emprise_max, 74, "min(COS 150 m², zone constructible 74 m²)");
  const derog = R.scenarioSdpLimits(Object.assign({}, base, { ces: 0, rules: R.DEFAULT_RULES.BALANCED, buildable_area: 200 }));
  assert.equal(derog.emprise_max, 200, "dérogation COS : seule la zone constructible limite");
  assert.equal(derog.emprise_cos, null);
});

test("C phasé : typologies du client gardées, le reste reporté en phase 2 (jamais « retiré »)", () => {
  const prog = { logements: [{ type: "T3", count: 3 }, { type: "T4", count: 1 }], commerce: 1 };
  const target = sdpOf(prog) - 60;
  const c = R.fitProgram(prog, sdpOf, target, "budget", "PHASE_2");
  assert.ok(!c.adaptations.some(a => a.kind === "DOWNGRADE"), "pas de réduction de typologie en C");
  assert.ok(c.adaptations.every(a => a.kind === "PHASE_2"));
  assert.ok(c.phase_2 && c.phase_2.logements.length > 0, "phase 2 décrite");
  const phase1Units = c.program.logements.reduce((s, t) => s + t.count, 0);
  const phase2Units = c.phase_2.logements.reduce((s, t) => s + t.count, 0);
  assert.equal(phase1Units + phase2Units, 4, "phase 1 + phase 2 = tout le programme du client");
  assert.ok(sdpOf(c.program) <= target);
  const b = R.fitProgram(prog, sdpOf, target, "budget", "DOWNGRADE");
  assert.equal(b.adaptations[0].kind, "DOWNGRADE", "B réduit d'abord les typologies");
  assert.equal(b.phase_2, null);
});

test("programme qui tient : B identique à A (pas plus petit par principe)", () => {
  const prog = { logements: [{ type: "T3", count: 2 }], commerce: 1 };
  const fit = R.fitProgram(prog, sdpOf, 1000, "budget");
  assert.deepEqual(fit.program, prog);
  assert.equal(fit.adaptations.length, 0);
  assert.equal(fit.infeasible, false);
});

test("programme trop grand : on descend d'abord les typologies, puis on retire le moins possible", () => {
  const prog = { logements: [{ type: "T3", count: 2 }, { type: "T4", count: 1 }], commerce: 1 };
  const target = sdpOf(prog) - 20;
  const fit = R.fitProgram(prog, sdpOf, target, "budget");
  assert.equal(fit.adaptations[0].kind, "DOWNGRADE");
  assert.equal(fit.adaptations[0].from, "T4");
  assert.equal(fit.program.logements.reduce((s, t) => s + t.count, 0), 3, "nombre d'unités préservé");
  assert.ok(sdpOf(fit.program) <= target);
  const tight = R.fitProgram(prog, sdpOf, 150, "COS");
  assert.ok(tight.adaptations.some(a => a.kind === "REMOVE_UNIT"));
  assert.ok(tight.adaptations.every(a => a.reason === "COS"));
  assert.ok(sdpOf(tight.program) <= 150);
  assert.equal(tight.program.commerce, 1, "le commerce demandé est gardé tant que possible");
});

test("chaque logement ne descend que d'une typologie", () => {
  const fit = R.fitProgram({ logements: [{ type: "T4", count: 1 }], commerce: 0 }, sdpOf, 10, "budget");
  assert.ok(!fit.adaptations.some(a => a.from === "T3"), "pas de T4 → T3 → T2");
  assert.equal(fit.infeasible, true, "impossible signalé, pas masqué");
});
