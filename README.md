# 環境ダッシュボード + アラート

SwitchBot HUB2 から室内環境データ(温度・湿度・照度)を15分間隔で自動記録し、
GitHub Pages のダッシュボードでグラフ表示。不適切な状態(暑すぎ・乾燥しすぎ等)を
検知したら LINE で通知する。サーバー費用ゼロ(GitHub Actions + GitHub Pages のみ)、
vanilla JS・依存ライブラリなし。

## 構成

```
GitHub Actions (cron 15分間隔) — .github/workflows/collect.yml
  ├─ SwitchBot API v1.1 から現在値を取得 (scripts/collect.mjs)
  ├─ data/YYYY-MM.json に追記してコミット
  └─ 閾値判定 → 新規アラートのみ LINE Messaging API で push 通知

GitHub Pages (静的サイト)
  └─ index.html + app.js が data/*.json を fetch してグラフ描画 (PWA)
```

## セットアップ

1. **SwitchBot トークンの取得**
   SwitchBot アプリ → プロフィール → 設定 → アプリバージョンを10回タップ
   → 開発者向けオプションで `token` / `secret` を取得。
2. **LINE Messaging API**
   LINE Developers で Messaging API チャネルを作成し、チャネルアクセストークンを取得。
   家族に公式アカウントを友だち追加してもらう(broadcast で全員に届く)。
3. **GitHub Secrets の登録**(Settings → Secrets and variables → Actions)

   | Secret | 内容 |
   |---|---|
   | `SWITCHBOT_TOKEN` | SwitchBot API トークン |
   | `SWITCHBOT_SECRET` | SwitchBot API シークレット |
   | `HUB2_DEVICE_ID` | (任意)HUB2 のデバイスID。未設定なら Hub 2 を自動検出 |
   | `LINE_CHANNEL_TOKEN` | LINE チャネルアクセストークン(未設定なら通知のみスキップ) |

4. **GitHub Pages の有効化**
   Settings → Pages → Branch: メインブランチ / root を選択。
5. **動作確認**
   Actions タブから `collect` を手動実行(workflow_dispatch)し、
   `data/` に月別 JSON がコミットされることを確認。

## アラート仕様

季節モード(夏: 5〜10月 / 冬: 11〜4月)で閾値を自動切替。
閾値・境界月・推奨レンジはすべて [`config.json`](config.json) で変更できる。

| 条件 | 夏モード | 冬モード | 通知文例 |
|---|---|---|---|
| 室温 上限 | > 28℃ | > 26℃ | 「室温28.5℃。エアコンの確認を」 |
| 室温 下限 | < 22℃ | < 18℃ | 「室温17.2℃。暖房の確認を」 |
| 湿度 上限 | > 65% | > 60% | 「湿度70%。カビ・あせも注意」 |
| 湿度 下限 | — | < 40% | 「湿度35%。加湿推奨」 |
| 不快指数 | ≥ 80 | — | 「不快指数82。熱中症注意」 |
| 絶対湿度 | — | < 7 g/m³ | 「乾燥しています(6.1g/m³)」 |

同一アラートは「解消 → 再発生」まで再送しない(状態は `data/alert-state.json` で管理)。

## ダッシュボード

- 現在値カード: 温度 / 湿度 / 照度 / 不快指数 / 絶対湿度 + 推奨レンジ判定バッジ
- 温度・湿度の推移グラフ(時間軸を共有した2段パネル、Canvas 自前描画)
  - 期間切替: 24時間 / 7日 / 30日
  - 推奨レンジを帯で背景表示、ホバー/タップで両系列の値をツールチップ表示
- PWA 対応(ホーム画面追加でアプリ的に起動、直近データをオフラインキャッシュ)
- ライト/ダークモード自動対応

### ローカルでの動作確認

```sh
python3 -m http.server 8000
# http://localhost:8000/?demo=1 でサンプルデータ表示
```

収集スクリプトのロジック(署名生成・アラート判定)は `scripts/collect.mjs` に
まとまっており、Node 20+ で単体実行できる。

## データ形式

`data/YYYY-MM.json`(月別、1レコード1行):

```json
[
  { "t": 1751770800, "temp": 27.3, "hum": 62, "lux": 14 }
]
```

`t` は UNIX 秒。月の区切りは JST(`config.json` の `timezoneOffsetHours`)。
デバイスIDはコード・データに含めない(Secrets のみ)。
