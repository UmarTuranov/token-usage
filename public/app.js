"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = {
  range: 30,
  metric: "total",
  split: "model",
  f: { project: "", model: "", agent: "", skill: "" },
  sort: { key: "v", asc: false },
  search: "",
  sessionLimit: 40,
  expanded: {},
};

let DATA = null, MSGS = [], SESS = {}, COLORS = {};

const METRICS = {
  total: { short: "токены", label: "Все токены", get: (m) => m.total },
  fresh: { short: "без кэша", label: "Без чтения кэша", get: (m) => m.fresh },
  out: { short: "выход", label: "Выход", get: (m) => m.out },
  cost: { short: "стоимость", label: "Стоимость", get: (m) => m.cost },
};
const KINDS = [
  { k: "in", label: "Вход", color: "var(--k-in)" },
  { k: "w", label: "Запись в кэш", color: "var(--k-w)" },
  { k: "cr", label: "Чтение из кэша", color: "var(--k-cr)" },
  { k: "out", label: "Выход", color: "var(--k-out)" },
];
const PALETTE = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c7)"];
const OTHER = "var(--c6)";

/* ---------- format ---------- */
const nf = (d) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: d });
function fmtTok(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return nf(2).format(n / 1e9) + " млрд";
  if (a >= 1e6) return nf(1).format(n / 1e6) + " млн";
  if (a >= 1e4) return nf(0).format(n / 1e3) + " тыс";
  if (a >= 1e3) return nf(1).format(n / 1e3) + " тыс";
  return nf(0).format(n);
}
function fmtCost(n) {
  if (n >= 1000) return "$" + nf(0).format(n);
  if (n >= 10) return "$" + nf(1).format(n);
  return "$" + nf(2).format(n);
}
const fmtV = (v) => (state.metric === "cost" ? fmtCost(v) : fmtTok(v));
const fmtInt = (n) => nf(0).format(n);
const pct = (a, b) => (b ? nf(a / b < 0.1 ? 1 : 0).format((a / b) * 100) + "%" : "—");
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
function fmtDate(d, withTime = true) {
  const s = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return withTime ? `${s}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : s;
}
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1 мин";
  if (m < 60) return m + " мин";
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч ${m % 60 ? (m % 60) + " мин" : ""}`.trim();
  return Math.round(h / 24) + " дн";
}
const shortModel = (m) => m.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1");
const agentLabel = (a) => (a === "main" ? "main" : a);
const skillLabel = (s) => s ?? "без скилла";

/* ---------- data prep ---------- */
function prep(data) {
  DATA = data;
  const P = data.prices || {};
  const mult = P.multipliers || { cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 };
  const models = P.models || {};
  SESS = {};
  for (const s of data.sessions) SESS[s.id] = s;
  MSGS = data.messages.map((m) => {
    const d = new Date(m.ts);
    const p = models[m.model] || models.default || { input: 3, output: 15 };
    const w = m.w5 + m.w1;
    const s = SESS[m.sid] || {};
    return {
      ...m,
      d, t: d.getTime(), day: dayKey(d), hour: d.getHours(), wd: (d.getDay() + 6) % 7,
      w,
      total: m.in + m.out + m.cr + w,
      fresh: m.in + m.out + w,
      cost: (m.in * p.input + m.cr * p.input * mult.cacheRead + m.w5 * p.input * mult.cacheWrite5m +
             m.w1 * p.input * mult.cacheWrite1h + m.out * p.output) / 1e6,
      project: s.project || "—",
    };
  }).sort((a, b) => a.t - b.t);

  // стабильные цвета: по рангу за всё время
  COLORS = {};
  for (const dim of ["model", "agent", "project", "skill"]) {
    const agg = {};
    for (const m of MSGS) agg[m[dim] ?? ""] = (agg[m[dim] ?? ""] || 0) + m.total;
    const keys = Object.keys(agg).sort((a, b) => agg[b] - agg[a]);
    COLORS[dim] = {};
    keys.forEach((k, i) => (COLORS[dim][k] = i < PALETTE.length ? PALETTE[i] : OTHER));
  }
  $("#source").textContent = `Claude Code · обновлено ${fmtDate(new Date(data.generatedAt))}`;
  $("#src2").textContent = data.source;
  fillSelects();
}
const colorOf = (dim, k) => (COLORS[dim] && COLORS[dim][k ?? ""]) || OTHER;

function fillSelects() {
  const dims = { project: "Все проекты", model: "Все модели", agent: "Все агенты", skill: "Все скиллы" };
  for (const [dim, all] of Object.entries(dims)) {
    const agg = {};
    for (const m of MSGS) agg[m[dim] ?? "__none"] = (agg[m[dim] ?? "__none"] || 0) + m.total;
    const keys = Object.keys(agg).sort((a, b) => agg[b] - agg[a]);
    const sel = $("#f-" + dim);
    const lab = (k) => (k === "__none" ? "без скилла" : dim === "model" ? shortModel(k) : k);
    sel.innerHTML = `<option value="">${all}</option>` +
      keys.map((k) => `<option value="${esc(k)}">${esc(lab(k))}</option>`).join("");
    sel.value = state.f[dim];
    sel.classList.toggle("active", !!state.f[dim]);
  }
}

function inRange(m) {
  if (!state.range) return true;
  return m.t >= Date.now() - state.range * 864e5;
}
function matches(m, skip) {
  for (const [dim, v] of Object.entries(state.f)) {
    if (!v || dim === skip) continue;
    const mv = m[dim] ?? "__none";
    if (mv !== v) return false;
  }
  return true;
}
const filtered = () => MSGS.filter((m) => inRange(m) && matches(m));
const val = (m) => METRICS[state.metric].get(m);

function group(rows, keyFn) {
  const g = new Map();
  for (const m of rows) {
    const keys = keyFn(m);
    for (const [k, share] of Array.isArray(keys) ? keys : [[keys, 1]]) {
      let a = g.get(k);
      if (!a) g.set(k, (a = { k, v: 0, n: 0, total: 0, in: 0, w: 0, cr: 0, out: 0, cost: 0, sids: new Set(), calls: 0 }));
      a.v += val(m) * share; a.total += m.total * share; a.in += m.in * share; a.w += m.w * share;
      a.cr += m.cr * share; a.out += m.out * share; a.cost += m.cost * share; a.n += share; a.sids.add(m.sid);
    }
  }
  return [...g.values()].sort((a, b) => b.v - a.v);
}

/* ---------- tooltip ---------- */
const tip = $("#tip");
function showTip(e, html) {
  tip.innerHTML = html;
  tip.classList.add("on");
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideTip = () => tip.classList.remove("on");
const tipRow = (l, v, c) => `<div class="r"><span>${c ? `<i class="sw" style="background:${c}"></i>` : ""}${esc(l)}</span><span>${v}</span></div>`;

/* ---------- KPIs ---------- */
function renderKpis(rows) {
  const sum = (f) => rows.reduce((s, m) => s + f(m), 0);
  const total = sum((m) => m.total), fresh = sum((m) => m.fresh), out = sum((m) => m.out),
        think = sum((m) => m.think), cost = sum((m) => m.cost), cr = sum((m) => m.cr), inp = sum((m) => m.in + m.w);
  const sids = new Set(rows.map((m) => m.sid));
  const days = new Set(rows.map((m) => m.day)).size || 1;
  const items = [
    ["Всего токенов", fmtTok(total), `${fmtTok(total / days)} в активный день`],
    ["Без чтения кэша", fmtTok(fresh), `${pct(fresh, total)} от всех`],
    ["Выход", fmtTok(out), think ? `размышления ${pct(think, out)}` : "&nbsp;"],
    ["Стоимость, оценка", fmtCost(cost), `${fmtCost(cost / days)} в активный день`],
    ["Сессий", fmtInt(sids.size), `${days} активных дней`],
    ["Запросов к API", fmtInt(rows.length), `кэш покрывает ${pct(cr, cr + inp)} входа`],
  ];
  $("#kpis").innerHTML = items.map(([l, v, d]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
}

/* ---------- daily chart ---------- */
function seriesOf(m) {
  switch (state.split) {
    case "kind": return null;
    case "agent": return m.agent;
    case "project": return m.project;
    default: return m.model;
  }
}
function renderDaily(rows) {
  const el = $("#daily");
  const W = el.clientWidth || 900, H = 240, padL = 56, padB = 24, padT = 8;
  // дни
  let start;
  if (state.range) start = new Date(Date.now() - state.range * 864e5);
  else start = rows.length ? new Date(rows[0].t) : new Date();
  start.setHours(0, 0, 0, 0);
  const days = [];
  for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) days.push(dayKey(d));

  const byDay = new Map(days.map((k) => [k, { segs: {}, sum: 0, n: 0 }]));
  const kindVal = (m, k) => {
    if (state.metric === "out") return k === "out" ? m.out : 0;
    if (state.metric === "fresh" && k === "cr") return 0;
    const t = { in: m.in, w: m.w, cr: m.cr, out: m.out }[k];
    if (state.metric === "cost") return m.total ? (m.cost * t) / m.total : 0; // приближённо
    return t;
  };
  const seriesTotals = {};
  for (const m of rows) {
    const b = byDay.get(m.day); if (!b) continue;
    b.n++;
    if (state.split === "kind") {
      for (const { k } of KINDS) { const v = kindVal(m, k); b.segs[k] = (b.segs[k] || 0) + v; b.sum += v; seriesTotals[k] = (seriesTotals[k] || 0) + v; }
    } else {
      const s = seriesOf(m) ?? ""; const v = val(m);
      b.segs[s] = (b.segs[s] || 0) + v; b.sum += v; seriesTotals[s] = (seriesTotals[s] || 0) + v;
    }
  }
  const series = state.split === "kind"
    ? KINDS.filter((k) => seriesTotals[k.k]).map((k) => ({ k: k.k, label: k.label, color: k.color }))
    : Object.keys(seriesTotals).sort((a, b) => seriesTotals[b] - seriesTotals[a]).map((k) => ({
        k, label: state.split === "model" ? shortModel(k) : k, color: colorOf(state.split, k) }));

  const max = Math.max(1, ...[...byDay.values()].map((b) => b.sum));
  const nice = niceMax(max);
  const iw = W - padL, ih = H - padB - padT;
  const bw = iw / days.length;
  const gap = Math.min(4, bw * 0.25);
  let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}"><g class="grid">`;
  for (let i = 0; i <= 4; i++) {
    const y = padT + ih - (ih * i) / 4;
    svg += `<line x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/>`;
    svg += `</g><g class="axis"><text x="${padL - 8}" y="${y + 4}" text-anchor="end">${i ? fmtV((nice * i) / 4) : "0"}</text></g><g class="grid">`;
  }
  svg += `</g>`;
  const every = Math.ceil(days.length / Math.max(2, Math.floor(iw / 64)));
  days.forEach((k, i) => {
    const b = byDay.get(k), x = padL + i * bw;
    svg += `<g class="col" data-day="${k}"><rect class="hit" x="${x}" y="${padT}" width="${bw}" height="${ih}"/>`;
    let y = padT + ih;
    for (const s of [...series].reverse()) {
      const v = b.segs[s.k] || 0; if (!v) continue;
      const h = (v / nice) * ih; y -= h;
      svg += `<rect class="bar" x="${x + gap / 2}" y="${y}" width="${Math.max(1, bw - gap)}" height="${h}" fill="${s.color}"/>`;
    }
    svg += `</g>`;
    if (i % every === 0) {
      const [yy, mm, dd] = k.split("-");
      svg += `<g class="axis"><text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${+dd} ${MONTHS[+mm - 1]}</text></g>`;
    }
  });
  svg += `</svg>`;
  el.innerHTML = svg;
  el.querySelectorAll(".col").forEach((g) => {
    g.addEventListener("mousemove", (e) => {
      const k = g.dataset.day, b = byDay.get(k), [yy, mm, dd] = k.split("-");
      let h = `<b>${+dd} ${MONTHS[+mm - 1]} ${yy}</b>`;
      for (const s of series) if (b.segs[s.k]) h += tipRow(s.label, fmtV(b.segs[s.k]), s.color);
      h += `<div class="r" style="margin-top:4px;border-top:1px solid rgba(127,127,127,.3);padding-top:4px"><span>Итого · ${b.n} запр.</span><span>${fmtV(b.sum)}</span></div>`;
      showTip(e, h);
    });
    g.addEventListener("mouseleave", hideTip);
  });
  $("#daily-legend").innerHTML = series.slice(0, 12).map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)} <span class="num" style="color:var(--muted)">${fmtV(seriesTotals[s.k])}</span></span>`).join("");
}
function niceMax(v) {
  // максимум оси = 4 × «красивый» шаг, чтобы подписи были круглыми
  const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return 4 * m * p;
  return 40 * p;
}

/* ---------- composition ---------- */
function renderComposition(rows) {
  const s = { in: 0, w5: 0, w1: 0, cr: 0, out: 0, think: 0 };
  for (const m of rows) for (const k in s) s[k] += m[k];
  const tot = s.in + s.w5 + s.w1 + s.cr + s.out || 1;
  const parts = [
    ["in", "Вход без кэша", s.in, "var(--k-in)"],
    ["w", "Запись в кэш", s.w5 + s.w1, "var(--k-w)"],
    ["cr", "Чтение из кэша", s.cr, "var(--k-cr)"],
    ["out", "Выход", s.out, "var(--k-out)"],
  ];
  $("#composition").innerHTML =
    `<div class="comp-bar">${parts.map(([, , v, c]) => `<div style="width:${(v / tot) * 100}%;background:${c}"></div>`).join("")}</div>
     <div class="comp-rows">
       ${parts.map(([k, l, v, c]) => `<div><div class="l"><i class="sw" style="background:${c}"></i>${l}</div><div class="v">${fmtTok(v)}</div><div class="p">${pct(v, tot)}${k === "w" && (s.w5 || s.w1) ? ` · 1ч ${fmtTok(s.w1)} / 5м ${fmtTok(s.w5)}` : ""}</div></div>`).join("")}
       <div><div class="l">из выхода — размышления</div><div class="v">${fmtTok(s.think)}</div><div class="p">${pct(s.think, s.out)} выхода</div></div>
     </div>`;
}

/* ---------- breakdown tables ---------- */
function breakdown(el, groups, opts) {
  const { dim, label = (k) => k, color = () => OTHER, click = true, id, calls } = opts;
  if (!groups.length) { el.innerHTML = `<div class="empty">Нет данных за выбранный период</div>`; return; }
  const totalV = groups.reduce((s, g) => s + g.v, 0);
  const max = groups[0].v || 1;
  const lim = state.expanded[id] ? groups.length : 8;
  const sel = dim ? state.f[dim] : "";
  let h = `<table class="bd"><thead><tr><th>${esc(opts.title || "")}</th><th></th><th>${METRICS[state.metric].short}</th><th>доля</th><th>${calls ? "вызовов" : "запросов"}</th></tr></thead><tbody>`;
  for (const g of groups.slice(0, lim)) {
    const key = g.k ?? "__none";
    const kinds = state.metric === "total" || state.metric === "cost"
      ? [["in", g.in], ["w", g.w], ["cr", g.cr], ["out", g.out]]
      : state.metric === "fresh" ? [["in", g.in], ["w", g.w], ["out", g.out]] : [["out", g.out]];
    const ks = kinds.reduce((s, [, v]) => s + v, 0) || 1;
    const len = (g.v / max) * 100;
    h += `<tr data-k="${esc(key)}" class="${sel === key ? "sel" : ""}">
      <td class="name" title="${esc(label(g.k))}"><i class="sw" style="background:${color(g.k)}"></i>${esc(label(g.k))}</td>
      <td class="barc"><div class="mbar" style="width:${Math.max(len, 0.5)}%">${kinds.map(([k, v]) => `<div style="width:${(v / ks) * 100}%;background:var(--k-${k === "w" ? "w" : k})"></div>`).join("")}</div></td>
      <td class="n">${fmtV(g.v)}</td>
      <td class="n m">${pct(g.v, totalV)}</td>
      <td class="n m">${fmtInt(calls ? g.calls : g.n)}</td></tr>`;
  }
  h += `</tbody></table>`;
  if (groups.length > 8) h += `<button class="more" data-id="${id}">${state.expanded[id] ? "Свернуть" : `Показать все ${groups.length}`}</button>`;
  el.innerHTML = h;
  el.querySelectorAll("tbody tr").forEach((tr) => {
    const g = groups.find((x) => (x.k ?? "__none") === tr.dataset.k);
    tr.addEventListener("mousemove", (e) => showTip(e, `<b>${esc(label(g.k))}</b>` +
      tipRow("Вход", fmtTok(g.in), "var(--k-in)") + tipRow("Запись в кэш", fmtTok(g.w), "var(--k-w)") +
      tipRow("Чтение из кэша", fmtTok(g.cr), "var(--k-cr)") + tipRow("Выход", fmtTok(g.out), "var(--k-out)") +
      tipRow("Стоимость", fmtCost(g.cost)) + tipRow("Сессий", fmtInt(g.sids.size)) +
      (click && dim ? `<div class="r" style="opacity:.6;margin-top:4px"><span>нажмите, чтобы отфильтровать</span><span></span></div>` : "")));
    tr.addEventListener("mouseleave", hideTip);
    if (click && dim) tr.addEventListener("click", () => {
      hideTip();
      state.f[dim] = state.f[dim] === tr.dataset.k ? "" : tr.dataset.k;
      render();
    });
  });
  const more = el.querySelector(".more");
  if (more) more.addEventListener("click", () => { state.expanded[id] = !state.expanded[id]; opts.rerender(); });
}

function toolKeys(m) {
  if (!m.tools.length) return [["(только текст)", 1]];
  const c = {};
  for (const t of m.tools) c[t] = (c[t] || 0) + 1;
  return Object.entries(c).map(([t, n]) => [t, n / m.tools.length]);
}
function toolGroups(rows) {
  const g = group(rows, toolKeys);
  const calls = {};
  for (const m of rows) for (const t of m.tools) calls[t] = (calls[t] || 0) + 1;
  for (const x of g) x.calls = calls[x.k] || 0;
  return g;
}
function prettyTool(t) {
  if (!t.startsWith("mcp__")) return t;
  const [, srv, ...rest] = t.split("__");
  const name = srv.replace(/^ccd_/, "app ").replace(/^plugin_[^_]+_/, "").replace(/^Claude_/, "").replace(/^[0-9a-f]{8}-[0-9a-f-]{27}$/, "docs");
  return `${name} · ${rest.join("__")}`;
}

function renderTables(rows) {
  // для таблицы измерения не применяем фильтр по этому же измерению — чтобы видеть альтернативы
  const base = (dim) => MSGS.filter((m) => inRange(m) && matches(m, dim));
  const r = () => render();
  breakdown($("#t-model"), group(base("model"), (m) => m.model), { id: "model", dim: "model", title: "модель", label: shortModel, color: (k) => colorOf("model", k), rerender: r });
  breakdown($("#t-agent"), group(base("agent"), (m) => m.agent), { id: "agent", dim: "agent", title: "агент", label: agentLabel, color: (k) => colorOf("agent", k), rerender: r });
  breakdown($("#t-skill"), group(base("skill"), (m) => m.skill ?? "__none").map((g) => ({ ...g, k: g.k === "__none" ? null : g.k })), { id: "skill", dim: "skill", title: "скилл", label: skillLabel, color: (k) => (k ? colorOf("skill", k) : "var(--k-cr)"), rerender: r });
  breakdown($("#t-project"), group(base("project"), (m) => m.project), { id: "project", dim: "project", title: "проект", color: (k) => colorOf("project", k), rerender: r });
  breakdown($("#t-tool"), toolGroups(rows), { id: "tool", title: "инструмент", label: prettyTool, click: false, calls: true, color: () => "var(--c6)", rerender: r });
}

/* ---------- heatmap ---------- */
function renderHeat(rows) {
  const el = $("#heat");
  const W = el.clientWidth || 560, padL = 26, padT = 4, padB = 18;
  const cw = (W - padL) / 24, ch = Math.max(17, Math.min(24, cw)), H = padT + ch * 7 + padB;
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0)), cnt = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const m of rows) { grid[m.wd][m.hour] += val(m); cnt[m.wd][m.hour]++; }
  const max = Math.max(1, ...grid.flat());
  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}">`;
  for (let d = 0; d < 7; d++) {
    s += `<text x="0" y="${padT + d * ch + ch / 2 + 4}">${WD[d]}</text>`;
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h], o = v ? 0.12 + 0.88 * Math.sqrt(v / max) : 0;
      s += `<rect data-d="${d}" data-h="${h}" x="${padL + h * cw + 1}" y="${padT + d * ch + 1}" width="${cw - 2}" height="${ch - 2}" fill="${v ? "var(--accent)" : "var(--rule-2)"}" fill-opacity="${v ? o.toFixed(3) : 1}"/>`;
    }
  }
  for (let h = 0; h < 24; h += 3) s += `<text x="${padL + h * cw + cw / 2}" y="${H - 4}" text-anchor="middle">${pad(h)}</text>`;
  el.innerHTML = s + `</svg>`;
  el.querySelectorAll("rect").forEach((r) => {
    r.addEventListener("mousemove", (e) => { const d = +r.dataset.d, h = +r.dataset.h;
      showTip(e, `<b>${WD[d]}, ${pad(h)}:00–${pad(h)}:59</b>` + tipRow(METRICS[state.metric].label, fmtV(grid[d][h])) + tipRow("Запросов", fmtInt(cnt[d][h]))); });
    r.addEventListener("mouseleave", hideTip);
  });
}

/* ---------- sessions ---------- */
function sessionRows(rows) {
  const g = new Map();
  for (const m of rows) {
    let a = g.get(m.sid);
    if (!a) g.set(m.sid, (a = { sid: m.sid, v: 0, total: 0, cost: 0, out: 0, n: 0, t0: m.t, t1: m.t, models: {}, agents: {}, skills: new Set() }));
    a.v += val(m); a.total += m.total; a.cost += m.cost; a.out += m.out; a.n++;
    a.t0 = Math.min(a.t0, m.t); a.t1 = Math.max(a.t1, m.t);
    a.models[m.model] = (a.models[m.model] || 0) + m.total;
    if (m.agent !== "main") a.agents[m.agent] = (a.agents[m.agent] || 0) + 1;
    if (m.skill) a.skills.add(m.skill);
  }
  return [...g.values()];
}
const COLS = [
  ["title", "Сессия"], ["project", "Проект"], ["t0", "Начало"], ["dur", "Длит.", "n"], ["n", "Запросов", "n"],
  ["models", "Модели"], ["agents", "Субагенты и скиллы"], ["v", "Токены", "n"], ["cost", "$", "n"],
];
function renderSessions(rows) {
  let list = sessionRows(rows);
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((a) => { const s = SESS[a.sid] || {}; return [s.title, s.firstPrompt, s.project, s.branch].some((x) => x && x.toLowerCase().includes(q)); });
  const { key, asc } = state.sort;
  const kf = { title: (a) => (SESS[a.sid]?.title || "").toLowerCase(), project: (a) => SESS[a.sid]?.project || "", dur: (a) => a.t1 - a.t0 }[key] || ((a) => a[key]);
  list.sort((a, b) => { const x = kf(a), y = kf(b); return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1); });
  $("#s-count").textContent = list.length;
  const vLabel = state.metric === "cost" ? "Стоимость" : METRICS[state.metric].label;
  let h = `<thead><tr>${COLS.map(([k, l, c]) => `<th data-k="${k}" class="${c || ""} ${key === k ? "on" : ""} ${key === k && asc ? "asc" : ""}">${k === "v" ? vLabel : l}</th>`).join("")}</tr></thead><tbody>`;
  for (const a of list.slice(0, state.sessionLimit)) {
    const s = SESS[a.sid] || {};
    const models = Object.entries(a.models).sort((x, y) => y[1] - x[1]);
    const tags = Object.entries(a.agents).map(([t, n]) => `<span class="tag">${esc(t)} ×${n}</span>`).join("") +
      [...a.skills].map((sk) => `<span class="tag" style="border-style:dashed">${esc(sk)}</span>`).join("");
    h += `<tr data-sid="${a.sid}">
      <td><div class="ttl">${esc(s.title || "Без названия")}</div><div class="pr">${esc(s.firstPrompt || "")}</div></td>
      <td class="proj">${esc(s.project || "—")}</td>
      <td class="when">${fmtDate(new Date(a.t0))}</td>
      <td class="n">${fmtDur(a.t1 - a.t0)}</td>
      <td class="n">${fmtInt(a.n)}</td>
      <td class="dots" title="${esc(models.map(([m]) => shortModel(m)).join(", "))}">${models.map(([m]) => `<i class="sw" style="background:${colorOf("model", m)}"></i>`).join("")} <span style="color:var(--muted);font-size:12px">${esc(shortModel(models[0][0]))}</span></td>
      <td>${tags || `<span style="color:var(--muted)">—</span>`}</td>
      <td class="n">${fmtV(a.v)}</td>
      <td class="n">${fmtCost(a.cost)}</td></tr>`;
  }
  h += `</tbody>`;
  const tbl = $("#sessions");
  tbl.innerHTML = h;
  if (list.length > state.sessionLimit) {
    tbl.insertAdjacentHTML("beforeend", `<tfoot><tr><td colspan="9"><button class="more" id="s-more">Показать ещё (${list.length - state.sessionLimit})</button></td></tr></tfoot>`);
    $("#s-more").onclick = () => { state.sessionLimit += 60; render(); };
  }
  tbl.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k; if (k === "models" || k === "agents") return;
    state.sort = { key: k, asc: state.sort.key === k ? !state.sort.asc : k === "title" || k === "project" };
    render();
  }));
  tbl.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => openSession(tr.dataset.sid)));
}

/* ---------- session drawer ---------- */
function openSession(sid) {
  const s = SESS[sid] || {};
  const rows = MSGS.filter((m) => m.sid === sid);
  if (!rows.length) return;
  const sum = (f) => rows.reduce((a, m) => a + f(m), 0);
  const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
  const runs = new Map();
  for (const m of rows) if (m.agent !== "main") {
    const k = m.agent + "|" + (m.agentDesc || "");
    let r = runs.get(k); if (!r) runs.set(k, (r = { type: m.agent, desc: m.agentDesc, n: 0, total: 0, cost: 0, models: new Set() }));
    r.n++; r.total += m.total; r.cost += m.cost; r.models.add(m.model);
  }
  const b = $("#drawer-body");
  b.innerHTML = `
    <div class="dr-head"><div>
      <h3>${esc(s.title || "Без названия")}</h3>
      <div class="dr-meta">${esc(s.project || "")}${s.branch ? " · " + esc(s.branch) : ""} · ${fmtDate(new Date(t0))} → ${fmtDate(new Date(t1))} · ${fmtDur(t1 - t0)}${s.version ? " · v" + esc(s.version) : ""}</div>
    </div><button class="close" id="dr-close" aria-label="Закрыть">×</button></div>
    ${s.firstPrompt ? `<div class="dr-prompt">${esc(s.firstPrompt)}</div>` : ""}
    <div class="dr-kpis">
      <div class="kpi"><div class="l">Всего токенов</div><div class="v">${fmtTok(sum((m) => m.total))}</div><div class="d">без кэша ${fmtTok(sum((m) => m.fresh))}</div></div>
      <div class="kpi"><div class="l">Выход</div><div class="v">${fmtTok(sum((m) => m.out))}</div><div class="d">размышления ${fmtTok(sum((m) => m.think))}</div></div>
      <div class="kpi"><div class="l">Стоимость, оценка</div><div class="v">${fmtCost(sum((m) => m.cost))}</div><div class="d">&nbsp;</div></div>
      <div class="kpi"><div class="l">Запросов к API</div><div class="v">${fmtInt(rows.length)}</div><div class="d">${runs.size} запусков субагентов</div></div>
    </div>
    <div class="block"><div class="block-head"><h2>Каждый запрос по порядку</h2><span class="hint">высота — ${METRICS[state.metric].label.toLowerCase()}, цвет — агент</span></div><div id="dr-tl" class="chart"></div><div id="dr-tl-legend" class="legend"></div></div>
    ${runs.size ? `<div class="block"><div class="block-head"><h2>Запуски субагентов</h2></div><table class="runs"><tbody>${[...runs.values()].sort((a, b) => b.total - a.total).map((r) => `<tr><td><i class="sw" style="background:${colorOf("agent", r.type)}"></i>${esc(r.type)}</td><td class="d">${esc(r.desc || "")}<br><span style="font-size:12px">${[...r.models].map(shortModel).join(", ")}</span></td><td class="n">${fmtInt(r.n)} запр.</td><td class="n">${fmtTok(r.total)}</td><td class="n">${fmtCost(r.cost)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <div class="grid2">
      <div class="block"><div class="block-head"><h2>Модели</h2></div><div id="dr-model"></div></div>
      <div class="block"><div class="block-head"><h2>Агенты</h2></div><div id="dr-agent"></div></div>
      <div class="block"><div class="block-head"><h2>Скиллы</h2></div><div id="dr-skill"></div></div>
      <div class="block"><div class="block-head"><h2>Инструменты</h2></div><div id="dr-tool"></div></div>
    </div>`;
  $("#drawer").classList.add("on"); $("#scrim").classList.add("on");
  $("#dr-close").onclick = closeDrawer;
  const rr = () => openSession(sid);
  breakdown($("#dr-model"), group(rows, (m) => m.model), { id: "drm", title: "модель", label: shortModel, click: false, color: (k) => colorOf("model", k), rerender: rr });
  breakdown($("#dr-agent"), group(rows, (m) => m.agent), { id: "dra", title: "агент", label: agentLabel, click: false, color: (k) => colorOf("agent", k), rerender: rr });
  breakdown($("#dr-skill"), group(rows, (m) => m.skill ?? "__none").map((g) => ({ ...g, k: g.k === "__none" ? null : g.k })), { id: "drs", title: "скилл", label: skillLabel, click: false, color: (k) => (k ? colorOf("skill", k) : "var(--k-cr)"), rerender: rr });
  breakdown($("#dr-tool"), toolGroups(rows), { id: "drt", title: "инструмент", label: prettyTool, click: false, calls: true, color: () => "var(--c6)", rerender: rr });
  requestAnimationFrame(() => timeline(rows));
}
function timeline(rows) {
  const el = $("#dr-tl");
  const W = el.clientWidth || 780, H = 170, padL = 52, padB = 20, padT = 6, ih = H - padB - padT, iw = W - padL;
  const max = niceMax(Math.max(1, ...rows.map(val)));
  const bw = iw / rows.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}"><g class="grid">`;
  for (let i = 0; i <= 4; i += 2) { const y = padT + ih - (ih * i) / 4; s += `<line x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/></g><g class="axis"><text x="${padL - 8}" y="${y + 4}" text-anchor="end">${i ? fmtV((max * i) / 4) : "0"}</text></g><g class="grid">`; }
  s += `</g>`;
  // кумулятивная линия
  let cum = 0; const tot = rows.reduce((a, m) => a + val(m), 0) || 1; const pts = [];
  rows.forEach((m, i) => {
    const v = val(m), h = (v / max) * ih, x = padL + i * bw;
    s += `<g class="col" data-i="${i}"><rect class="hit" x="${x}" y="${padT}" width="${bw}" height="${ih}"/><rect class="bar" x="${x + (bw > 3 ? 0.5 : 0)}" y="${padT + ih - h}" width="${Math.max(0.6, bw - (bw > 3 ? 1 : 0))}" height="${h}" fill="${colorOf("agent", m.agent)}"/></g>`;
    cum += v; pts.push(`${(x + bw).toFixed(1)},${(padT + ih - (cum / tot) * ih).toFixed(1)}`);
  });
  s += `<polyline points="${padL},${padT + ih} ${pts.join(" ")}" fill="none" stroke="var(--accent)" stroke-width="1.25" stroke-dasharray="3 3" opacity=".8"/>`;
  s += `<g class="axis"><text x="${padL}" y="${H - 4}">${fmtDate(new Date(rows[0].t))}</text><text x="${W}" y="${H - 4}" text-anchor="end">${fmtDate(new Date(rows[rows.length - 1].t))}</text></g></svg>`;
  el.innerHTML = s;
  el.querySelectorAll(".col").forEach((g) => {
    const m = rows[+g.dataset.i];
    g.addEventListener("mousemove", (e) => showTip(e,
      `<b>#${+g.dataset.i + 1} · ${fmtDate(m.d)}:${pad(m.d.getSeconds())}</b>` +
      tipRow("Модель", esc(shortModel(m.model))) + tipRow("Агент", esc(m.agent)) + (m.skill ? tipRow("Скилл", esc(m.skill)) : "") +
      (m.tools.length ? tipRow("Инструменты", esc([...new Set(m.tools.map(prettyTool))].join(", ").slice(0, 60))) : "") +
      tipRow("Вход", fmtTok(m.in), "var(--k-in)") + tipRow("Запись в кэш", fmtTok(m.w), "var(--k-w)") +
      tipRow("Чтение из кэша", fmtTok(m.cr), "var(--k-cr)") + tipRow("Выход", fmtTok(m.out), "var(--k-out)") +
      (m.think ? tipRow("размышления", fmtTok(m.think)) : "") + tipRow("Стоимость", fmtCost(m.cost))));
    g.addEventListener("mouseleave", hideTip);
  });
  const agents = [...new Set(rows.map((m) => m.agent))];
  $("#dr-tl-legend").innerHTML = agents.map((a) => `<span><i style="background:${colorOf("agent", a)}"></i>${esc(a)}</span>`).join("") +
    `<span><i style="background:none;border-top:1.5px dashed var(--accent);height:0;border-radius:0;width:14px;vertical-align:3px"></i>накопительно</span>`;
}
function closeDrawer() { $("#drawer").classList.remove("on"); $("#scrim").classList.remove("on"); hideTip(); }

/* ---------- wiring ---------- */
function syncControls() {
  for (const [id, key] of [["#range", "range"], ["#metric", "metric"], ["#split", "split"]])
    $(id).querySelectorAll("button").forEach((b) => b.classList.toggle("on", String(state[key]) === b.dataset.v));
  for (const dim of Object.keys(state.f)) { const s = $("#f-" + dim); s.value = state.f[dim]; s.classList.toggle("active", !!state.f[dim]); }
  $("#sessions").closest(".block").querySelector("h2").firstChild.textContent = "Сессии ";
}
function render() {
  if (!DATA) return;
  syncControls();
  const rows = filtered();
  renderKpis(rows);
  renderDaily(rows);
  renderComposition(rows);
  renderTables(rows);
  renderHeat(rows);
  renderSessions(rows);
  try { localStorage.setItem("tu-state", JSON.stringify({ range: state.range, metric: state.metric, split: state.split })); } catch {}
}
function bindSeg(id, key, num) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state[key] = num ? +b.dataset.v : b.dataset.v; state.sessionLimit = 40; render();
  });
}
bindSeg("#range", "range", true);
bindSeg("#metric", "metric");
bindSeg("#split", "split");
for (const dim of ["project", "model", "agent", "skill"])
  $("#f-" + dim).addEventListener("change", (e) => { state.f[dim] = e.target.value; render(); });
$("#s-search").addEventListener("input", (e) => { state.search = e.target.value; state.sessionLimit = 40; renderSessions(filtered()); });
$("#scrim").addEventListener("click", closeDrawer);
addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 120); });
$("#reload").addEventListener("click", load);

async function load() {
  const btn = $("#reload"); btn.textContent = "Читаю логи…"; btn.disabled = true;
  try {
    const r = await fetch("/api/data");
    prep(await r.json());
    render();
  } catch (e) {
    $("#source").textContent = "Не удалось загрузить данные: " + e.message;
  } finally { btn.textContent = "Обновить"; btn.disabled = false; }
}
try { Object.assign(state, JSON.parse(localStorage.getItem("tu-state") || "{}")); } catch {}
load();
