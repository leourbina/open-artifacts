/**
 * Prepared statements, once per D1 binding and SQL text (per isolate). A D1
 * statement is immutable: bind() returns a new bound copy, so sharing the
 * unbound one across requests is safe. Only statements are cached, never rows.
 */
const cache = new WeakMap<D1Database, Map<string, D1PreparedStatement>>();

export function stmt(db: D1Database, sql: string): D1PreparedStatement {
  let m = cache.get(db);
  if (!m) {
    m = new Map();
    cache.set(db, m);
  }
  let s = m.get(sql);
  if (!s) {
    s = db.prepare(sql);
    m.set(sql, s);
  }
  return s;
}
