// ═══════════════════════════════════════════════════════════════════════════════
// BARLO — slide_4_axo v8 — TRUE AXONOMETRIC 3D MASSING VIEW
// ═══════════════════════════════════════════════════════════════════════════════
// Rendu 100% vectoriel isométrique via node-canvas :
//   • Overpass API → bâtiments + routes réels OSM
//   • Projection axonométrique 30° (vue sud-est → nord-ouest)
//   • Bâtiments voisins extrudés en 3D
//   • Parcelle + enveloppe constructible
//   • Overlays BARLO (légende, boussole, stats bar)
// Aucune tuile raster — tout est dessiné en vecteur
// ═══════════════════════════════════════════════════════════════════════════════

const express = require("express");
const https = require("https");
const http = require("http");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas } = require("canvas");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

app.get("/health", (req, res) => res.json({ ok: true, engine: "axo-iso3d-vector", version: "8.0" }));

// ─── GEO HELPERS ──────────────────────────────────────────────────────────────
const R_EARTH = 6371000;

// Convert lat/lon to meters from a center point
function geoToM(lat, lon, cLat, cLon) {
  return {
    east: (lon - cLon) * Math.PI / 180 * R_EARTH * Math.cos(cLat * Math.PI / 180),
    north: (lat - cLat) * Math.PI / 180 * R_EARTH,
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
  const pts = coords.map(c => geoToM(c.lat, c.lon, cLat, cLon));
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
    const dx = p2.east - p1.east, dy = p2.north - p1.north;
    const len = Math.sqrt(dx * dx + dy * dy) + 0.001;
    return {
      p1: { east: p1.east - dy / len * dist, north: p1.north + dx / len * dist },
      p2: { east: p2.east - dy / len * dist, north: p2.north + dx / len * dist },
    };
  }
  function intersect(s1, s2) {
    const d1x = s1.p2.east - s1.p1.east, d1y = s1.p2.north - s1.p1.north;
    const d2x = s2.p2.east - s2.p1.east, d2y = s2.p2.north - s2.p1.north;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-10) return { east: (s1.p2.east + s2.p1.east) / 2, north: (s1.p2.north + s2.p1.north) / 2 };
    const t = ((s2.p1.east - s1.p1.east) * d2y - (s2.p1.north - s1.p1.north) * d2x) / den;
    return { east: s1.p1.east + t * d1x, north: s1.p1.north + t * d1y };
  }
  const segs = [];
  for (let i = 0; i < n; i++) {
    const b = brng(coords[i], coords[(i + 1) % n]);
    segs.push(offSeg(pts[i], pts[(i + 1) % n], setSB(b)));
  }
  const envM = segs.map((_, i) => intersect(segs[(i + n - 1) % n], segs[i]));
  // Return in meters (east, north) directly
  return envM;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AXONOMETRIC PROJECTION
// ═══════════════════════════════════════════════════════════════════════════════
// View from south-east looking north-west, 30° angle
// east → screen right+down, north → screen left+down, height → screen up

function createAxoProjection(scale, W, H, offsetY) {
  // Axonometric angles (standard architectural axo: 30°/60° or 45°/45°)
  const angle = Math.PI / 6; // 30 degrees
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const cx = W / 2;
  const cy = H / 2 + (offsetY || 0);

  return function project(east, north, height) {
    // east = meters east from center
    // north = meters north from center
    // height = meters above ground
    const sx = (east - north) * cosA * scale;
    const sy = (east + north) * sinA * scale - height * scale;
    return {
      x: cx + sx,
      y: cy + sy,
    };
  };
}

// ─── HTTP FETCH (with redirects + User-Agent) ────────────────────────────────
function httpFetch(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: { "User-Agent": "BARLO-AxoService/8.0 (diagnostic-foncier)" },
    };
    const client = isHttps ? https : http;
    client.request(options, (resp) => {
      if (resp.statusCode === 301 || resp.statusCode === 302) {
        return httpFetch(resp.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      resp.on("data", d => chunks.push(d));
      resp.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (resp.statusCode !== 200) reject(new Error(`HTTP ${resp.statusCode}: ${buf.toString().substring(0, 200)}`));
        else resolve(buf);
      });
      resp.on("error", reject);
    }).on("error", reject).end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERPASS — fetch buildings + roads
// ═══════════════════════════════════════════════════════════════════════════════
async function fetchOSMData(center, radiusM) {
  const query = `[out:json][timeout:20];(
    way["building"](around:${radiusM},${center.lat},${center.lon});
    way["highway"](around:${radiusM},${center.lat},${center.lon});
  );out body;>;out skel qt;`;

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

      // Extract buildings
      const buildings = [];
      for (const el of data.elements) {
        if (el.type === "way" && el.tags && el.tags.building) {
          const coords = (el.nodes || []).map(nid => nodes[nid]).filter(Boolean);
          if (coords.length >= 3) {
            const levels = parseInt(el.tags["building:levels"]) || 0;
            const height = parseFloat(el.tags.height) || (levels > 0 ? levels * 3 : 3 + Math.random() * 6);
            buildings.push({ coords, height, tags: el.tags });
          }
        }
      }

      // Extract roads
      const roads = [];
      for (const el of data.elements) {
        if (el.type === "way" && el.tags && el.tags.highway) {
          const coords = (el.nodes || []).map(nid => nodes[nid]).filter(Boolean);
          if (coords.length >= 2) {
            const hw = el.tags.highway;
            // Road width based on type
            let width = 4;
            if (["primary", "trunk"].includes(hw)) width = 10;
            else if (["secondary"].includes(hw)) width = 8;
            else if (["tertiary", "unclassified"].includes(hw)) width = 6;
            else if (["residential", "living_street"].includes(hw)) width = 5;
            else if (["service", "track"].includes(hw)) width = 3;
            else if (["footway", "path", "cycleway"].includes(hw)) width = 2;
            roads.push({ coords, width, type: hw, name: el.tags.name || "" });
          }
        }
      }

      console.log(`  → ${buildings.length} buildings, ${roads.length} roads`);
      return { buildings, roads };
    } catch (e) {
      console.warn(`  → failed: ${e.message}`);
    }
  }

  console.error("All Overpass servers failed");
  return { buildings: [], roads: [] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRAWING FUNCTIONS — ALL IN AXONOMETRIC PROJECTION
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Ground plane ───────────────────────────────────────────────────────────
function drawGroundPlane(ctx, project, extentM) {
  const e = extentM;
  // Draw subtle ground grid
  ctx.strokeStyle = "#e8e4de";
  ctx.lineWidth = 0.5;

  const step = 20; // 20m grid
  for (let i = -e; i <= e; i += step) {
    const p1 = project(i, -e, 0);
    const p2 = project(i, e, 0);
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    const p3 = project(-e, i, 0);
    const p4 = project(e, i, 0);
    ctx.beginPath(); ctx.moveTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.stroke();
  }
}

// ─── Roads ──────────────────────────────────────────────────────────────────
function drawRoads(ctx, project, roads, cLat, cLon) {
  // Draw road surfaces
  for (const road of roads) {
    const pts = road.coords.map(c => {
      const m = geoToM(c.lat, c.lon, cLat, cLon);
      return project(m.east, m.north, 0);
    });

    if (pts.length < 2) continue;

    // Road surface (wider, light)
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = "#d5d0c8";
    ctx.lineWidth = road.width * 0.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    // Road center line (thinner, slightly darker)
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = "#c8c2b8";
    ctx.lineWidth = Math.max(1, road.width * 0.3);
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ─── Buildings (isometric 3D extrusion) ─────────────────────────────────────
function drawBuildings(ctx, project, buildings, cLat, cLon, parcelMCoords) {
  // Check if centroid is inside parcel
  function inPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].east, yi = poly[i].north;
      const xj = poly[j].east, yj = poly[j].north;
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }

  // Convert buildings to meters + compute centroid sort key
  const buildingData = buildings.map(b => {
    const mCoords = b.coords.map(c => geoToM(c.lat, c.lon, cLat, cLon));
    const centroid = {
      east: mCoords.reduce((s, p) => s + p.east, 0) / mCoords.length,
      north: mCoords.reduce((s, p) => s + p.north, 0) / mCoords.length,
    };
    return { mCoords, height: b.height, centroid };
  }).filter(b => {
    // Skip buildings inside the parcel
    return !inPolygon(b.centroid.east, b.centroid.north, parcelMCoords);
  });

  // Sort back-to-front for isometric: draw buildings farther from viewer first
  // Viewer is at south-east → sort by (east + north) ascending
  buildingData.sort((a, b) => (a.centroid.east + a.centroid.north) - (b.centroid.east + b.centroid.north));

  const colors = {
    top: "#eae5db",
    frontLight: "#ddd8ce",  // south-facing walls
    frontDark: "#cbc5bb",   // west-facing walls
    stroke: "#b5b0a5",
  };

  let drawn = 0;
  for (const b of buildingData) {
    const fp = b.mCoords;
    const h = b.height;

    // Project all points at ground and roof level
    const ground = fp.map(p => project(p.east, p.north, 0));
    const roof = fp.map(p => project(p.east, p.north, h));

    // Check if any point is visible on canvas (rough check)
    const anyVisible = ground.some(p => p.x > -200 && p.x < 1480 && p.y > -200 && p.y < 1480);
    if (!anyVisible) continue;

    // Draw visible walls
    for (let i = 0; i < fp.length; i++) {
      const j = (i + 1) % fp.length;
      const g1 = ground[i], g2 = ground[j];
      const r1 = roof[i], r2 = roof[j];

      // Wall normal to determine facing direction
      const dx = fp[j].east - fp[i].east;
      const dy = fp[j].north - fp[i].north;
      // Cross product with view direction to determine visibility
      // View from south-east: visible if wall faces south or east
      const faceSouth = dy < 0; // wall faces south (toward viewer)
      const faceEast = dx > 0;  // wall faces east (toward viewer)

      if (faceSouth || faceEast) {
        ctx.beginPath();
        ctx.moveTo(g1.x, g1.y);
        ctx.lineTo(g2.x, g2.y);
        ctx.lineTo(r2.x, r2.y);
        ctx.lineTo(r1.x, r1.y);
        ctx.closePath();
        ctx.fillStyle = faceEast && !faceSouth ? colors.frontDark : colors.frontLight;
        ctx.fill();
        ctx.strokeStyle = colors.stroke;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    }

    // Draw roof
    ctx.beginPath();
    ctx.moveTo(roof[0].x, roof[0].y);
    for (let i = 1; i < roof.length; i++) ctx.lineTo(roof[i].x, roof[i].y);
    ctx.closePath();
    ctx.fillStyle = colors.top;
    ctx.fill();
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = 0.6;
    ctx.stroke();

    drawn++;
  }

  console.log(`Drew ${drawn} iso buildings (${buildings.length} total from Overpass)`);
  return drawn;
}

// ─── Parcel (ground polygon, highlighted) ───────────────────────────────────
function drawParcel(ctx, project, parcelMCoords) {
  // Ground-level polygon
  const pts = parcelMCoords.map(p => project(p.east, p.north, 0));

  // Fill
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = "rgba(208, 40, 24, 0.18)";
  ctx.fill();

  // Solid outline
  ctx.strokeStyle = "#d02818";
  ctx.lineWidth = 3;
  ctx.stroke();
}

// ─── Envelope (dashed outline on ground) ────────────────────────────────────
function drawEnvelope(ctx, project, envelopeMCoords) {
  const pts = envelopeMCoords.map(p => project(p.east, p.north, 0));

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.strokeStyle = "#d02818";
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([10, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

// ─── Buildable volume (3D extruded envelope — translucent) ──────────────────
function drawBuildableVolume(ctx, project, envelopeMCoords, maxHeight) {
  const h = maxHeight || 12; // default R+3 = 12m
  const ground = envelopeMCoords.map(p => project(p.east, p.north, 0));
  const top = envelopeMCoords.map(p => project(p.east, p.north, h));

  // Draw transparent walls
  for (let i = 0; i < envelopeMCoords.length; i++) {
    const j = (i + 1) % envelopeMCoords.length;
    const dx = envelopeMCoords[j].east - envelopeMCoords[i].east;
    const dy = envelopeMCoords[j].north - envelopeMCoords[i].north;
    const faceSouth = dy < 0;
    const faceEast = dx > 0;

    if (faceSouth || faceEast) {
      ctx.beginPath();
      ctx.moveTo(ground[i].x, ground[i].y);
      ctx.lineTo(ground[j].x, ground[j].y);
      ctx.lineTo(top[j].x, top[j].y);
      ctx.lineTo(top[i].x, top[i].y);
      ctx.closePath();
      ctx.fillStyle = "rgba(29, 122, 62, 0.08)";
      ctx.fill();
      ctx.strokeStyle = "rgba(29, 122, 62, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Top face
  ctx.beginPath();
  ctx.moveTo(top[0].x, top[0].y);
  for (let i = 1; i < top.length; i++) ctx.lineTo(top[i].x, top[i].y);
  ctx.closePath();
  ctx.fillStyle = "rgba(29, 122, 62, 0.06)";
  ctx.fill();
  ctx.strokeStyle = "rgba(29, 122, 62, 0.4)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ─── Setback dimension lines ────────────────────────────────────────────────
function drawSetbackLines(ctx, project, parcelMCoords, envelopeMCoords, setbacks) {
  // Find approximate edge midpoints for annotation placement
  if (parcelMCoords.length < 3 || envelopeMCoords.length < 3) return;

  function midpoint(arr, i, j) {
    return {
      east: (arr[i % arr.length].east + arr[j % arr.length].east) / 2,
      north: (arr[i % arr.length].north + arr[j % arr.length].north) / 2,
    };
  }

  // Simple approach: put setback labels near parcel edges
  const pMid = midpoint(parcelMCoords, 0, 1); // "front" edge
  const fp = project(pMid.east, pMid.north + 2, 1);
  drawLabel(ctx, fp.x, fp.y, `${setbacks.front}m`, "#d02818", 12, true);

  const pMidBack = midpoint(parcelMCoords, 2, 3);
  const fb = project(pMidBack.east, pMidBack.north - 2, 1);
  drawLabel(ctx, fb.x, fb.y, `${setbacks.back}m`, "#888", 11);

  const pMidLeft = midpoint(parcelMCoords, 1, 2);
  const fl = project(pMidLeft.east - 2, pMidLeft.north, 1);
  drawLabel(ctx, fl.x, fl.y, `${setbacks.side}m`, "#888", 11);

  const pMidRight = midpoint(parcelMCoords, 3, 0);
  const fr = project(pMidRight.east + 2, pMidRight.north, 1);
  drawLabel(ctx, fr.x, fr.y, `${setbacks.side}m`, "#888", 11);
}

// ─── Label helper ───────────────────────────────────────────────────────────
function drawLabel(ctx, x, y, txt, color, size, bold) {
  ctx.font = `${bold ? "700" : "500"} ${size}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "center";
  // White halo
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = size > 12 ? 4 : 3;
  ctx.lineJoin = "round";
  ctx.strokeText(txt, x, y);
  // Text
  ctx.fillStyle = color;
  ctx.fillText(txt, x, y);
}

// ─── Overlays (legend, compass, annotations, stats bar) ─────────────────────
function drawOverlays(ctx, W, H, BH, project, parcelMCoords, p) {
  const {
    site_area, land_width, land_depth, buildable_fp,
    setback_front, setback_side, setback_back,
    city, district, zoning, terrain_context, buildingCount,
  } = p;

  // ─── Center annotation ──────────────────
  const parcelCenter = {
    east: parcelMCoords.reduce((s, p2) => s + p2.east, 0) / parcelMCoords.length,
    north: parcelMCoords.reduce((s, p2) => s + p2.north, 0) / parcelMCoords.length,
  };
  const pc = project(parcelCenter.east, parcelCenter.north, 0);

  drawLabel(ctx, pc.x, pc.y - 40, "Enveloppe constructible", "#d02818", 15);
  drawLabel(ctx, pc.x, pc.y - 16, `${buildable_fp} m²`, "#1d7a3e", 24, true);
  drawLabel(ctx, pc.x, pc.y + 10, `${site_area} m² · ${land_width}×${land_depth}m`, "#666", 12);

  // "Accès principal" at front edge
  const frontMid = {
    east: (parcelMCoords[0].east + parcelMCoords[1 % parcelMCoords.length].east) / 2,
    north: (parcelMCoords[0].north + parcelMCoords[1 % parcelMCoords.length].north) / 2,
  };
  const fmp = project(frontMid.east, frontMid.north + 8, 0);
  drawLabel(ctx, fmp.x, fmp.y, "Accès principal ↓", "#d02818", 16, true);

  // ─── Compass (north arrow, top-right) ──────
  ctx.save();
  ctx.translate(W - 60, 60);
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fill();
  ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1.5; ctx.stroke();
  // North is "up-left" in our axo view
  const nAngle = -Math.PI / 6; // 30° left of vertical (matches axo north)
  ctx.rotate(nAngle);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -2); ctx.lineTo(0, -8); ctx.lineTo(5, -2); ctx.closePath();
  ctx.fillStyle = "#d02818"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 2); ctx.lineTo(0, 8); ctx.lineTo(5, 2); ctx.closePath();
  ctx.fillStyle = "#bbb"; ctx.fill();
  ctx.font = "bold 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#d02818";
  ctx.fillText("N", 0, -22);
  ctx.restore();

  // ─── Legend ──────────────────────────────
  const legItems = [
    { type: "rect", fill: "rgba(208,40,24,0.18)", stroke: "#d02818", label: `Parcelle — ${site_area} m²` },
    { type: "line", stroke: "#d02818", dash: true, label: "Enveloppe constructible" },
    { type: "rect", fill: "#eae5db", stroke: "#b5b0a5", label: `Bâtiments 3D (${buildingCount})` },
    { type: "rect", fill: "rgba(29,122,62,0.08)", stroke: "rgba(29,122,62,0.4)", label: "Volume constructible" },
    { type: "line", stroke: "#d5d0c8", label: "Voirie" },
  ];
  const legW = 290, legH = 22 + legItems.length * 28 + 16;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.06)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.beginPath(); ctx.roundRect(16, 16, legW, legH, 10); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#e8e5e0"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();

  legItems.forEach((item, i) => {
    const iy = 16 + 18 + i * 28;
    if (item.type === "rect") {
      ctx.fillStyle = item.fill;
      ctx.beginPath(); ctx.roundRect(30, iy, 16, 12, 2); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(30, iy + 6); ctx.lineTo(46, iy + 6);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2.5;
      if (item.dash) ctx.setLineDash([5, 3]);
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.font = "12px Arial"; ctx.fillStyle = "#555"; ctx.textAlign = "left";
    ctx.fillText(item.label, 56, iy + 11);
  });
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© OpenStreetMap contributors", 30, 16 + legH - 6);

  // ─── Stats bar ──────────────────────────
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
  console.log("═══ /generate (Axonometric Iso3D Massing) ═══");

  const {
    lead_id, client_name, polygon_points, site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp, setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    image_size = 900, slide_name = "slide_4_axo",
  } = req.body;

  if (!lead_id || !polygon_points)
    return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });

  // Parse polygon
  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
  if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });

  const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
  const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
  console.log(`Centre: ${cLat.toFixed(6)}, ${cLon.toFixed(6)}`);

  // Convert parcel to meters
  const parcelMCoords = coords.map(c => geoToM(c.lat, c.lon, cLat, cLon));

  // Compute envelope in meters
  const envelopeMCoords = computeEnvelope(
    coords, cLat, cLon,
    Number(setback_front), Number(setback_side), Number(setback_back)
  );

  // Calculate axo scale: fit parcel + surroundings in canvas
  const parcelExtent = Math.max(
    Math.max(...parcelMCoords.map(p => Math.abs(p.east))),
    Math.max(...parcelMCoords.map(p => Math.abs(p.north))),
    15
  );
  const viewExtent = parcelExtent * 5; // Show 5x parcel size for context

  const W = 1280;
  const H = 1280;
  const BH = Math.round(H * 0.12);

  // Scale: pixels per meter in the axo projection
  // Factor 0.35 accounts for the axo angle compression
  const axoScale = (W * 0.35) / viewExtent;
  console.log(`Parcel extent: ${parcelExtent.toFixed(0)}m, View: ${viewExtent.toFixed(0)}m, Scale: ${axoScale.toFixed(2)} px/m`);

  try {
    // ── 1. FETCH OSM DATA ──────────────────────────────────────────────────
    const osmData = await fetchOSMData({ lat: cLat, lon: cLon }, Math.round(viewExtent));
    console.log(`OSM data fetched (${Date.now() - t0}ms)`);

    // ── 2. CREATE CANVAS + PROJECTION ──────────────────────────────────────
    const canvas = createCanvas(W, H + BH);
    const ctx = canvas.getContext("2d");

    // Background
    ctx.fillStyle = "#f5f2ec";
    ctx.fillRect(0, 0, W, H);

    // Axonometric projection — shift center slightly up to leave room for stats bar
    const project = createAxoProjection(axoScale, W, H, -H * 0.05);

    // ── 3. DRAW SCENE (back-to-front) ──────────────────────────────────────

    // Ground grid
    drawGroundPlane(ctx, project, viewExtent);

    // Roads
    drawRoads(ctx, project, osmData.roads, cLat, cLon);

    // Buildings (isometric 3D)
    const buildingCount = drawBuildings(ctx, project, osmData.buildings, cLat, cLon, parcelMCoords);

    // Parcel outline (ground level)
    drawParcel(ctx, project, parcelMCoords);

    // Envelope (dashed, ground level)
    drawEnvelope(ctx, project, envelopeMCoords);

    // Buildable volume (translucent 3D box)
    drawBuildableVolume(ctx, project, envelopeMCoords, 12);

    // Setback dimension lines
    drawSetbackLines(ctx, project, parcelMCoords, envelopeMCoords, {
      front: Number(setback_front), side: Number(setback_side), back: Number(setback_back),
    });

    // ── 4. OVERLAYS ────────────────────────────────────────────────────────
    drawOverlays(ctx, W, H, BH, project, parcelMCoords, {
      site_area: Number(site_area), land_width: Number(land_width),
      land_depth: Number(land_depth), buildable_fp: Number(buildable_fp),
      setback_front: Number(setback_front), setback_side: Number(setback_side),
      setback_back: Number(setback_back),
      city: city || "", district: district || "", zoning: zoning || "",
      terrain_context: terrain_context || "", buildingCount,
    });

    const png = canvas.toBuffer("image/png");
    console.log(`Final PNG: ${png.length} bytes, ${W}x${H + BH} (${Date.now() - t0}ms)`);

    // ── 5. UPLOAD TO SUPABASE ──────────────────────────────────────────────
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
      buildings_count: buildingCount,
      roads_count: osmData.roads.length,
      engine: "axo-iso3d-vector-v8",
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error("Error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`BARLO Axo Service v8.0 on port ${PORT}`);
  console.log(`Engine: Axonometric Iso3D Vector (pure canvas)`);
  console.log(`No Mapbox/tiles needed — 100% vector rendering`);
  console.log(`Supabase: ${SUPABASE_URL ? "OK" : "MISSING"}`);
});
