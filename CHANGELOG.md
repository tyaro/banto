# Changelog

このリポジトリの注目すべき変更を記録する。フォーマットは
[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠する。
バージョン番号はタグ運用規約（[docs/publishing.md](docs/publishing.md)
「タグ運用規約」節、0.x系は `minor` = 破壊的変更 / `patch` = 追加・修正）に
従う。バージョンタグ導入前の M0〜M9 はマイルストーン単位で、M10以降は
マイルストーン + PR番号単位で記録し、コミット単位までは分解しない。

**運用規約**:

- PR ごとに `[Unreleased]` へ変更点を1行追記する。
- リリース（破壊的変更を伴うgitタグの更新）のタイミングで `[Unreleased]`
  の内容を新しいバージョン節に切り出し、日付を入れる。
- 配布方式はgitタグ参照（npm/crates.ioレジストリへは公開しない、
  [docs/publishing.md](docs/publishing.md)）のため、Changesets 等の
  自動生成ツールは導入しない。本ファイルは手動運用を継続する
  （publishing.md「タグ運用規約」に以前あった「CHANGELOGは当面省略」の
  記述は本ファイルの新設により本節に置き換え）。

## [Unreleased]

- P3-6/P4-4: CI の全サードパーティ Action をコミット SHA に固定し
  （checkout/pnpm-action-setup/setup-node/rust-cache/upload-artifact/
  install-action/github-script の7種。`dtolnay/rust-toolchain@stable` は
  ref がツールチェーン選択を兼ねる仕様のため意図的に非固定）、Dependabot
  （`.github/dependabot.yml`、github-actions/npm/cargo をグループ化週次）を
  導入して追従を自動化
- P4-6: `docs/improvements.md` を「未解決課題の調査記録」に絞り、対応済み
  項目の実装記録を `docs/history/improvements-archive.md` へ分離
  （各項目にスタブ + アーカイブリンクを残し追跡可能に）
- P3-5: アーキテクチャ規約の機械検査 `pnpm verify:architecture` を新設し
  CI の frontend ジョブで強制（サービス層の tauri/axum 非依存・パッケージ間
  import ゼロ・`$lib` import 禁止・`{@html}`/生色値の理由付き許可リスト・
  依存空の6ルール。conventions.md に [機械検査済み] 注記）。charts の
  ズームリセットボタンの生 box-shadow をトークン化
- P2-2: 英語版 README（`README.en.md`、1ページ要約）を追加
- P2-3: 全9パッケージに README を追加（役割・最小コード例・依存ゼロ方針・
  git サブディレクトリ依存での消費方法）
- P2-1: テンプレート初期化スクリプト `scripts/rename.mjs` を新設
  （`--name`/`--title`/`--identifier`/`--repo` で package.json×2・
  `--filter` 参照・tauri.conf.json・ブランド表示・E2E アサーション・
  リポジトリ URL を一括書き換え。Node 標準ライブラリのみ・`--dry-run`
  対応・再実行安全。README「コピーとリネーム」をスクリプト前提に改訂）
- M23: スキーマ→グリッド列の自動導出 `columnsFromSchema` を
  `@banto/grid-svelte` に追加（フォームと同一ルール・同一メッセージの
  バリデータ込み。items 一覧を導出ベースへ書き換え、仕様 §3.1 の
  「スキーマを1つ書けば一覧と編集フォームが両方生える」を実装）
- refactor: `rest.rs`（4,069行）をリソース別モジュールへ分割
  （`rest/mod.rs` = ルート表 doc + 共有ガード + `api_router`、
  `rest/{items,users,auth,ui_settings,audit,backups,attachments}.rs`、
  テストは `rest/tests.rs`。公開 API（`api_router` /
  `audited_credential_verifier`）のパスは不変。improvement-plan P3-1）
- refactor: `setup.ts` を分割し、リソース定義を `resources/items.ts` +
  `resources/index.ts` へ、環境判定を `environment.ts` へ、デモ認証を
  `providers/demo.ts` へ分離（既存の公開エクスポートは `setup.ts` から
  re-export され後方互換。improvement-plan P3-4）
- ci: Tauri compile check ワークフロー `tauri-check.yml` を新設
  （`cargo check -p admin-template` を ubuntu/windows で、Tauri側を触る
  PR/main push + 週次スケジュールで実行。週次失敗時は Issue 自動起票。
  improvement-plan P3-2）
- docs: 改善計画フェーズ1（README 5分クイックスタート・SQLite期待値明記・
  リソース追加レシピ `docs/recipes/add-resource.md` 新設・LAN HTTP警告 +
  Caddy TLS終端例・依存判断基準・AGENTS.md Definition of Done・roadmap
  M23候補登録）
- fix(e2e): vite preview を 127.0.0.1 に明示バインドし、CIのE2Eジョブが
  恒常失敗していた webServer タイムアウトを解消（webServer stdout の
  パイプ化も恒久化）(#37)
- docs: AIレビュー統合の改善計画 `docs/improvement-plan-2026-07.md` を
  新設し、E2E障害の事後記録を improvements.md §4.1 に追記 (#36, #38)
- M18: 基盤整備の残ギャップ解消（M18 完了。CIのRustジョブへ
  `banto-attachments` 追加、E2E visual regression + axe-coreジョブ追加、
  全9パッケージの `publish --dry-run` 確認、template-scope.md §6の
  チェック消込）(#32)
- M19: 帳票/印刷 `@banto/report`（MDテンプレート + データバインド +
  印刷CSS + items日報デモ）(#31)
- M21: バーコード/QR wedge入力検出 `@banto/scan-wedge`（キーボード
  ウェッジ検出ヘッドレスコア + Svelteアクション、テンプレート本体には
  未配線・レシピのみ）(#30)
- M20: 添付ファイル/画像管理 `banto-attachments` + `@banto/attachments`
  （アップロード/サムネイル/一覧 + REST/Tauri/監査ログ配線 + items
  デモ配線）(#29)
- docs: M19〜M21の提供形態を「パッケージ + 削除可能デモ + レシピ」方式に
  決定 (#28)
- a11y: dock-svelte/grid-svelteの既知アクセシビリティ2件を改修し、
  axe-coreスキャンの除外リストを撤去（8スキャン全通過）(#27)
- M22: ビジュアルリフレッシュ検証基盤（Playwright visual regression +
  axe-core、Phase 0）を追加しM22をroadmapに登録 (#26)
- M22: ビジュアルリフレッシュ実装（実装単位1〜6。Modern Operations
  Console化 — トークン拡張・密度軸・共通UI・アイコン統一・シェル刷新・
  View Transitions）(#25)
- docs: メニュー一式を計画へ追記し、実装レベルの設計書
  （visual-refresh-design.md）を新規作成 (#24)
- docs: visual-refresh-plan をレビュー反映で改訂 (#23)

## [0.1.1] - 2026-07-12

- chore: リポジトリ公開化に向けて全パッケージのライセンス表記をMITに
  統一（`packages/*/package.json` の `license` を `UNLICENSED` から
  `MIT` へ戻し、パッケージ個別の `LICENSE` ファイルを削除）(#22)
- docs: パッケージ配布方式をgitサブディレクトリ依存に確定（`@banto`
  スコープがGitHub Packagesで使えないと判明したため、GitHub Packages案は
  棚上げ）(#21)

## [0.1.0] - 2026-07-12

最初のタグ付きリリース。M0〜M18の累積。

**M0〜M9**（[ui-framework-spec.md](docs/ui-framework-spec.md) §15。
バージョンタグ導入前のためPR番号なし、1行要約）:

- M0: モノレポ + テンプレートアプリの骨格（SvelteKit + Tauri v2 +
  シェルレイアウト + ルーティング + テーマ切替/設定画面）
- M1: グリッドコア（クライアントモード、仮想スクロール、ソート/フィルタ、
  列リサイズ/並び替え）
- M2: `admin-core`（リソース定義・`DataProvider`/`AuthProvider`・
  コンポーザブル）+ スキーマ駆動フォーム + CRUDページ雛形（グリッド+
  フォーム+Rustサービス層+sqlxリポジトリ貫通）+ 認証/ログイン雛形
- M3: グリッド セル編集・範囲選択・コピー&ペースト
- M4: チャートv1（折れ線/棒/円/散布図/スパークライン）+
  ダッシュボードページ
- M5: グリッド サーバーモード（`getList`経由のTauri連携）、グルーピング
- M6: 組み込みWebサーバ（サービス層のREST公開、静的配信、
  `HttpDataProvider`、認証のREST対応+CSRF、`SettingsProvider`抽象、
  SSEイベント配信、設定画面トグル+URL/QR表示）
- M7: ドッキングレイアウト（フローティングウィンドウのみ）
- M8: ドッキング（分割・タブ化・スナップ）+ ダッシュボードへの統合
- M9: テーマ層の整理、MITライセンス、npm公開準備、テンプレートの
  ドキュメント整備

補足（M9〜M10のあいだ、2026-07-08、マイルストーン番号なし）: CI導入
（GitHub Actions）、リポジトリを `my-template` から `banto` へ改名、
セッション有効期限・ログインレート制限の実装、Node 24 LTS対応
（[improvements.md](docs/improvements.md) §0/§1/§2.1/§2.2/§3.2）。

**M10〜M18**（[roadmap.md](docs/roadmap.md)、PR番号付き）:

- M10（#11）: ユーザー管理UI + RBAC（admin/editor/viewerの3ロール）
- M11（#12）: 自動ログイン（ログイン不要モード + デスクトップkeyring
  自動ログイン + LAN Remember me）
- M12（#13）: Glassテーマプリセット + SettingsProvider移行（UI設定を
  localStorageからSQLite設定DBへ）
- M13（#14）: チャート拡張（ズーム/パン・十字カーソル・しきい値バンド・
  第2Y軸・ストリーミング更新 + ヒストグラム/パレート図/箱ひげ図）
- M14（#15）: 監査ログ（`audit_log`テーブル・サービス層記録点・
  保持ポリシー・閲覧ページ）
- M15（#16）: CSV/Excelエクスポート・インポート（RFC 4180準拠コア +
  バルクインポートAPI + itemsページUI）
- M16（#17）: コマンドパレット（Ctrl+K、ナビ定義からの自動導出 +
  RBAC連動）
- M17（#18）: SQLiteバックアップ/リストア（`VACUUM INTO` +
  ステージング方式リストア）
- M18（#20）: 基盤整備 Phase A〜C（lint/format基盤・Playwrightスモーク
  E2E・パッケージ配布可能化）— 残ギャップは `[Unreleased]` の #32 で解消
