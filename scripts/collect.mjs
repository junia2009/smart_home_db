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
import { ALERT_RULES, buildMetrics, seasonOf } from "../alerts.mjs";

// 判定式はフロントと共通(alerts.mjs)。テスト互換のため再 export する
export { discomfortIndex, volumetricHumidity } from "../alerts.mjs";

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

// ---- 季節判定・アラート ----

// 引数の既定値は config.json 由来。テストからは明示的に渡して純関数として使える
function localDate(nowMs, tzHours = config.timezoneOffsetHours) {
  return new Date(nowMs + tzHours * 3600 * 1000);
}

export function currentSeason(
  nowMs,
  summerMonths = config.seasons.summerMonths,
  tzHours = config.timezoneOffsetHours
) {
  return seasonOf(localDate(nowMs, tzHours).getUTCMonth() + 1, summerMonths);
}

// th: そのモードの閾値オブジェクト(config.thresholds[season])
// prevLastNotified: { key: 最終通知UNIX秒 }、nowSec: 今回の記録時刻(秒)
// renotifyHours: 継続中アラートの再通知間隔(時間)。0 以下なら継続中の再通知は無効
// (「解消→再発生」時のみ通知)。
export function evaluateAlerts(
  metrics,
  th,
  prevActive,
  prevLastNotified = {},
  nowSec = Math.floor(Date.now() / 1000),
  renotifyHours = config.renotifyHours ?? 3
) {
  const interval = renotifyHours > 0 ? renotifyHours * 3600 : Infinity;
  const active = {};
  const lastNotified = {};
  const newMessages = [];
  const notifiedKeys = [];
  for (const rule of ALERT_RULES) {
    const firing = rule.test(metrics, th);
    active[rule.key] = firing;
    if (!firing) continue;

    const isNew = !prevActive[rule.key];                       // 解消→再発生
    const prevAt = prevLastNotified[rule.key];
    const owed = !isNew && prevAt == null;                     // 継続中なのに通知記録がない = 前回送信に失敗 → 再送
    const dueReminder = prevAt != null && nowSec - prevAt >= interval; // 継続中の再通知

    if (isNew || owed || dueReminder) {
      newMessages.push(rule.message(metrics));
      notifiedKeys.push(rule.key);
      lastNotified[rule.key] = nowSec;                          // 通知したので時刻更新
    } else {
      // 継続中で今回は通知しない: 最終通知時刻を引き継ぐ
      lastNotified[rule.key] = prevAt;
    }
  }
  return { active, lastNotified, newMessages, notifiedKeys };
}

// ---- 定時レポート ----

export function localDayKey(nowMs, tzHours = config.timezoneOffsetHours) {
  const d = localDate(nowMs, tzHours);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function buildDailyReport(records, metrics, active, title = config.reportTitle ?? "【環境レポート】") {
  const now = records[records.length - 1];
  const recent = records.filter((r) => r.t >= now.t - 86400);
  const tMin = Math.min(...recent.map((r) => r.temp));
  const tMax = Math.max(...recent.map((r) => r.temp));
  const hMin = Math.min(...recent.map((r) => r.hum));
  const hMax = Math.max(...recent.map((r) => r.hum));
  const firing = ALERT_RULES.filter((r) => active[r.key]).map((r) => r.shortLabel);
  return [
    title,
    `現在: ${now.temp.toFixed(1)}℃ / ${Math.round(now.hum)}%(不快指数${Math.round(metrics.di)})`,
    `過去24時間: 温度 ${tMin.toFixed(1)}〜${tMax.toFixed(1)}℃ / 湿度 ${Math.round(hMin)}〜${Math.round(hMax)}%`,
    firing.length > 0
      ? `⚠️ アラート発火中: ${firing.join("、")}`
      : `アラート: なし`,
  ].join("\n");
}

// ---- LINE 通知 ----

// LINE の月間メッセージ上限(無料プランの 200 通/月 など)超過は 429 + 本文で判別する。
// 一時的な失敗と違い、枠がリセットされる翌月まで再送しても無駄なので区別して扱う。
export function isMonthlyLimitError(status, body) {
  return status === 429 && /monthly limit/i.test(body ?? "");
}

export async function lineBroadcast(channelToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelToken}`,
    },
    body: JSON.stringify({ messages: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`LINE API HTTP ${res.status}: ${body}`);
    err.status = res.status;
    err.monthlyLimit = isMonthlyLimitError(res.status, body);
    throw err;
  }
}

// ---- データ保存 ----

export async function readJsonOr(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function monthFileName(nowMs, tzHours = config.timezoneOffsetHours) {
  const d = localDate(nowMs, tzHours);
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${ym}.json`;
}

// ローカル月の「前月内」を指す時刻(前月ファイル名の算出用)。
// 当月の日数 + 1 日戻せば、月末が31日でも必ず前月に入る
export function prevMonthMs(nowMs, tzHours = config.timezoneOffsetHours) {
  return nowMs - (localDate(nowMs, tzHours).getUTCDate() + 1) * 86400 * 1000;
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
  // lightLevel は 1〜20 の段階値でルクスではない(キー名 lux は旧データ互換のまま)
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

  // 外部スケジューラとフォールバック cron が近接して二重起動した場合の重複ガード
  const last = records[records.length - 1];
  if (last && record.t - last.t < 300) {
    console.log(`skip: last record is ${record.t - last.t}s old (< 300s)`);
    return;
  }

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
  const metrics = buildMetrics(temp, hum);
  const season = currentSeason(nowMs);
  const state = await readJsonOr(STATE_FILE, { active: {} });
  const prevActive = state.active ?? {};
  const prevLastNotified = state.lastNotified ?? {};
  const { active, lastNotified, newMessages, notifiedKeys } = evaluateAlerts(
    metrics, config.thresholds[season], prevActive, prevLastNotified, record.t
  );

  const ym = monthFileName(nowMs).slice(0, 7); // "YYYY-MM"(LINE の月間上限はローカル月単位)
  // 前回の実行で今月分の送信上限に達していれば、枠がリセットされる翌月まで送信を試みない。
  // state.lineLimitMonth が今月と一致する間だけブロックし、月が変われば自動的に解除される。
  let lineLimitMonth = state.lineLimitMonth === ym ? ym : null;

  // 通知できなかったときの後始末: 通知記録を取り消す。継続中アラートは次回 owed 扱いで再送される
  const rollbackNotified = () => {
    for (const key of notifiedKeys) {
      if (prevLastNotified[key] == null) delete lastNotified[key];
      else lastNotified[key] = prevLastNotified[key];
    }
  };

  if (newMessages.length === 0) {
    console.log(`alerts: none new (season=${season})`);
  } else {
    const title = config.alertTitle ?? "【環境アラート】";
    const text = `${title}\n` + newMessages.map((m) => `・${m}`).join("\n");
    console.log(`alerts: ${JSON.stringify(newMessages)}`);

    if (!LINE_CHANNEL_TOKEN) {
      console.warn("LINE_CHANNEL_TOKEN 未設定のため通知をスキップします");
    } else if (lineLimitMonth) {
      // 今月は既に送信上限に達している。再送しても 429 になるだけなので試みない。
      // 発火状態(active)は事実なので残し、通知記録だけ取り消して枠回復後に再送させる。
      console.warn(`LINE月間送信上限に到達済み(${ym})のため通知をスキップします`);
      rollbackNotified();
    } else {
      try {
        await lineBroadcast(LINE_CHANNEL_TOKEN, text);
        console.log("LINE broadcast sent");
      } catch (err) {
        // 通知失敗でも測定データの記録は保持する。発火状態(active)は事実なので
        // そのまま残し(ダッシュボードの表示を偽らない)、通知記録だけ取り消して
        // 次回実行で再送させる。
        console.error(`LINE通知に失敗: ${err.message}`);
        rollbackNotified();
        if (err.monthlyLimit) {
          // 月間上限は既知の外部要因。今月は以降の送信を止め、ジョブ自体は失敗させない
          // (毎回の実行が失敗し続けるのを防ぐ)。翌月に枠がリセットされれば自動再開する。
          lineLimitMonth = ym;
          console.warn(`月間送信上限のため今月(${ym})はLINE通知を停止します(翌月に自動再開)`);
        } else {
          // 一時的な失敗(通信・認証など)はジョブを失敗としてマークし、次回再送する
          process.exitCode = 1;
        }
      }
    }
  }

  // 定時レポート: 設定時刻以降の最初の実行で1日1回だけ送る
  let lastReport = state.lastReport ?? null;
  const todayKey = localDayKey(nowMs);
  if (
    config.dailyReport?.enabled &&
    LINE_CHANNEL_TOKEN &&
    !lineLimitMonth &&
    localDate(nowMs).getUTCHours() >= config.dailyReport.hour &&
    lastReport !== todayKey
  ) {
    // 月初はレポートの24時間レンジが前月ファイルにまたがるため、
    // 当月分だけで足りないときは前月分も読んで結合する
    let reportRecords = records;
    if (records[0].t > record.t - 86400) {
      const prev = await readJsonOr(path.join(DATA_DIR, monthFileName(prevMonthMs(nowMs))), []);
      reportRecords = prev.filter((r) => r.t >= record.t - 86400).concat(records);
    }
    try {
      await lineBroadcast(LINE_CHANNEL_TOKEN, buildDailyReport(reportRecords, metrics, active));
      lastReport = todayKey;
      console.log("daily report sent");
    } catch (err) {
      // 失敗しても記録は保持し、次回実行で再送を試みる
      console.error(`定時レポート送信に失敗: ${err.message}`);
      if (err.monthlyLimit) {
        lineLimitMonth = ym;
        console.warn(`月間送信上限のため今月(${ym})はLINE通知を停止します(翌月に自動再開)`);
      } else {
        process.exitCode = 1;
      }
    }
  }

  await writeFile(
    STATE_FILE,
    JSON.stringify({ active, lastNotified, lastReport, lineLimitMonth, updatedAt: record.t, season }, null, 2) + "\n"
  );
}

// テストから import できるよう、直接実行時のみ main を走らせる
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
