const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./harness");
const { createFakeSupabase } = require("./fake-supabase");

const EXPORTS = ["wrapRouteHandler", "getSupabaseAdmin", "requireSupabase", "getLeadUnitsSupabase", "installedVersion"];

test("route qui lève une erreur synchrone : transmise au gestionnaire, pas de plantage", () => {
  const S = loadServer(EXPORTS);
  let got = null;
  const h = S.wrapRouteHandler(() => { throw new Error("boum"); });
  h({}, {}, (err) => { got = err; });
  assert.equal(got.message, "boum");
});

test("route async qui rejette : transmise au gestionnaire (plus d'unhandled rejection)", async () => {
  const S = loadServer(EXPORTS);
  let got = null;
  const h = S.wrapRouteHandler(async () => { throw new Error("async boum"); });
  await h({}, {}, (err) => { got = err; });
  await new Promise(r => setImmediate(r));
  assert.equal(got.message, "async boum");
});

test("route normale et gestionnaire d'erreurs (4 arguments) inchangés", async () => {
  const S = loadServer(EXPORTS);
  let nextCalled = false;
  const h = S.wrapRouteHandler((req, res) => { res.sent = true; });
  const res = {};
  h({}, res, () => { nextCalled = true; });
  assert.equal(res.sent, true);
  assert.equal(nextCalled, false);
  const errHandler = (err, req, res, next) => {};
  assert.equal(S.wrapRouteHandler(errHandler), errHandler);
});

test("création du client Supabase en échec (cas du 23/09) : null, jamais d'exception", () => {
  const S = loadServer(EXPORTS, { supabaseThrows: "Node.js 20 detected without native WebSocket support" });
  assert.equal(S.getSupabaseAdmin(), null);
  assert.equal(S.getLeadUnitsSupabase(), null);
  assert.throws(() => S.requireSupabase(), (e) => e.status === 503 && /Supabase indisponible/.test(e.message));
});

test("client Supabase créé une seule fois et partagé", () => {
  const fake = createFakeSupabase();
  const S = loadServer(EXPORTS, { supabase: fake.client });
  const a = S.getSupabaseAdmin();
  const b = S.getLeadUnitsSupabase();
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(S.requireSupabase(), a);
});

test("type de clé Supabase détecté sans exposer la clé", () => {
  const S = loadServer(["supabaseKeyKind"]);
  const jwt = role => ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ role })).toString("base64url"), "signature"].join(".");
  assert.equal(S.supabaseKeyKind(jwt("anon")), "anon");
  assert.equal(S.supabaseKeyKind(jwt("service_role")), "service_role");
  assert.equal(S.supabaseKeyKind("sb_secret_abc123"), "secret (serveur)");
  assert.equal(S.supabaseKeyKind("sb_publishable_abc123"), "publishable (publique)");
  assert.equal(S.supabaseKeyKind(""), "absente");
  assert.equal(S.supabaseKeyKind("n'importe quoi"), "inconnue");
});

test("version d'un paquet installé lue correctement, « ? » si absent", () => {
  const S = loadServer(EXPORTS);
  assert.equal(S.installedVersion("paquet-inexistant-barlo"), "?");
});
