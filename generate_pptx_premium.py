#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BARLO — Diagnostic premium v13.4 (charte du modèle Canva, contenus v13)

Même données que le PPT standard (server.js : buildPptxPayloadV13) : textes déterministes v13,
graphiques au format de leur zone, planches plan / axonométrie / coupe, images du lead.
Du modèle Canva (template_diagnostic_premium.pptx) on garde la couverture, le manifeste et la page
« Merci », ainsi que la charte (bleu canard, rose, arcs pointillés, trames de points) ; les slides 3 à 21
sont reconstruites à partir des données du lead : aucune donnée de l'exemple ne subsiste (contrôle final).

Usage : python3 generate_pptx_premium.py <data.json> <template.pptx> <output.pptx>
"""
import sys, os, re, json, math, hashlib, tempfile, shutil, zipfile, unicodedata, urllib.request

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn
from lxml import etree

import generate_charts as GC

# ─────────────────────────────────────────────────────────────────────────────
# Charte
# ─────────────────────────────────────────────────────────────────────────────
SW, SH = 20.0, 11.25                      # format du modèle (pouces)
TEAL = RGBColor(0x15, 0x61, 0x6E)         # bleu canard du modèle
TEAL_D = RGBColor(0x0E, 0x47, 0x51)
TEAL_L = RGBColor(0xE6, 0xF0, 0xF1)
PINK = RGBColor(0xEA, 0x5D, 0x91)         # rose du modèle
INK = RGBColor(0x1E, 0x2B, 0x31)
MUTED = RGBColor(0x5F, 0x6B, 0x72)
PANEL = RGBColor(0xF3, 0xF7, 0xF8)
LINE = RGBColor(0xD5, 0xDF, 0xE2)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
DOT = RGBColor(0xC4, 0xCF, 0xD3)
FONT = 'Century Gothic'
M = 0.55                                   # marge latérale
CONTENT_W = SW - 2 * M

QA = []                                    # contrôle final (renvoyé au serveur dans les journaux)


def qa(msg):
    QA.append(msg)
    print(f"[PREMIUM-QA] {msg}")


# ─────────────────────────────────────────────────────────────────────────────
# Mesure du texte — Century Gothic a les chasses d'ITC Avant Garde (1/1000 em)
# ─────────────────────────────────────────────────────────────────────────────
_W = {' ': 277, '.': 277, ',': 277, ':': 277, ';': 277, '!': 295, '?': 591, "'": 199, '’': 199, '"': 309, '«': 425, '»': 425,
      '-': 332, '–': 500, '—': 1000, '(': 369, ')': 369, '/': 437, '%': 775, '+': 606, '=': 606, '×': 606, '÷': 606,
      '·': 277, '•': 600, '☐': 900, '★': 900, '|': 672, '&': 680, '²': 332, '€': 554, '~': 606, '*': 425, '≥': 606, '≤': 606}
for _c, _w in zip("abcdefghijklmnopqrstuvwxyz", [683, 682, 647, 685, 650, 314, 673, 610, 200, 203, 502, 200, 938, 610, 655, 682, 682, 301, 388, 339, 608, 554, 831, 480, 536, 425]):
    _W[_c] = _w
for _c, _w in zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", [740, 574, 813, 744, 536, 485, 872, 683, 226, 482, 591, 462, 919, 740, 869, 592, 871, 607, 498, 426, 655, 702, 960, 609, 592, 480]):
    _W[_c] = _w
for _c in "0123456789":
    _W[_c] = 554
LINE_H = 1.23          # hauteur de ligne de Century Gothic à 100 % (ascendante + descendante)
SAFETY = 1.06          # marge de sécurité sur les largeurs (police de remplacement, crénage)


def _cw(ch):
    if ch in _W:
        return _W[ch]
    base = unicodedata.normalize('NFD', ch)[0]
    return _W.get(base, 600)


def text_width_pt(s, size, bold=False):
    return sum(_cw(c) for c in s) * size / 1000.0 * (1.06 if bold else 1.0) * SAFETY


_TOK = re.compile(r'(\*\*|\*)')


def runs_of(line):
    """« **gras** » et « *italique* » → [(texte, gras, italique)]"""
    out, b, i = [], False, False
    for part in _TOK.split(line):
        if part == '**':
            b = not b
            continue
        if part == '*':
            i = not i
            continue
        if part:
            out.append((part, b, i))
    return out


def parse_paras(text):
    paras, gap = [], False
    for raw in str(text or '').replace('\r', '').split('\n'):
        line = raw.rstrip()
        if not line.strip():
            gap = True
            continue
        s = line.lstrip()
        kind = None
        if s.startswith('- ☐') or s.startswith('☐'):
            kind, s = 'check', s.lstrip('- ').lstrip('☐').strip()
        elif s.startswith('- ') or s.startswith('• '):
            kind, s = 'bullet', s[2:]
        paras.append({'runs': runs_of(s), 'kind': kind, 'gap': gap and bool(paras)})
        gap = False
    return paras


def _para_lines(runs, size, width_pt):
    words = []
    for t, b, _ in runs:
        for k, w in enumerate(re.split(r'(\s+)', t)):
            if w and not w.isspace():
                words.append((w, b))
    lines, cur = 1, 0.0
    sp = text_width_pt(' ', size)
    for w, b in words:
        ww = text_width_pt(w, size, b)
        if cur > 0 and cur + sp + ww > width_pt:
            lines += 1
            cur = ww
        else:
            cur += (sp if cur > 0 else 0) + ww
    return lines


def text_height_in(paras, size, width_in, line=1.0):
    h = 0.0
    for p in paras:
        ind = 0.32 if p['kind'] else 0.0
        n = _para_lines(p['runs'], size, (width_in - ind) * 72)
        h += n * size * LINE_H * line
        if p['gap']:
            h += size * 0.55
        elif p['kind']:
            h += size * 0.18
    return h / 72.0


# ─────────────────────────────────────────────────────────────────────────────
# Formes
# ─────────────────────────────────────────────────────────────────────────────
def _no_style(shape):
    st = shape._element.find(qn('p:style'))
    if st is not None:
        shape._element.remove(st)


def shadow(shape, blur=0.32, dist=0.07, alpha=28):
    spPr = shape._element.spPr
    old = spPr.find(qn('a:effectLst'))
    if old is not None:
        spPr.remove(old)
    eff = etree.SubElement(spPr, qn('a:effectLst'))
    sh = etree.SubElement(eff, qn('a:outerShdw'), blurRad=str(int(blur * 914400)), dist=str(int(dist * 914400)),
                          dir='5400000', algn='t', rotWithShape='0')
    clr = etree.SubElement(sh, qn('a:srgbClr'), val='000000')
    etree.SubElement(clr, qn('a:alpha'), val=str(alpha * 1000))


def rect(slide, x, y, w, h, fill, radius=None, shadowed=False, line=None):
    kind = MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE
    s = slide.shapes.add_shape(kind, Inches(x), Inches(y), Inches(w), Inches(h))
    _no_style(s)
    if radius:
        s.adjustments[0] = radius
    if fill is None:
        s.fill.background()
    else:
        s.fill.solid()
        s.fill.fore_color.rgb = fill
    if line:
        s.line.color.rgb = line
        s.line.width = Pt(0.75)
    else:
        s.line.fill.background()
    if shadowed:
        shadow(s)
    return s


def oval(slide, x, y, d, fill):
    s = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(y), Inches(d), Inches(d))
    _no_style(s)
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    s.line.fill.background()
    return s


def dots(slide, x, y, cols=6, rows=4, gap=0.24, d=0.055, color=DOT):
    for r in range(rows):
        for c in range(cols):
            oval(slide, x + c * gap, y + r * gap, d, color)


def line_shape(slide, x1, y1, x2, y2, color=TEAL, width=1.5, dash=False):
    c = slide.shapes.add_connector(1, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    c.line.color.rgb = color
    c.line.width = Pt(width)
    if dash:
        ln = c.line._get_or_add_ln()
        etree.SubElement(ln, qn('a:prstDash'), val='dash')
    return c


def _img_size(path):
    try:
        from PIL import Image
        with Image.open(path) as im:
            return im.size
    except Exception:
        return None


def pic_cover(slide, path, x, y, w, h, zoom=1.0):
    """Remplit exactement le cadre (recadrage centré, sans déformation) ; zoom > 1 resserre sur le centre
    (vues 3D centrées sur la parcelle : le bâtiment gagne en présence sans sortir du cadre)."""
    pic = slide.shapes.add_picture(path, Inches(x), Inches(y), Inches(w), Inches(h))
    sz = _img_size(path)
    if sz:
        ar_i, ar_b = sz[0] / float(sz[1]), w / float(h)
        cl = cr = ct = cb = 0.0
        if ar_i > ar_b * 1.001:
            cl = cr = (1 - ar_b / ar_i) / 2
        elif ar_i < ar_b * 0.999:
            ct = cb = (1 - ar_i / ar_b) / 2
        if zoom > 1.0:
            kx, ky = (1 - cl - cr) * (1 - 1 / zoom) / 2, (1 - ct - cb) * (1 - 1 / zoom) / 2
            cl, cr, ct, cb = cl + kx, cr + kx, ct + ky, cb + ky
        pic.crop_left, pic.crop_right, pic.crop_top, pic.crop_bottom = cl, cr, ct, cb
    return pic


def pic_fit(slide, path, x, y, w, h, halign='center', valign='center'):
    """Tient dans le cadre, proportions conservées. Retourne (pic, x, y, w, h) réellement occupés."""
    sz = _img_size(path)
    if not sz:
        pic = slide.shapes.add_picture(path, Inches(x), Inches(y), Inches(w), Inches(h))
        return pic, x, y, w, h
    ar = sz[0] / float(sz[1])
    ww, hh = (w, w / ar) if w / ar <= h else (h * ar, h)
    xx = x + {'left': 0, 'center': (w - ww) / 2, 'right': w - ww}[halign]
    yy = y + {'top': 0, 'center': (h - hh) / 2, 'bottom': h - hh}[valign]
    pic = slide.shapes.add_picture(path, Inches(xx), Inches(yy), Inches(ww), Inches(hh))
    return pic, xx, yy, ww, hh


# ─────────────────────────────────────────────────────────────────────────────
# Texte
# ─────────────────────────────────────────────────────────────────────────────
def _bullet(p, char, color, font='Arial'):
    pPr = p._p.get_or_add_pPr()
    pPr.set('marL', str(int(Inches(0.32))))
    pPr.set('indent', str(int(-Inches(0.26))))
    bc = etree.SubElement(pPr, qn('a:buClr'))
    etree.SubElement(bc, qn('a:srgbClr'), val=str(color))
    etree.SubElement(pPr, qn('a:buFont'), typeface=font)
    etree.SubElement(pPr, qn('a:buChar'), char=char)


def text(slide, x, y, w, h, content, size=16, color=INK, bold_color=None, fit=None, align='left', anchor='top',
         bold=False, italic=False, caps=False, bullet_color=PINK, line=1.0, key='', font=FONT, inset=0.06):
    """Zone de texte : **gras**, *italique*, puces « - » et cases « ☐ ». fit=(min, max) choisit la plus grande
    taille qui tient dans la zone (mesure Century Gothic) ; au-delà du minimum, l'écart est signalé."""
    if content is None:
        content = ''
    content = str(content)
    if caps:
        content = content.upper()
    paras = parse_paras(content)
    usable_w, usable_h = w - 2 * inset, h - 2 * inset
    if fit:
        lo, hi = fit
        size = lo
        s = hi
        while s >= lo - 1e-6:
            if text_height_in(paras, s, usable_w, line) <= usable_h * 0.97:
                size = s
                break
            s -= 0.5
        else:
            need = text_height_in(paras, lo, usable_w, line)
            qa(f"texte trop long ({key or content[:40]!r}) : {need:.2f} po pour {usable_h:.2f} po à {lo} pt")
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left = tf.margin_right = Inches(inset)
    tf.margin_top = tf.margin_bottom = Inches(inset)
    tf.vertical_anchor = {'top': MSO_ANCHOR.TOP, 'middle': MSO_ANCHOR.MIDDLE, 'bottom': MSO_ANCHOR.BOTTOM}[anchor]
    al = {'left': PP_ALIGN.LEFT, 'center': PP_ALIGN.CENTER, 'right': PP_ALIGN.RIGHT, 'justify': PP_ALIGN.LEFT}[align]
    if not paras:
        paras = [{'runs': [('', False, False)], 'kind': None, 'gap': False}]
    for k, pd in enumerate(paras):
        p = tf.paragraphs[0] if k == 0 else tf.add_paragraph()
        p.alignment = al
        p.line_spacing = line
        if pd['gap']:
            p.space_before = Pt(size * 0.55)
        elif pd['kind'] and k > 0:
            p.space_before = Pt(size * 0.18)
        if pd['kind'] == 'bullet':
            _bullet(p, '•', bullet_color)
        elif pd['kind'] == 'check':
            _bullet(p, '☐', bullet_color, font='Segoe UI Symbol')
        for t, b, i in pd['runs']:
            r = p.add_run()
            r.text = t
            f = r.font
            f.name = font
            f.size = Pt(size)
            f.bold = bool(b or bold)
            f.italic = bool(i or italic)
            f.color.rgb = (bold_color if (b and bold_color is not None) else color)
    return tb, size


def title(slide, s, x=M, y=0.42, w=CONTENT_W, size=34, color=TEAL, lo=24):
    """Titre sur une ligne (taille réduite si nécessaire, jamais coupé en plein mot)."""
    s = s.upper()
    sz = size
    while sz > lo and text_width_pt(s, sz, True) > (w - 0.15) * 72:
        sz -= 1
    text(slide, x, y, w, 0.9, s, size=sz, color=color, bold=True, anchor='middle', key='titre')
    return sz


def eyebrow(slide, s, x, y, w=8, color=PINK, size=13):
    text(slide, x, y, w, 0.4, s.upper(), size=size, color=color, bold=True, key='surtitre')


def footer(slide, n, client, side='left'):
    """Numéro de page et rappel du dossier, du côté libre de la slide (jamais sur une image)."""
    label = f"**{n:02d}**    Diagnostic de potentiel{(' · ' + client) if client else ''}"
    if side == 'left':
        rect(slide, M, SH - 0.49, 0.35, 0.05, PINK)
        text(slide, M + 0.45, SH - 0.66, 11, 0.36, label, size=10.5, color=MUTED, bold_color=TEAL, key='pied')
    else:
        rect(slide, SW - M - 0.35, SH - 0.49, 0.35, 0.05, PINK)
        text(slide, SW - M - 0.45 - 8, SH - 0.66, 8, 0.36, label, size=10.5, color=MUTED, bold_color=TEAL, align='right', key='pied')


# ─────────────────────────────────────────────────────────────────────────────
# Éléments du modèle (arc pointillé, logo) relus dans le fichier modèle
# ─────────────────────────────────────────────────────────────────────────────
ASSETS = {}


def load_assets(template_path, tmp):
    wanted = {'arc_tl': 'ppt/media/image23.png', 'arc_br': 'ppt/media/image1.png'}
    try:
        with zipfile.ZipFile(template_path) as z:
            names = set(z.namelist())
            for k, n in wanted.items():
                if n in names:
                    p = os.path.join(tmp, k + '.png')
                    with open(p, 'wb') as fp:
                        fp.write(z.read(n))
                    ASSETS[k] = p
    except Exception as e:
        print(f"[premium] éléments du modèle indisponibles : {e}", file=sys.stderr)


def arc(slide, which='tl'):
    p = ASSETS.get('arc_tl')
    if not p:
        return
    if which == 'tl':
        slide.shapes.add_picture(p, 0, 0, Inches(2.39), Inches(2.2))
    else:
        pic = slide.shapes.add_picture(p, Inches(SW - 2.39), Inches(SH - 2.2), Inches(2.39), Inches(2.2))
        pic.rotation = 180


# ─────────────────────────────────────────────────────────────────────────────
# Données
# ─────────────────────────────────────────────────────────────────────────────
def T(data, key):
    return str((data.get('texts') or {}).get(key) or '').strip()


def rec_label(data):
    r = str(data.get('recommended') or data.get('rec_scenario') or '').strip().upper()
    if r in ('A', 'B', 'C'):
        return r
    sc = data.get('scenarios') or {}
    return next((l for l in 'ABC' if (sc.get(l) or {}).get('recommended')), 'B')


def scenario_intro(data):
    """Sous-titres et descriptions des scénarios, lus dans le texte de la slide 3 (mêmes mots partout)."""
    out, rest = {}, []
    txt = T(data, 'slide_3_intro_text') or T(data, 'slide_3_text')
    for raw in txt.split('\n'):
        m = re.match(r'^\s*-\s*\*\*Scénario ([ABC])\s*[—-]\s*([^*]+)\*\*\s*:\s*(.*)$', raw)
        if m:
            desc = m.group(3).strip()
            tail = ''
            k = desc.find('Chacun est lu')
            if k > 0:
                desc, tail = desc[:k].strip(), desc[k:].strip()
            out[m.group(1)] = {'sub': m.group(2).strip(), 'desc': desc}
            if tail:
                rest.append(tail)
        else:
            rest.append(raw)
    return out, '\n'.join(rest).strip()


def cap1(s):
    s = str(s or '').strip()
    return s[:1].upper() + s[1:]


def fetch_images(data, tmp):
    out = {}
    local = data.get('_local_images') or {}
    base = data.get('_base_dir') or ''
    for k, url in (data.get('images') or {}).items():
        if k in local and os.path.exists(os.path.join(base, local[k])):
            out[k] = os.path.join(base, local[k])
            continue
        if not url:
            continue
        try:
            ext = '.jpg' if re.search(r'\.jpe?g(\?|$)', url, re.I) else '.png'
            p = os.path.join(tmp, f'img_{k}{ext}')
            req = urllib.request.Request(url, headers={'User-Agent': 'BARLO-PPTX/1.0'})
            with urllib.request.urlopen(req, timeout=30) as resp, open(p, 'wb') as fp:
                shutil.copyfileobj(resp, fp)
            if _img_size(p):
                out[k] = p
            else:
                qa(f"image illisible : {k}")
        except Exception as e:
            qa(f"image non téléchargée : {k} ({e})")
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Graphiques (fonctions du PPT standard, palette de la charte premium)
# ─────────────────────────────────────────────────────────────────────────────
def premium_palette():
    GC.COLORS.update({'dark': '#15616E', 'accent': '#15616E', 'text': '#1E2B31', 'muted': '#6B7780',
                      'light': '#F3F7F8', 'grid': '#DDE6E8',
                      'pie_go': '#15616E', 'pie_so': '#5E9EA8', 'pie_lt': '#D4850E', 'pie_vrd': '#EA5D91'})
    GC.LEVEL_COLORS[:] = ['#15616E', '#3F8792', '#6FAAB3', '#A2CBD1', '#D0E5E8', '#EAF3F4']
    GC.CRIT_COLORS[:] = ['#15616E', '#3F8792', '#5B8DB8', '#8B5CF6', '#D4850E', '#B07D3A', '#EA5D91']


def build_charts(data, tmp):
    premium_palette()
    d = os.path.join(tmp, 'charts')
    paths = GC.generate_all_charts(data, d)
    for l in 'ABC':
        sc = (data.get('scenarios') or {}).get(l) or {}
        p = os.path.join(d, f'donut_{l}.png')
        try:
            if sc and GC.generate_cost_donut_fit(sc, l, p):
                paths[f'donut_{l}'] = p
        except Exception as e:
            qa(f"répartition des travaux {l} indisponible : {e}")
    return {k: v for k, v in paths.items() if v and os.path.exists(v)}


def chart(slide, paths, key, x, y, w, h, halign='center', valign='center'):
    p = paths.get(key)
    if not p:
        qa(f"graphique absent : {key}")
        return None
    return pic_fit(slide, p, x, y, w, h, halign, valign)


def build_planches(data, tmp):
    out = {}
    plans = data.get('plans_v13') or {}
    for l in 'ABC':
        p = os.path.join(tmp, f'planche_{l}.png')
        if plans.get(l):
            try:
                from plans_v13 import draw_composite
                if draw_composite(plans[l], p):
                    out[l] = p
                    continue
            except Exception as e:
                qa(f"planche {l} v13 impossible : {e}")
        units = (data.get('units_by_scenario') or {}).get(l) or []
        poly = data.get('parcel_polygon') or []
        if units and len(poly) >= 3:
            try:
                from generate_pptx import _plan_generate_image
                if _plan_generate_image(l, poly, units, float(data.get('site_area') or 0), p):
                    out[l] = p
            except Exception as e:
                qa(f"plan {l} impossible : {e}")
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Slides
# ─────────────────────────────────────────────────────────────────────────────
class Deck:
    def __init__(self, prs, data, imgs, charts, planches):
        self.prs, self.data, self.imgs, self.charts, self.planches = prs, data, imgs, charts, planches
        self.layout = prs.slides[0].slide_layout
        self.client = str(data.get('client_name') or '').strip()
        self.rec = rec_label(data)
        self.intro, self.intro_rest = scenario_intro(data)
        self.numbered = []

    def new(self, footer_side='left'):
        s = self.prs.slides.add_slide(self.layout)
        for ph in list(s.placeholders):
            ph._element.getparent().remove(ph._element)
        s._element.set('showMasterSp', '0')      # décor du masque (trame de points) : posé slide par slide
        self.numbered.append((s, footer_side))
        return s

    # ── 3 · Contexte du projet ──────────────────────────────────────────────
    def contexte(self):
        s = self.new()
        dots(s, SW - 2.0, 0.45)
        rect(s, M, 0.55, 8.4, 3.0, TEAL, shadowed=True)
        rect(s, M + 7.85, 0.25, 0.85, 0.85, PINK)
        text(s, M + 0.5, 0.95, 7.3, 2.3, 'CONTEXTE\nDU PROJET', size=44, color=WHITE, bold=True, anchor='middle', key='titre contexte')
        # à gauche : situation + données clés (sans la liste des scénarios, reprise à droite)
        left = self.intro_rest.replace('**Trois scénarios** ont été chiffrés pour vous aider à arbitrer :', '').strip()
        left = re.sub(r'\n{3,}', '\n\n', left)
        tail = ''
        m = re.search(r'Chacun est lu[^\n]*', left)
        if m:
            tail = m.group(0)
            left = left.replace(tail, '').strip()
        text(s, M, 3.95, 8.4, 6.5, left, fit=(13, 19), bold_color=TEAL_D, key='slide_3_intro_text')
        # à droite : les trois scénarios
        text(s, 10.0, 0.35, 3, 1.35, '03', size=76, color=TEAL, bold=True, anchor='middle')
        text(s, 11.55, 0.62, 7, 0.8, 'Scénarios chiffrés\npour vous aider à arbitrer', size=15, color=INK, anchor='middle')
        y = 2.05
        for l in 'ABC':
            it = self.intro.get(l) or {}
            text(s, 10.0, y, 1.3, 1.6, l, size=64, color=(PINK if l == self.rec else TEAL), bold=True, anchor='top')
            body = f"**{cap1(it.get('sub') or 'Scénario ' + l)}**" + (' — recommandé' if l == self.rec else '') + '\n' + (it.get('desc') or '')
            text(s, 11.45, y + 0.12, 8.0, 2.35, body, fit=(12.5, 18), bold_color=TEAL_D, key=f'scénario {l} (slide 3)')
            y += 2.55
        if tail:
            text(s, 10.0, SH - 1.35, 9.45, 0.6, tail, size=12.5, color=MUTED, italic=True, key='angles')
        return s

    # ── 4 · Lecture stratégique du terrain ─────────────────────────────────
    def terrain(self):
        s = self.new()
        arc(s, 'tl')
        rect(s, SW - 1.25, 0, 1.25, SH, PINK)
        img = self.imgs.get('slide_4_image')
        if img:
            pic = pic_cover(s, img, 9.15, 0.45, 10.35, 10.35)
            shadow(pic)
        else:
            qa("vue aérienne du terrain absente")
            rect(s, 9.15, 0.45, 10.35, 10.35, PANEL)
        text(s, M, 1.55, 8.2, 2.2, 'LECTURE\nSTRATÉGIQUE\nDU TERRAIN', size=40, color=TEAL, bold=True, anchor='bottom', key='titre terrain')
        rect(s, M + 0.06, 3.95, 1.2, 0.07, PINK)
        text(s, M, 4.2, 8.2, 6.2, T(self.data, 'slide_4_text'), fit=(12.5, 17.5), bold_color=TEAL_D, key='slide_4_text')
        return s

    # ── 5 · Contraintes invisibles ─────────────────────────────────────────
    def contraintes(self):
        s = self.new()
        arc(s, 'tl')
        dots(s, M, SH - 1.6, rows=3)
        img = self.imgs.get('slide_4_axo_image')
        if img:
            pic_cover(s, img, 9.0, 0, SW - 9.0, SH)
        else:
            qa("vue 3D du terrain absente")
            rect(s, 9.0, 0, SW - 9.0, SH, PANEL)
        rect(s, 8.55, 1.2, 0.9, 0.9, PINK)
        text(s, M, 1.6, 7.9, 1.8, 'CONTRAINTES\nINVISIBLES', size=40, color=TEAL, bold=True, anchor='bottom', key='titre contraintes')
        rect(s, M + 0.06, 3.6, 1.2, 0.07, PINK)
        text(s, M, 3.85, 7.9, 5.9, T(self.data, 'slide_5_text'), fit=(12.5, 18), bold_color=TEAL_D, key='slide_5_text')
        return s

    # ── 6 / 9 / 12 · Volumétrie du scénario ────────────────────────────────
    def volumetrie(self, l):
        s = self.new(footer_side='right')
        img = self.imgs.get(f'scenario_{l}_massing')
        if img:
            pic_cover(s, img, 0, 0, SH, SH, zoom=1.25)
        else:
            qa(f"volumétrie 3D du scénario {l} absente")
            rect(s, 0, 0, SH, SH, PANEL)
        cx, cw = SH + 0.45, SW - SH - 0.45 - M
        rect(s, cx, 0.95, cw, 9.35, TEAL, shadowed=True)
        rect(s, SW - M - 0.55, 0.6, 0.85, 0.85, PINK)
        it = self.intro.get(l) or {}
        text(s, cx + 0.45, 1.25, cw - 0.9, 1.0, f'SCÉNARIO {l}', size=46, color=WHITE, bold=True, anchor='middle', key='titre scénario')
        sub = cap1(it.get('sub') or '')
        if l == self.rec:
            sub = (sub + '  ·  ' if sub else '') + '★ RECOMMANDÉ'
        if sub:
            text(s, cx + 0.47, 2.2, cw - 0.9, 0.45, sub.upper(), size=14, color=RGBColor(0xF6, 0xB8, 0xCF), bold=True, key='sous-titre')
        text(s, cx + 0.45, 2.8, cw - 0.9, 7.25, T(self.data, f'scenario_{l}_summary_text'), color=WHITE, bullet_color=RGBColor(0xF6, 0xB8, 0xCF),
             fit=(12, 19), key=f'scenario_{l}_summary_text')
        return s

    # ── planche : plan, axonométrie, coupe ─────────────────────────────────
    def planche(self, l):
        p = self.planches.get(l)
        if not p:
            qa(f"planche du scénario {l} absente")
            return None
        s = self.new()
        dots(s, SW - 2.0, 0.3, rows=2)
        eyebrow(s, f'Scénario {l} · implantation', M, 0.3)
        title(s, 'Plan, axonométrie et coupe', y=0.62, size=32)
        rect(s, M, 1.62, CONTENT_W, SH - 1.62 - 0.85, PANEL, radius=0.02)
        pic_fit(s, p, M + 0.2, 1.72, CONTENT_W - 0.4, SH - 1.72 - 0.95)
        return s

    # ── 7 / 10 / 13 · Lecture financière ───────────────────────────────────
    def financier(self, l):
        s = self.new()
        dots(s, SW - 2.0, 0.3, rows=2)
        eyebrow(s, f'Scénario {l}', M, 0.3)
        title(s, 'Lecture financière et technique', y=0.62, size=32)
        top = 1.65
        rect(s, M, top, 9.1, 4.55, TEAL, shadowed=True)
        text(s, M + 0.4, top + 0.3, 8.3, 3.95, T(self.data, f'scenario_{l}_financial_text'), color=WHITE,
             bullet_color=RGBColor(0xF6, 0xB8, 0xCF), fit=(12, 18), key=f'scenario_{l}_financial_text')
        rect(s, 10.0, top, SW - M - 10.0, 4.55, PANEL, radius=0.03)
        chart(s, self.charts, f'donut_{l}', 10.15, top + 0.12, SW - M - 10.3, 4.3)
        # calcul du coût puis position face à la fourchette, pleine largeur
        y = top + 4.55 + 0.25
        avail = SH - 0.8 - y
        k = min(2.05, (avail - 0.2) / (GC.SLOTS['cost_calc'][1] + GC.SLOTS['budget_gauge'][1]), CONTENT_W / GC.SLOTS['cost_calc'][0])
        w1, h1 = GC.SLOTS['cost_calc'][0] * k, GC.SLOTS['cost_calc'][1] * k
        w2, h2 = GC.SLOTS['budget_gauge'][0] * k, GC.SLOTS['budget_gauge'][1] * k
        chart(s, self.charts, f'scenario_{l}_cost_calc', (SW - w1) / 2, y, w1, h1)
        chart(s, self.charts, f'scenario_{l}_budget_gauge', (SW - w2) / 2, y + h1 + 0.2, w2, h2)
        return s

    # ── 8 / 11 / 14 · Exposition et fragilités ─────────────────────────────
    def risques(self, l):
        s = self.new()
        dots(s, SW - 2.0, 0.3, rows=2)
        eyebrow(s, f'Scénario {l}', M, 0.3)
        title(s, 'Exposition et fragilités', y=0.62, size=32)
        cw_, ch_ = GC.SLOTS['risk_cell']
        gap = 0.2
        k = (CONTENT_W - 2 * gap) / (3 * cw_)
        w, h = cw_ * k, ch_ * k
        y = 1.65
        for i, key in enumerate(['risk_radar', 'risk_gauge', 'risk_bars']):
            x = M + i * (w + gap)
            rect(s, x, y, w, h, PANEL, radius=0.03)
            chart(s, self.charts, f'scenario_{l}_{key}', x, y, w, h)
        ty = y + h + 0.3
        rect(s, M, ty, CONTENT_W, SH - 0.8 - ty, TEAL, shadowed=True)
        text(s, M + 0.4, ty + 0.22, CONTENT_W - 0.8, SH - 0.8 - ty - 0.4, T(self.data, f'scenario_{l}_risk_text'), color=WHITE,
             bullet_color=RGBColor(0xF6, 0xB8, 0xCF), fit=(11.5, 18), key=f'scenario_{l}_risk_text')
        return s

    # ── 15 · Comparatif global ─────────────────────────────────────────────
    def comparatif(self):
        s = self.new()
        eyebrow(s, 'Les trois scénarios', M, 0.3)
        title(s, 'Comparatif global', y=0.62, w=7.5, size=32)
        rect(s, 8.1, 0.45, 0.07, 1.0, PINK)
        text(s, 8.35, 0.35, SW - M - 8.35, 1.2, T(self.data, 'comparatif_intro_text'), fit=(11.5, 14.5), color=MUTED, anchor='middle',
             key='comparatif_intro_text')
        cw_, ch_ = GC.SLOTS['comparatif']
        avail_h = SH - 0.8 - 1.7
        k = min(CONTENT_W / cw_, avail_h / ch_)
        chart(s, self.charts, 'tableau_comparative_charts', (SW - cw_ * k) / 2, 1.7, cw_ * k, ch_ * k)
        return s

    # ── 16 · Arbitrage ─────────────────────────────────────────────────────
    def arbitrage(self):
        s = self.new()
        cw_, ch_ = GC.SLOTS['arbitrage']
        k = CONTENT_W / cw_
        ch = ch_ * k
        card_h = SH - 0.8 - ch - 0.3 - 0.4
        rect(s, M, 0.4, CONTENT_W, card_h, TEAL, shadowed=True)
        rect(s, SW - 1.3, 0.15, 0.8, 0.8, PINK)
        text(s, M + 0.45, 0.6, 12, 0.8, 'ARBITRAGE STRATÉGIQUE', size=32, color=WHITE, bold=True, anchor='middle', key='titre arbitrage')
        text(s, M + 0.45, 1.45, CONTENT_W - 0.9, card_h - 1.2, T(self.data, 'strategic_arbitrage_text'), color=WHITE,
             bullet_color=RGBColor(0xF6, 0xB8, 0xCF), fit=(11.5, 18.5), key='strategic_arbitrage_text')
        chart(s, self.charts, 'arbitrage_graph_', M, 0.4 + card_h + 0.3, CONTENT_W, ch)
        return s

    # ── 17 · Conditions de réussite (coûts, budget à prévoir, calendrier) ──
    def conditions(self):
        s = self.new()
        dots(s, SW - 2.0, 0.3, rows=2)
        eyebrow(s, f'Scénario {self.rec} recommandé', M, 0.3)
        title(s, 'Conditions de réussite', y=0.62, size=32)
        intro = T(self.data, 'invisible_intro_text')
        intro = re.sub(r'^\*\*Conditions de réussite\*\*\s*[—-]\s*', '', intro)
        text(s, M, 1.45, CONTENT_W, 0.5, cap1(intro), size=15, color=TEAL_D, italic=True, key='invisible_intro_text')
        cols = [('Coûts et calendrier', 'invisible_technical_text'), ('Budget à prévoir', 'invisible_financial_text'),
                ('Saisons et décaissements', 'invisible_strategic_text')]
        gap = 0.3
        w = (CONTENT_W - 2 * gap) / 3
        y, h = 2.1, 5.35
        for i, (hd, key) in enumerate(cols):
            x = M + i * (w + gap)
            rect(s, x, y, w, h, WHITE, radius=0.03, shadowed=True)
            rect(s, x, y, w, 0.62, TEAL)
            text(s, x + 0.3, y, w - 0.6, 0.62, hd.upper(), size=14, color=WHITE, bold=True, anchor='middle', key='entête colonne')
            text(s, x + 0.25, y + 0.78, w - 0.5, h - 0.95, T(self.data, key), fit=(11, 16), bold_color=TEAL_D, key=key)
        self._budget_table(s, M, y + h + 0.35, CONTENT_W, SH - 0.8 - (y + h + 0.35))
        return s

    def _budget_table(self, s, x, y, w, h):
        d = self.data
        fit_lbl = {'DANS_BUDGET': 'Bas de votre fourchette', 'BUDGET_TENDU': 'Haut de votre fourchette', 'HORS_BUDGET': 'Au-dessus de votre fourchette'}
        hdr = ['Scénario', 'Surface de plancher', 'Prix courant / m²', 'Prix retenu / m²', 'Coût des travaux', 'Position budget']

        def milliers(v):   # « 250k » → « 250 000 FCFA »
            m = re.match(r'^\s*(\d+)\s*k', str(v or ''))
            return f"{m.group(1)}\u00a0000 FCFA" if m else (f"{v} FCFA" if v else '—')

        def position(l):   # v13.6 — position réelle (bas / milieu / haut), la même que dans les textes
            p = str(d.get(f'{l}_budget_position', '') or '')
            if p and p != 'budget non renseigné':
                return cap1(p)
            return fit_lbl.get(str(d.get(f'{l}_budget_fit', '')), '—')

        def cout(v):   # « 57M FCFA » → « 57 M FCFA »
            return re.sub(r'(\d)\s*M\s*FCFA', '\\1\u00a0M\u00a0FCFA', str(v or '—'))

        rows = []
        for l in 'ABC':
            rows.append([f'Scénario {l}' + ('  ★' if l == self.rec else ''), f"{d.get(f'{l}_sdp', '—')}\u00a0m²",
                         milliers(d.get(f'{l}_cost_m2_marche')), milliers(d.get(f'{l}_cost_m2_ajuste')),
                         cout(d.get(f'{l}_cost_total')), position(l)])
        n = len(rows) + 1
        rh = min(0.58, h / n)
        gt = s.shapes.add_table(n, len(hdr), Inches(x), Inches(y), Inches(w), Inches(rh * n))
        tbl = gt.table
        widths = [2.6, 3.0, 3.1, 3.1, 3.2, w - 15.0]
        for i, cw in enumerate(widths):
            tbl.columns[i].width = Inches(cw)
        for r in range(n):
            tbl.rows[r].height = Inches(rh)
            for c in range(len(hdr)):
                cell = tbl.cell(r, c)
                val = hdr[c] if r == 0 else rows[r - 1][c]
                cell.text = val
                cell.margin_left = cell.margin_right = Inches(0.1)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                cell.fill.solid()
                is_rec = r > 0 and rows[r - 1][0].endswith('★')
                cell.fill.fore_color.rgb = TEAL if r == 0 else (TEAL_L if is_rec else (WHITE if r % 2 else PANEL))
                for p in cell.text_frame.paragraphs:
                    p.alignment = PP_ALIGN.LEFT if c == 0 else PP_ALIGN.CENTER
                    for run in p.runs:
                        run.font.name = FONT
                        run.font.size = Pt(13 if r == 0 else 13.5)
                        run.font.bold = (r == 0 or c == 0 or is_rec)
                        run.font.color.rgb = WHITE if r == 0 else (TEAL_D if is_rec else INK)

    # ── 18 · Points clés & checklist ───────────────────────────────────────
    def checklist(self):
        s = self.new()
        rect(s, 0, 0, SW, 4.1, TEAL)
        dots(s, SW - 2.0, 0.45, rows=3, color=RGBColor(0x5E, 0x9E, 0xA8))
        text(s, 0.9, 0.5, 14, 0.95, 'POINTS CLÉS & CHECKLIST', size=40, color=WHITE, bold=True, anchor='middle', key='titre checklist')
        text(s, 0.9, 1.5, SW - 1.8, 1.0, T(self.data, 'success_intro_text'), fit=(13, 16), color=WHITE, key='success_intro_text')
        cols = ['success_technical_text', 'success_financial_text', 'success_strategic_text']
        gap = 0.4
        w = (SW - 1.8 - 2 * gap) / 3
        y, h = 2.85, SH - 0.8 - 2.85
        for i, key in enumerate(cols):
            x = 0.9 + i * (w + gap)
            rect(s, x, y, w, h, WHITE, radius=0.03, shadowed=True)
            rect(s, x + 0.35, y + 0.35, 0.9, 0.08, PINK)
            body = T(self.data, key)
            head, rest = '', body
            m = re.match(r'^\*\*([^*]+?)\s*:?\*\*\s*\n', body)
            if m:
                head, rest = m.group(1).strip().rstrip(':').strip(), body[m.end():].strip()
            text(s, x + 0.3, y + 0.52, w - 0.6, 1.0, head or '', fit=(13, 17.5), color=TEAL, bold=True, key=key + ' (titre)')
            text(s, x + 0.3, y + 1.55, w - 0.6, h - 1.75, rest, fit=(11, 16), bold_color=TEAL_D, bullet_color=TEAL, key=key)
        return s

    # ── 19 · Étude de faisabilité : les étapes du projet ───────────────────
    PHASE_DESC = {
        'Études de conception': 'Esquisse, APS, APD et étude de sol : plans, structure et budget affinés.',
        'Permis et consultation des entreprises': 'Dépôt et instruction du permis ; appel d\'offres et choix de l\'entreprise.',
        'Terrassement et fondations': 'Implantation, terrassement et fondations, de préférence en saison sèche.',
        'Gros œuvre': 'Structure en béton armé, élévations, planchers et toiture : bâtiment hors d\'eau.',
        'Second œuvre et installations techniques': 'Cloisons, menuiseries, électricité, plomberie, ventilation.',
        'Finitions, raccordements et réception': 'Revêtements, peinture, raccordements extérieurs, réception des travaux.',
    }

    def faisabilite(self):
        s = self.new()
        arc(s, 'tl')
        eyebrow(s, f'Scénario {self.rec} recommandé', 2.6, 0.3)
        title(s, 'Étude de faisabilité et étapes', x=2.6, y=0.62, w=SW - 2.6 - M, size=32)
        text(s, 2.6, 1.42, SW - 2.6 - M, 0.9, T(self.data, 'next_step_intro_text'), fit=(12.5, 15), bold_color=TEAL_D, key='next_step_intro_text')
        sc = (self.data.get('scenarios') or {}).get(self.rec) or {}
        phases = ((sc.get('schedule') or {}).get('phases') or [])[:6]
        if not phases:
            qa("calendrier du scénario recommandé absent")
            return s
        # étapes en zigzag : textes au-dessus des étapes hautes, en dessous des étapes basses (le trait ne les croise pas)
        n = len(phases)
        step = CONTENT_W / n
        bw, bh = min(2.75, step - 0.3), 0.8
        ys = (4.55, 6.15)
        centers = [(M + step * (i + 0.5), ys[i % 2] + bh / 2) for i in range(n)]
        for (x1, y1), (x2, y2) in zip(centers, centers[1:]):
            line_shape(s, x1, y1, x2, y2, TEAL, 2.25)
        for i, p in enumerate(phases):
            cx, _ = centers[i]
            y = ys[i % 2]
            m = f"M{p['debut']}" if p['debut'] == p['fin'] else f"M{p['debut']}–M{p['fin']}"
            rect(s, cx - bw / 2, y, bw, bh, (PINK if p.get('groupe') == 'travaux' and i == n - 1 else TEAL), shadowed=True)
            text(s, cx - bw / 2, y, bw, bh, m, size=22, color=WHITE, bold=True, align='center', anchor='middle', key='mois')
            nm = cap1(p.get('nom') or '')
            body = f"**{nm}**\n{p.get('mois')} mois — {self.PHASE_DESC.get(p.get('nom'), '')}"
            if i % 2 == 0:
                text(s, cx - step / 2 + 0.08, y - 2.1, step - 0.16, 2.0, body, fit=(11, 14.5), color=INK, bold_color=TEAL_D,
                     align='center', anchor='bottom', key=f"phase {nm}")
            else:
                text(s, cx - step / 2 + 0.08, y + bh + 0.1, step - 0.16, 2.0, body, fit=(11, 14.5), color=INK, bold_color=TEAL_D,
                     align='center', anchor='top', key=f"phase {nm}")
        groupes = [('etudes', 'Études et autorisations'), ('travaux', 'Travaux')]
        tot = sum(int(p.get('mois') or 0) for p in phases)
        legend = '   ·   '.join(f"{lbl} : {sum(int(p.get('mois') or 0) for p in phases if p.get('groupe') == g)} mois" for g, lbl in groupes)
        rect(s, M, 9.25, CONTENT_W, 0.62, TEAL_L, radius=0.3)
        text(s, M, 9.25, CONTENT_W, 0.62, f"**Délai total : {tot} mois**   ·   {legend}", size=16, color=TEAL_D, bold_color=TEAL, align='center',
             anchor='middle', key='délai')
        return s

    # ── 20 · Calendrier et périmètre des études ────────────────────────────
    def calendrier(self):
        s = self.new()
        eyebrow(s, 'Prochaine étape', M, 0.3)
        title(s, 'Calendrier et périmètre des études', y=0.62, size=32)
        cw_, ch_ = GC.SLOTS['timeline']
        k = CONTENT_W / cw_
        chart(s, self.charts, 'timeline', M, 1.6, CONTENT_W, ch_ * k)
        y = 1.6 + ch_ * k + 0.3
        h = SH - 0.8 - y
        rect(s, M, y, 12.9, h, TEAL, shadowed=True)
        text(s, M + 0.4, y + 0.25, 12.1, h - 0.45, T(self.data, 'next_step_scope_text'), color=WHITE,
             bullet_color=RGBColor(0xF6, 0xB8, 0xCF), fit=(11, 17), key='next_step_scope_text')
        x2 = M + 12.9 + 0.35
        rect(s, x2, y, SW - M - x2, h, WHITE, radius=0.03, shadowed=True)
        rect(s, x2 + 0.35, y + 0.35, 0.9, 0.08, PINK)
        text(s, x2 + 0.3, y + 0.55, SW - M - x2 - 0.6, h - 0.8, T(self.data, 'next_step_outcome_text'), fit=(12, 19), bold_color=TEAL, key='next_step_outcome_text')
        return s

    # ── 21 · Projection finale ─────────────────────────────────────────────
    def projection(self):
        s = self.new()
        arc(s, 'tl')
        rect(s, 13.4, 0, SW - 13.4, 7.4, TEAL)
        img = self.imgs.get(f'scenario_{self.rec}_massing')
        if img:
            rect(s, 10.0, 0.5, 6.6, 6.6, WHITE, shadowed=True)
            pic_cover(s, img, 10.12, 0.62, 6.36, 6.36, zoom=1.6)
        text(s, 16.9, 0.9, 2.6, 1.6, f'SCÉNARIO\n{self.rec}', size=26, color=WHITE, bold=True, key='repère scénario')
        sub = cap1((self.intro.get(self.rec) or {}).get('sub') or '')
        if sub:
            text(s, 16.92, 2.45, 2.6, 0.9, sub.upper() + '\n★ RECOMMANDÉ', size=12.5, color=RGBColor(0xF6, 0xB8, 0xCF), bold=True, key='sous-titre')
        text(s, M, 0.95, 9.0, 1.6, 'PROJECTION\nFINALE', size=40, color=TEAL, bold=True, anchor='bottom', key='titre projection')
        rect(s, M + 0.06, 2.72, 1.2, 0.07, PINK)
        body = T(self.data, 'conclusion_summary_text')
        proj = T(self.data, 'conclusion_projection_text')
        if proj:
            proj = proj.split('\n\n')[0]            # l'horizon de livraison ; le calendrier est détaillé slide précédente
            body = body + '\n\n' + proj
        text(s, M, 2.95, 9.1, 4.6, body, fit=(11.5, 16.5), bold_color=TEAL_D, key='conclusion')
        cw_, ch_ = GC.SLOTS['recap_card']
        k = CONTENT_W / cw_
        chart(s, self.charts, 'recap_card', M, SH - 0.8 - ch_ * k, CONTENT_W, ch_ * k)
        return s


# ─────────────────────────────────────────────────────────────────────────────
# Slides conservées du modèle (couverture, manifeste, merci)
# ─────────────────────────────────────────────────────────────────────────────
def restyle_fonts(slide):
    """Montserrat du modèle → Century Gothic ; les graisses ExtraBold / Black / Bold deviennent du gras."""
    for el in slide._element.iter(qn('a:latin')):
        face = el.get('typeface') or ''
        if re.search(r'Bold|Black|Heavy', face):
            rpr = el.getparent()
            if rpr is not None and rpr.tag in (qn('a:rPr'), qn('a:endParaRPr'), qn('a:defRPr')):
                rpr.set('b', '1')
        el.set('typeface', FONT)
    for tag in ('a:ea', 'a:cs'):
        for el in slide._element.iter(qn(tag)):
            el.set('typeface', FONT)


def theme_fonts(prs):
    """Polices du thème (textes sans police explicite) : Century Gothic."""
    try:
        from pptx.opc.constants import RELATIONSHIP_TYPE as RT
        for master in prs.slide_masters:
            th = master.part.part_related_by(RT.THEME)
            if getattr(th, '_element', None) is not None:
                for tag in ('a:majorFont', 'a:minorFont'):
                    for mf in th._element.iter(qn(tag)):
                        lat = mf.find(qn('a:latin'))
                        if lat is not None:
                            lat.set('typeface', FONT)
            else:
                xml = th.blob.decode('utf-8')
                xml = re.sub(r'(<a:(?:major|minor)Font>\s*<a:latin typeface=")[^"]*(")', r'\g<1>' + FONT + r'\2', xml)
                th._blob = xml.encode('utf-8')
    except Exception as e:
        print(f"[premium] polices du thème inchangées : {e}", file=sys.stderr)


def _shape_with(slide, start):
    for sh in slide.shapes:
        if sh.has_text_frame and sh.text_frame.text.strip().upper().startswith(start.upper()):
            return sh
    return None


def _set_sizes(shape, pt):
    for p in shape.text_frame.paragraphs:
        for r in p.runs:
            r.font.size = Pt(pt)


def cover(slide, data):
    restyle_fonts(slide)
    client = str(data.get('client_name') or '').strip()
    site = str(data.get('site_area') or '').strip()
    city = str(data.get('city') or '').strip()
    budget = str(data.get('budget_label') or data.get('budget_fcfa') or '').strip()
    parts = [client] if client else []
    if site:
        parts.append(f"Terrain {site} m²" + (f" à {city}" if city else ''))
    if budget:
        parts.append(f"Budget {budget}")
    line = ' | '.join(parts)
    tsh = _shape_with(slide, 'Diagnostic de')
    if tsh is not None:
        paras = tsh.text_frame.paragraphs
        for k, p in enumerate(paras):
            if k == 0:
                p.line_spacing = 0.95
            for r in p.runs:
                r.font.size = Pt(66 if k == 0 else 24)
    for sh in slide.shapes:
        if sh.has_text_frame and 'Terrain' in sh.text_frame.text and '|' in sh.text_frame.text:
            p = sh.text_frame.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER
            pPr = p._p.get_or_add_pPr()
            for att in ('marL', 'marR', 'indent'):
                if att in pPr.attrib:
                    del pPr.attrib[att]
            runs = p.runs
            if runs:
                runs[0].text = line
                for r in runs[1:]:
                    r.text = ''
            for extra in list(sh.text_frame.paragraphs[1:]):
                extra._p.getparent().remove(extra._p)
            if tsh is not None:
                sh.left, sh.width = tsh.left, tsh.width
            size = 20
            while size > 14 and text_width_pt(line, size) > Emu(sh.width).inches * 72 * 0.98:
                size -= 1
            _set_sizes(sh, size)
            break


def manifesto(slide):
    restyle_fonts(slide)
    t = _shape_with(slide, 'CE DIAGNOSTIC')
    if t is not None:
        _set_sizes(t, 46)
        for p in t.text_frame.paragraphs:
            p.line_spacing = 0.95
    b = _shape_with(slide, 'Ce document')
    if b is not None:
        _set_sizes(b, 17)


def merci(slide):
    restyle_fonts(slide)
    # adresse du site sur une seule ligne (elle se coupait avant « m ») : marge droite du paragraphe retirée
    for sh in slide.shapes:
        if sh.has_text_frame and 'immodiaspo' in sh.text_frame.text:
            for p in sh.text_frame.paragraphs:
                full = ''.join(r.text for r in p.runs)
                if 'immodiaspo' in full:
                    pPr = p._p.get_or_add_pPr()
                    if 'marR' in pPr.attrib:
                        del pPr.attrib['marR']
                    # un seul lien (le modèle le découpait en trois morceaux, coupés à l'affichage)
                    runs = p.runs
                    runs[0].text = full.strip()
                    runs[0].font.size = Pt(18)
                    for r in runs[1:]:
                        r._r.getparent().remove(r._r)


# ─────────────────────────────────────────────────────────────────────────────
# Assemblage
# ─────────────────────────────────────────────────────────────────────────────
def _media_hashes_of(prs, slide_indexes):
    out = set()
    for i in slide_indexes:
        for rel in prs.slides[i].part.rels.values():
            if 'image' in rel.reltype:
                try:
                    out.add(hashlib.sha1(rel.target_part.blob).hexdigest())
                except Exception:
                    pass
    return out


def _all_media_hashes(prs):
    out = set()
    for s in prs.slides:
        for rel in s.part.rels.values():
            if 'image' in rel.reltype:
                out.add(hashlib.sha1(rel.target_part.blob).hexdigest())
    return out


def renumber_slide_parts(prs):
    """Noms internes slide1.xml … slideN.xml dans l'ordre : après suppression de slides, python-pptx
    réattribuerait un nom déjà pris (deux « slide22.xml » dans l'archive → fichier illisible)."""
    from pptx.opc.packuri import PackURI
    slides = list(prs.slides)
    for i, sl in enumerate(slides):
        sl.part.partname = PackURI(f'/ppt/slides/barlo_tmp_{i + 1}.xml')
    for i, sl in enumerate(slides):
        sl.part.partname = PackURI(f'/ppt/slides/slide{i + 1}.xml')


def build(data, template_path, output_path):
    tmp = tempfile.mkdtemp(prefix='barlo_premium_')
    try:
        load_assets(template_path, tmp)
        imgs = fetch_images(data, tmp)
        charts = build_charts(data, tmp)
        planches = build_planches(data, tmp)
        prs = Presentation(template_path)
        n0 = len(prs.slides)
        # médias de l'exemple : ceux des slides 3 à 21 du modèle (sauf éléments de charte réutilisés)
        kept_hashes = _media_hashes_of(prs, [0, 1, n0 - 1])
        sample_hashes = _media_hashes_of(prs, range(2, n0 - 1)) - kept_hashes
        for p in ASSETS.values():
            with open(p, 'rb') as fp:
                sample_hashes.discard(hashlib.sha1(fp.read()).hexdigest())
        # slides de l'exemple retirées (le paquet ne garde que les médias encore utilisés)
        lst = prs.slides._sldIdLst
        for sldId in list(lst)[2:n0 - 1]:
            prs.part.drop_rel(sldId.rId)
            lst.remove(sldId)
        renumber_slide_parts(prs)
        theme_fonts(prs)
        cover(prs.slides[0], data)
        manifesto(prs.slides[1])
        merci(prs.slides[2])
        d = Deck(prs, data, imgs, charts, planches)
        d.numbered = []
        d.contexte()
        d.terrain()
        d.contraintes()
        for l in 'ABC':
            d.planche(l)       # v13.6 — ordre retenu par Jeremy : la planche, puis la fiche du scénario
            d.volumetrie(l)
            d.financier(l)
            d.risques(l)
        d.comparatif()
        d.arbitrage()
        d.conditions()
        d.checklist()
        d.faisabilite()
        d.calendrier()
        d.projection()
        # « Merci » en dernier
        lst = prs.slides._sldIdLst
        merci_id = list(lst)[2]
        lst.remove(merci_id)
        lst.append(merci_id)
        renumber_slide_parts(prs)
        # pieds de page numérotés
        order = [sl.slide_id for sl in prs.slides]
        for sl, side in d.numbered:
            footer(sl, order.index(sl.slide_id) + 1, d.client, side)
        # ── contrôle final : aucune donnée de l'exemple ──
        alltext = '\n'.join(sh.text_frame.text for sl in prs.slides for sh in sl.shapes if sh.has_text_frame)
        for bad in ('Behalal', 'Marcelle', 'Scénario Ambition', 'Intensification maximale', '{{'):
            if bad in alltext:
                qa(f"RESTE DE L'EXEMPLE : « {bad} »")
        left = _all_media_hashes(prs) & sample_hashes
        if left:
            qa(f"RESTE DE L'EXEMPLE : {len(left)} image(s) du modèle encore présentes")
        prs.save(output_path)
        with zipfile.ZipFile(output_path) as z:
            names = z.namelist()
            dup = sorted({n for n in names if names.count(n) > 1})
            if dup:
                qa(f"archive invalide, noms en double : {', '.join(dup[:3])}")
        print(f"[premium] {len(prs.slides)} slides · graphiques {len(charts)} · planches {''.join(sorted(planches))} · "
              f"images {''.join(sorted(k[9] if k.startswith('scenario_') else '·' for k in imgs))} · contrôles {len(QA)}")
        if not QA:
            print("[PREMIUM-QA] OK : aucun reste de l'exemple, tous les textes tiennent dans leur zone")
        return output_path
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    if len(sys.argv) < 4:
        print("Usage: python3 generate_pptx_premium.py <data.json> <template.pptx> <output.pptx>", file=sys.stderr)
        sys.exit(1)
    data_file, template, output = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(data_file, 'r', encoding='utf-8') as fp:
        data = json.load(fp)
    data.setdefault('_base_dir', os.path.dirname(os.path.abspath(data_file)))
    build(data, template, output)


if __name__ == '__main__':
    main()
