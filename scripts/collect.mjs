#!/usr/bin/env node
// SwitchBot HUB2 の現在値を取得して data/YYYY-MM.json に追記し、
// 閾値超過時に LINE Messaging API で通知する。GitHub Actions から15分毎に実行される。
//
// 必要な環境変数:
//   SWITCHBOT_TOKEN, SWITCHBOT_SECRET, HUB2_DEVICE_ID
//   LINE_CHANNEL_TOKEN (未設定の場合は通知をスキップ)

import { createHmac, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "alert-state.json");

const config = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));

// ---- SwitchBot API v1.1 ----

function switchbotHeaders(token, secret) {
  const t = Date.now().toString();
  const nonce = randomUUID();
  const sign = createHmac("sha256", secret)
    .update(token + t + nonce)
    .digest("base64")
    .toUpperCase();
  return {
    Authorization: token,
    sign,
    t,
    nonce,
    "Content-Type": "application/json",
  };
}

async function switchbotGet(token, secret, path) {
  const res = await fetch(`https://api.switch-bot.com/v1.1${path}`, {
    headers: switchbotHeaders(token, secret),
  });
  if (!res.ok) {
    throw new Error(`SwitchBot API HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.statusCode !== 100) {
    throw new Error(`SwitchBot API error: statusCode=${json.statusCode} message=${json.message}`);
  }
  return json.body;
}

const fetchDeviceStatus = (token, secret, deviceId) =>
  switchbotGet(token, secret, `/devices/${deviceId}/status`);

const fetchDeviceList = (token, secret) =>
  switchbotGet(token, secret, "/devices").then((b) => b.deviceList ?? []);

// HUB2_DEVICE_ID 未設定時はデバイス一覧から Hub 2 を自動検出する
function findHub2(deviceList) {
  const hub = deviceList.find((d) => d.deviceType === "Hub 2");
  if (!hub) {
    throw new Error("デバイス一覧に Hub 2 が見つかりません。HUB2_DEVICE_ID を設定してください");
  }
  // ログにはフルIDを出さない(public リポジトリの Actions ログ対策)
  console.log(`Hub 2 auto-discovered: ${hub.deviceId.slice(0, 4)}…`);
  return hub.deviceId;
}

// プラグ Mini の現在消費電力を取得(1台も無ければ空配列)。
// デバイス名(アプリで設定した表示名)だけを記録し、IDは残さない
async function collectPlugs(token, secret, deviceList) {
  const plugs = [];
  for (const d of deviceList) {
    if (!/^Plug/.test(d.deviceType ?? "")) continue;
    try {
      const s = await fetchDeviceStatus(token, secret, d.deviceId);
      plugs.push({
        name: d.deviceName,
        w: Math.round(Number(s.weight ?? 0) * 10) / 10,
        on: s.power === "on",
      });
    } catch (err) {
      console.warn(`プラグ ${d.deviceName} の取得に失敗: ${err.message}`);
    }
  }
  return plugs;
}

// ---- 計算指標 ----

// 不快指数 DI = 0.81T + 0.01H(0.99T - 14.3) + 46.3
export function discomfortIndex(t, h) {
  return 0.81 * t + 0.01 * h * (0.99 * t - 14.3) + 46.3;
}

// 絶対湿度 VH (g/m³) = 217 × e / (T + 273.15)
// e = 6.1078 × 10^(7.5T / (T + 237.3)) × RH / 100
export function volumetricHumidity(t, rh) {
  const e = 6.1078 * Math.pow(10, (7.5 * t) / (t + 237.3)) * (rh / 100);
  return (217 * e) / (t + 273.15);
}

// ---- 季節判定・アラート ----

function localDate(nowMs) {
  return new Date(nowMs + config.timezoneOffsetHours * 3600 * 1000);
}

export function currentSeason(nowMs) {
  const month = localDate(nowMs).getUTCMonth() + 1;
  return config.seasons.summerMonths.includes(month) ? "summer" : "winter";
}

// 各アラートの判定関数。value が閾値を超えていれば通知メッセージを返す。
// 閾値が null のモードでは判定しない(仕様書 §6)。
const ALERT_RULES = [
  {
    key: "tempHigh",
    test: (m, th) => th.tempHigh != null && m.temp > th.tempHigh,
    message: (m) => `室温${m.temp.toFixed(1)}℃。エアコンの確認を`,
  },
  {
    key: "tempLow",
    test: (m, th) => th.tempLow != null && m.temp < th.tempLow,
    message: (m) => `室温${m.temp.toFixed(1)}℃。暖房の確認を`,
  },
  {
    key: "humHigh",
    test: (m, th) => th.humHigh != null && m.hum > th.humHigh,
    message: (m) => `湿度${Math.round(m.hum)}%。カビ・あせも注意`,
  },
  {
    key: "humLow",
    test: (m, th) => th.humLow != null && m.hum < th.humLow,
    message: (m) => `湿度${Math.round(m.hum)}%。加湿推奨`,
  },
  {
    key: "diHigh",
    test: (m, th) => th.diHigh != null && m.di >= th.diHigh,
    message: (m) => `不快指数${Math.round(m.di)}。熱中症注意`,
  },
  {
    key: "vhLow",
    test: (m, th) => th.vhLow != null && m.vh < th.vhLow,
    message: (m) => `乾燥しています(${m.vh.toFixed(1)}g/m³)`,
  },
];

export function evaluateAlerts(metrics, season, prevActive) {
  const th = config.thresholds[season];
  const active = {};
  const newMessages = [];
  for (const rule of ALERT_RULES) {
    const firing = rule.test(metrics, th);
    active[rule.key] = firing;
    // 「解消 → 再発生」まで再送しない: 前回も発火していたら通知しない
    if (firing && !prevActive[rule.key]) {
      newMessages.push(rule.message(metrics));
    }
  }
  return { active, newMessages };
}

// ---- 定時レポート ----

export function localDayKey(nowMs) {
  const d = localDate(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const ALERT_LABELS = {
  tempHigh: "室温高",
  tempLow: "室温低",
  humHigh: "湿度高",
  humLow: "湿度低",
  diHigh: "不快指数",
  vhLow: "乾燥",
};

export function buildDailyReport(records, metrics, active) {
  const now = records[records.length - 1];
  const recent = records.filter((r) => r.t >= now.t - 86400);
  const tMin = Math.min(...recent.map((r) => r.temp));
  const tMax = Math.max(...recent.map((r) => r.temp));
  const hMin = Math.min(...recent.map((r) => r.hum));
  const hMax = Math.max(...recent.map((r) => r.hum));
  const firing = Object.keys(ALERT_LABELS).filter((k) => active[k]);
  const title = config.reportTitle ?? "【環境レポート】";
  return [
    title,
    `現在: ${now.temp.toFixed(1)}℃ / ${Math.round(now.hum)}%(不快指数${Math.round(metrics.di)})`,
    `過去24時間: 温度 ${tMin.toFixed(1)}〜${tMax.toFixed(1)}℃ / 湿度 ${Math.round(hMin)}〜${Math.round(hMax)}%`,
    firing.length > 0
      ? `⚠️ アラート発火中: ${firing.map((k) => ALERT_LABELS[k]).join("、")}`
      : `アラート: なし`,
  ].join("\n");
}

// ---- LINE 通知 ----

async function lineBroadcast(channelToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelToken}`,
    },
    body: JSON.stringify({ messages: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    throw new Error(`LINE API HTTP ${res.status}: ${await res.text()}`);
  }
}

// ---- データ保存 ----

async function readJsonOr(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function monthFileName(nowMs) {
  const d = localDate(nowMs);
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${ym}.json`;
}

// 月別 JSON は1レコード1行で保持し、diff とファイルサイズを最小に保つ
function serializeRecords(records) {
  return "[\n" + records.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n";
}

// ---- main ----

async function main() {
  const { SWITCHBOT_TOKEN, SWITCHBOT_SECRET, HUB2_DEVICE_ID, LINE_CHANNEL_TOKEN } = process.env;
  if (!SWITCHBOT_TOKEN || !SWITCHBOT_SECRET) {
    console.error("SWITCHBOT_TOKEN / SWITCHBOT_SECRET を設定してください");
    process.exit(1);
  }

  const deviceList = await fetchDeviceList(SWITCHBOT_TOKEN, SWITCHBOT_SECRET);
  const deviceId = HUB2_DEVICE_ID || findHub2(deviceList);

  const nowMs = Date.now();
  const status = await fetchDeviceStatus(SWITCHBOT_TOKEN, SWITCHBOT_SECRET, deviceId);

  const temp = Number(status.temperature);
  const hum = Number(status.humidity);
  const lux = Number(status.lightLevel);
  if (!Number.isFinite(temp) || !Number.isFinite(hum)) {
    throw new Error(`不正な測定値: ${JSON.stringify(status)}`);
  }

  const record = {
    t: Math.floor(nowMs / 1000),
    temp,
    hum,
    lux: Number.isFinite(lux) ? lux : null,
  };

  await mkdir(DATA_DIR, { recursive: true });
  const monthFile = path.join(DATA_DIR, monthFileName(nowMs));
  const records = await readJsonOr(monthFile, []);
  records.push(record);
  await writeFile(monthFile, serializeRecords(records));
  console.log(`recorded: ${JSON.stringify(record)} -> ${path.basename(monthFile)}`);

  // プラグ Mini の消費電力ログ(デバイスがある場合のみ)
  const plugs = await collectPlugs(SWITCHBOT_TOKEN, SWITCHBOT_SECRET, deviceList);
  if (plugs.length > 0) {
    const powerFile = path.join(DATA_DIR, `power-${monthFileName(nowMs)}`);
    const powerRecords = await readJsonOr(powerFile, []);
    powerRecords.push({ t: record.t, plugs });
    await writeFile(powerFile, serializeRecords(powerRecords));
    console.log(`power: ${JSON.stringify(plugs)} -> ${path.basename(powerFile)}`);
  }

  // アラート判定
  const metrics = {
    temp,
    hum,
    di: discomfortIndex(temp, hum),
    vh: volumetricHumidity(temp, hum),
  };
  const season = currentSeason(nowMs);
  const state = await readJsonOr(STATE_FILE, { active: {} });
  const prevActive = state.active ?? {};
  const { active, newMessages } = evaluateAlerts(metrics, season, prevActive);

  if (newMessages.length === 0) {
    console.log(`alerts: none new (season=${season})`);
  } else {
    const title = config.alertTitle ?? "【環境アラート】";
    const text = `${title}\n` + newMessages.map((m) => `・${m}`).join("\n");
    console.log(`alerts: ${JSON.stringify(newMessages)}`);

    if (!LINE_CHANNEL_TOKEN) {
      console.warn("LINE_CHANNEL_TOKEN 未設定のため通知をスキップします");
    } else {
      try {
        await lineBroadcast(LINE_CHANNEL_TOKEN, text);
        console.log("LINE broadcast sent");
      } catch (err) {
        // 通知失敗でも測定データの記録は保持する。新規発火分を未発火扱いに
        // 戻して次回実行時に再送を試み、ジョブ自体は失敗としてマークする
        console.error(`LINE通知に失敗: ${err.message}`);
        for (const rule of ALERT_RULES) {
          if (active[rule.key] && !prevActive[rule.key]) active[rule.key] = false;
        }
        process.exitCode = 1;
      }
    }
  }

  // 定時レポート: 設定時刻以降の最初の実行で1日1回だけ送る
  let lastReport = state.lastReport ?? null;
  const todayKey = localDayKey(nowMs);
  if (
    config.dailyReport?.enabled &&
    LINE_CHANNEL_TOKEN &&
    localDate(nowMs).getUTCHours() >= config.dailyReport.hour &&
    lastReport !== todayKey
  ) {
    try {
      await lineBroadcast(LINE_CHANNEL_TOKEN, buildDailyReport(records, metrics, active));
      lastReport = todayKey;
      console.log("daily report sent");
    } catch (err) {
      // 失敗しても記録は保持し、次回実行で再送を試みる
      console.error(`定時レポート送信に失敗: ${err.message}`);
      process.exitCode = 1;
    }
  }

  await writeFile(
    STATE_FILE,
    JSON.stringify({ active, lastReport, updatedAt: record.t, season }, null, 2) + "\n"
  );
}

// テストから import できるよう、直接実行時のみ main を走らせる
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
