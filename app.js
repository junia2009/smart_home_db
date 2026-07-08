/* 環境ダッシュボード(ES モジュール)
 * data/YYYY-MM.json を fetch して現在値カードと温度・湿度の推移
 * (時間軸を共有した2段パネル)を Canvas で描画する。依存ライブラリなし。
 * アラート判定は collect.mjs と共通の alerts.mjs を使う(表示と通知の同一基準)。
 * ?demo=1 でサンプルデータ表示(開発・動作確認用)。
 */
import {
  discomfortIndex,
  volumetricHumidity,
  buildMetrics,
  seasonOf,
  ALERT_RULES,
  RULES_BY_KEY,
  evaluateActive,
} from "./alerts.mjs";

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
  power: [], // プラグ Mini の電力レコード(無ければ空)
  plot: [], // 描画用(期間フィルタ + バケット平均済み)
  hoverIndex: null,
  charts: [],
};

// 季節判定は config のタイムゾーン基準(データファイルの月区切りと同じ)
function tzHours() {
  return state.config?.timezoneOffsetHours ?? 9;
}

function currentSeason(date, config) {
  const month = new Date(date.getTime() + tzHours() * 3600 * 1000).getUTCMonth() + 1;
  return seasonOf(month, config.seasons.summerMonths);
}

// ---- データ読み込み ----

// 月キーはファイル名の月区切り(config のタイムゾーン)で計算する。
// ブラウザのローカル時刻を使うと、JST 以外の端末で月替わり直後に
// 最新ファイルを読み損ねる
function monthKeysBetween(startMs, endMs) {
  const shift = tzHours() * 3600 * 1000;
  const keys = [];
  const d = new Date(startMs + shift);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() <= endMs + shift) {
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
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

// ---- 消費電力(プラグ Mini、データがある場合のみ) ----

async function loadPowerRecords() {
  if (new URLSearchParams(location.search).has("demo")) {
    return generateDemoPower();
  }
  const now = Date.now();
  const start = now - RANGES["30d"].hours * 3600 * 1000;
  const keys = monthKeysBetween(start, now);
  const files = await Promise.all(keys.map((k) => fetchJson(`data/power-${k}.json`)));
  const records = files.filter(Boolean).flat();
  records.sort((a, b) => a.t - b.t);
  return records;
}

function generateDemoPower() {
  const records = [];
  const now = Math.floor(Date.now() / 1000);
  for (let t = now - 7 * 24 * 3600; t <= now; t += 900) {
    const hour = new Date(t * 1000).getHours();
    const on = hour >= 8 && hour < 23;
    const w = on ? 420 + Math.round(Math.sin(t / 5000) * 180) : 1.2;
    records.push({ t, plugs: [{ name: "エアコン", w, on }] });
  }
  return records;
}

function totalWatts(rec) {
  return rec.plugs.reduce((sum, p) => sum + (p.w || 0), 0);
}

// 電気代の表示: 少額(10円未満)は小数1桁で見せ、消費があるのに 0 円と
// 誤解されないようにする。ちょうど0のときだけ「0」。
function formatYen(yen) {
  if (yen === 0) return "0";
  if (yen < 10) return yen.toFixed(yen < 1 ? 2 : 1);
  return String(Math.round(yen));
}

// その日の電気代(円)。サンプル間隔を一定とみなさず、次の記録までの実時間で
// W を積分する(欠測で間隔が開いた区間は30分を上限に打ち切り、最終レコードは
// 標準間隔の15分とみなす)
function dayYen(records, dayKey) {
  const yenPerKwh = state.config.power?.yenPerKwh ?? 31;
  let wh = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const d = new Date(r.t * 1000);
    if (`${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` !== dayKey) continue;
    const next = records[i + 1];
    const dtSec = Math.min(next ? next.t - r.t : 900, 1800);
    wh += totalWatts(r) * (dtSec / 3600);
  }
  return (wh / 1000) * yenPerKwh;
}

function renderPowerTiles(container) {
  if (state.power.length === 0) return;
  const latest = state.power[state.power.length - 1];
  const now = new Date();
  const todayKey = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
  const yen = dayYen(state.power, todayKey);
  const row = document.createElement("div");
  row.className = "row-sm";
  row.append(
    makeTile({ label: "消費電力", value: String(Math.round(totalWatts(latest))), unit: "W", small: true }),
    makeTile({ label: "今日の電気代", value: formatYen(yen), unit: "円", small: true }),
    makeTile({
      label: "プラグ",
      value: latest.plugs.filter((p) => p.on).length + "/" + latest.plugs.length,
      unit: "ON",
      small: true,
    })
  );
  container.appendChild(row);
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

// ---- アラート状態バナー ----

// Actions がコミットする alert-state.json を読む。demo 時や取得失敗時は
// 最新値からクライアント側で同じ判定(alerts.mjs)を行う
async function loadAlertActive(latest) {
  if (!new URLSearchParams(location.search).has("demo")) {
    const alertState = await fetchJson("data/alert-state.json");
    if (alertState?.active) return alertState.active;
  }
  if (!latest) return {};
  const season = currentSeason(new Date(latest.t * 1000), state.config);
  return evaluateActive(buildMetrics(latest.temp, latest.hum), state.config.thresholds[season]);
}

const ACK_KEY = "alertSnooze";

// 発火中アラートの署名(種類の集合)。この署名が変われば別状態として再表示する
function alertSignature(firing) {
  return firing.slice().sort().join(",");
}

function renotifySec() {
  const h = state.config?.renotifyHours ?? 3;
  return h > 0 ? h * 3600 : Infinity;
}

// 解除(スヌーズ)記録の読み書き: { sig, until }(until は再表示するUNIX秒)
function readSnooze() {
  try { return JSON.parse(localStorage.getItem(ACK_KEY) || "null"); } catch { return null; }
}

function renderBanner(active) {
  const banner = document.getElementById("alert-banner");
  banner.hidden = false;
  banner.classList.remove("dismissing");
  banner.replaceChildren();
  const firing = ALERT_RULES.filter((r) => active[r.key]).map((r) => r.key);

  if (firing.length === 0) {
    // 全て適正に戻ったらスヌーズ記録をクリア(次の発火は必ず表示される)
    try { localStorage.removeItem(ACK_KEY); } catch {}
    banner.className = "alert-banner level-good";
    banner.textContent = "✅ すべて適正範囲です";
    return;
  }

  const signature = alertSignature(firing);
  const now = Date.now() / 1000;
  const snooze = readSnooze();
  // 同じ内容のアラートをスヌーズ中(期限内)なら非表示。期限切れ・署名変化で再表示。
  if (snooze && snooze.sig === signature && now < snooze.until) {
    banner.hidden = true;
    return;
  }

  const worst = firing.some((k) => RULES_BY_KEY[k].level === "crit") ? "crit" : "warn";
  banner.className = `alert-banner level-${worst}`;

  const head = document.createElement("span");
  head.className = "alert-head";
  head.textContent = `${worst === "crit" ? "🔴" : "⚠️"} アラート発火中: ${firing
    .map((k) => RULES_BY_KEY[k].label)
    .join("、")}`;

  const hours = state.config?.renotifyHours ?? 3;
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = `解除しても${hours}時間後に再表示します`;

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "alert-dismiss";
  dismiss.textContent = "解除";
  dismiss.addEventListener("click", () => {
    const until = Date.now() / 1000 + renotifySec();
    try { localStorage.setItem(ACK_KEY, JSON.stringify({ sig: signature, until })); } catch {}
    // フェードアウトしてから非表示に(即時反映)
    banner.classList.add("dismissing");
    setTimeout(() => {
      banner.hidden = true;
      banner.classList.remove("dismissing");
    }, 170);
  });

  banner.append(head, sub, dismiss);
}

// ---- 現在値カード ----

const BADGES = {
  good: "✅ 適正",
  warn: "⚠️ 注意",
  crit: "🔴 警戒",
};

// カードのバッジはアラートと同一基準(alerts.mjs の判定 + level)。
// 「バッジに色が付く ⟺ そのアラートが発火する条件」となり、表示と通知が常に一致する。
// keys: そのカードに関係するアラートキー(例: 温度なら tempHigh / tempLow)
function badgeLevel(active, keys) {
  let level = "good";
  for (const k of keys) {
    if (!active[k]) continue;
    if (RULES_BY_KEY[k].level === "crit") return "crit";
    level = "warn";
  }
  return level;
}

function makeTile({ label, value, unit, badge, spark, small }) {
  const tile = document.createElement("div");
  tile.className = small ? "stat-tile sm" : "stat-tile";
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
  if (badge || spark) {
    const foot = document.createElement("div");
    foot.className = "foot";
    if (badge) {
      const badgeEl = document.createElement("span");
      badgeEl.className = `badge b-${badge}`;
      badgeEl.textContent = BADGES[badge];
      foot.appendChild(badgeEl);
    }
    if (spark) {
      const canvas = document.createElement("canvas");
      canvas.className = "spark";
      foot.appendChild(canvas);
      // レイアウト確定後に描画
      requestAnimationFrame(() => drawSparkline(canvas, spark.values, spark.colorVar));
    }
    tile.appendChild(foot);
  }
  return tile;
}

// 12点スパークライン: 線は控えめなグレー、現在値のみ系列色のドット
function drawSparkline(canvas, values, colorVar) {
  if (values.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (i) => 2 + (i / (values.length - 1)) * (w - 8);
  const y = (v) => 3 + (1 - (v - min) / (max - min || 1)) * (h - 6);
  ctx.strokeStyle = cssVar("--text-muted");
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  values.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x(values.length - 1), y(values[values.length - 1]), 2.5, 0, Math.PI * 2);
  ctx.fillStyle = cssVar(colorVar);
  ctx.fill();
}

// 直近3時間(15分×12点)の推移
function sparkValues(field) {
  const rows = state.records.slice(-12);
  return rows.map((r) => r[field]);
}

function renderCards() {
  const container = document.getElementById("cards");
  container.replaceChildren();
  const latest = state.records[state.records.length - 1];
  if (!latest) return;

  const date = new Date(latest.t * 1000);
  const season = currentSeason(date, state.config);
  const metrics = buildMetrics(latest.temp, latest.hum);
  const active = evaluateActive(metrics, state.config.thresholds[season]);

  const rowLg = document.createElement("div");
  rowLg.className = "row-lg";
  rowLg.append(
    makeTile({
      label: "温度",
      value: latest.temp.toFixed(1),
      unit: "℃",
      badge: badgeLevel(active, ["tempHigh", "tempLow"]),
      spark: { values: sparkValues("temp"), colorVar: "--series-temp" },
    }),
    makeTile({
      label: "湿度",
      value: String(Math.round(latest.hum)),
      unit: "%",
      badge: badgeLevel(active, ["humHigh", "humLow"]),
      spark: { values: sparkValues("hum"), colorVar: "--series-hum" },
    })
  );

  const rowSm = document.createElement("div");
  rowSm.className = "row-sm";
  rowSm.append(
    // SwitchBot の lightLevel は 1〜20 の段階値(ルクスではない)
    makeTile({ label: "明るさ", value: latest.lux != null ? String(latest.lux) : "–", unit: "/20", small: true }),
    makeTile({ label: "不快指数", value: metrics.di.toFixed(1), badge: badgeLevel(active, ["diHigh"]), small: true }),
    makeTile({ label: "絶対湿度", value: metrics.vh.toFixed(1), unit: "g/m³", badge: badgeLevel(active, ["vhLow"]), small: true })
  );

  container.append(rowLg, rowSm);
  renderPowerTiles(container);

  document.getElementById("season-label").textContent =
    season === "summer" ? "夏モード" : "冬モード";

  // 死活監視(watchdog)と同じ staleMinutes 基準で、収集停止の可能性を表示する
  const ageMin = (Date.now() - date.getTime()) / 60000;
  const staleMin = state.config.watchdog?.staleMinutes ?? 120;
  const updatedEl = document.getElementById("updated-at");
  updatedEl.textContent = `最終更新 ${formatDateTime(date)}(${formatAgo(date)})`;
  updatedEl.classList.toggle("stale", ageMin > staleMin);
  if (ageMin > staleMin) updatedEl.textContent += " ⚠️ 収集が停止している可能性";
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
    this.opts = opts; // { field, colorVar, band:{low,high}, showXLabels, decimals }
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

    // アラートが出ない安全ゾーン(= バッジ・通知と同じ閾値)を帯で示す
    const band = opts.band;
    const extras = [band.low, band.high].filter((v) => v != null);
    let vMin = Math.min(...values, ...extras);
    let vMax = Math.max(...values, ...extras);
    const margin = (vMax - vMin) * 0.1 || 1;
    const { lo, hi, ticks } = niceTicks(vMin - margin, vMax + margin, 4);
    this.yDomain = { lo, hi };

    const plotRight = this.w - this.pad.right;

    // 安全ゾーン帯(系列色の薄い wash)。境界が null(その向きに閾値なし)なら
    // グラフ端まで伸ばす
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = color;
    const bandTop = band.high != null ? this.yOf(band.high) : this.pad.top;
    const bandBottom = band.low != null ? this.yOf(band.low) : this.h - this.pad.bottom;
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

    // データ線(2px, round join)+ HUD のネオングロー
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    rows.forEach((r, i) => {
      const x = this.xOf(r.t);
      const y = this.yOf(r[opts.field]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

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

    // 選択的な直接ラベル: 期間内の最高・最低(終端と重ならない場合のみ)
    let iMin = 0;
    let iMax = 0;
    rows.forEach((r, i) => {
      if (r[opts.field] < rows[iMin][opts.field]) iMin = i;
      if (r[opts.field] > rows[iMax][opts.field]) iMax = i;
    });
    if (iMax !== rows.length - 1 && rows[iMax][opts.field] !== rows[iMin][opts.field]) {
      this.drawExtremeLabel(rows[iMax], "above");
    }
    if (iMin !== rows.length - 1 && rows[iMax][opts.field] !== rows[iMin][opts.field]) {
      this.drawExtremeLabel(rows[iMin], "below");
    }

    // 終端ドット + 直近値の直接ラベル
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

  // 最高/最低値の小さなラベル(surface 色のハローで帯・線上でも読めるようにする)
  drawExtremeLabel(row, side) {
    const { ctx, opts } = this;
    const x = this.xOf(row.t);
    const y = this.yOf(row[opts.field]);
    const text = row[opts.field].toFixed(opts.decimals);
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = side === "above" ? "bottom" : "top";
    const ty = side === "above" ? y - 5 : y + 5;
    const tx = Math.min(Math.max(x, this.pad.left + 12), this.w - this.pad.right - 12);
    ctx.strokeStyle = cssVar("--surface-1");
    ctx.lineWidth = 3;
    ctx.strokeText(text, tx, ty);
    ctx.fillStyle = cssVar("--text-secondary");
    ctx.fillText(text, tx, ty);
  }

  // 8px ドット + 2px surface ring(+ HUD グロー)
  drawDot(x, y, color) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = cssVar("--surface-1");
    ctx.fill();
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
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

// ---- 日別サマリー ----

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function dailySummary(records) {
  const days = new Map();
  for (const r of records) {
    const d = new Date(r.t * 1000);
    const key = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    let day = days.get(key);
    if (!day) {
      day = { date: d, tMin: Infinity, tMax: -Infinity, tSum: 0, hMin: Infinity, hMax: -Infinity, hSum: 0, n: 0 };
      days.set(key, day);
    }
    day.tMin = Math.min(day.tMin, r.temp);
    day.tMax = Math.max(day.tMax, r.temp);
    day.tSum += r.temp;
    day.hMin = Math.min(day.hMin, r.hum);
    day.hMax = Math.max(day.hMax, r.hum);
    day.hSum += r.hum;
    day.n += 1;
  }
  return [...days.values()].sort((a, b) => b.date - a.date).slice(0, 14);
}

function renderDailySummary() {
  const section = document.getElementById("daily-summary");
  const days = dailySummary(state.records);
  if (days.length === 0) return;
  section.hidden = false;
  const hasPower = state.power.length > 0;
  if (hasPower && !section.querySelector("th.power-col")) {
    const th = document.createElement("th");
    th.className = "power-col";
    th.textContent = "電気代";
    section.querySelector("thead tr").appendChild(th);
  }
  const tbody = section.querySelector("tbody");
  tbody.replaceChildren();
  for (const day of days) {
    const tr = document.createElement("tr");
    const dayKey = `${day.date.getFullYear()}/${day.date.getMonth() + 1}/${day.date.getDate()}`;
    const cells = [
      `${day.date.getMonth() + 1}/${day.date.getDate()}(${WEEKDAYS[day.date.getDay()]})`,
      `${day.tMin.toFixed(1)} / ${(day.tSum / day.n).toFixed(1)} / ${day.tMax.toFixed(1)}`,
      `${Math.round(day.hMin)} / ${Math.round(day.hSum / day.n)} / ${Math.round(day.hMax)}`,
    ];
    if (hasPower) cells.push(`${formatYen(dayYen(state.power, dayKey))}円`);
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
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

// ---- データ更新 ----

// 最新の JSON を再取得して全面再描画する(初回ロードと更新ボタンで共用)
async function refreshData() {
  [state.records, state.power] = await Promise.all([loadRecords(), loadPowerRecords()]);
  state.lastFetch = Date.now();

  const empty = state.records.length === 0;
  document.getElementById("empty-state").hidden = !empty;
  if (empty) {
    document.getElementById("updated-at").textContent = "";
    return;
  }

  state.plot = buildPlotData();
  state.hoverIndex = null;
  state.alertActive = await loadAlertActive(state.records[state.records.length - 1]);
  renderBanner(state.alertActive);
  renderCards();
  drawCharts();
  renderDailySummary();
  renderTable();

  // アプリを開いたままでもスヌーズ期限が切れたらバナーを再表示する
  if (!state.snoozeTimer) {
    state.snoozeTimer = setInterval(() => {
      if (state.alertActive) renderBanner(state.alertActive);
    }, 60_000);
  }
}

function setupRefreshButton() {
  const btn = document.getElementById("refresh-btn");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      await refreshData();
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  });

  // PWA がバックグラウンドから復帰したとき、1分以上経っていれば自動更新
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - (state.lastFetch ?? 0) > 60_000) {
      refreshData();
    }
  });
}

// ---- 起動 ----

async function main() {
  state.config = (await fetchJson("config.json")) ?? {
    seasons: { summerMonths: [5, 6, 7, 8, 9, 10] },
    thresholds: {
      summer: { tempHigh: 28, tempLow: 22, humHigh: 75, humLow: null, diHigh: 80, vhLow: null },
      winter: { tempHigh: 26, tempLow: 18, humHigh: 60, humLow: 40, diHigh: null, vhLow: 7 },
    },
  };

  if (state.config.roomName) {
    const title = `${state.config.roomName}環境ダッシュボード`;
    document.getElementById("page-title").textContent = title;
    document.title = title;
  }

  // グラフの帯はアラート閾値(現在の季節)= バッジ・通知と同一基準
  const th = state.config.thresholds[currentSeason(new Date(), state.config)];
  state.charts = [
    new Panel("chart-temp", {
      field: "temp",
      colorVar: "--series-temp",
      band: { low: th.tempLow, high: th.tempHigh },
      showXLabels: false,
      decimals: 1,
    }),
    new Panel("chart-hum", {
      field: "hum",
      colorVar: "--series-hum",
      band: { low: th.humLow, high: th.humHigh },
      showXLabels: true,
      decimals: 0,
    }),
  ];

  setupRangeButtons();
  setupHover();
  setupRefreshButton();
  window.addEventListener("resize", drawCharts);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    drawCharts();
    renderCards();
  });

  await refreshData();
}

if ("serviceWorker" in navigator && !new URLSearchParams(location.search).has("demo")) {
  navigator.serviceWorker
    .register("sw.js", { updateViaCache: "none" })
    .then((reg) => {
      // PWA がフォアグラウンドに戻るたびに新しい SW が無いかチェックする
      // (iOS はプロセスが生きている間、自発的に更新チェックしないため)
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    })
    .catch(() => {});

  // 新しい SW がページの制御を握ったら一度だけリロードして最新シェルに切り替える
  let hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      // 初回インストール時(まだ旧バージョンは無い)はリロード不要
      hadController = true;
      return;
    }
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

main();
