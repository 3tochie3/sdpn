# Регистратура СДПН: сервер «постановки на учёт» и рассылка

Без сервера приложение работает полностью, кроме кнопки «Встать на учёт» и сообщения от бота в день релиза. Для них нужен этот маленький сервер на **Cloudflare Workers** (бесплатно) и база **D1** (бесплатно, до 100 000 записей в день).

```
server/
├─ worker.js       ← сервер: /register, /webhook (/start, /stop), /stats, /admin/*
├─ schema.sql      ← таблица пациентов
├─ wrangler.toml   ← настройки Cloudflare (без секретов)
├─ messages.json   ← тексты рассылок (релиз и напоминания)
└─ broadcast.py    ← скрипт рассылки (запускается с компьютера)
```

## Что хранится

Только Telegram ID, id назначенного трека, код диагноза, номер карты, дата постановки и флаг «на учёте». Имён, юзернеймов и телефонов нет. После релиза таблицу можно удалить.

## Запуск (один раз)

Все команды выполняются в папке `miniapp/server`.

1. **Аккаунт Cloudflare.** Зарегистрируйтесь на https://dash.cloudflare.com (бесплатно).
2. **Вход:**
   ```
   npx wrangler login
   ```
   Откроется браузер, нажмите «Allow».
3. **База:**
   ```
   npx wrangler d1 create sdpn
   ```
   Скопируйте `database_id` из ответа в `wrangler.toml`. Затем создайте таблицу:
   ```
   npx wrangler d1 execute sdpn --remote --file=schema.sql
   ```
4. **Секреты.** Каждая команда попросит ввести значение. Вставляете вы, в чат их не кидать:
   ```
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put ADMIN_KEY
   npx wrangler secret put WEBHOOK_SECRET
   ```
   - `BOT_TOKEN` — из @BotFather: `/mybots` → бот → **API Token**.
   - `ADMIN_KEY` и `WEBHOOK_SECRET` — любые длинные строки из латиницы и цифр. `ADMIN_KEY` запишите себе: он нужен для рассылки.
5. **Публикация:**
   ```
   npx wrangler deploy
   ```
   В ответе будет адрес вида `https://sdpn-registry.<имя>.workers.dev`.
6. **Подключить бота к серверу** (вебхук и команды /start, /stop). Это PowerShell:
   ```
   Invoke-RestMethod -Method Post -Uri "https://sdpn-registry.<имя>.workers.dev/admin/setup" -Headers @{ "X-Admin-Key" = "ВАШ_ADMIN_KEY" }
   ```
   В ответе должно быть `"ok": true` дважды. Теперь бот отвечает на /start.
7. **Связать с приложением.** В `index.html` впишите адрес сервера: `api: 'https://sdpn-registry.<имя>.workers.dev'`. Затем выложите приложение.

## Рассылка

PowerShell, в папке `miniapp/server`:
```
$env:BOT_TOKEN = "токен"
$env:SDPN_API = "https://sdpn-registry.<имя>.workers.dev"
$env:SDPN_ADMIN_KEY = "ваш ADMIN_KEY"

python broadcast.py release --dry-run          # посмотреть тексты и число получателей, ничего не отправляет
python broadcast.py release --only <ваш ID>    # прислать только себе (ID можно узнать у @userinfobot)
python broadcast.py d3                         # напоминание за 3 дня
python broadcast.py d1                         # напоминание за 1 день
python broadcast.py release                    # в момент релиза
```

- Тексты правятся в `messages.json`. Названия и ссылки треков скрипт берёт из `index.html`, поэтому сначала впишите туда ссылки на треки.
- Скорость около 25 сообщений в секунду, тысяча человек получит сообщения меньше чем за минуту.
- Кто заблокировал бота, автоматически снимается с учёта.
- Если запустить повторно, второй раз сообщения никому не уйдут: отправленные ID записываются в `sent_<тип>.txt`.

## Правила, чтобы бота не заблокировали

- Пишем только тем, кто сам нажал «Встать на учёт» и разрешил боту писать.
- За неделю максимум 2 напоминания и 1 сообщение в день релиза.
- В каждом сообщении есть «Снять с учёта: /stop».
