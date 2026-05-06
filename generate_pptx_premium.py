#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BARLO Premium PPTX Generator (Push 22.1 — Phase 1 : substitution textes)

Charge le template Canva 'template_diagnostic_premium.pptx' et y remplace
les textes pre-generes (specifiques a Vanelle) par les vraies donnees BARLO
du lead courant. Les images du template (photos N&B) sont conservees a ce
stade — elles seront supprimees/remplacees en Phase 22.2.

Usage : python3 generate_pptx_premium.py <data.json> <template.pptx> <output.pptx>
"""
import sys
import json
import os
from copy import deepcopy
from pptx import Presentation
from pptx.util import Pt, Emu


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def f(flat, key, default=""):
    """Lecture securisee d'un champ flat. Retourne string."""
    val = flat.get(key, default)
    if val is None or val == "":
        return str(default)
    return str(val)


def fnum(flat, key, default=0):
    """Lecture numerique securisee."""
    try:
        v = flat.get(key, default)
        if isinstance(v, str):
            v = "".join(c for c in v if c.isdigit() or c in ".-")
        return float(v) if v not in ("", None) else default
    except (ValueError, TypeError):
        return default


def replace_text_in_shape(shape, old_text, new_text):
    """
    Remplace 'old_text' par 'new_text' dans un shape, en preservant le
    formatting (police, taille, couleur) du premier run du paragraphe ou le
    texte est trouve. Retourne True si remplacement effectue.

    Strategie : on lit le texte complet du paragraphe (merge des runs) et si
    'old_text' s'y trouve, on remplace tout le texte du paragraphe par
    new_text en gardant le format du premier run.
    """
    if not shape.has_text_frame:
        return False
    tf = shape.text_frame
    found = False
    for para in tf.paragraphs:
        para_text = "".join(r.text for r in para.runs)
        if old_text in para_text:
            replaced = para_text.replace(old_text, new_text)
            # Vider tous les runs sauf le premier, et y mettre le texte complet
            if para.runs:
                first = para.runs[0]
                first.text = replaced
                for r in para.runs[1:]:
                    r.text = ""
                found = True
                break  # un seul replacement par shape pour cette occurrence
    return found


def replace_paragraph_text(shape, paragraph_index, new_text):
    """
    Remplace integralement le texte du paragraphe indique par new_text,
    en gardant le format du premier run.
    """
    if not shape.has_text_frame:
        return False
    tf = shape.text_frame
    if paragraph_index >= len(tf.paragraphs):
        return False
    para = tf.paragraphs[paragraph_index]
    if not para.runs:
        return False
    first = para.runs[0]
    first.text = new_text
    for r in para.runs[1:]:
        r.text = ""
    return True


def find_shape_containing(slide, fragment):
    """Trouve le premier shape dont le texte contient 'fragment'."""
    for shape in slide.shapes:
        if shape.has_text_frame and fragment in shape.text_frame.text:
            return shape
    return None


def find_shape_by_exact_text(slide, exact_text):
    """Trouve le premier shape dont le texte est exactement egal a exact_text."""
    for shape in slide.shapes:
        if shape.has_text_frame and shape.text_frame.text.strip() == exact_text.strip():
            return shape
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Mapping slide-par-slide : ancien_texte → nouveau_texte (depuis flat)
# ─────────────────────────────────────────────────────────────────────────────

def build_slide_replacements(flat, scenarios=None):
    """
    Construit pour chaque slide (1-20) un dict {ancien_texte: nouveau_texte}.
    L'ancien texte est ce qui est figé dans le template Canva. Le nouveau
    texte est genere depuis les donnees BARLO du lead courant.
    """
    # ── Donnees globales ──
    program = f(flat, "program_main", "Petit collectif")
    units_a = f(flat, "A_units", "?")
    units_b = f(flat, "B_units", "?")
    units_c = f(flat, "C_units", "?")
    standing = f(flat, "standing_level", "ECONOMIQUE").lower()
    city = f(flat, "city", "Douala")
    site_area = f(flat, "site_area", "130")
    budget_fcfa = f(flat, "budget_fcfa", "66M FCFA")
    site_cos = f(flat, "site_cos_regl", "2.5")
    site_ces = f(flat, "site_ces_regl", "60")
    retrait_avant = f(flat, "retrait_avant", "5m")
    retrait_lateral = f(flat, "retrait_lateral", "3m")
    retrait_arriere = f(flat, "retrait_arriere", "3m")
    retrait_mitoyennete = f(flat, "retrait_mitoyennete", "2")
    emprise_constructible = f(flat, "retrait_emprise_constructible", "70 m²")
    orient_zone = f(flat, "orient_zone", "Tropicale humide").capitalize()

    # ── Recommandation ──
    rec = f(flat, "rec_scenario", "B")
    rec_role = f(flat, f"{rec}_role", "EQUILIBRE")
    rec_role_label = {"INTENSIFICATION": "Intensification", "EQUILIBRE": "Équilibre", "PRUDENT": "Prudence"}.get(rec_role.upper(), rec_role)
    rec_score = f(flat, "rec_score", "76")
    rec_units = f(flat, f"{rec}_units", "?")
    rec_sdp = f(flat, f"{rec}_sdp", "?")
    rec_levels = f(flat, "rec_levels", "3")
    rec_total_niv = int(fnum(flat, "rec_levels", 3)) + 1
    rec_cost_total = f(flat, "rec_cost_total", "?")
    rec_duree = f(flat, "rec_duree_chantier", "11 mois")

    # ── Per-scenario donnees ──
    a_role = f(flat, "A_role", "INTENSIFICATION")
    a_role_label = {"INTENSIFICATION": "Intensification", "EQUILIBRE": "Équilibre", "PRUDENT": "Prudence"}.get(a_role.upper(), a_role)
    a_sdp = f(flat, "A_sdp", "?")
    a_levels_total = int(fnum(flat, "A_levels", 3)) + 1
    a_fp = f(flat, "A_fp", "?")
    a_units = units_a
    a_cost_total = f(flat, "A_cost_total", "?")
    a_cost_unit = f(flat, "A_cost_unit", "?")
    a_score = f(flat, "A_score", "?")

    b_role = f(flat, "B_role", "EQUILIBRE")
    b_role_label = {"INTENSIFICATION": "Intensification", "EQUILIBRE": "Équilibre", "PRUDENT": "Prudence"}.get(b_role.upper(), b_role)
    b_sdp = f(flat, "B_sdp", "?")
    b_levels_total = int(fnum(flat, "B_levels", 3)) + 1
    b_fp = f(flat, "B_fp", "?")
    b_units = units_b
    b_cost_total = f(flat, "B_cost_total", "?")
    b_cost_unit = f(flat, "B_cost_unit", "?")
    b_score = f(flat, "B_score", "?")

    c_role = f(flat, "C_role", "PRUDENT")
    c_role_label = {"INTENSIFICATION": "Intensification", "EQUILIBRE": "Équilibre", "PRUDENT": "Prudence"}.get(c_role.upper(), c_role)
    c_sdp = f(flat, "C_sdp", "?")
    c_levels_total = int(fnum(flat, "C_levels", 1)) + 1
    c_fp = f(flat, "C_fp", "?")
    c_units = units_c
    c_cost_total = f(flat, "C_cost_total", "?")
    c_cost_unit = f(flat, "C_cost_unit", "?")
    c_score = f(flat, "C_score", "?")

    # ── Constraints summary (si overrides actifs) ──
    has_constraints = f(flat, "_has_constraints", "") == "Y"
    constraints_note = " (dérogations assumées)" if has_constraints else ""

    # ─────────────────────────────────────────────────────────────
    # MAPPING PAR SLIDE
    # ─────────────────────────────────────────────────────────────
    return {
        # SLIDE 3 — PROJET EN BREF
        3: {
            "Petit collectif de 8 logements en standing économique à Douala, Cameroun. Surface terrain : 130 m². Budget de référence : 66 millions FCFA.":
                f"{program} de {units_a} logements en standing {standing} à {city}. Surface terrain : {site_area} m². Budget de référence : {budget_fcfa}.",
            "L'objectif de ce diagnostic est de comparer plusieurs scénarios de développement (A, B, C) selon les contraintes réglementaires, financières et architecturales pour déterminer le meilleur potentiel de projet.":
                "Notre objectif : comparer trois scénarios architecturaux (A, B, C) selon les contraintes réglementaires, financières et techniques pour identifier la meilleure stratégie de développement.",
            "Méthode : Analyse croisée architecturale, financière et réglementaire permettant une vision globale et stratégique du potentiel immobilier.":
                "Méthode : analyse croisée architecturale, financière et réglementaire — vision stratégique du potentiel immobilier.",
        },

        # SLIDE 4 — ANALYSE DU TERRAIN
        4: {
            "Surface totale : 130 m²": f"Surface totale : {site_area} m²",
            "Emprise constructible : 70 m² après retraits": f"Emprise constructible : {emprise_constructible} après retraits",
            "Mitoyenneté : 2 côtés (est assumé, ouest 4 m)": f"Mitoyenneté : {retrait_mitoyennete} côté(s){constraints_note}",
            "• COS (Coefficient d'Occupation des Sols) : 2,5": f"• COS (Coefficient d'Occupation des Sols) : {site_cos}",
            "• CES (Coefficient d'Emprise au Sol) : 60%": f"• CES (Coefficient d'Emprise au Sol) : {site_ces} %",
            "• Retraits : avant 5 m, latéraux 3 m, arrière 3 m":
                f"• Retraits : avant {retrait_avant}, latéraux {retrait_lateral}, arrière {retrait_arriere}",
            "Zone climatique : Tropicale humide": f"Zone climatique : {orient_zone}",
            "Gabarit volumétrique : 4 niveaux maximum": f"Gabarit volumétrique : {rec_total_niv} niveaux maximum",
        },

        # SLIDE 5 — CONTEXTE URBAIN & CONTRAINTES
        5: {
            "Le terrain s'inscrit dans un quartier dense et mixte de Douala, combinant fonctions résidentielles et commerciales. La mitoyenneté sur deux côtés impose une conception architecturale privilégiant la ventilation naturelle traversante, indispensable en climat tropical humide.":
                f"Le terrain s'inscrit dans un quartier dense et mixte de {city}. La mitoyenneté sur {retrait_mitoyennete} côté(s) impose une conception architecturale privilégiant la ventilation naturelle traversante, indispensable en climat {orient_zone.lower()}.",
            "Les conditions climatiques exigent une protection solaire efficace et une gestion optimale de l'humidité. Le gabarit volumétrique autorise un potentiel de 4 niveaux maximum, compatible avec le programme de 8 unités envisagé. Cette configuration permet d'exploiter pleinement le foncier disponible.":
                f"Les conditions climatiques exigent une protection solaire efficace et une gestion optimale de l'humidité. Le gabarit volumétrique permet jusqu'à {rec_total_niv} niveaux, compatible avec le programme de {units_a} unités envisagé. Cette configuration valorise pleinement le foncier disponible.",
        },

        # SLIDE 6 — SCÉNARIO A
        6: {
            "Maximiser la densité et exploiter pleinement le potentiel foncier du terrain de 130 m².":
                f"Maximiser la densité et exploiter pleinement le potentiel foncier du terrain de {site_area} m².",
            "Programme architectural : 8 logements répartis sur 4 niveaux (RDC + 3 étages). Surface habitable totale de 280 m², soit la densité maximale autorisée par le COS de 2,5. Cette configuration exploite l'intégralité du gabarit volumétrique permis, avec une emprise au sol de 70 m² respectant le CES de 60%. La mitoyenneté sur deux côtés est assumée, nécessitant une ventilation naturelle traversante optimisée sur les façades libres.":
                f"Programme architectural : {a_units} logements sur {a_levels_total} niveaux. Surface habitable totale de {a_sdp} m², emprise au sol de {a_fp} m². La mitoyenneté sur {retrait_mitoyennete} côté(s) est assumée, nécessitant une ventilation naturelle traversante optimisée sur les façades libres.",
            "Scénario A — Intensification": f"Scénario A — {a_role_label}",
        },

        # SLIDE 7 — SCÉNARIO A FINANCE
        7: {
            "Coût total du projet : 59 M FCFA": f"Coût total du projet : {a_cost_total}",
            "Coût unitaire : 7 M FCFA/logement": f"Coût unitaire : {a_cost_unit}/logement",
            "Score global : 64/100 (Acceptable)": f"Score global : {a_score}/100",
            "L'intensification maximale du foncier génère un investissement conséquent de 59 millions FCFA pour 8 unités. Le coût unitaire de 7 M FCFA par logement reflète la complexité technique du projet sur 4 niveaux. Malgré une densité optimale, le score financier de 64/100 révèle un risque de surcoût lié aux contraintes structurelles et à la mitoyenneté. Budget de référence dépassé de 7 M FCFA.":
                f"L'intensification du foncier représente un investissement de {a_cost_total} pour {a_units} unités. Le coût unitaire de {a_cost_unit}/logement reflète la complexité du projet sur {a_levels_total} niveaux. Score global : {a_score}/100 vs budget de référence {budget_fcfa}.",
            "Scénario A — Analyse Financière": f"Scénario A — Analyse Financière",
        },

        # SLIDE 8 — SCÉNARIO A RISQUES
        8: {
            "Le scénario d'intensification présente des risques significatifs liés à la complexité technique. La construction sur 4 niveaux avec 280 m² habitables nécessite une structure béton armé exigeante. Les fondations en mitoyenneté sur 2 côtés requièrent une étude géotechnique approfondie et des techniques de reprise en sous-œuvre coûteuses.":
                f"Le scénario d'intensification présente des risques techniques notables. La construction sur {a_levels_total} niveaux avec {a_sdp} m² habitables nécessite une structure béton armé exigeante. Les fondations en mitoyenneté ({retrait_mitoyennete} côté(s)) requièrent une étude géotechnique approfondie.",
            "Les dérogations réglementaires constituent un risque majeur. Le dépassement du COS standard et les retraits réduits nécessitent des autorisations spéciales dont l'obtention n'est pas garantie. Le surcoût estimé à 59 M FCFA dépasse le budget cible, avec un score global de 64/100 classé \"Acceptable\" — le plus faible des trois scénarios étudiés.":
                f"Le coût de {a_cost_total} pour {a_units} unités positionne ce scénario {(\"au-dessus\" if a_cost_total > budget_fcfa else \"dans la cible\")} de l'enveloppe {budget_fcfa}. Score global de {a_score}/100. Vigilance sur la conformité urbanistique et la complexité technique du projet.",
            "Scénario A — Analyse des Risques": f"Scénario A — Analyse des Risques",
        },

        # SLIDE 9 — SCÉNARIO B
        9: {
            "8 logements sur 4 niveaux": f"{b_units} logements sur {b_levels_total} niveaux",
            "240 m² de surface habitable": f"{b_sdp} m² de surface habitable",
            "Compromis optimal densité/coût/faisabilité": "Compromis optimal densité/coût/faisabilité",
            "Le scénario B propose un équilibre stratégique entre ambition et réalisme. Avec 8 unités réparties sur 4 niveaux (RDC + 3 étages), ce programme optimise l'emprise constructible de 70 m² tout en respectant les contraintes de mitoyenneté. La configuration permet une ventilation naturelle traversante sur les façades libres, essentielle en climat tropical humide. Score global : 76/100 — scénario recommandé.":
                f"Le scénario B propose un équilibre stratégique entre ambition et réalisme. {b_units} unités sur {b_levels_total} niveaux, emprise constructible de {b_fp} m². La configuration permet une ventilation naturelle traversante sur les façades libres, essentielle en climat {orient_zone.lower()}. Score global : {b_score}/100.",
            "Scénario B — Équilibre": f"Scénario B — {b_role_label}",
        },

        # SLIDE 10 — SCÉNARIO B FINANCE
        10: {
            "Le scénario B présente le meilleur équilibre financier avec un coût total maîtrisé de 46 millions FCFA pour 8 logements.":
                f"Le scénario B présente un équilibre financier maîtrisé : {b_cost_total} pour {b_units} logements.",
            "Score global : 76/100 — Recommandé": f"Score global : {b_score}/100",
            "Coût unitaire : 6 M FCFA par logement": f"Coût unitaire : {b_cost_unit}/logement",
            "Budget travaux : 46 M FCFA": f"Budget travaux : {b_cost_total}",
            "Frais annexes : 7 à 10 M FCFA": "Frais annexes : honoraires + études + permis + assurance",
            "Provision imprévus : 5 à 8 %": "Provision imprévus recommandée : 5 à 8 %",
            "Ce scénario respecte le budget cible de 66 M FCFA tout en optimisant le ratio surface habitable/investissement. La conformité urbanistique réduit les risques de surcoûts administratifs.":
                f"Ce scénario respecte le budget cible de {budget_fcfa} tout en optimisant le ratio surface habitable / investissement. La conformité urbanistique réduit les risques administratifs.",
            "Scénario B — Analyse Financière": "Scénario B — Analyse Financière",
        },

        # SLIDE 11 — SCÉNARIO B AVANTAGES
        11: {
            "Le scénario B offre le meilleur équilibre entre coût maîtrisé et conformité urbanistique. Avec un budget de 46 M FCFA pour 240 m² habitables, il présente un ratio coût/surface optimal de 192 000 FCFA/m². La conformité réglementaire solide réduit les risques de blocage administratif et sécurise l'investissement à long terme.":
                f"Le scénario B offre le meilleur équilibre coût/conformité. Budget de {b_cost_total} pour {b_sdp} m² habitables. Ratio coût/surface optimisé. Conformité réglementaire solide → risques administratifs réduits.",
            "La rentabilité supérieure découle d'un coût unitaire de 6 M FCFA par logement, le plus bas des trois scénarios. Cette approche équilibrée permet une réalisation technique maîtrisable localement tout en maximisant le retour sur investissement. Score global : 76/100, le plus élevé de l'étude comparative.":
                f"Coût unitaire de {b_cost_unit}/logement, particulièrement compétitif. Approche équilibrée : réalisation technique maîtrisable localement tout en valorisant l'investissement. Score global : {b_score}/100.",
            "Scénario B — Avantages clés": "Scénario B — Avantages clés",
        },

        # SLIDE 12 — SCÉNARIO C
        12: {
            "Minimiser les coûts et sécuriser l'investissement avec une approche conservatrice du projet immobilier.":
                "Minimiser les coûts et sécuriser l'investissement avec une approche conservatrice du projet immobilier.",
            "Programme architectural : 6 logements répartis sur 3 niveaux (RDC + 2 étages), pour une surface habitable totale de 210 m². Cette configuration réduit la complexité structurelle et les contraintes techniques liées à la hauteur. Le coût total estimé s'élève à 39 M FCFA, soit 6,5 M FCFA par logement. Score global : 65/100 (Acceptable). Avantage principal : budget sécurisé et risques minimisés. Point d'attention : sous-exploitation relative du potentiel foncier disponible.":
                f"Programme architectural : {c_units} logements sur {c_levels_total} niveaux, surface habitable totale de {c_sdp} m². Configuration réduisant la complexité structurelle. Coût total estimé : {c_cost_total}, soit {c_cost_unit}/logement. Score global : {c_score}/100. Budget sécurisé et risques minimisés.",
            "Scénario C — Prudence": f"Scénario C — {c_role_label}",
        },

        # SLIDE 13 — SCÉNARIO C FINANCE
        13: {
            "Approche prudente et budget sécurisé": "Approche prudente et budget sécurisé",
            "Coût total : 39 M FCFA": f"Coût total : {c_cost_total}",
            "Coût unitaire : 6,5 M FCFA/logement": f"Coût unitaire : {c_cost_unit}/logement",
            "Score global : 65/100 (Acceptable)": f"Score global : {c_score}/100",
            "Le scénario C privilégie la prudence financière avec un investissement maîtrisé de 39 millions FCFA. Cette option offre un budget sécurisé avec des risques minimisés, idéale pour un premier projet ou un contexte économique incertain.":
                f"Le scénario C privilégie la prudence financière avec un investissement maîtrisé de {c_cost_total}. Cette option offre un budget sécurisé avec des risques minimisés, adaptée à un contexte économique prudent.",
            "Marge de sécurité intégrée permettant d'absorber les imprévus sans compromettre la viabilité du projet. Durée de chantier réduite à 8 mois, limitant l'exposition aux aléas.":
                "Marge de sécurité intégrée permettant d'absorber les imprévus sans compromettre la viabilité du projet. Durée de chantier réduite limitant l'exposition aux aléas.",
            "Scénario C — Analyse Financière": "Scénario C — Analyse Financière",
        },

        # SLIDE 14 — SCÉNARIO C LIMITES
        14: {
            "Le scénario C, bien que sécurisant sur le plan budgétaire (39 M FCFA), présente une sous-exploitation significative du potentiel foncier. Avec seulement 6 logements sur 3 niveaux et 210 m² habitables, ce choix ne valorise pas pleinement l'investissement initial dans le terrain.":
                f"Le scénario C, sécurisant sur le plan budgétaire ({c_cost_total}), présente une sous-exploitation du potentiel foncier. Avec {c_units} logements sur {c_levels_total} niveaux et {c_sdp} m² habitables, ce choix ne valorise pas pleinement l'investissement initial dans le terrain.",
            "Le score global de 65/100 reflète ce compromis défavorable : si les risques techniques sont minimisés, le rendement économique reste en deçà des possibilités offertes par le site. Cette approche prudente peut convenir à un investisseur averses au risque, mais limite la création de valeur à long terme.":
                f"Le score global de {c_score}/100 reflète ce compromis : si les risques techniques sont minimisés, le rendement économique reste en deçà des possibilités du site. Approche convenant à un investisseur averse au risque, mais limitant la création de valeur à long terme.",
            "Scénario C — Analyse des Limites": "Scénario C — Analyse des Limites",
        },

        # SLIDE 15 — TRANSITION COMPARATIF
        15: {
            "Synthèse comparative des trois approches selon les critères de surface, coût et score global pour identifier la meilleure option.":
                "Synthèse comparative des trois scénarios selon les critères de surface, de coût et de score global pour identifier la meilleure option.",
            "Analyse stratégique des scénarios": "Analyse stratégique des scénarios",
        },

        # SLIDE 16 — ARBITRAGE STRATÉGIQUE
        16: {
            "Budget cible : 66 M FCFA": f"Budget cible : {budget_fcfa}",
            "Scénario recommandé : B (Équilibre)": f"Scénario recommandé : {rec} ({rec_role_label})",
            "Le scénario B s'impose comme le choix optimal pour ce projet immobilier à Douala. Avec un coût maîtrisé de 46 M FCFA, il offre le meilleur ratio coût/surface habitable (240 m² pour 8 logements). Sa conformité urbanistique solide et sa faisabilité technique locale garantissent une réalisation sans complications majeures. Ce scénario équilibre parfaitement ambition architecturale, rentabilité financière et maîtrise des risques.":
                f"Le scénario {rec} s'impose comme le choix optimal pour ce projet à {city}. Avec un coût maîtrisé de {rec_cost_total}, il offre le meilleur ratio coût/surface habitable ({rec_sdp} m² pour {rec_units} logements). Conformité urbanistique solide et faisabilité technique locale. Score global : {rec_score}/100.",
            "Arbitrage Stratégique": "Arbitrage Stratégique",
        },

        # SLIDE 17 — CONDITIONS DE RÉUSSITE
        17: {
            "Le scénario B intègre des ouvertures traversantes sur les façades libres, essentielles en climat tropical humide. La mitoyenneté sur deux côtés impose une conception bioclimatique rigoureuse avec protection solaire et circulation d'air naturelle.":
                f"Le scénario {rec} intègre des ouvertures traversantes sur les façades libres, essentielles en climat {orient_zone.lower()}. La mitoyenneté sur {retrait_mitoyennete} côté(s) impose une conception bioclimatique rigoureuse avec protection solaire et circulation d'air naturelle.",
            "Coût Travaux : 46 M FCFA": f"Coût Travaux : {rec_cost_total}",
            "Budget initial respecté avec frais annexes de 7 à 10 M FCFA (études, honoraires, taxes). Provision imprévus recommandée : 5-8%.":
                f"Budget initial respecté avec frais annexes (études, honoraires, taxes). Provision imprévus recommandée : 5-8 %.",
            "Phasage du Projet : 11 Mois": f"Phasage du Projet : {rec_duree}",
            "Démarrage en saison sèche (novembre-janvier) pour optimiser les conditions de chantier et éviter les retards liés aux intempéries tropicales.":
                "Démarrage en saison sèche (novembre-janvier) pour optimiser les conditions de chantier et éviter les retards liés aux intempéries tropicales.",
            "Conditions de Réussite": "Conditions de Réussite",
        },

        # SLIDE 18 — POINTS INVISIBLES
        18: {
            "Les aspects techniques critiques souvent sous-estimés déterminent la pérennité du projet.":
                "Les aspects techniques critiques souvent sous-estimés déterminent la pérennité du projet.",
            "Structure : Béton armé 4 niveaux, système poteau-poutre adapté à la mitoyenneté sur 2 côtés.":
                f"Structure : béton armé {rec_total_niv} niveaux, système poteau-poutre adapté à la mitoyenneté sur {retrait_mitoyennete} côté(s).",
            "Fondations : Étude géotechnique indispensable avant démarrage des travaux.":
                "Fondations : étude géotechnique indispensable avant démarrage des travaux.",
            "Ventilation : Ouvertures traversantes obligatoires sur façades libres (climat tropical humide).":
                f"Ventilation : ouvertures traversantes obligatoires sur façades libres (climat {orient_zone.lower()}).",
            "Étanchéité : Toiture terrasse critique — membrane haute performance requise.":
                "Étanchéité : toiture terrasse critique — membrane haute performance requise.",
            "Checklist financière : Budget validé, trésorerie par tranches, 3 devis comparatifs minimum, provision imprévus 5-8%.":
                "Checklist financière : budget validé, trésorerie par tranches, 3 devis comparatifs minimum, provision imprévus 5-8 %.",
            "Points Invisibles": "Points Invisibles",
        },

        # SLIDE 19 — RECOMMANDATION FINALE
        19: {
            "Scénario B — Équilibre": f"Scénario {rec} — {rec_role_label}",
            "Score global : 76/100": f"Score global : {rec_score}/100",
            "Le choix stratégique optimal": "Le choix stratégique optimal",
            "Après analyse croisée des trois scénarios, le Scénario B s'impose comme la recommandation du cabinet BARLO. Avec un budget maîtrisé de 46M FCFA pour 240m² habitables sur 11 mois de chantier, il offre le meilleur équilibre entre ambition architecturale, faisabilité technique locale et rentabilité financière. La conformité urbanistique solide et le ratio coût/surface optimisé en font la voie la plus sécurisée vers la réussite de votre projet immobilier à Douala.":
                f"Après analyse croisée des trois scénarios, le Scénario {rec} s'impose comme la recommandation du cabinet BARLO. Budget maîtrisé de {rec_cost_total} pour {rec_sdp} m² habitables sur {rec_duree} de chantier. Meilleur équilibre entre ambition architecturale, faisabilité technique locale et rentabilité financière. La conformité urbanistique solide et le ratio coût/surface optimisé en font la voie la plus sécurisée pour la réussite de votre projet immobilier à {city}.",
            "Recommandation Finale": "Recommandation Finale",
        },
        # SLIDE 20 — CONTACT (laisse le contact actuel du template, ne pas écraser)
    }


# ─────────────────────────────────────────────────────────────────────────────
# Application des replacements
# ─────────────────────────────────────────────────────────────────────────────

def apply_replacements_to_slide(slide, replacements):
    """Applique tous les replacements dict sur un slide donne."""
    applied = 0
    for old_text, new_text in replacements.items():
        if not old_text:
            continue
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            tf = shape.text_frame
            for para in tf.paragraphs:
                para_text = "".join(r.text for r in para.runs)
                if old_text in para_text:
                    # Replace tout le texte du paragraphe par new_text
                    # en preservant le format du premier run
                    if para.runs:
                        new_para_text = para_text.replace(old_text, new_text)
                        para.runs[0].text = new_para_text
                        for r in para.runs[1:]:
                            r.text = ""
                        applied += 1
                        break  # ne pas re-matcher dans le meme shape
    return applied


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 4:
        print("Usage: python3 generate_pptx_premium.py <data.json> <template.pptx> <output.pptx>", file=sys.stderr)
        sys.exit(1)

    data_file = sys.argv[1]
    template = sys.argv[2]
    output = sys.argv[3]

    if not os.path.exists(data_file):
        print(f"ERROR: data file not found: {data_file}", file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(template):
        print(f"ERROR: template not found: {template}", file=sys.stderr)
        sys.exit(3)

    with open(data_file, "r", encoding="utf-8") as fp:
        data = json.load(fp)

    flat = data.get("flat", {}) or {}
    scenarios = data.get("scenarios", {})

    print(f"[premium] Loading template: {template}")
    prs = Presentation(template)
    print(f"[premium] Template loaded: {len(prs.slides)} slides")

    print(f"[premium] Building replacements for lead: {flat.get('client_name', '?')}")
    slide_replacements = build_slide_replacements(flat, scenarios)

    total_applied = 0
    for i, slide in enumerate(prs.slides):
        slide_num = i + 1
        if slide_num in slide_replacements:
            applied = apply_replacements_to_slide(slide, slide_replacements[slide_num])
            print(f"[premium] Slide {slide_num} : {applied} replacements applied")
            total_applied += applied

    print(f"[premium] Total replacements applied : {total_applied}")
    print(f"[premium] Saving output: {output}")
    prs.save(output)
    print(f"[premium] Done. File size: {os.path.getsize(output)} bytes")


if __name__ == "__main__":
    main()
