// Supabase en mémoire, limité à ce qu'utilise BARLO : select/eq/maybeSingle/order et upsert.
// upsert : sur conflit, seules les colonnes fournies sont mises à jour (comportement PostgREST).
const DEFAULTS = {
  sb_scenarios: () => ({ overrides: {}, revision: 0, status: "SUGGESTED" }),
};

function createFakeSupabase() {
  const tables = {};
  const calls = { upsert: 0, select: 0 };
  function rowsOf(t) { return (tables[t] = tables[t] || []); }

  function from(table) {
    const filters = [];
    let single = false;
    const q = {
      select() { calls.select++; return q; },
      eq(col, val) { filters.push([col, val]); return q; },
      order() { return q; },
      maybeSingle() { single = true; return q; },
      insert(payload) {
        for (const row of Array.isArray(payload) ? payload : [payload]) {
          rowsOf(table).push(Object.assign((DEFAULTS[table] || (() => ({})))(), JSON.parse(JSON.stringify(row))));
        }
        return Promise.resolve({ data: null, error: null });
      },
      upsert(payload, opts) {
        calls.upsert++;
        const keys = String((opts && opts.onConflict) || "").split(",").map(s => s.trim()).filter(Boolean);
        for (const row of Array.isArray(payload) ? payload : [payload]) {
          const rows = rowsOf(table);
          const hit = rows.find(r => keys.every(k => r[k] === row[k]));
          const copy = JSON.parse(JSON.stringify(row));
          if (hit) Object.assign(hit, copy);
          else rows.push(Object.assign((DEFAULTS[table] || (() => ({})))(), copy));
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        const data = rowsOf(table).filter(r => filters.every(([c, v]) => r[c] === v)).map(r => JSON.parse(JSON.stringify(r)));
        return Promise.resolve({ data: single ? (data[0] || null) : data, error: null }).then(resolve, reject);
      },
    };
    return q;
  }
  return { client: { from }, tables, calls };
}

module.exports = { createFakeSupabase };
