// alerts.mjs(表示・通知共通の判定定義)のテスト。実行: node --test scripts/

import test from "node:test";
import assert from "node:assert/strict";
import { ALERT_RULES, RULES_BY_KEY, evaluateActive, buildMetrics, seasonOf } from "../alerts.mjs";

const TH = { tempHigh: 28, tempLow: 22, humHigh: 65, humLow: 40, diHigh: 80, vhLow: 7 };

test("全ルールが表示・通知に必要なメタデータを持つ", () => {
  assert.equal(ALERT_RULES.length, 6);
  for (const r of ALERT_RULES) {
    assert.equal(typeof r.key, "string");
    assert.ok(["crit", "warn"].includes(r.level), `${r.key}: level`);
    assert.equal(typeof r.label, "string");
    assert.equal(typeof r.shortLabel, "string");
    assert.equal(typeof r.test, "function");
    assert.equal(typeof r.message(buildMetrics(30, 70)), "string");
    assert.equal(RULES_BY_KEY[r.key], r);
  }
});

test("evaluateActive: 全キーの発火状態を返す", () => {
  const active = evaluateActive(buildMetrics(30, 70), TH);
  assert.equal(active.tempHigh, true);
  assert.equal(active.humHigh, true);
  assert.equal(active.tempLow, false);
  assert.equal(Object.keys(active).length, ALERT_RULES.length);
});

test("evaluateActive: 閾値 null のルールは発火しない", () => {
  const active = evaluateActive(buildMetrics(40, 20), { ...TH, tempHigh: null, humLow: null });
  assert.equal(active.tempHigh, false);
  assert.equal(active.humLow, false);
});

test("buildMetrics: 派生指標を含む", () => {
  const m = buildMetrics(25, 50);
  assert.equal(m.temp, 25);
  assert.equal(m.hum, 50);
  assert.ok(Math.abs(m.di - 71.775) < 0.001);
  assert.ok(m.vh > 11.4 && m.vh < 11.7);
});

test("seasonOf: 夏月リストに含まれるかで判定", () => {
  assert.equal(seasonOf(7, [5, 6, 7, 8, 9, 10]), "summer");
  assert.equal(seasonOf(1, [5, 6, 7, 8, 9, 10]), "winter");
});
