/* 環境ダッシュボード
 * data/YYYY-MM.json を fetch して現在値カードと温度・湿度の推移
 * (時間軸を共有した2段パネル)を Canvas で描画する。依存ライブラリなし。
 * ?demo=1 でサンプルデータ表示(開発・動作確認用)。
 */
"use strict";

const RANGES = {
  "24h": { hours: 24, label: "24時間" },
  "7d": { hours: 24 * 7, label: "7日" },
  "30d": { hours: 24 * 30, label: "30日" },
};
const MAX_PLOT_POINTS = 400; // これを超える場合は時間バケットで平均化

const state = {
  range: "24h",
  config: null,
  records: [], // 選択期間より広めに読み込んだ全レコード
  plot: [], // 描画用(期間フィルタ + バケット平均済み)
  hoverIndex: null,
  charts: [],
};

// ---- 計算指標(collect.mjs と同式) ----

function discomfortIndex(t, h) {
  return 0.81 * t + 0.01 * h * (0.99 * t - 14.3) + 46.3;
}
function volumetricHumidity(t, rh) {
  const e = 6.1078 * Math.pow(10, (7.5 * t) / (t + 237.3)) * (rh / 100);
  return (217 * e) / (t + 273.15);
}

function currentSeason(date, config) {
  return config.seasons.summerMonths.includes(date.getMonth() + 1) ? "summer" : "winter";
}

// ---- データ読み込み ----

function monthKeysBetween(startMs, endMs) {
  const keys = [];
  const d = new Date(startMs);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() <= endMs) {
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() + 1);
  }
  return keys;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function loadRecords() {
  if (new URLSearchParams(location.search).has("demo")) {
    return generateDemoData();
  }
  const now = Date.now();
  const start = now - RANGES["30d"].hours * 3600 * 1000;
  const keys = monthKeysBetween(start, now);
  const files = await Promise.all(keys.map((k) => fetchJson(`data/${k}.json`)));
  const records = files.filter(Boolean).flat();
  records.sort((a, b) => a.t - b.t);
  return records;
}

function generateDemoData() {
  const records = [];
  const now = Math.floor(Date.now() / 1000);
  const start = now - 30 * 24 * 3600;
  for (let t = start; t <= now; t += 900) {
    const dayPhase = ((t % 86400) / 86400) * 2 * Math.PI;
    const temp = 26 + 2.2 * Math.sin(dayPhase - Math.PI / 2) + Math.sin(t / 43210) * 1.2;
    const hum = 58 - 6 * Math.sin(dayPhase - Math.PI / 2) + Math.cos(t / 87131) * 5;
    const lux = Math.max(1, Math.round(10 + 9 * Math.sin(dayPhase - Math.PI / 2)));
    records.push({
      t,
      temp: Math.round(temp * 10) / 10,
      hum: Math.round(hum),
      lux,
    });
  }
  return records;
}

// 期間で絞り、点数が多すぎる場合は等間隔バケットの平均に集約する
function buildPlotData() {
  const now = Date.now() / 1000;
  const start = now - RANGES[state.range].hours * 3600;
  const rows = state.records.filter((r) => r.t >= start);
  if (rows.length <= MAX_PLOT_POINTS) return rows;

  const bucketSec = Math.ceil((RANGES[state.range].hours * 3600) / MAX_PLOT_POINTS);
  const buckets = new Map();
  for (const r of rows) {
    const key = Math.floor(r.t / bucketSec);
    let b = buckets.get(key);
    if (!b) {
      b = { t: 0, temp: 0, hum: 0, n: 0 };
      buckets.set(key, b);
    }
    b.t += r.t;
    b.temp += r.temp;
    b.hum += r.hum;
    b.n += 1;
  }
  return [...buckets.values()]
    .map((b) => ({
      t: Math.round(b.t / b.n),
      temp: Math.round((b.temp / b.n) * 10) / 10,
      hum: Math.round((b.hum / b.n) * 10) / 10,
    }))
    .sort((a, b) => a.t - b.t);
}

// ---- 現在値カード ----

const BADGES = {
  good: "✅ 適正",
  warn: "⚠️ 注意",
  crit: "🔴 警戒",
};

function judgeTemp(v, config, season) {
  const [lo, hi] = config.comfort.temp;
  const th = config.thresholds[season];
  if ((th.tempHigh != null && v > th.tempHigh) || (th.tempLow != null && v < th.tempLow)) return "crit";
  if (v < lo || v > hi) return "warn";
  return "good";
}
function judgeHum(v, config, season) {
  const [lo, hi] = config.comfort.hum;
  const th = config.thresholds[season];
  if ((th.humHigh != null && v > th.humHigh) || (th.humLow != null && v < th.humLow)) return "crit";
  if (v < lo || v > hi) return "warn";
  return "good";
}
function judgeDI(v) {
  if (v >= 80) return "crit";
  if (v >= 75) return "warn";
  return "good";
}
function judgeVH(v) {
  if (v < 7) return "crit";
  if (v < 10) return "warn";
  return "good";
}

function makeTile({ label, value, unit, badge }) {
  const tile = document.createElement("div");
  tile.className = "stat-tile";
  const labelEl = document.createElement("div");
  labelEl.className = "label";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.className = "value";
  valueEl.textContent = value;
  if (unit) {
    const unitEl = document.createElement("span");
    unitEl.className = "unit";
    unitEl.textContent = unit;
    valueEl.appendChild(unitEl);
  }
  tile.append(labelEl, valueEl);
  if (badge) {
    const badgeEl = document.createElement("div");
    badgeEl.className = "badge";
    badgeEl.textContent = BADGES[badge];
    tile.appendChild(badgeEl);
  }
  return tile;
}

function renderCards() {
  const container = document.getElementById("cards");
  container.replaceChildren();
  const latest = state.records[state.records.length - 1];
  if (!latest) return;

  const date = new Date(latest.t * 1000);
  const season = currentSeason(date, state.config);
  const di = discomfortIndex(latest.temp, latest.hum);
  const vh = volumetricHumidity(latest.temp, latest.hum);

  container.append(
    makeTile({ label: "温度", value: latest.temp.toFixed(1), unit: "℃", badge: judgeTemp(latest.temp, state.config, season) }),
    makeTile({ label: "湿度", value: String(Math.round(latest.hum)), unit: "%", badge: judgeHum(latest.hum, state.config, season) }),
    makeTile({ label: "照度", value: latest.lux != null ? String(latest.lux) : "–", unit: "/20" }),
    makeTile({ label: "不快指数", value: di.toFixed(1), badge: judgeDI(di) }),
    makeTile({ label: "絶対湿度", value: vh.toFixed(1), unit: "g/m³", badge: judgeVH(vh) })
  );

  document.getElementById("season-label").textContent =
    season === "summer" ? "夏モード" : "冬モード";
  document.getElementById("updated-at").textContent =
    `最終更新 ${formatDateTime(date)}(${formatAgo(date)})`;
}

function formatDateTime(d) {
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function formatAgo(d) {
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

// ---- チャート ----

function cssVar(name) {
  return getComputedStyle(document.querySelector(".viz-root")).getPropertyValue(name).trim();
}

function niceTicks(min, max, targetCount) {
  const span = max - min || 1;
  const rawStep = span / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let step = mag;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (mag * m >= rawStep) {
      step = mag * m;
      break;
    }
  }
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(Math.round(v * 100) / 100);
  return { lo, hi, ticks };
}

function timeTicks(startSec, endSec) {
  const spanH = (endSec - startSec) / 3600;
  let stepH, fmt;
  if (spanH <= 26) {
    stepH = 6;
    fmt = (d) => `${d.getHours()}:00`;
  } else if (spanH <= 24 * 8) {
    stepH = 24;
    fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  } else {
    stepH = 24 * 5;
    fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  }
  const ticks = [];
  const d = new Date(startSec * 1000);
  d.setMinutes(0, 0, 0);
  if (stepH >= 24) d.setHours(0);
  else d.setHours(Math.ceil(d.getHours() / stepH) * stepH);
  while (d.getTime() / 1000 <= endSec) {
    if (d.getTime() / 1000 >= startSec) ticks.push({ t: d.getTime() / 1000, label: fmt(d) });
    d.setTime(d.getTime() + stepH * 3600 * 1000);
  }
  return ticks;
}

class Panel {
  constructor(canvasId, opts) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext("2d");
    this.opts = opts; // { field, colorVar, comfort, showXLabels, decimals }
    this.pad = { left: 38, right: 44, top: 10, bottom: opts.showXLabels ? 22 : 8 };
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  xOf(t) {
    const { start, end } = this.domain;
    return this.pad.left + ((t - start) / (end - start || 1)) * (this.w - this.pad.left - this.pad.right);
  }
  yOf(v) {
    const { lo, hi } = this.yDomain;
    return this.pad.top + (1 - (v - lo) / (hi - lo || 1)) * (this.h - this.pad.top - this.pad.bottom);
  }

  draw(rows, hoverIndex) {
    this.resize();
    const { ctx, opts } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    if (rows.length === 0) return;

    const color = cssVar(opts.colorVar);
    const values = rows.map((r) => r[opts.field]);
    const now = Date.now() / 1000;
    this.domain = { start: now - RANGES[state.range].hours * 3600, end: now };

    let vMin = Math.min(...values, opts.comfort[0]);
    let vMax = Math.max(...values, opts.comfort[1]);
    const margin = (vMax - vMin) * 0.1 || 1;
    const { lo, hi, ticks } = niceTicks(vMin - margin, vMax + margin, 4);
    this.yDomain = { lo, hi };

    const plotRight = this.w - this.pad.right;

    // 推奨レンジ帯(系列色の薄い wash)
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = color;
    const bandTop = this.yOf(opts.comfort[1]);
    const bandBottom = this.yOf(opts.comfort[0]);
    ctx.fillRect(this.pad.left, bandTop, plotRight - this.pad.left, bandBottom - bandTop);
    ctx.restore();

    // グリッド(hairline)と Y 目盛
    ctx.strokeStyle = cssVar("--grid");
    ctx.lineWidth = 1;
    ctx.fillStyle = cssVar("--text-muted");
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const v of ticks) {
      const y = Math.round(this.yOf(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(this.pad.left, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      ctx.fillText(String(v), this.pad.left - 6, y);
    }

    // X 目盛
    const xt = timeTicks(this.domain.start, this.domain.end);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const tick of xt) {
      const x = Math.round(this.xOf(tick.t)) + 0.5;
      ctx.strokeStyle = cssVar("--grid");
      ctx.beginPath();
      ctx.moveTo(x, this.pad.top);
      ctx.lineTo(x, this.h - this.pad.bottom);
      ctx.stroke();
      if (opts.showXLabels) ctx.fillText(tick.label, x, this.h - this.pad.bottom + 6);
    }

    // ベースライン
    ctx.strokeStyle = cssVar("--baseline");
    ctx.beginPath();
    ctx.moveTo(this.pad.left, Math.round(this.h - this.pad.bottom) + 0.5);
    ctx.lineTo(plotRight, Math.round(this.h - this.pad.bottom) + 0.5);
    ctx.stroke();

    // データ線(2px, round join)
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    rows.forEach((r, i) => {
      const x = this.xOf(r.t);
      const y = this.yOf(r[opts.field]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // クロスヘア + ホバー点
    if (hoverIndex != null && rows[hoverIndex]) {
      const hx = this.xOf(rows[hoverIndex].t);
      ctx.strokeStyle = cssVar("--baseline");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(hx) + 0.5, this.pad.top);
      ctx.lineTo(Math.round(hx) + 0.5, this.h - this.pad.bottom);
      ctx.stroke();
      this.drawDot(hx, this.yOf(rows[hoverIndex][opts.field]), color);
    }

    // 終端ドット + 直近値の直接ラベル(選択的ラベル: 終端のみ)
    const last = rows[rows.length - 1];
    const lx = this.xOf(last.t);
    const ly = this.yOf(last[opts.field]);
    this.drawDot(lx, ly, color);
    ctx.fillStyle = cssVar("--text-primary");
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(last[opts.field].toFixed(opts.decimals), lx + 9, ly);
  }

  // 8px ドット + 2px surface ring
  drawDot(x, y, color) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = cssVar("--surface-1");
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function drawCharts() {
  for (const p of state.charts) p.draw(state.plot, state.hoverIndex);
}

// ---- ツールチップ(クロスヘアで X を拾い、両系列の値を1つに表示) ----

function setupHover() {
  const card = document.querySelector(".chart-card");
  const tooltip = document.getElementById("tooltip");

  function onMove(ev) {
    if (state.plot.length === 0) return;
    const panel = state.charts[0];
    const cardRect = card.getBoundingClientRect();
    const canvasRect = panel.canvas.getBoundingClientRect();
    const x = ev.clientX - canvasRect.left;

    // 最も近いデータ点にスナップ
    let best = 0;
    let bestDist = Infinity;
    state.plot.forEach((r, i) => {
      const d = Math.abs(panel.xOf(r.t) - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    if (state.hoverIndex !== best) {
      state.hoverIndex = best;
      drawCharts();
      renderTooltip(state.plot[best]);
    }
    tooltip.hidden = false;
    const px = ev.clientX - cardRect.left;
    const py = ev.clientY - cardRect.top;
    const flip = px > cardRect.width - 170;
    tooltip.style.left = `${flip ? px - tooltip.offsetWidth - 14 : px + 14}px`;
    tooltip.style.top = `${Math.max(6, py - tooltip.offsetHeight - 10)}px`;
  }

  function onLeave() {
    state.hoverIndex = null;
    tooltip.hidden = true;
    drawCharts();
  }

  card.addEventListener("pointermove", onMove);
  card.addEventListener("pointerleave", onLeave);
}

function renderTooltip(row) {
  const tooltip = document.getElementById("tooltip");
  tooltip.replaceChildren();
  const time = document.createElement("div");
  time.className = "tt-time";
  time.textContent = formatDateTime(new Date(row.t * 1000));
  tooltip.appendChild(time);
  const series = [
    { name: "温度", value: `${row.temp.toFixed(1)}℃`, colorVar: "--series-temp" },
    { name: "湿度", value: `${Math.round(row.hum)}%`, colorVar: "--series-hum" },
  ];
  for (const s of series) {
    const rowEl = document.createElement("div");
    rowEl.className = "tt-row";
    const key = document.createElement("span");
    key.className = "tt-key";
    key.style.background = cssVar(s.colorVar);
    const name = document.createElement("span");
    name.className = "tt-name";
    name.textContent = s.name;
    const value = document.createElement("span");
    value.className = "tt-value";
    value.textContent = s.value;
    rowEl.append(key, name, value);
    tooltip.appendChild(rowEl);
  }
}

// ---- データ表 ----

function renderTable() {
  const tbody = document.querySelector("#data-table tbody");
  tbody.replaceChildren();
  const rows = state.plot.slice(-48).reverse();
  for (const r of rows) {
    const tr = document.createElement("tr");
    const cells = [
      formatDateTime(new Date(r.t * 1000)),
      r.temp.toFixed(1),
      String(Math.round(r.hum)),
      r.lux != null ? String(r.lux) : "–",
      discomfortIndex(r.temp, r.hum).toFixed(1),
      volumetricHumidity(r.temp, r.hum).toFixed(1),
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

// ---- 期間フィルター ----

function setupRangeButtons() {
  const buttons = document.querySelectorAll(".range-btn");
  for (const btn of buttons) {
    btn.setAttribute("aria-pressed", String(btn.dataset.range === state.range));
    btn.addEventListener("click", () => {
      state.range = btn.dataset.range;
      for (const b of buttons) b.setAttribute("aria-pressed", String(b === btn));
      state.plot = buildPlotData();
      state.hoverIndex = null;
      drawCharts();
      renderTable();
    });
  }
}

// ---- 起動 ----

async function main() {
  state.config = (await fetchJson("config.json")) ?? {
    seasons: { summerMonths: [5, 6, 7, 8, 9, 10] },
    comfort: { temp: [20, 26], hum: [40, 60] },
    thresholds: {
      summer: { tempHigh: 28, tempLow: 22, humHigh: 65, humLow: null, diHigh: 80, vhLow: null },
      winter: { tempHigh: 26, tempLow: 18, humHigh: 60, humLow: 40, diHigh: null, vhLow: 7 },
    },
  };
  state.records = await loadRecords();

  if (state.records.length === 0) {
    document.getElementById("empty-state").hidden = false;
    document.getElementById("updated-at").textContent = "";
    return;
  }

  state.charts = [
    new Panel("chart-temp", {
      field: "temp",
      colorVar: "--series-temp",
      comfort: state.config.comfort.temp,
      showXLabels: false,
      decimals: 1,
    }),
    new Panel("chart-hum", {
      field: "hum",
      colorVar: "--series-hum",
      comfort: state.config.comfort.hum,
      showXLabels: true,
      decimals: 0,
    }),
  ];

  state.plot = buildPlotData();
  renderCards();
  drawCharts();
  renderTable();
  setupRangeButtons();
  setupHover();

  window.addEventListener("resize", drawCharts);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    drawCharts();
    renderCards();
  });
}

if ("serviceWorker" in navigator && !new URLSearchParams(location.search).has("demo")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

main();
