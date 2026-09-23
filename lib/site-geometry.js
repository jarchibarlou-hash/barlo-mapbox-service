// BARLO v12 — Géométrie du terrain : repère local, zone constructible, règles de retrait par segment.
// Une seule implémentation, partagée serveur (require) et studio (<script src="/lib/site-geometry.js">).
// Repère local : mètres, origine = moyenne des sommets GPS, x vers l'Est, y vers le Nord
// (identique au cockpit, au rendu 3D et au PPT).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BarloSiteGeometry = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const R_EARTH = 6371000;

  // Règle de retrait de Jeremy (23/09/2026) : 5 m côté rue, 3 m ailleurs, 0 m si mitoyen
  // (mur aveugle en limite). La mitoyenneté n'existe que si l'architecte la précise.
  const SETBACK_BY_TYPE = Object.freeze({ rue: 5, libre: 3, fond: 3, mitoyen: 0 });
  const SETBACK_RULE_NOTE = "Règle BARLO : 5 m côté rue, 3 m ailleurs, 0 m côté mitoyen (façade aveugle)";

  // "lat,lon|lat,lon|…" ou [{lat,lon}] ou [[lat,lon]] → [{lat,lon}]
  function parsePolygon(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.map(p => Array.isArray(p) ? { lat: Number(p[0]), lon: Number(p[1]) } : { lat: Number(p.lat), lon: Number(p.lon) })
        .filter(p => isFinite(p.lat) && isFinite(p.lon));
    }
    return String(raw).split(/[|;\n]+/).map(s => s.trim()).filter(Boolean).map(s => {
      const [lat, lon] = s.split(",").map(Number);
      return { lat, lon };
    }).filter(p => isFinite(p.lat) && isFinite(p.lon));
  }

  function toLocalMeters(latLon) {
    const n = latLon.length;
    if (n === 0) return [];
    const cLat = latLon.reduce((s, p) => s + p.lat, 0) / n;
    const cLon = latLon.reduce((s, p) => s + p.lon, 0) / n;
    const cosC = Math.cos(cLat * Math.PI / 180);
    return latLon.map(p => ({
      x: (p.lon - cLon) * Math.PI / 180 * R_EARTH * cosC,
      y: (p.lat - cLat) * Math.PI / 180 * R_EARTH,
    }));
  }

  function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }
  function polygonArea(pts) { return pts && pts.length >= 3 ? Math.abs(signedArea(pts)) : 0; }

  function edgeLengths(pts) {
    return pts.map((p, i) => { const q = pts[(i + 1) % pts.length]; return Math.hypot(q.x - p.x, q.y - p.y); });
  }

  // Garde la partie du polygone du côté (point - o)·n >= 0
  function clipByHalfPlane(poly, ox, oy, nx, ny) {
    const out = [];
    const side = p => (p.x - ox) * nx + (p.y - oy) * ny;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const sa = side(a), sb = side(b);
      if (sa >= 0) out.push(a);
      if ((sa >= 0) !== (sb >= 0)) {
        const t = sa / (sa - sb);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return out;
  }

  function edgeLines(parcel, dists) {
    const n = parcel.length, ccw = signedArea(parcel) > 0;
    const lines = [];
    for (let i = 0; i < n; i++) {
      const a = parcel[i], b = parcel[(i + 1) % n];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      const nrm = ccw ? { x: -d.y, y: d.x } : { x: d.y, y: -d.x };
      const off = dists[i];
      lines.push({ idx: i, d, n: nrm, off, a, p: { x: a.x + nrm.x * off, y: a.y + nrm.y * off } });
    }
    return lines;
  }

  function intersectLines(L0, L1) {
    const den = L0.d.x * L1.d.y - L0.d.y * L1.d.x;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((L1.p.x - L0.p.x) * L1.d.y - (L1.p.y - L0.p.y) * L1.d.x) / den;
    return { x: L0.p.x + L0.d.x * t, y: L0.p.y + L0.d.y * t };
  }
  const projectOn = (L, pt) => { const t = (pt.x - L.p.x) * L.d.x + (pt.y - L.p.y) * L.d.y; return { x: L.p.x + L.d.x * t, y: L.p.y + L.d.y * t }; };

  function segmentsCross(p1, p2, p3, p4) {
    const o = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
    return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
  }
  function selfIntersects(poly) {
    const n = poly.length;
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
    return false;
  }
  function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  // Décalage « en onglet » : chaque arête recule de sa distance, les sommets sont les intersections
  // des lignes reculées voisines. Une arête dont le recul s'inverse disparaît (comme un squelette droit).
  // Aux angles rentrants, l'onglet est légèrement plus prudent que la distance exacte (coin carré).
  function mitreOffset(parcel, dists) {
    let lines = edgeLines(parcel, dists);
    for (let guard = 0; guard <= parcel.length; guard++) {
      const m = lines.length;
      if (m < 3) return [];
      const corners = [];
      for (let k = 0; k < m; k++) {
        const L0 = lines[(k - 1 + m) % m], L1 = lines[k];
        const X = intersectLines(L0, L1);
        if (X) { corners.push([X]); continue; }
        if (L0.d.x * L1.d.x + L0.d.y * L1.d.y < 0) return []; // deux reculs opposés se croisent : bande vide
        corners.push([projectOn(L0, L1.a), projectOn(L1, L1.a)]); // arêtes alignées, reculs différents : décrochement
      }
      let worst = -1, worstVal = -1e-6;
      for (let k = 0; k < m; k++) {
        const s = corners[k][corners[k].length - 1], e = corners[(k + 1) % m][0];
        const v = (e.x - s.x) * lines[k].d.x + (e.y - s.y) * lines[k].d.y;
        if (v < worstVal) { worstVal = v; worst = k; }
      }
      if (worst < 0) return corners.flat();
      lines = lines.filter((_, k) => k !== worst);
    }
    return [];
  }

  // Zone constructible : chaque arête i reculée de retraits[i] (+ extra) vers l'intérieur.
  // Méthode principale : décalage en onglet (juste sur parcelle concave). Si le résultat est
  // incohérent (auto-intersection, sort de la parcelle), repli prudent : intersection des demi-plans.
  function buildablePolygon(parcel, retraits, extra) {
    if (!parcel || parcel.length < 3) return [];
    const dists = parcel.map((_, i) => Math.max(0, (Number(retraits && retraits[i]) || 0) + (Number(extra) || 0)));
    const mitre = mitreOffset(parcel, dists);
    const sameWay = mitre.length >= 3 && Math.sign(signedArea(mitre)) === Math.sign(signedArea(parcel));
    if (sameWay && !selfIntersects(mitre) && polygonArea(mitre) <= polygonArea(parcel) + 1e-6
        && mitre.every(pt => pointInPolygon(pt, parcel) || distToBoundary(pt, parcel) < 1e-3)) return mitre;
    return halfPlaneBuildable(parcel, dists);
  }

  function distToSegment(pt, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(pt.x - (a.x + dx * t), pt.y - (a.y + dy * t));
  }
  function distToBoundary(pt, poly) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) best = Math.min(best, distToSegment(pt, poly[i], poly[(i + 1) % poly.length]));
    return best;
  }

  function halfPlaneBuildable(parcel, dists) {
    let poly = parcel.slice();
    for (const L of edgeLines(parcel, dists)) {
      if (L.off <= 0) continue;
      poly = clipByHalfPlane(poly, L.p.x, L.p.y, L.n.x, L.n.y);
      if (poly.length < 3) return [];
    }
    return poly;
  }

  // Segments par défaut selon la règle : type connu → retrait de la règle ; sinon « libre » (3 m).
  function defaultSegments(parcel) {
    const lens = edgeLengths(parcel);
    return parcel.map((_, i) => ({ index: i, type: "libre", retrait_m: SETBACK_BY_TYPE.libre, length_m: Math.round(lens[i] * 10) / 10, source: "BARLO_RULE" }));
  }

  // Retraits effectifs par arête à partir des segments enregistrés (valeur saisie, sinon règle du type)
  function retraitsFromSegments(segments, n) {
    const out = new Array(n).fill(SETBACK_BY_TYPE.libre);
    for (const s of segments || []) {
      if (!(s.index >= 0 && s.index < n)) continue;
      const v = Number(s.retrait_m);
      out[s.index] = isFinite(v) && v >= 0 ? v : (SETBACK_BY_TYPE[s.type] ?? SETBACK_BY_TYPE.libre);
    }
    return out;
  }

  // Synthèse de la zone constructible d'un lead : parcelle, retraits, aire constructible (+ variante marge).
  function siteBuildable(polygonRaw, segments, extra) {
    const latLon = parsePolygon(polygonRaw);
    if (latLon.length < 3) return null;
    const parcel = toLocalMeters(latLon);
    const retraits = retraitsFromSegments(segments && segments.length === parcel.length ? segments : defaultSegments(parcel), parcel.length);
    const buildable = buildablePolygon(parcel, retraits, extra || 0);
    return {
      parcel_area_m2: Math.round(polygonArea(parcel)),
      buildable_area_m2: Math.round(polygonArea(buildable)),
      buildable,
      retraits,
      has_street: (segments || []).some(s => s.type === "rue"),
      segments_count: parcel.length,
    };
  }

  return {
    SETBACK_BY_TYPE, SETBACK_RULE_NOTE,
    parsePolygon, toLocalMeters, signedArea, polygonArea, edgeLengths, pointInPolygon, distToSegment,
    clipByHalfPlane, buildablePolygon, halfPlaneBuildable, defaultSegments, retraitsFromSegments, siteBuildable,
  };
});
