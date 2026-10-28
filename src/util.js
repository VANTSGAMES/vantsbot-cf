// ============================================
// vantsbot — utilidades compartidas
// Firma Ed25519 (node:crypto, patrón verificado de neon-functions/vantsbot),
// REST de Discord, helpers de D1, permisos y fechas.
// ============================================
import { timingSafeEqual, createPublicKey, verify as cryptoVerify } from 'node:crypto';

export const API = 'https://discord.com/api/v10';
export const ROJO = 0xe30613; // color de marca VANTS
export const GUILD_ID_DEFECTO = '1546641331927908472'; // VANTS GAMES
export const WEB_URL_DEFECTO = 'https://vants.vants.workers.dev';

export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export function webUrl(env) {
  return String(env.VANTS_WEB_URL || WEB_URL_DEFECTO).replace(/\/+$/, '');
}

// Limpieza anti-ping (mismo patrón que _txt de agent_bridge.py / txt de vantsbot)
export function txt(valor, limite = 200) {
  let t = String(valor ?? '');
  if (valor === null || valor === undefined || valor === '') t = '—';
  t = t.replace(/@(everyone|here)/g, '@\u200b$1');
  return t.slice(0, limite);
}

// El primer segmento del token de bot ES el application id (base64url)
export function appIdDeToken(token) {
  try {
    const seg = String(token || '').split('.')[0] ?? '';
    const id = Buffer.from(seg, 'base64url').toString('utf8');
    return /^\d{17,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Verificación Ed25519 oficial de Discord (sin dependencias: node:crypto)
export function verificarFirma(publicKeyHex, timestamp, body, firmaHex) {
  try {
    if (!/^[0-9a-fA-F]{128}$/.test(firmaHex)) return false; // firma Ed25519 = 64 bytes = 128 hex
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyHex, 'hex').toString('base64url') },
      format: 'jwk',
    });
    const mensaje = Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(body, 'utf8')]);
    return cryptoVerify(null, mensaje, key, Buffer.from(firmaHex, 'hex'));
  } catch {
    return false;
  }
}

// Comparación timing-safe para el secreto de /setup y /tarea
export function autorizado(header, secret) {
  if (!secret || secret.length < 32 || !header || header.length !== secret.length) return false;
  try {
    return timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(secret, 'utf8'));
  } catch {
    return false;
  }
}

// Llamada REST a Discord (con o sin auth de bot — los followups no la llevan)
export async function dapi(token, method, path, payload, razon) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'VANTS-Bot (https://vants.vants.workers.dev, 1.0)',
  };
  if (token) headers.Authorization = `Bot ${token}`;
  if (razon) headers['X-Audit-Log-Reason'] = encodeURIComponent(String(razon).slice(0, 400));
  try {
    const r = await fetch(API + path, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* respuestas vacías (204, etc.) */
    }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: String(e) };
  }
}

// Abrir canal de DM con un usuario
export async function abrirDM(token, destinatario) {
  const r = await dapi(token, 'POST', '/users/@me/channels', { recipient_id: destinatario });
  const id = r.data?.id;
  return r.ok && id ? { ok: true, id, status: r.status } : { ok: false, status: r.status };
}

// ── D1 (base de datos de Cloudflare) ────────────────────────────────────────
export async function dbAll(env, sql, params = []) {
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return results ?? [];
}

export async function dbFirst(env, sql, params = []) {
  return await env.DB.prepare(sql).bind(...params).first();
}

export async function dbRun(env, sql, params = []) {
  return await env.DB.prepare(sql).bind(...params).run();
}

// Temporada activa: la última marcada 'active' (fallback: la 1)
export const SQL_TEMPORADA_ACTIVA =
  "COALESCE((SELECT id FROM seasons WHERE status = 'active' ORDER BY season_number DESC LIMIT 1), 1)";

// ── Permisos del miembro que invocó (bitmask en string) ─────────────────────
export const PERM = {
  ADMIN: 0x8n,
  KICK: 0x2n,
  BAN: 0x4n,
  MANAGE_CHANNELS: 0x10n,
  MANAGE_GUILD: 0x20n,
  MANAGE_MESSAGES: 0x2000n,
  MODERATE_MEMBERS: 0x10000000000n, // 2^40 = 1099511627776 (timeout members)
};

export function permisosDe(body) {
  try {
    return BigInt(String(body?.member?.permissions ?? '0'));
  } catch {
    return 0n;
  }
}

export function tienePerm(permisos, ...bits) {
  return bits.some((b) => (permisos & b) === b);
}

// Gate de staff en 3 capas (defensa en profundidad sobre default_member_permissions):
//   1. el miembro tiene alguno de los bits pedidos de Discord, o
//   2. es Administrador, o
//   3. tiene un rol registrado en roles_admin (D1, gestionado con /vants rol).
// El dueño del servidor pasa por (1): Discord le envía el bitfield completo.
// body.member.roles llega siempre en interacciones de guild (array de ids).
export async function esStaff(env, body, ...bits) {
  if (tienePerm(permisosDe(body), PERM.ADMIN, ...bits)) return true;
  const guildId = String(body?.guild_id ?? '');
  const roles = Array.isArray(body?.member?.roles) ? body.member.roles.map(String) : [];
  if (!guildId || !roles.length) return false;
  try {
    const filas = await dbAll(env, 'SELECT role_id FROM roles_admin WHERE guild_id = ?', [guildId]);
    const staff = new Set(filas.map((f) => String(f.role_id)));
    return roles.some((r) => staff.has(r));
  } catch {
    return false; // si D1 falla, valen solo los permisos de Discord
  }
}

// ── Fechas (D1 guarda TEXT ISO; Postgres daba timestamptz) ──────────────────
export function fmtFecha(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'fecha por confirmar';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${mi} UTC`;
}

export const ahoraISO = () => new Date().toISOString();

// ── Embeds base ──────────────────────────────────────────────────────────────
export function embedBase(title, description) {
  const e = { title, color: ROJO };
  if (description) e.description = description;
  return e;
}

export function campo(e, name, value, inline = false) {
  e.fields = e.fields ?? [];
  e.fields.push({ name, value, inline });
  return e;
}

// Fila de botones con enlaces (como discord.ui.View + Button style=link)
export function botonEnlaces(...pares) {
  if (!pares.length) return undefined;
  return [
    {
      type: 1,
      components: pares.map(([label, url]) => ({ type: 2, style: 5, label, url })),
    },
  ];
}

// Avatar de un usuario de Discord (fallback al avatar por defecto)
export function avatarDe(user) {
  if (!user) return undefined;
  if (user.avatar) {
    const ext = String(user.avatar).startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
  }
  const idx = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

// Nombre visible de un miembro (nick > global_name > username)
export function nombreVisible(member, user) {
  return txt(member?.nick || user?.global_name || user?.username || '—', 48);
}

// Usuario objetivo de una opción type USER (resolved)
export function usuarioDeOpcion(body, nombre = 'usuario') {
  const data = body?.data ?? {};
  const opt = (data.options ?? []).find((o) => o.name === nombre);
  if (!opt) return null;
  const id = String(opt.value);
  const u = data.resolved?.users?.[id];
  const m = data.resolved?.members?.[id];
  return u ? { id, user: u, member: m ?? null } : null;
}
