# Changelog

このリポジトリの注目すべき変更を記録する。フォーマットは
[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠する。
バージョン番号はタグ運用規約（[docs/publishing.md](docs/publishing.md)
「タグ運用規約」節）に従う。**1.0.0（安定版）以降は SemVer 準拠**
（`major` = 破壊的変更 / `minor` = 機能追加 / `patch` = 修正）。0.x 系は
`minor` = 破壊的変更 / `patch` = 追加・修正で運用していた。バージョンタグ
導入前の M0〜M9 はマイルストーン単位で、M10以降はマイルストーン + PR番号
単位で記録し、コミット単位までは分解しない。

**運用規約**:

- PR ごとに `[Unreleased]` へ変更点を1行追記する。
- リリース（バージョンタグの更新）のタイミングで `[Unreleased]`
  の内容を新しいバージョン節に切り出し、日付を入れる。
- 配布方式はgitタグ参照（npm/crates.ioレジストリへは公開しない、
  [docs/publishing.md](docs/publishing.md)）のため、Changesets 等の
  自動生成ツールは導入しない。本ファイルは手動運用を継続する
  （publishing.md「タグ運用規約」に以前あった「CHANGELOGは当面省略」の
  記述は本ファイルの新設により本節に置き換え）。

## [Unreleased]

### 追加

- **グリッドの列表示/非表示（列マネージャー UI）**（issue #168、spec §4.4）。
  `GridColumn.hidden` で「定義は持つが既定では出さない」列を表現でき、
  `GridState` が `setColumnHidden` / `toggleColumnHidden` / `isHidden` /
  `allColumns` で表示状態を所有する（`orderedColumns` は可視列のみを返すため、
  セル選択やコピー&ペーストの列インデックスも自動的に追随する）。切り替え UI は
  新コンポーネント `ColumnsMenu`（ページ側ツールバーに置く。BantoGrid のヘッダ行は
  可視列幅から `grid-template-columns` を組むため、ヘッダ内には入れない）。
  admin-template の商品ページのツールバーに配線済み。
- **`columnsFromSchema` の `order` オプション**（issue #168）。一覧の列順を
  スキーマの定義順（＝フォームの入力順）から切り離して指定できる。列の既定非表示は
  `overrides: { code: { hidden: true } }` で表現する。
- **UI 宣言境界と Discussions 運用の ADR 化 + チャート性能ベンチ**
  （Discussion #173）。UI 宣言はスキーマ駆動の漸進拡張・追加レンダラは REST
  クライアント境界と決めた判断を ADR-0009 に、Discussions を決定前検討専用と
  する運用を ADR-0010 に記録。roadmap §3 のバックログを「チャート性能
  エスカレーション梯子」（SVG 実測→サーバ側間引き→Canvas→WebGL→ネイティブ
  候補ウォッチ）へ拡張し、template-scope §4.2 に非スコープ2行（クロス
  レンダラ共通ウィジェット DSL / 画面エディタ）、conventions §12 に
  Discussion 参照の文法行を追加。`packages/charts/tests/trend.bench.ts` を
  新設し、ルートの `pnpm bench` を recursive 化した。

### 変更

- **`SerializedGridState` に `hidden: string[]` を追加（破壊的）**。
  `GridState.serialize()` の出力に列の表示状態が含まれるようになり、
  `hydrate()` は `hidden` を持たない旧ペイロードを**受け付けない**（不正な
  ペイロードと同じく無視され、レイアウトは既定値のまま）。永続化した
  グリッドレイアウトを持つ派生アプリは、保存済みの値が一度リセットされる。

### 修正

- **`items` デモを削除した派生アプリでバックアップをリストアできない問題を修正**。
  リストア検証の `REQUIRED_TABLES` を Banto 基盤所有の `settings` / `users` /
  `audit_log` に限定し、派生アプリが差し替え・削除するドメインテーブルを必須条件から
  除外した。ドメインテーブル無しの有効な Banto DB を受理する回帰テストを追加。

## [1.3.0] - 2026-08-20

**v1.3.0 — 保守レビュー 2026-08 の反映テーマ。** 新機能の追加は無く、
maintenance-review 2026-08 で洗い出した修正・対称性是正・テスト増強・
機械検査の追加が中心。**後方互換**（既存の公開 API は削除・改名とも無し、
依存追加ゼロ）のため minor リリース。以下は v1.2.0 以降のマージ分。

なお、クライアントから見えるステータスコードが2箇所変わる（不正な
フィルタ入力が 500 → 400、items import の大きなペイロードが 413 → 422）。
いずれも誤ったレスポンスの是正だが、ステータスコードで分岐している消費側は
確認すること。また `banto-core` の `BantoError` に `BadRequest`
バリアントが増えたため、この enum を網羅 `match` している消費側は
追随が必要（`ErrorBody` 経由で扱っている場合は影響なし）。

### 修正

- **Postgres で数値カラムへの `contains`/`starts_with` フィルタが 500 になるバグを修正**
  （maintenance-review PR-5 / H-3）。`list_query` の LIKE が `LOWER(<数値カラム>)` を
  生成し、Postgres の `lower()` は text 専用のため実行時エラー（500）になっていた
  （SQLite は動的型で暗黙変換するため既存テストが素通り）。`LOWER(CAST(col AS TEXT))`
  に変更（text カラムでは no-op、両バックエンド一致）。SQLite 回帰テスト + 実 Postgres の
  `postgres_tests`（LIKE/数値バインド/NULLS LAST、storage-postgres CI）を新設。
- **items import に明示 body limit を追加し 413 でなく 422 を返す**（maintenance-review
  PR-5 / M-14）。仕様上有効な最大行数のペイロードが axum 既定 2MB に先に当たり 413 で
  落ち得たのを、`items_write_router` に `DefaultBodyLimit::max(MAX_IMPORT_ROWS *
IMPORT_BODY_LIMIT_BYTES_PER_ROW)`（10MiB）を層付けして service 層の行数チェック
  （422）へ到達させる。境界テスト1本（修正を外すと 413 で落ちる回帰ガード）。

- **派生アプリの `pnpm dev` が `.svelte.ts` で 500 になる問題を修正**（issue #150 /
  [ADR-0007](docs/adr/0007-derived-app-dev-optimizer-exclude.md)）。`@banto/*` は
  ソース配布（`.svelte.ts` を生で出荷）のため、git 依存で node_modules 化した派生
  アプリでは Vite 8 dev の依存オプティマイザ（Rolldown）が preprocess せず
  `svelte.compileModule` に渡し `import type` 等で「Unexpected token」→ 500 になって
  いた（`pnpm build`/`check` は成功）。`apps/admin-template/vite.config.ts` の
  `optimizeDeps.exclude` に `.svelte.ts` を持つ5パッケージ（admin-core / dock-svelte /
  forms / grid-svelte / tree-svelte）を列挙して回避。テンプレート本体は workspace
  symlink 解決で元々 prebundle されないため no-op。列挙漏れの再発を
  `verify:architecture`（新 rule `optimizedeps-svelte-source`）で機械検査。
  publishing.md / conventions §14 に不変条件を明文化。

- **両経路の監査記録の非対称を是正**（maintenance-review PR-4 / H-4・M-15）。
  `audit-log/config` の denied 監査が REST=`resource:"audit_log"` /
  Tauri=`resource:"settings"` と食い違い、REST 内でも成功時（`settings`）と
  denied が不一致だった不変条件1違反を是正: REST の `audit_log_router` を
  list（`audit_log`）と config（`settings`）の2ガードに分割し、成功・denied・
  両経路すべてを `settings` に統一（`audit-log/list` は `audit_log` 維持）。
  両ガードの resource タグを `rest/tests.rs` でピン留め。backups restore の
  `entity_id` を canonical 化（対象ファイルの実名。upload は実体名が無いため
  `None`）。conventions §1 に監査 canonical 形状（resource / entity_id /
  denied detail 非対称 / 429 login 非記録）を明文化（ja/en）。
- **クライアント起因の不正入力を 500 でなく 400 で返す**（maintenance-review
  PR-4 / M-4）。`BantoError::BadRequest`（→ HTTP 400）を新設し、`list_query` の
  未知フィルタ列・不正なフィルタ値・`in` の非配列など5箇所を `Other`（500）から
  移行。`ErrorBody` に `bad_request` kind を追加し、フロント（`errors.ts` +
  全 `ERROR_KINDS`）とワイヤ形状パリティテスト（`error.rs`）を追随。サーバ
  エラー監視がクライアント起因の 500 で汚染されなくなる。

### 変更

- **`api_router` の10位置引数を `Services` 構造体へ集約**（maintenance-review M-13）。
  `api_router(items, users, …, auth, events, allow_setup)` を
  `api_router(services, auth, events, allow_setup)` に変更し、7つのサービスハンドル
  （items/users/settings/audit/backup/attachments/system_info）を `rest::Services`
  に束ねた。アプリ作者がサービスを足すコストが「位置引数を全呼び出し箇所へ波及」から
  「構造体フィールド1つ」に下がり、scaffold の attachments 除去も位置依存スロットから
  名前付きフィールドの除去になった。呼び出し箇所（`bin/banto-serve` / `src-tauri` の
  `start_embedded_server` / `rest::tests` の各ルータヘルパ）を追随。振る舞いの変更なし。
- **Tauri 側の監査記録に `record_ok` ヘルパーを導入**（maintenance-review M-1）。
  `src-tauri/lib.rs` の手書き `AuditEntry` 31箇所のうち、成功・アクター付き書き込み
  24箇所を REST の `record_write` に対応する `record_ok(&audit, &actor, action,
resource, entity_id, detail)` へ集約（`origin: "tauri"` / `result: "ok"` を固定）。
  両経路が各サイドのヘルパー経由になり、監査記録の形状ドリフト（conventions §1）を
  抑止。形状が異なる7箇所（import の ok/failed、login_failed、認証無効モードの
  エスケープハッチ書き込み、起動時 restore_applied、denied）は REST 同様に手書きのまま。
  振る舞いの変更なし（着手前提の両経路 detail 一致は maintenance-review §5.3 で実測済み）。

- **`record_write` の `entity_id` を `Option<&str>` に**（maintenance-review
  PR-4 / M-2）。entity_id を持たない mutating ハンドラ4箇所（audit config /
  backups restore-upload・cancel）が手書き `AuditEntry` を複製していたのを
  `record_write` ヘルパーに集約。

- **scaffold にツリーデモの remover を追加**（maintenance-review PR-3 / H-1）。
  v1.2.0 で追加された `@banto/tree-svelte` + `/tree` デモが scaffold 未登録で、
  minimal プリセットでもツリーデモが残っていた（#122 と同型のプリセット定義
  ドリフト）。README の手動4ステップを 1 対 1 で `removeTree()` 化し
  minimal / standard へ登録。`packages/` と scaffold の判断（remover / コア /
  除外）の同期を `scaffold.test.mjs` のトリップワイヤで機械検査化。
- **scaffold のアンカードリフト対策**（maintenance-review PR-3 / H-2）:
  (a) `verify-architecture.mjs` 対象ディレクトリ除去アンカーのカンマ欠落で
  dropBlock が無音スキップしていた実バグを修正。(b) `template-edit.mjs` に
  `--strict` モードを追加（pristine コピーでは「適用済み扱い」= アンカー不一致
  として失敗）し、template-acceptance の presets ジョブで有効化。
  (c) template-acceptance の paths トリガに scaffold のアンカー対象
  （アプリ側ファイル群）を追加 — アプリ側 PR でアンカーが壊れても週次まで
  潜伏せず毎 PR で検出される。

### テスト

- **Tauri の6コマンドを `_body` 分割し監査記録テストを追加**（maintenance-review PR-5 /
  M-5）。items_delete / auth_config_apply / autologin_enable / autologin_disable /
  attachments_upload / attachments_delete を `<cmd>_body(&AppState, …)` に切り出し（1行
  アダプタ）、各 body の監査エントリ（actor/action/resource/detail）を検証。attachments
  テストは scaffold で minimal/standard から除去（cutRegion 1本追加）。
- **pg_smoke に import の round-trip + rollback を追加**（maintenance-review PR-5 /
  M-12）。未実行だった `import_apply_postgres` の commit / rollback 両ブランチを実 Postgres で検証。
- **dock-svelte にドラッグ移動・フロート化のコンポーネントテストを追加**
  （maintenance-review PR-5 / M-8）。grid/tree の @testing-library/svelte + jsdom
  パターンを流用（devDeps + svelteTesting プラグイン追加）。

### 機械検査

- **機械検査を足すかの判断基準を [ADR-0008](docs/adr/0008-machine-check-stop-gate.md)
  に昇格し、rule を2本追加**（maintenance-review PR-7）。maintainability-review §4.1 が
  口伝で持っていた「打ち止め3条件」（背骨 / 静かに壊れる / AI が壊しうる を全て満たす）を
  ADR 化し、保守レビューの9案を選別（採用2・見送り2・却下5。全採否を ADR の台帳に記録）。
  採用分を `verify-architecture.mjs` に実装:
  - **rule 11 `migration-dialect-parity`**: `migrations-{sqlite,postgres}/` のファイル名/
    連番が1対1（片系統だけ足すと PG は smoke CI のみのため静かに欠落。中身の型差は §11 の
    意図的分岐でレビュー担保）。
  - **rule 12 `csp-two-definitions`**: `security_headers.rs` の const と `tauri.conf.json` の
    `app.security.csp` を connect-src の IPC 差分を除きディレクティブ単位で照合（cross-check
    テスト無し + src-tauri 非コンパイルのため片方だけ緩む退行を静かに見逃していた）。
    conventions §6/§11 に機械検査済みの旨を追記。両 rule とも意図的破壊で fail することを実測確認。

### ドキュメント

- **README の利用パッケージ別レシピ3節を `docs/recipes/` へ切り出し**
  （maintenance-review PR-6）。scan-wedge / 通知（トースト）/ tree-svelte の各節
  （計約240行）を `docs/recipes/{scan-wedge,notifications,tree-svelte}.md` へ移し、
  README には紹介 + リンクのスタブを残した（README は「コピー→リネーム→差し替え→
  削除→配信」の背骨に集中。節アンカーへの被参照ゼロを実測して切り出し）。
  欠落していた `packages/tree-svelte/README.md` を新設（他9パッケージと同形式）。
- **`docs/recipes/add-role.md`（ja/en）を新設**（feature-review-2026-08 §2.6 の宿題）。
  RBAC ロール追加のチェックリスト（Role enum → DB CHECK → 両経路の認可床 → rule 8 →
  フロント選択 UI/i18n → 対称テスト）。add-resource.md の姉妹編。AGENTS（ja/en）の
  「タスク別の入り口」に add-role とレシピ群を索引追加。
- **ui-framework-spec の §14/§15 に決着を追記**（maintenance-review PR-6）。§14 の
  解決済み未決2件（ドッキング初期スコープ→M7/M8 段階リリース、REST エラー
  フォーマット→ErrorBody + response.rs のステータス写像。バージョニングは未導入と明記）
  に [x] と決着先を記入。§15 に M0〜M9 完了印と「M10 以降は roadmap」の誘導。
  ヘッダを v0.7 → v0.8。

- 保守レビュー 2026-08（ドキュメント整理統合の実測プラン + 保守性再点検）を
  [docs/maintenance-review-2026-08.md](docs/maintenance-review-2026-08.md) に追加（#148）。
- 消失文書への参照46箇所を実在参照へ修復（#149、maintenance-review PR-1）:
  i18n-plan 参照を conventions §13 / ADR-0005 へ、CR-6/CR-7/AD 系の定義を
  maintainability-review §7 追補へ、spec §6.4「チャートデザインルール」新設、
  `spec §3.7/3.8` → `attachments-plan §3.7/3.8` 正規化、conventions §12 に
  参照文法表。Cargo.lock の v1.2.0 追随も同 PR。
- 追随更新とアーカイブ（maintenance-review PR-2）: review-2026-07-29 /
  improvements / improvement-plan-2026-07 を `docs/history/` へ凍結移動し、
  現役バックログを roadmap §3 に一本化。publishing.md の決着済み経緯を
  `docs/history/publishing-github-packages-2026-07.md` へ切り出し。
  visual-refresh plan/design・scaffold-presets-plan の状態ヘッダを実装済みに
  更新（§7 未決事項の決定結果を追記）。AGENTS.md の CI 記述・オプション一覧・
  不変条件要約（§13）を実態化しレビュー記録の索引を新設。conventions
  §1/§3/§4/§6/§9 のピンポイント追随（CR-6 後の rule 8・CSP 2定義同期・app 層
  生値の例外規約ほか、en 同時）。README の壊れた箇条書き修復 + システム情報
  カード追記、README.en にライブデモ URL と要約宣言。CHANGELOG v1.2.0 節に
  PR 番号を対応付け、版比較リンクを新設。

## [1.2.0] - 2026-08-12

**v1.2.0 — UI / デモ拡充テーマ。** ツリービュー（新規オプションパッケージ
`@banto/tree-svelte` + 削除可能なデモ配線）、システム情報カード + バージョン表示、
PWA（installable-only）、通知 `warning` 種別 + サーバ発通知（`Notice`）レシピ、
積立棒グラフのデモを追加。**いずれも後方互換（追加的で破壊的変更なし。既存の
公開 API・両経路の挙動は不変、依存追加ゼロ）** のため minor リリース。以下は
v1.1.0 以降のマージ分。

### Added

- **積立棒グラフのデモを追加**（#145、`@banto/charts` の `BarChart` stacked）。ダッシュボードに
  「カテゴリ別在庫（価格帯積立）」パネルを追加し、上位カテゴリの在庫を価格帯(低/中/高)で
  積み上げる（集計は `dashboard.ts` の `stockByCategoryPriceBand`、純関数・壁時計非依存）。
  これで README が挙げる全14チャート種が Pages ライブデモで実際に描画される（従来は積立が
  `StackedAreaChart` のみで、棒の stacked バリアントだけデモ未掲載だった）。
- **ツリービュー `@banto/tree-svelte`**（#143 パッケージ + #144 デモ配線。新規オプションパッケージ、利用者要望）。
  依存ゼロのヘッドレスコア（`core/` の純関数: 可視行フラット化・move/reparent・
  三状態チェック計算・リネーム patch、全て単体テスト済み）+ 薄い Svelte 5 (Runes)
  UI。`BantoTree` は展開/折りたたみ・単一/複数選択・三状態チェックボックス・
  遅延読み込み・ドラッグ並べ替え/親子変更・インライン名前変更に対応し、`columns`
  で階層データグリッド（tree-grid）化。`TreeSelect` はポップオーバー型の選択入力
  （`popover="auto"` でトップレイヤ + light-dismiss）。**依存追加ゼロ・パッケージ間
  import なし**（`@banto/grid-svelte`/`forms` の型は構造ミラーで非 import）。
  テンプレート本体には**削除可能なデモ配線**付き（サイドバー「ツリービュー」=
  `/tree` デモページ。ライブデモでも到達可。サンプルデータ `treeSample.ts`・
  `treeMessages()` ブリッジ・`nav.tree`/`tree.*` 文言を含む）。ナビ追加に伴い
  サイドバーが写る認証ページのビジュアル回帰ベースラインを再生成
  （`.github/workflows/visual-baselines.yml`）。テスト 37 件（コア/状態/コンポーネント）。
- **システム情報カード + バージョン表示**（#140、M-review 2026-08 §2.4「縮小版⑤」）。
  設定画面に admin 専用の「システム情報」カードを追加し、稼働中バージョン・
  マイグレーション版・DB 方言/レイテンシ・稼働時間・アクティブ LAN セッション数・
  添付ファイル容量を表示する。バックエンドは新サービス
  `banto_admin_services::system_info::SystemInfoService`（DB 専用・transport 非依存、
  best-effort 項目は None に劣化）と、両経路対称な `GET /api/system/info`（admin、
  読み取りのため非監査）+ Tauri `system_info` コマンド。`AuthState::session_count()`
  を追加。**依存追加ゼロ**（`std::time::Instant` でレイテンシ/稼働時間、既存 sqlx で
  クエリ）。従来 UI のどこにも出ていなかったバージョンをこのカードで可視化。
  なお CI の rust ジョブ（check/clippy/test）に欠落していた `-p banto-admin-services`
  を追加した（theme C でのクレート追加時からの漏れ）。
- **PWA（installable-only）**（#141、M-review 2026-08 §2.8）。LAN ブラウザ配信に
  Web マニフェスト（`static/manifest.webmanifest`）+ アイコン（192/512/512-maskable、
  提灯モチーフ）を同梱し、「ホーム画面に追加」/インストールでアプリのように起動可能に。
  `app.html` に manifest link・apple-touch-icon・theme-color・apple-mobile-web-app
  メタを追加。埋め込み LAN サーバが `.webmanifest` を正しく配信するよう
  `banto-server` の `guess_mime` に `application/manifest+json` arm を追加。
  Service Worker（オフライン）は非対応。**依存追加ゼロ**（アイコンはコミット済み静的
  アセット）。ブラウザはセキュアコンテキストでのみインストールを提供するため、標準の
  平文 HTTP LAN では機能せず HTTPS/localhost/TLS リバースプロキシ配下が前提
  （ADR-0003）。`rename.mjs` が manifest の name/short_name も追随。
- **通知に `warning` 種別を追加 + サーバ発通知（`ServerEvent::Notice`）のレシピ化**
  （#142、M-review 2026-08 §2.5 の「無料部分」）。`@banto/admin-core` の `NotificationKind`
  を `success`/`error`/`info` に **`warning`** を加えた4種に拡張（後方互換な union
  拡張。`events.ts` の `notice` レベル照合と `ToastHost` の `.toast.warning`
  スタイル（warning トークン）を追加）。既に配線済みだが未使用だった
  `ServerEvent::Notice { level, message }` の**発火例**を `banto-server` の doc
  コメント（doctest）+ SSE 配信テストで示し、README に「通知（トースト）」レシピ節
  （自タブ `notify('warning', …)` / 全クライアント一斉 `ServerEvent::Notice`
  ブロードキャスト）を追加。永続通知センターは引き続き非スコープ（§2.5）。**依存追加ゼロ**。

### ドキュメント

- 外部AIレビュー（ChatGPT）の機能スコープ提案を実測で検証・取捨した棚卸しを
  [docs/feature-review-2026-08.md](docs/feature-review-2026-08.md) に追加（#139）。
  roadmap §3 v2 バックログに **API Token / Service Account**（既存ロール紐付け設計）
  を追加し、updater / バックアップアーカイブへ設計上の但し書き参照を付した
  （実装は伴わない実需ドリブンのバックログ整理）。

## [1.1.0] - 2026-07-30

**v1.1.0 — V2 拡張テーマ（PostgreSQL アプリ全体対応 / i18n レイヤ② / コピー面積
縮小）を完了。** [roadmap.md](docs/roadmap.md) §3 の v2 バックログ3テーマを実装。
いずれも**後方互換**（既定は SQLite・表示ロケールは日本語のまま挙動 byte 等価、
移設したサービスは再エクスポートで旧パス保持）のため minor リリース。以下は
v1.0.0 以降のマージ分。

### Added

- **テーマA: PostgreSQL アプリ全体対応**（#106–#109）。サービス層を
  `sqlx::SqlitePool` から `banto_storage::Db`（enum ディスパッチ）へ抽象化し、
  `Dialect` で SQL 方言差（プレースホルダ・日付関数）を吸収。マイグレーションを
  `migrations-sqlite/` + `migrations-postgres/` に方言分割し、`db::init_db_from_target`
  が `BANTO_DB=postgres://…` で PostgreSQL 経路を選択（既定は SQLite で無改変）。
  CI に実 `postgres:16` で app 層 CRUD を検証する `app-postgres` スモークを追加。
  backup/restore は SQLite 専用として維持（Postgres ハンドルは明示エラー）。
- **テーマB: i18n レイヤ②**（#110–#113, #75, [ADR-0005](docs/adr/0005-i18n-paraglide.md)）。
  UI 多言語化ランタイムに **Paraglide JS (inlang)** を採用（ADR-0002 の意図的例外）。
  app 層の可視文言を全キー化（`messages/{en,ja}.json`・英語一次）、設定画面に
  言語切替 UI、ロケール解決/永続化を `locale.ts`（既存 provider 層に相乗り）。
  既定表示は日本語で視覚回帰ゼロ。conventions §13 +「app 層に生の日本語リテラルなし」
  の機械検査 `raw-jp-in-app` を追加。visual ベースライン手動再生成ワークフロー
  `visual-baselines.yml` を追加。
- M24 デモ配線（#74）: `@banto/charts` の積立エリア/ガントをダッシュボードデモに追加。
- 保守者向け中核ドキュメントの英語版（#119）: `conventions.en.md` / `AGENTS.en.md` /
  `recipes/add-resource.en.md` / ADR 各 `.en.md`（日本語一次・英語追随）。

### Changed

- **テーマC: コピー面積縮小**（#114–#117）。テンプレート採用者がコピー保守する
  汎用サービス層を新クレート **`banto-admin-services`**（settings/audit/rbac/users/backup）
  へ、汎用 REST ルータ（auth/users/audit/backups/ui_settings）を **`banto-server::routes`**
  へ移設（約4,700行）。`admin-template-core` は再エクスポートで旧パスを保持し
  REST/Tauri wiring は無改修、両経路対称（rule 8）は移設前と数値一致。依存方向
  `admin-template-core → banto-server → banto-admin-services → banto-storage → banto-core`。
  `items.rs`（デモ固有）は据え置き。
- ドキュメント整合（#118）: V2 リファクタ後の canonical ドキュメント/コード doc
  コメントを実装に合わせて更新（マイグレーションパス・DB 対応状況・クレート一覧・
  移設サービスの所在・`SqlitePool`→`Db`）。
- 依存更新（Dependabot・#47/#50/#55/#57/#59/#96/#97/#105）: vite / vite-plugin-svelte /
  sha2 / npm・cargo minor-patch グループ / GitHub Actions 各種。

### Fixed

リリース前のテンプレート実用性レビュー（`docs/review-2026-07-29.md`）で発見した所見に対応。

- **[出荷ブロッカー] i18n ビルドの CDN 依存 + fail-open**（#121）。inlang/Paraglide の
  コンパイル時プラグインが `project.inlang/settings.json` で jsdelivr CDN URL 参照になっており
  （lockfile 外・毎ビルド取得）、取得失敗時に空カタログを exit 0 で出力（fail-open）→ 実行時に
  画面が落ちる問題を修正。プラグインを devDependency（コンパイル時のみ・実行時依存ゼロ）として
  ローカル化、`scripts/check-i18n-nonempty.mjs` で「メッセージ0件なら異常終了」する fail-closed
  ガードを追加、CI に CDN 遮断ビルドの `i18n-offline` ジョブを追加。閉域網/社内プロキシ（README の
  ターゲット）でのビルド再現性を確保。
- **Tauri コマンドのテストがどの CI でも実行されていなかった**（#122）。`tauri-check.yml` に
  `cargo test -p admin-template` を追加（`cargo check` だけで実行されていなかった 8 テストが
  走るように。両経路対称の認可/監査の実行検証が復活）。
- **`scaffold.mjs` のプリセット除去パターンのドリフト**（#122）。#74（M24 デモ配線）と i18n
  キー化で `removeCharts`/`removeGlass`/report ボタン除去のアンカーが陳腐化し、`--preset
minimal`/`standard` が失敗していたのを現行コードに追随させて修正（3プリセットで
  scaffold→check 緑）。`template-acceptance` がフロントのみの変更で起動しないため潜在していた。
- scaffold をユーザー導線に露出（#122）: `pnpm scaffold` スクリプト + README（日英）/AGENTS
  （日英）に導線。e2e の `afterAll` を `page?.close()` 化、README にセッション再起動消失の注記。

## [1.0.0] - 2026-07-28

**v1.0.0 — 安定版リリース。** 仕様 M0〜M9 + ロードマップ M10〜M24 までの
汎用管理画面テンプレートとしての機能が出そろい、v1 スコープを完了。以降の
拡張テーマ（PostgreSQL アプリ全体対応 / i18n レイヤ②③ / コピー面積縮小）は
[roadmap.md](docs/roadmap.md) §3「v2 / 将来構想バックログ」に集約。0.1.2 からの
差分は破壊的変更なし（安定版としての昇格）。以下は 0.1.2 以降のマージ分。

- feat (P4-5): `banto-storage` に PostgreSQL 接続ヘルパ `postgres.rs`（`connect`、
  接続プール、feature `postgres`）を追加。`list_query` の Postgres 対応（既存）
  と合わせて storage クレートが Postgres 接続可能に（接続のみ）。アプリ層
  （`apps/admin-template/core`）は仕様どおり SQLite 専任のまま（§12.1/§548）。
  CI に `postgres:16` サービスコンテナで実接続する `storage-postgres` ジョブを追加
- feat (P4-9): プリセット・スキャフォールダ `scripts/scaffold.mjs`
  （`--preset minimal|standard|full`）を追加。コピー直後にプリセットで不要な
  オプション資産（charts / dock / Glass+vibrancy / コマンドパレット / 添付 /
  帳票）を README「オプション資産の削除」手順どおりに削除する（ship-full /
  remove-only、コアは非対象）。rename.mjs のファイル編集エンジンを
  `scripts/lib/template-edit.mjs` に共有抽出。`template-acceptance.yml` に
  3プリセット × ビルド緑（scaffold → install → check/build/cargo check /
  verify:architecture）の受け入れマトリクスを追加（依存追加なし）
- fix (P4-9, follow-up #94): `scaffold.mjs` の attachments 除去を
  `apps/admin-template/core/src/rest/tests.rs` にも適用し、全プリセットで
  `cargo test` が緑になるよう修正（従来は minimal/standard で削除済みクレート
  参照によりテストがコンパイル不能だった）。`template-edit.mjs` に章末ブロックを
  EOF ごと消す冪等ヘルパ `cutToEnd` を追加。`template-acceptance.yml` の
  presets マトリクスを `cargo check` → `cargo test` に強化
- feat (scaffold-presets-plan §7.3): `scripts/scaffold.mjs` に `--interactive`
  （`-i`）を追加。プリセット（minimal/standard/full）または資産ごとの
  残す/削除を対話で選ばせた上で、`--preset` と全く同じ削除ロジック・確認表示
  を実行する（`--preset` の非対話動作はバイト単位で不変）。依存追加なし
  （`node:readline/promises` のみ、conventions §3）。pipe された非 TTY stdin
  でも `question()` の既知の取りこぼしを避けるため async イテレータで
  1行ずつ読む方式を採用し、軽量テスト `scripts/scaffold.test.mjs` から
  駆動できるようにした
- feat (#89, AD-2): **GitHub Pages ライブデモを公開**（<https://tyaro.github.io/banto/>、
  InMemory デモ・admin/admin）。アプリを **base-path 対応**にし（`$app/paths` の
  `base` を全内部遷移へ付与。`BASE_PATH` 既定 `''` で Tauri/LAN ビルドは完全不変）、
  `deploy-demo.yml` ワークフロー（`BASE_PATH=/banto` ビルド → deploy-pages）を追加。
  README 冒頭にライブデモリンクを追加
- docs (#90, AD-3): OG ソーシャルプレビュー画像 `docs/assets/og-image.png` を追加
- ci (#91): `deploy-demo.yml` の Pages アクションを Node 24 版へ bump（Node 20 deprecation 解消）
- ci (#92): 全ワークフローの `checkout` / `setup-node` を Node 24（v7）へ bump（Node 20 警告解消）
- ci (#99): `pnpm/action-setup` を v6 へ bump（最後の Node 20 警告を解消）
- docs (#101): `ui-framework-spec.md` §5.3 ウィンドウ分離を「実装済み」に追随更新
  （`panel_open` の real `WebviewWindow` + `popout.ts`、`isTauri()` ガードで両経路対称）
- docs (#102, P4-6): `improvements.md` の履歴分離を完了。解決済み4項目（P3-3/P4-1/
  P4-2/P4-3）を `docs/history/improvements-archive.md` へ移設しスタブ化
- docs (#103): `roadmap.md` §3「v2 / 将来構想バックログ」を新設し大物残項目
  （PostgreSQL 全体対応 / i18n ②③ / コピー面積縮小）を隔離。**v1（M0〜M24）スコープ完了**を宣言

## [0.1.2] - 2026-07-23

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
（[improvements.md](docs/history/improvements.md) §0/§1/§2.1/§2.2/§3.2）。

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

[unreleased]: https://github.com/tyaro/banto/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/tyaro/banto/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/tyaro/banto/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/tyaro/banto/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tyaro/banto/compare/v0.1.2...v1.0.0
[0.1.2]: https://github.com/tyaro/banto/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/tyaro/banto/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tyaro/banto/releases/tag/v0.1.0
