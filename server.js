// ═══════════════════════════════════════════════════════════════════════════════
// BARLO — slide_4_axo v9 — BROWSERLESS + MAPBOX GL 3D
// ═══════════════════════════════════════════════════════════════════════════════
// Vrai rendu Mapbox GL JS avec bâtiments 3D (fill-extrusion) via Browserless.io
// Puppeteer se connecte à un Chrome cloud (Browserless) qui a le vrai WebGL
// → screenshot de la carte 3D → compositing overlays BARLO → upload Supabase
// ═══════════════════════════════════════════════════════════════════════════════

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

app.get("/health", (req, res) => res.json({
  ok: true,
  engine: "browserless-mapbox-gl-3d",
  version: "9.0",
  browserless: BROWSERLESS_TOKEN ? "configured" : "MISSING",
  mapbox: MAPBOX_TOKEN ? "configured" : "MISSING",
}));

// ─── GEO HELPERS ──────────────────────────────────────────────────────────────
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

// ─── ENVELOPPE CONSTRUCTIBLE ──────────────────────────────────────────────────
function computeEnvelope(coords, cLat, cLon, front, side, back) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const n = pts.length;
  let maxLat = -Infinity, rb = 0;
  for (let i = 0; i < n - 1; i++) {
    const ml = (coords[i].lat + coords[(i + 1) % n].lat) / 2;
    if (ml > maxLat) { maxLat = ml; rb = brng(coords[i], coords[(i + 1) % n]); }
  }
  function setSB(b) {
    let d = ((b - rb) + 360) % 360;
    if (d > 180) d = 360 - d;
    return d < 45 ? front : d < 135 ? side : back;
  }
  function offSeg(p1, p2, dist) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.sqrt(dx * dx + dy * dy) + 0.001;
    return {
      p1: { x: p1.x - dy / len * dist, y: p1.y + dx / len * dist },
      p2: { x: p2.x - dy / len * dist, y: p2.y + dx / len * dist },
    };
  }
  function intersect(s1, s2) {
    const d1x = s1.p2.x - s1.p1.x, d1y = s1.p2.y - s1.p1.y;
    const d2x = s2.p2.x - s2.p1.x, d2y = s2.p2.y - s2.p1.y;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-10) return { x: (s1.p2.x + s2.p1.x) / 2, y: (s1.p2.y + s2.p1.y) / 2 };
    const t = ((s2.p1.x - s1.p1.x) * d2y - (s2.p1.y - s1.p1.y) * d2x) / den;
    return { x: s1.p1.x + t * d1x, y: s1.p1.y + t * d1y };
  }
  const segs = [];
  for (let i = 0; i < n; i++) {
    const b = brng(coords[i], coords[(i + 1) % n]);
    segs.push(offSeg(pts[i], pts[(i + 1) % n], setSB(b)));
  }
  const envM = segs.map((_, i) => intersect(segs[(i + n - 1) % n], segs[i]));
  return envM.map(m => ({
    lat: cLat + m.y / R_EARTH * 180 / Math.PI,
    lon: cLon + m.x / (R_EARTH * Math.cos(cLat * Math.PI / 180)) * 180 / Math.PI,
  }));
}

// ─── ZOOM CALCULATION ────────────────────────────────────────────────────────
function computeZoom(coords, cLat, cLon) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const ext = Math.max(
    Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)),
    Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y)), 20
  );
  const targetViewM = ext * 2.5; // closer zoom — parcelle plus visible
  const mpp = targetViewM / 900;
  const z = Math.log2(156543.03 * Math.cos(cLat * Math.PI / 180) / mpp);
  return Math.min(17.5, Math.max(16, Math.round(z * 4) / 4));
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

// ═══════════════════════════════════════════════════════════════════════════════
// GENERATE MAPBOX GL HTML PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function generateMapHTML(center, zoom, bearing, parcelCoords, envelopeCoords, mapboxToken) {
  const parcelGeoJSON = {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[...parcelCoords.map(c => [c.lon, c.lat]), [parcelCoords[0].lon, parcelCoords[0].lat]]],
    },
  };
  const envelopeGeoJSON = {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[...envelopeCoords.map(c => [c.lon, c.lat]), [envelopeCoords[0].lon, envelopeCoords[0].lat]]],
    },
  };

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; }
  body { width: 1280px; height: 1280px; overflow: hidden; }
  #map { width: 1280px; height: 1280px; }
</style>
<script src="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.js"></script>
<link href="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.css" rel="stylesheet">
</head>
<body>
<div id="map"></div>
<script>
  mapboxgl.accessToken = '${mapboxToken}';

  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11',
    center: [${center.lon}, ${center.lat}],
    zoom: ${zoom},
    bearing: ${bearing},
    pitch: 62,
    antialias: true,
    preserveDrawingBuffer: true,
    fadeDuration: 0,
  });

  map.on('style.load', () => {
    // Better lighting for 3D depth and shadows
    map.setLight({
      anchor: 'viewport',
      color: '#ffffff',
      intensity: 0.4,
      position: [1.5, 210, 30],
    });

    // ─── 3D BUILDINGS ──────────────────────────────────────────────────
    const layers = map.getStyle().layers;
    let labelLayerId;
    for (const layer of layers) {
      if (layer.type === 'symbol' && layer.layout['text-field']) {
        labelLayerId = layer.id;
        break;
      }
    }

    map.addLayer({
      id: '3d-buildings',
      source: 'composite',
      'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion',
      minzoom: 14,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['get', 'height'],
          0, '#e6e1d8',
          8, '#dbd6cc',
          20, '#d0cbc2',
          40, '#c5c0b8',
        ],
        'fill-extrusion-height': ['*', ['get', 'height'], 1.8],
        'fill-extrusion-base': ['*', ['get', 'min_height'], 1.8],
        'fill-extrusion-opacity': 0.92,
        'fill-extrusion-vertical-gradient': true,
      },
    }, labelLayerId);

    // ─── PARCEL FILL ────────────────────────────────────────────────────
    map.addSource('parcel', {
      type: 'geojson',
      data: ${JSON.stringify(parcelGeoJSON)},
    });
    map.addLayer({
      id: 'parcel-fill',
      type: 'fill-extrusion',
      source: 'parcel',
      paint: {
        'fill-extrusion-color': '#c02010',
        'fill-extrusion-height': 1,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.3,
      },
    });
    map.addLayer({
      id: 'parcel-outline',
      type: 'line',
      source: 'parcel',
      paint: {
        'line-color': '#c02010',
        'line-width': 3.5,
        'line-opacity': 0.95,
      },
    });

    // ─── ENVELOPE ───────────────────────────────────────────────────────
    map.addSource('envelope', {
      type: 'geojson',
      data: ${JSON.stringify(envelopeGeoJSON)},
    });
    map.addLayer({
      id: 'envelope-outline',
      type: 'line',
      source: 'envelope',
      paint: {
        'line-color': '#d02818',
        'line-width': 2,
        'line-dasharray': [4, 3],
        'line-opacity': 0.6,
      },
    });

    // ─── BUILDABLE VOLUME (extruded envelope, translucent green) ────────
    map.addLayer({
      id: 'envelope-volume',
      type: 'fill-extrusion',
      source: 'envelope',
      paint: {
        'fill-extrusion-color': '#1d7a3e',
        'fill-extrusion-height': 14,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.1,
      },
    });
  });

  // ─── SIGNAL WHEN MAP IS FULLY RENDERED ──────────────────────────────
  map.on('idle', () => {
    // Wait extra time for all 3D tiles and extrusions to fully render
    setTimeout(() => {
      window.__MAP_READY = true;
    }, 3000);
  });

  // Fallback: mark ready after 25s no matter what
  setTimeout(() => {
    window.__MAP_READY = true;
  }, 25000);
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRAW OVERLAYS ON SCREENSHOT (canvas compositing)
// ═══════════════════════════════════════════════════════════════════════════════
function drawOverlays(ctx, W, H, BH, p) {
  const {
    site_area, land_width, land_depth, buildable_fp,
    setback_front, setback_side, setback_back,
    city, district, zoning, terrain_context, bearing,
  } = p;

  function T(x, y, txt, color, size, bold = false, anchor = "center") {
    ctx.font = `${bold ? "700" : "500"} ${size}px Arial, Helvetica, sans-serif`;
    ctx.textAlign = anchor;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = size > 14 ? 5 : 3.5;
    ctx.lineJoin = "round";
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y);
  }

  // (No overlay text on map — cleaner look, data in stats bar + legend)

  // ─── Compass ──────────────────────
  ctx.save();
  ctx.translate(W - 55, 55);
  ctx.beginPath(); ctx.arc(0, 0, 26, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fill();
  ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1; ctx.stroke();
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(-4, -2); ctx.lineTo(0, -7); ctx.lineTo(4, -2); ctx.closePath();
  ctx.fillStyle = "#d02818"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 16); ctx.lineTo(-4, 2); ctx.lineTo(0, 7); ctx.lineTo(4, 2); ctx.closePath();
  ctx.fillStyle = "#bbb"; ctx.fill();
  ctx.font = "bold 11px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#d02818";
  ctx.fillText("N", 0, -20);
  ctx.restore();

  // ─── Legend ──────────────────────
  const legItems = [
    { type: "rect", fill: "rgba(208,40,24,0.25)", stroke: "#d02818", label: `Parcelle — ${site_area} m²` },
    { type: "line", stroke: "#d02818", label: "Enveloppe constructible" },
    { type: "rect", fill: "#e8e4dc", stroke: "#c8c4bc", label: "Bâtiments 3D Mapbox" },
    { type: "rect", fill: "rgba(29,122,62,0.08)", stroke: "rgba(29,122,62,0.4)", label: "Volume constructible" },
  ];
  const legW = 280, legH = 20 + legItems.length * 26 + 12;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.06)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.beginPath(); ctx.roundRect(16, 16, legW, legH, 8); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#e8e5e0"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();

  legItems.forEach((item, i) => {
    const iy = 16 + 16 + i * 26;
    if (item.type === "rect") {
      ctx.fillStyle = item.fill;
      ctx.beginPath(); ctx.roundRect(28, iy, 16, 12, 2); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(28, iy + 6); ctx.lineTo(44, iy + 6);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.font = "12px Arial"; ctx.fillStyle = "#555"; ctx.textAlign = "left";
    ctx.fillText(item.label, 52, iy + 11);
  });
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© Mapbox © OpenStreetMap", 28, 16 + legH - 6);

  // ─── Stats bar ──────────────────
  const BY = H, pad = 30;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, BY, W, BH);
  ctx.beginPath(); ctx.moveTo(0, BY); ctx.lineTo(W, BY);
  ctx.strokeStyle = "#d02818"; ctx.lineWidth = 4; ctx.stroke();

  const C1 = pad, C2 = W * 0.25, C3 = W * 0.50, C4 = W * 0.74;
  ctx.textAlign = "left";
  ctx.font = "bold 22px Arial"; ctx.fillStyle = "#111";
  ctx.fillText("Lecture stratégique du site", C1, BY + 38);
  ctx.font = "12px Arial"; ctx.fillStyle = "#aaa";
  ctx.fillText(`${city} · ${district} · Zoning : ${zoning}`, C1, BY + 58);

  ctx.beginPath(); ctx.moveTo(C1, BY + 72); ctx.lineTo(W - pad, BY + 72);
  ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1.5; ctx.stroke();

  ctx.font = "10px Arial"; ctx.fillStyle = "#bbb";
  ctx.fillText("Surface parcelle", C1, BY + 90);
  ctx.font = "bold 28px Arial"; ctx.fillStyle = "#111"; ctx.fillText(`${site_area} m²`, C1, BY + 122);
  ctx.font = "10px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Dimensions", C2, BY + 90);
  ctx.font = "bold 22px Arial"; ctx.fillStyle = "#111"; ctx.fillText(`${land_width}m × ${land_depth}m`, C2, BY + 122);
  ctx.font = "10px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Empreinte constructible", C3, BY + 90);
  ctx.font = "bold 28px Arial"; ctx.fillStyle = "#1d7a3e"; ctx.fillText(`${buildable_fp} m²`, C3, BY + 122);
  ctx.font = "10px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Retraits réglementaires", C4, BY + 90);
  ctx.font = "600 14px Arial"; ctx.fillStyle = "#333";
  ctx.fillText(`Avant : ${setback_front}m · Côtés : ${setback_side}m`, C4, BY + 112);
  ctx.fillText(`Arrière : ${setback_back}m`, C4, BY + 132);

  ctx.beginPath(); ctx.moveTo(C1, BY + 146); ctx.lineTo(W - pad, BY + 146);
  ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = "11px Arial"; ctx.fillStyle = "#ccc";
  ctx.fillText((terrain_context || "").substring(0, 90), C1, BY + 168);
  ctx.textAlign = "right"; ctx.font = "9px Arial"; ctx.fillStyle = "#ddd";
  ctx.fillText("BARLO · Diagnostic foncier automatisé", W - pad, BY + BH - 12);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("═══ /generate (Browserless + Mapbox GL 3D) ═══");

  const {
    lead_id, client_name, polygon_points, site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp, setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    image_size = 900, slide_name = "slide_4_axo",
  } = req.body;

  if (!lead_id || !polygon_points)
    return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });
  if (!MAPBOX_TOKEN)
    return res.status(500).json({ error: "MAPBOX_TOKEN non configuré" });
  if (!BROWSERLESS_TOKEN)
    return res.status(500).json({ error: "BROWSERLESS_TOKEN non configuré — inscription gratuite sur browserless.io" });

  // Parse polygon
  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
  if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });

  const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
  const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
  console.log(`Centre: ${cLat.toFixed(6)}, ${cLon.toFixed(6)}`);

  // Compute envelope
  const envelopeCoords = computeEnvelope(
    coords, cLat, cLon,
    Number(setback_front), Number(setback_side), Number(setback_back)
  );

  const zoom = computeZoom(coords, cLat, cLon);
  const bearing = computeBearing(coords, cLat, cLon);
  console.log(`View: zoom=${zoom}, bearing=${bearing}°, pitch=55°`);

  let browser;
  try {
    // ── 1. CONNECT TO BROWSERLESS ──────────────────────────────────────
    console.log("Connecting to Browserless...");
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`,
    });
    console.log(`Connected to Browserless (${Date.now() - t0}ms)`);

    // ── 2. RENDER MAPBOX GL 3D ─────────────────────────────────────────
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1280, deviceScaleFactor: 1 });

    const html = generateMapHTML(
      { lat: cLat, lon: cLon }, zoom, bearing,
      coords, envelopeCoords, MAPBOX_TOKEN
    );

    // Set page content and wait for Mapbox to load
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    console.log(`Page loaded (${Date.now() - t0}ms), waiting for map render...`);

    // Wait for map to signal ready
    await page.waitForFunction("window.__MAP_READY === true", { timeout: 25000 });
    console.log(`Map rendered (${Date.now() - t0}ms)`);

    // Take screenshot
    const screenshotBuffer = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: 1280, height: 1280 },
    });
    console.log(`Screenshot: ${screenshotBuffer.length} bytes (${Date.now() - t0}ms)`);

    await page.close();

    // ── 3. COMPOSITE OVERLAYS ──────────────────────────────────────────
    const mapImg = await loadImage(screenshotBuffer);
    const W = 1280, H = 1280;
    const BH = Math.round(H * 0.12);

    const canvas = createCanvas(W, H + BH);
    const ctx = canvas.getContext("2d");

    // Draw the Mapbox 3D screenshot
    ctx.drawImage(mapImg, 0, 0);

    // Draw BARLO overlays
    drawOverlays(ctx, W, H, BH, {
      site_area: Number(site_area), land_width: Number(land_width),
      land_depth: Number(land_depth), buildable_fp: Number(buildable_fp),
      setback_front: Number(setback_front), setback_side: Number(setback_side),
      setback_back: Number(setback_back),
      city: city || "", district: district || "", zoning: zoning || "",
      terrain_context: terrain_context || "", bearing,
    });

    const png = canvas.toBuffer("image/png");
    console.log(`Final PNG: ${png.length} bytes, ${W}x${H + BH} (${Date.now() - t0}ms)`);

    // ── 4. UPLOAD TO SUPABASE ──────────────────────────────────────────
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const slug = String(client_name || "client").toLowerCase().trim()
      .replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const path = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;

    const { error: ue } = await sb.storage.from("massing-images").upload(path, png, {
      contentType: "image/png", upsert: true,
    });
    if (ue) return res.status(500).json({ error: ue.message });

    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(path);
    console.log(`✓ Done: ${pd.publicUrl} (${Date.now() - t0}ms)`);

    return res.json({
      ok: true, public_url: pd.publicUrl, path,
      centroid: { lat: cLat, lon: cLon },
      view: { zoom, bearing, pitch: 55 },
      engine: "browserless-mapbox-gl-3d-v9",
      duration_ms: Date.now() - t0,
    });

  } catch (e) {
    console.error("Error:", e.message || e);
    return res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (browser) {
      try { browser.disconnect(); } catch (_) {}
    }
  }
});

app.listen(PORT, () => {
  console.log(`BARLO Axo Service v9.0 on port ${PORT}`);
  console.log(`Engine: Browserless + Mapbox GL 3D`);
  console.log(`Browserless: ${BROWSERLESS_TOKEN ? "OK" : "MISSING — sign up at browserless.io"}`);
  console.log(`Mapbox: ${MAPBOX_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Supabase: ${SUPABASE_URL ? "OK" : "MISSING"}`);
});
