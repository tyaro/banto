# 下流の要望（2026-11）をまとめて入れる計画書

作成日: 2026-11-22
状態: **計画**（オーナー決定済み、§2。実装は未着手。最初の PR は C0 の ADR）
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

範囲に入れないもの: #712、Hub の手動書き込みそのもの（banto-industrial 側）、
下流のリポジトリの変更（D1 は読むだけ。置き換えは下流の別セッション）。

## 2. 決定事項（2026-11-22 オーナー）

| # | 決めたこと | 関係 |
| --- | --- | --- |
| 1 | #790・#778・#786 のスキーマの変更を **1 回の migration 0014** に束ねる | §4.1〜4.3 |
| 2 | `Identity.id` は username のまま。**`accountId` を足す**。`sessionOwnerKey` は `acct:<instance.id>:<accountId>`、`accountId` が無ければ `null`（fail closed） | §4.2 |
| 3 | 既に `Admin`（大小無視）のアカウントがある DB は、**起動時に検出して明示のエラーで止める**（黙って改名しない）。`Admin` と grant の固定 id は大小無視で予約名にする | §4.3 |
| 4 | ログインなしのロールが viewer でも、監査の actor 名は `Admin`。組み込みの行のロールは表示だけ（判定に使わない） | §4.3 |
| 5 | grant セッションの ui-settings は、ユーザーの行を作らず **kind をキー**にする | §4.4 |
| 6 | `instance.id`（DB ごとの乱数）を持ち主のキーに入れる | §4.2 |
| 7 | #795 は**先頭 4 系列だけ**状態色との色差を保証する。調整は最小、並べ替えなし | §4.10 |
| 8 | #793 は**ログインを含む全書き込み**に既定で掛ける。除外の口は作らない | §4.5 |
| 9 | #786 は provider の `get` / `set` を **revision つきの形に置き換える**（足すのではない） | §4.4 |
| 10 | #796 の `replaceLayout` / `resetLayout` は、進行中の操作を**自動で取り消す** | §4.7 |
| 11 | #791 の `onLayoutCommit` に**確定の理由**を渡す。reset のとき消費側が保存を消せる | §4.6 |
| 12 | #791 後半（パッケージ化）では、持ち主の照合と `beforeBaseline` を**省略可能**にする（temp-scada は不要と表明） | §4.6 |
| 13 | リリースは §1 の方針どおり 1 回。#782・#780 と dock の Issue もその前提 | §6・§7 |
| 14 | #782 の本文の決定は覆さない。ただし互換のために残している形を壊して正しくできる所を、各 PR で検討する | §9.2 |
| 15 | #714 の 4（ファイル型）に着手する（保留を解く）。#716 も同じ版に入れる。#712 は入れない | §4.12・§4.13 |

（当初の「#793 だけ先に v7.12.0 で出す」案は、決定 13 で無効。）

## 3. いまあるもの（2026-11-22 の main で確認）

| 何 | どこ | 確かめた結果 |
| --- | --- | --- |
| ui-settings の保存先 | `crates/banto-admin-services/src/settings.rs:428`・`:445` | `settings` 表のキー `ui.{username}.{key}`（単純な連結）。revision なし |
| ユーザーの削除 | `crates/banto-admin-services/src/users.rs:1485` | `DELETE FROM users` だけ。ui-settings の行は残る |
| 最後の管理者のガード | 同 `users.rs:313`（`ensure_admin_removal_allowed`）、数えるのは `:1487-1489` 付近の `COUNT(*) ... role = 'admin'` | 組み込みの行を足すと、数え方を変える必要がある |
| username の検査 | 同 `users.rs:134`（`validate_username`） | trim・長さ・`.` の禁止だけ。予約名も大小無視の照合も無い |
| REST の `Identity` | `crates/banto-server/src/auth/session.rs:27`（`id`・`name`・`role`）、組み立ては `routes/audit.rs:117`（`id: user.username.clone()`）と `:42` | `account_id` は `SessionStamp`（`audit.rs:122`）にあり、画面へは出ていない |
| Tauri の `Identity` | `apps/admin-template/src-tauri/src/lib.rs:419`、ui-settings は `:3403`・`:3421` が `identity.username` を渡す | REST と同じ形 |
| REST の ui-settings | `crates/banto-server/src/routes/ui_settings.rs:31-56` | GET は `{value}`、PUT は無条件。持ち主は `identity.id`（= username） |
| 画面側の持ち主のキー | `packages/admin-core/src/sessionController.svelte.ts:207-217`（`sessionOwnerKey`）、型は `provider.ts:88` | `local` / grant の kind / `account:${id}` |
| ui-settings の provider | `packages/admin-core/src/providers/uiSettings.ts:46-51`（`get`・`set`）、直列化は `:89-140` 付近 | キーごとに直列化、置き換えられた `set` は成功として resolve（#707） |
| `createSavedSetting` | `packages/admin-core/src/savedSetting.svelte.ts` | 失敗は `error`・`dirty` に残るだけで再送しない |
| サーバーの起動 | `crates/banto-server/src/server.rs:162`（`BoundServer::serve`） | 層は `axum::Extension` の 2 つ。書き込みを切り離す層は無い |
| migration | `apps/admin-template/core/migrations-sqlite/`・`migrations-postgres/` | 最新は `0013_user_permissions.sql`。次は **0014** |
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
- **§11**: migration は 2 系統の連番を対称に。リリース済みは追記のみ。0014 はリリースまでは直せるが、
  C1 で全体を一度に入れて、後の PR で書き換えない。

## 4. Issue ごとの設計

### 4.1 共通: migration 0014 と持ち主の識別（#790・#778・#786）

**根本原因**: 持ち主を username で識別している所が 3 層にある（サーバーの `ui.{username}.{key}`、
wire の `Identity.id`、画面の `account:${id}`）。username は再利用できる。`users.id` は再利用されないが、
DB を作り直すと 1 から数え直す。

**設計**（migration 0014、SQLite・PostgreSQL の両方）:

- `users.kind`（`'account'` 既定 / `'builtin'`）。組み込みの `Admin` の行を 1 つ入れる（§4.3）。
- `audit_log.actor_id`（NULL 可）。`actor_username` のスナップショットは残す。
- 新しい表 `ui_settings`（持ち主・key・value・revision）。持ち主の表し方は §4.4。
- `instance.id`（DB ごとの乱数）を `settings` に置く。**推測**: SQL だけで乱数を作る手段が方言で違うので、
  migration ではなく起動時の「無ければ作る」に置くほうが単純（C1 で確かめる）。
- 既存の `ui.{username}.{key}` の行を `ui_settings` へ移し、`settings` から消す。
  - 持ち主を一意に決められない行（`a` と `a.b` が両方いるときの `ui.a.b.c`、`settings.rs:436-441` の
    doc にある既知のあいまいさ）と、対応する users の行が無い行は**移さずに捨てる**（この計画での判断。§10）。
  - 既に同名の作り直しで引き継がれてしまった行は見分けられない。そのまま移る（今見えているものが固定されるだけ）。

**破壊的変更と移行**: 派生アプリは migration 0014 の 2 ファイルを取り込む。`REQUIRED_TABLES` に
`ui_settings` を足すかは C1 で決める（古いバックアップのリストアを拒むことになるので、足さない案を推奨）。

**リスク**: migration の途中で止まる DB。0014 は 1 トランザクションで済む形にし、SQLite / PostgreSQL の
両方で「0013 までの DB に、あいまいな行・持ち主の居ない行を入れてから当てる」試験を書く。

### 4.2 #790 再利用されないアカウントの ID

**設計**:

- wire の `Identity` に `accountId` を足す（REST の `/api/auth/identity`・ログインの応答、Tauri のコマンド）。
  アカウントのセッションでは `users.id` の文字列。grant セッション・Tauri の認証なし（`local`）には載せない。
- `instance.id` も画面へ届ける。**この計画での判断**: `Identity` に `instanceId` として並べる
  （`sessionOwnerKey` が identity だけで決まる、今の形を保つ）。置き場は C0 の ADR で確定する。
- `sessionOwnerKey`（`sessionController.svelte.ts:207-217`）: `local` と grant の kind は今のまま。
  アカウントは `acct:<instanceId>:<accountId>`。どちらかが無ければ `null`（何とも一致しない）。
  接頭辞を `account:` から `acct:` に変えるので、古いキーで保存された記憶は読まれない。
- `Identity.id` は username のまま（監査の主体・画面の表示・`acting_username` の呼び手を変えない）。
  ただしサーバーの中で「持ち主」に username を使っている所（ui-settings）は `users.id` に替える（§4.4）。
- 監査に `actor_id` を書く（REST・Tauri の両方。§1）。

**破壊的変更と移行**: `Identity` を自分で組み立てている派生アプリ（Tauri の `lib.rs`、REST の
credential verifier）は `accountId`・`instanceId` を載せる。載せないと持ち主のキーが `null` になり、
持ち主つきの記憶（一覧の記憶・最近のコマンド・ドックの配置）が保存も復元もされない（fail closed。
黙って他人に渡すよりよい）。古い `account:` のキーの localStorage は残骸になる（掃除の口は D2 で検討）。

**リスク**: `accountId` を載せ忘れた派生アプリが「記憶されない」とだけ見える。dev ビルドで
`sessionOwnerKey` が account の kind で `null` を返したら 1 回だけ警告する。

**試験**: 同名で作り直したアカウントのキーが違うこと、`instance.id` が違う DB で同じ `users.id` の
キーが違うこと、`accountId` なしで `null`（単体）。REST と Tauri の identity の形の一致（既存の対称の試験に足す）。

### 4.3 #778 組み込みのユーザー `Admin`

Issue の「決めること」への答え:

1. **ロックダウン後**: `Admin` はログインできない行のまま。パスワードは持たせない。
2. **改名・無効化・降格・パスワードの設定・削除**をすべて禁じる（サービス層で。§2）。
3. **最後の管理者のガード**: 組み込みの行は数えない（`role = 'admin' AND kind = 'account'`）。
   数えると、人のアカウントを全部消せてしまう。
4. **ADR-0017 の改訂**: 行にするのは `Admin` だけ。`public` などほかの grant の固定 identity は行を作らず、
   固定 id を予約名にする。
5. **既存の DB**: 決定 3（起動時に検出して止める）。

**設計**:

- 組み込みの行: `username = 'Admin'`、`kind = 'builtin'`、パスワードのハッシュなし。credential verifier は
  `kind = 'builtin'` を、ハッシュの有無に関係なく拒む（ハッシュを後から入れられても通らない、二重の守り）。
- ログインなしの操作（管理者相当の grant セッション）の監査は `actor_username = 'Admin'`・
  `actor_id = 組み込みの行の id`。`actor_role` はそのセッションの実際のロール（viewer なら viewer）を書く。
  行の `role` は一覧の表示だけで、認可の判定には使わない（決定 4。ADR に明記）。
- 予約名: `Admin` と grant の固定 id を、大小無視で作成・初期設定・改名から拒む。
  conventions §10 の「id・name から合成セッションを推測しない」は変えない（予約は見分けやすさのためで、
  判定の根拠にしない）。
- **初期設定の判定**（「users が空なら最初の管理者を作れる」）は `kind = 'account'` の行だけを数える。
  ここを直し忘れると、新しい DB で初期設定ができなくなる。ユーザー一覧・件数・CSV・バックアップの
  検証など、`users` を数える所を C2 で洗う。
- 起動時の検出: migration 0014 を当てる**前**に、`Admin`（大小無視）や予約名と同じ username の
  アカウントを探し、あれば migration を当てずに明示のエラーで止める。エラーには対処（前の版で
  その利用者を作り直す、など）を書く。

**破壊的変更と移行**: ユーザー一覧に `Admin` が 1 行増える。`Admin`・`public` など予約名のアカウントは
作れない。既にある DB は起動しない（上のエラー）。ADR-0017 §3（自己削除のガード）・監査の項を改訂する。

**リスク（認証）**: 組み込みの行が「ログインできる管理者」になる経路を作らないこと。パスワードの
リセット・CSV の取り込み・リストア・権限の個別付与（0013）の各経路を C2 で 1 つずつ確かめ、試験に入れる。

**試験**: 禁止の操作が REST・Tauri の両方で拒まれ、denied の監査も対称（§1）。組み込みの行ではログイン
できない。最後の管理者のガードが人のアカウントだけを数える。新しい DB で初期設定ができる。予約名の大小無視。

### 4.4 #786 ui-settings の条件付きの書き込みと再送

**設計（サーバー）**:

- `ui_settings` の持ち主は文字列 1 列にする（**この計画での判断**。§10）: アカウントは `acct:<users.id>`、
  grant は `grant:<kind>`（決定 5）、Tauri の認証なしは `local`。主キーは（持ち主, key）。
  ユーザーの行への外部キーは張れないので、**ユーザーの削除と同じトランザクションで明示的に消す**
  （`users.rs:1485` の所。SQLite の外部キーは有効だが、それに頼らない）。
- GET は `{ value, revision }`（行が無ければ `value: null`・`revision: 0`）。
- PUT は `{ value, ifRevision? }`。`ifRevision` があり、今の revision と違えば `conflict`（REST は 409）と
  現在の `{ value, revision }` を返す。`ifRevision: 0` は「まだ無いこと」。成功すれば新しい revision を返す。
  判定と書き込みは 1 文（または 1 トランザクション）で行う。
- `ifRevision` を省いた PUT は無条件（設定の画面のように、最後の値が勝ってよい使い方のため）。
- Tauri のコマンドも同じ引数・同じ応答にする（§1）。

**設計（画面）**:

- `UiSettingsProvider` を置き換える（決定 9）: `get(key)` は `{ value, revision }`、
  `set(key, value, { ifRevision? })` は `{ revision }` を返す。
- 直列化（#707）との関係: 条件付きの `set` は、後の `set` に**置き換えさせない**（順に送る）。
  置き換えられて送られなかった無条件の `set` は、今は成功として resolve する。revision つきの応答では
  「送っていない」を成功の revision と見分けられる形にする（例 `{ revision: null, superseded: true }`。
  形は C5 で確定）。条件付きの書き込みが「通った」と誤認されないことを試験にする。
- `updateUiSetting(provider, key, apply)`: 読む → 当てる → 条件付きで書く → `conflict` なら返ってきた
  現在の値に当て直す（回数に上限）。industrial の回り道の置き換え先。
- `createSavedSetting`: 再送は一時的な失敗だけ（間隔を延ばす、上限つき、セッションが替われば止める）。
  `conflict` は `merge(server, current)` があれば呼び、無ければ再送しない。`onSettled` で rune の外へ結果を渡す。
  「一時的」の判定に使える kind がいまの `ERROR_KINDS`（`providers/http.ts:42-51`）には無い
  （`storage`・`other` だけ）。通信の失敗をどう見分けるかは C6 で確かめる（§9.1）。

**破壊的変更と移行**: `UiSettingsProvider` を実装・利用している派生アプリは全部直す（`get` の戻り値が
文字列でなくなる）。`createLocalUiSettings` など同梱の実装も同じ形にする。REST の応答の形が変わる。

**リスク**: 条件付きの書き込みの判定に穴があると、別のタブの変更を黙って上書きする。SQLite /
PostgreSQL の両方で、2 つの書き込みを同じ revision から競わせる試験を書く。

### 4.5 #793 書き込みを接続の切断から切り離す

**根本原因**: hyper 1.x は応答待ちの間に相手の FIN を読むと service の future を捨てる。`.await` を
またぐ副作用（確定 → セッションの失効 → 監査）が途中で止まる。

**設計**:

- `BoundServer::serve`（`server.rs:162`）で、router 全体に手書きの層を 1 つ掛ける（§3）。
  POST・PUT・PATCH・DELETE は `next.run(req)` を `tokio::spawn` し、その終わりを待って応答する。
  接続が切れて待つ側が捨てられても、spawn した側は最後まで走る。GET・HEAD・SSE は今のまま。
- 派生アプリは `serve` を通るだけで全書き込みに掛かる。ログインも含める。除外の口は作らない（決定 8）。
- 停止: 切り離した仕事を数え、graceful shutdown のあと上限つきで待つ（上限と、超えたときのログは ADR で）。
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
停止時に走っている書き込みを待つこと。

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
  - `'reset'` のとき、消費側は「既定を保存する」か「保存を消す」かを選べる（temp-scada は消す）。
- `DockHost` だけを使う画面（ダッシュボード）向けに同じ口を `DockHost` にも置くかは K3 で決める
  （`ThreePaneDock` が先。置くなら同じ理由の名前にそろえる）。
- テンプレートの `/tree/workspace-dock` の自動保存を、この口に載せ替える。

**後半（K4、#786・#790 の後）**:

- `dockLayoutStore` を `@banto/dock-svelte` に移す。`UiSettingsProvider` は構造的な型
  （`get` / `set` の形だけ）で受け、admin-core を import しない（§4・§5）。
- 持ち主の照合（`scope`・`isCurrent`）と `beforeBaseline` は**省略可能**（決定 12）。省くと
  「キー 1 つ、持ち主なし」で動く（temp-scada の `createLocalUiSettings`）。
- 保存は `onLayoutCommit` から受ける（`serialize()` を `$effect` で読む形をやめる）。`'reset'` で
  「保存を消す」を選べるオプションを持つ。500ms のまとめ書き・unmount の flush・セッションの世代は今のまま移す。
- 別のタブとの競合は、#786 の条件付きの書き込みを使うかを K4 で決める（配置は最後の操作が勝ってよい、
  が今の前提。推奨は無条件のまま）。
- テンプレートの `lib/banto/dockLayoutStore.svelte.ts` は消し、scaffold の `removeDock` も直す
  （**scaffold の 4 プリセットの dry-run が要る**）。

**破壊的変更と移行**: 前半は足すだけ。後半はテンプレートのファイルが消える（写して持つ派生アプリは
パッケージの口へ載せ替える）。

**試験**: 広い → 狭い → 広いの各瞬間の `layoutSnapshot()` が確定後の値だけであること（フォーカスが
枠の中にある場合を含む）。`onLayoutCommit` が理由ごとに 1 回で、途中・拒否では呼ばれないこと。

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
- 見える木（`layout.docked`）だけから計算する。#782 の後も `layout.docked` は影の木の射影として
  残るので、口の意味は変わらない。

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
  `visibleWhen` で隠れたら保留は送らない。`required`・件数・サイズ・`accept` は画面での手がかりだけで、
  判定はサーバー（MIME はマジックバイト、§6。クライアントの申告を使わない）。
- 3-way（§10）: demo は添付を拒むので、フィールドは注入された口の拒否をそのまま表示する。

**破壊的変更と移行**: 公開の union `FieldType` に種類が増える（網羅 switch をしている利用側が型エラー）。

**リスク**: 新規のときの「レコードはできたが添付が無い」中間の状態。作成の確認の文言と再試行で受ける。
添付はオプション（template-scope §3）なので、添付を外した scaffold でもフォームが組めること。

**試験**: 単体（保留・`visibleWhen`・検証・失敗の表示）、e2e（ui-demo の見本、items の新規と編集）、
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

- C0（ADR の承認）→ C1（migration 0014）→ C2（#778）・C3（#790）→ C4（#786 サーバー）→ C5（provider）→
  C6（`createSavedSetting`）。C2 と C3 は同じファイル（`users.rs`・`audit.rs`・Tauri の `lib.rs`）に触れるので直列。
- S1（#793 の層）は C1 と並べられる（`server.rs` と新しいファイルだけ）。S2（handler の点検）は
  `routes/users.rs`・`ui_settings.rs` を読んで直すので、**C2 の前に済ませる**（C2〜C4 と同じファイル）。
- K4（#791 後半）は C3（持ち主のキー）と C5（provider の形）の後。dock の中では PR7 の後（§6）。
- T1（#794）・T2（#795）は誰とも重ならない。どちらも基準画像を変えるので、再生成は 1 回にまとめる。
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

| PR | 範囲 | パッケージ・場所 | 破壊的 | モデル | 完了条件 |
| --- | --- | --- | --- | --- | --- |
| **C0** | ADR: 持ち主の識別と組み込み `Admin`（新規 ADR-0034、ADR-0017 の改訂）。`.en.md` も | `docs/adr` | — | fable | **オーナーの承認**。§10 の判断を含めて確定 |
| S1 | #793 の層・停止・panic・切断の試験・ADR-0035 | `banto-server` | 挙動 | fable | 切断しても作成と監査が残る試験が通る |
| S2 | #793 handler の順序の点検と直し | `banto-server/routes`・テンプレートの `rest`・`src-tauri` | 挙動 | fable | 点検の表を PR に載せ、直した所に試験 |
| C1 | migration 0014（2 方言）・`instance.id`・既存の行の移し替え・起動時の検出 | テンプレートの `core`・`banto-admin-services` | **破壊的** | fable | 0013 までの DB からの移行の試験（両方言）。`pnpm verify:architecture` rule 11 |
| C2 | #778 組み込みの行・禁止・予約名・数え方・監査の actor | `banto-admin-services`・`banto-server`・`src-tauri` | **破壊的** | fable | §4.3 の試験。両経路の対称 |
| C3 | #790 `accountId`・`instanceId`・`sessionOwnerKey`・`actor_id` | `banto-server`・`src-tauri`・`admin-core`・テンプレート | **破壊的** | fable | §4.2 の試験。持ち主つきの記憶の利用箇所を全部確認 |
| C4 | #786 サーバー（表・条件付きの PUT・削除と同じトランザクション・Tauri） | `banto-admin-services`・`banto-server`・`src-tauri` | **破壊的** | fable | 競合の試験（両方言）。ユーザーの削除で行が消える |
| C5 | #786 provider の置き換え・`updateUiSetting`・同梱の実装・呼び手の追従 | `admin-core`・テンプレート | **破壊的** | fable | #707 の直列化の試験が新しい形で通る |
| C6 | `createSavedSetting` の再送・`merge`・`onSettled`・README | `admin-core` | 足すだけ | sonnet | 再送・停止・競合の単体テスト |
| T1 | #794 Toast と浮かぶ面の tint | `ui`・`grid-svelte` | 見た目 | sonnet | ダークで透けない。基準画像の再生成 |
| T2 | #795 色差の試験と最小の調整 | `theme` | 見た目 | fable | 試験が両テーマで通る。CVD の検査 |
| K1 | #792 `isOnScreen` | `dock-svelte` | 足すだけ | sonnet | 5 つの場合の単体テスト。README |
| K2 | #796 `cancelGesture` と自動の取り消し | `dock-svelte` | 挙動 | sonnet | 操作中の `replaceLayout` の単体テスト |
| K3 | #791 前半 | `dock-svelte`・テンプレート | 足すだけ | fable | §4.6 の試験。e2e（workspace-dock の保存） |
| #782 PR2〜PR8 | Issue の本文どおり | `dock-svelte` | PR ごとに判定（§9.2） | fable | 本文の各 PR の条件。PR6 で #780 を閉じる |
| K4 | #791 後半 | `dock-svelte`・テンプレート・scaffold | **破壊的** | fable | ダッシュボード・workspace-dock の保存が今と同じ。scaffold の dry-run |
| F1 | #714 `file` 型（保留の持ち方・検証・ui-demo の見本） | `forms`・ui-demo | union に追加 | fable | §4.12 の単体テスト。forms がほかのパッケージを import しない |
| F2 | #714 テンプレートの配線（items の新規・編集、作成後のアップロード、失敗の再試行）・README・片付け | テンプレート・scaffold | 足すだけ | sonnet | e2e。添付を外すプリセットの dry-run。#714 を閉じる |
| W0 | #716 の判断（§4.13 の 1〜4）と template-scope §4.2 の 1 文 | `docs` | — | fable | **オーナーの判断** |
| W1〜W3 | #716（判断の後に §4.13 を設計へ書き直してから。W2 は K4・C5 の後） | テンプレート（＋判断による） | 見た目・保存 | fable | 判断の後に決める。基準画像の再生成、scaffold の dry-run |
| D1 | 下流の使い勝手の精査（回り道・写し・自前の包みを読み、置き換えられるか・足りない口を洗う） | 読み取りのみ | — | fable | 所見の一覧（Issue か文書） |
| D2 | D1 の結果のリファクタ（PR に分ける） | D1 による | D1 による | D1 による | D1 の所見が閉じる |
| D3 | upgrading・CHANGELOG の「消費側への注意」・実機確認（#757 に #793 の切断と #794 のダークを足す）・版の判定 | `docs` | — | sonnet | リリースの準備の PR |

並べ方: C0 の承認が最初。その後は 4 本の列を並べる — サーバー（S1 → S2 → C1 → C2 → C3 → C4）、
画面（C5 → C6、C4 の後）、theme（T1・T2）、dock（§6）。S1 と C1 は並行できる。
F1・F2 はいつでも。W0 は C0 と一緒に諮り、W1〜W3 は dock の列の後ろ（K4 の後）に付ける。

## 8. CHANGELOG「消費側への注意」の要点

D3 でまとめる。各 PR は自分の分を `[Unreleased]` に書いておく。

- **DB**: migration 0014 を取り込む。`Admin`（大小無視）や予約名のアカウントがある DB は起動しない
  （対処の手順）。持ち主を決められない ui-settings は移らない。
- **Identity**: `accountId`・`instanceId` を載せる（Tauri の組み立て、REST の verifier）。載せないと
  持ち主つきの記憶が働かない。古い `account:` のキーの記憶は読まれない（一覧の記憶・最近のコマンド・
  ドックの配置は 1 回だけ既定に戻る）。
- **ユーザー一覧**: 組み込みの `Admin` が居る。消せない・変えられない。監査の actor に `actor_id`。
- **ui-settings**: `UiSettingsProvider` の `get` / `set` の形、REST・Tauri の応答の形が変わる。
  条件付きの書き込みと `updateUiSetting`。`createSavedSetting` の再送は opt-in。
- **サーバー**: 書き込みは接続が切れても最後まで走る。冪等ではない。自前の `run_detached` は外せる。
- **dock**: `onLayoutCommit`（理由つき）で保存する。`dockLayoutStore` はパッケージの口へ。`isOnScreen`。
  `cancelGesture`、`replaceLayout` / `resetLayout` は進行中の操作を取り消す。影の木で戻る場所が変わる例
  （#780 と既知の失敗 1〜3・6・7）。保存形式を変えた場合は、古い保存を読めないとき既定へ戻ること。
- **forms**: `FieldType` に `'file'`（網羅 switch の型エラー）。新規では作成の後にアップロードする。
- **ダッシュボード**（#716 の判断による）: 配置の保存が既定へ戻る、ウィジェットの登録の口。
- **theme**: ダークの Toast の背景、`--banto-chart-2`（ほか先頭 4 系列）の色。

## 9. 未確認・各 PR で検討

### 9.1 未確認（実装の PR で確かめる）

- #793: 失効と監査の順、ロックダウンの再検証（S2）。Tauri のコマンドが途中で捨てられない前提（S1）。
  `axum::middleware::from_fn` の `Next` を spawn へ渡せるか（`Send + 'static`）、二重に包んだときの挙動（S1）。
- #793: Issue が挙げる industrial の `local_grant.rs:678` は別リポジトリで、ここでは開いていない。
- #778: 前の版で username を変えられるか（起動時のエラーに書く対処が変わる）。`users` を数える所の全部（C2）。
- #790: TS の `Identity` を自分で組み立てている所、`identity.id` を持ち主として使っている所の残り（C3）。
- #786: 「一時的な失敗」を見分ける kind（C6）。`settings` 表のバックアップ・リストアが `ui_settings` を含むか（C4）。
- #791: テンプレートの `/tree/workspace-dock` で実際に確定前の保存が起きるか（K3 で再現の試験を先に書く）。
  `DockHost` にも `onLayoutCommit` を置くか（K3）。
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

## 10. この計画で新しく置いた判断（オーナーに確認する）

C0 の ADR で確定する。推奨を書く。

1. `instance.id` を画面へ届ける置き場: `Identity.instanceId`（推奨）か、別の応答か。
2. `ui_settings` の持ち主を文字列 1 列（`acct:<id>` / `grant:<kind>` / `local`）にし、外部キーを張らずに
   削除と同じトランザクションで消す（推奨）。別案は `user_id` の外部キー + grant 用の別の列。
3. 移行で、持ち主を一意に決められない ui-settings の行は捨てる（推奨）。
4. `onLayoutCommit` の理由は `'user' | 'reset' | 'narrow-switch'`。保存値の復元（`restoreLayout`）では呼ばない（推奨）。
5. `REQUIRED_TABLES` に `ui_settings` を足さない（推奨。古いバックアップを拒まない）。
6. #793 の停止時に待つ上限と、panic の応答の kind（S1 の ADR-0035 で提案）。
7. §9.2 の各候補（PR ごとに諮る）。
8. #714: ファイルは列にせず既存の添付に揃える。新規は「作成の後にアップロード」で、サーバーの操作は足さない（推奨）。
9. #716: §4.13 の判断 1〜4（線引きは Issue の案、二重構造は案 C、既定の配置の配布は作らない、
   フィルタは期間の共有だけ）。**判断待ち**。
