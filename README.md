# vantsbot — Bot Oficial de Discord VANTS GAMES (`bot.vants.cc`)

Bot oficial de **VANTS GAMES** en **Cloudflare Workers + D1** (100 % HTTP Interactions Endpoint, sin gateway ni servidor externo).

- **Dominio oficial:** `https://bot.vants.cc`
- **Web oficial:** `https://vants.cc`
- **Bus de eventos:** `https://bus.vants.cc` (conectado por Service Binding `VANTS_BUS_SERVICE` → `vants-bus` sin error 1042)
- **Integraciones:** Service Binding `VANTS_INT_SERVICE` → `vants-integraciones`
- **Base de datos:** Cloudflare D1 (`DB` → `vants-db`)
- **Discord App ID:** `1564805627979632730` · **Servidor:** `1546641331927908472`

---

## Rutas del Worker

| Ruta | Método | Autenticación | Función |
| --- | --- | --- | --- |
| `/` | `POST` | Firma **Ed25519** (`DISCORD_PUBLIC_KEY`) | Discord Interactions Endpoint (23 comandos slash + botones `/fabrica`) |
| `/` · `/salud` | `GET` | Pública | Diagnóstico de estado y tablas D1 (sin exponer secretos) |
| `/kick` | `POST` | HMAC-SHA256 `timingSafeEqual` (**fail-closed**, `KICK_CLIENT_SECRET`) | Webhook de directos de Kick → anuncio en Discord + evento `stream.live` al `vants-bus` |
| `/setup` | `POST` | `x-vants-bot` (`VANTS_BOT_SECRET`) | Registra/actualiza los 23 comandos slash en el servidor |
| `/tarea` | `POST` | `x-vants-bot` | Drena la cola `bot_alerts` → canales de Discord |
| `/bus-test` · `/kick-test` · `/evento-discord` · `/avisar` | `POST` | `x-vants-bot` | Pruebas y anuncios controlados |
| `/banter/*` · `/ads.txt` | Varios | Según ruta | Hub Banter/Clipper → D1 + `vants-bus` |

**Cron (`* * * * *`):** cada minuto consume eventos nuevos del `vants-bus` (`match.finished`, `match.scheduled`, `clip.published`, torneos, alertas) y procesa `bot_alerts`.

---

## Comandos principales (23 slash commands)

- **Jugadores:** `/ayuda`, `/perfil`, `/ranking`, `/torneos`, `/eventos`, `/calendario`, `/planes`, `/reglas`, `/soporte`, `/vincular riot`, `/ia` (OpenAI + respaldo Claude).
- **Staff (ocultos por permisos y roles D1):** `/vants canal|estado|rol`, `/warn`, `/kick`, `/ban`, `/mute`, `/unmute`, `/clear`, `/lock`, `/unlock`, `/informe`, `/fabrica`, `/agente`.

---

## Secretos requeridos (`wrangler secret put`)

- `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `VANTS_BOT_SECRET` (32+ caracteres)
- `KICK_CLIENT_SECRET`, `VANTS_BUS_SECRET`
- Opcionales: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AGENTE_TOKEN`, `SUPERVISOR_DM_ID`

---

## Pruebas y despliegue

```bash
node --check src/index.js
node test_local.mjs
node test_banter_hub.mjs
npx wrangler deploy
```

El deploy automático a Cloudflare corre en [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) en cada push a `main` y verifica `https://bot.vants.cc/banter/estado`.
