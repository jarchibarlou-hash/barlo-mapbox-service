const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");

// v13.3 — calendrier du projet (Jeremy, 29/09) : les études ne sont plus prises sur la durée des travaux
const S = loadServer(["projectScheduleV13"]);

test("travaux : durée par niveaux + 20 % de marge, en mois entiers", () => {
  const s = S.projectScheduleV13({ levels: 2, sdp_m2: 225 });
  assert.equal(s.travaux_brut_mois, 8);          // 2 + 2 × 1,5 + 2 + 1
  assert.equal(s.travaux_mois, 10);              // 8 × 1,2 = 9,6 → 10
  const tr = s.phases.filter(p => p.groupe === "travaux");
  assert.equal(tr.reduce((t, p) => t + p.mois, 0), s.travaux_mois, "les phases de travaux font la durée des travaux");
  assert.ok(tr.every(p => p.mois >= 1));
});

test("études avant les travaux, en part croissante avec la surface ; permis 2 mois", () => {
  const petit = S.projectScheduleV13({ levels: 2, sdp_m2: 150 });
  const grand = S.projectScheduleV13({ levels: 2, sdp_m2: 2500 });
  assert.ok(petit.ratio_etudes_pct < grand.ratio_etudes_pct);
  assert.ok(grand.etudes_mois > petit.etudes_mois);
  assert.ok(petit.etudes_mois >= 2, "2 mois d'études au minimum");
  assert.equal(petit.permis_mois, 2);
  // les travaux commencent après études et permis, et le total additionne tout
  const debutTravaux = petit.phases.find(p => p.groupe === "travaux").debut;
  assert.equal(debutTravaux, petit.etudes_mois + petit.permis_mois + 1);
  assert.equal(petit.total_mois, petit.etudes_mois + petit.permis_mois + petit.travaux_mois);
  assert.equal(petit.phases[petit.phases.length - 1].fin, petit.total_mois);
});

test("plus de niveaux : gros œuvre et travaux plus longs", () => {
  const r1 = S.projectScheduleV13({ levels: 1, sdp_m2: 100 });
  const r4 = S.projectScheduleV13({ levels: 4, sdp_m2: 400 });
  const go = s => s.phases.find(p => p.nom === "Gros œuvre").mois;
  assert.ok(go(r4) > go(r1));
  assert.ok(r4.travaux_mois > r1.travaux_mois);
});
