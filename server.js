// ═══════════════════════════════════════════════════════════════════════════════
// BARLO — Pipeline 8E · server.js v32 ULTIMATE
// ─ Style Hektar v16 exact (Mapbox custom style)
// ─ Zones parcelle + enveloppe FLAT bleues, sous bâtiments
// ─ OpenAI gpt-image-1 avec prompt STRICT EDIT (ton prompt ultime)
// ─ Cache Supabase : si enhanced existe → retour immédiat, zéro appel OpenAI
// ─ Image de référence de style injectée pour cohérence Massing A/B/C
// ─ Canvas final 1280×1280 (pas de bande stats)
// ─ Arc solaire canvas pur + légende + boussole
// ═══════════════════════════════════════════════════════════════════════════════

const express = require("express");
const puppeteer = require("puppeteer-core");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas, loadImage } = require("canvas");
const FormData = require("form-data");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get("/health", (req, res) => res.json({
  ok: true, engine: "browserless-mapbox-gl-3d",
  version: "33.0-rouge-final",
  features: ["cache", "style-reference", "flat-zones", "solar-arc", "no-stats-band"]
}));

// ─── GÉOMÉTRIE — IDENTIQUE v16 ────────────────────────────────────────────────
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
  function setSB(b) {
    let d = ((b - rb) + 360) % 360;
    if (d > 180) d = 360 - d;
    return d < 45 ? front : d < 135 ? side : back;
  }
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

// ─── HTML MAPBOX GL — STYLE HEKTAR v16 + ZONES FLAT BLEUES ───────────────────
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
  function seededRand(seed) {
    let s = seed;
    return function() {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff;
    };
  }
  const rand = seededRand(${seed});

  mapboxgl.accessToken = '${mapboxToken}';

  // ── Style Hektar custom — IDENTIQUE v16 exact ────────────────────────────
  const hektarStyle = {
    "version": 8, "name": "Hektar",
    "sources": {
      "composite": { "type": "vector", "url": "mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2" }
    },
    "glyphs": "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
    "sprite": "mapbox://sprites/mapbox/light-v11",
    "layers": [
      { "id": "background", "type": "background", "paint": { "background-color": "#f2f0ec" } },
      { "id": "water", "type": "fill", "source": "composite", "source-layer": "water",
        "paint": { "fill-color": "#c8dce8" } },
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
    center: [${center.lon}, ${center.lat}],
    zoom: ${zoom}, bearing: ${bearing}, pitch: 58,
    antialias: true, preserveDrawingBuffer: true,
    fadeDuration: 0, interactive: false,
  });

  map.addControl = function() {};

  map.on('style.load', () => {

    map.setLight({ anchor: 'map', color: '#fff8f0', intensity: 0.55, position: [1.15, 195, 40] });

    // ── Bâtiments 3D — style Hektar IDENTIQUE v16 ─────────────────────────
    map.addLayer({
      id: '3d-buildings',
      source: 'composite', 'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion', minzoom: 13,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['coalesce', ['get', 'height'], 6],
          0, '#ffffff', 4, '#f5f3ef', 10, '#e8e4dc', 20, '#c8c4bc', 40, '#9a9690',
        ],
        'fill-extrusion-height': ['case', ['has', 'height'], ['*', ['get', 'height'], 1.6], 8],
        'fill-extrusion-base': ['case', ['has', 'min_height'], ['*', ['get', 'min_height'], 1.6], 0],
        'fill-extrusion-opacity': 1.0,
        'fill-extrusion-vertical-gradient': true,
      },
    });

    // ── PARCELLE — flat bleue au sol, SOUS les bâtiments ──────────────────
    map.addSource('parcel', { type: 'geojson', data: ${JSON.stringify(parcelGeoJSON)} });
    map.addLayer({
      id: 'parcel-fill', type: 'fill', source: 'parcel',
      paint: { 'fill-color': '#d02818', 'fill-opacity': 0.18 },
    }, '3d-buildings');
    map.addLayer({
      id: 'parcel-outline', type: 'line', source: 'parcel',
      paint: { 'line-color': '#d02818', 'line-width': 3, 'line-opacity': 1 },
    }, '3d-buildings');

    // ── ENVELOPPE CONSTRUCTIBLE — flat bleue tirets, SOUS les bâtiments ───
    map.addSource('envelope', { type: 'geojson', data: ${JSON.stringify(envelopeGeoJSON)} });
    map.addLayer({
      id: 'envelope-fill', type: 'fill', source: 'envelope',
      paint: { 'fill-color': '#d02818', 'fill-opacity': 0.08 },
    }, '3d-buildings');
    map.addLayer({
      id: 'envelope-outline', type: 'line', source: 'envelope',
      paint: { 'line-color': '#d02818', 'line-width': 2.5, 'line-dasharray': [5, 3], 'line-opacity': 0.85 },
    }, '3d-buildings');

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

// ─── CANVAS OVERLAYS — légende + boussole + arc solaire ───────────────────────
function drawOverlays(ctx, W, H, p) {
  const { site_area, bearing } = p;

  // ── Boussole haut droite ──────────────────────────────────────────────────
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

  // ── Légende haut gauche ───────────────────────────────────────────────────
  const legItems = [
    { fill: "rgba(208,40,24,0.18)", stroke: "#d02818", dash: false, label: `Parcelle — ${site_area} m²` },
    { fill: "rgba(208,40,24,0.08)", stroke: "#d02818", dash: true,  label: "Zone constructible (reculs)" },
    { fill: "#e8e4dc",              stroke: "#c8c4bc", dash: false, label: "Bâtiment existant" },
  ];
  const legPad = 14, legLH = 26, legW = 310;
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
    ctx.fillStyle = item.fill;
    ctx.beginPath(); ctx.roundRect(28, iy, 16, 13, 2); ctx.fill();
    if (item.dash) ctx.setLineDash([4, 2]);
    ctx.strokeStyle = item.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    ctx.font = "12px Arial, Helvetica, sans-serif";
    ctx.fillStyle = "#444"; ctx.textAlign = "left";
    ctx.fillText(item.label, 52, iy + 11);
  });
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© Mapbox  © OpenStreetMap contributors", 28, 16 + legH - 6);

  // ── Arc solaire bas droite — canvas pur, discret ──────────────────────────
  const SX = W - 110, SY = H - 110, SR = 68;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.10)"; ctx.shadowBlur = 10;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath(); ctx.arc(SX, SY, SR + 12, 0, 2 * Math.PI); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#e8e4dc"; ctx.lineWidth = 1; ctx.stroke();
  ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.arc(SX, SY, SR - 8, 0, 2 * Math.PI); ctx.stroke();

  const northRad = -(bearing) * Math.PI / 180 - Math.PI / 2;
  const sunriseAngle = northRad + Math.PI / 2;
  const sunsetAngle  = northRad + 3 * Math.PI / 2;

  ctx.beginPath(); ctx.arc(SX, SY, SR - 6, sunriseAngle, sunsetAngle);
  ctx.strokeStyle = "rgba(255,170,0,0.12)"; ctx.lineWidth = 14; ctx.stroke();
  ctx.beginPath(); ctx.arc(SX, SY, SR - 6, sunriseAngle, sunsetAngle);
  const grad = ctx.createLinearGradient(
    SX + Math.cos(sunriseAngle) * SR, SY + Math.sin(sunriseAngle) * SR,
    SX + Math.cos(sunsetAngle)  * SR, SY + Math.sin(sunsetAngle)  * SR
  );
  grad.addColorStop(0,   "rgba(220,120,0,0.5)");
  grad.addColorStop(0.5, "rgba(230,170,0,0.8)");
  grad.addColorStop(1,   "rgba(200,80,0,0.5)");
  ctx.strokeStyle = grad; ctx.lineWidth = 5; ctx.stroke();

  const sunAngle = northRad + Math.PI;
  const sunX = SX + Math.cos(sunAngle) * (SR - 6);
  const sunY = SY + Math.sin(sunAngle) * (SR - 6);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(sunX + Math.cos(a) * 6, sunY + Math.sin(a) * 6);
    ctx.lineTo(sunX + Math.cos(a) * 10, sunY + Math.sin(a) * 10);
    ctx.strokeStyle = "rgba(200,140,0,0.7)"; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.fillStyle = "#e8b800";
  ctx.beginPath(); ctx.arc(sunX, sunY, 5, 0, 2 * Math.PI); ctx.fill();

  [
    { label: "N", angle: northRad,           color: "#1a44bb", font: "bold 11px Arial" },
    { label: "S", angle: northRad + Math.PI, color: "#aaa",    font: "9px Arial" },
    { label: "E", angle: sunriseAngle,        color: "#b08020", font: "bold 10px Arial" },
    { label: "O", angle: sunsetAngle,         color: "#b08020", font: "bold 10px Arial" },
  ].forEach(l => {
    const lx = SX + Math.cos(l.angle) * (SR + 4);
    const ly = SY + Math.sin(l.angle) * (SR + 4);
    ctx.font = l.font; ctx.fillStyle = l.color; ctx.textAlign = "center";
    ctx.fillText(l.label, lx, ly + 4);
  });
  ctx.font = "7px Arial"; ctx.fillStyle = "#ccc"; ctx.textAlign = "center";
  ctx.fillText("ENSOLEILLEMENT", SX, SY + SR + 18);
  ctx.restore();
}

// ─── PROMPT OPENAI ULTIME (ton prompt exact) ──────────────────────────────────
const OPENAI_PROMPT = `You are editing an EXISTING architectural axonometric map render.

CRITICAL RULE:
You must PRESERVE the exact geometry, camera angle, composition, and spatial layout of the original image.
NO reinterpretation. NO redesign. NO perspective change.
This is a STRICT EDIT, not a generation.

--------------------------------
VISUAL STYLE — DO NOT CHANGE
--------------------------------
- Buildings must remain PURE WHITE
- Keep sharp BLACK EDGES outlining buildings
- Preserve the clean architectural model style (physical maquette look)
- Keep all existing greenery (soft green tones, trees, parks)
- Keep roads in light beige tones
- Maintain soft shadows and global lighting
- DO NOT stylize, DO NOT cartoonize, DO NOT add textures

--------------------------------
MANDATORY CORRECTIONS
--------------------------------
1) PARCEL + BUILDING ENVELOPE (VERY IMPORTANT)
- Replace the existing red parcel and red envelope
- Create a FLAT BLUE ZONE on the ground (NO extrusion at all)
- The parcel must be:
  - soft blue fill
  - semi-transparent
- The envelope must be:
  - thin blue dashed outline
- BOTH must be strictly FLAT and positioned UNDER buildings
- They must NOT overlap visually on top of buildings
- They must follow EXACTLY the same geometry as original shapes

2) REMOVE BOTTOM BAND
- Completely REMOVE the bottom black / dark statistics band
- Extend the map seamlessly to fill the full square image
- Final image must be perfectly clean with NO footer, NO text band, NO UI strip

3) ADD SOLAR ARC (BOTTOM RIGHT)
- Add a minimal solar arc diagram in the bottom right corner
- Style: thin white lines, subtle, architectural, clean
- Include: arc curve, small tick marks, minimal sun symbol
- Must be DISCREET and not dominate the image
- Must integrate naturally into the scene

--------------------------------
COMPOSITION CONSTRAINTS
--------------------------------
- Output must be a PERFECT SQUARE (1:1)
- No borders, no padding, no vignette, no blur, no added noise
- No text except minimal graphical symbols (solar arc only)

--------------------------------
ABSOLUTE CONSTRAINTS (NON-NEGOTIABLE)
--------------------------------
- DO NOT change building shapes
- DO NOT change number of buildings
- DO NOT change positions
- DO NOT change camera angle
- DO NOT change lighting direction
- DO NOT recolor buildings
- DO NOT reinterpret vegetation
- DO NOT simplify geometry

--------------------------------
GOAL
--------------------------------
Produce a CLEAN, HIGH-END ARCHITECTURAL DIAGRAM with:
- stable geometry
- corrected zoning (blue flat parcel + envelope)
- no bottom band
- subtle solar arc
The result must look like a professional urban planning axonometric illustration,
fully consistent with the original image.`;

// ─── HELPER : télécharger une image Supabase en buffer ───────────────────────
async function fetchSupabaseImage(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

// ─── ENDPOINT ─────────────────────────────────────────────────────────────────
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("═══ /generate v33 (rouge + cache + style-ref) ═══");

  const {
    lead_id, client_name, polygon_points, site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp, setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    slide_name = "slide_4_axo",
    zoom: zoomOverride = null,
    style_ref_url = null, // URL optionnelle d'une image de référence de style (pour Massing)
  } = req.body;

  if (!lead_id || !polygon_points) return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });
  if (!MAPBOX_TOKEN)      return res.status(500).json({ error: "MAPBOX_TOKEN manquant" });
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
  const zoom    = zoomOverride ? Number(zoomOverride) : computeZoom(coords, cLat, cLon);
  const bearing = computeBearing(coords, cLat, cLon);
  console.log(`zoom=${zoom} bearing=${bearing}° pitch=58°`);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const slug = String(client_name || "client").toLowerCase().trim()
    .replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const folder      = `hektar/${String(lead_id).trim()}_${slug}`;
  const basePath    = `${folder}/${slide_name}.png`;
  const enhancedPath = `${folder}/${slide_name}_enhanced.png`;

  // ── CACHE CHECK : si enhanced existe déjà → retour immédiat ─────────────
  try {
    const { data: files } = await sb.storage.from("massing-images").list(folder);
    const cached = files?.find(f => f.name === `${slide_name}_enhanced.png`);
    if (cached) {
      const { data: cpd } = sb.storage.from("massing-images").getPublicUrl(enhancedPath);
      console.log(`✓ CACHE HIT — returning existing enhanced (${Date.now() - t0}ms)`);
      return res.json({
        ok: true, cached: true,
        public_url: cpd.publicUrl, enhanced_url: cpd.publicUrl,
        path: enhancedPath, duration_ms: Date.now() - t0,
      });
    }
  } catch (e) { console.warn("Cache check error:", e.message); }

  // ── RENDER MAPBOX ─────────────────────────────────────────────────────────
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

    // Canvas base 1280×1280 (pas de bande stats)
    const W = 1280, H = 1280;
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext("2d");
    ctx.drawImage(await loadImage(screenshotBuf), 0, 0, W, H);
    drawOverlays(ctx, W, H, { site_area: Number(site_area), bearing });
    const png = canvas.toBuffer("image/png");
    console.log(`PNG base: ${png.length} bytes (${Date.now() - t0}ms)`);

    // Upload base
    const { error: ue } = await sb.storage.from("massing-images").upload(basePath, png, { contentType: "image/png", upsert: true });
    if (ue) return res.status(500).json({ error: ue.message });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
    console.log(`✓ Base uploaded: ${pd.publicUrl} (${Date.now() - t0}ms)`);

    // ── OPENAI gpt-image-1 ────────────────────────────────────────────────
    let enhancedUrl = pd.publicUrl;
    if (OPENAI_API_KEY) {
      try {
        console.log("Calling OpenAI gpt-image-1 edits...");

        // Resize 1280→1024 pour OpenAI
        const resizedCanvas = createCanvas(1024, 1024);
        const resizedCtx = resizedCanvas.getContext("2d");
        resizedCtx.drawImage(await loadImage(png), 0, 0, W, H, 0, 0, 1024, 1024);
        const pngResized = resizedCanvas.toBuffer("image/png");

        const form = new FormData();
        form.append("model", "gpt-image-1");
        form.append("size", "1024x1024");
        form.append("input_fidelity", "high");
        form.append("prompt", OPENAI_PROMPT);

        // Image principale à styliser
        form.append("image", pngResized, { filename: "map.png", contentType: "image/png" });

        // Image de référence de style (optionnelle — pour Massing A/B/C)
        // Si style_ref_url fourni, on l'injecte comme 2e image pour cohérence visuelle
        if (style_ref_url) {
          console.log(`Using style reference: ${style_ref_url}`);
          const refBuf = await fetchSupabaseImage(style_ref_url);
          if (refBuf) {
            // Resize ref aussi en 1024×1024
            const refCanvas = createCanvas(1024, 1024);
            const refCtx = refCanvas.getContext("2d");
            refCtx.drawImage(await loadImage(refBuf), 0, 0, 1024, 1024);
            const refResized = refCanvas.toBuffer("image/png");
            form.append("image", refResized, { filename: "style_ref.png", contentType: "image/png" });
            console.log("Style reference injected as 2nd image input");
          }
        }

        const oaiRes = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
          body: form,
        });
        const oaiJson = await oaiRes.json();
        console.log(`OpenAI status: ${oaiRes.status} (${Date.now() - t0}ms)`);

        if (oaiJson.data?.[0]?.b64_json) {
          const enhancedMapBuf = Buffer.from(oaiJson.data[0].b64_json, "base64");
          console.log(`OpenAI enhanced: ${enhancedMapBuf.length} bytes`);

          // Recomposer : enhanced 1024→1280 + overlays canvas
          const finalCanvas = createCanvas(W, H);
          const finalCtx = finalCanvas.getContext("2d");
          finalCtx.drawImage(await loadImage(enhancedMapBuf), 0, 0, W, H);
          drawOverlays(finalCtx, W, H, { site_area: Number(site_area), bearing });
          const finalPng = finalCanvas.toBuffer("image/png");
          console.log(`Final PNG: ${finalPng.length} bytes (${Date.now() - t0}ms)`);

          const { error: ue2 } = await sb.storage.from("massing-images")
            .upload(enhancedPath, finalPng, { contentType: "image/png", upsert: true });
          if (!ue2) {
            const { data: pd2 } = sb.storage.from("massing-images").getPublicUrl(enhancedPath);
            enhancedUrl = pd2.publicUrl;
            console.log(`✓ Enhanced uploaded + CACHED: ${enhancedUrl} (${Date.now() - t0}ms)`);
          } else {
            console.warn("Enhanced upload error:", ue2.message);
          }
        } else {
          console.warn("OpenAI no data:", JSON.stringify(oaiJson).substring(0, 300));
        }
      } catch (oaiErr) {
        console.warn("OpenAI error (fallback to base):", oaiErr.message);
      }
    } else {
      console.log("OPENAI_API_KEY absent — base image only");
    }

    return res.json({
      ok: true, cached: false,
      public_url:   pd.publicUrl,
      enhanced_url: enhancedUrl,
      path: basePath,
      centroid: { lat: cLat, lon: cLon },
      view: { zoom, bearing, pitch: 58 },
      duration_ms: Date.now() - t0,
    });

  } catch (e) {
    console.error("Error:", e.message || e);
    return res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (browser) { try { browser.disconnect(); } catch (_) {} }
  }
});

app.listen(PORT, () => {
  console.log(`BARLO v33 FINAL on port ${PORT}`);
  console.log(`Browserless: ${BROWSERLESS_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Mapbox:      ${MAPBOX_TOKEN      ? "OK" : "MISSING"}`);
  console.log(`OpenAI:      ${OPENAI_API_KEY    ? "OK" : "MISSING"}`);
  console.log(`Features:    cache + style-ref + flat-zones + solar-arc`);
});
