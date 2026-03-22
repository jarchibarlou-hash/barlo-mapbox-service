const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas } = require("canvas");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

app.get("/health", (req, res) => res.json({ ok: true }));

// ─── Maths géo ────────────────────────────────────────────────────────────────
const R_EARTH = 6371000;

function toM(lat, lon, cLat, cLon) {
  return {
    x: (lon - cLon) * Math.PI / 180 * R_EARTH * Math.cos(cLat * Math.PI / 180),
    y: (lat - cLat) * Math.PI / 180 * R_EARTH,
  };
}

function centroidLatLon(coords) {
  return {
    lat: coords.reduce((s, p) => s + p.lat, 0) / coords.length,
    lon: coords.reduce((s, p) => s + p.lon, 0) / coords.length,
  };
}

// Projection axonométrique isométrique
function axo(mx, my, mz, sc, cx, cy) {
  const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
  return {
    x: cx + (mx - my) * c30 * sc,
    y: cy - (mx + my) * s30 * sc - mz * sc * 0.85,
  };
}

function hav(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function brng(p1, p2) {
  const dLon = (p2.lon - p1.lon) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(p2.lat * Math.PI / 180);
  const x = Math.cos(p1.lat * Math.PI / 180) * Math.sin(p2.lat * Math.PI / 180)
           - Math.sin(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ─── Enveloppe constructible ──────────────────────────────────────────────────
function computeEnvelope(coords, cLat, cLon, front, side, back) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const n = pts.length;

  let maxLat = -Infinity, rb = 0;
  for (let i = 0; i < n - 1; i++) {
    const ml = (coords[i].lat + coords[i+1].lat) / 2;
    if (ml > maxLat) { maxLat = ml; rb = brng(coords[i], coords[i+1]); }
  }

  function setSB(b) {
    let d = ((b - rb) + 360) % 360; if (d > 180) d = 360 - d;
    return d < 45 ? front : d < 135 ? side : back;
  }
  function offSeg(p1, p2, dist) {
    const dx = p2.x-p1.x, dy = p2.y-p1.y, len = Math.sqrt(dx*dx+dy*dy)+0.001;
    return { p1:{x:p1.x-dy/len*dist, y:p1.y+dx/len*dist}, p2:{x:p2.x-dy/len*dist, y:p2.y+dx/len*dist} };
  }
  function intersect(s1, s2) {
    const d1x=s1.p2.x-s1.p1.x, d1y=s1.p2.y-s1.p1.y, d2x=s2.p2.x-s2.p1.x, d2y=s2.p2.y-s2.p1.y;
    const den = d1x*d2y-d1y*d2x;
    if (Math.abs(den)<1e-10) return {x:(s1.p2.x+s2.p1.x)/2, y:(s1.p2.y+s2.p1.y)/2};
    const t = ((s2.p1.x-s1.p1.x)*d2y-(s2.p1.y-s1.p1.y)*d2x)/den;
    return {x:s1.p1.x+t*d1x, y:s1.p1.y+t*d1y};
  }

  const segs = [];
  for (let i = 0; i < n; i++) {
    const b = brng(coords[i], coords[(i+1)%n]);
    segs.push(offSeg(pts[i], pts[(i+1)%n], setSB(b)));
  }
  const envM = segs.map((_, i) => intersect(segs[(i+n-1)%n], segs[i]));
  return envM.map(m => ({
    lat: cLat + m.y / R_EARTH * 180 / Math.PI,
    lon: cLon + m.x / (R_EARTH * Math.cos(cLat * Math.PI / 180)) * 180 / Math.PI,
  }));
}

// ─── OSM fetch ────────────────────────────────────────────────────────────────
async function fetchOSM(cLat, cLon, radius) {
  const q = `[out:json][timeout:30];(way["building"](around:${radius},${cLat},${cLon});way["highway"](around:${radius},${cLat},${cLon}););out geom tags;`;
  const mirrors = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  let resp = null;
  for (const m of mirrors) {
    try {
      resp = await fetch(`${m}?data=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(20000) });
      if (resp.ok) { console.log("OSM OK:", m); break; }
    } catch { continue; }
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
      for (let i = 0; i < geom.length - 1; i++) {
        const m1 = toM(geom[i].lat, geom[i].lon, cLat, cLon);
        const m2 = toM(geom[i+1].lat, geom[i+1].lon, cLat, cLon);
        area += m1.x * m2.y - m2.x * m1.y;
      }
      area = Math.abs(area) / 2;
      const lv = parseInt(tags["building:levels"] || tags["levels"] || "0") || 0;
      const levels = lv || (area > 600 ? 5 : area > 300 ? 4 : area > 120 ? 3 : area > 50 ? 2 : 1);
      buildings.push({ geom, levels, name: tags.name || "", area });
    } else if (tags.highway) {
      roads.push({ geom, name: tags.name || tags.ref || "", type: tags.highway });
    }
  }

  buildings.sort((a, b) => {
    const ca = centroidLatLon(a.geom), cb = centroidLatLon(b.geom);
    return hav(cLat, cLon, ca.lat, ca.lon) - hav(cLat, cLon, cb.lat, cb.lon);
  });

  return {
    buildings: buildings.slice(0, 60),
    roads: roads.filter(r => ["primary","secondary","tertiary","residential","unclassified","service"].includes(r.type)).slice(0, 20),
  };
}

// ─── PRNG déterministe ────────────────────────────────────────────────────────
function seededRand(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length-1; i < poly.length; j = i++) {
    const xi=poly[i].x, yi=poly[i].y, xj=poly[j].x, yj=poly[j].y;
    if (((yi>py)!=(yj>py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi)) inside = !inside;
  }
  return inside;
}

function distPtSeg(px, py, ax, ay, bx, by) {
  const dx=bx-ax, dy=by-ay, lenSq=dx*dx+dy*dy;
  if (lenSq===0) return Math.sqrt((px-ax)**2+(py-ay)**2);
  const t = Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/lenSq));
  return Math.sqrt((px-(ax+t*dx))**2+(py-(ay+t*dy))**2);
}

function generateSyntheticBuildings(cLat, cLon, parcelMeters, radius, roads) {
  const seed = Math.round(Math.abs(cLat*137.508+cLon*251.663)*1000) % 0x7fffffff;
  const rand = seededRand(seed);

  // Segments de routes pour exclusion
  const roadSegs = [];
  const bufMap = { primary:14, secondary:11, tertiary:9, residential:7, unclassified:6, service:5 };
  for (const r of roads) {
    const buf = (bufMap[r.type] || 5) + 2;
    const pts = r.geom.map(p => toM(p.lat, p.lon, cLat, cLon));
    for (let i = 0; i < pts.length-1; i++)
      roadSegs.push({ ax:pts[i].x, ay:pts[i].y, bx:pts[i+1].x, by:pts[i+1].y, buf });
  }

  const pMinX = Math.min(...parcelMeters.map(p=>p.x)) - 8;
  const pMaxX = Math.max(...parcelMeters.map(p=>p.x)) + 8;
  const pMinY = Math.min(...parcelMeters.map(p=>p.y)) - 8;
  const pMaxY = Math.max(...parcelMeters.map(p=>p.y)) + 8;

  const buildings = [];
  const cellSize = 11, gap = 3;
  const gridCount = Math.ceil(radius / (cellSize + gap));

  for (let gx = -gridCount; gx <= gridCount; gx++) {
    for (let gy = -gridCount; gy <= gridCount; gy++) {
      const baseX = gx*(cellSize+gap), baseY = gy*(cellSize+gap);
      const dist = Math.sqrt(baseX*baseX+baseY*baseY);
      if (dist > radius) continue;
      if (baseX>pMinX&&baseX<pMaxX&&baseY>pMinY&&baseY<pMaxY) continue;

      const fillProb = dist<60?0.88:dist<120?0.82:dist<180?0.72:0.60;
      if (rand() > fillProb) continue;

      const isBig = rand() < 0.13;
      const minW = isBig?16:5, maxW = isBig?28:13;
      const w = minW + rand()*(maxW-minW);
      const d = minW*0.7 + rand()*(maxW*0.95-minW*0.7);

      const bx = baseX + (rand()-0.5)*gap*0.6;
      const by = baseY + (rand()-0.5)*gap*0.6;

      if (bx>pMinX&&bx<pMaxX&&by>pMinY&&by<pMaxY) continue;
      if (pointInPoly(bx, by, parcelMeters)) continue;
      if (roadSegs.some(s => distPtSeg(bx,by,s.ax,s.ay,s.bx,s.by) < s.buf)) continue;

      const angle = (rand()-0.5)*0.09;
      const ca = Math.cos(angle), sa = Math.sin(angle);
      const corners = [
        {x:-w/2,y:-d/2},{x:w/2,y:-d/2},{x:w/2,y:d/2},{x:-w/2,y:d/2}
      ].map(c => ({ x: bx+c.x*ca-c.y*sa, y: by+c.x*sa+c.y*ca }));

      const geom = corners.map(c => ({
        lat: cLat + c.y/R_EARTH*180/Math.PI,
        lon: cLon + c.x/(R_EARTH*Math.cos(cLat*Math.PI/180))*180/Math.PI,
      }));

      const lvlRand = rand();
      const levels = lvlRand<0.18?1:lvlRand<0.52?2:lvlRand<0.76?3:lvlRand<0.91?4:5;
      buildings.push({ geom, levels, name:"", area:w*d });
    }
  }
  return buildings;
}

// ─── RENDU CANVAS ─────────────────────────────────────────────────────────────
function renderAxo(canvas, params) {
  const ctx = canvas.getContext("2d");
  const { W, H, BH, cLat, cLon, coords, envelopeCoords, buildings, roads,
          site_area, land_width, land_depth, buildable_fp,
          setback_front, setback_side, setback_back,
          city, district, zoning, terrain_context } = params;

  const pMtrs = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const allX = pMtrs.map(p => p.x), allY = pMtrs.map(p => p.y);
  const ext = Math.max(
    Math.max(...allX) - Math.min(...allX),
    Math.max(...allY) - Math.min(...allY), 30
  );
  const sc = (W * 0.20) / ext;
  const cx = W * 0.50, cy = H * 0.50;

  // Fond
  ctx.fillStyle = "#f2f0ec";
  ctx.fillRect(0, 0, W, H + BH);

  // ── Routes ─────────────────────────────────────────────────────────────────
  const roadCfg = {
    primary:     { w:14, fill:"#eae4d4", border:"#ccc4ae" },
    secondary:   { w:10, fill:"#eae4d4", border:"#ccc4ae" },
    tertiary:    { w:8,  fill:"#eee8da", border:"#d0c8b4" },
    residential: { w:6,  fill:"#f0ece2", border:"#d8d2c4" },
    unclassified:{ w:5,  fill:"#f0ece2", border:"#d8d2c4" },
    service:     { w:3,  fill:"#f4f1e8", border:"#dedad0" },
  };

  const sortedRoads = [...roads].sort((a,b) => {
    const o = {primary:3,secondary:2,tertiary:1};
    return (o[a.type]||0)-(o[b.type]||0);
  });

  for (const r of sortedRoads) {
    if (r.geom.length < 2) continue;
    const pts = r.geom.map(c => { const m = toM(c.lat,c.lon,cLat,cLon); return axo(m.x,m.y,0,sc,cx,cy); });
    const cfg = roadCfg[r.type] || { w:3, fill:"#f0ece2", border:"#d8d2c4" };

    ctx.beginPath();
    pts.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
    ctx.strokeStyle = cfg.border;
    ctx.lineWidth = cfg.w + 3;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.stroke();

    ctx.beginPath();
    pts.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
    ctx.strokeStyle = cfg.fill;
    ctx.lineWidth = cfg.w;
    ctx.stroke();

    // Nom de rue
    if (r.name && ["primary","secondary","tertiary","residential"].includes(r.type) && pts.length > 1) {
      const mid = Math.floor(pts.length/2);
      const mp = pts[mid], mpN = pts[Math.min(mid+1,pts.length-1)];
      const ang = Math.atan2(mpN.y-mp.y, mpN.x-mp.x);
      const adj = ang>Math.PI/2||ang<-Math.PI/2 ? ang+Math.PI : ang;
      ctx.save();
      ctx.translate(mp.x, mp.y-5);
      ctx.rotate(adj);
      ctx.font = "italic 10px Arial";
      ctx.textAlign = "center";
      ctx.strokeStyle = "white"; ctx.lineWidth = 4;
      ctx.strokeText(r.name.substring(0,28), 0, 0);
      ctx.fillStyle = "#6a5e44";
      ctx.fillText(r.name.substring(0,28), 0, 0);
      ctx.restore();
    }
  }

  // ── Bâtiments — painter's algorithm ────────────────────────────────────────
  const allBldgs = buildings.map(b => {
    const bc = centroidLatLon(b.geom);
    return { ...b, dist: hav(cLat, cLon, bc.lat, bc.lon) };
  }).sort((a,b) => b.dist-a.dist);

  for (const b of allBldgs) {
    if (b.dist < 4) continue;
    const pts = b.geom.map(c => toM(c.lat,c.lon,cLat,cLon));
    const h = b.levels * 3.2;
    const n = pts.length;

    const gPts = pts.map(p => axo(p.x,p.y,0,sc,cx,cy));
    const rPts = pts.map(p => axo(p.x,p.y,h,sc,cx,cy));

    // Ombre portée au sol — HEX solide
    const shOff = h * sc * 0.45;
    ctx.beginPath();
    gPts.forEach((p,i) => i===0 ? ctx.moveTo(p.x+shOff,p.y+shOff*0.42) : ctx.lineTo(p.x+shOff,p.y+shOff*0.42));
    ctx.closePath();
    ctx.fillStyle = "#c8c4bc";
    ctx.fill();

    // Sol du bâtiment
    ctx.beginPath();
    gPts.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
    ctx.closePath();
    ctx.fillStyle = "#eceae6";
    ctx.fill();

    // Faces latérales
    for (let i = 0; i < n; i++) {
      const j = (i+1)%n;
      const p1g = axo(pts[i].x,pts[i].y,0,sc,cx,cy);
      const p2g = axo(pts[j].x,pts[j].y,0,sc,cx,cy);
      const p1r = axo(pts[i].x,pts[i].y,h,sc,cx,cy);
      const p2r = axo(pts[j].x,pts[j].y,h,sc,cx,cy);
      const dx = pts[j].x-pts[i].x, dy = pts[j].y-pts[i].y;
      const len = Math.sqrt(dx*dx+dy*dy)+0.001;
      const isShadow = (-dx/len*0.7+dy/len*0.3) < 0;

      ctx.beginPath();
      ctx.moveTo(p1g.x,p1g.y);
      ctx.lineTo(p2g.x,p2g.y);
      ctx.lineTo(p2r.x,p2r.y);
      ctx.lineTo(p1r.x,p1r.y);
      ctx.closePath();
      ctx.fillStyle = isShadow ? "#9e9990" : "#f5f3ef";
      ctx.fill();
      ctx.strokeStyle = isShadow ? "#8e8980" : "#ccc8c0";
      ctx.lineWidth = 0.4;
      ctx.stroke();
    }

    // Toit
    ctx.beginPath();
    rPts.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#bbb8b0";
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  // ── Parcelle cible ─────────────────────────────────────────────────────────
  const parcelPts = coords.map(c => toM(c.lat,c.lon,cLat,cLon));
  const parcelPx = parcelPts.map(p => axo(p.x,p.y,0,sc,cx,cy));

  ctx.beginPath();
  parcelPx.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
  ctx.closePath();
  ctx.fillStyle = "rgba(208,40,24,0.15)";
  ctx.fill();
  ctx.strokeStyle = "#d02818";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // ── Enveloppe constructible ────────────────────────────────────────────────
  const envPts = envelopeCoords.map(c => toM(c.lat,c.lon,cLat,cLon));
  const envPx = envPts.map(p => axo(p.x,p.y,0,sc,cx,cy));

  ctx.beginPath();
  envPx.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
  ctx.closePath();
  ctx.strokeStyle = "#d02818";
  ctx.lineWidth = 2;
  ctx.setLineDash([10,5]);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Annotations ────────────────────────────────────────────────────────────
  function drawText(x, y, txt, color, size, bold=false, anchor="center") {
    ctx.font = `${bold?"700":"500"} ${size}px Arial`;
    ctx.textAlign = anchor;
    ctx.strokeStyle = "white"; ctx.lineWidth = 5;
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y);
  }

  // Centroïde parcelle en axo
  const pCtr = axo(0,0,0,sc,cx,cy);

  // Segment nord → annotation accès principal
  let maxLat = -Infinity, northIdx = 0;
  for (let i = 0; i < coords.length-1; i++) {
    const ml = (coords[i].lat+coords[(i+1)%coords.length].lat)/2;
    if (ml > maxLat) { maxLat=ml; northIdx=i; }
  }
  const pm0=parcelPts[northIdx], pm1=parcelPts[(northIdx+1)%parcelPts.length];
  const midM = {x:(pm0.x+pm1.x)/2, y:(pm0.y+pm1.y)/2};
  const midAxo = axo(midM.x,midM.y,0,sc,cx,cy);

  const fA = axo(midM.x,midM.y,0,sc,cx,cy);
  const fB = axo(midM.x,midM.y+setback_front,0,sc,cx,cy);

  ctx.beginPath();
  ctx.moveTo(fA.x,fA.y); ctx.lineTo(fB.x,fB.y);
  ctx.strokeStyle="#d02818"; ctx.lineWidth=1.5;
  ctx.setLineDash([6,3]); ctx.stroke(); ctx.setLineDash([]);
  drawText((fA.x+fB.x)/2,(fA.y+fB.y)/2-10,`+${setback_front}m`,"#d02818",13,true);
  drawText(midAxo.x,midAxo.y-18,"Accès principal","#d02818",12,true);
  drawText(pCtr.x,pCtr.y+14,`${land_width}m × ${land_depth}m`,"#333",11);

  // ── Boussole ───────────────────────────────────────────────────────────────
  ctx.save();
  ctx.translate(W-52, 52);
  ctx.beginPath(); ctx.arc(0,0,22,0,2*Math.PI);
  ctx.fillStyle="white"; ctx.fill();
  ctx.strokeStyle="#e0dbd4"; ctx.lineWidth=1; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0,-16); ctx.lineTo(-4,-2); ctx.lineTo(0,-6); ctx.lineTo(4,-2);
  ctx.closePath(); ctx.fillStyle="#1a1a1a"; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0,16); ctx.lineTo(-4,2); ctx.lineTo(0,6); ctx.lineTo(4,2);
  ctx.closePath(); ctx.fillStyle="#cccccc"; ctx.fill();
  ctx.font="bold 9px Arial"; ctx.textAlign="center"; ctx.fillStyle="#1a1a1a";
  ctx.fillText("N",0,-20);
  ctx.restore();

  // ── Légende ────────────────────────────────────────────────────────────────
  ctx.fillStyle="white";
  ctx.beginPath();
  ctx.roundRect(12,12,185,70,5);
  ctx.fill();
  ctx.strokeStyle="#e4e0d8"; ctx.lineWidth=1; ctx.stroke();

  ctx.fillStyle="#f2e2e0";
  ctx.beginPath(); ctx.roundRect(22,22,12,10,2); ctx.fill();
  ctx.strokeStyle="#d02818"; ctx.lineWidth=2; ctx.stroke();
  ctx.font="10px Arial"; ctx.fillStyle="#444"; ctx.textAlign="left";
  ctx.fillText(`Parcelle (${site_area} m²)`,40,32);

  ctx.beginPath(); ctx.moveTo(22,43); ctx.lineTo(34,43);
  ctx.strokeStyle="#d02818"; ctx.lineWidth=1.5;
  ctx.setLineDash([5,2]); ctx.stroke(); ctx.setLineDash([]);
  ctx.font="10px Arial"; ctx.fillStyle="#444";
  ctx.fillText("Enveloppe constructible",40,48);
  ctx.font="7px Arial"; ctx.fillStyle="#bbb";
  ctx.fillText("© OpenStreetMap contributors",22,64);

  // ── Bande stats ────────────────────────────────────────────────────────────
  const BY = H;
  ctx.fillStyle="#ffffff";
  ctx.fillRect(0,BY,W,BH);

  ctx.beginPath(); ctx.moveTo(0,BY); ctx.lineTo(W,BY);
  ctx.strokeStyle="#d02818"; ctx.lineWidth=3; ctx.stroke();

  const C1=24, C2=220, C3=410, C4=590;
  ctx.textAlign="left";

  ctx.font="bold 16px Arial"; ctx.fillStyle="#111";
  ctx.fillText("Lecture stratégique du site",C1,BY+30);
  ctx.font="9px Arial"; ctx.fillStyle="#aaa";
  ctx.fillText(`${city} · ${district} · Zoning : ${zoning}`,C1,BY+48);

  ctx.beginPath(); ctx.moveTo(C1,BY+56); ctx.lineTo(W-C1,BY+56);
  ctx.strokeStyle="#f0ede8"; ctx.lineWidth=1; ctx.stroke();

  ctx.font="8px Arial"; ctx.fillStyle="#bbb";
  ctx.fillText("Surface parcelle",C1,BY+72);
  ctx.font="bold 22px Arial"; ctx.fillStyle="#111";
  ctx.fillText(`${site_area} m²`,C1,BY+94);

  ctx.font="8px Arial"; ctx.fillStyle="#bbb";
  ctx.fillText("Dimensions",C2,BY+72);
  ctx.font="bold 17px Arial"; ctx.fillStyle="#111";
  ctx.fillText(`${land_width}m × ${land_depth}m`,C2,BY+94);

  ctx.font="8px Arial"; ctx.fillStyle="#bbb";
  ctx.fillText("Empreinte constructible",C3,BY+72);
  ctx.font="bold 22px Arial"; ctx.fillStyle="#1d7a3e";
  ctx.fillText(`${buildable_fp} m²`,C3,BY+94);

  ctx.font="8px Arial"; ctx.fillStyle="#bbb";
  ctx.fillText("Retraits réglementaires",C4,BY+72);
  ctx.font="600 10px Arial"; ctx.fillStyle="#333";
  ctx.fillText(`Avant : ${setback_front}m · Côtés : ${setback_side}m`,C4,BY+86);
  ctx.fillText(`Arrière : ${setback_back}m`,C4,BY+100);

  ctx.beginPath(); ctx.moveTo(C1,BY+112); ctx.lineTo(W-C1,BY+112);
  ctx.strokeStyle="#f0ede8"; ctx.lineWidth=1; ctx.stroke();

  ctx.font="8px Arial"; ctx.fillStyle="#ccc";
  ctx.fillText((terrain_context||"").substring(0,120),C1,BY+128);

  ctx.textAlign="right"; ctx.font="7px Arial"; ctx.fillStyle="#ddd";
  ctx.fillText("BARLO · Diagnostic foncier",W-C1,BY+BH-10);
}

// ─── ENDPOINT PRINCIPAL ───────────────────────────────────────────────────────
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("→ /generate received");

  const {
    lead_id, client_name, polygon_points,
    site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp,
    setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    image_size = 900, osm_radius = 240,
    slide_name = "slide_4_axo",
  } = req.body;

  if (!lead_id || !polygon_points)
    return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });

  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));

  if (coords.length < 3)
    return res.status(400).json({ error: "polygon_points invalide" });

  const cLat = coords.reduce((s,p)=>s+p.lat,0)/coords.length;
  const cLon = coords.reduce((s,p)=>s+p.lon,0)/coords.length;
  console.log(`Centroïde: ${cLat}, ${cLon}`);

  const envelopeCoords = computeEnvelope(
    coords, cLat, cLon,
    Number(setback_front), Number(setback_side), Number(setback_back)
  );

  try {
    // OSM
    console.log("Fetching OSM...");
    const osm = await fetchOSM(cLat, cLon, Number(osm_radius));
    console.log(`OSM: ${osm.buildings.length} bâtiments, ${osm.roads.length} routes`);

    // Bâtiments synthétiques
    const pMtrs = coords.map(c => toM(c.lat,c.lon,cLat,cLon));
    const synthBuildings = generateSyntheticBuildings(cLat, cLon, pMtrs, 220, osm.roads);
    console.log(`Synthetic: ${synthBuildings.length} bâtiments`);

    // Fusion OSM + synthétiques
    const osmCentres = osm.buildings.map(b => centroidLatLon(b.geom));
    const filteredSynth = synthBuildings.filter(sb => {
      const sc2 = centroidLatLon(sb.geom);
      return !osmCentres.some(ob => hav(sc2.lat,sc2.lon,ob.lat,ob.lon) < 12);
    });
    const allBuildings = [
      ...osm.buildings,
      ...filteredSynth,
    ];
    console.log(`Total buildings: ${allBuildings.length}`);

    // Rendu canvas
    const W = Number(image_size), BH = 170, H = W;
    console.log("Rendering canvas...");
    const canvas = createCanvas(W, H + BH);
    renderAxo(canvas, {
      W, H, BH, cLat, cLon,
      coords, envelopeCoords,
      buildings: allBuildings,
      roads: osm.roads,
      site_area: Number(site_area),
      land_width: Number(land_width), land_depth: Number(land_depth),
      envelope_w: Number(envelope_w), envelope_d: Number(envelope_d),
      buildable_fp: Number(buildable_fp),
      setback_front: Number(setback_front),
      setback_side: Number(setback_side),
      setback_back: Number(setback_back),
      city: city||"", district: district||"",
      zoning: zoning||"", terrain_context: terrain_context||"",
    });

    const pngBuffer = canvas.toBuffer("image/png");
    console.log(`Canvas PNG: ${pngBuffer.length} bytes (${Date.now()-t0}ms)`);

    // Upload Supabase
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const slug = String(client_name||"client").toLowerCase().trim()
      .replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"");
    const path = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;

    const { error: ue } = await sb.storage.from("massing-images")
      .upload(path, pngBuffer, { contentType:"image/png", upsert:true });
    if (ue) return res.status(500).json({ error: ue.message });

    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(path);
    console.log(`Done: ${pd.publicUrl} (${Date.now()-t0}ms)`);

    return res.json({
      ok: true,
      public_url: pd.publicUrl,
      path,
      centroid: { lat: cLat, lon: cLon },
      osm_stats: { buildings: osm.buildings.length, roads: osm.roads.length, synthetic: filteredSynth.length },
      duration_ms: Date.now()-t0,
    });

  } catch (e) {
    console.error("Error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`BARLO Canvas Axo Service running on port ${PORT}`);
  console.log(`Mapbox token: ${MAPBOX_TOKEN ? "OK" : "not needed"}`);
  console.log(`Supabase: ${SUPABASE_URL ? "OK" : "MISSING"}`);
});
