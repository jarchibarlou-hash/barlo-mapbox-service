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

# Font consistency
plt.rcParams['font.family'] = 'DejaVu Sans'

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

DPI = 300

def _save(fig, path):
    fig.savefig(path, dpi=DPI, bbox_inches='tight', facecolor='white', transparent=False)
    plt.close(fig)

# ─────────────────────────────────────────────────────────────
# RADAR CHART
# ─────────────────────────────────────────────────────────────
def generate_risk_radar(scenario_data, scenario_key, output_path):
    """
    Radar chart for one scenario's risk metrics.
    scenario_data: dict with keys like 'budget_fit', 'complexite_structurelle', etc. (0–100)
    scenario_key: 'A', 'B', or 'C'
    """
    fig, ax = plt.subplots(figsize=(10, 10), subplot_kw=dict(projection='polar'))

    metrics = list(RISK_LABELS_FR.keys())
    values = [scenario_data.get(m, 50) for m in metrics]
    angles = np.linspace(0, 2 * np.pi, len(metrics), endpoint=False).tolist()
    values += values[:1]
    angles += angles[:1]

    color = COLORS[scenario_key]
    ax.plot(angles, values, 'o-', linewidth=2.5, color=color, markersize=6)
    ax.fill(angles, values, alpha=0.25, color=color)

    ax.set_xticks(angles[:-1])
    ax.set_xticklabels([RISK_LABELS_FR[m] for m in metrics], size=10, weight='bold')
    ax.set_ylim(0, 100)
    ax.set_yticks([20, 40, 60, 80, 100])
    ax.set_yticklabels(['20', '40', '60', '80', '100'], size=8, color=COLORS['text'], alpha=0.7)
    ax.grid(True, color=COLORS['grid'], alpha=0.5)

    ax.set_facecolor(COLORS['bg'])
    fig.patch.set_facecolor(COLORS['bg'])

    _save(fig, output_path)

# ─────────────────────────────────────────────────────────────
# GAUGE CHART (Arc Gauge)
# ─────────────────────────────────────────────────────────────
def generate_gauge(score, scenario_key, output_path):
    """
    Gauge chart showing a single score (0–100).
    Score positioning: LEFT (low/red) → MIDDLE (orange) → RIGHT (high/green).
    Arc goes from 180° (left) to 0° (right).
    """
    fig, ax = plt.subplots(figsize=(10, 6))

    # Normalize score to 0-1 for arc positioning
    # t=0 is left (180°), t=1 is right (0°)
    t = score / 100.0

    # Draw background arc (gray)
    theta_bg = np.linspace(np.pi, 0, 100)
    ax.plot(np.cos(theta_bg), np.sin(theta_bg), '-', linewidth=20, color='#CCCCCC', solid_capstyle='round')

    # Draw colored arc segments
    # RED: low scores (t < 0.33, left side)
    theta_red = np.linspace(np.pi, np.pi - (np.pi / 3), 50)
    ax.plot(np.cos(theta_red), np.sin(theta_red), 'o-', linewidth=20, color=COLORS['red'], solid_capstyle='round')

    # ORANGE: medium scores (0.33 <= t < 0.66, middle)
    theta_orange = np.linspace(np.pi - (np.pi / 3), np.pi - (2 * np.pi / 3), 50)
    ax.plot(np.cos(theta_orange), np.sin(theta_orange), 'o-', linewidth=20, color=COLORS['orange'], solid_capstyle='round')

    # GREEN: high scores (t >= 0.66, right side)
    theta_green = np.linspace(np.pi - (2 * np.pi / 3), 0, 50)
    ax.plot(np.cos(theta_green), np.sin(theta_green), 'o-', linewidth=20, color=COLORS['green'], solid_capstyle='round')

    # Draw needle at the score position
    angle = np.pi - (t * np.pi)
    ax.arrow(0, 0, 0.8 * np.cos(angle), 0.8 * np.sin(angle), head_width=0.1, head_length=0.1, fc=COLORS['dark'], ec=COLORS['dark'])

    # Center circle
    circle = plt.Circle((0, 0), 0.1, color=COLORS['dark'], zorder=10)
    ax.add_patch(circle)

    # Labels
    ax.text(-1.1, 0, 'Faible', fontsize=12, weight='bold', ha='center', color=COLORS['red'])
    ax.text(0, -0.4, 'Moyen', fontsize=12, weight='bold', ha='center', color=COLORS['orange'])
    ax.text(1.1, 0, 'Élevé', fontsize=12, weight='bold', ha='center', color=COLORS['green'])

    # Score display in center
    ax.text(0, -0.7, f'{int(score)}', fontsize=48, weight='bold', ha='center', color=COLORS['dark'])

    ax.set_xlim(-1.5, 1.5)
    ax.set_ylim(-1.2, 1.2)
    ax.set_aspect('equal')
    ax.axis('off')
    fig.patch.set_facecolor(COLORS['bg'])

    _save(fig, output_path)

# ─────────────────────────────────────────────────────────────
# HORIZONTAL BARS CHART
# ─────────────────────────────────────────────────────────────
def generate_horizontal_bars(scenario_data, scenario_key, output_path):
    """
    Horizontal bar chart for scenario metrics.
    scenario_data: dict with metric keys mapping to 0–100 values
    """
    fig, ax = plt.subplots(figsize=(11, 7))

    metrics = list(RISK_LABELS_FR.keys())
    values = [scenario_data.get(m, 50) for m in metrics]
    labels = [RISK_LABELS_FR[m] for m in metrics]

    color = COLORS[scenario_key]
    y_pos = np.arange(len(labels))

    bars = ax.barh(y_pos, values, color=color, alpha=0.85, edgecolor=COLORS['dark'], linewidth=1.5)

    # Add value labels on bars
    for i, (bar, val) in enumerate(zip(bars, values)):
        ax.text(val + 2, bar.get_y() + bar.get_height() / 2, f'{int(val)}',
                va='center', fontsize=11, weight='bold', color=COLORS['dark'])

    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels, fontsize=11, weight='bold')
    ax.set_xlabel('Score (0–100)', fontsize=12, weight='bold', color=COLORS['text'])
    ax.set_xlim(0, 110)
    ax.grid(axis='x', color=COLORS['grid'], alpha=0.5, linestyle='--')
    ax.set_axisbelow(True)

    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.set_facecolor(COLORS['light'])
    fig.patch.set_facecolor(COLORS['bg'])

    plt.tight_layout()
    _save(fig, output_path)

# ─────────────────────────────────────────────────────────────
# COMPARATIVE TABLE (Tableau Comparatif)
# ─────────────────────────────────────────────────────────────
def generate_comparative_table(scenarios_data, output_path):
    """
    Table comparing all three scenarios (A, B, C).
    scenarios_data: dict with keys 'A', 'B', 'C' each containing risk metric dicts
    """
    fig, ax = plt.subplots(figsize=(14, 8))
    ax.axis('tight')
    ax.axis('off')

    # Build table data
    metrics = list(RISK_LABELS_FR.keys())
    headers = ['Métrique', 'Scénario A', 'Scénario B', 'Scénario C']

    table_data = []
    for metric in metrics:
        row = [
            RISK_LABELS_FR[metric],
            f"{scenarios_data.get('A', {}).get(metric, 50):.0f}",
            f"{scenarios_data.get('B', {}).get(metric, 50):.0f}",
            f"{scenarios_data.get('C', {}).get(metric, 50):.0f}",
        ]
        table_data.append(row)

    table = ax.table(cellText=table_data, colLabels=headers, cellLoc='center', loc='center',
                     colWidths=[0.3, 0.23, 0.23, 0.23])

    table.auto_set_font_size(False)
    table.set_fontsize(11)
    table.scale(1, 2.5)

    # Header styling
    for i in range(len(headers)):
        cell = table[(0, i)]
        cell.set_facecolor(COLORS['dark'])
        cell.set_text_props(weight='bold', color='white')

    # Alternate row colors
    for i in range(1, len(table_data) + 1):
        for j in range(len(headers)):
            cell = table[(i, j)]
            if i % 2 == 0:
                cell.set_facecolor(COLORS['light'])
            else:
                cell.set_facecolor(COLORS['bg'])
            cell.set_text_props(weight='bold' if j == 0 else 'normal')

    fig.patch.set_facecolor(COLORS['bg'])
    _save(fig, output_path)

# ─────────────────────────────────────────────────────────────
# ARBITRAGE GRAPH (Cost comparison bars)
# ─────────────────────────────────────────────────────────────
def generate_arbitrage_graph(scenarios_data, output_path):
    """
    4-panel bar chart comparing key criteria across scenarios.
    Matches reference: Coût total, Surface habitable, Nombre d'unités, Score recommandation.
    scenarios_data: dict with keys 'A', 'B', 'C' mapping to scenario dicts.
    """
    fig, axes = plt.subplots(1, 4, figsize=(16, 5))

    keys = ['A', 'B', 'C']
    labels = ['A', 'B', 'C']
    colors_list = [COLORS[k] for k in keys]

    # Extract data for each criterion
    costs_m = [scenarios_data.get(k, {}).get('cost_total_fcfa', 0) / 1_000_000 for k in keys]
    surfaces = [scenarios_data.get(k, {}).get('surface_habitable_m2', 0) for k in keys]
    units = [scenarios_data.get(k, {}).get('total_units', 0) for k in keys]
    scores = [scenarios_data.get(k, {}).get('recommendation_score', 0) for k in keys]

    criteria = [
        ('Coût total (M FCFA)', costs_m, '{:.0f}M', ''),
        ('Surface habitable (m²)', surfaces, '{:.0f}m²', ''),
        ("Nombre d'unités", units, '{:.0f}', ''),
        ('Score recommandation', scores, '{:.0f}/100', ''),
    ]

    for ax, (title, values, fmt, _) in zip(axes, criteria):
        bars = ax.bar(labels, values, color=colors_list, alpha=0.85,
                      edgecolor=COLORS['dark'], linewidth=1.2, width=0.6)
        # Value labels on top of bars
        max_val = max(values) if max(values) > 0 else 1
        for bar, val in zip(bars, values):
            h = bar.get_height()
            label = fmt.format(val)
            ax.text(bar.get_x() + bar.get_width() / 2, h + max_val * 0.03,
                    label, ha='center', va='bottom', fontsize=10, weight='bold',
                    color=COLORS['dark'])
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

# ─────────────────────────────────────────────────────────────
# COST BREAKDOWN PIE CHART
# ─────────────────────────────────────────────────────────────
def generate_cost_breakdown(scenario_data, output_path):
    """
    Pie chart breaking down costs by category.
    Uses scenario data if available, falls back to defaults.
    """
    fig, ax = plt.subplots(figsize=(10, 10))

    # Try to extract cost breakdown from scenario_data
    # Expected keys: cost_fondations_infrastructure, cost_gros_oeuvre_structure,
    #                cost_second_oeuvre_finitions, cost_vrd_amenagements
    cost_fondations = scenario_data.get('cost_fondations_infrastructure', None)
    cost_gros_oeuvre = scenario_data.get('cost_gros_oeuvre_structure', None)
    cost_second_oeuvre = scenario_data.get('cost_second_oeuvre_finitions', None)
    cost_vrd = scenario_data.get('cost_vrd_amenagements', None)

    # If all costs are available, compute percentages
    if all(v is not None for v in [cost_fondations, cost_gros_oeuvre, cost_second_oeuvre, cost_vrd]):
        total = cost_fondations + cost_gros_oeuvre + cost_second_oeuvre + cost_vrd
        if total > 0:
            percentages = [
                (cost_fondations / total) * 100,
                (cost_gros_oeuvre / total) * 100,
                (cost_second_oeuvre / total) * 100,
                (cost_vrd / total) * 100,
            ]
        else:
            percentages = [20, 35, 30, 15]  # Fallback defaults
    else:
        percentages = [20, 35, 30, 15]  # Fallback defaults

    labels = [
        'Fondations &\ninfrastructure',
        'Gros œuvre &\nstructure',
        'Second œuvre &\nfinitions',
        'VRD &\naménagements'
    ]
    colors_pie = ['#1E2761', '#2C7873', '#F39C12', '#E74C3C']

    wedges, texts, autotexts = ax.pie(percentages, labels=labels, colors=colors_pie, autopct='%1.0f%%',
                                        startangle=90, textprops={'fontsize': 11, 'weight': 'bold'})

    for autotext in autotexts:
        autotext.set_color('white')
        autotext.set_weight('bold')
        autotext.set_fontsize(12)

    ax.set_facecolor(COLORS['bg'])
    fig.patch.set_facecolor(COLORS['bg'])

    _save(fig, output_path)

# ─────────────────────────────────────────────────────────────
# TIMELINE CHART
# ─────────────────────────────────────────────────────────────
def generate_timeline(scenario_data, output_path):
    """
    Gantt-like timeline showing project phases.
    Scales phase durations proportionally to total project duration.
    """
    fig, ax = plt.subplots(figsize=(14, 7))

    # Get total project duration from scenario (default 18 months)
    total_duration = scenario_data.get('duree_chantier_mois', 18)

    # Default phase structure with relative proportions
    # These will be scaled to match total_duration
    default_phases = [
        ('Études & Permis', 3),
        ('Terrassement', 2),
        ('Fondations', 2),
        ('Gros Œuvre', 4),
        ('Second Œuvre', 4),
        ('Finitions', 2),
        ('Livraison', 1),
    ]

    default_total = sum(d for _, d in default_phases)
    scale_factor = total_duration / default_total if default_total > 0 else 1.0

    # Scale all durations
    phases = [(name, max(1, int(duration * scale_factor))) for name, duration in default_phases]

    # Compute cumulative positions
    positions = []
    cumulative = 0
    for name, duration in phases:
        positions.append((cumulative, duration, name))
        cumulative += duration

    # Colors for phases
    phase_colors = [COLORS['red'], COLORS['orange'], COLORS['green'], COLORS['blue'] if 'blue' in COLORS else '#3498DB',
                    COLORS['dark'], '#95A5A6', '#34495E']

    y_pos = 0
    for i, (start, duration, name) in enumerate(positions):
        color = phase_colors[i % len(phase_colors)]
        ax.barh(y_pos, duration, left=start, height=0.6, color=color, edgecolor=COLORS['dark'], linewidth=2, alpha=0.85)
        ax.text(start + duration / 2, y_pos, f'{name}\n({duration}m)', ha='center', va='center',
                fontsize=10, weight='bold', color='white')

    ax.set_ylim(-0.5, 0.5)
    ax.set_xlim(0, total_duration + 1)
    ax.set_xlabel('Durée (mois)', fontsize=12, weight='bold', color=COLORS['text'])
    ax.set_yticks([])
    ax.grid(axis='x', color=COLORS['grid'], alpha=0.5, linestyle='--')
    ax.set_axisbelow(True)

    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['left'].set_visible(False)
    ax.set_facecolor(COLORS['light'])
    fig.patch.set_facecolor(COLORS['bg'])

    plt.tight_layout()
    _save(fig, output_path)

# ─────────────────────────────────────────────────────────────
# RECAP CARD
# ─────────────────────────────────────────────────────────────
def generate_recap_card(scenario_data, scenario_key, output_path):
    """
    Summary card displaying key scenario metrics.
    Pulls data from: sdp_m2, surface_habitable_m2, total_units, cost_total_fcfa,
                     duree_chantier_mois, recommendation_score
    """
    fig, ax = plt.subplots(figsize=(10, 8))
    ax.axis('off')

    # Extract data
    sdp_m2 = scenario_data.get('sdp_m2', 'N/A')
    surface_habitable = scenario_data.get('surface_habitable_m2', 'N/A')
    total_units = scenario_data.get('total_units', 'N/A')
    cost_total = scenario_data.get('cost_total_fcfa', 0)
    duration = scenario_data.get('duree_chantier_mois', 'N/A')
    score = scenario_data.get('recommendation_score', 50)

    # Format cost in millions
    if isinstance(cost_total, (int, float)):
        cost_display = f"{int(cost_total / 1_000_000)}M FCFA"
    else:
        cost_display = "N/A"

    # Title
    title_color = COLORS[scenario_key]
    ax.text(0.5, 0.95, f'Scénario {scenario_key}', fontsize=28, weight='bold', ha='center',
            transform=ax.transAxes, color=title_color)

    # Draw card background box
    card_box = FancyBboxPatch((0.05, 0.1), 0.9, 0.8, boxstyle="round,pad=0.01",
                             edgecolor=title_color, facecolor=COLORS['light'], linewidth=3,
                             transform=ax.transAxes, zorder=1)
    ax.add_patch(card_box)

    # Key metrics
    metrics = [
        ('SDP', f"{sdp_m2} m²" if sdp_m2 != 'N/A' else sdp_m2),
        ('Surface habitable', f"{surface_habitable} m²" if surface_habitable != 'N/A' else surface_habitable),
        ('Total unités', str(total_units)),
        ('Coût total', cost_display),
        ('Durée du chantier', f"{duration} mois" if duration != 'N/A' else duration),
        ('Score recommandation', f"{int(score)}/100"),
    ]

    y_start = 0.75
    for i, (label, value) in enumerate(metrics):
        y = y_start - (i * 0.11)
        ax.text(0.1, y, label, fontsize=12, weight='bold', ha='left', transform=ax.transAxes, color=COLORS['text'])
        ax.text(0.65, y, value, fontsize=12, weight='normal', ha='right', transform=ax.transAxes, color=COLORS['dark'])

    fig.patch.set_facecolor(COLORS['bg'])
    _save(fig, output_path)

# ─────────────────────────────────────────────────────────────
# MAIN GENERATION FUNCTION
# ─────────────────────────────────────────────────────────────
def generate_all_charts(scenario_data, output_dir):
    """
    Generate all required charts for the PPTX.

    scenario_data: dict with structure:
    {
        'scenarios': {
            'A': { risk metrics and project data },
            'B': { ... },
            'C': { ... }
        },
        'recommended': 'A' or 'B' or 'C'
    }

    Returns: dict mapping chart_path keys to file paths
    """
    os.makedirs(output_dir, exist_ok=True)

    chart_paths = {}

    # Extract scenarios and recommended
    scenarios = scenario_data.get('scenarios', {})
    recommended_key = scenario_data.get('recommended', 'A')

    # Generate per-scenario charts (radar, gauge, bars)
    for scenario_key in ['A', 'B', 'C']:
        scenario_info = scenarios.get(scenario_key, {})

        # Risk metrics (for radar and bars)
        risk_metrics = {
            'budget_fit': scenario_info.get('budget_fit', 50),
            'complexite_structurelle': scenario_info.get('complexite_structurelle', 50),
            'risque_permis': scenario_info.get('risque_permis', 50),
            'ratio_efficacite': scenario_info.get('ratio_efficacite', 50),
            'densite_cos': scenario_info.get('densite_cos', 50),
            'phasabilite': scenario_info.get('phasabilite', 50),
            'cout_m2': scenario_info.get('cout_m2', 50),
        }

        # Radar
        radar_path = os.path.join(output_dir, f'scenario_{scenario_key}_risk_radar.png')
        generate_risk_radar(risk_metrics, scenario_key, radar_path)
        chart_paths[f'scenario_{scenario_key}_risk_radar'] = radar_path

        # Gauge
        score = scenario_info.get('recommendation_score', 50)
        gauge_path = os.path.join(output_dir, f'scenario_{scenario_key}_risk_gauge.png')
        generate_gauge(score, scenario_key, gauge_path)
        chart_paths[f'scenario_{scenario_key}_risk_gauge'] = gauge_path

        # Horizontal bars
        bars_path = os.path.join(output_dir, f'scenario_{scenario_key}_risk_bars.png')
        generate_horizontal_bars(risk_metrics, scenario_key, bars_path)
        chart_paths[f'scenario_{scenario_key}_risk_bars'] = bars_path

    # Comparative table
    all_risk_metrics = {}
    for scenario_key in ['A', 'B', 'C']:
        scenario_info = scenarios.get(scenario_key, {})
        all_risk_metrics[scenario_key] = {
            'budget_fit': scenario_info.get('budget_fit', 50),
            'complexite_structurelle': scenario_info.get('complexite_structurelle', 50),
            'risque_permis': scenario_info.get('risque_permis', 50),
            'ratio_efficacite': scenario_info.get('ratio_efficacite', 50),
            'densite_cos': scenario_info.get('densite_cos', 50),
            'phasabilite': scenario_info.get('phasabilite', 50),
            'cout_m2': scenario_info.get('cout_m2', 50),
        }

    table_path = os.path.join(output_dir, 'tableau_comparative_charts.png')
    generate_comparative_table(all_risk_metrics, table_path)
    chart_paths['tableau_comparative_charts'] = table_path

    # Arbitrage graph (4-panel: cost, surface, units, score)
    arbitrage_path = os.path.join(output_dir, 'arbitrage_graph_.png')
    generate_arbitrage_graph(scenarios, arbitrage_path)
    chart_paths['arbitrage_graph_'] = arbitrage_path

    # Cost breakdown (from recommended scenario)
    recommended_scenario = scenarios.get(recommended_key, {})
    cost_breakdown_path = os.path.join(output_dir, 'cost_breakdown.png')
    generate_cost_breakdown(recommended_scenario, cost_breakdown_path)
    chart_paths['cost_breakdown'] = cost_breakdown_path

    # Timeline (from recommended scenario)
    timeline_path = os.path.join(output_dir, 'timeline.png')
    generate_timeline(recommended_scenario, timeline_path)
    chart_paths['timeline'] = timeline_path

    # Recap card (from recommended scenario)
    recap_path = os.path.join(output_dir, 'recap_card.png')
    generate_recap_card(recommended_scenario, recommended_key, recap_path)
    chart_paths['recap_card'] = recap_path

    return chart_paths

# ─────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────
if __name__ == '__main__':
    # For testing: load sample scenario data
    if len(sys.argv) > 1:
        json_path = sys.argv[1]
        with open(json_path, 'r') as f:
            scenario_data = json.load(f)
    else:
        # Default sample data
        scenario_data = {
            'scenarios': {
                'A': {
                    'budget_fit': 65, 'complexite_structurelle': 55, 'risque_permis': 75,
                    'ratio_efficacite': 70, 'densite_cos': 60, 'phasabilite': 65, 'cout_m2': 50,
                    'recommendation_score': 65,
                    'cost_total_fcfa': 2_500_000_000,
                    'duree_chantier_mois': 18,
                    'sdp_m2': 5000, 'surface_habitable_m2': 3500, 'total_units': 40,
                    'cost_fondations_infrastructure': 500_000_000,
                    'cost_gros_oeuvre_structure': 875_000_000,
                    'cost_second_oeuvre_finitions': 750_000_000,
                    'cost_vrd_amenagements': 375_000_000,
                },
                'B': {
                    'budget_fit': 75, 'complexite_structurelle': 45, 'risque_permis': 65,
                    'ratio_efficacite': 80, 'densite_cos': 50, 'phasabilite': 75, 'cout_m2': 60,
                    'recommendation_score': 75,
                    'cost_total_fcfa': 2_200_000_000,
                    'duree_chantier_mois': 16,
                    'sdp_m2': 5000, 'surface_habitable_m2': 3200, 'total_units': 35,
                },
                'C': {
                    'budget_fit': 55, 'complexite_structurelle': 65, 'risque_permis': 45,
                    'ratio_efficacite': 60, 'densite_cos': 70, 'phasabilite': 50, 'cout_m2': 40,
                    'recommendation_score': 55,
                    'cost_total_fcfa': 1_800_000_000,
                    'duree_chantier_mois': 14,
                    'sdp_m2': 5000, 'surface_habitable_m2': 2800, 'total_units': 28,
                },
            },
            'recommended': 'B',
        }

    output_dir = './charts_output'
    chart_paths = generate_all_charts(scenario_data, output_dir)

    print('Generated charts:')
    for key, path in chart_paths.items():
        print(f'  {key}: {path}')
