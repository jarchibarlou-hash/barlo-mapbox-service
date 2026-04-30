const express = require("express");
const puppeteer = require("puppeteer-core");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas, loadImage } = require("canvas");
const FormData = require("form-data");
const fetch = require("node-fetch");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb", type: () => true }));
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// ═══════════════════════════════════════════════════════════════════════════════
// v72.34: ROBUST AI POLISH ENGINE — stable, retries, model fallback, timeout
// ═══════════════════════════════════════════════════════════════════════════════
const POLISH_MODEL = process.env.OPENAI_POLISH_MODEL || "gpt-4o";
const POLISH_TIMEOUT_MS = 90000; // 90s per API call
const POLISH_MAX_RETRIES = 2;    // retry each variation up to 2 times
const POLISH_RETRY_DELAY_MS = 2000; // 2s between retries
const POLISH_MAX_IMAGE_DIM = 1536;  // resize to max 1536px before sending

/**
 * v72.34: Robust single polish API call with retry + timeout + full error logging
 * Returns { b64: string } on success or { error: string, details: string } on failure
 */
async function callPolishAPI(b64Input, prompt, label, variationIndex, attempt = 1) {
  const tag = `[POLISH-API] ${label}/v${variationIndex}`;
  const controller = new (typeof AbortController !== "undefined" ? AbortController : require("abort-controller"))();
  const timer = setTimeout(() => controller.abort(), POLISH_TIMEOUT_MS);
  try {
    console.log(`${tag} attempt ${attempt}/${POLISH_MAX_RETRIES + 1} — model=${POLISH_MODEL}`);
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: POLISH_MODEL,
        input: [{ role: "user", content: [
          { type: "input_image", image_url: `data:image/png;base64,${b64Input}` },
          { type: "input_text", text: prompt }
        ]}],
        tools: [{ type: "image_generation", input_fidelity: "high" }]
      })
    });
    clearTimeout(timer);
    // Check HTTP status first
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "no body");
      const errMsg = `HTTP ${resp.status}: ${errBody.substring(0, 300)}`;
      console.error(`${tag} API HTTP error: ${errMsg}`);
      // Rate limit → retry after delay
      if (resp.status === 429 && attempt <= POLISH_MAX_RETRIES) {
        const retryAfter = parseInt(resp.headers.get("retry-after") || "3", 10) * 1000;
        console.log(`${tag} Rate limited — waiting ${retryAfter}ms before retry...`);
        await new Promise(r => setTimeout(r, retryAfter));
        return callPolishAPI(b64Input, prompt, label, variationIndex, attempt + 1);
      }
      // Server error (5xx) → retry
      if (resp.status >= 500 && attempt <= POLISH_MAX_RETRIES) {
        console.log(`${tag} Server error — retrying in ${POLISH_RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, POLISH_RETRY_DELAY_MS));
        return callPolishAPI(b64Input, prompt, label, variationIndex, attempt + 1);
      }
      return { error: `HTTP ${resp.status}`, details: errMsg };
    }
    const oaiJson = await resp.json();
    // Check for API-level error in response body
    if (oaiJson.error) {
      const errMsg = typeof oaiJson.error === "string" ? oaiJson.error : JSON.stringify(oaiJson.error);
      console.error(`${tag} API error in response: ${errMsg.substring(0, 300)}`);
      if (attempt <= POLISH_MAX_RETRIES) {
        console.log(`${tag} Retrying in ${POLISH_RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, POLISH_RETRY_DELAY_MS));
        return callPolishAPI(b64Input, prompt, label, variationIndex, attempt + 1);
      }
      return { error: "API error", details: errMsg };
    }
    // Extract image from response
    let polishedB64 = null;
    if (oaiJson.output) {
      for (const item of oaiJson.output) {
        if (item.type === "image_generation_call" && item.result) {
          polishedB64 = item.result;
          break;
        }
      }
    }
    if (!polishedB64) {
      const outputSummary = JSON.stringify(oaiJson.output || oaiJson).substring(0, 400);
      console.warn(`${tag} No image in response. Output: ${outputSummary}`);
      if (attempt <= POLISH_MAX_RETRIES) {
        console.log(`${tag} Retrying (no image)...`);
        await new Promise(r => setTimeout(r, POLISH_RETRY_DELAY_MS));
        return callPolishAPI(b64Input, prompt, label, variationIndex, attempt + 1);
      }
      return { error: "no_image", details: outputSummary };
    }
    console.log(`${tag} ✓ Image received (attempt ${attempt})`);
    return { b64: polishedB64 };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === "AbortError";
    const errType = isTimeout ? "TIMEOUT" : "NETWORK";
    console.error(`${tag} ${errType}: ${err.message}`);
    if (attempt <= POLISH_MAX_RETRIES) {
      const delay = isTimeout ? POLISH_RETRY_DELAY_MS * 2 : POLISH_RETRY_DELAY_MS;
      console.log(`${tag} Retrying in ${delay}ms after ${errType}...`);
      await new Promise(r => setTimeout(r, delay));
      return callPolishAPI(b64Input, prompt, label, variationIndex, attempt + 1);
    }
    return { error: errType, details: err.message };
  }
}

/**
 * v72.34: Resize image buffer to max dimension while preserving aspect ratio
 * Returns { buf: Buffer, w: number, h: number }
 */
async function resizeForPolish(pngBuf, maxDim) {
  const img = await loadImage(pngBuf);
  const w = img.width, h = img.height;
  if (w <= maxDim && h <= maxDim) return { buf: pngBuf, w, h };
  const scale = maxDim / Math.max(w, h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const c = createCanvas(nw, nh);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, nw, nh);
  console.log(`[POLISH-RESIZE] ${w}×${h} → ${nw}×${nh} (scale=${scale.toFixed(3)})`);
  return { buf: c.toBuffer("image/png"), w: nw, h: nh };
}

app.get("/health", (req, res) => res.json({ ok: true, engine: "browserless-mapbox-gl-3d", version: "72.50-SUPERVISOR" }));
// ─── DIAGNOSTIC MASSING : trace complète du calcul de polygone bâti ─────────
app.post("/diag-massing", async (req, res) => {
  try {
    const { polygon_points, site_area, setback_front = 3, setback_side = 3, setback_back = 3,
      fp_m2 = 1147, envelope_w = 24, envelope_d = 24, front_edge } = req.body;
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
    // v70: front_edge en paramètre = override, sinon détection OSM
    const frontEdgeIndex = (front_edge !== undefined && front_edge !== null && front_edge !== "")
      ? (console.log(`│ FRONT-EDGE: override depuis body → arête ${front_edge}`), Number(front_edge))
      : await findNearestRoadEdge(coords, cLat, cLon);
    // Enveloppe
    const envelopeCoords = computeEnvelope(coords, cLat, cLon, Number(setback_front), Number(setback_side), Number(setback_back), frontEdgeIndex);
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
// ── v69.0: Détection route — Overpass (2 miroirs) + Nominatim fallback ──
// ══════════════════════════════════════════════════════════════════════════════
// v70.3 ROAD DETECTION — MAPBOX TILEQUERY (fiable, pas d'OSM)
// ══════════════════════════════════════════════════════════════════════════════
// Stratégie : on lance des requêtes Tilequery depuis le midpoint EXTÉRIEUR
// de chaque arête de la parcelle. L'arête dont le midpoint extérieur est le
// plus proche d'une route de haut rang = le front.
//
// Pourquoi midpoint EXTÉRIEUR ? Parce que le midpoint d'une arête est SUR la
// parcelle. Si on tire un peu vers l'extérieur (5m dans la direction de la
// normale sortante), on tombe sur la route si elle est vraiment devant.
// ══════════════════════════════════════════════════════════════════════════════
const ROAD_CLASS_WEIGHT = {
  motorway: 6, trunk: 6, primary: 5, secondary: 4, tertiary: 3,
  street: 2, residential: 2, service: 1, path: 0, pedestrian: 0, track: 0,
};
async function findNearestRoadEdge(coords, cLat, cLon) {
  // ── MÉTHODE 1: Mapbox Tilequery — requête multi-points le long des arêtes ──
  const mapboxResult = await tryMapboxTilequery(coords, cLat, cLon);
  if (mapboxResult !== null) return mapboxResult;
  // ── MÉTHODE 2: Nominatim reverse (fallback léger) ──
  const nominatimResult = await tryNominatim(coords, cLat, cLon);
  if (nominatimResult !== null) return nominatimResult;
  console.warn("│ ROAD-DETECT: Mapbox ET Nominatim ont échoué, fallback premier segment");
  return null;
}
async function tryMapboxTilequery(coords, cLat, cLon) {
  if (!MAPBOX_TOKEN) {
    console.warn("│ MAPBOX-TQ: pas de token, skip");
    return null;
  }
  try {
    const n = coords.length;
    console.log(`│ MAPBOX-TQ: analyse ${n} arêtes via Tilequery...`);
    // Pour chaque arête : calculer un point-sonde 8m à l'extérieur du midpoint
    // (dans la direction de la normale sortante)
    const probeResults = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const midLat = (coords[i].lat + coords[j].lat) / 2;
      const midLon = (coords[i].lon + coords[j].lon) / 2;
      // Normale sortante (perpendiculaire à l'arête, vers l'extérieur)
      const edgeDx = (coords[j].lon - coords[i].lon) * Math.cos(midLat * Math.PI / 180);
      const edgeDy = coords[j].lat - coords[i].lat;
      const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
      if (edgeLen < 1e-10) continue;
      // Perpendiculaire (rotation +90° = vers la droite quand on parcourt l'arête)
      let nx = edgeDy / edgeLen;
      let ny = -edgeDx / edgeLen;
      // Vérifier que la normale pointe vers l'extérieur (loin du centroïde)
      const toCenterDx = (cLon - midLon) * Math.cos(midLat * Math.PI / 180);
      const toCenterDy = cLat - midLat;
      if (nx * toCenterDx + ny * toCenterDy > 0) {
        nx = -nx; ny = -ny; // inverser si pointe vers le centre
      }
      // Point-sonde à ~8m à l'extérieur
      const probeOffsetDeg = 8 / 111000; // ~8m en degrés
      const probeLat = midLat + ny * probeOffsetDeg;
      const probeLon = midLon + nx * probeOffsetDeg / Math.cos(midLat * Math.PI / 180);
      probeResults.push({ edgeIdx: i, probeLat, probeLon, midLat, midLon });
    }
    // Lancer les requêtes Tilequery en parallèle (max 4 arêtes, on les fait toutes)
    const tqPromises = probeResults.map(async (probe) => {
      const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${probe.probeLon},${probe.probeLat}.json?radius=50&limit=10&layers=road&access_token=${MAPBOX_TOKEN}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) return { ...probe, roads: [], error: `HTTP ${resp.status}` };
        const data = await resp.json();
        const features = (data.features || []).filter(f =>
          f.properties && f.properties.class && ROAD_CLASS_WEIGHT[f.properties.class] > 0
        );
        return { ...probe, roads: features, error: null };
      } catch (e) {
        clearTimeout(timer);
        return { ...probe, roads: [], error: e.name === "AbortError" ? "TIMEOUT" : e.message };
      }
    });
    const results = await Promise.all(tqPromises);
    // ══════════════════════════════════════════════════════════════════
    // v70.6 SCORING — 2 passes :
    //   Pass 1 : routes à 4-50m (distance normale d'accès)
    //   Pass 2 : si rien en pass 1, accepter < 4m (ruelle)
    //
    // Pourquoi ? Les routes à < 4m du bord de parcelle sont souvent
    // des ruelles/passages mitoyens, PAS la route principale d'accès.
    // La vraie route d'accès est typiquement à 5-20m (largeur de la
    // rue + trottoir + retrait clôture).
    // ══════════════════════════════════════════════════════════════════
    const MIN_ROAD_DIST = 4; // mètres — en dessous = ruelle/mur mitoyen
    // Collecter les scores pour chaque arête
    const edgeScores = [];
    for (const r of results) {
      if (r.error) {
        console.log(`│ MAPBOX-TQ: arête ${r.edgeIdx} → ERREUR ${r.error}`);
        edgeScores.push({ idx: r.edgeIdx, scoreNormal: 0, scoreAll: 0, bestClass: "?", bestDist: 999, bestDistAll: 999 });
        continue;
      }
      if (r.roads.length === 0) {
        console.log(`│ MAPBOX-TQ: arête ${r.edgeIdx} → aucune route dans 50m`);
        edgeScores.push({ idx: r.edgeIdx, scoreNormal: 0, scoreAll: 0, bestClass: "?", bestDist: 999, bestDistAll: 999 });
        continue;
      }
      let scoreNormal = 0, scoreAll = 0;
      let bestClassNormal = "?", bestDistNormal = 999;
      let bestClassAll = "?", bestDistAll = 999;
      for (const feat of r.roads) {
        const cls = feat.properties.class || "service";
        const weight = ROAD_CLASS_WEIGHT[cls] || 1;
        const dist = feat.properties.tilequery?.distance || 50;
        const sc = weight * 100 / Math.max(1, dist);
        // Score ALL (incluant ruelles)
        if (sc > scoreAll) { scoreAll = sc; bestClassAll = cls; bestDistAll = dist; }
        // Score NORMAL (exclut ruelles < 4m)
        if (dist >= MIN_ROAD_DIST && sc > scoreNormal) { scoreNormal = sc; bestClassNormal = cls; bestDistNormal = dist; }
      }
      const bestClass = scoreNormal > 0 ? bestClassNormal : bestClassAll;
      const bestDist = scoreNormal > 0 ? bestDistNormal : bestDistAll;
      console.log(`│ MAPBOX-TQ: arête ${r.edgeIdx} → ${r.roads.length} routes, best=${bestClass} à ${bestDist.toFixed(1)}m (score_normal=${scoreNormal.toFixed(1)} score_all=${scoreAll.toFixed(1)}${bestDistAll < MIN_ROAD_DIST ? " ⚠ruelle@" + bestDistAll.toFixed(1) + "m" : ""})`);
      edgeScores.push({ idx: r.edgeIdx, scoreNormal, scoreAll, bestClass, bestDist: bestDistNormal, bestDistAll });
    }
    // Pass 1 : chercher la meilleure arête avec des routes à distance normale (≥4m)
    let bestEdge = -1, bestScore = -Infinity;
    for (const es of edgeScores) {
      if (es.scoreNormal > bestScore) { bestScore = es.scoreNormal; bestEdge = es.idx; }
    }
    if (bestEdge >= 0 && bestScore > 0) {
      // v70.8: Convention utilisateur — si l'arête 0 a un score proche du meilleur (≥70%),
      // préférer arête 0 car l'utilisateur trace le polygone en commençant côté route.
      const edge0Score = edgeScores.find(es => es.idx === 0)?.scoreNormal || 0;
      if (bestEdge !== 0 && edge0Score > 0 && edge0Score >= bestScore * 0.70) {
        console.log(`│ MAPBOX-TQ: arête 0 (score=${edge0Score.toFixed(1)}) proche de arête ${bestEdge} (score=${bestScore.toFixed(1)}) → PRÉFÉRENCE arête 0 (convention polygone)`);
        bestEdge = 0;
        bestScore = edge0Score;
      }
      console.log(`│ MAPBOX-TQ: ✓ front = arête ${bestEdge} (score_normal=${bestScore.toFixed(1)}) — route d'accès principale`);
      return bestEdge;
    }
    // Pass 2 : fallback — accepter les ruelles (< 4m), avec même préférence arête 0
    bestEdge = -1; bestScore = -Infinity;
    for (const es of edgeScores) {
      if (es.scoreAll > bestScore) { bestScore = es.scoreAll; bestEdge = es.idx; }
    }
    if (bestEdge >= 0) {
      const edge0ScoreAll = edgeScores.find(es => es.idx === 0)?.scoreAll || 0;
      if (bestEdge !== 0 && edge0ScoreAll > 0 && edge0ScoreAll >= bestScore * 0.70) {
        console.log(`│ MAPBOX-TQ: arête 0 (all=${edge0ScoreAll.toFixed(1)}) proche → PRÉFÉRENCE arête 0`);
        bestEdge = 0;
      }
      console.log(`│ MAPBOX-TQ: ✓ front = arête ${bestEdge} (score_all=${bestScore.toFixed(1)}) — fallback ruelle`);
      return bestEdge;
    }
    console.warn("│ MAPBOX-TQ: aucune route trouvée pour aucune arête");
    return null;
  } catch (err) {
    console.warn(`│ MAPBOX-TQ: erreur globale ${err.message}`);
    return null;
  }
}
async function tryNominatim(coords, cLat, cLon) {
  try {
    console.log("│ NOMINATIM: tentative reverse geocoding (fallback)...");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${cLat}&lon=${cLon}&zoom=17&addressdetails=0`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "BARLO-RealEstate/1.0 (diagnostic tool)" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) { console.warn(`│ NOMINATIM: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    if (!data || !data.lat || !data.lon) { console.warn("│ NOMINATIM: pas de coordonnées"); return null; }
    const roadLat = parseFloat(data.lat);
    const roadLon = parseFloat(data.lon);
    const roadName = data.display_name || "?";
    console.log(`│ NOMINATIM: route → "${roadName.substring(0, 60)}" à (${roadLat.toFixed(6)}, ${roadLon.toFixed(6)})`);
    let bestEdge = 0, bestDist = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const j = (i + 1) % coords.length;
      const d = distPointToSegment(roadLat, roadLon, coords[i].lat, coords[i].lon, coords[j].lat, coords[j].lon);
      console.log(`│ NOMINATIM: arête ${i} → dist=${d.toFixed(1)}m`);
      if (d < bestDist) { bestDist = d; bestEdge = i; }
    }
    console.log(`│ NOMINATIM: ✓ front = arête ${bestEdge} (à ${bestDist.toFixed(1)}m)`);
    return bestEdge;
  } catch (err) {
    console.warn(`│ NOMINATIM: ${err.name === "AbortError" ? "TIMEOUT 4s" : err.message}`);
    return null;
  }
}
function distPointToSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
  // Distance approximative (mètres) d'un point à un segment en coordonnées GPS
  const R = 6371000;
  const toRad = Math.PI / 180;
  const px = (pLon - aLon) * toRad * R * Math.cos(aLat * toRad);
  const py = (pLat - aLat) * toRad * R;
  const ax = 0, ay = 0;
  const bx = (bLon - aLon) * toRad * R * Math.cos(aLat * toRad);
  const by = (bLat - aLat) * toRad * R;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const closestX = ax + t * dx, closestY = ay + t * dy;
  const ddx = px - closestX, ddy = py - closestY;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}
function computeAccessPoint(coords, cLat, cLon, frontEdgeIndex) {
  // v70: Utiliser le frontEdgeIndex déjà calculé (plus de double appel OSM)
  let bestI = 0;
  if (frontEdgeIndex !== null && frontEdgeIndex !== undefined) {
    bestI = frontEdgeIndex;
  } else {
    bestI = 0;
    console.log("│ AccessPoint fallback: premier segment du polygone");
  }
  const j = (bestI + 1) % coords.length;
  const midLat = (coords[bestI].lat + coords[j].lat) / 2;
  const midLon = (coords[bestI].lon + coords[j].lon) / 2;
  const edgeBrng = brng(coords[bestI], coords[j]);
  const outBrng = (edgeBrng + 90) % 360;
  console.log(`│ AccessPoint: edge=${bestI} midLat=${midLat.toFixed(6)} bearing=${outBrng.toFixed(0)}°`);
  return { lat: midLat, lon: midLon, bearing: outBrng };
}
function computeEnvelope(coords, cLat, cLon, front, side, back, frontEdgeIndex) {
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
  // v69.1: Assignation directe des setbacks par INDEX d'arête (plus de bearing)
  // front = arête frontEdgeIndex, back = opposée, sides = adjacentes
  function getSetbackForEdge(edgeIdx) {
    if (frontEdgeIndex !== undefined && frontEdgeIndex !== null && frontEdgeIndex < n) {
      const diff = ((edgeIdx - frontEdgeIndex) % n + n) % n;
      if (diff === 0) return front;                    // arête front (face route)
      if (n === 4 && diff === 2) return back;          // arête opposée (fond)
      if (n === 4 && (diff === 1 || diff === 3)) return side; // arêtes latérales
      // Pour polygones > 4 côtés: front, back (opposé), reste = side
      if (diff === Math.floor(n / 2)) return back;
      return side;
    }
    // Fallback sans frontEdgeIndex: bearing-based (ancien comportement)
    return null;
  }
  // Fallback bearing si pas de frontEdgeIndex
  let rb = 0;
  if (frontEdgeIndex === undefined || frontEdgeIndex === null || frontEdgeIndex >= n) {
    let maxLat = -Infinity;
    for (let i = 0; i < n - 1; i++) {
      const ml = (coords[i].lat + coords[(i + 1) % n].lat) / 2;
      if (ml > maxLat) { maxLat = ml; rb = brng(coords[i], coords[(i + 1) % n]); }
    }
    console.log(`│ Envelope front: maxLat fallback bearing=${rb.toFixed(0)}°`);
  }
  function setSB(edgeIdx) {
    const direct = getSetbackForEdge(edgeIdx);
    if (direct !== null) return direct;
    // Fallback bearing
    const b = brng(coords[edgeIdx], coords[(edgeIdx + 1) % n]);
    let d = ((b - rb) + 360) % 360; if (d > 180) d = 360 - d;
    return d < 45 ? front : d < 135 ? side : back;
  }
  // Log des setbacks assignés
  for (let i = 0; i < n; i++) {
    const sb = setSB(i);
    const role = sb === front ? "FRONT" : sb === back ? "BACK" : "SIDE";
    console.log(`│ Envelope: arête ${i} → setback=${sb}m (${role})`);
  }
  function offSeg(p1, p2, dist) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.sqrt(dx * dx + dy * dy) + 0.001;
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
  for (let i = 0; i < n; i++) segs.push(offSeg(pts[i], pts[(i + 1) % n], setSB(i)));
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
  const result = envM.map(m => ({
    lat: cLat + m.y / R_EARTH * 180 / Math.PI,
    lon: cLon + m.x / (R_EARTH * Math.cos(cLat * Math.PI / 180)) * 180 / Math.PI,
  }));
  // v70: Log GPS de chaque vertex d'enveloppe pour debug visuel
  result.forEach((p, i) => console.log(`│ Envelope GPS V${i}: ${p.lat.toFixed(6)},${p.lon.toFixed(6)}`));
  // Log des distances parcelle→enveloppe par arête
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const pMidX = (pts[i].x + pts[j].x) / 2, pMidY = (pts[i].y + pts[j].y) / 2;
    const eMidX = (envM[i].x + envM[j].x) / 2, eMidY = (envM[i].y + envM[j].y) / 2;
    const dist = Math.sqrt((pMidX - eMidX) ** 2 + (pMidY - eMidY) ** 2);
    const sb = setSB(i);
    const role = sb === front ? "FRONT" : sb === back ? "BACK" : "SIDE";
    console.log(`│ Envelope edge ${i} (${role}): setback=${sb}m actual_dist=${dist.toFixed(2)}m`);
  }
  return result;
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
// v72.53 — COÛT/m² EXPLICITE par STANDING × RÔLE (A/B/C)
// Valeurs calées sur le marché Cameroun (Douala/Yaoundé)
// A = coût CIBLE du programme (haut de la fourchette du standing)
// B = coût MÉDIAN (milieu de la fourchette)
// C = coût PLANCHER (bas de la fourchette — construction la plus économique)
// Chaque standing a ses propres bornes réelles, pas des % génériques
const COST_PER_M2_BY_ROLE = {
  //                          A (cible)    B (médian)   C (plancher)
  ECONOMIQUE: { A: 250000,  B: 212500,  C: 175000 },  // 175k–250k FCFA/m²
  ECO:        { A: 250000,  B: 212500,  C: 175000 },  // alias ECONOMIQUE
  STANDARD:   { A: 350000,  B: 300000,  C: 250000 },  // 250k–350k FCFA/m²
  HAUT:       { A: 450000,  B: 387500,  C: 325000 },  // 325k–450k FCFA/m²
  PREMIUM:    { A: 550000,  B: 475000,  C: 400000 },  // 400k–550k FCFA/m²
};
// Ajustement optionnel par driver : le driver peut décaler légèrement le coût cible
// RENTABILITE → A plus haut (+5%) car finitions supérieures pour meilleurs loyers
// SECURISATION → A plus bas (-3%) car prudence budgétaire
const COST_DRIVER_ADJUST = {
  MAX_CAPACITE:         0.00,
  RENTABILITE:         +0.05,  // +5% sur A pour qualité locative
  SECURISATION_RISQUE: -0.03,  // -3% prudence
  MIXTE_PROGRAMME:      0.00,
  PHASAGE_FONCIER:     -0.02,  // -2% construction phasée
};
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
  permis_construire: 0.01,         // 1% — permis de construire (Cameroun)
  assurance_dommage_ouvrage: 0.005, // 0.5% — assurance (non obligatoire au Cameroun)
  etudes_techniques: 0.0025,       // 0.25% — études de sol / géotechnique
  divers_imprevus: 0.0025,         // 0.25% — frais démarches permis et administratif
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
  budget_range = 0, budget_range_raw = "", budget_band = "", budget_tension = 0,
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
  // v57.20 : disposition spatiale du programme (SPLIT commerce/logement)
  layout_mode = "SUPERPOSE", // SUPERPOSE (défaut) | SPLIT_AV_AR | SPLIT_LAT | LINEAIRE
  commerce_depth_m = 6,      // profondeur bande commerciale (défaut 6m, classique Afrique)
  retrait_inter_volumes_m = 4, // distance entre les 2 volumes (passage véhicule/piéton)
}) {
  // v56.3 FIX DÉFINITIF: max_fp = CES × site_area UNIQUEMENT.
  // Les envelope_w/d de la Sheet sont souvent FAUX (dérivés de l'aire polygonale
  // ≈24×24 au lieu du vrai bbox ≈49×47), ce qui causait fp_A=342 au lieu de ~1100.
  // La contrainte physique (bâtiment dans l'enveloppe) est gérée par
  // computeMassingPolygon au moment du rendu, avec cross-section + containment check.

  // v72.52: GARDE ANTI-NaN sur envelope_w et envelope_d
  // Si les valeurs sont NaN/0, on déduit depuis envelope_area (polygone) ou site_area
  if (isNaN(envelope_w) || envelope_w <= 0) {
    const fallbackArea = env_area_override || site_area * 0.6;
    envelope_w = Math.round(Math.sqrt(fallbackArea) * 1.1); // slightly wider than square
    console.warn(`[v72.52] ⚠️ envelope_w was NaN/0 → fallback=${envelope_w}m (from area=${fallbackArea}m²)`);
  }
  if (isNaN(envelope_d) || envelope_d <= 0) {
    const fallbackArea = env_area_override || site_area * 0.6;
    envelope_d = Math.round(Math.sqrt(fallbackArea) * 0.9); // slightly narrower
    console.warn(`[v72.52] ⚠️ envelope_d was NaN/0 → fallback=${envelope_d}m (from area=${fallbackArea}m²)`);
  }

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
  // v57.20 FIX : recalcul automatique de budget_band
  // Ne plus dépendre de la formule Google Sheets (écrasée par les Update Row)
  // Stratégie multi-sources : texte brut OU nombre OU extraction chiffres
  const rawBudget = String(budget_range_raw || budget_range || "");
  // Extraire le montant max depuis n'importe quel format texte
  // "500 000 € – 1 M €" → detecte "1 M" → 1000000
  // "328–656 M FCFA" → detecte "656 M" → 656000000 (FCFA)
  // "500000" → 500000
  let detectedMaxEUR = 0;
  let detectedMaxFCFA = 0;
  // v57.21: Cherche FCFA d'abord (prioritaire car c'est la devise locale)
  // "328–656 M FCFA" → 656000000 FCFA | "200 000 000 FCFA" → 200000000
  const fcfaMMatch = rawBudget.match(/(\d[\d\s.,]*)\s*M\s*FCFA/i);
  if (fcfaMMatch) {
    detectedMaxFCFA = parseFloat(fcfaMMatch[1].replace(/[\s,]/g, '').replace(',', '.')) * 1000000;
    // Si format "X–Y M FCFA", prendre le Y (dernier nombre avant M FCFA)
    const allFcfaM = [...rawBudget.matchAll(/(\d[\d\s.,]*)\s*M\s*FCFA/gi)];
    if (allFcfaM.length > 0) {
      detectedMaxFCFA = Math.max(...allFcfaM.map(m => parseFloat(m[1].replace(/[\s,]/g, '').replace(',', '.')) * 1000000));
    }
  }
  if (!detectedMaxFCFA) {
    const fcfaPlain = rawBudget.match(/(\d[\d\s]*)\s*FCFA/i);
    if (fcfaPlain) detectedMaxFCFA = Number(fcfaPlain[1].replace(/\s/g, ''));
  }
  // Cherche "X M €" ou "X M" (millions EUR, excluant FCFA)
  const mMatch = rawBudget.match(/(\d[\d\s.,]*)\s*M\s*€/i) || rawBudget.match(/(\d[\d\s.,]*)\s*M(?!\s*FCFA)/i);
  if (mMatch) {
    detectedMaxEUR = parseFloat(mMatch[1].replace(/[\s,]/g, '').replace(',', '.')) * 1000000;
  }
  // Cherche "X 000 €" (milliers EUR)
  if (!detectedMaxEUR) {
    const kMatch = rawBudget.match(/(\d[\d\s]*000)\s*€/);
    if (kMatch) detectedMaxEUR = Number(kMatch[1].replace(/\s/g, ''));
  }
  // Fallback : budget_range numérique
  if (!detectedMaxEUR && !detectedMaxFCFA && budget_range > 0) detectedMaxEUR = budget_range;
  console.log(`│ v57.21 budget parse: raw="${rawBudget.substring(0,80)}" → EUR=${detectedMaxEUR} FCFA=${detectedMaxFCFA}`);
  if (!budget_band || String(budget_band).toUpperCase() === "LOW_BUDGET") {
    const oldBand = budget_band;
    if (detectedMaxEUR >= 800000) {
      budget_band = "HIGH_BUDGET";
    } else if (detectedMaxEUR >= 300000) {
      budget_band = "MEDIUM_BUDGET";
    }
    // sinon reste LOW_BUDGET (légitime pour < 300k€)
    console.log(`│ ⚠️ v57.20: budget_band ${oldBand} → ${budget_band} (détecté ${detectedMaxEUR}€ depuis "${rawBudget.substring(0, 60)}")`);
  }
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
  console.log(`┌── SCENARIO ENGINE v57.20 (PROGRAMME-DRIVEN${isProgramDriven ? "" : " → FALLBACK REGULATION"}) ──`);
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
  // v57.21 FIX: budget_range arrive souvent en texte ("500 000 € – 1 M €")
  // → Number() retourne NaN → budgetMax reste 0 → budget_fit = "N/A" systématique.
  // Solution : utiliser detectedMaxEUR (parsé ligne 1111-1123) avec conversion EUR→FCFA.
  let budgetMax = 0;
  if (typeof budget_range === 'string' && budget_range.includes('-')) {
    budgetMax = Number(budget_range.split('-')[1]) || 0;
  } else {
    budgetMax = Number(budget_range) || 0;
  }
  // v57.21: fallback sur detectedMaxFCFA ou detectedMaxEUR si budgetMax reste 0
  if (budgetMax === 0 && (detectedMaxFCFA > 0 || detectedMaxEUR > 0)) {
    const EUR_TO_FCFA = 656;
    if (detectedMaxFCFA > 0) {
      // Budget déjà en FCFA → utiliser directement
      budgetMax = Math.round(detectedMaxFCFA);
    } else if (detectedMaxEUR > 0) {
      // Budget en EUR → convertir en FCFA
      if (detectedMaxEUR < 50000000) {
        // Valeurs < 50M → probablement EUR (budget immo camerounais rarement < 50M FCFA)
        budgetMax = Math.round(detectedMaxEUR * EUR_TO_FCFA);
      } else {
        budgetMax = Math.round(detectedMaxEUR);
      }
    }
    console.log(`│ v57.21 FIX budget_fit: budgetMax était 0 → recalculé depuis ${detectedMaxFCFA > 0 ? 'FCFA=' + detectedMaxFCFA : 'EUR=' + detectedMaxEUR} → budgetMax=${budgetMax} FCFA`);
  }
  for (const label of ["A", "B", "C"]) {
    const role = SCENARIO_ROLE[label];
    const mode = SCENARIO_MASSING_MODE[label];
    let fp, fpRdc, fpEtages, levels, unitMixDetail, totalUseful, circRatio, bodyDepth, maxPerFloor, groundReserve;
    let unitMix = {};
    let totalUnitsResult = 0;
    let hasPilotis = false;
    let pilotisLevels = 0;
    // v57.20 SPLIT : volumes séparés (commerce + logement)
    let splitLayout = null; // sera rempli si layout_mode === "SPLIT_AV_AR"
    let target_sdp_programme = 0; // ancre client : target_units × refSize / (1-circ)
    // v72.53 TYPOLOGY — déclaré ici pour être accessible dans TOUS les chemins (CES-driven ou legacy)
    let preTypology = "BLOC";
    let typoImpact = TYPOLOGY_IMPACT.BLOC;
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
      // ══════════════════════════════════════════════════════════════════════
      // v72.53: TYPOLOGY IMPACT — la forme du bâtiment modifie les calculs
      // Pré-sélection de la typology AVANT les calculs de SDP/coûts
      // ══════════════════════════════════════════════════════════════════════
      const envAspectCalc = envelope_w / Math.max(1, envelope_d);
      const fillRatioCalc = (ces * site_area * (CES_FILL_BY_ROLE[role] || 0.80)) / Math.max(1, envelope_area);
      preTypology = preSelectTypology({
        fp_m2: ces * site_area * (CES_FILL_BY_ROLE[role] || 0.80),
        envelope_area, site_area, envAspect: envAspectCalc,
        massing_mode: SCENARIO_MASSING_MODE[label] || "BALANCED",
        scenario_role: role, standing_level, program_main, isMixte, fillRatio: fillRatioCalc,
      });
      typoImpact = TYPOLOGY_IMPACT[preTypology] || TYPOLOGY_IMPACT.BLOC;
      // Appliquer les modifiers typologiques
      circRatio = Math.max(0.08, Math.min(0.35, circRatio + typoImpact.circ_modifier));
      bodyDepth = Math.round(bodyDepth * typoImpact.body_depth_mult);
      console.log(`│   🏛️ v72.53 TYPOLOGY: ${preTypology} → circ+${(typoImpact.circ_modifier*100).toFixed(0)}%=${(circRatio*100).toFixed(0)}%, body×${typoImpact.body_depth_mult}=${bodyDepth}m, coût×${typoImpact.cost_mult}`);
      console.log(`│     ${typoImpact.description}`);
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
      // v72.51: garde anti-NaN sur le CES client
      const _safeClientCesMod = (isNaN(clientCesMod) || clientCesMod <= 0) ? 0.80 : clientCesMod;
      const effectiveCES = Math.max(ces * 0.40, Math.min(ces * 1.05,
        ces * _safeClientCesMod
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
      const parkingPerUnitEst = (rules && rules.parking_per_unit) || 1;
      const roleTargetFactorEst = ({ INTENSIFICATION: 1.05, EQUILIBRE: 0.70, PRUDENT: 0.45 })[role] || 0.70;
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
      // ══════════════════════════════════════════════════════════════════
      // v72.33: PLATEAU ADAPTATIF — dimensionné par le PROGRAMME CLIENT
      // ══════════════════════════════════════════════════════════════════
      // AVANT: fpProgramme = maxPerFloor × refUnitSize → plateau fixe 475m²
      //   → ignorait target_units, surdimensionnait toujours le plateau
      // MAINTENANT: fpProgramme = unitsPerFloor_réel × avgSize_adaptatif
      //   → dimensionné par le programme du client
      //   → tailles d'appartement FLEXIBLES (compression 10-15% si parcelle contrainte)
      //   → si même compressé ça ne rentre pas → réduire unités/palier (monter en hauteur)
      // ══════════════════════════════════════════════════════════════════
      const refUnitSize = sizes.T3 || sizes.T4 || 80;
      // v72.33: TAILLE UNITAIRE = DONNÉE CLIENT × RATIO SCÉNARIO
      // ─────────────────────────────────────────────────────────────
      // Le nombre d'unités (target_units) est SACRÉ — identique pour A, B, C.
      // La DIFFÉRENCIATION vient des TAILLES d'appartement :
      //   A = taille généreuse (UNIT_SIZES.A) — le programme du client tel quel
      //   B = taille standard (UNIT_SIZES.B) — ~15-20% plus compact
      //   C = taille compacte (UNIT_SIZES.C) — ~25-30% plus compact
      // Cela produit naturellement : A → plus grand plateau → plus de SDP
      //                               C → plateau réduit → moins de SDP
      // ─────────────────────────────────────────────────────────────
      // Ratio de taille du scénario vs le scénario A (référence client)
      const allLabelSizes = (UNIT_SIZES[sizeKey] || UNIT_SIZES.STANDARD);
      const refT3_A = (allLabelSizes.A && allLabelSizes.A.T3) || 95;
      const refT3_label = (allLabelSizes[label] && allLabelSizes[label].T3) || refT3_A;
      const sizeRatio = refT3_label / refT3_A; // A=1.00, B≈0.84, C≈0.74
      // Taille de base : depuis le formulaire client OU estimation mix
      const clientAvgSizeRaw = (Number(target_surface_m2) > 0 && target_units > 0)
        ? Math.round(Number(target_surface_m2) / target_units)
        : null;
      // Appliquer le ratio scénario : le client donne la taille "A", B et C s'adaptent
      const avgResSize = clientAvgSizeRaw
        ? Math.round(clientAvgSizeRaw * sizeRatio)
        : computeAvgResidentialSize(sizes, rules, target_units); // déjà label-specific
      console.log(`│   📋 v72.33 TAILLES: ${clientAvgSizeRaw ? `client=${clientAvgSizeRaw}m²` : `estimé=${Math.round(avgResSize/sizeRatio)}m²`} × ratio_${label}=${sizeRatio.toFixed(2)} → avgResSize=${avgResSize}m²/appt`);
      // ══════════════════════════════════════════════════════════════════
      // v72.33: PLATEAU ADAPTATIF — ORDRE DE PRIORITÉ :
      //   1. NOMBRE D'APPARTEMENTS (target_units) = INPUT CLIENT, SACRÉ
      //   2. COMBIEN RENTRENT PAR NIVEAU = déterminé par la parcelle
      //   3. NOMBRE DE NIVEAUX = CONSÉQUENCE (target_units / u_par_niveau)
      //
      // La parcelle dicte la capacité du plateau (pas l'inverse).
      // Les tailles d'appartement s'adaptent : compression 10-15% max
      // si la parcelle est contrainte, pour maximiser les unités/palier.
      // ══════════════════════════════════════════════════════════════════
      const MAX_COMPRESSION = 0.85; // tailles réduites de 15% max
      const clientUnits = Math.max(1, target_units || 1);
      // ÉTAPE 1 : Capacité max du plateau (le terrain dicte)
      const fpMaxParcel = Math.min(fpMaxCes, fpMaxEnv, fpMaxRetraits);
      const usefulPerFloor = fpMaxParcel * (1 - circRatio); // surface utile par palier
      // ÉTAPE 2 : Combien d'appartements RENTRENT par palier ?
      // D'abord essayer avec les tailles STANDARD (100%)
      let unitsPerFloorStd = Math.floor(usefulPerFloor / avgResSize);
      // Puis avec les tailles COMPRESSÉES (85%) — 15% plus petit
      const compressedSize = Math.round(avgResSize * MAX_COMPRESSION);
      let unitsPerFloorCompressed = Math.floor(usefulPerFloor / compressedSize);
      // Cap au max programme (pas plus que maxPerFloor)
      unitsPerFloorStd = Math.min(unitsPerFloorStd, maxPerFloor);
      unitsPerFloorCompressed = Math.min(unitsPerFloorCompressed, maxPerFloor);
      // Choisir : si la compression permet +1 unité/palier, ça vaut le coup
      let adaptiveUnitsPerFloor, unitCompression;
      if (unitsPerFloorStd >= 1 && unitsPerFloorStd >= unitsPerFloorCompressed) {
        // Les tailles standard suffisent — pas de compression nécessaire
        adaptiveUnitsPerFloor = unitsPerFloorStd;
        unitCompression = 1.0;
      } else if (unitsPerFloorCompressed > unitsPerFloorStd) {
        // La compression permet de caser +1 unité — ça vaut le coup
        adaptiveUnitsPerFloor = unitsPerFloorCompressed;
        // Compression juste nécessaire pour caser N unités (pas forcément 15%)
        unitCompression = Math.max(MAX_COMPRESSION, usefulPerFloor / (adaptiveUnitsPerFloor * avgResSize));
      } else if (unitsPerFloorStd < 1) {
        // Même 1 appartement standard ne rentre pas → compresser pour 1
        adaptiveUnitsPerFloor = 1;
        const minSizeForOne = usefulPerFloor; // tout l'espace utile pour 1 appart
        unitCompression = Math.max(MAX_COMPRESSION, minSizeForOne / avgResSize);
      } else {
        adaptiveUnitsPerFloor = Math.max(1, unitsPerFloorStd);
        unitCompression = 1.0;
      }
      // Taille effective par appartement
      const effectiveUnitSize = Math.round(avgResSize * unitCompression);
      // ÉTAPE 3 : Nombre de niveaux = CONSÉQUENCE
      const levelsFromProgram = Math.max(1, Math.ceil(clientUnits / Math.max(1, adaptiveUnitsPerFloor)));
      // fpProgramme = dimensionné pour les unités qui rentrent réellement
      // v72.51: garde anti-NaN — si un facteur est invalide, fallback sur valeurs sûres
      const _safeAdaptive = isNaN(adaptiveUnitsPerFloor) ? 1 : adaptiveUnitsPerFloor;
      const _safeEffSize = isNaN(effectiveUnitSize) ? (sizes.T3 || 80) : effectiveUnitSize;
      const _safeCirc = (isNaN(circRatio) || circRatio >= 1) ? 0.20 : circRatio;
      const fpProgramme = Math.round(_safeAdaptive * _safeEffSize / (1 - _safeCirc));
      // Plancher : minimum 1 appartement compressé
      const fpMinViable = Math.round(Math.max(100, 1 * compressedSize / (1 - circRatio)));
      console.log(`│   🏠 v72.33 PLATEAU ADAPTATIF (parcelle → unités → niveaux):`);
      console.log(`│     1. PROGRAMME CLIENT: ${clientUnits} appartements demandés`);
      console.log(`│     2. PARCELLE: fpMaxParcel=${fpMaxParcel}m² → utile=${Math.round(usefulPerFloor)}m²/palier`);
      console.log(`│        avgResSize=${avgResSize}m² → standard: ${unitsPerFloorStd}u/palier | compressé(${Math.round(MAX_COMPRESSION*100)}%): ${unitsPerFloorCompressed}u/palier`);
      console.log(`│        → CHOIX: ${adaptiveUnitsPerFloor}u/palier × ${effectiveUnitSize}m²/appt (compression=${(unitCompression*100).toFixed(0)}%)`);
      console.log(`│     3. NIVEAUX = ${clientUnits}u / ${adaptiveUnitsPerFloor}u = ${levelsFromProgram} niveaux nécessaires`);
      console.log(`│     fpProgramme=${fpProgramme}m² fpMinViable=${fpMinViable}m²`);
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
      // ══════════════════════════════════════════════════════════════════
      // v57.20 FIX : DIFFÉRENCIATION EMPRISE PAR SCÉNARIO
      // ══════════════════════════════════════════════════════════════════
      // Avant : fpRdc = fpProgramme (identique pour A, B, C)
      // → quand fpProgramme < tous les plafonds, les 3 scénarios sont identiques.
      //
      // ══════════════════════════════════════════════════════════════════
      // v72.53 PHILOSOPHIE DES 3 SCÉNARIOS :
      //   A = EXACTEMENT LA DEMANDE DU CLIENT
      //       → fpProgramme × 1.00 = programme complet, tailles généreuses
      //       → Ni plus, ni moins que ce que le client a demandé
      //   B = ALTERNATIVE ÉQUILIBRÉE
      //       → fpProgramme × 0.85 = même programme, surfaces/coûts moindres
      //       → Tailles d'unités réduites (~15%), budget plus accessible
      //   C = PRUDENT — IMPLANTATION DIFFÉRENTE + COMPACTE SI OPTIMAL
      //       → fpProgramme × 0.70 = emprise compacte, volume unique SUPERPOSÉ
      //       → Possibilité d'une implantation alternative (ex: SUPERPOSÉ au lieu de SPLIT)
      //       → Coûts minimisés, programme livré en version économique
      // Le terrain plafonne toujours (CES, enveloppe, retraits).
      // ══════════════════════════════════════════════════════════════════
      const ROLE_FP_FACTOR = { INTENSIFICATION: 1.00, EQUILIBRE: 0.85, PRUDENT: 0.70 };
      const roleFpFactor = ROLE_FP_FACTOR[role] || 1.0;
      // ══════════════════════════════════════════════════════════════════
      // v57.20 SPLIT_AV_AR : COMMERCE DEVANT (clôture) + LOGEMENT DERRIÈRE
      // ══════════════════════════════════════════════════════════════════
      // Quand layout_mode = "SPLIT_AV_AR", le programme est éclaté en 2 volumes :
      //   Volume 1 (AVANT) : bande de boutiques contre la clôture, 1 niveau
      //     → largeur = largeur parcelle (envelope_w), profondeur = commerce_depth_m
      //     → collé au retrait avant (ou retrait avant = 0 si clôture)
      //   Volume 2 (ARRIÈRE) : logement en retrait, N niveaux
      //     → profondeur dispo = profondeur parcelle - commerce_depth - retrait_inter
      //     → largeur = largeur parcelle (avec retraits latéraux)
      //     → le client veut le dégagement du terrain derrière
      // Le CES total (vol1 + vol2) reste plafonné par la réglementation.
      // ══════════════════════════════════════════════════════════════════
      // v72.30: INTELLIGENCE DE DISPOSITION PAR RÔLE
      // SPLIT_AV_AR → 2 volumes séparés (commerce devant + logement sur pilotis derrière)
      //   ✅ INTENSIFICATION : SPLIT + pilotis + max étages (maximise la SDP)
      //   ✅ EQUILIBRE : SPLIT + pilotis + étages modérés (compromis espace/densité)
      //   ❌ PRUDENT : SUPERPOSÉ compact (commerce RDC + logement empilé au-dessus)
      //      → Plus économique, plus simple à construire, CES réduit, 1 seul volume
      // Cette logique est STRATÉGIQUE : le PRUDENT choisit la compacité, pas juste moins d'étages.
      const _splitRequested = String(layout_mode).toUpperCase() === "SPLIT_AV_AR" && isMixte;
      let _splitViable = true;
      if (_splitRequested) {
        const _parcD = envelope_d || Math.round(site_area / (envelope_w || 20));
        const _commD = Math.min(Number(commerce_depth_m) || 6, _parcD * 0.30);
        const _gapD = Number(retrait_inter_volumes_m) || 4;
        // v72.63: FIX CRITIQUE — envelope_d est DÉJÀ après retraits (land_depth - rAvant - rArrière)
        // NE PAS re-soustraire rAvant et rArrière, sinon double-comptage → SPLIT toujours "non viable"
        const _logtD = _parcD - _commD - _gapD;
        const _gapDViability = Math.min(_gapD, 2);
        const _logtDRelaxed = _parcD - _commD - _gapDViability;
        _splitViable = _logtDRelaxed >= 5 && _parcD >= 12;
        console.log(`│   v72.63 SPLIT VIABILITY: parcD=${_parcD}m commD=${_commD.toFixed(1)}m gap=${_gapD}m → logtD=${_logtD.toFixed(1)}m (relaxed=${_logtDRelaxed.toFixed(1)}m) → ${_splitViable ? "✅ VIABLE" : "❌ NON VIABLE"}`);
        if (!_splitViable) console.log(`│   ⚠️ SPLIT NON VIABLE: logtDepth=${_logtDRelaxed.toFixed(1)}m (min 5m) parcD=${_parcD}m (min 12m)`);
      }
      // v72.53: RÈGLES SPLIT_AV_AR :
      // - Commerce collé à la LIMITE SÉPARATIVE côté front (ligne de setback avant)
      // - Logement EN RETRAIT sur PILOTIS (habitable à partir de R+1)
      // - Pilotis obligatoire quand : SPLIT_AV_AR OU terrain étroit (< 10m constructible)
      // v72.30: PRUDENT → TOUJOURS SUPERPOSÉ (choix stratégique de compacité)
      const useSplitForRole = _splitRequested && role !== "PRUDENT" && _splitViable;
      if (role === "PRUDENT" && _splitRequested) {
        console.log(`│   🏗️ v72.30 PRUDENT: SPLIT demandé → SUPERPOSÉ COMPACT (choix stratégique: volume unique, commerce RDC + logement dessus)`);
      }
      if (useSplitForRole) {
        const parcDepth = envelope_d || Math.round(site_area / (envelope_w || 20));
        const parcWidth = envelope_w || Math.round(site_area / parcDepth);
        // Volume 1 : COMMERCE (bande avant) — collé à la LIMITE SÉPARATIVE FRONT
        // v72.53: le commerce colle au setback avant (retrait_avant = position du commerce)
        // Pleine largeur : couvre toute la façade côté rue (identique pour A/B)
        const commDepth = Math.min(Number(commerce_depth_m) || 6, parcDepth * 0.30);
        // v72.53: respecter la mitoyenneté (2 mitoyens → pas de retrait latéral)
        const commWidth = Math.round(parcWidth - retraitLatEffectif);
        const fpCommerce = Math.round(commWidth * commDepth);
        const levelsCommerce = 1;
        const sdpCommerce = fpCommerce;
        // ══════════════════════════════════════════════════════════════════
        // v72.53: PROGRAMME-DRIVEN — le mix client donne les unités VOULUES
        // Le nombre d'unités commerce + résidentiel vient du PROGRAMME,
        // pas de la capacité physique de la bande commerciale.
        // ══════════════════════════════════════════════════════════════════
        const estMixSplit = rules.default_mix_fn ? rules.default_mix_fn(clientUnits) : { COMMERCE: 1 };
        const programmeCommerceUnits = estMixSplit.COMMERCE || 1;
        // v72.53: Résidentiel cible = PROGRAMME CLIENT (SACRÉ, identique A/B/C)
        const resiTarget = Math.max(1, clientUnits - programmeCommerceUnits);
        // Volume 2 : LOGEMENT (en retrait sur pilotis) — v72.53 PROGRAMME-DRIVEN
        const interGap = Number(retrait_inter_volumes_m) || 4;
        // v72.63: FIX — parcDepth = envelope_d = DÉJÀ après retraits (rAvant/rArriere exclus)
        // Ne PAS re-soustraire rAvant/rArriere ici
        const logtDepthDispo = Math.round(parcDepth - commDepth - interGap);
        // v72.53: Le RÔLE affecte les dimensions physiques (différenciation architecturale)
        const roleWidthFactor = role === "INTENSIFICATION" ? 1.00 : role === "EQUILIBRE" ? 0.85 : 0.70;
        const roleDepthFactor = role === "INTENSIFICATION" ? 1.00 : role === "EQUILIBRE" ? 0.90 : 0.75;
        const logtWidth = Math.round((parcWidth - retraitLatEffectif) * roleWidthFactor);
        const logtDepthUsed = Math.round(Math.min(logtDepthDispo, bodyDepth * 1.5) * roleDepthFactor);
        const fpLogtRaw = Math.round(logtWidth * logtDepthUsed);
        // ══════════════════════════════════════════════════════════════════
        // v72.53: FLOOR PLATE DIMENSIONNÉE PAR LE PROGRAMME
        // Au lieu de maximiser la surface terrain (fpProgramme = adaptiveUnitsPerFloor),
        // on dimensionne pour le nombre d'unités résidentielles NÉCESSAIRES par étage.
        // ══════════════════════════════════════════════════════════════════
        const maxResiPerFloorSplit = Math.max(1, Math.floor(
          fpLogtRaw * (1 - circRatio) / Math.max(40, effectiveUnitSize)
        ));
        const idealResiPerFloor = Math.min(resiTarget, maxResiPerFloorSplit);
        const fpLogtFromProgramme = Math.round(idealResiPerFloor * effectiveUnitSize / (1 - _safeCirc));
        console.log(`│   v72.53 PROGRAMME-SPLIT: ${clientUnits}u → ${programmeCommerceUnits} commerce + ${resiTarget} rési | max ${maxResiPerFloorSplit}/étage → idéal ${idealResiPerFloor}/étage → fpLogtProg=${fpLogtFromProgramme}m²`);
        // Cap par les contraintes terrain (le terrain PLAFONNE, le programme DIMENSIONNE)
        const fpLogt = Math.min(
          fpLogtRaw,
          fpLogtFromProgramme,
          fpMaxCes - fpCommerce,
          fpMaxRetraits - fpCommerce
        );
        // Plancher viable (au moins 1 logement compressé)
        const splitMinViable = Math.round(Math.max(80, 1 * compressedSize / (1 - _safeCirc)));
        const fpLogtFinal = Math.max(splitMinViable, fpLogt);
        // CES total
        const fpTotal = fpCommerce + fpLogtFinal;
        const cesTotalPct = Math.round(fpTotal / site_area * 100);
        // Boutiques
        // v72.53: Commerce band = pleine largeur (colle à la limite séparative front)
        // Mais le PROGRAMME détermine le nombre d'unités commerciales reportées
        const commerceUnitSize = 30;
        const nbBoutiquesTerrain = Math.max(1, Math.floor(sdpCommerce / commerceUnitSize));
        const nbBoutiques = programmeCommerceUnits; // PROGRAMME, pas terrain
        // v72.53: resiTarget déjà calculé ci-dessus (programme-driven)
        const usefulLogt = Math.round(fpLogtFinal * (1 - circRatio));
        const avgResiSize = refUnitSize;
        const resiPerFloor = Math.max(1, Math.min(maxPerFloor, Math.floor(usefulLogt / avgResiSize)));
        // ══════════════════════════════════════════════════════════════════
        // v72.53: NIVEAUX = CONSÉQUENCE DU PROGRAMME (target_units SACRÉ)
        // A (INTENSIFICATION) = EXACTEMENT la demande client, ni plus ni moins
        //   → Le client demande N logements, on livre N logements au juste dimensionnement
        // B (EQUILIBRE) = même nombre d'unités, tailles légèrement réduites
        //   → Surfaces et coûts moindres, mais programme complet
        // C (PRUDENT) = SUPERPOSÉ compact (géré ailleurs)
        //   → Implantation différente si plus optimal
        // ══════════════════════════════════════════════════════════════════
        let levelsLogt;
        const baseCalc = Math.max(1, Math.ceil(resiTarget / resiPerFloor));
        if (role === "INTENSIFICATION") {
          // A = INTENSIFICATION → pousse 1 niveau de plus que le strict minimum
          // pour maximiser la valeur locative et différencier visuellement de B
          levelsLogt = Math.min(baseCalc + 1, effectiveMaxFloors);
          levelsLogt = Math.max(2, levelsLogt);
        } else if (role === "EQUILIBRE") {
          // B = EQUILIBRE → strict minimum pour le programme (confort modéré)
          levelsLogt = Math.min(baseCalc, effectiveMaxFloors);
          levelsLogt = Math.max(1, levelsLogt);
        } else {
          levelsLogt = 1; // PRUDENT = SUPERPOSÉ
        }
        // Garde-fou COS
        while (levelsLogt > 1 && (sdpCommerce + fpLogtFinal * levelsLogt) > max_sdp) levelsLogt--;
        // v72.60: Garde-fou PROGRAMME — SDP total plafonné par rôle
        // A (INTENSIFICATION) = 1.60× → marge pour le niveau supplémentaire (valeur ajoutée)
        // B (EQUILIBRE) = 1.35× → strict programme, confort modéré
        // C (PRUDENT) = 1.20× → compact
        const sdpCapMultiplier = role === "INTENSIFICATION" ? 1.60 : role === "EQUILIBRE" ? 1.35 : 1.20;
        const sdpCapSplit = Math.round((resiTarget * effectiveUnitSize / (1 - _safeCirc) + sdpCommerce) * sdpCapMultiplier);
        while (levelsLogt > 1 && (sdpCommerce + fpLogtFinal * levelsLogt) > sdpCapSplit) levelsLogt--;
        const totalResiUnits = resiPerFloor * levelsLogt;
        // ══════════════════════════════════════════════════════════════════
        // v72.53: RÈGLE DES PILOTIS — logement habitable à partir de R+1
        // Pilotis OBLIGATOIRE quand :
        //   1. SPLIT_AV_AR : commerce en front + logement en retrait → pilotis
        //   2. Terrain trop étroit : constructibleWidth < 10m → pilotis pour libérer le sol
        // Le RDC du volume logement = pilotis (parking, accès, local technique)
        // Les logements démarrent à R+1 (ventilation, intimité, sécurité)
        // ══════════════════════════════════════════════════════════════════
        const constructibleWidthSplit = parcWidth - retraitLatEffectif;
        const isTerrainEtroit = constructibleWidthSplit < 10;
        hasPilotis = true; // SPLIT = toujours pilotis
        pilotisLevels = 1;
        if (isTerrainEtroit) {
          console.log(`│   ⚡ v72.53 PILOTIS: terrain étroit (${constructibleWidthSplit}m < 10m) → pilotis obligatoire`);
        }
        // Sol libre
        const freeGroundSplit = Math.round(site_area - fpTotal);
        // v72.63: FIX — même correction, parcDepth déjà net de retraits
        const espaceArriere = Math.round(logtDepthDispo > 0 ? logtWidth * Math.max(0, parcDepth - commDepth - interGap - logtDepthUsed) : 0);
        splitLayout = {
          mode: "SPLIT_AV_AR",
          volume_commerce: {
            fp_m2: fpCommerce,
            width_m: commWidth,
            depth_m: Math.round(commDepth),
            levels: levelsCommerce,
            sdp_m2: sdpCommerce,
            units: nbBoutiques,
            position: "AVANT (collé à la limite séparative front, aligné sur ligne de setback)",
          },
          volume_logement: {
            fp_m2: fpLogtFinal,
            width_m: logtWidth,
            depth_m: logtDepthUsed,
            levels: levelsLogt,
            sdp_m2: fpLogtFinal * levelsLogt,
            units: totalResiUnits,
            position: `ARRIÈRE sur pilotis (retrait ${Math.round(commDepth + interGap)}m)`,
            has_pilotis: true,
          },
          retrait_inter_m: interGap,
          espace_arriere_m2: espaceArriere,
          ces_total_pct: cesTotalPct,
        };
        // v72.53: SUPPRESSION du v72.29 DIFF — la différenciation est DÉJÀ faite par :
        //   - roleWidthFactor / roleDepthFactor (dimensions physiques du volume)
        //   - roleFpFactor (cap sur fpProgramme)
        //   - le nombre de niveaux (INTENSIFICATION=3+, EQUILIBRE=2, PRUDENT=SUPERPOSÉ)
        // Appliquer un facteur SUPPLÉMENTAIRE de 0.75/0.50 crée un triple-compounding
        // qui rend B et C absurdement petits (B=36% de A au lieu de ~80%).
        console.log(`│   v72.53 SPLIT: fpLogtFinal=${fpLogtFinal} (role=${role}, pas de double-réduction)`);
        // Valeurs principales = LOGEMENT
        fpRdc = fpLogtFinal;
        fp = fpLogtFinal;
        fpEtages = fpLogtFinal;
        levels = levelsLogt;
        // v72.65: totalUnitsResult plafonné à clientUnits (A = EXACTEMENT la demande)
        const rawTotalUnits = nbBoutiques + totalResiUnits;
        totalUnitsResult = Math.min(rawTotalUnits, clientUnits);
        // Si trop d'unités rési (ex: 3 niveaux × 1/palier = 3 rési + 1 comm = 4 > 3 demandées)
        // → réduire les rési comptées pour coller au programme client
        const resiCountFinal = totalUnitsResult - nbBoutiques;
        // v72.66c: FIX — mettre à jour split_layout.volume_logement.units après le cap
        if (splitLayout && splitLayout.volume_logement) {
          splitLayout.volume_logement.units = resiCountFinal;
        }
        // v72.66: FIX — totalUseful = SDP totale × (1-circ) pour cohérence avec _recalcSdp et garde-fou
        // Avant: sdpCommerce comptait 100% utile (pas de circ), incohérent avec sdp×(1-circ)
        const sdpSplitTotal = sdpCommerce + fpLogtFinal * levelsLogt;
        totalUseful = Math.round(sdpSplitTotal * (1 - circRatio));
        unitMix = { COMMERCE: nbBoutiques };
        // v72.66: FIX — default_mix_fn retourne COMMERCE dans le mix (USAGE_MIXTE),
        // mais en SPLIT le commerce est DÉJÀ géré séparément (vol.1).
        // → On filtre COMMERCE du resiMix pour ne garder que les logements.
        const rawResiMix = rules.default_mix_fn ? rules.default_mix_fn(resiCountFinal) : { T3: resiCountFinal };
        const resiMix = {};
        let resiMixTotal = 0;
        for (const [typ, count] of Object.entries(rawResiMix)) {
          if (typ === "COMMERCE") continue; // v72.66: skip — déjà dans vol.1
          if (count > 0) { resiMix[typ] = count; resiMixTotal += count; }
        }
        // v72.66: si après filtrage il manque des unités (ex: COMMERCE comptait pour 1),
        // redistribuer sur T3 pour coller à resiCountFinal
        if (resiMixTotal < resiCountFinal) {
          resiMix.T3 = (resiMix.T3 || 0) + (resiCountFinal - resiMixTotal);
        }
        for (const [typ, count] of Object.entries(resiMix)) {
          if (count > 0) unitMix[typ] = count;
        }
        // v72.65: unitMixDetail au format PARSABLE "1×COMMERCE(40m²) + 2×T3(72m²)"
        // Ce format est attendu par le regex dans buildTextInjection
        const commerceSizePerUnit = nbBoutiques > 0 ? Math.round(sdpCommerce / nbBoutiques) : 0;
        const splitMixParts = [];
        splitMixParts.push(`${nbBoutiques}×COMMERCE(${commerceSizePerUnit}m²)`);
        for (const [typ, count] of Object.entries(resiMix)) {
          if (count > 0) {
            const unitSize = sizes[typ] || sizes.T3 || 72;
            splitMixParts.push(`${count}×${typ}(${unitSize}m²)`);
          }
        }
        unitMixDetail = splitMixParts.join(" + ");
        console.log(`│   🏪 v72.53 SPLIT_AV_AR ${role} PROGRAMME-DRIVEN:`);
        console.log(`│     VOL.1 COMMERCE: ${commWidth}m×${Math.round(commDepth)}m = ${fpCommerce}m² (${nbBoutiques} prog / ${nbBoutiquesTerrain} possibles) — collé limite séparative front`);
        console.log(`│     GAP: ${interGap}m (passage véhicule/piéton)`);
        console.log(`│     VOL.2 LOGEMENT: ${logtWidth}m×${logtDepthUsed}m = ${fpLogtFinal}m² × ${levelsLogt}niv sur PILOTIS R+1 (${totalResiUnits} logts pour ${resiTarget} cibles)`);
        console.log(`│     CES total: ${cesTotalPct}% | espace arrière: ${espaceArriere}m²`);
        console.log(`│     ${isTerrainEtroit ? '⚡TERRAIN ÉTROIT' : '✓largeur OK'} (${constructibleWidthSplit}m constructible)`);
      } else {
      // ── MODE SUPERPOSÉ (défaut) — v72.53: PROGRAMME-DRIVEN ──
      fpRdc = Math.round(fpProgramme * roleFpFactor);
      // v72.51: garde anti-NaN sur fpRdc
      if (isNaN(fpRdc)) fpRdc = Math.round(Math.min(empriseEffective, envelope_area * 0.60));
      // ══════════════════════════════════════════════════════════════════
      // v72.53: PROGRAMME-DRIVEN CAP — ne pas surdimensionner le plateau
      // fpProgramme est basé sur adaptiveUnitsPerFloor (capacité TERRAIN).
      // Pour un petit programme (ex: 3 unités), le terrain peut en caser 4-6/étage
      // → fpProgramme = 4×72/0.82 = 351m² quand le programme ne demande que 2 rési.
      // CAP: le plateau ne dépasse pas ce dont le PROGRAMME a besoin par étage.
      // ══════════════════════════════════════════════════════════════════
      const estMixSuper = rules.default_mix_fn ? rules.default_mix_fn(clientUnits) : {};
      const commerceUnitsSuper = isMixte ? (estMixSuper.COMMERCE || 1) : 0;
      const resiUnitsSuper = Math.max(1, clientUnits - commerceUnitsSuper);
      // Combien d'unités par étage au maximum (capé par le programme)
      const resiPerFloorProg = Math.min(resiUnitsSuper, _safeAdaptive || 2);
      const fpCapProgramme = Math.round(resiPerFloorProg * _safeEffSize / (1 - _safeCirc));
      fpRdc = Math.min(fpRdc, fpCapProgramme);
      console.log(`│   v72.53 SUPERPOSÉ PROGRAMME-CAP: rési=${resiUnitsSuper}u, perFloor=${resiPerFloorProg}, fpCap=${fpCapProgramme}m² → fpRdc=${fpRdc}m²`);
      // Plafonds réglementaires (le terrain ne peut jamais aller au-delà)
      fpRdc = Math.min(fpRdc, fpMaxCes, fpMaxEnv, fpMaxRetraits);
      fpRdc = Math.max(fpRdc, fpMinViable);
      fpRdc = Math.round(fpRdc);
      if (isNaN(fpRdc)) fpRdc = Math.max(100, Math.round(envelope_area * 0.40)); // ultime fallback
      }
      const cesPctResult = Math.round((splitLayout ? (splitLayout.volume_commerce.fp_m2 + fpRdc) : fpRdc) / site_area * 100);
      const cesVsExpert = expertCesPct > 0 ? (cesPctResult >= expertCesPct ? "≥expert" : "<expert") : "";
      const reserveActive = fpMaxAfterReserves < fpProgramme;
      if (!splitLayout) console.log(`│   🏗️ v57.15 ${role}: fpProg=${fpProgramme} → fpRdc=${fpRdc}m² (CES=${cesPctResult}% ${cesVsExpert}) | cible_sdp=${target_sdp_programme}m²`);
      if (!splitLayout) console.log(`│   🅿️ réserve terrain: ${estParkingSpots} places × 25m² = ${estParkingM2}m² parking | free_ground_min=${Math.round(minFreeGroundForParking)}m² | fpMaxReserve=${fpMaxAfterReserves}m² ${reserveActive ? "⚡CONTRAINT" : "✓ok"}`);
      // ÉTAGES : extension selon le rôle (seulement en mode SUPERPOSÉ)
      const etageExt = splitLayout ? 1.0 : ETAGE_EXTENSION_BY_ROLE[role];
      const empriseEtageMax = empriseEffective * (nbMitoyens > 0 ? 1.10 : 1.0);
      if (etageExt === "ENVELOPE") {
        fpEtages = Math.round(Math.min(fpRdc * 1.15, envelope_area, effectiveMaxFp, empriseEtageMax * 1.05));
      } else {
        fpEtages = Math.round(Math.min(fpRdc * (etageExt || 1.0), envelope_area, effectiveMaxFp, empriseEtageMax));
      }
      // fp principal (pour le rendu 3D) = fpEtages (volume dominant)
      fp = fpEtages;
      // Helper COS check : SDP = fpRdc + fpEtages × (niv - 1) — déclaré AVANT le guard pour accessibilité
      const computeSdpDual = (niv) => fpRdc + fpEtages * Math.max(0, niv - 1);
      // v72.64: GUARD — en mode SPLIT, les valeurs (levels, totalUseful, unitMixDetail, unitMix)
      // sont déjà calculées dans le bloc SPLIT ci-dessus. Le bloc ci-dessous (unit calc)
      // ne doit PAS les écraser, sinon totalUnitsResult ≠ unitMixDetail (ex: 4 vs "1×COMM+2×T3")
      let floorsNeeded, totalUnits;
      if (!splitLayout) {
      totalUseful = 0;
      const details = [];
      const cosCap = COS_CAP_BY_ROLE[role] || 1.0;
      const maxSdpForRole = Math.floor(max_sdp * cosCap);
      if (isFpFromEnvelope) {
        // ── BUREAUX : plateaux — v72.33 LOGIQUE UNIFIÉE ──
        // target_units = nombre de plateaux souhaités (SACRÉ)
        // Niveaux = target_units (1 plateau = 1 niveau)
        floorsNeeded = Math.min(clientUnits, effectiveMaxFloors);
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
        // v72.33: LOGIQUE UNIFIÉE — target_units SACRÉ, niveaux = conséquence
        const usefulEtage = fpEtages * (1 - circRatio);
        // Commerce count from mix function
        const estMix = rules.default_mix_fn ? rules.default_mix_fn(clientUnits) : { COMMERCE: 1, T3: clientUnits - 1 };
        const commerceUnits = estMix.COMMERCE || 1;
        // Résidentiel cible = PROGRAMME CLIENT (sacré, pas modifié par roleTargetFactor)
        const resiTarget = Math.max(1, clientUnits - commerceUnits);
        // Combien de logements RENTRENT par étage (déterminé par le plateau)
        let resiPerFloor = Math.floor(usefulEtage / avgResSize); // avgResSize déjà différencié par scénario
        resiPerFloor = Math.max(1, Math.min(maxPerFloor, resiPerFloor));
        // Niveaux = CONSÉQUENCE (1 RDC commerce + N étages résidentiels)
        floorsNeeded = 1 + Math.ceil(resiTarget / resiPerFloor);
        floorsNeeded = Math.max(2, Math.min(floorsNeeded, effectiveMaxFloors));
        // Garde-fou COS
        while (floorsNeeded > 2 && computeSdpDual(floorsNeeded) > maxSdpForRole) floorsNeeded--;
        const actualResiFloors = floorsNeeded - 1;
        totalUnits = commerceUnits + resiPerFloor * actualResiFloors;
        console.log(`│   v72.33 MIXTE: ${resiTarget} logts cibles / ${resiPerFloor} par palier (${avgResSize}m²) = ${actualResiFloors} étages rési + 1 RDC commerce`);
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
        // v72.33: LOGIQUE UNIFIÉE — target_units SACRÉ, niveaux = conséquence
        // La différenciation A/B/C vient des TAILLES (avgResSize), pas du nombre d'unités
        // Combien de logements RENTRENT par palier (déterminé par le plateau)
        let unitsPerFloor = Math.floor(usefulEtage / avgResSize); // avgResSize déjà différencié par scénario
        unitsPerFloor = Math.max(1, Math.min(maxPerFloor, unitsPerFloor));
        // Niveaux = CONSÉQUENCE (target_units / unitsPerFloor)
        floorsNeeded = Math.ceil(clientUnits / unitsPerFloor);
        floorsNeeded = Math.max(1, Math.min(floorsNeeded, effectiveMaxFloors));
        // Garde-fou COS
        while (floorsNeeded > 1 && computeSdpDual(floorsNeeded) > maxSdpForRole) floorsNeeded--;
        // Garde-fou anti-surdimensionnement : SDP ne dépasse pas le programme × 1.35
        const sdpCapProgramme = Math.round(clientUnits * avgResSize / (1 - circRatio) * 1.35);
        while (floorsNeeded > 1 && computeSdpDual(floorsNeeded) > sdpCapProgramme) floorsNeeded--;
        totalUnits = unitsPerFloor * floorsNeeded;
        console.log(`│   v72.33 RÉSIDENTIEL: ${clientUnits} logts cibles / ${unitsPerFloor} par palier (${avgResSize}m²/appt) = ${floorsNeeded} niveaux`);
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
      } // v72.64: fin du guard !splitLayout pour le bloc unit calc
      // v72.31: En SPLIT, les niveaux sont déjà calculés dans le SPLIT branch (levelsLogt)
      // NE PAS écraser avec floorsNeeded qui vient de la logique SUPERPOSÉ
      if (!splitLayout) levels = floorsNeeded;
      // ══════════════════════════════════════════════════════════════════
      // v70.2 ANTI-COLLAPSE : garantir A > B ≥ C en niveaux OU en emprise
      // Quand B et C tombent au même plancher (fpMinViable + 2 niveaux),
      // on réduit C d'1 niveau pour créer une différenciation visible.
      // ══════════════════════════════════════════════════════════════════
      if (!splitLayout && role === "PRUDENT" && levels >= 2 && fpRdc <= fpMinViable * 1.15) {
        // C est au plancher d'emprise → réduire d'1 niveau pour différencier de B
        // v72.22: en programme mixte, minimum = commerceLevels + 1 (au moins 1 logement au-dessus du commerce)
        const minLevels = commerceLevels > 0 ? commerceLevels + 1 : 1;
        levels = Math.max(minLevels, levels - 1);
        console.log(`│   ⚠️ v70.2 ANTI-COLLAPSE: C réduit à ${levels} niv (emprise au plancher ${fpRdc}m² ≈ fpMin=${fpMinViable}m² | min=${minLevels} car commerce=${commerceLevels})`);
      }
      // ── PILOTIS ──
      const freeGround = envelope_area - fpRdc;
      const parkingSpotsNeeded = Math.max(PILOTIS_CONFIG.MIN_PARKING_SPOTS, Math.ceil((totalUnits || 1) * ((rules && rules.parking_per_unit) || 1)));
      const parkingM2Needed = parkingSpotsNeeded * PILOTIS_CONFIG.PARKING_SPOT_M2;
      const freeGroundPct = freeGround / Math.max(1, envelope_area);
      const pilotisRule = rules.requires_pilotis;
      // v57.16: ratio parking/vert — si le parking requis dépasse 40% du sol libre,
      // le ratio 1/3 parking - 2/3 vert est impossible → pilotis auto
      const parkingRatioExceeded = freeGround > 0 && parkingM2Needed > freeGround * 0.40;
      // v72.53: PILOTIS — terrain trop étroit (constructible < 10m)
      const constructibleWidthSuper = (envelope_w || 0) - retraitLatEffectif;
      const isTerrainEtroitSuper = constructibleWidthSuper > 0 && constructibleWidthSuper < 10;
      if (!isBungalow && (pilotisRule === true || isTerrainEtroitSuper || (pilotisRule === "auto" && (
        // ancien seuil : sol libre insuffisant en absolu
        ((freeGround < PILOTIS_CONFIG.MIN_FREE_GROUND_M2 || freeGroundPct < PILOTIS_CONFIG.MIN_FREE_GROUND_PCT)
          && freeGround < parkingM2Needed)
        // v57.16 : ratio parking/vert déséquilibré → pilotis pour libérer le sol
        || parkingRatioExceeded
      )))) {
        hasPilotis = true;
        pilotisLevels = 1;
        if (isTerrainEtroitSuper) {
          console.log(`│   ⚡ v72.53 PILOTIS: terrain étroit (${Math.round(constructibleWidthSuper)}m constructible < 10m) → pilotis R+1 obligatoire`);
        }
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
      // v72.31: En SPLIT, totalUnitsResult déjà calculé dans le SPLIT branch
      if (!splitLayout) totalUnitsResult = totalUnits || 0;
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
    // v72.53: en SPLIT, le SDP TOTAL = commerce + logement (pas juste logement)
    const sdpLogement = (fpRdc && fpEtages && levels > 1)
      ? fpRdc + fpEtages * (levels - 1)
      : fp * levels;
    const sdpCommerce = splitLayout ? (splitLayout.volume_commerce.sdp_m2 || 0) : 0;
    const sdp = sdpLogement + sdpCommerce;
    const cosRatio = max_sdp > 0 ? sdp / max_sdp : 0;
    let compliance;
    if (cosRatio <= 1.05) compliance = "CONFORME";
    else if (cosRatio <= 1.30) compliance = "DEROGATION_POSSIBLE";
    else compliance = "AMBITIEUX_HORS_COS";
    // v72.53: Coût estimé FCFA (Cameroun) — DIFFÉRENCIÉ commerce vs bâti
    // Commerce = construction plus simple (pas de cuisine/SdB) → 80% du coût bâti
    // Bâti résidentiel = coût standard standing
    // VRD = 10% de SDP × 50% du coût/m²
    const COMMERCE_COST_RATIO = 0.80; // commerce = 80% du coût bâti (20% moins cher)
    // v72.53: Coût/m² EXPLICITE par standing × rôle (valeurs marché Cameroun)
    const standingKey = String(standing_level).toUpperCase();
    const roleRange = COST_PER_M2_BY_ROLE[standingKey] || COST_PER_M2_BY_ROLE.STANDARD;
    const costPerM2Standing = roleRange[label] || roleRange.B; // A=cible, B=médian, C=plancher
    // Ajustement driver optionnel (±quelques % selon la stratégie client)
    const driverAdj = COST_DRIVER_ADJUST[primary_driver] || 0;
    const costPerM2Base = label === "A" ? Math.round(costPerM2Standing * (1 + driverAdj)) : costPerM2Standing;
    // v72.53 TYPOLOGY: appliquer cost_mult de la typologie au coût/m² positionné
    const costPerM2 = Math.round(costPerM2Base * (typoImpact ? typoImpact.cost_mult : 1.0));
    const costPerM2Commerce = Math.round(costPerM2 * COMMERCE_COST_RATIO);
    // Coût construction différencié + surcharges typologiques
    const constructionCostBati = sdpLogement * costPerM2;
    const constructionCostCommerce = sdpCommerce * costPerM2Commerce;
    const constructionCost = constructionCostBati + constructionCostCommerce;
    // v72.53 TYPOLOGY: surcharges fondations et toiture (proportionnelles à l'empreinte)
    const _typoFondMult = typoImpact ? typoImpact.fondation_mult : 1.0;
    const _typoToitMult = typoImpact ? typoImpact.toiture_mult : 1.0;
    const _fpForSurcharges = fpRdc || fp;
    const fondationSurcharge = Math.round(_fpForSurcharges * costPerM2Base * (_typoFondMult - 1.0) * 0.15);
    const toitureSurcharge = Math.round(_fpForSurcharges * costPerM2Base * (_typoToitMult - 1.0) * 0.10);
    // v72.53 VRD avec multiplicateur zoning (basé sur le coût standing brut, pas le positionné)
    const vrdZoningMult = VRD_MULT_BY_ZONING[String(zoning_type).toUpperCase()] || VRD_MULT_BY_ZONING.Z_DEFAULT || 1.0;
    const vrdCost = Math.round(((sdpLogement + sdpCommerce) * 0.10) * (costPerM2Standing * 0.50) * vrdZoningMult);
    const estimatedCost = Math.round(constructionCost + fondationSurcharge + toitureSurcharge + vrdCost);
    console.log(`│   💰 COÛT ${label}: ${standingKey}[${label}]=${costPerM2Standing} driverAdj=${driverAdj > 0 ? '+' : ''}${(driverAdj*100).toFixed(0)}% → base=${costPerM2Base} × typo(${preTypology})=${typoImpact ? typoImpact.cost_mult : 1} → ${costPerM2}/m² | fond=+${fondationSurcharge} toit=+${toitureSurcharge} | VRD×${vrdZoningMult}=${vrdCost} | TOTAL=${Math.round(estimatedCost/1e6)}M`);
    // budgetMax is already computed before the loop
    const budgetFit = budgetMax > 0
      ? (estimatedCost <= budgetMax ? "DANS_BUDGET" : estimatedCost <= budgetMax * 1.2 ? "BUDGET_TENDU" : "HORS_BUDGET")
      : "N/A";
    const freeGround = envelope_area - (fpRdc || fp); // espace libre au sol = enveloppe - empreinte RDC
    const parkingEst = hasPilotis ? Math.floor((fpRdc || fp) / PILOTIS_CONFIG.PARKING_SPOT_M2) : Math.floor(freeGround / PILOTIS_CONFIG.PARKING_SPOT_M2);
    // ── v57.13 PARKING DÉTAILLÉ + ESPACE DÉGAGÉ (corrigé) ──
    // Parking basé sur les places REQUISES (réglementation), pas sur tout l'espace théorique
    const parkingPerUnit = (rules && rules.parking_per_unit) || 1;
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
      // v57.20 SPLIT layout (null si SUPERPOSÉ)
      split_layout: splitLayout || null,
      layout_mode: splitLayout ? splitLayout.mode : "SUPERPOSE",
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
      // v72.53 TYPOLOGY impact
      typology: preTypology || "BLOC",
      typology_impact: typoImpact ? {
        cost_mult: typoImpact.cost_mult,
        fondation_mult: typoImpact.fondation_mult,
        toiture_mult: typoImpact.toiture_mult,
        circ_modifier: typoImpact.circ_modifier,
        efficiency: typoImpact.efficiency,
        description: typoImpact.description,
      } : null,
      cost_detail: {
        cost_per_m2_standing: costPerM2Standing,
        cost_driver_adjust: driverAdj,
        cost_per_m2_base: costPerM2Base,
        cost_per_m2_typo: costPerM2,
        cost_per_m2_commerce: costPerM2Commerce,
        construction_bati: Math.round(constructionCostBati),
        construction_commerce: Math.round(constructionCostCommerce),
        fondation_surcharge: fondationSurcharge || 0,
        toiture_surcharge: toitureSurcharge || 0,
        vrd: vrdCost,
        vrd_zoning_mult: vrdZoningMult || 1.0,
      },
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
  // ══════════════════════════════════════════════════════════════════
  // v70.10 ROBUST ANTI-COLLAPSE : post-loop B vs C differentiation
  // If B and C have identical levels AND identical fp → FORCE differentiation
  // ══════════════════════════════════════════════════════════════════
  if (r.B && r.C) {
    const bLev = r.B.levels, cLev = r.C.levels;
    const bFp = Math.round(r.B.fp_m2), cFp = Math.round(r.C.fp_m2);
    const bSdp = Math.round(r.B.sdp_m2), cSdp = Math.round(r.C.sdp_m2);
    if (bLev === cLev && bFp === cFp) {
      console.log(`│ ⚠️ v70.10 ANTI-COLLAPSE: B(${bLev}niv,${bFp}m²) === C(${cLev}niv,${cFp}m²) → différenciation forcée`);
      if (cLev >= 2) {
        // Réduire C d'1 niveau
        r.C.levels = cLev - 1;
        recalcSdp(r.C);
        console.log(`│   → C réduit à ${r.C.levels} niv, SDP=${r.C.sdp_m2}m²`);
      } else {
        // C déjà à 1 niveau → réduire emprise de 15%
        r.C.fp_m2 = Math.round(cFp * 0.85);
        r.C.fp_rdc_m2 = r.C.fp_m2;
        r.C.fp_etages_m2 = r.C.fp_m2;
        recalcSdp(r.C);
        console.log(`│   → C emprise réduite à ${r.C.fp_m2}m², SDP=${r.C.sdp_m2}m²`);
      }
    } else if (bSdp === cSdp && bSdp > 0) {
      console.log(`│ ⚠️ v70.10 ANTI-COLLAPSE (SDP): B.sdp=${bSdp} === C.sdp=${cSdp} → C réduit`);
      if (cLev >= 2) {
        r.C.levels = cLev - 1;
        recalcSdp(r.C);
        console.log(`│   → C réduit à ${r.C.levels} niv, SDP=${r.C.sdp_m2}m²`);
      }
    }
  }
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
    // v5.4 FIX: Ne PAS capper total_units entre scénarios.
    // B peut avoir PLUS de logements que A si les logements sont plus compacts (UNIT_SIZES plus petits).
    // La hiérarchie A >= B >= C s'applique aux NIVEAUX et à la SDP, pas au nombre de logements.
    // L'ancien code écrasait B.total_units = A.total_units SANS recalculer unit_mix_detail,
    // surf_hab et m2_par_logt, ce qui créait une incohérence (unit_mix=10 mais total_units=8).
    // Supprimé — le nombre de logements est un RÉSULTAT du dimensionnement, pas une contrainte.
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
  // v57.21 SAFETY NET: enforce A.fp_m2 >= B.fp_m2 >= C.fp_m2
  // The core calculation should always produce this, but post-processing
  // or edge cases might break it. This is the last line of defense.
  if (r.A.fp_m2 < r.B.fp_m2) {
    console.log(`│ ⚠️ v57.21: fp inversion A(${r.A.fp_m2}) < B(${r.B.fp_m2}) → fixing A=B`);
    r.A.fp_m2 = r.B.fp_m2;
    r.A.fp_rdc_m2 = Math.max(r.A.fp_rdc_m2 || 0, r.B.fp_rdc_m2 || 0);
    r.A.fp_etages_m2 = Math.max(r.A.fp_etages_m2 || 0, r.B.fp_etages_m2 || 0);
    recalcSdp(r.A);
  }
  if (r.B.fp_m2 < r.C.fp_m2) {
    console.log(`│ ⚠️ v57.21: fp inversion B(${r.B.fp_m2}) < C(${r.C.fp_m2}) → fixing C=B*0.85`);
    r.C.fp_m2 = Math.max(50, Math.round(r.B.fp_m2 * 0.85));
    r.C.fp_rdc_m2 = Math.max(50, Math.round((r.B.fp_rdc_m2 || r.B.fp_m2) * 0.85));
    r.C.fp_etages_m2 = Math.max(50, Math.round((r.B.fp_etages_m2 || r.B.fp_m2) * 0.85));
    recalcSdp(r.C);
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
    engine_version: "57.20",
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
    engine_version: "57.20",
  };
  console.log(`│`);
  console.log(`│ A(${r.A.role}): fp=${r.A.fp_m2}m² × ${r.A.levels}niv = ${r.A.sdp_m2}m² SDP (${r.A.cos_ratio_pct}%COS) ${r.A.cos_compliance} | ${r.A.unit_mix_detail}`);
  console.log(`│ B(${r.B.role}): fp=${r.B.fp_m2}m² × ${r.B.levels}niv = ${r.B.sdp_m2}m² SDP (${r.B.cos_ratio_pct}%COS) ${r.B.cos_compliance} | ${r.B.unit_mix_detail}`);
  console.log(`│ C(${r.C.role}): fp=${r.C.fp_m2}m² × ${r.C.levels}niv = ${r.C.sdp_m2}m² SDP (${r.C.cos_ratio_pct}%COS) ${r.C.cos_compliance} | ${r.C.unit_mix_detail}`);
  console.log(`│ ★ RECOMMANDÉ : ${recommended} — ${recommendation_reason}`);
  console.log(`└── end SCENARIO ENGINE v57.20 ──`);
  return { A: r.A, B: r.B, C: r.C, meta, diagnostic, computed_budget_band: budget_band };
}
// ══════════════════════════════════════════════════════════════════════════════
// v72.59: FONCTION GLOBALE — calcul des scores depuis les champs bruts du body
// Utilisée par /compute-scenarios ET /generate-massing pour GARANTIR la cohérence
// ══════════════════════════════════════════════════════════════════════════════
function computeScoresFromRaw(p) {
  const _n = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
  const rawBF = _n(p.setback_side_m || p.setback_side);
  const rawBG = _n(p.setback_back_m || p.setback_back);
  const rawBH = _n(p.envelope_w);
  const rawBD = _n(p.plot_d_m || p.plot_d || p.site_depth || p.envelope_d);
  const rawL  = _n(p.site_area);
  const rawS  = _n(p.target_units);
  const rawR  = _n(p.target_surface_m2);
  const rawZ  = _n(p.financial_rigidity_score);
  const rawAY = String(p.primary_driver || "").toUpperCase();
  const rawCI = String(p.budget_band || "").toUpperCase();
  // Scores normalisés
  const rent_score_norm     = Math.round((rawBF / 50) * 100);
  const capacity_score_norm = Math.round((rawBG / 50) * 100);
  const risk_score_norm     = Math.round((rawBH / 50) * 100);
  // Scores principaux
  const rent_score     = rawL ? Math.min(100, Math.max(0, rawBF + (rawBG * 1.5) + rawBH)) : 0;
  const capacity_score = rawL ? Math.min(100, Math.max(0, (rent_score_norm + capacity_score_norm + risk_score_norm) / 3)) : 0;
  const mix_score_norm = Math.round((rent_score / 50) * 100);
  const phase_score_norm = Math.round((capacity_score / 50) * 100);
  const phase_score    = rawL ? 35 : 0;
  const risk_score     = rawL ? 45 : 0;
  // Density & pressure
  const density_band = rawBD >= 15 ? "HIGH" : (rawBD >= 8 ? "MEDIUM" : "LOW");
  const density_pressure_factor = density_band === "HIGH" ? 15 : (density_band === "MEDIUM" ? 7 : 0);
  const risk_adjusted = Math.min(100, risk_score_norm + density_pressure_factor);
  // Second best & dominance
  const scoreArray = [rent_score_norm, capacity_score_norm, risk_score_norm, mix_score_norm].sort((a, b) => b - a);
  const second_best_score = scoreArray[1] || 0;
  const dominance_gap = (scoreArray[0] || 0) - second_best_score;
  // Decision columns
  const density_band_calc = rawL < 800 ? "LOW DENSITY" : (rawL < 1500 ? "MEDIUM DENSITY" : "HIGH DENSITY");
  let budget_tension_calc = "LOW_TENSION";
  if (rawCI === "LOW_BUDGET" && (rawS >= 10 || rawR >= 900)) budget_tension_calc = "HIGH_TENSION";
  else if (rawCI === "MEDIUM_BUDGET" && (rawS >= 14 || rawR >= 1400)) budget_tension_calc = "HIGH_TENSION";
  else if (rawCI === "MEDIUM_BUDGET" && (rawS >= 8 || rawR >= 900)) budget_tension_calc = "MEDIUM_TENSION";
  const feasibility_posture = risk_score_norm >= 75 ? "DEFENSIVE" : ((risk_score_norm <= 40 && density_band_calc === "HIGH DENSITY") ? "OFFENSIVE" : "BALANCED");
  let program_intent = "BALANCED_RESIDENTIAL";
  if (rawAY === "RENT_SCORE" || rawAY === "CAPACITY_SCORE" || rawAY === "RENTABILITE" || rawAY === "CAPACITE") program_intent = "MAX_YIELD";
  else if (rawAY === "MIX_SCORE" || rawAY === "MIXTE" || rawAY === "EQUILIBRE") program_intent = "MIXED_PROGRAM";
  else if (rawAY === "PHASE_SCORE" || rawAY === "PHASAGE") program_intent = "PHASED_STRATEGY";
  else if (rawAY === "RISK_SCORE" || rawAY === "RISQUE") program_intent = "LOW_RISK_STRATEGY";
  else if (rawZ >= 8) program_intent = "DEFENSIVE_PROGRAM";
  let program_alignment = "MEDIUM_ALIGNMENT";
  if ((program_intent === "MAX_YIELD" || program_intent === "MIXED_PROGRAM") && (density_band_calc === "LOW DENSITY" || budget_tension_calc === "HIGH_TENSION" || feasibility_posture === "DEFENSIVE")) program_alignment = "LOW_ALIGNMENT";
  else if ((program_intent === "LOW_RISK_STRATEGY" || program_intent === "DEFENSIVE_PROGRAM") && (budget_tension_calc === "LOW_TENSION" || feasibility_posture === "BALANCED")) program_alignment = "HIGH_ALIGNMENT";
  else if (program_intent === "BALANCED_RESIDENTIAL" && (feasibility_posture === "BALANCED" || feasibility_posture === "OFFENSIVE")) program_alignment = "HIGH_ALIGNMENT";
  const strategic_position = program_alignment === "HIGH_ALIGNMENT" ? "ALIGNED_STRATEGY" : (program_alignment === "MEDIUM_ALIGNMENT" ? "NEGOTIATED_STRATEGY" : (program_alignment === "LOW_ALIGNMENT" ? "CORRECTIVE_STRATEGY" : "BALANCED_POSITION"));
  const recommended_scenario = feasibility_posture === "OFFENSIVE" ? "A" : (feasibility_posture === "BALANCED" ? "B" : "C");
  // Driver intensity
  let driver_intensity = "MOYENNE";
  if (rawAY === "RENTABILITE" || rawAY === "RENT_SCORE") driver_intensity = rent_score_norm >= 70 ? "FORTE" : (rent_score_norm >= 40 ? "MOYENNE" : "FAIBLE");
  else if (rawAY === "CAPACITE" || rawAY === "CAPACITY_SCORE") driver_intensity = capacity_score_norm >= 70 ? "FORTE" : (capacity_score_norm >= 40 ? "MOYENNE" : "FAIBLE");
  // useCalc helpers: prefer received value if non-zero, else use calculated
  // v72.59: useCalc/useCalcStr rejettent les #VALUE! et chaînes corrompues de Google Sheet
  const _isSheetError = (v) => typeof v === "string" && /^#(VALUE|REF|N\/A|ERROR|NAME|NULL|DIV\/0)!?/i.test(String(v).trim());
  const useCalc = (received, calculated) => (received && received !== 0 && !isNaN(received)) ? received : calculated;
  const useCalcStr = (received, calculated) => (received && String(received).length > 0 && !_isSheetError(received)) ? received : calculated;
  return {
    // Final scores (with useCalc applied — prefer received if present)
    rent_score: useCalc(Number(p.rent_score), rent_score),
    capacity_score: useCalc(Number(p.capacity_score), capacity_score),
    mix_score: Number(p.mix_score) || 0,
    phase_score: useCalc(Number(p.phase_score), phase_score),
    risk_score: useCalc(Number(p.risk_score), risk_score),
    density_band: useCalcStr(p.density_band, density_band),
    risk_adjusted: useCalc(Number(p.risk_adjusted), risk_adjusted),
    feasibility_posture: useCalcStr(p.feasibility_posture, feasibility_posture),
    density_pressure_factor: useCalc(Number(p.density_pressure_factor), density_pressure_factor),
    driver_intensity: useCalcStr(p.driver_intensity, driver_intensity),
    strategic_position: useCalcStr(p.strategic_position, strategic_position),
    // Raw calculated values (for computed_scores response)
    rent_score_norm, capacity_score_norm, risk_score_norm,
    mix_score_norm, phase_score_norm,
    second_best_score, dominance_gap,
    density_band_calc, budget_tension_calc,
    program_intent_calc: program_intent,
    program_alignment_calc: program_alignment,
    recommended_scenario,
    feasibility_posture_calc: feasibility_posture,
  };
}
// ─── ENDPOINT /compute-scenarios ─────────────────────────────────────────────
app.post("/compute-scenarios", (req, res) => {
  const p = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch(e) { return {}; } })() : (req.body || {});
  // v72.54: SANITIZE #VALUE! from Google Sheet — replace all Sheet errors with empty string
  for (const key of Object.keys(p)) {
    if (typeof p[key] === "string" && /^#(VALUE|REF|N\/A|ERROR|NAME|NULL|DIV\/0)!?/i.test(p[key].trim())) {
      console.log(`[SANITIZE] ${key}="${p[key]}" → "" (Google Sheet error)`);
      p[key] = "";
    }
  }
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
  console.log(`║ disposition="${p.disposition}" layout_mode="${p.layout_mode}"`);
  console.log(`╚════════════════════════════════════════╝\n`);

  // ── v72.53: PARSING ROBUSTE des dimensions ──────────────────────────────────
  // Make.com peut envoyer "20 - 6" (formule Sheet comme texte) au lieu d'un nombre.
  // Number("20 - 6") = NaN → CRASH.
  // parseFloat("20 - 6") = 20 → CORRECT car le serveur attend les dimensions BRUTES.
  // Le serveur applique lui-même les retraits avec la bonne logique de mitoyenneté.
  // Évaluer l'arithmétique (20-6=14) serait FAUX car ça donnerait des dimensions NETTES
  // que le serveur re-soustrairait → double soustraction.
  const _safeFloat = (v) => {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return isNaN(v) ? 0 : v;
    const s = String(v).trim();
    const n = Number(s);
    if (!isNaN(n)) return n;
    // Prendre le premier nombre de la chaîne (= dimension BRUTE du terrain)
    const f = parseFloat(s);
    return (!isNaN(f)) ? f : 0;
  };

  // v72.59: Appel de la fonction GLOBALE computeScoresFromRaw (définie avant ce endpoint)

  // v72.52: Appliquer parseFloat sur envelope_w et envelope_d AVANT tout calcul
  const parsed_envelope_w = _safeFloat(p.envelope_w);
  const parsed_envelope_d = _safeFloat(p.envelope_d);
  const parsed_site_area  = _safeFloat(p.site_area);
  const parsed_envelope_area = _safeFloat(p.envelope_area);
  console.log(`[v72.52] PARSED DIMS: envelope_w=${parsed_envelope_w} envelope_d=${parsed_envelope_d} site_area=${parsed_site_area} envelope_area=${parsed_envelope_area} (raw: w="${p.envelope_w}" d="${p.envelope_d}")`);

  // ── v72.59: APPEL DE LA FONCTION PARTAGÉE POUR CALCULER LES SCORES ──
  const scores = computeScoresFromRaw(p);
  const calc_rent_score = scores.rent_score;
  const calc_capacity_score = scores.capacity_score;
  const calc_phase_score = scores.phase_score;
  const calc_risk_score = scores.risk_score;
  const calc_density_band = scores.density_band;
  const calc_risk_adjusted = scores.risk_adjusted;
  const calc_feasibility_posture = scores.feasibility_posture;
  const calc_density_pressure_factor = scores.density_pressure_factor;
  const calc_driver_intensity = scores.driver_intensity;
  const calc_strategic_position = scores.strategic_position;
  const calc_rent_score_norm = scores.rent_score_norm;
  const calc_capacity_score_norm = scores.capacity_score_norm;
  const calc_risk_score_norm = scores.risk_score_norm;
  const calc_mix_score_norm = scores.mix_score_norm;
  const calc_phase_score_norm = scores.phase_score_norm;
  const calc_second_best_score = scores.second_best_score;
  const calc_dominance_gap = scores.dominance_gap;
  const calc_density_band_calc = scores.density_band_calc;
  const calc_budget_tension_calc = scores.budget_tension_calc;
  const calc_program_intent = scores.program_intent_calc;
  const calc_program_alignment = scores.program_alignment_calc;
  const calc_recommended_scenario = scores.recommended_scenario;

  console.log(`[v72.59] SCORES CALCULÉS SERVEUR: rent_score=${calc_rent_score} capacity=${calc_capacity_score} risk_norm=${calc_risk_score_norm}`);
  console.log(`[v72.59] density_band=${calc_density_band} feasibility=${calc_feasibility_posture} strategic=${calc_strategic_position} recommended=${calc_recommended_scenario}`);
  console.log(`[v72.59] program_intent=${calc_program_intent} alignment=${calc_program_alignment} driver_intensity=${calc_driver_intensity}`);

  // v72.59: useCalc/useCalcStr rejettent les #VALUE! de Google Sheet
  const _isSheetErr = (v) => typeof v === "string" && /^#(VALUE|REF|N\/A|ERROR|NAME|NULL|DIV\/0)!?/i.test(String(v).trim());
  const useCalc = (received, calculated) => (received && received !== 0 && !isNaN(received)) ? received : calculated;
  const useCalcStr = (received, calculated) => (received && String(received).length > 0 && !_isSheetErr(received)) ? received : calculated;

  // ── v72.62: DÉTECTION SPLIT — ALIGNÉE avec /generate-massing (4 signaux identiques) ──
  // Signal 1: layout_mode explicitement SPLIT_AV_AR
  const layoutModeIsSplit_cs = String(p.layout_mode || "").toUpperCase() === "SPLIT_AV_AR";
  // Signal 2: disposition (formulaire Google) mentionne commerce devant/split
  const dispositionRaw_cs = String(p.disposition || "").toLowerCase();
  const dispositionIsSplit_cs = /commerce devant|retrait|split/i.test(dispositionRaw_cs);
  // Signal 3: body contient des mots-clés SPLIT dans les valeurs
  const fieldValues_cs = Object.values(p).map(v => String(v).toLowerCase()).join(" ");
  const bodyHasSplit_cs = /split.?av|commerce.?devant|devant.?retrait|dissoci/i.test(fieldValues_cs);
  // Signal 4: commerce_depth_m > 0 avec programme mixte → FORCÉMENT du SPLIT
  const bodyHasMixte_cs = /mixte|mixed|usage.?mixte/i.test(fieldValues_cs);
  const hasCommerceDepth_cs = Number(p.commerce_depth_m) > 0;
  // ── Résolution SPLIT (IDENTIQUE au massing endpoint) ──
  const effectiveLayoutMode_cs = (layoutModeIsSplit_cs || dispositionIsSplit_cs || bodyHasSplit_cs || (hasCommerceDepth_cs && bodyHasMixte_cs))
    ? "SPLIT_AV_AR" : "SUPERPOSE";
  console.log(`[v72.62] SPLIT DETECTION: layout_mode="${p.layout_mode}"→${layoutModeIsSplit_cs} | disposition="${dispositionRaw_cs}"→${dispositionIsSplit_cs} | bodyHasSplit=${bodyHasSplit_cs} | commerceDepth=${p.commerce_depth_m} hasMixte=${bodyHasMixte_cs} | RESULT=${effectiveLayoutMode_cs}`);
  const scenarios = computeSmartScenarios({
    site_area: parsed_site_area,
    envelope_w: parsed_envelope_w,
    envelope_d: parsed_envelope_d,
    envelope_area: parsed_envelope_area || undefined,
    zoning_type: p.zoning_type || "URBAIN",
    floor_height: Number(p.floor_height) || 3.2,
    primary_driver: p.primary_driver || "MAX_CAPACITE",
    max_floors: Number(p.max_floors) || 99,
    max_height_m: Number(p.max_height_m) || 99,
    program_main: p.program_main || p.project_type || "",
    target_surface_m2: Number(p.target_surface_m2) || 0,
    site_saturation_level: p.site_saturation_level || "MEDIUM",
    financial_rigidity_score: Number(p.financial_rigidity_score) || 0,
    // v72.59: scores.* contient DÉJÀ les valeurs useCalc'd (pref received, sinon calculated)
    density_band: scores.density_band,
    risk_adjusted: scores.risk_adjusted,
    feasibility_posture: scores.feasibility_posture,
    scenario_A_role: p.scenario_A_role || "",
    scenario_B_role: p.scenario_B_role || "",
    scenario_C_role: p.scenario_C_role || "",
    budget_range: Number(p.budget_range) || 0,
    budget_range_raw: String(p.budget_range || ""),
    budget_band: p.budget_band || "",
    budget_tension: Number(p.budget_tension) || 0,
    standing_level: p.standing_level || "STANDARD",
    target_units: Number(p.target_units) || 0,
    rent_score: scores.rent_score,
    capacity_score: scores.capacity_score,
    mix_score: scores.mix_score,
    phase_score: scores.phase_score,
    risk_score: scores.risk_score,
    density_pressure_factor: scores.density_pressure_factor,
    driver_intensity: scores.driver_intensity,
    strategic_position: scores.strategic_position,
    // v72.50 : disposition spatiale — détecté depuis le champ "disposition" du formulaire
    layout_mode: effectiveLayoutMode_cs,
    commerce_depth_m: Number(p.commerce_depth_m) || 6,
    retrait_inter_volumes_m: Number(p.retrait_inter_volumes_m) || 4,
  });
  // ── v72.50: ANTI-COLLAPSE — garantir A > B > C en SDP ──
  // Sur petites parcelles avec scores vides, le moteur peut produire A ≈ B.
  // On force la différenciation en post-processing.
  const _recalcSdp = (sc) => {
    if (sc.split_layout && sc.split_layout.volume_commerce && sc.split_layout.volume_logement) {
      sc.sdp_m2 = (sc.split_layout.volume_commerce.sdp_m2 || 0) + (sc.split_layout.volume_logement.sdp_m2 || 0);
    } else {
      const fpRdc = sc.fp_rdc_m2 || sc.fp_m2;
      const fpEt = sc.fp_etages_m2 || sc.fp_m2;
      sc.sdp_m2 = fpRdc + fpEt * (sc.levels - 1);
    }
    sc.height_m = Math.round(sc.levels * 3.2 * 10) / 10;
    // v72.64: recalculer surface_habitable et total_useful après changement de SDP
    const circRatio = (sc.circulation_ratio_pct || 20) / 100;
    sc.surface_habitable_m2 = Math.round(sc.sdp_m2 * (1 - circRatio));
    sc.total_useful_m2 = sc.surface_habitable_m2;
    // Recalculer m2/logement
    const nbLogements = Math.max(1, (sc.total_units || 1) - (sc.commerce_levels > 0 ? 1 : 0));
    sc.m2_habitable_par_logement = Math.round(sc.surface_habitable_m2 / nbLogements);
    sc.ratio_efficacite_pct = sc.sdp_m2 > 0 ? Math.round(sc.surface_habitable_m2 / sc.sdp_m2 * 100) : 0;
  };
  if (scenarios.A && scenarios.B) {
    const aSdp = Math.round(scenarios.A.sdp_m2);
    const bSdp = Math.round(scenarios.B.sdp_m2);
    const diffAB = aSdp > 0 ? Math.abs(aSdp - bSdp) / aSdp : 0;
    if (diffAB < 0.08) {
      console.log(`[v72.50] ⚠️ ANTI-COLLAPSE A/B: A.sdp=${aSdp} B.sdp=${bSdp} diff=${(diffAB*100).toFixed(1)}% < 8% → FORÇAGE`);
      if (scenarios.B.levels >= 2) {
        scenarios.B.levels = scenarios.B.levels - 1;
        if (scenarios.B.split_layout && scenarios.B.split_layout.volume_logement) {
          scenarios.B.split_layout.volume_logement.levels = Math.max(1, scenarios.B.split_layout.volume_logement.levels - 1);
          scenarios.B.split_layout.volume_logement.sdp_m2 = scenarios.B.split_layout.volume_logement.fp_m2 * scenarios.B.split_layout.volume_logement.levels;
        }
        _recalcSdp(scenarios.B);
        console.log(`[v72.50] → B.levels réduit → B.sdp=${scenarios.B.sdp_m2}`);
      } else {
        scenarios.B.fp_m2 = Math.round(scenarios.B.fp_m2 * 0.80);
        scenarios.B.fp_rdc_m2 = Math.round((scenarios.B.fp_rdc_m2 || scenarios.B.fp_m2) * 0.80);
        scenarios.B.fp_etages_m2 = Math.round((scenarios.B.fp_etages_m2 || scenarios.B.fp_m2) * 0.80);
        _recalcSdp(scenarios.B);
        console.log(`[v72.50] → B.fp réduit 80% → B.sdp=${scenarios.B.sdp_m2}`);
      }
    }
  }
  if (scenarios.B && scenarios.C) {
    const bSdp2 = Math.round(scenarios.B.sdp_m2);
    const cSdp = Math.round(scenarios.C.sdp_m2);
    if (bSdp2 <= cSdp && scenarios.C.levels >= 2) {
      scenarios.C.levels = scenarios.C.levels - 1;
      _recalcSdp(scenarios.C);
      console.log(`[v72.50] → C.levels réduit car B.sdp(${bSdp2}) ≤ C.sdp(${cSdp}) → C.sdp=${scenarios.C.sdp_m2}`);
    }
  }
  // ── v72.53: RECALCUL DES COÛTS après anti-collapse ──
  // L'anti-collapse modifie les SDP/levels/fp → les coûts doivent être recalculés
  // v72.53: commerce = 80% du coût bâti (construction plus simple)
  const COMMERCE_COST_RATIO_RECALC = 0.80;
  const COST_RANGE_MULT_RECALC = { bas: 0.85, haut: 1.20 };
  const standingRecalc = String(p.standing_level || "STANDARD").toUpperCase();
  const roleRangeRecalc = COST_PER_M2_BY_ROLE[standingRecalc] || COST_PER_M2_BY_ROLE.STANDARD;
  const zoningRecalc = String(p.zoning_type || "URBAIN").toUpperCase();
  const vrdMultRecalc = VRD_MULT_BY_ZONING[zoningRecalc] || VRD_MULT_BY_ZONING.Z_DEFAULT || 1.0;
  const driverRecalc = String(p.primary_driver || "MAX_CAPACITE").toUpperCase();
  const driverAdjRecalc = COST_DRIVER_ADJUST[driverRecalc] || 0;
  for (const label of ["A", "B", "C"]) {
    const sc = scenarios[label];
    if (!sc) continue;
    const newSdp = sc.sdp_m2;
    if (!newSdp || isNaN(newSdp) || newSdp <= 0) continue;
    // v72.53: récupérer la typologie stockée dans le scénario
    const scTypo = TYPOLOGY_IMPACT[sc.typology] || TYPOLOGY_IMPACT.BLOC;
    // v72.53: coût/m² explicite par rôle + ajustement driver
    const rcCostPerM2Standing = roleRangeRecalc[label] || roleRangeRecalc.B;
    const rcCostPerM2Base = label === "A" ? Math.round(rcCostPerM2Standing * (1 + driverAdjRecalc)) : rcCostPerM2Standing;
    const costPerM2Recalc = Math.round(rcCostPerM2Base * scTypo.cost_mult);
    const costPerM2CommerceRecalc = Math.round(costPerM2Recalc * COMMERCE_COST_RATIO_RECALC);
    // v72.53: coût différencié commerce vs bâti
    const scCommerceSdp = (sc.split_layout && sc.split_layout.volume_commerce) ? (sc.split_layout.volume_commerce.sdp_m2 || 0) : 0;
    const scBatiSdp = newSdp - scCommerceSdp;
    const newCostConstruction = scBatiSdp * costPerM2Recalc + scCommerceSdp * costPerM2CommerceRecalc;
    // v72.53: surcharges fondations + toiture (proportionnelles à l'empreinte)
    const scFp = sc.fp_rdc_m2 || sc.fp_m2 || 0;
    const rcFondSurcharge = Math.round(scFp * rcCostPerM2Base * (scTypo.fondation_mult - 1.0) * 0.15);
    const rcToitSurcharge = Math.round(scFp * rcCostPerM2Base * (scTypo.toiture_mult - 1.0) * 0.10);
    // v72.53: VRD avec multiplicateur zoning (basé sur coût médian du standing)
    const rcVrdBase = roleRangeRecalc.B; // médian du standing pour VRD
    const newCostVrd = Math.round((newSdp * 0.10) * (rcVrdBase * 0.50) * vrdMultRecalc);
    const newEstimatedCost = Math.round(newCostConstruction + rcFondSurcharge + rcToitSurcharge + newCostVrd);
    sc.estimated_cost = newEstimatedCost;
    sc.cost_total_fcfa = newEstimatedCost;
    sc.cost_construction_fcfa = Math.round(newCostConstruction);
    sc.cost_fondation_surcharge = rcFondSurcharge;
    sc.cost_toiture_surcharge = rcToitSurcharge;
    sc.cost_vrd_fcfa = newCostVrd;
    sc.cost_per_m2_sdp = Math.round(newEstimatedCost / Math.max(1, newSdp));
    sc.cost_per_unit = sc.total_units > 0 ? Math.round(newEstimatedCost / sc.total_units) : 0;
    sc.cout_fourchette = { bas: Math.round(newEstimatedCost * COST_RANGE_MULT_RECALC.bas), median: newEstimatedCost, haut: Math.round(newEstimatedCost * COST_RANGE_MULT_RECALC.haut) };
    // Mettre à jour cost_detail aussi
    if (sc.cost_detail) {
      sc.cost_detail.cost_per_m2_standing = rcCostPerM2Standing;
      sc.cost_detail.cost_driver_adjust = driverAdjRecalc;
      sc.cost_detail.cost_per_m2_base = rcCostPerM2Base;
      sc.cost_detail.cost_per_m2_typo = costPerM2Recalc;
      sc.cost_detail.cost_per_m2_commerce = costPerM2CommerceRecalc;
      sc.cost_detail.construction_bati = Math.round(scBatiSdp * costPerM2Recalc);
      sc.cost_detail.construction_commerce = Math.round(scCommerceSdp * costPerM2CommerceRecalc);
      sc.cost_detail.fondation_surcharge = rcFondSurcharge;
      sc.cost_detail.toiture_surcharge = rcToitSurcharge;
      sc.cost_detail.vrd = newCostVrd;
    }
    console.log(`[v72.53] RECALC COÛTS ${label}(${sc.typology}): ${standingRecalc}[${label}]=${rcCostPerM2Standing} adj=${driverAdjRecalc} → base=${rcCostPerM2Base} × typo=${scTypo.cost_mult} → ${costPerM2Recalc}/m² | bâti=${scBatiSdp}m² comm=${scCommerceSdp}m² | fond=+${rcFondSurcharge} toit=+${rcToitSurcharge} VRD=${newCostVrd} → ${Math.round(newEstimatedCost/1e6)}M`);

    // ══════════════════════════════════════════════════════════════════════
    // v72.60: RECALC VENTILATION — maintenir la cohérence GO+SO+LT = construction
    // CRITIQUE: sans ce recalcul, les flat fields A_ventil_go etc. reflètent
    // les ANCIENNES valeurs alors que A_cost_total reflète le NOUVEAU coût
    // → GPT reçoit des chiffres qui ne s'additionnent pas
    // ══════════════════════════════════════════════════════════════════════
    const rcGO = Math.round(newCostConstruction * COST_VENTILATION_PCT.gros_oeuvre);
    const rcSO = Math.round(newCostConstruction * COST_VENTILATION_PCT.second_oeuvre);
    const rcLT = Math.round(newCostConstruction * COST_VENTILATION_PCT.lots_techniques);
    const rcAmenExt = Math.round(newCostConstruction * COST_VENTILATION_PCT.amenagements_ext);
    const rcHonoraires = calcHonorairesDegressifs(newEstimatedCost);
    const rcHonoMedian = rcHonoraires.median || Math.round((rcHonoraires.bas + rcHonoraires.haut) / 2);
    const rcFraisPermis = Math.round(newEstimatedCost * FRAIS_ANNEXES_PCT.permis_construire);
    const rcFraisAssurance = Math.round(newEstimatedCost * FRAIS_ANNEXES_PCT.assurance_dommage_ouvrage);
    const rcFraisEtudes = Math.round(newEstimatedCost * FRAIS_ANNEXES_PCT.etudes_techniques);
    const rcFraisDivers = Math.round(newEstimatedCost * FRAIS_ANNEXES_PCT.divers_imprevus);
    const rcTotalFrais = rcFraisPermis + rcFraisAssurance + rcFraisEtudes + rcFraisDivers;
    const rcMalusSolaire = sc.malus_orientation_solaire_fcfa || 0;
    const rcGlobalProjet = newEstimatedCost + rcHonoMedian + rcTotalFrais + rcMalusSolaire;
    sc.cout_ventilation = {
      gros_oeuvre_fcfa: rcGO,
      second_oeuvre_fcfa: rcSO,
      lots_techniques_fcfa: rcLT,
      amenagements_ext_fcfa: rcAmenExt,
      vrd_fcfa: newCostVrd,
      sous_total_construction_fcfa: newEstimatedCost,
      honoraires_architecte: {
        bas_fcfa: rcHonoraires.bas,
        median_fcfa: rcHonoMedian,
        haut_fcfa: rcHonoraires.haut,
        taux_bas_pct: newEstimatedCost > 0 ? Math.round(rcHonoraires.bas / newEstimatedCost * 10000) / 100 : 0,
        taux_median_pct: newEstimatedCost > 0 ? Math.round(rcHonoMedian / newEstimatedCost * 10000) / 100 : 0,
        taux_haut_pct: newEstimatedCost > 0 ? Math.round(rcHonoraires.haut / newEstimatedCost * 10000) / 100 : 0,
      },
      frais_annexes: {
        permis_construire_fcfa: rcFraisPermis,
        assurance_dommage_ouvrage_fcfa: rcFraisAssurance,
        etudes_techniques_fcfa: rcFraisEtudes,
        divers_imprevus_fcfa: rcFraisDivers,
        total_frais_annexes_fcfa: rcTotalFrais,
      },
      malus_orientation_solaire_fcfa: rcMalusSolaire,
      cout_global_projet_fcfa: rcGlobalProjet,
    };
    sc.cout_global_projet_fcfa = rcGlobalProjet;
    sc.honoraires_architecte_fcfa = rcHonoMedian;
    console.log(`[v72.60] RECALC VENTILATION ${label}: GO=${Math.round(rcGO/1e6)}M SO=${Math.round(rcSO/1e6)}M LT=${Math.round(rcLT/1e6)}M VRD=${Math.round(newCostVrd/1e6)}M | hono=${Math.round(rcHonoMedian/1e6)}M frais=${Math.round(rcTotalFrais/1e6)}M → global=${Math.round(rcGlobalProjet/1e6)}M`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // v72.63: RECOMPUTE DELTAS — après anti-collapse + recalc coûts
  // Les deltas dans diagnostic.comparatif étaient calculés AVANT anti-collapse
  // → ils reflètent A ≈ B (d'où delta ≈ 0). On les recalcule maintenant.
  // ══════════════════════════════════════════════════════════════════════
  if (scenarios.diagnostic && scenarios.diagnostic.comparatif) {
    const _reExtract = (sc) => ({
      sdp_m2: sc.sdp_m2 || 0,
      surface_habitable_m2: sc.surface_habitable_m2 || 0,
      unites: sc.total_units || 0,
      cout_total_fcfa: sc.cost_total_fcfa || sc.estimated_cost || 0,
      sol_libre_m2: sc.free_ground_m2 || 0,
    });
    const _reDeltas = (ref, alt, refLabel, altLabel) => {
      const dSdp = alt.sdp_m2 - ref.sdp_m2;
      const dCout = alt.cout_total_fcfa - ref.cout_total_fcfa;
      const valeurMarginale = dSdp !== 0 ? Math.round(Math.abs(dCout / dSdp)) : 0;
      const coutM2Ref = ref.sdp_m2 > 0 ? Math.round(ref.cout_total_fcfa / ref.sdp_m2) : 0;
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
        valeur_marginale_fcfa_par_m2: valeurMarginale,
        commentaire: marginaleFavorable
          ? `Chaque m² supplémentaire coûte ${Math.round(valeurMarginale / 1000)}k FCFA — inférieur au coût moyen (${Math.round(coutM2Ref / 1000)}k/m²), investissement efficace.`
          : dSdp > 0
          ? `Chaque m² supplémentaire coûte ${Math.round(valeurMarginale / 1000)}k FCFA — supérieur au coût moyen (${Math.round(coutM2Ref / 1000)}k/m²), rendement décroissant.`
          : `L'économie est de ${Math.round(Math.abs(valeurMarginale) / 1000)}k FCFA par m² sacrifié.`,
      };
    };
    const rA = _reExtract(scenarios.A);
    const rB = _reExtract(scenarios.B);
    const rC = _reExtract(scenarios.C);
    scenarios.diagnostic.comparatif.deltas = {
      B_vs_A: _reDeltas(rA, rB, "A", "B"),
      C_vs_A: _reDeltas(rA, rC, "A", "C"),
      C_vs_B: _reDeltas(rB, rC, "B", "C"),
    };
    console.log(`[v72.63] DELTAS RECOMPUTED: B_vs_A SDP=${scenarios.diagnostic.comparatif.deltas.B_vs_A.delta_sdp_m2}m² (${scenarios.diagnostic.comparatif.deltas.B_vs_A.delta_sdp_pct}%) | C_vs_A SDP=${scenarios.diagnostic.comparatif.deltas.C_vs_A.delta_sdp_m2}m²`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // v72.65: GARDE-FOU FINAL — surface_habitable ≤ sdp (physiquement impossible autrement)
  // Après anti-collapse + recalc, certains scénarios peuvent avoir hab > sdp
  // si totalUseful n'a pas été recalculé. Ce garde-fou corrige en dernier recours.
  // ══════════════════════════════════════════════════════════════════════
  for (const label of ["A", "B", "C"]) {
    const sc = scenarios[label];
    if (!sc) continue;
    if (sc.surface_habitable_m2 > sc.sdp_m2) {
      const circRatio = (sc.circulation_ratio_pct || 20) / 100;
      const oldHab = sc.surface_habitable_m2;
      sc.surface_habitable_m2 = Math.round(sc.sdp_m2 * (1 - circRatio));
      sc.total_useful_m2 = sc.surface_habitable_m2;
      const nbLogements = Math.max(1, (sc.total_units || 1) - (sc.commerce_levels > 0 ? 1 : 0));
      sc.m2_habitable_par_logement = Math.round(sc.surface_habitable_m2 / nbLogements);
      sc.ratio_efficacite_pct = sc.sdp_m2 > 0 ? Math.round(sc.surface_habitable_m2 / sc.sdp_m2 * 100) : 0;
      console.log(`[v72.65] GARDE-FOU HAB≤SDP: ${label} hab=${oldHab} > sdp=${sc.sdp_m2} → corrigé hab=${sc.surface_habitable_m2} (circ=${sc.circulation_ratio_pct}%)`);
    }
  }

  // v72.66: REFRESH NARRATIVE — après garde-fou + anti-collapse, les m² habitables
  // dans la narrative peuvent être périmés. On corrige par regex.
  if (scenarios.diagnostic && scenarios.diagnostic.recommandation && scenarios.diagnostic.recommandation.narrative) {
    let narr = scenarios.diagnostic.recommandation.narrative;
    for (const label of ["A", "B", "C"]) {
      const sc = scenarios[label];
      if (!sc) continue;
      // Pattern: "XXXm² de surface de plancher dont YYYm² habitables" → update YYY
      const sdpStr = String(sc.sdp_m2);
      const habNew = sc.surface_habitable_m2 || sc.total_useful_m2 || 0;
      const regex = new RegExp(`${sdpStr}m² de surface de plancher dont \\d+m² habitables`);
      narr = narr.replace(regex, `${sdpStr}m² de surface de plancher dont ${habNew}m² habitables`);
    }
    // v72.66b: aussi corriger "(efficacite XX%)" dans la narrative
    const recLabel = (scenarios.diagnostic.recommandation || {}).scenario || "C";
    const recSc = scenarios[recLabel];
    narr = narr.replace(/\(efficacite \d+%\)/g, () => {
      if (recSc && recSc.sdp_m2 > 0) {
        const newEff = recSc.ratio_efficacite_pct || Math.round((recSc.surface_habitable_m2 || 0) / recSc.sdp_m2 * 100);
        return `(efficacite ${newEff}%)`;
      }
      return `(efficacite 0%)`;
    });
    // v72.66c: corriger "XXm² habitables par logement" dans la narrative
    if (recSc && recSc.m2_habitable_par_logement) {
      narr = narr.replace(/\d+m² habitables par logement/, `${recSc.m2_habitable_par_logement}m² habitables par logement`);
    }
    scenarios.diagnostic.recommandation.narrative = narr;
    console.log(`[v72.66] NARRATIVE REFRESHED with post-garde-fou hab values`);
  }

  // v72.66: REFRESH COMPARATIF SNAPSHOT — après garde-fou + anti-collapse + recalc,
  // le snapshot comparatif (copie des valeurs) est périmé. On le rafraîchit.
  // ══════════════════════════════════════════════════════════════════════
  if (scenarios.diagnostic && scenarios.diagnostic.comparatif) {
    for (const label of ["A", "B", "C"]) {
      const sc = scenarios[label];
      const comp = scenarios.diagnostic.comparatif[label];
      if (!sc || !comp) continue;
      // Rafraîchir tous les champs qui ont pu changer après anti-collapse/recalc/garde-fou
      comp.sdp_m2 = sc.sdp_m2;
      comp.surface_habitable_m2 = sc.surface_habitable_m2 || 0;
      comp.ratio_efficacite_pct = sc.ratio_efficacite_pct || 0;
      comp.unites = sc.total_units;
      comp.m2_par_logement = sc.m2_habitable_par_logement || 0;
      comp.cout_total_fcfa = sc.cost_total_fcfa || sc.estimated_cost;
      comp.cout_par_unite = sc.cost_per_unit || 0;
      comp.cout_par_m2_sdp = sc.cost_per_m2_sdp || 0;
      comp.cout_par_m2_habitable = sc.cost_per_m2_habitable || 0;
      comp.emprise_rdc_m2 = sc.fp_rdc_m2 || sc.fp_m2;
      comp.emprise_etages_m2 = sc.fp_etages_m2 || sc.fp_m2;
      comp.niveaux = sc.levels;
      comp.hauteur_m = sc.height_m;
      comp.budget_fit = sc.budget_fit;
      comp.cout_fourchette = sc.cout_fourchette || {};
      comp.cout_ventilation = sc.cout_ventilation || {};
      comp.score_recommandation = sc.recommendation_score || 0;
      comp.duree_chantier_mois = sc.duree_chantier_mois || 0;
      console.log(`[v72.66] COMPARATIF ${label} REFRESHED: hab=${comp.surface_habitable_m2}, cost=${comp.cout_total_fcfa}, eff=${comp.ratio_efficacite_pct}%`);
    }
    // Also recompute deltas with fresh comparatif values
    const _reExtract2 = (label) => {
      const c = scenarios.diagnostic.comparatif[label];
      return {
        sdp_m2: c.sdp_m2 || 0,
        surface_habitable_m2: c.surface_habitable_m2 || 0,
        unites: c.unites || 0,
        cout_total_fcfa: c.cout_total_fcfa || 0,
        sol_libre_m2: c.sol_libre_m2 || 0,
      };
    };
    const _reDeltas2 = (ref, alt, refLabel, altLabel) => {
      const dSdp = alt.sdp_m2 - ref.sdp_m2;
      const dCout = alt.cout_total_fcfa - ref.cout_total_fcfa;
      const valeurMarginale = dSdp !== 0 ? Math.round(Math.abs(dCout / dSdp)) : 0;
      const coutM2Ref = ref.sdp_m2 > 0 ? Math.round(ref.cout_total_fcfa / ref.sdp_m2) : 0;
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
        valeur_marginale_fcfa_par_m2: valeurMarginale,
        commentaire: dSdp < 0
          ? `L'économie est de ${Math.round(Math.abs(valeurMarginale) / 1000)}k FCFA par m² sacrifié.`
          : marginaleFavorable
          ? `Chaque m² supplémentaire coûte ${Math.round(valeurMarginale / 1000)}k FCFA — investissement efficace.`
          : `Chaque m² supplémentaire coûte ${Math.round(valeurMarginale / 1000)}k FCFA — rendement décroissant.`,
      };
    };
    const rA2 = _reExtract2("A");
    const rB2 = _reExtract2("B");
    const rC2 = _reExtract2("C");
    scenarios.diagnostic.comparatif.deltas = {
      B_vs_A: _reDeltas2(rA2, rB2, "A", "B"),
      C_vs_A: _reDeltas2(rA2, rC2, "A", "C"),
      C_vs_B: _reDeltas2(rB2, rC2, "B", "C"),
    };
    console.log(`[v72.66] COMPARATIF+DELTAS FULLY REFRESHED`);
  }

  // v72.66: REFRESH scenario_identity.description — uses sdp_m2 which may have changed
  for (const label of ["A", "B", "C"]) {
    const sc = scenarios[label];
    if (!sc || !sc.scenario_identity) continue;
    const desc = sc.scenario_identity.description || "";
    // Replace "Les XXXm² de SDP" or "developpant XXXm² de SDP" or "XXXm² de SDP" with current sdp
    const sdpFixed = desc.replace(/\d+m² de SDP/g, `${sc.sdp_m2}m² de SDP`);
    if (sdpFixed !== desc) {
      sc.scenario_identity.description = sdpFixed;
      console.log(`[v72.66] ${label} scenario_identity.description SDP updated to ${sc.sdp_m2}m²`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // v72.60: PRÉ-CALCUL DES CHAMPS INJECTION TEXTE
  // ══════════════════════════════════════════════════════════════════════
  function buildTextInjection(sc, label) {
    if (!sc || !sc.sdp_m2) return {};
    // R+ notation
    const totalLevels = (sc.has_pilotis ? 1 : 0) + (sc.levels || 0) + (sc.commerce_levels || 0);
    const rPlus = sc.split_layout
      ? sc.levels  // SPLIT: levels = logement only, pilotis is RDC
      : (totalLevels - 1); // SUPERPOSÉ: RDC + N = R+N
    const rPlusStr = `R+${rPlus}`;
    const gabaritStr = sc.split_layout
      ? `${rPlusStr} sur pilotis (commerce devant + logement arrière)`
      : (sc.commerce_levels > 0 ? `${rPlusStr} (commerce RDC + logement dessus)` : rPlusStr);

    // Unit summary — parse unit_mix_detail string (ex: "1×COMMERCE(40m²) + 2×T3(72m²)")
    const mixDetail = sc.unit_mix_detail || "";
    const parsedParts = [];
    let parsedCommerceCount = 0;
    const mixRegex = /(\d+)×(\w+)\((\d+)m²\)/g;
    let m;
    while ((m = mixRegex.exec(mixDetail)) !== null) {
      const count = parseInt(m[1]);
      const typ = m[2];
      const size = m[3];
      if (typ === "COMMERCE") {
        parsedCommerceCount += count;
        parsedParts.push(`${count} commerce (${size}m²)`);
      } else {
        parsedParts.push(`${count} logement${count > 1 ? 's' : ''} ${typ} (${size}m²)`);
      }
    }
    const totalLogements = (sc.total_units || 0) - parsedCommerceCount;
    const unitSummary = parsedParts.length > 0
      ? `${sc.total_units || 0} unités : ${parsedParts.join(' + ')}`
      : `${sc.total_units || 0} unités (${sc.unit_mix_detail || "détail non disponible"})`;

    // Financial — VERIFIED arithmetic
    const vent = sc.cout_ventilation || {};
    const goM = vent.gros_oeuvre_fcfa ? Math.round(vent.gros_oeuvre_fcfa / 1e6) : 0;
    const soM = vent.second_oeuvre_fcfa ? Math.round(vent.second_oeuvre_fcfa / 1e6) : 0;
    const ltM = vent.lots_techniques_fcfa ? Math.round(vent.lots_techniques_fcfa / 1e6) : 0;
    const constructionM = Math.round((sc.cost_construction_fcfa || sc.estimated_cost || 0) / 1e6);
    const vrdM = vent.vrd_fcfa ? Math.round(vent.vrd_fcfa / 1e6) : 0;
    const travauxM = Math.round((sc.estimated_cost || 0) / 1e6);
    const honoObj = vent.honoraires_architecte || {};
    const honoBasM = honoObj.bas_fcfa ? Math.round(honoObj.bas_fcfa / 1e6) : 0;
    const honoMedianM = honoObj.median_fcfa ? Math.round(honoObj.median_fcfa / 1e6) : 0;
    const honoHautM = honoObj.haut_fcfa ? Math.round(honoObj.haut_fcfa / 1e6) : 0;
    const fraisM = vent.frais_annexes ? Math.round(vent.frais_annexes.total_frais_annexes_fcfa / 1e6) : 0;
    const globalM = vent.cout_global_projet_fcfa ? Math.round(vent.cout_global_projet_fcfa / 1e6) : 0;
    // VERIFIED equation: sum MUST equal global
    const sumCheck = travauxM + honoMedianM + fraisM;
    const budgetEquation = `${travauxM}M travaux + ${honoMedianM}M honoraires + ${fraisM}M frais annexes = ${sumCheck}M FCFA`;
    const ventilEquation = `gros oeuvre ${goM}M (55%) + second oeuvre ${soM}M (25%) + lots techniques ${ltM}M (15%) = ${goM + soM + ltM}M FCFA de construction`;

    // Cost per m²
    const costPerM2 = sc.cost_per_m2_sdp ? Math.round(sc.cost_per_m2_sdp / 1000) : 0;
    const costPerM2Full = sc.cost_per_m2_sdp || 0;

    // Commerce cost info
    const commCostPerM2 = (sc.cost_detail || {}).cost_per_m2_commerce || 0;
    const batiCostPerM2 = (sc.cost_detail || {}).cost_per_m2_typo || 0;
    const commerceCostInfo = commCostPerM2 > 0
      ? `Commerce construit à 80% du coût bâtiment : ${Math.round(commCostPerM2/1000)}k/m² contre ${Math.round(batiCostPerM2/1000)}k/m² pour le bâtiment`
      : "";

    // Budget fit
    const budgetClientFcsa = sc.budget_client_fcsa || 0;
    const fourchette = sc.cout_fourchette || {};
    const fourchetteBasM = fourchette.bas ? Math.round(fourchette.bas / 1e6) : 0;
    const fourchetteHautM = fourchette.haut ? Math.round(fourchette.haut / 1e6) : 0;

    // Habitable surface — utiliser le ratio moteur (circulation architecturale par étage)
    const habM2 = sc.surface_habitable_m2 || sc.total_useful_m2 || 0;
    const circPct = sc.circulation_ratio_pct || (sc.sdp_m2 > 0 ? Math.round((1 - habM2 / sc.sdp_m2) * 100) : 0);
    const circM2 = Math.round(sc.sdp_m2 * circPct / 100);

    // COS compliance
    // v72.64: FIX — cosMax = COS × site_area (SDP max autorisée), pas CES × site_area (emprise max)
    // COS = coefficient d'occupation des sols (ratio SDP/terrain), CES = coefficient d'emprise au sol
    const cosRegl = (sc.regulatory && sc.regulatory.cos_reglementaire) || 2.5;
    const cosMax = Math.round(cosRegl * (sc._site_area || Number(p.site_area) || 0));
    const cosDepassement = sc.sdp_m2 > cosMax ? sc.sdp_m2 - cosMax : 0;

    return {
      R_plus: rPlusStr,
      gabarit: gabaritStr,
      unit_summary: unitSummary,
      logement_count: String(totalLogements),
      commerce_count: String(parsedCommerceCount),
      hab_m2: String(Math.round(habM2)),
      circ_pct: `${circPct}%`,
      circ_m2: String(circM2),
      m2_hab_par_unite: String(sc.m2_habitable_par_logement || Math.round(habM2 / Math.max(1, sc.total_units || 1))),
      budget_equation: budgetEquation,
      ventil_equation: ventilEquation,
      cost_per_m2_fcfa: String(costPerM2Full),
      cost_per_m2_text: `${costPerM2}k FCFA/m² (${Math.round(costPerM2Full)} FCFA/m²)`,
      commerce_cost_info: commerceCostInfo,
      travaux_M: String(travauxM),
      vrd_M: String(vrdM),
      hono_median_M: String(honoMedianM),
      hono_bas_M: String(honoBasM),
      hono_haut_M: String(honoHautM),
      frais_M: String(fraisM),
      global_M: String(globalM),
      fourchette_text: `entre ${fourchetteBasM}M et ${fourchetteHautM}M FCFA`,
      cos_max_m2: String(cosMax),
      cos_depassement_m2: String(cosDepassement),
      cos_depassement_text: cosDepassement > 0 ? `Dépassement de ${cosDepassement}m² par rapport au COS (${cosMax}m² autorisés)` : `Conforme au COS (${sc.sdp_m2}m² sur ${cosMax}m² autorisés)`,
    };
  }

  // v57.22: champs diagnostic APLATIS pour Make.com (évite {object} dans Google Sheets)
  const diag = scenarios.diagnostic || {};
  const comp = diag.comparatif || {};
  const deltas = comp.deltas || {};
  const dBA = deltas.B_vs_A || {};
  const dCA = deltas.C_vs_A || {};
  const dCB = deltas.C_vs_B || {};
  const phasage = diag.strategie_phasage || {};
  const orient = diag.orientation_solaire || {};
  const retr = diag.retraits_reglementaires || {};
  const profil = diag.profil_client || {};
  const siteDiag = diag.site || {};
  const sA = scenarios.A || {};
  const sB = scenarios.B || {};
  const sC = scenarios.C || {};

  // Store site_area in scenarios for buildTextInjection to access
  for (const l of ["A", "B", "C"]) {
    if (scenarios[l]) scenarios[l]._site_area = Number(p.site_area) || 0;
  }

  const txtA = buildTextInjection(sA, "A");
  const txtB = buildTextInjection(sB, "B");
  const txtC = buildTextInjection(sC, "C");
  const flat = {
    // ── NARRATIVE ──
    diagnostic_narrative: (diag.recommandation || {}).narrative || "",
    rec_scenario: (diag.recommandation || {}).scenario || "",
    rec_score: (diag.recommandation || {}).score || 0,
    // ── COMPARATIF DELTAS (texte plat) ──
    delta_BA_sdp: `${dBA.delta_sdp_m2 || 0} m² (${dBA.delta_sdp_pct || 0}%)`,
    delta_BA_cout: `${dBA.delta_cout_fcfa ? Math.round(dBA.delta_cout_fcfa / 1e6) : 0}M FCFA (${dBA.delta_cout_pct || 0}%)`,
    delta_BA_unites: `${dBA.delta_unites || 0} logements`,
    delta_BA_valeur_marginale: `${dBA.valeur_marginale_fcfa_par_m2 ? Math.round(dBA.valeur_marginale_fcfa_par_m2 / 1000) : 0}k FCFA/m²`,
    delta_BA_commentaire: dBA.commentaire || "",
    delta_BA_conseil: dBA.conseil_marginale || "",
    delta_CA_sdp: `${dCA.delta_sdp_m2 || 0} m² (${dCA.delta_sdp_pct || 0}%)`,
    delta_CA_cout: `${dCA.delta_cout_fcfa ? Math.round(dCA.delta_cout_fcfa / 1e6) : 0}M FCFA (${dCA.delta_cout_pct || 0}%)`,
    delta_CA_unites: `${dCA.delta_unites || 0} logements`,
    delta_CA_commentaire: dCA.commentaire || "",
    delta_CB_sdp: `${dCB.delta_sdp_m2 || 0} m² (${dCB.delta_sdp_pct || 0}%)`,
    delta_CB_cout: `${dCB.delta_cout_fcfa ? Math.round(dCB.delta_cout_fcfa / 1e6) : 0}M FCFA (${dCB.delta_cout_pct || 0}%)`,
    delta_CB_unites: `${dCB.delta_unites || 0} logements`,
    // ── PHASAGE (texte plat) ──
    phasage_text: phasage.text || "",
    phasage_duree_mois: String((phasage.structured || {}).duree_totale_mois || ""),
    phasage_nb_phases: String((phasage.structured || {}).phases ? phasage.structured.phases.length : 1),
    // ── ORIENTATION SOLAIRE (texte plat) ──
    orient_zone: orient.zone_climatique || "",
    orient_facade_optimale: orient.facade_optimale || "",
    orient_facade_proteger: orient.facade_a_proteger || "",
    orient_ventilation: orient.ventilation_traversante ? "OUI" : "NON",
    orient_brise_soleil: orient.brise_soleil_ouest ? "OUI" : "NON",
    orient_malus_pct: String(orient.malus_orientation_pct || 0),
    orient_recommandation: orient.recommandation || "",
    // ── RETRAITS (texte plat) ──
    retrait_avant: `${retr.avant_m || 0}m`,
    retrait_lateral: `${retr.lateral_m || 0}m`,
    retrait_arriere: `${retr.arriere_m || 0}m`,
    retrait_mitoyennete: String(retr.mitoyennete_cotes || 0),
    retrait_emprise_constructible: `${retr.emprise_constructible_m2 || 0} m²`,
    retrait_reduction_pct: `${retr.reduction_pct || 0}%`,
    // ── SCENARIO A (champs plats) ──
    A_fp: String(sA.fp_m2 || 0), A_fp_rdc: String(sA.fp_rdc_m2 || 0),
    A_levels: String(sA.levels || 0), A_height: String(sA.height_m || 0),
    A_sdp: String(sA.sdp_m2 || 0), A_units: String(sA.total_units || 0),
    A_commerce_levels: String(sA.commerce_levels || 0),
    A_has_pilotis: String(!!sA.has_pilotis),
    A_accent_color: sA.accent_color || "#2a5298",
    A_role: sA.label_fr || "INTENSIFICATION",
    A_split_layout: sA.split_layout ? JSON.stringify(sA.split_layout) : "",
    A_unit_mix: sA.unit_mix_detail || "", A_m2_par_logt: String(sA.m2_habitable_par_logement || 0),
    A_cost_total: `${sA.cost_total_fcfa ? Math.round(sA.cost_total_fcfa / 1e6) : 0}M FCFA`,
    A_cost_bas: `${sA.cout_fourchette ? Math.round(sA.cout_fourchette.bas / 1e6) : 0}M`,
    A_cost_haut: `${sA.cout_fourchette ? Math.round(sA.cout_fourchette.haut / 1e6) : 0}M`,
    A_cost_m2: `${sA.cost_per_m2_sdp ? Math.round(sA.cost_per_m2_sdp / 1000) : 0}k FCFA/m²`,
    A_cost_unit: `${sA.cost_per_unit ? Math.round(sA.cost_per_unit / 1e6) : 0}M FCFA`,
    A_budget_fit: sA.budget_fit || "",
    A_typology: sA.typology || "BLOC",
    A_typology_desc: (sA.typology_impact || {}).description || "",
    A_ces_pct: String(sA.ces_fill_pct || 0), A_cos_pct: String(sA.cos_ratio_pct || 0),
    A_cos_compliance: sA.cos_compliance || "",
    A_free_ground: `${sA.free_ground_m2 || 0} m²`,
    A_parking_places: String((sA.parking_detail || {}).places_disponibles || 0),
    A_parking_deficit: String((sA.parking_detail || {}).deficit || 0),
    A_parking_source: (sA.parking_detail || {}).source || "",
    A_duree_chantier: `${sA.duree_chantier_mois || 0} mois`,
    A_score: String(sA.recommendation_score || 0),
    A_hab_m2: String(sA.surface_habitable_m2 || sA.total_useful_m2 || 0),
    A_efficacite: `${sA.ratio_efficacite_pct || 0}%`,
    A_ventil_go: `${(sA.cout_ventilation || {}).gros_oeuvre_fcfa ? Math.round(sA.cout_ventilation.gros_oeuvre_fcfa / 1e6) : 0}M`,
    A_ventil_so: `${(sA.cout_ventilation || {}).second_oeuvre_fcfa ? Math.round(sA.cout_ventilation.second_oeuvre_fcfa / 1e6) : 0}M`,
    A_ventil_lt: `${(sA.cout_ventilation || {}).lots_techniques_fcfa ? Math.round(sA.cout_ventilation.lots_techniques_fcfa / 1e6) : 0}M`,
    A_ventil_vrd: `${(sA.cout_ventilation || {}).vrd_fcfa ? Math.round(sA.cout_ventilation.vrd_fcfa / 1e6) : 0}M`,
    A_ventil_hono: `${(sA.cout_ventilation || {}).honoraires_architecte ? Math.round(((sA.cout_ventilation || {}).honoraires_architecte || {}).median_fcfa / 1e6) : 0}M`,
    A_ventil_hono_bas: `${(sA.cout_ventilation || {}).honoraires_architecte ? Math.round(((sA.cout_ventilation || {}).honoraires_architecte || {}).bas_fcfa / 1e6) : 0}M`,
    A_ventil_hono_haut: `${(sA.cout_ventilation || {}).honoraires_architecte ? Math.round(((sA.cout_ventilation || {}).honoraires_architecte || {}).haut_fcfa / 1e6) : 0}M`,
    A_hono_taux_bas: `${((sA.cout_ventilation || {}).honoraires_architecte || {}).taux_bas_pct || 0}%`,
    A_hono_taux_haut: `${((sA.cout_ventilation || {}).honoraires_architecte || {}).taux_haut_pct || 0}%`,
    A_frais_annexes: `${(sA.cout_ventilation || {}).frais_annexes ? Math.round(sA.cout_ventilation.frais_annexes.total_frais_annexes_fcfa / 1e6) : 0}M`,
    A_frais_permis: `${(sA.cout_ventilation || {}).frais_annexes ? Math.round(sA.cout_ventilation.frais_annexes.permis_construire_fcfa / 1e6) : 0}M`,
    A_frais_assurance: `${(sA.cout_ventilation || {}).frais_annexes ? Math.round(sA.cout_ventilation.frais_annexes.assurance_dommage_ouvrage_fcfa / 1e6) : 0}M`,
    A_frais_etudes: `${(sA.cout_ventilation || {}).frais_annexes ? Math.round(sA.cout_ventilation.frais_annexes.etudes_techniques_fcfa / 1e6) : 0}M`,
    A_frais_divers: `${(sA.cout_ventilation || {}).frais_annexes ? Math.round(sA.cout_ventilation.frais_annexes.divers_imprevus_fcfa / 1e6) : 0}M`,
    A_ventil_global: `${(sA.cout_ventilation || {}).cout_global_projet_fcfa ? Math.round(sA.cout_ventilation.cout_global_projet_fcfa / 1e6) : 0}M FCFA`,
    // ── SCENARIO B (champs plats) ──
    B_fp: String(sB.fp_m2 || 0), B_fp_rdc: String(sB.fp_rdc_m2 || 0),
    B_levels: String(sB.levels || 0), B_height: String(sB.height_m || 0),
    B_sdp: String(sB.sdp_m2 || 0), B_units: String(sB.total_units || 0),
    B_commerce_levels: String(sB.commerce_levels || 0),
    B_has_pilotis: String(!!sB.has_pilotis),
    B_accent_color: sB.accent_color || "#34a853",
    B_role: sB.label_fr || "EQUILIBRE",
    B_split_layout: sB.split_layout ? JSON.stringify(sB.split_layout) : "",
    B_unit_mix: sB.unit_mix_detail || "", B_m2_par_logt: String(sB.m2_habitable_par_logement || 0),
    B_cost_total: `${sB.cost_total_fcfa ? Math.round(sB.cost_total_fcfa / 1e6) : 0}M FCFA`,
    B_cost_bas: `${sB.cout_fourchette ? Math.round(sB.cout_fourchette.bas / 1e6) : 0}M`,
    B_cost_haut: `${sB.cout_fourchette ? Math.round(sB.cout_fourchette.haut / 1e6) : 0}M`,
    B_cost_m2: `${sB.cost_per_m2_sdp ? Math.round(sB.cost_per_m2_sdp / 1000) : 0}k FCFA/m²`,
    B_cost_unit: `${sB.cost_per_unit ? Math.round(sB.cost_per_unit / 1e6) : 0}M FCFA`,
    B_budget_fit: sB.budget_fit || "",
    B_typology: sB.typology || "BLOC",
    B_typology_desc: (sB.typology_impact || {}).description || "",
    B_ces_pct: String(sB.ces_fill_pct || 0), B_cos_pct: String(sB.cos_ratio_pct || 0),
    B_cos_compliance: sB.cos_compliance || "",
    B_free_ground: `${sB.free_ground_m2 || 0} m²`,
    B_parking_places: String((sB.parking_detail || {}).places_disponibles || 0),
    B_parking_deficit: String((sB.parking_detail || {}).deficit || 0),
    B_parking_source: (sB.parking_detail || {}).source || "",
    B_duree_chantier: `${sB.duree_chantier_mois || 0} mois`,
    B_score: String(sB.recommendation_score || 0),
    B_hab_m2: String(sB.surface_habitable_m2 || sB.total_useful_m2 || 0),
    B_efficacite: `${sB.ratio_efficacite_pct || 0}%`,
    B_ventil_go: `${(sB.cout_ventilation || {}).gros_oeuvre_fcfa ? Math.round(sB.cout_ventilation.gros_oeuvre_fcfa / 1e6) : 0}M`,
    B_ventil_so: `${(sB.cout_ventilation || {}).second_oeuvre_fcfa ? Math.round(sB.cout_ventilation.second_oeuvre_fcfa / 1e6) : 0}M`,
    B_ventil_lt: `${(sB.cout_ventilation || {}).lots_techniques_fcfa ? Math.round(sB.cout_ventilation.lots_techniques_fcfa / 1e6) : 0}M`,
    B_ventil_vrd: `${(sB.cout_ventilation || {}).vrd_fcfa ? Math.round(sB.cout_ventilation.vrd_fcfa / 1e6) : 0}M`,
    B_ventil_hono: `${(sB.cout_ventilation || {}).honoraires_architecte ? Math.round(((sB.cout_ventilation || {}).honoraires_architecte || {}).median_fcfa / 1e6) : 0}M`,
    B_ventil_hono_bas: `${(sB.cout_ventilation || {}).honoraires_architecte ? Math.round(((sB.cout_ventilation || {}).honoraires_architecte || {}).bas_fcfa / 1e6) : 0}M`,
    B_ventil_hono_haut: `${(sB.cout_ventilation || {}).honoraires_architecte ? Math.round(((sB.cout_ventilation || {}).honoraires_architecte || {}).haut_fcfa / 1e6) : 0}M`,
    B_hono_taux_bas: `${((sB.cout_ventilation || {}).honoraires_architecte || {}).taux_bas_pct || 0}%`,
    B_hono_taux_haut: `${((sB.cout_ventilation || {}).honoraires_architecte || {}).taux_haut_pct || 0}%`,
    B_frais_annexes: `${(sB.cout_ventilation || {}).frais_annexes ? Math.round(sB.cout_ventilation.frais_annexes.total_frais_annexes_fcfa / 1e6) : 0}M`,
    B_frais_permis: `${(sB.cout_ventilation || {}).frais_annexes ? Math.round(sB.cout_ventilation.frais_annexes.permis_construire_fcfa / 1e6) : 0}M`,
    B_frais_assurance: `${(sB.cout_ventilation || {}).frais_annexes ? Math.round(sB.cout_ventilation.frais_annexes.assurance_dommage_ouvrage_fcfa / 1e6) : 0}M`,
    B_frais_etudes: `${(sB.cout_ventilation || {}).frais_annexes ? Math.round(sB.cout_ventilation.frais_annexes.etudes_techniques_fcfa / 1e6) : 0}M`,
    B_frais_divers: `${(sB.cout_ventilation || {}).frais_annexes ? Math.round(sB.cout_ventilation.frais_annexes.divers_imprevus_fcfa / 1e6) : 0}M`,
    B_ventil_global: `${(sB.cout_ventilation || {}).cout_global_projet_fcfa ? Math.round(sB.cout_ventilation.cout_global_projet_fcfa / 1e6) : 0}M FCFA`,
    // ── SCENARIO C (champs plats) ──
    C_fp: String(sC.fp_m2 || 0), C_fp_rdc: String(sC.fp_rdc_m2 || 0),
    C_commerce_levels: String(sC.commerce_levels || 0),
    C_has_pilotis: String(!!sC.has_pilotis),
    C_accent_color: sC.accent_color || "#ea4335",
    C_role: sC.label_fr || "PRUDENT",
    C_split_layout: sC.split_layout ? JSON.stringify(sC.split_layout) : "",
    C_levels: String(sC.levels || 0), C_height: String(sC.height_m || 0),
    C_sdp: String(sC.sdp_m2 || 0), C_units: String(sC.total_units || 0),
    C_unit_mix: sC.unit_mix_detail || "", C_m2_par_logt: String(sC.m2_habitable_par_logement || 0),
    C_cost_total: `${sC.cost_total_fcfa ? Math.round(sC.cost_total_fcfa / 1e6) : 0}M FCFA`,
    C_cost_bas: `${sC.cout_fourchette ? Math.round(sC.cout_fourchette.bas / 1e6) : 0}M`,
    C_cost_haut: `${sC.cout_fourchette ? Math.round(sC.cout_fourchette.haut / 1e6) : 0}M`,
    C_cost_m2: `${sC.cost_per_m2_sdp ? Math.round(sC.cost_per_m2_sdp / 1000) : 0}k FCFA/m²`,
    C_cost_unit: `${sC.cost_per_unit ? Math.round(sC.cost_per_unit / 1e6) : 0}M FCFA`,
    C_budget_fit: sC.budget_fit || "",
    C_typology: sC.typology || "BLOC",
    C_typology_desc: (sC.typology_impact || {}).description || "",
    C_ces_pct: String(sC.ces_fill_pct || 0), C_cos_pct: String(sC.cos_ratio_pct || 0),
    C_cos_compliance: sC.cos_compliance || "",
    C_free_ground: `${sC.free_ground_m2 || 0} m²`,
    C_parking_places: String((sC.parking_detail || {}).places_disponibles || 0),
    C_parking_deficit: String((sC.parking_detail || {}).deficit || 0),
    C_parking_source: (sC.parking_detail || {}).source || "",
    C_duree_chantier: `${sC.duree_chantier_mois || 0} mois`,
    C_score: String(sC.recommendation_score || 0),
    C_hab_m2: String(sC.surface_habitable_m2 || sC.total_useful_m2 || 0),
    C_efficacite: `${sC.ratio_efficacite_pct || 0}%`,
    C_ventil_go: `${(sC.cout_ventilation || {}).gros_oeuvre_fcfa ? Math.round(sC.cout_ventilation.gros_oeuvre_fcfa / 1e6) : 0}M`,
    C_ventil_so: `${(sC.cout_ventilation || {}).second_oeuvre_fcfa ? Math.round(sC.cout_ventilation.second_oeuvre_fcfa / 1e6) : 0}M`,
    C_ventil_lt: `${(sC.cout_ventilation || {}).lots_techniques_fcfa ? Math.round(sC.cout_ventilation.lots_techniques_fcfa / 1e6) : 0}M`,
    C_ventil_vrd: `${(sC.cout_ventilation || {}).vrd_fcfa ? Math.round(sC.cout_ventilation.vrd_fcfa / 1e6) : 0}M`,
    C_ventil_hono: `${(sC.cout_ventilation || {}).honoraires_architecte ? Math.round(((sC.cout_ventilation || {}).honoraires_architecte || {}).median_fcfa / 1e6) : 0}M`,
    C_ventil_hono_bas: `${(sC.cout_ventilation || {}).honoraires_architecte ? Math.round(((sC.cout_ventilation || {}).honoraires_architecte || {}).bas_fcfa / 1e6) : 0}M`,
    C_ventil_hono_haut: `${(sC.cout_ventilation || {}).honoraires_architecte ? Math.round(((sC.cout_ventilation || {}).honoraires_architecte || {}).haut_fcfa / 1e6) : 0}M`,
    C_hono_taux_bas: `${((sC.cout_ventilation || {}).honoraires_architecte || {}).taux_bas_pct || 0}%`,
    C_hono_taux_haut: `${((sC.cout_ventilation || {}).honoraires_architecte || {}).taux_haut_pct || 0}%`,
    C_frais_annexes: `${(sC.cout_ventilation || {}).frais_annexes ? Math.round(sC.cout_ventilation.frais_annexes.total_frais_annexes_fcfa / 1e6) : 0}M`,
    C_frais_permis: `${(sC.cout_ventilation || {}).frais_annexes ? Math.round(sC.cout_ventilation.frais_annexes.permis_construire_fcfa / 1e6) : 0}M`,
    C_frais_assurance: `${(sC.cout_ventilation || {}).frais_annexes ? Math.round(sC.cout_ventilation.frais_annexes.assurance_dommage_ouvrage_fcfa / 1e6) : 0}M`,
    C_frais_etudes: `${(sC.cout_ventilation || {}).frais_annexes ? Math.round(sC.cout_ventilation.frais_annexes.etudes_techniques_fcfa / 1e6) : 0}M`,
    C_frais_divers: `${(sC.cout_ventilation || {}).frais_annexes ? Math.round(sC.cout_ventilation.frais_annexes.divers_imprevus_fcfa / 1e6) : 0}M`,
    C_ventil_global: `${(sC.cout_ventilation || {}).cout_global_projet_fcfa ? Math.round(sC.cout_ventilation.cout_global_projet_fcfa / 1e6) : 0}M FCFA`,
    // ══ v72.60: TEXT INJECTION — champs pré-calculés pour GPT ══
    A_R_plus: txtA.R_plus || "R+0",
    A_gabarit: txtA.gabarit || "",
    A_unit_summary: txtA.unit_summary || "",
    A_logement_count: txtA.logement_count || "0",
    A_commerce_count: txtA.commerce_count || "0",
    A_hab_m2_total: txtA.hab_m2 || "0",
    A_circ_pct: txtA.circ_pct || "0%",
    A_circ_m2: txtA.circ_m2 || "0",
    A_m2_hab_par_unite: txtA.m2_hab_par_unite || "0",
    A_budget_equation: txtA.budget_equation || "",
    A_ventil_equation: txtA.ventil_equation || "",
    A_cost_per_m2_text: txtA.cost_per_m2_text || "",
    A_commerce_cost_info: txtA.commerce_cost_info || "",
    A_travaux_M: txtA.travaux_M || "0",
    A_vrd_M: txtA.vrd_M || "0",
    A_hono_median_M: txtA.hono_median_M || "0",
    A_hono_bas_M: txtA.hono_bas_M || "0",
    A_hono_haut_M: txtA.hono_haut_M || "0",
    A_frais_M: txtA.frais_M || "0",
    A_global_M: txtA.global_M || "0",
    A_fourchette_text: txtA.fourchette_text || "",
    A_cos_depassement_text: txtA.cos_depassement_text || "",
    B_R_plus: txtB.R_plus || "R+0",
    B_gabarit: txtB.gabarit || "",
    B_unit_summary: txtB.unit_summary || "",
    B_logement_count: txtB.logement_count || "0",
    B_commerce_count: txtB.commerce_count || "0",
    B_hab_m2_total: txtB.hab_m2 || "0",
    B_circ_pct: txtB.circ_pct || "0%",
    B_circ_m2: txtB.circ_m2 || "0",
    B_m2_hab_par_unite: txtB.m2_hab_par_unite || "0",
    B_budget_equation: txtB.budget_equation || "",
    B_ventil_equation: txtB.ventil_equation || "",
    B_cost_per_m2_text: txtB.cost_per_m2_text || "",
    B_commerce_cost_info: txtB.commerce_cost_info || "",
    B_travaux_M: txtB.travaux_M || "0",
    B_vrd_M: txtB.vrd_M || "0",
    B_hono_median_M: txtB.hono_median_M || "0",
    B_hono_bas_M: txtB.hono_bas_M || "0",
    B_hono_haut_M: txtB.hono_haut_M || "0",
    B_frais_M: txtB.frais_M || "0",
    B_global_M: txtB.global_M || "0",
    B_fourchette_text: txtB.fourchette_text || "",
    B_cos_depassement_text: txtB.cos_depassement_text || "",
    C_R_plus: txtC.R_plus || "R+0",
    C_gabarit: txtC.gabarit || "",
    C_unit_summary: txtC.unit_summary || "",
    C_logement_count: txtC.logement_count || "0",
    C_commerce_count: txtC.commerce_count || "0",
    C_hab_m2_total: txtC.hab_m2 || "0",
    C_circ_pct: txtC.circ_pct || "0%",
    C_circ_m2: txtC.circ_m2 || "0",
    C_m2_hab_par_unite: txtC.m2_hab_par_unite || "0",
    C_budget_equation: txtC.budget_equation || "",
    C_ventil_equation: txtC.ventil_equation || "",
    C_cost_per_m2_text: txtC.cost_per_m2_text || "",
    C_commerce_cost_info: txtC.commerce_cost_info || "",
    C_travaux_M: txtC.travaux_M || "0",
    C_vrd_M: txtC.vrd_M || "0",
    C_hono_median_M: txtC.hono_median_M || "0",
    C_hono_bas_M: txtC.hono_bas_M || "0",
    C_hono_haut_M: txtC.hono_haut_M || "0",
    C_frais_M: txtC.frais_M || "0",
    C_global_M: txtC.global_M || "0",
    C_fourchette_text: txtC.fourchette_text || "",
    C_cos_depassement_text: txtC.cos_depassement_text || "",
    // ══ v72.60: PROMPT INJECTION — directives strictes pour GPT ══
    gpt_text_rules: `RÈGLES ABSOLUES POUR LA GÉNÉRATION DES TEXTES DIAGNOSTIC BARLO:
1. UTILISE UNIQUEMENT les champs {X}_budget_equation, {X}_ventil_equation, {X}_unit_summary, {X}_R_plus, {X}_gabarit TELS QUELS. NE JAMAIS recalculer, inventer ou arrondir différemment.
2. Notation gabarit: utilise TOUJOURS le champ {X}_R_plus (ex: R+3, R+2, R+1). Ne JAMAIS deviner la notation R+.
3. Unités: utilise {X}_unit_summary tel quel. Ne JAMAIS changer le nombre d'unités ou les types.
4. Financier: TOUJOURS au conditionnel ("s'élèverait à", "atteindrait"). TOUJOURS présenter la fourchette {X}_fourchette_text.
5. Surface: parler de "surface habitable hors circulations" ({X}_hab_m2_total m²), JAMAIS de "surface nette".
6. Budget equation: {X}_budget_equation est la SEULE décomposition autorisée. Les sous-totaux DOIVENT additionner au global.
7. Ventilation: {X}_ventil_equation est la SEULE ventilation autorisée.
8. Commerce: {X}_commerce_cost_info doit être mentionné pour expliquer le différentiel de coût.
9. COS: {X}_cos_depassement_text est la seule formulation autorisée pour le dépassement réglementaire.
10. Scenario A = EXACTEMENT la demande client (pas d'intensification idiote). B = équilibre justifié. C = prudent compact.
11. Ne JAMAIS poser de question directe au client. Utiliser "La question qui se pose ici sera de savoir si... ou si..."
12. Commencer slide_3 (intro) par "Ce projet consiste" SANS mentionner le nom du client.
13. PAS DE CONCLUSION sur le respect budgétaire en slide_3. Juste expliquer le rôle de chaque scénario.`,
    // ── PROFIL CLIENT (echo) ──
    profil_posture: profil.posture || "",
    profil_budget_band: profil.budget_band || "",
    profil_budget_max: `${profil.budget_max_fcfa ? Math.round(profil.budget_max_fcfa / 1e6) : 0}M FCFA`,
    profil_standing: profil.standing || "",
    profil_programme: profil.programme || "",
    profil_cible_unites: String(profil.cible_unites || 0),
    // ── SITE DIAG ──
    site_ces_regl: `${siteDiag.ces_reglementaire_pct || 0}%`,
    site_cos_regl: String(siteDiag.cos_reglementaire || 0),
    site_hauteur_max: `${siteDiag.hauteur_max_m || 0}m`,
    site_niveaux_max: String(siteDiag.niveaux_max || 0),
    site_emprise_max: `${siteDiag.emprise_max_m2 || 0} m²`,
    site_sdp_max: `${siteDiag.sdp_max_m2 || 0} m²`,
  };
  // ── v72.51: Inclure les scores calculés dans la réponse pour que Make.com les écrive dans le Sheet ──
  const computed_scores = {
    rent_score_norm: calc_rent_score_norm,
    capacity_score_norm: calc_capacity_score_norm,
    risk_score_norm: calc_risk_score_norm,
    rent_score: Math.round(calc_rent_score),
    capacity_score: Math.round(calc_capacity_score),
    mix_score_norm: calc_mix_score_norm,
    phase_score_norm: calc_phase_score_norm,
    phase_score: calc_phase_score,
    risk_score: calc_risk_score,
    density_band: calc_density_band,
    density_pressure_factor: calc_density_pressure_factor,
    risk_adjusted: calc_risk_adjusted,
    second_best_score: calc_second_best_score,
    dominance_gap: calc_dominance_gap,
    density_band_calc: calc_density_band_calc,
    budget_tension_calc: calc_budget_tension_calc,
    feasibility_posture_calc: calc_feasibility_posture,
    program_intent_calc: calc_program_intent,
    program_alignment_calc: calc_program_alignment,
    strategic_position_calc: calc_strategic_position,
    recommended_scenario_calc: calc_recommended_scenario,
    driver_intensity: calc_driver_intensity,
  };
  // ══════════════════════════════════════════════════════════════════════
  // v72.60: PROMPTS GPT PRÉ-CONSTRUITS — Make.com mappe SEULEMENT 2 champs
  // gpt_system_prompt → Message 1 (system) dans le module OpenAI
  // gpt_user_prompt   → Message 2 (user) dans le module OpenAI
  // Toutes les valeurs sont DÉJÀ injectées → zéro mapping de variables
  // ══════════════════════════════════════════════════════════════════════
  const _f = flat; // alias court
  const _quartier = String(p.quartier || p.localisation || p.city || "Douala");
  const _clientName = String(p.client_name || p.nom_client || "");

  flat.gpt_system_prompt = `Tu es un architecte-urbaniste expert en diagnostic immobilier au Cameroun, avec 20 ans d'expérience sur des projets résidentiels et mixtes à Douala. Tu rédiges les textes d'un rapport diagnostic professionnel pour un client investisseur.

${_f.gpt_text_rules}

IDENTITÉ DU TON :
Tu écris comme un architecte conseil qui s'adresse à son client en face-à-face : professionnel, naturel, rassurant mais honnête. Tu expliques les choix comme si tu dessinais sur une nappe — pas de jargon gratuit, pas de phrases creuses, pas de copier-coller administratif.
- Chaque phrase doit APPORTER une information ou un raisonnement. Pas de remplissage.
- Tu guides le client dans sa réflexion, tu ne lui assènes pas des vérités.
- Quand tu parles d'un risque, tu l'expliques concrètement ET tu donnes la solution ou l'atténuation.

RÈGLES DE RÉDACTION STRICTES :
- TOUJOURS au conditionnel pour tout montant ("s'élèverait à", "se situerait autour de", "représenterait").
- JAMAIS de question directe au client. Formulation : "La question qui se pose ici sera de savoir si… ou si…"
- Dire "surface habitable hors circulations", JAMAIS "surface nette" ni "surface utile nette".
- Ne JAMAIS inventer un chiffre. Si un champ est vide ou 0, ignorer le point silencieusement.
- Ne JAMAIS faire d'addition, multiplication ou division — UNIQUEMENT utiliser les valeurs pré-calculées.
- JAMAIS de phrase générique applicable à n'importe quel projet. Chaque phrase doit être SPÉCIFIQUE à ce terrain, ce programme, ce budget.

LOGIQUE DES SCÉNARIOS :
- A = la réponse FIDÈLE à la demande du client. Dimensionnement optimal pour SON programme, SON nombre d'unités. Pas une intensification délirante.
- B = alternative équilibrée : même objectif mais avec des compromis justifiés (moins de niveaux, emprise réduite, coût maîtrisé). B est TOUJOURS moins cher que A.
- C = prudent/compact : enveloppe réduite, budget maîtrisé, conformité réglementaire sécurisée. Le filet de sécurité.

FINANCIER :
- DÉMONTRER le raisonnement étape par étape : d'abord le coût unitaire au m² (contexte local + standing), puis la surface totale, puis les postes complémentaires (VRD, honoraires, frais).
- TOUJOURS donner la fourchette réaliste, pas juste un chiffre.
- Le commerce est construit à 80% du coût du bâtiment — mentionner systématiquement quand l'info est fournie.
- Chaque somme citée doit correspondre EXACTEMENT aux données fournies. Zéro arrondi personnel.

RISQUES :
- SPÉCIFIQUES et CHIFFRÉS. Pas "il y a un risque de dépassement" mais "une hausse de 10% des matériaux ajouterait XM au budget".
- Chaque risque est suivi d'une piste de mitigation ou d'une conséquence concrète.

SPLIT / PILOTIS :
- Quand un scénario est en SPLIT (commerce devant + logement arrière sur pilotis), EXPLIQUER le choix : intimité résidentielle, accès séparés, ventilation naturelle optimisée, RDC sur pilotis = parking couvert ou local technique.
- Bien distinguer les 2 volumes : volume commercial (RDC clôture) et volume logement (sur pilotis derrière).`;

  flat.gpt_user_prompt = `Génère les textes du diagnostic immobilier. Respecte STRICTEMENT les données — NE RECALCULE RIEN.

═══ CONTEXTE PROJET ═══
Client : ${_clientName}
Localisation : ${_quartier}, Douala
Terrain : ${p.site_area || 0} m² (${_f.retrait_emprise_constructible} constructibles après retraits)
Retraits : avant ${_f.retrait_avant}, latéral ${_f.retrait_lateral}, arrière ${_f.retrait_arriere}
Mitoyenneté : ${_f.retrait_mitoyennete} côté(s)
Zoning : ${p.zoning_type || "URBAIN"}
Programme : ${_f.profil_programme} — ${_f.profil_cible_unites} unités, standing ${_f.profil_standing}
Budget client : ${_f.profil_budget_max}
Enveloppe bâtie : ${p.envelope_w || 0} × ${p.envelope_d || 0} m
COS réglementaire : ${_f.site_cos_regl} → SDP max autorisée : ${_f.site_sdp_max}
Orientation : façade optimale ${_f.orient_facade_optimale}, façade à protéger ${_f.orient_facade_proteger}
Ventilation traversante : ${_f.orient_ventilation} | Brise-soleil : ${_f.orient_brise_soleil}
Scénario recommandé : ${_f.rec_scenario} (score ${_f.rec_score}/100)

═══ SCÉNARIO A — ${_f.A_role} ═══
Gabarit : ${_f.A_R_plus} — ${_f.A_gabarit}
Emprise : ${_f.A_fp} m² (CES ${_f.A_ces_pct}%)
SDP totale : ${_f.A_sdp} m²
Programme : ${_f.A_unit_summary}
Surface habitable hors circulations : ${_f.A_hab_m2_total} m² | Circulations : ${_f.A_circ_pct} (${_f.A_circ_m2} m²)
Surface habitable moyenne par unité : ${_f.A_m2_hab_par_unite} m²
Typologie : ${_f.A_typology} — ${_f.A_typology_desc}
COS : ${_f.A_cos_depassement_text}
Coût/m² : ${_f.A_cost_per_m2_text}
${_f.A_commerce_cost_info}
Ventilation construction : ${_f.A_ventil_equation}
Budget : ${_f.A_budget_equation}
Fourchette : ${_f.A_fourchette_text}
Budget global : ${_f.A_global_M}M FCFA
Honoraires : entre ${_f.A_hono_bas_M}M et ${_f.A_hono_haut_M}M (${_f.A_hono_taux_bas} à ${_f.A_hono_taux_haut})
Frais annexes : ${_f.A_frais_M}M
Durée chantier : ${_f.A_duree_chantier}
Mix détaillé : ${_f.A_unit_mix}

═══ SCÉNARIO B — ${_f.B_role} ═══
Gabarit : ${_f.B_R_plus} — ${_f.B_gabarit}
Emprise : ${_f.B_fp} m² (CES ${_f.B_ces_pct}%)
SDP totale : ${_f.B_sdp} m²
Programme : ${_f.B_unit_summary}
Surface habitable hors circulations : ${_f.B_hab_m2_total} m² | Circulations : ${_f.B_circ_pct} (${_f.B_circ_m2} m²)
Surface habitable moyenne par unité : ${_f.B_m2_hab_par_unite} m²
Typologie : ${_f.B_typology} — ${_f.B_typology_desc}
COS : ${_f.B_cos_depassement_text}
Coût/m² : ${_f.B_cost_per_m2_text}
${_f.B_commerce_cost_info}
Ventilation construction : ${_f.B_ventil_equation}
Budget : ${_f.B_budget_equation}
Fourchette : ${_f.B_fourchette_text}
Budget global : ${_f.B_global_M}M FCFA
Honoraires : entre ${_f.B_hono_bas_M}M et ${_f.B_hono_haut_M}M (${_f.B_hono_taux_bas} à ${_f.B_hono_taux_haut})
Frais annexes : ${_f.B_frais_M}M
Durée chantier : ${_f.B_duree_chantier}
Mix détaillé : ${_f.B_unit_mix}

═══ SCÉNARIO C — ${_f.C_role} ═══
Gabarit : ${_f.C_R_plus} — ${_f.C_gabarit}
Emprise : ${_f.C_fp} m² (CES ${_f.C_ces_pct}%)
SDP totale : ${_f.C_sdp} m²
Programme : ${_f.C_unit_summary}
Surface habitable hors circulations : ${_f.C_hab_m2_total} m² | Circulations : ${_f.C_circ_pct} (${_f.C_circ_m2} m²)
Surface habitable moyenne par unité : ${_f.C_m2_hab_par_unite} m²
Typologie : ${_f.C_typology} — ${_f.C_typology_desc}
COS : ${_f.C_cos_depassement_text}
Coût/m² : ${_f.C_cost_per_m2_text}
${_f.C_commerce_cost_info}
Ventilation construction : ${_f.C_ventil_equation}
Budget : ${_f.C_budget_equation}
Fourchette : ${_f.C_fourchette_text}
Budget global : ${_f.C_global_M}M FCFA
Honoraires : entre ${_f.C_hono_bas_M}M et ${_f.C_hono_haut_M}M (${_f.C_hono_taux_bas} à ${_f.C_hono_taux_haut})
Frais annexes : ${_f.C_frais_M}M
Durée chantier : ${_f.C_duree_chantier}
Mix détaillé : ${_f.C_unit_mix}

═══ COMPARATIFS ═══
Delta B vs A : SDP ${_f.delta_BA_sdp}, coût ${_f.delta_BA_cout}
Delta C vs A : SDP ${_f.delta_CA_sdp}, coût ${_f.delta_CA_cout}
Delta C vs B : SDP ${_f.delta_CB_sdp}, coût ${_f.delta_CB_cout}
Phasage : ${_f.phasage_text}
Durée totale : ${_f.phasage_duree_mois} mois en ${_f.phasage_nb_phases} phase(s)

═══ TEXTES À GÉNÉRER ═══
Génère EXACTEMENT les champs suivants. Retourne UNIQUEMENT un JSON valide avec ces clés :

{
  "slide_3_intro_text": "[Commence par 'Ce projet consiste à valoriser un terrain de ${p.site_area || 0} m² à ${_quartier}, Douala'. NE PAS mentionner le nom du client. Présenter le programme (mixte, standing, budget). Nommer les 3 scénarios (A=${_f.A_role}, B=${_f.B_role}, C=${_f.C_role}) et expliquer leur rôle. NE PAS donner de conclusion budgétaire ici. Dire que le diagnostic éclairera le choix. 4-6 phrases.]",

  "slide_3_programme_text": "[Programme : ${_f.profil_cible_unites} unités, standing ${_f.profil_standing}. SDP max ${_f.site_sdp_max}. Retraits → emprise ${_f.retrait_emprise_constructible}. NE PAS détailler les scénarios. Plans en APS. 3-4 phrases.]",

  "slide_4_text": "[Terrain ${p.site_area || 0} m², ~${p.envelope_w || 0}m × ${p.envelope_d || 0}m. Retraits → ${_f.retrait_emprise_constructible}. Accès voie publique. Mitoyenneté ${_f.retrait_mitoyennete} côté(s). Impact ouvertures, ventilation. 4-5 phrases.]",

  "slide_5_text": "[COS limite SDP à ${_f.site_sdp_max}. A: ${_f.A_cos_depassement_text}. B: ${_f.B_cos_depassement_text}. C: ${_f.C_cos_depassement_text}. Rapport à la rue, mitoyenneté. 4-6 phrases.]",

  "scenario_A_summary_text": "[${_f.A_role}. ${_f.A_R_plus}, ${_f.A_gabarit}. SDP ${_f.A_sdp} m² sur ${_f.A_fp} m². Si SPLIT/pilotis: expliquer intimité, accès séparé, pilotis=parking. ${_f.A_unit_summary}. Habitable: ${_f.A_hab_m2_total} m² hors circ (${_f.A_circ_pct}). Moyenne ${_f.A_m2_hab_par_unite} m²/unité. Répond EXACTEMENT à la demande. 5-7 phrases. Finir par 'La question qui se pose...']",

  "scenario_A_financial_text": "[Standing ${_f.profil_standing}. Coût ${_f.A_cost_per_m2_text} pour ${_f.A_sdp} m². ${_f.A_commerce_cost_info}. Ventilation: ${_f.A_ventil_equation}. VRD ${_f.A_vrd_M}M. Honoraires ${_f.A_hono_bas_M}M-${_f.A_hono_haut_M}M. Frais ${_f.A_frais_M}M. TOTAL: ${_f.A_budget_equation}. Fourchette: ${_f.A_fourchette_text}. Vs budget ${_f.profil_budget_max}. CONDITIONNEL. 6-8 phrases.]",

  "scenario_A_risk_text": "[1) ${_f.A_cos_depassement_text} → refus permis possible. 2) Hausse 10% = +${Math.round(Number(_f.A_global_M) * 0.1)}M. 3) Complexité ${_f.A_R_plus}. 4) Circulations ${_f.A_circ_pct}. CHAQUE risque chiffré. 4-5 phrases.]",

  "scenario_B_summary_text": "[${_f.B_role}. ${_f.B_R_plus}, ${_f.B_gabarit}. SDP ${_f.B_sdp} m² sur ${_f.B_fp} m². ${_f.B_unit_summary}. Habitable: ${_f.B_hab_m2_total} m² (${_f.B_circ_pct}). Moyenne ${_f.B_m2_hab_par_unite} m²/unité. JUSTIFIER en quoi B est plus équilibré que A: moins de niveaux, emprise réduite, coût moindre. 5-7 phrases. 'La question qui se pose...']",

  "scenario_B_financial_text": "[Coût ${_f.B_cost_per_m2_text} pour ${_f.B_sdp} m². ${_f.B_commerce_cost_info}. Ventilation: ${_f.B_ventil_equation}. TOTAL: ${_f.B_budget_equation}. Fourchette: ${_f.B_fourchette_text}. B toujours moins cher que A. CONDITIONNEL. 6-8 phrases.]",

  "scenario_B_risk_text": "[COS: ${_f.B_cos_depassement_text}. Compacité ${_f.B_m2_hab_par_unite} m²/unité. Hausse 10% = +${Math.round(Number(_f.B_global_M) * 0.1)}M. Structure simplifiée vs A. 3-4 phrases.]",

  "scenario_C_summary_text": "[${_f.C_role}. ${_f.C_R_plus}, ${_f.C_gabarit}. SDP ${_f.C_sdp} m² sur ${_f.C_fp} m². ${_f.C_unit_summary}. Habitable: ${_f.C_hab_m2_total} m² (${_f.C_circ_pct}). Moyenne ${_f.C_m2_hab_par_unite} m²/unité. Compact, maîtrise budget. 5-7 phrases. 'La question qui se pose...']",

  "scenario_C_financial_text": "[Coût ${_f.C_cost_per_m2_text} pour ${_f.C_sdp} m². ${_f.C_commerce_cost_info}. Ventilation: ${_f.C_ventil_equation}. TOTAL: ${_f.C_budget_equation}. Fourchette: ${_f.C_fourchette_text}. Le plus proche du budget client. CONDITIONNEL. 6-8 phrases.]",

  "scenario_C_risk_text": "[COS: ${_f.C_cos_depassement_text}. Compacité ${_f.C_m2_hab_par_unite} m²/unité. Hausse 10% = +${Math.round(Number(_f.C_global_M) * 0.1)}M. Faible emprise. 3-4 phrases.]",

  "comparatif_intro_text": "[A(${_f.A_sdp}m², ${_f.A_R_plus}), B(${_f.B_sdp}m², ${_f.B_R_plus}), C(${_f.C_sdp}m², ${_f.C_R_plus}). Écart A↔C: ${_f.delta_CA_sdp}/${_f.delta_CA_cout}. B entre les deux: ${_f.delta_CB_sdp}/${_f.delta_CB_cout}. 4-5 phrases.]",
  "comparatif_A_label": "${_f.A_role} — ${_f.A_R_plus}",
  "comparatif_B_label": "${_f.B_role} — ${_f.B_R_plus}",
  "comparatif_C_label": "${_f.C_role} — ${_f.C_R_plus}",
  "comparatif_A_sdp": "${_f.A_sdp} m²",
  "comparatif_B_sdp": "${_f.B_sdp} m²",
  "comparatif_C_sdp": "${_f.C_sdp} m²",
  "comparatif_A_cost": "${_f.A_global_M}M FCFA",
  "comparatif_B_cost": "${_f.B_global_M}M FCFA",
  "comparatif_C_cost": "${_f.C_global_M}M FCFA",
  "comparatif_A_units": "${_f.A_unit_summary}",
  "comparatif_B_units": "${_f.B_unit_summary}",
  "comparatif_C_units": "${_f.C_unit_summary}",

  "strategic_arbitrage_text": "[Arbitrage. Priorités client: programme ${_f.profil_programme}, budget ${_f.profil_budget_max}. Recommandation: ${_f.rec_scenario}. Pourquoi les autres sont moins adaptés. 5-7 phrases.]",

  "success_intro_text": "[Le scénario ${_f.rec_scenario} constitue la base la plus solide. 1-2 phrases.]",
  "success_technical_text": "[Technique du scénario recommandé. 4-5 phrases.]",
  "success_financial_text": "[Budget du recommandé. Position vs budget client. 4-5 phrases.]",
  "success_strategic_text": "[Phasage: ${_f.phasage_text}. Durée ${_f.phasage_duree_mois} mois. Saison des pluies. 4-5 phrases.]",

  "invisible_intro_text": "[Aspects techniques et administratifs à anticiper. 1-2 phrases.]",
  "invisible_technical_text": "[Fondations, ventilation mitoyenneté, accès chantier zone dense. 4-5 phrases.]",
  "invisible_financial_text": "[Honoraires, permis, études géotechniques, bureau contrôle. 4-5 phrases.]",
  "invisible_strategic_text": "[Phasage décaissements. Saison pluies. Logistique quartier dense. 4-5 phrases.]",

  "next_step_intro_text": "[Business plan et faisabilité sur le scénario recommandé. 2-3 phrases.]",
  "next_step_scope_text": "[APS, APD, permis, études exécution, consultation entreprises, chantier. 5-7 phrases.]",
  "next_step_outcome_text": "[Plans détaillés, estimatif actualisé, dossier permis. 2-3 phrases.]",

  "conclusion_summary_text": "[Résumé: terrain analysé, 3 scénarios, ${_f.rec_scenario} recommandé. 3-4 phrases.]",
  "conclusion_positioning_text": "[Pourquoi le recommandé est le meilleur compromis. 3-4 phrases.]",
  "conclusion_projection_text": "[Durée chantier, saison pluies, livraison. 2-3 phrases.]"
}`;

  console.log(`[v72.60] GPT PROMPTS PRÉ-CONSTRUITS: system=${flat.gpt_system_prompt.length} chars, user=${flat.gpt_user_prompt.length} chars`);

  return res.json({ ok: true, scenarios, computed_budget_band: scenarios.computed_budget_band, computed_scores, ...flat });
});

// ══════════════════════════════════════════════════════════════════════════════
// v72.61: ENDPOINT /generate-texts — LE SERVEUR APPELLE GPT DIRECTEMENT
// Make.com envoie le MÊME body que /compute-scenarios
// Le serveur calcule les scénarios, construit les prompts, appelle GPT, renvoie les textes
// → Make.com n'a PLUS BESOIN du module OpenAI, juste un module HTTP
// ══════════════════════════════════════════════════════════════════════════════
app.post("/generate-texts", async (req, res) => {
  try {
    console.log("[v72.61] /generate-texts — START");

    // 1) Appeler /compute-scenarios via HTTP local
    const localUrl = `http://localhost:${PORT}/compute-scenarios`;
    console.log(`[v72.61] Appel interne → ${localUrl}`);
    const intResponse = await fetch(localUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    if (!intResponse.ok) {
      const errText = await intResponse.text();
      console.error(`[v72.61] /compute-scenarios a échoué (${intResponse.status}):`, errText);
      return res.status(500).json({ ok: false, error: "compute-scenarios failed", detail: errText });
    }

    const scenariosResponse = await intResponse.json();

    if (!scenariosResponse || !scenariosResponse.ok) {
      console.error("[v72.61] /compute-scenarios réponse invalide:", JSON.stringify(scenariosResponse).substring(0, 200));
      return res.status(500).json({ ok: false, error: "compute-scenarios returned invalid data" });
    }

    const systemPrompt = scenariosResponse.gpt_system_prompt;
    const userPrompt = scenariosResponse.gpt_user_prompt;

    if (!systemPrompt || !userPrompt) {
      console.error("[v72.61] gpt_system_prompt ou gpt_user_prompt manquant dans la réponse");
      return res.status(500).json({ ok: false, error: "prompts not found in scenarios response" });
    }

    console.log(`[v72.61] Prompts OK: system=${systemPrompt.length} chars, user=${userPrompt.length} chars`);
    console.log("[v72.61] Appel GPT-4o...");

    // 2) Appeler OpenAI directement
    const gptStart = Date.now();
    const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.4,
        max_tokens: 8000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!gptResponse.ok) {
      const errText = await gptResponse.text();
      console.error(`[v72.61] GPT API error ${gptResponse.status}: ${errText}`);
      return res.status(502).json({ ok: false, error: `GPT API error: ${gptResponse.status}`, detail: errText });
    }

    const gptData = await gptResponse.json();
    const gptElapsed = Date.now() - gptStart;
    console.log(`[v72.61] GPT réponse reçue en ${gptElapsed}ms — tokens: prompt=${gptData.usage?.prompt_tokens || "?"}, completion=${gptData.usage?.completion_tokens || "?"}`);

    // 3) Extraire le contenu JSON généré par GPT
    const rawContent = gptData.choices?.[0]?.message?.content;
    if (!rawContent) {
      console.error("[v72.61] GPT n'a pas retourné de contenu");
      return res.status(502).json({ ok: false, error: "GPT returned no content" });
    }

    let generatedTexts;
    try {
      generatedTexts = JSON.parse(rawContent);
    } catch (parseErr) {
      console.error("[v72.61] GPT JSON invalide:", parseErr.message);
      return res.status(502).json({ ok: false, error: "GPT returned invalid JSON", raw: rawContent.substring(0, 500) });
    }

    const textKeys = Object.keys(generatedTexts);
    console.log(`[v72.61] ✅ TEXTES GÉNÉRÉS: ${textKeys.length} champs — ${textKeys.join(", ")}`);

    // 4) Retourner les textes + les données scénarios (sans les prompts pour alléger)
    const { gpt_system_prompt, gpt_user_prompt, ...scenariosFlat } = scenariosResponse;

    return res.json({
      ok: true,
      server_version: "72.65-GENERATE-TEXTS",
      gpt_model: "gpt-4o",
      gpt_elapsed_ms: gptElapsed,
      gpt_tokens: gptData.usage || {},
      generated_texts: generatedTexts,
      // Aussi renvoyer les données scénarios pour que Make.com puisse les utiliser
      ...scenariosFlat,
      // Et les textes en FLAT pour mapping direct dans Make.com
      ...generatedTexts,
    });

  } catch (err) {
    console.error("[v72.61] /generate-texts ERREUR:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── TYPOLOGIES ARCHITECTURALES (v54) ────────────────────────────────────────
// Sélection automatique de la forme bâtie selon le contexte :
//   BLOC     → rectangle compact (~1:1.3), économique, petit terrain
//   BARRE    → lamelle allongée (~1:3+), éclairage naturel, logement
//   EN_U     → 3 ailes + cour intérieure, programme mixte, standing élevé
//   EN_L     → 2 ailes, terrain d'angle, extension/rénovation
//   EXTENSION→ barre accolée à un côté (parcelle déjà occupée)
//
// ══════════════════════════════════════════════════════════════════════════════
// v72.53: IMPACT DES TYPOLOGIES SUR LES CALCULS
// Chaque forme a un impact RÉEL sur : circulation, coûts, efficacité, profondeur
// Ces modifiers sont appliqués dans computeSmartScenarios (pas juste le rendu 3D)
// ══════════════════════════════════════════════════════════════════════════════
const TYPOLOGY_IMPACT = {
  BLOC: {
    // Rectangle compact : fondations simples, toiture rectangulaire, circulation minimale
    // Le plus économique à construire — référence de coût
    circ_modifier: 0,        // pas de surcoût circulation (couloir central simple)
    cost_mult: 1.00,         // référence coût construction
    body_depth_mult: 1.00,   // profondeur standard
    efficiency: 0.84,        // ratio surface utile / SDP (bon)
    fondation_mult: 1.00,    // fondations simples (rectangle)
    toiture_mult: 1.00,      // toiture simple (2 pans ou terrasse)
    description: "Volume compact rectangulaire — coût optimisé, fondations simples",
  },
  BARRE: {
    // Lamelle allongée : double orientation, ventilation traversante, couloirs latéraux
    // Éclairage naturel optimal — légèrement plus cher (linéaire de façade)
    circ_modifier: +0.02,    // +2% circulation (couloir latéral + escaliers en bouts)
    cost_mult: 1.08,         // +8% (plus de linéaire de façade, étanchéité, finitions)
    body_depth_mult: 0.75,   // corps de bâti plus mince (ventilation traversante)
    efficiency: 0.82,        // ratio utile/SDP (bon, grâce à la double orientation)
    fondation_mult: 1.05,    // fondations linéaires (plus longues)
    toiture_mult: 1.05,      // toiture allongée
    description: "Lamelle allongée — double orientation, ventilation traversante, éclairage optimal",
  },
  EN_U: {
    // 3 ailes autour d'une cour : circulation plus complexe (3 cages d'escalier)
    // Premium — cour intérieure créant un microclimat, mais fondations complexes
    circ_modifier: +0.06,    // +6% circulation (3 cages d'escalier, coursives, hall)
    cost_mult: 1.15,         // +15% (3 ailes, joints de dilatation, cour, fondations en U)
    body_depth_mult: 0.80,   // ailes plus minces (éclairage sur cour + extérieur)
    efficiency: 0.78,        // ratio utile/SDP (perdu en circulation, mais cour = valeur)
    fondation_mult: 1.20,    // fondations complexes (3 directions, angles)
    toiture_mult: 1.15,      // 3 toitures + noues intérieures
    description: "3 ailes en U avec cour intérieure — prestige, microclimat, mixité optimale",
  },
  EN_L: {
    // 2 ailes en angle : compromis entre BLOC et EN_U
    // Bon éclairage, angle crée un espace semi-protégé
    circ_modifier: +0.03,    // +3% (2 cages, angle de circulation)
    cost_mult: 1.10,         // +10% (angle, 2 ailes, joint de dilatation)
    body_depth_mult: 0.85,   // ailes légèrement plus minces
    efficiency: 0.80,        // ratio utile/SDP (bon compromis)
    fondation_mult: 1.10,    // fondations en angle
    toiture_mult: 1.08,      // 2 toitures + noue à l'angle
    description: "2 ailes en L — bon compromis lumière/coût, espace semi-protégé en angle",
  },
  EXTENSION: {
    // Accolée à l'existant : 1 mur mitoyen partagé, fondations partielles
    // Économique car 1 façade en moins, mais contraintes structurelles existant
    circ_modifier: +0.01,    // +1% (raccordement à l'existant)
    cost_mult: 1.05,         // +5% (raccordement structurel, reprise fondations)
    body_depth_mult: 0.90,   // légèrement contraint par l'existant
    efficiency: 0.82,        // bon (1 mur partagé = moins de déperditions)
    fondation_mult: 1.08,    // reprise fondations existantes
    toiture_mult: 1.02,      // raccord toiture existante
    description: "Extension accolée — raccordement à l'existant, 1 façade partagée",
  },
};
// ══════════════════════════════════════════════════════════════════════════════
// v72.53: VRD PAR ZONAGE — le coût des réseaux varie selon la zone
// URBAIN: réseaux existants, raccordement court → VRD bas
// PERIURBAIN: réseaux proches, quelques extensions → VRD moyen
// RURAL/PAVILLON: pas de réseaux, tout à créer → VRD élevé
// ══════════════════════════════════════════════════════════════════════════════
const VRD_MULT_BY_ZONING = {
  URBAIN: 0.80,      // réseaux existants, raccordement court
  MIXTE: 0.90,       // zone mixte, réseaux partiels
  PERIURBAIN: 1.00,  // référence — quelques extensions nécessaires
  PAVILLON: 1.20,    // zone résidentielle, extensions significatives
  RURAL: 1.50,       // tout à créer (routes, eau, électricité, assainissement)
  Z_DEFAULT: 1.00,   // fallback
};
// ══════════════════════════════════════════════════════════════════════════════
// v72.53: PRÉ-SÉLECTION TYPOLOGIQUE POUR LE CALCUL
// Version simplifiée de selectTypology() utilisable DANS computeSmartScenarios
// (la version complète avec bearing/solaire est pour le rendu 3D)
// ══════════════════════════════════════════════════════════════════════════════
function preSelectTypology({ fp_m2, envelope_area, site_area, envAspect, massing_mode,
  scenario_role, standing_level, program_main, isMixte, fillRatio }) {
  const isPremium = /PREMIUM|HAUT/i.test(standing_level || "");
  // Contrainte géométrique dure
  if (fillRatio > 0.80) return "BLOC";
  // PRUDENT → BLOC (simple, économique)
  if (scenario_role === "PRUDENT" && fillRatio > 0.30) return "BLOC";
  // INTENSIFICATION + grand terrain mixte → EN_U
  if (scenario_role === "INTENSIFICATION" && isMixte && envelope_area > 400 && fillRatio > 0.30) return "EN_U";
  // INTENSIFICATION + terrain allongé → BARRE
  if (scenario_role === "INTENSIFICATION" && envAspect > 1.8) return "BARRE";
  // COMPACT → BLOC ou EN_U
  if (massing_mode === "COMPACT") {
    if (isPremium && isMixte && envelope_area > 400) return "EN_U";
    return "BLOC";
  }
  // SPREAD → BARRE ou EN_L
  if (massing_mode === "SPREAD") {
    if (envAspect > 1.5) return "BARRE";
    if (isPremium && envelope_area > 350) return "EN_L";
    return "BARRE";
  }
  // BALANCED → selon contexte
  if (isPremium && isMixte && envelope_area > 500) return "EN_U";
  if (envAspect > 2.0) return "BARRE";
  if (fillRatio > 0.35 && fillRatio < 0.65 && envelope_area > 350) return "EN_L";
  return "BLOC";
}
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
    road_bearing: roadBearingInput, scenario_role, split_context } = context;
  console.log(`┌── computeMassingPolygon v72.27 (ROAD_BEARING + RÔLE + SOLAR + SPLIT) ──`);
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
  let maxW = Math.max(8, availW - 2 * margin);
  let maxD = Math.max(8, availD - 2 * margin);
  // v72.27: En mode SPLIT, réduire maxD pour que le logement tienne derrière le commerce
  if (split_context && split_context.is_split) {
    const commD = split_context.commerce_depth_m || 6;
    const gapD = split_context.retrait_inter_m || 4;
    const commMargin = 0.5;
    const reservedFront = commMargin + commD + gapD;
    maxD = Math.max(6, availD - reservedFront - margin); // profondeur restante pour logement
    console.log(`│ v72.27 SPLIT maxD: availD=${availD.toFixed(1)} - reserved=${reservedFront.toFixed(1)} - margin=${margin} → maxD=${maxD.toFixed(1)}m`);
  }
  console.log(`│ v56.5 DIRECT: availW=${availW.toFixed(1)} availD=${availD.toFixed(1)} → maxW=${maxW.toFixed(1)} maxD=${maxD.toFixed(1)} (margin=${margin}m)`);
  // Position en profondeur (retrait de la rue) — v72.27 : SPLIT-aware
  // En mode SPLIT_AV_AR, le logement doit être DERRIÈRE le commerce + gap.
  // Le centre du logement = marge + commDepth + interGap + bD/2 (calculé après forme)
  let depthPct;
  let splitForcePosition = false; // v72.27: flag pour forcer la position APRÈS calcul forme
  if (split_context && split_context.is_split) {
    // Mode SPLIT : le logement doit commencer APRÈS la zone commerce + gap
    const commD = split_context.commerce_depth_m || 6;
    const gapD = split_context.retrait_inter_m || 4;
    const reservedFront = margin + commD + gapD; // espace réservé devant (commerce + gap)
    // Le centre du logement sera calculé après la forme (besoin de bD)
    // Pour l'instant on calcule un depthPct approximatif qui place le logement derrière
    const logementCenterFromFront = reservedFront + (availD - reservedFront) / 2;
    depthPct = logementCenterFromFront / availD;
    depthPct = Math.max(0.50, Math.min(0.85, depthPct));
    splitForcePosition = true;
    console.log(`│ v72.27 SPLIT: commerce=${commD}m + gap=${gapD}m → reservedFront=${reservedFront.toFixed(1)}m`);
    console.log(`│ v72.27 SPLIT: logement center at ${(depthPct*100).toFixed(0)}% depth (${(availD*depthPct).toFixed(1)}m from front)`);
  } else {
    // Mode normal : basé sur le RÔLE
    // INTENSIFICATION → plus près de la rue (visibilité, commerce RDC, intensité urbaine)
    // EQUILIBRE → retrait modéré
    // PRUDENT → retrait plus marqué (calme, résidentiel, phasage)
    if (scenario_role === "INTENSIFICATION") depthPct = 0.45;
    else if (scenario_role === "PRUDENT") depthPct = 0.62;
    else depthPct = 0.53; // EQUILIBRE
    // Ajustement solaire : si la rue est N-S, reculer un peu pour libérer la cour sud
    if (solarFavorDepth) depthPct = Math.min(0.70, depthPct + 0.05);
    depthPct = Math.max(0.38, Math.min(0.72, depthPct));
  }
  console.log(`│ Implantation: retrait ${(depthPct*100).toFixed(0)}% de la rue (role=${scenario_role}, mode=${massing_mode}, split=${!!split_context})`);
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
  let cV;
  if (splitForcePosition && split_context) {
    // v72.27 SPLIT: positionner le logement PRÉCISÉMENT derrière le commerce + gap
    // Le commerce est collé au front avec une marge de 0.5m (limite séparative)
    // Le bord AVANT du logement = minV + commMargin + commDepth + gapD
    const commD = split_context.commerce_depth_m || 6;
    const gapD = split_context.retrait_inter_m || 4;
    const commMargin = 0.5; // même marge que buildCommercePolygon
    const logementFrontEdge = minV + commMargin + commD + gapD;
    cV = logementFrontEdge + bD / 2;
    // S'assurer que le logement reste dans l'enveloppe
    const logementBackEdge = cV + bD / 2;
    if (logementBackEdge > maxV - margin) {
      cV = maxV - margin - bD / 2; // reculer pour rester dans l'enveloppe
    }
    console.log(`│ v72.27 SPLIT POSITION: logement front=${logementFrontEdge.toFixed(1)}m center=${cV.toFixed(1)}m back=${(cV+bD/2).toFixed(1)}m`);
    console.log(`│ v72.27 Commerce zone: [${(minV+margin).toFixed(1)}, ${(minV+margin+commD).toFixed(1)}m] | Gap: ${gapD}m | Logement: [${logementFrontEdge.toFixed(1)}, ${(cV+bD/2).toFixed(1)}m]`);
  } else {
    cV = minV + availD * depthPct;
  }
  console.log(`│ Position: center=(${cU.toFixed(1)}, ${cV.toFixed(1)}) [bbox mid-U, ${((cV-minV)/availD*100).toFixed(0)}% depth-V]`);
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
  // v72.25: Exporter les infos de repère local pour le SPLIT (découpe commerce/logement)
  result._frontDir = { sUx, sUy, nUx, nUy }; // direction rue (s) et profondeur site (n)
  result._centerLatLon = { lat: eLat, lon: eLon };
  return result;
}
// ─── SPLIT COMMERCE/LOGEMENT : polygon commerce construit depuis l'enveloppe ──
// v72.27: Le commerce est une bande rectangulaire COLLÉE AU FRONT de l'enveloppe (limite séparative).
// Le logement = massingCoords existant (positionné en retrait par computeMassingPolygon + split_context).
// On CONSTRUIT le commerce séparément depuis l'enveloppe, SANS marge devant (collé à la limite).
function buildCommercePolygon(envelopeCoords, splitLayout, roadBearing) {
  if (!splitLayout || !envelopeCoords || envelopeCoords.length < 3) return null;
  const commDepth = splitLayout.volume_commerce.depth_m || 6;
  const commWidth = splitLayout.volume_commerce.width_m || null;
  const margin = 0.5; // v72.27: marge minimale (commerce collé à la limite séparative)
  console.log(`┌── buildCommercePolygon v72.27 ──`);
  console.log(`│ commDepth=${commDepth}m  commWidth=${commWidth}m  envVertices=${envelopeCoords.length}`);
  // Centroïde de l'enveloppe
  const cLat = envelopeCoords.reduce((s, p) => s + p.lat, 0) / envelopeCoords.length;
  const cLon = envelopeCoords.reduce((s, p) => s + p.lon, 0) / envelopeCoords.length;
  // Convertir en mètres
  const envM = envelopeCoords.map(c => toM(c.lat, c.lon, cLat, cLon));
  // Trouver le bord "façade rue" (même logique que computeMassingPolygon)
  let frontIdx = 0;
  if (roadBearing != null && !isNaN(roadBearing)) {
    const rb = ((roadBearing % 360) + 360) % 360;
    let bestScore = 999;
    for (let i = 0; i < envM.length; i++) {
      const j = (i + 1) % envM.length;
      const dx = envM[j].x - envM[i].x, dy = envM[j].y - envM[i].y;
      const edgeLen = Math.sqrt(dx * dx + dy * dy);
      if (edgeLen < 1) continue;
      const edgeBearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
      let diff = Math.abs(edgeBearing - rb) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff > 90) diff = 180 - diff;
      const score = diff - edgeLen * 0.02;
      if (score < bestScore) { bestScore = score; frontIdx = i; }
    }
  } else {
    let maxLen = 0;
    for (let i = 0; i < envM.length; i++) {
      const j = (i + 1) % envM.length;
      const dx = envM[j].x - envM[i].x, dy = envM[j].y - envM[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > maxLen) { maxLen = len; frontIdx = i; }
    }
  }
  const fi = frontIdx, fj = (fi + 1) % envM.length;
  const sDx = envM[fj].x - envM[fi].x, sDy = envM[fj].y - envM[fi].y;
  const sLen = Math.sqrt(sDx * sDx + sDy * sDy) || 1;
  const sUx = sDx / sLen, sUy = sDy / sLen; // direction le long de la rue
  let nUx = -sUy, nUy = sUx; // direction vers l'intérieur du site
  // Vérifier que "into site" pointe bien vers le centroïde
  const midFX = (envM[fi].x + envM[fj].x) / 2, midFY = (envM[fi].y + envM[fj].y) / 2;
  if (nUx * (0 - midFX) + nUy * (0 - midFY) < 0) { nUx = -nUx; nUy = -nUy; }
  // Projeter l'enveloppe en repère local (u = rue, v = profondeur)
  const envLocal = envM.map(p => ({
    u: p.x * sUx + p.y * sUy,
    v: p.x * nUx + p.y * nUy,
  }));
  const minU = Math.min(...envLocal.map(p => p.u));
  const maxU = Math.max(...envLocal.map(p => p.u));
  const minV = Math.min(...envLocal.map(p => p.v));
  const maxV = Math.max(...envLocal.map(p => p.v));
  const envWidth = maxU - minU;
  const envDepth = maxV - minV;
  console.log(`│ Envelope local: W=${envWidth.toFixed(1)}m × D=${envDepth.toFixed(1)}m`);
  console.log(`│ Front edge: [${fi}→${fj}] len=${sLen.toFixed(1)}m`);
  // v72.27: Construire le rectangle commerce : bande collée au front (limite séparative)
  // La largeur du commerce utilise la largeur splitLayout (déjà avec retraits latéraux)
  // v72.68: FIX ÉTAGE FANTÔME — contraindre la largeur commerce à son fp_m2 réel
  // AVANT: si commWidth=null → pleine largeur enveloppe → commerce visuellement plus large que logement → "ghost floor"
  // MAINTENANT: calculer la largeur depuis fp_m2/depth pour que l'aire affichée = aire réelle
  const commFP = splitLayout.volume_commerce.fp_m2 || 0;
  let cW;
  if (commWidth) {
    cW = Math.min(commWidth, envWidth - 2 * margin);
  } else if (commFP > 0 && commDepth > 0) {
    // Largeur calculée pour respecter l'aire réelle du commerce
    cW = Math.min(commFP / commDepth, envWidth - 2 * margin);
    console.log(`│ v72.68: Commerce width from fp_m2: ${commFP}m² / ${commDepth}m = ${cW.toFixed(1)}m (anti ghost-floor)`);
  } else {
    cW = envWidth - 2 * margin;
  }
  const cD = Math.min(commDepth, envDepth * 0.40); // max 40% de la profondeur enveloppe
  const cCenterU = (minU + maxU) / 2; // centré sur la largeur
  const cStartV = minV + margin; // collé au front (avec marge)
  // 4 coins du rectangle commerce en repère local
  const commLocal = [
    { u: cCenterU - cW / 2, v: cStartV },
    { u: cCenterU + cW / 2, v: cStartV },
    { u: cCenterU + cW / 2, v: cStartV + cD },
    { u: cCenterU - cW / 2, v: cStartV + cD },
  ];
  console.log(`│ Commerce rect: ${cW.toFixed(1)}m × ${cD.toFixed(1)}m = ${Math.round(cW * cD)}m²`);
  console.log(`│ Position: u=[${(cCenterU - cW/2).toFixed(1)}, ${(cCenterU + cW/2).toFixed(1)}] v=[${cStartV.toFixed(1)}, ${(cStartV + cD).toFixed(1)}]`);
  // Convertir local → mètres → GPS
  function localToGPS(lp) {
    const mx = lp.u * sUx + lp.v * nUx;
    const my = lp.u * sUy + lp.v * nUy;
    return {
      lat: cLat + my / R_EARTH * 180 / Math.PI,
      lon: cLon + mx / (R_EARTH * Math.cos(cLat * Math.PI / 180)) * 180 / Math.PI,
    };
  }
  const commerceGPS = commLocal.map(localToGPS);
  commerceGPS.forEach((c, i) => console.log(`│ Commerce[${i}]: ${c.lat.toFixed(7)}, ${c.lon.toFixed(7)}`));
  console.log(`└── end buildCommercePolygon v72.26 ──`);
  return commerceGPS;
}
// ─── HTML MAPBOX GL — SLIDE 4 AXO ─────────────────────────────────────────────
function generateMapHTML(center, zoom, bearing, parcelCoords, envelopeCoords, mapboxToken, frontEdgeIndex) {
  const parcelGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...parcelCoords.map(c => [c.lon, c.lat]), [parcelCoords[0].lon, parcelCoords[0].lat]]] },
  };
  const envelopeGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...envelopeCoords.map(c => [c.lon, c.lat]), [envelopeCoords[0].lon, envelopeCoords[0].lat]]] },
  };
  // v49: accès principal auto-détecté
  const access = computeAccessPoint(parcelCoords, center.lat, center.lon, frontEdgeIndex);
  const arrowLen = 8;
  const accEndLat = access.lat + (arrowLen / R_EARTH) * 180 / Math.PI * Math.cos(access.bearing * Math.PI / 180);
  const accEndLon = access.lon + (arrowLen / (R_EARTH * Math.cos(access.lat * Math.PI / 180))) * 180 / Math.PI * Math.sin(access.bearing * Math.PI / 180);
  const accessLineGeoJSON = {
    type: "Feature", properties: {},
    geometry: { type: "LineString", coordinates: [[access.lon, access.lat], [accEndLon, accEndLat]] },
  };
  const accessPointGeoJSON = {
    type: "Feature", properties: { label: "Accès" },
    geometry: { type: "Point", coordinates: [accEndLon, accEndLat] },
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
  // ═══════════════════════════════════════════════════════════════════
  // v49 HEKTAR PRO — style avec couleurs intégrées (vert gazon, beige routes)
  // ═══════════════════════════════════════════════════════════════════
  const hektarStyle = {
    "version": 8,
    "name": "Hektar Pro",
    "sources": {
      "mapbox-streets": { "type": "vector", "url": "mapbox://mapbox.mapbox-streets-v8" },
      "mapbox-terrain": { "type": "vector", "url": "mapbox://mapbox.mapbox-terrain-v2" },
      "composite": { "type": "vector", "url": "mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2" }
    },
    "glyphs": "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
    "sprite": "mapbox://sprites/mapbox/light-v11",
    "layers": [
      { "id": "background", "type": "background",
        "paint": { "background-color": "#4a8c2a" } },
      { "id": "water", "type": "fill",
        "source": "composite", "source-layer": "water",
        "paint": { "fill-color": "#a0c8dd" } },
      { "id": "landuse-park", "type": "fill",
        "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["park", "grass", "cemetery", "wood", "scrub", "pitch"], true, false],
        "paint": { "fill-color": "#3d7a22" } },
      { "id": "landuse-urban", "type": "fill",
        "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["residential", "commercial", "industrial"], true, false],
        "paint": { "fill-color": "#4a8c2a" } },
      { "id": "road-case-secondary", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#5c5c5c", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 28, 16, 56, 17, 80, 18, 100] } },
      { "id": "road-case-street", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#6a6a6a", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 12, 16, 28, 17, 40, 18, 56] } },
      { "id": "road-fill-secondary", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#707070", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 24, 16, 48, 17, 72, 18, 92] } },
      { "id": "road-fill-street", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#808080", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 8, 16, 20, 17, 32, 18, 48] } },
      { "id": "road-label-major", "type": "symbol",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": {
          "text-field": ["coalesce", ["get", "name_fr"], ["get", "name"]],
          "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 17, 13],
          "symbol-placement": "line", "text-max-angle": 30, "text-padding": 20, "text-allow-overlap": false
        },
        "paint": { "text-color": "#333333", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 }
      },
      { "id": "road-label-street", "type": "symbol",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited"], true, false],
        "minzoom": 16,
        "layout": {
          "text-field": ["coalesce", ["get", "name_fr"], ["get", "name"]],
          "text-font": ["DIN Pro Regular", "Arial Unicode MS Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 16, 8, 18, 11],
          "symbol-placement": "line", "text-max-angle": 30, "text-padding": 30, "text-allow-overlap": false
        },
        "paint": { "text-color": "#555555", "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1 }
      }
    ]
  };
  const map = new mapboxgl.Map({
    container: 'map', style: hektarStyle,
    center: [${center.lon}, ${center.lat}], zoom: ${zoom}, bearing: ${bearing}, pitch: 58,
    antialias: true, preserveDrawingBuffer: true, fadeDuration: 0, interactive: false,
  });
  map.addControl = function() {};
  map.on('style.load', () => {
    // v70.5: Lumière directionnelle forte pour ombres marquées
    map.setLight({ anchor: 'map', color: '#fff8f0', intensity: 0.70, position: [1.5, 210, 30] });
    const labelLayerId = undefined;
    // v70.5: BÂTIMENTS 3D — posés au sol (base=0), hauteurs réalistes
    map.addLayer({
      id: '3d-buildings', source: 'composite', 'source-layer': 'building',
      filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 13,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['coalesce', ['get', 'height'], 6],
          0,  '#e8e6e2',
          4,  '#e0deda',
          10, '#d5d3cf',
          20, '#cac8c4',
          40, '#bab8b4',
        ],
        'fill-extrusion-height': [
          'let', 'h', ['coalesce', ['get', 'height'], 0],
          ['case',
            ['>', ['var', 'h'], 2], ['var', 'h'],
            ['match', ['%', ['to-number', ['id']], 7],
              0, 4, 1, 4, 2, 7, 3, 7, 4, 10, 5, 13, 6, 4, 7
            ]
          ]
        ],
        'fill-extrusion-base': ['case',
          ['has', 'min_height'], 0,
          0
        ],
        'fill-extrusion-opacity': 1.0,
        'fill-extrusion-vertical-gradient': true,
      },
    }, labelLayerId);
    // v70.7: Pas de tree-canopy Mapbox (blocs verts moches) — l'AI polish ajoute des vrais arbres
    // v70.10: Parcelle — fond AU-DESSUS des bâtiments pour masquer le contenu
    map.addSource('parcel', { type: 'geojson', data: ${JSON.stringify(parcelGeoJSON)} });
    // fill-extrusion opaque à hauteur minimale pour couvrir les bâtiments 3D à l'intérieur
    map.addLayer({ id: 'parcel-fill-3d', type: 'fill-extrusion', source: 'parcel',
      paint: { 'fill-extrusion-color': '#d4c8a0', 'fill-extrusion-height': 0.15,
               'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.85 } });
    // Contour parcelle — rouge épais par-dessus
    map.addLayer({ id: 'parcel-outline', type: 'line', source: 'parcel',
      paint: { 'line-color': '#d04020', 'line-width': 6, 'line-opacity': 1.0 } });
    // v70.8: Zone constructible (reculs) — tirets bien visibles
    map.addSource('envelope', { type: 'geojson', data: ${JSON.stringify(envelopeGeoJSON)} });
    map.addLayer({ id: 'envelope-outline', type: 'line', source: 'envelope',
      paint: { 'line-color': '#d04020', 'line-width': 4,
               'line-dasharray': [5, 3], 'line-opacity': 1.0 } });
    // v49: Accès principal — DÉSACTIVÉ (annotation retirée)
  });
  let rendered = false;
  map.on('idle', () => { if (rendered) return; rendered = true; setTimeout(() => { window.__MAP_READY = true; }, 2500); });
  setTimeout(() => { window.__MAP_READY = true; }, 12000);
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
  const rdcH = 3.0;  // v71: tous les niveaux = 3m
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
      { "id": "background", "type": "background", "paint": { "background-color": "#eae8e4" } },
      { "id": "water", "type": "fill", "source": "composite", "source-layer": "water", "paint": { "fill-color": "#c4d4de" } },
      { "id": "landuse-park", "type": "fill", "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["park", "grass", "cemetery", "wood", "scrub", "pitch"], true, false],
        "paint": { "fill-color": "#dddcd6" } },
      { "id": "landuse-urban", "type": "fill", "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["residential", "commercial", "industrial"], true, false],
        "paint": { "fill-color": "#e4e2de" } },
      { "id": "road-case-secondary", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#707070", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 28, 16, 56, 17, 80, 18, 100, 19, 120] } },
      { "id": "road-case-street", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#888888", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 12, 16, 28, 17, 40, 18, 56, 19, 72] } },
      { "id": "road-fill-secondary", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#808080", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 24, 16, 48, 17, 72, 18, 92, 19, 112] } },
      { "id": "road-fill-street", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#989898", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 8, 16, 20, 17, 32, 18, 48, 19, 64] } }
    ]
  };
  const map = new mapboxgl.Map({
    container: 'map', style: hektarStyle,
    center: [${center.lon}, ${center.lat}], zoom: ${zoom}, bearing: ${bearing}, pitch: 58,
    antialias: true, preserveDrawingBuffer: true, fadeDuration: 0, interactive: false,
  });
  map.addControl = function() {};
  map.on('style.load', () => {
    // v71: Lumière douce pour ombres subtiles
    map.setLight({ anchor: 'map', color: '#ffffff', intensity: 0.55, position: [1.2, 210, 35] });
    map.addLayer({
      id: '3d-buildings', source: 'composite', 'source-layer': 'building',
      filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 13,
      paint: {
        // v71: Bâtiments blancs/crème — style maquette propre
        'fill-extrusion-color': '#f0ede8',
        'fill-extrusion-height': ['case', ['has', 'height'], ['get', 'height'], 7],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.92, 'fill-extrusion-vertical-gradient': true,
      },
    });
    // v71: Parcelle — fond beige/sable + contour rouge
    map.addSource('parcel', { type: 'geojson', data: ${JSON.stringify(parcelGeoJSON)} });
    map.addLayer({ id: 'parcel-fill', type: 'fill', source: 'parcel',
      paint: { 'fill-color': '#dcc8a0', 'fill-opacity': 0.60 } }, '3d-buildings');
    map.addLayer({ id: 'parcel-outline', type: 'line', source: 'parcel',
      paint: { 'line-color': '#c04020', 'line-width': 5, 'line-opacity': 1.0 } });
    // v71: Zone constructible (reculs) — tirets rouge au-dessus des bâtiments
    map.addSource('envelope', { type: 'geojson', data: ${JSON.stringify(envelopeGeoJSON)} });
    map.addLayer({ id: 'envelope-outline', type: 'line', source: 'envelope',
      paint: { 'line-color': '#c04020', 'line-width': 4, 'line-dasharray': [6, 4], 'line-opacity': 1.0 } });
    // ── MASSING : étages individuels, RDC=${rdcH}m, courants=${etageH}m, gaps entre niveaux ──
    map.addSource('massing', { type: 'geojson', data: ${JSON.stringify(massingGeoJSON)} });
    const rdcH = ${rdcH};
    const etageH = ${etageH};
    const gap = 0.30;  // v71: gap net entre niveaux (ligne noire visible)
    // v72.22: SPLIT_AV_AR — commerce = volume séparé devant, logement = volume derrière
    ${massingParams.commerce_coords ? `
    // ══ MODE SPLIT_AV_AR : 2 volumes distincts ══
    const commerceGeoJSON = ${JSON.stringify({
      type: "Feature",
      properties: { height: rdcH, base_height: 0 },
      geometry: { type: "Polygon", coordinates: [[...massingParams.commerce_coords.map(c => [c.lon, c.lat]), [massingParams.commerce_coords[0].lon, massingParams.commerce_coords[0].lat]]] },
    })};
    map.addSource('commerce-volume', { type: 'geojson', data: commerceGeoJSON });
    // Commerce : 1 niveau ORANGE en avant
    map.addLayer({
      id: 'commerce-floor-0', type: 'fill-extrusion', source: 'commerce-volume',
      paint: {
        'fill-extrusion-color': '#e07830',
        'fill-extrusion-height': rdcH,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.92,
        'fill-extrusion-vertical-gradient': false,
      },
    });
    map.addLayer({ id: 'commerce-footprint', type: 'line', source: 'commerce-volume',
      paint: { 'line-color': '#1a1a1a', 'line-width': 1.5, 'line-opacity': 0.9 } });
    // v72.28: Logement sur PILOTIS en SPLIT — 4 poteaux aux coins + niveaux habitables au-dessus
    const logtLevels = ${massingParams.split_layout ? massingParams.split_layout.volume_logement.levels : massingParams.levels};
    const pilotisH = rdcH; // pilotis = hauteur d'un RDC (3m)
    // v72.28: 4 POTEAUX PILOTIS aux coins du logement (petits carrés extrudés)
    const massingRing = ${JSON.stringify(massingGeoJSON)}.geometry.coordinates[0];
    const colSize = 0.000004; // ~0.45m en GPS (petit carré de poteau)
    const pilotisFeatures = [];
    // Prendre les 4 premiers points du polygon (coins du logement)
    for (let c = 0; c < Math.min(massingRing.length - 1, 4); c++) {
      const cx = massingRing[c][0], cy = massingRing[c][1];
      pilotisFeatures.push({
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[ [cx - colSize, cy - colSize], [cx + colSize, cy - colSize],
                          [cx + colSize, cy + colSize], [cx - colSize, cy + colSize],
                          [cx - colSize, cy - colSize] ]]
        }
      });
    }
    const pilotisGeoJSON = { type: "FeatureCollection", features: pilotisFeatures };
    map.addSource('pilotis-cols', { type: 'geojson', data: pilotisGeoJSON });
    map.addLayer({
      id: 'pilotis-columns', type: 'fill-extrusion', source: 'pilotis-cols',
      paint: {
        'fill-extrusion-color': '#c8c4bc',
        'fill-extrusion-height': pilotisH - gap / 2,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.95,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    // Niveaux habitables logement — commencent AU-DESSUS du pilotis
    for (let f = 0; f < logtLevels; f++) {
      const base = pilotisH + f * etageH;
      const top  = pilotisH + (f + 1) * etageH;
      const baseH = base + gap / 2;
      const topH  = f < logtLevels - 1 ? top - gap / 2 : top;
      map.addLayer({
        id: 'floor-' + f, type: 'fill-extrusion', source: 'massing',
        paint: {
          'fill-extrusion-color': '#3a7ac0',
          'fill-extrusion-height': topH,
          'fill-extrusion-base': baseH,
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': false,
        },
      });
    }
    ` : `
    // ══ MODE SUPERPOSÉ : étages empilés sur un seul volume ══
    const totalLevels = ${massingParams.levels};  // v72.22: TOUJOURS utiliser levels du moteur — jamais de fallback calculé
    const commLevels = ${massingParams.commerce_levels || 0};
    for (let f = 0; f < totalLevels; f++) {
      const base = f === 0 ? 0 : rdcH + (f - 1) * etageH;
      const top  = f === 0 ? rdcH : rdcH + f * etageH;
      const baseH = f > 0 ? base + gap / 2 : 0;
      const topH  = f < totalLevels - 1 ? top - gap / 2 : top;
      const isComm = f < commLevels;
      // v70.10: Commerce = ORANGE vif, Logement = BLEU net
      map.addLayer({
        id: 'floor-' + f, type: 'fill-extrusion', source: 'massing',
        paint: {
          'fill-extrusion-color': isComm ? '#e07830' : '#3a7ac0',
          'fill-extrusion-height': topH,
          'fill-extrusion-base': baseH,
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': false,
        },
      });
    }
    `}
    // ── Contour emprise au sol : bleu foncé ──
    map.addLayer({ id: 'massing-footprint', type: 'line', source: 'massing',
      paint: { 'line-color': '#1a1a1a', 'line-width': 1.5, 'line-opacity': 0.9 } });
  });
  let rendered = false;
  map.on('idle', () => { if (rendered) return; rendered = true; setTimeout(() => { window.__MAP_READY = true; }, 2500); });
  setTimeout(() => { window.__MAP_READY = true; }, 12000);
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
  ctx.fillStyle = "#c45030"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 3); ctx.lineTo(0, 8); ctx.lineTo(5, 3); ctx.closePath();
  ctx.fillStyle = "#ccc"; ctx.fill();
  ctx.rotate((bearing || 0) * Math.PI / 180);
  ctx.font = "bold 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#c45030";
  ctx.fillText("N", 0, -22);
  ctx.restore();
  const legItems = [
    { type: "rect", fill: "rgba(196,80,48,0.25)", stroke: "#c45030", label: `Parcelle — ${site_area} m²` },
    { type: "dash", stroke: "#c45030", label: "Zone constructible (reculs)" },
    { type: "rect", fill: "#e0ddd8", stroke: "#b0ada6", label: "Bâtiments 3D" },
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
  ctx.strokeStyle = "#c45030"; ctx.lineWidth = 4; ctx.stroke();
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
// ─── COLOR REMAP — remplace les teintes beige Mapbox par vert/sable architectural ──
function applyColorRemap(ctx, W, H) {
  // v72.21: Mapbox "Hektar Pro" already has green grass (#6aad3a) and dark roads.
  // NO ground→grass or road→sandy remap needed — that was for the old beige style.
  // This function now ONLY whitens building rooftops for a premium concrete look.
  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;

  // ─── STEP 1: Build rooftop mask ──────────────────────────────────────────
  // In 3D axonometric view, building rooftops have darker building-side pixels
  // directly below them. Ground does NOT have this brightness drop.
  const roofMask = new Uint8Array(W * H);
  for (let y = 0; y < H - 15; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const r = d[idx], g = d[idx + 1], b = d[idx + 2];
      const brightness = (r + g + b) / 3;
      // Building rooftops in Mapbox Hektar Pro: #d8d4cc to #908c88 → brightness 140-215
      // Green grass #6aad3a → brightness ~112. Skip grass and very dark/bright pixels.
      if (brightness < 130 || brightness > 240) continue;
      // Skip green pixels (grass) — g channel dominant
      if (g > r + 20 && g > b + 30) continue;
      // Skip reddish pixels (parcel zone)
      if (r > 180 && g < 140 && b < 140) continue;
      // Check 2-15 pixels below for building wall (brightness drop > 30)
      for (let dy = 2; dy <= 15; dy++) {
        const by = y + dy;
        if (by >= H) break;
        const bi = (by * W + x) * 4;
        const bBright = (d[bi] + d[bi + 1] + d[bi + 2]) / 3;
        if (brightness - bBright > 30) {
          // Verify the dark pixel is a building wall (neutral gray, not green grass)
          const wr = d[bi], wg = d[bi + 1], wb = d[bi + 2];
          const isWall = Math.abs(wr - wg) < 30 && Math.abs(wg - wb) < 30;
          const isGrass = wg > wr + 15 && wg > wb + 20;
          if (isWall && !isGrass) {
            roofMask[y * W + x] = 1;
            break;
          }
        }
      }
    }
  }
  // Expand rooftop mask upward + laterally for full coverage
  const roofMask2 = new Uint8Array(roofMask);
  for (let y = 3; y < H; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (roofMask[y * W + x]) {
        for (let dy = 1; dy <= 4; dy++) {
          if (y - dy >= 0) roofMask2[(y - dy) * W + x] = 1;
        }
        // Slight lateral expansion for edge coverage
        roofMask2[y * W + x - 1] = 1;
        roofMask2[y * W + x + 1] = 1;
      }
    }
  }

  // ─── STEP 2: Building whitening — rooftop pixels → warm white concrete ───
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!roofMask2[y * W + x]) continue;
      const i = (y * W + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const brightness = (r + g + b) / 3;
      if (brightness > 245 || brightness < 70) continue;
      // Skip green pixels that leaked into mask
      if (g > r + 15 && g > b + 25) continue;
      // Skip parcel red
      if (r > 180 && g < 130 && b < 130) continue;
      // Remap to warm white — preserve luminosity
      const lum = Math.min(1.3, brightness / 180);
      d[i]     = Math.min(255, Math.round(242 * lum));
      d[i + 1] = Math.min(255, Math.round(240 * lum));
      d[i + 2] = Math.min(255, Math.round(235 * lum));
    }
  }
  ctx.putImageData(imgData, 0, 0);
}
// ─── v72.17 DETERMINISTIC SHADOWS — sun from upper-left ─────────────────────
// Scans each grass pixel and checks if building pixels exist ~15px toward upper-left
// If yes → darken the grass to simulate shadow projection
function applyDeterministicShadows(ctx, W, H) {
  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  const SHADOW_DIST = 18; // pixels to check for building occlusion
  const SHADOW_DARKEN = 0.7; // shadow intensity (0.7 = 30% darker)
  for (let y = SHADOW_DIST; y < H; y++) {
    for (let x = SHADOW_DIST; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = d[i], g = d[i+1], b = d[i+2];
      // Only shadow on grass pixels (green: R<110, G>100, B<90)
      if (!(r < 110 && g > 100 && b < 90)) continue;
      // Check if there's a building pixel ~SHADOW_DIST pixels to the upper-left
      let hasBuildingAbove = false;
      for (let s = 8; s <= SHADOW_DIST; s += 5) {
        const si = ((y - s) * W + (x - Math.floor(s * 0.6))) * 4;
        if (si < 0 || si >= d.length) continue;
        const sr = d[si], sg = d[si+1], sb = d[si+2];
        const sBright = (sr + sg + sb) / 3;
        // Building: bright (>180), not grass-green
        if (sBright > 180 && sg < sr + 30) { hasBuildingAbove = true; break; }
      }
      if (hasBuildingAbove) {
        d[i]   = Math.round(r * SHADOW_DARKEN);
        d[i+1] = Math.round(g * SHADOW_DARKEN);
        d[i+2] = Math.round(b * SHADOW_DARKEN);
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
}
// ─── v72.17 WARM COLOR GRADING — subtle warm tone shift ─────────────────────
function applyWarmGrading(ctx, W, H) {
  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    // Slight warm shift: +3R, +1G, -2B
    d[i]   = Math.min(255, d[i] + 3);
    d[i+1] = Math.min(255, d[i+1] + 1);
    d[i+2] = Math.max(0, d[i+2] - 2);
  }
  ctx.putImageData(imgData, 0, 0);
}
// ─── v72.3 BLOCK-GRID DRIFT DETECTION ─────────────────────────────────────────
// Lessons from production (v72.1 and v72.2 both failed):
//   - Pixel-level edge comparison doesn't work: AI polish transforms everything
//   - Even strong Sobel edges shift when textures/shadows are added
//
// NEW APPROACH: Compare the MACRO LAYOUT using a coarse grid.
//   1. Divide both images into blocks (e.g. 32×32 grid = 1024 blocks on 1280px)
//   2. For each block, compute average brightness (grayscale)
//   3. Classify each block: BRIGHT (building/roof), DARK (road/shadow), MID (grass/ground)
//   4. Compare classification maps — if the same blocks are bright/dark/mid, structure is intact
//
// This is robust because:
//   - Polish changes colors/textures → brightness shifts within a class are OK
//   - A BUILDING MOVING would change block classifications (bright block becomes mid)
//   - A new phantom building would flip a mid/dark block to bright
//   - Tonal harmonization doesn't flip classifications
//
// v72.5: threshold is now a parameter — heavy polish (slide 4) needs higher threshold
async function detectDriftFromBuffers(cleanPngBuf, polishedPngBuf, W, H, customThreshold) {
  const cleanImg = await loadImage(cleanPngBuf);
  const polishedImg = await loadImage(polishedPngBuf);
  const cleanCanvas = createCanvas(W, H);
  const cleanCtx = cleanCanvas.getContext("2d");
  cleanCtx.drawImage(cleanImg, 0, 0, W, H);
  const polishedCanvas = createCanvas(W, H);
  const polishedCtx = polishedCanvas.getContext("2d");
  polishedCtx.drawImage(polishedImg, 0, 0, W, H);
  const cleanData = cleanCtx.getImageData(0, 0, W, H).data;
  const polishedData = polishedCtx.getImageData(0, 0, W, H).data;
  // Grid parameters
  const BLOCK = 40; // 40px blocks → 32×32 grid on 1280px image
  const cols = Math.floor(W / BLOCK);
  const rows = Math.floor(H / BLOCK);
  // Compute average brightness per block for both images
  function blockBrightness(data, bx, by) {
    let sum = 0, count = 0;
    for (let y = by * BLOCK; y < Math.min((by + 1) * BLOCK, H); y++) {
      for (let x = bx * BLOCK; x < Math.min((bx + 1) * BLOCK, W); x++) {
        const idx = (y * W + x) * 4;
        sum += 0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2];
        count++;
      }
    }
    return sum / count;
  }
  // Classify block: 0=DARK (<80), 1=MID (80-170), 2=BRIGHT (>170)
  function classify(brightness) {
    if (brightness < 80) return 0;
    if (brightness > 170) return 2;
    return 1;
  }
  let totalBlocks = 0;
  let classShifts = 0;     // blocks that changed classification (structural drift)
  let bigBrightnessShifts = 0; // blocks with >60 brightness change (extreme)
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      totalBlocks++;
      const cb = blockBrightness(cleanData, bx, by);
      const pb = blockBrightness(polishedData, bx, by);
      const cc = classify(cb);
      const pc = classify(pb);
      if (cc !== pc) classShifts++;
      if (Math.abs(cb - pb) > 60) bigBrightnessShifts++;
    }
  }
  const classShiftRatio = totalBlocks > 0 ? classShifts / totalBlocks : 0;
  // v72.5: Configurable threshold per pipeline
  // - Slide 4 heavy polish (texture, grass, concrete) → 0.55 (legitimately flips many blocks)
  // - Massing light polish (tonal only) → 0.25 (stricter, less transformation expected)
  const DRIFT_THRESHOLD = customThreshold || 0.25;
  const passed = classShiftRatio < DRIFT_THRESHOLD;
  return {
    driftScore: +classShiftRatio.toFixed(4),
    passed,
    totalBlocks,
    classShifts,
    bigBrightnessShifts,
    threshold: DRIFT_THRESHOLD,
    details: !passed
      ? `DRIFT: ${(classShiftRatio * 100).toFixed(1)}% blocks shifted class (${classShifts}/${totalBlocks}, threshold ${DRIFT_THRESHOLD * 100}%)`
      : `OK: ${(classShiftRatio * 100).toFixed(1)}% blocks shifted (${classShifts}/${totalBlocks}) — macro structure preserved`,
  };
}
// ─── v72.4 POST-POLISH SHARPENING — counteract AI softness ──────────────────
// Applies a 3×3 unsharp-mask kernel on the canvas pixels.
// amount=0.35 is tuned for typical OpenAI edit output — enough to restore
// crisp edges without introducing halo artifacts.
function applySharpen(ctx, W, H, amount = 0.35) {
  const imageData = ctx.getImageData(0, 0, W, H);
  const src = new Uint8ClampedArray(imageData.data); // copy of original
  const dst = imageData.data;
  const a = amount;
  const center = 1 + 4 * a;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const val = center * src[i + c]
          - a * src[((y - 1) * W + x) * 4 + c]
          - a * src[((y + 1) * W + x) * 4 + c]
          - a * src[(y * W + (x - 1)) * 4 + c]
          - a * src[(y * W + (x + 1)) * 4 + c];
        dst[i + c] = val < 0 ? 0 : val > 255 ? 255 : (val + 0.5) | 0;
      }
      dst[i + 3] = src[i + 3]; // alpha unchanged
    }
  }
  ctx.putImageData(imageData, 0, 0);
}
// ─── v72.6 PARCEL ZONE OVERLAY — redrawn AFTER AI polish to guarantee visibility ───
// The AI polish tends to cover parcel boundaries with grass/texture.
// This function redraws the parcel fill, parcel border, and envelope dashed lines
// deterministically on top of the polished image. 100% safe per Supervisor protocol.
function drawParcelZone(ctx, W, H, parcelScreenPts, envelopeScreenPts) {
  if (!parcelScreenPts || parcelScreenPts.length < 3) return;
  // 1. Semi-transparent fill inside parcel — sand/beige to "clear" the grass invasion
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(parcelScreenPts[0].x, parcelScreenPts[0].y);
  for (let i = 1; i < parcelScreenPts.length; i++) {
    ctx.lineTo(parcelScreenPts[i].x, parcelScreenPts[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(222, 197, 155, 0.55)"; // sand/beige, semi-transparent
  ctx.fill();
  // 2. Parcel boundary — solid red/orange, thick
  ctx.beginPath();
  ctx.moveTo(parcelScreenPts[0].x, parcelScreenPts[0].y);
  for (let i = 1; i < parcelScreenPts.length; i++) {
    ctx.lineTo(parcelScreenPts[i].x, parcelScreenPts[i].y);
  }
  ctx.closePath();
  ctx.strokeStyle = "rgba(220, 80, 30, 0.9)";
  ctx.lineWidth = 3;
  ctx.stroke();
  // 3. Envelope (setback zone) — dashed red, thinner
  if (envelopeScreenPts && envelopeScreenPts.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(envelopeScreenPts[0].x, envelopeScreenPts[0].y);
    for (let i = 1; i < envelopeScreenPts.length; i++) {
      ctx.lineTo(envelopeScreenPts[i].x, envelopeScreenPts[i].y);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(200, 60, 30, 0.8)";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}
// ─── v72 DETERMINISTIC TREES — seeded PRNG, improved canopy, shadow casting ──
// Seed is derived from pixel coordinates → identical output on every run
function seedRandom(seed) {
  // Simple mulberry32 PRNG — deterministic from integer seed
  let t = (seed >>> 0) + 0x6D2B79F5;
  return function() {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function drawTrees(ctx, W, H) {
  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  const treePositions = [];
  const step = 28; // v72: tighter grid for more tree candidates
  const minTreeDist = 22; // minimum distance between tree centers
  // v72: seeded PRNG based on image dimensions (deterministic)
  const rng = seedRandom(W * 10000 + H);
  for (let y = step; y < H - step; y += step) {
    for (let x = step; x < W - step; x += step) {
      const idx = (y * W + x) * 4;
      const r = d[idx], g = d[idx+1], b = d[idx+2];
      // Is this a green grass pixel? (after applyColorRemap: ~R75,G145,B60)
      const isGrass = (g > 80 && g > r * 1.2 && g > b * 1.4 && r < 150);
      if (!isGrass) continue;
      // Check road nearby (sandy after remap: ~R195,G180,B145)
      let nearRoad = false;
      for (let dy = -20; dy <= 20; dy += 6) {
        for (let dx = -20; dx <= 20; dx += 6) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ni = (ny * W + nx) * 4;
          const nr = d[ni], ng = d[ni+1], nb = d[ni+2];
          if (nr > 120 && ng > 100 && nb > 70 && nr > ng && nr - nb > 25 && ng - nb > 15 && nr < 230) {
            nearRoad = true; break;
          }
        }
        if (nearRoad) break;
      }
      // Not on/near building (white/bright areas)
      let nearBuilding = false;
      for (let dy = -28; dy <= 4; dy += 6) {
        for (let dx = -14; dx <= 14; dx += 6) {
          const nx = Math.max(0, Math.min(W-1, x + dx));
          const ny = Math.max(0, Math.min(H-1, y + dy));
          const ni = (ny * W + nx) * 4;
          if (d[ni] > 200 && d[ni+1] > 200 && d[ni+2] > 190) { nearBuilding = true; break; }
        }
        if (nearBuilding) break;
      }
      // Not on parcel area (reddish boundary zone)
      let onParcel = false;
      const pr = d[idx], pg = d[idx+1], pb = d[idx+2];
      // Beige/sand parcel interior or red boundary
      if ((pr > 180 && pg > 150 && pb > 100 && pr > pg && pr - pb > 40) || (pr > 180 && pg < 140 && pb < 140)) {
        onParcel = true;
      }
      // v72: seeded selection — use PRNG instead of modulo hash for better distribution
      const selectChance = rng();
      if (nearRoad && !nearBuilding && !onParcel && selectChance < 0.35) {
        // Check min distance from existing trees
        let tooClose = false;
        for (const existing of treePositions) {
          const dx2 = x - existing.x, dy2 = y - existing.y;
          if (dx2 * dx2 + dy2 * dy2 < minTreeDist * minTreeDist) { tooClose = true; break; }
        }
        if (!tooClose) {
          // v72: slight jitter from PRNG for natural look (but deterministic)
          const jx = Math.round((rng() - 0.5) * 8);
          const jy = Math.round((rng() - 0.5) * 8);
          treePositions.push({ x: x + jx, y: y + jy });
        }
      }
      // v72: also place trees in open green areas (not just near roads)
      if (!nearRoad && !nearBuilding && !onParcel && isGrass && selectChance > 0.85 && selectChance < 0.92) {
        let tooClose = false;
        for (const existing of treePositions) {
          const dx2 = x - existing.x, dy2 = y - existing.y;
          if (dx2 * dx2 + dy2 * dy2 < (minTreeDist * 1.5) * (minTreeDist * 1.5)) { tooClose = true; break; }
        }
        if (!tooClose) {
          treePositions.push({ x: x + Math.round((rng() - 0.5) * 6), y: y + Math.round((rng() - 0.5) * 6) });
        }
      }
    }
  }
  console.log(`[TREES] v72: ${treePositions.length} deterministic trees placed (seeded PRNG)`);
  // v72: Sort by Y for correct overlap (back-to-front painter's order)
  treePositions.sort((a, b) => a.y - b.y);
  for (const t of treePositions) {
    // v72: seeded radius per tree — deterministic
    const tRng = seedRandom(t.x * 1000 + t.y);
    const radius = 9 + Math.round(tRng() * 7); // 9-16px range
    // Shadow (offset toward bottom-right — sun from upper-left)
    ctx.beginPath();
    ctx.arc(t.x + 3, t.y + 4, radius + 1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(15,40,10,0.30)";
    ctx.fill();
    // Canopy — multi-layer gradient for 3D spherical look
    ctx.beginPath();
    ctx.arc(t.x, t.y, radius, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(t.x - radius * 0.25, t.y - radius * 0.25, 1, t.x, t.y, radius);
    // v72: slightly varied greens per tree for natural look (seeded)
    const gVar = Math.round(tRng() * 20) - 10;
    grad.addColorStop(0, `rgb(${90 + gVar},${175 + gVar},${66 + gVar})`);
    grad.addColorStop(0.45, `rgb(${61 + gVar},${138 + gVar},${46 + gVar})`);
    grad.addColorStop(0.8, `rgb(${45 + gVar},${110 + gVar},${34 + gVar})`);
    grad.addColorStop(1, `rgb(${35 + gVar},${85 + gVar},${28 + gVar})`);
    ctx.fillStyle = grad;
    ctx.fill();
    // v72: subtle highlight spot for 3D depth
    ctx.beginPath();
    ctx.arc(t.x - radius * 0.2, t.y - radius * 0.2, radius * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(140,210,100,0.15)";
    ctx.fill();
  }
}
// ─── LÉGENDE + BOUSSOLE — SLIDE 4 AXO ────────────────────────────────────────
function drawLegendCompass(ctx, W, H, p) {
  const { site_area, bearing, setback_front, setback_side, setback_back } = p;
  ctx.save();
  ctx.translate(W - 58, 58);
  ctx.shadowColor = "rgba(0,0,0,0.15)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.96)"; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1; ctx.stroke();
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -3); ctx.lineTo(0, -8); ctx.lineTo(5, -3); ctx.closePath();
  ctx.fillStyle = "#c45030"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 3); ctx.lineTo(0, 8); ctx.lineTo(5, 3); ctx.closePath();
  ctx.fillStyle = "#ccc"; ctx.fill();
  ctx.rotate((bearing || 0) * Math.PI / 180);
  ctx.font = "bold 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#c45030";
  ctx.fillText("N", 0, -22);
  ctx.restore();
  const legItems = [
    { type: "rect", fill: "rgba(196,80,48,0.25)", stroke: "#c45030", label: "Parcelle — " + site_area + " m²" },
    { type: "dash", stroke: "#c45030", label: "Zone constructible (reculs)" },
    { type: "rect", fill: "#e0ddd8", stroke: "#b0ada6", label: "Bâtiment existant" },
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
  // v72.22: Setback labels DISABLED per user request
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
  // v64: Arc solaire sobre — teintes neutres, pas de bloom doré
  ctx.beginPath(); ctx.arc(SX, SY, SR - 6, sunriseAngle, sunsetAngle);
  ctx.strokeStyle = "rgba(180,160,100,0.12)"; ctx.lineWidth = 14; ctx.stroke();
  ctx.beginPath(); ctx.arc(SX, SY, SR - 6, sunriseAngle, sunsetAngle);
  const grad = ctx.createLinearGradient(
    SX + Math.cos(sunriseAngle) * SR, SY + Math.sin(sunriseAngle) * SR,
    SX + Math.cos(sunsetAngle)  * SR, SY + Math.sin(sunsetAngle)  * SR);
  grad.addColorStop(0, "rgba(180,120,40,0.4)"); grad.addColorStop(0.5, "rgba(200,160,60,0.6)"); grad.addColorStop(1, "rgba(180,100,30,0.4)");
  ctx.strokeStyle = grad; ctx.lineWidth = 4; ctx.stroke();
  const sunAngle = northRad + Math.PI;
  const sunX = SX + Math.cos(sunAngle) * (SR - 6), sunY = SY + Math.sin(sunAngle) * (SR - 6);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(sunX + Math.cos(a) * 6, sunY + Math.sin(a) * 6);
    ctx.lineTo(sunX + Math.cos(a) * 10, sunY + Math.sin(a) * 10);
    ctx.strokeStyle = "rgba(160,130,50,0.5)"; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.fillStyle = "#c8a030"; ctx.beginPath(); ctx.arc(sunX, sunY, 5, 0, 2 * Math.PI); ctx.fill();
  [
    { label: "N", angle: northRad, color: "#c45030", font: "bold 11px Arial" },
    { label: "S", angle: northRad + Math.PI, color: "#aaa", font: "9px Arial" },
    { label: "E", angle: sunriseAngle, color: "#888", font: "bold 10px Arial" },
    { label: "O", angle: sunsetAngle, color: "#888", font: "bold 10px Arial" },
  ].forEach(function(l) {
    const lx = SX + Math.cos(l.angle) * (SR + 4), ly = SY + Math.sin(l.angle) * (SR + 4);
    ctx.font = l.font; ctx.fillStyle = l.color; ctx.textAlign = "center"; ctx.fillText(l.label, lx, ly + 4);
  });
  ctx.font = "7px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "center";
  ctx.fillText("ENSOLEILLEMENT", SX, SY + SR + 18);
  ctx.restore();
}
// ─── OVERLAYS CANVAS — MASSING ────────────────────────────────────────────────
function drawMassingOverlays(ctx, W, H, { site_area, bearing, label, levels, commerce_levels, habitation_levels, total_height, floor_height, fp_m2, accent_color, scenario_role, typology, split_layout }) {
  const s = W / 1280;
  // ── BOUSSOLE N en bas à droite ──
  ctx.save();
  ctx.translate(W - 60*s, H - 60*s);
  ctx.shadowColor = "rgba(0,0,0,0.12)"; ctx.shadowBlur = 6*s; ctx.shadowOffsetY = 2*s;
  ctx.beginPath(); ctx.arc(0, 0, 32*s, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#c45030"; ctx.lineWidth = 2*s; ctx.stroke();
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.font = `bold ${11*s}px Arial`; ctx.textAlign = "center";
  ctx.fillStyle = "#c45030"; ctx.fillText("N", 0, -18*s);
  ctx.fillStyle = "#bbb"; ctx.fillText("S", 0, 24*s);
  ctx.fillStyle = "#bbb"; ctx.fillText("O", -22*s, 4*s);
  ctx.fillStyle = "#bbb"; ctx.fillText("E", 22*s, 4*s);
  ctx.restore();
  // ── ANNOTATIONS ÉTAGES : traits + labels à droite du bâtiment (style référence) ──
  const rdcH_m = 3.0;
  const etageH_m = 3.0;
  const lineLen = 14 * s;
  // v72.28: SPLIT_AV_AR — annotations LOGEMENT en haut, COMMERCE en dessous (même colonne droite)
  if (split_layout && split_layout.mode === "SPLIT_AV_AR") {
    const vc = split_layout.volume_commerce;
    const vl = split_layout.volume_logement;
    const annX = W * 0.62;
    const stepY = -32 * s;
    // ── LOGEMENT annotations (en haut, BLEU) — niveaux habitables sur pilotis ──
    const logtBaseY = H * 0.52;
    for (let f = 0; f < vl.levels; f++) {
      const y = logtBaseY + f * stepY;
      // v72.28: En SPLIT avec pilotis, le logement commence à R+1
      const floorLabel = `R+${f + 1}`;
      ctx.beginPath();
      ctx.moveTo(annX, y); ctx.lineTo(annX + lineLen, y);
      ctx.strokeStyle = "#3a7ac0"; ctx.lineWidth = 2*s; ctx.stroke();
      ctx.font = `bold ${12*s}px Arial`; ctx.textAlign = "left";
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
      ctx.strokeText(`${floorLabel} : ${vl.fp_m2} m²`, annX + lineLen + 6*s, y + 4*s);
      ctx.fillStyle = "#3a7ac0";
      ctx.fillText(`${floorLabel} : ${vl.fp_m2} m²`, annX + lineLen + 6*s, y + 4*s);
    }
    // Pilotis annotation
    const pilotisY = logtBaseY + 24*s;
    ctx.beginPath();
    ctx.moveTo(annX, pilotisY); ctx.lineTo(annX + lineLen, pilotisY);
    ctx.strokeStyle = "#b0aea8"; ctx.lineWidth = 2*s; ctx.stroke();
    ctx.font = `${11*s}px Arial`; ctx.textAlign = "left";
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
    ctx.strokeText(`Pilotis (RDC)`, annX + lineLen + 6*s, pilotisY + 4*s);
    ctx.fillStyle = "#888";
    ctx.fillText(`Pilotis (RDC)`, annX + lineLen + 6*s, pilotisY + 4*s);
    // Label "Logement" sous les niveaux
    const logtLabelY = pilotisY + 22*s;
    ctx.font = `bold ${11*s}px Arial`; ctx.textAlign = "left";
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
    ctx.strokeText(`Logement: ${vl.sdp_m2} m² SDP`, annX, logtLabelY);
    ctx.fillStyle = "#3a7ac0";
    ctx.fillText(`Logement: ${vl.sdp_m2} m² SDP`, annX, logtLabelY);
    // ── COMMERCE annotations (en dessous du logement, ORANGE) ──
    const commBaseY = logtLabelY + 28*s;
    for (let f = 0; f < vc.levels; f++) {
      const y = commBaseY + f * 24*s;
      const floorLabel = f === 0 ? "RDC" : `R+${f}`;
      ctx.beginPath();
      ctx.moveTo(annX, y); ctx.lineTo(annX + lineLen, y);
      ctx.strokeStyle = "#e07830"; ctx.lineWidth = 2*s; ctx.stroke();
      ctx.font = `bold ${12*s}px Arial`; ctx.textAlign = "left";
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
      ctx.strokeText(`${floorLabel} : ${vc.fp_m2} m² (commerce)`, annX + lineLen + 6*s, y + 4*s);
      ctx.fillStyle = "#e07830";
      ctx.fillText(`${floorLabel} : ${vc.fp_m2} m² (commerce)`, annX + lineLen + 6*s, y + 4*s);
    }
    // Label "Commerce" sous
    const commLabelY = commBaseY + vc.levels * 24*s + 4*s;
    ctx.font = `bold ${11*s}px Arial`; ctx.textAlign = "left";
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
    ctx.strokeText(`Commerce: ${vc.sdp_m2} m² SDP`, annX, commLabelY);
    ctx.fillStyle = "#e07830";
    ctx.fillText(`Commerce: ${vc.sdp_m2} m² SDP`, annX, commLabelY);
    // Total SDP en bas — NOIR avec contour blanc
    const totalSDP = (vc.sdp_m2 || 0) + (vl.sdp_m2 || 0);
    const totalY = commLabelY + 24*s;
    ctx.font = `bold ${13*s}px Arial`; ctx.textAlign = "left";
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
    ctx.strokeText(`Total: ${totalSDP.toLocaleString("fr-FR")} m² SDP`, annX, totalY);
    ctx.fillStyle = "#000000";
    ctx.fillText(`Total: ${totalSDP.toLocaleString("fr-FR")} m² SDP`, annX, totalY);
  } else {
    // ══ MODE SUPERPOSÉ : annotations par étage ══
    // v72.55: Annotations MIXTE = commerce (orange) pour les niveaux commerce + logement (bleu) pour le reste
    const commLev = commerce_levels || 0;
    const sdpTotale = fp_m2 * levels;
    const sdpCommerce = commLev > 0 ? fp_m2 * commLev : 0;
    const sdpLogement = sdpTotale - sdpCommerce;
    const annX = W * 0.62;
    const annBaseY = H * 0.58;
    const annStepY = -32 * s;
    for (let f = 0; f < levels; f++) {
      const y = annBaseY + f * annStepY;
      const floorLabel = f === 0 ? "RDC" : `R+${f}`;
      const isCommerce = f < commLev;
      ctx.beginPath();
      ctx.moveTo(annX, y); ctx.lineTo(annX + lineLen, y);
      ctx.strokeStyle = isCommerce ? "#e07830" : "#3a7ac0"; ctx.lineWidth = 2*s; ctx.stroke();
      const floorText = isCommerce ? `${floorLabel} : ${fp_m2} m² (commerce)` : `${floorLabel} : ${fp_m2} m²`;
      ctx.font = `bold ${12*s}px Arial`; ctx.textAlign = "left";
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
      ctx.strokeText(floorText, annX + lineLen + 6*s, y + 4*s);
      ctx.fillStyle = isCommerce ? "#e07830" : "#3a7ac0";
      ctx.fillText(floorText, annX + lineLen + 6*s, y + 4*s);
    }
    // Résumé commerce + logement + total
    let summaryY = annBaseY + 24*s;
    if (commLev > 0) {
      ctx.font = `bold ${11*s}px Arial`; ctx.textAlign = "left";
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
      ctx.strokeText(`Commerce: ${sdpCommerce.toLocaleString("fr-FR")} m² SDP`, annX, summaryY);
      ctx.fillStyle = "#e07830";
      ctx.fillText(`Commerce: ${sdpCommerce.toLocaleString("fr-FR")} m² SDP`, annX, summaryY);
      summaryY += 18*s;
      ctx.strokeText(`Logement: ${sdpLogement.toLocaleString("fr-FR")} m² SDP`, annX, summaryY);
      ctx.fillStyle = "#3a7ac0";
      ctx.fillText(`Logement: ${sdpLogement.toLocaleString("fr-FR")} m² SDP`, annX, summaryY);
      summaryY += 18*s;
    }
    ctx.font = `bold ${13*s}px Arial`; ctx.textAlign = "left";
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
    ctx.strokeText(`Total: ${sdpTotale.toLocaleString("fr-FR")} m² SDP`, annX, summaryY);
    ctx.fillStyle = "#000000";
    ctx.fillText(`Total: ${sdpTotale.toLocaleString("fr-FR")} m² SDP`, annX, summaryY);
  }
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
    front_edge,
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
  // v70: front_edge en paramètre = override, sinon détection OSM
  const frontEdgeIndex = (front_edge !== undefined && front_edge !== null && front_edge !== "")
    ? (console.log(`│ FRONT-EDGE: override depuis body → arête ${front_edge}`), Number(front_edge))
    : await findNearestRoadEdge(coords, cLat, cLon);
  const envelopeCoords = computeEnvelope(coords, cLat, cLon, Number(setback_front), Number(setback_side), Number(setback_back), frontEdgeIndex);
  const zoom = zoomOverride ? Number(zoomOverride) : computeZoom(coords, cLat, cLon);
  // v70.1: Slide 4 TOUJOURS orienté nord en haut (bearing=0) pour repérage facile
  const bearing = 0;
  console.log(`zoom=${zoom} bearing=${bearing}° (NORD EN HAUT) pitch=58°`);
  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}` });
    console.log(`Connected (${Date.now() - t0}ms)`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1280, deviceScaleFactor: 1 });
    const html = generateMapHTML({ lat: cLat, lon: cLon }, zoom, bearing, coords, envelopeCoords, MAPBOX_TOKEN, frontEdgeIndex);
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForFunction("window.__MAP_READY === true", { timeout: 20000 });
    const screenshotBuf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 1280 } });
    console.log(`Screenshot: ${screenshotBuf.length} bytes (${Date.now() - t0}ms)`);
    await page.close();
    const W = 1280, H = 1280;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(await loadImage(screenshotBuf), 0, 0);
    // ═══════════════════════════════════════════════════════════════════════
    // v72 DETERMINISTIC PIPELINE — all structural rendering BEFORE AI polish
    // Step 1: Color remap (Mapbox beige → green grass + sandy roads)
    // Step 2: Deterministic trees (seeded PRNG, identical every run)
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`[SLIDE4] v72: Applying deterministic color remap...`);
    applyColorRemap(ctx, W, H);
    console.log(`[SLIDE4] v72: Drawing deterministic trees...`);
    drawTrees(ctx, W, H);
    console.log(`[SLIDE4] v72: Applying deterministic shadows...`);
    applyDeterministicShadows(ctx, W, H);
    console.log(`[SLIDE4] v72: Applying warm color grading...`);
    applyWarmGrading(ctx, W, H);
    console.log(`[SLIDE4] v72: Applying light sharpening...`);
    applySharpen(ctx, W, H, 0.25);
    console.log(`[SLIDE4] v72: Deterministic pipeline complete (${Date.now() - t0}ms)`);
    // pngClean = Mapbox screenshot + color remap + trees — NO extra canvas drawings
    // Mapbox already draws the parcel + envelope in the HTML — don't duplicate
    const pngClean = canvas.toBuffer("image/png");
    // Screen coordinates for overlays (legend, setback labels) — drawn on fallback + after polish
    const pitch = 58;
    const scale = 256 * Math.pow(2, zoom) / (2 * Math.PI);
    function gpsToScreen(lat, lon) {
      const dx = (lon - cLat > 1000 ? lon : lon) - cLon;
      const dyMerc = Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) - Math.log(Math.tan(Math.PI / 4 + cLat * Math.PI / 360));
      const px = dx * Math.PI / 180 * scale;
      const py = -dyMerc * scale;
      const pitchRad = pitch * Math.PI / 180;
      const cosPitch = Math.cos(pitchRad);
      return { x: W / 2 + px, y: H / 2 + py * cosPitch };
    }
    const parcelScreenPts = coords.map(c => gpsToScreen(c.lat, c.lon));
    const envelopeScreenPts = envelopeCoords.map(c => gpsToScreen(c.lat, c.lon));
    drawLegendCompass(ctx, W, H, { site_area: Number(site_area), bearing, setback_front: Number(setback_front), setback_side: Number(setback_side), setback_back: Number(setback_back), parcelScreenPts, envelopeScreenPts, frontEdgeIndex });
    drawSolarArc(ctx, W, H, { bearing });
    const png = canvas.toBuffer("image/png");
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const slug = String(client_name || "client").toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const basePath = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;
    const { error: ue } = await sb.storage.from("massing-images").upload(basePath, png, { contentType: "image/png", upsert: true });
    if (ue) return res.status(500).json({ error: ue.message });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
    const cacheBust2 = `?v=${Date.now()}`;
    let enhancedUrl = pd.publicUrl + cacheBust2;
    // ═══════════════════════════════════════════════════════════════════════════
    // v72.20: HYBRID AI POLISH — strict stability protocol
    // Strategy: AI polishes ONLY the base texture (no overlays visible to AI)
    //           → strict drift scoring (25%) → redraw overlays on top
    //           → fallback to deterministic if all variations fail
    // ═══════════════════════════════════════════════════════════════════════════
    const SLIDE4_VARIATIONS = 3;
    const SLIDE4_AI_POLISH_ENABLED = true;
    const SLIDE4_DRIFT_THRESHOLD = 0.40; // 40% — allows tree enhancement + texture while catching structural drift
    if (SLIDE4_AI_POLISH_ENABLED && OPENAI_API_KEY) {
      try {
        console.log(`[SLIDE4-POLISH] v72.34: Robust hybrid pipeline — ${SLIDE4_VARIATIONS} variations, drift threshold ${SLIDE4_DRIFT_THRESHOLD * 100}%, model=${POLISH_MODEL}`);
        // v72.34: Resize for API reliability
        const resized = await resizeForPolish(pngClean, POLISH_MAX_IMAGE_DIM);
        const b64Input = resized.buf.toString("base64");
        console.log(`[SLIDE4-POLISH] Input: ${(resized.buf.length / 1024).toFixed(0)}KB (${resized.w}×${resized.h})`);
        // ── ARCHITECTURAL POLISH PROMPT — matches reference render ─────────
        const polishPrompt = [
          "STRICT EDIT ONLY. This is a 3D axonometric urban planning site plan render.",
          "PRESERVE EXACT: camera angle, perspective, building positions, building shapes, building count, road layout, parcel geometry, image framing, image dimensions.",
          "Do NOT move, add, remove, or redesign any building.",
          "Do NOT change the camera angle or perspective.",
          "Do NOT add people, vehicles, text, labels, or watermarks.",
          "Apply ONLY these specific enhancements:",
          "1. Replace the simple green sphere trees with realistic architectural maquette-style trees (same positions, same sizes, natural leafy canopy).",
          "2. Add subtle realistic shadows under buildings (soft, natural afternoon light from the south).",
          "3. Give the white/light buildings a subtle clean matte concrete texture (keep them white/light, do not darken them).",
          "4. Enhance the green grass ground with subtle natural grass texture (keep the same green tone).",
          "5. Refine road surfaces with subtle asphalt texture.",
          "6. Overall warm afternoon lighting with gentle ambient occlusion.",
          "Style: premium architectural maquette visualization. Clean, professional, minimal. No artistic effects, no painterly style.",
          "The buildings must remain in the EXACT SAME positions. The layout must be IDENTICAL."
        ].join(" ");
        // v72.34: Use robust polish engine with retry + timeout
        const polishResults = await Promise.all(
          Array.from({ length: SLIDE4_VARIATIONS }, (_, v) =>
            callPolishAPI(b64Input, polishPrompt, "SLIDE4", v + 1)
          )
        );
        console.log(`[SLIDE4-POLISH] ${SLIDE4_VARIATIONS} API calls completed (${Date.now() - t0}ms)`);
        // ── DRIFT SCORING — pick best under threshold ───────────────────────
        let bestVariation = null;
        let bestDriftScore = 1.0;
        const variationLog = [];
        for (let v = 0; v < polishResults.length; v++) {
          const result = polishResults[v];
          if (result.error) {
            variationLog.push(`  v${v+1}: ${result.error} — ${(result.details || "").substring(0, 150)}`);
            continue;
          }
          const enhancedBuf = Buffer.from(result.b64, "base64");
          // v72.20: Strict drift check — threshold 25%
          const drift = await detectDriftFromBuffers(pngClean, enhancedBuf, W, H, SLIDE4_DRIFT_THRESHOLD);
          const pct = (drift.driftScore * 100).toFixed(1);
          const pass = drift.driftScore < SLIDE4_DRIFT_THRESHOLD ? "PASS" : "FAIL";
          variationLog.push(`  v${v+1}: drift=${pct}% (${drift.classShifts}/${drift.totalBlocks} blocks) → ${pass}`);
          // Only consider variations that PASS the threshold
          if (drift.driftScore < SLIDE4_DRIFT_THRESHOLD && drift.driftScore < bestDriftScore) {
            bestDriftScore = drift.driftScore;
            bestVariation = { buf: enhancedBuf, drift, index: v + 1 };
          }
        }
        console.log(`[SLIDE4-POLISH] v72.20 Multi-render results (${Date.now() - t0}ms):\n${variationLog.join("\n")}`);
        if (bestVariation) {
          console.log(`[SLIDE4-POLISH] ✓ ACCEPTED v${bestVariation.index} (drift=${(bestDriftScore * 100).toFixed(1)}% < ${SLIDE4_DRIFT_THRESHOLD * 100}% threshold)`);
          const polishedImg = await loadImage(bestVariation.buf);
          const finalCanvas = createCanvas(W, H);
          const finalCtx = finalCanvas.getContext("2d");
          finalCtx.drawImage(polishedImg, 0, 0, W, H);
          // Black bar detection — crop if AI shifted content
          const scanData = finalCtx.getImageData(0, 0, W, H).data;
          let leftBlack = 0, rightBlack = 0, topBlack = 0, bottomBlack = 0;
          for (let x = 0; x < W / 4; x++) {
            let isBlack = true;
            for (let y = 0; y < H; y += 10) {
              const idx = (y * W + x) * 4;
              if (scanData[idx] + scanData[idx+1] + scanData[idx+2] > 30) { isBlack = false; break; }
            }
            if (isBlack) leftBlack = x + 1; else break;
          }
          for (let x = W - 1; x > W * 3 / 4; x--) {
            let isBlack = true;
            for (let y = 0; y < H; y += 10) {
              const idx = (y * W + x) * 4;
              if (scanData[idx] + scanData[idx+1] + scanData[idx+2] > 30) { isBlack = false; break; }
            }
            if (isBlack) rightBlack = W - x; else break;
          }
          for (let y = 0; y < H / 4; y++) {
            let isBlack = true;
            for (let x = 0; x < W; x += 10) {
              const idx = (y * W + x) * 4;
              if (scanData[idx] + scanData[idx+1] + scanData[idx+2] > 30) { isBlack = false; break; }
            }
            if (isBlack) topBlack = y + 1; else break;
          }
          for (let y = H - 1; y > H * 3 / 4; y--) {
            let isBlack = true;
            for (let x = 0; x < W; x += 10) {
              const idx = (y * W + x) * 4;
              if (scanData[idx] + scanData[idx+1] + scanData[idx+2] > 30) { isBlack = false; break; }
            }
            if (isBlack) bottomBlack = H - y; else break;
          }
          if (leftBlack > 2 || rightBlack > 2 || topBlack > 2 || bottomBlack > 2) {
            console.log(`[SLIDE4-POLISH] Black bars L=${leftBlack} R=${rightBlack} T=${topBlack} B=${bottomBlack} — cropping`);
            const srcX = leftBlack, srcY = topBlack;
            const srcW = W - leftBlack - rightBlack, srcH = H - topBlack - bottomBlack;
            finalCtx.clearRect(0, 0, W, H);
            finalCtx.drawImage(polishedImg, srcX, srcY, srcW, srcH, 0, 0, W, H);
          }
          // Post-polish sharpening to counteract AI softness
          applySharpen(finalCtx, W, H, 0.30);
          // ── REDRAW OVERLAYS on polished image (AI never saw these) ─────────
          drawLegendCompass(finalCtx, W, H, { site_area: Number(site_area), bearing, setback_front: Number(setback_front), setback_side: Number(setback_side), setback_back: Number(setback_back), parcelScreenPts, envelopeScreenPts, frontEdgeIndex });
          drawSolarArc(finalCtx, W, H, { bearing });
          const finalPng = finalCanvas.toBuffer("image/png");
          const enhancedPath = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}_enhanced.png`;
          const { error: ue2 } = await sb.storage.from("massing-images").upload(enhancedPath, finalPng, { contentType: "image/png", upsert: true, cacheControl: "0" });
          if (!ue2) {
            const { data: pd2 } = sb.storage.from("massing-images").getPublicUrl(enhancedPath);
            enhancedUrl = pd2.publicUrl + `?v=${Date.now()}`;
            console.log(`✓ [SLIDE4-POLISH] Enhanced uploaded: ${enhancedUrl} (${Date.now() - t0}ms)`);
          }
        } else {
          console.log(`⚠ [SLIDE4-POLISH] ALL ${SLIDE4_VARIATIONS} variations FAILED drift check (>${SLIDE4_DRIFT_THRESHOLD * 100}%) — using deterministic fallback`);
          // Fallback: deterministic render is already in 'png' with overlays — no action needed
        }
      } catch (oaiErr) {
        console.error("[SLIDE4-POLISH] Exception:", oaiErr.message);
        console.log("[SLIDE4-POLISH] Fallback to deterministic render (already uploaded)");
      }
    } else {
      if (!OPENAI_API_KEY) console.log("[SLIDE4-POLISH] OPENAI_API_KEY absent — using deterministic render");
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
  console.log("═══ /generate-massing v72.59 ═══");
  // v72.54: SANITIZE #VALUE! from Google Sheet — replace all #VALUE!, #REF!, #N/A, #ERROR! with empty string
  for (const key of Object.keys(req.body)) {
    if (typeof req.body[key] === "string" && /^#(VALUE|REF|N\/A|ERROR|NAME|NULL|DIV\/0)!?/i.test(req.body[key].trim())) {
      console.log(`[SANITIZE] ${key}="${req.body[key]}" → "" (Google Sheet error)`);
      req.body[key] = "";
    }
  }
  console.log(`[BODY] massing_label="${req.body.massing_label}" slide_name="${req.body.slide_name}" compute_scenario="${req.body.compute_scenario}" render_label="${req.body.render_label}"`);
  console.log(`[BODY] lead_id="${req.body.lead_id}" layout_mode="${req.body.layout_mode}" commerce_depth_m="${req.body.commerce_depth_m}"`);
  console.log(`[BODY_RAW] ${JSON.stringify(req.body).slice(0, 500)}`);
  const {
    lead_id, client_name, polygon_points,
    site_area, setback_front, setback_side, setback_back,
    envelope_w, envelope_d, envelope_area: envelope_area_raw,  // v72.55: CRITIQUE — manquait, causait SDP ×2
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
    budget_range, budget_range_raw, budget_band, budget_tension,
    standing_level, rent_score, capacity_score,
    mix_score, phase_score, risk_score,
    density_pressure_factor, driver_intensity, strategic_position,
    // ── Contexte parcelle occupée / rénovation ──
    project_type,          // NEUF | RENOVATION | EXTENSION | SURELEVATION | DEMOLITION_RECONSTRUCTION
    existing_footprint_m2, // emprise existante si parcelle déjà construite
    // ── v56.7 : orientation rue ──
    road_bearing,          // azimut de la route principale (degrés, depuis la Sheet)
    front_edge,            // v70: override index arête front (0-3)
    // ── v72.22 : disposition spatiale commerce/logement ──
    layout_mode,           // SUPERPOSE (défaut) | SPLIT_AV_AR | SPLIT_LAT | LINEAIRE
    commerce_depth_m,      // profondeur bande commerciale (défaut 6m)
    retrait_inter_volumes_m, // distance entre les 2 volumes (défaut 4m)
    // ── v72.50 : champ dédié disposition du formulaire Google (colonne BE) ──
    disposition,           // "Commerce devant, logement en retrait" | "Tout dans un seul bâtiment" | vide
    // ── v72.54 : label explicite pour différencier A/B/C quand Make.com envoie massing_label=A pour tout ──
    render_label,          // "A" | "B" | "C" — override explicite depuis Make.com
  } = req.body;
  if (!lead_id || !polygon_points) return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });
  if (!envelope_w || !envelope_d) return res.status(400).json({ error: "envelope_w, envelope_d obligatoires" });
  // v72.54: PARSING ROBUSTE — même logique que /compute-scenarios
  // Make.com envoie "20 - 6" (formule Sheet comme texte) → Number("20 - 6") = NaN → CRASH SILENCIEUX
  const _safeFloatM = (v) => {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return isNaN(v) ? 0 : v;
    const s = String(v).trim();
    const n = Number(s);
    if (!isNaN(n)) return n;
    const f = parseFloat(s);
    return (!isNaN(f)) ? f : 0;
  };
  const envW = _safeFloatM(envelope_w);
  const envD = _safeFloatM(envelope_d);
  let envArea = _safeFloatM(envelope_area_raw); // v72.55: zone constructible réelle (après retraits)
  const floorH = _safeFloatM(fh_raw) || 3.2;
  // v72.56-57: Si envelope_area n'est PAS fourni par Make.com (= 0 ou absent),
  // on le CALCULE à partir des retraits réglementaires — sinon envW×envD (BRUT) surestime de 50-110%
  if (!envArea || envArea <= 0) {
    const RETRAITS_ZONING = {
      URBAIN: { avant: 5, lateral: 3, arriere: 3 },
      PERIURBAIN: { avant: 6, lateral: 4, arriere: 4 },
      MIXTE: { avant: 5, lateral: 3, arriere: 3 },
      PAVILLON: { avant: 6, lateral: 4, arriere: 4 },
      RURAL: { avant: 8, lateral: 5, arriere: 5 },
    };
    const zoneKey = String(zoning_type || "URBAIN").toUpperCase();
    const zr = RETRAITS_ZONING[zoneKey] || RETRAITS_ZONING.URBAIN;
    // Utiliser les setbacks explicites du body si fournis, sinon les retraits réglementaires
    const sf = _safeFloatM(setback_front) || zr.avant;
    const ss = _safeFloatM(setback_side) || zr.lateral;
    const sb = _safeFloatM(setback_back) || zr.arriere;
    const netW = Math.max(5, envW - 2 * ss);
    const netD = Math.max(5, envD - sf - sb);
    envArea = Math.round(netW * netD);
    console.log(`[v72.59] ⚠️ envelope_area NON FOURNI → calculé depuis retraits: (${envW}-2×${ss}) × (${envD}-${sf}-${sb}) = ${netW}×${netD} = ${envArea}m²`);
  }
  console.log(`[v72.59] PARSED DIMS: envW=${envW} envD=${envD} envArea=${envArea} floorH=${floorH} (raw: w="${envelope_w}" d="${envelope_d}" area="${envelope_area_raw}")`);
  if (envW * envD > 0 && Math.abs(envW * envD - envArea) > envArea * 0.3) {
    console.log(`[v72.59] ⚠️ ALERTE: envW×envD=${envW*envD}m² vs envelope_area=${envArea}m² — écart ${Math.round((envW*envD/envArea-1)*100)}%`);
  }
  // v72.56-57: DÉTECTION ROBUSTE DU LABEL (A/B/C) + COMPTEUR AUTOMATIQUE
  // Make.com envoie souvent massing_label="A" pour les 3 requêtes → INUTILISABLE.
  // SOLUTION DÉFINITIVE : compteur par lead_id qui cycle A → B → C automatiquement.
  let label = "A"; // défaut
  const slideStr = String(slide_name || "").toUpperCase();
  const rawLabel = String(massing_label || "").toUpperCase().trim();
  const explicitLabel = String(render_label || "").toUpperCase().trim();
  let labelSource = "default";
  // PRIORITÉ 0: render_label (champ explicite — le plus fiable si Make.com l'envoie)
  if (["A", "B", "C"].includes(explicitLabel)) {
    label = explicitLabel;
    labelSource = "render_label";
  }
  // PRIORITÉ 1: slide_name (regex A/B/C + mots-clés INTENSIF/EQUILIBRE/PRUDENT)
  else {
    const slideMatch = slideStr.match(/(?:MASSING|SCENARIO|SC)[_\s.-]*([ABC])\b/)
      || slideStr.match(/[_\s.-]([ABC])[_\s.-]/)
      || slideStr.match(/[_\s.-]([ABC])$/)
      || slideStr.match(/\b([ABC])\b/);
    // v72.56-57: aussi détecter INTENSIF/EQUILIBRE/PRUDENT dans slide_name
    const slideRole = /INTENSIF/i.test(slideStr) ? "A" : /EQUILIB/i.test(slideStr) ? "B" : /PRUDENT/i.test(slideStr) ? "C" : null;
    if (slideMatch) {
      label = slideMatch[1];
      labelSource = "slide_name_regex";
    } else if (slideRole) {
      label = slideRole;
      labelSource = "slide_name_role";
    } else {
      // PRIORITÉ 2: COMPTEUR AUTOMATIQUE par lead_id — cycle A → B → C
      // C'est le FILET DE SÉCURITÉ quand Make.com envoie le même label/slide pour tout
      if (!global.__massingCallCounter) global.__massingCallCounter = {};
      const counterKey = String(lead_id).trim();
      if (!global.__massingCallCounter[counterKey]) {
        global.__massingCallCounter[counterKey] = { count: 0, ts: Date.now() };
      }
      // Reset le compteur si le dernier appel date de > 5 minutes (nouveau run)
      const counterEntry = global.__massingCallCounter[counterKey];
      if (Date.now() - counterEntry.ts > 5 * 60 * 1000) {
        counterEntry.count = 0;
      }
      const labels = ["A", "B", "C"];
      label = labels[counterEntry.count % 3];
      counterEntry.count++;
      counterEntry.ts = Date.now();
      labelSource = `auto_counter(${counterEntry.count})`;
      // Nettoyer les vieux compteurs (> 30min) pour éviter fuite mémoire
      const now = Date.now();
      for (const k of Object.keys(global.__massingCallCounter)) {
        if (now - global.__massingCallCounter[k].ts > 30 * 60 * 1000) delete global.__massingCallCounter[k];
      }
    }
  }
  console.log(`[v72.59] ═══ LABEL FINAL: "${label}" ═══ (source=${labelSource}, render_label="${render_label}", massing_label="${massing_label}", slide_name="${slide_name}")`);
  // ── v72.59: DÉTECTION SPLIT — ROBUSTE (même logique que v72.34 parfait) ──
  // Signal 1: layout_mode explicitement SPLIT_AV_AR
  const layoutModeIsSplit = String(layout_mode || "").toUpperCase() === "SPLIT_AV_AR";
  // Signal 2: disposition (formulaire Google) mentionne commerce devant/split
  const dispositionRaw = String(disposition || "").toLowerCase();
  const dispositionIsSplit = /commerce devant|retrait|split/i.test(dispositionRaw);
  // Signal 3: body contient des mots-clés SPLIT dans TOUTES les valeurs
  const fieldValues = Object.values(req.body).map(v => String(v).toLowerCase()).join(" ");
  const bodyHasSplit = /split.?av|commerce.?devant|devant.?retrait|dissoci/i.test(fieldValues);
  // Signal 4: commerce_depth_m > 0 avec programme mixte → FORCÉMENT du SPLIT
  const bodyHasMixte = /mixte|mixed|usage.?mixte/i.test(fieldValues);
  const hasCommerceDepth = Number(commerce_depth_m) > 0;
  // ── Résolution SPLIT ──
  const effectiveLayoutMode = (layoutModeIsSplit || dispositionIsSplit || bodyHasSplit || (hasCommerceDepth && bodyHasMixte))
    ? "SPLIT_AV_AR" : "SUPERPOSE";
  const splitActive = effectiveLayoutMode === "SPLIT_AV_AR";
  // ── Détection MIXTE ──
  const effectiveProgramMain = program_main || project_type || ((bodyHasMixte || splitActive) ? "USAGE_MIXTE" : "");
  console.log(`[MASSING v72.59] ┌── DÉTECTION SPLIT ──`);
  console.log(`[MASSING v72.59] │ layout_mode="${layout_mode}" → ${layoutModeIsSplit}`);
  console.log(`[MASSING v72.59] │ disposition="${dispositionRaw}" → ${dispositionIsSplit}`);
  console.log(`[MASSING v72.59] │ bodyHasSplit=${bodyHasSplit} | commerce_depth=${commerce_depth_m} hasCommerceDepth=${hasCommerceDepth} bodyHasMixte=${bodyHasMixte}`);
  console.log(`[MASSING v72.59] │ → effectiveLayoutMode="${effectiveLayoutMode}" splitActive=${splitActive}`);
  console.log(`[MASSING v72.59] │ effectiveProgramMain="${effectiveProgramMain}"`);
  console.log(`[MASSING v72.59] └── FIN DÉTECTION ──`);
  // ── Déterminer les paramètres du scénario ──
  let fp, levels, totalH, commerceLevels, scenarioRole, accentColor, splitLayout = null;
  let has_pilotis = false; // v72.54: déclaration explicite (évite implicit global)
  // ══════════════════════════════════════════════════════════════════════
  // v72.59: SHEET PASS-THROUGH — PRIORITÉ ABSOLUE
  // Make.com envoie A_fp, A_levels, A_sdp, A_split_layout etc. directement
  // depuis /compute-scenarios → on les utilise TELS QUELS → ZÉRO DIVERGENCE
  // ══════════════════════════════════════════════════════════════════════
  const sheetFp = _safeFloatM(req.body[`${label}_fp`]);
  const sheetLevels = Math.round(_safeFloatM(req.body[`${label}_levels`]));
  const sheetSdp = _safeFloatM(req.body[`${label}_sdp`]);
  const sheetHeight = _safeFloatM(req.body[`${label}_height`]);
  const sheetCommLevels = Math.round(_safeFloatM(req.body[`${label}_commerce_levels`]));
  const sheetPilotis = /true/i.test(String(req.body[`${label}_has_pilotis`] || ""));
  const sheetAccent = req.body[`${label}_accent_color`] || "";
  const sheetRole = req.body[`${label}_role`] || "";
  const sheetSplitJson = req.body[`${label}_split_layout`] || "";
  console.log(`[v72.59] SHEET CHECK: ${label}_fp=${sheetFp} ${label}_levels=${sheetLevels} ${label}_sdp=${sheetSdp} ${label}_commerce_levels=${sheetCommLevels} ${label}_split_layout=${sheetSplitJson ? "OUI(" + sheetSplitJson.length + "chars)" : "NON"}`);

  if (sheetFp > 0 && sheetLevels > 0) {
    // ═══ MODE SHEET PASS-THROUGH — GARANTI COHÉRENT AVEC LA SHEET ═══
    fp = sheetFp;
    levels = sheetLevels;
    totalH = sheetHeight || levels * floorH;
    commerceLevels = sheetCommLevels;
    has_pilotis = sheetPilotis;
    scenarioRole = sheetRole || (label === "A" ? "INTENSIFICATION" : label === "B" ? "ÉQUILIBRE" : "PRUDENT");
    accentColor = sheetAccent || (label === "A" ? "#2a5298" : label === "B" ? "#34a853" : "#ea4335");
    // Parse split_layout JSON si présent
    if (sheetSplitJson) {
      try {
        splitLayout = JSON.parse(sheetSplitJson);
        console.log(`[v72.59] ★ SPLIT LAYOUT FROM SHEET: mode=${splitLayout.mode} commerce=${splitLayout.volume_commerce?.sdp_m2}m² logement=${splitLayout.volume_logement?.sdp_m2}m²`);
      } catch (e) {
        console.log(`[v72.59] ⚠️ split_layout JSON invalide: ${e.message}`);
        splitLayout = null;
      }
    }
    console.log(`[v72.59] ★★★ SHEET PASS-THROUGH: ${label} → fp=${fp}m² levels=${levels} sdp_sheet=${sheetSdp} commerce=${commerceLevels} pilotis=${has_pilotis} split=${splitLayout ? splitLayout.mode : "NON"}`);
  } else if (compute_scenario || !fp_m2_raw || !levels_raw) {
    // ═══ MODE SMART — recalcul (fallback quand Make.com n'envoie pas les champs {label}_*) ═══
    console.log(`[v72.59] SMART FALLBACK: pas de champs ${label}_fp/${label}_levels dans le body → recalcul`);
    if (!site_area) return res.status(400).json({ error: "site_area obligatoire en mode compute_scenario" });
    // ── v72.59: Utiliser la fonction partagée pour calculer les scores ──
    const masteredScores = computeScoresFromRaw(req.body);
    const scenarios = computeSmartScenarios({
      site_area: _safeFloatM(site_area),
      envelope_w: envW,
      envelope_d: envD,
      envelope_area: envArea || undefined,
      zoning_type: String(zoning_type),
      floor_height: floorH,
      primary_driver: primary_driver || "MAX_CAPACITE",
      max_floors: Number(max_floors) || 99,
      max_height_m: Number(max_height_m) || 99,
      program_main: effectiveProgramMain,
      target_surface_m2: Number(target_surface_m2) || 0,
      target_units: Number(target_units) || 0,
      site_saturation_level: site_saturation_level || "MEDIUM",
      financial_rigidity_score: Number(financial_rigidity_score) || 0,
      density_band: masteredScores.density_band,
      risk_adjusted: masteredScores.risk_adjusted,
      feasibility_posture: masteredScores.feasibility_posture,
      scenario_A_role: scenario_A_role || "",
      scenario_B_role: scenario_B_role || "",
      scenario_C_role: scenario_C_role || "",
      budget_range: Number(budget_range) || 0,
      budget_band: budget_band || "",
      budget_tension: Number(budget_tension) || 0,
      standing_level: standing_level || "STANDARD",
      rent_score: masteredScores.rent_score,
      capacity_score: masteredScores.capacity_score,
      mix_score: masteredScores.mix_score,
      phase_score: masteredScores.phase_score,
      risk_score: masteredScores.risk_score,
      density_pressure_factor: masteredScores.density_pressure_factor,
      driver_intensity: masteredScores.driver_intensity,
      strategic_position: masteredScores.strategic_position,
      layout_mode: effectiveLayoutMode,
      commerce_depth_m: Number(commerce_depth_m) || 6,
      retrait_inter_volumes_m: Number(retrait_inter_volumes_m) || 4,
    });
    const sc = scenarios[label] || scenarios.A;
    console.log(`[v72.59] SMART: ${label} → fp=${sc.fp_m2}m² levels=${sc.levels} sdp=${sc.sdp_m2}`);
    fp = sc.fp_m2;
    levels = sc.levels;
    totalH = sc.height_m;
    commerceLevels = sc.commerce_levels;
    has_pilotis = sc.has_pilotis || false;
    scenarioRole = sc.label_fr;
    accentColor = sc.accent_color;
    splitLayout = sc.split_layout || null;
    console.log(`SMART MODE: ${label} → fp=${fp}m² levels=${levels} h=${totalH}m commerce=${commerceLevels} pilotis=${has_pilotis} layout=${splitLayout ? splitLayout.mode : "SUPERPOSE"}`);
  } else {
    // MODE CLASSIQUE : valeurs de la sheet
    fp = Number(fp_m2_raw);
    levels = Number(levels_raw);
    totalH = Number(height_raw) || levels * floorH;
    // v72.22: commerce_levels — si la sheet envoie une valeur, on la respecte.
    // Sinon, on cross-check program_main ou layout_mode : si mixte ou SPLIT → 1 niveau commerce (RDC)
    const rawComm = Number(commerce_raw);
    if (rawComm > 0) {
      commerceLevels = rawComm;
    } else if (/mixte|mixed/i.test(effectiveProgramMain) || splitActive) {
      commerceLevels = 1; // commerce toujours au RDC
      console.log(`[CLASSIC] commerce_raw vide mais effectiveProgram="${effectiveProgramMain}" split=${splitActive} → commerce_levels=1 (RDC)`);
    } else {
      commerceLevels = 0;
    }
    has_pilotis = false;
    scenarioRole = String(role_raw);
    accentColor = String(accent_raw);
    console.log(`CLASSIC MODE: ${label} → fp=${fp}m² levels=${levels} h=${totalH}m commerce=${commerceLevels}`);
  }
  // v72.22: FILET ULTIME — si le body contient "mixte" MAIS commerceLevels est toujours 0, on force
  // Ça arrive quand Make.com envoie program_main vide pour certains scénarios
  if (commerceLevels === 0 && (bodyHasMixte || splitActive)) {
    commerceLevels = 1;
    console.log(`[OVERRIDE] commerceLevels=0 mais body contient mixte/split → FORCÉ à 1 (commerce RDC ORANGE)`);
  }
  // v72.28: Si mixte SUPERPOSÉ et 1 seul niveau, forcer à 2 minimum (1 commerce + 1 logement)
  // En SPLIT, les levels = logement seulement (commerce est un volume séparé) → PAS de override
  if (commerceLevels > 0 && levels <= commerceLevels && !splitLayout) {
    const oldLevels = levels;
    levels = commerceLevels + 1;
    console.log(`[OVERRIDE] levels=${oldLevels} ≤ commerce=${commerceLevels} → forcé à ${levels} (minimum 1 logement au-dessus du commerce)`);
  }
  // ══════════════════════════════════════════════════════════════════════
  // v72.59: SPLIT SYNTHÉTIQUE — COHÉRENT AVEC LE SDP SHEET
  // Si le body demande un SPLIT mais splitLayout est null → on le construit.
  // Le SDP total du split DOIT matcher le SDP de la Sheet (sheetSdp ou fp×levels).
  // C (PRUDENT) = TOUJOURS SUPERPOSÉ compact (volume unique).
  // ══════════════════════════════════════════════════════════════════════
  if (!splitLayout && effectiveLayoutMode === "SPLIT_AV_AR" && commerceLevels > 0 && label !== "C") {
    const commDepth = Number(commerce_depth_m) || 6;
    // SDP total cible = celui de la Sheet si dispo, sinon fp × levels
    const sdpTarget = (sheetSdp > 0) ? sheetSdp : Math.round(fp * levels);
    // Commerce: emprise = largeur_envelope × profondeur_commerce (surface réelle au sol)
    const commWidth = Math.max(5, Math.round(envW * 0.7));
    const commFp = Math.round(commWidth * commDepth);
    const commSdp = commFp * commerceLevels;
    // Logement: SDP = total - commerce (GARANTI COHÉRENT)
    const logtSdp = Math.max(0, sdpTarget - commSdp);
    // Niveaux logement: déduits du SDP logement ÷ emprise
    const logtFp = fp; // emprise logement = emprise moteur
    let logtLevels = logtFp > 0 ? Math.max(1, Math.round(logtSdp / logtFp)) : 1;
    // Forçage minimum: A ≥ 3 niveaux, B ≥ 2 niveaux
    const maxLogtFloors = Math.max(1, (Number(max_floors) || 99) - commerceLevels);
    if (label === "A") logtLevels = Math.min(maxLogtFloors, Math.max(3, logtLevels));
    else if (label === "B") logtLevels = Math.min(maxLogtFloors, Math.max(2, logtLevels));
    // Recalculer SDP logement avec les niveaux ajustés
    const logtSdpFinal = logtFp * logtLevels;
    console.log(`[v72.59] SPLIT SYNTHÉTIQUE ${label}: sdpTarget=${sdpTarget} → commerce=${commFp}m²×${commerceLevels}niv=${commSdp}m² + logement=${logtFp}m²×${logtLevels}niv=${logtSdpFinal}m² = total ${commSdp + logtSdpFinal}m²`);
    splitLayout = {
      mode: "SPLIT_AV_AR",
      volume_commerce: {
        fp_m2: commFp,
        width_m: commWidth,
        depth_m: commDepth,
        levels: commerceLevels,
        sdp_m2: commSdp,
        units: Math.max(1, Math.floor(commFp / 30)),
        position: "AVANT (contre clôture)",
      },
      volume_logement: {
        fp_m2: logtFp,
        width_m: Math.round(envW * 0.7),
        depth_m: Math.round(envD * 0.45),
        levels: logtLevels,
        sdp_m2: logtSdpFinal,
        units: 0,
        position: "ARRIÈRE (sur pilotis)",
      },
      retrait_inter_m: Number(retrait_inter_volumes_m) || 4,
    };
    has_pilotis = true; // SPLIT = logement TOUJOURS sur pilotis
    console.log(`[v72.59] SPLIT CONSTRUIT: 2 volumes séparés — commerce DEVANT + logement DERRIÈRE sur pilotis`);
  }
  // v72.32: En SPLIT (moteur ou synthétique), levels doit = niveaux LOGEMENT uniquement
  // Car le rendu 3D utilise: realTotalH = rdcH + levels * etageH (pilotis + N étages)
  // Si levels reste en mode SUPERPOSÉ (total), la hauteur est fausse
  if (splitLayout && splitLayout.volume_logement) {
    levels = splitLayout.volume_logement.levels;
    console.log(`[v72.32] SPLIT levels sync: levels=${levels} (logement seul, depuis splitLayout.volume_logement.levels)`);
  }
  const slideName = slide_name || ("massing_" + label.toLowerCase());
  const commerceH = commerceLevels * floorH;
  const habitationLevels = splitLayout ? levels : levels - commerceLevels;
  // v72.23: LOG DIAGNOSTIC COMPLET — traçabilité moteur → 3D
  console.log(`┌── MASSING DIAGNOSTIC v72.22 ──`);
  console.log(`│ Scénario: ${label} (${compute_scenario ? "SMART" : "CLASSIQUE"})`);
  console.log(`│ program_main="${program_main}" effectiveProgramMain="${effectiveProgramMain}"`);
  console.log(`│ commerce_raw="${commerce_raw}" → commerceLevels=${commerceLevels}`);
  console.log(`│ fp=${fp}m² × levels=${levels} = ${Math.round(fp * levels)}m² SDP`);
  console.log(`│ ${commerceLevels > 0 ? `MIXTE: ${commerceLevels} RDC commerce (ORANGE) + ${habitationLevels} logement (BLEU)` : `LOGEMENT PUR: ${levels} niveaux BLEU`}`);
  console.log(`│ site_area=${site_area} envelope=${envW}×${envD}`);
  console.log(`│ mix_score=${mix_score} rent_score=${rent_score} capacity_score=${capacity_score}`);
  console.log(`│ scenario_role=${scenarioRole} accent=${accentColor}`);
  console.log(`└── end MASSING DIAGNOSTIC ──`);
  const { w: mw, d: md, offset_x: ox, offset_y: oy } = computeMassingDimensions(fp, envW, envD);
  console.log(`fp_m2=${fp} → ${mw}m×${md}m offset[${ox.toFixed(1)},${oy.toFixed(1)}]`);
  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
  if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });
  const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
  const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
  // v70: front_edge en paramètre = override, sinon détection OSM
  const frontEdgeIndex = (front_edge !== undefined && front_edge !== null && front_edge !== "")
    ? (console.log(`│ FRONT-EDGE: override depuis body → arête ${front_edge}`), Number(front_edge))
    : await findNearestRoadEdge(coords, cLat, cLon);
  const envelopeCoords = computeEnvelope(coords, cLat, cLon, Number(setback_front), Number(setback_side), Number(setback_back), frontEdgeIndex);
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
  // v70.1: Massing TOUJOURS nord en haut (bearing=0) comme le slide 4
  const bearing = 0;
  const zoom = computeZoomMassing(coords, cLat, cLon); // v56.5: zoom plus serré pour le massing
  console.log(`Map view: bearing=${bearing}° zoom=${zoom}`);
  // v72.27: Passer split_context pour que le logement soit positionné DERRIÈRE le commerce
  const splitContext = splitLayout ? {
    commerce_depth_m: splitLayout.volume_commerce.depth_m || 6,
    retrait_inter_m: splitLayout.retrait_inter_m || 4,
    is_split: true,
  } : null;
  const massingCoords = computeMassingPolygon(envelopeCoords, fp, envelopeAreaReal, {
    massing_mode: compute_scenario ? (label === "A" ? "BALANCED" : label === "B" ? "SPREAD" : "COMPACT") : "BALANCED",
    primary_driver: primary_driver || "MAX_CAPACITE",
    levels,
    standing_level: standing_level || "STANDARD",
    program_main: effectiveProgramMain,
    site_saturation: site_saturation_level || "MEDIUM",
    project_type: project_type || "NEUF",
    existing_fp_m2: Number(existing_footprint_m2) || 0,
    road_bearing: Number(road_bearing) || null,        // v56.7: azimut rue depuis la Sheet
    scenario_role: label === "A" ? "INTENSIFICATION" : label === "B" ? "EQUILIBRE" : "PRUDENT",
    split_context: splitContext,                         // v72.27: positionner logement derrière commerce
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
    const rdcH = 3.0;   // v71: RDC toujours 3m (commerce et logement même hauteur)
    const etageH = 3.0;                              // étages courants = 3m
    // v72.28: SPLIT 3D — commerce construit depuis l'ENVELOPPE, logement = massingCoords
    let commerceCoords = null;
    if (splitLayout && commerceLevels > 0) {
      commerceCoords = buildCommercePolygon(envelopeCoords, splitLayout, Number(road_bearing) || null);
    }
    const useSplit3D = commerceCoords !== null;
    // v72.28: En SPLIT, la hauteur totale du logement = pilotis (3m) + levels × etageH
    const realTotalH = useSplit3D
      ? rdcH + levels * etageH    // pilotis (rdcH) + N niveaux habitables au-dessus
      : rdcH + (levels - 1) * etageH; // mode normal : RDC + (N-1) étages
    console.log(`┌── MASSING 3D RENDER v72.26 — ${useSplit3D ? "SPLIT_AV_AR" : "SUPERPOSÉ"} ──`);
    console.log(`│ Scénario ${label}: ${levels} niveaux (${commerceLevels} commerce RDC ORANGE + ${levels - commerceLevels} logement BLEU)`);
    console.log(`│ Hauteurs: RDC=${rdcH}m, étages=${etageH}m, total=${realTotalH}m`);
    console.log(`│ Emprise logement: ${Math.round(fp)}m² × ${levels} niveaux = ${Math.round(fp * levels)}m² SDP`);
    if (useSplit3D) {
      console.log(`│ SPLIT 3D ACTIF: commerce=${commerceCoords.length}pts (orange DEVANT) | logement=massingCoords (bleu DERRIÈRE)`);
      console.log(`│ Commerce: 1 niveau ORANGE | Logement: ${splitLayout.volume_logement.levels} niveaux BLEU`);
    } else {
      console.log(`│ Couleurs: f<${commerceLevels} → ORANGE (#e07830), f>=${commerceLevels} → BLEU (#3a7ac0)`);
    }
    console.log(`└── FIN DIAGNOSTIC 3D ──`);
    // v72.28: En SPLIT, pilotis déjà inclus dans realTotalH — pas de double ajout
    const hasPilotisRender = String(has_pilotis || "").toLowerCase() === "true" || has_pilotis === true;
    const pilotisH = (hasPilotisRender && !useSplit3D) ? 3.5 : 0; // SPLIT gère pilotis dans realTotalH
    const totalHWithPilotis = realTotalH + pilotisH;
    // v72.26: En mode SPLIT, massingCoords = logement (en retrait), commerceCoords = devant (depuis enveloppe)
    const html = generateMassingHTML({ lat: cLat, lon: cLon }, zoom, bearing, coords, envelopeCoords,
      massingCoords,
      { total_height: totalHWithPilotis, commerce_levels: commerceLevels, floor_height: etageH, rdc_height: rdcH, accent_color: accentColor, levels: levels, has_pilotis: hasPilotisRender, pilotis_height: pilotisH,
        split_layout: useSplit3D ? splitLayout : null,
        commerce_coords: useSplit3D ? commerceCoords : null }, MAPBOX_TOKEN);
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForFunction("window.__MAP_READY === true", { timeout: 25000 });
    // v72.22: Attendre un peu plus pour que les tuiles soient bien peintes
    await new Promise(r => setTimeout(r, 1500));
    // clip en CSS pixels (1280×1280) → Puppeteer produit PNG 2560×2560 grâce à deviceScaleFactor: 2
    let screenshotBuf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 1280 } });
    // v72.22: TONE CHECK — vérifier que le fond est bien beige (pas gris/blanc = Mapbox default light)
    // On sample un pixel de coin (hors bâtiment massing) — si trop froid (R≈G≈B > 230), c'est le style light par défaut
    const toneImg = await loadImage(screenshotBuf);
    const toneW = toneImg.width, toneH = toneImg.height;
    const toneCanvas = createCanvas(toneW, toneH);
    const toneCtx = toneCanvas.getContext("2d");
    toneCtx.drawImage(toneImg, 0, 0, toneW, toneH);
    // Sample 50 pixels en haut à gauche (zone de fond sans bâtiment)
    const cornerData = toneCtx.getImageData(50, 50, 10, 5).data;
    let coldPixels = 0, totalChecked = 0;
    for (let i = 0; i < cornerData.length; i += 4) {
      const r = cornerData[i], g = cornerData[i+1], b = cornerData[i+2];
      totalChecked++;
      // Si R≈G≈B et luminosité > 230 → fond blanc/gris froid (style light par défaut)
      if (r > 225 && g > 225 && b > 225 && Math.abs(r - g) < 8 && Math.abs(g - b) < 8) coldPixels++;
    }
    const coldRatio = coldPixels / Math.max(1, totalChecked);
    if (coldRatio > 0.5) {
      console.log(`[HEKTAR] ⚠️ TONE CHECK: fond trop froid (${Math.round(coldRatio*100)}% cold pixels) — retry screenshot après délai...`);
      await new Promise(r => setTimeout(r, 3000));
      screenshotBuf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 1280 } });
      console.log(`[HEKTAR] Retry screenshot: ${screenshotBuf.length} bytes`);
    }
    await page.close();
    console.log(`[HEKTAR] Screenshot: ${screenshotBuf.length} bytes (coldRatio=${Math.round(coldRatio*100)}%)`);
    // Canvas overlay à la résolution native du screenshot (2560×2560)
    const img = await loadImage(screenshotBuf);
    const W = img.width, H = img.height;  // sera 2560×2560
    console.log(`[HEKTAR] Canvas: ${W}×${H}`);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, W, H);
    // v65.2: Image SANS overlays pour le polish AI (éviter dédoublement)
    const pngClean = canvas.toBuffer("image/png");
    // Version avec overlays (fallback si pas d'AI polish)
    drawMassingOverlays(ctx, W, H, {
      site_area: Number(site_area), bearing, label,
      levels, commerce_levels: commerceLevels, habitation_levels: habitationLevels,
      total_height: realTotalH, floor_height: etageH, fp_m2: Math.round(fp), accent_color: accentColor, scenario_role: scenarioRole,
      typology: massingCoords._typology, split_layout: splitLayout,
    });
    const png = canvas.toBuffer("image/png");
    await sb.storage.from("massing-images").upload(basePath, png, { contentType: "image/png", upsert: true });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
    const cacheBust = `?v=${Date.now()}`;
    let enhancedUrl = pd.publicUrl + cacheBust;
    // ═══════════════════════════════════════════════════════════════════════════
    // v72.34: ROBUST MULTI-RENDER MASSING POLISH — model fallback, retry, timeout
    // ═══════════════════════════════════════════════════════════════════════════
    const MASSING_VARIATIONS = 2;
    let polishApplied = false;
    if (OPENAI_API_KEY) {
      try {
        console.log(`[MASSING-POLISH] v72.34: Starting robust multi-render (${MASSING_VARIATIONS} variations) for ${label}... model=${POLISH_MODEL}`);
        // v72.34: Resize image for API — reduces payload, improves reliability
        const resized = await resizeForPolish(pngClean, POLISH_MAX_IMAGE_DIM);
        const b64Input = resized.buf.toString("base64");
        console.log(`[MASSING-POLISH] ${label} input: ${(resized.buf.length / 1024).toFixed(0)}KB (${resized.w}×${resized.h})`);
        // v72.4: Stronger color preservation for floor coding
        let massingPolishPrompt = `STRICT EDIT ONLY.

PRESERVE EXACT GEOMETRY. PRESERVE EXACT CAMERA. PRESERVE EXACT COMPOSITION.
Do NOT modify, move, add, or remove ANY element.
Do NOT change building shapes, positions, sizes, count.
Do NOT reinterpret, redesign, or restyle the scene.
NO STRUCTURAL MODIFICATION. NO CAMERA CHANGE. NO REINTERPRETATION.

ANTI-HALLUCINATION RULES (CRITICAL):
- Do NOT add ANY floor, slab, or platform below the building. The building sits DIRECTLY on the ground.
- Do NOT add ANY object not in the source: no trees, no vehicles, no people, no furniture, no signs.
- Do NOT add underground/basement levels or visible foundation slabs.
- Do NOT widen, extend, or reshape any floor band.
- The building has EXACTLY the floor bands shown — do NOT add or merge any.

CRITICAL COLOR PRESERVATION:
- The building has colored floor bands: ORANGE floors (commerce) and BLUE floors (habitation).
- These colors MUST remain vivid and clearly distinguishable after polish.
- Do NOT wash out, desaturate, or unify the floor colors.
- Do NOT turn orange or blue floors into beige, gray, or white.
- The color difference between floor types is essential information — preserve it exactly.
- ALL surrounding context buildings must remain NEUTRAL white/cream (#f0ede8). Do NOT tint them.

Apply ONLY these subtle non-structural adjustments:
- Very slight tonal harmonization (uniform warm balance) — but KEEP floor colors intact
- Minimal contrast improvement for visual clarity
- Subtle soft shadows under the building volume
- Gentle ambient occlusion at ground contact
- Clean, professional finish
- KEEP IMAGE SHARP — do not soften or blur any edges

Do NOT change the maquette/model aesthetic — keep the clean architectural model look.
This is a WARM BEIGE architectural maquette with colored floor bands. The background is warm beige (#eae8e4), buildings are cream (#f0ede8), roads are gray (#808080). PRESERVE THESE EXACT TONES. Do NOT shift to white, gray, or cool tones. The warm beige palette is essential.

CONSISTENCY IS CRITICAL: This image is one of a set (A, B, C). All must look identical in WARM BEIGE tone and style. Do NOT make the scene cooler or whiter.`;

        // v72.35: Extra warm-tone enforcement for small volumes (C scenario)
        // Small buildings = more background pixels = AI tends to shift cool/gray
        const totalBuildingLevels = (habitationLevels || 0) + (commerceLevels || 0);
        if (totalBuildingLevels <= 2 || label === "C") {
          const warmEnforcement = `

CRITICAL WARM TONE ENFORCEMENT:
This is a SMALL building variant. The image is dominated by surrounding context (roads, other buildings, ground).
You MUST maintain the EXACT SAME warm beige tone (#eae8e4) across the ENTIRE image.
Do NOT let the large background area become gray, white, cool, or desaturated.
The surrounding buildings must stay warm cream (#f0ede8), NOT gray or white.
The ground must stay warm beige, NOT cool gray.
Roads must stay warm gray (#808080 with slight warmth), NOT cool blue-gray.
Compare mentally with a warm sunset-lit architectural model — THAT is the target tone.
ABSOLUTELY NO COOL SHIFT. ABSOLUTELY NO GRAY SHIFT. KEEP EVERYTHING WARM BEIGE.`;
          // Append to prompt
          massingPolishPrompt += warmEnforcement;
          console.log(`[MASSING-POLISH] ${label} v72.35: Warm-tone enforcement ACTIVE (levels=${totalBuildingLevels})`);
        }

        // v72.34: Launch all variations with robust retry engine
        const polishResults = await Promise.all(
          Array.from({ length: MASSING_VARIATIONS }, (_, v) =>
            callPolishAPI(b64Input, massingPolishPrompt, label, v + 1)
          )
        );
        let bestVariation = null;
        let bestDriftScore = 1.0;
        const variationLog = [];
        for (let v = 0; v < polishResults.length; v++) {
          const result = polishResults[v];
          if (result.error) {
            variationLog.push(`  v${v+1}: ${result.error} — ${(result.details || "").substring(0, 150)}`);
            continue;
          }
          const enhancedBuf = Buffer.from(result.b64, "base64");
          // v72.54: Massing drift threshold raised to 0.35 (was 0.25 default — too strict, caused ALL variations rejected)
          const drift = await detectDriftFromBuffers(pngClean, enhancedBuf, W, H, 0.35);
          // v72.22: COLOR PRESERVATION CHECK — verify orange and blue floor bands survived
          let colorCheckPassed = true;
          let colorLog = "";
          if (commerceLevels > 0) {
            const polishedImg = await loadImage(enhancedBuf);
            const checkCanvas = createCanvas(W, H);
            const checkCtx = checkCanvas.getContext("2d");
            const origImg = await loadImage(pngClean);
            checkCtx.drawImage(origImg, 0, 0, W, H);
            const origData = checkCtx.getImageData(0, 0, W, H).data;
            let origOrange = 0, origBlue = 0;
            for (let px = 0; px < origData.length; px += 4) {
              const r = origData[px], g = origData[px+1], b = origData[px+2];
              if (r > 180 && g > 80 && g < 150 && b < 80) origOrange++;
              if (b > 140 && r < 100 && g < 150) origBlue++;
            }
            checkCtx.drawImage(polishedImg, 0, 0, W, H);
            const polData = checkCtx.getImageData(0, 0, W, H).data;
            let polOrange = 0, polBlue = 0;
            for (let px = 0; px < polData.length; px += 4) {
              const r = polData[px], g = polData[px+1], b = polData[px+2];
              if (r > 180 && g > 80 && g < 150 && b < 80) polOrange++;
              if (b > 140 && r < 100 && g < 150) polBlue++;
            }
            const orangeRetained = origOrange > 0 ? polOrange / origOrange : 1;
            const blueRetained = origBlue > 0 ? polBlue / origBlue : 1;
            colorLog = ` orange=${Math.round(orangeRetained*100)}% blue=${Math.round(blueRetained*100)}%`;
            if (orangeRetained < 0.35 || blueRetained < 0.35) {
              colorCheckPassed = false;
              colorLog += " COLORS_WASHED";
            }
          }
          variationLog.push(`  v${v+1}: drift=${(drift.driftScore * 100).toFixed(2)}% ${drift.passed ? "✓" : "✗"}${colorLog} (shifted=${drift.classShifts}/${drift.totalBlocks})`);
          if (drift.passed && colorCheckPassed && drift.driftScore < bestDriftScore) {
            bestDriftScore = drift.driftScore;
            bestVariation = { buf: enhancedBuf, drift, index: v + 1 };
          }
        }
        console.log(`[MASSING-POLISH] ${label} multi-render (${Date.now() - t0}ms):\n${variationLog.join("\n")}`);
        if (bestVariation) {
          console.log(`[MASSING-POLISH] ${label} ✓ Best: v${bestVariation.index} (drift=${(bestVariation.drift.driftScore * 100).toFixed(2)}%)`);
          const finalCanvas = createCanvas(W, H);
          const finalCtx = finalCanvas.getContext("2d");
          finalCtx.drawImage(await loadImage(bestVariation.buf), 0, 0, W, H);
          // v72.4: Post-polish sharpening (lighter for massing — already at 2x resolution)
          applySharpen(finalCtx, W, H, 0.25);
          console.log(`[MASSING-POLISH] ${label} v72.4: Sharpening applied (amount=0.25)`);
          drawMassingOverlays(finalCtx, W, H, {
            site_area: Number(site_area), bearing, label,
            levels, commerce_levels: commerceLevels, habitation_levels: habitationLevels,
            total_height: realTotalH, floor_height: etageH, fp_m2: Math.round(fp), accent_color: accentColor, scenario_role: scenarioRole,
            typology: massingCoords._typology, split_layout: splitLayout,
          });
          const finalPng = finalCtx.canvas.toBuffer("image/png");
          const enhancedPath = `${folder}/${slideName}_enhanced.png`;
          const { error: ue2 } = await sb.storage.from("massing-images").upload(enhancedPath, finalPng, { contentType: "image/png", upsert: true, cacheControl: "0" });
          if (!ue2) {
            const { data: pd2 } = sb.storage.from("massing-images").getPublicUrl(enhancedPath);
            enhancedUrl = pd2.publicUrl + `?v=${Date.now()}`;
            polishApplied = true;
            console.log(`✓ [MASSING-POLISH] ${label} enhanced uploaded (${Date.now() - t0}ms)`);
          }
        } else {
          console.warn(`⚠ [MASSING-DRIFT] ${label}: ALL ${MASSING_VARIATIONS} variations rejected — deterministic fallback`);
        }
      } catch (polishErr) {
        console.error(`[MASSING-POLISH] ${label} EXCEPTION:`, polishErr.message, polishErr.stack);
      }
    } else {
      console.warn(`[MASSING-POLISH] OPENAI_API_KEY not set — skipping polish`);
    }
    console.log(`[MASSING] v72.34: ${label} complete — polish=${polishApplied ? "APPLIED" : "DETERMINISTIC_FALLBACK"} (${Date.now() - t0}ms)`);
    return res.json({
      ok: true, cached: false, server_version: "72.65-SUPERVISOR",
      public_url: pd.publicUrl + cacheBust, enhanced_url: enhancedUrl,
      polish_applied: polishApplied,
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
// ══════════════════════════════════════════════════════════════════════════════
// v72.68: ENDPOINT /generate-pptx — GÉNÉRATION POWERPOINT CÔTÉ SERVEUR
// Reçoit le même body que /compute-scenarios (données client)
// + optionnel: images URLs (massing, terrain) et textes pré-générés
// Le serveur:
//   1) Appelle /generate-texts en interne pour obtenir scénarios + textes
//   2) Construit le JSON pour le script Python
//   3) Appelle generate_pptx.py via child_process
//   4) Retourne le fichier PPTX en base64
// ══════════════════════════════════════════════════════════════════════════════

// Template PPTX path — stocké à côté du server.js
const PPTX_TEMPLATE_PATH = process.env.PPTX_TEMPLATE_PATH || path.join(__dirname, "template_diagnostic.pptx");
const PYTHON_SCRIPTS_DIR = process.env.PYTHON_SCRIPTS_DIR || __dirname;

app.post("/generate-pptx", async (req, res) => {
  const t0 = Date.now();
  let tmpDir = null;

  try {
    console.log("[v72.68] /generate-pptx — START");

    // ─── 1) RÉCUPÉRER LES TEXTES + SCÉNARIOS ───
    // Si le body contient déjà 'texts' et 'scenarios', on les utilise directement
    // Sinon on appelle /generate-texts en interne
    let texts, scenarios, clientName, images;

    if (req.body.texts && req.body.scenarios) {
      // Mode direct: le caller fournit tout
      console.log("[v72.68] Mode direct — textes et scénarios fournis dans le body");
      texts = req.body.texts;
      scenarios = req.body.scenarios;
      clientName = req.body.client_name || "";
      images = req.body.images || {};
    } else {
      // Mode pipeline: on appelle /generate-texts puis on extrait
      console.log("[v72.68] Mode pipeline — appel interne /generate-texts");
      const localUrl = `http://localhost:${PORT}/generate-texts`;
      const intResponse = await fetch(localUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });

      if (!intResponse.ok) {
        const errText = await intResponse.text();
        console.error(`[v72.68] /generate-texts a échoué (${intResponse.status}):`, errText);
        return res.status(500).json({ ok: false, error: "generate-texts failed", detail: errText });
      }

      const textsResponse = await intResponse.json();

      if (!textsResponse || !textsResponse.ok) {
        console.error("[v72.68] /generate-texts réponse invalide");
        return res.status(500).json({ ok: false, error: "generate-texts returned invalid data" });
      }

      // Extraire les textes du résultat de /generate-texts
      // /generate-texts renvoie les textes sous "generated_texts" ET en flat au top-level
      texts = textsResponse.generated_texts || {};
      // Si generated_texts est vide, récupérer les textes flat du top-level
      if (Object.keys(texts).length === 0) {
        const skipKeys = new Set(["ok", "server_version", "gpt_model", "gpt_elapsed_ms", "gpt_tokens", "A", "B", "C", "computed_budget_band", "computed_scores"]);
        for (const [k, v] of Object.entries(textsResponse)) {
          if (!skipKeys.has(k) && typeof v === "string") {
            texts[k] = v;
          }
        }
      }
      console.log(`[v72.68] Texts extracted: ${Object.keys(texts).length} keys — ${Object.keys(texts).join(", ")}`);
      clientName = req.body.client_name || req.body.nom_client || "";
      images = req.body.images || {};

      // Récupérer les scénarios depuis /compute-scenarios directement
      console.log("[v72.68] Appel interne /compute-scenarios pour données scénarios");
      const scenResponse = await fetch(`http://localhost:${PORT}/compute-scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });

      if (!scenResponse.ok) {
        return res.status(500).json({ ok: false, error: "compute-scenarios failed for pptx" });
      }

      const scenData = await scenResponse.json();

      // Construire l'objet scenarios pour les graphiques
      scenarios = {};
      for (const label of ["A", "B", "C"]) {
        const sc = scenData[label];
        if (!sc) continue;
        scenarios[label] = {
          sdp_m2: sc.sdp_m2 || 0,
          surface_habitable_m2: sc.surface_habitable_m2 || sc.total_useful_m2 || 0,
          ratio_efficacite_pct: sc.ratio_efficacite_pct || 0,
          total_units: sc.total_units || 0,
          levels: sc.levels || 0,
          cost_total_fcfa: sc.cost_total_fcfa || sc.estimated_cost || 0,
          cost_per_m2_sdp: sc.cost_per_m2_sdp || 0,
          budget_fit: sc.budget_fit || 0,
          recommendation_score: sc.recommendation_score || 0,
          duree_chantier_mois: sc.duree_chantier_mois || 0,
          risk_scores: _computeRiskScores(sc, scenData),
        };
      }
    }

    // ─── 2) CONSTRUIRE LE JSON POUR PYTHON ───
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barlo-pptx-"));
    const inputJsonPath = path.join(tmpDir, "input.json");
    const outputPptxPath = path.join(tmpDir, "diagnostic_output.pptx");

    const pptxData = {
      client_name: clientName,
      images: images,
      texts: texts,
      scenarios: scenarios,
      recommended_scenario: _findRecommendedScenario(scenarios),
    };

    fs.writeFileSync(inputJsonPath, JSON.stringify(pptxData, null, 2), "utf-8");
    console.log(`[v72.68] JSON écrit: ${inputJsonPath} (${(JSON.stringify(pptxData).length / 1024).toFixed(1)} KB)`);

    // ─── 3) VÉRIFIER QUE LE TEMPLATE EXISTE ───
    if (!fs.existsSync(PPTX_TEMPLATE_PATH)) {
      console.error(`[v72.68] Template PPTX introuvable: ${PPTX_TEMPLATE_PATH}`);
      return res.status(500).json({ ok: false, error: `Template PPTX not found: ${PPTX_TEMPLATE_PATH}` });
    }

    // ─── 4) APPELER LE SCRIPT PYTHON ───
    const pythonScript = path.join(PYTHON_SCRIPTS_DIR, "generate_pptx.py");
    console.log(`[v72.68] Lancement Python: ${pythonScript}`);

    const pptxBuffer = await new Promise((resolve, reject) => {
      const proc = execFile("python3", [
        pythonScript,
        inputJsonPath,
        PPTX_TEMPLATE_PATH,
        outputPptxPath,
      ], {
        cwd: PYTHON_SCRIPTS_DIR,
        timeout: 120000,  // 2 minutes max
        maxBuffer: 10 * 1024 * 1024,  // 10MB stdout buffer
      }, (error, stdout, stderr) => {
        if (stderr) console.log(`[v72.68] Python stderr:\n${stderr}`);
        if (stdout) console.log(`[v72.68] Python stdout:\n${stdout}`);

        if (error) {
          console.error(`[v72.68] Python error:`, error.message);
          return reject(new Error(`Python script failed: ${error.message}`));
        }

        // Lire le fichier PPTX généré
        if (!fs.existsSync(outputPptxPath)) {
          return reject(new Error("Python script did not produce output file"));
        }

        const buffer = fs.readFileSync(outputPptxPath);
        resolve(buffer);
      });
    });

    const durationMs = Date.now() - t0;
    console.log(`[v72.68] PPTX généré en ${durationMs}ms (${(pptxBuffer.length / 1024).toFixed(0)} KB)`);

    // ─── 5) RETOURNER LE RÉSULTAT ───
    // Par défaut: retourner le fichier PPTX directement
    // Si ?format=base64, retourner en JSON avec base64
    if (req.query.format === "base64") {
      return res.json({
        ok: true,
        filename: `diagnostic_${clientName.replace(/\s+/g, "_") || "client"}.pptx`,
        pptx_base64: pptxBuffer.toString("base64"),
        size_bytes: pptxBuffer.length,
        duration_ms: durationMs,
      });
    }

    // Retour binaire (pour téléchargement direct ou upload Google Drive)
    const filename = `diagnostic_${clientName.replace(/\s+/g, "_") || "client"}.pptx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pptxBuffer.length);
    res.setHeader("X-BARLO-Duration-Ms", String(durationMs));
    return res.send(pptxBuffer);

  } catch (e) {
    console.error("[v72.68] /generate-pptx ERROR:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    // Cleanup temp files
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
});

// ─── HELPERS pour /generate-pptx ─────────────────────────────────────────────

/**
 * Calcule les risk_scores (1-5) pour un scénario, utilisés par les graphiques radar/barres.
 * Dérivés directement des données numériques du scénario.
 */
function _computeRiskScores(sc, allData) {
  const budgetFit = sc.budget_fit || 0;
  const effRatio = sc.ratio_efficacite_pct || 0;
  const levels = sc.levels || 1;
  const cosMax = (allData.terrain || {}).cos_max || 1;
  const sdp = sc.sdp_m2 || 0;
  const terrainArea = (allData.terrain || {}).area_m2 || 200;
  const cosUsed = sdp / terrainArea;
  const cosDensity = cosMax > 0 ? cosUsed / cosMax : 0;

  return {
    budget_fit: budgetFit >= 0.95 ? 5 : budgetFit >= 0.8 ? 4 : budgetFit >= 0.6 ? 3 : budgetFit >= 0.4 ? 2 : 1,
    complexite_structurelle: levels <= 2 ? 1 : levels <= 3 ? 2 : levels <= 4 ? 3 : levels <= 5 ? 4 : 5,
    risque_permis: cosDensity <= 0.5 ? 1 : cosDensity <= 0.7 ? 2 : cosDensity <= 0.85 ? 3 : cosDensity <= 0.95 ? 4 : 5,
    ratio_efficacite: effRatio >= 80 ? 4 : effRatio >= 70 ? 3 : effRatio >= 60 ? 2 : 1,
    densite_cos: cosDensity <= 0.5 ? 1 : cosDensity <= 0.65 ? 2 : cosDensity <= 0.8 ? 3 : cosDensity <= 0.9 ? 4 : 5,
    phasabilite: levels <= 2 ? 5 : levels <= 3 ? 3 : levels <= 4 ? 2 : 1,
    cout_m2: (sc.cost_per_m2_sdp || 0) <= 400000 ? 1 : (sc.cost_per_m2_sdp || 0) <= 500000 ? 2 : (sc.cost_per_m2_sdp || 0) <= 600000 ? 3 : 4,
  };
}

/**
 * Trouve le scénario recommandé (celui avec le plus haut recommendation_score).
 */
function _findRecommendedScenario(scenarios) {
  let best = "C";
  let bestScore = -1;
  for (const [label, sc] of Object.entries(scenarios || {})) {
    const score = sc.recommendation_score || 0;
    if (score > bestScore) {
      bestScore = score;
      best = label;
    }
  }
  return best;
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`BARLO v72.68-PPTX on port ${PORT}`);
  console.log(`Browserless: ${BROWSERLESS_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Mapbox:      ${MAPBOX_TOKEN ? "OK" : "MISSING"}`);
  console.log(`OpenAI:      ${OPENAI_API_KEY ? "OK" : "MISSING"} (polish model: ${POLISH_MODEL})`);
});
