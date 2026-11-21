/**
 * СДПН · Регистратура — сервер «постановки на учёт» (Cloudflare Worker + D1).
 *
 * Что делает:
 *   POST /register        — Mini App присылает initData (подпись Telegram) + назначенный трек.
 *                           Проверяем подпись, сохраняем ID, присылаем подтверждение в чат.
 *   POST /webhook         — апдейты от Telegram: /start, /stop, блокировка бота.
 *   GET  /stats           — сколько пациентов на учёте (для «На учёте: N» в приложении).
 *   GET  /admin/patients  — список для рассылки (только с X-Admin-Key).
 *   POST /admin/forget    — пометить неактивными тех, кто заблокировал бота (X-Admin-Key).
 *   POST /admin/setup     — один раз: подключить вебхук и команды бота (X-Admin-Key).
 *
 * Секреты (задаются командой `npx wrangler secret put ...`, в коде и в GitHub их НЕТ):
 *   BOT_TOKEN       — токен бота из @BotFather
 *   ADMIN_KEY       — любой длинный пароль для админских запросов и скрипта рассылки
 *   WEBHOOK_SECRET  — любая длинная строка (латиница/цифры), Telegram пришлёт её в заголовке
 *
 * Храним минимум: Telegram ID, назначенный трек, код формы, номер карты, дату. Без имён и телефонов.
 */

const TEXT = {
  registered: (p) =>
    `МИНИСТЕРСТВО ЗВУКОВОГО ЗДРАВООХРАНЕНИЯ\n` +
    `Центр музыкальной психотерапии «СДПН»\n\n` +
    `Пациент поставлен на учёт.\n` +
    `Карта № ${p.card} · диагноз ${p.form}.\n\n` +
    `Препарат «СДПН» (ТРОЕТОЧИЕ) проходит последние испытания. ` +
    `В день поступления в аптеки дежурный врач лично пришлёт вам назначение.\n\n` +
    `Снять с учёта: /stop`,
  start:
    `МИНИСТЕРСТВО ЗВУКОВОГО ЗДРАВООХРАНЕНИЯ\n` +
    `Центр музыкальной психотерапии «СДПН»\n\n` +
    `Регистратура открыта. Пациент, пройдите обследование.\n` +
    `Альбом «СДПН» — ТРОЕТОЧИЕ.`,
  startBtn: 'Пройти обследование',
  stop: 'Вы сняты с учёта. Сообщений от дежурного врача больше не будет.\nВернуться: пройдите обследование и снова нажмите «Встать на учёт».',
  other: 'Дежурный врач принимает только через регистратуру.',
};

/* Секреты, вставленные через терминал, иногда приходят с пробелами, переводом строки или BOM — чистим */
const clean = (s) => String(s || '').replace(/[\s﻿]/g, '');

export default {
  async fetch(req, rawEnv) {
    const env = { ...rawEnv, BOT_TOKEN: clean(rawEnv.BOT_TOKEN), ADMIN_KEY: clean(rawEnv.ADMIN_KEY), WEBHOOK_SECRET: clean(rawEnv.WEBHOOK_SECRET), ADMIN_IDS: clean(rawEnv.ADMIN_IDS) };
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === '/register' && req.method === 'POST') return withCors(await register(req, env), cors);
      if (url.pathname === '/stats' && req.method === 'GET') return withCors(await stats(env), cors);
      if (url.pathname === '/status' && req.method === 'POST') return withCors(await status(req, env), cors);
      if (url.pathname === '/teaser' && req.method === 'POST') return withCors(await teaser(req, env), cors);
      if (url.pathname === '/webhook' && req.method === 'POST') return await webhook(req, env);
      if (url.pathname.startsWith('/admin/')) {
        if (req.headers.get('X-Admin-Key') !== env.ADMIN_KEY || !env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
        if (url.pathname === '/admin/patients') return await patients(env);
        if (url.pathname === '/admin/forget' && req.method === 'POST') return await forget(req, env);
        if (url.pathname === '/admin/setup' && req.method === 'POST') return await setup(url, env);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      return withCors(json({ error: 'server' }, 500), cors);
    }
  },
};

/* ---------- Регистрация из Mini App ---------- */
async function register(req, env) {
  const body = JSON.parse(await req.text());
  const data = await verifyInitData(body.initData || '', env.BOT_TOKEN);
  if (!data) return json({ error: 'bad signature' }, 401);
  const user = JSON.parse(data.get('user') || '{}');
  if (!user.id) return json({ error: 'no user' }, 400);

  // только «чистые» короткие значения
  const pick = (s, re, max) => (typeof s === 'string' && re.test(s) ? s.slice(0, max) : '');
  const track = pick(body.track, /^[a-z0-9_-]+$/, 32);
  const form = pick(body.form, /^[А-ЯA-Z0-9-]+$/, 16);
  const card = pick(body.card, /^[А-ЯA-Z0-9-]+$/, 16);
  if (!track) return json({ error: 'bad track' }, 400);

  const existing = await env.DB.prepare('SELECT active FROM patients WHERE id = ?').bind(user.id).first();
  await env.DB.prepare(
    `INSERT INTO patients (id, track, form, card, created, active) VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET track = excluded.track, form = excluded.form, card = excluded.card, active = 1`
  ).bind(user.id, track, form, card, Date.now()).run();

  // подтверждение — только при первой постановке (или повторной после /stop)
  if (!existing || !existing.active) {
    await tg(env, 'sendMessage', { chat_id: user.id, text: TEXT.registered({ card: card || '—', form: form || 'СДПН' }) });
  }
  return json({ ok: true });
}

/* Проверка подписи initData: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const enc = new TextEncoder();
  const hmac = async (key, msg) => {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  };
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const sig = await hmac(secret, check);
  const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== hash) return null;
  // подпись не старше суток
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  return params;
}

/* ---------- Вебхук бота ---------- */
async function webhook(req, env) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const upd = await req.json();

  // человек заблокировал бота — снимаем с учёта
  const mcm = upd.my_chat_member;
  if (mcm && mcm.chat.type === 'private' && ['kicked', 'left'].includes(mcm.new_chat_member.status)) {
    await env.DB.prepare('UPDATE patients SET active = 0 WHERE id = ?').bind(mcm.chat.id).run();
    return new Response('ok');
  }

  const msg = upd.message;
  if (!msg || msg.chat.type !== 'private') return new Response('ok');
  const text = (msg.text || '').trim();
  const appBtn = { reply_markup: { inline_keyboard: [[{ text: TEXT.startBtn, web_app: { url: env.MINIAPP_URL } }]] } };

  if (text.startsWith('/preview')) {
    // скрытая команда автора: открыть приложение «за 5 дней до релиза», чтобы проверить предрелизный режим
    const preview = { reply_markup: { inline_keyboard: [[{ text: 'Предпросмотр: за 5 дней до релиза', web_app: { url: env.MINIAPP_URL + '?days=5&v=' + Date.now() } }]] } }; // v= — чтобы Telegram не открыл старую копию
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Режим предпросмотра. Так приложение будет выглядеть за 5 дней до релиза.', ...preview });
  } else if (text.startsWith('/start')) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: TEXT.start, ...appBtn });
  } else if (text.startsWith('/stop')) {
    await env.DB.prepare('UPDATE patients SET active = 0 WHERE id = ?').bind(msg.chat.id).run();
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: TEXT.stop });
  } else {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: TEXT.other, ...appBtn });
  }
  return new Response('ok');
}

/* ---------- Стоит ли пациент на учёте (чтобы приложение не верило старой памяти после /stop) ---------- */
async function status(req, env) {
  const body = JSON.parse(await req.text());
  const data = await verifyInitData(body.initData || '', env.BOT_TOKEN);
  if (!data) return json({ error: 'bad signature' }, 401);
  const user = JSON.parse(data.get('user') || '{}');
  const row = user.id ? await env.DB.prepare('SELECT active FROM patients WHERE id = ?').bind(user.id).first() : null;
  return json({ active: !!(row && row.active) });
}

/* ---------- Сниппеты процедурного листа ----------
   Файл (ключ dayN в KV) отдаётся, только когда наступил его день:
   день N открывается за (8 − N) суток до RELEASE_DATE — так же, как в приложении.
   Авторы (Telegram ID в секрете ADMIN_IDS через запятую) получают любой файл в любое время — для /preview. */
const DAY_MS = 864e5;
async function teaser(req, env) {
  const body = JSON.parse(await req.text());
  const key = typeof body.key === 'string' && /^day([1-9])$/.exec(body.key);
  if (!key) return json({ error: 'bad key' }, 400);
  const day = parseInt(key[1], 10);

  let allowed = false;
  const release = env.RELEASE_DATE ? Date.parse(env.RELEASE_DATE) : NaN;
  if (!isNaN(release) && Date.now() >= release - (8 - day) * DAY_MS) allowed = true;
  if (!allowed && body.initData) {
    const data = await verifyInitData(body.initData, env.BOT_TOKEN);
    const id = data && JSON.parse(data.get('user') || '{}').id;
    const admins = clean(env.ADMIN_IDS).split(',').filter(Boolean);
    if (id && admins.includes(String(id))) allowed = true;
  }
  if (!allowed) return json({ error: 'locked' }, 403);

  const { value, metadata } = await env.TEASERS.getWithMetadata(body.key, { type: 'arrayBuffer' });
  if (!value) return json({ error: 'not uploaded' }, 404);
  return new Response(value, {
    headers: { 'Content-Type': (metadata && metadata.type) || 'audio/mpeg', 'Cache-Control': 'private, no-store' },
  });
}

/* ---------- Статистика ---------- */
async function stats(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM patients WHERE active = 1').first();
  return json({ patients: row ? row.n : 0 }, 200, { 'Cache-Control': 'public, max-age=60' });
}

/* ---------- Админка ---------- */
async function patients(env) {
  const { results } = await env.DB.prepare('SELECT id, track, form, card FROM patients WHERE active = 1').all();
  return json({ patients: results });
}
async function forget(req, env) {
  const { ids } = await req.json();
  if (!Array.isArray(ids)) return json({ error: 'ids' }, 400);
  for (const id of ids.slice(0, 1000)) await env.DB.prepare('UPDATE patients SET active = 0 WHERE id = ?').bind(id).run();
  return json({ ok: true, count: ids.length });
}
async function setup(url, env) {
  const hook = await tg(env, 'setWebhook', {
    url: `${url.origin}/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'my_chat_member'],
    drop_pending_updates: true,
  });
  const cmds = await tg(env, 'setMyCommands', {
    commands: [
      { command: 'start', description: 'Регистратура' },
      { command: 'stop', description: 'Снять с учёта' },
    ],
  });
  return json({ webhook: hook, commands: cmds });
}

/* ---------- Утилиты ---------- */
async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}
function withCors(res, cors) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
