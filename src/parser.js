// Interpretación de mensajes: formato fijo (/nuevo) y lenguaje natural con Claude.

import {
  MIN, addDaysYmd, describeNow, localToUtc, parseHm, parseYmd, pad, todayYmd, upcomingDays, ymd,
} from './time.js';
import { MAX_GOOGLE_REMINDER_MIN, toGoogleOverrides } from './alerts.js';

const UNIT_MIN = { m: 1, h: 60, d: 1440, s: 10080, w: 10080 };

/**
 * Formato fijo:
 *   /nuevo 15/11 10:00 -1s -1d Pagar el seguro
 *   /nuevo mañana 9:30 -1h Llamar al dentista
 *   /nuevo 3/12/2027 Renovar el DNI        (día completo)
 * Avisos: -30m (minutos), -2h (horas), -1d (días), -1s (semanas).
 */
export function parseFixed(input, nowMs, tz) {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { error: 'Falta la fecha. Ejemplo: /nuevo 15/11 10:00 -1s Pagar el seguro' };

  const today = todayYmd(nowMs, tz);
  let date;
  const first = tokens.shift().toLowerCase();
  if (first === 'hoy') date = today;
  else if (first === 'mañana' || first === 'manana') date = addDaysYmd(today, 1);
  else {
    const m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(first);
    if (!m) return { error: `No entiendo la fecha «${first}». Usa dd/mm, dd/mm/aaaa, hoy o mañana.` };
    const d = +m[1], mo = +m[2];
    let y = m[3] ? +m[3] : +today.slice(0, 4);
    if (m[3] && m[3].length === 2) y += 2000;
    date = ymd(y, mo, d);
    if (!parseYmd(date)) return { error: `La fecha ${first} no existe.` };
    if (!m[3] && date < today) date = ymd(y + 1, mo, d);
  }

  let time = null;
  if (tokens.length) {
    const t = /^(\d{1,2})(?::(\d{2})|h)$/i.exec(tokens[0]);
    if (t) {
      time = `${pad(+t[1])}:${t[2] || '00'}`;
      if (!parseHm(time)) return { error: `La hora ${tokens[0]} no es válida.` };
      tokens.shift();
    }
  }

  const alerts = [];
  const titleParts = [];
  for (const tok of tokens) {
    const a = /^-(\d+)([mhdsw])$/i.exec(tok);
    if (a) alerts.push(+a[1] * UNIT_MIN[a[2].toLowerCase()]);
    else titleParts.push(tok);
  }
  const title = titleParts.join(' ').trim();
  if (!title) return { error: 'Falta el texto del recordatorio.' };
  return { title, date, time, alerts };
}

/** Valida y completa un borrador. Devuelve { draft } o { error }. */
export function normalizeDraft(raw, nowMs, env) {
  const tz = env.TIMEZONE;
  const allDayHour = Number(env.ALL_DAY_HOUR || 9);
  const title = String(raw.title || '').trim().slice(0, 200);
  if (!title) return { error: 'Falta el texto del recordatorio.' };
  const date = parseYmd(raw.date);
  if (!date) return { error: 'No he entendido la fecha.' };
  const time = raw.time ? parseHm(raw.time) : null;
  if (raw.time && !time) return { error: 'No he entendido la hora.' };

  const hh = time ? time.h : allDayHour;
  const mm = time ? time.m : 0;
  const startMs = localToUtc(date.y, date.m, date.d, hh, mm, tz);
  if (time ? startMs < nowMs - MIN : raw.date < todayYmd(nowMs, tz)) {
    return { error: 'Esa fecha ya ha pasado.' };
  }

  const alerts = [...new Set((raw.alerts || []).map(Number))]
    .filter((m) => Number.isInteger(m) && m > 0 && m <= MAX_GOOGLE_REMINDER_MIN)
    .sort((a, b) => b - a)
    .slice(0, 5);
  const { overrides, dropped } = toGoogleOverrides(alerts, !time, allDayHour);

  return {
    draft: {
      id: crypto.randomUUID().slice(0, 8),
      title,
      date: raw.date,
      time: time ? `${pad(time.h)}:${pad(time.m)}` : null,
      startMs,
      alerts: alerts.filter((m) => !dropped.includes(m)),
      dropped,
      overrides,
    },
  };
}

// ---------- Lenguaje natural con Claude ----------

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['create', 'list', 'help', 'unclear'] },
    title: { type: 'string', description: 'Texto breve del recordatorio, sin la fecha ni los avisos' },
    date: { type: 'string', description: 'Fecha YYYY-MM-DD, o vacío si no aplica' },
    time: { type: 'string', description: 'Hora HH:MM en 24h, o vacío si es de día completo' },
    alerts_minutes: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Avisos previos en minutos antes del evento (sin incluir el aviso a la hora)',
    },
    list_days: { type: 'integer', description: 'Para action=list: cuántos días hacia delante mostrar' },
    message: { type: 'string', description: 'Para action=unclear: pregunta breve al usuario en español' },
  },
  required: ['action', 'title', 'date', 'time', 'alerts_minutes', 'list_days', 'message'],
  additionalProperties: false,
};

function systemPrompt(nowMs, tz) {
  return `Eres el intérprete de un bot personal de recordatorios en Telegram. Conviertes cada mensaje del usuario (en español) en una acción estructurada.

Ahora mismo es ${describeNow(nowMs, tz)} (zona horaria ${tz}).
Próximos días:
${upcomingDays(nowMs, tz, 15)}

Acciones:
- "create": el usuario quiere crear un recordatorio. Rellena title, date y time.
  · title: breve y claro, con mayúscula inicial, sin la fecha, la hora ni los avisos.
  · date: YYYY-MM-DD. Resuelve fechas relativas ("mañana", "el jueves", "dentro de 3 días", "el 15") usando la lista de días. Si la fecha sin año ya pasó este año, usa el año siguiente.
  · time: HH:MM en 24h ("a las 5 de la tarde" = 17:00, "por la mañana" = 09:00, "a mediodía" = 12:00, "por la noche" = 21:00). Vacío si no se menciona hora (recordatorio de día completo).
  · alerts_minutes: avisos previos que pida el usuario, en minutos antes: 1 semana = 10080, 1 día = 1440, 2 horas = 120, 30 minutos = 30. El aviso a la hora exacta se envía siempre: no lo incluyas. Si no pide avisos previos, array vacío. Máximo 5, cada uno ≤ 40320.
- "list": quiere ver sus recordatorios ("qué tengo hoy", "esta semana", "próximos días"). list_days: hoy = 1, mañana = 2, esta semana = 7, este mes = 31; por defecto 7.
- "help": saluda o pregunta cómo funciona el bot.
- "unclear": falta información imprescindible (qué recordar o cuándo) o no tiene que ver con recordatorios. message: pregunta breve en español para aclararlo.

Si recibes un borrador y una corrección, aplica la corrección al borrador y devuelve "create" con todos los campos actualizados.
Rellena siempre todos los campos; usa "" o 0 o [] en los que no apliquen.`;
}

export async function interpretWithClaude(env, text, nowMs, draft) {
  const content = draft
    ? `Borrador actual: ${JSON.stringify({
      title: draft.title, date: draft.date, time: draft.time || '', alerts_minutes: draft.alerts,
    })}\nCorrección del usuario: ${text}`
    : text;

  const outputConfig = { format: { type: 'json_schema', schema: SCHEMA } };
  if (env.CLAUDE_EFFORT) outputConfig.effort = env.CLAUDE_EFFORT;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || 'claude-haiku-5-5',
      max_tokens: 2000,
      system: systemPrompt(nowMs, env.TIMEZONE),
      messages: [{ role: 'user', content }],
      output_config: outputConfig,
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (data.stop_reason === 'refusal') return { action: 'unclear', message: 'No puedo ayudarte con eso.' };
  const block = (data.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('Claude no devolvió texto');
  return JSON.parse(block.text);
}
