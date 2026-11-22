# 下流の要望（2026-11）をまとめて入れる計画書

作成日: 2026-11-22
状態: **計画**（オーナー決定済み、§2。§10 の確認事項は 2026-11-22 に推奨どおりで確定、#716 の判断（§4.13）だけ待ち。**2026-11-22 変更: 互換不要・DB 作り直し**の前提で簡素化した。実装は未着手。**2026-11-22: §11（#756 からの取り込み）を確定**。C0 の ADR-0034 は 2026-11-22 に Accepted。計画書との食い違いは ADR が正）
トラック: 保守者向け（トラックA）
Issue: [#778](https://github.com/tyaro/banto/issues/778)・[#786](https://github.com/tyaro/banto/issues/786)・[#790](https://github.com/tyaro/banto/issues/790)・[#791](https://github.com/tyaro/banto/issues/791)・[#792](https://github.com/tyaro/banto/issues/792)・[#793](https://github.com/tyaro/banto/issues/793)・[#794](https://github.com/tyaro/banto/issues/794)・[#795](https://github.com/tyaro/banto/issues/795)・[#796](https://github.com/tyaro/banto/issues/796)、
洗練案の [#714](https://github.com/tyaro/banto/issues/714)（残りの 4 = ファイル型）・[#716](https://github.com/tyaro/banto/issues/716)（ウィジェット盤。**判断待ち**）、
既存の [#782](https://github.com/tyaro/banto/issues/782)（影の木。PR の分け方は Issue の本文が正）・[#780](https://github.com/tyaro/banto/issues/780)（#782 の PR6 で通す）
関連: [three-pane-dock-plan.md](three-pane-dock-plan.md)（`ThreePaneDock`・`dockLayoutStore`）、
[attachments-plan.md](attachments-plan.md)・[attachment-history-plan.md](attachment-history-plan.md)（添付）、[template-scope.md](../template-scope.md) §4.2、
[ADR-0017](../adr/0017-credential-less-grant.md)（grant セッションと固定 identity。この計画で改訂）、
[ADR-0033](../adr/0033-dock-svelte-fast-check-devdep.md)、
conventions §1 / §2 / §3 / §4 / §5 / §6 / §10 / §11、[upgrading.md](../upgrading.md)

この文書の `path:line` は 2026-11-22 の main（`768741e0`）で開いて確かめた。確かめられなかったものは
「未確認」と書き、§9 に集めた。Issue の本文は写さない（リンク先が正）。

## 1. 背景と方針

下流の 2 つのアプリ（banto-industrial・temp-scada）から、2026-11-21〜22 に 9 件の要望が届いた。
同じ根を持つものが多い。

- **利用者の持ち主を何で識別するか**（#790・#778・#786）。いまは username が持ち主のキーで、
  同名でアカウントを作り直すと前の人の記憶が渡る。画面側（`sessionOwnerKey`）だけでなく、
  サーバーの ui-settings も同じ穴を持つ（§4.1）。
- **書き込みが最後まで終わること**（#793）。接続が切れると handler が途中で捨てられる。
- **dock の公開の口の不足**（#791・#792・#796）と、土台の置き換え（#782・#780）。
- **theme の色**（#794・#795）。

これに、洗練案（親 #559）の残り 2 件を同じ版に入れる（2026-11-22 オーナー決定）: #714 の 4（フォームの
ファイル型。2026-11-21 から合図待ちだった。今回の決定がその合図）と、#716（ダッシュボードの
ウィジェット盤。着手の前にオーナーの判断が要る、§4.13）。

方針（2026-11-22 オーナー決定）:

1. **全部が終わるまでリリースしない**。下流の 2 つのアプリは、その間の開発を止める。途中の版
   （v7.12.0）は出さない。下流の暫定の回り道（temp-scada の #791 待ちの保存の抑止など）は要らない。
2. **破壊的変更を厭わない**。互換のために形を曲げるより、正しい形にして移行の手順を書く。
3. **#782（PR2〜PR8）と #780 もリリースの前提**。「並走してよい作業」ではなく、これが終わるまで
   リリースしない。dock の Issue（#791・#792・#796）も同じ版に入れる。
4. #714・#716 も **D1 より前**に終わらせる。#712 は入れない。
5. 全 Issue の後に、D1 下流の使い勝手の精査（読み取り）→ D2 リファクタ → D3 upgrading・CHANGELOG の
   「消費側への注意」・実機確認（[#757](https://github.com/tyaro/banto/issues/757)）→ **1 回でリリース**。
   版は v8.0.0 の見込みだが、最後に `[Unreleased]` を規約に照らして判定する。
6. **互換性を保つ必要はない。DB は 1 から作り直す**（決定 16）。既存の DB・既存のデータを移す設計は置かない。
   下流も同じ前提で作り直す。旧版の DB・バックアップは、読まずに明示のエラーで断る（§4.1）。
7. **初回セットアップでユーザーもパスワードも作らない**（決定 18）。新しい DB はログインなしで起動し、
   その操作は組み込みの `admin`（決定 17）の操作として記録する（§4.3）。

範囲に入れないもの: #712、Hub の手動書き込みそのもの（banto-industrial 側）、
下流のリポジトリの変更（D1 は読むだけ。置き換えは下流の別セッション）。

## 2. 決定事項（2026-11-22 オーナー）

**2026-11-22 変更: 互換不要・DB 作り直し**（決定 16〜18）。これに合わせて、既存の DB・既存のデータを前提にした
設計（旧い `ui.{username}.*` の移し替え、既存の `Admin` / `admin` アカウントの検出と改名の口、`account_uid` の
既存行への埋め込み、旧版のバックアップの事前検査）を**全部外した**。形が変わった決定には注記を付けた。

| # | 決めたこと | 関係 |
| --- | --- | --- |
| 1 | #790・#778・#786 のスキーマの変更を 1 回に束ねる。**2026-11-22 変更（互換不要・DB 作り直し）**: データの移行は無い。形は「既存の migration を書き換えて基準を作り直す」で確定（§4.1、§10 の N2） | §4.1〜4.3 |
| 2 | `Identity.id` は username のまま。**`accountId` を足す**（作成時の乱数 `users.account_uid`、キーは `acct:<accountId>`）。無ければ `sessionOwnerKey` は `null`（fail closed）。**2026-11-22 変更**: 既存の行への埋め込みは無い。アカウントの行では最初から必須 | §4.2 |
| 3 | **2026-11-22 変更（互換不要・DB 作り直し）**: 組み込みのユーザーは**小文字の `admin`**。新しい DB には最初から居る。既存の `Admin` / `admin` アカウントの検出・起動の停止・改名の口は**置かない**（既存の DB は読まない）。`admin`（大小無視）と grant の固定 id を新規の作成で断るのは残す | §4.3 |
| 4 | ログインなしのロールが viewer でも、監査の actor 名は `admin`（組み込み）。組み込みの行のロールは表示だけ（判定に使わない）。どのセッションを `admin` に帰属させるかは、配線の層の明示の印で決める。Tauri のログインなし（`local`）は `admin` に帰属させる（決定 18） | §4.3 |
| 5 | grant セッションの ui-settings は、ユーザーの行を作らず **kind をキー**にする | §4.4 |
| 6 | `instance.id` は置かない。アカウントごとの乱数 `account_uid` を使う（DB を作り直しても、バックアップを復元しても、別人に同じキーが渡らない）。**2026-11-22 注記**: 互換不要でも、新しい版どうしの復元は残るので形は変えない | §4.2 |
| 7 | #795 は**先頭 4 系列だけ**状態色との色差を保証する。調整は最小、並べ替えなし | §4.10 |
| 8 | #793 は**ログインを含む全書き込み**に既定で掛ける。除外の口は作らない | §4.5 |
| 9 | #786 は provider の `get` / `set` を **revision つきの形に置き換える**（足すのではない）。revision は数ではなく書き込みごとの乱数、消す口も足す（§10 の 19） | §4.4 |
| 10 | #796 の `replaceLayout` / `resetLayout` は、進行中の操作を**自動で取り消す** | §4.7 |
| 11 | #791 の `onLayoutCommit` に**確定の理由**を渡す。reset のとき消費側が保存を消せる。発火は「確定点で `serialize()` が変わっていたら」と定義する（§10 の 18） | §4.6 |
| 12 | #791 後半（パッケージ化）では、持ち主の照合と `beforeBaseline` を**省略可能**にする（temp-scada は不要と表明） | §4.6 |
| 13 | リリースは §1 の方針どおり 1 回。#782・#780 と dock の Issue もその前提 | §6・§7 |
| 14 | #782 の本文の決定は覆さない。ただし互換のために残している形を壊して正しくできる所を、各 PR で検討する | §9.2 |
| 15 | #714 の 4（ファイル型）に着手する（保留を解く）。#716 も同じ版に入れる。#712 は入れない | §4.12・§4.13 |
| 16 | **互換性を保つ必要はない。DB は 1 から作り直す**。既存の DB・既存のデータは気にしない（下流も同じ前提で作り直す）。旧版の DB・バックアップは読まずに明示のエラーで断る | §4.1・§8 |
| 17 | #778 の組み込みのユーザーは**小文字の `admin`**。新しい DB では最初から居る | §4.3 |
| 18 | **初回セットアップでユーザーもパスワードも作らない**。新しい DB はユーザーを作らずに起動し、ログインなしの操作は組み込みの `admin` の操作として記録する。ユーザー管理が要る利用者だけが、ユーザー管理の画面からユーザーを作る。組み込みの `admin` は**パスワードを持たず、ログインできない**。ログイン必須への切り替え（ロックダウン）は、ログインできる管理者のアカウントが 1 つ以上あるときだけ許す | §4.3 |
| 19 | §10 の確認事項（N2〜N6 と継続分）を**推奨どおりで確定**（2026-11-22）。#716 の判断（§4.13、§10 の 9）だけは確定させず判断待ち | §10 |

（当初の「#793 だけ先に v7.12.0 で出す」案は、決定 13 で無効。）

## 3. いまあるもの（2026-11-22 の main で確認）

| 何 | どこ | 確かめた結果 |
| --- | --- | --- |
| ui-settings の保存先 | `crates/banto-admin-services/src/settings.rs:428`・`:445` | `settings` 表のキー `ui.{username}.{key}`（単純な連結）。revision なし |
| ユーザーの削除 | `crates/banto-admin-services/src/users.rs:1485` | `DELETE FROM users` だけ。ui-settings の行は残る |
| 最後の管理者のガード | 同 `users.rs:313`（`ensure_admin_removal_allowed`）、数えるのは `:1487-1489` 付近の `COUNT(*) ... role = 'admin'`。`has_admin`（`:723`）の呼び手は試験だけ | 組み込みの行を足すと、数え方を変える必要がある。ログイン必須への切り替えは、管理者の有無を見ていない |
| username の検査 | 同 `users.rs:134`（`validate_username`） | trim・長さ・`.` の禁止だけ。予約名も大小無視の照合も無い |
| REST の `Identity` | `crates/banto-server/src/auth/session.rs:27`（`id`・`name`・`role`）、組み立ては `routes/audit.rs:117`（`id: user.username.clone()`）と `:42` | `account_id` は `SessionStamp`（`audit.rs:122`）にあり、画面へは出ていない |
| Tauri の `Identity` | `apps/admin-template/src-tauri/src/lib.rs:419`、ui-settings は `:3403`・`:3421` が `identity.username` を渡す | REST と同じ形 |
| REST の ui-settings | `crates/banto-server/src/routes/ui_settings.rs:31-56` | GET は `{value}`、PUT は無条件。持ち主は `identity.id`（= username） |
| 画面側の持ち主のキー | `packages/admin-core/src/sessionController.svelte.ts:207-217`（`sessionOwnerKey`）、型は `provider.ts:88` | `local` / grant の kind / `account:${id}` |
| ui-settings の provider | `packages/admin-core/src/providers/uiSettings.ts:46-51`（`get`・`set`）、直列化は `:89-140` 付近 | キーごとに直列化、置き換えられた `set` は成功として resolve（#707） |
| `createSavedSetting` | `packages/admin-core/src/savedSetting.svelte.ts` | 失敗は `error`・`dirty` に残るだけで再送しない |
| サーバーの起動 | `crates/banto-server/src/server.rs:162`（`BoundServer::serve`） | 層は `axum::Extension` の 2 つ。書き込みを切り離す層は無い |
| migration | `apps/admin-template/core/migrations-sqlite/`・`migrations-postgres/`、適用は `core/src/db.rs:181`（`run_migrations`） | 最新は `0013_user_permissions.sql`。派生アプリはこのディレクトリを丸ごと持つ（scaffold は 4 本を名前で消すだけ、`scripts/scaffold.mjs:1064-1069`・`1485-1508`） |
| migration の凍結 | `scripts/verify-migrations-frozen.mjs`（`pnpm verify:migrations`）、conventions §11 | 最新の `v*` タグにある migration の変更・削除を CI が拒む。sqlx は適用済みの checksum を照らし、違えば `VersionMismatch` で起動しない |
| 復元の検証 | `crates/banto-admin-services/src/backup.rs:151`（`REQUIRED_TABLES`）・`:269`（`validate_sqlite_file`） | `settings`・`users`・`audit_log` の表があるかだけを見る。列・migration の版は見ない |
| ログインなし | `crates/banto-admin-services/src/settings.rs:180`（`auth.disabled` の既定は off）・`:237-242`（`auth_server_combination_allowed`） | Tauri の「ログイン不要モード」。ログインなし + LAN は、閲覧公開が on のときだけ許す |
| 初回セットアップ | `users.rs:706`（`is_initialized`）・`:738`（`setup_first_user`）、`routes/auth.rs:95-117`、Tauri の `lib.rs:1049`・`1756`・`1807`、`login/+page.svelte:74`、`e2e/first-run-setup.ts` | アカウント 0 のときだけ、認証なしで最初の管理者を作れる。REST は `allow_setup`（`BANTO_ALLOW_SETUP=1`）が要る |
| ログイン試行の制限 | `crates/banto-server/src/auth/policy.rs:54-72`（`RateLimitPolicy`） | REST のログイン。IP + username で 5 回、IP だけで 20 回、60 秒。居ないユーザーにもダミーの検証を回す |
| SQLite の外部キー | `crates/banto-storage/src/sqlite.rs:25`・`:39` | `foreign_keys(true)`（有効） |
| 狭い ⇄ 広いの切り替え | `packages/dock-svelte/src/ThreePaneDock.svelte:330-355` | `await host.replaceLayout(...)` の**後**で `wideLayout`・`narrowShown` を確定 |
| `replaceLayout` | `packages/dock-svelte/src/DockHost.svelte:576-598`（適用は `:585-595`、その後 `await tick()`） | フォーカスが枠の中にあると、適用から戻るまで 1 tick あく |
| `arrange` を切ったときの取り消し | 同 `DockHost.svelte:410-420`（`gesture.cancel('api')` は `:420`） | 直接の口は無い |
| `isVisible` | `packages/dock-svelte/src/state.svelte.ts:566-569` | 「ドッキング中・帯・開いた浮動」のどれか。doc は "on screen" と書いていて実際と違う |
| Toast の背景 | `packages/ui/src/ToastHost.svelte:119`・`:125`・`:134`（info は `:143`） | tint をそのまま背景にしている |
| ダークの tint | `packages/theme/src/css/banto.css:552`・`:554`・`:556` | `color-mix(... 18%, transparent)`（半透明） |
| warning と系列 2 | 同 `banto.css:339`・`:373`（ライト）、`:506`・`:514`（ダーク） | Issue の値のとおり |
| 保存の部品 | `apps/admin-template/src/lib/banto/dockLayoutStore.svelte.ts`（309 行、`createDockLayoutStore` は `:130`） | テンプレートの中にだけある |

不変条件（[conventions.md](../conventions.md) の本文で確認）:

- **§1 両経路の対称**: mutating 操作は REST と Tauri の両方で同じ認可・同じ監査。#778・#790・#786 は
  必ず両経路を 1 つの PR で変える。
- **§2**: サービス層（`banto-admin-services`）は axum / tauri を知らない。組み込みの行の禁止事項・
  ui-settings の条件付き書き込みはサービス層に置き、両経路から呼ぶ。
- **§3 依存を足さない**: `tower-http` は入れていない。#793 の層は `axum::middleware::from_fn` の手書きにする。
- **§4・§5**: パッケージ間の `from '@banto/...'` import はゼロ。#791 後半を dock-svelte に置くなら、
  `UiSettingsProvider` と持ち主の照合は構造的な型で受ける（admin-core を import しない）。
- **§10**: 環境分岐は配線の層だけ。通常のアカウントも `public` という username を持てるので、
  identity の id・name から合成セッションを推測しない（予約名にしても、この規則は変えない）。
- **§11**: migration は 2 系統の連番を対称に。リリース済みは追記のみ。**この計画は、この規則を 1 回だけ破る**
  （基準の作り直し、§4.1。オーナーの決定 16 が前提。ADR と conventions に書く）。C1 で全体を一度に入れて、
  後の PR で書き換えない。

## 4. Issue ごとの設計

### 4.1 共通: 基準の作り直しと持ち主の識別（#790・#778・#786）

**根本原因**: 持ち主を username で識別している所が 3 層にある（サーバーの `ui.{username}.{key}`、
wire の `Identity.id`、画面の `account:${id}`）。username は再利用できる。`users.id` は再利用されないが、
DB を作り直すと 1 から数え直し、**バックアップの復元でも巻き戻る**（採番の履歴も DB の中にある）。

**前提（2026-11-22 変更: 互換不要・DB 作り直し。決定 16）**: 既存の DB・既存のデータは読まない。この節から、
旧い `ui.{username}.*` の移し替えと削除（あいまいな行・`ui.local.*`・退役済みのユーザーの行の規則、advisory lock、
「固定 id → kind」を先に渡す手順）、`account_uid` の既存行への埋め込み、組み込みの行を起動時に入れる冪等な手順を外した。

**migration の形**（選び直し。§10 の N2）:

| 案 | 中身 | 得 | 失 |
| --- | --- | --- | --- |
| (i) 0014 を足す | 既存の 13 本は触らず、`ALTER TABLE` と新しい表を 0014 に置く | リリース済みは追記のみ（conventions §11）のまま。`pnpm verify:migrations` に手を入れない | sqlx は旧版の DB に 0014 を**そのまま当てる**（断るには自前の検査が要る）。SQLite の `ALTER TABLE` では `account_uid` を必須にできず、`password_hash` の `NOT NULL` も外せない（NULL の行の扱いと、資格情報ではない固定値が残る） |
| **(ii) 基準を作り直す（推奨）** | `0003_users.sql`・`0005_audit_log.sql` を新しい形に**書き換え**、`0014_ui_settings.sql` を足す。ほかの 11 本とファイル名・連番は変えない | 旧版の DB は sqlx が自分で断る（下）。列の制約を最初から正しく置ける。scaffold が名前で消す 4 本（`scripts/scaffold.mjs:1064-1069`・`1485-1508`）に触れない | conventions §11 の「追記のみ」を 1 回だけ破る。`verify-migrations-frozen.mjs` に今回かぎりの許可が要る。保守者の手元の DB も作り直し |

推奨は **(ii)**。理由: (1) 安全。sqlx は適用済みの migration の checksum を埋め込みと照らすので
（`scripts/verify-migrations-frozen.mjs` の冒頭の説明、conventions §11）、0003 の本文が変われば旧版の DB は
`VersionMismatch` で止まる。0014 は連番の最後なので、**新しい migration が旧版の DB に当たる前に止まる**
（順序は C1 の試験で固定する。§9.1）。(i) は「旧版の DB に 0014 だけが当たって、移していないデータと混ざる」状態を、
自前の検査の入れ忘れで作れる。(2) 単純。`account_uid` の NULL・固定値の `password_hash`・遅れて埋める手順が
要らなくなり、認証の分岐が減る。(3) 写す側の手間は小さい。派生アプリはテンプレートの
`core/migrations-{sqlite,postgres}/` を丸ごと持っていて（scaffold は名前で一部を消すだけ）、どちらの案でも DB は作り直す。
全部を 1〜数本に畳み直す形（連番も変える）は、scaffold・レシピ・README がファイル名を引いている所を全部直すことに
なるので採らない。

**設計**（SQLite・PostgreSQL の両方。rule 11 の対称は保つ）:

- `0003_users.sql`（書き換え）: `kind`（`'account'` 既定 / `'builtin'`）、`account_uid`（一意。§4.2）、
  `password_hash` は NULL 可にする。CHECK で「`kind = 'builtin'` ⇔ `password_hash IS NULL`」
  「`kind = 'builtin'` ⇔ `account_uid IS NULL`」を守る（アカウントの行は両方が必須。サービス層を通らない INSERT が
  `account_uid` を入れ忘れると、黙って NULL で残らずに失敗する）。組み込みの行は 1 つだけ、を
  **部分一意インデックス**（`WHERE kind = 'builtin'`）で守る。
- `0005_audit_log.sql`（書き換え）: `actor_id`（NULL 可）。`actor_username` のスナップショットは残す。
  外部キーは張らない（ユーザーを消しても監査は残す）。
- `0014_ui_settings.sql`（新規）: 表 `ui_settings`（持ち主・key・value・revision、アカウントの行の外部キー。§4.4）と、
  **組み込みの `admin` の行の INSERT**（`kind = 'builtin'`・`role = 'admin'`。role・`auth_epoch`・`version` の列は
  0004・0007・0012 が足すので、行を入れるのはその後）。起動時に入れる手順は要らない（新しい DB には migration の後、必ず居る）。
- `instance.id` は置かない（決定 6）。
- `pnpm verify:migrations`: 「タグ `v7.11.0` と比べるときに、この 4 ファイル（2 方言 × 2 本）の変更だけを許す」を
  スクリプトに書く（タグを名指しするので、v8.0.0 のタグの後は自動で効かなくなる）。conventions §11 に
  「v8.0.0 で基準を作り直した。以後はまた追記のみ」と書く。C1 で全体を一度に入れて、後の PR で書き換えない。

**旧版の DB・バックアップを断る所**（読まずに明示のエラー。決めるのは 1 か所）:

- **`db::run_migrations`**（`apps/admin-template/core/src/db.rs:181`。起動で必ず通る、両方言）。sqlx の
  `VersionMismatch` を「この DB は v8.0.0 より前の版のものです。読めません。DB を作り直してください」に写す。
  PostgreSQL をアプリの外で復元した場合（`backup.rs:207-213`）も、次の起動でここに当たる。
- 復元だけは、置き換えの**前**に断る必要がある（置き換えた後で止まると、起動できない DB が残る）。既にある検査
  `validate_sqlite_file`（`backup.rs:269`。予約と適用の両方が通る）の `REQUIRED_TABLES`（`backup.rs:151`）に
  **`ui_settings` を足す**。旧版のバックアップは「必須の表が無い」で予約の時点に拒まれ、今の DB は置き換わらない。
  新しい検査の関数は足さない（当初の「予約名のアカウントを含む候補の事前検査」は不要になった）。

**破壊的変更と移行**: 派生アプリは `0003_users.sql`・`0005_audit_log.sql` を差し替え、`0014_ui_settings.sql` を足し、
**DB を作り直す**（データの移行の口は無い）。自分の migration を 0014 以降の番号で足している派生アプリは番号をずらす
（下流の実際の番号は D1 で見る）。

**リスク**: 書き換えで列・索引を落とす。C1 の試験で、書き換え前の 0003・0005 を当てた DB と、書き換え後の DB の
スキーマを比べ、差が意図した列・制約だけであることを確かめる（1 回きりの試験。両方言）。

**試験**（両方言）: 新しい DB に migration を当てると、組み込みの `admin` が 1 行だけ居る（2 行目は入らない）。
`account_uid` なしのアカウントの INSERT、`password_hash` つきの組み込みの行は CHECK で失敗する。
v7.11.0 の migration で作った DB を開くと、明示のエラーで止まり、スキーマが変わっていない。
v7.11.0 の形のバックアップは復元の予約で拒まれる。

### 4.2 #790 再利用されないアカウントの ID

**設計**:

- **再利用されない識別子**: `users.account_uid`。アカウントの作成時にサービス層で作る 128 bit の乱数
  （OS の乱数源、文字列）。一意制約。改名・ロールの変更では変えない。秘密ではない（認証にも認可にも使わない。
  記憶を仕切る名前）。組み込みの行には持たせない（ログインしないので、持ち主つきの記憶を持たない）。
  - 復元に強い理由: 取得後に作った A の値は、復元した DB には無い。復元後に作る B は新しい乱数を引くので、
    `users.id` が A と同じ 2 でも一致しない。取得の時点で居たアカウントは同じ値に戻る（同じ人なので正しい）。
  - DB を作り直した場合・別の DB の同じ `users.id` も一致しない（決定 16 で、作り直しは全部の利用者に起きる）。
  - **2026-11-22 変更**: 既存の行への埋め込みは無い。アカウントの行では列の制約で必須（§4.1）。
    列が必須なので、作成時の採番は C1 に入る（wire に載せるのは C3）。
- wire の `Identity` に `accountId` を足す（REST の `/api/auth/identity`・ログインの応答、Tauri のコマンド）。
  アカウントのセッションでは `account_uid`。grant セッション・Tauri のログインなし（`local`）には載せない。
  `instanceId` は足さない。
- `sessionOwnerKey`（`sessionController.svelte.ts:207-217`）: `local` と grant の kind は今のまま。
  アカウントは `acct:<accountId>`。無ければ `null`（何とも一致しない）。
- `Identity.id` は username のまま（監査の主体・画面の表示・`acting_username` の呼び手を変えない）。
  ただしサーバーの中で「持ち主」に username を使っている所（ui-settings）は `users.id` に替える（§4.4）。
  サーバーの中の `users.id`（`ui_settings`・`actor_id`）は同じ DB の行どうしで、復元しても一緒に戻るので食い違わない。
  画面の側（ブラウザーの保存）は DB と一緒に戻らないので、`account_uid` を使う。
- 監査に `actor_id` を書く（REST・Tauri の両方。§1。帰属の規則と一緒に C2 で入れる）。

**破壊的変更と移行**: `Identity` を自分で組み立てている派生アプリ（Tauri の `lib.rs`、REST の
credential verifier）は `accountId`（`account_uid`）を載せる。載せないと持ち主のキーが `null` になり、
持ち主つきの記憶（一覧の記憶・最近のコマンド・ドックの配置）が保存も復元もされない（fail closed。
黙って他人に渡すよりよい）。古い `account:` のキーの localStorage は残骸になる（掃除の口は D2 で検討）。

**リスク**: `accountId` を載せ忘れた派生アプリが「記憶されない」とだけ見える。dev ビルドで
`sessionOwnerKey` が account の kind で `null` を返したら 1 回だけ警告する。

**試験**: 同名で作り直したアカウントのキーが違うこと、別の DB の同じ `users.id` のキーが違うこと、
`accountId` なしで `null`（単体）。REST と Tauri の identity の形の一致（既存の対称の試験に足す）。
**復元の回帰試験**（実ファイルの SQLite、`backup.rs` の既存の試験の形）: バックアップを取る → A を作る
（`users.id` = 2）→ 復元を適用 → B を作る（同じ `users.id` = 2）で、B の `accountId` と `sessionOwnerKey` が
A と違うこと。同じ URL・同じブラウザーを想定し、A のキーで保存した記憶を B の画面が読まないこと（画面の単体）。

### 4.3 #778 組み込みのユーザー `admin` と、初回セットアップの撤去

**決定（2026-11-22。決定 17・18）**: 組み込みのユーザーは小文字の `admin`。新しい DB に最初から居る。
パスワードを持たず、ログインできない。初回セットアップ（最初の管理者とパスワードを作る画面）は無くす。
新しい DB はユーザーを作らずに起動し、ログインなしの操作は組み込みの `admin` の操作として監査に残る。
ユーザー管理が要る利用者だけが、ユーザー管理の画面からアカウントを作る。
（前の版の「`Admin` か `admin` か内部名 `builtin.admin` か」「既存の DB の `admin` を止める・改名する」の比較は、
決定 16・17 で不要になったので消した。）

Issue の「決めること」への答え:

1. **ロックダウン後**: `admin` はログインできない行のまま。パスワードは持たせない。
2. **改名・無効化・降格・パスワードの設定・削除**をすべて禁じる（サービス層で。§2）。
3. **最後の管理者のガード**: 組み込みの行は数えない（`role = 'admin' AND kind = 'account'`）。
   数えると、人のアカウントを全部消せてしまう。
4. **ADR-0017 の改訂**: 行にするのは `admin` だけ。`public` などほかの grant の固定 identity は行を作らず、
   固定 id を予約名にする。
5. **既存の DB**: 読まない（決定 16。§4.1）。

**いまの形（確かめた）**:

- ログインなしは既にある: Tauri の「ログイン不要モード」（`auth.disabled`。合成セッション `local`、ロールは
  `auth.disabled_role`）。既定は off（`settings.rs:180`）。
- 新しい DB（アカウント 0）では、ログインの画面が初回セットアップに替わる（`login/+page.svelte:74`、
  `status.initialized`）。経路は Tauri の `auth_setup`（`lib.rs:1049`）と REST の `POST /api/auth/setup`
  （`routes/auth.rs:95-117`。`allow_setup` が要り、`banto-serve` は `BANTO_ALLOW_SETUP=1` のときだけ、
  `banto-serve.rs:85`）。アカウント 0 の間は、セッションなしで `auth_config_apply` を呼べる
  （「ログインなしで使い始める」、`lib.rs:1756`・`1807`）。
- **ログインなしと LAN は両立しない**: 「`auth.disabled` かつ `server.enabled`」は、閲覧公開（`viewer_public`）が
  on のときだけ許す（`auth_server_combination_allowed`、`settings.rs:237-242`。保存の両側と、Tauri の起動時
  `lib.rs:4583-4600` が同じ判定を使う）。
- ログイン必須へ切り替えるときに、管理者のアカウントがあるかは**見ていない**（`has_admin`、`users.rs:723` の
  呼び手は試験だけ）。今は、0 件のまま切り替えると初回セットアップの画面に出る。

**設計**:

- **組み込みの行**: `username = 'admin'`・`kind = 'builtin'`・`password_hash` は NULL（§4.1 の CHECK）。
  migration が入れる。credential verifier は `kind = 'builtin'` を、ハッシュを見る**前に**拒む
  （列の CHECK と二重の守り）。拒むときも、ユーザーが居ないときと同じ**ダミーのハッシュ検証は回す**
  （現行 `users.rs:895-898`。応答の時間で組み込みの行を見分けさせない）。
  - `change_password`（SELECT は `users.rs:922`、UPDATE は `:965`）と `reset_password`（UPDATE は `:1399`）の文に
    `kind = 'account'` を入れる。サービス層の検査を抜けても、組み込みの行にハッシュが入らない（入れば CHECK でも落ちる）。
  - **既知の名前 `admin` がパスワードの的になるリスクは無い**: ログインできないので、当てるパスワードが無い。
    `admin` へのログインの試行は、居ないユーザーと同じ扱いで、REST のログイン試行の制限
    （`crates/banto-server/src/auth/policy.rs:54-72`。IP + username で 5 回、IP だけで 20 回、60 秒）にそのまま掛かる。
- **新しい DB の既定をログインなしにする**: `auth.disabled` の既定を on に変える（`settings.rs:180`。キーが無いとき）。
  Tauri は起動すると合成セッション `local`（ロールは `auth.disabled_role`、既定 admin）でアプリに入る。
  ログインの画面も初回セットアップの画面も出ない。
- **安全の前提**（ADR-0017・spec M11 の考え方のまま。ADR に明記する）: ログインなしの間は、**その端末の前に居る人を
  信用する**。誰でも、合成セッションのロール（既定は admin）で操作できる。これが許されるのは、ログインなしの間は
  LAN から書き込めないから（上の `auth_server_combination_allowed`。開けられるのは閲覧公開 = 読むだけ、だけ）。
  **この組み合わせの規則は緩めない**。LAN から操作させたい利用者は、先にアカウントを作ってロックダウンする。
- **アカウントが 0 の間に REST でできること**（conventions §1 の対称）: REST にログインなしの管理者のセッションは無い。
  ログインは必ず失敗し（アカウントが無い。組み込みは拒む）、初回セットアップの口も無くなるので、REST から届くのは
  閲覧公開の読み取りと、派生アプリが足した grant だけ。ユーザーの作成の認可と監査は両経路で同じ関数を通る
  （REST の口はアカウントのセッションが要るので、0 の間は誰も届かない。認可の規則は同じ）。
  - ヘッドレス（`banto-serve` だけ。PostgreSQL の運用・e2e）は Tauri のログインなしを持たないので、最初のアカウントを
    作る手段が別に要る。**DB に触れる人の CLI**（`banto-serve` の引数。ネットワーク越しの口にしない。監査は
    組み込みの `admin` の操作として残す）を推奨する（§10 の N3）。`BANTO_ALLOW_SETUP` は消す。
- **ロックダウン**（`auth.disabled` を off にする。`auth_config_apply`）: **ログインできる管理者のアカウント
  （`kind = 'account' AND role = 'admin'`）が 1 つ以上あるときだけ**許す。無ければ `Validation` で断り、
  「先に管理者のアカウントを作ってください」と返す。判定と保存は同じ `auth_config_lock` の中で行う
  （ADR-0017 のロックダウンの流れ「保存 → 同じ関数の中で直後に grant の失効」の手前に置く）。
  - **最後の管理者のガードは、ログインなしの間も常に掛ける**（今のまま。§10 の N5）。1 つ作った管理者は 0 に戻せないので、
    「判定の後・保存の前に最後の管理者が消える」競合が起きない。ログインなしの間は害が無い（アカウントが残るだけ）。
  - ログイン必須なのに管理者が 0 の DB（直接の編集でしか起きない）は、起動時に明示のエラーで止める。
    黙ってログインなしへ戻さない（fail-open になる。§10 の N4）。
- **初回セットアップを外す**（C2b）。消す・置き換えるもの:
  - サービス層: `setup_first_user`（`users.rs:738`）と、初回の INSERT の `NOT EXISTS (SELECT 1 FROM users)`
    （`users.rs:776`）、PostgreSQL の同時セットアップの試験（`ci.yml:423-426` の `pg_concurrent_setup`）。
  - `is_initialized`（`users.rs:706`）: 「初期化済み」の判定は**要らなくなる**（新しい DB は migration の後、いつでも
    使える状態）。呼び手（`auth_status` `lib.rs:1029-1031`、bootstrap の窓 `lib.rs:1807`、REST の status
    `routes/auth.rs:64`）と一緒に消す。「アカウントがあるか」を知りたい所（ロックダウンの判定）は
    `has_admin`（`kind = 'account'` を数える形に直す）を使う。
  - REST: `POST /api/auth/setup` と `allow_setup`（`routes/auth.rs`）、status の `initialized`。
    Tauri: `auth_setup` コマンド、`auth_config_apply` の bootstrap の窓（ログインなしの間は「認可を通さない出口」
    が既にあるので、窓は要らない）。
  - 画面: ログインの画面の `setup` の分岐と「ログインなしで使い始める」（`login/+page.svelte`）、`AuthProvider.setup`
    （`provider.ts`・`providers/http.ts`・`providers/tauri.ts`・demo）、`auth.setup*` の文言（i18n の両言語）。
    ロックダウンの入口は今の設定の画面（認証の節）のまま。管理者が 0 のときは、切り替えを押せない理由と
    ユーザー管理への導線を出す。
  - e2e: `e2e/first-run-setup.ts` の `createFirstAdmin`（`smoke.spec.ts:268` のシナリオ 1、
    `tests-add-resource/orders.spec.ts:28`）を「CLI で作ったアカウントでログインする」に置き換える
    （`playwright.config.ts:267` の `BANTO_ALLOW_SETUP` も）。ログインの画面の基準画像と a11y の試験が変わる。
  - scaffold・rename: `scripts/rename.mjs:221` はログインの見出しの書き換え先に `e2e/first-run-setup.ts` を挙げている。
    置き換えたファイルへ直す。display プリセットが初回起動で入れる `auth.disabled = true`（`scripts/scaffold.mjs:2022`）は
    既定と同じになる（`auth.disabled_role` などは残す。ADR-0034 §5: 既定は新しい DB だけ、0014 の migration が `auth.disabled = 'true'`・`auth.disabled_role = 'admin'` を明示して入れる。キーの欠落・破損は既定で埋めず起動を止める。`seed_first_boot_settings` の「表が空のときだけ seed」の条件は、0014 が `settings` に行を入れた時点で成り立たなくなり、display の生成物の `server.viewer_public`・`server.enabled`・bind が入らなくなるので、**C1 で 0014 と一緒に**「seed 済みの印が無いとき」に直す。ADR-0034 §5）。**scaffold の 4 プリセットの dry-run と、template-acceptance の
    実行が要る**（フロントだけの変更では template-acceptance が走らない）。
- **ログインなしの操作の帰属**（決定 4・18）: id・name からは推測しない（conventions §10）。配線の層が付ける
  **明示の印**で決める。`GrantSpec` に「組み込みの actor に帰属する」フラグ（既定は off。名前は C0 の ADR で確定）を
  足し（名前は `audit_as_builtin_admin: bool`、ADR-0034 §3）、発行したセッションの `AuthenticatedSession`（`TokenRecord` 経由、`#[serde(skip)]`）に写す。`SessionStamp` はアカウントの `account_id`・`auth_epoch` の組で grant セッションでは `None` なので載せられない。監査の主体は認可時のスナップショットで、ガードが 1 回だけ作って成功・拒否の監査へ渡す（bearer から引き直さない）。経路は `actor_kind`（`account` / `local` / `grant:<kind>` / `cli`）に残す。監査を書く所は印だけを見る。
  - Tauri のログインなし（`local`。現行の監査は `local`、`lib.rs:5733`）: 同じ印を Tauri の配線で付け、
    `actor_username = 'admin'`・`actor_id = 組み込みの行の id` を書く。`actor_role` はそのセッションの実際のロール
    （viewer なら viewer）。行の `role` は一覧の表示だけで、認可の判定には使わない。
    ui-settings の持ち主と `sessionOwnerKey` は `local` のまま（帰属は監査だけ）。
  - 印つきの grant セッション（派生アプリの管理者相当の grant）: 同じく `admin` に帰属する。
  - 印なしの grant セッション（閲覧公開の `public` など）: 今のまま固定 id を書き、`actor_id` は NULL。
  - wire の `Identity`（id・name・role）は変えず、印は画面へ出さない。
- **予約名**: `admin`（大小無視）と grant の固定 id を、アカウントの作成・改名で断る（新しい DB でも、人が
  `Admin`・`ADMIN` を作って見分けにくくするのを防ぐ）。conventions §10 の「id・name から合成セッションを
  推測しない」は変えない（予約は見分けやすさのためで、判定の根拠にしない）。
  - 予約名の一覧を知っているのは配線の層だけ（grant は派生アプリが足せる開いた集合、`grant.rs:89-94`・`:200`。
    サービス層は axum / tauri を知らない、§2）。配線の層が `GrantSpec` の一覧から固定 id を集め、
    サービス層へ渡す口（`UsersService` の構築時の引数など）を置く。形は ADR-0034 §4 で決まった: `UsersService::with_reserved_usernames(ReservedUsernames)`（`admin` はサービス層が自前で必ず予約し、配線は grant の固定 id だけを渡す）。C2 で入れる。
  - **起動時の検出**: 既存の `Admin` / `admin` を探して止める検査は**要らない**（新しい DB には居ない。作成は断る）。
    残る穴は 1 つ: **grant を後から足した**とき、その固定 id と同名のアカウントが既に居る場合。これだけを、起動時の
    1 文の検査（予約名の一覧と `kind = 'account'` の username を大小無視で照らす。REST と Tauri の配線が起動時に呼ぶ）で見て、当たれば名前と対処
    （そのアカウントを作り直すか、grant の固定 id を変える）を書いたエラーで止める（推奨。§10 の N6）。改名の口は作らない。
- `users` を数える所（ユーザー一覧・件数・CSV・バックアップの検証・最後の管理者のガード・今の `is_initialized`）を
  `kind = 'account'` に直す。組み込みの行が migration で入るので、**C1 で**洗う（§5）。組み込みの行の最低限の保護（verifier を `kind = 'account'` に絞る、パスワード・更新・削除・CSV の取り込みが `kind = 'builtin'` を断る）も C1 に前倒しする（ADR-0034 §2）。管理のユーザー一覧だけが読み取り専用の 1 行として返す（`UserSummary` に `kind`）。組み込みかどうかの判定は、
  どこでも名前ではなく `kind`。
- **C1 の途中の条件**: `setup_first_user` の INSERT（`users.rs:776`）の `WHERE NOT EXISTS (SELECT 1 FROM users)` も、
  `WHERE NOT EXISTS (SELECT 1 FROM users WHERE kind = 'account')` に直す（直さないと、組み込みの `admin` の行があるため
  初回セットアップが常に失敗する）。C2b で初回セットアップごと消すまでの条件。試験: 組み込みの行だけがある DB で初回セットアップが通る（両方言）。

**破壊的変更と移行**: 初回セットアップが無くなる（画面・REST の口・Tauri のコマンド・`AuthProvider.setup`・
`BANTO_ALLOW_SETUP`）。新しい DB の既定がログインなしになる。ユーザー一覧に `admin` が 1 行居る。
`admin`（大小無視）・`public` など予約名のアカウントは作れない。Tauri のログインなしの監査の actor が `local` から
`admin` に変わる。ADR-0017 §3（自己削除のガード）・監査の項・ロックダウンの条件を改訂する。

**リスク（認証）**: (1) 組み込みの行が「ログインできる管理者」になる経路を作らないこと。パスワードのリセット・
CSV の取り込み・リストア・権限の個別付与（0013）・自動ログイン（`auth.autologin.username`）の各経路を C2 で
1 つずつ確かめ、試験に入れる。(2) 既定がログインなしになるので、**LAN との組み合わせの規則が唯一の柵**になる。
C2b で、起動時・保存の両側・`banto-serve`（listener は `BANTO_BIND` / `PORT` から来て、保存した設定を見ない、
`banto-serve.rs:277`）の 3 か所で、ログインなしの間に REST から書き込めないことを試験で固定する。

**試験**: 禁止の操作が REST・Tauri の両方で拒まれ、denied の監査も対称（§1）。組み込みの行ではログインできず、
失敗が居ないユーザーと同じ経路（ダミーの検証）を通る。`change_password`・`reset_password` が組み込みの行を変えない
（SQL を直接呼んでも 0 行）。最後の管理者のガードが人のアカウントだけを数える。予約名の大小無視。
grant を後から足して同名のアカウントに当たると、次の起動が止まる。
帰属の規則: 印つきの grant・印なしの grant・Tauri のログインなしの 3 通りで、監査の actor が REST と Tauri で同じになる（§1）。
ログインなしの間の REST は読み取り専用（ADR-0034 §6）。アカウントが 0 の間に限らず、ログインなしの間ぜんぶで、次の 2 つを分けて試験する。
(a) **拒否**: 全アカウントでログインとトークンの利用を拒否し（資格情報が正しくても。切り替えの前に発行したトークンも）、既定の業務・管理の更新を拒否する。
(b) **例外は別に成功を確かめる**: 閲覧公開の viewer は自分の kind の UI 設定の PUT が通り、派生アプリが明示して登録した grant はその権限どおりに通る（ADR-0034 §6・§10）。
**切り替えとの直列化（C2b の実装条件。ADR-0034 §6）**: ログインの許可・トークンの発行・既発行トークンでの認可を、モードの世代でモードの切り替えと直列にする（今は照合を await した後に発行する、`crates/banto-server/src/auth/state.rs:348-390`。認可も DB 照合の後に古いセッションを返しうる、`:690-714`・`:817-824`）。発行の直前と認可の完了時に世代と今のモードを確かめ、切り替えの後は旧い世代から発行も利用もできない。回帰試験: 照合を止めている間に切り替えを終わらせても、トークンが発行されない・その要求が通らない。進行中の書き込みは「世代の確認つきの認可が終わった時点」で許可済みとし、#793（§4.5）の切り離した仕事と同じ扱いにそろえる。
C2b: 新しい DB がユーザーなしで起動してアプリに入れる。ユーザー管理からアカウントを作れ、監査の actor が `admin`。
管理者が 0 のままのロックダウンは断られ、1 つ作れば通る。ロックダウンの後、ログインなしのセッションと grant が失効する。
アカウントが 0 の間も上の (a)・(b) のとおり（ログインは必ず失敗し、既定の業務・管理の更新は拒否。例外の成功は別に確かめる）。ログインなしの間は LAN を（閲覧公開なしで）開けない。
**復元前の検査（起動時の検査が入る PR の条件。ADR-0034 §9）**: 起動を止める検査（組み込みの行・予約名の当たり = C2、必須の設定・ログイン必須での管理者 ≥1 = C2b）を足す PR は、同じ関数を復元の入れ替えの前（予約のときと適用の直前。読み取り専用）にも掛ける。断ったら元の DB を保つ。基準より後の未適用の migration がある候補は、作業用のコピーで migration と検査を通してから交換する。復旧の CLI は、予約された復元があるとき、暗黙に適用も無視もせず、明示のエラーで止まる（C2b）。**待ち受けの可否も起動条件に含める**（C2b）: `banto-serve` の配線は「ログインなしで閲覧公開も off なら listen せず止まる」を復元前の検査にも掛ける（Tauri の配線は含めない。同じ候補を Tauri は許し、ヘッドレスは交換の前に断る）。判定は起動時に使う実効設定（migration と、seed 済みの印が無ければ初回の seed の後の値）で行い、未適用の migration か印の無い候補は作業用のコピーで確かめる。
**CLI と初回の seed の順序（C2b の実装条件。ADR-0034 §5・§7）**: CLI は「予約の確認 → migration → 1 つのトランザクション（seed 済みの印が無ければ、起動と同じ関数で seed と印 → 管理者の作成 → ロックダウン → 監査）」の順で書く。seed をせずにロックダウンだけを書くと、次の通常の起動が同じキーを seed の値（display は `auth.disabled = true`、`scripts/scaffold.mjs:2026-2032`）で上書きし、ログインなしに戻る。回帰試験（SQLite と PostgreSQL。display の生成物）: 新しい DB で通常の起動を一度もせず、CLI → 起動 → 作ったアカウントでログインできる。

### 4.4 #786 ui-settings の条件付きの書き込みと再送

**設計（サーバー）**:

- 保存先は新しい表 `ui_settings`（§4.1）。**2026-11-22 変更**: 旧い `settings` の `ui.{username}.{key}` からの
  移し替えは無い。C4 で参照先を切り替え、旧い読み書きの関数（`settings.rs:428`・`:445`）を消す。
- `ui_settings` の持ち主は文字列の列にする（§10 の 2）: アカウントは `acct:<users.id>`、
  grant は `grant:<kind>`（決定 5）、Tauri のログインなしは `local`。主キーは（持ち主, key）。
- **アカウントの行は外部キーで守る**: 別の列 `user_id`（NULL 可、
  `REFERENCES users(id) ON DELETE CASCADE`）を持ち、アカウントの行では必ず入れ、合成セッションの行では NULL
  （CHECK で持ち主の列と食い違わせない。形は C1 で確定）。「削除と同じトランザクションで消す」だけでは、
  削除の前に受け付けた PUT が削除の後に行を作れる（孤児の行。同じ `users.id` は再利用されないが、消えない）。
  外部キーなら、削除が先に確定すれば PUT が失敗し、PUT が先なら削除が一緒に消す。
  - 外部キーの違反は storage ではなく、セッションが無いときと同じ拒否にして返す。
  - SQLite は接続ごとに外部キーを有効にしていることを前提にせず、効いていることを試験で確かめる。
- **revision は数ではなく、書き込みのたびにサービス層で作る乱数の文字列**（§10 の 19）。
  行が無いことは固定の `"0"` で表す。1 ずつ増やす数だと、バックアップの復元で巻き戻った後に、開いたままのタブの
  古い `ifRevision` が別の値の revision と偶然一致して上書きする。行を消すと 0 へ戻るのも同じ穴。乱数なら、
  復元の後・作り直しの後に書かれた行は別の値になる（取得の時点の値と revision は一緒に戻るので、それを見ていたタブは通ってよい）。
  別案の墓石（値 NULL で revision を進める）は削除の穴だけを塞ぎ、復元には別に世代の値が要るので採らない。
- GET は `{ value, revision }`（行が無ければ `value: null`・`revision: "0"`）。
- PUT は `{ value, ifRevision? }`。`ifRevision` があり、今の revision と違えば `conflict`（REST は 409）と
  現在の `{ value, revision }` を返す。`ifRevision: "0"` は「まだ無いこと」。成功すれば新しい revision を返す。
- **判定と書き込みは 1 文で行う**。PostgreSQL の既定の分離レベルでは、同じトランザクションで
  読んでから無条件に UPDATE しても、2 つが同じ revision を読んで両方通る。場合を分ける:
  - `ifRevision` が `"0"` 以外: `UPDATE ... SET revision = 新しい乱数 WHERE 持ち主・key・revision = ifRevision`。
    変わった行が 0 なら `conflict`。
  - `ifRevision: "0"`: `INSERT ... ON CONFLICT DO NOTHING`。入った行が 0 なら `conflict`
    （同時の INSERT は主キーで片方だけが入る）。
  - `conflict` のときだけ、後から現在の値を読んで返す（その間に消えていれば `value: null`・`revision: "0"`）。
- `ifRevision` を省いた PUT は無条件（設定の画面のように、最後の値が勝ってよい使い方のため）。
  `INSERT ... ON CONFLICT DO UPDATE SET revision = 新しい乱数` の 1 文。
- **消す口**: DELETE（`ifRevision?`。判定は PUT と同じく 1 文）。行を消し、以後の GET は
  `"0"` を返す。K4 の「reset で保存を消す」（§4.6）が使う。いまの provider には消す口が無い（`uiSettings.ts:46-51`）。
- Tauri のコマンドも同じ引数・同じ応答にする（§1）。
- **C4 に admin-core の http・tauri アダプタの最小の追従を含める**: C4 で Tauri の応答が
  `Option<String>`（`lib.rs:3398-3404`）から `{ value, revision }` に、REST の PUT が 204
  （`routes/ui_settings.rs:49-56`）から本文つきに変わり、そのままでは旧い provider が C5 まで壊れる。
  アダプタだけが新しい応答を読み（revision は捨てる）、公開の `UiSettingsProvider` の形（`get` は文字列、`set` は `void`）は
  C5 まで据え置く。C4 と C5 を 1 つにする案は、PR が大きくなるので採らない。

**設計（画面）**:

- `UiSettingsProvider` を置き換える（決定 9）: `get(key)` は `{ value, revision }`、
  `set(key, value, { ifRevision? })` は `{ revision }` を返す。`remove(key, { ifRevision? })` を足す（上の消す口）。
- 直列化（#707）との関係: 条件付きの `set` は、後の `set` に**置き換えさせない**（順に送る）。
  置き換えられて送られなかった無条件の `set` は、今は成功として resolve する。revision つきの応答では
  「送っていない」を成功の revision と見分けられる形にする（例 `{ revision: null, superseded: true }`。
  形は C5 で確定）。条件付きの書き込みが「通った」と誤認されないことを試験にする。
- `updateUiSetting(provider, key, apply)`: 読む → 当てる → 条件付きで書く → `conflict` なら返ってきた
  現在の値に当て直す（回数に上限）。industrial の回り道の置き換え先。
  - **応答だけが失われた書き込み**（#793 の後は、切断しても書き込みは終わる）: 結果が分からない
    失敗の後は、同じ PUT を送り直さずに読み直す。値が送ったものと同じなら成功として終える（revision は乱数なので
    「1 つ進んだ」では見分けない。以後は読み直した revision を使う）。
    違えば現在の値に当て直す。この当て直しは、自分の書き込みが既に入った値に `apply` をもう一度当てることがある。
  - そのため **`apply` は冪等であること**を契約にする（同じ変更を 2 回当てても結果が同じ。キーの上書き・集合への追加など）。
    冪等にできない変更（数を 1 増やす、末尾へ足す）は、呼び手が値の中に操作の id を持って重複を落とす。
    サーバーに操作 ID の表は作らない（ui-settings は画面の記憶で、業務のデータではない。§10 の 12）。
- `createSavedSetting`: 再送は一時的な失敗だけ（間隔を延ばす、上限つき、セッションが替われば止める）。
  `conflict` は `merge(server, current)` があれば呼び、無ければ再送しない。`onSettled` で rune の外へ結果を渡す。
  「一時的」の判定に使える kind がいまの `ERROR_KINDS`（`providers/http.ts:42-51`）には無い
  （`storage`・`other` だけ）。通信の失敗をどう見分けるかは C6 で確かめる（§9.1）。

**破壊的変更と移行**: `UiSettingsProvider` を実装・利用している派生アプリは全部直す（`get` の戻り値が
文字列でなくなる）。`createLocalUiSettings` など同梱の実装も同じ形にする。REST の応答の形が変わる。

**リスク**: 条件付きの書き込みの判定に穴があると、別のタブの変更を黙って上書きする。

**試験**（SQLite / PostgreSQL の両方。別々の接続から同時に）: 同じ revision からの条件付きの UPDATE 2 つで
**片方だけ**が成功し、もう片方が `conflict`。`ifRevision: "0"` の INSERT 2 つでも片方だけ。アカウントの削除と
PUT を競わせて、どちらの順でも行が残らない。居ない `users.id` の行は作れない（外部キーが効いている）。
応答を捨てた後の `updateUiSetting` が、冪等な `apply` で値を二重に変えない（画面の単体）。
バックアップを取る → 書く → 復元、の後で、復元より後に得た `ifRevision` の PUT が `conflict` になる。
消して作り直した行に、消す前の `ifRevision` が通らない。C4 の時点で、旧い形の provider のまま REST・Tauri の読み書きが動く。

### 4.5 #793 書き込みを接続の切断から切り離す

**根本原因**: hyper 1.x は応答待ちの間に相手の FIN を読むと service の future を捨てる。`.await` を
またぐ副作用（確定 → セッションの失効 → 監査）が途中で止まる。

**設計**:

- `BoundServer::serve`（`server.rs:162`）で、router 全体に手書きの層を 1 つ掛ける（§3）。
  POST・PUT・PATCH・DELETE は `next.run(req)` を `tokio::spawn` し、その終わりを待って応答する。
  接続が切れて待つ側が捨てられても、spawn した側は最後まで走る。GET・HEAD・SSE は今のまま。
- 派生アプリは `serve` を通るだけで全書き込みに掛かる。ログインも含める。除外の口は作らない（決定 8）。
- 停止（レビューで変更）: 今の `stop()` は 5 秒で打ち切ってサーバーのタスクを中断する（`server.rs:30-34`・
  `121-135`）。切り離した仕事は中断しても走り続けるので、Tauri の再設定（`lib.rs:2966` の
  `live.server.stop().await` の後で次を起動）では、旧い世代の書き込みが新しい構成の後に状態を書き換えうる。
  順序を決める:
  1. **新規の受付を止める**: 停止の合図の後は、層が書き込みを spawn せずに 503 で断る
     （keep-alive の接続に後から来た要求も含む）。listener も閉じる。
  2. 切り離した仕事の数が 0 になるまで、上限つきで待つ（上限は ADR-0035）。
  3. **上限を超えたら、ログだけで成功にしない**。`stop()` は「書き込みが残っている」を結果で返す。
     再設定の扱いは**露出の向き**で分ける（独立レビューで変更。§10 の 17）:
     - **広げる・同等の変更**（ポートの変更、bind を広げる、閲覧公開を始める）: **切り替えを失敗**にする。
       新しい構成を保存も起動もせず、前の構成で listener を戻す（既にある巻き戻しの経路、`lib.rs:3074-3100`）。
       残った仕事は、それを受け付けたのと同じ構成の下で終わる。
     - **狭める変更**（サーバーの無効化、閲覧公開の停止、bind を狭める。どれも同じ `lib.rs:2960-2969` の経路）:
       listener を**戻さない**。戻すと、止めたはずの口が開いたまま残る（fail-open）。新しい構成を保存し、listener は
       閉じたまま、結果は「止めたが、書き込みが残っている」で返す。残った仕事は監査に残す（数と、分かる範囲の操作）。
       狭めた後も listener が要る構成（bind を狭めただけ、など）は、残った仕事が終わってから起動し、
       終わらなければ起動せずに再試行を促す。
     - 向きの判定は純関数にする。「前の構成へ戻しても、求められた構成より露出が広がらない」ときだけ巻き戻す。
       広げると狭めるが混ざった変更は、狭める側（戻さない）に倒す。
     「旧い世代が以後書けない保証」（世代の番号で全書き込みを柵で囲う）は、サービス層の全部に手が入るので採らない。
  4. アプリの終了は、上限を超えたらログに残して終える（プロセスが消えるので後から書かない。DB のトランザクションは
     確定か取り消しのどちらか）。
- panic: `JoinError` を 500 と「状態を読み直してから、もう一度試してください」に対応する kind で返し、
  `eprintln!` に残す（`tracing` は入れない、§3）。
- **冪等ではない**と明記する。切断したクライアントは結果を知らない。再送で二重に効く操作
  （作成など）は、version や一意制約で守る側の責任。
- Tauri: コマンドは接続を持たないので層は要らない、という前提（**未確認**、§9.1）。これは輸送の違いで、
  認可・監査の対称（§1）は変わらない。ADR に書く。

**S2（handler の点検）**: 層が入っても、handler の中の順序が悪ければ穴は残る。banto の書き込みの
handler（users・ui-settings・backups・ログイン・ロックダウン）を「確定 → 失効 → 監査」の順で 1 つずつ読み、
途中で失敗したときに何が残るかを表にする。STATUS の筋書き 2・3（失効と監査の順、ロックダウンの再検証）は
ここで確かめる。

**破壊的変更と移行**: 挙動の変化（切断しても書き込みが終わる）。派生アプリが自前で包んでいる所
（industrial の `run_detached`）は外せる。二重に包んでも害は無い見込み（未確認）。

**リスク（安全）**: (1) 切断で止まることに頼っていた処理は無いはずだが、長い書き込み（バックアップの
作成）が切断後も走り続ける。数と時間の上限を ADR で決める。(2) 本体の読み込み中に切れた場合は、
body の読みが失敗して handler が自分で終わる（切り離しの対象は「読めた後」）。(3) 失効した後の
セッションで走り続ける仕事が、失効の後に書き込まないこと（S2 で確かめる）。

**試験**: 応答を待たずに接続を閉じるクライアントで、ユーザーの作成と監査の両方が残ること。panic が 500。
停止時に走っている書き込みを待つこと。停止の合図の後に来た書き込みが 503 で、状態を変えないこと。
終わらない書き込みを置いた停止が「残っている」を返すこと。再設定は **2 方向**で確かめる: 広げる・同等の変更は
失敗して前の構成のまま残る。狭める変更（無効化・閲覧公開の停止）は listener が戻らず、新しい構成が保存され、
残った仕事が監査に残る。向きの判定の純関数は、混ざった変更が狭める側になることまで単体で確かめる
（`src-tauri` はレビューで担保。判定の部分は `banto-server` の単体で確かめられる形に切り出す）。

### 4.6 #791 保存してよい配置の確定を知らせる口と、保存の部品のパッケージ化

**根本原因**（確認済み）: `switchNarrow` は `await host.replaceLayout(...)` の後で `wideLayout`・
`narrowShown` を確定する（`ThreePaneDock.svelte:330-355`）。`replaceLayout` はフォーカスが枠の中に
あると、適用の後に `await tick()` を待つ（`DockHost.svelte:585-598`）。この間、`dock.layout` は
行き先の木なのに `layoutSnapshot()` は確定前の値で答える。

**前半（K3）**:

- `replaceLayout` の適用のクロージャ（`DockHost.svelte:588-594`）の中で、`ThreePaneDock` の
  `wideLayout`・`narrowShown` を**同期で**確定する（適用と同じ tick）。確定前の `layoutSnapshot()` を
  読める瞬間を無くす。
- `ThreePaneDock` に `onLayoutCommit(saved: ThreePaneSavedLayout, reason)` を足す（決定 11）。
  - `reason`: `'user'`（利用者の操作が確定した）/ `'reset'`（`resetLayout` が確定した）/
    `'narrow-switch'`（狭い ⇄ 広いの切り替えが確定した）。
  - 呼ばない場合: 切り替えの途中、`beforePanelChange` で断られた・`stale` になった変更、
    アプリが渡した保存値の復元（`restoreLayout`。保存し直す必要が無い）。
  - 操作の途中（divider のドラッグ中）は呼ばず、操作の終わりに 1 回呼ぶ。
  - **発火の定義**（独立レビューで変更。§10 の 18）: 利用者の操作の種類を数え上げない。**確定点で `serialize()` が
    前回の通知（または最後の復元）から変わっていたら 1 回**呼ぶ。確定点は、ポインターとキーボードの操作の終わり、
    公開の API（`showPanel`・`setPanelVisible`、`DockHost.svelte:486-516`。`autoHidePanel` ほか）の適用の後、
    `DockState` を直接呼んだ変更の後（操作中でなければ、次の tick で比べる）。数え上げにすると、API 経由の表示切替・
    キーボードのリサイズ・タブの切り替え・`DockState` 直接の変更が保存から漏れる（ダッシュボードは今、`serialize()` の
    全部の変化を保存している、`dashboard/+page.svelte:267-272`）。
  - 列挙するのは**除外だけ**: 復元（アプリが渡した配置の `replaceLayout`・`restoreLayout`。比べる基準だけを更新する）、
    操作の途中、断られた・`stale` の変更（配置が変わらない）。
  - `'user'` は「復元でも reset でもない確定」の意味にする（API 経由の変更も含む）。`'reset'` は **reset を始めた口が出す**:
    `ThreePaneDock.resetLayout`（`:690`）は `host.replaceLayout`（`:709`）を通るので、`DockHost` からは復元と
    見分けられない。`replaceLayout` の options に確定の理由（省略は復元 = 通知しない）を足し、`resetLayout` が `'reset'` を渡す。
  - `'reset'` のとき、消費側は「既定を保存する」か「保存を消す」かを選べる（temp-scada は消す）。
- **`DockHost` にも同じ口を置く**（レビューで変更。「K3 で決める」をやめる）: ダッシュボードは `DockHost` を
  直接使い、`dock.serialize()` を `$effect` で読んで保存している（`dashboard/+page.svelte:12`・`267-272`・`520`）。
  `ThreePaneDock` だけに口があると、K4 の「保存は `onLayoutCommit` から受ける」へ載せ替えられない。
  `DockHost` の `onLayoutCommit(layout, reason)` は `reason` が `'user' | 'reset'`（狭い ⇄ 広いは無い）。
  呼ばない場合は同じ（操作の途中、断られた・`stale` の変更、アプリが渡した配置の `replaceLayout`）。
  `ThreePaneDock` の口は、これを受けて `ThreePaneSavedLayout` に包み、`'narrow-switch'` を足す形にする。
- テンプレートの `/tree/workspace-dock` の自動保存を、この口に載せ替える。

**後半（K4、#786・#790 の後）**:

- `dockLayoutStore` を `@banto/dock-svelte` に移す。`UiSettingsProvider` は構造的な型
  （`get` / `set` の形だけ）で受け、admin-core を import しない（§4・§5）。
- 持ち主の照合（`scope`・`isCurrent`）と `beforeBaseline` は**省略可能**（決定 12）。省くと
  「キー 1 つ、持ち主なし」で動く（temp-scada の `createLocalUiSettings`）。
- 保存は `onLayoutCommit` から受ける（`serialize()` を `$effect` で読む形をやめる）。`'reset'` で
  「保存を消す」を選べるオプションを持つ（provider の `remove`、§4.4。構造的な型では省略可能にし、無ければ既定を保存する）。
  500ms のまとめ書き・unmount の flush・セッションの世代は今のまま移す。
- 別のタブとの競合は、#786 の条件付きの書き込みを使うかを K4 で決める（配置は最後の操作が勝ってよい、
  が今の前提。推奨は無条件のまま）。
- テンプレートの `lib/banto/dockLayoutStore.svelte.ts` は消し、scaffold の `removeDock` も直す
  （**scaffold の 4 プリセットの dry-run が要る**）。

**破壊的変更と移行**: 前半は足すだけ。後半はテンプレートのファイルが消える（写して持つ派生アプリは
パッケージの口へ載せ替える）。

**試験**: 広い → 狭い → 広いの各瞬間の `layoutSnapshot()` が確定後の値だけであること（フォーカスが
枠の中にある場合を含む）。`onLayoutCommit` が理由ごとに 1 回で、途中・拒否では呼ばれないこと
（`DockHost` 単体と `ThreePaneDock` の両方）。K4 では、ダッシュボードの保存が `DockHost` の口だけで今と同じに働くこと。
独立レビューで追加: ドラッグ以外の変更（API 経由の表示切替 `setPanelVisible`・`showPanel`、キーボードのリサイズ、
タブの切り替え、`DockState` を直接呼んだ変更）でも 1 回ずつ通知され、K4 の保存に載ること。`resetLayout` が `'reset'` で
1 回だけ通知され（`'user'` と二重にならない）、「保存を消す」を選ぶと provider の行が消えること。

### 4.7 #796 進行中の操作を取り消す口

- `DockHost` に `cancelGesture(): boolean`（取り消したら true、`onGestureEnd` へは `'api'`）。
- `replaceLayout` / `resetLayout` は、適用の前に進行中の操作を自動で取り消す（決定 10、挙動の変化）。
  `lifecycle.requestReplace`（`core/lifecycle.ts:553`）が操作中にどう振る舞うかは未確認（§9.1）。
- temp-scada の「`arrange` を一瞬 false にする」回り道が要らなくなる。

### 4.8 #792 実際に画面に出ているか

- `DockState.isOnScreen(panelId)`（反応する値）と `panels[].onScreen`。偽にする場合: 畳んだ区画の中、
  帯にしまわれていて引き出していない（`flyoutPanel` がそのパネルでない）、タブの組の裏、
  タイトルバーへ畳んだ浮動、閉じた浮動。
- `isVisible` は改名しない（doc を「閉じていない」の意味に直す。`state.svelte.ts:566`）。改名するかは §9.2。
- **`layout.docked` だけでは決まらない**（レビューで変更）。浮動は `layout.floating`、帯は `autoHidden` の
  パネルと今の `flyoutPanel`（`state.svelte.ts:625`）にあるので、この 4 つから計算する。真にする場合:
  畳んでいない区画の、タブの組の表のパネル。開いていてタイトルバーへ畳んでいない浮動。帯から今引き出している
  パネル（`flyoutPanel`）。#782 の後も `layout.docked` は影の木の射影として残るので、口の意味は変わらない。
- 試験は偽の 5 つに加えて、**真の 3 つ**（区画の表・開いた浮動・引き出し中）と、引き出しを閉じたら偽へ戻ることを確かめる。

### 4.9 #794 ダークで Toast が透ける

- `ToastHost.svelte:119`・`:125`・`:134` の背景を、`--banto-surface-overlay` の上に tint を重ねる形にする。
  theme のトークン（`banto.css:552-556`）は変えない（表の行やバッジは下の面が見えてよい）。
- tint を背景に使っているほかの部品を点検する。grep で見つかったのは `MenuItem`・`StatusBadge`
  （`packages/ui`）、`BantoGrid`・`HeaderCell`（`packages/grid-svelte`）。浮かぶ面・固定列のように
  「下に別の中身が来る」所だけ直す。`ConnectionBanner`・`UnsavedChangesNotice` は未確認（§9.1）。
- #756 の ToastHost の項目もここで見る。ダークの基準画像が変わる（`visual-baselines.yml` の dispatch で再生成）。

### 4.10 #795 warning と系列の色

- 先頭 4 系列（`--banto-chart-1`〜`4`）と、状態色（warning・danger・success）の OKLab の色差の下限を
  `packages/theme/tests/chart-palette.test.ts` に足す（両テーマ）。5 系列目以降は保証しない（決定 7）。
- 調整は系列の側を最小に（`--banto-chart-2` の色相を warning から離す）。並べ替えはしない。
  色覚特性（CVD）の既存の検査を通し直す。下限の数値は T2 で、今の値を測ってから決める。
- 既存のグラフの 2 本目の色が変わる（基準画像の再生成、CHANGELOG の注意）。

### 4.11 #782・#780 影の木

設計・決定事項・既知の失敗 7 件の扱いは [#782](https://github.com/tyaro/banto/issues/782) の本文が正。
要約: `DockState` の非公開の木 S（墓石つき）を唯一の正にし、見える木は S の射影にする。PR1（性質テスト、
#785）は済み。残りは PR2（`core/shadow.ts` の純関数）→ PR3（inflate / deflate）→ PR4（S を並走）→
PR5（hide / show / float / dockBack）→ PR6（`dockExisting*`・ドロップ・リサイズ。#780 と #781 の系統が
ここで通る）→ PR7（外からの代入・`replaceLayout`・`syncPanels`・`reconcileThreePaneLayout` の整理、
補正の削除）→ PR8（帯を S に載せるかの判断）。

この計画での位置づけは**リリースの前提**（決定 13）。互換のために残している形の見直しは §9.2。

### 4.12 #714 フォームのファイル型（残りの 4）

1〜3（配置・型・参照選択）は v7.10.0 で済み（PR #760〜#762）。`FieldType` は今 12 種
（`packages/forms/src/types.ts:22-34`）。残るのは 4 だけ。

**決めること（Issue）への答え（この計画の推奨。§10）**: 添付の既存の仕組みに**揃える**。
ファイルはレコードの列にせず、今の添付（親の `resource`・`resourceId` に付く別の行、
[attachments-plan.md](attachments-plan.md) §3.1・§3.5）のまま扱う。

**設計**:

- `FieldType` に `'file'` を足す。forms は通信の契約を持たない（参照選択の `search` と同じ流儀）。
  フィールド定義に、構造的な型の口（一覧・アップロード・削除）を渡させる。`@banto/forms` は
  `@banto/attachments` を import しない（§4・§5）。アプリは `attachmentsAdmin.ts` の実装をそのまま渡せる。
- **編集（親の id がある）**: 選んだらすぐアップロード、削除もすぐ。`AttachmentsPanel` と同じ振る舞いで、
  サーバーの口は既存の添付のルート・コマンドだけを使う。**新しい mutating 操作は足さない**ので、
  認可と監査の対称（§1）、親の実在の確認と履歴（[attachment-history-plan.md](attachment-history-plan.md)）は今のまま効く。
- **新規（親がまだ無い）**: 選んだファイルは画面の中で保留し、レコードの作成が成功した後で、
  返ってきた id に対して順にアップロードする。「先に上げて後で結び付ける」形（仮の添付・結び付け・掃除の
  新しい操作が要る）は採らない。
  - 作成は成功したがアップロードが一部失敗した場合: レコードは残る。失敗したファイルを示し、
    編集の状態で再試行できるようにする（黙って捨てない）。
- 値と検証: フィールドの値は「既にある添付のメタ + 保留中のファイル」。保留があれば未保存（dirty）。
  `visibleWhen` で隠れたら保留は送らない。
- **検証の範囲**（レビューで変更）: 添付の API は `resource`・`resourceId` の単位で、どの欄のファイルかを知らない
  （`core/src/rest/attachments.rs:174-176`・`253`）。そこで分ける:
  - **欄の制約**（`required`・件数・`accept`・欄ごとのサイズ）は**画面だけ**が見る。入力を助けるためのもので、
    サーバーは強制しない。**業務上の必須は保証しない**と README・型の doc に明記する（別のクライアントや、
    新規で作成の後のアップロードが失敗した場合に、必須の添付が無い親ができる）。
  - **共通の安全の上限**（1 ファイルの大きさ、MIME はマジックバイト（§6。クライアントの申告を使わない）、
    認可、親の実在）は**サーバー**が今のまま強制する。画面の制約がこれより緩くても、サーバーの拒否をそのまま表示する。
  - **`File` をレコードの送信に混ぜない**: `file` 型の値はフォームの送信値（作成・更新の payload）から除き、
    注入された口だけを通す。レコードの API は `File` もファイルの中身も受けない（契約として型と試験で固定する）。
  - 業務として必須を保証したいアプリは、**別のサーバーの契約**（例: 状態を進める操作の handler が添付の数を確かめる）を
    自分のドメインに置く。この計画では作らない（§10 の 8）。
- **1 つのフォームに `file` 型は 1 欄まで**（レビューで追加）: 添付は親のレコードに付き、欄を区別できないので、
  2 欄あると同じ一覧が両方に出る。2 欄目は定義の時点でエラーにする。欄ごとに分けるには添付に欄の名前を持たせる
  スキーマの変更が要るので、要望が出てから別に計画する。
- 3-way（§10）: demo は添付を拒むので、フィールドは注入された口の拒否をそのまま表示する。

**破壊的変更と移行**: 公開の union `FieldType` に種類が増える（網羅 switch をしている利用側が型エラー）。

**リスク**: 新規のときの「レコードはできたが添付が無い」中間の状態。作成の確認の文言と再試行で受ける。
添付はオプション（template-scope §3）なので、添付を外した scaffold でもフォームが組めること。

**試験**: 単体（保留・`visibleWhen`・検証・失敗の表示、送信値に `File` が入らないこと、2 欄目の定義のエラー、
画面の制約より厳しいサーバーの拒否の表示）、e2e（ui-demo の見本、items の新規と編集）、
添付を外すプリセットを含む scaffold の dry-run。

**片付け**: STATUS の「保留」の記述を外す。#756（合図待ちの追跡）に該当の項目があれば外す
（2026-11-22 に本文を見た範囲では、ファイル型の項目は見当たらなかった。F2 で確かめる）。

### 4.13 #716 ダッシュボードのウィジェット盤（**判断待ち**）

着手の前にオーナーの判断が要る。ここでは選択肢と推奨だけを置く。決まったら、この節を設計に書き直す。

いまの形: `apps/admin-template/src/routes/(app)/dashboard/+page.svelte`（782 行）。KPI とカードの
固定部の下に、別枠の「分析ワークスペース」（dock）がある二重構造。

**判断 1: template-scope §4.2 との線引き**（「画面エディタ / コードレスビルダーは入れない」）

- 推奨: Issue の案のとおり。**配置**（追加・並べ替え・大きさ・表示 / 非表示）は利用者が編集できる。
  ウィジェットの**種類と中身**は作者がコードで登録する。利用者がデータの出どころ・式・見た目を
  画面で組む口は作らない。この 1 文を template-scope §4.2 に足す。
- 別案: 線引きを変えず、#716 を見送る。

**判断 2: 二重構造の解き方**

| 案 | 中身 | 得 | 失 |
| --- | --- | --- | --- |
| A | 固定部を新しい「盤」（格子に並べる部品）に置き換え、dock は残す | KPI の小さなタイルに合う | 配置の仕組み・保存・キーボード操作が 2 つになる。二重構造は残る |
| B | 全部を dock のパネルにする（KPI も 1 枚ずつ） | 仕組みが 1 つ。保存は K4 の部品、操作と読み上げは既にある | dock は分割の木で、小さなタイルをたくさん並べるのに向かない。キオスクの大型 KPI |
| **C（推奨）** | KPI の帯は固定（作者が定義、並べ替えなし）。残り（チャート・一覧・メモ）は **1 つの dock** に寄せ、「分析ワークスペース」の別枠をやめる | 編集できる配置は 1 つ。新しい配置の部品を作らない。キオスク（`arrange={false}`）・狭い幅は dock の既存の振る舞い | KPI の並べ替えはできない。固定部のカードを dock のパネルに直す作業 |

破壊的変更を厭わないので、C では今の保存キー（`dock.dashboard`）の配置を引き継がず、既定へ戻してよい。

**判断 3: 配置の保存と配布**

- 保存は利用者ごと。K4（パッケージ化した保存の部品）と C5（revision つきの provider）を使う。
- 管理者が既定の配置を配る口は**作らない**を推奨（要望が出たら起票。既定は作者がコードで決める）。

**判断 4: 範囲**: Issue の「やること 3」（期間フィルタの共有・クロスフィルタ・ドリルダウン）を
この版に入れるか。推奨は、期間フィルタの共有だけ入れ、残りは別 Issue に分ける。

**PR の分け方（判断の後の見込み。C の場合）**: W0 線引きを template-scope に書く（文書）→
W1 ウィジェットの登録の型と、固定部のカードの載せ替え → W2 dock への一本化・追加と表示 / 非表示・
保存（K4・C5 の後）→ W3 期間フィルタの共有。

**注意**（Issue のとおり）: command-palette の基準画像も変わる。charts を外すプリセットで壊れないこと
（scaffold の dry-run）。キオスクの大型 KPI と touch 密度。

## 5. 依存関係

- C0（ADR の承認）→ C1（基準の作り直し）→ C2（#778 の保護と帰属）→ C2b（初回セットアップの撤去）→ C3（#790）→
  C4（#786 サーバー）→ C5（provider）→ C6（`createSavedSetting`）。C1〜C4 は同じファイル（`users.rs`・`audit.rs`・
  Tauri の `lib.rs`）に触れるので直列。
- **C1b（#820 の `lib.rs` のテスト分離）→ C2**: C2・C2b が `lib.rs` の認証まわりを大きく触るので、C1b の準備 PR を先に入れる。C1b は C1 と並行して準備してよいが、C2 の前に C1・C1b の両方が必須（機能変更なしの準備 PR なので順序の制約はこれだけ）。
- **2026-11-22 変更（互換不要・DB 作り直し）**: データの移行の手順（組み込みの行を起動時に入れる・`account_uid` の埋め込み・
  旧い `ui.*` の移し替え）は無くなった。組み込みの行は C1 の migration が入れるので、**`users` の数え方の直しは C1 に入る**
  （入れないと、新しい DB で初回セットアップが出なくなる）。初回セットアップそのものは C2b で外す。
- 途中の main が壊れない条件: C1・C2 の後は今の初回セットアップで最初の管理者を作れる。C2b の後は、新しい DB が
  ログインなしで起動し、ユーザー管理からアカウントを作れる。ui-settings は C4 まで旧い保存先（`settings` の `ui.*`）で読み書きでき、
  C4 で `ui_settings` へ切り替える（移し替えは無い）。C4 は admin-core の http・tauri アダプタの最小の追従を含み、
  公開の provider の形が変わるのは C5（§4.4）。どの PR も REST と Tauri を一緒に変える（conventions §1）。
- S1（#793 の層）は C1 と並べられる（`server.rs` と新しいファイルだけ）。S2（handler の点検）は
  `routes/users.rs`・`ui_settings.rs` を読んで直すので、**C2 の前に済ませる**（C2〜C4 と同じファイル）。
- K4（#791 後半）は C3（持ち主のキー）と C5（provider の形）の後。dock の中では PR7 の後（§6）。
- T1（#794）・T2（#795）は誰とも重ならない。T2 は基準画像を変える。T1 の Toast は基準画像を使わず、computed style の試験で確かめる（§7）。
  C2b もログインの画面の基準画像を変える（初回セットアップの画面が無くなる）。
- F1 → F2（#714）は誰とも重ならない（`packages/forms` とテンプレートの items）。早く始めてよい。
- W0（#716 の判断）は C0 と同時に諮る。W1 は判断の後すぐ、W2 は **K4 と C5 の後**（保存の部品と provider の形）、
  ダッシュボードの保存を K4 が載せ替えた後に触る（同じ `+page.svelte`）。
- D1 は全部（#714・#716 を含む）の後。

## 6. dock の PR の順序（ファイルの衝突を減らす）

| 順 | PR | 主に触れるファイル | 並べ方 |
| --- | --- | --- | --- |
| 1 | K1 #792 | `state.svelte.ts`・`types.ts`・README | #782 PR2・PR3 と並行可（PR2・PR3 は新しいファイルだけ）。**PR4 の前に入れる** |
| 1 | K2 #796 | `DockHost.svelte`・`core/gesture.svelte.ts` | K1・PR2・PR3 と並行可 |
| 1 | #782 PR2 → PR3 | `core/shadow.ts`（新規）と試験 | K1・K2・K3 と並行可 |
| 2 | K3 #791 前半 | `DockHost.svelte`・`ThreePaneDock.svelte`・テンプレートのデモ | **K2 の後**（同じ `replaceLayout` の周り）。PR4 と並行可 |
| 3 | #782 PR4 → PR5 → PR6 | `state.svelte.ts`・`core/slot.ts`・`core/tree.ts` | K1 の後。直列 |
| 4 | #782 PR7 | `DockHost.svelte`（`replaceLayout`）・`ThreePaneDock.svelte`（`reconcileThreePaneLayout`）・`core/replace.ts` | **K3 の後**（同じ所を整理する） |
| 5 | #782 PR8 | `core/autohide.ts`・`state.svelte.ts` | PR7 の後。保存形式を変えるならここまでに決める（§9.2） |
| 6 | K4 #791 後半 | dock-svelte の新しいファイル・テンプレート・`scripts/scaffold.mjs` | PR8 と C5 の後（保存形式と provider の形が決まってから） |

K1・K2 は小さいので、#782 PR2 の着手と同時に出して先に入れる。K3 と K4 は同じ人（同じ文脈の要点）で続けてよい。

## 7. PR の分け方と順序

1 PR = 1 エージェントに任せられる大きさ。各 PR で `pnpm check`・`pnpm format:check`・該当の単体テスト、
CHANGELOG の `[Unreleased]` に 1 行（破壊的なら「消費側への注意」も）、この文書の状態行の更新。
`src-tauri` はコンパイルできない環境があるので、Tauri 側はレビューで担保する。

**2026-11-22 変更（互換不要・DB 作り直し）**: C1〜C4 から、データの移行（組み込みの行を起動時に入れる手順・
`account_uid` の埋め込み・旧い `ui.*` の移し替えと削除・既存の `admin` の検出と改名の口・復元の候補の事前検査）を
外した。代わりに、初回セットアップの撤去（決定 18）を C2b として足した。

| PR | 範囲 | パッケージ・場所 | 破壊的 | モデル | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| **C0** | ADR: 持ち主の識別、組み込みの `admin`、初回セットアップの撤去とロックダウンの条件（新規 ADR-0034、ADR-0017 の改訂）。conventions §11 の「基準の作り直し」の注記。`.en.md` も | `docs/adr`・`docs/conventions` | — | fable | **済み**（PR #804。2026-11-22 に Accepted。§10 の N2〜N6 を含めて確定） |
| S1 | **状態: 実装済み・レビュー待ち（PR #829、ADR-0035 は 2026-11-22 に Accepted、5 点はオーナーが推奨どおりで確定）。** #793 の層・停止（受付を止めて待つ。超過は向きで分ける: 広げる変更は切り替えの失敗、狭める変更は止めたまま）・panic・切断の試験・ADR-0035 | `banto-server`・`src-tauri` | 挙動 | fable | 切断しても作成と監査が残る試験が通る。停止の試験（§4.5） |
| S2 | #793 handler の順序の点検と直し | `banto-server/routes`・テンプレートの `rest`・`src-tauri` | 挙動 | fable | 点検の表を PR に載せ、直した所に試験 |
| C1 | 基準の作り直し（2 方言）: **#814 のうち、今回追加する起動・seed 用のキー（`auth.disabled` 等、seed 済みの印）の名前だけを決める（C1 の前に、キーと利用先を読み取りで棚卸しする。既存の UI の論理キーは触らない。C4/C5 の行を参照）**。`0003_users.sql`・`0005_audit_log.sql` の書き換え、`0014_ui_settings.sql`（表と組み込みの `admin` の行）。`verify-migrations-frozen.mjs` の今回かぎりの許可。旧版の DB を断る文言（`run_migrations`）、`REQUIRED_TABLES` に `ui_settings`。**組み込みの行の最低限の保護**（verifier を `kind = 'account'` に絞る・パスワード・更新・削除・CSV の取り込みが `kind = 'builtin'` を断る）と、**復元の検査**（`_sqlx_migrations` の版と checksum を予約と適用の直前に読み取り専用で確かめる。migrator は配線が `BackupService` に渡す。ADR-0034 §9）。**初回の seed の条件の直し**（`seed_first_boot_settings` を「表が空」から「seed 済みの印が無い」へ。0014 が `settings` に行を入れるので同じ PR で。ADR-0034 §5）。**同じ PR で**: 作成時の `account_uid` の採番、`users` の数え方を `kind = 'account'` に、`admin` を使う試験 / fixture / e2e / demo / scaffold の生成物の改名（組み込みの行と username が当たるため） | テンプレートの `core`・`banto-admin-services`・`scripts`・`e2e` | **破壊的** | fable | **実装済み・レビュー待ち**（PR #830、2026-11-22。決めた点: seed 済みの印は `first_boot.seeded` で、一覧が空でも書く。試験の `admin` は `manager` に改名。**持ち越し**: `0014` への `auth.disabled`・`auth.disabled_role` の INSERT は入れていない — 入れると今の `banto-serve` が起動を断り初回セットアップも通らないので、C2b で入れる。demo の `admin / admin` の改名もログインの画面が変わる C2b へ）。§4.1 の試験（両方言）。新しい DB（組み込みの行だけ）で今の初回セットアップができ（INSERT の条件は `kind = 'account'`）、ui-settings が今のまま読み書きできる。**C1 の実 migration（0001〜0014）を当てた DB で display の生成物を起動し、公開閲覧（`server.viewer_public`・`server.enabled`・bind の seed）を確かめる**。`pnpm verify:architecture` rule 11・`pnpm verify:migrations` |
| C1b | #820 `apps/admin-template/src-tauri/src/lib.rs` のテストを別ファイルに分ける（準備。C2・C2b が認証まわりを大きく触るので、先に分けて衝突を減らす） | `src-tauri` | — | sonnet | 分ける前後でテストの数と結果が同じ。挙動の変更なし（Tauri 側はレビューで担保）。**状態: 実装済み**（`src-tauri/src/tests.rs` に分離。scaffold・add-resource の差し込み先も移した） |
| C2 | **#807 auth フローの `AuditEntry` を `*_as` へ**。#778 組み込みの行の保護（禁止・verifier・SQL の `kind`）・予約名（一覧を渡す口）・grant を後から足したときの起動時の検査・帰属の印（`audit_as_builtin_admin`）と認可時のスナップショット・監査の `actor_id` / `actor_kind`（列を足す。wire は `actorKind`）。**予約名の導入で、smoke の管理者名 `public`（`e2e/tests/smoke.spec.ts:51,269–273`）と公開閲覧 suite の同名（`e2e/tests-public-viewer/public-viewer.spec.ts:37,191–217`）が使えなくなるので、e2e の名前の変更は C2 と同時** | `banto-admin-services`・`banto-server`・`src-tauri`・テンプレート | **破壊的** | fable | §4.3 の試験（C2b の分を除く）。両経路の対称。**この PR で足す起動時の検査（組み込みの行・予約名の当たり）を、同じ関数で復元前の検査にも掛ける**（断ったら元の DB を保つ。ADR-0034 §9） |
| C2b | **#819 ロール型の統一（フロントの変更と一緒に）**。初回セットアップの撤去（決定 18）: `auth.disabled` の既定を on、ロックダウンの条件（管理者のアカウントが 1 つ以上）、ログインなしの間の REST（読み取り専用。ログインの許可・トークンの発行・認可をモードの世代で切り替えと直列化。ADR-0034 §6）、設定の明示と異常時の停止（キーの欠落・破損。seed の条件の直しは C1 で済み）、`banto-serve` の listen の条件（ログインなしで閲覧公開も off なら listen せず止まる）、`setup_first_user`・`is_initialized`・`/api/auth/setup`・`auth_setup`・bootstrap の窓・`AuthProvider.setup`・ログインの画面の分岐と文言を消す。ヘッドレスの最初のアカウント（N3。CLI は予約された復元があれば明示のエラーで止まる）。e2e（`createFirstAdmin` の置き換え・smoke・add-resource に加え、setup を直接呼ぶ公開閲覧 suite のケース 5 も移行。公開閲覧 suite は「実アカウント 0 件のまま閲覧成功・業務の書き込み拒否」と「CLI で管理者を作成し、ログイン必須・公開閲覧有効の別 DB でログイン／ログアウト／セッション競合」に分け、両方の保証を残す）・`rename.mjs`・scaffold の seed・基準画像 | `banto-admin-services`・`banto-server`・`src-tauri`・`admin-core`・テンプレート・`e2e`・`scripts` | **破壊的** | fable | §4.3 の C2b の試験。新しい DB がユーザーなしで起動し、ユーザー管理からアカウントを作れる。e2e が通る。scaffold の 4 プリセットの dry-run と template-acceptance。両経路の対称。**実装条件**: (1) この PR で足す起動時の検査（必須の設定・ログイン必須での管理者 ≥1）を、同じ関数で復元前の検査にも掛ける（断ったら元の DB を保つ。未適用の migration がある候補・seed 済みの印が無い候補は作業用のコピーで検査。`banto-serve` の配線は待ち受けの可否も含め、同じ候補を Tauri は許しヘッドレスは交換の前に断る試験を足す。ADR-0034 §9）。(2) 照合・認可の DB 照合を止めている間に切り替えを終わらせる回帰試験で、旧い世代から発行も利用もできない（進行中の書き込みの扱いは #793・§4.5 とそろえる。ADR-0034 §6）。(3) CLI は起動と同じ関数で初回の seed と印を書いてから、同じトランザクションでロックダウンを書く。新しい DB（SQLite・PostgreSQL、display の生成物）で通常の起動をせずに CLI → 起動 → ログインの回帰試験（ADR-0034 §5・§7） |
| C3 | #790 `accountId` を wire に載せる・`sessionOwnerKey` | `banto-server`・`src-tauri`・`admin-core`・テンプレート | **破壊的** | fable | §4.2 の試験（復元の回帰試験を含む）。持ち主つきの記憶の利用箇所を全部確認 |
| C4 | #786 サーバー（条件付きの PUT・DELETE・乱数の revision・外部キー・Tauri）。参照先を `ui_settings` へ切り替える（移し替えなし）。**既存の UI の論理キー（例 `dashboard.memo`）は、変える必要があるものだけここ（C4/C5）で判断する（#814）**。admin-core の http・tauri アダプタの最小の追従（公開の provider の形は据え置き） | `banto-admin-services`・`banto-server`・`src-tauri`・`admin-core`（アダプタだけ） | **破壊的** | fable | §4.4 の競合の試験（両方言、片方だけ成功）。削除と PUT の競合で行が残らない。旧い形の provider のまま画面が動く |
| C5 | #786 provider の置き換え（`remove` を含む）・`updateUiSetting`・同梱の実装・呼び手の追従 | `admin-core`・テンプレート | **破壊的** | fable | #707 の直列化の試験が新しい形で通る |
| C6 | `createSavedSetting` の再送・`merge`・`onSettled`・README | `admin-core` | 足すだけ | sonnet | 再送・停止・競合の単体テスト |
| T1（実装済み: fix/794-toast-dark-tint の PR）| #794 Toast と浮かぶ面の tint（Grid の固定列の透けを含む）。**#808 のうち ToastHost の色だけを T1 に合わせる**（Dock/Grid の primary の文字と Tree の `--banto-surface-muted` は T1b） | `ui`・`grid-svelte` | 見た目 | sonnet | ダークで透けない。ダークで、着色された BantoGrid の固定列の後ろにスクロールする文字が透けない。実ブラウザーで success・error・warning の Toast の背景の最下層が不透明（`e2e/demo/toast-opaque.spec.ts`。基準画像は使わない） |
| T1b | #808 primary の文字を `--banto-primary-text` へ（dock の DockedTree・DockWindow、grid の BantoGrid・HeaderCell）と、`--banto-surface-muted` の定義（Tree の 2 か所）。T1 とは別の小さな PR（見た目の差分の原因を追いやすくする） | `dock-svelte`・`grid-svelte`・`theme`・テンプレート | 見た目 | sonnet | axe が通る。基準画像の再生成。差分が T1 と混ざらない |
| T2 | #795 色差の試験と最小の調整 | `theme` | 見た目 | fable | 試験が両テーマで通る。CVD の検査 |
| K1 | #792 `isOnScreen`（`docked`・`floating`・`autoHidden`・`flyoutPanel` から） | `dock-svelte` | 足すだけ | sonnet | 偽の 5 つと真の 3 つの単体テスト。README。**実装済み**（`tests/on-screen.test.ts`。`isVisible` は改名せず doc を直した。PR は #825（#792 を Closes）） |
| K2 | #796 `cancelGesture` と自動の取り消し | `dock-svelte` | 挙動 | sonnet | 操作中の `replaceLayout` の単体テスト 状態: **PR 提出済み**（2026-11-22、`feat/796-dock-cancel-gesture`。`replaceLayout` は `invalid` なら取り消さず、拒否・`stale` でも取り消したままにする。`lifecycle.requestReplace` は変更なし） |
| K3 | #791 前半（`DockHost` と `ThreePaneDock` の両方に `onLayoutCommit`） | `dock-svelte`・テンプレート | 足すだけ | fable | §4.6 の試験。e2e（workspace-dock の保存） |
| #782 PR2〜PR8 | Issue の本文どおり | `dock-svelte` | PR ごとに判定（§9.2） | fable | 本文の各 PR の条件。PR6 で #780 を閉じる。**PR2（`core/shadow.ts` の純関数と試験）は PR #826**（配線なし。設計上の判断は PR の本文） |
| K4 | #791 後半 | `dock-svelte`・テンプレート・scaffold | **破壊的** | fable | ダッシュボード・workspace-dock の保存が今と同じ（API 経由の表示切替・キーボード・タブの切り替えを含む）。scaffold の dry-run |
| F1 | #714 `file` 型（保留の持ち方・画面の検証・送信値から除く・1 欄まで・ui-demo の見本）。**状態: 実装済み（PR 提出、2026-11-22）。親の id は `BantoForm` の `fileParentId`、作成後の送信は `uploadPendingFiles`、`FormDraft` は `file` 欄を受けない** | `forms`・ui-demo | union に追加 | fable | §4.12 の単体テスト。forms がほかのパッケージを import しない |
| F2 | #714 テンプレートの配線（items の新規・編集、作成後のアップロード、失敗の再試行）・README・片付け | テンプレート・scaffold | 足すだけ | sonnet | e2e。添付を外すプリセットの dry-run。#714 を閉じる |
| W0 | #716 の判断（§4.13 の 1〜4）と template-scope §4.2 の 1 文 | `docs` | — | fable | **オーナーの判断** |
| W1〜W3 | #716（判断の後に §4.13 を設計へ書き直してから。W2 は K4・C5 の後） | テンプレート（＋判断による） | 見た目・保存 | fable | 判断の後に決める。基準画像の再生成、scaffold の dry-run |
| D1 | 下流の使い勝手の精査（回り道・写し・自前の包みを読み、置き換えられるか・足りない口を洗う）。**#821 `BantoTree` の不足（行末のアクション・ドロップの可否の口・外からの絞り込み）が不足かどうかを確かめる（調査だけ。不足が確かめられたら別 Issue・別 PR）** | 読み取りのみ | — | fable | 所見の一覧（Issue か文書） |
| D2 | D1 の結果のリファクタ（PR に分ける）。**v8 で入れる（確定）: #811 日付・時刻の解析と形式の複製の解消（#813・#815 を統合。D13 の前提）・#816 ピッカーの `ownText`・`mirroredValue` の統合・#818 テスト差し替え用の抽象の削除・#822 BantoGrid の編集の状態遷移の分離（D1 の後に独立 PR。#713 で入った既存の行選択・一括操作（#749・#752・#751・#753・#754）の挙動は維持）。各々 D1 の所見の後に着手する（必ずやる）** | D1 による | D1 による | D1 による | D1 の所見が閉じる |
| D3 | upgrading・CHANGELOG の「消費側への注意」・実機確認（#757 に #793 の切断と #794 のダークを足す）・版の判定 | `docs` | — | sonnet | リリースの準備の PR |

並べ方: C0 の承認が最初。その後は 4 本の列を並べる — サーバー（S1 → S2 → C1 → C1b → C2 → C2b → C3 → C4）、
画面（C5 → C6、C4 の後）、theme（T1・T1b・T2）、dock（§6）。S1 と C1 は並行できる。C1b は C1 と並行して準備してよい（C2 の前に C1・C1b の両方が必須）。
F1・F2 はいつでも。W0 は C0 と一緒に諮り、W1〜W3 は dock の列の後ろ（K4 の後）に付ける。
C1 は「スキーマ・採番・数え方・fixture の改名」で大きいが、分けると途中の main が壊れる（組み込みの行が入った時点で、
`admin` を作る試験と、全行を数える初回セットアップの判定が落ちる）。C1 のエージェントには、fixture の改名を
機械的な置換として先に済ませる順を指示する。

## 8. CHANGELOG「消費側への注意」の要点

D3 でまとめる。各 PR は自分の分を `[Unreleased]` に書いておく。

- **DB を作り直す**（2026-11-22 変更: 互換不要）: この版は**旧版の DB を読めない**。旧版の DB で起動すると、
  明示のエラーで止まる（スキーマは変えない）。**旧版のバックアップも復元できない**（予約の時点で拒む）。
  データを移す口は無い。必要なデータは、旧版で CSV などに書き出してから、新しい DB に入れ直す。
  旧版へ戻すときは、旧版のバイナリと旧版の DB（残しておく）をそのまま使う。
  - 派生アプリは `0003_users.sql`・`0005_audit_log.sql` を差し替え、`0014_ui_settings.sql` を足す（両方言）。
    自分の migration を 0014 以降で足していれば番号をずらす。`users` へ直接 INSERT している seed・試験は、
    `account_uid` を入れる（入れないと CHECK で失敗する）。
- **初回セットアップが無い**: 新しい DB はユーザーなし・ログインなしで起動する。ユーザー管理が要るときだけ、
  ユーザー管理の画面からアカウントを作る。ログイン必須へ切り替えるには、管理者のアカウントが 1 つ以上要る。
  `/api/auth/setup`・`auth_setup`・`AuthProvider.setup`・status の `initialized`・`BANTO_ALLOW_SETUP` は無くなる。
  ログインなしの間は、LAN を開けない（閲覧公開だけは開ける。今の規則のまま）。ヘッドレスの最初のアカウントは CLI で作る。
- **Identity**: `accountId`（`users.account_uid`）を載せる（Tauri の組み立て、REST の verifier）。載せないと
  持ち主つきの記憶が働かない。
- **ユーザー一覧**: 組み込みの `admin` が居る。消せない・変えられない・ログインできない。`admin`（大小無視）と
  grant の固定 id のアカウントは作れない。監査の actor に `actor_id`。`admin` に帰属させる grant には `GrantSpec` の印を
  付ける（付けなければ今のまま固定 id）。Tauri のログインなしの監査の actor は `local` から `admin` に変わる
  （監査を名前で絞っている所を直す）。grant を後から足して、固定 id と同名のアカウントがあると起動が止まる。
- **ui-settings**: 保存先が新しい表に変わる。`UiSettingsProvider` の `get` / `set` の形、REST・Tauri の応答の形が変わる。
  条件付きの書き込みと `updateUiSetting`。`createSavedSetting` の再送は opt-in。revision は数ではなく不透明な文字列
  （大小を比べない・足さない。無い行は `"0"`）。消す口（DELETE・`remove`）が増える。
- **サーバー**: 書き込みは接続が切れても最後まで走る。冪等ではない。自前の `run_detached` は外せる。
  停止は書き込みの終わりを待ち、待ち切れなければ結果で知らせる。再設定は、広げる・同等の変更なら失敗として前の構成へ戻し、
  狭める変更（無効化・閲覧公開の停止）なら listener を閉じたまま新しい構成を保存する。
- **dock**: `onLayoutCommit`（理由つき）で保存する。`dockLayoutStore` はパッケージの口へ。`isOnScreen`。
  通知は「確定点で配置が変わっていたら」で、API 経由の変更でも届く（`'user'`）。復元では届かない。
  `cancelGesture`、`replaceLayout` / `resetLayout` は進行中の操作を取り消す。影の木で戻る場所が変わる例
  （#780 と既知の失敗 1〜3・6・7）。保存形式を変えた場合は、古い保存を読めないとき既定へ戻ること。
- **forms**: `FieldType` に `'file'`（網羅 switch の型エラー）。新規では作成の後にアップロードする。
  欄の必須・件数は画面だけの制約で、サーバーは保証しない。1 つのフォームに 1 欄まで。
- **ダッシュボード**（#716 の判断による）: 配置の保存が既定へ戻る、ウィジェットの登録の口。
- **theme**: ダークの Toast の背景、`--banto-chart-2`（ほか先頭 4 系列）の色。

## 9. 未確認・各 PR で検討

### 9.1 未確認（実装の PR で確かめる）

- #793: 失効と監査の順、ロックダウンの再検証（S2）。Tauri のコマンドが途中で捨てられない前提（S1）。
  `axum::middleware::from_fn` の `Next` を spawn へ渡せるか（`Send + 'static`）、二重に包んだときの挙動（S1）。
  **S1 で確認済み**: `Next` は spawn へ渡せる（axum 0.8）。Tauri の async コマンドは `async_runtime::spawn` で
  走る（`tauri` 2.12 の `InvokeResolver::respond_async`）ので、途中で捨てられない。二重に包むと入れ子になるだけ。
  ADR-0035 §1・§6。
- #793: Issue が挙げる industrial の `local_grant.rs:678` は別リポジトリで、ここでは開いていない。
- #793: 構成の「露出の向き」を比べる項目の全部（有効・bind・閲覧公開のほかにあるか）と、残った仕事を監査に書く形（S1）。
  **S1 で確認済み**: `ServerSettings` の項目は有効・bind・ポート・閲覧公開の 4 つで、ポートは露出を変えない。
  監査は `detail.remainingWrites = {count, operations}`（ADR-0035 §5）。
- 基準の作り直し（C1）: sqlx が、新しい migration を当てる**前に** checksum の不一致で止まること（両方言。試験で固定）。
  `VersionMismatch` を明示の文言に写す所の形。下流が自分の migration を何番から足しているか（D1）。
  `users` へ直接 INSERT している試験・seed・scaffold の生成物（`scripts/lib/add-resource-rust.mjs` ほか）の数。
- #778: `users` を数える所の全部（C1）。`admin` を使う試験・fixture・e2e・demo の数と、改名後の名前（C1）。
  監査を名前（`local`）で絞っている所が下流にあるか（D1）。組み込みの行に届きうる経路（CSV の取り込み・権限の個別付与・
  自動ログイン）の全部（C2）。
- 初回セットアップの撤去（C2b）: `auth.disabled` の既定を読んでいる所の全部（`settings.rs:180` のほか、画面・`banto-serve`・
  scaffold の seed）。`banto-serve` がログインなしの設定をどう扱うか（listener は環境変数から来る、`banto-serve.rs:277`）。
  Tauri のログインに試行の制限があるか（REST は `auth/policy.rs`。Tauri の `lib.rs` では見つけていない）。
  `auth_status` の `initialized` を読んでいる画面・下流（D1）。ロックダウンで失効させるセッションの全部
  （ログインなしの合成セッション・印つきの grant）。template-acceptance が C2b の変更で走る条件。
- #786: SQLite の外部キーが全部の接続で有効か（C4）。
- #790: TS の `Identity` を自分で組み立てている所、`identity.id` を持ち主として使っている所の残り（C3）。
- #786: 「一時的な失敗」を見分ける kind（C6）。バックアップ・リストアが `ui_settings` を含むか（C1）。
- #791: テンプレートの `/tree/workspace-dock` で実際に確定前の保存が起きるか（K3 で再現の試験を先に書く）。
  `DockHost` の `onLayoutCommit` を `ThreePaneDock` の口が包む形で、確定の同期（§4.6 前半）が保てるか（K3）。
  `DockState` を直接呼んだ変更を、操作の途中と取り違えずに次の tick で拾えるか（K3）。
- #796: `lifecycle.requestReplace` の操作中の扱い（K2）。
- #794: `BantoGrid` の固定列の透け、`ConnectionBanner`・`UnsavedChangesNotice`（T1）。
- #795: 今の色差の実測値と、下限の数値（T2）。
- #714: 参照選択（3）で採った注入の形に `file` 型をそろえられるか、ResourcePage のフォーム定義から渡せるか（F1）。
  #756 に外す項目があるか（F2）。
- #716: 固定部のカードが dock のパネルとして成り立つ最小の大きさ、キオスクの見え方（W1）。

### 9.2 #782 で「壊して正しくできる所」の検討候補（決定 14）

#782 の本文の決定は覆さない。次は、互換を保つ必要が無くなったことを受けた**検討の候補**で、
各 PR で得失を書いてオーナーに諮る。

| 候補 | いまの形（#782 本文） | 壊すなら | 検討する PR |
| --- | --- | --- | --- |
| 保存形式 | `version` 2 \| 3 のまま。S から `dockSlot` を導出（deflate）し、読み込みで組み直す（inflate） | S をそのまま保存する `version` 4。inflate / deflate の「今の slot の表現力に縛られる」危険と既知の失敗 6 の根が消える。古い保存は inflate で 1 回読むか、読めなければ既定へ戻す | PR3（境目を決める時）・PR8 |
| slot の公開 API | `captureDockSlot` / `restoreDockSlot`・`DockSlot` の型を残す | 公開から外す（S の操作に置き換わり、外から slot を作る意味が無くなる）。使っている下流があるかは D1 でも見る | PR7 |
| 既知の失敗 4（`MIN_SHARE`） | 5% 未満の切り上げが順序に出るのを「仕様として許容」 | S が元の比率を持ち、切り上げを射影（表示）の時だけにする。順序に出なくなる | PR2（S の型）・PR5 |
| 既知の失敗 5（帯の逆順） | PR8 で判断 | 帯を S に載せる。`autoHidden[].slot` の形が変わる（保存形式の変更と一緒に） | PR8 |
| 外からの丸ごと代入 | `dock.layout = ...` を受け、差分から推測する | 代入をやめて `replaceLayout` / `hydrate` に限る（推測の補正を消せる） | PR7 |
| `isVisible` の名前 | #792 では改名しない | 「閉じていない」の意味の名前に改名し、`isOnScreen` と対にする | K1（諮るだけ。既定は改名しない） |
| 細部（split id の再利用・tab の active） | 既存テストとずれたら 1 件ずつ報告 | 変えない（本文の決定のまま） | — |

保存形式を変える場合は、(1) 古い `version` の読み込みを 1 版だけ残すか、(2) 読めない保存は既定へ戻すかを
決め、§8 の注意に書く。K4 の保存の部品は、読めない値を「既定へ戻す」で受ける（今の `validate` と同じ扱い）。

## 10. この計画で新しく置いた判断（2026-11-22 オーナー確定。#716 を除く）

**2026-11-22 にオーナーが、推奨どおりで確定した（#716 の項目 9 だけは判断待ち）。C0 の ADR-0034 はこれを記録し、同日 Accepted になった（PR #804 の「オーナーに確かめたい点」もすべて推奨どおり）。この計画書との食い違いは ADR が正。** 各項目の「推奨」は決定として読む。**2026-11-22 変更（互換不要・DB 作り直し）**: 先頭の N1〜N6 が、決定 16〜18 を
受けて新しく置いた項目（N1 は解決済み、N2〜N6 は推奨どおりで確定）。その下の 1〜20 は、クロスレビュー・独立レビュー
（PR #797）で置いた項目で、番号は本文からの参照のために変えていない。既存のデータにだけ関係していた項目は
「解決（互換不要）」と印を付けて短くした。

- **N1. 解決（2026-11-22 オーナー。決定 18）: 組み込みの `admin` はログインできない**。比べた 2 案:
  A「パスワードでログインできる。初回セットアップでこの `admin` のパスワードを決める」は、既知の名前 `admin` が
  パスワードの的になり（ログイン試行の制限 `auth/policy.rs` だけが守り）、最後の管理者のガード・verifier・
  `password_hash` に組み込みの行のための分岐が要る。B「ログインできない。ログインなしの操作の記録先だけ」は、
  その分岐が全部要らない。採ったのは B を進めた形で、**初回セットアップそのものを無くす**（ユーザーもパスワードも作らない。
  §4.3）。名前の案（`Admin`・内部名 `builtin.admin`）の比較も、決定 17 で不要になった。
- **N2. migration の形**: 既存の `0003_users.sql`・`0005_audit_log.sql` を書き換えて基準を作り直し、
  `0014_ui_settings.sql` を足す（決定。§4.1 の (ii)）。旧版の DB を sqlx が自分で断り、列の制約を最初から正しく置ける。
  代わりに conventions §11 の「リリース済みは追記のみ」を 1 回だけ破り、`pnpm verify:migrations` に今回かぎりの許可を足す。
  別案は 0014 を足すだけ（(i)。規約は破らないが、旧版の DB を断る自前の検査と、NULL・固定値の扱いが残る）。
- **N3. ヘッドレス（`banto-serve` だけ）の最初のアカウント**: Tauri のログインなしが無いので、DB に触れる人の CLI で作る
  （決定。ネットワーク越しの口は作らない。e2e もこれを使う）。別案は、ループバックだけに出す管理者相当の grant
  （ADR-0017 の試運転の形）をテンプレートに入れる。プロキシの後ろではループバックの条件が守りにならない
  （ADR-0017 が既に注意している）ので、既定では入れない。
- **N4. ログイン必須なのに管理者のアカウントが 0 の DB**（アプリの操作では作れない。直接の編集だけ）: 起動時に
  明示のエラーで止める（決定）。黙ってログインなしへ戻すと、DB を書き換えられる人が認証を外せる形になる。
  復旧の口（CLI でアカウントを作る = N3 と同じもの）を Tauri の実行ファイルにも持たせるかは、C0 の ADR で詰める。
- **N5. 最後の管理者のガードを、ログインなしの間も掛ける**（決定。今のまま）。ロックダウンの判定との競合が無くなる。
  代わりに、ログインなしの間に作った最後の管理者は消せない（アカウントを 0 に戻せない）。
- **N6. 起動時の予約名の検査を、小さく残す**（決定）: 既存の `admin` を探す検査は要らないが、grant を後から足したときに
  固定 id と同名のアカウントが居る場合だけは、作成時の予約では防げない。1 文の検査で止め、改名の口は作らない
  （対処は、アカウントの作り直しか、grant の固定 id の変更）。別案は検査を置かず、同名を許す（監査で見分けにくい）。

レビューで置いた項目（番号は据え置き。9 以外は 2026-11-22 に推奨どおりで確定）:

1. **（決定 2・6）** 持ち主のキーは `acct:<accountId>`、`accountId` はアカウントの作成時の乱数
   `users.account_uid`。`instance.id` と `Identity.instanceId` は置かない。理由: DB の中の `instance.id` は
   バックアップの復元で採番と一緒に巻き戻り、復元後に作った別人が同じキーを得る（§4.2）。互換不要でも変わらない。
2. `ui_settings` の持ち主は文字列の列（`acct:<id>` / `grant:<kind>` / `local`）のまま、
   アカウントの行は `user_id` の**外部キー（`ON DELETE CASCADE`）で守る**（§4.4）。
3. **解決（互換不要）**: 旧い ui-settings の移し替えは無い。持ち主を決められない行の扱いも要らない。
   `local` を予約名に足すかは、足さない（新しい持ち主の表し方では衝突しない）。
4. `onLayoutCommit` の理由は `'user' | 'reset' | 'narrow-switch'`。保存値の復元（`restoreLayout`）では呼ばない（決定）。
   `DockHost` にも置く（理由は `'user' | 'reset'`）。ダッシュボードの保存の移行（K4）に要る（§4.6）。
5. **解決（互換不要。向きが逆になった）**: `REQUIRED_TABLES` に `ui_settings` を**足す**。旧版のバックアップを
   復元の予約で断るため（§4.1）。
6. #793 の停止時に待つ上限と、panic の応答の kind（S1 の ADR-0035 で提案）。上限を超えたら成功にしない。
   停止の合図の後の書き込みは 503。超えたときの再設定の扱いは 17（§4.5）。
7. §9.2 の各候補（PR ごとに諮る）。
8. #714: ファイルは列にせず既存の添付に揃える。新規は「作成の後にアップロード」で、サーバーの操作は足さない（決定）。
   欄の必須・件数は画面だけの制約で、**業務上の必須はサーバーで保証しない**と明記する。
   保証が要るアプリは別のサーバーの契約を自分で置く。`file` 型は 1 つのフォームに 1 欄まで（§4.12）。
9. #716: §4.13 の判断 1〜4（線引きは Issue の案、二重構造は案 C、既定の配置の配布は作らない、
   フィルタは期間の共有だけ）。**判断待ち（確定させない。§4.13 の判断 1〜4、W0）**。
10. **解決（互換不要）**: 「0014 はスキーマだけ、行の追加・移し替えは起動時の手順で」は要らない。データの移行は無く、
    組み込みの行は migration が入れる（§4.1。形は N2）。
11. **解決（互換不要）**: 組み込みの行の `password_hash` は NULL にする（基準を作り直すので `NOT NULL` を外せる。
    N2 で (i) を選ぶ場合だけ、資格情報ではない固定値に戻る）。verifier は `kind` で先に拒む（§4.3）。
12. `updateUiSetting` の `apply` は冪等であることを契約にし、サーバーに操作 ID は持たない（§4.4）。
13. **解決（互換不要）**: 予約名のアカウントを含むバックアップの事前検査は要らない。旧版のバックアップは
    必須の表の検査で断る（5）。
14. **解決（決定 16・17）**: 組み込みの行の名前は小文字の `admin`。既存の DB を止める・改名する口・内部名の案は要らない。
    `admin` を使う試験・fixture・demo の改名だけは残る（組み込みの行と当たる。C1）。
15. **解決（互換不要）**: 毎回の起動での `Admin` の検出は要らない。部分一意インデックスと、`kind` での判定、
    予約名の一覧を配線の層から渡す口は残す。起動時の検査は N6 の形に縮める。
16. **（決定 4・18）** `admin` に帰属させるセッションは、`GrantSpec` の明示の印で決める（id・name から推測しない）。
    印なしの grant（`public` など）は今のまま。Tauri のログインなし（`local`）は `admin` に帰属させる（決定 18 で確定。
    持ち主のキーは `local` のまま。§4.3）。
17. **（6 の形）** 停止が上限を超えたときの巻き戻しは、広げる・同等の変更だけにする。狭める変更
    （無効化・閲覧公開の停止）は listener を戻さず、新しい構成を保存し、残った仕事を監査に残す（決定。戻すと fail-open。§4.5）。
18. **（4 と決定 11）** `onLayoutCommit` は「確定点で `serialize()` が前回の通知から変わっていたら」呼ぶ。
    除外（復元・途中・拒否）だけを列挙し、`'user'` は API 経由の変更も含む。`'reset'` は reset を始めた口が `replaceLayout` に渡す（決定。§4.6）。
19. **（決定 9）** ui-settings の revision は数ではなく、書き込みごとの乱数の文字列（無い行は `"0"`）にする。
    復元と削除で revision が巻き戻り、古い `ifRevision` が偶然一致するのを防ぐ（決定）。別案は墓石（値 NULL で revision を進める。
    復元には効かない）。あわせて消す口（DELETE・provider の `remove`）を足し、C4 に admin-core のアダプタの最小の追従を含める（§4.4）。
20. **解決（互換不要）**: 旧い `ui.*` の行を全部消す手順は要らない（移し替えが無い）。旧版へ戻せないことは、
    「この版は旧版の DB を読めない」として §8 に書く。

## 11. 合図待ちの項目（#756）から v8 に取り込む項目（2026-11-22 確定）

**2026-11-22 オーナーが案どおりで確定**（v8 の範囲が広がる）。統合: #813・#815 → #811、#809 → #808。
確定した項目は §7 の表（C1・C1b・C2・C2b・T1・T1b・D1・D2）と §5 の依存関係に載せた。

| Issue | 何をするか | 入れる先 | 理由 |
| --- | --- | --- | --- |
| #814 | settings のキー名の整理 | 分けて入れる。C1 の前にキーと利用先を棚卸し（読み取りのみ）。C1 は今回追加する起動・seed 用のキー（`auth.disabled` 等）の名前だけ。既存の UI の論理キー（例 `dashboard.memo`）は変える必要があるものだけ C4/C5 で判断。既存の運用設定のキーは別件（v8 に入れない、#814 に残す） | C1〜C4 の間は旧 `settings.ui.*` を読み書きするので、C1 で UI キーを変えると間の値が見えなくなる。「所有者を `users.id` にする」と「呼び手のキー名を変える」は別 |
| #820 | `lib.rs` のテストを別ファイルに分ける | C1b（C2 の前の、機能変更なしの準備 PR） | C2・C2b が `apps/admin-template/src-tauri/src/lib.rs` の認証まわりを大きく触る。先に分けて衝突を減らす |
| #807 | auth フローの `AuditEntry` を `*_as` へ | C2 | C2 で監査の主体のスナップショットと `actor_kind` を入れる（#778・ADR-0034）。合図だった banto-industrial の追従は、v8 が破壊的で下流も作り直すので待つ理由が無い |
| #819 | ロール型の統一 | C2b（フロントの変更と一緒に） | 組み込み admin・`AuthDisabledRole`・`UserSummary.kind`（#778）を触るので、型を 1 つにするなら同時が安い |
| #808 | primary の文字を `--banto-primary-text` へ、`--banto-surface-muted` の定義 | ToastHost の色だけ T1（#794）、Dock/Grid の primary の文字と Tree の muted は別の小さな PR（T1b） | ToastHost は #794・#795 と同じ面。残りは分けると見た目の差分の原因を追いやすい。#809 を統合済み |
| #821 | `BantoTree` の不足（行末のアクション・ドロップの可否の口・外からの絞り込み） | D1（調査だけ。不足が確かめられたら別 Issue・別 PR） | temp-scada の回り道を見るときに、不足かどうかを確かめる |
| #811 | 日付・時刻の解析と形式の複製の解消（#813・#815 を統合） | D2 | 期間の強調表示（D13）の前提。3 パッケージの複製を解消する。D1 の所見の後に着手する（必ずやる） |
| #816 | ピッカーの `ownText`・`mirroredValue` の統合 | D2 | #811 と同じ日付入力まわり |
| #818 | テスト差し替え用の抽象の削除 | D2 | 対象は着手時に洗う |
| #822 | BantoGrid の編集の状態遷移の分離 | D2 | D1 の後に独立 PR で着手する（必ずやる）。#713 で入った既存の行選択・一括操作（#749・#752・#751・#753・#754）の挙動は維持 |
| #812 | 再マウントを避ける設計（portal 等） | 取り込まない | 関連 #782（影の木）・#791。合図は据え置き（実際に要る画面が出たとき） |
| #805 | 依存監査の除外を外す | 取り込まない | v8 と無関係。sqlx のリリース待ち |
| #806 | paraglide 3 の `outputStructure` の明示 | 取り込まない | v8 と無関係。出力の不具合待ち |
| #810 | メニューの e2e のハイドレーション待ち | 取り込まない | v8 と無関係。該当の e2e が落ちたとき |
| #817 | PowerShell 実行の共通化 | 取り込まない | v8 と無関係。その部分を触る Issue が立ったとき |
