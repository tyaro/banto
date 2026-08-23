# Banto 保守者向け規約 — 変えてはいけない不変条件

> English: [conventions.en.md](conventions.en.md)

対象読者: **このテンプレート自体を保守・機能拡張する人**（トラックA）。
テンプレートから自分のアプリを作る利用者向けの手順は
[README](../README.md) 側（トラックB）にある。両トラックの区別は
[README「ドキュメントの2トラック」](../README.md#ドキュメントの2トラック)を参照。

位置づけ: 各モジュール冒頭の doc コメントに散在していた「なぜこう書くか」の
規約を、機能追加のたびに参照できるよう1箇所に集めたもの。ここに書いた項目は
**機械（lint/型/CI）では強制しきれず、レビューで守る不変条件**に限る。一般的な
言語スタイル（命名・整形）は eslint/prettier/clippy/rustfmt に委ねており、本書の
対象外。

ドキュメントの3分類（2026-07-19 追記、improvement-plan P4-7）: 「なぜ」は
3つに役割分担する — **コードコメント**（その場でしか意味を持たない局所的な
理由）/ **本書**（横断的な不変条件＝守るべきルール）/
**[ADR](adr/README.md)**（代替案を比較して1つを選んだ設計判断＝なぜその
ルールにしたか）。本書の各不変条件の背後にある「なぜ」で、代替案の比較を
伴うものは対応する ADR から辿れる（例: §1・§2 → [ADR-0001](adr/0001-rest-tauri-two-path-symmetry.md)、
§3 → [ADR-0002](adr/0002-minimal-dependencies.md)）。同じ「なぜ」を2箇所に
書かない。

機械検査（2026-07-19 追記、improvement-plan P3-5）: 本書のうち機械検査
可能な項目は `pnpm verify:architecture`（`scripts/verify-architecture.mjs`、
CI の frontend ジョブで強制）が検査する。対象は各節に **[機械検査済み]** と
注記した — それ以外は引き続きレビューで守る。意図的な例外はコード内の
正当化コメント + スクリプトの許可リスト（理由付き）のペアで管理する。

削除可能性: 本書はトラックA の資産であり、アップストリームを追わず
**ハードフォークして独自進化させる**なら丸ごと削除してよい（テンプレートの
「すべては削除可能」方針に従う）。アップストリームを追い続ける／テンプレートを
保守し続けるなら残す。

参照の書き方: 行番号は変化するため、本書は原則**ファイル + シンボル名 + 仕様節**で
参照する。実際のコードが一次情報であり、食い違いがあればコードを正とする。

---

## 1. REST と Tauri の判定対称性 [機械検査済み: mutating 操作の両経路存在]

すべての mutating 操作（create/update/delete/import/login/logout/setup）は、
**REST 経路と Tauri 経路の両方で同一の認可と同一の監査を通す**。origin
（`"rest"` / `"tauri"`）だけが異なる。

- REST: `banto-server` `routes/mod.rs` の `RoleGuard` / `require_role_at_least`
  + `record_write`（V2 テーマC PR-C4 で `admin-template-core` `rest/mod.rs` から
  移設。アプリ側 `rest/items.rs`・`rest/attachments.rs` はこれを import して使う）。
- Tauri: `src-tauri/src/lib.rs` の `require_role`（doc コメントに
  「mirrors REST's `RoleGuard`」と明記）+ 各コマンドの `audit.record(...)`。
- 対応表は `rest/mod.rs` のモジュール doc（仕様 M14）にある。
- **読み取り系（list/get）は両経路とも監査しない**。denied 記録は
  「認証済みだがロール不足」のみ。無セッション（Unauthorized）は記録しない
  — この判断も両側で揃える。

機能追加時: 新しい mutating コマンドを片方の経路にだけ足さない。両経路 +
両経路の denied を必ずペアで実装・テストする（template-scope §6 チェックリスト④⑤）。

**機械検査（`verify:architecture` rule 8、CR-1）**: mutating 操作が REST/Tauri
両経路に存在することを、`scripts/verify-architecture.mjs` の `DUAL_PATH`
マニフェスト + 完全性チェックで担保する。新しい Tauri コマンド / REST ルートを
分類（dual-path / desktop-only / read）に足さない限り CI が落ちるため、**片方の
経路にだけ足すミスは必ず捕捉される**。宣言済みの対は**ロール床（認可レベル）も
rule 8 が両経路で照合する**（CR-6。`DUAL_PATH` の `role` フィールド +
読み取り系の `ROLE_READ`）。機械検査の対象外は**監査記録の同一性**
（同じ `AuditEntry` 形状か）のみで、そこはコード + テストで担保する。
desktop-only / read の分類判断は maintainability-review-2026-07.md §3 に根拠。

**監査記録の canonical 形状**（機械検査外＝コード+テストで揃える規約。逸脱は
maintenance-review-2026-08 §5.3 で実測・是正済み）:

- **`resource` は操作対象で決める。** audit-log の**保持ポリシー設定**
  （`audit_config_get`/`apply`）は監査ログ本体ではなく設定の読み書きなので、
  成功・denied とも `resource: "settings"`（監査ログ本体を読む
  `audit-log/list` だけが `"audit_log"`）。REST では `audit_log_router` を
  list / config の2ガードに分けて実現。denied と成功で `resource` を揃えると、
  管理者が resource でフィルタしたとき拒否と成功が同じ束に入る。
- **`entity_id` は「対象の実体名」。** backup 系は必ずバックアップファイルの
  実名（`backups_create` / 既存ファイルからの restore は `Some`、アップロード
  からの restore はサーバ採番前で実体名が無いので `None` + `detail.fileName`）。
- **denied の `detail` は経路で非対称を許容する。** REST は RoleGuard
  ミドルウェアの都合で `{method, path}` が付くが Tauri は `None`。denied は
  「操作が実行されなかった」記録なので監査の主眼は「誰がどの `resource` へ
  拒否されたか」であり、個別操作の特定は不要（実行された操作は成功時の
  `action`/`entity_id` に残る）。この非対称は意図的。
- **REST のログインは argon2 前スロットルでロックアウト中の試行（429）を
  記録しない**（`login_failed` は verifier 到達時のみ）。監査ログ自己 DoS を
  避けるための意図的な非対称で、Tauri 経路（ローカル入力・スロットル無し）は
  全失敗を記録する。ロックアウト自体はレート制限器の状態として別途観測できる。

## 2. サービス層は tauri / axum / RBAC / HTTP を知らない [機械検査済み: tauri/axum 非依存のみ]

全サービス（`ItemsService` / `AuditLogService` / `BackupService` /
`SettingsService` / `UsersService` / `banto-attachments` の
`AttachmentsService`）は同じ形を守る:

- `#[derive(Clone)]`（`Db`（Arc-backed なプールの enum ラッパ）/
  `broadcast::Sender` / `PathBuf` は Arc-backed か read-only で clone が安い）。
- `Result<_, BantoError>` を返す。`tauri` / `axum` に依存しない。
- 認可・監査・イベント通知は**呼び出し側（REST/Tauri の wiring 層）が付ける**。
  サービスは actor / RBAC / HTTP を知らない（`audit.rs` doc:
  「This service does not know about actors, RBAC, or HTTP」）。

効果: サービスは `cargo test` で `:memory:` プールから直接叩ける。各サービスの
`#[cfg(test)] mod tests` がこの形を前提にしている。新サービスもこの契約を守る。

## 3. 依存を足さない（自前実装の文化）

ワークスペース（ルート `Cargo.toml`）は依存を厳選し、以下を**入れていない**。
それぞれ自前実装で代替している:

| 引きたくなる依存 | 代わりに | 実装箇所 |
|---|---|---|
| `chrono` / `time` | 手書きの日付変換 | `backup.rs` の `iso_datetime_from_system_time` / `compact_stamp`。Howard Hinnant の `civil_from_days` は3箇所に移植（`banto-attachments`・`backup.rs`・app `core/src/db.rs`。4箇所目が生えたら `banto-core` への一本化を判断する） |
| MIME 検出ライブラリ | マジックバイト判定 | `banto-attachments` `detect_mime`（下記§6） |
| `multipart` | 生バイト body + `?fileName=` クエリ | `banto-server` `routes/backups.rs`・app `rest/attachments.rs` のアップロード |
| `tower-http` | `axum::middleware::from_fn` の手書き | `security_headers.rs` / `csrf.rs` |
| markdown ライブラリ | 自前パーサ + エスケープ | `packages/report/src/core/{parse,bind,html}.ts`（deps 空） |
| `tracing` | `eprintln!` | `audit.rs` |

規約: 上記のどれかを引きたくなったら、それは設計判断であり**議論の対象**。
安易に追加しない（バイナリ肥大・監査面拡大・利用者のコピー負荷を避ける）。

判断基準（2026-07-18 追記、improvement-plan-2026-07.md P1-5）: 目的は
「依存ゼロ」ではなく**総保守コストの最小化**。以下に複数当てはまる場合は
依存の採用を前向きに検討する:

- 自前実装が肥大化する（目安: 100〜200行超、または仕様拡張が始まった）
- セキュリティ境界に関係する（自前だと脆弱性修正を自力で追う必要がある）
- Unicode・日時・暗号・パーサ等、エッジケースが多い領域
- crate/パッケージが十分成熟している（メンテ実績・依存の少なさ）
- feature 限定で必要部分だけ引ける
- バイナリ/バンドルの増加量を測定して許容範囲と確認済み

逆に、どれにも当てはまらない小さな自前実装は現状維持でよい。既存の
自前実装（§3 の表）を予防的に置き換えることはしない — 各実装が上記に
実際に該当し始めた時点で個別に判断する。

個別の「足すか否か」の保留判断は ADR に残す（代替案比較込み）:
**サーバログ（`tracing` を入れず `eprintln!`）は [ADR-0004](adr/0004-server-logging-eprintln.md)**、
**LAN の TLS（rustls を入れずリバースプロキシ終端）は [ADR-0003](adr/0003-tls-via-reverse-proxy.md)**。
いずれも「今は足さない・再検討条件つき」の Accepted。

**依存を足す側の例外も ADR に残す**: UI i18n ランタイムに Paraglide JS を引く判断は
[ADR-0005](adr/0005-i18n-paraglide.md)（本表・本方針は維持したまま、i18n に限った
意図的な例外。コンパイル時 i18n で実行時依存は極小・型安全という P1-5 基準での採用）。
i18n は app 層のみで、`@banto/*` には辞書も i18n 依存も入れない（§5）。

## 4. コア → オプションの逆依存禁止 [機械検査済み]

コア（`admin-core` / `grid-svelte` / `forms` / `theme`）はオプションを import
しない。依存方向は「シェル→オプション 可、オプション→コア 可、
**コア→オプション 不可**」。**コア/オプションの正準リストは
[template-scope.md §3](template-scope.md) の表**（ここに列挙を複製しない —
複製はドリフト源。機械検査 rule 2/6 は `packages/` を動的走査するため
新パッケージも自動で対象になる）。

現状の担保:

- 全 `packages/@banto/*` の `dependencies` / `peerDependencies` は空。
- パッケージ間の `from '@banto/...'` import はゼロ。
- `theme/banto.css` の「charts/dock がこのトークンを消費する」等はコメントで
  あって import ではない。

オプションを同梱するときは template-scope §3 の表に行を追加し、
**削除手順（外すファイル一覧）を明文化する義務**を負う。削除して他が壊れない
構造を保つ（§6 チェックリスト②③）。

## 5. パッケージはアプリ固有 import を持たない [機械検査済み: `$lib` import のみ]

`packages/@banto/*` のコンポーネントは `sessionStore` や
`@banto/admin-core` の `ProviderError` 等の**アプリ固有シンボルを import しない**。
transport は `client: XxxClient` のように注入する（例: `AttachmentsPanel` は
`AttachmentsClient` を受け取り、`attachmentsAdmin.ts`（アプリ側＝コピーして
書き換える層）を package からは決して import しない）。

状態所有権: ロード/空/エラー状態はコンポーネント内部が所有し、ホストページに
分岐を漏らさない（grid-svelte と同じ規則）。

## 6. セキュリティ不変条件（横断）[機械検査済み: 一部（mime 無し / settings 対称）]

これらは「守らないと脆弱性になる」種類の規約。ランタイムガードが無い項目は
**全 call site のレビューで担保する**。

- **MIME はマジックバイト判定。クライアント申告を使わない。** `banto-attachments`
  `detect_mime` は `image::guess_format` のマジックバイトで4フォーマットに限定、
  それ以外は `application/octet-stream`。`NewAttachment` は `mime` フィールドを
  持たない（申告を受け取りすらしない）。**[機械検査済み: `NewAttachment` に
  mime フィールド無し（rule 9）]**
- **ファイルパスにユーザー入力を使わない。** 添付本体は行 id で命名し、`file_name`
  は表示専用。バックアップは `safe_backup_path` がセパレータ・`..`・
  `[A-Za-z0-9._-]` 外を全拒否（Content-Disposition 注入・Windows 予約名も同時に
  封じる）。添付は `validate_file_name` が同種の検査。
- **重い検証（argon2）の前にスロットルする。** `auth.rs` `login_rate_limited` は
  per-(IP+username) と per-IP の2次元スロットルを argon2 verifier の**前**に通す
  （username ローテーション flood での DoS 対策）。回帰テスト
  `per_ip_dimension_bounds_a_username_rotation_flood` が「ロックアウト中は argon2 を
  呼ばない」ことを検証。
- **`DefaultBodyLimit` は service 層チェックの上に置く。** transport 上限は
  service 層の実チェック（`MAX_ATTACHMENT_BYTES` 等）より「快適に上」であればよい
  という順序（`rest/mod.rs` の doc とルータ各所）。
- **security headers ミドルウェアは最外層（LAST）に適用する。** `/api/*` と静的
  フォールバックを merge した後に付けることで、新ルートが opt-in を忘れても
  ヘッダが漏れない構造にする（`security_headers.rs`）。
- **監査 detail に秘密を入れない。** password / hash / bearer token を `detail` に
  絶対入れない。ランタイムガードは無く**レビューで担保**。key/value ストアは
  key のみ記録し value は入れない（`settings_set`）。
- **settings の生 key/value 読み取りは admin 対称。** `settings_get` は
  `settings_set` と対称に admin ゲート（任意 key を読めるのは書けるのと同格の
  権限）。UI 設定だけは別コマンド `ui_settings_get`（viewer 可・自名前空間限定）に
  分離する。「同一ストアでも権限の非対称を作らない」。**[機械検査済み:
  `settings_get`/`settings_set` が同一 Admin ゲート（rule 9）]**
- **SQL 列はホワイトリスト経由のみ。** フロント由来のフィールド名は必ず
  `ColumnMap`（`list_query.rs`）で SQL 列に解決し、値は必ずバインドする（文字列
  補間しない）。未知フィールドの sort は無視、filter は hard error。
  `ListParams` を受けるサービス（現状 items / audit）に `column_map()` を置く
  （固定 ORDER BY のみのサービスには不要）。
- **CSP は2定義を同期する。** デスクトップは `tauri.conf.json` の
  `app.security.csp`、LAN は `banto-server` の `security_headers.rs`
  `CONTENT_SECURITY_POLICY`。**意図的な差分は connect-src のみ**（Tauri IPC）で、
  それ以外はディレクティブ単位で一字一句一致させる（根拠と `unsafe-inline` が
  必要な理由は `security_headers.rs` 冒頭の doc が一次情報）。編集自体は手動だが、
  **connect-src 以外のディレクティブのドリフトは `verify-architecture.mjs` rule 12 が
  CI で捕捉する**（[ADR-0008](adr/0008-machine-check-stop-gate.md)。cross-check
  テストが無く src-tauri も非コンパイルのため、静かに片方だけ緩む退行を防ぐ）—
  どちらかを変えるときは両方を更新する。

## 7. `{@html}` は自前生成の全エスケープ済み出力のみ [機械検査済み: 使用箇所の許可リスト]

`{@html}` の使用は最小限に留め、**自前で生成・全エスケープした安全な文字列**に
限る。現状の2箇所:

- `report/src/ReportView.svelte`: 自前エンジン `renderHtml` の出力のみ。
  `html.ts` は全 text/attribute を例外なくエスケープし、`javascript:` src も
  ブロック（「no 'trusted' string anywhere in this module」）。
- `settings/+page.svelte`: `qrcode` クレート生成の SVG（LAN 接続 QR）。

外部由来・未エスケープの文字列を `{@html}` に流さない。

## 8. Svelte 5 runes の落とし穴

`@banto/*` のコンポーネントで踏みやすい罠。`AttachmentsPanel.svelte` が実例:

- **`$effect` は意図した依存だけを追い、副作用は `untrack` で囲う。** effect 内で
  読み書きする state がトラッキング対象に入ると `effect_update_depth_exceeded`
  （無限ループ）になる。reload 系の同期プレフィックスは `untrack()` で囲む。
- **object URL は所有者が revoke する。** `createObjectURL` した URL は reload /
  teardown / download の `finally` で必ず revoke（`attachmentsAdmin.ts`:
  「Callers own the returned URL's lifetime」）。
- **非同期レースは loadToken で無効化する。** `++loadToken` で superseded な
  リクエストを検出し、結果を破棄して取得済み URL を revoke する。

## 9. テーマトークンのみ・生値は theme に集約 [機械検査済み: packages の色値のみ]

UI CSS は `var(--banto-*)` トークンのみを使い、色・寸法の**生値をコンポーネントに
書かない**。生値の集約先は `packages/theme/src/css/banto.css`。glass プリセットは
`backdrop-filter: var(--banto-backdrop, none)` のようにオプトインで効かせる
（visual-refresh-design.md）。適用範囲の注記: 機械検査（rule 5 raw-colors）が
走査するのは `packages/` のみ。app 層（`apps/admin-template/src`）の生値は
**正当化コメント付きの意図的例外としてのみ**許容する（login のブランド面・
テーマプレビューの静的スウォッチ等が既存例。理由コメント無しの生値は書かない）。

## 10. 3-way provider 分岐 + demo は明示拒否

環境分岐は `tauri` / `server` / `demo` の3種を `getBantoMode()` で判定し、
**provider 層（`*Admin.ts` / setup）に閉じる**。UI コンポーネントは環境分岐を
持たない。demo モードは InMemory 実装を作らず `DEMO_MODE_MESSAGE` で拒否する
（ブラウザ単体で backend 機能を使わせない）。一部操作のモード制限
（download/upload は server 限定、folder は tauri 限定 等）も provider 層で表現。

## 11. マイグレーションの流儀

- 連番ファイル名（`0001_items.sql` … `0006_attachments.sql`）を `sqlx::migrate!`
  で埋め込み実行。V2「PostgreSQL アプリ全体対応」以降、方言ごとに2系統に分岐:
  `apps/admin-template/core/migrations-sqlite/`（従来の DDL を後方互換のため
  byte 等価で維持）と `.../migrations-postgres/`（同一スキーマの Postgres 厳密
  型版: `BIGINT GENERATED BY DEFAULT AS IDENTITY` / `BOOLEAN` / TEXT 時刻列は
  `now()::text` 既定 等）。`db::run_migrations` が接続のバックエンドで振り分け。
  **2系統のファイル名/連番の対称は `verify-architecture.mjs` rule 11 が CI で
  捕捉する**（[ADR-0008](adr/0008-machine-check-stop-gate.md)。PG CI は smoke のみで
  各 `sqlx::migrate!` はディレクトリ独立のため、片系統だけ足すと静かに欠落する。
  同名ペア内の型差は上記の意図的分岐でレビュー担保）。
- **テーブル定義はアプリが所有**。`banto-attachments` は自前マイグレーションを
  持たず、テスト内の `CREATE TABLE` を `0006_attachments.sql` と同期させる
  （「MUST be kept in sync」）。
- リストア検証（`REQUIRED_TABLES`）は Banto 基盤が所有する `settings` / `users` /
  `audit_log` の**テーブル存在のみ**確認し、列は見ない（粗いが安価な「Banto の
  DB か」判定）。派生アプリが差し替え・削除する `items` 等のドメインテーブルは
  必須にしない。
- 検証で開いた接続は全パスで `conn.close()`（Windows のファイルロック残り対策）。

## 12. doc コメントは仕様節を参照する

モジュール冒頭と個別の設計判断で仕様節を引き、設計の「なぜ」を仕様に紐付ける
文化を維持する。新モジュールも冒頭で該当仕様節を引く（参照ファイル数は
`rg -l 'spec §|spec M'` で測る。2026-08 時点で Rust 約40 / TS+Svelte 約159）。

**参照の文法**（接頭辞と参照先の対応）。文書を統合・移動・改名する前に、被参照を
**パス形式（`docs/xxx.md`）とラベル/節番号形式（`spec §N` 等）の両方**で `rg`
して数えること（片形式のみの計測は誤判定の実績あり、maintenance-review-2026-08 §2.1）:

| 表記 | 参照先 |
| --- | --- |
| `spec §N` | `ui-framework-spec.md` の §N（**この表記は ui-framework-spec 限定**） |
| `roadmap MN` / `spec MN` | `roadmap.md` の MN 節（M10 以降の実体は roadmap。spec §15 は初期案 M0〜M9 のみ。新規は `roadmap MN` 表記を推奨） |
| `<plan名> §N` | `docs/<plan名>.md` の §N（例 `attachments-plan §3.7`） |
| `conventions §N` | 本書の §N（節番号は不変に保つ） |
| `M-review YYYY-MM §N` | `feature-review-YYYY-MM.md` の §N |
| `CR-N` / `AD-N` | `maintainability-review-2026-07.md`（§4 と §7 追補） |
| `ADR-000N` | `adr/000N-*.md` |

## 13. UI 文言はキー経由（Paraglide）で持つ [機械検査済み: app 層の生日本語リテラル] {#i18n-messages}

§9（色・寸法の生値は theme に集約）の**文言版**。UI に出すテキストは
`messages/{en,ja}.json` のキーに置き、コンポーネントは **Paraglide 経由**
（`import * as m from '$lib/paraglide/messages'` → `m['key']()`）で参照する。
生の文言（日本語リテラル等）をコンポーネントに直書きしない
（[ADR-0005](adr/0005-i18n-paraglide.md)）。

- **対象は app 層のみ**（`apps/admin-template/src`）。`@banto/*` パッケージは
  辞書も i18n 依存も `$lib` import も持たず（§5）、文言は**レイヤ①の
  `messages` props 経由**で注入された解決済み文字列として受け取る
  （レイヤ①注入方式、[ADR-0005](adr/0005-i18n-paraglide.md)）。パッケージに
  `messages/*.json` を置かない。
- base/source ロケールは英語（メッセージの真実源）、既定**表示**ロケールは
  日本語（`locale.ts` の custom-banto 戦略で視覚回帰ゼロ、ADR-0005）。
- ロケール解決・永続化は provider/設定層（`locale.ts`）に閉じる（§10）。
  UI コンポーネントはロケール分岐を持たない。
- ブランド名 "Banto" は翻訳しない。ロケール表示名（日本語 / English）は
  各言語のネイティブ名で持ち翻訳しない（両ロケールで同値のキー）。

現状の担保: `apps/admin-template/src` の `.svelte`（生成物 `paraglide/` と
辞書 `messages/*.json` を除く）にコメント外の日本語リテラルが無いことを
`verify:architecture`（rule `raw-jp-in-app`）が grep で検査する（§9 の
生色値検査と同型）。正当な例外はスクリプトの許可リストに理由付きで追加する。

## 14. `.svelte.ts` ソース配布パッケージは dev optimizer から除外する [機械検査済み]

`@banto/*` はソース配布（`exports` が `./src/index.ts`、`.svelte.ts` を生で出荷。
[publishing.md](publishing.md) / [ADR-0007](adr/0007-derived-app-dev-optimizer-exclude.md)）。
派生アプリでは node_modules 実体になり、Vite dev の依存オプティマイザが `.svelte.ts` を
preprocess せず `svelte.compileModule` に渡して `import type` 等で 500 になる（issue #150）。

不変条件: **`.svelte.ts` を `src/` にソース配布する `@banto/*` パッケージのうち
`apps/admin-template` が依存するものは、`apps/admin-template/vite.config.ts` の
`optimizeDeps.exclude` に必ず列挙する**（新規追加時も同期）。`.svelte` コンポーネント
のみのパッケージ（charts/attachments/report）は preprocess 経路を通るため対象外。
`verify:architecture`（rule `optimizedeps-svelte-source`）が「admin-template が依存し
`.svelte.ts` を持つ `@banto/*`」と exclude リストの一致を機械検査する。

---

## プロセス（別ドキュメントに既出）

- **実施プロセス**（司令塔設計 → タスク分割 → モデル委譲 → 検証 → PR + CI ゲート）:
  [roadmap.md §7](roadmap.md#7-実施プロセス)。
- **機能追加チェックリスト**（4条件判定 / 削除手順明文化 / 逆依存禁止 /
  両経路対称 / admin は 403 + UI 非表示の両方をテスト）:
  [template-scope.md §6](template-scope.md#6-今後の運用ルールと宿題)。
- **拡張の提供形態**（パッケージ + 削除可能デモ + レシピ、runtime プラグイン機構は
  作らない）: [template-scope.md §3.1](template-scope.md#31-今後の機能拡張の提供形態2026-07-15-決定)。
- **配布**（git tag / `path:` 依存での消費）: [publishing.md](publishing.md)。
