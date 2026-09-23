// BARLO v12 — Modèle de scénario : rôles, grille de coûts, provenance des valeurs, états.
// Fonctions pures, utilisables côté serveur (require) et côté studio (<script src="/lib/scenario-model.js">).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BarloScenarioModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── Rôles métier : la lettre n'est qu'un identifiant, le rôle porte la philosophie ──
  const ROLE = Object.freeze({ CLIENT_INTENT: "CLIENT_INTENT", BALANCED: "BALANCED", PRUDENT: "PRUDENT" });
  const ROLE_BY_LETTER = Object.freeze({ A: ROLE.CLIENT_INTENT, B: ROLE.BALANCED, C: ROLE.PRUDENT });
  const ROLE_LABEL_FR = Object.freeze({
    CLIENT_INTENT: "Intention client",
    BALANCED: "Équilibre",
    PRUDENT: "Prudence",
  });
  function roleOf(letter) {
    const r = ROLE_BY_LETTER[String(letter || "").toUpperCase()];
    if (!r) throw new Error(`Scénario inconnu : ${letter}`);
    return r;
  }

  // ── Provenance ──
  const SOURCE = Object.freeze({
    USER_OVERRIDE: "USER_OVERRIDE",
    BARLO_SUGGESTION: "BARLO_SUGGESTION",
    GEOMETRY_CALCULATION: "GEOMETRY_CALCULATION",
    REGULATORY_RULE: "REGULATORY_RULE",
    QUESTIONNAIRE: "QUESTIONNAIRE",
    HYPOTHESIS: "HYPOTHESIS",
    UNKNOWN: "UNKNOWN",
  });
  function pv(value, source, note) {
    const out = { value: value === undefined ? null : value, source: source || SOURCE.UNKNOWN };
    if (note) out.note = note;
    return out;
  }

  // ── Grille coût/m² de construction (FCFA), validée par Jeremy le 2026-09-23 ──
  // Standings du questionnaire : économique (bas), bon standing, haut standing, très haut standing.
  const COST_GRID = Object.freeze({
    ECONOMIQUE: { CLIENT_INTENT: 250000, BALANCED: 200000, PRUDENT: 175000 },
    STANDARD:   { CLIENT_INTENT: 350000, BALANCED: 300000, PRUDENT: 275000 },
    HAUT:       { CLIENT_INTENT: 500000, BALANCED: 450000, PRUDENT: 400000 },
    PREMIUM:    { CLIENT_INTENT: 650000, BALANCED: 600000, PRUDENT: 550000 },
  });
  // Valeurs non dictées explicitement, déduites de « la même logique » (−50 k par rôle)
  const COST_GRID_DERIVED = Object.freeze({ PREMIUM: ["BALANCED", "PRUDENT"] });
  const STANDING_ALIASES = Object.freeze({ ECO: "ECONOMIQUE", BAS: "ECONOMIQUE", CONFORT: "HAUT", TRES_HAUT: "PREMIUM" });

  function normalizeStanding(s) {
    const k = String(s || "").toUpperCase().trim();
    if (COST_GRID[k]) return k;
    if (STANDING_ALIASES[k]) return STANDING_ALIASES[k];
    return null;
  }
  function suggestedCostPerM2(standing, role) {
    const std = normalizeStanding(standing);
    if (!std) return pv(null, SOURCE.UNKNOWN, `Standing non reconnu : "${standing}"`);
    const derived = (COST_GRID_DERIVED[std] || []).includes(role);
    return pv(COST_GRID[std][role], derived ? SOURCE.HYPOTHESIS : SOURCE.BARLO_SUGGESTION,
      derived ? `Grille ${std} : valeur déduite (−50 k par rôle), à confirmer` : `Grille ${std} × ${role}`);
  }

  // ── Surcharges utilisateur : jamais écrasées par un recalcul ──
  function setOverride(overrides, key, value, at) {
    const out = Object.assign({}, overrides || {});
    if (value === null || value === undefined || value === "") delete out[key];
    else out[key] = { value, source: SOURCE.USER_OVERRIDE, at: at || new Date().toISOString() };
    return out;
  }
  // Valeur effective = surcharge utilisateur ?? suggestion. suggestion peut être brute ou déjà {value, source}.
  function effective(overrides, key, suggestion) {
    const ov = overrides && overrides[key];
    if (ov && ov.value !== null && ov.value !== undefined) return pv(ov.value, SOURCE.USER_OVERRIDE);
    if (suggestion && typeof suggestion === "object" && "source" in suggestion) return suggestion;
    return pv(suggestion === undefined ? null : suggestion, suggestion == null ? SOURCE.UNKNOWN : SOURCE.BARLO_SUGGESTION);
  }

  // ── États d'un scénario ──
  const STATUS = Object.freeze({
    SUGGESTED: "SUGGESTED",   // proposition BARLO, pas encore travaillée
    EDITING: "EDITING",       // modifié dans le cockpit, pas encore validé
    VALIDATED: "VALIDATED",   // géométrie validée, analyse à jour
    OUTDATED: "OUTDATED",     // modifié ou re-suggéré après validation : analyse à refaire
    ANALYZED: "ANALYZED",     // validé + analyse complète (scoring, constats, textes)
  });
  // Une nouvelle suggestion ne fait pas perdre la validation, mais la rend à revoir.
  function statusAfterNewSuggestion(prev) {
    return (prev === STATUS.VALIDATED || prev === STATUS.ANALYZED) ? STATUS.OUTDATED : (prev || STATUS.SUGGESTED);
  }
  function statusAfterEdit(prev) {
    return (prev === STATUS.VALIDATED || prev === STATUS.ANALYZED || prev === STATUS.OUTDATED) ? STATUS.OUTDATED : STATUS.EDITING;
  }

  // ── Empreinte stable des entrées du moteur (détecte une suggestion périmée) ──
  function stableStringify(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined)
      .map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  }
  function hashInputs(obj) {
    const s = stableStringify(obj);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  // ── Programme : "1×COMMERCE(60m²) + 2×T3(65m²)" → [{type, count, size_m2}] ──
  function parseUnitMixDetail(detail) {
    const out = [];
    const re = /(\d+)\s*[×x]\s*([A-Z0-9_]+)\s*\(\s*(\d+(?:[.,]\d+)?)\s*m²?\s*\)/gi;
    let m;
    while ((m = re.exec(String(detail || "")))) {
      out.push({ type: m[2].toUpperCase(), count: Number(m[1]), size_m2: Number(String(m[3]).replace(",", ".")) });
    }
    return out;
  }

  // ── Suggestion normalisée à partir d'un scénario du moteur (champs historiques) ──
  function normalizeSuggestion(letter, sc, ctx) {
    sc = sc || {};
    ctx = ctx || {};
    const role = roleOf(letter);
    const siteArea = Number(ctx.site_area) || 0;
    const sdp = Number(sc.sdp_m2) || 0;
    const fp = Number(sc.fp_m2) || 0;
    const levels = Number(sc.levels) || 0;
    const program = parseUnitMixDetail(sc.unit_mix_detail);
    const cost = ctx.cost_per_m2 || pv(Number(sc.market_cost_per_m2) || null, SOURCE.BARLO_SUGGESTION);
    return {
      role,
      role_label: ROLE_LABEL_FR[role],
      program,
      total_units: Number(sc.total_units) || program.reduce((s, u) => s + u.count, 0),
      unit_mix_detail: sc.unit_mix_detail || "",
      sdp_m2: pv(sdp || null, SOURCE.BARLO_SUGGESTION),
      footprint_m2: pv(fp || null, SOURCE.BARLO_SUGGESTION),
      levels: pv(levels || null, SOURCE.BARLO_SUGGESTION, "nombre total de niveaux (1 = RDC seul)"),
      cos: pv(siteArea > 0 && sdp > 0 ? round(sdp / siteArea, 3) : null, siteArea > 0 ? SOURCE.BARLO_SUGGESTION : SOURCE.UNKNOWN, "SDP / surface terrain"),
      ces: pv(siteArea > 0 && fp > 0 ? round(fp / siteArea, 3) : null, siteArea > 0 ? SOURCE.BARLO_SUGGESTION : SOURCE.UNKNOWN, "emprise / surface terrain"),
      cost_per_m2: cost,
      cost_total_fcfa: pv(Number(sc.cost_total_fcfa) || null, SOURCE.BARLO_SUGGESTION),
      budget_fit: sc.budget_fit || null,
      layout: pv(sc.layout_mode || null, SOURCE.BARLO_SUGGESTION),
      orientation: pv(sc.orientation || null, sc.orientation ? SOURCE.BARLO_SUGGESTION : SOURCE.UNKNOWN),
      height_m: pv(Number(sc.height_m) || null, SOURCE.BARLO_SUGGESTION),
      has_pilotis: !!sc.has_pilotis,
    };
  }
  function round(x, d) { const k = Math.pow(10, d || 0); return Math.round(x * k) / k; }

  return {
    ROLE, ROLE_BY_LETTER, ROLE_LABEL_FR, roleOf,
    SOURCE, pv,
    COST_GRID, normalizeStanding, suggestedCostPerM2,
    setOverride, effective,
    STATUS, statusAfterNewSuggestion, statusAfterEdit,
    stableStringify, hashInputs,
    parseUnitMixDetail, normalizeSuggestion,
  };
});
