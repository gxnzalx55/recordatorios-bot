// Acceso a Google Calendar con una cuenta de servicio (JWT firmado con WebCrypto).

import { DAY, MIN } from './time.js';
import { cacheGet, cacheSet } from './db.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const API = 'https://www.googleapis.com/calendar/v3';
const EVENT_FIELDS = 'id,status,summary,start,end,reminders,extendedProperties';

let memToken = null;

const enc = new TextEncoder();

function b64url(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function signServiceAccountJwt(sa, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600,
  }));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

async function getAccessToken(env) {
  const now = Date.now();
  if (memToken && memToken.exp > now + MIN) return memToken.token;
  const cached = await cacheGet(env, 'google_token');
  if (cached && cached.exp > now + MIN) {
    memToken = cached;
    return cached.token;
  }
  let sa;
  try {
    sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT no es un JSON válido');
  }
  const assertion = await signServiceAccountJwt(sa, now);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Google token ${res.status}: ${await res.text()}`);
  const j = await res.json();
  memToken = { token: j.access_token, exp: now + j.expires_in * 1000 };
  await cacheSet(env, 'google_token', memToken, memToken.exp);
  return memToken.token;
}

async function gcal(env, path, { method = 'GET', query, body } = {}) {
  const token = await getAccessToken(env);
  const url = new URL(`${API}/calendars/${encodeURIComponent(env.CALENDAR_ID)}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`Google Calendar ${res.status}: ${await res.text()}`);
  return res.status === 204 ? {} : res.json();
}

/** Eventos (instancias expandidas) que terminan después de fromMs y empiezan antes de toMs. */
export async function listEvents(env, fromMs, toMs) {
  const items = [];
  let pageToken;
  do {
    const query = {
      timeMin: new Date(fromMs).toISOString(),
      timeMax: new Date(toMs).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      fields: `nextPageToken,items(${EVENT_FIELDS})`,
    };
    if (pageToken) query.pageToken = pageToken;
    const j = await gcal(env, '/events', { query });
    if (!j) throw new Error('Calendario no encontrado: revisa CALENDAR_ID y que esté compartido con la cuenta de servicio');
    items.push(...(j.items || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return items;
}

export const getEvent = (env, id) =>
  gcal(env, `/events/${encodeURIComponent(id)}`, { query: { fields: EVENT_FIELDS } });

export const patchEvent = (env, id, patch) =>
  gcal(env, `/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, query: { fields: EVENT_FIELDS } });

/**
 * Crea un evento a partir de un borrador normalizado.
 * draft: { title, date, time|null, startMs, overrides }
 */
export function createEvent(env, draft) {
  const tz = env.TIMEZONE;
  const durMin = Number(env.EVENT_DURATION_MIN || 30);
  const body = {
    summary: draft.title,
    reminders: { useDefault: false, overrides: draft.overrides },
    extendedProperties: { private: { source: 'telegram-bot' } },
  };
  if (draft.time) {
    body.start = { dateTime: new Date(draft.startMs).toISOString(), timeZone: tz };
    body.end = { dateTime: new Date(draft.startMs + durMin * MIN).toISOString(), timeZone: tz };
  } else {
    const [y, m, d] = draft.date.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d) + DAY).toISOString().slice(0, 10);
    body.start = { date: draft.date };
    body.end = { date: next };
  }
  return gcal(env, '/events', { method: 'POST', body, query: { fields: EVENT_FIELDS } });
}

export function markDone(env, event) {
  const summary = event.summary?.startsWith('✅') ? event.summary : `✅ ${event.summary || ''}`;
  return patchEvent(env, event.id, {
    summary,
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { ...(event.extendedProperties?.private || {}), done: '1' } },
  });
}
