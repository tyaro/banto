# ADR-0028: アプリのローカル日付は `chrono`（`clock` のみ）で求める（ADR-0002 の例外）

> English: [0028-chrono-local-date.en.md](0028-chrono-local-date.en.md)

- 状態: Accepted
- 日付: 2026-11-08
- 関連: PR #533 / conventions §3 / [ADR-0002](0002-minimal-dependencies.md) /
  [docs/design/date-time-pickers.md](../design/date-time-pickers.md)

## コンテキスト

admin-template の `items.updated_at` は SQL 式（SQLite の `date('now')` = UTC、
PostgreSQL の `CURRENT_DATE::text` = DB サーバーのタイムゾーン）で書いていた。
日本時間 0〜9 時に保存した行が前日の日付になり、日付ピッカーの「今日」（ブラウザの
ローカル日付）で期間を絞り込むと出てこない。

オーナーと「アプリのプロセスが動く PC のローカル日付を Rust で求め、SQL にバインドする」
と決めた。ローカル日付にはタイムゾーンのオフセットが要る。std には無く、
Windows は Win32 API、Unix は `localtime_r` の FFI になる。

制約: conventions §3 / ADR-0002 は `chrono` / `time` を名指しで「足さない」としており、
足すなら設計判断として ADR に残す。

## 決定

**`admin-template-core` に `chrono`（`default-features = false, features = ["clock"]`）を
足し、`chrono::Local` でローカル日付を求める。** オーナーが 2026-11-08 に承認。

範囲はこの用途（ローカル日付・時刻の取得）に限る。日付の文字列変換・暦の計算は
従来どおり自前（`civil_from_days` など）で、`chrono` に置き換えない。
共通クレート（`banto-*`）には足さない。

## 検討した代替案

- **案A（採用）: `chrono` の `clock` feature だけを足す。**
  P1-5 の該当: ①タイムゾーンは OS ごとの FFI でエッジケースが多い（日時の領域）／
  ②`chrono` は成熟し、`src-tauri` で既に使っているのでロックファイルとバイナリの
  実質の増分はほぼ無い／③`clock` だけに絞れる。欠点: テンプレートを写す派生アプリの
  core に依存が 1 つ増える。
- **案B（不採用）: プロセス内の SQLite に `SELECT date('now','localtime')` を問い合わせる。**
  依存は増えないが、PostgreSQL の経路でも日付のためだけに `sqlite::memory:` の接続を
  開くことになり、「日付を取る」意図がコードから読み取りにくい。PR #533 で一度実装し、
  オーナーの判断で案 A に戻した。
- **案C（不採用）: `windows-sys` / `libc` で自前の FFI。** OS ごとの `unsafe` を
  自前で保守することになり、§3 の「総保守コストの最小化」に反する。
- **案D（不採用）: SQL 式を `date('now','localtime')` に変えるだけ。** PostgreSQL は
  DB サーバーのタイムゾーンのままで、方言間で結果が食い違う。

## 帰結

- `items.updated_at` は SQLite・PostgreSQL とも、アプリのローカル日付になる。
  テストは `ItemsService::with_today` で日付を固定できる。
- conventions §3 の表の `chrono` / `time` の行に、この例外への参照を足す。
- 外し方: `chrono` を外すなら、案 B（プロセス内 SQLite の localtime）に置き換える。
