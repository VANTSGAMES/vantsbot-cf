// ============================================
// vantsbot — cerebro.js : cliente Anthropic (Claude) compartido.
// Lo usan el comando /ia (respaldo de OpenAI) y la fábrica /fabrica
// (roles Opus/Sonnet del diagrama). Un solo cliente, dos consumidores.
//
// Región: Anthropic NO bloquea por IP de origen como OpenAI, pero la clave
// del dueño validó 403 por región desde el sandbox → en producción las
// interacciones salen por EE.UU. (colo de Cloudflare) y ahí funcionó.
// ============================================

const URL_ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 45000; // igual que OpenAI: los modelos piensan; el followup tolera

export async function chatAnthropic(key, modelo, sistema, usuario, maxTokens = 1600) {
  if (!key) return { status: 401, data: { error: { code: 'no_key', message: 'falta ANTHROPIC_API_KEY' } } };
  const r = await fetch(URL_ANTHROPIC, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': String(key),
      'anthropic-version': '2023-06-01',
      'User-Agent': 'VANTS-Bot (https://vants.cc, 1.0)',
    },
    body: JSON.stringify({
      model: modelo,
      max_tokens: maxTokens,
      system: sistema,
      messages: [{ role: 'user', content: String(usuario).slice(0, 6000) }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
}

// Une los bloques de texto de la respuesta Anthropic en un solo string.
export const textoAnthropic = (data) =>
  (data?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n')
    .trim();
