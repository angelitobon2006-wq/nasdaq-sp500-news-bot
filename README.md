# 📰 Bot de noticias Nasdaq 100 y S&P 500 para Discord

Bot **independiente** que lee noticias financieras gratuitas (RSS), las filtra, las analiza con Claude y las publica en español en **un único canal** de tu Discord. Incluye resumen cada hora, calendario económico con alertas 30 minutos antes y los comandos `/estado`, `/resumen`, `/analizar`, `/calendario` y `/sesgo`.

> ⚠️ Análisis automático con IA. **No es consejo financiero** ni genera señales de entrada/salida.

## Cómo funciona (en 6 líneas)

```
GitHub Actions (cada ~5 min / cada hora)  ──llama──▶  Vercel (tu app, gratis)
                                                         │  lee RSS + calendario
                                                         │  guarda en Supabase (evita duplicados)
                                                         │  analiza con Claude (solo lo relevante)
                                                         └▶ publica en Discord (solo en TU canal de noticias)
```

* No hay servidor encendido: cada ejecución es independiente.
* GitHub **no garantiza** que corra exactamente cada 5 minutos: puede retrasarse varios minutos. El bot está diseñado para que eso no importe.
* Si GitHub ejecuta dos veces lo mismo, **no se duplica nada** (bloqueos en la base de datos).

## 🔒 Independencia de tu otro bot

* Se crea una **aplicación de Discord NUEVA** con su **token propio**. Nunca usas el token del bot actual.
* Los comandos se registran **solo para la aplicación nueva** (`scripts/register-commands.ts` usa el ID de la aplicación nueva). No toca los comandos del otro bot.
* No modifica roles, categorías ni canales. Se invita **sin permisos de administrador** (permissions=0) y solo le das *Ver canal, Enviar mensajes e Insertar enlaces* **en el canal de noticias**.
* Solo tiene una dependencia en producción (`@vercel/functions`). No toca nada del otro proyecto.

## Estructura de carpetas

```
api/                    Endpoints de Vercel
  interactions.ts       Recibe los comandos de Discord (firma verificada)
  health.ts             Comprobación de configuración (solo sí/no, sin secretos)
  jobs/news.ts          Noticias  (lo llama GitHub Actions)
  jobs/summary.ts       Resumen horario
  jobs/calendar.ts      Calendario + alertas
lib/                    Lógica (RSS, relevancia, Claude, Discord, Supabase, formato…)
scripts/register-commands.ts   Registra los 5 comandos del bot nuevo
supabase/schema.sql     Tablas de la base de datos
test/                   Pruebas automáticas (30)
.github/workflows/      Los 3 programadores (news-check, hourly-summary, calendar-alerts)
docs/COSTES.md          Costes, límites y cuántas llamadas a Claude se hacen
.env.example            Plantilla de variables (sin claves reales)
```

---

# 🧭 INSTALACIÓN PASO A PASO (para principiantes)

Tiempo aproximado: 45–60 minutos. Ve **en orden** y no te saltes pasos. Ten abierto un bloc de notas donde ir guardando los valores que te voy pidiendo copiar.

> 🛑 **Regla de oro:** nunca pegues tokens ni claves en un chat, en una captura de pantalla ni en GitHub. Solo en las casillas que te indico.

## PASO 0 · Cuentas que necesitas (todas gratis)

| Servicio | Para qué | Enlace |
|---|---|---|
| GitHub | Guardar el código y ejecutar los programadores | github.com |
| Vercel | Alojar la app | vercel.com (entra con tu cuenta de GitHub) |
| Supabase | Base de datos | supabase.com |
| Groq | La IA que analiza las noticias, **plan gratuito** (sin gastar dinero) | console.groq.com |

## PASO 1 · Crear el bot NUEVO de Discord

1. Entra en **https://discord.com/developers/applications** y pulsa **New Application** (arriba a la derecha).
2. Ponle un nombre distinto al del otro bot, por ejemplo `ELVN News`. Acepta y pulsa **Create**.
3. En la pantalla *General Information* copia y guarda en tu bloc de notas:
   * **Application ID** → será `DISCORD_APPLICATION_ID`
   * **Public Key** → será `DISCORD_PUBLIC_KEY`
4. Menú izquierdo → **Bot**. Pulsa **Reset Token** → confirma → **Copy**. Es `DISCORD_BOT_TOKEN`. (Solo se muestra una vez. Si lo pierdes, lo reseteas otra vez. **Es solo del bot nuevo**).
5. En esa misma pantalla *Bot*, deja **todos los "Privileged Gateway Intents" desactivados** (no hacen falta).
6. Menú izquierdo → **OAuth2** → apartado *OAuth2 URL Generator*:
   * Marca **bot** y **applications.commands**.
   * En *Bot Permissions* **no marques nada** (y desde luego no Administrator).
   * Copia la **URL generada** de abajo, ábrela en el navegador, elige tu servidor y pulsa **Autorizar**.
7. Ahora el bot aparece en tu servidor **sin poder ver ningún canal**. Eso es lo que queremos.

### Dale acceso SOLO al canal de noticias

1. En Discord crea (o elige) tu canal de noticias, p. ej. `#noticias-nasdaq-sp500`.
2. Clic derecho sobre el canal → **Editar canal** → **Permisos** → **＋** (añadir miembro/rol) → busca `ELVN News` (el bot nuevo).
3. Actívale **solo** estas tres cosas con ✅: **Ver canal**, **Enviar mensajes**, **Insertar enlaces**. Guarda.
4. No cambies nada más ni en el servidor ni en el otro bot.

### Copiar los IDs
1. Discord → **Ajustes de usuario** → **Avanzado** → activa **Modo desarrollador**.
2. Clic derecho en el canal de noticias → **Copiar ID del canal** → será `DISCORD_CHANNEL_ID`.
3. Clic derecho en el icono de tu servidor → **Copiar ID del servidor** → será `DISCORD_GUILD_ID`.

## PASO 2 · Base de datos en Supabase

1. En **supabase.com** → **New project**. Nombre `news-bot`, pon una contraseña (guárdala) y elige la región más cercana (p. ej. *West EU*). Espera 1–2 minutos a que se cree.
2. Menú izquierdo → **SQL Editor** → **New query**.
3. Abre el archivo `supabase/schema.sql` de este proyecto, **copia todo** su contenido, pégalo en el editor y pulsa **Run**. Debe decir *Success*.
4. Menú izquierdo → **Project Settings** (⚙️) → **API** (o *Data API*):
   * **Project URL** → será `SUPABASE_URL`.
   * Menú ⚙️ **Project Settings** → **API Keys**. Verás dos pestañas. En la nueva, la clave secreta se llama **Secret key** y empieza por `sb_secret_`; en la pestaña **Legacy API Keys** está la **service_role** (empieza por `eyJ`). Sirve cualquiera de las dos (nunca la *publishable* ni la *anon*). Pulsa *Reveal* → copiar → será `SUPABASE_SERVICE_ROLE_KEY`.
   * 🔴 La `service_role` da control total. **Nunca** la subas a GitHub ni la pegues en ningún otro sitio que no sea Vercel (paso 5). El proyecto no tiene parte web pública que la use; solo se lee en el servidor.

## PASO 3 · Clave GRATUITA de IA (Groq)

1. Entra en **https://console.groq.com** y crea tu cuenta (puedes usar Google o GitHub).
2. Menú izquierdo → **API Keys** → **Create API Key** → ponle un nombre (`news-bot`) → **Submit** → **Copy**. Será `GROQ_API_KEY`. (Solo se muestra una vez.)
3. No introduzcas ninguna tarjeta: el plan gratuito no la necesita según las fuentes que consulté; si Groq te la pidiera, no sigas y avísame.
4. Los límites gratuitos son por día y por minuto y pueden cambiar. El bot lleva topes propios para no pasarse; cuando se agota el cupo del día simplemente deja de analizar hasta mañana. Mira `docs/COSTES.md`.

> ¿Prefieres Claude de pago? Cambia `LLM_PROVIDER=anthropic` y añade `ANTHROPIC_API_KEY` (y fija un límite de gasto en console.anthropic.com). No es necesario.

## PASO 4 · Subir el proyecto a GitHub

Recomendado: **repositorio PÚBLICO**. Motivo: los repositorios públicos tienen minutos de GitHub Actions ilimitados; los privados tienen un cupo mensual que este bot gastaría antes de acabar el mes. No hay ninguna clave dentro del código (están en Vercel/GitHub Secrets), así que es seguro que sea público.

**Con la web de GitHub (lo más fácil):**
1. github.com → **＋** → **New repository** → nombre `nasdaq-sp500-news-bot` → **Public** → **Create repository**.
2. Descomprime el .zip del proyecto en tu Mac.
3. En la página del repositorio vacío pulsa **uploading an existing file**.
4. Arrastra **todo el contenido** de la carpeta (incluida la carpeta `.github`, que es oculta: en el Finder pulsa `Cmd + Shift + .` para ver archivos ocultos). **Importante:** `.github/workflows` debe subirse, si no los programadores no existirán.
5. Pulsa **Commit changes**.
6. Comprueba que en el repositorio existe `.github/workflows/` con 3 archivos. Si no están, créalos con **Add file → Create new file** escribiendo la ruta `.github/workflows/news-check.yml` y pegando el contenido.

> No subas nunca un archivo `.env`. El `.gitignore` ya lo evita.

## PASO 5 · Desplegar en Vercel (plan Hobby gratis)

1. **vercel.com** → **Add New… → Project** → conecta GitHub si te lo pide → junto a `nasdaq-sp500-news-bot` pulsa **Import**.
2. *Framework Preset*: **Other**. No toques nada más de build.
3. Despliega **Environment Variables** y añade una a una (Name = nombre, Value = tu valor, **Add**):

| Name | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | token del bot NUEVO |
| `DISCORD_CHANNEL_ID` | ID del canal de noticias |
| `DISCORD_PUBLIC_KEY` | Public Key de la aplicación nueva |
| `DISCORD_APPLICATION_ID` | Application ID de la aplicación nueva |
| `DISCORD_GUILD_ID` | ID del servidor |
| `LLM_PROVIDER` | `groq` |
| `GROQ_API_KEY` | tu clave gratuita de Groq |
| `SUPABASE_URL` | Project URL de Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | clave service_role |
| `CRON_SECRET` | una contraseña larga inventada (mín. 16 caracteres, p. ej. 40 letras y números aleatorios). **Guárdala: la usarás en el paso 7** |

   Opcionales (si no los pones, se usan valores seguros por defecto): ver `.env.example`.
   🔴 Ningún nombre debe empezar por `PUBLIC_` ni `NEXT_PUBLIC_`. Pega los valores **sin comillas ni espacios**.
4. Pulsa **Deploy** y espera. Cuando termine verás tu dirección, p. ej. `https://nasdaq-sp500-news-bot.vercel.app`. **Cópiala**: es `APP_URL`.
5. Comprobación: abre `https://TU-DIRECCION.vercel.app/api/health`. Debe mostrar todo en `true`. Si algo sale `false`, esa variable falta o está mal; corrígela en *Settings → Environment Variables* y haz **Redeploy** (Deployments → ⋯ → Redeploy).

> Usa siempre la dirección de **producción** (la corta, `…vercel.app`). Las direcciones de *preview* están protegidas por Vercel y darían error.

## PASO 6 · Registrar los comandos y activar la URL de interacciones

**A) Decir a Discord dónde atender los comandos.**
1. Discord Developer Portal → tu aplicación **nueva** → **General Information** → **Interactions Endpoint URL**.
2. Pega `https://TU-DIRECCION.vercel.app/api/interactions` → **Save Changes**. Si dice *Success*, la firma funciona. Si da error: revisa `DISCORD_PUBLIC_KEY` en Vercel y haz Redeploy.

**B) Registrar los 5 comandos** (esto se hace una sola vez, desde tu Mac):
1. Instala Node.js LTS desde **nodejs.org** (si no lo tienes).
2. Abre la app **Terminal**. Escribe `cd ` (con espacio), arrastra la carpeta del proyecto a la ventana y pulsa Enter.
3. Ejecuta: `npm install`
4. Crea un archivo `.env` **solo en tu ordenador** (nunca lo subas) con este contenido, rellenando los valores del bot nuevo:
   ```
   DISCORD_BOT_TOKEN=...
   DISCORD_APPLICATION_ID=...
   DISCORD_GUILD_ID=...
   ```
   Truco: `cp .env.example .env` y luego edítalo con TextEdit (menú *Formato → Convertir en texto plano*) o con `nano .env`.
5. Ejecuta: `npm run register-commands`. Debe listar `/estado /resumen /analizar /calendario /sesgo`.
   Este paso solo afecta a la aplicación nueva; los comandos del otro bot no se tocan.

## PASO 7 · Activar los programadores de GitHub Actions

1. En tu repositorio de GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Crea dos secretos:
   * `APP_URL` = `https://TU-DIRECCION.vercel.app` (sin barra final)
   * `CRON_SECRET` = **exactamente** la misma contraseña que pusiste en Vercel.
3. Pestaña **Actions**: si GitHub pide activarlos, pulsa **I understand my workflows, go ahead and enable them**.
4. Prueba manual: Actions → **Noticias (cada 5 minutos)** → **Run workflow** → **Run workflow**. Tras unos segundos debe quedar con ✅ verde. Repite con *Resumen horario* y *Calendario y alertas*.
5. Desde ese momento corren solos (con los retrasos habituales de GitHub).

## PASO 8 · Comprobar que funciona

1. En Discord escribe `/estado` en cualquier canal donde el bot pueda leer comandos. Debe responder (solo tú lo ves) con las últimas ejecuciones.
   > Los comandos funcionan en cualquier canal donde puedas escribir; el bot solo *publica* en el canal de noticias.
2. `/calendario` → próximos eventos de alto impacto.
3. `/analizar texto: <pega un titular o párrafo de al menos 30 caracteres>` → análisis completo.
4. Espera 10–20 minutos: deberían aparecer noticias en el canal (si hay noticias relevantes en ese momento).
5. A la hora en punto +2 minutos llega el primer resumen horario.

### Comandos

| Comando | Qué hace |
|---|---|
| `/estado` | Salud del sistema, consumo de Claude del día y fuentes RSS caídas |
| `/resumen [actualizar]` | Último resumen horario (con `actualizar` genera uno nuevo, con espera y límites) |
| `/analizar texto:` | Analiza un texto que pegues (público, con límite diario y espera por usuario) |
| `/calendario [dias]` | Eventos económicos de los próximos 1–7 días, hora de Madrid |
| `/sesgo` | Sesgo fundamental de Nasdaq y S&P 500 de las últimas 6 horas |

## PASO 9 · Pruebas automáticas (opcional, en tu Mac)

```
npm install
npm run typecheck
npm test
```
Deben pasar las 31 pruebas. Cubren: lectura RSS, filtro de relevancia, duplicados, validación de respuestas de Claude, horarios de Madrid con cambios de hora, límites de Discord, firma de Discord, dobles ejecuciones, límites diarios, fallos de Discord y comandos.

---

# 🛠️ Si algo falla

| Síntoma | Qué hacer |
|---|---|
| `/api/health` muestra `false` | Falta esa variable en Vercel → añádela → Redeploy |
| Discord no acepta la *Interactions Endpoint URL* | `DISCORD_PUBLIC_KEY` mal copiada, o falta Redeploy. Pruébalo con la URL de producción |
| Los comandos no aparecen | Repite `npm run register-commands`; comprueba que `DISCORD_GUILD_ID` es el del servidor y que invitaste el bot con `applications.commands` |
| GitHub Action en rojo con `401` | `CRON_SECRET` distinto entre GitHub y Vercel |
| GitHub Action en rojo con `404` | `APP_URL` mal o proyecto no desplegado |
| El bot no publica | No tiene permiso *Ver canal / Enviar mensajes / Insertar enlaces* en ese canal, o `DISCORD_CHANNEL_ID` es erróneo |
| Casi nunca publica | Normal si hay pocas noticias relevantes; mira `/estado` |
| Dejó de ejecutarse tras semanas | GitHub desactiva los programadores de repos **sin actividad durante 60 días**: Actions → activar de nuevo, o haz un pequeño cambio en el repo |
| Supabase "pausado" | En plan gratis se pausa tras 1 semana sin actividad; el bot genera actividad continua, pero si pasa, pulsa *Restore* |

# ⚠️ Limitaciones honestas

* **Calendario económico:** no existe una fuente gratuita, oficial y fiable con el dato publicado en tiempo real. Se usa el JSON público no oficial de Faireconomy: da fecha/hora, impacto, previsión y anterior; el **"publicado"** muchas veces no viene y entonces se muestra *no disponible* (no se inventa). Puede cambiar o dejar de funcionar sin aviso.
* **Fuentes RSS:** Reuters ya no ofrece RSS público; se obtiene a través de una búsqueda RSS de Google News (solo titulares). Bloomberg, FT y WSJ ofrecen RSS limitado. Las direcciones de los feeds **no se han podido probar en vivo desde donde se creó el proyecto**; si alguna cae, `/estado` te la marca y el resto sigue funcionando. Se pueden desactivar con `DISABLED_FEEDS=id1,id2`.
* **No se ha probado contra los servicios reales** (Discord, Supabase, Groq, Vercel) desde el entorno donde se escribió. Lo comprobado: compila (TypeScript estricto) y 30 pruebas con servicios simulados. La primera ejecución real es tu prueba de aceptación; si algo falla, copia el error (sin claves) y lo arreglamos.
* La IA puede equivocarse. Es un apoyo informativo, no una señal de operación.

Con Groq todo el sistema es gratuito. Costes y límites de cada servicio: **docs/COSTES.md**.
