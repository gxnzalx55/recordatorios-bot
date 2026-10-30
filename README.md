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

El bot se ejecuta entero en Cloudflare: una vez montado, tu ordenador puede estar apagado.

**Coste:** 0 €/mes de infraestructura. La IA es opcional y cuesta unos 0,0003 $ por mensaje interpretado: con 5 recordatorios al día, menos de 0,10 $ al mes. Sin clave de Anthropic funciona el formato rápido `/nuevo`.

---

## Montaje paso a paso (unos 30–60 minutos)

Necesitas una cuenta gratuita de [Cloudflare](https://dash.cloudflare.com/sign-up), tu cuenta de Google, Telegram y Node.js. Para Node.js hay dos opciones.

**Opción A: Node.js instalado en tu ordenador.** Descarga la versión LTS desde [nodejs.org](https://nodejs.org) (o `winget install OpenJS.NodeJS.LTS` en Windows, `brew install node` en macOS). Comprueba con `node -v` que es la 20 o superior. `npm` y `npx` vienen incluidos.

**Opción B: Node.js dentro de Docker, sin instalar nada más.** Con [Docker Desktop](https://www.docker.com/get-started/) abierto, lanza el contenedor desde la carpeta del proyecto:

```bash
docker run -it --rm -v "${PWD}:/app" -w /app node:26-slim bash
```

Dentro, `/app` es tu carpeta: lo que cambies se guarda en tu disco. Con Docker, `wrangler login` no funciona bien (necesita abrir el navegador), así que en el paso 4 usarás un **token de API** en su lugar. Los comandos de esta guía se escriben dentro del contenedor.

### 1. Crea el bot en Telegram

1. En Telegram, abre **@BotFather** y envía `/newbot`.
2. Elige un nombre y un usuario (tiene que acabar en `bot`).
3. Guarda el **token** que te da (algo como `123456:ABC-...`). No lo compartas: quien lo tenga controla el bot. Si se filtra, en @BotFather usa `/revoke`.

### 2. Prepara Google Calendar

**2.1 Crea el calendario.** En [Google Calendar](https://calendar.google.com) (web) → ⚙️ Configuración → *Añadir calendario* → *Crear calendario* → nómbralo «Recordatorios».

**2.2 Crea el proyecto y habilita la API.**

1. Entra en [console.cloud.google.com](https://console.cloud.google.com) y crea un proyecto nuevo (p. ej. «recordatorios»). No hace falta activar facturación. **Comprueba arriba que queda seleccionado**: todo lo que sigue tiene que hacerse en ese proyecto.
2. Menú → *APIs y servicios* → *Biblioteca* → busca **Google Calendar API** → *Habilitar*. Si te saltas este paso, `/health` dará un error 403.

**2.3 Crea una cuenta de servicio** (una «cuenta robot» que solo verá ese calendario):

1. Menú → *IAM y administración* → *Cuentas de servicio* → *Crear cuenta de servicio*.
2. Ponle un nombre → *Crear y continuar*. No le des ningún rol: *Continuar* → *Listo*.
3. Entra en la cuenta creada → pestaña *Claves* → *Agregar clave* → *Crear clave nueva* → **JSON** → *Crear*.
4. Se descarga un archivo. Muévelo a la carpeta del proyecto y renómbralo `clave.json`. En Windows, comprueba que no se queda como `clave.json.json` por la extensión oculta. **No lo compartas ni lo subas a ningún repositorio.**
5. Copia el email de la cuenta de servicio (termina en `iam.gserviceaccount.com`; también está en el JSON, campo `client_email`).

**2.4 Comparte el calendario con la cuenta de servicio.** En Google Calendar → ⋮ junto a «Recordatorios» → *Configuración y uso compartido* → *Compartir con determinadas personas* → *Añadir personas* → el email del paso anterior con permiso **«Hacer cambios en eventos»**. Si avisa de que no es una cuenta de Google, envía igualmente.

**2.5 Copia el ID del calendario.** En esa misma página, sección *Integrar el calendario* → **ID de calendario** (algo como `abc123...@group.calendar.google.com`).

### 3. Clave de Anthropic (opcional, para el lenguaje natural)

En [console.anthropic.com](https://console.anthropic.com) crea una API key y recarga saldo (funciona con prepago; la recarga mínima te dura años con uso personal). Fija también un **límite de gasto mensual** bajo, por ejemplo 1 $, para no llevarte sorpresas.

Puedes saltarte este paso y añadir la clave más adelante con `npx wrangler secret put ANTHROPIC_API_KEY`.

### 4. Despliega en Cloudflare

**4.1 Instala las dependencias.** En la carpeta del proyecto:

```bash
npm install
```

Si npm avisa de que esbuild y workerd tienen scripts de instalación sin aprobar (versiones recientes de npm), apruébalos:

```bash
npm install-scripts approve esbuild workerd
npm rebuild esbuild workerd
```

**4.2 Autentícate en Cloudflare.**

- **Opción A (Node.js instalado):** `npx wrangler login` y autoriza en el navegador.
- **Opción B (Docker):** crea un token en el panel de Cloudflare → *My Profile* → *API Tokens* → *Create Token* → plantilla **Edit Cloudflare Workers**. Comprueba que incluye *D1 · Edit* (si no, añádelo). Pon una caducidad (por ejemplo 1 año), crea el token y guárdalo en tu gestor de contraseñas: solo se muestra una vez. Después, dentro del contenedor:

  ```bash
  export CLOUDFLARE_API_TOKEN="tu-token"
  ```

  Hay que repetir este `export` cada vez que abras un contenedor nuevo. Si tienes varias cuentas de Cloudflare, añade también `export CLOUDFLARE_ACCOUNT_ID="..."`.

En los dos casos, comprueba con `npx wrangler whoami` que reconoce tu cuenta.

**4.3 Crea la base de datos y publica el Worker.**

```bash
npx wrangler d1 create recordatorios     # crea la base de datos
```

El comando muestra un `database_id`. Ábrelo en `wrangler.toml` y sustituye `PEGA_AQUI_EL_ID_DE_D1` por ese valor. Luego:

```bash
npm run db:init      # crea las tablas
npm run deploy       # publica el Worker
```

La primera vez, `deploy` te pide registrar un subdominio de workers.dev para tu cuenta. Escribe **solo el nombre** (por ejemplo `miapp`), sin `https://` ni `.workers.dev`. Ese subdominio es de toda tu cuenta y la URL es pública, así que mejor que no lleve datos personales. Al terminar, `deploy` muestra la URL del bot: `https://recordatorios-bot.TU-SUBDOMINIO.workers.dev`.

**4.4 Configura los secretos.** Escribe cada comando **solo con el nombre** y pulsa Enter: te pedirá el valor después. Al pegarlo no se ve nada; es normal. Si pegas el valor en la misma línea, wrangler da `Unknown argument`.

Primero genera un secreto aleatorio para el webhook y apúntalo (lo usarás también en las URLs de `/setup` y `/health`):

```bash
node -e "console.log(crypto.randomUUID())"
```

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN        # el token de BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # el que acabas de generar
npx wrangler secret put CALENDAR_ID               # el ID del paso 2.5
npx wrangler secret put ANTHROPIC_API_KEY         # opcional
```

La clave de Google se carga directamente desde el archivo, sin pegar nada:

```bash
# macOS / Linux / dentro de Docker
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT < clave.json

# Windows (PowerShell, sin Docker)
Get-Content clave.json -Raw | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT
```

Cuando todo funcione, saca `clave.json` de la carpeta del proyecto y guárdala en un sitio seguro (o bórrala: si la necesitas, puedes crear otra clave).

### 5. Conecta Telegram con el Worker

Abre en el navegador (cambiando la URL y tu secreto):

```
https://recordatorios-bot.TU-SUBDOMINIO.workers.dev/setup?secret=TU_SECRETO
```

Debe responder con `"webhook": true`. Si dice `forbidden`, el secreto no coincide. Si no carga, espera unos minutos: un subdominio recién creado tarda en estar disponible.

### 6. Vincula tu chat

1. Abre tu bot en Telegram (el enlace `t.me/...` está en el mensaje de @BotFather) y pulsa **Iniciar** o escribe `/start`. Te responderá con tu **chat ID**.
2. Guárdalo: `npx wrangler secret put ALLOWED_CHAT_ID`
3. Escribe `/start` otra vez: ya debería saludarte con la ayuda.

El bot ignora a cualquier otra persona que le escriba.

### 7. Comprueba que todo funciona

```
https://recordatorios-bot.TU-SUBDOMINIO.workers.dev/health?secret=TU_SECRETO
```

Debe mostrar `"google_calendar": "ok (...)"`. Después, crea un recordatorio para dentro de unos minutos con un aviso previo, por ejemplo (ajustando la hora):

```
/nuevo hoy 18:30 -5m Probar el bot
```

Pulsa **✅ Crear**. Debe aparecer en tu calendario, y te llegarán dos avisos: 5 minutos antes y a la hora. Prueba el botón **✅ Hecho** en el último.

Listo: puedes cerrar la terminal, Docker y el calendario. El bot sigue funcionando en Cloudflare.

---

## Uso

| Escribes | Qué pasa |
|---|---|
| Texto libre (*«mañana a las 9 llamar al dentista, avísame 1 hora antes»*) | Te propone el recordatorio; confirmas con ✅ (necesita la clave de Anthropic) |
| Una corrección mientras hay un borrador (*«mejor a las 10»*) | Actualiza el borrador |
| *«¿qué tengo esta semana?»*, `/semana`, `/hoy` | Lista tus recordatorios |
| `/nuevo 15/11 10:00 -1s -1d Pagar el seguro` | Formato rápido sin IA. Fechas: `dd/mm`, `dd/mm/aaaa`, `hoy`, `mañana`. Avisos: `-30m`, `-2h`, `-1d`, `-1s`. Sin hora = día completo |
| `/cancelar` | Descarta el borrador pendiente |

En cada aviso: **✅ Hecho** (marca el evento con ✅ y deja de avisar), **⏰ 1 h** y **⏰ Mañana** (te lo vuelve a recordar; no mueve el evento).

Solo gastan IA los mensajes de texto libre. Los avisos, los botones, `/hoy`, `/semana` y `/nuevo` son gratis.

**Detalles útiles:**
- Los recordatorios de **día completo** suenan a las 09:00 (configurable con `ALL_DAY_HOUR` en `wrangler.toml`). En ellos solo caben avisos de días o semanas antes.
- Google permite **hasta 5 avisos** por evento y como máximo **4 semanas** de antelación.
- Los avisos pueden llegar hasta un minuto tarde: el bot revisa el calendario una vez por minuto.
- Los eventos que crees a mano en el calendario «Recordatorios» también te avisarán por Telegram: a la hora siempre, y con antelación si les pones notificaciones.
- Google Calendar puede enviarte además sus propias notificaciones. Si solo quieres las de Telegram, desactívalas para ese calendario en la app de Google Calendar.

## Mantenimiento

Solo necesitas abrir la terminal (o el contenedor) para cambiar algo:

- **Ver qué está pasando:** `npm run logs` muestra los registros en directo.
- **Cambiar ajustes** (zona horaria, hora de día completo, modelo): edita `[vars]` en `wrangler.toml` y `npm run deploy`.
- **Añadir o cambiar un secreto:** `npx wrangler secret put NOMBRE`. Se aplica al momento, sin volver a desplegar.
- **Tests:** `npm test` ejecuta las pruebas (zonas horarias, avisos, formato rápido y un flujo completo simulado).
- **Token de Cloudflare caducado** (opción Docker): el bot sigue funcionando. Solo necesitas crear un token nuevo para volver a desplegar.

**¿Puedo subir el proyecto a un repositorio?** Sí. `wrangler.toml` no contiene secretos: el `database_id` es solo un identificador y no da acceso sin tu token. Los secretos viven cifrados en Cloudflare. El `.gitignore` ya excluye `node_modules/`, `.wrangler/`, `.dev.vars` y `clave.json`.

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| `wrangler secret put` da `Unknown argument` | Pegaste el valor (o el comando dos veces) en la misma línea. Escribe solo `npx wrangler secret put NOMBRE` y pega el valor cuando lo pida. |
| `deploy` dice que el subdominio es inválido | Escribe solo el nombre, sin `https://` ni `.workers.dev`. |
| `/setup` no carga | El subdominio es nuevo y aún se está propagando. Espera unos minutos. |
| `/health` da `Google Calendar 403 ... has not been used in project` | La Google Calendar API no está habilitada en el proyecto de la cuenta de servicio. Usa el enlace del propio error, pulsa *Habilitar* y espera 2–3 minutos. |
| `/health` dice «Calendario no encontrado» | El `CALENDAR_ID` está mal o no compartiste el calendario con la cuenta de servicio (paso 2.4). |
| `/health` dice `Google token 400` o «no es un JSON válido» | El secreto `GOOGLE_SERVICE_ACCOUNT` no es el JSON completo. Vuelve a cargarlo desde el archivo. |
| El bot no contesta | Repite el paso 5 y revisa `npm run logs`. Si no configuraste `ALLOWED_CHAT_ID`, solo responde con tu chat ID. |
| Texto libre: «El modo de lenguaje natural no está activado» | Falta `ANTHROPIC_API_KEY`. Mientras tanto, usa `/nuevo`. |
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
