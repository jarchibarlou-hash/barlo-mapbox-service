// v12.17 — Estimation du remplissage des zones de texte du PPT (règle « découper, ne pas réduire ») :
// chaque texte doit tenir dans sa zone à la taille de police prévue, sans réduction automatique.
// Estimation prudente (Arial, largeur moyenne 0,5 em, interligne 1,2) : on vise ≤ 95 % de la hauteur.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BarloPptFit = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Zones du modèle template_diagnostic.pptx (pouces) et taille de police appliquée par generate_pptx.py
  // h = hauteur réellement libre (graphiques ou autre zone de texte en dessous déduits)
  const ZONES = {
    slide_3_intro_text:          { slide: 3,  w: 9.11, h: 4.44, pt: 12 },
    slide_4_text:                { slide: 4,  w: 4.37, h: 4.90, pt: 11 },
    slide_5_text:                { slide: 5,  w: 3.98, h: 5.30, pt: 11 },
    scenario_A_summary_text:     { slide: 6,  w: 4.14, h: 5.28, pt: 11 },
    scenario_B_summary_text:     { slide: 9,  w: 4.08, h: 5.17, pt: 11 },
    scenario_C_summary_text:     { slide: 12, w: 3.91, h: 5.19, pt: 11 },
    scenario_A_financial_text:   { slide: 7,  w: 9.12, h: 2.20, pt: 11 },
    scenario_B_financial_text:   { slide: 10, w: 9.12, h: 2.20, pt: 11 },
    scenario_C_financial_text:   { slide: 13, w: 9.12, h: 2.20, pt: 11 },
    scenario_A_risk_text:        { slide: 8,  w: 9.79, h: 2.45, pt: 12 },
    scenario_B_risk_text:        { slide: 11, w: 9.79, h: 2.45, pt: 12 },
    scenario_C_risk_text:        { slide: 14, w: 9.79, h: 2.45, pt: 12 },
    strategic_arbitrage_text:    { slide: 16, w: 9.90, h: 2.05, pt: 11 },
    invisible_technical_text:    { slide: 17, w: 3.19, h: 4.17, pt: 10 },
    invisible_financial_text:    { slide: 17, w: 3.35, h: 4.17, pt: 10 },
    invisible_strategic_text:    { slide: 17, w: 3.44, h: 4.17, pt: 10 },
    success_technical_text:      { slide: 18, w: 3.19, h: 4.00, pt: 10 },
    success_financial_text:      { slide: 18, w: 3.35, h: 4.00, pt: 10 },
    success_strategic_text:      { slide: 18, w: 3.44, h: 4.00, pt: 10 },
    next_step_intro_text:        { slide: 19, w: 9.52, h: 1.00, pt: 11 },
    next_step_scope_text:        { slide: 19, w: 9.52, h: 2.26, pt: 11 },
    conclusion_summary_text:     { slide: 20, w: 9.52, h: 1.85, pt: 11 },
    conclusion_positioning_text: { slide: 20, w: 9.52, h: 1.55, pt: 11 },
  };
  const INSET_W = 0.2, INSET_H = 0.1;   // marges internes par défaut d'une zone de texte (pouces)
  function estimateLines(text, zone) {
    const usableW = (zone.w - INSET_W) * 72;               // points
    const charW = 0.5 * zone.pt;
    let lines = 0;
    for (const raw of String(text || "").split("\n")) {
      const para = raw.replace(/\*\*/g, "").replace(/\*/g, "");
      if (!para.trim()) { lines += 1; continue; }
      // césure au mot : on remplit ligne par ligne
      let cur = 0, n = 1;
      for (const word of para.split(/\s+/)) {
        const w = (word.length + 1) * charW;
        if (cur + w > usableW && cur > 0) { n++; cur = w; } else cur += w;
      }
      lines += n;
    }
    return lines;
  }
  function fit(key, text) {
    const zone = ZONES[key];
    if (!zone) return null;
    const lines = estimateLines(text, zone);
    const capacity = Math.floor(((zone.h - INSET_H) * 72) / (zone.pt * 1.2));
    return { key, slide: zone.slide, lines, capacity, ratio: Math.round(lines / capacity * 100) / 100, fits: lines <= capacity * 0.95 };
  }
  function fitAll(texts) {
    return Object.keys(ZONES).filter(k => texts && texts[k]).map(k => fit(k, texts[k]));
  }
  return { ZONES, estimateLines, fit, fitAll };
});
