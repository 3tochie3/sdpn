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

const HEAD = `МИНИСТЕРСТВО ЗВУКОВОГО ЗДРАВООХРАНЕНИЯ\nЦентр музыкальной психотерапии «СДПН»\n\n`;
const TEXT = {
  // подтверждение постановки на учёт — зависит от того, идёт ли уже курс процедур
  registered: (p, c) =>
    HEAD +
    `Пациент поставлен на учёт.\n` +
    `Карта № ${p.card} · диагноз ${p.form}.\n\n` +
    (c.phase === 'course'
      ? `Курс подготовки уже идёт: открыто процедур — ${c.opened} из 7. Пропущенные процедуры доступны в процедурном листе.\n` +
        `До выхода «СДПН»: ${c.daysLeft} ${plural(c.daysLeft, 'день', 'дня', 'дней')}.\n\n`
      : c.phase === 'released'
        ? `Препарат «СДПН» уже поступил на все площадки. Процедурный лист открыт полностью.\n\n`
        : `Препарат «СДПН» (ТРОЕТОЧИЕ) проходит последние испытания. Вам выдан процедурный лист: ` +
          `курс из 7 процедур начнётся за неделю до поступления препарата в аптеки. ` +
          `Дежурный врач будет сообщать о каждой процедуре и лично пришлёт назначение в день релиза.\n\n`) +
    `Снять с учёта: /stop`,
  openProc: '▶ Открыть процедурный лист',
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
const cleanEnv = (rawEnv) => ({ ...rawEnv, BOT_TOKEN: clean(rawEnv.BOT_TOKEN), ADMIN_KEY: clean(rawEnv.ADMIN_KEY), WEBHOOK_SECRET: clean(rawEnv.WEBHOOK_SECRET), ADMIN_IDS: clean(rawEnv.ADMIN_IDS) });
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}

export default {
  // Рассылка по расписанию: cron каждую минуту, но работает только в окна рассылки (см. campaignNow)
  async scheduled(event, rawEnv, ctx) {
    ctx.waitUntil(runCampaign(cleanEnv(rawEnv)).catch((e) => console.error(e)));
  },
  async fetch(req, rawEnv) {
    const env = cleanEnv(rawEnv);
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === '/register' && req.method === 'POST') return withCors(await register(req, env), cors);
      if (url.pathname === '/stats' && req.method === 'GET') return withCors(await stats(env), cors);
      if (url.pathname === '/status' && req.method === 'POST') return withCors(await status(req, env), cors);
      if (url.pathname === '/teaser' && req.method === 'POST') return withCors(await teaser(req, env), cors);
      if (url.pathname === '/whoami' && req.method === 'POST') return withCors(await whoami(req, env), cors);
      if (url.pathname === '/track' && req.method === 'POST') return withCors(await addTrack(req, env), cors);
      if (url.pathname === '/webhook' && req.method === 'POST') return await webhook(req, env);
      if (url.pathname.startsWith('/admin/')) {
        if (req.headers.get('X-Admin-Key') !== env.ADMIN_KEY || !env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
        if (url.pathname === '/admin/patients') return await patients(env);
        if (url.pathname === '/admin/forget' && req.method === 'POST') return await forget(req, env);
        if (url.pathname === '/admin/setup' && req.method === 'POST') return await setup(url, env);
        if (url.pathname === '/admin/campaign-status') return await campaignStatus(env);
        if (url.pathname === '/admin/campaign-test' && req.method === 'POST') return await campaignTest(req, env);
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

  const existing = await env.DB.prepare('SELECT active, tracks FROM patients WHERE id = ?').bind(user.id).first();
  // все треки из «Результатов» пациента + текущий
  const tracks = mergeTracks(existing && existing.tracks, [...(Array.isArray(body.history) ? body.history : []), track]);
  await env.DB.prepare(
    `INSERT INTO patients (id, track, form, card, created, active, tracks) VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET track = excluded.track, form = excluded.form, card = excluded.card, active = 1, tracks = excluded.tracks`
  ).bind(user.id, track, form, card, Date.now(), tracks).run();

  // подтверждение — только при первой постановке (или повторной после /stop)
  if (!existing || !existing.active) {
    const c = courseState(env);
    await tg(env, 'sendMessage', {
      chat_id: user.id,
      text: TEXT.registered({ card: card || '—', form: form || 'СДПН' }, c),
      reply_markup: { inline_keyboard: await registeredButtons(env, c) },
    });
  }
  return json({ ok: true });
}

/* Кнопки под подтверждением постановки на учёт:
   до курса — процедурный лист; во время курса — лист + «Предзаказ «СДПН»»; после релиза — «Слушать «СДПН»» + лист */
async function registeredButtons(env, c) {
  const proc = [{ text: TEXT.openProc, web_app: { url: appUrl(env, 'proc') } }];
  if (c.phase !== 'course' && c.phase !== 'released') return [proc];
  let site = { presave: '', album: '' };
  try { site = await loadSite(env); } catch (e) {} // сайт недоступен — просто без ссылок
  if (c.phase === 'course') return site.presave ? [proc, [{ text: 'Предзаказ «СДПН»', url: site.presave }]] : [proc];
  return site.album ? [[{ text: '▶ Слушать «СДПН»', url: site.album }], proc] : [proc];
}

/* ---------- Новое обследование у пациента на учёте: дописать трек в его назначения ---------- */
async function addTrack(req, env) {
  const body = JSON.parse(await req.text());
  const data = await verifyInitData(body.initData || '', env.BOT_TOKEN);
  const id = data && JSON.parse(data.get('user') || '{}').id;
  if (!id) return json({ error: 'bad signature' }, 401);
  if (!TRACK_RE.test(body.track || '')) return json({ error: 'bad track' }, 400);
  const row = await env.DB.prepare('SELECT active, tracks FROM patients WHERE id = ?').bind(id).first();
  if (!row || !row.active) return json({ ok: false, registered: false });
  const pick = (s) => (typeof s === 'string' && /^[А-ЯA-Z0-9-]{1,16}$/.test(s) ? s : '');
  await env.DB.prepare('UPDATE patients SET track = ?, form = ?, card = ?, tracks = ? WHERE id = ?')
    .bind(body.track, pick(body.form), pick(body.card), mergeTracks(row.tracks, [body.track]), id).run();
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

  const isAdmin = clean(env.ADMIN_IDS).split(',').filter(Boolean).includes(String(msg.from && msg.from.id));
  if (text.startsWith('/preview') && isAdmin) { // только авторам; остальным — как на любой текст
    // скрытая команда автора: открыть приложение в предрелизном режиме (v= — чтобы Telegram не открыл старую копию)
    const v = Date.now();
    const preview = { reply_markup: { inline_keyboard: [
      [{ text: 'Первый день предзаказа · новый пользователь', web_app: { url: `${env.MINIAPP_URL}?days=7&fresh=1&v=${v}` } }],
      [{ text: 'Накануне релиза (открыты все 7 дней)', web_app: { url: `${env.MINIAPP_URL}?days=1&v=${v}` } }],
      [{ text: 'За 5 дней до релиза', web_app: { url: `${env.MINIAPP_URL}?days=5&v=${v}` } }],
    ] } };
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Режим предпросмотра. Выберите, какой день показать.\nСниппеты в предпросмотре доступны только авторам.', ...preview });
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
   Файл (ключ dayN в KV) отдаётся только пациентам, вставшим на учёт, и только когда наступил его день:
   день N открывается за (8 − N) суток до RELEASE_DATE — так же, как в приложении.
   Авторы (Telegram ID в секрете ADMIN_IDS через запятую) получают любой файл в любое время — для /preview. */
const DAY_MS = 864e5;
async function teaser(req, env) {
  const body = JSON.parse(await req.text());
  const key = typeof body.key === 'string' && /^day([1-9])$/.exec(body.key);
  if (!key) return json({ error: 'bad key' }, 400);
  const day = parseInt(key[1], 10);

  // кто спрашивает: только подписанный Telegram-пользователь
  const data = body.initData ? await verifyInitData(body.initData, env.BOT_TOKEN) : null;
  const id = data && JSON.parse(data.get('user') || '{}').id;
  if (!id) return json({ error: 'locked' }, 403);

  const admins = clean(env.ADMIN_IDS).split(',').filter(Boolean);
  let allowed = admins.includes(String(id)); // авторы — всегда (для /preview)
  if (!allowed) {
    // остальные — только вставшие на учёт и только когда наступил день процедуры
    const release = env.RELEASE_DATE ? Date.parse(env.RELEASE_DATE) : NaN;
    const dayReached = !isNaN(release) && Date.now() >= release - (8 - day) * DAY_MS;
    const row = dayReached ? await env.DB.prepare('SELECT active FROM patients WHERE id = ?').bind(id).first() : null;
    allowed = !!(row && row.active);
  }
  if (!allowed) return json({ error: 'locked' }, 403);

  const { value, metadata } = await env.TEASERS.getWithMetadata(body.key, { type: 'arrayBuffer' });
  if (!value) return json({ error: 'not uploaded' }, 404);
  return new Response(value, {
    headers: { 'Content-Type': (metadata && metadata.type) || 'audio/mpeg', 'Cache-Control': 'private, no-store' },
  });
}

/* ---------- Автор ли это? (приложение включает предпросмотр ?days/?fresh только авторам) ---------- */
async function whoami(req, env) {
  const body = JSON.parse(await req.text());
  const data = body.initData ? await verifyInitData(body.initData, env.BOT_TOKEN) : null;
  const id = data && JSON.parse(data.get('user') || '{}').id;
  return json({ admin: !!id && clean(env.ADMIN_IDS).split(',').filter(Boolean).includes(String(id)) });
}

/* =====================================================================
   РАССЫЛКА «ДЕЖУРНОГО ВРАЧА»
   • 7 дней до релиза — каждый день в 19:00 МСК: «открыта процедура № N, до выхода СДПН — X дней».
   • Момент релиза (RELEASE_DATE, 00:00 МСК) — личное назначение с треком.
   Cron дёргает сервер каждую минуту; в окно рассылки он отправляет пачку (~40 сообщений —
   лимит бесплатного Cloudflare) и запоминает, кому уже ушло (таблица sends). Дважды — никогда.
   Названия процедур и треков берутся прямо с сайта (index.html), чтобы не дублировать.
   ===================================================================== */
const SEND_HOUR_MSK = 19;      // ежедневное сообщение — в 19:00 по Москве
const DAILY_WINDOW_H = 4;      // сколько часов после 19:00 досылать (если людей много)
const RELEASE_WINDOW_H = 6;    // сколько часов после релиза досылать назначения
const BATCH = 40;              // сообщений за один запуск (лимит бесплатного тарифа — 50 запросов)

/* Строки для каждого дня курса (под процедурный план; {tracks} — число треков). Уточнить вместе с планом. */
const DAILY_LINES = [
  'Курс подготовки начат. Медицинская карта заведена.',
  'Выписка из истории болезни готова. Читать в тишине.',
  'Первая доза препарата выдана. Принимать через наушники.',
  'Снимок препарата готов. Изображение проявляется не сразу.',
  'Опубликован состав препарата. Действующих веществ: {tracks}.',
  'Доза увеличена. Действует на слух и зрение.',
  'Последняя ночь без препарата. Зарядите наушники. Освободите ночь.',
];

/* Все треки пациента (по всем его обследованиям). В базе — через запятую, без повторов. */
const TRACK_RE = /^[a-z0-9_-]{1,32}$/;
function trackList(p) {
  const list = [...new Set(String(p.tracks || '').split(',').filter((t) => TRACK_RE.test(t)))];
  return list.length ? list : (p.track ? [p.track] : []);
}
function mergeTracks(existing, add) {
  const out = String(existing || '').split(',').filter((t) => TRACK_RE.test(t));
  for (const t of add) if (typeof t === 'string' && TRACK_RE.test(t) && !out.includes(t)) out.push(t);
  return out.slice(0, 30).join(',');
}

const appUrl = (env, tab) => `${env.MINIAPP_URL}?tab=${tab}&v=${Date.now()}`; // v= — мимо кэша Telegram

/* Где мы сейчас относительно релиза */
function courseState(env, now = Date.now()) {
  const release = Date.parse(env.RELEASE_DATE || '');
  if (isNaN(release)) return { phase: 'nodate' };
  if (now >= release) return { phase: 'released' };
  const daysLeft = Math.ceil((release - now) / DAY_MS);
  if (daysLeft > 7) return { phase: 'before', daysLeft };
  return { phase: 'course', daysLeft, opened: 8 - daysLeft };
}
/* Какую рассылку отправлять прямо сейчас (или null) */
function campaignNow(env, now = Date.now()) {
  const release = Date.parse(env.RELEASE_DATE || '');
  if (isNaN(release)) return null;
  if (now >= release && now < release + RELEASE_WINDOW_H * 36e5) return { key: 'release' };
  for (let n = 1; n <= 7; n++) {
    const opens = release - (8 - n) * DAY_MS;           // процедура N открывается в 00:00 МСК своего дня
    const at = opens + SEND_HOUR_MSK * 36e5;             // а сообщение уходит в 19:00 того же дня
    if (now >= at && now < at + DAILY_WINDOW_H * 36e5) return { key: `day${n}`, n, daysLeft: 8 - n };
  }
  return null;
}
/* Названия процедур, треки и ссылка на альбом — с опубликованного сайта */
async function loadSite(env) {
  const html = await (await fetch(`${env.MINIAPP_URL}?nc=${Date.now()}`)).text();
  const block = (from, to) => { const a = html.indexOf(from); const b = html.indexOf(to, a); return a < 0 ? '' : html.slice(a, b < 0 ? undefined : b); };
  const procs = [...block('procedures: [', '/* ---------- Учреждение').matchAll(/title: '([^']*)'/g)].map((m) => m[1]);
  const tracks = {};
  for (const m of block('tracks: {', '/* ---------- Формы диагноза').matchAll(/(\w+):\s*\{\s*title:\s*'([^']*)',\s*url:\s*'([^']*)'/g)) tracks[m[1]] = { title: m[2], url: m[3] };
  const album = (/albumUrl:\s*'([^']*)'/.exec(html) || [])[1] || '';
  const presave = (/presaveUrl:\s*'([^']*)'/.exec(html) || [])[1] || '';
  return { procs, tracks, album, presave };
}
function buildMessage(c, p, site, env) {
  if (c.key === 'release') {
    // Курс пройден, альбом вышел: все треки, назначенные пациенту за все обследования, + кнопка на альбом
    const ids = trackList(p);
    const titles = ids.map((id) => `— «${(site.tracks[id] || { title: id }).title}»`);
    const rows = [[site.album
      ? { text: '▶ Слушать «СДПН»', url: site.album }
      : { text: '▶ Открыть медкарту', web_app: { url: appUrl(env, 'hist') } }]];
    return {
      text: HEAD + `Курс первоначального лечения пройден.\n` +
        `Препарат «СДПН» поступил на все площадки.\n\n` +
        `Карта № ${p.card || '—'} · диагноз ${p.form || 'СДПН'}\n` +
        (ids.length > 1 ? `Ваши назначения по результатам обследований:\n` : `Ваше назначение:\n`) +
        titles.join('\n') + `\nс альбома «СДПН» — ТРОЕТОЧИЕ.\n\n` +
        `Способ применения: аурикулярно, через наушники.\nРежим: ежедневно, предпочтительно ночью, на высокой громкости.\n` +
        `Длительность курса: до восстановления эмоциональной нестабильности.\n\nСнять с учёта: /stop`,
      reply_markup: { inline_keyboard: rows },
    };
  }
  const title = site.procs[c.n - 1] || `Процедура № ${c.n}`;
  const line = (DAILY_LINES[c.n - 1] || '').replace('{tracks}', String(Object.keys(site.tracks).length));
  return {
    text: HEAD + `Процедурный лист · День ${c.n} из 7\n\n` +
      `Пациент, открыта процедура № ${c.n} — «${title}».\n${line}\n\n` +
      `До выхода «СДПН»: ${c.daysLeft} ${plural(c.daysLeft, 'день', 'дня', 'дней')}.\n` +
      `Пропуск процедур не рекомендуется.\n\nСнять с учёта: /stop`,
    reply_markup: { inline_keyboard: [
      [{ text: '▶ Принять процедуру', web_app: { url: appUrl(env, 'proc') } }],
      ...(site.presave ? [[{ text: 'Предзаказ «СДПН»', url: site.presave }]] : []), // пресейв — если ссылка уже вписана
    ] },
  };
}
async function sendRaw(env, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return r.status;
}
/* Один запуск: отправить следующую пачку текущей рассылки */
async function runCampaign(env, now = Date.now()) {
  const c = campaignNow(env, now);
  if (!c) return { idle: true };
  const { results } = await env.DB.prepare(
    'SELECT id, track, form, card, tracks FROM patients WHERE active = 1 AND id NOT IN (SELECT id FROM sends WHERE campaign = ?) LIMIT ?'
  ).bind(c.key, BATCH).all();
  if (!results.length) return { campaign: c.key, done: true };
  const site = await loadSite(env);
  let ok = 0, blocked = 0, errors = 0;
  for (const p of results) {
    const st = await sendRaw(env, { chat_id: p.id, ...buildMessage(c, p, site, env) });
    if (st === 429) break; // Telegram просит притормозить — продолжим в следующую минуту
    const status = st === 200 ? 'ok' : st === 403 ? 'blocked' : 'error';
    if (status === 'blocked') await env.DB.prepare('UPDATE patients SET active = 0 WHERE id = ?').bind(p.id).run();
    await env.DB.prepare('INSERT OR IGNORE INTO sends (campaign, id, status, ts) VALUES (?, ?, ?, ?)').bind(c.key, p.id, status, now).run();
    status === 'ok' ? ok++ : status === 'blocked' ? blocked++ : errors++;
  }
  return { campaign: c.key, ok, blocked, errors };
}
/* Админка: что уже разослано и какая рассылка идёт сейчас */
async function campaignStatus(env) {
  const { results } = await env.DB.prepare('SELECT campaign, status, COUNT(*) AS n FROM sends GROUP BY campaign, status').all();
  return json({ now: campaignNow(env), course: courseState(env), releaseDate: env.RELEASE_DATE || null, sends: results });
}
/* Админка: прислать любое сообщение рассылки только авторам (проверить вид) */
async function campaignTest(req, env) {
  const { campaign } = await req.json();
  const m = /^day([1-7])$/.exec(campaign || '');
  const c = campaign === 'release' ? { key: 'release' } : m ? { key: campaign, n: +m[1], daysLeft: 8 - +m[1] } : null;
  if (!c) return json({ error: 'campaign: day1…day7 или release' }, 400);
  const site = await loadSite(env);
  const ids = clean(env.ADMIN_IDS).split(',').filter(Boolean);
  const out = [];
  for (const id of ids) {
    const row = await env.DB.prepare('SELECT track, form, card, tracks FROM patients WHERE id = ?').bind(id).first();
    const p = { id, track: (row && row.track) || Object.keys(site.tracks)[0], form: (row && row.form) || 'СДПН-01', card: (row && row.card) || 'СДПН-000', tracks: (row && row.tracks) || '' };
    out.push(await sendRaw(env, { chat_id: id, ...buildMessage(c, p, site, env) }));
  }
  return json({ sent: out });
}

/* ---------- Статистика ---------- */
async function stats(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM patients WHERE active = 1').first();
  return json({ patients: row ? row.n : 0 }, 200, { 'Cache-Control': 'public, max-age=60' });
}

/* ---------- Админка ---------- */
async function patients(env) {
  const { results } = await env.DB.prepare('SELECT id, track, form, card, tracks FROM patients WHERE active = 1').all();
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
