// BARLO v12 — Règles de rôle des scénarios (A intention client, B équilibre, C prudence).
// Décisions de Jeremy (23/09/2026) :
// - B et C diffèrent d'abord par le coût/m² (grille par standing), qui détermine le programme
//   finançable ; puis par des marges qui répondent chacune à un risque réel.
// - COS = OCCUPATION AU SOL (emprise / parcelle) : 60 % en ville, 45 % en périphérie, 30 % à la
//   campagne. Il n'y a pas de plafond de surface de plancher totale.
// - B = tout le programme maintenant, dans le budget, avec la réserve pour imprévus standard (10 %) ;
//   si ça ne tient pas, typologies réduites d'un cran avant de retirer des unités.
// - C = le même projet sécurisé et phasé : réserve renforcée (20 %), 85 % du COS, un niveau de moins
//   en phase 1, volume compact ; ce qui ne tient pas est REPORTÉ EN PHASE 2 (typologies du client
//   gardées), jamais « retiré ». Pas de marge de retrait ajoutée (pénalisait les petites parcelles).
// Les valeurs numériques restent des HYPOTHÈSES BARLO (modifiables par lead), jamais des faits.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BarloScenarioRules = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TYPO_ORDER = ["T1", "T2", "T3", "T4", "T5"];

  // COS (occupation au sol) par zone. Mixte = ville, pavillonnaire = périphérie (Jeremy, 23/09).
  const COS_SOL_BY_ZONE = Object.freeze({ URBAIN: 0.60, MIXTE: 0.60, PERIURBAIN: 0.45, PAVILLON: 0.45, RURAL: 0.30 });
  const ZONE_LABEL_FR = Object.freeze({ URBAIN: "ville", MIXTE: "ville", PERIURBAIN: "périphérie", PAVILLON: "périphérie", RURAL: "campagne" });
  // Zone non renseignée ou inconnue : ville (défaut du moteur), signalée comme hypothèse
  function cosSolForZone(zone) {
    const z = String(zone || "").toUpperCase();
    if (z in COS_SOL_BY_ZONE) return { value: COS_SOL_BY_ZONE[z], source: "REGULATORY_RULE", zone: ZONE_LABEL_FR[z] };
    return { value: COS_SOL_BY_ZONE.URBAIN, source: "HYPOTHESIS", zone: "ville (zone non renseignée)" };
  }

  // adapt_program     : le programme du client peut être adapté pour respecter les limites
  // adapt_mode        : DOWNGRADE (typologies d'un cran, puis retrait) | PHASE_2 (report en phase 2)
  // emprise_usage_max : part de l'emprise permise utilisée (COS au sol et zone constructible)
  // setback_extra_m   : retrait supplémentaire sur chaque côté (0 par défaut, réglable par lead)
  // levels_cap_delta  : écart appliqué au nombre de niveaux raisonnable du programme
  // budget_target     : part du budget visée, le reste = réserve pour imprévus (null = non contraignant)
  // compact           : volume unique compact (pas de programme scindé en deux volumes)
  const DEFAULT_RULES = Object.freeze({
    CLIENT_INTENT: Object.freeze({ adapt_program: false, adapt_mode: null,        emprise_usage_max: 1,    setback_extra_m: 0, levels_cap_delta: 0,  budget_target: null, compact: false }),
    BALANCED:      Object.freeze({ adapt_program: true,  adapt_mode: "DOWNGRADE", emprise_usage_max: 1,    setback_extra_m: 0, levels_cap_delta: 0,  budget_target: 0.9,  compact: false }),
    PRUDENT:       Object.freeze({ adapt_program: true,  adapt_mode: "PHASE_2",   emprise_usage_max: 0.85, setback_extra_m: 0, levels_cap_delta: -1, budget_target: 0.8,  compact: true }),
  });
  const RULES_SOURCE = "HYPOTHESIS";
  const RULES_NOTE = "Valeurs par défaut BARLO (hypothèses), modifiables par lead";

  // Surface de plancher maximale du scénario selon chaque contrainte ; la plus basse s'impose.
  // o.ces          : COS au sol (0 = plafond levé par dérogation assumée)
  // o.buildable_area : zone constructible réelle (parcelle − retraits par côté, cf. lib/site-geometry.js).
  //                  À défaut, ancienne estimation par enveloppe l × p.
  function scenarioSdpLimits(o) {
    const r = o.rules;
    const setback = Math.max(0, Number(r.setback_extra_m) || 0);
    const hasBuildable = o.buildable_area !== undefined && o.buildable_area !== null && isFinite(Number(o.buildable_area));
    const envW = Math.max(0, (Number(o.envelope_w) || 0) - 2 * setback);
    const envD = Math.max(0, (Number(o.envelope_d) || 0) - 2 * setback);
    const empriseCos = Number(o.ces) > 0 ? Number(o.ces) * (Number(o.site_area) || 0) : Infinity;
    const empriseEnv = hasBuildable ? Math.max(0, Number(o.buildable_area)) : envW * envD * 0.85;
    // Emprise maximale saisie par l'utilisateur (contrainte du lead) : un plafond, jamais une cible
    const empriseUser = Number(o.max_fp) > 0 ? Number(o.max_fp) : Infinity;
    const empriseMax = Math.max(0, Math.min(empriseCos, empriseEnv, empriseUser)) * (Number(r.emprise_usage_max) || 1);
    const levelsCap = Math.max(Number(o.levels_min) || 1, (Number(o.levels_max) || 1) + (Number(r.levels_cap_delta) || 0));
    const budgetKnown = !!(r.budget_target && o.budget_fcfa > 0 && o.cost_per_m2 > 0);
    const limits = {
      capacity: empriseMax > 0 ? empriseMax * levelsCap : Infinity,
      budget: budgetKnown ? (o.budget_fcfa * r.budget_target) / (o.cost_per_m2 * 1.05) : Infinity,
    };
    let binding = null, sdpMax = Infinity;
    for (const k of Object.keys(limits)) if (limits[k] < sdpMax) { sdpMax = limits[k]; binding = k; }
    return {
      sdp_max: sdpMax, binding, limits, emprise_max: empriseMax, levels_cap: levelsCap,
      emprise_cos: isFinite(empriseCos) ? Math.round(empriseCos) : null,
      buildable_area: hasBuildable ? Math.round(empriseEnv) : null,
      emprise_source: hasBuildable ? "PARCELLE_RETRAITS" : "ENVELOPPE_ESTIMEE",
      reserve_pct: budgetKnown ? Math.round((1 - r.budget_target) * 100) : null,
      reserve_fcfa: budgetKnown ? Math.round(o.budget_fcfa * (1 - r.budget_target)) : null,
    };
  }

  // Adapte le programme pour tenir sous sdpMax.
  // mode DOWNGRADE (B) : préserve d'abord le nombre d'unités :
  //   1) chaque logement peut descendre d'une typologie au plus (T4 → T3), du plus grand au plus petit ;
  //   2) puis retrait d'un logement : le plus petit qui suffit, sinon le plus grand ;
  //   3) puis retrait d'un commerce au-delà du premier.
  // mode PHASE_2 (C) : garde les typologies du client ; les unités qui ne tiennent pas sont
  //   reportées en phase 2 (même choix d'unité qu'en 2), puis les commerces au-delà du premier.
  // sdpOf(program) calcule la SDP d'un programme { logements:[{type,count}], commerce }.
  function fitProgram(program, sdpOf, sdpMax, reason, mode) {
    const phased = mode === "PHASE_2";
    const units = [];
    for (const t of program.logements || []) for (let i = 0; i < (Number(t.count) || 0); i++) units.push({ orig: t.type, cur: t.type });
    let commerce = Number(program.commerce) || 0;
    const adaptations = [];
    const deferred = { logements: {}, commerce: 0 };
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
      const downgradable = phased ? [] : units
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
        if (phased) {
          deferred.logements[removed.cur] = (deferred.logements[removed.cur] || 0) + 1;
          adaptations.push({ kind: "PHASE_2", type: removed.cur, reason });
        } else adaptations.push({ kind: "REMOVE_UNIT", type: removed.cur, reason });
        continue;
      }
      if (commerce > 1) {
        commerce -= 1;
        if (phased) { deferred.commerce += 1; adaptations.push({ kind: "PHASE_2", type: "COMMERCE", reason }); }
        else adaptations.push({ kind: "REMOVE_COMMERCE", reason });
        continue;
      }
      break;
    }
    const out = toProgram();
    const deferredList = Object.keys(deferred.logements)
      .sort((a, b) => TYPO_ORDER.indexOf(a) - TYPO_ORDER.indexOf(b))
      .map(type => ({ type, count: deferred.logements[type] }));
    return {
      program: out, adaptations, infeasible: sdpOf(out) > sdpMax + 1e-6,
      phase_2: (deferredList.length || deferred.commerce) ? { logements: deferredList, commerce: deferred.commerce } : null,
    };
  }

  return {
    TYPO_ORDER, COS_SOL_BY_ZONE, ZONE_LABEL_FR, cosSolForZone,
    DEFAULT_RULES, RULES_SOURCE, RULES_NOTE, scenarioSdpLimits, fitProgram,
  };
});
