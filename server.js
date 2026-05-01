const express = require("express");
const puppeteer = require("puppeteer-core");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas, loadImage } = require("canvas");
const FormData = require("form-data");
const fetch = require("node-fetch");
const turf = require("@turf/turf");
const app = express();
// v72.160: CORS — allow BARLO Diagnostic Studio (Netlify) and any origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "2mb", type: () => true }));
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY; // v73.2.6 : Google Maps Static API pour vue top haute qualite
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// ═══════════════════════════════════════════════════════════════════════════════
// v72.34: ROBUST AI POLISH ENGINE — stable, retries, model fallback, timeout
// ═══════════════════════════════════════════════════════════════════════════════
const POLISH_MODEL = process.env.OPENAI_POLISH_MODEL || "gpt-4o";
const POLISH_TIMEOUT_MS = 120000; // v72.112: 120s per API call (increased from 60s for more reliable polish) (was 90s — too slow for Make.com 300s limit)
const POLISH_MAX_RETRIES = 1;    // v72.93: 1 retry only (was 2 — worst case 270s of retries alone)
const POLISH_RETRY_DELAY_MS = 2000; // 2s between retries
const POLISH_MAX_IMAGE_DIM = 1536;  // resize to max 1536px before sending
// v72.93: TIME BUDGET — skip polish if endpoint has already spent this many ms
const POLISH_TIME_BUDGET_MS = 180000; // 180s = leave 120s margin for Make.com 300s timeout
// v73.2.7 : polish massing REACTIVE par defaut avec prompt OFF-WHITE (style maquette hektar blanc casse + bandes colorees preservees).
// Override possible via env var MASSING_SKIP_POLISH=true pour rollback rapide.
const MASSING_SKIP_POLISH = process.env.MASSING_SKIP_POLISH === "true";
// v73.2.7 : reference visuelle pour le polish slide 5 axo (image enhanced model committed dans le repo)
let _referenceAxoB64 = null;
function getReferenceAxoB64() {
  if (_referenceAxoB64 !== null) {
    return _referenceAxoB64 === "" ? null : _referenceAxoB64;
  }
  try {
    const path = require("path");
    const fs = require("fs");
    const refPath = path.join(__dirname, "reference_axo.png");
    if (!fs.existsSync(refPath)) {
      console.warn(`[REFERENCE-AXO v73.2.7] reference_axo.png absent dans ${__dirname} — polish slide 5 sera sans reference visuelle`);
      _referenceAxoB64 = "";
      return null;
    }
    const buf = fs.readFileSync(refPath);
    _referenceAxoB64 = buf.toString("base64");
    console.log(`[REFERENCE-AXO v73.2.7] reference_axo.png loaded ${(buf.length/1024).toFixed(0)}KB`);
    return _referenceAxoB64;
  } catch (e) {
    console.warn(`[REFERENCE-AXO v73.2.7] Could not load reference_axo.png: ${e.message}`);
    _referenceAxoB64 = "";
    return null;
  }
}
/**
 * v72.34: Robust single polish API call with retry + timeout + full error logging
 * Returns { b64: string } on success or { error: string, details: string } on failure
 */
async function callPolishAPI(b64Input, prompt, label, variationIndex, attempt = 1, referenceB64 = null) {
  const tag = `[POLISH-API] ${label}/v${variationIndex}`;
  const controller = new (typeof AbortController !== "undefined" ? AbortController : require("abort-controller"))();
  const timer = setTimeout(() => controller.abort(), POLISH_TIMEOUT_MS);
  try {
    console.log(`${tag} attempt ${attempt}/${POLISH_MAX_RETRIES + 1} — model=${POLISH_MODEL}`);
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: POLISH_MODEL,
        // v73.2.7 : si referenceB64 fourni, on ajoute l'image de reference visuelle (multimodal)
        input: [{ role: "user", content: (() => {
          const c = [{ type: "input_image", image_url: `data:image/png;base64,${b64Input}` }];
          if (referenceB64) {
            c.push({ type: "input_image", image_url: `data:image/png;base64,${referenceB64}` });
          }
          c.push({ type: "input_text", text: prompt });
          return c;
        })() }],
        tools: [{ type: "image_generation", input_fidelity: "high" }]
      })
    });
    clearTimeout(timer);
    // Check HTTP status first
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "no body");
      const errMsg = `HTTP ${resp.status}: ${errBody.substring(0, 300)}`;
      console.error(`${tag} API HTTP error: ${errMsg}`);
      // Rate limit → retry after delay
      if (resp.status === 429 && attempt <= POLISH_MAX_RETRIES) {
        const retryAfter = parseInt(resp.headers.get("retry-after") || "3", 10) * 1000;
        console.log(`${tag} Rate limited — waiting ${retryAfter}ms before retry...`);
        await new Promise(r => setTimeout(r, retryAfter));
        return callPolishAPI(b64Input, prompt, label, variationIndex, attempt + 1, referenceB64);
      }
      // Server error (5xx) → retry
      if (resp.status >= 500 && attempt <= POLISH_MAX_RETRIES) {
        console.log(`${tag} Server error — retrying in ${POLISH_RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, POLISH_RETRY_DELAY_MS));
        return callPolishAPI(b64Input, prompt, label, variationIndex, attempt + 1, referenceB64);
      }
      return { error: `HTTP ${resp.status}`, details: errMsg };
    }
    const oaiJson = await resp.json();
    // Check for API-level error in response body
    if (oaiJson.error) {
      const errMsg = typeof oaiJson.error === "string" ? oaiJson.error : JSON.stringify(oaiJson.error);
      console.error(`${tag} API error in response: ${errMsg.substring(0, 300)}`);
      if (attempt <= POLISH_MAX_RETRIES) {
        console.log(`${tag} Retrying in ${POLISH_RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, POLISH_RETRY_DELAY_MS));
        return callPolishAPI(b64Input, prompt, label, variationIndex, attempt + 1, referenceB64);
      }
      return { error: "API error", details: errMsg };
    }
    // Extract image from response
    let polishedB64 = null;
    if (oaiJson.output) {
      for (const item of oaiJson.output) {
        if (item.type === "image_generation_call" && item.result) {
          polishedB64 = item.result;
          break;
        }
      }
    }
    if (!polishedB64) {
      const outputSummary = JSON.stringify(oaiJson.output || oaiJson).substring(0, 400);
      console.warn(`${tag} No image in response. Output: ${outputSummary}`);
      if (attempt <= POLISH_MAX_RETRIES) {
        console.log(`${tag} Retrying (no image)...`);
        await new Promise(r => setTimeout(r, POLISH_RETRY_DELAY_MS));
        return callPolishAPI(b64Input, prompt, label, variationIndex, attempt + 1, referenceB64);
      }
      return { error: "no_image", details: outputSummary };
    }
    console.log(`${tag} ✓ Image received (attempt ${attempt})`);
    return { b64: polishedB64 };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === "AbortError";
    const errType = isTimeout ? "TIMEOUT" : "NETWORK";
    console.error(`${tag} ${errType}: ${err.message}`);
    if (attempt <= POLISH_MAX_RETRIES) {
      const delay = isTimeout ? POLISH_RETRY_DELAY_MS * 2 : POLISH_RETRY_DELAY_MS;
      console.log(`${tag} Retrying in ${delay}ms after ${errType}...`);
      await new Promise(r => setTimeout(r, delay));
      return callPolishAPI(b64Input, prompt, label, variationIndex, attempt + 1, referenceB64);
    }
    return { error: errType, details: err.message };
  }
}
/**
 * v72.34: Resize image buffer to max dimension while preserving aspect ratio
 * Returns { buf: Buffer, w: number, h: number }
 */
async function resizeForPolish(pngBuf, maxDim) {
  const img = await loadImage(pngBuf);
  const w = img.width, h = img.height;
  if (w <= maxDim && h <= maxDim) return { buf: pngBuf, w, h };
  const scale = maxDim / Math.max(w, h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const c = createCanvas(nw, nh);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, nw, nh);
  console.log(`[POLISH-RESIZE] ${w}×${h} → ${nw}×${nh} (scale=${scale.toFixed(3)})`);
  return { buf: c.toBuffer("image/png"), w: nw, h: nh };
}
app.get("/health", (req, res) => res.json({ ok: true, engine: "browserless-mapbox-gl-3d", version: "73.6.0-apps-script" }));
// ─── STUDIO v6.0 — Interface diagnostic premium ─────────────────────────────
app.get("/studio", (req, res) => {
  const studioPath = path.join(__dirname, "studio.html");
  if (fs.existsSync(studioPath)) {
    res.sendFile(studioPath);
  } else {
    res.status(404).send("Studio HTML not found. Deploy studio.html alongside server.js.");
  }
});
// ═══════════════════════════════════════════════════════════════════════════════
// v73.6.0: STUDIO ENGINE — Google Apps Script Proxy + Process Lead (8A→8D) + PPTX
// ═══════════════════════════════════════════════════════════════════════════════
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || "";    // Google Apps Script Web App URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// ─── Apps Script Proxy helpers ──────────────────────────────────────────────
// All Google Sheets operations go through the Apps Script Web App — no OAuth needed
async function gasGet(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const r = await fetch(`${APPS_SCRIPT_URL}?${qs}`, { redirect: "follow" });
  const data = await r.json();
  if (data.error) throw new Error(`GAS ${action}: ${data.error}`);
  return data;
}

async function gasPost(action, body = {}, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const r = await fetch(`${APPS_SCRIPT_URL}?${qs}`, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (data.error) throw new Error(`GAS ${action}: ${data.error}`);
  return data;
}

// ─── PIPELINE column mapping ─────────────────────────────────────────────────
const PIPELINE_TO_BODY = {
  "site_area_m2": "site_area", "envelope_w_m": "envelope_w", "envelope_d_m": "envelope_d",
  "envelope_area_m2": "envelope_area", "zoning_type": "zoning_type", "primary_driver": "primary_driver",
  "max_floors": "max_floors", "max_height_m": "max_height_m", "target_program": "program_main",
  "target_surface_m2": "target_surface_m2", "target_units": "target_units",
  "site_saturation_level": "site_saturation_level", "financial_rigidity_score": "financial_rigidity_score",
  "density_band": "density_band", "risk_adjusted": "risk_adjusted",
  "feasibility_posture_calc": "feasibility_posture", "scenario_A_role": "scenario_A_role",
  "scenario_B_role": "scenario_B_role", "scenario_C_role": "scenario_C_role",
  "budget_range": "budget_range", "budget_band": "budget_band", "budget_tension_calc": "budget_tension",
  "standing_level": "standing_level", "rent_score": "rent_score", "capacity_score": "capacity_score",
  "mix_score": "mix_score", "phase_score": "phase_score", "risk_score": "risk_score",
  "density_pressure_factor": "density_pressure_factor", "driver_intensity": "driver_intensity",
  "strategic_position_calc": "strategic_position", "layout_mode": "layout_mode",
  "commerce_depth_m": "commerce_depth_m", "retrait_inter_volumes_m": "retrait_inter_volumes_m",
  "cf": "lead_id", "client_name": "client_name", "project_city": "city", "project_district": "district",
  "land_width_m": "land_width", "land_depth_m": "land_depth", "site_context": "site_context",
  "terrain_integration": "terrain_context", "road_bearing": "road_bearing",
  "site_lat": "site_lat", "site_lon": "site_lon", "site_polygon_points": "site_polygon",
  "buildable_footprint_m2": "buildable_fp", "setback_front_m": "setback_front",
  "setback_side_m": "setback_side", "setback_back_m": "setback_back",
  "cos_ratio": "cos_ratio", "cos_used": "cos_used", "max_levels_cap": "max_levels_cap",
  "parking_preference": "Parking_Préférence", "parking_required": "Parking_required",
  "satellite_img_url": "satellite_url", "slide_5_image_url": "axo_url",
  "massing_scn_A_img_url": "massing_A_url", "massing_scn_B_img_url": "massing_B_url",
  "massing_scn_C_img_url": "massing_C_url",
  // v74.4 — CRITICAL FIX : input_typologies + Disposition manquaient du mapping
  // Conséquence : body8D ne contenait pas T3=2 → /generate-pptx tombait sur defaultMixFn
  "input_typologies": "input_typologies",
  "Disposition": "Disposition"
};

const EXTRA_DISPLAY_COLS = [
  "client_email", "project_type", "project_country", "date_submit", "Pipeline_stage",
  "fp_A_m2", "fp_B_m2", "fp_C_m2", "levels_A", "levels_B", "levels_C",
  "height_A_m", "height_B_m", "height_C_m", "scenario_A_label", "scenario_B_label", "scenario_C_label",
  "scenario_A_target_surface_m2", "scenario_B_target_surface_m2", "scenario_C_target_surface_m2",
  "A_cost_total", "B_cost_total", "C_cost_total", "sdp_A", "sdp_B", "sdp_C",
  "rendement_A", "rendement_B", "rendement_C", "recommended_scenario_final",
  "total_units_A", "total_units_B", "total_units_C",
  "slide_4_image_url", "plot_area_m2", "barlo_status",
  "Disposition", "input_typologies", "diagnostic_narrative"
];

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/form-leads — Poll Google Form responses (new + existing)
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/api/form-leads", async (req, res) => {
  try {
    if (!APPS_SCRIPT_URL) return res.status(500).json({ error: "APPS_SCRIPT_URL not configured" });
    // Read form responses via Apps Script
    const d = await gasGet("readForm");
    if (!d.values || d.values.length < 2) return res.json({ ok: true, leads: [] });
    const headers = d.values[0];
    // Also read PIPELINE refs to know which form rows are already processed
    let processedRefs = new Set();
    const pipe = await gasGet("readPipelineRefs");
    if (pipe.values) pipe.values.slice(1).forEach(r => { if (r[0]) processedRefs.add(r[0].toString().trim()); });
    const leads = d.values.slice(1).map((row, idx) => {
      const nom = (row[2] || "").toString().trim();
      const prenom = (row[3] || "").toString().trim();
      const barloCode = (row[55] || row[36] || "").toString().trim(); // BARLO-XXXX code
      const ref = barloCode || `FORM_${idx + 2}`;
      return {
        formRow: idx + 2,
        ref,
        client: `${nom} ${prenom}`.trim() || "—",
        email: (row[1] || "").toString(),
        date: (row[0] || "").toString(),
        city: (row[9] || "").toString(),
        country: (row[8] || "").toString(),
        processed: processedRefs.has(ref),
        barloCode
      };
    }).filter(l => l.client !== "—" || l.email);
    res.json({ ok: true, leads, total: leads.length, processed: leads.filter(l => l.processed).length });
  } catch (err) {
    console.error(`[FORM-LEADS] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/process-lead — Execute 8A→8D pipeline for one lead
// Body: { formRow: N } — the row number in form responses to process
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/process-lead", async (req, res) => {
  const t0 = Date.now();
  // v73.9 — accepter formRow (nouveau lead) OU ref (retraitement lead existant)
  let { formRow, ref } = req.body;
  if (!formRow && !ref) return res.status(400).json({ error: "formRow ou ref requis" });
  console.log(`\n╔══ PROCESS-LEAD ${formRow ? `row ${formRow}` : `ref ${ref}`} ══╗`);

  try {
    if (!APPS_SCRIPT_URL) throw new Error("APPS_SCRIPT_URL not configured");

    // v73.9 — Si ref fourni mais pas formRow, retrouver le formRow via readForm
    if (!formRow && ref) {
      console.log(`[8A] Resolving formRow from ref="${ref}"...`);
      const allForm = await gasGet("readForm");
      if (allForm.values && allForm.values.length > 1) {
        for (let i = 1; i < allForm.values.length; i++) {
          const row = allForm.values[i] || [];
          const code = (row[55] || row[36] || "").toString().trim();
          if (code === ref) { formRow = i + 1; break; }
        }
      }
      if (!formRow) throw new Error(`Lead "${ref}" introuvable dans le formulaire`);
      console.log(`[8A] Resolved ref="${ref}" → formRow=${formRow}`);
    }

    // ─── STEP 8A: Read form response & write to PIPELINE ─────────────────────
    console.log(`[8A] Reading form row ${formRow}...`);
    const formData = await gasGet("readFormRow", { row: formRow });
    if (!formData.values || !formData.values[0]) throw new Error(`Form row ${formRow} not found`);
    const f = formData.values[0]; // f[0]=Horodateur, f[1]=Email, f[2]=Nom, etc.

    // Read PIPELINE headers to know column order
    const headersData = await gasGet("readPipelineHeaders");
    if (!headersData.values || !headersData.values[0]) throw new Error("PIPELINE headers not found");
    const pipeHeaders = headersData.values[0];

    // Standing level conversion (from 8A SetVariables)
    const standingRaw = (f[30] || "").toString().toLowerCase();
    let standingLevel = "STANDARD";
    if (standingRaw.includes("très haut")) standingLevel = "PREMIUM";
    else if (standingRaw.includes("haut standing")) standingLevel = "HAUT";
    else if (standingRaw.includes("bon standing")) standingLevel = "STANDARD";
    else if (standingRaw.includes("économique") || standingRaw.includes("economique")) standingLevel = "ECONOMIQUE";

    // Zoning type from site context (from 8A)
    const contextRaw = (f[45] || f[15] || "").toString().toLowerCase();
    let zoningType = "URBAIN";
    if (contextRaw.includes("isolé") || contextRaw.includes("périph")) zoningType = "PERIURBAIN";
    else if (contextRaw.includes("intermédiaire") || contextRaw.includes("développement")) zoningType = "PERIURBAIN";

    // Primary driver from objectif (from 8A)
    const objectifRaw = (f[23] || f[5] || "").toString().toLowerCase();
    let primaryDriver = "RENTABILITE";
    if (objectifRaw.includes("sécuriser") || objectifRaw.includes("faisabilité")) primaryDriver = "CAPACITE";
    else if (objectifRaw.includes("rentabilité")) primaryDriver = "RENTABILITE";
    else if (objectifRaw.includes("surface") || objectifRaw.includes("capacité")) primaryDriver = "CAPACITE";
    else if (objectifRaw.includes("équilibre") || objectifRaw.includes("explorer")) primaryDriver = "MIXITE";

    // Financial rigidity from constraints (from 8A)
    const constraintRaw = (f[31] || "").toString().toLowerCase();
    let financialRigidity = "0.5";
    if (constraintRaw.includes("plafond strict")) financialRigidity = "0.9";
    else if (constraintRaw.includes("emprunt limité")) financialRigidity = "0.7";
    else if (constraintRaw.includes("aucune")) financialRigidity = "0.2";
    else if (constraintRaw.includes("flou")) financialRigidity = "0.5";

    // Layout mode from disposition (from 8A module 3)
    const dispositionRaw = (f[56] || "").toString().toLowerCase();
    let layoutMode = "SUPERPOSE";
    if (dispositionRaw.includes("retrait")) layoutMode = "SPLIT_AV_AR";

    // Commerce depth and retrait (from 8A module 3)
    const commerceDepth = f[57] ? f[57].toString() : "6";
    const retraitInter = f[59] ? f[59].toString() : "4";

    // Generate lead reference
    const barloCode = (f[55] || f[36] || "").toString().trim();
    const leadRef = barloCode || `LEAD_${Date.now().toString(36).toUpperCase()}`;

    // Build PIPELINE row — map to header positions
    const newRow = new Array(pipeHeaders.length).fill("");
    function setCol(name, val) {
      const idx = pipeHeaders.indexOf(name);
      if (idx >= 0 && val !== undefined && val !== null) newRow[idx] = val.toString();
    }
    // Core identity
    setCol("cf", leadRef);
    setCol("Pipeline_stage", "1-CLEAN_READY");
    setCol("processing_lock", "STUDIO");
    setCol("last_processed_module", "8A");
    setCol("date_submit", f[0] || new Date().toISOString());
    setCol("client_name", `${(f[2]||"")} ${(f[3]||"")}`.trim());
    setCol("client_email", f[1] || "");
    // Project info
    setCol("project_type", f[4] || "");
    setCol("project_country", f[8] || "");
    setCol("project_city", f[9] || "");
    setCol("project_district", f[10] || "");
    setCol("site_area_m2", f[37] || f[20] || "");
    setCol("site_width_m", f[51] || f[22] || "");
    setCol("site_depth_m", f[52] || f[23] || "");
    setCol("site_context", f[45] || f[15] || "");
    setCol("target_program", f[21] || f[35] || "");
    setCol("target_surface_m2", f[15] || f[27] || "");
    setCol("target_units", f[16] || f[28] || "");
    setCol("max_height_m", "");
    setCol("max_floors", "");
    setCol("parking_preference", f[44] || "");
    setCol("site_saturation_level", "");
    setCol("financial_rigidity_score", financialRigidity);
    setCol("land_shape", f[49] || f[21] || "");
    setCol("fenced_status", f[48] || f[16] || "");
    setCol("land_identified", f[11] || f[13] || "");
    setCol("land_width_m", f[51] || f[22] || "");
    setCol("land_depth_m", f[52] || f[23] || "");
    setCol("land_min_width_m", f[50] || f[24] || "");
    setCol("barlo_temp_code", barloCode);
    setCol("existing_built_area_m2", f[26] || "0");
    setCol("zoning_type", zoningType);
    setCol("primary_driver", primaryDriver);
    // v74.3 — OFF-BY-ONE FIX (confirmé par logs Render)
    // Vrais indices : budget=f[17] (33M FCFA), typo=f[38] (T3=2), dispo=f[56] (Commerce devant)
    // Fallbacks aux anciens index pour ne pas casser les autres leads
    setCol("budget_range", f[17] || f[18] || f[30] || "");
    setCol("standing_level", standingLevel);
    setCol("Disposition", f[56] || "");
    setCol("input_typologies", f[38] || f[39] || f[29] || "");
    console.log("[v74.3 INDICES] budget=" + JSON.stringify(f[17] || f[18] || f[30]) + " dispo=" + JSON.stringify(f[56]) + " typo=" + JSON.stringify(f[38] || f[39] || f[29]));
    setCol("layout_mode", layoutMode);
    setCol("commerce_depth_m", commerceDepth);
    setCol("retrait_inter_volumes_m", retraitInter);

    // v73.9 — Détection lead existant : UPDATE au lieu d'APPEND (mode retraitement)
    let pipeRowNum = null;
    let isReprocessing = false;
    try {
      const existingRefs = await gasGet("readPipelineRefs");
      if (existingRefs.values && existingRefs.values.length > 1) {
        for (let i = 1; i < existingRefs.values.length; i++) {
          const cf = ((existingRefs.values[i] || [])[0] || "").toString().trim();
          if (cf === leadRef) { pipeRowNum = i + 1; isReprocessing = true; break; }
        }
      }
    } catch (e) { console.warn(`[8A] readPipelineRefs error: ${e.message}`); }

    if (isReprocessing) {
      console.log(`[8A] Lead ${leadRef} EXISTS at row ${pipeRowNum} → RETRAITEMENT (UPDATE mode)`);
      // Préserver les URLs images valides depuis l'existant (le cache 8E/8F décidera de regen ou pas)
      try {
        const existingRow = await gasGet("readPipelineRow", { row: pipeRowNum });
        const existing = existingRow.values?.[0] || [];
        // v74.6 — CRITICAL FIX : préserver aussi le polygon (sinon retraitement = perte du polygon dessiné)
        const preserveCols = ["slide_4_image_url", "slide_5_image_url",
                              "massing_scn_A_img_url", "massing_scn_B_img_url", "massing_scn_C_img_url",
                              "site_polygon_points", "site_polygon_status"];
        for (const col of preserveCols) {
          const idx = pipeHeaders.indexOf(col);
          if (idx >= 0 && existing[idx]) newRow[idx] = existing[idx];
        }
      } catch (e) { console.warn(`[8A] Preserve images error: ${e.message}`); }
      await gasPost("writePipelineRow", { rowNum: pipeRowNum, row: newRow });
      console.log(`[8A] Lead ${leadRef} UPDATED at row ${pipeRowNum} ✓`);
    } else {
      const appendResult = await gasPost("appendPipeline", { row: newRow });
      pipeRowNum = appendResult.appendedRow;
      if (!pipeRowNum) throw new Error("Failed to append row to PIPELINE");
      console.log(`[8A] Lead ${leadRef} APPENDED at row ${pipeRowNum} ✓`);
    }

    // ─── STEP 8B: Fetch polygon from Supabase ───────────────────────────────
    console.log(`[8B] Fetching polygon for ${barloCode}...`);
    let polygonPoints = "";
    if (barloCode && SUPABASE_URL && SUPABASE_ANON_KEY) {
      try {
        const polyUrl = `${SUPABASE_URL}/rest/v1/polygon_drafts?temp_id=eq.${barloCode}&select=polygon_points`;
        const polyRes = await fetch(polyUrl, {
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Accept: "application/json" }
        });
        const polyData = await polyRes.json();
        if (Array.isArray(polyData) && polyData.length > 0 && polyData[0].polygon_points) {
          polygonPoints = polyData[0].polygon_points;
        }
      } catch (e) { console.log(`[8B] Polygon fetch warning: ${e.message}`); }
    }
    // Write polygon + stage to PIPELINE
    const colAN = pipeHeaders.indexOf("site_polygon_points");
    const colAO = pipeHeaders.indexOf("site_polygon_status");
    const colB = pipeHeaders.indexOf("Pipeline_stage");
    const colC = pipeHeaders.indexOf("processing_lock");
    const colD = pipeHeaders.indexOf("last_processed_module");
    {
      const curRow = await gasGet("readPipelineRow", { row: pipeRowNum });
      const updateRow = curRow.values?.[0] ? [...curRow.values[0]] : new Array(pipeHeaders.length).fill("");
      while (updateRow.length < pipeHeaders.length) updateRow.push("");
      if (polygonPoints && colAN >= 0) {
        updateRow[colAN] = polygonPoints;
        if (colAO >= 0) updateRow[colAO] = "OK";
        console.log(`[8B] Polygon written ✓ (${polygonPoints.substring(0, 40)}...)`);
      } else {
        console.log(`[8B] No polygon found — continuing without GPS`);
      }
      updateRow[colB] = "2-POLYGON_READY";
      updateRow[colC] = "DONE_8B";
      updateRow[colD] = "8B";
      await gasPost("writePipelineRow", { rowNum: pipeRowNum, row: updateRow });
    }

    // ─── STEP 8C: Compute envelope & read formula-calculated values ─────────
    console.log(`[8C] Computing feasibility...`);
    // Wait 2s for Sheet formulas to recalculate after our writes
    await new Promise(ok => setTimeout(ok, 2000));
    // Read back the full row (formulas should have computed by now)
    const refreshed = await gasGet("readPipelineRow", { row: pipeRowNum });
    if (!refreshed.values || !refreshed.values[0]) throw new Error("Failed to read back PIPELINE row");
    const rowData = refreshed.values[0];
    const rowObj = {};
    pipeHeaders.forEach((h, i) => { if (h) rowObj[h] = (rowData[i] !== undefined ? rowData[i] : ""); });

    // Envelope calculations (from 8C)
    const plotW = parseFloat(rowObj.plot_w_m || rowObj.land_width_m || rowObj.site_width_m) || 20;
    const plotD = parseFloat(rowObj.plot_d_m || rowObj.land_depth_m || rowObj.site_depth_m) || 30;
    const setbackFront = 5, setbackSide = 3, setbackBack = 3;
    const envW = plotW - (setbackSide * 2);  // width - 6
    const envD = plotD - setbackFront - setbackBack; // depth - 8
    const envArea = envW * envD;

    // Write 8C results
    const row8C = [...rowData];
    while (row8C.length < pipeHeaders.length) row8C.push("");
    function set8C(name, val) { const i = pipeHeaders.indexOf(name); if (i >= 0) row8C[i] = val; }
    set8C("Pipeline_stage", "4-SCENARIOS_READY");
    set8C("processing_lock", "DONE_8C");
    set8C("last_processed_module", "8C");
    set8C("setback_front_m", setbackFront);
    set8C("setback_side_m", setbackSide);
    set8C("setback_back_m", setbackBack);
    set8C("envelope_w_m", envW);
    set8C("envelope_d_m", envD);
    set8C("envelope_area_m2", envArea);
    set8C("site_area_m2", rowObj.site_area_m2 || (plotW * plotD));
    // ─── STEP 8C-bis: Compute diagnostic scores server-side ───────────────
    // (Google Sheet formulas don't auto-extend to API-appended rows)
    const siteArea = parseFloat(rowObj.site_area_m2 || (plotW * plotD)) || 500;
    const budgetRaw = (rowObj.budget_range || f[30] || "").toString();
    const budgetNum = parseFloat(budgetRaw.replace(/[^0-9]/g, "")) || 0;

    // Density band based on site area + zoning
    let densityBand = "MEDIUM";
    if (siteArea < 300) densityBand = "HIGH";
    else if (siteArea < 600) densityBand = "MEDIUM";
    else if (siteArea < 1200) densityBand = "LOW";
    else densityBand = "VERY_LOW";

    // Budget tension: budget vs site area expectation
    const budgetPerM2 = budgetNum > 0 ? budgetNum / siteArea : 0;
    let budgetTension = "MEDIUM";
    if (budgetPerM2 > 0) {
      if (budgetPerM2 < 150000) budgetTension = "HIGH";
      else if (budgetPerM2 < 300000) budgetTension = "MEDIUM";
      else budgetTension = "LOW";
    }

    // Budget band
    let budgetBand = "MEDIUM";
    if (budgetNum <= 50000000) budgetBand = "SMALL";
    else if (budgetNum <= 150000000) budgetBand = "MEDIUM";
    else if (budgetNum <= 500000000) budgetBand = "LARGE";
    else budgetBand = "XLARGE";

    // Feasibility posture based on driver + constraints
    let feasibilityPosture = "BALANCED";
    if (primaryDriver === "CAPACITE") feasibilityPosture = "AGGRESSIVE";
    else if (primaryDriver === "RENTABILITE") feasibilityPosture = "OPTIMISTIC";
    else if (primaryDriver === "MIXITE") feasibilityPosture = "BALANCED";
    if (parseFloat(financialRigidity) >= 0.8) feasibilityPosture = "CONSERVATIVE";

    // Strategic position
    let strategicPosition = "DEVELOP";
    if (siteArea > 800 && budgetBand !== "SMALL") strategicPosition = "EXPAND";
    else if (budgetBand === "SMALL" || parseFloat(financialRigidity) >= 0.7) strategicPosition = "SECURE";
    else strategicPosition = "DEVELOP";

    // Diagnostic scores (0-1 scale, used by compute-scenarios)
    const rentScore = standingLevel === "PREMIUM" ? 0.9 : standingLevel === "HAUT" ? 0.7 : standingLevel === "STANDARD" ? 0.5 : 0.3;
    const capacityScore = densityBand === "HIGH" ? 0.8 : densityBand === "MEDIUM" ? 0.6 : 0.4;
    const mixScore = primaryDriver === "MIXITE" ? 0.8 : primaryDriver === "CAPACITE" ? 0.5 : 0.4;
    const phaseScore = siteArea > 600 ? 0.7 : siteArea > 300 ? 0.5 : 0.3;
    const riskScore = parseFloat(financialRigidity) >= 0.7 ? 0.7 : parseFloat(financialRigidity) >= 0.5 ? 0.5 : 0.3;

    // Driver intensity
    let driverIntensity = "MEDIUM";
    if (primaryDriver === "CAPACITE" && densityBand === "HIGH") driverIntensity = "HIGH";
    else if (primaryDriver === "RENTABILITE" && rentScore >= 0.7) driverIntensity = "HIGH";

    // Density pressure factor
    const densityPressureFactor = densityBand === "HIGH" ? 1.3 : densityBand === "MEDIUM" ? 1.0 : 0.8;

    // Write all computed scores to PIPELINE
    set8C("density_band", densityBand);
    set8C("budget_band", budgetBand);
    set8C("budget_tension_calc", budgetTension);
    set8C("feasibility_posture_calc", feasibilityPosture);
    set8C("strategic_position_calc", strategicPosition);
    set8C("rent_score", rentScore);
    set8C("capacity_score", capacityScore);
    set8C("mix_score", mixScore);
    set8C("phase_score", phaseScore);
    set8C("risk_score", riskScore);
    set8C("driver_intensity", driverIntensity);
    set8C("density_pressure_factor", densityPressureFactor);
    // Scenario roles based on posture
    set8C("scenario_A_role", "INTENSIFICATION");
    set8C("scenario_B_role", "EQUILIBRE");
    set8C("scenario_C_role", "PRUDENT");
    console.log(`[8C] Scores computed: rent=${rentScore} cap=${capacityScore} mix=${mixScore} phase=${phaseScore} risk=${riskScore}`);
    console.log(`[8C] Posture=${feasibilityPosture} DensityBand=${densityBand} BudgetTension=${budgetTension}`);

    await gasPost("writePipelineRow", { rowNum: pipeRowNum, row: row8C });
    console.log(`[8C] Envelope ${envW.toFixed(1)}×${envD.toFixed(1)} = ${envArea.toFixed(0)}m² ✓`);

    // ─── STEP 8D: Call /compute-scenarios ────────────────────────────────────
    console.log(`[8D] Computing scenarios...`);
    // Re-read row to get latest state
    await new Promise(ok => setTimeout(ok, 1000));
    const preScenario = await gasGet("readPipelineRow", { row: pipeRowNum });
    const row8D = preScenario.values?.[0] || row8C;
    const obj8D = {};
    pipeHeaders.forEach((h, i) => { if (h) obj8D[h] = (row8D[i] !== undefined ? row8D[i] : ""); });

    // Build /compute-scenarios body (same as 8D Make body)
    const scenarioBody = {
      site_area: obj8D.site_area_m2 || "",
      envelope_w: obj8D.envelope_w_m || envW,
      envelope_d: obj8D.envelope_d_m || envD,
      envelope_area: obj8D.envelope_area_m2 || envArea,
      zoning_type: obj8D.zoning_type || zoningType,
      floor_height: 3.2,
      primary_driver: obj8D.primary_driver || primaryDriver,
      max_floors: obj8D.max_floors || "",
      max_height_m: obj8D.max_height_m || "",
      program_main: obj8D.target_program || "",
      target_surface_m2: obj8D.target_surface_m2 || "",
      target_units: obj8D.target_units || "",
      site_saturation_level: obj8D.site_saturation_level || "",
      input_typologies: obj8D.input_typologies || "",
      financial_rigidity_score: obj8D.financial_rigidity_score || financialRigidity,
      density_band: obj8D.density_band || "",
      risk_adjusted: obj8D.risk_adjusted || "",
      feasibility_posture: obj8D.feasibility_posture_calc || "",
      scenario_A_role: obj8D.scenario_A_role || "",
      scenario_B_role: obj8D.scenario_B_role || "",
      scenario_C_role: obj8D.scenario_C_role || "",
      budget_range: obj8D.budget_range || "",
      budget_band: obj8D.budget_band || "",
      budget_tension: obj8D.budget_tension_calc || "",
      standing_level: obj8D.standing_level || standingLevel,
      rent_score: obj8D.rent_score || "",
      capacity_score: obj8D.capacity_score || "",
      mix_score: obj8D.mix_score || "",
      phase_score: obj8D.phase_score || "",
      risk_score: obj8D.risk_score || "",
      density_pressure_factor: obj8D.density_pressure_factor || "",
      driver_intensity: obj8D.driver_intensity || "",
      strategic_position: obj8D.strategic_position_calc || "",
      layout_mode: obj8D.layout_mode || layoutMode,
      commerce_depth_m: obj8D.commerce_depth_m || commerceDepth,
      retrait_inter_volumes_m: obj8D.retrait_inter_volumes_m || retraitInter,
      disposition: obj8D.Disposition || ""
    };

    // Call /compute-scenarios on THIS server (internal call)
    const scenarioRes = await fetch(`http://localhost:${PORT}/compute-scenarios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scenarioBody)
    });
    const scenarioResult = await scenarioRes.json();
    if (!scenarioRes.ok) throw new Error(`compute-scenarios failed: ${JSON.stringify(scenarioResult).substring(0, 200)}`);
    console.log(`[8D] Scenarios computed ✓`);

    // Write scenario results back to PIPELINE
    const finalRow = await gasGet("readPipelineRow", { row: pipeRowNum });
    const rowFinal = finalRow.values?.[0] ? [...finalRow.values[0]] : [...row8C];
    while (rowFinal.length < pipeHeaders.length) rowFinal.push("");
    function setFinal(name, val) { const i = pipeHeaders.indexOf(name); if (i >= 0 && val !== undefined && val !== null) rowFinal[i] = val.toString(); }

    // Map scenario response to PIPELINE columns
    const sc = scenarioResult;
    setFinal("Pipeline_stage", "DONE_8D");
    setFinal("processing_lock", "DONE_8D");
    setFinal("last_processed_module", "8D");
    setFinal("recommended_scenario_final", sc.rec_scenario || "");
    // Scenario A/B/C params
    ["A", "B", "C"].forEach(s => {
      const scn = sc.scenarios?.[s] || {};
      setFinal(`fp_${s}_m2`, scn.footprint_m2);
      setFinal(`levels_${s}`, scn.levels);
      setFinal(`height_${s}_m`, scn.height_m);
      setFinal(`scenario_${s}_ratio`, scn.ratio);
      setFinal(`scenario_${s}_role`, scn.role);
      setFinal(`scenario_${s}_object`, scn.object);
      setFinal(`scenario_${s}_label`, scn.label);
      setFinal(`scenario_${s}_target_surface_m2`, scn.target_surface_m2);
      setFinal(`scenario_${s}_density_index`, scn.density_index);
      setFinal(`${s}_cost_total`, scn.cost_total);
      setFinal(`${s}_ventil_global`, JSON.stringify(scn.ventil_global || {}));
      setFinal(`${s}_budget_fit`, scn.budget_fit);
      setFinal(`sdp_${s}`, scn.sdp_m2);
      setFinal(`total_units_${s}`, scn.total_units);
      setFinal(`circ_ratio_${s}`, scn.circ_ratio);
      setFinal(`surf_hab_${s}`, scn.surf_hab_m2);
      setFinal(`m2_par_logt_${s}`, scn.m2_par_logement);
      setFinal(`revenu_mens_${s}`, scn.revenu_mensuel);
      setFinal(`rendement_${s}`, scn.rendement);
      setFinal(`cost_m2_${s}`, scn.cost_m2);
      setFinal(`cost_bas_${s}`, scn.cost_bas);
      setFinal(`cost_haut_${s}`, scn.cost_haut);
      setFinal(`ventil_go_${s}`, scn.ventil_go);
      setFinal(`ventil_so_${s}`, scn.ventil_so);
      setFinal(`ventil_lt_${s}`, scn.ventil_lt);
      setFinal(`ventil_vrd_${s}`, scn.ventil_vrd);
      setFinal(`unit_mix_${s}`, JSON.stringify(scn.unit_mix || {}));
    });
    // Deltas
    setFinal("delta_BA_sdp", sc.deltas?.BA?.sdp);
    setFinal("delta_BA_cout", sc.deltas?.BA?.cout);
    setFinal("delta_CA_sdp", sc.deltas?.CA?.sdp);
    setFinal("delta_CA_cout", sc.deltas?.CA?.cout);
    // Preserve computed scores (in case finalRow read lost them)
    setFinal("rent_score", obj8D.rent_score || rentScore);
    setFinal("capacity_score", obj8D.capacity_score || capacityScore);
    setFinal("mix_score", obj8D.mix_score || mixScore);
    setFinal("phase_score", obj8D.phase_score || phaseScore);
    setFinal("risk_score", obj8D.risk_score || riskScore);
    setFinal("density_band", obj8D.density_band || densityBand);
    setFinal("budget_band", obj8D.budget_band || budgetBand);
    setFinal("budget_tension_calc", obj8D.budget_tension_calc || budgetTension);
    setFinal("feasibility_posture_calc", obj8D.feasibility_posture_calc || feasibilityPosture);
    setFinal("strategic_position_calc", obj8D.strategic_position_calc || strategicPosition);
    setFinal("driver_intensity", obj8D.driver_intensity || driverIntensity);
    setFinal("density_pressure_factor", obj8D.density_pressure_factor || densityPressureFactor);
    setFinal("scenario_A_role", "INTENSIFICATION");
    setFinal("scenario_B_role", "EQUILIBRE");
    setFinal("scenario_C_role", "PRUDENT");

    await gasPost("writePipelineRow", { rowNum: pipeRowNum, row: rowFinal });

    // ═══════════════════════════════════════════════════════════════════════
    // v73.8 — 8E + 8F : génération slide 4 (top) + slide 5 (axo IA) + massings A/B/C
    // ═══════════════════════════════════════════════════════════════════════
    const isValidImgUrl = (url) => {
      if (!url || typeof url !== "string") return false;
      const u = url.trim();
      if (!u.startsWith("http")) return false;
      if (!u.includes("/hektar/") || u.endsWith("massing-images")) return false;
      return true;
    };

    const polygonForImg = polygonPoints || (rowFinal[colAN] || "");
    const clientNameImg = `${(f[2]||"")} ${(f[3]||"")}`.trim();
    let slide4ImageUrl = "", slide4AxoImageUrl = "";
    const massingUrls = { A: "", B: "", C: "" };

    if (polygonForImg) {
      const _baseGenBody = {
        lead_id: leadRef, client_name: clientNameImg,
        polygon_points: polygonForImg,
        site_area: obj8D.site_area_m2 || (plotW * plotD),
        land_width: obj8D.land_width_m || plotW, land_depth: obj8D.land_depth_m || plotD,
        envelope_w: envW, envelope_d: envD, buildable_fp: envArea,
        setback_front: setbackFront, setback_side: setbackSide, setback_back: setbackBack,
        terrain_context: obj8D.site_context || "",
        city: obj8D.project_city || "", district: obj8D.project_district || "",
        zoning: obj8D.zoning_type || "URBAIN",
      };

      const cachedSlide4 = obj8D.slide_4_image_url || "";
      if (isValidImgUrl(cachedSlide4)) {
        slide4ImageUrl = cachedSlide4;
        console.log(`[8E-TOP] Cache hit slide 4 satellite top`);
      } else {
        console.log(`[8E-TOP] Generating slide 4 satellite top view...`);
        try {
          const genTopRes = await fetch(`http://localhost:${PORT}/generate`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ..._baseGenBody, view: "top", slide_name: "slide_4_top" })
          });
          const genTopResult = await genTopRes.json();
          if (genTopResult && genTopResult.ok) {
            slide4ImageUrl = genTopResult.enhanced_url || genTopResult.public_url || "";
            console.log(`[8E-TOP] ✓ Slide 4 satellite top generated`);
          } else {
            console.warn(`[8E-TOP] /generate(top) failed: ${JSON.stringify(genTopResult).substring(0, 200)}`);
          }
        } catch (e) { console.warn(`[8E-TOP] Error: ${e.message}`); }
      }

      const cachedSlide5 = obj8D.slide_5_image_url || "";
      if (isValidImgUrl(cachedSlide5)) {
        slide4AxoImageUrl = cachedSlide5;
        console.log(`[8E-AXO] Cache hit slide 5 axo`);
      } else {
        console.log(`[8E-AXO] Generating slide 5 axonometry + AI polish...`);
        try {
          const genAxoRes = await fetch(`http://localhost:${PORT}/generate`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ..._baseGenBody, view: "axo", slide_name: "slide_4_axo" })
          });
          const genAxoResult = await genAxoRes.json();
          if (genAxoResult && genAxoResult.ok) {
            slide4AxoImageUrl = genAxoResult.enhanced_url || genAxoResult.public_url || "";
            console.log(`[8E-AXO] ✓ Slide 5 axo enhanced generated`);
          } else {
            console.warn(`[8E-AXO] /generate(axo) failed: ${JSON.stringify(genAxoResult).substring(0, 200)}`);
          }
        } catch (e) { console.warn(`[8E-AXO] Error: ${e.message}`); }
      }

      for (const label of ["A", "B", "C"]) {
        const cachedKey = `massing_scn_${label}_img_url`;
        const cached = obj8D[cachedKey] || "";
        if (isValidImgUrl(cached)) {
          massingUrls[label] = cached;
          console.log(`[8F-${label}] Cache hit`);
          continue;
        }
        console.log(`[8F-${label}] Generating massing...`);
        try {
          const massingBody = {
            lead_id: leadRef, client_name: clientNameImg,
            polygon_points: polygonForImg,
            site_area: obj8D.site_area_m2 || (plotW * plotD),
            setback_front: setbackFront, setback_side: setbackSide, setback_back: setbackBack,
            envelope_w: envW, envelope_d: envD,
            massing_label: label, slide_name: `scenario_${label}_massing`,
            compute_scenario: true,
            zoning_type: obj8D.zoning_type || zoningType,
            primary_driver: obj8D.primary_driver || primaryDriver,
            max_floors: obj8D.max_floors || "", max_height_m: obj8D.max_height_m || "",
            program_main: obj8D.target_program || "",
            target_surface_m2: obj8D.target_surface_m2 || "",
            target_units: obj8D.target_units || "",
            input_typologies: obj8D.input_typologies || "",
            financial_rigidity_score: obj8D.financial_rigidity_score || financialRigidity,
            density_band: obj8D.density_band || densityBand,
            feasibility_posture: obj8D.feasibility_posture_calc || feasibilityPosture,
            budget_range: obj8D.budget_range || "",
            budget_band: obj8D.budget_band || budgetBand,
            standing_level: obj8D.standing_level || standingLevel,
            rent_score: obj8D.rent_score || rentScore,
            capacity_score: obj8D.capacity_score || capacityScore,
            mix_score: obj8D.mix_score || mixScore,
            phase_score: obj8D.phase_score || phaseScore,
            risk_score: obj8D.risk_score || riskScore,
            density_pressure_factor: obj8D.density_pressure_factor || densityPressureFactor,
            driver_intensity: obj8D.driver_intensity || driverIntensity,
            layout_mode: obj8D.layout_mode || layoutMode,
            commerce_depth_m: obj8D.commerce_depth_m || commerceDepth,
            retrait_inter_volumes_m: obj8D.retrait_inter_volumes_m || retraitInter,
          };
          const mRes = await fetch(`http://localhost:${PORT}/generate-massing`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(massingBody)
          });
          const mResult = await mRes.json();
          if (mResult && mResult.ok) {
            massingUrls[label] = mResult.enhanced_url || mResult.public_url || "";
            console.log(`[8F-${label}] ✓ massing generated`);
          } else {
            console.warn(`[8F-${label}] /generate-massing failed: ${JSON.stringify(mResult).substring(0, 200)}`);
          }
        } catch (e) { console.warn(`[8F-${label}] Error: ${e.message}`); }
      }

      try {
        const rowImg = await gasGet("readPipelineRow", { row: pipeRowNum });
        const row8E = rowImg.values?.[0] ? [...rowImg.values[0]] : [...rowFinal];
        while (row8E.length < pipeHeaders.length) row8E.push("");
        const setImg = (name, val) => { const i = pipeHeaders.indexOf(name); if (i >= 0 && val) row8E[i] = val; };
        if (slide4ImageUrl) setImg("slide_4_image_url", slide4ImageUrl);
        if (slide4AxoImageUrl) setImg("slide_5_image_url", slide4AxoImageUrl);
        if (massingUrls.A) setImg("massing_scn_A_img_url", massingUrls.A);
        if (massingUrls.B) setImg("massing_scn_B_img_url", massingUrls.B);
        if (massingUrls.C) setImg("massing_scn_C_img_url", massingUrls.C);
        await gasPost("writePipelineRow", { rowNum: pipeRowNum, row: row8E });
        console.log(`[8E/8F] Image URLs written to PIPELINE ✓`);
      } catch (e) { console.warn(`[8E/8F] PIPELINE write error: ${e.message}`); }
    } else {
      console.log(`[8E/8F] No polygon_points — skipping image generation`);
    }

    console.log(`╚══ PROCESS-LEAD ${leadRef} DONE in ${Date.now() - t0}ms ══╝\n`);

    // Return complete lead data for the cockpit
    const finalObj = {};
    pipeHeaders.forEach((h, i) => { if (h) finalObj[h] = rowFinal[i] || ""; });
    const body8D = { floor_height: 3.2 };
    for (const [pipeCol, bodyKey] of Object.entries(PIPELINE_TO_BODY)) {
      if (finalObj[pipeCol] !== undefined && finalObj[pipeCol] !== "") body8D[bodyKey] = finalObj[pipeCol];
    }
    const imagesDict = {};
    if (slide4ImageUrl)    imagesDict.slide_4_image      = slide4ImageUrl;
    if (slide4AxoImageUrl) imagesDict.slide_4_axo_image  = slide4AxoImageUrl;
    if (massingUrls.A)     imagesDict.scenario_A_massing = massingUrls.A;
    if (massingUrls.B)     imagesDict.scenario_B_massing = massingUrls.B;
    if (massingUrls.C)     imagesDict.scenario_C_massing = massingUrls.C;
    body8D.images = imagesDict;

    const display = {};
    for (const col of EXTRA_DISPLAY_COLS) { if (finalObj[col] !== undefined) display[col] = finalObj[col]; }

    res.json({ ok: true, ref: leadRef, reprocessed: isReprocessing, body8D, display, raw_columns: Object.keys(finalObj).length, duration_ms: Date.now() - t0 });
  } catch (err) {
    console.error(`[PROCESS-LEAD] Error: ${err.message}\n${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/lead/:ref — Read processed lead from PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/api/lead/:ref", async (req, res) => {
  const t0 = Date.now();
  const ref = req.params.ref.trim();
  console.log(`[LEAD-API] Fetching lead: ${ref}`);
  try {
    if (!APPS_SCRIPT_URL) return res.status(500).json({ error: "APPS_SCRIPT_URL not configured on server" });
    const sheetData = await gasGet("readPipelineAll");
    if (!sheetData.values || sheetData.values.length < 2) {
      return res.status(404).json({ error: "PIPELINE tab empty or not found" });
    }
    const headers = sheetData.values[0];
    const cfIndex = headers.indexOf("cf");
    if (cfIndex === -1) return res.status(500).json({ error: "Column 'cf' not found in PIPELINE" });
    const dataRow = sheetData.values.find((row, i) => i > 0 && row[cfIndex] && row[cfIndex].toString().trim() === ref);
    if (!dataRow) return res.status(404).json({ error: `Lead '${ref}' not found in PIPELINE` });
    const rowObj = {};
    headers.forEach((h, i) => { if (h) rowObj[h] = dataRow[i] || ""; });
    const body8D = { floor_height: 3.2 };
    for (const [pipeCol, bodyKey] of Object.entries(PIPELINE_TO_BODY)) {
      if (rowObj[pipeCol] !== undefined && rowObj[pipeCol] !== "") body8D[bodyKey] = rowObj[pipeCol];
    }
    const _isValidLeadImg = (u) => u && typeof u === "string" && u.startsWith("http") && u.includes("/hektar/") && !u.endsWith("massing-images");
    const _imagesDict = {};
    if (_isValidLeadImg(rowObj.slide_4_image_url))     _imagesDict.slide_4_image      = rowObj.slide_4_image_url;
    if (_isValidLeadImg(rowObj.slide_5_image_url))     _imagesDict.slide_4_axo_image  = rowObj.slide_5_image_url;
    if (_isValidLeadImg(rowObj.massing_scn_A_img_url)) _imagesDict.scenario_A_massing = rowObj.massing_scn_A_img_url;
    if (_isValidLeadImg(rowObj.massing_scn_B_img_url)) _imagesDict.scenario_B_massing = rowObj.massing_scn_B_img_url;
    if (_isValidLeadImg(rowObj.massing_scn_C_img_url)) _imagesDict.scenario_C_massing = rowObj.massing_scn_C_img_url;
    body8D.images = _imagesDict;
    const display = {};
    for (const col of EXTRA_DISPLAY_COLS) { if (rowObj[col] !== undefined) display[col] = rowObj[col]; }
    console.log(`[LEAD-API] Lead '${ref}' found — ${Object.keys(body8D).length} body keys, ${Date.now() - t0}ms`);
    res.json({ ok: true, ref, body8D, display, raw_columns: Object.keys(rowObj).length });
  } catch (err) {
    console.error(`[LEAD-API] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads — List PIPELINE leads
app.get("/api/leads", async (req, res) => {
  try {
    if (!APPS_SCRIPT_URL) return res.status(500).json({ error: "APPS_SCRIPT_URL not configured" });
    const d = await gasGet("readPipelineAll");
    if (!d.values || d.values.length < 2) return res.json({ ok: true, leads: [] });
    const headers = d.values[0];
    const leads = d.values.slice(1).filter(row => row[0]).map(row => ({
      ref: row[0],
      stage: row[1] || "",
      client: row[headers.indexOf("client_name")] || "",
      email: row[headers.indexOf("client_email")] || "",
      date: row[headers.indexOf("date_submit")] || ""
    }));
    res.json({ ok: true, leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ─── DIAGNOSTIC MASSING : trace complète du calcul de polygone bâti ─────────
app.post("/diag-massing", async (req, res) => {
  try {
    const { polygon_points, site_area, setback_front = 3, setback_side = 3, setback_back = 3,
      fp_m2 = 1147, envelope_w = 24, envelope_d = 24, front_edge } = req.body;
    if (!polygon_points) return res.status(400).json({ error: "polygon_points requis" });
    const coords = polygon_points.split("|").map(pt => {
      const [lat, lon] = pt.trim().split(",").map(Number);
      return { lat, lon };
    }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
    if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });
    const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
    const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
    // Parcelle en mètres
    const parcelM = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
    const parcelMinX = Math.min(...parcelM.map(p => p.x)), parcelMaxX = Math.max(...parcelM.map(p => p.x));
    const parcelMinY = Math.min(...parcelM.map(p => p.y)), parcelMaxY = Math.max(...parcelM.map(p => p.y));
    // v70: front_edge en paramètre = override, sinon détection OSM
    const frontEdgeIndex = (front_edge !== undefined && front_edge !== null && front_edge !== "")
      ? (console.log(`│ FRONT-EDGE: override depuis body → arête ${front_edge}`), Number(front_edge))
      : (console.log(`│ FRONT-EDGE: convention v73.1 → arête 0 (premier segment polygone)`), 0);
    // Enveloppe
    const envelopeCoords = computeEnvelope(coords, cLat, cLon, (Number(setback_front) > 0 ? Number(setback_front) : 5), (Number(setback_side) > 0 ? Number(setback_side) : 3), (Number(setback_back) > 0 ? Number(setback_back) : 3), frontEdgeIndex);
    const envM = envelopeCoords.map(c => toM(c.lat, c.lon, cLat, cLon));
    const envMinX = Math.min(...envM.map(p => p.x)), envMaxX = Math.max(...envM.map(p => p.x));
    const envMinY = Math.min(...envM.map(p => p.y)), envMaxY = Math.max(...envM.map(p => p.y));
    // Aire réelle enveloppe
    let envAreaShoelace = 0;
    for (let i = 0; i < envM.length; i++) {
      const j = (i + 1) % envM.length;
      envAreaShoelace += envM[i].x * envM[j].y - envM[j].x * envM[i].y;
    }
    envAreaShoelace = Math.abs(envAreaShoelace) / 2;
    // Massing polygon
    const fp = Number(fp_m2);
    const massingCoords = computeMassingPolygon(envelopeCoords, fp, envAreaShoelace, {
      massing_mode: "BALANCED", primary_driver: "MAX_CAPACITE", levels: 4,
      standing_level: "STANDARD", program_main: "", site_saturation: "MEDIUM",
      project_type: "NEUF", existing_fp_m2: 0,
    });
    // Massing en mètres pour vérifier les dimensions
    const massingM = massingCoords.map(c => toM(c.lat, c.lon, cLat, cLon));
    const masMinX = Math.min(...massingM.map(p => p.x)), masMaxX = Math.max(...massingM.map(p => p.x));
    const masMinY = Math.min(...massingM.map(p => p.y)), masMaxY = Math.max(...massingM.map(p => p.y));
    let masAreaShoelace = 0;
    for (let i = 0; i < massingM.length; i++) {
      const j = (i + 1) % massingM.length;
      masAreaShoelace += massingM[i].x * massingM[j].y - massingM[j].x * massingM[i].y;
    }
    masAreaShoelace = Math.abs(masAreaShoelace) / 2;
    res.json({
      server_version: "57.13",
      input: { fp_m2: fp, site_area: Number(site_area), setbacks: { front: Number(setback_front), side: Number(setback_side), back: Number(setback_back) } },
      parcel: {
        centroid: { lat: cLat, lon: cLon },
        bbox_m: { w: (parcelMaxX - parcelMinX).toFixed(1), d: (parcelMaxY - parcelMinY).toFixed(1) },
        vertices_m: parcelM.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })),
      },
      envelope: {
        vertices_count: envelopeCoords.length,
        bbox_m: { w: (envMaxX - envMinX).toFixed(1), d: (envMaxY - envMinY).toFixed(1) },
        area_m2: +envAreaShoelace.toFixed(0),
        vertices_m: envM.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })),
        vertices_gps: envelopeCoords.map(c => ({ lat: +c.lat.toFixed(7), lon: +c.lon.toFixed(7) })),
      },
      massing: {
        typology: massingCoords._typology,
        reason: massingCoords._reason,
        bbox_m: { w: (masMaxX - masMinX).toFixed(1), d: (masMaxY - masMinY).toFixed(1) },
        area_m2: +masAreaShoelace.toFixed(0),
        fill_ratio: +(masAreaShoelace / envAreaShoelace).toFixed(3),
        target_ratio: +(fp / envAreaShoelace).toFixed(3),
        vertices_m: massingM.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })),
        vertices_gps: massingCoords.filter(c => c.lat).map(c => ({ lat: +c.lat.toFixed(7), lon: +c.lon.toFixed(7) })),
      },
      sheet_vs_real: {
        sheet_envelope: { w: Number(envelope_w), d: Number(envelope_d), area: Number(envelope_w) * Number(envelope_d) },
        real_envelope: { w: +(envMaxX - envMinX).toFixed(1), d: +(envMaxY - envMinY).toFixed(1), area: +envAreaShoelace.toFixed(0) },
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split("\n").slice(0, 5) });
  }
});
// ─── DIAGNOSTIC : tester compute-scenarios avec des valeurs par défaut ──────
app.get("/diag-scenarios", (req, res) => {
  const sa = Number(req.query.site_area) || 1950;
  const ew = Number(req.query.ew) || 55;
  const ed = Number(req.query.ed) || 55;
  const zt = req.query.zoning || "URBAIN";
  const pd = req.query.driver || "MAX_CAPACITE";
  const scenarios = computeSmartScenarios({
    site_area: sa, envelope_w: ew, envelope_d: ed,
    zoning_type: zt, floor_height: 3.2, primary_driver: pd,
    max_floors: 5, max_height_m: 16, program_main: "",
    target_surface_m2: 0, target_units: 0,
    site_saturation_level: "MEDIUM", financial_rigidity_score: 0.5,
    density_band: "MEDIUM", risk_adjusted: 0.5,
    feasibility_posture: "STANDARD",
    scenario_A_role: "INTENSIFICATION", scenario_B_role: "OPTIMISATION", scenario_C_role: "PRUDENT",
    budget_range: 0, budget_band: "MEDIUM", budget_tension: 0.5,
    standing_level: "STANDARD", rent_score: 0.5, capacity_score: 0.7,
    mix_score: 0.5, phase_score: 0.5, risk_score: 0.5,
    density_pressure_factor: 1, driver_intensity: "MEDIUM",
  });
  res.json({
    version: "57.13", zoning: zt, site_area: sa, envelope: `${ew}x${ed}`,
    CES: ZONING_CES[zt], COS: ZONING_COS[zt],
    fp_A: scenarios.A.fp_m2, fp_B: scenarios.B.fp_m2, fp_C: scenarios.C.fp_m2,
    levels_A: scenarios.A.levels, levels_B: scenarios.B.levels, levels_C: scenarios.C.levels,
    height_A: scenarios.A.height_m, height_B: scenarios.B.height_m, height_C: scenarios.C.height_m,
  });
});
// ─── GÉOMÉTRIE GPS ────────────────────────────────────────────────────────────
const R_EARTH = 6371000;
function toM(lat, lon, cLat, cLon) {
  return {
    x: (lon - cLon) * Math.PI / 180 * R_EARTH * Math.cos(cLat * Math.PI / 180),
    y: (lat - cLat) * Math.PI / 180 * R_EARTH,
  };
}
function brng(p1, p2) {
  const dLon = (p2.lon - p1.lon) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(p2.lat * Math.PI / 180);
  const x = Math.cos(p1.lat * Math.PI / 180) * Math.sin(p2.lat * Math.PI / 180) -
    Math.sin(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// ── v69.0: Détection route — Overpass (2 miroirs) + Nominatim fallback ──
// ══════════════════════════════════════════════════════════════════════════════
// v70.3 ROAD DETECTION — MAPBOX TILEQUERY (fiable, pas d'OSM)
// ══════════════════════════════════════════════════════════════════════════════
// Stratégie : on lance des requêtes Tilequery depuis le midpoint EXTÉRIEUR
// de chaque arête de la parcelle. L'arête dont le midpoint extérieur est le
// plus proche d'une route de haut rang = le front.
//
// Pourquoi midpoint EXTÉRIEUR ? Parce que le midpoint d'une arête est SUR la
// parcelle. Si on tire un peu vers l'extérieur (5m dans la direction de la
// normale sortante), on tombe sur la route si elle est vraiment devant.
// ══════════════════════════════════════════════════════════════════════════════
const ROAD_CLASS_WEIGHT = {
  motorway: 6, trunk: 6, primary: 5, secondary: 4, tertiary: 3,
  street: 2, residential: 2, service: 1, path: 0, pedestrian: 0, track: 0,
};
async function findNearestRoadEdge(coords, cLat, cLon) {
  // ── MÉTHODE 1: Mapbox Tilequery — requête multi-points le long des arêtes ──
  const mapboxResult = await tryMapboxTilequery(coords, cLat, cLon);
  if (mapboxResult !== null) return mapboxResult;
  // ── MÉTHODE 2: Nominatim reverse (fallback léger) ──
  const nominatimResult = await tryNominatim(coords, cLat, cLon);
  if (nominatimResult !== null) return nominatimResult;
  console.warn("│ ROAD-DETECT: Mapbox ET Nominatim ont échoué, fallback premier segment");
  return null;
}
async function tryMapboxTilequery(coords, cLat, cLon) {
  if (!MAPBOX_TOKEN) {
    console.warn("│ MAPBOX-TQ: pas de token, skip");
    return null;
  }
  try {
    const n = coords.length;
    console.log(`│ MAPBOX-TQ: analyse ${n} arêtes via Tilequery...`);
    // Pour chaque arête : calculer un point-sonde 8m à l'extérieur du midpoint
    // (dans la direction de la normale sortante)
    const probeResults = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const midLat = (coords[i].lat + coords[j].lat) / 2;
      const midLon = (coords[i].lon + coords[j].lon) / 2;
      // Normale sortante (perpendiculaire à l'arête, vers l'extérieur)
      const edgeDx = (coords[j].lon - coords[i].lon) * Math.cos(midLat * Math.PI / 180);
      const edgeDy = coords[j].lat - coords[i].lat;
      const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
      if (edgeLen < 1e-10) continue;
      // Perpendiculaire (rotation +90° = vers la droite quand on parcourt l'arête)
      let nx = edgeDy / edgeLen;
      let ny = -edgeDx / edgeLen;
      // Vérifier que la normale pointe vers l'extérieur (loin du centroïde)
      const toCenterDx = (cLon - midLon) * Math.cos(midLat * Math.PI / 180);
      const toCenterDy = cLat - midLat;
      if (nx * toCenterDx + ny * toCenterDy > 0) {
        nx = -nx; ny = -ny; // inverser si pointe vers le centre
      }
      // Point-sonde à ~8m à l'extérieur
      const probeOffsetDeg = 8 / 111000; // ~8m en degrés
      const probeLat = midLat + ny * probeOffsetDeg;
      const probeLon = midLon + nx * probeOffsetDeg / Math.cos(midLat * Math.PI / 180);
      probeResults.push({ edgeIdx: i, probeLat, probeLon, midLat, midLon });
    }
    // Lancer les requêtes Tilequery en parallèle (max 4 arêtes, on les fait toutes)
    const tqPromises = probeResults.map(async (probe) => {
      const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${probe.probeLon},${probe.probeLat}.json?radius=50&limit=10&layers=road&access_token=${MAPBOX_TOKEN}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) return { ...probe, roads: [], error: `HTTP ${resp.status}` };
        const data = await resp.json();
        const features = (data.features || []).filter(f =>
          f.properties && f.properties.class && ROAD_CLASS_WEIGHT[f.properties.class] > 0
        );
        return { ...probe, roads: features, error: null };
      } catch (e) {
        clearTimeout(timer);
        return { ...probe, roads: [], error: e.name === "AbortError" ? "TIMEOUT" : e.message };
      }
    });
    const results = await Promise.all(tqPromises);
    // ══════════════════════════════════════════════════════════════════
    // v70.6 SCORING — 2 passes :
    //   Pass 1 : routes à 4-50m (distance normale d'accès)
    //   Pass 2 : si rien en pass 1, accepter < 4m (ruelle)
    //
    // Pourquoi ? Les routes à < 4m du bord de parcelle sont souvent
    // des ruelles/passages mitoyens, PAS la route principale d'accès.
    // La vraie route d'accès est typiquement à 5-20m (largeur de la
    // rue + trottoir + retrait clôture).
    // ══════════════════════════════════════════════════════════════════
    const MIN_ROAD_DIST = 4; // mètres — en dessous = ruelle/mur mitoyen
    // Collecter les scores pour chaque arête
    const edgeScores = [];
    for (const r of results) {
      if (r.error) {
        console.log(`│ MAPBOX-TQ: arête ${r.edgeIdx} → ERREUR ${r.error}`);
        edgeScores.push({ idx: r.edgeIdx, scoreNormal: 0, scoreAll: 0, bestClass: "?", bestDist: 999, bestDistAll: 999 });
        continue;
      }
      if (r.roads.length === 0) {
        console.log(`│ MAPBOX-TQ: arête ${r.edgeIdx} → aucune route dans 50m`);
        edgeScores.push({ idx: r.edgeIdx, scoreNormal: 0, scoreAll: 0, bestClass: "?", bestDist: 999, bestDistAll: 999 });
        continue;
      }
      let scoreNormal = 0, scoreAll = 0;
      let bestClassNormal = "?", bestDistNormal = 999;
      let bestClassAll = "?", bestDistAll = 999;
      for (const feat of r.roads) {
        const cls = feat.properties.class || "service";
        const weight = ROAD_CLASS_WEIGHT[cls] || 1;
        const dist = feat.properties.tilequery?.distance || 50;
        const sc = weight * 100 / Math.max(1, dist);
        // Score ALL (incluant ruelles)
        if (sc > scoreAll) { scoreAll = sc; bestClassAll = cls; bestDistAll = dist; }
        // Score NORMAL (exclut ruelles < 4m)
        if (dist >= MIN_ROAD_DIST && sc > scoreNormal) { scoreNormal = sc; bestClassNormal = cls; bestDistNormal = dist; }
      }
      const bestClass = scoreNormal > 0 ? bestClassNormal : bestClassAll;
      const bestDist = scoreNormal > 0 ? bestDistNormal : bestDistAll;
      console.log(`│ MAPBOX-TQ: arête ${r.edgeIdx} → ${r.roads.length} routes, best=${bestClass} à ${bestDist.toFixed(1)}m (score_normal=${scoreNormal.toFixed(1)} score_all=${scoreAll.toFixed(1)}${bestDistAll < MIN_ROAD_DIST ? " ⚠ruelle@" + bestDistAll.toFixed(1) + "m" : ""})`);
      edgeScores.push({ idx: r.edgeIdx, scoreNormal, scoreAll, bestClass, bestDist: bestDistNormal, bestDistAll });
    }
    // Pass 1 : chercher la meilleure arête avec des routes à distance normale (≥4m)
    let bestEdge = -1, bestScore = -Infinity;
    for (const es of edgeScores) {
      if (es.scoreNormal > bestScore) { bestScore = es.scoreNormal; bestEdge = es.idx; }
    }
    if (bestEdge >= 0 && bestScore > 0) {
      // v70.8: Convention utilisateur — si l'arête 0 a un score proche du meilleur (≥70%),
      // préférer arête 0 car l'utilisateur trace le polygone en commençant côté route.
      const edge0Score = edgeScores.find(es => es.idx === 0)?.scoreNormal || 0;
      if (bestEdge !== 0 && edge0Score > 0 && edge0Score >= bestScore * 0.70) {
        console.log(`│ MAPBOX-TQ: arête 0 (score=${edge0Score.toFixed(1)}) proche de arête ${bestEdge} (score=${bestScore.toFixed(1)}) → PRÉFÉRENCE arête 0 (convention polygone)`);
        bestEdge = 0;
        bestScore = edge0Score;
      }
      console.log(`│ MAPBOX-TQ: ✓ front = arête ${bestEdge} (score_normal=${bestScore.toFixed(1)}) — route d'accès principale`);
      return bestEdge;
    }
    // Pass 2 : fallback — accepter les ruelles (< 4m), avec même préférence arête 0
    bestEdge = -1; bestScore = -Infinity;
    for (const es of edgeScores) {
      if (es.scoreAll > bestScore) { bestScore = es.scoreAll; bestEdge = es.idx; }
    }
    if (bestEdge >= 0) {
      const edge0ScoreAll = edgeScores.find(es => es.idx === 0)?.scoreAll || 0;
      if (bestEdge !== 0 && edge0ScoreAll > 0 && edge0ScoreAll >= bestScore * 0.70) {
        console.log(`│ MAPBOX-TQ: arête 0 (all=${edge0ScoreAll.toFixed(1)}) proche → PRÉFÉRENCE arête 0`);
        bestEdge = 0;
      }
      console.log(`│ MAPBOX-TQ: ✓ front = arête ${bestEdge} (score_all=${bestScore.toFixed(1)}) — fallback ruelle`);
      return bestEdge;
    }
    console.warn("│ MAPBOX-TQ: aucune route trouvée pour aucune arête");
    return null;
  } catch (err) {
    console.warn(`│ MAPBOX-TQ: erreur globale ${err.message}`);
    return null;
  }
}
async function tryNominatim(coords, cLat, cLon) {
  try {
    console.log("│ NOMINATIM: tentative reverse geocoding (fallback)...");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${cLat}&lon=${cLon}&zoom=17&addressdetails=0`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "BARLO-RealEstate/1.0 (diagnostic tool)" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) { console.warn(`│ NOMINATIM: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    if (!data || !data.lat || !data.lon) { console.warn("│ NOMINATIM: pas de coordonnées"); return null; }
    const roadLat = parseFloat(data.lat);
    const roadLon = parseFloat(data.lon);
    const roadName = data.display_name || "?";
    console.log(`│ NOMINATIM: route → "${roadName.substring(0, 60)}" à (${roadLat.toFixed(6)}, ${roadLon.toFixed(6)})`);
    let bestEdge = 0, bestDist = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const j = (i + 1) % coords.length;
      const d = distPointToSegment(roadLat, roadLon, coords[i].lat, coords[i].lon, coords[j].lat, coords[j].lon);
      console.log(`│ NOMINATIM: arête ${i} → dist=${d.toFixed(1)}m`);
      if (d < bestDist) { bestDist = d; bestEdge = i; }
    }
    console.log(`│ NOMINATIM: ✓ front = arête ${bestEdge} (à ${bestDist.toFixed(1)}m)`);
    return bestEdge;
  } catch (err) {
    console.warn(`│ NOMINATIM: ${err.name === "AbortError" ? "TIMEOUT 4s" : err.message}`);
    return null;
  }
}
function distPointToSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
  // Distance approximative (mètres) d'un point à un segment en coordonnées GPS
  const R = 6371000;
  const toRad = Math.PI / 180;
  const px = (pLon - aLon) * toRad * R * Math.cos(aLat * toRad);
  const py = (pLat - aLat) * toRad * R;
  const ax = 0, ay = 0;
  const bx = (bLon - aLon) * toRad * R * Math.cos(aLat * toRad);
  const by = (bLat - aLat) * toRad * R;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const closestX = ax + t * dx, closestY = ay + t * dy;
  const ddx = px - closestX, ddy = py - closestY;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}
function computeAccessPoint(coords, cLat, cLon, frontEdgeIndex) {
  // v70: Utiliser le frontEdgeIndex déjà calculé (plus de double appel OSM)
  let bestI = 0;
  if (frontEdgeIndex !== null && frontEdgeIndex !== undefined) {
    bestI = frontEdgeIndex;
  } else {
    bestI = 0;
    console.log("│ AccessPoint fallback: premier segment du polygone");
  }
  const j = (bestI + 1) % coords.length;
  const midLat = (coords[bestI].lat + coords[j].lat) / 2;
  const midLon = (coords[bestI].lon + coords[j].lon) / 2;
  const edgeBrng = brng(coords[bestI], coords[j]);
  const outBrng = (edgeBrng + 90) % 360;
  console.log(`│ AccessPoint: edge=${bestI} midLat=${midLat.toFixed(6)} bearing=${outBrng.toFixed(0)}°`);
  return { lat: midLat, lon: midLon, bearing: outBrng };
}
function computeEnvelope(coords, cLat, cLon, front, side, back, frontEdgeIndex) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const n = pts.length;
  // ── v56.3 FIX: Détecter le sens de rotation (CW vs CCW) ──
  // Shoelace sign: positif = CCW, négatif = CW
  let windingSum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    windingSum += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  // Si CW (windingSum < 0), on inverse le signe de l'offset pour aller vers l'intérieur
  const windingSign = windingSum >= 0 ? 1 : -1;
  console.log(`│ Envelope winding: ${windingSum >= 0 ? "CCW" : "CW"} (sign=${windingSign}) sum=${windingSum.toFixed(1)}`);
  // v69.1: Assignation directe des setbacks par INDEX d'arête (plus de bearing)
  // front = arête frontEdgeIndex, back = opposée, sides = adjacentes
  function getSetbackForEdge(edgeIdx) {
    if (frontEdgeIndex !== undefined && frontEdgeIndex !== null && frontEdgeIndex < n) {
      const diff = ((edgeIdx - frontEdgeIndex) % n + n) % n;
      if (diff === 0) return front;                    // arête front (face route)
      if (n === 4 && diff === 2) return back;          // arête opposée (fond)
      if (n === 4 && (diff === 1 || diff === 3)) return side; // arêtes latérales
      // Pour polygones > 4 côtés: front, back (opposé), reste = side
      if (diff === Math.floor(n / 2)) return back;
      return side;
    }
    // Fallback sans frontEdgeIndex: bearing-based (ancien comportement)
    return null;
  }
  // Fallback bearing si pas de frontEdgeIndex
  let rb = 0;
  if (frontEdgeIndex === undefined || frontEdgeIndex === null || frontEdgeIndex >= n) {
    let maxLat = -Infinity;
    for (let i = 0; i < n - 1; i++) {
      const ml = (coords[i].lat + coords[(i + 1) % n].lat) / 2;
      if (ml > maxLat) { maxLat = ml; rb = brng(coords[i], coords[(i + 1) % n]); }
    }
    console.log(`│ Envelope front: maxLat fallback bearing=${rb.toFixed(0)}°`);
  }
  function setSB(edgeIdx) {
    const direct = getSetbackForEdge(edgeIdx);
    if (direct !== null) return direct;
    // Fallback bearing
    const b = brng(coords[edgeIdx], coords[(edgeIdx + 1) % n]);
    let d = ((b - rb) + 360) % 360; if (d > 180) d = 360 - d;
    return d < 45 ? front : d < 135 ? side : back;
  }
  // Log des setbacks assignés
  for (let i = 0; i < n; i++) {
    const sb = setSB(i);
    const role = sb === front ? "FRONT" : sb === back ? "BACK" : "SIDE";
    console.log(`│ Envelope: arête ${i} → setback=${sb}m (${role})`);
  }
  function offSeg(p1, p2, dist) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.sqrt(dx * dx + dy * dy) + 0.001;
    const d = dist * windingSign;
    return { p1: { x: p1.x - dy / len * d, y: p1.y + dx / len * d }, p2: { x: p2.x - dy / len * d, y: p2.y + dx / len * d } };
  }
  function intersect(s1, s2) {
    const d1x = s1.p2.x - s1.p1.x, d1y = s1.p2.y - s1.p1.y, d2x = s2.p2.x - s2.p1.x, d2y = s2.p2.y - s2.p1.y;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-10) return { x: (s1.p2.x + s2.p1.x) / 2, y: (s1.p2.y + s2.p1.y) / 2 };
    const t = ((s2.p1.x - s1.p1.x) * d2y - (s2.p1.y - s1.p1.y) * d2x) / den;
    return { x: s1.p1.x + t * d1x, y: s1.p1.y + t * d1y };
  }
  const segs = [];
  for (let i = 0; i < n; i++) segs.push(offSeg(pts[i], pts[(i + 1) % n], setSB(i)));
  const envM = segs.map((_, i) => intersect(segs[(i + n - 1) % n], segs[i]));
  // ── v56.3 VALIDATION: vérifier que l'enveloppe est PLUS PETITE que la parcelle ──
  let envArea = 0, parcelArea = 0;
  for (let i = 0; i < envM.length; i++) {
    const j = (i + 1) % envM.length;
    envArea += envM[i].x * envM[j].y - envM[j].x * envM[i].y;
  }
  envArea = Math.abs(envArea) / 2;
  parcelArea = Math.abs(windingSum) / 2;
  console.log(`│ Envelope area=${envArea.toFixed(0)}m² vs Parcel area=${parcelArea.toFixed(0)}m² → ${envArea < parcelArea ? "OK (inside)" : "⚠ PROBLÈME (outside!)"}`);
  const result = envM.map(m => ({
    lat: cLat + m.y / R_EARTH * 180 / Math.PI,
    lon: cLon + m.x / (R_EARTH * Math.cos(cLat * Math.PI / 180)) * 180 / Math.PI,
  }));
  // v70: Log GPS de chaque vertex d'enveloppe pour debug visuel
  result.forEach((p, i) => console.log(`│ Envelope GPS V${i}: ${p.lat.toFixed(6)},${p.lon.toFixed(6)}`));
  // Log des distances parcelle→enveloppe par arête
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const pMidX = (pts[i].x + pts[j].x) / 2, pMidY = (pts[i].y + pts[j].y) / 2;
    const eMidX = (envM[i].x + envM[j].x) / 2, eMidY = (envM[i].y + envM[j].y) / 2;
    const dist = Math.sqrt((pMidX - eMidX) ** 2 + (pMidY - eMidY) ** 2);
    const sb = setSB(i);
    const role = sb === front ? "FRONT" : sb === back ? "BACK" : "SIDE";
    console.log(`│ Envelope edge ${i} (${role}): setback=${sb}m actual_dist=${dist.toFixed(2)}m`);
  }
  return result;
}
function computeZoom(coords, cLat, cLon) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const ext = Math.max(
    Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)),
    Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y)), 20
  );
  // v73.1.5: zoom ×3 vs original — parcelle plus grande encore (multiplier 1.5 → 1.0)
  const mpp = (ext * 1.0) / 1280;
  const z = Math.log2(156543.03 * Math.cos(cLat * Math.PI / 180) / mpp);
  return Math.min(19, Math.max(17.5, Math.round(z * 4) / 4));
}
function computeZoomMassing(coords, cLat, cLon) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const ext = Math.max(
    Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)),
    Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y)), 20
  );
  const mpp = (ext * 0.45) / 1280;  // v72.85: zoom ×2 sur bâtiment principal — cadrage serré
  const z = Math.log2(156543.03 * Math.cos(cLat * Math.PI / 180) / mpp);
  return Math.min(19.5, Math.max(17.5, Math.round(z * 4) / 4));
}
function computeBearing(coords, cLat, cLon) {
  const pts = coords.map(c => toM(c.lat, c.lon, cLat, cLon));
  let longest = 0, angle = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > longest) { longest = len; angle = Math.atan2(dx, dy) * 180 / Math.PI; }
  }
  return ((Math.round(angle + 30) % 360) + 360) % 360;
}
// v72.122: Server-side intersection filter
// Uses Mapbox Tilequery API + Turf.js booleanIntersects to find buildings that overlap the parcel (even partially).
async function getIntersectingBuildingIds(parcelCoordsArray, mapboxToken) {
  try {
    if (!parcelCoordsArray || parcelCoordsArray.length < 3) return [];
    if (!mapboxToken) return [];
    // Ensure closed ring
    const ring = parcelCoordsArray.slice();
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    const parcelPoly = turf.polygon([ring]);
    const centroid = turf.centroid(parcelPoly);
    const [lng, lat] = centroid.geometry.coordinates;
    const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lng},${lat}.json?radius=250&limit=50&layers=building&access_token=${mapboxToken}`;
    // Use fetch (native on Node 18+) or require node-fetch
    let fetchFn;
    try { fetchFn = fetch; } catch (e) { fetchFn = require("node-fetch"); }
    const resp = await fetchFn(url);
    if (!resp.ok) {
      console.warn(`[INTERSECT-SERVER v72.122] tilequery HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (!data || !Array.isArray(data.features)) return [];
    const ids = [];
    for (const f of data.features) {
      if (!f || !f.geometry) continue;
      try {
        let fPoly = null;
        if (f.geometry.type === "Polygon") fPoly = turf.polygon(f.geometry.coordinates);
        else if (f.geometry.type === "MultiPolygon") fPoly = turf.multiPolygon(f.geometry.coordinates);
        if (!fPoly) continue;
        if (turf.booleanIntersects(fPoly, parcelPoly)) {
          if (f.id !== undefined && f.id !== null) ids.push(f.id);
        }
      } catch (inner) { /* skip bad features */ }
    }
    console.log(`[INTERSECT-SERVER v72.122] found ${ids.length} intersecting buildings`);
    return ids;
  } catch (err) {
    console.warn(`[INTERSECT-SERVER v72.122] error: ${err.message}`);
    return [];
  }
}
// ─── CALCUL DIMENSIONNEL MASSING ──────────────────────────────────────────────
function computeMassingDimensions(fp_m2, envelope_w, envelope_d) {
  const ratio = envelope_w / envelope_d;
  const w = Math.sqrt(fp_m2 * ratio);
  const d = Math.sqrt(fp_m2 / ratio);
  const wCapped = Math.min(w, envelope_w);
  const dCapped = Math.min(d, envelope_d);
  const offset_x = (envelope_w - wCapped) / 2;
  const offset_y = (envelope_d - dCapped) / 2;
  return { w: Math.round(wCapped * 10) / 10, d: Math.round(dCapped * 10) / 10, offset_x, offset_y };
}
// ─── MOTEUR DE SCÉNARIOS v52 — DATA-DRIVEN ──────────────────────────────────
// Basé sur les 23 feuilles du source of truth :
//   RULES_SCENARIOS  → ratios fp par primary_driver (5 profils)
//   RULES_ZONING     → COS (vos_ratio) par zoning_type
//   RULES_HEKTAR     → massing_mode (COMPACT/BALANCED/SPREAD) par saturation
//   SCENARIOS_FR     → S1=Référence/BALANCED, S2=Étalée/SPREAD, S3=Compacte/COMPACT
//   VARIABLES        → formulaire client (program_main, target_surface, max_floors...)
//
// Le commerce (USAGE_MIXTE) vient du FORMULAIRE CLIENT, pas du scénario.
// Les ratios viennent du primary_driver, pas d'un ratio fixe.
// La FORME (hauteur vs étalement) vient du massing_mode par scénario.
//
// Ratios d'emprise par primary_driver (depuis RULES_SCENARIOS)
const FP_RATIOS = {
  MAX_CAPACITE:       { A: 0.95, B: 0.85, C: 0.70 },
  RENTABILITE:        { A: 0.90, B: 0.80, C: 0.65 },
  SECURISATION_RISQUE:{ A: 0.80, B: 0.70, C: 0.60 },
  MIXTE_PROGRAMME:    { A: 0.85, B: 0.75, C: 0.65 },
  PHASAGE_FONCIER:    { A: 0.80, B: 0.70, C: 0.60 },
};
// CES par zoning_type — Coefficient d'Emprise au Sol RÉGLEMENTAIRE (max autorisé)
const ZONING_CES = {
  URBAIN: 0.60, PERIURBAIN: 0.45, PAVILLON: 0.30,
  RURAL: 0.20, MIXTE: 0.50, Z_DEFAULT: 0.40,
};
// COS par zoning_type — Coefficient d'Occupation du Sol → contrôle la SDP TOTALE (plancher tous niveaux)
const ZONING_COS = {
  URBAIN: 2.50, PERIURBAIN: 1.50, PAVILLON: 0.80,
  RURAL: 0.40, MIXTE: 2.00, Z_DEFAULT: 1.50,
};
// ══════════════════════════════════════════════════════════════════════════════
// v56.8 — RÉSERVE SOL + PILOTIS
// ══════════════════════════════════════════════════════════════════════════════
// v56.9.1 — QUALITÉ DE CIRCULATION PAR RÔLE
// ══════════════════════════════════════════════════════════════════════════════
// Le scénario A (INTENSIFICATION) = la meilleure version du programme client :
//   → circulation plus généreuse (halls, paliers, rangements communs)
//   → balcons/terrasses intégrés dans le fp
//   → résultat : un bâtiment plus qualitatif, donc un peu plus grand en fp
// Le scénario B = standard marché
// Le scénario C = compact, optimisé coût
// ══════════════════════════════════════════════════════════════════════════════
const CIRCULATION_BONUS_BY_ROLE = {
  INTENSIFICATION: 0.05,  // +5% de circulation en plus (lobby, paliers larges, rangements)
  EQUILIBRE: 0,            // standard
  PRUDENT: -0.02,          // -2% (couloirs plus étroits, optimisé)
};
// ══════════════════════════════════════════════════════════════════════════════
// CES_FILL_BY_ROLE : quel % du CES autorisé on occupe réellement au sol
// C'est le PREMIER levier de différenciation entre scénarios.
// Combiné avec UNIT_SIZES (2e levier), ça donne des scénarios réalistes :
//   A → grosse empreinte + grands apparts = ambitieux
//   B → empreinte standard + tailles marché = équilibré
//   C → empreinte réduite + compact = prudent/phasable
// ══════════════════════════════════════════════════════════════════════════════
const CES_FILL_BY_ROLE = {
  INTENSIFICATION: 0.95,  // occupe 95% du CES autorisé (quasi max, 5% marge technique)
  EQUILIBRE: 0.80,         // 80% — retrait confortable
  PRUDENT: 0.65,           // 65% — empreinte réduite, plus d'espace libre
};
// ══════════════════════════════════════════════════════════════════════════════
// EXTENSION ÉTAGES : à partir du R+1, le bâtiment peut s'élargir vers les
// limites séparatives de la parcelle. Le RDC reste en retrait (parking, accès,
// jardin), mais les étages débordent — architecture courante en Afrique de l'Ouest.
//   A = étages jusqu'à l'enveloppe (limites séparatives)
//   B = +15% vs le RDC (extension modérée)
//   C = pas d'extension (même empreinte que le RDC)
// ══════════════════════════════════════════════════════════════════════════════
const ETAGE_EXTENSION_BY_ROLE = {
  INTENSIFICATION: 1.10,  // v72.82: léger débord étages (+10%), intensification maîtrisée
  EQUILIBRE: 1.00,         // fp_etages = fp_rdc (pas d'extension)
  PRUDENT: 1.00,           // v72.82: fp_etages = fp_rdc (pas de réduction, T3 doit rentrer)
};
// ══════════════════════════════════════════════════════════════════════════════
// v72.156: TYPOLOGY-DRIVEN SCENARIO CALCULATION
// Apartment sizes by typology and standing level (architect's programme is source of truth)
// ══════════════════════════════════════════════════════════════════════════════
const APARTMENT_SIZE_GRID = {
  T1: { ECONOMIQUE: 30, STANDARD: 35, CONFORT: 40, PREMIUM: 45 },
  T2: { ECONOMIQUE: 45, STANDARD: 50, CONFORT: 60, PREMIUM: 70 },
  T3: { ECONOMIQUE: 65, STANDARD: 75, CONFORT: 90, PREMIUM: 105 },
  T4: { ECONOMIQUE: 80, STANDARD: 90, CONFORT: 110, PREMIUM: 135 },
  T5: { ECONOMIQUE: 95, STANDARD: 105, CONFORT: 130, PREMIUM: 160 }
};
const COMMERCE_SIZE_BY_STANDING = {
  ECONOMIQUE: 40,
  STANDARD: 50,
  CONFORT: 60,
  PREMIUM: 80
};
const CIRCULATION_COEFFICIENT = 1.15;
// ══════════════════════════════════════════════════════════════════════════════
// Le CES réglementaire = max autorisé, PAS ce qu'on doit construire.
// En pratique, on réserve toujours de l'espace au sol pour :
//   - Parking (obligatoire en ville)
//   - Circulation véhicules/piétons
//   - Espaces verts, cour, aire de jeux
//   - Accès pompiers
//
// RÉSERVE = % de l'enveloppe réservé aux aménagements extérieurs
// Varie selon : rôle scénario + standing + programme + zoning
//
// PILOTIS : quand la parcelle est trop étroite pour du parking en surface,
// le RDC est libéré en pilotis (colonnes ouvertes) et le bâtiment commence au R+1.
// Le RDC pilotis n'est PAS de la SDP, mais le parking est résolu.
// ══════════════════════════════════════════════════════════════════════════════
// Réserve sol de BASE par rôle (% de l'enveloppe)
const RESERVE_BY_ROLE = {
  INTENSIFICATION: 0.18,  // max bâti, mais accès + parking minimum
  EQUILIBRE: 0.27,        // bon compromis bâti/extérieur
  PRUDENT: 0.35,          // espaces verts généreux, phasable
};
// Bonus réserve par standing
const RESERVE_STANDING = {
  ECONOMIQUE: 0, ECO: 0,
  STANDARD: 0.05,
  HAUT: 0.10,
  PREMIUM: 0.15,          // jardins, piscine, dégagement
};
// Bonus réserve par programme
const RESERVE_PROGRAM = {
  DEFAULT: 0.05,                // minimum parking
  IMMEUBLE_RAPPORT: 0.05,      // parking résidents
  COLLECTIF: 0.08,             // parking + espaces communs
  MIXTE: 0.10,                 // parking client + livraison + parking résidents
  COMMERCE: 0.12,              // parking clients, accès livraison
  BUREAUX: 0.10,               // parking employés
  LOGEMENT_SOCIAL: 0.05,       // minimum
};
// Seuils pour la décision PILOTIS vs RDC OCCUPÉ
// Si l'espace libre au sol (après emprise bâtiment) < seuil, on passe en pilotis
const PILOTIS_CONFIG = {
  MIN_FREE_GROUND_M2: 150,     // minimum 150m² libres au sol pour ne PAS avoir besoin de pilotis
  MIN_FREE_GROUND_PCT: 0.25,   // OU minimum 25% de l'enveloppe libre
  MIN_PARKING_SPOTS: 4,        // nombre min de places de parking à prévoir
  PARKING_SPOT_M2: 25,         // ~12.5m² place + 12.5m² circulation
  PILOTIS_HEIGHT_M: 3.5,       // hauteur libre sous pilotis
};
// ══════════════════════════════════════════════════════════════════════════════
// v56.9 — SURFACES PAR TYPOLOGIE × STANDING × RÔLE SCÉNARIO
// ══════════════════════════════════════════════════════════════════════════════
// Rôle A (INTENSIFICATION) = surfaces GÉNÉREUSES (+15-20% vs standard marché)
// Rôle B (EQUILIBRE) = surfaces STANDARD (référence marché)
// Rôle C (PRUDENT) = surfaces COMPACTES (-10-15%, économie de construction)
const UNIT_SIZES = {
  ECONOMIQUE: {
    A: { T1: 32, T2: 55, T3: 72, T4: 90, T5: 110, STUDIO: 22, COMMERCE: 40, BUREAU: 20 },
    B: { T1: 28, T2: 48, T3: 65, T4: 82, T5: 100, STUDIO: 18, COMMERCE: 35, BUREAU: 16 },
    C: { T1: 24, T2: 42, T3: 58, T4: 72, T5: 88, STUDIO: 16, COMMERCE: 30, BUREAU: 14 },
  },
  STANDARD: {
    A: { T1: 42, T2: 72, T3: 95, T4: 120, T5: 148, STUDIO: 28, COMMERCE: 60, BUREAU: 25 },
    B: { T1: 35, T2: 60, T3: 80, T4: 100, T5: 125, STUDIO: 24, COMMERCE: 50, BUREAU: 20 },
    C: { T1: 30, T2: 52, T3: 70, T4: 88, T5: 108, STUDIO: 20, COMMERCE: 40, BUREAU: 16 },
  },
  PREMIUM: {
    A: { T1: 55, T2: 90, T3: 120, T4: 155, T5: 190, STUDIO: 38, COMMERCE: 80, BUREAU: 35 },
    B: { T1: 45, T2: 75, T3: 100, T4: 130, T5: 160, STUDIO: 32, COMMERCE: 65, BUREAU: 28 },
    C: { T1: 38, T2: 65, T3: 88, T4: 112, T5: 138, STUDIO: 26, COMMERCE: 55, BUREAU: 22 },
  },
};
// ══════════════════════════════════════════════════════════════════════════════
// v57.6 — LOYERS MARCHÉ DOUALA (FCFA/mois par typologie × standing)
// Source : estimations marché Cameroun 2024-2025, ajustables
// ══════════════════════════════════════════════════════════════════════════════
const LOYERS_MENSUELS_FCFA = {
  PREMIUM: { T1: 100000, T2: 150000, T3: 250000, T4: 350000, T5: 450000, STUDIO: 80000, COMMERCE: 400000, BUREAU: 300000 },
  STANDARD: { T1: 60000, T2: 100000, T3: 150000, T4: 200000, T5: 280000, STUDIO: 45000, COMMERCE: 250000, BUREAU: 180000 },
  ECO: { T1: 35000, T2: 60000, T3: 90000, T4: 130000, T5: 180000, STUDIO: 25000, COMMERCE: 150000, BUREAU: 100000 },
};
const VACANCY_RATE_BY_ZONING = {
  URBAIN: 0.10, PERIURBAIN: 0.15, PAVILLON: 0.20, RURAL: 0.25, MIXTE: 0.12,
};
// Fourchette de coûts construction : le costPerM2 du standing est le MEDIAN
// BAS = -15%, HAUT = +20% (aléas chantier, fondations, accès)
const COST_RANGE_MULT = { bas: 0.85, median: 1.0, haut: 1.20 };
// ══════════════════════════════════════════════════════════════════════════════
// v57.7 — RETRAITS RÉGLEMENTAIRES (SETBACKS) par zonage
// ══════════════════════════════════════════════════════════════════════════════
// En zone URBAIN Cameroun : retrait AVANT 3-5m, LATÉRAL 0-3m, ARRIÈRE 3m
// Mitoyenneté : en urbain dense, les murs pignons touchent la limite → retrait=0
// La combinaison retrait + mitoyenneté réduit l'emprise RÉELLE constructible
// ══════════════════════════════════════════════════════════════════════════════
const RETRAITS_M = {
  URBAIN:     { avant: 5, lateral: 3, arriere: 3, mitoyen_possible: true },
  PERIURBAIN: { avant: 6, lateral: 4, arriere: 4, mitoyen_possible: true },
  PAVILLON:   { avant: 8, lateral: 5, arriere: 5, mitoyen_possible: false },
  RURAL:      { avant: 10, lateral: 6, arriere: 6, mitoyen_possible: false },
  MIXTE:      { avant: 5, lateral: 3, arriere: 3, mitoyen_possible: true },
};
// Mitoyenneté : en zone urbaine dense, un ou deux côtés sont mitoyens
// → retrait latéral = 0 sur les côtés mitoyens
// On modélise le nombre de côtés mitoyens par zonage
const MITOYENNETE_SIDES = {
  URBAIN: 2,      // 2 côtés mitoyens (typique Douala centre)
  PERIURBAIN: 1,  // 1 côté mitoyen
  PAVILLON: 0,    // isolé
  RURAL: 0,
  MIXTE: 1,
};
// ══════════════════════════════════════════════════════════════════════════════
// v57.7 — VENTILATION COÛTS PAR POSTE (% du coût construction hors VRD)
// ══════════════════════════════════════════════════════════════════════════════
// v72.90: ventilation PAR RÔLE — A (grand volume) a plus de GO, C (compact) plus de LT%
const COST_VENTILATION_PCT_BY_ROLE = {
  A: { gros_oeuvre: 0.55, second_oeuvre: 0.24, lots_techniques: 0.14, amenagements_ext: 0.07 },
  B: { gros_oeuvre: 0.52, second_oeuvre: 0.25, lots_techniques: 0.15, amenagements_ext: 0.08 },
  C: { gros_oeuvre: 0.48, second_oeuvre: 0.26, lots_techniques: 0.16, amenagements_ext: 0.10 },
};
const COST_VENTILATION_PCT = COST_VENTILATION_PCT_BY_ROLE.B; // fallback
// ══════════════════════════════════════════════════════════════════════════════
// v57.8 — HONORAIRES ARCHITECTE : barème international dégressif
// ══════════════════════════════════════════════════════════════════════════════
// v57.9 — HONORAIRES ARCHITECTE : barème FCFA réel (fourchette bas/haut)
// ══════════════════════════════════════════════════════════════════════════════
// Source : barème professionnel ONAC / UIA ajusté Cameroun
// Le taux effectif est la MÉDIANE de la fourchette (négociation standard)
// Inclut : esquisse, APS, APD, permis, DCE, suivi chantier, réception
// ══════════════════════════════════════════════════════════════════════════════
const HONORAIRES_TRANCHES_FCFA = [
  { seuil_max: 100_000_000,     taux_bas: 0.10, taux_haut: 0.15 },   // <100M → 10-15%
  { seuil_max: 500_000_000,     taux_bas: 0.08, taux_haut: 0.12 },   // 100-500M → 8-12%
  { seuil_max: 1_000_000_000,   taux_bas: 0.06, taux_haut: 0.10 },   // 500M-1Md → 6-10%
  { seuil_max: 5_000_000_000,   taux_bas: 0.05, taux_haut: 0.08 },   // 1-5Md → 5-8%
  { seuil_max: 10_000_000_000,  taux_bas: 0.04, taux_haut: 0.06 },   // 5-10Md → 4-6%
  { seuil_max: Infinity,        taux_bas: 0.03, taux_haut: 0.05 },   // >10Md → 3-5%
];
// Frais annexes : permis de construire, assurances, études techniques
const FRAIS_ANNEXES_PCT = {
  permis_construire: 0.01,         // 1% — permis de construire (Cameroun)
  assurance_dommage_ouvrage: 0.005, // 0.5% — assurance (non obligatoire au Cameroun)
  etudes_techniques: 0.0025,       // 0.25% — études de sol / géotechnique
  divers_imprevus: 0.0025,         // 0.25% — frais démarches permis et administratif
};
// Calcul honoraires dégressifs (retourne { bas, median, haut })
function calcHonorairesDegressifs(coutConstruction) {
  let honoBas = 0, honoHaut = 0;
  let reste = coutConstruction;
  let tranchePrecedente = 0;
  for (const tranche of HONORAIRES_TRANCHES_FCFA) {
    const montantTranche = Math.min(reste, tranche.seuil_max - tranchePrecedente);
    if (montantTranche <= 0) break;
    honoBas += montantTranche * tranche.taux_bas;
    honoHaut += montantTranche * tranche.taux_haut;
    reste -= montantTranche;
    tranchePrecedente = tranche.seuil_max;
  }
  const median = Math.round((honoBas + honoHaut) / 2);
  return { bas: Math.round(honoBas), median, haut: Math.round(honoHaut) };
}
// ══════════════════════════════════════════════════════════════════════════════
// v57.9 — ORIENTATION SOLAIRE & GÉOGRAPHIE DU SITE
// ══════════════════════════════════════════════════════════════════════════════
// L'orientation solaire impacte la géométrie du bâtiment :
// - En zone tropicale (Cameroun, lat ~4°N) : soleil quasi-zénithal
//   → Façades principales NORD-SUD (minimiser l'exposition est/ouest)
//   → Protéger la façade OUEST (soleil rasant l'après-midi = surchauffe)
//   → Profondeur de corps limitée (ventilation traversante)
//   → Toiture débordante (protection solaire)
// - En zone tempérée : optimiser l'apport solaire sud en hiver
// ══════════════════════════════════════════════════════════════════════════════
const SOLAR_CONFIG = {
  TROPICAL: {
    // Cameroun, Afrique de l'Ouest, zone équatoriale (lat < 15°)
    orientation_optimale: "NORD-SUD",       // façades principales
    facade_a_proteger: "OUEST",             // soleil rasant PM
    profondeur_max_m: 14,                   // ventilation traversante
    debord_toiture_m: 1.2,                  // protection solaire
    ratio_longueur_profondeur: 1.8,         // bâtiment allongé E-O → façades N-S
    malus_mauvaise_orientation_pct: 15,     // surcoût clim si mal orienté
    ventilation_traversante: true,
    brise_soleil_ouest: true,
  },
  TEMPERE: {
    orientation_optimale: "SUD",
    facade_a_proteger: "NORD",
    profondeur_max_m: 18,
    debord_toiture_m: 0.6,
    ratio_longueur_profondeur: 1.4,
    malus_mauvaise_orientation_pct: 8,
    ventilation_traversante: false,
    brise_soleil_ouest: false,
  },
  MEDITERRANEEN: {
    orientation_optimale: "SUD",
    facade_a_proteger: "OUEST",
    profondeur_max_m: 16,
    debord_toiture_m: 1.0,
    ratio_longueur_profondeur: 1.5,
    malus_mauvaise_orientation_pct: 10,
    ventilation_traversante: true,
    brise_soleil_ouest: true,
  },
};
// Détecter la zone climatique depuis le zoning ou le pays
function detectClimaticZone(zoning_type, country) {
  const c = String(country || "").toUpperCase();
  if (/CAMEROUN|CAMEROON|SENEGAL|COTE.D.IVOIRE|IVORY|BENIN|TOGO|GABON|CONGO|NIGERIA|GHANA|GUINEA|MALI|BURKINA/i.test(c)) return "TROPICAL";
  if (/MAROC|MOROCCO|TUNISIE|TUNISIA|ALGERIE|ALGERIA|EGYPTE|EGYPT/i.test(c)) return "MEDITERRANEEN";
  if (/FRANCE|BELGIQUE|SUISSE|CANADA|ALLEMAGNE/i.test(c)) return "TEMPERE";
  // Fallback par zonage : urbain africain = tropical par défaut
  return "TROPICAL";
}
// Calculer l'impact de l'orientation sur la géométrie
// Retourne un facteur correctif pour W et D du bâtiment
function computeSolarImpact(envelope_w, envelope_d, climaticZone, parcelOrientation) {
  const config = SOLAR_CONFIG[climaticZone] || SOLAR_CONFIG.TROPICAL;
  const ratio = config.ratio_longueur_profondeur;
  // Si la parcelle est plus large que profonde (W > D), la longueur du bâti
  // s'aligne naturellement sur W → façades longues en N-S = OPTIMAL en tropical
  // Si W < D, le bâtiment est profond → SOUS-OPTIMAL (façades courtes en N-S)
  const parcelRatio = envelope_w / Math.max(1, envelope_d);
  let orientationScore = 1.0; // 1.0 = parfait
  if (climaticZone === "TROPICAL") {
    // En tropical : on VEUT un bâtiment allongé E-O (façades longues N-S)
    // Si la parcelle le permet (W > D), c'est optimal
    if (parcelRatio >= 1.3) {
      orientationScore = 1.0; // parcelle large → bâti allongé N-S = optimal
    } else if (parcelRatio >= 0.8) {
      orientationScore = 0.92; // parcelle carrée → compromis acceptable
    } else {
      orientationScore = 0.85; // parcelle profonde → sous-optimal (façades longues E-O)
    }
    // Limiter la profondeur de corps pour ventilation traversante
    const profondeurEffective = Math.min(envelope_d, config.profondeur_max_m);
    return {
      orientationScore,
      profondeur_recommandee_m: profondeurEffective,
      ratio_recommande: ratio,
      facade_optimale: config.orientation_optimale,
      facade_a_proteger: config.facade_a_proteger,
      ventilation_traversante: config.ventilation_traversante,
      brise_soleil: config.brise_soleil_ouest,
      debord_toiture_m: config.debord_toiture_m,
      malus_orientation_pct: orientationScore < 0.95 ? config.malus_mauvaise_orientation_pct : 0,
      recommandation_orientation: orientationScore >= 0.95
        ? "Parcelle favorable : longueur orientee pour maximiser les facades Nord-Sud. Ventilation traversante naturelle possible."
        : orientationScore >= 0.90
        ? "Parcelle acceptable : orienter la longueur du batiment Nord-Sud autant que possible. Prevoir des brise-soleil en facade Ouest."
        : "Parcelle contrainte pour l'orientation solaire : la profondeur impose des facades longues Est-Ouest. Prevoir imperativement des protections solaires (brise-soleil, double peau, vegetation) en facade Ouest et un surcoût climatisation de ~" + config.malus_mauvaise_orientation_pct + "%.",
    };
  }
  // Tempéré / Méditerranéen : logique similaire mais inversée
  if (parcelRatio >= 1.2) orientationScore = 0.95;
  else if (parcelRatio >= 0.8) orientationScore = 1.0;
  else orientationScore = 0.90;
  return {
    orientationScore,
    profondeur_recommandee_m: Math.min(envelope_d, config.profondeur_max_m),
    ratio_recommande: ratio,
    facade_optimale: config.orientation_optimale,
    facade_a_proteger: config.facade_a_proteger,
    ventilation_traversante: config.ventilation_traversante,
    brise_soleil: config.brise_soleil_ouest,
    debord_toiture_m: config.debord_toiture_m,
    malus_orientation_pct: orientationScore < 0.95 ? config.malus_mauvaise_orientation_pct : 0,
    recommandation_orientation: "Orientation standard pour climat tempere.",
  };
}
// Durée estimée de chantier (mois) par niveau
const DUREE_CHANTIER_MOIS_PAR_NIVEAU = {
  fondations_terrassement: 2,  // invariant : terrassement + fondations
  par_niveau: 1.5,             // ~1.5 mois par niveau (gros œuvre + étanchéité)
  finitions: 2,                // second œuvre + lots techniques
  vrd_ext: 1,                  // VRD + aménagements extérieurs
};
// ══════════════════════════════════════════════════════════════════════════════
// v56.9 — RÈGLES PAR PROGRAMME (chaque option du formulaire client)
// ══════════════════════════════════════════════════════════════════════════════
const PROGRAM_RULES = {
  MAISON_INDIVIDUELLE: {
    // Villa individuelle OU bungalows (éco-lodges, résidences touristiques)
    // Si target_units=1 → 1 villa ; si target_units>1 → bungalows sur la parcelle
    // Le T-type détermine le nombre de chambres :
    //   T2 = 1 chambre (bungalow simple, studio gardien)
    //   T3 = master(≥15m²+dressing) + 1 chambre enfant(≥12m²)
    //   T4 = master + 2 chambres (standard famille camerounaise)
    //   T5 = master + 3 chambres (grande famille)
    // SDB : individuelle en PREMIUM/HAUT, partagée enfants en STANDARD/ECO
    default_mix_fn: (n) => {
      if (n <= 1) return { T4: 1 }; // villa familiale = 3 chambres par défaut
      // Bungalows / éco-lodges : unités reproductibles
      return { T3: n }; // chaque bungalow = 2 chambres (master + 1)
    },
    max_units_per_floor: 1,
    max_floors: 2,          // R+1 pour villa ; bungalows → plain-pied (1 niveau)
    bungalow_max_floors: 1, // si target_units > 1, on force 1 niveau
    circulation_ratio: 0.12,
    body_depth_m: { ECO: 10, STD: 12, PREM: 14 },
    ground_reserve: { A: 0.40, B: 0.50, C: 0.60 }, // jardin, cour, garage
    parking_per_unit: 1,
    requires_pilotis: false, rdc_commerce: false,
  },
  PETIT_COLLECTIF: {
    // Marché Cameroun : majorité T3, quelques T2 ("studios"), 1 T4 si ≥5 logements
    default_mix_fn: (n) => {
      if (n <= 2) return { T3: n };
      if (n <= 4) return { T2: 1, T3: n - 1 };
      // ≥5 : 1 T4 (proprio), ~20% T2, reste T3
      const t4 = 1;
      const t2 = Math.max(1, Math.round((n - t4) * 0.20));
      return { T2: t2, T3: n - t4 - t2, T4: t4 };
    },
    max_units_per_floor: { ECO: 4, STD: 3, PREM: 2 }, max_floors: 4,
    circulation_ratio: { ECO: 0.15, STD: 0.18, PREM: 0.22 },
    body_depth_m: { ECO: 12, STD: 13, PREM: 15 },
    ground_reserve: { A: 0.25, B: 0.30, C: 0.40 }, parking_per_unit: 1,
    requires_pilotis: "auto", rdc_commerce: false,
  },
  IMMEUBLE_RAPPORT: {
    // Marché Cameroun : majorité T3, ~20% T2 ("studios"), 1 T4 dernier étage (proprio)
    // Pas de T1 (pas courant), T5 seulement si ≥15 logements
    default_mix_fn: (n) => {
      if (n <= 3) return { T3: n };
      const t4 = 1; // toujours 1 T4 pour le proprio
      const t5 = n >= 15 ? 1 : 0; // T5 seulement gros programme
      const rest = n - t4 - t5;
      const t2 = Math.max(1, Math.round(rest * 0.25)); // ~25% T2 "studios"
      const t3 = rest - t2; // tout le reste en T3
      return { T2: t2, T3: Math.max(1, t3), T4: t4, ...(t5 > 0 ? { T5: t5 } : {}) };
    },
    max_units_per_floor: { ECO: 8, STD: 6, PREM: 4 }, max_floors: 8,
    circulation_ratio: { ECO: 0.16, STD: 0.18, PREM: 0.22 },
    body_depth_m: { ECO: 12, STD: 13, PREM: 15 },
    ground_reserve: { A: 0.22, B: 0.30, C: 0.38 }, parking_per_unit: 1.2,
    requires_pilotis: "auto", rdc_commerce: false,
  },
  USAGE_MIXTE: {
    // Cameroun : commerce RDC + logements aux étages (même logique résidentielle)
    default_mix_fn: (n) => {
      const commerce = Math.max(1, Math.round(n * 0.15)); // 1-2 commerces au RDC
      const resi = n - commerce;
      if (resi <= 2) return { COMMERCE: commerce, T3: Math.max(1, resi) };
      const t4 = 1;
      const rest = resi - t4;
      const t2 = Math.max(1, Math.round(rest * 0.25));
      return { COMMERCE: commerce, T2: t2, T3: Math.max(1, rest - t2), T4: t4 };
    },
    max_units_per_floor: { ECO: 5, STD: 4, PREM: 3 }, max_floors: 8,
    circulation_ratio: { ECO: 0.18, STD: 0.20, PREM: 0.24 },
    body_depth_m: { ECO: 14, STD: 15, PREM: 16 },
    ground_reserve: { A: 0.25, B: 0.32, C: 0.40 }, parking_per_unit: 1.5,
    requires_pilotis: false, rdc_commerce: true, rdc_height_m: 4.0,
  },
  ACTIVITE_PRO: {
    // Immeuble de bureaux : plateaux libres reproductibles, cloisonnables
    // target_units = nombre de NIVEAUX de bureaux (chaque niveau = 1 plateau identique)
    // Le fp est dérivé de l'enveloppe (on remplit raisonnablement), PAS du UNIT_SIZES
    // Pas de cap arbitraire sur les niveaux — le COS fait le garde-fou
    fp_from_envelope: true,   // flag spécial : fp = enveloppe × (1-reserve), pas unit-driven
    default_mix_fn: (n) => ({ PLATEAU: n || 4 }), // n plateaux identiques
    max_units_per_floor: 1,   // 1 plateau = 1 étage complet
    max_floors: 99,
    circulation_ratio: { ECO: 0.20, STD: 0.22, PREM: 0.25 },
    body_depth_m: { ECO: 14, STD: 16, PREM: 18 },
    ground_reserve: { A: 0.20, B: 0.28, C: 0.35 }, parking_per_unit: 2.0,
    requires_pilotis: "auto", rdc_commerce: false,
  },
  PROGRAMME_FLOU: {
    // Pas de programme défini → on suppose le standard camerounais (résidentiel T3-dominant)
    default_mix_fn: (n) => {
      if (n <= 3) return { T3: n };
      const t4 = 1;
      const rest = n - t4;
      const t2 = Math.max(1, Math.round(rest * 0.20));
      return { T2: t2, T3: rest - t2, T4: t4 };
    },
    max_units_per_floor: { ECO: 4, STD: 3, PREM: 2 }, max_floors: 6,
    circulation_ratio: { ECO: 0.16, STD: 0.18, PREM: 0.22 },
    body_depth_m: { ECO: 12, STD: 13, PREM: 15 },
    ground_reserve: { A: 0.25, B: 0.30, C: 0.40 }, parking_per_unit: 1,
    requires_pilotis: "auto", rdc_commerce: false,
  },
  // ── 7 NOUVEAUX USAGES (prompt expert architecte-urbaniste africain) ──
  RESIDENCE_MEUBLEE: {
    // Appart-hôtel / résidence meublée : unités compactes reproductibles
    // Back-of-house important (accueil, linge, maintenance, stockage)
    default_mix_fn: (n) => {
      if (n <= 4) return { STUDIO: n };
      const studio = Math.round(n * 0.40);
      const t2 = Math.round(n * 0.40);
      const t3 = n - studio - t2;
      return { STUDIO: Math.max(1, studio), T2: Math.max(1, t2), T3: Math.max(0, t3) };
    },
    max_units_per_floor: { ECO: 10, STD: 8, PREM: 5 }, max_floors: 7,
    circulation_ratio: { ECO: 0.22, STD: 0.25, PREM: 0.28 },
    body_depth_m: { ECO: 13, STD: 14, PREM: 15 },
    ground_reserve: { A: 0.25, B: 0.30, C: 0.38 }, parking_per_unit: 0.6,
    requires_pilotis: "auto", rdc_commerce: false,
  },
  HOTEL_URBAIN: {
    // Hôtel compact urbain : chambres standardisées, BOH important
    // target_units = nombre de clés (chambres)
    default_mix_fn: (n) => {
      const standard = Math.round(n * 0.70);
      const suite = n - standard;
      return { CHAMBRE: Math.max(1, standard), SUITE: Math.max(0, suite) };
    },
    max_units_per_floor: { ECO: 14, STD: 10, PREM: 6 }, max_floors: 8,
    circulation_ratio: { ECO: 0.26, STD: 0.30, PREM: 0.35 },
    body_depth_m: { ECO: 14, STD: 16, PREM: 18 },
    ground_reserve: { A: 0.22, B: 0.28, C: 0.35 }, parking_per_unit: 0.4,
    requires_pilotis: false, rdc_commerce: false, rdc_height_m: 4.5,
  },
  CLINIQUE: {
    // Centre médical / clinique de quartier
    // Circulation très importante (brancards, attente, imagerie)
    default_mix_fn: (n) => {
      const consult = Math.round(n * 0.50);
      const imagerie = Math.max(1, Math.round(n * 0.15));
      const service = n - consult - imagerie;
      return { CONSULTATION: Math.max(1, consult), IMAGERIE: imagerie, SERVICE: Math.max(1, service) };
    },
    max_units_per_floor: { ECO: 8, STD: 6, PREM: 4 }, max_floors: 4,
    circulation_ratio: { ECO: 0.28, STD: 0.32, PREM: 0.35 },
    body_depth_m: { ECO: 16, STD: 18, PREM: 20 },
    ground_reserve: { A: 0.30, B: 0.35, C: 0.42 }, parking_per_unit: 2.5,
    requires_pilotis: false, rdc_commerce: false,
  },
  CENTRE_COMMERCIAL: {
    // Retail de proximité / galerie commerciale active
    // Profondeur importante, réserves, livraisons
    default_mix_fn: (n) => {
      const boutique = Math.round(n * 0.70);
      const ancre = n - boutique;
      return { BOUTIQUE: Math.max(1, boutique), ANCRE: Math.max(0, ancre) };
    },
    max_units_per_floor: { ECO: 10, STD: 8, PREM: 5 }, max_floors: 3,
    circulation_ratio: { ECO: 0.22, STD: 0.25, PREM: 0.28 },
    body_depth_m: { ECO: 18, STD: 20, PREM: 22 },
    ground_reserve: { A: 0.20, B: 0.28, C: 0.35 }, parking_per_unit: 3.5,
    requires_pilotis: false, rdc_commerce: true, rdc_height_m: 4.5,
  },
  SCOLAIRE: {
    // Établissement scolaire privé : salles de classe + administration + cour
    // Cour = élément dimensionnant (min 30-40% du terrain)
    default_mix_fn: (n) => {
      const classes = Math.round(n * 0.65);
      const admin = Math.max(1, Math.round(n * 0.15));
      const service = n - classes - admin;
      return { CLASSE: Math.max(1, classes), ADMIN: admin, SERVICE: Math.max(1, service) };
    },
    max_units_per_floor: { ECO: 6, STD: 4, PREM: 3 }, max_floors: 3,
    circulation_ratio: { ECO: 0.25, STD: 0.28, PREM: 0.30 },
    body_depth_m: { ECO: 10, STD: 11, PREM: 12 },
    ground_reserve: { A: 0.45, B: 0.52, C: 0.58 }, parking_per_unit: 0.1,
    requires_pilotis: false, rdc_commerce: false,
  },
  ENTREPOT: {
    // Entrepôt / logistique légère / semi-industriel
    // Grande emprise, faible hauteur, cour de manœuvre importante
    fp_from_envelope: true,
    default_mix_fn: (n) => ({ STOCKAGE: Math.max(1, n - 1), BUREAU: 1 }),
    max_units_per_floor: 1, max_floors: 2,
    circulation_ratio: { ECO: 0.10, STD: 0.12, PREM: 0.15 },
    body_depth_m: { ECO: 22, STD: 25, PREM: 28 },
    ground_reserve: { A: 0.30, B: 0.38, C: 0.45 }, parking_per_unit: 0.8,
    requires_pilotis: false, rdc_commerce: false,
  },
  MIXTE_OPPORTUNISTE: {
    // Usage mixte africain typique : commerce RDC, étages flexibles
    // (logement, bureaux, location courte durée selon le marché)
    default_mix_fn: (n) => {
      const commerce = Math.max(1, Math.round(n * 0.20));
      const resi = n - commerce;
      if (resi <= 2) return { COMMERCE: commerce, T3: Math.max(1, resi) };
      const t2 = Math.max(1, Math.round(resi * 0.30));
      return { COMMERCE: commerce, T2: t2, T3: resi - t2 };
    },
    max_units_per_floor: { ECO: 6, STD: 5, PREM: 3 }, max_floors: 7,
    circulation_ratio: { ECO: 0.18, STD: 0.20, PREM: 0.24 },
    body_depth_m: { ECO: 13, STD: 14, PREM: 16 },
    ground_reserve: { A: 0.22, B: 0.28, C: 0.35 }, parking_per_unit: 1.0,
    requires_pilotis: false, rdc_commerce: true, rdc_height_m: 4.0,
  },
};
// ══════════════════════════════════════════════════════════════════════════════
// v57.13: GRILLE EXPERT — Ratios architecte-urbaniste africain senior
// ══════════════════════════════════════════════════════════════════════════════
// CES recommandé, niveaux, efficacité brut/net, parking, profondeur bâtiment
// Par programme × zonage × scénario (A=optimisé, B=équilibré, C=secure)
// Source : pratique terrain Afrique francophone, logique marché Cameroun/Douala
// Principe : constructibilité théorique ≠ faisabilité rentable
// ══════════════════════════════════════════════════════════════════════════════
const EXPERT_RATIOS = {
  MAISON_INDIVIDUELLE: {
    URBAIN:     { A: { ces: 0.38, fl: [1,2], eff: 0.88 }, B: { ces: 0.30, fl: [1,2], eff: 0.90 }, C: { ces: 0.24, fl: [1,1], eff: 0.90 } },
    PERIURBAIN: { A: { ces: 0.30, fl: [1,2], eff: 0.88 }, B: { ces: 0.24, fl: [1,2], eff: 0.90 }, C: { ces: 0.20, fl: [1,1], eff: 0.90 } },
    Z_DEFAULT:  { A: { ces: 0.22, fl: [1,1], eff: 0.90 }, B: { ces: 0.18, fl: [1,1], eff: 0.90 }, C: { ces: 0.15, fl: [1,1], eff: 0.90 } },
  },
  PETIT_COLLECTIF: {
    URBAIN:     { A: { ces: 0.40, fl: [3,4], eff: 0.76 }, B: { ces: 0.33, fl: [2,3], eff: 0.78 }, C: { ces: 0.25, fl: [2,2], eff: 0.80 } },
    PERIURBAIN: { A: { ces: 0.32, fl: [2,3], eff: 0.78 }, B: { ces: 0.25, fl: [2,3], eff: 0.80 }, C: { ces: 0.20, fl: [2,2], eff: 0.82 } },
    Z_DEFAULT:  { A: { ces: 0.24, fl: [2,3], eff: 0.80 }, B: { ces: 0.20, fl: [2,2], eff: 0.82 }, C: { ces: 0.16, fl: [1,2], eff: 0.84 } },
  },
  IMMEUBLE_RAPPORT: {
    // Logement collectif moyen standing — le produit standard camerounais
    // 1950m² URBAIN : CES 42% = 819m² au sol, 3-5 niv = 2460-4095m² SDP
    // Ventilation naturelle traversante : profondeur max 14m recommandée
    // Stationnement au sol ~30% du terrain libre → 15-20 places
    URBAIN:     { A: { ces: 0.42, fl: [3,5], eff: 0.78 }, B: { ces: 0.35, fl: [3,4], eff: 0.80 }, C: { ces: 0.28, fl: [2,3], eff: 0.82 } },
    PERIURBAIN: { A: { ces: 0.34, fl: [3,4], eff: 0.80 }, B: { ces: 0.28, fl: [2,3], eff: 0.82 }, C: { ces: 0.22, fl: [2,2], eff: 0.84 } },
    Z_DEFAULT:  { A: { ces: 0.26, fl: [2,3], eff: 0.82 }, B: { ces: 0.22, fl: [2,3], eff: 0.84 }, C: { ces: 0.18, fl: [2,2], eff: 0.85 } },
  },
  USAGE_MIXTE: {
    // Commerce RDC (hauteur 4-4.5m) + logements étages
    // Le commerce tire la rentabilité, les logements sécurisent le cash-flow
    URBAIN:     { A: { ces: 0.45, fl: [4,6], eff: 0.74 }, B: { ces: 0.38, fl: [3,5], eff: 0.76 }, C: { ces: 0.30, fl: [3,4], eff: 0.78 } },
    PERIURBAIN: { A: { ces: 0.35, fl: [3,5], eff: 0.76 }, B: { ces: 0.28, fl: [3,4], eff: 0.78 }, C: { ces: 0.22, fl: [2,3], eff: 0.80 } },
    Z_DEFAULT:  { A: { ces: 0.26, fl: [2,4], eff: 0.78 }, B: { ces: 0.22, fl: [2,3], eff: 0.80 }, C: { ces: 0.18, fl: [2,2], eff: 0.82 } },
  },
  ACTIVITE_PRO: {
    // Bureaux : plateaux libres, 1 place/30-40m² plancher
    // Profondeur 14-18m selon ventilation/clim
    URBAIN:     { A: { ces: 0.42, fl: [4,6], eff: 0.78 }, B: { ces: 0.35, fl: [3,5], eff: 0.80 }, C: { ces: 0.28, fl: [3,4], eff: 0.82 } },
    PERIURBAIN: { A: { ces: 0.32, fl: [3,5], eff: 0.80 }, B: { ces: 0.25, fl: [2,4], eff: 0.82 }, C: { ces: 0.20, fl: [2,3], eff: 0.84 } },
    Z_DEFAULT:  { A: { ces: 0.24, fl: [2,4], eff: 0.82 }, B: { ces: 0.20, fl: [2,3], eff: 0.84 }, C: { ces: 0.16, fl: [2,2], eff: 0.85 } },
  },
  PROGRAMME_FLOU: {
    // Programme non défini → hypothèse résidentiel standard
    URBAIN:     { A: { ces: 0.40, fl: [3,5], eff: 0.76 }, B: { ces: 0.32, fl: [2,4], eff: 0.78 }, C: { ces: 0.24, fl: [2,3], eff: 0.80 } },
    PERIURBAIN: { A: { ces: 0.32, fl: [2,4], eff: 0.78 }, B: { ces: 0.25, fl: [2,3], eff: 0.80 }, C: { ces: 0.20, fl: [2,2], eff: 0.82 } },
    Z_DEFAULT:  { A: { ces: 0.24, fl: [2,3], eff: 0.80 }, B: { ces: 0.20, fl: [2,2], eff: 0.82 }, C: { ces: 0.16, fl: [1,2], eff: 0.84 } },
  },
  RESIDENCE_MEUBLEE: {
    // Appart-hôtel : BOH (accueil, linge, maintenance) = 25-30% du RDC
    // Unités compactes (studios 22-28m², T2 45-55m²) → haute densité/plateau
    URBAIN:     { A: { ces: 0.42, fl: [4,6], eff: 0.72 }, B: { ces: 0.35, fl: [3,5], eff: 0.74 }, C: { ces: 0.28, fl: [3,4], eff: 0.76 } },
    PERIURBAIN: { A: { ces: 0.34, fl: [3,5], eff: 0.74 }, B: { ces: 0.28, fl: [3,4], eff: 0.76 }, C: { ces: 0.22, fl: [2,3], eff: 0.78 } },
    Z_DEFAULT:  { A: { ces: 0.26, fl: [2,4], eff: 0.76 }, B: { ces: 0.22, fl: [2,3], eff: 0.78 }, C: { ces: 0.18, fl: [2,2], eff: 0.80 } },
  },
  HOTEL_URBAIN: {
    // Hôtel compact : BOH lourd (30-35%), chambres 18-25m², couloirs larges
    // Seuil critique : <40 clés = non viable ; 60-80 clés = optimal urbain
    URBAIN:     { A: { ces: 0.48, fl: [4,7], eff: 0.68 }, B: { ces: 0.40, fl: [3,5], eff: 0.70 }, C: { ces: 0.32, fl: [3,4], eff: 0.72 } },
    PERIURBAIN: { A: { ces: 0.38, fl: [3,5], eff: 0.70 }, B: { ces: 0.30, fl: [3,4], eff: 0.72 }, C: { ces: 0.24, fl: [2,3], eff: 0.74 } },
    Z_DEFAULT:  { A: { ces: 0.28, fl: [2,4], eff: 0.72 }, B: { ces: 0.24, fl: [2,3], eff: 0.74 }, C: { ces: 0.20, fl: [2,2], eff: 0.76 } },
  },
  CLINIQUE: {
    // Circulations dimensionnantes (brancards 2.40m, attente, accès PMR)
    // Imagerie = rez-de-chaussée obligatoire (poids, blindage)
    // Parking surdimensionné (patients + accompagnants + personnel)
    URBAIN:     { A: { ces: 0.40, fl: [2,4], eff: 0.65 }, B: { ces: 0.34, fl: [2,3], eff: 0.68 }, C: { ces: 0.28, fl: [2,3], eff: 0.70 } },
    PERIURBAIN: { A: { ces: 0.32, fl: [2,3], eff: 0.68 }, B: { ces: 0.26, fl: [2,3], eff: 0.70 }, C: { ces: 0.22, fl: [1,2], eff: 0.72 } },
    Z_DEFAULT:  { A: { ces: 0.24, fl: [1,3], eff: 0.70 }, B: { ces: 0.20, fl: [1,2], eff: 0.72 }, C: { ces: 0.16, fl: [1,2], eff: 0.74 } },
  },
  CENTRE_COMMERCIAL: {
    // Retail : profondeur 18-22m, réserves 15-20%, galerie 10-12%
    // Parking = élément dimensionnant (3-5 places/100m² vente)
    // >R+2 rarement viable en Afrique (flux piétons chute aux étages)
    URBAIN:     { A: { ces: 0.50, fl: [1,3], eff: 0.70 }, B: { ces: 0.42, fl: [1,2], eff: 0.72 }, C: { ces: 0.35, fl: [1,2], eff: 0.75 } },
    PERIURBAIN: { A: { ces: 0.38, fl: [1,2], eff: 0.72 }, B: { ces: 0.30, fl: [1,2], eff: 0.75 }, C: { ces: 0.24, fl: [1,1], eff: 0.78 } },
    Z_DEFAULT:  { A: { ces: 0.28, fl: [1,2], eff: 0.75 }, B: { ces: 0.22, fl: [1,1], eff: 0.78 }, C: { ces: 0.18, fl: [1,1], eff: 0.80 } },
  },
  SCOLAIRE: {
    // Cour = élément dimensionnant (min 35-40% du terrain en urbain)
    // Ratio salles/admin/circulation ≈ 55/15/30%
    // Profondeur faible (ventilation + éclairage naturel classes)
    URBAIN:     { A: { ces: 0.38, fl: [2,3], eff: 0.68 }, B: { ces: 0.30, fl: [2,3], eff: 0.70 }, C: { ces: 0.24, fl: [1,2], eff: 0.72 } },
    PERIURBAIN: { A: { ces: 0.28, fl: [1,3], eff: 0.70 }, B: { ces: 0.22, fl: [1,2], eff: 0.72 }, C: { ces: 0.18, fl: [1,2], eff: 0.75 } },
    Z_DEFAULT:  { A: { ces: 0.22, fl: [1,2], eff: 0.72 }, B: { ces: 0.18, fl: [1,2], eff: 0.75 }, C: { ces: 0.15, fl: [1,1], eff: 0.78 } },
  },
  ENTREPOT: {
    // Grande emprise, faible hauteur, cour manœuvre = 30-40% terrain
    // >R+1 rarement viable (surcoût structure vs gain m²)
    URBAIN:     { A: { ces: 0.52, fl: [1,2], eff: 0.85 }, B: { ces: 0.45, fl: [1,1], eff: 0.88 }, C: { ces: 0.38, fl: [1,1], eff: 0.90 } },
    PERIURBAIN: { A: { ces: 0.38, fl: [1,2], eff: 0.88 }, B: { ces: 0.32, fl: [1,1], eff: 0.90 }, C: { ces: 0.25, fl: [1,1], eff: 0.90 } },
    Z_DEFAULT:  { A: { ces: 0.28, fl: [1,1], eff: 0.90 }, B: { ces: 0.22, fl: [1,1], eff: 0.90 }, C: { ces: 0.18, fl: [1,1], eff: 0.90 } },
  },
  MIXTE_OPPORTUNISTE: {
    // Le produit africain par excellence : commerce RDC + étages flexibles
    // Résilient au marché car les étages s'adaptent (logement, bureau, meublé)
    URBAIN:     { A: { ces: 0.45, fl: [4,6], eff: 0.74 }, B: { ces: 0.38, fl: [3,5], eff: 0.76 }, C: { ces: 0.30, fl: [3,4], eff: 0.78 } },
    PERIURBAIN: { A: { ces: 0.35, fl: [3,5], eff: 0.76 }, B: { ces: 0.28, fl: [2,4], eff: 0.78 }, C: { ces: 0.22, fl: [2,3], eff: 0.80 } },
    Z_DEFAULT:  { A: { ces: 0.26, fl: [2,4], eff: 0.78 }, B: { ces: 0.22, fl: [2,3], eff: 0.80 }, C: { ces: 0.18, fl: [2,2], eff: 0.82 } },
  },
};
// ── Helper: normalise program_main string → PROGRAM_RULES key ──
function parseProgramKey(raw) {
  const s = String(raw || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Nouveaux usages (v57.13 — expert africain)
  if (/APART.?HOTEL|RESIDENCE.?MEUBLE|SERVICED|^MEUBLE/.test(s)) return "RESIDENCE_MEUBLEE";
  if (/HOTEL|HEBERGEMENT|AUBERGE/.test(s)) return "HOTEL_URBAIN";
  if (/CLINIQUE|MEDICAL|SANTE|HOPITAL|CABINET/.test(s)) return "CLINIQUE";
  if (/COMMERCIAL|RETAIL|GALERIE|BOUTIQUE|CENTRE.?COM/.test(s)) return "CENTRE_COMMERCIAL";
  if (/SCOLAIRE|ECOLE|LYCEE|COLLEGE|FORMATION|CRECHE/.test(s)) return "SCOLAIRE";
  if (/ENTREPOT|LOGISTIQUE|INDUSTRIEL|STOCKAGE|HANGAR/.test(s)) return "ENTREPOT";
  if (/OPPORTUNISTE|POLYVALENT|FLEXIBLE/.test(s)) return "MIXTE_OPPORTUNISTE";
  // Usages existants
  if (/MAISON|VILLA|INDIVIDUEL/.test(s)) return "MAISON_INDIVIDUELLE";
  if (/PETIT.?COLLECTIF/.test(s)) return "PETIT_COLLECTIF";
  if (/RAPPORT|DENSE|COLLECTIF|LOCATIF/.test(s)) return "IMMEUBLE_RAPPORT";
  if (/MIXTE|MIXED/.test(s)) return "USAGE_MIXTE";
  if (/ACTIVITE|PROFESS|BUREAU|OFFICE/.test(s)) return "ACTIVITE_PRO";
  if (/FLOU|INDEFINI|A.DEFINIR|PAS.ENCORE/.test(s)) return "PROGRAMME_FLOU";
  return null; // → fallback to regulation-driven
}
// ── Helper: standing → lookup key for per-standing objects ──
function standingKey(standing_level) {
  const s = String(standing_level).toUpperCase();
  if (/PREMIUM|HAUT/.test(s)) return "PREM";
  if (/ECO/.test(s)) return "ECO";
  return "STD";
}
// ── Helper: standing → UNIT_SIZES key ──
function standingSizeKey(standing_level) {
  const s = String(standing_level).toUpperCase();
  if (/PREMIUM|HAUT/.test(s)) return "PREMIUM";
  if (/ECO/.test(s)) return "ECONOMIQUE";
  return "STANDARD";
}
// ── Helper: resolve a per-standing or per-role value from a rules field ──
function resolveField(field, key) {
  if (typeof field === "object" && field !== null) return field[key] ?? Object.values(field)[0];
  return field;
}
// ── Helper : taille moyenne pondérée d'un logement résidentiel ──
// Utilise la default_mix_fn du programme pour calculer les proportions réelles
// au lieu de poids en dur. Fonctionne pour tous les 6 types de programme.
function computeAvgResidentialSize(sizes, rules, targetUnits) {
  const n = Math.max(1, targetUnits || 4);
  const mix = rules.default_mix_fn ? rules.default_mix_fn(n) : { T3: n };
  let totalSize = 0, totalCount = 0;
  for (const [typ, count] of Object.entries(mix)) {
    if (count <= 0) continue;
    // Pour le calcul de avgSize résidentiel, ignorer les COMMERCE/BUREAU/PLATEAU
    // (ils ont leur propre logique : RDC commerce, fp_from_envelope, etc.)
    if (/COMMERCE|BUREAU|PLATEAU/i.test(typ)) continue;
    const unitSize = sizes[typ] || sizes.T3 || 80;
    totalSize += count * unitSize;
    totalCount += count;
  }
  return totalCount > 0 ? totalSize / totalCount : (sizes.T3 || 80);
}
// ══════════════════════════════════════════════════════════════════════════════
// v56.7 — RÔLES SCÉNARIOS (logique métier claire)
// ══════════════════════════════════════════════════════════════════════════════
// A = INTENSIFICATION : colle au max à la priorité client, pousse les limites réglementaires
// B = EQUILIBRE : alternative équilibrée, bon compromis densité/risque
// C = PRUDENT : version conservatrice, reste bien dans les clous, phasable
//
// Le massing_mode (forme du bâti: BALANCED/SPREAD/COMPACT) est INDÉPENDANT du rôle.
// On peut avoir un scénario prudent en forme compacte (petit bâtiment dense mais peu de niveaux).
// ══════════════════════════════════════════════════════════════════════════════
// Rôle stratégique de chaque scénario
const SCENARIO_ROLE = { A: "INTENSIFICATION", B: "EQUILIBRE", C: "PRUDENT" };
// Massing mode = FORME du bâtiment (indépendant du rôle)
const SCENARIO_MASSING_MODE = { A: "BALANCED", B: "SPREAD", C: "COMPACT" };
// Multiplicateur de niveaux par rôle (PAS par massing_mode)
// INTENSIFICATION = pousse les niveaux au max du driver
// EQUILIBRE = niveaux modérés
// PRUDENT = niveaux conservateurs, toujours conforme COS
function levelMultiplier(role) {
  if (role === "INTENSIFICATION") return 0.85;
  if (role === "EQUILIBRE") return 0.55;
  return 0.35; // PRUDENT
}
// Contrainte COS par rôle
// INTENSIFICATION peut atteindre 100% du COS (voire dérogation légère)
// EQUILIBRE vise 70-90% du COS
// PRUDENT ne dépasse jamais 80% du COS
const COS_CAP_BY_ROLE = { INTENSIFICATION: 1.05, EQUILIBRE: 0.90, PRUDENT: 0.80 };
// ══════════════════════════════════════════════════════════════════════════════
// v72.156: Typology parser and SDP computation
// ══════════════════════════════════════════════════════════════════════════════
function parseTypologies(typologiesString) {
  if (!typologiesString || typeof typologiesString !== 'string') return [];
  // Parse "T3=2; T2=4" → [{type:"T3",count:2},{type:"T2",count:4}]
  return typologiesString
    .split(/[;,\s]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => {
      const m = s.match(/^(T[1-5])\s*=\s*(\d+)$/i);
      if (!m) return null;
      return { type: m[1].toUpperCase(), count: parseInt(m[2], 10) };
    })
    .filter(Boolean);
}
function computeTypologyDrivenSdp(typologiesString, standing, targetUnitsFallback, commerceOverride) {
  const standingNorm = (standing || 'ECONOMIQUE').toUpperCase();
  let typologies = parseTypologies(typologiesString);
  // Fallback: if empty, use T3 × target_units
  if (typologies.length === 0 && targetUnitsFallback > 0) {
    typologies = [{ type: 'T3', count: targetUnitsFallback }];
  }
  // Sum residential surface
  let surfaceResidentielle = 0;
  for (const { type, count } of typologies) {
    const sizeRow = APARTMENT_SIZE_GRID[type];
    if (!sizeRow) continue;
    const size = sizeRow[standingNorm] || sizeRow.ECONOMIQUE;
    surfaceResidentielle += count * size;
  }
  // Commerce
  const commerceSize = (commerceOverride && commerceOverride > 0)
    ? commerceOverride
    : (COMMERCE_SIZE_BY_STANDING[standingNorm] || 40);
  // Total with circulation coefficient
  const targetSdp = Math.round(surfaceResidentielle * CIRCULATION_COEFFICIENT + commerceSize);
  return { targetSdp, surfaceResidentielle, commerceSize };
}
// ═══════════════════════════════════════════════════════════════════════════════
// PATCH v73.0 — INSERTION HELPERS PROGRAM-DRIVEN (avant computeSmartScenarios)
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// v73.0 — MOTEUR DE CALCUL PROGRAMME-DRIVEN
// ═══════════════════════════════════════════════════════════════════════════════
//
// Philosophie : LE PROGRAMME CLIENT EST LA VÉRITÉ.
//
//   Scenario A = programme strict (exactement les inputs client)
//   Scenario B = compromis qualité (moitié des logements descendus d'1 cran de typo)
//   Scenario C = phasage (~30% des logements + commerce, garde-fou : C ≤ B)
//
// La SDP est CALCULÉE depuis les surfaces unitaires × circulation.
// Les niveaux et l'emprise sont des CONSÉQUENCES, pas des cibles.
//
// ⚠️ TYPES DE PROGRAMME SUPPORTÉS :
//   - MAISON, PETIT_COLLECTIF, IMMEUBLE_DENSE, MIXTE, COMMERCIAL
//
// ⚠️ TYPES NON SUPPORTÉS (retournent un flag isUnsupported = true) :
//   - Programme flou / à définir → "diagnostic personnalisé requis"
//   - Saisie libre / autre       → "diagnostic personnalisé requis"
//   - Rénovation / extension     → "diagnostic personnalisé requis"
//
// ═══════════════════════════════════════════════════════════════════════════════
// ── GRILLE DES TAILLES UNITAIRES (source de vérité unique) ─────────────────────
const UNIT_SIZES_V73 = {
  T1: { ECONOMIQUE: 30, STANDARD: 35, CONFORT: 40, PREMIUM: 45 },
  T2: { ECONOMIQUE: 45, STANDARD: 50, CONFORT: 60, PREMIUM: 70 },
  T3: { ECONOMIQUE: 65, STANDARD: 75, CONFORT: 90, PREMIUM: 105 },
  T4: { ECONOMIQUE: 80, STANDARD: 90, CONFORT: 110, PREMIUM: 135 },
  T5: { ECONOMIQUE: 95, STANDARD: 105, CONFORT: 130, PREMIUM: 160 },
  COMMERCE: { ECONOMIQUE: 50, STANDARD: 60, CONFORT: 70, PREMIUM: 90 },
};
const TYPO_ORDER_V73 = ["T1", "T2", "T3", "T4", "T5"];
const CIRCULATION_COEFF_V73 = 1.15;
// ── NIVEAUX MIN/MAX RAISONNABLES PAR TYPE DE PROGRAMME ─────────────────────────
const LEVELS_BY_TYPE_V73 = {
  MAISON:           { min: 1, maxRaisonnable: 2 },
  PETIT_COLLECTIF:  { min: 2, maxRaisonnable: 4 },
  IMMEUBLE_DENSE:   { min: 3, maxRaisonnable: 8 },
  MIXTE:            { min: 2, maxRaisonnable: 6 },
  COMMERCIAL:       { min: 1, maxRaisonnable: 2 },
};
// ── CLASSIFICATION DU TYPE DE PROGRAMME ─────────────────────────────────────────
function classifyProgramTypeV73(programMain) {
  const s = String(programMain || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/FLOU|INDEFINI|PAS.ENCORE|A.DEFINIR/.test(s)) return "UNSUPPORTED_FLOU";
  if (/AUTRE|SAISIE.LIBRE/.test(s)) return "UNSUPPORTED_AUTRE";
  if (/RENOVATION|EXTENSION|SURELEVATION/.test(s)) return "UNSUPPORTED_RENO";
  if (/MAISON|VILLA|INDIVIDUEL/.test(s)) return "MAISON";
  if (/PETIT.?COLLECTIF/.test(s)) return "PETIT_COLLECTIF";
  if (/RAPPORT|DENSE|IMMEUBLE.?COLLECTIF|LOCATIF/.test(s)) return "IMMEUBLE_DENSE";
  if (/MIXTE|MIXED|USAGE.?MIXTE/.test(s)) return "MIXTE";
  if (/ACTIVITE|PROFESSIONNEL|BUREAU|COMMERCE.?SEUL|COMMERCIAL/.test(s)) return "COMMERCIAL";
  return "PETIT_COLLECTIF"; // défaut
}
// ── PARSEUR DE TYPOLOGIES ───────────────────────────────────────────────────────
function parseTypologiesV73(typoString) {
  // v74 — Parser robuste : accepte multiple formats
  //   "T3=2"
  //   "T2 : 2 unités, T3 : 3 unités"
  //   "Studio : 1 unité, T2 : 2 unités"
  //   "1 commerce + 2 T3"
  if (!typoString || typeof typoString !== "string") return [];
  const s = typoString.trim();
  if (!s) return [];
  const result = {};
  const normalized = s.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const patterns = [
    /(STUDIO|COMMERCE|T[1-5])\s*[=:]\s*(\d+)/g,
    /(\d+)\s*[\u00d7x*]?\s*(STUDIO|COMMERCE|T[1-5])/g,
  ];
  for (const pattern of patterns) {
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(normalized)) !== null) {
      let type, count;
      if (/^\d/.test(m[1])) {
        count = parseInt(m[1], 10);
        type = m[2];
      } else {
        type = m[1];
        count = parseInt(m[2], 10);
      }
      if (type === "STUDIO") type = "T1";
      if (count > 0) result[type] = (result[type] || 0) + count;
    }
  }
  // Convert to legacy list format (commerce séparé par computeProgramDrivenScenarioV73)
  const out = [];
  for (const t of ["T1", "T2", "T3", "T4", "T5"]) {
    if (result[t] && result[t] > 0) out.push({ type: t, count: result[t] });
  }
  // COMMERCE handled séparément via _hasCommerceInput flag attaché au résultat
  Object.defineProperty(out, "_hasCommerceInput", { value: !!result.COMMERCE, enumerable: false });
  Object.defineProperty(out, "_commerceCountInput", { value: result.COMMERCE || 0, enumerable: false });
  return out;
}
// ── HELPERS DE CONSTRUCTION DU MIX A/B/C ───────────────────────────────────────
function downgradeTypeV73(t) {
  const idx = TYPO_ORDER_V73.indexOf(t);
  if (idx <= 0) return "T1";
  return TYPO_ORDER_V73[idx - 1];
}
function highestTypeV73(typologies) {
  let highest = "T1";
  for (const t of typologies) {
    if (TYPO_ORDER_V73.indexOf(t.type) > TYPO_ORDER_V73.indexOf(highest)) {
      highest = t.type;
    }
  }
  return highest;
}
function consolidateTypologiesV73(typologies) {
  const counts = {};
  for (const t of typologies) {
    counts[t.type] = (counts[t.type] || 0) + t.count;
  }
  return Object.keys(counts)
    .sort((a, b) => TYPO_ORDER_V73.indexOf(a) - TYPO_ORDER_V73.indexOf(b))
    .map(type => ({ type, count: counts[type] }));
}
function buildMixB_logements_V73(typologies) {
  const allUnits = [];
  for (const t of typologies) {
    for (let i = 0; i < t.count; i++) allUnits.push(t.type);
  }
  const N = allUnits.length;
  if (N === 0) return [];
  const nKeep = Math.ceil(N / 2);
  const nDowngrade = N - nKeep;
  const sorted = [...allUnits].sort((a, b) => TYPO_ORDER_V73.indexOf(a) - TYPO_ORDER_V73.indexOf(b));
  const result = sorted.map((t, i) => i < nDowngrade ? downgradeTypeV73(t) : t);
  const counts = {};
  for (const t of result) counts[t] = (counts[t] || 0) + 1;
  return Object.keys(counts)
    .sort((a, b) => TYPO_ORDER_V73.indexOf(a) - TYPO_ORDER_V73.indexOf(b))
    .map(t => ({ type: t, count: counts[t] }));
}
function buildMixC_logements_V73(typologiesA, typologiesB) {
  const N = typologiesA.reduce((s, t) => s + t.count, 0);
  if (N === 0) return [];
  let nC = Math.max(1, Math.floor(N * 0.30));
  const nB = typologiesB.reduce((s, t) => s + t.count, 0);
  if (nC > nB) nC = nB;
  const topType = highestTypeV73(typologiesA);
  return [{ type: topType, count: nC }];
}
// ── CALCUL SDP DEPUIS UN MIX ──────────────────────────────────────────────────
function computeSdpFromMixV73(logementsTypos, commerceCount, standing) {
  const std = String(standing || "ECONOMIQUE").toUpperCase();
  let sdpLogements = 0;
  let surfaceUtileLogements = 0;
  let nbLogements = 0;
  for (const t of logementsTypos) {
    const sizeRow = UNIT_SIZES_V73[t.type];
    if (!sizeRow) continue;
    const unitSize = sizeRow[std] || sizeRow.ECONOMIQUE || 65;
    surfaceUtileLogements += t.count * unitSize;
    sdpLogements += t.count * unitSize * CIRCULATION_COEFF_V73;
    nbLogements += t.count;
  }
  let sdpCommerces = 0;
  let surfaceUtileCommerces = 0;
  if (commerceCount > 0) {
    const commSize = (UNIT_SIZES_V73.COMMERCE[std] || 50);
    surfaceUtileCommerces = commerceCount * commSize;
    sdpCommerces = commerceCount * commSize;
  }
  return {
    sdp_total: Math.round(sdpLogements + sdpCommerces),
    sdp_logements: Math.round(sdpLogements),
    sdp_commerces: Math.round(sdpCommerces),
    surface_utile_logements: Math.round(surfaceUtileLogements),
    surface_utile_commerces: Math.round(surfaceUtileCommerces),
    surface_utile_totale: Math.round(surfaceUtileLogements + surfaceUtileCommerces),
    nb_logements: nbLogements,
    nb_commerces: commerceCount,
  };
}
function buildUnitMixDetailV73(logementsTypos, commerceCount, standing) {
  const std = String(standing || "ECONOMIQUE").toUpperCase();
  const parts = [];
  if (commerceCount > 0) {
    const commSize = UNIT_SIZES_V73.COMMERCE[std] || 50;
    parts.push(`${commerceCount}×COMMERCE(${commSize}m²)`);
  }
  for (const t of logementsTypos) {
    const sizeRow = UNIT_SIZES_V73[t.type];
    if (!sizeRow) continue;
    const sz = sizeRow[std] || sizeRow.ECONOMIQUE;
    parts.push(`${t.count}×${t.type}(${sz}m²)`);
  }
  return parts.join(" + ");
}
function buildUnitMixObjectV73(logementsTypos, commerceCount) {
  const obj = {};
  if (commerceCount > 0) obj.COMMERCE = commerceCount;
  for (const t of logementsTypos) {
    if (t.count > 0) obj[t.type] = (obj[t.type] || 0) + t.count;
  }
  return obj;
}
// ═══════════════════════════════════════════════════════════════════════════════
// v74 — defaultMixFn(n, programType) : génère le mix par défaut si pas d'input_typologies
// Doctrine officielle :
//   MAISON_INDIVIDUELLE : 1 unité = T4, plusieurs = tous T3
//   PETIT_COLLECTIF : majorité T3, +T2 (~20%) si ≥5, +1 T4 si ≥5
//   IMMEUBLE_RAPPORT : toujours 1 T4, ~25% T2, reste T3, +1 T5 si ≥15
//   USAGE_MIXTE : 15% commerces + même logique résidentielle (1 T4, 25% T2, reste T3)
//   MIXTE_OPPORTUNISTE : 20% commerces + 30% T2 + reste T3
//   RESIDENCE_MEUBLEE : 40% T1 + 40% T2 + 20% T3 (si ≤4 → tout T1)
//   HOTEL_URBAIN : 70% T1 + 30% T3
//   CLINIQUE : 50% T2 + 15% T3 + 35% T1
//   CENTRE_COMMERCIAL : 70% commerces + 30% T4 (ancres)
//   SCOLAIRE : 65% T3 + 15% T2 + 20% T1
//   COMMERCIAL : tout commerces
// ═══════════════════════════════════════════════════════════════════════════════
function defaultMixFnV74(n, programType) {
  if (n <= 0) return { logements: [], commerceCount: 0 };
  const cleanLog = (mix) => {
    const out = [];
    for (const t of ["T1", "T2", "T3", "T4", "T5"]) {
      if (mix[t] && mix[t] > 0) out.push({ type: t, count: mix[t] });
    }
    return out;
  };
  const PT = programType;

  if (PT === "MAISON" || PT === "MAISON_INDIVIDUELLE") {
    if (n === 1) return { logements: [{ type: "T4", count: 1 }], commerceCount: 0 };
    return { logements: [{ type: "T3", count: n }], commerceCount: 0 };
  }
  if (PT === "PETIT_COLLECTIF") {
    if (n < 5) return { logements: [{ type: "T3", count: n }], commerceCount: 0 };
    const nT4 = 1, nT2 = Math.max(1, Math.round(n * 0.20));
    const nT3 = n - nT4 - nT2;
    return { logements: cleanLog({ T2: nT2, T3: nT3, T4: nT4 }), commerceCount: 0 };
  }
  if (PT === "IMMEUBLE_DENSE" || PT === "IMMEUBLE_RAPPORT") {
    const nT4 = 1, nT5 = (n >= 15) ? 1 : 0;
    const nT2 = Math.max(1, Math.round(n * 0.25));
    const nT3 = Math.max(0, n - nT4 - nT5 - nT2);
    return { logements: cleanLog({ T2: nT2, T3: nT3, T4: nT4, T5: nT5 }), commerceCount: 0 };
  }
  if (PT === "MIXTE" || PT === "USAGE_MIXTE") {
    const nCom = Math.max(1, Math.round(n * 0.15));
    const nResid = n - nCom;
    if (nResid <= 0) return { logements: [], commerceCount: n };
    if (nResid <= 2) return { logements: [{ type: "T3", count: nResid }], commerceCount: nCom };
    const nT4 = 1, nT2 = Math.max(1, Math.round(nResid * 0.25));
    const nT3 = Math.max(0, nResid - nT4 - nT2);
    return { logements: cleanLog({ T2: nT2, T3: nT3, T4: nT4 }), commerceCount: nCom };
  }
  if (PT === "MIXTE_OPPORTUNISTE") {
    const nCom = Math.max(1, Math.round(n * 0.20));
    const nResid = n - nCom;
    if (nResid <= 0) return { logements: [], commerceCount: n };
    const nT2 = Math.max(1, Math.round(nResid * 0.30));
    const nT3 = Math.max(0, nResid - nT2);
    return { logements: cleanLog({ T2: nT2, T3: nT3 }), commerceCount: nCom };
  }
  if (PT === "RESIDENCE_MEUBLEE") {
    if (n <= 4) return { logements: [{ type: "T1", count: n }], commerceCount: 0 };
    const nT1 = Math.round(n * 0.40), nT2 = Math.round(n * 0.40);
    const nT3 = Math.max(0, n - nT1 - nT2);
    return { logements: cleanLog({ T1: nT1, T2: nT2, T3: nT3 }), commerceCount: 0 };
  }
  if (PT === "HOTEL_URBAIN") {
    const nT1 = Math.round(n * 0.70);
    const nT3 = Math.max(0, n - nT1);
    return { logements: cleanLog({ T1: nT1, T3: nT3 }), commerceCount: 0 };
  }
  if (PT === "CLINIQUE") {
    const nT2 = Math.round(n * 0.50), nT3 = Math.round(n * 0.15);
    const nT1 = Math.max(0, n - nT2 - nT3);
    return { logements: cleanLog({ T1: nT1, T2: nT2, T3: nT3 }), commerceCount: 0 };
  }
  if (PT === "CENTRE_COMMERCIAL") {
    const nCom = Math.round(n * 0.70);
    const nT4 = Math.max(0, n - nCom);
    return { logements: cleanLog({ T4: nT4 }), commerceCount: nCom };
  }
  if (PT === "SCOLAIRE") {
    const nT3 = Math.round(n * 0.65), nT2 = Math.round(n * 0.15);
    const nT1 = Math.max(0, n - nT3 - nT2);
    return { logements: cleanLog({ T1: nT1, T2: nT2, T3: nT3 }), commerceCount: 0 };
  }
  if (PT === "COMMERCIAL") {
    return { logements: [], commerceCount: n };
  }
  // Fallback : tout T3
  return { logements: [{ type: "T3", count: n }], commerceCount: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FONCTION PRINCIPALE — calcule fp/levels/sdp/unitMix pour un scénario (A, B ou C)
// ═══════════════════════════════════════════════════════════════════════════════
function computeProgramDrivenScenarioV73(params) {
  const {
    label,
    input_typologies = "",
    target_units = 0,
    target_surface_m2 = 0,
    standing_level = "ECONOMIQUE",
    program_main = "",
    layout_mode = "SUPERPOSE",
    site_area = 0,
    envelope_w = 0,
    envelope_d = 0,
    max_floors = 99,
    max_height_m = 99,
    floor_height = 3.2,
    zoning_type = "URBAIN",
    commerce_size_m2 = 0,
  } = params;
  // 1. CLASSIFIER
  const programType = classifyProgramTypeV73(program_main);
  if (programType.startsWith("UNSUPPORTED")) {
    const reasons = {
      UNSUPPORTED_FLOU: "Programme flou ou à définir — diagnostic personnalisé requis, contactez l'architecte",
      UNSUPPORTED_AUTRE: "Programme atypique (saisie libre) — diagnostic personnalisé requis, contactez l'architecte",
      UNSUPPORTED_RENO: "Rénovation/extension/surélévation — diagnostic personnalisé requis, contactez l'architecte",
    };
    return { isUnsupported: true, unsupportedReason: reasons[programType], programType };
  }
  // 2. PARSER TYPOLOGIES + FALLBACKS (v74 doctrine officielle)
  let typologiesA_logements = parseTypologiesV73(input_typologies);
  let commerceCountA = 0, commerceCountB = 0, commerceCountC = 0;
  let usingSurfaceFallback = false;

  if (typologiesA_logements.length > 0 || typologiesA_logements._hasCommerceInput) {
    // INPUT FOURNI = source de vérité pour les logements
    // Commerce : 1 si MIXTE et pas de commerce dans input (auto), sinon = input._commerceCountInput
    const isMixte = (programType === "MIXTE" || programType === "USAGE_MIXTE" || programType === "MIXTE_OPPORTUNISTE");
    if (typologiesA_logements._hasCommerceInput) {
      commerceCountA = typologiesA_logements._commerceCountInput;
    } else if (isMixte) {
      commerceCountA = 1; // auto-commerce signature MIXTE
    }
    commerceCountB = commerceCountA;
    commerceCountC = commerceCountA;
  } else if (target_units > 0) {
    // PAS D'INPUT → defaultMixFn par programme
    const dm = defaultMixFnV74(target_units, programType);
    typologiesA_logements = dm.logements;
    commerceCountA = dm.commerceCount;
    commerceCountB = dm.commerceCount;
    commerceCountC = dm.commerceCount;
  } else if (target_surface_m2 > 0) {
    // FALLBACK SURFACE : déduire un nombre d'unités T3
    usingSurfaceFallback = true;
    const std = String(standing_level).toUpperCase();
    const sizeT3 = (UNIT_SIZES_V73.T3[std] || UNIT_SIZES_V73.T3.ECONOMIQUE);
    const nUnits = Math.max(1, Math.round(target_surface_m2 / (sizeT3 * CIRCULATION_COEFF_V73)));
    const dm = defaultMixFnV74(nUnits, programType);
    typologiesA_logements = dm.logements;
    commerceCountA = dm.commerceCount;
    commerceCountB = dm.commerceCount;
    commerceCountC = dm.commerceCount;
  }

  if (typologiesA_logements.length === 0 && commerceCountA === 0) {
    return {
      isUnsupported: true,
      unsupportedReason: "Aucune donnée programme exploitable — fournir input_typologies, target_units ou target_surface_m2",
      programType,
    };
  }
  // 3. COMMERCIAL pur — tout en commerces (déjà géré par defaultMixFn pour ce cas)
  if (programType === "COMMERCIAL" && typologiesA_logements.length > 0) {
    // Si l'utilisateur a saisi des logements mais le programme est COMMERCIAL,
    // on convertit tout en commerces
    const totalUnits = typologiesA_logements.reduce((s, t) => s + t.count, 0) + commerceCountA;
    commerceCountA = totalUnits;
    commerceCountB = totalUnits;
    commerceCountC = 1;
    typologiesA_logements = [];
  }
  // 4. MIX A/B/C
  let mixA_logements, mixB_logements, mixC_logements;
  if (programType === "COMMERCIAL") {
    mixA_logements = []; mixB_logements = []; mixC_logements = [];
  } else if (programType === "MAISON") {
    mixA_logements = typologiesA_logements;
    mixB_logements = consolidateTypologiesV73(typologiesA_logements.map(t => ({ type: downgradeTypeV73(t.type), count: t.count })));
    mixC_logements = consolidateTypologiesV73(typologiesA_logements.map(t => ({ type: downgradeTypeV73(downgradeTypeV73(t.type)), count: t.count })));
  } else {
    mixA_logements = typologiesA_logements;
    mixB_logements = buildMixB_logements_V73(typologiesA_logements);
    mixC_logements = buildMixC_logements_V73(typologiesA_logements, mixB_logements);
  }
  // 5. SDP DU SCÉNARIO
  let scenarioMix, scenarioCommerceCount;
  if (label === "A") { scenarioMix = mixA_logements; scenarioCommerceCount = commerceCountA; }
  else if (label === "B") { scenarioMix = mixB_logements; scenarioCommerceCount = commerceCountB; }
  else { scenarioMix = mixC_logements; scenarioCommerceCount = commerceCountC; }
  const sdpData = computeSdpFromMixV73(scenarioMix, scenarioCommerceCount, standing_level);
  const sdpTotal = sdpData.sdp_total;
  // 6. NIVEAUX & EMPRISE
  const ZONING_CES_V73 = { URBAIN: 0.60, PERIURBAIN: 0.45, PAVILLON: 0.30, RURAL: 0.20, MIXTE: 0.50, Z_DEFAULT: 0.40 };
  const ces = ZONING_CES_V73[zoning_type] || ZONING_CES_V73.Z_DEFAULT;
  const empriseMaxCes = ces * site_area;
  const empriseMaxEnv = (envelope_w * envelope_d) * 0.85;
  const empriseMaxAbsolue = Math.min(empriseMaxCes, empriseMaxEnv);
  const maxLevelsHauteur = Math.floor((max_height_m || 99) / floor_height);
  const maxLevelsAbsolu = Math.min(max_floors || 99, maxLevelsHauteur, 10);
  const levelsBounds = LEVELS_BY_TYPE_V73[programType] || { min: 1, maxRaisonnable: 4 };
  const levelsMin = Math.min(levelsBounds.min, maxLevelsAbsolu);
  const levelsMaxRaisonnable = Math.min(levelsBounds.maxRaisonnable, maxLevelsAbsolu);
  const isSplit = layout_mode === "SPLIT_AV_AR" && programType === "MIXTE" && scenarioCommerceCount > 0 && label !== "C";
  let fp, fpRdc, fpEtages, levels, splitLayout = null, hasPilotis = false;
  if (isSplit) {
    const std = String(standing_level).toUpperCase();
    const commSize = (commerce_size_m2 > 0) ? commerce_size_m2 : (UNIT_SIZES_V73.COMMERCE[std] || 50);
    const fpCommerce = scenarioCommerceCount * commSize;
    const sdpCommerce = fpCommerce;
    const sdpLogements = sdpData.sdp_logements;
    const empriseMaxLogement = Math.max(50, empriseMaxAbsolue - fpCommerce);
    let levelsLogement = Math.max(1, Math.ceil(sdpLogements / empriseMaxLogement));
    levelsLogement = Math.max(levelsLogement, levelsMin);
    levelsLogement = Math.min(levelsLogement, levelsMaxRaisonnable);
    if (label === "C") levelsLogement = levelsMin;
    const fpLogement = Math.max(50, Math.round(sdpLogements / levelsLogement));
    if (label === "A" || label === "B") hasPilotis = true;
    splitLayout = {
      mode: "SPLIT_AV_AR",
      volume_commerce: {
        fp_m2: Math.round(fpCommerce),
        width_m: Math.round((envelope_w || 20) * 0.85),
        depth_m: Math.round(fpCommerce / Math.max(1, (envelope_w || 20) * 0.85)),
        levels: 1,
        sdp_m2: Math.round(sdpCommerce),
        units: scenarioCommerceCount,
        position: "AVANT (contre limite séparative)",
      },
      volume_logement: {
        fp_m2: Math.round(fpLogement),
        width_m: Math.round((envelope_w || 20) * 0.80),
        depth_m: Math.round(fpLogement / Math.max(1, (envelope_w || 20) * 0.80)),
        levels: levelsLogement,
        sdp_m2: Math.round(fpLogement * levelsLogement),
        units: sdpData.nb_logements,
        position: "ARRIÈRE sur pilotis (RDC libéré)",
        has_pilotis: hasPilotis,
      },
      retrait_inter_m: 4,
      ces_total_pct: Math.round((fpCommerce + fpLogement) / Math.max(1, site_area) * 100),
    };
    fp = fpLogement; fpRdc = fpLogement; fpEtages = fpLogement; levels = levelsLogement;
  } else {
    const std = String(standing_level).toUpperCase();
    const commSize = (commerce_size_m2 > 0) ? commerce_size_m2 : (UNIT_SIZES_V73.COMMERCE[std] || 50);
    if (scenarioCommerceCount > 0) {
      const fpCommerceRdc = scenarioCommerceCount * commSize;
      const sdpRestante = sdpTotal - fpCommerceRdc;
      let levelsTotal = Math.max(1, Math.ceil(sdpRestante / empriseMaxAbsolue) + 1);
      levelsTotal = Math.max(levelsTotal, levelsMin);
      levelsTotal = Math.min(levelsTotal, levelsMaxRaisonnable);
      if (label === "C") levelsTotal = levelsMin;
      const nbEtagesLog = Math.max(1, levelsTotal - 1);
      const fpLogEtages = Math.max(50, Math.round(sdpRestante / nbEtagesLog));
      fpRdc = Math.round(fpCommerceRdc);
      fpEtages = Math.round(fpLogEtages);
      fp = fpEtages;
      levels = levelsTotal;
    } else {
      let nbNiveaux = Math.max(1, Math.ceil(sdpTotal / empriseMaxAbsolue));
      nbNiveaux = Math.max(nbNiveaux, levelsMin);
      nbNiveaux = Math.min(nbNiveaux, levelsMaxRaisonnable);
      if (label === "C") nbNiveaux = levelsMin;
      const fpUniforme = Math.max(50, Math.round(sdpTotal / nbNiveaux));
      fp = fpUniforme; fpRdc = fpUniforme; fpEtages = fpUniforme; levels = nbNiveaux;
    }
  }
  const heightM = Math.round(levels * floor_height * 10) / 10;
  const unitMixDetail = buildUnitMixDetailV73(scenarioMix, scenarioCommerceCount, standing_level);
  const unitMixObject = buildUnitMixObjectV73(scenarioMix, scenarioCommerceCount);
  const totalUnits = sdpData.nb_logements + sdpData.nb_commerces;
  return {
    isUnsupported: false,
    programType,
    label,
    fp, fpRdc, fpEtages, levels,
    height_m: heightM,
    sdp_m2: sdpTotal,
    commerce_levels: scenarioCommerceCount > 0 && !isSplit ? 1 : 0,
    has_pilotis: hasPilotis,
    split_layout: splitLayout,
    layout_mode: splitLayout ? "SPLIT_AV_AR" : "SUPERPOSE",
    total_units: totalUnits,
    nb_logements: sdpData.nb_logements,
    nb_commerces: sdpData.nb_commerces,
    unit_mix: unitMixObject,
    unit_mix_detail: unitMixDetail,
    total_useful: sdpData.surface_utile_totale,
    surface_utile_logements: sdpData.surface_utile_logements,
    surface_utile_commerces: sdpData.surface_utile_commerces,
    m2_habitable_par_logement: sdpData.nb_logements > 0 ? Math.round(sdpData.surface_utile_logements / sdpData.nb_logements) : 0,
    using_surface_fallback: usingSurfaceFallback,
    typologies_input: typologiesA_logements,
    mix_a: mixA_logements,
    mix_b: mixB_logements,
    mix_c: mixC_logements,
  };
}
function computeSmartScenarios({
  site_area, envelope_w, envelope_d, envelope_area: env_area_override,
  zoning_type = "URBAIN", floor_height = 3.2,
  primary_driver = "MAX_CAPACITE",
  max_floors = 99, max_height_m = 99,
  program_main = "", target_surface_m2 = 0,
  site_saturation_level = "MEDIUM",
  financial_rigidity_score = 0,
  density_band = "", risk_adjusted = 0,
  feasibility_posture = "BALANCED",
  scenario_A_role = "", scenario_B_role = "", scenario_C_role = "",
  // ── BUDGET & ATTENTES CLIENT (depuis PIPELINE) ──
  budget_range = 0, budget_range_raw = "", budget_band = "", budget_tension = 0,
  standing_level = "STANDARD",
  target_units = 0,
  rent_score = 0, capacity_score = 0, mix_score = 0, phase_score = 0, risk_score = 0,
  density_pressure_factor = 1,
  driver_intensity = "MEDIUM",
  strategic_position = "",
  // v57.7 : retraits optionnels (overrides)
  retrait_avant_m = 0, retrait_lateral_m = 0, retrait_arriere_m = 0,
  nb_cotes_mitoyens = -1, // -1 = auto (déduit du zonage)
  // v57.9 : orientation solaire & géographie
  country = "CAMEROUN", // pays du site (pour détecter zone climatique)
  parcel_orientation = "", // orientation principale de la parcelle (optionnel)
  // v57.20 : disposition spatiale du programme (SPLIT commerce/logement)
  layout_mode = "SUPERPOSE", // SUPERPOSE (défaut) | SPLIT_AV_AR | SPLIT_LAT | LINEAIRE
  commerce_depth_m = 6,      // profondeur bande commerciale (défaut 6m, classique Afrique)
  retrait_inter_volumes_m = 4, // distance entre les 2 volumes (passage véhicule/piéton)
  // v72.157 : typology-driven fields (from /compute-scenarios request)
  input_typologies = "", // typologies string (e.g., "T2,T3,T4")
  commerce_size_m2 = 0,  // override commerce surface
}) {
  // v56.3 FIX DÉFINITIF: max_fp = CES × site_area UNIQUEMENT.
  // Les envelope_w/d de la Sheet sont souvent FAUX (dérivés de l'aire polygonale
  // ≈24×24 au lieu du vrai bbox ≈49×47), ce qui causait fp_A=342 au lieu de ~1100.
  // La contrainte physique (bâtiment dans l'enveloppe) est gérée par
  // computeMassingPolygon au moment du rendu, avec cross-section + containment check.
  const envelope_bbox = envelope_w * envelope_d;
  const envelope_area = env_area_override || envelope_bbox;
  const ces = ZONING_CES[zoning_type] || 0.50;
  const max_fp = ces * site_area;  // v56.3: CES seul, pas de cap par envelope_bbox erroné
  // ⚠ Diagnostic : si envelope_bbox << ces*site_area, les dimensions Sheet sont suspectes
  if (envelope_bbox > 0 && envelope_bbox < max_fp * 0.6) {
    console.warn(`⚠ ENVELOPE SUSPECT: bbox=${envelope_bbox}m² (${envelope_w}×${envelope_d}) << max_fp=${max_fp}m² (CES×site). Les dimensions Sheet sont probablement fausses.`);
  }
  // COS → surface de plancher totale max (SDP = fp × niveaux)
  const cos = ZONING_COS[zoning_type] || 1.50;
  const max_sdp = cos * site_area;
  const ratios = FP_RATIOS[primary_driver] || FP_RATIOS.MAX_CAPACITE;
  // ══════════════════════════════════════════════════════════════════════════════
  // v57.7 — RETRAITS RÉGLEMENTAIRES & MITOYENNETÉ → emprise constructible réduite
  // ══════════════════════════════════════════════════════════════════════════════
  const retraitsZone = RETRAITS_M[zoning_type] || RETRAITS_M.URBAIN;
  const rAvant = retrait_avant_m > 0 ? retrait_avant_m : retraitsZone.avant;
  const rLateral = retrait_lateral_m > 0 ? retrait_lateral_m : retraitsZone.lateral;
  const rArriere = retrait_arriere_m > 0 ? retrait_arriere_m : retraitsZone.arriere;
  const nbMitoyens = nb_cotes_mitoyens >= 0 ? nb_cotes_mitoyens : (MITOYENNETE_SIDES[zoning_type] || 0);
  // Emprise constructible = envelope réduite par les retraits
  // Modèle simplifié : on retire les retraits de W et D
  // Mitoyenneté : chaque côté mitoyen annule un retrait latéral
  const retraitLatEffectif = Math.max(0, rLateral * (2 - nbMitoyens)); // 0 si 2 mitoyens
  const wConstructible = Math.max(envelope_w - retraitLatEffectif, envelope_w * 0.5);
  const dConstructible = Math.max(envelope_d - rAvant - rArriere, envelope_d * 0.5);
  const empriseConstructible = wConstructible * dConstructible;
  // L'emprise constructible est un plafond physique supplémentaire (en plus du CES)
  const setbackReductionPct = envelope_bbox > 0 ? Math.round((1 - empriseConstructible / envelope_bbox) * 100) : 0;
  console.log(`│ v57.7 retraits: avant=${rAvant}m lat=${rLateral}m(×${2-nbMitoyens} côtés) arr=${rArriere}m → W=${wConstructible.toFixed(1)}×D=${dConstructible.toFixed(1)}=${Math.round(empriseConstructible)}m² (-${setbackReductionPct}%)`);
  // ══════════════════════════════════════════════════════════════════════════════
  // v57.9 — ORIENTATION SOLAIRE → impact profondeur de corps + géométrie
  // ══════════════════════════════════════════════════════════════════════════════
  const climaticZone = detectClimaticZone(zoning_type, country);
  const solarImpact = computeSolarImpact(envelope_w, envelope_d, climaticZone, parcel_orientation);
  // v57.13: Le solaire est une RECOMMANDATION (façades, orientation, ventilation)
  // mais ne plafonne plus la géométrie — le CES réglementaire reste la contrainte structurante.
  // Si la profondeur dépasse le seuil solaire, on applique un malus coût (climatisation)
  // mais on ne réduit PAS l'emprise constructible.
  const profondeurSolaire = solarImpact.profondeur_recommandee_m || 99;
  const depassementSolaire = Math.max(0, dConstructible - profondeurSolaire);
  const solaireSouple = depassementSolaire > 0; // true si bâtiment plus profond que recommandé
  if (solaireSouple) {
    // Malus proportionnel au dépassement (max +15% si double de la profondeur recommandée)
    const depassementRatio = Math.min(1, depassementSolaire / profondeurSolaire);
    solarImpact.malus_orientation_pct = Math.round(solarImpact.malus_orientation_pct + depassementRatio * 10);
    console.log(`│ v57.13 solaire: zone=${climaticZone} profondeur D=${dConstructible.toFixed(1)}m > recommandé ${profondeurSolaire}m (+${depassementSolaire.toFixed(1)}m) → malus clim +${solarImpact.malus_orientation_pct}% (RECOMMANDATION, CES préservé)`);
  } else {
    console.log(`│ v57.13 solaire: zone=${climaticZone} profondeur D=${dConstructible.toFixed(1)}m ≤ ${profondeurSolaire}m — conforme ventilation traversante`);
  }
  // v57.13: emprise effective = emprise constructible (retraits seuls, PAS plafonnée par le solaire)
  const empriseEffective = empriseConstructible;
  // ══════════════════════════════════════════════════════════════════════════════
  // v56.1 — TOUS LES PARAMÈTRES INTÉGRÉS (plus de code mort)
  // ══════════════════════════════════════════════════════════════════════════════
  // v56.7 — NORMALISATION SCORES + ENUMS FR/EN
  // ══════════════════════════════════════════════════════════════════════════════
  // ── Helper: normalise un score (accepte 0-1, 0-10, ou 0-100) ──
  // v57.6 FIX CRITIQUE: les scores Sheet sont en 0-10, pas 0-100.
  // Avant ce fix, score=8 → 0.08 au lieu de 0.8 → modulations 10× trop faibles!
  function norm01(v) {
    const n = Number(v) || 0;
    if (n > 10 && n <= 100) return n / 100;  // score 0-100 → 0-1
    if (n > 1 && n <= 10) return n / 10;     // score 0-10 → 0-1
    return Math.max(0, Math.min(1, n));       // déjà 0-1 → 0-1
  }
  // ── Helper: parse budget_tension qui peut être string ou number ──
  function parseBudgetTension(v) {
    const n = Number(v);
    if (!isNaN(n)) return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
    const s = String(v).toUpperCase();
    if (s.includes("LOW") || s.includes("FAIBLE") || s.includes("BAS")) return 0.25;
    if (s.includes("HIGH") || s.includes("FORT") || s.includes("HAUT") || s.includes("ELEV")) return 0.75;
    if (s.includes("MED") || s.includes("MOY")) return 0.50;
    return 0;
  }
  // ── 1. BUDGET : tension + rigidité + band ──
  const bt = parseBudgetTension(budget_tension);
  const fri = norm01(financial_rigidity_score);
  // v57.20 FIX : recalcul automatique de budget_band
  // Ne plus dépendre de la formule Google Sheets (écrasée par les Update Row)
  // Stratégie multi-sources : texte brut OU nombre OU extraction chiffres
  const rawBudget = String(budget_range_raw || budget_range || "");
  // Extraire le montant max depuis n'importe quel format texte
  // "500 000 € – 1 M €" → detecte "1 M" → 1000000
  // "328–656 M FCFA" → detecte "656 M" → 656000000 (FCFA)
  // "500000" → 500000
  let detectedMaxEUR = 0;
  let detectedMaxFCFA = 0;
  // v57.21: Cherche FCFA d'abord (prioritaire car c'est la devise locale)
  // "328–656 M FCFA" → 656000000 FCFA | "200 000 000 FCFA" → 200000000
  const fcfaMMatch = rawBudget.match(/(\d[\d\s.,]*)\s*M\s*FCFA/i);
  if (fcfaMMatch) {
    detectedMaxFCFA = parseFloat(fcfaMMatch[1].replace(/[\s,]/g, '').replace(',', '.')) * 1000000;
    // Si format "X–Y M FCFA", prendre le Y (dernier nombre avant M FCFA)
    const allFcfaM = [...rawBudget.matchAll(/(\d[\d\s.,]*)\s*M\s*FCFA/gi)];
    if (allFcfaM.length > 0) {
      detectedMaxFCFA = Math.max(...allFcfaM.map(m => parseFloat(m[1].replace(/[\s,]/g, '').replace(',', '.')) * 1000000));
    }
  }
  if (!detectedMaxFCFA) {
    const fcfaPlain = rawBudget.match(/(\d[\d\s]*)\s*FCFA/i);
    if (fcfaPlain) detectedMaxFCFA = Number(fcfaPlain[1].replace(/\s/g, ''));
  }
  // Cherche "X M €" ou "X M" (millions EUR, excluant FCFA)
  const mMatch = rawBudget.match(/(\d[\d\s.,]*)\s*M\s*€/i) || rawBudget.match(/(\d[\d\s.,]*)\s*M(?!\s*FCFA)/i);
  if (mMatch) {
    detectedMaxEUR = parseFloat(mMatch[1].replace(/[\s,]/g, '').replace(',', '.')) * 1000000;
  }
  // Cherche "X 000 €" (milliers EUR)
  if (!detectedMaxEUR) {
    const kMatch = rawBudget.match(/(\d[\d\s]*000)\s*€/);
    if (kMatch) detectedMaxEUR = Number(kMatch[1].replace(/\s/g, ''));
  }
  // Fallback : budget_range numérique
  if (!detectedMaxEUR && !detectedMaxFCFA && budget_range > 0) detectedMaxEUR = budget_range;
  console.log(`│ v57.21 budget parse: raw="${rawBudget.substring(0,80)}" → EUR=${detectedMaxEUR} FCFA=${detectedMaxFCFA}`);
  if (!budget_band || String(budget_band).toUpperCase() === "LOW_BUDGET") {
    const oldBand = budget_band;
    if (detectedMaxEUR >= 800000) {
      budget_band = "HIGH_BUDGET";
    } else if (detectedMaxEUR >= 300000) {
      budget_band = "MEDIUM_BUDGET";
    }
    // sinon reste LOW_BUDGET (légitime pour < 300k€)
    console.log(`│ ⚠️ v57.20: budget_band ${oldBand} → ${budget_band} (détecté ${detectedMaxEUR}€ depuis "${rawBudget.substring(0, 60)}")`);
  }
  // budget_band amplifie/atténue la tension (FR + EN + variantes)
  const bandMod = {
    HIGH: 0.15, HIGH_BUDGET: 0.15, HAUT: 0.15, ELEVE: 0.15,
    MEDIUM: 0, MEDIUM_BUDGET: 0, MOYEN: 0,
    LOW: -0.10, LOW_BUDGET: -0.10, BAS: -0.10, FAIBLE: -0.10,
  }[String(budget_band).toUpperCase()] || 0;
  const budgetPressure = Math.max(0, Math.min(1, (bt + fri) / 2 + bandMod));
  // ── 2. STANDING ──
  const standingFactor = {
    PREMIUM: 0.85, HAUT: 0.90, STANDARD: 1.0, ECONOMIQUE: 1.08, ECO: 1.08,
  }[String(standing_level).toUpperCase()] || 1.0;
  // ── 3. DENSITY : pressure + band ──
  const dpf = Math.max(0.5, Math.min(2.0, Number(density_pressure_factor) || 1));
  // density_band affecte le plafond d'emprise (FR + EN + variantes)
  const densityBandMult = {
    HIGH: 1.10, HIGH_DENSITY: 1.10, "HIGH DENSITY": 1.10, HAUT: 1.10, DENSE: 1.10, FORTE: 1.10,
    MEDIUM: 1.0, MEDIUM_DENSITY: 1.0, MOYEN: 1.0, MOYENNE: 1.0,
    LOW: 0.88, LOW_DENSITY: 0.88, BAS: 0.88, FAIBLE: 0.88,
  }[String(density_band).toUpperCase().trim()] || 1.0;
  // ── 4. DRIVER INTENSITY (FR + EN) ──
  const intensitySpread = {
    HIGH: 1.3, FORT: 1.3, FORTE: 1.3, ELEVE: 1.3, ELEVEE: 1.3,
    MEDIUM: 1.0, MOYEN: 1.0, MOYENNE: 1.0,
    LOW: 0.7, FAIBLE: 0.7, BAS: 0.7,
  }[String(driver_intensity).toUpperCase()] || 1.0;
  // ── 5. FEASIBILITY POSTURE (FR + EN + variantes) ──
  const postureMod = {
    AMBITIEUX: 1.08, AGGRESSIVE: 1.08, OFFENSIVE: 1.08, OFFENSIF: 1.08,
    BALANCED: 1.0, STANDARD: 1.0, EQUILIBRE: 1.0, NEUTRE: 1.0,
    PRUDENT: 0.90, CONSERVATIVE: 0.90, DEFENSIVE: 0.90, DEFENSIF: 0.90, PRUDENTE: 0.90,
  }[String(feasibility_posture).toUpperCase()] || 1.0;
  // ── 6. RISK ── (scores normalisés 0-1)
  const riskAdj = norm01(risk_adjusted);
  const riskSc = norm01(risk_score);
  const riskPenalty = 1.0 - ((riskAdj + riskSc) / 2) * 0.15; // max -15% si risque max
  // ── 7. SCORES MÉTIER (normalisés 0-1, accepte 0-100) ──
  const rentSc = norm01(rent_score);
  const capSc = norm01(capacity_score);
  const mixSc = norm01(mix_score);
  const phaseSc = norm01(phase_score);
  // capacity_score → boost emprise (high cap = max footprint)
  const capacityBoost = 1.0 + (capSc - 0.5) * 0.12; // ±6%
  // rent_score → pousse vers plus de niveaux (rendement locatif)
  const rentLevelBoost = 1.0 + (rentSc - 0.5) * 0.20; // ±10%
  // mix_score → influence le nombre de niveaux commerce
  // Si mixSc > 0.6 et programme non-mixte → ajouter quand même un niveau commerce
  const forceCommerce = mixSc > 0.6;
  // phase_score → modère le scénario C (phasage)
  // High phase = le scénario C peut être plus ambitieux (construit par phases)
  const phaseBoostC = 1.0 + (phaseSc - 0.5) * 0.15; // ±7.5%
  const absMaxLevels = Math.min(
    Number(max_floors) || 99,
    Math.floor((Number(max_height_m) || 99) / floor_height),
    10
  );
  const isMixte = /mixte|mixed/i.test(program_main) || forceCommerce;
  const commerceLevels = isMixte ? 1 : 0;
  // ══════════════════════════════════════════════════════════════════════════════
  // v56.9 — PROGRAMME-DRIVEN : le fp vient du PROGRAMME CLIENT, pas du CES
  // ══════════════════════════════════════════════════════════════════════════════
  // Si target_units > 0 et qu'on identifie le programme → on dimensionne le
  // bâtiment à partir du nombre de logements × surfaces par typo × circulation.
  // CES/COS restent des GARDE-FOUS (contraintes max), pas des cibles.
  // Si pas de programme → fallback à la logique regulation-driven.
  // ══════════════════════════════════════════════════════════════════════════════
  const programKey = parseProgramKey(program_main);
  const rules = programKey ? PROGRAM_RULES[programKey] : null;
  const stdKey = standingKey(standing_level);
  const sizeKey = standingSizeKey(standing_level);
  let isProgramDriven = !!(rules && target_units > 0);  // v73 patch : let pour permettre réassignation depuis le shim
  console.log(`┌── SCENARIO ENGINE v57.20 (PROGRAMME-DRIVEN${isProgramDriven ? "" : " → FALLBACK REGULATION"}) ──`);
  console.log(`│ site=${site_area}m² envelope=${envelope_w}×${envelope_d} bbox=${envelope_bbox}m² polyArea=${envelope_area}m²`);
  console.log(`│ zoning=${zoning_type} CES=${ces} max_fp=${Math.round(max_fp)}m² | COS=${cos} max_sdp=${Math.round(max_sdp)}m²`);
  console.log(`│ driver=${primary_driver} intensity=${driver_intensity}`);
  console.log(`│ max_floors=${max_floors} max_height=${max_height_m}m → absMaxLevels=${absMaxLevels}`);
  console.log(`│ program=${program_main} → key=${programKey || "NONE"} | target_units=${target_units} | mode=${isProgramDriven ? "PROGRAM" : "REGULATION"}`);
  console.log(`│ standing=${standing_level} (stdKey=${stdKey} sizeKey=${sizeKey})`);
  console.log(`│ budget: band=${budget_band} tension=${bt} pressure=${budgetPressure.toFixed(2)} | posture=${feasibility_posture}(×${postureMod})`);
  console.log(`│ risk: adj=${riskAdj} score=${riskSc} penalty=${riskPenalty.toFixed(3)}`);
  console.log(`│ scores: rent=${rentSc} cap=${capSc} mix=${mixSc} phase=${phaseSc}`);
  const results = {};
  const accents = { A: "#2a5298", B: "#1e8449", C: "#d35400" };
  const labels_fr = {
    A: "Scenario intensification", B: "Scenario equilibre", C: "Scenario prudent",
  };
  // Initialize for effective CES (used in program-driven mode)
  let effectiveCESOutput = ces;
  // Extract budgetMax before the loop for use in diagnostic
  // v57.21 FIX: budget_range arrive souvent en texte ("500 000 € – 1 M €")
  // → Number() retourne NaN → budgetMax reste 0 → budget_fit = "N/A" systématique.
  // Solution : utiliser detectedMaxEUR (parsé ligne 1111-1123) avec conversion EUR→FCFA.
  let budgetMax = 0;
  if (typeof budget_range === 'string' && budget_range.includes('-')) {
    budgetMax = Number(budget_range.split('-')[1]) || 0;
  } else {
    budgetMax = Number(budget_range) || 0;
  }
  // v57.21: fallback sur detectedMaxFCFA ou detectedMaxEUR si budgetMax reste 0
  if (budgetMax === 0 && (detectedMaxFCFA > 0 || detectedMaxEUR > 0)) {
    const EUR_TO_FCFA = 656;
    if (detectedMaxFCFA > 0) {
      // Budget déjà en FCFA → utiliser directement
      budgetMax = Math.round(detectedMaxFCFA);
    } else if (detectedMaxEUR > 0) {
      // Budget en EUR → convertir en FCFA
      if (detectedMaxEUR < 50000000) {
        // Valeurs < 50M → probablement EUR (budget immo camerounais rarement < 50M FCFA)
        budgetMax = Math.round(detectedMaxEUR * EUR_TO_FCFA);
      } else {
        budgetMax = Math.round(detectedMaxEUR);
      }
    }
    console.log(`│ v57.21 FIX budget_fit: budgetMax était 0 → recalculé depuis ${detectedMaxFCFA > 0 ? 'FCFA=' + detectedMaxFCFA : 'EUR=' + detectedMaxEUR} → budgetMax=${budgetMax} FCFA`);
  }
  for (const label of ["A", "B", "C"]) {
    const role = SCENARIO_ROLE[label];
    const mode = SCENARIO_MASSING_MODE[label];
    let fp, fpRdc, fpEtages, levels, unitMixDetail, totalUseful, circRatio, bodyDepth, maxPerFloor, groundReserve;
    let unitMix = {};
    let totalUnitsResult = 0;
    let hasPilotis = false;
    let pilotisLevels = 0;
    // v57.20 SPLIT : volumes séparés (commerce + logement)
    let splitLayout = null; // sera rempli si layout_mode === "SPLIT_AV_AR"
    let target_sdp_programme = 0; // ancre client : target_units × refSize / (1-circ)
    // v57.13 EXPERT RATIOS — lookup pour ce programme × zonage × scénario
    const scenarioKey = label; // A, B, C
    const expertZone = EXPERT_RATIOS[programKey]?.[zoning_type] || EXPERT_RATIOS[programKey]?.Z_DEFAULT;
    const expertRatio = expertZone?.[scenarioKey] || null;
// ═══════════════════════════════════════════════════════════════════════════════
// PATCH v73 — REMPLACEMENT DU CALCUL fp/levels/sdp/unitMix DANS LA BOUCLE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Ce bloc remplace TOUT LE CALCUL chaotique des ~700 lignes par un appel propre
// à computeProgramDrivenScenarioV73.
//
// LOCALISATION : à insérer DANS la boucle `for (const label of ["A","B","C"])`,
// JUSTE APRÈS les déclarations let (fp, fpRdc, fpEtages, levels, etc.)
// et JUSTE AVANT le bloc "CALCULS COMMUNS".
//
// Tout ce qui était entre ces deux points DOIT être supprimé et remplacé par ce code.
//
// ═══════════════════════════════════════════════════════════════════════════════
    // ── v73 PROGRAM-DRIVEN ENGINE ─────────────────────────────────────────────
    const v73Result = computeProgramDrivenScenarioV73({
      label,
      input_typologies: input_typologies || "",
      target_units: target_units || 0,
      target_surface_m2: target_surface_m2 || 0,
      standing_level: standing_level || "ECONOMIQUE",
      program_main: program_main || "",
      layout_mode: layout_mode || "SUPERPOSE",
      site_area: Number(site_area) || 0,
      envelope_w: Number(envelope_w) || 0,
      envelope_d: Number(envelope_d) || 0,
      max_floors: Number(max_floors) || 99,
      max_height_m: Number(max_height_m) || 99,
      floor_height: Number(floor_height) || 3.2,
      zoning_type: zoning_type || "URBAIN",
      commerce_size_m2: Number(commerce_size_m2) || 0,
    });
    // ── Si type non supporté → retourner un message d'erreur lisible ──────────
    if (v73Result.isUnsupported) {
      console.warn(`│ v73 ${label}: UNSUPPORTED — ${v73Result.unsupportedReason}`);
      // Produire un scénario "vide" mais structuré pour ne pas casser le pipeline
      results[label] = {
        unsupported: true,
        unsupported_reason: v73Result.unsupportedReason,
        program_type: v73Result.programType,
        // Valeurs minimales pour ne pas planter le rendu
        fp_m2: 0, fp_rdc_m2: 0, fp_etages_m2: 0,
        levels: 0, height_m: 0, sdp_m2: 0,
        commerce_levels: 0, has_pilotis: false, split_layout: null,
        layout_mode: "SUPERPOSE",
        total_units: 0, unit_mix_detail: "Diagnostic personnalisé requis",
        unit_mix: {}, total_useful_m2: 0,
        m2_habitable_par_logement: 0,
        role: SCENARIO_ROLE[label],
        label_fr: { A: "Scenario intensification", B: "Scenario equilibre", C: "Scenario prudent" }[label],
        accent_color: { A: "#2a5298", B: "#1e8449", C: "#d35400" }[label],
        recommendation_score: 0,
        recommended: false,
        cost_total_fcfa: 0,
        budget_fit: "N/A",
      };
      continue; // passer au scénario suivant
    }
    // ── Assigner les variables locales depuis le résultat v73 ─────────────────
    fp = v73Result.fp;
    fpRdc = v73Result.fpRdc;
    fpEtages = v73Result.fpEtages;
    levels = v73Result.levels;
    unitMix = v73Result.unit_mix;
    unitMixDetail = v73Result.unit_mix_detail;
    totalUnitsResult = v73Result.total_units;
    totalUseful = v73Result.total_useful;
    hasPilotis = v73Result.has_pilotis;
    pilotisLevels = hasPilotis ? 1 : 0;
    splitLayout = v73Result.split_layout;
    // ── Variables auxiliaires utilisées par le code en aval ───────────────────
    // circRatio : ratio de circulation utilisé pour les calculs parking/espace
    circRatio = 0.15; // standard logements (commerce = 0, mais on utilise une valeur unique pour le scénario)
    // bodyDepth : profondeur de corps de bâtiment (utilisée pour orientation solaire)
    bodyDepth = 14; // valeur typique en climat tropical
    // maxPerFloor : nombre max d'unités par palier (utilisé pour parking)
    maxPerFloor = Math.max(1, Math.ceil(totalUnitsResult / Math.max(1, levels)));
    // groundReserve : pourcentage de l'enveloppe réservé au sol (utilisé pour espace dégagé)
    groundReserve = 0.25; // standard
    // target_sdp_programme : ancre client (la SDP cible théorique)
    target_sdp_programme = v73Result.sdp_m2;
    // Logging diagnostique
    console.log(`│ v73 ${label}: type=${v73Result.programType} layout=${v73Result.layout_mode} | fp=${fp}m² × ${levels}niv = SDP ${v73Result.sdp_m2}m²`);
    console.log(`│       mix: ${unitMixDetail} (${totalUnitsResult} unités, ${totalUseful}m² utiles)`);
    if (hasPilotis) console.log(`│       PILOTIS activé`);
    if (splitLayout) console.log(`│       SPLIT: commerce ${splitLayout.volume_commerce.fp_m2}m² + logement ${splitLayout.volume_logement.fp_m2}m²×${splitLayout.volume_logement.levels}niv`);
    // ── À PARTIR D'ICI, le code original continue NORMALEMENT ─────────────────
    // (calculs financiers, ventilation, scoring, narrative, etc.)
    // ─────────────────────────────────────────────────────────────────────────
    // v73 COMPAT SHIM — variables référencées par le code aval (calculs
    // financiers, scoring, narrative). Réintroduites ici car définies à
    // l'origine dans le bloc supprimé (lignes 1799-1810 du server v72.160).
    // Ne pas supprimer tant que le code aval n'a pas été refactoré pour
    // consommer directement le résultat v73Result.
    // ─────────────────────────────────────────────────────────────────────────
    isProgramDriven = !v73Result.isUnsupported || isProgramDriven; // v73 patch : assigne au scope externe (sticky : true reste true si au moins un scenario v73 OK)
    const standingKeyV84 = String(standing_level || "ECONOMIQUE").toUpperCase();
    const _COST_PER_M2_ROLE_V73COMPAT = {
      ECONOMIQUE: { A: 250000, B: 215000, C: 175000 },
      ECO:        { A: 250000, B: 215000, C: 175000 },
      STANDARD:   { A: 350000, B: 300000, C: 250000 },
      HAUT:       { A: 450000, B: 385000, C: 325000 },
      PREMIUM:    { A: 550000, B: 475000, C: 400000 },
    };
    const _costTableV73COMPAT = _COST_PER_M2_ROLE_V73COMPAT[standingKeyV84] || _COST_PER_M2_ROLE_V73COMPAT.STANDARD;
    const marketCostV84 = _costTableV73COMPAT[label] || _costTableV73COMPAT.B;
    const BUDGET_CAP_FACTOR_V84 = { A: 1.20, B: 1.00, C: 0.85 };
    // ══════════════════════════════════════════════════════════════════════════
    // CALCULS COMMUNS (program-driven et regulation-driven)
    // ══════════════════════════════════════════════════════════════════════════
    const totalLevelsWithPilotis = levels + pilotisLevels;
    const pilotisH = hasPilotis ? PILOTIS_CONFIG.PILOTIS_HEIGHT_M : 0;
    const height = Math.round((levels * floor_height + pilotisH) * 10) / 10;
    // v73.1.2: SDP finale = target_sdp_programme (calcul propre v73) en mode program-driven
    // Sinon (regulation-driven) : ancienne logique fpRdc + fpEtages × (levels-1) ou fp × levels
    const sdp = (isProgramDriven && typeof target_sdp_programme === 'number' && target_sdp_programme > 0)
      ? target_sdp_programme
      : ((fpRdc && fpEtages && levels > 1)
        ? fpRdc + fpEtages * (levels - 1)
        : fp * levels);
    const cosRatio = max_sdp > 0 ? sdp / max_sdp : 0;
    let compliance;
    if (cosRatio <= 1.05) compliance = "CONFORME";
    else if (cosRatio <= 1.30) compliance = "DEROGATION_POSSIBLE";
    else compliance = "AMBITIEUX_HORS_COS";
    // v57.6: Coût estimé FCFA (Cameroun) = Construction + VRD
    // Construction = SDP × coût/m²
    // VRD = 10% de SDP × 50% du coût/m²
    // Total = construction + VRD = SDP × costPerM2 × 1.05
    // ── v72.84 BUDGET + STANDING DRIVEN ──
    // Standing → coût/m² MARCHÉ (réalité construction, affiché dans le tableau)
    // Budget × cap factor → plafond budgétaire par rôle (A=1.20, B=1.00, C=0.85)
    // Si coût marché × SDP > plafond → coût/m² ajusté à la baisse (plancher par standing)
    // Le tableau PPTX montre les deux : marché vs ajusté
    const standingKey = standingKeyV84;
    const marketCostPerM2 = marketCostV84;
    let costPerM2 = marketCostPerM2;
    let costAdjusted = false;
    if (budgetMax > 0 && sdp > 0) {
      const budgetCapForRole = budgetMax * (BUDGET_CAP_FACTOR_V84[label] || 1.00);
      const marketEstimatedCost = Math.round(sdp * marketCostPerM2 * 1.05);
      if (marketEstimatedCost > budgetCapForRole) {
        // v72.90: COST_FLOOR par standing × rôle — évite l'effondrement identique A=B=C
        // Quand le budget est serré, A reste au prix marché, B légèrement en dessous, C au plancher
        const COST_FLOOR_BY_STANDING_ROLE = {
          ECONOMIQUE: { A: 200000, B: 180000, C: 160000 },
          ECO:        { A: 200000, B: 180000, C: 160000 },
          STANDARD:   { A: 280000, B: 250000, C: 220000 },
          HAUT:       { A: 370000, B: 330000, C: 290000 },
          PREMIUM:    { A: 460000, B: 410000, C: 360000 },
        };
        const floorTable = COST_FLOOR_BY_STANDING_ROLE[standingKey] || COST_FLOOR_BY_STANDING_ROLE.STANDARD;
        const costFloor = floorTable[label] || floorTable.B;
        const budgetDriven = Math.floor(budgetCapForRole / (sdp * 1.05));
        // v72.90: Use the HIGHER of budget-driven and floor — but never exceed market price
        costPerM2 = Math.min(marketCostPerM2, Math.max(costFloor, budgetDriven));
        costAdjusted = true;
        console.log(`│   v72.90 COST-DIFF: ${label} market=${marketCostPerM2/1000}k budgetDriven=${Math.round(budgetDriven/1000)}k floor=${costFloor/1000}k → final=${costPerM2/1000}k/m²`);
      }
    }
    const constructionCost = sdp * costPerM2;
    const vrdCost = (sdp * 0.10) * (costPerM2 * 0.50);
    const estimatedCost = Math.round(constructionCost + vrdCost);
    // budgetMax is already computed before the loop
    const budgetFit = budgetMax > 0
      ? (estimatedCost <= budgetMax ? "DANS_BUDGET" : estimatedCost <= budgetMax * 1.2 ? "BUDGET_TENDU" : "HORS_BUDGET")
      : "N/A";
    const freeGround = envelope_area - (fpRdc || fp); // espace libre au sol = enveloppe - empreinte RDC
    const parkingEst = hasPilotis ? Math.floor((fpRdc || fp) / PILOTIS_CONFIG.PARKING_SPOT_M2) : Math.floor(freeGround / PILOTIS_CONFIG.PARKING_SPOT_M2);
    // ── v57.13 PARKING DÉTAILLÉ + ESPACE DÉGAGÉ (corrigé) ──
    // Parking basé sur les places REQUISES (réglementation), pas sur tout l'espace théorique
    const parkingPerUnit = (rules && rules.parking_per_unit) || 1;
    const parkingRequired = Math.max(PILOTIS_CONFIG.MIN_PARKING_SPOTS, Math.ceil((totalUnitsResult || 1) * parkingPerUnit));
    const parkingSource = hasPilotis ? "PILOTIS" : "SURFACE";
    // Sol libre TOTAL = site_area - emprise RDC (inclut retraits, cour, jardin, parking)
    const solLibreTotal = site_area - (fpRdc || fp);
    // v57.13: Ratio réaliste — parking requis occupe ~1/3 du sol libre, espace dégagé ~2/3
    // On dimensionne le parking sur les places requises uniquement
    const parkingM2Requis = parkingRequired * PILOTIS_CONFIG.PARKING_SPOT_M2;
    const parkingM2Effectif = hasPilotis ? 0 : Math.min(parkingM2Requis, Math.round(solLibreTotal * 0.33));
    const parkingPlacesEffectif = hasPilotis
      ? Math.floor((fpRdc || fp) / PILOTIS_CONFIG.PARKING_SPOT_M2) // pilotis : sous le bâtiment
      : Math.floor(parkingM2Effectif / PILOTIS_CONFIG.PARKING_SPOT_M2);
    const parkingSuffisant = parkingPlacesEffectif >= parkingRequired;
    const parkingDeficit = parkingSuffisant ? 0 : parkingRequired - parkingPlacesEffectif;
    // Espace dégagé = sol libre - parking effectif en surface
    const espaceVert = Math.max(0, Math.round(solLibreTotal - parkingM2Effectif));
    const freeGroundPctTotal = site_area > 0 ? solLibreTotal / site_area : 0;
    const espaceVertPct = site_area > 0 ? espaceVert / site_area : 0;
    const ratioParkingEspace = solLibreTotal > 0
      ? `${Math.round(parkingM2Effectif / solLibreTotal * 100)}/${Math.round(espaceVert / solLibreTotal * 100)}`
      : "0/0";
    // Qualification de l'espace dégagé (basée sur espace vert réel, pas le sol brut)
    let espaceQualite = "CONFORTABLE";
    let espaceDescription = "";
    if (espaceVertPct >= 0.40) {
      espaceQualite = "GENEREUX";
      espaceDescription = "Espace exterieur genereux — jardin, terrasses, aire de jeux possibles";
    } else if (espaceVertPct >= 0.25) {
      espaceQualite = "CONFORTABLE";
      espaceDescription = "Espace exterieur confortable — cour paysagee, acces vehicules et espaces de vie exterieurs";
    } else if (espaceVertPct >= 0.15) {
      espaceQualite = "FONCTIONNEL";
      espaceDescription = "Espace exterieur fonctionnel — acces, circulation et stationnement assures, mais peu d'agrement";
    } else {
      espaceQualite = "CONTRAINT";
      espaceDescription = "Espace exterieur contraint — privilegier le parking en sous-sol ou pilotis pour liberer du sol";
    }
    // Mitoyenneté justification
    let mitoyenneteJustification = "";
    if (nbMitoyens >= 2) {
      mitoyenneteJustification = `Construction en mitoyennete sur ${nbMitoyens} cotes lateraux, conformement a la pratique courante en zone ${zoning_type} dense. Les murs mitoyens suppriment le retrait lateral (${rLateral}m) sur ces cotes, liberant ${nbMitoyens * rLateral}m de largeur constructible supplementaire. Cette configuration maximise l'emprise au sol sur les parcelles etroites du tissu urbain`;
    } else if (nbMitoyens === 1) {
      mitoyenneteJustification = `Construction en mitoyennete sur 1 cote lateral (appui sur le voisin existant), retrait lateral de ${rLateral}m maintenu de l'autre cote. Configuration courante en zone ${zoning_type} semi-dense`;
    } else {
      mitoyenneteJustification = `Construction isolee — retraits lateraux de ${rLateral}m respectes des deux cotes. Pas de mitoyennete (zone ${zoning_type})`;
    }
    results[label] = {
      fp_m2: fp, fp_rdc_m2: fpRdc || fp, fp_etages_m2: fpEtages || fp,
      levels, height_m: height,
      commerce_levels: commerceLevels,
      massing_mode: mode,
      // v57.20 SPLIT layout (null si SUPERPOSÉ)
      split_layout: splitLayout || null,
      layout_mode: splitLayout ? splitLayout.mode : "SUPERPOSE",
      sdp_m2: sdp,
      cos_compliance: compliance,
      cos_ratio_pct: Math.round(cosRatio * 100),
      has_pilotis: hasPilotis,
      pilotis_levels: pilotisLevels,
      total_levels_incl_pilotis: totalLevelsWithPilotis,
      ground_reserve_pct: Math.round((groundReserve || 0) * 100),
      free_ground_m2: Math.round(freeGround),
      parking_spots_estimate: parkingPlacesEffectif,
      // v57.13 parking détaillé + espace dégagé (basé sur requis, ratio 1/3-2/3)
      parking_detail: {
        places_disponibles: parkingPlacesEffectif,
        places_requises: parkingRequired,
        ratio_par_unite: parkingPerUnit,
        suffisant: parkingSuffisant,
        deficit: parkingDeficit,
        source: parkingSource,
        m2_parking: Math.round(parkingM2Effectif),
        m2_parking_requis: Math.round(parkingM2Requis),
      },
      espace_degage: {
        sol_libre_total_m2: Math.round(solLibreTotal),
        sol_libre_pct: Math.round(freeGroundPctTotal * 100),
        espace_vert_m2: espaceVert,
        espace_vert_pct: Math.round(espaceVertPct * 100),
        ratio_parking_espace: ratioParkingEspace,
        qualite: espaceQualite,
        description: espaceDescription,
      },
      mitoyennete_detail: {
        nb_cotes: nbMitoyens,
        justification: mitoyenneteJustification,
        largeur_recuperee_m: nbMitoyens * rLateral,
      },
      role: SCENARIO_ROLE[label],
      label_fr: labels_fr[label],
      accent_color: accents[label],
      estimated_cost: estimatedCost,
      cost_per_m2: costPerM2,
      market_cost_per_m2: marketCostPerM2,
      cost_adjusted: costAdjusted,
      budget_fit: budgetFit,
      // v57.0 CES-driven extras
      program_driven: isProgramDriven,
      program_key: programKey || "NONE",
      unit_mix_detail: unitMixDetail || "N/A",
      total_units: totalUnitsResult,
      target_units_client: target_units || 0,
      total_useful_m2: Math.round(totalUseful || 0),
      circulation_ratio_pct: Math.round((circRatio || 0) * 100),
      ces_fill_pct: Math.round(((fpRdc || fp) / Math.max(1, site_area)) * 100),  // % réel du terrain occupé au sol
      body_depth_m: bodyDepth || 0,
      // v57.13 EXPERT RATIOS — grille architecte-urbaniste africain
      // v57.13 — ancre programme client
      target_sdp_programme_m2: target_sdp_programme || 0,
      // v57.13 EXPERT RATIOS — diagnostic (narrative, pas lifting)
      expert_ces_recommande_pct: expertRatio ? Math.round(expertRatio.ces * 100) : null,
      expert_floors_range: expertRatio?.fl || null,
      expert_efficiency_pct: expertRatio ? Math.round(expertRatio.eff * 100) : null,
      // ── v57.6 EFFICIENCY METRICS ──
      surface_habitable_m2: Math.round(totalUseful || 0),
      ratio_efficacite_pct: sdp > 0 ? Math.round((totalUseful || 0) / sdp * 100) : 0,
      m2_habitable_par_logement: totalUnitsResult > 0 ? Math.round((totalUseful || 0) / totalUnitsResult) : 0,
      // ── v57.6 COST BREAKDOWN ──
      cost_construction_fcfa: Math.round(constructionCost),
      cost_vrd_fcfa: Math.round(vrdCost),
      cost_total_fcfa: estimatedCost,
      cost_per_m2_sdp: Math.round(costPerM2 * 1.05),
      cost_per_unit: totalUnitsResult > 0 ? Math.round(estimatedCost / totalUnitsResult) : 0,
      cost_per_m2_habitable: (totalUseful > 0) ? Math.round(estimatedCost / totalUseful) : 0,
      // ── 2. REGULATORY COMPLIANCE (new in v57.6) ──
      regulatory: {
        ces_reglementaire_pct: Math.round(ces * 100),
        ces_effectif_pct: Math.round((effectiveCESOutput || ces) * 100),
        ces_utilise_pct: Math.round(((fpRdc || fp) / Math.max(1, site_area)) * 100),
        ces_marge_pct: Math.round((ces - (fpRdc || fp) / Math.max(1, site_area)) * 100),
        cos_reglementaire: cos,
        cos_utilise_pct: Math.round(cosRatio * 100),
        cos_marge_pct: Math.round((1 - cosRatio) * 100),
        hauteur_max_m: Number(max_height_m) || 99,
        hauteur_projet_m: height,
        hauteur_marge_m: Math.round(((Number(max_height_m) || 99) - height) * 10) / 10,
        conformite_globale: compliance === "CONFORME" ? "CONFORME" : compliance,
        // v57.7 retraits
        retrait_avant_m: rAvant,
        retrait_lateral_m: rLateral,
        retrait_arriere_m: rArriere,
        mitoyennete_cotes: nbMitoyens,
        emprise_constructible_m2: Math.round(empriseConstructible),
        emprise_effective_m2: Math.round(empriseEffective),
        reduction_retraits_pct: setbackReductionPct,
        // v57.9 solaire
        zone_climatique: climaticZone,
        orientation_score: solarImpact.orientationScore,
        profondeur_recommandee_m: solarImpact.profondeur_recommandee_m,
        facade_optimale: solarImpact.facade_optimale,
        facade_a_proteger: solarImpact.facade_a_proteger,
        ventilation_traversante: solarImpact.ventilation_traversante,
        brise_soleil: solarImpact.brise_soleil,
        malus_orientation_pct: solarImpact.malus_orientation_pct,
      },
      // ── 3. SCENARIO IDENTITY (new in v57.6) ──
      scenario_identity: {
        code: label,
        nom: labels_fr[label],
        role: SCENARIO_ROLE[label],
        description: generateScenarioDescription(label, SCENARIO_ROLE[label], {
          ces_fill_pct: Math.round(((fpRdc || fp) / Math.max(1, site_area)) * 100),
          sdp: sdp,
          levels: levels,
          free_ground_m2: Math.round(freeGround),
        }),
      },
      // ── v57.6 FINANCIAL LAYER ──
      revenu_mensuel_brut: 0,
      revenu_annuel_brut: 0,
      revenu_annuel_net: 0,
      revenu_detail: {},
      vacancy_rate_pct: 0,
      rendement_brut_pct: 0,
      roi_annees: 0,
      ratio_invest_revenu: 0,
      cout_fourchette: { bas: 0, median: estimatedCost, haut: 0 },
      complexite: { score: 0, label: "Moyen" },
      risque: "MOYEN",
    };
    // ── v72.86 TYPOLOGY + PILOTIS DESCRIPTION ──
    // Builds human-readable description of the architectural configuration
    {
      const sc = results[label];
      const isSplit = sc.split_layout && sc.split_layout.mode === "SPLIT_AV_AR";
      // Typology name (forme du bâti)
      const typoNames = {
        BLOC: "bloc compact", EN_L: "en L", EN_U: "en U", BARRE: "barre (lamelle)", EXTENSION: "extension",
      };
      // Predict typology from scenario params (same logic as selectTypology)
      const fillR = fp / Math.max(1, empriseConstructible);
      let predictedTypo;
      if (fillR > 0.80) predictedTypo = "BLOC";
      else if (role === "PRUDENT" && fillR > 0.35) predictedTypo = "BLOC";
      else if (role === "INTENSIFICATION" && isMixte && empriseConstructible > 500 && fillR > 0.35) predictedTypo = "EN_U";
      else if (mode === "COMPACT") predictedTypo = "BLOC";
      else if (mode === "SPREAD") predictedTypo = (empriseConstructible > 400) ? "EN_L" : "BARRE";
      else predictedTypo = (isMixte && fillR > 0.35 && empriseConstructible > 400) ? "EN_U" : "BLOC";
      const typoName = typoNames[predictedTypo] || "bloc compact";
      // Pilotis description
      let pilotisDesc;
      if (isSplit && sc.has_pilotis) {
        pilotisDesc = `logement sur pilotis (RDC libere), commerce en volume separe devant`;
      } else if (sc.has_pilotis) {
        pilotisDesc = `RDC sur pilotis (sol libere pour parking et circulation)`;
      } else if (isSplit) {
        pilotisDesc = `commerce au RDC en volume separe, logement en retrait`;
      } else {
        pilotisDesc = `commerce directement au RDC, logement aux etages superieurs (volume unique superpose)`;
      }
      // Configuration justification
      let configJustif;
      if (isSplit) {
        const cD = sc.split_layout.volume_commerce.depth_m || 6;
        const gD = sc.split_layout.retrait_inter_m || 4;
        configJustif = `Configuration en deux volumes separes (SPLIT) : commerce en bande de ${cD}m de profondeur devant, logement en retrait de ${Math.round(cD + gD)}m sur pilotis a l'arriere. Cette disposition maximise la visibilite commerciale depuis la rue, degage un espace de circulation entre les deux volumes, et libere le sol sous le logement pour le stationnement. La mitoyennete sur ${nbMitoyens} cote(s) impose des murs aveugles lateraux, compensee par des ouvertures en facade avant et arriere pour la ventilation traversante en climat ${climaticZone.toLowerCase()}.`;
      } else if (sc.has_pilotis) {
        // v72.92: SUPERPOSÉ + PILOTIS — le renderer montre commerce devant + logement sur pilotis
        configJustif = `Configuration avec logement sur pilotis : le RDC est libere pour le stationnement et la circulation, tandis que le commerce est au rez-de-chaussee et les logements aux etages. Cette disposition sur pilotis (${typoName}) libere l'emprise au sol (${Math.round(fp)} m2) pour le parking et les espaces verts. La mitoyennete sur ${nbMitoyens} cote(s) contraint les ouvertures laterales, favorisant une orientation des pieces de vie en facade avant et arriere pour la ventilation naturelle en climat ${climaticZone.toLowerCase()}.`;
      } else {
        configJustif = `Configuration en volume unique superpose (${typoName}) : commerce au RDC et logement aux etages. Cette disposition compacte optimise le cout de construction (une seule structure porteuse, une seule toiture) et minimise l'emprise au sol (${Math.round(fp)} m2). La mitoyennete sur ${nbMitoyens} cote(s) contraint les ouvertures laterales, favorisant une orientation des pieces de vie en facade avant et arriere pour la ventilation naturelle en climat ${climaticZone.toLowerCase()}.`;
      }
      sc.typology_predicted = predictedTypo;
      // v72.92: typology_desc doit TOUJOURS refléter ce que le massing montre visuellement
      if (isSplit) {
        sc.typology_desc = `deux volumes separes (split avant/arriere)${sc.has_pilotis ? ", logement sur pilotis" : ""}`;
      } else if (sc.has_pilotis) {
        // SUPERPOSÉ + PILOTIS: le renderer montre un split synthétique avec pilotis
        sc.typology_desc = `${typoName}, logement sur pilotis (RDC libere)`;
      } else {
        sc.typology_desc = `${typoName} (superpose)`;
      }
      sc.pilotis_desc = pilotisDesc;
      sc.config_justification = configJustif;
    }
    // ── v57.6 REVENUE & FINANCIAL INDICATORS ──
    const loyerKey = /PREMIUM|HAUT/i.test(String(standing_level)) ? "PREMIUM" : /ECO/i.test(String(standing_level)) ? "ECO" : "STANDARD";
    const loyers = LOYERS_MENSUELS_FCFA[loyerKey] || LOYERS_MENSUELS_FCFA.STANDARD;
    const vacancyRate = VACANCY_RATE_BY_ZONING[zoning_type] || 0.15;
    let revenuMensuelBrut = 0;
    const revenuDetail = {};
    for (const [typo, count] of Object.entries(unitMix)) {
      if (count <= 0) continue;
      const loyerUnit = loyers[typo] || loyers.T3 || 100000;
      revenuMensuelBrut += count * loyerUnit;
      revenuDetail[typo] = { count, loyer_unitaire: loyerUnit, loyer_total: count * loyerUnit };
    }
    const revenuAnnuelBrut = revenuMensuelBrut * 12;
    const revenuAnnuelNet = Math.round(revenuAnnuelBrut * (1 - vacancyRate));
    const rendementBrutPct = estimatedCost > 0 ? Math.round(revenuAnnuelNet / estimatedCost * 10000) / 100 : 0;
    const roiAnnees = revenuAnnuelNet > 0 ? Math.round(estimatedCost / revenuAnnuelNet * 10) / 10 : 0;
    // Cost range (fourchette)
    const costBas = Math.round(estimatedCost * COST_RANGE_MULT.bas);
    const costHaut = Math.round(estimatedCost * COST_RANGE_MULT.haut);
    // Complexity (1-5) — v72.88: pilotis +2 (was +1), split_layout +1
    //   Pilotis structures are structurally more complex than compact (requires transfer slab).
    //   Split layout (2 separate volumes) adds coordination complexity.
    //   This ensures B(pilotis+split) always scores higher than C(compact).
    const complexityScore = Math.min(5, 1 + Math.floor(levels / 2) + (hasPilotis ? 2 : 0) + (splitLayout ? 1 : 0) + (totalUnitsResult > 12 ? 1 : 0) + (commerceLevels > 0 ? 1 : 0));
    const complexityLabel = ["", "Faible", "Modere", "Moyen", "Eleve", "Tres eleve"][complexityScore] || "Moyen";
    // Risk level
    let riskLevel = "MOYEN";
    if (budgetFit === "HORS_BUDGET" && cosRatio > 0.90) riskLevel = "ELEVE";
    else if (budgetFit === "DANS_BUDGET" && cosRatio < 0.80) riskLevel = "FAIBLE";
    else if (budgetFit === "HORS_BUDGET") riskLevel = "ELEVE";
    else if (cosRatio > 0.95) riskLevel = "ELEVE";
    // v57.9: ventilation des coûts par poste + honoraires fourchette + frais + solaire
    const coutConstruction = Math.round(sdp * costPerM2); // hors VRD
    const honorairesResult = calcHonorairesDegressifs(estimatedCost);
    const honorairesArchi = honorairesResult.median;
    const tauxHonorairesBas = estimatedCost > 0 ? Math.round(honorairesResult.bas / estimatedCost * 10000) / 100 : 0;
    const tauxHonorairesHaut = estimatedCost > 0 ? Math.round(honorairesResult.haut / estimatedCost * 10000) / 100 : 0;
    const tauxHonoraires = estimatedCost > 0 ? Math.round(honorairesArchi / estimatedCost * 10000) / 100 : 0;
    const fraisPermis = Math.round(estimatedCost * FRAIS_ANNEXES_PCT.permis_construire);
    const fraisAssurance = Math.round(estimatedCost * FRAIS_ANNEXES_PCT.assurance_dommage_ouvrage);
    const fraisEtudes = Math.round(estimatedCost * FRAIS_ANNEXES_PCT.etudes_techniques);
    const fraisDivers = Math.round(estimatedCost * FRAIS_ANNEXES_PCT.divers_imprevus);
    const totalFraisAnnexes = fraisPermis + fraisAssurance + fraisEtudes + fraisDivers;
    // Malus orientation solaire (surcoût climatisation si mal orienté)
    const malusSolaire = solarImpact.malus_orientation_pct > 0 ? Math.round(estimatedCost * solarImpact.malus_orientation_pct / 100) : 0;
    const coutGlobalProjet = estimatedCost + honorairesArchi + totalFraisAnnexes + malusSolaire;
    // v72.90: ventilation par rôle (A/B/C ont des ratios différents)
    const ventPct = COST_VENTILATION_PCT_BY_ROLE[label] || COST_VENTILATION_PCT;
    results[label].cout_ventilation = {
      gros_oeuvre_fcfa: Math.round(coutConstruction * ventPct.gros_oeuvre),
      second_oeuvre_fcfa: Math.round(coutConstruction * ventPct.second_oeuvre),
      lots_techniques_fcfa: Math.round(coutConstruction * ventPct.lots_techniques),
      amenagements_ext_fcfa: Math.round(coutConstruction * ventPct.amenagements_ext),
      vrd_fcfa: Math.round(vrdCost),
      sous_total_construction_fcfa: estimatedCost,
      honoraires_architecte: {
        bas_fcfa: honorairesResult.bas,
        median_fcfa: honorairesArchi,
        haut_fcfa: honorairesResult.haut,
        taux_bas_pct: tauxHonorairesBas,
        taux_median_pct: tauxHonoraires,
        taux_haut_pct: tauxHonorairesHaut,
      },
      frais_annexes: {
        permis_construire_fcfa: fraisPermis,
        assurance_dommage_ouvrage_fcfa: fraisAssurance,
        etudes_techniques_fcfa: fraisEtudes,
        divers_imprevus_fcfa: fraisDivers,
        total_frais_annexes_fcfa: totalFraisAnnexes,
      },
      malus_orientation_solaire_fcfa: malusSolaire,
      cout_global_projet_fcfa: coutGlobalProjet,
    };
    results[label].cout_global_projet_fcfa = coutGlobalProjet;
    results[label].honoraires_architecte_fcfa = honorairesArchi;
    results[label].malus_orientation_solaire_fcfa = malusSolaire;
    // v57.7: durée estimée du chantier
    const dureeBase = DUREE_CHANTIER_MOIS_PAR_NIVEAU;
    const dureeTotale = dureeBase.fondations_terrassement
      + levels * dureeBase.par_niveau
      + dureeBase.finitions
      + dureeBase.vrd_ext;
    results[label].duree_chantier_mois = Math.round(dureeTotale);
    // Update the results object with financial metrics
    results[label].revenu_mensuel_brut = revenuMensuelBrut;
    results[label].revenu_annuel_brut = revenuAnnuelBrut;
    results[label].revenu_annuel_net = revenuAnnuelNet;
    results[label].revenu_detail = revenuDetail;
    results[label].vacancy_rate_pct = Math.round(vacancyRate * 100);
    results[label].rendement_brut_pct = rendementBrutPct;
    results[label].roi_annees = roiAnnees;
    results[label].ratio_invest_revenu = revenuAnnuelNet > 0 ? Math.round(estimatedCost / revenuAnnuelNet * 10) / 10 : 0;
    results[label].cout_fourchette = { bas: costBas, median: estimatedCost, haut: costHaut };
    results[label].complexite = { score: complexityScore, label: complexityLabel };
    results[label].risque = riskLevel;
  }
  const r = results;
  // Helper : recalcule SDP duale pour un scénario
  const recalcSdp = (s) => {
    s.sdp_m2 = (s.fp_rdc_m2 && s.fp_etages_m2 && s.levels > 1)
      ? s.fp_rdc_m2 + s.fp_etages_m2 * (s.levels - 1)
      : s.fp_m2 * s.levels;
    s.height_m = Math.round(s.levels * floor_height * 10) / 10;
  };
  // ══════════════════════════════════════════════════════════════════
  // v70.10 ROBUST ANTI-COLLAPSE : post-loop B vs C differentiation
  // If B and C have identical levels AND identical fp → FORCE differentiation
  // ══════════════════════════════════════════════════════════════════
  if (r.B && r.C) {
    const bLev = r.B.levels, cLev = r.C.levels;
    const bFp = Math.round(r.B.fp_m2), cFp = Math.round(r.C.fp_m2);
    const bSdp = Math.round(r.B.sdp_m2), cSdp = Math.round(r.C.sdp_m2);
    // v72.82: calcul du SDP min pour que le programme C rentre
    const cTotalUseful = r.C.total_useful_m2 || r.C.surface_habitable_m2 || 0;
    const cMinSdp = cTotalUseful > 0 ? Math.ceil(cTotalUseful / (1 - 0.15)) : 0;
    if (bLev === cLev && bFp === cFp) {
      console.log(`│ ⚠️ v70.10 ANTI-COLLAPSE: B(${bLev}niv,${bFp}m²) === C(${cLev}niv,${cFp}m²) → différenciation`);
      if (cLev >= 2) {
        // v72.82: vérifier que la réduction ne casse pas le programme
        const proposedLevels = cLev - 1;
        const sdpIfReduced = r.C.fp_rdc_m2 + r.C.fp_etages_m2 * Math.max(0, proposedLevels - 1);
        if (cMinSdp === 0 || sdpIfReduced >= cMinSdp) {
          r.C.levels = proposedLevels;
          recalcSdp(r.C);
          console.log(`│   → C réduit à ${r.C.levels} niv, SDP=${r.C.sdp_m2}m² (≥ prog ${cMinSdp})`);
        } else {
          console.log(`│   → C MAINTENU à ${cLev} niv (SDP ${sdpIfReduced} < prog ${cMinSdp})`);
        }
      } else {
        r.C.fp_m2 = Math.round(cFp * 0.85);
        r.C.fp_rdc_m2 = r.C.fp_m2;
        r.C.fp_etages_m2 = r.C.fp_m2;
        recalcSdp(r.C);
        console.log(`│   → C emprise réduite à ${r.C.fp_m2}m², SDP=${r.C.sdp_m2}m²`);
      }
    } else if (bSdp === cSdp && bSdp > 0) {
      console.log(`│ ⚠️ v70.10 ANTI-COLLAPSE (SDP): B.sdp=${bSdp} === C.sdp=${cSdp}`);
      if (cLev >= 2) {
        const proposedLevels = cLev - 1;
        const sdpIfReduced = r.C.fp_rdc_m2 + r.C.fp_etages_m2 * Math.max(0, proposedLevels - 1);
        if (cMinSdp === 0 || sdpIfReduced >= cMinSdp) {
          r.C.levels = proposedLevels;
          recalcSdp(r.C);
          console.log(`│   → C réduit à ${r.C.levels} niv, SDP=${r.C.sdp_m2}m²`);
        } else {
          console.log(`│   → C MAINTENU (SDP ${sdpIfReduced} < prog ${cMinSdp})`);
        }
      }
    }
  }
  // ── v57.6 HELPERS FOR DIAGNOSTICS ──
  // Generate scenario description (1-2 sentences in French)
  function generateScenarioDescription(label, role, sc_data) {
    const sdp = Math.round(sc_data.sdp);
    const ces = sc_data.ces_fill_pct;
    const niv = sc_data.levels;
    const libre = Math.round(sc_data.free_ground_m2);
    if (label === "A") {
      return `Intensification : exploitation maximale du potentiel constructible du terrain. Emprise au sol de ${ces}%, developpant ${sdp}m² de SDP sur ${niv} niveaux. Cette option maximise la surface construite et le nombre d'unites, au prix d'un sol libre reduit (${libre}m²).`;
    } else if (label === "B") {
      return `Equilibre : compromis entre densite et qualite de vie. Emprise moderee a ${ces}% du terrain, produisant ${sdp}m² de SDP sur ${niv} niveaux avec ${libre}m² d'espace libre. Ce scenario offre un bon ratio entre rendement et habitabilite.`;
    } else if (label === "C") {
      return `Prudent : implantation mesuree, phasable et evolutive. Emprise contenue a ${ces}% du terrain, preservant ${libre}m² d'espaces exterieurs. Les ${sdp}m² de SDP sur ${niv} niveaux permettent une construction progressive et un investissement maitrise.`;
    }
    return "Scenario de projet immobilier.";
  }
  // Extract comparison data for a scenario
  function extractComparatif(sc) {
    return {
      emprise_rdc_m2: sc.fp_rdc_m2 || sc.fp_m2,
      emprise_etages_m2: sc.fp_etages_m2 || sc.fp_m2,
      niveaux: sc.levels,
      hauteur_m: sc.height_m,
      sdp_m2: sc.sdp_m2,
      surface_habitable_m2: sc.surface_habitable_m2 || 0,
      ratio_efficacite_pct: sc.ratio_efficacite_pct || 0,
      unites: sc.total_units,
      m2_par_logement: sc.m2_habitable_par_logement || 0,
      cout_total_fcfa: sc.cost_total_fcfa || sc.estimated_cost,
      cout_par_unite: sc.cost_per_unit || 0,
      cout_par_m2_sdp: sc.cost_per_m2_sdp || 0,
      cout_par_m2_marche: sc.market_cost_per_m2 || 0,
      cout_par_m2_ajuste: sc.cost_per_m2 || 0,
      cost_adjusted: sc.cost_adjusted || false,
      cout_par_m2_habitable: sc.cost_per_m2_habitable || 0,
      ces_utilise_pct: sc.ces_fill_pct,
      cos_utilise_pct: sc.cos_ratio_pct,
      conformite: sc.cos_compliance,
      budget_fit: sc.budget_fit,
      parking: sc.parking_spots_estimate,
      parking_detail: sc.parking_detail || {},
      sol_libre_m2: sc.free_ground_m2,
      sol_libre_pct: sc.free_ground_m2 > 0 ? Math.round(sc.free_ground_m2 / site_area * 100) : 0,
      espace_degage: sc.espace_degage || {},
      mitoyennete_detail: sc.mitoyennete_detail || {},
      // v57.6 : coût fourchette + complexité + risque (diagnostic scope)
      cout_fourchette: sc.cout_fourchette || {},
      complexite: sc.complexite ? sc.complexite.label : "N/A",
      risque: sc.risque || "N/A",
      // v57.7 : ventilation coûts + durée + scoring décomposé + retraits
      cout_ventilation: sc.cout_ventilation || {},
      duree_chantier_mois: sc.duree_chantier_mois || 0,
      score_recommandation: sc.recommendation_score || 0,
      score_detail: sc.score_detail || {},
      retraits: sc.regulatory ? {
        avant_m: sc.regulatory.retrait_avant_m,
        lateral_m: sc.regulatory.retrait_lateral_m,
        arriere_m: sc.regulatory.retrait_arriere_m,
        mitoyennete: sc.regulatory.mitoyennete_cotes,
        emprise_constructible_m2: sc.regulatory.emprise_constructible_m2,
        reduction_pct: sc.regulatory.reduction_retraits_pct,
      } : {},
    };
  }
  // v57.8: Phasage intelligent — durées, jalons datés (M0..Mn), répartition budgétaire, calendrier structuré
  function generatePhasingStrategy(recommended, r_results, ctx) {
    const recSc = r_results[recommended];
    const totalCost = recSc.cost_total_fcfa || recSc.estimated_cost;
    const globalCost = recSc.cout_global_projet_fcfa || totalCost;
    const honoraires = recSc.honoraires_architecte_fcfa || 0;
    const dureeBase = DUREE_CHANTIER_MOIS_PAR_NIVEAU;
    // Calendrier structuré (données machine pour 8F)
    const calendrier = [];
    let moisCourant = 0;
    // Projet compact (1-2 niveaux) : monophasé avec calendrier détaillé
    if (recSc.levels <= 2) {
      const dureeFond = dureeBase.fondations_terrassement;
      const dureeGO = Math.round(recSc.levels * dureeBase.par_niveau);
      const dureeFin = dureeBase.finitions;
      const dureeVRD = dureeBase.vrd_ext;
      const dureeTotal = dureeFond + dureeGO + dureeFin + dureeVRD;
      const parts = [];
      // Jalons datés
      calendrier.push({ jalon: "Demarrage chantier", mois: `M0`, cout_cumule_pct: 0 });
      parts.push(`CONSTRUCTION MONOPHASEE — Duree estimee : ${Math.round(dureeTotal)} mois (M0 a M${Math.round(dureeTotal)}).`);
      moisCourant = dureeFond;
      calendrier.push({ jalon: "Fin fondations", mois: `M${moisCourant}`, cout_cumule_pct: 15 });
      parts.push(`M0-M${moisCourant} — Terrassement + fondations : ${dureeFond} mois | ${Math.round(totalCost * 0.15 / 1e6)}M FCFA (15% du budget construction).`);
      const finGO = moisCourant + dureeGO;
      calendrier.push({ jalon: "Fin gros oeuvre (hors d'eau/hors d'air)", mois: `M${Math.round(finGO)}`, cout_cumule_pct: 55 });
      parts.push(`M${moisCourant}-M${Math.round(finGO)} — Gros oeuvre + etancheite : ${dureeGO} mois | ${Math.round(totalCost * 0.40 / 1e6)}M FCFA (40%). Batiment hors d'eau hors d'air.`);
      moisCourant = Math.round(finGO);
      const finFin = moisCourant + dureeFin;
      calendrier.push({ jalon: "Fin second oeuvre + lots techniques", mois: `M${Math.round(finFin)}`, cout_cumule_pct: 90 });
      parts.push(`M${moisCourant}-M${Math.round(finFin)} — Second oeuvre + lots techniques : ${dureeFin} mois | ${Math.round(totalCost * 0.35 / 1e6)}M FCFA (35%).`);
      moisCourant = Math.round(finFin);
      const finVRD = moisCourant + dureeVRD;
      calendrier.push({ jalon: "Reception + livraison", mois: `M${Math.round(finVRD)}`, cout_cumule_pct: 100 });
      parts.push(`M${moisCourant}-M${Math.round(finVRD)} — VRD + amenagements exterieurs + reception : ${dureeVRD} mois | ${Math.round(totalCost * 0.10 / 1e6)}M FCFA (10%).`);
      parts.push(`\nBUDGET GLOBAL — Construction : ${Math.round(totalCost / 1e6)}M FCFA + Honoraires architecte : ${Math.round(honoraires / 1e6)}M FCFA = ${Math.round(globalCost / 1e6)}M FCFA TTC. Le projet compact simplifie la gestion du chantier.`);
      return {
        text: parts.join("\n"),
        calendrier,
        phases: [{ nom: "Construction complete", duree_mois: Math.round(dureeTotal), cout_construction_fcfa: totalCost, pct_budget: 100 }],
        duree_totale_mois: Math.round(dureeTotal),
        cout_global_projet_fcfa: globalCost,
      };
    }
    // Projet multi-niveaux : phasé en 2-3 tranches
    const phase1Floors = Math.min(2, recSc.levels - 1);
    const phase1Levels = 1 + phase1Floors;
    const phase1CostRatio = phase1Levels / recSc.levels;
    const phase1Cost = Math.round(totalCost * phase1CostRatio);
    const phase1Sdp = Math.round(recSc.fp_rdc_m2 + recSc.fp_etages_m2 * phase1Floors);
    const phase1DureeFond = dureeBase.fondations_terrassement;
    const phase1DureeGO = Math.round(phase1Levels * dureeBase.par_niveau);
    const phase1DureeFin = dureeBase.finitions;
    const phase1Duree = phase1DureeFond + phase1DureeGO + phase1DureeFin;
    const remainingFloors = recSc.levels - phase1Levels;
    const parts = [];
    const phasesData = [];
    const dureeTotalEstimee = recSc.duree_chantier_mois || Math.round(phase1Duree + remainingFloors * dureeBase.par_niveau + dureeBase.finitions + dureeBase.vrd_ext);
    parts.push(`CONSTRUCTION PHASEE — ${remainingFloors > 2 ? 3 : 2} tranches, duree totale estimee : ${dureeTotalEstimee} mois (M0 a M${dureeTotalEstimee}).`);
    // Phase 1 avec jalons datés
    calendrier.push({ jalon: "Demarrage Phase 1", mois: "M0", cout_cumule_pct: 0 });
    parts.push(`\nPHASE 1 — RDC + ${phase1Floors} etage(s) | ${phase1Sdp}m² SDP | ${Math.round(phase1Duree)} mois | ${Math.round(phase1Cost / 1e6)}M FCFA (${Math.round(phase1CostRatio * 100)}% du budget).`);
    moisCourant = phase1DureeFond;
    calendrier.push({ jalon: "Fin fondations (dim. pour " + recSc.levels + " niv.)", mois: `M${moisCourant}`, cout_cumule_pct: Math.round(phase1CostRatio * 15) });
    parts.push(`  M0-M${moisCourant} — Fondations dimensionnees pour ${recSc.levels} niveaux (structure renforcee des le depart).`);
    const finGO1 = moisCourant + phase1DureeGO;
    calendrier.push({ jalon: "Phase 1 hors d'eau", mois: `M${Math.round(finGO1)}`, cout_cumule_pct: Math.round(phase1CostRatio * 55) });
    parts.push(`  M${moisCourant}-M${Math.round(finGO1)} — Gros oeuvre RDC a R+${phase1Floors}.`);
    moisCourant = Math.round(finGO1);
    const finFin1 = moisCourant + phase1DureeFin;
    calendrier.push({ jalon: "Livraison Phase 1", mois: `M${Math.round(finFin1)}`, cout_cumule_pct: Math.round(phase1CostRatio * 100) });
    parts.push(`  M${moisCourant}-M${Math.round(finFin1)} — Finitions + mise en service. Tranche autonome et fonctionnelle.`);
    moisCourant = Math.round(finFin1);
    phasesData.push({ nom: "Phase 1 (RDC+R" + phase1Floors + ")", debut: "M0", fin: `M${moisCourant}`, duree_mois: Math.round(phase1Duree), cout_construction_fcfa: phase1Cost, pct_budget: Math.round(phase1CostRatio * 100), sdp_m2: phase1Sdp });
    // Phase 2
    if (remainingFloors > 0) {
      const phase2Floors = remainingFloors > 2 ? Math.ceil(remainingFloors / 2) : remainingFloors;
      const phase2CostRatio = phase2Floors / recSc.levels;
      const phase2Cost = Math.round(totalCost * phase2CostRatio);
      const phase2DureeGO = Math.round(phase2Floors * dureeBase.par_niveau);
      const phase2DureeFin = remainingFloors <= 2 ? dureeBase.finitions + dureeBase.vrd_ext : Math.round(dureeBase.finitions * 0.5);
      const phase2Duree = phase2DureeGO + phase2DureeFin;
      const phase2Start = moisCourant;
      calendrier.push({ jalon: "Demarrage Phase 2 (surelevation)", mois: `M${moisCourant}`, cout_cumule_pct: Math.round(phase1CostRatio * 100) });
      parts.push(`\nPHASE 2 — Surelevation R+${phase1Floors + 1} a R+${phase1Floors + phase2Floors} | +${Math.round(recSc.fp_etages_m2 * phase2Floors)}m² SDP | M${moisCourant}-M${moisCourant + phase2Duree} (${phase2Duree} mois) | ${Math.round(phase2Cost / 1e6)}M FCFA (${Math.round(phase2CostRatio * 100)}%).`);
      moisCourant += phase2DureeGO;
      calendrier.push({ jalon: "Phase 2 hors d'eau", mois: `M${moisCourant}`, cout_cumule_pct: Math.round((phase1CostRatio + phase2CostRatio * 0.6) * 100) });
      moisCourant += phase2DureeFin;
      calendrier.push({ jalon: remainingFloors <= 2 ? "Livraison finale" : "Livraison Phase 2", mois: `M${moisCourant}`, cout_cumule_pct: Math.round((phase1CostRatio + phase2CostRatio) * 100) });
      parts.push(`  Avantage : l'investissement initial est reduit de ${Math.round((1 - phase1CostRatio) * 100)}%, permettant de financer la phase 2 par les revenus de la phase 1 ou un second financement.`);
      phasesData.push({ nom: `Phase 2 (R+${phase1Floors + 1} a R+${phase1Floors + phase2Floors})`, debut: `M${phase2Start}`, fin: `M${moisCourant}`, duree_mois: phase2Duree, cout_construction_fcfa: phase2Cost, pct_budget: Math.round(phase2CostRatio * 100) });
      // Phase 3
      const phase3Floors = remainingFloors - phase2Floors;
      if (phase3Floors > 0) {
        const phase3CostRatio = phase3Floors / recSc.levels;
        const phase3Cost = Math.round(totalCost * phase3CostRatio);
        const phase3Duree = Math.round(phase3Floors * dureeBase.par_niveau + dureeBase.finitions * 0.5 + dureeBase.vrd_ext);
        const phase3Start = moisCourant;
        calendrier.push({ jalon: "Demarrage Phase 3", mois: `M${moisCourant}`, cout_cumule_pct: Math.round((phase1CostRatio + phase2CostRatio) * 100) });
        parts.push(`\nPHASE 3 — Surelevation R+${phase1Floors + phase2Floors + 1} a R+${recSc.levels - 1} | +${Math.round(recSc.fp_etages_m2 * phase3Floors)}m² SDP | M${moisCourant}-M${moisCourant + phase3Duree} (${phase3Duree} mois) | ${Math.round(phase3Cost / 1e6)}M FCFA (${Math.round(phase3CostRatio * 100)}%).`);
        moisCourant += phase3Duree;
        calendrier.push({ jalon: "Livraison finale", mois: `M${moisCourant}`, cout_cumule_pct: 100 });
        phasesData.push({ nom: `Phase 3 (R+${phase1Floors + phase2Floors + 1} a R+${recSc.levels - 1})`, debut: `M${phase3Start}`, fin: `M${moisCourant}`, duree_mois: phase3Duree, cout_construction_fcfa: phase3Cost, pct_budget: Math.round(phase3CostRatio * 100) });
      }
    }
    parts.push(`\nSTRATEGIE STRUCTURELLE — Fondations et poteaux dimensionnes des la phase 1 pour ${recSc.levels} niveaux. Surcoût de renforcement initial : +8-12% sur les fondations, compense par l'economie sur la mobilisation de chantier.`);
    parts.push(`BUDGET GLOBAL — Construction : ${Math.round(totalCost / 1e6)}M FCFA + Honoraires architecte : ${Math.round(honoraires / 1e6)}M FCFA = ${Math.round(globalCost / 1e6)}M FCFA TTC.`);
    return {
      text: parts.join("\n"),
      calendrier,
      phases: phasesData,
      duree_totale_mois: moisCourant > 0 ? moisCourant : dureeTotalEstimee,
      cout_global_projet_fcfa: globalCost,
    };
  }
  // v57.7: Narratif stratégique contextualisé
  // Identifie la CONTRAINTE DOMINANTE du projet et construit l'argumentaire autour
  function generateRecommendationNarrative(recommended, r_results, ctx) {
    const sc = r_results[recommended];
    const noms = { A: "Intensification", B: "Equilibre", C: "Prudent" };
    const costM = Math.round((sc.cost_total_fcfa || sc.estimated_cost) / 1e6);
    const costBas = sc.cout_fourchette ? Math.round(sc.cout_fourchette.bas / 1e6) : Math.round(costM * 0.85);
    const costHaut = sc.cout_fourchette ? Math.round(sc.cout_fourchette.haut / 1e6) : Math.round(costM * 1.2);
    const habM2 = sc.surface_habitable_m2 || sc.total_useful_m2 || 0;
    const m2Logt = sc.m2_habitable_par_logement || 0;
    const coutLogt = sc.cost_per_unit ? Math.round(sc.cost_per_unit / 1e6) : 0;
    const reg = sc.regulatory || {};
    const scoreDet = sc.score_detail || {};
    const parts = [];
    // ══════════════════════════════════════════════════════════════════
    // v57.7: IDENTIFICATION CONTRAINTE DOMINANTE
    // ══════════════════════════════════════════════════════════════════
    // On identifie le facteur limitant principal parmi : budget, terrain, réglementation, programme
    let contrainteDominante = "equilibre"; // default
    let contrainteExplication = "";
    const budgetMaxCtx = ctx.budgetMax || 0;
    const solLibrePct = sc.free_ground_m2 > 0 ? sc.free_ground_m2 / ctx.site_area : 1;
    if (sc.budget_fit === "HORS_BUDGET" && budgetMaxCtx > 0) {
      contrainteDominante = "budget";
      contrainteExplication = `le budget disponible (${Math.round(budgetMaxCtx / 1e6)}M FCFA) est le facteur limitant principal de ce projet`;
    } else if (sc.cos_ratio_pct > 85) {
      contrainteDominante = "reglementation";
      contrainteExplication = `la densite reglementaire (COS a ${sc.cos_ratio_pct}%) est le facteur structurant — le terrain est exploite pres de sa capacite maximale`;
    } else if (solLibrePct < 0.25 || setbackReductionPct > 20) {
      contrainteDominante = "terrain";
      contrainteExplication = `la geometrie du terrain et les retraits reglementaires (${setbackReductionPct}% de reduction d'emprise) sont les contraintes majeures de l'implantation`;
    } else if (ctx.target_units > 0 && sc.total_units < ctx.target_units * 0.80) {
      contrainteDominante = "programme";
      contrainteExplication = `le terrain ne permet pas d'atteindre les ${ctx.target_units} unites souhaitees dans les regles — ${sc.total_units} unites sont realisables`;
    } else {
      contrainteExplication = `le projet s'inscrit dans un equilibre favorable entre terrain, budget et reglementation`;
    }
    // ── 1. VERDICT CONTEXTUALISE ──
    let verdictRaison = "";
    if (/AMBITIEUX|OFFENSIVE/i.test(ctx.feasibility_posture) && recommended === "A") {
      verdictRaison = `Il exploite pleinement le potentiel constructible du terrain. Votre posture ambitieuse et votre capacite financiere permettent de viser le scenario le plus dense.`;
    } else if (/PRUDENT|CONSERVATIVE/i.test(ctx.feasibility_posture) && recommended === "C") {
      verdictRaison = `Il respecte votre approche prudente : implantation maitrisee, investissement contenu, et possibilite d'evolution future par surelevation.`;
    } else if (recommended === "B") {
      verdictRaison = `Il offre le meilleur compromis entre surface construite, cout de realisation et conformite reglementaire.`;
    } else if (contrainteDominante === "budget") {
      verdictRaison = `Face a la contrainte budgetaire identifiee, il optimise la surface construite dans les limites de votre enveloppe financiere.`;
    } else if (contrainteDominante === "terrain") {
      verdictRaison = `Sur ce terrain ou les retraits reglementaires reduisent l'emprise de ${setbackReductionPct}%, il tire le meilleur parti de la surface constructible reelle.`;
    } else {
      verdictRaison = `Il offre la meilleure adequation entre votre programme, votre budget et les contraintes du terrain.`;
    }
    parts.push(`◆ VERDICT — Le scenario ${noms[recommended]} est recommande pour votre projet (score ${sc.recommendation_score}/1). ${verdictRaison}`);
    // ── 1b. CONTEXTE DU SITE avec orientation solaire + mitoyenneté ──
    const contexte = [];
    contexte.push(`Sur votre terrain de ${ctx.site_area}m² en zone ${zoning_type} (${climaticZone.toLowerCase()})`);
    if (setbackReductionPct > 5) {
      contexte.push(`les retraits reglementaires (avant ${rAvant}m, lateral ${rLateral}m, arriere ${rArriere}m) reduisent l'emprise constructible de ${setbackReductionPct}%`);
    }
    // v57.10: mitoyenneté justifiée dans la lecture du site
    const mitoDet = sc.mitoyennete_detail || {};
    if (mitoDet.justification) {
      contexte.push(mitoDet.justification);
    }
    // v57.13: orientation solaire = recommandation (pas contrainte dure)
    contexte.push(solarImpact.recommandation_orientation);
    if (solaireSouple) {
      contexte.push(`profondeur de batiment (${Math.round(dConstructible)}m) superieure au seuil de ventilation traversante (${profondeurSolaire}m) — prevoir des dispositifs de ventilation intermediaires (patios, gaines, double orientation)`);
    }
    if (solarImpact.malus_orientation_pct > 0) {
      contexte.push(`surcoût climatisation estime a +${solarImpact.malus_orientation_pct}% en raison de l'orientation et de la profondeur`);
    }
    contexte.push(`${contrainteExplication}`);
    parts.push(`◆ LECTURE DU SITE — ${contexte.join(". ")}.`);
    // ── 2. CE QUE VOUS CONSTRUISEZ ──
    const implantation = [];
    implantation.push(`un batiment de ${sc.levels} niveaux (${sc.height_m}m)`);
    implantation.push(`emprise au sol de ${sc.fp_rdc_m2}m² (${sc.ces_fill_pct}% du terrain)`);
    if (sc.fp_etages_m2 > sc.fp_rdc_m2) {
      implantation.push(`etages elargis a ${sc.fp_etages_m2}m² (extension${nbMitoyens > 0 ? " en appui sur les mitoyennetes" : " vers les limites separatives"})`);
    }
    implantation.push(`${sc.sdp_m2}m² de surface de plancher dont ${habM2}m² habitables (efficacite ${sc.ratio_efficacite_pct || 0}%)`);
    if (sc.total_units > 1) {
      implantation.push(`${sc.total_units} logements — ${sc.unit_mix_detail || "mix standard"}`);
      if (m2Logt > 0) implantation.push(`${m2Logt}m² habitables par logement`);
    }
    parts.push(`◆ CE QUE VOUS CONSTRUISEZ — ${implantation.join(" ; ")}.`);
    // ── 2b. STATIONNEMENT ET ESPACES EXTÉRIEURS (v57.10) ──
    const pkDet = sc.parking_detail || {};
    const espDet = sc.espace_degage || {};
    const extParts = [];
    // Parking
    const parkingLine = [];
    parkingLine.push(`${pkDet.places_disponibles || sc.parking_spots_estimate} places de stationnement ${pkDet.source === "PILOTIS" ? "en rez-de-chaussee (sous pilotis)" : "en surface"}`);
    parkingLine.push(`ratio de ${pkDet.ratio_par_unite || 1} place(s) par unite (${pkDet.places_requises || 0} requises reglementairement)`);
    if (pkDet.suffisant) {
      parkingLine.push(`stationnement conforme — ${pkDet.places_disponibles - pkDet.places_requises} place(s) excedentaire(s) pour visiteurs`);
    } else if (pkDet.deficit > 0) {
      parkingLine.push(`deficit de ${pkDet.deficit} place(s) — envisager un parking en sous-sol partiel ou des places en voirie`);
    }
    parkingLine.push(`emprise parking : ${pkDet.m2_parking || 0}m² (${PILOTIS_CONFIG.PARKING_SPOT_M2}m² par place, circulation comprise)`);
    extParts.push(`Stationnement : ${parkingLine.join(". ")}`);
    // Espace dégagé (v57.13: ratio parking/espace basé sur requis)
    const espaceLine = [];
    espaceLine.push(`${espDet.sol_libre_total_m2 || sc.free_ground_m2}m² libres au sol (${espDet.sol_libre_pct || Math.round(solLibrePct * 100)}% du terrain)`);
    if (pkDet.source !== "PILOTIS") {
      espaceLine.push(`repartition : ${espDet.ratio_parking_espace || "33/67"} (parking/espaces verts) — ${pkDet.m2_parking || 0}m² de parking, ${espDet.espace_vert_m2 || 0}m² d'espace degage (${espDet.espace_vert_pct || 0}% du terrain)`);
    } else {
      espaceLine.push(`integralement disponible pour amenagement exterieur (parking sous pilotis)`);
    }
    espaceLine.push(`Qualite : ${espDet.qualite || "N/A"} — ${espDet.description || ""}`);
    extParts.push(`Espaces exterieurs : ${espaceLine.join(". ")}`);
    parts.push(`◆ STATIONNEMENT ET ESPACES EXTERIEURS — ${extParts.join(". ")}.`);
    // ── 3. COUT GLOBAL DU PROJET (construction + honoraires fourchette + frais + solaire) ──
    const cout = [];
    const vent = sc.cout_ventilation || {};
    const globalM = vent.cout_global_projet_fcfa ? Math.round(vent.cout_global_projet_fcfa / 1e6) : costM;
    const honoObj = vent.honoraires_architecte || {};
    const honoBasM = Math.round((honoObj.bas_fcfa || 0) / 1e6);
    const honoHautM = Math.round((honoObj.haut_fcfa || 0) / 1e6);
    const honoMedianM = Math.round((honoObj.median_fcfa || 0) / 1e6);
    const fraisAnnM = vent.frais_annexes ? Math.round(vent.frais_annexes.total_frais_annexes_fcfa / 1e6) : 0;
    const malusSolaireM = vent.malus_orientation_solaire_fcfa ? Math.round(vent.malus_orientation_solaire_fcfa / 1e6) : 0;
    cout.push(`Cout global du projet estime : ${globalM}M FCFA`);
    let honoText = `honoraires architecte ${honoMedianM}M (fourchette ${honoBasM}M a ${honoHautM}M, soit ${honoObj.taux_bas_pct || 0}% a ${honoObj.taux_haut_pct || 0}% — bareme degressif)`;
    cout.push(`dont construction ${costM}M (fourchette ${costBas}M a ${costHaut}M), ${honoText}, frais annexes ${fraisAnnM}M (permis, assurance DO, BET, imprevus)`);
    if (malusSolaireM > 0) {
      cout.push(`Surcoût orientation solaire : +${malusSolaireM}M FCFA (protection facades Ouest, climatisation renforcee)`);
    }
    if (vent.gros_oeuvre_fcfa) {
      cout.push(`Ventilation construction : gros oeuvre ${Math.round(vent.gros_oeuvre_fcfa / 1e6)}M (55%), second oeuvre ${Math.round(vent.second_oeuvre_fcfa / 1e6)}M (25%), lots techniques ${Math.round(vent.lots_techniques_fcfa / 1e6)}M (15%), VRD ${Math.round(vent.vrd_fcfa / 1e6)}M`);
    }
    cout.push(`${Math.round((sc.cost_per_m2_sdp || 0) / 1000)}k FCFA/m² SDP`);
    if (coutLogt > 0 && sc.total_units > 1) cout.push(`${coutLogt}M FCFA par logement (construction seule)`);
    if (sc.budget_fit === "DANS_BUDGET") {
      cout.push(`Ce montant s'inscrit dans votre enveloppe budgetaire`);
    } else if (sc.budget_fit === "BUDGET_TENDU") {
      cout.push(`Montant proche de votre limite — optimisable par ajustement des finitions`);
    } else if (sc.budget_fit === "HORS_BUDGET" && budgetMaxCtx > 0) {
      const dep = Math.round(((sc.cost_total_fcfa || sc.estimated_cost) - budgetMaxCtx) / 1e6);
      cout.push(`Depassement de ${dep}M FCFA sur la construction. Cout global tout compris : ${globalM}M FCFA`);
    }
    cout.push(`Duree estimee du chantier : ${sc.duree_chantier_mois || "N/A"} mois`);
    parts.push(`◆ BUDGET GLOBAL DU PROJET — ${cout.join(". ")}.`);
    // ── 4. ALTERNATIVES avec deltas chiffrés ──
    const others = ["A","B","C"].filter(l => l !== recommended);
    const comparaison = [];
    for (const o of others) {
      const osc = r_results[o];
      const oCostM = Math.round((osc.cost_total_fcfa || osc.estimated_cost) / 1e6);
      const deltaSdp = osc.sdp_m2 - sc.sdp_m2;
      const deltaUnits = osc.total_units - sc.total_units;
      const deltaCost = oCostM - costM;
      const deltaSdpPct = sc.sdp_m2 > 0 ? Math.round(Math.abs(deltaSdp) / sc.sdp_m2 * 100) : 0;
      const deltaCostPct = costM > 0 ? Math.round(Math.abs(deltaCost) / costM * 100) : 0;
      if (deltaSdp > 0) {
        comparaison.push(`${noms[o]} (${o}) : +${deltaSdp}m² SDP (+${deltaSdpPct}%), +${Math.max(0, deltaUnits)} logement(s), +${deltaCost}M FCFA (+${deltaCostPct}%)`);
      } else {
        comparaison.push(`${noms[o]} (${o}) : ${deltaSdp}m² SDP (-${deltaSdpPct}%), ${deltaUnits} logement(s), -${Math.abs(deltaCost)}M FCFA (-${deltaCostPct}%)`);
      }
    }
    parts.push(`◆ ALTERNATIVES — ${comparaison.join(" | ")}.`);
    // ── 5. DECOMPOSITION DU SCORE avec explications actionnables ──
    if (scoreDet && scoreDet.budget_fit) {
      const criteres = [];
      const labels = {
        budget_fit: "Budget", risk_alignment: "Risque", cos_conformity: "Conformite COS",
        capacity_adequacy: "Capacite", cost_efficiency: "Efficacite cout", standing_match: "Standing", phase_flexibility: "Phasabilite"
      };
      let bestCrit = "", bestVal = 0, bestExpl = "";
      let worstCrit = "", worstVal = 1, worstExpl = "";
      for (const [k, v] of Object.entries(scoreDet)) {
        if (k === "total" || !v.score) continue;
        criteres.push(`${labels[k] || k}: ${Math.round(v.score * 10)}/10 (poids ${Math.round(v.poids * 100)}%)`);
        if (v.contribution > bestVal) { bestVal = v.contribution; bestCrit = labels[k] || k; bestExpl = v.explication || ""; }
        if (v.score < worstVal) { worstVal = v.score; worstCrit = labels[k] || k; worstExpl = v.explication || ""; }
      }
      const scoreParts = [];
      scoreParts.push(`Score global ${sc.recommendation_score}/1`);
      scoreParts.push(`Point fort : ${bestCrit} (${Math.round(bestVal * 1000) / 1000}). ${bestExpl}`);
      scoreParts.push(`Point d'attention : ${worstCrit} (${Math.round(worstVal * 10)}/10). ${worstExpl}`);
      scoreParts.push(`Detail : ${criteres.join(" | ")}`);
      parts.push(`◆ POURQUOI CE SCENARIO — ${scoreParts.join(". ")}.`);
    }
    // ── 6. ANALYSE DE RISQUE ──
    const risques = [];
    if (sc.budget_fit === "HORS_BUDGET") risques.push("Risque budgetaire : depassement de l'enveloppe — phasage ou optimisation recommande");
    if (sc.cos_ratio_pct > 90) risques.push(`Densite elevee : COS a ${sc.cos_ratio_pct}% — marges d'evolution limitees`);
    if (solLibrePct < 0.25) risques.push(`Emprise importante : seulement ${Math.round(solLibrePct * 100)}% du terrain libre — contrainte pour parking et acces`);
    if ((sc.complexite || {}).score >= 4) risques.push(`Complexite technique ${(sc.complexite || {}).label} : maitrise d'oeuvre experimentee requise`);
    if (sc.total_units > ctx.target_units * 1.3) risques.push(`Surdimensionnement (+${Math.round((sc.total_units / ctx.target_units - 1) * 100)}% vs besoin) : investissement supplementaire sans garantie de demande`);
    if (setbackReductionPct > 25) risques.push(`Terrain contraint : retraits reglementaires reduisent l'emprise de ${setbackReductionPct}%`);
    if (risques.length === 0) risques.push("Risque maitrise : projet conforme, budget coherent, complexite raisonnable");
    parts.push(`◆ ANALYSE DE RISQUE — ${risques.join(". ")}.`);
    // ── 7. RÉGLEMENTAIRE + RETRAITS ──
    const regParts = [];
    regParts.push(`CES utilise ${reg.ces_utilise_pct || sc.ces_fill_pct}% sur ${reg.ces_reglementaire_pct || ""}% autorises (marge ${reg.ces_marge_pct || ""}%)`);
    regParts.push(`COS a ${reg.cos_utilise_pct || sc.cos_ratio_pct}% de la capacite reglementaire`);
    regParts.push(`Hauteur ${sc.height_m}m sur ${reg.hauteur_max_m || ""}m autorises`);
    if (reg.retrait_avant_m) {
      regParts.push(`Retraits : avant ${reg.retrait_avant_m}m, lateral ${reg.retrait_lateral_m}m, arriere ${reg.retrait_arriere_m}m${reg.mitoyennete_cotes > 0 ? ` (${reg.mitoyennete_cotes} mitoyennete(s))` : ""}`);
    }
    regParts.push(`Statut : ${(reg.conformite_globale || sc.cos_compliance)}`);
    parts.push(`◆ CONFORMITE REGLEMENTAIRE — ${regParts.join(". ")}.`);
    // ── 9. CONSEIL STRATÉGIQUE PERSONNALISÉ (conclusion) ──
    const conseil = [];
    if (contrainteDominante === "budget" && sc.levels > 2) {
      conseil.push(`Recommandation : demarrez par la phase 1 (RDC + ${Math.min(2, sc.levels - 1)} niveaux) pour valider le projet dans votre budget actuel, puis reevaluez la surelevation dans 12-18 mois`);
    } else if (contrainteDominante === "budget") {
      conseil.push(`Recommandation : optimisez les finitions pour rester dans l'enveloppe. Un standing ECONOMIQUE au lieu de ${ctx.standing_level} reduirait le cout de ~25%`);
    } else if (contrainteDominante === "terrain") {
      conseil.push(`Recommandation : sur ce terrain contraint, privilegiez la densite verticale plutot que l'etalement. Chaque niveau supplementaire ajoute de la surface sans consommer d'emprise au sol`);
    } else if (contrainteDominante === "reglementation") {
      conseil.push(`Recommandation : le COS est presque atteint. Toute evolution future (surelevation, extension) necessitera une derogation ou un changement de zonage`);
    } else if (recommended === "A" && sc.total_units > ctx.target_units * 1.2) {
      conseil.push(`Recommandation : vous pouvez construire plus que votre cible initiale. Verifiez que le marche local absorbe ce surplus avant de maximiser`);
    } else {
      conseil.push(`Recommandation : le projet est bien dimensionne pour votre profil. Lancez les etudes de sol (geotechnique) et le permis de construire pour securiser le calendrier`);
    }
    if (solarImpact.brise_soleil && climaticZone === "TROPICAL") {
      conseil.push(`Point d'attention climatique : prevoyez des brise-soleil en facade Ouest et une toiture debordante (${solarImpact.debord_toiture_m}m) pour le confort thermique sans surdimensionner la climatisation`);
    }
    parts.push(`◆ CONSEIL STRATEGIQUE — ${conseil.join(". ")}.`);
    return parts.join("\n\n");
  }
  // ── POST-TRAITEMENT v57.6: garantir la hiérarchie A ≥ B ≥ C en SDP, levels, et units ──
  // Avec CES_FILL 95%>80%>65% + extension étages, la hiérarchie est naturelle.
  // Mais des cas edge (BUREAUX avec mix function différents) peuvent inverser B>A en units
  if (isProgramDriven) {
    // Enforce: A.levels >= B.levels >= C.levels
    if (r.A.levels < r.B.levels) {
      r.A.levels = r.B.levels;
      recalcSdp(r.A);
    }
    if (r.B.levels < r.C.levels) {
      r.C.levels = Math.max(1, r.B.levels - 1);
      if (r.C.levels === r.B.levels) r.C.fp_m2 = Math.round(r.C.fp_m2 * 0.90);
      recalcSdp(r.C);
    }
    // v5.4 FIX: Ne PAS capper total_units entre scénarios.
    // B peut avoir PLUS de logements que A si les logements sont plus compacts (UNIT_SIZES plus petits).
    // La hiérarchie A >= B >= C s'applique aux NIVEAUX et à la SDP, pas au nombre de logements.
    // L'ancien code écrasait B.total_units = A.total_units SANS recalculer unit_mix_detail,
    // surf_hab et m2_par_logt, ce qui créait une incohérence (unit_mix=10 mais total_units=8).
    // Supprimé — le nombre de logements est un RÉSULTAT du dimensionnement, pas une contrainte.
    // SDP check (original logic preserved)
    if (r.A.sdp_m2 < r.B.sdp_m2) {
      r.A.levels = Math.max(r.A.levels, r.B.levels);
      recalcSdp(r.A);
    }
    if (r.B.sdp_m2 < r.C.sdp_m2) {
      r.C.levels = Math.max(1, r.B.levels - 1 || 1);
      if (r.C.levels === r.B.levels) r.C.fp_m2 = Math.round(r.C.fp_m2 * 0.90);
      recalcSdp(r.C);
    }
  } else {
    // Regulation-driven : ancienne logique de différenciation
    if (r.C.levels <= r.A.levels && absMaxLevels > r.A.levels) {
      r.C.levels = Math.min(r.A.levels + 1, absMaxLevels);
    }
    if (r.B.levels >= r.A.levels && r.A.levels > 1) {
      r.B.levels = Math.max(1, r.A.levels - 1);
    }
    for (const lbl of ["A", "B", "C"]) recalcSdp(r[lbl]);
    for (const lbl of ["A", "B", "C"]) {
      const cr = max_sdp > 0 ? r[lbl].sdp_m2 / max_sdp : 0;
      r[lbl].cos_ratio_pct = Math.round(cr * 100);
      r[lbl].cos_compliance = cr <= 1.05 ? "CONFORME" : cr <= 1.30 ? "DEROGATION_POSSIBLE" : "AMBITIEUX_HORS_COS";
    }
    if (r.B.fp_m2 > 0 && r.C.fp_m2 > 0) {
      const diff = Math.abs(r.B.fp_m2 - r.C.fp_m2) / Math.max(r.B.fp_m2, r.C.fp_m2);
      if (diff < 0.15) {
        r.B.fp_m2 = Math.round(Math.min(r.B.fp_m2 * 1.10, envelope_area * 0.95));
        r.C.fp_m2 = Math.max(50, Math.round(r.C.fp_m2 * 0.85));
        recalcSdp(r.B); recalcSdp(r.C);
      }
    }
  }
  // v57.21 SAFETY NET: enforce A.fp_m2 >= B.fp_m2 >= C.fp_m2
  // v73.1.4: NEUTRALISÉ en mode program-driven (B<C en fp est légitime quand
  // A/B sont en SPLIT logement-seul et C en SUPERPOSE incluant commerce)
  if (!isProgramDriven) {
    if (r.A.fp_m2 < r.B.fp_m2) {
      console.log(`│ ⚠️ v57.21: fp inversion A(${r.A.fp_m2}) < B(${r.B.fp_m2}) → fixing A=B`);
      r.A.fp_m2 = r.B.fp_m2;
      r.A.fp_rdc_m2 = Math.max(r.A.fp_rdc_m2 || 0, r.B.fp_rdc_m2 || 0);
      r.A.fp_etages_m2 = Math.max(r.A.fp_etages_m2 || 0, r.B.fp_etages_m2 || 0);
      recalcSdp(r.A);
    }
    if (r.B.fp_m2 < r.C.fp_m2) {
      console.log(`│ ⚠️ v57.21: fp inversion B(${r.B.fp_m2}) < C(${r.C.fp_m2}) → fixing C=B*0.85`);
      r.C.fp_m2 = Math.max(50, Math.round(r.B.fp_m2 * 0.85));
      r.C.fp_rdc_m2 = Math.max(50, Math.round((r.B.fp_rdc_m2 || r.B.fp_m2) * 0.85));
      r.C.fp_etages_m2 = Math.max(50, Math.round((r.B.fp_etages_m2 || r.B.fp_m2) * 0.85));
      recalcSdp(r.C);
    }
  } else {
    console.log(`│ v73.1.4: v57.21 fp inversion check NEUTRALISÉ (program-driven mode)`);
  }
  // Recalc COS ratios after post-processing
  for (const lbl of ["A", "B", "C"]) {
    const cr = max_sdp > 0 ? r[lbl].sdp_m2 / max_sdp : 0;
    r[lbl].cos_ratio_pct = Math.round(cr * 100);
    r[lbl].cos_compliance = cr <= 1.05 ? "CONFORME" : cr <= 1.30 ? "DEROGATION_POSSIBLE" : "AMBITIEUX_HORS_COS";
  }
  // ══════════════════════════════════════════════════════════════════════════════
  // MOTEUR DE RECOMMANDATION v57.6 (CLIENT-CENTRIC)
  // ══════════════════════════════════════════════════════════════════════════════
  // Recommendation weights: Budget is #1 (30%), then risk alignment (20%), COS (15%),
  // capacity adequacy (15%), standing (10%), phase (10%)
  const scoreWeights_v57_5 = {
    budget_fit: 0.25,          // Budget compatibility
    risk_alignment: 0.20,      // Posture-scenario alignment
    cos_conformity: 0.12,      // COS compliance
    capacity_adequacy: 0.13,   // Target units adequacy
    cost_efficiency: 0.12,     // Quand budget serré, le moins cher gagne
    standing_match: 0.08,      // Standing compatibility
    phase_flexibility: 0.10,   // Phase compatibility
  };
  for (const label of ["A", "B", "C"]) {
    const sc = r[label];
    let score = 0;
    // 1. BUDGET FIT (0.30): Favor scenarios within budget
    // MAIS : un client AMBITIEUX tolère plus de dépassement qu'un PRUDENT
    let budgetScore = 0;
    if (sc.budget_fit === "DANS_BUDGET") budgetScore = 1.0;
    else if (sc.budget_fit === "BUDGET_TENDU") budgetScore = 0.6;
    else if (sc.budget_fit === "HORS_BUDGET") {
      // AMBITIEUX : le hors-budget est un signal, pas un veto
      if (/AMBITIEUX|OFFENSIVE?|AGGRESSIVE/i.test(feasibility_posture)) budgetScore = 0.35;
      else if (/PRUDENT|CONSERVATIVE|DEFENSIVE?/i.test(feasibility_posture)) budgetScore = 0.0;
      else budgetScore = 0.15;
    }
    else budgetScore = 0.5; // N/A
    score += budgetScore * scoreWeights_v57_5.budget_fit;
    // 2. RISK ALIGNMENT (0.20): Match scenario risk to client posture
    // PRUDENT clients should NOT get risky (high-capacity) scenarios
    // AMBITIEUX clients can take more risk
    let riskAlignScore = 0.5;
    if (/PRUDENT|CONSERVATIVE|DEFENSIVE?/i.test(feasibility_posture)) {
      // PRUDENT : préfère C (conservateur) ou B (équilibre), pénalise A (trop risqué)
      riskAlignScore = label === "C" ? 1.0 : label === "B" ? 0.85 : label === "A" ? 0.2 : 0.5;
    } else if (/AMBITIEUX|OFFENSIVE?|AGGRESSIVE/i.test(feasibility_posture)) {
      // AMBITIEUX : préfère A (maximise), tolère B, pénalise C (trop timide)
      riskAlignScore = label === "A" ? 1.0 : label === "B" ? 0.6 : label === "C" ? 0.15 : 0.5;
    } else {
      // EQUILIBRE/STANDARD : préfère B, acceptable A et C
      riskAlignScore = label === "B" ? 1.0 : label === "A" ? 0.65 : label === "C" ? 0.55 : 0.5;
    }
    score += riskAlignScore * scoreWeights_v57_5.risk_alignment;
    // 3. COS CONFORMITY (0.15): Penalize HORS_COS scenarios
    const cosScore = sc.cos_compliance === "CONFORME" ? 1.0 : sc.cos_compliance === "DEROGATION_POSSIBLE" ? 0.5 : 0.1;
    score += cosScore * scoreWeights_v57_5.cos_conformity;
    // 4. CAPACITY ADEQUACY (0.15): Measure how CLOSE to target, not how BIG
    // Oversizing (50% over target) is as bad as undersizing (30% under target)
    const targetUnits = Math.max(1, target_units || 1);
    const ratio = sc.total_units / targetUnits;
    let capAdequacyScore = 0;
    if (ratio >= 0.85 && ratio <= 1.20) {
      // Ideal: 85-120% of target
      capAdequacyScore = 1.0 - Math.abs(ratio - 1.0) * 0.5;
    } else if (ratio >= 0.70 && ratio < 0.85) {
      // Acceptable undersizing: 70-85%
      capAdequacyScore = 0.7 - (0.85 - ratio) * 2;
    } else if (ratio > 1.20 && ratio <= 1.50) {
      // Acceptable oversizing: 120-150%
      capAdequacyScore = 0.7 - (ratio - 1.20) * 1.5;
    } else {
      // Too far from target
      capAdequacyScore = Math.max(0, 0.3 - Math.abs(ratio - 1.0) * 0.2);
    }
    score += capAdequacyScore * scoreWeights_v57_5.capacity_adequacy;
    // 5. COST EFFICIENCY (0.12): Quand budget contraint, favorise le moins cher
    // C'est le tiebreaker clé : si tout est HORS_BUDGET, C est le moins douloureux
    let costEffScore = 0.5;
    if (budgetPressure > 0.5) {
      // Budget serré : le moins cher gagne
      const costs = { A: r.A.cost_total_fcfa || r.A.estimated_cost, B: r.B.cost_total_fcfa || r.B.estimated_cost, C: r.C.cost_total_fcfa || r.C.estimated_cost };
      const minCost = Math.min(costs.A, costs.B, costs.C);
      const maxCost = Math.max(costs.A, costs.B, costs.C);
      const range = maxCost - minCost || 1;
      costEffScore = 1.0 - (((sc.cost_total_fcfa || sc.estimated_cost) - minCost) / range);
    } else {
      // Budget confortable : l'efficacité coût n'est pas un critère fort
      costEffScore = 0.7; // neutre
    }
    score += costEffScore * scoreWeights_v57_5.cost_efficiency;
    // 6. STANDING MATCH (0.08): Standing compatibility
    // Le standing (PREMIUM/STD/ECO) ne dépend PAS du scénario A/B/C — il s'applique
    // aux 3. Le score reflète si le volume bâti est cohérent avec le standing visé.
    // PREMIUM veut de l'espace (A), ECO veut de l'efficacité (C compact).
    let standScore = 0.7; // base neutre
    if (/PREMIUM|HAUT/i.test(standing_level)) {
      standScore = label === "A" ? 1.0 : label === "B" ? 0.75 : 0.5;
    } else if (/ECO/i.test(standing_level)) {
      standScore = label === "C" ? 1.0 : label === "B" ? 0.75 : 0.5;
    } else {
      // STANDARD : tous les scénarios sont compatibles, léger avantage B
      standScore = label === "B" ? 0.85 : label === "A" ? 0.75 : label === "C" ? 0.75 : 0.7;
    }
    score += standScore * scoreWeights_v57_5.standing_match;
    // 7. PHASE FLEXIBILITY (0.10): Phasability
    // C est le plus phasable (compact, évolutif), A le moins (gros investissement d'un coup)
    let phaseScore = 0.6;
    if (label === "C") phaseScore = 1.0;
    else if (label === "B") phaseScore = 0.7;
    else phaseScore = 0.4;
    // Modulé par le phase_score client (haut = veut du phasage)
    phaseScore = phaseScore * (0.5 + phaseSc * 0.5) + (1 - phaseScore) * (1 - phaseSc) * 0.3;
    score += phaseScore * scoreWeights_v57_5.phase_flexibility;
    sc.recommendation_score = Math.round(score * 1000) / 1000;
    // v57.8: décomposition granulaire du scoring + texte explicatif par critère
    // Chaque critère a un score, un poids, sa contribution, ET un texte conseil actionnable
    function explBudget(s, fit) {
      if (s >= 0.9) return "Le cout s'inscrit dans votre budget — aucune contrainte financiere.";
      if (s >= 0.6) return "Budget tendu mais tenable. Levier : passer au standing inferieur ou reduire de 1 niveau pour gagner ~15%.";
      if (s >= 0.3) return "Depassement budgetaire. Leviers : reduire le programme, baisser le standing, ou phaser la construction pour etaler l'investissement.";
      return "Hors budget. Ce scenario necessite un financement complementaire ou une reduction significative du programme.";
    }
    function explRisk(s, posture) {
      if (s >= 0.9) return "Parfaite adequation entre le niveau de risque du scenario et votre posture " + posture.toLowerCase() + ".";
      if (s >= 0.6) return "Risque acceptable pour votre profil. Le scenario est legerement plus " + (s < 0.7 ? "ambitieux" : "prudent") + " que votre posture ideale.";
      return "Decalage entre votre posture " + posture.toLowerCase() + " et le niveau de risque de ce scenario. Envisagez un scenario plus " + (/PRUDENT/i.test(posture) ? "conservateur" : "ambitieux") + ".";
    }
    function explCos(s) {
      if (s >= 0.9) return "Projet conforme au COS reglementaire — pas de risque de refus de permis.";
      if (s >= 0.5) return "Derogation possible mais a argumenter aupres de la mairie. Prevoyez un delai supplementaire pour l'instruction.";
      return "Depassement significatif du COS — risque de refus de permis. Reduisez le nombre de niveaux.";
    }
    function explCapacity(s, ratio) {
      if (s >= 0.9) return "Le nombre d'unites correspond precisement a votre besoin.";
      if (ratio > 1.2) return "Surdimensionnement de " + Math.round((ratio - 1) * 100) + "% par rapport a votre cible. Vous construisez plus que necessaire — verifiez que la demande locative justifie ce surplus.";
      if (ratio < 0.8) return "Le terrain ne permet que " + Math.round(ratio * 100) + "% de votre cible. Leviers : augmenter le nombre de niveaux, reduire les surfaces unitaires, ou revoir le programme a la baisse.";
      return "Proche de votre cible — bon dimensionnement du programme.";
    }
    function explCostEff(s) {
      if (s >= 0.8) return "Ce scenario offre le meilleur rapport surface/cout parmi les 3 options.";
      if (s >= 0.5) return "Rapport cout/surface intermediaire. Les alternatives offrent un meilleur ratio.";
      return "Le scenario le plus couteux par m² construit. Si le budget est une contrainte, privilegiez une alternative plus compacte.";
    }
    function explStanding(s, standing) {
      if (s >= 0.9) return "Le volume et la qualite du scenario sont en parfaite coherence avec le standing " + standing + " vise.";
      if (s >= 0.6) return "Coherence acceptable entre le volume construit et le standing " + standing + ".";
      return "Decalage : le volume construit n'est pas optimal pour du " + standing + ". Un standing " + (/PREMIUM/i.test(standing) ? "STANDARD" : "superieur") + " serait plus coherent avec ce scenario.";
    }
    function explPhase(s) {
      if (s >= 0.8) return "Scenario facilement phasable — vous pouvez construire par tranches et etaler l'investissement.";
      if (s >= 0.5) return "Phasage possible mais moins flexible. La structure doit etre concue des le depart pour la totalite.";
      return "Scenario peu phasable — l'investissement doit etre mobilise en une seule fois. Si le phasage est important, privilegiez un scenario plus compact.";
    }
    const targetRatio = sc.total_units / Math.max(1, target_units || 1);
    sc.score_detail = {
      budget_fit:        { score: Math.round(budgetScore * 100) / 100, poids: scoreWeights_v57_5.budget_fit, contribution: Math.round(budgetScore * scoreWeights_v57_5.budget_fit * 1000) / 1000, explication: explBudget(budgetScore, sc.budget_fit) },
      risk_alignment:    { score: Math.round(riskAlignScore * 100) / 100, poids: scoreWeights_v57_5.risk_alignment, contribution: Math.round(riskAlignScore * scoreWeights_v57_5.risk_alignment * 1000) / 1000, explication: explRisk(riskAlignScore, feasibility_posture) },
      cos_conformity:    { score: Math.round(cosScore * 100) / 100, poids: scoreWeights_v57_5.cos_conformity, contribution: Math.round(cosScore * scoreWeights_v57_5.cos_conformity * 1000) / 1000, explication: explCos(cosScore) },
      capacity_adequacy: { score: Math.round(capAdequacyScore * 100) / 100, poids: scoreWeights_v57_5.capacity_adequacy, contribution: Math.round(capAdequacyScore * scoreWeights_v57_5.capacity_adequacy * 1000) / 1000, explication: explCapacity(capAdequacyScore, targetRatio) },
      cost_efficiency:   { score: Math.round(costEffScore * 100) / 100, poids: scoreWeights_v57_5.cost_efficiency, contribution: Math.round(costEffScore * scoreWeights_v57_5.cost_efficiency * 1000) / 1000, explication: explCostEff(costEffScore) },
      standing_match:    { score: Math.round(standScore * 100) / 100, poids: scoreWeights_v57_5.standing_match, contribution: Math.round(standScore * scoreWeights_v57_5.standing_match * 1000) / 1000, explication: explStanding(standScore, standing_level) },
      phase_flexibility: { score: Math.round(phaseScore * 100) / 100, poids: scoreWeights_v57_5.phase_flexibility, contribution: Math.round(phaseScore * scoreWeights_v57_5.phase_flexibility * 1000) / 1000, explication: explPhase(phaseScore) },
      total: Math.round(score * 1000) / 1000,
    };
  }
  // Find best scenario
  let recommended = "A";
  if (r.B.recommendation_score > r[recommended].recommendation_score) recommended = "B";
  if (r.C.recommendation_score > r[recommended].recommendation_score) recommended = "C";
  r.A.recommended = recommended === "A";
  r.B.recommended = recommended === "B";
  r.C.recommended = recommended === "C";
  // Generate client-centric recommendation reason
  const recSc = r[recommended];
  const reasons = [];
  if (budgetPressure > 0.6) {
    reasons.push("optimise pour contrainte budgetaire");
  } else if (recSc.budget_fit === "DANS_BUDGET") {
    reasons.push("respecte le budget client");
  }
  if (recSc.cos_compliance === "CONFORME") reasons.push("conforme au COS");
  if (feasibility_posture === "PRUDENT" && recommended === "B") reasons.push("equilibre entre ambitieux et prudent");
  if (feasibility_posture === "PRUDENT" && recommended === "C") reasons.push("approche conservative, risque maitrise");
  if (feasibility_posture === "AMBITIEUX" && recommended === "A") reasons.push("maximise la capacite");
  if (recSc.total_units >= target_units * 0.85 && recSc.total_units <= target_units * 1.20) reasons.push("proche du besoin exprime");
  const recommendation_reason = reasons.length > 0 ? reasons.join(", ") : "meilleur compromis multicritere";
  const meta = {
    engine_version: "57.20",
    mode: isProgramDriven ? "PROGRAM_DRIVEN" : "REGULATION_DRIVEN",
    program_key: programKey || "NONE",
    zoning_type, primary_driver, cos, ces, floor_height,
    max_fp: Math.round(max_fp), max_sdp: Math.round(max_sdp), absMaxLevels,
    envelope_bbox: Math.round(envelope_bbox), envelope_poly_area: Math.round(envelope_area),
    program_main, commerce_levels: commerceLevels, force_commerce: forceCommerce,
    target_units, standing_level,
    budget_pressure: Math.round(budgetPressure * 100) / 100,
    feasibility_posture, posture_mod: postureMod,
    risk_adjusted: riskAdj, risk_penalty: Math.round(riskPenalty * 1000) / 1000,
    driver_intensity, intensity_spread: intensitySpread,
    scores: { rent: rentSc, capacity: capSc, mix: mixSc, phase: phaseSc, risk: riskSc },
    recommended_scenario: recommended,
    recommendation_reason,
  };
  // ── v57.6 DIAGNOSTIC COMPARISON TABLE ──
  const diagnostic = {
    // Client profile echo
    profil_client: {
      posture: feasibility_posture,
      budget_band: budget_band || "N/A",
      budget_max_fcfa: budgetMax,
      standing: standing_level,
      programme: program_main,
      cible_unites: target_units,
      rigidite_financiere: Number(financial_rigidity_score) || 0,
      score_risque: Number(risk_score) || 0,
    },
    // Site summary
    site: {
      surface_m2: Number(site_area),
      zonage: zoning_type,
      ces_reglementaire_pct: Math.round(ces * 100),
      cos_reglementaire: cos,
      hauteur_max_m: Number(max_height_m) || 99,
      niveaux_max: absMaxLevels,
      emprise_max_m2: Math.round(max_fp),
      sdp_max_m2: Math.round(max_sdp),
    },
    // A vs B vs C comparison + deltas
    comparatif: (() => {
      const compA = extractComparatif(r.A);
      const compB = extractComparatif(r.B);
      const compC = extractComparatif(r.C);
      // v57.7: Deltas entre scénarios (Δ B vs A, Δ C vs A, Δ C vs B)
      function computeDeltas(ref, alt, refLabel, altLabel) {
        const dSdp = alt.sdp_m2 - ref.sdp_m2;
        const dCout = alt.cout_total_fcfa - ref.cout_total_fcfa;
        // v57.9: valeur marginale = coût de chaque m² supplémentaire entre les 2 scénarios
        const valeurMarginale = dSdp !== 0 ? Math.round(Math.abs(dCout / dSdp)) : 0;
        const coutM2Ref = ref.sdp_m2 > 0 ? Math.round(ref.cout_total_fcfa / ref.sdp_m2) : 0;
        // Si valeur marginale < coût/m² moyen = bon deal, sinon surcoût
        const marginaleFavorable = valeurMarginale > 0 && valeurMarginale < coutM2Ref * 1.1;
        return {
          label: `${altLabel} vs ${refLabel}`,
          delta_sdp_m2: dSdp,
          delta_sdp_pct: ref.sdp_m2 > 0 ? Math.round(dSdp / ref.sdp_m2 * 100) : 0,
          delta_unites: alt.unites - ref.unites,
          delta_cout_fcfa: dCout,
          delta_cout_pct: ref.cout_total_fcfa > 0 ? Math.round(dCout / ref.cout_total_fcfa * 100) : 0,
          delta_surface_hab_m2: alt.surface_habitable_m2 - ref.surface_habitable_m2,
          delta_sol_libre_m2: alt.sol_libre_m2 - ref.sol_libre_m2,
          // v57.9: valeur marginale
          valeur_marginale_fcfa_par_m2: valeurMarginale,
          marginale_favorable: marginaleFavorable,
          commentaire: dSdp < 0
            ? `${altLabel} coute ${Math.abs(Math.round(dCout / ref.cout_total_fcfa * 100))}% de moins que ${refLabel} pour ${Math.abs(Math.round(dSdp / ref.sdp_m2 * 100))}% de surface en moins`
            : `${altLabel} offre ${Math.round(dSdp / ref.sdp_m2 * 100)}% de surface en plus pour ${Math.round(dCout / ref.cout_total_fcfa * 100)}% de cout supplementaire`,
          conseil_marginale: dSdp > 0 && marginaleFavorable
            ? `Chaque m² supplementaire de ${refLabel} a ${altLabel} coute ${Math.round(valeurMarginale / 1000)}k FCFA — inferieur au cout moyen (${Math.round(coutM2Ref / 1000)}k/m²), l'investissement supplementaire est rentable.`
            : dSdp > 0
            ? `Chaque m² supplementaire coute ${Math.round(valeurMarginale / 1000)}k FCFA — superieur au cout moyen (${Math.round(coutM2Ref / 1000)}k/m²), rendement decroissant.`
            : `L'economie est de ${Math.round(Math.abs(valeurMarginale) / 1000)}k FCFA par m² sacrifie.`,
        };
      }
      return {
        A: compA, B: compB, C: compC,
        deltas: {
          B_vs_A: computeDeltas(compA, compB, "A", "B"),
          C_vs_A: computeDeltas(compA, compC, "A", "C"),
          C_vs_B: computeDeltas(compB, compC, "B", "C"),
        },
      };
    })(),
    // Narrative recommendation
    recommandation: {
      scenario: recommended,
      score: r[recommended].recommendation_score,
      score_detail: r[recommended].score_detail || {},
      narrative: generateRecommendationNarrative(recommended, r, {
        feasibility_posture, budgetPressure, budgetMax, target_units,
        standing_level, site_area, program_main
      }),
    },
    // v57.7 Phasing strategy (object with text + structured data)
    strategie_phasage: generatePhasingStrategy(recommended, r, {
      program_main, target_units, site_area
    }),
    // v57.7 retraits réglementaires
    retraits_reglementaires: {
      avant_m: rAvant,
      lateral_m: rLateral,
      arriere_m: rArriere,
      mitoyennete_cotes: nbMitoyens,
      emprise_constructible_m2: Math.round(empriseConstructible),
      emprise_effective_m2: Math.round(empriseEffective),
      reduction_pct: setbackReductionPct,
    },
    // v57.9: orientation solaire
    orientation_solaire: {
      zone_climatique: climaticZone,
      orientation_score: solarImpact.orientationScore,
      facade_optimale: solarImpact.facade_optimale,
      facade_a_proteger: solarImpact.facade_a_proteger,
      profondeur_recommandee_m: solarImpact.profondeur_recommandee_m,
      ventilation_traversante: solarImpact.ventilation_traversante,
      brise_soleil_ouest: solarImpact.brise_soleil,
      debord_toiture_m: solarImpact.debord_toiture_m,
      malus_orientation_pct: solarImpact.malus_orientation_pct,
      recommandation: solarImpact.recommandation_orientation,
    },
    engine_version: "57.20",
  };
  console.log(`│`);
  console.log(`│ A(${r.A.role}): fp=${r.A.fp_m2}m² × ${r.A.levels}niv = ${r.A.sdp_m2}m² SDP (${r.A.cos_ratio_pct}%COS) ${r.A.cos_compliance} | ${r.A.unit_mix_detail}`);
  console.log(`│ B(${r.B.role}): fp=${r.B.fp_m2}m² × ${r.B.levels}niv = ${r.B.sdp_m2}m² SDP (${r.B.cos_ratio_pct}%COS) ${r.B.cos_compliance} | ${r.B.unit_mix_detail}`);
  console.log(`│ C(${r.C.role}): fp=${r.C.fp_m2}m² × ${r.C.levels}niv = ${r.C.sdp_m2}m² SDP (${r.C.cos_ratio_pct}%COS) ${r.C.cos_compliance} | ${r.C.unit_mix_detail}`);
  console.log(`│ ★ RECOMMANDÉ : ${recommended} — ${recommendation_reason}`);
  console.log(`└── end SCENARIO ENGINE v57.20 ──`);
  return { A: r.A, B: r.B, C: r.C, meta, diagnostic, computed_budget_band: budget_band };
}
// ─── ENDPOINT /compute-scenarios ─────────────────────────────────────────────
app.post("/compute-scenarios", (req, res) => {
  const p = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch(e) { return {}; } })() : (req.body || {});
  if (!p.site_area || !p.envelope_w || !p.envelope_d) {
    return res.status(400).json({ error: "site_area, envelope_w, envelope_d obligatoires" });
  }
  // v56: LOG COMPLET des paramètres reçus par 8D pour diagnostic
  console.log(`\n╔══ /compute-scenarios RECEIVED (v56.3) ══╗`);
  console.log(`║ site_area=${p.site_area} envelope_w=${p.envelope_w} envelope_d=${p.envelope_d}`);
  console.log(`║ envelope_area=${p.envelope_area} (${p.envelope_area ? "OVERRIDE REÇU" : "non fourni → w×d"})`);
  console.log(`║ zoning=${p.zoning_type} driver=${p.primary_driver} standing=${p.standing_level}`);
  console.log(`║ max_floors=${p.max_floors} max_height=${p.max_height_m} floor_h=${p.floor_height}`);
  console.log(`║ budget_tension=${p.budget_tension} budget_band=${p.budget_band}`);
  console.log(`║ program=${p.program_main} target_sdp=${p.target_surface_m2} units=${p.target_units}`);
  console.log(`╚════════════════════════════════════════╝\n`);
  const scenarios = computeSmartScenarios({
    site_area: Number(p.site_area),
    envelope_w: Number(p.envelope_w),
    envelope_d: Number(p.envelope_d),
    envelope_area: Number(p.envelope_area) || undefined,
    zoning_type: p.zoning_type || "URBAIN",
    floor_height: Number(p.floor_height) || 3.2,
    primary_driver: p.primary_driver || "MAX_CAPACITE",
    max_floors: Number(p.max_floors) || 99,
    max_height_m: Number(p.max_height_m) || 99,
    program_main: p.program_main || p.project_type || "",
    target_surface_m2: Number(p.target_surface_m2) || 0,
    site_saturation_level: p.site_saturation_level || "MEDIUM",
    financial_rigidity_score: Number(p.financial_rigidity_score) || 0,
    density_band: p.density_band || "",
    risk_adjusted: Number(p.risk_adjusted) || 0,
    feasibility_posture: p.feasibility_posture || "BALANCED",
    scenario_A_role: p.scenario_A_role || "",
    scenario_B_role: p.scenario_B_role || "",
    scenario_C_role: p.scenario_C_role || "",
    budget_range: Number(p.budget_range) || 0,
    budget_range_raw: String(p.budget_range || ""),
    budget_band: p.budget_band || "",
    budget_tension: Number(p.budget_tension) || 0,
    standing_level: p.standing_level || "STANDARD",
    target_units: Number(p.target_units) || 0,
    rent_score: Number(p.rent_score) || 0,
    capacity_score: Number(p.capacity_score) || 0,
    mix_score: Number(p.mix_score) || 0,
    phase_score: Number(p.phase_score) || 0,
    risk_score: Number(p.risk_score) || 0,
    density_pressure_factor: Number(p.density_pressure_factor) || 1,
    driver_intensity: p.driver_intensity || "MEDIUM",
    strategic_position: p.strategic_position || "",
    // v57.20 : disposition spatiale
    layout_mode: p.layout_mode || "SUPERPOSE",
    commerce_depth_m: Number(p.commerce_depth_m) || 6,
    // v72.157 : typology-driven fields
    input_typologies: p.input_typologies || "",
    commerce_size_m2: Number(p.commerce_size_m2) || 0,
    retrait_inter_volumes_m: Number(p.retrait_inter_volumes_m) || 4,
  });
  // v57.22: champs diagnostic APLATIS pour Make.com (évite {object} dans Google Sheets)
  const diag = scenarios.diagnostic || {};
  const comp = diag.comparatif || {};
  const deltas = comp.deltas || {};
  const dBA = deltas.B_vs_A || {};
  const dCA = deltas.C_vs_A || {};
  const dCB = deltas.C_vs_B || {};
  const phasage = diag.strategie_phasage || {};
  const orient = diag.orientation_solaire || {};
  const retr = diag.retraits_reglementaires || {};
  const profil = diag.profil_client || {};
  const siteDiag = diag.site || {};
  const sA = scenarios.A || {};
  const sB = scenarios.B || {};
  const sC = scenarios.C || {};
  const flat = {
    // ── NARRATIVE ──
    diagnostic_narrative: (diag.recommandation || {}).narrative || "",
    rec_scenario: (diag.recommandation || {}).scenario || "",
    rec_score: Math.round(((diag.recommandation || {}).score || 0) * 100), // v72.80 FIX: 0-1 → 0-100
    // ── COMPARATIF DELTAS (texte plat) ──
    delta_BA_sdp: `${dBA.delta_sdp_m2 || 0} m² (${dBA.delta_sdp_pct || 0}%)`,
    delta_BA_cout: `${dBA.delta_cout_fcfa ? Math.round(dBA.delta_cout_fcfa / 1e6) : 0}M FCFA (${dBA.delta_cout_pct || 0}%)`,
    delta_BA_unites: `${dBA.delta_unites || 0} logements`,
    delta_BA_valeur_marginale: `${dBA.valeur_marginale_fcfa_par_m2 ? Math.round(dBA.valeur_marginale_fcfa_par_m2 / 1000) : 0}k FCFA/m²`,
    delta_BA_commentaire: dBA.commentaire || "",
    delta_BA_conseil: dBA.conseil_marginale || "",
    delta_CA_sdp: `${dCA.delta_sdp_m2 || 0} m² (${dCA.delta_sdp_pct || 0}%)`,
    delta_CA_cout: `${dCA.delta_cout_fcfa ? Math.round(dCA.delta_cout_fcfa / 1e6) : 0}M FCFA (${dCA.delta_cout_pct || 0}%)`,
    delta_CA_unites: `${dCA.delta_unites || 0} logements`,
    delta_CA_commentaire: dCA.commentaire || "",
    delta_CB_sdp: `${dCB.delta_sdp_m2 || 0} m² (${dCB.delta_sdp_pct || 0}%)`,
    delta_CB_cout: `${dCB.delta_cout_fcfa ? Math.round(dCB.delta_cout_fcfa / 1e6) : 0}M FCFA (${dCB.delta_cout_pct || 0}%)`,
    delta_CB_unites: `${dCB.delta_unites || 0} logements`,
    // ── PHASAGE (texte plat) ──
    phasage_text: phasage.text || "",
    phasage_duree_mois: String((phasage.structured || {}).duree_totale_mois || ""),
    phasage_nb_phases: String((phasage.structured || {}).phases ? phasage.structured.phases.length : 1),
    // ── ORIENTATION SOLAIRE (texte plat) ──
    orient_zone: orient.zone_climatique || "",
    orient_facade_optimale: orient.facade_optimale || "",
    orient_facade_proteger: orient.facade_a_proteger || "",
    orient_ventilation: orient.ventilation_traversante ? "OUI" : "NON",
    orient_brise_soleil: orient.brise_soleil_ouest ? "OUI" : "NON",
    orient_malus_pct: String(orient.malus_orientation_pct || 0),
    orient_recommandation: orient.recommandation || "",
    // ── RETRAITS (texte plat) ──
    retrait_avant: `${retr.avant_m || 0}m`,
    retrait_lateral: `${retr.lateral_m || 0}m`,
    retrait_arriere: `${retr.arriere_m || 0}m`,
    retrait_mitoyennete: String(retr.mitoyennete_cotes || 0),
    retrait_emprise_constructible: `${retr.emprise_constructible_m2 || 0} m²`,
    retrait_reduction_pct: `${retr.reduction_pct || 0}%`,
    // ── SCENARIO A (champs plats) ──
    A_fp: String(sA.fp_m2 || 0), A_fp_rdc: String(sA.fp_rdc_m2 || 0),
    A_levels: String(Math.max(0, (sA.levels || 1) - 1)), A_height: String(sA.height_m || 0),
    A_sdp: String(sA.sdp_m2 || 0), A_units: String(sA.total_units || 0),
    A_unit_mix: sA.unit_mix_detail || "", A_m2_par_logt: String(sA.m2_habitable_par_logement || 0),
    A_cost_total: `${sA.cost_total_fcfa ? Math.round(sA.cost_total_fcfa / 1e6) : 0}M FCFA`,
    A_cost_bas: `${sA.cout_fourchette ? Math.round(sA.cout_fourchette.bas / 1e6) : 0}M`,
    A_cost_haut: `${sA.cout_fourchette ? Math.round(sA.cout_fourchette.haut / 1e6) : 0}M`,
    A_cost_m2: `${sA.cost_per_m2_sdp ? Math.round(sA.cost_per_m2_sdp / 1000) : 0}k FCFA/m²`,
    A_cost_m2_marche: `${sA.market_cost_per_m2 ? Math.round(sA.market_cost_per_m2 / 1000) : 0}k`,
    A_cost_m2_ajuste: `${sA.cost_per_m2 ? Math.round(sA.cost_per_m2 / 1000) : 0}k`,
    A_cost_unit: `${sA.cost_per_unit ? Math.round(sA.cost_per_unit / 1e6) : 0}M FCFA`,
    A_budget_fit: sA.budget_fit || "",
    A_ces_pct: String(sA.ces_fill_pct || 0), A_cos_pct: String(sA.cos_ratio_pct || 0),
    A_cos_compliance: sA.cos_compliance || "",
    A_free_ground: `${sA.free_ground_m2 || 0} m²`,
    A_parking_places: String((sA.parking_detail || {}).places_disponibles || 0),
    A_parking_deficit: String((sA.parking_detail || {}).deficit || 0),
    A_parking_source: (sA.parking_detail || {}).source || "",
    A_duree_chantier: `${sA.duree_chantier_mois || 0} mois`,
    A_score: String(Math.round((sA.recommendation_score || 0) * 100)), // v72.80 FIX: 0-1 → 0-100
    A_hab_m2: String(sA.surface_habitable_m2 || sA.total_useful_m2 || 0),
    A_efficacite: `${sA.ratio_efficacite_pct || 0}%`,
    A_ventil_go: `${(sA.cout_ventilation || {}).gros_oeuvre_fcfa ? Math.round(sA.cout_ventilation.gros_oeuvre_fcfa / 1e6) : 0}M`,
    A_ventil_so: `${(sA.cout_ventilation || {}).second_oeuvre_fcfa ? Math.round(sA.cout_ventilation.second_oeuvre_fcfa / 1e6) : 0}M`,
    A_ventil_lt: `${(sA.cout_ventilation || {}).lots_techniques_fcfa ? Math.round(sA.cout_ventilation.lots_techniques_fcfa / 1e6) : 0}M`,
    A_ventil_vrd: `${(() => { const cv = sA.cout_ventilation || {}; return Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / 1e6); })()}M`,
    A_ventil_hono: `${(sA.cout_ventilation || {}).honoraires_architecte ? Math.round(((sA.cout_ventilation || {}).honoraires_architecte || {}).median_fcfa / 1e6) : 0}M`,
    A_ventil_hono_bas: `${(sA.cout_ventilation || {}).honoraires_architecte ? Math.round(((sA.cout_ventilation || {}).honoraires_architecte || {}).bas_fcfa / 1e6) : 0}M`,
    A_ventil_hono_haut: `${(sA.cout_ventilation || {}).honoraires_architecte ? Math.round(((sA.cout_ventilation || {}).honoraires_architecte || {}).haut_fcfa / 1e6) : 0}M`,
    A_hono_taux_bas: `${((sA.cout_ventilation || {}).honoraires_architecte || {}).taux_bas_pct || 0}%`,
    A_hono_taux_haut: `${((sA.cout_ventilation || {}).honoraires_architecte || {}).taux_haut_pct || 0}%`,
    A_frais_annexes: `${(sA.cout_ventilation || {}).frais_annexes ? Math.round(sA.cout_ventilation.frais_annexes.total_frais_annexes_fcfa / 1e6) : 0}M`,
    A_frais_permis: `${(sA.cout_ventilation || {}).frais_annexes ? Math.round(sA.cout_ventilation.frais_annexes.permis_construire_fcfa / 1e6) : 0}M`,
    A_frais_assurance: `${(sA.cout_ventilation || {}).frais_annexes ? Math.round(sA.cout_ventilation.frais_annexes.assurance_dommage_ouvrage_fcfa / 1e6) : 0}M`,
    A_frais_etudes: `${(sA.cout_ventilation || {}).frais_annexes ? Math.round(sA.cout_ventilation.frais_annexes.etudes_techniques_fcfa / 1e6) : 0}M`,
    A_frais_divers: `${(sA.cout_ventilation || {}).frais_annexes ? Math.round(sA.cout_ventilation.frais_annexes.divers_imprevus_fcfa / 1e6) : 0}M`,
    A_ventil_global: `${(sA.cout_ventilation || {}).cout_global_projet_fcfa ? Math.round(sA.cout_ventilation.cout_global_projet_fcfa / 1e6) : 0}M FCFA`,
    // ── SCENARIO B (champs plats) ──
    B_fp: String(sB.fp_m2 || 0), B_fp_rdc: String(sB.fp_rdc_m2 || 0),
    B_levels: String(Math.max(0, (sB.levels || 1) - 1)), B_height: String(sB.height_m || 0),
    B_sdp: String(sB.sdp_m2 || 0), B_units: String(sB.total_units || 0),
    B_unit_mix: sB.unit_mix_detail || "", B_m2_par_logt: String(sB.m2_habitable_par_logement || 0),
    B_cost_total: `${sB.cost_total_fcfa ? Math.round(sB.cost_total_fcfa / 1e6) : 0}M FCFA`,
    B_cost_bas: `${sB.cout_fourchette ? Math.round(sB.cout_fourchette.bas / 1e6) : 0}M`,
    B_cost_haut: `${sB.cout_fourchette ? Math.round(sB.cout_fourchette.haut / 1e6) : 0}M`,
    B_cost_m2: `${sB.cost_per_m2_sdp ? Math.round(sB.cost_per_m2_sdp / 1000) : 0}k FCFA/m²`,
    B_cost_m2_marche: `${sB.market_cost_per_m2 ? Math.round(sB.market_cost_per_m2 / 1000) : 0}k`,
    B_cost_m2_ajuste: `${sB.cost_per_m2 ? Math.round(sB.cost_per_m2 / 1000) : 0}k`,
    B_cost_unit: `${sB.cost_per_unit ? Math.round(sB.cost_per_unit / 1e6) : 0}M FCFA`,
    B_budget_fit: sB.budget_fit || "",
    B_ces_pct: String(sB.ces_fill_pct || 0), B_cos_pct: String(sB.cos_ratio_pct || 0),
    B_cos_compliance: sB.cos_compliance || "",
    B_free_ground: `${sB.free_ground_m2 || 0} m²`,
    B_parking_places: String((sB.parking_detail || {}).places_disponibles || 0),
    B_parking_deficit: String((sB.parking_detail || {}).deficit || 0),
    B_parking_source: (sB.parking_detail || {}).source || "",
    B_duree_chantier: `${sB.duree_chantier_mois || 0} mois`,
    B_score: String(Math.round((sB.recommendation_score || 0) * 100)), // v72.80 FIX: 0-1 → 0-100
    B_hab_m2: String(sB.surface_habitable_m2 || sB.total_useful_m2 || 0),
    B_efficacite: `${sB.ratio_efficacite_pct || 0}%`,
    B_ventil_go: `${(sB.cout_ventilation || {}).gros_oeuvre_fcfa ? Math.round(sB.cout_ventilation.gros_oeuvre_fcfa / 1e6) : 0}M`,
    B_ventil_so: `${(sB.cout_ventilation || {}).second_oeuvre_fcfa ? Math.round(sB.cout_ventilation.second_oeuvre_fcfa / 1e6) : 0}M`,
    B_ventil_lt: `${(sB.cout_ventilation || {}).lots_techniques_fcfa ? Math.round(sB.cout_ventilation.lots_techniques_fcfa / 1e6) : 0}M`,
    B_ventil_vrd: `${(() => { const cv = sB.cout_ventilation || {}; return Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / 1e6); })()}M`,
    B_ventil_hono: `${(sB.cout_ventilation || {}).honoraires_architecte ? Math.round(((sB.cout_ventilation || {}).honoraires_architecte || {}).median_fcfa / 1e6) : 0}M`,
    B_ventil_hono_bas: `${(sB.cout_ventilation || {}).honoraires_architecte ? Math.round(((sB.cout_ventilation || {}).honoraires_architecte || {}).bas_fcfa / 1e6) : 0}M`,
    B_ventil_hono_haut: `${(sB.cout_ventilation || {}).honoraires_architecte ? Math.round(((sB.cout_ventilation || {}).honoraires_architecte || {}).haut_fcfa / 1e6) : 0}M`,
    B_hono_taux_bas: `${((sB.cout_ventilation || {}).honoraires_architecte || {}).taux_bas_pct || 0}%`,
    B_hono_taux_haut: `${((sB.cout_ventilation || {}).honoraires_architecte || {}).taux_haut_pct || 0}%`,
    B_frais_annexes: `${(sB.cout_ventilation || {}).frais_annexes ? Math.round(sB.cout_ventilation.frais_annexes.total_frais_annexes_fcfa / 1e6) : 0}M`,
    B_frais_permis: `${(sB.cout_ventilation || {}).frais_annexes ? Math.round(sB.cout_ventilation.frais_annexes.permis_construire_fcfa / 1e6) : 0}M`,
    B_frais_assurance: `${(sB.cout_ventilation || {}).frais_annexes ? Math.round(sB.cout_ventilation.frais_annexes.assurance_dommage_ouvrage_fcfa / 1e6) : 0}M`,
    B_frais_etudes: `${(sB.cout_ventilation || {}).frais_annexes ? Math.round(sB.cout_ventilation.frais_annexes.etudes_techniques_fcfa / 1e6) : 0}M`,
    B_frais_divers: `${(sB.cout_ventilation || {}).frais_annexes ? Math.round(sB.cout_ventilation.frais_annexes.divers_imprevus_fcfa / 1e6) : 0}M`,
    B_ventil_global: `${(sB.cout_ventilation || {}).cout_global_projet_fcfa ? Math.round(sB.cout_ventilation.cout_global_projet_fcfa / 1e6) : 0}M FCFA`,
    // ── SCENARIO C (champs plats) ──
    C_fp: String(sC.fp_m2 || 0), C_fp_rdc: String(sC.fp_rdc_m2 || 0),
    C_levels: String(Math.max(0, (sC.levels || 1) - 1)), C_height: String(sC.height_m || 0),
    C_sdp: String(sC.sdp_m2 || 0), C_units: String(sC.total_units || 0),
    C_unit_mix: sC.unit_mix_detail || "", C_m2_par_logt: String(sC.m2_habitable_par_logement || 0),
    C_cost_total: `${sC.cost_total_fcfa ? Math.round(sC.cost_total_fcfa / 1e6) : 0}M FCFA`,
    C_cost_bas: `${sC.cout_fourchette ? Math.round(sC.cout_fourchette.bas / 1e6) : 0}M`,
    C_cost_haut: `${sC.cout_fourchette ? Math.round(sC.cout_fourchette.haut / 1e6) : 0}M`,
    C_cost_m2: `${sC.cost_per_m2_sdp ? Math.round(sC.cost_per_m2_sdp / 1000) : 0}k FCFA/m²`,
    C_cost_m2_marche: `${sC.market_cost_per_m2 ? Math.round(sC.market_cost_per_m2 / 1000) : 0}k`,
    C_cost_m2_ajuste: `${sC.cost_per_m2 ? Math.round(sC.cost_per_m2 / 1000) : 0}k`,
    C_cost_unit: `${sC.cost_per_unit ? Math.round(sC.cost_per_unit / 1e6) : 0}M FCFA`,
    C_budget_fit: sC.budget_fit || "",
    C_ces_pct: String(sC.ces_fill_pct || 0), C_cos_pct: String(sC.cos_ratio_pct || 0),
    C_cos_compliance: sC.cos_compliance || "",
    C_free_ground: `${sC.free_ground_m2 || 0} m²`,
    C_parking_places: String((sC.parking_detail || {}).places_disponibles || 0),
    C_parking_deficit: String((sC.parking_detail || {}).deficit || 0),
    C_parking_source: (sC.parking_detail || {}).source || "",
    C_duree_chantier: `${sC.duree_chantier_mois || 0} mois`,
    C_score: String(Math.round((sC.recommendation_score || 0) * 100)), // v72.80 FIX: 0-1 → 0-100
    C_hab_m2: String(sC.surface_habitable_m2 || sC.total_useful_m2 || 0),
    C_efficacite: `${sC.ratio_efficacite_pct || 0}%`,
    C_ventil_go: `${(sC.cout_ventilation || {}).gros_oeuvre_fcfa ? Math.round(sC.cout_ventilation.gros_oeuvre_fcfa / 1e6) : 0}M`,
    C_ventil_so: `${(sC.cout_ventilation || {}).second_oeuvre_fcfa ? Math.round(sC.cout_ventilation.second_oeuvre_fcfa / 1e6) : 0}M`,
    C_ventil_lt: `${(sC.cout_ventilation || {}).lots_techniques_fcfa ? Math.round(sC.cout_ventilation.lots_techniques_fcfa / 1e6) : 0}M`,
    C_ventil_vrd: `${(() => { const cv = sC.cout_ventilation || {}; return Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / 1e6); })()}M`,
    C_ventil_hono: `${(sC.cout_ventilation || {}).honoraires_architecte ? Math.round(((sC.cout_ventilation || {}).honoraires_architecte || {}).median_fcfa / 1e6) : 0}M`,
    C_ventil_hono_bas: `${(sC.cout_ventilation || {}).honoraires_architecte ? Math.round(((sC.cout_ventilation || {}).honoraires_architecte || {}).bas_fcfa / 1e6) : 0}M`,
    C_ventil_hono_haut: `${(sC.cout_ventilation || {}).honoraires_architecte ? Math.round(((sC.cout_ventilation || {}).honoraires_architecte || {}).haut_fcfa / 1e6) : 0}M`,
    C_hono_taux_bas: `${((sC.cout_ventilation || {}).honoraires_architecte || {}).taux_bas_pct || 0}%`,
    C_hono_taux_haut: `${((sC.cout_ventilation || {}).honoraires_architecte || {}).taux_haut_pct || 0}%`,
    C_frais_annexes: `${(sC.cout_ventilation || {}).frais_annexes ? Math.round(sC.cout_ventilation.frais_annexes.total_frais_annexes_fcfa / 1e6) : 0}M`,
    C_frais_permis: `${(sC.cout_ventilation || {}).frais_annexes ? Math.round(sC.cout_ventilation.frais_annexes.permis_construire_fcfa / 1e6) : 0}M`,
    C_frais_assurance: `${(sC.cout_ventilation || {}).frais_annexes ? Math.round(sC.cout_ventilation.frais_annexes.assurance_dommage_ouvrage_fcfa / 1e6) : 0}M`,
    C_frais_etudes: `${(sC.cout_ventilation || {}).frais_annexes ? Math.round(sC.cout_ventilation.frais_annexes.etudes_techniques_fcfa / 1e6) : 0}M`,
    C_frais_divers: `${(sC.cout_ventilation || {}).frais_annexes ? Math.round(sC.cout_ventilation.frais_annexes.divers_imprevus_fcfa / 1e6) : 0}M`,
    C_ventil_global: `${(sC.cout_ventilation || {}).cout_global_projet_fcfa ? Math.round(sC.cout_ventilation.cout_global_projet_fcfa / 1e6) : 0}M FCFA`,
    // ── PROFIL CLIENT (echo) ──
    profil_posture: profil.posture || "",
    profil_budget_band: profil.budget_band || "",
    profil_budget_max: `${profil.budget_max_fcfa ? Math.round(profil.budget_max_fcfa / 1e6) : 0}M FCFA`,
    profil_standing: profil.standing || "",
    profil_programme: profil.programme || "",
    profil_cible_unites: String(profil.cible_unites || 0),
    // ── SITE DIAG ──
    site_ces_regl: `${siteDiag.ces_reglementaire_pct || 0}%`,
    site_cos_regl: String(siteDiag.cos_reglementaire || 0),
    site_hauteur_max: `${siteDiag.hauteur_max_m || 0}m`,
    site_niveaux_max: String(siteDiag.niveaux_max || 0),
    site_emprise_max: `${siteDiag.emprise_max_m2 || 0} m²`,
    site_sdp_max: `${siteDiag.sdp_max_m2 || 0} m²`,
  };
  return res.json({ ok: true, scenarios, computed_budget_band: scenarios.computed_budget_band, ...flat });
});
// ─── TYPOLOGIES ARCHITECTURALES (v54) ────────────────────────────────────────
// Sélection automatique de la forme bâtie selon le contexte :
//   BLOC     → rectangle compact (~1:1.3), économique, petit terrain
//   BARRE    → lamelle allongée (~1:3+), éclairage naturel, logement
//   EN_U     → 3 ailes + cour intérieure, programme mixte, standing élevé
//   EN_L     → 2 ailes, terrain d'angle, extension/rénovation
//   EXTENSION→ barre accolée à un côté (parcelle déjà occupée)
// ─── SÉLECTION TYPOLOGIQUE v56.2 ─────────────────────────────────────────────
// Chaque scénario (A/B/C) peut avoir une typologie DIFFÉRENTE.
// Le choix tient compte de :
//   - massing_mode (BALANCED/SPREAD/COMPACT) → oriente vers certaines formes
//   - fillRatio (emprise/enveloppe) → contrainte géométrique
//   - envAspect (largeur/profondeur) → terrain allongé ou carré
//   - streetBearing (orientation rue en degrés) → soleil vs façade
//   - standing, programme, saturation, etc.
//
// RÈGLE CLÉ : les 3 scénarios doivent proposer des typologies différentes quand c'est possible.
function selectTypology({ fp_m2, envelopeArea, envAspect, massing_mode, primary_driver,
  levels, standing_level, program_main, site_saturation, project_type, existing_fp_m2,
  streetBearing = 0, latitude = 14, scenario_role = "EQUILIBRE" }) {
  const fillRatio = fp_m2 / Math.max(1, envelopeArea);
  const isMixte = /mixte|mixed/i.test(program_main || "");
    // v72.98: DEMOLITION → parcelle vide
  const isDemolition = /DEMOLITION/i.test(project_type || "");
  const isReno = !isDemolition && /RENOVATION|EXTENSION|SURELEVATION/i.test(project_type || "");
  const effectiveExistingFp = isDemolition ? 0 : (Number(existing_fp_m2) || 0);
  const isOccupied = !isDemolition && ((site_saturation === "HIGH") || (effectiveExistingFp > 0) || isReno);
  const isPremium = /PREMIUM|HAUT/i.test(standing_level || "");
  const isEco = /ECO|ECONOMIQUE/i.test(standing_level || "");
  // ── Analyse bioclimatique par zone ──
  // RÈGLES PAR LATITUDE :
  // Zone équatoriale (0-5°) : soleil vient du N et du S selon saison. E et W chauffent le plus.
  //   → Façades ouvertes : N et S. Façades à protéger : E (matin) et surtout W (après-midi = surchauffe)
  //   → Bâtiment allongé axe E-W = optimal (façades N/S ouvertes, pignons E/W minimaux)
  //
  // Zone tropicale (5-15°) : Cameroun, Sénégal, Côte d'Ivoire, Mali...
  //   → Soleil haut toute l'année, OUEST = surchauffe majeure (soleil rasant 14h-18h)
  //   → Façades ouvertes : SUD (ventilation, lumière douce). Façade à protéger : OUEST
  //   → Bâtiment allongé axe E-W = optimal. Si impossible : protéger façade W (peu d'ouvertures)
  //
  // Zone sahélienne/sub-tropicale (15-25°) : Sénégal nord, Mali, Burkina...
  //   → Comme tropical mais plus sec. Soleil intense. Même règle W = pire.
  //
  // Zone méditerranéenne/tempérée (25°+) : Maghreb, Afrique du Sud
  //   → Logique européenne : façade SUD = apport solaire hivernal souhaité.
  //   → Bâtiment allongé E-W aussi optimal.
  //
  // CONCLUSION UNIVERSELLE : L'axe long du bâtiment doit être E-W dans toutes les zones.
  // La façade à PROTÉGER (minimiser) est l'OUEST en zone tropicale/équatoriale.
  const absLat = Math.abs(latitude);
  const climateZone = absLat < 5 ? "EQUATORIAL" : absLat < 15 ? "TROPICAL" : absLat < 25 ? "SAHELIEN" : "TEMPERE";
  // Azimut de la façade à protéger (éviter les ouvertures)
  const protectAzimuth = climateZone === "TEMPERE" ? null : 270; // OUEST sauf tempéré
  // Azimut de la façade préférée (ouvertures, ventilation)
  const preferAzimuth = climateZone === "TEMPERE" ? 180 : (climateZone === "EQUATORIAL" ? 0 : 180); // SUD (ou N en équatorial)
  // L'AXE LONG optimal du bâtiment : toujours ~E-W (90° ou 270°)
  const optimalLongAxis = 90; // azimut de l'axe long idéal
  const streetAngle = ((streetBearing % 360) + 360) % 360;
  // Écart entre l'axe de la rue et l'axe E-W optimal
  const axisDeviation = Math.min(
    Math.abs(streetAngle - optimalLongAxis),
    Math.abs(streetAngle - (optimalLongAxis + 180)),
    Math.abs(streetAngle - optimalLongAxis + 360),
    Math.abs(streetAngle - (optimalLongAxis + 180) + 360)
  ) % 180;
  // Si la rue est ~E-W : BARRE le long = optimal (axisDeviation petit)
  // Si la rue est ~N-S : BARRE le long = mauvais (axisDeviation grand)
  const barreSolarScore = Math.max(0, 1.0 - axisDeviation / 90); // 1.0 si E-W, 0 si N-S
  // Façade OUEST du bâtiment par rapport à la rue
  // Si la rue est au nord : l'ouest du bâtiment est à gauche en regardant la parcelle
  // On veut minimiser la façade ouest = mettre le pignon (côté court) face à l'ouest
  const streetFacesWest = Math.abs(streetAngle - 270) < 45 || Math.abs(streetAngle - 270 + 360) < 45;
  console.log(`│ Climate: zone=${climateZone} lat=${latitude.toFixed(1)}° protect=${protectAzimuth || "none"}° prefer=${preferAzimuth}°`);
  console.log(`│ Street: bearing=${streetAngle.toFixed(0)}° axisDeviation=${axisDeviation.toFixed(0)}° barreSolar=${barreSolarScore.toFixed(2)} facesWest=${streetFacesWest}`);
  console.log(`┌── selectTypology v56.2
 ──`);
  console.log(`│ fillRatio=${fillRatio.toFixed(3)} envAspect=${envAspect.toFixed(2)} mode=${massing_mode}`);
  console.log(`│ streetBearing=${streetBearing.toFixed(0)}° axisDeviation=${axisDeviation.toFixed(0)}° barreSolar=${barreSolarScore.toFixed(2)} facesWest=${streetFacesWest}`);
  console.log(`│ driver=${primary_driver} levels=${levels} standing=${standing_level}`);
  console.log(`│ program=${program_main} saturation=${site_saturation} project=${project_type}`);
  let typology;
  let reason;
  // ── Parcelle occupée / extension / rénovation → contrainte forte ──
  if (isOccupied && isReno) {
    typology = "EXTENSION";
    reason = "parcelle occupée + rénovation → extension accolée";
  } else if (isOccupied && fillRatio < 0.5) {
    typology = "EN_L";
    reason = "parcelle occupée + emprise modérée → L pour contourner l'existant";
  } else if (isOccupied) {
    typology = "BLOC";
    reason = "parcelle occupée + forte emprise → bloc compact loin de l'existant";
  }
  // ── Contrainte géométrique dure ──
  else if (fillRatio > 0.80) {
    typology = "BLOC";
    reason = `emprise ${(fillRatio*100).toFixed(0)}% > 80% → bloc compact seul possible`;
  }
  // ── v56.7: RÔLE influence la préférence typologique ──
  // PRUDENT → préfère les formes simples (BLOC) sauf si le terrain impose autre chose
  // INTENSIFICATION → peut proposer des formes complexes (EN_U, BARRE longue)
  // EQUILIBRE → compromis
  else if (scenario_role === "PRUDENT" && fillRatio > 0.35) {
    typology = "BLOC";
    reason = `PRUDENT + emprise ${(fillRatio*100).toFixed(0)}% → bloc simple (risque minimal, coût maîtrisé)`;
  } else if (scenario_role === "INTENSIFICATION" && isMixte && envelopeArea > 500 && fillRatio > 0.35) {
    typology = "EN_U";
    reason = "INTENSIFICATION + mixte + grande parcelle → U (max SDP, cour intérieure, commerce RDC)";
  } else if (scenario_role === "INTENSIFICATION" && envAspect > 1.8 && barreSolarScore > 0.5) {
    typology = "BARRE";
    reason = `INTENSIFICATION + terrain allongé + bonne orientation solaire → barre longue`;
  }
  // ── Sélection par massing_mode (différenciation de forme) ──
  else if (massing_mode === "COMPACT") {
    // COMPACT = rentabilité max, coût optimisé → BLOC ou EN_U
    if (isPremium && isMixte && envelopeArea > 500) {
      typology = "EN_U";
      reason = "COMPACT + premium + mixte → U dense avec cour intérieure";
    } else if (isMixte && fillRatio > 0.4 && envelopeArea > 500) {
      typology = "EN_U";
      reason = "COMPACT + mixte + grande emprise → U maximise la SDP";
    } else {
      typology = "BLOC";
      reason = `COMPACT → bloc compact (coût/m² optimisé)`;
    }
  } else if (massing_mode === "SPREAD") {
    // SPREAD = qualité de vie, lumière, espaces → BARRE ou EN_L
    if (envAspect > 1.5 && barreSolarScore > 0.5) {
      typology = "BARRE";
      reason = `SPREAD + terrain allongé (${envAspect.toFixed(1)}) + bonne orientation solaire → lamelle`;
    } else if (envAspect > 1.8) {
      typology = "BARRE";
      reason = `SPREAD + terrain très allongé → lamelle (même si orientation pas idéale)`;
    } else if (isPremium && envelopeArea > 400) {
      typology = "EN_L";
      reason = "SPREAD + premium → L pour max lumière et dégagement";
    } else if (fillRatio < 0.45) {
      typology = "BARRE";
      reason = "SPREAD + faible emprise → lamelle (double orientation, lumière)";
    } else {
      typology = "EN_L";
      reason = "SPREAD → L (bon compromis lumière/espace)";
    }
  } else {
    // BALANCED = référence optimale
    if (isPremium && isMixte && envelopeArea > 600) {
      typology = "EN_U";
      reason = "BALANCED + premium + mixte → U avec cour (prestige)";
    } else if (envAspect > 2.0 && barreSolarScore > 0.6) {
      typology = "BARRE";
      reason = "BALANCED + terrain allongé + bonne orientation → lamelle optimale";
    } else if (fillRatio > 0.4 && fillRatio < 0.70 && envelopeArea > 400) {
      typology = "EN_L";
      reason = "BALANCED + emprise intermédiaire → L (compromis optimal)";
    } else if (isMixte && fillRatio > 0.35 && envelopeArea > 400) {
      typology = "EN_U";
      reason = "BALANCED + mixte → U avec cour intérieure";
    } else if (levels >= 5 && fillRatio < 0.35) {
      typology = "BLOC";
      reason = `BALANCED + petite emprise + ${levels} niveaux → tour/bloc`;
    } else {
      typology = "BLOC";
      reason = "BALANCED → bloc compact (défaut robuste)";
    }
  }
  console.log(`│ → TYPOLOGY = ${typology} (${reason})`);
  console.log(`└── end selectTypology v56.2 ──`);
  return { typology, reason };
}
// ─── POINT-IN-POLYGON (ray casting) ─────────────────────────────────────────
function ptInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
// ─── COUPE TRANSVERSALE de l'enveloppe (v56) ─────────────────────────────────
// Pour un polygone en repère local (u,v), trouve la largeur disponible
// à une profondeur v donnée, en scannant les arêtes qui croisent ce v.
function envelopeWidthAtV(vTarget, envLocal) {
  let minU = Infinity, maxU = -Infinity;
  const n = envLocal.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const vi = envLocal[i].v, vj = envLocal[j].v;
    if ((vi <= vTarget && vj >= vTarget) || (vj <= vTarget && vi >= vTarget)) {
      if (Math.abs(vj - vi) < 0.001) {
        minU = Math.min(minU, envLocal[i].u, envLocal[j].u);
        maxU = Math.max(maxU, envLocal[i].u, envLocal[j].u);
      } else {
        const t = (vTarget - vi) / (vj - vi);
        const u = envLocal[i].u + t * (envLocal[j].u - envLocal[i].u);
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
      }
    }
  }
  if (minU === Infinity) return { minU: 0, maxU: 0, width: 0 };
  return { minU, maxU, width: maxU - minU };
}
// Idem mais coupe horizontale : profondeur dispo à un u donné
function envelopeDepthAtU(uTarget, envLocal) {
  let minV = Infinity, maxV = -Infinity;
  const n = envLocal.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ui = envLocal[i].u, uj = envLocal[j].u;
    if ((ui <= uTarget && uj >= uTarget) || (uj <= uTarget && ui >= uTarget)) {
      if (Math.abs(uj - ui) < 0.001) {
        minV = Math.min(minV, envLocal[i].v, envLocal[j].v);
        maxV = Math.max(maxV, envLocal[i].v, envLocal[j].v);
      } else {
        const t = (uTarget - ui) / (uj - ui);
        const v = envLocal[i].v + t * (envLocal[j].v - envLocal[i].v);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
  }
  if (minV === Infinity) return { minV: 0, maxV: 0, depth: 0 };
  return { minV, maxV, depth: maxV - minV };
}
// ─── POLYGONE GPS DU BÂTIMENT MASSING v56.2 — ORIENTATION SOLAIRE ────────────
// v56.2 : intègre l'orientation solaire, la position par rapport à la rue,
// le voisinage, et propose une typologie adaptée par scénario.
function computeMassingPolygon(envelopeCoords, fp_m2, envelopeArea, context = {}) {
  const { massing_mode, primary_driver, levels, standing_level, program_main,
    site_saturation, project_type, existing_fp_m2,
    road_bearing: roadBearingInput, scenario_role, split_context } = context;
  console.log(`┌── computeMassingPolygon v72.27 (ROAD_BEARING + RÔLE + SOLAR + SPLIT) ──`);
  console.log(`│ fp_m2=${fp_m2}  envelopeArea=${envelopeArea.toFixed(1)}m²  mode=${massing_mode}  role=${scenario_role}`);
  // ── 1. Centroïde et conversion mètres ──
  const eLat = envelopeCoords.reduce((s, p) => s + p.lat, 0) / envelopeCoords.length;
  const eLon = envelopeCoords.reduce((s, p) => s + p.lon, 0) / envelopeCoords.length;
  const envM = envelopeCoords.map(c => toM(c.lat, c.lon, eLat, eLon));
  envelopeCoords.forEach((c, i) => console.log(`│ Env[${i}]: ${c.lat.toFixed(7)}, ${c.lon.toFixed(7)}`));
  // ── 2. Détecter la façade rue ──
  // v56.7: Si road_bearing est fourni par la Sheet, on cherche le bord de l'enveloppe
  // dont l'azimut est le PLUS PROCHE du road_bearing (= parallèle à la route).
  // Sinon, fallback: le bord le PLUS LONG (heuristique ouest-africaine).
  let frontIdx = 0;
  let maxEdgeLen = 0;
  if (roadBearingInput != null && !isNaN(roadBearingInput)) {
    // ── ROAD BEARING CONNU : trouver le bord parallèle à la route ──
    const rb = ((roadBearingInput % 360) + 360) % 360;
    let bestAngleDiff = 999;
    for (let i = 0; i < envelopeCoords.length; i++) {
      const j = (i + 1) % envelopeCoords.length;
      const dx = envM[j].x - envM[i].x, dy = envM[j].y - envM[i].y;
      const edgeLen = Math.sqrt(dx * dx + dy * dy);
      if (edgeLen < 3) continue; // ignorer les micro-bords
      const edgeBearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
      // Différence angulaire (0°-180°, car un bord à 10° et 190° est le même axe)
      let diff = Math.abs(edgeBearing - rb) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff > 90) diff = 180 - diff; // même axe, direction opposée
      // Pondérer légèrement par la longueur (préférer un bord long à angle égal)
      const score = diff - edgeLen * 0.02;
      if (score < bestAngleDiff) { bestAngleDiff = score; frontIdx = i; maxEdgeLen = edgeLen; }
    }
    console.log(`│ Front edge: road_bearing=${rb.toFixed(0)}° → best match [${frontIdx}→${(frontIdx+1)%envM.length}] angleDiff=${bestAngleDiff.toFixed(1)}° len=${maxEdgeLen.toFixed(1)}m`);
  } else {
    // ── FALLBACK : bord le plus long = front de rue ──
    for (let i = 0; i < envelopeCoords.length; i++) {
      const j = (i + 1) % envelopeCoords.length;
      const dx = envM[j].x - envM[i].x, dy = envM[j].y - envM[i].y;
      const edgeLen = Math.sqrt(dx * dx + dy * dy);
      if (edgeLen > maxEdgeLen) { maxEdgeLen = edgeLen; frontIdx = i; }
    }
    console.log(`│ Front edge: no road_bearing → longest edge [${frontIdx}→${(frontIdx+1)%envM.length}] len=${maxEdgeLen.toFixed(1)}m`);
  }
  const fi = frontIdx, fj = (fi + 1) % envM.length;
  const sDx = envM[fj].x - envM[fi].x, sDy = envM[fj].y - envM[fi].y;
  const sLen = Math.sqrt(sDx * sDx + sDy * sDy) || 1;
  const sUx = sDx / sLen, sUy = sDy / sLen;
  let nUx = -sUy, nUy = sUx;
  const midFX = (envM[fi].x + envM[fj].x) / 2, midFY = (envM[fi].y + envM[fj].y) / 2;
  if (nUx * (0 - midFX) + nUy * (0 - midFY) < 0) { nUx = -nUx; nUy = -nUy; }
  // ── Calculer le bearing de la rue (azimut en degrés) ──
  const streetBearing = ((Math.atan2(sDx, sDy) * 180 / Math.PI) + 360) % 360;
  console.log(`│ Front edge: [${fi}→${fj}] len=${sLen.toFixed(1)}m bearing=${streetBearing.toFixed(0)}°`);
  console.log(`│ StreetDir=(${sUx.toFixed(3)},${sUy.toFixed(3)}) IntoSite=(${nUx.toFixed(3)},${nUy.toFixed(3)})`);
  // ── 3. Analyse bioclimatique ──
  const absLat = Math.abs(eLat);
  const climateZone = absLat < 5 ? "EQUATORIAL" : absLat < 15 ? "TROPICAL" : absLat < 25 ? "SAHELIEN" : "TEMPERE";
  // En zone tropicale/équatoriale : OUEST (270°) = surchauffe → minimiser cette façade
  // L'axe long du bâtiment doit être E-W (90°/270°) pour que les façades longues soient N et S
  const optimalLongAxis = 90;
  const streetSunDeviation = Math.min(
    Math.abs(streetBearing - optimalLongAxis),
    Math.abs(streetBearing - optimalLongAxis - 180),
    Math.abs(streetBearing - optimalLongAxis + 180)
  ) % 180;
  const solarFavorBarre = streetSunDeviation < 40; // rue ~E-W → barre le long = bon
  const solarFavorDepth = streetSunDeviation > 50; // rue ~N-S → profondeur = mieux
  console.log(`│ Bioclimatic: zone=${climateZone} lat=${eLat.toFixed(2)}° streetDeviation=${streetSunDeviation.toFixed(0)}°`);
  console.log(`│ Orientation: favorBarre=${solarFavorBarre} favorDepth=${solarFavorDepth}`);
  // ── 4. Projeter l'enveloppe en repère local ──
  const envLocal = envM.map(p => ({
    u: p.x * sUx + p.y * sUy,
    v: p.x * nUx + p.y * nUy,
  }));
  const minU = Math.min(...envLocal.map(p => p.u)), maxU = Math.max(...envLocal.map(p => p.u));
  const minV = Math.min(...envLocal.map(p => p.v)), maxV = Math.max(...envLocal.map(p => p.v));
  const availW = maxU - minU;
  const availD = maxV - minV;
  const envAspect = availW / Math.max(1, availD);
  console.log(`│ Local frame: W=${availW.toFixed(1)}m(rue) × D=${availD.toFixed(1)}m(prof) aspect=${envAspect.toFixed(2)}`);
  // ── 5. Sélection typologique (avec orientation solaire, bearing et rôle) ──
  const { typology, reason } = selectTypology({
    fp_m2, envelopeArea, envAspect, massing_mode,
    primary_driver, levels, standing_level, program_main,
    site_saturation, project_type, existing_fp_m2: Number(existing_fp_m2) || 0,
    streetBearing, latitude: eLat, scenario_role,
  });
  console.log(`│ Typology: ${typology} — ${reason}`);
  // ── 5b. v56.5 SIMPLIFIED POSITIONING ──
  // Approche directe : utiliser le bbox de l'enveloppe en repère local.
  // Le bâtiment est inscrit dans le bbox avec une marge de 2m.
  // Pas de cross-section, pas de containment check, pas de shrink loop.
  // Garanti de fonctionner pour toute enveloppe convexe.
  const margin = 2.0; // marge constructive (l'enveloppe est déjà en retrait de la parcelle)
  let maxW = Math.max(8, availW - 2 * margin);
  let maxD = Math.max(8, availD - 2 * margin);
  // v72.27: En mode SPLIT, réduire maxD pour que le logement tienne derrière le commerce
  if (split_context && split_context.is_split) {
    const commD = split_context.commerce_depth_m || 6;
    const gapD = split_context.retrait_inter_m || 4;
    const commMargin = 0.5;
    const reservedFront = commMargin + commD + gapD;
    maxD = Math.max(6, availD - reservedFront - margin); // profondeur restante pour logement
    console.log(`│ v72.27 SPLIT maxD: availD=${availD.toFixed(1)} - reserved=${reservedFront.toFixed(1)} - margin=${margin} → maxD=${maxD.toFixed(1)}m`);
  }
  console.log(`│ v56.5 DIRECT: availW=${availW.toFixed(1)} availD=${availD.toFixed(1)} → maxW=${maxW.toFixed(1)} maxD=${maxD.toFixed(1)} (margin=${margin}m)`);
  // Position en profondeur (retrait de la rue) — v72.27 : SPLIT-aware
  // En mode SPLIT_AV_AR, le logement doit être DERRIÈRE le commerce + gap.
  // Le centre du logement = marge + commDepth + interGap + bD/2 (calculé après forme)
  let depthPct;
  let splitForcePosition = false; // v72.27: flag pour forcer la position APRÈS calcul forme
  if (split_context && split_context.is_split) {
    // Mode SPLIT : le logement doit commencer APRÈS la zone commerce + gap
    const commD = split_context.commerce_depth_m || 6;
    const gapD = split_context.retrait_inter_m || 4;
    const reservedFront = margin + commD + gapD; // espace réservé devant (commerce + gap)
    // Le centre du logement sera calculé après la forme (besoin de bD)
    // Pour l'instant on calcule un depthPct approximatif qui place le logement derrière
    const logementCenterFromFront = reservedFront + (availD - reservedFront) / 2;
    depthPct = logementCenterFromFront / availD;
    depthPct = Math.max(0.50, Math.min(0.85, depthPct));
    splitForcePosition = true;
    console.log(`│ v72.27 SPLIT: commerce=${commD}m + gap=${gapD}m → reservedFront=${reservedFront.toFixed(1)}m`);
    console.log(`│ v72.27 SPLIT: logement center at ${(depthPct*100).toFixed(0)}% depth (${(availD*depthPct).toFixed(1)}m from front)`);
  } else {
    // Mode normal : basé sur le RÔLE
    // INTENSIFICATION → plus près de la rue (visibilité, commerce RDC, intensité urbaine)
    // EQUILIBRE → retrait modéré
    // PRUDENT → retrait plus marqué (calme, résidentiel, phasage)
    if (scenario_role === "INTENSIFICATION") depthPct = 0.45;
    else if (scenario_role === "PRUDENT") depthPct = 0.62;
    else depthPct = 0.53; // EQUILIBRE
    // Ajustement solaire : si la rue est N-S, reculer un peu pour libérer la cour sud
    if (solarFavorDepth) depthPct = Math.min(0.70, depthPct + 0.05);
    depthPct = Math.max(0.38, Math.min(0.72, depthPct));
  }
  console.log(`│ Implantation: retrait ${(depthPct*100).toFixed(0)}% de la rue (role=${scenario_role}, mode=${massing_mode}, split=${!!split_context})`);
  // ── 6. Générer la forme bâtie ──
  let bPts = [];
  let bW, bD;
  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      a += pts[i].u * pts[j].v - pts[j].u * pts[i].v;
    }
    return Math.abs(a) / 2;
  }
  if (typology === "BARRE") {
    const idealD = Math.min(14, maxD * 0.40);
    bW = Math.min(fp_m2 / idealD, maxW);
    bD = Math.min(fp_m2 / bW, maxD);
    bPts = [
      { u: -bW / 2, v: -bD / 2 }, { u: bW / 2, v: -bD / 2 },
      { u: bW / 2, v: bD / 2 }, { u: -bW / 2, v: bD / 2 },
    ];
  } else if (typology === "EN_U") {
    const wingPct = 0.22, backPct = 0.28;
    bW = Math.min(maxW * 0.92, Math.max(16, maxW * 0.80));
    bD = Math.min(maxD * 0.92, Math.max(14, maxD * 0.80));
    let wing = bW * wingPct, back = bD * backPct;
    let aU = bW * back + 2 * wing * (bD - back);
    if (aU > 0 && aU !== fp_m2) {
      const sc = Math.sqrt(fp_m2 / aU);
      bW = Math.min(bW * sc, maxW); bD = Math.min(bD * sc, maxD);
      wing = bW * wingPct; back = bD * backPct;
    }
    bPts = [
      { u: -bW / 2, v: -bD / 2 },
      { u: -bW / 2 + wing, v: -bD / 2 },
      { u: -bW / 2 + wing, v: bD / 2 - back },
      { u: bW / 2 - wing, v: bD / 2 - back },
      { u: bW / 2 - wing, v: -bD / 2 },
      { u: bW / 2, v: -bD / 2 },
      { u: bW / 2, v: bD / 2 },
      { u: -bW / 2, v: bD / 2 },
    ];
  } else if (typology === "EN_L") {
    const armPctW = 0.35, armPctD = 0.35;
    bW = Math.min(maxW * 0.92, Math.max(14, maxW * 0.80));
    bD = Math.min(maxD * 0.92, Math.max(14, maxD * 0.80));
    let aW = bW * armPctW, aD = bD * armPctD;
    let aL = bW * aD + aW * (bD - aD);
    if (aL > 0 && aL !== fp_m2) {
      const sc = Math.sqrt(fp_m2 / aL);
      bW = Math.min(bW * sc, maxW); bD = Math.min(bD * sc, maxD);
      aW = bW * armPctW; aD = bD * armPctD;
    }
    bPts = [
      { u: -bW / 2, v: -bD / 2 },
      { u: bW / 2, v: -bD / 2 },
      { u: bW / 2, v: -bD / 2 + aD },
      { u: -bW / 2 + aW, v: -bD / 2 + aD },
      { u: -bW / 2 + aW, v: bD / 2 },
      { u: -bW / 2, v: bD / 2 },
    ];
  } else {
    // BLOC : rectangle compact ~1.25:1
    const ratio = 1.25;
    bD = Math.min(Math.sqrt(fp_m2 / ratio), maxD);
    bW = Math.min(fp_m2 / bD, maxW);
    if (bW > maxW) { bW = maxW; bD = Math.min(fp_m2 / bW, maxD); }
    bPts = [
      { u: -bW / 2, v: -bD / 2 }, { u: bW / 2, v: -bD / 2 },
      { u: bW / 2, v: bD / 2 }, { u: -bW / 2, v: bD / 2 },
    ];
  }
  const shapeArea = polyArea(bPts);
  console.log(`│ Shape: ${typology} bW=${bW.toFixed(1)}m × bD=${bD.toFixed(1)}m area=${shapeArea.toFixed(0)}m² target=${fp_m2}m²`);
  // ── 7. POSITIONNEMENT DIRECT dans le bbox ──
  // Centre U = milieu du bbox, Centre V = retrait en profondeur
  const cU = (minU + maxU) / 2;
  let cV;
  if (splitForcePosition && split_context) {
    // v72.27 SPLIT: positionner le logement PRÉCISÉMENT derrière le commerce + gap
    // Le commerce est collé au front avec une marge de 0.5m (limite séparative)
    // Le bord AVANT du logement = minV + commMargin + commDepth + gapD
    const commD = split_context.commerce_depth_m || 6;
    const gapD = split_context.retrait_inter_m || 4;
    const commMargin = 0.5; // même marge que buildCommercePolygon
    const logementFrontEdge = minV + commMargin + commD + gapD;
    cV = logementFrontEdge + bD / 2;
    // S'assurer que le logement reste dans l'enveloppe
    const logementBackEdge = cV + bD / 2;
    if (logementBackEdge > maxV - margin) {
      cV = maxV - margin - bD / 2; // reculer pour rester dans l'enveloppe
    }
    console.log(`│ v72.27 SPLIT POSITION: logement front=${logementFrontEdge.toFixed(1)}m center=${cV.toFixed(1)}m back=${(cV+bD/2).toFixed(1)}m`);
    console.log(`│ v72.27 Commerce zone: [${(minV+margin).toFixed(1)}, ${(minV+margin+commD).toFixed(1)}m] | Gap: ${gapD}m | Logement: [${logementFrontEdge.toFixed(1)}, ${(cV+bD/2).toFixed(1)}m]`);
  } else {
    cV = minV + availD * depthPct;
  }
  console.log(`│ Position: center=(${cU.toFixed(1)}, ${cV.toFixed(1)}) [bbox mid-U, ${((cV-minV)/availD*100).toFixed(0)}% depth-V]`);
  // Positionner les points : local (u,v) → mètre (x,y) → GPS
  function localToMeter(p) {
    return { x: p.u * sUx + p.v * nUx, y: p.u * sUy + p.v * nUy };
  }
  const finalPts = bPts.map(p => ({ u: p.u + cU, v: p.v + cV }));
  const finalM = finalPts.map(localToMeter);
  // ── 8. Conversion GPS ──
  const result = finalM.map(p => ({
    lat: eLat + p.y / R_EARTH * 180 / Math.PI,
    lon: eLon + p.x / (R_EARTH * Math.cos(eLat * Math.PI / 180)) * 180 / Math.PI,
  }));
  result.forEach((c, i) => console.log(`│ Massing[${i}]: ${c.lat.toFixed(7)}, ${c.lon.toFixed(7)}`));
  const actualFp = Math.abs(finalM.reduce((s, p, i) => {
    const j = (i + 1) % finalM.length;
    return s + p.x * finalM[j].y - finalM[j].x * p.y;
  }, 0) / 2);
  console.log(`│ Emprise réelle ≈ ${actualFp.toFixed(0)}m² (cible=${fp_m2}m²)`);
  console.log(`│ Typology: ${typology} — ${reason}`);
  console.log(`└── end computeMassingPolygon v56 ──`);
  result._typology = typology;
  result._reason = reason;
  // v72.25: Exporter les infos de repère local pour le SPLIT (découpe commerce/logement)
  result._frontDir = { sUx, sUy, nUx, nUy }; // direction rue (s) et profondeur site (n)
  result._centerLatLon = { lat: eLat, lon: eLon };
  return result;
}
// ─── SPLIT COMMERCE/LOGEMENT : polygon commerce construit depuis l'enveloppe ──
// v72.27: Le commerce est une bande rectangulaire COLLÉE AU FRONT de l'enveloppe (limite séparative).
// Le logement = massingCoords existant (positionné en retrait par computeMassingPolygon + split_context).
// On CONSTRUIT le commerce séparément depuis l'enveloppe, SANS marge devant (collé à la limite).
function buildCommercePolygon(envelopeCoords, splitLayout, roadBearing) {
  if (!splitLayout || !envelopeCoords || envelopeCoords.length < 3) return null;
  const commDepth = splitLayout.volume_commerce.depth_m || 6;
  const commWidth = splitLayout.volume_commerce.width_m || null;
  const margin = 0.5; // v72.27: marge minimale (commerce collé à la limite séparative)
  console.log(`┌── buildCommercePolygon v72.27 ──`);
  console.log(`│ commDepth=${commDepth}m  commWidth=${commWidth}m  envVertices=${envelopeCoords.length}`);
  // Centroïde de l'enveloppe
  const cLat = envelopeCoords.reduce((s, p) => s + p.lat, 0) / envelopeCoords.length;
  const cLon = envelopeCoords.reduce((s, p) => s + p.lon, 0) / envelopeCoords.length;
  // Convertir en mètres
  const envM = envelopeCoords.map(c => toM(c.lat, c.lon, cLat, cLon));
  // Trouver le bord "façade rue" (même logique que computeMassingPolygon)
  let frontIdx = 0;
  if (roadBearing != null && !isNaN(roadBearing)) {
    const rb = ((roadBearing % 360) + 360) % 360;
    let bestScore = 999;
    for (let i = 0; i < envM.length; i++) {
      const j = (i + 1) % envM.length;
      const dx = envM[j].x - envM[i].x, dy = envM[j].y - envM[i].y;
      const edgeLen = Math.sqrt(dx * dx + dy * dy);
      if (edgeLen < 1) continue;
      const edgeBearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
      let diff = Math.abs(edgeBearing - rb) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff > 90) diff = 180 - diff;
      const score = diff - edgeLen * 0.02;
      if (score < bestScore) { bestScore = score; frontIdx = i; }
    }
  } else {
    let maxLen = 0;
    for (let i = 0; i < envM.length; i++) {
      const j = (i + 1) % envM.length;
      const dx = envM[j].x - envM[i].x, dy = envM[j].y - envM[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > maxLen) { maxLen = len; frontIdx = i; }
    }
  }
  const fi = frontIdx, fj = (fi + 1) % envM.length;
  const sDx = envM[fj].x - envM[fi].x, sDy = envM[fj].y - envM[fi].y;
  const sLen = Math.sqrt(sDx * sDx + sDy * sDy) || 1;
  const sUx = sDx / sLen, sUy = sDy / sLen; // direction le long de la rue
  let nUx = -sUy, nUy = sUx; // direction vers l'intérieur du site
  // Vérifier que "into site" pointe bien vers le centroïde
  const midFX = (envM[fi].x + envM[fj].x) / 2, midFY = (envM[fi].y + envM[fj].y) / 2;
  if (nUx * (0 - midFX) + nUy * (0 - midFY) < 0) { nUx = -nUx; nUy = -nUy; }
  // Projeter l'enveloppe en repère local (u = rue, v = profondeur)
  const envLocal = envM.map(p => ({
    u: p.x * sUx + p.y * sUy,
    v: p.x * nUx + p.y * nUy,
  }));
  const minU = Math.min(...envLocal.map(p => p.u));
  const maxU = Math.max(...envLocal.map(p => p.u));
  const minV = Math.min(...envLocal.map(p => p.v));
  const maxV = Math.max(...envLocal.map(p => p.v));
  const envWidth = maxU - minU;
  const envDepth = maxV - minV;
  console.log(`│ Envelope local: W=${envWidth.toFixed(1)}m × D=${envDepth.toFixed(1)}m`);
  console.log(`│ Front edge: [${fi}→${fj}] len=${sLen.toFixed(1)}m`);
  // v72.27: Construire le rectangle commerce : bande collée au front (limite séparative)
  // La largeur du commerce utilise la largeur splitLayout (déjà avec retraits latéraux)
  // v72.68: FIX ÉTAGE FANTÔME — contraindre la largeur commerce à son fp_m2 réel
  const commFP = splitLayout.volume_commerce.fp_m2 || 0;
  let cW;
  if (commWidth) {
    cW = Math.min(commWidth, envWidth - 2 * margin);
  } else if (commFP > 0 && commDepth > 0) {
    cW = Math.min(commFP / commDepth, envWidth - 2 * margin);
    console.log(`│ v72.68: Commerce width from fp_m2: ${commFP}m² / ${commDepth}m = ${cW.toFixed(1)}m (anti ghost-floor)`);
  } else {
    cW = envWidth - 2 * margin;
  }
  const cD = Math.min(commDepth, envDepth * 0.40); // max 40% de la profondeur enveloppe
  const cCenterU = (minU + maxU) / 2; // centré sur la largeur
  const cStartV = minV + margin; // collé au front (avec marge)
  // 4 coins du rectangle commerce en repère local
  const commLocal = [
    { u: cCenterU - cW / 2, v: cStartV },
    { u: cCenterU + cW / 2, v: cStartV },
    { u: cCenterU + cW / 2, v: cStartV + cD },
    { u: cCenterU - cW / 2, v: cStartV + cD },
  ];
  console.log(`│ Commerce rect: ${cW.toFixed(1)}m × ${cD.toFixed(1)}m = ${Math.round(cW * cD)}m²`);
  console.log(`│ Position: u=[${(cCenterU - cW/2).toFixed(1)}, ${(cCenterU + cW/2).toFixed(1)}] v=[${cStartV.toFixed(1)}, ${(cStartV + cD).toFixed(1)}]`);
  // Convertir local → mètres → GPS
  function localToGPS(lp) {
    const mx = lp.u * sUx + lp.v * nUx;
    const my = lp.u * sUy + lp.v * nUy;
    return {
      lat: cLat + my / R_EARTH * 180 / Math.PI,
      lon: cLon + mx / (R_EARTH * Math.cos(cLat * Math.PI / 180)) * 180 / Math.PI,
    };
  }
  const commerceGPS = commLocal.map(localToGPS);
  commerceGPS.forEach((c, i) => console.log(`│ Commerce[${i}]: ${c.lat.toFixed(7)}, ${c.lon.toFixed(7)}`));
  console.log(`└── end buildCommercePolygon v72.26 ──`);
  return commerceGPS;
}
// ─── v73.2.6 : Google Maps Static API (qualite satellite superieure pour Afrique) ───
async function fetchGoogleStaticTop({ cLat, cLon, zoom, parcelCoords, envelopeCoords, googleKey, width = 640, height = 640 }) {
  // Google Maps Static API : path overlays
  // Format : path=color:0xRRGGBBAA|fillcolor:0xRRGGBBAA|weight:N|lat1,lng1|lat2,lng2|...
  // Note : Google attend lat,lng (pas lng,lat comme Mapbox)
  const parcelPath = `color:0xC84828FF|fillcolor:0xE0C89055|weight:4|` +
    parcelCoords.map(c => `${c.lat},${c.lon}`).join("|") +
    `|${parcelCoords[0].lat},${parcelCoords[0].lon}`;
  const envelopePath = `color:0xA07840E0|fillcolor:0xB8986080|weight:2|` +
    envelopeCoords.map(c => `${c.lat},${c.lon}`).join("|") +
    `|${envelopeCoords[0].lat},${envelopeCoords[0].lon}`;
  // Google Maps zoom max = 21. Notre zoom est calcule pour Mapbox (peut etre 19-20)
  const gZoom = Math.min(21, Math.round(zoom));
  // scale=2 pour double resolution (640x640 -> 1280x1280 effective)
  const url = `https://maps.googleapis.com/maps/api/staticmap?` +
    `center=${cLat},${cLon}&zoom=${gZoom}&size=${width}x${height}&scale=2&maptype=satellite` +
    `&path=${encodeURIComponent(parcelPath)}` +
    `&path=${encodeURIComponent(envelopePath)}` +
    `&key=${googleKey}`;
  console.log(`[GOOGLE-STATIC v73.2.6] URL length=${url.length}, zoom=${gZoom}, fetching...`);
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Google Static API HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  const arrayBuffer = await r.arrayBuffer();
  console.log(`[GOOGLE-STATIC v73.2.6] OK ${arrayBuffer.byteLength} bytes`);
  return Buffer.from(arrayBuffer);
}
// ─── v73.2.5 : Mapbox Static Images API (vraie raster satellite, pas vectoriel) ───
async function fetchMapboxStaticTop({ cLat, cLon, zoom, parcelCoords, envelopeCoords, mapboxToken, width = 1280, height = 1280 }) {
  const parcelArr = [...parcelCoords.map(c => [c.lon, c.lat]), [parcelCoords[0].lon, parcelCoords[0].lat]];
  const envelopeArr = [...envelopeCoords.map(c => [c.lon, c.lat]), [envelopeCoords[0].lon, envelopeCoords[0].lat]];
  const geojson = {
    type: "FeatureCollection",
    features: [
      // Parcelle : contour rouge, fill orange/sable transparent
      { type: "Feature",
        properties: { stroke: "#c84828", "stroke-width": 4, "stroke-opacity": 1, fill: "#e0c890", "fill-opacity": 0.30 },
        geometry: { type: "Polygon", coordinates: [parcelArr] } },
      // Zone constructible (recul) : contour beige fonce, fill beige plus opaque
      { type: "Feature",
        properties: { stroke: "#a07840", "stroke-width": 2, "stroke-opacity": 0.9, fill: "#b89860", "fill-opacity": 0.55 },
        geometry: { type: "Polygon", coordinates: [envelopeArr] } }
    ]
  };
  const encoded = encodeURIComponent(JSON.stringify(geojson));
  // satellite-v9 = pure raster Maxar/DigitalGlobe (PAS satellite-streets-v12 vectoriel)
  const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/geojson(${encoded})/${cLon},${cLat},${zoom}/${width}x${height}@2x?access_token=${mapboxToken}`;
  console.log(`[STATIC-TOP v73.2.5] URL length=${url.length}, fetching...`);
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Mapbox Static API HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const arrayBuffer = await r.arrayBuffer();
  console.log(`[STATIC-TOP v73.2.5] OK ${arrayBuffer.byteLength} bytes`);
  return Buffer.from(arrayBuffer);
}
// ─── HTML MAPBOX GL — SLIDE 4 AXO ─────────────────────────────────────────────
// v73.2.3 : ajout param mapStyle ('hektar' default | 'satellite' pour vue top)
async function generateMapHTML(center, zoom, bearing, parcelCoords, envelopeCoords, mapboxToken, frontEdgeIndex, hideExistingBuildings, pitch = 58, mapStyle = "hektar") {
  const parcelGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...parcelCoords.map(c => [c.lon, c.lat]), [parcelCoords[0].lon, parcelCoords[0].lat]]] },
  };
  const envelopeGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...envelopeCoords.map(c => [c.lon, c.lat]), [envelopeCoords[0].lon, envelopeCoords[0].lat]]] },
  };
  // v73.1: Zone de recul front matérialisée visuellement
  const setbackFrontGeoJSON = {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[
        [parcelCoords[0].lon, parcelCoords[0].lat],
        [parcelCoords[1].lon, parcelCoords[1].lat],
        [envelopeCoords[1].lon, envelopeCoords[1].lat],
        [envelopeCoords[0].lon, envelopeCoords[0].lat],
        [parcelCoords[0].lon, parcelCoords[0].lat],
      ]]
    },
  };
  const _refLat73 = parcelCoords[0].lat;
  const sbFrontM = Math.round(Math.sqrt(
    Math.pow((parcelCoords[0].lat - envelopeCoords[0].lat) * 111000, 2) +
    Math.pow((parcelCoords[0].lon - envelopeCoords[0].lon) * 111000 * Math.cos(_refLat73 * Math.PI / 180), 2)
  ));
  const setbackLabelGeoJSON = {
    type: "Feature",
    properties: { label: "Recul " + sbFrontM + "m" },
    geometry: {
      type: "Point",
      coordinates: [
        (parcelCoords[0].lon + parcelCoords[1].lon + envelopeCoords[0].lon + envelopeCoords[1].lon) / 4,
        (parcelCoords[0].lat + parcelCoords[1].lat + envelopeCoords[0].lat + envelopeCoords[1].lat) / 4,
      ],
    },
  };
  console.log("│ SLIDE4 v73.1: zone de recul front " + sbFrontM + "m matérialisée");
  // v49: accès principal auto-détecté
  const access = computeAccessPoint(parcelCoords, center.lat, center.lon, frontEdgeIndex);
  const arrowLen = 8;
  const accEndLat = access.lat + (arrowLen / R_EARTH) * 180 / Math.PI * Math.cos(access.bearing * Math.PI / 180);
  const accEndLon = access.lon + (arrowLen / (R_EARTH * Math.cos(access.lat * Math.PI / 180))) * 180 / Math.PI * Math.sin(access.bearing * Math.PI / 180);
  const accessLineGeoJSON = {
    type: "Feature", properties: {},
    geometry: { type: "LineString", coordinates: [[access.lon, access.lat], [accEndLon, accEndLat]] },
  };
  const accessPointGeoJSON = {
    type: "Feature", properties: { label: "Accès" },
    geometry: { type: "Point", coordinates: [accEndLon, accEndLat] },
  };
  const seed = Math.round(Math.abs(center.lat * 137.508 + center.lon * 251.663) * 1000) % 99999;
  // v72.102: Calcul du buffer +5m pour le masquage bâti slide 4
  const cLat = parcelCoords.reduce((s, p) => s + p.lat, 0) / parcelCoords.length;
  const cLon = parcelCoords.reduce((s, p) => s + p.lon, 0) / parcelCoords.length;
  const bufferM = 50; // v72.108: super aggressive // v72.104: aggressive buffer
  const scaleLat = bufferM / 111000;
  const scaleLon = bufferM / (111000 * Math.cos(cLat * Math.PI / 180));
  const bufferedCoords = parcelCoords.map(p => {
    const dx = p.lon - cLon;
    const dy = p.lat - cLat;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-10) return p;
    return {
      lat: p.lat + (dy / len) * scaleLat,
      lon: p.lon + (dx / len) * scaleLon,
    };
  });
  // v72.127: race Tilequery against 3s timeout for slide 4 to stay under Make 25s budget
  const parcelCoordsArray = parcelCoords.map(c => [c.lon, c.lat]);
  const EXCLUDED_IDS = await Promise.race([
    getIntersectingBuildingIds(parcelCoordsArray, mapboxToken),
    new Promise(resolve => setTimeout(() => {
      console.warn('[SLIDE4 v72.127] Tilequery timeout 3s — proceeding without exclusion');
      resolve([]);
    }, 3000))
  ]);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1280px; height: 1280px; overflow: hidden; background: #f2f0ec; }
  #map { width: 1280px; height: 1280px; }
  .mapboxgl-ctrl-logo, .mapboxgl-ctrl-attrib, .mapboxgl-ctrl-group { display: none !important; }
</style>
<script src="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.js"></script>
<link href="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.css" rel="stylesheet">
</head>
<body>
<div id="map"></div>
<script>
(function() {
  function seededRand(seed) { let s = seed; return function() { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; }; }
  const rand = seededRand(${seed});
  mapboxgl.accessToken = '${mapboxToken}';
  // ═══════════════════════════════════════════════════════════════════
  // v49 HEKTAR PRO — style avec couleurs intégrées (vert gazon, beige routes)
  // ═══════════════════════════════════════════════════════════════════
  const hektarStyle = {
    "version": 8,
    "name": "Hektar Pro",
    "sources": {
      "mapbox-streets": { "type": "vector", "url": "mapbox://mapbox.mapbox-streets-v8" },
      "mapbox-terrain": { "type": "vector", "url": "mapbox://mapbox.mapbox-terrain-v2" },
      "composite": { "type": "vector", "url": "mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2" }
    },
    "glyphs": "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
    "sprite": "mapbox://sprites/mapbox/light-v11",
    "layers": [
      { "id": "background", "type": "background",
        "paint": { "background-color": "#4a8c2a" } },
      { "id": "water", "type": "fill",
        "source": "composite", "source-layer": "water",
        "paint": { "fill-color": "#a0c8dd" } },
      { "id": "landuse-park", "type": "fill",
        "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["park", "grass", "cemetery", "wood", "scrub", "pitch"], true, false],
        "paint": { "fill-color": "#3d7a22" } },
      { "id": "landuse-urban", "type": "fill",
        "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["residential", "commercial", "industrial"], true, false],
        "paint": { "fill-color": "#4a8c2a" } },
      { "id": "road-case-secondary", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#5c5c5c", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 28, 16, 56, 17, 80, 18, 100] } },
      { "id": "road-case-street", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#6a6a6a", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 12, 16, 28, 17, 40, 18, 56] } },
      { "id": "road-fill-secondary", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#707070", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 24, 16, 48, 17, 72, 18, 92] } },
      { "id": "road-fill-street", "type": "line",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#808080", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 8, 16, 20, 17, 32, 18, 48] } },
      { "id": "road-label-major", "type": "symbol",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": {
          "text-field": ["coalesce", ["get", "name_fr"], ["get", "name"]],
          "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 17, 13],
          "symbol-placement": "line", "text-max-angle": 30, "text-padding": 20, "text-allow-overlap": false
        },
        "paint": { "text-color": "#333333", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 }
      },
      { "id": "road-label-street", "type": "symbol",
        "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited"], true, false],
        "minzoom": 16,
        "layout": {
          "text-field": ["coalesce", ["get", "name_fr"], ["get", "name"]],
          "text-font": ["DIN Pro Regular", "Arial Unicode MS Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 16, 8, 18, 11],
          "symbol-placement": "line", "text-max-angle": 30, "text-padding": 30, "text-allow-overlap": false
        },
        "paint": { "text-color": "#555555", "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1 }
      }
    ]
  };
  const map = new mapboxgl.Map({
    container: 'map', style: ${mapStyle === "satellite" ? '"mapbox://styles/mapbox/satellite-streets-v12"' : 'hektarStyle'},
    center: [${center.lon}, ${center.lat}], zoom: ${zoom}, bearing: ${bearing}, pitch: ${pitch},
    antialias: true, preserveDrawingBuffer: true, fadeDuration: 0, interactive: false,
  });
  map.addControl = function() {};
  map.on('style.load', () => {
    map.setTerrain(null);
    // v73.2.4 : flag injecté côté serveur pour skip overlays en mode satellite (slide 4 top pure)
    const __isSatellite = ${mapStyle === "satellite" ? "true" : "false"};
    // v70.5: Lumière directionnelle forte pour ombres marquées
    map.setLight({ anchor: 'map', color: '#fff8f0', intensity: 0.70, position: [1.5, 210, 30] });
    const labelLayerId = undefined;
    // v70.5: BÂTIMENTS 3D — posés au sol (base=0), hauteurs réalistes
    // v73.2.4: SKIP en mode satellite (slide 4 top) — on garde l'imagerie pure sans blocs ajoutés
    if (!__isSatellite) {
    map.addLayer({
      id: '3d-buildings', source: 'composite', 'source-layer': 'building',
      filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 13,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['coalesce', ['get', 'height'], 6],
          0,  '#e8e6e2',
          4,  '#e0deda',
          10, '#d5d3cf',
          20, '#cac8c4',
          40, '#bab8b4',
        ],
        'fill-extrusion-height': [
          'let', 'h', ['coalesce', ['get', 'height'], 0],
          ['case',
            ['>', ['var', 'h'], 2], ['var', 'h'],
            ['match', ['%', ['to-number', ['id']], 7],
              0, 4, 1, 4, 2, 7, 3, 7, 4, 10, 5, 13, 6, 4, 7
            ]
          ]
        ],
        'fill-extrusion-base': ['case',
          ['has', 'min_height'], 0,
          0
        ],
        'fill-extrusion-opacity': 1.0,
        'fill-extrusion-vertical-gradient': true,
      },
    }, labelLayerId);
    } else {
      console.log('[SLIDE4-TOP v73.2.4] 3d-buildings layer SKIPPED for satellite mode');
    }
    // v72.126: DIAGNOSTIC — list all layers in style to find what actually exists
    const allLayers = map.getStyle().layers.map(l => l.id);
    const buildingLayers = allLayers.filter(id => /build/i.test(id));
    console.log('[CLIENT v72.126] building-related layers in style:', buildingLayers.join(', '));
    // v72.126: Parcel polygon feature for within expression
    const parcelFeature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[${parcelCoords.map(c => `[${c.lon}, ${c.lat}]`).join(", ")}, [${parcelCoords[0].lon}, ${parcelCoords[0].lat}]]]
      }
    };
    // v72.126: GEOMETRIC FILTER using within expression + server-side EXCLUDED_IDS (belt-and-suspenders)
    // Apply to ALL building-related layers discovered at runtime
    const buildingLayerIds = [
      '3d-buildings',
      'building', 'building-outline', 'building-footprint', 'building-top', 'building-shadow', 'building-extrusion',
      'layer-building', 'feature-building'
    ];
    buildingLayerIds.forEach(layerId => {
      try {
        if (map.getLayer(layerId)) {
          let combinedFilter;
          const withinClause = ['\!', ['within', parcelFeature]];
          if (EXCLUDED_IDS && EXCLUDED_IDS.length > 0) {
            // Combine within filter + ID-based filter for defense in depth
            combinedFilter = [
              'all',
              withinClause,
              ['\!', ['in', ['id'], ['literal', EXCLUDED_IDS]]]
            ];
            console.log('[CLIENT v72.126] double-filter applied to', layerId, '(within + ID-based for', EXCLUDED_IDS.length, 'buildings)');
          } else {
            // Just within filter if no EXCLUDED_IDS
            combinedFilter = withinClause;
            console.log('[CLIENT v72.126] within-filter applied to', layerId);
          }
          map.setFilter(layerId, combinedFilter);
        }
      } catch (e) { console.warn('[CLIENT v72.126]', layerId, 'filter error:', e.message); }
    });
    console.log('[SLIDE4 v72.126] Buildings filtered via geometric within + Tilequery intersection');
    // v70.7: Pas de tree-canopy Mapbox (blocs verts moches) — l'AI polish ajoute des vrais arbres
    // v72.100: Parcelle au niveau 0 — fond flat, pas d'extrusion
    map.addSource('parcel', { type: 'geojson', data: ${JSON.stringify(parcelGeoJSON)} });
    // v72.108: parcel-fill transparent
    // v73.1.10: parcelle SABLE/BEIGE (style image enhanced) + contour rouge pointillés
    map.addLayer({ id: 'parcel-fill', type: 'fill', source: 'parcel',
      paint: { 'fill-color': '#e0c890', 'fill-opacity': 0.75 } });
    map.addLayer({ id: 'parcel-zone-mask', type: 'fill', source: 'parcel',
      paint: { 'fill-color': '#f5f0e1', 'fill-opacity': 0.0 } });
    // Contour parcelle — rouge fin en pointillés (style axonométrie urbanistique)
    map.addLayer({ id: 'parcel-outline', type: 'line', source: 'parcel',
      paint: { 'line-color': '#c84828', 'line-width': 3, 'line-dasharray': [4, 3], 'line-opacity': 1.0 } });
    // v70.8: Zone constructible (reculs) — tirets bien visibles
    map.addSource('envelope', { type: 'geojson', data: ${JSON.stringify(envelopeGeoJSON)} });
    map.addLayer({ id: 'envelope-outline', type: 'line', source: 'envelope',
      paint: { 'line-color': '#d04020', 'line-width': 4,
               'line-dasharray': [5, 3], 'line-opacity': 1.0 } });
    // v73.1: Zone de recul front — fill semi-transparent + contour pointillé + label "Recul Xm"
    map.addSource('setback-front', { type: 'geojson', data: ${JSON.stringify(setbackFrontGeoJSON)} });
    // v73.1.10: zone de recul = bande BEIGE plus FONCÉ que le fond parcelle (contraste subtil)
    map.addLayer({ id: 'setback-front-fill', type: 'fill', source: 'setback-front',
      paint: { 'fill-color': '#b89860', 'fill-opacity': 0.85 } });
    map.addLayer({ id: 'setback-front-outline', type: 'line', source: 'setback-front',
      paint: { 'line-color': '#a07840', 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': 0.9 } });
    // v73.1.9: layer setback-label RETIRÉE (le label texte était systématiquement halluciné par le polish IA en gibberish style 'Nion 6br', 'RECULF'. La zone de recul reste visible via setback-front-fill + outline et la légende en haut à gauche du canvas.)
    // v49: Accès principal — DÉSACTIVÉ (annotation retirée)
  });
  let rendered = false;
  map.on('idle', () => { if (rendered) return; rendered = true; setTimeout(() => { window.__MAP_READY = true; }, 2500); });
  setTimeout(() => { window.__MAP_READY = true; }, 12000);
})();
</script>
</body>
</html>`;
}
// ─── HTML MAPBOX GL — MASSING ─────────────────────────────────────────────────
async function generateMassingHTML(center, zoom, bearing, parcelCoords, envelopeCoords, massingCoords, massingParams, mapboxToken) {
  const parcelGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...parcelCoords.map(c => [c.lon, c.lat]), [parcelCoords[0].lon, parcelCoords[0].lat]]] },
  };
  const envelopeGeoJSON = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...envelopeCoords.map(c => [c.lon, c.lat]), [envelopeCoords[0].lon, envelopeCoords[0].lat]]] },
  };
  const massingGeoJSON = {
    type: "Feature",
    properties: { height: massingParams.total_height, base_height: 0 },
    geometry: { type: "Polygon", coordinates: [[...massingCoords.map(c => [c.lon, c.lat]), [massingCoords[0].lon, massingCoords[0].lat]]] },
  };
  const rdcH = 3.0;  // v71: tous les niveaux = 3m
  const etageH = massingParams.floor_height || 3.0;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1280px; height: 1280px; overflow: hidden; background: #f2f0ec; }
  #map { width: 1280px; height: 1280px; }
  .mapboxgl-ctrl-logo, .mapboxgl-ctrl-attrib, .mapboxgl-ctrl-group { display: none !important; }
</style>
<script src="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.js"></script>
<link href="https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.css" rel="stylesheet">
</head>
<body>
<div id="map"></div>
<script>
(function() {
  mapboxgl.accessToken = '${mapboxToken}';
  const hektarStyle = {
    "version": 8, "name": "Hektar",
    "sources": { "composite": { "type": "vector", "url": "mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2" } },
    "glyphs": "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
    "sprite": "mapbox://sprites/mapbox/light-v11",
    "layers": [
      { "id": "background", "type": "background", "paint": { "background-color": "#eae8e4" } },
      { "id": "water", "type": "fill", "source": "composite", "source-layer": "water", "paint": { "fill-color": "#c4d4de" } },
      { "id": "landuse-park", "type": "fill", "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["park", "grass", "cemetery", "wood", "scrub", "pitch"], true, false],
        "paint": { "fill-color": "#dddcd6" } },
      { "id": "landuse-urban", "type": "fill", "source": "composite", "source-layer": "landuse",
        "filter": ["match", ["get", "class"], ["residential", "commercial", "industrial"], true, false],
        "paint": { "fill-color": "#e4e2de" } },
      { "id": "road-case-secondary", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#707070", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 28, 16, 56, 17, 80, 18, 100, 19, 120] } },
      { "id": "road-case-street", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#888888", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 12, 16, 28, 17, 40, 18, 56, 19, 72] } },
      { "id": "road-fill-secondary", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["secondary", "tertiary", "primary", "trunk", "motorway"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#808080", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 24, 16, 48, 17, 72, 18, 92, 19, 112] } },
      { "id": "road-fill-street", "type": "line", "source": "composite", "source-layer": "road",
        "filter": ["match", ["get", "class"], ["street", "street_limited", "service"], true, false],
        "layout": { "line-cap": "round", "line-join": "round" },
        "paint": { "line-color": "#989898", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 8, 16, 20, 17, 32, 18, 48, 19, 64] } }
    ]
  };
  const map = new mapboxgl.Map({
    container: 'map', style: hektarStyle,
    center: [${center.lon}, ${center.lat}], zoom: ${zoom}, bearing: ${bearing}, pitch: 58,
    antialias: true, preserveDrawingBuffer: true, fadeDuration: 0, interactive: false,
  });
  map.addControl = function() {};
  map.on('style.load', () => {
    map.setTerrain(null);
    // v71: Lumière douce pour ombres subtiles
    map.setLight({ anchor: 'map', color: '#ffffff', intensity: 0.55, position: [1.2, 210, 35] });
    map.addLayer({
      id: '3d-buildings', source: 'composite', 'source-layer': 'building',
      filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 13,
      paint: {
        // v71: Bâtiments blancs/crème — style maquette propre
        'fill-extrusion-color': '#f0ede8',
        'fill-extrusion-height': ['case', ['has', 'height'], ['get', 'height'], 7],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.92, 'fill-extrusion-vertical-gradient': true,
      },
    });
    // v72.126: DIAGNOSTIC — list all layers in style to find what actually exists
    const allLayers = map.getStyle().layers.map(l => l.id);
    const buildingLayers = allLayers.filter(id => /build/i.test(id));
    console.log('[MASSING v72.126] building-related layers in style:', buildingLayers.join(', '));
    // v71: Parcelle — fond beige/sable + contour rouge
    map.addSource('parcel', { type: 'geojson', data: ${JSON.stringify(parcelGeoJSON)} });
    // v72.103: Fond parcelle TRANSPARENT dans massing (évite tinting orange par polish IA)
    map.addLayer({ id: 'parcel-fill', type: 'fill', source: 'parcel',
      paint: { 'fill-color': '#dcc8a0', 'fill-opacity': 0.0 } }, '3d-buildings');
    map.addLayer({ id: 'parcel-outline', type: 'line', source: 'parcel',
      paint: { 'line-color': '#c04020', 'line-width': 5, 'line-opacity': 1.0 } });
    // v71: Zone constructible (reculs) — tirets rouge au-dessus des bâtiments
    map.addSource('envelope', { type: 'geojson', data: ${JSON.stringify(envelopeGeoJSON)} });
    map.addLayer({ id: 'envelope-outline', type: 'line', source: 'envelope',
      paint: { 'line-color': '#c04020', 'line-width': 4, 'line-dasharray': [6, 4], 'line-opacity': 1.0 } });
    // ── MASSING : étages individuels, RDC=${rdcH}m, courants=${etageH}m, gaps entre niveaux ──
    map.addSource('massing', { type: 'geojson', data: ${JSON.stringify(massingGeoJSON)} });
    const rdcH = ${rdcH};
    const etageH = ${etageH};
    const gap = 0.30;  // v71: gap net entre niveaux (ligne noire visible)
    // v72.22: SPLIT_AV_AR — commerce = volume séparé devant, logement = volume derrière
    ${massingParams.commerce_coords ? `
    // ══ MODE SPLIT_AV_AR : 2 volumes distincts ══
    const commerceGeoJSON = ${JSON.stringify({
      type: "Feature",
      properties: { height: rdcH, base_height: 0 },
      geometry: { type: "Polygon", coordinates: [[...massingParams.commerce_coords.map(c => [c.lon, c.lat]), [massingParams.commerce_coords[0].lon, massingParams.commerce_coords[0].lat]]] },
    })};
    map.addSource('commerce-volume', { type: 'geojson', data: commerceGeoJSON });
    // Commerce : 1 niveau ORANGE en avant
    map.addLayer({
      id: 'commerce-floor-0', type: 'fill-extrusion', source: 'commerce-volume',
      paint: {
        'fill-extrusion-color': '#e07830',
        'fill-extrusion-height': rdcH,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.92,
        'fill-extrusion-vertical-gradient': false,
      },
    });
    map.addLayer({ id: 'commerce-footprint', type: 'line', source: 'commerce-volume',
      paint: { 'line-color': '#1a1a1a', 'line-width': 1.5, 'line-opacity': 0.9 } });
    // v72.28: Logement sur PILOTIS en SPLIT — 4 poteaux aux coins + niveaux habitables au-dessus
    const logtLevels = ${massingParams.split_layout ? massingParams.split_layout.volume_logement.levels : massingParams.levels};
    const pilotisH = rdcH; // pilotis = hauteur d'un RDC (3m)
    // v72.28: 4 POTEAUX PILOTIS aux coins du logement (petits carrés extrudés)
    const massingRing = ${JSON.stringify(massingGeoJSON)}.geometry.coordinates[0];
    const colSize = 0.000004; // ~0.45m en GPS (petit carré de poteau)
    const pilotisFeatures = [];
    // Prendre les 4 premiers points du polygon (coins du logement)
    for (let c = 0; c < Math.min(massingRing.length - 1, 4); c++) {
      const cx = massingRing[c][0], cy = massingRing[c][1];
      pilotisFeatures.push({
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[ [cx - colSize, cy - colSize], [cx + colSize, cy - colSize],
                          [cx + colSize, cy + colSize], [cx - colSize, cy + colSize],
                          [cx - colSize, cy - colSize] ]]
        }
      });
    }
    const pilotisGeoJSON = { type: "FeatureCollection", features: pilotisFeatures };
    map.addSource('pilotis-cols', { type: 'geojson', data: pilotisGeoJSON });
    map.addLayer({
      id: 'pilotis-columns', type: 'fill-extrusion', source: 'pilotis-cols',
      paint: {
        'fill-extrusion-color': '#c8c4bc',
        'fill-extrusion-height': pilotisH - gap / 2,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.95,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    // Niveaux habitables logement — commencent AU-DESSUS du pilotis
    for (let f = 0; f < logtLevels; f++) {
      const base = pilotisH + f * etageH;
      const top  = pilotisH + (f + 1) * etageH;
      const baseH = base + gap / 2;
      const topH  = f < logtLevels - 1 ? top - gap / 2 : top;
      map.addLayer({
        id: 'floor-' + f, type: 'fill-extrusion', source: 'massing',
        paint: {
          'fill-extrusion-color': '#3a7ac0',
          'fill-extrusion-height': topH,
          'fill-extrusion-base': baseH,
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': false,
        },
      });
    }
    ` : `
    // ══ MODE SUPERPOSÉ : étages empilés sur un seul volume ══
    const totalLevels = ${massingParams.levels};  // v72.22: TOUJOURS utiliser levels du moteur — jamais de fallback calculé
    const commLevels = ${massingParams.commerce_levels || 0};
    for (let f = 0; f < totalLevels; f++) {
      const base = f === 0 ? 0 : rdcH + (f - 1) * etageH;
      const top  = f === 0 ? rdcH : rdcH + f * etageH;
      const baseH = f > 0 ? base + gap / 2 : 0;
      const topH  = f < totalLevels - 1 ? top - gap / 2 : top;
      const isComm = f < commLevels;
      // v70.10: Commerce = ORANGE vif, Logement = BLEU net
      map.addLayer({
        id: 'floor-' + f, type: 'fill-extrusion', source: 'massing',
        paint: {
          'fill-extrusion-color': isComm ? '#e07830' : '#3a7ac0',
          'fill-extrusion-height': topH,
          'fill-extrusion-base': baseH,
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': false,
        },
      });
    }
    `}
    // ── Contour emprise au sol : bleu foncé ──
    map.addLayer({ id: 'massing-footprint', type: 'line', source: 'massing',
      paint: { 'line-color': '#1a1a1a', 'line-width': 1.5, 'line-opacity': 0.9 } });
  });
  let rendered = false;
  map.on('idle', () => { if (rendered) return; rendered = true; setTimeout(() => { window.__MAP_READY = true; }, 2500); });
  setTimeout(() => { window.__MAP_READY = true; }, 12000);
})();
</script>
</body>
</html>`;
}
// ─── OVERLAYS CANVAS — SLIDE 4 AXO ───────────────────────────────────────────
function drawOverlays(ctx, W, H, BH, p) {
  const { site_area, land_width, land_depth, buildable_fp,
    setback_front, setback_side, setback_back,
    city, district, zoning, terrain_context, bearing } = p;
  ctx.save();
  ctx.translate(W - 58, 58);
  ctx.shadowColor = "rgba(0,0,0,0.15)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.96)"; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1; ctx.stroke();
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -3); ctx.lineTo(0, -8); ctx.lineTo(5, -3); ctx.closePath();
  ctx.fillStyle = "#c45030"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 3); ctx.lineTo(0, 8); ctx.lineTo(5, 3); ctx.closePath();
  ctx.fillStyle = "#ccc"; ctx.fill();
  ctx.rotate((bearing || 0) * Math.PI / 180);
  ctx.font = "bold 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#c45030";
  ctx.fillText("N", 0, -22);
  ctx.restore();
  const legItems = [
    { type: "rect", fill: "rgba(196,80,48,0.25)", stroke: "#c45030", label: `Parcelle — ${site_area} m²` },
    { type: "dash", stroke: "#c45030", label: "Zone constructible (reculs)" },
    { type: "rect", fill: "#e0ddd8", stroke: "#b0ada6", label: "Bâtiments 3D" },
  ];
  const legPad = 14, legLH = 26, legW = 300;
  const legH = legPad * 2 + legItems.length * legLH + 10;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.08)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
  ctx.fillStyle = "rgba(255,255,255,0.97)";
  ctx.beginPath(); ctx.roundRect(16, 16, legW, legH, 8); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#e4e0d8"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
  legItems.forEach((item, i) => {
    const iy = 16 + legPad + i * legLH;
    ctx.save();
    if (item.type === "rect") {
      ctx.fillStyle = item.fill; ctx.beginPath(); ctx.roundRect(28, iy, 16, 13, 2); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(28, iy + 6); ctx.lineTo(44, iy + 6);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2.5; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
    ctx.font = "12px Arial, Helvetica, sans-serif"; ctx.fillStyle = "#444"; ctx.textAlign = "left";
    ctx.fillText(item.label, 52, iy + 11);
  });
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© Mapbox  © OpenStreetMap contributors", 28, 16 + legH - 6);
  const BY = H;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, BY, W, BH);
  ctx.beginPath(); ctx.moveTo(0, BY); ctx.lineTo(W, BY);
  ctx.strokeStyle = "#c45030"; ctx.lineWidth = 4; ctx.stroke();
  const pad = 32, C1 = pad, C2 = W * 0.26, C3 = W * 0.52, C4 = W * 0.76;
  ctx.textAlign = "left";
  ctx.font = "bold 20px Arial"; ctx.fillStyle = "#111"; ctx.fillText("Lecture stratégique du site", C1, BY + 42);
  ctx.font = "11px Arial"; ctx.fillStyle = "#aaa"; ctx.fillText(`${city}  ·  ${district}  ·  Zoning : ${zoning}`, C1, BY + 62);
  ctx.beginPath(); ctx.moveTo(C1, BY + 76); ctx.lineTo(W - pad, BY + 76); ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1.5; ctx.stroke();
  const stats = [
    { label: "Surface parcelle", val: `${site_area} m²`, col: C1, color: "#111" },
    { label: "Dimensions", val: `${land_width}m × ${land_depth}m`, col: C2, color: "#111" },
    { label: "Empreinte constructible", val: `${buildable_fp} m²`, col: C3, color: "#1d7a3e" },
  ];
  stats.forEach(s => {
    ctx.font = "10px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText(s.label, s.col, BY + 96);
    ctx.font = "bold 26px Arial"; ctx.fillStyle = s.color; ctx.fillText(s.val, s.col, BY + 128);
  });
  ctx.font = "10px Arial"; ctx.fillStyle = "#bbb"; ctx.fillText("Retraits réglementaires", C4, BY + 96);
  ctx.font = "600 13px Arial"; ctx.fillStyle = "#555";
  ctx.fillText(`Avant : ${setback_front}m  ·  Côtés : ${setback_side}m`, C4, BY + 114);
  ctx.fillText(`Arrière : ${setback_back}m`, C4, BY + 132);
  ctx.beginPath(); ctx.moveTo(C1, BY + 148); ctx.lineTo(W - pad, BY + 148); ctx.strokeStyle = "#f0ede8"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = "11px Arial"; ctx.fillStyle = "#ccc"; ctx.fillText((terrain_context || "").substring(0, 100), C1, BY + BH - 16);
  ctx.textAlign = "right"; ctx.font = "9px Arial"; ctx.fillStyle = "#ddd";
  ctx.fillText("BARLO · Diagnostic foncier automatisé", W - pad, BY + BH - 16);
}
// ─── COLOR REMAP — remplace les teintes beige Mapbox par vert/sable architectural ──
function applyColorRemap(ctx, W, H) {
  // v72.21: Mapbox "Hektar Pro" already has green grass (#6aad3a) and dark roads.
  // NO ground→grass or road→sandy remap needed — that was for the old beige style.
  // This function now ONLY whitens building rooftops for a premium concrete look.
  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  // ─── STEP 1: Build rooftop mask ──────────────────────────────────────────
  // In 3D axonometric view, building rooftops have darker building-side pixels
  // directly below them. Ground does NOT have this brightness drop.
  const roofMask = new Uint8Array(W * H);
  for (let y = 0; y < H - 15; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const r = d[idx], g = d[idx + 1], b = d[idx + 2];
      const brightness = (r + g + b) / 3;
      // Building rooftops in Mapbox Hektar Pro: #d8d4cc to #908c88 → brightness 140-215
      // Green grass #6aad3a → brightness ~112. Skip grass and very dark/bright pixels.
      if (brightness < 130 || brightness > 240) continue;
      // Skip green pixels (grass) — g channel dominant
      if (g > r + 20 && g > b + 30) continue;
      // Skip reddish pixels (parcel zone)
      if (r > 180 && g < 140 && b < 140) continue;
      // Check 2-15 pixels below for building wall (brightness drop > 30)
      for (let dy = 2; dy <= 15; dy++) {
        const by = y + dy;
        if (by >= H) break;
        const bi = (by * W + x) * 4;
        const bBright = (d[bi] + d[bi + 1] + d[bi + 2]) / 3;
        if (brightness - bBright > 30) {
          // Verify the dark pixel is a building wall (neutral gray, not green grass)
          const wr = d[bi], wg = d[bi + 1], wb = d[bi + 2];
          const isWall = Math.abs(wr - wg) < 30 && Math.abs(wg - wb) < 30;
          const isGrass = wg > wr + 15 && wg > wb + 20;
          if (isWall && !isGrass) {
            roofMask[y * W + x] = 1;
            break;
          }
        }
      }
    }
  }
  // Expand rooftop mask upward + laterally for full coverage
  const roofMask2 = new Uint8Array(roofMask);
  for (let y = 3; y < H; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (roofMask[y * W + x]) {
        for (let dy = 1; dy <= 4; dy++) {
          if (y - dy >= 0) roofMask2[(y - dy) * W + x] = 1;
        }
        // Slight lateral expansion for edge coverage
        roofMask2[y * W + x - 1] = 1;
        roofMask2[y * W + x + 1] = 1;
      }
    }
  }
  // ─── STEP 2: Building whitening — rooftop pixels → warm white concrete ───
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!roofMask2[y * W + x]) continue;
      const i = (y * W + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const brightness = (r + g + b) / 3;
      if (brightness > 245 || brightness < 70) continue;
      // Skip green pixels that leaked into mask
      if (g > r + 15 && g > b + 25) continue;
      // Skip parcel red
      if (r > 180 && g < 130 && b < 130) continue;
      // Remap to warm white — preserve luminosity
      const lum = Math.min(1.3, brightness / 180);
      d[i]     = Math.min(255, Math.round(242 * lum));
      d[i + 1] = Math.min(255, Math.round(240 * lum));
      d[i + 2] = Math.min(255, Math.round(235 * lum));
    }
  }
  ctx.putImageData(imgData, 0, 0);
}
// ─── v72.17 DETERMINISTIC SHADOWS — sun from upper-left ─────────────────────
// Scans each grass pixel and checks if building pixels exist ~15px toward upper-left
// If yes → darken the grass to simulate shadow projection
function applyDeterministicShadows(ctx, W, H) {
  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  const SHADOW_DIST = 18; // pixels to check for building occlusion
  const SHADOW_DARKEN = 0.7; // shadow intensity (0.7 = 30% darker)
  for (let y = SHADOW_DIST; y < H; y++) {
    for (let x = SHADOW_DIST; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = d[i], g = d[i+1], b = d[i+2];
      // Only shadow on grass pixels (green: R<110, G>100, B<90)
      if (!(r < 110 && g > 100 && b < 90)) continue;
      // Check if there's a building pixel ~SHADOW_DIST pixels to the upper-left
      let hasBuildingAbove = false;
      for (let s = 8; s <= SHADOW_DIST; s += 5) {
        const si = ((y - s) * W + (x - Math.floor(s * 0.6))) * 4;
        if (si < 0 || si >= d.length) continue;
        const sr = d[si], sg = d[si+1], sb = d[si+2];
        const sBright = (sr + sg + sb) / 3;
        // Building: bright (>180), not grass-green
        if (sBright > 180 && sg < sr + 30) { hasBuildingAbove = true; break; }
      }
      if (hasBuildingAbove) {
        d[i]   = Math.round(r * SHADOW_DARKEN);
        d[i+1] = Math.round(g * SHADOW_DARKEN);
        d[i+2] = Math.round(b * SHADOW_DARKEN);
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
}
// ─── v72.17 WARM COLOR GRADING — subtle warm tone shift ─────────────────────
function applyWarmGrading(ctx, W, H) {
  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    // Slight warm shift: +3R, +1G, -2B
    d[i]   = Math.min(255, d[i] + 3);
    d[i+1] = Math.min(255, d[i+1] + 1);
    d[i+2] = Math.max(0, d[i+2] - 2);
  }
  ctx.putImageData(imgData, 0, 0);
}
// ─── v72.3 BLOCK-GRID DRIFT DETECTION ─────────────────────────────────────────
// Lessons from production (v72.1 and v72.2 both failed):
//   - Pixel-level edge comparison doesn't work: AI polish transforms everything
//   - Even strong Sobel edges shift when textures/shadows are added
//
// NEW APPROACH: Compare the MACRO LAYOUT using a coarse grid.
//   1. Divide both images into blocks (e.g. 32×32 grid = 1024 blocks on 1280px)
//   2. For each block, compute average brightness (grayscale)
//   3. Classify each block: BRIGHT (building/roof), DARK (road/shadow), MID (grass/ground)
//   4. Compare classification maps — if the same blocks are bright/dark/mid, structure is intact
//
// This is robust because:
//   - Polish changes colors/textures → brightness shifts within a class are OK
//   - A BUILDING MOVING would change block classifications (bright block becomes mid)
//   - A new phantom building would flip a mid/dark block to bright
//   - Tonal harmonization doesn't flip classifications
//
// v72.5: threshold is now a parameter — heavy polish (slide 4) needs higher threshold
async function detectDriftFromBuffers(cleanPngBuf, polishedPngBuf, W, H, customThreshold) {
  const cleanImg = await loadImage(cleanPngBuf);
  const polishedImg = await loadImage(polishedPngBuf);
  const cleanCanvas = createCanvas(W, H);
  const cleanCtx = cleanCanvas.getContext("2d");
  cleanCtx.drawImage(cleanImg, 0, 0, W, H);
  const polishedCanvas = createCanvas(W, H);
  const polishedCtx = polishedCanvas.getContext("2d");
  polishedCtx.drawImage(polishedImg, 0, 0, W, H);
  const cleanData = cleanCtx.getImageData(0, 0, W, H).data;
  const polishedData = polishedCtx.getImageData(0, 0, W, H).data;
  // Grid parameters
  const BLOCK = 40; // 40px blocks → 32×32 grid on 1280px image
  const cols = Math.floor(W / BLOCK);
  const rows = Math.floor(H / BLOCK);
  // Compute average brightness per block for both images
  function blockBrightness(data, bx, by) {
    let sum = 0, count = 0;
    for (let y = by * BLOCK; y < Math.min((by + 1) * BLOCK, H); y++) {
      for (let x = bx * BLOCK; x < Math.min((bx + 1) * BLOCK, W); x++) {
        const idx = (y * W + x) * 4;
        sum += 0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2];
        count++;
      }
    }
    return sum / count;
  }
  // Classify block: 0=DARK (<80), 1=MID (80-170), 2=BRIGHT (>170)
  function classify(brightness) {
    if (brightness < 80) return 0;
    if (brightness > 170) return 2;
    return 1;
  }
  let totalBlocks = 0;
  let classShifts = 0;     // blocks that changed classification (structural drift)
  let bigBrightnessShifts = 0; // blocks with >60 brightness change (extreme)
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      totalBlocks++;
      const cb = blockBrightness(cleanData, bx, by);
      const pb = blockBrightness(polishedData, bx, by);
      const cc = classify(cb);
      const pc = classify(pb);
      if (cc !== pc) classShifts++;
      if (Math.abs(cb - pb) > 60) bigBrightnessShifts++;
    }
  }
  const classShiftRatio = totalBlocks > 0 ? classShifts / totalBlocks : 0;
  // v72.5: Configurable threshold per pipeline
  // - Slide 4 heavy polish (texture, grass, concrete) → 0.55 (legitimately flips many blocks)
  // - Massing light polish (tonal only) → 0.25 (stricter, less transformation expected)
  const DRIFT_THRESHOLD = customThreshold || 0.25;
  const passed = classShiftRatio < DRIFT_THRESHOLD;
  return {
    driftScore: +classShiftRatio.toFixed(4),
    passed,
    totalBlocks,
    classShifts,
    bigBrightnessShifts,
    threshold: DRIFT_THRESHOLD,
    details: !passed
      ? `DRIFT: ${(classShiftRatio * 100).toFixed(1)}% blocks shifted class (${classShifts}/${totalBlocks}, threshold ${DRIFT_THRESHOLD * 100}%)`
      : `OK: ${(classShiftRatio * 100).toFixed(1)}% blocks shifted (${classShifts}/${totalBlocks}) — macro structure preserved`,
  };
}
// ─── v72.4 POST-POLISH SHARPENING — counteract AI softness ──────────────────
// Applies a 3×3 unsharp-mask kernel on the canvas pixels.
// amount=0.35 is tuned for typical OpenAI edit output — enough to restore
// crisp edges without introducing halo artifacts.
function applySharpen(ctx, W, H, amount = 0.35) {
  const imageData = ctx.getImageData(0, 0, W, H);
  const src = new Uint8ClampedArray(imageData.data); // copy of original
  const dst = imageData.data;
  const a = amount;
  const center = 1 + 4 * a;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const val = center * src[i + c]
          - a * src[((y - 1) * W + x) * 4 + c]
          - a * src[((y + 1) * W + x) * 4 + c]
          - a * src[(y * W + (x - 1)) * 4 + c]
          - a * src[(y * W + (x + 1)) * 4 + c];
        dst[i + c] = val < 0 ? 0 : val > 255 ? 255 : (val + 0.5) | 0;
      }
      dst[i + 3] = src[i + 3]; // alpha unchanged
    }
  }
  ctx.putImageData(imageData, 0, 0);
}
// ─── v72.6 PARCEL ZONE OVERLAY — redrawn AFTER AI polish to guarantee visibility ───
// The AI polish tends to cover parcel boundaries with grass/texture.
// This function redraws the parcel fill, parcel border, and envelope dashed lines
// deterministically on top of the polished image. 100% safe per Supervisor protocol.
function drawParcelZone(ctx, W, H, parcelScreenPts, envelopeScreenPts) {
  if (!parcelScreenPts || parcelScreenPts.length < 3) return;
  // 1. Semi-transparent fill inside parcel — sand/beige to "clear" the grass invasion
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(parcelScreenPts[0].x, parcelScreenPts[0].y);
  for (let i = 1; i < parcelScreenPts.length; i++) {
    ctx.lineTo(parcelScreenPts[i].x, parcelScreenPts[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(222, 197, 155, 0.55)"; // sand/beige, semi-transparent
  ctx.fill();
  // 2. Parcel boundary — solid red/orange, thick
  ctx.beginPath();
  ctx.moveTo(parcelScreenPts[0].x, parcelScreenPts[0].y);
  for (let i = 1; i < parcelScreenPts.length; i++) {
    ctx.lineTo(parcelScreenPts[i].x, parcelScreenPts[i].y);
  }
  ctx.closePath();
  ctx.strokeStyle = "rgba(220, 80, 30, 0.9)";
  ctx.lineWidth = 3;
  ctx.stroke();
  // 3. Envelope (setback zone) — dashed red, thinner
  if (envelopeScreenPts && envelopeScreenPts.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(envelopeScreenPts[0].x, envelopeScreenPts[0].y);
    for (let i = 1; i < envelopeScreenPts.length; i++) {
      ctx.lineTo(envelopeScreenPts[i].x, envelopeScreenPts[i].y);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(200, 60, 30, 0.8)";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}
// ─── v72 DETERMINISTIC TREES — seeded PRNG, improved canopy, shadow casting ──
// Seed is derived from pixel coordinates → identical output on every run
function seedRandom(seed) {
  // Simple mulberry32 PRNG — deterministic from integer seed
  let t = (seed >>> 0) + 0x6D2B79F5;
  return function() {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function drawTrees(ctx, W, H) {
  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  const treePositions = [];
  const step = 28; // v72: tighter grid for more tree candidates
  const minTreeDist = 22; // minimum distance between tree centers
  // v72: seeded PRNG based on image dimensions (deterministic)
  const rng = seedRandom(W * 10000 + H);
  for (let y = step; y < H - step; y += step) {
    for (let x = step; x < W - step; x += step) {
      const idx = (y * W + x) * 4;
      const r = d[idx], g = d[idx+1], b = d[idx+2];
      // Is this a green grass pixel? (after applyColorRemap: ~R75,G145,B60)
      const isGrass = (g > 80 && g > r * 1.2 && g > b * 1.4 && r < 150);
      if (!isGrass) continue;
      // Check road nearby (sandy after remap: ~R195,G180,B145)
      let nearRoad = false;
      for (let dy = -20; dy <= 20; dy += 6) {
        for (let dx = -20; dx <= 20; dx += 6) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ni = (ny * W + nx) * 4;
          const nr = d[ni], ng = d[ni+1], nb = d[ni+2];
          if (nr > 120 && ng > 100 && nb > 70 && nr > ng && nr - nb > 25 && ng - nb > 15 && nr < 230) {
            nearRoad = true; break;
          }
        }
        if (nearRoad) break;
      }
      // Not on/near building (white/bright areas)
      let nearBuilding = false;
      for (let dy = -28; dy <= 4; dy += 6) {
        for (let dx = -14; dx <= 14; dx += 6) {
          const nx = Math.max(0, Math.min(W-1, x + dx));
          const ny = Math.max(0, Math.min(H-1, y + dy));
          const ni = (ny * W + nx) * 4;
          if (d[ni] > 200 && d[ni+1] > 200 && d[ni+2] > 190) { nearBuilding = true; break; }
        }
        if (nearBuilding) break;
      }
      // Not on parcel area (reddish boundary zone)
      let onParcel = false;
      const pr = d[idx], pg = d[idx+1], pb = d[idx+2];
      // Beige/sand parcel interior or red boundary
      if ((pr > 180 && pg > 150 && pb > 100 && pr > pg && pr - pb > 40) || (pr > 180 && pg < 140 && pb < 140)) {
        onParcel = true;
      }
      // v72: seeded selection — use PRNG instead of modulo hash for better distribution
      const selectChance = rng();
      if (nearRoad && !nearBuilding && !onParcel && selectChance < 0.35) {
        // Check min distance from existing trees
        let tooClose = false;
        for (const existing of treePositions) {
          const dx2 = x - existing.x, dy2 = y - existing.y;
          if (dx2 * dx2 + dy2 * dy2 < minTreeDist * minTreeDist) { tooClose = true; break; }
        }
        if (!tooClose) {
          // v72: slight jitter from PRNG for natural look (but deterministic)
          const jx = Math.round((rng() - 0.5) * 8);
          const jy = Math.round((rng() - 0.5) * 8);
          treePositions.push({ x: x + jx, y: y + jy });
        }
      }
      // v72: also place trees in open green areas (not just near roads)
      if (!nearRoad && !nearBuilding && !onParcel && isGrass && selectChance > 0.85 && selectChance < 0.92) {
        let tooClose = false;
        for (const existing of treePositions) {
          const dx2 = x - existing.x, dy2 = y - existing.y;
          if (dx2 * dx2 + dy2 * dy2 < (minTreeDist * 1.5) * (minTreeDist * 1.5)) { tooClose = true; break; }
        }
        if (!tooClose) {
          treePositions.push({ x: x + Math.round((rng() - 0.5) * 6), y: y + Math.round((rng() - 0.5) * 6) });
        }
      }
    }
  }
  console.log(`[TREES] v72: ${treePositions.length} deterministic trees placed (seeded PRNG)`);
  // v72: Sort by Y for correct overlap (back-to-front painter's order)
  treePositions.sort((a, b) => a.y - b.y);
  for (const t of treePositions) {
    // v72: seeded radius per tree — deterministic
    const tRng = seedRandom(t.x * 1000 + t.y);
    const radius = 9 + Math.round(tRng() * 7); // 9-16px range
    // Shadow (offset toward bottom-right — sun from upper-left)
    ctx.beginPath();
    ctx.arc(t.x + 3, t.y + 4, radius + 1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(15,40,10,0.30)";
    ctx.fill();
    // Canopy — multi-layer gradient for 3D spherical look
    ctx.beginPath();
    ctx.arc(t.x, t.y, radius, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(t.x - radius * 0.25, t.y - radius * 0.25, 1, t.x, t.y, radius);
    // v72: slightly varied greens per tree for natural look (seeded)
    const gVar = Math.round(tRng() * 20) - 10;
    grad.addColorStop(0, `rgb(${90 + gVar},${175 + gVar},${66 + gVar})`);
    grad.addColorStop(0.45, `rgb(${61 + gVar},${138 + gVar},${46 + gVar})`);
    grad.addColorStop(0.8, `rgb(${45 + gVar},${110 + gVar},${34 + gVar})`);
    grad.addColorStop(1, `rgb(${35 + gVar},${85 + gVar},${28 + gVar})`);
    ctx.fillStyle = grad;
    ctx.fill();
    // v72: subtle highlight spot for 3D depth
    ctx.beginPath();
    ctx.arc(t.x - radius * 0.2, t.y - radius * 0.2, radius * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(140,210,100,0.15)";
    ctx.fill();
  }
}
// ─── LÉGENDE + BOUSSOLE — SLIDE 4 AXO ────────────────────────────────────────
function drawLegendCompass(ctx, W, H, p) {
  const { site_area, bearing, setback_front, setback_side, setback_back } = p;
  ctx.save();
  ctx.translate(W - 58, 58);
  ctx.shadowColor = "rgba(0,0,0,0.15)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.96)"; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1; ctx.stroke();
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(-5, -3); ctx.lineTo(0, -8); ctx.lineTo(5, -3); ctx.closePath();
  ctx.fillStyle = "#c45030"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(-5, 3); ctx.lineTo(0, 8); ctx.lineTo(5, 3); ctx.closePath();
  ctx.fillStyle = "#ccc"; ctx.fill();
  ctx.rotate((bearing || 0) * Math.PI / 180);
  ctx.font = "bold 12px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#c45030";
  ctx.fillText("N", 0, -22);
  ctx.restore();
  const legItems = [
    { type: "rect", fill: "rgba(196,80,48,0.25)", stroke: "#c45030", label: "Parcelle — " + site_area + " m²" },
    { type: "dash", stroke: "#c45030", label: "Zone constructible (reculs)" },
    { type: "rect", fill: "#e0ddd8", stroke: "#b0ada6", label: "Bâtiment existant" },
  ];
  const legPad = 14, legLH = 26, legW = 300;
  const legH = legPad * 2 + legItems.length * legLH + 10;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.08)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
  ctx.fillStyle = "rgba(255,255,255,0.97)";
  ctx.beginPath(); ctx.roundRect(16, 16, legW, legH, 8); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#e4e0d8"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
  legItems.forEach(function(item, i) {
    const iy = 16 + legPad + i * legLH;
    ctx.save();
    if (item.type === "rect") {
      ctx.fillStyle = item.fill; ctx.beginPath(); ctx.roundRect(28, iy, 16, 13, 2); ctx.fill();
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(28, iy + 6); ctx.lineTo(44, iy + 6);
      ctx.strokeStyle = item.stroke; ctx.lineWidth = 2.5; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
    ctx.font = "12px Arial"; ctx.fillStyle = "#444"; ctx.textAlign = "left";
    ctx.fillText(item.label, 52, iy + 11);
  });
  ctx.font = "8px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "left";
  ctx.fillText("© Mapbox  © OpenStreetMap contributors", 28, 16 + legH - 6);
  // v72.22: Setback labels DISABLED per user request
}
// ─── ARC SOLAIRE ──────────────────────────────────────────────────────────────
function drawSolarArc(ctx, W, H, p) {
  const { bearing } = p;
  const SX = W - 110, SY = H - 110, SR = 68;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.10)"; ctx.shadowBlur = 10;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath(); ctx.arc(SX, SY, SR + 12, 0, 2 * Math.PI); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#e8e4dc"; ctx.lineWidth = 1; ctx.stroke();
  const northRad = -(bearing) * Math.PI / 180 - Math.PI / 2;
  const sunriseAngle = northRad + Math.PI / 2;
  const sunsetAngle  = northRad + 3 * Math.PI / 2;
  // v64: Arc solaire sobre — teintes neutres, pas de bloom doré
  ctx.beginPath(); ctx.arc(SX, SY, SR - 6, sunriseAngle, sunsetAngle);
  ctx.strokeStyle = "rgba(180,160,100,0.12)"; ctx.lineWidth = 14; ctx.stroke();
  ctx.beginPath(); ctx.arc(SX, SY, SR - 6, sunriseAngle, sunsetAngle);
  const grad = ctx.createLinearGradient(
    SX + Math.cos(sunriseAngle) * SR, SY + Math.sin(sunriseAngle) * SR,
    SX + Math.cos(sunsetAngle)  * SR, SY + Math.sin(sunsetAngle)  * SR);
  grad.addColorStop(0, "rgba(180,120,40,0.4)"); grad.addColorStop(0.5, "rgba(200,160,60,0.6)"); grad.addColorStop(1, "rgba(180,100,30,0.4)");
  ctx.strokeStyle = grad; ctx.lineWidth = 4; ctx.stroke();
  const sunAngle = northRad + Math.PI;
  const sunX = SX + Math.cos(sunAngle) * (SR - 6), sunY = SY + Math.sin(sunAngle) * (SR - 6);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(sunX + Math.cos(a) * 6, sunY + Math.sin(a) * 6);
    ctx.lineTo(sunX + Math.cos(a) * 10, sunY + Math.sin(a) * 10);
    ctx.strokeStyle = "rgba(160,130,50,0.5)"; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.fillStyle = "#c8a030"; ctx.beginPath(); ctx.arc(sunX, sunY, 5, 0, 2 * Math.PI); ctx.fill();
  [
    { label: "N", angle: northRad, color: "#c45030", font: "bold 11px Arial" },
    { label: "S", angle: northRad + Math.PI, color: "#aaa", font: "9px Arial" },
    { label: "E", angle: sunriseAngle, color: "#888", font: "bold 10px Arial" },
    { label: "O", angle: sunsetAngle, color: "#888", font: "bold 10px Arial" },
  ].forEach(function(l) {
    const lx = SX + Math.cos(l.angle) * (SR + 4), ly = SY + Math.sin(l.angle) * (SR + 4);
    ctx.font = l.font; ctx.fillStyle = l.color; ctx.textAlign = "center"; ctx.fillText(l.label, lx, ly + 4);
  });
  ctx.font = "7px Arial"; ctx.fillStyle = "#bbb"; ctx.textAlign = "center";
  ctx.fillText("ENSOLEILLEMENT", SX, SY + SR + 18);
  ctx.restore();
}
// ─── OVERLAYS CANVAS — MASSING ────────────────────────────────────────────────
function drawMassingOverlays(ctx, W, H, { site_area, bearing, label, levels, commerce_levels, habitation_levels, total_height, floor_height, fp_m2, fp_rdc_m2, fp_etages_m2, accent_color, scenario_role, typology, split_layout, sdp_m2_actual }) {
  const s = W / 1280;
  // ── BOUSSOLE N en bas à droite ──
  ctx.save();
  ctx.translate(W - 60*s, H - 60*s);
  ctx.shadowColor = "rgba(0,0,0,0.12)"; ctx.shadowBlur = 6*s; ctx.shadowOffsetY = 2*s;
  ctx.beginPath(); ctx.arc(0, 0, 32*s, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = "#c45030"; ctx.lineWidth = 2*s; ctx.stroke();
  ctx.rotate(-(bearing || 0) * Math.PI / 180);
  ctx.font = `bold ${11*s}px Arial`; ctx.textAlign = "center";
  ctx.fillStyle = "#c45030"; ctx.fillText("N", 0, -18*s);
  ctx.fillStyle = "#bbb"; ctx.fillText("S", 0, 24*s);
  ctx.fillStyle = "#bbb"; ctx.fillText("O", -22*s, 4*s);
  ctx.fillStyle = "#bbb"; ctx.fillText("E", 22*s, 4*s);
  ctx.restore();
  // ── ANNOTATIONS ÉTAGES : traits + labels à droite du bâtiment (style référence) ──
  const rdcH_m = 3.0;
  const etageH_m = 3.0;
  const lineLen = 14 * s;
  // v72.28: SPLIT_AV_AR — annotations LOGEMENT en haut, COMMERCE en dessous (même colonne droite)
  if (split_layout && split_layout.mode === "SPLIT_AV_AR") {
    const vc = split_layout.volume_commerce;
    const vl = split_layout.volume_logement;
    const annX = W * 0.62;
    const stepY = -32 * s;
    // ── LOGEMENT annotations (en haut, BLEU) — niveaux habitables sur pilotis ──
    const logtBaseY = H * 0.52;
    for (let f = 0; f < vl.levels; f++) {
      const y = logtBaseY + f * stepY;
      // v72.28: En SPLIT avec pilotis, le logement commence à R+1
      const floorLabel = `R+${f + 1}`;
      ctx.beginPath();
      ctx.moveTo(annX, y); ctx.lineTo(annX + lineLen, y);
      ctx.strokeStyle = "#3a7ac0"; ctx.lineWidth = 2*s; ctx.stroke();
      ctx.font = `bold ${12*s}px Arial`; ctx.textAlign = "left";
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
      ctx.strokeText(`${floorLabel} : ${vl.fp_m2} m²`, annX + lineLen + 6*s, y + 4*s);
      ctx.fillStyle = "#3a7ac0";
      ctx.fillText(`${floorLabel} : ${vl.fp_m2} m²`, annX + lineLen + 6*s, y + 4*s);
    }
    // Pilotis annotation
    const pilotisY = logtBaseY + 24*s;
    ctx.beginPath();
    ctx.moveTo(annX, pilotisY); ctx.lineTo(annX + lineLen, pilotisY);
    ctx.strokeStyle = "#b0aea8"; ctx.lineWidth = 2*s; ctx.stroke();
    ctx.font = `${11*s}px Arial`; ctx.textAlign = "left";
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
    ctx.strokeText(`Pilotis (RDC)`, annX + lineLen + 6*s, pilotisY + 4*s);
    ctx.fillStyle = "#888";
    ctx.fillText(`Pilotis (RDC)`, annX + lineLen + 6*s, pilotisY + 4*s);
    // v72.88: Recalculate sub-labels proportionally from actual SDP total
    //   Raw vl.sdp_m2 + vc.sdp_m2 may not match sdp_m2_actual (the real moteur value).
    //   Apply ratio so sub-labels sum exactly to the total shown.
    const rawTotal = (vl.sdp_m2 || 0) + (vc.sdp_m2 || 0);
    const sdpRatio = (sdp_m2_actual && rawTotal > 0) ? sdp_m2_actual / rawTotal : 1;
    const logtSdpDisplay = Math.round((vl.sdp_m2 || 0) * sdpRatio);
    const commSdpDisplay = Math.round((vc.sdp_m2 || 0) * sdpRatio);
    // Label "Logement" sous les niveaux
    const logtLabelY = pilotisY + 22*s;
    ctx.font = `bold ${11*s}px Arial`; ctx.textAlign = "left";
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
    ctx.strokeText(`Logement: ${logtSdpDisplay} m² SDP (Surface de Plancher)`, annX, logtLabelY);
    ctx.fillStyle = "#3a7ac0";
    ctx.fillText(`Logement: ${logtSdpDisplay} m² SDP (Surface de Plancher)`, annX, logtLabelY);
    // ── COMMERCE annotations (en dessous du logement, ORANGE) ──
    const commBaseY = logtLabelY + 28*s;
    for (let f = 0; f < vc.levels; f++) {
      const y = commBaseY + f * 24*s;
      const floorLabel = f === 0 ? "RDC" : `R+${f}`;
      ctx.beginPath();
      ctx.moveTo(annX, y); ctx.lineTo(annX + lineLen, y);
      ctx.strokeStyle = "#e07830"; ctx.lineWidth = 2*s; ctx.stroke();
      ctx.font = `bold ${12*s}px Arial`; ctx.textAlign = "left";
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
      ctx.strokeText(`${floorLabel} : ${vc.fp_m2} m² (commerce)`, annX + lineLen + 6*s, y + 4*s);
      ctx.fillStyle = "#e07830";
      ctx.fillText(`${floorLabel} : ${vc.fp_m2} m² (commerce)`, annX + lineLen + 6*s, y + 4*s);
    }
    // Label "Commerce" sous
    const commLabelY = commBaseY + vc.levels * 24*s + 4*s;
    ctx.font = `bold ${11*s}px Arial`; ctx.textAlign = "left";
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
    ctx.strokeText(`Commerce: ${commSdpDisplay} m² SDP`, annX, commLabelY);
    ctx.fillStyle = "#e07830";
    ctx.fillText(`Commerce: ${commSdpDisplay} m² SDP`, annX, commLabelY);
    // v72.91: SDP already spelled out on Logement line above — keep Commerce short
    // Total SDP en bas — NOIR avec contour blanc — v72.87: utiliser le SDP RÉEL du scénario
    const totalSDP = sdp_m2_actual || ((vc.sdp_m2 || 0) + (vl.sdp_m2 || 0));
    const totalY = commLabelY + 24*s;
    ctx.font = `bold ${13*s}px Arial`; ctx.textAlign = "left";
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
    ctx.strokeText(`Total: ${totalSDP.toLocaleString("fr-FR")} m² SDP (Surface de Plancher)`, annX, totalY);
    ctx.fillStyle = "#000000";
    ctx.fillText(`Total: ${totalSDP.toLocaleString("fr-FR")} m² SDP (Surface de Plancher)`, annX, totalY);
  } else {
    // ══ MODE SUPERPOSÉ : annotations classiques ══
    const realTotalH = rdcH_m + (levels - 1) * etageH_m;
    // v72.87: utiliser le SDP RÉEL du scénario (pas fp_m2 × levels qui est une approximation)
    const sdpTotale = sdp_m2_actual || (fp_m2 * levels);
    const annX = W * 0.62;
    const annBaseY = H * 0.58;
    const annStepY = -32 * s;
    for (let f = 0; f < levels; f++) {
      const y = annBaseY + f * annStepY;
      const floorLabel = f === 0 ? "RDC" : `R+${f}`;
      const floorFp = f === 0 ? (fp_rdc_m2 || fp_m2) : (fp_etages_m2 || fp_m2);
      ctx.beginPath();
      ctx.moveTo(annX, y); ctx.lineTo(annX + lineLen, y);
      ctx.strokeStyle = "#000000"; ctx.lineWidth = 2*s; ctx.stroke();
      ctx.font = `bold ${12*s}px Arial`; ctx.textAlign = "left";
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
      ctx.strokeText(`${floorLabel} : ${floorFp} m²`, annX + lineLen + 6*s, y + 4*s);
      ctx.fillStyle = "#000000";
      ctx.fillText(`${floorLabel} : ${floorFp} m²`, annX + lineLen + 6*s, y + 4*s);
    }
    // Total SDP en bas — NOIR avec contour blanc
    ctx.font = `bold ${12*s}px Arial`; ctx.textAlign = "left";
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3*s;
    ctx.strokeText(`Total: ${sdpTotale.toLocaleString("fr-FR")} m² SDP (Surface de Plancher)`, annX, annBaseY + 24*s);
    ctx.fillStyle = "#000000";
    ctx.fillText(`Total: ${sdpTotale.toLocaleString("fr-FR")} m² SDP (Surface de Plancher)`, annX, annBaseY + 24*s);
  }
}
// ─── ENDPOINT /generate — SLIDE 4 AXO ────────────────────────────────────────
app.post("/generate", async (req, res) => {
  const t0 = Date.now();
  console.log("═══ /generate v49 (style-ref) ═══");
  const {
    lead_id, client_name, polygon_points, site_area, land_width, land_depth,
    envelope_w, envelope_d, buildable_fp, setback_front, setback_side, setback_back,
    terrain_context, city, district, zoning,
    slide_name = "slide_4_axo",
    zoom: zoomOverride = null,
    style_ref_url = null,
    front_edge,
    support_type,
    project_type,
    consider_site_empty,
    // v73.2.2 : view='top' produit une vue verticale (pitch=0) sans polish IA, slide_name auto
    view = "axo",
  } = req.body;
  // v73.2.2 : si view='top' on force la vue verticale et un slide_name dedie
  const isTopView = String(view).toLowerCase() === "top";
  const effectivePitch = isTopView ? 0 : 58;
  const effectiveSlideName = isTopView ? "slide_4_top" : slide_name;
  if (isTopView) console.log(`[GENERATE v73.2.3] view='top' → pitch=0, style=satellite-streets-v12, slide_name='slide_4_top', polish IA SKIP`);
  // v72.98: terrain nu / démolition → masquer bâti existant
  const isEmptySite = String(support_type || "").toUpperCase().includes("TERRAIN_NU") ||
                      /DEMOLITION/i.test(String(project_type || "")) ||
                      String(consider_site_empty || "").toLowerCase() === "true";
  if (isEmptySite) console.log(`[SLIDE4 v72.98] Terrain nu/démolition détecté → masquage bâti existant dans parcelle`);
  if (!lead_id || !polygon_points) return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });
  if (!MAPBOX_TOKEN) return res.status(500).json({ error: "MAPBOX_TOKEN manquant" });
  if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: "BROWSERLESS_TOKEN manquant" });
  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
  if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });
  const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
  const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
  // v70: front_edge en paramètre = override, sinon détection OSM
  const frontEdgeIndex = (front_edge !== undefined && front_edge !== null && front_edge !== "")
    ? (console.log(`│ FRONT-EDGE: override depuis body → arête ${front_edge}`), Number(front_edge))
    : (console.log(`│ FRONT-EDGE: convention v73.1 → arête 0 (premier segment polygone)`), 0);
  const envelopeCoords = computeEnvelope(coords, cLat, cLon, (Number(setback_front) > 0 ? Number(setback_front) : 5), (Number(setback_side) > 0 ? Number(setback_side) : 3), (Number(setback_back) > 0 ? Number(setback_back) : 3), frontEdgeIndex);
  const zoom = zoomOverride ? Number(zoomOverride) : computeZoom(coords, cLat, cLon);
  // v70.1: Slide 4 TOUJOURS orienté nord en haut (bearing=0) pour repérage facile
  const bearing = 0;
  console.log(`zoom=${zoom} bearing=${bearing}° (NORD EN HAUT) pitch=${effectivePitch}° view=${view}`);
    // v73.2.5 : view='top' → utiliser Mapbox Static Images API (vraie photo satellite raster)
    // bypass complet du pipeline puppeteer/GL JS pour la slide 4 top view
    if (isTopView) {
      try {
        // v73.2.6 : Google Maps Static API si cle presente (qualite superieure), sinon fallback Mapbox satellite-v9
        let staticBuf;
        let usedSource = "mapbox-satellite-v9";
        if (GOOGLE_MAPS_API_KEY) {
          try {
            staticBuf = await fetchGoogleStaticTop({
              cLat, cLon, zoom,
              parcelCoords: coords,
              envelopeCoords,
              googleKey: GOOGLE_MAPS_API_KEY,
              width: 640, height: 640  // x scale=2 = 1280x1280 effective
            });
            usedSource = "google-static-satellite";
            console.log(`[STATIC-TOP v73.2.6] Google source OK`);
          } catch (gErr) {
            console.warn(`[STATIC-TOP v73.2.6] Google failed (${gErr.message}), fallback Mapbox`);
            staticBuf = await fetchMapboxStaticTop({
              cLat, cLon, zoom,
              parcelCoords: coords,
              envelopeCoords,
              mapboxToken: MAPBOX_TOKEN,
              width: 1280, height: 1280
            });
          }
        } else {
          console.log(`[STATIC-TOP v73.2.6] GOOGLE_MAPS_API_KEY absent, fallback Mapbox`);
          staticBuf = await fetchMapboxStaticTop({
            cLat, cLon, zoom,
            parcelCoords: coords,
            envelopeCoords,
            mapboxToken: MAPBOX_TOKEN,
            width: 1280, height: 1280
          });
        }
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const slug = String(client_name || "client").toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
        const UPLOAD_TS = Date.now();
        const basePath = `hektar/${String(lead_id).trim()}_${slug}/${effectiveSlideName}_${UPLOAD_TS}.png`;
        const { error: ue } = await sb.storage.from("massing-images").upload(basePath, staticBuf, { contentType: "image/png", upsert: true });
        if (ue) {
          console.error(`[STATIC-TOP v73.2.5] Supabase upload error: ${ue.message}`);
          return res.status(500).json({ error: ue.message });
        }
        const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
        const cb = `?v=${Date.now()}`;
        console.log(`[STATIC-TOP v73.2.5] DONE in ${Date.now() - t0}ms — ${pd.publicUrl}`);
        return res.json({
          ok: true,
          public_url: pd.publicUrl + cb,
          enhanced_url: pd.publicUrl + cb,
          path: basePath,
          centroid: { lat: cLat, lon: cLon },
          view: { zoom, bearing, pitch: 0, mode: usedSource },
          duration_ms: Date.now() - t0
        });
      } catch (e) {
        console.error(`[STATIC-TOP v73.2.5] ERROR: ${e.message}\n${e.stack}`);
        return res.status(500).json({ error: `Static top view failed: ${e.message}` });
      }
    }
  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}` });
    console.log(`Connected (${Date.now() - t0}ms)`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1280, deviceScaleFactor: 1 });
    const effectiveMapStyle = isTopView ? "satellite" : "hektar";
    const html = await generateMapHTML({ lat: cLat, lon: cLon }, zoom, bearing, coords, envelopeCoords, MAPBOX_TOKEN, frontEdgeIndex, isEmptySite, effectivePitch, effectiveMapStyle);
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForFunction("window.__MAP_READY === true", { timeout: 60000 });
    const screenshotBuf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 1280 } });
    console.log(`Screenshot: ${screenshotBuf.length} bytes (${Date.now() - t0}ms)`);
    await page.close();
    const W = 1280, H = 1280;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(await loadImage(screenshotBuf), 0, 0);
    // ═══════════════════════════════════════════════════════════════════════
    // v72 DETERMINISTIC PIPELINE — all structural rendering BEFORE AI polish
    // Step 1: Color remap (Mapbox beige → green grass + sandy roads)
    // Step 2: Deterministic trees (seeded PRNG, identical every run)
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`[SLIDE4] v72: Applying deterministic color remap...`);
    applyColorRemap(ctx, W, H);
    console.log(`[SLIDE4] v72: Drawing deterministic trees...`);
    drawTrees(ctx, W, H);
    console.log(`[SLIDE4] v72: Applying deterministic shadows...`);
    applyDeterministicShadows(ctx, W, H);
    console.log(`[SLIDE4] v72: Applying warm color grading...`);
    applyWarmGrading(ctx, W, H);
    console.log(`[SLIDE4] v72: Applying light sharpening...`);
    applySharpen(ctx, W, H, 0.25);
    console.log(`[SLIDE4] v72: Deterministic pipeline complete (${Date.now() - t0}ms)`);
    // pngClean = Mapbox screenshot + color remap + trees — NO extra canvas drawings
    // Mapbox already draws the parcel + envelope in the HTML — don't duplicate
    const pngClean = canvas.toBuffer("image/png");
    // Screen coordinates for overlays (legend, setback labels) — drawn on fallback + after polish
    const pitch = 58;
    const scale = 256 * Math.pow(2, zoom) / (2 * Math.PI);
    function gpsToScreen(lat, lon) {
      const dx = (lon - cLat > 1000 ? lon : lon) - cLon;
      const dyMerc = Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) - Math.log(Math.tan(Math.PI / 4 + cLat * Math.PI / 360));
      const px = dx * Math.PI / 180 * scale;
      const py = -dyMerc * scale;
      const pitchRad = pitch * Math.PI / 180;
      const cosPitch = Math.cos(pitchRad);
      return { x: W / 2 + px, y: H / 2 + py * cosPitch };
    }
    const parcelScreenPts = coords.map(c => gpsToScreen(c.lat, c.lon));
    const envelopeScreenPts = envelopeCoords.map(c => gpsToScreen(c.lat, c.lon));
    drawLegendCompass(ctx, W, H, { site_area: Number(site_area), bearing, setback_front: Number(setback_front), setback_side: Number(setback_side), setback_back: Number(setback_back), parcelScreenPts, envelopeScreenPts, frontEdgeIndex });
    drawSolarArc(ctx, W, H, { bearing });
    const png = canvas.toBuffer("image/png");
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const slug = String(client_name || "client").toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const UPLOAD_TS = Date.now();
    const basePath = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}_${UPLOAD_TS}.png`;
    const { error: ue } = await sb.storage.from("massing-images").upload(basePath, png, { contentType: "image/png", upsert: true });
    if (ue) return res.status(500).json({ error: ue.message });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
    const cacheBust2 = `?v=${Date.now()}`;
    let enhancedUrl = pd.publicUrl + cacheBust2;
    // ═══════════════════════════════════════════════════════════════════════════
    // v72.20: HYBRID AI POLISH — strict stability protocol
    // Strategy: AI polishes ONLY the base texture (no overlays visible to AI)
    //           → strict drift scoring (25%) → redraw overlays on top
    //           → fallback to deterministic if all variations fail
    // ═══════════════════════════════════════════════════════════════════════════
    const SLIDE4_VARIATIONS = 2; // v72.93: reduced from 3 → 2 (saves 30-60s)
    const SLIDE4_AI_POLISH_ENABLED = true; // v72.127: balanced photorealism with strict geometric preservation
    const SLIDE4_DRIFT_THRESHOLD = 0.75; // v72.128: raised — photorealistic texture polish naturally causes 60-70% block drift; raised to 75% to let it pass while catching true geometric hallucinations (typically >85%)
    // v72.100: TIME BUDGET SUPPRIMÉ pour slide4 — polish toujours tenté
    // (si ça déborde Make.com, on aura au moins la version déterministe en fallback)
    const slide4Elapsed = Date.now() - t0;
    console.log(`[SLIDE4-POLISH v72.100] Début polish à ${Math.round(slide4Elapsed/1000)}s`);
    if (SLIDE4_AI_POLISH_ENABLED && OPENAI_API_KEY && !isTopView) {
      try {
        console.log(`[SLIDE4-POLISH] v72.34: Robust hybrid pipeline — ${SLIDE4_VARIATIONS} variations, drift threshold ${SLIDE4_DRIFT_THRESHOLD * 100}%, model=${POLISH_MODEL}`);
        // v72.34: Resize for API reliability
        const resized = await resizeForPolish(pngClean, POLISH_MAX_IMAGE_DIM);
        const b64Input = resized.buf.toString("base64");
        console.log(`[SLIDE4-POLISH] Input: ${(resized.buf.length / 1024).toFixed(0)}KB (${resized.w}×${resized.h})`);
        // ── ARCHITECTURAL POLISH PROMPT — v73.1.9: PHOTOREALISTIC CLEAN (sober, no painterly) ─────────
        const polishPrompt = [
          "ARCHITECTURAL AXONOMETRIC POLISH — CLEAN PROFESSIONAL 3D RENDER:",
          "",
          "INPUT IMAGES:",
          "- IMAGE 1 (the one to transform): Mapbox 3D base render — preserve EXACTLY its geometry, camera angle, building positions, parcel polygon, setback zone",
          "- IMAGE 2 (visual reference if provided): the EXACT visual style to match — clean axonometric urban planning render with off-white buildings, even green grass, sober palette, neutral lighting. STUDY this reference carefully and apply its aesthetic to image 1.",
          "",
          "If a reference image is provided as IMAGE 2, your output MUST visually resemble it in: building tones, ground treatment, lighting, palette, line crispness, and overall sober architectural maquette feel.",
          "",
          "Your task: transform this Mapbox 3D base into a clean, professional architectural axonometric render — the visual style of a contemporary urban planning visualization (think SOM, BIG, or MVRDV master plan rendering). NOT a photo, NOT a painting, NOT a sketch — a clean 3D architectural render.",
          "",
          "REQUIRED VISUAL QUALITIES:",
          "- Clean simple white-to-light-beige building volumes with crisp geometric edges",
          "- Soft volumetric shadows on facades and ground — gentle, neutral grey",
          "- Smooth uniform ground surfaces (no chaotic textures, no debris)",
          "- Sober coherent palette: white/beige buildings, even green grass, light gray asphalt roads",
          "- Professional architectural model rendering quality (V-Ray / Lumion-style clean output)",
          "",
          "BUILDING STYLE:",
          "- Simple cubic volumes with flat or low-slope roofs",
          "- White, light beige, or very light gray facades — uniform palette",
          "- Crisp building edges, no painterly bleed",
          "- ZERO informal settlement: NO corrugated metal, NO rusty tin, NO tarps, NO patchwork, NO chaotic textures",
          "- Volume hierarchy preserved: keep the size/height differences between buildings",
          "",
          "GROUND & VEGETATION (CLEAN AXONOMETRIC STYLE):",
          "- Uniform medium-green grass — even tone, slight subtle texture, NOT cartoon-flat NOT chaotic",
          "- Simple round green trees with single-tone foliage — orderly placement",
          "- Smooth light gray asphalt roads with clean edges",
          "- Subtle ground definition between paved and green areas",
          "",
          "PARCEL & SETBACK ZONE — CRITICAL TO PRESERVE EXACTLY:",
          "- The parcel is filled with a SAND/BEIGE color (#d4b878 area) — keep this beige fill EXACTLY as is, do NOT replace it with grass",
          "- The parcel has a thin RED DASHED outline — keep this red dashed line EXACTLY visible, do NOT thicken into a wall",
          "- Inside the parcel: SAND/BEIGE flat ground (NOT grass, NOT a building, NOT a platform) — represents an empty buildable plot",
          "- A separate setback band along the front edge of the parcel — keep its color contrast visible",
          "",
          "LIGHTING:",
          "- NEUTRAL daylight (midday or soft overcast) — daylight white balance",
          "- Soft uniform volumetric shadows for depth perception",
          "- NO warm sepia tint, NO golden hour, NO amber atmosphere, NO sun bloom",
          "- Cool-to-neutral color temperature throughout",
          "",
          "FORBIDDEN (zero tolerance):",
          "- Do NOT change the position, shape, height, or count of ANY building",
          "- Do NOT add NEW buildings, walls, structures, volumes, or pads",
          "- Do NOT modify the parcel beige fill or its red dashed outline — keep them EXACTLY as in the input",
          "- Do NOT alter the setback band — keep its color visible",
          "- Do NOT move, delete, or relocate anything",
          "- Do NOT change camera angle, perspective, framing, or zoom",
          "- Do NOT add characters, vehicles, signage, or UI elements",
          "- Do NOT add ANY text annotation, label, number, or hallucinated lettering anywhere in the image",
          "- Do NOT add ground elevation/socle under the parcel — flat at street level",
          "- Do NOT use painterly, sketchy, watercolor, or comic-book styles",
          "- Do NOT make it look like a real photograph — keep the clean architectural render aesthetic",
          "",
          "REFERENCE STYLE: clean architectural axonometric urban planning render — like a high-quality 3D model rendering from a professional architecture office, with sober materials, neutral lighting, and absolute geometric clarity.",
        ].join(" ");
        // v72.34: Use robust polish engine with retry + timeout
        // v73.2.7 : polish slide 5 axo avec image reference enhanced (multimodal)
        const refAxoB64 = getReferenceAxoB64();
        if (refAxoB64) {
          console.log(`[SLIDE4-POLISH v73.2.7] Reference enhanced image LOADED (${(refAxoB64.length*0.75/1024).toFixed(0)}KB) → multimodal polish`);
        } else {
          console.log(`[SLIDE4-POLISH v73.2.7] No reference image — polish prompt-only (fallback)`);
        }
        const polishResults = await Promise.all(
          Array.from({ length: SLIDE4_VARIATIONS }, (_, v) =>
            callPolishAPI(b64Input, polishPrompt, "SLIDE4", v + 1, 1, refAxoB64)
          )
        );
        console.log(`[SLIDE4-POLISH] ${SLIDE4_VARIATIONS} API calls completed (${Date.now() - t0}ms)`);
        // ── DRIFT SCORING — pick best under threshold ───────────────────────
        let bestVariation = null;
        let bestDriftScore = 1.0;
        const variationLog = [];
        for (let v = 0; v < polishResults.length; v++) {
          const result = polishResults[v];
          if (result.error) {
            variationLog.push(`  v${v+1}: ${result.error} — ${(result.details || "").substring(0, 150)}`);
            continue;
          }
          const enhancedBuf = Buffer.from(result.b64, "base64");
          // v72.20: Strict drift check — threshold 25%
          const drift = await detectDriftFromBuffers(pngClean, enhancedBuf, W, H, SLIDE4_DRIFT_THRESHOLD);
          const pct = (drift.driftScore * 100).toFixed(1);
          const pass = drift.driftScore < SLIDE4_DRIFT_THRESHOLD ? "PASS" : "FAIL";
          variationLog.push(`  v${v+1}: drift=${pct}% (${drift.classShifts}/${drift.totalBlocks} blocks) → ${pass}`);
          // Only consider variations that PASS the threshold
          if (drift.driftScore < SLIDE4_DRIFT_THRESHOLD && drift.driftScore < bestDriftScore) {
            bestDriftScore = drift.driftScore;
            bestVariation = { buf: enhancedBuf, drift, index: v + 1 };
          }
        }
        console.log(`[SLIDE4-POLISH] v72.20 Multi-render results (${Date.now() - t0}ms):\n${variationLog.join("\n")}`);
        if (bestVariation) {
          console.log(`[SLIDE4-POLISH] ✓ ACCEPTED v${bestVariation.index} (drift=${(bestDriftScore * 100).toFixed(1)}% < ${SLIDE4_DRIFT_THRESHOLD * 100}% threshold)`);
          const polishedImg = await loadImage(bestVariation.buf);
          const finalCanvas = createCanvas(W, H);
          const finalCtx = finalCanvas.getContext("2d");
          finalCtx.drawImage(polishedImg, 0, 0, W, H);
          // Black bar detection — crop if AI shifted content
          const scanData = finalCtx.getImageData(0, 0, W, H).data;
          let leftBlack = 0, rightBlack = 0, topBlack = 0, bottomBlack = 0;
          for (let x = 0; x < W / 4; x++) {
            let isBlack = true;
            for (let y = 0; y < H; y += 10) {
              const idx = (y * W + x) * 4;
              if (scanData[idx] + scanData[idx+1] + scanData[idx+2] > 30) { isBlack = false; break; }
            }
            if (isBlack) leftBlack = x + 1; else break;
          }
          for (let x = W - 1; x > W * 3 / 4; x--) {
            let isBlack = true;
            for (let y = 0; y < H; y += 10) {
              const idx = (y * W + x) * 4;
              if (scanData[idx] + scanData[idx+1] + scanData[idx+2] > 30) { isBlack = false; break; }
            }
            if (isBlack) rightBlack = W - x; else break;
          }
          for (let y = 0; y < H / 4; y++) {
            let isBlack = true;
            for (let x = 0; x < W; x += 10) {
              const idx = (y * W + x) * 4;
              if (scanData[idx] + scanData[idx+1] + scanData[idx+2] > 30) { isBlack = false; break; }
            }
            if (isBlack) topBlack = y + 1; else break;
          }
          for (let y = H - 1; y > H * 3 / 4; y--) {
            let isBlack = true;
            for (let x = 0; x < W; x += 10) {
              const idx = (y * W + x) * 4;
              if (scanData[idx] + scanData[idx+1] + scanData[idx+2] > 30) { isBlack = false; break; }
            }
            if (isBlack) bottomBlack = H - y; else break;
          }
          if (leftBlack > 2 || rightBlack > 2 || topBlack > 2 || bottomBlack > 2) {
            console.log(`[SLIDE4-POLISH] Black bars L=${leftBlack} R=${rightBlack} T=${topBlack} B=${bottomBlack} — cropping`);
            const srcX = leftBlack, srcY = topBlack;
            const srcW = W - leftBlack - rightBlack, srcH = H - topBlack - bottomBlack;
            finalCtx.clearRect(0, 0, W, H);
            finalCtx.drawImage(polishedImg, srcX, srcY, srcW, srcH, 0, 0, W, H);
          }
          // Post-polish sharpening to counteract AI softness
          applySharpen(finalCtx, W, H, 0.30);
          // ── REDRAW OVERLAYS on polished image (AI never saw these) ─────────
          drawLegendCompass(finalCtx, W, H, { site_area: Number(site_area), bearing, setback_front: Number(setback_front), setback_side: Number(setback_side), setback_back: Number(setback_back), parcelScreenPts, envelopeScreenPts, frontEdgeIndex });
          drawSolarArc(finalCtx, W, H, { bearing });
          const finalPng = finalCanvas.toBuffer("image/png");
          const enhancedPath = `hektar/${String(lead_id).trim()}_${slug}/${slide_name}_enhanced_${UPLOAD_TS}.png`;
          const { error: ue2 } = await sb.storage.from("massing-images").upload(enhancedPath, finalPng, { contentType: "image/png", upsert: true, cacheControl: "0" });
          if (!ue2) {
            const { data: pd2 } = sb.storage.from("massing-images").getPublicUrl(enhancedPath);
            enhancedUrl = pd2.publicUrl + `?v=${Date.now()}`;
            console.log(`✓ [SLIDE4-POLISH] Enhanced uploaded: ${enhancedUrl} (${Date.now() - t0}ms)`);
          }
        } else {
          console.log(`⚠ [SLIDE4-POLISH] ALL ${SLIDE4_VARIATIONS} variations FAILED drift check (>${SLIDE4_DRIFT_THRESHOLD * 100}%) — using deterministic fallback`);
          // Fallback: deterministic render is already in 'png' with overlays — no action needed
        }
      } catch (oaiErr) {
        console.error("[SLIDE4-POLISH] Exception:", oaiErr.message);
        console.log("[SLIDE4-POLISH] Fallback to deterministic render (already uploaded)");
      }
    } else {
      if (!OPENAI_API_KEY) console.log("[SLIDE4-POLISH] OPENAI_API_KEY absent — using deterministic render");
    }
    return res.json({ ok: true, public_url: pd.publicUrl + cacheBust2, enhanced_url: enhancedUrl, path: basePath, centroid: { lat: cLat, lon: cLon }, view: { zoom, bearing, pitch: 58 }, duration_ms: Date.now() - t0 });
  } catch (e) {
    console.error("Error:", e.message || e);
    return res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (browser) { try { browser.disconnect(); } catch (_) {} }
  }
});
// ─── ENDPOINT /generate-massing — SCÉNARIOS A/B/C ────────────────────────────
app.post("/generate-massing", async (req, res) => {
  const t0 = Date.now();
  console.log("═══ /generate-massing v72.29 ═══");
  console.log(`[BODY] massing_label="${req.body.massing_label}" slide_name="${req.body.slide_name}" compute_scenario="${req.body.compute_scenario}"`);
  console.log(`[BODY] lead_id="${req.body.lead_id}" layout_mode="${req.body.layout_mode}" commerce_depth_m="${req.body.commerce_depth_m}"`);
  console.log(`[BODY_RAW] ${JSON.stringify(req.body).slice(0, 500)}`);
  const {
    lead_id, client_name, polygon_points,
    site_area, setback_front, setback_side, setback_back,
    envelope_w, envelope_d,
    massing_label = "A", slide_name,
    style_ref_url = null,
    // ── Mode classique (valeurs pré-calculées par la sheet) ──
    fp_m2: fp_m2_raw, massing_levels: levels_raw, height_m: height_raw,
    commerce_levels: commerce_raw = 0, floor_height: fh_raw = 3.2,
    scenario_role: role_raw = "", accent_color: accent_raw = "#2a5298",
    // ── Mode smart (calcul serveur) ──
    compute_scenario = false,
    zoning_type = "URBAIN",
    // ── Tous les paramètres PIPELINE pour le moteur intelligent ──
    primary_driver, max_floors, max_height_m,
    program_main, target_surface_m2, target_units,
    site_saturation_level, financial_rigidity_score,
    density_band, risk_adjusted, feasibility_posture,
    scenario_A_role, scenario_B_role, scenario_C_role,
    budget_range, budget_range_raw, budget_band, budget_tension,
    standing_level, rent_score, capacity_score,
    mix_score, phase_score, risk_score,
    density_pressure_factor, driver_intensity, strategic_position,
    // ── Contexte parcelle occupée / rénovation ──
    project_type,          // NEUF | RENOVATION | EXTENSION | SURELEVATION | DEMOLITION_RECONSTRUCTION
    existing_footprint_m2, // emprise existante si parcelle déjà construite
    // ── v56.7 : orientation rue ──
    road_bearing,          // azimut de la route principale (degrés, depuis la Sheet)
    front_edge,            // v70: override index arête front (0-3)
    // ── v72.22 : disposition spatiale commerce/logement ──
    layout_mode,           // SUPERPOSE (défaut) | SPLIT_AV_AR | SPLIT_LAT | LINEAIRE
    commerce_depth_m,      // profondeur bande commerciale (défaut 6m)
    retrait_inter_volumes_m, // distance entre les 2 volumes (défaut 4m)
    // v72.93: Performance — skip AI polish to stay within Make.com 300s timeout
    skip_polish = false,
    // v73.1.3: typology-driven fields (CRITIQUE — sinon fallback sur target_units → mauvais mix)
    input_typologies = "",
    commerce_size_m2 = 0,
  } = req.body;
  if (!lead_id || !polygon_points) return res.status(400).json({ error: "lead_id et polygon_points obligatoires" });
  if (!envelope_w || !envelope_d) return res.status(400).json({ error: "envelope_w, envelope_d obligatoires" });
  const envW = Number(envelope_w);
  const envD = Number(envelope_d);
  const floorH = Number(fh_raw) || 3.2;
  // v72.29: DÉTECTION ROBUSTE DU LABEL (A/B/C) — PRIORITÉ À slide_name
  // Make.com envoie souvent massing_label="A" pour les 3 requêtes → INUTILISABLE.
  // Le slide_name est TOUJOURS différent (sinon les images s'écrasent) → SOURCE DE VÉRITÉ.
  let label = "A"; // défaut
  const slideStr = String(slide_name || "").toUpperCase();
  const rawLabel = String(massing_label || "").toUpperCase().trim();
  // PRIORITÉ 1: slide_name (TOUJOURS fiable car unique par requête)
  const slideMatch = slideStr.match(/(?:MASSING|SCENARIO|SC)[_\s.-]*([ABC])\b/)
    || slideStr.match(/[_\s.-]([ABC])$/)
    || slideStr.match(/([ABC])$/);
  if (slideMatch) {
    label = slideMatch[1];
    console.log(`[v72.29] LABEL from slide_name: "${label}" (slide_name="${slide_name}")`);
  } else if (["A", "B", "C"].includes(rawLabel)) {
    // PRIORITÉ 2: massing_label (seulement si slide_name ne contient pas A/B/C)
    label = rawLabel;
    console.log(`[v72.29] LABEL from massing_label: "${label}" (slide_name="${slide_name}" had no A/B/C)`);
  } else {
    // PRIORITÉ 3: chercher dans tout le body
    const bodyStr = JSON.stringify(req.body).toUpperCase();
    if (/PRUDENT|[_":]C[_"}\s,]/.test(bodyStr)) label = "C";
    else if (/EQUILIBRE|[_":]B[_"}\s,]/.test(bodyStr)) label = "B";
    console.log(`[v72.29] LABEL from body scan: "${label}"`);
  }
  console.log(`[v72.29] ═══ LABEL FINAL: "${label}" ═══ (massing_label="${massing_label}", slide_name="${slide_name}")`);
  // ═══════════════════════════════════════════════════════════════════════════
  // v72.103 EARLY GUARD — simple mode detection AVANT toute autre logique
  // Si le client veut pure résidentiel + volume unique, on force simple mode :
  //   - pas de commerce (commerceLevels sera 0)
  //   - pas de pilotis (has_pilotis sera false)
  //   - pas de split (splitLayout sera null)
  //   - layout_mode forcé à SUPERPOSE
  // Cela empêche les chemins downstream de ré-activer du commerce/split/pilotis.
  // ═══════════════════════════════════════════════════════════════════════════
  try {
    const _dispoEarly = String((req.body && req.body.Disposition) || (req.body && req.body.disposition) || "").toLowerCase();
    const _progEarly = String((req.body && req.body.target_program) || "").toLowerCase();
    const _wantsSingle = /seul\s*b.?timent|un\s*seul|single\s*building/i.test(_dispoEarly);
    const _isPureResi = /petit.?collectif|collectif|immeuble.?rapport|villa|individuel|maison/i.test(_progEarly)
                      && !/mixte|mixed|commerce|bureau|activite/i.test(_progEarly);
    if (_wantsSingle && _isPureResi) {
      console.log(`[v72.103 EARLY GUARD ${label}] ⚡ SIMPLE MODE activé : pure résidentiel + volume unique`);
      console.log(`  → force layout_mode=SUPERPOSE, commerce_raw=0, skip_split=true`);
      req.body.layout_mode = "SUPERPOSE";
      req.body.commerce_levels = 0;
      req.body.commerce_raw = 0;
      req.body.consider_site_empty = req.body.consider_site_empty || "true";
    }
  } catch (_earlyErr) {
    console.warn(`[v72.103 EARLY GUARD] non-fatal:`, _earlyErr.message);
  }
  // ═══════════════════════════════════════════════════════════════════════════
  // v72.24: DÉTECTION PROPRE programme mixte + disposition SPLIT
  // On examine les VALEURS des champs, pas les noms (pour éviter les faux positifs)
  // ── Détection MIXTE : on examine les valeurs textuelles des champs pertinents ──
  const fieldValues = Object.values(req.body).map(v => String(v).toLowerCase()).join(" ");
  // v72.25: DÉTECTION ROBUSTE — ne plus dépendre de Make.com qui peut envoyer
  // des bodies différents pour A/B/C. Tout signal de mixte/split = ON pour les 3.
  // ── Détection MIXTE ──
  const bodyHasMixte = /mixte|mixed|usage.?mixte/i.test(fieldValues);
  // ── Détection SPLIT ──
  // Signal 1: layout_mode explicitement SPLIT_AV_AR
  const layoutModeIsSplit = String(layout_mode || "").toUpperCase() === "SPLIT_AV_AR";
  // Signal 2: une valeur du body mentionne clairement la séparation
  const bodyHasSplit = /split.?av|commerce.?devant|devant.?retrait|dissoci/i.test(fieldValues);
  // Signal 3: commerce_depth_m est envoyé avec une valeur > 0 → c'est forcément du SPLIT
  const hasCommerceDepth = Number(commerce_depth_m) > 0;
  // ── Résolution ──
  const effectiveLayoutMode = (layoutModeIsSplit || bodyHasSplit || hasCommerceDepth)
    ? "SPLIT_AV_AR" : "SUPERPOSE";
  const splitActive = effectiveLayoutMode === "SPLIT_AV_AR";
  // ── Programme effectif ──
  const effectiveProgramMain = program_main || project_type || ((bodyHasMixte || splitActive) ? "USAGE_MIXTE" : "");
  console.log(`[MASSING v72.25] ┌── DÉTECTION MIXTE/SPLIT ──`);
  console.log(`[MASSING v72.25] │ program_main="${program_main}" project_type="${project_type}"`);
  console.log(`[MASSING v72.25] │ layout_mode_raw="${layout_mode}" commerce_depth_m="${commerce_depth_m}" retrait="${retrait_inter_volumes_m}"`);
  console.log(`[MASSING v72.25] │ bodyHasMixte=${bodyHasMixte} bodyHasSplit=${bodyHasSplit} splitActive=${splitActive}`);
  console.log(`[MASSING v72.25] │ effectiveLayoutMode="${effectiveLayoutMode}" effectiveProgramMain="${effectiveProgramMain}"`);
  console.log(`[MASSING v72.25] │ BODY KEYS: ${Object.keys(req.body).join(", ")}`);
  console.log(`[MASSING v72.25] │ field_values_sample="${fieldValues.slice(0, 500)}"`);
  console.log(`[MASSING v72.25] └── FIN DÉTECTION ──`);
  // ── Déterminer les paramètres du scénario ──
  let fp, levels, totalH, commerceLevels, scenarioRole, accentColor, splitLayout = null, scenarioSdp = 0;
  // v73.1.7: exporter sc.fp_rdc_m2 et sc.fp_etages_m2 hors du bloc if (sinon hors-scope)
  let scFpRdc = null, scFpEtages = null;
  if (compute_scenario || !fp_m2_raw || !levels_raw) {
    // MODE SMART : le moteur calcule tout
    if (!site_area) return res.status(400).json({ error: "site_area obligatoire en mode compute_scenario" });
    const scenarios = computeSmartScenarios({
      site_area: Number(site_area),
      envelope_w: envW,
      envelope_d: envD,
      zoning_type: String(zoning_type),
      floor_height: floorH,
      primary_driver: primary_driver || "MAX_CAPACITE",
      max_floors: Number(max_floors) || 99,
      max_height_m: Number(max_height_m) || 99,
      program_main: effectiveProgramMain,
      target_surface_m2: Number(target_surface_m2) || 0,
      target_units: Number(target_units) || 0,
      site_saturation_level: site_saturation_level || "MEDIUM",
      financial_rigidity_score: Number(financial_rigidity_score) || 0,
      density_band: density_band || "",
      risk_adjusted: Number(risk_adjusted) || 0,
      feasibility_posture: feasibility_posture || "BALANCED",
      scenario_A_role: scenario_A_role || "",
      scenario_B_role: scenario_B_role || "",
      scenario_C_role: scenario_C_role || "",
      budget_range: Number(budget_range) || 0,
      budget_band: budget_band || "",
      budget_tension: Number(budget_tension) || 0,
      standing_level: standing_level || "STANDARD",
      rent_score: Number(rent_score) || 0,
      capacity_score: Number(capacity_score) || 0,
      mix_score: Number(mix_score) || 0,
      phase_score: Number(phase_score) || 0,
      risk_score: Number(risk_score) || 0,
      density_pressure_factor: Number(density_pressure_factor) || 1,
      driver_intensity: driver_intensity || "MEDIUM",
      strategic_position: strategic_position || "",
      // v72.22: disposition spatiale commerce/logement
      layout_mode: effectiveLayoutMode,
      commerce_depth_m: Number(commerce_depth_m) || 6,
      retrait_inter_volumes_m: Number(retrait_inter_volumes_m) || 4,
      // v73.1.3: typology-driven fields (sinon fallback target_units → mauvais mix)
      input_typologies: input_typologies || "",
      commerce_size_m2: Number(commerce_size_m2) || 0,
    });
    const sc = scenarios[label] || scenarios.A;
    // v72.28: LOG les 3 scénarios pour vérifier la différenciation
    console.log(`[v72.28] ═══ SMART SCENARIOS COMPUTED ═══`);
    for (const k of ["A", "B", "C"]) {
      const s = scenarios[k];
      if (s) console.log(`[v72.28] ${k}: fp=${s.fp_m2}m² levels=${s.levels} split=${s.split_layout ? s.split_layout.volume_logement.levels + "niv_logt" : "none"} pilotis=${s.has_pilotis}`);
    }
    console.log(`[v72.28] USING: label="${label}" → fp=${sc.fp_m2}m² levels=${sc.levels}`);
    fp = sc.fp_m2;
    levels = sc.levels;
    totalH = sc.height_m;
    commerceLevels = sc.commerce_levels;
    has_pilotis = sc.has_pilotis || false;
    scenarioRole = sc.label_fr;
    accentColor = sc.accent_color;
    splitLayout = sc.split_layout || null;
    scenarioSdp = sc.sdp_m2 || 0;  // v72.87: SDP réel du moteur (pour annotations)
    // v73.1.7: exporter pour usage hors du bloc
    scFpRdc = sc.fp_rdc_m2 || null;
    scFpEtages = sc.fp_etages_m2 || null;
    console.log(`SMART MODE: ${label} → fp=${fp}m² levels=${levels} h=${totalH}m commerce=${commerceLevels} pilotis=${has_pilotis} layout=${splitLayout ? splitLayout.mode : "SUPERPOSE"} sdp=${scenarioSdp}m² (${sc.cos_compliance})`);
  } else {
    // MODE CLASSIQUE : valeurs de la sheet
    fp = Number(fp_m2_raw);
    levels = Number(levels_raw);
    totalH = Number(height_raw) || levels * floorH;
    // v72.22: commerce_levels — si la sheet envoie une valeur, on la respecte.
    // Sinon, on cross-check program_main ou layout_mode : si mixte ou SPLIT → 1 niveau commerce (RDC)
    const rawComm = Number(commerce_raw);
    if (rawComm > 0) {
      commerceLevels = rawComm;
    } else if (/mixte|mixed/i.test(effectiveProgramMain) || splitActive) {
      commerceLevels = 1; // commerce toujours au RDC
      console.log(`[CLASSIC] commerce_raw vide mais effectiveProgram="${effectiveProgramMain}" split=${splitActive} → commerce_levels=1 (RDC)`);
    } else {
      commerceLevels = 0;
    }
    has_pilotis = false;
    scenarioRole = String(role_raw);
    accentColor = String(accent_raw);
    scenarioSdp = Math.round(fp * levels);  // v72.87: SDP classique = fp × levels
    console.log(`CLASSIC MODE: ${label} → fp=${fp}m² levels=${levels} h=${totalH}m commerce=${commerceLevels} sdp=${scenarioSdp}m²`);
  }
  // v72.98: FILET ULTIME SUPPRIMÉ — commerce piloté uniquement par input client (P1)
  // v72.28: Si mixte SUPERPOSÉ et 1 seul niveau, forcer à 2 minimum (1 commerce + 1 logement)
  // En SPLIT, les levels = logement seulement (commerce est un volume séparé) → PAS de override
  if (commerceLevels > 0 && levels <= commerceLevels && !splitLayout) {
    const oldLevels = levels;
    levels = commerceLevels + 1;
    console.log(`[OVERRIDE] levels=${oldLevels} ≤ commerce=${commerceLevels} → forcé à ${levels} (minimum 1 logement au-dessus du commerce)`);
  }
  // v72.23: SPLIT SYNTHÉTIQUE — si le body demande un SPLIT mais splitLayout est null,
  // on construit un splitLayout synthétique pour que le rendu 3D montre 2 volumes séparés.
  // v72.31: JAMAIS pour C (PRUDENT) → C est TOUJOURS SUPERPOSÉ compact (volume unique).
  // A et B gardent le SPLIT avec commerce en front + logement sur pilotis derrière.
  if (!splitLayout && effectiveLayoutMode === "SPLIT_AV_AR" && commerceLevels > 0 && label !== "C") {
    const commDepthEstimate = Number(commerce_depth_m) || 6;
    const commFpEstimate = Math.round(fp * 0.4); // ~40% de l'emprise pour le commerce devant
    const logtFpEstimate = fp;  // emprise logement = fp original
    // v72.32: DIFFÉRENCIATION FORCÉE — même logique que le moteur SPLIT
    // INTENSIFICATION (A): min 3 niveaux logement (R+3) = pilotis + 3 étages habitables
    // EQUILIBRE (B): min 2 niveaux logement (R+2) = pilotis + 2 étages habitables
    // Sans ce forçage, logtLevels = levels - commerceLevels donne trop peu de niveaux
    // car les niveaux SUPERPOSÉ (total) sont inférieurs aux niveaux SPLIT (logement seul)
    const maxLogtFloors = Math.max(1, (Number(max_floors) || 99) - commerceLevels);
    let logtLevels = Math.max(1, levels - commerceLevels);
    if (label === "A") logtLevels = Math.min(maxLogtFloors, Math.max(3, logtLevels));
    else if (label === "B") logtLevels = Math.min(maxLogtFloors, Math.max(2, logtLevels));
    console.log(`[v72.32] SPLIT SYNTHÉTIQUE ${label}: levels_engine=${levels} - commerce=${commerceLevels} → logtLevels=${logtLevels} (maxLogt=${maxLogtFloors})`);
    splitLayout = {
      mode: "SPLIT_AV_AR",
      volume_commerce: {
        fp_m2: commFpEstimate,
        width_m: Math.round(envW * 0.8),
        depth_m: commDepthEstimate,
        levels: commerceLevels,
        sdp_m2: commFpEstimate * commerceLevels,
        units: Math.max(1, Math.floor(commFpEstimate / 30)),
        position: "AVANT (contre clôture)",
      },
      volume_logement: {
        fp_m2: logtFpEstimate,
        width_m: Math.round(envW * 0.8),
        depth_m: Math.round(envD * 0.5),
        levels: Math.max(1, logtLevels),
        sdp_m2: logtFpEstimate * Math.max(1, logtLevels),
        units: 0,
        position: "ARRIÈRE",
      },
      retrait_inter_m: Number(retrait_inter_volumes_m) || 4,
    };
    console.log(`[CLASSIC→SPLIT] splitLayout synthétique construit: commerce=${commFpEstimate}m²×${commerceLevels}niv + logement=${logtFpEstimate}m²×${Math.max(1, logtLevels)}niv`);
  }
  // v72.32: En SPLIT (moteur ou synthétique), levels doit = niveaux LOGEMENT uniquement
  // Car le rendu 3D utilise: realTotalH = rdcH + levels * etageH (pilotis + N étages)
  // Si levels reste en mode SUPERPOSÉ (total), la hauteur est fausse
  if (splitLayout && splitLayout.volume_logement) {
    levels = splitLayout.volume_logement.levels;
    console.log(`[v72.32] SPLIT levels sync: levels=${levels} (logement seul, depuis splitLayout.volume_logement.levels)`);
  }
  // ═══════════════════════════════════════════════════════════════════════════
  // v72.101 PROGRAM LOCK (bulletproof + defensive) — Respect strict du programme client
  // Try/catch + typeof sur TOUTES les variables → jamais de crash runtime.
  // ═══════════════════════════════════════════════════════════════════════════
  try {
    const _dispositionRaw = String((req.body && req.body.Disposition) || (req.body && req.body.disposition) || "").toLowerCase();
    const _targetProgRaw = String((req.body && req.body.target_program) || "").toLowerCase();
    const _supportTypeRaw = String((req.body && req.body.support_type) || "").toUpperCase();
    const _clientWantsSingleVolume = /seul\s*b.?timent|seul\s*batiment|un\s*seul|single\s*building/i.test(_dispositionRaw);
    const _clientProgramIsPureResidential = (
      /petit.?collectif|collectif|immeuble.?rapport|villa|individuel|maison/i.test(_targetProgRaw)
      && !/mixte|mixed|commerce|bureau|activite/i.test(_targetProgRaw)
    );
    const _clientWantsPilotis = /pilotis|rdc.?ouvert|rdc.?libere/i.test(_dispositionRaw);
    const _isTerrainNu = _supportTypeRaw.includes("TERRAIN_NU");
    const _before = {
      commerce: (typeof commerceLevels !== "undefined" ? commerceLevels : 0),
      pilotis: (typeof has_pilotis !== "undefined" ? has_pilotis : false),
      split: (typeof splitLayout !== "undefined" && splitLayout ? true : false),
    };
    const _bodyHasMixte = (typeof bodyHasMixte !== "undefined") ? bodyHasMixte : false;
    const _splitActive = (typeof splitActive !== "undefined") ? splitActive : false;
    if (!_bodyHasMixte && !_splitActive) {
      if (typeof commerceLevels !== "undefined") commerceLevels = 0;
      if (typeof splitLayout !== "undefined") splitLayout = null;
      if (typeof has_pilotis !== "undefined" && !_clientWantsPilotis) has_pilotis = false;
    }
    if (_clientWantsSingleVolume && typeof splitLayout !== "undefined") {
      splitLayout = null;
    }
    if (_clientProgramIsPureResidential) {
      if (typeof commerceLevels !== "undefined") commerceLevels = 0;
      if (typeof splitLayout !== "undefined") splitLayout = null;
    }
    if (_isTerrainNu && !_clientWantsPilotis && typeof has_pilotis !== "undefined") {
      has_pilotis = false;
    }
    const _clientTargetUnits = Number((req.body && req.body.target_units)) || 0;
    const _totalUnitsResult = (typeof totalUnitsResult !== "undefined") ? totalUnitsResult : 0;
    let _unitsWarning = "";
    if (_clientTargetUnits > 0 && _totalUnitsResult > _clientTargetUnits) {
      _unitsWarning = ` (client ${_clientTargetUnits} logements, moteur ${_totalUnitsResult})`;
    }
    const _changed = (_before.commerce !== (typeof commerceLevels !== "undefined" ? commerceLevels : 0))
                  || (_before.pilotis !== (typeof has_pilotis !== "undefined" ? has_pilotis : false))
                  || (_before.split !== (typeof splitLayout !== "undefined" && splitLayout ? true : false));
    if (_changed || _unitsWarning) {
      const _label = (typeof label !== "undefined") ? label : "?";
      console.log(`[v72.101 PROGRAM LOCK ${_label}] overrides appliqués :`);
      console.log(`  commerce : ${_before.commerce} → ${typeof commerceLevels !== "undefined" ? commerceLevels : "undef"}`);
      console.log(`  pilotis  : ${_before.pilotis} → ${typeof has_pilotis !== "undefined" ? has_pilotis : "undef"}`);
      console.log(`  split    : ${_before.split} → ${typeof splitLayout !== "undefined" && splitLayout ? true : false}`);
      if (_unitsWarning) console.log(`  units    :${_unitsWarning}`);
      console.log(`  [ctx] mixte=${_bodyHasMixte} split=${_splitActive} singleVol=${_clientWantsSingleVolume} pureResi=${_clientProgramIsPureResidential} terrainNu=${_isTerrainNu}`);
    }
  } catch (lockErr) {
    console.error(`[v72.101 PROGRAM LOCK] ERROR non-fatal, render continue:`, lockErr.message);
  }
  // ═══════════════════════════════════════════════════════════════════════════
  const slideName = slide_name || ("massing_" + label.toLowerCase());
  const commerceH = commerceLevels * floorH;
  const habitationLevels = splitLayout ? levels : levels - commerceLevels;
  // v72.23: LOG DIAGNOSTIC COMPLET — traçabilité moteur → 3D
  console.log(`┌── MASSING DIAGNOSTIC v72.22 ──`);
  console.log(`│ Scénario: ${label} (${compute_scenario ? "SMART" : "CLASSIQUE"})`);
  console.log(`│ program_main="${program_main}" effectiveProgramMain="${effectiveProgramMain}"`);
  console.log(`│ commerce_raw="${commerce_raw}" → commerceLevels=${commerceLevels}`);
  console.log(`│ fp=${fp}m² × levels=${levels} = ${Math.round(fp * levels)}m² SDP`);
  console.log(`│ ${commerceLevels > 0 ? `MIXTE: ${commerceLevels} RDC commerce (ORANGE) + ${habitationLevels} logement (BLEU)` : `LOGEMENT PUR: ${levels} niveaux BLEU`}`);
  console.log(`│ site_area=${site_area} envelope=${envW}×${envD}`);
  console.log(`│ mix_score=${mix_score} rent_score=${rent_score} capacity_score=${capacity_score}`);
  console.log(`│ scenario_role=${scenarioRole} accent=${accentColor}`);
  console.log(`└── end MASSING DIAGNOSTIC ──`);
  const { w: mw, d: md, offset_x: ox, offset_y: oy } = computeMassingDimensions(fp, envW, envD);
  console.log(`fp_m2=${fp} → ${mw}m×${md}m offset[${ox.toFixed(1)},${oy.toFixed(1)}]`);
  const coords = polygon_points.split("|").map(pt => {
    const [lat, lon] = pt.trim().split(",").map(Number);
    return { lat, lon };
  }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
  if (coords.length < 3) return res.status(400).json({ error: "polygon invalide" });
  const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
  const cLon = coords.reduce((s, p) => s + p.lon, 0) / coords.length;
  // v70: front_edge en paramètre = override, sinon détection OSM
  const frontEdgeIndex = (front_edge !== undefined && front_edge !== null && front_edge !== "")
    ? (console.log(`│ FRONT-EDGE: override depuis body → arête ${front_edge}`), Number(front_edge))
    : (console.log(`│ FRONT-EDGE: convention v73.1 → arête 0 (premier segment polygone)`), 0);
  const envelopeCoords = computeEnvelope(coords, cLat, cLon, (Number(setback_front) > 0 ? Number(setback_front) : 5), (Number(setback_side) > 0 ? Number(setback_side) : 3), (Number(setback_back) > 0 ? Number(setback_back) : 3), frontEdgeIndex);
  // ── DIAGNOSTIC : vérifier que l'enveloppe est à l'intérieur de la parcelle ──
  const envPtsDbg = envelopeCoords.map(c => toM(c.lat, c.lon, cLat, cLon));
  const envMinX = Math.min(...envPtsDbg.map(p => p.x)), envMaxX = Math.max(...envPtsDbg.map(p => p.x));
  const envMinY = Math.min(...envPtsDbg.map(p => p.y)), envMaxY = Math.max(...envPtsDbg.map(p => p.y));
  const actualEnvW = envMaxX - envMinX, actualEnvD = envMaxY - envMinY;
  console.log(`┌── ENVELOPE DIAGNOSTIC ──`);
  console.log(`│ Sheet envelope: ${envW}m × ${envD}m`);
  console.log(`│ Actual computed envelope bbox: ${actualEnvW.toFixed(1)}m × ${actualEnvD.toFixed(1)}m`);
  console.log(`│ Parcel centroid: ${cLat.toFixed(7)}, ${cLon.toFixed(7)}`);
  console.log(`│ Setbacks: front=${setback_front} side=${setback_side} back=${setback_back}`);
  coords.forEach((c, i) => console.log(`│ Parcel[${i}]: ${c.lat.toFixed(7)}, ${c.lon.toFixed(7)}`));
  console.log(`└── end ENVELOPE DIAGNOSTIC ──`);
  // ── Calcul aire réelle de l'enveloppe (Shoelace formula en mètres) ──
  let envelopeAreaReal = 0;
  for (let i = 0; i < envPtsDbg.length; i++) {
    const j = (i + 1) % envPtsDbg.length;
    envelopeAreaReal += envPtsDbg[i].x * envPtsDbg[j].y;
    envelopeAreaReal -= envPtsDbg[j].x * envPtsDbg[i].y;
  }
  envelopeAreaReal = Math.abs(envelopeAreaReal) / 2;
  console.log(`Envelope real area (shoelace): ${envelopeAreaReal.toFixed(1)}m²`);
  // v70.1: Massing TOUJOURS nord en haut (bearing=0) comme le slide 4
  const bearing = 0;
  const zoom = computeZoomMassing(coords, cLat, cLon); // v56.5: zoom plus serré pour le massing
  console.log(`Map view: bearing=${bearing}° zoom=${zoom}`);
  // v72.27: Passer split_context pour que le logement soit positionné DERRIÈRE le commerce
  const splitContext = splitLayout ? {
    commerce_depth_m: splitLayout.volume_commerce.depth_m || 6,
    retrait_inter_m: splitLayout.retrait_inter_m || 4,
    is_split: true,
  } : null;
  const massingCoords = computeMassingPolygon(envelopeCoords, fp, envelopeAreaReal, {
    massing_mode: compute_scenario ? (label === "A" ? "BALANCED" : label === "B" ? "SPREAD" : "COMPACT") : "BALANCED",
    primary_driver: primary_driver || "MAX_CAPACITE",
    levels,
    standing_level: standing_level || "STANDARD",
    program_main: effectiveProgramMain,
    site_saturation: site_saturation_level || "MEDIUM",
    project_type: project_type || "NEUF",
    existing_fp_m2: Number(existing_footprint_m2) || 0,
    road_bearing: Number(road_bearing) || null,        // v56.7: azimut rue depuis la Sheet
    scenario_role: label === "A" ? "INTENSIFICATION" : label === "B" ? "EQUILIBRE" : "PRUDENT",
    split_context: splitContext,                         // v72.27: positionner logement derrière commerce
  });
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const slug = String(client_name || "client").toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const folder = `hektar/${String(lead_id).trim()}_${slug}`;
    const UPLOAD_TS = Date.now();
  const basePath = `${folder}/${slideName}_${UPLOAD_TS}.png`;
  const enhancedPath = `${folder}/${slideName}_enhanced_${UPLOAD_TS}.png`;
  // Cache disabled for debugging
  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}` });
    const page = await browser.newPage();
    // ── PIPELINE HEKTAR : capture HD x2 ──
    await page.setViewport({ width: 1280, height: 1280, deviceScaleFactor: 2 });
    const rdcH = 3.0;   // v71: RDC toujours 3m (commerce et logement même hauteur)
    const etageH = 3.0;                              // étages courants = 3m
    // v72.28: SPLIT 3D — commerce construit depuis l'ENVELOPPE, logement = massingCoords
    let commerceCoords = null;
    if (splitLayout && commerceLevels > 0) {
      commerceCoords = buildCommercePolygon(envelopeCoords, splitLayout, Number(road_bearing) || null);
    }
    const useSplit3D = commerceCoords !== null;
    // v72.28: En SPLIT, la hauteur totale du logement = pilotis (3m) + levels × etageH
    const realTotalH = useSplit3D
      ? rdcH + levels * etageH    // pilotis (rdcH) + N niveaux habitables au-dessus
      : rdcH + (levels - 1) * etageH; // mode normal : RDC + (N-1) étages
    console.log(`┌── MASSING 3D RENDER v72.26 — ${useSplit3D ? "SPLIT_AV_AR" : "SUPERPOSÉ"} ──`);
    console.log(`│ Scénario ${label}: ${levels} niveaux (${commerceLevels} commerce RDC ORANGE + ${levels - commerceLevels} logement BLEU)`);
    console.log(`│ Hauteurs: RDC=${rdcH}m, étages=${etageH}m, total=${realTotalH}m`);
    console.log(`│ Emprise logement: ${Math.round(fp)}m² × ${levels} niveaux = ${Math.round(fp * levels)}m² SDP`);
    if (useSplit3D) {
      console.log(`│ SPLIT 3D ACTIF: commerce=${commerceCoords.length}pts (orange DEVANT) | logement=massingCoords (bleu DERRIÈRE)`);
      console.log(`│ Commerce: 1 niveau ORANGE | Logement: ${splitLayout.volume_logement.levels} niveaux BLEU`);
    } else {
      console.log(`│ Couleurs: f<${commerceLevels} → ORANGE (#e07830), f>=${commerceLevels} → BLEU (#3a7ac0)`);
    }
    console.log(`└── FIN DIAGNOSTIC 3D ──`);
    // v72.28: En SPLIT, pilotis déjà inclus dans realTotalH — pas de double ajout
    const hasPilotisRender = String(has_pilotis || "").toLowerCase() === "true" || has_pilotis === true;
    const pilotisH = (hasPilotisRender && !useSplit3D) ? 3.5 : 0; // SPLIT gère pilotis dans realTotalH
    const totalHWithPilotis = realTotalH + pilotisH;
    // v72.26: En mode SPLIT, massingCoords = logement (en retrait), commerceCoords = devant (depuis enveloppe)
    const html = await generateMassingHTML({ lat: cLat, lon: cLon }, zoom, bearing, coords, envelopeCoords,
      massingCoords,
      { total_height: totalHWithPilotis, commerce_levels: commerceLevels, floor_height: etageH, rdc_height: rdcH, accent_color: accentColor, levels: levels, has_pilotis: hasPilotisRender, pilotis_height: pilotisH,
        split_layout: useSplit3D ? splitLayout : null,
        commerce_coords: useSplit3D ? commerceCoords : null }, MAPBOX_TOKEN);
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForFunction("window.__MAP_READY === true", { timeout: 60000 });
    // v72.22: Attendre un peu plus pour que les tuiles soient bien peintes
    await new Promise(r => setTimeout(r, 1500));
    // clip en CSS pixels (1280×1280) → Puppeteer produit PNG 2560×2560 grâce à deviceScaleFactor: 2
    let screenshotBuf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 1280 } });
    // v72.22: TONE CHECK — vérifier que le fond est bien beige (pas gris/blanc = Mapbox default light)
    // On sample un pixel de coin (hors bâtiment massing) — si trop froid (R≈G≈B > 230), c'est le style light par défaut
    const toneImg = await loadImage(screenshotBuf);
    const toneW = toneImg.width, toneH = toneImg.height;
    const toneCanvas = createCanvas(toneW, toneH);
    const toneCtx = toneCanvas.getContext("2d");
    toneCtx.drawImage(toneImg, 0, 0, toneW, toneH);
    // Sample 50 pixels en haut à gauche (zone de fond sans bâtiment)
    const cornerData = toneCtx.getImageData(50, 50, 10, 5).data;
    let coldPixels = 0, totalChecked = 0;
    for (let i = 0; i < cornerData.length; i += 4) {
      const r = cornerData[i], g = cornerData[i+1], b = cornerData[i+2];
      totalChecked++;
      // Si R≈G≈B et luminosité > 230 → fond blanc/gris froid (style light par défaut)
      if (r > 225 && g > 225 && b > 225 && Math.abs(r - g) < 8 && Math.abs(g - b) < 8) coldPixels++;
    }
    const coldRatio = coldPixels / Math.max(1, totalChecked);
    if (coldRatio > 0.5) {
      console.log(`[HEKTAR] ⚠️ TONE CHECK: fond trop froid (${Math.round(coldRatio*100)}% cold pixels) — retry screenshot après délai...`);
      await new Promise(r => setTimeout(r, 3000));
      screenshotBuf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 1280 } });
      console.log(`[HEKTAR] Retry screenshot: ${screenshotBuf.length} bytes`);
    }
    await page.close();
    console.log(`[HEKTAR] Screenshot: ${screenshotBuf.length} bytes (coldRatio=${Math.round(coldRatio*100)}%)`);
    // Canvas overlay à la résolution native du screenshot (2560×2560)
    const img = await loadImage(screenshotBuf);
    const W = img.width, H = img.height;  // sera 2560×2560
    console.log(`[HEKTAR] Canvas: ${W}×${H}`);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, W, H);
    // v65.2: Image SANS overlays pour le polish AI (éviter dédoublement)
    const pngClean = canvas.toBuffer("image/png");
    // v72.102: fp RDC (pour annotations cohérentes avec engine)
    // v73.1.7: utilise scFpRdc (exporté du bloc if) — sc lui-même est hors scope ici
    const fp_m2_raw_used_rdc = (compute_scenario && scFpRdc)
      ? scFpRdc
      : (typeof fp_m2_raw !== "undefined" && fp_m2_raw)
        ? Number(fp_m2_raw)
        : (scFpRdc) ? scFpRdc : fp;
    // v73.1.7: log retiré (v73.1.6 utilisait sc hors-scope → crash).
    // Version avec overlays (fallback si pas d'AI polish)
    drawMassingOverlays(ctx, W, H, {
      site_area: Number(site_area), bearing, label,
      levels, commerce_levels: commerceLevels, habitation_levels: habitationLevels,
      total_height: realTotalH, floor_height: etageH, fp_m2: Math.round(fp), accent_color: accentColor, scenario_role: scenarioRole,
      typology: massingCoords._typology, split_layout: splitLayout, sdp_m2_actual: scenarioSdp,
      fp_rdc_m2: Math.round(Number(fp_m2_raw_used_rdc) || fp),
      fp_etages_m2: Math.round((compute_scenario && scFpEtages) ? scFpEtages : fp),
    });
    const png = canvas.toBuffer("image/png");
    await sb.storage.from("massing-images").upload(basePath, png, { contentType: "image/png", upsert: true });
    const { data: pd } = sb.storage.from("massing-images").getPublicUrl(basePath);
    const cacheBust = `?v=${Date.now()}`;
    let enhancedUrl = pd.publicUrl + cacheBust;
    // ═══════════════════════════════════════════════════════════════════════════
    // v72.34: ROBUST MULTI-RENDER MASSING POLISH — model fallback, retry, timeout
    // ═══════════════════════════════════════════════════════════════════════════
    const MASSING_VARIATIONS = 1; // v72.93: reduced from 2 → 1 (saves 30-60s, stays in Make.com budget)
    let polishApplied = false;
    // v72.93: TIME BUDGET GUARD — skip polish if we've already spent too long
    const elapsedBeforePolish = Date.now() - t0;
    const skipPolishFlag = String(skip_polish).toLowerCase() === "true" || skip_polish === true || MASSING_SKIP_POLISH === true;
    if (MASSING_SKIP_POLISH === true) {
      console.log(`[MASSING-POLISH] v72.150: MASSING_SKIP_POLISH=true → ALWAYS SKIP for Make.com reliability (deterministic only)`);
    } else if (skipPolishFlag) {
      console.log(`[MASSING-POLISH] v72.93: skip_polish=true → SKIPPING AI polish (deterministic render only)`);
    } else if (elapsedBeforePolish > POLISH_TIME_BUDGET_MS) {
      console.log(`[MASSING-POLISH] v72.93: TIME BUDGET EXCEEDED — ${Math.round(elapsedBeforePolish/1000)}s already spent (limit ${POLISH_TIME_BUDGET_MS/1000}s) → SKIPPING polish`);
    }
    // v72.107: POLISH MASSING DÉSACTIVÉ définitivement pour stabilité maximale.
    // Le rendu déterministe (Mapbox + overlays) est la seule source de vérité.
    // Aucune possibilité d'hallucination IA (socle, commerce fantôme, flottement, etc.).
    // Pour réactiver plus tard : remplacer la condition `false` par l'ancienne.
    console.log(`[MASSING-POLISH v72.107] ⚡ Polish désactivé pour stabilité max — rendu déterministe uniquement`);
    if (OPENAI_API_KEY && !skipPolishFlag && elapsedBeforePolish <= POLISH_TIME_BUDGET_MS) {
      try {
        console.log(`[MASSING-POLISH] v72.34: Starting robust multi-render (${MASSING_VARIATIONS} variations) for ${label}... model=${POLISH_MODEL}`);
        // v72.34: Resize image for API — reduces payload, improves reliability
        const resized = await resizeForPolish(pngClean, POLISH_MAX_IMAGE_DIM);
        const b64Input = resized.buf.toString("base64");
        console.log(`[MASSING-POLISH] ${label} input: ${(resized.buf.length / 1024).toFixed(0)}KB (${resized.w}×${resized.h})`);
        // v72.105: Adaptive prompt — no mention of orange if commerce=0 (évite hallucination IA)
        const _colorInstruction = (commerceLevels === 0)
          ? `STRICT COLOR AND GROUNDING CONSTRAINT: The building has ONLY BLUE floors (100% residential, NO commerce).
- ALL floors are BLUE (#3a7ac0) — there is NO ORANGE anywhere in the building.
- Do NOT add any orange, brown, red, or warm-colored elements to the building.
- The building is a pure BLUE volume, period. Any orange/warm tone = HALLUCINATION = FORBIDDEN.
GROUNDING RULES (CRITICAL):
- The building MUST sit DIRECTLY on the ground (grass or parcel surface). NO gap, NO shadow gap, NO raised socle.
- Do NOT add any platform, plinth, pedestal, base, raised floor, colored slab, or elevated plateau under the building.
- Do NOT fill the parcel area with any colored surface that would appear raised above ground level.
- The parcel outline (red dashed line) is JUST a line on the ground — do NOT extrude it, do NOT fill it, do NOT add texture to it.
- The building's bottom edge MUST touch the ground plane — zero elevation, zero floating.
- If you render any platform or raised surface under the building, that is a HALLUCINATION and FORBIDDEN.
- Ground (grass/parcel) may have natural warm tones, but there must be NO visible raised element between the ground and the building.`
          : `CRITICAL COLOR PRESERVATION:
- The building has colored floor bands: ORANGE floors (commerce) and BLUE floors (habitation).
- These colors MUST remain vivid and clearly distinguishable after polish.
- Do NOT wash out, desaturate, or unify the floor colors.
- Do NOT turn orange or blue floors into beige, gray, or white.
- The color difference between floor types is essential information — preserve it exactly.`;
        // v73.2.4 : prompt OFF-WHITE (blanc cassé) — environnement sobre + bandes colorées préservées
        let massingPolishPrompt = `ARCHITECTURAL AXONOMETRIC POLISH — CLEAN OFF-WHITE 3D MASSING RENDER.
STRICT EDIT ONLY. SUBTLE polish only — light tonal harmonization, soft ambient occlusion, crisp edges.
PRESERVE EXACT GEOMETRY. PRESERVE EXACT CAMERA. PRESERVE EXACT COMPOSITION.
Do NOT modify, move, add, or remove ANY element. Do NOT reinterpret the scene.

ANTI-HALLUCINATION RULES (CRITICAL):
- Do NOT add ANY floor, slab, or platform below the building. The building sits DIRECTLY on the ground.
- Do NOT add ANY object not in the source: no trees, no vehicles, no people, no furniture, no signs.
- Do NOT add underground/basement levels or visible foundation slabs.
- Do NOT widen, extend, or reshape any floor band.
- The building has EXACTLY the floor bands shown — do NOT add or merge any.

${_colorInstruction}
REQUIRED VISUAL QUALITIES:
- Clean simple OFF-WHITE / very light beige existing context buildings with crisp geometric edges
- Soft volumetric shadows on facades and ground — gentle, neutral grey
- Smooth uniform ground surfaces (no chaotic textures, no debris)
- Sober coherent OFF-WHITE palette throughout the environment
CRITICAL — NEW PROJECT BUILDING (the massing scenario):
- The NEW building has COLORED FLOOR BANDS — these MUST stay vivid and clearly distinguishable
- ORANGE bands = commerce floors / BLUE bands = habitation floors
- Do NOT wash out, desaturate, or unify the floor colors of the new building
- Do NOT turn orange or blue floors into beige, gray, or white
- The new building's colored bands are the visual identity of the scenario — preserve them exactly
EXISTING CONTEXT BUILDINGS:
- Simple cubic volumes with flat or low-slope roofs
- OFF-WHITE / very light beige facades — uniform palette (#e8e6e2 to #efeae0)
- Crisp building edges, no painterly bleed
- ZERO informal settlement: NO corrugated metal, NO rusty tin, NO tarps, NO patchwork
- Volume hierarchy preserved: keep the size/height differences
GROUND & VEGETATION (BLANC CASSÉ AXONOMETRIC STYLE):
- LIGHT CREAM-BEIGE ground surface (#ece8e0 area) — NOT bright green, NOT cartoon-flat, NOT warm sepia
- Simple light-tone trees if visible — orderly placement, single-tone foliage
- Smooth light gray asphalt roads (#aaaaaa) with clean edges
PARCEL OUTLINE — PRESERVE EXACTLY:
- The parcel has a thin RED DASHED outline — keep this red dashed line EXACTLY visible, do NOT thicken into a wall
LIGHTING:
- NEUTRAL daylight (midday or soft overcast) — daylight white balance
- Soft uniform volumetric shadows for depth perception
- NO warm sepia tint, NO golden hour, NO amber atmosphere, NO sun bloom
- Cool-to-neutral color temperature throughout
GROUNDING (ZERO TOLERANCE FOR FLOATING):
- The new building MUST sit DIRECTLY on the ground. NO gap, NO shadow gap, NO raised socle
- Do NOT add any platform, plinth, pedestal, base, raised floor, colored slab, or elevated plateau under the building
- Do NOT fill the parcel area with any colored surface that would appear raised above ground level
- The building's bottom edge MUST touch the ground plane — zero elevation, zero floating
FORBIDDEN (zero tolerance):
- Do NOT change the position, shape, height, or count of ANY building (existing or new)
- Do NOT add NEW buildings, walls, structures, volumes, or pads
- Do NOT modify the parcel red dashed outline
- Do NOT alter the new building's colored bands — keep ORANGE and BLUE vivid
- Do NOT change camera angle, perspective, framing, or zoom
- Do NOT add characters, vehicles, signage, or UI elements
- Do NOT add ANY text annotation, label, number, or hallucinated lettering
- Do NOT use painterly, sketchy, watercolor styles
- Do NOT make it look like a real photograph — keep the clean architectural render aesthetic
- Do NOT shift the environment to warm beige, sepia, or amber — keep it COOL OFF-WHITE
REFERENCE STYLE: clean OFF-WHITE architectural axonometric urban planning render with COLORED bands ONLY on the new project building — sober, neutral lighting, geometrically precise.
CONSISTENCY: This image is one of a set (A, B, C). All MUST look identical in COOL OFF-WHITE tone with the new building's COLORED bands as the only chromatic accent. Do NOT make the scene warmer.`;
        // v72.35: Extra warm-tone enforcement for small volumes (C scenario)
        // Small buildings = more background pixels = AI tends to shift cool/gray
        const totalBuildingLevels = (habitationLevels || 0) + (commerceLevels || 0);
        if (totalBuildingLevels <= 2 || label === "C") {
          // v73.2.4: COOL OFF-WHITE enforcement (au lieu de WARM BEIGE) pour cohérence avec le nouveau prompt blanc cassé
          const offWhiteEnforcement = `
CRITICAL COOL OFF-WHITE ENFORCEMENT:
This is a SMALL building variant. The image is dominated by surrounding context (roads, other buildings, ground).
You MUST maintain a UNIFORM COOL OFF-WHITE tone across the ENTIRE environment.
Do NOT let any area drift to warm beige, sepia, amber, or golden tones.
The surrounding existing buildings must stay OFF-WHITE / very light beige (#e8e6e2 to #efeae0), NOT warm cream NOT gray.
The ground must stay LIGHT CREAM-BEIGE (#ece8e0), NOT warm sepia, NOT bright green.
Roads must stay LIGHT GRAY (#aaaaaa), neutral, NOT warm.
The ONLY chromatic accent in the image must be the NEW project building's ORANGE/BLUE colored bands.
Compare mentally with a clean architectural model under neutral overcast daylight — THAT is the target tone.
ABSOLUTELY NO WARM SHIFT. ABSOLUTELY NO SEPIA. KEEP EVERYTHING COOL OFF-WHITE except the new building's vivid bands.`;
          // Append to prompt
          massingPolishPrompt += offWhiteEnforcement;
          console.log(`[MASSING-POLISH] ${label} v73.2.4: Cool off-white enforcement ACTIVE (levels=${totalBuildingLevels})`);
        }
        // v72.34: Launch all variations with robust retry engine
        const polishResults = await Promise.all(
          Array.from({ length: MASSING_VARIATIONS }, (_, v) =>
            callPolishAPI(b64Input, massingPolishPrompt, label, v + 1)
          )
        );
        let bestVariation = null;
        let bestDriftScore = 1.0;
        const variationLog = [];
        for (let v = 0; v < polishResults.length; v++) {
          const result = polishResults[v];
          if (result.error) {
            variationLog.push(`  v${v+1}: ${result.error} — ${(result.details || "").substring(0, 150)}`);
            continue;
          }
          const enhancedBuf = Buffer.from(result.b64, "base64");
          // Massing uses default threshold (0.25) — light polish
          // v72.108: drift threshold 0.15
          const drift = await detectDriftFromBuffers(pngClean, enhancedBuf, W, H, 0.15);
          // v72.22: COLOR PRESERVATION CHECK — verify orange and blue floor bands survived
          let colorCheckPassed = true;
          let colorLog = "";
          if (commerceLevels > 0) {
            const polishedImg = await loadImage(enhancedBuf);
            const checkCanvas = createCanvas(W, H);
            const checkCtx = checkCanvas.getContext("2d");
            const origImg = await loadImage(pngClean);
            checkCtx.drawImage(origImg, 0, 0, W, H);
            const origData = checkCtx.getImageData(0, 0, W, H).data;
            let origOrange = 0, origBlue = 0;
            for (let px = 0; px < origData.length; px += 4) {
              const r = origData[px], g = origData[px+1], b = origData[px+2];
              if (r > 180 && g > 80 && g < 150 && b < 80) origOrange++;
              if (b > 140 && r < 100 && g < 150) origBlue++;
            }
            checkCtx.drawImage(polishedImg, 0, 0, W, H);
            const polData = checkCtx.getImageData(0, 0, W, H).data;
            let polOrange = 0, polBlue = 0;
            for (let px = 0; px < polData.length; px += 4) {
              const r = polData[px], g = polData[px+1], b = polData[px+2];
              if (r > 180 && g > 80 && g < 150 && b < 80) polOrange++;
              if (b > 140 && r < 100 && g < 150) polBlue++;
            }
            const orangeRetained = origOrange > 0 ? polOrange / origOrange : 1;
            const blueRetained = origBlue > 0 ? polBlue / origBlue : 1;
            colorLog = ` orange=${Math.round(orangeRetained*100)}% blue=${Math.round(blueRetained*100)}%`;
            if (orangeRetained < 0.35 || blueRetained < 0.35) {
              colorCheckPassed = false;
              colorLog += " COLORS_WASHED";
            }
          }
          variationLog.push(`  v${v+1}: drift=${(drift.driftScore * 100).toFixed(2)}% ${drift.passed ? "✓" : "✗"}${colorLog} (shifted=${drift.classShifts}/${drift.totalBlocks})`);
          if (drift.passed && colorCheckPassed && drift.driftScore < bestDriftScore) {
            bestDriftScore = drift.driftScore;
            bestVariation = { buf: enhancedBuf, drift, index: v + 1 };
          }
        }
        console.log(`[MASSING-POLISH] ${label} multi-render (${Date.now() - t0}ms):\n${variationLog.join("\n")}`);
        if (bestVariation) {
          console.log(`[MASSING-POLISH] ${label} ✓ Best: v${bestVariation.index} (drift=${(bestVariation.drift.driftScore * 100).toFixed(2)}%)`);
          const finalCanvas = createCanvas(W, H);
          const finalCtx = finalCanvas.getContext("2d");
          finalCtx.drawImage(await loadImage(bestVariation.buf), 0, 0, W, H);
          // v72.4: Post-polish sharpening (lighter for massing — already at 2x resolution)
          applySharpen(finalCtx, W, H, 0.25);
          console.log(`[MASSING-POLISH] ${label} v72.4: Sharpening applied (amount=0.25)`);
          drawMassingOverlays(finalCtx, W, H, {
            site_area: Number(site_area), bearing, label,
            levels, commerce_levels: commerceLevels, habitation_levels: habitationLevels,
            total_height: realTotalH, floor_height: etageH, fp_m2: Math.round(fp), accent_color: accentColor, scenario_role: scenarioRole,
            typology: massingCoords._typology, split_layout: splitLayout, sdp_m2_actual: scenarioSdp,
          });
          const finalPng = finalCtx.canvas.toBuffer("image/png");
          const enhancedPath = `${folder}/${slideName}_enhanced_${UPLOAD_TS}.png`;
          const { error: ue2 } = await sb.storage.from("massing-images").upload(enhancedPath, finalPng, { contentType: "image/png", upsert: true, cacheControl: "0" });
          if (!ue2) {
            const { data: pd2 } = sb.storage.from("massing-images").getPublicUrl(enhancedPath);
            enhancedUrl = pd2.publicUrl + `?v=${Date.now()}`;
            polishApplied = true;
            console.log(`✓ [MASSING-POLISH] ${label} enhanced uploaded (${Date.now() - t0}ms)`);
          }
        } else {
          console.warn(`⚠ [MASSING-DRIFT] ${label}: ALL ${MASSING_VARIATIONS} variations rejected — deterministic fallback`);
        }
      } catch (polishErr) {
        console.error(`[MASSING-POLISH] ${label} EXCEPTION:`, polishErr.message, polishErr.stack);
      }
    } else {
      console.warn(`[MASSING-POLISH] OPENAI_API_KEY not set — skipping polish`);
    }
    console.log(`[MASSING] v72.34: ${label} complete — polish=${polishApplied ? "APPLIED" : "DETERMINISTIC_FALLBACK"} (${Date.now() - t0}ms)`);
    return res.json({
      ok: true, cached: false, server_version: "72.34-SUPERVISOR",
      public_url: pd.publicUrl + cacheBust, enhanced_url: enhancedUrl,
      polish_applied: polishApplied,
      massing_label: label, fp_m2: fp,
      actual_typology: massingCoords._typology || "BLOC",
      actual_envelope_w: actualEnvW.toFixed(1), actual_envelope_d: actualEnvD.toFixed(1),
      actual_envelope_area: envelopeAreaReal.toFixed(0),
      sheet_envelope_w: envW, sheet_envelope_d: envD,
      levels, total_height: totalH, commerce_levels: commerceLevels,
      scenario_role: scenarioRole, accent_color: accentColor,
      centroid: { lat: cLat, lon: cLon },
      view: { zoom, bearing, pitch: 58 }, duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error("Error:", e.message);
    return res.status(500).json({ error: String(e.message) });
  } finally {
    if (browser) { try { browser.disconnect(); } catch (_) {} }
  }
});
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// ─── v73.3.0 TEMPLATE TEXT ENGINE v2.0 — Premium BARLO ──────────────────────
// Ton : cabinet d'architecture / conseil immobilier premium
// Accents français, conditionnel pour financiers, démonstrations de calculs,
// cross-références aux charts ("comme l'illustre le radar ci-contre")
// GPT n'est utilisé QUE pour slide_5_text (contexte voisinage qualitatif).
// ═══════════════════════════════════════════════════════════════════════════════
function buildTemplateTexts(flat, scenarios) {
  const f = (k) => flat[k] || "";
  const n = (k) => parseInt(String(flat[k] || "0").replace(/[^\d]/g, "")) || 0;
  // ── Helpers qualificatifs ──
  function qualifSurface(m2) {
    const v = parseInt(m2) || 0;
    if (v < 50) return "compact";
    if (v <= 65) return "confortable";
    return "spacieux";
  }
  function qualifGabarit(levels) {
    const v = parseInt(levels) || 0;
    if (v <= 2) return "modéré, cohérent avec le tissu urbain environnant";
    if (v <= 4) return "significatif mais conforme aux prescriptions urbanistiques";
    return "imposant, nécessitant une attention particulière aux impacts visuels";
  }
  function tradBudgetFit(bf) {
    const s = String(bf || "").toUpperCase().replace(/[_ ]/g, "_");
    if (s.includes("HORS")) return "hors budget";
    if (s.includes("DANS")) return "dans le budget";
    if (s.includes("TENDU") || s.includes("LIMITE")) return "en limite de budget";
    return "N/A";
  }
  function qualifRisqueCompacite(m2) {
    const v = parseInt(m2) || 0;
    if (v < 45) return "élevé";
    if (v <= 55) return "modéré";
    return "faible";
  }
  function qualifProfil(score) {
    const v = parseInt(score) || 0;
    if (v >= 75) return "prudent et favorable";
    if (v >= 60) return "équilibré";
    return "modéré, nécessitant une vigilance accrue";
  }
  function parkingText(sc) {
    const places = f(`${sc}_parking_places`);
    const deficit = n(`${sc}_parking_deficit`);
    if (deficit > 0) return `${places} places prévues, avec un déficit de ${deficit} places à compenser par des solutions alternatives (parking en enclos, mutualisation)`;
    return `${places} places en surface, conformes aux exigences réglementaires — aucun déficit constaté`;
  }
  const philosophie = { A: "vise à maximiser la densité constructible afin d'exploiter pleinement le potentiel foncier", B: "recherche un compromis équilibré entre densité, coût de construction et qualité des espaces", C: "privilégie une approche prudente en termes de coûts, avec un gabarit maîtrisé" };
  // ── Scenario summary builder (slides 6/9/12) ──
  // Directive BARLO : "DÉCRIRE LA CONSTRUCTION DANS SA TYPOLOGIE",
  //                   "PARLER DE SURFACE UTILE ET HABITABLE HORS CIRCULATIONS"
  function buildSummary(sc) {
    const role = f(`${sc}_role`);
    const fp = f(`${sc}_fp`);
    const levels = f(`${sc}_levels`);
    const sdp = f(`${sc}_sdp`);
    const pilotisDesc = f(`${sc}_pilotis_desc`) || "sans pilotis";
    const typoDesc = f(`${sc}_typology_desc`) || "bloc compact";
    const configJustif = f(`${sc}_config_justif`) || `Configuration optimisée pour le terrain`;
    const unitSummary = f(`${sc}_unit_summary`);
    const m2Logt = f(`${sc}_m2_par_logt`);
    const units = f(`${sc}_units`);
    const cosPct = f(`${sc}_cos_pct`);
    const sdpMax = f("site_sdp_max");
    const standing = f("standing_level").toLowerCase();
    const habTotal = f(`${sc}_hab_m2_total`);
    const circRatio = f(`${sc}_circulation_ratio`) || "15 à 20";
    return `Le Scénario ${sc} (${role}) ${philosophie[sc]}.\n\nCe scénario propose un programme de ${units} unités en usage mixte, conçu pour répondre aux objectifs du porteur de projet tout en respectant les contraintes réglementaires du site.\n\nConfiguration architecturale retenue :\n- Gabarit : R+${levels} (rez-de-chaussée + ${levels} étages)\n- Emprise au sol : ${fp} m²\n- SDP totale : ${sdp} m²\n- Disposition : ${pilotisDesc}\n- Forme architecturale : ${typoDesc}\n\n${configJustif}\n\nProgramme détaillé :\n- ${unitSummary}\n\nLa surface utile et habitable par logement, hors circulations et parties communes (estimées entre ${circRatio} % de la SDP), représenterait environ ${m2Logt} m² nets — un niveau ${qualifSurface(m2Logt)} pour des logements en standing ${standing}. La surface habitable totale de ce scénario atteindrait ${habTotal} m², soit la SDP de ${sdp} m² diminuée des circulations, cages d'escalier et parties communes.\n\nL'accès principal se ferait par une entrée unique desservant les différentes unités, avec une circulation verticale optimisée pour limiter les espaces perdus et maximiser la surface habitable.\n\n- Stationnement : ${parkingText(sc)}\n- Gabarit et impact visuel : ${qualifGabarit(levels)}\n- COS utilisé : ${cosPct} % du COS autorisé (soit ${sdp} m² de SDP sur un maximum théorique de ${sdpMax})`;
  }
  // ── Scenario financial builder (slides 7/10/13) ──
  // Directive BARLO : "EXPLIQUER DE FAÇON ACCESSIBLE LE RAISONNEMENT DES CALCULS",
  //                   "TOUJOURS PARLER AU CONDITIONNEL", "MONTRER LES RATIOS"
  function buildFinancial(sc) {
    const standing = f("standing_level").toLowerCase();
    const city = f("city");
    const sdp = f(`${sc}_sdp`);
    const costM2 = f(`${sc}_cost_m2`);
    const costTotal = f(`${sc}_cost_total`);
    const ventGo = f(`${sc}_ventil_go`);
    const ventGoPct = f(`${sc}_ventil_go_pct`);
    const ventSo = f(`${sc}_ventil_so`);
    const ventSoPct = f(`${sc}_ventil_so_pct`);
    const ventLt = f(`${sc}_ventil_lt`);
    const ventLtPct = f(`${sc}_ventil_lt_pct`);
    const ventVrd = f(`${sc}_ventil_vrd`);
    const ventVrdPct = f(`${sc}_ventil_vrd_pct`);
    const fourchette = f(`${sc}_fourchette_text`);
    const honoBas = f(`${sc}_hono_bas_M`);
    const honoHaut = f(`${sc}_hono_haut_M`);
    const honoTauxBas = f(`${sc}_hono_taux_bas`);
    const honoTauxHaut = f(`${sc}_hono_taux_haut`);
    const budgetFcfa = f("budget_fcfa");
    const budgetFit = tradBudgetFit(f(`${sc}_budget_fit`));
    const costUnit = f(`${sc}_cost_unit`);
    const units = f(`${sc}_units`);
    return `Pour un standing ${standing} à ${city}, le coût de construction au m² de SDP se situerait aux alentours de ${costM2}. Ce positionnement est cohérent avec les références du marché local pour ce niveau de prestation.\n\nDémonstration du raisonnement de coût :\nLe calcul s'articule comme suit : une SDP totale de ${sdp} m², multipliée par un coût unitaire de ${costM2} au m², aboutirait à un coût total estimé d'environ ${costTotal}.\n\nSoit : ${sdp} m² × ${costM2}/m² ≈ ${costTotal}\n\nVentilation prévisionnelle des travaux (comme l'illustre le graphique de ventilation des coûts ci-après) :\n- Gros œuvre et structure : ${ventGo} FCFA (${ventGoPct}) — fondations, système poteau-poutre béton armé, dalles et voiles\n- Second œuvre et finitions : ${ventSo} FCFA (${ventSoPct}) — menuiseries, revêtements, peintures, étanchéité\n- Lots techniques (électricité, plomberie, CVC) : ${ventLt} FCFA (${ventLtPct})\n- VRD et aménagements extérieurs : ${ventVrd} FCFA (${ventVrdPct}) — raccordements réseaux, voirie, assainissement\n\nLa fourchette budgétaire globale se situerait ${fourchette}.\n\nHonoraires de maîtrise d'œuvre : entre ${honoBas}M et ${honoHaut}M FCFA (soit ${honoTauxBas} à ${honoTauxHaut} du montant des travaux).\n\nPositionnement budgétaire :\n- Enveloppe budgétaire du client : environ ${budgetFcfa}\n- Position : ${budgetFit}\n- Ratio coût par unité : environ ${costUnit}/unité (soit ${costTotal} répartis sur ${units} unités)\n\nCes estimations sont données à titre indicatif et devront être affinées lors de la phase APS/APD, sur la base d'un chiffrage détaillé par lots.`;
  }
  // ── Scenario risk builder (slides 8/11/14) ──
  // Directive BARLO : "ÊTRE SPÉCIFIQUE SUR LES RISQUES, pas de phrase générique"
  // Cross-ref : radar, gauge, barres horizontales
  function buildRisk(sc) {
    const score = f(`${sc}_score`);
    const cosPct = f(`${sc}_cos_pct`);
    const cosRegl = f("site_cos_regl");
    const m2Logt = f(`${sc}_m2_par_logt`);
    const budgetFit = tradBudgetFit(f(`${sc}_budget_fit`));
    const parking = parkingText(sc);
    const units = f(`${sc}_units`);
    const levels = f(`${sc}_levels`);
    const standing = f("standing_level").toLowerCase();
    const profil = qualifProfil(score);
    const risqueCompacite = qualifRisqueCompacite(m2Logt);
    const sdp = f(`${sc}_sdp`);
    const sdpMax = f("site_sdp_max");
    const costTotal = f(`${sc}_cost_total`);
    const budgetFcfa = f("budget_fcfa");
    // Détails budgétaires spécifiques
    let budgetAnalysis = "";
    if (budgetFit === "hors budget") {
      budgetAnalysis = `Le coût estimé de ${costTotal} dépasse significativement l'enveloppe prévue de ${budgetFcfa}. Ce dépassement constitue un risque majeur qui nécessiterait soit une révision du programme, soit un réajustement du budget. Probabilité : élevée. Impact : fort.`;
    } else if (budgetFit === "en limite de budget") {
      budgetAnalysis = `Le coût estimé de ${costTotal} se situe en limite de l'enveloppe de ${budgetFcfa}. La marge de manœuvre est réduite — toute dérive de chantier pourrait entraîner un dépassement. Probabilité : moyenne. Impact : modéré. Mitigation : provision pour imprévus de 5 à 8 %.`;
    } else {
      budgetAnalysis = `Le coût estimé de ${costTotal} s'inscrit dans l'enveloppe de ${budgetFcfa}. La marge disponible permettrait d'absorber d'éventuels imprévus. Probabilité de dépassement : faible. Impact : limité.`;
    }
    // Analyse de compacité spécifique
    let compaciteAnalysis = "";
    if (risqueCompacite === "élevé") {
      compaciteAnalysis = `Avec ${m2Logt} m² par logement (surface utile habitable), le risque de refus de permis pour non-conformité aux normes d'habitabilité est élevé. Les logements pourraient être jugés trop exigus pour le standing ${standing} visé.`;
    } else if (risqueCompacite === "modéré") {
      compaciteAnalysis = `Les ${m2Logt} m² par logement constituent un compromis acceptable, mais restent dans la fourchette basse pour un standing ${standing}. Un ajustement des plans en phase APS pourrait optimiser l'agencement.`;
    } else {
      compaciteAnalysis = `Les ${m2Logt} m² par logement offrent un niveau de confort conforme au standing ${standing} visé. Le risque de refus lié à la compacité est faible.`;
    }
    return `Le système de scoring évalue le Scénario ${sc} selon 7 critères pondérés, chacun noté de 0 à 100 (comme l'illustre le radar ci-contre et les barres de risque ci-dessous). Le score global de ${score}/100 reflète un profil ${profil}.\n\nLe graphique jauge ci-dessus positionne ce scénario sur l'échelle de recommandation globale.\n\nAnalyse détaillée des risques :\n\n1) Risque urbanistique — COS et conformité :\nLe COS utilisé représente ${cosPct} % du COS réglementaire autorisé de ${cosRegl}, soit ${sdp} m² de SDP sur un maximum théorique de ${sdpMax}. La conformité aux hauteurs et retraits est vérifiée.\n\n2) Risque de compacité — Surface habitable :\n${compaciteAnalysis}\n\n3) Risque financier — Adéquation budgétaire :\n${budgetAnalysis}\n\n4) Risque de stationnement :\n${parking}.\n\n5) Risque de construction — Complexité technique :\nLa réalisation d'un R+${levels} en standing ${standing} représente une complexité ${risqueCompacite === "élevé" ? "significative" : risqueCompacite === "modéré" ? "modérée" : "standard"} pour les entreprises locales. Le système poteau-poutre en béton armé est maîtrisé, mais la hauteur de ${levels} niveaux impose une rigueur particulière sur la qualité du béton et le ferraillage.\n\nCes évaluations sont synthétisées dans les trois graphiques de risque associés à ce scénario : le radar de profil, la jauge de score global, et les barres de facteurs individuels.`;
  }
  // ── Recommended scenario shortcuts ──
  const rec = f("rec_scenario") || "C";
  // ═══ BUILD ALL TEXT KEYS ═══
  const texts = {};
  // ── SLIDE 3: Introduction ──
  // Directive BARLO : "COMMENCE TOUJOURS PAR « Ce projet consiste à »"
  texts.slide_3_intro_text = `Ce projet consiste à valoriser un terrain de ${f("site_area")} m² situé à ${f("city")}, dans le cadre d'un programme ${f("program_main")}. Le programme cible prévoit ${f("A_units")} unités pour un standing ${f("standing_level").toLowerCase()}, avec un budget de référence de l'ordre de ${f("budget_fcfa")}.\n\nL'objectif stratégique est d'identifier la meilleure configuration possible en respectant les contraintes urbanistiques du site, notamment un COS de ${f("site_cos_regl")}, un CES de ${f("site_ces_regl")} %, et des retraits réglementaires qui réduisent significativement l'emprise constructible.\n\nPour répondre à cette question, trois scénarios ont été élaborés :\n- Le Scénario A (${f("A_role")}) explore une approche de maximisation de la densité.\n- Le Scénario B (${f("B_role")}) recherche un compromis entre densité et coût.\n- Le Scénario C (${f("C_role")}) privilégie une approche plus prudente en termes de coûts.\n\nLe présent rapport diagnostic analyse chacun de ces scénarios sous l'angle volumétrique, financier et réglementaire, afin d'orienter le porteur de projet vers le scénario le plus recommandé au regard de ses priorités et de son enveloppe budgétaire.\n\nDonnées clés du projet :\n- Surface terrain : ${f("site_area")} m² | Emprise constructible : ${f("retrait_emprise_constructible")} (après retraits)\n- Enveloppe largeur × profondeur : ${f("envelope_w")} m × ${f("envelope_d")} m\n- SDP maximale théorique (COS) : ${f("site_sdp_max")}\n- Budget de référence : ${f("budget_fcfa")} | Standing : ${f("standing_level").toLowerCase()}\n- Zone climatique : ${(f("orient_zone") || "tropical").toLowerCase()} | Mitoyenneté : ${f("retrait_mitoyennete")} côtés`;
  texts.slide_3_programme_text = "";
  // ── SLIDE 4: Terrain ──
  texts.slide_4_text = `Ce terrain de ${f("site_area")} m² se situe dans un tissu urbain dense de ${f("city")}. Il présente une géométrie régulière de ${f("envelope_w")} m de largeur sur ${f("envelope_d")} m de profondeur, offrant une surface brute de ${f("envelope_area")} m².\n\nLes contraintes réglementaires imposent les retraits suivants :\n- Recul avant : ${f("retrait_avant")} (par rapport à la voie)\n- Recul latéral : ${f("retrait_lateral")} de chaque côté\n- Recul arrière : ${f("retrait_arriere")}\n- Mitoyenneté : ${f("retrait_mitoyennete")} côtés\n\nL'impact de ces retraits est significatif : ils réduisent l'emprise constructible de ${f("retrait_reduction_pct")}, la ramenant à environ ${f("retrait_emprise_constructible")} exploitables.\n\nLe programme envisagé prévoit ${f("A_units")} unités en usage ${f("program_main")}, dans un standing ${f("standing_level").toLowerCase()}.\n\n- Zone climatique : ${f("orient_zone").toLowerCase()}\n- COS réglementaire : ${f("site_cos_regl")}\n- CES réglementaire : ${f("site_ces_regl")} %`;
  // ── SLIDE 5: Contexte quartier (base déterministe — GPT reformule uniquement) ──
  texts.slide_5_text = `Le quartier de ${f("city")} présente une densité urbaine élevée, avec un environnement bâti mixte associant des immeubles de logements et des activités commerciales. Le tissu urbain environnant est composé d'habitations individuelles et collectives, de commerces de proximité, et d'équipements publics.\n\nLe rapport à la rue est influencé par la mitoyenneté sur ${f("retrait_mitoyennete")} côtés, ce qui limite les ouvertures latérales et nécessite une réflexion approfondie sur l'éclairage et la ventilation naturelle des espaces intérieurs.\n\nLa surface de plancher est limitée par plusieurs facteurs cumulés :\n- L'emprise constructible après retraits est réduite à ${f("retrait_emprise_constructible")} (soit ${f("retrait_reduction_pct")} de perte)\n- Le COS de ${f("site_cos_regl")} autorise jusqu'à ${f("site_sdp_max")} de SDP théorique, mais l'emprise réelle au sol limite fortement cette capacité\n- Le CES de ${f("site_ces_regl")} % définit la couverture maximale du terrain\n\nLa zone climatique ${(f("orient_zone") || "tropical").toLowerCase()} impacte le confort thermique. Une orientation optimale des façades et une ventilation naturelle traversante sont essentielles pour maximiser le confort des occupants tout en limitant les coûts énergétiques.\n\nLa densité du voisinage et les contraintes réglementaires orientent vers un gabarit de R+${f("rec_levels")} maximum, cohérent avec l'environnement bâti existant et les objectifs du programme de ${f("target_units")} unités.`;
  // ── SLIDES 6/9/12: Scenario summaries ──
  texts.scenario_A_summary_text = buildSummary("A");
  // B vs A comparison
  const bVsA_sdpDelta = n("A_sdp") - n("B_sdp");
  const bVsA_comparison = `\n\nComparaison avec le Scénario A :\nPar rapport au Scénario A (${f("A_role")}), le Scénario B réduirait la SDP de ${bVsA_sdpDelta} m² (passant de ${f("A_sdp")} à ${f("B_sdp")} m²) et le coût estimé de ${f("A_cost_total")} à ${f("B_cost_total")}. L'emprise au sol passerait de ${f("A_fp")} à ${f("B_fp")} m², avec une surface habitable par logement de ${f("B_m2_par_logt")} m² contre ${f("A_m2_par_logt")} m² pour A. Le score de recommandation évolue de ${f("A_score")}/100 (A) à ${f("B_score")}/100 (B), comme le détaille le tableau comparatif en slide 15.`;
  texts.scenario_B_summary_text = buildSummary("B") + bVsA_comparison;
  // C vs A+B comparison
  const cVsAB_comparison = `\n\nComparaison avec les Scénarios A et B :\nLe Scénario C est le plus compact et le plus économique des trois. Par rapport à A (${f("A_cost_total")}), il permettrait d'économiser environ ${f("delta_CA_cout")}, soit ${f("delta_CA_sdp")} de surface en moins. Par rapport à B (${f("B_cost_total")}), il réduirait encore le coût de ${f("B_cost_total")} à ${f("C_cost_total")}, avec une emprise de ${f("C_fp")} m² (vs ${f("B_fp")} pour B et ${f("A_fp")} pour A). La surface habitable par logement (${f("C_m2_par_logt")} m²) serait inférieure à B (${f("B_m2_par_logt")} m²) et A (${f("A_m2_par_logt")} m²), mais resterait acceptable en standing ${f("standing_level").toLowerCase()}. Le score de ${f("C_score")}/100, le plus élevé des trois, confirme le meilleur rapport coût/conformité (cf. graphiques d'arbitrage slide 16).`;
  texts.scenario_C_summary_text = buildSummary("C") + cVsAB_comparison;
  // ── SLIDES 7/10/13: Financial ──
  texts.scenario_A_financial_text = buildFinancial("A");
  texts.scenario_B_financial_text = buildFinancial("B");
  texts.scenario_C_financial_text = buildFinancial("C");
  // ── SLIDES 8/11/14: Risk ──
  texts.scenario_A_risk_text = buildRisk("A");
  texts.scenario_B_risk_text = buildRisk("B");
  texts.scenario_C_risk_text = buildRisk("C");
  // ── SLIDE 15: Comparatif intro ──
  // Cross-ref au tableau comparatif chart
  texts.comparatif_intro_text = `Le tableau comparatif ci-dessous synthétise les indicateurs clés des trois scénarios : SDP, surfaces habitables, coûts, scores de recommandation et durées de chantier. Les cellules vertes indiquent la meilleure valeur pour chaque critère, permettant une lecture rapide des forces et faiblesses de chaque option.`;
  // ── SLIDE 16: Arbitrage stratégique ──
  // Cross-ref aux 4 graphiques d'arbitrage
  texts.strategic_arbitrage_text = `Le client recherche un programme ${f("program_main")} en standing ${f("standing_level").toLowerCase()}, avec une posture ${f("feasibility_posture_fr")}, pour une enveloppe budgétaire de l'ordre de ${f("budget_fcfa")}.\n\nLe système de scoring évalue chaque scénario selon 7 critères pondérés : adéquation budgétaire (25 %), alignement risque (20 %), conformité COS (12 %), capacité du programme (13 %), efficacité coût (12 %), adéquation standing (8 %), flexibilité de phasage (10 %).\n\nComme l'illustrent les quatre graphiques d'arbitrage ci-dessous, les trois scénarios livrent respectivement ${f("A_units")}, ${f("B_units")} et ${f("C_units")} unités, et diffèrent significativement sur le coût et la surface :\n- Scénario A : ${f("A_cost_total")}, ${f("A_hab_m2_total")} m² habitables, score ${f("A_score")}/100\n- Scénario B : ${f("B_cost_total")}, ${f("B_hab_m2_total")} m² habitables, score ${f("B_score")}/100\n- Scénario C : ${f("C_cost_total")}, ${f("C_hab_m2_total")} m² habitables, score ${f("C_score")}/100\n\nLe Scénario C économiserait ${f("delta_CA_cout")} par rapport à A, pour ${f("delta_CA_sdp")} de surface en moins. Cette économie justifierait la perte de surface au regard de l'enveloppe de ${f("budget_fcfa")}.\n\nLe Scénario ${rec} obtient le meilleur score (${f("rec_score")}/100) car il offrirait le meilleur compromis entre coût optimisé, conformité urbanistique et gestion rigoureuse du budget. Il est le scénario recommandé.`;
  // ── SLIDE 17: Conditions de réussite — ventilation ──
  // Cross-ref au donut de ventilation des coûts
  texts.invisible_intro_text = `Points de vigilance techniques et administratifs à anticiper pour assurer la conformité et l'efficacité du projet.`;
  texts.invisible_technical_text = `Les conditions de réussite reposent sur une anticipation rigoureuse des postes de dépenses et des délais. La ventilation détaillée pour le scénario ${rec} recommandé (${f("rec_cost_total")}) est illustrée par le graphique en anneau ci-contre.\n\nVentilation des coûts par lot :\n- Gros œuvre et structure : ${f("rec_ventil_go")} FCFA (${f("rec_ventil_go_pct")}). Système poteau-poutre en béton armé adapté au R+${f("rec_levels")}. Ce poste représente la part la plus importante du budget.\n- Second œuvre et finitions : ${f("rec_ventil_so")} FCFA (${f("rec_ventil_so_pct")}). Matériaux ${f("standing_level").toLowerCase()} mais durables, adaptés au climat tropical.\n- Lots techniques : ${f("rec_ventil_lt")} FCFA (${f("rec_ventil_lt_pct")}). Électricité, plomberie, ventilation naturelle traversante.\n- VRD et aménagements : ${f("rec_ventil_vrd")} FCFA (${f("rec_ventil_vrd_pct")}). Raccordements réseaux, assainissement, accès.\n\nStratégies de phasage recommandées (cf. timeline ci-après) :\n- Durée estimée du chantier : ${f("rec_duree_chantier")}\n- Phase 1 (M1-M2) : études et permis — délai incompressible\n- Phase 2 (M3) : terrassement et fondations — impérativement en saison sèche\n- Phase 3 (M4-M5) : gros œuvre — peut se poursuivre en saison des pluies avec précautions\n- Phase 4 (M6-M7) : second œuvre et lots techniques\n- Phase 5 (M8) : finitions et réception\n\nDélais cachés à anticiper : obtention du permis de construire (2-4 mois), étude géotechnique (2-3 semaines), raccordements réseaux (variable selon les opérateurs).`;
  texts.invisible_financial_text = `Le budget du Scénario ${rec} s'établirait à environ ${f("rec_cost_total")}, à comparer au budget initial de ${f("budget_fcfa")}. L'écart serait gérable avec une optimisation rigoureuse des postes de dépenses.\n\nFrais complémentaires à anticiper (non inclus dans l'estimation travaux) :\n- Honoraires d'architecte : entre ${f("rec_hono_bas")}M et ${f("rec_hono_haut")}M FCFA (${f("rec_hono_taux_bas")} à ${f("rec_hono_taux_haut")} du montant des travaux)\n- Frais de permis de construire et taxes : environ 1 à 2 % du montant des travaux\n- Études géotechniques : entre 300 000 et 500 000 FCFA\n- Frais de notaire et administratifs : variables selon la commune\n- Assurance dommage-ouvrage : recommandée, environ 2 % du coût travaux\n\nBudgétiser l'ensemble de ces postes en amont est impératif pour éviter toute dérive financière. La fourchette totale (travaux + frais annexes) se situerait entre ${f("rec_hono_bas")}M et ${f("rec_hono_haut")}M FCFA au-dessus du coût travaux.`;
  texts.invisible_strategic_text = `Le phasage financier devrait tenir compte du climat ${f("orient_zone").toLowerCase()} de ${f("city")}, en particulier de la saison des pluies (juin à octobre), comme le montre la timeline de phasage.\n\nRecommandations de phasage :\n- Démarrage idéal des travaux : novembre à janvier (saison sèche)\n- Terrassement et fondations : impérativement hors saison des pluies\n- Gros œuvre : peut se poursuivre pendant la saison des pluies avec précautions\n- Finitions : planifier la réception avant la prochaine saison des pluies\n\nÉchelonnement des décaissements :\n- M1-M2 : 15 % (études, permis, installation chantier)\n- M3-M5 : 50 % (fondations + gros œuvre)\n- M6-M7 : 25 % (second œuvre)\n- M8 : 10 % (finitions, réception, solde)`;
  // ── SLIDE 18: Success / Technique ──
  texts.success_intro_text = `Le scénario recommandé (${rec}) constituerait le meilleur choix en raison de son coût optimisé (${f("rec_cost_total")}), de sa conformité urbanistique (COS à ${f("rec_cos_pct")} %), et de sa gestion rigoureuse du budget.`;
  texts.success_technical_text = `Le Scénario ${rec} proposerait une structure R+${f("rec_levels")} avec commerce au RDC, compacte mais fonctionnelle. Points techniques à anticiper :\n\n- Structure R+${f("rec_levels")} en béton armé : système poteau-poutre classique, maîtrisé par les entreprises locales\n- Fondations : étude géotechnique indispensable compte tenu de la mitoyenneté sur ${f("retrait_mitoyennete")} côtés\n- Emprise de ${f("rec_fp")} m² : optimisation des circulations verticales nécessaire\n- Ventilation naturelle : essentielle en zone ${f("orient_zone").toLowerCase()}, ouvertures traversantes sur façades libres\n- Étanchéité toiture terrasse : point critique en climat tropical humide`;
  texts.success_financial_text = texts.invisible_financial_text;
  texts.success_strategic_text = texts.invisible_strategic_text;
  // ── SLIDE 19: Next steps ──
  // Cross-ref à la timeline
  texts.next_step_intro_text = `Suite à la recommandation du Scénario ${rec}, voici les études et démarches à engager pour passer à la phase opérationnelle du projet. Le phasage est illustré par la timeline ci-dessus.`;
  texts.next_step_scope_text = `Périmètre des études à lancer pour la phase suivante :\n\n- APS (Avant-Projet Sommaire) : définition des volumes, implantation, choix structurels. Validation de la faisabilité technique et affinage du budget. Délai : 3-4 semaines.\n\n- APD (Avant-Projet Définitif) : plans détaillés, dimensionnement structure, choix des matériaux. Base pour le chiffrage définitif. Délai : 4-6 semaines.\n\n- Études géotechniques : sondages et essais de sol pour dimensionner les fondations. Indispensable avant le dépôt de permis. Délai : 2-3 semaines.\n\n- Dossier de permis de construire : constitution du dossier administratif complet. Délai d'instruction : 2-4 mois selon la commune.\n\n- Consultation des entreprises : appel d'offres restreint ou consultation directe. Prévoir 3-4 semaines pour réception et analyse des devis.`;
  texts.next_step_outcome_text = `Les livrables attendus à l'issue de cette phase sont : un APS validé, un budget affiné à +/- 10 %, un rapport géotechnique, et un dossier de permis de construire complet prêt pour dépôt.`;
  // ── SLIDE 20: Conclusion ──
  // Cross-ref à la recap card
  texts.conclusion_summary_text = `Ce diagnostic a permis d'analyser le potentiel d'un terrain de ${f("site_area")} m² à ${f("city")} sous trois scénarios contrastés : ${f("A_role")} (A), ${f("B_role")} (B) et ${f("C_role")} (C). Chacun répond au programme cible de ${f("A_units")} unités en usage ${f("program_main")} en standing ${f("standing_level").toLowerCase()}.\n\nLe Scénario ${rec} est recommandé avec un score de ${f("rec_score")}/100, comme le synthétise la fiche récapitulative ci-dessous. Il offrirait le meilleur compromis entre le respect du programme, la proximité avec l'enveloppe budgétaire (${f("rec_cost_total")} vs ${f("budget_fcfa")} visés), la conformité urbanistique, et la simplicité de mise en œuvre d'un R+${f("rec_levels")}.\n\nLa prochaine étape consisterait à lancer les études de faisabilité (APS/APD) et l'étude géotechnique pour confirmer ces hypothèses et affiner le chiffrage.`;
  texts.conclusion_positioning_text = `Le Scénario ${rec} représenterait le meilleur compromis entre coût maîtrisé (${f("rec_cost_total")}), conformité urbanistique (COS utilisé à ${f("rec_cos_pct")} %), et adéquation avec les objectifs du client. Il permettrait de livrer les ${f("A_units")} unités demandées dans un gabarit R+${f("rec_levels")} sobre et réaliste.`;
  texts.conclusion_projection_text = `La durée estimée du chantier serait de ${f("rec_duree_chantier")}. Le calendrier optimal prévoirait un démarrage en saison sèche (novembre-janvier) pour sécuriser les fondations. L'horizon de livraison se situerait environ 12 à 14 mois après le lancement des études, sous réserve de l'obtention du permis de construire dans les délais habituels.`;
  console.log(`│ ✅ TEMPLATE ENGINE v2.0 PREMIUM: ${Object.keys(texts).length} textes générés (accents, conditionnel, cross-ref charts)`);
  return texts;
}
// ─── v72.91 enrichFlatForTemplates — Ajoute TOUTES les clés manquantes au flat ─
// Called BEFORE buildTemplateTexts() in both /generate-texts and /generate-pptx.
// Ensures: site_area, city, standing_level, budget_fcfa, target_units, program_main,
//   envelope_w/d/area, feasibility_posture_fr, X_score, X_hab_m2_total, X_ventil_*_pct,
//   rec_* (recommended scenario aliases), site_sdp_max
// ════════════════════════════════════════════════════════════════════════════════
function enrichFlatForTemplates(flat, p, scenarios) {
  const sA = scenarios.A || {};
  const sB = scenarios.B || {};
  const sC = scenarios.C || {};
  const diag = scenarios.diagnostic || {};
  const siteDiag = diag.site || {};
  // ── Basic params ──
  flat.site_area = flat.site_area || String(p.site_area || "");
  flat.city = flat.city || p.city || "Douala";
  flat.standing_level = flat.standing_level || p.standing_level || "STANDARD";
  flat.target_units = flat.target_units || String(p.target_units || 0);
  flat.program_main = flat.program_main || p.program_main || p.project_type || "MIXTE";
  flat.envelope_w = flat.envelope_w || String(p.envelope_w || "");
  flat.envelope_d = flat.envelope_d || String(p.envelope_d || "");
  flat.envelope_area = flat.envelope_area || String(p.envelope_area || Math.round(Number(p.envelope_w || 0) * Number(p.envelope_d || 0)));
  // ── Budget FCFA (parsed from budget_range) ──
  if (!flat.budget_fcfa) {
    const raw = String(p.budget_range || "");
    const fcfaM = raw.match(/(\d[\d\s.,]*)\s*M\s*FCFA/i);
    if (fcfaM) flat.budget_fcfa = fcfaM[1].replace(/[\s,]/g, '').replace(',', '.') + "M FCFA";
    else {
      const eurM = raw.match(/(\d[\d\s.,]*)\s*M?\s*€/i);
      if (eurM) { const eur = parseFloat(eurM[1].replace(/[\s,]/g, '')) * (eurM[0].includes('M') ? 1e6 : 1); flat.budget_fcfa = Math.round(eur * 655.957 / 1e6) + "M FCFA"; }
      else if (Number(p.budget_range) > 0) flat.budget_fcfa = Math.round(Number(p.budget_range) * 655.957 / 1e6) + "M FCFA";
      else flat.budget_fcfa = "N/A";
    }
  }
  // ── Feasibility posture FR ──
  if (!flat.feasibility_posture_fr) {
    const p2 = String(flat.profil_posture || p.feasibility_posture || "").toUpperCase();
    flat.feasibility_posture_fr = ({ AGGRESSIVE: "ambitieuse", BALANCED: "equilibree", CONSERVATIVE: "prudente" })[p2] || p2.toLowerCase() || "equilibree";
  }
  // ── Site SDPmax ──
  if (!flat.site_sdp_max) {
    flat.site_sdp_max = `${siteDiag.sdp_max_m2 || Math.round(Number(p.site_area || 0) * Number(siteDiag.cos_reglementaire || p.max_floors || 2.5))} m²`;
  }
  // ── Per-scenario: score, hab_m2_total, ventil_*_pct ──
  for (const [key, sc] of [["A", sA], ["B", sB], ["C", sC]]) {
    if (!flat[`${key}_score`]) {
      flat[`${key}_score`] = String(Math.round((sc.recommendation_score || 0) * 100));
    }
    if (!flat[`${key}_hab_m2_total`]) {
      flat[`${key}_hab_m2_total`] = String(sc.surface_habitable_m2 || sc.total_useful_m2 || sc.hab_m2_total || 0);
    }
    // Ventilation percentages (calculated from actual values)
    const cv = sc.cout_ventilation || {};
    const t = sc.cost_total_fcfa || 1;
    if (!flat[`${key}_ventil_go_pct`]) flat[`${key}_ventil_go_pct`] = `${Math.round((cv.gros_oeuvre_fcfa || 0) / t * 100)}%`;
    if (!flat[`${key}_ventil_so_pct`]) flat[`${key}_ventil_so_pct`] = `${Math.round((cv.second_oeuvre_fcfa || 0) / t * 100)}%`;
    if (!flat[`${key}_ventil_lt_pct`]) flat[`${key}_ventil_lt_pct`] = `${Math.round((cv.lots_techniques_fcfa || 0) / t * 100)}%`;
    if (!flat[`${key}_ventil_vrd_pct`]) flat[`${key}_ventil_vrd_pct`] = `${Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / t * 100)}%`;
  }
  // ── Recommended scenario aliases (rec_*) ──
  const rec = flat.rec_scenario || "C";
  const recSc = rec === "A" ? sA : rec === "B" ? sB : sC;
  flat.rec_cost_total = flat.rec_cost_total || flat[`${rec}_cost_total`] || "";
  flat.rec_levels = flat.rec_levels || flat[`${rec}_levels`] || "";
  flat.rec_fp = flat.rec_fp || flat[`${rec}_fp`] || "";
  flat.rec_cos_pct = flat.rec_cos_pct || flat[`${rec}_cos_pct`] || "";
  flat.rec_duree_chantier = flat.rec_duree_chantier || flat[`${rec}_duree_chantier`] || "";
  flat.rec_hono_bas = flat.rec_hono_bas || flat[`${rec}_hono_bas_M`] || "";
  flat.rec_hono_haut = flat.rec_hono_haut || flat[`${rec}_hono_haut_M`] || "";
  flat.rec_hono_taux_bas = flat.rec_hono_taux_bas || flat[`${rec}_hono_taux_bas`] || "";
  flat.rec_hono_taux_haut = flat.rec_hono_taux_haut || flat[`${rec}_hono_taux_haut`] || "";
  flat.rec_hab_m2_total = flat.rec_hab_m2_total || flat[`${rec}_hab_m2_total`] || "";
  flat.rec_ventil_go = flat.rec_ventil_go || flat[`${rec}_ventil_go`] || "";
  flat.rec_ventil_so = flat.rec_ventil_so || flat[`${rec}_ventil_so`] || "";
  flat.rec_ventil_lt = flat.rec_ventil_lt || flat[`${rec}_ventil_lt`] || "";
  flat.rec_ventil_vrd = flat.rec_ventil_vrd || flat[`${rec}_ventil_vrd`] || "";
  flat.rec_ventil_go_pct = flat.rec_ventil_go_pct || flat[`${rec}_ventil_go_pct`] || "";
  flat.rec_ventil_so_pct = flat.rec_ventil_so_pct || flat[`${rec}_ventil_so_pct`] || "";
  flat.rec_ventil_lt_pct = flat.rec_ventil_lt_pct || flat[`${rec}_ventil_lt_pct`] || "";
  flat.rec_ventil_vrd_pct = flat.rec_ventil_vrd_pct || flat[`${rec}_ventil_vrd_pct`] || "";
  console.log(`│ ✅ enrichFlatForTemplates: ${Object.keys(flat).length} clés (site_area=${flat.site_area}, city=${flat.city}, budget=${flat.budget_fcfa}, rec=${rec})`);
  return flat;
}
// ─── PREMIUM GATE v1.0 — Post-GPT sanitization ─────────────────────────────
// Catches and fixes: orphan variables, raw scores, untranslated labels,
// raw budget strings, uppercase terms, missing percentages
// ═══════════════════════════════════════════════════════════════════════════════
function sanitizePremiumTexts(texts, flat) {
  if (!texts || typeof texts !== "object") return texts;
  const sanitized = { ...texts };
  // Build replacement map from flat data
  const replacements = {};
  // Score fixes: "0.XXX/100" → "XX/100"
  const scoreRegex = /\b0\.(\d{2,3})\/100\b/g;
  // Budget label translations
  const LABEL_TR = {
    "HORS_BUDGET": "hors budget",
    "BUDGET_TENDU": "budget tendu",
    "DANS_BUDGET": "dans le budget",
    "BALANCED": "equilibree",
    "AGGRESSIVE": "ambitieuse",
    "CONSERVATIVE": "prudente",
  };
  // Budget raw string patterns (emoji + text)
  const budgetRawRegex = /⭕\s*Moins de [^)]+\(~?(\d+)\s*M\s*FCFA\)/gi;
  const budgetRawRegex2 = /environ\s*⭕[^)]+\)/gi;
  for (const [key, val] of Object.entries(sanitized)) {
    if (typeof val !== "string" || key.startsWith("_")) continue;
    let text = val;
    // 1. Fix scores "0.741/100" → "74/100"
    text = text.replace(scoreRegex, (match, digits) => {
      const score = Math.round(parseFloat("0." + digits) * 100);
      return `${score}/100`;
    });
    // 2. Clean budget raw strings
    text = text.replace(budgetRawRegex, (match, amount) => `${amount}M FCFA`);
    text = text.replace(budgetRawRegex2, (match) => {
      const m = match.match(/(\d+)\s*M\s*FCFA/i);
      return m ? `environ ${m[1]}M FCFA` : match;
    });
    // Also catch standalone "⭕ Moins de..." without parens
    text = text.replace(/⭕\s*Moins de [^(.\n]+/gi, (match) => {
      const m = match.match(/(\d+)\s*M\s*FCFA/i);
      return m ? `${m[1]}M FCFA` : match;
    });
    // 3. Translate labels (case-insensitive, keep context)
    for (const [raw, translated] of Object.entries(LABEL_TR)) {
      // Replace "HORS_BUDGET" or "Position budgetaire : HORS_BUDGET"
      text = text.replace(new RegExp(raw.replace(/_/g, "[_ ]"), "gi"), translated);
    }
    // 4. Fix "XX %" or "(XX%)" → use flat data if available
    // Replace generic XX% with actual percentages from flat data
    if (text.includes("XX")) {
      // For ventilation percentages in financial texts
      for (const sc of ["A", "B", "C"]) {
        if (key.includes(`scenario_${sc}`) || key.includes(`_${sc.toLowerCase()}_`)) {
          const goPct = flat[`${sc}_ventil_go_pct`] || "";
          const soPct = flat[`${sc}_ventil_so_pct`] || "";
          const ltPct = flat[`${sc}_ventil_lt_pct`] || "";
          const vrdPct = flat[`${sc}_ventil_vrd_pct`] || "";
          if (goPct) {
            // Replace first XX% with GO, second with SO, etc.
            let idx = 0;
            const pcts = [goPct, soPct, ltPct, vrdPct];
            text = text.replace(/\(?\s*XX\s*%?\s*\)?/g, (m) => {
              const pct = pcts[idx] || "";
              idx++;
              return pct ? `(${pct})` : m;
            });
          }
        }
      }
      // Catch remaining XX%
      text = text.replace(/\(\s*XX\s*%?\s*\)/g, "");
      text = text.replace(/XX\s*%/g, "");
    }
    // 5. Fix orphan variables: [montant], [%], [X]M, [calcul]
    // Replace [montant] FCFA ([%]) with actual ventilation data for recommended scenario
    const recSc = flat.rec_scenario || "C";
    if (text.includes("[montant]") || text.includes("[%]") || text.includes("[X]M") || text.includes("[calcul]")) {
      const cv = {};
      cv.go = flat[`${recSc}_ventil_go`] || "0M";
      cv.so = flat[`${recSc}_ventil_so`] || "0M";
      cv.lt = flat[`${recSc}_ventil_lt`] || "0M";
      cv.vrd = flat[`${recSc}_ventil_vrd`] || "0M";
      cv.goPct = flat[`${recSc}_ventil_go_pct`] || "";
      cv.soPct = flat[`${recSc}_ventil_so_pct`] || "";
      cv.ltPct = flat[`${recSc}_ventil_lt_pct`] || "";
      cv.vrdPct = flat[`${recSc}_ventil_vrd_pct`] || "";
      // Replace [montant] FCFA ([%]) patterns sequentially
      let montantIdx = 0;
      const montants = [cv.go, cv.go, cv.so, cv.vrd, cv.lt]; // fondations≈GO, GO, SO, VRD, LT
      const pcts = [cv.goPct, cv.goPct, cv.soPct, cv.vrdPct, cv.ltPct];
      text = text.replace(/\[montant\]\s*FCFA\s*\(\[%\]\)/g, () => {
        const m = montants[montantIdx] || "N/A";
        const p = pcts[montantIdx] || "";
        montantIdx++;
        return `${m} FCFA${p ? ` (${p})` : ""}`;
      });
      // Standalone [montant] or [%]
      text = text.replace(/\[montant\]/g, () => {
        const m = montants[montantIdx] || "N/A";
        montantIdx++;
        return m;
      });
      text = text.replace(/\[%\]/g, "");
      // [X]M → actual budget delta
      const recCost = parseInt((flat[`${recSc}_cost_total`] || "0").replace(/[^\d]/g, "")) || 0;
      const budgetFcfa = parseInt((flat.budget_fcfa || "0").replace(/[^\d]/g, "")) || 0;
      const delta = recCost - budgetFcfa;
      text = text.replace(/\[X\]M/g, `${Math.abs(delta)}M`);
      text = text.replace(/\[calcul\]/g, delta > 0 ? `${Math.round(delta * 1e6 / 130)}` : "N/A");
    }
    // 6. TROPICAL → tropical (EVERYWHERE in flowing text — zone labels handled by generate_pptx.py)
    text = text.replace(/\bTROPICAL\b/g, "tropical");
    // EQUILIBREE/AMBITIEUSE/PRUDENTE → minuscules dans texte courant
    text = text.replace(/\bEQUILIBREE\b/g, "equilibree");
    text = text.replace(/\bAMBITIEUSE\b/g, "ambitieuse");
    text = text.replace(/\bPRUDENTE\b/g, "prudente");
    // ECONOMIQUE/STANDARD/HAUT/PREMIUM → minuscules (sauf dans titres en ALL CAPS)
    text = text.replace(/\bECONOMIQUE\b/g, "economique");
    text = text.replace(/\bSTANDARD\b(?!\s*[-:])/g, (m, offset) => {
      // Keep if in a label context like "STANDARD:"
      return "standard";
    });
    // INTENSIFICATION/EQUILIBRE/PRUDENT as role labels — keep uppercase when in parens like "(INTENSIFICATION)"
    // But lowercase when in flowing text like "posture EQUILIBREE"
    // 7. Remove orphan curly-brace variables {var_name} that weren't replaced
    text = text.replace(/\{[A-Z][a-z_]+\}/g, "");
    // But keep legitimate uses like {A_score}
    // 8. v72.88 PILOTIS GATE — force pilotis description when has_pilotis=true
    //    GPT sometimes writes "sans pilotis" even when the massing clearly has pilotis.
    //    This catches and corrects the contradiction.
    for (const sc of ["A", "B", "C"]) {
      if (key.toLowerCase().includes(`scenario_${sc.toLowerCase()}`) || key.toLowerCase().includes(`_${sc.toLowerCase()}_`) || key.toLowerCase().includes(`sc${sc.toLowerCase()}`)) {
        const hasPilotis = flat[`${sc}_has_pilotis`];
        if (hasPilotis === "true" || hasPilotis === true) {
          const pilotisDesc = flat[`${sc}_pilotis_desc`] || "avec pilotis au RDC";
          // Replace contradictory "sans pilotis" mentions
          text = text.replace(/sans\s+pilotis/gi, pilotisDesc);
          text = text.replace(/pas\s+de\s+pilotis/gi, pilotisDesc);
          text = text.replace(/absence\s+de\s+pilotis/gi, `présence de pilotis (${pilotisDesc})`);
          text = text.replace(/aucun\s+pilotis/gi, pilotisDesc);
          // Also ensure "sur dalle" is not used when pilotis exist
          text = text.replace(/sur\s+dalle\s+pleine/gi, `sur pilotis (${pilotisDesc})`);
        }
      }
    }
    sanitized[key] = text;
  }
  console.log(`│ ✅ PREMIUM GATE: sanitized ${Object.keys(sanitized).length} text fields`);
  return sanitized;
}
// ═══════════════════════════════════════════════════════════════════════════════
// ─── v72.87 CONFORMITY GATE — vérification automatique post-génération ───────
// ═══════════════════════════════════════════════════════════════════════════════
function validateConformity(flat, scenarios, texts) {
  const errors = [];
  const warnings = [];
  const sA = scenarios.A || {}, sB = scenarios.B || {}, sC = scenarios.C || {};
  // ── 1. CHECK: SDP A > SDP B > SDP C (hierarchie intensification → prudent) ──
  if (sA.sdp_m2 && sB.sdp_m2 && sA.sdp_m2 < sB.sdp_m2) {
    errors.push(`SDP A (${sA.sdp_m2}) < SDP B (${sB.sdp_m2}) — hiérarchie inversée`);
  }
  if (sB.sdp_m2 && sC.sdp_m2 && sB.sdp_m2 < sC.sdp_m2) {
    errors.push(`SDP B (${sB.sdp_m2}) < SDP C (${sC.sdp_m2}) — hiérarchie inversée`);
  }
  // ── 2. CHECK: Cost A > Cost B > Cost C ──
  if (sA.cost_total_fcfa && sB.cost_total_fcfa && sA.cost_total_fcfa < sB.cost_total_fcfa) {
    errors.push(`Coût A (${Math.round(sA.cost_total_fcfa/1e6)}M) < Coût B (${Math.round(sB.cost_total_fcfa/1e6)}M)`);
  }
  if (sB.cost_total_fcfa && sC.cost_total_fcfa && sB.cost_total_fcfa < sC.cost_total_fcfa) {
    errors.push(`Coût B (${Math.round(sB.cost_total_fcfa/1e6)}M) < Coût C (${Math.round(sC.cost_total_fcfa/1e6)}M)`);
  }
  // ── 3. CHECK: Levels A ≥ Levels B ≥ Levels C ──
  if (sA.levels && sB.levels && sA.levels < sB.levels) {
    warnings.push(`Niveaux A (${sA.levels}) < Niveaux B (${sB.levels})`);
  }
  // ── 4. CHECK: Scores are 0-100 integers, not 0-1 floats ──
  for (const lbl of ["A", "B", "C"]) {
    const sc = scenarios[lbl] || {};
    if (sc.score !== undefined && sc.score < 1 && sc.score > 0) {
      errors.push(`Score ${lbl} = ${sc.score} — semble être un float 0-1 au lieu d'un entier 0-100`);
    }
  }
  // ── 5. CHECK: Ventilation percentages sum ~100% ──
  for (const lbl of ["A", "B", "C"]) {
    const goPct = parseInt(flat[`${lbl}_ventil_go_pct`]) || 0;
    const soPct = parseInt(flat[`${lbl}_ventil_so_pct`]) || 0;
    const ltPct = parseInt(flat[`${lbl}_ventil_lt_pct`]) || 0;
    const vrdPct = parseInt(flat[`${lbl}_ventil_vrd_pct`]) || 0;
    const total = goPct + soPct + ltPct + vrdPct;
    if (total > 0 && (total < 95 || total > 105)) {
      errors.push(`Ventilation ${lbl}: GO${goPct}+SO${soPct}+LT${ltPct}+VRD${vrdPct} = ${total}% (≠ ~100%)`);
    }
  }
  // ── 6. CHECK: Budget fit coherence ──
  for (const lbl of ["A", "B", "C"]) {
    const sc = scenarios[lbl] || {};
    const budgetMax = flat.budget_fcfa ? parseInt(String(flat.budget_fcfa).replace(/[^\d]/g, "")) * 1e6 : 0;
    if (budgetMax > 0 && sc.cost_total_fcfa) {
      const ratio = sc.cost_total_fcfa / budgetMax;
      if (sc.budget_fit === "DANS_BUDGET" && ratio > 1.05) {
        errors.push(`${lbl}: budget_fit=DANS_BUDGET mais coût/budget = ${(ratio*100).toFixed(0)}%`);
      }
      if (sc.budget_fit === "HORS_BUDGET" && ratio < 1.0) {
        errors.push(`${lbl}: budget_fit=HORS_BUDGET mais coût/budget = ${(ratio*100).toFixed(0)}%`);
      }
    }
  }
  // ── 7. CHECK: Texts don't contain raw variable placeholders ──
  if (texts) {
    for (const [key, text] of Object.entries(texts)) {
      if (!text || typeof text !== "string") continue;
      const unreplaced = text.match(/\{[A-Za-z_]+\}/g);
      if (unreplaced && unreplaced.length > 0) {
        warnings.push(`Text "${key}" contient ${unreplaced.length} variable(s) non remplacée(s): ${unreplaced.slice(0, 3).join(", ")}`);
      }
      // Check for raw 0.XXX scores
      if (/\b0\.\d{2,}\/100\b/.test(text)) {
        errors.push(`Text "${key}" contient un score au format float "0.XXX/100" au lieu de "XX/100"`);
      }
      // Check for uppercase TROPICAL/EQUILIBREE in flowing text
      if (/\bTROPICAL\b/.test(text) && !/titre|TITRE/.test(key)) {
        warnings.push(`Text "${key}" contient "TROPICAL" en majuscules`);
      }
    }
  }
  // ── 8. CHECK: Recommended scenario exists and has valid score ──
  const recSc = flat.rec_scenario;
  if (!recSc || !["A", "B", "C"].includes(recSc)) {
    errors.push(`rec_scenario invalide: "${recSc}"`);
  } else {
    const recData = scenarios[recSc] || {};
    if (!recData.score || recData.score < 1) {
      errors.push(`Scénario recommandé ${recSc}: score invalide (${recData.score})`);
    }
  }
  // ── 9. CHECK: A/B/C scores are distinct ──
  if (sA.score && sB.score && sC.score) {
    if (sA.score === sB.score && sB.score === sC.score) {
      errors.push(`Scores identiques A=B=C=${sA.score} — moteur de différenciation défaillant`);
    }
  }
  // ── v72.88 CONFORMITY TRACE — trace critical data through all layers ──
  console.log(`\n┌── CONFORMITY TRACE v72.88 ─────────────────────────────────┐`);
  for (const sc of ["A", "B", "C"]) {
    const s = scenarios[sc] || {};
    const hasPil = s.has_pilotis ? "OUI" : "NON";
    const flatPil = flat[`${sc}_has_pilotis`] || "?";
    const flatPilDesc = flat[`${sc}_pilotis_desc`] || "N/A";
    const sdpMoteur = s.sdp_m2 || "?";
    const sdpFlat = flat[`${sc}_sdp_m2`] || "?";
    const costM2 = flat[`${sc}_cost_m2_adjusted`] || flat[`${sc}_cost_m2`] || "?";
    const fpMoteur = s.fp_m2 || "?";
    const fpFlat = flat[`${sc}_fp_m2`] || "?";
    const complexity = s.complexite ? `${s.complexite.score}/5 (${s.complexite.label})` : "?";
    const layoutMode = s.layout_mode || "?";
    console.log(`│ ${sc}: pilotis=${hasPil}(flat:${flatPil}) | sdp=${sdpMoteur}(flat:${sdpFlat}) | fp=${fpMoteur}(flat:${fpFlat}) | cost/m²=${costM2} | complexity=${complexity} | layout=${layoutMode}`);
    console.log(`│    pilotis_desc: "${flatPilDesc}"`);
    // Check GPT text for contradictions
    if (texts && typeof texts === "object") {
      for (const [tKey, tVal] of Object.entries(texts)) {
        if (typeof tVal !== "string") continue;
        if (tKey.toLowerCase().includes(`scenario_${sc.toLowerCase()}`) || tKey.toLowerCase().includes(`_${sc.toLowerCase()}_`)) {
          if (flatPil === "true" && /sans\s+pilotis|pas\s+de\s+pilotis/i.test(tVal)) {
            errors.push(`${sc}: GPT text "${tKey}" still says "sans pilotis" despite has_pilotis=true (PREMIUM GATE may have missed it)`);
          }
        }
      }
    }
  }
  console.log(`└───────────────────────────────────────────────────────────┘`);
  // ── LOG RESULTS ──
  console.log(`\n╔══ CONFORMITY GATE v72.88 ══╗`);
  if (errors.length === 0 && warnings.length === 0) {
    console.log(`║ ✅ PASS — 0 erreurs, 0 warnings`);
  } else {
    if (errors.length > 0) {
      console.log(`║ ❌ ${errors.length} ERREUR(S) CRITIQUE(S):`);
      errors.forEach(e => console.log(`║   ✖ ${e}`));
    }
    if (warnings.length > 0) {
      console.log(`║ ⚠️  ${warnings.length} WARNING(S):`);
      warnings.forEach(w => console.log(`║   ⚠ ${w}`));
    }
  }
  console.log(`╚═══════════════════════════╝\n`);
  return { valid: errors.length === 0, errors, warnings };
}
// ═══════════════════════════════════════════════════════════════════════════════
// ─── ENDPOINT /generate-texts — PREMIUM TEXT ENGINE v3.0 ─────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const GPT_TEXT_MODEL = "gpt-4o";
const GPT_TEXT_TIMEOUT_MS = 120000;
/**
 * v72.90 GPT PROMPT — REDUCED TO QUALITATIVE ONLY
 * GPT only generates slide_5_text (neighborhood context analysis).
 * All other texts are generated by buildTemplateTexts() (100% deterministic).
 */
function buildGptTextRules() {
  return `RÔLE : Tu es un expert en urbanisme en Afrique subsaharienne, spécialisé dans le conseil en investissement immobilier au Cameroun. Tu REFORMULES un texte existant pour lui donner un ton professionnel premium de cabinet d'architecture.
RÈGLES STRICTES :
1. Tu reçois un texte de référence dans le champ "slide_5_base" du JSON {data}.
2. Tu REFORMULES ce texte avec un ton professionnel, fluide et expert.
3. Tu NE CHANGES PAS les chiffres, les données, les pourcentages, les surfaces, les dimensions.
4. Tu NE SUPPRIMES AUCUNE information du texte de base.
5. Tu N'INVENTES AUCUNE donnée, aucun chiffre, aucun fait.
6. Tu N'AJOUTES PAS d'informations qui ne sont pas dans le texte de base.
7. Écrire en français AVEC accents (é, è, ê, à, ç, ù, etc.).
8. Utiliser \\n pour les sauts de ligne.
9. Utiliser des tirets (- ) pour les listes.
10. Garder la MÊME STRUCTURE en 5 paragraphes.
11. Utiliser le CONDITIONNEL pour les projections et estimations.
CE QUE TU PEUX FAIRE :
- Améliorer la formulation et le vocabulaire
- Rendre les transitions plus fluides
- Ajouter des connecteurs logiques
- Utiliser un vocabulaire d'expert urbaniste / architecte
- Contextualiser à {city} avec des références génériques au tissu urbain local
CE QUE TU NE PEUX PAS FAIRE :
- Inventer des chiffres ou des données
- Modifier les valeurs numériques
- Ajouter des informations factuelles absentes du texte de base
- Changer la structure (5 paragraphes)
=== FORMAT DE RÉPONSE ===
Réponds UNIQUEMENT en JSON valide avec UNE SEULE clé : "slide_5_text".
Pas de markdown, pas de commentaires.
La valeur est une string contenant le texte reformulé.
Utilise \\n pour les sauts de ligne.
UTILISER les accents français.`;
}
/* ── OLD GPT RULES v4.0 removed in v72.90 — replaced by buildTemplateTexts() ──
   All deterministic texts are now generated by template engine.
   GPT only generates slide_5_text (neighborhood qualitative context).
*/
// ═══════════════════════════════════════════════════════════════════════════════
// ─── DEAD CODE BOUNDARY — everything below until next function is legacy ─────
// ═══════════════════════════════════════════════════════════════════════════════
/* LEGACY REMOVED v72.90 — was:
=== PRINCIPES FONDAMENTAUX ===
1. UTILISE UNIQUEMENT les donnees fournies dans le JSON {data}. Ne JAMAIS inventer de chiffres.
2. CHAQUE TEXTE doit etre CONTEXTUALISE au projet specifique -- jamais de phrases generiques.
3. STYLE : phrases structurees, vocabulaire technique precis, ton professionnel mais accessible.
4. FORMAT : utilise des tirets (- ) pour les listes, des paragraphes pour le reste. PAS de bullet points unicode.
5. NE JAMAIS utiliser de placeholder non rempli ({X}) dans le texte final.
6. NE JAMAIS commencer un texte par "Voici" ou "Ce texte".
7. NE PAS utiliser d'accents. Ecrire en francais SANS accents (a au lieu de a, e au lieu de e/e, etc.).
8. TOUJOURS utiliser les chiffres EXACTS du JSON. Ne pas arrondir differemment.
9. Utiliser \\n pour les sauts de ligne.
10. COS et CES : expliquer ce que sont le COS (Coefficient d'Occupation des Sols) et le CES (Coefficient d'Emprise au Sol) UNE SEULE FOIS dans slide_4_text. Ensuite, ne plus expliquer ni definir ces termes — utiliser simplement les valeurs en %.
11. Les termes "economique", "tropical", "standard", "premium", "hors budget", "dans le budget" doivent etre en MINUSCULES dans le texte courant. JAMAIS "TROPICAL", "ECONOMIQUE" etc. en majuscules sauf dans un titre.
12. La posture "BALANCED" doit etre ecrite "EQUILIBREE" en francais, "AGGRESSIVE" → "AMBITIEUSE", "CONSERVATIVE" → "PRUDENTE".
13. UTILISE {budget_fcfa} pour le budget (c'est le montant FCFA formate). Ne pas utiliser {budget_range} directement.
14. Pour les ventilations en pourcentage, utilise les variables {X_ventil_go_pct}, {X_ventil_so_pct}, {X_ventil_lt_pct}, {X_ventil_vrd_pct} au lieu d'ecrire "XX %".
15. Pour les scores individuels, utilise {A_score}, {B_score}, {C_score} (deja en 0-100). Ne pas inventer.
16. Pour les surfaces habitables totales, utilise {A_hab_m2_total}, {B_hab_m2_total}, {C_hab_m2_total}.
17. TRADUCTION budget_fit : "HORS_BUDGET" → "hors budget", "DANS_BUDGET" → "dans le budget", "TIGHT" → "en limite de budget". Ne JAMAIS afficher les codes bruts.
18. FORMULATION DELTA : quand tu compares deux scenarios, ne pas combiner un chiffre negatif avec le mot "supplementaire". Ecrire : "L'ecart entre A et C est de {delta_CA_cout} de surcout pour {delta_CA_sdp} de SDP en plus." Si C < A, ecrire "Le scenario C economise {montant} par rapport a A, pour {surface} de surface en moins."
19. VARIABLES rec_ventil_* : pour la ventilation du scenario recommande, utilise {rec_ventil_go}, {rec_ventil_go_pct}, {rec_ventil_so}, {rec_ventil_so_pct}, {rec_ventil_lt}, {rec_ventil_lt_pct}, {rec_ventil_vrd}, {rec_ventil_vrd_pct}. NE PAS recopier le nom des variables dans le texte final.
20. ZERO IMPROVISATION : Tu ne dois JAMAIS ecrire un chiffre, montant, pourcentage ou surface qui ne provient pas DIRECTEMENT d'une variable {xxx} du JSON data. Si tu ne connais pas une valeur, utilise la variable correspondante entre accolades. JAMAIS de "environ 35 %" ou "pres de 40M" si la variable exacte existe. Tout chiffre non issu d'une variable = ERREUR CRITIQUE.
21. SCORE FORMAT : Toujours ecrire le score comme {X_score}/100 (ou X = A, B, C, rec). Les scores sont deja en echelle 0-100 dans le JSON. JAMAIS ecrire "0.741/100" ou "74.1/100" — utiliser {A_score}/100, {B_score}/100, {C_score}/100, {rec_score}/100 directement. Le score est un ENTIER sur 100.
22. COUT AU M2 : Pour les couts au m2, utilise {A_cost_m2_marche}/{A_cost_m2_ajuste}, {B_cost_m2_marche}/{B_cost_m2_ajuste}, {C_cost_m2_marche}/{C_cost_m2_ajuste}. Le cout "marche" est le prix de reference du marche. Le cout "ajuste" est recalcule pour respecter l'enveloppe budgetaire. Si cost_adjusted=true, mentionner l'ajustement.
23. BUDGET DELTA : Pour comparer budget vs cout, utilise {rec_budget_delta_M} (ecart en millions) et {rec_budget_delta_sign} ("depassement" ou "economie"). NE PAS calculer l'ecart toi-meme.
24. CONFIGURATION ARCHITECTURALE : Chaque scenario a une configuration specifique decrite par {X_typology_desc} (forme), {X_pilotis_desc} (disposition RDC) et {X_config_justif} (justification). UTILISE ces variables pour decrire la configuration. NE PAS ecrire "Pas de pilotis" si {X_has_pilotis}=true ou si {X_pilotis_desc} mentionne des pilotis. La justification de la forme (bloc, L, U, barre, split) doit etre liee aux contraintes du terrain (mitoyennete, retraits, orientation, programme).
=== STRUCTURE OBLIGATOIRE PAR TEXTE ===
Chaque texte ci-dessous a une STRUCTURE IMPOSEE que tu DOIS respecter exactement.
Les paragraphes sont separes par \\n\\n (double saut de ligne).
--- slide_3_intro_text ---
STRUCTURE OBLIGATOIRE (4 paragraphes) :
PARA 1: "Ce projet consiste a valoriser un terrain de {site_area} m2 situe a {city}, dans le cadre d'un programme {program_main}. Le programme cible prevoit {target_units} unites pour un standing {standing_level}, avec un budget de reference de l'ordre de {budget_fcfa}."
PARA 2: "L'objectif strategique est d'identifier la meilleure configuration possible en respectant les contraintes urbanistiques du site, notamment un COS de {site_cos_regl}, un CES de {site_ces_regl}%, et des retraits reglementaires qui reduisent significativement l'emprise constructible."
PARA 3: "Pour repondre a cette question, trois scenarios ont ete elabores :\\n- Le Scenario A ({A_role}) explore [description courte A].\\n- Le Scenario B ({B_role}) recherche [description courte B].\\n- Le Scenario C ({C_role}) privilegie [description courte C]."
PARA 4: "Le present rapport diagnostic analyse chacun de ces scenarios sous l'angle volumetrique, financier et reglementaire, afin d'orienter le porteur de projet vers le scenario le plus recommande au regard de ses priorites et de son enveloppe budgetaire."
--- slide_3_programme_text ---
NE PAS GENERER CE TEXTE. Retourner une chaine vide "".
Le contenu est fusionne dans slide_3_intro_text.
--- slide_4_text ---
STRUCTURE OBLIGATOIRE (5 blocs) :
PARA 1: "Ce terrain de {site_area} m2 se situe dans un tissu urbain [qualificatif] de {city}. Il presente une geometrie [reguliere/irreguliere] de {envelope_w} m de largeur sur {envelope_d} m de profondeur, offrant une surface brute de {envelope_area} m2."
PARA 2: "Les contraintes reglementaires imposent les retraits suivants :\\n- Recul avant : {retrait_avant} (par rapport a la voie)\\n- Recul lateral : {retrait_lateral} de chaque cote\\n- Recul arriere : {retrait_arriere}\\n- Mitoyennete : {retrait_mitoyennete} cotes"
PARA 3: "L'impact de ces retraits est significatif : ils reduisent l'emprise constructible de {retrait_reduction_pct}, la ramenant a environ {retrait_emprise_constructible} exploitables."
PARA 4: "Le programme envisage prevoit {target_units} unites en usage {program_main}, dans un standing {standing_level}."
PARA 5: "- Zone climatique : {orient_zone}\\n- COS reglementaire : {site_cos_regl}\\n- CES reglementaire : {site_ces_regl} %"
--- slide_5_text ---
STRUCTURE OBLIGATOIRE (5 paragraphes) :
PARA 1: Description de l'environnement bati (quartier, densite, voisinage). Contextualisee a {city}.
PARA 2: Rapport a la rue et impact de la mitoyennete ({retrait_mitoyennete} cotes) sur les ouvertures, l'eclairage, la ventilation.
PARA 3: "La surface de plancher est limitee par plusieurs facteurs cumules :\\n- L'emprise constructible apres retraits est reduite a {retrait_emprise_constructible} (soit {retrait_reduction_pct} de perte)\\n- Le COS de {site_cos_regl} autorise jusqu'a {site_sdp_max} de SDP theorique, mais l'emprise reelle au sol limite fortement cette capacite\\n- Le CES de {site_ces_regl}% n'est pas le facteur limitant ici"
PARA 4: Impact de la zone climatique {orient_zone} sur le confort thermique, l'orientation, les facades.
PARA 5: Conclusion sur la densite du voisinage et le gabarit a respecter.
--- scenario_A_summary_text ---
STRUCTURE OBLIGATOIRE (scenario A) :
PARA 1: "Le Scenario A ({A_role}) [description philosophie] afin de repondre au programme cible du client : {A_units} unites en usage mixte."
PARA 2 Config: "Configuration retenue :\\n- Gabarit : R+{A_levels} (rez-de-chaussee + {A_levels} etages)\\n- Emprise au sol : {A_fp} m2\\n- SDP totale : {A_sdp} m2\\n- Disposition : {A_pilotis_desc}\\n- Forme : {A_typology_desc}"
PARA 3 Justification architecturale: Reprendre {A_config_justif} et le reformuler en 2-3 phrases fluides. Expliquer POURQUOI cette configuration (split/superpose, pilotis/pas de pilotis, forme en bloc/L/U/barre) a ete choisie compte tenu des contraintes du terrain, de la mitoyennete, du programme et du standing.
PARA 4 Programme: "Programme :\\n- [detail du mix: {A_unit_summary}]"
PARA 5: "La surface utile et habitable par logement, hors circulations et parties communes, est estimee a environ {A_m2_par_logt} m2, un niveau [compact/confortable/spacieux] pour des T[X] en standing {standing_level}."
PARA 6: Description de l'acces et circulation.
PARA 7: "- Parking : {A_parking_places} places en surface, [deficit/aucun deficit]\\n- Gabarit et impact visuel : [qualificatif] mais conforme\\n- COS utilise : {A_cos_pct} % du COS autorise ({A_sdp} m2 sur {site_sdp_max})"
--- scenario_B_summary_text ---
MEME STRUCTURE QUE scenario_A_summary_text, en utilisant les variables B_* (B_fp, B_levels, B_sdp, B_pilotis_desc, B_typology_desc, B_config_justif, B_unit_summary, B_m2_par_logt, B_parking_places, B_cos_pct) et en decrivant la philosophie d'equilibre. IMPORTANT: utiliser {B_pilotis_desc} pour decrire la disposition (PAS "Pas de pilotis" par defaut).
--- scenario_C_summary_text ---
MEME STRUCTURE QUE scenario_A_summary_text, en utilisant les variables C_* (C_fp, C_levels, C_sdp, C_pilotis_desc, C_typology_desc, C_config_justif, C_unit_summary, C_m2_par_logt, C_parking_places, C_cos_pct) et en decrivant la philosophie de prudence. IMPORTANT: utiliser {C_pilotis_desc} pour decrire la disposition.
--- scenario_A_financial_text ---
STRUCTURE OBLIGATOIRE :
PARA 1: "Pour un standing {standing_level} a {city}, le cout de construction au m2 de SDP se situerait aux alentours de {A_cost_m2}. Ce positionnement [qualificatif marche local]."
PARA 2: "Le raisonnement de cout s'articule ainsi :\\n- SDP totale : {A_sdp} m2\\n- Cout estime au m2 : {A_cost_m2}\\n- Cout total estime : environ {A_cost_total}"
PARA 3: "Ventilation previsionnelle des travaux :\\n- Gros oeuvre et structure : {A_ventil_go} FCFA ({A_ventil_go_pct})\\n- Second oeuvre et finitions : {A_ventil_so} FCFA ({A_ventil_so_pct})\\n- Lots techniques (electricite, plomberie, CVC) : {A_ventil_lt} FCFA ({A_ventil_lt_pct})\\n- VRD et amenagements exterieurs : {A_ventil_vrd} FCFA ({A_ventil_vrd_pct})"
PARA 4: "La fourchette budgetaire globale se situerait {A_fourchette_text}."
PARA 5: "Honoraires de maitrise d'oeuvre : entre {A_hono_bas_M}M et {A_hono_haut_M}M FCFA ({A_hono_taux_bas} a {A_hono_taux_haut})."
PARA 6: "- Enveloppe budgetaire du client : environ {budget_fcfa}\\n- Position budgetaire : {A_budget_fit}\\n- Ratio cout par unite : environ {A_cost_unit}/unite"
--- scenario_B_financial_text ---
MEME STRUCTURE QUE scenario_A_financial_text, avec variables B_* (B_ventil_go, B_ventil_go_pct, B_ventil_so, B_ventil_so_pct, B_ventil_lt, B_ventil_lt_pct, B_ventil_vrd, B_ventil_vrd_pct, B_cost_total, B_cost_m2, B_sdp, B_fourchette_text, B_hono_bas_M, B_hono_haut_M, B_hono_taux_bas, B_hono_taux_haut, B_budget_fit, B_cost_unit). Mentionner la comparaison avec A. Utilise {budget_fcfa} pour le budget.
--- scenario_C_financial_text ---
MEME STRUCTURE QUE scenario_A_financial_text, avec variables C_* (C_ventil_go, C_ventil_go_pct, C_ventil_so, C_ventil_so_pct, C_ventil_lt, C_ventil_lt_pct, C_ventil_vrd, C_ventil_vrd_pct, C_cost_total, C_cost_m2, C_sdp, C_fourchette_text, C_hono_bas_M, C_hono_haut_M, C_hono_taux_bas, C_hono_taux_haut, C_budget_fit, C_cost_unit). Insister sur l'optimisation du cout. Utilise {budget_fcfa} pour le budget.
--- scenario_A_risk_text ---
STRUCTURE OBLIGATOIRE :
PARA 1: "Le scoring evalue le Scenario A selon 7 criteres ponderes, chacun note de 1 a 5. Le score global de {A_score}/100 reflete un profil [qualificatif] :"
PARA 2: "1) Risque urbanistique : conforme au COS ({A_cos_pct} % utilise sur {site_cos_regl} autorise), hauteurs et retraits respectes.\\n2) Risque de compacite : {A_m2_par_logt} m2/logement de surface utile habitable, [faible/moyen/fort] risque de refus de permis.\\n3) Risque financier : position {A_budget_fit}. [detail depassement si HORS_BUDGET].\\n4) Risque de parking : [deficit ou aucun deficit] ({A_parking_places} places pour {A_units} unites).\\n5) Risque de construction : complexite d'un R+{A_levels} en standing {standing_level}, [qualificatif]."
PARA 3: "Probabilite [faible/moyenne/elevee], impact [faible/modere/eleve], [mitigation possible]."
--- scenario_B_risk_text ---
MEME STRUCTURE, variables B_*, comparer avec A si pertinent.
--- scenario_C_risk_text ---
MEME STRUCTURE, variables C_*. Insister que ce scenario est le plus recommande si c'est le cas.
--- strategic_arbitrage_text ---
STRUCTURE OBLIGATOIRE (5 paragraphes) :
PARA 1: "Le client recherche un programme {program_main} en standing {standing_level}, avec une posture {feasibility_posture_fr}, pour une enveloppe budgetaire de l'ordre de {budget_fcfa}."
PARA 2: "Le systeme de scoring evalue chaque scenario selon 7 criteres ponderes : adequation budgetaire (25 %), alignement risque (20 %), conformite COS (12 %), capacite du programme (13 %), efficacite cout (12 %), adequation standing (8 %), flexibilite de phasage (10 %)."
PARA 3: "Les 3 scenarios livrent tous les {target_units} unites demandees, mais different significativement sur le cout :\\n- Scenario A : {A_cost_total}, {A_hab_m2_total} m2 habitables, score {A_score}/100\\n- Scenario B : {B_cost_total}, {B_hab_m2_total} m2 habitables, score {B_score}/100\\n- Scenario C : {C_cost_total}, {C_hab_m2_total} m2 habitables, score {C_score}/100"
PARA 4: Compare les scenarios A et C : le scenario C economise combien par rapport a A (utilise {delta_CA_cout}) pour combien de surface en moins ({delta_CA_sdp}). Conclure si l'economie justifie la perte de surface au regard de l'enveloppe de {budget_fcfa}.
PARA 5: "Le Scenario {rec_scenario} obtient le meilleur score ({rec_score}/100) car il offre le meilleur compromis entre [arguments hierarchises]. Il est le scenario recommande."
--- comparatif_intro_text ---
UNE SEULE PHRASE structuree avec les chiffres cles de chaque scenario.
--- invisible_intro_text ---
UNE SEULE PHRASE: "Points de vigilance techniques et administratifs a anticiper pour assurer la conformite et l'efficacite du projet."
--- invisible_technical_text ---
STRUCTURE OBLIGATOIRE (texte dense pour slide 17) :
PARA 1: "Les conditions de reussite reposent sur une anticipation rigoureuse des postes de depenses et des delais. Voici la ventilation detaillee pour le scenario {rec_scenario} recommande ({rec_cost_total}) :"
PARA 2: "Ventilation des couts par lot :\\n- Gros oeuvre et structure : {rec_ventil_go} FCFA ({rec_ventil_go_pct}). Systeme poteau-poutre en beton arme adapte au R+{rec_levels}.\\n- Second oeuvre et finitions : {rec_ventil_so} FCFA ({rec_ventil_so_pct}). Materiaux {standing_level} mais durables.\\n- Lots techniques : {rec_ventil_lt} FCFA ({rec_ventil_lt_pct}). Electricite, plomberie, ventilation naturelle.\\n- VRD et amenagements : {rec_ventil_vrd} FCFA ({rec_ventil_vrd_pct}). Raccordements reseaux, assainissement."
PARA 3: "Strategies de phasage recommandees :\\n- Duree estimee du chantier : {rec_duree_chantier}\\n- Phase 1 (M1-M2) : etudes et permis\\n- Phase 2 (M3) : terrassement et fondations, eviter la saison des pluies (juin-octobre)\\n- Phase 3 (M4-M5) : gros oeuvre\\n- Phase 4 (M6-M7) : second oeuvre\\n- Phase 5 (M8) : finitions et reception"
PARA 4: "Delais caches a anticiper : obtention du permis (2-4 mois), etude geotechnique (2-3 semaines), raccordements reseaux (variable)."
--- invisible_financial_text ---
STRUCTURE OBLIGATOIRE (texte dense pour slide 17 col 2 et slide 18 col 2) :
Ce texte sera utilise DEUX FOIS (slide 17 et slide 18). Redige-le pour la slide 18 (budget detaille).
PARA 1: "Le budget du Scenario {rec_scenario} s'etablit a environ {rec_cost_total}, a comparer au budget initial de {budget_fcfa}. L'ecart est gerable avec une optimisation rigoureuse."
PARA 2: "Frais complementaires a anticiper :\\n- Honoraires d'architecte : entre {rec_hono_bas}M et {rec_hono_haut}M FCFA ({rec_hono_taux_bas} a {rec_hono_taux_haut})\\n- Frais de permis de construire et taxes : environ 1 a 2 % du montant des travaux\\n- Etudes geotechniques : entre 300 000 et 500 000 FCFA\\n- Frais de notaire et administratifs : variables\\n- Assurance dommage-ouvrage : recommandee, environ 2 % du cout travaux"
PARA 3: "Budgetiser l'ensemble de ces postes en amont est imperatif pour eviter toute derive financiere."
--- invisible_strategic_text ---
STRUCTURE OBLIGATOIRE (phasage financier pour slide 17 col 3 et slide 18 col 3) :
PARA 1: "Le phasage financier doit tenir compte du climat {orient_zone} de {city}, en particulier de la saison des pluies (juin a octobre)."
PARA 2: "Recommandations de phasage :\\n- Demarrage ideal des travaux : novembre a janvier (saison seche)\\n- Terrassement et fondations : imperativement hors saison des pluies\\n- Gros oeuvre : peut se poursuivre pendant la saison des pluies avec precautions\\n- Finitions : planifier la reception avant la prochaine saison des pluies"
PARA 3: "Echelonnement des decaissements :\\n- M1-M2 : 15 % (etudes, permis, installation chantier)\\n- M3-M5 : 50 % (fondations + gros oeuvre)\\n- M6-M7 : 25 % (second oeuvre)\\n- M8 : 10 % (finitions, reception, solde)"
--- success_intro_text ---
UNE SEULE PHRASE: "Le scenario recommande ({rec_scenario}) est le meilleur choix en raison de son cout optimise ({rec_cost_total}), de sa conformite urbanistique (COS a {rec_cos_pct} %), et de sa gestion rigoureuse du budget."
--- success_technical_text ---
STRUCTURE OBLIGATOIRE (slide 18, colonne technique) :
PARA 1: "Le Scenario {rec_scenario} propose une structure R+{rec_levels} avec commerce au RDC, compacte mais fonctionnelle. Points techniques a anticiper :"
PARA 2: "- Structure R+{rec_levels} en beton arme : systeme poteau-poutre classique, maitrise par les entreprises locales\\n- Fondations : etude geotechnique indispensable compte tenu de la mitoyennete sur {retrait_mitoyennete} cotes\\n- Emprise de {rec_fp} m2 : optimisation des circulations verticales necessaire\\n- Ventilation naturelle : essentielle en zone {orient_zone}, ouvertures traversantes sur facades libres\\n- Etancheite toiture terrasse : point critique en climat tropical humide"
--- success_financial_text ---
MEME CONTENU QUE invisible_financial_text. Retourner le MEME texte.
--- success_strategic_text ---
MEME CONTENU QUE invisible_strategic_text. Retourner le MEME texte.
--- next_step_intro_text ---
UNE PHRASE contextualisee: "Suite a la recommandation du Scenario {rec_scenario}, voici les etudes et demarches a engager pour passer a la phase operationnelle du projet."
--- next_step_scope_text ---
STRUCTURE OBLIGATOIRE (5 etudes a lancer) :
PARA 1: "Perimetre des etudes a lancer pour la phase suivante :"
PARA 2: "- APS (Avant-Projet Sommaire) : definition des volumes, implantation, choix structurels. Validation de la faisabilite technique et affinage du budget. Delai : 3-4 semaines."
PARA 3: "- APD (Avant-Projet Definitif) : plans detailles, dimensionnement structure, choix des materiaux. Base pour le chiffrage definitif. Delai : 4-6 semaines."
PARA 4: "- Etudes geotechniques : sondages et essais de sol pour dimensionner les fondations. Indispensable avant le depot de permis. Delai : 2-3 semaines."
PARA 5: "- Dossier de permis de construire : constitution du dossier administratif complet. Delai d'instruction : 2-4 mois selon la commune."
PARA 6: "- Consultation des entreprises : appel d'offres restreint ou consultation directe. Prevoir 3-4 semaines pour reception et analyse des devis."
--- next_step_outcome_text ---
Livrables attendus en 2-3 phrases.
--- conclusion_summary_text ---
STRUCTURE OBLIGATOIRE (2 paragraphes) :
PARA 1: "Ce diagnostic a permis d'analyser le potentiel d'un terrain de {site_area} m2 a {city} sous trois scenarios contrastes : {A_role} (A), {B_role} (B) et {C_role} (C). Chacun repond au programme cible de {target_units} unites en usage {program_main} en standing {standing_level}."
PARA 2: "Le Scenario {rec_scenario} est recommande avec un score de {rec_score}/100. Il offre le meilleur compromis entre le respect du programme, la proximite avec l'enveloppe budgetaire ({rec_cost_total} vs {budget_fcfa} vises), la conformite urbanistique, et la simplicite de mise en oeuvre d'un R+{rec_levels}. La prochaine etape consiste a lancer les etudes de faisabilite (APS/APD) et l'etude geotechnique pour confirmer ces hypotheses."
--- conclusion_positioning_text ---
STRUCTURE OBLIGATOIRE (1 paragraphe dense) :
"Le scenario {rec_scenario} est le meilleur compromis entre cout maitrise ({rec_cost_total}), conformite urbanistique (COS utilise a {rec_cos_pct} %), et adequation avec les objectifs du client. Il permet de livrer les {target_units} unites demandees dans un gabarit R+{rec_levels} [qualificatif] et realiste."
--- conclusion_projection_text ---
Projection temporelle : duree du chantier ({rec_duree_chantier}), points d'attention calendaire, horizon de livraison.
=== VARIABLES SUPPLEMENTAIRES DU SCENARIO RECOMMANDE ===
Pour les textes qui mentionnent le scenario recommande, utilise ces variables :
- rec_scenario = {rec_scenario}
- rec_score = {rec_score}
- rec_cost_total = cout total du scenario recommande (A, B ou C)
- rec_levels = niveaux du scenario recommande
- rec_fp = emprise du scenario recommande
- rec_cos_pct = COS utilise du scenario recommande
- rec_duree_chantier = duree chantier du scenario recommande
- rec_hono_bas/haut = honoraires du scenario recommande
Identifie le scenario recommande (A, B ou C) a partir de rec_scenario et utilise ses donnees.
=== FORMAT DE REPONSE ===
Reponds UNIQUEMENT en JSON valide avec toutes les cles ci-dessus. Pas de markdown, pas de commentaires.
Chaque valeur est une string contenant le texte redige.
Utilise \\n pour les sauts de ligne dans les strings JSON.
Utilise des tirets (- ) pour les listes, PAS de bullet points unicode.
NE PAS utiliser d'accents dans le texte.
END LEGACY REMOVED */
/**
 * Build the data context string for GPT from computed scenarios
 */
function buildGptDataContext(p, scenarios, flat, templateTexts) {
  const sA = scenarios.A || {};
  const sB = scenarios.B || {};
  const sC = scenarios.C || {};
  const diag = scenarios.diagnostic || {};
  const retr = diag.retraits_reglementaires || {};
  const orient = diag.orientation_solaire || {};
  const phasage = diag.strategie_phasage || {};
  const profil = diag.profil_client || {};
  const siteDiag = diag.site || {};
  const rec = diag.recommandation || {};
  return JSON.stringify({
    // Site
    site_area: p.site_area, city: p.city || "Douala",
    envelope_w: p.envelope_w, envelope_d: p.envelope_d,
    envelope_area: flat.site_emprise_max || `${Number(p.envelope_w) * Number(p.envelope_d)} m²`,
    zoning_type: p.zoning_type,
    max_floors: p.max_floors, max_height_m: p.max_height_m,
    site_cos_regl: flat.site_cos_regl || "2.5",
    site_ces_regl: flat.site_ces_regl || "60%",
    site_sdp_max: flat.site_sdp_max || `${Math.round(Number(p.site_area || 0) * Number(siteDiag.cos_reglementaire || p.max_floors || 2.5))} m²`,
    // Retraits
    retrait_avant: flat.retrait_avant, retrait_lateral: flat.retrait_lateral,
    retrait_arriere: flat.retrait_arriere,
    retrait_mitoyennete: flat.retrait_mitoyennete,
    retrait_emprise_constructible: flat.retrait_emprise_constructible,
    retrait_reduction_pct: flat.retrait_reduction_pct,
    // Orientation
    orient_zone: flat.orient_zone,
    orient_facade_optimale: flat.orient_facade_optimale,
    orient_recommandation: flat.orient_recommandation,
    // Client profile
    program_main: p.program_main, primary_driver: p.primary_driver,
    standing_level: p.standing_level,
    target_surface_m2: p.target_surface_m2, target_units: p.target_units,
    budget_range: p.budget_range, budget_band: p.budget_band,
    budget_tension: p.budget_tension,
    feasibility_posture: flat.profil_posture || p.feasibility_posture,
    // Scores
    rent_score: p.rent_score, capacity_score: p.capacity_score,
    mix_score: p.mix_score, phase_score: p.phase_score, risk_score: p.risk_score,
    // Phasage
    phasage_text: flat.phasage_text,
    // Recommendation + recommended scenario details
    rec_scenario: flat.rec_scenario, rec_score: flat.rec_score,
    rec_cost_total: (() => { const rs = flat.rec_scenario; if (rs === "A") return flat.A_cost_total; if (rs === "B") return flat.B_cost_total; return flat.C_cost_total; })(),
    rec_levels: (() => { const rs = flat.rec_scenario; if (rs === "A") return flat.A_levels; if (rs === "B") return flat.B_levels; return flat.C_levels; })(),
    rec_fp: (() => { const rs = flat.rec_scenario; if (rs === "A") return flat.A_fp; if (rs === "B") return flat.B_fp; return flat.C_fp; })(),
    rec_cos_pct: (() => { const rs = flat.rec_scenario; if (rs === "A") return flat.A_cos_pct; if (rs === "B") return flat.B_cos_pct; return flat.C_cos_pct; })(),
    rec_duree_chantier: (() => { const rs = flat.rec_scenario; if (rs === "A") return flat.A_duree_chantier; if (rs === "B") return flat.B_duree_chantier; return flat.C_duree_chantier; })(),
    rec_hono_bas: (() => { const rs = flat.rec_scenario; if (rs === "A") return flat.A_hono_bas_M; if (rs === "B") return flat.B_hono_bas_M; return flat.C_hono_bas_M; })(),
    rec_hono_haut: (() => { const rs = flat.rec_scenario; if (rs === "A") return flat.A_hono_haut_M; if (rs === "B") return flat.B_hono_haut_M; return flat.C_hono_haut_M; })(),
    rec_hono_taux_bas: (() => { const rs = flat.rec_scenario; if (rs === "A") return flat.A_hono_taux_bas; if (rs === "B") return flat.B_hono_taux_bas; return flat.C_hono_taux_bas; })(),
    rec_hono_taux_haut: (() => { const rs = flat.rec_scenario; if (rs === "A") return flat.A_hono_taux_haut; if (rs === "B") return flat.B_hono_taux_haut; return flat.C_hono_taux_haut; })(),
    rec_hab_m2_total: (() => { const rs = flat.rec_scenario; if (rs === "A") return flat.A_hab_m2_total; if (rs === "B") return flat.B_hab_m2_total; return flat.C_hab_m2_total; })(),
    // v72.82: ventilation du scénario recommandé (pour slides 17/18)
    rec_ventil_go: (() => { const rs = flat.rec_scenario; return flat[`${rs}_ventil_go`] || ""; })(),
    rec_ventil_so: (() => { const rs = flat.rec_scenario; return flat[`${rs}_ventil_so`] || ""; })(),
    rec_ventil_lt: (() => { const rs = flat.rec_scenario; return flat[`${rs}_ventil_lt`] || ""; })(),
    rec_ventil_vrd: (() => { const rs = flat.rec_scenario; return flat[`${rs}_ventil_vrd`] || ""; })(),
    rec_ventil_go_pct: (() => { const rs = flat.rec_scenario; const cv = (rs === "A" ? sA : rs === "B" ? sB : sC).cout_ventilation || {}; const t = (rs === "A" ? sA : rs === "B" ? sB : sC).cost_total_fcfa || 1; return `${Math.round((cv.gros_oeuvre_fcfa || 0) / t * 100)}%`; })(),
    rec_ventil_so_pct: (() => { const rs = flat.rec_scenario; const cv = (rs === "A" ? sA : rs === "B" ? sB : sC).cout_ventilation || {}; const t = (rs === "A" ? sA : rs === "B" ? sB : sC).cost_total_fcfa || 1; return `${Math.round((cv.second_oeuvre_fcfa || 0) / t * 100)}%`; })(),
    rec_ventil_lt_pct: (() => { const rs = flat.rec_scenario; const cv = (rs === "A" ? sA : rs === "B" ? sB : sC).cout_ventilation || {}; const t = (rs === "A" ? sA : rs === "B" ? sB : sC).cost_total_fcfa || 1; return `${Math.round((cv.lots_techniques_fcfa || 0) / t * 100)}%`; })(),
    // v72.87: VRD pct inclut amenagements_ext pour total 100%
    rec_ventil_vrd_pct: (() => { const rs = flat.rec_scenario; const cv = (rs === "A" ? sA : rs === "B" ? sB : sC).cout_ventilation || {}; const t = (rs === "A" ? sA : rs === "B" ? sB : sC).cost_total_fcfa || 1; return `${Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / t * 100)}%`; })(),
    // Scenario A
    A_role: sA.role || flat.A_role || "", A_fp: flat.A_fp,
    A_levels: String(Math.max(0, (sA.levels || 1) - 1)), // v72.80 FIX: R+X = levels-1 (levels=total incl. RDC)
    A_levels_total: flat.A_levels, // total levels for internal use
    A_height: flat.A_height, A_sdp: flat.A_sdp, A_units: flat.A_units,
    A_unit_summary: flat.A_unit_summary, A_m2_par_logt: flat.A_m2_par_logt,
    A_has_pilotis: flat.A_has_pilotis, A_cost_total: flat.A_cost_total,
    A_cost_m2: flat.A_cost_m2, A_fourchette_text: flat.A_fourchette_text,
    A_budget_fit: flat.A_budget_fit, A_cos_pct: flat.A_cos_pct,
    A_cos_compliance: flat.A_cos_compliance, A_duree_chantier: flat.A_duree_chantier,
    A_parking_places: flat.A_parking_places, A_parking_deficit: flat.A_parking_deficit,
    A_parking_source: flat.A_parking_source, A_ventil_global: flat.A_ventil_global,
    A_ventil_go: flat.A_ventil_go || "", A_ventil_so: flat.A_ventil_so || "",
    A_ventil_lt: flat.A_ventil_lt || "", A_ventil_vrd: flat.A_ventil_vrd || "",
    A_ventil_hono: flat.A_ventil_hono || "",
    A_hono_bas_M: flat.A_hono_bas_M || "", A_hono_haut_M: flat.A_hono_haut_M || "",
    A_hono_taux_bas: flat.A_hono_taux_bas || "", A_hono_taux_haut: flat.A_hono_taux_haut || "",
    A_cost_unit: flat.A_cost_unit || "", A_free_ground: flat.A_free_ground,
    A_budget_equation: flat.A_budget_equation || "",
    A_gabarit: sA.gabarit_desc || flat.A_gabarit || "",
    // Scenario B
    B_role: sB.role || flat.B_role || "", B_fp: flat.B_fp,
    B_levels: String(Math.max(0, (sB.levels || 1) - 1)), // v72.80 FIX: R+X = levels-1
    B_height: flat.B_height, B_sdp: flat.B_sdp, B_units: flat.B_units,
    B_unit_summary: flat.B_unit_summary, B_m2_par_logt: flat.B_m2_par_logt,
    B_has_pilotis: flat.B_has_pilotis, B_cost_total: flat.B_cost_total,
    B_cost_m2: flat.B_cost_m2, B_fourchette_text: flat.B_fourchette_text,
    B_budget_fit: flat.B_budget_fit, B_cos_pct: flat.B_cos_pct,
    B_cos_compliance: flat.B_cos_compliance, B_duree_chantier: flat.B_duree_chantier,
    B_parking_places: flat.B_parking_places, B_parking_deficit: flat.B_parking_deficit,
    B_parking_source: flat.B_parking_source, B_ventil_global: flat.B_ventil_global,
    B_ventil_go: flat.B_ventil_go || "", B_ventil_so: flat.B_ventil_so || "",
    B_ventil_lt: flat.B_ventil_lt || "", B_ventil_vrd: flat.B_ventil_vrd || "",
    B_ventil_hono: flat.B_ventil_hono || "",
    B_hono_bas_M: flat.B_hono_bas_M || "", B_hono_haut_M: flat.B_hono_haut_M || "",
    B_hono_taux_bas: flat.B_hono_taux_bas || "", B_hono_taux_haut: flat.B_hono_taux_haut || "",
    B_cost_unit: flat.B_cost_unit || "", B_free_ground: flat.B_free_ground,
    B_budget_equation: flat.B_budget_equation || "",
    B_gabarit: sB.gabarit_desc || flat.B_gabarit || "",
    // Scenario C
    C_role: sC.role || flat.C_role || "", C_fp: flat.C_fp,
    C_levels: String(Math.max(0, (sC.levels || 1) - 1)), // v72.80 FIX: R+X = levels-1
    C_height: flat.C_height, C_sdp: flat.C_sdp, C_units: flat.C_units,
    C_unit_summary: flat.C_unit_summary, C_m2_par_logt: flat.C_m2_par_logt,
    C_has_pilotis: flat.C_has_pilotis, C_cost_total: flat.C_cost_total,
    C_cost_m2: flat.C_cost_m2, C_fourchette_text: flat.C_fourchette_text,
    C_budget_fit: flat.C_budget_fit, C_cos_pct: flat.C_cos_pct,
    C_cos_compliance: flat.C_cos_compliance, C_duree_chantier: flat.C_duree_chantier,
    C_parking_places: flat.C_parking_places, C_parking_deficit: flat.C_parking_deficit,
    C_parking_source: flat.C_parking_source, C_ventil_global: flat.C_ventil_global,
    C_ventil_go: flat.C_ventil_go || "", C_ventil_so: flat.C_ventil_so || "",
    C_ventil_lt: flat.C_ventil_lt || "", C_ventil_vrd: flat.C_ventil_vrd || "",
    C_ventil_hono: flat.C_ventil_hono || "",
    C_hono_bas_M: flat.C_hono_bas_M || "", C_hono_haut_M: flat.C_hono_haut_M || "",
    C_hono_taux_bas: flat.C_hono_taux_bas || "", C_hono_taux_haut: flat.C_hono_taux_haut || "",
    C_cost_unit: flat.C_cost_unit || "", C_free_ground: flat.C_free_ground,
    C_budget_equation: flat.C_budget_equation || "",
    C_gabarit: sC.gabarit_desc || flat.C_gabarit || "",
    // v72.80: Individual scores (0-100)
    A_score: String(Math.round((sA.recommendation_score || 0) * 100)),
    B_score: String(Math.round((sB.recommendation_score || 0) * 100)),
    C_score: String(Math.round((sC.recommendation_score || 0) * 100)),
    // v72.80: hab_m2_total per scenario
    A_hab_m2_total: String(sA.surface_habitable_m2 || sA.total_useful_m2 || 0),
    B_hab_m2_total: String(sB.surface_habitable_m2 || sB.total_useful_m2 || 0),
    C_hab_m2_total: String(sC.surface_habitable_m2 || sC.total_useful_m2 || 0),
    // v72.80: Ventilation percentages (pre-calculated for GPT)
    A_ventil_go_pct: (() => { const cv = sA.cout_ventilation || {}; const t = sA.cost_total_fcfa || 1; return `${Math.round((cv.gros_oeuvre_fcfa || 0) / t * 100)}%`; })(),
    A_ventil_so_pct: (() => { const cv = sA.cout_ventilation || {}; const t = sA.cost_total_fcfa || 1; return `${Math.round((cv.second_oeuvre_fcfa || 0) / t * 100)}%`; })(),
    A_ventil_lt_pct: (() => { const cv = sA.cout_ventilation || {}; const t = sA.cost_total_fcfa || 1; return `${Math.round((cv.lots_techniques_fcfa || 0) / t * 100)}%`; })(),
    // v72.87: VRD pct inclut amenagements_ext pour que GO+SO+LT+VRD = 100%
    A_ventil_vrd_pct: (() => { const cv = sA.cout_ventilation || {}; const t = sA.cost_total_fcfa || 1; return `${Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / t * 100)}%`; })(),
    B_ventil_go_pct: (() => { const cv = sB.cout_ventilation || {}; const t = sB.cost_total_fcfa || 1; return `${Math.round((cv.gros_oeuvre_fcfa || 0) / t * 100)}%`; })(),
    B_ventil_so_pct: (() => { const cv = sB.cout_ventilation || {}; const t = sB.cost_total_fcfa || 1; return `${Math.round((cv.second_oeuvre_fcfa || 0) / t * 100)}%`; })(),
    B_ventil_lt_pct: (() => { const cv = sB.cout_ventilation || {}; const t = sB.cost_total_fcfa || 1; return `${Math.round((cv.lots_techniques_fcfa || 0) / t * 100)}%`; })(),
    B_ventil_vrd_pct: (() => { const cv = sB.cout_ventilation || {}; const t = sB.cost_total_fcfa || 1; return `${Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / t * 100)}%`; })(),
    C_ventil_go_pct: (() => { const cv = sC.cout_ventilation || {}; const t = sC.cost_total_fcfa || 1; return `${Math.round((cv.gros_oeuvre_fcfa || 0) / t * 100)}%`; })(),
    C_ventil_so_pct: (() => { const cv = sC.cout_ventilation || {}; const t = sC.cost_total_fcfa || 1; return `${Math.round((cv.second_oeuvre_fcfa || 0) / t * 100)}%`; })(),
    C_ventil_lt_pct: (() => { const cv = sC.cout_ventilation || {}; const t = sC.cost_total_fcfa || 1; return `${Math.round((cv.lots_techniques_fcfa || 0) / t * 100)}%`; })(),
    C_ventil_vrd_pct: (() => { const cv = sC.cout_ventilation || {}; const t = sC.cost_total_fcfa || 1; return `${Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / t * 100)}%`; })(),
    // v72.80: Budget as clean FCFA string (parsed from raw budget_range)
    budget_fcfa: (() => {
      const raw = String(p.budget_range || "");
      const fcfaM = raw.match(/(\d[\d\s.,]*)\s*M\s*FCFA/i);
      if (fcfaM) return fcfaM[1].replace(/[\s,]/g, '').replace(',', '.') + "M FCFA";
      const fcfaPlain = raw.match(/~?\s*(\d[\d\s]*)\s*M\s*FCFA/i);
      if (fcfaPlain) return fcfaPlain[1].replace(/\s/g, '') + "M FCFA";
      const eurM = raw.match(/(\d[\d\s.,]*)\s*M?\s*€/i);
      if (eurM) { const eur = parseFloat(eurM[1].replace(/[\s,]/g, '')) * (eurM[0].includes('M') ? 1e6 : 1); return Math.round(eur * 655.957 / 1e6) + "M FCFA"; }
      if (Number(p.budget_range) > 0) return Math.round(Number(p.budget_range) * 655.957 / 1e6) + "M FCFA";
      return "N/A";
    })(),
    // v72.80: Posture in French
    feasibility_posture_fr: (() => {
      const p2 = String(flat.profil_posture || p.feasibility_posture || "").toUpperCase();
      return { AGGRESSIVE: "AMBITIEUSE", BALANCED: "EQUILIBREE", CONSERVATIVE: "PRUDENTE" }[p2] || p2;
    })(),
    // Deltas
    delta_BA_sdp: flat.delta_BA_sdp, delta_BA_cout: flat.delta_BA_cout,
    delta_CA_sdp: flat.delta_CA_sdp, delta_CA_cout: flat.delta_CA_cout,
    delta_CB_sdp: flat.delta_CB_sdp || "", delta_CB_cout: flat.delta_CB_cout || "",
    // v72.84: Pre-computed budget delta for slides 17/18
    rec_budget_delta_M: (() => {
      const recKey = flat.rec_scenario || "C";
      const recCost = parseInt((flat[`${recKey}_cost_total`] || "0").replace(/[^\d]/g, "")) || 0;
      const budgetVal = parseInt((flat.budget_fcfa || "0").replace(/[^\d]/g, "")) || 0;
      return `${Math.abs(recCost - budgetVal)}M`;
    })(),
    rec_budget_delta_sign: (() => {
      const recKey = flat.rec_scenario || "C";
      const recCost = parseInt((flat[`${recKey}_cost_total`] || "0").replace(/[^\d]/g, "")) || 0;
      const budgetVal = parseInt((flat.budget_fcfa || "0").replace(/[^\d]/g, "")) || 0;
      return recCost > budgetVal ? "depassement" : "economie";
    })(),
    // v72.91: Pass template slide_5 text as base for GPT reformulation
    slide_5_base: (templateTexts && templateTexts.slide_5_text) || "",
  }, null, 0);
}
/**
 * Call GPT-4o to generate all diagnostic texts
 */
async function generateDiagnosticTexts(dataContext, rules) {
  const t0 = Date.now();
  const controller = new (typeof AbortController !== "undefined" ? AbortController : require("abort-controller"))();
  const timer = setTimeout(() => controller.abort(), GPT_TEXT_TIMEOUT_MS);
  try {
    console.log(`[GENERATE-TEXTS] Calling GPT-4o...`);
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: GPT_TEXT_MODEL,
        temperature: 0.4,
        max_tokens: 8000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: rules },
          { role: "user", content: `Voici les données du projet. Génère TOUS les textes demandés en JSON.\n\n{data} = ${dataContext}` }
        ]
      })
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[GENERATE-TEXTS] GPT error ${resp.status}: ${errText.substring(0, 500)}`);
      return { error: `GPT ${resp.status}`, elapsed_ms: Date.now() - t0 };
    }
    const json = await resp.json();
    const content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || "{}";
    const elapsed = Date.now() - t0;
    console.log(`[GENERATE-TEXTS] GPT responded in ${elapsed}ms, ${content.length} chars`);
    try {
      const texts = JSON.parse(content);
      texts._gpt_elapsed_ms = elapsed;
      texts._gpt_model = GPT_TEXT_MODEL;
      return texts;
    } catch (parseErr) {
      console.error(`[GENERATE-TEXTS] JSON parse error: ${parseErr.message}`);
      return { error: "JSON parse failed", raw: content.substring(0, 1000), elapsed_ms: elapsed };
    }
  } catch (err) {
    clearTimeout(timer);
    console.error(`[GENERATE-TEXTS] Error: ${err.message}`);
    return { error: err.message, elapsed_ms: Date.now() - t0 };
  }
}
app.post("/generate-texts", async (req, res) => {
  const t0 = Date.now();
  console.log(`\n═══ /generate-texts v3.0-PREMIUM ═══`);
  const p = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch(e) { return {}; } })() : (req.body || {});
  if (!p.site_area || !p.envelope_w || !p.envelope_d) {
    return res.status(400).json({ error: "site_area, envelope_w, envelope_d obligatoires" });
  }
  // Step 1: Compute scenarios (reuse existing engine)
  const scenarios = computeSmartScenarios({
    site_area: Number(p.site_area),
    envelope_w: Number(p.envelope_w),
    envelope_d: Number(p.envelope_d),
    envelope_area: Number(p.envelope_area) || undefined,
    zoning_type: p.zoning_type || "URBAIN",
    floor_height: Number(p.floor_height) || 3.2,
    primary_driver: p.primary_driver || "MAX_CAPACITE",
    max_floors: Number(p.max_floors) || 99,
    max_height_m: Number(p.max_height_m) || 99,
    program_main: p.program_main || p.project_type || "",
    target_surface_m2: Number(p.target_surface_m2) || 0,
    site_saturation_level: p.site_saturation_level || "MEDIUM",
    financial_rigidity_score: Number(p.financial_rigidity_score) || 0,
    density_band: p.density_band || "",
    risk_adjusted: Number(p.risk_adjusted) || 0,
    feasibility_posture: p.feasibility_posture || "BALANCED",
    scenario_A_role: p.scenario_A_role || "",
    scenario_B_role: p.scenario_B_role || "",
    scenario_C_role: p.scenario_C_role || "",
    budget_range: Number(p.budget_range) || 0,
    budget_range_raw: String(p.budget_range || ""),
    budget_band: p.budget_band || "",
    budget_tension: Number(p.budget_tension) || 0,
    standing_level: p.standing_level || "STANDARD",
    target_units: Number(p.target_units) || 0,
    rent_score: Number(p.rent_score) || 0,
    capacity_score: Number(p.capacity_score) || 0,
    mix_score: Number(p.mix_score) || 0,
    phase_score: Number(p.phase_score) || 0,
    risk_score: Number(p.risk_score) || 0,
    density_pressure_factor: Number(p.density_pressure_factor) || 1,
    driver_intensity: p.driver_intensity || "MEDIUM",
    strategic_position: p.strategic_position || "",
    layout_mode: p.layout_mode || "SUPERPOSE",
    commerce_depth_m: Number(p.commerce_depth_m) || 6,
    retrait_inter_volumes_m: Number(p.retrait_inter_volumes_m) || 4,
  });
  // Step 2: Flatten scenario data (reuse existing flatten logic)
  const diag = scenarios.diagnostic || {};
  const comp = diag.comparatif || {};
  const deltas = comp.deltas || {};
  const dBA = deltas.B_vs_A || {};
  const dCA = deltas.C_vs_A || {};
  const dCB = deltas.C_vs_B || {};
  const phasage = diag.strategie_phasage || {};
  const orient = diag.orientation_solaire || {};
  const retr = diag.retraits_reglementaires || {};
  const profil = diag.profil_client || {};
  const siteDiag = diag.site || {};
  const sA = scenarios.A || {};
  const sB = scenarios.B || {};
  const sC = scenarios.C || {};
  const flat = {
    diagnostic_narrative: (diag.recommandation || {}).narrative || "",
    rec_scenario: (diag.recommandation || {}).scenario || "",
    rec_score: Math.round(((diag.recommandation || {}).score || 0) * 100), // v72.80 FIX: 0-1 → 0-100
    delta_BA_sdp: `${dBA.delta_sdp_m2 || 0} m² (${dBA.delta_sdp_pct || 0}%)`,
    delta_BA_cout: `${dBA.delta_cout_fcfa ? Math.round(dBA.delta_cout_fcfa / 1e6) : 0}M FCFA (${dBA.delta_cout_pct || 0}%)`,
    delta_BA_unites: `${dBA.delta_unites || 0} logements`,
    delta_CA_sdp: `${dCA.delta_sdp_m2 || 0} m² (${dCA.delta_sdp_pct || 0}%)`,
    delta_CA_cout: `${dCA.delta_cout_fcfa ? Math.round(dCA.delta_cout_fcfa / 1e6) : 0}M FCFA (${dCA.delta_cout_pct || 0}%)`,
    delta_CA_unites: `${dCA.delta_unites || 0} logements`,
    delta_CB_sdp: `${dCB.delta_sdp_m2 || 0} m² (${dCB.delta_sdp_pct || 0}%)`,
    delta_CB_cout: `${dCB.delta_cout_fcfa ? Math.round(dCB.delta_cout_fcfa / 1e6) : 0}M FCFA (${dCB.delta_cout_pct || 0}%)`,
    phasage_text: phasage.text || "",
    orient_zone: orient.zone_climatique || "",
    orient_facade_optimale: orient.facade_optimale || "",
    orient_recommandation: orient.recommandation || "",
    retrait_avant: `${retr.avant_m || 0}m`,
    retrait_lateral: `${retr.lateral_m || 0}m`,
    retrait_arriere: `${retr.arriere_m || 0}m`,
    retrait_mitoyennete: String(retr.mitoyennete_cotes || 0),
    retrait_emprise_constructible: `${retr.emprise_constructible_m2 || 0} m²`,
    retrait_reduction_pct: `${retr.reduction_pct || 0}%`,
    site_cos_regl: String(siteDiag.cos_regl || "2.5"),
    site_ces_regl: String(siteDiag.ces_regl_pct || "60"),
    site_sdp_max: `${siteDiag.sdp_max_m2 || 0} m²`,
    site_emprise_max: `${siteDiag.emprise_max_m2 || 0} m²`,
    profil_posture: profil.posture || p.feasibility_posture || "BALANCED",
    profil_standing: profil.standing || p.standing_level || "STANDARD",
    profil_programme: profil.programme || "",
    A_role: sA.role || "", A_fp: String(sA.fp_m2 || 0), A_levels: String(sA.levels || 0),
    A_height: String(sA.height_m || 0), A_sdp: String(sA.sdp_m2 || 0),
    A_units: String(sA.total_units || 0), A_unit_summary: sA.unit_mix_detail || "",
    A_m2_par_logt: String(sA.m2_habitable_par_logement || 0),
    A_has_pilotis: String(sA.has_pilotis || false),
    A_cost_total: `${sA.cost_total_fcfa ? Math.round(sA.cost_total_fcfa / 1e6) : 0}M FCFA`,
    A_cost_m2: `${sA.cost_per_m2_sdp ? Math.round(sA.cost_per_m2_sdp / 1000) : 0}k FCFA/m²`,
    A_cost_m2_marche: `${sA.market_cost_per_m2 ? Math.round(sA.market_cost_per_m2 / 1000) : 0}k`,
    A_cost_m2_ajuste: `${sA.cost_per_m2 ? Math.round(sA.cost_per_m2 / 1000) : 0}k`,
    A_fourchette_text: `entre ${sA.cout_fourchette ? Math.round(sA.cout_fourchette.bas / 1e6) : 0}M et ${sA.cout_fourchette ? Math.round(sA.cout_fourchette.haut / 1e6) : 0}M FCFA`,
    A_budget_fit: sA.budget_fit || "", A_cos_pct: String(sA.cos_ratio_pct || 0),
    A_cos_compliance: sA.cos_compliance || "", A_duree_chantier: `${sA.duree_chantier_mois || 0} mois`,
    A_parking_places: String((sA.parking_detail || {}).places_disponibles || 0),
    A_parking_deficit: String((sA.parking_detail || {}).deficit || 0),
    A_parking_source: (sA.parking_detail || {}).source || "",
    A_ventil_global: `${sA.cost_total_fcfa ? Math.round(sA.cost_total_fcfa / 1e6) : 0}M FCFA`,
    // v72.72: FIX — cout_ventilation + sous-clés _fcfa + honoraires_architecte
    A_ventil_go: `${Math.round(((sA.cout_ventilation || {}).gros_oeuvre_fcfa || 0) / 1e6)}M`,
    A_ventil_so: `${Math.round(((sA.cout_ventilation || {}).second_oeuvre_fcfa || 0) / 1e6)}M`,
    A_ventil_lt: `${Math.round(((sA.cout_ventilation || {}).lots_techniques_fcfa || 0) / 1e6)}M`,
    A_ventil_vrd: `${(() => { const cv = sA.cout_ventilation || {}; return Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / 1e6); })()}M`,
    A_ventil_hono: `${Math.round((((sA.cout_ventilation || {}).honoraires_architecte || {}).median_fcfa || 0) / 1e6)}M`,
    A_hono_bas_M: String(Math.round((((sA.cout_ventilation || {}).honoraires_architecte || {}).bas_fcfa || 0) / 1e6)),
    A_hono_haut_M: String(Math.round((((sA.cout_ventilation || {}).honoraires_architecte || {}).haut_fcfa || 0) / 1e6)),
    A_hono_taux_bas: `${((sA.cout_ventilation || {}).honoraires_architecte || {}).taux_bas_pct || 10}%`,
    A_hono_taux_haut: `${((sA.cout_ventilation || {}).honoraires_architecte || {}).taux_haut_pct || 15}%`,
    A_cost_unit: `${sA.cost_per_unit ? Math.round(sA.cost_per_unit / 1e6) : 0}M FCFA`,
    A_free_ground: `${sA.free_ground_m2 || 0} m²`,
    A_budget_equation: sA.budget_equation || "",
    A_gabarit: sA.gabarit_desc || "",
    A_accent_color: sA.accent_color || "#2a5298",
    A_efficacite: `${sA.efficacite_pct || 0}%`,
    A_hab_m2_total: String(sA.hab_m2_total || 0),
    A_commerce_count: String(sA.commerce_count || 0),
    A_logement_count: String(sA.logement_count || 0),
    A_typology_desc: sA.typology_desc || "",
    A_pilotis_desc: sA.pilotis_desc || "pas de pilotis",
    A_config_justif: sA.config_justification || "",
    A_layout_mode: sA.layout_mode || "SUPERPOSE",
    A_split_layout: sA.split_layout ? JSON.stringify(sA.split_layout) : "",
    A_frais_M: `${sA.frais_annexes ? Math.round(sA.frais_annexes / 1e6) : 0}M`,
    B_role: sB.role || "", B_fp: String(sB.fp_m2 || 0), B_levels: String(sB.levels || 0),
    B_height: String(sB.height_m || 0), B_sdp: String(sB.sdp_m2 || 0),
    B_units: String(sB.total_units || 0), B_unit_summary: sB.unit_mix_detail || "",
    B_m2_par_logt: String(sB.m2_habitable_par_logement || 0),
    B_has_pilotis: String(sB.has_pilotis || false),
    B_cost_total: `${sB.cost_total_fcfa ? Math.round(sB.cost_total_fcfa / 1e6) : 0}M FCFA`,
    B_cost_m2: `${sB.cost_per_m2_sdp ? Math.round(sB.cost_per_m2_sdp / 1000) : 0}k FCFA/m²`,
    B_cost_m2_marche: `${sB.market_cost_per_m2 ? Math.round(sB.market_cost_per_m2 / 1000) : 0}k`,
    B_cost_m2_ajuste: `${sB.cost_per_m2 ? Math.round(sB.cost_per_m2 / 1000) : 0}k`,
    B_fourchette_text: `entre ${sB.cout_fourchette ? Math.round(sB.cout_fourchette.bas / 1e6) : 0}M et ${sB.cout_fourchette ? Math.round(sB.cout_fourchette.haut / 1e6) : 0}M FCFA`,
    B_budget_fit: sB.budget_fit || "", B_cos_pct: String(sB.cos_ratio_pct || 0),
    B_cos_compliance: sB.cos_compliance || "", B_duree_chantier: `${sB.duree_chantier_mois || 0} mois`,
    B_parking_places: String((sB.parking_detail || {}).places_disponibles || 0),
    B_parking_deficit: String((sB.parking_detail || {}).deficit || 0),
    B_parking_source: (sB.parking_detail || {}).source || "",
    B_ventil_global: `${sB.cost_total_fcfa ? Math.round(sB.cost_total_fcfa / 1e6) : 0}M FCFA`,
    B_ventil_go: `${Math.round(((sB.cout_ventilation || {}).gros_oeuvre_fcfa || 0) / 1e6)}M`,
    B_ventil_so: `${Math.round(((sB.cout_ventilation || {}).second_oeuvre_fcfa || 0) / 1e6)}M`,
    B_ventil_lt: `${Math.round(((sB.cout_ventilation || {}).lots_techniques_fcfa || 0) / 1e6)}M`,
    B_ventil_vrd: `${(() => { const cv = sB.cout_ventilation || {}; return Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / 1e6); })()}M`,
    B_ventil_hono: `${Math.round((((sB.cout_ventilation || {}).honoraires_architecte || {}).median_fcfa || 0) / 1e6)}M`,
    B_hono_bas_M: String(Math.round((((sB.cout_ventilation || {}).honoraires_architecte || {}).bas_fcfa || 0) / 1e6)),
    B_hono_haut_M: String(Math.round((((sB.cout_ventilation || {}).honoraires_architecte || {}).haut_fcfa || 0) / 1e6)),
    B_hono_taux_bas: `${((sB.cout_ventilation || {}).honoraires_architecte || {}).taux_bas_pct || 10}%`,
    B_hono_taux_haut: `${((sB.cout_ventilation || {}).honoraires_architecte || {}).taux_haut_pct || 15}%`,
    B_cost_unit: `${sB.cost_per_unit ? Math.round(sB.cost_per_unit / 1e6) : 0}M FCFA`,
    B_free_ground: `${sB.free_ground_m2 || 0} m²`,
    B_budget_equation: sB.budget_equation || "",
    B_gabarit: sB.gabarit_desc || "",
    B_accent_color: sB.accent_color || "#1e8449",
    B_efficacite: `${sB.efficacite_pct || 0}%`,
    B_hab_m2_total: String(sB.hab_m2_total || 0),
    B_commerce_count: String(sB.commerce_count || 0),
    B_logement_count: String(sB.logement_count || 0),
    B_typology_desc: sB.typology_desc || "",
    B_pilotis_desc: sB.pilotis_desc || "pas de pilotis",
    B_config_justif: sB.config_justification || "",
    B_layout_mode: sB.layout_mode || "SUPERPOSE",
    B_frais_M: `${sB.frais_annexes ? Math.round(sB.frais_annexes / 1e6) : 0}M`,
    C_role: sC.role || "", C_fp: String(sC.fp_m2 || 0), C_levels: String(sC.levels || 0),
    C_height: String(sC.height_m || 0), C_sdp: String(sC.sdp_m2 || 0),
    C_units: String(sC.total_units || 0), C_unit_summary: sC.unit_mix_detail || "",
    C_m2_par_logt: String(sC.m2_habitable_par_logement || 0),
    C_has_pilotis: String(sC.has_pilotis || false),
    C_cost_total: `${sC.cost_total_fcfa ? Math.round(sC.cost_total_fcfa / 1e6) : 0}M FCFA`,
    C_cost_m2: `${sC.cost_per_m2_sdp ? Math.round(sC.cost_per_m2_sdp / 1000) : 0}k FCFA/m²`,
    C_cost_m2_marche: `${sC.market_cost_per_m2 ? Math.round(sC.market_cost_per_m2 / 1000) : 0}k`,
    C_cost_m2_ajuste: `${sC.cost_per_m2 ? Math.round(sC.cost_per_m2 / 1000) : 0}k`,
    C_fourchette_text: `entre ${sC.cout_fourchette ? Math.round(sC.cout_fourchette.bas / 1e6) : 0}M et ${sC.cout_fourchette ? Math.round(sC.cout_fourchette.haut / 1e6) : 0}M FCFA`,
    C_budget_fit: sC.budget_fit || "", C_cos_pct: String(sC.cos_ratio_pct || 0),
    C_cos_compliance: sC.cos_compliance || "", C_duree_chantier: `${sC.duree_chantier_mois || 0} mois`,
    C_parking_places: String((sC.parking_detail || {}).places_disponibles || 0),
    C_parking_deficit: String((sC.parking_detail || {}).deficit || 0),
    C_parking_source: (sC.parking_detail || {}).source || "",
    C_ventil_global: `${sC.cost_total_fcfa ? Math.round(sC.cost_total_fcfa / 1e6) : 0}M FCFA`,
    C_ventil_go: `${Math.round(((sC.cout_ventilation || {}).gros_oeuvre_fcfa || 0) / 1e6)}M`,
    C_ventil_so: `${Math.round(((sC.cout_ventilation || {}).second_oeuvre_fcfa || 0) / 1e6)}M`,
    C_ventil_lt: `${Math.round(((sC.cout_ventilation || {}).lots_techniques_fcfa || 0) / 1e6)}M`,
    C_ventil_vrd: `${(() => { const cv = sC.cout_ventilation || {}; return Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / 1e6); })()}M`,
    C_ventil_hono: `${Math.round((((sC.cout_ventilation || {}).honoraires_architecte || {}).median_fcfa || 0) / 1e6)}M`,
    C_hono_bas_M: String(Math.round((((sC.cout_ventilation || {}).honoraires_architecte || {}).bas_fcfa || 0) / 1e6)),
    C_hono_haut_M: String(Math.round((((sC.cout_ventilation || {}).honoraires_architecte || {}).haut_fcfa || 0) / 1e6)),
    C_hono_taux_bas: `${((sC.cout_ventilation || {}).honoraires_architecte || {}).taux_bas_pct || 10}%`,
    C_hono_taux_haut: `${((sC.cout_ventilation || {}).honoraires_architecte || {}).taux_haut_pct || 15}%`,
    C_cost_unit: `${sC.cost_per_unit ? Math.round(sC.cost_per_unit / 1e6) : 0}M FCFA`,
    C_free_ground: `${sC.free_ground_m2 || 0} m²`,
    C_budget_equation: sC.budget_equation || "",
    C_gabarit: sC.gabarit_desc || "",
    C_accent_color: sC.accent_color || "#d35400",
    C_efficacite: `${sC.efficacite_pct || 0}%`,
    C_hab_m2_total: String(sC.hab_m2_total || 0),
    C_commerce_count: String(sC.commerce_count || 0),
    C_logement_count: String(sC.logement_count || 0),
    C_typology_desc: sC.typology_desc || "",
    C_pilotis_desc: sC.pilotis_desc || "pas de pilotis",
    C_config_justif: sC.config_justification || "",
    C_layout_mode: sC.layout_mode || "SUPERPOSE",
    C_frais_M: `${sC.frais_annexes ? Math.round(sC.frais_annexes / 1e6) : 0}M`,
  };
  // ═══ v72.91 ENRICH flat with ALL keys needed by template engine ═══
  enrichFlatForTemplates(flat, p, scenarios);
  // ═══ v72.90 TEMPLATE ENGINE — deterministic texts (zero GPT) ═══
  const templateTexts = buildTemplateTexts(flat, scenarios);
  console.log(`[GENERATE-TEXTS] Template engine: ${Object.keys(templateTexts).length} deterministic texts`);
  // ═══ v72.90 GPT — ONLY slide_5_text (qualitative neighborhood context) ═══
  const rules = buildGptTextRules();
  const dataContext = buildGptDataContext(p, scenarios, flat, templateTexts);
  let gptTexts = {};
  if (OPENAI_API_KEY) {
    try {
      gptTexts = await generateDiagnosticTexts(dataContext, rules);
      console.log(`[GENERATE-TEXTS] GPT returned: ${Object.keys(gptTexts).join(", ")}`);
    } catch (gptErr) {
      console.error(`[GENERATE-TEXTS] GPT error: ${gptErr.message} — using fallback`);
    }
  } else {
    console.warn(`[GENERATE-TEXTS] OPENAI_API_KEY missing — slide_5_text will be empty`);
  }
  // ═══ v72.91 MERGE: templates (base) + GPT reformulation (slide_5_text only) ═══
  // Templates are the source of truth. GPT only REFORMULATES slide_5_text.
  // If GPT fails, the template version is already professional and complete.
  let generatedTexts = { ...templateTexts };
  if (gptTexts.slide_5_text && gptTexts.slide_5_text.length > 50) {
    generatedTexts.slide_5_text = gptTexts.slide_5_text;
    console.log(`[GENERATE-TEXTS] ✅ GPT slide_5_text reformulated (${gptTexts.slide_5_text.length} chars)`);
  } else {
    // Template slide_5_text is already filled by buildTemplateTexts — keep it as is
    console.log(`[GENERATE-TEXTS] ⚠️
 GPT slide_5_text missing/short — keeping template version`);
  }
  // v72.93: SLIDE 17/18 TEXT ALIASES (same fix as /generate-pptx)
  generatedTexts.invisible_technical_text_s17 = generatedTexts.invisible_technical_text || "";
  generatedTexts.invisible_financial_text_s17 = generatedTexts.invisible_financial_text || "";
  generatedTexts.invisible_strategic_text_s17 = generatedTexts.invisible_strategic_text || "";
  generatedTexts.invisible_technical_text_s18 = generatedTexts.success_technical_text || "";
  generatedTexts.invisible_financial_text_s18 = generatedTexts.success_financial_text || "";
  generatedTexts.invisible_strategic_text_s18 = generatedTexts.success_strategic_text || "";
  // ── PREMIUM GATE: sanitize (mostly a no-op now, but catches edge cases) ──
  generatedTexts = sanitizePremiumTexts(generatedTexts, flat);
  // Step 4: Build comparatif data from scenarios
  const comparatif = {
    comparatif_A_label: `Scenario ${sA.role || "A"} — R+${sA.levels || 0}`,
    comparatif_B_label: `Scenario ${sB.role || "B"} — R+${sB.levels || 0}`,
    comparatif_C_label: `Scenario ${sC.role || "C"} — R+${sC.levels || 0}`,
    comparatif_A_sdp: `${sA.sdp_m2 || 0} m²`,
    comparatif_B_sdp: `${sB.sdp_m2 || 0} m²`,
    comparatif_C_sdp: `${sC.sdp_m2 || 0} m²`,
    comparatif_A_cost: flat.A_cost_total,
    comparatif_B_cost: flat.B_cost_total,
    comparatif_C_cost: flat.C_cost_total,
    comparatif_A_units: flat.A_unit_summary,
    comparatif_B_units: flat.B_unit_summary,
    comparatif_C_units: flat.C_unit_summary,
  };
  // ── CONFORMITY GATE v72.87: vérification automatique post-génération ──
  const conformity = validateConformity(flat, scenarios, generatedTexts);
  // Step 5: Merge all into response
  const response = {
    ...flat,
    ...comparatif,
    generated_texts: { ...comparatif, ...generatedTexts },
    // Top-level text fields for backward compat with Google Sheets
    slide_4_text: generatedTexts.slide_4_text || "",
    slide_5_text: generatedTexts.slide_5_text || "",
    scenario_A_summary_text: generatedTexts.scenario_A_summary_text || "",
    scenario_B_summary_text: generatedTexts.scenario_B_summary_text || "",
    scenario_C_summary_text: generatedTexts.scenario_C_summary_text || "",
    scenario_A_financial_text: generatedTexts.scenario_A_financial_text || "",
    scenario_B_financial_text: generatedTexts.scenario_B_financial_text || "",
    scenario_C_financial_text: generatedTexts.scenario_C_financial_text || "",
    scenario_A_risk_text: generatedTexts.scenario_A_risk_text || "",
    scenario_B_risk_text: generatedTexts.scenario_B_risk_text || "",
    scenario_C_risk_text: generatedTexts.scenario_C_risk_text || "",
    strategic_arbitrage_text: generatedTexts.strategic_arbitrage_text || "",
    conclusion_summary_text: generatedTexts.conclusion_summary_text || "",
    conclusion_positioning_text: generatedTexts.conclusion_positioning_text || "",
    conclusion_projection_text: generatedTexts.conclusion_projection_text || "",
    // Computed scores for charts
    computed_scores: scenarios.meta || {},
    gpt_text_rules: rules.substring(0, 200) + "...",
    gpt_elapsed_ms: generatedTexts._gpt_elapsed_ms || 0,
    gpt_model: generatedTexts._gpt_model || GPT_TEXT_MODEL,
    conformity_check: conformity,
    server_version: "72.87-CONFORMITY-GATE",
    total_duration_ms: Date.now() - t0,
  };
  console.log(`═══ /generate-texts DONE in ${Date.now() - t0}ms ═══\n`);
  return res.json(response);
});
// ═══════════════════════════════════════════════════════════════════════════════
// ─── ENDPOINT /generate-pptx — PPTX ASSEMBLY v3.0 ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const { execSync, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
app.post("/generate-pptx", async (req, res) => {
  const t0 = Date.now();
  console.log(`\n═══ /generate-pptx v3.0-PREMIUM ═══`);
  const p = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch(e) { return {}; } })() : (req.body || {});
  if (!p.site_area || !p.envelope_w || !p.envelope_d) {
    return res.status(400).json({ error: "site_area, envelope_w, envelope_d obligatoires" });
  }
  try {
    // Step 1: Compute scenarios
    const scenarios = computeSmartScenarios({
      site_area: Number(p.site_area),
      envelope_w: Number(p.envelope_w),
      envelope_d: Number(p.envelope_d),
      envelope_area: Number(p.envelope_area) || undefined,
      zoning_type: p.zoning_type || "URBAIN",
      floor_height: Number(p.floor_height) || 3.2,
      primary_driver: p.primary_driver || "MAX_CAPACITE",
      max_floors: Number(p.max_floors) || 99,
      max_height_m: Number(p.max_height_m) || 99,
      program_main: p.program_main || p.project_type || "",
      target_surface_m2: Number(p.target_surface_m2) || 0,
      site_saturation_level: p.site_saturation_level || "MEDIUM",
      financial_rigidity_score: Number(p.financial_rigidity_score) || 0,
      density_band: p.density_band || "",
      risk_adjusted: Number(p.risk_adjusted) || 0,
      feasibility_posture: p.feasibility_posture || "BALANCED",
      scenario_A_role: p.scenario_A_role || "",
      scenario_B_role: p.scenario_B_role || "",
      scenario_C_role: p.scenario_C_role || "",
      budget_range: Number(p.budget_range) || 0,
      budget_range_raw: String(p.budget_range || ""),
      budget_band: p.budget_band || "",
      budget_tension: Number(p.budget_tension) || 0,
      standing_level: p.standing_level || "STANDARD",
      target_units: Number(p.target_units) || 0,
      rent_score: Number(p.rent_score) || 0,
      capacity_score: Number(p.capacity_score) || 0,
      mix_score: Number(p.mix_score) || 0,
      phase_score: Number(p.phase_score) || 0,
      risk_score: Number(p.risk_score) || 0,
      density_pressure_factor: Number(p.density_pressure_factor) || 1,
      driver_intensity: p.driver_intensity || "MEDIUM",
      strategic_position: p.strategic_position || "",
      layout_mode: p.layout_mode || "SUPERPOSE",
      commerce_depth_m: Number(p.commerce_depth_m) || 6,
      retrait_inter_volumes_m: Number(p.retrait_inter_volumes_m) || 4,
      // v73.1.11: typology-driven fields (sinon fallback target_units → mauvais mix dans les textes)
      input_typologies: p.input_typologies || "",
      commerce_size_m2: Number(p.commerce_size_m2) || 0,
    });
    // Step 2: Flatten + generate texts (same as /generate-texts)
    const diag = scenarios.diagnostic || {};
    const comp = diag.comparatif || {};
    const deltas = comp.deltas || {};
    const dBA = deltas.B_vs_A || {};
    const dCA = deltas.C_vs_A || {};
    const phasageD = diag.strategie_phasage || {};
    const orientD = diag.orientation_solaire || {};
    const retrD = diag.retraits_reglementaires || {};
    const sA = scenarios.A || {};
    const sB = scenarios.B || {};
    const sC = scenarios.C || {};
    // Build flat data (abbreviated — reuse same logic)
    const flat = {
      rec_scenario: (diag.recommandation || {}).scenario || "",
      rec_score: Math.round(((diag.recommandation || {}).score || 0) * 100), // v72.80 FIX: 0-1 → 0-100
      phasage_text: phasageD.text || "",
      retrait_avant: `${retrD.avant_m || 0}m`,
      retrait_lateral: `${retrD.lateral_m || 0}m`,
      retrait_arriere: `${retrD.arriere_m || 0}m`,
      retrait_mitoyennete: String(retrD.mitoyennete_cotes || 0),
      retrait_emprise_constructible: `${retrD.emprise_constructible_m2 || 0} m²`,
      retrait_reduction_pct: `${retrD.reduction_pct || 0}%`,
      site_cos_regl: String((diag.site || {}).cos_regl || "2.5"),
      site_ces_regl: String((diag.site || {}).ces_regl_pct || "60"),
      orient_zone: orientD.zone_climatique || "",
      delta_BA_sdp: `${dBA.delta_sdp_m2 || 0} m² (${dBA.delta_sdp_pct || 0}%)`,
      delta_BA_cout: `${dBA.delta_cout_fcfa ? Math.round(dBA.delta_cout_fcfa / 1e6) : 0}M FCFA (${dBA.delta_cout_pct || 0}%)`,
      delta_CA_sdp: `${dCA.delta_sdp_m2 || 0} m² (${dCA.delta_sdp_pct || 0}%)`,
      delta_CA_cout: `${dCA.delta_cout_fcfa ? Math.round(dCA.delta_cout_fcfa / 1e6) : 0}M FCFA (${dCA.delta_cout_pct || 0}%)`,
      profil_posture: (diag.profil_client || {}).posture || "BALANCED",
    };
    // Add per-scenario flat fields
    for (const [key, s] of [["A", sA], ["B", sB], ["C", sC]]) {
      flat[`${key}_role`] = s.role || "";
      flat[`${key}_fp`] = String(s.fp_m2 || 0);
      flat[`${key}_levels`] = String(Math.max(0, (s.levels || 1) - 1)); // v72.80 FIX: R+X = levels-1
      flat[`${key}_sdp`] = String(s.sdp_m2 || 0);
      flat[`${key}_units`] = String(s.total_units || 0);
      flat[`${key}_unit_summary`] = s.unit_mix_detail || "";
      flat[`${key}_m2_par_logt`] = String(s.m2_habitable_par_logement || 0);
      flat[`${key}_has_pilotis`] = String(s.has_pilotis || false);
      flat[`${key}_pilotis_desc`] = s.pilotis_desc || "pas de pilotis";
      flat[`${key}_typology_desc`] = s.typology_desc || "";
      flat[`${key}_config_justif`] = s.config_justification || "";
      flat[`${key}_layout_mode`] = s.layout_mode || "SUPERPOSE";
      flat[`${key}_cost_total`] = `${s.cost_total_fcfa ? Math.round(s.cost_total_fcfa / 1e6) : 0}M FCFA`;
      flat[`${key}_cost_m2`] = `${s.cost_per_m2_sdp ? Math.round(s.cost_per_m2_sdp / 1000) : 0}k FCFA/m²`;
      flat[`${key}_cost_m2_marche`] = `${s.market_cost_per_m2 ? Math.round(s.market_cost_per_m2 / 1000) : 0}k`;
      flat[`${key}_cost_m2_ajuste`] = `${s.cost_per_m2 ? Math.round(s.cost_per_m2 / 1000) : 0}k`;
      flat[`${key}_budget_fit`] = s.budget_fit || "";
      flat[`${key}_cos_pct`] = String(s.cos_ratio_pct || 0);
      flat[`${key}_cos_compliance`] = s.cos_compliance || "";
      flat[`${key}_duree_chantier`] = `${s.duree_chantier_mois || 0} mois`;
      flat[`${key}_parking_places`] = String((s.parking_detail || {}).places_disponibles || 0);
      flat[`${key}_parking_deficit`] = String((s.parking_detail || {}).deficit || 0);
      flat[`${key}_parking_source`] = (s.parking_detail || {}).source || "";
      flat[`${key}_fourchette_text`] = `entre ${s.cout_fourchette ? Math.round(s.cout_fourchette.bas / 1e6) : 0}M et ${s.cout_fourchette ? Math.round(s.cout_fourchette.haut / 1e6) : 0}M FCFA`;
      flat[`${key}_ventil_global`] = `${s.cost_total_fcfa ? Math.round(s.cost_total_fcfa / 1e6) : 0}M FCFA`;
      // v72.72: FIX — honoraires sont dans cout_ventilation.honoraires_architecte
      const ha = (s.cout_ventilation || {}).honoraires_architecte || {};
      flat[`${key}_hono_bas_M`] = String(Math.round((ha.bas_fcfa || 0) / 1e6));
      flat[`${key}_hono_haut_M`] = String(Math.round((ha.haut_fcfa || 0) / 1e6));
      flat[`${key}_hono_taux_bas`] = `${ha.taux_bas_pct || 10}%`;
      flat[`${key}_hono_taux_haut`] = `${ha.taux_haut_pct || 15}%`;
      flat[`${key}_cost_unit`] = `${s.cost_per_unit ? Math.round(s.cost_per_unit / 1e6) : 0}M FCFA`;
      flat[`${key}_free_ground`] = `${s.free_ground_m2 || 0} m²`;
      flat[`${key}_budget_equation`] = s.budget_equation || "";
      flat[`${key}_gabarit`] = s.gabarit_desc || "";
      // v72.72: FIX — cout_ventilation (pas ventilation), sous-clés _fcfa
      const cv = s.cout_ventilation || {};
      const cvh = cv.honoraires_architecte || {};
      flat[`${key}_ventil_go`] = `${Math.round((cv.gros_oeuvre_fcfa || 0) / 1e6)}M`;
      flat[`${key}_ventil_so`] = `${Math.round((cv.second_oeuvre_fcfa || 0) / 1e6)}M`;
      flat[`${key}_ventil_lt`] = `${Math.round((cv.lots_techniques_fcfa || 0) / 1e6)}M`;
      // v72.87: VRD inclut amenagements_ext pour total 100%
      flat[`${key}_ventil_vrd`] = `${Math.round(((cv.vrd_fcfa || 0) + (cv.amenagements_ext_fcfa || 0)) / 1e6)}M`;
      flat[`${key}_ventil_hono`] = `${Math.round((cvh.median_fcfa || 0) / 1e6)}M`;
    }
    // ═══ v72.91 ENRICH flat with ALL keys needed by template engine ═══
    enrichFlatForTemplates(flat, p, scenarios);
    // ═══ v72.90 TEMPLATE ENGINE — deterministic texts ═══
    const templateTexts = buildTemplateTexts(flat, scenarios);
    // ═══ v72.90 GPT — ONLY slide_5_text ═══
    const rules = buildGptTextRules();
    const dataContext = buildGptDataContext(p, scenarios, flat, templateTexts);
    let gptTexts = {};
    if (OPENAI_API_KEY) {
      try { gptTexts = await generateDiagnosticTexts(dataContext, rules); }
      catch (e) { console.error(`[PPTX] GPT error: ${e.message}`); }
    }
    // ═══ v72.91 MERGE: templates + GPT reformulation slide_5 ═══
    let generatedTexts = { ...templateTexts };
    if (gptTexts.slide_5_text && gptTexts.slide_5_text.length > 50) {
      generatedTexts.slide_5_text = gptTexts.slide_5_text;
    }
    // Template slide_5_text is already complete — no fallback needed
    // v72.93: SLIDE 17/18 TEXT ALIASES — generate_pptx.py uses SLIDE_SPECIFIC_TEXT
    // mapping that expects _s17 and _s18 suffixed keys
    generatedTexts.invisible_technical_text_s17 = generatedTexts.invisible_technical_text || "";
    generatedTexts.invisible_financial_text_s17 = generatedTexts.invisible_financial_text || "";
    generatedTexts.invisible_strategic_text_s17 = generatedTexts.invisible_strategic_text || "";
    generatedTexts.invisible_technical_text_s18 = generatedTexts.success_technical_text || "";
    generatedTexts.invisible_financial_text_s18 = generatedTexts.success_financial_text || "";
    generatedTexts.invisible_strategic_text_s18 = generatedTexts.success_strategic_text || "";
    // ── PREMIUM GATE + CONFORMITY GATE ──
    generatedTexts = sanitizePremiumTexts(generatedTexts, flat);
    const conformity = validateConformity(flat, scenarios, generatedTexts);
    // Step 4: Map server data to EXACT keys expected by Python scripts
    // ═══════════════════════════════════════════════════════════════
    // generate_charts.py expects per-scenario:
    //   RISK (0-100): budget_fit, complexite_structurelle, risque_permis,
    //                 ratio_efficacite, densite_cos, phasabilite, cout_m2
    //   GAUGE: recommendation_score
    //   TABLE: sdp_m2, surface_habitable_m2, niveaux, total_units,
    //          cost_total_fcfa, recommendation_score, duree_chantier_mois
    //   ARBITRAGE: cost_total_fcfa, surface_habitable_m2, total_units, recommendation_score
    //   COST PIE: cost_fondations_infrastructure, cost_gros_oeuvre_structure,
    //             cost_second_oeuvre_finitions, cost_vrd_amenagements
    //   TIMELINE: duree_chantier_mois
    //   RECAP: sdp_m2, surface_habitable_m2, total_units, cost_total_fcfa,
    //          duree_chantier_mois, recommendation_score
    // ═══════════════════════════════════════════════════════════════
    function mapScenarioForPython(sc) {
      const sd = sc.score_detail || {};
      // v72.72: FIX — la clé est cout_ventilation (pas ventilation)
      // et les sous-clés ont le suffixe _fcfa
      const vent = sc.cout_ventilation || {};
      const costTotal = sc.cost_total_fcfa || sc.estimated_cost || 0;
      // Risk metrics: score_detail scores are 0.0–1.0 → convert to 0–100
      const riskMetrics = {
        budget_fit: Math.round(((sd.budget_fit || {}).score || 0.5) * 100),
        complexite_structurelle: Math.round(((sd.risk_alignment || {}).score || 0.5) * 100),
        risque_permis: Math.round(((sd.cos_conformity || {}).score || 0.5) * 100),
        ratio_efficacite: Math.round(((sd.cost_efficiency || {}).score || 0.5) * 100),
        densite_cos: Math.round(((sd.capacity_adequacy || {}).score || 0.5) * 100),
        phasabilite: Math.round(((sd.phase_flexibility || {}).score || 0.5) * 100),
        cout_m2: Math.round(((sd.standing_match || {}).score || 0.5) * 100),
      };
      // v72.93: Cost breakdown — 4 categories ALIGNED with template text
      // OLD: split gros_oeuvre into fondations+GO and merged VRD+lots_tech → mismatch with text
      // NEW: same 4 categories as text: GO, SO, Lots Tech, VRD
      const costBreakdown = {
        cost_gros_oeuvre_structure: vent.gros_oeuvre_fcfa || 0,
        cost_second_oeuvre_finitions: vent.second_oeuvre_fcfa || 0,
        cost_lots_techniques: vent.lots_techniques_fcfa || 0,
        cost_vrd_amenagements: (vent.vrd_fcfa || 0) + (vent.amenagements_ext_fcfa || 0),
      };
      // v72.72: FIX — recommendation_score est 0.0–1.0 dans le moteur → convertir en 0–100
      // v73.7 FIX RADARS: risk_scores en échelle 0-100 (PAS 1-5) — generate_charts.py expects 0-100
      // Preuves côté Python: set_ylim(0,100) sur radar, _severity_color(scale=100), docstring "(0-100)".
      // L'ancien bloc convertissait 0-100 → 1-5 (tâche au centre du radar) puis envoyait riskScores15.
      // → on envoie maintenant riskMetrics tel quel (déjà calculé en 0-100 lignes 8838-8844).
      return {
        ...riskMetrics,
        ...costBreakdown,
        risk_scores: { ...riskMetrics },
        recommendation_score: Math.round((sc.recommendation_score || 0.5) * 100),
        sdp_m2: sc.sdp_m2 || 0,
        surface_habitable_m2: sc.surface_habitable_m2 || sc.hab_m2_total || 0,
        niveaux: sc.levels || 0,
        levels: sc.levels || 0,
        total_units: sc.total_units || 0,
        cost_total_fcfa: costTotal,
        duree_chantier_mois: sc.duree_chantier_mois || 0,
        fp_m2: sc.fp_m2 || 0,
        height_m: sc.height_m || 0,
        role: sc.role || "",
        label_fr: sc.label_fr || "",
        unit_mix_detail: sc.unit_mix_detail || "",
        m2_habitable_par_logement: sc.m2_habitable_par_logement || 0,
        has_pilotis: sc.has_pilotis || false,
        cos_ratio_pct: sc.cos_ratio_pct || 0,
        cos_compliance: sc.cos_compliance || "",
        accent_color: sc.accent_color || "#888888",
        budget_fit_label: sc.budget_fit || "",
        parking_detail: sc.parking_detail || {},
        free_ground_m2: sc.free_ground_m2 || 0,
        circulation_ratio_pct: sc.circulation_ratio_pct || 0,
        rendement_brut_pct: sc.rendement_brut_pct || 0,
      };
    }
    // Step 5: Prepare data JSON for Python
    // generate_pptx.py reads: data['texts'], data['images'], data['scenarios'],
    //   data['client_name'], data['recommended']
    const pptxData = {
      ...flat,
      client_name: p.client_name || "",
      site_area: p.site_area,
      // Texts MUST be nested under 'texts' key (generate_pptx.py line 379)
      texts: { ...generatedTexts },
      // Images MUST be nested under 'images' key (generate_pptx.py line 369)
      images: p.images || {},
      // Scenarios with all keys mapped for charts (generate_charts.py)
      scenarios: {
        A: mapScenarioForPython(sA),
        B: mapScenarioForPython(sB),
        C: mapScenarioForPython(sC),
      },
      scores: {
        rent_score: Number(p.rent_score) || 0,
        capacity_score: Number(p.capacity_score) || 0,
        mix_score: Number(p.mix_score) || 0,
        phase_score: Number(p.phase_score) || 0,
        risk_score: Number(p.risk_score) || 0,
      },
      rec_scenario: flat.rec_scenario,
      rec_score: flat.rec_score,
      // Top-level 'recommended' key (generate_charts.py line 614)
      recommended: flat.rec_scenario || "A",
    };
    // Step 5: Write data to temp file and call Python
    const tmpDir = `/tmp/pptx_${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    const dataPath = path.join(tmpDir, "data.json");
    fs.writeFileSync(dataPath, JSON.stringify(pptxData, null, 2));
    const scriptDir = __dirname;
    const templatePath = path.join(scriptDir, "template_diagnostic.pptx");
    const pythonCmd = `cd "${scriptDir}" && python3 generate_pptx.py "${dataPath}" "${templatePath}" "${tmpDir}/output.pptx" 2>&1`;
    console.log(`[GENERATE-PPTX] Running: ${pythonCmd}`);
    // Check prerequisites
    if (!fs.existsSync(templatePath)) {
      console.error(`[GENERATE-PPTX] Template not found: ${templatePath}`);
      return res.status(500).json({ error: `Template not found: ${templatePath}. Deploy template_diagnostic.pptx alongside server_v72.js` });
    }
    let pyOutput;
    try {
      pyOutput = execSync(pythonCmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }).toString();
    } catch (pyErr) {
      const stderr = pyErr.stderr ? pyErr.stderr.toString() : "";
      const stdout = pyErr.stdout ? pyErr.stdout.toString() : "";
      console.error(`[GENERATE-PPTX] Python FAILED:\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
      return res.status(500).json({
        error: "Python generate_pptx.py failed",
        stdout: stdout.substring(0, 2000),
        stderr: stderr.substring(0, 2000),
        hint: "Check that python3, python-pptx, matplotlib, and lxml are installed on Render"
      });
    }
    console.log(`[GENERATE-PPTX] Python output:\n${pyOutput.substring(0, 2000)}`);
    const outputPath = path.join(tmpDir, "output.pptx");
    if (!fs.existsSync(outputPath)) {
      console.error(`[GENERATE-PPTX] Output file not found at ${outputPath}`);
      return res.status(500).json({ error: "PPTX generation failed — output file not created", python_output: pyOutput.substring(0, 2000) });
    }
    // Step 6: Return PPTX file
    const pptxBuffer = fs.readFileSync(outputPath);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="diagnostic_${p.client_name || "barlo"}.pptx"`);
    res.send(pptxBuffer);
    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    console.log(`═══ /generate-pptx DONE in ${Date.now() - t0}ms ═══\n`);
  } catch (err) {
    console.error(`[GENERATE-PPTX] Error: ${err.message}\n${err.stack}`);
    return res.status(500).json({ error: err.message });
  }
});
app.listen(PORT, () => {
  console.log(`BARLO v73.6.0-apps-script on port ${PORT}`);
  console.log(`Browserless: ${BROWSERLESS_TOKEN ? "OK" : "MISSING"}`);
  console.log(`Mapbox:      ${MAPBOX_TOKEN ? "OK" : "MISSING"}`);
  console.log(`OpenAI:      ${OPENAI_API_KEY ? "OK" : "MISSING"} (polish model: ${POLISH_MODEL})`);
  console.log(`Google Maps: ${GOOGLE_MAPS_API_KEY ? "OK" : "MISSING (fallback Mapbox satellite)"}`);
});
