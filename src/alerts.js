// Cálculo de avisos a partir de eventos de Google Calendar.
//
// Convención:
// - Eventos con hora: cada aviso de Google ("X minutos antes") se dispara en inicio - X.
// - Eventos de día completo: Google mide los minutos desde la medianoche del día.
//   Tratamos el "momento" del evento como las ALL_DAY_HOUR (p. ej. 09:00), así que
//   "1 día antes" se guarda como 1440 - 540 = 900 minutos y suena a las 09:00 del día anterior.
// - Siempre hay además un aviso "a la hora" (momento del evento).

import { localToUtc, parseYmd, MIN } from './time.js';

export const MAX_GOOGLE_REMINDER_MIN = 40320; // límite de Google: 4 semanas

export function isDone(event) {
  return event?.extendedProperties?.private?.done === '1';
}

/** Momento del evento (ms) y medianoche (para día completo). */
export function eventMoment(event, tz, allDayHour) {
  if (event.start?.date) {
    const { y, m, d } = parseYmd(event.start.date);
    return {
      allDay: true,
      at: localToUtc(y, m, d, allDayHour, 0, tz),
      midnight: localToUtc(y, m, d, 0, 0, tz),
    };
  }
  return { allDay: false, at: Date.parse(event.start.dateTime) };
}

/** Lista de avisos de un evento: [{ key, fireAt, leadMin }] */
export function eventAlerts(event, tz, allDayHour) {
  if (!event?.start || event.status === 'cancelled' || isDone(event)) return [];
  const mo = eventMoment(event, tz, allDayHour);
  const base = mo.allDay ? mo.midnight : mo.at;
  const overrides = event.reminders?.useDefault === false ? (event.reminders.overrides || []) : [];

  const fireTimes = new Set([mo.at]);
  for (const o of overrides) {
    const fireAt = base - o.minutes * MIN;
    if (fireAt < mo.at) fireTimes.add(fireAt);
  }
  return [...fireTimes]
    .sort((a, b) => a - b)
    .map((fireAt) => ({
      key: `${event.id}@${fireAt}`,
      fireAt,
      leadMin: Math.round((mo.at - fireAt) / MIN),
    }));
}

/** Avisos que deben enviarse ahora: los que vencieron dentro de la ventana. */
export function dueAlerts(events, nowMs, windowMs, tz, allDayHour) {
  const out = [];
  for (const ev of events) {
    for (const a of eventAlerts(ev, tz, allDayHour)) {
      if (a.fireAt <= nowMs && a.fireAt > nowMs - windowMs) out.push({ event: ev, ...a });
    }
  }
  return out;
}

/**
 * Convierte avisos "X minutos antes del momento del evento" al formato de Google.
 * Devuelve { overrides, dropped } (dropped = avisos imposibles en día completo).
 */
export function toGoogleOverrides(alertMinutes, allDay, allDayHour) {
  const overrides = [];
  const dropped = [];
  for (const m of alertMinutes) {
    const g = allDay ? m - allDayHour * 60 : m;
    if (g > 0 && g <= MAX_GOOGLE_REMINDER_MIN) overrides.push({ method: 'popup', minutes: g });
    else dropped.push(m);
  }
  return { overrides: overrides.slice(0, 5), dropped };
}
