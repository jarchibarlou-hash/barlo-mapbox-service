#!/usr/bin/env python3
"""
BARLO -- Chart generation for diagnostic PPTX -- v3.0 PREMIUM
Generates: radar, gauge, horizontal bars (per scenario) + comparatif table + arbitrage + cost pie + timeline + recap card
All charts calibrated to match reference output exactly.
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, Wedge
import numpy as np
import os, json, sys, math

# Font consistency
plt.rcParams['font.family'] = 'DejaVu Sans'
plt.rcParams['axes.unicode_minus'] = False

# --- BARLO color palette ---
COLORS = {
    'A': '#E74C3C',
    'B': '#F39C12',
    'C': '#27AE60',
    'dark': '#1E2761',
    'light': '#F5F7FA',
    'accent': '#2C3E50',
    'grid': '#E8ECF1',
    'text': '#2C3E50',
    'green': '#27AE60',
    'orange': '#F39C12',
    'red': '#E74C3C',
    'teal': '#2C7873',
    'bg': '#FFFFFF',
    'header_blue': '#1B3A5C',
}

RISK_LABELS_FR = {
    'budget_fit': 'Adéquation\nbudgétaire',
    'complexite_structurelle': 'Complexité\nstructurelle',
    'risque_permis': 'Risque\npermis',
    'ratio_efficacite': "Ratio\nd'efficacité",
    'densite_cos': 'Densité\nCOS',
    'phasabilite': 'Phasabilité',
    'cout_m2': 'Coût\nau m²',
}

RISK_LABELS_SINGLE = {
    'budget_fit': 'Adéquation budgétaire',
    'complexite_structurelle': 'Complexité structurelle',
    'risque_permis': 'Risque permis',
    'ratio_efficacite': "Ratio d'efficacité",
    'densite_cos': 'Densité COS',
    'phasabilite': 'Phasabilité',
    'cout_m2': 'Coût au m²',
}

RISK_METRICS_ORDER = ['budget_fit', 'complexite_structurelle', 'risque_permis',
                      'ratio_efficacite', 'densite_cos', 'phasabilite', 'cout_m2']

DPI = 300

def _save(fig, path):
    fig.savefig(path, dpi=DPI, bbox_inches='tight', facecolor='white', transparent=False)
    plt.close(fig)

def _score_to_5(val):
    """Convert 0-100 score to 1-5 scale."""
    return max(1, min(5, round(val / 20)))

def _score_color(val_5):
    """Color based on /5 score: 1-2=red, 3=orange, 4-5=green."""
    if val_5 <= 2:
        return COLORS['red']
    elif val_5 == 3:
        return COLORS['orange']
    else:
        return COLORS['green']


# ===============================================================
# RADAR CHART -- Profil de risque
# ===============================================================
def generate_risk_radar(scenario_data, scenario_key, output_path):
    fig, ax = plt.subplots(figsize=(8, 8), subplot_kw=dict(projection='polar'))

    metrics = RISK_METRICS_ORDER
    values_100 = [scenario_data.get(m, 50) for m in metrics]
    values_5 = [_score_to_5(v) for v in values_100]

    angles = np.linspace(0, 2 * np.pi, len(metrics), endpoint=False).tolist()
    values_5_closed = values_5 + values_5[:1]
    angles_closed = angles + angles[:1]

    color = COLORS[scenario_key]

    # Background circles at 1,2,3,4,5
    for r in [1, 2, 3, 4, 5]:
        circle_angles = np.linspace(0, 2 * np.pi, 100)
        ax.plot(circle_angles, [r]*100, '-', color=COLORS['grid'], linewidth=0.5, alpha=0.6)

    ax.plot(angles_closed, values_5_closed, 'o-', linewidth=2.5, color=color, markersize=7, zorder=5)
    ax.fill(angles_closed, values_5_closed, alpha=0.2, color=color, zorder=4)

    ax.set_xticks(angles)
    ax.set_xticklabels([RISK_LABELS_FR[m] for m in metrics], size=9, weight='bold',
                       color=COLORS['dark'])
    ax.set_ylim(0, 5.5)
    ax.set_yticks([1, 2, 3, 4, 5])
    ax.set_yticklabels(['1', '2', '3', '4', '5'], size=8, color=COLORS['text'], alpha=0.7)
    ax.grid(True, color=COLORS['grid'], alpha=0.4)

    ax.set_title(f'Profil de risque -- Scénario {scenario_key}',
                 fontsize=13, weight='bold', color=COLORS['dark'], pad=20)

    ax.set_facecolor(COLORS['bg'])
    fig.patch.set_facecolor(COLORS['bg'])
    plt.tight_layout()
    _save(fig, output_path)


# ===============================================================
# GAUGE CHART -- Score global (segmented arc)
# ===============================================================
def generate_gauge(score, scenario_key, output_path, is_recommended=False):
    fig, ax = plt.subplots(figsize=(8, 5.5))

    # Draw segmented arc from 180° (left/red) to 0° (right/green)
    n_segments = 20
    segment_angle = 180 / n_segments

    for i in range(n_segments):
        start_angle = 180 - (i + 1) * segment_angle
        # Color gradient: red → orange → green
        frac = i / (n_segments - 1)
        if frac < 0.35:
            r, g, b = 231, 76, 60      # red
        elif frac < 0.5:
            r, g, b = 243, 156, 18     # orange
        elif frac < 0.65:
            r, g, b = 241, 196, 15     # yellow-orange
        else:
            r, g, b = 39, 174, 96      # green
        color = (r/255, g/255, b/255)

        wedge = Wedge(center=(0, 0), r=0.95, theta1=start_angle, theta2=start_angle + segment_angle - 1,
                      width=0.25, facecolor=color, edgecolor='white', linewidth=1.5)
        ax.add_patch(wedge)

    # Needle
    t = score / 100.0
    angle_rad = math.radians(180 - t * 180)
    needle_length = 0.65
    nx = needle_length * math.cos(angle_rad)
    ny = needle_length * math.sin(angle_rad)
    ax.plot([0, nx], [0, ny], '-', linewidth=3, color=COLORS['dark'], solid_capstyle='round', zorder=10)

    # Center dot
    circle = plt.Circle((0, 0), 0.06, color=COLORS['dark'], zorder=11)
    ax.add_patch(circle)

    # Score text
    ax.text(0, -0.35, f'{int(score)}/100', fontsize=36, weight='bold', ha='center',
            va='center', color=COLORS['dark'])

    # "Recommandé" label ONLY for the actual recommended scenario
    if is_recommended:
        ax.text(0, -0.55, 'Recommandé', fontsize=16, weight='bold', ha='center',
                va='center', color=COLORS['green'])

    # Title
    ax.set_title(f'Score global -- Scénario {scenario_key}',
                 fontsize=14, weight='bold', color=COLORS['dark'], pad=15)

    ax.set_xlim(-1.3, 1.3)
    ax.set_ylim(-0.75, 1.15)
    ax.set_aspect('equal')
    ax.axis('off')
    fig.patch.set_facecolor(COLORS['bg'])
    plt.tight_layout()
    _save(fig, output_path)


# ===============================================================
# HORIZONTAL BARS -- Facteurs de risque (scored /5)
# ===============================================================
def generate_horizontal_bars(scenario_data, scenario_key, output_path):
    fig, ax = plt.subplots(figsize=(9, 6))

    metrics = RISK_METRICS_ORDER
    values_100 = [scenario_data.get(m, 50) for m in metrics]
    values_5 = [_score_to_5(v) for v in values_100]
    labels = [RISK_LABELS_SINGLE[m] for m in metrics]

    y_pos = np.arange(len(labels))

    # Draw background tracks (gray, 0 to 5)
    for y in y_pos:
        ax.barh(y, 5, color=COLORS['grid'], alpha=0.3, height=0.55, left=0)

    # Draw score bars with color coding
    for y, val5 in zip(y_pos, values_5):
        color = _score_color(val5)
        ax.barh(y, val5, color=color, alpha=0.85, height=0.55, left=0,
                edgecolor='white', linewidth=1)
        # Score label
        ax.text(val5 + 0.15, y, f'{val5}/5', va='center', fontsize=11,
                weight='bold', color=COLORS['dark'])

    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels, fontsize=10, weight='bold', color=COLORS['dark'])
    ax.set_xlim(0, 6)
    ax.set_xticks([1, 2, 3, 4, 5])
    ax.set_xticklabels(['1', '2', '3', '4', '5'], fontsize=9)
    ax.invert_yaxis()

    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['bottom'].set_visible(False)
    ax.tick_params(bottom=False)
    ax.set_facecolor(COLORS['bg'])
    fig.patch.set_facecolor(COLORS['bg'])

    ax.set_title(f'Facteurs de risque -- Scénario {scenario_key}',
                 fontsize=13, weight='bold', color=COLORS['dark'], pad=12)

    plt.tight_layout()
    _save(fig, output_path)


# ===============================================================
# COMPARATIVE TABLE -- Tableau stratégique global
# ===============================================================
def generate_comparative_table(scenarios_full, output_path):
    """
    Professional table comparing project KPIs across scenarios.
    scenarios_full: dict with keys 'A','B','C' each containing full scenario data.
    """
    fig, ax = plt.subplots(figsize=(14, 8))
    ax.axis('off')

    # Headers
    headers = ['Critère', 'Scénario A', 'Scénario B', 'Scénario C']
    header_colors = [COLORS['header_blue'], COLORS['A'], COLORS['B'], COLORS['C']]

    def _fmt(val, fmt_type='int'):
        if val is None or val == 'N/A' or val == '--' or val == '':
            return '--'
        try:
            if fmt_type == 'money':
                return f"{int(float(val)):,}".replace(',', ' ')
            if fmt_type == 'int':
                return str(int(float(val)))
        except (ValueError, TypeError):
            return str(val)
        return str(val)

    # Build rows from real project data
    sA = scenarios_full.get('A', {})
    sB = scenarios_full.get('B', {})
    sC = scenarios_full.get('C', {})

    rows = [
        ('SDP (m²)',
         _fmt(sA.get('sdp_m2', 0)),
         _fmt(sB.get('sdp_m2', 0)),
         _fmt(sC.get('sdp_m2', 0)),
         'max'),
        ('Surface habitable (m²)',
         _fmt(sA.get('surface_habitable_m2', 0)),
         _fmt(sB.get('surface_habitable_m2', 0)),
         _fmt(sC.get('surface_habitable_m2', 0)),
         'max'),
        ('Efficacité (%)',
         _fmt(round(sA.get('surface_habitable_m2', 0) / max(sA.get('sdp_m2', 1), 1) * 100)),
         _fmt(round(sB.get('surface_habitable_m2', 0) / max(sB.get('sdp_m2', 1), 1) * 100)),
         _fmt(round(sC.get('surface_habitable_m2', 0) / max(sC.get('sdp_m2', 1), 1) * 100)),
         'max'),
        ("Nombre d'unités",
         _fmt(sA.get('total_units', 0)),
         _fmt(sB.get('total_units', 0)),
         _fmt(sC.get('total_units', 0)),
         'max'),
        ('Niveaux',
         _fmt(sA.get('niveaux', sA.get('levels', '--'))),
         _fmt(sB.get('niveaux', sB.get('levels', '--'))),
         _fmt(sC.get('niveaux', sC.get('levels', '--'))),
         'none'),
        ('Coût total (FCFA)',
         _fmt(sA.get('cost_total_fcfa', 0), 'money'),
         _fmt(sB.get('cost_total_fcfa', 0), 'money'),
         _fmt(sC.get('cost_total_fcfa', 0), 'money'),
         'min'),
        ('Coût/m² SDP',
         _fmt(round(sA.get('cost_total_fcfa', 0) / max(sA.get('sdp_m2', 1), 1)), 'money'),
         _fmt(round(sB.get('cost_total_fcfa', 0) / max(sB.get('sdp_m2', 1), 1)), 'money'),
         _fmt(round(sC.get('cost_total_fcfa', 0) / max(sC.get('sdp_m2', 1), 1)), 'money'),
         'min'),
        ('Score recommandation',
         _fmt(sA.get('recommendation_score', 0)),
         _fmt(sB.get('recommendation_score', 0)),
         _fmt(sC.get('recommendation_score', 0)),
         'max'),
        ('Durée chantier (mois)',
         _fmt(sA.get('duree_chantier_mois', 0)),
         _fmt(sB.get('duree_chantier_mois', 0)),
         _fmt(sC.get('duree_chantier_mois', 0)),
         'min'),
    ]

    table_data = [[r[0], r[1], r[2], r[3]] for r in rows]

    table = ax.table(cellText=table_data, colLabels=headers, cellLoc='center', loc='center',
                     colWidths=[0.28, 0.24, 0.24, 0.24])
    table.auto_set_font_size(False)
    table.set_fontsize(12)
    table.scale(1, 2.2)

    # Style headers
    for col_idx, color in enumerate(header_colors):
        cell = table[(0, col_idx)]
        cell.set_facecolor(color)
        cell.set_text_props(weight='bold', color='white', fontsize=13)
        cell.set_edgecolor('white')
        cell.set_linewidth(2)

    # Style data rows + highlight best values
    for row_idx, row_data in enumerate(rows):
        criterion, va, vb, vc, best_rule = row_data

        # Find best column
        best_col = -1
        if best_rule in ('max', 'min'):
            try:
                vals = [float(va.replace(' ', '')), float(vb.replace(' ', '')), float(vc.replace(' ', ''))]
                if best_rule == 'max':
                    best_col = vals.index(max(vals)) + 1
                else:
                    best_col = vals.index(min(vals)) + 1
            except (ValueError, AttributeError):
                pass

        for col_idx in range(4):
            cell = table[(row_idx + 1, col_idx)]
            # Alternate row colors
            if row_idx % 2 == 0:
                cell.set_facecolor('#F8F9FA')
            else:
                cell.set_facecolor(COLORS['bg'])
            cell.set_edgecolor('#DEE2E6')
            cell.set_linewidth(0.8)

            if col_idx == 0:
                cell.set_text_props(weight='bold', color=COLORS['dark'], fontsize=11)
            elif col_idx == best_col:
                cell.set_text_props(weight='bold', color=COLORS['dark'], fontsize=12)
            else:
                cell.set_text_props(weight='normal', color=COLORS['text'], fontsize=11)

    title = 'Comparatif stratégique -- Scénarios A / B / C'
    ax.set_title(title, fontsize=16, weight='bold', color=COLORS['dark'], pad=20, y=1.02)

    fig.patch.set_facecolor(COLORS['bg'])
    plt.tight_layout()
    _save(fig, output_path)


# ===============================================================
# ARBITRAGE GRAPH -- 4 panels
# ===============================================================
def generate_arbitrage_graph(scenarios_data, output_path):
    fig, axes = plt.subplots(1, 4, figsize=(16, 5))

    keys = ['A', 'B', 'C']
    labels = ['A', 'B', 'C']
    colors_list = [COLORS[k] for k in keys]

    sA = scenarios_data.get('A', {})
    sB = scenarios_data.get('B', {})
    sC = scenarios_data.get('C', {})

    costs_m = [sA.get('cost_total_fcfa', 0)/1e6, sB.get('cost_total_fcfa', 0)/1e6, sC.get('cost_total_fcfa', 0)/1e6]
    surfaces = [sA.get('surface_habitable_m2', 0), sB.get('surface_habitable_m2', 0), sC.get('surface_habitable_m2', 0)]
    units = [sA.get('total_units', 0), sB.get('total_units', 0), sC.get('total_units', 0)]
    scores = [sA.get('recommendation_score', 0), sB.get('recommendation_score', 0), sC.get('recommendation_score', 0)]

    criteria = [
        ('Coût total (M FCFA)', costs_m, '{:.0f}M'),
        ('Surface habitable (m²)', surfaces, '{:.0f}m²'),
        ("Nombre d'unités", units, '{:.0f}'),
        ('Score recommandation', scores, '{:.0f}/100'),
    ]

    for ax, (title, values, fmt) in zip(axes, criteria):
        bars = ax.bar(labels, values, color=colors_list, alpha=0.85,
                      edgecolor=COLORS['dark'], linewidth=1.2, width=0.6)
        max_val = max(values) if max(values) > 0 else 1
        for bar, val in zip(bars, values):
            h = bar.get_height()
            ax.text(bar.get_x() + bar.get_width()/2, h + max_val*0.03,
                    fmt.format(val), ha='center', va='bottom', fontsize=10,
                    weight='bold', color=COLORS['dark'])
        ax.set_title(title, fontsize=11, weight='bold', color=COLORS['dark'], pad=10)
        ax.set_ylim(0, max_val * 1.25)
        ax.grid(axis='y', color=COLORS['grid'], alpha=0.5, linestyle='--')
        ax.set_axisbelow(True)
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.set_facecolor(COLORS['light'])
        ax.tick_params(axis='y', labelsize=9)

    fig.suptitle("Critères d'arbitrage stratégique", fontsize=14, weight='bold',
                 color=COLORS['dark'], y=0.98)
    fig.patch.set_facecolor(COLORS['bg'])
    plt.tight_layout(rect=[0, 0, 1, 0.93])
    _save(fig, output_path)


# ===============================================================
# COST BREAKDOWN PIE CHART
# ===============================================================
def generate_cost_breakdown(scenario_data, output_path):
    fig, ax = plt.subplots(figsize=(8, 8))

    cost_fondations = scenario_data.get('cost_fondations_infrastructure', None)
    cost_gros_oeuvre = scenario_data.get('cost_gros_oeuvre_structure', None)
    cost_second_oeuvre = scenario_data.get('cost_second_oeuvre_finitions', None)
    cost_vrd = scenario_data.get('cost_vrd_amenagements', None)

    if all(v is not None and v > 0 for v in [cost_fondations, cost_gros_oeuvre, cost_second_oeuvre, cost_vrd]):
        total = cost_fondations + cost_gros_oeuvre + cost_second_oeuvre + cost_vrd
        percentages = [
            (cost_fondations / total) * 100,
            (cost_gros_oeuvre / total) * 100,
            (cost_second_oeuvre / total) * 100,
            (cost_vrd / total) * 100,
        ]
    else:
        percentages = [20, 35, 30, 15]

    labels = ['Fondations &\ninfrastructure', 'Gros œuvre &\nstructure',
              'Second œuvre &\nfinitions', 'VRD &\naménagements']
    colors_pie = [COLORS['dark'], COLORS['teal'], COLORS['orange'], COLORS['red']]

    explode = (0.02, 0.02, 0.02, 0.02)
    wedges, texts, autotexts = ax.pie(
        percentages, labels=labels, colors=colors_pie, autopct='%1.0f%%',
        startangle=90, explode=explode, pctdistance=0.6,
        textprops={'fontsize': 11, 'weight': 'bold', 'color': COLORS['dark']},
        wedgeprops={'edgecolor': 'white', 'linewidth': 2}
    )
    for autotext in autotexts:
        autotext.set_color('white')
        autotext.set_weight('bold')
        autotext.set_fontsize(13)

    ax.set_title('Ventilation des coûts de construction', fontsize=14, weight='bold',
                 color=COLORS['dark'], pad=15)
    fig.patch.set_facecolor(COLORS['bg'])
    plt.tight_layout()
    _save(fig, output_path)


# ===============================================================
# TIMELINE -- Gantt chart (reference style)
# ===============================================================
def generate_timeline(scenario_data, output_path):
    fig, ax = plt.subplots(figsize=(14, 4.5))

    total_duration = scenario_data.get('duree_chantier_mois', 12)

    # 5 phases matching reference output exactly
    raw_phases = [
        ('Études &\nPermis', 3, COLORS['dark']),
        ('Terrassement &\nFondations', 2, COLORS['orange']),
        ('Gros\nœuvre', 4, COLORS['red']),
        ('Second\nœuvre', 3, COLORS['teal']),
        ('Finitions &\nRéception', 1, '#F1C40F'),
    ]

    raw_total = sum(d for _, d, _ in raw_phases)
    scale = total_duration / raw_total if raw_total > 0 else 1.0
    phases = [(name, max(1, round(dur * scale)), color) for name, dur, color in raw_phases]

    # Adjust to match total exactly
    actual_total = sum(d for _, d, _ in phases)
    diff = total_duration - actual_total
    if diff != 0:
        # Add/subtract from largest phase
        largest_idx = max(range(len(phases)), key=lambda i: phases[i][1])
        n, d, c = phases[largest_idx]
        phases[largest_idx] = (n, max(1, d + diff), c)

    # Draw bars
    cumulative = 0
    bar_height = 0.5
    y = 0

    for name, duration, color in phases:
        ax.barh(y, duration, left=cumulative, height=bar_height, color=color,
                edgecolor='white', linewidth=2, alpha=0.9)
        # Phase label inside bar
        ax.text(cumulative + duration/2, y, name, ha='center', va='center',
                fontsize=9, weight='bold', color='white', linespacing=1.2)
        # Duration label below
        ax.text(cumulative + duration/2, y - 0.4, f'{duration} mois', ha='center',
                va='center', fontsize=9, color=COLORS['dark'])
        # Month marker above
        month_label = f'M{cumulative + 1}' if cumulative == 0 else f'M{cumulative + 1}'
        ax.text(cumulative, y + 0.35, f'M{cumulative + 1}', ha='center', va='bottom',
                fontsize=8, color=COLORS['text'], alpha=0.7)
        cumulative += duration

    # End marker
    ax.text(cumulative, y + 0.35, f'M{cumulative}', ha='center', va='bottom',
            fontsize=8, color=COLORS['text'], alpha=0.7)

    # Title
    ax.set_title(f'Phasage du chantier -- Durée estimée : {total_duration} mois',
                 fontsize=13, weight='bold', color=COLORS['dark'], pad=15)

    # Warning about rainy season
    ax.text(cumulative/2, y - 0.7,
            '⚠ Saison des pluies (juin-octobre) : éviter terrassement et fondations',
            ha='center', va='center', fontsize=9, style='italic', color=COLORS['orange'])

    ax.set_xlim(-0.5, cumulative + 1)
    ax.set_ylim(-1.0, 0.8)
    ax.set_yticks([])
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['left'].set_visible(False)
    ax.spines['bottom'].set_visible(False)
    ax.tick_params(bottom=False, labelbottom=False)
    ax.set_facecolor(COLORS['bg'])
    fig.patch.set_facecolor(COLORS['bg'])

    plt.tight_layout()
    _save(fig, output_path)


# ===============================================================
# RECAP CARD -- Green banner + metrics boxes (reference style)
# ===============================================================
def generate_recap_card(scenario_data, scenario_key, output_path):
    fig, ax = plt.subplots(figsize=(14, 3.5))
    ax.axis('off')

    sdp = scenario_data.get('sdp_m2', 'N/A')
    surface_hab = scenario_data.get('surface_habitable_m2', 'N/A')
    units = scenario_data.get('total_units', 'N/A')
    cost = scenario_data.get('cost_total_fcfa', 0)
    duration = scenario_data.get('duree_chantier_mois', 'N/A')
    score = scenario_data.get('recommendation_score', 'N/A')

    cost_display = f'{int(cost/1e6)} M FCFA' if isinstance(cost, (int, float)) and cost > 0 else 'N/A'

    # Green header banner
    banner = FancyBboxPatch((0.02, 0.65), 0.96, 0.28, boxstyle="round,pad=0.01",
                            facecolor=COLORS['green'], edgecolor='none',
                            transform=ax.transAxes, zorder=2)
    ax.add_patch(banner)
    ax.text(0.5, 0.79, f'SCÉNARIO {scenario_key} -- RECOMMANDÉ',
            fontsize=20, weight='bold', ha='center', va='center',
            transform=ax.transAxes, color='white', zorder=3)

    # Metrics boxes
    metrics = [
        (f'{sdp} m²', 'SDP'),
        (f'{surface_hab} m²', 'Surface\nhabitable'),
        (str(units), 'Unités'),
        (cost_display, 'Coût\nestimé'),
        (f'{duration} mois', 'Durée\nchantier'),
        (f'{score}/100', 'Score'),
    ]

    n = len(metrics)
    box_width = 0.14
    gap = (0.96 - n * box_width) / (n + 1)
    y_center = 0.30

    for i, (value, label) in enumerate(metrics):
        x = 0.02 + gap + i * (box_width + gap)

        # Box border
        box = FancyBboxPatch((x, y_center - 0.18), box_width, 0.36,
                             boxstyle="round,pad=0.01",
                             facecolor=COLORS['bg'], edgecolor=COLORS['grid'],
                             linewidth=1.5, transform=ax.transAxes, zorder=2)
        ax.add_patch(box)

        # Value (bold, large)
        ax.text(x + box_width/2, y_center + 0.06, value,
                fontsize=16, weight='bold', ha='center', va='center',
                transform=ax.transAxes, color=COLORS['dark'], zorder=3)

        # Label (small, gray)
        ax.text(x + box_width/2, y_center - 0.10, label,
                fontsize=9, ha='center', va='center', linespacing=1.1,
                transform=ax.transAxes, color=COLORS['text'], zorder=3)

    fig.patch.set_facecolor(COLORS['bg'])
    plt.tight_layout()
    _save(fig, output_path)


# ===============================================================
# GENERATE ALL CHARTS
# ===============================================================
def generate_all_charts(scenario_data, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    chart_paths = {}

    scenarios = scenario_data.get('scenarios', {})
    recommended_key = scenario_data.get('recommended', 'A')

    # Per-scenario charts (radar, gauge, bars)
    for scenario_key in ['A', 'B', 'C']:
        scenario_info = scenarios.get(scenario_key, {})

        risk_metrics = {m: scenario_info.get(m, 50) for m in RISK_METRICS_ORDER}

        # Radar
        radar_path = os.path.join(output_dir, f'scenario_{scenario_key}_risk_radar.png')
        generate_risk_radar(risk_metrics, scenario_key, radar_path)
        chart_paths[f'scenario_{scenario_key}_risk_radar'] = radar_path

        # Gauge
        score = scenario_info.get('recommendation_score', 50)
        gauge_path = os.path.join(output_dir, f'scenario_{scenario_key}_risk_gauge.png')
        generate_gauge(score, scenario_key, gauge_path, is_recommended=(scenario_key == recommended_key))
        chart_paths[f'scenario_{scenario_key}_risk_gauge'] = gauge_path

        # Horizontal bars
        bars_path = os.path.join(output_dir, f'scenario_{scenario_key}_risk_bars.png')
        generate_horizontal_bars(risk_metrics, scenario_key, bars_path)
        chart_paths[f'scenario_{scenario_key}_risk_bars'] = bars_path

    # Comparative table (uses full project data, not just risk metrics)
    table_path = os.path.join(output_dir, 'tableau_comparative_charts.png')
    generate_comparative_table(scenarios, table_path)
    chart_paths['tableau_comparative_charts'] = table_path

    # Arbitrage graph (4-panel)
    arbitrage_path = os.path.join(output_dir, 'arbitrage_graph_.png')
    generate_arbitrage_graph(scenarios, arbitrage_path)
    chart_paths['arbitrage_graph_'] = arbitrage_path

    # Cost breakdown (recommended scenario)
    recommended_scenario = scenarios.get(recommended_key, {})
    cost_breakdown_path = os.path.join(output_dir, 'cost_breakdown.png')
    generate_cost_breakdown(recommended_scenario, cost_breakdown_path)
    chart_paths['cost_breakdown'] = cost_breakdown_path

    # Timeline (recommended scenario)
    timeline_path = os.path.join(output_dir, 'timeline.png')
    generate_timeline(recommended_scenario, timeline_path)
    chart_paths['timeline'] = timeline_path

    # Recap card (recommended scenario)
    recap_path = os.path.join(output_dir, 'recap_card.png')
    generate_recap_card(recommended_scenario, recommended_key, recap_path)
    chart_paths['recap_card'] = recap_path

    return chart_paths


if __name__ == '__main__':
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'r') as f:
            data = json.load(f)
    else:
        data = {
            'scenarios': {
                'A': {'budget_fit': 40, 'complexite_structurelle': 80, 'risque_permis': 60,
                       'ratio_efficacite': 60, 'densite_cos': 80, 'phasabilite': 40, 'cout_m2': 60,
                       'recommendation_score': 62, 'cost_total_fcfa': 156_000_000,
                       'duree_chantier_mois': 18, 'sdp_m2': 312, 'surface_habitable_m2': 239, 'total_units': 4},
                'B': {'budget_fit': 80, 'complexite_structurelle': 40, 'risque_permis': 40,
                       'ratio_efficacite': 60, 'densite_cos': 60, 'phasabilite': 60, 'cout_m2': 60,
                       'recommendation_score': 78, 'cost_total_fcfa': 130_000_000,
                       'duree_chantier_mois': 14, 'sdp_m2': 260, 'surface_habitable_m2': 199, 'total_units': 3},
                'C': {'budget_fit': 100, 'complexite_structurelle': 20, 'risque_permis': 20,
                       'ratio_efficacite': 80, 'densite_cos': 40, 'phasabilite': 100, 'cout_m2': 40,
                       'recommendation_score': 85, 'cost_total_fcfa': 100_000_000,
                       'duree_chantier_mois': 10, 'sdp_m2': 200, 'surface_habitable_m2': 153, 'total_units': 2},
            },
            'recommended': 'C',
        }
    output_dir = './charts_output'
    chart_paths = generate_all_charts(data, output_dir)
    print('Generated charts:')
    for key, path in sorted(chart_paths.items()):
        print(f'  {key}: {path}')
