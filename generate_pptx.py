#!/usr/bin/env python3
"""
BARLO -- Server-side PPTX generation from diagnostic data.
v4.0 -- Premium density: font sizes calibrated, structural text templates.
v75.2 -- ADD "Plan d'implantation" slide after each massing slide (A/B/C).
         Reads data['units_by_scenario'] and data['parcel_polygon'] injected by server.js.
         The plan slide is ADDITIONAL, does NOT replace the existing 3D massing slide.
"""
import json, sys, os, re, copy, math, tempfile, urllib.request, shutil
from pptx import Presentation
from pptx.util import Inches, Emu, Pt
from pptx.enum.text import PP_ALIGN
from pptx.dml.color import RGBColor
from generate_charts import generate_all_charts

# v75.2 — matplotlib (deja utilise par generate_charts) pour dessiner le plan d'implantation
import matplotlib
matplotlib.use('Agg')  # backend non-interactif
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MplPolygon, Rectangle as MplRectangle, FancyArrowPatch
from matplotlib.transforms import Affine2D

# -------------------------------------------------------------
# PLACEHOLDER MAPPINGS
# -------------------------------------------------------------

IMAGE_PLACEHOLDERS = {
    '{{slide_4_image}}',
    '{{slide_4_axo_image}}',
    '{{scenario_A_massing}}',
    '{{scenario_B_massing}}',
    '{{scenario_C_massing}}',
}

CHART_PLACEHOLDERS = {
    '{{scenario_A_risk_chart}}': ['scenario_A_risk_radar', 'scenario_A_risk_gauge', 'scenario_A_risk_bars'],
    '{{scenario_B_risk_chart}}': ['scenario_B_risk_radar', 'scenario_B_risk_gauge', 'scenario_B_risk_bars'],
    '{{scenario_C_risk_chart}}': ['scenario_C_risk_radar', 'scenario_C_risk_gauge', 'scenario_C_risk_bars'],
    '{{tableau comparative_charts}}': ['tableau_comparative_charts'],
    '{{arbitrage_graph_}}': ['arbitrage_graph_'],
}

SLIDE_SPECIFIC_TEXT = {
    (17, '{{invisible_technical_text}}'): 'invisible_technical_text_s17',
    (17, '{{invisible_financial_text}}'): 'invisible_financial_text_s17',
    (17, '{{invisible_strategic_text}}'): 'invisible_strategic_text_s17',
    (18, '{{invisible_technical_text}}'): 'invisible_technical_text_s18',
    (18, '{{invisible_financial_text}}'): 'invisible_financial_text_s18',
    (18, '{{invisible_strategic_text}}'): 'invisible_strategic_text_s18',
}

# Risk chart slides that need fallback shape detection
RISK_CHART_SLIDES = {8, 11, 14}

# -------------------------------------------------------------
# UTILITY FUNCTIONS
# -------------------------------------------------------------

def download_image(url, dest_dir):
    try:
        filename = os.path.join(dest_dir, os.path.basename(url).split('?')[0] or 'image.png')
        req = urllib.request.Request(url, headers={'User-Agent': 'BARLO-PPTX/1.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            with open(filename, 'wb') as f:
                shutil.copyfileobj(resp, f)
        return filename
    except Exception as e:
        print(f"WARNING: Failed to download {url}: {e}", file=sys.stderr)
        return None

def find_placeholder_in_shape(shape, placeholder_text):
    if not shape.has_text_frame:
        return False
    full_text = ''.join(run.text for para in shape.text_frame.paragraphs for run in para.runs)
    if not full_text:
        full_text = shape.text_frame.text
    return placeholder_text in full_text

def get_shape_placeholder(shape):
    if not shape.has_text_frame:
        return None
    full_text = shape.text_frame.text
    match = re.search(r'\{\{[^}]+\}\}', full_text)
    if match:
        return match.group(0)
    match = re.search(r'\{\{([a-zA-Z_][a-zA-Z0-9_ ]*)\}', full_text)
    if match:
        return '{{' + match.group(1) + '}}'
    return None

def clear_shape_text(shape):
    if shape.has_text_frame:
        for para in shape.text_frame.paragraphs:
            for run in para.runs:
                run.text = ''

# -------------------------------------------------------------
# FONT SIZE STRATEGY
# -------------------------------------------------------------
# Template uses 15pt body / 16pt client_name.
# Reference PDF shows ~13-14pt for body text (auto-shrunk from 15pt).
# We keep template fonts for most slides and only override for dense slides.
# fontScale=80000 (80%) prevents over-shrinking.

def get_font_size_for_slide(slide_num):
    """
    Return target font size matching premium document density.
    v74.13 -- Calibration : textes refondus plus courts (lot P4) → on peut
    remonter les tailles. Cible architecte conseil moderne, lisible.
    Slides 8/11/14/16 spécifiquement remontées (feedback user "trop petits").
    """
    if slide_num == 3:
        return Pt(12)    # Intro -- moderate density, slightly bumped
    elif slide_num in [6, 9, 12]:
        return Pt(11)    # Scenario summaries -- bumped from 9 (textes raccourcis)
    elif slide_num == 5:
        return Pt(11)    # Context -- bumped from 9
    elif slide_num in [8, 11, 14]:
        return Pt(12)    # Risk slides -- BUMPED from 10 (feedback "trop petits")
    elif slide_num in [4, 7, 10, 13, 19]:
        return Pt(11)    # Site, financial, next steps -- bumped from 10
    elif slide_num == 16:
        return Pt(12)    # Strategic arbitrage -- BUMPED from 10 (feedback "trop petit")
    elif slide_num in [17, 18]:
        return Pt(10)    # 3-column layout -- bumped from 9 (still dense but legible)
    elif slide_num == 20:
        return Pt(12)    # Conclusion -- bumped from 11
    else:
        return None       # Keep template font (15-16pt) for slides 1, 2, 15

def set_font_size_for_shape(shape, font_size_pt):
    """
    Set all text runs in a shape to a specific font size.
    Only called when font_size_pt is not None.
    """
    if not shape.has_text_frame or font_size_pt is None:
        return
    for para in shape.text_frame.paragraphs:
        for run in para.runs:
            run.font.size = font_size_pt

def enable_auto_shrink(shape, fontScale=80000):
    """
    Enable auto-shrink for text overflow.
    fontScale=80000 = 80% minimum (15pt base → 12pt min, 12pt base → 9.6pt min)
    """
    if not shape.has_text_frame:
        return
    from lxml import etree
    ns = 'http://schemas.openxmlformats.org/drawingml/2006/main'
    txBody = shape.text_frame._txBody
    bodyPr = txBody.find(f'{{{ns}}}bodyPr')
    if bodyPr is None:
        return
    for child_tag in ['noAutofit', 'normAutofit', 'spAutoFit']:
        existing = bodyPr.find(f'{{{ns}}}{child_tag}')
        if existing is not None:
            bodyPr.remove(existing)
    normAutofit = etree.SubElement(bodyPr, f'{{{ns}}}normAutofit')
    normAutofit.set('fontScale', str(fontScale))

# -------------------------------------------------------------
# TEXT REPLACEMENT
# -------------------------------------------------------------

def replace_text_in_shape(shape, placeholder, new_text):
    if not shape.has_text_frame:
        return
    tf = shape.text_frame
    placeholder_found = False
    placeholder_core = placeholder.strip('{}')
    for para in tf.paragraphs:
        para_text = ''.join(run.text for run in para.runs)
        if not para_text:
            para_text = para.text
        if placeholder in para_text or ('{{' + placeholder_core) in para_text:
            placeholder_found = True
            break
    if not placeholder_found:
        return
    # Get reference run for formatting
    ref_run = None
    for para in tf.paragraphs:
        for run in para.runs:
            ref_run = run
            break
        if ref_run:
            break
    new_paragraphs = new_text.split('\n') if new_text else ['']
    xml_element = tf._txBody
    p_elements = xml_element.findall('{http://schemas.openxmlformats.org/drawingml/2006/main}p')
    for p_elem in p_elements[1:]:
        xml_element.remove(p_elem)
    first_p = p_elements[0]
    r_elements = first_p.findall('{http://schemas.openxmlformats.org/drawingml/2006/main}r')
    for r_elem in r_elements:
        first_p.remove(r_elem)
    _add_run_to_paragraph(first_p, new_paragraphs[0], ref_run)
    for para_text in new_paragraphs[1:]:
        new_p = copy.deepcopy(first_p)
        r_elements = new_p.findall('{http://schemas.openxmlformats.org/drawingml/2006/main}r')
        for r_elem in r_elements:
            new_p.remove(r_elem)
        _add_run_to_paragraph(new_p, para_text, ref_run)
        xml_element.append(new_p)

def _parse_markdown_bold(text):
    """v74.12 — Parse markdown **bold** into [(text, is_bold), ...] segments.
    Robust against unbalanced markers : ** sans pair → traite comme texte normal."""
    if not text or '**' not in text:
        return [(text or '', False)]
    segments = []
    parts = text.split('**')
    # Si nombre impair de **, le dernier segment reste en non-bold (markers déséquilibrés)
    is_bold = False
    for part in parts:
        if part:
            segments.append((part, is_bold))
        is_bold = not is_bold
    # Si on a fini en is_bold=True (impair), le dernier ** orphelin a inversé pour rien.
    # Pas de souci, le segment a déjà été ajouté avec son flag correct.
    return segments

def _add_run_to_paragraph(p_element, text, ref_run=None):
    """v74.12 — Crée 1+ runs en parsant markdown **bold**.
    Si pas de **, comportement identique à avant (1 seul run).
    Sinon, alterne runs normaux et runs bold."""
    from lxml import etree
    A_NS = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
    segments = _parse_markdown_bold(text)
    # Reference rPr depuis ref_run (formatting hérité) — sans le b
    base_rPr = None
    if ref_run is not None and ref_run._r is not None:
        rPr_orig = ref_run._r.find(f'{A_NS}rPr')
        if rPr_orig is not None:
            base_rPr = copy.deepcopy(rPr_orig)
            base_rPr.attrib.pop('b', None)
    for seg_text, seg_bold in segments:
        if not seg_text:
            continue
        r = etree.SubElement(p_element, f'{A_NS}r')
        if base_rPr is not None:
            seg_rPr = copy.deepcopy(base_rPr)
            if seg_bold:
                seg_rPr.set('b', '1')
            r.insert(0, seg_rPr)
        elif seg_bold:
            seg_rPr = etree.SubElement(r, f'{A_NS}rPr')
            seg_rPr.set('b', '1')
        t = etree.SubElement(r, f'{A_NS}t')
        t.text = seg_text
        if seg_text and (seg_text[0] == ' ' or seg_text[-1] == ' '):
            t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')

# -------------------------------------------------------------
# IMAGE REPLACEMENT
# -------------------------------------------------------------

def replace_shape_with_image(slide, shape, image_path, override_bounds=None, maintain_aspect_ratio=False):
    if not os.path.exists(image_path):
        print(f"WARNING: Image not found: {image_path}", file=sys.stderr)
        return
    if override_bounds:
        left, top, width, height = override_bounds
    else:
        left = shape.left
        top = shape.top
        width = shape.width
        height = shape.height
    sp_element = shape._element
    sp_element.getparent().remove(sp_element)
    if maintain_aspect_ratio:
        try:
            from PIL import Image
            img = Image.open(image_path)
            img_width, img_height = img.size
            aspect_ratio = img_width / img_height if img_height > 0 else 1.0
            target_width = width
            target_height = int(target_width / aspect_ratio)
            if target_height > height:
                target_height = height
                target_width = int(target_height * aspect_ratio)
            width = target_width
            height = target_height
        except Exception as e:
            print(f"WARNING: Could not load image for aspect ratio: {e}", file=sys.stderr)
    slide.shapes.add_picture(image_path, left, top, width, height)

def replace_shape_with_multiple_images(slide, shape, image_paths, maintain_aspect_ratio=True):
    """v74.13 — par défaut maintain_aspect_ratio=True pour eviter la distorsion
    des charts (radar, barres, jauge) inseres cote-a-cote. Calcule pour chaque
    image la taille qui rentre dans la cellule (img_width × height) en preservant
    le ratio source, puis centre verticalement dans la cellule disponible."""
    valid_paths = [p for p in image_paths if p and os.path.exists(p)]
    if not valid_paths:
        print("WARNING: No valid images for multi-image replacement", file=sys.stderr)
        return
    left = shape.left
    top = shape.top
    total_width = shape.width
    height = shape.height
    n = len(valid_paths)
    gap = Emu(36000)
    img_width = (total_width - gap * (n - 1)) // n
    sp_element = shape._element
    sp_element.getparent().remove(sp_element)
    for i, img_path in enumerate(valid_paths):
        img_left = left + i * (img_width + gap)
        cell_w = img_width
        cell_h = height
        cell_top = top
        if maintain_aspect_ratio:
            try:
                from PIL import Image
                pil = Image.open(img_path)
                src_w, src_h = pil.size
                if src_h > 0 and src_w > 0:
                    ratio = src_w / src_h
                    target_w = cell_w
                    target_h = int(target_w / ratio)
                    if target_h > cell_h:
                        target_h = cell_h
                        target_w = int(target_h * ratio)
                    # Centrer verticalement dans la cellule disponible
                    cell_top = top + (cell_h - target_h) // 2
                    img_left = img_left + (cell_w - target_w) // 2
                    cell_w = target_w
                    cell_h = target_h
            except Exception as e:
                print(f"WARNING: Could not preserve aspect ratio for {img_path}: {e}", file=sys.stderr)
        slide.shapes.add_picture(img_path, img_left, cell_top, cell_w, cell_h)

# -------------------------------------------------------------
# SLIDE 15 -- COMPARATIVE TABLE (FULL SLIDE)
# -------------------------------------------------------------

SLIDE_15_GRID_SHAPES = {
    'Google Shape;141;p27', 'Google Shape;145;p27',
    'Google Shape;146;p27', 'Google Shape;147;p27',
    'Google Shape;150;p27', 'Google Shape;151;p27',
    'Google Shape;152;p27', 'Google Shape;153;p27',
}

def _handle_slide_15(slide, chart_paths):
    chart_path = chart_paths.get('tableau_comparative_charts')
    if not chart_path or not os.path.exists(chart_path):
        print("WARNING: No comparatif chart for slide 15", file=sys.stderr)
        return
    shapes_to_remove = []
    for shape in slide.shapes:
        name = shape.name if hasattr(shape, 'name') else ''
        placeholder = get_shape_placeholder(shape)
        if placeholder == '{{tableau comparative_charts}}' or name in SLIDE_15_GRID_SHAPES:
            shapes_to_remove.append(shape)
    for shape in shapes_to_remove:
        sp_element = shape._element
        sp_element.getparent().remove(sp_element)
    # Full width with small margins
    left = Emu(200000)
    top = Emu(391320)
    width = Emu(8700000)
    height = Emu(4400000)
    slide.shapes.add_picture(chart_path, left, top, width, height)

# -------------------------------------------------------------
# RISK CHART FALLBACK (SLIDES 8, 11, 14)
# -------------------------------------------------------------

def find_large_shape_for_charts(slide):
    """Find large empty shape on risk chart slides."""
    min_width = Emu(914400 * 8)
    min_height = Emu(914400 * 2)    # Relaxed from 2.5 to 2 inches
    max_top = Emu(914400 * 2)       # Relaxed from 1.5 to 2 inches

    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        text_content = shape.text_frame.text.strip()
        if len(text_content) > 50:
            continue
        if shape.width >= min_width and shape.height >= min_height and shape.top <= max_top:
            return shape
    return None

def _insert_risk_charts_fallback(slide, slide_num, chart_paths):
    """Fallback: find large shape and insert 3 risk charts side-by-side."""
    scenario_map = {8: 'scenario_A', 11: 'scenario_B', 14: 'scenario_C'}
    scenario = scenario_map.get(slide_num)
    if not scenario:
        return False
    chart_keys = [f'{scenario}_risk_radar', f'{scenario}_risk_gauge', f'{scenario}_risk_bars']
    chart_image_paths = [chart_paths.get(k) for k in chart_keys]
    chart_image_paths = [p for p in chart_image_paths if p and os.path.exists(p)]
    if not chart_image_paths:
        print(f"WARNING: No risk charts for slide {slide_num}", file=sys.stderr)
        return False
    target_shape = find_large_shape_for_charts(slide)
    if not target_shape:
        print(f"WARNING: No suitable shape found for risk charts on slide {slide_num}", file=sys.stderr)
        return False
    print(f"Found target shape for risk charts on slide {slide_num}: {target_shape.name}", file=sys.stderr)
    if len(chart_image_paths) == 1:
        # v74.13 : preserve aspect ratio sur charts (homothecie OK)
        replace_shape_with_image(slide, target_shape, chart_image_paths[0], maintain_aspect_ratio=True)
    else:
        replace_shape_with_multiple_images(slide, target_shape, chart_image_paths, maintain_aspect_ratio=True)
    return True

# -------------------------------------------------------------
# PHASAGE TEXT CLEANUP (SLIDE 18)
# -------------------------------------------------------------

def _clean_phasage_text(text):
    """
    Remove raw phasage data from text.
    Phasage info is displayed as a timeline chart on slide 19 instead.
    """
    if not text:
        return ''
    text_upper = text.upper()
    if 'PHASAGE' in text_upper or 'MONOPHASEE' in text_upper or 'TRIPHASEE' in text_upper or 'BIPHASEE' in text_upper or 'MONOPHASÉE' in text_upper:
        return ''
    return text

# -------------------------------------------------------------
# APPLY TEXT + FONT TO A SHAPE (DRY helper)
# -------------------------------------------------------------

def _apply_text_to_shape(shape, placeholder, text, slide_num):
    """v74.14 — calibration auto-shrink :
    - Slides 8/11/14/16 (textes refondus courts) : 95% min, presque pas de shrink → on garde les 12pt
    - Slides 5/6/9/12 : 85% min (un peu plus serre)
    - Slides 17/18 (3-col tres dense) : 80% min
    - Autres : 90% min standard
    """
    replace_text_in_shape(shape, placeholder, text)
    font_size = get_font_size_for_slide(slide_num)
    if font_size is not None:
        set_font_size_for_shape(shape, font_size)
    if slide_num in [8, 11, 14, 16]:
        enable_auto_shrink(shape, fontScale=95000)  # 95% min — quasi pas de shrink, garantit la 12pt
    elif slide_num in [17, 18]:
        enable_auto_shrink(shape, fontScale=80000)  # 80% — 3-col dense
    elif slide_num in [5, 6, 9, 12]:
        enable_auto_shrink(shape, fontScale=85000)  # 85% — scenario sommaires
    else:
        enable_auto_shrink(shape, fontScale=90000)  # 90% standard (vs 80% avant)

# -------------------------------------------------------------
# MAIN ASSEMBLY
# -------------------------------------------------------------

# ═══════════════════════════════════════════════════════════════════════════════
# v75.2 — PLAN D'IMPLANTATION (nouvelle slide par scénario, s'AJOUTE à la vue axo)
# ═══════════════════════════════════════════════════════════════════════════════

# Rayon Terre pour projection GPS -> mètres locaux (identique au frontend cockpit)
_R_EARTH = 6378137.0

# Miroir des heuristiques du cockpit (studio.html PLACEMENT_HEURISTICS)
_PLACEMENT_HEURISTICS = {
    'A': {'COMMERCE': ['N', 'NE', 'NW'], 'BUREAU': ['E', 'W', 'NE', 'NW'], 'ATELIER': ['E', 'W'], 'RESI': ['S', 'SE', 'SW', 'E', 'W']},
    'B': {'COMMERCE': ['N', 'NE'],       'BUREAU': ['NE', 'NW'],           'ATELIER': ['E', 'W'], 'RESI': ['S', 'SE', 'SW', 'E', 'W', 'NW']},
    'C': {'COMMERCE': ['N'],             'BUREAU': ['NE'],                 'ATELIER': ['E'],     'RESI': ['S', 'SW']},
}

# Aspect ratio (largeur/hauteur) par catégorie — identique au SVG cockpit
_UNIT_ASPECT = {'COMMERCE': 2.0, 'BUREAU': 1.5, 'ATELIER': 1.5, 'RESI': 1.2}

# Couleurs par catégorie (cohérence visuelle avec studio)
_UNIT_COLOR = {
    'COMMERCE': '#F59E0B',
    'BUREAU':   '#0EA5E9',
    'ATELIER':  '#8B5CF6',
    'RESI':     '#22C55E',
}

# 8 secteurs cardinaux : (angle_from_north_deg, sens horaire) au centre du secteur
_SECTOR_CENTER_DEG = {
    'N':  0.0,   'NE': 45.0,  'E':  90.0, 'SE': 135.0,
    'S':  180.0, 'SW': 225.0, 'W':  270.0, 'NW': 315.0,
}

# Titres de scénarios pour la slide plan
_SCENARIO_TITLES = {
    'A': "Scénario A — Plan d'implantation vu du ciel",
    'B': "Scénario B — Plan d'implantation vu du ciel",
    'C': "Scénario C — Plan d'implantation vu du ciel",
}


def _plan_categorize_unit_type(t):
    """Miroir de categorizeUnitType() du studio."""
    t = str(t or '').upper().strip()
    if t == 'COMMERCE': return 'COMMERCE'
    if t == 'BUREAU':   return 'BUREAU'
    if t == 'ATELIER':  return 'ATELIER'
    return 'RESI'  # T1..T5, AUTRE → logement


def _plan_project_polygon_to_xy(polygon_latlon):
    """
    Projette une liste de [lat, lon] en (x, y) mètres locaux (centré sur centroïde du polygone).
    Le Nord géographique correspond à y croissant. Utilisé pour dessiner le plan orienté Nord.
    """
    if not polygon_latlon:
        return []
    # centroïde grossier (moyenne des sommets)
    lat0 = sum(p[0] for p in polygon_latlon) / len(polygon_latlon)
    lon0 = sum(p[1] for p in polygon_latlon) / len(polygon_latlon)
    lat0_rad = math.radians(lat0)
    xy = []
    for lat, lon in polygon_latlon:
        x = math.radians(lon - lon0) * _R_EARTH * math.cos(lat0_rad)
        y = math.radians(lat - lat0) * _R_EARTH
        xy.append((x, y))
    return xy


def _plan_polygon_area_m2(xy):
    """Shoelace pour l'aire du polygone en mètres carrés."""
    if len(xy) < 3:
        return 0.0
    a = 0.0
    n = len(xy)
    for i in range(n):
        x1, y1 = xy[i]
        x2, y2 = xy[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def _plan_polygon_centroid(xy):
    """Centroïde géométrique (barycentre) du polygone."""
    if not xy:
        return (0.0, 0.0)
    cx = sum(p[0] for p in xy) / len(xy)
    cy = sum(p[1] for p in xy) / len(xy)
    return (cx, cy)


def _plan_sector_direction_vector(sector):
    """
    Retourne (dx, dy) unitaire depuis le centroïde vers le secteur donné.
    Nord = (0, 1). Sens horaire pour NE, E, SE, S, SW, W, NW.
    """
    ang_deg = _SECTOR_CENTER_DEG.get(sector, 0.0)
    ang_rad = math.radians(ang_deg)
    # 0° = Nord (y+), sens horaire = x augmente vers l'Est
    dx = math.sin(ang_rad)
    dy = math.cos(ang_rad)
    return (dx, dy)


def _plan_assign_preplacement(scenario_label, units):
    """
    Attribue un placement_sector aux unités qui n'en ont pas encore.
    Miroir de assignPreplacementForScenario() du studio.
    """
    rules = _PLACEMENT_HEURISTICS.get(scenario_label, _PLACEMENT_HEURISTICS['B'])
    counters = {'COMMERCE': 0, 'BUREAU': 0, 'ATELIER': 0, 'RESI': 0}
    out = []
    for u in units:
        u2 = dict(u)
        cat = _plan_categorize_unit_type(u2.get('type', ''))
        if not u2.get('sector'):
            sectors = rules.get(cat) or rules.get('RESI') or ['S']
            u2['sector'] = sectors[counters[cat] % len(sectors)]
        counters[cat] += 1
        out.append(u2)
    return out


def _plan_generate_image(scenario_label, polygon_latlon, units, site_area_m2, output_path):
    """
    Génère une image PNG du plan d'implantation vue du ciel.
    - polygon_latlon : [[lat, lon], ...] du polygone parcelle
    - units : liste de {type, name, size_m2, sector, notes}
    - site_area_m2 : superficie site (m²) pour l'échelle (fallback si polygone absent)
    - output_path : chemin fichier PNG à écrire
    Retourne output_path si succès, None sinon.
    """
    xy = _plan_project_polygon_to_xy(polygon_latlon)
    if len(xy) < 3:
        print(f"[PLAN {scenario_label}] Polygone parcelle absent ou insuffisant ({len(xy)} pts) — slide plan skipped", file=sys.stderr)
        return None

    poly_area = _plan_polygon_area_m2(xy)
    if poly_area <= 0:
        print(f"[PLAN {scenario_label}] Aire polygone nulle — slide plan skipped", file=sys.stderr)
        return None

    # Attribue placement par défaut aux unités sans sector
    units = _plan_assign_preplacement(scenario_label, units or [])

    cx, cy = _plan_polygon_centroid(xy)

    # Bounding box du polygone pour cadrer la figure
    xs = [p[0] for p in xy]
    ys = [p[1] for p in xy]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    dx_span = max(xmax - xmin, 1.0)
    dy_span = max(ymax - ymin, 1.0)
    max_span = max(dx_span, dy_span)
    # Marge 25% autour pour légende, compass, secteurs
    margin = max_span * 0.35
    xlim = (xmin - margin, xmax + margin)
    ylim = (ymin - margin * 0.6, ymax + margin * 0.6)

    # Rayon effectif du polygone pour placer les rectangles (distance moyenne centroïde -> sommets)
    r_poly = sum(math.hypot(p[0] - cx, p[1] - cy) for p in xy) / len(xy)

    fig, ax = plt.subplots(figsize=(10, 6.2), dpi=140)
    fig.patch.set_facecolor('#0B0F19')  # fond dark cohérent avec studio
    ax.set_facecolor('#0B0F19')

    # --- Secteurs cardinaux en fond léger (8 triangles depuis le centroïde) ---
    sector_r = max_span * 0.75
    for sec, ang_center in _SECTOR_CENTER_DEG.items():
        a_start = math.radians(ang_center - 22.5)
        a_end = math.radians(ang_center + 22.5)
        n_arc = 12
        arc_x = [cx]
        arc_y = [cy]
        for i in range(n_arc + 1):
            a = a_start + (a_end - a_start) * i / n_arc
            arc_x.append(cx + math.sin(a) * sector_r)
            arc_y.append(cy + math.cos(a) * sector_r)
        ax.fill(arc_x, arc_y, color='#1E293B', alpha=0.35, edgecolor='#334155', linewidth=0.5, linestyle=':')
        # Label du secteur (à 90% du rayon secteur)
        lx = cx + math.sin(math.radians(ang_center)) * sector_r * 0.92
        ly = cy + math.cos(math.radians(ang_center)) * sector_r * 0.92
        ax.text(lx, ly, sec, color='#F59E0B', fontsize=11, fontweight='bold',
                ha='center', va='center', alpha=0.85)

    # --- Polygone parcelle ---
    poly_patch = MplPolygon(xy, closed=True, facecolor='#78350F', edgecolor='#FBBF24',
                            linewidth=2.2, alpha=0.55, zorder=3)
    ax.add_patch(poly_patch)

    # Centroïde
    ax.plot([cx], [cy], marker='o', color='#FBBF24', markersize=5, zorder=6)

    # --- Unités : v75.11.1 utilise VRAIES dimensions/rotation/polygone si dispos, sinon fallback heuristique
    counters_by_sector = {}
    for u in units:
        area_m2 = max(4.0, float(u.get('size_m2') or 20.0))
        cat = _plan_categorize_unit_type(u.get('type', ''))
        color = _UNIT_COLOR.get(cat, '#22C55E')

        # v75.11.1 : utilise polygone custom s'il existe (formes L/T/U/circle etc.)
        custom_polygon = u.get('polygon')
        if custom_polygon and isinstance(custom_polygon, list) and len(custom_polygon) >= 3:
            # Points polygone en mètres relatifs au centroïde unit
            offset_x = float(u.get('offset_x_m') or 0)
            offset_y = float(u.get('offset_y_m') or 0)
            rot_deg = float(u.get('rotation_deg') or 0)
            rot_rad = math.radians(rot_deg)
            cos_r, sin_r = math.cos(rot_rad), math.sin(rot_rad)
            # v11.8-P0.1 — bug fix cross-language JS↔Python schéma polygone.
            # Le frontend v9.0+ (2020+) écrit `{x, y}` (studio.html:1949).
            # Le frontend legacy pre-v9 écrit `{x_m, y_m}` (shapeCircle/L/T/U/...).
            # Ce Python lisait UNIQUEMENT `x_m`/`y_m` → tous les polygones édités en Revit-mode
            # (drag vertex, offset, trim, corner, ...) arrivaient effondrés sur (0,0) → polygone dégénéré
            # → dessin invisible ou fallback rectangle heuristique dans le PPTX client.
            # Bug silencieux depuis 6+ mois. Fix : accepte les 2 schémas.
            poly_pts = []
            for pt in custom_polygon:
                xm = pt.get('x_m')
                if xm is None: xm = pt.get('x')
                ym = pt.get('y_m')
                if ym is None: ym = pt.get('y')
                lx = float(xm if xm is not None else 0)
                ly = float(ym if ym is not None else 0)
                px = cx + offset_x + lx * cos_r - ly * sin_r
                py = cy + offset_y + lx * sin_r + ly * cos_r
                poly_pts.append((px, py))
            up = MplPolygon(poly_pts, closed=True, facecolor=color, edgecolor='#F8FAFC',
                            linewidth=1.4, alpha=0.85, zorder=5)
            ax.add_patch(up)
            # Label au centroïde du polygone custom
            cxu = sum(p[0] for p in poly_pts) / len(poly_pts)
            cyu = sum(p[1] for p in poly_pts) / len(poly_pts)
            label_txt = str(u.get('name') or cat.title()).strip()[:14]
            ax.text(cxu, cyu, label_txt, color='#F8FAFC', fontsize=8, fontweight='bold',
                    ha='center', va='center', zorder=7)
            # Détails techniques dans le label (pilotis, sous-sols)
            details = []
            if u.get('pilotis'): details.append('pilotis')
            if u.get('sous_sols'):
                ss = int(u.get('sous_sols'))
                if ss > 0: details.append(f"-{ss}ss")
            if u.get('terrasse'): details.append('T')
            if u.get('balcon'): details.append('B')
            detail_str = ' · '.join(details) if details else ''
            ax.text(cxu, cyu - 2, f"{int(round(area_m2))}m² {detail_str}",
                    color='#FBBF24', fontsize=6.5, ha='center', va='center', zorder=7)
            continue

        # v75.11.1 : sinon utilise width_m/height_m custom si dispos, sinon fallback aspect ratio
        if u.get('width_m') and u.get('height_m'):
            w = float(u['width_m'])
            h = float(u['height_m'])
        else:
            aspect = _UNIT_ASPECT.get(cat, 1.2)
            w = math.sqrt(area_m2 * aspect)
            h = w / aspect
        sector = u.get('sector') or 'S'
        counters_by_sector[sector] = counters_by_sector.get(sector, 0) + 1
        n_in_sector = counters_by_sector[sector]

        # v75.11.1 : si offset_x_m/y_m défini (drag user), utilise-le, sinon calcul secteur
        if u.get('offset_x_m') is not None and u.get('offset_y_m') is not None:
            rx = cx + float(u['offset_x_m'])
            ry = cy + float(u['offset_y_m'])
        else:
            dx, dy = _plan_sector_direction_vector(sector)
            dist = r_poly * (0.45 + 0.12 * (n_in_sector - 1))
            dist = min(dist, r_poly * 0.90 - max(w, h) * 0.5)
            dist = max(dist, r_poly * 0.15)
            rx = cx + dx * dist
            ry = cy + dy * dist

        # v75.11.1 : rotation depuis u.rotation_deg si défini (drag user), sinon fallback secteur
        if u.get('rotation_deg') is not None:
            rot_deg = float(u['rotation_deg'])
        else:
            dxs, dys = _plan_sector_direction_vector(sector)
            angle_rad = math.atan2(dys, dxs)
            rot_deg = math.degrees(angle_rad) - 90.0

        # Rectangle centré sur (rx, ry) avec rotation autour de son centre
        transform = Affine2D().rotate_deg_around(rx, ry, rot_deg) + ax.transData
        rect = MplRectangle((rx - w/2, ry - h/2), w, h, facecolor=color, edgecolor='#F8FAFC',
                            linewidth=1.4, alpha=0.85, zorder=5)
        rect.set_transform(transform)
        ax.add_patch(rect)

        # Label unité (nom + détails techniques)
        label = str(u.get('name') or u.get('type') or '').strip() or cat.title()
        ax.text(rx, ry - 0.4, label, color='#F8FAFC', fontsize=8, fontweight='bold',
                ha='center', va='center', zorder=7)
        # v75.11.1 : label m² + détails (pilotis, sous-sols, terrasse, balcon)
        details = []
        if u.get('pilotis'): details.append('pilotis')
        if u.get('sous_sols'):
            try:
                ss = int(u.get('sous_sols') or 0)
                if ss > 0: details.append(f"-{ss}ss")
            except: pass
        if u.get('terrasse'): details.append('T')
        if u.get('balcon'): details.append('B')
        detail_str = ' · '.join(details) if details else ''
        ax.text(rx, ry + 1.0, f"{int(round(area_m2))}m² {detail_str}".strip(),
                color='#FBBF24', fontsize=7, ha='center', va='center', zorder=7)

    # --- Compass Nord en haut à droite ---
    cnx = xlim[1] - max_span * 0.10
    cny = ylim[1] - max_span * 0.12
    cnr = max_span * 0.07
    ax.add_patch(plt.Circle((cnx, cny), cnr, facecolor='#111827', edgecolor='#FBBF24', linewidth=1.2, zorder=8))
    arrow = FancyArrowPatch((cnx, cny - cnr * 0.5), (cnx, cny + cnr * 0.7),
                            arrowstyle='->', color='#EF4444', mutation_scale=14, linewidth=2, zorder=9)
    ax.add_patch(arrow)
    ax.text(cnx, cny + cnr * 0.95, 'N', color='#FBBF24', fontsize=11, fontweight='bold',
            ha='center', va='bottom', zorder=9)

    # --- Titre + légende types ---
    ax.set_title(_SCENARIO_TITLES.get(scenario_label, f"Scénario {scenario_label}"),
                 color='#FBBF24', fontsize=14, fontweight='bold', pad=12)

    # Légende types présents
    present_cats = []
    for u in units:
        c = _plan_categorize_unit_type(u.get('type', ''))
        if c not in present_cats:
            present_cats.append(c)
    if present_cats:
        legend_x = xlim[0] + max_span * 0.05
        legend_y = ylim[0] + max_span * 0.10
        for i, c in enumerate(present_cats):
            yy = legend_y + i * max_span * 0.045
            ax.add_patch(MplRectangle((legend_x, yy), max_span * 0.03, max_span * 0.02,
                                       facecolor=_UNIT_COLOR[c], edgecolor='#F8FAFC', linewidth=0.8, zorder=8))
            ax.text(legend_x + max_span * 0.04, yy + max_span * 0.01, c.title(),
                    color='#F8FAFC', fontsize=8, ha='left', va='center', zorder=8)

    # Info parcelle (superficie affichée en bas)
    ax.text(xlim[0] + max_span * 0.05, ylim[0] + max_span * 0.02,
            f"Superficie parcelle : {int(round(poly_area))} m²", color='#94A3B8',
            fontsize=8, ha='left', va='bottom', zorder=8)

    ax.set_xlim(xlim)
    ax.set_ylim(ylim)
    ax.set_aspect('equal')
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)

    plt.tight_layout()
    fig.savefig(output_path, facecolor=fig.get_facecolor(), bbox_inches='tight', dpi=140)
    plt.close(fig)
    return output_path


def _plan_find_scenario_slide_indices(prs):
    """
    Parcourt les slides ET repère celles contenant un placeholder scenario_X_massing
    OU (si placeholders déjà remplacés) qui portent un texte titre "Scénario X".
    Retourne {'A': idx or None, 'B': idx or None, 'C': idx or None} (0-based).
    """
    found = {'A': None, 'B': None, 'C': None}
    # Passe 1 — recherche placeholder brut (si assemble_pptx n'a pas encore tourné, non applicable ici)
    for idx, slide in enumerate(prs.slides):
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            txt = shape.text_frame.text or ''
            if '{{scenario_A_massing}}' in txt and found['A'] is None: found['A'] = idx
            if '{{scenario_B_massing}}' in txt and found['B'] is None: found['B'] = idx
            if '{{scenario_C_massing}}' in txt and found['C'] is None: found['C'] = idx
    # Passe 2 — fallback : titre "Scénario X" dans le texte
    if any(v is None for v in found.values()):
        for idx, slide in enumerate(prs.slides):
            full = ''
            for shape in slide.shapes:
                if shape.has_text_frame:
                    full += ' ' + (shape.text_frame.text or '')
            up = full.upper()
            if found['A'] is None and ('SCÉNARIO A' in up or 'SCENARIO A' in up): found['A'] = idx
            if found['B'] is None and ('SCÉNARIO B' in up or 'SCENARIO B' in up): found['B'] = idx
            if found['C'] is None and ('SCÉNARIO C' in up or 'SCENARIO C' in up): found['C'] = idx
    return found


def _plan_insert_slide_after(prs, target_slide_idx, image_path, title_text):
    """
    Ajoute une nouvelle slide (layout blank) contenant :
    - titre "Scénario X — Plan d'implantation vu du ciel"
    - image PNG plan (généré par _plan_generate_image) sur toute la surface utile
    Puis déplace cette slide en position (target_slide_idx + 1) via manipulation XML _sldIdLst.
    Retourne l'index final de la slide insérée.
    """
    # Slide layout "blank" — dernier layout du template en général, ou premier si non trouvé
    blank_layout = None
    for lay in prs.slide_layouts:
        # heuristique : layout dont le nom contient "blank" ou "blanc"
        name = (getattr(lay, 'name', '') or '').lower()
        if 'blank' in name or 'blanc' in name or 'vide' in name:
            blank_layout = lay
            break
    if blank_layout is None:
        # Fallback : dernier layout dispo (souvent = blank)
        try:
            blank_layout = prs.slide_layouts[-1]
        except Exception:
            blank_layout = prs.slide_layouts[0]

    slide = prs.slides.add_slide(blank_layout)

    # Nettoyer les placeholders du layout si présents (on veut une slide propre)
    for shape in list(slide.shapes):
        try:
            if shape.is_placeholder:
                sp = shape._element
                sp.getparent().remove(sp)
        except Exception:
            pass

    # Fond dark plein slide (rectangle)
    slide_w = prs.slide_width
    slide_h = prs.slide_height
    bg = slide.shapes.add_shape(1, 0, 0, slide_w, slide_h)  # 1 = MSO_SHAPE.RECTANGLE
    bg.fill.solid()
    bg.fill.fore_color.rgb = RGBColor(0x0B, 0x0F, 0x19)
    bg.line.fill.background()

    # Titre (bandeau haut)
    title_h = Emu(457200)  # 0.5"
    title_box = slide.shapes.add_textbox(Emu(228600), Emu(228600), slide_w - Emu(457200), title_h)
    tf = title_box.text_frame
    tf.word_wrap = True
    tf.text = title_text
    for para in tf.paragraphs:
        para.alignment = PP_ALIGN.LEFT
        for run in para.runs:
            run.font.size = Pt(20)
            run.font.bold = True
            run.font.color.rgb = RGBColor(0xFB, 0xBF, 0x24)

    # Image plan (occupe la surface principale, sous le titre, avec marge)
    img_left = Emu(228600)
    img_top = Emu(228600) + title_h + Emu(114300)
    img_width = slide_w - Emu(457200)
    img_height = slide_h - img_top - Emu(228600)
    slide.shapes.add_picture(image_path, img_left, img_top, img_width, img_height)

    # Réordonner via XML : la slide ajoutée est en dernier, on la déplace après target_slide_idx
    xml_slides = prs.slides._sldIdLst
    slide_ids = list(xml_slides)
    last = slide_ids[-1]
    xml_slides.remove(last)
    xml_slides.insert(target_slide_idx + 1, last)
    return target_slide_idx + 1


def _plan_maybe_insert_all(prs, data, chart_dir):
    """
    Point d'entrée v75.2 : lit data['units_by_scenario'] et data['parcel_polygon'],
    génère 3 images PNG et insère 3 slides plan APRÈS chaque slide massing existante.
    Best-effort : toute erreur est logguée mais ne casse pas le PPTX principal.
    """
    units_by_scenario = data.get('units_by_scenario') or {}
    polygon = data.get('parcel_polygon') or []
    site_area = float(data.get('site_area') or 0)

    total_units = sum(len(units_by_scenario.get(k) or []) for k in ('A', 'B', 'C'))
    if total_units == 0:
        print("[PLAN v75.2] Aucune unité en base sb_lead_units — slides plan non insérées.", file=sys.stderr)
        return
    if len(polygon) < 3:
        print(f"[PLAN v75.2] Polygone parcelle absent ou insuffisant ({len(polygon)} pts) — slides plan non insérées.", file=sys.stderr)
        return

    # Repérer les indices des slides massing existantes AVANT insertion
    indices = _plan_find_scenario_slide_indices(prs)
    print(f"[PLAN v75.2] Indices slides massing détectés : {indices}", file=sys.stderr)

    # Générer les 3 images d'abord (dans chart_dir pour partager le cleanup)
    plan_images = {}
    for label in ('A', 'B', 'C'):
        units = units_by_scenario.get(label) or []
        if not units:
            continue
        out_png = os.path.join(chart_dir, f'plan_scenario_{label}.png')
        try:
            path = _plan_generate_image(label, polygon, units, site_area, out_png)
            if path:
                plan_images[label] = path
        except Exception as e:
            print(f"[PLAN v75.2] Erreur génération image scénario {label} : {e}", file=sys.stderr)

    # Insérer en ordre INVERSE (C, B, A) pour ne pas décaler les indices amont
    inserted = 0
    for label in ('C', 'B', 'A'):
        target_idx = indices.get(label)
        img = plan_images.get(label)
        if target_idx is None or not img:
            continue
        try:
            new_idx = _plan_insert_slide_after(prs, target_idx, img, _SCENARIO_TITLES[label])
            print(f"[PLAN v75.2] Slide plan {label} insérée à index {new_idx} (après massing index {target_idx})", file=sys.stderr)
            inserted += 1
        except Exception as e:
            print(f"[PLAN v75.2] Erreur insertion slide plan {label} : {e}", file=sys.stderr)

    print(f"[PLAN v75.2] {inserted}/3 slides plan insérées.", file=sys.stderr)


def assemble_pptx(data, template_path, output_path):
    chart_dir = tempfile.mkdtemp(prefix='barlo_charts_')
    print(f"Generating charts in {chart_dir}...", file=sys.stderr)
    chart_paths = generate_all_charts(data, chart_dir)
    print(f"Charts generated: {list(chart_paths.keys())}", file=sys.stderr)

    img_dir = tempfile.mkdtemp(prefix='barlo_images_')
    images = data.get('images', {})
    downloaded_images = {}
    for key, url in images.items():
        if url:
            print(f"Downloading image: {key}...", file=sys.stderr)
            local_path = download_image(url, img_dir)
            if local_path:
                downloaded_images[key] = local_path

    prs = Presentation(template_path)
    texts = data.get('texts', {})
    # v11.8-P0.2 — bug fix `flat_data` undefined. Ce nom était référencé lignes 1239-1243 et
    # 1319-1323 sans jamais être défini → NameError → try/except silencieux → les 2 tables budget
    # A/B/C sur slides 17 et 18 étaient TOUJOURS absentes des PPTX client (warning stderr uniquement).
    # server.js:10340 fait `...flat` qui aplatit à la racine de `data` → `data` EST déjà le flat_data.
    flat_data = data
    client_name = data.get('client_name', '')

    # -- Prepare composite text keys --
    if 'slide_3_text' not in texts and 'slide_3_intro_text' in texts:
        parts = [texts.get('slide_3_intro_text', ''), texts.get('slide_3_programme_text', '')]
        texts['slide_3_text'] = '\n\n'.join(p for p in parts if p)

    for base_key in ['invisible_technical_text', 'invisible_financial_text', 'invisible_strategic_text']:
        s17_key = f'{base_key}_s17'
        s18_key = f'{base_key}_s18'
        if s17_key not in texts and base_key in texts:
            texts[s17_key] = texts[base_key]
        if s18_key not in texts:
            success_key = base_key.replace('invisible_', 'success_')
            if success_key in texts:
                texts[s18_key] = texts[success_key]
            elif base_key in texts:
                texts[s18_key] = texts[base_key]

    print(f"Text keys available: {sorted(texts.keys())}", file=sys.stderr)
    print(f"Chart paths available: {sorted(chart_paths.keys())}", file=sys.stderr)

    # -- Process each slide --
    for slide_idx, slide in enumerate(prs.slides):
        slide_num = slide_idx + 1

        # Slide 15 -- full-page comparative table
        if slide_num == 15:
            _handle_slide_15(slide, chart_paths)
            continue

        # Risk chart slides (8, 11, 14) -- special chart insertion + text
        if slide_num in RISK_CHART_SLIDES:
            shapes_to_process = list(slide.shapes)
            chart_inserted = False
            for shape in shapes_to_process:
                placeholder = get_shape_placeholder(shape)
                if placeholder and placeholder in CHART_PLACEHOLDERS:
                    chart_keys = CHART_PLACEHOLDERS[placeholder]
                    chart_image_paths = [chart_paths.get(k) for k in chart_keys]
                    chart_image_paths = [p for p in chart_image_paths if p]
                    if len(chart_image_paths) == 1:
                        # v74.13 : preserve aspect ratio sur charts
                        replace_shape_with_image(slide, shape, chart_image_paths[0], maintain_aspect_ratio=True)
                        chart_inserted = True
                    elif len(chart_image_paths) > 1:
                        replace_shape_with_multiple_images(slide, shape, chart_image_paths, maintain_aspect_ratio=True)
                        chart_inserted = True
                    break
            if not chart_inserted:
                print(f"No risk chart placeholder found on slide {slide_num}, using fallback...", file=sys.stderr)
                _insert_risk_charts_fallback(slide, slide_num, chart_paths)

            # Process text shapes on risk slides
            shapes_to_process = list(slide.shapes)
            for shape in shapes_to_process:
                placeholder = get_shape_placeholder(shape)
                if not placeholder or placeholder in CHART_PLACEHOLDERS:
                    continue
                if placeholder == '{{client_name}}':
                    _apply_text_to_shape(shape, placeholder, client_name, slide_num)
                    continue
                placeholder_key = placeholder.strip('{}').strip()
                slide_specific_key = (slide_num, placeholder)
                if slide_specific_key in SLIDE_SPECIFIC_TEXT:
                    text_key = SLIDE_SPECIFIC_TEXT[slide_specific_key]
                    text = texts.get(text_key, '')
                    if text:
                        _apply_text_to_shape(shape, placeholder, text, slide_num)
                    else:
                        clear_shape_text(shape)
                    continue
                text = texts.get(placeholder_key, '')
                if text:
                    _apply_text_to_shape(shape, placeholder, text, slide_num)
                else:
                    clean_key = placeholder_key.replace(' ', '_')
                    text = texts.get(clean_key, '')
                    if text:
                        _apply_text_to_shape(shape, placeholder, text, slide_num)

        else:
            # Standard shape processing for all non-risk, non-slide-15 slides
            shapes_to_process = list(slide.shapes)
            for shape in shapes_to_process:
                placeholder = get_shape_placeholder(shape)
                if not placeholder:
                    continue
                placeholder_key = placeholder.strip('{}').strip()

                # Client name
                if placeholder == '{{client_name}}':
                    replace_text_in_shape(shape, placeholder, client_name)
                    # Slide 1: keep template 16pt, no font override
                    # Other slides: apply slide-specific font
                    if slide_num != 1:
                        font_size = get_font_size_for_slide(slide_num)
                        if font_size is not None:
                            set_font_size_for_shape(shape, font_size)
                    enable_auto_shrink(shape, fontScale=80000)
                    continue

                # Images
                if placeholder in IMAGE_PLACEHOLDERS:
                    img_key = placeholder_key
                    img_path = downloaded_images.get(img_key)
                    if img_path:
                        # v73.2.1 : maintain_aspect_ratio=True pour TOUTES les images
                        # (axo brute slide 4, axo enhanced slide 5, massings A/B/C)
                        # Evite la deformation horizontale (homothetie respectee)
                        replace_shape_with_image(slide, shape, img_path, maintain_aspect_ratio=True)
                    else:
                        clear_shape_text(shape)
                    continue

                # Charts
                if placeholder in CHART_PLACEHOLDERS:
                    chart_keys = CHART_PLACEHOLDERS[placeholder]
                    chart_image_paths = [chart_paths.get(k) for k in chart_keys]
                    chart_image_paths = [p for p in chart_image_paths if p]
                    if len(chart_image_paths) == 1:
                        # v74.13 : preserve aspect ratio sur charts
                        replace_shape_with_image(slide, shape, chart_image_paths[0], maintain_aspect_ratio=True)
                    elif len(chart_image_paths) > 1:
                        replace_shape_with_multiple_images(slide, shape, chart_image_paths, maintain_aspect_ratio=True)
                    else:
                        clear_shape_text(shape)
                    continue

                # Slide-specific text (slides 17, 18)
                slide_specific_key = (slide_num, placeholder)
                if slide_specific_key in SLIDE_SPECIFIC_TEXT:
                    text_key = SLIDE_SPECIFIC_TEXT[slide_specific_key]
                    text = texts.get(text_key, '')
                    # v72.94: REMOVED phasage cleanup — _s18 texts are clean
                    # buildTemplateTexts already produces proper prose, not raw data
                    if text:
                        _apply_text_to_shape(shape, placeholder, text, slide_num)
                    else:
                        clear_shape_text(shape)
                    continue

                # Generic text
                text = texts.get(placeholder_key, '')
                if text:
                    _apply_text_to_shape(shape, placeholder, text, slide_num)
                else:
                    clean_key = placeholder_key.replace(' ', '_')
                    text = texts.get(clean_key, '')
                    if text:
                        _apply_text_to_shape(shape, placeholder, text, slide_num)
                    else:
                        print(f"WARNING: No text for placeholder {placeholder} on slide {slide_num}", file=sys.stderr)

    # ----------------------------------------------------------
    # INSERT EXTRA CHARTS (positioned within slide bounds)
    # Slide dimensions: 10.00" x 5.62" (9144000 x 5143500 EMU)
    # ----------------------------------------------------------

    slides_list = list(prs.slides)

    # ─── v74.19 SLIDE 17 — repositionner donut + resize colonnes texte ─────────
    # v25 a montre : donut a 3.3" superpose la 3e colonne texte qui descend
    # jusqu'au bas. Push 3 : RESIZE les 3 colonnes a top=0.8" h=2.7"
    # → libere 3.5"-5.5" pour le donut full-width centre.
    cost_chart = chart_paths.get('cost_breakdown')
    if len(slides_list) >= 17:
        slide17 = slides_list[16]
        # Etape 1 : trouver les 3 shapes texte des colonnes (top > 0.8" et grandes)
        col_shapes = []
        for shp in slide17.shapes:
            try:
                if not shp.has_text_frame:
                    continue
                if shp.top is None or shp.top < Emu(700000):
                    continue
                if shp.height < Emu(1500000):  # skip petits inserts (intro)
                    continue
                col_shapes.append((shp.top, shp))
            except Exception:
                continue
        # Resize chacune a h=2.5" pour liberer le bas
        for top_emu, shp in col_shapes:
            try:
                shp.top = Emu(914400)        # 1.0"
                shp.height = Emu(2286000)    # 2.5"
            except Exception:
                pass
        # Etape 2 : inserer le donut bottom-center, w=5.0" h=2.0"
        if cost_chart and os.path.exists(cost_chart):
            slide17.shapes.add_picture(cost_chart,
                Emu(2286000), Emu(3382200),  # left=2.5", top=3.7"
                Emu(4572000), Emu(1828800))  # 5.0" × 2.0"
            print(f"v74.19: Donut on slide 17 repositioned bottom-center", file=sys.stderr)

    # ─── v74.17 SLIDES 7/10/13 — DISCIPLINE LAYOUT ────────────────────────────
    # v25 a montre que le shape TEXTE prend toute la slide (~5.5" haut),
    # donc le texte affiche son contenu jusqu'a ~4.2" et SE CHEVAUCHE
    # avec mes charts a 3.0" et 4.1". Fix : RESIZE le shape texte
    # programmatiquement a 2.5" haut → 0.5"-3.0" → libere 3.0"-5.5" net.
    #
    # Plus : calc figsize=(11,3) ratio 3.67 inserer dans 9x1 ratio 9 → 2.4x
    # de stretch horizontal. v74.17 : ajuste figsize ET insertion pour
    # matcher 1:1 (zero distorsion).
    #
    # Layout cible final (zero overlap, zero distorsion) :
    #   - Title (template) : 0-0.5"
    #   - Texte (resize) : 0.5"-3.0" (h=2.5")
    #   - Calc visuel : 3.1"-4.4" (h=1.3", figsize 11×1.6 ratio 6.9 → insert 9.0×1.3 ratio 6.9 ✓)
    #   - Gauge budget : 4.5"-5.5" (h=1.0", figsize 11×1.4 ratio 7.9 → insert 9.0×1.0 ratio 9.0 close)
    FINANCIAL_SLIDE_MAP = {7: 'A', 10: 'B', 13: 'C'}
    for slide_num_fin, label_fin in FINANCIAL_SLIDE_MAP.items():
        if len(slides_list) < slide_num_fin:
            continue
        slide_fin = slides_list[slide_num_fin - 1]
        # ─── ETAPE 1 : Resize le shape texte principal (le plus grand non-titre) ──
        text_shapes = []
        for shp in slide_fin.shapes:
            try:
                if not shp.has_text_frame:
                    continue
                if shp.top is None or shp.top < Emu(700000):  # skip title (top<0.77")
                    continue
                text_shapes.append((shp.height, shp))
            except Exception:
                continue
        if text_shapes:
            text_shapes.sort(key=lambda t: t[0], reverse=True)
            main_text = text_shapes[0][1]
            try:
                main_text.height = Emu(2286000)  # 2.5"
                main_text.top = Emu(457200)      # 0.5"
                print(f"v74.17 slide {slide_num_fin}: text shape resized to top=0.5\" h=2.5\"", file=sys.stderr)
            except Exception as e:
                print(f"v74.17 slide {slide_num_fin}: failed to resize text shape: {e}", file=sys.stderr)
        # ─── ETAPE 2 : Inserer les 2 charts avec espace entre eux ──
        gauge = chart_paths.get(f'scenario_{label_fin}_budget_gauge')
        calc = chart_paths.get(f'scenario_{label_fin}_cost_calc')
        # Calc visuel : top=3.0", left=0.5", w=9.0", h=1.1"
        if calc and os.path.exists(calc):
            slide_fin.shapes.add_picture(calc,
                Emu(457200), Emu(2743200),  # left=0.5", top=3.0"
                Emu(8229600), Emu(1005840)) # 9.0" × 1.1"
        # Gauge budget : top=4.4", left=0.5", w=9.0", h=1.0" (gap 0.3" entre les deux)
        if gauge and os.path.exists(gauge):
            slide_fin.shapes.add_picture(gauge,
                Emu(457200), Emu(4023360),  # left=0.5", top=4.4"
                Emu(8229600), Emu(914400))  # 9.0" × 1.0"
        print(f"v74.18: Inserted financial charts on slide {slide_num_fin} ({label_fin})", file=sys.stderr)

    # Slide 17 -- Budget comparison table (bottom-left, next to pie chart)
    # v72.92: Repositioned to bottom-left to coexist with pie chart on right
    # Table: Scenario | SDP | Cout/m2 marche | Cout/m2 ajuste | Cout total | Label
    if len(slides_list) >= 17:
        slide17 = slides_list[16]
        try:
            # Extract data from flat_data
            table_rows = []
            for sc_key in ['A', 'B', 'C']:
                sdp_val = flat_data.get(f'{sc_key}_sdp', '0')
                cost_m2_marche = flat_data.get(f'{sc_key}_cost_m2_marche', '0k')
                cost_m2_ajuste = flat_data.get(f'{sc_key}_cost_m2_ajuste', '0k')
                cost_total = flat_data.get(f'{sc_key}_cost_total', '0M FCFA')
                budget_fit = flat_data.get(f'{sc_key}_budget_fit', '')
                # Translate budget_fit labels
                fit_label = {
                    'DANS_BUDGET': 'DANS BUDGET',
                    'BUDGET_TENDU': 'BUDGET TENDU',
                    'HORS_BUDGET': 'HORS BUDGET',
                }.get(budget_fit, budget_fit)
                table_rows.append([sc_key, f'{sdp_val}m\u00b2', cost_m2_marche, cost_m2_ajuste, cost_total, fit_label])

            # Position: bottom-left, left-aligned under text columns
            # left=0.3", top=3.7", width=5.8", height=1.3"
            tbl_left = Emu(274320)    # 0.3"
            tbl_top = Emu(3383280)    # 3.7"
            tbl_width = Emu(5303520)  # 5.8"
            tbl_height = Emu(1188720) # 1.3"

            rows, cols = 4, 6  # header + 3 data rows
            table_shape = slide17.shapes.add_table(rows, cols, tbl_left, tbl_top, tbl_width, tbl_height)
            tbl = table_shape.table

            # Column widths (proportional)
            col_widths_emu = [
                Emu(914400),   # Scenario (1.0")
                Emu(914400),   # SDP (1.0")
                Emu(1143000),  # Cout/m2 marche (1.25")
                Emu(1143000),  # Cout/m2 ajuste (1.25")
                Emu(1028700),  # Cout total (1.125")
                Emu(1257300),  # Label (1.375")
            ]
            for i, w in enumerate(col_widths_emu):
                tbl.columns[i].width = w

            # Header row
            headers = ['Scenario', 'SDP', 'Cout/m\u00b2\nmarche', 'Cout/m\u00b2\najuste', 'Cout\ntotal', 'Label']
            DARK_GREEN = RGBColor(0x2C, 0x5F, 0x2D)
            WHITE = RGBColor(0xFF, 0xFF, 0xFF)
            LIGHT_BG = RGBColor(0xF5, 0xF5, 0xF0)

            for ci, hdr in enumerate(headers):
                cell = tbl.cell(0, ci)
                cell.text = hdr
                for para in cell.text_frame.paragraphs:
                    para.alignment = PP_ALIGN.CENTER
                    for run in para.runs:
                        run.font.size = Pt(9)
                        run.font.bold = True
                        run.font.color.rgb = WHITE
                # Dark green header background
                cell.fill.solid()
                cell.fill.fore_color.rgb = DARK_GREEN

            # Data rows
            for ri, row_data in enumerate(table_rows):
                for ci, val in enumerate(row_data):
                    cell = tbl.cell(ri + 1, ci)
                    cell.text = val
                    for para in cell.text_frame.paragraphs:
                        para.alignment = PP_ALIGN.CENTER
                        for run in para.runs:
                            run.font.size = Pt(9)
                            run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
                    # Alternate row shading
                    if ri % 2 == 1:
                        cell.fill.solid()
                        cell.fill.fore_color.rgb = LIGHT_BG

            print("Inserted budget comparison table on slide 17", file=sys.stderr)
        except Exception as e:
            print(f"Warning: could not insert budget table on slide 17: {e}", file=sys.stderr)

    # Slide 18 -- Budget comparison table (same as slide 17, for risk/conclusion)
    if len(slides_list) >= 18:
        slide18 = slides_list[17]
        try:
            table_rows_18 = []
            for sc_key in ['A', 'B', 'C']:
                sdp_val = flat_data.get(f'{sc_key}_sdp', '0')
                cost_m2_marche = flat_data.get(f'{sc_key}_cost_m2_marche', '0k')
                cost_m2_ajuste = flat_data.get(f'{sc_key}_cost_m2_ajuste', '0k')
                cost_total = flat_data.get(f'{sc_key}_cost_total', '0M FCFA')
                budget_fit = flat_data.get(f'{sc_key}_budget_fit', '')
                fit_label = {
                    'DANS_BUDGET': 'DANS BUDGET',
                    'BUDGET_TENDU': 'BUDGET TENDU',
                    'HORS_BUDGET': 'HORS BUDGET',
                }.get(budget_fit, budget_fit)
                table_rows_18.append([sc_key, f'{sdp_val}m\u00b2', cost_m2_marche, cost_m2_ajuste, cost_total, fit_label])

            tbl_left_18 = Emu(1371600)
            tbl_top_18 = Emu(3703320)
            tbl_width_18 = Emu(6400800)
            tbl_height_18 = Emu(1371600)

            table_shape_18 = slide18.shapes.add_table(4, 6, tbl_left_18, tbl_top_18, tbl_width_18, tbl_height_18)
            tbl_18 = table_shape_18.table

            col_widths_18 = [Emu(914400), Emu(914400), Emu(1143000), Emu(1143000), Emu(1028700), Emu(1257300)]
            for i, w in enumerate(col_widths_18):
                tbl_18.columns[i].width = w

            headers_18 = ['Scenario', 'SDP', 'Cout/m\u00b2\nmarche', 'Cout/m\u00b2\najuste', 'Cout\ntotal', 'Label']
            DARK_GREEN_18 = RGBColor(0x2C, 0x5F, 0x2D)
            WHITE_18 = RGBColor(0xFF, 0xFF, 0xFF)
            LIGHT_BG_18 = RGBColor(0xF5, 0xF5, 0xF0)

            for ci, hdr in enumerate(headers_18):
                cell = tbl_18.cell(0, ci)
                cell.text = hdr
                for para in cell.text_frame.paragraphs:
                    para.alignment = PP_ALIGN.CENTER
                    for run in para.runs:
                        run.font.size = Pt(9)
                        run.font.bold = True
                        run.font.color.rgb = WHITE_18
                cell.fill.solid()
                cell.fill.fore_color.rgb = DARK_GREEN_18

            for ri, row_data in enumerate(table_rows_18):
                for ci, val in enumerate(row_data):
                    cell = tbl_18.cell(ri + 1, ci)
                    cell.text = val
                    for para in cell.text_frame.paragraphs:
                        para.alignment = PP_ALIGN.CENTER
                        for run in para.runs:
                            run.font.size = Pt(9)
                            run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
                    if ri % 2 == 1:
                        cell.fill.solid()
                        cell.fill.fore_color.rgb = LIGHT_BG_18

            print("Inserted budget comparison table on slide 18", file=sys.stderr)
        except Exception as e:
            print(f"Warning: could not insert budget table on slide 18: {e}", file=sys.stderr)

    # Slide 18 -- FALLBACK: Force-inject 3rd column (strategic/phasage) text
    # The template's 3rd column shape has static text instead of a {{invisible_strategic_text}} placeholder,
    # so the placeholder-based replacement never triggers. We find it by position (rightmost text column).
    if len(slides_list) >= 18:
        slide18_fb = slides_list[17]
        strategic_text_s18 = texts.get('invisible_strategic_text_s18', '')
        if strategic_text_s18:
            # Find the rightmost text shape that is NOT the header (header spans full width)
            text_columns = []
            for shape in slide18_fb.shapes:
                if shape.has_text_frame and shape.width < Emu(5000000):  # exclude full-width header
                    text_columns.append(shape)
            # Sort by left position
            text_columns.sort(key=lambda s: s.left)
            if len(text_columns) >= 3:
                third_col = text_columns[2]
                # Check if this shape was NOT already replaced by placeholder logic
                current_text = third_col.text_frame.text
                placeholder_match = re.search(r'\{\{[^}]+\}\}', current_text)
                if not placeholder_match:
                    # Apply the strategic text
                    _clean_text = _clean_phasage_text(strategic_text_s18)
                    _apply_text_to_shape(third_col, '{{invisible_strategic_text}}', _clean_text, 18)
                    print("Slide 18: FALLBACK injected strategic text into 3rd column", file=sys.stderr)
            else:
                print(f"Slide 18: only {len(text_columns)} text columns found (need 3)", file=sys.stderr)
        else:
            print("Slide 18: no invisible_strategic_text_s18 in texts", file=sys.stderr)

    # Slide 19 -- Timeline Gantt chart (below text, full width)
    timeline_chart = chart_paths.get('timeline')
    if timeline_chart and os.path.exists(timeline_chart) and len(slides_list) >= 19:
        slide19 = slides_list[18]
        # left=0.2", top=3.8", width=9.5", height=1.6" → bottom=5.4"
        slide19.shapes.add_picture(timeline_chart,
            Emu(182880), Emu(3474720), Emu(8686800), Emu(1463040))
        print("Inserted timeline chart on slide 19", file=sys.stderr)

    # Slide 20 -- Recap card (below text)
    recap_chart = chart_paths.get('recap_card')
    if recap_chart and os.path.exists(recap_chart) and len(slides_list) >= 20:
        slide20 = slides_list[19]
        # left=0.2", top=4.0", width=9.5", height=1.3" → bottom=5.3"
        slide20.shapes.add_picture(recap_chart,
            Emu(182880), Emu(3657600), Emu(8686800), Emu(1188720))
        print("Inserted recap card on slide 20", file=sys.stderr)

    # -- Final auto-shrink pass for any text-heavy shapes not yet handled --
    # Uses fontScale=80000 (80% minimum) to prevent over-shrinking
    shrink_count = 0
    for slide in prs.slides:
        for shape in slide.shapes:
            if shape.has_text_frame:
                text_content = shape.text_frame.text.strip()
                if len(text_content) > 150:
                    enable_auto_shrink(shape, fontScale=80000)
                    shrink_count += 1
    print(f"Auto-shrink applied to {shrink_count} text shapes (fontScale=80000)", file=sys.stderr)

    # v75.2 — Insertion des slides "Plan d'implantation" APRÈS chaque slide massing
    # Best-effort : n'échoue jamais le PPTX principal, log-only en cas d'erreur.
    try:
        _plan_maybe_insert_all(prs, data, chart_dir)
    except Exception as e:
        print(f"[PLAN v75.2] Insertion globale échouée : {e}", file=sys.stderr)

    prs.save(output_path)
    print(f"PPTX saved to {output_path}", file=sys.stderr)
    shutil.rmtree(chart_dir, ignore_errors=True)
    shutil.rmtree(img_dir, ignore_errors=True)
    return output_path

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python generate_pptx.py <input.json> <template.pptx> <output.pptx>")
        sys.exit(1)
    input_json = sys.argv[1]
    template_pptx = sys.argv[2]
    output_pptx = sys.argv[3]
    with open(input_json, 'r', encoding='utf-8') as f:
        data = json.load(f)
    assemble_pptx(data, template_pptx, output_pptx)
    print(json.dumps({"status": "ok", "output": output_pptx}))
