const express = require("express");
const puppeteer = require("puppeteer-core");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas, loadImage } = require("canvas");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

app.get("/health", (req, res) => res.json({ ok: true, engine: "browserless-mapbox-gl-3d", version: "10.0" }));

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
  const targetViewM = ext * 3.0;
  const mpp = targetViewM / 1280;
  const z = Math.log2(156543.03 * Math.cos(cLat * Math.PI / 180) / mpp);
  return Math.min(17, Math.max(15.5, Math.round(z * 4) / 4));
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

// ─── HTML MAPBOX GL ────────────────────────────────────────────────────────────
function generateMapHTML(center, zoom, bearing, parcelCoords, envelopeCoords, mapboxToken) {
  const parcelGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...parcelCoords.map(c => [c.lon, c.lat]), [parcelCoords[0].lon, parcelCoords[0].lat]]] },
  };
  const envelopeGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...envelopeCoords.map(c => [c.lon, c.lat]), [envelopeCoords[0].lon, envelopeCoords[0].lat]]] },
  };

  // Seed déterministe basé sur les coordonnées pour variation hauteur reproductible
  const seed = Math.round(Math.abs(center.lat * 137.508 + center.lon * 251.663) * 1000) % 99999;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1280px; height: 1280px; overflow: hidden; background: #f2f0ec; }
  #map { width: 1280px; height: 1280px; }
  /* Masquer tous les contrôles et labels Mapbox */
  .mapboxgl-ctrl-logo,
  .mapboxgl-ctrl-attrib,
  .mapboxgl-ctrl-group { display: none !important; }
</style>
<script src="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.js"></script>
<link href="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.css" rel="stylesheet">
</head>
<body>
<div id="map"></div>
<script>
(function() {
  // Générateur pseudo-aléatoire déterministe
  function seededRand(seed) {
    let s = seed;
    return function() {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff;
    };
  }
  const rand = seededRand(${seed});

  mapboxgl.accessToken = '${mapboxToken}';

  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11',
    center: [${center.lon}, ${center.lat}],
    zoom: ${zoom},
    bearing: ${bearing},
    pitch: 58,
    antialias: true,
    preserveDrawingBuffer: true,
    fadeDuration: 0,
    interactive: false,
  });

  // Supprimer les contrôles UI
  map.addControl = function() {};

  map.on('style.load', () => {

    // ── Lumière directionnelle pour ombres et profondeur ──────────────
    map.setLight({
      anchor: 'map',
      color: '#fff8f0',
      intensity: 0.55,
      position: [1.15, 195, 40],
    });

    // ── Masquer labels de rues (trop chargé) ─────────────────────────
    const style = map.getStyle();
    for (const layer of style.layers) {
      if (layer.type === 'symbol') {
        // Garder uniquement les noms de rues principales
        const isRoadLabel = layer['source-layer'] === 'road' ||
          (layer.id && (layer.id.includes('road-label') || layer.id.includes('street-label')));
        if (!isRoadLabel) {
          map.setLayoutProperty(layer.id, 'visibility', 'none');
        }
      }
    }

    // ── Trouver label layer pour insertion ────────────────────────────
    let labelLayerId;
    for (const layer of style.layers) {
      if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
        labelLayerId = layer.id;
        break;
      }
    }

    // ── Bâtiments 3D avec variation de hauteur ────────────────────────
    // On utilise fill-extrusion avec une expression qui ajoute de la variabilité
    // aux hauteurs en fonction d'un hash sur les coordonnées du bâtiment
    map.addLayer({
      id: '3d-buildings',
      source: 'composite',
      'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion',
      minzoom: 13,
      paint: {
        // Couleur basée sur la hauteur pour effet de profondeur réaliste
        'fill-extrusion-color': [
          'interpolate', ['linear'],
          ['coalesce', ['get', 'height'], 6],
          0,  '#ece8e0',
          5,  '#e8e4dc',
          10, '#e2ded6',
          20, '#d8d4cc',
          35, '#ccc8c0',
          60, '#c0bcb4',
        ],
        // Hauteur avec multiplicateur + variabilité via expression
        // On amplifie légèrement les hauteurs pour meilleure lisibilité 3D
        'fill-extrusion-height': [
          'case',
          ['has', 'height'],
          ['*', ['get', 'height'], 1.6],
          // Bâtiments sans hauteur connue : estimation par surface approximative
          8
        ],
        'fill-extrusion-base': [
          'case',
          ['has', 'min_height'],
          ['*', ['get', 'min_height'], 1.6],
          0
        ],
        'fill-extrusion-opacity': 0.95,
        'fill-extrusion-vertical-gradient': true,
      },
    }, labelLayerId);

    // ── Parcelle — fill-extrusion légère pour visibilité 3D ──────────
    map.addSource('parcel', { type: 'geojson', data: ${JSON.stringify(parcelGeoJSON)} });
    map.addLayer({
      id: 'parcel-fill-3d',
      type: 'fill-extrusion',
      source: 'parcel',
      paint: {
        'fill-extrusion-color': '#d02818',
        'fill-extrusion-height': 0.5,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.25,
      },
    });
    map.addLayer({
      id: 'parcel-outline',
      type: 'line',
      source: 'parcel',
      paint: {
        'line-color': '#d02818',
        'line-width': 3,
        'line-opacity': 1,
      },
    });

    // ── Enveloppe constructible ───────────────────────────────────────
    map.addSource('envelope', { type: 'geojson', data: ${JSON.stringify(envelopeGeoJSON)} });
    map.addLayer({
      id: 'envelope-outline',
      type: 'line',
      source: 'envelope',
      paint: {
        'line-color': '#d02818',
        'line-width': 2.5,
        'line-dasharray': [5, 3],
        'line-opacity': 0.85,
      },
    });

    // ── Volume constructible (extrusion translucide) ──────────────────
    map.addLayer({
      id: 'envelope-volume',
      type: 'fill-extrusion',
      source: 'envelope',
      paint: {
        'fill-extrusion-color': '#1d7a3e',
        'fill-extrusion-height': 12,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.12,
      },
    });
  });

  let rendered = false;
  map.on('idle', () => {
    if (rendered) return;
    rendered = true;
    setTimeout(() => { window.__MAP_READY = true; }, 2500);
  });
  setTimeout(() => { window.__MAP_READY = true; }, 28000);
})();
</script>
</body>
</html>`;
}

// ─── OVERLAYS CANVAS ──────────────────────────────────────────────────────────
function drawOverlays(ctx, W, H, BH, p) {
  const { site_area, land_width, land_depth, buildable_fp,
    setback_front, setback_side, setback_back,
    city, district, zoning, terrain_context, bearing } = p;

  // ── Boussole ─────────────────────────────────────────────────────────────
  ctx.save();
  ctx.translate(W - 58, 58);
  // Ombre douce
  ctx.shadowColor = "rgba(0,0,0,0.15)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.96)"; ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1; ctx.stroke();
  // Flèche orientée selon bearing
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -3); ctx.lineTo(0, -8); ctx.lineTo(5, -3); ctx.closePath();
  ctx.fillStyle = "#d02818"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 3); ctx.lineTo(0, 8); ctx.lineTo(5, 3); ctx.closePath();
  ctx.fillStyle = "#ccc"; ctx.fill();
  ctx.rotate((bearing || 0) * Math.PI / 180);
  ctx.font = "bold 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#d02818";
  ctx.fillText("N", 0, -22);
  ctx.restore();

  // ── Légende ───────────────────────────────────────────────────────────────
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
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#e4e0d8"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();

  legItems.forEach((item, i) => {
    const iy = 16 + legPad + i * legLH;
    ctx.save();
    if (item.type === "rect") {
      ctx.fillStyle = item.fill;
      ctx.beginPath(); ctx.roundRect(28, iy, 16, 13, 2); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(28, iy + 6); ctx.lineTo(44, iy + 6);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
    ctx.font = "12px Arial, Helvetica, sans-serif";
    ctx.fillStyle = "#444"; ctx.textAlign = "left";
    ctx.fillText(item.label, 52, iy + 11);
  });
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© Mapbox  © OpenStreetMap contributors", 28, 16 + legH - 6);

  // ── Bande stats ───────────────────────────────────────────────────────────
  const BY = H;

  // Fond blanc avec ombre subtile en haut
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, BY, W, BH);

  // Ligne rouge top
  ctx.beginPath(); ctx.moveTo(0, BY); ctx.lineTo(W, BY);
  ctx.strokeStyle = "#d02818"; ctx.lineWidth = 4; ctx.stroke();

  const pad = 32;
  const C1 = pad, C2 = W * 0.26, C3 = W * 0.52, C4 = W * 0.76;

  ctx.textAlign = "left";

  // Titre
  ctx.font = "bold 20px Arial"; ctx.fillStyle = "#111";
  ctx.fillText("Lecture stratégique du site", C1, BY + 42);
  ctx.font = "11px Arial"; ctx.fillStyle = "#aaa";
  ctx.fillText(`${city}  ·  ${district}  ·  Zoning : ${zoning}`, C1, BY + 62);

  // Séparateur
  ctx.beginPath(); ctx.moveTo(C1, BY + 76); ctx.lineTo(W - pad, BY + 76);
  ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1.5; ctx.stroke();

  // Stats
  const stats = [
    { label: "Surface parcelle", val: `${site_area} m²`, col: C1, color: "#111" },
    { label: "Dimensions", val: `${land_width}m × ${land_depth}m`, col: C2, color: "#111" },
    { label: "Empreinte constructible", val: `${buildable_fp} m²`, col: C3, color: "#1d7a3e" },
  ];
  stats.forEach(s => {
    ctx.font = "10px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText(s.label, s.col, BY + 96);
    ctx.font = `bold 26px Arial`; ctx.fillStyle = s.color; ctx.fillText(s.val, s.col, BY + 128);
  });

  // Retraits
  ctx.font = "10px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Retraits réglementaires", C4, BY + 96);
  ctx.font = "600 13px Arial"; ctx.fillStyle = "#555";
  ctx.fillText(`Avant : ${setback_front}m  ·  Côtés : ${setback_side}m`, C4, BY + 114);
  ctx.fillText(`Arrière : ${setback_back}m`, C4, BY + 132);

  // Séparateur bas
  ctx.beginPath(); ctx.moveTo(C1, BY + 148); ctx.lineTo(W - pad, BY + 148);
  ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1.5; ctx.stroke();

  // Terrain context + signature
  ctx.font = "11px Arial"; ctx.fillStyle = "#ccc";
  ctx.fillText((terrain_context || "").substring(0, 100), C1, BY + BH - 16);
  ctx.textAlign = "right"; ctx.font = "9px Arial"; ctx.fillStyle = "#ddd";
  ctx.fillText("BARLO · Diagnostic foncier automatisé", W - pad, BY + BH - 16);
}

// ─── ENDPOINT ─────────────────────────────────────────────────────────────────
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("═══ /generate v10 (Browserless + Mapbox GL 3D) ═══");

  const {
    lead_id, client_name, polygon_points, site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp, setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    slide_name = "slide_4_axo",
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

  const envelopeCoords = computeEnvelope(coords, cLat, cLon,
    Number(setback_front), Number(setback_side), Number(setback_back));

  const zoom = computeZoom(coords, cLat, cLon);
  const bearing = computeBearing(coords, cLat, cLon);
  console.log(`zoom=${zoom} bearing=${bearing}° pitch=58°`);

  let browser;
  try {
    console.log("Connecting to Browserless...");
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`,
    });
    console.log(`Connected (${Date.now() - t0}ms)`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1280, deviceScaleFactor: 1 });

    const html = generateMapHTML({ lat: cLat, lon: cLon }, zoom, bearing, coords, envelopeCoords, MAPBOX_TOKEN);
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    console.log(`Page loaded (${Date.now() - t0}ms)`);

    await page.waitForFunction("window.__MAP_READY === true", { timeout: 28000 });
    console.log(`Map ready (${Date.now() - t0}ms)`);

    const screenshotBuf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 1280 } });
    console.log(`Screenshot: ${screenshotBuf.length} bytes (${Date.now() - t0}ms)`);
    await page.close();

    // Compositing
    const W = 1280, H = 1280, BH = 200;
    const canvas = createCanvas(W, H + BH);
    const ctx = canvas.getContext("2d");
    const mapImg = await loadImage(screenshotBuf);
    ctx.drawImage(mapImg, 0, 0);

    drawOverlays(ctx, W, H, BH, {
      site_area: Number(site_area), land_width: Number(land_width),
      land_depth: Number(land_depth), buildable_fp: Number(buildable_fp),
      setback_front: Number(setback_front), setback_side: Number(setback_side),
      setback_back: Number(setback_back),
      city: city || "", district: district || "", zoning: zoning || "",
      terrain_context: terrain_context || "", bearing,
    });

    const png = canvas.toBuffer("image/png");
    console.log(`PNG: ${png.length} bytes (${Date.now() - t0}ms)`);

    // Upload Supabase
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const slug = String(client_name || "client").toLowerCase().trim()
      .replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const path = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;
    const { error: ue } = await sb.storage.from("massing-images").upload(path, png, { contentType: "image/png", upsert: true });
    if (ue) return res.status(500).json({ error: ue.message });

    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(path);
    console.log(`✓ Done: ${pd.publicUrl} (${Date.now() - t0}ms)`);

    return res.json({ ok: true, public_url: pd.publicUrl, path,
      centroid: { lat: cLat, lon: cLon },
      view: { zoom, bearing, pitch: 58 },
      duration_ms: Date.now() - t0 });

  } catch (e) {
    console.error("Error:", e.message || e);
    return res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (browser) { try { browser.disconnect(); } catch (_) {} }
  }
});

app.listen(PORT, () => {
  console.log(`BARLO v10 on port ${PORT}`);
  console.log(`Browserless: ${BROWSERLESS_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Mapbox: ${MAPBOX_TOKEN ? "OK" : "MISSING"}`);
});
