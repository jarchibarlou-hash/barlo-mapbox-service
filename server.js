const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas } = require("canvas");
const zlib = require("zlib");
const { promisify } = require("util");
const gunzip = promisify(zlib.gunzip);

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

app.get("/health", (req, res) => res.json({ ok: true }));

// ─── Maths géo ────────────────────────────────────────────────────────────────
const R_EARTH = 6371000;

function toM(lat, lon, cLat, cLon) {
  return {
    x: (lon-cLon)*Math.PI/180*R_EARTH*Math.cos(cLat*Math.PI/180),
    y: (lat-cLat)*Math.PI/180*R_EARTH,
  };
}

function centroidLL(coords) {
  return {
    lat: coords.reduce((s,p)=>s+p.lat,0)/coords.length,
    lon: coords.reduce((s,p)=>s+p.lon,0)/coords.length,
  };
}

function axo(mx, my, mz, sc, cx, cy) {
  const c30=Math.cos(Math.PI/6), s30=Math.sin(Math.PI/6);
  return { x: cx+(mx-my)*c30*sc, y: cy-(mx+my)*s30*sc-mz*sc*0.85 };
}

function hav(lat1, lon1, lat2, lon2) {
  const dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R_EARTH*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function brng(p1, p2) {
  const dLon=(p2.lon-p1.lon)*Math.PI/180;
  const y=Math.sin(dLon)*Math.cos(p2.lat*Math.PI/180);
  const x=Math.cos(p1.lat*Math.PI/180)*Math.sin(p2.lat*Math.PI/180)
          -Math.sin(p1.lat*Math.PI/180)*Math.cos(p2.lat*Math.PI/180)*Math.cos(dLon);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}

// ─── Quadkey (Bing Maps tile system) ─────────────────────────────────────────
function latLonToQuadkey(lat, lon, level) {
  // Convertir lat/lon en tile x,y puis en quadkey
  const sinLat = Math.sin(lat * Math.PI / 180);
  const pixelX = ((lon + 180) / 360) * (1 << level);
  const pixelY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * (1 << level);
  const tileX = Math.floor(Math.max(0, Math.min(pixelX, (1 << level) - 1)));
  const tileY = Math.floor(Math.max(0, Math.min(pixelY, (1 << level) - 1)));

  let quadkey = "";
  for (let i = level; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((tileX & mask) !== 0) digit += 1;
    if ((tileY & mask) !== 0) digit += 2;
    quadkey += digit.toString();
  }
  return quadkey;
}

// ─── Microsoft Buildings fetch ────────────────────────────────────────────────
// Stratégie : on essaie plusieurs niveaux de quadkey (9→8→7) pour trouver des tiles
async function fetchMicrosoftBuildings(cLat, cLon, radiusM) {
  console.log("Fetching Microsoft Buildings...");

  // On essaie quadkey niveau 9 (tile ~5km), puis 8 si pas trouvé
  for (const level of [9, 8]) {
    const qk = latLonToQuadkey(cLat, cLon, level);
    console.log(`Trying quadkey level ${level}: ${qk}`);

    try {
      // 1. Chercher l'URL du tile dans dataset-links.csv
      const linksUrl = `https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv`;
      const linksResp = await fetch(linksUrl, { signal: AbortSignal.timeout(15000) });
      if (!linksResp.ok) {
        console.log("dataset-links.csv not accessible");
        break;
      }

      const linksText = await linksResp.text();
      const lines = linksText.split("\n");
      console.log(`dataset-links.csv: ${lines.length} lines total`);

      // Chercher les lignes contenant ce quadkey
      const matchingLines = lines.filter(line => line.includes(qk));
      if (matchingLines.length === 0) {
        console.log(`No tile found for quadkey ${qk}`);
        continue;
      }
      console.log(`Found ${matchingLines.length} tile(s) for quadkey ${qk}`);
      console.log(`First match raw: ${matchingLines[0].substring(0, 200)}`);

      // Parser CSV : Location,QuadKey,Size,UploadDate,Url
      // L'URL peut contenir des virgules dans le path donc on prend tout après le 4ème comma
      const parts = matchingLines[0].split(",");
      console.log(`Parts count: ${parts.length}`);
      // L'URL commence par https — trouver l'index
      const urlIdx = parts.findIndex(p => p.trim().startsWith("https"));
      const tileUrl = urlIdx >= 0 ? parts.slice(urlIdx).join(",").trim() : parts[parts.length-1].trim();
      console.log(`Tile URL: ${tileUrl.substring(0, 120)}`);
      if (!tileUrl.startsWith("https")) {
        console.log("URL invalid, skipping");
        continue;
      }

      // 2. Télécharger + décompresser le tile .csv.gz
      console.log("Downloading tile...");
      const tileResp = await fetch(tileUrl, { signal: AbortSignal.timeout(25000) });
      console.log(`Tile response status: ${tileResp.status}`);
      if (!tileResp.ok) {
        const errBody = await tileResp.text();
        console.log(`Tile download failed: ${tileResp.status} — ${errBody.substring(0,100)}`);
        continue;
      }

      const tileBuffer = Buffer.from(await tileResp.arrayBuffer());
      console.log(`Tile downloaded: ${tileBuffer.length} bytes`);

      const decompressed = await gunzip(tileBuffer);
      const text = decompressed.toString("utf8");
      console.log(`Decompressed: ${text.length} chars`);

      // 3. Parser les bâtiments Microsoft
      // Format : CSV avec colonne "geometry" contenant du JSON, ou GeoJSON ligne par ligne
      const buildings = [];
      const lines2 = text.split("\n");
      const firstLine = lines2[0]?.trim() || "";
      console.log(`Tile format sample: ${firstLine.substring(0,100)}`);

      // Détecter CSV vs GeoJSON
      const isCSV = !firstLine.startsWith("{");
      let startLine = 0;
      if (isCSV) {
        startLine = 1; // skip header
        console.log("CSV format detected");
      } else {
        console.log("GeoJSON format detected");
      }

      for (let li = startLine; li < lines2.length; li++) {
        const line = lines2[li];
        if (!line?.trim()) continue;
        try {
          let coordsRaw = null;
          let height = 0;

          if (isCSV) {
            // Extraire le JSON de géométrie entre { et }
            const jsonStart = line.indexOf("{");
            const jsonEnd = line.lastIndexOf("}");
            if (jsonStart === -1 || jsonEnd === -1) continue;
            const jsonStr = line.substring(jsonStart, jsonEnd+1).replace(/""/g, '"');
            const geomObj = JSON.parse(jsonStr);
            coordsRaw = geomObj.coordinates?.[0];
            // Extraire hauteur si présente après le JSON
            const afterJson = line.substring(jsonEnd+2);
            if (afterJson) height = parseFloat(afterJson) || 0;
          } else {
            const feature = JSON.parse(line);
            coordsRaw = feature.geometry?.coordinates?.[0];
            const props = feature.properties || {};
            height = parseFloat(props.height || props.Height || 0) || 0;
          }

          if (!coordsRaw || coordsRaw.length < 3) continue;
          const geom = coordsRaw.map(c => ({ lat: c[1], lon: c[0] }));
          const center = centroidLL(geom);
          const dist = hav(cLat, cLon, center.lat, center.lon);
          if (dist > radiusM) continue;

          const levels = height > 0
            ? Math.max(1, Math.round(height / 3.2))
            : estimateLevels(geom, cLat, cLon);

          buildings.push({ geom, levels, name: "", area: estimateArea(geom, cLat, cLon) });
        } catch { continue; }
      }

      console.log(`Microsoft Buildings in radius: ${buildings.length}`);

      if (buildings.length > 0) {
        // Trier par distance (painter's algo)
        buildings.sort((a, b) => {
          const ca = centroidLL(a.geom), cb = centroidLL(b.geom);
          return hav(cLat, cLon, ca.lat, ca.lon) - hav(cLat, cLon, cb.lat, cb.lon);
        });
        return buildings.slice(0, 300); // max 300 bâtiments
      }

    } catch(e) {
      console.log(`Error fetching quadkey ${qk}:`, e.message);
    }
  }

  console.log("Microsoft Buildings fetch failed — using OSM only");
  return [];
}

function estimateLevels(geom, cLat, cLon) {
  const area = estimateArea(geom, cLat, cLon);
  return area > 600 ? 5 : area > 300 ? 4 : area > 120 ? 3 : area > 50 ? 2 : 1;
}

function estimateArea(geom, cLat, cLon) {
  let area = 0;
  for (let i = 0; i < geom.length - 1; i++) {
    const m1 = toM(geom[i].lat, geom[i].lon, cLat, cLon);
    const m2 = toM(geom[i+1].lat, geom[i+1].lon, cLat, cLon);
    area += m1.x * m2.y - m2.x * m1.y;
  }
  return Math.abs(area) / 2;
}

// ─── OSM fetch (routes uniquement) ───────────────────────────────────────────
async function fetchOSMRoads(cLat, cLon, radius) {
  const q = `[out:json][timeout:25];(way["highway"](around:${radius},${cLat},${cLon}););out geom tags;`;
  const mirrors = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  let resp = null;
  for (const m of mirrors) {
    try {
      resp = await fetch(`${m}?data=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(18000) });
      if (resp.ok) { console.log("OSM roads OK:", m); break; }
    } catch { continue; }
  }
  if (!resp || !resp.ok) return [];
  const data = await resp.json();
  const roads = [];
  for (const el of data.elements || []) {
    const geom = (el.geometry || []).map(p => ({ lat: p.lat, lon: p.lon }));
    if (geom.length < 2) continue;
    const tags = el.tags || {};
    if (tags.highway && ["primary","secondary","tertiary","residential","unclassified","service","living_street"].includes(tags.highway)) {
      roads.push({ geom, name: tags.name || tags.ref || "", type: tags.highway });
    }
  }
  return roads.slice(0, 25);
}

// ─── Enveloppe constructible ──────────────────────────────────────────────────
function computeEnvelope(coords, cLat, cLon, front, side, back) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const n = pts.length;
  let maxLat = -Infinity, rb = 0;
  for (let i = 0; i < n-1; i++) {
    const ml = (coords[i].lat+coords[i+1].lat)/2;
    if (ml > maxLat) { maxLat=ml; rb=brng(coords[i],coords[i+1]); }
  }
  function setSB(b) {
    let d=((b-rb)+360)%360; if(d>180)d=360-d;
    return d<45?front:d<135?side:back;
  }
  function offSeg(p1,p2,dist) {
    const dx=p2.x-p1.x,dy=p2.y-p1.y,len=Math.sqrt(dx*dx+dy*dy)+0.001;
    return {p1:{x:p1.x-dy/len*dist,y:p1.y+dx/len*dist},p2:{x:p2.x-dy/len*dist,y:p2.y+dx/len*dist}};
  }
  function intersect(s1,s2) {
    const d1x=s1.p2.x-s1.p1.x,d1y=s1.p2.y-s1.p1.y,d2x=s2.p2.x-s2.p1.x,d2y=s2.p2.y-s2.p1.y;
    const den=d1x*d2y-d1y*d2x;
    if(Math.abs(den)<1e-10)return{x:(s1.p2.x+s2.p1.x)/2,y:(s1.p2.y+s2.p1.y)/2};
    const t=((s2.p1.x-s1.p1.x)*d2y-(s2.p1.y-s1.p1.y)*d2x)/den;
    return{x:s1.p1.x+t*d1x,y:s1.p1.y+t*d1y};
  }
  const segs=[];
  for(let i=0;i<n;i++){
    const b=brng(coords[i],coords[(i+1)%n]);
    segs.push(offSeg(pts[i],pts[(i+1)%n],setSB(b)));
  }
  const envM=segs.map((_,i)=>intersect(segs[(i+n-1)%n],segs[i]));
  return envM.map(m=>({
    lat:cLat+m.y/R_EARTH*180/Math.PI,
    lon:cLon+m.x/(R_EARTH*Math.cos(cLat*Math.PI/180))*180/Math.PI,
  }));
}

// ─── RENDU CANVAS ─────────────────────────────────────────────────────────────
function renderAxo(canvas, p) {
  const ctx = canvas.getContext("2d");
  const { W, H, BH, cLat, cLon, coords, envelopeCoords, buildings, roads,
    site_area, land_width, land_depth, buildable_fp,
    setback_front, setback_side, setback_back,
    city, district, zoning, terrain_context } = p;

  const pMtrs = coords.map(c => toM(c.lat,c.lon,cLat,cLon));
  const allX = pMtrs.map(q=>q.x), allY = pMtrs.map(q=>q.y);
  const ext = Math.max(Math.max(...allX)-Math.min(...allX),Math.max(...allY)-Math.min(...allY),30);
  const sc = (W*0.20)/ext;
  const cx = W*0.50, cy = H*0.50;

  // Fond crème style Hektar
  ctx.fillStyle = "#f2f0ec";
  ctx.fillRect(0, 0, W, H+BH);

  // ── Routes ────────────────────────────────────────────────────────────────
  const roadCfg = {
    primary:     {w:14,fill:"#eae4d4",border:"#ccc4ae"},
    secondary:   {w:10,fill:"#eae4d4",border:"#ccc4ae"},
    tertiary:    {w:8, fill:"#eee8da",border:"#d0c8b4"},
    residential: {w:6, fill:"#f0ece2",border:"#d8d2c4"},
    unclassified:{w:5, fill:"#f0ece2",border:"#d8d2c4"},
    service:     {w:3, fill:"#f4f1e8",border:"#dedad0"},
    living_street:{w:3,fill:"#f4f1e8",border:"#dedad0"},
  };
  const sortedRoads = [...roads].sort((a,b)=>{
    const o={primary:3,secondary:2,tertiary:1};
    return (o[a.type]||0)-(o[b.type]||0);
  });
  for (const r of sortedRoads) {
    if (r.geom.length<2) continue;
    const pts = r.geom.map(c=>{const m=toM(c.lat,c.lon,cLat,cLon);return axo(m.x,m.y,0,sc,cx,cy);});
    const cfg = roadCfg[r.type]||{w:3,fill:"#f0ece2",border:"#d8d2c4"};
    ctx.beginPath();
    pts.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
    ctx.strokeStyle=cfg.border; ctx.lineWidth=cfg.w+3;
    ctx.lineCap="round"; ctx.lineJoin="round"; ctx.stroke();
    ctx.beginPath();
    pts.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
    ctx.strokeStyle=cfg.fill; ctx.lineWidth=cfg.w; ctx.stroke();
    if (r.name&&["primary","secondary","tertiary","residential"].includes(r.type)&&pts.length>1) {
      const mid=Math.floor(pts.length/2);
      const mp=pts[mid],mpN=pts[Math.min(mid+1,pts.length-1)];
      const ang=Math.atan2(mpN.y-mp.y,mpN.x-mp.x);
      const adj=ang>Math.PI/2||ang<-Math.PI/2?ang+Math.PI:ang;
      ctx.save();
      ctx.translate(mp.x,mp.y-5); ctx.rotate(adj);
      ctx.font="italic 10px Arial"; ctx.textAlign="center";
      ctx.strokeStyle="white"; ctx.lineWidth=4;
      ctx.strokeText(r.name.substring(0,28),0,0);
      ctx.fillStyle="#6a5e44"; ctx.fillText(r.name.substring(0,28),0,0);
      ctx.restore();
    }
  }

  // ── Bâtiments — painter's algorithm ─────────────────────────────────────
  const allBldgs = buildings.map(b=>{
    const bc=centroidLL(b.geom);
    return{...b,dist:hav(cLat,cLon,bc.lat,bc.lon)};
  }).sort((a,b)=>b.dist-a.dist);

  for (const b of allBldgs) {
    if (b.dist<4) continue;
    const pts = b.geom.map(c=>toM(c.lat,c.lon,cLat,cLon));
    if (pts.length<3) continue;
    const h = b.levels*3.2;
    const n = pts.length;
    const gPts = pts.map(pt=>axo(pt.x,pt.y,0,sc,cx,cy));
    const rPts = pts.map(pt=>axo(pt.x,pt.y,h,sc,cx,cy));

    // Ombre portée — couleur solide
    const shOff = h*sc*0.45;
    ctx.beginPath();
    gPts.forEach((pt,i)=>i===0?ctx.moveTo(pt.x+shOff,pt.y+shOff*0.42):ctx.lineTo(pt.x+shOff,pt.y+shOff*0.42));
    ctx.closePath();
    ctx.fillStyle="#c4c0b8"; ctx.fill();

    // Sol
    ctx.beginPath();
    gPts.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
    ctx.closePath();
    ctx.fillStyle="#eceae6"; ctx.fill();

    // Faces latérales — ombre/lumière style Hektar
    for (let i=0;i<n;i++) {
      const j=(i+1)%n;
      const p1g=axo(pts[i].x,pts[i].y,0,sc,cx,cy);
      const p2g=axo(pts[j].x,pts[j].y,0,sc,cx,cy);
      const p1r=axo(pts[i].x,pts[i].y,h,sc,cx,cy);
      const p2r=axo(pts[j].x,pts[j].y,h,sc,cx,cy);
      const dx=pts[j].x-pts[i].x,dy=pts[j].y-pts[i].y;
      const len=Math.sqrt(dx*dx+dy*dy)+0.001;
      const isShadow=(-dx/len*0.7+dy/len*0.3)<0;
      ctx.beginPath();
      ctx.moveTo(p1g.x,p1g.y); ctx.lineTo(p2g.x,p2g.y);
      ctx.lineTo(p2r.x,p2r.y); ctx.lineTo(p1r.x,p1r.y);
      ctx.closePath();
      // Hektar : face lumière #f5f3ef, face ombre #9a9690
      ctx.fillStyle=isShadow?"#9a9690":"#f5f3ef";
      ctx.fill();
      ctx.strokeStyle=isShadow?"#8a8680":"#ccc8c0";
      ctx.lineWidth=0.4; ctx.stroke();
    }

    // Toit blanc
    ctx.beginPath();
    rPts.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
    ctx.closePath();
    ctx.fillStyle="#ffffff"; ctx.fill();
    ctx.strokeStyle="#bbb8b0"; ctx.lineWidth=0.6; ctx.stroke();
  }

  // ── Parcelle cible ────────────────────────────────────────────────────────
  const parcelPts=coords.map(c=>toM(c.lat,c.lon,cLat,cLon));
  const parcelPx=parcelPts.map(pt=>axo(pt.x,pt.y,0,sc,cx,cy));
  ctx.beginPath();
  parcelPx.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
  ctx.closePath();
  ctx.fillStyle="rgba(208,40,24,0.15)"; ctx.fill();
  ctx.strokeStyle="#d02818"; ctx.lineWidth=2.5; ctx.stroke();

  // ── Enveloppe constructible ───────────────────────────────────────────────
  const envPts=envelopeCoords.map(c=>toM(c.lat,c.lon,cLat,cLon));
  const envPx=envPts.map(pt=>axo(pt.x,pt.y,0,sc,cx,cy));
  ctx.beginPath();
  envPx.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
  ctx.closePath();
  ctx.strokeStyle="#d02818"; ctx.lineWidth=2;
  ctx.setLineDash([10,5]); ctx.stroke(); ctx.setLineDash([]);

  // ── Annotations ───────────────────────────────────────────────────────────
  function drawText(x,y,txt,color,size,bold=false,anchor="center") {
    ctx.font=`${bold?"700":"500"} ${size}px Arial`;
    ctx.textAlign=anchor;
    ctx.strokeStyle="white"; ctx.lineWidth=5;
    ctx.strokeText(txt,x,y);
    ctx.fillStyle=color; ctx.fillText(txt,x,y);
  }

  const pCtr=axo(0,0,0,sc,cx,cy);
  let maxLat=-Infinity,northIdx=0;
  for(let i=0;i<coords.length-1;i++){
    const ml=(coords[i].lat+coords[(i+1)%coords.length].lat)/2;
    if(ml>maxLat){maxLat=ml;northIdx=i;}
  }
  const pm0=parcelPts[northIdx],pm1=parcelPts[(northIdx+1)%parcelPts.length];
  const midM={x:(pm0.x+pm1.x)/2,y:(pm0.y+pm1.y)/2};
  const midAxo=axo(midM.x,midM.y,0,sc,cx,cy);
  const fA=axo(midM.x,midM.y,0,sc,cx,cy);
  const fB=axo(midM.x,midM.y+setback_front,0,sc,cx,cy);

  ctx.beginPath(); ctx.moveTo(fA.x,fA.y); ctx.lineTo(fB.x,fB.y);
  ctx.strokeStyle="#d02818"; ctx.lineWidth=1.5;
  ctx.setLineDash([6,3]); ctx.stroke(); ctx.setLineDash([]);
  drawText((fA.x+fB.x)/2,(fA.y+fB.y)/2-10,`+${setback_front}m`,"#d02818",13,true);
  drawText(midAxo.x,midAxo.y-18,"Accès principal","#d02818",12,true);
  drawText(pCtr.x,pCtr.y+14,`${land_width}m × ${land_depth}m`,"#333",11);

  // ── Boussole ──────────────────────────────────────────────────────────────
  ctx.save();
  ctx.translate(W-52,52);
  ctx.beginPath(); ctx.arc(0,0,22,0,2*Math.PI);
  ctx.fillStyle="white"; ctx.fill();
  ctx.strokeStyle="#e0dbd4"; ctx.lineWidth=1; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0,-16); ctx.lineTo(-4,-2); ctx.lineTo(0,-6); ctx.lineTo(4,-2);
  ctx.closePath(); ctx.fillStyle="#1a1a1a"; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0,16); ctx.lineTo(-4,2); ctx.lineTo(0,6); ctx.lineTo(4,2);
  ctx.closePath(); ctx.fillStyle="#cccccc"; ctx.fill();
  ctx.font="bold 9px Arial"; ctx.textAlign="center";
  ctx.fillStyle="#1a1a1a"; ctx.fillText("N",0,-20);
  ctx.restore();

  // ── Légende ───────────────────────────────────────────────────────────────
  ctx.fillStyle="white";
  ctx.beginPath(); ctx.roundRect(12,12,190,70,5);
  ctx.fill(); ctx.strokeStyle="#e4e0d8"; ctx.lineWidth=1; ctx.stroke();
  ctx.fillStyle="#f2e2e0";
  ctx.beginPath(); ctx.roundRect(22,22,12,10,2);
  ctx.fill(); ctx.strokeStyle="#d02818"; ctx.lineWidth=2; ctx.stroke();
  ctx.font="10px Arial"; ctx.fillStyle="#444"; ctx.textAlign="left";
  ctx.fillText(`Parcelle (${site_area} m²)`,40,32);
  ctx.beginPath(); ctx.moveTo(22,43); ctx.lineTo(34,43);
  ctx.strokeStyle="#d02818"; ctx.lineWidth=1.5;
  ctx.setLineDash([5,2]); ctx.stroke(); ctx.setLineDash([]);
  ctx.font="10px Arial"; ctx.fillStyle="#444";
  ctx.fillText("Enveloppe constructible",40,48);
  ctx.font="7px Arial"; ctx.fillStyle="#bbb";
  ctx.fillText("© Microsoft Buildings · © OpenStreetMap",22,64);

  // ── Bande stats ───────────────────────────────────────────────────────────
  const BY=H;
  ctx.fillStyle="#ffffff"; ctx.fillRect(0,BY,W,BH);
  ctx.beginPath(); ctx.moveTo(0,BY); ctx.lineTo(W,BY);
  ctx.strokeStyle="#d02818"; ctx.lineWidth=3; ctx.stroke();

  const C1=24,C2=220,C3=410,C4=590;
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
  const t0=Date.now();
  console.log("→ /generate received");

  const {
    lead_id,client_name,polygon_points,
    site_area,land_width,land_depth,
    envelope_w,envelope_d,buildable_fp,
    setback_front,setback_side,setback_back,
    terrain_context,city,district,zoning,
    image_size=900,osm_radius=240,
    slide_name="slide_4_axo",
  } = req.body;

  if (!lead_id||!polygon_points)
    return res.status(400).json({error:"lead_id et polygon_points obligatoires"});

  const coords=polygon_points.split("|").map(pt=>{
    const [lat,lon]=pt.trim().split(",").map(Number);
    return{lat,lon};
  }).filter(p=>!isNaN(p.lat)&&!isNaN(p.lon));

  if (coords.length<3)
    return res.status(400).json({error:"polygon_points invalide"});

  const cLat=coords.reduce((s,p)=>s+p.lat,0)/coords.length;
  const cLon=coords.reduce((s,p)=>s+p.lon,0)/coords.length;
  console.log(`Centroïde: ${cLat}, ${cLon}`);

  const envelopeCoords=computeEnvelope(
    coords,cLat,cLon,
    Number(setback_front),Number(setback_side),Number(setback_back)
  );

  try {
    // Fetch en parallèle : Microsoft Buildings + OSM Routes
    console.log("Fetching data in parallel...");
    const [msBuildings, osmRoads] = await Promise.all([
      fetchMicrosoftBuildings(cLat, cLon, Number(osm_radius)),
      fetchOSMRoads(cLat, cLon, Number(osm_radius)),
    ]);
    console.log(`MS Buildings: ${msBuildings.length}, OSM Roads: ${osmRoads.length}`);

    const W=Number(image_size), BH=170, H=W;
    console.log("Rendering canvas...");
    const canvas=createCanvas(W,H+BH);
    renderAxo(canvas,{
      W,H,BH,cLat,cLon,
      coords,envelopeCoords,
      buildings:msBuildings,
      roads:osmRoads,
      site_area:Number(site_area),
      land_width:Number(land_width),land_depth:Number(land_depth),
      envelope_w:Number(envelope_w),envelope_d:Number(envelope_d),
      buildable_fp:Number(buildable_fp),
      setback_front:Number(setback_front),
      setback_side:Number(setback_side),
      setback_back:Number(setback_back),
      city:city||"",district:district||"",
      zoning:zoning||"",terrain_context:terrain_context||"",
    });

    const pngBuffer=canvas.toBuffer("image/png");
    console.log(`PNG: ${pngBuffer.length} bytes (${Date.now()-t0}ms)`);

    const sb=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY);
    const slug=String(client_name||"client").toLowerCase().trim()
      .replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"");
    const path=`hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;

    const{error:ue}=await sb.storage.from("massing-images")
      .upload(path,pngBuffer,{contentType:"image/png",upsert:true});
    if(ue)return res.status(500).json({error:ue.message});

    const{data:pd}=sb.storage.from("massing-images").getPublicUrl(path);
    console.log(`Done: ${pd.publicUrl} (${Date.now()-t0}ms)`);

    return res.json({
      ok:true,public_url:pd.publicUrl,path,
      centroid:{lat:cLat,lon:cLon},
      stats:{ms_buildings:msBuildings.length,osm_roads:osmRoads.length},
      duration_ms:Date.now()-t0,
    });

  } catch(e) {
    console.error("Error:",e);
    return res.status(500).json({error:String(e)});
  }
});

app.listen(PORT,()=>{
  console.log(`BARLO MS Buildings Service running on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL?"OK":"MISSING"}`);
});
