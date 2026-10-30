# Bot de recordatorios (Telegram + Google Calendar)

Escribes a tu bot de Telegram lo que quieres recordar, lo guarda como evento en un calendario «Recordatorios» de Google y te avisa por Telegram a la hora y con la antelación que pidas.

```
Tú:   pagar el seguro el 15 de noviembre a las 10, avísame una semana y un día antes
Bot:  📝 Pagar el seguro
      📅 domingo 15 de noviembre de 2026, 10:00
      🔔 Avisos: 1 semana antes, 1 día antes, a la hora
      [✅ Crear] [❌ Cancelar]
...
Bot:  🔔 Pagar el seguro
      En 1 semana · dom 15 nov, 10:00
      [✅ Hecho] [⏰ 1 h] [⏰ Mañana]
```

**Cómo funciona:** un Cloudflare Worker (gratis) recibe tus mensajes, usa Claude Haiku para entenderlos, crea el evento en Google Calendar y cada minuto revisa qué avisos tocan. El estado mínimo (avisos ya enviados, borradores, pospuestos) vive en una base de datos D1, también gratuita.

**Coste:** 0 €/mes de infraestructura + céntimos al año de IA (opcional: sin clave de Anthropic funciona el formato rápido `/nuevo`).

---

## Montaje paso a paso (unos 30–40 minutos)

Necesitas: [Node.js 20 o superior](https://nodejs.org), una cuenta gratuita de [Cloudflare](https://dash.cloudflare.com/sign-up), tu cuenta de Google y Telegram.

### 1. Crea el bot en Telegram

1. En Telegram, abre **@BotFather** y envía `/newbot`.
2. Elige un nombre y un usuario (tiene que acabar en `bot`).
3. Guarda el **token** que te da (algo como `123456:ABC-...`).

### 2. Prepara Google Calendar

**2.1 Crea el calendario.** En [Google Calendar](https://calendar.google.com) (web) → ⚙️ Configuración → *Añadir calendario* → *Crear calendario* → nómbralo «Recordatorios».

**2.2 Crea una cuenta de servicio** (es una «cuenta robot» que solo verá ese calendario):

1. Entra en [console.cloud.google.com](https://console.cloud.google.com) y crea un proyecto nuevo (p. ej. «recordatorios»). No hace falta activar facturación.
2. Menú → *APIs y servicios* → *Biblioteca* → busca **Google Calendar API** → *Habilitar*.
3. Menú → *IAM y administración* → *Cuentas de servicio* → *Crear cuenta de servicio*. Ponle un nombre, y *Listo* (no necesita roles).
4. Entra en la cuenta creada → pestaña *Claves* → *Agregar clave* → *Crear clave nueva* → **JSON**. Se descarga un archivo: guárdalo como `clave.json` en la carpeta del proyecto. **No lo compartas ni lo subas a ningún repositorio.**
5. Copia el email de la cuenta de servicio (termina en `iam.gserviceaccount.com`).

**2.3 Comparte el calendario con la cuenta de servicio.** En Google Calendar → Configuración del calendario «Recordatorios» → *Compartir con determinadas personas* → añade el email del paso anterior con permiso **«Hacer cambios en eventos»**.

**2.4 Copia el ID del calendario.** En esa misma página, sección *Integrar el calendario* → **ID de calendario** (algo como `abc123...@group.calendar.google.com`).

### 3. Clave de Anthropic (opcional, para el lenguaje natural)

En [console.anthropic.com](https://console.anthropic.com) crea una API key y añade un poco de saldo. Cada mensaje cuesta en torno a una diezmilésima de dólar.

### 4. Despliega en Cloudflare

Abre una terminal en la carpeta del proyecto:

```bash
npm install
npx wrangler login                       # abre el navegador para autorizar
npx wrangler d1 create recordatorios     # crea la base de datos
```

El último comando muestra un `database_id`. Ábrelo en `wrangler.toml` y sustituye `PEGA_AQUI_EL_ID_DE_D1` por ese valor. Luego:

```bash
npm run db:init      # crea las tablas
npm run deploy       # publica el Worker
```

`deploy` te muestra la URL del bot, del estilo `https://recordatorios-bot.TU-SUBDOMINIO.workers.dev`. Ahora configura los secretos (cada comando te pide el valor):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN        # el token de BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # invéntate uno largo: solo letras, números, _ y -
npx wrangler secret put CALENDAR_ID               # el ID del paso 2.4
npx wrangler secret put ANTHROPIC_API_KEY         # opcional
```

La clave de Google se carga desde el archivo:

```bash
# macOS / Linux
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT < clave.json

# Windows (PowerShell)
Get-Content clave.json -Raw | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT
```

Después puedes borrar `clave.json` de la carpeta (guárdala en un sitio seguro por si la necesitas).

### 5. Conecta Telegram con el Worker

Abre en el navegador (cambiando la URL y tu secreto):

```
https://recordatorios-bot.TU-SUBDOMINIO.workers.dev/setup?secret=TU_SECRETO
```

Debe responder con `"webhook": true`.

### 6. Vincula tu chat

1. Escribe `/start` a tu bot. Te responderá con tu **chat ID**.
2. Guárdalo: `npx wrangler secret put ALLOWED_CHAT_ID`
3. Escribe `/start` otra vez: ya debería saludarte con la ayuda.

El bot ignora a cualquier otra persona que le escriba.

### 7. Comprueba que todo funciona

```
https://recordatorios-bot.TU-SUBDOMINIO.workers.dev/health?secret=TU_SECRETO
```

Debe mostrar `"google_calendar": "ok (...)"`. Prueba a crear un recordatorio para dentro de 3 minutos y espera el aviso.

---

## Uso

| Escribes | Qué pasa |
|---|---|
| Texto libre (*«mañana a las 9 llamar al dentista, avísame 1 hora antes»*) | Te propone el recordatorio; confirmas con ✅ |
| Una corrección mientras hay un borrador (*«mejor a las 10»*) | Actualiza el borrador |
| *«¿qué tengo esta semana?»*, `/semana`, `/hoy` | Lista tus recordatorios |
| `/nuevo 15/11 10:00 -1s -1d Pagar el seguro` | Formato rápido sin IA. Avisos: `-30m`, `-2h`, `-1d`, `-1s`. Sin hora = día completo |
| `/cancelar` | Descarta el borrador pendiente |

En cada aviso: **✅ Hecho** (marca el evento con ✅ y deja de avisar), **⏰ 1 h** y **⏰ Mañana** (te lo vuelve a recordar; no mueve el evento).

**Detalles útiles:**
- Los recordatorios de **día completo** suenan a las 09:00 (configurable con `ALL_DAY_HOUR` en `wrangler.toml`). En ellos solo caben avisos de días o semanas antes.
- Google permite **hasta 5 avisos** por evento y como máximo **4 semanas** de antelación.
- Los eventos que crees a mano en el calendario «Recordatorios» también te avisarán por Telegram: a la hora siempre, y con antelación si les pones notificaciones.
- Google Calendar puede enviarte además sus propias notificaciones. Si solo quieres las de Telegram, desactívalas para ese calendario en la app de Google Calendar.

## Mantenimiento

- **Ver qué está pasando:** `npm run logs` muestra los registros en directo.
- **Cambiar ajustes** (zona horaria, hora de día completo, modelo): edita `[vars]` en `wrangler.toml` y `npm run deploy`.
- **Tests:** `npm test` ejecuta las pruebas (zonas horarias, avisos, formato rápido y un flujo completo simulado).

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| `/health` dice «Calendario no encontrado» | El `CALENDAR_ID` está mal o no compartiste el calendario con la cuenta de servicio (paso 2.3). |
| `/health` dice `Google token 400` | El secreto `GOOGLE_SERVICE_ACCOUNT` no es el JSON completo. Vuelve a cargarlo desde el archivo. |
| El bot no contesta | Repite el paso 5 y revisa `npm run logs`. Si no configuraste `ALLOWED_CHAT_ID`, solo responde con tu chat ID. |
| «Claude 400» al escribir texto libre | Prueba a dejar `CLAUDE_EFFORT = ""` en `wrangler.toml` y vuelve a desplegar. Mientras tanto, `/nuevo` sigue funcionando. |
| Un aviso no llegó | Si Cloudflare se salta ejecuciones, el bot recupera avisos con hasta 15 minutos de retraso; más allá se pierden. |

## Límites del plan gratuito

Con un uso personal quedas muy por debajo de todos: el Worker hace ~1.500 ejecuciones al día (límite 100.000), una consulta a Google por minuto, y unas pocas escrituras en D1 por aviso. Solo usa 1 de las 5 tareas programadas gratuitas de tu cuenta de Cloudflare.

## Estructura

```
src/index.js     Entrada del Worker: webhook, /setup, /health y tarea cada minuto
src/bot.js       Lógica del bot: mensajes, botones, listados y envío de avisos
src/parser.js    Formato rápido /nuevo y lenguaje natural con Claude
src/alerts.js    Cálculo de cuándo toca cada aviso
src/google.js    Google Calendar con cuenta de servicio (JWT con WebCrypto)
src/telegram.js  Cliente mínimo de Telegram
src/db.js        Estado en D1
src/time.js      Zonas horarias y formato de fechas en español
schema.sql       Tablas de D1
test/            Pruebas
```
