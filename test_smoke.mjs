// Smoke test v2: PING, comandos, gate staff, Kick (challenge + firma + directo),
// /avisar (401 y ok), /evento-discord dedupe, /agente sin AGENTE_URL, /salud
import { createHmac } from 'node:crypto';
import { construir, setupComandos } from './src/index.js';

const handler = construir({ saltarFirma: true });

const dbMem = { web_events: new Set() };
const envSim = {
  DISCORD_BOT_TOKEN: 'MTU2NDgwNTYyNzk3OTYzMjczMA.' + 'x'.repeat(50),
  DISCORD_PUBLIC_KEY: 'a'.repeat(64),
  VANTS_BOT_SECRET: 's'.repeat(32),
  DISCORD_GUILD_ID: '1546641331927908472',
  VANTS_WEB_URL: 'https://vants.vants.workers.dev',
  KICK_CLIENT_SECRET: 'kick-secret-de-prueba',
  KICK_USERNAME: 'vants',
  // sin AGENTE_URL → /agente debe dar guía
  DB: {
    prepare(sql) {
      const runConDedupe = async (...args) => {
        if (sql.includes('INSERT INTO web_events')) {
          const id = args[0];
          if (dbMem.web_events.has(id)) return { meta: { changes: 0 } };
          dbMem.web_events.add(id);
          return { meta: { changes: 1 } };
        }
        if (sql.includes('INSERT INTO fabrica_corridas')) return { meta: { changes: 1, last_row_id: 77 } };
        return { meta: { changes: 1 } };
      };
      return {
        bind: (...args) => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => runConDedupe(...args) }),
        all: async () => ({ results: [] }),
        first: async () => null,
        run: runConDedupe,
      };
    },
  },
};

const req = (body, headers = {}) =>
  new Request('https://vantsbot.example/', { method: 'POST', body: JSON.stringify(body), headers });

// 1) PING
let r = await handler(req({ type: 1 }), envSim, {});
console.assert((await r.json()).type === 1, 'PING mal');

// 2) /ayuda
r = await handler(req({ type: 2, data: { name: 'ayuda' } }), envSim, {});
let j = await r.json();
console.assert(j.type === 4 && j.data.embeds[0].title.includes('Comandos'), 'ayuda mal');

// 3) gate staff en /vants
r = await handler(req({ type: 2, data: { name: 'vants', options: [{ name: 'estado' }] }, member: { permissions: '0' } }), envSim, {});
j = await r.json();
console.assert(j.type === 4 && j.data.flags === 64 && j.data.content.includes('staff'), 'gate staff mal');

// 4) Kick challenge → responde el challenge tal cual (texto plano)
r = await handler(
  new Request('https://vantsbot.example/kick', {
    method: 'POST',
    body: JSON.stringify({ challenge: 'abc-123-xyz' }),
    headers: {
      'x-kick-event-type': 'webhook.callback.verify',
      'x-kick-signature': createHmac('sha256', envSim.KICK_CLIENT_SECRET).update(JSON.stringify({ challenge: 'abc-123-xyz' })).digest('hex'),
    },
  }),
  envSim,
  {},
);
console.assert((await r.text()) === 'abc-123-xyz', 'challenge kick mal');

// 5) Kick con firma inválida → 401
r = await handler(
  new Request('https://vantsbot.example/kick', {
    method: 'POST',
    body: JSON.stringify({ is_live: true }),
    headers: { 'x-kick-event-type': 'livestream.status.updated', 'x-kick-signature': 'firma-mala' },
  }),
  envSim,
  {},
);
console.assert(r.status === 401, 'firma kick mal');

// 6) Kick directo real (sin canal configurado → avisado:false pero ok:true)
const payloadLive = { broadcaster_username: 'vants', is_live: true, title: 'Ranked con la comunidad', started_at: '2026-10-28T12:00:00Z' };
r = await handler(
  new Request('https://vantsbot.example/kick', {
    method: 'POST',
    body: JSON.stringify(payloadLive),
    headers: {
      'x-kick-event-type': 'livestream.status.updated',
      'x-kick-event-id': 'evt-001',
      'x-kick-signature': createHmac('sha256', envSim.KICK_CLIENT_SECRET).update(JSON.stringify(payloadLive)).digest('hex'),
    },
  }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.ok === true && j.avisado === false && String(j.error).includes('canal'), 'kick directo mal');
console.assert(dbMem.web_events.has('kick:evt-001'), 'dedupe kick no guardó');

// 7) /avisar sin secreto → 401
r = await handler(new Request('https://vantsbot.example/avisar', { method: 'POST', body: '{}' }), envSim, {});
console.assert(r.status === 401, 'avisar 401 mal');

// 8) /avisar sin destino → ok:false con error claro
r = await handler(
  new Request('https://vantsbot.example/avisar', {
    method: 'POST',
    body: JSON.stringify({ title: 't', message: 'm' }),
    headers: { 'x-vants-bot': envSim.VANTS_BOT_SECRET },
  }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.ok === false && String(j.error).includes('destino'), 'avisar sin destino mal');

// 9) /evento-discord dedupe en D1 simulada
r = await handler(
  new Request('https://vantsbot.example/evento-discord', {
    method: 'POST',
    body: JSON.stringify({ evento_id: 'ev-9', payload: { data: { type: 'ENTITLEMENT_CREATE' } } }),
    headers: { 'x-vants-bot': envSim.VANTS_BOT_SECRET },
  }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.ok === true, 'evento-discord mal');

// 10) /agente sin AGENTE_URL → guía de configuración
r = await handler(req({ type: 2, data: { name: 'agente', options: [{ name: 'estado' }] }, member: { permissions: '8' } }), envSim, {});
j = await r.json();
console.assert(j.type === 4 && String(j.data.content).includes('AGENTE_URL'), 'agente guía mal');

// 11) /soporte pregunta → si la IA tarda >2.2s el Worker hace defer (type 5, correcto)
r = await handler(
  req({ type: 2, data: { name: 'soporte', options: [{ name: 'pregunta', value: '¿cómo vinculo riot?' }] }, member: { permissions: '8' } }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.type === 4 || j.type === 5, 'soporte IA mal');

// 11b) /ia sin OPENAI_API_KEY → guía de configuración (sin colgarse)
r = await handler(
  req({ type: 2, data: { name: 'ia', options: [{ name: 'pregunta', value: '¿quién es sol?' }] }, member: { permissions: '8' } }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.type === 4 && String(j.data.content).includes('OPENAI_API_KEY'), 'ia sin key mal');

// 11c) /ia con key inválida simulada → mensaje claro, no crashea
r = await handler(
  req({ type: 2, data: { name: 'ia', options: [{ name: 'pregunta', value: 'hola' }, { name: 'modelo', value: 'sol' }] }, member: { permissions: '8' } }),
  { ...envSim, OPENAI_API_KEY: 'sk-test-invalido' },
  {},
);
j = await r.json();
console.assert(j.type === 4 && /❌|⏳|🌍|💳|🔑|🤖/.test(String(j.data?.content ?? '')), 'ia con key mal');

// 11d) /fabrica sin permisos → gate de staff
r = await handler(
  req({ type: 2, data: { name: 'fabrica', options: [{ name: 'lista' }] }, member: { permissions: '0' } }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.type === 4 && j.data.flags === 64 && String(j.data.content).includes('staff'), 'gate fabrica mal');

// 11e) /fabrica nueva como staff, sin claves IA → plantilla rápida con botón Builder
r = await handler(
  req({ type: 2, data: { name: 'fabrica', options: [{ name: 'nueva', options: [{ name: 'idea', value: 'búsqueda de jugadores en la web' }] }] }, member: { permissions: '8' } }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.type === 4 && String(j.data.embeds?.[0]?.title ?? '').includes('Spec writer'), 'fabrica nueva mal');
console.assert(j.data.components?.[0]?.components?.[0]?.custom_id === 'fabrica:build:77', 'fabrica nueva botón mal');

// 11f) /fabrica estado de una corrida que no existe → aviso claro
r = await handler(
  req({ type: 2, data: { name: 'fabrica', options: [{ name: 'estado', options: [{ name: 'id', value: 999 }] }] }, member: { permissions: '8' } }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.type === 4 && String(j.data.content).includes('#999'), 'fabrica estado mal');

// 11g) botón de fábrica sobre una corrida fantasma → efímero, sin frío
r = await handler(
  req({ type: 3, data: { custom_id: 'fabrica:build:999' }, member: { user: { id: '1' }, permissions: '8' }, token: 'tok' }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.type === 4 && String(j.data.content).includes('#999'), 'botón fantasma mal');

// 11h) botón desconocido → aviso de versión
r = await handler(
  req({ type: 3, data: { custom_id: 'otro:accion:1' }, member: { user: { id: '1' }, permissions: '8' }, token: 'tok' }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.type === 4 && String(j.data.content).includes('versión'), 'botón desconocido mal');

// 11i) /vants rol agregar SIN ser admin → rechazado (gestionar staff es de admins)
r = await handler(
  req({
    type: 2, guild_id: '1546641331927908472',
    data: { name: 'vants', options: [{ name: 'rol', options: [{ name: 'agregar', options: [{ name: 'rol', value: '111222333444555666' }] }] }] },
    member: { permissions: '32' },
  }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.type === 4 && String(j.data.content).includes('Administrador'), 'rol agregar sin admin mal');

// 11j) /vants rol agregar como admin → guarda en D1 y sincroniza permisos con Discord
const fetchRealSm = globalThis.fetch;
let putsPermisos = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/commands/permissions')) {
    if ((opts?.method ?? 'GET') === 'PUT') { putsPermisos += 1; return { status: 200, ok: true, json: async () => [] }; }
    return { status: 200, ok: true, json: async () => [] };
  }
  if (u.includes('/guilds/') && u.includes('/commands')) {
    return { status: 200, ok: true, json: async () => [{ id: 'cmd-1', name: 'vants' }, { id: 'cmd-2', name: 'warn' }, { id: 'cmd-3', name: 'ayuda' }] };
  }
  return { status: 200, ok: true, json: async () => ({}) };
};
r = await handler(
  req({
    type: 2, guild_id: '1546641331927908472',
    data: { name: 'vants', options: [{ name: 'rol', options: [{ name: 'agregar', options: [{ name: 'rol', value: '111222333444555666' }] }] }] },
    member: { permissions: '8' },
  }),
  envSim,
  {},
);
j = await r.json();
console.assert(j.type === 4 && String(j.data.content).includes('staff de VANTS'), 'rol agregar admin mal');
console.assert(putsPermisos === 1, 'sincronizar permisos no hizo PUT');
globalThis.fetch = fetchRealSm;

// 12) /setup shape
const resSetup = await setupComandos(envSim);
console.assert(typeof resSetup.ok === 'boolean', 'setup shape mal');

// 13) /salud con kick/agente/openai/fabrica
r = await handler(new Request('https://vantsbot.example/salud'), envSim, {});
j = await r.json();
console.assert(j.config.kick.client_secret === true && j.config.agente.hq_web.includes('vants-ai'), 'salud kick/agente mal');
console.assert(j.config.openai && j.config.openai.modelos.includes('astra'), 'salud openai mal');
console.assert(j.config.fabrica && j.config.fabrica.cerebro_openai === false, 'salud fabrica mal');

// 14) /vincular riot con usuario SIN ficha → la crea al momento (alta automática)
{
  const players = new Map(); // discord_user_id → fila
  const cuentas = new Set(); // handles de riot ya usados
  let inserts = 0;
  const envVin = {
    ...envSim,
    DB: {
      prepare(sql) {
        return {
          bind: (...p) => ({
            all: async () => ({ results: [] }),
            first: async () => {
              if (sql.includes('FROM players WHERE discord_user_id')) {
                return players.get(String(p[0])) ?? null;
              }
              if (sql.includes("FROM user_game_accounts WHERE game = 'riot'")) {
                return cuentas.has(String(p[0])) ? { user_id: 'otro' } : null;
              }
              return null;
            },
            run: async () => {
              if (sql.startsWith('INSERT INTO players')) {
                inserts += 1;
                players.set(String(p[1]), { id: String(p[0]), auth_user_id: String(p[2]) });
              }
              if (sql.startsWith('UPDATE players SET auth_user_id')) {
                const fila = players.get(String(p[3]));
                if (fila) fila.auth_user_id = String(p[0]);
              }
              if (sql.includes("INSERT INTO user_game_accounts (user_id, game, handle")) {
                cuentas.add(String(p[1]));
              }
              return { meta: { changes: 1 } };
            },
          }),
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
    },
  };
  // 14a) formato inválido → error claro
  r = await handler(
    req({ type: 2, data: { name: 'vincular', options: [{ name: 'riot', options: [{ name: 'nombre', value: 'sin gato' }] }] }, member: { user: { id: '777', username: 'nuevo' }, permissions: '0' } }),
    envVin, {},
  );
  j = await r.json();
  console.assert(j.type === 4 && String(j.data.content).includes('Formato inválido'), 'vincular formato mal');
  // 14b) usuario nuevo → crea ficha + vincula + embed de éxito con Bienvenido
  r = await handler(
    req({ type: 2, data: { name: 'vincular', options: [{ name: 'riot', options: [{ name: 'nombre', value: 'NuevoJugador#LA1' }] }] }, member: { user: { id: '777', username: 'nuevo' }, permissions: '0' } }),
    envVin, {},
  );
  j = await r.json();
  const embed = j?.data?.embeds?.[0];
  console.assert(inserts === 1, 'vincular no insertó player');
  console.assert(embed?.title?.includes('vinculada'), 'vincular éxito mal');
  console.assert((embed?.fields ?? []).some((f) => f.name.includes('Bienvenido')), 'vincular alta automática sin Bienvenido');
  // 14c) Riot ID de otro → rechazo de duplicado
  r = await handler(
    req({ type: 2, data: { name: 'vincular', options: [{ name: 'riot', options: [{ name: 'nombre', value: 'NuevoJugador#LA1' }] }] }, member: { user: { id: '888', username: 'otro' }, permissions: '0' } }),
    envVin, {},
  );
  j = await r.json();
  console.assert(String(j?.data?.content).includes('ya está vinculado'), 'vincular duplicado mal');
  // 14d) nombre Riot CON ESPACIO (gameName real, ej: "Kick Feispla#000") → acepta
  const insertsAntes = inserts;
  r = await handler(
    req({ type: 2, data: { name: 'vincular', options: [{ name: 'riot', options: [{ name: 'nombre', value: 'Kick Feispla#000' }] }] }, member: { user: { id: '999', username: 'owner2' }, permissions: '0' } }),
    envVin, {},
  );
  j = await r.json();
  console.assert(j?.data?.embeds?.[0]?.title?.includes('vinculada'), 'vincular con espacio mal');
  console.assert(inserts === insertsAntes + 1, 'vincular con espacio no insertó player');
}

// ── 15) VANTS-BUS: sin configurar todo degrada con mensajes claros ──────────
import { cicloBus, publicarBus, busCliente } from './src/bus.js';

// /bus-test sin secreto → 401
r = await handler(new Request('https://vantsbot.example/bus-test', { method: 'POST', body: '{}' }), envSim, {});
console.assert(r.status === 401, 'bus-test 401 mal');

let out = await cicloBus(envSim);
console.assert(out.deshabilitado === true, 'cicloBus sin secreto debe estar deshabilitado');
out = await publicarBus(envSim, 'stream.live', {});
console.assert(out.ok === false && out.deshabilitado === true, 'publicarBus sin config mal');
console.assert(busCliente(envSim) === null, 'busCliente sin config debe ser null');
// URL sola sin secreto también es null; binding sin secreto también
console.assert(busCliente({ VANTS_BUS_URL: 'https://x/' }) === null, 'busCliente URL sin secreto debe ser null');
const bindFalso = { fetch: async (u, i) => new Response(JSON.stringify({ ok: true, via: 'binding' }), { status: 200 }) };
out = await publicarBus({ VANTS_BUS_SECRET: 'x'.repeat(16), VANTS_BUS_SERVICE: bindFalso }, 'stream.live', {});
console.assert(out.ok === true && out.via === 'binding', `publicarBus vía binding mal: ${JSON.stringify(out)}`);

// ── 16) cicloBus con bus simulado: firma HMAC, anuncios y cursor en D1 ──────
const SECRET_BUS = 'bus-secret-de-prueba-32-chars-ok';
const canalesBus = new Map([['resultados', '999000000000000001'], ['anuncios', '800000000000000002']]);
const busMem = { cursor: '', servido: false, publicaciones: [] };
const envBus = {
  DISCORD_BOT_TOKEN: envSim.DISCORD_BOT_TOKEN,
  VANTS_BUS_URL: 'https://bus.example/',
  VANTS_BUS_SECRET: SECRET_BUS,
  VANTS_BUS_PROJECT: 'vantsbot',
  DB: {
    prepare(sql) {
      return {
        bind: (...p) => ({
          all: async () => ({ results: [] }),
          first: async () => {
            if (sql.includes('FROM bus_estado')) return busMem.cursor ? { valor: busMem.cursor } : null;
            if (sql.includes('FROM discord_channels')) {
              const cat = String(p[0] ?? '');
              return canalesBus.has(cat) ? { channel_id: canalesBus.get(cat) } : null;
            }
            return null;
          },
          run: async () => {
            if (sql.includes('INSERT INTO bus_estado')) busMem.cursor = String(p[0]);
            return { meta: { changes: 1 } };
          },
        }),
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => ({ meta: { changes: 1 } }),
      };
    },
  },
};

// fetch simulado del bus: valida la firma HMAC del contrato y sirve 2 eventos
const fetchBus = async (url, init = {}) => {
  const u = new URL(url);
  const ts = init.headers?.['X-VANTS-Timestamp'] ?? '';
  const sig = init.headers?.['X-VANTS-Signature'] ?? '';
  const proyecto = init.headers?.['X-VANTS-Project'] ?? '';
  if (proyecto !== 'vantsbot') return new Response(JSON.stringify({ error: 'project' }), { status: 401 });
  const rawBody = init.method === 'GET' ? '' : String(init.body ?? '');
  const esperada = createHmac('sha256', SECRET_BUS).update(`${ts}.${rawBody}`).digest('hex');
  if (sig !== esperada) return new Response(JSON.stringify({ error: 'bad signature' }), { status: 401 });

  if (init.method === 'POST') {
    const cuerpo = JSON.parse(rawBody);
    busMem.publicaciones.push(cuerpo);
    return new Response(JSON.stringify({ ok: true, id: 123 }), { status: 200 });
  }
  if (!busMem.servido) {
    busMem.servido = true;
    return new Response(JSON.stringify({
      events: [
        { id: 'e1', type: 'match.finished', source: 'faceit', ts: '2026-10-28T10:00:00Z', data: { title: 'Alpha vs Bravo', score: '13-9', mapa: 'Ascent' } },
        { id: 'e2', type: 'clip.published', source: 'web', ts: '2026-10-28T10:05:00Z', data: { title: 'Aces de la semana', url: 'https://vants.vants.workers.dev/clips' } },
      ],
      cursor: 'e2',
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ events: [], cursor: null }), { status: 200 });
};

// Interceptamos la API de Discord y el bus simulado para no salir a la red
const fetchReal = globalThis.fetch;
const mensajesDiscord = [];
const fetchInterceptado = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://discord.com/api/')) {
    mensajesDiscord.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
  }
  if (u.startsWith('https://bus.example/')) return fetchBus(url, init);
  return fetchReal(url, init);
};
globalThis.fetch = fetchInterceptado;

out = await cicloBus(envBus, fetchBus);
console.assert(out.recibidos === 2 && out.anunciadas === 2 && out.fallos === 0, `cicloBus primera vuelta mal: ${JSON.stringify(out)}`);
console.assert(busMem.cursor === 'e2', 'cursor no guardó e2');
console.assert(mensajesDiscord.length === 2, 'debió anunciar 2 embeds');
console.assert(mensajesDiscord[0].body.embeds[0].title.includes('🏁'), 'embed match.finished sin emoji');
console.assert(mensajesDiscord[0].body.embeds[0].footer.text.includes('faceit'), 'footer sin fuente');
console.assert((mensajesDiscord[0].body.embeds[0].fields ?? []).some((f) => f.name === 'score'), 'campo dinámico score mal');
console.assert(mensajesDiscord[1].body.embeds[0].url === 'https://vants.vants.workers.dev/clips', 'url del clip mal');

// Segunda vuelta: cursor e2 → el bus ya no devuelve nada (sin repetir)
out = await cicloBus(envBus, fetchBus);
console.assert(out.recibidos === 0 && out.anunciadas === 0 && busMem.cursor === 'e2', 'segunda vuelta repitió eventos');

// publicarBus firma y publica stream.live
out = await publicarBus(envBus, 'stream.live', { username: 'vants', platform: 'kick' }, fetchBus);
console.assert(out.ok === true, 'publicarBus firmado mal');
console.assert(busMem.publicaciones.some((p) => p.type === 'stream.live' && p.data.username === 'vants'), 'stream.live no llegó al bus');

// Kick real con bus configurado → el aviso Y el publish al bus
const payloadLive2 = { broadcaster_username: 'vants', is_live: true, title: 'Scrim final', started_at: '2026-10-28T12:00:00Z' };
r = await handler(
  new Request('https://vantsbot.example/kick', {
    method: 'POST',
    body: JSON.stringify(payloadLive2),
    headers: {
      'x-kick-event-type': 'livestream.status.updated',
      'x-kick-event-id': 'evt-bus-1',
      'x-kick-signature': createHmac('sha256', envSim.KICK_CLIENT_SECRET).update(JSON.stringify(payloadLive2)).digest('hex'),
    },
  }),
  { ...envBus, KICK_CLIENT_SECRET: envSim.KICK_CLIENT_SECRET, KICK_USERNAME: envSim.KICK_USERNAME, DB: envSim.DB },
  {},
);
j = await r.json();
console.assert(j.ok === true && j.bus?.ok === true, `kick→bus mal: ${JSON.stringify(j)}`);
console.assert(busMem.publicaciones.filter((p) => p.type === 'stream.live').length === 2, 'kick no publicó stream.live');

// /bus-test con secreto: mismo camino del cron con canal resultados
r = await handler(
  new Request('https://vantsbot.example/bus-test', { method: 'POST', body: '{}', headers: { 'x-vants-bot': envSim.VANTS_BOT_SECRET } }),
  { ...envBus, VANTS_BOT_SECRET: envSim.VANTS_BOT_SECRET },
  {},
);
j = await r.json();
console.assert(j.ok === true && j.enviado === true, `bus-test mal: ${JSON.stringify(j)}`);

// scheduled() no explota ni con el bus deshabilitado (envSim, sin red)
const entradaEstatica = (await import('./src/index.js')).default;
globalThis.fetch = fetchReal;
await entradaEstatica.scheduled({}, envSim, {});
globalThis.fetch = fetchReal; // restauramos la red real para el resto del smoke
console.log('SMOKE v3 OK: ping, ayuda, gate, kick (+bus), avisar, evento-discord, agente, soporte, ia, fabrica (gate/nueva/estado/botones), vincular (alta automática/duplicado), bus (ciclo/cursor/publish/bus-test/scheduled), setup, salud');
