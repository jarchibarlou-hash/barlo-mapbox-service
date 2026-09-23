// BARLO v12 — Règles de rôle des scénarios (A intention client, B équilibre, C prudence).
// Décision de Jeremy (23/09/2026) : B et C diffèrent d'abord par le coût/m² (qui détermine le
// programme finançable), puis par des marges : COS, emprise maximale, retraits renforcés, plafond
// de niveaux, configuration compacte si plus économique. Un scénario n'est réduit que si une
// contrainte l'impose ; chaque adaptation est tracée avec sa raison.
// Les valeurs numériques ci-dessous sont des HYPOTHÈSES BARLO (valeurs par défaut modifiables),
// jamais présentées comme des faits.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BarloScenarioRules = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TYPO_ORDER = ["T1", "T2", "T3", "T4", "T5"];

  // adapt_program     : le programme du client peut être adapté pour respecter les limites
  // cos_usage_max     : part du COS réglementaire utilisable (1 = 100 %)
  // emprise_usage_max : part de l'emprise constructible utilisable
  // setback_extra_m   : retrait supplémentaire sur chaque côté de l'enveloppe
  // levels_cap_delta  : écart appliqué au nombre de niveaux raisonnable du programme
  // budget_target     : part du budget client visée (null = budget non contraignant)
  // compact           : volume unique compact (pas de programme scindé en deux volumes)
  const DEFAULT_RULES = Object.freeze({
    CLIENT_INTENT: Object.freeze({ adapt_program: false, cos_usage_max: 1, emprise_usage_max: 1, setback_extra_m: 0, levels_cap_delta: 0, budget_target: null, compact: false }),
    BALANCED:      Object.freeze({ adapt_program: true,  cos_usage_max: 1, emprise_usage_max: 1, setback_extra_m: 0, levels_cap_delta: 0, budget_target: 1, compact: false }),
    PRUDENT:       Object.freeze({ adapt_program: true,  cos_usage_max: 0.85, emprise_usage_max: 0.85, setback_extra_m: 1, levels_cap_delta: -1, budget_target: 0.9, compact: true }),
  });
  const RULES_SOURCE = "HYPOTHESIS";
  const RULES_NOTE = "Valeurs par défaut BARLO (hypothèses), modifiables par lead";

  // Surface de plancher maximale du scénario selon chaque contrainte ; la plus basse s'impose.
  function scenarioSdpLimits(o) {
    const r = o.rules;
    const setback = Math.max(0, Number(r.setback_extra_m) || 0);
    const envW = Math.max(0, (Number(o.envelope_w) || 0) - 2 * setback);
    const envD = Math.max(0, (Number(o.envelope_d) || 0) - 2 * setback);
    const empriseCes = (Number(o.ces) || 0) * (Number(o.site_area) || 0);
    const empriseEnv = envW * envD * 0.85;
    // Emprise maximale saisie par l'utilisateur (contrainte du lead) : un plafond, jamais une cible
    const empriseUser = Number(o.max_fp) > 0 ? Number(o.max_fp) : Infinity;
    const empriseMax = Math.max(0, Math.min(empriseCes, empriseEnv, empriseUser)) * (Number(r.emprise_usage_max) || 1);
    const levelsCap = Math.max(Number(o.levels_min) || 1, (Number(o.levels_max) || 1) + (Number(r.levels_cap_delta) || 0));
    const limits = {
      cos: o.cos_regl > 0 && o.site_area > 0 ? o.cos_regl * o.site_area * (Number(r.cos_usage_max) || 1) : Infinity,
      capacity: empriseMax > 0 ? empriseMax * levelsCap : Infinity,
      budget: (r.budget_target && o.budget_fcfa > 0 && o.cost_per_m2 > 0)
        ? (o.budget_fcfa * r.budget_target) / (o.cost_per_m2 * 1.05) : Infinity,
    };
    let binding = null, sdpMax = Infinity;
    for (const k of Object.keys(limits)) if (limits[k] < sdpMax) { sdpMax = limits[k]; binding = k; }
    return { sdp_max: sdpMax, binding, limits, emprise_max: empriseMax, levels_cap: levelsCap };
  }

  // Adapte le programme pour tenir sous sdpMax, en préservant d'abord le nombre d'unités :
  // 1) chaque logement peut descendre d'une typologie au plus (T4 → T3), du plus grand au plus petit ;
  // 2) puis retrait d'un logement : le plus petit qui suffit, sinon le plus grand ;
  // 3) puis retrait d'un commerce au-delà du premier.
  // sdpOf(program) calcule la SDP d'un programme { logements:[{type,count}], commerce }.
  function fitProgram(program, sdpOf, sdpMax, reason) {
    const units = [];
    for (const t of program.logements || []) for (let i = 0; i < (Number(t.count) || 0); i++) units.push({ orig: t.type, cur: t.type });
    let commerce = Number(program.commerce) || 0;
    const adaptations = [];
    const toProgram = () => {
      const counts = {};
      for (const u of units) counts[u.cur] = (counts[u.cur] || 0) + 1;
      return {
        logements: Object.keys(counts).sort((a, b) => TYPO_ORDER.indexOf(a) - TYPO_ORDER.indexOf(b)).map(type => ({ type, count: counts[type] })),
        commerce,
      };
    };
    let guard = 0;
    while (sdpOf(toProgram()) > sdpMax + 1e-6 && guard++ < 100) {
      const downgradable = units
        .filter(u => u.cur === u.orig && TYPO_ORDER.indexOf(u.cur) > 1)
        .sort((a, b) => TYPO_ORDER.indexOf(b.cur) - TYPO_ORDER.indexOf(a.cur));
      if (downgradable.length) {
        const u = downgradable[0];
        const to = TYPO_ORDER[TYPO_ORDER.indexOf(u.cur) - 1];
        adaptations.push({ kind: "DOWNGRADE", from: u.cur, to, reason });
        u.cur = to;
        continue;
      }
      if (units.length > 1) {
        const gap = sdpOf(toProgram()) - sdpMax;
        const bySize = units.map((u, i) => ({ i, size: sdpOf({ logements: [{ type: u.cur, count: 1 }], commerce: 0 }) }))
          .sort((a, b) => a.size - b.size);
        const pick = bySize.find(x => x.size >= gap) || bySize[bySize.length - 1];
        const removed = units.splice(pick.i, 1)[0];
        adaptations.push({ kind: "REMOVE_UNIT", type: removed.cur, reason });
        continue;
      }
      if (commerce > 1) {
        commerce -= 1;
        adaptations.push({ kind: "REMOVE_COMMERCE", reason });
        continue;
      }
      break;
    }
    const out = toProgram();
    return { program: out, adaptations, infeasible: sdpOf(out) > sdpMax + 1e-6 };
  }

  return { TYPO_ORDER, DEFAULT_RULES, RULES_SOURCE, RULES_NOTE, scenarioSdpLimits, fitProgram };
});
