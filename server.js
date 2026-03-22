const express = require("express");
const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");
const sharp = require("sharp");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));

// ─── Endpoint principal ───────────────────────────────────────────────────────
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("→ /generate received");

  const {
    lead_id, client_name, polygon_points,
    site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp,
    setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    image_size = 900,
    slide_name = "slide_4_axo",
  } = req.body;

  if (!lead_id || !polygon_points) {
    return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });
  }

  // Parse polygon
  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));

  if (coords.length < 3) {
    return res.status(400).json({ error: "polygon_points invalide" });
  }

  // Centroïde
  const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
  const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
  console.log(`Centroïde: ${cLat}, ${cLon}`);

  // Enveloppe constructible (offset inset)
  const envelopeCoords = computeEnvelope(
    coords, cLat, cLon,
    Number(setback_front), Number(setback_side), Number(setback_back)
  );

  let browser;
  try {
    // ── 1. Lancer Puppeteer ──────────────────────────────────────────────────
    console.log("Launching Puppeteer...");
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    const W = Number(image_size);
    const H = Number(image_size);
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });

    // ── 2. Charger la page Mapbox ────────────────────────────────────────────
    console.log("Loading Mapbox page...");
    const mapHTML = buildMapboxHTML({
      cLat, cLon, coords, envelopeCoords,
      W, H, mapboxToken: MAPBOX_TOKEN,
    });

    await page.setContent(mapHTML, { waitUntil: "networkidle0", timeout: 30000 });

    // Attendre que Mapbox soit fully rendered (idle + tuiles chargées)
    await page.waitForFunction(() => window.__mapReady === true, { timeout: 55000 });

    // Pause pour laisser les tuiles 3D se charger complètement
    await new Promise(r => setTimeout(r, 2000));

    // ── 3. Screenshot Mapbox ──────────────────────────────────────────────────
    console.log("Taking Mapbox screenshot...");
    const mapScreenshot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: W, height: H } });
    await browser.close();
    browser = null;
    console.log(`Mapbox screenshot done (${Date.now() - t0}ms)`);

    // ── 4. Générer l'overlay SVG (parcelle + enveloppe + annotations + stats) ─
    console.log("Generating SVG overlay...");
    const BH = 170; // hauteur bande stats
    const TOTAL_H = H + BH;
    const overlaySVG = buildOverlaySVG({
      coords, envelopeCoords, cLat, cLon,
      site_area: Number(site_area),
      land_width: Number(land_width), land_depth: Number(land_depth),
      envelope_w: Number(envelope_w), envelope_d: Number(envelope_d),
      buildable_fp: Number(buildable_fp),
      setback_front: Number(setback_front),
      setback_side: Number(setback_side),
      setback_back: Number(setback_back),
      city: city || "", district: district || "",
      zoning: zoning || "", terrain_context: terrain_context || "",
      W, H, BH, TOTAL_H,
    });

    // ── 5. Composer : Mapbox + overlay + bande stats ──────────────────────────
    console.log("Compositing...");
    const overlaySVGBuffer = Buffer.from(overlaySVG);
    const overlayPNG = await sharp(overlaySVGBuffer)
      .resize(W * 2, TOTAL_H * 2)
      .png()
      .toBuffer();

    // Canvas final = screenshot Mapbox (W×H) + bande blanche stats en bas
    const finalPNG = await sharp({
      create: { width: W * 2, height: TOTAL_H * 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
    })
      .composite([
        // Screenshot Mapbox en haut (2x pour retina)
        { input: await sharp(mapScreenshot).resize(W * 2, H * 2).png().toBuffer(), top: 0, left: 0 },
        // Overlay SVG par-dessus (parcelle + enveloppe + annotations + bande stats)
        { input: overlayPNG, top: 0, left: 0 },
      ])
      .png()
      .toBuffer();

    console.log(`PNG final: ${finalPNG.length} bytes (${Date.now() - t0}ms)`);

    // ── 6. Upload Supabase ─────────────────────────────────────────────────────
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const slug = String(client_name || "client").toLowerCase().trim()
      .replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const path = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;

    const { error: ue } = await sb.storage.from("massing-images")
      .upload(path, finalPNG, { contentType: "image/png", upsert: true });

    if (ue) return res.status(500).json({ error: ue.message });

    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(path);
    console.log(`Done: ${pd.publicUrl} (${Date.now() - t0}ms)`);

    return res.json({
      ok: true,
      public_url: pd.publicUrl,
      path,
      centroid: { lat: cLat, lon: cLon },
      duration_ms: Date.now() - t0,
    });

  } catch (e) {
    console.error("Error:", e);
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: String(e) });
  }
});

// ─── Calcul enveloppe constructible ──────────────────────────────────────────
function computeEnvelope(coords, cLat, cLon, front, side, back) {
  const R = 6371000;
  const toM = (lat, lon) => ({
    x: (lon - cLon) * Math.PI / 180 * R * Math.cos(cLat * Math.PI / 180),
    y: (lat - cLat) * Math.PI / 180 * R,
  });
  const toGPS = (x, y) => ({
    lat: cLat + y / R * 180 / Math.PI,
    lon: cLon + x / (R * Math.cos(cLat * Math.PI / 180)) * 180 / Math.PI,
  });

  const pts = coords.map(c => toM(c.lat, c.lon));
  const n = pts.length;

  function brng(p1, p2) {
    const dLon = (p2.lon - p1.lon) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(p2.lat * Math.PI / 180);
    const x = Math.cos(p1.lat * Math.PI / 180) * Math.sin(p2.lat * Math.PI / 180)
             - Math.sin(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // Road bearing = bearing du segment le plus au nord
  let maxLat = -Infinity, rb = 0;
  for (let i = 0; i < n - 1; i++) {
    const ml = (coords[i].lat + coords[i + 1].lat) / 2;
    if (ml > maxLat) { maxLat = ml; rb = brng(coords[i], coords[i + 1]); }
  }

  function segBrng(i) { return brng(coords[i], coords[(i + 1) % n]); }
  function setSB(b) {
    let d = ((b - rb) + 360) % 360; if (d > 180) d = 360 - d;
    return d < 45 ? front : d < 135 ? side : back;
  }

  function offSeg(p1, p2, dist) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) + 0.001;
    const nx = -dy / len, ny = dx / len;
    return { p1: { x: p1.x + nx * dist, y: p1.y + ny * dist }, p2: { x: p2.x + nx * dist, y: p2.y + ny * dist } };
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
    segs.push(offSeg(pts[i], pts[(i + 1) % n], setSB(segBrng(i))));
  }
  const envM = segs.map((_, i) => intersect(segs[(i + n - 1) % n], segs[i]));
  return envM.map(m => toGPS(m.x, m.y));
}

// ─── Page HTML Mapbox ─────────────────────────────────────────────────────────
function buildMapboxHTML({ cLat, cLon, coords, envelopeCoords, W, H, mapboxToken }) {
  const polygonGeoJSON = {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[...coords.map(c => [c.lon, c.lat]), [coords[0].lon, coords[0].lat]]],
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
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${W}px; height: ${H}px; overflow: hidden; }
  #map { width: ${W}px; height: ${H}px; }
</style>
<link href="https://api.mapbox.com/mapbox-gl-js/v3.1.2/mapbox-gl.css" rel="stylesheet"/>
<script src="https://api.mapbox.com/mapbox-gl-js/v3.1.2/mapbox-gl.js"></script>
</head>
<body>
<div id="map"></div>
<script>
mapboxgl.accessToken = '${mapboxToken}';
window.__mapReady = false;

const map = new mapboxgl.Map({
  container: 'map',
  // Style Mapbox Light — le plus proche du rendu Hektar
  style: 'mapbox://styles/mapbox/light-v11',
  center: [${cLon}, ${cLat}],
  zoom: 17,
  pitch: 45,          // Vue isométrique ~45°
  bearing: -17.6,     // Légère rotation NW pour les ombres
  antialias: true,
  preserveDrawingBuffer: true,  // OBLIGATOIRE pour le screenshot
});

map.on('load', () => {
  // Activer les bâtiments 3D Mapbox
  const layers = map.getStyle().layers;
  const labelLayerId = layers.find(l => l.type === 'symbol' && l.layout['text-field'])?.id;

  map.addLayer({
    id: 'add-3d-buildings',
    source: 'composite',
    'source-layer': 'building',
    filter: ['==', 'extrude', 'true'],
    type: 'fill-extrusion',
    minzoom: 14,
    paint: {
      'fill-extrusion-color': '#f5f3ef',
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.05, ['get', 'height']],
      'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.05, ['get', 'min_height']],
      'fill-extrusion-opacity': 0.95,
      'fill-extrusion-ambient-occlusion-intensity': 0.5,
    }
  }, labelLayerId);

  // Attendre que toutes les tuiles soient chargées
  map.once('idle', () => {
    window.__mapReady = true;
  });
});

map.on('error', (e) => {
  console.error('Mapbox error:', e);
  window.__mapReady = true; // Ne pas bloquer en cas d'erreur
});
</script>
</body>
</html>`;
}

// ─── Overlay SVG (parcelle + enveloppe + annotations + bande stats) ───────────
// Projeté en coordonnées écran depuis lat/lon via Mercator simplifié
function buildOverlaySVG({
  coords, envelopeCoords, cLat, cLon,
  site_area, land_width, land_depth,
  envelope_w, envelope_d, buildable_fp,
  setback_front, setback_side, setback_back,
  city, district, zoning, terrain_context,
  W, H, BH, TOTAL_H,
}) {
  // Projection Mercator → pixels pour superposition sur Mapbox zoom 17 pitch 45 bearing -17.6
  // On utilise une projection axo cohérente avec la vue Mapbox
  const ZOOM = 17;
  const PITCH = 45 * Math.PI / 180;
  const BEARING = -17.6 * Math.PI / 180;

  function latLonToMercator(lat, lon) {
    const scale = 256 * Math.pow(2, ZOOM);
    const x = (lon + 180) / 360 * scale;
    const sinLat = Math.sin(lat * Math.PI / 180);
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    return { x, y };
  }

  const centerMerc = latLonToMercator(cLat, cLon);

  function project(lat, lon) {
    const m = latLonToMercator(lat, lon);
    // Décalage depuis le centre
    let dx = m.x - centerMerc.x;
    let dy = m.y - centerMerc.y;
    // Rotation bearing
    const cos = Math.cos(-BEARING), sin = Math.sin(-BEARING);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    // Perspective pitch (compression verticale)
    const py = ry * Math.cos(PITCH);
    // Centrage écran
    return { x: W / 2 + rx, y: H / 2 + py };
  }

  // Projection des polygones
  const parcelPx = coords.map(c => project(c.lat, c.lon));
  const envPx = envelopeCoords.map(c => project(c.lat, c.lon));

  const parcelPath = parcelPx.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";
  const envPath = envPx.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";

  // Centre parcelle pour annotation
  const cx = parcelPx.reduce((s, p) => s + p.x, 0) / parcelPx.length;
  const cy = parcelPx.reduce((s, p) => s + p.y, 0) / parcelPx.length;

  function T(x, y, txt, color, size, bold = false, anchor = "middle") {
    const fw = bold ? "700" : "500";
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-size="${size}" font-weight="${fw}" font-family="Arial, sans-serif" fill="white" stroke="white" stroke-width="5" stroke-linejoin="round">${esc(txt)}</text>
<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-size="${size}" font-weight="${fw}" font-family="Arial, sans-serif" fill="${color}">${esc(txt)}</text>`;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Bande stats
  const BY = H;
  const C1 = 24, C2 = 220, C3 = 410, C4 = 590;

  const stats = `
<rect x="0" y="${BY}" width="${W}" height="${BH}" fill="#ffffff"/>
<line x1="0" y1="${BY}" x2="${W}" y2="${BY}" stroke="#d02818" stroke-width="3"/>
<text x="${C1}" y="${BY + 30}" font-size="16" font-weight="700" font-family="Arial, sans-serif" fill="#111">Lecture stratégique du site</text>
<text x="${C1}" y="${BY + 48}" font-size="9" font-family="Arial, sans-serif" fill="#aaa">${esc(city)} · ${esc(district)} · Zoning : ${esc(zoning)}</text>
<line x1="${C1}" y1="${BY + 56}" x2="${W - C1}" y2="${BY + 56}" stroke="#f0ede8" stroke-width="1"/>
<text x="${C1}" y="${BY + 72}" font-size="8" font-family="Arial, sans-serif" fill="#bbb">Surface parcelle</text>
<text x="${C1}" y="${BY + 94}" font-size="22" font-weight="700" font-family="Arial, sans-serif" fill="#111">${site_area} m²</text>
<text x="${C2}" y="${BY + 72}" font-size="8" font-family="Arial, sans-serif" fill="#bbb">Dimensions</text>
<text x="${C2}" y="${BY + 94}" font-size="17" font-weight="700" font-family="Arial, sans-serif" fill="#111">${land_width}m × ${land_depth}m</text>
<text x="${C3}" y="${BY + 72}" font-size="8" font-family="Arial, sans-serif" fill="#bbb">Empreinte constructible</text>
<text x="${C3}" y="${BY + 94}" font-size="22" font-weight="700" font-family="Arial, sans-serif" fill="#1d7a3e">${buildable_fp} m²</text>
<text x="${C4}" y="${BY + 72}" font-size="8" font-family="Arial, sans-serif" fill="#bbb">Retraits réglementaires</text>
<text x="${C4}" y="${BY + 86}" font-size="10" font-weight="600" font-family="Arial, sans-serif" fill="#333">Avant : ${setback_front}m · Côtés : ${setback_side}m</text>
<text x="${C4}" y="${BY + 100}" font-size="10" font-weight="600" font-family="Arial, sans-serif" fill="#333">Arrière : ${setback_back}m</text>
<line x1="${C1}" y1="${BY + 112}" x2="${W - C1}" y2="${BY + 112}" stroke="#f0ede8" stroke-width="1"/>
<text x="${C1}" y="${BY + 128}" font-size="8" font-family="Arial, sans-serif" fill="#ccc">${esc((terrain_context || "").substring(0, 120))}</text>
<text x="${W - C1}" y="${BY + BH - 10}" text-anchor="end" font-size="7" font-family="Arial, sans-serif" fill="#ddd">BARLO · Diagnostic foncier</text>`;

  // Légende
  const legend = `<g>
<rect x="12" y="12" width="185" height="68" rx="5" fill="white" stroke="#e4e0d8" stroke-width="1"/>
<rect x="22" y="22" width="12" height="10" rx="1" fill="#f2e2e0" stroke="#d02818" stroke-width="2"/>
<text x="40" y="31" font-size="10" fill="#444" font-family="Arial, sans-serif">Parcelle (${site_area} m²)</text>
<line x1="22" y1="43" x2="34" y2="43" stroke="#d02818" stroke-width="1.5" stroke-dasharray="5,2"/>
<text x="40" y="47" font-size="10" fill="#444" font-family="Arial, sans-serif">Enveloppe constructible</text>
<text x="22" y="68" font-size="7" fill="#bbb" font-family="Arial, sans-serif">© Mapbox · © OpenStreetMap contributors</text>
</g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${TOTAL_H}" viewBox="0 0 ${W} ${TOTAL_H}">
<!-- Parcelle cible -->
<path d="${parcelPath}" fill="#f2e2e0" fill-opacity="0.55" stroke="#d02818" stroke-width="2.5"/>
<!-- Enveloppe constructible -->
<path d="${envPath}" fill="none" stroke="#d02818" stroke-width="2" stroke-dasharray="10,5"/>
<!-- Annotation centre parcelle -->
${T(cx, cy - 10, "Enveloppe constructible", "#d02818", 11, true)}
<!-- Accès principal (segment nord) -->
${T(parcelPx[0].x, parcelPx[0].y - 14, "Accès principal", "#d02818", 11, true)}
<!-- Stats retraits -->
${T(cx + 4, cy + 18, `↔ ${land_width}m × ${land_depth}m`, "#555555", 10)}
${legend}
${stats}
</svg>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`BARLO Mapbox Screenshot Service running on port ${PORT}`);
  console.log(`Mapbox token: ${MAPBOX_TOKEN ? "✓ configured" : "✗ MISSING"}`);
  console.log(`Supabase URL: ${SUPABASE_URL ? "✓ configured" : "✗ MISSING"}`);
});
