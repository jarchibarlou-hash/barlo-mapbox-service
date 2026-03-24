// ═══════════════════════════════════════════════════════════════════════════════
// BARLO — slide_4_axo — OSM Raster Tiles + Overpass + Canvas Isometric 3D
// ═══════════════════════════════════════════════════════════════════════════════
// 1. OpenStreetMap raster tiles → fond de carte (routes, labels, terrain)
//    → Simples PNG via HTTP, AUCUNE clé API, fonctionne toujours
// 2. Overpass API (GET) → vrais bâtiments OSM autour de la parcelle
// 3. node-canvas → extrusion isométrique 3D + overlays BARLO
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

app.get("/health", (req, res) => res.json({ ok: true, engine: "osm-tiles-overpass-iso3d", version: "7.0" }));

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

// ─── ZOOM CALCULATION ────────────────────────────────────────────────────────
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

// ─── HTTP FETCH (supports redirects, custom headers) ─────────────────────────
function httpFetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        "User-Agent": "BARLO-AxoService/7.0 (diagnostic-foncier; contact@barlo.app)",
        ...headers,
      },
    };
    const client = isHttps ? https : http;
    client.request(options, (resp) => {
      if (resp.statusCode === 301 || resp.statusCode === 302) {
        return httpFetch(resp.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      resp.on("data", d => chunks.push(d));
      resp.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (resp.statusCode !== 200) {
          reject(new Error(`HTTP ${resp.statusCode} from ${u.hostname}: ${buf.toString().substring(0, 200)}`));
        } else {
          resolve(buf);
        }
      });
      resp.on("error", reject);
    }).on("error", reject).end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// OSM RASTER TILES — guaranteed to work, no API key needed
// ═══════════════════════════════════════════════════════════════════════════════

const TILE_SIZE = 256;

// Convert lon/lat to fractional tile coordinates
function lon2tileF(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
function lat2tileF(lat, z) {
  const latRad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, z);
}

// Fetch a single OSM tile
async function fetchTile(tx, ty, z) {
  // Use multiple tile servers for reliability (OSM round-robin)
  const servers = ["a", "b", "c"];
  const s = servers[(tx + ty) % 3];
  const url = `https://${s}.tile.openstreetmap.org/${z}/${tx}/${ty}.png`;
  return httpFetch(url);
}

// Fetch and stitch tiles into a canvas of size WxH centered on (lat,lon) at zoom
async function fetchTileCanvas(center, zoom, W, H) {
  // Integer zoom for tiles
  const z = Math.floor(zoom);

  // Center tile coordinates (fractional)
  const cTileX = lon2tileF(center.lon, z);
  const cTileY = lat2tileF(center.lat, z);

  // How many tiles we need to cover the canvas
  const halfTilesX = Math.ceil(W / TILE_SIZE / 2) + 1;
  const halfTilesY = Math.ceil(H / TILE_SIZE / 2) + 1;

  const startTX = Math.floor(cTileX) - halfTilesX;
  const endTX = Math.floor(cTileX) + halfTilesX;
  const startTY = Math.floor(cTileY) - halfTilesY;
  const endTY = Math.floor(cTileY) + halfTilesY;

  // Pixel offset: where does the center tile start on our canvas?
  // Center of canvas (W/2, H/2) = center of the fractional tile position
  const originPxX = W / 2 - (cTileX - startTX) * TILE_SIZE;
  const originPxY = H / 2 - (cTileY - startTY) * TILE_SIZE;

  // Fetch all tiles in parallel
  const tilesToFetch = [];
  for (let ty = startTY; ty <= endTY; ty++) {
    for (let tx = startTX; tx <= endTX; tx++) {
      // Wrap tile X around the world
      const maxTile = Math.pow(2, z);
      const wrappedTX = ((tx % maxTile) + maxTile) % maxTile;
      if (ty < 0 || ty >= maxTile) continue; // skip invalid Y tiles
      tilesToFetch.push({
        tx: wrappedTX, ty, z,
        canvasX: originPxX + (tx - startTX) * TILE_SIZE,
        canvasY: originPxY + (ty - startTY) * TILE_SIZE,
      });
    }
  }

  console.log(`Fetching ${tilesToFetch.length} OSM tiles at zoom ${z}...`);

  // Fetch tiles with concurrency limit (max 6 parallel)
  const tileImages = [];
  const BATCH = 6;
  for (let i = 0; i < tilesToFetch.length; i += BATCH) {
    const batch = tilesToFetch.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (t) => {
        try {
          const buf = await fetchTile(t.tx, t.ty, t.z);
          const img = await loadImage(buf);
          return { ...t, img };
        } catch (e) {
          console.warn(`Tile ${t.z}/${t.tx}/${t.ty} failed: ${e.message}`);
          return { ...t, img: null };
        }
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.img) {
        tileImages.push(r.value);
      }
    }
  }

  console.log(`Got ${tileImages.length}/${tilesToFetch.length} tiles`);

  // Create canvas and draw tiles
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Fill background (in case some tiles fail)
  ctx.fillStyle = "#f2efe9";
  ctx.fillRect(0, 0, W, H);

  // Draw each tile
  for (const t of tileImages) {
    ctx.drawImage(t.img, Math.round(t.canvasX), Math.round(t.canvasY), TILE_SIZE, TILE_SIZE);
  }

  return canvas;
}

// ─── GEO → PIXEL PROJECTION (matches OSM tile math exactly) ────────────────
function createTileProjection(center, zoom, W, H) {
  const z = Math.floor(zoom);
  const scale = Math.pow(2, z) * TILE_SIZE; // total pixels for the world at this zoom

  // Center in world pixel coordinates
  const cPixelX = (center.lon + 180) / 360 * scale;
  const cLatRad = center.lat * Math.PI / 180;
  const cPixelY = (1 - Math.log(Math.tan(cLatRad) + 1 / Math.cos(cLatRad)) / Math.PI) / 2 * scale;

  return function geoToPx(lat, lon) {
    const px = (lon + 180) / 360 * scale;
    const latRad = lat * Math.PI / 180;
    const py = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * scale;
    return {
      x: W / 2 + (px - cPixelX),
      y: H / 2 + (py - cPixelY),
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERPASS — real OSM buildings (GET method + fallback servers)
// ═══════════════════════════════════════════════════════════════════════════════
async function fetchBuildings(center, radiusM) {
  const query = `[out:json][timeout:15];(way["building"](around:${radiusM},${center.lat},${center.lon}););out body;>;out skel qt;`;
  console.log(`Overpass: radius=${radiusM}m around ${center.lat.toFixed(5)},${center.lon.toFixed(5)}`);

  const servers = [
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
    `https://overpass.kumi.systems/api/interpreter?data=${encodeURIComponent(query)}`,
    `https://maps.mail.ru/osm/tools/overpass/api/interpreter?data=${encodeURIComponent(query)}`,
  ];

  for (const url of servers) {
    try {
      console.log(`  Trying: ${new URL(url).hostname}...`);
      const buf = await httpFetch(url);
      const txt = buf.toString();
      if (txt.startsWith("<") || txt.startsWith("<!")) {
        console.warn(`  → returned HTML/XML, skipping`);
        continue;
      }
      const data = JSON.parse(txt);

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
      console.log(`  → ${buildings.length} buildings found`);
      return buildings;
    } catch (e) {
      console.warn(`  → failed: ${e.message}`);
    }
  }

  console.error("All Overpass servers failed — 0 buildings");
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRAWING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function drawParcelAndEnvelope(ctx, geoToPx, parcelCoords, envCoords) {
  // Draw envelope (dashed line)
  ctx.save();
  ctx.strokeStyle = "#d02818";
  ctx.lineWidth = 2.5;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([10, 5]);
  ctx.beginPath();
  const envPx = envCoords.map(c => geoToPx(c.lat, c.lon));
  ctx.moveTo(envPx[0].x, envPx[0].y);
  for (let i = 1; i < envPx.length; i++) ctx.lineTo(envPx[i].x, envPx[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  // Draw parcel (filled + solid outline)
  ctx.save();
  ctx.fillStyle = "rgba(208, 40, 24, 0.15)";
  ctx.strokeStyle = "#d02818";
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  const parcelPx = parcelCoords.map(c => geoToPx(c.lat, c.lon));
  ctx.moveTo(parcelPx[0].x, parcelPx[0].y);
  for (let i = 1; i < parcelPx.length; i++) ctx.lineTo(parcelPx[i].x, parcelPx[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  console.log(`Parcel px: (${parcelPx[0].x.toFixed(0)}, ${parcelPx[0].y.toFixed(0)}) to (${parcelPx[2] ? parcelPx[2].x.toFixed(0) : "?"}, ${parcelPx[2] ? parcelPx[2].y.toFixed(0) : "?"})`);
  return parcelPx;
}

function drawIsoBuildings(ctx, W, H, center, zoom, buildings, parcelCoords, geoToPx) {
  const z = Math.floor(zoom);
  const mPerPx = 156543.03 * Math.cos(center.lat * Math.PI / 180) / Math.pow(2, z);
  const heightScale = 1.0 / mPerPx;

  // Parcel hit-test
  const parcelPx = parcelCoords.map(c => geoToPx(c.lat, c.lon));
  function inParcel(px, py) {
    let inside = false;
    for (let i = 0, j = parcelPx.length - 1; i < parcelPx.length; j = i++) {
      const xi = parcelPx[i].x, yi = parcelPx[i].y, xj = parcelPx[j].x, yj = parcelPx[j].y;
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  const buildingPx = buildings.map(b => {
    const footprint = b.coords.map(c => geoToPx(c.lat, c.lon));
    const centroid = {
      x: footprint.reduce((s, p) => s + p.x, 0) / footprint.length,
      y: footprint.reduce((s, p) => s + p.y, 0) / footprint.length,
    };
    return { footprint, height: b.height, centroid };
  }).filter(b => !inParcel(b.centroid.x, b.centroid.y))
    .filter(b => b.footprint.some(p => p.x > -50 && p.x < W + 50 && p.y > -50 && p.y < H + 50));

  // Sort back-to-front
  buildingPx.sort((a, b) => a.centroid.y - b.centroid.y);

  const colors = {
    top: "#f0ece4",
    front: "#dbd6cc",
    side: "#c8c2b8",
    stroke: "#b0aa9e",
  };

  for (const b of buildingPx) {
    const hPx = b.height * heightScale;
    const fp = b.footprint;

    // Draw visible walls
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < fp.length; i++) {
      const j = (i + 1) % fp.length;
      const p1 = fp[i], p2 = fp[j];
      const nx = -(p2.y - p1.y);
      const ny = p2.x - p1.x;
      if (ny > 0 || nx > 0) {
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

    // Draw roof
    ctx.beginPath();
    ctx.moveTo(fp[0].x, fp[0].y - hPx);
    for (let i = 1; i < fp.length; i++) ctx.lineTo(fp[i].x, fp[i].y - hPx);
    ctx.closePath();
    ctx.fillStyle = colors.top;
    ctx.fill();
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  console.log(`Drew ${buildingPx.length} iso buildings (${buildings.length} total from Overpass)`);
  return buildingPx.length;
}

function drawOverlays(ctx, W, H, BH, p) {
  const {
    site_area, land_width, land_depth, buildable_fp,
    setback_front, setback_side, setback_back,
    city, district, zoning, terrain_context, buildingCount,
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

  const cx = W / 2, cy = H / 2 + H * 0.04;
  T(cx, cy - 50, "Accès principal ↓", "#d02818", 20, true);
  T(cx, cy - 10, "Enveloppe constructible", "#d02818", 16);
  T(cx, cy + 24, `${buildable_fp} m²`, "#1d7a3e", 28, true);
  T(cx, cy + 52, `${site_area} m² · ${land_width}×${land_depth}m`, "#555", 14);
  T(cx, cy - 100, `↕ Recul avant : ${setback_front}m`, "#d02818", 14, true);
  T(cx - W * 0.20, cy + 10, `↔ ${setback_side}m`, "#666", 13);
  T(cx + W * 0.20, cy + 10, `↔ ${setback_side}m`, "#666", 13);
  T(cx, cy + 90, `↕ Recul arrière : ${setback_back}m`, "#666", 13);

  // ─── Compass (north-up) ──────────────────────
  ctx.save();
  ctx.translate(W - 60, 60);
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fill();
  ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1.5; ctx.stroke();
  // No rotation — always north-up
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -2); ctx.lineTo(0, -8); ctx.lineTo(5, -2); ctx.closePath();
  ctx.fillStyle = "#d02818"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 2); ctx.lineTo(0, 8); ctx.lineTo(5, 2); ctx.closePath();
  ctx.fillStyle = "#bbb"; ctx.fill();
  ctx.font = "bold 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#d02818";
  ctx.fillText("N", 0, -22);
  ctx.restore();

  // ─── Legend ──────────────────────────────────
  const legItems = [
    { type: "rect", fill: "rgba(208,40,24,0.15)", stroke: "#d02818", label: `Parcelle — ${site_area} m²` },
    { type: "line", stroke: "#d02818", dash: true, label: "Enveloppe constructible" },
    { type: "rect", fill: "#f0ece4", stroke: "#b0aa9e", label: `Bâtiments 3D (${buildingCount})` },
    { type: "line", stroke: "#999", label: "Voirie OSM" },
  ];
  const legW = 290, legH = 22 + legItems.length * 30 + 16;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.08)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.beginPath(); ctx.roundRect(16, 16, legW, legH, 10); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.strokeStyle = "#e8e5e0"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();

  legItems.forEach((item, i) => {
    const iy = 16 + 20 + i * 30;
    if (item.type === "rect") {
      ctx.fillStyle = item.fill;
      ctx.beginPath(); ctx.roundRect(30, iy, 18, 14, 3); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(30, iy + 7); ctx.lineTo(48, iy + 7);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2.5;
      if (item.dash) ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = "13px Arial"; ctx.fillStyle = "#444"; ctx.textAlign = "left";
    ctx.fillText(item.label, 58, iy + 13);
  });
  ctx.font = "9px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© OpenStreetMap contributors", 30, 16 + legH - 8);

  // ─── Stats bar ──────────────────────────────
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
  console.log("═══ /generate (OSM Tiles + Overpass + Iso3D) ═══");

  const {
    lead_id, client_name, polygon_points, site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp, setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    image_size = 900, slide_name = "slide_4_axo",
  } = req.body;

  if (!lead_id || !polygon_points)
    return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });

  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
  if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });

  const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
  const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
  console.log(`Centre: ${cLat.toFixed(6)}, ${cLon.toFixed(6)}`);

  const envelopeCoords = computeEnvelope(
    coords, cLat, cLon,
    Number(setback_front), Number(setback_side), Number(setback_back)
  );

  const zoom = computeZoom(coords, cLat, cLon);
  console.log(`Zoom: ${zoom}`);

  try {
    const W = 1280;
    const H = 1280;
    const BH = Math.round(H * 0.12); // stats bar height

    // ── 1. FETCH TILES + BUILDINGS IN PARALLEL ─────────────────────────────
    console.log("Fetching OSM tiles + Overpass buildings in parallel...");
    const [tileCanvas, buildings] = await Promise.all([
      fetchTileCanvas({ lat: cLat, lon: cLon }, zoom, W, H),
      fetchBuildings({ lat: cLat, lon: cLon }, 300),
    ]);
    console.log(`Tiles done, Buildings: ${buildings.length} (${Date.now() - t0}ms)`);

    // ── 2. COMPOSITE FINAL IMAGE ───────────────────────────────────────────
    const finalCanvas = createCanvas(W, H + BH);
    const ctx = finalCanvas.getContext("2d");

    // Draw tile base map
    ctx.drawImage(tileCanvas, 0, 0);

    // Create geo→pixel projection (matches tile math exactly)
    const geoToPx = createTileProjection({ lat: cLat, lon: cLon }, zoom, W, H);

    // Draw 3D buildings
    const buildingCount = drawIsoBuildings(ctx, W, H, { lat: cLat, lon: cLon }, zoom, buildings, coords, geoToPx);

    // Draw parcel + envelope
    drawParcelAndEnvelope(ctx, geoToPx, coords, envelopeCoords);

    // Draw overlays
    drawOverlays(ctx, W, H, BH, {
      site_area: Number(site_area), land_width: Number(land_width),
      land_depth: Number(land_depth), buildable_fp: Number(buildable_fp),
      setback_front: Number(setback_front), setback_side: Number(setback_side),
      setback_back: Number(setback_back),
      city: city || "", district: district || "", zoning: zoning || "",
      terrain_context: terrain_context || "", buildingCount,
    });

    const png = finalCanvas.toBuffer("image/png");
    console.log(`Final PNG: ${png.length} bytes, ${W}x${H + BH} (${Date.now() - t0}ms)`);

    // ── 3. UPLOAD TO SUPABASE ──────────────────────────────────────────────
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
      zoom,
      buildings_count: buildingCount,
      tiles: "osm-raster",
      engine: "osm-tiles-overpass-iso3d",
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error("Error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`BARLO Axo Service v7.0 on port ${PORT}`);
  console.log(`Engine: OSM Raster Tiles + Overpass + Canvas Iso3D`);
  console.log(`No Mapbox token needed for base map`);
  console.log(`Supabase: ${SUPABASE_URL ? "OK" : "MISSING"}`);
});
