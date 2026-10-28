// Validación: importa los módulos del Worker y verifica el menú de comandos
import { COMANDOS } from './src/defs.js';
import { construir } from './src/index.js';
import { _fab, fabricaBoton } from './src/fabrica.js';
import { ia } from './src/openai.js';
import { esStaff, PERM } from './src/util.js';

const ESPERADOS = [
  'ayuda', 'perfil', 'ranking', 'torneos', 'eventos', 'calendario', 'planes',
  'reglas', 'soporte', 'ia', 'fabrica', 'agente', 'vincular', 'vants', 'warn',
  'kick', 'ban', 'mute', 'unmute', 'clear', 'lock', 'unlock', 'informe',
];

const nombres = COMANDOS.map((c) => c.name);
const falta = ESPERADOS.filter((n) => !nombres.includes(n));
const sobra = nombres.filter((n) => !ESPERADOS.includes(n));
if (falta.length || sobra.length) {
  console.error('FALTA:', falta, 'SOBRA:', sobra);
  process.exit(1);
}

// Verificar subcomandos y choices
const vants = COMANDOS.find((c) => c.name === 'vants');
const subs = vants.options.map((o) => o.name);
console.assert(subs.join(',') === 'canal,estado,rol', 'subcomandos vants mal');
const grupoRol = vants.options.find((o) => o.name === 'rol');
console.assert(grupoRol.type === 2 && grupoRol.options.map((o) => o.name).join(',') === 'agregar,quitar,lista', 'grupo /vants rol mal');
console.assert(grupoRol.options[0].options[0].type === 8, 'opción rol debe ser type 8 (ROLE)');
const choices = vants.options[0].options[0].choices.map((c) => c.value);
console.assert(choices.join(',') === 'anuncios,registros,ranked,staff,logs,directos,resultados,agenda,clips', 'choices mal');
const vincular = COMANDOS.find((c) => c.name === 'vincular');
console.assert(vincular.options[0].name === 'riot', 'sub riot mal');
const agente = COMANDOS.find((c) => c.name === 'agente');
console.assert(agente.options.map((o) => o.name).join(',') === 'estado,informe,incidentes,resolver,comando', 'sub agente mal');
const soporte = COMANDOS.find((c) => c.name === 'soporte');
console.assert(soporte.options[0].name === 'pregunta' && soporte.options[0].required === false, 'soporte pregunta mal');
const cmdIa = COMANDOS.find((c) => c.name === 'ia');
console.assert(cmdIa.options[0].name === 'pregunta' && cmdIa.options[0].required === true, 'ia pregunta mal');
console.assert(
  cmdIa.options[1].choices.map((c) => c.value).join(',') === 'nano,mini,sol,astra,terra,luna',
  'choices de modelo de /ia mal',
);
const fabrica = COMANDOS.find((c) => c.name === 'fabrica');
console.assert(fabrica.options.map((o) => o.name).join(',') === 'nueva,estado,lista,cancelar', 'sub fabrica mal');
console.assert(fabrica.options[0].options[0].name === 'idea' && fabrica.options[0].options[0].required === true, 'fabrica idea mal');

// default_member_permissions: los 12 de staff ocultos para miembros, los demás públicos
const PERMISOS_ESPERADOS = {
  vants: '32', informe: '32', fabrica: '32', agente: '32',
  warn: '1099511627776', kick: '2', ban: '4', mute: '1099511627776',
  unmute: '1099511627776', clear: '8192', lock: '16', unlock: '16',
};
for (const c of COMANDOS) {
  const esperado = PERMISOS_ESPERADOS[c.name] ?? null;
  console.assert((c.default_member_permissions ?? null) === esperado, `default_member_permissions de /${c.name} mal`);
}
console.assert(Object.keys(PERMISOS_ESPERADOS).length === 12, 'deben ser 12 comandos de staff ocultos');

// esStaff: pasa por bit de Discord, por rol de D1 o por admin; niega al resto
const dbStaff = {
  prepare(sql) {
    return {
      bind: (...p) => ({
        all: async () => (sql.includes('roles_admin') ? { results: [{ role_id: 'rol-staff-1' }] } : { results: [] }),
        first: async () => null,
        run: async () => ({ meta: { changes: 1 } }),
      }),
    };
  },
};
const bodyStaff = { guild_id: 'g1', member: { user: { id: 'u1' }, permissions: '0', roles: ['rol-staff-1'] } };
console.assert((await esStaff({ DB: dbStaff }, bodyStaff, PERM.MANAGE_GUILD)) === true, 'esStaff por rol D1 mal');
console.assert((await esStaff({ DB: dbStaff }, { guild_id: 'g1', member: { user: { id: 'u1' }, permissions: '0', roles: ['otro'] } }, PERM.MANAGE_GUILD)) === false, 'esStaff niega sin rol mal');
console.assert((await esStaff({ DB: dbStaff }, { member: { user: { id: 'u1' }, permissions: '8' } }, PERM.MANAGE_GUILD)) === true, 'esStaff por admin mal');
console.assert((await esStaff({ DB: dbStaff }, { member: { user: { id: 'u1' }, permissions: '0' } }, PERM.MANAGE_GUILD)) === false, 'esStaff sin roles ni permiso mal');

// Handler instalable
const handler = construir({ saltarFirma: true });
if (typeof handler !== 'function') throw new Error('handler no es función');

// ── Máquina de estados de la fábrica (con D1 simulada, sin red) ─────────────
const dbMem = { corridas: new Map(), pasos: [] };
let nextId = 7;

function aplicarUpdate(sql, params, f) {
  // devuelvo { ok } aplicando la misma semántica que los guards reales
  if (sql.includes("SET etapa = 'espec'")) {
    if (f.etapa !== 'entrada' || f.estado !== 'activa') return false;
    f.etapa = 'espec';
  } else if (sql.includes("SET etapa = 'build'") && sql.includes('sol_ok = 0')) {
    // bucle rojo (auto o reintento humano)
    if (f.etapa !== 'aprobacion' || f.estado !== 'activa' || Number(f.vueltas) >= 2) return false;
    f.etapa = 'build'; f.vueltas += 1; f.sol_ok = 0; f.ui_ok = 0; f.veredicto = 'RECHAZADO';
  } else if (sql.includes('vueltas = vueltas + 1')) {
    if (f.etapa !== 'espec' || f.estado !== 'activa') return false;
    f.etapa = 'build'; f.vueltas += 1;
  } else if (sql.includes('SET ui_ok = 1')) {
    if (f.etapa !== 'build' || f.ui_ok !== 0 || f.estado !== 'activa') return false;
    f.ui_ok = 1; if (Number(f.sol_ok) === 1) f.etapa = 'revision';
  } else if (sql.includes('SET sol_ok = 1')) {
    if (f.etapa !== 'build' || f.sol_ok !== 0 || f.estado !== 'activa') return false;
    f.sol_ok = 1; if (Number(f.ui_ok) === 1) f.etapa = 'revision';
  } else if (sql.includes("SET etapa = 'aprobacion'")) {
    if (f.etapa !== 'revision' || f.estado !== 'activa') return false;
    f.etapa = 'aprobacion'; f.veredicto = null; f.tamano = null;
  } else if (sql.includes("decision_humano = 'main_directo'")) {
    // regla del dueño: APROBADO+PEQUEÑO → cierre automático en una escritura
    if (f.etapa !== 'aprobacion' || f.veredicto !== null || f.estado !== 'activa') return false;
    f.veredicto = 'APROBADO'; f.tamano = 'PEQUENO'; f.decision_humano = 'main_directo'; f.estado = 'hecha';
  } else if (sql.includes('SET veredicto = ?')) {
    if (f.etapa !== 'aprobacion' || f.veredicto !== null) return false;
    f.veredicto = params[0];
    f.tamano = params.length >= 4 ? params[1] : null; // [veredicto, tamano, ahora, id]
  } else if (sql.includes("estado = 'cancelada'")) {
    if (f.estado !== 'activa') return false;
    f.estado = 'cancelada';
  } else if (sql.includes("estado = 'hecha'")) {
    if (f.etapa !== 'aprobacion' || f.estado !== 'activa') return false;
    f.decision_humano = params[0]; f.estado = 'hecha';
  } else {
    return false;
  }
  f.actualizado_en = '2026-10-28T00:00:00Z';
  return true;
}

const dbFalsa = {
  prepare(sql) {
    return {
      bind: (...params) => ({
        all: async () => ({
          results: [...dbMem.corridas.values()].sort((a, b) => b.id - a.id),
        }),
        first: async () => {
          if (sql.includes('fabrica_corridas') && sql.includes('WHERE id = ? LIMIT 1')) {
            return dbMem.corridas.get(params[0]) ?? null;
          }
          if (sql.includes('fabrica_pasos')) {
            const paso = [...dbMem.pasos].reverse().find((p) => p.corrida_id === params[0] && p.etapa === params[1]);
            return paso ? { contenido: paso.contenido } : null;
          }
          if (sql.includes('count(*)')) return { n: 0 };
          return null;
        },
        run: async () => {
          if (sql.includes('INSERT INTO fabrica_corridas')) {
            const id = nextId++;
            dbMem.corridas.set(id, {
              id, guild_id: params[0], canal_id: params[1], autor_id: params[2], idea: params[3],
              etapa: params[4], vueltas: 0, sol_ok: 0, ui_ok: 0, veredicto: null,
              tamano: null, decision_humano: null, estado: params[5], creado_en: params[6], actualizado_en: params[7],
            });
            return { meta: { changes: 1, last_row_id: id } };
          }
          if (sql.startsWith('UPDATE fabrica_corridas')) {
            // el id SIEMPRE es el último parámetro en los UPDATE de la fábrica
            const id = params[params.length - 1];
            const f = dbMem.corridas.get(id);
            if (!f) return { meta: { changes: 0 } };
            return { meta: { changes: aplicarUpdate(sql, params, f) ? 1 : 0 } };
          }
          if (sql.includes('INSERT INTO fabrica_pasos')) {
            dbMem.pasos.push({ corrida_id: params[0], etapa: params[1], modo: params[2], contenido: params[4] });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      }),
    };
  },
};

const envFab = { DB: dbFalsa }; // sin claves IA → modo plantillas, sin red

const fila0 = {
  id: 7, guild_id: 'g', canal_id: 'c', autor_id: '123', idea: 'buscar de jugadores en la web',
  etapa: 'entrada', vueltas: 0, sol_ok: 0, ui_ok: 0, veredicto: null,
  decision_humano: null, estado: 'activa', creado_en: 'x', actualizado_en: 'x',
};

// espec (plantilla) → botón Builder
dbMem.corridas.set(7, { ...fila0 });
const f7 = () => dbMem.corridas.get(7);
let sal = await _fab.ejecutarEtapa(envFab, f7(), 'espec');
console.assert(sal.embeds?.[0]?.title.includes('Spec'), 'fab espec title mal');
console.assert(String(sal.embeds[0].description).includes('Modo plantillas'), 'fab espec modo mal');
console.assert(sal.components?.[0]?.components?.[0]?.custom_id === 'fabrica:build:7', 'fab espec boton mal');

// build → botones Sol + Astra
sal = await _fab.ejecutarEtapa(envFab, f7(), 'build');
const ids = sal.components?.[0]?.components?.map((b) => b.custom_id) ?? [];
console.assert(ids.join(',').includes('fabrica:sol:7') && ids.join(',').includes('fabrica:ui:7'), 'fab build botones mal');

// sol → sigue esperando Astra (ya no repite el botón de Sol)
sal = await _fab.ejecutarEtapa(envFab, f7(), 'sol');
console.assert(!sal.components?.[0]?.components?.some((b) => b.custom_id === 'fabrica:sol:7'), 'fab sol repite boton');

// ui (tras sol) → revision → botón Approver
sal = await _fab.ejecutarEtapa(envFab, f7(), 'ui');
console.assert(sal.components?.[0]?.components?.[0]?.custom_id === 'fabrica:aprobar:7', 'fab ui approver mal');

// approver en plantilla → sin veredicto → puerta humana
sal = await _fab.ejecutarEtapa(envFab, f7(), 'aprobacion');
const idsA = sal.components?.[0]?.components?.map((b) => b.custom_id) ?? [];
console.assert(idsA.includes('fabrica:main:7') && idsA.includes('fabrica:pr:7') && idsA.includes('fabrica:reintento:7'), 'fab puerta humana mal');

// decisión humana → guard anti-doble-clic
sal = await _fab.ejecutarEtapa(envFab, f7(), 'aprobacion'); // repetido → guard lo rechaza
console.assert(String(sal.content ?? '').includes('ya avanzó'), 'fab guard duplicado mal');

// parser de veredicto
console.assert(_fab.veredictoDe('bla\nVEREDICTO: RECHAZADO') === 'RECHAZADO', 'veredicto parse mal');
console.assert(_fab.veredictoDe('sin veredicto') === null, 'veredicto vacio mal');

// botones: ver → embed; gate dueno/staff; corrida inexistente
let resBoton = await fabricaBoton(envFab, {
  data: { custom_id: 'fabrica:ver:7' },
  member: { user: { id: '123' }, permissions: '0' },
});
console.assert(resBoton.tipo === 4 && resBoton.data.embeds?.[0]?.title.includes('#7'), 'fab ver mal');

resBoton = await fabricaBoton(envFab, {
  data: { custom_id: 'fabrica:build:7' },
  member: { user: { id: '999' }, permissions: '0' },
});
console.assert(resBoton.tipo === 4 && String(resBoton.data.content).includes('staff'), 'fab gate boton mal');

resBoton = await fabricaBoton(envFab, {
  data: { custom_id: 'fabrica:build:99' },
  member: { user: { id: '123' }, permissions: '8' },
});
console.assert(resBoton.tipo === 4 && String(resBoton.data.content).includes('#99'), 'fab corrida fantasma mal');

// proveedores: sin claude → solo OpenAI; con claude → primero Anthropic en las etapas Opus
const provSin = _fab.proveedoresDe({}, 'espec');
console.assert(provSin.length === 1 && provSin[0][0] === 'openai', 'proveedores sin claude mal');
const provCon = _fab.proveedoresDe({ ANTHROPIC_API_KEY: 'k' }, 'aprobacion');
console.assert(provCon[0][0] === 'anthropic' && provCon[0][1].includes('opus'), 'proveedores con claude mal');
const provSol = _fab.proveedoresDe({ ANTHROPIC_API_KEY: 'k' }, 'sol');
console.assert(provSol[0][0] === 'openai' && provSol[0][1] === 'gpt-6-sol', 'proveedores sol mal');

// ── Regla del dueño: el Approver clasifica el tamaño y la máquina se auto-ruta ──
console.assert(_fab.tamanoDe('razones...\nTAMANO: PEQUENO') === 'PEQUENO', 'tamano PEQUENO mal');
console.assert(_fab.tamanoDe('TAMANO: PEQUEÑO') === 'PEQUENO', 'tamano con Ñ mal');
console.assert(_fab.tamanoDe('TAMANO: GRANDE') === 'GRANDE', 'tamano GRANDE mal');
console.assert(_fab.tamanoDe('sin clasificación') === null, 'tamano vacío → null (escala al humano)');

// fetch falso: Anthropic "responde" lo que cada corrida necesita (sin red real).
// El veredicto se decide por la idea de la corrida (aparece en el prompt).
const fetchReal = globalThis.fetch;
const veredictoPorCorrida = { 8: 'APROBADO\nTAMANO: PEQUENO', 9: 'APROBADO\nTAMANO: GRANDE', 10: 'RECHAZADO' };
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('anthropic')) throw new Error(`fetch inesperado: ${url}`);
  const cuerpo = String(opts?.body ?? '');
  const id = cuerpo.includes('grande #9') ? 9
    : cuerpo.includes('pequeño #8') ? 8
      : 10;
  const v = veredictoPorCorrida[id] ?? 'APROBADO\nTAMANO: GRANDE';
  return {
    status: 200,
    json: async () => ({ content: [{ type: 'text', text: `Razones concretas.\nVEREDICTO: ${v}` }] }),
  };
};

const envIa = { DB: dbFalsa, ANTHROPIC_API_KEY: 'clave-de-test' };
const nuevaCorrida = (id, idea) => {
  dbMem.corridas.set(id, { ...fila0, id, idea, autor_id: '123' });
  return () => dbMem.corridas.get(id);
};
const pasoTodo = async (f) => {
  await _fab.ejecutarEtapa(envIa, f(), 'espec');
  await _fab.ejecutarEtapa(envIa, f(), 'build');
  await _fab.ejecutarEtapa(envIa, f(), 'sol');
  await _fab.ejecutarEtapa(envIa, f(), 'ui');
  return _fab.ejecutarEtapa(envIa, f(), 'aprobacion');
};

// corrida #8 · PEQUEÑO → ⚡ main directo AUTOMÁTICO ("directamente se sube")
const f8 = nuevaCorrida(8, 'cambio pequeño #8: ajustar un texto');
let sal8 = await pasoTodo(f8);
console.assert(f8().estado === 'hecha' && f8().decision_humano === 'main_directo', 'fab #8 no cerró sola');
console.assert(f8().tamano === 'PEQUENO' && f8().veredicto === 'APROBADO', 'fab #8 tamano mal');
console.assert(sal8.embeds?.[0]?.title.includes('Directo a main'), 'fab #8 título mal');
console.assert(!sal8.components, 'fab #8 no debe tener botones (ya está hecha)');

// corrida #9 · GRANDE → 🔀 PR primero (apruebo yo)
const f9 = nuevaCorrida(9, 'rediseño grande #9 de la web');
let sal9 = await pasoTodo(f9);
console.assert(f9().estado === 'activa' && f9().etapa === 'aprobacion', 'fab #9 debe esperar al humano');
console.assert(f9().tamano === 'GRANDE', 'fab #9 tamano mal');
const ids9 = sal9.components?.[0]?.components?.map((b) => b.custom_id) ?? [];
console.assert(ids9[0] === 'fabrica:pr:9', `fab #9 PR debe ir primero: ${ids9}`);
console.assert(String(sal9.embeds?.[0]?.description).includes('GRANDE'), 'fab #9 nota de regla mal');

// corrida #10 · RECHAZADO → bucle rojo al Builder (regla 3)
const f10 = nuevaCorrida(10, 'idea #10 rechazada');
let sal10 = await pasoTodo(f10);
// el claim del Builder contó vuelta 1 y el bucle rojo la llevó a vuelta 2
console.assert(f10().etapa === 'build' && Number(f10().vueltas) === 2, 'fab #10 no volvió al Builder');
console.assert(String(sal10.embeds?.[0]?.title).includes('bucle rojo'), 'fab #10 título bucle mal');
const ids10 = sal10.components?.[0]?.components?.map((b) => b.custom_id) ?? [];
console.assert(ids10.join(',').includes('fabrica:sol:10') && ids10.join(',').includes('fabrica:ui:10'), 'fab #10 botones de re-build mal');

// RECHAZADO en vuelta 1 → UN bucle rojo automático (claim del Builder ya contó
// vuelta 1; el rebote la lleva a 2). En la 2ª vuelta ya no rebota: escala al humano.
await _fab.ejecutarEtapa(envIa, f10(), 'sol');
await _fab.ejecutarEtapa(envIa, f10(), 'ui');
await _fab.ejecutarEtapa(envIa, f10(), 'aprobar');
sal10 = await _fab.ejecutarEtapa(envIa, f10(), 'aprobacion');
console.assert(f10().etapa === 'aprobacion' && f10().veredicto === 'RECHAZADO', 'fab #10 escalado mal');
const ids10b = sal10.components?.[0]?.components?.map((b) => b.custom_id) ?? [];
console.assert(ids10b.includes('fabrica:main:10') && ids10b.includes('fabrica:pr:10'), 'fab #10 puerta humana final mal');

globalThis.fetch = fetchReal; // restaurar red

// ── /ia con cerebro dual: OpenAI primario, Claude de respaldo ────────────────
const bodyIa = (id, modelo) => ({
  member: { user: { id }, permissions: '0' },
  data: { options: [{ name: 'pregunta', value: '¿cómo funciona VANTS?' }, ...(modelo ? [{ name: 'modelo', value: modelo }] : [])] },
});

// A) sin OPENAI_API_KEY pero con ANTHROPIC_API_KEY → responde Claude (respaldo)
globalThis.fetch = async (url) => (String(url).includes('anthropic')
  ? { status: 200, json: async () => ({ content: [{ type: 'text', text: 'Respuesta de Claude' }] }) }
  : { status: 200, json: async () => ({ choices: [{ message: { content: 'de openai' } }] }) });
let rIa = await ia({ ANTHROPIC_API_KEY: 'k' }, bodyIa('ia-a'));
console.assert(rIa.embeds?.[0]?.description === 'Respuesta de Claude', 'ia solo-claude mal');
console.assert(String(rIa.embeds?.[0]?.footer?.text).includes('respaldo'), 'ia solo-claude footer mal');

// B) OpenAI sin créditos (429) → Claude responde
globalThis.fetch = async (url) => (String(url).includes('anthropic')
  ? { status: 200, json: async () => ({ content: [{ type: 'text', text: 'Claude salva la pregunta' }] }) }
  : { status: 429, json: async () => ({ error: { code: 'insufficient_quota', message: 'insufficient_quota' } }) });
rIa = await ia({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }, bodyIa('ia-b'));
console.assert(rIa.embeds?.[0]?.description === 'Claude salva la pregunta', 'ia respaldo por quota mal');

// C) ambos fallan → aviso de OpenAI + nota de que Claude tampoco pudo
globalThis.fetch = async (url) => (String(url).includes('anthropic')
  ? { status: 500, json: async () => ({}) }
  : { status: 429, json: async () => ({ error: { code: 'insufficient_quota', message: 'sin créditos' } }) });
rIa = await ia({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }, bodyIa('ia-c'));
console.assert(String(rIa.content).includes('no tiene créditos') && String(rIa.content).includes('respaldo de Claude'), 'ia doble fallo mal');

// D) OpenAI feliz → sin respaldo, footer de OpenAI
globalThis.fetch = async (url) => (String(url).includes('anthropic')
  ? { status: 500, json: async () => ({}) }
  : { status: 200, json: async () => ({ choices: [{ message: { content: 'Respuesta normal de OpenAI' } }] }) });
rIa = await ia({ OPENAI_API_KEY: 'k' }, bodyIa('ia-d'));
console.assert(String(rIa.embeds?.[0]?.footer?.text).includes('OpenAI') && !String(rIa.embeds?.[0]?.footer?.text).includes('respaldo'), 'ia normal footer mal');

globalThis.fetch = fetchReal; // restaurar red

console.log(`OK: ${nombres.length} comandos → ${nombres.join(', ')}`);
console.log('OK: handler del Worker construido');
console.log('OK: 12 comandos de staff ocultos para miembros (default_member_permissions) + grupo /vants rol');
console.log('OK: esStaff (permiso de Discord O rol de staff en D1 O admin)');
console.log('OK: máquina de la fábrica (espec → build → sol/ui → aprobación, plantillas, gates)');
console.log('OK: regla del dueño (pequeño → main directo automático · grande → PR · rechazo → bucle rojo)');
console.log('OK: /ia con cerebro dual (OpenAI primario · Claude respaldo · avisos legibles)');
