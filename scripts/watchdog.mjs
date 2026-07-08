#!/usr/bin/env node
// データ収集の死活監視。最終記録が config.watchdog.staleMinutes より古ければ
// LINE で「収集停止」を通知し、復旧したら「復旧」を1回通知する。
// 収集本体(外部スケジューラ → collect.yml)とは独立に、GitHub Actions の
// 毎時 cron から実行される。GitHub cron の遅延(±30分程度)はこの粒度なら許容。
//
// 必要な環境変数: LINE_CHANNEL_TOKEN(未設定なら通知をスキップ)

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lineBroadcast, readJsonOr, monthFileName } from "./collect.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "watchdog-state.json");

const config = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));

// 分を「X分」「X時間Y分」に整形
export function formatAge(min) {
  const m = Math.round(min);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}時間` : `${h}時間${rest}分`;
}

// 死活判定の純ロジック。prevState: { alerting, lastNotified }
// 戻り値の notify は "stale" | "recovered" | null
export function evaluateWatchdog(lastRecordT, nowSec, prevState, { staleMinutes, renotifyHours }) {
  const stale = nowSec - lastRecordT > staleMinutes * 60;
  const interval = renotifyHours > 0 ? renotifyHours * 3600 : Infinity;
  if (stale) {
    const isNew = !prevState.alerting;
    const prevAt = prevState.lastNotified;
    const dueReminder = prevAt != null && nowSec - prevAt >= interval;
    if (isNew || dueReminder) {
      return { alerting: true, lastNotified: nowSec, notify: "stale" };
    }
    return { alerting: true, lastNotified: prevAt ?? nowSec, notify: null };
  }
  if (prevState.alerting) {
    return { alerting: false, lastNotified: null, notify: "recovered" };
  }
  return { alerting: false, lastNotified: null, notify: null };
}

// 最新記録の UNIX 秒。当月ファイルが空・無しなら前月ファイルも見る(月初対策)
async function latestRecordTime(nowMs) {
  const tz = config.timezoneOffsetHours;
  const prevMonthMs = nowMs - (new Date(nowMs + tz * 3600 * 1000).getUTCDate() + 1) * 86400 * 1000;
  for (const ms of [nowMs, prevMonthMs]) {
    const records = await readJsonOr(path.join(DATA_DIR, monthFileName(ms)), []);
    if (records.length > 0) return records[records.length - 1].t;
  }
  return null;
}

async function main() {
  const wd = config.watchdog ?? {};
  if (wd.enabled === false) {
    console.log("watchdog: disabled by config");
    return;
  }
  const staleMinutes = wd.staleMinutes ?? 120;
  const renotifyHours = wd.renotifyHours ?? 6;
  const title = wd.title ?? `【${config.roomName ?? "環境ログ"} 死活監視】`;

  const nowSec = Math.floor(Date.now() / 1000);
  const lastT = await latestRecordTime(Date.now());
  if (lastT == null) {
    console.log("watchdog: まだ記録がありません(初期セットアップ中とみなしてスキップ)");
    return;
  }

  const ageMin = (nowSec - lastT) / 60;
  const prevState = await readJsonOr(STATE_FILE, { alerting: false });
  const next = evaluateWatchdog(lastT, nowSec, prevState, { staleMinutes, renotifyHours });
  console.log(`watchdog: last record ${formatAge(ageMin)}前 (threshold ${staleMinutes}分) -> ${next.notify ?? "no-op"}`);

  if (next.notify) {
    const text =
      next.notify === "stale"
        ? `${title}\n⚠️ データ収集が止まっています(最終記録: ${formatAge(ageMin)}前)\ncron-job.org と GitHub Actions の状態を確認してください`
        : `${title}\n✅ データ収集が復旧しました(最終記録: ${formatAge(ageMin)}前)`;
    if (!process.env.LINE_CHANNEL_TOKEN) {
      // 通知できないなら状態も進めない(トークン設定後の実行で改めて通知される)
      console.warn("LINE_CHANNEL_TOKEN 未設定のため通知をスキップします(状態は更新しない)");
      return;
    }
    try {
      await lineBroadcast(process.env.LINE_CHANNEL_TOKEN, text);
      console.log(`LINE broadcast sent (${next.notify})`);
    } catch (err) {
      // 送信失敗時は状態を進めず、次回の毎時実行で再送を試みる
      console.error(`LINE通知に失敗: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const serialized = JSON.stringify(
    { alerting: next.alerting, lastNotified: next.lastNotified, checkedAt: nowSec },
    null,
    2
  ) + "\n";
  // 変化がない毎時実行でコミットが積まれないよう、内容が変わるときだけ書く
  const current = await readFile(STATE_FILE, "utf8").catch(() => null);
  const changed =
    current == null ||
    (() => {
      try {
        const c = JSON.parse(current);
        return c.alerting !== next.alerting || (c.lastNotified ?? null) !== (next.lastNotified ?? null);
      } catch {
        return true;
      }
    })();
  if (changed) {
    await writeFile(STATE_FILE, serialized);
    console.log("watchdog: state updated");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
