const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas } = require("canvas");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get("/health", (req, res) => res.json({ ok: true }));

const R_EARTH = 6371000;

function toM(lat, lon, cLat, cLon) {
  return {
    x: (lon-cLon)*Math.PI/180*R_EARTH*Math.cos(cLat*Math.PI/180),
    y: (lat-cLat)*Math.PI/180*R_EARTH,
  };
}
function centroidLL(coords) {
  return { lat:coords.reduce((s,p)=>s+p.lat,0)/coords.length, lon:coords.reduce((s,p)=>s+p.lon,0)/coords.length };
}
function axo(mx,my,mz,sc,cx,cy) {
  const c30=Math.cos(Math.PI/6),s30=Math.sin(Math.PI/6);
  return { x:cx+(mx-my)*c30*sc, y:cy-(mx+my)*s30*sc-mz*sc*0.85 };
}
function hav(lat1,lon1,lat2,lon2) {
  const dLat=(lat2-lat1)*Math.PI/180,dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R_EARTH*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function brng(p1,p2) {
  const dLon=(p2.lon-p1.lon)*Math.PI/180;
  const y=Math.sin(dLon)*Math.cos(p2.lat*Math.PI/180);
  const x=Math.cos(p1.lat*Math.PI/180)*Math.sin(p2.lat*Math.PI/180)-Math.sin(p1.lat*Math.PI/180)*Math.cos(p2.lat*Math.PI/180)*Math.cos(dLon);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}

// ─── Enveloppe constructible ──────────────────────────────────────────────────
function computeEnvelope(coords,cLat,cLon,front,side,back) {
  const pts=coords.map(c=>toM(c.lat,c.lon,cLat,cLon));
  const n=pts.length;
  let maxLat=-Infinity,rb=0;
  for(let i=0;i<n-1;i++){
    const ml=(coords[i].lat+coords[i+1].lat)/2;
    if(ml>maxLat){maxLat=ml;rb=brng(coords[i],coords[i+1]);}
  }
  function setSB(b){let d=((b-rb)+360)%360;if(d>180)d=360-d;return d<45?front:d<135?side:back;}
  function offSeg(p1,p2,dist){
    const dx=p2.x-p1.x,dy=p2.y-p1.y,len=Math.sqrt(dx*dx+dy*dy)+0.001;
    return{p1:{x:p1.x-dy/len*dist,y:p1.y+dx/len*dist},p2:{x:p2.x-dy/len*dist,y:p2.y+dx/len*dist}};
  }
  function intersect(s1,s2){
    const d1x=s1.p2.x-s1.p1.x,d1y=s1.p2.y-s1.p1.y,d2x=s2.p2.x-s2.p1.x,d2y=s2.p2.y-s2.p1.y;
    const den=d1x*d2y-d1y*d2x;
    if(Math.abs(den)<1e-10)return{x:(s1.p2.x+s2.p1.x)/2,y:(s1.p2.y+s2.p1.y)/2};
    const t=((s2.p1.x-s1.p1.x)*d2y-(s2.p1.y-s1.p1.y)*d2x)/den;
    return{x:s1.p1.x+t*d1x,y:s1.p1.y+t*d1y};
  }
  const segs=[];
  for(let i=0;i<n;i++){const b=brng(coords[i],coords[(i+1)%n]);segs.push(offSeg(pts[i],pts[(i+1)%n],setSB(b)));}
  const envM=segs.map((_,i)=>intersect(segs[(i+n-1)%n],segs[i]));
  return envM.map(m=>({lat:cLat+m.y/R_EARTH*180/Math.PI,lon:cLon+m.x/(R_EARTH*Math.cos(cLat*Math.PI/180))*180/Math.PI}));
}

// ─── OSM — bâtiments + routes ─────────────────────────────────────────────────
async function fetchOSM(cLat,cLon,radius) {
  const q=`[out:json][timeout:25];(way["building"](around:${radius},${cLat},${cLon});way["highway"](around:${radius},${cLat},${cLon}););out geom tags;`;
  const mirrors=["https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter"];
  let resp=null;
  for(const m of mirrors){
    try{resp=await fetch(`${m}?data=${encodeURIComponent(q)}`,{signal:AbortSignal.timeout(20000)});if(resp.ok){console.log("OSM OK:",m);break;}}catch{continue;}
  }
  if(!resp||!resp.ok)return{buildings:[],roads:[]};
  const data=await resp.json();
  const buildings=[],roads=[];
  for(const el of data.elements||[]){
    const geom=(el.geometry||[]).map(p=>({lat:p.lat,lon:p.lon}));
    if(geom.length<3)continue;
    const tags=el.tags||{};
    if(tags.building){
      let area=0;
      for(let i=0;i<geom.length-1;i++){const m1=toM(geom[i].lat,geom[i].lon,cLat,cLon),m2=toM(geom[i+1].lat,geom[i+1].lon,cLat,cLon);area+=m1.x*m2.y-m2.x*m1.y;}
      area=Math.abs(area)/2;
      const lv=parseInt(tags["building:levels"]||tags["levels"]||"0")||0;
      const levels=lv||(area>600?5:area>300?4:area>120?3:area>50?2:1);
      buildings.push({geom,levels,name:tags.name||"",area});
    } else if(tags.highway&&["primary","secondary","tertiary","residential","unclassified","service","living_street"].includes(tags.highway)){
      roads.push({geom,name:tags.name||tags.ref||"",type:tags.highway});
    }
  }
  buildings.sort((a,b)=>{const ca=centroidLL(a.geom),cb=centroidLL(b.geom);return hav(cLat,cLon,ca.lat,ca.lon)-hav(cLat,cLon,cb.lat,cb.lon);});
  return{buildings:buildings.slice(0,80),roads:roads.slice(0,25)};
}

// ─── Bâtiments synthétiques (complément OSM) ──────────────────────────────────
function seededRand(seed){let s=seed;return()=>{s=(s*1664525+1013904223)&0xffffffff;return(s>>>0)/0xffffffff;};}
function pointInPoly(px,py,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;if(((yi>py)!=(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi))inside=!inside;}return inside;}
function distPtSeg(px,py,ax,ay,bx,by){const dx=bx-ax,dy=by-ay,lenSq=dx*dx+dy*dy;if(lenSq===0)return Math.sqrt((px-ax)**2+(py-ay)**2);const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/lenSq));return Math.sqrt((px-(ax+t*dx))**2+(py-(ay+t*dy))**2);}

function generateSynthetic(cLat,cLon,parcelM,radius,roads,osmBuildings) {
  const seed=Math.round(Math.abs(cLat*137.508+cLon*251.663)*1000)%0x7fffffff;
  const rand=seededRand(seed);
  const roadSegs=[];
  const bufMap={primary:14,secondary:11,tertiary:9,residential:7,unclassified:6,service:5,living_street:5};
  for(const r of roads){
    const buf=(bufMap[r.type]||5)+2;
    const pts=r.geom.map(p=>toM(p.lat,p.lon,cLat,cLon));
    for(let i=0;i<pts.length-1;i++)roadSegs.push({ax:pts[i].x,ay:pts[i].y,bx:pts[i+1].x,by:pts[i+1].y,buf});
  }
  const osmCentres=osmBuildings.map(b=>centroidLL(b.geom));
  const pMinX=Math.min(...parcelM.map(p=>p.x))-8,pMaxX=Math.max(...parcelM.map(p=>p.x))+8;
  const pMinY=Math.min(...parcelM.map(p=>p.y))-8,pMaxY=Math.max(...parcelM.map(p=>p.y))+8;
  const buildings=[];
  const cellSize=11,gap=3,gridCount=Math.ceil(radius/(cellSize+gap));
  for(let gx=-gridCount;gx<=gridCount;gx++){
    for(let gy=-gridCount;gy<=gridCount;gy++){
      const baseX=gx*(cellSize+gap),baseY=gy*(cellSize+gap);
      const dist=Math.sqrt(baseX*baseX+baseY*baseY);
      if(dist>radius)continue;
      if(baseX>pMinX&&baseX<pMaxX&&baseY>pMinY&&baseY<pMaxY)continue;
      const fillProb=dist<60?0.88:dist<120?0.82:dist<180?0.72:0.60;
      if(rand()>fillProb)continue;
      const isBig=rand()<0.13,minW=isBig?16:5,maxW=isBig?28:13;
      const w=minW+rand()*(maxW-minW),d=minW*0.7+rand()*(maxW*0.95-minW*0.7);
      const bx=baseX+(rand()-0.5)*gap*0.6,by=baseY+(rand()-0.5)*gap*0.6;
      if(bx>pMinX&&bx<pMaxX&&by>pMinY&&by<pMaxY)continue;
      if(pointInPoly(bx,by,parcelM))continue;
      if(roadSegs.some(s=>distPtSeg(bx,by,s.ax,s.ay,s.bx,s.by)<s.buf))continue;
      // Exclure si trop proche d'un bâtiment OSM
      const gps={lat:cLat+by/R_EARTH*180/Math.PI,lon:cLon+bx/(R_EARTH*Math.cos(cLat*Math.PI/180))*180/Math.PI};
      if(osmCentres.some(ob=>hav(gps.lat,gps.lon,ob.lat,ob.lon)<15))continue;
      const angle=(rand()-0.5)*0.09,ca=Math.cos(angle),sa=Math.sin(angle);
      const corners=[{x:-w/2,y:-d/2},{x:w/2,y:-d/2},{x:w/2,y:d/2},{x:-w/2,y:d/2}].map(c=>({x:bx+c.x*ca-c.y*sa,y:by+c.x*sa+c.y*ca}));
      const geom=corners.map(c=>({lat:cLat+c.y/R_EARTH*180/Math.PI,lon:cLon+c.x/(R_EARTH*Math.cos(cLat*Math.PI/180))*180/Math.PI}));
      const lvlRand=rand();
      buildings.push({geom,levels:lvlRand<0.18?1:lvlRand<0.52?2:lvlRand<0.76?3:lvlRand<0.91?4:5,name:"",area:w*d,isSynth:true});
    }
  }
  return buildings;
}

// ─── RENDU CANVAS ─────────────────────────────────────────────────────────────
function renderAxo(canvas,p) {
  const ctx=canvas.getContext("2d");
  const {W,H,BH,cLat,cLon,coords,envelopeCoords,buildings,roads,
    site_area,land_width,land_depth,buildable_fp,
    setback_front,setback_side,setback_back,city,district,zoning,terrain_context}=p;

  const pMtrs=coords.map(c=>toM(c.lat,c.lon,cLat,cLon));
  const ext=Math.max(Math.max(...pMtrs.map(q=>q.x))-Math.min(...pMtrs.map(q=>q.x)),Math.max(...pMtrs.map(q=>q.y))-Math.min(...pMtrs.map(q=>q.y)),30);
  const sc=(W*0.20)/ext;
  const cx=W*0.50,cy=H*0.50;

  // Fond crème Hektar
  ctx.fillStyle="#f2f0ec";
  ctx.fillRect(0,0,W,H+BH);

  // ── Routes ────────────────────────────────────────────────────────────────
  const roadCfg={
    primary:{w:14,fill:"#eae4d4",border:"#ccc4ae"},secondary:{w:10,fill:"#eae4d4",border:"#ccc4ae"},
    tertiary:{w:8,fill:"#eee8da",border:"#d0c8b4"},residential:{w:6,fill:"#f0ece2",border:"#d8d2c4"},
    unclassified:{w:5,fill:"#f0ece2",border:"#d8d2c4"},service:{w:3,fill:"#f4f1e8",border:"#dedad0"},
    living_street:{w:3,fill:"#f4f1e8",border:"#dedad0"},
  };
  [...roads].sort((a,b)=>{const o={primary:3,secondary:2,tertiary:1};return(o[a.type]||0)-(o[b.type]||0);})
  .forEach(r=>{
    if(r.geom.length<2)return;
    const pts=r.geom.map(c=>{const m=toM(c.lat,c.lon,cLat,cLon);return axo(m.x,m.y,0,sc,cx,cy);});
    const cfg=roadCfg[r.type]||{w:3,fill:"#f0ece2",border:"#d8d2c4"};
    ctx.beginPath();pts.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
    ctx.strokeStyle=cfg.border;ctx.lineWidth=cfg.w+3;ctx.lineCap="round";ctx.lineJoin="round";ctx.stroke();
    ctx.beginPath();pts.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
    ctx.strokeStyle=cfg.fill;ctx.lineWidth=cfg.w;ctx.stroke();
    if(r.name&&["primary","secondary","tertiary","residential"].includes(r.type)&&pts.length>1){
      const mid=Math.floor(pts.length/2),mp=pts[mid],mpN=pts[Math.min(mid+1,pts.length-1)];
      const ang=Math.atan2(mpN.y-mp.y,mpN.x-mp.x),adj=ang>Math.PI/2||ang<-Math.PI/2?ang+Math.PI:ang;
      ctx.save();ctx.translate(mp.x,mp.y-5);ctx.rotate(adj);ctx.font="italic 10px Arial";ctx.textAlign="center";
      ctx.strokeStyle="white";ctx.lineWidth=4;ctx.strokeText(r.name.substring(0,28),0,0);
      ctx.fillStyle="#6a5e44";ctx.fillText(r.name.substring(0,28),0,0);ctx.restore();
    }
  });

  // ── Bâtiments — painter's algorithm ──────────────────────────────────────
  buildings.map(b=>({...b,dist:hav(cLat,cLon,...(c=>[ c.lat,c.lon])(centroidLL(b.geom)))}))
  .sort((a,b)=>b.dist-a.dist)
  .forEach(b=>{
    if(b.dist<4)return;
    const pts=b.geom.map(c=>toM(c.lat,c.lon,cLat,cLon));
    if(pts.length<3)return;
    const h=b.levels*3.2,n=pts.length;
    const gPts=pts.map(pt=>axo(pt.x,pt.y,0,sc,cx,cy));
    const rPts=pts.map(pt=>axo(pt.x,pt.y,h,sc,cx,cy));
    const shOff=h*sc*0.45;

    // Ombre portée solide
    ctx.beginPath();
    gPts.forEach((pt,i)=>i===0?ctx.moveTo(pt.x+shOff,pt.y+shOff*0.42):ctx.lineTo(pt.x+shOff,pt.y+shOff*0.42));
    ctx.closePath();ctx.fillStyle="#c4c0b8";ctx.fill();

    // Sol
    ctx.beginPath();gPts.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
    ctx.closePath();ctx.fillStyle="#eceae6";ctx.fill();

    // Faces latérales
    for(let i=0;i<n;i++){
      const j=(i+1)%n;
      const p1g=axo(pts[i].x,pts[i].y,0,sc,cx,cy),p2g=axo(pts[j].x,pts[j].y,0,sc,cx,cy);
      const p1r=axo(pts[i].x,pts[i].y,h,sc,cx,cy),p2r=axo(pts[j].x,pts[j].y,h,sc,cx,cy);
      const dx=pts[j].x-pts[i].x,dy=pts[j].y-pts[i].y,len=Math.sqrt(dx*dx+dy*dy)+0.001;
      const isShadow=(-dx/len*0.7+dy/len*0.3)<0;
      ctx.beginPath();ctx.moveTo(p1g.x,p1g.y);ctx.lineTo(p2g.x,p2g.y);ctx.lineTo(p2r.x,p2r.y);ctx.lineTo(p1r.x,p1r.y);ctx.closePath();
      ctx.fillStyle=isShadow?"#9a9690":"#f5f3ef";ctx.fill();
      ctx.strokeStyle=isShadow?"#8a8680":"#ccc8c0";ctx.lineWidth=0.4;ctx.stroke();
    }

    // Toit
    ctx.beginPath();rPts.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
    ctx.closePath();ctx.fillStyle="#ffffff";ctx.fill();ctx.strokeStyle="#bbb8b0";ctx.lineWidth=0.6;ctx.stroke();
  });

  // ── Parcelle ──────────────────────────────────────────────────────────────
  const parcelPts=pMtrs;
  const parcelPx=parcelPts.map(pt=>axo(pt.x,pt.y,0,sc,cx,cy));
  ctx.beginPath();parcelPx.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
  ctx.closePath();ctx.fillStyle="rgba(208,40,24,0.15)";ctx.fill();
  ctx.strokeStyle="#d02818";ctx.lineWidth=2.5;ctx.stroke();

  // ── Enveloppe ─────────────────────────────────────────────────────────────
  const envPts=envelopeCoords.map(c=>toM(c.lat,c.lon,cLat,cLon));
  const envPx=envPts.map(pt=>axo(pt.x,pt.y,0,sc,cx,cy));
  ctx.beginPath();envPx.forEach((pt,i)=>i===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
  ctx.closePath();ctx.strokeStyle="#d02818";ctx.lineWidth=2;ctx.setLineDash([10,5]);ctx.stroke();ctx.setLineDash([]);

  // ── Annotations sur l'image ───────────────────────────────────────────────
  function T(x,y,txt,color,size,bold=false,anchor="center"){
    ctx.font=`${bold?"700":"500"} ${size}px Arial`;ctx.textAlign=anchor;
    ctx.strokeStyle="white";ctx.lineWidth=5;ctx.lineJoin="round";ctx.strokeText(txt,x,y);
    ctx.fillStyle=color;ctx.fillText(txt,x,y);
  }

  const pCtr=axo(0,0,0,sc,cx,cy);
  let maxLat=-Infinity,northIdx=0;
  for(let i=0;i<coords.length-1;i++){const ml=(coords[i].lat+coords[(i+1)%coords.length].lat)/2;if(ml>maxLat){maxLat=ml;northIdx=i;}}
  const pm0=parcelPts[northIdx],pm1=parcelPts[(northIdx+1)%parcelPts.length];
  const midM={x:(pm0.x+pm1.x)/2,y:(pm0.y+pm1.y)/2};
  const midAxo=axo(midM.x,midM.y,0,sc,cx,cy);
  const fA=axo(midM.x,midM.y,0,sc,cx,cy),fB=axo(midM.x,midM.y+setback_front,0,sc,cx,cy);

  // Retrait avant
  ctx.beginPath();ctx.moveTo(fA.x,fA.y);ctx.lineTo(fB.x,fB.y);
  ctx.strokeStyle="#d02818";ctx.lineWidth=1.5;ctx.setLineDash([6,3]);ctx.stroke();ctx.setLineDash([]);
  T((fA.x+fB.x)/2,(fA.y+fB.y)/2-10,`+${setback_front}m`,"#d02818",12,true);

  // Retrait côté
  const si=Math.floor(parcelPts.length*0.25)%parcelPts.length;
  const sA=axo(parcelPts[si].x,parcelPts[si].y,0,sc,cx,cy),sB=axo(parcelPts[si].x-setback_side,parcelPts[si].y,0,sc,cx,cy);
  ctx.beginPath();ctx.moveTo(sA.x,sA.y);ctx.lineTo(sB.x,sB.y);
  ctx.strokeStyle="#555";ctx.lineWidth=1.2;ctx.setLineDash([5,3]);ctx.stroke();ctx.setLineDash([]);
  T((sA.x+sB.x)/2,(sA.y+sB.y)/2-8,`+${setback_side}m`,"#555",11);

  // Retrait arrière
  const bi=Math.floor(parcelPts.length*0.6)%parcelPts.length;
  const bA=axo(parcelPts[bi].x,parcelPts[bi].y,0,sc,cx,cy),bB=axo(parcelPts[bi].x,parcelPts[bi].y-setback_back,0,sc,cx,cy);
  ctx.beginPath();ctx.moveTo(bA.x,bA.y);ctx.lineTo(bB.x,bB.y);
  ctx.strokeStyle="#555";ctx.lineWidth=1.2;ctx.setLineDash([5,3]);ctx.stroke();ctx.setLineDash([]);
  T((bA.x+bB.x)/2,(bA.y+bB.y)/2-8,`+${setback_back}m`,"#555",11);

  // Côte largeur
  const dA=axo(parcelPts[0].x,parcelPts[0].y,0,sc,cx,cy),dB=axo(parcelPts[1%parcelPts.length].x,parcelPts[1%parcelPts.length].y,0,sc,cx,cy);
  ctx.strokeStyle="#555";ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(dA.x,dA.y-14);ctx.lineTo(dB.x,dB.y-14);ctx.stroke();
  ctx.beginPath();ctx.moveTo(dA.x,dA.y-8);ctx.lineTo(dA.x,dA.y-22);ctx.stroke();
  ctx.beginPath();ctx.moveTo(dB.x,dB.y-8);ctx.lineTo(dB.x,dB.y-22);ctx.stroke();
  T((dA.x+dB.x)/2,(dA.y+dB.y)/2-26,`${land_width}m`,"#222",13,true);

  // Labels centre parcelle
  T(midAxo.x,midAxo.y-22,"Accès principal","#d02818",13,true);
  T(pCtr.x,pCtr.y-8,"Enveloppe constructible","#d02818",11);
  T(pCtr.x,pCtr.y+10,`${buildable_fp} m²`,"#1d7a3e",15,true);
  T(pCtr.x,pCtr.y+26,`${site_area} m² · ${land_width}×${land_depth}m`,"#444",10);

  // ── Boussole ──────────────────────────────────────────────────────────────
  ctx.save();ctx.translate(W-54,54);
  ctx.beginPath();ctx.arc(0,0,24,0,2*Math.PI);ctx.fillStyle="white";ctx.fill();ctx.strokeStyle="#ccc";ctx.lineWidth=1;ctx.stroke();
  ctx.beginPath();ctx.moveTo(0,-17);ctx.lineTo(-5,-2);ctx.lineTo(0,-7);ctx.lineTo(5,-2);ctx.closePath();ctx.fillStyle="#1a1a1a";ctx.fill();
  ctx.beginPath();ctx.moveTo(0,17);ctx.lineTo(-5,2);ctx.lineTo(0,7);ctx.lineTo(5,2);ctx.closePath();ctx.fillStyle="#aaa";ctx.fill();
  ctx.font="bold 11px Arial";ctx.textAlign="center";ctx.fillStyle="#1a1a1a";ctx.fillText("N",0,-22);ctx.restore();

  // ── Légende ───────────────────────────────────────────────────────────────
  const legItems=[
    {type:"rect",fill:"#f2e2e0",stroke:"#d02818",label:`Parcelle — ${site_area} m²`},
    {type:"dash",stroke:"#d02818",label:"Enveloppe constructible"},
    {type:"rect",fill:"#f5f3ef",stroke:"#ccc",label:"Bâtiments existants"},
  ];
  const legW=215,legH=10+legItems.length*22+14;
  ctx.fillStyle="white";ctx.beginPath();ctx.roundRect(12,12,legW,legH,6);
  ctx.fill();ctx.strokeStyle="#e0ddd8";ctx.lineWidth=1;ctx.stroke();
  legItems.forEach((item,i)=>{
    const iy=12+10+i*22;
    if(item.type==="rect"){ctx.fillStyle=item.fill;ctx.beginPath();ctx.roundRect(22,iy,14,12,2);ctx.fill();ctx.strokeStyle=item.stroke;ctx.lineWidth=2;ctx.stroke();}
    else{ctx.beginPath();ctx.moveTo(22,iy+6);ctx.lineTo(36,iy+6);ctx.strokeStyle=item.stroke;ctx.lineWidth=2;ctx.setLineDash([5,2]);ctx.stroke();ctx.setLineDash([]);}
    ctx.font="11px Arial";ctx.fillStyle="#333";ctx.textAlign="left";ctx.fillText(item.label,42,iy+10);
  });
  ctx.font="7px Arial";ctx.fillStyle="#bbb";ctx.fillText("© OpenStreetMap contributors",22,12+legH-4);

  // ── Bande stats ───────────────────────────────────────────────────────────
  const BY=H;
  ctx.fillStyle="#ffffff";ctx.fillRect(0,BY,W,BH);
  ctx.beginPath();ctx.moveTo(0,BY);ctx.lineTo(W,BY);ctx.strokeStyle="#d02818";ctx.lineWidth=3;ctx.stroke();
  const C1=24,C2=220,C3=410,C4=590;
  ctx.textAlign="left";
  ctx.font="bold 16px Arial";ctx.fillStyle="#111";ctx.fillText("Lecture stratégique du site",C1,BY+30);
  ctx.font="9px Arial";ctx.fillStyle="#aaa";ctx.fillText(`${city} · ${district} · Zoning : ${zoning}`,C1,BY+48);
  ctx.beginPath();ctx.moveTo(C1,BY+56);ctx.lineTo(W-C1,BY+56);ctx.strokeStyle="#f0ede8";ctx.lineWidth=1;ctx.stroke();
  ctx.font="8px Arial";ctx.fillStyle="#bbb";ctx.fillText("Surface parcelle",C1,BY+72);
  ctx.font="bold 22px Arial";ctx.fillStyle="#111";ctx.fillText(`${site_area} m²`,C1,BY+94);
  ctx.font="8px Arial";ctx.fillStyle="#bbb";ctx.fillText("Dimensions",C2,BY+72);
  ctx.font="bold 17px Arial";ctx.fillStyle="#111";ctx.fillText(`${land_width}m × ${land_depth}m`,C2,BY+94);
  ctx.font="8px Arial";ctx.fillStyle="#bbb";ctx.fillText("Empreinte constructible",C3,BY+72);
  ctx.font="bold 22px Arial";ctx.fillStyle="#1d7a3e";ctx.fillText(`${buildable_fp} m²`,C3,BY+94);
  ctx.font="8px Arial";ctx.fillStyle="#bbb";ctx.fillText("Retraits réglementaires",C4,BY+72);
  ctx.font="600 10px Arial";ctx.fillStyle="#333";
  ctx.fillText(`Avant : ${setback_front}m · Côtés : ${setback_side}m`,C4,BY+86);
  ctx.fillText(`Arrière : ${setback_back}m`,C4,BY+100);
  ctx.beginPath();ctx.moveTo(C1,BY+112);ctx.lineTo(W-C1,BY+112);ctx.strokeStyle="#f0ede8";ctx.lineWidth=1;ctx.stroke();
  ctx.font="8px Arial";ctx.fillStyle="#ccc";ctx.fillText((terrain_context||"").substring(0,120),C1,BY+128);
  ctx.textAlign="right";ctx.font="7px Arial";ctx.fillStyle="#ddd";ctx.fillText("BARLO · Diagnostic foncier",W-C1,BY+BH-10);
}


// ─── DALL-E img2img — amélioration du rendu axo ───────────────────────────────
async function enhanceWithDallE(pngBuffer, W, H) {
  if (!OPENAI_API_KEY) {
    console.log("No OpenAI key — skipping enhancement");
    return null;
  }

  console.log("Enhancing with DALL-E...");

  try {
    // DALL-E 2 edit endpoint — prend une image PNG + mask + prompt
    // On utilise l'image directement sans mask (variation)
    const { FormData, Blob } = await import("node:buffer").then(() => ({
      FormData: global.FormData || require("undici").FormData,
      Blob: global.Blob,
    })).catch(() => ({ FormData: null, Blob: null }));

    // Utiliser fetch avec FormData natif Node 18+
    // DALL-E 2 variations — pas besoin de mask
    // L'image doit être carré PNG max 4MB
    const form = new global.FormData();
    const imageBlob = new Blob([pngBuffer], { type: "image/png" });
    form.append("image", imageBlob, "axo.png");
    form.append("n", "1");
    form.append("size", "1024x1024");
    form.append("response_format", "b64_json");

    const resp = await fetch("https://api.openai.com/v1/images/variations", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.log(`DALL-E error ${resp.status}: ${err.substring(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) { console.log("No b64_json in response"); return null; }

    console.log("DALL-E enhancement OK");
    return Buffer.from(b64, "base64");

  } catch(e) {
    console.log(`DALL-E failed: ${e.message}`);
    return null;
  }
}

// ─── ENDPOINT ─────────────────────────────────────────────────────────────────
app.post("/generate",async(req,res)=>{
  const t0=Date.now();
  console.log("→ /generate");
  const{lead_id,client_name,polygon_points,site_area,land_width,land_depth,
    envelope_w,envelope_d,buildable_fp,setback_front,setback_side,setback_back,
    terrain_context,city,district,zoning,image_size=900,osm_radius=240,slide_name="slide_4_axo"}=req.body;

  if(!lead_id||!polygon_points)return res.status(400).json({error:"lead_id et polygon_points obligatoires"});
  const coords=polygon_points.split("|").map(pt=>{const[lat,lon]=pt.trim().split(",").map(Number);return{lat,lon};}).filter(p=>!isNaN(p.lat)&&!isNaN(p.lon));
  if(coords.length<3)return res.status(400).json({error:"polygon invalide"});

  const cLat=coords.reduce((s,p)=>s+p.lat,0)/coords.length;
  const cLon=coords.reduce((s,p)=>s+p.lon,0)/coords.length;
  console.log(`Centroïde: ${cLat}, ${cLon}`);

  const envelopeCoords=computeEnvelope(coords,cLat,cLon,Number(setback_front),Number(setback_side),Number(setback_back));

  try{
    console.log("Fetching OSM...");
    const osm=await fetchOSM(cLat,cLon,Number(osm_radius));
    console.log(`OSM: ${osm.buildings.length} bâtiments, ${osm.roads.length} routes`);

    const pMtrs=coords.map(c=>toM(c.lat,c.lon,cLat,cLon));
    const synth=generateSynthetic(cLat,cLon,pMtrs,220,osm.roads,osm.buildings);
    console.log(`Synthetic: ${synth.length}`);

    const allBuildings=[...osm.buildings.map(b=>({...b,isSynth:false})),...synth];

    const W=Number(image_size),BH=170,H=W;
    console.log("Rendering...");
    const canvas=createCanvas(W,H+BH);
    renderAxo(canvas,{W,H,BH,cLat,cLon,coords,envelopeCoords,
      buildings:allBuildings,roads:osm.roads,
      site_area:Number(site_area),land_width:Number(land_width),land_depth:Number(land_depth),
      envelope_w:Number(envelope_w),envelope_d:Number(envelope_d),buildable_fp:Number(buildable_fp),
      setback_front:Number(setback_front),setback_side:Number(setback_side),setback_back:Number(setback_back),
      city:city||"",district:district||"",zoning:zoning||"",terrain_context:terrain_context||""});

    let png=canvas.toBuffer("image/png");
    console.log(`Canvas PNG: ${png.length} bytes (${Date.now()-t0}ms)`);

    // Tenter l'amélioration DALL-E (optionnel — fallback sur canvas si échec)
    // DALL-E 2 edit requiert image 1024x1024 RGBA
    if (W <= 1024 && H <= 1024) {
      const enhanced = await enhanceWithDallE(png, W, H);
      if (enhanced) {
        png = enhanced;
        console.log(`DALL-E PNG: ${png.length} bytes (${Date.now()-t0}ms)`);
      } else {
        console.log("Using canvas PNG (DALL-E skipped)");
      }
    } else {
      console.log(`Image ${W}x${H} > 1024px — DALL-E skipped, using canvas`);
    }

    const sb=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY);
    const slug=String(client_name||"client").toLowerCase().trim().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"");
    const path=`hektar/${String(lead_id).trim()}_${slug}/${slide_name}.png`;
    const{error:ue}=await sb.storage.from("massing-images").upload(path,png,{contentType:"image/png",upsert:true});
    if(ue)return res.status(500).json({error:ue.message});
    const{data:pd}=sb.storage.from("massing-images").getPublicUrl(path);
    console.log(`Done: ${pd.publicUrl} (${Date.now()-t0}ms)`);
    return res.json({ok:true,public_url:pd.publicUrl,path,centroid:{lat:cLat,lon:cLon},stats:{osm_buildings:osm.buildings.length,osm_roads:osm.roads.length,synthetic:synth.length},duration_ms:Date.now()-t0});
  }catch(e){
    console.error("Error:",e);
    return res.status(500).json({error:String(e)});
  }
});

app.listen(PORT,()=>{
  console.log(`BARLO Axo Service on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL?"OK":"MISSING"}`);
});
