// ============================================
// vantsbot — puente con el ecosistema VANTS (los "demás" del repo)
//
// 1) /evento-discord  → MISMO contrato que la Neon Function vantsbot: el
//    Worker de la web (vants-server/worker.js → /api/discord/events) ya
//    verifica la firma Ed25519 y reenvía aquí con auth x-vants-bot. Solo hay
//    que apuntar VANTS_BOT_URL del web worker a este Cloudflare Worker.
//    Guarda en web_events (D1) y avisa por DM de compras/instalaciones.
//
// 2) /avisar          → ruta interna genérica (x-vants-bot) para que cualquier
//    servicio del repo (supervisor, discord-notify, matchmaking-service,
//    el Agente VANTS, la web VANTS AI) empuje avisos a Discord:
//      { "category": "staff", "channel_id": "opcional", "dm": "user_id opcional",
//        "title": "...", "message": "...", "color": 16711680 }
//
// 3) /agente          → mando del dueño sobre el Agente VANTS
//    (services/agent-service): estado, informe, incidentes, resolver, comando.
//    Habla HTTP con AGENTE_URL (/api/v1/*) con Bearer AGENTE_TOKEN — el mismo
//    papel que ORION hacía con commands/agente.py + agent_bridge.py.
//
// 4) /soporte pregunta → chat con el agente de soporte de la web VANTS AI
//    (vants-ai.vercel.app → POST /api/chat, modelo GLM).
// ============================================
import { createHash } from 'node:crypto';
import { txt, dapi, abrirDM, dbRun, dbFirst, embedBase, campo, esStaff, PERM } from './util.js';
import { comandoIaCore } from './aiBridge.js';

const TIPOS_DM = new Set(['ENTITLEMENT_CREATE', 'ENTITLEMENT_UPDATE', 'APPLICATION_AUTHORIZED']);
const DM_DUENO_DEFECTO = '1532612429295521930'; // dueño (mismo default que agent_bridge.py)
const COLORES_ESTADO = { UP: 0x3ddc84, DEGRADED: 0xffb547, DOWN: 0xed4245 };

// ── 1) /evento-discord (contrato de vantsbot, ahora en D1) ──────────────────
export async function eventoDiscord(env, body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_request' };
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : body;
  const data = payload.data ?? {};
  const tipo = String(data.type ?? payload.type ?? 'evento').slice(0, 60);
  let eventoId = String(body.evento_id ?? '').slice(0, 120);
  if (!eventoId) {
    // mismo dedupe que la Neon Function: sha256 del payload
    eventoId = 'discord:' + createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 40);
  }

  let guardado = false;
  try {
    const res = await dbRun(
      env,
      'INSERT INTO web_events (event_id, kind, severity, page, payload) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT (event_id) DO NOTHING',
      [eventoId, 'discord_event', 'info', 'discord', JSON.stringify(payload).slice(0, 4000)],
    );
    guardado = (res?.meta?.changes ?? 0) > 0;
  } catch (e) {
    return { ok: false, error: txt(e?.message ?? e, 120) };
  }

  // Compras e instalación de la app → DM al dueño (si hay token)
  let dm = null;
  const token = String(env.DISCORD_BOT_TOKEN ?? '');
  if (TIPOS_DM.has(tipo) && token) {
    const dmId = String(env.SUPERVISOR_DM_ID || DM_DUENO_DEFECTO);
    const canal = await abrirDM(token, dmId);
    if (canal.ok && canal.id) {
      const r = await dapi(token, 'POST', `/channels/${canal.id}/messages`, {
        embeds: [{
          title: `Discord · ${tipo}`,
          description: '```json\n' + txt(JSON.stringify(data), 600) + '\n```',
          color: 0x57f287,
        }],
        allowed_mentions: { parse: [] },
      });
      dm = r.ok ? 'enviado' : `fallo:${r.status}`;
    } else {
      dm = `dm:${canal.status}`;
    }
  }
  return { ok: true, guardado, evento_id: eventoId, ...(dm ? { dm } : {}) };
}

// ── 2) /avisar (puente de notificaciones para los demás servicios) ──────────
export async function avisar(env, body) {
  const token = String(env.DISCORD_BOT_TOKEN ?? '');
  if (!token) return { ok: false, error: 'falta DISCORD_BOT_TOKEN' };
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_request' };

  const titulo = txt(body.title ?? 'Aviso VANTS', 250);
  const mensaje = txt(body.message ?? '', 1800) || '—';
  const color = Number.isFinite(Number(body.color)) ? Number(body.color) >>> 0 : 0xe30613;
  const embed = { title: titulo, description: mensaje, color };

  let destino = body.channel_id ? String(body.channel_id) : null;
  if (!destino && body.category) {
    try {
      const f = await dbFirst(env, 'SELECT channel_id FROM discord_channels WHERE category = ? LIMIT 1', [
        String(body.category).slice(0, 40),
      ]);
      destino = f?.channel_id ? String(f.channel_id) : null;
    } catch {
      /* sin canal configurado */
    }
  }

  const salida = { ok: true, canal: null, dm: null };
  if (destino) {
    const r = await dapi(token, 'POST', `/channels/${destino}/messages`, {
      embeds: [embed],
      allowed_mentions: { parse: ['roles', 'users'] },
    });
    salida.canal = r.ok ? 'enviado' : `http:${r.status}`;
  }
  if (body.dm && /^\d{15,21}$/.test(String(body.dm))) {
    const canal = await abrirDM(token, String(body.dm));
    if (canal.ok && canal.id) {
      const r = await dapi(token, 'POST', `/channels/${canal.id}/messages`, {
        embeds: [embed],
        allowed_mentions: { parse: [] },
      });
      salida.dm = r.ok ? 'enviado' : `fallo:${r.status}`;
    } else {
      salida.dm = `dm:${canal.status}`;
    }
  }
  if (!salida.canal && !salida.dm) {
    salida.ok = false;
    salida.error = 'sin destino: pasa channel_id/category o dm';
  }
  return salida;
}

// ── 3) /agente (mando sobre services/agent-service) ─────────────────────────
function agenteUrl(env) {
  return String(env.AGENTE_URL ?? '').replace(/\/+$/, '');
}

async function llamarAgente(env, metodo, ruta, payload) {
  const base = agenteUrl(env);
  if (!base) return { ok: false, status: 0, data: 'AGENTE_URL no configurada' };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'vantsbot-cf/1.0' };
  const t = String(env.AGENTE_TOKEN ?? '');
  if (t) headers.Authorization = `Bearer ${t}`;
  try {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* respuesta vacía */
    }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: String(e?.message ?? e) };
  }
}

// Render defensivo: el agent-service devuelve {ok, estado:{...}} u objetos
// propios; si no reconocemos la forma, mostramos JSON en codeblock.
function renderAgente(sub, data, status) {
  if (!data || typeof data !== 'object') {
    return { flags: 64, content: '```\n' + txt(data, 1500) + '\n(HTTP ' + status + ')\n```' };
  }
  const estado = data.estado ?? data;
  const global = String(estado.estado_global ?? '').toUpperCase();
  const incidentes = Array.isArray(data.incidentes) ? data.incidentes : (Array.isArray(estado.incidentes) ? estado.incidentes : []);

  if (sub === 'estado' || sub === 'informe' || global) {
    const e = {
      title: 'Agente VANTS · estado',
      color: COLORES_ESTADO[global] ?? 0x5865f2,
      description: global ? `Estado global: **${global}**` : 'El agente no reporta estado global.',
    };
    if (estado.started_at) campo(e, 'Último ciclo', txt(estado.started_at, 16), true);
    if (estado.fuente || estado.modo) campo(e, 'Fuente', `${txt(estado.fuente, 12)} / ${txt(estado.modo, 12)}`, true);
    if (estado.resumen) campo(e, 'Resumen', txt(estado.resumen, 200));
    if (estado.error) campo(e, 'Error', txt(estado.error, 200));
    if (incidentes.length) {
      campo(
        e,
        `Incidentes abiertos (${incidentes.length})`,
        incidentes
          .map((i) => `\`#${i.id ?? '?'}\` ${txt(i.severity, 8)} ${txt(i.titulo, 90)}`)
          .join('\n')
          .slice(0, 1000),
      );
    } else if (sub === 'estado' || sub === 'informe') {
      campo(e, 'Incidentes abiertos', 'Ninguno ✅');
    }
    e.footer = { text: 'Agente VANTS · services/agent-service' };
    return { flags: 64, embeds: [e] };
  }

  if (sub === 'incidentes') {
    if (!incidentes.length) return { flags: 64, content: 'Sin incidentes abiertos ✅' };
    return {
      flags: 64,
      content:
        '**Incidentes abiertos**\n'
        + incidentes
          .map((i) => `\`#${i.id ?? '?'}\` ${txt(i.severity, 8)} ${txt(i.titulo, 90)}`)
          .join('\n')
          .slice(0, 1800),
    };
  }

  // respuesta genérica (resolver/comando/cola)
  const texto = data.respuesta ?? data.resultado ?? data.mensaje ?? JSON.stringify(data);
  return { flags: 64, content: '```\n' + txt(texto, 1800) + '\n```' };
}

export async function agente(env, body) {
  // El control del Agente (estado, órdenes libres, resolver incidentes) es staff.
  if (!(await esStaff(env, body, PERM.MANAGE_GUILD))) {
    return {
      flags: 64,
      content: '🚫 El Agente VANTS solo lo maneja el staff (permiso **Gestionar servidor** o rol de `/vants rol agregar`).',
    };
  }
  const sub = String((body?.data?.options ?? [])[0]?.name ?? 'estado');
  const subOpts = (body?.data?.options ?? [])[0]?.options ?? [];
  const optVal = (n) => subOpts.find((o) => o.name === n)?.value;

  if (!agenteUrl(env)) {
    return {
      flags: 64,
      content:
        '⚠️ **AGENTE_URL no configurada** en el Worker.\n'
        + 'Levanta `services/agent-service` (`node server.js`, puerto 8082), expón la URL y:\n'
        + '`npx wrangler secret put AGENTE_URL` + `npx wrangler secret put AGENTE_TOKEN`.\n'
        + 'Mientras tanto el Agente VANTS sigue su ciclo cada 30 min (workflow `agente.yml`) '
        + 'y los avisos pueden llegar por `/avisar` desde cualquier servicio.',
    };
  }

  let res;
  if (sub === 'estado') res = await llamarAgente(env, 'GET', '/api/v1/estado');
  else if (sub === 'incidentes') res = await llamarAgente(env, 'GET', '/api/v1/incidentes');
  else if (sub === 'informe') {
    const [a, b] = await Promise.all([
      llamarAgente(env, 'GET', '/api/v1/estado'),
      llamarAgente(env, 'GET', '/api/v1/incidentes'),
    ]);
    res = a.ok ? { ...a, data: { ...a.data, incidentes: b.ok ? b.data?.incidentes ?? b.data : [] } } : a;
  } else if (sub === 'resolver') {
    const id = Number(optVal('id_incidente') ?? 0);
    res = await llamarAgente(env, 'POST', '/api/v1/comando', { texto: `resolver ${id}` });
  } else {
    const texto = String(optVal('texto') ?? '').slice(0, 500);
    res = await llamarAgente(env, 'POST', '/api/v1/comando', { texto });
  }

  if (!res.ok && res.status === 0) {
    return {
      flags: 64,
      content: `❌ No pude contactar con el Agente VANTS (\`${agenteUrl(env)}\`).\nMotivo: ${txt(res.data, 160)}\n¿Está corriendo \`services/agent-service\`?`,
    };
  }
  if (!res.ok) {
    return { flags: 64, content: `❌ El agente respondió HTTP ${res.status}: ${txt(JSON.stringify(res.data), 400)}` };
  }
  return renderAgente(sub, res.data, res.status);
}

// ── 4) Soporte IA (VANTS Core AI primero, respaldo web VANTS AI) ─────────────
export async function soporteIA(env, pregunta, body = null) {
  const core = await comandoIaCore(env, body, pregunta).catch(() => null);
  if (core) return core;

  const hq = String(env.AGENTE_HQ_URL || 'https://vants-ai.vercel.app').replace(/\/+$/, '');
  try {
    const r = await fetch(hq + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'vantsbot-cf/1.0' },
      body: JSON.stringify({ mensaje: String(pregunta).slice(0, 2000), historial: [] }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data?.respuesta) throw new Error(`HTTP ${r.status}`);
    const e = embedBase('🤖 Vants Soporte', txt(data.respuesta, 1800));
    e.footer = { text: `VANTS AI${data.modelo ? ` · ${data.modelo}` : ''} · ${hq}` };
    return { flags: 64, embeds: [e] };
  } catch {
    return {
      flags: 64,
      content:
        '❌ El agente de soporte no respondió ahora mismo.\n'
        + `Prueba otra vez en un rato o usa el chat de la web: ${hq}`,
    };
  }
}
