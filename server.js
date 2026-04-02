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
app.get("/health", (req, res) => res.json({ ok: true, engine: "browserless-mapbox-gl-3d", version: "58.3-HEKTAR-POLISH" }));
// ─── DIAGNOSTIC MASSING : trace complète du calcul de polygone bâti ─────────
app.post("/diag-massing", (req, res) => {
  try {
    const { polygon_points, site_area, setback_front = 3, setback_side = 3, setback_back = 3,
      fp_m2 = 1147, envelope_w = 24, envelope_d = 24 } = req.body;
    if (!polygon_points) return res.status(400).json({ error: "polygon_points requis" });
    const coords = polygon_points.split("|").map(pt => {
      const [lat, lon] = pt.trim().split(",").map(Number);
      return { lat, lon };
    }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
    if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });
    const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
    const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
    // Parcelle en mètres
    const parcelM = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
    const parcelMinX = Math.min(...parcelM.map(p => p.x)), parcelMaxX = Math.max(...parcelM.map(p => p.x));
    const parcelMinY = Math.min(...parcelM.map(p => p.y)), parcelMaxY = Math.max(...parcelM.map(p => p.y));
    // Enveloppe
    const envelopeCoords = computeEnvelope(coords, cLat, cLon, Number(setback_front), Number(setback_side), Number(setback_back));
    const envM = envelopeCoords.map(c => toM(c.lat, c.lon, cLat, cLon));
    const envMinX = Math.min(...envM.map(p => p.x)), envMaxX = Math.max(...envM.map(p => p.x));
    const envMinY = Math.min(...envM.map(p => p.y)), envMaxY = Math.max(...envM.map(p => p.y));
    // Aire réelle enveloppe
    let envAreaShoelace = 0;
    for (let i = 0; i < envM.length; i++) {
      const j = (i + 1) % envM.length;
      envAreaShoelace += envM[i].x * envM[j].y - envM[j].x * envM[i].y;
    }
    envAreaShoelace = Math.abs(envAreaShoelace) / 2;
    // Massing polygon
    const fp = Number(fp_m2);
    const massingCoords = computeMassingPolygon(envelopeCoords, fp, envAreaShoelace, {
      massing_mode: "BALANCED", primary_driver: "MAX_CAPACITE", levels: 4,
      standing_level: "STANDARD", program_main: "", site_saturation: "MEDIUM",
      project_type: "NEUF", existing_fp_m2: 0,
    });
    // Massing en mètres pour vérifier les dimensions
    const massingM = massingCoords.map(c => toM(c.lat, c.lon, cLat, cLon));
    const masMinX = Math.min(...massingM.map(p => p.x)), masMaxX = Math.max(...massingM.map(p => p.x));
    const masMinY = Math.min(...massingM.map(p => p.y)), masMaxY = Math.max(...massingM.map(p => p.y));
    let masAreaShoelace = 0;
    for (let i = 0; i < massingM.length; i++) {
      const j = (i + 1) % massingM.length;
      masAreaShoelace += massingM[i].x * massingM[j].y - massingM[j].x * massingM[i].y;
    }
    masAreaShoelace = Math.abs(masAreaShoelace) / 2;
    res.json({
      server_version: "57.13",
      input: { fp_m2: fp, site_area: Number(site_area), setbacks: { front: Number(setback_front), side: Number(setback_side), back: Number(setback_back) } },
      parcel: {
        centroid: { lat: cLat, lon: cLon },
        bbox_m: { w: (parcelMaxX - parcelMinX).toFixed(1), d: (parcelMaxY - parcelMinY).toFixed(1) },
        vertices_m: parcelM.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })),
      },
      envelope: {
        vertices_count: envelopeCoords.length,
        bbox_m: { w: (envMaxX - envMinX).toFixed(1), d: (envMaxY - envMinY).toFixed(1) },
        area_m2: +envAreaShoelace.toFixed(0),
        vertices_m: envM.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })),
        vertices_gps: envelopeCoords.map(c => ({ lat: +c.lat.toFixed(7), lon: +c.lon.toFixed(7) })),
      },
      massing: {
        typology: massingCoords._typology,
        reason: massingCoords._reason,
        bbox_m: { w: (masMaxX - masMinX).toFixed(1), d: (masMaxY - masMinY).toFixed(1) },
        area_m2: +masAreaShoelace.toFixed(0),
        fill_ratio: +(masAreaShoelace / envAreaShoelace).toFixed(3),
        target_ratio: +(fp / envAreaShoelace).toFixed(3),
        vertices_m: massingM.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })),
        vertices_gps: massingCoords.filter(c => c.lat).map(c => ({ lat: +c.lat.toFixed(7), lon: +c.lon.toFixed(7) })),
      },
      sheet_vs_real: {
        sheet_envelope: { w: Number(envelope_w), d: Number(envelope_d), area: Number(envelope_w) * Number(envelope_d) },
        real_envelope: { w: +(envMaxX - envMinX).toFixed(1), d: +(envMaxY - envMinY).toFixed(1), area: +envAreaShoelace.toFixed(0) },
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split("\n").slice(0, 5) });
  }
});
// ─── DIAGNOSTIC : tester compute-scenarios avec des valeurs par défaut ──────
app.get("/diag-scenarios", (req, res) => {
  const sa = Number(req.query.site_area) || 1950;
  const ew = Number(req.query.ew) || 55;
  const ed = Number(req.query.ed) || 55;
  const zt = req.query.zoning || "URBAIN";
  const pd = req.query.driver || "MAX_CAPACITE";
  const scenarios = computeSmartScenarios({
    site_area: sa, envelope_w: ew, envelope_d: ed,
    zoning_type: zt, floor_height: 3.2, primary_driver: pd,
    max_floors: 5, max_height_m: 16, program_main: "",
    target_surface_m2: 0, target_units: 0,
    site_saturation_level: "MEDIUM", financial_rigidity_score: 0.5,
    density_band: "MEDIUM", risk_adjusted: 0.5,
    feasibility_posture: "STANDARD",
    scenario_A_role: "INTENSIFICATION", scenario_B_role: "OPTIMISATION", scenario_C_role: "PRUDENT",
    budget_range: 0, budget_band: "MEDIUM", budget_tension: 0.5,
    standing_level: "STANDARD", rent_score: 0.5, capacity_score: 0.7,
    mix_score: 0.5, phase_score: 0.5, risk_score: 0.5,
    density_pressure_factor: 1, driver_intensity: "MEDIUM",
  });
  res.json({
    version: "57.13", zoning: zt, site_area: sa, envelope: `${ew}x${ed}`,
    CES: ZONING_CES[zt], COS: ZONING_COS[zt],
    fp_A: scenarios.A.fp_m2, fp_B: scenarios.B.fp_m2, fp_C: scenarios.C.fp_m2,
    levels_A: scenarios.A.levels, levels_B: scenarios.B.levels, levels_C: scenarios.C.levels,
    height_A: scenarios.A.height_m, height_B: scenarios.B.height_m, height_C: scenarios.C.height_m,
  });
});
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
  // ── v56.3 FIX: Détecter le sens de rotation (CW vs CCW) ──
  // Shoelace sign: positif = CCW, négatif = CW
  let windingSum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    windingSum += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  // Si CW (windingSum < 0), on inverse le signe de l'offset pour aller vers l'intérieur
  const windingSign = windingSum >= 0 ? 1 : -1;
  console.log(`│ Envelope winding: ${windingSum >= 0 ? "CCW" : "CW"} (sign=${windingSign}) sum=${windingSum.toFixed(1)}`);
  let maxLat = -Infinity, rb = 0;
  for (let i = 0; i < n - 1; i++) {
    const ml = (coords[i].lat + coords[(i + 1) % n].lat) / 2;
    if (ml > maxLat) { maxLat = ml; rb = brng(coords[i], coords[(i + 1) % n]); }
  }
  function setSB(b) { let d = ((b - rb) + 360) % 360; if (d > 180) d = 360 - d; return d < 45 ? front : d < 135 ? side : back; }
  function offSeg(p1, p2, dist) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.sqrt(dx * dx + dy * dy) + 0.001;
    // windingSign garantit que l'offset va TOUJOURS vers l'intérieur
    const d = dist * windingSign;
    return { p1: { x: p1.x - dy / len * d, y: p1.y + dx / len * d }, p2: { x: p2.x - dy / len * d, y: p2.y + dx / len * d } };
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
  // ── v56.3 VALIDATION: vérifier que l'enveloppe est PLUS PETITE que la parcelle ──
  let envArea = 0, parcelArea = 0;
  for (let i = 0; i < envM.length; i++) {
    const j = (i + 1) % envM.length;
    envArea += envM[i].x * envM[j].y - envM[j].x * envM[i].y;
  }
  envArea = Math.abs(envArea) / 2;
  parcelArea = Math.abs(windingSum) / 2;
  console.log(`│ Envelope area=${envArea.toFixed(0)}m² vs Parcel area=${parcelArea.toFixed(0)}m² → ${envArea < parcelArea ? "OK (inside)" : "⚠ PROBLÈME (outside!)"}`);
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
  const mpp = (ext * 0.9) / 1280;  // x2 zoom — parcelle centrée et proche
  const z = Math.log2(156543.03 * Math.cos(cLat * Math.PI / 180) / mpp);
  return Math.min(19, Math.max(17, Math.round(z * 4) / 4));
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
// CES par zoning_type — Coefficient d'Emprise au Sol RÉGLEMENTAIRE (max autorisé)
const ZONING_CES = {
  URBAIN: 0.60, PERIURBAIN: 0.45, PAVILLON: 0.30,
  RURAL: 0.20, MIXTE: 0.50, Z_DEFAULT: 0.40,
};
// COS par zoning_type — Coefficient d'Occupation du Sol → contrôle la SDP TOTALE (plancher tous niveaux)
const ZONING_COS = {
  URBAIN: 2.50, PERIURBAIN: 1.50, PAVILLON: 0.80,
  RURAL: 0.40, MIXTE: 2.00, Z_DEFAULT: 1.50,
};
// ══════════════════════════════════════════════════════════════════════════════
// v56.8 — RÉSERVE SOL + PILOTIS
// ══════════════════════════════════════════════════════════════════════════════
// v56.9.1 — QUALITÉ DE CIRCULATION PAR RÔLE
// ══════════════════════════════════════════════════════════════════════════════
// Le scénario A (INTENSIFICATION) = la meilleure version du programme client :
//   → circulation plus généreuse (halls, paliers, rangements communs)
//   → balcons/terrasses intégrés dans le fp
//   → résultat : un bâtiment plus qualitatif, donc un peu plus grand en fp
// Le scénario B = standard marché
// Le scénario C = compact, optimisé coût
// ══════════════════════════════════════════════════════════════════════════════
const CIRCULATION_BONUS_BY_ROLE = {
  INTENSIFICATION: 0.05,  // +5% de circulation en plus (lobby, paliers larges, rangements)
  EQUILIBRE: 0,            // standard
  PRUDENT: -0.02,          // -2% (couloirs plus étroits, optimisé)
};
// ══════════════════════════════════════════════════════════════════════════════
// CES_FILL_BY_ROLE : quel % du CES autorisé on occupe réellement au sol
// C'est le PREMIER levier de différenciation entre scénarios.
// Combiné avec UNIT_SIZES (2e levier), ça donne des scénarios réalistes :
//   A → grosse empreinte + grands apparts = ambitieux
//   B → empreinte standard + tailles marché = équilibré
//   C → empreinte réduite + compact = prudent/phasable
// ══════════════════════════════════════════════════════════════════════════════
const CES_FILL_BY_ROLE = {
  INTENSIFICATION: 0.95,  // occupe 95% du CES autorisé (quasi max, 5% marge technique)
  EQUILIBRE: 0.80,         // 80% — retrait confortable
  PRUDENT: 0.65,           // 65% — empreinte réduite, plus d'espace libre
};
// ══════════════════════════════════════════════════════════════════════════════
// EXTENSION ÉTAGES : à partir du R+1, le bâtiment peut s'élargir vers les
// limites séparatives de la parcelle. Le RDC reste en retrait (parking, accès,
// jardin), mais les étages débordent — architecture courante en Afrique de l'Ouest.
//   A = étages jusqu'à l'enveloppe (limites séparatives)
//   B = +15% vs le RDC (extension modérée)
//   C = pas d'extension (même empreinte que le RDC)
// ══════════════════════════════════════════════════════════════════════════════
const ETAGE_EXTENSION_BY_ROLE = {
  INTENSIFICATION: "ENVELOPE",  // fp_etages = enveloppe constructible
  EQUILIBRE: 1.15,               // fp_etages = fp_rdc × 1.15
  PRUDENT: 1.00,                  // fp_etages = fp_rdc (pas d'extension)
};
// ══════════════════════════════════════════════════════════════════════════════
// Le CES réglementaire = max autorisé, PAS ce qu'on doit construire.
// En pratique, on réserve toujours de l'espace au sol pour :
//   - Parking (obligatoire en ville)
//   - Circulation véhicules/piétons
//   - Espaces verts, cour, aire de jeux
//   - Accès pompiers
//
// RÉSERVE = % de l'enveloppe réservé aux aménagements extérieurs
// Varie selon : rôle scénario + standing + programme + zoning
//
// PILOTIS : quand la parcelle est trop étroite pour du parking en surface,
// le RDC est libéré en pilotis (colonnes ouvertes) et le bâtiment commence au R+1.
// Le RDC pilotis n'est PAS de la SDP, mais le parking est résolu.
// ══════════════════════════════════════════════════════════════════════════════
// Réserve sol de BASE par rôle (% de l'enveloppe)
const RESERVE_BY_ROLE = {
  INTENSIFICATION: 0.18,  // max bâti, mais accès + parking minimum
  EQUILIBRE: 0.27,        // bon compromis bâti/extérieur
  PRUDENT: 0.35,          // espaces verts généreux, phasable
};
// Bonus réserve par standing
const RESERVE_STANDING = {
  ECONOMIQUE: 0, ECO: 0,
  STANDARD: 0.05,
  HAUT: 0.10,
  PREMIUM: 0.15,          // jardins, piscine, dégagement
};
// Bonus réserve par programme
const RESERVE_PROGRAM = {
  DEFAULT: 0.05,                // minimum parking
  IMMEUBLE_RAPPORT: 0.05,      // parking résidents
  COLLECTIF: 0.08,             // parking + espaces communs
  MIXTE: 0.10,                 // parking client + livraison + parking résidents
  COMMERCE: 0.12,              // parking clients, accès livraison
  BUREAUX: 0.10,               // parking employés
  LOGEMENT_SOCIAL: 0.05,       // minimum
};
// Seuils pour la décision PILOTIS vs RDC OCCUPÉ
// Si l'espace libre au sol (après emprise bâtiment) < seuil, on passe en pilotis
const PILOTIS_CONFIG = {
  MIN_FREE_GROUND_M2: 150,     // minimum 150m² libres au sol pour ne PAS avoir besoin de pilotis
  MIN_FREE_GROUND_PCT: 0.25,   // OU minimum 25% de l'enveloppe libre
  MIN_PARKING_SPOTS: 4,        // nombre min de places de parking à prévoir
  PARKING_SPOT_M2: 25,         // ~12.5m² place + 12.5m² circulation
  PILOTIS_HEIGHT_M: 3.5,       // hauteur libre sous pilotis
};
// ══════════════════════════════════════════════════════════════════════════════
// v56.9 — SURFACES PAR TYPOLOGIE × STANDING × RÔLE SCÉNARIO
// ══════════════════════════════════════════════════════════════════════════════
// Rôle A (INTENSIFICATION) = surfaces GÉNÉREUSES (+15-20% vs standard marché)
// Rôle B (EQUILIBRE) = surfaces STANDARD (référence marché)
// Rôle C (PRUDENT) = surfaces COMPACTES (-10-15%, économie de construction)
const UNIT_SIZES = {
  ECONOMIQUE: {
    A: { T1: 32, T2: 55, T3: 72, T4: 90, T5: 110, STUDIO: 22, COMMERCE: 40, BUREAU: 20 },
    B: { T1: 28, T2: 48, T3: 65, T4: 82, T5: 100, STUDIO: 18, COMMERCE: 35, BUREAU: 16 },
    C: { T1: 24, T2: 42, T3: 58, T4: 72, T5: 88, STUDIO: 16, COMMERCE: 30, BUREAU: 14 },
  },
  STANDARD: {
    A: { T1: 42, T2: 72, T3: 95, T4: 120, T5: 148, STUDIO: 28, COMMERCE: 60, BUREAU: 25 },
    B: { T1: 35, T2: 60, T3: 80, T4: 100, T5: 125, STUDIO: 24, COMMERCE: 50, BUREAU: 20 },
    C: { T1: 30, T2: 52, T3: 70, T4: 88, T5: 108, STUDIO: 20, COMMERCE: 40, BUREAU: 16 },
  },
  PREMIUM: {
    A: { T1: 55, T2: 90, T3: 120, T4: 155, T5: 190, STUDIO: 38, COMMERCE: 80, BUREAU: 35 },
    B: { T1: 45, T2: 75, T3: 100, T4: 130, T5: 160, STUDIO: 32, COMMERCE: 65, BUREAU: 28 },
    C: { T1: 38, T2: 65, T3: 88, T4: 112, T5: 138, STUDIO: 26, COMMERCE: 55, BUREAU: 22 },
  },
};
// ══════════════════════════════════════════════════════════════════════════════
// v57.6 — LOYERS MARCHÉ DOUALA (FCFA/mois par typologie × standing)
// Source : estimations marché Cameroun 2024-2025, ajustables
// ══════════════════════════════════════════════════════════════════════════════
const LOYERS_MENSUELS_FCFA = {
  PREMIUM: { T1: 100000, T2: 150000, T3: 250000, T4: 350000, T5: 450000, STUDIO: 80000, COMMERCE: 400000, BUREAU: 300000 },
  STANDARD: { T1: 60000, T2: 100000, T3: 150000, T4: 200000, T5: 280000, STUDIO: 45000, COMMERCE: 250000, BUREAU: 180000 },
  ECO: { T1: 35000, T2: 60000, T3: 90000, T4: 130000, T5: 180000, STUDIO: 25000, COMMERCE: 150000, BUREAU: 100000 },
};
const VACANCY_RATE_BY_ZONING = {
  URBAIN: 0.10, PERIURBAIN: 0.15, PAVILLON: 0.20, RURAL: 0.25, MIXTE: 0.12,
};
// Fourchette de coûts construction : le costPerM2 du standing est le MEDIAN
// BAS = -15%, HAUT = +20% (aléas chantier, fondations, accès)
const COST_RANGE_MULT = { bas: 0.85, median: 1.0, haut: 1.20 };
// ══════════════════════════════════════════════════════════════════════════════
// v57.7 — RETRAITS RÉGLEMENTAIRES (SETBACKS) par zonage
// ══════════════════════════════════════════════════════════════════════════════
// En zone URBAIN Cameroun : retrait AVANT 3-5m, LATÉRAL 0-3m, ARRIÈRE 3m
// Mitoyenneté : en urbain dense, les murs pignons touchent la limite → retrait=0
// La combinaison retrait + mitoyenneté réduit l'emprise RÉELLE constructible
// ══════════════════════════════════════════════════════════════════════════════
const RETRAITS_M = {
  URBAIN:     { avant: 5, lateral: 3, arriere: 3, mitoyen_possible: true },
  PERIURBAIN: { avant: 6, lateral: 4, arriere: 4, mitoyen_possible: true },
  PAVILLON:   { avant: 8, lateral: 5, arriere: 5, mitoyen_possible: false },
  RURAL:      { avant: 10, lateral: 6, arriere: 6, mitoyen_possible: false },
  MIXTE:      { avant: 5, lateral: 3, arriere: 3, mitoyen_possible: true },
};
// Mitoyenneté : en zone urbaine dense, un ou deux côtés sont mitoyens
// → retrait latéral = 0 sur les côtés mitoyens
// On modélise le nombre de côtés mitoyens par zonage
const MITOYENNETE_SIDES = {
  URBAIN: 2,      // 2 côtés mitoyens (typique Douala centre)
  PERIURBAIN: 1,  // 1 côté mitoyen
  PAVILLON: 0,    // isolé
  RURAL: 0,
  MIXTE: 1,
};
// ══════════════════════════════════════════════════════════════════════════════
// v57.7 — VENTILATION COÛTS PAR POSTE (% du coût construction hors VRD)
// ══════════════════════════════════════════════════════════════════════════════
const COST_VENTILATION_PCT = {
  gros_oeuvre: 0.55,      // fondations, structure, maçonnerie, charpente
  second_oeuvre: 0.25,    // cloisons, menuiseries, revêtements, peinture
  lots_techniques: 0.15,  // plomberie, électricité, climatisation
  amenagements_ext: 0.05, // VRD, clôture, aménagements paysagers
};
// ══════════════════════════════════════════════════════════════════════════════
// v57.8 — HONORAIRES ARCHITECTE : barème international dégressif
// ══════════════════════════════════════════════════════════════════════════════
// v57.9 — HONORAIRES ARCHITECTE : barème FCFA réel (fourchette bas/haut)
// ══════════════════════════════════════════════════════════════════════════════
// Source : barème professionnel ONAC / UIA ajusté Cameroun
// Le taux effectif est la MÉDIANE de la fourchette (négociation standard)
// Inclut : esquisse, APS, APD, permis, DCE, suivi chantier, réception
// ══════════════════════════════════════════════════════════════════════════════
const HONORAIRES_TRANCHES_FCFA = [
  { seuil_max: 100_000_000,     taux_bas: 0.10, taux_haut: 0.15 },   // <100M → 10-15%
  { seuil_max: 500_000_000,     taux_bas: 0.08, taux_haut: 0.12 },   // 100-500M → 8-12%
  { seuil_max: 1_000_000_000,   taux_bas: 0.06, taux_haut: 0.10 },   // 500M-1Md → 6-10%
  { seuil_max: 5_000_000_000,   taux_bas: 0.05, taux_haut: 0.08 },   // 1-5Md → 5-8%
  { seuil_max: 10_000_000_000,  taux_bas: 0.04, taux_haut: 0.06 },   // 5-10Md → 4-6%
  { seuil_max: Infinity,        taux_bas: 0.03, taux_haut: 0.05 },   // >10Md → 3-5%
];
// Frais annexes : permis de construire, assurances, études techniques
const FRAIS_ANNEXES_PCT = {
  permis_construire: 0.015,        // ~1.5% du coût construction
  assurance_dommage_ouvrage: 0.02, // ~2% (obligatoire)
  etudes_techniques: 0.025,        // BET structure, fluides, géotechnique (~2.5%)
  divers_imprevus: 0.03,           // aléas administratifs, raccordements (~3%)
};
// Calcul honoraires dégressifs (retourne { bas, median, haut })
function calcHonorairesDegressifs(coutConstruction) {
  let honoBas = 0, honoHaut = 0;
  let reste = coutConstruction;
  let tranchePrecedente = 0;
  for (const tranche of HONORAIRES_TRANCHES_FCFA) {
    const montantTranche = Math.min(reste, tranche.seuil_max - tranchePrecedente);
    if (montantTranche <= 0) break;
    honoBas += montantTranche * tranche.taux_bas;
    honoHaut += montantTranche * tranche.taux_haut;
    reste -= montantTranche;
    tranchePrecedente = tranche.seuil_max;
  }
  const median = Math.round((honoBas + honoHaut) / 2);
  return { bas: Math.round(honoBas), median, haut: Math.round(honoHaut) };
}
// ══════════════════════════════════════════════════════════════════════════════
// v57.9 — ORIENTATION SOLAIRE & GÉOGRAPHIE DU SITE
// ══════════════════════════════════════════════════════════════════════════════
// L'orientation solaire impacte la géométrie du bâtiment :
// - En zone tropicale (Cameroun, lat ~4°N) : soleil quasi-zénithal
//   → Façades principales NORD-SUD (minimiser l'exposition est/ouest)
//   → Protéger la façade OUEST (soleil rasant l'après-midi = surchauffe)
//   → Profondeur de corps limitée (ventilation traversante)
//   → Toiture débordante (protection solaire)
// - En zone tempérée : optimiser l'apport solaire sud en hiver
// ══════════════════════════════════════════════════════════════════════════════
const SOLAR_CONFIG = {
  TROPICAL: {
    // Cameroun, Afrique de l'Ouest, zone équatoriale (lat < 15°)
    orientation_optimale: "NORD-SUD",       // façades principales
    facade_a_proteger: "OUEST",             // soleil rasant PM
    profondeur_max_m: 14,                   // ventilation traversante
    debord_toiture_m: 1.2,                  // protection solaire
    ratio_longueur_profondeur: 1.8,         // bâtiment allongé E-O → façades N-S
    malus_mauvaise_orientation_pct: 15,     // surcoût clim si mal orienté
    ventilation_traversante: true,
    brise_soleil_ouest: true,
  },
  TEMPERE: {
    orientation_optimale: "SUD",
    facade_a_proteger: "NORD",
    profondeur_max_m: 18,
    debord_toiture_m: 0.6,
    ratio_longueur_profondeur: 1.4,
    malus_mauvaise_orientation_pct: 8,
    ventilation_traversante: false,
    brise_soleil_ouest: false,
  },
  MEDITERRANEEN: {
    orientation_optimale: "SUD",
    facade_a_proteger: "OUEST",
    profondeur_max_m: 16,
    debord_toiture_m: 1.0,
    ratio_longueur_profondeur: 1.5,
    malus_mauvaise_orientation_pct: 10,
    ventilation_traversante: true,
    brise_soleil_ouest: true,
  },
};
// Détecter la zone climatique depuis le zoning ou le pays
function detectClimaticZone(zoning_type, country) {
  const c = String(country || "").toUpperCase();
  if (/CAMEROUN|CAMEROON|SENEGAL|COTE.D.IVOIRE|IVORY|BENIN|TOGO|GABON|CONGO|NIGERIA|GHANA|GUINEA|MALI|BURKINA/i.test(c)) return "TROPICAL";
  if (/MAROC|MOROCCO|TUNISIE|TUNISIA|ALGERIE|ALGERIA|EGYPTE|EGYPT/i.test(c)) return "MEDITERRANEEN";
  if (/FRANCE|BELGIQUE|SUISSE|CANADA|ALLEMAGNE/i.test(c)) return "TEMPERE";
  // Fallback par zonage : urbain africain = tropical par défaut
  return "TROPICAL";
}
// Calculer l'impact de l'orientation sur la géométrie
// Retourne un facteur correctif pour W et D du bâtiment
function computeSolarImpact(envelope_w, envelope_d, climaticZone, parcelOrientation) {
  const config = SOLAR_CONFIG[climaticZone] || SOLAR_CONFIG.TROPICAL;
  const ratio = config.ratio_longueur_profondeur;
  // Si la parcelle est plus large que profonde (W > D), la longueur du bâti
  // s'aligne naturellement sur W → façades longues en N-S = OPTIMAL en tropical
  // Si W < D, le bâtiment est profond → SOUS-OPTIMAL (façades courtes en N-S)
  const parcelRatio = envelope_w / Math.max(1, envelope_d);
  let orientationScore = 1.0; // 1.0 = parfait
  if (climaticZone === "TROPICAL") {
    // En tropical : on VEUT un bâtiment allongé E-O (façades longues N-S)
    // Si la parcelle le permet (W > D), c'est optimal
    if (parcelRatio >= 1.3) {
      orientationScore = 1.0; // parcelle large → bâti allongé N-S = optimal
    } else if (parcelRatio >= 0.8) {
      orientationScore = 0.92; // parcelle carrée → compromis acceptable
    } else {
      orientationScore = 0.85; // parcelle profonde → sous-optimal (façades longues E-O)
    }
    // Limiter la profondeur de corps pour ventilation traversante
    const profondeurEffective = Math.min(envelope_d, config.profondeur_max_m);
    return {
      orientationScore,
      profondeur_recommandee_m: profondeurEffective,
      ratio_recommande: ratio,
      facade_optimale: config.orientation_optimale,
      facade_a_proteger: config.facade_a_proteger,
      ventilation_traversante: config.ventilation_traversante,
      brise_soleil: config.brise_soleil_ouest,
      debord_toiture_m: config.debord_toiture_m,
      malus_orientation_pct: orientationScore < 0.95 ? config.malus_mauvaise_orientation_pct : 0,
      recommandation_orientation: orientationScore >= 0.95
        ? "Parcelle favorable : longueur orientee pour maximiser les facades Nord-Sud. Ventilation traversante naturelle possible."
        : orientationScore >= 0.90
        ? "Parcelle acceptable : orienter la longueur du batiment Nord-Sud autant que possible. Prevoir des brise-soleil en facade Ouest."
        : "Parcelle contrainte pour l'orientation solaire : la profondeur impose des facades longues Est-Ouest. Prevoir imperativement des protections solaires (brise-soleil, double peau, vegetation) en facade Ouest et un surcoût climatisation de ~" + config.malus_mauvaise_orientation_pct + "%.",
    };
  }
  // Tempéré / Méditerranéen : logique similaire mais inversée
  if (parcelRatio >= 1.2) orientationScore = 0.95;
  else if (parcelRatio >= 0.8) orientationScore = 1.0;
  else orientationScore = 0.90;
  return {
    orientationScore,
    profondeur_recommandee_m: Math.min(envelope_d, config.profondeur_max_m),
    ratio_recommande: ratio,
    facade_optimale: config.orientation_optimale,
    facade_a_proteger: config.facade_a_proteger,
    ventilation_traversante: config.ventilation_traversante,
    brise_soleil: config.brise_soleil_ouest,
    debord_toiture_m: config.debord_toiture_m,
    malus_orientation_pct: orientationScore < 0.95 ? config.malus_mauvaise_orientation_pct : 0,
    recommandation_orientation: "Orientation standard pour climat tempere.",
  };
}
// Durée estimée de chantier (mois) par niveau
const DUREE_CHANTIER_MOIS_PAR_NIVEAU = {
  fondations_terrassement: 2,  // invariant : terrassement + fondations
  par_niveau: 1.5,             // ~1.5 mois par niveau (gros œuvre + étanchéité)
  finitions: 2,                // second œuvre + lots techniques
  vrd_ext: 1,                  // VRD + aménagements extérieurs
};
// ══════════════════════════════════════════════════════════════════════════════
// v56.9 — RÈGLES PAR PROGRAMME (chaque option du formulaire client)
// ══════════════════════════════════════════════════════════════════════════════
const PROGRAM_RULES = {
  MAISON_INDIVIDUELLE: {
    // Villa individuelle OU bungalows (éco-lodges, résidences touristiques)
    // Si target_units=1 → 1 villa ; si target_units>1 → bungalows sur la parcelle
    // Le T-type détermine le nombre de chambres :
    //   T2 = 1 chambre (bungalow simple, studio gardien)
    //   T3 = master(≥15m²+dressing) + 1 chambre enfant(≥12m²)
    //   T4 = master + 2 chambres (standard famille camerounaise)
    //   T5 = master + 3 chambres (grande famille)
    // SDB : individuelle en PREMIUM/HAUT, partagée enfants en STANDARD/ECO
    default_mix_fn: (n) => {
      if (n <= 1) return { T4: 1 }; // villa familiale = 3 chambres par défaut
      // Bungalows / éco-lodges : unités reproductibles
      return { T3: n }; // chaque bungalow = 2 chambres (master + 1)
    },
    max_units_per_floor: 1,
    max_floors: 2,          // R+1 pour villa ; bungalows → plain-pied (1 niveau)
    bungalow_max_floors: 1, // si target_units > 1, on force 1 niveau
    circulation_ratio: 0.12,
    body_depth_m: { ECO: 10, STD: 12, PREM: 14 },
    ground_reserve: { A: 0.40, B: 0.50, C: 0.60 }, // jardin, cour, garage
    parking_per_unit: 1,
    requires_pilotis: false, rdc_commerce: false,
  },
  PETIT_COLLECTIF: {
    // Marché Cameroun : majorité T3, quelques T2 ("studios"), 1 T4 si ≥5 logements
    default_mix_fn: (n) => {
      if (n <= 2) return { T3: n };
      if (n <= 4) return { T2: 1, T3: n - 1 };
      // ≥5 : 1 T4 (proprio), ~20% T2, reste T3
      const t4 = 1;
      const t2 = Math.max(1, Math.round((n - t4) * 0.20));
      return { T2: t2, T3: n - t4 - t2, T4: t4 };
    },
    max_units_per_floor: { ECO: 4, STD: 3, PREM: 2 }, max_floors: 4,
    circulation_ratio: { ECO: 0.15, STD: 0.18, PREM: 0.22 },
    body_depth_m: { ECO: 12, STD: 13, PREM: 15 },
    ground_reserve: { A: 0.25, B: 0.30, C: 0.40 }, parking_per_unit: 1,
    requires_pilotis: "auto", rdc_commerce: false,
  },
  IMMEUBLE_RAPPORT: {
    // Marché Cameroun : majorité T3, ~20% T2 ("studios"), 1 T4 dernier étage (proprio)
    // Pas de T1 (pas courant), T5 seulement si ≥15 logements
    default_mix_fn: (n) => {
      if (n <= 3) return { T3: n };
      const t4 = 1; // toujours 1 T4 pour le proprio
      const t5 = n >= 15 ? 1 : 0; // T5 seulement gros programme
      const rest = n - t4 - t5;
      const t2 = Math.max(1, Math.round(rest * 0.25)); // ~25% T2 "studios"
      const t3 = rest - t2; // tout le reste en T3
      return { T2: t2, T3: Math.max(1, t3), T4: t4, ...(t5 > 0 ? { T5: t5 } : {}) };
    },
    max_units_per_floor: { ECO: 8, STD: 6, PREM: 4 }, max_floors: 8,
    circulation_ratio: { ECO: 0.16, STD: 0.18, PREM: 0.22 },
    body_depth_m: { ECO: 12, STD: 13, PREM: 15 },
    ground_reserve: { A: 0.22, B: 0.30, C: 0.38 }, parking_per_unit: 1.2,
    requires_pilotis: "auto", rdc_commerce: false,
  },
  USAGE_MIXTE: {
    // Cameroun : commerce RDC + logements aux étages (même logique résidentielle)
    default_mix_fn: (n) => {
      const commerce = Math.max(1, Math.round(n * 0.15)); // 1-2 commerces au RDC
      const resi = n - commerce;
      if (resi <= 2) return { COMMERCE: commerce, T3: Math.max(1, resi) };
      const t4 = 1;
      const rest = resi - t4;
      const t2 = Math.max(1, Math.round(rest * 0.25));
      return { COMMERCE: commerce, T2: t2, T3: Math.max(1, rest - t2), T4: t4 };
    },
    max_units_per_floor: { ECO: 5, STD: 4, PREM: 3 }, max_floors: 8,
    circulation_ratio: { ECO: 0.18, STD: 0.20, PREM: 0.24 },
    body_depth_m: { ECO: 14, STD: 15, PREM: 16 },
    ground_reserve: { A: 0.25, B: 0.32, C: 0.40 }, parking_per_unit: 1.5,
    requires_pilotis: false, rdc_commerce: true, rdc_height_m: 4.0,
  },
  ACTIVITE_PRO: {
    // Immeuble de bureaux : plateaux libres reproductibles, cloisonnables
    // target_units = nombre de NIVEAUX de bureaux (chaque niveau = 1 plateau identique)
    // Le fp est dérivé de l'enveloppe (on remplit raisonnablement), PAS du UNIT_SIZES
    // Pas de cap arbitraire sur les niveaux — le COS fait le garde-fou
    fp_from_envelope: true,   // flag spécial : fp = enveloppe × (1-reserve), pas unit-driven
    default_mix_fn: (n) => ({ PLATEAU: n || 4 }), // n plateaux identiques
    max_units_per_floor: 1,   // 1 plateau = 1 étage complet
    max_floors: 99,
    circulation_ratio: { ECO: 0.20, STD: 0.22, PREM: 0.25 },
    body_depth_m: { ECO: 14, STD: 16, PREM: 18 },
    ground_reserve: { A: 0.20, B: 0.28, C: 0.35 }, parking_per_unit: 2.0,
    requires_pilotis: "auto", rdc_commerce: false,
  },
  PROGRAMME_FLOU: {
    // Pas de programme défini → on suppose le standard camerounais (résidentiel T3-dominant)
    default_mix_fn: (n) => {
      if (n <= 3) return { T3: n };
      const t4 = 1;
      const rest = n - t4;
      const t2 = Math.max(1, Math.round(rest * 0.20));
      return { T2: t2, T3: rest - t2, T4: t4 };
    },
    max_units_per_floor: { ECO: 4, STD: 3, PREM: 2 }, max_floors: 6,
    circulation_ratio: { ECO: 0.16, STD: 0.18, PREM: 0.22 },
    body_depth_m: { ECO: 12, STD: 13, PREM: 15 },
    ground_reserve: { A: 0.25, B: 0.30, C: 0.40 }, parking_per_unit: 1,
    requires_pilotis: "auto", rdc_commerce: false,
  },
  // ── 7 NOUVEAUX USAGES (prompt expert architecte-urbaniste africain) ──
  RESIDENCE_MEUBLEE: {
    // Appart-hôtel / résidence meublée : unités compactes reproductibles
    // Back-of-house important (accueil, linge, maintenance, stockage)
    default_mix_fn: (n) => {
      if (n <= 4) return { STUDIO: n };
      const studio = Math.round(n * 0.40);
      const t2 = Math.round(n * 0.40);
      const t3 = n - studio - t2;
      return { STUDIO: Math.max(1, studio), T2: Math.max(1, t2), T3: Math.max(0, t3) };
    },
    max_units_per_floor: { ECO: 10, STD: 8, PREM: 5 }, max_floors: 7,
    circulation_ratio: { ECO: 0.22, STD: 0.25, PREM: 0.28 },
    body_depth_m: { ECO: 13, STD: 14, PREM: 15 },
    ground_reserve: { A: 0.25, B: 0.30, C: 0.38 }, parking_per_unit: 0.6,
    requires_pilotis: "auto", rdc_commerce: false,
  },
  HOTEL_URBAIN: {
    // Hôtel compact urbain : chambres standardisées, BOH important
    // target_units = nombre de clés (chambres)
    default_mix_fn: (n) => {
      const standard = Math.round(n * 0.70);
      const suite = n - standard;
      return { CHAMBRE: Math.max(1, standard), SUITE: Math.max(0, suite) };
    },
    max_units_per_floor: { ECO: 14, STD: 10, PREM: 6 }, max_floors: 8,
    circulation_ratio: { ECO: 0.26, STD: 0.30, PREM: 0.35 },
    body_depth_m: { ECO: 14, STD: 16, PREM: 18 },
    ground_reserve: { A: 0.22, B: 0.28, C: 0.35 }, parking_per_unit: 0.4,
    requires_pilotis: false, rdc_commerce: false, rdc_height_m: 4.5,
  },
  CLINIQUE: {
    // Centre médical / clinique de quartier
    // Circulation très importante (brancards, attente, imagerie)
    default_mix_fn: (n) => {
      const consult = Math.round(n * 0.50);
      const imagerie = Math.max(1, Math.round(n * 0.15));
      const service = n - consult - imagerie;
      return { CONSULTATION: Math.max(1, consult), IMAGERIE: imagerie, SERVICE: Math.max(1, service) };
    },
    max_units_per_floor: { ECO: 8, STD: 6, PREM: 4 }, max_floors: 4,
    circulation_ratio: { ECO: 0.28, STD: 0.32, PREM: 0.35 },
    body_depth_m: { ECO: 16, STD: 18, PREM: 20 },
    ground_reserve: { A: 0.30, B: 0.35, C: 0.42 }, parking_per_unit: 2.5,
    requires_pilotis: false, rdc_commerce: false,
  },
  CENTRE_COMMERCIAL: {
    // Retail de proximité / galerie commerciale active
    // Profondeur importante, réserves, livraisons
    default_mix_fn: (n) => {
      const boutique = Math.round(n * 0.70);
      const ancre = n - boutique;
      return { BOUTIQUE: Math.max(1, boutique), ANCRE: Math.max(0, ancre) };
    },
    max_units_per_floor: { ECO: 10, STD: 8, PREM: 5 }, max_floors: 3,
    circulation_ratio: { ECO: 0.22, STD: 0.25, PREM: 0.28 },
    body_depth_m: { ECO: 18, STD: 20, PREM: 22 },
    ground_reserve: { A: 0.20, B: 0.28, C: 0.35 }, parking_per_unit: 3.5,
    requires_pilotis: false, rdc_commerce: true, rdc_height_m: 4.5,
  },
  SCOLAIRE: {
    // Établissement scolaire privé : salles de classe + administration + cour
    // Cour = élément dimensionnant (min 30-40% du terrain)
    default_mix_fn: (n) => {
      const classes = Math.round(n * 0.65);
      const admin = Math.max(1, Math.round(n * 0.15));
      const service = n - classes - admin;
      return { CLASSE: Math.max(1, classes), ADMIN: admin, SERVICE: Math.max(1, service) };
    },
    max_units_per_floor: { ECO: 6, STD: 4, PREM: 3 }, max_floors: 3,
    circulation_ratio: { ECO: 0.25, STD: 0.28, PREM: 0.30 },
    body_depth_m: { ECO: 10, STD: 11, PREM: 12 },
    ground_reserve: { A: 0.45, B: 0.52, C: 0.58 }, parking_per_unit: 0.1,
    requires_pilotis: false, rdc_commerce: false,
  },
  ENTREPOT: {
    // Entrepôt / logistique légère / semi-industriel
    // Grande emprise, faible hauteur, cour de manœuvre importante
    fp_from_envelope: true,
    default_mix_fn: (n) => ({ STOCKAGE: Math.max(1, n - 1), BUREAU: 1 }),
    max_units_per_floor: 1, max_floors: 2,
    circulation_ratio: { ECO: 0.10, STD: 0.12, PREM: 0.15 },
    body_depth_m: { ECO: 22, STD: 25, PREM: 28 },
    ground_reserve: { A: 0.30, B: 0.38, C: 0.45 }, parking_per_unit: 0.8,
    requires_pilotis: false, rdc_commerce: false,
  },
  MIXTE_OPPORTUNISTE: {
    // Usage mixte africain typique : commerce RDC, étages flexibles
    // (logement, bureaux, location courte durée selon le marché)
    default_mix_fn: (n) => {
      const commerce = Math.max(1, Math.round(n * 0.20));
      const resi = n - commerce;
      if (resi <= 2) return { COMMERCE: commerce, T3: Math.max(1, resi) };
      const t2 = Math.max(1, Math.round(resi * 0.30));
      return { COMMERCE: commerce, T2: t2, T3: resi - t2 };
    },
    max_units_per_floor: { ECO: 6, STD: 5, PREM: 3 }, max_floors: 7,
    circulation_ratio: { ECO: 0.18, STD: 0.20, PREM: 0.24 },
    body_depth_m: { ECO: 13, STD: 14, PREM: 16 },
    ground_reserve: { A: 0.22, B: 0.28, C: 0.35 }, parking_per_unit: 1.0,
    requires_pilotis: false, rdc_commerce: true, rdc_height_m: 4.0,
  },
};
// ══════════════════════════════════════════════════════════════════════════════
// v57.13: GRILLE EXPERT — Ratios architecte-urbaniste africain senior
// ══════════════════════════════════════════════════════════════════════════════
// CES recommandé, niveaux, efficacité brut/net, parking, profondeur bâtiment
// Par programme × zonage × scénario (A=optimisé, B=équilibré, C=secure)
// Source : pratique terrain Afrique francophone, logique marché Cameroun/Douala
// Principe : constructibilité théorique ≠ faisabilité rentable
// ══════════════════════════════════════════════════════════════════════════════
const EXPERT_RATIOS = {
  MAISON_INDIVIDUELLE: {
    URBAIN:     { A: { ces: 0.38, fl: [1,2], eff: 0.88 }, B: { ces: 0.30, fl: [1,2], eff: 0.90 }, C: { ces: 0.24, fl: [1,1], eff: 0.90 } },
    PERIURBAIN: { A: { ces: 0.30, fl: [1,2], eff: 0.88 }, B: { ces: 0.24, fl: [1,2], eff: 0.90 }, C: { ces: 0.20, fl: [1,1], eff: 0.90 } },
    Z_DEFAULT:  { A: { ces: 0.22, fl: [1,1], eff: 0.90 }, B: { ces: 0.18, fl: [1,1], eff: 0.90 }, C: { ces: 0.15, fl: [1,1], eff: 0.90 } },
  },
  PETIT_COLLECTIF: {
    URBAIN:     { A: { ces: 0.40, fl: [3,4], eff: 0.76 }, B: { ces: 0.33, fl: [2,3], eff: 0.78 }, C: { ces: 0.25, fl: [2,2], eff: 0.80 } },
    PERIURBAIN: { A: { ces: 0.32, fl: [2,3], eff: 0.78 }, B: { ces: 0.25, fl: [2,3], eff: 0.80 }, C: { ces: 0.20, fl: [2,2], eff: 0.82 } },
    Z_DEFAULT:  { A: { ces: 0.24, fl: [2,3], eff: 0.80 }, B: { ces: 0.20, fl: [2,2], eff: 0.82 }, C: { ces: 0.16, fl: [1,2], eff: 0.84 } },
  },
  IMMEUBLE_RAPPORT: {
    // Logement collectif moyen standing — le produit standard camerounais
    // 1950m² URBAIN : CES 42% = 819m² au sol, 3-5 niv = 2460-4095m² SDP
    // Ventilation naturelle traversante : profondeur max 14m recommandée
    // Stationnement au sol ~30% du terrain libre → 15-20 places
    URBAIN:     { A: { ces: 0.42, fl: [3,5], eff: 0.78 }, B: { ces: 0.35, fl: [3,4], eff: 0.80 }, C: { ces: 0.28, fl: [2,3], eff: 0.82 } },
    PERIURBAIN: { A: { ces: 0.34, fl: [3,4], eff: 0.80 }, B: { ces: 0.28, fl: [2,3], eff: 0.82 }, C: { ces: 0.22, fl: [2,2], eff: 0.84 } },
    Z_DEFAULT:  { A: { ces: 0.26, fl: [2,3], eff: 0.82 }, B: { ces: 0.22, fl: [2,3], eff: 0.84 }, C: { ces: 0.18, fl: [2,2], eff: 0.85 } },
  },
  USAGE_MIXTE: {
    // Commerce RDC (hauteur 4-4.5m) + logements étages
    // Le commerce tire la rentabilité, les logements sécurisent le cash-flow
    URBAIN:     { A: { ces: 0.45, fl: [4,6], eff: 0.74 }, B: { ces: 0.38, fl: [3,5], eff: 0.76 }, C: { ces: 0.30, fl: [3,4], eff: 0.78 } },
    PERIURBAIN: { A: { ces: 0.35, fl: [3,5], eff: 0.76 }, B: { ces: 0.28, fl: [3,4], eff: 0.78 }, C: { ces: 0.22, fl: [2,3], eff: 0.80 } },
    Z_DEFAULT:  { A: { ces: 0.26, fl: [2,4], eff: 0.78 }, B: { ces: 0.22, fl: [2,3], eff: 0.80 }, C: { ces: 0.18, fl: [2,2], eff: 0.82 } },
  },
  ACTIVITE_PRO: {
    // Bureaux : plateaux libres, 1 place/30-40m² plancher
    // Profondeur 14-18m selon ventilation/clim
    URBAIN:     { A: { ces: 0.42, fl: [4,6], eff: 0.78 }, B: { ces: 0.35, fl: [3,5], eff: 0.80 }, C: { ces: 0.28, fl: [3,4], eff: 0.82 } },
    PERIURBAIN: { A: { ces: 0.32, fl: [3,5], eff: 0.80 }, B: { ces: 0.25, fl: [2,4], eff: 0.82 }, C: { ces: 0.20, fl: [2,3], eff: 0.84 } },
    Z_DEFAULT:  { A: { ces: 0.24, fl: [2,4], eff: 0.82 }, B: { ces: 0.20, fl: [2,3], eff: 0.84 }, C: { ces: 0.16, fl: [2,2], eff: 0.85 } },
  },
  PROGRAMME_FLOU: {
    // Programme non défini → hypothèse résidentiel standard
    URBAIN:     { A: { ces: 0.40, fl: [3,5], eff: 0.76 }, B: { ces: 0.32, fl: [2,4], eff: 0.78 }, C: { ces: 0.24, fl: [2,3], eff: 0.80 } },
    PERIURBAIN: { A: { ces: 0.32, fl: [2,4], eff: 0.78 }, B: { ces: 0.25, fl: [2,3], eff: 0.80 }, C: { ces: 0.20, fl: [2,2], eff: 0.82 } },
    Z_DEFAULT:  { A: { ces: 0.24, fl: [2,3], eff: 0.80 }, B: { ces: 0.20, fl: [2,2], eff: 0.82 }, C: { ces: 0.16, fl: [1,2], eff: 0.84 } },
  },
  RESIDENCE_MEUBLEE: {
    // Appart-hôtel : BOH (accueil, linge, maintenance) = 25-30% du RDC
    // Unités compactes (studios 22-28m², T2 45-55m²) → haute densité/plateau
    URBAIN:     { A: { ces: 0.42, fl: [4,6], eff: 0.72 }, B: { ces: 0.35, fl: [3,5], eff: 0.74 }, C: { ces: 0.28, fl: [3,4], eff: 0.76 } },
    PERIURBAIN: { A: { ces: 0.34, fl: [3,5], eff: 0.74 }, B: { ces: 0.28, fl: [3,4], eff: 0.76 }, C: { ces: 0.22, fl: [2,3], eff: 0.78 } },
    Z_DEFAULT:  { A: { ces: 0.26, fl: [2,4], eff: 0.76 }, B: { ces: 0.22, fl: [2,3], eff: 0.78 }, C: { ces: 0.18, fl: [2,2], eff: 0.80 } },
  },
  HOTEL_URBAIN: {
    // Hôtel compact : BOH lourd (30-35%), chambres 18-25m², couloirs larges
    // Seuil critique : <40 clés = non viable ; 60-80 clés = optimal urbain
    URBAIN:     { A: { ces: 0.48, fl: [4,7], eff: 0.68 }, B: { ces: 0.40, fl: [3,5], eff: 0.70 }, C: { ces: 0.32, fl: [3,4], eff: 0.72 } },
    PERIURBAIN: { A: { ces: 0.38, fl: [3,5], eff: 0.70 }, B: { ces: 0.30, fl: [3,4], eff: 0.72 }, C: { ces: 0.24, fl: [2,3], eff: 0.74 } },
    Z_DEFAULT:  { A: { ces: 0.28, fl: [2,4], eff: 0.72 }, B: { ces: 0.24, fl: [2,3], eff: 0.74 }, C: { ces: 0.20, fl: [2,2], eff: 0.76 } },
  },
  CLINIQUE: {
    // Circulations dimensionnantes (brancards 2.40m, attente, accès PMR)
    // Imagerie = rez-de-chaussée obligatoire (poids, blindage)
    // Parking surdimensionné (patients + accompagnants + personnel)
    URBAIN:     { A: { ces: 0.40, fl: [2,4], eff: 0.65 }, B: { ces: 0.34, fl: [2,3], eff: 0.68 }, C: { ces: 0.28, fl: [2,3], eff: 0.70 } },
    PERIURBAIN: { A: { ces: 0.32, fl: [2,3], eff: 0.68 }, B: { ces: 0.26, fl: [2,3], eff: 0.70 }, C: { ces: 0.22, fl: [1,2], eff: 0.72 } },
    Z_DEFAULT:  { A: { ces: 0.24, fl: [1,3], eff: 0.70 }, B: { ces: 0.20, fl: [1,2], eff: 0.72 }, C: { ces: 0.16, fl: [1,2], eff: 0.74 } },
  },
  CENTRE_COMMERCIAL: {
    // Retail : profondeur 18-22m, réserves 15-20%, galerie 10-12%
    // Parking = élément dimensionnant (3-5 places/100m² vente)
    // >R+2 rarement viable en Afrique (flux piétons chute aux étages)
    URBAIN:     { A: { ces: 0.50, fl: [1,3], eff: 0.70 }, B: { ces: 0.42, fl: [1,2], eff: 0.72 }, C: { ces: 0.35, fl: [1,2], eff: 0.75 } },
    PERIURBAIN: { A: { ces: 0.38, fl: [1,2], eff: 0.72 }, B: { ces: 0.30, fl: [1,2], eff: 0.75 }, C: { ces: 0.24, fl: [1,1], eff: 0.78 } },
    Z_DEFAULT:  { A: { ces: 0.28, fl: [1,2], eff: 0.75 }, B: { ces: 0.22, fl: [1,1], eff: 0.78 }, C: { ces: 0.18, fl: [1,1], eff: 0.80 } },
  },
  SCOLAIRE: {
    // Cour = élément dimensionnant (min 35-40% du terrain en urbain)
    // Ratio salles/admin/circulation ≈ 55/15/30%
    // Profondeur faible (ventilation + éclairage naturel classes)
    URBAIN:     { A: { ces: 0.38, fl: [2,3], eff: 0.68 }, B: { ces: 0.30, fl: [2,3], eff: 0.70 }, C: { ces: 0.24, fl: [1,2], eff: 0.72 } },
    PERIURBAIN: { A: { ces: 0.28, fl: [1,3], eff: 0.70 }, B: { ces: 0.22, fl: [1,2], eff: 0.72 }, C: { ces: 0.18, fl: [1,2], eff: 0.75 } },
    Z_DEFAULT:  { A: { ces: 0.22, fl: [1,2], eff: 0.72 }, B: { ces: 0.18, fl: [1,2], eff: 0.75 }, C: { ces: 0.15, fl: [1,1], eff: 0.78 } },
  },
  ENTREPOT: {
    // Grande emprise, faible hauteur, cour manœuvre = 30-40% terrain
    // >R+1 rarement viable (surcoût structure vs gain m²)
    URBAIN:     { A: { ces: 0.52, fl: [1,2], eff: 0.85 }, B: { ces: 0.45, fl: [1,1], eff: 0.88 }, C: { ces: 0.38, fl: [1,1], eff: 0.90 } },
    PERIURBAIN: { A: { ces: 0.38, fl: [1,2], eff: 0.88 }, B: { ces: 0.32, fl: [1,1], eff: 0.90 }, C: { ces: 0.25, fl: [1,1], eff: 0.90 } },
    Z_DEFAULT:  { A: { ces: 0.28, fl: [1,1], eff: 0.90 }, B: { ces: 0.22, fl: [1,1], eff: 0.90 }, C: { ces: 0.18, fl: [1,1], eff: 0.90 } },
  },
  MIXTE_OPPORTUNISTE: {
    // Le produit africain par excellence : commerce RDC + étages flexibles
    // Résilient au marché car les étages s'adaptent (logement, bureau, meublé)
    URBAIN:     { A: { ces: 0.45, fl: [4,6], eff: 0.74 }, B: { ces: 0.38, fl: [3,5], eff: 0.76 }, C: { ces: 0.30, fl: [3,4], eff: 0.78 } },
    PERIURBAIN: { A: { ces: 0.35, fl: [3,5], eff: 0.76 }, B: { ces: 0.28, fl: [2,4], eff: 0.78 }, C: { ces: 0.22, fl: [2,3], eff: 0.80 } },
    Z_DEFAULT:  { A: { ces: 0.26, fl: [2,4], eff: 0.78 }, B: { ces: 0.22, fl: [2,3], eff: 0.80 }, C: { ces: 0.18, fl: [2,2], eff: 0.82 } },
  },
};
// ── Helper: normalise program_main string → PROGRAM_RULES key ──
function parseProgramKey(raw) {
  const s = String(raw || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Nouveaux usages (v57.13 — expert africain)
  if (/APART.?HOTEL|RESIDENCE.?MEUBLE|SERVICED|^MEUBLE/.test(s)) return "RESIDENCE_MEUBLEE";
  if (/HOTEL|HEBERGEMENT|AUBERGE/.test(s)) return "HOTEL_URBAIN";
  if (/CLINIQUE|MEDICAL|SANTE|HOPITAL|CABINET/.test(s)) return "CLINIQUE";
  if (/COMMERCIAL|RETAIL|GALERIE|BOUTIQUE|CENTRE.?COM/.test(s)) return "CENTRE_COMMERCIAL";
  if (/SCOLAIRE|ECOLE|LYCEE|COLLEGE|FORMATION|CRECHE/.test(s)) return "SCOLAIRE";
  if (/ENTREPOT|LOGISTIQUE|INDUSTRIEL|STOCKAGE|HANGAR/.test(s)) return "ENTREPOT";
  if (/OPPORTUNISTE|POLYVALENT|FLEXIBLE/.test(s)) return "MIXTE_OPPORTUNISTE";
  // Usages existants
  if (/MAISON|VILLA|INDIVIDUEL/.test(s)) return "MAISON_INDIVIDUELLE";
  if (/PETIT.?COLLECTIF/.test(s)) return "PETIT_COLLECTIF";
  if (/RAPPORT|DENSE|COLLECTIF|LOCATIF/.test(s)) return "IMMEUBLE_RAPPORT";
  if (/MIXTE|MIXED/.test(s)) return "USAGE_MIXTE";
  if (/ACTIVITE|PROFESS|BUREAU|OFFICE/.test(s)) return "ACTIVITE_PRO";
  if (/FLOU|INDEFINI|A.DEFINIR|PAS.ENCORE/.test(s)) return "PROGRAMME_FLOU";
  return null; // → fallback to regulation-driven
}
// ── Helper: standing → lookup key for per-standing objects ──
function standingKey(standing_level) {
  const s = String(standing_level).toUpperCase();
  if (/PREMIUM|HAUT/.test(s)) return "PREM";
  if (/ECO/.test(s)) return "ECO";
  return "STD";
}
// ── Helper: standing → UNIT_SIZES key ──
function standingSizeKey(standing_level) {
  const s = String(standing_level).toUpperCase();
  if (/PREMIUM|HAUT/.test(s)) return "PREMIUM";
  if (/ECO/.test(s)) return "ECONOMIQUE";
  return "STANDARD";
}
// ── Helper: resolve a per-standing or per-role value from a rules field ──
function resolveField(field, key) {
  if (typeof field === "object" && field !== null) return field[key] ?? Object.values(field)[0];
  return field;
}
// ── Helper : taille moyenne pondérée d'un logement résidentiel ──
// Utilise la default_mix_fn du programme pour calculer les proportions réelles
// au lieu de poids en dur. Fonctionne pour tous les 6 types de programme.
function computeAvgResidentialSize(sizes, rules, targetUnits) {
  const n = Math.max(1, targetUnits || 4);
  const mix = rules.default_mix_fn ? rules.default_mix_fn(n) : { T3: n };
  let totalSize = 0, totalCount = 0;
  for (const [typ, count] of Object.entries(mix)) {
    if (count <= 0) continue;
    // Pour le calcul de avgSize résidentiel, ignorer les COMMERCE/BUREAU/PLATEAU
    // (ils ont leur propre logique : RDC commerce, fp_from_envelope, etc.)
    if (/COMMERCE|BUREAU|PLATEAU/i.test(typ)) continue;
    const unitSize = sizes[typ] || sizes.T3 || 80;
    totalSize += count * unitSize;
    totalCount += count;
  }
  return totalCount > 0 ? totalSize / totalCount : (sizes.T3 || 80);
}
// ══════════════════════════════════════════════════════════════════════════════
// v56.7 — RÔLES SCÉNARIOS (logique métier claire)
// ══════════════════════════════════════════════════════════════════════════════
// A = INTENSIFICATION : colle au max à la priorité client, pousse les limites réglementaires
// B = EQUILIBRE : alternative équilibrée, bon compromis densité/risque
// C = PRUDENT : version conservatrice, reste bien dans les clous, phasable
//
// Le massing_mode (forme du bâti: BALANCED/SPREAD/COMPACT) est INDÉPENDANT du rôle.
// On peut avoir un scénario prudent en forme compacte (petit bâtiment dense mais peu de niveaux).
// ══════════════════════════════════════════════════════════════════════════════
// Rôle stratégique de chaque scénario
const SCENARIO_ROLE = { A: "INTENSIFICATION", B: "EQUILIBRE", C: "PRUDENT" };
// Massing mode = FORME du bâtiment (indépendant du rôle)
const SCENARIO_MASSING_MODE = { A: "BALANCED", B: "SPREAD", C: "COMPACT" };
// Multiplicateur de niveaux par rôle (PAS par massing_mode)
// INTENSIFICATION = pousse les niveaux au max du driver
// EQUILIBRE = niveaux modérés
// PRUDENT = niveaux conservateurs, toujours conforme COS
function levelMultiplier(role) {
  if (role === "INTENSIFICATION") return 0.85;
  if (role === "EQUILIBRE") return 0.55;
  return 0.35; // PRUDENT
}
// Contrainte COS par rôle
// INTENSIFICATION peut atteindre 100% du COS (voire dérogation légère)
// EQUILIBRE vise 70-90% du COS
// PRUDENT ne dépasse jamais 80% du COS
const COS_CAP_BY_ROLE = { INTENSIFICATION: 1.05, EQUILIBRE: 0.90, PRUDENT: 0.80 };
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
  // v57.7 : retraits optionnels (overrides)
  retrait_avant_m = 0, retrait_lateral_m = 0, retrait_arriere_m = 0,
  nb_cotes_mitoyens = -1, // -1 = auto (déduit du zonage)
  // v57.9 : orientation solaire & géographie
  country = "CAMEROUN", // pays du site (pour détecter zone climatique)
  parcel_orientation = "", // orientation principale de la parcelle (optionnel)
}) {
  // v56.3 FIX DÉFINITIF: max_fp = CES × site_area UNIQUEMENT.
  // Les envelope_w/d de la Sheet sont souvent FAUX (dérivés de l'aire polygonale
  // ≈24×24 au lieu du vrai bbox ≈49×47), ce qui causait fp_A=342 au lieu de ~1100.
  // La contrainte physique (bâtiment dans l'enveloppe) est gérée par
  // computeMassingPolygon au moment du rendu, avec cross-section + containment check.
  const envelope_bbox = envelope_w * envelope_d;
  const envelope_area = env_area_override || envelope_bbox;
  const ces = ZONING_CES[zoning_type] || 0.50;
  const max_fp = ces * site_area;  // v56.3: CES seul, pas de cap par envelope_bbox erroné
  // ⚠ Diagnostic : si envelope_bbox << ces*site_area, les dimensions Sheet sont suspectes
  if (envelope_bbox > 0 && envelope_bbox < max_fp * 0.6) {
    console.warn(`⚠ ENVELOPE SUSPECT: bbox=${envelope_bbox}m² (${envelope_w}×${envelope_d}) << max_fp=${max_fp}m² (CES×site). Les dimensions Sheet sont probablement fausses.`);
  }
  // COS → surface de plancher totale max (SDP = fp × niveaux)
  const cos = ZONING_COS[zoning_type] || 1.50;
  const max_sdp = cos * site_area;
  const ratios = FP_RATIOS[primary_driver] || FP_RATIOS.MAX_CAPACITE;
  // ══════════════════════════════════════════════════════════════════════════════
  // v57.7 — RETRAITS RÉGLEMENTAIRES & MITOYENNETÉ → emprise constructible réduite
  // ══════════════════════════════════════════════════════════════════════════════
  const retraitsZone = RETRAITS_M[zoning_type] || RETRAITS_M.URBAIN;
  const rAvant = retrait_avant_m > 0 ? retrait_avant_m : retraitsZone.avant;
  const rLateral = retrait_lateral_m > 0 ? retrait_lateral_m : retraitsZone.lateral;
  const rArriere = retrait_arriere_m > 0 ? retrait_arriere_m : retraitsZone.arriere;
  const nbMitoyens = nb_cotes_mitoyens >= 0 ? nb_cotes_mitoyens : (MITOYENNETE_SIDES[zoning_type] || 0);
  // Emprise constructible = envelope réduite par les retraits
  // Modèle simplifié : on retire les retraits de W et D
  // Mitoyenneté : chaque côté mitoyen annule un retrait latéral
  const retraitLatEffectif = Math.max(0, rLateral * (2 - nbMitoyens)); // 0 si 2 mitoyens
  const wConstructible = Math.max(envelope_w - retraitLatEffectif, envelope_w * 0.5);
  const dConstructible = Math.max(envelope_d - rAvant - rArriere, envelope_d * 0.5);
  const empriseConstructible = wConstructible * dConstructible;
  // L'emprise constructible est un plafond physique supplémentaire (en plus du CES)
  const setbackReductionPct = envelope_bbox > 0 ? Math.round((1 - empriseConstructible / envelope_bbox) * 100) : 0;
  console.log(`│ v57.7 retraits: avant=${rAvant}m lat=${rLateral}m(×${2-nbMitoyens} côtés) arr=${rArriere}m → W=${wConstructible.toFixed(1)}×D=${dConstructible.toFixed(1)}=${Math.round(empriseConstructible)}m² (-${setbackReductionPct}%)`);
  // ══════════════════════════════════════════════════════════════════════════════
  // v57.9 — ORIENTATION SOLAIRE → impact profondeur de corps + géométrie
  // ══════════════════════════════════════════════════════════════════════════════
  const climaticZone = detectClimaticZone(zoning_type, country);
  const solarImpact = computeSolarImpact(envelope_w, envelope_d, climaticZone, parcel_orientation);
  // v57.13: Le solaire est une RECOMMANDATION (façades, orientation, ventilation)
  // mais ne plafonne plus la géométrie — le CES réglementaire reste la contrainte structurante.
  // Si la profondeur dépasse le seuil solaire, on applique un malus coût (climatisation)
  // mais on ne réduit PAS l'emprise constructible.
  const profondeurSolaire = solarImpact.profondeur_recommandee_m || 99;
  const depassementSolaire = Math.max(0, dConstructible - profondeurSolaire);
  const solaireSouple = depassementSolaire > 0; // true si bâtiment plus profond que recommandé
  if (solaireSouple) {
    // Malus proportionnel au dépassement (max +15% si double de la profondeur recommandée)
    const depassementRatio = Math.min(1, depassementSolaire / profondeurSolaire);
    solarImpact.malus_orientation_pct = Math.round(solarImpact.malus_orientation_pct + depassementRatio * 10);
    console.log(`│ v57.13 solaire: zone=${climaticZone} profondeur D=${dConstructible.toFixed(1)}m > recommandé ${profondeurSolaire}m (+${depassementSolaire.toFixed(1)}m) → malus clim +${solarImpact.malus_orientation_pct}% (RECOMMANDATION, CES préservé)`);
  } else {
    console.log(`│ v57.13 solaire: zone=${climaticZone} profondeur D=${dConstructible.toFixed(1)}m ≤ ${profondeurSolaire}m — conforme ventilation traversante`);
  }
  // v57.13: emprise effective = emprise constructible (retraits seuls, PAS plafonnée par le solaire)
  const empriseEffective = empriseConstructible;
  // ══════════════════════════════════════════════════════════════════════════════
  // v56.1 — TOUS LES PARAMÈTRES INTÉGRÉS (plus de code mort)
  // ══════════════════════════════════════════════════════════════════════════════
  // v56.7 — NORMALISATION SCORES + ENUMS FR/EN
  // ══════════════════════════════════════════════════════════════════════════════
  // ── Helper: normalise un score (accepte 0-1, 0-10, ou 0-100) ──
  // v57.6 FIX CRITIQUE: les scores Sheet sont en 0-10, pas 0-100.
  // Avant ce fix, score=8 → 0.08 au lieu de 0.8 → modulations 10× trop faibles!
  function norm01(v) {
    const n = Number(v) || 0;
    if (n > 10 && n <= 100) return n / 100;  // score 0-100 → 0-1
    if (n > 1 && n <= 10) return n / 10;     // score 0-10 → 0-1
    return Math.max(0, Math.min(1, n));       // déjà 0-1 → 0-1
  }
  // ── Helper: parse budget_tension qui peut être string ou number ──
  function parseBudgetTension(v) {
    const n = Number(v);
    if (!isNaN(n)) return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
    const s = String(v).toUpperCase();
    if (s.includes("LOW") || s.includes("FAIBLE") || s.includes("BAS")) return 0.25;
    if (s.includes("HIGH") || s.includes("FORT") || s.includes("HAUT") || s.includes("ELEV")) return 0.75;
    if (s.includes("MED") || s.includes("MOY")) return 0.50;
    return 0;
  }
  // ── 1. BUDGET : tension + rigidité + band ──
  const bt = parseBudgetTension(budget_tension);
  const fri = norm01(financial_rigidity_score);
  // budget_band amplifie/atténue la tension (FR + EN + variantes)
  const bandMod = {
    HIGH: 0.15, HIGH_BUDGET: 0.15, HAUT: 0.15, ELEVE: 0.15,
    MEDIUM: 0, MEDIUM_BUDGET: 0, MOYEN: 0,
    LOW: -0.10, LOW_BUDGET: -0.10, BAS: -0.10, FAIBLE: -0.10,
  }[String(budget_band).toUpperCase()] || 0;
  const budgetPressure = Math.max(0, Math.min(1, (bt + fri) / 2 + bandMod));
  // ── 2. STANDING ──
  const standingFactor = {
    PREMIUM: 0.85, HAUT: 0.90, STANDARD: 1.0, ECONOMIQUE: 1.08, ECO: 1.08,
  }[String(standing_level).toUpperCase()] || 1.0;
  // ── 3. DENSITY : pressure + band ──
  const dpf = Math.max(0.5, Math.min(2.0, Number(density_pressure_factor) || 1));
  // density_band affecte le plafond d'emprise (FR + EN + variantes)
  const densityBandMult = {
    HIGH: 1.10, HIGH_DENSITY: 1.10, "HIGH DENSITY": 1.10, HAUT: 1.10, DENSE: 1.10, FORTE: 1.10,
    MEDIUM: 1.0, MEDIUM_DENSITY: 1.0, MOYEN: 1.0, MOYENNE: 1.0,
    LOW: 0.88, LOW_DENSITY: 0.88, BAS: 0.88, FAIBLE: 0.88,
  }[String(density_band).toUpperCase().trim()] || 1.0;
  // ── 4. DRIVER INTENSITY (FR + EN) ──
  const intensitySpread = {
    HIGH: 1.3, FORT: 1.3, FORTE: 1.3, ELEVE: 1.3, ELEVEE: 1.3,
    MEDIUM: 1.0, MOYEN: 1.0, MOYENNE: 1.0,
    LOW: 0.7, FAIBLE: 0.7, BAS: 0.7,
  }[String(driver_intensity).toUpperCase()] || 1.0;
  // ── 5. FEASIBILITY POSTURE (FR + EN + variantes) ──
  const postureMod = {
    AMBITIEUX: 1.08, AGGRESSIVE: 1.08, OFFENSIVE: 1.08, OFFENSIF: 1.08,
    BALANCED: 1.0, STANDARD: 1.0, EQUILIBRE: 1.0, NEUTRE: 1.0,
    PRUDENT: 0.90, CONSERVATIVE: 0.90, DEFENSIVE: 0.90, DEFENSIF: 0.90, PRUDENTE: 0.90,
  }[String(feasibility_posture).toUpperCase()] || 1.0;
  // ── 6. RISK ── (scores normalisés 0-1)
  const riskAdj = norm01(risk_adjusted);
  const riskSc = norm01(risk_score);
  const riskPenalty = 1.0 - ((riskAdj + riskSc) / 2) * 0.15; // max -15% si risque max
  // ── 7. SCORES MÉTIER (normalisés 0-1, accepte 0-100) ──
  const rentSc = norm01(rent_score);
  const capSc = norm01(capacity_score);
  const mixSc = norm01(mix_score);
  const phaseSc = norm01(phase_score);
  // capacity_score → boost emprise (high cap = max footprint)
  const capacityBoost = 1.0 + (capSc - 0.5) * 0.12; // ±6%
  // rent_score → pousse vers plus de niveaux (rendement locatif)
  const rentLevelBoost = 1.0 + (rentSc - 0.5) * 0.20; // ±10%
  // mix_score → influence le nombre de niveaux commerce
  // Si mixSc > 0.6 et programme non-mixte → ajouter quand même un niveau commerce
  const forceCommerce = mixSc > 0.6;
  // phase_score → modère le scénario C (phasage)
  // High phase = le scénario C peut être plus ambitieux (construit par phases)
  const phaseBoostC = 1.0 + (phaseSc - 0.5) * 0.15; // ±7.5%
  const absMaxLevels = Math.min(
    Number(max_floors) || 99,
    Math.floor((Number(max_height_m) || 99) / floor_height),
    10
  );
  const isMixte = /mixte|mixed/i.test(program_main) || forceCommerce;
  const commerceLevels = isMixte ? 1 : 0;
  // ══════════════════════════════════════════════════════════════════════════════
  // v56.9 — PROGRAMME-DRIVEN : le fp vient du PROGRAMME CLIENT, pas du CES
  // ══════════════════════════════════════════════════════════════════════════════
  // Si target_units > 0 et qu'on identifie le programme → on dimensionne le
  // bâtiment à partir du nombre de logements × surfaces par typo × circulation.
  // CES/COS restent des GARDE-FOUS (contraintes max), pas des cibles.
  // Si pas de programme → fallback à la logique regulation-driven.
  // ══════════════════════════════════════════════════════════════════════════════
  const programKey = parseProgramKey(program_main);
  const rules = programKey ? PROGRAM_RULES[programKey] : null;
  const stdKey = standingKey(standing_level);
  const sizeKey = standingSizeKey(standing_level);
  const isProgramDriven = !!(rules && target_units > 0);
  console.log(`┌── SCENARIO ENGINE v56.9 (PROGRAMME-DRIVEN${isProgramDriven ? "" : " → FALLBACK REGULATION"}) ──`);
  console.log(`│ site=${site_area}m² envelope=${envelope_w}×${envelope_d} bbox=${envelope_bbox}m² polyArea=${envelope_area}m²`);
  console.log(`│ zoning=${zoning_type} CES=${ces} max_fp=${Math.round(max_fp)}m² | COS=${cos} max_sdp=${Math.round(max_sdp)}m²`);
  console.log(`│ driver=${primary_driver} intensity=${driver_intensity}`);
  console.log(`│ max_floors=${max_floors} max_height=${max_height_m}m → absMaxLevels=${absMaxLevels}`);
  console.log(`│ program=${program_main} → key=${programKey || "NONE"} | target_units=${target_units} | mode=${isProgramDriven ? "PROGRAM" : "REGULATION"}`);
  console.log(`│ standing=${standing_level} (stdKey=${stdKey} sizeKey=${sizeKey})`);
  console.log(`│ budget: band=${budget_band} tension=${bt} pressure=${budgetPressure.toFixed(2)} | posture=${feasibility_posture}(×${postureMod})`);
  console.log(`│ risk: adj=${riskAdj} score=${riskSc} penalty=${riskPenalty.toFixed(3)}`);
  console.log(`│ scores: rent=${rentSc} cap=${capSc} mix=${mixSc} phase=${phaseSc}`);
  const results = {};
  const accents = { A: "#2a5298", B: "#1e8449", C: "#d35400" };
  const labels_fr = {
    A: "Scenario intensification", B: "Scenario equilibre", C: "Scenario prudent",
  };
  // Initialize for effective CES (used in program-driven mode)
  let effectiveCESOutput = ces;
  // Extract budgetMax before the loop for use in diagnostic
  let budgetMax = 0;
  if (typeof budget_range === 'string' && budget_range.includes('-')) {
    budgetMax = Number(budget_range.split('-')[1]) || 0;
  } else {
    budgetMax = Number(budget_range) || 0;
  }
  for (const label of ["A", "B", "C"]) {
    const role = SCENARIO_ROLE[label];
    const mode = SCENARIO_MASSING_MODE[label];
    let fp, fpRdc, fpEtages, levels, unitMixDetail, totalUseful, circRatio, bodyDepth, maxPerFloor, groundReserve;
    let unitMix = {};
    let totalUnitsResult = 0;
    let hasPilotis = false;
    let pilotisLevels = 0;
    let target_sdp_programme = 0; // ancre client : target_units × refSize / (1-circ)
    // v57.13 EXPERT RATIOS — lookup pour ce programme × zonage × scénario
    const scenarioKey = label; // A, B, C
    const expertZone = EXPERT_RATIOS[programKey]?.[zoning_type] || EXPERT_RATIOS[programKey]?.Z_DEFAULT;
    const expertRatio = expertZone?.[scenarioKey] || null;
    if (isProgramDriven) {
      // ════════════════════════════════════════════════════════════════════════
      // MODE CES-DRIVEN v57.0
      // RDC = CES_FILL × CES (retrait parking, accès, jardin)
      // ÉTAGES = extension vers limites séparatives (A→enveloppe, B→+15%, C→=RDC)
      // SDP = fpRdc + fpEtages × (niveaux - 1)
      // Le nombre de logements est un RÉSULTAT, pas une entrée.
      // ════════════════════════════════════════════════════════════════════════
      const sizes = (UNIT_SIZES[sizeKey] || UNIT_SIZES.STANDARD)[label];
      // Résoudre les champs rules
      circRatio = resolveField(rules.circulation_ratio, stdKey);
      circRatio = Math.max(0.08, Math.min(0.30, circRatio + (CIRCULATION_BONUS_BY_ROLE[role] || 0)));
      bodyDepth = resolveField(rules.body_depth_m, stdKey);
      maxPerFloor = resolveField(rules.max_units_per_floor, stdKey);
      groundReserve = resolveField(rules.ground_reserve, label) || 0.25;
      let maxFloorsProg = rules.max_floors || 99;
      // ── CAS SPÉCIAUX ──
      const isBungalow = programKey === "MAISON_INDIVIDUELLE" && target_units > 1;
      if (isBungalow) maxFloorsProg = rules.bungalow_max_floors || 1;
      const isFpFromEnvelope = rules.fp_from_envelope === true;
      const effectiveMaxFloors = Math.min(maxFloorsProg, absMaxLevels);
      // ══════════════════════════════════════════════════════════════════════
      // ÉTAPE 1 : CES EFFECTIF CLIENT → EMPREINTES RDC + ÉTAGES
      // ══════════════════════════════════════════════════════════════════════
      // v57.6 : Le CES RÉGLEMENTAIRE lui-même est ajusté par le profil client.
      // Un client AMBITIEUX (rigidité=2, risque=2) utilise le CES complet (60%).
      // Un client SERRÉ (rigidité=8, risque=8) se voit appliquer un CES réduit (~38%).
      // Ensuite CES_FILL_BY_ROLE s'applique NORMALEMENT (0.95/0.80/0.65).
      // Les étages sont une CONSÉQUENCE NATURELLE, pas un forçage.
      // ══════════════════════════════════════════════════════════════════════
      // ── CES EFFECTIF = CES réglementaire × profil client ──
      // Composantes du profil client qui réduisent/augmentent le CES atteignable :
      const clientCesMod =
        (1 - budgetPressure * 0.30)     // budget serré → CES réduit (-30% max)
        * postureMod                      // AMBITIEUX=+8%, PRUDENT=-10%
        * riskPenalty                     // risque élevé → -15% max
        * capacityBoost                   // capacité élevée → +6% max
        * densityBandMult;                // zone dense → CES poussé (+10% max)
      // Bornes : jamais en dessous de 40% du CES réglementaire, jamais au-dessus de 105%
      const effectiveCES = Math.max(ces * 0.40, Math.min(ces * 1.05,
        ces * clientCesMod
      ));
      effectiveCESOutput = effectiveCES;
      const effectiveMaxFp = Math.round(effectiveCES * site_area);
      // ── CES_FILL : constantes architecturales PURES (ne dépendent PAS du client) ──
      const cesFill = CES_FILL_BY_ROLE[role] || 0.80;
      // ══════════════════════════════════════════════════════════════════════
      // v57.15: RÉSERVE TERRAIN DYNAMIQUE — parking + espace vert
      // ══════════════════════════════════════════════════════════════════════
      // Le programme est le driver #1, MAIS il est AFFECTÉ par les besoins
      // terrain : parking requis + espace vert. Si ça ne tient pas au sol,
      // le moteur MONTE EN HAUTEUR plutôt que de s'étaler.
      //
      // Logique : free_ground = enveloppe - emprise
      //   → 1/3 free_ground = parking
      //   → 2/3 free_ground = espace vert
      //   → donc : free_ground ≥ parkingM2 × 3 (pour respecter le ratio 1/3-2/3)
      //   → donc : emprise ≤ enveloppe - (parkingM2 × 3)
      //
      // Si la contrainte est trop forte (>55% de l'enveloppe réservée),
      // on plafonne la réserve mais le diagnostic le signale.
      // ══════════════════════════════════════════════════════════════════════
      const parkingPerUnitEst = rules.parking_per_unit || 1;
      const roleTargetFactorEst = ({ INTENSIFICATION: 1.40, EQUILIBRE: 0.90, PRUDENT: 0.65 })[role] || 0.90;
      const estUnitsForRole = Math.max(2, Math.round(target_units * roleTargetFactorEst));
      const estParkingSpots = Math.ceil(estUnitsForRole * parkingPerUnitEst);
      const estParkingM2 = estParkingSpots * PILOTIS_CONFIG.PARKING_SPOT_M2; // 25m²/place
      // Règle 1/3 parking, 2/3 vert → free_ground ≥ parkingM2 × 3
      const minFreeGroundForParking = estParkingM2 * 3;
      // Garde-fou : la réserve ne peut pas dépasser 55% de l'enveloppe
      const effectiveReserve = Math.min(minFreeGroundForParking, envelope_area * 0.55);
      const fpMaxAfterReserves = Math.round(envelope_area - effectiveReserve);
      // groundReserve classique (ancien système) comme fallback
      const maxFpByEnvelope = Math.min(
        envelope_area * (1 - groundReserve),
        Math.max(200, fpMaxAfterReserves)   // réserve dynamique, plancher 200m²
      );
      // ══════════════════════════════════════════════════════════════════════
      // v57.15: EMPRISE PROGRAMME-DRIVEN — dimensionnée par le plateau optimal
      // ══════════════════════════════════════════════════════════════════════
      // Le plateau est le nombre d'unités/palier × la taille des logements.
      // C'est la taille ARCHITECTURALEMENT CORRECTE pour le programme.
      // Le CES et les niveaux sont des CONSÉQUENCES, pas des cibles.
      //
      // Quand la réserve terrain réduit l'emprise → le moteur MONTE en hauteur.
      // C'est l'interdépendance programme ↔ terrain que vise l'architecte.
      // ══════════════════════════════════════════════════════════════════════
      const fpMaxCes = Math.round(cesFill * effectiveMaxFp);
      const fpMaxEnv = Math.round(maxFpByEnvelope);
      const fpMaxRetraits = Math.round(empriseEffective);
      // Plateau optimal = maxPerFloor × taille logement de référence / (1 - circulation)
      // La taille de référence est le T3 (type dominant au Cameroun)
      const refUnitSize = sizes.T3 || sizes.T4 || 80;
      const fpProgramme = Math.round(maxPerFloor * refUnitSize / (1 - circRatio));
      // Plancher : minimum 2 logements × refSize pour un palier viable
      const fpMinViable = Math.round(Math.max(200, 2 * refUnitSize / (1 - circRatio)));
      // ══════════════════════════════════════════════════════════════════════
      // v57.13 : LOGIQUE PROGRAMME → TERRAIN (pas l'inverse)
      // ══════════════════════════════════════════════════════════════════════
      // Le client a un PROGRAMME (target_units × standing → target_sdp).
      // Le terrain soit CONFIRME (A), ADAPTE (B), ou CONTRAINT (C) ce programme.
      //
      //   A (INTENSIFICATION) = terrain ADAPTE le programme client
      //     → emprise = programme pur, terrain ne fait que PLAFONNER
      //     → le rôle A donne la version la plus ambitieuse du programme
      //   B (EQUILIBRE) = terrain ÉQUILIBRE le programme
      //     → un peu moins ambitieux que A en tailles/unités
      //   C (PRUDENT) = terrain CONTRAINT le programme
      //     → version réduite/prudente du programme
      //
      // target_sdp_programme = ancre client (ce que le client VEUT en m²)
      // Les expert ratios = DIAGNOSTIC narratif (comparaison vs grille expert)
      // Ils ne liftent JAMAIS l'emprise. Le programme commande, le terrain plafonne.
      // ══════════════════════════════════════════════════════════════════════
      const fpExpertMin = expertRatio ? Math.round(expertRatio.ces * site_area) : 0;
      const expertCesPct = expertRatio ? Math.round(expertRatio.ces * 100) : 0;
      // Ancre client : surface totale que le programme demande
      target_sdp_programme = Math.round(target_units * refUnitSize / (1 - circRatio));
      // TOUS LES SCÉNARIOS = PROGRAMME PUR → terrain ne fait que plafonner
      fpRdc = fpProgramme;
      // Plafonds réglementaires (le terrain ne peut jamais aller au-delà)
      fpRdc = Math.min(fpRdc, fpMaxCes, fpMaxEnv, fpMaxRetraits);
      fpRdc = Math.max(fpRdc, fpMinViable);
      fpRdc = Math.round(fpRdc);
      const cesPctResult = Math.round(fpRdc / site_area * 100);
      const cesVsExpert = expertCesPct > 0 ? (cesPctResult >= expertCesPct ? "≥expert" : "<expert") : "";
      const reserveActive = fpMaxAfterReserves < fpProgramme;
      console.log(`│   🏗️ v57.15 ${role}: fpProg=${fpProgramme} → fpRdc=${fpRdc}m² (CES=${cesPctResult}% ${cesVsExpert}) | cible_sdp=${target_sdp_programme}m²`);
      console.log(`│   🅿️ réserve terrain: ${estParkingSpots} places × 25m² = ${estParkingM2}m² parking | free_ground_min=${Math.round(minFreeGroundForParking)}m² | fpMaxReserve=${fpMaxAfterReserves}m² ${reserveActive ? "⚡CONTRAINT" : "✓ok"}`);
      // ÉTAGES : extension selon le rôle
      const etageExt = ETAGE_EXTENSION_BY_ROLE[role];
      const empriseEtageMax = empriseEffective * (nbMitoyens > 0 ? 1.10 : 1.0);
      if (etageExt === "ENVELOPE") {
        fpEtages = Math.round(Math.min(fpRdc * 1.15, envelope_area, effectiveMaxFp, empriseEtageMax * 1.05));
      } else {
        fpEtages = Math.round(Math.min(fpRdc * (etageExt || 1.0), envelope_area, effectiveMaxFp, empriseEtageMax));
      }
      // fp principal (pour le rendu 3D) = fpEtages (volume dominant)
      fp = fpEtages;
      let floorsNeeded, totalUnits;
      totalUseful = 0;
      const details = [];
      // Helper COS check : SDP = fpRdc + fpEtages × (niv - 1)
      const computeSdpDual = (niv) => fpRdc + fpEtages * Math.max(0, niv - 1);
      const cosCap = COS_CAP_BY_ROLE[role] || 1.0;
      const maxSdpForRole = Math.floor(max_sdp * cosCap);
      if (isFpFromEnvelope) {
        // ── BUREAUX : plateaux proportionnels au CES effectif et rôle scénario ──
        // v57.6: Apply roleTargetFactor to ensure A >= B >= C in floor count
        const cesRatio = effectiveCES / ces;
        const roleTargetFactor = ({ INTENSIFICATION: 1.40, EQUILIBRE: 0.90, PRUDENT: 0.65 })[role] || 0.90;
        const effectiveTargetBur = Math.max(1, Math.round(target_units * cesRatio * roleTargetFactor));
        floorsNeeded = Math.min(effectiveTargetBur, effectiveMaxFloors);
        // v57.13 : niveaux = conséquence programme, pas de floor min expert
        floorsNeeded = Math.max(1, floorsNeeded);
        // COS check avec SDP duale
        while (floorsNeeded > 1 && computeSdpDual(floorsNeeded) > maxSdpForRole) floorsNeeded--;
        if (computeSdpDual(floorsNeeded) > maxSdpForRole && floorsNeeded === 1) {
          fpRdc = Math.round(maxSdpForRole);
          fpEtages = fpRdc;
        }
        totalUnits = floorsNeeded;
        const sdpBur = computeSdpDual(floorsNeeded);
        totalUseful = Math.round(sdpBur * (1 - circRatio));
        unitMixDetail = `${floorsNeeded} plateaux (RDC=${fpRdc}m² + ${Math.max(0,floorsNeeded-1)}ét.×${fpEtages}m², utile ${Math.round(fpEtages*(1-circRatio))}m²/ét.)`;
        fp = fpEtages; // rendu 3D
        unitMix = { BUREAU: floorsNeeded };
      } else if (isBungalow) {
        // ── BUNGALOWS : plain-pied, pas d'extension étage ──
        const mix = rules.default_mix_fn ? rules.default_mix_fn(target_units) : { T3: target_units };
        totalUnits = 0;
        for (const [typ, count] of Object.entries(mix)) {
          if (count <= 0) continue;
          const unitSize = sizes[typ] || sizes.T3 || 80;
          totalUseful += count * unitSize;
          totalUnits += count;
          details.push(`${count}×${typ}(${unitSize}m²)`);
        }
        floorsNeeded = 1;
        fpRdc = Math.round(totalUseful / (1 - circRatio));
        if (fpRdc > max_fp) fpRdc = Math.round(max_fp);
        if (fpRdc > maxFpByEnvelope) fpRdc = Math.round(maxFpByEnvelope);
        fpEtages = fpRdc;
        fp = fpRdc;
        unitMixDetail = `${totalUnits} bungalows: ` + details.join(" + ");
        unitMix = mix;
      } else if (programKey === "MAISON_INDIVIDUELLE" && target_units <= 1) {
        // ── VILLA : RDC + étage étendu ──
        floorsNeeded = Math.min(2, effectiveMaxFloors);
        while (floorsNeeded > 1 && computeSdpDual(floorsNeeded) > maxSdpForRole) floorsNeeded--;
        totalUnits = 1;
        const sdpVilla = computeSdpDual(floorsNeeded);
        totalUseful = Math.round(sdpVilla * (1 - circRatio));
        let villaTypo = "T4";
        if (totalUseful >= (sizes.T5 || 999) * 0.9) villaTypo = "T5";
        else if (totalUseful >= (sizes.T4 || 120)) villaTypo = "T4";
        else if (totalUseful >= (sizes.T3 || 80)) villaTypo = "T3";
        unitMixDetail = `1 villa ${villaTypo} (${totalUseful}m² utile, RDC=${fpRdc}m² ét.=${fpEtages}m²)`;
        unitMix = { [villaTypo]: 1 };
      } else if (programKey === "USAGE_MIXTE") {
        // ── USAGE MIXTE : Commerce RDC (fpRdc) + Logements étages (fpEtages) ──
        const usefulEtage = fpEtages * (1 - circRatio);
        // Commerce count from mix function
        const estMix = rules.default_mix_fn ? rules.default_mix_fn(target_units) : { COMMERCE: 1, T3: target_units - 1 };
        const commerceUnits = estMix.COMMERCE || 1;
        // Résidentiel par étage
        const resiAvgSize = computeAvgResidentialSize(sizes, rules, target_units);
        let resiPerFloor = Math.floor(usefulEtage / resiAvgSize);
        let effectiveMaxPerFloor = maxPerFloor;
        // Adaptation maxPerFloor seulement pour A si le plateau le permet
        if (role === "INTENSIFICATION" && usefulEtage >= resiAvgSize * (maxPerFloor + 1) * 1.20) {
          effectiveMaxPerFloor = maxPerFloor + 1;
        }
        resiPerFloor = Math.max(1, Math.min(effectiveMaxPerFloor, resiPerFloor));
        // v57.6 : target résidentiel proportionnel au CES effectif × rôle
        const cesRatio = effectiveCES / ces;
        const roleTargetFactor = ({ INTENSIFICATION: 1.40, EQUILIBRE: 0.90, PRUDENT: 0.65 })[role] || 0.90;
        const effectiveTargetResi = Math.max(1, Math.round((target_units - commerceUnits) * cesRatio * roleTargetFactor));
        floorsNeeded = 1 + Math.ceil(effectiveTargetResi / resiPerFloor);
        // v57.13 : niveaux = conséquence programme
        floorsNeeded = Math.max(2, Math.min(floorsNeeded, effectiveMaxFloors));
        while (floorsNeeded > 2 && computeSdpDual(floorsNeeded) > maxSdpForRole) floorsNeeded--;
        const actualResiFloors = floorsNeeded - 1;
        totalUnits = commerceUnits + resiPerFloor * actualResiFloors;
        // Mix réel
        const resiMix = rules.default_mix_fn ? rules.default_mix_fn(totalUnits) : { COMMERCE: commerceUnits, T3: totalUnits - commerceUnits };
        totalUseful = 0;
        let mixUnits = 0;
        for (const [typ, count] of Object.entries(resiMix)) {
          if (count <= 0) continue;
          const unitSize = sizes[typ] || sizes.T3 || 80;
          totalUseful += count * unitSize;
          mixUnits += count;
          details.push(`${count}×${typ}(${unitSize}m²)`);
        }
        totalUnits = mixUnits;
        unitMixDetail = details.join(" + ");
        unitMix = resiMix;
      } else {
        // ══════════════════════════════════════════════════════════════════
        // ── IMMEUBLES GÉNÉRIQUES (PETIT_COLLECTIF, IMMEUBLE_RAPPORT,
        //    PROGRAMME_FLOU) — logique CES-DRIVEN + extension étages ──
        // ══════════════════════════════════════════════════════════════════
        // ── Unités/palier : adaptatif au plateau, capé par programme ──
        const usefulEtage = fpEtages * (1 - circRatio);
        const avgSize = computeAvgResidentialSize(sizes, rules, target_units);
        let effectiveMaxPerFloor = maxPerFloor;
        // v57.6 : maxPerFloor adaptatif SEULEMENT pour A (INTENSIFICATION)
        // Si le plateau est assez grand pour accueillir +1 confortablement
        // (marge de 20% pour circulation large, rangements, etc.)
        // On ne touche PAS B/C — ils restent au standard programme.
        const isMaxDriver = /MAX_CAPACITE|RENTABILITE/i.test(primary_driver);
        if (role === "INTENSIFICATION") {
          const canFitMore = usefulEtage >= avgSize * (maxPerFloor + 1) * 1.20;
          if (canFitMore || isMaxDriver) {
            effectiveMaxPerFloor = maxPerFloor + 1;
            console.log(`│   💪 ${role}: plateau ${Math.round(usefulEtage)}m² utile → ${effectiveMaxPerFloor} logts/palier (base ${maxPerFloor})`);
          }
        }
        let unitsPerFloor = Math.floor(usefulEtage / avgSize);
        unitsPerFloor = Math.max(1, Math.min(effectiveMaxPerFloor, unitsPerFloor));
        // v57.6 : effectiveTarget PROPORTIONNEL au CES effectif × rôle scénario
        // - CES effectif = profil client (budget, risque, posture)
        // - roleTargetFactor = ambition du scénario (A=max, B=standard, C=réduit)
        // Le nombre de logements est un RÉSULTAT, pas une cible fixe.
        const cesRatio = effectiveCES / ces;
        const roleTargetFactor = ({ INTENSIFICATION: 1.40, EQUILIBRE: 0.90, PRUDENT: 0.65 })[role] || 0.90;
        const effectiveTarget = Math.max(2, Math.round(target_units * cesRatio * roleTargetFactor));
        floorsNeeded = Math.ceil(effectiveTarget / unitsPerFloor);
        // v57.13 : niveaux = CONSÉQUENCE PURE du programme
        // Tous les scénarios : le nombre de niveaux découle du target effectif / unitsPerFloor
        // Min 2 niveaux (un bâtiment collectif à 1 niveau n'a pas de sens architectural)
        // Pas de floor min expert — le programme commande, le terrain plafonne.
        floorsNeeded = Math.max(2, Math.min(floorsNeeded, effectiveMaxFloors));
        // COS check duale
        while (floorsNeeded > 1 && computeSdpDual(floorsNeeded) > maxSdpForRole) floorsNeeded--;
        // v57.15: anti-paradoxe zonage — empêche compensation verticale excessive
        // Quand le terrain contraint le plateau (CES bas → fpEtages réduit → moins de logts/palier),
        // le moteur ne doit PAS compenser en ajoutant des niveaux au-delà du besoin programme.
        // Sans ce garde-fou, un CES restrictif (PERIURBAIN, PAVILLON) peut produire PLUS de SDP
        // qu'un CES permissif (URBAIN) — paradoxe architectural.
        // Double garde-fou : unités ET SDP ne doivent pas dépasser le programme.
        while (floorsNeeded > 2 && unitsPerFloor * floorsNeeded > effectiveTarget * 1.20) floorsNeeded--;
        // SDP cap : la SDP ne doit pas dépasser ce que le programme demande (avec marge role)
        const sdpCapProgramme = Math.round(target_sdp_programme * roleTargetFactor * 1.35);
        while (floorsNeeded > 2 && computeSdpDual(floorsNeeded) > sdpCapProgramme) floorsNeeded--;
        totalUnits = unitsPerFloor * floorsNeeded;
        // Mix réel
        const mix = rules.default_mix_fn ? rules.default_mix_fn(totalUnits) : { T3: totalUnits };
        totalUseful = 0;
        let mixUnits = 0;
        for (const [typ, count] of Object.entries(mix)) {
          if (count <= 0) continue;
          const unitSize = sizes[typ] || sizes.T3 || 80;
          totalUseful += count * unitSize;
          mixUnits += count;
          details.push(`${count}×${typ}(${unitSize}m²)`);
        }
        totalUnits = mixUnits;
        unitMixDetail = details.join(" + ");
        unitMix = mix;
      }
      levels = floorsNeeded;
      // ── PILOTIS ──
      const freeGround = envelope_area - fpRdc;
      const parkingSpotsNeeded = Math.max(PILOTIS_CONFIG.MIN_PARKING_SPOTS, Math.ceil((totalUnits || 1) * (rules.parking_per_unit || 1)));
      const parkingM2Needed = parkingSpotsNeeded * PILOTIS_CONFIG.PARKING_SPOT_M2;
      const freeGroundPct = freeGround / Math.max(1, envelope_area);
      const pilotisRule = rules.requires_pilotis;
      // v57.16: ratio parking/vert — si le parking requis dépasse 40% du sol libre,
      // le ratio 1/3 parking - 2/3 vert est impossible → pilotis auto
      const parkingRatioExceeded = freeGround > 0 && parkingM2Needed > freeGround * 0.40;
      if (!isBungalow && (pilotisRule === true || (pilotisRule === "auto" && (
        // ancien seuil : sol libre insuffisant en absolu
        ((freeGround < PILOTIS_CONFIG.MIN_FREE_GROUND_M2 || freeGroundPct < PILOTIS_CONFIG.MIN_FREE_GROUND_PCT)
          && freeGround < parkingM2Needed)
        // v57.16 : ratio parking/vert déséquilibré → pilotis pour libérer le sol
        || parkingRatioExceeded
      )))) {
        hasPilotis = true;
        pilotisLevels = 1;
        if (parkingRatioExceeded) {
          console.log(`│   🅿️→🏗️ v57.16: parking ${Math.round(parkingM2Needed)}m² > 40% sol libre ${Math.round(freeGround)}m² → PILOTIS AUTO (ratio 1/3-2/3 impossible sans pilotis)`);
        }
      }
      // Commerce au RDC
      const hasRdcCommerce = rules.rdc_commerce || false;
      const rdcHeightM = hasRdcCommerce ? (rules.rdc_height_m || 4.0) : floor_height;
      const sdpDual = computeSdpDual(levels);
      console.log(`│ ✅ ${label} (${role}) CES-DRIVEN v57.13${isBungalow ? " [BUNGALOWS]" : ""}:`);
      console.log(`│   📊 CES EFFECTIF: réglementaire=${(ces*100).toFixed(0)}% → client=${(effectiveCES*100).toFixed(1)}% (clientMod=${clientCesMod.toFixed(3)}: budPres=${budgetPressure.toFixed(2)} post=${postureMod} risk=${riskPenalty.toFixed(3)} cap=${capacityBoost.toFixed(3)} dens=${densityBandMult})`);
      console.log(`│   📊 maxFp: réglementaire=${Math.round(max_fp)}m² → client=${effectiveMaxFp}m² | cesFill=${(cesFill*100).toFixed(0)}% (role=${role})`);
      console.log(`│   RDC=${fpRdc}m² (${(fpRdc/site_area*100).toFixed(0)}% terrain) | ét.=${fpEtages}m² (${(fpEtages/site_area*100).toFixed(0)}%) [${etageExt === "ENVELOPE" ? "→enveloppe" : "×" + etageExt}]`);
      console.log(`│   mix: ${unitMixDetail} | ${totalUnits || 0} logts (souhait: ${target_units})`);
      console.log(`│   ${levels}niv → SDP=${sdpDual}m² (COS ${(sdpDual/max_sdp*100).toFixed(0)}%)`);
      console.log(`│   sol libre=${Math.round(freeGround)}m² parking=${parkingSpotsNeeded} places`);
      if (hasPilotis) console.log(`│   ⚡ PILOTIS activé`);
      if (hasRdcCommerce) console.log(`│   🏪 RDC Commerce (h=${rdcHeightM}m)`);
      totalUnitsResult = totalUnits || 0;
    } else {
      // ════════════════════════════════════════════════════════════════════════
      // MODE REGULATION-DRIVEN (FALLBACK) : fp dérivé du CES × ratio
      // ════════════════════════════════════════════════════════════════════════
      const baseRatio = ratios[label];
      let budgetMod = 1.0;
      if (mode === "BALANCED") budgetMod = 1.0 + (0.5 - budgetPressure) * 0.12 * intensitySpread;
      else if (mode === "SPREAD") budgetMod = 1.0 + (0.5 - budgetPressure) * 0.20 * intensitySpread;
      else if (mode === "COMPACT") budgetMod = 1.0 + budgetPressure * 0.08;
      let ratio = baseRatio * standingFactor * budgetMod;
      ratio = ratio * (1 + (dpf - 1) * 0.15) * densityBandMult;
      ratio = ratio * postureMod * riskPenalty * capacityBoost;
      if (label === "C") ratio = ratio * phaseBoostC;
      ratio = Math.max(0.30, Math.min(0.98, ratio));
      // Réserve sol
      const reserveRole = RESERVE_BY_ROLE[role] || 0.25;
      const reserveStanding = RESERVE_STANDING[String(standing_level).toUpperCase()] || 0.05;
      const progUp = String(program_main).toUpperCase();
      let reserveProgram = RESERVE_PROGRAM.DEFAULT;
      if (/MIXTE|MIXED/.test(progUp)) reserveProgram = RESERVE_PROGRAM.MIXTE;
      else if (/COMMERCE/.test(progUp)) reserveProgram = RESERVE_PROGRAM.COMMERCE;
      else if (/BUREAU|OFFICE/.test(progUp)) reserveProgram = RESERVE_PROGRAM.BUREAUX;
      else if (/COLLECTIF|DENSE/.test(progUp)) reserveProgram = RESERVE_PROGRAM.COLLECTIF;
      else if (/RAPPORT|LOCATIF/.test(progUp)) reserveProgram = RESERVE_PROGRAM.IMMEUBLE_RAPPORT;
      groundReserve = Math.min(0.60, reserveRole + reserveStanding + reserveProgram);
      const maxFpByEnvelope = envelope_area * (1 - groundReserve);
      const effectiveMaxFp = Math.min(max_fp, maxFpByEnvelope);
      fp = Math.max(50, Math.round(effectiveMaxFp * ratio));
      // Niveaux (regulation-driven)
      let baseLevelMult = levelMultiplier(role);
      if (budgetPressure > 0.5 && role === "INTENSIFICATION")
        baseLevelMult = Math.min(1.0, baseLevelMult + (budgetPressure - 0.5) * 0.3);
      if (budgetPressure < 0.3 && role === "PRUDENT")
        baseLevelMult = Math.max(0.15, baseLevelMult - (0.3 - budgetPressure) * 0.15);
      baseLevelMult = baseLevelMult * rentLevelBoost * postureMod * riskPenalty;
      baseLevelMult = Math.max(0.15, Math.min(1.2, baseLevelMult));
      levels = Math.max(1, Math.min(Math.round(absMaxLevels * baseLevelMult), absMaxLevels));
      if (target_surface_m2 > 0 && fp > 0) {
        const idealLevels = Math.ceil(target_surface_m2 * ratio / fp);
        levels = Math.max(1, Math.min(Math.round((idealLevels + levels) / 2), absMaxLevels));
      }
      // COS cap
      const cosCap = COS_CAP_BY_ROLE[role] || 1.0;
      const maxSdpForRole = Math.floor(max_sdp * cosCap);
      if (fp > 0 && levels > Math.floor(maxSdpForRole / fp)) {
        levels = Math.max(1, Math.floor(maxSdpForRole / fp));
      }
      // Pilotis check (regulation mode)
      const freeGround = envelope_area - fp;
      const parkingSpotsNeeded = Math.max(PILOTIS_CONFIG.MIN_PARKING_SPOTS, Math.ceil(fp * levels / 70));
      const parkingM2Needed = parkingSpotsNeeded * PILOTIS_CONFIG.PARKING_SPOT_M2;
      const freeGroundPct = freeGround / Math.max(1, envelope_area);
      // v57.16: ratio parking/vert
      const parkingRatioExceeded = freeGround > 0 && parkingM2Needed > freeGround * 0.40;
      if ((freeGround < PILOTIS_CONFIG.MIN_FREE_GROUND_M2 || freeGroundPct < PILOTIS_CONFIG.MIN_FREE_GROUND_PCT)
          && freeGround < parkingM2Needed
          || parkingRatioExceeded) {
        hasPilotis = true;
        pilotisLevels = 1;
      }
      unitMixDetail = null;
      totalUseful = 0;
      circRatio = 0;
      bodyDepth = 0;
      fpRdc = fp;
      fpEtages = fp;
      console.log(`│ 📐 ${label} (${role}) REGULATION-DRIVEN: ratio=${ratio.toFixed(3)} fp=${fp}m² levels=${levels}`);
    }
    // ══════════════════════════════════════════════════════════════════════════
    // CALCULS COMMUNS (program-driven et regulation-driven)
    // ══════════════════════════════════════════════════════════════════════════
    const totalLevelsWithPilotis = levels + pilotisLevels;
    const pilotisH = hasPilotis ? PILOTIS_CONFIG.PILOTIS_HEIGHT_M : 0;
    const height = Math.round((levels * floor_height + pilotisH) * 10) / 10;
    // SDP duale : RDC + étages (si fpRdc/fpEtages définis), sinon classique
    const sdp = (fpRdc && fpEtages && levels > 1)
      ? fpRdc + fpEtages * (levels - 1)
      : fp * levels;
    const cosRatio = max_sdp > 0 ? sdp / max_sdp : 0;
    let compliance;
    if (cosRatio <= 1.05) compliance = "CONFORME";
    else if (cosRatio <= 1.30) compliance = "DEROGATION_POSSIBLE";
    else compliance = "AMBITIEUX_HORS_COS";
    // v57.6: Coût estimé FCFA (Cameroun) = Construction + VRD
    // Construction = SDP × coût/m²
    // VRD = 10% de SDP × 50% du coût/m²
    // Total = construction + VRD = SDP × costPerM2 × 1.05
    const COST_PER_M2_FCFA = {
      PREMIUM: 400000, HAUT: 350000,
      STANDARD: 250000,
      ECONOMIQUE: 180000, ECO: 180000
    };
    const costPerM2 = COST_PER_M2_FCFA[String(standing_level).toUpperCase()] || 250000;
    const constructionCost = sdp * costPerM2;
    const vrdCost = (sdp * 0.10) * (costPerM2 * 0.50);
    const estimatedCost = Math.round(constructionCost + vrdCost);
    // budgetMax is already computed before the loop
    const budgetFit = budgetMax > 0
      ? (estimatedCost <= budgetMax ? "DANS_BUDGET" : estimatedCost <= budgetMax * 1.2 ? "BUDGET_TENDU" : "HORS_BUDGET")
      : "N/A";
    const freeGround = envelope_area - (fpRdc || fp); // espace libre au sol = enveloppe - empreinte RDC
    const parkingEst = hasPilotis ? Math.floor((fpRdc || fp) / PILOTIS_CONFIG.PARKING_SPOT_M2) : Math.floor(freeGround / PILOTIS_CONFIG.PARKING_SPOT_M2);
    // ── v57.13 PARKING DÉTAILLÉ + ESPACE DÉGAGÉ (corrigé) ──
    // Parking basé sur les places REQUISES (réglementation), pas sur tout l'espace théorique
    const parkingPerUnit = rules.parking_per_unit || 1;
    const parkingRequired = Math.max(PILOTIS_CONFIG.MIN_PARKING_SPOTS, Math.ceil((totalUnitsResult || 1) * parkingPerUnit));
    const parkingSource = hasPilotis ? "PILOTIS" : "SURFACE";
    // Sol libre TOTAL = site_area - emprise RDC (inclut retraits, cour, jardin, parking)
    const solLibreTotal = site_area - (fpRdc || fp);
    // v57.13: Ratio réaliste — parking requis occupe ~1/3 du sol libre, espace dégagé ~2/3
    // On dimensionne le parking sur les places requises uniquement
    const parkingM2Requis = parkingRequired * PILOTIS_CONFIG.PARKING_SPOT_M2;
    const parkingM2Effectif = hasPilotis ? 0 : Math.min(parkingM2Requis, Math.round(solLibreTotal * 0.33));
    const parkingPlacesEffectif = hasPilotis
      ? Math.floor((fpRdc || fp) / PILOTIS_CONFIG.PARKING_SPOT_M2) // pilotis : sous le bâtiment
      : Math.floor(parkingM2Effectif / PILOTIS_CONFIG.PARKING_SPOT_M2);
    const parkingSuffisant = parkingPlacesEffectif >= parkingRequired;
    const parkingDeficit = parkingSuffisant ? 0 : parkingRequired - parkingPlacesEffectif;
    // Espace dégagé = sol libre - parking effectif en surface
    const espaceVert = Math.max(0, Math.round(solLibreTotal - parkingM2Effectif));
    const freeGroundPctTotal = site_area > 0 ? solLibreTotal / site_area : 0;
    const espaceVertPct = site_area > 0 ? espaceVert / site_area : 0;
    const ratioParkingEspace = solLibreTotal > 0
      ? `${Math.round(parkingM2Effectif / solLibreTotal * 100)}/${Math.round(espaceVert / solLibreTotal * 100)}`
      : "0/0";
    // Qualification de l'espace dégagé (basée sur espace vert réel, pas le sol brut)
    let espaceQualite = "CONFORTABLE";
    let espaceDescription = "";
    if (espaceVertPct >= 0.40) {
      espaceQualite = "GENEREUX";
      espaceDescription = "Espace exterieur genereux — jardin, terrasses, aire de jeux possibles";
    } else if (espaceVertPct >= 0.25) {
      espaceQualite = "CONFORTABLE";
      espaceDescription = "Espace exterieur confortable — cour paysagee, acces vehicules et espaces de vie exterieurs";
    } else if (espaceVertPct >= 0.15) {
      espaceQualite = "FONCTIONNEL";
      espaceDescription = "Espace exterieur fonctionnel — acces, circulation et stationnement assures, mais peu d'agrement";
    } else {
      espaceQualite = "CONTRAINT";
      espaceDescription = "Espace exterieur contraint — privilegier le parking en sous-sol ou pilotis pour liberer du sol";
    }
    // Mitoyenneté justification
    let mitoyenneteJustification = "";
    if (nbMitoyens >= 2) {
      mitoyenneteJustification = `Construction en mitoyennete sur ${nbMitoyens} cotes lateraux, conformement a la pratique courante en zone ${zoning_type} dense. Les murs mitoyens suppriment le retrait lateral (${rLateral}m) sur ces cotes, liberant ${nbMitoyens * rLateral}m de largeur constructible supplementaire. Cette configuration maximise l'emprise au sol sur les parcelles etroites du tissu urbain`;
    } else if (nbMitoyens === 1) {
      mitoyenneteJustification = `Construction en mitoyennete sur 1 cote lateral (appui sur le voisin existant), retrait lateral de ${rLateral}m maintenu de l'autre cote. Configuration courante en zone ${zoning_type} semi-dense`;
    } else {
      mitoyenneteJustification = `Construction isolee — retraits lateraux de ${rLateral}m respectes des deux cotes. Pas de mitoyennete (zone ${zoning_type})`;
    }
    results[label] = {
      fp_m2: fp, fp_rdc_m2: fpRdc || fp, fp_etages_m2: fpEtages || fp,
      levels, height_m: height,
      commerce_levels: commerceLevels,
      massing_mode: mode,
      sdp_m2: sdp,
      cos_compliance: compliance,
      cos_ratio_pct: Math.round(cosRatio * 100),
      has_pilotis: hasPilotis,
      pilotis_levels: pilotisLevels,
      total_levels_incl_pilotis: totalLevelsWithPilotis,
      ground_reserve_pct: Math.round((groundReserve || 0) * 100),
      free_ground_m2: Math.round(freeGround),
      parking_spots_estimate: parkingPlacesEffectif,
      // v57.13 parking détaillé + espace dégagé (basé sur requis, ratio 1/3-2/3)
      parking_detail: {
        places_disponibles: parkingPlacesEffectif,
        places_requises: parkingRequired,
        ratio_par_unite: parkingPerUnit,
        suffisant: parkingSuffisant,
        deficit: parkingDeficit,
        source: parkingSource,
        m2_parking: Math.round(parkingM2Effectif),
        m2_parking_requis: Math.round(parkingM2Requis),
      },
      espace_degage: {
        sol_libre_total_m2: Math.round(solLibreTotal),
        sol_libre_pct: Math.round(freeGroundPctTotal * 100),
        espace_vert_m2: espaceVert,
        espace_vert_pct: Math.round(espaceVertPct * 100),
        ratio_parking_espace: ratioParkingEspace,
        qualite: espaceQualite,
        description: espaceDescription,
      },
      mitoyennete_detail: {
        nb_cotes: nbMitoyens,
        justification: mitoyenneteJustification,
        largeur_recuperee_m: nbMitoyens * rLateral,
      },
      role: SCENARIO_ROLE[label],
      label_fr: labels_fr[label],
      accent_color: accents[label],
      estimated_cost: estimatedCost,
      budget_fit: budgetFit,
      // v57.0 CES-driven extras
      program_driven: isProgramDriven,
      program_key: programKey || "NONE",
      unit_mix_detail: unitMixDetail || "N/A",
      total_units: totalUnitsResult,
      target_units_client: target_units || 0,
      total_useful_m2: Math.round(totalUseful || 0),
      circulation_ratio_pct: Math.round((circRatio || 0) * 100),
      ces_fill_pct: Math.round(((fpRdc || fp) / Math.max(1, site_area)) * 100),  // % réel du terrain occupé au sol
      body_depth_m: bodyDepth || 0,
      // v57.13 EXPERT RATIOS — grille architecte-urbaniste africain
      // v57.13 — ancre programme client
      target_sdp_programme_m2: target_sdp_programme || 0,
      // v57.13 EXPERT RATIOS — diagnostic (narrative, pas lifting)
      expert_ces_recommande_pct: expertRatio ? Math.round(expertRatio.ces * 100) : null,
      expert_floors_range: expertRatio?.fl || null,
      expert_efficiency_pct: expertRatio ? Math.round(expertRatio.eff * 100) : null,
      // ── v57.6 EFFICIENCY METRICS ──
      surface_habitable_m2: Math.round(totalUseful || 0),
      ratio_efficacite_pct: sdp > 0 ? Math.round((totalUseful || 0) / sdp * 100) : 0,
      m2_habitable_par_logement: totalUnitsResult > 0 ? Math.round((totalUseful || 0) / totalUnitsResult) : 0,
      // ── v57.6 COST BREAKDOWN ──
      cost_construction_fcfa: Math.round(constructionCost),
      cost_vrd_fcfa: Math.round(vrdCost),
      cost_total_fcfa: estimatedCost,
      cost_per_m2_sdp: Math.round(costPerM2 * 1.05),
      cost_per_unit: totalUnitsResult > 0 ? Math.round(estimatedCost / totalUnitsResult) : 0,
      cost_per_m2_habitable: (totalUseful > 0) ? Math.round(estimatedCost / totalUseful) : 0,
      // ── 2. REGULATORY COMPLIANCE (new in v57.6) ──
      regulatory: {
        ces_reglementaire_pct: Math.round(ces * 100),
        ces_effectif_pct: Math.round((effectiveCESOutput || ces) * 100),
        ces_utilise_pct: Math.round(((fpRdc || fp) / Math.max(1, site_area)) * 100),
        ces_marge_pct: Math.round((ces - (fpRdc || fp) / Math.max(1, site_area)) * 100),
        cos_reglementaire: cos,
        cos_utilise_pct: Math.round(cosRatio * 100),
        cos_marge_pct: Math.round((1 - cosRatio) * 100),
        hauteur_max_m: Number(max_height_m) || 99,
        hauteur_projet_m: height,
        hauteur_marge_m: Math.round(((Number(max_height_m) || 99) - height) * 10) / 10,
        conformite_globale: compliance === "CONFORME" ? "CONFORME" : compliance,
        // v57.7 retraits
        retrait_avant_m: rAvant,
        retrait_lateral_m: rLateral,
        retrait_arriere_m: rArriere,
        mitoyennete_cotes: nbMitoyens,
        emprise_constructible_m2: Math.round(empriseConstructible),
        emprise_effective_m2: Math.round(empriseEffective),
        reduction_retraits_pct: setbackReductionPct,
        // v57.9 solaire
        zone_climatique: climaticZone,
        orientation_score: solarImpact.orientationScore,
        profondeur_recommandee_m: solarImpact.profondeur_recommandee_m,
        facade_optimale: solarImpact.facade_optimale,
        facade_a_proteger: solarImpact.facade_a_proteger,
        ventilation_traversante: solarImpact.ventilation_traversante,
        brise_soleil: solarImpact.brise_soleil,
        malus_orientation_pct: solarImpact.malus_orientation_pct,
      },
      // ── 3. SCENARIO IDENTITY (new in v57.6) ──
      scenario_identity: {
        code: label,
        nom: labels_fr[label],
        role: SCENARIO_ROLE[label],
        description: generateScenarioDescription(label, SCENARIO_ROLE[label], {
          ces_fill_pct: Math.round(((fpRdc || fp) / Math.max(1, site_area)) * 100),
          sdp: sdp,
          levels: levels,
          free_ground_m2: Math.round(freeGround),
        }),
      },
      // ── v57.6 FINANCIAL LAYER ──
      revenu_mensuel_brut: 0,
      revenu_annuel_brut: 0,
      revenu_annuel_net: 0,
      revenu_detail: {},
      vacancy_rate_pct: 0,
      rendement_brut_pct: 0,
      roi_annees: 0,
      ratio_invest_revenu: 0,
      cout_fourchette: { bas: 0, median: estimatedCost, haut: 0 },
      complexite: { score: 0, label: "Moyen" },
      risque: "MOYEN",
    };
    // ── v57.6 REVENUE & FINANCIAL INDICATORS ──
    const loyerKey = /PREMIUM|HAUT/i.test(String(standing_level)) ? "PREMIUM" : /ECO/i.test(String(standing_level)) ? "ECO" : "STANDARD";
    const loyers = LOYERS_MENSUELS_FCFA[loyerKey] || LOYERS_MENSUELS_FCFA.STANDARD;
    const vacancyRate = VACANCY_RATE_BY_ZONING[zoning_type] || 0.15;
    let revenuMensuelBrut = 0;
    const revenuDetail = {};
    for (const [typo, count] of Object.entries(unitMix)) {
      if (count <= 0) continue;
      const loyerUnit = loyers[typo] || loyers.T3 || 100000;
      revenuMensuelBrut += count * loyerUnit;
      revenuDetail[typo] = { count, loyer_unitaire: loyerUnit, loyer_total: count * loyerUnit };
    }
    const revenuAnnuelBrut = revenuMensuelBrut * 12;
    const revenuAnnuelNet = Math.round(revenuAnnuelBrut * (1 - vacancyRate));
    const rendementBrutPct = estimatedCost > 0 ? Math.round(revenuAnnuelNet / estimatedCost * 10000) / 100 : 0;
    const roiAnnees = revenuAnnuelNet > 0 ? Math.round(estimatedCost / revenuAnnuelNet * 10) / 10 : 0;
    // Cost range (fourchette)
    const costBas = Math.round(estimatedCost * COST_RANGE_MULT.bas);
    const costHaut = Math.round(estimatedCost * COST_RANGE_MULT.haut);
    // Complexity (1-5)
    const complexityScore = Math.min(5, 1 + Math.floor(levels / 2) + (hasPilotis ? 1 : 0) + (totalUnitsResult > 12 ? 1 : 0) + (commerceLevels > 0 ? 1 : 0));
    const complexityLabel = ["", "Faible", "Modere", "Moyen", "Eleve", "Tres eleve"][complexityScore] || "Moyen";
    // Risk level
    let riskLevel = "MOYEN";
    if (budgetFit === "HORS_BUDGET" && cosRatio > 0.90) riskLevel = "ELEVE";
    else if (budgetFit === "DANS_BUDGET" && cosRatio < 0.80) riskLevel = "FAIBLE";
    else if (budgetFit === "HORS_BUDGET") riskLevel = "ELEVE";
    else if (cosRatio > 0.95) riskLevel = "ELEVE";
    // v57.9: ventilation des coûts par poste + honoraires fourchette + frais + solaire
    const coutConstruction = Math.round(sdp * costPerM2); // hors VRD
    const honorairesResult = calcHonorairesDegressifs(estimatedCost);
    const honorairesArchi = honorairesResult.median;
    const tauxHonorairesBas = estimatedCost > 0 ? Math.round(honorairesResult.bas / estimatedCost * 10000) / 100 : 0;
    const tauxHonorairesHaut = estimatedCost > 0 ? Math.round(honorairesResult.haut / estimatedCost * 10000) / 100 : 0;
    const tauxHonoraires = estimatedCost > 0 ? Math.round(honorairesArchi / estimatedCost * 10000) / 100 : 0;
    const fraisPermis = Math.round(estimatedCost * FRAIS_ANNEXES_PCT.permis_construire);
    const fraisAssurance = Math.round(estimatedCost * FRAIS_ANNEXES_PCT.assurance_dommage_ouvrage);
    const fraisEtudes = Math.round(estimatedCost * FRAIS_ANNEXES_PCT.etudes_techniques);
    const fraisDivers = Math.round(estimatedCost * FRAIS_ANNEXES_PCT.divers_imprevus);
    const totalFraisAnnexes = fraisPermis + fraisAssurance + fraisEtudes + fraisDivers;
    // Malus orientation solaire (surcoût climatisation si mal orienté)
    const malusSolaire = solarImpact.malus_orientation_pct > 0 ? Math.round(estimatedCost * solarImpact.malus_orientation_pct / 100) : 0;
    const coutGlobalProjet = estimatedCost + honorairesArchi + totalFraisAnnexes + malusSolaire;
    results[label].cout_ventilation = {
      gros_oeuvre_fcfa: Math.round(coutConstruction * COST_VENTILATION_PCT.gros_oeuvre),
      second_oeuvre_fcfa: Math.round(coutConstruction * COST_VENTILATION_PCT.second_oeuvre),
      lots_techniques_fcfa: Math.round(coutConstruction * COST_VENTILATION_PCT.lots_techniques),
      amenagements_ext_fcfa: Math.round(coutConstruction * COST_VENTILATION_PCT.amenagements_ext),
      vrd_fcfa: Math.round(vrdCost),
      sous_total_construction_fcfa: estimatedCost,
      honoraires_architecte: {
        bas_fcfa: honorairesResult.bas,
        median_fcfa: honorairesArchi,
        haut_fcfa: honorairesResult.haut,
        taux_bas_pct: tauxHonorairesBas,
        taux_median_pct: tauxHonoraires,
        taux_haut_pct: tauxHonorairesHaut,
      },
      frais_annexes: {
        permis_construire_fcfa: fraisPermis,
        assurance_dommage_ouvrage_fcfa: fraisAssurance,
        etudes_techniques_fcfa: fraisEtudes,
        divers_imprevus_fcfa: fraisDivers,
        total_frais_annexes_fcfa: totalFraisAnnexes,
      },
      malus_orientation_solaire_fcfa: malusSolaire,
      cout_global_projet_fcfa: coutGlobalProjet,
    };
    results[label].cout_global_projet_fcfa = coutGlobalProjet;
    results[label].honoraires_architecte_fcfa = honorairesArchi;
    results[label].malus_orientation_solaire_fcfa = malusSolaire;
    // v57.7: durée estimée du chantier
    const dureeBase = DUREE_CHANTIER_MOIS_PAR_NIVEAU;
    const dureeTotale = dureeBase.fondations_terrassement
      + levels * dureeBase.par_niveau
      + dureeBase.finitions
      + dureeBase.vrd_ext;
    results[label].duree_chantier_mois = Math.round(dureeTotale);
    // Update the results object with financial metrics
    results[label].revenu_mensuel_brut = revenuMensuelBrut;
    results[label].revenu_annuel_brut = revenuAnnuelBrut;
    results[label].revenu_annuel_net = revenuAnnuelNet;
    results[label].revenu_detail = revenuDetail;
    results[label].vacancy_rate_pct = Math.round(vacancyRate * 100);
    results[label].rendement_brut_pct = rendementBrutPct;
    results[label].roi_annees = roiAnnees;
    results[label].ratio_invest_revenu = revenuAnnuelNet > 0 ? Math.round(estimatedCost / revenuAnnuelNet * 10) / 10 : 0;
    results[label].cout_fourchette = { bas: costBas, median: estimatedCost, haut: costHaut };
    results[label].complexite = { score: complexityScore, label: complexityLabel };
    results[label].risque = riskLevel;
  }
  const r = results;
  // Helper : recalcule SDP duale pour un scénario
  const recalcSdp = (s) => {
    s.sdp_m2 = (s.fp_rdc_m2 && s.fp_etages_m2 && s.levels > 1)
      ? s.fp_rdc_m2 + s.fp_etages_m2 * (s.levels - 1)
      : s.fp_m2 * s.levels;
    s.height_m = Math.round(s.levels * floor_height * 10) / 10;
  };
  // ── v57.6 HELPERS FOR DIAGNOSTICS ──
  // Generate scenario description (1-2 sentences in French)
  function generateScenarioDescription(label, role, sc_data) {
    const sdp = Math.round(sc_data.sdp);
    const ces = sc_data.ces_fill_pct;
    const niv = sc_data.levels;
    const libre = Math.round(sc_data.free_ground_m2);
    if (label === "A") {
      return `Intensification : exploitation maximale du potentiel constructible du terrain. Emprise au sol de ${ces}%, developpant ${sdp}m² de SDP sur ${niv} niveaux. Cette option maximise la surface construite et le nombre d'unites, au prix d'un sol libre reduit (${libre}m²).`;
    } else if (label === "B") {
      return `Equilibre : compromis entre densite et qualite de vie. Emprise moderee a ${ces}% du terrain, produisant ${sdp}m² de SDP sur ${niv} niveaux avec ${libre}m² d'espace libre. Ce scenario offre un bon ratio entre rendement et habitabilite.`;
    } else if (label === "C") {
      return `Prudent : implantation mesuree, phasable et evolutive. Emprise contenue a ${ces}% du terrain, preservant ${libre}m² d'espaces exterieurs. Les ${sdp}m² de SDP sur ${niv} niveaux permettent une construction progressive et un investissement maitrise.`;
    }
    return "Scenario de projet immobilier.";
  }
  // Extract comparison data for a scenario
  function extractComparatif(sc) {
    return {
      emprise_rdc_m2: sc.fp_rdc_m2 || sc.fp_m2,
      emprise_etages_m2: sc.fp_etages_m2 || sc.fp_m2,
      niveaux: sc.levels,
      hauteur_m: sc.height_m,
      sdp_m2: sc.sdp_m2,
      surface_habitable_m2: sc.surface_habitable_m2 || 0,
      ratio_efficacite_pct: sc.ratio_efficacite_pct || 0,
      unites: sc.total_units,
      m2_par_logement: sc.m2_habitable_par_logement || 0,
      cout_total_fcfa: sc.cost_total_fcfa || sc.estimated_cost,
      cout_par_unite: sc.cost_per_unit || 0,
      cout_par_m2_sdp: sc.cost_per_m2_sdp || 0,
      cout_par_m2_habitable: sc.cost_per_m2_habitable || 0,
      ces_utilise_pct: sc.ces_fill_pct,
      cos_utilise_pct: sc.cos_ratio_pct,
      conformite: sc.cos_compliance,
      budget_fit: sc.budget_fit,
      parking: sc.parking_spots_estimate,
      parking_detail: sc.parking_detail || {},
      sol_libre_m2: sc.free_ground_m2,
      sol_libre_pct: sc.free_ground_m2 > 0 ? Math.round(sc.free_ground_m2 / site_area * 100) : 0,
      espace_degage: sc.espace_degage || {},
      mitoyennete_detail: sc.mitoyennete_detail || {},
      // v57.6 : coût fourchette + complexité + risque (diagnostic scope)
      cout_fourchette: sc.cout_fourchette || {},
      complexite: sc.complexite ? sc.complexite.label : "N/A",
      risque: sc.risque || "N/A",
      // v57.7 : ventilation coûts + durée + scoring décomposé + retraits
      cout_ventilation: sc.cout_ventilation || {},
      duree_chantier_mois: sc.duree_chantier_mois || 0,
      score_recommandation: sc.recommendation_score || 0,
      score_detail: sc.score_detail || {},
      retraits: sc.regulatory ? {
        avant_m: sc.regulatory.retrait_avant_m,
        lateral_m: sc.regulatory.retrait_lateral_m,
        arriere_m: sc.regulatory.retrait_arriere_m,
        mitoyennete: sc.regulatory.mitoyennete_cotes,
        emprise_constructible_m2: sc.regulatory.emprise_constructible_m2,
        reduction_pct: sc.regulatory.reduction_retraits_pct,
      } : {},
    };
  }
  // v57.8: Phasage intelligent — durées, jalons datés (M0..Mn), répartition budgétaire, calendrier structuré
  function generatePhasingStrategy(recommended, r_results, ctx) {
    const recSc = r_results[recommended];
    const totalCost = recSc.cost_total_fcfa || recSc.estimated_cost;
    const globalCost = recSc.cout_global_projet_fcfa || totalCost;
    const honoraires = recSc.honoraires_architecte_fcfa || 0;
    const dureeBase = DUREE_CHANTIER_MOIS_PAR_NIVEAU;
    // Calendrier structuré (données machine pour 8F)
    const calendrier = [];
    let moisCourant = 0;
    // Projet compact (1-2 niveaux) : monophasé avec calendrier détaillé
    if (recSc.levels <= 2) {
      const dureeFond = dureeBase.fondations_terrassement;
      const dureeGO = Math.round(recSc.levels * dureeBase.par_niveau);
      const dureeFin = dureeBase.finitions;
      const dureeVRD = dureeBase.vrd_ext;
      const dureeTotal = dureeFond + dureeGO + dureeFin + dureeVRD;
      const parts = [];
      // Jalons datés
      calendrier.push({ jalon: "Demarrage chantier", mois: `M0`, cout_cumule_pct: 0 });
      parts.push(`CONSTRUCTION MONOPHASEE — Duree estimee : ${Math.round(dureeTotal)} mois (M0 a M${Math.round(dureeTotal)}).`);
      moisCourant = dureeFond;
      calendrier.push({ jalon: "Fin fondations", mois: `M${moisCourant}`, cout_cumule_pct: 15 });
      parts.push(`M0-M${moisCourant} — Terrassement + fondations : ${dureeFond} mois | ${Math.round(totalCost * 0.15 / 1e6)}M FCFA (15% du budget construction).`);
      const finGO = moisCourant + dureeGO;
      calendrier.push({ jalon: "Fin gros oeuvre (hors d'eau/hors d'air)", mois: `M${Math.round(finGO)}`, cout_cumule_pct: 55 });
      parts.push(`M${moisCourant}-M${Math.round(finGO)} — Gros oeuvre + etancheite : ${dureeGO} mois | ${Math.round(totalCost * 0.40 / 1e6)}M FCFA (40%). Batiment hors d'eau hors d'air.`);
      moisCourant = Math.round(finGO);
      const finFin = moisCourant + dureeFin;
      calendrier.push({ jalon: "Fin second oeuvre + lots techniques", mois: `M${Math.round(finFin)}`, cout_cumule_pct: 90 });
      parts.push(`M${moisCourant}-M${Math.round(finFin)} — Second oeuvre + lots techniques : ${dureeFin} mois | ${Math.round(totalCost * 0.35 / 1e6)}M FCFA (35%).`);
      moisCourant = Math.round(finFin);
      const finVRD = moisCourant + dureeVRD;
      calendrier.push({ jalon: "Reception + livraison", mois: `M${Math.round(finVRD)}`, cout_cumule_pct: 100 });
      parts.push(`M${moisCourant}-M${Math.round(finVRD)} — VRD + amenagements exterieurs + reception : ${dureeVRD} mois | ${Math.round(totalCost * 0.10 / 1e6)}M FCFA (10%).`);
      parts.push(`\nBUDGET GLOBAL — Construction : ${Math.round(totalCost / 1e6)}M FCFA + Honoraires architecte : ${Math.round(honoraires / 1e6)}M FCFA = ${Math.round(globalCost / 1e6)}M FCFA TTC. Le projet compact simplifie la gestion du chantier.`);
      return {
        text: parts.join("\n"),
        calendrier,
        phases: [{ nom: "Construction complete", duree_mois: Math.round(dureeTotal), cout_construction_fcfa: totalCost, pct_budget: 100 }],
        duree_totale_mois: Math.round(dureeTotal),
        cout_global_projet_fcfa: globalCost,
      };
    }
    // Projet multi-niveaux : phasé en 2-3 tranches
    const phase1Floors = Math.min(2, recSc.levels - 1);
    const phase1Levels = 1 + phase1Floors;
    const phase1CostRatio = phase1Levels / recSc.levels;
    const phase1Cost = Math.round(totalCost * phase1CostRatio);
    const phase1Sdp = Math.round(recSc.fp_rdc_m2 + recSc.fp_etages_m2 * phase1Floors);
    const phase1DureeFond = dureeBase.fondations_terrassement;
    const phase1DureeGO = Math.round(phase1Levels * dureeBase.par_niveau);
    const phase1DureeFin = dureeBase.finitions;
    const phase1Duree = phase1DureeFond + phase1DureeGO + phase1DureeFin;
    const remainingFloors = recSc.levels - phase1Levels;
    const parts = [];
    const phasesData = [];
    const dureeTotalEstimee = recSc.duree_chantier_mois || Math.round(phase1Duree + remainingFloors * dureeBase.par_niveau + dureeBase.finitions + dureeBase.vrd_ext);
    parts.push(`CONSTRUCTION PHASEE — ${remainingFloors > 2 ? 3 : 2} tranches, duree totale estimee : ${dureeTotalEstimee} mois (M0 a M${dureeTotalEstimee}).`);
    // Phase 1 avec jalons datés
    calendrier.push({ jalon: "Demarrage Phase 1", mois: "M0", cout_cumule_pct: 0 });
    parts.push(`\nPHASE 1 — RDC + ${phase1Floors} etage(s) | ${phase1Sdp}m² SDP | ${Math.round(phase1Duree)} mois | ${Math.round(phase1Cost / 1e6)}M FCFA (${Math.round(phase1CostRatio * 100)}% du budget).`);
    moisCourant = phase1DureeFond;
    calendrier.push({ jalon: "Fin fondations (dim. pour " + recSc.levels + " niv.)", mois: `M${moisCourant}`, cout_cumule_pct: Math.round(phase1CostRatio * 15) });
    parts.push(`  M0-M${moisCourant} — Fondations dimensionnees pour ${recSc.levels} niveaux (structure renforcee des le depart).`);
    const finGO1 = moisCourant + phase1DureeGO;
    calendrier.push({ jalon: "Phase 1 hors d'eau", mois: `M${Math.round(finGO1)}`, cout_cumule_pct: Math.round(phase1CostRatio * 55) });
    parts.push(`  M${moisCourant}-M${Math.round(finGO1)} — Gros oeuvre RDC a R+${phase1Floors}.`);
    moisCourant = Math.round(finGO1);
    const finFin1 = moisCourant + phase1DureeFin;
    calendrier.push({ jalon: "Livraison Phase 1", mois: `M${Math.round(finFin1)}`, cout_cumule_pct: Math.round(phase1CostRatio * 100) });
    parts.push(`  M${moisCourant}-M${Math.round(finFin1)} — Finitions + mise en service. Tranche autonome et fonctionnelle.`);
    moisCourant = Math.round(finFin1);
    phasesData.push({ nom: "Phase 1 (RDC+R" + phase1Floors + ")", debut: "M0", fin: `M${moisCourant}`, duree_mois: Math.round(phase1Duree), cout_construction_fcfa: phase1Cost, pct_budget: Math.round(phase1CostRatio * 100), sdp_m2: phase1Sdp });
    // Phase 2
    if (remainingFloors > 0) {
      const phase2Floors = remainingFloors > 2 ? Math.ceil(remainingFloors / 2) : remainingFloors;
      const phase2CostRatio = phase2Floors / recSc.levels;
      const phase2Cost = Math.round(totalCost * phase2CostRatio);
      const phase2DureeGO = Math.round(phase2Floors * dureeBase.par_niveau);
      const phase2DureeFin = remainingFloors <= 2 ? dureeBase.finitions + dureeBase.vrd_ext : Math.round(dureeBase.finitions * 0.5);
      const phase2Duree = phase2DureeGO + phase2DureeFin;
      const phase2Start = moisCourant;
      calendrier.push({ jalon: "Demarrage Phase 2 (surelevation)", mois: `M${moisCourant}`, cout_cumule_pct: Math.round(phase1CostRatio * 100) });
      parts.push(`\nPHASE 2 — Surelevation R+${phase1Floors + 1} a R+${phase1Floors + phase2Floors} | +${Math.round(recSc.fp_etages_m2 * phase2Floors)}m² SDP | M${moisCourant}-M${moisCourant + phase2Duree} (${phase2Duree} mois) | ${Math.round(phase2Cost / 1e6)}M FCFA (${Math.round(phase2CostRatio * 100)}%).`);
      moisCourant += phase2DureeGO;
      calendrier.push({ jalon: "Phase 2 hors d'eau", mois: `M${moisCourant}`, cout_cumule_pct: Math.round((phase1CostRatio + phase2CostRatio * 0.6) * 100) });
      moisCourant += phase2DureeFin;
      calendrier.push({ jalon: remainingFloors <= 2 ? "Livraison finale" : "Livraison Phase 2", mois: `M${moisCourant}`, cout_cumule_pct: Math.round((phase1CostRatio + phase2CostRatio) * 100) });
      parts.push(`  Avantage : l'investissement initial est reduit de ${Math.round((1 - phase1CostRatio) * 100)}%, permettant de financer la phase 2 par les revenus de la phase 1 ou un second financement.`);
      phasesData.push({ nom: `Phase 2 (R+${phase1Floors + 1} a R+${phase1Floors + phase2Floors})`, debut: `M${phase2Start}`, fin: `M${moisCourant}`, duree_mois: phase2Duree, cout_construction_fcfa: phase2Cost, pct_budget: Math.round(phase2CostRatio * 100) });
      // Phase 3
      const phase3Floors = remainingFloors - phase2Floors;
      if (phase3Floors > 0) {
        const phase3CostRatio = phase3Floors / recSc.levels;
        const phase3Cost = Math.round(totalCost * phase3CostRatio);
        const phase3Duree = Math.round(phase3Floors * dureeBase.par_niveau + dureeBase.finitions * 0.5 + dureeBase.vrd_ext);
        const phase3Start = moisCourant;
        calendrier.push({ jalon: "Demarrage Phase 3", mois: `M${moisCourant}`, cout_cumule_pct: Math.round((phase1CostRatio + phase2CostRatio) * 100) });
        parts.push(`\nPHASE 3 — Surelevation R+${phase1Floors + phase2Floors + 1} a R+${recSc.levels - 1} | +${Math.round(recSc.fp_etages_m2 * phase3Floors)}m² SDP | M${moisCourant}-M${moisCourant + phase3Duree} (${phase3Duree} mois) | ${Math.round(phase3Cost / 1e6)}M FCFA (${Math.round(phase3CostRatio * 100)}%).`);
        moisCourant += phase3Duree;
        calendrier.push({ jalon: "Livraison finale", mois: `M${moisCourant}`, cout_cumule_pct: 100 });
        phasesData.push({ nom: `Phase 3 (R+${phase1Floors + phase2Floors + 1} a R+${recSc.levels - 1})`, debut: `M${phase3Start}`, fin: `M${moisCourant}`, duree_mois: phase3Duree, cout_construction_fcfa: phase3Cost, pct_budget: Math.round(phase3CostRatio * 100) });
      }
    }
    parts.push(`\nSTRATEGIE STRUCTURELLE — Fondations et poteaux dimensionnes des la phase 1 pour ${recSc.levels} niveaux. Surcoût de renforcement initial : +8-12% sur les fondations, compense par l'economie sur la mobilisation de chantier.`);
    parts.push(`BUDGET GLOBAL — Construction : ${Math.round(totalCost / 1e6)}M FCFA + Honoraires architecte : ${Math.round(honoraires / 1e6)}M FCFA = ${Math.round(globalCost / 1e6)}M FCFA TTC.`);
    return {
      text: parts.join("\n"),
      calendrier,
      phases: phasesData,
      duree_totale_mois: moisCourant > 0 ? moisCourant : dureeTotalEstimee,
      cout_global_projet_fcfa: globalCost,
    };
  }
  // v57.7: Narratif stratégique contextualisé
  // Identifie la CONTRAINTE DOMINANTE du projet et construit l'argumentaire autour
  function generateRecommendationNarrative(recommended, r_results, ctx) {
    const sc = r_results[recommended];
    const noms = { A: "Intensification", B: "Equilibre", C: "Prudent" };
    const costM = Math.round((sc.cost_total_fcfa || sc.estimated_cost) / 1e6);
    const costBas = sc.cout_fourchette ? Math.round(sc.cout_fourchette.bas / 1e6) : Math.round(costM * 0.85);
    const costHaut = sc.cout_fourchette ? Math.round(sc.cout_fourchette.haut / 1e6) : Math.round(costM * 1.2);
    const habM2 = sc.surface_habitable_m2 || sc.total_useful_m2 || 0;
    const m2Logt = sc.m2_habitable_par_logement || 0;
    const coutLogt = sc.cost_per_unit ? Math.round(sc.cost_per_unit / 1e6) : 0;
    const reg = sc.regulatory || {};
    const scoreDet = sc.score_detail || {};
    const parts = [];
    // ══════════════════════════════════════════════════════════════════
    // v57.7: IDENTIFICATION CONTRAINTE DOMINANTE
    // ══════════════════════════════════════════════════════════════════
    // On identifie le facteur limitant principal parmi : budget, terrain, réglementation, programme
    let contrainteDominante = "equilibre"; // default
    let contrainteExplication = "";
    const budgetMaxCtx = ctx.budgetMax || 0;
    const solLibrePct = sc.free_ground_m2 > 0 ? sc.free_ground_m2 / ctx.site_area : 1;
    if (sc.budget_fit === "HORS_BUDGET" && budgetMaxCtx > 0) {
      contrainteDominante = "budget";
      contrainteExplication = `le budget disponible (${Math.round(budgetMaxCtx / 1e6)}M FCFA) est le facteur limitant principal de ce projet`;
    } else if (sc.cos_ratio_pct > 85) {
      contrainteDominante = "reglementation";
      contrainteExplication = `la densite reglementaire (COS a ${sc.cos_ratio_pct}%) est le facteur structurant — le terrain est exploite pres de sa capacite maximale`;
    } else if (solLibrePct < 0.25 || setbackReductionPct > 20) {
      contrainteDominante = "terrain";
      contrainteExplication = `la geometrie du terrain et les retraits reglementaires (${setbackReductionPct}% de reduction d'emprise) sont les contraintes majeures de l'implantation`;
    } else if (ctx.target_units > 0 && sc.total_units < ctx.target_units * 0.80) {
      contrainteDominante = "programme";
      contrainteExplication = `le terrain ne permet pas d'atteindre les ${ctx.target_units} unites souhaitees dans les regles — ${sc.total_units} unites sont realisables`;
    } else {
      contrainteExplication = `le projet s'inscrit dans un equilibre favorable entre terrain, budget et reglementation`;
    }
    // ── 1. VERDICT CONTEXTUALISE ──
    let verdictRaison = "";
    if (/AMBITIEUX|OFFENSIVE/i.test(ctx.feasibility_posture) && recommended === "A") {
      verdictRaison = `Il exploite pleinement le potentiel constructible du terrain. Votre posture ambitieuse et votre capacite financiere permettent de viser le scenario le plus dense.`;
    } else if (/PRUDENT|CONSERVATIVE/i.test(ctx.feasibility_posture) && recommended === "C") {
      verdictRaison = `Il respecte votre approche prudente : implantation maitrisee, investissement contenu, et possibilite d'evolution future par surelevation.`;
    } else if (recommended === "B") {
      verdictRaison = `Il offre le meilleur compromis entre surface construite, cout de realisation et conformite reglementaire.`;
    } else if (contrainteDominante === "budget") {
      verdictRaison = `Face a la contrainte budgetaire identifiee, il optimise la surface construite dans les limites de votre enveloppe financiere.`;
    } else if (contrainteDominante === "terrain") {
      verdictRaison = `Sur ce terrain ou les retraits reglementaires reduisent l'emprise de ${setbackReductionPct}%, il tire le meilleur parti de la surface constructible reelle.`;
    } else {
      verdictRaison = `Il offre la meilleure adequation entre votre programme, votre budget et les contraintes du terrain.`;
    }
    parts.push(`◆ VERDICT — Le scenario ${noms[recommended]} est recommande pour votre projet (score ${sc.recommendation_score}/1). ${verdictRaison}`);
    // ── 1b. CONTEXTE DU SITE avec orientation solaire + mitoyenneté ──
    const contexte = [];
    contexte.push(`Sur votre terrain de ${ctx.site_area}m² en zone ${zoning_type} (${climaticZone.toLowerCase()})`);
    if (setbackReductionPct > 5) {
      contexte.push(`les retraits reglementaires (avant ${rAvant}m, lateral ${rLateral}m, arriere ${rArriere}m) reduisent l'emprise constructible de ${setbackReductionPct}%`);
    }
    // v57.10: mitoyenneté justifiée dans la lecture du site
    const mitoDet = sc.mitoyennete_detail || {};
    if (mitoDet.justification) {
      contexte.push(mitoDet.justification);
    }
    // v57.13: orientation solaire = recommandation (pas contrainte dure)
    contexte.push(solarImpact.recommandation_orientation);
    if (solaireSouple) {
      contexte.push(`profondeur de batiment (${Math.round(dConstructible)}m) superieure au seuil de ventilation traversante (${profondeurSolaire}m) — prevoir des dispositifs de ventilation intermediaires (patios, gaines, double orientation)`);
    }
    if (solarImpact.malus_orientation_pct > 0) {
      contexte.push(`surcoût climatisation estime a +${solarImpact.malus_orientation_pct}% en raison de l'orientation et de la profondeur`);
    }
    contexte.push(`${contrainteExplication}`);
    parts.push(`◆ LECTURE DU SITE — ${contexte.join(". ")}.`);
    // ── 2. CE QUE VOUS CONSTRUISEZ ──
    const implantation = [];
    implantation.push(`un batiment de ${sc.levels} niveaux (${sc.height_m}m)`);
    implantation.push(`emprise au sol de ${sc.fp_rdc_m2}m² (${sc.ces_fill_pct}% du terrain)`);
    if (sc.fp_etages_m2 > sc.fp_rdc_m2) {
      implantation.push(`etages elargis a ${sc.fp_etages_m2}m² (extension${nbMitoyens > 0 ? " en appui sur les mitoyennetes" : " vers les limites separatives"})`);
    }
    implantation.push(`${sc.sdp_m2}m² de surface de plancher dont ${habM2}m² habitables (efficacite ${sc.ratio_efficacite_pct || 0}%)`);
    if (sc.total_units > 1) {
      implantation.push(`${sc.total_units} logements — ${sc.unit_mix_detail || "mix standard"}`);
      if (m2Logt > 0) implantation.push(`${m2Logt}m² habitables par logement`);
    }
    parts.push(`◆ CE QUE VOUS CONSTRUISEZ — ${implantation.join(" ; ")}.`);
    // ── 2b. STATIONNEMENT ET ESPACES EXTÉRIEURS (v57.10) ──
    const pkDet = sc.parking_detail || {};
    const espDet = sc.espace_degage || {};
    const extParts = [];
    // Parking
    const parkingLine = [];
    parkingLine.push(`${pkDet.places_disponibles || sc.parking_spots_estimate} places de stationnement ${pkDet.source === "PILOTIS" ? "en rez-de-chaussee (sous pilotis)" : "en surface"}`);
    parkingLine.push(`ratio de ${pkDet.ratio_par_unite || 1} place(s) par unite (${pkDet.places_requises || 0} requises reglementairement)`);
    if (pkDet.suffisant) {
      parkingLine.push(`stationnement conforme — ${pkDet.places_disponibles - pkDet.places_requises} place(s) excedentaire(s) pour visiteurs`);
    } else if (pkDet.deficit > 0) {
      parkingLine.push(`deficit de ${pkDet.deficit} place(s) — envisager un parking en sous-sol partiel ou des places en voirie`);
    }
    parkingLine.push(`emprise parking : ${pkDet.m2_parking || 0}m² (${PILOTIS_CONFIG.PARKING_SPOT_M2}m² par place, circulation comprise)`);
    extParts.push(`Stationnement : ${parkingLine.join(". ")}`);
    // Espace dégagé (v57.13: ratio parking/espace basé sur requis)
    const espaceLine = [];
    espaceLine.push(`${espDet.sol_libre_total_m2 || sc.free_ground_m2}m² libres au sol (${espDet.sol_libre_pct || Math.round(solLibrePct * 100)}% du terrain)`);
    if (pkDet.source !== "PILOTIS") {
      espaceLine.push(`repartition : ${espDet.ratio_parking_espace || "33/67"} (parking/espaces verts) — ${pkDet.m2_parking || 0}m² de parking, ${espDet.espace_vert_m2 || 0}m² d'espace degage (${espDet.espace_vert_pct || 0}% du terrain)`);
    } else {
      espaceLine.push(`integralement disponible pour amenagement exterieur (parking sous pilotis)`);
    }
    espaceLine.push(`Qualite : ${espDet.qualite || "N/A"} — ${espDet.description || ""}`);
    extParts.push(`Espaces exterieurs : ${espaceLine.join(". ")}`);
    parts.push(`◆ STATIONNEMENT ET ESPACES EXTERIEURS — ${extParts.join(". ")}.`);
    // ── 3. COUT GLOBAL DU PROJET (construction + honoraires fourchette + frais + solaire) ──
    const cout = [];
    const vent = sc.cout_ventilation || {};
    const globalM = vent.cout_global_projet_fcfa ? Math.round(vent.cout_global_projet_fcfa / 1e6) : costM;
    const honoObj = vent.honoraires_architecte || {};
    const honoBasM = Math.round((honoObj.bas_fcfa || 0) / 1e6);
    const honoHautM = Math.round((honoObj.haut_fcfa || 0) / 1e6);
    const honoMedianM = Math.round((honoObj.median_fcfa || 0) / 1e6);
    const fraisAnnM = vent.frais_annexes ? Math.round(vent.frais_annexes.total_frais_annexes_fcfa / 1e6) : 0;
    const malusSolaireM = vent.malus_orientation_solaire_fcfa ? Math.round(vent.malus_orientation_solaire_fcfa / 1e6) : 0;
    cout.push(`Cout global du projet estime : ${globalM}M FCFA`);
    let honoText = `honoraires architecte ${honoMedianM}M (fourchette ${honoBasM}M a ${honoHautM}M, soit ${honoObj.taux_bas_pct || 0}% a ${honoObj.taux_haut_pct || 0}% — bareme degressif)`;
    cout.push(`dont construction ${costM}M (fourchette ${costBas}M a ${costHaut}M), ${honoText}, frais annexes ${fraisAnnM}M (permis, assurance DO, BET, imprevus)`);
    if (malusSolaireM > 0) {
      cout.push(`Surcoût orientation solaire : +${malusSolaireM}M FCFA (protection facades Ouest, climatisation renforcee)`);
    }
    if (vent.gros_oeuvre_fcfa) {
      cout.push(`Ventilation construction : gros oeuvre ${Math.round(vent.gros_oeuvre_fcfa / 1e6)}M (55%), second oeuvre ${Math.round(vent.second_oeuvre_fcfa / 1e6)}M (25%), lots techniques ${Math.round(vent.lots_techniques_fcfa / 1e6)}M (15%), VRD ${Math.round(vent.vrd_fcfa / 1e6)}M`);
    }
    cout.push(`${Math.round((sc.cost_per_m2_sdp || 0) / 1000)}k FCFA/m² SDP`);
    if (coutLogt > 0 && sc.total_units > 1) cout.push(`${coutLogt}M FCFA par logement (construction seule)`);
    if (sc.budget_fit === "DANS_BUDGET") {
      cout.push(`Ce montant s'inscrit dans votre enveloppe budgetaire`);
    } else if (sc.budget_fit === "BUDGET_TENDU") {
      cout.push(`Montant proche de votre limite — optimisable par ajustement des finitions`);
    } else if (sc.budget_fit === "HORS_BUDGET" && budgetMaxCtx > 0) {
      const dep = Math.round(((sc.cost_total_fcfa || sc.estimated_cost) - budgetMaxCtx) / 1e6);
      cout.push(`Depassement de ${dep}M FCFA sur la construction. Cout global tout compris : ${globalM}M FCFA`);
    }
    cout.push(`Duree estimee du chantier : ${sc.duree_chantier_mois || "N/A"} mois`);
    parts.push(`◆ BUDGET GLOBAL DU PROJET — ${cout.join(". ")}.`);
    // ── 4. ALTERNATIVES avec deltas chiffrés ──
    const others = ["A","B","C"].filter(l => l !== recommended);
    const comparaison = [];
    for (const o of others) {
      const osc = r_results[o];
      const oCostM = Math.round((osc.cost_total_fcfa || osc.estimated_cost) / 1e6);
      const deltaSdp = osc.sdp_m2 - sc.sdp_m2;
      const deltaUnits = osc.total_units - sc.total_units;
      const deltaCost = oCostM - costM;
      const deltaSdpPct = sc.sdp_m2 > 0 ? Math.round(Math.abs(deltaSdp) / sc.sdp_m2 * 100) : 0;
      const deltaCostPct = costM > 0 ? Math.round(Math.abs(deltaCost) / costM * 100) : 0;
      if (deltaSdp > 0) {
        comparaison.push(`${noms[o]} (${o}) : +${deltaSdp}m² SDP (+${deltaSdpPct}%), +${Math.max(0, deltaUnits)} logement(s), +${deltaCost}M FCFA (+${deltaCostPct}%)`);
      } else {
        comparaison.push(`${noms[o]} (${o}) : ${deltaSdp}m² SDP (-${deltaSdpPct}%), ${deltaUnits} logement(s), -${Math.abs(deltaCost)}M FCFA (-${deltaCostPct}%)`);
      }
    }
    parts.push(`◆ ALTERNATIVES — ${comparaison.join(" | ")}.`);
    // ── 5. DECOMPOSITION DU SCORE avec explications actionnables ──
    if (scoreDet && scoreDet.budget_fit) {
      const criteres = [];
      const labels = {
        budget_fit: "Budget", risk_alignment: "Risque", cos_conformity: "Conformite COS",
        capacity_adequacy: "Capacite", cost_efficiency: "Efficacite cout", standing_match: "Standing", phase_flexibility: "Phasabilite"
      };
      let bestCrit = "", bestVal = 0, bestExpl = "";
      let worstCrit = "", worstVal = 1, worstExpl = "";
      for (const [k, v] of Object.entries(scoreDet)) {
        if (k === "total" || !v.score) continue;
        criteres.push(`${labels[k] || k}: ${Math.round(v.score * 10)}/10 (poids ${Math.round(v.poids * 100)}%)`);
        if (v.contribution > bestVal) { bestVal = v.contribution; bestCrit = labels[k] || k; bestExpl = v.explication || ""; }
        if (v.score < worstVal) { worstVal = v.score; worstCrit = labels[k] || k; worstExpl = v.explication || ""; }
      }
      const scoreParts = [];
      scoreParts.push(`Score global ${sc.recommendation_score}/1`);
      scoreParts.push(`Point fort : ${bestCrit} (${Math.round(bestVal * 1000) / 1000}). ${bestExpl}`);
      scoreParts.push(`Point d'attention : ${worstCrit} (${Math.round(worstVal * 10)}/10). ${worstExpl}`);
      scoreParts.push(`Detail : ${criteres.join(" | ")}`);
      parts.push(`◆ POURQUOI CE SCENARIO — ${scoreParts.join(". ")}.`);
    }
    // ── 6. ANALYSE DE RISQUE ──
    const risques = [];
    if (sc.budget_fit === "HORS_BUDGET") risques.push("Risque budgetaire : depassement de l'enveloppe — phasage ou optimisation recommande");
    if (sc.cos_ratio_pct > 90) risques.push(`Densite elevee : COS a ${sc.cos_ratio_pct}% — marges d'evolution limitees`);
    if (solLibrePct < 0.25) risques.push(`Emprise importante : seulement ${Math.round(solLibrePct * 100)}% du terrain libre — contrainte pour parking et acces`);
    if ((sc.complexite || {}).score >= 4) risques.push(`Complexite technique ${(sc.complexite || {}).label} : maitrise d'oeuvre experimentee requise`);
    if (sc.total_units > ctx.target_units * 1.3) risques.push(`Surdimensionnement (+${Math.round((sc.total_units / ctx.target_units - 1) * 100)}% vs besoin) : investissement supplementaire sans garantie de demande`);
    if (setbackReductionPct > 25) risques.push(`Terrain contraint : retraits reglementaires reduisent l'emprise de ${setbackReductionPct}%`);
    if (risques.length === 0) risques.push("Risque maitrise : projet conforme, budget coherent, complexite raisonnable");
    parts.push(`◆ ANALYSE DE RISQUE — ${risques.join(". ")}.`);
    // ── 7. RÉGLEMENTAIRE + RETRAITS ──
    const regParts = [];
    regParts.push(`CES utilise ${reg.ces_utilise_pct || sc.ces_fill_pct}% sur ${reg.ces_reglementaire_pct || ""}% autorises (marge ${reg.ces_marge_pct || ""}%)`);
    regParts.push(`COS a ${reg.cos_utilise_pct || sc.cos_ratio_pct}% de la capacite reglementaire`);
    regParts.push(`Hauteur ${sc.height_m}m sur ${reg.hauteur_max_m || ""}m autorises`);
    if (reg.retrait_avant_m) {
      regParts.push(`Retraits : avant ${reg.retrait_avant_m}m, lateral ${reg.retrait_lateral_m}m, arriere ${reg.retrait_arriere_m}m${reg.mitoyennete_cotes > 0 ? ` (${reg.mitoyennete_cotes} mitoyennete(s))` : ""}`);
    }
    regParts.push(`Statut : ${(reg.conformite_globale || sc.cos_compliance)}`);
    parts.push(`◆ CONFORMITE REGLEMENTAIRE — ${regParts.join(". ")}.`);
    // ── 9. CONSEIL STRATÉGIQUE PERSONNALISÉ (conclusion) ──
    const conseil = [];
    if (contrainteDominante === "budget" && sc.levels > 2) {
      conseil.push(`Recommandation : demarrez par la phase 1 (RDC + ${Math.min(2, sc.levels - 1)} niveaux) pour valider le projet dans votre budget actuel, puis reevaluez la surelevation dans 12-18 mois`);
    } else if (contrainteDominante === "budget") {
      conseil.push(`Recommandation : optimisez les finitions pour rester dans l'enveloppe. Un standing ECONOMIQUE au lieu de ${ctx.standing_level} reduirait le cout de ~25%`);
    } else if (contrainteDominante === "terrain") {
      conseil.push(`Recommandation : sur ce terrain contraint, privilegiez la densite verticale plutot que l'etalement. Chaque niveau supplementaire ajoute de la surface sans consommer d'emprise au sol`);
    } else if (contrainteDominante === "reglementation") {
      conseil.push(`Recommandation : le COS est presque atteint. Toute evolution future (surelevation, extension) necessitera une derogation ou un changement de zonage`);
    } else if (recommended === "A" && sc.total_units > ctx.target_units * 1.2) {
      conseil.push(`Recommandation : vous pouvez construire plus que votre cible initiale. Verifiez que le marche local absorbe ce surplus avant de maximiser`);
    } else {
      conseil.push(`Recommandation : le projet est bien dimensionne pour votre profil. Lancez les etudes de sol (geotechnique) et le permis de construire pour securiser le calendrier`);
    }
    if (solarImpact.brise_soleil && climaticZone === "TROPICAL") {
      conseil.push(`Point d'attention climatique : prevoyez des brise-soleil en facade Ouest et une toiture debordante (${solarImpact.debord_toiture_m}m) pour le confort thermique sans surdimensionner la climatisation`);
    }
    parts.push(`◆ CONSEIL STRATEGIQUE — ${conseil.join(". ")}.`);
    return parts.join("\n\n");
  }
  // ── POST-TRAITEMENT v57.6: garantir la hiérarchie A ≥ B ≥ C en SDP, levels, et units ──
  // Avec CES_FILL 95%>80%>65% + extension étages, la hiérarchie est naturelle.
  // Mais des cas edge (BUREAUX avec mix function différents) peuvent inverser B>A en units
  if (isProgramDriven) {
    // Enforce: A.levels >= B.levels >= C.levels
    if (r.A.levels < r.B.levels) {
      r.A.levels = r.B.levels;
      recalcSdp(r.A);
    }
    if (r.B.levels < r.C.levels) {
      r.C.levels = Math.max(1, r.B.levels - 1);
      if (r.C.levels === r.B.levels) r.C.fp_m2 = Math.round(r.C.fp_m2 * 0.90);
      recalcSdp(r.C);
    }
    // Enforce: A.total_units >= B.total_units >= C.total_units
    // If B > A, cap B to A's level
    if (r.B.total_units > r.A.total_units) {
      r.B.total_units = r.A.total_units;
    }
    // If C > B, cap C to B's level
    if (r.C.total_units > r.B.total_units) {
      r.C.total_units = r.B.total_units;
    }
    // SDP check (original logic preserved)
    if (r.A.sdp_m2 < r.B.sdp_m2) {
      r.A.levels = Math.max(r.A.levels, r.B.levels);
      recalcSdp(r.A);
    }
    if (r.B.sdp_m2 < r.C.sdp_m2) {
      r.C.levels = Math.max(1, r.B.levels - 1 || 1);
      if (r.C.levels === r.B.levels) r.C.fp_m2 = Math.round(r.C.fp_m2 * 0.90);
      recalcSdp(r.C);
    }
  } else {
    // Regulation-driven : ancienne logique de différenciation
    if (r.C.levels <= r.A.levels && absMaxLevels > r.A.levels) {
      r.C.levels = Math.min(r.A.levels + 1, absMaxLevels);
    }
    if (r.B.levels >= r.A.levels && r.A.levels > 1) {
      r.B.levels = Math.max(1, r.A.levels - 1);
    }
    for (const lbl of ["A", "B", "C"]) recalcSdp(r[lbl]);
    for (const lbl of ["A", "B", "C"]) {
      const cr = max_sdp > 0 ? r[lbl].sdp_m2 / max_sdp : 0;
      r[lbl].cos_ratio_pct = Math.round(cr * 100);
      r[lbl].cos_compliance = cr <= 1.05 ? "CONFORME" : cr <= 1.30 ? "DEROGATION_POSSIBLE" : "AMBITIEUX_HORS_COS";
    }
    if (r.B.fp_m2 > 0 && r.C.fp_m2 > 0) {
      const diff = Math.abs(r.B.fp_m2 - r.C.fp_m2) / Math.max(r.B.fp_m2, r.C.fp_m2);
      if (diff < 0.15) {
        r.B.fp_m2 = Math.round(Math.min(r.B.fp_m2 * 1.10, envelope_area * 0.95));
        r.C.fp_m2 = Math.max(50, Math.round(r.C.fp_m2 * 0.85));
        recalcSdp(r.B); recalcSdp(r.C);
      }
    }
  }
  // Recalc COS ratios after post-processing
  for (const lbl of ["A", "B", "C"]) {
    const cr = max_sdp > 0 ? r[lbl].sdp_m2 / max_sdp : 0;
    r[lbl].cos_ratio_pct = Math.round(cr * 100);
    r[lbl].cos_compliance = cr <= 1.05 ? "CONFORME" : cr <= 1.30 ? "DEROGATION_POSSIBLE" : "AMBITIEUX_HORS_COS";
  }
  // ══════════════════════════════════════════════════════════════════════════════
  // MOTEUR DE RECOMMANDATION v57.6 (CLIENT-CENTRIC)
  // ══════════════════════════════════════════════════════════════════════════════
  // Recommendation weights: Budget is #1 (30%), then risk alignment (20%), COS (15%),
  // capacity adequacy (15%), standing (10%), phase (10%)
  const scoreWeights_v57_5 = {
    budget_fit: 0.25,          // Budget compatibility
    risk_alignment: 0.20,      // Posture-scenario alignment
    cos_conformity: 0.12,      // COS compliance
    capacity_adequacy: 0.13,   // Target units adequacy
    cost_efficiency: 0.12,     // Quand budget serré, le moins cher gagne
    standing_match: 0.08,      // Standing compatibility
    phase_flexibility: 0.10,   // Phase compatibility
  };
  for (const label of ["A", "B", "C"]) {
    const sc = r[label];
    let score = 0;
    // 1. BUDGET FIT (0.30): Favor scenarios within budget
    // MAIS : un client AMBITIEUX tolère plus de dépassement qu'un PRUDENT
    let budgetScore = 0;
    if (sc.budget_fit === "DANS_BUDGET") budgetScore = 1.0;
    else if (sc.budget_fit === "BUDGET_TENDU") budgetScore = 0.6;
    else if (sc.budget_fit === "HORS_BUDGET") {
      // AMBITIEUX : le hors-budget est un signal, pas un veto
      if (/AMBITIEUX|OFFENSIVE?|AGGRESSIVE/i.test(feasibility_posture)) budgetScore = 0.35;
      else if (/PRUDENT|CONSERVATIVE|DEFENSIVE?/i.test(feasibility_posture)) budgetScore = 0.0;
      else budgetScore = 0.15;
    }
    else budgetScore = 0.5; // N/A
    score += budgetScore * scoreWeights_v57_5.budget_fit;
    // 2. RISK ALIGNMENT (0.20): Match scenario risk to client posture
    // PRUDENT clients should NOT get risky (high-capacity) scenarios
    // AMBITIEUX clients can take more risk
    let riskAlignScore = 0.5;
    if (/PRUDENT|CONSERVATIVE|DEFENSIVE?/i.test(feasibility_posture)) {
      // PRUDENT : préfère C (conservateur) ou B (équilibre), pénalise A (trop risqué)
      riskAlignScore = label === "C" ? 1.0 : label === "B" ? 0.85 : label === "A" ? 0.2 : 0.5;
    } else if (/AMBITIEUX|OFFENSIVE?|AGGRESSIVE/i.test(feasibility_posture)) {
      // AMBITIEUX : préfère A (maximise), tolère B, pénalise C (trop timide)
      riskAlignScore = label === "A" ? 1.0 : label === "B" ? 0.6 : label === "C" ? 0.15 : 0.5;
    } else {
      // EQUILIBRE/STANDARD : préfère B, acceptable A et C
      riskAlignScore = label === "B" ? 1.0 : label === "A" ? 0.65 : label === "C" ? 0.55 : 0.5;
    }
    score += riskAlignScore * scoreWeights_v57_5.risk_alignment;
    // 3. COS CONFORMITY (0.15): Penalize HORS_COS scenarios
    const cosScore = sc.cos_compliance === "CONFORME" ? 1.0 : sc.cos_compliance === "DEROGATION_POSSIBLE" ? 0.5 : 0.1;
    score += cosScore * scoreWeights_v57_5.cos_conformity;
    // 4. CAPACITY ADEQUACY (0.15): Measure how CLOSE to target, not how BIG
    // Oversizing (50% over target) is as bad as undersizing (30% under target)
    const targetUnits = Math.max(1, target_units || 1);
    const ratio = sc.total_units / targetUnits;
    let capAdequacyScore = 0;
    if (ratio >= 0.85 && ratio <= 1.20) {
      // Ideal: 85-120% of target
      capAdequacyScore = 1.0 - Math.abs(ratio - 1.0) * 0.5;
    } else if (ratio >= 0.70 && ratio < 0.85) {
      // Acceptable undersizing: 70-85%
      capAdequacyScore = 0.7 - (0.85 - ratio) * 2;
    } else if (ratio > 1.20 && ratio <= 1.50) {
      // Acceptable oversizing: 120-150%
      capAdequacyScore = 0.7 - (ratio - 1.20) * 1.5;
    } else {
      // Too far from target
      capAdequacyScore = Math.max(0, 0.3 - Math.abs(ratio - 1.0) * 0.2);
    }
    score += capAdequacyScore * scoreWeights_v57_5.capacity_adequacy;
    // 5. COST EFFICIENCY (0.12): Quand budget contraint, favorise le moins cher
    // C'est le tiebreaker clé : si tout est HORS_BUDGET, C est le moins douloureux
    let costEffScore = 0.5;
    if (budgetPressure > 0.5) {
      // Budget serré : le moins cher gagne
      const costs = { A: r.A.cost_total_fcfa || r.A.estimated_cost, B: r.B.cost_total_fcfa || r.B.estimated_cost, C: r.C.cost_total_fcfa || r.C.estimated_cost };
      const minCost = Math.min(costs.A, costs.B, costs.C);
      const maxCost = Math.max(costs.A, costs.B, costs.C);
      const range = maxCost - minCost || 1;
      costEffScore = 1.0 - (((sc.cost_total_fcfa || sc.estimated_cost) - minCost) / range);
    } else {
      // Budget confortable : l'efficacité coût n'est pas un critère fort
      costEffScore = 0.7; // neutre
    }
    score += costEffScore * scoreWeights_v57_5.cost_efficiency;
    // 6. STANDING MATCH (0.08): Standing compatibility
    // Le standing (PREMIUM/STD/ECO) ne dépend PAS du scénario A/B/C — il s'applique
    // aux 3. Le score reflète si le volume bâti est cohérent avec le standing visé.
    // PREMIUM veut de l'espace (A), ECO veut de l'efficacité (C compact).
    let standScore = 0.7; // base neutre
    if (/PREMIUM|HAUT/i.test(standing_level)) {
      standScore = label === "A" ? 1.0 : label === "B" ? 0.75 : 0.5;
    } else if (/ECO/i.test(standing_level)) {
      standScore = label === "C" ? 1.0 : label === "B" ? 0.75 : 0.5;
    } else {
      // STANDARD : tous les scénarios sont compatibles, léger avantage B
      standScore = label === "B" ? 0.85 : label === "A" ? 0.75 : label === "C" ? 0.75 : 0.7;
    }
    score += standScore * scoreWeights_v57_5.standing_match;
    // 7. PHASE FLEXIBILITY (0.10): Phasability
    // C est le plus phasable (compact, évolutif), A le moins (gros investissement d'un coup)
    let phaseScore = 0.6;
    if (label === "C") phaseScore = 1.0;
    else if (label === "B") phaseScore = 0.7;
    else phaseScore = 0.4;
    // Modulé par le phase_score client (haut = veut du phasage)
    phaseScore = phaseScore * (0.5 + phaseSc * 0.5) + (1 - phaseScore) * (1 - phaseSc) * 0.3;
    score += phaseScore * scoreWeights_v57_5.phase_flexibility;
    sc.recommendation_score = Math.round(score * 1000) / 1000;
    // v57.8: décomposition granulaire du scoring + texte explicatif par critère
    // Chaque critère a un score, un poids, sa contribution, ET un texte conseil actionnable
    function explBudget(s, fit) {
      if (s >= 0.9) return "Le cout s'inscrit dans votre budget — aucune contrainte financiere.";
      if (s >= 0.6) return "Budget tendu mais tenable. Levier : passer au standing inferieur ou reduire de 1 niveau pour gagner ~15%.";
      if (s >= 0.3) return "Depassement budgetaire. Leviers : reduire le programme, baisser le standing, ou phaser la construction pour etaler l'investissement.";
      return "Hors budget. Ce scenario necessite un financement complementaire ou une reduction significative du programme.";
    }
    function explRisk(s, posture) {
      if (s >= 0.9) return "Parfaite adequation entre le niveau de risque du scenario et votre posture " + posture.toLowerCase() + ".";
      if (s >= 0.6) return "Risque acceptable pour votre profil. Le scenario est legerement plus " + (s < 0.7 ? "ambitieux" : "prudent") + " que votre posture ideale.";
      return "Decalage entre votre posture " + posture.toLowerCase() + " et le niveau de risque de ce scenario. Envisagez un scenario plus " + (/PRUDENT/i.test(posture) ? "conservateur" : "ambitieux") + ".";
    }
    function explCos(s) {
      if (s >= 0.9) return "Projet conforme au COS reglementaire — pas de risque de refus de permis.";
      if (s >= 0.5) return "Derogation possible mais a argumenter aupres de la mairie. Prevoyez un delai supplementaire pour l'instruction.";
      return "Depassement significatif du COS — risque de refus de permis. Reduisez le nombre de niveaux.";
    }
    function explCapacity(s, ratio) {
      if (s >= 0.9) return "Le nombre d'unites correspond precisement a votre besoin.";
      if (ratio > 1.2) return "Surdimensionnement de " + Math.round((ratio - 1) * 100) + "% par rapport a votre cible. Vous construisez plus que necessaire — verifiez que la demande locative justifie ce surplus.";
      if (ratio < 0.8) return "Le terrain ne permet que " + Math.round(ratio * 100) + "% de votre cible. Leviers : augmenter le nombre de niveaux, reduire les surfaces unitaires, ou revoir le programme a la baisse.";
      return "Proche de votre cible — bon dimensionnement du programme.";
    }
    function explCostEff(s) {
      if (s >= 0.8) return "Ce scenario offre le meilleur rapport surface/cout parmi les 3 options.";
      if (s >= 0.5) return "Rapport cout/surface intermediaire. Les alternatives offrent un meilleur ratio.";
      return "Le scenario le plus couteux par m² construit. Si le budget est une contrainte, privilegiez une alternative plus compacte.";
    }
    function explStanding(s, standing) {
      if (s >= 0.9) return "Le volume et la qualite du scenario sont en parfaite coherence avec le standing " + standing + " vise.";
      if (s >= 0.6) return "Coherence acceptable entre le volume construit et le standing " + standing + ".";
      return "Decalage : le volume construit n'est pas optimal pour du " + standing + ". Un standing " + (/PREMIUM/i.test(standing) ? "STANDARD" : "superieur") + " serait plus coherent avec ce scenario.";
    }
    function explPhase(s) {
      if (s >= 0.8) return "Scenario facilement phasable — vous pouvez construire par tranches et etaler l'investissement.";
      if (s >= 0.5) return "Phasage possible mais moins flexible. La structure doit etre concue des le depart pour la totalite.";
      return "Scenario peu phasable — l'investissement doit etre mobilise en une seule fois. Si le phasage est important, privilegiez un scenario plus compact.";
    }
    const targetRatio = sc.total_units / Math.max(1, target_units || 1);
    sc.score_detail = {
      budget_fit:        { score: Math.round(budgetScore * 100) / 100, poids: scoreWeights_v57_5.budget_fit, contribution: Math.round(budgetScore * scoreWeights_v57_5.budget_fit * 1000) / 1000, explication: explBudget(budgetScore, sc.budget_fit) },
      risk_alignment:    { score: Math.round(riskAlignScore * 100) / 100, poids: scoreWeights_v57_5.risk_alignment, contribution: Math.round(riskAlignScore * scoreWeights_v57_5.risk_alignment * 1000) / 1000, explication: explRisk(riskAlignScore, feasibility_posture) },
      cos_conformity:    { score: Math.round(cosScore * 100) / 100, poids: scoreWeights_v57_5.cos_conformity, contribution: Math.round(cosScore * scoreWeights_v57_5.cos_conformity * 1000) / 1000, explication: explCos(cosScore) },
      capacity_adequacy: { score: Math.round(capAdequacyScore * 100) / 100, poids: scoreWeights_v57_5.capacity_adequacy, contribution: Math.round(capAdequacyScore * scoreWeights_v57_5.capacity_adequacy * 1000) / 1000, explication: explCapacity(capAdequacyScore, targetRatio) },
      cost_efficiency:   { score: Math.round(costEffScore * 100) / 100, poids: scoreWeights_v57_5.cost_efficiency, contribution: Math.round(costEffScore * scoreWeights_v57_5.cost_efficiency * 1000) / 1000, explication: explCostEff(costEffScore) },
      standing_match:    { score: Math.round(standScore * 100) / 100, poids: scoreWeights_v57_5.standing_match, contribution: Math.round(standScore * scoreWeights_v57_5.standing_match * 1000) / 1000, explication: explStanding(standScore, standing_level) },
      phase_flexibility: { score: Math.round(phaseScore * 100) / 100, poids: scoreWeights_v57_5.phase_flexibility, contribution: Math.round(phaseScore * scoreWeights_v57_5.phase_flexibility * 1000) / 1000, explication: explPhase(phaseScore) },
      total: Math.round(score * 1000) / 1000,
    };
  }
  // Find best scenario
  let recommended = "A";
  if (r.B.recommendation_score > r[recommended].recommendation_score) recommended = "B";
  if (r.C.recommendation_score > r[recommended].recommendation_score) recommended = "C";
  r.A.recommended = recommended === "A";
  r.B.recommended = recommended === "B";
  r.C.recommended = recommended === "C";
  // Generate client-centric recommendation reason
  const recSc = r[recommended];
  const reasons = [];
  if (budgetPressure > 0.6) {
    reasons.push("optimise pour contrainte budgetaire");
  } else if (recSc.budget_fit === "DANS_BUDGET") {
    reasons.push("respecte le budget client");
  }
  if (recSc.cos_compliance === "CONFORME") reasons.push("conforme au COS");
  if (feasibility_posture === "PRUDENT" && recommended === "B") reasons.push("equilibre entre ambitieux et prudent");
  if (feasibility_posture === "PRUDENT" && recommended === "C") reasons.push("approche conservative, risque maitrise");
  if (feasibility_posture === "AMBITIEUX" && recommended === "A") reasons.push("maximise la capacite");
  if (recSc.total_units >= target_units * 0.85 && recSc.total_units <= target_units * 1.20) reasons.push("proche du besoin exprime");
  const recommendation_reason = reasons.length > 0 ? reasons.join(", ") : "meilleur compromis multicritere";
  const meta = {
    engine_version: "57.13",
    mode: isProgramDriven ? "PROGRAM_DRIVEN" : "REGULATION_DRIVEN",
    program_key: programKey || "NONE",
    zoning_type, primary_driver, cos, ces, floor_height,
    max_fp: Math.round(max_fp), max_sdp: Math.round(max_sdp), absMaxLevels,
    envelope_bbox: Math.round(envelope_bbox), envelope_poly_area: Math.round(envelope_area),
    program_main, commerce_levels: commerceLevels, force_commerce: forceCommerce,
    target_units, standing_level,
    budget_pressure: Math.round(budgetPressure * 100) / 100,
    feasibility_posture, posture_mod: postureMod,
    risk_adjusted: riskAdj, risk_penalty: Math.round(riskPenalty * 1000) / 1000,
    driver_intensity, intensity_spread: intensitySpread,
    scores: { rent: rentSc, capacity: capSc, mix: mixSc, phase: phaseSc, risk: riskSc },
    recommended_scenario: recommended,
    recommendation_reason,
  };
  // ── v57.6 DIAGNOSTIC COMPARISON TABLE ──
  const diagnostic = {
    // Client profile echo
    profil_client: {
      posture: feasibility_posture,
      budget_band: budget_band || "N/A",
      budget_max_fcfa: budgetMax,
      standing: standing_level,
      programme: program_main,
      cible_unites: target_units,
      rigidite_financiere: Number(financial_rigidity_score) || 0,
      score_risque: Number(risk_score) || 0,
    },
    // Site summary
    site: {
      surface_m2: Number(site_area),
      zonage: zoning_type,
      ces_reglementaire_pct: Math.round(ces * 100),
      cos_reglementaire: cos,
      hauteur_max_m: Number(max_height_m) || 99,
      niveaux_max: absMaxLevels,
      emprise_max_m2: Math.round(max_fp),
      sdp_max_m2: Math.round(max_sdp),
    },
    // A vs B vs C comparison + deltas
    comparatif: (() => {
      const compA = extractComparatif(r.A);
      const compB = extractComparatif(r.B);
      const compC = extractComparatif(r.C);
      // v57.7: Deltas entre scénarios (Δ B vs A, Δ C vs A, Δ C vs B)
      function computeDeltas(ref, alt, refLabel, altLabel) {
        const dSdp = alt.sdp_m2 - ref.sdp_m2;
        const dCout = alt.cout_total_fcfa - ref.cout_total_fcfa;
        // v57.9: valeur marginale = coût de chaque m² supplémentaire entre les 2 scénarios
        const valeurMarginale = dSdp !== 0 ? Math.round(Math.abs(dCout / dSdp)) : 0;
        const coutM2Ref = ref.sdp_m2 > 0 ? Math.round(ref.cout_total_fcfa / ref.sdp_m2) : 0;
        // Si valeur marginale < coût/m² moyen = bon deal, sinon surcoût
        const marginaleFavorable = valeurMarginale > 0 && valeurMarginale < coutM2Ref * 1.1;
        return {
          label: `${altLabel} vs ${refLabel}`,
          delta_sdp_m2: dSdp,
          delta_sdp_pct: ref.sdp_m2 > 0 ? Math.round(dSdp / ref.sdp_m2 * 100) : 0,
          delta_unites: alt.unites - ref.unites,
          delta_cout_fcfa: dCout,
          delta_cout_pct: ref.cout_total_fcfa > 0 ? Math.round(dCout / ref.cout_total_fcfa * 100) : 0,
          delta_surface_hab_m2: alt.surface_habitable_m2 - ref.surface_habitable_m2,
          delta_sol_libre_m2: alt.sol_libre_m2 - ref.sol_libre_m2,
          // v57.9: valeur marginale
          valeur_marginale_fcfa_par_m2: valeurMarginale,
          marginale_favorable: marginaleFavorable,
          commentaire: dSdp < 0
            ? `${altLabel} coute ${Math.abs(Math.round(dCout / ref.cout_total_fcfa * 100))}% de moins que ${refLabel} pour ${Math.abs(Math.round(dSdp / ref.sdp_m2 * 100))}% de surface en moins`
            : `${altLabel} offre ${Math.round(dSdp / ref.sdp_m2 * 100)}% de surface en plus pour ${Math.round(dCout / ref.cout_total_fcfa * 100)}% de cout supplementaire`,
          conseil_marginale: dSdp > 0 && marginaleFavorable
            ? `Chaque m² supplementaire de ${refLabel} a ${altLabel} coute ${Math.round(valeurMarginale / 1000)}k FCFA — inferieur au cout moyen (${Math.round(coutM2Ref / 1000)}k/m²), l'investissement supplementaire est rentable.`
            : dSdp > 0
            ? `Chaque m² supplementaire coute ${Math.round(valeurMarginale / 1000)}k FCFA — superieur au cout moyen (${Math.round(coutM2Ref / 1000)}k/m²), rendement decroissant.`
            : `L'economie est de ${Math.round(Math.abs(valeurMarginale) / 1000)}k FCFA par m² sacrifie.`,
        };
      }
      return {
        A: compA, B: compB, C: compC,
        deltas: {
          B_vs_A: computeDeltas(compA, compB, "A", "B"),
          C_vs_A: computeDeltas(compA, compC, "A", "C"),
          C_vs_B: computeDeltas(compB, compC, "B", "C"),
        },
      };
    })(),
    // Narrative recommendation
    recommandation: {
      scenario: recommended,
      score: r[recommended].recommendation_score,
      score_detail: r[recommended].score_detail || {},
      narrative: generateRecommendationNarrative(recommended, r, {
        feasibility_posture, budgetPressure, budgetMax, target_units,
        standing_level, site_area, program_main
      }),
    },
    // v57.7 Phasing strategy (object with text + structured data)
    strategie_phasage: generatePhasingStrategy(recommended, r, {
      program_main, target_units, site_area
    }),
    // v57.7 retraits réglementaires
    retraits_reglementaires: {
      avant_m: rAvant,
      lateral_m: rLateral,
      arriere_m: rArriere,
      mitoyennete_cotes: nbMitoyens,
      emprise_constructible_m2: Math.round(empriseConstructible),
      emprise_effective_m2: Math.round(empriseEffective),
      reduction_pct: setbackReductionPct,
    },
    // v57.9: orientation solaire
    orientation_solaire: {
      zone_climatique: climaticZone,
      orientation_score: solarImpact.orientationScore,
      facade_optimale: solarImpact.facade_optimale,
      facade_a_proteger: solarImpact.facade_a_proteger,
      profondeur_recommandee_m: solarImpact.profondeur_recommandee_m,
      ventilation_traversante: solarImpact.ventilation_traversante,
      brise_soleil_ouest: solarImpact.brise_soleil,
      debord_toiture_m: solarImpact.debord_toiture_m,
      malus_orientation_pct: solarImpact.malus_orientation_pct,
      recommandation: solarImpact.recommandation_orientation,
    },
    engine_version: "57.13",
  };
  console.log(`│`);
  console.log(`│ A(${r.A.role}): fp=${r.A.fp_m2}m² × ${r.A.levels}niv = ${r.A.sdp_m2}m² SDP (${r.A.cos_ratio_pct}%COS) ${r.A.cos_compliance} | ${r.A.unit_mix_detail}`);
  console.log(`│ B(${r.B.role}): fp=${r.B.fp_m2}m² × ${r.B.levels}niv = ${r.B.sdp_m2}m² SDP (${r.B.cos_ratio_pct}%COS) ${r.B.cos_compliance} | ${r.B.unit_mix_detail}`);
  console.log(`│ C(${r.C.role}): fp=${r.C.fp_m2}m² × ${r.C.levels}niv = ${r.C.sdp_m2}m² SDP (${r.C.cos_ratio_pct}%COS) ${r.C.cos_compliance} | ${r.C.unit_mix_detail}`);
  console.log(`│ ★ RECOMMANDÉ : ${recommended} — ${recommendation_reason}`);
  console.log(`└── end SCENARIO ENGINE v57.13 ──`);
  return { A: r.A, B: r.B, C: r.C, meta, diagnostic };
}
// ─── ENDPOINT /compute-scenarios ─────────────────────────────────────────────
app.post("/compute-scenarios", (req, res) => {
  const p = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch(e) { return {}; } })() : (req.body || {});
  if (!p.site_area || !p.envelope_w || !p.envelope_d) {
    return res.status(400).json({ error: "site_area, envelope_w, envelope_d obligatoires" });
  }
  // v56: LOG COMPLET des paramètres reçus par 8D pour diagnostic
  console.log(`\n╔══ /compute-scenarios RECEIVED (v56.3) ══╗`);
  console.log(`║ site_area=${p.site_area} envelope_w=${p.envelope_w} envelope_d=${p.envelope_d}`);
  console.log(`║ envelope_area=${p.envelope_area} (${p.envelope_area ? "OVERRIDE REÇU" : "non fourni → w×d"})`);
  console.log(`║ zoning=${p.zoning_type} driver=${p.primary_driver} standing=${p.standing_level}`);
  console.log(`║ max_floors=${p.max_floors} max_height=${p.max_height_m} floor_h=${p.floor_height}`);
  console.log(`║ budget_tension=${p.budget_tension} budget_band=${p.budget_band}`);
  console.log(`║ program=${p.program_main} target_sdp=${p.target_surface_m2} units=${p.target_units}`);
  console.log(`╚════════════════════════════════════════╝\n`);
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
// ─── TYPOLOGIES ARCHITECTURALES (v54) ────────────────────────────────────────
// Sélection automatique de la forme bâtie selon le contexte :
//   BLOC     → rectangle compact (~1:1.3), économique, petit terrain
//   BARRE    → lamelle allongée (~1:3+), éclairage naturel, logement
//   EN_U     → 3 ailes + cour intérieure, programme mixte, standing élevé
//   EN_L     → 2 ailes, terrain d'angle, extension/rénovation
//   EXTENSION→ barre accolée à un côté (parcelle déjà occupée)
// ─── SÉLECTION TYPOLOGIQUE v56.2 ─────────────────────────────────────────────
// Chaque scénario (A/B/C) peut avoir une typologie DIFFÉRENTE.
// Le choix tient compte de :
//   - massing_mode (BALANCED/SPREAD/COMPACT) → oriente vers certaines formes
//   - fillRatio (emprise/enveloppe) → contrainte géométrique
//   - envAspect (largeur/profondeur) → terrain allongé ou carré
//   - streetBearing (orientation rue en degrés) → soleil vs façade
//   - standing, programme, saturation, etc.
//
// RÈGLE CLÉ : les 3 scénarios doivent proposer des typologies différentes quand c'est possible.
function selectTypology({ fp_m2, envelopeArea, envAspect, massing_mode, primary_driver,
  levels, standing_level, program_main, site_saturation, project_type, existing_fp_m2,
  streetBearing = 0, latitude = 14, scenario_role = "EQUILIBRE" }) {
  const fillRatio = fp_m2 / Math.max(1, envelopeArea);
  const isMixte = /mixte|mixed/i.test(program_main || "");
  const isReno = /RENOVATION|EXTENSION|SURELEVATION/i.test(project_type || "");
  const isOccupied = (site_saturation === "HIGH") || (existing_fp_m2 > 0) || isReno;
  const isPremium = /PREMIUM|HAUT/i.test(standing_level || "");
  const isEco = /ECO|ECONOMIQUE/i.test(standing_level || "");
  // ── Analyse bioclimatique par zone ──
  // RÈGLES PAR LATITUDE :
  // Zone équatoriale (0-5°) : soleil vient du N et du S selon saison. E et W chauffent le plus.
  //   → Façades ouvertes : N et S. Façades à protéger : E (matin) et surtout W (après-midi = surchauffe)
  //   → Bâtiment allongé axe E-W = optimal (façades N/S ouvertes, pignons E/W minimaux)
  //
  // Zone tropicale (5-15°) : Cameroun, Sénégal, Côte d'Ivoire, Mali...
  //   → Soleil haut toute l'année, OUEST = surchauffe majeure (soleil rasant 14h-18h)
  //   → Façades ouvertes : SUD (ventilation, lumière douce). Façade à protéger : OUEST
  //   → Bâtiment allongé axe E-W = optimal. Si impossible : protéger façade W (peu d'ouvertures)
  //
  // Zone sahélienne/sub-tropicale (15-25°) : Sénégal nord, Mali, Burkina...
  //   → Comme tropical mais plus sec. Soleil intense. Même règle W = pire.
  //
  // Zone méditerranéenne/tempérée (25°+) : Maghreb, Afrique du Sud
  //   → Logique européenne : façade SUD = apport solaire hivernal souhaité.
  //   → Bâtiment allongé E-W aussi optimal.
  //
  // CONCLUSION UNIVERSELLE : L'axe long du bâtiment doit être E-W dans toutes les zones.
  // La façade à PROTÉGER (minimiser) est l'OUEST en zone tropicale/équatoriale.
  const absLat = Math.abs(latitude);
  const climateZone = absLat < 5 ? "EQUATORIAL" : absLat < 15 ? "TROPICAL" : absLat < 25 ? "SAHELIEN" : "TEMPERE";
  // Azimut de la façade à protéger (éviter les ouvertures)
  const protectAzimuth = climateZone === "TEMPERE" ? null : 270; // OUEST sauf tempéré
  // Azimut de la façade préférée (ouvertures, ventilation)
  const preferAzimuth = climateZone === "TEMPERE" ? 180 : (climateZone === "EQUATORIAL" ? 0 : 180); // SUD (ou N en équatorial)
  // L'AXE LONG optimal du bâtiment : toujours ~E-W (90° ou 270°)
  const optimalLongAxis = 90; // azimut de l'axe long idéal
  const streetAngle = ((streetBearing % 360) + 360) % 360;
  // Écart entre l'axe de la rue et l'axe E-W optimal
  const axisDeviation = Math.min(
    Math.abs(streetAngle - optimalLongAxis),
    Math.abs(streetAngle - (optimalLongAxis + 180)),
    Math.abs(streetAngle - optimalLongAxis + 360),
    Math.abs(streetAngle - (optimalLongAxis + 180) + 360)
  ) % 180;
  // Si la rue est ~E-W : BARRE le long = optimal (axisDeviation petit)
  // Si la rue est ~N-S : BARRE le long = mauvais (axisDeviation grand)
  const barreSolarScore = Math.max(0, 1.0 - axisDeviation / 90); // 1.0 si E-W, 0 si N-S
  // Façade OUEST du bâtiment par rapport à la rue
  // Si la rue est au nord : l'ouest du bâtiment est à gauche en regardant la parcelle
  // On veut minimiser la façade ouest = mettre le pignon (côté court) face à l'ouest
  const streetFacesWest = Math.abs(streetAngle - 270) < 45 || Math.abs(streetAngle - 270 + 360) < 45;
  console.log(`│ Climate: zone=${climateZone} lat=${latitude.toFixed(1)}° protect=${protectAzimuth || "none"}° prefer=${preferAzimuth}°`);
  console.log(`│ Street: bearing=${streetAngle.toFixed(0)}° axisDeviation=${axisDeviation.toFixed(0)}° barreSolar=${barreSolarScore.toFixed(2)} facesWest=${streetFacesWest}`);
  console.log(`┌── selectTypology v56.2 ──`);
  console.log(`│ fillRatio=${fillRatio.toFixed(3)} envAspect=${envAspect.toFixed(2)} mode=${massing_mode}`);
  console.log(`│ streetBearing=${streetBearing.toFixed(0)}° axisDeviation=${axisDeviation.toFixed(0)}° barreSolar=${barreSolarScore.toFixed(2)} facesWest=${streetFacesWest}`);
  console.log(`│ driver=${primary_driver} levels=${levels} standing=${standing_level}`);
  console.log(`│ program=${program_main} saturation=${site_saturation} project=${project_type}`);
  let typology;
  let reason;
  // ── Parcelle occupée / extension / rénovation → contrainte forte ──
  if (isOccupied && isReno) {
    typology = "EXTENSION";
    reason = "parcelle occupée + rénovation → extension accolée";
  } else if (isOccupied && fillRatio < 0.5) {
    typology = "EN_L";
    reason = "parcelle occupée + emprise modérée → L pour contourner l'existant";
  } else if (isOccupied) {
    typology = "BLOC";
    reason = "parcelle occupée + forte emprise → bloc compact loin de l'existant";
  }
  // ── Contrainte géométrique dure ──
  else if (fillRatio > 0.80) {
    typology = "BLOC";
    reason = `emprise ${(fillRatio*100).toFixed(0)}% > 80% → bloc compact seul possible`;
  }
  // ── v56.7: RÔLE influence la préférence typologique ──
  // PRUDENT → préfère les formes simples (BLOC) sauf si le terrain impose autre chose
  // INTENSIFICATION → peut proposer des formes complexes (EN_U, BARRE longue)
  // EQUILIBRE → compromis
  else if (scenario_role === "PRUDENT" && fillRatio > 0.35) {
    typology = "BLOC";
    reason = `PRUDENT + emprise ${(fillRatio*100).toFixed(0)}% → bloc simple (risque minimal, coût maîtrisé)`;
  } else if (scenario_role === "INTENSIFICATION" && isMixte && envelopeArea > 500 && fillRatio > 0.35) {
    typology = "EN_U";
    reason = "INTENSIFICATION + mixte + grande parcelle → U (max SDP, cour intérieure, commerce RDC)";
  } else if (scenario_role === "INTENSIFICATION" && envAspect > 1.8 && barreSolarScore > 0.5) {
    typology = "BARRE";
    reason = `INTENSIFICATION + terrain allongé + bonne orientation solaire → barre longue`;
  }
  // ── Sélection par massing_mode (différenciation de forme) ──
  else if (massing_mode === "COMPACT") {
    // COMPACT = rentabilité max, coût optimisé → BLOC ou EN_U
    if (isPremium && isMixte && envelopeArea > 500) {
      typology = "EN_U";
      reason = "COMPACT + premium + mixte → U dense avec cour intérieure";
    } else if (isMixte && fillRatio > 0.4 && envelopeArea > 500) {
      typology = "EN_U";
      reason = "COMPACT + mixte + grande emprise → U maximise la SDP";
    } else {
      typology = "BLOC";
      reason = `COMPACT → bloc compact (coût/m² optimisé)`;
    }
  } else if (massing_mode === "SPREAD") {
    // SPREAD = qualité de vie, lumière, espaces → BARRE ou EN_L
    if (envAspect > 1.5 && barreSolarScore > 0.5) {
      typology = "BARRE";
      reason = `SPREAD + terrain allongé (${envAspect.toFixed(1)}) + bonne orientation solaire → lamelle`;
    } else if (envAspect > 1.8) {
      typology = "BARRE";
      reason = `SPREAD + terrain très allongé → lamelle (même si orientation pas idéale)`;
    } else if (isPremium && envelopeArea > 400) {
      typology = "EN_L";
      reason = "SPREAD + premium → L pour max lumière et dégagement";
    } else if (fillRatio < 0.45) {
      typology = "BARRE";
      reason = "SPREAD + faible emprise → lamelle (double orientation, lumière)";
    } else {
      typology = "EN_L";
      reason = "SPREAD → L (bon compromis lumière/espace)";
    }
  } else {
    // BALANCED = référence optimale
    if (isPremium && isMixte && envelopeArea > 600) {
      typology = "EN_U";
      reason = "BALANCED + premium + mixte → U avec cour (prestige)";
    } else if (envAspect > 2.0 && barreSolarScore > 0.6) {
      typology = "BARRE";
      reason = "BALANCED + terrain allongé + bonne orientation → lamelle optimale";
    } else if (fillRatio > 0.4 && fillRatio < 0.70 && envelopeArea > 400) {
      typology = "EN_L";
      reason = "BALANCED + emprise intermédiaire → L (compromis optimal)";
    } else if (isMixte && fillRatio > 0.35 && envelopeArea > 400) {
      typology = "EN_U";
      reason = "BALANCED + mixte → U avec cour intérieure";
    } else if (levels >= 5 && fillRatio < 0.35) {
      typology = "BLOC";
      reason = `BALANCED + petite emprise + ${levels} niveaux → tour/bloc`;
    } else {
      typology = "BLOC";
      reason = "BALANCED → bloc compact (défaut robuste)";
    }
  }
  console.log(`│ → TYPOLOGY = ${typology} (${reason})`);
  console.log(`└── end selectTypology v56.2 ──`);
  return { typology, reason };
}
// ─── POINT-IN-POLYGON (ray casting) ─────────────────────────────────────────
function ptInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
// ─── COUPE TRANSVERSALE de l'enveloppe (v56) ─────────────────────────────────
// Pour un polygone en repère local (u,v), trouve la largeur disponible
// à une profondeur v donnée, en scannant les arêtes qui croisent ce v.
function envelopeWidthAtV(vTarget, envLocal) {
  let minU = Infinity, maxU = -Infinity;
  const n = envLocal.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const vi = envLocal[i].v, vj = envLocal[j].v;
    if ((vi <= vTarget && vj >= vTarget) || (vj <= vTarget && vi >= vTarget)) {
      if (Math.abs(vj - vi) < 0.001) {
        minU = Math.min(minU, envLocal[i].u, envLocal[j].u);
        maxU = Math.max(maxU, envLocal[i].u, envLocal[j].u);
      } else {
        const t = (vTarget - vi) / (vj - vi);
        const u = envLocal[i].u + t * (envLocal[j].u - envLocal[i].u);
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
      }
    }
  }
  if (minU === Infinity) return { minU: 0, maxU: 0, width: 0 };
  return { minU, maxU, width: maxU - minU };
}
// Idem mais coupe horizontale : profondeur dispo à un u donné
function envelopeDepthAtU(uTarget, envLocal) {
  let minV = Infinity, maxV = -Infinity;
  const n = envLocal.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ui = envLocal[i].u, uj = envLocal[j].u;
    if ((ui <= uTarget && uj >= uTarget) || (uj <= uTarget && ui >= uTarget)) {
      if (Math.abs(uj - ui) < 0.001) {
        minV = Math.min(minV, envLocal[i].v, envLocal[j].v);
        maxV = Math.max(maxV, envLocal[i].v, envLocal[j].v);
      } else {
        const t = (uTarget - ui) / (uj - ui);
        const v = envLocal[i].v + t * (envLocal[j].v - envLocal[i].v);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
  }
  if (minV === Infinity) return { minV: 0, maxV: 0, depth: 0 };
  return { minV, maxV, depth: maxV - minV };
}
// ─── POLYGONE GPS DU BÂTIMENT MASSING v56.2 — ORIENTATION SOLAIRE ────────────
// v56.2 : intègre l'orientation solaire, la position par rapport à la rue,
// le voisinage, et propose une typologie adaptée par scénario.
function computeMassingPolygon(envelopeCoords, fp_m2, envelopeArea, context = {}) {
  const { massing_mode, primary_driver, levels, standing_level, program_main,
    site_saturation, project_type, existing_fp_m2,
    road_bearing: roadBearingInput, scenario_role } = context;
  console.log(`┌── computeMassingPolygon v56.7 (ROAD_BEARING + RÔLE + SOLAR) ──`);
  console.log(`│ fp_m2=${fp_m2}  envelopeArea=${envelopeArea.toFixed(1)}m²  mode=${massing_mode}  role=${scenario_role}`);
  // ── 1. Centroïde et conversion mètres ──
  const eLat = envelopeCoords.reduce((s, p) => s + p.lat, 0) / envelopeCoords.length;
  const eLon = envelopeCoords.reduce((s, p) => s + p.lon, 0) / envelopeCoords.length;
  const envM = envelopeCoords.map(c => toM(c.lat, c.lon, eLat, eLon));
  envelopeCoords.forEach((c, i) => console.log(`│ Env[${i}]: ${c.lat.toFixed(7)}, ${c.lon.toFixed(7)}`));
  // ── 2. Détecter la façade rue ──
  // v56.7: Si road_bearing est fourni par la Sheet, on cherche le bord de l'enveloppe
  // dont l'azimut est le PLUS PROCHE du road_bearing (= parallèle à la route).
  // Sinon, fallback: le bord le PLUS LONG (heuristique ouest-africaine).
  let frontIdx = 0;
  let maxEdgeLen = 0;
  if (roadBearingInput != null && !isNaN(roadBearingInput)) {
    // ── ROAD BEARING CONNU : trouver le bord parallèle à la route ──
    const rb = ((roadBearingInput % 360) + 360) % 360;
    let bestAngleDiff = 999;
    for (let i = 0; i < envelopeCoords.length; i++) {
      const j = (i + 1) % envelopeCoords.length;
      const dx = envM[j].x - envM[i].x, dy = envM[j].y - envM[i].y;
      const edgeLen = Math.sqrt(dx * dx + dy * dy);
      if (edgeLen < 3) continue; // ignorer les micro-bords
      const edgeBearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
      // Différence angulaire (0°-180°, car un bord à 10° et 190° est le même axe)
      let diff = Math.abs(edgeBearing - rb) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff > 90) diff = 180 - diff; // même axe, direction opposée
      // Pondérer légèrement par la longueur (préférer un bord long à angle égal)
      const score = diff - edgeLen * 0.02;
      if (score < bestAngleDiff) { bestAngleDiff = score; frontIdx = i; maxEdgeLen = edgeLen; }
    }
    console.log(`│ Front edge: road_bearing=${rb.toFixed(0)}° → best match [${frontIdx}→${(frontIdx+1)%envM.length}] angleDiff=${bestAngleDiff.toFixed(1)}° len=${maxEdgeLen.toFixed(1)}m`);
  } else {
    // ── FALLBACK : bord le plus long = front de rue ──
    for (let i = 0; i < envelopeCoords.length; i++) {
      const j = (i + 1) % envelopeCoords.length;
      const dx = envM[j].x - envM[i].x, dy = envM[j].y - envM[i].y;
      const edgeLen = Math.sqrt(dx * dx + dy * dy);
      if (edgeLen > maxEdgeLen) { maxEdgeLen = edgeLen; frontIdx = i; }
    }
    console.log(`│ Front edge: no road_bearing → longest edge [${frontIdx}→${(frontIdx+1)%envM.length}] len=${maxEdgeLen.toFixed(1)}m`);
  }
  const fi = frontIdx, fj = (fi + 1) % envM.length;
  const sDx = envM[fj].x - envM[fi].x, sDy = envM[fj].y - envM[fi].y;
  const sLen = Math.sqrt(sDx * sDx + sDy * sDy) || 1;
  const sUx = sDx / sLen, sUy = sDy / sLen;
  let nUx = -sUy, nUy = sUx;
  const midFX = (envM[fi].x + envM[fj].x) / 2, midFY = (envM[fi].y + envM[fj].y) / 2;
  if (nUx * (0 - midFX) + nUy * (0 - midFY) < 0) { nUx = -nUx; nUy = -nUy; }
  // ── Calculer le bearing de la rue (azimut en degrés) ──
  const streetBearing = ((Math.atan2(sDx, sDy) * 180 / Math.PI) + 360) % 360;
  console.log(`│ Front edge: [${fi}→${fj}] len=${sLen.toFixed(1)}m bearing=${streetBearing.toFixed(0)}°`);
  console.log(`│ StreetDir=(${sUx.toFixed(3)},${sUy.toFixed(3)}) IntoSite=(${nUx.toFixed(3)},${nUy.toFixed(3)})`);
  // ── 3. Analyse bioclimatique ──
  const absLat = Math.abs(eLat);
  const climateZone = absLat < 5 ? "EQUATORIAL" : absLat < 15 ? "TROPICAL" : absLat < 25 ? "SAHELIEN" : "TEMPERE";
  // En zone tropicale/équatoriale : OUEST (270°) = surchauffe → minimiser cette façade
  // L'axe long du bâtiment doit être E-W (90°/270°) pour que les façades longues soient N et S
  const optimalLongAxis = 90;
  const streetSunDeviation = Math.min(
    Math.abs(streetBearing - optimalLongAxis),
    Math.abs(streetBearing - optimalLongAxis - 180),
    Math.abs(streetBearing - optimalLongAxis + 180)
  ) % 180;
  const solarFavorBarre = streetSunDeviation < 40; // rue ~E-W → barre le long = bon
  const solarFavorDepth = streetSunDeviation > 50; // rue ~N-S → profondeur = mieux
  console.log(`│ Bioclimatic: zone=${climateZone} lat=${eLat.toFixed(2)}° streetDeviation=${streetSunDeviation.toFixed(0)}°`);
  console.log(`│ Orientation: favorBarre=${solarFavorBarre} favorDepth=${solarFavorDepth}`);
  // ── 4. Projeter l'enveloppe en repère local ──
  const envLocal = envM.map(p => ({
    u: p.x * sUx + p.y * sUy,
    v: p.x * nUx + p.y * nUy,
  }));
  const minU = Math.min(...envLocal.map(p => p.u)), maxU = Math.max(...envLocal.map(p => p.u));
  const minV = Math.min(...envLocal.map(p => p.v)), maxV = Math.max(...envLocal.map(p => p.v));
  const availW = maxU - minU;
  const availD = maxV - minV;
  const envAspect = availW / Math.max(1, availD);
  console.log(`│ Local frame: W=${availW.toFixed(1)}m(rue) × D=${availD.toFixed(1)}m(prof) aspect=${envAspect.toFixed(2)}`);
  // ── 5. Sélection typologique (avec orientation solaire, bearing et rôle) ──
  const { typology, reason } = selectTypology({
    fp_m2, envelopeArea, envAspect, massing_mode,
    primary_driver, levels, standing_level, program_main,
    site_saturation, project_type, existing_fp_m2: Number(existing_fp_m2) || 0,
    streetBearing, latitude: eLat, scenario_role,
  });
  console.log(`│ Typology: ${typology} — ${reason}`);
  // ── 5b. v56.5 SIMPLIFIED POSITIONING ──
  // Approche directe : utiliser le bbox de l'enveloppe en repère local.
  // Le bâtiment est inscrit dans le bbox avec une marge de 2m.
  // Pas de cross-section, pas de containment check, pas de shrink loop.
  // Garanti de fonctionner pour toute enveloppe convexe.
  const margin = 2.0; // marge constructive (l'enveloppe est déjà en retrait de la parcelle)
  const maxW = Math.max(8, availW - 2 * margin);
  const maxD = Math.max(8, availD - 2 * margin);
  console.log(`│ v56.5 DIRECT: availW=${availW.toFixed(1)} availD=${availD.toFixed(1)} → maxW=${maxW.toFixed(1)} maxD=${maxD.toFixed(1)} (margin=${margin}m)`);
  // Position en profondeur (retrait de la rue) — v56.7 : basé sur le RÔLE
  // INTENSIFICATION → plus près de la rue (visibilité, commerce RDC, intensité urbaine)
  // EQUILIBRE → retrait modéré
  // PRUDENT → retrait plus marqué (calme, résidentiel, phasage)
  let depthPct;
  if (scenario_role === "INTENSIFICATION") depthPct = 0.45;
  else if (scenario_role === "PRUDENT") depthPct = 0.62;
  else depthPct = 0.53; // EQUILIBRE
  // Ajustement solaire : si la rue est N-S, reculer un peu pour libérer la cour sud
  if (solarFavorDepth) depthPct = Math.min(0.70, depthPct + 0.05);
  depthPct = Math.max(0.38, Math.min(0.72, depthPct));
  console.log(`│ Implantation: retrait ${(depthPct*100).toFixed(0)}% de la rue (role=${scenario_role}, mode=${massing_mode})`);
  // ── 6. Générer la forme bâtie ──
  let bPts = [];
  let bW, bD;
  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      a += pts[i].u * pts[j].v - pts[j].u * pts[i].v;
    }
    return Math.abs(a) / 2;
  }
  if (typology === "BARRE") {
    const idealD = Math.min(14, maxD * 0.40);
    bW = Math.min(fp_m2 / idealD, maxW);
    bD = Math.min(fp_m2 / bW, maxD);
    bPts = [
      { u: -bW / 2, v: -bD / 2 }, { u: bW / 2, v: -bD / 2 },
      { u: bW / 2, v: bD / 2 }, { u: -bW / 2, v: bD / 2 },
    ];
  } else if (typology === "EN_U") {
    const wingPct = 0.22, backPct = 0.28;
    bW = Math.min(maxW * 0.92, Math.max(16, maxW * 0.80));
    bD = Math.min(maxD * 0.92, Math.max(14, maxD * 0.80));
    let wing = bW * wingPct, back = bD * backPct;
    let aU = bW * back + 2 * wing * (bD - back);
    if (aU > 0 && aU !== fp_m2) {
      const sc = Math.sqrt(fp_m2 / aU);
      bW = Math.min(bW * sc, maxW); bD = Math.min(bD * sc, maxD);
      wing = bW * wingPct; back = bD * backPct;
    }
    bPts = [
      { u: -bW / 2, v: -bD / 2 },
      { u: -bW / 2 + wing, v: -bD / 2 },
      { u: -bW / 2 + wing, v: bD / 2 - back },
      { u: bW / 2 - wing, v: bD / 2 - back },
      { u: bW / 2 - wing, v: -bD / 2 },
      { u: bW / 2, v: -bD / 2 },
      { u: bW / 2, v: bD / 2 },
      { u: -bW / 2, v: bD / 2 },
    ];
  } else if (typology === "EN_L") {
    const armPctW = 0.35, armPctD = 0.35;
    bW = Math.min(maxW * 0.92, Math.max(14, maxW * 0.80));
    bD = Math.min(maxD * 0.92, Math.max(14, maxD * 0.80));
    let aW = bW * armPctW, aD = bD * armPctD;
    let aL = bW * aD + aW * (bD - aD);
    if (aL > 0 && aL !== fp_m2) {
      const sc = Math.sqrt(fp_m2 / aL);
      bW = Math.min(bW * sc, maxW); bD = Math.min(bD * sc, maxD);
      aW = bW * armPctW; aD = bD * armPctD;
    }
    bPts = [
      { u: -bW / 2, v: -bD / 2 },
      { u: bW / 2, v: -bD / 2 },
      { u: bW / 2, v: -bD / 2 + aD },
      { u: -bW / 2 + aW, v: -bD / 2 + aD },
      { u: -bW / 2 + aW, v: bD / 2 },
      { u: -bW / 2, v: bD / 2 },
    ];
  } else {
    // BLOC : rectangle compact ~1.25:1
    const ratio = 1.25;
    bD = Math.min(Math.sqrt(fp_m2 / ratio), maxD);
    bW = Math.min(fp_m2 / bD, maxW);
    if (bW > maxW) { bW = maxW; bD = Math.min(fp_m2 / bW, maxD); }
    bPts = [
      { u: -bW / 2, v: -bD / 2 }, { u: bW / 2, v: -bD / 2 },
      { u: bW / 2, v: bD / 2 }, { u: -bW / 2, v: bD / 2 },
    ];
  }
  const shapeArea = polyArea(bPts);
  console.log(`│ Shape: ${typology} bW=${bW.toFixed(1)}m × bD=${bD.toFixed(1)}m area=${shapeArea.toFixed(0)}m² target=${fp_m2}m²`);
  // ── 7. POSITIONNEMENT DIRECT dans le bbox ──
  // Centre U = milieu du bbox, Centre V = retrait en profondeur
  const cU = (minU + maxU) / 2;
  const cV = minV + availD * depthPct;
  console.log(`│ Position: center=(${cU.toFixed(1)}, ${cV.toFixed(1)}) [bbox mid-U, ${(depthPct*100).toFixed(0)}% depth-V]`);
  // Positionner les points : local (u,v) → mètre (x,y) → GPS
  function localToMeter(p) {
    return { x: p.u * sUx + p.v * nUx, y: p.u * sUy + p.v * nUy };
  }
  const finalPts = bPts.map(p => ({ u: p.u + cU, v: p.v + cV }));
  const finalM = finalPts.map(localToMeter);
  // ── 8. Conversion GPS ──
  const result = finalM.map(p => ({
    lat: eLat + p.y / R_EARTH * 180 / Math.PI,
    lon: eLon + p.x / (R_EARTH * Math.cos(eLat * Math.PI / 180)) * 180 / Math.PI,
  }));
  result.forEach((c, i) => console.log(`│ Massing[${i}]: ${c.lat.toFixed(7)}, ${c.lon.toFixed(7)}`));
  const actualFp = Math.abs(finalM.reduce((s, p, i) => {
    const j = (i + 1) % finalM.length;
    return s + p.x * finalM[j].y - finalM[j].x * p.y;
  }, 0) / 2);
  console.log(`│ Emprise réelle ≈ ${actualFp.toFixed(0)}m² (cible=${fp_m2}m²)`);
  console.log(`│ Typology: ${typology} — ${reason}`);
  console.log(`└── end computeMassingPolygon v56 ──`);
  result._typology = typology;
  result._reason = reason;
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
      paint: { 'line-color': '#2563eb', 'line-width': 2.5, 'line-dasharray': [5, 3], 'line-opacity': 0.80 } }, '3d-buildings');
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
  const parcelGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...parcelCoords.map(c => [c.lon, c.lat]), [parcelCoords[0].lon, parcelCoords[0].lat]]] },
  };
  const envelopeGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...envelopeCoords.map(c => [c.lon, c.lat]), [envelopeCoords[0].lon, envelopeCoords[0].lat]]] },
  };
  const massingGeoJSON = {
    type: "Feature",
    properties: { height: massingParams.total_height, base_height: 0 },
    geometry: { type: "Polygon", coordinates: [[...massingCoords.map(c => [c.lon, c.lat]), [massingCoords[0].lon, massingCoords[0].lat]]] },
  };
  const rdcH = massingParams.rdc_height || (massingParams.commerce_levels > 0 ? 4.0 : 3.0);
  const etageH = massingParams.floor_height || 3.0;
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
    // ── PARCELLE : contour ocre jaune, pas de fill ──
    map.addSource('parcel', { type: 'geojson', data: ${JSON.stringify(parcelGeoJSON)} });
    map.addLayer({ id: 'parcel-outline', type: 'line', source: 'parcel',
      paint: { 'line-color': '#c8a020', 'line-width': 2.5, 'line-opacity': 0.9 } }, '3d-buildings');
    // ── ENVELOPE (limite séparative) : ocre tirets ──
    map.addSource('envelope', { type: 'geojson', data: ${JSON.stringify(envelopeGeoJSON)} });
    map.addLayer({ id: 'envelope-outline', type: 'line', source: 'envelope',
      paint: { 'line-color': '#b8942c', 'line-width': 1.8, 'line-dasharray': [6, 3], 'line-opacity': 0.70 } }, '3d-buildings');
    // ── MASSING : étages individuels, RDC=${rdcH}m, courants=${etageH}m, gaps entre niveaux ──
    map.addSource('massing', { type: 'geojson', data: ${JSON.stringify(massingGeoJSON)} });
    const rdcH = ${rdcH};
    const etageH = ${etageH};
    const totalLevels = ${massingParams.levels || Math.round(massingParams.total_height / etageH)};
    const commLevels = ${massingParams.commerce_levels};
    const gap = 0.06;
    for (let f = 0; f < totalLevels; f++) {
      // Hauteur cumulée : RDC a sa propre hauteur, les suivants = etageH
      const base = f === 0 ? 0 : rdcH + (f - 1) * etageH;
      const top  = f === 0 ? rdcH : rdcH + f * etageH;
      // Gap entre étages (trait de niveau) : uniquement ENTRE les étages, pas en bas ni en haut
      const baseH = f > 0 ? base + gap / 2 : 0;
      const topH  = f < totalLevels - 1 ? top - gap / 2 : top;
      const isComm = f < commLevels;
      map.addLayer({
        id: 'floor-' + f, type: 'fill-extrusion', source: 'massing',
        paint: {
          'fill-extrusion-color': isComm ? '#e8a030' : '#8bb0d8',
          'fill-extrusion-height': topH,
          'fill-extrusion-base': baseH,
          'fill-extrusion-opacity': isComm ? 0.90 : 0.72,
          'fill-extrusion-vertical-gradient': true,
        },
      });
    }
    // ── Contour emprise au sol : bleu foncé ──
    map.addLayer({ id: 'massing-footprint', type: 'line', source: 'massing',
      paint: { 'line-color': '#2c4a6e', 'line-width': 2.5, 'line-opacity': 0.9 } });
  });
  let rendered = false;
  map.on('idle', () => { if (rendered) return; rendered = true; setTimeout(() => { window.__MAP_READY = true; }, 2500); });
  setTimeout(() => { window.__MAP_READY = true; }, 28000);
})();
</script>
</body>
</html>`;
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
function drawMassingOverlays(ctx, W, H, { site_area, bearing, label, levels, commerce_levels, habitation_levels, total_height, floor_height, fp_m2, accent_color, scenario_role, typology }) {
  const s = W / 1280;

  // ── BOUSSOLE N en bas à droite ──
  ctx.save();
  ctx.translate(W - 60*s, H - 60*s);
  ctx.shadowColor = "rgba(0,0,0,0.12)"; ctx.shadowBlur = 6*s; ctx.shadowOffsetY = 2*s;
  ctx.beginPath(); ctx.arc(0, 0, 32*s, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#c8a020"; ctx.lineWidth = 2*s; ctx.stroke();
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.font = `bold ${11*s}px Arial`; ctx.textAlign = "center";
  ctx.fillStyle = "#c8a020"; ctx.fillText("N", 0, -18*s);
  ctx.fillStyle = "#bbb"; ctx.fillText("S", 0, 24*s);
  ctx.fillStyle = "#bbb"; ctx.fillText("O", -22*s, 4*s);
  ctx.fillStyle = "#bbb"; ctx.fillText("E", 22*s, 4*s);
  ctx.restore();

  // ── ANNOTATIONS ÉTAGES : traits + labels à droite du bâtiment (style référence) ──
  // Positionnées au centre-droit de l'image
  const rdcH_m = commerce_levels > 0 ? 4.0 : 3.0;
  const etageH_m = 3.0;
  const realTotalH = rdcH_m + (levels - 1) * etageH_m;
  const sdpTotale = fp_m2 * levels;
  // Espacement vertical entre annotations (adapté à la perspective)
  const annX = W * 0.62;         // position X des annotations (à droite du bâtiment)
  const annBaseY = H * 0.58;     // base du RDC (approximation perspective)
  const annStepY = -32 * s;      // espacement vertical entre étages
  const lineLen = 14 * s;
  for (let f = 0; f < levels; f++) {
    const y = annBaseY + f * annStepY;
    const floorLabel = f === 0 ? "RDC" : `R+${f}`;
    // Petit trait horizontal
    ctx.beginPath();
    ctx.moveTo(annX, y); ctx.lineTo(annX + lineLen, y);
    ctx.strokeStyle = "#2c4a6e"; ctx.lineWidth = 2*s; ctx.stroke();
    // Label : "R+2 : 596 m²"
    ctx.font = `bold ${12*s}px Arial`; ctx.fillStyle = "#2c4a6e"; ctx.textAlign = "left";
    ctx.fillText(`${floorLabel} : ${fp_m2} m²`, annX + lineLen + 6*s, y + 4*s);
  }
  // Total SDP en bas
  ctx.font = `${12*s}px Arial`; ctx.fillStyle = "#555"; ctx.textAlign = "left";
  ctx.fillText(`Total: ${sdpTotale.toLocaleString("fr-FR")} m² SDP`, annX, annBaseY + 24*s);
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
    const cacheBust2 = `?v=${Date.now()}`;
    let enhancedUrl = pd.publicUrl + cacheBust2;
    if (OPENAI_API_KEY) {
      try {
        console.log("[SLIDE4-POLISH] Starting OpenAI polish (Responses API + gpt-image-1)...");
        const resizedCanvas = createCanvas(1024, 1024);
        resizedCanvas.getContext("2d").drawImage(await loadImage(png), 0, 0, W, H, 0, 0, 1024, 1024);
        const pngResized = resizedCanvas.toBuffer("image/png");
        const b64Input = pngResized.toString("base64");
        console.log(`[SLIDE4-POLISH] Resized image: ${pngResized.length} bytes, b64: ${b64Input.length} chars`);
        const polishPrompt = "Restyle as premium architectural illustration. Keep exact same geometry, camera, buildings, roads. White rooftops, warm gray shadows, black edges. Green grass inside blocks, round dark-green trees along streets. Sandy beige roads, cream sidewalks. Keep red/pink parcel zone at exact position. No text or labels.";
        console.log("[SLIDE4-POLISH] Calling OpenAI Responses API (gpt-4o-mini + image_generation)...");
        const oaiRes = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            input: [{ role: "user", content: [
              { type: "input_image", image_url: `data:image/png;base64,${b64Input}` },
              { type: "input_text", text: polishPrompt }
            ]}],
            tools: [{ type: "image_generation", quality: "low", size: "1024x1024" }]
          })
        });
        console.log(`[SLIDE4-POLISH] OpenAI status: ${oaiRes.status}`);
        const oaiJson = await oaiRes.json();
        if (oaiJson.error) {
          console.error(`[SLIDE4-POLISH] OpenAI error: ${JSON.stringify(oaiJson.error)}`);
        }
        let polishedB64 = null;
        if (oaiJson.output) {
          for (const item of oaiJson.output) {
            if (item.type === "image_generation_call" && item.result) { polishedB64 = item.result; break; }
          }
        }
        if (polishedB64) {
          console.log(`[SLIDE4-POLISH] Got image (${polishedB64.length} chars)`);
          const enhancedMapBuf = Buffer.from(polishedB64, "base64");
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
            console.log(`✓ [SLIDE4-POLISH] Enhanced OK: ${enhancedUrl} (${Date.now() - t0}ms)`);
          } else {
            console.error(`[SLIDE4-POLISH] Supabase upload error: ${JSON.stringify(ue2)}`);
          }
        } else {
          console.warn(`[SLIDE4-POLISH] No image in response. Keys: ${JSON.stringify(Object.keys(oaiJson))}`);
          if (oaiJson.output) console.warn(`[SLIDE4-POLISH] output types: ${oaiJson.output.map(o => o.type).join(", ")}`);
        }
      } catch (oaiErr) { console.error("[SLIDE4-POLISH] Exception:", oaiErr.message); }
    }
    return res.json({ ok: true, public_url: pd.publicUrl + cacheBust2, enhanced_url: enhancedUrl, path: basePath, centroid: { lat: cLat, lon: cLon }, view: { zoom, bearing, pitch: 58 }, duration_ms: Date.now() - t0 });
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
  console.log("═══ /generate-massing v56.2 ═══", JSON.stringify(req.body).slice(0, 300));
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
    // ── Contexte parcelle occupée / rénovation ──
    project_type,          // NEUF | RENOVATION | EXTENSION | SURELEVATION | DEMOLITION_RECONSTRUCTION
    existing_footprint_m2, // emprise existante si parcelle déjà construite
    // ── v56.7 : orientation rue ──
    road_bearing,          // azimut de la route principale (degrés, depuis la Sheet)
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
  // ── Calcul aire réelle de l'enveloppe (Shoelace formula en mètres) ──
  let envelopeAreaReal = 0;
  for (let i = 0; i < envPtsDbg.length; i++) {
    const j = (i + 1) % envPtsDbg.length;
    envelopeAreaReal += envPtsDbg[i].x * envPtsDbg[j].y;
    envelopeAreaReal -= envPtsDbg[j].x * envPtsDbg[i].y;
  }
  envelopeAreaReal = Math.abs(envelopeAreaReal) / 2;
  console.log(`Envelope real area (shoelace): ${envelopeAreaReal.toFixed(1)}m²`);
  const bearing = computeBearing(coords, cLat, cLon);
  const zoom = computeZoomMassing(coords, cLat, cLon); // v56.5: zoom plus serré pour le massing
  console.log(`Map view: bearing=${bearing}° zoom=${zoom}`);
  const massingCoords = computeMassingPolygon(envelopeCoords, fp, envelopeAreaReal, {
    massing_mode: compute_scenario ? (label === "A" ? "BALANCED" : label === "B" ? "SPREAD" : "COMPACT") : "BALANCED",
    primary_driver: primary_driver || "MAX_CAPACITE",
    levels,
    standing_level: standing_level || "STANDARD",
    program_main: program_main || "",
    site_saturation: site_saturation_level || "MEDIUM",
    project_type: project_type || "NEUF",
    existing_fp_m2: Number(existing_footprint_m2) || 0,
    road_bearing: Number(road_bearing) || null,        // v56.7: azimut rue depuis la Sheet
    scenario_role: label === "A" ? "INTENSIFICATION" : label === "B" ? "EQUILIBRE" : "PRUDENT",
  });
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
    // ── PIPELINE HEKTAR : capture HD x2 ──
    await page.setViewport({ width: 1280, height: 1280, deviceScaleFactor: 2 });
    const rdcH = commerceLevels > 0 ? 4.0 : 3.0;   // RDC commerce = 4m, sinon 3m
    const etageH = 3.0;                              // étages courants = 3m
    const realTotalH = rdcH + (levels - 1) * etageH; // hauteur réelle avec RDC variable
    console.log(`[HEKTAR] levels=${levels} rdcH=${rdcH}m etageH=${etageH}m totalH=${realTotalH}m commerce=${commerceLevels}`);
    const html = generateMassingHTML({ lat: cLat, lon: cLon }, zoom, bearing, coords, envelopeCoords, massingCoords,
      { total_height: realTotalH, commerce_levels: commerceLevels, floor_height: etageH, rdc_height: rdcH, accent_color: accentColor, levels: levels }, MAPBOX_TOKEN);
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForFunction("window.__MAP_READY === true", { timeout: 28000 });
    // clip en CSS pixels (1280×1280) → Puppeteer produit PNG 2560×2560 grâce à deviceScaleFactor: 2
    const screenshotBuf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 1280 } });
    await page.close();
    console.log(`[HEKTAR] Screenshot: ${screenshotBuf.length} bytes`);
    // Canvas overlay à la résolution native du screenshot (2560×2560)
    const img = await loadImage(screenshotBuf);
    const W = img.width, H = img.height;  // sera 2560×2560
    console.log(`[HEKTAR] Canvas: ${W}×${H}`);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, W, H);
    drawMassingOverlays(ctx, W, H, {
      site_area: Number(site_area), bearing, label,
      levels, commerce_levels: commerceLevels, habitation_levels: habitationLevels,
      total_height: realTotalH, floor_height: etageH, fp_m2: Math.round(fp), accent_color: accentColor, scenario_role: scenarioRole,
      typology: massingCoords._typology,
    });
    const png = canvas.toBuffer("image/png");
    await sb.storage.from("massing-images").upload(basePath, png, { contentType: "image/png", upsert: true });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
    const cacheBust = `?v=${Date.now()}`;
    let enhancedUrl = pd.publicUrl + cacheBust;
    if (OPENAI_API_KEY) {
      try {
        console.log(`[POLISH] Starting OpenAI polish (Responses API + gpt-image-1)... (key: ${OPENAI_API_KEY.substring(0,8)}...)`);
        const resizedCanvas = createCanvas(1024, 1024);
        resizedCanvas.getContext("2d").drawImage(await loadImage(png), 0, 0, W, H, 0, 0, 1024, 1024);
        const pngResized = resizedCanvas.toBuffer("image/png");
        const b64Input = pngResized.toString("base64");
        console.log(`[POLISH] Resized image: ${pngResized.length} bytes, b64: ${b64Input.length} chars`);
        const polishPrompt = "Polish this architectural massing render. Keep EXACT geometry, camera, volumes. White rooftops, warm gray shadows, dark edge lines. Sandy beige roads. Round green trees outside parcel. Keep blue floors, orange commerce, annotations. Premium architectural quality.";
        console.log("[POLISH] Calling OpenAI Responses API (gpt-4o-mini + image_generation)...");
        const oaiRes = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            input: [{ role: "user", content: [
              { type: "input_image", image_url: `data:image/png;base64,${b64Input}` },
              { type: "input_text", text: polishPrompt }
            ]}],
            tools: [{ type: "image_generation", quality: "low", size: "1024x1024" }]
          })
        });
        console.log(`[POLISH] OpenAI response status: ${oaiRes.status}`);
        const oaiJson = await oaiRes.json();
        if (oaiJson.error) {
          console.error(`[POLISH] OpenAI API error: ${JSON.stringify(oaiJson.error)}`);
        }
        let polishedB64 = null;
        if (oaiJson.output) {
          for (const item of oaiJson.output) {
            if (item.type === "image_generation_call" && item.result) { polishedB64 = item.result; break; }
          }
        }
        if (polishedB64) {
          console.log(`[POLISH] Got image (${polishedB64.length} chars)`);
          const enhBuf = Buffer.from(polishedB64, "base64");
          const fCanvas = createCanvas(W, H);
          fCanvas.getContext("2d").drawImage(await loadImage(enhBuf), 0, 0, W, H);
          drawMassingOverlays(fCanvas.getContext("2d"), W, H, {
            site_area: Number(site_area), bearing, label,
            levels, commerce_levels: commerceLevels, habitation_levels: habitationLevels,
            total_height: realTotalH, floor_height: etageH, fp_m2: Math.round(fp), accent_color: accentColor, scenario_role: scenarioRole,
            typology: massingCoords._typology,
          });
          const finalPng = fCanvas.toBuffer("image/png");
          const { error: ue2 } = await sb.storage.from("massing-images").upload(enhancedPath, finalPng, { contentType: "image/png", upsert: true });
          if (!ue2) {
            const { data: pd2 } = sb.storage.from("massing-images").getPublicUrl(enhancedPath);
            enhancedUrl = pd2.publicUrl;
            console.log(`✓ Enhanced OK: ${enhancedUrl} (${Date.now() - t0}ms)`);
          } else {
            console.error(`[POLISH] Supabase upload error: ${JSON.stringify(ue2)}`);
          }
        } else {
          console.warn(`[POLISH] No image in response. Keys: ${JSON.stringify(Object.keys(oaiJson))}`);
        }
      } catch (oaiErr) { console.error("[POLISH] Exception:", oaiErr.message, oaiErr.stack); }
    } else {
      console.warn("[POLISH] Skipped — no OPENAI_API_KEY");
    }
    return res.json({
      ok: true, cached: false, server_version: "58.3-HEKTAR-POLISH",
      public_url: pd.publicUrl + cacheBust, enhanced_url: enhancedUrl,
      massing_label: label, fp_m2: fp,
      actual_typology: massingCoords._typology || "BLOC",
      actual_envelope_w: actualEnvW.toFixed(1), actual_envelope_d: actualEnvD.toFixed(1),
      actual_envelope_area: envelopeAreaReal.toFixed(0),
      sheet_envelope_w: envW, sheet_envelope_d: envD,
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
  console.log(`BARLO v56.6 on port ${PORT}`);
  console.log(`Browserless: ${BROWSERLESS_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Mapbox:      ${MAPBOX_TOKEN ? "OK" : "MISSING"}`);
  console.log(`OpenAI:      ${OPENAI_API_KEY ? "OK" : "MISSING"}`);
});
