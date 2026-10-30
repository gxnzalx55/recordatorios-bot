// Lógica del bot: mensajes, botones y envío de avisos.

import { DAY, HOUR, MIN, addDaysYmd, formatLead, localDateTime, localToUtc, longDate, parseYmd, shortDate, todayYmd } from './time.js';
import { dueAlerts, eventMoment, isDone } from './alerts.js';
import { createEvent, getEvent, listEvents, markDone } from './google.js';
import { addSnooze, claimAlert, claimSnooze, cleanupSent, deleteDraft, dueSnoozes, getDraft, releaseAlert, saveDraft } from './db.js';
import { answerCallback, editMessage, escapeHtml, sendMessage, typing } from './telegram.js';
import { aiProvider, interpret, normalizeDraft, parseFixed } from './parser.js';

const ALERT_WINDOW_MS = 15 * MIN; // si una ejecución se pierde, los avisos se recuperan hasta 15 min tarde

const HELP = `👋 <b>Bot de recordatorios</b>

Escríbeme lo que quieras recordar, por ejemplo:
• <i>Pagar el seguro el 15 de noviembre a las 10, avísame una semana y un día antes</i>
• <i>Mañana llamar al dentista a las 9:30</i>
• <i>Cumpleaños de Ana el 3 de diciembre</i> (día completo)

Te enseño un resumen para confirmar y lo guardo en tu calendario «Recordatorios».

<b>Comandos</b>
/hoy — lo de hoy
/semana — próximos 7 días
/nuevo — formato rápido sin IA:
<code>/nuevo 15/11 10:00 -1s -1d Pagar el seguro</code>
(avisos: -30m, -2h, -1d, -1s)
/cancelar — descarta el borrador pendiente`;

const cfg = (env) => ({ tz: env.TIMEZONE || 'Europe/Madrid', allDayHour: Number(env.ALL_DAY_HOUR || 9) });

// ---------- Formato ----------

function whenText(event, nowMs, env) {
  const { tz } = cfg(env);
  if (event.start.date) return `${shortDate(event.start.date, nowMs, tz)} · todo el día`;
  const { date, time } = localDateTime(Date.parse(event.start.dateTime), tz);
  return `${shortDate(date, nowMs, tz)}, ${time}`;
}

function alertKeyboard(eventId) {
  if (`done:${eventId}`.length > 64) return undefined; // límite de Telegram
  return [[
    { text: '✅ Hecho', callback_data: `done:${eventId}` },
    { text: '⏰ 1 h', callback_data: `s1h:${eventId}` },
    { text: '⏰ Mañana', callback_data: `s1d:${eventId}` },
  ]];
}

function alertText(event, leadMin, nowMs, env, snoozed = false) {
  const title = `<b>${escapeHtml(event.summary || '(sin título)')}</b>`;
  const when = whenText(event, nowMs, env);
  if (snoozed) return `🔁 ${title}\nPospuesto · ${when}`;
  if (leadMin <= 0) return `⏰ ${title}\n${event.start.date ? 'Hoy' : 'Es ahora'} · ${when}`;
  return `🔔 ${title}\nEn ${formatLead(leadMin)} · ${when}`;
}

function draftSummary(d) {
  const when = d.time ? `${longDate(d.date)}, ${d.time}` : `${longDate(d.date)} (todo el día)`;
  const alerts = d.alerts.map((m) => `${formatLead(m)} antes`);
  alerts.push(d.time ? 'a la hora' : 'ese día a primera hora');
  let txt = `📝 <b>${escapeHtml(d.title)}</b>\n📅 ${when}\n🔔 Avisos: ${alerts.join(', ')}`;
  if (d.dropped?.length) {
    txt += `\n⚠️ En un recordatorio de día completo no puedo avisar ${d.dropped.map((m) => `${formatLead(m)} antes`).join(', ')}; ponle hora si lo necesitas.`;
  }
  return `${txt}\n\n¿Lo creo? Si algo no está bien, escríbeme la corrección.`;
}

const draftKeyboard = (d) => [[
  { text: '✅ Crear', callback_data: `ok:${d.id}` },
  { text: '❌ Cancelar', callback_data: `no:${d.id}` },
]];

// ---------- Listados ----------

async function sendList(env, chatId, days) {
  const { tz, allDayHour } = cfg(env);
  const now = Date.now();
  const today = todayYmd(now, tz);
  const end = parseYmd(addDaysYmd(today, Math.max(1, Math.min(days, 62))));
  const endMs = localToUtc(end.y, end.m, end.d, 0, 0, tz);
  const startOfToday = parseYmd(today);
  const events = await listEvents(env, localToUtc(startOfToday.y, startOfToday.m, startOfToday.d, 0, 0, tz), endMs);

  if (!events.length) {
    return sendMessage(env, chatId, days <= 1 ? '🎉 Nada para hoy.' : `🎉 Nada en los próximos ${days} días.`);
  }
  const byDay = new Map();
  for (const ev of events) {
    const mo = eventMoment(ev, tz, allDayHour);
    const date = ev.start.date || localDateTime(mo.at, tz).date;
    const line = `${isDone(ev) ? '✅' : '•'} ${ev.start.date ? 'Todo el día' : localDateTime(mo.at, tz).time} — ${escapeHtml(ev.summary || '(sin título)')}`;
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(line);
  }
  const header = days <= 1 ? '📋 <b>Hoy</b>' : `📋 <b>Próximos ${days} días</b>`;
  const blocks = [...byDay].map(([date, lines]) => `<b>${shortDate(date, now, tz)}</b>\n${lines.join('\n')}`);
  return sendMessage(env, chatId, `${header}\n\n${blocks.join('\n\n')}`);
}

// ---------- Mensajes entrantes ----------

async function proposeDraft(env, chatId, raw) {
  const { draft, error } = normalizeDraft(raw, Date.now(), env);
  if (error) return sendMessage(env, chatId, `🤔 ${error}`);
  await saveDraft(env, chatId, draft);
  return sendMessage(env, chatId, draftSummary(draft), draftKeyboard(draft));
}

async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (!env.ALLOWED_CHAT_ID) {
    return sendMessage(env, chatId, `Tu chat ID es <code>${chatId}</code>.\nGuárdalo como secreto ALLOWED_CHAT_ID para activar el bot.`);
  }
  if (String(chatId) !== String(env.ALLOWED_CHAT_ID)) return; // ignora a cualquier otro

  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.startsWith('/') ? cmdRaw.split('@')[0].toLowerCase() : null;
  const args = rest.join(' ');

  switch (cmd) {
    case '/start':
    case '/ayuda':
    case '/help':
      return sendMessage(env, chatId, HELP);
    case '/hoy':
      return sendList(env, chatId, 1);
    case '/semana':
      return sendList(env, chatId, 7);
    case '/cancelar':
      await deleteDraft(env, chatId);
      return sendMessage(env, chatId, 'Borrador descartado.');
    case '/nuevo': {
      const parsed = parseFixed(args, Date.now(), cfg(env).tz);
      if (parsed.error) return sendMessage(env, chatId, `🤔 ${parsed.error}`);
      return proposeDraft(env, chatId, parsed);
    }
    default:
      if (cmd) return sendMessage(env, chatId, 'No conozco ese comando. Escribe /ayuda.');
  }

  if (!aiProvider(env)) {
    return sendMessage(env, chatId, 'El modo de lenguaje natural no está activado. Usa el formato rápido:\n<code>/nuevo 15/11 10:00 -1s Pagar el seguro</code>');
  }

  await typing(env, chatId);
  const draft = await getDraft(env, chatId);
  let r;
  try {
    r = await interpret(env, text, Date.now(), draft);
  } catch (err) {
    console.error('Fallo de la IA', err);
    return sendMessage(env, chatId, '🤔 No he podido interpretarlo. Prueba a escribirlo de otra forma, o usa el formato rápido:\n<code>/nuevo 15/11 10:00 -1d Pagar el seguro</code>');
  }
  switch (r.action) {
    case 'create':
      return proposeDraft(env, chatId, { title: r.title, date: r.date, time: r.time || null, alerts: r.alerts_minutes });
    case 'list':
      return sendList(env, chatId, r.list_days || 7);
    case 'help':
      return sendMessage(env, chatId, HELP);
    default:
      return sendMessage(env, chatId, `🤔 ${escapeHtml(r.message || 'No te he entendido. ¿Qué quieres recordar y cuándo?')}`);
  }
}

// ---------- Botones ----------

async function handleCallback(env, cb) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (String(chatId) !== String(env.ALLOWED_CHAT_ID)) return answerCallback(env, cb.id);

  const [action, arg] = (cb.data || '').split(/:(.*)/s);
  const original = cb.message.text ? escapeHtml(cb.message.text) : '';

  if (action === 'ok' || action === 'no') {
    const draft = await getDraft(env, chatId);
    if (!draft || draft.id !== arg) {
      await answerCallback(env, cb.id, 'Este borrador ya no está activo');
      return editMessage(env, chatId, messageId, original);
    }
    await deleteDraft(env, chatId);
    if (action === 'no') {
      await answerCallback(env, cb.id, 'Cancelado');
      return editMessage(env, chatId, messageId, `❌ <s>${escapeHtml(draft.title)}</s>`);
    }
    await createEvent(env, draft);
    await answerCallback(env, cb.id, 'Creado');
    const when = draft.time ? `${longDate(draft.date)}, ${draft.time}` : `${longDate(draft.date)} (todo el día)`;
    return editMessage(env, chatId, messageId, `✅ Guardado: <b>${escapeHtml(draft.title)}</b>\n📅 ${when}`);
  }

  const event = await getEvent(env, arg);
  if (!event || event.status === 'cancelled') {
    await answerCallback(env, cb.id, 'Ese recordatorio ya no existe');
    return editMessage(env, chatId, messageId, original);
  }

  if (action === 'done') {
    await markDone(env, event);
    await answerCallback(env, cb.id, '¡Hecho!');
    return editMessage(env, chatId, messageId, `${original}\n\n✅ Hecho`);
  }

  if (action === 's1h' || action === 's1d') {
    const { tz, allDayHour } = cfg(env);
    const now = Date.now();
    let fireAt;
    let label;
    if (action === 's1h') {
      fireAt = now + HOUR;
      label = 'dentro de 1 hora';
    } else {
      const t = parseYmd(addDaysYmd(todayYmd(now, tz), 1));
      fireAt = localToUtc(t.y, t.m, t.d, allDayHour, 0, tz);
      label = `mañana a las ${String(allDayHour).padStart(2, '0')}:00`;
    }
    await addSnooze(env, event.id, fireAt);
    await answerCallback(env, cb.id, `Te lo recuerdo ${label}`);
    return editMessage(env, chatId, messageId, `${original}\n\n⏰ Te lo recuerdo ${label}`);
  }

  return answerCallback(env, cb.id);
}

export async function handleUpdate(env, update) {
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  try {
    if (update.callback_query) return await handleCallback(env, update.callback_query);
    if (update.message?.text) return await handleMessage(env, update.message);
  } catch (err) {
    console.error(err);
    if (chatId && String(chatId) === String(env.ALLOWED_CHAT_ID)) {
      await sendMessage(env, chatId, `⚠️ Algo ha fallado: ${escapeHtml(String(err.message || err).slice(0, 300))}`).catch(() => {});
    }
  }
}

// ---------- Tarea programada (cada minuto) ----------

export async function runAlerts(env) {
  const { tz, allDayHour } = cfg(env);
  const chatId = env.ALLOWED_CHAT_ID;
  if (!chatId) return;
  const now = Date.now();

  // 1) Avisos de los eventos (hasta 4 semanas vista + margen)
  const events = await listEvents(env, now - ALERT_WINDOW_MS, now + 30 * DAY);
  for (const a of dueAlerts(events, now, ALERT_WINDOW_MS, tz, allDayHour)) {
    if (!(await claimAlert(env, a.key))) continue;
    try {
      await sendMessage(env, chatId, alertText(a.event, a.leadMin, now, env), alertKeyboard(a.event.id));
    } catch (err) {
      console.error('Fallo enviando aviso', a.key, err);
      await releaseAlert(env, a.key); // se reintentará en el siguiente minuto
    }
  }

  // 2) Avisos pospuestos
  for (const s of await dueSnoozes(env, now)) {
    if (!(await claimSnooze(env, s.id))) continue;
    const ev = await getEvent(env, s.event_id);
    if (!ev || ev.status === 'cancelled' || isDone(ev)) continue;
    await sendMessage(env, chatId, alertText(ev, 0, now, env, true), alertKeyboard(ev.id));
  }

  // 3) Limpieza una vez por hora
  if (new Date(now).getUTCMinutes() === 0) await cleanupSent(env, now - 45 * DAY);
}
