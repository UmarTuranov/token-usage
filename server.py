#!/usr/bin/env python3
"""Локальный сервер статистики токенов Claude Code.

Читает транскрипты из ~/.claude/projects/**/*.jsonl, ничего никуда не отправляет.
Запуск:  python3 server.py  →  http://127.0.0.1:8765
"""
import argparse
import datetime
import glob
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.expanduser(os.environ.get("CLAUDE_PROJECTS_DIR", "~/.claude/projects"))
PORT = int(os.environ.get("PORT", "8765"))

# Встроенные слэш-команды — это не скиллы.
BUILTIN_COMMANDS = {
    "model", "clear", "compact", "config", "cost", "help", "init", "login", "logout",
    "memory", "permissions", "resume", "status", "doctor", "exit", "fast", "effort",
    "hooks", "mcp", "agents", "context", "usage", "rewind", "add-dir", "ide", "vim",
    "theme", "output-style", "plugin", "plugins", "bug", "feedback", "release-notes",
}

CMD_RE = re.compile(r"<command-name>/?([^<\s]+)</command-name>")

_cache = {"sig": None, "data": None}
_lock = threading.Lock()


def project_name(cwd, folder):
    if cwd:
        if "/scratch-workspaces/" in cwd:
            return "Без папки"
        return os.path.basename(cwd.rstrip("/")) or cwd
    return folder.strip("-").split("-")[-1]


def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for c in content or []:
        if isinstance(c, dict) and c.get("type") == "text":
            out.append(c.get("text", ""))
    return "\n".join(out)


def has_tool_result(content):
    return isinstance(content, list) and any(
        isinstance(c, dict) and c.get("type") == "tool_result" for c in content
    )


def clean_prompt(t):
    t = re.sub(r"<system-reminder>.*?</system-reminder>", "", t, flags=re.S)
    t = re.sub(r"<[^>]+>", "", t)
    return " ".join(t.split())[:240]


def parse_file(path, agent_type, agent_desc, sessions):
    """Возвращает список сообщений ассистента (дедуплицированных по message.id)."""
    msgs = {}
    order = []
    active_skill = None
    folder = os.path.relpath(path, PROJECTS).split(os.sep)[0]
    for line in open(path, encoding="utf-8", errors="ignore"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        t = d.get("type")
        sid = d.get("sessionId")
        if not sid:
            continue
        s = sessions.setdefault(sid, {
            "id": sid, "title": None, "firstPrompt": None, "cwd": None,
            "folder": folder, "branch": None, "version": None, "entry": None,
        })
        if t == "custom-title" and agent_type is None:
            s["title"] = d.get("customTitle") or s["title"]
            continue
        if t == "agent-name" and agent_type is None and not s["title"]:
            s["title"] = d.get("agentName")
            continue
        if t == "user":
            if agent_type is None:
                s["cwd"] = s["cwd"] or d.get("cwd")
                s["branch"] = s["branch"] or d.get("gitBranch")
                s["version"] = d.get("version") or s["version"]
                s["entry"] = s["entry"] or d.get("entrypoint")
            content = (d.get("message") or {}).get("content")
            txt = text_of(content)
            m = CMD_RE.search(txt)
            if m and m.group(1) not in BUILTIN_COMMANDS:
                active_skill = m.group(1)
                continue
            if d.get("isMeta") or has_tool_result(content):
                continue
            # новый запрос пользователя → скилл предыдущего хода закончился
            if txt.strip():
                active_skill = None
                if agent_type is None and not s["firstPrompt"]:
                    p = clean_prompt(txt)
                    if p and not p.startswith(("This session is being continued", "Caveat:")):
                        s["firstPrompt"] = p
            continue
        if t != "assistant":
            continue
        msg = d.get("message") or {}
        model = msg.get("model")
        if not model or model == "<synthetic>":
            continue
        u = msg.get("usage") or {}
        key = msg.get("id") or d.get("uuid")
        tools = []
        for c in msg.get("content") or []:
            if isinstance(c, dict) and c.get("type") == "tool_use":
                tools.append(c.get("name"))
                if c.get("name") == "Skill":
                    sk = (c.get("input") or {}).get("skill")
                    if sk:
                        active_skill = sk
        cc = u.get("cache_creation") or {}
        w5 = cc.get("ephemeral_5m_input_tokens")
        w1 = cc.get("ephemeral_1h_input_tokens")
        cw = u.get("cache_creation_input_tokens") or 0
        if w5 is None and w1 is None:
            w5, w1 = cw, 0
        rec = msgs.get(key)
        if rec is None:
            rec = {
                "ts": d.get("timestamp"),
                "sid": sid,
                "model": model,
                "agent": agent_type or "main",
                "agentDesc": agent_desc,
                "skill": active_skill,
                "tools": [],
                "in": 0, "out": 0, "cr": 0, "w5": 0, "w1": 0, "think": 0,
                "effort": d.get("effort"),
            }
            msgs[key] = rec
            order.append(key)
        rec["tools"].extend(tools)
        if rec["skill"] is None and active_skill:
            rec["skill"] = active_skill
        # строки одного ответа повторяют usage; берём максимум (итоговое значение)
        rec["in"] = max(rec["in"], u.get("input_tokens") or 0)
        rec["out"] = max(rec["out"], u.get("output_tokens") or 0)
        rec["cr"] = max(rec["cr"], u.get("cache_read_input_tokens") or 0)
        rec["w5"] = max(rec["w5"], w5 or 0)
        rec["w1"] = max(rec["w1"], w1 or 0)
        rec["think"] = max(rec["think"], (u.get("output_tokens_details") or {}).get("thinking_tokens") or 0)
    return [msgs[k] for k in order]


def is_subagent(path):
    return os.sep + "subagents" + os.sep in path


def signature():
    files = glob.glob(os.path.join(PROJECTS, "**", "*.jsonl"), recursive=True)
    sig = 0
    for f in files:
        try:
            st = os.stat(f)
            sig ^= hash((f, st.st_mtime_ns, st.st_size))
        except OSError:
            pass
    return (len(files), sig), files


def build():
    sig, files = signature()
    with _lock:
        if _cache["sig"] == sig:
            return _cache["data"]
    sessions = {}
    messages = []
    agents_meta = []
    # сначала основные сессии, потом субагенты (чтобы заголовки сессий были заполнены)
    files.sort(key=lambda f: (is_subagent(f), f))
    for f in files:
        agent_type = agent_desc = None
        if is_subagent(f):
            meta_path = f[:-6] + ".meta.json"
            agent_type = "subagent"
            try:
                meta = json.load(open(meta_path))
                agent_type = meta.get("agentType") or "subagent"
                agent_desc = meta.get("description")
            except Exception:
                pass
        try:
            rows = parse_file(f, agent_type, agent_desc, sessions)
        except Exception as e:  # битый файл не должен ронять дашборд
            print("skip", f, e, file=sys.stderr)
            continue
        messages.extend(rows)
        if agent_type:
            agents_meta.append({"type": agent_type, "desc": agent_desc,
                                "sid": rows[0]["sid"] if rows else None})
    for s in sessions.values():
        s["project"] = project_name(s["cwd"], s["folder"])
    used = {m["sid"] for m in messages}
    data = {
        "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "source": PROJECTS,
        "sessions": [s for s in sessions.values() if s["id"] in used],
        "messages": messages,
        "agentRuns": agents_meta,
        "prices": load_prices(),
    }
    with _lock:
        _cache["sig"] = sig
        _cache["data"] = data
    return data


def load_prices():
    try:
        return json.load(open(os.path.join(ROOT, "prices.json"), encoding="utf-8"))
    except Exception:
        return {}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Защита от DNS rebinding: чужой сайт не сможет прочитать /api/data через подменённый домен.
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        if host not in ("127.0.0.1", "localhost", "::1"):
            return self.send(403, b"forbidden", "text/plain")
        path = self.path.split("?")[0]
        if path == "/api/data":
            body = json.dumps(build(), ensure_ascii=False, separators=(",", ":")).encode()
            return self.send(200, body, "application/json; charset=utf-8")
        static = {"/": "index.html", "/index.html": "index.html",
                  "/app.js": "app.js", "/style.css": "style.css"}
        name = static.get(path)
        if not name:
            return self.send(404, b"not found", "text/plain")
        ctype = {"html": "text/html", "js": "text/javascript", "css": "text/css"}[name.rsplit(".", 1)[1]]
        with open(os.path.join(ROOT, "public", name), "rb") as fh:
            self.send(200, fh.read(), ctype + "; charset=utf-8")


def main():
    ap = argparse.ArgumentParser(description="Локальный дашборд расхода токенов Claude Code")
    ap.add_argument("--port", type=int, default=PORT, help="порт (по умолчанию 8765 или $PORT)")
    ap.add_argument("--open", action="store_true", help="открыть дашборд в браузере после запуска")
    args = ap.parse_args()
    if not os.path.isdir(PROJECTS):
        print(f"Папка с логами не найдена: {PROJECTS}\n"
              "Укажите её через CLAUDE_PROJECTS_DIR=/путь python3 server.py", file=sys.stderr)
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as e:
        sys.exit(f"Не удалось занять порт {args.port}: {e.strerror}. Попробуйте --port 8766")
    url = f"http://127.0.0.1:{args.port}"
    print(f"Token usage → {url}  (данные: {PROJECTS})")
    if args.open:
        import webbrowser
        threading.Timer(0.6, webbrowser.open, (url,)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
