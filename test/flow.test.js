// Prueba de extremo a extremo con Telegram, Google y Claude simulados y D1 sobre SQLite local.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import worker from '../src/index.js';
import { signServiceAccountJwt } from '../src/google.js';

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      };
      return stmt;
    },
  };
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { client_email: 'bot@proyecto.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

function makeEnv() {
  return {
    DB: fakeD1(), TIMEZONE: 'Europe/Madrid', ALL_DAY_HOUR: '9', EVENT_DURATION_MIN: '30',
    CLAUDE_MODEL: 'claude-haiku-5-5', CLAUDE_EFFORT: 'low',
    TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_WEBHOOK_SECRET: 'S', ALLOWED_CHAT_ID: '42',
    CALENDAR_ID: 'cal@group.calendar.google.com', GOOGLE_SERVICE_ACCOUNT: JSON.stringify(SA), ANTHROPIC_API_KEY: 'K',
  };
}

// Simulador de servicios externos
function installFakes() {
  const state = { events: new Map(), sent: [], edits: [], claudeBodies: [], claudeReply: null, nextId: 1 };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const body = init.body && typeof init.body === 'string' && init.headers?.['content-type']?.includes('json') ? JSON.parse(init.body) : init.body;
    const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });

    if (url.host === 'api.telegram.org') {
      const method = url.pathname.split('/').pop();
      if (method === 'sendMessage') state.sent.push(body);
      if (method === 'editMessageText') state.edits.push(body);
      return ok({ ok: true, result: { message_id: 1 } });
    }
    if (url.host === 'oauth2.googleapis.com') return ok({ access_token: 'AT', expires_in: 3600 });
    if (url.host === 'www.googleapis.com') {
      assert.equal(init.headers.authorization, 'Bearer AT');
      const parts = url.pathname.split('/events');
      const id = parts[1] ? decodeURIComponent(parts[1].slice(1)) : null;
      if (init.method === 'POST') {
        const ev = { ...body, id: `ev${state.nextId++}` };
        state.events.set(ev.id, ev);
        return ok(ev);
      }
      if (init.method === 'PATCH') {
        const ev = { ...state.events.get(id), ...body };
        state.events.set(id, ev);
        return ok(ev);
      }
      if (id) return state.events.has(id) ? ok(state.events.get(id)) : new Response('', { status: 404 });
      const min = Date.parse(url.searchParams.get('timeMin'));
      const max = Date.parse(url.searchParams.get('timeMax'));
      const items = [...state.events.values()].filter((e) => {
        const s = e.start.dateTime ? Date.parse(e.start.dateTime) : Date.parse(`${e.start.date}T00:00:00+01:00`);
        const en = e.end.dateTime ? Date.parse(e.end.dateTime) : Date.parse(`${e.end.date}T00:00:00+01:00`);
        return en > min && s < max;
      });
      return ok({ items });
    }
    if (url.host === 'api.anthropic.com') {
      state.claudeBodies.push(body);
      return ok({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(state.claudeReply) }] });
    }
    throw new Error(`fetch inesperado: ${url}`);
  };
  return state;
}

async function sendUpdate(env, update) {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const res = await worker.fetch(new Request('https://bot.example.workers.dev/telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'S', 'content-type': 'application/json' }, body: JSON.stringify(update),
  }), env, ctx);
  await Promise.all(pending);
  return res;
}

async function cron(env) {
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}

const msg = (text, chat = 42) => ({ message: { chat: { id: chat }, text } });
const cb = (data) => ({ callback_query: { id: 'c', data, message: { chat: { id: 42 }, message_id: 7, text: 'texto original' } } });

test('JWT de cuenta de servicio con firma RS256 válida', async () => {
  const jwt = await signServiceAccountJwt(SA, Date.parse('2026-10-30T00:00:00Z'));
  const [h, c, s] = jwt.split('.');
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, 'base64url')));
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.iss, SA.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/calendar.events');
});

test('flujo completo: crear, avisar, hecho y posponer', async () => {
  const fakes = installFakes();
  const env = makeEnv();
  // 30/10/2026 01:10 hora de Madrid
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:10:00Z') });

  try {
    // Webhook sin secreto -> 403
    const bad = await worker.fetch(new Request('https://x/telegram', { method: 'POST', body: '{}' }), env, { waitUntil() {} });
    assert.equal(bad.status, 403);

    // Otro chat: se ignora
    await sendUpdate(env, msg('hola', 99));
    assert.equal(fakes.sent.length, 0);

    // 1) Lenguaje natural -> borrador
    fakes.claudeReply = { action: 'create', title: 'Pagar el seguro', date: '2026-11-15', time: '10:00', alerts_minutes: [10080, 1440], list_days: 0, message: '' };
    await sendUpdate(env, msg('pagar el seguro el 15 de noviembre a las 10, avísame una semana y un día antes'));
    const req = fakes.claudeBodies[0];
    assert.equal(req.model, 'claude-haiku-5-5');
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.equal(req.messages.at(-1).role, 'user'); // sin prefill
    assert.ok(!('temperature' in req));
    assert.match(req.system, /viernes 30 de octubre de 2026, 01:10/);
    const summary = fakes.sent.at(-1);
    assert.match(summary.text, /Pagar el seguro/);
    assert.match(summary.text, /1 semana antes, 1 día antes, a la hora/);
    const okData = summary.reply_markup.inline_keyboard[0][0].callback_data;

    // 2) Corrección sobre el borrador
    fakes.claudeReply = { ...fakes.claudeReply, time: '11:00' };
    await sendUpdate(env, msg('mejor a las 11'));
    assert.match(fakes.claudeBodies[1].messages[0].content, /Borrador actual:.*"time":"10:00".*Corrección del usuario: mejor a las 11/s);
    const okData2 = fakes.sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data;

    // El botón del borrador anterior ya no vale
    await sendUpdate(env, cb(okData));
    assert.equal(fakes.events.size, 0);

    // 3) Confirmar -> se crea el evento en Google
    await sendUpdate(env, cb(okData2));
    assert.equal(fakes.events.size, 1);
    const ev = fakes.events.get('ev1');
    assert.equal(ev.start.dateTime, '2026-11-15T10:00:00.000Z');
    assert.equal(ev.start.timeZone, 'Europe/Madrid');
    assert.equal(ev.end.dateTime, '2026-11-15T10:30:00.000Z');
    assert.deepEqual(ev.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 10080 }, { method: 'popup', minutes: 1440 }] });
    assert.match(fakes.edits.at(-1).text, /Guardado/);

    // 4) Aviso de 1 semana antes: 08/11 11:00 Madrid = 10:00Z
    const before = fakes.sent.length;
    mock.timers.setTime(Date.parse('2026-11-08T09:59:00Z'));
    await cron(env);
    assert.equal(fakes.sent.length, before);
    mock.timers.setTime(Date.parse('2026-11-08T10:00:30Z'));
    await cron(env);
    assert.equal(fakes.sent.length, before + 1);
    assert.match(fakes.sent.at(-1).text, /En 1 semana · dom 15 nov, 11:00/);
    mock.timers.setTime(Date.parse('2026-11-08T10:01:30Z'));
    await cron(env); // no se duplica
    assert.equal(fakes.sent.length, before + 1);

    // 5) Posponer 1 hora
    await sendUpdate(env, cb('s1h:ev1'));
    assert.match(fakes.edits.at(-1).text, /dentro de 1 hora/);
    mock.timers.setTime(Date.parse('2026-11-08T11:02:00Z'));
    await cron(env);
    assert.match(fakes.sent.at(-1).text, /Pospuesto/);
    const afterSnooze = fakes.sent.length;
    mock.timers.setTime(Date.parse('2026-11-08T11:03:00Z'));
    await cron(env);
    assert.equal(fakes.sent.length, afterSnooze);

    // 6) Hecho -> el evento se marca y deja de avisar
    await sendUpdate(env, cb('done:ev1'));
    assert.equal(fakes.events.get('ev1').extendedProperties.private.done, '1');
    assert.match(fakes.events.get('ev1').summary, /^✅ Pagar el seguro/);
    mock.timers.setTime(Date.parse('2026-11-14T10:00:30Z')); // aviso de 1 día antes
    await cron(env);
    assert.equal(fakes.sent.length, afterSnooze);

    // 7) Formato fijo, día completo, y listado
    await sendUpdate(env, msg('/nuevo 3/12 -1d Cumple de Ana'));
    const s2 = fakes.sent.at(-1);
    assert.match(s2.text, /jueves 3 de diciembre de 2026 \(todo el día\)/);
    await sendUpdate(env, cb(s2.reply_markup.inline_keyboard[0][0].callback_data));
    assert.deepEqual(fakes.events.get('ev2').start, { date: '2026-12-03' });
    assert.deepEqual(fakes.events.get('ev2').reminders.overrides, [{ method: 'popup', minutes: 900 }]);
    mock.timers.setTime(Date.parse('2026-12-02T08:00:30Z')); // 09:00 del día anterior
    await cron(env);
    assert.match(fakes.sent.at(-1).text, /En 1 día · jue 3 dic · todo el día/);

    await sendUpdate(env, msg('/semana'));
    assert.match(fakes.sent.at(-1).text, /Todo el día — Cumple de Ana/);
  } finally {
    mock.timers.reset();
  }
});

test('sin ALLOWED_CHAT_ID el bot te dice tu chat ID', async () => {
  const fakes = installFakes();
  const env = { ...makeEnv(), ALLOWED_CHAT_ID: '' };
  await sendUpdate(env, msg('/start', 12345));
  assert.match(fakes.sent.at(-1).text, /12345/);
});
