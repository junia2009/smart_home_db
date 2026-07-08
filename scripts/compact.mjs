#!/usr/bin/env node
// 保持期間(config.retention.months、既定なし=無効)を過ぎた月次データファイルを
// 標準出力に列挙する(1行1ファイル名)。GitHub Releases への退避・削除・履歴の
// squash は compact.yml がこの出力を使って行う。ログは stderr へ出す。

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monthFileName } from "./collect.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");

const config = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));

// "YYYY-MM" → 通算月
function monthIndex(ym) {
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
}

// 月次データファイル(power- 含む)が currentYm から keepMonths ヶ月以上前なら true。
// 例: currentYm="2026-07", keepMonths=6 なら 2026-01 以前が期限切れ
// (残るのは 2026-02〜07 の6ヶ月)。月次データ以外のファイル名は常に false。
export function isExpired(fileName, currentYm, keepMonths) {
  const m = /^(?:power-)?(\d{4}-\d{2})\.json$/.exec(fileName);
  if (!m) return false;
  return monthIndex(currentYm) - monthIndex(m[1]) >= keepMonths;
}

async function main() {
  const months = config.retention?.months;
  if (!(months > 0)) {
    console.error("retention: 無効(config.retention.months が未設定または0以下)");
    return;
  }
  const currentYm = monthFileName(Date.now()).slice(0, 7);
  const files = await readdir(DATA_DIR);
  const expired = files.filter((f) => isExpired(f, currentYm, months)).sort();
  console.error(`retention: ${months}ヶ月保持(現在 ${currentYm})— 期限切れ ${expired.length} 件`);
  for (const f of expired) console.log(f);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
