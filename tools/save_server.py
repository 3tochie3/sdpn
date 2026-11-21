"""
Локальный сервер для автора.

1) Раздаёт папку miniapp на http://localhost:8765
2) Принимает PUT /__save?name=<файл>.jpg и кладёт картинку в miniapp/stories/

Как сгенерировать картинки для сторис (после правки текстов):
    python tools/save_server.py
    открыть http://localhost:8765/?export=stories
"""
import http.server, os, re, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORIES = os.path.join(ROOT, "stories")
PORT = 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_PUT(self):
        u = urllib.parse.urlparse(self.path)
        name = urllib.parse.parse_qs(u.query).get("name", [""])[0]
        if u.path != "/__save" or not re.fullmatch(r"[a-z0-9_-]+\.jpg", name):
            self.send_error(400, "bad name")
            return
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        os.makedirs(STORIES, exist_ok=True)
        with open(os.path.join(STORIES, name), "wb") as f:
            f.write(data)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")
        print("saved", name, len(data), "bytes")


if __name__ == "__main__":
    print(f"http://localhost:{PORT}  (сторис: http://localhost:{PORT}/?export=stories)")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
