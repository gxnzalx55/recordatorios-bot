// Utilidades de fecha/hora con zona horaria (sin dependencias).

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const WD_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const EN_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Componentes de fecha/hora locales en `tz` para un instante (ms). */
export function zonedParts(ms, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(ms))) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: EN_WD.indexOf(p.weekday),
  };
}

function tzOffset(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Instante (ms UTC) de una fecha/hora local en `tz`. Gestiona el cambio de horario. */
export function localToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

export const pad = (n) => String(n).padStart(2, '0');

export function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

export function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return { h, m: mi };
}

export const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function addDaysYmd(s, n) {
  const { y, m, d } = parseYmd(s);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function todayYmd(nowMs, tz) {
  const p = zonedParts(nowMs, tz);
  return ymd(p.year, p.month, p.day);
}

function weekdayOfYmd(s) {
  const { y, m, d } = parseYmd(s);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "sáb 15 nov" (+ año si no es el actual) */
export function shortDate(s, nowMs, tz) {
  const { y, m, d } = parseYmd(s);
  const thisYear = zonedParts(nowMs, tz).year;
  return `${WD_SHORT[weekdayOfYmd(s)]} ${d} ${MONTHS_SHORT[m - 1]}${y !== thisYear ? ` ${y}` : ''}`;
}

/** "sábado 15 de noviembre de 2026" */
export function longDate(s) {
  const { y, m, d } = parseYmd(s);
  return `${WEEKDAYS[weekdayOfYmd(s)]} ${d} de ${MONTHS[m - 1]} de ${y}`;
}

/** Texto para el prompt: fecha y hora actuales en lenguaje natural. */
export function describeNow(nowMs, tz) {
  const p = zonedParts(nowMs, tz);
  return `${longDate(ymd(p.year, p.month, p.day))}, ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Calendario de los próximos `n` días para ayudar a resolver fechas relativas. */
export function upcomingDays(nowMs, tz, n = 14) {
  const today = todayYmd(nowMs, tz);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = addDaysYmd(today, i);
    out.push(`${s} = ${WEEKDAYS[weekdayOfYmd(s)]}`);
  }
  return out.join('\n');
}

/** Fecha/hora local de un instante: { date: 'YYYY-MM-DD', time: 'HH:MM' } */
export function localDateTime(ms, tz) {
  const p = zonedParts(ms, tz);
  return { date: ymd(p.year, p.month, p.day), time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** "1 semana", "2 días", "3 horas", "30 minutos" */
export function formatLead(minutes) {
  const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  if (minutes <= 0) return 'ahora';
  if (minutes % 10080 === 0) return plural(minutes / 10080, 'semana', 'semanas');
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'día', 'días');
  if (minutes >= 2880) return plural(Math.round(minutes / 1440), 'día', 'días');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hora', 'horas');
  if (minutes > 120) return plural(Math.round(minutes / 60), 'hora', 'horas');
  return plural(minutes, 'minuto', 'minutos');
}
