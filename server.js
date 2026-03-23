// ═══════════════════════════════════════════════════════════════════════════════
// BARLO — generate-slide4-axo — Mapbox Static API + Canvas Overlays
// ═══════════════════════════════════════════════════════════════════════════════
// Strategy:
//   1. Mapbox Static Images API with pitch=55° + bearing → real 3D buildings,
//      real roads, professional cartography. No synthetic data needed.
//   2. GeoJSON overlay in the URL → parcel + envelope drawn by Mapbox itself
//      (perfect geo-alignment, no projection math needed).
//   3. node-canvas overlays on top → legend, compass, annotations, stats bar.
//   4. Upload to Supabase → same contract as before for Make.com.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas, loadImage } = require("canvas");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

app.get("/health", (req, res) => res.json({ ok: true, engine: "mapbox-static" }));

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

// ─── COMPUTE OPTIMAL ZOOM from parcel size ────────────────────────────────────
function computeZoom(coords, cLat, cLon) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const extX = Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x));
  const extY = Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y));
  const parcelExtent = Math.max(extX, extY, 20);
  // View should span ~5x parcel for good urban context
  const targetViewM = parcelExtent * 5;
  const logicalWidth = 900;
  const metersPerPixel = targetViewM / logicalWidth;
  const zoom = Math.log2(156543.03 * Math.cos(cLat * Math.PI / 180) / metersPerPixel);
  return Math.min(19, Math.max(15, Math.round(zoom * 2) / 2));
}

// ─── COMPUTE BEARING from parcel orientation ──────────────────────────────────
function computeBearing(coords, cLat, cLon) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  let longest = 0, angle = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > longest) { longest = len; angle = Math.atan2(dx, dy) * 180 / Math.PI; }
  }
  // Offset for nice 3D axo feel
  const base = ((angle + 45) % 90) + 15;
  return Math.round(base);
}

// ─── BUILD MAPBOX STATIC API URL ──────────────────────────────────────────────
function buildMapboxUrl(cLat, cLon, zoom, bearing, pitch, coords, envCoords, w, h) {
  const geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          "stroke": "#d02818",
          "stroke-width": 3,
          "stroke-opacity": 1,
          "fill": "#d02818",
          "fill-opacity": 0.12,
        },
        geometry: {
          type: "Polygon",
          coordinates: [[
            ...coords.map(c => [Math.round(c.lon * 1e6) / 1e6, Math.round(c.lat * 1e6) / 1e6]),
            [Math.round(coords[0].lon * 1e6) / 1e6, Math.round(coords[0].lat * 1e6) / 1e6],
          ]],
        },
      },
      {
        type: "Feature",
        properties: {
          "stroke": "#d02818",
          "stroke-width": 2,
          "stroke-opacity": 0.55,
          "fill-opacity": 0,
        },
        geometry: {
          type: "Polygon",
          coordinates: [[
            ...envCoords.map(c => [Math.round(c.lon * 1e6) / 1e6, Math.round(c.lat * 1e6) / 1e6]),
            [Math.round(envCoords[0].lon * 1e6) / 1e6, Math.round(envCoords[0].lat * 1e6) / 1e6],
          ]],
        },
      },
    ],
  };

  const overlay = `geojson(${encodeURIComponent(JSON.stringify(geojson))})`;
  // streets-v12 has built-in fill-extrusion for 3D buildings at zoom 15+
  // If you upload a custom style later, replace this with "archibarlou/YOUR_STYLE_ID"
  const STYLE = "mapbox/streets-v12";
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlay}/${cLon.toFixed(6)},${cLat.toFixed(6)},${zoom},${bearing},${pitch}/${w}x${h}@2x?access_token=${MAPBOX_TOKEN}&logo=false&attribution=false`;

  console.log(`Mapbox URL length: ${url.length} chars`);
  if (url.length > 8192) {
    console.warn("URL too long — falling back to no GeoJSON overlay");
    return `https://api.mapbox.com/styles/v1/${STYLE}/static/${cLon.toFixed(6)},${cLat.toFixed(6)},${zoom},${bearing},${pitch}/${w}x${h}@2x?access_token=${MAPBOX_TOKEN}&logo=false&attribution=false`;
  }
  return url;
}

// ─── DRAW CANVAS OVERLAYS ─────────────────────────────────────────────────────
function drawOverlays(ctx, W, H, BH, p) {
  const {
    site_area, land_width, land_depth, buildable_fp,
    setback_front, setback_side, setback_back,
    city, district, zoning, terrain_context, bearing,
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

  // ── CENTRAL LABELS ─────────────────────────────────────────────────────────
  const cx = W / 2, cy = H / 2 + H * 0.04;
  T(cx, cy - 50, "Accès principal ↓", "#d02818", 24, true);
  T(cx, cy + 10, "Enveloppe constructible", "#d02818", 20);
  T(cx, cy + 50, `${buildable_fp} m²`, "#1d7a3e", 32, true);
  T(cx, cy + 82, `${site_area} m² · ${land_width}×${land_depth}m`, "#555", 18);

  // ── SETBACK ANNOTATIONS ────────────────────────────────────────────────────
  T(cx, cy - 120, `↕ Recul avant : ${setback_front}m`, "#d02818", 18, true);
  T(cx - W * 0.18, cy + 20, `↔ ${setback_side}m`, "#666", 16);
  T(cx + W * 0.18, cy + 20, `↔ ${setback_side}m`, "#666", 16);
  T(cx, cy + 140, `↕ Recul arrière : ${setback_back}m`, "#666", 16);

  // ── COMPASS ────────────────────────────────────────────────────────────────
  ctx.save();
  ctx.translate(W - 80, 80);
  ctx.beginPath(); ctx.arc(0, 0, 36, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fill();
  ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.rotate(-(bearing || 30) * Math.PI / 180);
  ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(-7, -3); ctx.lineTo(0, -10); ctx.lineTo(7, -3); ctx.closePath();
  ctx.fillStyle = "#d02818"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 24); ctx.lineTo(-7, 3); ctx.lineTo(0, 10); ctx.lineTo(7, 3); ctx.closePath();
  ctx.fillStyle = "#bbb"; ctx.fill();
  ctx.font = "bold 16px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#d02818";
  ctx.fillText("N", 0, -30);
  ctx.restore();

  // ── LEGEND ─────────────────────────────────────────────────────────────────
  const legItems = [
    { type: "rect", fill: "rgba(208,40,24,0.12)", stroke: "#d02818", label: `Parcelle — ${site_area} m²` },
    { type: "line", stroke: "#d02818", opacity: 0.55, label: "Enveloppe constructible" },
    { type: "rect", fill: "#e8e6e2", stroke: "#ccc", label: "Bâtiments (Mapbox 3D)" },
    { type: "line", stroke: "#b0a080", opacity: 1, label: "Voirie" },
  ];
  const legW = 380, legH = 24 + legItems.length * 40 + 20;

  ctx.shadowColor = "rgba(0,0,0,0.08)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.beginPath(); ctx.roundRect(20, 20, legW, legH, 12); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.strokeStyle = "#e8e5e0"; ctx.lineWidth = 1.5; ctx.stroke();

  legItems.forEach((item, i) => {
    const iy = 20 + 24 + i * 40;
    if (item.type === "rect") {
      ctx.fillStyle = item.fill;
      ctx.beginPath(); ctx.roundRect(36, iy, 22, 18, 3); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(36, iy + 9); ctx.lineTo(58, iy + 9);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 3;
      ctx.globalAlpha = item.opacity || 1; ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.font = "16px Arial"; ctx.fillStyle = "#444"; ctx.textAlign = "left";
    ctx.fillText(item.label, 72, iy + 15);
  });
  ctx.font = "11px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© Mapbox © OpenStreetMap", 36, 20 + legH - 10);

  // ── STATS BAR ──────────────────────────────────────────────────────────────
  const BY = H, pad = 40;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, BY, W, BH);
  ctx.beginPath(); ctx.moveTo(0, BY); ctx.lineTo(W, BY);
  ctx.strokeStyle = "#d02818"; ctx.lineWidth = 5; ctx.stroke();

  const C1 = pad, C2 = W * 0.25, C3 = W * 0.50, C4 = W * 0.72;
  ctx.textAlign = "left";
  ctx.font = "bold 28px Arial"; ctx.fillStyle = "#111";
  ctx.fillText("Lecture stratégique du site", C1, BY + 50);
  ctx.font = "15px Arial"; ctx.fillStyle = "#aaa";
  ctx.fillText(`${city} · ${district} · Zoning : ${zoning}`, C1, BY + 78);

  ctx.beginPath(); ctx.moveTo(C1, BY + 96); ctx.lineTo(W - pad, BY + 96);
  ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1.5; ctx.stroke();

  ctx.font = "12px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Surface parcelle", C1, BY + 122);
  ctx.font = "bold 36px Arial"; ctx.fillStyle = "#111"; ctx.fillText(`${site_area} m²`, C1, BY + 162);

  ctx.font = "12px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Dimensions", C2, BY + 122);
  ctx.font = "bold 28px Arial"; ctx.fillStyle = "#111"; ctx.fillText(`${land_width}m × ${land_depth}m`, C2, BY + 162);

  ctx.font = "12px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Empreinte constructible", C3, BY + 122);
  ctx.font = "bold 36px Arial"; ctx.fillStyle = "#1d7a3e"; ctx.fillText(`${buildable_fp} m²`, C3, BY + 162);

  ctx.font = "12px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Retraits réglementaires", C4, BY + 122);
  ctx.font = "600 16px Arial"; ctx.fillStyle = "#333";
  ctx.fillText(`Avant : ${setback_front}m · Côtés : ${setback_side}m`, C4, BY + 148);
  ctx.fillText(`Arrière : ${setback_back}m`, C4, BY + 172);

  ctx.beginPath(); ctx.moveTo(C1, BY + 192); ctx.lineTo(W - pad, BY + 192);
  ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = "13px Arial"; ctx.fillStyle = "#ccc";
  ctx.fillText((terrain_context || "").substring(0, 100), C1, BY + 220);
  ctx.textAlign = "right"; ctx.font = "11px Arial"; ctx.fillStyle = "#ddd";
  ctx.fillText("BARLO · Diagnostic foncier automatisé", W - pad, BY + BH - 16);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINT — same Make.com contract
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("→ /generate (Mapbox Static)");

  const {
    lead_id, client_name, polygon_points, site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp, setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    image_size = 900, slide_name = "slide_4_axo",
  } = req.body;

  if (!lead_id || !polygon_points)
    return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });
  if (!MAPBOX_TOKEN)
    return res.status(500).json({ error: "MAPBOX_TOKEN non configuré sur Railway" });

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
  const pitch = 55;
  console.log(`View: zoom=${zoom}, bearing=${bearing}°, pitch=${pitch}°`);

  try {
    const mapW = 900, mapH = 900;
    const mapboxUrl = buildMapboxUrl(cLat, cLon, zoom, bearing, pitch, coords, envelopeCoords, mapW, mapH);
    console.log("Fetching Mapbox image...");

    const mbResp = await fetch(mapboxUrl, { signal: AbortSignal.timeout(15000) });
    if (!mbResp.ok) {
      const errText = await mbResp.text();
      console.error(`Mapbox error ${mbResp.status}: ${errText}`);
      return res.status(502).json({ error: `Mapbox API error: ${mbResp.status}`, detail: errText });
    }

    const imgBuffer = Buffer.from(await mbResp.arrayBuffer());
    console.log(`Mapbox image: ${imgBuffer.length} bytes`);

    const mapImg = await loadImage(imgBuffer);
    const W = mapImg.width;   // 1800 (@2x)
    const H = mapImg.height;  // 1800 (@2x)
    const BH = 260;

    const canvas = createCanvas(W, H + BH);
    const ctx = canvas.getContext("2d");

    // Base map
    ctx.drawImage(mapImg, 0, 0);

    // Overlays
    drawOverlays(ctx, W, H, BH, {
      site_area: Number(site_area), land_width: Number(land_width),
      land_depth: Number(land_depth), buildable_fp: Number(buildable_fp),
      setback_front: Number(setback_front), setback_side: Number(setback_side),
      setback_back: Number(setback_back),
      city: city || "", district: district || "", zoning: zoning || "",
      terrain_context: terrain_context || "", bearing,
    });

    const png = canvas.toBuffer("image/png");
    console.log(`Final PNG: ${png.length} bytes (${Date.now() - t0}ms)`);

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
      ok: true,
      public_url: pd.publicUrl,
      path,
      centroid: { lat: cLat, lon: cLon },
      view: { zoom, bearing, pitch },
      engine: "mapbox-static",
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error("Error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`BARLO Axo Service on port ${PORT}`);
  console.log(`Engine: Mapbox Static API`);
  console.log(`Mapbox: ${MAPBOX_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Supabase: ${SUPABASE_URL ? "OK" : "MISSING"}`);
});
