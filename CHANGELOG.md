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

- fix (#77, CR-6): `audit_config_get` の両経路ロールを Admin に統一（Tauri が
  Viewer・REST が Admin という看板不変条件「両経路対称」の実バグを修正）。
  `verify:architecture` rule 8 に**ロール床照合**（`require_role`/`RoleGuard` の
  期待ロールを DUAL_PATH/ROLE_READ 宣言と静的照合）を追加
- docs/tooling (#78, CR-7): ドキュメントと実装の整合を是正（チャート14種・
  scan-wedge 記述・`pnpm check` 説明、scan-wedge を tsc 化）+ **バージョン整合検査**
  `check:versions`（全マニフェスト version の相互一致 / タグモードでタグ名照合）を追加
- ci (#79, AD-5): テンプレート受け入れ CI（copy→rename→check）+ `rename.mjs` の
  統合テスト（Node 標準 `node:test`）を追加
- i18n (#81, AD-6 レイヤ①): `@banto/*` 全パッケージの可視文言を**注入対応化**。
  現行日本語をデフォルトに残した `messages` props / メッセージ引数で上書き可能にし
  （`forms/validate.ts` の既存パターンを横展開）、辞書・`t()`・依存追加なし・
  byte-identical・後方互換。②仕組み・③辞書・docs 英語化は実需ドリブンで保留
- docs (#82, AD-4): template-scope §7 コピー面積縮小の着手トリガに「外部採用者
  フィードバック」を追加
- fix (#83, PR-C): Tauri デスクトップ Webview に **CSP を設定**（`app.security.csp` を
  null → LAN 側 `security_headers.rs` と対称。差分は `connect-src` の Tauri IPC のみ）。
  実機 Windows のビルド + スモークで確認。app.html インラインスクリプトは SvelteKit
  ブートストラップのビルド毎ハッシュ変動のため `'unsafe-inline'` を踏襲（LAN と同じ）
- fix (#84): デスクトップの CSV エクスポートを `exports/` フォルダ書き出し +
  フォルダを開く方式に（WebView2 が保存ダイアログを出さない問題。backup と同じ
  流儀・依存追加なし。Tauri コマンド `items_export_csv_to_folder`、`DESKTOP_ONLY` 分類）
- docs (#85, AD-1/AD-2): README に「対象読者 / 非対象」ポジショニング宣言と
  スクリーンショット3枚（`docs/assets/`）を追加（採用者向け導線）
- chore (#86, CR-7): 全マニフェストの version を **0.1.1 に整合**（既存 v0.1.1 タグ /
  CHANGELOG [0.1.1] とのドリフトを解消）

- M24: `@banto/charts` に **積立エリア（`StackedAreaChart`）** と
  **ガントチャート（`GanttChart`）** を追加（全14種）。積立棒は従来どおり
  `BarChart` の `stacked`。積立エリアは既存 `core/stack.ts` を再利用し、境界間
  バンドの新規純関数 `bandAreaPath` で塗る（`LineChart` のズーム/第2Y軸と
  衝突するため専用コンポーネント）。ガントは純関数 `core/gantt.ts`
  （`toMs`/`ganttDomain`/`ganttLayout`）+ 時間軸バー・進捗・「今日」マーカー
  （依存線は非スコープ）。日付は `formatDate` 委譲で日付ライブラリ非同梱
  （依存を足さない）。ユニットテスト14件追加、生色値なし。ダッシュボードデモ
  への配線は visual baseline 再生成が要るため別 PR（roadmap M24）

- docs: 保守性コードレビューの不変条件機械検査化を **CR-1 / CR-2 で打ち止め**と
  決定し、理由を maintainability-review-2026-07.md §4.1 に記録。機械検査の3条件
  （背骨 / 静かに壊れる / AI が無自覚に壊す）に照らし、CR-4 は不採用、CR-5 は
  機会的、CR-3 は実需ドリブンで見送り。ガードレール自体が保守負担・偽の安心感に
  なる手前で止める判断

- ci: `verify:architecture` に rule 9「§6 セキュリティ不変条件」を追加（CR-2）。
  §6 のうち静的テキストで低誤検知に検査できる2件を機械化: (A) `NewAttachment` に
  `mime` フィールドが無い（クライアント申告 MIME を受け取らず、判定は
  `detect_mime` のマジックバイトのみ）、(B) `settings_get`/`settings_set` が同一
  Admin ゲート（「同一ストアでも権限の非対称を作らない」）。順序依存・
  セマンティックな項目（body limit の順序・監査 detail に秘密を入れない等）は
  レビュー/テスト担保のまま。conventions §6 の該当2箇所を [機械検査済み] に更新

- ci: `verify:architecture` に rule 8「REST/Tauri 両経路対称」を追加（CR-1、
  conventions §1）。このテンプレートの背骨の不変条件でありながら従来は機械検査が
  無く、AI が mutating 操作を片方の経路にだけ足しても落ちる検査が無かった
  （`src-tauri` は非コンパイル環境で実行検証も不可）。`DUAL_PATH` マニフェスト
  （20対、所有者確認済み分類）+ 完全性チェックで、未分類の Tauri コマンド /
  REST ルート追加を CI で捕捉する。アンカーは Tauri コマンド定義と
  `rest/mod.rs` の Route table（実 `.route()` 宣言との doc-sync 併設）。依存追加
  なし。conventions §1 を [機械検査済み] に更新

- docs: 保守性コードレビュー（Rustサービス+サーバ層、AI中心保守が前提）の所見と
  不変条件の機械検査化ロードマップ（CR-1〜CR-5）を
  [maintainability-review-2026-07.md](docs/maintainability-review-2026-07.md) に
  記録。人間の保守性とAI保守性の分岐点を整理し、conventions.md のうち機械検査に
  落ちていない不変条件（特に §1 両経路対称）を優先的に検査化する方針。
  improvement-plan-2026-07.md から参照

- ci/docs: `verify:architecture` に「ドキュメント整合性」ルール（rule 7）を追加。
  `docs/`・README・AGENTS・CLAUDE 内の `@banto/*` 参照が実在パッケージのみで
  あることを機械検査し、実在しない `@banto/grid-core` 等の掲載（今回修正した
  ドリフト）を CI で防ぐ。実在パッケージ名は `packages/*/package.json` から
  動的取得するため追加/改名に自動追従。依存追加なし（Node 標準のみ）

- docs: ドキュメントと実装の不整合を修正。(1) ui-framework-spec §2.1 の対象
  パッケージ表から実在しない `@banto/grid-core`/`@banto/dock-core` を除去し、
  ヘッドレスロジックは各 `-svelte` パッケージ内 `src/core/` に内包（§14 決着）と
  明記。(2) 同表の `banto-storage` の PostgreSQL 記述を実装状況（v1 は SQLite
  のみ、postgres は feature 定義止まり — §12.1 注記）に整合。(3) v1後追加の
  オプション拡張パッケージ（report/attachments/scan-wedge、M19〜21）への参照を
  追記。(4) AGENTS.md/CLAUDE.md の E2E 検証コマンドを実在しない
  `pnpm -C apps/admin-template test:e2e` から実際の `pnpm e2e` に修正。
  (5) template-scope のクレート化計画表に、`rest.rs` が P3-1 で `rest/` へ
  分割済みである旨を反映

- P4-9: スキャフォールド・プリセット（`minimal`/`standard`/`full`）の**設計を
  確定**（[docs/scaffold-presets-plan.md](docs/scaffold-presets-plan.md)、設計のみ・
  実装は P2-1 v2 の後）。プリセットは §3 オプション資産の削除手順の自動実行で
  あり、コア（auth/audit/settings/backup/CSV/shell）や runtime 機構には触れない。
  ChatGPT レビュー当初案の "industrial"（別リポジトリ `banto-industrial` と混同）を
  避け命名を是正。remover 関数群 + rename.mjs のエンジン再利用・依存追加なしで
  構成し、各プリセットのビルド緑を受け入れ条件にする方針を明記

- docs: v2 検討事項の決着とドキュメント棚卸し。TLS 本体（組み込み rustls）と
  サーバログ（`tracing`）は、いずれも conventions §3 が退けた依存追加のため
  実装ではなく ADR で決定を記録（[ADR-0003](docs/adr/0003-tls-via-reverse-proxy.md)
  リバースプロキシ終端を正式・組み込み TLS は保留、
  [ADR-0004](docs/adr/0004-server-logging-eprintln.md) `eprintln!` 継続・
  `tracing` は保留）。あわせて improvements.md の「まとめ」から完了済み項目
  （Dependabot/コンポーネントテスト）を除去、改行正規化を実質完了（CRLF 0件）と
  確認、spec §6.1/§6.3 の陳腐化した「v2以降」注記（複合/レーダー/ヒートマップ/
  ゲージ・SVGエクスポート＝M13/M22 で実装済み）を訂正

- P4-2: 仮想スクロールの計測ベンチを追加（`@banto/grid-svelte`、
  `pnpm bench`）。per-frame 処理（`computeWindow` + 可視ウィンドウ slice）が
  総行数に依存しないこと（10k/100k でほぼ同一）を実証し、sort/filter の
  総行数依存コストも計測。vitest bench でホットパスを計測する方式（ブラウザ
  FPS ではなく決定的・CI 非ゲート・依存追加なし）。代表結果はベンチ冒頭に常設

- P4-3: README LAN 節に「同時書き込みとSQLite（WAL）」節を追加。
  デスクトップ + 組み込みサーバは同一プロセス・単一プール共有で書き込みが
  シリアライズされ、DB は WAL モードで開くこと（別プロセスからの同時
  アクセスは避けるべき点も）を明記

- P4-7: ADR（Architecture Decision Record）を `docs/adr/` に導入。README
  （ドキュメント3分類の役割分担: コードコメント / conventions.md / ADR）+
  テンプレート + 最初の ADR 2件（0001 REST/Tauri 二経路対称、0002 依存
  最小化）。ADR は「退けた代替案とその理由」に絞り、conventions.md 冒頭
  から参照。既存判断のバックフィルは一括せず次に触れる時に1件ずつ起こす

- P4-1: `FilterPopover` の dismiss 挙動テストを追加（`@banto/grid-svelte`、
  9件）。実装精査の結果 Tab 巡回型フォーカストラップではなく「Escape /
  外側 pointerdown で閉じる」dismiss 型と判明したため、その実挙動
  （dialog 意味論・apply/clear/Enter 含む）を固定。improvements.md §8 の
  記述も実態に訂正

- fix(backup): `BackupService::create` の `created_at` を、生成した
  ファイルの mtime（`list()` と同一の取得源）から算出するよう修正。
  従来は `datetime('now')` 由来で、`VACUUM INTO` が秒境界をまたぐと
  create と list で最大1秒ずれる不整合があり、Windows で決定論的に
  `create_then_list_then_read_round_trips` を落としていた（P3-3 の CI で
  顕在化）
- P3-3: Svelte コンポーネントテストを導入（`@banto/forms` の `BantoForm`・
  `@banto/grid-svelte` の `BantoGrid` にマウント+基本操作テストを各5件）。
  `@testing-library/svelte` + `jsdom` を両パッケージの devDependencies に
  追加し、component テストのみ `// @vitest-environment jsdom` で opt-in
  （純ロジックテストの環境は不変、dependencies/peerDependencies は空を維持）
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
