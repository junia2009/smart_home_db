// アラート判定の共通定義(単一情報源)。
// collect.mjs(LINE通知)と app.js(バッジ・安全ゾーン帯・バナー)の両方が
// このモジュールを使うことで、「表示と通知は同一基準」をコードレベルで保証する。
// ブラウザからも Node からも読み込むため、依存なしの純粋な ES モジュールにする。

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

// 温湿度から派生指標までまとめた判定用メトリクス
export function buildMetrics(temp, hum) {
  return { temp, hum, di: discomfortIndex(temp, hum), vh: volumetricHumidity(temp, hum) };
}

// 月(1〜12)から季節モードを判定
export function seasonOf(month, summerMonths) {
  return summerMonths.includes(month) ? "summer" : "winter";
}

// 各アラートの定義。test は閾値が null のモードでは判定しない(仕様書 §6)。
// level はバッジ・バナーの深刻度、label は画面表示、shortLabel は定時レポート、
// message は LINE 通知の本文。
export const ALERT_RULES = [
  {
    key: "tempHigh",
    level: "crit",
    label: "室温が高い",
    shortLabel: "室温高",
    test: (m, th) => th.tempHigh != null && m.temp > th.tempHigh,
    message: (m) => `室温${m.temp.toFixed(1)}℃。エアコンの確認を`,
  },
  {
    key: "tempLow",
    level: "crit",
    label: "室温が低い",
    shortLabel: "室温低",
    test: (m, th) => th.tempLow != null && m.temp < th.tempLow,
    message: (m) => `室温${m.temp.toFixed(1)}℃。暖房の確認を`,
  },
  {
    key: "humHigh",
    level: "warn",
    label: "湿度が高い",
    shortLabel: "湿度高",
    // 湿度上限は「閾値に達したら」発火(≥)。温度上限(>)と違い境界を含む
    test: (m, th) => th.humHigh != null && m.hum >= th.humHigh,
    message: (m) => `湿度${Math.round(m.hum)}%。カビ・あせも注意`,
  },
  {
    key: "humLow",
    level: "warn",
    label: "湿度が低い",
    shortLabel: "湿度低",
    test: (m, th) => th.humLow != null && m.hum < th.humLow,
    message: (m) => `湿度${Math.round(m.hum)}%。加湿推奨`,
  },
  {
    key: "diHigh",
    level: "crit",
    label: "不快指数が高い",
    shortLabel: "不快指数",
    test: (m, th) => th.diHigh != null && m.di >= th.diHigh,
    message: (m) => `不快指数${Math.round(m.di)}。熱中症注意`,
  },
  {
    key: "vhLow",
    level: "warn",
    label: "乾燥している",
    shortLabel: "乾燥",
    test: (m, th) => th.vhLow != null && m.vh < th.vhLow,
    message: (m) => `乾燥しています(${m.vh.toFixed(1)}g/m³)`,
  },
];

export const RULES_BY_KEY = Object.fromEntries(ALERT_RULES.map((r) => [r.key, r]));

// その時点の発火状態 { key: bool }
export function evaluateActive(metrics, th) {
  return Object.fromEntries(ALERT_RULES.map((r) => [r.key, r.test(metrics, th)]));
}
