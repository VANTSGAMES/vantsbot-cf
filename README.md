# vantsbot — Bot VANTS en Cloudflare Workers + D1

El bot de Discord de VANTS GAMES convertido en **Cloudflare Worker** (endpoint de
interactions, 100% HTTP, sin gateway ni hosting de pago) y con base de datos
**Cloudflare D1** — ya no Neon.

- App ID: **1564805627979632730**
- Servidor: **VANTS GAMES** (1546641331927908472)
- Web: https://vants.vants.workers.dev
- Comandos: los de `bot/main.py` **+ el puente con el ecosistema VANTS**:
  ayuda, perfil, ranking, torneos, eventos, calendario, planes, reglas,
  soporte (con `pregunta` → IA), **agente** (estado|informe|incidentes|resolver|comando),
  vincular riot, vants canal|estado, warn, kick, ban, mute, unmute, clear,
  lock, unlock, informe.
- `/vincular riot Nombre#TAG` da de alta al jugador SOLO en Discord: si aún no
  existe ficha en `players`, la crea al momento (`auth_user_id = discord:<id>`)
  y guarda el Riot ID en `user_game_accounts`. La web
  https://vants.vants.workers.dev/vincular-discord.html explica el flujo
  (paso a paso + FAQ) y ya está desplegada junto al sitio v2.

---

## Paso 1 · Crear la base de datos D1

Con terminal (opción recomendada):

```bash
npm install
npx wrangler login
npx wrangler d1 create vants-db
```

Copia el `database_id` que devuelve y pégalo en `wrangler.toml`
(reemplaza `PEGA_AQUI_EL_DATABASE_ID_DE_TU_D1`).

También puedes crearla sin terminal: dashboard de Cloudflare → **Workers & Pages
→ D1 SQL Database → Create database** → nombre `vants-db` → copia el **Database ID**
→ edítalo en `wrangler.toml`.

## Paso 2 · Crear las tablas

```bash
npx wrangler d1 execute vants-db --remote --file=schema.sql
```

Eso crea: seasons, players, user_game_accounts, tournament_entries, leaderboard,
tournaments, events, discord_channels, bot_alerts, mod_logs, bot_settings, web_events.

## Paso 3 · Credenciales de Discord

En https://discord.com/developers/applications → tu app (1564805627979632730):

1. **Bot** → *Reset Token* → copia el token nuevo.
2. **General Information** → copia la **Public Key**.

## Paso 4 · Cargar los secretos en el Worker

```bash
npx wrangler secret put DISCORD_BOT_TOKEN    # pega el token nuevo
npx wrangler secret put DISCORD_PUBLIC_KEY   # pega la Public Key
npx wrangler secret put VANTS_BOT_SECRET     # inventa una clave de 32+ caracteres
npx wrangler secret put SUPERVISOR_DM_ID     # (opcional) tu user id de Discord
```

## Paso 5 · Desplegar

```bash
npx wrangler deploy
```

Te devuelve la URL del Worker, por ejemplo `https://vantsbot.<tu-subdominio>.workers.dev`.

## Paso 6 · Conectar el Interactions Endpoint

Developer Portal → tu app → **General Information → Interactions Endpoint URL**:

```
https://vantsbot.<tu-subdominio>.workers.dev/
```

Dale a **Save changes**: Discord envía un PING y el Worker responde `{type:1}`.
Si no guarda, revisa `wrangler tail` y https://vantsbot.../salud.

## Paso 7 · Registrar los comandos en el servidor

Opción A (sin terminal, con el Worker ya desplegado):

```bash
curl -X POST "https://vantsbot.<tu-subdominio>.workers.dev/setup" \
  -H "x-vants-bot: <el valor de VANTS_BOT_SECRET>"
```

Opción B (con el token, sin desplegar nada antes):

```bash
# crea un .env junto al script con DISCORD_TOKEN=... y DISCORD_GUILD_ID=...
python registrar_comandos_vants.py registrar     # registra los 20
python registrar_comandos_vants.py listar        # verifica
```

Los comandos son guild-scoped: **aparecen al instante** y el registro reemplaza
el set completo, así que los 13 comandos viejos del bot anterior desaparecen.

## Paso 8 · Permisos del rol del bot en el servidor

Los comandos de staff los aplica el bot vía REST, así que su rol necesita:

- Expulsar miembros (kick)
- Banear miembros (ban)
- Gestionar canales (lock/unlock)
- Gestionar mensajes (clear/warn)
- Tiempos de espera de voz *(Moderate members)* (mute/unmute)

Ajusta el rol del bot en **Configuración del servidor → Roles**, o re-invita con
OAuth2 → scopes `bot` + `applications.commands` y los permisos anteriores.

---

## Roles de staff y comandos ocultos 👥🔒

Los 12 comandos de administración (`/vants`, `/warn`, `/kick`, `/ban`, `/mute`,
`/unmute`, `/clear`, `/lock`, `/unlock`, `/informe`, `/fabrica`, `/agente`) están
**ocultos para los miembros normales**: Discord no los muestra en el menú `/`
salvo a quien tenga el permiso correspondiente (Expulsar, Banear, Gestionar
mensajes/canales/servidor, Tiempo de espera) o sea Administrador. Es automático:
vienen de `default_member_permissions` en `src/defs.js` y `POST /setup`.

Para dar acceso de staff a un rol SIN darle permisos reales de Discord:

- `/vants rol agregar rol:@Moderador` — lo guarda en D1 (`roles_admin`) y
  sincroniza la API de permisos de comandos para que ese rol **vea y use** los 12
  comandos (máx. 10 roles, límite de Discord).
- `/vants rol quitar rol:@Moderador` — le quita el acceso.
- `/vants rol lista` — ver los roles dados de alta.

Solo un **Administrador** puede agregar/quitar; la lista es libre para el staff.
Como segunda línea de defensa, cada acción se revalida en el Worker con
`esStaff()`: vale el permiso de Discord **o** un rol de `roles_admin` **o** ser
Administrador. Si un rol agregado no ve los comandos al instante, refresca
Discord (Ctrl+R) o revisa **Ajustes → Integraciones → VANTS**.

Corrección incluida: `PERM.MODERATE_MEMBERS` estaba mal calculado (2⁴⁸ en vez de
2⁴⁰), así que `/mute` y `/unmute` rechazaban a moderadores sin Administrador.

---

## Probar

- `/ayuda` — menú completo
- `/vants estado` — diagnóstico (staff): D1 conectada, canales, alertas en cola
- `GET /salud` en el Worker — configuración y conteo de tablas (incluye kick/agente)

## Directos en Kick 🔴

El bot anuncia en Discord cuando entras en directo, usando la app que creaste en
Kick (developers.kick.com) — es "el bot de Kick" que se comunica con este bot:

1. En developers.kick.com → tu app → copia el **Client Secret** y carga:
   `npx wrangler secret put KICK_CLIENT_SECRET`
2. Pon tu slug de canal en `wrangler.toml` → `KICK_USERNAME = "vants"`
   (y si quieres, `KICK_MENCION = "@everyone"` o "<@&ROL_ID>").
3. En la app de Kick, suscribe el webhook **`livestream.status.updated`** a:
   `https://vantsbot.<tu-subdominio>.workers.dev/kick`
   - Kick envía un `challenge`: el Worker lo responde solo y la suscripción queda verificada.
   - Cada webhook se valida con HMAC-SHA256 (firma `X-Kick-Signature` contra el Client Secret).
4. Elige el canal del aviso: `/vants canal directos #directos`
   (si no hay, usa el canal de `anuncios`).
5. Prueba sin ponerte en directo:
   `curl -X POST https://vantsbot.../kick-test -H "x-vants-bot: <VANTS_BOT_SECRET>"`

## IA de OpenAI en Discord 🧠

El comando `/ia` conecta el servidor con la cuenta de servicio de OpenAI de la
org (cuenta `sk-svcacct-…` guardada como secreto `OPENAI_API_KEY`):

```bash
npx wrangler secret put OPENAI_API_KEY
```

- `/ia pregunta:¿cómo me inscribo en un torneo?` → responde con el cerebro por
  defecto (`gpt-5.4-nano`, rápido y barato).
- `/ia pregunta:... modelo:sol` → cerebros a elegir: **sol** (gpt-6-sol),
  **astra** (gpt-6-astra), **terra** (gpt-6.1-terra), **luna** (gpt-5.6-luna),
  **mini** y **nano**. Son los mismos nombres Sol/Astra que usa el dueño en el
  diagrama de la fábrica (Seguridad/UX → Sol, UI → Astra).
- Los modelos gpt-5/6 y o3/o4 son razonadores: el Worker les manda
  `max_completion_tokens` (sin `temperature`), y si tardan más de 2.2 s Discord
  muestra "pensando…" y el bot entrega la respuesta por followup (`ctx.waitUntil`).
- Anti-spam incluido: 1 pregunta cada 12 s por usuario.
- **Importante**: la org de OpenAI necesita **créditos** en
  <https://platform.openai.com/settings/organization/billing/> — sin saldo el
  bot responde con el aviso de créditos en vez de fingir una respuesta.
- **Región**: OpenAI bloquea por IP de origen (Hong Kong/China bloqueados).
  Las interacciones de Discord llegan a Cloudflare desde EE.UU. y ahí funciona;
  si algún día responde "región no soportada", reintenta o cambia de cerebro.

Para dar la IA de OpenAI al **Agente VANTS** (cerebro del agent-service), en su
`.env`:

```bash
AGENT_LLM_URL=https://api.openai.com/v1
AGENT_LLM_KEY=sk-svcacct-…        # (usa el mismo secreto, no lo copies a repos)
AGENT_LLM_MODEL=gpt-6-sol
```

`services/agent-service/llm.js` (v2.2) ya adapta los parámetros de la familia
razonadora automáticamente y mantiene el function calling del modo agéntico.

## Fábrica de software en Discord 🏭

`/fabrica` implementa el diagrama del dueño como **máquina de estados** guardada
en D1 (`fabrica_corridas` + `fabrica_pasos`, migración
`migraciones/01-fabrica.sql`). El estado sobrevive reinicios y cada etapa deja
su artefacto en el canal:

```
idea ─→ ✍️ Spec writer ─→ 🏗️ Builder ─┬→ 🛡️ Sol (Seguridad) ─┐
                                       └→ 🎨 Astra (UI) ──────┤
                                                              ↓
             ⚖️ Approver ←─ (bucle rojo: rechaza → vuelve al Builder)
                  ↓
             ¿Tamaño? (nodo ¿Humano? del diagrama del dueño)
               PEQUEÑO → ⚡ Main DIRECTO automático ("directamente se sube")
               GRANDE  → 🔀 PR y lo aprueba el DUEÑO ("si es grande, apruebo yo")
```

**Regla del dueño** (columna `tamano`, migración `migraciones/02-tamano.sql`):
el Approver clasifica cada corrida como PEQUEÑA (trivial, sin BD ni contratos,
fácil de revertir) o GRANDE. Si es pequeña y APROBADA, la corrida se cierra sola
con decisión `main_directo` — nadie pulsa nada. Si es grande, queda en la puerta
humana con **🔀 Aprobar PR (apruebo yo)** como botón recomendado y ⚡ Main
directo como override consciente. Sin clasificación legible (modo plantillas),
la corrida escala al humano: nunca se auto-aprueba a ciegas.

- `/fabrica nueva idea:...` crea la corrida y ejecuta el **Spec writer**; de ahí
  se avanza pulsando **botones** (Builder → Sol + Astra → Approver → tamaño).
  También: `/fabrica estado id:N`, `/fabrica lista`, `/fabrica cancelar`.
- Es comando de **staff** (Gestionar servidor). Solo quien abrió la corrida o el
  staff mueve los botones; el Approver puede devolver el trabajo al Builder
  automáticamente (máximo 2 vueltas, después escala al humano).
- **Cerebro por etapa** (prueba proveedores en orden, el primero que responda):
  1. `AGENTE_URL` → agent-service (`POST /api/v1/fabrica`): el camino "con
     plata", con sandbox y GitHub reales.
  2. Anthropic (`ANTHROPIC_API_KEY`) para espec/build/aprobación (los roles
     Opus/Sonnet del diagrama).
  3. OpenAI: Terra (spec), Sol (build/seguridad/aprobación), Astra (UI).
  4. **Modo plantillas**: si ninguna IA responde (sin créditos, región, clave),
     la etapa produce un checklist determinista y la máquina **nunca se atasca**
     — cuando la org tenga saldo, las mismas corridas pasan a ser 100% IA.
- Modelos por etapa ajustables con vars `proveedor:modelo`:
  `FABRICA_ESPEC`, `FABRICA_BUILD`, `FABRICA_SOL`, `FABRICA_UI`,
  `FABRICA_APROBACION` (ej: `"anthropic:claude-opus-4-5"`).

```bash
npx wrangler d1 execute vants-db --remote --file=migraciones/01-fabrica.sql  # tablas (ya aplicada)
npx wrangler d1 execute vants-db --remote --file=migraciones/02-tamano.sql   # columna tamano (ya aplicada)
npx wrangler secret put ANTHROPIC_API_KEY   # cerebro Claude (Opus/Sonnet) de la fábrica
                                            # Y respaldo automático de /ia
```

### IA dual que no falla 🤖✨

`/ia` es de **cerebro doble**: pregunta a OpenAI (el modelo que elijas: nano,
mini, sol, astra, terra, luna) y si OpenAI no puede —sin créditos, región, 429,
timeout— **responde Claude solo** (`claude-sonnet-4-5`), con el footer
"Anthropic · respaldo de OpenAI". El plan de Claude del dueño trabaja a diario
sin recargar; OpenAI solo con créditos: combinados, la IA nunca se queda muda.
La fábrica usa la misma cadena con fallback por etapa, y si TODO falla entra el
modo plantillas determinista.

## Comunicación con el ecosistema VANTS 🤖

Este bot es el nodo de Discord de la plataforma; habla con los demás así:

| Quién | Cómo | Qué |
|---|---|---|
| **VANTS AI** (vants-ai.vercel.app) | `/soporte pregunta ¿cómo...?` | El bot llama a `POST /api/chat` del cuartel general (GLM) y responde la IA de soporte |
| **Agente VANTS** (services/agent-service) | `/agente estado · informe · incidentes · resolver <id> · comando <texto>` | Mando del dueño sobre el agente: HTTP a `AGENTE_URL` + `/api/v1/*` con Bearer `AGENT_TOKEN` (el papel que hacía ORION) |
| **Web** (vants.vants.workers.dev) | `POST /evento-discord` (x-vants-bot) | Mismo contrato que la Neon Function `vantsbot`: en `vants-server/wrangler.toml` cambia `VANTS_BOT_URL` a la URL de este Worker y las compras/instalaciones llegan por DM (`web_events` en D1) |
| **Cualquier servicio del repo** | `POST /avisar` (x-vants-bot) | Puente de avisos: `{"category":"staff","title":"...","message":"...","dm":"<user_id>"}` → embed al canal configurado o DM (supervisor, discord-notify, matchmaking, el propio agente...) |

Variables/secretos del ecosistema:

```bash
# var (wrangler.toml): AGENTE_HQ_URL, KICK_USERNAME, KICK_MENCION, AGENTE_URL
npx wrangler secret put AGENTE_TOKEN          # Bearer del agent-service (si protege /api/v1)
npx wrangler secret put KICK_CLIENT_SECRET    # firma de los webhooks de Kick
```

## VANTS-BUS: el bot en el bus de eventos 🚌

El bot es ahora un nodo más del bus central de la org
(`https://vants-bus.vants.workers.dev`, contrato de 12 eventos +
`stream.live` del propio bot). Dos direcciones:

**Consumir** — el cron del Worker (`* * * * *`, cada minuto) lee los eventos
nuevos del bus y los anuncia en Discord:

| Evento del bus | Canal configurado (fallback) | Embed |
|---|---|---|
| `match.finished` | `resultados` (ranked) | 🏁 verde con marcador/mapa |
| `match.scheduled` / `match.canceled` | `agenda` (anuncios) | 📅 / 🚫 |
| `tournament.inscriptions_opened` | `anuncios` | 🏆 dorado |
| `inscription.created` | `registros` | 📝 |
| `clip.published` / `clip.highlights_ready` | `clips` (anuncios) | 🎬 / ✨ |
| `alert.detected` | `staff` (logs) | 🚨 rojo |
| `game.session_*` / `anticheat.passed` | `registros` | 🎮 / 🛡️ |
| `stream.live` (Kick) | `directos` (anuncios) | 🔴 verde Kick |

Configura los destinos con `/vants canal resultados`, `/vants canal agenda`
y `/vants canal clips` (categorías nuevas del comando). El cursor del
consumidor vive en D1 (`bus_estado`) → sin repetir ni perder avisos entre
corridas. `POST /bus-test` (x-vants-bot) anuncia un evento sintético por el
mismo camino del cron para probar canales sin esperar eventos reales.

**Publicar** — cada directo de Kick (webhook ya operativo) sale además al bus
como `stream.live` con plataforma, título y URL, para que la web, el launcher
y los agentes reaccionen en vivo. Best-effort: si el bus no está disponible,
el aviso de Discord ya salió igual.

**Transporte (importante):** Cloudflare bloquea los fetch de Worker a otros
`*.workers.dev` (error 1042). Como bot y bus viven en la misma cuenta, el
transporte correcto es el **Service Binding** `VANTS_BUS_SERVICE → vants-bus`
(ya configurado en wrangler.toml). ✅ **COMPLETADO (28-10):**

- El proyecto `vantsbot` está **registrado en el bus** (secret
  `SECRET_VANTSBOT` creado en el worker `vants-bus` vía API) y el mismo
  valor vive en `VANTS_BUS_SECRET` del bot → `/salud` muestra
  `bus.secreto=true` y el cron de consumo activo.
- **Canales configurados en D1** (`discord_channels`): resultados → #📋・resultados,
  agenda/anuncios → #📢・anuncios, clips → #𝚃iktok-live, directos → #ｋick,
  staff → #«𝙼oderator, logs → #vants-data (ajustable con `/vants canal`).
- **Anuncio verificado de punta a punta**: `POST /bus-test` → embed de
  "Partido terminado" entregado en #📋・resultados (HTTP 200 de Discord).
- **Firma HMAC de `vantsbot` aceptada por el bus** (verificado con sonda:
  pasa la autenticación; sin ella responde 401).

⚠️ **Pendiente del lado del bus (infra del equipo):** su base Neon responde
`500 password authentication failed for user 'authenticator'` en TODAS las
operaciones (publicar/consumir, para todos los proyectos). El bot reintenta
solo cada minuto: cuando el admin del bus arregle su `DATABASE_URL`, el
consumo arranca sin tocar nada de este lado. Diagnóstico y arreglo propuesto
(rol nuevo `vants_bus`, no destructivo) en `scripts/arreglar_bd_bus.py`.
Nota para el equipo: `vants-consumer-playvants` y `vants-faceit-webhook`
siguen llamando al bus por su URL pública de workers.dev → sus subrequests
caen con el error 1042; la solución es la misma (service binding).

Permisos del bot (los de tu captura): correctos — cubren kick/ban/timeout,
gestionar canales y mensajes, y mencionar a todos. Recuerda que el rol del bot
debe estar **por encima** de los roles de quien quieras expulsar/banear (jerarquía).

## Datos

`schema.sql` crea las tablas **con los mismos nombres que la web usa en Neon**
(players, leaderboard, tournaments, events, user_game_accounts, discord_channels,
bot_alerts...). Cuando migres la web a D1, apuntará a la misma base sin cambiar el
bot. Para copiar datos existentes de Neon: exporta CSV y con `wrangler d1 execute`
inserta (pidémelo y preparo el volcado).

## Útil

- `npx wrangler tail` — logs en vivo
- `npx wrangler d1 execute vants-db --remote --command "SELECT 1"`
- `python registrar_comandos_vants.py borrar` — vaciar comandos del servidor

## Notas

- `/tarea` procesa la cola `bot_alerts` (la dispara tu CI con la cabecera
  `x-vants-bot`, igual que hacía la Neon Function).
- El bot python (`bot/main.py`) queda como referencia: con D1 el camino soportado
  es este Worker (D1 no acepta conexiones TCP como Postgres).
- `/informe` y `/vants` piden **Gestionar servidor**; la moderación valida el
  permiso específico de cada acción sobre el miembro que invoca.
