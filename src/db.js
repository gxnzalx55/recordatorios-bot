// Estado en Cloudflare D1 (SQLite, consistente; gratis en el plan Free).

// --- caché genérica (token de Google) ---
export async function cacheGet(env, k) {
  const row = await env.DB.prepare('SELECT v, exp FROM cache WHERE k = ?').bind(k).first();
  if (!row || row.exp < Date.now()) return null;
  return JSON.parse(row.v);
}

export async function cacheSet(env, k, v, exp) {
  await env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)')
    .bind(k, JSON.stringify(v), exp).run();
}

// --- avisos enviados (deduplicación) ---
/** Reserva un aviso. Devuelve true si es la primera vez (hay que enviarlo). */
export async function claimAlert(env, key) {
  const r = await env.DB.prepare('INSERT OR IGNORE INTO sent (k, created) VALUES (?, ?)')
    .bind(key, Date.now()).run();
  return r.meta.changes === 1;
}

export const releaseAlert = (env, key) =>
  env.DB.prepare('DELETE FROM sent WHERE k = ?').bind(key).run();

export const cleanupSent = (env, olderThanMs) =>
  env.DB.prepare('DELETE FROM sent WHERE created < ?').bind(olderThanMs).run();

// --- borradores pendientes de confirmar ---
export async function getDraft(env, chatId) {
  const row = await env.DB.prepare('SELECT data, updated FROM drafts WHERE chat_id = ?').bind(String(chatId)).first();
  if (!row || row.updated < Date.now() - 2 * 3600 * 1000) return null;
  return JSON.parse(row.data);
}

export const saveDraft = (env, chatId, draft) =>
  env.DB.prepare('INSERT OR REPLACE INTO drafts (chat_id, data, updated) VALUES (?, ?, ?)')
    .bind(String(chatId), JSON.stringify(draft), Date.now()).run();

export const deleteDraft = (env, chatId) =>
  env.DB.prepare('DELETE FROM drafts WHERE chat_id = ?').bind(String(chatId)).run();

// --- avisos pospuestos ---
export const addSnooze = (env, eventId, fireAt) =>
  env.DB.prepare('INSERT INTO snoozes (event_id, fire_at) VALUES (?, ?)').bind(eventId, fireAt).run();

export async function dueSnoozes(env, nowMs) {
  const r = await env.DB.prepare('SELECT id, event_id, fire_at FROM snoozes WHERE fire_at <= ?').bind(nowMs).all();
  return r.results || [];
}

/** Reclama un aviso pospuesto (lo borra). true si lo hemos reclamado nosotros. */
export async function claimSnooze(env, id) {
  const r = await env.DB.prepare('DELETE FROM snoozes WHERE id = ?').bind(id).run();
  return r.meta.changes === 1;
}
