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

app.get("/health", (req, res) => res.json({ ok: true, engine: "browserless-mapbox-gl-3d", version: "17.0-constraints" }));

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

  // Stats enrichies avec ratio constructible
  const ratio = Math.round(buildable_fp / site_area * 100);
  const stats = [
    { label: "Surface parcelle", val: `${site_area} m²`, col: C1, color: "#111" },
    { label: "Dimensions", val: `${land_width}m × ${land_depth}m`, col: C2, color: "#111" },
    { label: "Empreinte constructible", val: `${buildable_fp} m²`, col: C3, color: "#1d7a3e" },
    { label: "Ratio constructible", val: `${ratio}%`, col: C3 + 160, color: "#1d7a3e" },
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

// ─── FETCH NOM DE RUE NOMINATIM ───────────────────────────────────────────────
async function fetchStreetName(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=17`;
    const r = await fetch(url, { headers: { "User-Agent": "BARLO-diagnostic/1.0" } });
    const j = await r.json();
    const addr = j.address || {};
    return addr.road || addr.street || addr.pedestrian || addr.path || null;
  } catch { return null; }
}

// ─── DRAW CONSTRAINTS ────────────────────────────────────────────────────────
// Dessine les annotations de contraintes sur la carte (par-dessus l'image enhanced)
// Coordonnées pixel : on projette les coords GPS → pixels via zoom/bearing/center
function gpsToPixel(lat, lon, cLat, cLon, zoom, bearing, W, H) {
  // Projection Mercator simplifiée
  const scale = 256 * Math.pow(2, zoom);
  const toMercX = (lng) => (lng + 180) / 360 * scale;
  const toMercY = (lat) => {
    const s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  };
  const cx = toMercX(cLon), cy = toMercY(cLat);
  const px = toMercX(lon) - cx;
  const py = toMercY(lat) - cy;
  // Rotation bearing
  const rad = bearing * Math.PI / 180;
  const rx = px * Math.cos(rad) - py * Math.sin(rad);
  const ry = px * Math.sin(rad) + py * Math.cos(rad);
  return { x: W / 2 + rx, y: H / 2 + ry };
}

function drawConstraints(ctx, W, H, p) {
  const {
    coords, envelopeCoords, cLat, cLon, zoom, bearing,
    setback_front, setback_side, setback_back,
    buildable_fp, site_area, land_width, land_depth,
    streetNames,
  } = p;

  const toP = (lat, lon) => gpsToPixel(lat, lon, cLat, cLon, zoom, bearing, W, H);

  // ── Ratio constructible — badge central sur la parcelle ──────────────────
  const ratio = Math.round(buildable_fp / site_area * 100);
  const parcelPts = coords.map(c => toP(c.lat, c.lon));
  const cx = parcelPts.reduce((s, p) => s + p.x, 0) / parcelPts.length;
  const cy = parcelPts.reduce((s, p) => s + p.y, 0) / parcelPts.length;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.18)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 2;
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath(); ctx.roundRect(cx - 52, cy - 28, 104, 52, 8); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#d02818"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = "bold 22px Arial"; ctx.fillStyle = "#d02818"; ctx.textAlign = "center";
  ctx.fillText(`${ratio}%`, cx, cy + 2);
  ctx.font = "9px Arial"; ctx.fillStyle = "#888";
  ctx.fillText("CONSTRUCTIBLE", cx, cy + 17);
  ctx.restore();

  // ── Flèches retraits réglementaires ──────────────────────────────────────
  // On dessine des flèches double-sens entre bord parcelle et bord enveloppe
  // Pour chaque côté : midpoint parcelle → midpoint enveloppe
  const n = coords.length;
  const sides = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const midParcel = {
      lat: (coords[i].lat + coords[j].lat) / 2,
      lon: (coords[i].lon + coords[j].lon) / 2,
    };
    const midEnv = {
      lat: (envelopeCoords[i].lat + envelopeCoords[j].lat) / 2,
      lon: (envelopeCoords[i].lon + envelopeCoords[j].lon) / 2,
    };
    sides.push({ midParcel, midEnv, index: i });
  }

  // Déterminer les retraits par côté (front=avant, side=côtés, back=arrière)
  // Le côté "avant" est celui avec la latitude max (le plus au nord = face à la rue)
  const setbacks = sides.map((s, i) => {
    const avgLat = (coords[i].lat + coords[(i + 1) % n].lat) / 2;
    const maxLat = Math.max(...coords.map(c => c.lat));
    const minLat = Math.min(...coords.map(c => c.lat));
    if (Math.abs(avgLat - maxLat) < 0.00005) return { ...s, val: setback_front, label: `Av. ${setback_front}m`, color: "#d02818" };
    if (Math.abs(avgLat - minLat) < 0.00005) return { ...s, val: setback_back, label: `Ar. ${setback_back}m`, color: "#e07010" };
    return { ...s, val: setback_side, label: `${setback_side}m`, color: "#c05000" };
  });

  setbacks.forEach(s => {
    const pA = toP(s.midParcel.lat, s.midParcel.lon);
    const pB = toP(s.midEnv.lat, s.midEnv.lon);
    const dist = Math.sqrt((pB.x - pA.x) ** 2 + (pB.y - pA.y) ** 2);
    if (dist < 4) return; // trop petit, pas de flèche

    ctx.save();
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);

    // Ligne double-sens
    ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(pB.x, pB.y); ctx.stroke();
    ctx.setLineDash([]);

    // Pointe flèche A
    const angle = Math.atan2(pB.y - pA.y, pB.x - pA.x);
    const drawArrow = (x, y, ang) => {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 7 * Math.cos(ang - 0.4), y - 7 * Math.sin(ang - 0.4));
      ctx.moveTo(x, y);
      ctx.lineTo(x - 7 * Math.cos(ang + 0.4), y - 7 * Math.sin(ang + 0.4));
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.stroke();
    };
    drawArrow(pA.x, pA.y, angle + Math.PI);
    drawArrow(pB.x, pB.y, angle);

    // Label au milieu
    const mx = (pA.x + pB.x) / 2, my = (pA.y + pB.y) / 2;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    const tw = ctx.measureText(s.label).width;
    ctx.fillRect(mx - tw / 2 - 3, my - 9, tw + 6, 14);
    ctx.font = "bold 10px Arial"; ctx.fillStyle = s.color; ctx.textAlign = "center";
    ctx.fillText(s.label, mx, my + 2);
    ctx.restore();
  });

  // ── Orientation solaire ───────────────────────────────────────────────────
  // Le nord est à bearing degrés depuis le haut de l'image
  // On dessine un arc solaire en bas-droite de la carte
  const SX = W - 90, SY = H - 90, SR = 38;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.12)"; ctx.shadowBlur = 8;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath(); ctx.arc(SX, SY, SR + 8, 0, 2 * Math.PI); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#e8e4dc"; ctx.lineWidth = 1; ctx.stroke();

  // Arc solaire (est→sud→ouest = 90°→180°→270° depuis nord)
  const northRad = -(bearing) * Math.PI / 180 - Math.PI / 2;
  const sunriseAngle = northRad + Math.PI / 2;  // Est
  const sunsetAngle = northRad + 3 * Math.PI / 2; // Ouest

  ctx.beginPath();
  ctx.arc(SX, SY, SR - 4, sunriseAngle, sunsetAngle);
  const grad = ctx.createLinearGradient(
    SX + Math.cos(sunriseAngle) * SR, SY + Math.sin(sunriseAngle) * SR,
    SX + Math.cos(sunsetAngle) * SR, SY + Math.sin(sunsetAngle) * SR
  );
  grad.addColorStop(0, "rgba(255,160,0,0.3)");
  grad.addColorStop(0.5, "rgba(255,200,0,0.5)");
  grad.addColorStop(1, "rgba(255,100,0,0.3)");
  ctx.strokeStyle = grad; ctx.lineWidth = 6; ctx.stroke();

  // Icône soleil au milieu de l'arc (sud)
  const sunAngle = northRad + Math.PI; // Sud = direction du soleil en Afrique subsaharienne
  const sunX = SX + Math.cos(sunAngle) * (SR - 4);
  const sunY = SY + Math.sin(sunAngle) * (SR - 4);
  ctx.fillStyle = "#f0a000";
  ctx.beginPath(); ctx.arc(sunX, sunY, 5, 0, 2 * Math.PI); ctx.fill();

  // Labels cardinaux
  ctx.font = "bold 9px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#888";
  const dirs = [
    { label: "N", angle: northRad },
    { label: "S", angle: northRad + Math.PI },
    { label: "E", angle: northRad + Math.PI / 2 },
    { label: "O", angle: northRad - Math.PI / 2 },
  ];
  dirs.forEach(d => {
    const dx = SX + Math.cos(d.angle) * (SR + 2);
    const dy = SY + Math.sin(d.angle) * (SR + 2);
    ctx.fillStyle = d.label === "N" ? "#d02818" : "#999";
    ctx.font = d.label === "N" ? "bold 10px Arial" : "9px Arial";
    ctx.fillText(d.label, dx, dy + 3);
  });
  ctx.restore();

  // ── Noms de rues ─────────────────────────────────────────────────────────
  if (streetNames && streetNames.length > 0) {
    streetNames.forEach(street => {
      if (!street.name || !street.point) return;
      const sp = toP(street.point.lat, street.point.lon);
      if (sp.x < 0 || sp.x > W || sp.y < 0 || sp.y > H) return;

      ctx.save();
      const label = street.name;
      const typeLabel = street.type === "primary" ? "• PRINCIPALE" : "• secondaire";
      const tw = Math.max(ctx.measureText(label).width + 16, 80);

      ctx.shadowColor = "rgba(0,0,0,0.1)"; ctx.shadowBlur = 6;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.beginPath(); ctx.roundRect(sp.x - tw / 2, sp.y - 18, tw, 32, 4); ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = street.type === "primary" ? "#b08040" : "#ccc4ae";
      ctx.lineWidth = 1; ctx.stroke();

      ctx.font = "bold 10px Arial"; ctx.fillStyle = "#555"; ctx.textAlign = "center";
      ctx.fillText(label, sp.x, sp.y - 4);
      ctx.font = "8px Arial";
      ctx.fillStyle = street.type === "primary" ? "#b08040" : "#999";
      ctx.fillText(typeLabel, sp.x, sp.y + 10);
      ctx.restore();
    });
  }
}

// ─── ENDPOINT ─────────────────────────────────────────────────────────────────
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("═══ /generate v17 (constraints + streets + solar) ═══");

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

    // Upload Supabase — image de base (slide_4_axo)
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const slug = String(client_name || "client").toLowerCase().trim()
      .replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const basePath = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;
    const { error: ue } = await sb.storage.from("massing-images").upload(basePath, png, { contentType: "image/png", upsert: true });
    if (ue) return res.status(500).json({ error: ue.message });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
    console.log(`✓ Base uploaded: ${pd.publicUrl} (${Date.now() - t0}ms)`);

    // Post-processing OpenAI gpt-image-1 — style Hektar
    let enhancedUrl = pd.publicUrl; // fallback = image de base si OpenAI échoue
    if (OPENAI_API_KEY) {
      try {
        console.log("Calling OpenAI gpt-image-1 edits...");

        // Envoyer uniquement la partie carte 1280×1280 (sans bande stats)
        // redimensionnée en 1024×1024 pour OpenAI
        const resizedCanvas = createCanvas(1024, 1024);
        const resizedCtx = resizedCanvas.getContext("2d");
        const fullImg = await loadImage(png);
        resizedCtx.drawImage(fullImg, 0, 0, 1280, 1280, 0, 0, 1024, 1024);
        const pngResized = resizedCanvas.toBuffer("image/png");

        const form = new FormData();
        form.append("model", "gpt-image-1");
        form.append("image", pngResized, { filename: "slide.png", contentType: "image/png" });
        form.append("size", "1024x1024");
        form.append("input_fidelity", "high"); // préserver la géométrie source
        form.append("prompt", `Restyle this axonometric urban planning map into a professional architectural diagram in the exact style of Hektar (parametric solutions AB).

CRITICAL — GEOMETRY PRESERVATION:
- Keep EXACTLY the same camera angle, pitch and bearing
- Keep EXACTLY the same building footprints, positions and heights
- Keep EXACTLY the same road network layout
- Keep EXACTLY the red highlighted parcel at its exact position and shape
- Keep the dashed red envelope line at its exact position
- Do NOT move, add or remove any building or road
- Do NOT change the composition or crop

STYLE TO APPLY:
- Background and ground: warm cream #f2f0ec
- Building rooftops: pure white #ffffff
- Building sunlit faces: warm off-white #f5f3ef
- Building shadow faces: warm medium gray #9a9690
- Cast shadows on ground: solid warm gray #c4c0b8, pronounced and directional
- Roads: warm taupe #d4c9b0 slightly darker than background, with visible sidewalk strips #e8e2d4 on each side, subtle texture suggesting asphalt
- Main roads slightly wider with a center line suggestion
- Red parcel fill: semi-transparent rose/pink, keep exactly
- Red parcel outline #d02818: clearly visible solid line
- Dashed red envelope #d02818: clearly visible

VEGETATION — VERY IMPORTANT:
- Add many small stylized trees throughout: round canopy viewed from above, dark olive green #5a6e3a with lighter highlight #7a9050
- Trees should vary in size (small, medium, large) and opacity (0.7 to 1.0) for natural depth
- Place trees: along road sidewalks regularly spaced, in courtyards between buildings, in any open green spaces or parks visible
- At least 20-30 trees visible across the scene
- Some trees can partially overlap building edges for realism
- If any park or green area is visible, fill it with grass texture #c8d4a0 and dense trees

No text, no labels, no annotations anywhere on the map.
Professional urban planning quality suitable for 1000€/month architectural report.`);

        const oaiRes = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            ...form.getHeaders(),
          },
          body: form,
        });

        const oaiJson = await oaiRes.json();
        console.log(`OpenAI response status: ${oaiRes.status} (${Date.now() - t0}ms)`);

        if (oaiJson.data && oaiJson.data[0] && oaiJson.data[0].b64_json) {
          // Décoder b64 → buffer PNG enhanced (1024×1024, carte seulement)
          const enhancedMapBuf = Buffer.from(oaiJson.data[0].b64_json, "base64");
          console.log(`OpenAI enhanced map: ${enhancedMapBuf.length} bytes`);

          // ── Recomposer : enhanced map + contraintes + légende/boussole/bande stats ──
          const W = 1280, H = 1280, BH = 200;
          const finalCanvas = createCanvas(W, H + BH);
          const finalCtx = finalCanvas.getContext("2d");

          // 1. Image enhanced OpenAI → 1280×1280
          const enhancedMapImg = await loadImage(enhancedMapBuf);
          finalCtx.drawImage(enhancedMapImg, 0, 0, W, H);

          // 2. Fetch noms de rues Nominatim pour les 4 côtés de la parcelle
          const streetNames = [];
          try {
            const sides = [
              { // côté avant (nord)
                lat: Math.max(...coords.map(c => c.lat)),
                lon: coords.reduce((s, c) => s + c.lon, 0) / coords.length,
              },
              { // côté est
                lat: coords.reduce((s, c) => s + c.lat, 0) / coords.length,
                lon: Math.max(...coords.map(c => c.lon)),
              },
              { // côté sud
                lat: Math.min(...coords.map(c => c.lat)),
                lon: coords.reduce((s, c) => s + c.lon, 0) / coords.length,
              },
              { // côté ouest
                lat: coords.reduce((s, c) => s + c.lat, 0) / coords.length,
                lon: Math.min(...coords.map(c => c.lon)),
              },
            ];
            const seen = new Set();
            for (const side of sides) {
              // Décaler légèrement vers l'extérieur pour tomber sur la rue
              const offsetLat = side.lat + (side.lat - cLat) * 0.0008;
              const offsetLon = side.lon + (side.lon - cLon) * 0.0008;
              const name = await fetchStreetName(offsetLat, offsetLon);
              if (name && !seen.has(name)) {
                seen.add(name);
                // Déterminer type de rue (simplifié : si côté nord/est = principal)
                const type = sides.indexOf(side) <= 1 ? "primary" : "secondary";
                streetNames.push({ name, point: { lat: offsetLat, lon: offsetLon }, type });
              }
            }
            console.log(`Streets found: ${streetNames.map(s => s.name).join(", ")}`);
          } catch (e) {
            console.warn("Nominatim error:", e.message);
          }

          // 3. Annotations contraintes par-dessus la carte enhanced
          drawConstraints(finalCtx, W, H, {
            coords, envelopeCoords, cLat, cLon, zoom, bearing,
            setback_front: Number(setback_front),
            setback_side: Number(setback_side),
            setback_back: Number(setback_back),
            buildable_fp: Number(buildable_fp),
            site_area: Number(site_area),
            land_width: Number(land_width),
            land_depth: Number(land_depth),
            streetNames,
          });

          // 4. Légende + boussole + bande stats par-dessus tout
          drawOverlays(finalCtx, W, H, BH, {
            site_area: Number(site_area), land_width: Number(land_width),
            land_depth: Number(land_depth), buildable_fp: Number(buildable_fp),
            setback_front: Number(setback_front), setback_side: Number(setback_side),
            setback_back: Number(setback_back),
            city: city || "", district: district || "", zoning: zoning || "",
            terrain_context: terrain_context || "", bearing,
          });

          const finalPng = finalCanvas.toBuffer("image/png");
          console.log(`Final enhanced PNG: ${finalPng.length} bytes (${Date.now() - t0}ms)`);

          // Upload enhanced final sur Supabase
          const enhancedPath = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}_enhanced.png`;
          const { error: ue2 } = await sb.storage.from("massing-images").upload(enhancedPath, finalPng, { contentType: "image/png", upsert: true });
          if (!ue2) {
            const { data: pd2 } = sb.storage.from("massing-images").getPublicUrl(enhancedPath);
            enhancedUrl = pd2.publicUrl;
            console.log(`✓ Enhanced uploaded: ${enhancedUrl} (${Date.now() - t0}ms)`);
          } else {
            console.warn("Enhanced upload error:", ue2.message);
          }
        } else {
          console.warn("OpenAI no image data:", JSON.stringify(oaiJson).substring(0, 300));
        }
      } catch (oaiErr) {
        console.warn("OpenAI error (continuing with base):", oaiErr.message);
      }
    } else {
      console.log("OPENAI_API_KEY absent — skipping enhancement");
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
  console.log(`BARLO v17 (constraints + streets + solar) on port ${PORT}`);
  console.log(`Browserless: ${BROWSERLESS_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Mapbox: ${MAPBOX_TOKEN ? "OK" : "MISSING"}`);
  console.log(`OpenAI: ${OPENAI_API_KEY ? "OK" : "MISSING (enhancement disabled)"}`);
});
