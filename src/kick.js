// ============================================
// vantsbot — aviso de directos de Kick
// Recibe los webhooks de la app de Kick (developers.kick.com) del dueño:
//   POST /kick  → challenge de verificación + eventos livestream.*
//
// Contrato Kick Dev API (EventSub):
//   Headers: X-Kick-Event-Type · X-Kick-Event-Id · X-Kick-Signature (HMAC-SHA256
//   hex del body crudo con el Client Secret de la app) · X-Kick-Event-Time
//   Verificación: envía X-Kick-Event-Type: webhook.callback.verify con body
//   {"challenge": "..."} → hay que responder 200 con el challenge tal cual.
//   Evento de directo: livestream.status.updated { is_live, title, started_at,
//   broadcaster_username, categories[] }
//
// Al ir EN DIRECTO: embed verde de Kick en el canal configurado como
// 'directos' (fallback 'anuncios') con botón al canal. Dedupe por
// X-Kick-Event-Id en web_events (D1) para no repetir en reintentos.
// ============================================
import { createHmac } from 'node:crypto';
import { txt, fmtFecha, dapi, dbRun, dbFirst } from './util.js';
import { publicarBus } from './bus.js';

const VERDE_KICK = 0x53fc18;

// HMAC-SHA256 hex del body crudo con el Client Secret (formato Kick;
// se acepta también con prefijo "sha256=" por si cambia la convención)
function firmaValida(raw, firmaHeader, secret) {
  if (!secret) return true; // sin secret configurado no se puede verificar
  if (!firmaHeader) return false;
  const esperada = createHmac('sha256', secret).update(raw).digest('hex');
  const recibida = String(firmaHeader).replace(/^sha256=/i, '').toLowerCase();
  return recibida === esperada;
}

export async function kickHandler(request, env) {
  const raw = await request.text();
  const tipo = request.headers.get('x-kick-event-type') ?? '';
  const firma = request.headers.get('x-kick-signature') ?? '';
  const eventId = request.headers.get('x-kick-event-id') ?? '';
  const secret = String(env.KICK_CLIENT_SECRET ?? '');

  if (!firmaValida(raw, firma, secret)) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 1) Challenge de verificación: responder el string tal cual (texto plano)
  if (tipo === 'webhook.callback.verify' || raw.includes('"challenge"')) {
    try {
      const body = JSON.parse(raw);
      if (typeof body.challenge === 'string') {
        return new Response(body.challenge, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    } catch {
      /* seguimos: quizá es un evento con "challenge" en otro campo */
    }
  }

  // 2) Eventos de livestream (status y metadata)
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const esLivestream = tipo.startsWith('livestream.') || Array.isArray(body?.categories) || 'is_live' in (body ?? {});
  if (!esLivestream) return Response.json({ ok: true, ignorado: tipo || 'sin tipo' });

  if (body.is_live !== true) {
    // Se despidió el directo o metadata sin is_live: no se anuncia
    return Response.json({ ok: true, accion: 'sin_aviso', is_live: body.is_live ?? null });
  }

  // Dedupe por event id (Kick reintenta con el mismo id)
  const dedupeId = 'kick:' + (eventId || `sha:${tipo}:${body.broadcaster_user_id ?? ''}:${body.started_at ?? ''}`);
  let nuevo = true;
  try {
    const res = await dbRun(
      env,
      "INSERT INTO web_events (event_id, kind, severity, page, payload) VALUES (?, 'kick_live', 'info', 'kick', ?) "
      + 'ON CONFLICT (event_id) DO NOTHING RETURNING id',
      [dedupeId.slice(0, 120), raw.slice(0, 4000)],
    );
    nuevo = (res?.meta?.changes ?? 0) > 0;
  } catch {
    /* si falla el dedupe igual anunciamos (mejor doble aviso que ninguno) */
  }
  if (!nuevo) return Response.json({ ok: true, duplicado: true });

  const anuncio = await publicarAvisoDirecto(env, {
    username: body.broadcaster_username || body.broadcaster_channel_name || env.KICK_USERNAME || 'VANTS',
    titulo: body.title ?? '',
    categoria: Array.isArray(body.categories) && body.categories[0]?.name ? body.categories[0].name : '',
    startedAt: body.started_at ?? null,
  });

  // El directo también viaja al VANTS-BUS (stream.live) para que la web,
  // el launcher y los agentes reaccionen. Best-effort: si el bus no está
  // configurado o rechaza el tipo, el aviso de Discord ya salió igual.
  const publicacionBus = await publicarBus(env, 'stream.live', {
    platform: 'kick',
    username: body.broadcaster_username ?? body.broadcaster_channel_name ?? env.KICK_USERNAME ?? null,
    title: body.title ?? null,
    categoria: Array.isArray(body.categories) && body.categories[0]?.name ? body.categories[0].name : null,
    started_at: body.started_at ?? null,
    url: body.broadcaster_username
      ? `https://kick.com/${encodeURIComponent(String(body.broadcaster_username).slice(0, 40))}`
      : null,
  });

  return Response.json({ ok: true, ...anuncio, bus: publicacionBus });
}

// Construye y publica el embed de directo en 'directos' (fallback 'anuncios')
export async function publicarAvisoDirecto(env, { username, titulo, categoria, startedAt }) {
  const token = String(env.DISCORD_BOT_TOKEN ?? '');
  if (!token) return { avisado: false, error: 'falta DISCORD_BOT_TOKEN' };

  let canalId = null;
  for (const cat of ['directos', 'anuncios']) {
    try {
      const f = await dbFirst(env, 'SELECT channel_id FROM discord_channels WHERE category = ? LIMIT 1', [cat]);
      if (f?.channel_id) {
        canalId = String(f.channel_id);
        break;
      }
    } catch {
      /* sigue con el fallback */
    }
  }
  if (!canalId) return { avisado: false, error: 'sin canal: configura /vants canal directos' };

  const slug = txt(username, 40);
  const url = `https://kick.com/${encodeURIComponent(slug)}`;
  const embed = {
    title: `🔴 ${slug} está EN DIRECTO en Kick`,
    url,
    description: titulo ? txt(titulo, 300) : '¡Pásate por el directo!',
    color: VERDE_KICK,
    footer: { text: 'VANTS GAMES · Kick' },
  };
  if (categoria) {
    embed.fields = [{ name: '🎮 Categoría', value: txt(categoria, 40), inline: true }];
  }
  if (startedAt) {
    embed.fields = embed.fields ?? [];
    embed.fields.push({ name: '🕒 Empezó', value: fmtFecha(startedAt), inline: true });
  }

  const mencion = String(env.KICK_MENCION ?? '').slice(0, 100);
  const r = await dapi(token, 'POST', `/channels/${canalId}/messages`, {
    ...(mencion ? { content: mencion } : {}),
    embeds: [embed],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Ver en Kick', url }] }],
    allowed_mentions: { parse: mencion ? ['everyone', 'roles'] : [] },
  });
  return { avisado: r.ok, canal: canalId, status: r.status };
}

// POST /kick-test (x-vants-bot): publica un aviso de prueba sin estar en directo
export async function kickPrueba(env) {
  const r = await publicarAvisoDirecto(env, {
    username: String(env.KICK_USERNAME ?? 'vants'),
    titulo: 'Prueba del aviso de directos de VANTS (esto NO es un directo real)',
    categoria: 'Just Chatting',
    startedAt: new Date().toISOString(),
  });
  return r;
}
