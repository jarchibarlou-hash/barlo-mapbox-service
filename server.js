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

app.get("/health", (req, res) => res.json({ ok: true, engine: "browserless-mapbox-gl-3d", version: "20.0-final" }));

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

  const hektarStyle = {
    "version": 8,
    "name": "Hektar",
    "sources": {
      "mapbox-streets": {
        "type": "vector",
        "url": "mapbox://mapbox.mapbox-streets-v8"
      },
      "mapbox-terrain": {
        "type": "vector",
        "url": "mapbox://mapbox.mapbox-terrain-v2"
      },
      "composite": {
        "type": "vector",
        "url": "mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2"
      }
    },
    "glyphs": "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
    "sprite": "mapbox://sprites/mapbox/light-v11",
    "layers": [
      // Fond crème Hektar
      { "id": "background", "type": "background",
        "paint": { "background-color": "#f2f0ec" } },

      // Eau
      { "id": "water", "type": "fill",
        "source": "composite", "source-layer": "water",
        "paint": { "fill-color": "#c8dce8" } },

      // Végétation / parcs
      { "id": "landuse-park", "type": "fill",
        "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["park", "grass", "cemetery", "wood", "scrub", "pitch"], true, false],
        "paint": { "fill-color": "#e0ddd4" } },

      // Zones urbaines (légèrement plus foncé que fond)
      { "id": "landuse-urban", "type": "fill",
        "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["residential", "commercial", "industrial"], true, false],
        "paint": { "fill-color": "#ebe8e2" } },

      // Routes — case (bordure)
      { "id": "road-case-secondary", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#ccc4ae", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 3, 18, 10] } },

      { "id": "road-case-street", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#ccc4ae", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 18, 6] } },

      // Routes — surface beige Hektar
      { "id": "road-fill-secondary", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#eae4d4", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 2, 18, 8] } },

      { "id": "road-fill-street", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#eae4d4", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1, 18, 4] } }
    ]
  };

  const map = new mapboxgl.Map({
    container: 'map',
    style: hektarStyle,
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

    // Style custom Hektar = pas de labels du tout, labelLayerId inutile
    const labelLayerId = undefined;

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
        // Style Hektar : toit blanc, faces progressives du clair au sombre
        'fill-extrusion-color': [
          'interpolate', ['linear'],
          ['coalesce', ['get', 'height'], 6],
          0,  '#ffffff',   // toits : blanc pur Hektar
          4,  '#f5f3ef',   // face lumière : blanc chaud
          10, '#e8e4dc',   // milieu
          20, '#c8c4bc',   // face ombre : gris chaud
          40, '#9a9690',   // ombre profonde Hektar
        ],
        'fill-extrusion-height': [
          'case',
          ['has', 'height'],
          ['*', ['get', 'height'], 1.6],
          8
        ],
        'fill-extrusion-base': [
          'case',
          ['has', 'min_height'],
          ['*', ['get', 'min_height'], 1.6],
          0
        ],
        'fill-extrusion-opacity': 1.0,
        'fill-extrusion-vertical-gradient': true,
      },
    }, labelLayerId);

    // ── Parcelle — flat fill au sol (pas d'extrusion) ────────────────
    map.addSource('parcel', { type: 'geojson', data: ${JSON.stringify(parcelGeoJSON)} });
    map.addLayer({
      id: 'parcel-fill',
      type: 'fill',
      source: 'parcel',
      paint: {
        'fill-color': '#d02818',
        'fill-opacity': 0.15,
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

    // ── Enveloppe réglementaire (reculs) — tirets rouges ─────────────
    map.addSource('envelope', { type: 'geojson', data: ${JSON.stringify(envelopeGeoJSON)} });
    map.addLayer({
      id: 'envelope-fill',
      type: 'fill',
      source: 'envelope',
      paint: {
        'fill-color': '#1a3a5c',
        'fill-opacity': 0.12,
      },
    });
    map.addLayer({
      id: 'envelope-outline',
      type: 'line',
      source: 'envelope',
      paint: {
        'line-color': '#1a3a5c',
        'line-width': 2,
        'line-dasharray': [6, 3],
        'line-opacity': 0.8,
      },
    });

    // ── Noms de rues natifs Mapbox — style gris fin sur route ────────
    map.addLayer({
      id: 'road-labels',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'road',
      filter: ['in', 'class', 'primary', 'secondary', 'tertiary', 'street'],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['DIN Pro Regular', 'Arial Unicode MS Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10, 18, 13],
        'text-max-angle': 30,
        'symbol-placement': 'line',
        'text-padding': 10,
        'text-letter-spacing': 0.05,
      },
      paint: {
        'text-color': '#7a6a50',
        'text-halo-color': 'rgba(255,255,255,0.85)',
        'text-halo-width': 2,
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

// ─── FETCH NOM DE RUE NOMINATIM ───────────────────────────────────────────────
async function fetchStreetName(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=17`;
    const r = await fetch(url, { headers: { "User-Agent": "BARLO-diagnostic/1.0" } });
    const j = await r.json();
    const addr = j.address || {};
    return addr.road || addr.street || addr.pedestrian || null;
  } catch { return null; }
}

// ─── OVERLAYS CANVAS — légende + boussole + arc solaire + noms rues ──────────
function drawOverlays(ctx, W, H, p) {
  const { site_area, bearing, streetData } = p;

  // ── Boussole haut droite ──────────────────────────────────────────────────
  ctx.save();
  ctx.translate(W - 58, 58);
  ctx.shadowColor = "rgba(0,0,0,0.15)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.96)"; ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1; ctx.stroke();
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -3); ctx.lineTo(0, -8); ctx.lineTo(5, -3); ctx.closePath();
  ctx.fillStyle = "#d02818"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 3); ctx.lineTo(0, 8); ctx.lineTo(5, 3); ctx.closePath();
  ctx.fillStyle = "#ccc"; ctx.fill();
  ctx.rotate((bearing || 0) * Math.PI / 180);
  ctx.font = "bold 16px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#d02818";
  ctx.fillText("N", 0, -24);
  ctx.restore();

  // ── Légende haut gauche ───────────────────────────────────────────────────
  const legItems = [
    { type: "rect", fill: "rgba(208,40,24,0.15)", stroke: "#d02818", label: `Parcelle — ${site_area} m²` },
    { type: "rect", fill: "rgba(26,58,92,0.12)", stroke: "rgba(26,58,92,0.8)", dash: true, label: "Zone constructible" },
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
    ctx.fillStyle = item.fill;
    ctx.beginPath(); ctx.roundRect(28, iy, 16, 13, 2); ctx.fill();
    if (item.dash) { ctx.setLineDash([4, 2]); }
    ctx.strokeStyle = item.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    ctx.font = "12px Arial"; ctx.fillStyle = "#444"; ctx.textAlign = "left";
    ctx.fillText(item.label, 52, iy + 11);
  });
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© Mapbox  © OpenStreetMap contributors", 28, 16 + legH - 6);

  // ── Arc solaire bas droite — grand et visible ─────────────────────────────
  const SX = W - 120, SY = H - 120, SR = 75;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.15)"; ctx.shadowBlur = 14;
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath(); ctx.arc(SX, SY, SR + 14, 0, 2 * Math.PI); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#e8e4dc"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(SX, SY, SR - 10, 0, 2 * Math.PI); ctx.stroke();

  const northRad = -(bearing) * Math.PI / 180 - Math.PI / 2;
  const sunriseAngle = northRad + Math.PI / 2;
  const sunsetAngle = northRad + 3 * Math.PI / 2;

  ctx.beginPath(); ctx.arc(SX, SY, SR - 8, sunriseAngle, sunsetAngle);
  ctx.strokeStyle = "rgba(255,180,0,0.15)"; ctx.lineWidth = 18; ctx.stroke();

  ctx.beginPath(); ctx.arc(SX, SY, SR - 8, sunriseAngle, sunsetAngle);
  const grad = ctx.createLinearGradient(
    SX + Math.cos(sunriseAngle) * SR, SY + Math.sin(sunriseAngle) * SR,
    SX + Math.cos(sunsetAngle) * SR, SY + Math.sin(sunsetAngle) * SR
  );
  grad.addColorStop(0, "rgba(255,140,0,0.6)");
  grad.addColorStop(0.5, "rgba(255,200,0,0.9)");
  grad.addColorStop(1, "rgba(255,80,0,0.6)");
  ctx.strokeStyle = grad; ctx.lineWidth = 8; ctx.stroke();

  const sunAngle = northRad + Math.PI;
  const sunX = SX + Math.cos(sunAngle) * (SR - 8);
  const sunY = SY + Math.sin(sunAngle) * (SR - 8);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(sunX + Math.cos(a) * 8, sunY + Math.sin(a) * 8);
    ctx.lineTo(sunX + Math.cos(a) * 12, sunY + Math.sin(a) * 12);
    ctx.strokeStyle = "#f0a000"; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.fillStyle = "#f5c000"; ctx.beginPath(); ctx.arc(sunX, sunY, 7, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = "#f0a000"; ctx.beginPath(); ctx.arc(sunX, sunY, 4, 0, 2 * Math.PI); ctx.fill();

  const eX = SX + Math.cos(sunriseAngle) * (SR + 4), eY = SY + Math.sin(sunriseAngle) * (SR + 4);
  const oX = SX + Math.cos(sunsetAngle) * (SR + 4), oY = SY + Math.sin(sunsetAngle) * (SR + 4);
  ctx.font = "bold 11px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#c08020";
  ctx.fillText("E", eX, eY + 4); ctx.fillText("O", oX, oY + 4);
  const nX = SX + Math.cos(northRad) * (SR + 6), nY = SY + Math.sin(northRad) * (SR + 6);
  ctx.font = "bold 16px Arial"; ctx.fillStyle = "#d02818"; ctx.fillText("N", nX, nY + 5);
  const sX = SX + Math.cos(northRad + Math.PI) * (SR + 4), sY = SY + Math.sin(northRad + Math.PI) * (SR + 4);
  ctx.font = "11px Arial"; ctx.fillStyle = "#999"; ctx.fillText("S", sX, sY + 4);
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "center";
  ctx.fillText("ENSOLEILLEMENT", SX, SY + SR + 20);
  ctx.restore();

  // ── Noms de rues style Mapbox — gris fin sur route ────────────────────────
  if (streetData && streetData.length > 0) {
    streetData.forEach(s => {
      if (!s.name || !s.px || !s.py) return;
      if (s.px < 40 || s.px > W - 40 || s.py < 40 || s.py > H - 40) return;
      ctx.save();
      ctx.translate(s.px, s.py);
      ctx.rotate(s.angle || 0);
      const label = s.name;
      ctx.font = s.primary ? "bold 11px Arial" : "10px Arial";
      ctx.strokeStyle = "rgba(255,255,255,0.88)";
      ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.textAlign = "center";
      ctx.strokeText(label, 0, 0);
      ctx.fillStyle = s.primary ? "#6b5c3e" : "#8a7a60";
      ctx.fillText(label, 0, 0);
      ctx.restore();
    });
  }
}

// ─── ENDPOINT ─────────────────────────────────────────────────────────────────
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("═══ /generate v20 (final — Mapbox zones + OpenAI style + canvas overlays) ═══");

  const {
    lead_id, client_name, polygon_points, site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp, setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    slide_name = "slide_4_axo",
    zoom: zoomOverride = null,
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

  const zoom = zoomOverride ? Number(zoomOverride) : computeZoom(coords, cLat, cLon);
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

    // ── Fetch noms de rues Nominatim (avant OpenAI pour gain de temps) ────
    const streetData = [];
    try {
      const sides = [
        { lat: Math.max(...coords.map(c => c.lat)) + 0.0003, lon: cLon, primary: true, angle: -0.3 },
        { lat: cLat, lon: Math.max(...coords.map(c => c.lon)) + 0.0003, primary: false, angle: 0.3 },
        { lat: Math.min(...coords.map(c => c.lat)) - 0.0003, lon: cLon, primary: false, angle: -0.3 },
        { lat: cLat, lon: Math.min(...coords.map(c => c.lon)) - 0.0003, primary: false, angle: 0.3 },
      ];
      const seen = new Set();
      for (const side of sides) {
        const name = await fetchStreetName(side.lat, side.lon);
        if (name && !seen.has(name)) {
          seen.add(name);
          // Position pixel approximative (centre de l'image décalé vers le côté)
          const fracX = side.lon > cLon ? 0.75 : (side.lon < cLon ? 0.25 : 0.5);
          const fracY = side.lat > cLat ? 0.2 : (side.lat < cLat ? 0.75 : 0.5);
          streetData.push({ name, px: fracX * 1280, py: fracY * 1280, primary: side.primary, angle: side.angle });
        }
      }
      console.log(`Streets: ${streetData.map(s => s.name).join(", ")}`);
    } catch (e) { console.warn("Nominatim:", e.message); }

    // Compositing base (1280×1280 — pas de bande stats)
    const W = 1280, H = 1280;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    const mapImg = await loadImage(screenshotBuf);
    ctx.drawImage(mapImg, 0, 0);

    const png = canvas.toBuffer("image/png");
    console.log(`PNG base: ${png.length} bytes (${Date.now() - t0}ms)`);

    // Upload base
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const slug = String(client_name || "client").toLowerCase().trim()
      .replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const basePath = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;
    const { error: ue } = await sb.storage.from("massing-images").upload(basePath, png, { contentType: "image/png", upsert: true });
    if (ue) return res.status(500).json({ error: ue.message });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
    console.log(`✓ Base uploaded: ${pd.publicUrl} (${Date.now() - t0}ms)`);

    // OpenAI gpt-image-1 — stylisation Hektar (sans zones, sans texte)
    let enhancedUrl = pd.publicUrl;
    if (OPENAI_API_KEY) {
      try {
        console.log("Calling OpenAI gpt-image-1 edits...");
        const resizedCanvas = createCanvas(1024, 1024);
        const resizedCtx = resizedCanvas.getContext("2d");
        const fullImg = await loadImage(png);
        resizedCtx.drawImage(fullImg, 0, 0, W, H, 0, 0, 1024, 1024);
        const pngResized = resizedCanvas.toBuffer("image/png");

        const form = new FormData();
        form.append("model", "gpt-image-1");
        form.append("image", pngResized, { filename: "slide.png", contentType: "image/png" });
        form.append("size", "1024x1024");
        form.append("input_fidelity", "high");
        form.append("prompt", `Restyle this axonometric urban planning map into a professional architectural diagram in the exact style of Hektar (parametric solutions AB).

CRITICAL — GEOMETRY PRESERVATION:
- Keep EXACTLY the same camera angle, pitch and bearing
- Keep EXACTLY the same building footprints, positions and heights
- Keep EXACTLY the same road network layout
- Keep EXACTLY the red parcel outline and pink fill at its exact ground-level position — it is a FLAT ground surface, NOT raised
- Keep the blue dashed zone outline at its exact position — it is also FLAT on the ground
- Do NOT move, add, or remove any building, road or zone outline
- Do NOT change the composition or crop

STYLE TO APPLY:
- Background and ground: warm cream #f2f0ec
- Building rooftops: pure white #ffffff with thin dark edge lines #333 marking corners — ESSENTIAL for architectural quality
- Building sunlit faces: warm off-white #f5f3ef with visible edge lines
- Building shadow faces: warm medium gray #9a9690
- Cast shadows on ground: solid warm gray #c4c0b8, pronounced and directional
- Roads: warm taupe #d4c9b0 with sidewalk strips #e8e2d4, subtle asphalt texture
- Red parcel fill: flat semi-transparent rose/pink on ground level
- Red parcel outline #d02818: solid, clearly visible at ground level
- Blue dashed zone outline: keep exactly as is

VEGETATION:
- Add many stylized trees: round canopy top-view, dark olive green #5a6e3a, lighter highlight #7a9050
- Vary sizes and opacity (0.7–1.0) for depth
- Place along sidewalks, in courtyards, open spaces — at least 25 trees
- Green areas filled with #c8d4a0 grass and dense trees

ABSOLUTELY NO TEXT, no labels, no street names, no numbers anywhere on the map.
Professional urban planning quality.`);

        const oaiRes = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
          body: form,
        });
        const oaiJson = await oaiRes.json();
        console.log(`OpenAI status: ${oaiRes.status} (${Date.now() - t0}ms)`);

        if (oaiJson.data && oaiJson.data[0] && oaiJson.data[0].b64_json) {
          const enhancedMapBuf = Buffer.from(oaiJson.data[0].b64_json, "base64");

          // Recomposer : enhanced 1024→1280 + légende + boussole + soleil + rues
          const finalCanvas = createCanvas(W, H);
          const finalCtx = finalCanvas.getContext("2d");
          const enhancedImg = await loadImage(enhancedMapBuf);
          finalCtx.drawImage(enhancedImg, 0, 0, W, H);

          // Overlays node-canvas par-dessus
          drawOverlays(finalCtx, W, H, { site_area: Number(site_area), bearing, streetData });

          const finalPng = finalCanvas.toBuffer("image/png");
          const enhancedPath = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}_enhanced.png`;
          const { error: ue2 } = await sb.storage.from("massing-images").upload(enhancedPath, finalPng, { contentType: "image/png", upsert: true });
          if (!ue2) {
            const { data: pd2 } = sb.storage.from("massing-images").getPublicUrl(enhancedPath);
            enhancedUrl = pd2.publicUrl;
            console.log(`✓ Enhanced uploaded: ${enhancedUrl} (${Date.now() - t0}ms)`);
          }
        } else {
          console.warn("OpenAI no data:", JSON.stringify(oaiJson).substring(0, 300));
        }
      } catch (oaiErr) {
        console.warn("OpenAI error:", oaiErr.message);
      }
    }

    return res.json({
      ok: true,
      public_url: pd.publicUrl,           // image Mapbox de base
      enhanced_url: enhancedUrl,           // image OpenAI enhanced (ou base si échec)
      path: basePath,
      centroid: { lat: cLat, lon: cLon },
      view: { zoom, bearing, pitch: 58 },
      duration_ms: Date.now() - t0
    });

  } catch (e) {
    console.error("Error:", e.message || e);
    return res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (browser) { try { browser.disconnect(); } catch (_) {} }
  }
});

app.listen(PORT, () => {
  console.log(`BARLO v20 (final) on port ${PORT}`);
  console.log(`Browserless: ${BROWSERLESS_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Mapbox: ${MAPBOX_TOKEN ? "OK" : "MISSING"}`);
  console.log(`OpenAI: ${OPENAI_API_KEY ? "OK" : "MISSING (enhancement disabled)"}`);
});
