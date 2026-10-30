// Punto de entrada del Worker: webhook de Telegram, configuración y tarea cada minuto.

import { handleUpdate, runAlerts } from './bot.js';
import { listEvents } from './google.js';
import { aiProvider } from './parser.js';
import { tg } from './telegram.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

function checkSecret(url, env) {
  return env.TELEGRAM_WEBHOOK_SECRET && url.searchParams.get('secret') === env.TELEGRAM_WEBHOOK_SECRET;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Mensajes de Telegram
    if (request.method === 'POST' && url.pathname === '/telegram') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json();
      // Respondemos ya a Telegram y procesamos en segundo plano (evita reintentos si la IA tarda).
      ctx.waitUntil(handleUpdate(env, update));
      return new Response('ok');
    }

    // Registro del webhook y de los comandos: abre /setup?secret=TU_SECRETO una vez
    if (url.pathname === '/setup') {
      if (!checkSecret(url, env)) return new Response('forbidden', { status: 403 });
      const webhook = await tg(env, 'setWebhook', {
        url: `${url.origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      });
      const commands = await tg(env, 'setMyCommands', {
        commands: [
          { command: 'hoy', description: 'Recordatorios de hoy' },
          { command: 'semana', description: 'Próximos 7 días' },
          { command: 'nuevo', description: 'Formato rápido: /nuevo 15/11 10:00 -1d Texto' },
          { command: 'cancelar', description: 'Descartar el borrador' },
          { command: 'ayuda', description: 'Cómo funciona' },
        ],
      });
      return json({ webhook, commands, webhook_url: `${url.origin}/telegram` });
    }

    // Diagnóstico: comprueba la conexión con Google Calendar
    if (url.pathname === '/health') {
      if (!checkSecret(url, env)) return new Response('forbidden', { status: 403 });
      const checks = {
        telegram_token: !!env.TELEGRAM_BOT_TOKEN,
        allowed_chat_id: !!env.ALLOWED_CHAT_ID,
        ia: aiProvider(env) || 'desactivada',
        calendar_id: !!env.CALENDAR_ID,
      };
      try {
        const now = Date.now();
        const events = await listEvents(env, now, now + 7 * 24 * 3600 * 1000);
        checks.google_calendar = `ok (${events.length} eventos en 7 días)`;
      } catch (err) {
        checks.google_calendar = `ERROR: ${err.message}`;
      }
      return json(checks);
    }

    return new Response('Bot de recordatorios activo.');
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runAlerts(env));
  },
};
