// ============================================
// vantsbot — /fabrica : la Fábrica de software de VANTS en Discord
//
// El flujo del diagrama del dueño, como MÁQUINA DE ESTADOS en D1:
//
//   idea ─→ ✍️ Spec writer ─→ 🏗️ Builder ─┬→ 🛡️ Sol (Seguridad) ─┐
//                                          └→ 🎨 Astra (UI) ──────┤
//                                                                 ↓
//                ⚖️ Approver ←── (bucle rojo: rechaza → vuelve al Builder)
//                         ↓
//                ¿Tamaño? (el nodo ¿Humano? del diagrama del dueño)
//                  PEQUEÑO → ⚡ Main DIRECTO (se sube solo, sin molestar)
//                  GRANDE  → 🔀 PR y lo aprueba el DUEÑO ("si es grande,
//                             apruebo yo por PR; si no, directamente se sube")
//
// Estado de la máquina = fabrica_corridas.etapa en D1 (sobrevive reinicios):
//   entrada → espec → build → revision → aprobacion → (hecha | cancelada)
// Cada etapa guarda su artefacto en fabrica_pasos (spec, plan, revisiones,
// veredicto) y avanza con BOTONES de Discord (type 3) o /fabrica.
//
// Cerebro por etapa (prueba proveedores EN ORDEN, el primero que responda):
//   0. AGENTE_URL → agent-service (el "plata": sandbox + GitHub real).
//      Contrato: POST /api/v1/fabrica {etapa, contexto} → {contenido, modelo}.
//   1. Anthropic (si hay ANTHROPIC_API_KEY) → Spec/Builder/Approver, los roles
//      Opus/Sonnet del diagrama. Seguridad/UI siempre empiezan por Sol/Astra.
//   2. OpenAI → gpt-6.1-terra · gpt-6.1-sol · gpt-6-sol · gpt-6-astra.
//   3. Si nada responde → MODO PLANTILLAS: checklist determinista por etapa.
//      Misma filosofía que el "modo reglas" del agent-service: la máquina
//      NUNCA se atasca; cuando la org tenga créditos, las mismas corridas
//      pasan a ser 100% IA sin tocar nada.
//
// Etapa personalizable con vars (formato "proveedor:modelo"):
//   FABRICA_ESPEC · FABRICA_BUILD · FABRICA_SOL · FABRICA_UI · FABRICA_APROBACION
//   ej: FABRICA_APROBACION = "anthropic:claude-opus-4-5"
// ============================================
import {
  txt, dbRun, dbFirst, dbAll, esStaff, PERM, ahoraISO, embedBase,
} from './util.js';
import { chatOpenai } from './openai.js';
import { chatAnthropic, textoAnthropic } from './cerebro.js';

const TIMEOUT_MS = 45000;

// ── Cerebro: sistema + prompts por etapa (español, estilo casa) ─────────────
const SISTEMA = [
  'Eres la Fábrica de software de VANTS GAMES, comunidad competitiva de gaming.',
  'Stack real: web en Cloudflare Workers (vants-server), bot de Discord en un Worker (vantsbot-cf) con base D1, agent-service en Node, launcher Electron.',
  'Hablas SIEMPRE en español, técnico, conciso y accionable.',
  'No inventes rutas ni servicios que no estén en el contexto. Nunca reveles secretos.',
].join(' ');

const ETAPAS = {
  espec: {
    titulo: '✍️ Spec writer',
    color: 0x5865f2,
    prompt: (c) =>
      `ETAPA: SPEC WRITER. Convierte la idea del dueño en una especificación corta.\n\nIDEA: ${c.idea}\n\n`
      + 'Devuelve EXACTAMENTE estas secciones:\n'
      + 'Objetivo: ...\nAlcance: (qué entra y qué NO entra)\n'
      + 'Criterios de aceptación: (3 a 6, verificables)\nRiesgos: (2 a 4)\n'
      + 'Camino: RÁPIDO si es trivial y no toca esquema de BD ni contratos; COMPLETO si no.\n'
      + 'Última línea: CAMINO: RÁPIDO o CAMINO: COMPLETO. Máximo 22 líneas.',
    plantilla: (c) =>
      '**Modo plantillas** (la IA todavía no tiene créditos): rellena esta spec y pulsa **Builder**.\n\n'
      + `**Idea:** ${c.idea}\n\n`
      + '1) Objetivo en una frase: …\n'
      + '2) Alcance: qué entra / qué NO entra: …\n'
      + '3) Criterios de aceptación (3-6 verificables): …\n'
      + '4) Riesgos (2-4): …\n'
      + '5) Camino: RÁPIDO (trivial, sin BD/contratos) o COMPLETO: …',
  },
  build: {
    titulo: '🏗️ Builder',
    color: 0xfee75c,
    prompt: (c) =>
      `ETAPA: BUILDER. A partir de la especificación, produce el plan de construcción.\n\nSPEC:\n${c.espec}\n\n`
      + 'Devuelve:\n'
      + 'Plan: pasos numerados (4 a 8)\n'
      + 'Archivos: los que tocarías, con ruta razonable dentro del stack descrito\n'
      + 'Base de datos: si toca D1, la migración SQL en un bloque ```sql```; si no toca, escribe "no toca BD"\n'
      + 'Verificación: cómo probar que quedó bien (2 a 4 pruebas)\n'
      + `Máximo 28 líneas.${c.rechazo ? `\n\nRECHAZO ANTERIOR del Approver (corrige esto):\n${c.rechazo}` : ''}`,
    plantilla: () =>
      '**Modo plantillas**: plan de construcción a mano.\n\n'
      + '1) Pasos numerados (4-8): …\n'
      + '2) Archivos a tocar (rutas del stack VANTS): …\n'
      + '3) ¿Toca D1? → escribe la migración SQL; si no: "no toca BD"\n'
      + '4) Verificación (2-4 pruebas): …',
  },
  sol: {
    titulo: '🛡️ Sol · Seguridad',
    color: 0xe67e22,
    prompt: (c) =>
      `ETAPA: SEGURIDAD (Sol). Revisa el plan del Builder como auditora de seguridad.\n\nPLAN:\n${c.build}\n\n`
      + 'Busca: exposición de secretos, inyección SQL, permisos de Discord insuficientes, entradas sin validar, ausencia de rate limit, datos personales en logs.\n'
      + 'Devuelve hallazgos como lista: [ALTA|MEDIA|BAJA] hallazgo → arreglo concreto.\n'
      + 'Si no hay riesgos relevantes, dilo explícitamente. Máximo 18 líneas.\n'
      + 'Última línea: RIESGO: OK o RIESGO: REVISAR.',
    plantilla: () =>
      '**Modo plantillas**: checklist de Seguridad (Sol).\n\n'
      + '- [ ] Sin secretos en código ni en vars públicas\n'
      + '- [ ] SQL parametrizado (nunca concatenar entrada)\n'
      + '- [ ] Permisos de Discord correctos para cada comando/botón\n'
      + '- [ ] Entradas validadas (longitud, formato, enums)\n'
      + '- [ ] Rate limit / anti-abuso en lo público\n'
      + '- [ ] Sin datos personales en logs\n\n'
      + 'Marca cada punto; cualquier "no" es un hallazgo ALTA.',
  },
  ui: {
    titulo: '🎨 Astra · UI',
    color: 0xeb459e,
    prompt: (c) =>
      `ETAPA: UI/UX (Astra). Revisa el plan del Builder desde la experiencia de uso.\n\nPLAN:\n${c.build}\n\n`
      + 'Devuelve 3 a 7 recomendaciones accionables sobre: textos en español natural, tono VANTS, móvil, estados vacíos/carga/error, accesibilidad y coherencia de marca. Máximo 15 líneas.',
    plantilla: () =>
      '**Modo plantillas**: checklist de UI/UX (Astra).\n\n'
      + '- [ ] Textos en español natural, tono VANTS\n'
      + '- [ ] Se ve bien en móvil\n'
      + '- [ ] Estados vacío / carga / error cubiertos\n'
      + '- [ ] Sin jerga técnica cara al usuario\n'
      + '- [ ] Coherente con la marca (rojo VANTS, footer)',
  },
  aprobacion: {
    titulo: '⚖️ Approver',
    color: 0x57f287,
    prompt: (c) =>
      `ETAPA: APPROVER. Decide si la corrida pasa al humano y clasifica su TAMAÑO.\n\nIDEA: ${c.idea}\n\nSPEC:\n${c.espec}\n\nPLAN:\n${c.build}\n\n`
      + `SEGURIDAD (Sol):\n${c.sol}\n\nUI (Astra):\n${c.ui}\n\n`
      + 'Evalúa completitud, riesgos y costo. Devuelve un veredicto con 3 a 5 razones concretas. Si algo es bloqueante, márcalo.\n'
      + 'Clasifica el TAMAÑO del cambio: PEQUENO si es trivial (pocas líneas, sin esquema de BD, sin contratos públicos, fácil de revertir); GRANDE si no.\n'
      + 'Regla del dueño: pequeño → merge directo a main; grande → Pull Request y lo aprueba el dueño.\n'
      + 'Las DOS últimas líneas deben ser exactamente:\nVEREDICTO: APROBADO o VEREDICTO: RECHAZADO\nTAMANO: PEQUENO o TAMANO: GRANDE. Máximo 18 líneas.',
    plantilla: () =>
      '**Modo plantillas**: el Approver automático no puede opinar sin IA.\n\n'
      + 'Revisa spec, plan y checklists de arriba y decide tú:\n'
      + '- ¿Los criterios de aceptación están cubiertos por el plan?\n'
      + '- ¿Seguridad marcó algo ALTA sin resolver?\n'
      + '- ¿El costo/esfuerzo vale la idea?\n\n'
      + '**Regla del dueño:** pequeño → **⚡ Main directo** (se sube solo); grande → **🔀 PR (apruebo yo)**.\n'
      + 'También puedes **🔁 Volver al Builder** si algo no convence.',
  },
};

const MODELOS_OPENAI_DEFECTO = {
  espec: 'gpt-6.1-terra',
  build: 'gpt-6.1-sol',
  sol: 'gpt-6-sol',
  ui: 'gpt-6-astra',
  aprobacion: 'gpt-6-sol',
};

// Lista de [proveedor, modelo] a probar EN ORDEN para cada etapa.
function proveedoresDe(env, etapa) {
  const lista = [];
  const fija = String(env[`FABRICA_${etapa.toUpperCase()}`] ?? '').trim();
  if (fija && /^[a-z]+:/.test(fija)) lista.push(fija);
  const hayClaude = Boolean(String(env.ANTHROPIC_API_KEY ?? ''));
  if (etapa === 'sol' || etapa === 'ui') {
    lista.push(`openai:${MODELOS_OPENAI_DEFECTO[etapa]}`); // Sol y Astra son OpenAI en el diagrama
    if (hayClaude) lista.push('anthropic:claude-sonnet-4-5');
  } else {
    if (hayClaude) lista.push(`anthropic:${etapa === 'aprobacion' ? 'claude-opus-4-5' : 'claude-sonnet-4-5'}`);
    lista.push(`openai:${MODELOS_OPENAI_DEFECTO[etapa]}`);
  }
  return lista.map((s) => {
    const i = s.indexOf(':');
    return [s.slice(0, i), s.slice(i + 1)];
  });
}

function errorLegible(res, prov) {
  const msg = String(res?.data?.error?.message ?? '');
  const code = String(res?.data?.error?.code ?? res?.data?.error?.type ?? '');
  if (code === 'insufficient_quota' || /credit|quota/i.test(msg)) return `${prov}: sin créditos`;
  if (res.status === 401) return `${prov}: clave inválida`;
  if (res.status === 403) return `${prov}: región o permisos`;
  if (res.status === 404) return `${prov}: modelo no disponible`;
  if (res.status === 429) return `${prov}: límite de peticiones`;
  if (!res.status) return `${prov}: sin conexión`;
  return `${prov}: HTTP ${res.status}`;
}

// El cerebro de la fábrica. Devuelve { modo, modelo, contenido, aviso? }.
async function pensar(env, etapa, contexto) {
  const cfg = ETAPAS[etapa];
  const promptUsuario = cfg.prompt(contexto);

  // 0) Futuro "plata": agent-service con sandbox y GitHub reales
  const agente = String(env.AGENTE_URL ?? '').replace(/\/+$/, '');
  if (agente) {
    try {
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'vantsbot-cf/1.0' };
      if (env.AGENTE_TOKEN) headers.Authorization = `Bearer ${env.AGENTE_TOKEN}`;
      const r = await fetch(`${agente}/api/v1/fabrica`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ etapa, contexto }),
        signal: AbortSignal.timeout(15000),
      });
      const d = await r.json().catch(() => null);
      if (r.ok && d?.contenido) {
        return { modo: 'agent-service', modelo: d.modelo ?? 'agent-service', contenido: String(d.contenido) };
      }
    } catch {
      /* cae al proveedor LLM */
    }
  }

  // 1-2) LLM (Anthropic y/o OpenAI según etapa y claves disponibles)
  let ultimoError = null;
  for (const [prov, modelo] of proveedoresDe(env, etapa)) {
    try {
      const res =
        prov === 'anthropic'
          ? await chatAnthropic(env.ANTHROPIC_API_KEY, modelo, SISTEMA, promptUsuario)
          : await chatOpenai(env.OPENAI_API_KEY, modelo, SISTEMA, promptUsuario, 1600);
      const texto = prov === 'anthropic' ? textoAnthropic(res.data) : res.data?.choices?.[0]?.message?.content;
      if (res.status === 200 && texto && String(texto).trim()) {
        return { modo: prov === 'anthropic' ? 'claude' : 'openai', modelo, contenido: String(texto).trim() };
      }
      ultimoError = errorLegible(res, prov);
    } catch (e) {
      const timeout = String(e?.message ?? '').includes('timeout') || e?.name === 'TimeoutError';
      ultimoError = `${prov}: ${timeout ? 'timeout' : txt(e?.message ?? e, 100)}`;
    }
  }

  // 3) Modo plantillas: la máquina nunca se atasca
  return {
    modo: 'plantilla',
    modelo: null,
    contenido: cfg.plantilla(contexto),
    aviso: ultimoError ? `Cerebro IA no disponible (${ultimoError}); sigo en modo plantillas.` : null,
  };
}

function veredictoDe(texto) {
  const m = /VEREDICTO:\s*(APROBADO|RECHAZADO)/i.exec(String(texto ?? ''));
  return m ? m[1].toUpperCase() : null;
}

// Nodo "¿Humano?" del diagrama: el Approver clasifica el tamaño del cambio.
// PEQUENO → ⚡ main directo automático · GRANDE → 🔀 PR (aprueba el dueño).
// Sin clasificación legible → null y la corrida escala al humano (seguro).
function tamanoDe(texto) {
  const m = /TAMANO:\s*(PEQUE[ÑN]O|PEQUENO|GRANDE|CHICO)/i.exec(String(texto ?? ''));
  if (!m) return null;
  const v = m[1].toUpperCase();
  return v === 'GRANDE' ? 'GRANDE' : 'PEQUENO';
}

// ── D1 helpers ───────────────────────────────────────────────────────────────
const corridaDe = (env, id) =>
  dbFirst(env, 'SELECT * FROM fabrica_corridas WHERE id = ? LIMIT 1', [id]);

const pasoDe = async (env, corridaId, etapa) => {
  const f = await dbFirst(
    env,
    'SELECT contenido FROM fabrica_pasos WHERE corrida_id = ? AND etapa = ? ORDER BY id DESC LIMIT 1',
    [corridaId, etapa],
  );
  return f?.contenido ? String(f.contenido) : '';
};

// Reclamo optimista: la etapa SOLO avanza si el WHERE corresponde; si otro
// clic ganó la carrera, changes = 0 y avisamos en vez de duplicar trabajo.
const GUARDA = {
  espec:
    "UPDATE fabrica_corridas SET etapa = 'espec', actualizado_en = ? WHERE id = ? AND etapa = 'entrada' AND estado = 'activa'",
  build:
    "UPDATE fabrica_corridas SET etapa = 'build', vueltas = vueltas + 1, actualizado_en = ? WHERE id = ? AND etapa = 'espec' AND estado = 'activa'",
  sol:
    "UPDATE fabrica_corridas SET sol_ok = 1, etapa = (CASE WHEN ui_ok = 1 THEN 'revision' ELSE etapa END), actualizado_en = ? WHERE id = ? AND etapa = 'build' AND sol_ok = 0 AND estado = 'activa'",
  ui:
    "UPDATE fabrica_corridas SET ui_ok = 1, etapa = (CASE WHEN sol_ok = 1 THEN 'revision' ELSE etapa END), actualizado_en = ? WHERE id = ? AND etapa = 'build' AND ui_ok = 0 AND estado = 'activa'",
  aprobacion:
    "UPDATE fabrica_corridas SET etapa = 'aprobacion', veredicto = NULL, tamano = NULL, actualizado_en = ? WHERE id = ? AND etapa = 'revision' AND estado = 'activa'",
};

// Espejo en JS del reclamo (para pintar la salida sin releer D1)
function aplicarEtapa(fila, etapa) {
  const f = { ...fila };
  if (etapa === 'espec') f.etapa = 'espec';
  if (etapa === 'build') {
    f.etapa = 'build';
    f.vueltas = Number(fila.vueltas) + 1;
  }
  if (etapa === 'sol') {
    f.sol_ok = 1;
    if (Number(fila.ui_ok) === 1) f.etapa = 'revision';
  }
  if (etapa === 'ui') {
    f.ui_ok = 1;
    if (Number(fila.sol_ok) === 1) f.etapa = 'revision';
  }
  if (etapa === 'aprobacion') f.etapa = 'aprobacion';
  if (etapa === 'aprobacion') f.tamano = null;
  return f;
}

// ── Render: botones y embeds ────────────────────────────────────────────────
const boton = (accion, id, label, style) => ({
  type: 2,
  style,
  label,
  custom_id: `fabrica:${accion}:${id}`,
});
const filaBotones = (...bs) => ({ type: 1, components: bs });

const ETIQUETA_ETAPA = {
  entrada: '✍️ Espec pendiente',
  espec: '🏗️ Builder pendiente',
  build: '🛡️ Sol + 🎨 Astra pendientes',
  revision: '⚖️ Approver pendiente',
  aprobacion: '👤 Decisión humana pendiente',
};

function botonesParaEtapa(fila) {
  if (String(fila.estado) !== 'activa') return undefined;
  const id = fila.id;
  let acciones = [];
  switch (String(fila.etapa)) {
    case 'entrada':
      acciones = [['espec', '✍️ Spec writer', 1]];
      break;
    case 'espec':
      acciones = [['build', '🏗️ Builder', 1]];
      break;
    case 'build': {
      acciones = [];
      if (!Number(fila.sol_ok)) acciones.push(['sol', '🛡️ Sol · Seguridad', 1]);
      if (!Number(fila.ui_ok)) acciones.push(['ui', '🎨 Astra · UI', 1]);
      break;
    }
    case 'revision':
      acciones = [['aprobar', '⚖️ Approver', 1]];
      break;
    case 'aprobacion': {
      // Regla del dueño: GRANDE → el PR es la salida recomendada (apruebo yo);
      // sin tamaño clasificado (plantilla / escala) → menú completo como siempre.
      if (String(fila.tamano ?? '') === 'GRANDE') {
        acciones = [['pr', '🔀 Aprobar PR (apruebo yo)', 3], ['main', '⚡ Main directo', 1]];
      } else {
        acciones = [['main', '⚡ Main directo', 3], ['pr', '🔀 Vía PR', 1]];
      }
      if (Number(fila.vueltas) < 2) acciones.push(['reintento', '🔁 Volver al Builder', 2]);
      acciones.push(['cerrar', '✖️ Cerrar', 4]);
      break;
    }
    default:
      acciones = [];
  }
  if (!acciones.length) return undefined;
  acciones.push(['cancelar', '🗑️ Cancelar', 4]);
  const filas = [];
  for (let i = 0; i < acciones.length; i += 5) {
    filas.push(filaBotones(...acciones.slice(i, i + 5).map(([a, l, s]) => boton(a, id, l, s))));
  }
  return filas;
}

function recorridoDe(fila) {
  const hecho = (ok) => (ok ? '✅' : '⏳');
  const partes = [
    `✍️ Espec ${hecho(String(fila.etapa) !== 'entrada')}`,
    `🏗️ Builder ${hecho(Number(fila.vueltas) >= 1)} (vuelta ${Math.max(1, Number(fila.vueltas) || 1)})`,
    `🛡️ Sol ${hecho(Number(fila.sol_ok) === 1)}`,
    `🎨 Astra ${hecho(Number(fila.ui_ok) === 1)}`,
    `⚖️ Approver ${hecho(String(fila.etapa) === 'aprobacion' || fila.veredicto)}`,
    fila.tamano ? `📏 ${String(fila.tamano).toLowerCase()}` : null,
    `👤 Humano ${fila.decision_humano ? `→ ${String(fila.decision_humano).replace('_', ' ')}` : ''}`,
  ].filter(Boolean);
  return partes.join(' → ');
}

function estadoEmbed(fila) {
  const e = embedBase(`🏭 Fábrica VANTS · corrida #${fila.id}`, null);
  e.fields = [
    { name: '💡 Idea', value: txt(fila.idea, 300) },
    { name: '📍 Recorrido', value: recorridoDe(fila) },
    {
      name: '⚙️ Estado',
      value:
        `Etapa: **${ETIQUETA_ETAPA[fila.etapa] ?? fila.etapa}** · Estado: **${fila.estado}**`
        + (fila.tamano ? ` · Tamaño: **${String(fila.tamano) === 'GRANDE' ? 'GRANDE → 🔀 PR' : 'PEQUEÑO → ⚡ main directo'}**` : '')
        + (fila.veredicto ? ` · Veredicto: **${fila.veredicto}**` : '')
        + (fila.decision_humano ? ` · Decisión: **${String(fila.decision_humano).replace('_', ' ')}**` : ''),
    },
  ];
  e.footer = { text: `Creada ${txt(fila.creado_en, 16).replace('T', ' ')} UTC · Fábrica de software VANTS` };
  return e;
}

function embedEtapa(fila, etapa, resultado) {
  const cfg = ETAPAS[etapa];
  let descripcion = String(resultado.contenido).slice(0, 3800);
  if (resultado.aviso) descripcion += `\n\n_Nota: ${txt(resultado.aviso, 200)}_`;
  const e = {
    title: `🏭 #${fila.id} · ${cfg.titulo}`,
    description: descripcion,
    color: cfg.color,
  };
  if (etapa === 'espec') e.fields = [{ name: '💡 Idea original', value: txt(fila.idea, 250) }];
  const modoTxt = resultado.modo === 'plantilla' ? 'modo plantillas' : resultado.modo;
  e.footer = {
    text: `Fábrica VANTS · ${modoTxt}${resultado.modelo ? ` · ${resultado.modelo}` : ''} · corrida #${fila.id}`,
  };
  return e;
}

// ── Motor: ejecuta UNA etapa (con cerebro) ───────────────────────────────────
async function contextoDe(env, fila) {
  const [espec, build, sol, ui, rechazo] = await Promise.all([
    pasoDe(env, fila.id, 'espec'),
    pasoDe(env, fila.id, 'build'),
    pasoDe(env, fila.id, 'sol'),
    pasoDe(env, fila.id, 'ui'),
    Number(fila.vueltas) > 0 ? pasoDe(env, fila.id, 'aprobacion') : Promise.resolve(''),
  ]);
  return {
    idea: txt(fila.idea, 700),
    espec: txt(espec, 1600) || '(no hay spec guardada)',
    build: txt(build, 2000) || '(no hay plan guardado)',
    sol: txt(sol, 900) || '(sin revisión de seguridad)',
    ui: txt(ui, 900) || '(sin revisión de UI)',
    rechazo: txt(rechazo, 900),
  };
}

async function ejecutarEtapa(env, fila, etapa) {
  let reclamo;
  try {
    reclamo = await dbRun(env, GUARDA[etapa], [ahoraISO(), fila.id]);
  } catch (e) {
    return { content: `❌ No pude actualizar la corrida en D1: ${txt(e, 140)}` };
  }
  if (!reclamo?.meta?.changes) {
    return { content: `⏳ La corrida #${fila.id} ya avanzó de **${ETAPAS[etapa].titulo}** (alguien pulsó primero).` };
  }

  let maquina = aplicarEtapa(fila, etapa);
  let resultado;
  try {
    const contexto = await contextoDe(env, fila);
    resultado = await pensar(env, etapa, contexto);
  } catch (e) {
    resultado = {
      modo: 'plantilla',
      modelo: null,
      contenido: ETAPAS[etapa].plantilla({ idea: fila.idea }),
      aviso: `fallo del cerebro: ${txt(e, 120)}`,
    };
  }

  try {
    await dbRun(
      env,
      'INSERT INTO fabrica_pasos (corrida_id, etapa, modo, modelo, contenido, creado_en) VALUES (?, ?, ?, ?, ?, ?)',
      [fila.id, etapa, resultado.modo, resultado.modelo ?? null, String(resultado.contenido).slice(0, 8000), ahoraISO()],
    );
  } catch {
    /* el paso no bloquea la máquina */
  }

  // El Approver decide con la REGLA DEL DUEÑO:
  //   RECHAZADO + vueltas<2 → bucle rojo al Builder; tras 2 vueltas escala al humano.
  //   APROBADO + PEQUEÑO    → ⚡ main directo automático ("directamente se sube").
  //   APROBADO + GRANDE     → 🔀 queda en la puerta: el dueño aprueba por PR.
  //   Sin veredicto (plantilla) → puerta humana con el menú completo (seguro).
  if (etapa === 'aprobacion') {
    const v = veredictoDe(resultado.contenido);
    const tam = tamanoDe(resultado.contenido);
    if (v === 'RECHAZADO' && Number(fila.vueltas) < 2) {
      try {
        await dbRun(
          env,
          "UPDATE fabrica_corridas SET etapa = 'build', vueltas = vueltas + 1, sol_ok = 0, ui_ok = 0, veredicto = 'RECHAZADO', actualizado_en = ? "
          + "WHERE id = ? AND etapa = 'aprobacion' AND veredicto IS NULL",
          [ahoraISO(), fila.id],
        );
        maquina = { ...maquina, etapa: 'build', vueltas: Number(fila.vueltas) + 1, sol_ok: 0, ui_ok: 0, veredicto: 'RECHAZADO' };
      } catch {
        maquina = { ...maquina, veredicto: 'RECHAZADO' };
      }
    } else if (v === 'APROBADO' && tam === 'PEQUENO') {
      // ⚡ "Si no, directamente se sube": cierre automático en UNA escritura atómica
      // (veredicto + tamaño + decisión + estado) — sin puerta humana.
      try {
        await dbRun(
          env,
          "UPDATE fabrica_corridas SET veredicto = 'APROBADO', tamano = 'PEQUENO', decision_humano = 'main_directo', estado = 'hecha', actualizado_en = ? "
          + "WHERE id = ? AND etapa = 'aprobacion' AND veredicto IS NULL",
          [ahoraISO(), fila.id],
        );
        maquina = { ...maquina, veredicto: 'APROBADO', tamano: 'PEQUENO', decision_humano: 'main_directo', estado: 'hecha' };
      } catch {
        maquina = { ...maquina, veredicto: 'APROBADO', tamano: 'PEQUENO' };
      }
    } else if (v) {
      // APROBADO+GRANDE (o RECHAZADO escalado): registra veredicto+tamaño y espera al humano
      try {
        await dbRun(
          env,
          "UPDATE fabrica_corridas SET veredicto = ?, tamano = ?, actualizado_en = ? WHERE id = ? AND etapa = 'aprobacion' AND veredicto IS NULL",
          [v, tam, ahoraISO(), fila.id],
        );
      } catch {
        /* display only */
      }
      maquina = { ...maquina, veredicto: v, ...(tam ? { tamano: tam } : {}) };
    }
  }

  const e = embedEtapa(maquina, etapa, resultado);
  if (etapa === 'aprobacion') {
    if (maquina.etapa === 'build') {
      e.title = `🏭 #${fila.id} · ⚖️ Approver → 🔁 bucle rojo`;
      e.color = 0xe67e22;
    } else if (maquina.estado === 'hecha' && maquina.decision_humano === 'main_directo') {
      // regla del dueño: pequeño → directamente se sube (sin molestar a nadie)
      e.title = `🏭 #${fila.id} · ⚡ Directo a main (pequeño)`;
      e.color = 0x57f287;
      e.description = `${e.description}\n\n**Regla del dueño:** cambio PEQUEÑO → merge directo a \`main\` automático (el merge ES el despliegue).`;
    } else {
      e.title = `🏭 #${fila.id} · ⚖️ Approver${maquina.veredicto ? ` · ${maquina.veredicto}` : ''}${maquina.tamano ? ` · ${maquina.tamano === 'GRANDE' ? '🔀 vía PR' : '⚡ pequeño'}` : ''}`;
      e.color = maquina.veredicto === 'APROBADO' ? 0x57f287 : maquina.veredicto === 'RECHAZADO' ? 0xed4245 : 0x5865f2;
      if (maquina.tamano === 'GRANDE') {
        e.description = `${e.description}\n\n**Regla del dueño:** cambio GRANDE → 🔀 **Pull Request y lo aprueba el dueño** (nadie pushea a main directo).`;
      }
    }
  }
  const salida = { embeds: [e] };
  const botones = botonesParaEtapa(maquina);
  if (botones) salida.components = botones;
  return salida;
}

// ── Acciones sin cerebro (rápidas) ───────────────────────────────────────────
async function ejecutarAccion(env, fila, accion) {
  if (accion === 'cancelar') {
    const r = await dbRun(
      env,
      "UPDATE fabrica_corridas SET estado = 'cancelada', actualizado_en = ? WHERE id = ? AND estado = 'activa'",
      [ahoraISO(), fila.id],
    );
    if (!r?.meta?.changes) return { content: `⏳ La corrida #${fila.id} ya no está activa.` };
    const e = embedBase(
      `🗑️ Corrida #${fila.id} cancelada`,
      'La fábrica deja esta corrida cerrada. La idea queda en el historial (`/fabrica lista`).',
    );
    e.color = 0x99aab5;
    return { embeds: [e] };
  }

  if (accion === 'reintento') {
    const r = await dbRun(
      env,
      "UPDATE fabrica_corridas SET etapa = 'build', vueltas = vueltas + 1, sol_ok = 0, ui_ok = 0, veredicto = 'RECHAZADO', actualizado_en = ? "
      + "WHERE id = ? AND etapa = 'aprobacion' AND estado = 'activa' AND vueltas < 2",
      [ahoraISO(), fila.id],
    );
    if (!r?.meta?.changes) {
      return { content: `⏳ No pude devolver la corrida #${fila.id} al Builder (ya hizo 2 vueltas o cambió de estado).` };
    }
    const maquina = { ...fila, etapa: 'build', vueltas: Number(fila.vueltas) + 1, sol_ok: 0, ui_ok: 0, veredicto: 'RECHAZADO' };
    const e = embedBase(
      `🔁 Corrida #${fila.id} · bucle rojo`,
      `El humano devolvió el trabajo al **Builder** (vuelta **${maquina.vueltas}**). `
        + 'Las razones del rechazo quedaron en el paso del Approver, más arriba en el canal.',
    );
    e.color = 0xe67e22;
    return { embeds: [e], components: botonesParaEtapa(maquina) };
  }

  if (accion === 'main' || accion === 'pr' || accion === 'cerrar') {
    const decision = accion === 'main' ? 'main_directo' : accion === 'pr' ? 'via_pr' : 'cerrada';
    const r = await dbRun(
      env,
      "UPDATE fabrica_corridas SET decision_humano = ?, estado = 'hecha', actualizado_en = ? "
      + "WHERE id = ? AND etapa = 'aprobacion' AND estado = 'activa'",
      [decision, ahoraISO(), fila.id],
    );
    if (!r?.meta?.changes) return { content: `⏳ La corrida #${fila.id} ya se cerró antes.` };
    const textos = {
      main_directo: [
        '⚡ Main directo',
        'Decisión registrada: merge directo a `main` (solo para cambios triviales, regla 1 de la fábrica). '
          + 'Recordá que el merge ES el despliegue.',
      ],
      via_pr: [
        '🔀 PR aprobado (apruebo yo)',
        'Decisión registrada: el dueño aprueba el cambio GRANDE vía **Pull Request** — abre el PR con el plan del Builder '
          + 'y mergéalo cuando lo hayas revisado. Nadie pushea a main directamente.',
      ],
      cerrada: ['✖️ Corrida cerrada', 'Cerrada sin merge. El historial queda en `/fabrica lista` y en los pasos de este canal.'],
    };
    const [titulo, texto] = textos[decision];
    const maquina = { ...fila, decision_humano: decision, estado: 'hecha' };
    const e = embedBase(`🏭 #${fila.id} · ${titulo}`, `${texto}\n\n${recorridoDe(maquina)}`);
    return { embeds: [e] };
  }

  // espec · build · sol · ui · aprobar → etapas con cerebro
  return ejecutarEtapa(env, fila, accion);
}

// ── Botones (interaction type 3, custom_id "fabrica:<accion>:<id>") ─────────
const ACCIONES = ['espec', 'build', 'sol', 'ui', 'aprobar', 'main', 'pr', 'cerrar', 'reintento', 'cancelar', 'ver'];

const ETIQUETA_TRABAJO = {
  espec: '⏳ ✍️ Spec writer escribiendo…',
  build: '⏳ 🏗️ Builder construyendo…',
  sol: '⏳ 🛡️ Sol auditando seguridad…',
  ui: '⏳ 🎨 Astra revisando la UI…',
  aprobar: '⏳ ⚖️ Approver deliberando…',
};

function etiquetaTrabajo(accion, id) {
  return (
    ETIQUETA_TRABAJO[accion]
    ?? (accion === 'reintento'
      ? '🔁 Devolviendo al Builder…'
      : accion === 'cancelar'
        ? '🗑️ Cancelando la corrida…'
        : `⚡ Registrando la decisión de la corrida #${id}…`)
  );
}

// Devuelve { tipo: 4, data } (respuesta inmediata efímera) o
// { tipo: 6, etiqueta, trabajo } (ack + trabajo frío que el router publica).
export async function fabricaBoton(env, body) {
  const custom = String(body?.data?.custom_id ?? '');
  const partes = custom.split(':');
  const accion = String(partes[1] ?? '');
  const id = Number(partes[2] ?? 0);
  const userId = String(body?.member?.user?.id ?? body?.user?.id ?? '');
  const esStaffOk = await esStaff(env, body, PERM.MANAGE_GUILD);

  if (!ACCIONES.includes(accion) || !Number.isInteger(id) || id < 1) {
    return { tipo: 4, data: { flags: 64, content: '🤔 Botón de fábrica no reconocido (¿mensaje de una versión anterior?).' } };
  }

  let fila = null;
  try {
    fila = await corridaDe(env, id);
  } catch {
    fila = null;
  }
  if (!fila) return { tipo: 4, data: { flags: 64, content: `❌ No encontré la corrida #${id}.` } };

  if (accion === 'ver') {
    return { tipo: 4, data: { flags: 64, embeds: [estadoEmbed(fila)] } };
  }

  const esDueno = String(fila.autor_id) === userId;
  if (!esDueno && !esStaffOk) {
    return { tipo: 4, data: { flags: 64, content: '🚫 Solo quien abrió la corrida o el staff puede mover la fábrica.' } };
  }
  if (String(fila.estado) !== 'activa') {
    return { tipo: 4, data: { flags: 64, content: `⛔ La corrida #${id} ya está **${fila.estado}**; no se puede mover.` } };
  }

  return { tipo: 6, etiqueta: etiquetaTrabajo(accion, id), trabajo: () => ejecutarAccion(env, fila, accion) };
}

// ── /fabrica (nueva · estado · lista · cancelar) ─────────────────────────────
async function fabricaNueva(env, body, idea, userId) {
  if (!idea) {
    return { flags: 64, content: '❌ Describe la idea: `/fabrica nueva idea:añadir búsqueda de jugadores en la web`' };
  }

  // límites: protegen el free tier y la cuota de IA
  try {
    const mias = Number((await dbFirst(env, "SELECT count(*) AS n FROM fabrica_corridas WHERE estado = 'activa' AND autor_id = ?", [userId]))?.n ?? 0);
    if (mias >= 2) return { flags: 64, content: '⏳ Ya tienes 2 corridas activas. Cierra una antes de abrir otra.' };
    const activas = Number((await dbFirst(env, "SELECT count(*) AS n FROM fabrica_corridas WHERE estado = 'activa'"))?.n ?? 0);
    if (activas >= 10) return { flags: 64, content: '⏳ La fábrica llegó a su tope de 10 corridas activas (protección de cuota). Cierra alguna primero.' };
  } catch {
    /* sin límites si D1 no responde al conteo */
  }

  const ahora = ahoraISO();
  const guildId = String(body?.guild_id ?? '');
  const canalId = String(body?.channel_id ?? '');
  let filaId = 0;
  try {
    const r = await dbRun(
      env,
      'INSERT INTO fabrica_corridas (guild_id, canal_id, autor_id, idea, etapa, vueltas, sol_ok, ui_ok, veredicto, decision_humano, estado, creado_en, actualizado_en) '
      + 'VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, ?, ?, ?)',
      [guildId, canalId, userId, idea, 'entrada', 'activa', ahora, ahora],
    );
    filaId = Number(r?.meta?.last_row_id ?? 0);
  } catch (e) {
    return {
      flags: 64,
      content: `❌ No pude crear la corrida en D1: ${txt(e, 140)}\n¿Aplicaste la migración \`migraciones/01-fabrica.sql\`?`,
    };
  }
  if (!filaId) return { flags: 64, content: '❌ No pude crear la corrida (sin id). Prueba otra vez.' };

  const fila = {
    id: filaId,
    guild_id: guildId,
    canal_id: canalId,
    autor_id: userId,
    idea,
    etapa: 'entrada',
    vueltas: 0,
    sol_ok: 0,
    ui_ok: 0,
    veredicto: null,
    decision_humano: null,
    estado: 'activa',
    creado_en: ahora,
    actualizado_en: ahora,
  };
  return ejecutarEtapa(env, fila, 'espec');
}

async function fabricaEstado(env, id, userId, esStaff) {
  let fila = null;
  try {
    fila = await corridaDe(env, id);
  } catch {
    fila = null;
  }
  if (!fila) return { flags: 64, content: `❌ No encontré la corrida #${id}. Mira los números en \`/fabrica lista\`.` };
  const salida = { flags: 64, embeds: [estadoEmbed(fila)] };
  if ((esStaff || String(fila.autor_id) === userId) && String(fila.estado) === 'activa') {
    const botones = botonesParaEtapa(fila);
    if (botones) salida.components = botones;
  }
  return salida;
}

async function fabricaCancelar(env, id, userId, esStaff) {
  let fila = null;
  try {
    fila = await corridaDe(env, id);
  } catch {
    fila = null;
  }
  if (!fila) return { flags: 64, content: `❌ No encontré la corrida #${id}.` };
  if (String(fila.autor_id) !== userId && !esStaff) {
    return { flags: 64, content: '🚫 Solo quien abrió la corrida o el staff puede cancelarla.' };
  }
  if (String(fila.estado) !== 'activa') return { flags: 64, content: `⛔ La corrida #${id} ya está **${fila.estado}**.` };
  try {
    await dbRun(env, "UPDATE fabrica_corridas SET estado = 'cancelada', actualizado_en = ? WHERE id = ?", [ahoraISO(), id]);
  } catch (e) {
    return { flags: 64, content: `❌ No pude cancelar: ${txt(e, 140)}` };
  }
  const e = embedBase(`🗑️ Corrida #${id} cancelada`, txt(fila.idea, 200));
  e.color = 0x99aab5;
  return { flags: 64, embeds: [e] };
}

async function fabricaLista(env, userId, esStaff) {
  let filas = [];
  try {
    filas = esStaff
      ? await dbAll(env, 'SELECT * FROM fabrica_corridas ORDER BY id DESC LIMIT 10')
      : await dbAll(env, 'SELECT * FROM fabrica_corridas WHERE autor_id = ? ORDER BY id DESC LIMIT 10', [userId]);
  } catch (e) {
    return { flags: 64, content: `❌ No pude leer la fábrica: ${txt(e, 140)}\n¿Aplicaste la migración \`migraciones/01-fabrica.sql\`?` };
  }
  if (!filas.length) {
    return { flags: 64, content: '🏭 No hay corridas todavía. Arranca una con `/fabrica nueva idea:...` (staff).' };
  }
  const e = embedBase('🏭 Fábrica VANTS · corridas recientes', null);
  e.description = filas
    .map((f) =>
      `**#${f.id}** · ${ETIQUETA_ETAPA[f.etapa] ?? f.etapa} · ${f.estado}`
      + `${Number(f.vueltas) > 1 ? ` · ${f.vueltas} vueltas` : ''}`
      + `${f.veredicto ? ` · ${f.veredicto}` : ''}\n› ${txt(f.idea, 80)}`)
    .join('\n');
  e.footer = { text: 'Spec → Builder → Sol + Astra → Approver → Humano' };
  return { flags: 64, embeds: [e] };
}

export async function fabricaComando(env, body) {
  const sub = String((body?.data?.options ?? [])[0]?.name ?? 'lista');
  const subOpts = (body?.data?.options ?? [])[0]?.options ?? [];
  const opt = (n) => subOpts.find((o) => o.name === n)?.value;
  const userId = String(body?.member?.user?.id ?? body?.user?.id ?? '');
  const esStaffOk = await esStaff(env, body, PERM.MANAGE_GUILD);

  if (sub === 'nueva') return fabricaNueva(env, body, String(opt('idea') ?? '').trim(), userId);
  if (sub === 'estado') return fabricaEstado(env, Number(opt('id') ?? 0), userId, esStaffOk);
  if (sub === 'cancelar') return fabricaCancelar(env, Number(opt('id') ?? 0), userId, esStaffOk);
  return fabricaLista(env, userId, esStaffOk);
}

// Gancho para tests (la máquina sin pasarela HTTP)
export const _fab = { ejecutarEtapa, pensar, botonesParaEtapa, veredictoDe, tamanoDe, estadoEmbed, proveedoresDe };
