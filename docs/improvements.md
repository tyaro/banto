# Banto 改善提案ドキュメント

作成日: 2026-07-08（コードベース調査に基づく）

本ドキュメントは、リポジトリ全体（`packages/`・`crates/`・`apps/admin-template/`・
`docs/`・リポジトリ運用）を多角的に調査し、改善点を視点別に整理したもの。
各項目には優先度（高/中/低）を付す。

> **3ファイルの役割分担（2026-07-19 追記）**: このリポジトリの改善関連
> ドキュメントは3つに分かれている。
>
> - **本書（`docs/improvements.md`）**: 未解決課題の調査記録。対応済みに
>   なった項目は本文から詳細を外し、1〜2行のスタブ + アーカイブへのリンク
>   のみ残す。
> - **[docs/history/improvements-archive.md](history/improvements-archive.md)**:
>   対応済みになった項目の実装記録アーカイブ（日付・PR番号・根拠を保持）。
> - **[improvement-plan-2026-07.md](improvement-plan-2026-07.md)**: 外部AI
>   レビューと本書の残課題を統合した「これから何をどの順でやるか」の
>   アクションプラン。一次情報はこちら。

> **2026-07-18 追記**: 本書の残課題と外部AIレビュー（Claude / ChatGPT）の
> 所見を統合したアクションプランを
> [improvement-plan-2026-07.md](improvement-plan-2026-07.md) に新設した。
> 「これから何をやるか」はそちらが一次情報。本書は調査記録として
> 引き続き更新する。

**現状の総評**: 仕様書（[ui-framework-spec.md](ui-framework-spec.md)）の
マイルストーン M0〜M9 はすべて完了しており、パッケージ単位のユニットテスト
（TS 35ファイル + Rust 側 `#[cfg(test)]` 多数）、ヘッドレス/UI分離、
コメントの質など、コードそのものの品質は高い。改善余地は主に
**「コードの外側」**（CI・リリース運用・セキュリティ運用・E2E検証）に集中している。

---

## 0. Node バージョン追従 — 対応済み

**対応済み（2026-07-08）**: `engines.node >=24` / `.nvmrc` / README を
Node 24+ に更新済み。詳細は
[history/improvements-archive.md §0](history/improvements-archive.md#0-node-バージョン追従対応済み)。

## 1. CI/CD・自動化 — 対応済み

**対応済み（2026-07-16）**: M18（PR #20, #32）で `.github/workflows/ci.yml`
が整備され、frontend/rust（ubuntu+windows）/e2e の3ジョブがPRをゲートして
いる。整備前の現状記録・検討していた課題表は
[history/improvements-archive.md §1](history/improvements-archive.md#1-cicd自動化対応済み)
参照。

## 2. セキュリティ（優先度: 高）

M6/M9 で認証は argon2id 資格情報ストア + 初回セットアップまで実装済みだが、
LAN サーバ（`banto-server`）のセッション/運用面に残課題がある。

### 2.1 セッショントークンに有効期限がない — 対応済み（2026-07-08）

トークンごとに発行時刻・最終使用時刻を記録し、`TokenPolicy`（デフォルト:
絶対8時間 / アイドル1時間）で失効する実装が入っている。詳細は
[history/improvements-archive.md §2.1](history/improvements-archive.md#21-セッショントークンに有効期限がない対応済み2026-07-08)。

### 2.2 ログイン試行のレート制限がない — 対応済み（2026-07-08。追補 2026-07-17）

`RateLimitPolicy`（per-account 複合キー + per-IP 次元の2軸ロックアウト）を
argon2 検証前に判定する実装が入っている。詳細は
[history/improvements-archive.md §2.2](history/improvements-archive.md#22-ログイン試行のレート制限がない対応済み2026-07-08追補-2026-07-17)。

### 2.3 TLS 未対応（既知・v2 検討事項。構成例ドキュメントは対応済み）

仕様 §11.2 の割り切りどおり、TLS 自体の実装（`axum-server` + `rustls` で
自己署名証明書を自動生成するオプトイン）は引き続き **v2 検討事項**。

**対応済み（2026-07-18、ドキュメント部分。improvement-plan P1-4）**:
README の LAN 節に警告ボックス（HTTP 平文の明示・適用範囲）と
「リバースプロキシでの TLS 終端（Caddy 例）」節を追加した。詳細は
[history/improvements-archive.md §2.3](history/improvements-archive.md#23-tls-構成例ドキュメントドキュメント部分のみ対応済み2026-07-18)。

**未了**: 設定画面内の警告強化（既存 note の warning 化）— 設定ページは
visual regression の fullPage スナップショット対象のため、ベースライン
再生成ができる環境（CI と同一の Playwright Chromium + フォント）での実施
が必要（improvement-plan P1-4 の※2に追跡あり）。

### 2.4 セキュリティヘッダ — 対応済み（2026-07-16）

`with_security_headers` レイヤで4種のヘッダ（`X-Content-Type-Options` /
`X-Frame-Options` / `Referrer-Policy` / `Content-Security-Policy`）を全
ルートに一枚岩で付与済み。詳細は
[history/improvements-archive.md §2.4](history/improvements-archive.md#24-セキュリティヘッダ対応済み2026-07-16)。

### 2.5 依存監査の自動化 — 対応済み（2026-07-16。ignore登録 2026-07-17）

CI に `audit` ジョブ（`pnpm audit --prod --audit-level high` +
`cargo audit`）を追加済み。詳細は
[history/improvements-archive.md §2.5](history/improvements-archive.md#25-依存監査の自動化対応済み2026-07-16ignore登録-2026-07-17)。

**未解決**: Dependabot/Renovate 導入は引き続き検討事項
（improvement-plan P4-4 で追跡）。

## 3. ドキュメントの鮮度 — 対応済み（全項目）

以下4項目はすべて対応済み。詳細な調査結果・書き換え箇所は
[history/improvements-archive.md](history/improvements-archive.md) 参照。

- **3.1 README が認証実装の実態と不一致** — 対応済み（2026-07-08）。
  argon2id 資格情報ストア + 初回セットアップフローに合わせて書き換え済み。
  [詳細](history/improvements-archive.md#31-readme-が認証実装の実態と不一致対応済み2026-07-08)
- **3.2 リポジトリ URL の不整合** — 対応済み（2026-07-16棚卸し）。
  `tyaro/banto` へ改名済み・`Cargo.toml`/9パッケージ `package.json` とも
  追従確認済み。
  [詳細](history/improvements-archive.md#32-リポジトリ-url-の不整合対応済み2026-07-16棚卸し)
- **3.3 仕様書 §14「未決事項」の棚卸し** — 対応済み（2026-07-16棚卸し）。
  決着済み項目に `[x]` と決着注記を付けた。
  [詳細](history/improvements-archive.md#33-仕様書-14未決事項の棚卸し対応済み2026-07-16)
- **3.4 CHANGELOG がない** — 対応済み（2026-07-16）。
  [CHANGELOG.md](../CHANGELOG.md) 新設済み（Keep a Changelog形式）。
  [詳細](history/improvements-archive.md#34-changelog-がない対応済み2026-07-16)

## 4. テスト（優先度: 中〜高。E2Eは対応済み）

**対応済み（2026-07-16、E2E行のみ）**: Playwright スモークE2E + visual
regression + axe-core が CI の `e2e` ジョブに組み込み済み。詳細は
[history/improvements-archive.md §4](history/improvements-archive.md#4-e2e部分-playwright-スモーク-e2e-の導入対応済み2026-07-16)。
下表の他の行（Svelteコンポーネントテスト・PostgreSQL経路・REST結合テスト）
は未確認のため現状のまま残す。

**現状**: ヘッドレスロジックのユニットテストは充実
（packages 35 テストファイル、Rust 側も `auth`/`csrf`/`events`/`sqlite` 等
62 テスト関数）。一方で以下が空白。

| 空白 | 提案 | 優先度 |
|---|---|---|
| Svelte コンポーネントテストがない（`.svelte` はテスト対象外） | `BantoGrid`/`BantoForm` 等は vitest + `@testing-library/svelte`（browser mode）でレンダリングテスト可能。ロジックはヘッドレス側で担保済みなので、まずはマウント+基本操作のみ（improvement-plan P3-3） | 中 |
| PostgreSQL 経路のテストなし（そもそも未実装、§6.1 参照） | 実装時に testcontainers か CI のサービスコンテナで統合テスト | 中 |
| REST API の結合テスト | `banto-serve` バイナリがあるので、axum の `oneshot` ベースの結合テスト（auth → CRUD → SSE）を `admin-template-core` に追加しやすい。`rest.rs` に一部あるが、認可漏れ（未認証で各エンドポイントを叩く）の網羅があると安心 | 中 |

### 4.1 CI の E2E ジョブが webServer タイムアウトで恒常的に失敗 — 対応済み（2026-07-18、PR #37）

GitHub ランナー上の IPv4/IPv6 バインド不一致（`vite preview` が IPv6
ループバックのみバインド、Playwright の監視 URL は IPv4）が原因で `e2e`
ジョブが恒常的にタイムアウトしていた事象。`--host 127.0.0.1` 指定と
`stdout: 'pipe'` 恒久化で修正済み。詳細な事象・根本原因・教訓は
[history/improvements-archive.md §4.1](history/improvements-archive.md#41-ci-の-e2e-ジョブが-webserver-タイムアウトで恒常的に失敗対応済み2026-07-18pr-37)
参照（CI運用上の教訓として一読の価値あり）。

## 5. コード品質基盤・開発体験（優先度: 中）

### 5.1 リンタ・フォーマッタ設定が一切ない — 対応済み（2026-07-16）

`eslint.config.js`・`.prettierrc.json`・Rust側 `cargo fmt --check` /
`clippy -- -D warnings` がCIでゲートされている。詳細は
[history/improvements-archive.md §5.1](history/improvements-archive.md#51-リンタフォーマッタ設定が一切ない対応済み2026-07-16)。

### 5.2 改行コードの統一（`.gitattributes` がない）

**対応済み（2026-07-08、`.gitattributes` の追加のみ）**: ルートに
`.gitattributes`（`* text=auto eol=lf` + バイナリ拡張子の `binary` 指定）
を追加済み。詳細は
[history/improvements-archive.md §5.2](history/improvements-archive.md#52-gitattributes-追加部分-改行コードの統一対応済み2026-07-08)。

**未解決**: 既存ファイルの `git add --renormalize .` による一括正規化は
未実施（他エージェントの並行編集と衝突するため、統合フェーズで別途実施
すること）。

### 5.3 pre-commit フック — 対応済み（2026-07-16、オプトイン .githooks 方式）

`.githooks/pre-commit`（`pnpm format:check && pnpm lint`）をオプトイン
方式（`git config core.hooksPath .githooks`）で導入済み。詳細は
[history/improvements-archive.md §5.3](history/improvements-archive.md#53-pre-commit-フック対応済み2026-07-16オプトイン-githooks-方式)。

### 5.4 ルート `package.json` のスクリプト拡充 — 対応済み（2026-07-08 / 2026-07-16）

`test`/`lint`/`format`/`format:check`/`e2e`/`e2e:visual` が揃っている。
詳細は
[history/improvements-archive.md §5.4](history/improvements-archive.md#54-ルート-packagejson-のスクリプト拡充対応済み2026-07-08--2026-07-16)。

## 6. アーキテクチャ・機能の残課題（優先度: 中）

### 6.1 PostgreSQL リポジトリが未実装

`banto-storage` に `postgres` feature は定義されているが、
`src/` には `sqlite.rs` しかなく **Postgres 実装モジュールが存在しない**。
仕様 §12.1 は「業務データは外部 PostgreSQL（TimescaleDB）」を標準と
位置づけているため、仕様と実装の乖離が最も大きい箇所。

- 提案: `list_query.rs`（ホワイトリスト式クエリビルダ）は方言差が小さいはず
  なので、`sqlite.rs` を雛形に `postgres.rs` を追加。プレースホルダ
  （`?` vs `$1`）と `RETURNING` 周りの差分吸収が主作業。

**期待値の明記は対応済み（2026-07-18、README + 仕様 §12.1 注記。
improvement-plan P1-1）**: 「v1 は SQLite のみ、PostgreSQL は feature
定義のみ」と明記し期待値を合わせた。実装自体は improvement-plan P4-5
として実需ドリブンで再評価する方針（未解決のまま残す）。

### 6.2 UI 設定の保存先が localStorage のまま — 対応済み（2026-07-16棚卸し）

M12（PR #13）で `SettingsProvider` 抽象が追加され、保存先が localStorage
から `settings` テーブル（Tauri/REST経由）へ移行済み。詳細は
[history/improvements-archive.md §6.2](history/improvements-archive.md#62-ui-設定の保存先が-localstorage-のまま対応済み2026-07-16棚卸し)。

### 6.3 スキーマ→列定義の自動導出 — 対応済み（2026-07-19、M23）

仕様 §3.1 の最重要ゴール「スキーマを1つ書けば一覧と編集フォームが両方生える」
のうち未実装だったグリッド列導出を、`@banto/grid-svelte` の
`columnsFromSchema` として実装し、items 一覧を導出ベースへ書き換え済み。
詳細は
[history/improvements-archive.md §6.3](history/improvements-archive.md#63-スキーマ列定義の自動導出対応済み2026-07-19m23)（roadmap.md M23参照）。

### 6.4 リソース定義からのルート導出（仕様 §14 未決）— 対応済み（2026-07-18）

「`items` のルート一式をコピーして書き換える」規約で決着し、
[recipes/add-resource.md](recipes/add-resource.md) にチェックリスト形式で
固定化済み。詳細は
[history/improvements-archive.md §6.4](history/improvements-archive.md#64-リソース定義からのルート導出仕様-14-未決対応済み2026-07-18)。

## 7. npm 公開準備（優先度: 低〜中、公開する場合のみ）

[publishing.md](publishing.md) に手順は整理済み。追加で:

- `@banto` スコープの npm org を**先に確保**しておく（名前スクワッティング対策。
  公開予定がなくても取得だけは早めに）。
- 各パッケージに `README.md` がない（npm ページが空になる）。最低限
  1パッケージ1枚の短い README を用意。
- `exports` がソース `.ts` 直指しのため、公開時の `dist` 切替は
  publishing.md どおりだが、`publishConfig.exports` 方式にすれば
  モノレポ開発とデュアル運用できる（doc 内でも言及済み — 実際に仕込んでおくと
  公開時の作業がゼロになる）。
- ~~Changesets 導入（§3.4 と共通）。~~ → **2026-07-16時点の判断**:
  [publishing.md](publishing.md) が2026-07-12に「npm/crates.ioレジストリ
  へは公開せずgitタグ参照で配布する」方針へ確定したため、Changesets
  導入は当面見送り（§3.4参照）。この節自体（npm公開準備一式）も
  同方針次第では前提が変わる。

## 8. アクセシビリティ・i18n（優先度: 中。アクセシビリティ自動検査は対応済み）

**対応済み（2026-07-16棚卸し）**: axe-core（`@axe-core/playwright`）が
Playwright visual regressionジョブ（8ページスキャン）としてCIに組み込み
済み。dock-svelteのキーボード代替・grid-svelteのコントラスト不足はPR #27
で検出・修正され、除外リストなしで8スキャン全通過している。詳細は
[history/improvements-archive.md §8](history/improvements-archive.md#8-アクセシビリティ自動検査部分対応済み2026-07-16棚卸し)。
i18nは[template-scope.md](template-scope.md) §4.3で
「テンプレートに入れない」と2026-07-12に決定済み（roadmap.md §3参照）。

- **i18n**: パッケージ側は日本語ハードコードなし（仕様 §13 遵守）を確認。
  ただし **Rust 側にユーザー向け日本語文言が埋まっている**
  （例: [auth.rs:190](../crates/banto-server/src/auth.rs) の
  「ユーザー名またはパスワードが違います」）。ライブラリクレートとして
  公開するなら、エラーは kind コードで返しフロントで翻訳する形に寄せる。
  テンプレートアプリ自体は日本語のみだが、これは用途上許容範囲。
- **アクセシビリティ**: FilterPopoverのフォーカストラップは専用の
  ユニット/インタラクションテストとしては未確認（axeスキャンはaria違反
  検出が中心でフォーカス遷移の網羅検査ではないため）。仕様 §4.7
  （キーボード操作・スクリーンリーダー）の達成状況の一次棚卸しは完了
  しているが、この一点は「対応済み」と言い切らず残す
  （improvement-plan P4-1 で追跡）。

## 9. パフォーマンス・運用性（優先度: 低）

- 仕様 §4.2 のパフォーマンス目標（仮想スクロール）に対する
  **計測ベンチがない**。10万行での fps/初期描画を計測する簡易ベンチページ
  （既存の items ページ + 行数パラメータで足りる）と、結果の記録を推奨
  （improvement-plan P4-2）。
- `banto-server` にログ基盤がない場合、`tracing` + `tower-http::trace` の
  導入を検討（LAN サーバのトラブルシュートで効く）。
- SQLite の書き込み競合（Tauri ウィンドウ + LAN クライアント同時書き込み）の
  挙動を README の LAN 節に一言書いておく（WAL モードの有無を含む。
  improvement-plan P4-3）。

---

## まとめ: 現在の未解決課題

上記の各節から対応済み項目を除いた、現時点（2026-07-19）の未解決課題:

- **§2.3**: TLS 実装自体（v2検討事項）+ 設定画面内の警告強化
- **§2.5**: Dependabot/Renovate 導入検討（improvement-plan P4-4）
- **§4**: Svelteコンポーネントテスト（P3-3）・PostgreSQL経路テスト・
  REST結合テストの拡充
- **§5.2**: 既存ファイルの改行コード一括正規化（`--renormalize`）
- **§6.1**: PostgreSQL リポジトリ実装（実需ドリブン、P4-5）
- **§7**: npm公開準備一式（公開する場合のみ。現状は非公開方針）
- **§8**: FilterPopover フォーカストラップの専用テスト（P4-1）
- **§9**: 仮想スクロールの計測ベンチ（P4-2）・ログ基盤（tracing）・
  SQLite同時書き込みのREADME記載（P4-3）

着手順の推奨・優先度付けは [improvement-plan-2026-07.md](improvement-plan-2026-07.md)
が一次情報（本書の「優先度サマリ」節は全項目対応済みとなったため
[history/improvements-archive.md](history/improvements-archive.md) へ移動した）。
