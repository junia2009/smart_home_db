// compact.mjs の保持期間判定のテスト。実行: node --test scripts/

import test from "node:test";
import assert from "node:assert/strict";
import { isExpired } from "./compact.mjs";

test("境界: ちょうど keepMonths ヶ月前は期限切れ、1ヶ月手前は保持", () => {
  assert.equal(isExpired("2026-01.json", "2026-07", 6), true); // 6ヶ月前 → 退避
  assert.equal(isExpired("2026-02.json", "2026-07", 6), false); // 5ヶ月前 → 保持
  assert.equal(isExpired("2026-07.json", "2026-07", 6), false); // 当月 → 保持
});

test("電力ログ(power- プレフィックス)も同じ基準で判定する", () => {
  assert.equal(isExpired("power-2026-01.json", "2026-07", 6), true);
  assert.equal(isExpired("power-2026-02.json", "2026-07", 6), false);
});

test("年またぎ: 通算月で正しく差を計算する", () => {
  assert.equal(isExpired("2025-12.json", "2026-03", 6), false); // 3ヶ月前
  assert.equal(isExpired("2025-12.json", "2026-03", 3), true); // keep 3 なら期限切れ
  assert.equal(isExpired("2025-08.json", "2026-02", 6), true); // 6ヶ月前
});

test("月次データ以外のファイルは対象外", () => {
  for (const f of ["alert-state.json", "watchdog-state.json", ".gitkeep", "2026-07.json.bak"]) {
    assert.equal(isExpired(f, "2026-07", 6), false, f);
  }
});
