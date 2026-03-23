const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas } = require("canvas");
const sharp = require("sharp");
const app = express();
app.use(express.json({ limit: "2mb" }));
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
app.get("/health", (req, res) => res.json({ ok: true }));

// ─── GEO HELPERS ──────────────────────────────────────────────────────────────
const R_EARTH = 6371000;
function toM(lat, lon, cLat, cLon) {
  return {
    x: (lon - cLon) * Math.PI / 180 * R_EARTH * Math.cos(cLat * Math.PI / 180),
    y: (lat - cLat) * Math.PI / 180 * R_EARTH,
  };
}
function centroidLL(coords) {
  return {
    lat: coords.reduce((s, p) => s + p.lat, 0) / coords.length,
    lon: coords.reduce((s, p) => s + p.lon, 0) / coords.length,
  };
}
function hav(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function brng(p1, p2) {
  const dLon = (p2.lon - p1.lon) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(p2.lat * Math.PI / 180);
  const x = Math.cos(p1.lat * Math.PI / 180) * Math.sin(p2.lat * Math.PI / 180) - Math.sin(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ─── AXONOMETRIC PROJECTION ──────────────────────────────────────────────────
// rot = rotation angle (radians) applied to world coords before projection
function axo(mx, my, mz, sc, cx, cy, rot) {
  // Apply view rotation
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const rx = mx * cosR - my * sinR;
  const ry = mx * sinR + my * cosR;
  // Standard 30° axonometric
  const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
  return {
    x: cx + (rx - ry) * c30 * sc,
    y: cy - (rx + ry) * s30 * sc - mz * sc * 0.85,
  };
}

// Compute optimal view rotation so the parcel's longest edge runs roughly
// left-to-right in the axo view — gives the best visual reading.
function computeViewRotation(coords, cLat, cLon) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  let maxLen = 0, bestAngle = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const dx = pts[j].x - pts[i].x;
    const dy = pts[j].y - pts[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > maxLen) {
      maxLen = len;
      bestAngle = Math.atan2(dy, dx);
    }
  }
  // We want the longest edge roughly along the axo X axis (45° in world space)
  // So rotate by -(bestAngle - PI/4)
  const target = Math.PI / 4;
  let rot = -(bestAngle - target);
  // Normalize to [-PI, PI]
  while (rot > Math.PI) rot -= 2 * Math.PI;
  while (rot < -Math.PI) rot += 2 * Math.PI;
  return rot;
}

// ─── Enveloppe constructible ──────────────────────────────────────────────────
function computeEnvelope(coords, cLat, cLon, front, side, back) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const n = pts.length;
  let maxLat = -Infinity, rb = 0;
  for (let i = 0; i < n - 1; i++) {
    const ml = (coords[i].lat + coords[(i + 1) % coords.length].lat) / 2;
    if (ml > maxLat) { maxLat = ml; rb = brng(coords[i], coords[(i + 1) % coords.length]); }
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
  for (let i = 0; i < n; i++) { const b = brng(coords[i], coords[(i + 1) % n]); segs.push(offSeg(pts[i], pts[(i + 1) % n], setSB(b))); }
  const envM = segs.map((_, i) => intersect(segs[(i + n - 1) % n], segs[i]));
  return envM.map(m => ({ lat: cLat + m.y / R_EARTH * 180 / Math.PI, lon: cLon + m.x / (R_EARTH * Math.cos(cLat * Math.PI / 180)) * 180 / Math.PI }));
}

// ─── OSM — bâtiments + routes ─────────────────────────────────────────────────
async function fetchOSM(cLat, cLon, radius) {
  const q = `[out:json][timeout:25];(way["building"](around:${radius},${cLat},${cLon});way["highway"](around:${radius},${cLat},${cLon}););out geom tags;`;
  const mirrors = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
  let resp = null;
  for (const m of mirrors) {
    try { resp = await fetch(`${m}?data=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(20000) }); if (resp.ok) { console.log("OSM OK:", m); break; } } catch { continue; }
  }
  if (!resp || !resp.ok) return { buildings: [], roads: [] };
  const data = await resp.json();
  const buildings = [], roads = [];
  for (const el of data.elements || []) {
    const geom = (el.geometry || []).map(p => ({ lat: p.lat, lon: p.lon }));
    if (geom.length < 3) continue;
    const tags = el.tags || {};
    if (tags.building) {
      let area = 0;
      for (let i = 0; i < geom.length - 1; i++) { const m1 = toM(geom[i].lat, geom[i].lon, cLat, cLon), m2 = toM(geom[i + 1].lat, geom[i + 1].lon, cLat, cLon); area += m1.x * m2.y - m2.x * m1.y; }
      area = Math.abs(area) / 2;
      const lv = parseInt(tags["building:levels"] || tags["levels"] || "0") || 0;
      const levels = lv || (area > 600 ? 5 : area > 300 ? 4 : area > 120 ? 3 : area > 50 ? 2 : 1);
      buildings.push({ geom, levels, name: tags.name || "", area });
    } else if (tags.highway && ["primary", "secondary", "tertiary", "residential", "unclassified", "service", "living_street"].includes(tags.highway)) {
      roads.push({ geom, name: tags.name || tags.ref || "", type: tags.highway });
    }
  }
  buildings.sort((a, b) => { const ca = centroidLL(a.geom), cb = centroidLL(b.geom); return hav(cLat, cLon, ca.lat, ca.lon) - hav(cLat, cLon, cb.lat, cb.lon); });
  return { buildings: buildings.slice(0, 80), roads: roads.slice(0, 25) };
}

// ─── Overture Maps — vrais footprints (fallback gracieux) ─────────────────────
async function fetchOverture(cLat, cLon, radius) {
  // Overture Maps via DuckDB HTTPFS on PMTiles — attempt lightweight approach
  // Utilise l'endpoint tiles si disponible, sinon retourne vide
  const bbox = {
    minLon: cLon - (radius / (R_EARTH * Math.cos(cLat * Math.PI / 180))) * (180 / Math.PI),
    maxLon: cLon + (radius / (R_EARTH * Math.cos(cLat * Math.PI / 180))) * (180 / Math.PI),
    minLat: cLat - (radius / R_EARTH) * (180 / Math.PI),
    maxLat: cLat + (radius / R_EARTH) * (180 / Math.PI),
  };
  try {
    // Try Overture REST endpoint (if available)
    const url = `https://api.overturemaps.org/v0/buildings?bbox=${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}&limit=200`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.features || data.features.length === 0) return [];
    console.log(`Overture: ${data.features.length} buildings`);
    return data.features.map(f => {
      const coords = (f.geometry?.coordinates?.[0] || []).map(c => ({ lat: c[1], lon: c[0] }));
      const props = f.properties || {};
      const levels = props.num_floors || props.height ? Math.round((props.height || 9) / 3) : 2;
      let area = 0;
      for (let i = 0; i < coords.length - 1; i++) {
        const m1 = toM(coords[i].lat, coords[i].lon, cLat, cLon);
        const m2 = toM(coords[i + 1].lat, coords[i + 1].lon, cLat, cLon);
        area += m1.x * m2.y - m2.x * m1.y;
      }
      return { geom: coords, levels, name: props.name || "", area: Math.abs(area) / 2 };
    }).filter(b => b.geom.length >= 3);
  } catch (e) {
    console.log(`Overture unavailable: ${e.message}`);
    return [];
  }
}

// ─── Bâtiments synthétiques (complément OSM) ──────────────────────────────────
function seededRand(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; }; }
function pointInPoly(px, py, poly) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y; if (((yi > py) != (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside; } return inside; }
function distPtSeg(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy; if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2); const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)); return Math.sqrt((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2); }

function generateSynthetic(cLat, cLon, parcelM, radius, roads, osmBuildings) {
  const seed = Math.round(Math.abs(cLat * 137.508 + cLon * 251.663) * 1000) % 0x7fffffff;
  const rand = seededRand(seed);

  // Precompute road segments + buffers (increased)
  const roadSegs = [];
  const bufMap = { primary: 26, secondary: 22, tertiary: 18, residential: 14, unclassified: 12, service: 10, living_street: 10 };
  for (const r of roads) {
    const buf = (bufMap[r.type] || 8) + 3;
    const pts = r.geom.map(p => toM(p.lat, p.lon, cLat, cLon));
    for (let i = 0; i < pts.length - 1; i++) roadSegs.push({ ax: pts[i].x, ay: pts[i].y, bx: pts[i + 1].x, by: pts[i + 1].y, buf });
  }

  // Precompute road directions for building alignment
  const roadDirPts = [];
  for (const r of roads) {
    const pts = r.geom.map(p => toM(p.lat, p.lon, cLat, cLon));
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 5) {
        roadDirPts.push({ cx: (pts[i].x + pts[i + 1].x) / 2, cy: (pts[i].y + pts[i + 1].y) / 2, angle: Math.atan2(dy, dx) });
      }
    }
  }
  function nearestRoadAngle(x, y) {
    let best = 0, bestDist = Infinity;
    for (const rd of roadDirPts) {
      const d = Math.sqrt((x - rd.cx) ** 2 + (y - rd.cy) ** 2);
      if (d < bestDist) { bestDist = d; best = rd.angle; }
    }
    // Snap to road direction if close, otherwise random slight angle
    return bestDist < 60 ? best + (rand() - 0.5) * 0.05 : (rand() - 0.5) * 0.15;
  }

  const osmCentres = osmBuildings.map(b => centroidLL(b.geom));
  const pMinX = Math.min(...parcelM.map(p => p.x)) - 10, pMaxX = Math.max(...parcelM.map(p => p.x)) + 10;
  const pMinY = Math.min(...parcelM.map(p => p.y)) - 10, pMaxY = Math.max(...parcelM.map(p => p.y)) + 10;

  const buildings = [];
  const cellSize = 12, gap = 4, gridCount = Math.ceil(radius / (cellSize + gap));

  for (let gx = -gridCount; gx <= gridCount; gx++) {
    for (let gy = -gridCount; gy <= gridCount; gy++) {
      const baseX = gx * (cellSize + gap), baseY = gy * (cellSize + gap);
      const dist = Math.sqrt(baseX * baseX + baseY * baseY);
      if (dist > radius) continue;
      if (baseX > pMinX && baseX < pMaxX && baseY > pMinY && baseY < pMaxY) continue;

      // Distance-based fill probability (denser near centre)
      const fillProb = dist < 50 ? 0.90 : dist < 100 ? 0.82 : dist < 160 ? 0.68 : 0.50;
      if (rand() > fillProb) continue;

      // Varied building sizes — more range
      const isBig = rand() < 0.10;
      const isMed = !isBig && rand() < 0.25;
      const minW = isBig ? 18 : isMed ? 10 : 5;
      const maxW = isBig ? 30 : isMed ? 16 : 12;
      const w = minW + rand() * (maxW - minW);
      const d = (minW * 0.6) + rand() * (maxW * 0.9 - minW * 0.6);

      const bx = baseX + (rand() - 0.5) * gap * 0.8;
      const by = baseY + (rand() - 0.5) * gap * 0.8;
      if (bx > pMinX && bx < pMaxX && by > pMinY && by < pMaxY) continue;
      if (pointInPoly(bx, by, parcelM)) continue;
      if (roadSegs.some(s => distPtSeg(bx, by, s.ax, s.ay, s.bx, s.by) < s.buf)) continue;

      const gps = { lat: cLat + by / R_EARTH * 180 / Math.PI, lon: cLon + bx / (R_EARTH * Math.cos(cLat * Math.PI / 180)) * 180 / Math.PI };
      if (osmCentres.some(ob => hav(gps.lat, gps.lon, ob.lat, ob.lon) < 18)) continue;

      // Align to nearest road direction
      const angle = nearestRoadAngle(bx, by);
      const ca = Math.cos(angle), sa = Math.sin(angle);

      // Generate building shape — rectangle, L-shape, or U-shape
      let corners;
      const shapeRoll = rand();

      if (shapeRoll < 0.15 && w > 10 && d > 10) {
        // L-shaped building
        const cutW = w * (0.35 + rand() * 0.25);
        const cutD = d * (0.35 + rand() * 0.25);
        corners = [
          { x: -w / 2, y: -d / 2 },
          { x: w / 2, y: -d / 2 },
          { x: w / 2, y: -d / 2 + cutD },
          { x: -w / 2 + cutW, y: -d / 2 + cutD },
          { x: -w / 2 + cutW, y: d / 2 },
          { x: -w / 2, y: d / 2 },
        ];
      } else if (shapeRoll < 0.22 && w > 14 && d > 10) {
        // U-shaped building
        const wingW = w * (0.25 + rand() * 0.15);
        const courtD = d * (0.3 + rand() * 0.2);
        corners = [
          { x: -w / 2, y: -d / 2 },
          { x: w / 2, y: -d / 2 },
          { x: w / 2, y: d / 2 },
          { x: w / 2 - wingW, y: d / 2 },
          { x: w / 2 - wingW, y: -d / 2 + courtD },
          { x: -w / 2 + wingW, y: -d / 2 + courtD },
          { x: -w / 2 + wingW, y: d / 2 },
          { x: -w / 2, y: d / 2 },
        ];
      } else {
        // Rectangle (with slight imperfection for organic feel)
        const jitter = rand() * 0.6;
        corners = [
          { x: -w / 2 + jitter, y: -d / 2 },
          { x: w / 2, y: -d / 2 + jitter * 0.5 },
          { x: w / 2 - jitter * 0.3, y: d / 2 },
          { x: -w / 2, y: d / 2 - jitter * 0.4 },
        ];
      }

      // Rotate and translate
      const rotatedCorners = corners.map(c => ({ x: bx + c.x * ca - c.y * sa, y: by + c.x * sa + c.y * ca }));
      const geom = rotatedCorners.map(c => ({
        lat: cLat + c.y / R_EARTH * 180 / Math.PI,
        lon: cLon + c.x / (R_EARTH * Math.cos(cLat * Math.PI / 180)) * 180 / Math.PI,
      }));

      // More varied height distribution
      const lvlRand = rand();
      const distFactor = Math.max(0, 1 - dist / radius);
      let levels;
      if (isBig) {
        levels = lvlRand < 0.3 ? 4 : lvlRand < 0.6 ? 5 : lvlRand < 0.85 ? 6 : 8;
      } else if (distFactor > 0.7) {
        // Near centre — taller buildings
        levels = lvlRand < 0.15 ? 1 : lvlRand < 0.35 ? 2 : lvlRand < 0.60 ? 3 : lvlRand < 0.80 ? 4 : 5;
      } else {
        // Periphery — shorter
        levels = lvlRand < 0.30 ? 1 : lvlRand < 0.65 ? 2 : lvlRand < 0.85 ? 3 : 4;
      }

      buildings.push({ geom, levels, name: "", area: w * d, isSynth: true });
    }
  }
  return buildings;
}

// ─── RENDU CANVAS ─────────────────────────────────────────────────────────────
function renderAxo(canvas, p) {
  const ctx = canvas.getContext("2d");
  const {
    W, H, BH, cLat, cLon, coords, envelopeCoords, buildings, roads,
    site_area, land_width, land_depth, buildable_fp,
    setback_front, setback_side, setback_back, city, district, zoning, terrain_context,
    viewRotation,
  } = p;

  const rot = viewRotation;
  const pMtrs = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const ext = Math.max(
    Math.max(...pMtrs.map(q => q.x)) - Math.min(...pMtrs.map(q => q.x)),
    Math.max(...pMtrs.map(q => q.y)) - Math.min(...pMtrs.map(q => q.y)),
    30
  );
  const sc = (W * 0.20) / ext;
  const cx = W * 0.50, cy = H * 0.48;

  // ── 1. FOND CRÈME HEKTAR ──────────────────────────────────────────────────
  ctx.fillStyle = "#f2f0ec";
  ctx.fillRect(0, 0, W, H + BH);

  // ── Prepare sorted buildings for painter's algorithm ──────────────────────
  const sortedBuildings = buildings.map(b => {
    const c = centroidLL(b.geom);
    const m = toM(c.lat, c.lon, cLat, cLon);
    // Sort key: in axo, "far" = higher (y in axo space) = draw first
    // For 30° axo with rotation, "depth" = rx + ry after rotation
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const rx = m.x * cosR - m.y * sinR;
    const ry = m.x * sinR + m.y * cosR;
    return { ...b, sortKey: rx + ry, dist: hav(cLat, cLon, c.lat, c.lon) };
  }).filter(b => b.dist > 4)
    .sort((a, b) => a.sortKey - b.sortKey); // far-to-near

  // ── 2. ALL SHADOWS (first pass) ───────────────────────────────────────────
  sortedBuildings.forEach(b => {
    const pts = b.geom.map(c => toM(c.lat, c.lon, cLat, cLon));
    if (pts.length < 3) return;
    const h = b.levels * 3.2;
    const shOff = h * sc * 0.40;
    const gPts = pts.map(pt => axo(pt.x, pt.y, 0, sc, cx, cy, rot));
    ctx.beginPath();
    gPts.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x + shOff, pt.y + shOff * 0.38) : ctx.lineTo(pt.x + shOff, pt.y + shOff * 0.38));
    ctx.closePath();
    ctx.fillStyle = "rgba(180,175,165,0.35)";
    ctx.fill();
  });

  // ── 3. ALL BUILDINGS (second pass — back-to-front) ─────────────────────────
  sortedBuildings.forEach(b => {
    const pts = b.geom.map(c => toM(c.lat, c.lon, cLat, cLon));
    if (pts.length < 3) return;
    const h = b.levels * 3.2;
    const n = pts.length;
    const gPts = pts.map(pt => axo(pt.x, pt.y, 0, sc, cx, cy, rot));
    const rPts = pts.map(pt => axo(pt.x, pt.y, h, sc, cx, cy, rot));

    // Ground fill
    ctx.beginPath();
    gPts.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
    ctx.closePath();
    ctx.fillStyle = "#eceae6";
    ctx.fill();

    // Side faces
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p1g = axo(pts[i].x, pts[i].y, 0, sc, cx, cy, rot);
      const p2g = axo(pts[j].x, pts[j].y, 0, sc, cx, cy, rot);
      const p1r = axo(pts[i].x, pts[i].y, h, sc, cx, cy, rot);
      const p2r = axo(pts[j].x, pts[j].y, h, sc, cx, cy, rot);

      // Determine if this face is in shadow
      const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
      const len = Math.sqrt(dx * dx + dy * dy) + 0.001;
      // Light from upper-right
      const isShadow = (-dx / len * 0.7 + dy / len * 0.3) < 0;

      ctx.beginPath();
      ctx.moveTo(p1g.x, p1g.y);
      ctx.lineTo(p2g.x, p2g.y);
      ctx.lineTo(p2r.x, p2r.y);
      ctx.lineTo(p1r.x, p1r.y);
      ctx.closePath();
      ctx.fillStyle = isShadow ? "#9a9690" : "#f5f3ef";
      ctx.fill();
      ctx.strokeStyle = isShadow ? "#88847e" : "#d8d5ce";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // Roof — white with subtle edge highlight
    ctx.beginPath();
    rPts.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#c0bdb6";
    ctx.lineWidth = 0.7;
    ctx.stroke();

    // Subtle roof edge highlight (light side)
    if (rPts.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(rPts[0].x, rPts[0].y);
      ctx.lineTo(rPts[1].x, rPts[1].y);
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  });

  // ── 4. ROUTES — drawn ON TOP of buildings ─────────────────────────────────
  const roadCfg = {
    primary: { w: 16, fill: "#eae4d4", border: "#c8c0a8", label: true },
    secondary: { w: 12, fill: "#eae4d4", border: "#c8c0a8", label: true },
    tertiary: { w: 9, fill: "#eee8da", border: "#d0c8b4", label: true },
    residential: { w: 7, fill: "#f0ece2", border: "#d8d2c4", label: true },
    unclassified: { w: 5, fill: "#f0ece2", border: "#d8d2c4", label: false },
    service: { w: 3.5, fill: "#f4f1e8", border: "#dedad0", label: false },
    living_street: { w: 3.5, fill: "#f4f1e8", border: "#dedad0", label: false },
  };

  // Sort roads: minor first, major on top
  const roadOrder = { primary: 6, secondary: 5, tertiary: 4, residential: 3, unclassified: 2, service: 1, living_street: 0 };
  const sortedRoads = [...roads].sort((a, b) => (roadOrder[a.type] || 0) - (roadOrder[b.type] || 0));

  sortedRoads.forEach(r => {
    if (r.geom.length < 2) return;
    const pts = r.geom.map(c => { const m = toM(c.lat, c.lon, cLat, cLon); return axo(m.x, m.y, 0, sc, cx, cy, rot); });
    const cfg = roadCfg[r.type] || { w: 3, fill: "#f0ece2", border: "#d8d2c4", label: false };

    // White buffer underneath for visibility over buildings
    ctx.beginPath();
    pts.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
    ctx.strokeStyle = "rgba(242,240,236,0.85)";
    ctx.lineWidth = cfg.w + 8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    // Border stroke
    ctx.beginPath();
    pts.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
    ctx.strokeStyle = cfg.border;
    ctx.lineWidth = cfg.w + 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    // Fill stroke
    ctx.beginPath();
    pts.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
    ctx.strokeStyle = cfg.fill;
    ctx.lineWidth = cfg.w;
    ctx.stroke();

    // Centre dashes for major roads
    if (["primary", "secondary"].includes(r.type)) {
      ctx.beginPath();
      pts.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
      ctx.strokeStyle = "rgba(200,192,168,0.5)";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 8]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Road name labels
    if (r.name && cfg.label && pts.length > 1) {
      const mid = Math.floor(pts.length / 2);
      const mp = pts[mid], mpN = pts[Math.min(mid + 1, pts.length - 1)];
      const ang = Math.atan2(mpN.y - mp.y, mpN.x - mp.x);
      const adj = ang > Math.PI / 2 || ang < -Math.PI / 2 ? ang + Math.PI : ang;
      ctx.save();
      ctx.translate(mp.x, mp.y - 6);
      ctx.rotate(adj);
      ctx.font = "italic 9px Arial";
      ctx.textAlign = "center";
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 3.5;
      ctx.lineJoin = "round";
      ctx.strokeText(r.name.substring(0, 26), 0, 0);
      ctx.fillStyle = "#6a5e44";
      ctx.fillText(r.name.substring(0, 26), 0, 0);
      ctx.restore();
    }
  });

  // ── 5. PARCELLE ───────────────────────────────────────────────────────────
  const parcelPts = pMtrs;
  const parcelPx = parcelPts.map(pt => axo(pt.x, pt.y, 0, sc, cx, cy, rot));

  // Outer glow
  ctx.beginPath();
  parcelPx.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
  ctx.closePath();
  ctx.strokeStyle = "rgba(208,40,24,0.2)";
  ctx.lineWidth = 7;
  ctx.stroke();

  // Fill
  ctx.beginPath();
  parcelPx.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
  ctx.closePath();
  ctx.fillStyle = "rgba(208,40,24,0.12)";
  ctx.fill();

  // Stroke
  ctx.strokeStyle = "#d02818";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Corner dots
  parcelPx.forEach(pt => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3, 0, 2 * Math.PI);
    ctx.fillStyle = "#d02818";
    ctx.fill();
  });

  // ── 6. ENVELOPPE ──────────────────────────────────────────────────────────
  const envPts = envelopeCoords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const envPx = envPts.map(pt => axo(pt.x, pt.y, 0, sc, cx, cy, rot));
  ctx.beginPath();
  envPx.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
  ctx.closePath();
  ctx.strokeStyle = "#d02818";
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 5]);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── 7. ANNOTATIONS ────────────────────────────────────────────────────────
  function T(x, y, txt, color, size, bold = false, anchor = "center") {
    ctx.font = `${bold ? "700" : "500"} ${size}px Arial`;
    ctx.textAlign = anchor;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y);
  }

  const pCtr = axo(0, 0, 0, sc, cx, cy, rot);

  // Front setback
  let maxLat = -Infinity, northIdx = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const ml = (coords[i].lat + coords[(i + 1) % coords.length].lat) / 2;
    if (ml > maxLat) { maxLat = ml; northIdx = i; }
  }
  const pm0 = parcelPts[northIdx], pm1 = parcelPts[(northIdx + 1) % parcelPts.length];
  const midM = { x: (pm0.x + pm1.x) / 2, y: (pm0.y + pm1.y) / 2 };
  const midAxo = axo(midM.x, midM.y, 0, sc, cx, cy, rot);
  const fA = axo(midM.x, midM.y, 0, sc, cx, cy, rot);
  const fB = axo(midM.x, midM.y + setback_front, 0, sc, cx, cy, rot);
  ctx.beginPath(); ctx.moveTo(fA.x, fA.y); ctx.lineTo(fB.x, fB.y);
  ctx.strokeStyle = "#d02818"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]); ctx.stroke(); ctx.setLineDash([]);
  T((fA.x + fB.x) / 2, (fA.y + fB.y) / 2 - 10, `↕ ${setback_front}m`, "#d02818", 12, true);

  // Side setback
  const si = Math.floor(parcelPts.length * 0.25) % parcelPts.length;
  const sA = axo(parcelPts[si].x, parcelPts[si].y, 0, sc, cx, cy, rot);
  const sB = axo(parcelPts[si].x - setback_side, parcelPts[si].y, 0, sc, cx, cy, rot);
  ctx.beginPath(); ctx.moveTo(sA.x, sA.y); ctx.lineTo(sB.x, sB.y);
  ctx.strokeStyle = "#555"; ctx.lineWidth = 1.2; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
  T((sA.x + sB.x) / 2, (sA.y + sB.y) / 2 - 8, `↔ ${setback_side}m`, "#555", 11);

  // Back setback
  const bi = Math.floor(parcelPts.length * 0.6) % parcelPts.length;
  const bA = axo(parcelPts[bi].x, parcelPts[bi].y, 0, sc, cx, cy, rot);
  const bB = axo(parcelPts[bi].x, parcelPts[bi].y - setback_back, 0, sc, cx, cy, rot);
  ctx.beginPath(); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
  ctx.strokeStyle = "#555"; ctx.lineWidth = 1.2; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
  T((bA.x + bB.x) / 2, (bA.y + bB.y) / 2 - 8, `↕ ${setback_back}m`, "#555", 11);

  // Width dimension line
  const dA = axo(parcelPts[0].x, parcelPts[0].y, 0, sc, cx, cy, rot);
  const dB = axo(parcelPts[1 % parcelPts.length].x, parcelPts[1 % parcelPts.length].y, 0, sc, cx, cy, rot);
  ctx.strokeStyle = "#555"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(dA.x, dA.y - 14); ctx.lineTo(dB.x, dB.y - 14); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(dA.x, dA.y - 8); ctx.lineTo(dA.x, dA.y - 22); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(dB.x, dB.y - 8); ctx.lineTo(dB.x, dB.y - 22); ctx.stroke();
  // End ticks (small perpendicular marks)
  T((dA.x + dB.x) / 2, (dA.y + dB.y) / 2 - 26, `${land_width}m`, "#222", 13, true);

  // Centre labels
  T(midAxo.x, midAxo.y - 24, "Accès principal", "#d02818", 13, true);
  T(pCtr.x, pCtr.y - 10, "Enveloppe constructible", "#d02818", 11);
  T(pCtr.x, pCtr.y + 10, `${buildable_fp} m²`, "#1d7a3e", 16, true);
  T(pCtr.x, pCtr.y + 28, `${site_area} m² · ${land_width}×${land_depth}m`, "#444", 10);

  // ── 8. BOUSSOLE ───────────────────────────────────────────────────────────
  ctx.save();
  ctx.translate(W - 54, 54);
  // Outer ring
  ctx.beginPath(); ctx.arc(0, 0, 26, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fill();
  ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1; ctx.stroke();
  // Inner ring
  ctx.beginPath(); ctx.arc(0, 0, 22, 0, 2 * Math.PI);
  ctx.strokeStyle = "#eee"; ctx.lineWidth = 0.5; ctx.stroke();
  // North arrow — rotate to match view rotation
  ctx.rotate(-rot); // Counter-rotate so N always points up
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -2); ctx.lineTo(0, -7); ctx.lineTo(5, -2); ctx.closePath();
  ctx.fillStyle = "#d02818"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 2); ctx.lineTo(0, 7); ctx.lineTo(5, 2); ctx.closePath();
  ctx.fillStyle = "#bbb"; ctx.fill();
  ctx.font = "bold 11px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#d02818"; ctx.fillText("N", 0, -23);
  ctx.restore();

  // ── 9. LÉGENDE ────────────────────────────────────────────────────────────
  const legItems = [
    { type: "rect", fill: "#f2e2e0", stroke: "#d02818", label: `Parcelle — ${site_area} m²` },
    { type: "dash", stroke: "#d02818", label: "Enveloppe constructible" },
    { type: "rect", fill: "#f5f3ef", stroke: "#ccc", label: "Bâtiments existants" },
    { type: "line", stroke: "#eae4d4", border: "#c8c0a8", label: "Voirie" },
  ];
  const legW = 220, legH = 14 + legItems.length * 24 + 16;
  // Background with shadow
  ctx.shadowColor = "rgba(0,0,0,0.06)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.beginPath(); ctx.roundRect(12, 12, legW, legH, 8); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.strokeStyle = "#e8e5e0"; ctx.lineWidth = 1; ctx.stroke();

  legItems.forEach((item, i) => {
    const iy = 12 + 14 + i * 24;
    if (item.type === "rect") {
      ctx.fillStyle = item.fill;
      ctx.beginPath(); ctx.roundRect(22, iy, 14, 12, 2); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2; ctx.stroke();
    } else if (item.type === "dash") {
      ctx.beginPath(); ctx.moveTo(22, iy + 6); ctx.lineTo(36, iy + 6);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2; ctx.setLineDash([5, 2]); ctx.stroke(); ctx.setLineDash([]);
    } else if (item.type === "line") {
      ctx.beginPath(); ctx.moveTo(22, iy + 6); ctx.lineTo(36, iy + 6);
      ctx.strokeStyle = item.border; ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(22, iy + 6); ctx.lineTo(36, iy + 6);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 3; ctx.stroke();
    }
    ctx.font = "11px Arial"; ctx.fillStyle = "#444"; ctx.textAlign = "left"; ctx.fillText(item.label, 44, iy + 10);
  });
  ctx.font = "7px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("© OpenStreetMap contributors", 22, 12 + legH - 6);

  // ── 10. BANDE STATS ───────────────────────────────────────────────────────
  const BY = H;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, BY, W, BH);
  ctx.beginPath(); ctx.moveTo(0, BY); ctx.lineTo(W, BY);
  ctx.strokeStyle = "#d02818"; ctx.lineWidth = 3; ctx.stroke();

  const C1 = 24, C2 = 220, C3 = 410, C4 = 590;
  ctx.textAlign = "left";
  ctx.font = "bold 16px Arial"; ctx.fillStyle = "#111";
  ctx.fillText("Lecture stratégique du site", C1, BY + 30);
  ctx.font = "9px Arial"; ctx.fillStyle = "#aaa";
  ctx.fillText(`${city} · ${district} · Zoning : ${zoning}`, C1, BY + 48);

  ctx.beginPath(); ctx.moveTo(C1, BY + 56); ctx.lineTo(W - C1, BY + 56);
  ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1; ctx.stroke();

  // Stats columns
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Surface parcelle", C1, BY + 72);
  ctx.font = "bold 22px Arial"; ctx.fillStyle = "#111"; ctx.fillText(`${site_area} m²`, C1, BY + 94);

  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Dimensions", C2, BY + 72);
  ctx.font = "bold 17px Arial"; ctx.fillStyle = "#111"; ctx.fillText(`${land_width}m × ${land_depth}m`, C2, BY + 94);

  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Empreinte constructible", C3, BY + 72);
  ctx.font = "bold 22px Arial"; ctx.fillStyle = "#1d7a3e"; ctx.fillText(`${buildable_fp} m²`, C3, BY + 94);

  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Retraits réglementaires", C4, BY + 72);
  ctx.font = "600 10px Arial"; ctx.fillStyle = "#333";
  ctx.fillText(`Avant : ${setback_front}m · Côtés : ${setback_side}m`, C4, BY + 86);
  ctx.fillText(`Arrière : ${setback_back}m`, C4, BY + 100);

  ctx.beginPath(); ctx.moveTo(C1, BY + 112); ctx.lineTo(W - C1, BY + 112);
  ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1; ctx.stroke();

  ctx.font = "8px Arial"; ctx.fillStyle = "#ccc";
  ctx.fillText((terrain_context || "").substring(0, 120), C1, BY + 128);

  ctx.textAlign = "right"; ctx.font = "7px Arial"; ctx.fillStyle = "#ddd";
  ctx.fillText("BARLO · Diagnostic foncier", W - C1, BY + BH - 10);
}

// ─── ENDPOINT ─────────────────────────────────────────────────────────────────
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("→ /generate");
  const {
    lead_id, client_name, polygon_points, site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp, setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning, image_size = 900, osm_radius = 240, slide_name = "slide_4_axo",
  } = req.body;

  if (!lead_id || !polygon_points) return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });

  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
  if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });

  const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
  const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
  console.log(`Centroïde: ${cLat}, ${cLon}`);

  const envelopeCoords = computeEnvelope(coords, cLat, cLon, Number(setback_front), Number(setback_side), Number(setback_back));

  // Compute optimal view rotation
  const viewRotation = computeViewRotation(coords, cLat, cLon);
  console.log(`View rotation: ${(viewRotation * 180 / Math.PI).toFixed(1)}°`);

  try {
    // Fetch OSM + attempt Overture in parallel
    console.log("Fetching OSM...");
    const [osm, overtureBuildings] = await Promise.all([
      fetchOSM(cLat, cLon, Number(osm_radius)),
      fetchOverture(cLat, cLon, Number(osm_radius)),
    ]);
    console.log(`OSM: ${osm.buildings.length} bâtiments, ${osm.roads.length} routes`);
    console.log(`Overture: ${overtureBuildings.length} bâtiments`);

    // Merge Overture buildings with OSM (Overture takes priority if available)
    let realBuildings;
    if (overtureBuildings.length > 10) {
      // Overture has good coverage — use it as primary
      realBuildings = overtureBuildings;
      console.log("Using Overture as primary building source");
    } else {
      realBuildings = osm.buildings;
    }

    const pMtrs = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
    const synth = generateSynthetic(cLat, cLon, pMtrs, 180, osm.roads, realBuildings);
    console.log(`Synthetic: ${synth.length}`);

    const allBuildings = [...realBuildings.map(b => ({ ...b, isSynth: false })), ...synth];
    const W = Number(image_size), BH = 170, H = W;
    console.log("Rendering...");

    const canvas = createCanvas(W, H + BH);
    renderAxo(canvas, {
      W, H, BH, cLat, cLon, coords, envelopeCoords,
      buildings: allBuildings, roads: osm.roads, viewRotation,
      site_area: Number(site_area), land_width: Number(land_width), land_depth: Number(land_depth),
      envelope_w: Number(envelope_w), envelope_d: Number(envelope_d), buildable_fp: Number(buildable_fp),
      setback_front: Number(setback_front), setback_side: Number(setback_side), setback_back: Number(setback_back),
      city: city || "", district: district || "", zoning: zoning || "", terrain_context: terrain_context || "",
    });

    let png = canvas.toBuffer("image/png");
    console.log(`Canvas PNG: ${png.length} bytes (${Date.now() - t0}ms)`);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const slug = String(client_name || "client").toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const path = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;
    const { error: ue } = await sb.storage.from("massing-images").upload(path, png, { contentType: "image/png", upsert: true });
    if (ue) return res.status(500).json({ error: ue.message });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(path);
    console.log(`Done: ${pd.publicUrl} (${Date.now() - t0}ms)`);

    return res.json({
      ok: true,
      public_url: pd.publicUrl,
      path,
      centroid: { lat: cLat, lon: cLon },
      view_rotation_deg: Math.round(viewRotation * 180 / Math.PI),
      stats: {
        osm_buildings: osm.buildings.length,
        overture_buildings: overtureBuildings.length,
        osm_roads: osm.roads.length,
        synthetic: synth.length,
        total_buildings: allBuildings.length,
      },
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error("Error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`BARLO Axo Service on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? "OK" : "MISSING"}`);
});
