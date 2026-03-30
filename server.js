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
app.get("/health", (req, res) => res.json({ ok: true, engine: "browserless-mapbox-gl-3d", version: "56.9" }));

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
      server_version: "56.9",
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
    version: "56.4", zoning: zt, site_area: sa, envelope: `${ew}x${ed}`,
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
    max_units_per_floor: { ECO: 6, STD: 4, PREM: 3 }, max_floors: 8,
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
};

// ── Helper: normalise program_main string → PROGRAM_RULES key ──
function parseProgramKey(raw) {
  const s = String(raw || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
  // v56.1 — TOUS LES PARAMÈTRES INTÉGRÉS (plus de code mort)
  // ══════════════════════════════════════════════════════════════════════════════
  // v56.7 — NORMALISATION SCORES + ENUMS FR/EN
  // ══════════════════════════════════════════════════════════════════════════════

  // ── Helper: normalise un score (accepte 0-1 OU 0-100) ──
  function norm01(v) {
    const n = Number(v) || 0;
    if (n > 1 && n <= 100) return n / 100;  // score 0-100 → 0-1
    return Math.max(0, Math.min(1, n));
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

  for (const label of ["A", "B", "C"]) {
    const role = SCENARIO_ROLE[label];
    const mode = SCENARIO_MASSING_MODE[label];

    let fp, levels, unitMixDetail, totalUseful, circRatio, bodyDepth, maxPerFloor, groundReserve;
    let hasPilotis = false;
    let pilotisLevels = 0;

    if (isProgramDriven) {
      // ════════════════════════════════════════════════════════════════════════
      // MODE PROGRAMME-DRIVEN : fp dérivé du programme client
      // ════════════════════════════════════════════════════════════════════════
      const sizes = (UNIT_SIZES[sizeKey] || UNIT_SIZES.STANDARD)[label];

      // Résoudre les champs rules qui dépendent du standing ou du rôle
      circRatio = resolveField(rules.circulation_ratio, stdKey);
      bodyDepth = resolveField(rules.body_depth_m, stdKey);
      maxPerFloor = resolveField(rules.max_units_per_floor, stdKey);
      groundReserve = resolveField(rules.ground_reserve, label) || 0.25;
      let maxFloorsProg = rules.max_floors || 99;

      // ── BUNGALOWS : si maison individuelle + plusieurs unités → plain-pied ──
      const isBungalow = programKey === "MAISON_INDIVIDUELLE" && target_units > 1;
      if (isBungalow) {
        maxFloorsProg = rules.bungalow_max_floors || 1; // force 1 niveau
      }

      // ── BUREAUX (fp_from_envelope) : le plateau est dérivé de l'enveloppe ──
      // target_units = nombre de niveaux, pas nombre de postes
      const isFpFromEnvelope = rules.fp_from_envelope === true;

      // Mix de logements : unit_mix fourni par le client, sinon default
      const mix = rules.default_mix_fn
        ? rules.default_mix_fn(target_units)
        : rules.default_mix
          ? { ...rules.default_mix }
          : { T3: target_units };

      // Calculer surfaces utiles par typo
      totalUseful = 0;
      let totalUnits = 0;
      const details = [];

      if (isFpFromEnvelope) {
        // Pour les bureaux : fp = enveloppe × (1-réserve), niveaux = target_units
        totalUnits = target_units;
        totalUseful = 0; // pas pertinent pour les bureaux
        details.push(`${target_units} plateaux libres`);
      } else {
        for (const [typ, count] of Object.entries(mix)) {
          if (count <= 0) continue;
          const unitSize = sizes[typ] || sizes.T3 || 80;
          totalUseful += count * unitSize;
          totalUnits += count;
          details.push(`${count}×${typ}(${unitSize}m²)`);
        }
      }
      unitMixDetail = details.join(" + ");

      // SDP totale nécessaire = utile / (1 - circulation)
      const sdpNeeded = isFpFromEnvelope ? 0 : totalUseful / (1 - circRatio);

      // ── DRIVER MAX_CAPACITE / RENTABILITE : autoriser plus d'unités par palier ──
      // Le client veut maximiser → on peut mettre plus de logements par étage
      // en poussant l'emprise vers le CES max au lieu de rester au strict programme
      let effectiveMaxPerFloor = maxPerFloor;
      const isMaxDriver = /MAX_CAPACITE|RENTABILITE/i.test(primary_driver);
      if (isMaxDriver && role === "INTENSIFICATION") {
        // A (INTENSIFICATION) + driver max → on peut aller jusqu'à maxPerFloor+2
        // ça augmente le fp par palier en gardant les mêmes surfaces d'appart
        effectiveMaxPerFloor = maxPerFloor + 2;
        console.log(`│   💪 Driver ${primary_driver} + INTENSIFICATION → max ${effectiveMaxPerFloor} unités/palier (au lieu de ${maxPerFloor})`);
      } else if (isMaxDriver && role === "EQUILIBRE") {
        effectiveMaxPerFloor = maxPerFloor + 1;
      }

      // Nombre d'unités par palier (limité par rules ajustées)
      const unitsPerFloor = Math.min(effectiveMaxPerFloor, totalUnits);

      // ── CALCUL fp ET floorsNeeded selon le mode ──
      let floorsNeeded;
      if (isFpFromEnvelope) {
        // BUREAUX : plateau = enveloppe × (1-réserve), niveaux = target_units
        const maxFpByEnv = envelope_area * (1 - groundReserve);
        fp = Math.round(Math.min(max_fp, maxFpByEnv));
        floorsNeeded = Math.min(target_units, Math.min(maxFloorsProg, absMaxLevels));
        floorsNeeded = Math.max(1, floorsNeeded);
        totalUseful = Math.round(fp * (1 - circRatio) * floorsNeeded);
        unitMixDetail = `${floorsNeeded} plateaux de ${fp}m² (utile ${Math.round(fp*(1-circRatio))}m²/plateau)`;
      } else if (isBungalow) {
        // BUNGALOWS : pas d'empilement, chaque unité est au sol
        floorsNeeded = 1;
        fp = Math.round(sdpNeeded); // toute la SDP est au sol
        unitMixDetail = `${totalUnits} bungalows: ` + unitMixDetail;
      } else {
        // IMMEUBLES : empiler les unités
        floorsNeeded = Math.ceil(totalUnits / unitsPerFloor);
        const effectiveMaxFloors = Math.min(maxFloorsProg, absMaxLevels);
        floorsNeeded = Math.min(floorsNeeded, effectiveMaxFloors);
        floorsNeeded = Math.max(1, floorsNeeded);
        const usefulPerFloor = totalUseful / floorsNeeded;
        fp = Math.round(usefulPerFloor / (1 - circRatio));
      }

      const effectiveMaxFloors = Math.min(maxFloorsProg, absMaxLevels);

      // ── GARDE-FOU CES : fp ne peut pas dépasser le CES ──
      const canAdjustFloors = !isBungalow && !isFpFromEnvelope; // bureaux et bungalows : floors fixes
      if (fp > max_fp) {
        console.log(`│   ⚠ ${label}: fp programme=${fp}m² > CES max=${Math.round(max_fp)}m² → ajustement`);
        fp = Math.round(max_fp);
        if (canAdjustFloors && sdpNeeded > 0) {
          floorsNeeded = Math.min(effectiveMaxFloors, Math.ceil(sdpNeeded / fp));
          floorsNeeded = Math.max(1, floorsNeeded);
        }
      }

      // ── GARDE-FOU ENVELOPPE × réserve sol ──
      const maxFpByEnvelope = isFpFromEnvelope ? max_fp : envelope_area * (1 - groundReserve);
      if (!isFpFromEnvelope && fp > maxFpByEnvelope) {
        console.log(`│   ⚠ ${label}: fp=${fp}m² > enveloppe×(1-reserve)=${Math.round(maxFpByEnvelope)}m² → ajustement`);
        fp = Math.round(maxFpByEnvelope);
        if (canAdjustFloors && sdpNeeded > 0) {
          floorsNeeded = Math.min(effectiveMaxFloors, Math.ceil(sdpNeeded / fp));
          floorsNeeded = Math.max(1, floorsNeeded);
        }
      }

      // ── GARDE-FOU COS : SDP totale ≤ COS × site_area × cap_by_role ──
      const cosCap = COS_CAP_BY_ROLE[role] || 1.0;
      const maxSdpForRole = Math.floor(max_sdp * cosCap);
      if (fp * floorsNeeded > maxSdpForRole && !isBungalow) {
        if (isFpFromEnvelope) {
          // BUREAUX : plutôt réduire le plateau pour garder les niveaux demandés
          const idealFp = Math.floor(maxSdpForRole / floorsNeeded);
          console.log(`│   ⚠ ${label}: SDP=${fp * floorsNeeded}m² > COS cap=${maxSdpForRole}m² → fp réduit de ${fp} à ${idealFp}m² (${floorsNeeded} niveaux conservés)`);
          fp = idealFp;
        } else {
          const maxLevelsByCos = Math.max(1, Math.floor(maxSdpForRole / fp));
          console.log(`│   ⚠ ${label}: SDP=${fp * floorsNeeded}m² > COS cap=${maxSdpForRole}m² → ${maxLevelsByCos} niv`);
          floorsNeeded = maxLevelsByCos;
        }
      }

      levels = floorsNeeded;

      // ── PILOTIS : check si l'espace libre est suffisant pour le parking ──
      const freeGround = envelope_area - fp;
      const parkingSpotsNeeded = Math.max(PILOTIS_CONFIG.MIN_PARKING_SPOTS, Math.ceil(totalUnits * (rules.parking_per_unit || 1)));
      const parkingM2Needed = parkingSpotsNeeded * PILOTIS_CONFIG.PARKING_SPOT_M2;
      const freeGroundPct = freeGround / Math.max(1, envelope_area);
      const pilotisRule = rules.requires_pilotis;

      if (!isBungalow && (pilotisRule === true || (pilotisRule === "auto" &&
        (freeGround < PILOTIS_CONFIG.MIN_FREE_GROUND_M2 || freeGroundPct < PILOTIS_CONFIG.MIN_FREE_GROUND_PCT) &&
        freeGround < parkingM2Needed))) {
        hasPilotis = true;
        pilotisLevels = 1;
      }

      // Commerce au RDC : si rules.rdc_commerce, le RDC est commercial (hauteur différente)
      const hasRdcCommerce = rules.rdc_commerce || false;
      const rdcHeightM = hasRdcCommerce ? (rules.rdc_height_m || 4.0) : floor_height;

      console.log(`│ ✅ ${label} (${role}) PROGRAMME-DRIVEN${isBungalow ? " [BUNGALOWS]" : ""}:`);
      console.log(`│   mix: ${unitMixDetail}`);
      console.log(`│   utile=${Math.round(totalUseful)}m² circ=${(circRatio*100).toFixed(0)}% → plateau=${fp}m² (${Math.round(fp/bodyDepth)}m×${bodyDepth}m)`);
      console.log(`│   niveaux=${levels} (max prog=${maxFloorsProg} max regl=${absMaxLevels})`);
      console.log(`│   reserve sol=${(groundReserve*100).toFixed(0)}% libre=${Math.round(freeGround)}m² parking=${parkingSpotsNeeded} places`);
      if (hasPilotis) console.log(`│   ⚡ PILOTIS activé`);
      if (hasRdcCommerce) console.log(`│   🏪 RDC Commerce (h=${rdcHeightM}m)`);

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
      if ((freeGround < PILOTIS_CONFIG.MIN_FREE_GROUND_M2 || freeGroundPct < PILOTIS_CONFIG.MIN_FREE_GROUND_PCT)
          && freeGround < parkingM2Needed) {
        hasPilotis = true;
        pilotisLevels = 1;
      }

      unitMixDetail = null;
      totalUseful = 0;
      circRatio = 0;
      bodyDepth = 0;

      console.log(`│ 📐 ${label} (${role}) REGULATION-DRIVEN: ratio=${ratio.toFixed(3)} fp=${fp}m² levels=${levels}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CALCULS COMMUNS (program-driven et regulation-driven)
    // ══════════════════════════════════════════════════════════════════════════
    const totalLevelsWithPilotis = levels + pilotisLevels;
    const pilotisH = hasPilotis ? PILOTIS_CONFIG.PILOTIS_HEIGHT_M : 0;
    const height = Math.round((levels * floor_height + pilotisH) * 10) / 10;
    const sdp = fp * levels;
    const cosRatio = max_sdp > 0 ? sdp / max_sdp : 0;

    let compliance;
    if (cosRatio <= 1.05) compliance = "CONFORME";
    else if (cosRatio <= 1.30) compliance = "DEROGATION_POSSIBLE";
    else compliance = "AMBITIEUX_HORS_COS";

    // Coût estimé
    const costPerM2Base = { PREMIUM: 450, HAUT: 380, STANDARD: 300, ECONOMIQUE: 230, ECO: 230 }[String(standing_level).toUpperCase()] || 300;
    const zoningCostMult = { URBAIN: 1.15, PERIURBAIN: 1.0, PAVILLON: 0.95, RURAL: 0.85, MIXTE: 1.05 }[zoning_type] || 1.0;
    const pilotisCostMult = hasPilotis ? 1.12 : 1.0;
    const estimatedCost = Math.round(sdp * costPerM2Base * zoningCostMult * pilotisCostMult);
    const budgetFit = budget_range > 0 ? (estimatedCost <= budget_range * 1.1 ? "DANS_BUDGET" : estimatedCost <= budget_range * 1.3 ? "BUDGET_TENDU" : "HORS_BUDGET") : "N/A";

    const freeGround = envelope_area - fp;
    const parkingEst = hasPilotis ? Math.floor(fp / PILOTIS_CONFIG.PARKING_SPOT_M2) : Math.floor(freeGround / PILOTIS_CONFIG.PARKING_SPOT_M2);

    results[label] = {
      fp_m2: fp, levels, height_m: height,
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
      parking_spots_estimate: parkingEst,
      role: SCENARIO_ROLE[label],
      label_fr: labels_fr[label],
      accent_color: accents[label],
      estimated_cost: estimatedCost,
      budget_fit: budgetFit,
      // v56.9 programme-driven extras
      program_driven: isProgramDriven,
      program_key: programKey || "NONE",
      unit_mix_detail: unitMixDetail || "N/A",
      total_useful_m2: Math.round(totalUseful || 0),
      circulation_ratio_pct: Math.round((circRatio || 0) * 100),
      body_depth_m: bodyDepth || 0,
    };
  }

  const r = results;

  // ── POST-TRAITEMENT : garantir la hiérarchie A ≥ B ≥ C en SDP ──
  // En mode programme-driven, la différenciation vient des tailles d'apparts.
  // Mais il faut quand même garantir que A.sdp ≥ B.sdp ≥ C.sdp (cohérence visuelle).
  if (isProgramDriven) {
    // En programme-driven, les fp sont déjà différenciés par les UNIT_SIZES.
    // On vérifie juste la cohérence : A doit être ≥ B ≥ C en SDP
    if (r.A.sdp_m2 < r.B.sdp_m2) {
      // Si A < B, c'est que A a moins de niveaux → on ajuste
      r.A.levels = Math.max(r.A.levels, r.B.levels);
      r.A.sdp_m2 = r.A.fp_m2 * r.A.levels;
      r.A.height_m = Math.round(r.A.levels * floor_height * 10) / 10;
    }
    if (r.B.sdp_m2 < r.C.sdp_m2) {
      r.C.levels = Math.max(1, r.B.levels - 1 || 1);
      if (r.C.levels === r.B.levels) r.C.fp_m2 = Math.round(r.C.fp_m2 * 0.90);
      r.C.sdp_m2 = r.C.fp_m2 * r.C.levels;
      r.C.height_m = Math.round(r.C.levels * floor_height * 10) / 10;
    }
  } else {
    // Regulation-driven : ancienne logique de différenciation
    if (r.C.levels <= r.A.levels && absMaxLevels > r.A.levels) {
      r.C.levels = Math.min(r.A.levels + 1, absMaxLevels);
    }
    if (r.B.levels >= r.A.levels && r.A.levels > 1) {
      r.B.levels = Math.max(1, r.A.levels - 1);
    }
    for (const lbl of ["A", "B", "C"]) {
      r[lbl].height_m = Math.round(r[lbl].levels * floor_height * 10) / 10;
      r[lbl].sdp_m2 = r[lbl].fp_m2 * r[lbl].levels;
      const cr = max_sdp > 0 ? r[lbl].sdp_m2 / max_sdp : 0;
      r[lbl].cos_ratio_pct = Math.round(cr * 100);
      r[lbl].cos_compliance = cr <= 1.05 ? "CONFORME" : cr <= 1.30 ? "DEROGATION_POSSIBLE" : "AMBITIEUX_HORS_COS";
    }
    if (r.B.fp_m2 > 0 && r.C.fp_m2 > 0) {
      const diff = Math.abs(r.B.fp_m2 - r.C.fp_m2) / Math.max(r.B.fp_m2, r.C.fp_m2);
      if (diff < 0.15) {
        r.B.fp_m2 = Math.round(Math.min(r.B.fp_m2 * 1.10, envelope_area * 0.95));
        r.C.fp_m2 = Math.max(50, Math.round(r.C.fp_m2 * 0.85));
        r.B.sdp_m2 = r.B.fp_m2 * r.B.levels;
        r.C.sdp_m2 = r.C.fp_m2 * r.C.levels;
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
  // MOTEUR DE RECOMMANDATION (v56.9)
  // ══════════════════════════════════════════════════════════════════════════════
  const scoreWeights = {
    budget_fit: 0.20, cos_conform: 0.15, capacity: 0.15, risk: 0.15,
    rent_potential: 0.10, standing_match: 0.10, phase_compat: 0.08, mix_compat: 0.07,
  };

  for (const label of ["A", "B", "C"]) {
    const sc = r[label];
    let score = 0;
    const budgetScore = sc.budget_fit === "DANS_BUDGET" ? 1.0 : sc.budget_fit === "BUDGET_TENDU" ? 0.5 : sc.budget_fit === "N/A" ? 0.7 : 0;
    score += budgetScore * scoreWeights.budget_fit;
    const cosScore = sc.cos_compliance === "CONFORME" ? 1.0 : sc.cos_compliance === "DEROGATION_POSSIBLE" ? 0.5 : 0.1;
    score += cosScore * scoreWeights.cos_conform;
    const capScore = max_sdp > 0 ? Math.min(1, sc.sdp_m2 / max_sdp) : 0.5;
    score += capScore * scoreWeights.capacity * (0.7 + capSc * 0.6);
    const modeRiskScore = sc.massing_mode === "COMPACT" ? 0.9 : sc.massing_mode === "BALANCED" ? 0.7 : 0.4;
    const adjustedRisk = modeRiskScore * (0.5 + (riskAdj + riskSc) / 2 * 0.5) + (1 - modeRiskScore) * (1 - (riskAdj + riskSc) / 2) * 0.5;
    score += adjustedRisk * scoreWeights.risk;
    const rentScore2 = max_sdp > 0 ? Math.min(1, sc.sdp_m2 / max_sdp) * rentSc : 0.5;
    score += rentScore2 * scoreWeights.rent_potential;
    let standMatch = 0.5;
    if (/PREMIUM|HAUT/i.test(standing_level)) standMatch = sc.massing_mode === "SPREAD" ? 1.0 : sc.massing_mode === "BALANCED" ? 0.7 : 0.3;
    else if (/ECO/i.test(standing_level)) standMatch = sc.massing_mode === "COMPACT" ? 1.0 : sc.massing_mode === "BALANCED" ? 0.6 : 0.3;
    else standMatch = sc.massing_mode === "BALANCED" ? 1.0 : 0.6;
    score += standMatch * scoreWeights.standing_match;
    const phaseCompat = sc.massing_mode === "COMPACT" ? 0.9 : sc.massing_mode === "BALANCED" ? 0.7 : 0.4;
    score += (phaseCompat * phaseSc + 0.5 * (1 - phaseSc)) * scoreWeights.phase_compat;
    const mixCompat = commerceLevels > 0 ? 0.8 + mixSc * 0.2 : 0.5;
    score += mixCompat * scoreWeights.mix_compat;
    sc.recommendation_score = Math.round(score * 1000) / 1000;
  }

  let recommended = "A";
  if (r.B.recommendation_score > r[recommended].recommendation_score) recommended = "B";
  if (r.C.recommendation_score > r[recommended].recommendation_score) recommended = "C";
  r.A.recommended = recommended === "A";
  r.B.recommended = recommended === "B";
  r.C.recommended = recommended === "C";

  const recSc = r[recommended];
  const reasons = [];
  if (recSc.budget_fit === "DANS_BUDGET") reasons.push("respecte le budget");
  if (recSc.cos_compliance === "CONFORME") reasons.push("conforme au COS");
  if (recommended === "A") reasons.push("meilleur equilibre global");
  if (recommended === "B" && /PREMIUM|HAUT/i.test(standing_level)) reasons.push("adapte au standing eleve");
  if (recommended === "C" && budgetPressure > 0.5) reasons.push("optimise sous contrainte budgetaire");
  if (rentSc > 0.6) reasons.push("bon potentiel locatif");
  if (capSc > 0.7 && recSc.sdp_m2 >= max_sdp * 0.7) reasons.push("capacite maximisee");
  if (riskAdj > 0.5 && recSc.cos_compliance === "CONFORME") reasons.push("risque maitrise");
  const recommendation_reason = reasons.length > 0 ? reasons.join(", ") : "meilleur compromis multicritere";

  const meta = {
    engine_version: "56.9",
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

  console.log(`│`);
  console.log(`│ A(${r.A.role}): fp=${r.A.fp_m2}m² × ${r.A.levels}niv = ${r.A.sdp_m2}m² SDP (${r.A.cos_ratio_pct}%COS) ${r.A.cos_compliance} | ${r.A.unit_mix_detail}`);
  console.log(`│ B(${r.B.role}): fp=${r.B.fp_m2}m² × ${r.B.levels}niv = ${r.B.sdp_m2}m² SDP (${r.B.cos_ratio_pct}%COS) ${r.B.cos_compliance} | ${r.B.unit_mix_detail}`);
  console.log(`│ C(${r.C.role}): fp=${r.C.fp_m2}m² × ${r.C.levels}niv = ${r.C.sdp_m2}m² SDP (${r.C.cos_ratio_pct}%COS) ${r.C.cos_compliance} | ${r.C.unit_mix_detail}`);
  console.log(`│ ★ RECOMMANDÉ : ${recommended} — ${recommendation_reason}`);
  console.log(`└── end SCENARIO ENGINE v56.9 ──`);

  return { A: r.A, B: r.B, C: r.C, meta };
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
  const commerceH = massingParams.commerce_levels * massingParams.floor_height;
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
    map.addSource('parcel', { type: 'geojson', data: ${JSON.stringify(parcelGeoJSON)} });
    map.addLayer({ id: 'parcel-fill', type: 'fill', source: 'parcel',
      paint: { 'fill-color': '#d02818', 'fill-opacity': 0.22 } }, '3d-buildings');
    map.addLayer({ id: 'parcel-outline', type: 'line', source: 'parcel',
      paint: { 'line-color': '#d02818', 'line-width': 3, 'line-opacity': 1 } }, '3d-buildings');
    map.addSource('envelope', { type: 'geojson', data: ${JSON.stringify(envelopeGeoJSON)} });
    map.addLayer({ id: 'envelope-outline', type: 'line', source: 'envelope',
      paint: { 'line-color': '#2563eb', 'line-width': 2.5, 'line-dasharray': [5, 3], 'line-opacity': 0.80 } }, '3d-buildings');
    map.addSource('massing', { type: 'geojson', data: ${JSON.stringify(massingGeoJSON)} });
    ${commerceH > 0 ? `map.addLayer({ id: 'massing-commerce', type: 'fill-extrusion', source: 'massing',
      paint: { 'fill-extrusion-color': '#e8a030', 'fill-extrusion-height': ${commerceH}, 'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.95, 'fill-extrusion-vertical-gradient': true } });` : ""}
    map.addLayer({ id: 'massing-habitation', type: 'fill-extrusion', source: 'massing',
      paint: { 'fill-extrusion-color': '#ffffff', 'fill-extrusion-height': ${massingParams.total_height},
        'fill-extrusion-base': ${commerceH}, 'fill-extrusion-opacity': 0.95, 'fill-extrusion-vertical-gradient': true } });
    map.addLayer({ id: 'massing-footprint', type: 'line', source: 'massing',
      paint: { 'line-color': '${massingParams.accent_color}', 'line-width': 3, 'line-opacity': 1 } });
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
  const typoLabels = { BLOC: "Bloc compact", BARRE: "Barre / Lamelle", EN_U: "Forme en U", EN_L: "Forme en L", EXTENSION: "Extension" };
  if (typology) { ctx.font = "bold 11px Arial"; ctx.fillStyle = accent_color || "#2a5298"; ctx.fillText(`Typologie : ${typoLabels[typology] || typology}`, 170, 16 + legPad + 2); }
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
    const cacheBust2 = `?v=${Date.now()}`;
    let enhancedUrl = pd.publicUrl + cacheBust2;
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
      typology: massingCoords._typology,
    });
    const png = canvas.toBuffer("image/png");
    await sb.storage.from("massing-images").upload(basePath, png, { contentType: "image/png", upsert: true });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
    const cacheBust = `?v=${Date.now()}`;
    let enhancedUrl = pd.publicUrl + cacheBust;
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
            typology: massingCoords._typology,
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
      ok: true, cached: false, server_version: "56.9",
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
