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

app.get("/health", (req, res) => res.json({ ok: true, engine: "browserless-mapbox-gl-3d", version: "49.0-hektar-pro" }));

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

// ─── AUTO-DETECT ACCESS: milieu du côté "avant" (plus haute latitude) ────────
function computeAccessPoint(coords, cLat, cLon) {
  // Le côté "avant" = le côté dont le milieu a la plus haute latitude (face route)
  let bestMidLat = -Infinity, bestI = 0;
  for (let i = 0; i < coords.length; i++) {
    const j = (i + 1) % coords.length;
    const midLat = (coords[i].lat + coords[j].lat) / 2;
    if (midLat > bestMidLat) { bestMidLat = midLat; bestI = i; }
  }
  const j = (bestI + 1) % coords.length;
  const midLat = (coords[bestI].lat + coords[j].lat) / 2;
  const midLon = (coords[bestI].lon + coords[j].lon) / 2;
  // Bearing perpendiculaire sortant (vers la route)
  const edgeBrng = brng(coords[bestI], coords[j]);
  const outBrng = (edgeBrng + 90) % 360; // perpendiculaire vers l'extérieur
  return { lat: midLat, lon: midLon, bearing: outBrng };
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

  // v49: accès principal auto-détecté
  const access = computeAccessPoint(parcelCoords, center.lat, center.lon);
  // Petit segment flèche : du milieu du côté avant vers l'extérieur (5m)
  const arrowLen = 8; // mètres
  const accEndLat = access.lat + (arrowLen / R_EARTH) * 180 / Math.PI * Math.cos(access.bearing * Math.PI / 180);
  const accEndLon = access.lon + (arrowLen / (R_EARTH * Math.cos(access.lat * Math.PI / 180))) * 180 / Math.PI * Math.sin(access.bearing * Math.PI / 180);
  const accessLineGeoJSON = {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: [[access.lon, access.lat], [accEndLon, accEndLat]] },
  };
  const accessPointGeoJSON = {
    type: "Feature",
    properties: { label: "Accès" },
    geometry: { type: "Point", coordinates: [accEndLon, accEndLat] },
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

  // ═══════════════════════════════════════════════════════════════════
  // v49 HEKTAR PRO — style avec couleurs intégrées (vert gazon, beige routes)
  // Plus de dépendance OpenAI pour les couleurs de base
  // ═══════════════════════════════════════════════════════════════════
  const hektarStyle = {
    "version": 8,
    "name": "Hektar Pro",
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
      // Fond vert gazon — couleur dominante (comme slide 4 ref)
      { "id": "background", "type": "background",
        "paint": { "background-color": "#6aad3a" } },

      // Eau
      { "id": "water", "type": "fill",
        "source": "composite", "source-layer": "water",
        "paint": { "fill-color": "#a8cce0" } },

      // Végétation / parcs — vert plus intense
      { "id": "landuse-park", "type": "fill",
        "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["park", "grass", "cemetery", "wood", "scrub", "pitch"], true, false],
        "paint": { "fill-color": "#5a9e2e" } },

      // Zones résidentielles — vert gazon standard
      { "id": "landuse-urban", "type": "fill",
        "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["residential", "commercial", "industrial"], true, false],
        "paint": { "fill-color": "#6aad3a" } },

      // Routes — case (bordure) — beige sable foncé
      { "id": "road-case-secondary", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#b8a478", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 4, 18, 12] } },

      { "id": "road-case-street", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#b8a478", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 2, 18, 7] } },

      // Routes — surface beige sable clair (comme slide 4 ref)
      { "id": "road-fill-secondary", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#d4c49a", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 3, 18, 10] } },

      { "id": "road-fill-street", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#d4c49a", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 18, 5] } },

      // v49: Labels routes principales — noms de rues visibles
      { "id": "road-label-major", "type": "symbol",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": {
          "text-field": ["coalesce", ["get", "name_fr"], ["get", "name"]],
          "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 17, 13],
          "symbol-placement": "line",
          "text-max-angle": 30,
          "text-padding": 20,
          "text-allow-overlap": false
        },
        "paint": {
          "text-color": "#5a4a2a",
          "text-halo-color": "rgba(255,255,255,0.85)",
          "text-halo-width": 1.5
        }
      },

      // v49: Labels rues secondaires — plus discret
      { "id": "road-label-street", "type": "symbol",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited"], true, false],
        "minzoom": 16,
        "layout": {
          "text-field": ["coalesce", ["get", "name_fr"], ["get", "name"]],
          "text-font": ["DIN Pro Regular", "Arial Unicode MS Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 16, 8, 18, 11],
          "symbol-placement": "line",
          "text-max-angle": 30,
          "text-padding": 30,
          "text-allow-overlap": false
        },
        "paint": {
          "text-color": "#7a6a4a",
          "text-halo-color": "rgba(255,255,255,0.75)",
          "text-halo-width": 1
        }
      }
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

    // ═══════════════════════════════════════════════════════════════════
    // v49: BÂTIMENTS 3D — hauteurs variées 1-4 niveaux pour réalisme
    // ═══════════════════════════════════════════════════════════════════
    // Utilise un hash sur l'ID feature pour créer une variation
    // déterministe entre 3.5m (1 niv) et 14m (4 niv)
    map.addLayer({
      id: '3d-buildings',
      source: 'composite',
      'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion',
      minzoom: 13,
      paint: {
        // v49: blanc pur faces éclairées, gris chaud faces ombre
        'fill-extrusion-color': [
          'interpolate', ['linear'],
          ['coalesce', ['get', 'height'], 6],
          0,  '#fafafa',   // toits : blanc quasi-pur
          4,  '#f2f0ec',   // face lumière
          10, '#e0ddd6',   // milieu
          20, '#c0bdb6',   // face ombre
          40, '#908d88',   // ombre profonde
        ],
        // v49: hauteurs variées — hash sur ID pour varier entre 1 et 4 niveaux
        // Expression Mapbox : utilise modulo sur l'ID numérique pour distribuer
        // les hauteurs en 4 buckets : ~3.5m, ~7m, ~10.5m, ~14m
        'fill-extrusion-height': [
          'let', 'h', ['coalesce', ['get', 'height'], 0],
          ['case',
            // Si le bâtiment a une vraie hauteur > 2m, on la garde (× 1.2)
            ['>', ['var', 'h'], 2],
            ['*', ['var', 'h'], 1.2],
            // Sinon : distribution aléatoire basée sur l'ID
            // On utilise modulo sur la position du bâtiment pour varier
            ['match',
              ['%', ['to-number', ['id']], 7],
              0, 4,      // 1 niveau (4m)
              1, 4,      // 1 niveau
              2, 7.5,    // 2 niveaux (7.5m)
              3, 7.5,    // 2 niveaux
              4, 11,     // 3 niveaux (11m)
              5, 14,     // 4 niveaux (14m)
              6, 4,      // 1 niveau
              7.5        // fallback 2 niveaux
            ]
          ]
        ],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 1.0,
        'fill-extrusion-vertical-gradient': true,
      },
    }, labelLayerId);

    // ── v49: Parcelle — ocre terre (comme slide 4 ref) ────────────
    map.addSource('parcel', { type: 'geojson', data: ${JSON.stringify(parcelGeoJSON)} });
    map.addLayer({ id: 'parcel-fill', type: 'fill', source: 'parcel',
      paint: { 'fill-color': '#c4a56a', 'fill-opacity': 0.45 } }, '3d-buildings');
    map.addLayer({ id: 'parcel-outline', type: 'line', source: 'parcel',
      paint: { 'line-color': '#d02818', 'line-width': 2.5, 'line-opacity': 0.9 } }, '3d-buildings');

    // ── v49: Enveloppe constructible — tirets rouges ─────────────────
    map.addSource('envelope', { type: 'geojson', data: ${JSON.stringify(envelopeGeoJSON)} });
    map.addLayer({ id: 'envelope-outline', type: 'line', source: 'envelope',
      paint: { 'line-color': '#d02818', 'line-width': 2,
               'line-dasharray': [5, 3], 'line-opacity': 0.75 } }, '3d-buildings');

    // ── v49: Flèche d'accès principal ─────────────────────────────────
    map.addSource('access-line', { type: 'geojson', data: ${JSON.stringify(accessLineGeoJSON)} });
    map.addLayer({ id: 'access-arrow-line', type: 'line', source: 'access-line',
      paint: { 'line-color': '#1a6b3a', 'line-width': 3, 'line-opacity': 0.9 } });
    map.addSource('access-point', { type: 'geojson', data: ${JSON.stringify(accessPointGeoJSON)} });
    map.addLayer({ id: 'access-label', type: 'symbol', source: 'access-point',
      layout: {
        'text-field': 'Accès',
        'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
        'text-size': 11,
        'text-offset': [0, -1.2],
        'text-anchor': 'bottom',
        'icon-image': '',
        'text-allow-overlap': true
      },
      paint: {
        'text-color': '#1a6b3a',
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.5
      }
    });
    // Pointe de flèche via un cercle vert au bout
    map.addLayer({ id: 'access-dot', type: 'circle', source: 'access-point',
      paint: { 'circle-radius': 5, 'circle-color': '#1a6b3a', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
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
    { type: "rect", fill: "rgba(196,165,106,0.45)", stroke: "#d02818", label: `Parcelle — ${site_area} m²` },
    { type: "dash", stroke: "#d02818", label: "Zone constructible (reculs)" },
    { type: "dot",  fill: "#1a6b3a", label: "Accès principal" },
    { type: "rect", fill: "#e0ddd6", stroke: "#c0bdb6", label: "Bâtiment existant" },
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
    } else if (item.type === "dot") {
      ctx.fillStyle = item.fill;
      ctx.beginPath(); ctx.arc(36, iy + 6, 5, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(28, iy + 6); ctx.lineTo(44, iy + 6);
      ctx.strokeStyle = item.fill; ctx.lineWidth = 2; ctx.stroke();
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


// ─── LÉGENDE + BOUSSOLE ───────────────────────────────────────────────────────
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
    { type: "rect", fill: "rgba(196,165,106,0.45)", stroke: "#d02818", label: "Parcelle — " + site_area + " m²" },
    { type: "dash", stroke: "#d02818", label: "Zone constructible (reculs)" },
    { type: "dot",  fill: "#1a6b3a", label: "Accès principal" },
    { type: "rect", fill: "#e0ddd6", stroke: "#c0bdb6", label: "Bâtiment existant" },
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
      ctx.fillStyle = item.fill;
      ctx.beginPath(); ctx.roundRect(28, iy, 16, 13, 2); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    } else if (item.type === "dot") {
      ctx.fillStyle = item.fill;
      ctx.beginPath(); ctx.arc(36, iy + 6, 5, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(28, iy + 6); ctx.lineTo(44, iy + 6);
      ctx.strokeStyle = item.fill; ctx.lineWidth = 2; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(28, iy + 6); ctx.lineTo(44, iy + 6);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
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
  grad.addColorStop(0, "rgba(220,120,0,0.5)");
  grad.addColorStop(0.5, "rgba(230,170,0,0.8)");
  grad.addColorStop(1, "rgba(200,80,0,0.5)");
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
    { label: "N", angle: northRad,            color: "#d02818", font: "bold 11px Arial" },
    { label: "S", angle: northRad + Math.PI,  color: "#aaa",    font: "9px Arial" },
    { label: "E", angle: sunriseAngle,         color: "#b08020", font: "bold 10px Arial" },
    { label: "O", angle: sunsetAngle,          color: "#b08020", font: "bold 10px Arial" },
  ].forEach(function(l) {
    const lx = SX + Math.cos(l.angle) * (SR + 4);
    const ly = SY + Math.sin(l.angle) * (SR + 4);
    ctx.font = l.font; ctx.fillStyle = l.color; ctx.textAlign = "center";
    ctx.fillText(l.label, lx, ly + 4);
  });
  ctx.font = "7px Arial"; ctx.fillStyle = "#ccc"; ctx.textAlign = "center";
  ctx.fillText("ENSOLEILLEMENT", SX, SY + SR + 18);
  ctx.restore();
}

// ─── ENDPOINT ─────────────────────────────────────────────────────────────────
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("═══ /generate v49 (hektar-pro) ═══");

  const {
    lead_id, client_name, polygon_points, site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp, setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    slide_name = "slide_4_axo",
    zoom: zoomOverride = null,
    style_ref_url = null, // URL image de référence de style (ex: slide_4_axo_v46_enhanced.png)
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

    // Canvas 1280x1280 sans bande stats
    const W = 1280, H = 1280;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    const mapImg = await loadImage(screenshotBuf);
    ctx.drawImage(mapImg, 0, 0);
    drawLegendCompass(ctx, W, H, { site_area: Number(site_area), bearing });

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

        // Injection image de référence de style si fournie
        if (style_ref_url) {
          try {
            console.log("Fetching style reference: " + style_ref_url);
            const refRes = await fetch(style_ref_url);
            if (refRes.ok) {
              const refBuf = Buffer.from(await refRes.arrayBuffer());
              // Resize en 1024x1024
              const refCanvas = createCanvas(1024, 1024);
              const refCtx = refCanvas.getContext("2d");
              refCtx.drawImage(await loadImage(refBuf), 0, 0, 1024, 1024);
              const refPng = refCanvas.toBuffer("image/png");
              form.append("image", refPng, { filename: "style_ref.png", contentType: "image/png" });
              console.log("Style reference injected (" + refBuf.length + " bytes)");
            }
          } catch (e) { console.warn("Style ref fetch error:", e.message); }
        }
        form.append("size", "1024x1024");
        form.append("input_fidelity", "high"); // préserver la géométrie source
        // v49: prompt CLEAN — pas de grain, pas d'aquarelle, style vectoriel net
        form.append("prompt", "Enhance this axonometric urban planning 3D map into a CLEAN, CRISP architectural illustration.\n\nSTYLE - CRITICAL:\n- CLEAN VECTOR RENDER — NO watercolor, NO grain, NO paper texture, NO artistic filter\n- Sharp flat colors, smooth gradients, clean edges\n- Professional architectural visualization style — like a high-end urban planning presentation\n- Matte finish, no noise, no brush strokes\n\nGEOMETRY - ABSOLUTE CONSTRAINTS:\n- Keep EXACTLY the same camera angle, pitch, bearing and composition\n- Keep EXACTLY the same building footprints, positions and heights\n- Keep EXACTLY the same road network layout and widths\n- Do NOT move, add or remove any building or road\n\nPARCEL ZONE - NON-NEGOTIABLE:\n- There is an OCHRE/SANDY semi-transparent zone on the ground with a red outline\n- DO NOT MOVE, RESIZE or RECOLOR it — it is GPS-fixed\n- The dashed red outline must stay at exact same position\n\nBUILDINGS:\n- Rooftops: flat white #f8f8f8\n- Sunlit faces: white #fafafa\n- Shadow faces: warm gray #aaa8a2\n- EDGES: clean dark lines #333 on all corners and edges — crisp, not sketchy\n- FLOOR LINES: ONLY on the main project building (the one sitting on the ochre/sandy parcel zone), add thin horizontal lines (#ccc8c0, 1px) at each floor level on its facades to mark stories. Space them evenly (~3.2m per floor). Do NOT add floor lines on surrounding environment buildings — those stay clean and smooth.\n- Cast shadows: flat warm gray #bbb8b0, sharp edge\n\nGROUND:\n- Keep the green ground color exactly as-is\n- Add round-canopy trees (dark green #3d7a1a, highlight #5aaa28) along roads and in open spaces\n- Trees should be CLEAN circles with flat shading, no watercolor effect\n- At least 25-30 trees scattered realistically\n\nROADS:\n- Keep sandy beige color exactly as-is\n- Clean flat surface, no grain texture\n\nNo text, no labels, no annotations, no watermarks.");

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

          // Recomposer : enhanced + légende + boussole + arc solaire
          const finalCanvas = createCanvas(W, H);
          const finalCtx = finalCanvas.getContext("2d");
          finalCtx.drawImage(await loadImage(enhancedMapBuf), 0, 0, W, H);
          drawLegendCompass(finalCtx, W, H, { site_area: Number(site_area), bearing });
          drawSolarArc(finalCtx, W, H, { bearing });

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
  console.log(`BARLO v49 (hektar-pro) on port ${PORT}`);
  console.log(`Browserless: ${BROWSERLESS_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Mapbox: ${MAPBOX_TOKEN ? "OK" : "MISSING"}`);
  console.log(`OpenAI: ${OPENAI_API_KEY ? "OK" : "MISSING (enhancement disabled)"}`);
});
