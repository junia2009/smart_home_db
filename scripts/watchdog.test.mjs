// watchdog.mjs の死活判定ロジックのテスト。実行: node --test scripts/

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWatchdog, formatAge } from "./watchdog.mjs";

const NOW = 1_750_000_000;
const MIN = 60;
const CFG = { staleMinutes: 120, renotifyHours: 6 };

test("新鮮なデータ: 何もしない", () => {
  const r = evaluateWatchdog(NOW - 15 * MIN, NOW, { alerting: false }, CFG);
  assert.deepEqual(r, { alerting: false, lastNotified: null, notify: null });
});

test("閾値ちょうどでは発火しない(> で判定)", () => {
  const r = evaluateWatchdog(NOW - 120 * MIN, NOW, { alerting: false }, CFG);
  assert.equal(r.notify, null);
  assert.equal(r.alerting, false);
});

test("新規に停止検知: stale 通知し lastNotified を記録", () => {
  const r = evaluateWatchdog(NOW - 121 * MIN, NOW, { alerting: false }, CFG);
  assert.deepEqual(r, { alerting: true, lastNotified: NOW, notify: "stale" });
});

test("停止継続(再通知間隔内): 通知せず lastNotified を引き継ぐ", () => {
  const prevAt = NOW - 3600; // 6時間未満
  const r = evaluateWatchdog(NOW - 300 * MIN, NOW, { alerting: true, lastNotified: prevAt }, CFG);
  assert.deepEqual(r, { alerting: true, lastNotified: prevAt, notify: null });
});

test("停止継続(再通知間隔経過): リマインド通知", () => {
  const prevAt = NOW - 6 * 3600;
  const r = evaluateWatchdog(NOW - 500 * MIN, NOW, { alerting: true, lastNotified: prevAt }, CFG);
  assert.deepEqual(r, { alerting: true, lastNotified: NOW, notify: "stale" });
});

test("renotifyHours が 0 以下: 継続中はリマインドしない", () => {
  const prevAt = NOW - 100 * 3600;
  const r = evaluateWatchdog(
    NOW - 500 * MIN,
    NOW,
    { alerting: true, lastNotified: prevAt },
    { staleMinutes: 120, renotifyHours: 0 }
  );
  assert.equal(r.notify, null);
  assert.equal(r.lastNotified, prevAt);
});

test("復旧: recovered を1回通知し状態をクリア", () => {
  const r = evaluateWatchdog(NOW - 15 * MIN, NOW, { alerting: true, lastNotified: NOW - 3600 }, CFG);
  assert.deepEqual(r, { alerting: false, lastNotified: null, notify: "recovered" });
});

test("旧状態に lastNotified が無い停止継続: 通知せず現在時刻を起点にする", () => {
  const r = evaluateWatchdog(NOW - 300 * MIN, NOW, { alerting: true }, CFG);
  assert.equal(r.notify, null);
  assert.equal(r.lastNotified, NOW);
});

test("formatAge: 分・時間の整形", () => {
  assert.equal(formatAge(45), "45分");
  assert.equal(formatAge(60), "1時間");
  assert.equal(formatAge(92), "1時間32分");
  assert.equal(formatAge(1500), "25時間");
});
