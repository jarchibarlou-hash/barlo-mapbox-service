═══════════════════════════════════════════════
PATCH SERVER.JS — FIX SDP EN MODE SPLIT_AV_AR
Version : v72.0-SUPERVISOR → v72.1
Date : 2026-04-14
═══════════════════════════════════════════════

PROBLÈME IDENTIFIÉ :
En mode SPLIT_AV_AR, le flat output `sdp_m2` envoyé au Sheet
ne contient que le SDP du volume LOGEMENT. Le volume COMMERCE
est exclu. Mais le render (drawMassingOverlays) affiche le
SDP TOTAL (commerce + logement). Résultat : le client voit
391m² sur l'image mais le GPT écrit 330m² (lu depuis le Sheet).

═══════════════════════════════════════════════
FIX 1 — computeSmartScenarios : inclure commerce SDP
═══════════════════════════════════════════════

LOCALISATION : Dans la fonction `computeSmartScenarios`,
après le calcul du `sdp` pour chaque scénario (A, B, C),
chercher le bloc qui assigne `sdp_m2` à l'objet scénario.

AVANT (code actuel) :
─────────────────────
  const sdp = (fpRdc && fpEtages && levels > 1)
    ? fpRdc + fpEtages * (levels - 1)
    : fp * levels;

  // ... puis plus loin :
  sA.sdp_m2 = sdp;   // ← logement seul

APRÈS (code corrigé) :
──────────────────────
  const sdpLogement = (fpRdc && fpEtages && levels > 1)
    ? fpRdc + fpEtages * (levels - 1)
    : fp * levels;

  // En mode SPLIT, ajouter le SDP commerce au SDP total
  let sdp = sdpLogement;
  if (splitLayout && splitLayout.volume_commerce) {
    sdp += (splitLayout.volume_commerce.sdp_m2 || 0);
  }

  // ... puis :
  sA.sdp_m2 = sdp;   // ← commerce + logement = cohérent avec render

EXPLICATION :
- `splitLayout.volume_commerce.sdp_m2` est déjà calculé dans le
  bloc SPLIT (c'est ce que `drawMassingOverlays` utilise pour `vc.sdp_m2`)
- En ajoutant cette valeur, le flat output correspond exactement
  à ce que le render affiche
- En mode NON-SPLIT, `splitLayout` est null/undefined → le `if`
  est ignoré → aucun changement de comportement

═══════════════════════════════════════════════
FIX 2 — Appliquer le même fix pour les 3 scénarios
═══════════════════════════════════════════════

Le calcul du SDP est fait dans une boucle ou répété pour A, B, C.
Vérifier que le fix est appliqué pour CHAQUE scénario.

Si le code utilise une boucle type :
  for (const role of ['A', 'B', 'C']) { ... }
→ Le fix s'applique UNE FOIS dans la boucle.

Si le code a 3 blocs séparés (un pour A, un pour B, un pour C) :
→ Appliquer le fix DANS CHAQUE BLOC.

═══════════════════════════════════════════════
FIX 3 — levels dans le flat output (optionnel mais recommandé)
═══════════════════════════════════════════════

PROBLÈME SECONDAIRE :
Le flat output `A_levels` / `B_levels` peut ne contenir que les
niveaux du logement en SPLIT, alors que le render montre
commerce (1 niveau) + logement (N niveaux) = N+1 niveaux visibles.

SOLUTION :
Après le calcul des levels pour le flat output, en mode SPLIT :

  let totalLevels = levelsLogt;
  if (splitLayout && splitLayout.volume_commerce) {
    totalLevels += (splitLayout.volume_commerce.levels || 1);
  }
  sA.levels = totalLevels;

Cela garantit que le texte GPT dit "R+3" quand le render montre
effectivement un bâtiment à 4 niveaux (1 commerce + 3 logement).

═══════════════════════════════════════════════
VÉRIFICATION APRÈS DÉPLOIEMENT :
═══════════════════════════════════════════════

1. Lancer un test avec un lead SPLIT_AV_AR connu
2. Vérifier dans le log `/compute-scenarios` que :
   - A_sdp ≠ B_sdp (si levels sont différents)
   - A_sdp = valeur annotée sur le render A
   - B_sdp = valeur annotée sur le render B
3. Vérifier dans le Sheet colonnes GP/GQ/GR que les valeurs
   correspondent aux annotations render
4. Vérifier que le texte GPT utilise les bonnes valeurs SDP

═══════════════════════════════════════════════
IMPACT :
- Corrige le mismatch SDP Sheet vs Render en mode SPLIT
- Aucun impact sur les modes non-SPLIT (STANDARD, etc.)
- Le texte GPT sera désormais cohérent avec les images massing
═══════════════════════════════════════════════
