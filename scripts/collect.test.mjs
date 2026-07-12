// collect.mjs の純ロジックのテスト。実行: node --test scripts/
// 依存ライブラリなし(Node 20+ 標準の node:test)。
// config.json に依存しないよう、閾値・タイムゾーン等はすべて明示的に渡す。

import test from "node:test";
import assert from "node:assert/strict";
import {
  discomfortIndex,
  volumetricHumidity,
  currentSeason,
  evaluateAlerts,
  localDayKey,
  monthFileName,
  prevMonthMs,
  buildDailyReport,
} from "./collect.mjs";

// テスト用の閾値(全ルール有効)
const TH = { tempHigh: 28, tempLow: 22, humHigh: 65, humLow: 40, diHigh: 80, vhLow: 7 };
const OK = { temp: 25, hum: 50, di: 70, vh: 12 }; // どのルールにも掛からない値
const NOW = 1_750_000_000;
const HOUR = 3600;

// ---- 計算指標 ----

test("discomfortIndex: 25℃/50% ≈ 71.8", () => {
  assert.ok(Math.abs(discomfortIndex(25, 50) - 71.775) < 0.001);
});

test("volumetricHumidity: 25℃/50% ≈ 11.5 g/m³", () => {
  const vh = volumetricHumidity(25, 50);
  assert.ok(vh > 11.4 && vh < 11.7, `got ${vh}`);
});

// ---- 季節判定(タイムゾーン境界を含む) ----

test("currentSeason: 夏月・冬月の基本判定", () => {
  const summerMonths = [5, 6, 7, 8, 9, 10];
  assert.equal(currentSeason(Date.UTC(2026, 6, 15), summerMonths, 9), "summer"); // 7月
  assert.equal(currentSeason(Date.UTC(2026, 0, 15), summerMonths, 9), "winter"); // 1月
});

test("currentSeason: JST の月境界で切り替わる(UTC 4/30 20時 = JST 5/1 5時)", () => {
  const summerMonths = [5, 6, 7, 8, 9, 10];
  assert.equal(currentSeason(Date.UTC(2026, 3, 30, 20), summerMonths, 9), "summer");
  assert.equal(currentSeason(Date.UTC(2026, 3, 30, 10), summerMonths, 9), "winter");
});

// ---- 日付キー・月ファイル名(JST 基準) ----

test("monthFileName / localDayKey: JST で日・月をまたぐ", () => {
  const utc630 = Date.UTC(2026, 5, 30, 16); // JST 7/1 01:00
  assert.equal(monthFileName(utc630, 9), "2026-07.json");
  assert.equal(localDayKey(utc630, 9), "2026-07-01");
  const utc630b = Date.UTC(2026, 5, 30, 14); // JST 6/30 23:00
  assert.equal(monthFileName(utc630b, 9), "2026-06.json");
  assert.equal(localDayKey(utc630b, 9), "2026-06-30");
});

test("prevMonthMs: 月初でも月末でも必ず前月を指す", () => {
  // JST 7/1 01:00(UTC 6/30 16:00)→ 前月は 6 月
  assert.equal(monthFileName(prevMonthMs(Date.UTC(2026, 5, 30, 16), 9), 9), "2026-06.json");
  // JST 7/31(31日ある月の月末)→ 前月は 6 月
  assert.equal(monthFileName(prevMonthMs(Date.UTC(2026, 6, 31, 0), 9), 9), "2026-06.json");
  // 年またぎ: JST 1/1 → 前月は前年 12 月
  assert.equal(monthFileName(prevMonthMs(Date.UTC(2025, 11, 31, 16), 9), 9), "2025-12.json");
});

// ---- evaluateAlerts: 状態機械 ----

test("全て適正: 通知なし・active 全 false", () => {
  const r = evaluateAlerts(OK, TH, {}, {}, NOW, 3);
  assert.deepEqual(r.newMessages, []);
  assert.deepEqual(r.notifiedKeys, []);
  assert.ok(Object.values(r.active).every((v) => v === false));
  assert.deepEqual(r.lastNotified, {});
});

test("新規発火: 通知し lastNotified に現在時刻を記録", () => {
  const m = { ...OK, temp: 28.5 };
  const r = evaluateAlerts(m, TH, {}, {}, NOW, 3);
  assert.equal(r.active.tempHigh, true);
  assert.deepEqual(r.notifiedKeys, ["tempHigh"]);
  assert.deepEqual(r.newMessages, ["室温28.5℃。エアコンの確認を"]);
  assert.equal(r.lastNotified.tempHigh, NOW);
});

test("継続中(間隔内): 再通知せず lastNotified を引き継ぐ", () => {
  const m = { ...OK, temp: 28.5 };
  const prevAt = NOW - 1 * HOUR; // 3時間未満
  const r = evaluateAlerts(m, TH, { tempHigh: true }, { tempHigh: prevAt }, NOW, 3);
  assert.deepEqual(r.newMessages, []);
  assert.equal(r.active.tempHigh, true);
  assert.equal(r.lastNotified.tempHigh, prevAt);
});

test("継続中(間隔経過): リマインド通知し時刻を更新", () => {
  const m = { ...OK, temp: 28.5 };
  const prevAt = NOW - 3 * HOUR;
  const r = evaluateAlerts(m, TH, { tempHigh: true }, { tempHigh: prevAt }, NOW, 3);
  assert.deepEqual(r.notifiedKeys, ["tempHigh"]);
  assert.equal(r.lastNotified.tempHigh, NOW);
});

test("renotifyHours が 0 以下: 継続中は何時間経ってもリマインドしない", () => {
  const m = { ...OK, temp: 28.5 };
  const prevAt = NOW - 100 * HOUR;
  const r = evaluateAlerts(m, TH, { tempHigh: true }, { tempHigh: prevAt }, NOW, 0);
  assert.deepEqual(r.newMessages, []);
  assert.equal(r.lastNotified.tempHigh, prevAt);
});

test("解消: active が false になり lastNotified からも消える", () => {
  const r = evaluateAlerts(OK, TH, { tempHigh: true }, { tempHigh: NOW - HOUR }, NOW, 3);
  assert.equal(r.active.tempHigh, false);
  assert.equal("tempHigh" in r.lastNotified, false);
  assert.deepEqual(r.newMessages, []);
});

test("解消→再発生: 前回通知が直近でも新規として即通知する", () => {
  const m = { ...OK, temp: 28.5 };
  // prevActive=false(解消済み)だが lastNotified は5分前に残っているケース
  const r = evaluateAlerts(m, TH, { tempHigh: false }, { tempHigh: NOW - 300 }, NOW, 3);
  assert.deepEqual(r.notifiedKeys, ["tempHigh"]);
  assert.equal(r.lastNotified.tempHigh, NOW);
});

test("通知記録がない継続中アラート(前回送信失敗の状態): 再送する", () => {
  const m = { ...OK, temp: 28.5 };
  const r = evaluateAlerts(m, TH, { tempHigh: true }, {}, NOW, 3);
  assert.deepEqual(r.notifiedKeys, ["tempHigh"]);
  assert.equal(r.lastNotified.tempHigh, NOW);
});

test("閾値 null のルールは判定しない", () => {
  const th = { ...TH, tempHigh: null, diHigh: null };
  const m = { ...OK, temp: 40, di: 95 };
  const r = evaluateAlerts(m, th, {}, {}, NOW, 3);
  assert.equal(r.active.tempHigh, false);
  assert.equal(r.active.diHigh, false);
  assert.deepEqual(r.newMessages, []);
});

test("境界値: 温度はちょうど閾値では発火せず、湿度上限・不快指数は ≥ で発火する", () => {
  const atTemp = evaluateAlerts({ ...OK, temp: 28 }, TH, {}, {}, NOW, 3);
  assert.equal(atTemp.active.tempHigh, false);
  const atHum = evaluateAlerts({ ...OK, hum: 65 }, TH, {}, {}, NOW, 3);
  assert.equal(atHum.active.humHigh, true);
  const belowHum = evaluateAlerts({ ...OK, hum: 64 }, TH, {}, {}, NOW, 3);
  assert.equal(belowHum.active.humHigh, false);
  const atDi = evaluateAlerts({ ...OK, di: 80 }, TH, {}, {}, NOW, 3);
  assert.equal(atDi.active.diHigh, true);
});

test("複数同時発火: 1回の判定で全メッセージが揃う", () => {
  const m = { temp: 30, hum: 70, di: 82, vh: 12 };
  const r = evaluateAlerts(m, TH, {}, {}, NOW, 3);
  assert.deepEqual(r.notifiedKeys, ["tempHigh", "humHigh", "diHigh"]);
  assert.equal(r.newMessages.length, 3);
});

// ---- 定時レポート ----

test("buildDailyReport: 過去24時間のみでレンジを計算し、発火中アラートを列挙する", () => {
  const records = [
    { t: NOW - 30 * HOUR, temp: 10.0, hum: 10 }, // 24時間より前 → 除外されるべき
    { t: NOW - 20 * HOUR, temp: 24.0, hum: 55 },
    { t: NOW - 10 * HOUR, temp: 27.5, hum: 60 },
    { t: NOW, temp: 26.0, hum: 58 },
  ];
  const metrics = { di: 74.2 };
  const text = buildDailyReport(records, metrics, { humHigh: true }, "【テスト】");
  const lines = text.split("\n");
  assert.equal(lines[0], "【テスト】");
  assert.equal(lines[1], "現在: 26.0℃ / 58%(不快指数74)");
  assert.equal(lines[2], "過去24時間: 温度 24.0〜27.5℃ / 湿度 55〜60%");
  assert.equal(lines[3], "⚠️ アラート発火中: 湿度高");
});

test("buildDailyReport: アラートなしの行", () => {
  const records = [{ t: NOW, temp: 25.0, hum: 50 }];
  const text = buildDailyReport(records, { di: 70 }, {}, "【テスト】");
  assert.ok(text.endsWith("アラート: なし"));
});
