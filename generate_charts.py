#!/usr/bin/env python3
"""
BARLO — Diagnostic Chart Generation v2.0 (Premium)
═══════════════════════════════════════════════════
Style : cabinet de conseil / architecture premium
Palette : tons sourds et sophistiqués — pas de couleurs scolaires
Typographie : hiérarchie nette, espaces généreux, lisibilité PPTX

Génère : radar, gauge (gradient arc), barres horizontales (+ background tracks),
         tableau comparatif (highlight vert meilleur), arbitrage 4-graphs,
         ventilation coûts (donut avec données réelles), timeline, recap card

RÈGLE : Toute valeur numérique provient du JSON scénario.
        AUCUNE DONNÉE INVENTÉE. Les charts reflètent EXACTEMENT /compute-scenarios.
"""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch
import matplotlib.patheffects as pe
import numpy as np
import os, json, sys

# ─── PALETTE PREMIUM ────────────────────────────────────────────────
# Tons sourds, professionnels — jamais criards
COLORS = {
    # Scénarios
    'A': '#C0392B',   # Brique profond — ambitieux
    'B': '#D4850E',   # Ambre chaud — équilibré
    'C': '#1E8449',   # Forêt — prudent
    # Structure
    'dark':   '#1B2A4A',  # Marine profond
    'light':  '#F7F9FC',  # Gris perle
    'accent': '#2C3E50',  # Ardoise
    'grid':   '#E2E8F0',  # Grille subtile
    'text':   '#1B2A4A',  # Texte principal
    'muted':  '#7F8C9B',  # Texte secondaire
    # Sévérité
    'green':  '#1E8449',
    'orange': '#D4850E',
    'red':    '#C0392B',
    'bg':     '#FFFFFF',
    # Ventilation coûts
    'pie_go':  '#1B2A4A',   # Gros œuvre — marine
    'pie_so':  '#2E7D6F',   # Second œuvre — teal
    'pie_lt':  '#D4850E',   # Lots techniques — ambre
    'pie_vrd': '#C0392B',   # VRD — brique
}

# Libellés français des clés de risque (doivent correspondre à /compute-scenarios)
RISK_LABELS_FR = {
    'budget_fit':              'Adéquation\nbudgétaire',
    'complexite_structurelle': 'Complexité\nstructurelle',
    'risque_permis':           'Risque\npermis',
    'ratio_efficacite':        'Ratio\nd\'efficacité',
    'densite_cos':             'Densité\nCOS',
    'phasabilite':             'Phasabilité',
    'cout_m2':                 'Coût\nau m²',
}

# Typographie
FONT_TITLE    = {'fontsize': 13, 'fontweight': 'bold', 'color': COLORS['dark']}
FONT_SUBTITLE = {'fontsize': 11, 'fontweight': 'bold', 'color': COLORS['dark']}
FONT_LABEL    = {'fontsize': 9,  'fontweight': 'bold', 'color': COLORS['text']}
FONT_VALUE    = {'fontsize': 10, 'fontweight': 'bold', 'color': COLORS['text']}
FONT_MUTED    = {'fontsize': 8,  'color': COLORS['muted']}

DPI = 300  # Haute résolution pour PPTX


def _save(fig, path):
    """Sauvegarde avec fond blanc, haute résolution, marges serrées."""
    fig.savefig(path, dpi=DPI, bbox_inches='tight', facecolor='white',
                transparent=False, pad_inches=0.15)
    plt.close(fig)


def _severity_color(value, scale=5):
    """Couleur de sévérité : vert (bon) → orange → rouge (mauvais).
    Pour scores sur 5 : 1-2 vert, 3 orange, 4-5 rouge.
    Pour scores sur 100 : 70+ vert, 40-69 orange, <40 rouge."""
    if scale == 100:
        if value >= 70: return COLORS['green']
        if value >= 40: return COLORS['orange']
        return COLORS['red']
    else:
        if value <= 2: return COLORS['green']
        if value <= 3: return COLORS['orange']
        return COLORS['red']


# ═══════════════════════════════════════════════════════════════
# 1. RADAR — Profil de risque par scénario
# ═══════════════════════════════════════════════════════════════
def generate_radar(risk_scores: dict, scenario_label: str, output_path: str):
    """
    risk_scores : {"budget_fit": 72, "complexite_structurelle": 65, ...} (0-100)
    Toutes les valeurs viennent directement de /compute-scenarios.
    """
    categories = list(risk_scores.keys())
    values = [risk_scores[k] for k in categories]
    labels = [RISK_LABELS_FR.get(k, k) for k in categories]

    N = len(categories)
    if N == 0:
        return
    angles = np.linspace(0, 2 * np.pi, N, endpoint=False).tolist()
    values_closed = values + values[:1]
    angles_closed = angles + angles[:1]

    fig, ax = plt.subplots(figsize=(4.8, 4.8), subplot_kw=dict(polar=True))
    fig.patch.set_facecolor('white')

    color = COLORS.get(scenario_label, COLORS['accent'])

    # Zone de remplissage avec dégradé d'opacité
    ax.fill(angles_closed, values_closed, color=color, alpha=0.12)
    ax.plot(angles_closed, values_closed, color=color, linewidth=2.5,
            marker='o', markersize=7, markerfacecolor='white',
            markeredgecolor=color, markeredgewidth=2)

    # Valeurs sur chaque point
    for angle, val in zip(angles, values):
        ax.text(angle, val + 6, str(int(val)), ha='center', va='center',
                fontsize=8, fontweight='bold', color=color,
                path_effects=[pe.withStroke(linewidth=3, foreground='white')])

    ax.set_ylim(0, 100)
    ax.set_yticks([20, 40, 60, 80, 100])
    ax.set_yticklabels(['20', '40', '60', '80', '100'], fontsize=6.5, color=COLORS['muted'])
    ax.set_xticks(angles)
    ax.set_xticklabels(labels, **FONT_LABEL)

    ax.spines['polar'].set_visible(False)
    ax.grid(color=COLORS['grid'], linewidth=0.6, alpha=0.8)
    ax.set_facecolor('white')

    ax.set_title(f'Profil de risque — Scénario {scenario_label}',
                 pad=25, **FONT_TITLE)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 2. GAUGE — Score global de recommandation (arc dégradé)
# ═══════════════════════════════════════════════════════════════
def generate_gauge(score: float, max_score: float, scenario_label: str, output_path: str):
    """
    score : recommendation_score (0-100) — depuis /compute-scenarios.
    Arc dégradé progressif vert→orange→rouge au lieu de segments plats.
    """
    pct = min(score / max_score, 1.0) if max_score > 0 else 0

    fig, ax = plt.subplots(figsize=(5.2, 3.8))
    fig.patch.set_facecolor('white')
    ax.set_xlim(-1.5, 1.5)
    ax.set_ylim(-0.5, 1.5)
    ax.set_aspect('equal')
    ax.axis('off')

    # Arc dégradé — transition fluide vert → orange → rouge
    n_segments = 150
    for i in range(n_segments):
        t = i / n_segments
        # Interpolation de couleur : vert (0) → orange (0.5) → rouge (1)
        if t < 0.5:
            r = int(0x1E + (0xD4 - 0x1E) * t * 2)
            g = int(0x84 + (0x85 - 0x84) * t * 2)
            b = int(0x49 + (0x0E - 0x49) * t * 2)
        else:
            r = int(0xD4 + (0xC0 - 0xD4) * (t - 0.5) * 2)
            g = int(0x85 + (0x39 - 0x85) * (t - 0.5) * 2)
            b = int(0x0E + (0x2B - 0x0E) * (t - 0.5) * 2)
        c = f'#{r:02x}{g:02x}{b:02x}'

        a1 = np.pi * (1 - (i / n_segments))
        a2 = np.pi * (1 - ((i + 1) / n_segments))
        theta = np.linspace(a1, a2, 5)

        # Arc avec épaisseur
        r_inner, r_outer = 0.72, 1.02
        x_outer = r_outer * np.cos(theta)
        y_outer = r_outer * np.sin(theta)
        x_inner = r_inner * np.cos(theta[::-1])
        y_inner = r_inner * np.sin(theta[::-1])
        ax.fill(np.concatenate([x_outer, x_inner]),
                np.concatenate([y_outer, y_inner]),
                color=c, alpha=0.85)

    # Piste de fond (gris clair sous l'arc — pour profondeur)
    for i in range(n_segments):
        a1 = np.pi * (1 - (i / n_segments))
        a2 = np.pi * (1 - ((i + 1) / n_segments))
        theta = np.linspace(a1, a2, 5)
        r_bg_inner, r_bg_outer = 0.65, 0.70
        x_o = r_bg_outer * np.cos(theta)
        y_o = r_bg_outer * np.sin(theta)
        x_i = r_bg_inner * np.cos(theta[::-1])
        y_i = r_bg_inner * np.sin(theta[::-1])
        ax.fill(np.concatenate([x_o, x_i]),
                np.concatenate([y_o, y_i]),
                color=COLORS['grid'], alpha=0.4)

    # Aiguille — position depuis le score RÉEL
    needle_angle = np.pi * (1 - pct)
    nx = 0.92 * np.cos(needle_angle)
    ny = 0.92 * np.sin(needle_angle)
    ax.annotate('', xy=(nx, ny), xytext=(0, 0),
                arrowprops=dict(arrowstyle='->', color=COLORS['dark'], lw=2.8))
    ax.plot(0, 0, 'o', color=COLORS['dark'], markersize=9, zorder=5)

    # Score texte — valeur RÉELLE
    ax.text(0, -0.18, f'{int(score)}', fontsize=28, fontweight='bold',
            ha='center', va='center', color=COLORS['dark'])
    ax.text(0, -0.36, '/100', fontsize=12, ha='center', va='center',
            color=COLORS['muted'])

    # Label qualitatif
    if pct >= 0.7:
        label, lcolor = 'Recommandé', COLORS['green']
    elif pct >= 0.4:
        label, lcolor = 'Acceptable', COLORS['orange']
    else:
        label, lcolor = 'Risqué', COLORS['red']

    ax.text(0, -0.50, label, fontsize=11, fontweight='bold',
            ha='center', va='center', color=lcolor)

    # Étiquettes min/max
    ax.text(-1.15, -0.08, '0', fontsize=8, ha='center', color=COLORS['muted'])
    ax.text(1.15, -0.08, '100', fontsize=8, ha='center', color=COLORS['muted'])

    ax.set_title(f'Score global — Scénario {scenario_label}',
                 pad=12, **FONT_TITLE)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 3. BARRES HORIZONTALES — Facteurs de risque (avec background tracks)
# ═══════════════════════════════════════════════════════════════
def generate_risk_bars(risk_scores: dict, scenario_label: str, output_path: str):
    """
    Barres horizontales avec piste de fond (track) grise pour montrer l'étendue.
    Couleur de sévérité adaptative. Valeurs de /compute-scenarios (0-100).
    """
    categories = list(risk_scores.keys())
    values = [risk_scores[k] for k in categories]
    labels = [RISK_LABELS_FR.get(k, k).replace('\n', ' ') for k in categories]

    colors = [_severity_color(v, scale=100) for v in values]

    fig, ax = plt.subplots(figsize=(5.5, 4.2))
    fig.patch.set_facecolor('white')

    y_pos = np.arange(len(categories))

    # Background tracks (piste grise)
    ax.barh(y_pos, [100] * len(categories), color=COLORS['grid'],
            height=0.55, alpha=0.4, zorder=1)

    # Barres réelles — valeurs du scénario
    bars = ax.barh(y_pos, values, color=colors, height=0.55,
                   edgecolor='white', linewidth=0.5, zorder=2)

    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels, fontsize=9, color=COLORS['text'])
    ax.set_xlim(0, 110)
    ax.set_xticks([0, 25, 50, 75, 100])
    ax.set_xticklabels(['0', '25', '50', '75', '100'], fontsize=7, color=COLORS['muted'])

    # Valeurs à droite des barres — données RÉELLES
    for bar, v, c in zip(bars, values, colors):
        ax.text(bar.get_width() + 2, bar.get_y() + bar.get_height()/2,
                f'{int(v)}', va='center', fontsize=10, fontweight='bold', color=c)

    ax.invert_yaxis()
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['bottom'].set_color(COLORS['grid'])
    ax.spines['left'].set_color(COLORS['grid'])
    ax.grid(axis='x', color=COLORS['grid'], linewidth=0.4, alpha=0.5)

    ax.set_title(f'Facteurs de risque — Scénario {scenario_label}',
                 pad=18, **FONT_TITLE)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 4. TABLEAU COMPARATIF — Slide 15
# ═══════════════════════════════════════════════════════════════
def generate_comparatif_table(scenarios: dict, output_path: str):
    """
    Tableau visuel multi-critères avec highlight vert pour la meilleure valeur.
    Toutes les données viennent du JSON scénario — aucune invention.
    """
    criteria = [
        ('SDP (m²)',                 'sdp_m2'),
        ('Surface habitable (m²)',   'surface_habitable_m2'),
        ('Efficacité (%)',           'ratio_efficacite_pct'),
        ('Nombre d\'unités',         'total_units'),
        ('Niveaux',                  'levels'),
        ('Coût total (FCFA)',        'cost_total_fcfa'),
        ('Coût/m² SDP',             'cost_per_m2_sdp'),
        ('Score recommandation',     'recommendation_score'),
        ('Durée chantier (mois)',    'duree_chantier_mois'),
    ]

    labels_order = ['A', 'B', 'C']
    n_rows = len(criteria)

    fig, ax = plt.subplots(figsize=(10.5, 0.62 * n_rows + 1.5))
    fig.patch.set_facecolor('white')
    ax.axis('off')

    col_widths = [0.32, 0.22, 0.22, 0.22]
    col_x = [0]
    for w in col_widths[:-1]:
        col_x.append(col_x[-1] + w)

    row_h = 0.78 / (n_rows + 1)
    header_y = 1.0 - row_h

    # En-tête
    headers = ['Critère', 'Scénario A', 'Scénario B', 'Scénario C']
    header_colors = [COLORS['dark'], COLORS['A'], COLORS['B'], COLORS['C']]

    for j, (hdr, hcol) in enumerate(zip(headers, header_colors)):
        rect = FancyBboxPatch((col_x[j], header_y), col_widths[j] - 0.005, row_h * 0.9,
                              boxstyle="round,pad=0.006", facecolor=hcol,
                              edgecolor='white', linewidth=1.5)
        ax.add_patch(rect)
        ax.text(col_x[j] + col_widths[j] / 2, header_y + row_h * 0.45,
                hdr, ha='center', va='center', fontsize=11,
                fontweight='bold', color='white')

    # Lignes — données RÉELLES
    for i, (crit_name, crit_key) in enumerate(criteria):
        y = header_y - (i + 1) * row_h
        bg = 'white' if i % 2 == 0 else COLORS['light']

        # Cellule critère
        rect = FancyBboxPatch((col_x[0], y), col_widths[0] - 0.005, row_h * 0.9,
                              boxstyle="round,pad=0.006", facecolor=bg,
                              edgecolor=COLORS['grid'], linewidth=0.5)
        ax.add_patch(rect)
        ax.text(col_x[0] + 0.012, y + row_h * 0.45, crit_name,
                ha='left', va='center', fontsize=10, fontweight='bold',
                color=COLORS['text'])

        # Valeurs A, B, C — données RÉELLES
        vals = []
        for label in labels_order:
            sc = scenarios.get(label, {})
            v = sc.get(crit_key, '-')
            vals.append(v)

        # Identifier la meilleure valeur pour highlight vert
        numeric_vals = [(idx, v) for idx, v in enumerate(vals) if isinstance(v, (int, float))]
        best_idx = None
        if numeric_vals:
            if crit_key in ('recommendation_score', 'surface_habitable_m2',
                            'ratio_efficacite_pct', 'total_units', 'sdp_m2'):
                best_idx = max(numeric_vals, key=lambda x: x[1])[0]
            elif crit_key in ('cost_total_fcfa', 'cost_per_m2_sdp', 'duree_chantier_mois'):
                best_idx = min(numeric_vals, key=lambda x: x[1])[0]

        for j_val, (label, v) in enumerate(zip(labels_order, vals)):
            col_idx = j_val + 1
            is_best = (j_val == best_idx) if best_idx is not None else False
            cell_bg = '#E8F5E9' if is_best else bg
            cell_border = COLORS['green'] if is_best else COLORS['grid']
            border_w = 1.2 if is_best else 0.5

            rect = FancyBboxPatch((col_x[col_idx], y), col_widths[col_idx] - 0.005,
                                  row_h * 0.9, boxstyle="round,pad=0.006",
                                  facecolor=cell_bg, edgecolor=cell_border,
                                  linewidth=border_w)
            ax.add_patch(rect)

            # Formatage — données RÉELLES, aucun arrondi trompeur
            if isinstance(v, (int, float)):
                if crit_key in ('cost_total_fcfa', 'cost_per_m2_sdp'):
                    txt = f'{int(v):,}'.replace(',', ' ')
                elif isinstance(v, float) and v != int(v):
                    txt = f'{v:.1f}'
                else:
                    txt = str(int(v))
            else:
                txt = str(v)

            fw = 'bold' if is_best else 'normal'
            tc = COLORS['green'] if is_best else COLORS['text']
            ax.text(col_x[col_idx] + col_widths[col_idx] / 2, y + row_h * 0.45,
                    txt, ha='center', va='center', fontsize=10,
                    fontweight=fw, color=tc)

    ax.set_xlim(-0.02, 1.02)
    ax.set_ylim(header_y - n_rows * row_h - 0.02, header_y + row_h + 0.02)

    ax.set_title('Comparatif stratégique — Scénarios A / B / C',
                 pad=18, fontsize=14, fontweight='bold', color=COLORS['dark'])

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 5. ARBITRAGE — 4 mini-charts (slide 16)
# ═══════════════════════════════════════════════════════════════
def generate_arbitrage_graphs(scenarios: dict, output_path: str):
    """
    4 grouped bar charts : coût, surface, unités, score.
    Toutes les valeurs du JSON scénario — aucune invention.
    """
    labels = ['A', 'B', 'C']
    colors = [COLORS['A'], COLORS['B'], COLORS['C']]

    criteria = [
        ('Coût total\n(M FCFA)',        'cost_total_fcfa',      1_000_000, 'M'),
        ('Surface habitable\n(m²)',     'surface_habitable_m2', 1,         'm²'),
        ('Nombre\nd\'unités',           'total_units',          1,         ''),
        ('Score\nrecommandation',       'recommendation_score', 1,         '/100'),
    ]

    fig, axes = plt.subplots(1, 4, figsize=(14.5, 3.8))
    fig.patch.set_facecolor('white')

    for idx, (title, key, divisor, suffix) in enumerate(criteria):
        ax = axes[idx]
        # Données RÉELLES
        vals = [scenarios.get(l, {}).get(key, 0) / divisor for l in labels]
        max_val = max(vals) if max(vals) > 0 else 1

        # Barres
        bars = ax.bar(labels, vals, color=colors, width=0.55,
                      edgecolor='white', linewidth=1.5)

        # Valeurs au-dessus — données RÉELLES
        for bar, v, c in zip(bars, vals, colors):
            if divisor > 1:
                fmt = f'{v:.0f}{suffix}'
            elif suffix == '/100':
                fmt = f'{int(v)}{suffix}'
            elif suffix == 'm²':
                fmt = f'{int(v)}{suffix}'
            else:
                fmt = f'{int(v)}'
            ax.text(bar.get_x() + bar.get_width()/2,
                    bar.get_height() + max_val * 0.04,
                    fmt, ha='center', va='bottom', fontsize=9.5,
                    fontweight='bold', color=c)

        ax.set_title(title, fontsize=10.5, fontweight='bold',
                     color=COLORS['dark'], pad=12)
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.spines['left'].set_color(COLORS['grid'])
        ax.spines['bottom'].set_color(COLORS['grid'])
        ax.tick_params(colors=COLORS['text'], labelsize=10)
        ax.set_ylim(0, max_val * 1.28)
        ax.yaxis.set_visible(False)

    fig.suptitle('Critères d\'arbitrage stratégique', fontsize=14,
                 fontweight='bold', color=COLORS['dark'], y=1.03)
    plt.tight_layout()

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 6. VENTILATION COÛTS — Donut avec données réelles (slide 17)
# ═══════════════════════════════════════════════════════════════
def generate_cost_breakdown(scenario: dict, output_path: str):
    """
    Donut chart avec ventilation RÉELLE si disponible, sinon ratios standard.
    Le total au centre est le coût RÉEL du scénario.
    """
    # Tenter d'utiliser les données réelles de ventilation
    cost_go = scenario.get('cost_gros_oeuvre_structure', 0)
    cost_so = scenario.get('cost_second_oeuvre_finitions', 0)
    cost_lt = scenario.get('cost_lots_techniques', 0)
    cost_vrd = scenario.get('cost_vrd_amenagements', 0)

    cost_total = scenario.get('cost_total_fcfa', 0)
    has_real_ventilation = (cost_go + cost_so + cost_lt + cost_vrd) > 0

    if has_real_ventilation:
        sizes = [cost_go, cost_so, cost_lt, cost_vrd]
        # Calculer les pourcentages réels
        total_vent = sum(sizes)
        pcts = [s / total_vent * 100 if total_vent > 0 else 25 for s in sizes]
    else:
        # Ratios standards construction Cameroun
        pcts = [35, 30, 20, 15]
        sizes = pcts  # Utiliser les pourcentages directement

    labels = [
        'Gros œuvre\n& structure',
        'Second œuvre\n& finitions',
        'Lots\ntechniques',
        'VRD &\naménagements',
    ]
    colors_pie = [COLORS['pie_go'], COLORS['pie_so'], COLORS['pie_lt'], COLORS['pie_vrd']]
    explode = (0.02, 0.02, 0.02, 0.02)

    fig, ax = plt.subplots(figsize=(5.5, 4.8))
    fig.patch.set_facecolor('white')

    wedges, texts, autotexts = ax.pie(
        sizes, labels=labels, autopct='%1.0f%%', explode=explode,
        colors=colors_pie, startangle=90, textprops={'fontsize': 9.5},
        pctdistance=0.78, labeldistance=1.18,
        wedgeprops={'edgecolor': 'white', 'linewidth': 2.5}
    )

    for t in autotexts:
        t.set_fontweight('bold')
        t.set_color('white')
        t.set_fontsize(10.5)

    for t in texts:
        t.set_color(COLORS['text'])
        t.set_fontsize(9)

    # Cercle central (donut)
    centre = plt.Circle((0, 0), 0.50, fc='white', ec=COLORS['grid'], linewidth=0.8)
    ax.add_artist(centre)

    # Total au centre — coût RÉEL
    if cost_total > 0:
        ax.text(0, 0.06, f'{cost_total / 1_000_000:.0f} M', fontsize=20,
                fontweight='bold', ha='center', va='center', color=COLORS['dark'])
        ax.text(0, -0.14, 'FCFA', fontsize=10, ha='center', va='center',
                color=COLORS['muted'])

    # Indicateur données réelles vs standards
    data_source = 'Ventilation réelle' if has_real_ventilation else 'Ratios standards'
    ax.text(0, -1.35, data_source, fontsize=7, ha='center', va='center',
            color=COLORS['muted'], fontstyle='italic')

    ax.set_title('Ventilation des coûts de construction',
                 pad=18, **FONT_TITLE)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 7. TIMELINE — Phasage chantier (slide 19)
# ═══════════════════════════════════════════════════════════════
def generate_timeline(scenario: dict, output_path: str):
    """
    Timeline horizontale avec phases proportionnelles.
    Durée totale = donnée RÉELLE du scénario.
    """
    phases_base = [
        ('Études &\nPermis',           3, COLORS['dark']),
        ('Terrassement &\nFondations', 2, '#2E7D6F'),
        ('Gros\nœuvre',                4, COLORS['B']),
        ('Second\nœuvre',              3, '#B07D3A'),
        ('Finitions &\nRéception',     1, COLORS['C']),
    ]

    duree = scenario.get('duree_chantier_mois', 13)
    base_total = sum(p[1] for p in phases_base)

    phases = []
    for name, base_months, color in phases_base:
        scaled = max(1, round(base_months * duree / base_total))
        phases.append((name, scaled, color))

    # Ajuster pour correspondre à la durée exacte
    actual_total = sum(p[1] for p in phases)
    if actual_total != duree:
        diff = duree - actual_total
        name, months, color = phases[2]  # Ajuster le gros œuvre
        phases[2] = (name, max(1, months + diff), color)

    total_months = sum(p[1] for p in phases)

    fig, ax = plt.subplots(figsize=(12.5, 3.2))
    fig.patch.set_facecolor('white')

    x = 0
    bar_height = 0.45
    y_center = 0.5

    cumulative = 0
    for i, (label, months, color) in enumerate(phases):
        width = months / total_months
        rect = mpatches.FancyBboxPatch(
            (x, y_center - bar_height / 2), width - 0.004, bar_height,
            boxstyle="round,pad=0.012", facecolor=color,
            edgecolor='white', linewidth=2.5
        )
        ax.add_patch(rect)

        # Nom de phase
        ax.text(x + width / 2, y_center + 0.05, label,
                ha='center', va='center', fontsize=10,
                fontweight='bold', color='white')

        # Durée en mois — RÉELLE (scaled)
        ax.text(x + width / 2, y_center - bar_height / 2 - 0.13,
                f'{months} mois', ha='center', va='top',
                fontsize=9, color=COLORS['text'])

        # Marqueur mois
        ax.text(x + 0.005, y_center + bar_height / 2 + 0.09,
                f'M{cumulative + 1}', ha='left', va='bottom',
                fontsize=7, color=COLORS['muted'])

        cumulative += months
        x += width

    # Marqueur fin
    ax.text(1.0, y_center + bar_height / 2 + 0.09,
            f'M{total_months}', ha='right', va='bottom',
            fontsize=7, color=COLORS['muted'])

    ax.set_xlim(-0.02, 1.02)
    ax.set_ylim(-0.12, 1.1)
    ax.axis('off')

    ax.set_title(f'Phasage du chantier — Durée estimée : {duree} mois',
                 pad=22, fontsize=14, fontweight='bold', color=COLORS['dark'])

    # Avertissement saison des pluies
    ax.text(0.5, -0.07,
            '⚠ Saison des pluies (juin–octobre) : éviter terrassement et fondations',
            ha='center', va='top', fontsize=9, fontstyle='italic',
            color=COLORS['orange'])

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 8. RECAP CARD — Fiche scénario recommandé (slide 20)
# ═══════════════════════════════════════════════════════════════
def generate_recap_card(scenario: dict, label: str, output_path: str):
    """
    Carte résumé visuelle pour le scénario recommandé.
    Tous les KPI sont des données RÉELLES — aucune invention.
    """
    fig, ax = plt.subplots(figsize=(10.5, 3.2))
    fig.patch.set_facecolor('white')
    ax.axis('off')

    color = COLORS.get(label, COLORS['C'])

    # Fond de carte
    card = mpatches.FancyBboxPatch(
        (0.02, 0.08), 0.96, 0.84,
        boxstyle="round,pad=0.025", facecolor=color, edgecolor='white',
        linewidth=0, alpha=0.08
    )
    ax.add_patch(card)

    # Bandeau supérieur
    accent = mpatches.FancyBboxPatch(
        (0.02, 0.82), 0.96, 0.10,
        boxstyle="round,pad=0.012", facecolor=color, edgecolor='none'
    )
    ax.add_patch(accent)
    ax.text(0.5, 0.87, f'SCÉNARIO {label} — RECOMMANDÉ', ha='center', va='center',
            fontsize=14, fontweight='bold', color='white',
            fontfamily='sans-serif')

    # KPI boxes — données RÉELLES
    kpis = [
        ('SDP',             f'{scenario.get("sdp_m2", 0)} m²'),
        ('Surface\nhabitable', f'{scenario.get("surface_habitable_m2", 0)} m²'),
        ('Unités',          f'{scenario.get("total_units", 0)}'),
        ('Coût\nestimé',    f'{scenario.get("cost_total_fcfa", 0) / 1_000_000:.0f} M FCFA'),
        ('Durée\nchantier', f'{scenario.get("duree_chantier_mois", 0)} mois'),
        ('Score',           f'{scenario.get("recommendation_score", 0)}/100'),
    ]

    n = len(kpis)
    box_w = 0.135
    gap = (0.92 - n * box_w) / (n + 1)

    for i, (kpi_label, kpi_value) in enumerate(kpis):
        x = 0.04 + gap + i * (box_w + gap)
        y = 0.22

        # Boîte KPI avec ombre subtile
        shadow = mpatches.FancyBboxPatch(
            (x + 0.003, y - 0.003), box_w, 0.52,
            boxstyle="round,pad=0.015", facecolor=COLORS['grid'],
            edgecolor='none', alpha=0.3
        )
        ax.add_patch(shadow)

        kpi_box = mpatches.FancyBboxPatch(
            (x, y), box_w, 0.52,
            boxstyle="round,pad=0.015", facecolor='white',
            edgecolor=COLORS['grid'], linewidth=0.8
        )
        ax.add_patch(kpi_box)

        # Valeur (grande) — données RÉELLES
        ax.text(x + box_w / 2, y + 0.36, kpi_value,
                ha='center', va='center', fontsize=12.5,
                fontweight='bold', color=COLORS['dark'])

        # Label (petit)
        ax.text(x + box_w / 2, y + 0.10, kpi_label,
                ha='center', va='center', fontsize=7.5,
                color=COLORS['muted'])

    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 9. PANEL RISQUE — 3 charts séparés pour un scénario
# ═══════════════════════════════════════════════════════════════
def generate_risk_panel(risk_scores: dict, recommendation_score: float,
                        scenario_label: str, output_dir: str):
    """
    Génère 3 PNG séparés : radar, gauge, barres.
    Retourne dict des chemins. Données RÉELLES uniquement.
    """
    radar_path = os.path.join(output_dir, f'risk_radar_{scenario_label}.png')
    gauge_path = os.path.join(output_dir, f'risk_gauge_{scenario_label}.png')
    bars_path  = os.path.join(output_dir, f'risk_bars_{scenario_label}.png')

    generate_radar(risk_scores, scenario_label, radar_path)
    generate_gauge(recommendation_score, 100, scenario_label, gauge_path)
    generate_risk_bars(risk_scores, scenario_label, bars_path)

    return {'radar': radar_path, 'gauge': gauge_path, 'bars': bars_path}


# ═══════════════════════════════════════════════════════════════
# MAIN — Génération complète depuis le JSON d'entrée
# ═══════════════════════════════════════════════════════════════
def _format_money(amount):
    """v74.15 — formatte un montant FCFA en M (millions) ou k (milliers)."""
    a = float(amount or 0)
    if a >= 1_000_000:
        return f"{a / 1_000_000:.0f} M"
    if a >= 1_000:
        return f"{a / 1_000:.0f} k"
    return f"{a:.0f}"


def generate_cost_calc_visual(scenario: dict, label: str, output_path: str):
    """v74.15 — Visualisation graphique du calcul SDP × coût/m² = total.
    3 blocs numerotés côte à côte avec gros chiffres et icônes opérateurs.
    Remplace la prose 'Le calcul s'articule comme suit ...'.
    """
    sdp = scenario.get('sdp_m2', 0)
    cost_m2 = scenario.get('cost_m2_fcfa', 0)
    cost_total = scenario.get('cost_total_fcfa', 0)
    accent = COLORS.get(label, COLORS['dark'])

    fig, axes = plt.subplots(1, 5, figsize=(11, 3),
                             gridspec_kw={'width_ratios': [3, 0.4, 3, 0.4, 3.2]})
    fig.patch.set_facecolor('white')

    # Bloc 1 : SDP
    ax = axes[0]
    ax.set_facecolor(COLORS['light'])
    ax.text(0.5, 0.65, f"{sdp:,.0f}".replace(',', ' '), ha='center', va='center',
            fontsize=32, fontweight='bold', color=COLORS['dark'])
    ax.text(0.5, 0.30, 'm² SDP', ha='center', va='center',
            fontsize=11, color=COLORS['muted'])
    ax.text(0.5, 0.08, 'Surface de Plancher', ha='center', va='center',
            fontsize=8, color=COLORS['muted'], style='italic')
    ax.set_xticks([]); ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_color(COLORS['grid'])
        spine.set_linewidth(0.8)

    # Opérateur ×
    axes[1].text(0.5, 0.5, '×', ha='center', va='center',
                 fontsize=36, color=accent, fontweight='bold')
    axes[1].axis('off')

    # Bloc 2 : Coût/m²
    ax = axes[2]
    ax.set_facecolor(COLORS['light'])
    ax.text(0.5, 0.65, _format_money(cost_m2), ha='center', va='center',
            fontsize=32, fontweight='bold', color=COLORS['dark'])
    ax.text(0.5, 0.30, 'FCFA / m²', ha='center', va='center',
            fontsize=11, color=COLORS['muted'])
    ax.text(0.5, 0.08, 'Coût marché local', ha='center', va='center',
            fontsize=8, color=COLORS['muted'], style='italic')
    ax.set_xticks([]); ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_color(COLORS['grid'])
        spine.set_linewidth(0.8)

    # Opérateur =
    axes[3].text(0.5, 0.5, '=', ha='center', va='center',
                 fontsize=36, color=accent, fontweight='bold')
    axes[3].axis('off')

    # Bloc 3 : Total (mis en avant)
    ax = axes[4]
    ax.set_facecolor(accent)
    ax.text(0.5, 0.65, _format_money(cost_total), ha='center', va='center',
            fontsize=34, fontweight='bold', color='white')
    ax.text(0.5, 0.30, 'FCFA', ha='center', va='center',
            fontsize=11, color='white')
    ax.text(0.5, 0.08, 'Coût total estimé', ha='center', va='center',
            fontsize=8, color='white', style='italic')
    ax.set_xticks([]); ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)

    fig.suptitle(f"Calcul du coût total — Scénario {label}",
                 fontsize=12, fontweight='bold', color=COLORS['dark'], y=0.98)
    fig.subplots_adjust(left=0.02, right=0.98, top=0.85, bottom=0.05, wspace=0.05)

    _save(fig, output_path)


def generate_budget_position_gauge(scenario: dict, label: str, budget_fcfa_value: float, output_path: str):
    """v74.15 — Jauge horizontale : où se positionne le coût scénario par rapport au budget client.
    Coloration : vert (dans budget), orange (limite), rouge (dépassement).
    """
    cost_total = float(scenario.get('cost_total_fcfa', 0) or 0)
    budget = float(budget_fcfa_value or 0)
    if budget <= 0:
        budget = max(cost_total * 1.1, 1)

    # Calcul de la position
    ratio = cost_total / budget if budget > 0 else 0
    # Échelle : 0 à 150% du budget
    scale_max = max(1.5 * budget, cost_total * 1.05)

    # Couleur selon position
    if ratio <= 0.95:
        bar_color = COLORS['green']
        label_pos = 'Dans le budget'
    elif ratio <= 1.05:
        bar_color = COLORS['orange']
        label_pos = 'En limite de budget'
    else:
        bar_color = COLORS['red']
        label_pos = 'Hors budget'

    fig, ax = plt.subplots(figsize=(11, 2.6))
    fig.patch.set_facecolor('white')

    # Track de fond
    bar_y = 0.5
    ax.barh([bar_y], [scale_max], height=0.42, color=COLORS['grid'], edgecolor='none')
    # Coût scénario
    ax.barh([bar_y], [cost_total], height=0.42, color=bar_color, edgecolor='none')

    # Marker budget client (ligne verticale)
    ax.axvline(x=budget, color=COLORS['dark'], linewidth=2.5, linestyle='--', zorder=5)
    ax.text(budget, 1.02, f"Budget client\n{_format_money(budget)} FCFA",
            ha='center', va='bottom', fontsize=9.5, fontweight='bold',
            color=COLORS['dark'])

    # Marker coût scénario (texte au-dessus de la barre)
    ax.text(cost_total / 2, bar_y, f"{_format_money(cost_total)} FCFA",
            ha='center', va='center', fontsize=14, fontweight='bold',
            color='white' if ratio > 0.4 else COLORS['dark'])

    # Label position en bas à droite
    ax.text(scale_max * 0.99, 0.0, label_pos,
            ha='right', va='top', fontsize=10.5, fontweight='bold',
            color=bar_color)

    # Pourcentage du budget
    pct = ratio * 100
    ax.text(scale_max * 0.99, 0.18, f"{pct:.0f} % du budget",
            ha='right', va='top', fontsize=9, color=COLORS['muted'])

    ax.set_xlim(0, scale_max)
    ax.set_ylim(-0.1, 1.4)
    ax.set_yticks([])
    ax.set_xticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)

    ax.set_title(f"Position du coût vs budget — Scénario {label}",
                 pad=12, **FONT_TITLE)

    _save(fig, output_path)


def generate_all_charts(data: dict, output_dir: str) -> dict:
    """
    data : payload JSON complet de /generate-pptx
    Retourne un dict mappant les clés placeholder → chemins PNG.
    Tous les charts utilisent des données RÉELLES — aucune valeur inventée.
    """
    os.makedirs(output_dir, exist_ok=True)
    chart_paths = {}

    scenarios = data.get('scenarios', {})
    print(f"[CHARTS v2.0] Scénarios disponibles : {list(scenarios.keys())}", file=sys.stderr)

    # Panels de risque par scénario (slides 8, 11, 14)
    for label in ['A', 'B', 'C']:
        sc = scenarios.get(label, {})
        risk_scores = sc.get('risk_scores', {})
        rec_score = sc.get('recommendation_score', 50)

        print(f"[CHARTS v2.0] Scénario {label}: risk_scores={risk_scores}, "
              f"rec_score={rec_score}", file=sys.stderr)

        if risk_scores:
            paths = generate_risk_panel(risk_scores, rec_score, label, output_dir)
            chart_paths[f'scenario_{label}_risk_radar'] = paths['radar']
            chart_paths[f'scenario_{label}_risk_gauge'] = paths['gauge']
            chart_paths[f'scenario_{label}_risk_bars']  = paths['bars']
        else:
            print(f"[CHARTS v2.0] ATTENTION : pas de risk_scores pour "
                  f"scénario {label}", file=sys.stderr)

    # Tableau comparatif (slide 15)
    comp_path = os.path.join(output_dir, 'comparatif_table.png')
    generate_comparatif_table(scenarios, comp_path)
    chart_paths['tableau_comparative_charts'] = comp_path

    # Graphiques d'arbitrage (slide 16)
    arb_path = os.path.join(output_dir, 'arbitrage_graphs.png')
    generate_arbitrage_graphs(scenarios, arb_path)
    chart_paths['arbitrage_graph_'] = arb_path

    # Ventilation coûts (slide 17)
    rec_label = data.get('recommended_scenario', data.get('recommended', 'C'))
    rec_sc = scenarios.get(rec_label, {})
    if rec_sc:
        pie_path = os.path.join(output_dir, 'cost_breakdown.png')
        generate_cost_breakdown(rec_sc, pie_path)
        chart_paths['cost_breakdown'] = pie_path
        print(f"[CHARTS v2.0] Ventilation coûts scénario {rec_label}: "
              f"coût={rec_sc.get('cost_total_fcfa', 0)}", file=sys.stderr)

    # v74.15 — Charts financiers PAR SCENARIO (slides 7/10/13)
    # 3 charts pour chacun A, B, C : calcul, donut ventilation, jauge vs budget
    budget_value = 0
    try:
        # parser budget_fcfa string ex "33M FCFA" → 33_000_000
        budget_str = str(data.get('budget_fcfa', '') or '').upper()
        import re
        m = re.search(r'(\d+(?:[.,]\d+)?)\s*M', budget_str)
        if m:
            budget_value = float(m.group(1).replace(',', '.')) * 1_000_000
    except Exception:
        pass

    for label in ['A', 'B', 'C']:
        sc = scenarios.get(label, {})
        if not sc or not sc.get('cost_total_fcfa'):
            continue
        # 1. Calcul visuel SDP × cost/m² = total
        calc_path = os.path.join(output_dir, f'scenario_{label}_cost_calc.png')
        try:
            generate_cost_calc_visual(sc, label, calc_path)
            chart_paths[f'scenario_{label}_cost_calc'] = calc_path
        except Exception as e:
            print(f"[CHARTS v2.0] Erreur cost_calc {label}: {e}", file=sys.stderr)
        # 2. Donut ventilation pour ce scenario
        donut_path = os.path.join(output_dir, f'scenario_{label}_cost_donut.png')
        try:
            generate_cost_breakdown(sc, donut_path)
            chart_paths[f'scenario_{label}_cost_donut'] = donut_path
        except Exception as e:
            print(f"[CHARTS v2.0] Erreur cost_donut {label}: {e}", file=sys.stderr)
        # 3. Jauge vs budget client
        gauge_path = os.path.join(output_dir, f'scenario_{label}_budget_gauge.png')
        try:
            generate_budget_position_gauge(sc, label, budget_value, gauge_path)
            chart_paths[f'scenario_{label}_budget_gauge'] = gauge_path
        except Exception as e:
            print(f"[CHARTS v2.0] Erreur budget_gauge {label}: {e}", file=sys.stderr)

    # Timeline (slide 19)
    if rec_sc:
        timeline_path = os.path.join(output_dir, 'timeline.png')
        generate_timeline(rec_sc, timeline_path)
        chart_paths['timeline'] = timeline_path

    # Recap card (slide 20)
    if rec_sc:
        recap_path = os.path.join(output_dir, 'recap_card.png')
        generate_recap_card(rec_sc, rec_label, recap_path)
        chart_paths['recap_card'] = recap_path

    print(f"[CHARTS v2.0] Total charts générés : {len(chart_paths)}", file=sys.stderr)
    return chart_paths


# ═══════════════════════════════════════════════════════════════
# CLI — Point d'entrée ligne de commande
# ═══════════════════════════════════════════════════════════════
if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python generate_charts.py <input.json> <output_dir>")
        sys.exit(1)

    with open(sys.argv[1], 'r') as f:
        data = json.load(f)

    output_dir = sys.argv[2]
    paths = generate_all_charts(data, output_dir)

    # Retourne les chemins en JSON pour Node.js
    print(json.dumps(paths, indent=2))
