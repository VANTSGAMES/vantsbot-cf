#!/usr/bin/env node
/* VANTS · monitor portable — objetivo rsc-harness: detectar errores y avisar.
   Checks críticos definidos por repo; exit 1 si alguno falla (el workflow abre/actualiza incidente). */
const CHECKS = [
  {
    "id": "web",
    "label": "Web VANTS (vants.cc)",
    "url": "https://vants.cc/api/gpr",
    "markers": [
      "\"ok\":true"
    ]
  },
  {
    "id": "int",
    "label": "VANTS Integraciones (int.vants.cc)",
    "url": "https://int.vants.cc/salud",
    "markers": [
      "\"ok\":true"
    ]
  },
  {
    "id": "bot",
    "label": "Bot Discord (bot.vants.cc)",
    "url": "https://bot.vants.cc/salud",
    "markers": [
      "\"ok\":true"
    ]
  },
  {
    "id": "bus",
    "label": "VANTS-BUS (bus.vants.cc)",
    "url": "https://bus.vants.cc/health",
    "markers": [
      "\"ok\":true"
    ]
  }
];
const TIMEOUT = 15000;

async function httpCheck(c) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT);
    const r = await fetch(c.url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VANTS-Monitor/1.0; +https://vants.cc)' },
    });
    clearTimeout(t);
    const ms = Date.now() - t0;
    const body = (await r.text().catch(() => '')).slice(0, 20000);
    const statusOk = c.expect === 'any' ? r.status < 500 : (r.status >= 200 && r.status < 400);
    const faltan = (c.markers || []).filter((m) => !body.includes(m));
    const ok = statusOk && faltan.length === 0;
    return { ok, status: r.status, ms, detalle: ok ? '' : faltan.length ? 'faltan marcadores: ' + faltan.join(', ') : 'HTTP ' + r.status };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, detalle: String((e && e.message) || e).slice(0, 120) };
  }
}

async function enviarPagerDuty(action, summary, customDetails = {}) {
  const key = String(process.env.PAGERDUTY_ROUTING_KEY || '').trim();
  if (!key) return;
  try {
    const body = {
      routing_key: key,
      event_action: action,
      dedup_key: 'vants-ecosystem-monitor',
      ...(action === 'trigger'
        ? {
            payload: {
              summary: String(summary).slice(0, 1024),
              source: 'VANTS Cloudflare Monitor (vants.cc / int / bot / bus)',
              severity: 'critical',
              custom_details: customDetails,
            },
          }
        : {}),
    };
    const r = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log(`[PagerDuty] ${action} -> HTTP ${r.status}`);
  } catch (e) {
    console.error('[PagerDuty] error al enviar evento:', String(e?.message || e));
  }
}

(async () => {
  const fallos = [];
  const resultados = {};
  for (const c of CHECKS) {
    const r = await httpCheck(c);
    resultados[c.id] = r;
    console.log((r.ok ? 'OK  ' : 'FALLA ') + (c.label || c.id) + '  ' + c.url + '  ->  ' + r.status + '  ' + r.ms + 'ms' + (r.ok ? '' : '  :: ' + r.detalle));
    if (!r.ok) fallos.push((c.label || c.id) + ' (' + (r.detalle || 'HTTP ' + r.status) + ')');
  }
  if (fallos.length) {
    const msg = '[ALERT] DOWN — falla: ' + fallos.join('; ');
    console.error(msg);
    await enviarPagerDuty('trigger', msg, resultados);
    process.exit(1);
  }
  console.log('[OK] todos los checks críticos pasan (' + CHECKS.length + ')');
  await enviarPagerDuty('resolve', 'Todos los servicios VANTS operativos');
})();
