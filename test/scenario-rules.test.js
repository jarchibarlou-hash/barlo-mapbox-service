const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../lib/scenario-rules");

const SIZE = { T1: 30, T2: 45, T3: 65, T4: 80, T5: 95, COMMERCE: 50 };
const sdpOf = p => (p.logements || []).reduce((s, t) => s + t.count * SIZE[t.type] * 1.15, 0) + (p.commerce || 0) * SIZE.COMMERCE;

test("règles par défaut : A n'adapte jamais, B et C oui ; C prend des marges", () => {
  assert.equal(R.DEFAULT_RULES.CLIENT_INTENT.adapt_program, false);
  assert.equal(R.DEFAULT_RULES.BALANCED.adapt_program, true);
  assert.ok(R.DEFAULT_RULES.PRUDENT.cos_usage_max < 1);
  assert.ok(R.DEFAULT_RULES.PRUDENT.levels_cap_delta < 0);
  assert.equal(R.DEFAULT_RULES.PRUDENT.compact, true);
  assert.equal(R.RULES_SOURCE, "HYPOTHESIS");
});

test("limites : la plus contraignante s'impose et est nommée", () => {
  const base = { site_area: 250, ces: 0.6, cos_regl: 2.5, envelope_w: 12, envelope_d: 18, levels_min: 2, levels_max: 4, cost_per_m2: 200000 };
  const b = R.scenarioSdpLimits(Object.assign({}, base, { rules: R.DEFAULT_RULES.BALANCED, budget_fcfa: 20000000 }));
  assert.equal(b.binding, "budget");
  assert.ok(Math.abs(b.sdp_max - 20000000 / (200000 * 1.05)) < 1e-6);
  const noBudget = R.scenarioSdpLimits(Object.assign({}, base, { rules: R.DEFAULT_RULES.BALANCED, budget_fcfa: 0 }));
  assert.equal(noBudget.limits.budget, Infinity, "budget inconnu : pas de limite inventée");
  const c = R.scenarioSdpLimits(Object.assign({}, base, { rules: R.DEFAULT_RULES.PRUDENT, budget_fcfa: 0 }));
  assert.equal(c.levels_cap, 3, "plafond de niveaux C = raisonnable − 1");
  assert.ok(c.emprise_max < noBudget.emprise_max, "retraits renforcés + marge d'emprise");
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
