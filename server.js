// ═══════════════════════════════════════════════════════════════════════════════
// BARLO — generate-slide4-axo — Mapbox Static + Overpass + Canvas Isometric 3D
// ═══════════════════════════════════════════════════════════════════════════════
// 1. Mapbox Static API → fond de carte (routes, labels, terrain)
// 2. Overpass API → vrais bâtiments OSM autour de la parcelle
// 3. node-canvas → extrusion isométrique des bâtiments + overlays BARLO
// ═══════════════════════════════════════════════════════════════════════════════

const express = require("express");
const https = require("https");
const http = require("http");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas, loadImage } = require("canvas");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

app.get("/health", (req, res) => res.json({ ok: true, engine: "static-overpass-iso3d" }));

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
    const ml = (coords[i].lat + coords[(i + 1) % coords.length].lat) / 2;
    if (ml > maxLat) { maxLat = ml; rb = brng(coords[i], coords[(i + 1) % coords.length]); }
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

// ─── ZOOM + BEARING ───────────────────────────────────────────────────────────
function computeZoom(coords, cLat, cLon) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const ext = Math.max(
    Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)),
    Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y)), 20
  );
  const targetViewM = ext * 5;
  const mpp = targetViewM / 900;
  const z = Math.log2(156543.03 * Math.cos(cLat * Math.PI / 180) / mpp);
  return Math.min(18, Math.max(15, Math.round(z * 2) / 2));
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
  return Math.round(((angle + 45) % 90) + 15);
}

// ─── FETCH HELPERS ──────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (resp) => {
      if (resp.statusCode === 301 || resp.statusCode === 302) {
        return httpsGet(resp.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      resp.on("data", d => chunks.push(d));
      resp.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (resp.statusCode !== 200) reject(new Error(`HTTP ${resp.statusCode}: ${buf.toString().substring(0, 200)}`));
        else resolve(buf);
      });
      resp.on("error", reject);
    }).on("error", reject);
  });
}
function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname, port: u.port || 443, path: u.pathname,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    };
    const client = url.startsWith("https") ? https : http;
    const req = client.request(options, (resp) => {
      const chunks = [];
      resp.on("data", d => chunks.push(d));
      resp.on("end", () => resolve(Buffer.concat(chunks).toString()));
      resp.on("error", reject);
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── FETCH MAPBOX STATIC IMAGE ──────────────────────────────────────────────
async function fetchMapboxStatic(center, zoom, bearing, w, h, parcelCoords, envCoords) {
  const parcelGeo = {
    type: "Feature",
    properties: { "stroke": "#d02818", "stroke-width": 3, "stroke-opacity": 1, "fill": "#d02818", "fill-opacity": 0.12 },
    geometry: {
      type: "Polygon",
      coordinates: [[...parcelCoords.map(c => [c.lon, c.lat]), [parcelCoords[0].lon, parcelCoords[0].lat]]],
    },
  };
  const envGeo = {
    type: "Feature",
    properties: { "stroke": "#d02818", "stroke-width": 2, "stroke-opacity": 0.5, "fill-opacity": 0 },
    geometry: {
      type: "Polygon",
      coordinates: [[...envCoords.map(c => [c.lon, c.lat]), [envCoords[0].lon, envCoords[0].lat]]],
    },
  };
  const overlay = encodeURIComponent(JSON.stringify({ type: "FeatureCollection", features: [parcelGeo, envGeo] }));
  const url = `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/geojson(${overlay})/${center.lon},${center.lat},${zoom},${bearing}/${w}x${h}@2x?access_token=${MAPBOX_TOKEN}&attribution=false&logo=false`;
  console.log(`Mapbox Static URL: ${url.length} chars`);
  return httpsGet(url);
}

// ─── FETCH REAL BUILDINGS FROM OVERPASS ──────────────────────────────────────
async function fetchBuildings(center, radiusM) {
  const query = `[out:json][timeout:15];(way["building"](around:${radiusM},${center.lat},${center.lon}););out body;>;out skel qt;`;
  console.log(`Overpass query: radius=${radiusM}m around ${center.lat},${center.lon}`);
  try {
    const raw = await httpsPost("https://overpass-api.de/api/interpreter", `data=${encodeURIComponent(query)}`);
    const data = JSON.parse(raw);

    // Build node lookup
    const nodes = {};
    for (const el of data.elements) {
      if (el.type === "node") nodes[el.id] = { lat: el.lat, lon: el.lon };
    }

    // Extract building polygons
    const buildings = [];
    for (const el of data.elements) {
      if (el.type === "way" && el.tags && el.tags.building) {
        const coords = (el.nodes || []).map(nid => nodes[nid]).filter(Boolean);
        if (coords.length >= 3) {
          const levels = parseInt(el.tags["building:levels"]) || 0;
          const height = parseFloat(el.tags.height) || (levels > 0 ? levels * 3 : 4 + Math.random() * 5);
          buildings.push({ coords, height, tags: el.tags });
        }
      }
    }
    console.log(`Overpass: ${buildings.length} buildings found`);
    return buildings;
  } catch (e) {
    console.error("Overpass error:", e.message);
    return [];
  }
}

// ─── ISOMETRIC 3D PROJECTION ────────────────────────────────────────────────
function drawIsoBuildings(ctx, W, H, center, zoom, bearing, buildings, parcelCoords) {
  const mPerPx = 156543.03 * Math.cos(center.lat * Math.PI / 180) / Math.pow(2, zoom) / 2; // @2x
  const cx = W / 2, cy = H / 2;
  const bearingRad = -bearing * Math.PI / 180;

  // Isometric offset: how many pixels "up" per meter of building height
  const heightScale = 1.2 / mPerPx; // ~1.2m real height per pixel offset

  function geoToPx(lat, lon) {
    const dx = (lon - center.lon) * Math.PI / 180 * R_EARTH * Math.cos(center.lat * Math.PI / 180);
    const dy = (lat - center.lat) * Math.PI / 180 * R_EARTH;
    const rx = dx * Math.cos(bearingRad) - dy * Math.sin(bearingRad);
    const ry = dx * Math.sin(bearingRad) + dy * Math.cos(bearingRad);
    return { x: cx + rx / mPerPx, y: cy - ry / mPerPx };
  }

  // Check if point is inside parcel (to avoid drawing buildings on parcel)
  const parcelPx = parcelCoords.map(c => geoToPx(c.lat, c.lon));
  function inParcel(px, py) {
    let inside = false;
    for (let i = 0, j = parcelPx.length - 1; i < parcelPx.length; j = i++) {
      const xi = parcelPx[i].x, yi = parcelPx[i].y, xj = parcelPx[j].x, yj = parcelPx[j].y;
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Convert buildings to pixel coords and sort back-to-front
  const buildingPx = buildings.map(b => {
    const footprint = b.coords.map(c => geoToPx(c.lat, c.lon));
    const centroid = {
      x: footprint.reduce((s, p) => s + p.x, 0) / footprint.length,
      y: footprint.reduce((s, p) => s + p.y, 0) / footprint.length,
    };
    return { footprint, height: b.height, centroid };
  }).filter(b => {
    // Filter out buildings whose centroid is inside parcel
    return !inParcel(b.centroid.x, b.centroid.y);
  }).filter(b => {
    // Filter out buildings completely outside viewport
    return b.footprint.some(p => p.x > -50 && p.x < W + 50 && p.y > -50 && p.y < H + 50);
  });

  // Sort by Y (back to front) so nearer buildings overlap farther ones
  buildingPx.sort((a, b) => a.centroid.y - b.centroid.y);

  const colors = {
    top: "#f2eeE8",
    front: "#ddd8cf",
    side: "#cac4ba",
    stroke: "#b5afa5",
  };

  for (const b of buildingPx) {
    const hPx = b.height * heightScale;
    const fp = b.footprint;

    // Draw side faces (for edges where the "front" is visible)
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = 0.5;

    // Draw right/front side walls
    for (let i = 0; i < fp.length; i++) {
      const j = (i + 1) % fp.length;
      const p1 = fp[i], p2 = fp[j];

      // Only draw walls that face "forward" (positive y direction = toward viewer)
      const nx = -(p2.y - p1.y);
      const ny = p2.x - p1.x;

      if (ny > 0 || nx > 0) {
        // Front-facing wall
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p2.x, p2.y - hPx);
        ctx.lineTo(p1.x, p1.y - hPx);
        ctx.closePath();
        ctx.fillStyle = nx > 0 ? colors.side : colors.front;
        ctx.fill();
        ctx.stroke();
      }
    }

    // Draw roof (top face)
    ctx.beginPath();
    ctx.moveTo(fp[0].x, fp[0].y - hPx);
    for (let i = 1; i < fp.length; i++) {
      ctx.lineTo(fp[i].x, fp[i].y - hPx);
    }
    ctx.closePath();
    ctx.fillStyle = colors.top;
    ctx.fill();
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  return buildingPx.length;
}

// ─── DRAW OVERLAYS ──────────────────────────────────────────────────────────
function drawOverlays(ctx, W, H, BH, p) {
  const {
    site_area, land_width, land_depth, buildable_fp,
    setback_front, setback_side, setback_back,
    city, district, zoning, terrain_context, bearing, buildingCount,
  } = p;

  function T(x, y, txt, color, size, bold = false, anchor = "center") {
    ctx.font = `${bold ? "700" : "500"} ${size}px Arial`;
    ctx.textAlign = anchor;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = size > 14 ? 5 : 3.5;
    ctx.lineJoin = "round";
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y);
  }

  const cx = W / 2, cy = H / 2 + H * 0.04;
  T(cx, cy - 50, "Accès principal ↓", "#d02818", 20, true);
  T(cx, cy - 10, "Enveloppe constructible", "#d02818", 16);
  T(cx, cy + 24, `${buildable_fp} m²`, "#1d7a3e", 28, true);
  T(cx, cy + 52, `${site_area} m² · ${land_width}×${land_depth}m`, "#555", 14);

  T(cx, cy - 100, `↕ Recul avant : ${setback_front}m`, "#d02818", 14, true);
  T(cx - W * 0.20, cy + 10, `↔ ${setback_side}m`, "#666", 13);
  T(cx + W * 0.20, cy + 10, `↔ ${setback_side}m`, "#666", 13);
  T(cx, cy + 90, `↕ Recul arrière : ${setback_back}m`, "#666", 13);

  // Compass
  ctx.save();
  ctx.translate(W - 60, 60);
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fill();
  ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.rotate(-(bearing || 30) * Math.PI / 180);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -2); ctx.lineTo(0, -8); ctx.lineTo(5, -2); ctx.closePath();
  ctx.fillStyle = "#d02818"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 2); ctx.lineTo(0, 8); ctx.lineTo(5, 2); ctx.closePath();
  ctx.fillStyle = "#bbb"; ctx.fill();
  ctx.font = "bold 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#d02818";
  ctx.fillText("N", 0, -22);
  ctx.restore();

  // Legend
  const legItems = [
    { type: "rect", fill: "rgba(208,40,24,0.12)", stroke: "#d02818", label: `Parcelle — ${site_area} m²` },
    { type: "line", stroke: "#d02818", opacity: 0.55, label: "Enveloppe constructible" },
    { type: "rect", fill: "#f2eee8", stroke: "#b5afa5", label: `Bâtiments voisinage (${buildingCount})` },
    { type: "line", stroke: "#b0a080", opacity: 1, label: "Voirie" },
  ];
  const legW = 300, legH = 22 + legItems.length * 30 + 16;
  ctx.shadowColor = "rgba(0,0,0,0.08)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.beginPath(); ctx.roundRect(16, 16, legW, legH, 10); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.strokeStyle = "#e8e5e0"; ctx.lineWidth = 1.5; ctx.stroke();

  legItems.forEach((item, i) => {
    const iy = 16 + 20 + i * 30;
    if (item.type === "rect") {
      ctx.fillStyle = item.fill;
      ctx.beginPath(); ctx.roundRect(30, iy, 18, 14, 3); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(30, iy + 7); ctx.lineTo(48, iy + 7);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2.5;
      ctx.globalAlpha = item.opacity || 1; ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.font = "13px Arial"; ctx.fillStyle = "#444"; ctx.textAlign = "left";
    ctx.fillText(item.label, 58, iy + 13);
  });
  ctx.font = "9px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© Mapbox © OpenStreetMap", 30, 16 + legH - 8);

  // Stats bar
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

  ctx.font = "10px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Surface parcelle", C1, BY + 90);
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
// ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("→ /generate (Static + Overpass + Iso3D)");

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

  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
  if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });

  const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
  const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
  console.log(`Centroïde: ${cLat.toFixed(6)}, ${cLon.toFixed(6)}`);

  const envelopeCoords = computeEnvelope(
    coords, cLat, cLon,
    Number(setback_front), Number(setback_side), Number(setback_back)
  );

  const zoom = computeZoom(coords, cLat, cLon);
  const bearing = computeBearing(coords, cLat, cLon);
  console.log(`View: zoom=${zoom}, bearing=${bearing}°`);

  try {
    // ── 1. FETCH BASE MAP + BUILDINGS IN PARALLEL ──────────────────────────
    const mapW = Math.min(Number(image_size) || 900, 1280);
    const mapH = mapW;

    console.log("Fetching base map + buildings in parallel...");
    const [mapBuffer, buildings] = await Promise.all([
      fetchMapboxStatic({ lat: cLat, lon: cLon }, zoom, bearing, mapW, mapH, coords, envelopeCoords),
      fetchBuildings({ lat: cLat, lon: cLon }, 300), // 300m radius
    ]);
    console.log(`Base map: ${mapBuffer.length} bytes, Buildings: ${buildings.length} (${Date.now() - t0}ms)`);

    // ── 2. COMPOSITE ────────────────────────────────────────────────────────
    const baseImg = await loadImage(mapBuffer);
    const W = baseImg.width;   // @2x → 1800 or 2560
    const H = baseImg.height;
    const BH = Math.round(H * 0.12);

    const canvas = createCanvas(W, H + BH);
    const ctx = canvas.getContext("2d");

    // Draw base map (roads, labels, parcel/envelope overlay)
    ctx.drawImage(baseImg, 0, 0);

    // Draw real 3D buildings from OSM
    const buildingCount = drawIsoBuildings(ctx, W, H, { lat: cLat, lon: cLon }, zoom, bearing, buildings, coords);
    console.log(`Drew ${buildingCount} buildings on canvas (${Date.now() - t0}ms)`);

    // Draw overlays (annotations, legend, compass, stats bar)
    drawOverlays(ctx, W, H, BH, {
      site_area: Number(site_area), land_width: Number(land_width),
      land_depth: Number(land_depth), buildable_fp: Number(buildable_fp),
      setback_front: Number(setback_front), setback_side: Number(setback_side),
      setback_back: Number(setback_back),
      city: city || "", district: district || "", zoning: zoning || "",
      terrain_context: terrain_context || "", bearing, buildingCount,
    });

    const png = canvas.toBuffer("image/png");
    console.log(`Final PNG: ${png.length} bytes, ${W}x${H + BH} (${Date.now() - t0}ms)`);

    // ── 3. UPLOAD TO SUPABASE ─────────────────────────────────────────────
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const slug = String(client_name || "client").toLowerCase().trim()
      .replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const path = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;

    const { error: ue } = await sb.storage.from("massing-images").upload(path, png, {
      contentType: "image/png", upsert: true,
    });
    if (ue) return res.status(500).json({ error: ue.message });

    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(path);
    console.log(`Done: ${pd.publicUrl} (${Date.now() - t0}ms)`);

    return res.json({
      ok: true, public_url: pd.publicUrl, path,
      centroid: { lat: cLat, lon: cLon },
      view: { zoom, bearing },
      buildings_count: buildingCount,
      engine: "static-overpass-iso3d",
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error("Error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`BARLO Axo Service on port ${PORT}`);
  console.log(`Engine: Mapbox Static + Overpass + Canvas Isometric 3D`);
  console.log(`Mapbox: ${MAPBOX_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Supabase: ${SUPABASE_URL ? "OK" : "MISSING"}`);
});
