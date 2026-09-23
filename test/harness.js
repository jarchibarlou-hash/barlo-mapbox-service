// Charge server.js dans un bac à sable (dépendances lourdes remplacées par des bouchons)
// et expose ses fonctions internes pour les tests. Aucun serveur n'est lancé.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function makeStubs(opts) {
  const noop = () => {};
  const fakeApp = new Proxy({}, { get: (_, k) => (k === "listen" ? () => ({ close: noop }) : noop) });
  const express = Object.assign(() => fakeApp, { json: () => noop, static: () => noop, urlencoded: () => noop });
  const supabaseClient = (opts && opts.supabase) || null;
  return {
    express,
    "puppeteer-core": {},
    "@supabase/supabase-js": { createClient: () => supabaseClient },
    canvas: { createCanvas: () => ({ getContext: () => ({}) }), loadImage: async () => ({}) },
    "form-data": class FormData { append() {} },
    "node-fetch": async () => { throw new Error("réseau désactivé dans les tests"); },
    "@turf/turf": new Proxy({}, { get: () => () => { throw new Error("turf non disponible dans les tests"); } }),
  };
}

// opts.supabase : faux client Supabase (active aussi SUPABASE_URL / clé factices)
function loadServer(exportNames, opts) {
  const file = path.join(__dirname, "..", "server.js");
  const src = fs.readFileSync(file, "utf8");
  const stubs = makeStubs(opts);
  const sandboxModule = { exports: {} };
  const localRequire = (name) => {
    if (stubs[name]) return stubs[name];
    if (name.startsWith("./") || name.startsWith("../")) return require(path.join(__dirname, "..", name));
    return require(name);
  };
  const exportLine = `\n;module.exports = { ${exportNames.map(n => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(", ")} };\n`;
  const wrapper = `(function (require, module, exports, __filename, __dirname, process, console) {${src}${exportLine}})`;
  const fn = vm.runInThisContext(wrapper, { filename: file });
  const quietConsole = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  const env = Object.assign({}, process.env, { PORT: "0" },
    opts && opts.supabase ? { SUPABASE_URL: "http://fake", SUPABASE_SERVICE_ROLE_KEY: "fake" } : {});
  fn(localRequire, sandboxModule, sandboxModule.exports, file, path.dirname(file),
     Object.assign(Object.create(process), { env }), process.env.BARLO_TEST_VERBOSE ? console : quietConsole);
  return sandboxModule.exports;
}

module.exports = { loadServer };
