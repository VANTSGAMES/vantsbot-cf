// ============================================
// vantsbot — comandos de comunidad (espejo de bot/main.py)
// ayuda · perfil · ranking · torneos · eventos · calendario
// planes · reglas · soporte · vincular riot
// Todas las consultas van a D1 (binding DB).
// ============================================
import {
  ROJO, txt, dbAll, dbFirst, dbRun, SQL_TEMPORADA_ACTIVA, fmtFecha, webUrl,
  embedBase, campo, botonEnlaces, avatarDe, nombreVisible, usuarioDeOpcion, ahoraISO,
} from './util.js';
import { soporteIA } from './bridge.js';

const ESTADOS_TORNEO = ['registration', 'open', 'upcoming', 'in_progress', 'live'];
const ESTADO_ES = {
  registration: 'Inscripción abierta',
  open: 'Inscripción abierta',
  upcoming: 'Próximo',
  in_progress: 'En curso',
  live: 'En vivo',
  completed: 'Finalizado',
  cancelled: 'Cancelado',
};
const TIPO_EMOJI = {
  torneo: '🏆', tournament: '🏆', scrim: '🎮', 'watch party': '📺',
  comunidad: '🎉', evento: '📅',
};

// Helper: opciones de la interaction
function opcionesDe(body) {
  return (body?.data?.options ?? []);
}
const optVal = (body, n) => opcionesDe(body).find((o) => o.name === n)?.value;

// ── /ayuda ───────────────────────────────────────────────────────────────────
export function ayuda(env) {
  const W = webUrl(env);
  const e = embedBase('🤖 Comandos de VANTS', 'Todo lo que podés hacer desde Discord.');
  campo(
    e,
    '🎮 Comunidad',
    '`/perfil` — Tu perfil competitivo VANTS\n'
    + '`/ranking` — Top 10 de la temporada ranked\n'
    + '`/torneos` — Torneos abiertos y próximos\n'
    + '`/eventos` — Próximos eventos de la comunidad\n'
    + '`/calendario` — Lo que viene en los próximos 7 días\n'
    + '`/planes` — Membresías PRO, CREATOR y SOCIO\n'
    + '`/vincular riot` — Conecta tu cuenta de Riot\n'
    + '`/reglas` — Código de conducta\n'
    + '`/ia pregunta` — Habla con la IA de OpenAI (Sol, Astra, Terra, Luna)\n'
    + '`/soporte pregunta` — Ayuda del staff o del agente IA',
  );
  campo(
    e,
    '🛡️ Staff',
    '`/vants canal` — Elegir canal de cada notificación (incluye directos)\n'
    + '`/vants estado` — Ver configuración actual\n'
    + '`/vants rol agregar|quitar|lista` — Roles de staff del bot (ve y usa estos comandos sin permisos de Discord)\n'
    + '`/fabrica nueva|estado|lista` — Fábrica de software: Spec → Builder → Sol/Astra → Approver (pequeño → main directo · grande → PR con tu aprobación)\n'
    + '`/agente estado|informe|incidentes|resolver|comando` — Mando del Agente VANTS\n'
    + '`/warn` `/kick` `/ban` `/mute` `/unmute`\n'
    + '`/clear` `/lock` `/unlock`\n'
    + '`/informe` — Informe semanal de la plataforma\n\n'
    + '🔒 Los comandos de staff son **invisibles para los miembros**: solo los ve '
    + 'quien tenga el permiso correspondiente o un rol dado de alta con `/vants rol agregar`.',
  );
  campo(
    e,
    '🌐 Enlaces',
    `[Plataforma VANTS](${W}) · [Membresías](${W}/membresias) · [Torneos](${W}/torneos)`,
  );
  e.footer = { text: 'VANTS GAMES' };
  return { embeds: [e] };
}

// ── /perfil ──────────────────────────────────────────────────────────────────
export async function perfil(env, body) {
  const invocador = body.member?.user ?? body.user;
  const objetivo = usuarioDeOpcion(body, 'usuario');
  const userId = objetivo?.id ?? String(invocador?.id ?? '');
  const member = objetivo?.member ?? body.member;
  const user = objetivo?.user ?? invocador;

  let player;
  try {
    player = await dbFirst(env, 'SELECT * FROM players WHERE discord_user_id = ? LIMIT 1', [userId]);
  } catch {
    return { flags: 64, content: '❌ No se pudo consultar el perfil ahora. Inténtalo de nuevo más tarde.' };
  }
  if (!player) {
    const e = embedBase(
      '❌ Usuario no encontrado',
      'Este usuario no tiene cuenta VANTS vinculada.',
    );
    e.footer = { text: `VANTS · ${webUrl(env)}` };
    return {
      flags: 64,
      embeds: [e],
      components: botonEnlaces(['Vincular Discord', `${webUrl(env)}/vincular-discord.html`]),
    };
  }

  let torneos = 0;
  let accounts = [];
  let standing = null;
  try {
    const fila = await dbFirst(env, 'SELECT count(*) AS n FROM tournament_entries WHERE player_id = ?', [String(player.id)]);
    torneos = Number(fila?.n ?? 0);
    if (player.auth_user_id) {
      accounts = await dbAll(
        env,
        "SELECT game, handle FROM user_game_accounts WHERE user_id = ? AND game IN ('riot','steam') LIMIT 10",
        [String(player.auth_user_id)],
      );
    }
    standing = await dbFirst(
      env,
      `SELECT l.rank, l.mmr FROM leaderboard l LEFT JOIN seasons se ON se.id = l.season_id `
      + `WHERE l.player_id = ? ORDER BY (se.status = 'active') DESC, se.season_number DESC LIMIT 1`,
      [String(player.id)],
    );
  } catch {
    /* seguimos con lo que haya */
  }

  const porJuego = Object.fromEntries(accounts.map((r) => [r.game, r.handle]));
  const riotHandle = porJuego.riot ?? null;
  const steamId = porJuego.steam ?? null;

  const e = { color: ROJO };
  e.author = { name: nombreVisible(member, user), icon_url: avatarDe(user) };
  if (player.avatar_url) e.thumbnail = { url: String(player.avatar_url) };
  campo(e, '🏆 Rango VANTS', txt(standing?.rank, 32) === '—' ? 'Sin rango' : txt(standing?.rank, 32), true);
  campo(e, '⭐ Puntos', String(standing?.mmr ?? 0), true);
  campo(e, '🎮 Torneos', String(torneos), true);
  campo(e, '🌍 País', txt(player.country, 24) === '—' ? 'No definido' : txt(player.country, 24), true);
  campo(e, '🔫 Riot ID', riotHandle ? txt(riotHandle, 32) : 'No vinculado', true);
  campo(
    e,
    '🎲 Steam',
    steamId ? `[Perfil](https://steamcommunity.com/profiles/${steamId})` : 'No vinculado',
    true,
  );
  e.footer = { text: `VANTS · ${webUrl(env)}` };

  const botones = [];
  if (steamId) botones.push(['Perfil de Steam', `https://steamcommunity.com/profiles/${steamId}`]);
  botones.push(['Gestionar cuentas (RSO)', `${webUrl(env)}/perfil/cuentas`]);
  botones.push(['Perfil completo en la web', `${webUrl(env)}/perfil`]);

  return { embeds: [e], components: botonEnlaces(...botones) };
}

// ── /ranking ─────────────────────────────────────────────────────────────────
export async function ranking(env, body) {
  const pagina = Math.max(1, Math.min(50, Number(optVal(body, 'pagina') ?? 1)));
  const offset = (pagina - 1) * 10;
  let rows;
  try {
    rows = await dbAll(
      env,
      `SELECT row_number() OVER (ORDER BY l.mmr DESC) AS pos, `
      + `COALESCE(l.display_name, p.display_name, '—') AS nombre, l.rank, l.mmr, l.wins, l.losses, `
      + `CASE WHEN l.wins + l.losses > 0 THEN ROUND(100.0 * l.wins / (l.wins + l.losses), 1) ELSE 0 END AS wr `
      + `FROM leaderboard l LEFT JOIN players p ON p.id = l.player_id `
      + `WHERE l.season_id = ${SQL_TEMPORADA_ACTIVA} `
      + `ORDER BY l.mmr DESC LIMIT 10 OFFSET ?`,
      [offset],
    );
  } catch {
    return { flags: 64, content: 'No se pudo cargar el ranking ahora mismo.' };
  }
  if (!rows.length) {
    return { content: pagina > 1 ? 'No hay más páginas en el ranking.' : 'Aún no hay jugadores clasificados esta temporada.' };
  }
  const e = embedBase('🏅 Ranking VANTS · Top 10', null);
  if (pagina > 1) e.title = `🏅 Ranking VANTS · página ${pagina}`;
  e.description = rows
    .map((r) =>
      `**${r.pos}.** ${txt(r.nombre, 32)} — **${txt(r.rank, 24) === '—' ? 'Sin rango' : txt(r.rank, 24)} ${r.mmr} MMR** · ${r.wins} victorias · ${Number(r.wr ?? 0).toFixed(1)}% WR`)
    .join('\n');
  e.footer = { text: `VANTS RANKED · ${webUrl(env)}/ranking.html` };
  return { embeds: [e] };
}

// ── /torneos ─────────────────────────────────────────────────────────────────
export async function torneos(env) {
  let rows;
  try {
    rows = await dbAll(
      env,
      `SELECT name, format, status, starts_at, current_participants, max_participants `
      + `FROM tournaments WHERE status IN ('registration','open','upcoming','in_progress','live') `
      + `ORDER BY (starts_at IS NULL), starts_at ASC LIMIT 10`,
    );
  } catch {
    return { flags: 64, content: 'No se pudo consultar los torneos ahora mismo.' };
  }
  if (!rows.length) {
    return {
      content: `No hay torneos abiertos ni programados por ahora. Mirá [los torneos en la web](${webUrl(env)}/torneos).`,
    };
  }
  const e = embedBase('🏆 Torneos VANTS', null);
  e.description = rows
    .map((t) => {
      const plazas = `${t.current_participants ?? 0}/${t.max_participants ?? '∞'}`;
      const estado = ESTADO_ES[t.status] ?? t.status;
      return `**${txt(t.name, 48)}**\n› ${estado} · ${txt(t.format, 24)} · ${fmtFecha(t.starts_at)} · ${plazas} inscritos`;
    })
    .join('\n');
  e.footer = { text: `Inscripciones en ${webUrl(env)}/torneos` };
  return { embeds: [e] };
}

// ── /eventos ─────────────────────────────────────────────────────────────────
export async function eventos(env) {
  let rows;
  try {
    rows = await dbAll(
      env,
      `SELECT title, event_type, starts_at, description FROM events `
      + `WHERE starts_at >= datetime('now') ORDER BY starts_at ASC LIMIT 10`,
    );
  } catch {
    return { flags: 64, content: 'No se pudo consultar los eventos ahora mismo.' };
  }
  if (!rows.length) {
    return { content: 'No hay eventos programados por ahora. ¡Atento al calendario!' };
  }
  const e = embedBase('📅 Próximos eventos VANTS', null);
  e.description = rows
    .map((ev) => {
      const emoji = TIPO_EMOJI[String(ev.event_type ?? '').toLowerCase()] ?? '📅';
      const desc = txt(ev.description, 90);
      let linea = `${emoji} **${txt(ev.title, 60)}** — ${fmtFecha(ev.starts_at)}`;
      if (desc && desc !== '—') linea += `\n› ${desc}`;
      return linea;
    })
    .join('\n');
  return { embeds: [e] };
}

// ── /calendario ──────────────────────────────────────────────────────────────
export async function calendario(env) {
  let eventosRows = [];
  let torneosRows = [];
  try {
    eventosRows = await dbAll(
      env,
      `SELECT title, event_type, starts_at FROM events `
      + `WHERE starts_at >= datetime('now') AND starts_at < datetime('now', '+7 days') `
      + `ORDER BY starts_at ASC LIMIT 20`,
    );
    torneosRows = await dbAll(
      env,
      `SELECT name, starts_at FROM tournaments `
      + `WHERE starts_at >= datetime('now') AND starts_at < datetime('now', '+7 days') `
      + `AND status IN ('registration','open','upcoming','in_progress','live') `
      + `ORDER BY starts_at ASC LIMIT 20`,
    );
  } catch {
    return { flags: 64, content: 'No se pudo armar el calendario ahora mismo.' };
  }
  const items = [
    ...eventosRows.map((ev) => {
      const emoji = TIPO_EMOJI[String(ev.event_type ?? '').toLowerCase()] ?? '📅';
      return { cuando: ev.starts_at, texto: `${emoji} ${txt(ev.title, 48)}` };
    }),
    ...torneosRows.map((t) => ({ cuando: t.starts_at, texto: `🏆 Torneo: ${txt(t.name, 40)}` })),
  ];
  if (!items.length) {
    return { content: 'Nada programado en los próximos 7 días. ¡Buen momento para entrenar! 💪' };
  }
  items.sort((a, b) => String(a.cuando).localeCompare(String(b.cuando)));
  const e = embedBase('📆 Agenda VANTS · próximos 7 días', null);
  e.description = items
    .slice(0, 25)
    .map((i) => `• ${fmtFecha(i.cuando)} — ${i.texto}`)
    .join('\n');
  return { embeds: [e] };
}

// ── /planes (membresías reales de la web) ────────────────────────────────────
export function planes(env) {
  const e = embedBase(
    '💎 Membresías VANTS',
    'Desbloqueá la tienda de identidad premium, la cola prioritaria '
    + 'y las insignias verificadas de tu ficha.',
  );
  campo(
    e,
    'PRO — todo lo competitivo',
    'Insignia PRO en tu ficha · marcos y tarjetas premium · sello PRO '
    + 'junto a tu nick · cola prioritaria en VANTS RANKED · inscripciones '
    + 'sin fee en torneos abiertos',
  );
  campo(
    e,
    'CREATOR — para los que muestran la arena',
    'Insignia y sello CREATOR · canal de clips verificado · destacado '
    + 'en la sala de jugadores · soporte directo con el equipo · kit de '
    + 'overlays de marca',
  );
  campo(
    e,
    'SOCIO — la marca y vos, juntos',
    'Insignia SOCIO VANTS · marco de socio · voto en decisiones del '
    + 'circuito · descuentos en la tienda oficial · acceso al Discord privado',
  );
  campo(e, '💳 Precios', 'Por anunciar. Pagos seguros con Stripe (tarjeta, Klarna, Link y más).');
  e.description += `\n\nDetalles y activación: [Membresías VANTS](${webUrl(env)}/membresias)`;
  return { embeds: [e] };
}

// ── /reglas ──────────────────────────────────────────────────────────────────
export function reglas() {
  const e = embedBase('📜 Código de conducta VANTS', null);
  e.description =
    '**1. Respeto ante todo.** No se toleran insultos, acoso, discurso de odio '
    + 'ni toxicidad hacia otros miembros.\n'
    + '**2. Juego limpio.** Cero cheats, smurfing o explotación de bugs. '
    + 'La trampa significa ban permanente.\n'
    + '**3. Compromiso competitivo.** Si te inscribes a un torneo o ranked, '
    + 'presentate. Los no-shows repetidos se sancionan.\n'
    + '**4. Sin spam ni publicidad.** Nada de promociones, enlaces de invitación '
    + 'o autos en canales que no corresponden.\n'
    + '**5. Contenido apropiado.** Nada NSFW ni material que rompa los términos '
    + 'de Discord.\n'
    + '**6. Disputas por privado.** Los conflictos con rivales o compañeros se '
    + 'reportan al staff, no se pelean en canales públicos.\n'
    + '**7. Decisiones del staff.** Las sanciones se comunican por privado y la '
    + 'reincidencia agrava la pena.\n\n'
    + 'El staff puede actuar en cualquier caso no cubierto aquí. '
    + 'Dudas: usá `/soporte`.';
  e.footer = { text: 'VANTS GAMES · comunidad competitiva' };
  return { embeds: [e] };
}

// ── /soporte (con pregunta opcional → agente IA de la web VANTS AI) ──────────
export async function soporte(env, body) {
  const pregunta = (body?.data?.options ?? []).find((o) => o.name === 'pregunta')?.value;
  if (pregunta && String(pregunta).trim()) {
    return soporteIA(env, String(pregunta).trim(), body);
  }
  let canalStaff = null;
  try {
    const row = await dbFirst(env, "SELECT channel_id FROM discord_channels WHERE category = 'staff' LIMIT 1");
    canalStaff = row?.channel_id ? String(row.channel_id) : null;
  } catch {
    /* sin BD igual mostramos los pasos */
  }
  const e = embedBase('🆘 Soporte VANTS', null);
  e.description =
    '¿Necesitás ayuda? Seguí estos pasos:\n\n'
    + '**1.** Revisá `/ayuda` y `/reglas` — la mayoría de las dudas están ahí.\n'
    + '**2.** Problemas con tu cuenta (Riot, Steam, perfil): usá `/vincular riot` '
    + 'y verificá tu ficha en la web.\n'
    + '**3.** Reportes de jugadores, trampas o disputas de partida: abrí un ticket '
    + 'o escribile al staff.\n'
    + '**4.** Nada urgente pierde: el staff responde en horario de la comunidad.';
  campo(
    e,
    '📩 Canal de staff',
    canalStaff
      ? `Escribinos en <#${canalStaff}>`
      : 'El staff todavía no configuró el canal (usa `/vants canal` como admin).',
  );
  e.footer = { text: `Más info en ${webUrl(env)}` };
  return { flags: 64, embeds: [e] };
}

// ── /vincular riot ───────────────────────────────────────────────────────────────────────────
// Cumplimiento Riot Games Developer Policies: la vinculación de cuentas de Riot
// se realiza exclusivamente con consentimiento explícito (opt-in) mediante Riot Sign On (RSO).
export async function vincularRiot(env) {
  const W = webUrl(env);
  const e = embedBase(
    '🔐 Vinculación oficial con Riot Sign On (RSO)',
    'Para cumplir con las políticas de privacidad y seguridad de Riot Games, las cuentas de Riot / VALORANT '
    + 'solo se vinculan mediante **Riot Sign On (RSO)** con consentimiento explícito (opt-in) desde tu perfil web.',
  );
  campo(
    e,
    '📌 Estado actual',
    'Conexión oficial con Riot Sign On en revisión. Cuando esté activa podrás autorizar (opt-in) y desvincular (opt-out) tu cuenta al instante.',
  );
  campo(
    e,
    '🛡️ Privacidad garantizada',
    'Nunca mostramos estadísticas de VALORANT sin consentimiento previo y puedes eliminar tus datos en caché cuando quieras desde **Mis cuentas**.',
  );
  e.footer = { text: `VANTS · ${W}` };
  return {
    flags: 64,
    embeds: [e],
    components: botonEnlaces(
      ['Gestionar en Mis cuentas (RSO)', `${W}/perfil/cuentas`],
      ['Política de Privacidad', `${W}/privacidad`],
    ),
  };
}
