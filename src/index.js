// ============================================
// vantsbot — Cloudflare Worker · Interactions endpoint de Discord
// Sin gateway, sin hosting de pago: 100% HTTP (mismo modelo que la web).
// Base de datos: Cloudflare D1 (binding DB) — no Neon.
//
//   POST /        → Interactions endpoint (firma Ed25519 del Developer Portal)
//                   type 2 = comandos slash · type 3 = botones de /fabrica
//   POST /setup   → registra los 23 comandos en el servidor (x-vants-bot)
//                   PUT guild-commands = reemplaza el set completo (borra viejos)
//   POST /tarea   → procesa la cola bot_alerts → canales de discord_channels
//   POST /bus-test→ anuncia un evento sintético del bus (x-vants-bot)
//   GET  /salud   → diagnóstico de configuración y D1 (sin secretos)
//   scheduled()   → cron: consume el VANTS-BUS (eventos del ecosistema →
//                   anuncios en Discord) y drena la cola bot_alerts
//
// Secretos (wrangler secret put): DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY,
// VANTS_BOT_SECRET, OPENAI_API_KEY (comando /ia), SUPERVISOR_DM_ID (opcional).
// ============================================
import {
  txt, dormir, appIdDeToken, verificarFirma, autorizado,
  dapi, dbFirst, esStaff, PERM, GUILD_ID_DEFECTO,
} from './util.js';
import { COMANDOS } from './defs.js';
import {
  ayuda, perfil, ranking, torneos, eventos, calendario,
  planes, reglas, soporte, vincularRiot,
} from './comandos.js';
import {
  warn, kick, ban, mute, unmute, clear, lock, unlock,
  vantsCanal, vantsEstado, vantsRol, informe,
} from './staff.js';
import { eventoDiscord, avisar, agente } from './bridge.js';
import { kickHandler, kickPrueba } from './kick.js';
import { cicloBus, busPrueba } from './bus.js';
import { ia } from './openai.js';
import { fabricaComando, fabricaBoton } from './fabrica.js';
import { rutasBanterHub, resumenBanter } from './banterHub.js';

const PRESUPUESTO_MS = 2200; // Discord exige respuesta < 3s; margen para el followup

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Normaliza { content, embeds, components, flags } a la forma que Discord
// acepta en respuestas y followups (lo usan el camino caliente y el frío).
const aSalida = (res) => ({
  ...(res?.embeds ? { embeds: res.embeds } : {}),
  ...(res?.components ? { components: res.components } : {}),
  ...(res?.content ? { content: res.content } : {}),
  flags: res?.flags ?? 0,
});

// ── Despacho de comandos (type 2 APPLICATION_COMMAND) ───────────────────────
async function procesarComando(body, env) {
  const nombre = String(body?.data?.name ?? '');
  const token = String(env.DISCORD_BOT_TOKEN ?? '');
  const guildId = String(env.DISCORD_GUILD_ID || GUILD_ID_DEFECTO);

  switch (nombre) {
    case 'ayuda': return ayuda(env);
    case 'perfil': return perfil(env, body);
    case 'ranking': return ranking(env, body);
    case 'torneos': return torneos(env);
    case 'eventos': return eventos(env);
    case 'calendario': return calendario(env);
    case 'planes': return planes(env);
    case 'reglas': return reglas();
    case 'soporte': return soporte(env, body);
    case 'ia': return ia(env, body);
    case 'fabrica': return fabricaComando(env, body);
    case 'vincular': return vincularRiot(env, body);
    case 'agente': return agente(env, body);
    case 'vants': {
      const sub = String((body?.data?.options ?? [])[0]?.name ?? 'estado');
      if (sub === 'canal') return vantsCanal(env, body);
      if (sub === 'rol') return vantsRol(env, body, guildId);
      return vantsEstado(env, body);
    }
    case 'warn': return warn(env, body, token, guildId);
    case 'kick': return kick(env, body, token, guildId);
    case 'ban': return ban(env, body, token, guildId);
    case 'mute': return mute(env, body, token, guildId);
    case 'unmute': return unmute(env, body, token, guildId);
    case 'clear': return clear(env, body, token, guildId);
    case 'lock': return lock(env, body, token, guildId);
    case 'unlock': return unlock(env, body, token, guildId);
    case 'informe': return informe(env, body);
    default:
      return { content: `Comando \`${nombre}\` no implementado en vantsbot.` };
  }
}

// ── /setup: registro idempotente de los 23 comandos (guild = instantáneo) ────
export async function setupComandos(env) {
  const token = String(env.DISCORD_BOT_TOKEN ?? '');
  if (!token) return { ok: false, error: 'falta DISCORD_BOT_TOKEN (wrangler secret put)' };
  const appId = appIdDeToken(token) || String(env.DISCORD_APP_ID ?? '');
  const guildId = String(env.DISCORD_GUILD_ID || GUILD_ID_DEFECTO);
  if (!/^\d{17,20}$/.test(appId)) return { ok: false, error: 'no pude derivar el App ID del token' };

  const r = await dapi(token, 'PUT', `/applications/${appId}/guilds/${guildId}/commands`, COMANDOS);
  if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, detalle: r.data };
  return {
    ok: true,
    modo: 'guild (instantáneo, reemplaza el set completo)',
    servidor: guildId,
    registrados: Array.isArray(r.data) ? r.data.length : 0,
    nombres: Array.isArray(r.data) ? r.data.map((c) => c.name) : [],
  };
}

// ── /tarea: procesa la cola bot_alerts (la dispara CI o un cron) ─────────────
async function cicloTarea(env) {
  const token = String(env.DISCORD_BOT_TOKEN ?? '');
  const out = { enviadas: 0, errores: [] };
  if (!token) {
    out.errores.push('falta DISCORD_BOT_TOKEN');
    return out;
  }

  let pendientes = [];
  try {
    const res = await env.DB.prepare(
      "SELECT id, kind, category, payload, channel_id FROM bot_alerts WHERE status = 'pending' ORDER BY id LIMIT 10",
    ).all();
    pendientes = res.results ?? [];
  } catch (e) {
    out.errores.push(`db:${txt(e, 80)}`);
    return out;
  }

  for (const alerta of pendientes) {
    let destino = alerta.channel_id ? String(alerta.channel_id) : null;
    if (!destino && alerta.category) {
      try {
        const f = await dbFirst(
          env,
          'SELECT channel_id FROM discord_channels WHERE category = ? LIMIT 1',
          [String(alerta.category)],
        );
        destino = f?.channel_id ? String(f.channel_id) : null;
      } catch {
        /* sin canal configurado */
      }
    }
    if (!destino) {
      out.errores.push(`#${alerta.id}:sin_canal`);
      await env.DB.prepare("UPDATE bot_alerts SET status = 'error', error = 'sin canal', attempts = attempts + 1 WHERE id = ?")
        .bind(alerta.id)
        .run();
      continue;
    }

    let payload = {};
    try {
      payload = JSON.parse(String(alerta.payload ?? '{}'));
    } catch {
      /* payload opcional */
    }
    const r = await dapi(token, 'POST', `/channels/${destino}/messages`, {
      embeds: [{
        title: txt(payload.title ?? alerta.kind, 200),
        description: txt(payload.message ?? payload.titulo ?? '', 1500) || '—',
        color: 0xe30613,
        footer: { text: 'VANTS · alerta automática' },
      }],
      allowed_mentions: { parse: [] },
    });
    if (r.ok) out.enviadas += 1;
    await env.DB.prepare(
      'UPDATE bot_alerts SET status = ?, message_id = ?, sent_at = ?, attempts = attempts + 1, error = ? WHERE id = ?',
    )
      .bind(r.ok ? 'sent' : (r.status === 403 || r.status === 404 ? 'error' : 'pending'), r.data?.id ?? null, new Date().toISOString(), r.ok ? null : `http:${r.status}`, alerta.id)
      .run();
    if (!r.ok && r.status !== 403 && r.status !== 404) out.errores.push(`#${alerta.id}:http${r.status}`);
    await dormir(350); // holgura anti rate-limit (patrón supervisor.py)
  }
  return out;
}

// ── /salud: diagnóstico sin secretos (detalles solo con x-vants-bot) ─────────
async function salud(env, request) {
  const esAdmin = request && autorizado(request.headers?.get?.('x-vants-bot'), env.VANTS_BOT_SECRET);
  if (!esAdmin) {
    return json({
      ok: true,
      fn: 'vantsbot-worker',
      db: 'Cloudflare D1',
    });
  }
  const token = String(env.DISCORD_BOT_TOKEN ?? '');
  const tablas = {};
  for (const t of ['players', 'leaderboard', 'tournaments', 'events', 'discord_channels', 'bot_alerts', 'mod_logs', 'web_events', 'fabrica_corridas', 'fabrica_pasos', 'roles_admin', 'bus_estado']) {
    try {
      const f = await dbFirst(env, `SELECT count(*) AS n FROM ${t}`);
      tablas[t] = Number(f?.n ?? 0);
    } catch {
      tablas[t] = 'error (¿falta schema.sql?)';
    }
  }
  return json({
    ok: true,
    fn: 'vantsbot-worker',
    db: 'Cloudflare D1',
    config: {
      public_key: Boolean(env.DISCORD_PUBLIC_KEY),
      bot_token: Boolean(token),
      app_id: token ? appIdDeToken(token) : env.DISCORD_APP_ID || null,
      guild_id: env.DISCORD_GUILD_ID || GUILD_ID_DEFECTO,
      secret_tarea: Boolean((env.VANTS_BOT_SECRET ?? '').length >= 32),
      kick: {
        client_secret: Boolean(env.KICK_CLIENT_SECRET),
        usuario: env.KICK_USERNAME || null,
        mencion: Boolean(env.KICK_MENCION),
      },
      agente: {
        agent_service: env.AGENTE_URL || null,
        token: Boolean(env.AGENTE_TOKEN),
        hq_web: env.AGENTE_HQ_URL || 'https://vants-ai.vercel.app',
      },
      openai: {
        api_key: Boolean(env.OPENAI_API_KEY),
        modelos: 'nano · mini · sol · astra · terra · luna',
        respaldo_claude: Boolean(env.ANTHROPIC_API_KEY),
      },
      bus: {
        url: env.VANTS_BUS_URL || null,
        proyecto: env.VANTS_BUS_PROJECT || 'vantsbot',
        secreto: Boolean(env.VANTS_BUS_SECRET),
        via: env.VANTS_BUS_SERVICE
          ? 'service binding → vants-bus (misma cuenta, sin 1042)'
          : 'URL pública (ojo: Workers no puede fetchear *.workers.dev, error 1042)',
        consumo: env.VANTS_BUS_SECRET
          ? 'cron cada minuto → /vants canal resultados|agenda|clips'
          : 'deshabilitado (falta VANTS_BUS_SECRET: el admin del bus debe registrar el proyecto vantsbot)',
      },
      fabrica: {
        cerebro_openai: Boolean(env.OPENAI_API_KEY),
        cerebro_claude: Boolean(env.ANTHROPIC_API_KEY),
        agent_service: env.AGENTE_URL || null,
        regla: 'pequeño → ⚡ main directo automático · grande → 🔀 PR (aprueba el dueño)',
        modelos: env.FABRICA_ESPEC || 'auto (Claude si hay key · Terra/Sol/Astra en OpenAI)',
      },
      staff: {
        roles_admin: 'tabla roles_admin en D1 (/vants rol agregar|quitar|lista)',
        ocultos_para_miembros: 'vants, warn, kick, ban, mute, unmute, clear, lock, unlock, informe, fabrica, agente',
      },
      banter: await resumenBanter(env),
    },
    tablas,
  });
}

// ── Factory inyectable (convención de la casa) ───────────────────────────────
export function construir(sobre = {}) {
  const saltarFirma = sobre.saltarFirma ?? false;

  return async function handler(request, env, ctx) {
    const ruta = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'GET' && (ruta === '/' || ruta === '/salud')) return salud(env, request);

    // Motor Banter + NitroPay /ads.txt + VANTS-Clipper -> D1 + VANTS-BUS
    const rBanter = await rutasBanterHub(request, env, ruta, { fetchImpl: sobre.fetchImpl || fetch });
    if (rBanter) return rBanter;

    // Webhook de Kick (app del dueño en developers.kick.com): auth por firma
    // HMAC con KICK_CLIENT_SECRET, no x-vants-bot.
    if (ruta === '/kick') {
      if (request.method !== 'POST') return json({ ok: false, error: { message: 'usa POST' } }, 405);
      return kickHandler(request, env);
    }

    if (ruta === '/setup' || ruta === '/tarea' || ruta === '/kick-test' || ruta === '/bus-test' || ruta === '/evento-discord' || ruta === '/avisar') {
      if (request.method !== 'POST') return json({ ok: false, error: { message: 'usa POST' } }, 405);
      if (!autorizado(request.headers.get('x-vants-bot'), env.VANTS_BOT_SECRET)) {
        return json({ ok: false, error: { message: 'unauthorized' } }, 401);
      }
      if (ruta === '/setup') return json(await setupComandos(env));
      if (ruta === '/tarea') return json(await cicloTarea(env));
      if (ruta === '/kick-test') return json(await kickPrueba(env));
      if (ruta === '/bus-test') return json(await busPrueba(env));
      if (ruta === '/evento-discord') {
        const bodyEv = await request.json().catch(() => null);
        return json(await eventoDiscord(env, bodyEv));
      }
      const bodyAv = await request.json().catch(() => null);
      return json(await avisar(env, bodyAv));
    }

    if (request.method !== 'POST') return json({ ok: false, error: { message: 'no_encontrado' } }, 404);

    // ── Interactions endpoint ──
    const raw = await request.text();
    if (!saltarFirma) {
      const pk = String(env.DISCORD_PUBLIC_KEY ?? '');
      const firma = request.headers.get('x-signature-ed25519') ?? '';
      const ts = request.headers.get('x-signature-timestamp') ?? '';
      if (!pk) {
        return json({ ok: false, error: { message: 'falta DISCORD_PUBLIC_KEY (wrangler secret put)' } }, 503);
      }
      if (!verificarFirma(pk, ts, raw, firma)) {
        return json({ ok: false, error: { message: 'invalid signature' } }, 401);
      }
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: { message: 'bad_request' } }, 400);
    }

    const tipo = Number(body.type ?? 0);
    if (tipo === 1) return json({ type: 1 }); // PING del portal

    // Gate de staff a nivel interaction para /vants, /fabrica y /agente
    // (defensa en profundidad: los comandos ya vienen ocultos por
    // default_member_permissions; aquí además valen roles de D1 con esStaff).
    const nombreCmd = String(body?.data?.name ?? '');
    if (
      ['vants', 'fabrica', 'agente'].includes(nombreCmd)
      && !(await esStaff(env, body, PERM.MANAGE_GUILD))
    ) {
      return json({
        type: 4,
        data: {
          flags: 64,
          content: '🚫 Este comando es solo para staff de VANTS (permiso **Gestionar servidor** o rol de staff de `/vants rol agregar`).',
        },
      });
    }

    // ── Botones (type 3 MESSAGE_COMPONENT): los de la fábrica /fabrica ──
    if (tipo === 3) {
      const customId = String(body?.data?.custom_id ?? '');
      if (!customId.startsWith('fabrica:')) {
        return json({ type: 4, data: { flags: 64, content: 'Este botón es de una versión anterior del bot.' } });
      }
      const res = await fabricaBoton(env, body).catch(
        (e) => ({ tipo: 4, data: { flags: 64, content: `Error del bot: ${txt(e?.message ?? e, 180)}` } }),
      );
      // Respuesta inmediata (error / ver estado) → efímera, sin frío.
      if (res?.tipo !== 6 || typeof res.trabajo !== 'function') {
        return json({ type: 4, data: aSalida(res?.data ?? {}) });
      }
      // Frío (etapa con cerebro): ack type 6, borramos los botones del mensaje
      // original (anti doble-clic) y publicamos el resultado como mensaje nuevo.
      const appId = appIdDeToken(String(env.DISCORD_BOT_TOKEN ?? '')) || String(env.DISCORD_APP_ID ?? '');
      const tokenInteraccion = String(body.token ?? '');
      const trabajo = dapi(null, 'PATCH', `/webhooks/${appId}/${tokenInteraccion}/messages/@original`, {
        content: res.etiqueta,
        embeds: [],
        components: [],
      })
        .then(res.trabajo)
        .then((salida) =>
          appId && tokenInteraccion
            ? dapi(null, 'POST', `/webhooks/${appId}/${tokenInteraccion}`, aSalida(salida))
            : undefined)
        .catch((e) => console.error('[vantsbot] followup de botón falló:', String(e)));
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(trabajo);
      return json({ type: 6 });
    }

    if (tipo !== 2) return json({ ok: false, error: { message: 'tipo de interaction no soportado' } }, 400);

    // Respuesta en < 3s garantizada: directo (type 4) o defer (type 5) + followup
    const trabajo = procesarComando(body, env).catch(
      (e) => ({ flags: 64, content: `Error del bot: ${txt(e?.message ?? e, 180)}` }),
    );
    let resultado = null;
    try {
      resultado = await Promise.race([trabajo, dormir(PRESUPUESTO_MS).then(() => null)]);
    } catch {
      resultado = null;
    }

    if (resultado) return json({ type: 4, data: aSalida(resultado) });

    // Frío (D1 lenta o IA de OpenAI pensando): defer y sigue en background.
    // ctx.waitUntil garantiza que el followup sobreviva tras devolver el type 5
    // (los modelos razonadores de OpenAI tardan 10-60 s, muy por encima del
    // presupuesto de 2.2 s de Discord).
    const tokenInteraccion = String(body.token ?? '');
    const appId = appIdDeToken(String(env.DISCORD_BOT_TOKEN ?? '')) || String(env.DISCORD_APP_ID ?? '');
    const envioFrio = trabajo
      .then((res) =>
        appId && tokenInteraccion
          ? dapi(null, 'POST', `/webhooks/${appId}/${tokenInteraccion}`, aSalida(res))
          : undefined)
      .catch((e) => console.error('[vantsbot] followup falló:', String(e)));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(envioFrio);
    return json({ type: 5 });
  };
}

// Entrada estática para Cloudflare: el default export DEBE ser un objeto con
// método fetch (una función suelta no registra handler y la ruta workers.dev
// nunca se activa → "There is nothing here yet"). Los tests siguen usando
// construir() con saltarFirma.
// scheduled() dispara el [triggers] de wrangler.toml (cada minuto):
//   1) cicloBus      → eventos del ecosistema VANTS → anuncios en Discord
//   2) cicloTarea    → drena la cola bot_alerts (antes solo la tiraba CI)
async function notificarPagerDuty(env, summary, dedupKey = 'vantsbot-runtime-error', details = {}) {
  const key = String((env && env.PAGERDUTY_ROUTING_KEY) || '').trim();
  const ddKey = String((env && env.DD_API_KEY) || '').trim();
  const tasks = [];
  if (key) {
    tasks.push(
      fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing_key: key,
          event_action: 'trigger',
          dedup_key: dedupKey,
          payload: {
            summary: String(summary).slice(0, 1024),
            source: 'bot.vants.cc (vantsbot Cloudflare Worker)',
            severity: 'error',
            custom_details: details,
          },
        }),
      }).catch(() => {}),
    );
  }
  if (ddKey) {
    const site = String((env && env.DD_SITE) || 'datadoghq.com').trim();
    tasks.push(
      fetch(`https://http-intake.logs.${site}/api/v2/logs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'DD-API-KEY': ddKey,
        },
        body: JSON.stringify([
          {
            ddsource: 'cloudflare-worker',
            ddtags: 'env:production,service:vantsbot,domain:bot.vants.cc',
            hostname: 'bot.vants.cc',
            service: 'vantsbot',
            status: 'error',
            message: String(summary).slice(0, 1024),
            dedup_key: dedupKey,
            details,
          },
        ]),
      }).catch(() => {}),
    );
  }
  if (tasks.length) await Promise.all(tasks);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await construir()(request, env, ctx);
    } catch (e) {
      const p = notificarPagerDuty(env, `[vantsbot] Error no controlado en fetch: ${String(e?.message || e)}`, 'vantsbot-fetch-error', {
        url: request?.url,
        method: request?.method,
      });
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
      throw e;
    }
  },
  async scheduled(controller, env, ctx) {
    const trabajo = (async () => {
      let bus = null;
      let tarea = null;
      try {
        bus = await cicloBus(env);
      } catch (e) {
        bus = { error: String(e).slice(0, 200) };
        await notificarPagerDuty(env, `[vantsbot] Fallo en cron cicloBus: ${bus.error}`, 'vantsbot-cron-bus', bus);
      }
      try {
        tarea = await cicloTarea(env);
      } catch (e) {
        tarea = { error: String(e).slice(0, 200) };
        await notificarPagerDuty(env, `[vantsbot] Fallo en cron cicloTarea: ${tarea.error}`, 'vantsbot-cron-tarea', tarea);
      }
      console.log('[vantsbot] cron:', JSON.stringify({ bus, tarea: { enviadas: tarea?.enviadas, errores: Array.isArray(tarea?.errores) ? tarea.errores.length : 0 } }));
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(trabajo);
    else await trabajo;
  },
};
