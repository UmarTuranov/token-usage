#!/usr/bin/env python3
"""Генерирует правдоподобные демо-логи Claude Code — для скриншотов и для знакомства без своих данных.

    python3 demo/generate.py                      # пишет в demo/projects
    CLAUDE_PROJECTS_DIR=demo/projects python3 server.py --open

Все проекты, сессии и запросы выдуманы. Результат детерминирован (фиксированный seed),
даты отсчитываются от текущего момента.
"""
import json
import os
import random
import shutil
import sys
import uuid
from datetime import datetime, timedelta, timezone

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "projects")
rnd = random.Random(42)
NOW = datetime.now(timezone.utc).replace(microsecond=0)
DAYS = 45

PROJECTS = {
    "storefront": ["Корзина: перенос на новый API", "Фильтры каталога тормозят", "Тёмная тема для витрины",
                   "Оплата: обработка отказов", "SSR для карточки товара", "Ленивая загрузка картинок"],
    "billing-api": ["Идемпотентность платежей", "Миграция на Postgres 17", "Вебхуки Stripe падают по таймауту",
                    "Отчёт по выручке за квартал", "Rate limit для партнёров"],
    "mobile-app": ["Экран профиля: новая навигация", "Push-уведомления на Android", "Офлайн-режим заказов",
                   "Краш при повороте экрана", "Онбординг в три шага"],
    "infra": ["Terraform: вынести сети в модуль", "Алерты на задержку очереди", "Обновить ноды кластера"],
    "docs-site": ["Раздел «Быстрый старт»", "Поиск по документации", "Генерация справки по API"],
    "ml-ranker": ["Фичи для ранжирования", "Сравнить две модели на A/B", "Ускорить батч-инференс"],
}
PROJECT_WEIGHT = {"storefront": 5, "billing-api": 4, "mobile-app": 4, "infra": 2, "docs-site": 1.5, "ml-ranker": 2}
MAIN_MODELS = [("claude-opus-5-5", 6), ("claude-sonnet-5-5", 3), ("claude-haiku-5-5", 1)]
SUBAGENTS = {
    "Explore": ("claude-haiku-5-5", ["Найти, где собирается корзина", "Где описаны роуты профиля", "Найти все вызовы платёжного клиента"]),
    "general-purpose": ("claude-sonnet-5-5", ["Разобраться в схеме миграций", "Собрать список зависимостей", "Проверить гипотезу с кэшем"]),
    "web-fetch": ("claude-haiku-5-5", ["Прочитать changelog библиотеки", "Документация Stripe по вебхукам", "Release notes Postgres 17"]),
    "code-reviewer": ("claude-sonnet-5-5", ["Ревью изменений в оплате", "Ревью миграции", "Проверить обработку ошибок"]),
}
SKILLS = ["frontend-design", "code-review", "xlsx", "pdf", "dataviz", "tdd"]
TOOLS = [("Bash", 30), ("Read", 22), ("Edit", 18), ("Grep", 10), ("Write", 6), ("Glob", 5), ("WebSearch", 2),
         ("TodoWrite", 3), ("mcp__github__create_pull_request", 1), ("mcp__playwright__browser_snapshot", 2)]


def pick(weighted):
    items, w = zip(*weighted)
    return rnd.choices(items, weights=w)[0]


def iso(t):
    return t.isoformat().replace("+00:00", "Z")


def mid():
    return "msg_" + "".join(rnd.choice("0123456789abcdefABCDEF") for _ in range(24))


class Session:
    def __init__(self, path, sid, cwd):
        self.f = open(path, "w", encoding="utf-8")
        self.sid, self.cwd, self.ctx = sid, cwd, rnd.randint(14000, 26000)

    def w(self, obj):
        obj.setdefault("sessionId", self.sid)
        self.f.write(json.dumps(obj, ensure_ascii=False) + "\n")

    def user(self, t, text):
        self.w({"type": "user", "cwd": self.cwd, "gitBranch": "main", "version": "2.1.300", "entrypoint": "cli",
                "timestamp": iso(t), "uuid": str(uuid.UUID(int=rnd.getrandbits(128))),
                "message": {"role": "user", "content": text}})

    def assistant(self, t, model, tools, extra_ctx, out=None, skill=None, agent_input=None):
        write = extra_ctx
        content = []
        for name in tools:
            inp = {}
            if name == "Skill":
                inp = {"skill": skill}
            if name == "Agent":
                inp = agent_input
            content.append({"type": "tool_use", "id": "toolu_" + uuid.UUID(int=rnd.getrandbits(128)).hex[:20], "name": name, "input": inp})
        out = out or int(rnd.lognormvariate(6.6, 0.8))
        usage = {"input_tokens": rnd.randint(2, 40), "output_tokens": out,
                 "cache_read_input_tokens": self.ctx, "cache_creation_input_tokens": write,
                 "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": write},
                 "output_tokens_details": {"thinking_tokens": int(out * rnd.uniform(0.1, 0.4))}}
        self.w({"type": "assistant", "timestamp": iso(t), "isSidechain": False,
                "message": {"id": mid(), "model": model, "role": "assistant", "content": content, "usage": usage}})
        self.ctx += write + out
        if self.ctx > 170000:  # автокомпакт
            self.ctx = rnd.randint(28000, 40000)


def subagent(folder, parent_sid, cwd, t, kind):
    model, descs = SUBAGENTS[kind]
    desc = rnd.choice(descs)
    aid = "agent-a" + uuid.UUID(int=rnd.getrandbits(128)).hex[:16]
    d = os.path.join(folder, parent_sid, "subagents")
    os.makedirs(d, exist_ok=True)
    json.dump({"agentType": kind, "description": desc, "spawnDepth": 1}, open(os.path.join(d, aid + ".meta.json"), "w"), ensure_ascii=False)
    s = Session(os.path.join(d, aid + ".jsonl"), parent_sid, cwd)
    s.ctx = rnd.randint(9000, 15000)
    s.user(t, desc)
    for _ in range(rnd.randint(3, 14)):
        t += timedelta(seconds=rnd.randint(3, 20))
        tools = [pick(TOOLS[:7])] if rnd.random() < 0.9 else []
        s.assistant(t, model, tools, rnd.randint(800, 6000), out=rnd.randint(80, 900))
    s.f.close()
    return t, {"subagent_type": kind, "description": desc}


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    names = list(PROJECTS)
    n_sessions = 0
    for day in range(DAYS, -1, -1):
        date = NOW - timedelta(days=day)
        weekday = date.weekday()
        count = rnd.choice([0, 1, 2, 2, 3]) if weekday < 5 else rnd.choice([0, 0, 1])
        # активность растёт к концу периода
        if day < 14 and rnd.random() < 0.6:
            count += 1
        for _ in range(count):
            proj = rnd.choices(names, weights=[PROJECT_WEIGHT[n] for n in names])[0]
            cwd = f"/home/dev/{proj}"
            folder = os.path.join(OUT, cwd.replace("/", "-"))
            os.makedirs(folder, exist_ok=True)
            sid = str(uuid.UUID(int=rnd.getrandbits(128)))
            hour = rnd.choices(range(24), weights=[1, 0.5, 0, 0, 0, 0, 0, 1, 3, 7, 9, 9, 6, 8, 9, 9, 8, 7, 5, 4, 5, 5, 4, 2])[0]
            t = date.replace(hour=hour, minute=rnd.randint(0, 59), second=rnd.randint(0, 59))
            if t > NOW:
                t = NOW - timedelta(hours=rnd.randint(1, 6))
            s = Session(os.path.join(folder, sid + ".jsonl"), sid, cwd)
            title = rnd.choice(PROJECTS[proj])
            s.w({"type": "custom-title", "customTitle": title})
            model = pick(MAIN_MODELS)
            for turn in range(rnd.randint(2, 9)):
                if turn and rnd.random() < 0.12:
                    model = pick(MAIN_MODELS)
                s.user(t, title if turn == 0 else rnd.choice(["Да, давай", "Теперь тесты", "Покажи дифф", "Почини ошибку из логов", "Сделай коммит"]))
                skill = rnd.choice(SKILLS) if rnd.random() < 0.18 else None
                steps = rnd.randint(3, 22)
                for i in range(steps):
                    t += timedelta(seconds=rnd.randint(4, 45))
                    if t > NOW:
                        break
                    if i == 0 and skill:
                        s.assistant(t, model, ["Skill"], rnd.randint(2000, 9000), out=rnd.randint(60, 200), skill=skill)
                        continue
                    if rnd.random() < 0.07:
                        kind = rnd.choices(list(SUBAGENTS), weights=[5, 3, 2, 2])[0]
                        t_end, inp = subagent(folder, sid, cwd, t, kind)
                        s.assistant(t, model, ["Agent"], rnd.randint(300, 1500), out=rnd.randint(100, 400), agent_input=inp)
                        t = t_end
                        continue
                    tools = [pick(TOOLS) for _ in range(rnd.choice([0, 1, 1, 1, 2]))] if i < steps - 1 else []
                    s.assistant(t, model, tools, rnd.randint(400, 7000))
                t += timedelta(minutes=rnd.randint(1, 25))
            s.f.close()
            n_sessions += 1
    print(f"{n_sessions} демо-сессий → {OUT}")


if __name__ == "__main__":
    main()
