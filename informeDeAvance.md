# Bot de recordatorios: informe de avance

Oct 30, 2026 · @MiLord

El bot ya funciona: está desplegado en Cloudflare Workers, conectado a Telegram y a Google Calendar, y ha guardado su primer recordatorio de prueba. Falta confirmar que llegan los avisos y, si se quiere, activar el lenguaje natural con IA. El objetivo es crear recordatorios escribiendo a un bot de Telegram y recibir allí los avisos con la antelación elegida, como en los Recordatorios de Apple. Coste previsto: 0 €/mes de infraestructura y menos de 0,10 $/mes de IA con unos 5 recordatorios al día.

## Decisiones de diseño

La idea original (Recordatorios de Apple + WhatsApp) se cambió por Google Calendar + Telegram para quitar las dos fuentes de fricción.

| Decisión | Elegido | Descartado | Motivo |
| --- | --- | --- | --- |
| Almacén de recordatorios | Eventos de Google Calendar en un calendario propio | Recordatorios de Apple; Google Tasks | Apple no tiene API en la nube. La API de Google Tasks solo guarda la fecha, no la hora, y no tiene avisos previos. Los eventos sí tienen hora y avisos nativos. |
| Canal de mensajes | Bot de Telegram | WhatsApp | WhatsApp exige número aparte, alta en Meta, plantillas aprobadas y cobra por mensaje. Telegram es gratis y sin plantillas. |
| Servidor | Cloudflare Workers (plan gratuito) | Google Apps Script, VM e2-micro de Google, ESP32 | Gratis, sin mantenimiento, con tarea programada cada minuto. El ESP32 queda como posible avisador físico en una fase posterior. |
| Entrada de texto | Lenguaje natural con Claude Haiku 5.5 + formato fijo `/nuevo` de respaldo | Solo formato fijo; parser de fechas sin IA; botones | Es lo más cómodo, cuesta céntimos y siempre se confirma antes de guardar. |
| Acceso a Google | Cuenta de servicio con acceso solo a ese calendario | OAuth personal | En modo de pruebas, los tokens OAuth caducan cada 7 días. |
| Estado del bot | Base de datos D1 | Almacenamiento KV | KV tarda hasta un minuto en propagar cambios y provocaría avisos duplicados. |

## Arquitectura

&#91;embedded content: arquitectura del MVP · 1 Worker, 4 servicios\]

El Worker tiene dos entradas: los mensajes que le llegan de Telegram y una tarea que se ejecuta cada minuto. Antes de guardar nada, el bot te enseña un resumen y espera tu confirmación.

## Hecho

El bot está publicado y conectado a Telegram y a Google Calendar; ya ha creado un evento real.

**Despliegue**

- [x] Código del Worker: bot de Telegram, Google Calendar, interpretación con IA, formato `/nuevo`, avisos cada minuto, botones Hecho y Posponer
- [x] 13 pruebas automáticas superadas, incluido un flujo completo simulado y los cambios de horario de Madrid
- [x] Node.js 26 LTS funcionando dentro de un contenedor Docker, con la carpeta del proyecto montada
- [x] Dependencias instaladas (`npm install`)
- [x] Token de API de Cloudflare creado con la plantilla «Edit Cloudflare Workers» (incluye D1)
- [x] Base de datos D1 `recordatorios` creada, su ID puesto en `wrangler.toml` y tablas creadas (`npm run db:init`)
- [x] Subdominio workers.dev registrado y Worker desplegado con la tarea programada cada minuto

**Telegram**

- [x] Bot creado con @BotFather
- [x] Secretos `TELEGRAM_BOT_TOKEN` y `TELEGRAM_WEBHOOK_SECRET` guardados
- [x] Webhook conectado con `/setup`
- [x] Chat vinculado con `ALLOWED_CHAT_ID`: el bot responde solo a su dueño

**Google Calendar**

- [x] Calendario «Recordatorios» creado
- [x] Proyecto de Google Cloud con la Google Calendar API habilitada
- [x] Cuenta de servicio creada, con su clave JSON
- [x] Calendario compartido con la cuenta de servicio
- [x] Secretos `CALENDAR_ID` y `GOOGLE_SERVICE_ACCOUNT` guardados
- [x] `/health` responde «ok» para Google Calendar

**Prueba**

- [x] Recordatorio de prueba creado con `/nuevo` y guardado en el calendario

## Pendiente

Solo queda cerrar la prueba y un poco de limpieza; la IA es opcional.

- [x] Confirmar que llegan los dos avisos de la prueba (5 minutos antes y a la hora)
- [x] Probar el botón «Hecho»: el evento debe pasar a «✅ Probar el bot» en el calendario
- [x] Sacar `clave.json` de la carpeta del proyecto y guardarla en un sitio seguro
- [ ] (Opcional) Crear una API key de Anthropic, recargar saldo, fijar un límite de gasto mensual bajo (por ejemplo 1 $) y guardarla como `ANTHROPIC_API_KEY`
- [ ] (Opcional) Desactivar las notificaciones propias de Google Calendar para el calendario «Recordatorios» si salen duplicadas

## Costes, riesgos y notas

Todo cabe en planes gratuitos salvo la IA, que cuesta unos 0,0003 $ por mensaje interpretado: con 5 recordatorios al día, menos de 0,10 $ al mes. Los avisos, los botones, `/hoy`, `/semana` y `/nuevo` no usan IA. Lo que de verdad se paga es la recarga mínima de saldo en Anthropic.

| Servicio | Plan | Uso previsto | Límite del plan |
| --- | --- | --- | --- |
| Cloudflare Workers | Gratuito | \~1.500 ejecuciones/día | 100.000 peticiones/día; 5 tareas programadas (se usa 1) |
| Cloudflare D1 | Gratuito | Unas pocas escrituras por aviso | Muy por encima del uso |
| Google Calendar API | Gratuito | 1 consulta/minuto | Muy por encima del uso |
| Telegram Bot API | Gratuito | Uso personal | Sin coste |
| Claude Haiku 5.5 | Pago por uso | \~1 llamada por mensaje escrito | 0,10 $/M tokens de entrada, 0,50 $/M de salida |

**Riesgos y avisos**

- El token de Cloudflare caduca. Cuando pase, el bot sigue funcionando, pero hay que crear otro para volver a desplegar.
- Si Cloudflare se salta ejecuciones, los avisos se recuperan con hasta 15 minutos de retraso; más allá se pierden.
- Google Calendar puede enviar sus propias notificaciones además de las de Telegram. Se pueden desactivar para ese calendario.
- Los recordatorios de día completo suenan a las 09:00 y solo admiten avisos de días o semanas antes. Google permite 5 avisos por evento como máximo, hasta 4 semanas antes.
- La clave JSON de Google y los tokens no deben subirse a ningún repositorio (`.gitignore` ya los excluye).

**Notas del montaje**

- El bot funciona solo en Cloudflare: Docker, el ordenador y el calendario pueden estar cerrados. El contenedor solo hace falta para desplegar cambios, añadir secretos o ver registros (`npm run logs`).
- En cada contenedor nuevo hay que volver a exportar `CLOUDFLARE_API_TOKEN`; con Docker se usa el token en lugar de `wrangler login`.
- `wrangler secret put NOMBRE` se escribe solo con el nombre; el valor se pega cuando lo pide.
- La Google Calendar API debe estar habilitada en el mismo proyecto que la cuenta de servicio; si no, `/health` devuelve un error 403.
- Las versiones nuevas de npm piden aprobar los scripts de instalación de esbuild y workerd (`npm install-scripts approve`).
- `wrangler.toml` no contiene secretos y puede subirse a un repositorio; el ID de la base de datos no da acceso sin el token.

**Siguiente fase posible:** usar el ESP32 como avisador físico (pantalla con los próximos recordatorios, LED y botón de «hecho»), manteniendo la lógica en Cloudflare.
