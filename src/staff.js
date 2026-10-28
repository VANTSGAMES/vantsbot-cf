// ============================================
// vantsbot — comandos de staff (espejo de bot/commands/moderacion.py)
// /vants canal|estado|rol · /warn /kick /ban /mute /unmute /clear /lock /unlock
// · /informe
// Permisos: triple capa — Discord OCULTA los comandos (default_member_permissions),
// los roles de roles_admin (D1, /vants rol agregar) reciben override de visibilidad,
// y aquí se revalida con esStaff() (permiso de Discord O rol de staff O admin).
// El bot necesita los permisos equivalentes en su rol del servidor.
// Toda acción queda registrada en mod_logs (D1).
// ============================================
import {
  ROJO, txt, dapi, abrirDM, dbAll, dbFirst, dbRun,
  permisosDe, tienePerm, esStaff, PERM, ahoraISO, appIdDeToken,
} from './util.js';

const optVal = (body, n) => (body?.data?.options ?? []).find((o) => o.name === n)?.value;

function sinPermiso(que) {
  return { flags: 64, content: `🚫 Necesitas el permiso **${que}** para usar este comando.` };
}

function noEncontrado() {
  return { flags: 64, content: '❌ No pude resolver a ese usuario (¿sigue en el servidor?).' };
}

async function registrarMod(env, guildId, moderadorId, objetivoId, accion, razon, canalId) {
  try {
    await dbRun(
      env,
      'INSERT INTO mod_logs (guild_id, moderador_id, objetivo_id, accion, razon, canal_id) VALUES (?, ?, ?, ?, ?, ?)',
      [guildId, moderadorId, objetivoId ?? null, accion, razon ?? null, canalId ?? null],
    );
  } catch {
    /* el log no debe romper la acción */
  }
}

// ── /warn ────────────────────────────────────────────────────────────────────
export async function warn(env, body, token, guildId) {
  if (!(await esStaff(env, body, PERM.MANAGE_MESSAGES, PERM.MANAGE_GUILD))) {
    return sinPermiso('Gestionar mensajes');
  }
  const objetivo = (body?.data?.resolved?.users ?? {})[String(optVal(body, 'usuario') ?? '')];
  if (!objetivo) return noEncontrado();
  const razon = txt(optVal(body, 'razon'), 400);
  const moderadorId = String(body.member?.user?.id ?? body.user?.id ?? '');

  let dm = '✅ le llegó por DM';
  const canal = await abrirDM(token, objetivo.id);
  if (canal.ok && canal.id) {
    const r = await dapi(token, 'POST', `/channels/${canal.id}/messages`, {
      embeds: [{
        title: '⚠️ Advertencia de VANTS GAMES',
        description: `**Razón:** ${razon}`,
        color: 0xffb547,
        footer: { text: 'Comportá el comportamiento; la reincidencia agrava la sanción.' },
      }],
      allowed_mentions: { parse: [] },
    });
    if (!r.ok) dm = r.status === 403 ? '⚠️ no acepta DMs' : `⚠️ DM falló (${r.status})`;
  } else {
    dm = '⚠️ no acepta DMs';
  }
  await registrarMod(env, guildId, moderadorId, objetivo.id, 'warn', razon, body.channel_id);
  return {
    flags: 64,
    content: `⚠️ **${objetivo.username}** advertido — ${razon}\nDM: ${dm}`,
  };
}

// ── /kick ────────────────────────────────────────────────────────────────────
export async function kick(env, body, token, guildId) {
  if (!(await esStaff(env, body, PERM.KICK))) return sinPermiso('Expulsar miembros');
  const id = String(optVal(body, 'usuario') ?? '');
  const enServidor = Boolean((body?.data?.resolved?.members ?? {})[id]);
  const objetivo = (body?.data?.resolved?.users ?? {})[id];
  if (!objetivo || !enServidor) return noEncontrado();
  const razon = txt(optVal(body, 'razon'), 400);

  const r = await dapi(token, 'DELETE', `/guilds/${guildId}/members/${objetivo.id}`, undefined, razon);
  if (!r.ok) {
    const extra = r.status === 403 ? ' (¿jerarquía de roles o me falta el permiso?)' : '';
    return { flags: 64, content: `❌ No pude expulsarlo (HTTP ${r.status})${extra}.` };
  }
  await registrarMod(env, guildId, String(body.member?.user?.id ?? ''), objetivo.id, 'kick', razon);
  return { flags: 64, content: `👢 **${objetivo.username}** expulsado — ${razon}` };
}

// ── /ban ─────────────────────────────────────────────────────────────────────
export async function ban(env, body, token, guildId) {
  if (!(await esStaff(env, body, PERM.BAN))) return sinPermiso('Banear miembros');
  const id = String(optVal(body, 'usuario') ?? '');
  const objetivo = (body?.data?.resolved?.users ?? {})[id];
  if (!objetivo) return noEncontrado();
  const razon = txt(optVal(body, 'razon'), 400);
  const dias = Math.max(0, Math.min(7, Number(optVal(body, 'borrar_dias') ?? 0)));

  const r = await dapi(
    token,
    'PUT',
    `/guilds/${guildId}/bans/${objetivo.id}`,
    { delete_message_seconds: dias * 86400 },
    razon,
  );
  if (!r.ok && r.status !== 404) {
    const extra = r.status === 403 ? ' (¿jerarquía de roles o me falta el permiso?)' : '';
    return { flags: 64, content: `❌ No pude banearlo (HTTP ${r.status})${extra}.` };
  }
  await registrarMod(env, guildId, String(body.member?.user?.id ?? ''), objetivo.id, 'ban', razon);
  return { flags: 64, content: `🔨 **${objetivo.username}** baneado — ${razon}${dias ? ` (mensajes de ${dias}d borrados)` : ''}` };
}

// ── /mute (timeout) ──────────────────────────────────────────────────────────
export async function mute(env, body, token, guildId) {
  if (!(await esStaff(env, body, PERM.MODERATE_MEMBERS))) return sinPermiso('Tiempo de espera (Timeout)');
  const id = String(optVal(body, 'usuario') ?? '');
  const enServidor = Boolean((body?.data?.resolved?.members ?? {})[id]);
  const objetivo = (body?.data?.resolved?.users ?? {})[id];
  if (!objetivo || !enServidor) return noEncontrado();
  const minutos = Math.max(1, Math.min(40320, Number(optVal(body, 'minutos') ?? 10)));
  const razon = txt(optVal(body, 'razon'), 400);

  const hasta = new Date(Date.now() + minutos * 60000).toISOString();
  const r = await dapi(
    token,
    'PATCH',
    `/guilds/${guildId}/members/${objetivo.id}`,
    { communication_disabled_until: hasta },
    razon,
  );
  if (!r.ok) {
    const extra = r.status === 403 ? ' (¿me falta "Tiempo de espera"?)' : '';
    return { flags: 64, content: `❌ No pude silenciarlo (HTTP ${r.status})${extra}.` };
  }
  await registrarMod(env, guildId, String(body.member?.user?.id ?? ''), objetivo.id, 'mute', `${razon} (${minutos} min)`);
  return { flags: 64, content: `🔇 **${objetivo.username}** silenciado ${minutos} min — ${razon}` };
}

// ── /unmute ──────────────────────────────────────────────────────────────────
export async function unmute(env, body, token, guildId) {
  if (!(await esStaff(env, body, PERM.MODERATE_MEMBERS))) return sinPermiso('Tiempo de espera (Timeout)');
  const id = String(optVal(body, 'usuario') ?? '');
  const objetivo = (body?.data?.resolved?.users ?? {})[id];
  if (!objetivo) return noEncontrado();

  const r = await dapi(
    token,
    'PATCH',
    `/guilds/${guildId}/members/${objetivo.id}`,
    { communication_disabled_until: null },
    'unmute',
  );
  if (!r.ok) return { flags: 64, content: `❌ No pude quitar el silencio (HTTP ${r.status}).` };
  await registrarMod(env, guildId, String(body.member?.user?.id ?? ''), objetivo.id, 'unmute', null);
  return { flags: 64, content: `🔊 **${objetivo.username}** puede hablar de nuevo.` };
}

// ── /clear ───────────────────────────────────────────────────────────────────
export async function clear(env, body, token, guildId) {
  if (!(await esStaff(env, body, PERM.MANAGE_MESSAGES))) return sinPermiso('Gestionar mensajes');
  const cantidad = Math.max(1, Math.min(100, Number(optVal(body, 'cantidad') ?? 5)));
  const canalId = String(body.channel_id ?? '');

  const r = await dapi(token, 'GET', `/channels/${canalId}/messages?limit=${cantidad}`);
  if (!r.ok || !Array.isArray(r.data)) {
    return { flags: 64, content: `❌ No pude leer los mensajes (HTTP ${r.status}).` };
  }
  const LIMITE_14D = Date.now() - 13.5 * 86400000;
  const borrales = r.data.filter((m) => {
    if (m.pinned) return false;
    const ts = Date.parse(m.timestamp);
    return !Number.isNaN(ts) && ts >= LIMITE_14D;
  });
  const fijados = r.data.length - borrales.length;

  let borrados = 0;
  if (borrales.length >= 2) {
    const rb = await dapi(token, 'POST', `/channels/${canalId}/messages/bulk-delete`, {
      messages: borrales.map((m) => m.id),
    });
    if (rb.ok) borrados = borrales.length;
  } else if (borrales.length === 1) {
    const r1 = await dapi(token, 'DELETE', `/channels/${canalId}/messages/${borrales[0].id}`);
    if (r1.ok) borrados = 1;
  }
  await registrarMod(env, guildId, String(body.member?.user?.id ?? ''), null, 'clear', `${borrados} mensajes`, canalId);
  let msg = borrados
    ? `🗑️ ${borrados} mensaje(s) borrados.`
    : '🗑️ Nada que borrar (solo hay mensajes fijados o de más de 14 días).';
  if (fijados > 0) msg += `\n📌 ${fijados} fijado(s) o antiguo(s) se conservaron.`;
  return { flags: 64, content: msg };
}

// ── /lock y /unlock (overwrites de @everyone, preservando lo existente) ──────
const SEND_MESSAGES = '800';   // 0x800
const VIEW_CHANNEL = '400';    // 0x400

async function overwriteCanal(env, body, token, guildId, bloquear) {
  if (!(await esStaff(env, body, PERM.MANAGE_CHANNELS))) return sinPermiso('Gestionar canales');
  const canalId = String(body.channel_id ?? '');
  const accion = bloquear ? 'lock' : 'unlock';

  const actual = await dapi(token, 'GET', `/channels/${canalId}/permissions/${guildId}`);
  let allow = actual.ok && actual.data?.allow ? String(actual.data.allow) : VIEW_CHANNEL;
  let deny = actual.ok && actual.data?.deny ? String(actual.data.deny) : '0';

  const allowBits = BigInt(`0x${allow}`);
  const denyBits = BigInt(`0x${deny}`);
  const enviar = BigInt(`0x${SEND_MESSAGES}`);
  const nuevoAllow = bloquear ? (allowBits & ~enviar) : (allowBits | enviar);
  const nuevoDeny = bloquear ? (denyBits | enviar) : (denyBits & ~enviar);

  const r = await dapi(
    token,
    'PUT',
    `/channels/${canalId}/permissions/${guildId}`,
    { type: 0, id: guildId, allow: nuevoAllow.toString(), deny: nuevoDeny.toString() },
    accion,
  );
  if (!r.ok) {
    return { flags: 64, content: `❌ No pude ${bloquear ? 'bloquear' : 'desbloquear'} el canal (HTTP ${r.status}).` };
  }
  await registrarMod(env, guildId, String(body.member?.user?.id ?? ''), null, accion, null, canalId);
  return {
    flags: 64,
    content: bloquear
      ? '🔒 Canal bloqueado: @everyone ya no puede escribir.'
      : '🔓 Canal desbloqueado: @everyone puede escribir de nuevo.',
  };
}

export const lock = (env, body, token, guildId) => overwriteCanal(env, body, token, guildId, true);
export const unlock = (env, body, token, guildId) => overwriteCanal(env, body, token, guildId, false);

// ── /vants canal ─────────────────────────────────────────────────────────────
export async function vantsCanal(env, body) {
  if (!(await esStaff(env, body, PERM.MANAGE_GUILD))) return sinPermiso('Gestionar servidor');
  const sub = (body?.data?.options ?? []).find((o) => o.name === 'canal');
  const categoria = String(sub?.options?.find((o) => o.name === 'categoria')?.value ?? '');
  const canalOpt = sub?.options?.find((o) => o.name === 'canal')?.value;
  const canalId = String(canalOpt ?? body.channel_id ?? '');
  if (!categoria || !canalId) return { flags: 64, content: '❌ Faltan datos del canal.' };
  try {
    await dbRun(
      env,
      'INSERT INTO discord_channels (category, channel_id) VALUES (?, ?) '
      + 'ON CONFLICT (category) DO UPDATE SET channel_id = excluded.channel_id',
      [categoria, canalId],
    );
  } catch {
    return { flags: 64, content: '❌ No se pudo guardar la configuración. Revisá la base de datos D1.' };
  }
  return { flags: 64, content: `✅ Las notificaciones **${categoria}** llegarán a <#${canalId}>.` };
}

// ── /vants estado ────────────────────────────────────────────────────────────
export async function vantsEstado(env, body) {
  if (!(await esStaff(env, body, PERM.MANAGE_GUILD))) {
    return sinPermiso('Gestionar servidor');
  }
  let canales = [];
  let pendientes = 0;
  let dbOk = true;
  try {
    canales = await dbAll(env, 'SELECT category, channel_id FROM discord_channels ORDER BY category');
    const f = await dbFirst(env, "SELECT count(*) AS n FROM bot_alerts WHERE status = 'pending'");
    pendientes = Number(f?.n ?? 0);
  } catch {
    dbOk = false;
  }
  const e = { title: '⚙️ Estado de VANTS', color: ROJO };
  if (!dbOk) {
    e.description = '❌ No se pudo leer la configuración de la base de datos D1.';
  } else if (canales.length) {
    campo(
      e,
      '📢 Canales de notificación',
      canales.map((c) => `• **${c.category}** → <#${c.channel_id}>`).join('\n'),
    );
  } else {
    campo(e, '📢 Canales de notificación', 'Ninguno configurado todavía. Usá `/vants canal`.');
  }
  campo(e, '🔔 Alertas en cola', String(pendientes), true);
  campo(e, '🗄️ Base de datos', dbOk ? 'D1 conectada ✅' : 'D1 con error ❌', true);
  e.footer = { text: 'vantsbot · Cloudflare Worker + D1' };
  return { flags: 64, embeds: [e] };
}

// ── /informe ─────────────────────────────────────────────────────────────────
export async function informe(env, body) {
  if (!(await esStaff(env, body, PERM.MANAGE_GUILD))) return sinPermiso('Gestionar servidor');

  let conteos = [];
  let recientes = [];
  let pendientes = 0;
  try {
    conteos = await dbAll(
      env,
      "SELECT accion, count(*) AS n FROM mod_logs WHERE creado_at >= datetime('now', '-7 days') GROUP BY accion ORDER BY n DESC",
    );
    recientes = await dbAll(
      env,
      'SELECT moderador_id, objetivo_id, accion, razon, creado_at FROM mod_logs ORDER BY id DESC LIMIT 8',
    );
    const f = await dbFirst(env, "SELECT count(*) AS n FROM bot_alerts WHERE status = 'pending'");
    pendientes = Number(f?.n ?? 0);
  } catch {
    return { flags: 64, content: '❌ No se pudo leer el historial de moderación (D1).' };
  }

  const e = embedBase('📊 Informe semanal de VANTS', null);
  campo(
    e,
    '🛡️ Moderación (7 días)',
    conteos.length ? conteos.map((c) => `• **${c.accion}**: ${c.n}`).join('\n') : 'Sin acciones esta semana ✅',
  );
  campo(e, '🔔 Alertas en cola', String(pendientes), true);
  if (recientes.length) {
    campo(
      e,
      '🗂️ Últimas acciones',
      recientes
        .map((r) =>
          `• \`${r.creado_at?.slice(0, 16) ?? '?'}\` **${r.accion}** → <@${r.objetivo_id ?? '0'}> por <@${r.moderador_id}>${r.razon ? ` — ${txt(r.razon, 60)}` : ''}`)
        .join('\n')
        .slice(0, 1000),
    );
  }
  e.footer = { text: 'vantsbot · Cloudflare Worker + D1' };
  return { flags: 64, embeds: [e] };
}

// ── Roles de staff (/vants rol) ──────────────────────────────────────────────
// Comandos que quedan ocultos para miembros sin permisos y visibles para los
// roles registrados aquí. Debe reflejar defs.js (default_member_permissions).
const COMANDOS_STAFF = [
  'vants', 'warn', 'kick', 'ban', 'mute', 'unmute',
  'clear', 'lock', 'unlock', 'informe', 'fabrica', 'agente',
];

// Sincroniza los overrides de la API de permisos de comandos de Discord:
// cada rol de roles_admin queda como allow=true en los 12 comandos de staff,
// así el rol los VE en el menú / aunque no tenga permisos de Discord.
// Sin roles → body vacío para esos comandos = vuelta al default.
export async function sincronizarPermisosComandos(env, guildId) {
  const token = String(env.DISCORD_BOT_TOKEN ?? '');
  const appId = appIdDeToken(token) || String(env.DISCORD_APP_ID ?? '');
  if (!token || !/^\d{17,20}$/.test(appId)) return { ok: false, motivo: 'sin token/app_id' };

  const filas = await dbAll(env, 'SELECT role_id FROM roles_admin WHERE guild_id = ?', [guildId]);
  const roles = filas.map((f) => String(f.role_id)).slice(0, 10); // Discord: máx 10 overwrites por comando

  const lista = await dapi(token, 'GET', `/applications/${appId}/guilds/${guildId}/commands`);
  if (!lista.ok || !Array.isArray(lista.data)) {
    return { ok: false, motivo: `no pude listar comandos (HTTP ${lista.status})` };
  }
  const nombreDe = new Map(lista.data.map((c) => [String(c.id), String(c.name)]));

  // Conservamos los overrides ya existentes de comandos que no son de staff
  // (por si el dueño ajustó algo a mano en Ajustes → Integraciones).
  const actuales = await dapi(token, 'GET', `/applications/${appId}/guilds/${guildId}/commands/permissions`);
  const previos = actuales.ok && Array.isArray(actuales.data) ? actuales.data : [];

  const cuerpo = [];
  const vistos = new Set();
  for (const p of previos) {
    const id = String(p.id);
    if (!nombreDe.has(id) || vistos.has(id)) continue; // ignora entrada global/ghost
    vistos.add(id);
    const esDeStaff = COMANDOS_STAFF.includes(nombreDe.get(id));
    cuerpo.push({
      id,
      permissions: esDeStaff
        ? roles.map((r) => ({ id: r, type: 1, permission: true }))
        : Array.isArray(p.permissions) ? p.permissions : [],
    });
  }
  for (const c of lista.data) {
    const id = String(c.id);
    if (vistos.has(id)) continue;
    vistos.add(id);
    if (COMANDOS_STAFF.includes(String(c.name))) {
      cuerpo.push({ id, permissions: roles.map((r) => ({ id: r, type: 1, permission: true })) });
    }
  }
  if (!cuerpo.length) return { ok: true, roles, comandos: 0, nota: 'sin comandos que sincronizar' };

  const put = await dapi(
    token, 'PUT',
    `/applications/${appId}/guilds/${guildId}/commands/permissions`,
    cuerpo, 'roles de staff de /vants rol',
  );
  return put.ok
    ? { ok: true, roles, comandos: cuerpo.length }
    : { ok: false, motivo: `HTTP ${put.status}` };
}

// /vants rol agregar @Rol · quitar @Rol · lista
export async function vantsRol(env, body, guildId) {
  const grupo = (body?.data?.options ?? []).find((o) => o.name === 'rol');
  const sub = String(grupo?.options?.[0]?.name ?? 'lista');
  const rolId = String(grupo?.options?.[0]?.options?.find((o) => o.name === 'rol')?.value ?? '');

  // Gestionar QUIÉN es staff es cosa de Administradores (la lista es libre).
  if (sub !== 'lista' && !tienePerm(permisosDe(body), PERM.ADMIN)) {
    return {
      flags: 64,
      content: '🚫 Solo un **Administrador** puede cambiar los roles de staff. Consulta con `/vants rol lista`.',
    };
  }
  if (sub === 'lista' && !(await esStaff(env, body, PERM.MANAGE_GUILD))) {
    return sinPermiso('Gestionar servidor');
  }

  if (sub === 'agregar') {
    if (!/^\d{17,20}$/.test(rolId)) return { flags: 64, content: '❌ Ese rol no es válido.' };
    try {
      await dbRun(
        env,
        'INSERT OR IGNORE INTO roles_admin (guild_id, role_id) VALUES (?, ?)',
        [guildId, rolId],
      );
    } catch {
      return { flags: 64, content: '❌ No pude guardar el rol (¿falta la migración 03 en D1?).' };
    }
    const sinc = await sincronizarPermisosComandos(env, guildId).catch((e) => ({ ok: false, motivo: txt(e, 80) }));
    return {
      flags: 64,
      content: `✅ <@&${rolId}> ahora es **staff de VANTS**: ve y usa los comandos de administración.\n`
        + (sinc.ok
          ? '🔄 Menú de Discord sincronizado (puede tardar unos segundos en refrescar).'
          : `⚠️ Guardado en D1, pero no pude refrescar el menú (${sinc.motivo}). Revisa Ajustes → Integraciones → VANTS si no lo ven.`),
    };
  }

  if (sub === 'quitar') {
    try {
      await dbRun(env, 'DELETE FROM roles_admin WHERE guild_id = ? AND role_id = ?', [guildId, rolId]);
    } catch {
      return { flags: 64, content: '❌ No pude quitar el rol (¿falta la migración 03 en D1?).' };
    }
    const sinc = await sincronizarPermisosComandos(env, guildId).catch((e) => ({ ok: false, motivo: txt(e, 80) }));
    return {
      flags: 64,
      content: `✂️ <@&${rolId}> ya **no** es staff de VANTS.`
        + (sinc.ok ? ' Menú sincronizado.' : ` (Menú no refrescado: ${sinc.motivo})`),
    };
  }

  // lista
  let filas = [];
  try {
    filas = await dbAll(env, 'SELECT role_id, creado_at FROM roles_admin WHERE guild_id = ? ORDER BY creado_at', [guildId]);
  } catch {
    return { flags: 64, content: '❌ No pude leer roles_admin (¿falta la migración 03 en D1?).' };
  }
  if (!filas.length) {
    return {
      flags: 64,
      content: '👥 No hay roles de staff todavía. Un administrador puede añadir uno con `/vants rol agregar rol:@Rol`.',
    };
  }
  return {
    flags: 64,
    embeds: [{
      title: '👥 Roles de staff de VANTS',
      description: filas.map((f) => `• <@&${f.role_id}> — desde \`${String(f.creado_at ?? '').slice(0, 10)}\``).join('\n'),
      color: ROJO,
      footer: { text: 'Ven y usan los comandos de administración sin permisos de Discord · /vants rol agregar|quitar' },
    }],
  };
}
