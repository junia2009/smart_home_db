# 環境ダッシュボード + アラート

SwitchBot HUB2 から室内環境データ(温度・湿度・照度)を15分間隔で自動記録し、
GitHub Pages のダッシュボードでグラフ表示。不適切な状態(暑すぎ・乾燥しすぎ等)を
検知したら LINE で通知する。サーバー費用ゼロ(GitHub Actions + GitHub Pages のみ)、
vanilla JS・依存ライブラリなし。

## 構成

```
外部スケジューラ (cron-job.org, 15分間隔)
  └─ workflow_dispatch API で GitHub Actions を起動
       .github/workflows/collect.yml → scripts/collect.mjs
         ├─ SwitchBot API v1.1 から現在値を取得(HUB2・プラグ Mini)
         ├─ data/YYYY-MM.json に追記してコミット
         └─ 閾値判定 → 新規アラートのみ LINE Messaging API で push 通知

GitHub Pages (静的サイト・PWA)
  └─ index.html + app.js が data/*.json を fetch してグラフ描画
```

## セットアップ

1. **SwitchBot トークンの取得**
   SwitchBot アプリ → プロフィール → 設定 → アプリバージョンを10回タップ
   → 開発者向けオプションで `token` / `secret` を取得。
2. **LINE Messaging API**
   LINE Developers で Messaging API チャネルを作成し、
   **チャネルアクセストークン(長期)** を発行(チャネルシークレットとは別物)。
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
5. **外部スケジューラの設定**(下記「スケジューリング」)
6. **動作確認**
   Actions タブから `collect` を手動実行(workflow_dispatch)し、
   `data/` に月別 JSON がコミットされることを確認。

## スケジューリング

GitHub Actions の cron は間引き・遅延が大きい(実測で30〜60分間隔になる)ため
**使わず**、15分間隔の起動は**外部スケジューラから `workflow_dispatch` を叩く**方式。
ワークフローの起動トリガーは `workflow_dispatch` のみ(外部からの API 起動と
Actions タブからの手動実行を兼ねる)。

1. GitHub で fine-grained PAT を発行
   (対象: このリポジトリのみ / Repository permissions → Actions: **Read and write**)
2. [cron-job.org](https://cron-job.org) にジョブを作成
   - URL: `https://api.github.com/repos/<owner>/<repo>/actions/workflows/collect.yml/dispatches`
   - Method: `POST` / Body: `{"ref":"main"}`
   - Headers: `Authorization: Bearer <PAT>` / `Accept: application/vnd.github+json`
   - スケジュール: 15分ごと
   - ※「Requires HTTP authentication」は OFF(トークンは Authorization ヘッダーで渡す)

念のため、二重起動時は収集スクリプト側の重複ガード(前回記録から300秒未満は
スキップ)が効く。

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

通知タイトルは `config.json` の `alertTitle`(例: `【リビング環境アラート】`)。
アラート状態は `data/alert-state.json` で管理。同一アラートは以下のタイミングで通知:

- **解消 → 再発生** した時
- **継続中は `renotifyHours` 間隔**(既定3時間)で再通知(リマインド)

ダッシュボードの「解除」ボタンも同じ間隔のスヌーズで、押すと `renotifyHours`
時間だけバナーを非表示にし、まだ継続していれば再表示する(端末ローカル)。

## 定時レポート・電力ログ

- **LINE定時レポート**: 毎朝(`config.json` の `dailyReport.hour`、初期値7時)以降の
  最初の実行で、現在値・過去24時間の温湿度レンジ・発火中アラートを1日1回送信。
  送信済み日は `alert-state.json` の `lastReport` で管理(重複送信なし)
- **プラグ Mini**: デバイスがあれば自動検出して消費電力(W)を
  `data/power-YYYY-MM.json` に記録。ダッシュボードに現在の消費電力と
  電気代換算(`power.yenPerKwh`、初期値31円/kWh)を表示

## ダッシュボード

**STARK HUD テーマ**(ダーク基調・アークリアクター調のシアン + ゴールド)。

- **アラートバナー**: 発火中のアラートを最上部に色付き表示(`alert-state.json` を参照)
- **現在値カード**: 温度 / 湿度 / 照度 / 不快指数 / 絶対湿度 + 推奨レンジ判定バッジ。
  温度・湿度の大タイルには直近3時間のスパークライン。電力データがあれば
  消費電力 / 今日の電気代 / プラグON数 のタイルも表示
- **推移グラフ**: 温度・湿度の2段パネル(時間軸共有・Canvas 自前描画・発光ライン)
  - 期間切替: 24時間 / 7日 / 30日
  - 推奨レンジ帯、期間内の最高/最低ラベル、クロスヘア + ツールチップ
- **日別サマリー**: 直近14日の温度・湿度(最低/平均/最高)+ 電気代
- **データ表**: 直近の生記録
- **更新ボタン**: 最新データを再取得。PWA 復帰時は自動更新
- **PWA**: ホーム画面追加でアプリ的に起動。Service Worker は network-first
  (オンラインは常に最新・オフライン時のみキャッシュ)

部屋名は `config.json` の `roomName`(ヘッダーとタイトルに反映)。

### ローカルでの動作確認

```sh
python3 -m http.server 8000
# http://localhost:8000/?demo=1 でサンプルデータ表示
```

収集スクリプトのロジック(署名生成・アラート判定)は `scripts/collect.mjs` に
まとまっており、Node 20+ で単体実行できる。

## データ形式

環境ログ `data/YYYY-MM.json`(月別、1レコード1行):

```json
[
  { "t": 1751770800, "temp": 27.3, "hum": 62, "lux": 14 }
]
```

電力ログ `data/power-YYYY-MM.json`(プラグ Mini がある場合のみ):

```json
[
  { "t": 1751770800, "plugs": [ { "name": "エアコン", "w": 420, "on": true } ] }
]
```

`t` は UNIX 秒。月の区切りは JST(`config.json` の `timezoneOffsetHours`)。
デバイスIDはコード・データに含めない(Secrets のみ / プラグはデバイス名のみ記録)。

## config.json

| キー | 内容 |
|---|---|
| `roomName` | 部屋名(ダッシュボードのタイトルに反映) |
| `alertTitle` | アラート通知のタイトル |
| `reportTitle` | 定時レポートのタイトル |
| `dailyReport` | `{ enabled, hour }` 定時レポートの有効化と送信時刻 |
| `renotifyHours` | 継続中アラートの再通知/再表示間隔(時間)。0以下で無効 |
| `power.yenPerKwh` | 電気代換算の単価(円/kWh) |
| `timezoneOffsetHours` | タイムゾーン(JST = 9) |
| `seasons.summerMonths` | 夏モードの月 |
| `comfort` | 推奨レンジ(温度・湿度) |
| `thresholds` | 夏/冬モードのアラート閾値 |
