#!/usr/bin/env node
// GitHub Actions の schedule トリガーが予定時刻からどれだけ遅れて起動したかを集計する。
//
// schedule イベントのペイロードには「予定時刻」が入らないため、cron 式から
// 予定時刻を復元し、Actions API の run.created_at (キューに積まれた時刻) と比較する。
//
//   使い方: GITHUB_TOKEN=ghp_xxx node scripts/analyze-cron-delay.mjs <owner/repo> <workflow.yml> <minute>
//   例:     GITHUB_TOKEN=... node scripts/analyze-cron-delay.mjs junia2009/smart_home_db watchdog.yml 23
//
// <minute> は毎時 cron ("<minute> * * * *") の分。毎時以外の cron には対応しない。

const [, , repo, workflow, minuteArg] = process.argv;
if (!repo || !workflow || minuteArg === undefined) {
  console.error("usage: node scripts/analyze-cron-delay.mjs <owner/repo> <workflow.yml> <minute>");
  process.exit(1);
}
const MINUTE = Number(minuteArg);
const token = process.env.GITHUB_TOKEN;

async function fetchAllRuns() {
  const runs = [];
  for (let page = 1; ; page++) {
    const url =
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}` +
      `/runs?event=schedule&per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    runs.push(...json.workflow_runs);
    if (json.workflow_runs.length === 0 || runs.length >= json.total_count) break;
  }
  return runs.map((r) => new Date(r.created_at).getTime()).sort((a, b) => a - b);
}

// 各実行の「直前の予定時刻」との差を遅延とする。
// 予定と実行を1対1に割り当てないので、どの回がスキップされたかの推定に依存しない。
// 代わりに 60 分を超える遅延は次のコマに吸収されるため、この値は下限になる。
function delaysOf(runs) {
  return runs.map((t) => {
    const d = new Date(t);
    let slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), MINUTE, 0);
    if (slot > t) slot -= 3600_000;
    return { slot, delay: (t - slot) / 1000 };
  });
}

const runs = await fetchAllRuns();
if (runs.length === 0) {
  console.error("schedule 起動の実行が見つかりません");
  process.exit(1);
}
const rows = delaysOf(runs);
const d = rows.map((r) => r.delay).sort((a, b) => a - b);
const q = (p) => d[Math.floor(d.length * p)];
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const fmt = (s) => `${s.toFixed(0)}s (${(s / 60).toFixed(1)}分)`;

// 予定回数は、最初の実行の直前のコマから最後の実行までを1時間刻みで数える
const first = rows[0].slot;
const last = runs[runs.length - 1];
let expected = 0;
for (let t = first; t <= last; t += 3600_000) expected++;

console.log(`対象      : ${repo} ${workflow} (cron "${MINUTE} * * * *")`);
console.log(`期間      : ${new Date(first).toISOString()} 〜 ${new Date(last).toISOString()}`);
console.log(`日数      : ${((last - first) / 86400_000).toFixed(2)}`);
console.log(`予定 E    : ${expected}`);
console.log(`実行 X    : ${runs.length}`);
console.log(`スキップ S: ${expected - runs.length} (${((1 - runs.length / expected) * 100).toFixed(1)}%)`);
console.log("");
console.log(`中央値    : ${fmt(q(0.5))}`);
console.log(`平均      : ${fmt(mean(d))}`);
console.log(`最小      : ${fmt(d[0])}`);
console.log(`最大      : ${fmt(d[d.length - 1])}`);
console.log(`P95       : ${fmt(q(0.95))}`);
console.log(`5分以内   : ${((d.filter((v) => v < 300).length / d.length) * 100).toFixed(1)}%`);
console.log(`30分超    : ${((d.filter((v) => v > 1800).length / d.length) * 100).toFixed(1)}%`);

console.log("\n--- histogram.csv (5分バケット) ---");
console.log("delay_min,count");
const bucket = {};
for (const v of d) {
  const b = Math.floor(v / 300) * 5;
  bucket[b] = (bucket[b] ?? 0) + 1;
}
for (const k of Object.keys(bucket).sort((a, b) => a - b)) console.log(`${k},${bucket[k]}`);

// 起動時刻の「分」の分布。予定との割り当てを一切仮定しないので、
// 遅延の推定方法に関わらず信頼できる。
console.log("\n--- start_minute.csv (5分バケット) ---");
console.log("minute,count");
const mb = {};
for (const t of runs) {
  const b = Math.floor(new Date(t).getUTCMinutes() / 5) * 5;
  mb[b] = (mb[b] ?? 0) + 1;
}
for (let b = 0; b < 60; b += 5) console.log(`${b},${mb[b] ?? 0}`);

console.log("\n--- by_hour_utc.csv ---");
console.log("hour_utc,avg_delay_s,count");
const byHour = {};
for (const r of rows) (byHour[new Date(r.slot).getUTCHours()] ??= []).push(r.delay);
for (let h = 0; h < 24; h++) {
  const a = byHour[h];
  if (!a) continue;
  console.log(`${h},${mean(a).toFixed(1)},${a.length}`);
}
