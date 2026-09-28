"""
v13.1 — Planche d'implantation d'un scénario, au format de la slide : PLAN DU REZ-DE-CHAUSSÉE (retraits en
pointillés), AXONOMÉTRIE des volumes, COUPE SCHÉMATIQUE et RÉPARTITION PAR NIVEAU, pour que le client
compare les vues et comprenne la configuration de tous les niveaux.

Données (calculées par le serveur, repère du cockpit : mètres, origine = moyenne des sommets de la
parcelle, x = est, y = nord) :
  plan = {
    parcel: [[x, y], ...], buildable: [[x, y], ...],
    sides: [{a: [x, y], b: [x, y], type: 'rue'|'libre'|'fond'|'mitoyen', retrait_m, name}],
    units: [{name, type, color, poly: [[x, y], ...], start_level, floors, ground_m, base_m, top_m, fh, pilotis}]
  }
Aucun texte ne se superpose : le plan ne montre que le rez-de-chaussée (les étages en pointillés, sans
étiquette) ; l'axonométrie porte une étiquette par unité, rangées en colonne sans chevauchement.
Les tailles de texte sont celles de la slide (figure à la taille de la zone image).
"""
import math
import textwrap

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MplPolygon, Rectangle as MplRectangle

INK = '#1F2A37'
MUTED = '#6B7280'
BRAND = '#1F5E55'
PINK = '#E94B78'
PARCEL_FILL = '#F3F0E9'
PARCEL_EDGE = '#3F3F46'
FONT = 'DejaVu Sans'
FIG_W, FIG_H = 9.3, 4.7   # zone image de la slide (pouces)


# ── Géométrie ────────────────────────────────────────────────────────────────
def _area_signed(p):
    return sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p))) / 2.0


def _ccw(p):
    return p if _area_signed(p) >= 0 else list(reversed(p))


def _inside(pt, poly):
    x, y = pt
    c = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            c = not c
    return c


def _dist_seg(pt, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / l2))
    return math.hypot(pt[0] - (ax + t * dx), pt[1] - (ay + t * dy))


def _label_point(poly):
    """Point intérieur le plus éloigné des bords (lisible même pour une forme en L ou en triangle)."""
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    best, best_d = (sum(xs) / len(xs), sum(ys) / len(ys)), -1.0
    for i in range(1, 24):
        for j in range(1, 24):
            q = (min(xs) + (max(xs) - min(xs)) * i / 24, min(ys) + (max(ys) - min(ys)) * j / 24)
            if not _inside(q, poly):
                continue
            d = min(_dist_seg(q, poly[k], poly[(k + 1) % len(poly)]) for k in range(len(poly)))
            if d > best_d:
                best, best_d = q, d
    return best, max(best_d, 0.0)


def _level_name(n):
    return 'RDC' if n <= 0 else f'R+{n}'


def _unit_levels(u):
    s = int(u.get('start_level') or 0)
    e = s + max(1, int(u.get('floors') or 1)) - 1
    txt = _level_name(s) if e == s else f'{_level_name(s)} → {_level_name(e)}'
    return txt + (' (pilotis)' if u.get('pilotis') else '')


def _fr(v, nd=1):
    s = f'{v:.{nd}f}'.rstrip('0').rstrip('.') if nd else str(int(round(v)))
    return s.replace('.', ',')


def _alt(v):
    return ('±' if abs(v) < 0.005 else '+') + f'{abs(v):.2f}'.replace('.', ',')


def _hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def _shade(color, k):
    r, g, b = _hex_rgb(color)
    if k >= 1:
        return (r + (1 - r) * (k - 1), g + (1 - g) * (k - 1), b + (1 - b) * (k - 1))
    return (r * k, g * k, b * k)


def _is_ground(u):
    return float(u.get('ground_m') or 0) < 0.01


def _fit_axes(ax, x0, x1, y0, y1, w_in, h_in, anchor='center'):
    """Échelle égale en x et y : cadre (x0..x1, y0..y1) dans des axes de w_in × h_in pouces."""
    s = max((x1 - x0) / w_in, (y1 - y0) / h_in)
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    xl = (x0, x0 + s * w_in) if anchor == 'left' else (cx - s * w_in / 2, cx + s * w_in / 2)
    ax.set_xlim(*xl)
    ax.set_ylim(cy - s * h_in / 2, cy + s * h_in / 2)
    return s


def _stack_labels(items, min_gap, y_min=None, y_max=None):
    """items : [{'ty': y souhaité}] → 'ly' final, espacés d'au moins min_gap, au plus près des souhaits."""
    order = sorted(items, key=lambda it: it['ty'])
    for i, it in enumerate(order):
        it['ly'] = it['ty'] if i == 0 else max(it['ty'], order[i - 1]['ly'] + min_gap)
    if order:
        shift = sum(it['ly'] - it['ty'] for it in order) / len(order)
        for it in order:
            it['ly'] -= shift
        for i in range(1, len(order)):
            order[i]['ly'] = max(order[i]['ly'], order[i - 1]['ly'] + min_gap)
        if y_min is not None and order[0]['ly'] < y_min:
            d = y_min - order[0]['ly']
            for it in order:
                it['ly'] += d
        if y_max is not None and order[-1]['ly'] > y_max:
            d = order[-1]['ly'] - y_max
            for it in order:
                it['ly'] -= d
    return order


# ── 1. Plan du rez-de-chaussée ─────────────────────────────────────────────────
def _draw_plan(ax, d, cut, w_in, h_in):
    parcel = d['parcel']
    build = d.get('buildable') or []
    units = d.get('units') or []
    xs = [p[0] for p in parcel]
    ys = [p[1] for p in parcel]
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    span = max(max(xs) - min(xs), max(ys) - min(ys), 5.0)
    ax.add_patch(MplPolygon(parcel, closed=True, facecolor=PARCEL_FILL, edgecolor=PARCEL_EDGE, lw=1.4, zorder=1))
    # retraits : valeur à l'EXTÉRIEUR de chaque côté (jamais sur une unité), à l'écart des repères A / A'
    marks = list(cut['plan_line']) if cut else []
    for s in d.get('sides') or []:
        (ax0, ay0), (bx0, by0) = s['a'], s['b']
        L = math.hypot(bx0 - ax0, by0 - ay0)
        if L < 3:
            continue
        mx, my = (ax0 + bx0) / 2, (ay0 + by0) / 2
        for f in (0.5, 0.28, 0.72):
            px, py = ax0 + (bx0 - ax0) * f, ay0 + (by0 - ay0) * f
            if all(math.hypot(px - m[0], py - m[1]) > span * 0.1 for m in marks):
                mx, my = px, py
                break
        nx, ny = -(by0 - ay0) / L, (bx0 - ax0) / L
        if (cx - mx) * nx + (cy - my) * ny > 0:      # normale tournée vers l'extérieur
            nx, ny = -nx, -ny
        ang = math.degrees(math.atan2(by0 - ay0, bx0 - ax0))
        if ang > 90:
            ang -= 180
        if ang <= -90:
            ang += 180
        typ = s.get('type') or 'libre'
        r = float(s.get('retrait_m') or 0)
        txt = f"{_fr(r)} m" + (' · rue' if typ == 'rue' else ' · mitoyen' if typ == 'mitoyen' else '')
        ax.text(mx + nx * span * 0.035, my + ny * span * 0.035, txt, fontsize=5.6, color=BRAND, rotation=ang,
                ha='center', va='center', zorder=3, family=FONT, fontweight=('bold' if typ == 'rue' else 'normal'))
    # rez-de-chaussée
    for u in [u for u in units if _is_ground(u)]:
        pil = bool(u.get('pilotis'))
        ax.add_patch(MplPolygon(u['poly'], closed=True, facecolor=(u['color'] if not pil else 'white'),
                                edgecolor=('white' if not pil else u['color']), lw=1.0, alpha=0.93,
                                hatch=('////' if pil else None), zorder=4))
    # étages : contour en pointillés, sans étiquette (lus sur l'axonométrie et la coupe)
    uppers = [u for u in units if not _is_ground(u)]
    for u in uppers:
        ax.add_patch(MplPolygon(u['poly'], closed=True, fill=False, edgecolor=INK, lw=0.7, ls=(0, (1.5, 1.5)), zorder=5))
    # limite des retraits PAR-DESSUS les unités : un débord se voit
    if len(build) >= 3:
        ax.add_patch(MplPolygon(build, closed=True, fill=False, edgecolor=BRAND, lw=1.1, ls=(0, (4, 2.5)), zorder=6))
    for u in [u for u in units if _is_ground(u)]:
        pil = bool(u.get('pilotis'))
        (lx, ly), rad = _label_point(u['poly'])
        area = abs(_area_signed(u['poly']))
        name = '\n'.join(textwrap.wrap(str(u.get('name') or u.get('type') or ''), 13)[:2])
        ax.text(lx, ly, f"{name}\n{_fr(area, 0)} m²" + ('\nsur pilotis' if pil else ''), fontsize=(6.2 if rad >= 1.4 else 5.2),
                color=('white' if not pil else INK), fontweight='bold', ha='center', va='center', zorder=8, family=FONT, linespacing=1.1,
                bbox=dict(boxstyle='round,pad=0.15', fc=(u['color'] if not pil else 'white'), ec='none', alpha=0.9))
    # ligne de coupe A–A'
    if cut:
        (p0, p1) = cut['plan_line']
        ax.plot([p0[0], p1[0]], [p0[1], p1[1]], color=PINK, lw=1.0, ls=(0, (6, 2, 1.5, 2)), zorder=7)   # sous les étiquettes
        for pt, lab in ((p0, 'A'), (p1, "A'")):
            ax.text(pt[0], pt[1], lab, fontsize=6.3, color='white', fontweight='bold', ha='center', va='center', zorder=10,
                    family=FONT, bbox=dict(boxstyle='circle,pad=0.2', fc=PINK, ec='none'))
    # cadrage : place en bas pour l'échelle et la légende
    pad = span * 0.12
    s = _fit_axes(ax, min(xs) - pad, max(xs) + pad, min(ys) - pad * 2.6, max(ys) + pad, w_in, h_in)
    X0, X1 = ax.get_xlim()
    Y0, Y1 = ax.get_ylim()
    # nord
    nxp, nyp = X1 - 0.18 * s, Y1 - 0.45 * s
    ax.annotate('', xy=(nxp, nyp + 0.22 * s), xytext=(nxp, nyp - 0.12 * s), arrowprops=dict(arrowstyle='-|>', color=INK, lw=1.2), zorder=11)
    ax.text(nxp, nyp + 0.26 * s, 'N', fontsize=7.5, fontweight='bold', color=INK, ha='center', va='bottom', family=FONT)
    # échelle graphique
    bar = 5 if span < 30 else 10
    bx, by = X0 + 0.12 * s, Y0 + 0.42 * s
    for i in range(2):
        ax.add_patch(MplRectangle((bx + i * bar / 2, by), bar / 2, 0.05 * s, facecolor=(INK if i == 0 else 'white'), edgecolor=INK, lw=0.5, zorder=11))
    ax.text(bx, by + 0.1 * s, '0', fontsize=5.3, color=INK, ha='center', va='bottom', family=FONT)
    ax.text(bx + bar, by + 0.1 * s, f'{bar} m', fontsize=5.3, color=INK, ha='center', va='bottom', family=FONT)
    legend = [(BRAND, 'limite des retraits (zone constructible)')]
    if uppers:
        legend.append((INK, 'étages au-dessus : voir axonométrie et coupe'))
    for i, (col, txt) in enumerate(legend):
        yy = Y0 + (0.25 - 0.14 * i) * s
        ax.plot([bx, bx + 0.28 * s], [yy, yy], color=col, lw=1.0, ls=((0, (4, 2.5)) if i == 0 else (0, (1.5, 1.5))))
        ax.text(bx + 0.36 * s, yy, txt, fontsize=5.3, color=col, va='center', family=FONT)
    ax.set_aspect('equal')
    ax.axis('off')


# ── 2. Axonométrie ─────────────────────────────────────────────────────────────
PSI = math.radians(28)     # rotation du plan ; recalculée par planche (voir _view_for)
ELEV = math.radians(34)    # inclinaison du regard


def _view_for(axis):
    """Vue de côté du bâti : son grand axe court de gauche à droite dans le même sens que la coupe
    (A à gauche, A' à droite), légèrement incliné pour voir le pignon ; les unités alignées sont toutes
    visibles et l'axonométrie se lit comme la coupe. Une flèche indique le nord."""
    ang = math.degrees(math.atan2(axis[1], axis[0]))
    return math.radians(-25.0 - ang)


def _proj(x, y, z):
    c, s = math.cos(PSI), math.sin(PSI)
    x1 = x * c - y * s
    y1 = x * s + y * c
    return x1, y1 * math.sin(ELEV) + z * math.cos(ELEV), y1


def _draw_axo(ax, d, w_in, h_in):
    parcel = d['parcel']
    build = d.get('buildable') or []
    units = d.get('units') or []
    P = lambda pts, z: [_proj(p[0], p[1], z)[:2] for p in pts]
    ax.add_patch(MplPolygon(P(parcel, 0), closed=True, facecolor=PARCEL_FILL, edgecolor=PARCEL_EDGE, lw=1.1, zorder=1))
    if len(build) >= 3:
        ax.add_patch(MplPolygon(P(build, 0), closed=True, fill=False, edgecolor=BRAND, lw=0.9, ls=(0, (4, 2.5)), zorder=2))
    # volumes : du plus lointain au plus proche, puis de bas en haut
    prisms = []
    for u in units:
        poly = _ccw(u['poly'])
        depth = min(_proj(p[0], p[1], 0)[2] for p in poly)
        prisms.append((-round(depth, 1), float(u.get('base_m') or 0), u, poly))
    prisms.sort(key=lambda t: (t[0], t[1]))
    c, s_ = math.cos(PSI), math.sin(PSI)
    z = 10
    drawn = []          # (ordre de dessin, n° du volume, face 2D) : pour savoir ce qui reste visible
    for vi, (_, base, u, poly) in enumerate(prisms):
        top = float(u.get('top_m') or base + 3)
        col = u['color']
        g = float(u.get('ground_m') or 0)
        if u.get('pilotis') and g < base:
            for p in poly:
                (xa, ya), (xb, yb) = _proj(p[0], p[1], g)[:2], _proj(p[0], p[1], base)[:2]
                ax.plot([xa, xb], [ya, yb], color='#4B5563', lw=1.4, zorder=z)
            z += 1
        n = len(poly)
        for i in range(n):
            a, b = poly[i], poly[(i + 1) % n]
            nx, ny = (b[1] - a[1]), -(b[0] - a[0])      # normale extérieure (sens direct)
            n_depth = nx * s_ + ny * c
            if n_depth >= 0:
                continue                                 # face cachée
            n_right = nx * c - ny * s_
            ln = math.hypot(nx, ny) or 1
            k = 0.62 + 0.28 * max(0.0, -n_right / ln) + 0.1 * (-n_depth / ln)
            face = [_proj(a[0], a[1], base)[:2], _proj(b[0], b[1], base)[:2], _proj(b[0], b[1], top)[:2], _proj(a[0], a[1], top)[:2]]
            ax.add_patch(MplPolygon(face, closed=True, facecolor=_shade(col, k), edgecolor=INK, lw=0.5, zorder=z))
            drawn.append((z, vi, face))
            z += 1
        ax.add_patch(MplPolygon(P(poly, top), closed=True, facecolor=_shade(col, 1.2), edgecolor=INK, lw=0.5, zorder=z))
        drawn.append((z, vi, P(poly, top)))
        # traits de niveaux sur les volumes de plusieurs étages
        fh = float(u.get('fh') or 3)
        lv = base + fh
        while lv < top - 0.05:
            pts = P(poly, lv)
            for i in range(n):
                a, b = poly[i], poly[(i + 1) % n]
                if ((b[1] - a[1]) * s_ - (b[0] - a[0]) * c) < 0:
                    ax.plot([pts[i][0], pts[(i + 1) % n][0]], [pts[i][1], pts[(i + 1) % n][1]], color='white', lw=0.5, alpha=0.75, zorder=z)
            lv += fh
        z += 1
    # nord : flèche dans le coin, dans la direction du nord sur cette vue
    (ox, oy), (nx_, ny_) = _proj(0, 0, 0)[:2], _proj(0, 1, 0)[:2]
    ln = math.hypot(nx_ - ox, ny_ - oy) or 1
    ux, uy = (nx_ - ox) / ln, (ny_ - oy) / ln * (w_in / h_in)
    k0 = (0.06, 0.1)
    ax.annotate('', xy=(k0[0] + ux * 0.06, k0[1] + uy * 0.06), xytext=(k0[0] - ux * 0.02, k0[1] - uy * 0.02), xycoords='axes fraction',
                textcoords='axes fraction', arrowprops=dict(arrowstyle='-|>', color=INK, lw=1.0), zorder=400)
    ax.text(k0[0] + ux * 0.085, k0[1] + uy * 0.085, 'N', transform=ax.transAxes, fontsize=6.5, fontweight='bold', color=INK,
            ha='center', va='center', family=FONT, zorder=400)
    # cadrage : scène à gauche, colonne d'étiquettes à droite
    allp = P(parcel, 0) + [pt for _, base, u, poly in prisms for pt in P(poly, float(u.get('top_m') or 3))]
    X0, X1 = min(p[0] for p in allp), max(p[0] for p in allp)
    Y0, Y1 = min(p[1] for p in allp), max(p[1] for p in allp)
    fs = 6.2
    texts = [f"{u.get('name') or u.get('type')} · {_unit_levels(u)}" for _, _, u, _ in prisms]
    lab_in = (max((len(t) for t in texts), default=0) * fs * 0.56 + 12) / 72
    gap_in = 0.25
    s = max((X1 - X0) / max(0.8, w_in - lab_in - gap_in - 0.1), (Y1 - Y0) / (h_in - 0.15)) * 1.03
    ax.set_xlim(X0 - 0.05 * s, X0 - 0.05 * s + s * w_in)
    ym = (Y0 + Y1) / 2
    ax.set_ylim(ym - s * h_in / 2, ym + s * h_in / 2)
    # une étiquette par unité, reliée à une partie VISIBLE de son volume (façade ou toit non masqué)
    def visible(pt, vi):
        mine = max(zz for zz, v, _ in drawn if v == vi)
        return not any(zz > mine and v != vi and _inside(pt, f) for zz, v, f in drawn)
    items = []
    for vi, (_, base, u, poly) in enumerate(prisms):
        faces = [f for _, v, f in drawn if v == vi]
        cands = []
        for f in faces:
            fx = sum(q[0] for q in f) / len(f)
            fy = sum(q[1] for q in f) / len(f)
            cands.append((fx, fy))
            cands += [((fx + q[0]) / 2, (fy + q[1]) / 2) for q in f]
        cands.sort(key=lambda q: -q[0])            # de préférence du côté des étiquettes
        anchor = next((q for q in cands if visible(q, vi)), cands[0] if cands else (0, 0))
        items.append({'ty': anchor[1], 'anchor': anchor, 'text': f"{u.get('name') or u.get('type')} · {_unit_levels(u)}", 'color': u['color']})
    lx = X1 + gap_in * s
    yl0, yl1 = ax.get_ylim()
    for it in _stack_labels(items, fs * 2.2 / 72 * s, yl0 + 0.15 * s, yl1 - 0.15 * s):
        ax.annotate(it['text'], xy=it['anchor'], xytext=(lx, it['ly']), textcoords='data', fontsize=fs, color=INK, family=FONT,
                    ha='left', va='center', zorder=300,
                    bbox=dict(boxstyle='round,pad=0.22', fc='white', ec=it['color'], lw=0.9),
                    arrowprops=dict(arrowstyle='-', color=INK, lw=0.6, shrinkA=0, shrinkB=0))
        ax.plot([it['anchor'][0]], [it['anchor'][1]], marker='o', ms=2.6, color=it['color'], mec=INK, mew=0.5, zorder=301)
    ax.set_aspect('equal')
    ax.axis('off')


# ── 3. Coupe schématique ───────────────────────────────────────────────────────
def _intervals(poly, a, p, t):
    """Portions de la droite {q : q·p = t} dans le polygone, en abscisse s = q·a."""
    ss = []
    n = len(poly)
    for i in range(n):
        P0, P1 = poly[i], poly[(i + 1) % n]
        d0 = P0[0] * p[0] + P0[1] * p[1] - t
        d1 = P1[0] * p[0] + P1[1] * p[1] - t
        if (d0 > 0) != (d1 > 0):
            s0 = P0[0] * a[0] + P0[1] * a[1]
            s1 = P1[0] * a[0] + P1[1] * a[1]
            ss.append(s0 + (s1 - s0) * d0 / (d0 - d1))
    ss.sort()
    return [(ss[i], ss[i + 1]) for i in range(0, len(ss) - 1, 2) if ss[i + 1] - ss[i] > 0.05]


def compute_cut(d):
    """Ligne de coupe : dans l'axe long du bâti, placée pour traverser le plus d'unités."""
    units = d.get('units') or []
    pts = [q for u in units for q in u['poly']] or d['parcel']
    mx = sum(q[0] for q in pts) / len(pts)
    my = sum(q[1] for q in pts) / len(pts)
    sxx = sum((q[0] - mx) ** 2 for q in pts)
    syy = sum((q[1] - my) ** 2 for q in pts)
    sxy = sum((q[0] - mx) * (q[1] - my) for q in pts)
    ang = 0.5 * math.atan2(2 * sxy, sxx - syy)
    a = (math.cos(ang), math.sin(ang))
    if a[0] < -1e-6 or (abs(a[0]) <= 1e-6 and a[1] < 0):
        a = (-a[0], -a[1])
    p = (-a[1], a[0])
    tv = [q[0] * p[0] + q[1] * p[1] for q in pts]
    tmin, tmax = min(tv), max(tv)
    tc = mx * p[0] + my * p[1]
    best = None
    for i in range(1, 40):
        t = tmin + (tmax - tmin) * i / 40
        n_cut = sum(1 for u in units if _intervals(u['poly'], a, p, t))
        key = (n_cut, -abs(t - tc))
        if best is None or key > best[0]:
            best = (key, t)
    t = best[1] if best else tc
    ps = _intervals(d['parcel'], a, p, t)
    s0 = min(x for x, _ in ps) if ps else min(q[0] * a[0] + q[1] * a[1] for q in d['parcel'])
    s1 = max(y for _, y in ps) if ps else max(q[0] * a[0] + q[1] * a[1] for q in d['parcel'])
    ext = 2.2
    line =((a[0] * (s0 - ext) + p[0] * t, a[1] * (s0 - ext) + p[1] * t), (a[0] * (s1 + ext) + p[0] * t, a[1] * (s1 + ext) + p[1] * t))
    return {'a': a, 'p': p, 't': t, 's0': s0, 's1': s1, 'plan_line': line}


_CARD = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest']


def _cardinal(v):
    b = (math.degrees(math.atan2(v[0], v[1])) + 360) % 360
    return _CARD[int(((b + 22.5) % 360) // 45)]


def _draw_coupe(ax, d, cut, w_in, h_in):
    a, p, t = cut['a'], cut['p'], cut['t']
    units = d.get('units') or []
    s0, s1 = cut['s0'], cut['s1']
    b_iv = _intervals(d.get('buildable') or [], a, p, t) if len(d.get('buildable') or []) >= 3 else []
    htop = max([float(u.get('top_m') or 3) for u in units] + [3.0])
    left_in = 0.55
    s = max(((s1 + 1.0) - (s0 - 1.0)) / (w_in - left_in - 0.05), (htop + 2.2) / (h_in - 0.1))
    ax.set_xlim(s0 - 1.0 - left_in * s, s0 - 1.0 - left_in * s + s * w_in)
    yc = (htop + 2.2) / 2 - 1.0
    ax.set_ylim(yc - s * h_in / 2, yc + s * h_in / 2)
    X0 = ax.get_xlim()[0]
    # sol, limites de parcelle
    ax.add_patch(MplRectangle((s0, -0.6), s1 - s0, 0.6, facecolor='#E7E2D8', edgecolor='none', hatch='////', zorder=1))
    ax.plot([s0 - 1.0, s1 + 1.0], [0, 0], color=INK, lw=1.4, zorder=3)
    for sx in (s0, s1):
        ax.plot([sx, sx], [-0.6, 1.0], color=PARCEL_EDGE, lw=1.1, zorder=3)
    # niveaux (repères à gauche)
    fh_ref = min([float(u.get('fh') or 3) for u in units] + [3.0])
    alts = sorted({round(float(u.get('base_m') or 0) + i * float(u.get('fh') or 3), 2)
                   for u in units for i in range(max(1, int(u.get('floors') or 1)))} | {0.0})
    for zz in alts + ([round(htop, 2)] if round(htop, 2) not in alts else []):
        ax.plot([s0 - 1.0, s1 + 1.0], [zz, zz], color=MUTED, lw=0.35, ls=(0, (1, 2)), zorder=0)
        lvl = (_level_name(int(round(zz / fh_ref))) + '  ') if zz in alts else ''
        ax.text(X0 + 0.04 * s, zz, f"{lvl}{_alt(zz)}", fontsize=5.3, color=INK, va='center', ha='left', family=FONT)
    # unités vues au-delà de la coupe, puis unités coupées
    cut_units, beyond = [], []
    for u in units:
        iv = _intervals(u['poly'], a, p, t)
        (cut_units if iv else beyond).append((u, iv))
    for u, _ in beyond:
        sv = [q[0] * a[0] + q[1] * a[1] for q in u['poly']]
        b0 = float(u.get('base_m') or 0)
        ax.add_patch(MplRectangle((min(sv), b0), max(sv) - min(sv), float(u.get('top_m') or b0 + 3) - b0,
                                  facecolor=_shade(u['color'], 1.6), edgecolor=MUTED, lw=0.5, ls=(0, (2, 2)), zorder=4))
    labels = []
    for u, iv in cut_units:
        base = float(u.get('base_m') or 0)
        top = float(u.get('top_m') or base + 3)
        fh = float(u.get('fh') or 3)
        for lo, hi in iv:
            ax.add_patch(MplRectangle((lo, base), hi - lo, top - base, facecolor=u['color'], edgecolor=INK, lw=0.9, zorder=6))
            lv = base + fh
            while lv < top - 0.05:
                ax.plot([lo, hi], [lv, lv], color='white', lw=0.6, alpha=0.8, zorder=7)
                lv += fh
            g = float(u.get('ground_m') or 0)
            if u.get('pilotis') and g < base:
                for sx in (lo + 0.15, hi - 0.15):
                    ax.plot([sx, sx], [g, base], color='#4B5563', lw=2.0, zorder=6)
        lo, hi = max(iv, key=lambda q: q[1] - q[0])
        labels.append((u, lo, hi, base, top))
    # limite des retraits par-dessus les volumes : un débord se voit
    if b_iv:
        for sx in (min(x for x, _ in b_iv), max(y for _, y in b_iv)):
            ax.plot([sx, sx], [0, htop + 0.9], color=BRAND, lw=0.9, ls=(0, (4, 2.5)), zorder=9)
    # étiquettes dans les volumes coupés, réduites à la place disponible
    for u, lo, hi, base, top in labels:
        w_pt = (hi - lo) / s * 72
        h_pt = (top - base) / s * 72
        name = str(u.get('name') or u.get('type') or '')
        options = [textwrap.wrap(name, 12)[:2] + [_unit_levels(u)], [_unit_levels(u)]]
        for lines in options:
            fs = 6.0
            while fs > 4.4 and (max(len(x) for x in lines) * fs * 0.58 > w_pt - 3 or len(lines) * fs * 1.2 > h_pt - 1):
                fs -= 0.3
            if max(len(x) for x in lines) * fs * 0.58 <= w_pt - 3 and len(lines) * fs * 1.2 <= h_pt - 1:
                ax.text((lo + hi) / 2, (base + top) / 2, '\n'.join(lines), fontsize=fs, color='white', fontweight='bold',
                        ha='center', va='center', zorder=8, family=FONT, linespacing=1.05)
                break
    # repères de coupe, orientation
    for sx, lab in ((s0 - 1.0, 'A'), (s1 + 1.0, "A'")):
        ax.text(sx, htop + 1.35, lab, fontsize=6.3, color='white', fontweight='bold', ha='center', va='center', family=FONT,
                bbox=dict(boxstyle='circle,pad=0.2', fc=PINK, ec='none'), zorder=10)
    ax.text(s0 - 1.0, -1.05, _cardinal((-a[0], -a[1])), fontsize=5.3, color=MUTED, ha='left', va='center', family=FONT)
    ax.text(s1 + 1.0, -1.05, _cardinal(a), fontsize=5.3, color=MUTED, ha='right', va='center', family=FONT)
    ax.set_aspect('equal')
    ax.axis('off')


# ── 4. Répartition par niveau ──────────────────────────────────────────────────
def _draw_niveaux(ax, d, w_in, h_in):
    units = d.get('units') or []
    by_level = {}
    for u in units:
        s = int(u.get('start_level') or 0)
        for lv in range(s, s + max(1, int(u.get('floors') or 1))):
            by_level.setdefault(lv, []).append(u)
        if u.get('pilotis') and s >= 1:
            by_level.setdefault(s - 1, []).append(dict(u, name=f"pilotis sous {u.get('name') or ''}".strip(), color='#9CA3AF', _pil=True))
    ax.set_xlim(0, w_in)
    ax.set_ylim(0, h_in)
    y = h_in - 0.08
    lh = 7.4 / 72
    chars = max(20, int((w_in - 0.5) * 72 / (6.0 * 0.56)))
    for lv in sorted(by_level, reverse=True):
        if y < 0.1:
            break
        ax.text(0.02, y, _level_name(lv), fontsize=6.4, fontweight='bold', color=BRAND, va='top', family=FONT)
        for u in by_level[lv]:
            area = abs(_area_signed(u['poly']))
            txt = f"{u.get('name') or u.get('type')}" + ('' if u.get('_pil') else f" · {_fr(area, 0)} m²")
            for j, line in enumerate(textwrap.wrap(txt, chars) or ['']):
                if y < 0.1:
                    break
                if j == 0:
                    ax.add_patch(MplRectangle((0.45, y - lh * 0.8), 0.09, lh * 0.7, facecolor=u['color'], edgecolor='none'))
                ax.text(0.6, y, line, fontsize=6.0, color=INK, va='top', family=FONT)
                y -= lh
        y -= lh * 0.45
    ax.axis('off')


# ── Planche complète ───────────────────────────────────────────────────────────
def draw_composite(plan, output_path, dpi=250):
    units = plan.get('units') or []
    if len(plan.get('parcel') or []) < 3 or not units:
        return None
    cut = compute_cut(plan)
    global PSI
    PSI = _view_for(cut['a'])
    fig = plt.figure(figsize=(FIG_W, FIG_H), dpi=dpi)
    fig.patch.set_facecolor('white')
    boxes = {
        'plan': (0.004, 0.02, 0.30, 0.875),
        'axo': (0.325, 0.44, 0.672, 0.455),
        'coupe': (0.325, 0.02, 0.445, 0.33),
        'niveaux': (0.785, 0.02, 0.212, 0.33),
    }
    titles = {'plan': ('PLAN DU REZ-DE-CHAUSSÉE', 0.955), 'axo': ('AXONOMÉTRIE DES VOLUMES', 0.955),
              'coupe': ("COUPE A–A' SCHÉMATIQUE", 0.385), 'niveaux': ('RÉPARTITION PAR NIVEAU', 0.385)}
    axes = {k: fig.add_axes(b) for k, b in boxes.items()}
    size = lambda k: (FIG_W * boxes[k][2], FIG_H * boxes[k][3])
    _draw_plan(axes['plan'], plan, cut, *size('plan'))
    _draw_axo(axes['axo'], plan, *size('axo'))
    _draw_coupe(axes['coupe'], plan, cut, *size('coupe'))
    _draw_niveaux(axes['niveaux'], plan, *size('niveaux'))
    for k, (t, y) in titles.items():
        l, b, w, h = boxes[k]
        fig.text(l + w / 2, y, t, fontsize=7.6, fontweight='bold', color=BRAND, ha='center', va='center', family=FONT)
    fig.add_artist(plt.Line2D([0.314, 0.314], [0.03, 0.97], color='#D9D4C7', lw=0.7))
    fig.add_artist(plt.Line2D([0.325, 0.997], [0.415, 0.415], color='#D9D4C7', lw=0.7))
    fig.add_artist(plt.Line2D([0.778, 0.778], [0.03, 0.40], color='#D9D4C7', lw=0.7))
    fig.savefig(output_path, dpi=dpi, facecolor='white')
    plt.close(fig)
    return output_path
