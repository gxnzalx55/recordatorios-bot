import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localToUtc, formatLead, todayYmd, localDateTime } from '../src/time.js';
import { eventAlerts, dueAlerts, toGoogleOverrides } from '../src/alerts.js';
import { parseFixed, normalizeDraft } from '../src/parser.js';

const TZ = 'Europe/Madrid';
const env = { TIMEZONE: TZ, ALL_DAY_HOUR: '9' };
// Viernes 30/10/2026 01:00 en Madrid (CET, UTC+1; el cambio de hora fue el 25/10)
const NOW = Date.parse('2026-10-30T00:00:00Z');

test('localToUtc respeta horario de invierno y verano', () => {
  assert.equal(new Date(localToUtc(2026, 11, 15, 10, 0, TZ)).toISOString(), '2026-11-15T09:00:00.000Z');
  assert.equal(new Date(localToUtc(2026, 7, 15, 10, 0, TZ)).toISOString(), '2026-07-15T08:00:00.000Z');
  // justo después del cambio de horario de marzo (29/03/2026 02:00 -> 03:00)
  assert.equal(new Date(localToUtc(2026, 3, 29, 12, 0, TZ)).toISOString(), '2026-03-29T10:00:00.000Z');
});

test('todayYmd y localDateTime', () => {
  assert.equal(todayYmd(NOW, TZ), '2026-10-30');
  assert.deepEqual(localDateTime(Date.parse('2026-11-15T09:00:00Z'), TZ), { date: '2026-11-15', time: '10:00' });
});

test('formatLead', () => {
  assert.equal(formatLead(10080), '1 semana');
  assert.equal(formatLead(20160), '2 semanas');
  assert.equal(formatLead(1440), '1 día');
  assert.equal(formatLead(120), '2 horas');
  assert.equal(formatLead(30), '30 minutos');
  assert.equal(formatLead(0), 'ahora');
});

test('avisos de un evento con hora', () => {
  const ev = {
    id: 'e1', start: { dateTime: '2026-11-15T10:00:00+01:00' },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10080 }, { method: 'popup', minutes: 1440 }] },
  };
  const a = eventAlerts(ev, TZ, 9);
  assert.deepEqual(a.map((x) => x.leadMin), [10080, 1440, 0]);
  assert.equal(new Date(a[0].fireAt).toISOString(), '2026-11-08T09:00:00.000Z');
});

test('avisos de un evento de día completo suenan a las 09:00', () => {
  const { overrides } = toGoogleOverrides([1440, 10080], true, 9);
  assert.deepEqual(overrides.map((o) => o.minutes), [900, 9540]);
  const ev = { id: 'e2', start: { date: '2026-12-03' }, reminders: { useDefault: false, overrides } };
  const a = eventAlerts(ev, TZ, 9);
  assert.deepEqual(a.map((x) => x.leadMin), [10080, 1440, 0]);
  assert.deepEqual(a.map((x) => localDateTime(x.fireAt, TZ)), [
    { date: '2026-11-26', time: '09:00' },
    { date: '2026-12-02', time: '09:00' },
    { date: '2026-12-03', time: '09:00' },
  ]);
});

test('día completo: avisos de horas imposibles se descartan', () => {
  const { overrides, dropped } = toGoogleOverrides([60, 1440], true, 9);
  assert.deepEqual(overrides.map((o) => o.minutes), [900]);
  assert.deepEqual(dropped, [60]);
});

test('eventos hechos o cancelados no avisan', () => {
  assert.deepEqual(eventAlerts({ id: 'x', status: 'cancelled', start: { dateTime: '2026-11-01T10:00:00Z' } }, TZ, 9), []);
  assert.deepEqual(eventAlerts({ id: 'x', start: { dateTime: '2026-11-01T10:00:00Z' }, extendedProperties: { private: { done: '1' } } }, TZ, 9), []);
});

test('dueAlerts usa una ventana de recuperación', () => {
  const ev = { id: 'e3', start: { dateTime: '2026-10-30T01:00:00+01:00' }, reminders: { useDefault: true } };
  assert.equal(dueAlerts([ev], NOW, 15 * 60000, TZ, 9).length, 1);
  assert.equal(dueAlerts([ev], NOW - 60000, 15 * 60000, TZ, 9).length, 0); // aún no
  assert.equal(dueAlerts([ev], NOW + 20 * 60000, 15 * 60000, TZ, 9).length, 0); // demasiado tarde
});

test('parseFixed', () => {
  assert.deepEqual(parseFixed('15/11 10:00 -1s -1d Pagar el seguro', NOW, TZ),
    { title: 'Pagar el seguro', date: '2026-11-15', time: '10:00', alerts: [10080, 1440] });
  assert.deepEqual(parseFixed('mañana 9h Llamar -30m al dentista', NOW, TZ),
    { title: 'Llamar al dentista', date: '2026-10-31', time: '09:00', alerts: [30] });
  // fecha ya pasada este año -> año siguiente
  assert.equal(parseFixed('3/1 Reyes', NOW, TZ).date, '2027-01-03');
  assert.equal(parseFixed('3/12 Cumple de Ana', NOW, TZ).time, null);
  assert.ok(parseFixed('31/02 Nada', NOW, TZ).error);
  assert.ok(parseFixed('15/11 10:00', NOW, TZ).error);
});

test('normalizeDraft valida fechas y avisos', () => {
  const ok = normalizeDraft({ title: ' Pagar ', date: '2026-11-15', time: '10:00', alerts: [1440, 10080, 1440, -5, 99999] }, NOW, env);
  assert.equal(ok.draft.title, 'Pagar');
  assert.deepEqual(ok.draft.alerts, [10080, 1440]);
  assert.equal(new Date(ok.draft.startMs).toISOString(), '2026-11-15T09:00:00.000Z');
  assert.ok(normalizeDraft({ title: 'x', date: '2026-10-01', time: '10:00', alerts: [] }, NOW, env).error);
  assert.ok(normalizeDraft({ title: 'x', date: '2026-13-01', time: '', alerts: [] }, NOW, env).error);
  // hoy, día completo: válido aunque sean las 01:00
  assert.ok(normalizeDraft({ title: 'x', date: '2026-10-30', time: '', alerts: [] }, NOW, env).draft);
});
