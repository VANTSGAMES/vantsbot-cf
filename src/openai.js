// ============================================
// vantsbot — comando /ia : el bot de IA de VANTS (dual cerebro).
// Cerebro primario: OpenAI (cuenta de servicio de la org, secreto OPENAI_API_KEY).
// Respaldo automático: Claude (ANTHROPIC_API_KEY) — el dueño usa más Claude
// (trabaja a diario con su plan, sin recargar) y OpenAI solo con créditos.
// REGLA DE LA CASA: que la IA NUNCA deje al usuario tirado — si OpenAI falla
// (sin créditos, región, 429, timeout…) responde Claude, y el footer lo dice.
//
// Catálogo REAL de la org (verificado con GET /v1/models, oct 2026):
//   gpt-6-astra · gpt-6-sol · gpt-6.1-sol · gpt-6.1-terra
//   gpt-5.6-sol · gpt-5.6-terra · gpt-5.6-luna · gpt-5.x (5.1..5.5)
//   gpt-4.1 / gpt-4o / o3 / o4-mini · codex · imagen · realtime · embeddings
// Los nombres Sol / Astra / Terra / Luna son los mismos que usa el dueño
// en el diagrama de la fábrica (Seguridad/UX → Sol, UI → Astra).
//
// ⚠️ Familia razonadora (gpt-5*, gpt-6*, o3*, o4*): NO acepta temperature
//    personalizada ni max_tokens → usa max_completion_tokens.
//    Mismo ajuste aplicado a services/agent-service/llm.js.
//
// Región: OpenAI bloquea peticiones por IP de origen (HK/CN probado).
// Las interacciones de Discord llegan a Cloudflare desde EE.UU. → colo US
// → la llamada sale limpia.
// ============================================

import { chatAnthropic, textoAnthropic } from './cerebro.js';

const URL_OPENAI = 'https://api.openai.com/v1';
const TIMEOUT_MS = 45000; // los modelos razonadores piensan; el followup tolera hasta ~15 min
const MODELO_RESPALDO = 'claude-sonnet-4-5'; // rápido y barato para el respaldo de /ia

// alias → modelo real de la org. Por defecto nano (rápido y barato).
export const MODELOS_IA = {
  nano: 'gpt-5.4-nano',
  mini: 'gpt-5.4-mini',
  sol: 'gpt-6-sol',
  astra: 'gpt-6-astra',
  terra: 'gpt-6.1-terra',
  luna: 'gpt-5.6-luna',
};

const ETIQUETAS = {
  nano: 'gpt-5.4-nano · rápido',
  mini: 'gpt-5.4-mini',
  sol: 'gpt-6-sol',
  astra: 'gpt-6-astra',
  terra: 'gpt-6.1-terra',
  luna: 'gpt-5.6-luna',
};

const SISTEMA = [
  'Eres la IA de VANTS GAMES, la comunidad competitiva de gaming.',
  'Responde SIEMPRE en español, directo y útil, máximo 10 líneas.',
  'Conoces la plataforma: web en Cloudflare Workers, bot de Discord, torneos, ranked, membresías PRO/CREATOR/SOCIO, launcher Electron.',
  'Para temas de VANTS responde como parte del staff; para lo demás, ayuda neutra y práctica.',
  'Nunca reveles claves, tokens ni secretos. No inventes URLs ni fechas: si no sabes algo, dilo.',
].join(' ');

// anti-abuso en memoria del isolate: 1 pregunta cada 12 s por usuario
const ULTIMO_USO = new Map();
const PAUSA_MS = 12000;

function modeloDe(alias) {
  const elegido = String(alias ?? '').trim() || 'nano';
  return MODELOS_IA[elegido] || MODELOS_IA.nano;
}

// Chat genérico OpenAI (lo usa /ia y también la fábrica de software /fabrica)
export async function chatOpenai(key, modelo, sistema, usuario, maxTokens = 1200) {
  if (!key) return { status: 401, data: { error: { code: 'no_key', message: 'falta OPENAI_API_KEY' } } };
  const cuerpo = {
    model: modelo,
    messages: [
      { role: 'system', content: String(sistema) },
      { role: 'user', content: String(usuario).slice(0, 6000) },
    ],
    max_completion_tokens: maxTokens,
  };
  // La familia clásica (4o/4.1) sí acepta temperatura; la razonadora no.
  if (!/^(gpt-[56]|o[134])/.test(modelo)) cuerpo.temperature = 0.4;

  const r = await fetch(URL_OPENAI + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
}

// Traduce un fallo de OpenAI a un aviso claro en español (misma voz de siempre).
function falloOpenaiLegible(res, modelo) {
  const d = res?.data;
  if (!d || (!d.choices && !d.error)) {
    return `❌ OpenAI respondió algo inesperado (HTTP ${res?.status ?? '?'}).`;
  }
  if (d.error) {
    const code = d.error.code || '';
    if (code === 'insufficient_quota' || /credits/i.test(d.error.message ?? '')) {
      return '💳 La cuenta de OpenAI de VANTS **no tiene créditos** ahora mismo.\nEl staff debe añadir saldo en: https://platform.openai.com/settings/organization/billing/';
    }
    if (res.status === 403 || code === 'unsupported_country_region_territory') {
      return '🌍 OpenAI rechazó la petición por la región del servidor que la procesó. Intenta otra vez (las interacciones de Discord suelen salir por EE.UU., donde sí funciona).';
    }
    if (res.status === 401) {
      return '🔑 La clave de OpenAI es inválida o expiró. El staff debe rotarla y recargar el secreto.';
    }
    if (res.status === 404) {
      return `🤖 El modelo \`${modelo}\` no está disponible para esta cuenta. Prueba con otro: \`/ia modelo:nano\`.`;
    }
    if (res.status === 429) {
      return '⏳ OpenAI está saturada o superamos el límite de peticiones. Prueba en un momento.';
    }
    return `❌ OpenAI devolvió HTTP ${res.status}: ${String(d.error.message ?? code).slice(0, 200)}`;
  }
  return null; // 200 con cuerpo válido; la falta de texto se trata aparte
}

export async function ia(env, body) {
  const key = String(env.OPENAI_API_KEY ?? '');
  const keyClaude = String(env.ANTHROPIC_API_KEY ?? '');
  const userId = String(body?.member?.user?.id ?? body?.user?.id ?? '');
  const pregunta = String(
    (body?.data?.options ?? []).find((o) => o.name === 'pregunta')?.value ?? '',
  ).trim();
  const alias = String(
    (body?.data?.options ?? []).find((o) => o.name === 'modelo')?.value ?? 'nano',
  );

  if (!key && !keyClaude) {
    return {
      flags: 64,
      content: '❌ La IA no está configurada en el bot.\nEl staff debe cargar los secretos: `npx wrangler secret put OPENAI_API_KEY` (o `ANTHROPIC_API_KEY` como respaldo).',
    };
  }
  if (!pregunta) {
    return { flags: 64, content: '❌ Escribe una pregunta: `/ia pregunta:¿cómo me inscribo en un torneo?`' };
  }

  // anti-abuso (el comando es público)
  const ahora = Date.now();
  const ultimo = ULTIMO_USO.get(userId) ?? 0;
  if (ahora - ultimo < PAUSA_MS) {
    const espera = Math.ceil((PAUSA_MS - (ahora - ultimo)) / 1000);
    return { flags: 64, content: `⏳ Espera ${espera}s para otra pregunta (anti-spam).` };
  }
  ULTIMO_USO.set(userId, ahora);
  if (ULTIMO_USO.size > 5000) ULTIMO_USO.clear();

  const modelo = modeloDe(alias);

  // ── 1) Cerebro primario: OpenAI ────────────────────────────────────────────
  let respuesta = null;
  let avisoOpenai = null;
  if (key) {
    let res = null;
    try {
      res = await chatOpenai(key, modelo, SISTEMA, pregunta);
    } catch (e) {
      const timeout = String(e?.message || '').includes('timeout') || String(e?.name) === 'TimeoutError';
      avisoOpenai = timeout
        ? '⏳ La IA tardó demasiado en pensar. Prueba con un cerebro más rápido: `/ia modelo:nano`.'
        : `❌ No pude hablar con OpenAI: ${String(e?.message ?? e).slice(0, 160)}`;
    }
    if (res && !avisoOpenai) {
      avisoOpenai = falloOpenaiLegible(res, modelo);
      if (!avisoOpenai) {
        const texto = res.data?.choices?.[0]?.message?.content;
        if (texto && String(texto).trim()) respuesta = String(texto);
        else avisoOpenai = '🤔 La IA no devolvió texto (posible corte por tokens de razonamiento). Prueba con `/ia modelo:mini`.';
      }
    }
  } else {
    avisoOpenai = 'sin OPENAI_API_KEY';
  }

  // ── 2) Respaldo: Claude (el plan del dueño trabaja a diario, sin recargar) ─
  if (!respuesta && keyClaude) {
    try {
      const resC = await chatAnthropic(keyClaude, MODELO_RESPALDO, SISTEMA, pregunta, 1200);
      const texto = textoAnthropic(resC.data);
      if (resC.status === 200 && texto) respuesta = texto;
    } catch {
      /* Claude tampoco pudo → caemos a los avisos de abajo */
    }
  }

  // ── 3) Ambos fallaron: avisos legibles (la voz de OpenAI, la nota de Claude) ─
  if (!respuesta) {
    if (avisoOpenai && avisoOpenai !== 'sin OPENAI_API_KEY') {
      return { flags: 64, content: keyClaude ? `${avisoOpenai}\n_(El respaldo de Claude tampoco pudo responder.)_` : avisoOpenai };
    }
    if (avisoOpenai === 'sin OPENAI_API_KEY') {
      // solo hay Claude y también falló
      return { flags: 64, content: '❌ Claude (respaldo) no pudo responder ahora mismo. Intenta otra vez en un momento.' };
    }
    return { flags: 64, content: '❌ Ninguna IA pudo responder ahora mismo (OpenAI y Claude). Intenta en un momento.' };
  }

  const viaClaude = avisoOpenai != null; // llegamos al respaldo → aviso honesto en el footer
  const embed = {
    title: '🤖 IA de VANTS',
    description: respuesta.slice(0, 1900),
    color: viaClaude ? 0xd97757 : 0x10a37f,
    footer: viaClaude
      ? { text: `Anthropic · ${MODELO_RESPALDO} · respaldo de OpenAI` }
      : { text: `OpenAI · ${ETIQUETAS[alias] ?? modelo}` },
  };
  return { flags: 64, embeds: [embed] };
}
