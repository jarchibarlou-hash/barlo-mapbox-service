#!/usr/bin/env python3
"""
BARLO — Chart generation for diagnostic PPTX
Generates: radar, gauge, horizontal bars (per scenario) + comparatif table + arbitrage graphs
All charts exported as PNG for insertion into PPTX template.
"""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch
import numpy as np
import os, json, sys

# ─── BARLO color palette ───
COLORS = {
    'A': '#E74C3C',   # Rouge — scénario ambitieux
    'B': '#F39C12',   # Orange — scénario équilibré
    'C': '#27AE60',   # Vert — scénario prudent
    'dark': '#1E2761',
    'light': '#F5F7FA',
    'accent': '#2C3E50',
    'grid': '#E8ECF1',
    'text': '#2C3E50',
    'green': '#27AE60',
    'orange': '#F39C12',
    'red': '#E74C3C',
    'bg': '#FFFFFF',
}

RISK_LABELS_FR = {
    'budget_fit': 'Adéquation\nbudgétaire',
    'complexite_structurelle': 'Complexité\nstructurelle',
    'risque_permis': 'Risque\npermis',
    'ratio_efficacite': 'Ratio\nd\'efficacité',
    'densite_cos': 'Densité\nCOS',
    'phasabilite': 'Phasabilité',
    'cout_m2': 'Coût\nau m²',
}

DPI = 200


def _save(fig, path):
    fig.savefig(path, dpi=DPI, bbox_inches='tight', facecolor='white', transparent=False)
    plt.close(fig)


# ═══════════════════════════════════════════════════════════════
# 1. RADAR CHART — profil de risque par scénario
# ═══════════════════════════════════════════════════════════════
def generate_radar(risk_scores: dict, scenario_label: str, output_path: str):
    """
    risk_scores: {"budget_fit": 3, "complexite_structurelle": 4, ...} (1-5 scale)
    """
    categories = list(risk_scores.keys())
    values = [risk_scores[k] for k in categories]
    labels = [RISK_LABELS_FR.get(k, k) for k in categories]

    N = len(categories)
    angles = np.linspace(0, 2 * np.pi, N, endpoint=False).tolist()
    values += values[:1]
    angles += angles[:1]

    fig, ax = plt.subplots(figsize=(4, 4), subplot_kw=dict(polar=True))
    fig.patch.set_facecolor('white')

    color = COLORS.get(scenario_label, COLORS['accent'])

    ax.fill(angles, values, color=color, alpha=0.2)
    ax.plot(angles, values, color=color, linewidth=2.5, marker='o', markersize=6)

    ax.set_ylim(0, 5)
    ax.set_yticks([1, 2, 3, 4, 5])
    ax.set_yticklabels(['1', '2', '3', '4', '5'], fontsize=7, color='#999')
    ax.set_xticks(angles[:-1])
    ax.set_xticklabels(labels, fontsize=8, fontweight='bold', color=COLORS['text'])

    ax.spines['polar'].set_visible(False)
    ax.grid(color=COLORS['grid'], linewidth=0.8)
    ax.set_facecolor('white')

    ax.set_title(f'Profil de risque — Scénario {scenario_label}',
                 fontsize=12, fontweight='bold', color=COLORS['dark'], pad=20)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 2. GAUGE — score global de recommandation
# ═══════════════════════════════════════════════════════════════
def generate_gauge(score: float, max_score: float, scenario_label: str, output_path: str):
    """
    score: recommendation_score (0-100)
    """
    pct = min(score / max_score, 1.0) if max_score > 0 else 0

    fig, ax = plt.subplots(figsize=(4, 2.8))
    fig.patch.set_facecolor('white')
    ax.set_xlim(-1.3, 1.3)
    ax.set_ylim(-0.3, 1.3)
    ax.set_aspect('equal')
    ax.axis('off')

    # Background arc segments (green -> orange -> red)
    n_segments = 100
    for i in range(n_segments):
        t = i / n_segments
        angle = np.pi * (1 - t)
        if t < 0.4:
            c = COLORS['green']
        elif t < 0.7:
            c = COLORS['orange']
        else:
            c = COLORS['red']

        a1 = np.pi * (1 - (i / n_segments))
        a2 = np.pi * (1 - ((i + 1) / n_segments))
        theta = np.linspace(a1, a2, 5)

        for r_inner, r_outer in [(0.7, 1.0)]:
            x_outer = r_outer * np.cos(theta)
            y_outer = r_outer * np.sin(theta)
            x_inner = r_inner * np.cos(theta[::-1])
            y_inner = r_inner * np.sin(theta[::-1])
            ax.fill(np.concatenate([x_outer, x_inner]),
                    np.concatenate([y_outer, y_inner]),
                    color=c, alpha=0.8)

    # Needle
    needle_angle = np.pi * (1 - pct)
    nx = 0.9 * np.cos(needle_angle)
    ny = 0.9 * np.sin(needle_angle)
    ax.annotate('', xy=(nx, ny), xytext=(0, 0),
                arrowprops=dict(arrowstyle='->', color=COLORS['dark'], lw=2.5))
    ax.plot(0, 0, 'o', color=COLORS['dark'], markersize=8, zorder=5)

    # Score text
    ax.text(0, -0.15, f'{int(score)}/100', fontsize=20, fontweight='bold',
            ha='center', va='center', color=COLORS['dark'])

    # Label
    if pct >= 0.7:
        label = 'Recommandé'
        lcolor = COLORS['green']
    elif pct >= 0.4:
        label = 'Acceptable'
        lcolor = COLORS['orange']
    else:
        label = 'Risqué'
        lcolor = COLORS['red']

    ax.text(0, -0.35, label, fontsize=11, fontweight='bold',
            ha='center', va='center', color=lcolor)

    ax.set_title(f'Score global — Scénario {scenario_label}',
                 fontsize=12, fontweight='bold', color=COLORS['dark'], pad=10)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 3. HORIZONTAL BARS — facteurs de risque
# ═══════════════════════════════════════════════════════════════
def generate_risk_bars(risk_scores: dict, scenario_label: str, output_path: str):
    """
    Horizontal bar chart with color-coded severity (1-2 green, 3 orange, 4-5 red)
    """
    categories = list(risk_scores.keys())
    values = [risk_scores[k] for k in categories]
    labels = [RISK_LABELS_FR.get(k, k).replace('\n', ' ') for k in categories]

    colors = []
    for v in values:
        if v <= 2:
            colors.append(COLORS['green'])
        elif v <= 3:
            colors.append(COLORS['orange'])
        else:
            colors.append(COLORS['red'])

    fig, ax = plt.subplots(figsize=(4.5, 3.5))
    fig.patch.set_facecolor('white')

    y_pos = np.arange(len(categories))
    bars = ax.barh(y_pos, values, color=colors, height=0.6, edgecolor='white', linewidth=0.5)

    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels, fontsize=9, color=COLORS['text'])
    ax.set_xlim(0, 5.5)
    ax.set_xticks([1, 2, 3, 4, 5])
    ax.set_xticklabels(['1', '2', '3', '4', '5'], fontsize=8, color='#999')

    # Value labels
    for bar, v in zip(bars, values):
        ax.text(bar.get_width() + 0.15, bar.get_y() + bar.get_height()/2,
                f'{v}/5', va='center', fontsize=9, fontweight='bold', color=COLORS['text'])

    ax.invert_yaxis()
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['bottom'].set_color(COLORS['grid'])
    ax.spines['left'].set_color(COLORS['grid'])
    ax.grid(axis='x', color=COLORS['grid'], linewidth=0.5)

    ax.set_title(f'Facteurs de risque — Scénario {scenario_label}',
                 fontsize=12, fontweight='bold', color=COLORS['dark'], pad=15)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 4. COMPARATIF TABLE — slide 15
# ═══════════════════════════════════════════════════════════════
def generate_comparatif_table(scenarios: dict, output_path: str):
    """
    Generates a visual comparison table as an image.
    scenarios: {"A": {...}, "B": {...}, "C": {...}}
    """
    criteria = [
        ('SDP (m²)', 'sdp_m2'),
        ('Surface habitable (m²)', 'surface_habitable_m2'),
        ('Efficacité (%)', 'ratio_efficacite_pct'),
        ('Nombre d\'unités', 'total_units'),
        ('Niveaux', 'levels'),
        ('Coût total (FCFA)', 'cost_total_fcfa'),
        ('Coût/m² SDP', 'cost_per_m2_sdp'),
        ('Score recommandation', 'recommendation_score'),
        ('Durée chantier (mois)', 'duree_chantier_mois'),
    ]

    labels_order = ['A', 'B', 'C']
    n_rows = len(criteria)
    n_cols = 4  # Critère + A + B + C

    fig, ax = plt.subplots(figsize=(10, 0.6 * n_rows + 1.2))
    fig.patch.set_facecolor('white')
    ax.axis('off')

    # Header
    col_widths = [0.32, 0.22, 0.22, 0.22]
    col_x = [0]
    for w in col_widths[:-1]:
        col_x.append(col_x[-1] + w)

    header_y = 1.0 - (0.8 / (n_rows + 1))
    row_h = 0.8 / (n_rows + 1)

    # Draw header
    headers = ['Critère', 'Scénario A', 'Scénario B', 'Scénario C']
    header_colors = [COLORS['dark'], COLORS['A'], COLORS['B'], COLORS['C']]

    for j, (hdr, hcol) in enumerate(zip(headers, header_colors)):
        rect = FancyBboxPatch((col_x[j], header_y), col_widths[j] - 0.005, row_h * 0.9,
                              boxstyle="round,pad=0.005", facecolor=hcol, edgecolor='white', linewidth=1)
        ax.add_patch(rect)
        ax.text(col_x[j] + col_widths[j] / 2, header_y + row_h * 0.45,
                hdr, ha='center', va='center', fontsize=10, fontweight='bold', color='white')

    # Draw rows
    for i, (crit_name, crit_key) in enumerate(criteria):
        y = header_y - (i + 1) * row_h
        bg = 'white' if i % 2 == 0 else COLORS['light']

        # Criteria label
        rect = FancyBboxPatch((col_x[0], y), col_widths[0] - 0.005, row_h * 0.9,
                              boxstyle="round,pad=0.005", facecolor=bg, edgecolor=COLORS['grid'], linewidth=0.5)
        ax.add_patch(rect)
        ax.text(col_x[0] + 0.01, y + row_h * 0.45, crit_name,
                ha='left', va='center', fontsize=9, fontweight='bold', color=COLORS['text'])

        # Values for A, B, C
        vals = []
        for label in labels_order:
            sc = scenarios.get(label, {})
            v = sc.get(crit_key, '-')
            vals.append(v)

        # Find best value for highlighting
        numeric_vals = [(idx, v) for idx, v in enumerate(vals) if isinstance(v, (int, float))]
        best_idx = None
        if numeric_vals and crit_key in ('recommendation_score', 'surface_habitable_m2', 'ratio_efficacite_pct', 'total_units'):
            best_idx = max(numeric_vals, key=lambda x: x[1])[0]
        elif numeric_vals and crit_key in ('cost_total_fcfa', 'cost_per_m2_sdp', 'duree_chantier_mois'):
            best_idx = min(numeric_vals, key=lambda x: x[1])[0]

        for j, (label, v) in enumerate(zip(labels_order, vals)):
            col_idx = j + 1
            is_best = (j == best_idx) if best_idx is not None else False
            cell_bg = '#E8F5E9' if is_best else bg

            rect = FancyBboxPatch((col_x[col_idx], y), col_widths[col_idx] - 0.005, row_h * 0.9,
                                  boxstyle="round,pad=0.005", facecolor=cell_bg, edgecolor=COLORS['grid'], linewidth=0.5)
            ax.add_patch(rect)

            # Format value
            if isinstance(v, (int, float)):
                if crit_key in ('cost_total_fcfa',):
                    txt = f'{v:,.0f}'.replace(',', ' ')
                elif crit_key in ('cost_per_m2_sdp',):
                    txt = f'{v:,.0f}'.replace(',', ' ')
                else:
                    txt = str(int(v)) if v == int(v) else f'{v:.1f}'
            else:
                txt = str(v)

            fw = 'bold' if is_best else 'normal'
            ax.text(col_x[col_idx] + col_widths[col_idx] / 2, y + row_h * 0.45,
                    txt, ha='center', va='center', fontsize=9, fontweight=fw, color=COLORS['text'])

    ax.set_xlim(-0.02, 1.02)
    ax.set_ylim(header_y - n_rows * row_h - 0.02, header_y + row_h + 0.02)

    ax.set_title('Comparatif stratégique — Scénarios A / B / C',
                 fontsize=14, fontweight='bold', color=COLORS['dark'], pad=15)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 5. ARBITRAGE GRAPHS — slide 16 (4 mini-charts)
# ═══════════════════════════════════════════════════════════════
def generate_arbitrage_graphs(scenarios: dict, output_path: str):
    """
    4 grouped bar charts: prix, surface, unités, standing
    """
    labels = ['A', 'B', 'C']
    colors = [COLORS['A'], COLORS['B'], COLORS['C']]

    criteria = [
        ('Coût total (M FCFA)', 'cost_total_fcfa', 1_000_000, 'M'),
        ('Surface habitable (m²)', 'surface_habitable_m2', 1, 'm²'),
        ('Nombre d\'unités', 'total_units', 1, ''),
        ('Score recommandation', 'recommendation_score', 1, '/100'),
    ]

    fig, axes = plt.subplots(1, 4, figsize=(14, 3.5))
    fig.patch.set_facecolor('white')

    for idx, (title, key, divisor, suffix) in enumerate(criteria):
        ax = axes[idx]
        vals = [scenarios.get(l, {}).get(key, 0) / divisor for l in labels]

        bars = ax.bar(labels, vals, color=colors, width=0.6, edgecolor='white', linewidth=1)

        for bar, v in zip(bars, vals):
            fmt = f'{v:.0f}{suffix}' if divisor > 1 else f'{int(v)}{suffix}'
            ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + max(vals)*0.03,
                    fmt, ha='center', va='bottom', fontsize=9, fontweight='bold', color=COLORS['text'])

        ax.set_title(title, fontsize=10, fontweight='bold', color=COLORS['dark'], pad=10)
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.spines['left'].set_color(COLORS['grid'])
        ax.spines['bottom'].set_color(COLORS['grid'])
        ax.tick_params(colors=COLORS['text'], labelsize=9)
        ax.set_ylim(0, max(vals) * 1.25 if max(vals) > 0 else 1)
        ax.yaxis.set_visible(False)

    fig.suptitle('Critères d\'arbitrage stratégique', fontsize=13,
                 fontweight='bold', color=COLORS['dark'], y=1.02)
    plt.tight_layout()

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 6. COST BREAKDOWN PIE — camembert ventilation des coûts (slide 17)
# ═══════════════════════════════════════════════════════════════
def generate_cost_breakdown(scenario: dict, output_path: str):
    """
    Pie chart showing cost breakdown for the recommended scenario.
    """
    labels = [
        'Fondations &\ninfrastructure',
        'Gros œuvre &\nstructure',
        'Second œuvre &\nfinitions',
        'VRD &\naménagements',
    ]
    sizes = [20, 35, 30, 15]
    colors_pie = ['#1E2761', '#2C7873', '#F39C12', '#E74C3C']
    explode = (0.03, 0.03, 0.03, 0.03)

    cost_total = scenario.get('cost_total_fcfa', 100000000)

    fig, ax = plt.subplots(figsize=(5, 4))
    fig.patch.set_facecolor('white')

    wedges, texts, autotexts = ax.pie(
        sizes, labels=labels, autopct='%1.0f%%', explode=explode,
        colors=colors_pie, startangle=90, textprops={'fontsize': 9},
        pctdistance=0.75, labeldistance=1.15,
        wedgeprops={'edgecolor': 'white', 'linewidth': 2}
    )

    for t in autotexts:
        t.set_fontweight('bold')
        t.set_color('white')
        t.set_fontsize(10)

    # Add cost values as annotation
    for i, (wedge, pct) in enumerate(zip(wedges, sizes)):
        cost_val = cost_total * pct / 100
        angle = (wedge.theta2 + wedge.theta1) / 2
        x = 0.5 * np.cos(np.radians(angle))
        y = 0.5 * np.sin(np.radians(angle))

    centre_circle = plt.Circle((0, 0), 0.45, fc='white', ec=COLORS['grid'], linewidth=1)
    ax.add_artist(centre_circle)

    # Center text
    ax.text(0, 0.05, f'{cost_total / 1_000_000:.0f} M', fontsize=16, fontweight='bold',
            ha='center', va='center', color=COLORS['dark'])
    ax.text(0, -0.12, 'FCFA', fontsize=10, ha='center', va='center', color=COLORS['text'])

    ax.set_title('Ventilation des coûts de construction',
                 fontsize=12, fontweight='bold', color=COLORS['dark'], pad=15)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 7. TIMELINE — phasage chantier (slide 19)
# ═══════════════════════════════════════════════════════════════
def generate_timeline(scenario: dict, output_path: str):
    """
    Horizontal timeline showing construction phases.
    """
    phases = [
        ('Études &\nPermis', 3, COLORS['dark']),
        ('Terrassement &\nFondations', 2, '#2C7873'),
        ('Gros\nœuvre', 4, COLORS['B']),
        ('Second\nœuvre', 3, '#E67E22'),
        ('Finitions &\nRéception', 1, COLORS['C']),
    ]

    total_months = sum(p[1] for p in phases)
    duree = scenario.get('duree_chantier_mois', total_months)

    fig, ax = plt.subplots(figsize=(12, 3))
    fig.patch.set_facecolor('white')

    x = 0
    bar_height = 0.5
    y_center = 0.5

    for label, months, color in phases:
        width = months / total_months
        rect = mpatches.FancyBboxPatch(
            (x, y_center - bar_height / 2), width - 0.005, bar_height,
            boxstyle="round,pad=0.01", facecolor=color, edgecolor='white', linewidth=2
        )
        ax.add_patch(rect)

        # Phase label
        ax.text(x + width / 2, y_center + 0.05, label,
                ha='center', va='center', fontsize=10, fontweight='bold', color='white')

        # Month count below
        ax.text(x + width / 2, y_center - bar_height / 2 - 0.12,
                f'{months} mois', ha='center', va='top', fontsize=9, color=COLORS['text'])

        # Month markers above
        ax.text(x + 0.005, y_center + bar_height / 2 + 0.08,
                f'M{int(x * total_months) + 1}', ha='left', va='bottom',
                fontsize=7, color='#999')

        x += width

    # End marker
    ax.text(1.0, y_center + bar_height / 2 + 0.08,
            f'M{total_months}', ha='right', va='bottom', fontsize=7, color='#999')

    ax.set_xlim(-0.02, 1.02)
    ax.set_ylim(-0.1, 1.1)
    ax.axis('off')

    ax.set_title(f'Phasage du chantier — Durée estimée : {duree} mois',
                 fontsize=13, fontweight='bold', color=COLORS['dark'], pad=20)

    # Rain season warning
    ax.text(0.5, -0.05, '⚠ Saison des pluies (juin–octobre) : éviter terrassement et fondations',
            ha='center', va='top', fontsize=9, fontstyle='italic', color=COLORS['orange'])

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 8. RECAP CARD — mini-fiche scénario recommandé (slide 20)
# ═══════════════════════════════════════════════════════════════
def generate_recap_card(scenario: dict, label: str, output_path: str):
    """
    Visual summary card for the recommended scenario.
    """
    fig, ax = plt.subplots(figsize=(10, 3))
    fig.patch.set_facecolor('white')
    ax.axis('off')

    color = COLORS.get(label, COLORS['C'])

    # Main card background
    card = mpatches.FancyBboxPatch(
        (0.02, 0.1), 0.96, 0.8,
        boxstyle="round,pad=0.02", facecolor=color, edgecolor='white', linewidth=0, alpha=0.1
    )
    ax.add_patch(card)

    # Top accent bar
    accent = mpatches.FancyBboxPatch(
        (0.02, 0.82), 0.96, 0.08,
        boxstyle="round,pad=0.01", facecolor=color, edgecolor='none'
    )
    ax.add_patch(accent)
    ax.text(0.5, 0.86, f'SCÉNARIO {label} — RECOMMANDÉ', ha='center', va='center',
            fontsize=14, fontweight='bold', color='white')

    # KPI boxes
    kpis = [
        ('SDP', f'{scenario.get("sdp_m2", 0)} m²'),
        ('Surface\nhabitable', f'{scenario.get("surface_habitable_m2", 0)} m²'),
        ('Unités', f'{scenario.get("total_units", 0)}'),
        ('Coût\nestimé', f'{scenario.get("cost_total_fcfa", 0) / 1_000_000:.0f} M FCFA'),
        ('Durée\nchantier', f'{scenario.get("duree_chantier_mois", 0)} mois'),
        ('Score', f'{scenario.get("recommendation_score", 0)}/100'),
    ]

    n = len(kpis)
    box_w = 0.14
    gap = (0.92 - n * box_w) / (n + 1)

    for i, (kpi_label, kpi_value) in enumerate(kpis):
        x = 0.04 + gap + i * (box_w + gap)
        y = 0.25

        # KPI box
        kpi_box = mpatches.FancyBboxPatch(
            (x, y), box_w, 0.5,
            boxstyle="round,pad=0.015", facecolor='white', edgecolor=COLORS['grid'], linewidth=1
        )
        ax.add_patch(kpi_box)

        # Value (big)
        ax.text(x + box_w / 2, y + 0.35, kpi_value,
                ha='center', va='center', fontsize=13, fontweight='bold', color=COLORS['dark'])

        # Label (small)
        ax.text(x + box_w / 2, y + 0.1, kpi_label,
                ha='center', va='center', fontsize=8, color='#777')

    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)

    _save(fig, output_path)


# ═══════════════════════════════════════════════════════════════
# 9. COMBINED RISK PANEL — 3 charts side by side for one scenario
# ═══════════════════════════════════════════════════════════════
def generate_risk_panel(risk_scores: dict, recommendation_score: float,
                        scenario_label: str, output_dir: str):
    """
    Generates 3 separate PNGs: radar, gauge, bars
    Returns dict of paths.
    """
    radar_path = os.path.join(output_dir, f'risk_radar_{scenario_label}.png')
    gauge_path = os.path.join(output_dir, f'risk_gauge_{scenario_label}.png')
    bars_path = os.path.join(output_dir, f'risk_bars_{scenario_label}.png')

    generate_radar(risk_scores, scenario_label, radar_path)
    generate_gauge(recommendation_score, 100, scenario_label, gauge_path)
    generate_risk_bars(risk_scores, scenario_label, bars_path)

    return {'radar': radar_path, 'gauge': gauge_path, 'bars': bars_path}


# ═══════════════════════════════════════════════════════════════
# MAIN — generate all charts from JSON input
# ═══════════════════════════════════════════════════════════════
def generate_all_charts(data: dict, output_dir: str) -> dict:
    """
    data: full /generate-pptx JSON payload
    Returns dict mapping placeholder keys to image file paths.
    """
    os.makedirs(output_dir, exist_ok=True)
    chart_paths = {}

    scenarios = data.get('scenarios', {})

    # Per-scenario risk panels (slides 8, 11, 14)
    for label in ['A', 'B', 'C']:
        sc = scenarios.get(label, {})
        risk_scores = sc.get('risk_scores', {})
        rec_score = sc.get('recommendation_score', 50)

        if risk_scores:
            paths = generate_risk_panel(risk_scores, rec_score, label, output_dir)
            chart_paths[f'scenario_{label}_risk_radar'] = paths['radar']
            chart_paths[f'scenario_{label}_risk_gauge'] = paths['gauge']
            chart_paths[f'scenario_{label}_risk_bars'] = paths['bars']

    # Comparatif table (slide 15)
    comp_path = os.path.join(output_dir, 'comparatif_table.png')
    generate_comparatif_table(scenarios, comp_path)
    chart_paths['tableau_comparative_charts'] = comp_path

    # Arbitrage graphs (slide 16)
    arb_path = os.path.join(output_dir, 'arbitrage_graphs.png')
    generate_arbitrage_graphs(scenarios, arb_path)
    chart_paths['arbitrage_graph_'] = arb_path

    # Cost breakdown pie (slide 17)
    rec_label = data.get('recommended_scenario', 'C')
    rec_sc = scenarios.get(rec_label, {})
    if rec_sc:
        pie_path = os.path.join(output_dir, 'cost_breakdown.png')
        generate_cost_breakdown(rec_sc, pie_path)
        chart_paths['cost_breakdown'] = pie_path

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

    return chart_paths


# ═══════════════════════════════════════════════════════════════
# CLI entry point
# ═══════════════════════════════════════════════════════════════
if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python generate_charts.py <input.json> <output_dir>")
        sys.exit(1)

    with open(sys.argv[1], 'r') as f:
        data = json.load(f)

    output_dir = sys.argv[2]
    paths = generate_all_charts(data, output_dir)

    # Output paths as JSON for Node.js to consume
    print(json.dumps(paths, indent=2))
