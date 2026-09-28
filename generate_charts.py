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

# Libellés des 7 critères du score BARLO (v12.12). Les clés restent celles envoyées par le serveur
# (mapScenarioForPython) ; chaque libellé nomme le critère RÉELLEMENT porté par la valeur
# (avant : « Densité COS » affichait la capacité, « Coût au m² » le standing, etc.).
# Échelle 0-100 : 100 = favorable.
RISK_LABELS_FR = {
    # v13 — grille BARLO du 28/09/2026 (clés = critères envoyés par le serveur)
    'budget_fit':              'Budget',
    'programme_match':         'Réponse au\nprogramme',
    'setback_encroachment':    'Marges de recul',
    'cos_conformity':          'Emprise\nau sol',
    'phase_flexibility':       'Phasage',
    'structure_simplicity':    'Simplicité\nconstructive',
    'standing_match':          'Standing',
    # anciennes clés (avant v13)
    'complexite_structurelle': 'Risque /\nposture',
    'risque_permis':           'Conformité\n(COS, retraits)',
    'ratio_efficacite':        'Efficacité\ncoût',
    'densite_cos':             'Nombre\nd\'unités',
    'phasabilite':             'Phasage',
    'cout_m2':                 'Standing\n(surfaces)',
}

# Typographie
FONT_TITLE    = {'fontsize': 13, 'fontweight': 'bold', 'color': COLORS['dark']}
FONT_SUBTITLE = {'fontsize': 11, 'fontweight': 'bold', 'color': COLORS['dark']}
FONT_LABEL    = {'fontsize': 9,  'fontweight': 'bold', 'color': COLORS['text']}
FONT_VALUE    = {'fontsize': 10, 'fontweight': 'bold', 'color': COLORS['text']}
FONT_MUTED    = {'fontsize': 8,  'color': COLORS['muted']}

DPI = 300  # Haute résolution pour PPTX


def _save(fig, path):
    """v74.18 — Sauvegarde fond figure transparent MAIS axes facecolors PRESERVES.
    Avec transparent=True (v74.16) matplotlib forcait tous les patches en transparent,
    cassant le bloc de couleur 'TOTAL' (42M en blanc-sur-rien invisible).
    Solution : facecolor='none' sur la figure mais transparent=False dans savefig
    → la figure n'a pas de fond, mais ax.set_facecolor() est respecte."""
    fig.patch.set_facecolor('none')
    fig.patch.set_edgecolor('none')
    fig.savefig(path, dpi=DPI, bbox_inches='tight',
                transparent=False, pad_inches=0.15,
                facecolor='none', edgecolor='none')
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

    # Valeurs sur chaque point (v13 : à l'intérieur du radar quand la note est haute, pour ne pas
    # chevaucher le libellé du critère)
    for angle, val in zip(angles, values):
        ax.text(angle, val + 8 if val < 80 else val - 13, str(int(val)), ha='center', va='center',
                fontsize=8, fontweight='bold', color=color,
                path_effects=[pe.withStroke(linewidth=3, foreground='white')])

    ax.set_ylim(0, 100)
    ax.set_yticks([20, 40, 60, 80, 100])
    ax.set_yticklabels(['20', '40', '60', '80', '100'], fontsize=6.5, color=COLORS['muted'])
    ax.set_xticks(angles)
    ax.set_xticklabels(labels, **FONT_LABEL)
    ax.tick_params(axis='x', pad=18)   # v12.17b / v13 — libellés décollés des valeurs

    ax.spines['polar'].set_visible(False)
    ax.grid(color=COLORS['grid'], linewidth=0.6, alpha=0.8)
    ax.set_facecolor('white')

    ax.set_title(f'Évaluation multicritère — Scénario {scenario_label} (100 = favorable)',
                 pad=25, **FONT_TITLE)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 2. GAUGE — Score global de recommandation (arc dégradé)
# ═══════════════════════════════════════════════════════════════
def generate_gauge(score: float, max_score: float, scenario_label: str, output_path: str, recommended: bool = False):
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

    # Arc dégradé : rouge à gauche (score 0) → orange → vert à droite (score 100),
    # dans le même sens que l'aiguille (angle = pi * (1 - pct)).
    n_segments = 150
    for i in range(n_segments):
        t = 1 - i / n_segments
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

    # Label qualitatif — v12.17 : « Recommandé » seulement pour le scénario réellement recommandé
    if recommended:
        label, lcolor = 'Recommandé', COLORS['green']
    elif pct >= 0.75:
        label, lcolor = 'Favorable', COLORS['green']
    elif pct >= 0.6:
        label, lcolor = 'Correct', COLORS['orange']
    else:
        label, lcolor = 'Fragile', COLORS['red']

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

    ax.set_title(f'Critères du score — Scénario {scenario_label} (100 = favorable)',
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
        ('Surface utile (m²)',       'surface_habitable_m2'),
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
        ('Surface utile\n(m²)',         'surface_habitable_m2', 1,         'm²'),
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
        ('Surface\nutile',     f'{scenario.get("surface_habitable_m2", 0)} m²'),
        ('Unités',          f'{scenario.get("total_units", 0)}'),
        ('Coût des\ntravaux', f'{scenario.get("cost_total_fcfa", 0) / 1_000_000:.0f} M FCFA'),
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
                        scenario_label: str, output_dir: str, recommended: bool = False):
    """
    Génère 3 PNG séparés : radar, gauge, barres.
    Retourne dict des chemins. Données RÉELLES uniquement.
    """
    radar_path = os.path.join(output_dir, f'risk_radar_{scenario_label}.png')
    gauge_path = os.path.join(output_dir, f'risk_gauge_{scenario_label}.png')
    bars_path  = os.path.join(output_dir, f'risk_bars_{scenario_label}.png')

    # v13.2 — au format exact de la zone (3 graphiques côte à côte)
    generate_radar_fit(risk_scores, scenario_label, radar_path)
    generate_gauge_fit(recommendation_score, scenario_label, gauge_path, recommended)
    generate_bars_fit(risk_scores, scenario_label, bars_path)

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
    # v74.16 — utilise cost_per_m2_sdp (champ reel de mapScenarioForPython)
    # avec fallback derive (cost_total / sdp) si manquant
    cost_m2 = scenario.get('cost_per_m2_sdp', 0)
    cost_total = scenario.get('cost_total_fcfa', 0)
    if not cost_m2 and sdp > 0 and cost_total > 0:
        cost_m2 = cost_total / sdp
    accent = COLORS.get(label, COLORS['dark'])

    # v74.17 — figsize ratio 9:1.3 ≈ 6.9 (match insertion pour zero distorsion)
    fig, axes = plt.subplots(1, 5, figsize=(13.8, 2),
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

    # v74.16 — pas de suptitle (le titre est porte par le texte de la slide).
    # Plus d'espace pour les chiffres, fond integre au slide.
    fig.subplots_adjust(left=0.02, right=0.98, top=0.96, bottom=0.04, wspace=0.05)

    _save(fig, output_path)


def generate_budget_position_gauge(scenario: dict, label: str, budget_fcfa_value: float, output_path: str):
    """v74.15 — Jauge horizontale : où se positionne le coût scénario par rapport au budget client.
    Coloration : vert (dans budget), orange (limite), rouge (dépassement).
    """
    cost_total = float(scenario.get('cost_total_fcfa', 0) or 0)
    budget = float(budget_fcfa_value or 0)
    # Budget client inconnu : on ne l'invente pas (plus de « coût × 1,1 » qui affichait toujours « dans le budget »)
    has_budget = budget > 0

    ratio = cost_total / budget if has_budget else 0
    scale_max = max(1.5 * budget, cost_total * 1.05) if has_budget else max(cost_total * 1.25, 1)

    if not has_budget:
        bar_color = COLORS['dark']
        label_pos = 'Budget client non renseigné'
    elif ratio <= 0.95:
        bar_color = COLORS['green']
        label_pos = 'Dans le budget'
    elif ratio <= 1.05:
        bar_color = COLORS['orange']
        label_pos = 'En limite de budget'
    else:
        bar_color = COLORS['red']
        label_pos = 'Hors budget'

    # v74.17 — figsize ratio 9:1.0 = 9 (match insertion pour zero distorsion)
    fig, ax = plt.subplots(figsize=(13.5, 1.5))
    fig.patch.set_facecolor('white')

    # Track de fond
    bar_y = 0.5
    ax.barh([bar_y], [scale_max], height=0.42, color=COLORS['grid'], edgecolor='none')
    # Coût scénario
    ax.barh([bar_y], [cost_total], height=0.42, color=bar_color, edgecolor='none')

    # Marker budget client (ligne verticale), seulement si le budget est connu
    if has_budget:
        ax.axvline(x=budget, color=COLORS['dark'], linewidth=2.5, linestyle='--', zorder=5)
        ax.text(budget, 1.02, f"Budget client\n{_format_money(budget)} FCFA",
                ha='center', va='bottom', fontsize=9.5, fontweight='bold',
                color=COLORS['dark'])

    # Marker coût scénario (texte au-dessus de la barre)
    ax.text(cost_total / 2, bar_y, f"{_format_money(cost_total)} FCFA",
            ha='center', va='center', fontsize=14, fontweight='bold',
            color='white' if (ratio > 0.4 or not has_budget) else COLORS['dark'])

    # Label position en bas à droite
    ax.text(scale_max * 0.99, 0.0, label_pos,
            ha='right', va='top', fontsize=10.5, fontweight='bold',
            color=bar_color)

    # Pourcentage du budget
    if has_budget:
        pct = ratio * 100
        ax.text(scale_max * 0.99, 0.18, f"{pct:.0f} % du budget",
                ha='right', va='top', fontsize=9, color=COLORS['muted'])

    ax.set_xlim(0, scale_max)
    ax.set_ylim(-0.1, 1.55)  # v74.16 — plus d'espace en haut pour le label budget
    ax.set_yticks([])
    ax.set_xticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)

    # v74.16 — pas de suptitle (le slide a deja un titre). Espace sup. pour le marker budget.
    fig.subplots_adjust(left=0.02, right=0.98, top=0.92, bottom=0.05)

    _save(fig, output_path)



# ═══════════════════════════════════════════════════════════════════════════════
# v13.2 — GRAPHIQUES AU FORMAT EXACT DE LEUR ZONE DANS LA SLIDE
# Chaque graphique est dessiné à la taille réelle de son emplacement (pouces) : il n'est ni étiré ni
# réduit, et ses textes ont leur vraie taille à l'écran. generate_pptx.py lit SLOTS pour les poser.
# ═══════════════════════════════════════════════════════════════════════════════
SLOTS = {
    'risk_cell':    (3.30, 2.35),   # slides 8/11/14 : radar, jauge, barres côte à côte (zone 10 × 2,35)
    'arbitrage':    (9.45, 2.62),   # slide 16
    'comparatif':   (9.50, 4.75),   # slide 15
    'cost_calc':    (9.00, 1.10),   # slides 7/10/13
    'budget_gauge': (9.00, 1.00),   # slides 7/10/13
    'timeline':     (9.50, 2.20),   # slide 19 : calendrier études + permis + travaux
    'recap_card':   (9.50, 1.30),   # slide 20
    'donut':        (4.70, 2.30),   # PPT premium : répartition des travaux par scénario
}
# Positions (pouces) des graphiques posés hors emplacement du modèle
SLOT_POS = {
    'comparatif':   (0.25, 0.45),
    'cost_calc':    (0.50, 3.00),
    'budget_gauge': (0.50, 4.40),
    'timeline':     (0.25, 3.15),
    'recap_card':   (0.25, 4.00),
}
BRAND_GREEN = '#1F5E55'
# Libellés courts du radar (zone étroite) ; les barres voisines portent les libellés complets
RADAR_SHORT = {'budget_fit': 'Budget', 'programme_match': 'Programme', 'setback_encroachment': 'Reculs', 'cos_conformity': 'Emprise',
               'phase_flexibility': 'Phasage', 'structure_simplicity': 'Structure', 'standing_match': 'Standing'}
BRAND_PINK = '#E94B78'


def _fig(slot):
    w, h = SLOTS[slot]
    fig = plt.figure(figsize=(w, h), dpi=DPI)
    fig.patch.set_facecolor('none')
    return fig


def _save_exact(fig, path):
    """Taille exacte de la figure (pas de recadrage 'tight' qui changerait les proportions)."""
    fig.savefig(path, dpi=DPI, facecolor='none', edgecolor='none')
    plt.close(fig)


def _r(x):
    """Arrondi commercial (0,5 → au-dessus), comme Math.round côté serveur : 262 500 → 263 k partout."""
    x = float(x or 0)
    return int(x + 0.5) if x >= 0 else -int(-x + 0.5)


def _m(v):
    v = float(v or 0)
    return f"{_r(v / 1e6)} M" if v >= 1e6 else (f"{_r(v / 1e3)} k" if v >= 1e3 else f"{_r(v)}")


def _sp(n):
    return f'{_r(n):,}'.replace(',', ' ')


# ── Slides 8/11/14 : radar, jauge, barres (3,30 × 2,35 chacun) ──────────────────
def generate_radar_fit(risk_scores, label, path):
    cats = list(risk_scores.keys())
    if not cats:
        return
    vals = [risk_scores[k] for k in cats]
    labs = [RADAR_SHORT.get(k) or RISK_LABELS_FR.get(k, k).replace(chr(10), ' ') for k in cats]
    fig = _fig('risk_cell')
    ax = fig.add_axes([0.2, 0.1, 0.6, 0.7], polar=True)
    ang = np.linspace(0, 2 * np.pi, len(cats), endpoint=False).tolist()
    col = COLORS.get(label, COLORS['accent'])
    ax.fill(ang + ang[:1], vals + vals[:1], color=col, alpha=0.13)
    ax.plot(ang + ang[:1], vals + vals[:1], color=col, lw=1.6, marker='o', ms=3.5, mfc='white', mec=col, mew=1.2)
    for a, v in zip(ang, vals):
        ax.text(a, v + 12 if v < 75 else v - 17, str(int(v)), ha='center', va='center', fontsize=6, fontweight='bold', color=col,
                path_effects=[pe.withStroke(linewidth=2, foreground='white')])
    ax.set_ylim(0, 100)
    ax.set_yticks([25, 50, 75, 100])
    ax.set_yticklabels([])
    ax.set_xticks(ang)
    ax.set_xticklabels(labs, fontsize=5.8, color=COLORS['text'], fontweight='bold')
    ax.tick_params(axis='x', pad=3)
    ax.spines['polar'].set_visible(False)
    ax.grid(color=COLORS['grid'], lw=0.5)
    ax.set_facecolor('white')
    fig.text(0.5, 0.955, f'Profil des 7 critères — scénario {label}', ha='center', va='center', fontsize=7.5,
             fontweight='bold', color=COLORS['dark'])
    _save_exact(fig, path)


def generate_gauge_fit(score, label, path, recommended=False):
    pct = max(0.0, min(float(score or 0) / 100.0, 1.0))
    fig = _fig('risk_cell')
    ax = fig.add_axes([0.05, 0.02, 0.9, 0.84])
    ax.set_xlim(-1.35, 1.35)
    ax.set_ylim(-0.62, 1.12)
    ax.set_aspect('equal')
    ax.axis('off')
    n = 120
    for i in range(n):
        t = 1 - i / n
        if t < 0.5:
            r, g, b = 0x1E + (0xD4 - 0x1E) * t * 2, 0x84 + (0x85 - 0x84) * t * 2, 0x49 + (0x0E - 0x49) * t * 2
        else:
            r, g, b = 0xD4 + (0xC0 - 0xD4) * (t - 0.5) * 2, 0x85 + (0x39 - 0x85) * (t - 0.5) * 2, 0x0E + (0x2B - 0x0E) * (t - 0.5) * 2
        th = np.linspace(np.pi * (1 - i / n), np.pi * (1 - (i + 1) / n), 4)
        ax.fill(np.concatenate([1.0 * np.cos(th), 0.74 * np.cos(th[::-1])]), np.concatenate([1.0 * np.sin(th), 0.74 * np.sin(th[::-1])]),
                color=f'#{int(r):02x}{int(g):02x}{int(b):02x}', alpha=0.9, lw=0)
    na = np.pi * (1 - pct)
    ax.annotate('', xy=(0.88 * np.cos(na), 0.88 * np.sin(na)), xytext=(0, 0), arrowprops=dict(arrowstyle='-|>', color=COLORS['dark'], lw=1.8))
    ax.plot(0, 0, 'o', color=COLORS['dark'], ms=5, zorder=5)
    ax.text(0, -0.2, f'{int(round(score))}', fontsize=17, fontweight='bold', ha='center', va='center', color=COLORS['dark'])
    ax.text(0.42, -0.2, '/100', fontsize=7, ha='left', va='center', color=COLORS['muted'])
    if recommended:
        lab, lc = 'Recommandé', COLORS['green']
    elif pct >= 0.75:
        lab, lc = 'Favorable', COLORS['green']
    elif pct >= 0.6:
        lab, lc = 'Correct', COLORS['orange']
    else:
        lab, lc = 'Fragile', COLORS['red']
    ax.text(0, -0.5, lab, fontsize=7.5, fontweight='bold', ha='center', va='center', color=lc)
    ax.text(-0.87, -0.1, '0', fontsize=5.5, ha='center', color=COLORS['muted'])
    ax.text(0.87, -0.1, '100', fontsize=5.5, ha='center', color=COLORS['muted'])
    fig.text(0.5, 0.955, f'Score global — scénario {label}', ha='center', va='center', fontsize=7.5, fontweight='bold', color=COLORS['dark'])
    _save_exact(fig, path)


def generate_bars_fit(risk_scores, label, path):
    cats = list(risk_scores.keys())
    if not cats:
        return
    vals = [risk_scores[k] for k in cats]
    labs = [RISK_LABELS_FR.get(k, k).replace('\n', ' ') for k in cats]
    fig = _fig('risk_cell')
    ax = fig.add_axes([0.42, 0.05, 0.5, 0.8])
    y = np.arange(len(cats))
    cols = [_severity_color(v, scale=100) for v in vals]
    ax.barh(y, [100] * len(cats), color=COLORS['grid'], height=0.58, alpha=0.5, zorder=1)
    ax.barh(y, vals, color=cols, height=0.58, zorder=2)
    for yy, v, c in zip(y, vals, cols):
        ax.text(v + 2, yy, f'{int(v)}', va='center', fontsize=6, fontweight='bold', color=c)
    ax.set_yticks(y)
    ax.set_yticklabels(labs, fontsize=6, color=COLORS['text'])
    ax.set_xlim(0, 112)
    ax.set_xticks([])
    ax.invert_yaxis()
    for s in ('top', 'right', 'bottom'):
        ax.spines[s].set_visible(False)
    ax.spines['left'].set_color(COLORS['grid'])
    ax.tick_params(axis='y', length=0, pad=3)
    fig.text(0.5, 0.955, 'Note de chaque critère (100 = favorable)', ha='center', va='center', fontsize=7.5, fontweight='bold', color=COLORS['dark'])
    _save_exact(fig, path)


# ── Slide 16 : arbitrage — coût face à la fourchette + d'où vient le score (9,45 × 2,62) ──
CRIT_COLORS = ['#1F5E55', '#2E7D6F', '#5B8DB8', '#8B5CF6', '#D4850E', '#B07D3A', '#E94B78']


def generate_arbitrage_fit(scenarios, path):
    labels = [l for l in ['A', 'B', 'C'] if scenarios.get(l)]
    fig = _fig('arbitrage')
    W, H = SLOTS['arbitrage']
    # ─ gauche : coût des travaux de chaque scénario face à la fourchette du client ─
    ax = fig.add_axes([0.13, 0.2, 0.36, 0.62])
    costs = [float(scenarios[l].get('cost_total_fcfa', 0) or 0) for l in labels]
    needs = [float(scenarios[l].get('budget_needed_fcfa', 0) or 0) or c for l, c in zip(labels, costs)]
    bmin = max([float(scenarios[l].get('budget_min_fcfa', 0) or 0) for l in labels] + [0])
    bmax = max([float(scenarios[l].get('budget_max_fcfa', 0) or 0) for l in labels] + [0])
    xmax = max(needs + costs + [bmax * 1.15, 1]) * 1.12
    y = np.arange(len(labels))[::-1]
    if bmax:
        lo = bmin if bmin < bmax else bmax * 0.97
        ax.axvspan(lo, bmax, color='#C8E6C9', alpha=0.8, zorder=0)
        ax.text((lo + bmax) / 2, len(labels) - 0.35, f'votre fourchette\n{_m(bmin)} – {_m(bmax)}' if bmin < bmax else f'votre budget\n{_m(bmax)}',
                ha='center', va='bottom', fontsize=6.3, color=COLORS['green'], fontweight='bold')
    for yy, l, c, nd in zip(y, labels, costs, needs):
        ax.barh(yy, c, height=0.5, color=COLORS[l], zorder=2)
        ax.text(max(c, nd) + xmax * 0.015, yy, f'{_m(c)}', va='center', ha='left', fontsize=7, fontweight='bold', color=COLORS[l], zorder=3)
        if nd > c * 1.005:
            ax.plot([nd, nd], [yy - 0.32, yy + 0.32], color=COLORS['dark'], lw=1.2, zorder=4)
    ax.set_yticks(y)
    ax.set_yticklabels([f'Scénario {l}' for l in labels], fontsize=7.5, color=COLORS['text'])
    ax.set_xlim(0, xmax)
    ax.set_ylim(-0.6, len(labels) - 0.05)
    ax.set_xticks([])
    for s in ('top', 'right', 'bottom'):
        ax.spines[s].set_visible(False)
    ax.spines['left'].set_color(COLORS['grid'])
    ax.tick_params(axis='y', length=0)
    fig.text(0.28, 0.93, 'Coût des travaux face à votre fourchette', ha='center', va='center', fontsize=8.2, fontweight='bold', color=COLORS['dark'])
    fig.text(0.28, 0.07, '| trait noir : besoin avec la réserve pour imprévus du scénario', ha='center', va='center', fontsize=5.8, color=COLORS['muted'])
    # ─ droite : d'où vient le score (contribution de chaque critère, sur 100) ─
    ax2 = fig.add_axes([0.6, 0.32, 0.37, 0.5])
    parts0 = (scenarios[labels[0]].get('score_parts') or []) if labels else []
    names = [RADAR_SHORT.get(p.get('key'), p.get('label', '')) for p in parts0]   # mêmes libellés courts que le radar
    for yy, l in zip(y, labels):
        parts = scenarios[l].get('score_parts') or []
        left = 0.0
        for k, p in enumerate(parts):
            v = float(p.get('points', 0) or 0)
            if v <= 0:
                continue
            ax2.barh(yy, v, left=left, height=0.5, color=CRIT_COLORS[k % len(CRIT_COLORS)], edgecolor='white', lw=0.6)
            if v >= 7:
                ax2.text(left + v / 2, yy, f'{v:.0f}', ha='center', va='center', fontsize=5.8, color='white', fontweight='bold')
            left += v
        ax2.text(left + 1.5, yy, f'{int(round(float(scenarios[l].get("recommendation_score", 0) or 0)))}/100', va='center', ha='left',
                 fontsize=7, fontweight='bold', color=COLORS[l])
    ax2.set_yticks(y)
    ax2.set_yticklabels(labels, fontsize=7.5, fontweight='bold', color=COLORS['text'])
    ax2.set_xlim(0, 112)
    ax2.set_ylim(-0.6, len(labels) - 0.4)
    ax2.set_xticks([])
    for s in ('top', 'right', 'bottom'):
        ax2.spines[s].set_visible(False)
    ax2.spines['left'].set_color(COLORS['grid'])
    ax2.tick_params(axis='y', length=0)
    fig.text(0.785, 0.93, "D'où vient le score (points sur 100)", ha='center', va='center', fontsize=8.2, fontweight='bold', color=COLORS['dark'])
    # légende des critères sur deux lignes
    per_row = 4
    for k, nm in enumerate(names):
        r, c = divmod(k, per_row)
        x0 = 0.6 + c * 0.095
        y0 = 0.19 - r * 0.1
        fig.patches.append(mpatches.Rectangle((x0, y0 - 0.025), 0.012, 0.05, transform=fig.transFigure, color=CRIT_COLORS[k % len(CRIT_COLORS)]))
        fig.text(x0 + 0.017, y0, nm, fontsize=5.6, va='center', ha='left', color=COLORS['text'])
    _save_exact(fig, path)


# ── Slide 15 : comparatif (tableau) + surfaces par niveau (9,50 × 4,75) ─────────
LEVEL_COLORS = ['#1F5E55', '#3E8A7E', '#6FB0A4', '#A4CFC6', '#D3E9E4', '#EAF4F1']


def generate_comparatif_fit(scenarios, path):
    crit = [('Surface de plancher (SDP)', 'sdp_m2', 'm²', 'max'), ('Surface utile', 'surface_habitable_m2', 'm²', 'max'),
            ("Nombre d'unités", 'total_units', '', 'max'), ('Niveaux', 'levels', '', None),
            ('Coût des travaux', 'cost_total_fcfa', 'FCFA', 'min'), ('Coût au m² de SDP', 'cost_per_m2_sdp', 'FCFA', 'min'),
            ('Note globale', 'recommendation_score', '/100', 'max'), ('Durée des travaux', 'duree_chantier_mois', 'mois', 'min'),
            ('Délai total du projet', 'duree_projet_mois', 'mois', 'min')]
    labels = ['A', 'B', 'C']
    rows = []
    for name, key, unit, best in crit:
        vals = [(scenarios.get(l) or {}).get(key) for l in labels]
        if all(v in (None, '', 0) for v in vals):
            continue
        rows.append((name, key, unit, best, vals))
    fig = _fig('comparatif')
    W, H = SLOTS['comparatif']
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.axis('off')
    rec = next((l for l in labels if (scenarios.get(l) or {}).get('recommended')), None)
    cols_x = [0.05, 3.05, 5.2, 7.35]
    col_w = [2.95, 2.1, 2.1, 2.1]
    niv = {l: (scenarios.get(l) or {}).get('sdp_par_niveau') or [] for l in labels}
    has_levels = any(niv.values())
    table_h = H - (1.55 if has_levels else 0.45)
    top = H - 0.05
    rh = min(0.4, table_h / (len(rows) + 1))
    hdr = ['Critère'] + [f'Scénario {l}' + ('  ★' if l == rec else '') for l in labels]
    hcol = [COLORS['dark'], COLORS['A'], COLORS['B'], COLORS['C']]
    fs = 8.3 if rh >= 0.3 else 7.5
    for j in range(4):
        ax.add_patch(FancyBboxPatch((cols_x[j], top - rh), col_w[j] - 0.06, rh - 0.04, boxstyle='round,pad=0.008', fc=hcol[j], ec='none'))
        ax.text(cols_x[j] + col_w[j] / 2 - 0.03, top - rh / 2 - 0.02, hdr[j], ha='center', va='center', fontsize=fs + 0.4, fontweight='bold', color='white')
    for i, (name, key, unit, best, vals) in enumerate(rows):
        yb = top - (i + 2) * rh
        bg = 'white' if i % 2 == 0 else COLORS['light']
        nums = [(k, float(v)) for k, v in enumerate(vals) if isinstance(v, (int, float))]
        bests = set()   # toutes les valeurs les plus favorables (égalités comprises) ; aucune si tout est égal
        if best and len(nums) >= 2 and len({v for _, v in nums}) > 1:
            bv = (max if best == 'max' else min)(v for _, v in nums)
            bests = {k for k, v in nums if abs(v - bv) < 1e-9}
        ax.add_patch(FancyBboxPatch((cols_x[0], yb), col_w[0] - 0.06, rh - 0.04, boxstyle='round,pad=0.008', fc=bg, ec=COLORS['grid'], lw=0.5))
        ax.text(cols_x[0] + 0.12, yb + rh / 2 - 0.02, name, ha='left', va='center', fontsize=fs, fontweight='bold', color=COLORS['text'])
        for k, v in enumerate(vals):
            j = k + 1
            good = k in bests
            ax.add_patch(FancyBboxPatch((cols_x[j], yb), col_w[j] - 0.06, rh - 0.04, boxstyle='round,pad=0.008', fc=('#E8F5E9' if good else bg),
                                        ec=(COLORS['green'] if good else COLORS['grid']), lw=(1.0 if good else 0.5)))
            if isinstance(v, (int, float)):
                if unit == '/100':
                    txt = f'{int(round(v))}/100'
                elif unit == 'FCFA':
                    txt = (_m(v) + ' FCFA') if v >= 1e6 else f'{_sp(v)} FCFA'
                else:
                    txt = f'{_sp(v)} {unit}'.strip()
            else:
                txt = str(v if v not in (None, '') else '—')
            ax.text(cols_x[j] + col_w[j] / 2 - 0.03, yb + rh / 2 - 0.02, txt, ha='center', va='center', fontsize=fs,
                    fontweight=('bold' if good else 'normal'), color=(COLORS['green'] if good else COLORS['text']))
    ynote = top - (len(rows) + 1) * rh - 0.1
    ax.text(cols_x[0], ynote, 'En vert : la valeur la plus favorable des trois scénarios.' + ('  ★ : scénario recommandé.' if rec else ''),
            ha='left', va='top', fontsize=6.5, color=COLORS['muted'], fontstyle='italic')
    # ─ surfaces par niveau : une barre par scénario, un segment par niveau ─
    if has_levels:
        ax.text(cols_x[0], 1.18, 'Surface de plancher par niveau', ha='left', va='center', fontsize=8.2, fontweight='bold', color=COLORS['dark'])
        tot_max = max(sum(p.get('m2', 0) for p in niv[l]) for l in labels) or 1
        x0, wmax = 1.3, W - 1.3 - 0.9
        for i, l in enumerate(labels):
            yy = 0.86 - i * 0.3
            ax.text(x0 - 0.1, yy, f'Scénario {l}', ha='right', va='center', fontsize=7.3, fontweight='bold', color=COLORS[l])
            left = x0
            for k, p in enumerate(niv[l]):
                w = wmax * float(p.get('m2', 0) or 0) / tot_max
                if w <= 0:
                    continue
                c = LEVEL_COLORS[min(k, len(LEVEL_COLORS) - 1)]
                ax.add_patch(mpatches.Rectangle((left, yy - 0.11), w, 0.22, fc=c, ec='white', lw=0.8))
                lab = f"{p.get('niveau')} · {int(p.get('m2', 0))} m²"
                if w > len(lab) * 0.052:
                    ax.text(left + w / 2, yy, lab, ha='center', va='center', fontsize=6.2, fontweight='bold', color=('white' if k < 3 else COLORS['dark']))
                elif w > 0.3:
                    ax.text(left + w / 2, yy, p.get('niveau'), ha='center', va='center', fontsize=6, fontweight='bold', color=('white' if k < 3 else COLORS['dark']))
                left += w
            ax.text(left + 0.08, yy, f"{int(sum(p.get('m2', 0) for p in niv[l]))} m²", ha='left', va='center', fontsize=7, fontweight='bold', color=COLORS['text'])
    _save_exact(fig, path)


# ── Slides 7/10/13 : calcul du coût (9,00 × 1,10) ───────────────────────────────
def generate_cost_calc_fit(sc, label, path):
    sdp = float(sc.get('sdp_m2', 0) or 0)
    total = float(sc.get('cost_total_fcfa', 0) or 0)
    cm2 = float(sc.get('cost_per_m2_sdp', 0) or 0) or (total / sdp if sdp > 0 else 0)
    acc = COLORS.get(label, COLORS['dark'])
    fig = _fig('cost_calc')
    blocks = [(0.0, 0.3, f'{_sp(sdp)}', 'm² de surface de plancher', COLORS['light'], COLORS['dark']),
              (0.35, 0.3, _m(cm2), 'FCFA / m² (raccordements compris)', COLORS['light'], COLORS['dark']),
              (0.70, 0.30, _m(total), 'FCFA de travaux', acc, 'white')]
    for x, w, big, small, fc, tc in blocks:
        ax = fig.add_axes([x + 0.005, 0.06, w - 0.01, 0.88])
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1)
        ax.set_xticks([])
        ax.set_yticks([])
        ax.set_facecolor(fc)
        for s in ax.spines.values():
            s.set_color(COLORS['grid'] if fc != acc else acc)
            s.set_linewidth(0.6)
        ax.text(0.5, 0.6, big, ha='center', va='center', fontsize=20, fontweight='bold', color=tc)
        ax.text(0.5, 0.2, small, ha='center', va='center', fontsize=7.5, color=(tc if fc == acc else COLORS['muted']))
    for x, sym in ((0.325, '×'), (0.675, '=')):
        fig.text(x, 0.5, sym, ha='center', va='center', fontsize=20, fontweight='bold', color=acc)
    _save_exact(fig, path)


# ── Slides 7/10/13 : coût face à la fourchette du client (9,00 × 1,00) ──────────
def generate_budget_range_fit(sc, label, path, budget_single=0):
    cost = float(sc.get('cost_total_fcfa', 0) or 0)
    need = float(sc.get('budget_needed_fcfa', 0) or 0) or cost
    bmin = float(sc.get('budget_min_fcfa', 0) or 0)
    bmax = float(sc.get('budget_max_fcfa', 0) or 0)
    if not bmax and budget_single:
        bmin = bmax = float(budget_single)
    fit = str(sc.get('budget_fit_label') or sc.get('budget_fit') or '')
    fig = _fig('budget_gauge')
    ax = fig.add_axes([0.02, 0.05, 0.96, 0.9])
    scale = max(bmax * 1.35, need * 1.08, cost * 1.08, 1)
    ax.set_xlim(0, scale)
    ax.set_ylim(0, 1)
    ax.axis('off')
    y0, hb = 0.36, 0.26
    ax.add_patch(mpatches.Rectangle((0, y0), scale, hb, fc=COLORS['grid'], ec='none'))
    if bmax:
        ax.add_patch(mpatches.Rectangle((bmin if bmin < bmax else bmax * 0.9, y0 - 0.06), (bmax - bmin) if bmin < bmax else bmax * 0.1, hb + 0.12,
                                        fc='#C8E6C9', ec=COLORS['green'], lw=0.8, zorder=1))
    status = {'DANS_BUDGET': ('Dans le bas de votre fourchette', COLORS['green']),
              'BUDGET_TENDU': ('Dans le haut de votre fourchette', COLORS['orange']),
              'HORS_BUDGET': ('Au-dessus de votre fourchette', COLORS['red'])}.get(fit, ('Budget non renseigné', COLORS['muted']) if not bmax else ('', COLORS['dark']))
    col = status[1] if bmax else COLORS['dark']
    ax.add_patch(mpatches.Rectangle((0, y0 + 0.05), cost, hb - 0.1, fc=col, ec='none', zorder=2))
    ax.text(min(cost, scale) / 2, y0 + hb / 2, f'Travaux {_m(cost)} FCFA', ha='center', va='center', fontsize=8, fontweight='bold', color='white', zorder=3)
    if need > cost * 1.005:
        ax.plot([need, need], [y0 - 0.02, y0 + hb + 0.02], color=COLORS['dark'], lw=1.4, zorder=4)
        ax.text(need, y0 - 0.05, f'avec réserve : {_m(need)}', ha='center', va='top', fontsize=6.5, color=COLORS['dark'])
    if bmax:
        txt = f'Votre fourchette : {_m(bmin)} – {_m(bmax)} FCFA' if bmin < bmax else f'Votre budget : {_m(bmax)} FCFA'
        ax.text((bmin + bmax) / 2 if bmin < bmax else bmax, y0 + hb + 0.1, txt, ha='center', va='bottom', fontsize=7, fontweight='bold', color=COLORS['green'])
    ax.text(scale, 0.02, status[0], ha='right', va='bottom', fontsize=8, fontweight='bold', color=status[1])
    _save_exact(fig, path)


# ── Slide 19 : calendrier du projet — études, permis, travaux (9,50 × 2,20) ─────
def generate_timeline_fit(sc, path):
    sch = sc.get('schedule') or None
    if not sch or not sch.get('phases'):
        duree = int(sc.get('duree_chantier_mois', 12) or 12)
        sch = {'total_mois': duree, 'travaux_mois': duree, 'etudes_mois': 0, 'permis_mois': 0, 'marge_pct': 0,
               'phases': [{'nom': 'Travaux', 'groupe': 'travaux', 'mois': duree, 'debut': 1, 'fin': duree}]}
    total = int(sch['total_mois'])
    fig = _fig('timeline')
    W, H = SLOTS['timeline']
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.axis('off')
    x0, x1 = 1.55, W - 0.12
    mw = (x1 - x0) / total
    X = lambda mth: x0 + (mth - 1) * mw
    ttl = f"Calendrier du projet — environ {total} mois : {sch.get('etudes_mois', 0) + sch.get('permis_mois', 0)} mois d'études et d'autorisations, " \
          f"puis {sch.get('travaux_mois', total)} mois de travaux" + (f" (marge de {sch.get('marge_pct')} % comprise)" if sch.get('marge_pct') else '')
    ax.text(W / 2, H - 0.14, ttl, ha='center', va='center', fontsize=8.6, fontweight='bold', color=COLORS['dark'])
    # graduation des mois
    ya = H - 0.42
    step = 1 if total <= 18 else 2
    for mth in range(1, total + 1):
        ax.plot([X(mth), X(mth)], [0.34, ya - 0.06], color=COLORS['grid'], lw=0.5, zorder=0)
        if (mth - 1) % step == 0:
            ax.text(X(mth) + mw / 2, ya, f'M{mth}', ha='center', va='center', fontsize=5.8, color=COLORS['muted'])
    ax.plot([X(total + 1), X(total + 1)], [0.34, ya - 0.06], color=COLORS['grid'], lw=0.5, zorder=0)
    rows = [('etudes', 'Études et autorisations', H - 0.82), ('travaux', 'Travaux', H - 1.37)]
    colors = {'Études de conception': COLORS['dark'], 'Permis et consultation des entreprises': '#6B7280',
              'Terrassement et fondations': '#2E7D6F', 'Gros œuvre': COLORS['B'], 'Second œuvre et lots techniques': '#B07D3A',
              'Finitions, VRD et réception': COLORS['C']}
    hb = 0.42
    for grp, name, yc in rows:
        ax.text(x0 - 0.1, yc, name, ha='right', va='center', fontsize=7.4, fontweight='bold', color=COLORS['text'])
        for p in [q for q in sch['phases'] if q.get('groupe') == grp]:
            xa, w = X(p['debut']), p['mois'] * mw
            ax.add_patch(FancyBboxPatch((xa + 0.015, yc - hb / 2), w - 0.03, hb, boxstyle='round,pad=0.008', fc=colors.get(p['nom'], COLORS['accent']), ec='none', zorder=2))
            court = p.get('court') or p['nom']
            court = court[:1].upper() + court[1:]
            nm = p['nom'] if w > len(p['nom']) * 0.058 else court
            if w < len(nm) * 0.05:
                nm = nm.replace(' et ', ' et\n', 1).replace(', ', ',\n', 1)
            if w >= len(nm.split('\n')[0]) * 0.05:
                ax.text(xa + w / 2, yc, f"{nm}\n{p['mois']} mois", ha='center', va='center', fontsize=(6.3 if w > 0.9 else 5.6), fontweight='bold',
                        color='white', zorder=3, linespacing=1.05)
            else:
                # phase trop courte pour son nom : durée dans la barre, nom en dessous
                ax.text(xa + w / 2, yc, f"{p['mois']} mois", ha='center', va='center', fontsize=5.6, fontweight='bold', color='white', zorder=3)
                ax.text(xa + w / 2, yc - hb / 2 - 0.1, court, ha='center', va='center', fontsize=5.4, color=COLORS['text'], zorder=3)
    ax.text(W / 2, 0.16, '⚠ Saison des pluies (juin – octobre) : prévoir terrassement et fondations en saison sèche ; permis : 2 à 4 mois selon la commune',
            ha='center', va='center', fontsize=6.4, fontstyle='italic', color=COLORS['orange'])
    _save_exact(fig, path)


# ── Slide 20 : carte du scénario recommandé (9,50 × 1,30) ───────────────────────
def generate_recap_fit(sc, label, path):
    col = COLORS.get(label, COLORS['C'])
    proj = int(sc.get('duree_projet_mois', 0) or 0)
    trav = int(sc.get('duree_chantier_mois', 0) or 0)
    kpis = [('Surface de plancher', f"{_sp(sc.get('sdp_m2', 0) or 0)} m²"), ('Surface utile', f"{_sp(sc.get('surface_habitable_m2', 0) or 0)} m²"),
            ('Unités', f"{int(sc.get('total_units', 0) or 0)}"), ('Coût des travaux', f"{_m(sc.get('cost_total_fcfa', 0))} FCFA"),
            (f'Délai total, dont {trav} mois de travaux' if proj else 'Durée des travaux', f"{proj or trav} mois"),
            ('Note globale', f"{int(sc.get('recommendation_score', 0) or 0)}/100")]
    fig = _fig('recap_card')
    W, H = SLOTS['recap_card']
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.axis('off')
    ax.add_patch(FancyBboxPatch((0.04, 0.04), W - 0.08, H - 0.08, boxstyle='round,pad=0.02', fc=col, ec='none', alpha=0.08))
    ax.add_patch(FancyBboxPatch((0.04, H - 0.34), W - 0.08, 0.28, boxstyle='round,pad=0.02', fc=col, ec='none'))
    ax.text(W / 2, H - 0.2, f'SCÉNARIO {label} — RECOMMANDÉ', ha='center', va='center', fontsize=9.5, fontweight='bold', color='white')
    n = len(kpis)
    bw = (W - 0.3 - 0.12 * (n - 1)) / n
    for i, (lab, val) in enumerate(kpis):
        x = 0.15 + i * (bw + 0.12)
        ax.add_patch(FancyBboxPatch((x, 0.14), bw, 0.66, boxstyle='round,pad=0.02', fc='white', ec=COLORS['grid'], lw=0.6))
        ax.text(x + bw / 2, 0.55, val, ha='center', va='center', fontsize=10, fontweight='bold', color=COLORS['dark'])
        ax.text(x + bw / 2, 0.27, lab, ha='center', va='center', fontsize=(6.5 if len(lab) < 24 else 5.6), color=COLORS['muted'])
    _save_exact(fig, path)


# ── PPT premium : répartition des travaux d'un scénario (4,70 × 2,30) ───────────
def generate_cost_donut_fit(sc, label, path):
    parts = [('Gros œuvre (structure)', float(sc.get('cost_gros_oeuvre_structure', 0) or 0), COLORS['pie_go']),
             ('Finitions', float(sc.get('cost_second_oeuvre_finitions', 0) or 0), COLORS['pie_so']),
             ('Installations techniques', float(sc.get('cost_lots_techniques', 0) or 0), COLORS['pie_lt']),
             ('Raccordements et abords', float(sc.get('cost_vrd_amenagements', 0) or 0), COLORS['pie_vrd'])]
    tot = sum(v for _, v, _ in parts)
    if tot <= 0:
        return False
    W, H = SLOTS['donut']
    fig = _fig('donut')
    side = H * 0.92 / W
    ax = fig.add_axes([0.01, 0.04, side, 0.92])
    ax.pie([v for _, v, _ in parts], colors=[c for _, _, c in parts], startangle=90, counterclock=False,
           wedgeprops=dict(width=0.33, edgecolor='white', linewidth=1.6))
    ax.set_aspect('equal')
    total = float(sc.get('cost_total_fcfa', 0) or 0) or tot
    ax.text(0, 0.1, _m(total), ha='center', va='center', fontsize=14, fontweight='bold', color=COLORS['dark'])
    ax.text(0, -0.2, 'FCFA de travaux', ha='center', va='center', fontsize=5.8, color=COLORS['muted'])
    x0 = 0.01 + side + 0.05
    fig.text(x0, 0.88, 'Répartition des travaux', ha='left', va='center', fontsize=8.2, fontweight='bold', color=COLORS['dark'])
    fig.text(x0, 0.77, f'Scénario {label}', ha='left', va='center', fontsize=6.6, color=COLORS['muted'])
    for i, (nm, v, c) in enumerate(parts):
        yy = 0.6 - i * 0.155
        fig.patches.append(FancyBboxPatch((x0, yy - 0.04), 0.022, 0.08, boxstyle='round,pad=0.002', transform=fig.transFigure, fc=c, ec='none'))
        fig.text(x0 + 0.035, yy, nm, ha='left', va='center', fontsize=6.6, color=COLORS['text'])
        fig.text(0.99, yy, f'{v / tot * 100:.0f} %  ·  {_m(v)}', ha='right', va='center', fontsize=7, fontweight='bold', color=COLORS['dark'])
    fig.text(x0, 0.03, 'Montants en FCFA, raccordements extérieurs compris', ha='left', va='bottom', fontsize=5.4, color=COLORS['muted'], fontstyle='italic')
    _save_exact(fig, path)
    return True


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
            paths = generate_risk_panel(risk_scores, rec_score, label, output_dir, bool(sc.get('recommended')))
            chart_paths[f'scenario_{label}_risk_radar'] = paths['radar']
            chart_paths[f'scenario_{label}_risk_gauge'] = paths['gauge']
            chart_paths[f'scenario_{label}_risk_bars']  = paths['bars']
        else:
            print(f"[CHARTS v2.0] ATTENTION : pas de risk_scores pour "
                  f"scénario {label}", file=sys.stderr)

    # Tableau comparatif (slide 15)
    comp_path = os.path.join(output_dir, 'comparatif_table.png')
    generate_comparatif_fit(scenarios, comp_path)
    chart_paths['tableau_comparative_charts'] = comp_path

    # Graphiques d'arbitrage (slide 16)
    arb_path = os.path.join(output_dir, 'arbitrage_graphs.png')
    generate_arbitrage_fit(scenarios, arb_path)
    chart_paths['arbitrage_graph_'] = arb_path

    # Ventilation coûts (slide 17)
    rec_label = data.get('recommended_scenario') or data.get('recommended') or next((l for l in ['A', 'B', 'C'] if (scenarios.get(l) or {}).get('recommended')), 'C')
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
            generate_cost_calc_fit(sc, label, calc_path)
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
            generate_budget_range_fit(sc, label, gauge_path, budget_value)
            chart_paths[f'scenario_{label}_budget_gauge'] = gauge_path
        except Exception as e:
            print(f"[CHARTS v2.0] Erreur budget_gauge {label}: {e}", file=sys.stderr)

    # Timeline (slide 19)
    if rec_sc:
        timeline_path = os.path.join(output_dir, 'timeline.png')
        generate_timeline_fit(rec_sc, timeline_path)
        chart_paths['timeline'] = timeline_path

    # Recap card (slide 20)
    if rec_sc:
        recap_path = os.path.join(output_dir, 'recap_card.png')
        generate_recap_fit(rec_sc, rec_label, recap_path)
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
