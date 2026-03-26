const express = require("express");
const puppeteer = require("puppeteer-core");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas, loadImage } = require("canvas");
const FormData = require("form-data");
const fetch = require("node-fetch");
const app = express();
app.use(express.json({ limit: "2mb", type: () => true }));
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
app.get("/health", (req, res) => res.json({ ok: true, engine: "browserless-mapbox-gl-3d", version: "53-massing" }));
// ─── GÉOMÉTRIE GPS ────────────────────────────────────────────────────────────
const R_EARTH = 6371000;
function toM(lat, lon, cLat, cLon) {
  return {
    x: (lon - cLon) * Math.PI / 180 * R_EARTH * Math.cos(cLat * Math.PI / 180),
    y: (lat - cLat) * Math.PI / 180 * R_EARTH,
  };
}
function brng(p1, p2) {
  const dLon = (p2.lon - p1.lon) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(p2.lat * Math.PI / 180);
  const x = Math.cos(p1.lat * Math.PI / 180) * Math.sin(p2.lat * Math.PI / 180) -
    Math.sin(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function computeEnvelope(coords, cLat, cLon, front, side, back) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const n = pts.length;
  let maxLat = -Infinity, rb = 0;
  for (let i = 0; i < n - 1; i++) {
    const ml = (coords[i].lat + coords[(i + 1) % n].lat) / 2;
    if (ml > maxLat) { maxLat = ml; rb = brng(coords[i], coords[(i + 1) % n]); }
  }
  function setSB(b) { let d = ((b - rb) + 360) % 360; if (d > 180) d = 360 - d; return d < 45 ? front : d < 135 ? side : back; }
  function offSeg(p1, p2, dist) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.sqrt(dx * dx + dy * dy) + 0.001;
    return { p1: { x: p1.x - dy / len * dist, y: p1.y + dx / len * dist }, p2: { x: p2.x - dy / len * dist, y: p2.y + dx / len * dist } };
  }
  function intersect(s1, s2) {
    const d1x = s1.p2.x - s1.p1.x, d1y = s1.p2.y - s1.p1.y, d2x = s2.p2.x - s2.p1.x, d2y = s2.p2.y - s2.p1.y;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-10) return { x: (s1.p2.x + s2.p1.x) / 2, y: (s1.p2.y + s2.p1.y) / 2 };
    const t = ((s2.p1.x - s1.p1.x) * d2y - (s2.p1.y - s1.p1.y) * d2x) / den;
    return { x: s1.p1.x + t * d1x, y: s1.p1.y + t * d1y };
  }
  const segs = [];
  for (let i = 0; i < n; i++) segs.push(offSeg(pts[i], pts[(i + 1) % n], setSB(brng(coords[i], coords[(i + 1) % n]))));
  const envM = segs.map((_, i) => intersect(segs[(i + n - 1) % n], segs[i]));
  return envM.map(m => ({
    lat: cLat + m.y / R_EARTH * 180 / Math.PI,
    lon: cLon + m.x / (R_EARTH * Math.cos(cLat * Math.PI / 180)) * 180 / Math.PI,
  }));
}
function computeZoom(coords, cLat, cLon) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const ext = Math.max(
    Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)),
    Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y)), 20
  );
  const mpp = (ext * 3.0) / 1280;
  const z = Math.log2(156543.03 * Math.cos(cLat * Math.PI / 180) / mpp);
  return Math.min(17.5, Math.max(16, Math.round(z * 4) / 4));
}
function computeZoomMassing(coords, cLat, cLon) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const ext = Math.max(
    Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)),
    Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y)), 20
  );
  const mpp = (ext * 1.8) / 1280;
  const z = Math.log2(156543.03 * Math.cos(cLat * Math.PI / 180) / mpp);
  return Math.min(18, Math.max(16.5, Math.round(z * 4) / 4));
}
function computeBearing(coords, cLat, cLon) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  let longest = 0, angle = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > longest) { longest = len; angle = Math.atan2(dx, dy) * 180 / Math.PI; }
  }
  return ((Math.round(angle + 30) % 360) + 360) % 360;
}
// ─── CALCUL DIMENSIONNEL MASSING ──────────────────────────────────────────────
function computeMassingDimensions(fp_m2, envelope_w, envelope_d) {
  const ratio = envelope_w / envelope_d;
  const w = Math.sqrt(fp_m2 * ratio);
  const d = Math.sqrt(fp_m2 / ratio);
  const wCapped = Math.min(w, envelope_w);
  const dCapped = Math.min(d, envelope_d);
  const offset_x = (envelope_w - wCapped) / 2;
  const offset_y = (envelope_d - dCapped) / 2;
  return { w: Math.round(wCapped * 10) / 10, d: Math.round(dCapped * 10) / 10, offset_x, offset_y };
}
// ─── MOTEUR DE SCÉNARIOS v52 — DATA-DRIVEN ──────────────────────────────────
// Basé sur les 23 feuilles du source of truth :
//   RULES_SCENARIOS  → ratios fp par primary_driver (5 profils)
//   RULES_ZONING     → COS (vos_ratio) par zoning_type
//   RULES_HEKTAR     → massing_mode (COMPACT/BALANCED/SPREAD) par saturation
//   SCENARIOS_FR     → S1=Référence/BALANCED, S2=Étalée/SPREAD, S3=Compacte/COMPACT
//   VARIABLES        → formulaire client (program_main, target_surface, max_floors...)
//
// Le commerce (USAGE_MIXTE) vient du FORMULAIRE CLIENT, pas du scénario.
// Les ratios viennent du primary_driver, pas d'un ratio fixe.
// La FORME (hauteur vs étalement) vient du massing_mode par scénario.
//

// Ratios d'emprise par primary_driver (depuis RULES_SCENARIOS)
const FP_RATIOS = {
  MAX_CAPACITE:       { A: 0.95, B: 0.85, C: 0.70 },
  RENTABILITE:        { A: 0.90, B: 0.80, C: 0.65 },
  SECURISATION_RISQUE:{ A: 0.80, B: 0.70, C: 0.60 },
  MIXTE_PROGRAMME:    { A: 0.85, B: 0.75, C: 0.65 },
  PHASAGE_FONCIER:    { A: 0.80, B: 0.70, C: 0.60 },
};

// COS par zoning_type (depuis RULES_ZONING)
const ZONING_COS = {
  URBAIN: 0.60, PERIURBAIN: 0.40, PAVILLON: 0.30,
  RURAL: 0.20, MIXTE: 0.50, Z_DEFAULT: 0.40,
};

// Massing modes par scénario (depuis SCENARIOS_FR)
// S1/A = Référence (BALANCED), S2/B = Étalée (SPREAD), S3/C = Compacte (COMPACT)
const SCENARIO_MASSING_MODE = { A: "BALANCED", B: "SPREAD", C: "COMPACT" };

// Multiplicateur de niveaux par massing_mode
// COMPACT = hauteur max, BALANCED = modéré, SPREAD = bas
function levelMultiplier(mode) {
  if (mode === "COMPACT") return 1.0;
  if (mode === "BALANCED") return 0.65;
  return 0.35; // SPREAD
}

function computeSmartScenarios({
  site_area, envelope_w, envelope_d, envelope_area: env_area_override,
  zoning_type = "URBAIN", floor_height = 3.2,
  primary_driver = "MAX_CAPACITE",
  max_floors = 99, max_height_m = 99,
  program_main = "", target_surface_m2 = 0,
  site_saturation_level = "MEDIUM",
  financial_rigidity_score = 0,
  density_band = "", risk_adjusted = 0,
  feasibility_posture = "BALANCED",
  scenario_A_role = "", scenario_B_role = "", scenario_C_role = "",
  // ── BUDGET & ATTENTES CLIENT (depuis PIPELINE) ──
  budget_range = 0, budget_band = "", budget_tension = 0,
  standing_level = "STANDARD",
  target_units = 0,
  rent_score = 0, capacity_score = 0, mix_score = 0, phase_score = 0, risk_score = 0,
  density_pressure_factor = 1,
  driver_intensity = "MEDIUM",
  strategic_position = "",
}) {
  const envelope_area = env_area_override || (envelope_w * envelope_d);
  const cos = ZONING_COS[zoning_type] || 0.40;
  const max_sdp = cos * site_area;
  const max_fp = Math.min(cos * site_area, envelope_area);
  const ratios = FP_RATIOS[primary_driver] || FP_RATIOS.MAX_CAPACITE;

  // ── BUDGET MODULATION ──
  // budget_tension : 0–1 (0=confortable, 1=très tendu)
  // Si budget tendu → favoriser COMPACT (moins d'emprise, + de niveaux = moins cher au m²)
  // Si budget large → autoriser SPREAD (confort, espaces verts, standing)
  const bt = Math.max(0, Math.min(1, Number(budget_tension) || 0));
  const fri = Math.max(0, Math.min(1, Number(financial_rigidity_score) || 0));
  // Pression budgétaire combinée : tension + rigidité financière
  const budgetPressure = (bt + fri) / 2;

  // ── STANDING MODULATION ──
  // PREMIUM → plus de marge, emprise réduite, hauteur confort
  // ECONOMIQUE → emprise max, optimisation densité
  const standingFactor = {
    PREMIUM: 0.85, HAUT: 0.90, STANDARD: 1.0, ECONOMIQUE: 1.08, ECO: 1.08,
  }[String(standing_level).toUpperCase()] || 1.0;

  // ── DENSITY PRESSURE ──
  const dpf = Math.max(0.5, Math.min(2.0, Number(density_pressure_factor) || 1));

  // ── DRIVER INTENSITY ──
  // HIGH → accentue les différences entre scénarios
  // LOW → scénarios plus proches les uns des autres
  const intensitySpread = { HIGH: 1.3, MEDIUM: 1.0, LOW: 0.7 }[String(driver_intensity).toUpperCase()] || 1.0;

  const absMaxLevels = Math.min(
    Number(max_floors) || 99,
    Math.floor((Number(max_height_m) || 99) / floor_height),
    10
  );

  const isMixte = /mixte|mixed/i.test(program_main);
  const commerceLevels = isMixte ? 1 : 0;

  console.log(`┌── SCENARIO ENGINE v52.1 (data-driven + budget) ──`);
  console.log(`│ site=${site_area}m² envelope=${envelope_w}×${envelope_d}=${envelope_area}m²`);
  console.log(`│ zoning=${zoning_type} COS=${cos} max_sdp=${Math.round(max_sdp)}m²`);
  console.log(`│ driver=${primary_driver} intensity=${driver_intensity} ratios=[${ratios.A}/${ratios.B}/${ratios.C}]`);
  console.log(`│ max_floors=${max_floors} max_height=${max_height_m}m → absMaxLevels=${absMaxLevels}`);
  console.log(`│ program=${program_main} commerce=${commerceLevels} saturation=${site_saturation_level}`);
  console.log(`│ budget_range=${budget_range} band=${budget_band} tension=${bt} rigidity=${fri} → pressure=${budgetPressure.toFixed(2)}`);
  console.log(`│ standing=${standing_level} (factor=${standingFactor}) density_pressure=${dpf}`);
  console.log(`│ scores: rent=${rent_score} cap=${capacity_score} mix=${mix_score} phase=${phase_score} risk=${risk_score}`);

  const results = {};
  for (const label of ["A", "B", "C"]) {
    const baseRatio = ratios[label];
    const mode = SCENARIO_MASSING_MODE[label];

    // ── Modulation du ratio emprise par budget + standing + densité ──
    // SPREAD : sensible au budget (si tendu → réduire), sensible au standing (premium → réduire)
    // COMPACT : insensible au budget (déjà petit)
    // BALANCED : modération
    let budgetMod = 1.0;
    if (mode === "SPREAD") {
      // Budget tendu → réduire emprise spread (économiser), budget large → boost
      budgetMod = 1.0 + (0.5 - budgetPressure) * 0.20 * intensitySpread;
    } else if (mode === "COMPACT") {
      // Budget tendu → légèrement agrandir emprise compact (pragmatisme)
      budgetMod = 1.0 + budgetPressure * 0.08;
    }

    let ratio = baseRatio * standingFactor * budgetMod;
    // Density pressure : forte pression → pousser vers plus d'emprise
    ratio = ratio * (1 + (dpf - 1) * 0.15);
    ratio = Math.max(0.30, Math.min(0.98, ratio));

    let fp = Math.round(Math.min(max_fp * ratio, envelope_area * ratio));
    fp = Math.max(50, fp);

    // ── Niveaux : massing_mode + modulation budget ──
    let baseLevelMult = levelMultiplier(mode);
    // Budget tendu + COMPACT → pousser encore plus de niveaux (vertical = économique)
    if (budgetPressure > 0.5 && mode === "COMPACT") {
      baseLevelMult = Math.min(1.0, baseLevelMult + (budgetPressure - 0.5) * 0.3);
    }
    // Budget large + SPREAD → réduire niveaux (confort, horizontal)
    if (budgetPressure < 0.3 && mode === "SPREAD") {
      baseLevelMult = Math.max(0.20, baseLevelMult - (0.3 - budgetPressure) * 0.2);
    }

    let levels = Math.max(1, Math.round(absMaxLevels * baseLevelMult));
    levels = Math.min(levels, absMaxLevels);

    // Si le client a une cible SDP, on essaie de s'en approcher
    if (target_surface_m2 > 0 && fp > 0) {
      const idealLevels = Math.ceil(target_surface_m2 * ratio / fp);
      const modeLevels = Math.max(1, Math.round(absMaxLevels * baseLevelMult));
      levels = Math.max(1, Math.min(Math.round((idealLevels + modeLevels) / 2), absMaxLevels));
    }

    // Si cible en nombre de logements → estimer SDP nécessaire
    if (target_units > 0 && target_surface_m2 <= 0 && fp > 0) {
      const avgUnitSize = standing_level === "PREMIUM" ? 90 : standing_level === "ECONOMIQUE" ? 55 : 70;
      const neededSdp = target_units * avgUnitSize;
      const idealLevels = Math.ceil(neededSdp / fp);
      const modeLevels = Math.max(1, Math.round(absMaxLevels * baseLevelMult));
      levels = Math.max(1, Math.min(Math.round((idealLevels + modeLevels) / 2), absMaxLevels));
    }

    const height = Math.round(levels * floor_height * 10) / 10;
    const sdp = fp * levels;
    const cosRatio = max_sdp > 0 ? sdp / max_sdp : 0;

    let compliance;
    if (cosRatio <= 1.05) compliance = "CONFORME";
    else if (cosRatio <= 1.30) compliance = "DEROGATION_POSSIBLE";
    else compliance = "AMBITIEUX_HORS_COS";

    // Coût estimé au m² (indicatif, basé sur standing + zoning)
    const costPerM2Base = { PREMIUM: 450, HAUT: 380, STANDARD: 300, ECONOMIQUE: 230, ECO: 230 }[String(standing_level).toUpperCase()] || 300;
    const zoningCostMult = { URBAIN: 1.15, PERIURBAIN: 1.0, PAVILLON: 0.95, RURAL: 0.85, MIXTE: 1.05 }[zoning_type] || 1.0;
    const estimatedCost = Math.round(sdp * costPerM2Base * zoningCostMult);
    const budgetFit = budget_range > 0 ? (estimatedCost <= budget_range * 1.1 ? "DANS_BUDGET" : estimatedCost <= budget_range * 1.3 ? "BUDGET_TENDU" : "HORS_BUDGET") : "N/A";

    const roles = {
      A: scenario_A_role || "INTENSIFICATION",
      B: scenario_B_role || "ALTERNATIVE_EQUILIBREE",
      C: scenario_C_role || "PHASAGE_PROGRESSIF",
    };
    const labels_fr = {
      A: "Scenario de reference",
      B: "Variante etalee",
      C: "Variante compacte",
    };
    const accents = { A: "#2a5298", B: "#1e8449", C: "#d35400" };

    results[label] = {
      fp_m2: fp, levels, height_m: height,
      commerce_levels: commerceLevels,
      massing_mode: mode,
      sdp_m2: sdp,
      cos_compliance: compliance,
      cos_ratio_pct: Math.round(cosRatio * 100),
      role: roles[label],
      label_fr: labels_fr[label],
      accent_color: accents[label],
      estimated_cost: estimatedCost,
      budget_fit: budgetFit,
      ratio_used: Math.round(ratio * 100) / 100,
    };
  }

  // ── POST-TRAITEMENT : garantir la différenciation visuelle ──
  const r = results;

  // C(COMPACT) ≥ A(BALANCED) ≥ B(SPREAD) en niveaux
  if (r.C.levels <= r.A.levels && absMaxLevels > r.A.levels) {
    r.C.levels = Math.min(r.A.levels + 1, absMaxLevels);
  }
  if (r.B.levels >= r.A.levels && r.A.levels > 1) {
    r.B.levels = Math.max(1, r.A.levels - 1);
  }
  for (const label of ["A", "B", "C"]) {
    r[label].height_m = Math.round(r[label].levels * floor_height * 10) / 10;
    r[label].sdp_m2 = r[label].fp_m2 * r[label].levels;
    const cr = max_sdp > 0 ? r[label].sdp_m2 / max_sdp : 0;
    r[label].cos_ratio_pct = Math.round(cr * 100);
    r[label].cos_compliance = cr <= 1.05 ? "CONFORME" : cr <= 1.30 ? "DEROGATION_POSSIBLE" : "AMBITIEUX_HORS_COS";
  }

  // Emprise : au moins 15% diff entre B(spread) et C(compact)
  if (r.B.fp_m2 > 0 && r.C.fp_m2 > 0) {
    const diff = Math.abs(r.B.fp_m2 - r.C.fp_m2) / Math.max(r.B.fp_m2, r.C.fp_m2);
    if (diff < 0.15) {
      r.B.fp_m2 = Math.round(Math.min(r.B.fp_m2 * 1.10, envelope_area * 0.95));
      r.C.fp_m2 = Math.round(r.C.fp_m2 * 0.85);
      r.C.fp_m2 = Math.max(r.C.fp_m2, 50);
      r.B.sdp_m2 = r.B.fp_m2 * r.B.levels;
      r.C.sdp_m2 = r.C.fp_m2 * r.C.levels;
    }
  }

  const meta = {
    zoning_type, primary_driver, cos, floor_height,
    max_sdp: Math.round(max_sdp), absMaxLevels,
    envelope_area: Math.round(envelope_area),
    program_main, commerce_levels: commerceLevels,
    site_saturation_level, ratios_used: ratios,
    budget_pressure: Math.round(budgetPressure * 100) / 100,
    standing_level, standing_factor: standingFactor,
    density_pressure_factor: dpf,
    driver_intensity, intensity_spread: intensitySpread,
    scores: { rent_score, capacity_score, mix_score, phase_score, risk_score },
  };

  console.log(`│ A(REF):     fp=${r.A.fp_m2}m² × ${r.A.levels}niv = ${r.A.sdp_m2}m² SDP (${r.A.cos_ratio_pct}% COS) [${r.A.massing_mode}] ${r.A.cos_compliance} cost=${r.A.estimated_cost} ${r.A.budget_fit}`);
  console.log(`│ B(SPREAD):  fp=${r.B.fp_m2}m² × ${r.B.levels}niv = ${r.B.sdp_m2}m² SDP (${r.B.cos_ratio_pct}% COS) [${r.B.massing_mode}] ${r.B.cos_compliance} cost=${r.B.estimated_cost} ${r.B.budget_fit}`);
  console.log(`│ C(COMPACT): fp=${r.C.fp_m2}m² × ${r.C.levels}niv = ${r.C.sdp_m2}m² SDP (${r.C.cos_ratio_pct}% COS) [${r.C.massing_mode}] ${r.C.cos_compliance} cost=${r.C.estimated_cost} ${r.C.budget_fit}`);
  console.log(`└── end SCENARIO ENGINE v52.1 ──`);

  return { A: r.A, B: r.B, C: r.C, meta };
}
// ─── ENDPOINT /compute-scenarios ─────────────────────────────────────────────
app.post("/compute-scenarios", (req, res) => {
  const p = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch(e) { return {}; } })() : (req.body || {});
  if (!p.site_area || !p.envelope_w || !p.envelope_d) {
    return res.status(400).json({ error: "site_area, envelope_w, envelope_d obligatoires" });
  }
  const scenarios = computeSmartScenarios({
    site_area: Number(p.site_area),
    envelope_w: Number(p.envelope_w),
    envelope_d: Number(p.envelope_d),
    envelope_area: Number(p.envelope_area) || undefined,
    zoning_type: p.zoning_type || "URBAIN",
    floor_height: Number(p.floor_height) || 3.2,
    primary_driver: p.primary_driver || "MAX_CAPACITE",
    max_floors: Number(p.max_floors) || 99,
    max_height_m: Number(p.max_height_m) || 99,
    program_main: p.program_main || "",
    target_surface_m2: Number(p.target_surface_m2) || 0,
    site_saturation_level: p.site_saturation_level || "MEDIUM",
    financial_rigidity_score: Number(p.financial_rigidity_score) || 0,
    density_band: p.density_band || "",
    risk_adjusted: Number(p.risk_adjusted) || 0,
    feasibility_posture: p.feasibility_posture || "BALANCED",
    scenario_A_role: p.scenario_A_role || "",
    scenario_B_role: p.scenario_B_role || "",
    scenario_C_role: p.scenario_C_role || "",
    budget_range: Number(p.budget_range) || 0,
    budget_band: p.budget_band || "",
    budget_tension: Number(p.budget_tension) || 0,
    standing_level: p.standing_level || "STANDARD",
    target_units: Number(p.target_units) || 0,
    rent_score: Number(p.rent_score) || 0,
    capacity_score: Number(p.capacity_score) || 0,
    mix_score: Number(p.mix_score) || 0,
    phase_score: Number(p.phase_score) || 0,
    risk_score: Number(p.risk_score) || 0,
    density_pressure_factor: Number(p.density_pressure_factor) || 1,
    driver_intensity: p.driver_intensity || "MEDIUM",
    strategic_position: p.strategic_position || "",
  });
  return res.json({ ok: true, scenarios });
});
// ─── POLYGONE GPS DU BÂTIMENT MASSING (v51 — GPS CENTROID DIRECT) ────────────
// v50 bug: centroïde en mètres + rotation causait un décalage mystérieux
// v51 fix: approche la plus simple possible — centroïde GPS direct, aligné axe le plus long
function computeMassingPolygon(envelopeCoords, cLat, cLon, bearing, mw, md, ox, oy) {
  // ── DIAGNOSTIC : log chaque sommet de l'enveloppe ──
  console.log(`┌── computeMassingPolygon v51 ──`);
  console.log(`│ Parcel centroid: ${cLat.toFixed(7)}, ${cLon.toFixed(7)}`);
  console.log(`│ Massing dims: ${mw}m × ${md}m`);
  envelopeCoords.forEach((c, i) => console.log(`│ Envelope[${i}]: ${c.lat.toFixed(7)}, ${c.lon.toFixed(7)}`));

  // ── Centroïde GPS direct de l'enveloppe (pas de conversion en mètres) ──
  const eLat = envelopeCoords.reduce((s, p) => s + p.lat, 0) / envelopeCoords.length;
  const eLon = envelopeCoords.reduce((s, p) => s + p.lon, 0) / envelopeCoords.length;
  console.log(`│ Envelope GPS centroid: ${eLat.toFixed(7)}, ${eLon.toFixed(7)}`);

  // ── Vérifier distance centroïde enveloppe ↔ centroïde parcelle ──
  const distM = Math.sqrt(
    Math.pow((eLon - cLon) * Math.PI / 180 * R_EARTH * Math.cos(cLat * Math.PI / 180), 2) +
    Math.pow((eLat - cLat) * Math.PI / 180 * R_EARTH, 2)
  );
  console.log(`│ Distance envelope↔parcel centroid: ${distM.toFixed(1)}m`);

  // ── Trouver l'orientation du plus long côté de l'enveloppe (en mètres) ──
  const envPts = envelopeCoords.map(c => toM(c.lat, c.lon, eLat, eLon)); // ref = envelope centroid
  let longest = 0, edgeAngle = 0;
  for (let i = 0; i < envPts.length; i++) {
    const j = (i + 1) % envPts.length;
    const dx = envPts[j].x - envPts[i].x;
    const dy = envPts[j].y - envPts[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    console.log(`│ Edge[${i}→${j}]: len=${len.toFixed(1)}m angle=${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1)}°`);
    if (len > longest) {
      longest = len;
      edgeAngle = Math.atan2(dy, dx);
    }
  }
  console.log(`│ Longest edge: ${longest.toFixed(1)}m at ${(edgeAngle * 180 / Math.PI).toFixed(1)}°`);

  // ── Vecteurs unitaires : u le long du plus long côté, v perpendiculaire ──
  const ux = Math.cos(edgeAngle), uy = Math.sin(edgeAngle);
  const vx = -uy, vy = ux;

  // ── mw le long de u, md le long de v — centrés sur centroïde enveloppe ──
  const hw = mw / 2, hd = md / 2;

  // ── 4 coins en mètres (ref = envelope centroid, donc centre = 0,0) ──
  const cornersM = [
    { x: -hw * ux - hd * vx, y: -hw * uy - hd * vy },
    { x: +hw * ux - hd * vx, y: +hw * uy - hd * vy },
    { x: +hw * ux + hd * vx, y: +hw * uy + hd * vy },
    { x: -hw * ux + hd * vx, y: -hw * uy + hd * vy },
  ];

  // ── Reconvertir en GPS (ref = envelope centroid GPS) ──
  const result = cornersM.map(m => ({
    lat: eLat + m.y / R_EARTH * 180 / Math.PI,
    lon: eLon + m.x / (R_EARTH * Math.cos(eLat * Math.PI / 180)) * 180 / Math.PI,
  }));

  // ── Diagnostic : vérifier que le centroïde du massing = centroïde de l'enveloppe ──
  const mLat = result.reduce((s, p) => s + p.lat, 0) / result.length;
  const mLon = result.reduce((s, p) => s + p.lon, 0) / result.length;
  const checkDist = Math.sqrt(
    Math.pow((mLon - eLon) * Math.PI / 180 * R_EARTH * Math.cos(eLat * Math.PI / 180), 2) +
    Math.pow((mLat - eLat) * Math.PI / 180 * R_EARTH, 2)
  );
  result.forEach((c, i) => console.log(`│ Massing[${i}]: ${c.lat.toFixed(7)}, ${c.lon.toFixed(7)}`));
  console.log(`│ Massing centroid: ${mLat.toFixed(7)}, ${mLon.toFixed(7)}`);
  console.log(`│ Massing↔Envelope centroid offset: ${checkDist.toFixed(3)}m (should be ~0)`);
  console.log(`└── end computeMassingPolygon v51 ──`);

  return result;
}
// ─── HTML MAPBOX GL — SLIDE 4 AXO ─────────────────────────────────────────────
function generateMapHTML(center, zoom, bearing, parcelCoords, envelopeCoords, mapboxToken) {
  const parcelGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...parcelCoords.map(c => [c.lon, c.lat]), [parcelCoords[0].lon, parcelCoords[0].lat]]] },
  };
  const envelopeGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...envelopeCoords.map(c => [c.lon, c.lat]), [envelopeCoords[0].lon, envelopeCoords[0].lat]]] },
  };
  const seed = Math.round(Math.abs(center.lat * 137.508 + center.lon * 251.663) * 1000) % 99999;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1280px; height: 1280px; overflow: hidden; background: #f2f0ec; }
  #map { width: 1280px; height: 1280px; }
  .mapboxgl-ctrl-logo, .mapboxgl-ctrl-attrib, .mapboxgl-ctrl-group { display: none !important; }
</style>
<script src="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.js"></script>
<link href="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.css" rel="stylesheet">
</head>
<body>
<div id="map"></div>
<script>
(function() {
  function seededRand(seed) { let s = seed; return function() { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; }; }
  const rand = seededRand(${seed});
  mapboxgl.accessToken = '${mapboxToken}';
  const hektarStyle = {
    "version": 8, "name": "Hektar",
    "sources": { "composite": { "type": "vector", "url": "mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2" } },
    "glyphs": "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
    "sprite": "mapbox://sprites/mapbox/light-v11",
    "layers": [
      { "id": "background", "type": "background", "paint": { "background-color": "#f2f0ec" } },
      { "id": "water", "type": "fill", "source": "composite", "source-layer": "water", "paint": { "fill-color": "#c8dce8" } },
      { "id": "landuse-park", "type": "fill", "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["park", "grass", "cemetery", "wood", "scrub", "pitch"], true, false],
        "paint": { "fill-color": "#e0ddd4" } },
      { "id": "landuse-urban", "type": "fill", "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["residential", "commercial", "industrial"], true, false],
        "paint": { "fill-color": "#ebe8e2" } },
      { "id": "road-case-secondary", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#ccc4ae", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 3, 18, 10] } },
      { "id": "road-case-street", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#ccc4ae", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 18, 6] } },
      { "id": "road-fill-secondary", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#eae4d4", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 2, 18, 8] } },
      { "id": "road-fill-street", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#eae4d4", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1, 18, 4] } }
    ]
  };
  const map = new mapboxgl.Map({
    container: 'map', style: hektarStyle,
    center: [${center.lon}, ${center.lat}], zoom: ${zoom}, bearing: ${bearing}, pitch: 58,
    antialias: true, preserveDrawingBuffer: true, fadeDuration: 0, interactive: false,
  });
  map.addControl = function() {};
  map.on('style.load', () => {
    map.setLight({ anchor: 'map', color: '#fff8f0', intensity: 0.55, position: [1.15, 195, 40] });
    map.addLayer({
      id: '3d-buildings', source: 'composite', 'source-layer': 'building',
      filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 13,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'height'], 6],
          0, '#ffffff', 4, '#f5f3ef', 10, '#e8e4dc', 20, '#c8c4bc', 40, '#9a9690'],
        'fill-extrusion-height': ['case', ['has', 'height'], ['*', ['get', 'height'], 1.6], 8],
        'fill-extrusion-base': ['case', ['has', 'min_height'], ['*', ['get', 'min_height'], 1.6], 0],
        'fill-extrusion-opacity': 1.0, 'fill-extrusion-vertical-gradient': true,
      },
    });
    map.addSource('parcel', { type: 'geojson', data: ${JSON.stringify(parcelGeoJSON)} });
    map.addLayer({ id: 'parcel-fill', type: 'fill', source: 'parcel',
      paint: { 'fill-color': '#d02818', 'fill-opacity': 0.22 } }, '3d-buildings');
    map.addLayer({ id: 'parcel-outline', type: 'line', source: 'parcel',
      paint: { 'line-color': '#d02818', 'line-width': 3, 'line-opacity': 1 } }, '3d-buildings');
    map.addSource('envelope', { type: 'geojson', data: ${JSON.stringify(envelopeGeoJSON)} });
    map.addLayer({ id: 'envelope-outline', type: 'line', source: 'envelope',
      paint: { 'line-color': '#d02818', 'line-width': 2.5, 'line-dasharray': [5, 3], 'line-opacity': 0.85 } }, '3d-buildings');
  });
  let rendered = false;
  map.on('idle', () => { if (rendered) return; rendered = true; setTimeout(() => { window.__MAP_READY = true; }, 2500); });
  setTimeout(() => { window.__MAP_READY = true; }, 28000);
})();
</script>
</body>
</html>`;
}
// ─── HTML MAPBOX GL — MASSING ─────────────────────────────────────────────────
function generateMassingHTML(center, zoom, bearing, parcelCoords, envelopeCoords, massingCoords, massingParams, mapboxToken) {
  const toGeoJSON = (coords) => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...coords.map(c => [c.lon, c.lat]), [coords[0].lon, coords[0].lat]]] },
  });
  const massingFeature = {
    type: "Feature",
    properties: { height: massingParams.total_height, base_height: 0 },
    geometry: toGeoJSON(massingCoords).geometry,
  };
  const commerceH = massingParams.commerce_levels * massingParams.floor_height;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>* { margin: 0; padding: 0; box-sizing: border-box; } body { width: 1280px; height: 1280px; overflow: hidden; background: #f2f0ec; } #map { width: 1280px; height: 1280px; } .mapboxgl-ctrl-logo, .mapboxgl-ctrl-attrib, .mapboxgl-ctrl-group { display: none !important; }</style>
<script src="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.js"></script>
<link href="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.css" rel="stylesheet">
</head>
<body><div id="map"></div>
<script>
(function(){
  mapboxgl.accessToken='${mapboxToken}';
  const hektarStyle={version:8,name:"Hektar",sources:{composite:{type:"vector",url:"mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2"}},glyphs:"mapbox://fonts/mapbox/{fontstack}/{range}.pbf",sprite:"mapbox://sprites/mapbox/light-v11",layers:[
    {id:"background",type:"background",paint:{"background-color":"#f2f0ec"}},
    {id:"water",type:"fill",source:"composite","source-layer":"water",paint:{"fill-color":"#c8dce8"}},
    {id:"landuse-park",type:"fill",source:"composite","source-layer":"landuse",filter:["match",["get","class"],["park","grass","cemetery","wood","scrub","pitch"],true,false],paint:{"fill-color":"#e0ddd4"}},
    {id:"landuse-urban",type:"fill",source:"composite","source-layer":"landuse",filter:["match",["get","class"],["residential","commercial","industrial"],true,false],paint:{"fill-color":"#ebe8e2"}},
    {id:"road-case-sec",type:"line",source:"composite","source-layer":"road",filter:["match",["get","class"],["secondary","tertiary","primary","trunk","motorway"],true,false],layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#ccc4ae","line-width":["interpolate",["linear"],["zoom"],14,3,18,10]}},
    {id:"road-case-str",type:"line",source:"composite","source-layer":"road",filter:["match",["get","class"],["street","street_limited","service"],true,false],layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#ccc4ae","line-width":["interpolate",["linear"],["zoom"],14,1.5,18,6]}},
    {id:"road-fill-sec",type:"line",source:"composite","source-layer":"road",filter:["match",["get","class"],["secondary","tertiary","primary","trunk","motorway"],true,false],layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#eae4d4","line-width":["interpolate",["linear"],["zoom"],14,2,18,8]}},
    {id:"road-fill-str",type:"line",source:"composite","source-layer":"road",filter:["match",["get","class"],["street","street_limited","service"],true,false],layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#eae4d4","line-width":["interpolate",["linear"],["zoom"],14,1,18,4]}}
  ]};
  const map=new mapboxgl.Map({container:"map",style:hektarStyle,center:[${center.lon},${center.lat}],zoom:${zoom},bearing:${bearing},pitch:58,antialias:true,preserveDrawingBuffer:true,fadeDuration:0,interactive:false});
  map.addControl=function(){};
  map.on("style.load",()=>{
    map.setLight({anchor:"map",color:"#fff8f0",intensity:0.55,position:[1.15,195,40]});
    map.addLayer({id:"3d-buildings",source:"composite","source-layer":"building",filter:["==","extrude","true"],type:"fill-extrusion",minzoom:13,paint:{
      "fill-extrusion-color":["interpolate",["linear"],["coalesce",["get","height"],6],0,"#ffffff",4,"#f5f3ef",10,"#e8e4dc",20,"#c8c4bc",40,"#9a9690"],
      "fill-extrusion-height":["case",["has","height"],["*",["get","height"],1.6],8],
      "fill-extrusion-base":["case",["has","min_height"],["*",["get","min_height"],1.6],0],
      "fill-extrusion-opacity":1.0,"fill-extrusion-vertical-gradient":true
    }});
    map.addSource("parcel",{type:"geojson",data:${JSON.stringify(toGeoJSON(parcelCoords))}});
    map.addLayer({id:"parcel-fill",type:"fill",source:"parcel",paint:{"fill-color":"#d02818","fill-opacity":0.22}},"3d-buildings");
    map.addLayer({id:"parcel-outline",type:"line",source:"parcel",paint:{"line-color":"#d02818","line-width":3,"line-opacity":1}},"3d-buildings");
    map.addSource("envelope",{type:"geojson",data:${JSON.stringify(toGeoJSON(envelopeCoords))}});
    map.addLayer({id:"envelope-outline",type:"line",source:"envelope",paint:{"line-color":"#d02818","line-width":2,"line-dasharray":[5,3],"line-opacity":0.8}},"3d-buildings");
    map.addSource("massing",{type:"geojson",data:${JSON.stringify(massingFeature)}});
    ${commerceH > 0 ? `map.addLayer({id:"massing-commerce",type:"fill-extrusion",source:"massing",paint:{"fill-extrusion-color":"#e8a030","fill-extrusion-height":${commerceH},"fill-extrusion-base":0,"fill-extrusion-opacity":0.95,"fill-extrusion-vertical-gradient":true}});` : ""}
    map.addLayer({id:"massing-habitation",type:"fill-extrusion",source:"massing",paint:{"fill-extrusion-color":"#ffffff","fill-extrusion-height":${massingParams.total_height},"fill-extrusion-base":${commerceH},"fill-extrusion-opacity":0.95,"fill-extrusion-vertical-gradient":true}});
    map.addLayer({id:"massing-footprint",type:"line",source:"massing",paint:{"line-color":"${massingParams.accent_color}","line-width":3,"line-opacity":1}});
  });
  let ready=false;
  map.on("idle",()=>{if(ready)return;ready=true;setTimeout(()=>{window.__MAP_READY=true;},2500);});
  setTimeout(()=>{window.__MAP_READY=true;},28000);
})();
</script></body></html>`;
}
// ─── OVERLAYS CANVAS — SLIDE 4 AXO ───────────────────────────────────────────
function drawOverlays(ctx, W, H, BH, p) {
  const { site_area, land_width, land_depth, buildable_fp,
    setback_front, setback_side, setback_back,
    city, district, zoning, terrain_context, bearing } = p;
  ctx.save();
  ctx.translate(W - 58, 58);
  ctx.shadowColor = "rgba(0,0,0,0.15)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.96)"; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1; ctx.stroke();
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -3); ctx.lineTo(0, -8); ctx.lineTo(5, -3); ctx.closePath();
  ctx.fillStyle = "#d02818"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 3); ctx.lineTo(0, 8); ctx.lineTo(5, 3); ctx.closePath();
  ctx.fillStyle = "#ccc"; ctx.fill();
  ctx.rotate((bearing || 0) * Math.PI / 180);
  ctx.font = "bold 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#d02818";
  ctx.fillText("N", 0, -22);
  ctx.restore();
  const legItems = [
    { type: "rect", fill: "rgba(208,40,24,0.2)", stroke: "#d02818", label: `Parcelle — ${site_area} m²` },
    { type: "dash", stroke: "#d02818", label: "Enveloppe constructible" },
    { type: "rect", fill: "#e8e4dc", stroke: "#c8c4bc", label: "Bâtiments 3D" },
  ];
  const legPad = 14, legLH = 26, legW = 300;
  const legH = legPad * 2 + legItems.length * legLH + 10;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.08)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
  ctx.fillStyle = "rgba(255,255,255,0.97)";
  ctx.beginPath(); ctx.roundRect(16, 16, legW, legH, 8); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#e4e0d8"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
  legItems.forEach((item, i) => {
    const iy = 16 + legPad + i * legLH;
    ctx.save();
    if (item.type === "rect") {
      ctx.fillStyle = item.fill; ctx.beginPath(); ctx.roundRect(28, iy, 16, 13, 2); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(28, iy + 6); ctx.lineTo(44, iy + 6);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2.5; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
    ctx.font = "12px Arial, Helvetica, sans-serif"; ctx.fillStyle = "#444"; ctx.textAlign = "left";
    ctx.fillText(item.label, 52, iy + 11);
  });
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© Mapbox  © OpenStreetMap contributors", 28, 16 + legH - 6);
  const BY = H;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, BY, W, BH);
  ctx.beginPath(); ctx.moveTo(0, BY); ctx.lineTo(W, BY);
  ctx.strokeStyle = "#d02818"; ctx.lineWidth = 4; ctx.stroke();
  const pad = 32, C1 = pad, C2 = W * 0.26, C3 = W * 0.52, C4 = W * 0.76;
  ctx.textAlign = "left";
  ctx.font = "bold 20px Arial"; ctx.fillStyle = "#111"; ctx.fillText("Lecture stratégique du site", C1, BY + 42);
  ctx.font = "11px Arial"; ctx.fillStyle = "#aaa"; ctx.fillText(`${city}  ·  ${district}  ·  Zoning : ${zoning}`, C1, BY + 62);
  ctx.beginPath(); ctx.moveTo(C1, BY + 76); ctx.lineTo(W - pad, BY + 76); ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1.5; ctx.stroke();
  const stats = [
    { label: "Surface parcelle", val: `${site_area} m²`, col: C1, color: "#111" },
    { label: "Dimensions", val: `${land_width}m × ${land_depth}m`, col: C2, color: "#111" },
    { label: "Empreinte constructible", val: `${buildable_fp} m²`, col: C3, color: "#1d7a3e" },
  ];
  stats.forEach(s => {
    ctx.font = "10px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText(s.label, s.col, BY + 96);
    ctx.font = "bold 26px Arial"; ctx.fillStyle = s.color; ctx.fillText(s.val, s.col, BY + 128);
  });
  ctx.font = "10px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Retraits réglementaires", C4, BY + 96);
  ctx.font = "600 13px Arial"; ctx.fillStyle = "#555";
  ctx.fillText(`Avant : ${setback_front}m  ·  Côtés : ${setback_side}m`, C4, BY + 114);
  ctx.fillText(`Arrière : ${setback_back}m`, C4, BY + 132);
  ctx.beginPath(); ctx.moveTo(C1, BY + 148); ctx.lineTo(W - pad, BY + 148); ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = "11px Arial"; ctx.fillStyle = "#ccc"; ctx.fillText((terrain_context || "").substring(0, 100), C1, BY + BH - 16);
  ctx.textAlign = "right"; ctx.font = "9px Arial"; ctx.fillStyle = "#ddd";
  ctx.fillText("BARLO · Diagnostic foncier automatisé", W - pad, BY + BH - 16);
}
// ─── LÉGENDE + BOUSSOLE — SLIDE 4 AXO ────────────────────────────────────────
function drawLegendCompass(ctx, W, H, p) {
  const { site_area, bearing } = p;
  ctx.save();
  ctx.translate(W - 58, 58);
  ctx.shadowColor = "rgba(0,0,0,0.15)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.96)"; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1; ctx.stroke();
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -3); ctx.lineTo(0, -8); ctx.lineTo(5, -3); ctx.closePath();
  ctx.fillStyle = "#d02818"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 3); ctx.lineTo(0, 8); ctx.lineTo(5, 3); ctx.closePath();
  ctx.fillStyle = "#ccc"; ctx.fill();
  ctx.rotate((bearing || 0) * Math.PI / 180);
  ctx.font = "bold 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#d02818";
  ctx.fillText("N", 0, -22);
  ctx.restore();
  const legItems = [
    { type: "rect", fill: "rgba(208,40,24,0.2)", stroke: "#d02818", label: "Parcelle — " + site_area + " m²" },
    { type: "dash", stroke: "#d02818", label: "Enveloppe constructible" },
    { type: "rect", fill: "#e8e4dc", stroke: "#c8c4bc", label: "Bâtiment existant" },
  ];
  const legPad = 14, legLH = 26, legW = 300;
  const legH = legPad * 2 + legItems.length * legLH + 10;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.08)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
  ctx.fillStyle = "rgba(255,255,255,0.97)";
  ctx.beginPath(); ctx.roundRect(16, 16, legW, legH, 8); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#e4e0d8"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
  legItems.forEach(function(item, i) {
    const iy = 16 + legPad + i * legLH;
    ctx.save();
    if (item.type === "rect") {
      ctx.fillStyle = item.fill; ctx.beginPath(); ctx.roundRect(28, iy, 16, 13, 2); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(28, iy + 6); ctx.lineTo(44, iy + 6);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2.5; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
    ctx.font = "12px Arial"; ctx.fillStyle = "#444"; ctx.textAlign = "left";
    ctx.fillText(item.label, 52, iy + 11);
  });
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© Mapbox  © OpenStreetMap contributors", 28, 16 + legH - 6);
}
// ─── ARC SOLAIRE ──────────────────────────────────────────────────────────────
function drawSolarArc(ctx, W, H, p) {
  const { bearing } = p;
  const SX = W - 110, SY = H - 110, SR = 68;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.10)"; ctx.shadowBlur = 10;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath(); ctx.arc(SX, SY, SR + 12, 0, 2 * Math.PI); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#e8e4dc"; ctx.lineWidth = 1; ctx.stroke();
  const northRad = -(bearing) * Math.PI / 180 - Math.PI / 2;
  const sunriseAngle = northRad + Math.PI / 2;
  const sunsetAngle  = northRad + 3 * Math.PI / 2;
  ctx.beginPath(); ctx.arc(SX, SY, SR - 6, sunriseAngle, sunsetAngle);
  ctx.strokeStyle = "rgba(255,170,0,0.15)"; ctx.lineWidth = 14; ctx.stroke();
  ctx.beginPath(); ctx.arc(SX, SY, SR - 6, sunriseAngle, sunsetAngle);
  const grad = ctx.createLinearGradient(
    SX + Math.cos(sunriseAngle) * SR, SY + Math.sin(sunriseAngle) * SR,
    SX + Math.cos(sunsetAngle)  * SR, SY + Math.sin(sunsetAngle)  * SR);
  grad.addColorStop(0, "rgba(220,120,0,0.5)"); grad.addColorStop(0.5, "rgba(230,170,0,0.8)"); grad.addColorStop(1, "rgba(200,80,0,0.5)");
  ctx.strokeStyle = grad; ctx.lineWidth = 5; ctx.stroke();
  const sunAngle = northRad + Math.PI;
  const sunX = SX + Math.cos(sunAngle) * (SR - 6), sunY = SY + Math.sin(sunAngle) * (SR - 6);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(sunX + Math.cos(a) * 6, sunY + Math.sin(a) * 6);
    ctx.lineTo(sunX + Math.cos(a) * 10, sunY + Math.sin(a) * 10);
    ctx.strokeStyle = "rgba(200,140,0,0.7)"; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.fillStyle = "#e8b800"; ctx.beginPath(); ctx.arc(sunX, sunY, 5, 0, 2 * Math.PI); ctx.fill();
  [
    { label: "N", angle: northRad, color: "#d02818", font: "bold 11px Arial" },
    { label: "S", angle: northRad + Math.PI, color: "#aaa", font: "9px Arial" },
    { label: "E", angle: sunriseAngle, color: "#b08020", font: "bold 10px Arial" },
    { label: "O", angle: sunsetAngle, color: "#b08020", font: "bold 10px Arial" },
  ].forEach(function(l) {
    const lx = SX + Math.cos(l.angle) * (SR + 4), ly = SY + Math.sin(l.angle) * (SR + 4);
    ctx.font = l.font; ctx.fillStyle = l.color; ctx.textAlign = "center"; ctx.fillText(l.label, lx, ly + 4);
  });
  ctx.font = "7px Arial"; ctx.fillStyle = "#ccc"; ctx.textAlign = "center";
  ctx.fillText("ENSOLEILLEMENT", SX, SY + SR + 18);
  ctx.restore();
}
// ─── OVERLAYS CANVAS — MASSING ────────────────────────────────────────────────
function drawMassingOverlays(ctx, W, H, { site_area, bearing, label, levels, commerce_levels, habitation_levels, total_height, floor_height, fp_m2, accent_color, scenario_role }) {
  ctx.save();
  ctx.translate(W - 58, 58);
  ctx.shadowColor = "rgba(0,0,0,0.15)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.96)"; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1; ctx.stroke();
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -3); ctx.lineTo(0, -8); ctx.lineTo(5, -3); ctx.closePath();
  ctx.fillStyle = "#d02818"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 3); ctx.lineTo(0, 8); ctx.lineTo(5, 3); ctx.closePath();
  ctx.fillStyle = "#ccc"; ctx.fill();
  ctx.rotate((bearing || 0) * Math.PI / 180);
  ctx.font = "bold 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#d02818"; ctx.fillText("N", 0, -22);
  ctx.restore();
  const legItems = [
    { fill: "rgba(208,40,24,0.22)", stroke: "#d02818", dash: false, label: `Parcelle — ${site_area} m²` },
    { fill: "rgba(208,40,24,0.0)",  stroke: "#d02818", dash: true,  label: "Enveloppe constructible" },
    commerce_levels > 0 && { fill: "#e8a030", stroke: "#c07020", dash: false, label: `Commerce — ${commerce_levels} niv. (RDC)` },
    { fill: "#ffffff", stroke: "#333", dash: false, label: `Habitation — ${habitation_levels} niv.` },
  ].filter(Boolean);
  const legPad = 14, legLH = 26, legW = 340;
  const legH = legPad * 2 + legItems.length * legLH + 52;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.08)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
  ctx.fillStyle = "rgba(255,255,255,0.97)";
  ctx.beginPath(); ctx.roundRect(16, 16, legW, legH, 8); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#e4e0d8"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
  ctx.font = "bold 14px Arial"; ctx.fillStyle = accent_color || "#2a5298"; ctx.textAlign = "left";
  ctx.fillText(`Option ${label}`, 28, 16 + legPad + 2);
  ctx.font = "12px Arial"; ctx.fillStyle = "#555";
  ctx.fillText(`${levels} niv. · H=${total_height}m · Empreinte ${fp_m2}m²`, 28, 16 + legPad + 18);
  if (scenario_role) { ctx.font = "italic 11px Arial"; ctx.fillStyle = "#888"; ctx.fillText(scenario_role, 28, 16 + legPad + 34); }
  legItems.forEach((item, i) => {
    const iy = 16 + legPad + 48 + i * legLH;
    ctx.save();
    ctx.fillStyle = item.fill; ctx.beginPath(); ctx.roundRect(28, iy, 16, 13, 2); ctx.fill();
    if (item.dash) ctx.setLineDash([4, 2]);
    ctx.strokeStyle = item.stroke; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    ctx.font = "12px Arial"; ctx.fillStyle = "#444"; ctx.textAlign = "left";
    ctx.fillText(item.label, 52, iy + 11);
  });
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© Mapbox  © OpenStreetMap", 28, 16 + legH - 6);
  drawSolarArc(ctx, W, H, { bearing });
}
// ─── ENDPOINT /generate — SLIDE 4 AXO ────────────────────────────────────────
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("═══ /generate v49 (style-ref) ═══");
  const {
    lead_id, client_name, polygon_points, site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp, setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    slide_name = "slide_4_axo",
    zoom: zoomOverride = null,
    style_ref_url = null,
  } = req.body;
  if (!lead_id || !polygon_points) return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });
  if (!MAPBOX_TOKEN) return res.status(500).json({ error: "MAPBOX_TOKEN manquant" });
  if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: "BROWSERLESS_TOKEN manquant" });
  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
  if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });
  const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
  const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
  const envelopeCoords = computeEnvelope(coords, cLat, cLon, Number(setback_front), Number(setback_side), Number(setback_back));
  const zoom = zoomOverride ? Number(zoomOverride) : computeZoom(coords, cLat, cLon);
  const bearing = computeBearing(coords, cLat, cLon);
  console.log(`zoom=${zoom} bearing=${bearing}° pitch=58°`);
  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}` });
    console.log(`Connected (${Date.now() - t0}ms)`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1280, deviceScaleFactor: 1 });
    const html = generateMapHTML({ lat: cLat, lon: cLon }, zoom, bearing, coords, envelopeCoords, MAPBOX_TOKEN);
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForFunction("window.__MAP_READY === true", { timeout: 28000 });
    const screenshotBuf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 1280 } });
    console.log(`Screenshot: ${screenshotBuf.length} bytes (${Date.now() - t0}ms)`);
    await page.close();
    const W = 1280, H = 1280;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(await loadImage(screenshotBuf), 0, 0);
    drawLegendCompass(ctx, W, H, { site_area: Number(site_area), bearing });
    const png = canvas.toBuffer("image/png");
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const slug = String(client_name || "client").toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const basePath = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;
    const { error: ue } = await sb.storage.from("massing-images").upload(basePath, png, { contentType: "image/png", upsert: true });
    if (ue) return res.status(500).json({ error: ue.message });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
    let enhancedUrl = pd.publicUrl;
    if (OPENAI_API_KEY) {
      try {
        const resizedCanvas = createCanvas(1024, 1024);
        resizedCanvas.getContext("2d").drawImage(await loadImage(png), 0, 0, 1280, 1280, 0, 0, 1024, 1024);
        const pngResized = resizedCanvas.toBuffer("image/png");
        const form = new FormData();
        form.append("model", "gpt-image-1");
        form.append("image", pngResized, { filename: "slide.png", contentType: "image/png" });
        if (style_ref_url) {
          try {
            const refRes = await fetch(style_ref_url);
            if (refRes.ok) {
              const refBuf = Buffer.from(await refRes.arrayBuffer());
              const refCanvas = createCanvas(1024, 1024);
              refCanvas.getContext("2d").drawImage(await loadImage(refBuf), 0, 0, 1024, 1024);
              form.append("image", refCanvas.toBuffer("image/png"), { filename: "style_ref.png", contentType: "image/png" });
            }
          } catch (e) { console.warn("Style ref fetch error:", e.message); }
        }
        form.append("size", "1024x1024");
        form.append("input_fidelity", "high");
        form.append("prompt", "Restyle this axonometric urban planning map into a premium architectural site analysis illustration.\n\nGEOMETRY - ABSOLUTE CONSTRAINTS:\n- Keep EXACTLY the same camera angle, pitch, bearing and composition\n- Keep EXACTLY the same building footprints, positions and heights\n- Keep EXACTLY the same road network layout and widths\n- Do NOT move, add or remove any building or road\n\nPARCEL ZONE - NON-NEGOTIABLE:\n- There is a RED/PINK semi-transparent zone visible on the ground\n- DO NOT MOVE IT under any circumstances\n- DO NOT RESIZE IT\n- DO NOT RECOLOR IT beyond keeping it red/pink semi-transparent\n- It must stay at EXACTLY the same position, same shape, same size\n- The dashed red outline around it must also stay at exact same position\n- This zone is GPS-fixed and must not drift even 1 pixel\n\nBUILDINGS - MANDATORY:\n- Building rooftops: BRIGHT PURE WHITE #ffffff\n- Building sunlit faces: PURE WHITE #ffffff to #faf9f6\n- Building shadow faces: warm gray #9a9690\n- Building EDGES: MANDATORY strong black lines #1a1a1a on ALL edges and corners\n- Cast shadows: solid warm gray #c4c0b8\n\nGROUND AND VEGETATION - MANDATORY:\n- Ground inside blocks: fresh vivid green #7ab83a, slightly warm, natural sunlit grass\n- Grass texture: visible fine grain #6aa030\n- Trees: round canopy top-view, dark green #3d7a1a with highlight #5aaa28, vary sizes\n- Place trees densely along sidewalks and in open spaces - at least 30 trees\n- Ground is predominantly GREEN inside blocks\n\nROADS - MANDATORY:\n- Road surface: warm sandy beige #d4c49a with asphalt grain texture\n- Road borders: darker #b8a478, sharp edge\n- Sidewalks: cream strip #ede4cc\n- Roads are clearly sandy/beige, strong contrast with green blocks\n- Road grid is prominent and legible\n\nBLOCK STRUCTURE - MANDATORY:\n- Each block is surrounded by roads on all 4 sides\n- Green stays strictly inside blocks, never crosses roads\n- Block boundaries are sharp hard lines\n\nNo text, no labels, no annotations.");
        const oaiRes = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST", headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() }, body: form,
        });
        const oaiJson = await oaiRes.json();
        if (oaiJson.data && oaiJson.data[0] && oaiJson.data[0].b64_json) {
          const enhancedMapBuf = Buffer.from(oaiJson.data[0].b64_json, "base64");
          const finalCanvas = createCanvas(W, H);
          const finalCtx = finalCanvas.getContext("2d");
          finalCtx.drawImage(await loadImage(enhancedMapBuf), 0, 0, W, H);
          drawLegendCompass(finalCtx, W, H, { site_area: Number(site_area), bearing });
          drawSolarArc(finalCtx, W, H, { bearing });
          const finalPng = finalCanvas.toBuffer("image/png");
          const enhancedPath = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}_enhanced.png`;
          const { error: ue2 } = await sb.storage.from("massing-images").upload(enhancedPath, finalPng, { contentType: "image/png", upsert: true });
          if (!ue2) {
            const { data: pd2 } = sb.storage.from("massing-images").getPublicUrl(enhancedPath);
            enhancedUrl = pd2.publicUrl;
          }
        }
      } catch (oaiErr) { console.warn("OpenAI error:", oaiErr.message); }
    }
    return res.json({ ok: true, public_url: pd.publicUrl, enhanced_url: enhancedUrl, path: basePath, centroid: { lat: cLat, lon: cLon }, view: { zoom, bearing, pitch: 58 }, duration_ms: Date.now() - t0 });
  } catch (e) {
    console.error("Error:", e.message || e);
    return res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (browser) { try { browser.disconnect(); } catch (_) {} }
  }
});
// ─── ENDPOINT /generate-massing — SCÉNARIOS A/B/C ────────────────────────────
app.post("/generate-massing", async (req, res) => {
  const t0 = Date.now();
  console.log("═══ /generate-massing v53 ═══", JSON.stringify(req.body).slice(0, 300));
  const {
    lead_id, client_name, polygon_points,
    site_area, setback_front, setback_side, setback_back,
    envelope_w, envelope_d,
    massing_label = "A", slide_name,
    style_ref_url = null,
    // ── Mode classique (valeurs pré-calculées par la sheet) ──
    fp_m2: fp_m2_raw, massing_levels: levels_raw, height_m: height_raw,
    commerce_levels: commerce_raw = 0, floor_height: fh_raw = 3.2,
    scenario_role: role_raw = "", accent_color: accent_raw = "#2a5298",
    // ── Mode smart (calcul serveur) ──
    compute_scenario = false,
    zoning_type = "URBAIN",
    // ── Tous les paramètres PIPELINE pour le moteur intelligent ──
    primary_driver, max_floors, max_height_m,
    program_main, target_surface_m2, target_units,
    site_saturation_level, financial_rigidity_score,
    density_band, risk_adjusted, feasibility_posture,
    scenario_A_role, scenario_B_role, scenario_C_role,
    budget_range, budget_band, budget_tension,
    standing_level, rent_score, capacity_score,
    mix_score, phase_score, risk_score,
    density_pressure_factor, driver_intensity, strategic_position,
  } = req.body;
  if (!lead_id || !polygon_points) return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });
  if (!envelope_w || !envelope_d) return res.status(400).json({ error: "envelope_w, envelope_d obligatoires" });
  const envW = Number(envelope_w);
  const envD = Number(envelope_d);
  const floorH = Number(fh_raw) || 3.2;
  const label = String(massing_label).toUpperCase();

  // ── Déterminer les paramètres du scénario ──
  let fp, levels, totalH, commerceLevels, scenarioRole, accentColor;

  if (compute_scenario || !fp_m2_raw || !levels_raw) {
    // MODE SMART : le moteur calcule tout
    if (!site_area) return res.status(400).json({ error: "site_area obligatoire en mode compute_scenario" });
    const scenarios = computeSmartScenarios({
      site_area: Number(site_area),
      envelope_w: envW,
      envelope_d: envD,
      zoning_type: String(zoning_type),
      floor_height: floorH,
      primary_driver: primary_driver || "MAX_CAPACITE",
      max_floors: Number(max_floors) || 99,
      max_height_m: Number(max_height_m) || 99,
      program_main: program_main || "",
      target_surface_m2: Number(target_surface_m2) || 0,
      target_units: Number(target_units) || 0,
      site_saturation_level: site_saturation_level || "MEDIUM",
      financial_rigidity_score: Number(financial_rigidity_score) || 0,
      density_band: density_band || "",
      risk_adjusted: Number(risk_adjusted) || 0,
      feasibility_posture: feasibility_posture || "BALANCED",
      scenario_A_role: scenario_A_role || "",
      scenario_B_role: scenario_B_role || "",
      scenario_C_role: scenario_C_role || "",
      budget_range: Number(budget_range) || 0,
      budget_band: budget_band || "",
      budget_tension: Number(budget_tension) || 0,
      standing_level: standing_level || "STANDARD",
      rent_score: Number(rent_score) || 0,
      capacity_score: Number(capacity_score) || 0,
      mix_score: Number(mix_score) || 0,
      phase_score: Number(phase_score) || 0,
      risk_score: Number(risk_score) || 0,
      density_pressure_factor: Number(density_pressure_factor) || 1,
      driver_intensity: driver_intensity || "MEDIUM",
      strategic_position: strategic_position || "",
    });
    const sc = scenarios[label] || scenarios.A;
    fp = sc.fp_m2;
    levels = sc.levels;
    totalH = sc.height_m;
    commerceLevels = sc.commerce_levels;
    scenarioRole = sc.label_fr;
    accentColor = sc.accent_color;
    console.log(`SMART MODE: ${label} → fp=${fp}m² levels=${levels} h=${totalH}m commerce=${commerceLevels} (${sc.cos_compliance})`);
  } else {
    // MODE CLASSIQUE : valeurs de la sheet
    fp = Number(fp_m2_raw);
    levels = Number(levels_raw);
    totalH = Number(height_raw) || levels * floorH;
    commerceLevels = Number(commerce_raw);
    scenarioRole = String(role_raw);
    accentColor = String(accent_raw);
    console.log(`CLASSIC MODE: ${label} → fp=${fp}m² levels=${levels} h=${totalH}m`);
  }

  const slideName = slide_name || ("massing_" + label.toLowerCase());
  const commerceH = commerceLevels * floorH;
  const habitationLevels = levels - commerceLevels;
  const { w: mw, d: md, offset_x: ox, offset_y: oy } = computeMassingDimensions(fp, envW, envD);
  console.log(`fp_m2=${fp} → ${mw}m×${md}m offset[${ox.toFixed(1)},${oy.toFixed(1)}]`);
  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
  if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });
  const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
  const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
  const envelopeCoords = computeEnvelope(coords, cLat, cLon, Number(setback_front), Number(setback_side), Number(setback_back));
  // ── DIAGNOSTIC : vérifier que l'enveloppe est à l'intérieur de la parcelle ──
  const envPtsDbg = envelopeCoords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const envMinX = Math.min(...envPtsDbg.map(p => p.x)), envMaxX = Math.max(...envPtsDbg.map(p => p.x));
  const envMinY = Math.min(...envPtsDbg.map(p => p.y)), envMaxY = Math.max(...envPtsDbg.map(p => p.y));
  const actualEnvW = envMaxX - envMinX, actualEnvD = envMaxY - envMinY;
  console.log(`┌── ENVELOPE DIAGNOSTIC ──`);
  console.log(`│ Sheet envelope: ${envW}m × ${envD}m`);
  console.log(`│ Actual computed envelope bbox: ${actualEnvW.toFixed(1)}m × ${actualEnvD.toFixed(1)}m`);
  console.log(`│ Parcel centroid: ${cLat.toFixed(7)}, ${cLon.toFixed(7)}`);
  console.log(`│ Setbacks: front=${setback_front} side=${setback_side} back=${setback_back}`);
  coords.forEach((c, i) => console.log(`│ Parcel[${i}]: ${c.lat.toFixed(7)}, ${c.lon.toFixed(7)}`));
  console.log(`└── end ENVELOPE DIAGNOSTIC ──`);
  const bearing = computeBearing(coords, cLat, cLon);
  const zoom = computeZoom(coords, cLat, cLon);
  console.log(`Map view: bearing=${bearing}° zoom=${zoom}`);
  const massingCoords = computeMassingPolygon(envelopeCoords, cLat, cLon, bearing, mw, md, ox, oy);
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const slug = String(client_name || "client").toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const folder = `hektar/${String(lead_id).trim()}_${slug}`;
  const basePath = `${folder}/${slideName}.png`;
  const enhancedPath = `${folder}/${slideName}_enhanced.png`;
  // Cache disabled for debugging
  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}` });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1280, deviceScaleFactor: 1 });
    const html = generateMassingHTML({ lat: cLat, lon: cLon }, zoom, bearing, coords, envelopeCoords, massingCoords,
      { total_height: totalH, commerce_levels: commerceLevels, floor_height: floorH, accent_color: accentColor }, MAPBOX_TOKEN);
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForFunction("window.__MAP_READY === true", { timeout: 28000 });
    const screenshotBuf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 1280 } });
    await page.close();
    const W = 1280, H = 1280;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(await loadImage(screenshotBuf), 0, 0, W, H);
    drawMassingOverlays(ctx, W, H, {
      site_area: Number(site_area), bearing, label,
      levels, commerce_levels: commerceLevels, habitation_levels: habitationLevels,
      total_height: totalH, floor_height: floorH, fp_m2: Math.round(fp), accent_color: accentColor, scenario_role: scenarioRole,
    });
    const png = canvas.toBuffer("image/png");
    await sb.storage.from("massing-images").upload(basePath, png, { contentType: "image/png", upsert: true });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
    let enhancedUrl = pd.publicUrl;
    if (OPENAI_API_KEY) {
      try {
        const resizedCanvas = createCanvas(1024, 1024);
        resizedCanvas.getContext("2d").drawImage(await loadImage(png), 0, 0, W, H, 0, 0, 1024, 1024);
        const pngResized = resizedCanvas.toBuffer("image/png");
        const form = new FormData();
        form.append("model", "gpt-image-1");
        form.append("image", pngResized, { filename: "massing.png", contentType: "image/png" });
        if (style_ref_url) {
          try {
            const refRes = await fetch(style_ref_url);
            if (refRes.ok) {
              const refBuf = Buffer.from(await refRes.arrayBuffer());
              const rCanvas = createCanvas(1024, 1024);
              rCanvas.getContext("2d").drawImage(await loadImage(refBuf), 0, 0, 1024, 1024);
              form.append("image", rCanvas.toBuffer("image/png"), { filename: "style_ref.png", contentType: "image/png" });
            }
          } catch (e) { console.warn("Style ref error:", e.message); }
        }
        form.append("size", "1024x1024");
        form.append("input_fidelity", "high");
        form.append("prompt",
          "Restyle this axonometric urban planning map into a premium architectural massing illustration.\n\n" +
          "GEOMETRY — ABSOLUTE CONSTRAINTS:\n- Keep EXACTLY the same camera angle, pitch, bearing and composition\n- Keep EXACTLY the same building footprints, positions and heights\n- Keep EXACTLY the same road network layout and widths\n- Do NOT move, add or remove any building or road\n\n" +
          "PARCEL ZONE — NON-NEGOTIABLE:\n- The RED/PINK semi-transparent zone on the ground must NOT MOVE\n- DO NOT MOVE IT, DO NOT RESIZE IT, DO NOT RECOLOR IT\n- GPS-fixed, must not drift even 1 pixel\n- The dashed red outline must also stay at exact same position\n\n" +
          "PROPOSED MASSING — CRITICAL:\n- There is a NEW BUILDING VOLUME on the parcel — the architectural proposal\n- Keep its exact position, footprint and height — do NOT alter it\n- Orange/warm levels = COMMERCE floors (ground floor)\n- White levels = HABITATION floors\n- Add visible horizontal lines on building faces to show each floor\n- Strong black edges #1a1a1a on all proposed building corners\n- The proposed building must clearly stand out from surrounding buildings\n\n" +
          "EXISTING BUILDINGS:\n- Rooftops: BRIGHT PURE WHITE #ffffff with strong black edges\n- Sunlit faces: PURE WHITE #ffffff to #faf9f6\n- Shadow faces: warm gray #9a9690\n- EDGES: MANDATORY strong black lines #1a1a1a on ALL edges and corners\n- Cast shadows: solid warm gray #c4c0b8\n\n" +
          "GROUND AND VEGETATION:\n- Ground inside blocks: fresh vivid green #7ab83a, natural sunlit grass\n- Trees: round canopy dark green #3d7a1a with highlight #5aaa28, vary sizes\n- Place trees densely along sidewalks — at least 30 trees\n\n" +
          "ROADS:\n- Road surface: warm sandy beige #d4c49a\n- Road borders: darker #b8a478, sharp edge\n- Sidewalks: cream strip #ede4cc\n\nNo text, no labels, no annotations."
        );
        const oaiRes = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST", headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() }, body: form,
        });
        const oaiJson = await oaiRes.json();
        if (oaiJson.data?.[0]?.b64_json) {
          const enhBuf = Buffer.from(oaiJson.data[0].b64_json, "base64");
          const fCanvas = createCanvas(W, H);
          fCanvas.getContext("2d").drawImage(await loadImage(enhBuf), 0, 0, W, H);
          drawMassingOverlays(fCanvas.getContext("2d"), W, H, {
            site_area: Number(site_area), bearing, label,
            levels, commerce_levels: commerceLevels, habitation_levels: habitationLevels,
            total_height: totalH, floor_height: floorH, fp_m2: Math.round(fp), accent_color: accentColor, scenario_role: scenarioRole,
          });
          const finalPng = fCanvas.toBuffer("image/png");
          const { error: ue2 } = await sb.storage.from("massing-images").upload(enhancedPath, finalPng, { contentType: "image/png", upsert: true });
          if (!ue2) {
            const { data: pd2 } = sb.storage.from("massing-images").getPublicUrl(enhancedPath);
            enhancedUrl = pd2.publicUrl;
            console.log(`✓ Enhanced: ${enhancedUrl} (${Date.now() - t0}ms)`);
          }
        }
      } catch (oaiErr) { console.warn("OpenAI error:", oaiErr.message); }
    }
    return res.json({
      ok: true, cached: false, public_url: pd.publicUrl, enhanced_url: enhancedUrl,
      massing_label: label, fp_m2: fp, mw, md, offset_x: ox, offset_y: oy,
      levels, total_height: totalH, commerce_levels: commerceLevels,
      scenario_role: scenarioRole, accent_color: accentColor,
      centroid: { lat: cLat, lon: cLon },
      view: { zoom, bearing, pitch: 58 }, duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error("Error:", e.message);
    return res.status(500).json({ error: String(e.message) });
  } finally {
    if (browser) { try { browser.disconnect(); } catch (_) {} }
  }
});
// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`BARLO v53-massing on port ${PORT}`);
  console.log(`Browserless: ${BROWSERLESS_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Mapbox:      ${MAPBOX_TOKEN ? "OK" : "MISSING"}`);
  console.log(`OpenAI:      ${OPENAI_API_KEY ? "OK" : "MISSING"}`);
});
