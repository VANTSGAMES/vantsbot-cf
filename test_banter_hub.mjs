import assert from 'node:assert/strict';
import { construir } from './src/index.js';
import { resetBanterHubCacheForTests } from './src/banterHub.js';

function fakeDb() {
  const users = new Map();
  const requests = [];
  const subs = new Map();
  return {
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim();
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async run() {
          if (q.startsWith('CREATE TABLE IF NOT EXISTS')) return { success: true };
          if (q.startsWith('INSERT INTO banter_users')) {
            const [id, handle, email, platform, plan_id, country, notes, created_at, updated_at] = args;
            users.set(email, { id, handle, email, platform, plan_id, country, notes, customization_json: null, created_at, updated_at });
            return { success: true };
          }
          if (q.startsWith('INSERT INTO banter_requests')) {
            const [id, requester, email, request_type, platform, priority, summary, created_at] = args;
            requests.push({ id, requester, email, request_type, platform, priority, status: 'Pendiente', summary, created_at });
            return { success: true };
          }
          if (q.startsWith('INSERT INTO banter_subscriptions')) {
            const [id, email, plan_id, billing_channel, ad_free, price_usd, status, started_at, updated_at] = args;
            subs.set(email, { id, email, plan_id, billing_channel, ad_free, price_usd, status, started_at, updated_at });
            return { success: true };
          }
          if (q.startsWith('UPDATE banter_users SET plan_id')) {
            const [plan_id, updated_at, email] = args;
            if (users.has(email)) Object.assign(users.get(email), { plan_id, updated_at });
            return { success: true };
          }
          return { success: true };
        },
        async first() {
          if (q.startsWith('SELECT COUNT(*) AS n FROM banter_users')) return { n: users.size };
          if (q.startsWith('SELECT COUNT(*) AS n FROM banter_requests')) return { n: requests.length };
          if (q.startsWith("SELECT COUNT(*) AS n FROM banter_subscriptions WHERE status = 'active'")) {
            return { n: [...subs.values()].filter((s) => s.status === 'active').length };
          }
          if (q.startsWith('SELECT id, plan_id, billing_channel, ad_free, status')) {
            const s = subs.get(args[0]);
            return s && s.status === 'active' ? s : null;
          }
          if (q.startsWith('SELECT handle, customization_json FROM banter_users')) {
            return users.get(args[0]) || null;
          }
          return { n: 0 };
        },
        async all() {
          return { results: [] };
        },
      };
      return stmt;
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

resetBanterHubCacheForTests();
const busEvents = [];
const sheetCalls = [];

const fetchMock = async (url, init) => {
  if (String(url).includes('/events')) {
    busEvents.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, id: 'ev-1' }), { status: 200 });
  }
  if (String(url).includes('script.google.com')) {
    sheetCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

const env = {
  DB: fakeDb(),
  VANTS_BOT_SECRET: 's'.repeat(40),
  VANTS_BUS_SECRET: 'bus-secret-test',
  VANTS_BUS_URL: 'https://vants-bus.vants.workers.dev',
  NITROPAY_SITE_ID: '4321',
  BANTER_SHEET_ID: '1i0t2hRSAO4WT7nKlK3rzgsx4oulmrYmpTqIe6CA5ozU',
  BANTER_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/test/exec',
};

const handler = construir({ saltarFirma: true, fetchImpl: fetchMock });

// 1) /ads.txt 301 redirect oficial NitroPay
const adsRes = await handler(new Request('https://vantsbot.vants.workers.dev/ads.txt'), env);
assert.equal(adsRes.status, 301);
assert.equal(adsRes.headers.get('location'), 'https://api.nitropay.com/v1/ads-4321.txt');

// 2) POST /banter/registro -> D1 + Sheet + VANTS-BUS
const regRes = await handler(
  new Request('https://vantsbot.vants.workers.dev/banter/registro', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      handle: 'FEISS',
      email: 'feiss@vants.cc',
      platform: 'desktop-electron',
      planId: 'free',
      country: 'VE',
    }),
  }),
  env,
);
assert.equal(regRes.status, 201);
const regBody = await regRes.json();
assert.equal(regBody.ok, true);
assert.equal(regBody.sheet.synced, true);
assert.equal(busEvents.at(-1).type, 'banter.user_registered');

// 3) POST /banter/solicitud -> D1 + Sheet + VANTS-BUS
const solRes = await handler(
  new Request('https://vantsbot.vants.workers.dev/banter/solicitud', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requester: 'FEISS',
      email: 'feiss@vants.cc',
      requestType: 'Solicitud NitroPay/Ads',
      platform: 'desktop-electron',
      priority: 'Alta',
      summary: 'Activación de NitroPay Electron y redirect 301',
    }),
  }),
  env,
);
assert.equal(solRes.status, 201);
assert.equal(busEvents.at(-1).type, 'banter.request_created');

// 4) GET /banter/nitro antes (free) -> POST /banter/nitro (requiere secreto) -> GET /banter/nitro (adFree: true)
const nBefore = await (await handler(new Request('https://vantsbot.vants.workers.dev/banter/nitro?email=feiss@vants.cc'), env)).json();
assert.equal(nBefore.adFree, false);

const nUnauth = await handler(
  new Request('https://vantsbot.vants.workers.dev/banter/nitro', {
    method: 'POST',
    body: JSON.stringify({ email: 'feiss@vants.cc', planId: 'nitro_plus' }),
  }),
  env,
);
assert.equal(nUnauth.status, 401);

const nAct = await handler(
  new Request('https://vantsbot.vants.workers.dev/banter/nitro', {
    method: 'POST',
    headers: { 'x-vants-bot': env.VANTS_BOT_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'feiss@vants.cc', planId: 'nitro_plus', billingChannel: 'stripe' }),
  }),
  env,
);
assert.equal(nAct.status, 200);
const nAfter = await (await handler(new Request('https://vantsbot.vants.workers.dev/banter/nitro?email=feiss@vants.cc'), env)).json();
assert.equal(nAfter.adFree, true);
assert.equal(nAfter.planId, 'nitro_plus');

// 5) POST /banter/clipper -> publica clip.published al VANTS-BUS
const clipRes = await handler(
  new Request('https://vantsbot.vants.workers.dev/banter/clipper', {
    method: 'POST',
    headers: { 'x-vants-bot': env.VANTS_BOT_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Ace Ascent #shorts', url: 'https://www.youtube.com/shorts/abc123', juego: 'VALORANT' }),
  }),
  env,
);
assert.equal(clipRes.status, 200);
assert.equal(busEvents.at(-1).type, 'clip.published');

// 6) GET /banter/estado refleja conteos reales
const est = await (await handler(new Request('https://vantsbot.vants.workers.dev/banter/estado'), env)).json();
assert.equal(est.usuarios, 1);
assert.equal(est.solicitudes, 1);
assert.equal(est.suscripciones_activas, 1);
assert.equal(sheetCalls.length, 2);

console.log('OK: banterHub (NitroPay /ads.txt 301, D1 usuarios/solicitudes/Nitro, Google Sheets, Clipper y VANTS-BUS)');
