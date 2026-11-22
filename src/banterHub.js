// ============================================
// vantsbot — Motor Cloudflare del ecosistema Banter + VANTS-Clipper
// -----------------------------------------------------------------------------
// Conecta Banter (Web, Escritorio Electron y Android Capacitor) y VANTS-Clipper
// con Cloudflare D1 (`vants-db`), VANTS-BUS (`VANTS_BUS_SERVICE`) y Google Sheets.
//
// Rutas:
//   GET  /ads.txt | /banter/ads.txt -> 301 IAB one-hop a NitroPay ads-<ID>.txt
//   GET  /banter/estado             -> salud + métricas reales en D1 + config NitroPay/Sheet
//   POST /banter/registro           -> alta usuario en D1 + Google Sheets + VANTS-BUS
//   POST /banter/solicitud          -> control solicitudes en D1 + Google Sheets + VANTS-BUS
//   GET  /banter/nitro?email=...    -> entitlement Ad-Free y personalización Nitro en D1
//   POST /banter/nitro              -> activa/actualiza plan Nitro (x-vants-bot)
//   POST /banter/clipper            -> recibe clip de VANTS-Clipper -> VANTS-BUS (Discord)
// ============================================

import { autorizado, txt } from './util.js';
import { publicarBus } from './bus.js';

const BANTER_PLANS = {
  free: { id: 'free', name: 'Banter Free', adFree: false, priceUsd: 0 },
  nitro: { id: 'nitro', name: 'Banter Nitro', adFree: true, priceUsd: 4.99 },
  nitro_plus: { id: 'nitro_plus', name: 'Banter Nitro+', adFree: true, priceUsd: 9.99 },
};

const VALID_PLATFORMS = new Set(['web', 'desktop-electron', 'android-capacitor']);
const VALID_REQUEST_TYPES = new Set([
  'Acceso Beta',
  'Verificación Creador',
  'Soporte Técnico',
  'Alianza / Patrocinio',
  'Solicitud NitroPay/Ads',
  'Reembolso / Facturación',
]);

let tablasBanterListas = false;
export function resetBanterHubCacheForTests() {
  tablasBanterListas = false;
}

function corsHeaders(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-vants-bot, x-clipper-secret',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function jsonCors(req, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(req),
    },
  });
}

export function nitroAdsTxtTarget(siteId) {
  const clean = String(siteId || '').trim();
  if (!/^\d{3,10}$/.test(clean)) return null;
  return `https://api.nitropay.com/v1/ads-${clean}.txt`;
}

async function asegurarTablasBanter(db) {
  if (tablasBanterListas || !db) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS banter_users (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL DEFAULT 'web',
      plan_id TEXT NOT NULL DEFAULT 'free',
      country TEXT,
      notes TEXT,
      customization_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS banter_requests (
      id TEXT PRIMARY KEY,
      requester TEXT NOT NULL,
      email TEXT NOT NULL,
      request_type TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'web',
      priority TEXT NOT NULL DEFAULT 'Media',
      status TEXT NOT NULL DEFAULT 'Pendiente',
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS banter_subscriptions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      plan_id TEXT NOT NULL DEFAULT 'nitro',
      billing_channel TEXT NOT NULL DEFAULT 'stripe',
      ad_free INTEGER NOT NULL DEFAULT 1,
      price_usd REAL NOT NULL DEFAULT 4.99,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`),
  ]);
  tablasBanterListas = true;
}

async function reenviarGoogleSheet(env, payload, fetchImpl = fetch) {
  const webhook = String((env && env.BANTER_SHEETS_WEBHOOK_URL) || '').trim();
  if (!webhook || !/^https:\/\//.test(webhook)) return { synced: false, motivo: 'sin_webhook' };
  try {
    const r = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return { synced: r.ok, status: r.status };
  } catch (e) {
    return { synced: false, error: txt(e, 100) };
  }
}

export async function resumenBanter(env) {
  const target = nitroAdsTxtTarget(env && env.NITROPAY_SITE_ID);
  const out = {
    nitropay_site_id: target ? String(env.NITROPAY_SITE_ID).trim() : null,
    nitropay_ads_txt_301: target,
    sheet_id: (env && env.BANTER_SHEET_ID) || '1i0t2hRSAO4WT7nKlK3rzgsx4oulmrYmpTqIe6CA5ozU',
    sheets_webhook: Boolean(env && env.BANTER_SHEETS_WEBHOOK_URL),
    integraciones_binding: Boolean(env && env.VANTS_INT_SERVICE),
    usuarios: 0,
    solicitudes: 0,
    suscripciones_activas: 0,
  };
  if (env && env.DB) {
    try {
      await asegurarTablasBanter(env.DB);
      const [u, s, sub] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS n FROM banter_users').first().catch(() => ({ n: 0 })),
        env.DB.prepare('SELECT COUNT(*) AS n FROM banter_requests').first().catch(() => ({ n: 0 })),
        env.DB.prepare("SELECT COUNT(*) AS n FROM banter_subscriptions WHERE status = 'active'").first().catch(() => ({ n: 0 })),
      ]);
      out.usuarios = Number(u?.n || 0);
      out.solicitudes = Number(s?.n || 0);
      out.suscripciones_activas = Number(sub?.n || 0);
    } catch {
      // diagnóstico best-effort
    }
  }
  return out;
}

export async function rutasBanterHub(req, env, ruta, { fetchImpl = fetch } = {}) {
  const m = req.method;

  // Redirect 301 oficial IAB one-hop para NitroPay /ads.txt
  if ((ruta === '/ads.txt' || ruta === '/banter/ads.txt') && (m === 'GET' || m === 'HEAD')) {
    const target = nitroAdsTxtTarget(env && env.NITROPAY_SITE_ID);
    if (target) {
      return new Response(null, {
        status: 301,
        headers: { location: target, 'cache-control': 'public, max-age=3600' },
      });
    }
    return new Response(
      '# NitroPay ads.txt pendiente de NITROPAY_SITE_ID en vantsbot wrangler.toml\n',
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } },
    );
  }

  if (!ruta.startsWith('/banter')) return null;

  if (m === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  // GET /banter/estado
  if (ruta === '/banter/estado' && m === 'GET') {
    return jsonCors(req, { ok: true, motor: 'vantsbot-cf', ...(await resumenBanter(env)) });
  }

  // POST /banter/registro — registra usuario en D1 + Google Sheets + VANTS-BUS
  if (ruta === '/banter/registro' && m === 'POST') {
    const b = await req.json().catch(() => ({}));
    const handle = String(b.handle || '').trim().slice(0, 60);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 140);
    const platform = VALID_PLATFORMS.has(b.platform) ? b.platform : 'web';
    const planId = BANTER_PLANS[b.planId] ? b.planId : 'free';
    const country = String(b.country || '').trim().slice(0, 40) || null;
    const notes = String(b.notes || '').trim().slice(0, 300) || null;

    if (handle.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return jsonCors(req, { ok: false, error: 'datos_invalidos' }, 400);
    }

    await asegurarTablasBanter(env.DB);
    const id = 'BNT-' + Date.now().toString(36).toUpperCase();
    const nowIso = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO banter_users (id, handle, email, platform, plan_id, country, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         handle = excluded.handle,
         platform = excluded.platform,
         country = COALESCE(excluded.country, banter_users.country),
         notes = COALESCE(excluded.notes, banter_users.notes),
         updated_at = excluded.updated_at`,
    )
      .bind(id, handle, email, platform, planId, country, notes, nowIso, nowIso)
      .run();

    const [sheet, bus] = await Promise.all([
      reenviarGoogleSheet(
        env,
        { kind: 'usuario_registro', clientId: id, handle, email, platform, planId, country: country || '', notes: notes || '' },
        fetchImpl,
      ),
      publicarBus(
        env,
        'banter.user_registered',
        { title: `Nuevo usuario Banter: ${handle}`, handle, platform, plan: planId, country: country || '—' },
        fetchImpl,
      ),
    ]);

    return jsonCors(req, { ok: true, id, handle, platform, planId, sheet, bus }, 201);
  }

  // POST /banter/solicitud — registra solicitud en D1 + Google Sheets + VANTS-BUS
  if (ruta === '/banter/solicitud' && m === 'POST') {
    const b = await req.json().catch(() => ({}));
    const requester = String(b.requester || '').trim().slice(0, 80);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 140);
    const requestType = VALID_REQUEST_TYPES.has(b.requestType) ? b.requestType : 'Soporte Técnico';
    const platform = VALID_PLATFORMS.has(b.platform) ? b.platform : 'web';
    const priority = ['Alta', 'Media', 'Baja'].includes(b.priority) ? b.priority : 'Media';
    const summary = String(b.summary || '').trim().slice(0, 800);

    if (requester.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || summary.length < 8) {
      return jsonCors(req, { ok: false, error: 'datos_invalidos' }, 400);
    }

    await asegurarTablasBanter(env.DB);
    const id = 'SOL-' + Date.now().toString(36).toUpperCase();
    const nowIso = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO banter_requests (id, requester, email, request_type, platform, priority, status, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Pendiente', ?, ?)`,
    )
      .bind(id, requester, email, requestType, platform, priority, summary, nowIso)
      .run();

    const [sheet, bus] = await Promise.all([
      reenviarGoogleSheet(
        env,
        { kind: 'solicitud_banter', clientId: id, requester, email, requestType, platform, priority, summary },
        fetchImpl,
      ),
      publicarBus(
        env,
        'banter.request_created',
        { title: `Solicitud Banter · ${requestType}`, requester, platform, priority, message: summary.slice(0, 300) },
        fetchImpl,
      ),
    ]);

    return jsonCors(req, { ok: true, id, status: 'Pendiente', sheet, bus }, 201);
  }

  // GET /banter/nitro?email=... — estado de suscripción Nitro (Ad-Free + personalización)
  if (ruta === '/banter/nitro' && m === 'GET') {
    const url = new URL(req.url);
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return jsonCors(req, { ok: false, error: 'email_invalido' }, 400);
    }
    await asegurarTablasBanter(env.DB);
    const sub = await env.DB.prepare(
      "SELECT id, plan_id, billing_channel, ad_free, status, started_at, updated_at FROM banter_subscriptions WHERE email = ? AND status = 'active'",
    )
      .bind(email)
      .first();
    const user = await env.DB.prepare('SELECT handle, customization_json FROM banter_users WHERE email = ?')
      .bind(email)
      .first();

    const planId = sub && BANTER_PLANS[sub.plan_id] ? sub.plan_id : 'free';
    const plan = BANTER_PLANS[planId];
    let customization = null;
    try {
      customization = user && user.customization_json ? JSON.parse(user.customization_json) : null;
    } catch {
      customization = null;
    }
    return jsonCors(req, {
      ok: true,
      email,
      handle: (user && user.handle) || null,
      planId: plan.id,
      planName: plan.name,
      adFree: Boolean(sub ? sub.ad_free : plan.adFree),
      billingChannel: (sub && sub.billing_channel) || null,
      customization,
    });
  }

  // POST /banter/nitro — activar/actualizar suscripción Nitro (solo backend/admin con x-vants-bot)
  if (ruta === '/banter/nitro' && m === 'POST') {
    if (!autorizado(req.headers.get('x-vants-bot'), env.VANTS_BOT_SECRET)) {
      return jsonCors(req, { ok: false, error: 'unauthorized' }, 401);
    }
    const b = await req.json().catch(() => ({}));
    const email = String(b.email || '').trim().toLowerCase();
    const planId = BANTER_PLANS[b.planId] ? b.planId : 'nitro';
    const billingChannel = ['stripe', 'google-play-billing', 'partner'].includes(b.billingChannel)
      ? b.billingChannel
      : 'stripe';
    const status = ['active', 'canceled', 'expired'].includes(b.status) ? b.status : 'active';
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return jsonCors(req, { ok: false, error: 'email_invalido' }, 400);
    }

    await asegurarTablasBanter(env.DB);
    const plan = BANTER_PLANS[planId];
    const id = 'SUB-' + Date.now().toString(36).toUpperCase();
    const adFree = status === 'active' && plan.adFree ? 1 : 0;
    const nowIso = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO banter_subscriptions (id, email, plan_id, billing_channel, ad_free, price_usd, status, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         plan_id = excluded.plan_id,
         billing_channel = excluded.billing_channel,
         ad_free = excluded.ad_free,
         price_usd = excluded.price_usd,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    )
      .bind(id, email, plan.id, billingChannel, adFree, plan.priceUsd, status, nowIso, nowIso)
      .run();

    await env.DB.prepare('UPDATE banter_users SET plan_id = ?, updated_at = ? WHERE email = ?')
      .bind(status === 'active' ? plan.id : 'free', nowIso, email)
      .run()
      .catch(() => null);

    const bus = await publicarBus(
      env,
      'banter.nitro_activated',
      { title: `${plan.name} (${status})`, plan: plan.id, channel: billingChannel, adFree: Boolean(adFree) },
      fetchImpl,
    );

    return jsonCors(req, { ok: true, id, email, planId: plan.id, adFree: Boolean(adFree), status, bus });
  }

  // POST /banter/clipper — puente de VANTS-Clipper hacia VANTS-BUS -> Discord
  if (ruta === '/banter/clipper' && m === 'POST') {
    const authBot = autorizado(req.headers.get('x-vants-bot'), env.VANTS_BOT_SECRET);
    const clipperSec = String((env && env.CLIPPER_SECRET) || '').trim();
    const hdrClipper = String(req.headers.get('x-clipper-secret') || '').trim();
    const authClipper = Boolean(clipperSec && hdrClipper && hdrClipper === clipperSec);
    if (!authBot && !authClipper) {
      return jsonCors(req, { ok: false, error: 'unauthorized' }, 401);
    }
    const b = await req.json().catch(() => ({}));
    const title = String(b.title || b.titulo || 'Nuevo Short de VANTS Clipper').trim().slice(0, 140);
    const url = String(b.url || '').trim();
    const juego = String(b.juego || b.game || 'VALORANT').trim().slice(0, 40);
    const seoSource = String(b.seoSource || 'local').trim().slice(0, 30);
    const bus = await publicarBus(
      env,
      'clip.published',
      { title, url: /^https?:\/\//.test(url) ? url : undefined, juego, fuente: `VANTS-Clipper (${seoSource})` },
      fetchImpl,
    );
    return jsonCors(req, { ok: true, published: true, bus });
  }

  return jsonCors(req, { ok: false, error: 'no_encontrado' }, 404);
}
