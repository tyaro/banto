# 設定の下書き・反映・元に戻す 設計書 — Issue #938

作成日: 2026-11-25
状態: **草案（S0）。§12 の「確かめたい点」はオーナーの判断待ち。実装は未着手**
トラック: 保守者向け（トラックA）
関連: Issue #938、#638・#651（楽観ロックと `conflict`）、#786（`ui_settings` の revision）、#597（監査の差分）、
#697（ユーザー個別の権限）、#935・#936（[アプリ独自の SSE](sse-stream-design.md)）、#793 / [ADR-0035](../adr/0035-detached-writes.md)（書き込みを切断から切り離す）、
[ADR-0034](../adr/0034-owner-identity-builtin-admin.md)（持ち主の作り方・v8 の基準）、
conventions §1 / §2 / §3 / §4 / §6 / §10 / §11 / §12、[template-scope](../template-scope.md) §1・§3・§3.1

この文書の `path` と型の名前は、2026-11-25 の main（`682691ad`）で開いて確かめた。
**新しく足す型・関数・表・ルートの名前は見込み**で、各 PR で決める（決めた形はこの文書へ書き戻す）。

## 0. 判定（template-scope §1 の 4 条件）

**オーナーの判定（2026-11-25）: banto のオプション（template-scope §3）として入れる。**

| #   | 基準       | 判定         | 理由                                                                                                                                                                                                        |
| --- | ---------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 横断性     | 満たす寄り   | 「運用中の設定を、確かめてから切り替える・戻す」は業種を選ばない。ただし、設定を画面からすぐ書き換えて困らないアプリ（多くの小さな管理画面）には要らない。全員が使う物ではないので、コアにはしない          |
| 2   | 削除容易性 | **条件付き** | 表・REST の口・Tauri のコマンドが増える。使わないアプリが外せるように、**外す手順を明文化する**（§10）。コアからこの仕組みを参照しない（conventions §4）                                                    |
| 3   | 代替不能性 | 満たす       | 外の製品（設定の配布の仕組みなど）は、banto の認可・監査・`ServerEvent`・両 DB・Tauri と REST の対に乗らない。アプリごとに作ると、版の衝突・ロック・1 トランザクションの反映を毎回作り直すことになる        |
| 4   | 無ドメイン性 | 満たす     | 扱うのは「対象ごとの JSON」だけ。中身の意味（装置・レシピ・しきい値）は知らない。検証はアプリが関数で渡す                                                                                                   |

1・2 が条件付きなので **オプション**（§3）。提供の形は §3.1 の「パッケージ + 削除可能 + レシピ」に従う。
テンプレートのアプリへどこまで配線するかは §4.1 で比べ、§12 の 1 で決める。

## 1. 用語

- **対象**: 設定のまとまり 1 つ。キー（例 `plc.line1`）で指す。アプリが起動時に登録する。
- **本番**: 対象の、いま動作に使われている JSON。アプリの処理は本番だけを読む。
- **下書き**: 対象の、編集中の JSON。対象ごとに多くて 1 つ。本番の動作には影響しない。
- **版**: 対象ごとに、反映のたびに 1 ずつ増える番号。登録したときの初期値が版 0。
- **元にした版**: 下書きを作り始めたとき（または取り直したとき）の本番の版。
- **反映**: 下書きを本番に差し替え、版を 1 つ進め、履歴に 1 行足すこと。
- **元に戻す**: 過去の版の JSON を、**新しい版として**反映すること（履歴は消さない）。
- **編集のロック**: 対象の下書きを書ける人を 1 人に限る、期限つきの印。サーバーが DB に持つ。
- **revision**: 書き込みのたびにサービス層が作る乱数の文字列（`ui_settings` と同じ）。**クライアントが条件に使うのはこちら**で、版の番号ではない（§4.4）。

## 2. 背景と目的

### 2.1 いま（`682691ad`）

あるもの（使い回す）:

- **楽観ロックと `conflict`（#638・#651）**: `BantoError::Conflict { message, current }`（`banto-core` `error.rs`）。
  線の上では `{ "kind": "conflict", "message", "current"? }`、HTTP は 409（`banto-server` `response.rs`）。
  `items`・`users` は数の `version` を持ち、行を固定して読んでから比べる（SQLite は `BEGIN IMMEDIATE`、PostgreSQL は `SELECT ... FOR UPDATE`。`items.rs` の update）。
  フロントは `conflictOf`（admin-core `form.svelte.ts`）で取り出す。
- **`ui_settings` の revision（#786）**: `ui_settings.rs`。revision は乱数（数にすると、復元や削除の後に古い数が一致してしまう）。
  条件つきの書き込みは判定と書き込みを 1 文で行う（`UPDATE ... WHERE revision = ?` / `INSERT ... ON CONFLICT DO NOTHING`）。conventions §6 に規約。
- **監査と差分（#597）**: `audit::diff::diff_changes`（`banto-admin-services` `audit/diff.rs`）。JSON の**最上位の欄ごと**の `{ field, before, after }`、
  秘密の欄は `{ field, masked: true }`（欄名は必須の引数）、長い文字列は `MAX_VALUE_CHARS`（200 字）で切る。
  表示は app 層の `src/lib/resource/AuditChanges.svelte` と `auditChanges.ts`（`{ field, before, after }` / `{ field, masked }` の形を読む）。
- **監査の主体**: ガードが作る `AuditActor`（`username`・`id`・`role`・`kind`）。経路は `origin`（`"rest"` / `"tauri"`）。REST は `record_write`、Tauri は `record_ok`。
- **`ServerEvent`**: `ResourceChanged { resource }` と `Notice { level, message }` の 2 種類（`events.rs`）。`#[non_exhaustive]` ではない。
  フロントの `isAppEvent` は知らない `kind` を捨てる。Tauri の画面には、同じ broadcast を `banto://event` へ流すタスクが届ける（`src-tauri/src/lib.rs`）。
  `/api/events` は**認証済みの全セッション**（閲覧公開の grant を含む）に届く。
- **ユーザー個別の権限（#697）**: `PermissionKey`・`PermissionCatalog`（`permissions.rs`。テンプレートの登録は空）、
  REST の `PermissionGuard` / `require_permission`、Tauri の `require_permission`。両経路の対は `verify:architecture` rule 8 の `PERMISSION_PAIRS`。
- **両 DB**: サービスは `banto_storage::Db`（`Sqlite` / `Postgres`）を match で書き分ける（conventions §2）。表の定義はアプリの
  `migrations-{sqlite,postgres}/` が持ち、クレートは migration を持たない（§11）。いまの最後は `0015_auth_mode_defaults.sql`。
- **持ち主の作り方**: `routes/ui_settings.rs` の `owner_of`（grant は kind、アカウントは stamp の `users.id`。名前からは作らない）。
- **時刻の差し替え**: `banto-server` の `auth/state.rs` に、試験で進められる `Clock`（`pub(super)`）がある。`banto-admin-services` には無い。

無いもの（この設計で足す）: 本番と下書きの分離、反映の履歴、元に戻す、編集のロック、JSON のパスごとの差分。

### 2.2 目的（Issue の完了の条件）

1. 下書きの保存・反映・元に戻す・下書きの破棄が API でできる。
2. 版の衝突、ロックの期限切れ・取り合いを試験で確かめられる。
3. 反映・元に戻すが監査と `ServerEvent` に出る。

### 2.3 やらないこと

- 画面（編集中の表示、差分の確認）。アプリごとに作る（Issue の補足）。banto は API と薄い読み口まで。
- 3 者のマージ（2 人の変更を自動で合わせる）。衝突したら人が差分を見て取り直す（§4.6）。
- 複数の対象をまとめた 1 回の反映（対象をまたぐトランザクション）。要るなら対象を 1 つにまとめる。
- 承認の流れ（申請 → 承認者の許可）。編集と反映の権限を分けられるところまで（§4.9）。
- 反映の予約（時刻を決めて反映）、履歴の自動の削除。
- 既存の `settings`・`ui_settings` をこの仕組みへ移すこと。運用設定（`auth.*`・`server.*`）は今のまま。
- **既存の DB からの移行**。v8 は互換不要・DB 作り直しの方針なので、表は新しい migration で足すだけ（§4.5）。

## 3. conventions との関係

本文を読んで、この設計が触れるものだけを挙げる。

| 節                                 | 触れ方                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 REST と Tauri の対              | 書き込み（下書きの保存・破棄・取り直し、ロックの取得・返却・解除、反映、元に戻す）は**全部、両経路に対で作る**。認可と監査は同じ、違うのは `origin` だけ。監査の detail は両経路が同じ関数で作る（`users` の update と同じやり方）。対は `DUAL_PATH`（権限で守るなら `PERMISSION_PAIRS`）に足す（§4.9・§7 の S4）          |
| §1 順序（確定 → 監査）             | 反映は 1 トランザクションで確定し、その後に監査、最後に `ServerEvent`。監査の主体はガードのスナップショット（`AuditActor`）。REST は層が書き込みを最後まで走らせる（ADR-0035）ので、handler は包まない。本文の上限は上げない（2 MiB 未満。§4.3）ので、照合し直しは要らない                                             |
| §2 サービス層                      | `ConfigDraftsService` は `Clone`、`Result<_, BantoError>`、`Db` を持ち、axum・tauri・RBAC を知らない。**誰が**（履歴の列・ロックの持ち主）は配線が作って渡す値で、サービスは記録と照合に使うだけ（認可には使わない）。イベントも配線が送る                                                                              |
| §3 依存を足さない                  | **足さない**。JSON の差分・パスは自前（`serde_json` だけ）。乱数は `ui_settings.rs` と同じ `OsRng`                                                                                                                                                                                                                     |
| §4 逆依存                          | コア（`admin-core` の既存の部品、`resource/`）はこの仕組みを import しない。admin-core に足す読み口（§5）は、ほかの部品から参照しない独立のファイルにする                                                                                                                                                              |
| §6 監査 detail に秘密を入れない    | 差分は秘密のパスを**必須の引数**で受けてマスクする（`diff_changes` と同じ決まり）。対象の登録で秘密のパスを必ず渡させる（空なら空と書く）。監査 detail には JSON の全体を入れず、差分（切り詰め済み）だけを入れる                                                                                                      |
| §6 settings の読み書きは同格       | 下書き・本番・履歴を**読む**口にも権限を付ける（既定は admin）。書ける人より広く読ませる既定にしない                                                                                                                                                                                                                   |
| §6 条件つきの書き込み              | クライアントの条件は revision（乱数）。判定と書き込みは、対象の行を固定した 1 トランザクションの中で行う（§4.6。`ui_settings` の「1 文で」と同じ狙いを、行の固定で満たす）                                                                                                                                             |
| §6 持ち主はセッションの種類から    | ロックの持ち主は `owner_of` と同じ規則で配線が作る（名前・要求の中身からは作らない）                                                                                                                                                                                                                                   |
| §10 3-way provider                 | 読み口は http と tauri の 2 つ。demo は作らず、アプリの provider 層が `DEMO_MODE_MESSAGE` で断る                                                                                                                                                                                                                       |
| §11 マイグレーション               | 表はアプリが持つ。両方言に同じ番号・同じ名前で足す（rule 11）。クレートの試験は同じ `CREATE TABLE` を写して持つ（`ui_settings.rs` と同じ）。リリース済みの migration は触らない                                                                                                                                        |
| §12 doc コメント                   | 新しいモジュールの冒頭で `config-draft-publish-design §N` を引く                                                                                                                                                                                                                                                       |
| §13 文言                           | admin-core は文言を持たない。サービスのエラーの文は既存の流儀（`CONFLICT_MESSAGE` など）に合わせ、画面の文言はアプリのキー                                                                                                                                                                                             |

公開 API は**足すだけ**の見込み（minor）。`ServerEvent` に変種を足す案は採らない（§4.8）。

## 4. server 側

### 4.1 案の比較（どこまで banto が持つか）

|                            | 案 A: クレート + レシピ（テンプレートに配線しない）                                                         | 案 B: クレート + テンプレートに配線（消せる形）                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| banto に入る物             | サービス、REST のルーター、admin-core の読み口、レシピ（表の定義・Tauri のコマンドの見本）                  | 案 A に加えて、migration `0016`（両方言）、REST の配線、Tauri のコマンド（`[scaffold:config-drafts]` の印）、`DUAL_PATH` の行、scaffold で外す処理   |
| REST と Tauri の対（§1）   | Tauri 側はレシピの見本だけ。**機械検査（rule 8）も `tauri-check` も掛からない**。派生アプリごとに写し間違える | テンプレートで対を持ち、rule 8 と `tauri-check` が見る                                                                                               |
| 両 DB の試験               | クレートの中（表の定義を写して持つ。PostgreSQL は `pg_audit_spool` と同じ形の試験を足す）                   | 加えて、本物の migration に対する試験（`ui_settings_cases` と同じ形）                                                                                |
| 外す手順                   | 配線していないので、アプリ側に外す物は無い                                                                  | scaffold と手作業の手順が要る。`template-acceptance` が毎回確かめる                                                                                  |
| 保守の重さ                 | 軽い                                                                                                        | 重い（`src-tauri/src/lib.rs` にコマンドが 10 個ほど増える。scaffold の印の内外を保つ義務）                                                           |
| テンプレートの画面         | 無し                                                                                                        | 無し（対象の登録は空。権限のカタログが空なのと同じ。ナビも足さないので基準画像は変わらない）                                                         |

**推奨: 案 B。ただし段を分け、S1〜S3（クレートと読み口）は案 A・B で同じ物にする**（§7）。
この仕組みの要は「REST と Tauri の両方で、同じ認可と同じ監査で反映できる」ことで、案 A だとその対が機械検査の外に出る。
オーナーの判定（削除容易性は条件付き・外す手順の明文化が要る）も、配線して消せるようにする形を前提にしている。
重さが見合わないと判断するなら案 A（S4 を「レシピだけ」にする）。どちらでも S1〜S3 は変わらない。

### 4.2 置き場所

- サービス: `crates/banto-admin-services/src/config_drafts.rs`（`pub mod config_drafts`）。依存は増えないので、cargo の feature では囲まない（§12 の 2）。
- パスごとの差分: `crates/banto-admin-services/src/audit/diff.rs` に `diff_changes` の隣の関数として足す（§4.7）。
- REST: `crates/banto-server/src/routes/config_drafts.rs` の `config_drafts_router(..)`。アプリが `/api` の層の内側に載せる。
- 表: アプリの `migrations-sqlite/0016_config_drafts.sql`・`migrations-postgres/0016_config_drafts.sql`（案 B。案 A ならレシピに本文を載せる）。
- Tauri: `apps/admin-template/src-tauri/src/lib.rs` の `// [scaffold:config-drafts]` の区画（案 B）。

### 4.3 対象の登録とアプリの読み口

対象は、権限のカタログ（`PermissionCatalog`）と同じく**起動時に組み立てて、後から変えない**。

- キーは `PermissionKey` と同じ字種（小文字・数字・`_`、`.` 区切り、64 バイトまで）。区切りは 1 つでも無くてもよい。
- 登録に渡す物: キー、初期値（JSON。最上位は**オブジェクト**に限る）、秘密のパスの一覧（必須の引数）、検証の関数（任意）。
- 値の大きさは 256 KiB まで（`MAX_CONFIG_VALUE_BYTES`。`ui_settings` は 64 KiB）。HTTP の本文の上限（2 MiB）は上げない。
- **起動時に `ensure_targets()` を呼ぶ**（migration の後）。登録済みの対象で行が無いものに、版 0 の本番の行と履歴の行を 1 トランザクションで入れる
  （`INSERT ... ON CONFLICT DO NOTHING`）。こうする理由は 2 つ:
  1. 本番の行が必ずあるので、書き込みはその行を固定して直列にできる（§4.6）。
  2. **コードの初期値を変えても、本番は変わらない**。初期値は「最初の 1 回の種」で、その後の変更は必ず反映を通る（履歴に残る）。
- 登録から外した対象の行は消さない（読めなくなるだけ。API は 404）。

アプリの処理は**本番だけ**を読む。下書きを返す関数とは名前で分ける。

- `published(target)` → 値（JSON）・版・**revision**・反映した時刻。`published_as::<T>(target)` → 型に写した値・版・**revision**・反映した時刻（`PublishedConfigAs<T>`。`published` と同じ形で、同じ 1 行の 1 回の読み取りから返す。revision を別に読むと、並行の反映で古い値と新しい revision が組み合わさる）。
- 読むのは `config_published` の 1 行（主キー）。途中の状態は見えない（反映は 1 トランザクション）。
- 変わったことは、配線が送る `ServerEvent::ResourceChanged { resource: "config:<対象>" }` を同じ broadcast から受けて読み直す（§4.8）。
  **知らせは「すぐ読み直す合図」で、届くことを当てにしない**（コミットの後に送るので、切断・受け手の遅れ（broadcast の `Lagged`）・プロセスの終了で落ちうる）。
  動作中に本番へ追いつく処理は、次の 4 つを全部持つ: (1) 起動のときに読む、(2) 知らせで読む、(3) 受け手が遅れた・つなぎ直したら読む、
  (4) **周期でも版を比べる**（知らせを全部落としても、周期 1 回ぶんの遅れで追いつく）。
- **追跡の印は revision で、版の大小ではない**。処理は「いま採っている本番の revision」を持ち、読んだ revision がそれと違えば採る。
  版は対象ごとに単調だが、それは**同じ復元の世代の中だけ**の話で、バックアップの復元で版は戻る（§11）。「いまより版が大きいときだけ採る」にすると、
  前の高い版を覚えたままの処理（サービスの再起動をまたいで生きる外の読み手を含む）は、復元された本番をいつまでも採れない。
  revision は反映のたびに作る乱数で、復元された行の revision は、復元の前に採っていた物と一致しない。これが世代の識別になる（別の世代の ID の列は足さない）。
- **遅れて返った古い読み取りを採らない方法は、版の比較ではなく、読み手の側の順序**にする: 読み取りは 1 本の直列の流れで行うか、
  並べて行うなら読み手が始めた順の番号を付け、**最後に始めた読み取りの結果だけ**を採る（前に始めた読み取りの結果は、後から返っても捨てる）。
- **起動・つなぎ直し・受け手の遅れの後は、前の追跡の状態（持っていた revision・版・進行中の読み取り）を捨ててから読み直す**。
  復元は必ずアプリの再起動を伴う（予約された復元は起動時に当てる）ので、プロセスの中の読み手は起動の読み取りで追いつく。
  外の読み手は、つなぎ直しで同じことをする。周期の照合も revision の違いで採るので、どれを取りこぼしても 1 周期で追いつく。
- **DB の反映の成功は、装置・処理への適用の成功ではない**。反映の応答・履歴・監査が言うのは「本番の JSON が変わった」まで。
  処理が実際に採った版を見せたいアプリは、採った版を自分の状態として持って出す（banto はその欄を持たない）。
  サービスは通知の口を持たない（§2）。

### 4.4 版と revision

- **版**（`BIGINT`）は対象ごとの連番。反映のトランザクションの中で「本番の行の版 + 1」。
  履歴の主キー `(target, version)` が、同じ版が 2 回書かれないことを DB でも保証する。
  本番の行も履歴も消さないので、番号は戻らない・使い回さない。`items` の `VERSION_BUMP` のような巻き戻し（上限で 1 に戻す）は入れない
  （`i64` の上限には届かない。届いたら反映を断る）。
- **revision**（乱数 32 桁の 16 進。`ui_settings.rs` の `new_revision` と同じ作り）を、本番の行と下書きの行がそれぞれ持つ。書き込みのたびに作り直す。
- **クライアントが送る条件は revision だけ**にする:
  - 下書きの保存・破棄 → `ifRevision`（下書きの revision。下書きが無いときは `"0"`）。**省略できない**。
  - **最初の保存（`ifRevision: "0"`）と取り直し → `ifPublishedRevision` も要る**（画面が編集・比較に使った本番の revision）。
    サーバーが採る「元にした版」を、利用者が実際に見た本番に結び付けるため（§4.6）。
  - 反映 → `ifDraftRevision`（差分を確かめた下書きの revision）。
  - 元に戻す → `ifPublishedRevision`（画面が見ていた本番の revision）。
- 版の番号を条件にしない理由は conventions §6 と同じ: バックアップの復元で番号が戻ると、開いたままの画面が持つ古い番号が、別の中身の同じ番号に一致しうる。
  revision は一致しない。**版の衝突の判定そのもの**（下書きの「元にした版」と本番の版の比較）は、両方とも DB の中の値なので、復元しても食い違わない。

### 4.5 DB のスキーマ

表は 4 つ。時刻の列以外は両方言で同じ（SQLite は `INTEGER`、PostgreSQL は `BIGINT`。時刻の既定は `datetime('now')` / `now()::text`）。
下の本文は PostgreSQL の形。JSON は **TEXT**（`serde_json` の文字列）で持つ。`JSONB` にしないのは、両方言で同じ文字列を保ち、DB が欄の順や数の表記を変えないようにするため。

```sql
-- 本番: 対象ごとに 1 行。ensure_targets が版 0 で入れ、以後は消さない。
CREATE TABLE config_published (
    target       TEXT PRIMARY KEY,
    value        TEXT NOT NULL,
    version      BIGINT NOT NULL,
    revision     TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT (now()::text)
);

-- 履歴: 版ごとに 1 行。value は「その版の本番」。追記だけ。
CREATE TABLE config_history (
    target         TEXT NOT NULL,
    version        BIGINT NOT NULL,
    value          TEXT NOT NULL,
    kind           TEXT NOT NULL,          -- 'initial' | 'publish' | 'revert'
    reverted_to    BIGINT,                 -- kind = 'revert' のとき、戻した先の版
    actor_username TEXT,                   -- 'initial' は NULL
    actor_id       BIGINT,                 -- 外部キーにしない（アカウントより長く残る。audit_log と同じ）
    actor_kind     TEXT,
    origin         TEXT,                   -- 'rest' | 'tauri'
    comment        TEXT,
    published_at   TEXT NOT NULL DEFAULT (now()::text),
    PRIMARY KEY (target, version)
);

-- 下書き: 対象ごとに多くて 1 行。反映・破棄で消える。
CREATE TABLE config_drafts (
    target       TEXT PRIMARY KEY,
    value        TEXT NOT NULL,
    base_version BIGINT NOT NULL,
    revision     TEXT NOT NULL,
    updated_by   TEXT NOT NULL,            -- 表示用の名前（スナップショット）
    updated_at   TEXT NOT NULL DEFAULT (now()::text)
);

-- 編集のロック: 対象ごとに多くて 1 行。期限が過ぎた行は「無い」と同じ。
CREATE TABLE config_locks (
    target        TEXT PRIMARY KEY,
    holder        TEXT NOT NULL,           -- 'acct:<users.id>' | 'grant:<kind>' | 'local'
    holder_name   TEXT NOT NULL,           -- 表示用の名前（スナップショット）
    lease         TEXT NOT NULL,           -- 取得のたびに作る乱数（lease ID。延長では変えない）
    acquired_at_ms BIGINT NOT NULL,
    expires_at_ms BIGINT NOT NULL          -- Unix ミリ秒（サービスの時計。§4.6）
);
```

- 履歴の `value` は「その版の本番」を 1 つだけ持つ。版 N の**反映前**は版 N−1 の行の `value` なので、Issue の「反映前・後の JSON」は 2 行で揃う。
  前後を 1 行に 2 つ持たないのは、同じ JSON を 2 回持たない・前後が食い違う行を作れないようにするため。
- 本番の `value` は履歴の最新の行と同じ物を重ねて持つ（アプリの読み口を 1 行の読みにするため）。同じトランザクションで書き、試験で一致を確かめる。
- バックアップ（SQLite の `VACUUM INTO`）は 4 表を同じ時点で写す。`REQUIRED_TABLES`（復元の検査）には**足さない**（オプションなので、外したアプリのバックアップも通す）。
- v8 は互換不要なので、既存の DB への配慮は要らない。v8.0.0 のタグの後なので、足し方は「新しい連番を足す」だけ（§11）。

### 4.6 書き込みの規則（衝突・ロック・1 トランザクション）

**対象ごとの直列化**: 書き込みは全部、最初に対象の本番の行を固定する。

- SQLite: `begin_with("BEGIN IMMEDIATE")`（`items.rs`・`users.rs` と同じ）。
- PostgreSQL: `SELECT ... FROM config_published WHERE target = $1 FOR UPDATE`（行は `ensure_targets` で必ずある）。

固定した後は、同じ対象のほかの書き込みは待つので、「読んで比べて書く」をトランザクションの中で安全に行える。対象が違えば互いに待たない（PostgreSQL）。

**時刻の出どころ**: ロックの期限は**サービスの時計**（Unix ミリ秒）で決め、SQL には値として渡す（`expires_at_ms > $now`）。

- 既定は `SystemTime::now()`。`ConfigDraftsService::with_clock(..)` で差し替える（試験は `AtomicI64` を進める。眠らない）。
- DB の時計（`datetime('now')` / `now()`）を使わない理由: SQLite は秒の刻みで、試験で差し替えられない。
- 期限の長さは `with_lock_ttl(..)`。既定は 5 分（§12 の 6）。画面は期限の 1/3 ごとに延長する（lease ID つき）（下書きの保存も期限を延ばす）。

**ロックの規則**:

| 操作                         | 条件                                                                                 | 結果                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 取得                         | 行が無い、期限切れ、または持ち主が自分                                               | 持ち主を自分にし、**新しい lease ID** を作り、期限を `now + ttl` にする。ほかの人が有効に持っていれば `conflict`（`reason: "lock_held"`、`current` に持ち主の名前と期限） |
| 延長                         | **持ち主が自分**で、かつ**送った lease ID が、有効な（期限内の）行と一致する**       | 期限を `now + ttl` にする。lease ID は変えない。どちらかが違う・期限切れなら `conflict`（`lock_required`）。**延長は取り直さない**（失効の後は、画面が改めて取得する） |
| 返す                         | **持ち主が自分**で、かつ送った lease ID が行と一致する                               | 行を消す。どちらかが違えば何もしない（成功。古いタブの遅れた返却が、取り直した新しいロックを消さない。ほかの人のロックも消さない） |
| 解除（管理者）               | 権限 + **画面で見た lease ID が行と一致する**                                        | 行を消す。監査に残す。下書きは消さない。一致しなければ `conflict`（`lock_held`、`current` にいまの持ち主。見た相手と違う人のロックを消さない） |
| 下書きの保存・破棄・取り直し | **自分が有効に持っている**                                                           | 持っていなければ `conflict`（`reason: "lock_required"`。期限切れもこれ）               |
| 反映・元に戻す               | ほかの人が有効に持って**いない**（空き、期限切れ、または自分）                       | ほかの人が持っていれば `conflict`（`reason: "lock_held"`）                             |

- 持ち主は**アカウント**（`acct:<users.id>` など）で、セッションやタブではない（§12 の 5）。同じ人の 2 つのタブは両方とも下書きの書き込みを通るが、
  下書きの `ifRevision`（必須）が、後から書いた方を `conflict` にする。
- **ロックそのものの操作（延長・返却・解除）は、取得ごとの lease ID で限る**。lease ID は「どの取得か」の条件で、本人の確かめではない（状態を読める人には見える）ので、**延長・返却は持ち主の一致と lease の一致の両方**を見る。ほかの人のロックに触れられるのは、解除の権限を通った管理者の解除だけ。持ち主だけで決めると、古いタブの遅れた返却や延長が、
  同じ人が取り直した新しいロックを消したり延ばしたりする。下書きの revision は文書の衝突のための物で、これは防げない。
  同じ人がもう 1 度取得すると lease ID が変わるので、前のタブの延長は `lock_required` で止まる（画面は「ほかの画面で編集を始めた」と出す）。
  下書きの `ifRevision`（必須）が、後から書いた方を `conflict` にする。
- 期限切れの行は掃除しない（次の取得が上書きする）。サーバーが止まっても、行は期限で自然に無効になる。

**下書きの規則**:

- 最初の保存（`ifRevision: "0"`）が下書きを作る。**`ifPublishedRevision` が本番の revision と一致するときだけ**作り、その本番の版が「元にした版」になる。
  違えば `conflict`（`reason: "published_changed"`、`current` に本番の版と revision）。画面が開いてから保存までに本番が進んだ場合を、ここで止める。
- **状態と差分は、同じスナップショットから出す（API の契約）**。状態（`GET /api/config/{target}`）は、本番・下書き・ロックを **1 つの SQL 文**
  （`config_published` に `config_drafts`・`config_locks` を `LEFT JOIN`）で読む。差分も、比べる 2 つの値とその revision を 1 つの SQL 文で読む
  （「本番 → 下書き」は本番と下書きの行、「本番 → 版 N」は本番と履歴の行）。トランザクションで囲むだけでは足りない:
  PostgreSQL の既定の READ COMMITTED は文ごとにスナップショットを取るので、`SELECT` を分けると時点がずれる。
  1 文にすれば両 DB とも分離レベルに頼らずに揃う（分離レベルを上げる案は採らない。SQLite と書き方が分かれるため）。
- **差分の応答は、比べた物の印を必ず載せる**: `publishedRevision`・`publishedVersion` と、`draftRevision`（「本番 → 版 N」のときは `toVersion`）。
  画面は、**表示した差分の応答に載っていた revision**を、反映・取り直し・元に戻すの条件にそのまま使う（別の読み取りで得た revision と組み合わせない）。
- 保存は、ロックを確かめ、revision を比べ（違えば `conflict`、`reason: "draft_changed"`、`current` にいまの下書き）、値と revision を書き、ロックの期限を延ばす。
- 保存のときは**大きさと形（最上位がオブジェクト）だけ**を確かめる。検証の関数は呼ぶが、結果は返すだけで保存は通す（書きかけを保存できるように）。**反映では検証を通らなければ断る**（422 `validation`）。
- 破棄は下書きの行を消す（ロックは持ったまま）。
- **取り直し**（rebase）: 本番が先に進んだ下書きの「元にした版」を、**画面が差分で確かめた本番**の版に付け替える（値は変えない）。
  条件は `ifRevision`（下書き）と `ifPublishedRevision`（確かめた本番）の両方で、トランザクションの中で照合する。本番がその後さらに進んでいれば
  `conflict`（`published_changed`）で、付け替えない（確かめていない変更を「見た」ことにしない）。
  **成功すると下書きの revision を作り直す**（取り直しの前に開いた反映の画面の `ifDraftRevision` は、古くなって通らない）。
  差分はいつも「いまの本番 → 下書き」なので、付け替える前に見れば「反映すると相手の変更をどう上書きするか」が見える。
  人が見て確かめた、という操作を 1 つの口にする（自動のマージはしない）。

**反映（1 トランザクション）**:

1. 対象の本番の行を固定して読む（版・値・revision）。
2. 下書きを読む。無ければ `not_found`。`ifDraftRevision` と違えば `conflict`（`draft_changed`）。
3. 下書きの「元にした版」が本番の版と違えば `conflict`（`reason: "stale_base"`、`current` に本番の版と revision）。→ 画面は取り直しへ。
4. ロックを確かめる（上の表）。
5. 検証の関数を通す（422）。本番と同じ値なら断る（`bad_request`。変更の無い版を作らない）。
6. 履歴に 1 行足す（版 = 本番の版 + 1、`kind = 'publish'`、誰が・どこから）。
7. 本番の行を書き換える（値・版・新しい revision・時刻）。`WHERE target = ? AND version = <読んだ版>` を付け、1 行でなければ失敗にする（二重の守り）。
8. 下書きとロックの行を消す。
9. コミット。戻り値は、新しい版・前の版・差分（マスク済み）。

途中で失敗すれば全部が巻き戻る（本番・履歴・下書き・ロックのどれも変わらない）。両 DB で同じ手順。
検証の関数はトランザクションの中で呼ぶので、**純粋で速い関数**に限る（I/O をしない。doc コメントに書く）。

**元に戻す**: `toVersion`（0 以上、いまの版より小さい）の履歴の行の `value` を、下書きを経ずに同じ手順（1・4〜7・9）で反映する。
`kind = 'revert'`、`reverted_to = toVersion`。条件は `ifPublishedRevision`。

- Issue の言い方（「指定した版の**反映前**の JSON」）とは、「版 N の反映前」＝ `toVersion = N − 1` で同じ物を指す（§12 の 7）。
- 下書きがあれば残す。その下書きは「元にした版」が古くなるので、反映の前に取り直しが要る。
- 戻す値も検証の関数を通す。**いまの検証を通らない古い値には戻せない**（§11）。

**エラーの形**: 新しい `kind` は足さない。衝突は全部 `conflict`（409）で、`current.reason` で分ける
（`stale_base` / `draft_changed` / `published_changed` / `lock_held` / `lock_required`）。`current` には理由ごとのいまの状態を入れる。

### 4.7 差分（JSON のパスごと）

`audit/diff.rs` に、`diff_changes`（最上位の欄ごと。変えない）の隣の関数を足す。

- 1 件の形は同じ: `{ "field": "<パス>", "before", "after" }` / `{ "field": "<パス>", "masked": true }`。
  同じ形なので、`AuditChanges.svelte`・`auditChanges.ts` がそのまま読める（`field` がパスになるだけ）。
- パスは **JSON Pointer**（RFC 6901。`/limits/high`）。キーに `.` を含んでも曖昧にならない。
- オブジェクトは中へ降りる。**配列は 1 つの値として比べる**（中へ降りない。要素の挿入・削除で、番号ごとの差分は読めなくなるため。§12 の 8）。
- 秘密のパスは**出す側で**当てる。差分の 1 件のパス P と秘密のパス S について、**P が S と同じ・S より下・S より上のどれかなら、その 1 件を丸ごと `masked` にする**。
  「S より上」が要る: 配列は 1 つの値として出すので、`/devices/0/token` が秘密でも差分のパスは `/devices` になる。オブジェクトの丸ごとの追加・削除、
  型の変更（オブジェクト → 文字列など）でも、親のパスで値を出す。どの場合も、秘密を含みうる値は出さない（部分だけ伏せる処理は作らない。漏れの余地を残さないため）。
  配列の中の番号つきのパスは、番号を見ずに「その配列が秘密を含む」として扱う。必須の引数。
- 並びはパスの順（安定）。

使い道は 2 つで、切り詰めだけが違う。

- **API の差分**（確かめる画面のため）: 値は切らない（マスクはする）。
- **監査の detail**（`changes`）: `MAX_VALUE_CHARS` で切り、件数にも上限を付ける（超えたら `changesTruncated: true` を添える。上限は S1 で決める）。JSON の全体は入れない。

### 4.8 監査と知らせ

| 操作                         | 監査                                                                                                               | `ServerEvent`                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 反映                         | `action: "publish"`、`resource: "config"`、`entity_id: <対象>`、detail = `{ version, previousVersion, comment?, changes }` | `ResourceChanged { resource: "config:<対象>" }`     |
| 元に戻す                     | `action: "revert"`、同上 + `revertedTo`                                                                            | 同上                                                |
| ロックの解除（管理者）       | `action: "unlock"`、detail = `{ holder: <名前> }`                                                                  | `ResourceChanged { resource: "config-draft:<対象>" }` |
| 下書きの破棄                 | `action: "discard"`、detail = `{ baseVersion }`                                                                    | 同上                                                |
| 下書きの保存・取り直し、ロックの取得・延長・返却 | **書かない**（本番を変えない。打つたびの保存で監査が埋まる。§12 の 9）                               | 同上（ほかの画面が持ち主・下書きの有無を読み直す）  |
| 拒否                         | ガードが `denied` を書く（既存のとおり）                                                                           | —                                                   |

- 「誰が・いつ・どこから・何を」は**履歴の行**（反映と同じトランザクション）と**監査**の両方に残る。監査の保存が遅れても（spool）、履歴は確定している。
- **`ServerEvent` に変種は足さない**。理由: (1) `ServerEvent` は `#[non_exhaustive]` でないので、変種を足すと下流の `match` が壊れる。
  (2) `/api/events` は閲覧公開のセッションにも届くので、反映した人の名前を載せると、権限の無い相手に見せることになる。
  知らせは「どの対象が変わったか」だけにし、**誰が・どこから**は履歴の口（権限つき）で読む（§12 の 3）。
  Issue の「誰が・どこから・どの対象」を知らせそのものに載せたい場合は、権限つきのアプリの配信（[sse-stream-design](sse-stream-design.md) の土台）で出す道がある（今回は作らない）。
- Tauri の画面には、既存の転送のタスクが同じイベントを届ける（足す物は無い）。

### 4.9 権限

口を 4 つの役目に分け、それぞれにガードを 1 つ付ける。

| 役目   | 口                                                         | 既定  |
| ------ | ---------------------------------------------------------- | ----- |
| 読む   | 一覧、状態（本番・下書き・ロック）、差分、履歴             | admin |
| 編集   | ロックの取得・返却、下書きの保存・破棄・取り直し           | admin |
| 反映   | 反映、元に戻す                                             | admin |
| 解除   | ほかの人のロックの解除                                     | admin |

- **「読む」は、編集・反映・解除の必要条件にする**（その 3 つの口には「読む」のガードも重ねる。両経路とも）。
  編集・反映の口は値を返す（衝突の `current` にいまの下書き、反映の応答に値つきの差分）ので、読めない人に編集・反映だけを許す組み合わせは作らない。
  こうすると「読めない相手には値の無い応答を返す」という分岐が要らず、REST と Tauri で境界がずれない。配線は、役目ごとのガードを渡すときにこの重ねを自動で付ける
  （`ConfigDraftsAccess` が組み立てる。アプリが付け忘れる余地を作らない）。
- ガードは、ロールの床（`RoleGuard`）か権限（`PermissionGuard`、#697）のどちらかを、配線が役目ごとに選ぶ。
  テンプレートは権限を登録しないので、既定は 4 つとも admin。派生アプリは `config.edit`・`config.publish` のような権限を登録して差し替える
  （「編集する人」と「反映する人」を分けられる）。
- **v1 は対象ごとに権限を分けない**（ルーター全体で 1 組。§12 の 4）。ルートの層のガードのままなので、rule 8 の照合（`DUAL_PATH` の `role` / `PERMISSION_PAIRS`）に乗る。
- 権限での拒否は 403 `forbidden` + `denied` の監査（既存のとおり）。
- アプリの処理の読み口（`published`）はプロセスの中の関数で、認可は無い。

### 4.10 公開 API の案（Rust）

```rust
// crates/banto-admin-services/src/config_drafts.rs
pub const MAX_CONFIG_VALUE_BYTES: usize = 256 * 1024;
pub const DEFAULT_LOCK_TTL: Duration = Duration::from_secs(300);
pub const CONFIG_DRAFT_ABSENT_REVISION: &str = "0";

/// 対象 1 つの登録。`masked_paths` は必須（無ければ `&[]` と書く）。
pub struct ConfigTarget { /* key, default, masked_paths, validate */ }
impl ConfigTarget {
    pub fn new(key: &str, default: serde_json::Value, masked_paths: &[&str]) -> Result<Self, BantoError>;
    /// 純粋で速い関数に限る（反映のトランザクションの中で呼ぶ）。
    pub fn with_validator(
        self,
        validate: impl Fn(&serde_json::Value) -> Result<(), Vec<FieldError>> + Send + Sync + 'static,
    ) -> Self;
}

/// 起動時に組み立てて、後から変えない（`PermissionCatalog` と同じ）。
#[derive(Clone, Default)]
pub struct ConfigTargetRegistry { /* Arc<..> */ }

/// 編集する人。配線がセッションから作る（`owner_of` と同じ規則）。認可には使わない。
pub struct ConfigEditor { pub holder: String, pub name: String }

/// 履歴に残す「誰が・どこから」。配線が `AuditActor` と origin から作る。
pub struct PublishStamp<'a> {
    pub actor_username: &'a str,
    pub actor_id: Option<i64>,
    pub actor_kind: &'a str,
    pub origin: &'a str,
    pub comment: Option<&'a str>,
}

#[derive(Clone)]
pub struct ConfigDraftsService { /* db, targets, lock_ttl, clock */ }

impl ConfigDraftsService {
    pub fn new(db: Db, targets: ConfigTargetRegistry) -> Self;
    pub fn with_lock_ttl(self, ttl: Duration) -> Self;
    /// Unix ミリ秒を返す時計（試験で差し替える）。
    pub fn with_clock(self, now_ms: impl Fn() -> i64 + Send + Sync + 'static) -> Self;
    pub async fn ensure_targets(&self) -> Result<(), BantoError>;

    // アプリの処理の読み口（本番だけ）
    pub async fn published(&self, target: &str) -> Result<PublishedConfig, BantoError>;
    pub async fn published_as<T: DeserializeOwned>(&self, target: &str) -> Result<PublishedConfigAs<T>, BantoError>; // value: T は値の型だけ違い、version・revision・published_at は PublishedConfig と同じ

    // 画面のための読み取り
    pub async fn list(&self) -> Result<Vec<ConfigTargetSummary>, BantoError>;
    pub async fn state(&self, target: &str, viewer: &ConfigEditor) -> Result<ConfigState, BantoError>;
    pub async fn diff(&self, target: &str, to_version: Option<i64>) -> Result<ConfigDiff, BantoError>;
    pub async fn history(&self, target: &str, before: Option<i64>, limit: u32) -> Result<Vec<ConfigHistoryEntry>, BantoError>;
    pub async fn history_entry(&self, target: &str, version: i64) -> Result<ConfigHistoryDetail, BantoError>;

    // ロック
    pub async fn lock_acquire(&self, target: &str, editor: &ConfigEditor) -> Result<ConfigLock, BantoError>; // 新しい lease
    pub async fn lock_extend(&self, target: &str, editor: &ConfigEditor, lease: &str) -> Result<ConfigLock, BantoError>; // 持ち主と lease の両方が一致する有効なロックだけ
    pub async fn lock_release(&self, target: &str, editor: &ConfigEditor, lease: &str) -> Result<(), BantoError>; // 同上
    pub async fn lock_force_release(&self, target: &str, if_lease: &str) -> Result<ConfigLock, BantoError>;

    // 下書き（自分のロックが要る）
    /// `if_published_revision` は最初の保存（`if_revision == "0"`）で必須。
    pub async fn draft_put(&self, target: &str, editor: &ConfigEditor, value: &serde_json::Value, if_revision: &str, if_published_revision: Option<&str>) -> Result<ConfigDraftSaved, BantoError>;
    pub async fn draft_rebase(&self, target: &str, editor: &ConfigEditor, if_revision: &str, if_published_revision: &str) -> Result<ConfigDraftSaved, BantoError>;
    pub async fn draft_discard(&self, target: &str, editor: &ConfigEditor, if_revision: &str) -> Result<ConfigDraftDiscarded, BantoError>;

    // 反映（1 トランザクション）
    pub async fn publish(&self, target: &str, editor: &ConfigEditor, if_draft_revision: &str, stamp: &PublishStamp<'_>) -> Result<PublishOutcome, BantoError>;
    pub async fn revert(&self, target: &str, editor: &ConfigEditor, to_version: i64, if_published_revision: &str, stamp: &PublishStamp<'_>) -> Result<PublishOutcome, BantoError>;
}

/// 両経路が同じ監査 detail を作るための関数（`users` の update の detail と同じ置き方）。
pub fn publish_audit_detail(outcome: &PublishOutcome) -> serde_json::Value;
```

```rust
// crates/banto-server/src/routes/config_drafts.rs
/// 役目ごとのガード（§4.9）。既定は 4 つとも admin。
pub struct ConfigDraftsAccess { /* read, edit, publish, unlock: ロールの床か PermissionKey */ }

pub fn config_drafts_router(
    service: ConfigDraftsService,
    access: ConfigDraftsAccess,
    audit: AuditLogService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
) -> Router;
```

### 4.11 REST の口と Tauri のコマンド

`/api/config` で始まるルートは今は無い（`crates/`・`apps/admin-template/core/src` を grep で確かめた）。本文・応答の欄名は camelCase。

| 役目 | REST                                           | Tauri                  | 本文・応答（要点）                                                                                   |
| ---- | ---------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| 読む | `GET /api/config`                              | `config_list`          | 対象ごとの `{ target, version, hasDraft, lock? }`                                                    |
| 読む | `GET /api/config/{target}`                     | `config_get`           | `{ published: { value, version, revision, publishedAt }, draft?: { value, baseVersion, revision, updatedBy, updatedAt }, lock?: { holderName, mine, leaseId, expiresAt } }`。1 回の読み取りで揃える |
| 読む | `GET /api/config/{target}/diff`                | `config_diff`          | 既定は「本番 → 下書き」: `{ publishedVersion, publishedRevision, draftRevision, changes: [...] }`。`?toVersion=N` で「本番 → 版 N」（元に戻す前の確かめ）: `{ publishedVersion, publishedRevision, toVersion, changes: [...] }`。比べた値と印は 1 つの SQL 文で読む |
| 読む | `GET /api/config/{target}/history`             | `config_history_list`  | 新しい順。`?before=<版>&limit=`。値は含めない（誰が・いつ・どこから・種類・コメント）                |
| 読む | `GET /api/config/{target}/history/{version}`   | `config_history_get`   | その版の値と、1 つ前の版からの差分                                                                   |
| 編集 | `POST /api/config/{target}/lock`               | `config_lock_acquire`  | 取得。`{ leaseId, expiresAt }`                                                                       |
| 編集 | `PUT /api/config/{target}/lock`                | `config_lock_extend`   | 延長。`{ leaseId }` → `{ expiresAt }`。失効の後は `conflict`（取り直さない）                         |
| 編集 | `DELETE /api/config/{target}/lock`             | `config_lock_release`  | `?leaseId=`。一致するロックだけ返す                                                                  |
| 編集 | `PUT /api/config/{target}/draft`               | `config_draft_put`     | `{ value, ifRevision, ifPublishedRevision? }`（最初の保存では必須）→ `{ revision, baseVersion, fieldErrors? }` |
| 編集 | `POST /api/config/{target}/draft/rebase`       | `config_draft_rebase`  | `{ ifRevision, ifPublishedRevision }` → `{ revision（新しい）, baseVersion }`                        |
| 編集 | `DELETE /api/config/{target}/draft`            | `config_draft_discard` | `?ifRevision=`                                                                                       |
| 反映 | `POST /api/config/{target}/publish`            | `config_publish`       | `{ ifDraftRevision, comment? }` → `{ version, previousVersion, changes }`                            |
| 反映 | `POST /api/config/{target}/revert`             | `config_revert`        | `{ toVersion, ifPublishedRevision, comment? }` → 同上                                                |
| 解除 | `POST /api/config/{target}/unlock`             | `config_unlock`        | `{ ifLeaseId }`。画面で見たロックだけ外す                                                            |

書き込み 9 つは `DUAL_PATH` の対、読み取り 5 つは `ROLE_READ` の対（ロールの床の対称を見る）に足す（案 B）。
Tauri のコマンドは `require_role`（または `require_permission`）→ サービス → `record_ok` → `state.events.send(..)` の順で、REST の handler と同じ。

## 5. フロント側

画面はアプリごとに作る（Issue の補足）。banto が足すのは、admin-core の**薄い読み口**だけ。

- 置き場所: `packages/admin-core/src/providers/configDrafts.ts`（`uiSettings.ts` と同じ並び）。ほかの部品から import しない。
- `ConfigDraftsProvider`（型）と、`createHttpConfigDrafts({ baseUrl, fetch, .. })`・`createTauriConfigDrafts({ invoke })`。
  §4.11 の口を 1 対 1 で呼ぶだけで、状態は持たない。demo の実装は作らない（conventions §10）。
- `configDraftConflict(error)`: `conflict` の `current.reason` を型つきで取り出す（`uiSettingConflict` と同じ役目）。画面は理由で出し分ける
  （`stale_base` → 差分を見せて取り直し、`lock_held` → 持ち主の名前を出す、`lock_required` → 取り直す、`draft_changed` → 読み直す）。
- 差分の表示: 応答の `changes` は監査の差分と同じ形なので、テンプレートから来たアプリは `src/lib/resource/AuditChanges.svelte` に渡せる
  （欄の名前の引き当ては無く、パスがそのまま出る。見出しを付けたいアプリは自分で引き当てる）。admin-core には表示の部品を足さない。
- ロックの延長（期限の 1/3 ごとに `PUT lock`）、反映の知らせでの読み直し（`resource_changed` の `config:<対象>`）は、レシピに見本を書く。
  延長を admin-core の関数にするかは §12 の 10。

## 6. 試験の方針

サービス層（`config_drafts.rs` の `#[cfg(test)]`。SQLite の `:memory:`、表は写し。時計は `with_clock` で進める）:

- T1 版: 反映のたびに 1 ずつ増える。`ensure_targets` は 2 回呼んでも版 0 を作り直さない。初期値を変えて呼んでも本番は変わらない。
- T2 版の衝突: 下書きを作る → 別の反映（元に戻す）で本番が進む → 反映は `conflict`（`stale_base`）で、本番・履歴・下書きが変わらない → 取り直し → 反映できる。
  取り直しは、確かめた本番の revision が古ければ `published_changed` で付け替えない。成功の後は下書きの revision が変わり、取り直しの前の `ifDraftRevision` での反映は `draft_changed`。
  最初の保存も、開いた後に本番が進んでいれば `published_changed`。
- T3 revision: 古い `ifRevision` の保存、古い `ifDraftRevision` の反映、古い `ifPublishedRevision` の元に戻す、がそれぞれ `conflict`。
  `published_as::<T>()` も `published()` と同じ行から値・版・revision を返し、並行の反映を挟んでも別の時点の物が組み合わさらない（revision は値と一致）。
- T4 ロックの取り合い: A が取得 → B の取得は `lock_held`（持ち主の名前と期限つき）→ B の保存は `lock_required` → B の反映は `lock_held`。 B が A の lease ID を知っていても（状態で読める）、B の延長・返却は A のロックに効かない。
  lease: A のタブ 1 が取得 → タブ 2 が取得（lease が変わる）→ タブ 1 の遅れた返却・延長は新しいロックを消さない・延ばさない。
  失効の後の延長は取り直さない。管理者の解除は、見た lease と違えば消さない。
- T5 ロックの期限: 時計を期限の 1 ミリ秒前・ちょうど・後に進め、境界を確かめる。期限切れの後は B が取得でき、A の保存は `lock_required`。保存が期限を延ばす。
- T6 解除: 管理者の解除の後、B が取得できる。下書きは残る。
- T7 反映が 1 つのまとまりであること: 検証で落ちる・途中で失敗させる（履歴の主キーを先に埋める）→ 本番・履歴・下書き・ロックのどれも変わらない。
  成功の後は「本番の値 = 履歴の最新の行の値」。
- T8 元に戻す: 版 3 まで反映 → `toVersion: 1` → 版 4 ができ、値は版 1 と同じ、履歴は 5 行（0〜4）で 1 行も消えない。いまの検証を通らない値には戻せない。
- T9 差分: 入れ子・追加・削除・`null` と欠けの違い・配列は 1 つの値・秘密のパスより下は `masked` で値が文字列に出ない・切り詰め。
  **秘密を含む親**: 配列の中の秘密（`/devices/0/token`）、秘密を含むオブジェクトの丸ごとの追加・削除、型の変更で、その 1 件が丸ごと `masked` になり、原値が出力の文字列のどこにも無い。
- T10 入力: 知らない対象は `not_found`、オブジェクトでない値・大きすぎる値は断る。

両 DB:

- T11 PostgreSQL（`BANTO_TEST_PG_URL`。`pg_audit_spool` と同じ置き方で CI の `app-postgres` に足す）: T2・T4・T7・T8 を同じ本文で通す。
  **同じスナップショット**（両 DB）: 状態と差分の読み取りがそれぞれ 1 つの SQL 文であること。別の接続で反映・保存を挟み続けながら差分を読み、
  応答の `changes` が、応答に載った `publishedRevision`・`draftRevision` の値どうしの差分と必ず一致する（別の時点の印と組み合わさらない）。
  その印で反映すると通り、1 つ前の印では `conflict` になる。
  加えて、**別々の接続 2 つから同時に反映**して、通るのは 1 つだけ・版は 1 つだけ進む、を確かめる（SQLite もファイルの DB と別々のプール 2 つで同じことを確かめる。`ui_settings_cases` の形）。
- 案 B では、本物の migration `0016` に対して同じ場合を通す（表の写しとのずれを捕まえる）。

REST（`banto-server` の `routes/config_drafts.rs` の試験）:

- T12 役目ごとのガード（読む・編集・反映・解除）の許可と拒否。拒否は 403 + `denied` の監査。
- T13 409 の本文が `{ kind: "conflict", current: { reason, .. } }` であること（理由ごと）。
- T14 反映・元に戻すで、監査が 1 行（`changes` はマスク・切り詰め済みで、秘密の値を含まない）、`ResourceChanged { resource: "config:<対象>" }` が 1 回。
  T9 の「秘密を含む親」の場合を、REST の差分の応答・反映の応答・監査の detail の 3 つで通し、原値が入らないことを確かめる（Tauri は同じ関数を呼ぶ）。
  「読む」を持たないセッションは、編集・反映・解除の口でも 403（409 の `current` や差分から値を読めない）。
  下書きの保存では監査が増えない。
- T15 `tests/public_api.rs` に公開の項目の固定を足す。

Tauri（案 B）: rule 8 の対の照合と `tauri-check`。コマンドの本文は REST と同じ関数（detail・イベント）を呼ぶ形にして、違いを作れなくする。

admin-core: T16 読み口が §4.11 の口・本文・ヘッダーを正しく組むこと、`configDraftConflict` が理由を取り出すこと。

## 7. PR の分け方

1 PR = 1 エージェントで済む大きさ。順序は S1 → S2 → S3 → S4 → S5。S1〜S3 は §12 の 1（案 A・B）に関わらず同じ。

| PR  | 範囲                                                                                                                                                                         | 完了条件                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| S0  | この設計書（文書だけ）                                                                                                                                                       | `pnpm format:check`・リンク検査  |
| S1a | `audit/diff.rs` のパスごとの差分。`config_drafts.rs` の土台: 対象の登録、`ensure_targets`、本番の読み口、ロック（時計の差し替え）、下書きの保存・破棄                        | T1・T3（下書き）・T4〜T6・T9・T10 |
| S1b | 反映・元に戻す・取り直し・履歴・差分の口。PostgreSQL の試験と CI の行                                                                                                        | T2・T3・T7・T8・T11              |
| S2  | `banto-server` の `routes/config_drafts.rs`（ガード・監査・イベント）、`public_api.rs`                                                                                       | T12〜T15                         |
| S3  | admin-core の読み口（`configDrafts.ts`・`index.ts` の輸出・README に 1 節）                                                                                                  | T16、`pnpm check`・`pnpm test`   |
| S4  | 案 B: テンプレートへの配線（migration `0016` 両方言、REST の載せ、Tauri のコマンド、`DUAL_PATH`・`ROLE_READ`、scaffold で外す処理、`template-acceptance` の dry-run の確かめ） | rule 8・rule 11、`tauri-check`、scaffold の 4 プリセット |
| S5  | レシピ `docs/recipes/config-draft-publish.md`（対象の登録、アプリの読み口、画面の作り方の要点、権限の差し替え）、template-scope §3 の表の行、`remove-optional-assets.md` の節、CHANGELOG | リンク検査                       |

案 A なら S4 を作らず、S5 のレシピに表の定義（両方言）と Tauri のコマンドの見本を載せる。
S1 は大きいので 2 つに割る。S1a だけでは反映できないので、**S1a〜S2 は同じリリースに入れる**。

## 8. 下流の使い方の概略

1. 対象を登録する（キー・初期値・秘密のパス・検証）。起動時に migration の後で `ensure_targets()`。
2. 処理は `published_as::<T>()` で読む。起動・`config:<対象>` の `ResourceChanged`・受け手の遅れとつなぎ直し・周期の照合、の 4 つで読み直す。採るかどうかは **revision の違い**で決め（版の大小では決めない。復元で版は戻る）、最後に始めた読み取りの結果だけを採り、起動・つなぎ直しでは前の追跡の状態を捨てる（§4.3）。
3. 権限を分けたいなら `config.edit`・`config.publish` などを登録し、`ConfigDraftsAccess` と Tauri のガードを差し替え、`PERMISSION_PAIRS` に対を足す。
4. 画面を作る: 開く → ロックを取る → 編集して保存（`ifRevision`）→ 差分を見る → 反映。衝突は理由で出し分ける（§5）。
5. 既に自前の設定の表がある下流は、最初の起動で値を初期値として渡して種にする（移行の仕組みは banto に作らない）。

## 9. 残る検討（今回は決めない）

- 履歴の保持（件数・期間で古い版を消す）。消すと、その版には戻せなくなる。要望が出たら、監査の保持の設定に倣って足す。
- 対象ごとの権限（§12 の 4）。
- 権限つきの配信で「誰が反映したか」を知らせること（§4.8）。

## 10. 外す手順（削除容易性）

コアからの参照は無い（conventions §4）ので、外しても残りは壊れない。この節の内容を S5 で `remove-optional-assets.md` と template-scope §3 の表に写す。

**派生アプリが使わないとき（案 B の配線を外す）**。scaffold の `minimal`・`display` はこれを自動で行う（`standard`・`full` は残す。§12 の 11）。

1. `core/migrations-sqlite/0016_config_drafts.sql`・`core/migrations-postgres/0016_config_drafts.sql` を消す（まだ DB を作っていないアプリ。作った後なら、表を残したまま 2 以降だけ行う）。
2. REST の載せ（`config_drafts_router` の 1 行）と、`rest/mod.rs` の対応表の行を消す。
3. `src-tauri/src/lib.rs` の `// [scaffold:config-drafts]` の区画（コマンド・`invoke_handler` の行・状態の欄）を消す。
4. `scripts/verify-architecture.mjs` の `DUAL_PATH`・`ROLE_READ` の config の行を消す。
5. 起動の `ensure_targets()` の呼び出しと、対象の登録を消す。
6. フロントで読み口を作っていれば、その provider のファイルを消す（テンプレートは画面を持たないので、ルート・ナビ・文言キーは無い）。

**案 A のとき**: 配線していないので、アプリ側に外す物は無い。

**banto 本体から外すとき**（オプションをやめる判断をしたとき）: `config_drafts.rs`、`routes/config_drafts.rs`、`providers/configDrafts.ts` とその輸出、レシピ、
上の配線を消す。`audit/diff.rs` のパスごとの差分は、ほかで使っていなければ消す。

## 11. 危うい点

- **アプリが下書きを読んでしまう**: 読み口を名前で分け（`published*` だけが処理向け）、レシピに「処理は `published` だけ」と書く。型で防ぐ手は無い。
- **検証が変わると古い版に戻せない**: 元に戻すは、いまの検証を通す。古い形の値を受ける検証にするか、戻せないことを画面で伝える（422 の `fieldErrors`）。検証を飛ばす口は作らない。
- **検証の関数が遅い・I/O をする**: トランザクションの中で呼ぶので、対象の行（SQLite は DB 全体）を止める。doc コメントとレシピで縛る。
- **時計のずれ・巻き戻り**: 期限はサーバーの壁時計。時計が戻るとロックが長く残る（管理者が解除できる）。PostgreSQL を複数のサーバーで共有すると、
  サーバー間の時計の差だけ期限がずれる（数秒の差は、期限 5 分に対して許す。大きくずれる構成では DB の時計に変える余地を残す）。
- **復元で版が戻る**: 履歴も一緒に戻るので、DB の中は食い違わない。開いたままの画面の条件は revision なので、古い画面の反映は `conflict` になる。
  **版の単調さは復元をまたがない**。本番を追う処理は、版の大小ではなく revision の違いで採り、起動・つなぎ直しで前の追跡の状態を捨てる（§4.3）。
  版の大小で採る読み手を作ると、復元の後に古い設定のまま動き続ける。レシピの見本は revision で書く。
  復元の前に反映した版は消える（バックアップの性質。監査も同じ）。
- **ロックを持ったままの放置**: 期限で外れる。期限を長くしすぎると待たされる。上限を設ける（`with_lock_ttl` は 1 時間まで、など。S1 で決める）。
- **元に戻すと、編集中の人の下書きが古くなる**: 反映で `stale_base` になり、取り直しで気づける。ロックをほかの人が持っている間は元に戻せない（急ぐときは管理者が解除してから）。
- **履歴が増え続ける**: 1 版あたり最大 256 KiB。頻繁に反映する対象は DB とバックアップが太る（§9）。
- **監査と履歴の二重**: 同じ出来事が 2 か所に残る。正は履歴（同じトランザクション）。監査は「誰が何をしたか」の横断の検索のため。
- **Tauri と REST の写し違い**（特に案 A）: detail とイベントを共通の関数にして、コマンドの本文を薄くする。
- **秘密の値**: 履歴と下書きには値の全体が入る（戻すために要る）。読む口は権限つきだが、**秘密そのもの（パスワード・鍵）は対象に入れない**ことをレシピに書く。
  秘密のパスの指定は、差分と監査のマスクのための二重の守り。
- **`/api/events` に対象のキーが流れる**: キーは全セッションに見える。キーに秘密や個人の名前を入れない。

## 12. 確かめたい点（オーナーの判断）

| #   | 決めること                                                         | 推奨                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | テンプレートに配線するか（§4.1）                                   | **案 B（配線して、scaffold で消せる形）**。REST と Tauri の対を機械検査に乗せるため。重さが見合わなければ案 A（クレート + レシピ）。S1〜S3 はどちらでも同じ                                          |
| 2   | cargo の feature で囲むか（§4.2）                                  | **囲まない**。依存が増えないので、囲んでも得るものが無い（`system-metrics` は `sysinfo` を外すための feature）                                                                                       |
| 3   | 知らせの形（§4.8）                                                 | **`ResourceChanged { resource: "config:<対象>" }` だけ**。誰が・どこからは履歴の口で読む。`ServerEvent` に変種は足さない（下流の `match` が壊れる・閲覧公開にも名前が届く）                          |
| 4   | 権限を対象ごとに分けるか（§4.9）                                   | **v1 は分けない**（役目 4 つに 1 組）。分ける要望が出たら、対象の登録にガードを持たせる形で足す（rule 8 の照合の作りも変える）                                                                       |
| 5   | ロックの持ち主（§4.6）                                             | **アカウント**（セッション・タブではない）。同じ人の 2 つのタブは下書きの `ifRevision`（必須）で防ぐ。ロックそのものの操作（延長・返却・解除）だけは取得ごとの lease ID で限る（クロスレビューを受けて足した）。別案: 下書きの書き込みも lease でタブ単位にする（リロードで編集できなくなる）                   |
| 6   | ロックの期限の既定（§4.6）                                         | **5 分**、画面は 1/3 ごとに延長、保存でも延長。上限 1 時間                                                                                                                                           |
| 7   | 元に戻すの指定のしかた（§4.6）                                     | **`toVersion`（その版の時点の本番に戻す）**。Issue の「版 N の反映前」は `toVersion = N − 1` と同じ。画面の「版 3 に戻す」と素直に合う                                                               |
| 8   | 配列の差分（§4.7）                                                 | **配列は 1 つの値として比べる**。別案: 番号ごと（挿入・削除で読めない差分になる）                                                                                                                    |
| 9   | 下書きの保存・ロックの取得を監査に書くか（§4.8）                   | **書かない**（本番を変えない。`ui_settings` と同じ扱い）。破棄・反映・元に戻す・管理者の解除は書く。conventions §1 の対応表にこの例外を書き足す                                                      |
| 10  | admin-core にロックの延長の関数を足すか（§5）                      | **足さない**（S3 は口を呼ぶだけ）。レシピの見本で足り、2 つ目のアプリが同じ物を書いたら足す                                                                                                          |
| 11  | scaffold のどのプリセットで外すか（案 B。§10）                     | **`minimal`・`display` で外す、`standard`・`full` は残す**（添付・帳票と同じ並び）                                                                                                                   |
| 12  | 反映にロックを要るとするか（§4.6）                                 | **「ほかの人が持っていなければ通す」**（編集する人と反映する人を分けられる）。別案: 反映する人が自分でロックを持つことを必須にする                                                                   |
| 13  | 履歴の持ち方（§4.5）                                               | **版ごとに「その版の値」を 1 つ**（反映前は 1 つ前の行）。別案: 1 行に前後 2 つ（Issue の文字どおり。同じ JSON を 2 回持つ）                                                                         |
| 14  | REST の接頭辞と対象の初期値の扱い（§4.3・§4.11）                   | **`/api/config/{target}`**、**初期値は最初の 1 回だけ種にする**（コードの初期値を変えても本番は変わらない）                                                                                          |

未確定のまま残る点（実装で確かめる）: 監査の `changes` の件数の上限、`ConfigDraftsAccess` の形（rule 8 がロールの床・権限を読める書き方）、
`ConfigEditor` と `UiSettingsOwner` の作り方の共通化、下書きの保存の応答に検証の結果をどう載せるか、`history` のページの切り方、
SQLite のファイルの DB で 2 つのプールから同時に反映する試験の安定（`busy_timeout`）。

決めた点（クロスレビュー `b5cd9cfb` を受けて。オーナーの判断は要らない見込み）:

- 最初の保存と取り直しは、画面が確かめた本番の revision（`ifPublishedRevision`）も条件にする。取り直しの成功で下書きの revision を作り直す（§4.4・§4.6）。
- ロックの延長・返却は、持ち主の一致と取得ごとの lease ID の両方で限る（解除は権限 + lease）。延長は失効の後に取り直さない（§4.6。再レビュー `534b9655`）。
- 「読む」を編集・反映・解除の必要条件にする（値を返す口を、読めない人に開けない。§4.9）。
- 差分のマスクは出す側で当て、秘密を含みうる親の 1 件は丸ごと伏せる（§4.7）。
- 知らせは合図で、処理は起動・知らせ・遅れとつなぎ直し・周期の 4 つで追いつく。採るかどうかは revision の違いで決め（版の大小ではない。復元で版は戻る）、起動・つなぎ直しで前の追跡の状態を捨てる。DB の反映の成功は適用の成功ではない（§4.3・§11。再レビュー `534b9655`）。
- 状態と差分はそれぞれ 1 つの SQL 文で読み、差分の応答に比べた物の revision を載せる（§4.6・§4.11。再レビュー `534b9655`）。
