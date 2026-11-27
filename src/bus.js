// ============================================
// vantsbot — integración con el VANTS-BUS
// (https://vants-bus.vants.workers.dev)
//
// El bot entra a la comunicación entre los proyectos del ecosistema
// (contrato de VANTS-BUS.md y clients/js/vants-bus-client.js):
//
//   CONSUMIR (cron cada minuto, cursor en D1):
//     GET /events?since=<cursor>&limit=25 firmado con
//       X-VANTS-Project · X-VANTS-Timestamp · X-VANTS-Signature
//     → match.finished/scheduled/canceled, torneos, clips, alertas,
//       sesiones, anticheat, posts → embeds en los canales configurados
//       con /vants canal resultados|agenda|clips (fallbacks: ranked,
//       registros, anuncios, staff).
//
//   PUBLICAR (disparo, best-effort: nunca rompe al llamador):
//     POST /events {"type":"stream.live","data":{...}} cuando arranca un
//       directo de Kick → la web y el launcher reaccionan en vivo.
//
// Firma HMAC-SHA256 hex de `${ts}.${rawBody}` (en GET el body es ''
// → se firma `${ts}.`). Sin VANTS_BUS_SECRET (ni binding ni URL) el módulo
// queda deshabilitado y todo degrade con mensajes claros en /salud.
// ============================================
import { createHmac } from 'node:crypto';
import { txt, dormir, dapi, dbFirst, dbRun, ROJO } from './util.js';

export const PROYECTO_DEFECTO = 'vantsbot';

// ── Cliente mínimo del bus (mismo contrato que vants-bus-client.js) ─────────

// IMPORTANTE (hallazgo en producción): Cloudflare BLOQUEA los subrequests de
// un Worker a otros *.workers.dev (error 1042). Como el bot y el bus están en
// la MISMA cuenta de Cloudflare, el transporte correcto es un Service Binding
// (env.VANTS_BUS_SERVICE → worker 'vants-bus'): same-account, sin 1042 y con
// los headers HMAC intactos (el bus valida la firma igual).
// La URL pública solo sirve para clientes fuera de Cloudflare y para humans.

function hmacHex(secret, message) {
  return createHmac('sha256', secret).update(message).digest('hex');
}

// Cliente o null si falta configuración. fetchImpl solo para tests.
export function busCliente(env, fetchImpl) {
  const secret = String(env.VANTS_BUS_SECRET ?? '');
  const binding = env.VANTS_BUS_SERVICE; // Service Binding → worker 'vants-bus'
  const busUrl = String(env.VANTS_BUS_URL ?? '').replace(/\/+$/, '');
  if (!secret || (!binding && !busUrl)) return null;
  const projectId = String(env.VANTS_BUS_PROJECT || PROYECTO_DEFECTO);
  const base = busUrl || 'https://vants-bus'; // con binding el host da igual

  // Con binding el host del Request es irrelevante (lo reescribe el runtime);
  // conservamos headers y body exactos para que la firma HMAC sea la misma.
  const enviar = fetchImpl
    ?? (binding ? ((u, i) => binding.fetch(new Request(u, i))) : undefined)
    ?? fetch;

  const headers = (rawBody) => {
    const ts = Math.floor(Date.now() / 1000).toString();
    return {
      'Content-Type': 'application/json',
      'X-VANTS-Project': projectId,
      'X-VANTS-Timestamp': ts,
      'X-VANTS-Signature': hmacHex(secret, `${ts}.${rawBody}`),
    };
  };

  const request = async (path, { method = 'GET', body = '', query = {} } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    const url = base + path + (q ? `?${q}` : '');
    const res = await enviar(url, {
      method,
      headers: headers(body),
      body: method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* respuesta no JSON */ }
    if (!res.ok) {
      const err = new Error(`VantsBus ${res.status}: ${(json && json.error) || text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  };

  return {
    projectId,
    publish: (type, data = {}) =>
      request('/events', { method: 'POST', body: JSON.stringify({ type, data }) }),
    fetchEvents: ({ since, types, sources, limit, wait } = {}) =>
      request('/events', {
        query: {
          since,
          types: Array.isArray(types) ? types.join(',') : types,
          sources: Array.isArray(sources) ? sources.join(',') : sources,
          limit,
          wait,
        },
      }),
  };
}

// Publicar best-effort: NUNCA lanza (el llamador es más importante que el bus)
export async function publicarBus(env, type, data = {}, fetchImpl) {
  try {
    const cli = busCliente(env, fetchImpl);
    if (!cli) return { ok: false, deshabilitado: true, motivo: 'falta VANTS_BUS_SECRET (o binding/URL del bus)' };
    const r = await cli.publish(type, data);
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) };
  } catch (e) {
    return { ok: false, error: txt(e?.message ?? e, 200) };
  }
}

// ── Evento → embed de Discord (defensivo: data puede traer cualquier cosa) ──

const MAPA_EVENTOS = {
  'match.finished': { canales: ['resultados', 'ranked'], color: 0x57f287, emoji: '🏁', titulo: 'Partido terminado' },
  'match.scheduled': { canales: ['agenda', 'anuncios'], color: 0x5865f2, emoji: '📅', titulo: 'Partido agendado' },
  'match.canceled': { canales: ['agenda', 'anuncios'], color: 0x99aab5, emoji: '🚫', titulo: 'Partido cancelado' },
  'tournament.inscriptions_opened': { canales: ['anuncios'], color: 0xfaa61a, emoji: '🏆', titulo: 'Inscripciones de torneo abiertas' },
  'inscription.created': { canales: ['registros'], color: 0x5865f2, emoji: '📝', titulo: 'Nueva inscripción' },
  'clip.published': { canales: ['clips', 'anuncios'], color: 0xeb459e, emoji: '🎬', titulo: 'Nuevo clip publicado' },
  'clip.highlights_ready': { canales: ['clips', 'anuncios'], color: 0xeb459e, emoji: '✨', titulo: 'Highlights listos' },
  'alert.detected': { canales: ['staff', 'logs'], color: 0xe30613, emoji: '🚨', titulo: 'Alerta detectada' },
  'game.session_started': { canales: ['registros'], color: 0x2dc770, emoji: '🎮', titulo: 'Sesión de juego iniciada' },
  'game.session_ended': { canales: ['registros'], color: 0x2dc770, emoji: '🎮', titulo: 'Sesión de juego terminada' },
  'anticheat.passed': { canales: ['registros'], color: 0x57f287, emoji: '🛡️', titulo: 'Anticheat OK' },
  'post.generated': { canales: ['anuncios'], color: 0x5865f2, emoji: '🤖', titulo: 'Post generado' },
  'stream.live': { canales: ['directos', 'anuncios'], color: 0x53fc18, emoji: '🔴', titulo: 'EN DIRECTO' },
  'banter.user_registered': { canales: ['registros', 'anuncios'], color: 0xff0d2e, emoji: '👋', titulo: 'Nuevo usuario en Banter' },
  'banter.request_created': { canales: ['staff', 'registros'], color: 0xfaa61a, emoji: '📥', titulo: 'Nueva solicitud Banter' },
  'banter.nitro_activated': { canales: ['registros', 'anuncios'], color: 0xeb459e, emoji: '⚡', titulo: 'Suscripción Banter Nitro' },
  'release.published': { canales: ['anuncios'], color: 0x57f287, emoji: '📦', titulo: 'Nueva versión disponible (WinGet)' },
  'ai.draft_created': { canales: ['staff', 'logs'], color: 16426522, emoji: '🧠', titulo: 'Borrador IA pendiente de aprobación' },
  'ai.report_ready': { canales: ['logs'], color: 5793266, emoji: '🎯', titulo: 'Reporte Scouting IA generado' },
  'ai.task_reviewed': { canales: ['logs'], color: 5763719, emoji: '✅', titulo: 'Tarea IA revisada' },
};
const DEFECTO_EVENTO = { canales: ['anuncios'], color: ROJO, emoji: '📡', titulo: '' };

// Campos dinámicos: escalares del payload (máx 6, ya limpios de @ping)
function camposDinamicos(data) {
  const campos = [];
  if (!data || typeof data !== 'object') return campos;
  for (const [k, v] of Object.entries(data)) {
    if (campos.length >= 6) break;
    if (v === null || v === undefined || typeof v === 'object') continue;
    if (['title', 'message', 'titulo', 'url'].includes(k)) continue; // ya van en title/description/url
    const nombre = txt(k, 40);
    const valor = txt(v, 200);
    if (!valor || valor === '—') continue;
    campos.push({ name: nombre, value: valor, inline: true });
  }
  return campos;
}

// Anuncia UN evento del bus en Discord. Devuelve {enviado, canal?, motivo?}
export async function anunciarEventoBus(env, ev) {
  if (ev?.type === 'stream.live' && ev?.source === 'vantsbot') {
    return { enviado: false, motivo: 'ya_anunciado_en_origen' };
  }
  const token = String(env.DISCORD_BOT_TOKEN ?? '');
  const tipo = String(ev?.type ?? '');
  const mapa = MAPA_EVENTOS[tipo] ?? DEFECTO_EVENTO;
  const data = (ev?.data && typeof ev?.data === 'object') ? ev.data : {};

  if (!token) return { enviado: false, motivo: 'falta DISCORD_BOT_TOKEN' };

  // Canal destino: primera categoría configurada de la cadena de fallback
  let canalId = null;
  let categoriaUsada = null;
  for (const cat of mapa.canales) {
    try {
      const f = await dbFirst(env, 'SELECT channel_id FROM discord_channels WHERE category = ? LIMIT 1', [cat]);
      if (f?.channel_id) {
        canalId = String(f.channel_id);
        categoriaUsada = cat;
        break;
      }
    } catch { /* sigue con el fallback */ }
  }
  if (!canalId) return { enviado: false, motivo: `sin canal: configura /vants canal ${mapa.canales[0]}` };

  const url = typeof data.url === 'string' && data.url.startsWith('http') ? data.url : undefined;
  const embed = {
    title: `${mapa.emoji} ${txt(data.title ?? data.titulo ?? mapa.titulo ?? tipo, 200)}`,
    color: mapa.color,
    footer: { text: `VANTS-BUS · ${txt(ev?.source ?? 'desconocido', 40)}` },
  };
  const desc = data.message ?? data.description;
  if (typeof desc === 'string' && desc.trim()) embed.description = txt(desc, 1500);
  if (url) embed.url = url;
  if (ev?.ts) {
    const t = new Date(ev.ts);
    if (!Number.isNaN(t.getTime())) embed.timestamp = t.toISOString();
  }
  const campos = camposDinamicos(data);
  if (campos.length) embed.fields = campos;

  const components = tipo === 'ai.draft_created' && data.task_id
    ? [{
        type: 1,
        components: [
          { type: 2, style: 3, label: '✅ Aprobar y publicar', custom_id: `ai:approve:${data.task_id}` },
          { type: 2, style: 4, label: '✖️ Rechazar', custom_id: `ai:reject:${data.task_id}` },
        ],
      }]
    : undefined;

  const r = await dapi(token, 'POST', `/channels/${canalId}/messages`, {
    embeds: [embed],
    ...(components ? { components } : {}),
    allowed_mentions: { parse: [] },
  });
  return { enviado: r.ok, canal: canalId, categoria: categoriaUsada, status: r.status, ...(r.ok ? {} : { motivo: `http:${r.status}` }) };
}

// ── Ciclo del cron: consume eventos nuevos y los anuncia ────────────────────
// Cursor en D1 (tabla bus_estado) → si un anuncio falla, igual avanzamos:
// el bus es de avisos (no de garantía) y un evento trabado bloquearía todo.
export async function cicloBus(env, fetchImpl) {
  const cli = busCliente(env, fetchImpl);
  if (!cli) return { deshabilitado: true, motivo: 'falta VANTS_BUS_SECRET (o binding/URL del bus)' };

  let since = '';
  try {
    const f = await dbFirst(env, "SELECT valor FROM bus_estado WHERE clave = 'bus_cursor' LIMIT 1");
    since = String(f?.valor ?? '');
  } catch (e) {
    return { deshabilitado: false, error: `db:${txt(e, 100)}` };
  }

  let res = null;
  try {
    res = await cli.fetchEvents({ since, limit: 25 });
  } catch (e) {
    return { deshabilitado: false, error: txt(e?.message ?? e, 200) };
  }

  const eventos = Array.isArray(res?.events) ? res.events : [];
  let anunciadas = 0;
  let sinCanal = 0;
  let fallos = 0;
  let ultimo = since;

  for (const ev of eventos) {
    if (ev?.id) ultimo = ev.id;
    try {
      const r = await anunciarEventoBus(env, ev);
      if (r.enviado) anunciadas += 1;
      else if (String(r.motivo ?? '').startsWith('sin canal')) sinCanal += 1;
      else fallos += 1;
    } catch {
      fallos += 1;
    }
    await dormir(250); // holgura anti rate-limit de Discord
  }

  const nuevoCursor = res?.cursor ? String(res.cursor) : ultimo;
  if (nuevoCursor && nuevoCursor !== since) {
    try {
      await dbRun(
        env,
        "INSERT INTO bus_estado (clave, valor, actualizado_at) VALUES ('bus_cursor', ?, datetime('now')) "
        + 'ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_at = datetime(\'now\')',
        [nuevoCursor],
      );
    } catch (e) {
      return { deshabilitado: false, recibidos: eventos.length, anunciadas, sinCanal, fallos, error: `cursor:${txt(e, 100)}` };
    }
  }

  return { deshabilitado: false, recibidos: eventos.length, anunciadas, sinCanal, fallos, cursor: nuevoCursor || null };
}

// POST /bus-test: anuncia un evento sintético por el MISMO camino del cron
// (sin tocar el bus) para verificar canales y diseño del embed.
export async function busPrueba(env) {
  const ev = {
    id: `test:${Date.now()}`,
    type: 'match.finished',
    source: 'bus-test',
    ts: new Date().toISOString(),
    data: {
      title: 'Evento de prueba del bus (esto NO es un partido real)',
      match_id: 'demo-001',
      equipo_a: 'VANTS Alpha',
      equipo_b: 'VANTS Bravo',
      score: '13 - 9',
      mapa: 'Ascent',
    },
  };
  return { ok: true, ...(await anunciarEventoBus(env, ev)) };
}
