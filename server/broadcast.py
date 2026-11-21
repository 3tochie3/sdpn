"""
Рассылка «дежурного врача» всем, кто встал на учёт.

Запуск (PowerShell, из папки miniapp/server):
    $env:BOT_TOKEN = "токен из @BotFather"
    $env:SDPN_API = "https://sdpn-registry.<имя>.workers.dev"
    $env:SDPN_ADMIN_KEY = "ваш ADMIN_KEY"

    python broadcast.py release --dry-run          # показать, кому и что уйдёт (ничего не отправляет)
    python broadcast.py release --only 123456789   # отправить только себе (ваш Telegram ID) — проверить вид
    python broadcast.py release                    # боевая рассылка в день релиза
    python broadcast.py d3                         # напоминание за 3 дня (ключ из messages.json → reminders)

Без сторонних библиотек. Скорость ~25 сообщений/сек (лимит Telegram ~30/сек).
Кто заблокировал бота — автоматически снимается с учёта.
Повторный запуск не шлёт дважды: отправленные ID пишутся в sent_<тип>.txt.
"""
import argparse, json, os, re, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "..", "index.html")


def load_tracks():
    """Названия и ссылки треков берём прямо из index.html (CONTENT.tracks), чтобы не дублировать."""
    src = open(INDEX, encoding="utf-8").read()
    block = src[src.index("tracks: {"): src.index("/* ---------- Формы диагноза")]
    out = {}
    for m in re.finditer(r"(\w+):\s*\{\s*title:\s*'([^']*)',\s*url:\s*'([^']*)'", block):
        out[m.group(1)] = {"title": m.group(2), "url": m.group(3)}
    return out


def http(method, url, data=None, headers=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", help="release или ключ из reminders (например d3, d1)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", type=int, help="отправить только этому Telegram ID")
    a = ap.parse_args()

    token, api, key = os.environ.get("BOT_TOKEN"), os.environ.get("SDPN_API", "").rstrip("/"), os.environ.get("SDPN_ADMIN_KEY")
    if not (token and api and key):
        sys.exit("Задайте BOT_TOKEN, SDPN_API и SDPN_ADMIN_KEY (см. начало файла).")

    msgs = json.load(open(os.path.join(HERE, "messages.json"), encoding="utf-8"))
    template = msgs["release"] if a.kind == "release" else msgs["reminders"].get(a.kind)
    if not template:
        sys.exit(f"Нет текста «{a.kind}» в messages.json")
    tracks = load_tracks()

    if a.only:
        patients = [{"id": a.only, "track": next(iter(tracks)), "form": "СДПН-01", "card": "СДПН-000"}]
    else:
        st, res = http("GET", f"{api}/admin/patients", headers={"X-Admin-Key": key})
        if st != 200:
            sys.exit(f"Сервер ответил {st}: {res}")
        patients = res["patients"]

    sent_path = os.path.join(HERE, f"sent_{a.kind}.txt")
    already = set(open(sent_path).read().split()) if os.path.exists(sent_path) and not a.only else set()
    todo = [p for p in patients if str(p["id"]) not in already]
    print(f"Пациентов на учёте: {len(patients)}; к отправке: {len(todo)} (уже получили: {len(already)})")

    blocked, ok, fail = [], 0, 0
    sent_log = open(sent_path, "a") if not (a.dry_run or a.only) else None
    for i, p in enumerate(todo, 1):
        t = tracks.get(p["track"], {"title": p["track"], "url": ""})
        text = template.format(card=p.get("card") or "—", form=p.get("form") or "СДПН", track=t["title"])
        payload = {"chat_id": p["id"], "text": text}
        link = t["url"] or msgs.get("albumUrl")
        if a.kind == "release" and link:
            payload["reply_markup"] = {"inline_keyboard": [[{"text": msgs.get("button", "Принять назначение"), "url": link}]]}
        if a.dry_run:
            if i <= 3:
                btn = f"\n[кнопка: {link or 'нет ссылки — впишите url трека или albumUrl'}]" if a.kind == "release" else ""
                print(f"\n--- {p['id']} ---\n{text}{btn}")
            continue

        while True:
            st, res = http("POST", f"https://api.telegram.org/bot{token}/sendMessage", payload)
            if st == 429:  # слишком быстро — ждём сколько сказал Telegram
                time.sleep(res.get("parameters", {}).get("retry_after", 5) + 1)
                continue
            break
        if st == 200:
            ok += 1
            if sent_log:
                sent_log.write(f"{p['id']}\n"); sent_log.flush()
        elif st == 403:  # заблокировал бота / удалил аккаунт
            blocked.append(p["id"])
        else:
            fail += 1
            print(f"  ! {p['id']}: {st} {res.get('description', '')}")
        if i % 100 == 0:
            print(f"  … {i}/{len(todo)}")
        time.sleep(0.04)

    if blocked:
        http("POST", f"{api}/admin/forget", {"ids": blocked}, {"X-Admin-Key": key})
    if a.dry_run:
        print(f"\n(dry-run) Ничего не отправлено. Всего было бы: {len(todo)}")
    else:
        print(f"\nГотово: отправлено {ok}, заблокировали бота {len(blocked)}, ошибок {fail}")


if __name__ == "__main__":
    main()
