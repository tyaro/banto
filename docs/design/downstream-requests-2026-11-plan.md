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
| 1 | #790・#778・#786 のスキーマの変更を **1 回の migration 0014** に束ねる。**レビューで変更**: 0014 はスキーマの追加だけ。行の追加・移し替えは、呼び出し側の切り替えと同じ PR に置く（§10 の 10） | §4.1〜4.3 |
| 2 | `Identity.id` は username のまま。**`accountId` を足す**。`accountId` が無ければ `sessionOwnerKey` は `null`（fail closed）。**レビューで変更**: `accountId` は `users.id` ではなく作成時の乱数 `users.account_uid`、キーは `acct:<accountId>`（§10 の 1） | §4.2 |
| 3 | 既に `Admin`（大小無視）のアカウントがある DB は、**起動時に検出して明示のエラーで止める**（黙って改名しない）。`Admin` と grant の固定 id は大小無視で予約名にする。**独立レビューで変更**: 止める形は保ち、新しい版の側に改名の口を足す。検出は毎回の起動（§10 の 14・15） | §4.3 |
| 4 | ログインなしのロールが viewer でも、監査の actor 名は `Admin`。組み込みの行のロールは表示だけ（判定に使わない）。**独立レビューで追加**: どのセッションを `Admin` に帰属させるかは、配線の層の明示の印で決める（§10 の 16） | §4.3 |
| 5 | grant セッションの ui-settings は、ユーザーの行を作らず **kind をキー**にする | §4.4 |
| 6 | ~~`instance.id`（DB ごとの乱数）を持ち主のキーに入れる~~ **レビューで変更**: `instance.id` は置かない。DB の中の値はバックアップの復元で採番と一緒に巻き戻るので、アカウントごとの乱数 `account_uid` に替える（§10 の 1） | §4.2 |
| 7 | #795 は**先頭 4 系列だけ**状態色との色差を保証する。調整は最小、並べ替えなし | §4.10 |
| 8 | #793 は**ログインを含む全書き込み**に既定で掛ける。除外の口は作らない | §4.5 |
| 9 | #786 は provider の `get` / `set` を **revision つきの形に置き換える**（足すのではない）。**独立レビューで変更**: revision は数ではなく書き込みごとの乱数、消す口も足す（§10 の 19） | §4.4 |
| 10 | #796 の `replaceLayout` / `resetLayout` は、進行中の操作を**自動で取り消す** | §4.7 |
| 11 | #791 の `onLayoutCommit` に**確定の理由**を渡す。reset のとき消費側が保存を消せる。**独立レビューで変更**: 発火は「確定点で `serialize()` が変わっていたら」と定義する（§10 の 18） | §4.6 |
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
DB を作り直すと 1 から数え直す。**バックアップの復元でも巻き戻る**（採番の履歴も DB の中にある。
クロスレビューが `VACUUM INTO` で再現）。DB の中に置く `instance.id` も一緒に巻き戻るので、守りにならない。

**設計**（migration 0014、SQLite・PostgreSQL の両方。**スキーマの追加だけ**。レビューで変更）:

- `users.kind`（`'account'` 既定 / `'builtin'`）。列だけ足す。組み込みの行は 0014 では入れない（下の「段階」）。
  組み込みの行は 1 つだけ、を**部分一意インデックス**（`WHERE kind = 'builtin'`）で守る（独立レビューで追加。§4.3）。
- `users.account_uid`（NULL 可・一意）。アカウントごとの再利用されない識別子（§4.2）。
- `audit_log.actor_id`（NULL 可）。`actor_username` のスナップショットは残す。
- 新しい表 `ui_settings`（持ち主・key・value・revision）。持ち主の表し方と、revision が乱数の文字列であることは §4.4。
- `instance.id` は**置かない**（レビューで変更。決定 6）。
- `users.password_hash` は両方言で `NOT NULL`（`0003_users.sql`）のまま変えない。組み込みの行には
  **資格情報ではない固定値**（PHC 文字列として解釈できない 1 文字。例 `!`）を置く（§4.3）。NULL を許す形は、
  SQLite で表の作り直しが要るので採らない。

**段階**（レビューで変更。どの PR の後でも main が動くこと）:

- **C1 はスキーマだけ**。行を足さず、旧い `ui.{username}.{key}` も消さない。0014 を当てた直後も、
  `is_initialized()`（`users.rs:706`、全行を数える）、初回の管理者の INSERT（`users.rs:776`、
  `NOT EXISTS (SELECT 1 FROM users)`）、ui-settings の読み書きは今のまま動く。
- **組み込みの行を入れるのは C2**。数え方（上の 2 か所ほか）を `kind = 'account'` に直すのと同じ PR で、
  起動時の冪等な手順（無ければ入れる）として置く。migration に入れないので、古いバックアップを
  復元した DB にも同じ手順が効く。派生アプリが呼び忘れない置き場は C2 で決める。
  「無ければ」は `kind = 'builtin'` の行で見て（username では見ない）、条件付きの 1 文
  （`INSERT ... WHERE NOT EXISTS`。部分一意インデックスに当たった場合は成功として扱う）にする。
- **`account_uid` の埋め込みは C3**。既存の行は起動時に 1 トランザクションで埋め（行ごとの
  `UPDATE ... WHERE id = ? AND account_uid IS NULL`。先に埋まった値を上書きしない）、新しい行は作成時に
  サービス層で作る（SQL だけで乱数を作る手段が方言で違うため）。埋まるまでは `accountId` を載せない（fail closed）。
- **旧い `ui.*` の移し替えと削除は C4**。REST・Tauri の参照先を `ui_settings` へ替えるのと同じ PR で、
  起動時の冪等な手順として 1 トランザクションで行う（`ui.` で始まる行は、移した・捨てたを問わず
  **全部** `settings` から消す。下の「移し替えの規則」）。
- **同時の起動**（独立レビューで追加）: PostgreSQL では複数のインスタンスが同じ DB で同時に起動しうる。
  上の 3 つの手順は、条件付きの文（`WHERE account_uid IS NULL`・`WHERE NOT EXISTS`）にするか、
  トランザクションの先頭で advisory lock（`pg_advisory_xact_lock`）を取る。C4 の移し替えは読んでから書くので
  lock を取る。SQLite は書き込みが 1 つなので、書き込みのトランザクションとして始めれば足りる。
  サービス層を通らない INSERT（試験・seed・派生アプリの直接の SQL）の行は `account_uid` が NULL のまま残るので、
  ログイン時に同じ条件付きの文で遅れて埋めるかを C3 で検討する（埋めなければ、その行は次の起動まで fail closed）。

**移し替えの規則**（C4）: 持ち主の候補は、users の行**と合成セッションの名前**（Tauri の認証なしの `local`、
grant の固定 id）。現行は認証なしも `ui.local.*` に保存し（`lib.rs:1511`・`3394`）、`local` という通常の
アカウントも作れる（`validate_username`、`users.rs:134` に予約が無い）ので、名前だけでは区別できない。

- 候補が 1 つだけ: アカウントなら `acct:<users.id>`、合成セッションなら `local` / `grant:<kind>` へ移す
  （`local` のアカウントが居ない DB の端末共通の値は、消さずに `local` へ残る）。
- 候補が 2 つ以上（`a` と `a.b` が両方いるときの `ui.a.b.c`、`settings.rs:436-441` の既知のあいまいさ。
  **合成セッションの名前と同名のアカウントが居る場合**も同じ）と、候補が無い行は、**どちらにも渡さずに捨てる**
  （§10 の 3）。端末共通の値を個人に渡さない、個人の値を端末共通にしない、の両方を守る。
- 既に同名の作り直しで引き継がれてしまった行は見分けられない。そのまま移る（今見えているものが固定されるだけ）。
- **`ui.` で始まる行は、同じトランザクションで全部消す**（独立レビューで変更。当初は「移した行だけ」。§10 の 20）。
  残すと、起動のたびに走る手順が後から拾う。(A) 退役した bob の `ui.bob.*`（削除は users の行だけを消す、
  `users.rs:1484-1486`）が、後で別人の bob を作った次の起動でその人へ移る。(B) `local` と同名のアカウントが居て
  あいまいで残した `ui.local.*` が、そのアカウントを消した後の起動で端末共通へ移る。
  `ui.` 接頭辞の全体設定は無い（`desktop.vibrancy` は別の接頭辞、`lib.rs:3428`）。以後も `ui.` を全体設定の
  キーに使わないことを `settings.rs` に書く。
- 判定は 1 回きりになるので、派生アプリは **C4 を取り込む時点で**「grant の固定 id → kind」の対応を渡しておく
  （口は §4.3 の予約名の一覧と同じ。渡し忘れた grant の値は候補なしで捨てられ、やり直せない。§8）。

**破壊的変更と移行**: 派生アプリは migration 0014 の 2 ファイルを取り込む。`REQUIRED_TABLES` に
`ui_settings` を足すかは C1 で決める（古いバックアップのリストアを拒むことになるので、足さない案を推奨）。

**リスク**: migration の途中で止まる DB。0014 は 1 トランザクションで済む形にし、起動時の手順も
それぞれ 1 トランザクション・冪等にする（途中で落ちても、次の起動でやり直せる）。

**試験**（両方言）: 0014 だけを当てた新しい DB で初期設定ができ、既存の DB で保存済みの ui-settings が読める（C1）。
移し替えは「0013 までの DB に、あいまいな行・持ち主の居ない行・`ui.local.*` を入れてから当てる」で、
`local` のアカウントが居ない／居るの 2 通りと grant の固定 id を確かめる（C4）。2 回走らせても同じ結果。
手順の後に `ui.` で始まる行が 1 つも残らないこと。**捨てた後に同名のアカウントを作って再起動しても渡らない**こと
（上の A・B の両方）。PostgreSQL では、2 つの接続から同時に走らせても行が重複・欠落しないこと（C2〜C4 の各手順）。

### 4.2 #790 再利用されないアカウントの ID

**設計**:

- **再利用されない識別子**（レビューで変更）: `users.account_uid`。アカウントの作成時にサービス層で作る
  128 bit の乱数（OS の乱数源、文字列）。一意制約。改名・ロールの変更では変えない。秘密ではない（認証にも認可にも
  使わない。記憶を仕切る名前）。組み込みの行には持たせない。
  - 復元に強い理由: 取得後に作った A の値は、復元した DB には無い。復元後に作る B は新しい乱数を引くので、
    `users.id` が A と同じ 2 でも一致しない。取得の時点で居たアカウントは同じ値に戻る（同じ人なので正しい）。
  - DB を作り直した場合・別の DB の同じ `users.id` も一致しない。`instance.id` が担うはずだった役は、これで足りる。
  - 0014 より前のバックアップを復元すると、起動時の埋め込みで新しい値になる（記憶が 1 回既定へ戻る。安全な側）。
- wire の `Identity` に `accountId` を足す（REST の `/api/auth/identity`・ログインの応答、Tauri のコマンド）。
  アカウントのセッションでは `account_uid`。grant セッション・Tauri の認証なし（`local`）には載せない。
  `instanceId` は足さない。
- `sessionOwnerKey`（`sessionController.svelte.ts:207-217`）: `local` と grant の kind は今のまま。
  アカウントは `acct:<accountId>`。無ければ `null`（何とも一致しない）。
  接頭辞を `account:` から `acct:` に変えるので、古いキーで保存された記憶は読まれない。
- `Identity.id` は username のまま（監査の主体・画面の表示・`acting_username` の呼び手を変えない）。
  ただしサーバーの中で「持ち主」に username を使っている所（ui-settings）は `users.id` に替える（§4.4）。
  サーバーの中の `users.id`（`ui_settings`・`actor_id`）は同じ DB の行どうしで、復元しても一緒に戻るので食い違わない。
  画面の側（ブラウザーの保存）は DB と一緒に戻らないので、`account_uid` を使う。
- 監査に `actor_id` を書く（REST・Tauri の両方。§1）。

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

### 4.3 #778 組み込みのユーザー `Admin`

Issue の「決めること」への答え:

1. **ロックダウン後**: `Admin` はログインできない行のまま。パスワードは持たせない。
2. **改名・無効化・降格・パスワードの設定・削除**をすべて禁じる（サービス層で。§2）。
3. **最後の管理者のガード**: 組み込みの行は数えない（`role = 'admin' AND kind = 'account'`）。
   数えると、人のアカウントを全部消せてしまう。
4. **ADR-0017 の改訂**: 行にするのは `Admin` だけ。`public` などほかの grant の固定 identity は行を作らず、
   固定 id を予約名にする。
5. **既存の DB**: 決定 3（起動時に検出して止める）。止めたうえで、新しい版の側に改名の口を置く
   （独立レビューで変更。下の「移行の口」）。

**設計**:

- 組み込みの行: `username = 'Admin'`、`kind = 'builtin'`。`password_hash` は `NOT NULL` なので、資格情報ではない
  固定値を置く（§4.1）。credential verifier は `kind = 'builtin'` を、ハッシュを見る**前に**拒む
  （ハッシュを後から入れられても通らない、二重の守り）。固定値がハッシュの検証で「不一致」になり、
  エラーや panic にならないことも C2 の試験に入れる。
  - 独立レビューで追加: `kind` で拒むときも、ユーザーが居ないときと同じ**ダミーのハッシュ検証は回す**
    （現行 `users.rs:895-898`。応答の時間で組み込みの行を見分けさせない）。
  - `change_password`（SELECT は `users.rs:922`、UPDATE は `:965`）と `reset_password`（UPDATE は `:1399`）の文に
    `kind = 'account'` を入れる。サービス層の検査を抜けても、組み込みの行にハッシュが入らない。
- ログインなしの操作（管理者相当の grant セッション）の監査は `actor_username = 'Admin'`・
  `actor_id = 組み込みの行の id`。`actor_role` はそのセッションの実際のロール（viewer なら viewer）を書く。
  行の `role` は一覧の表示だけで、認可の判定には使わない（決定 4。ADR に明記）。
- **どのセッションが `Admin` の操作か**（独立レビューで追加。§10 の 16）: id・name からは推測しない
  （conventions §10）。配線の層が付ける**明示の印**で決める。`GrantSpec` に「組み込みの actor に帰属する」フラグ
  （既定は off。名前は C0 の ADR で確定）を足し、発行したセッションの `SessionStamp` に写す。監査を書く所は印だけを見る。
  - 印つきの grant セッション: `actor_username = 'Admin'`・`actor_id = 組み込みの行の id`。
  - 印なしの grant セッション（閲覧公開の `public` など）: 今のまま固定 id を書き、`actor_id` は NULL。
  - Tauri の認証なし（`local`。現行の監査は `local`、`lib.rs:5733`）: 同じ印を Tauri の配線で付け、`Admin` に
    帰属させる（推奨。「ログインなしの操作」が両経路で同じ名前になる）。ui-settings の持ち主と `sessionOwnerKey` は
    `local` のまま（帰属は監査だけ）。別案は監査も `local` のまま残す（#778 の趣旨が Tauri だけ外れる）。
  - wire の `Identity`（id・name・role）は変えず、印は画面へ出さない。
- 予約名: `Admin` と grant の固定 id を、大小無視で作成・初期設定・改名から拒む。
  conventions §10 の「id・name から合成セッションを推測しない」は変えない（予約は見分けやすさのためで、
  判定の根拠にしない）。
  - 予約名の一覧を知っているのは配線の層だけ（grant は派生アプリが足せる開いた集合、`grant.rs:89-94`・`:200`。
    サービス層は axum / tauri を知らない、§2）。配線の層が `GrantSpec` の一覧から「固定 id → kind」の対応を作り、
    サービス層へ渡す口（`UsersService` の構築時の引数など）を置く（独立レビューで追加）。形は C0 の ADR で決め、
    C2 で入れる。C4 の移し替え（§4.1）も同じ対応を使う。
- **初期設定の判定**（「users が空なら最初の管理者を作れる」）は `kind = 'account'` の行だけを数える。
  ここを直し忘れると、新しい DB で初期設定ができなくなる。ユーザー一覧・件数・CSV・バックアップの
  検証など、`users` を数える所を C2 で洗う。
- 起動時の検出（独立レビューで変更。§10 の 15）: **毎回の起動で**、migration を当てる前に、`Admin`（大小無視）や
  予約名と同じ username のアカウントを探し、あれば migration を当てずに明示のエラーで止める。
  「0014 の前に 1 回」では足りない: grant は後から足せ（新しい固定 id が既存のアカウントと当たる）、PostgreSQL は
  アプリの復元を通らず（`backup.rs:207-213`）、開発中は C1〜C2 の間に 0014 済みの DB で `Admin` を作れる。
  - 対象は `kind = 'account'` の行（`kind` の列が無い 0014 より前の DB では全部の行）。
  - **組み込みの行の有無は `kind = 'builtin'` で判定する**。username では判定しない（人が作った `Admin` を
    組み込みと誤認しない）。1 行だけ、は 0014 の部分一意インデックスで守る（§4.1）。
  - 検出・予約・下の移行の口・fixture の改名は**同じ PR（C2）**に置く（C1 に検出だけを入れると、`admin` を使う
    既存の試験と demo が止まる）。リリースは 1 回なので、利用者の DB で「新しい版の最初の起動で、0014 の前に止まる」は変わらない。
  - エラーには、当たった名前と対処（下の移行の口の使い方）を書く。
- **移行の口**（独立レビューで追加。§10 の 14）: `Admin` の大小無視の予約は、最初の管理者を `admin` にした DB を
  全部止める。`admin` はこのリポジトリの標準の名前で（`apps/admin-template/src-tauri/src/lib.rs:5660`・`5748`・`5769` の
  `setup_first_user("admin", …)`、demo、`scripts/lib/add-resource-rust.mjs:1248`）、当たる DB は多い。
  `UsersService` に改名の口は無く、自己削除もできないので、「前の版で作り直す」は対処にならない。
  - 新しい版に**予約名のアカウントを改名する口**を置く。検出に当たった行だけが対象で、username だけを変える
    （`users.id`・ロール・パスワードは変えない。`auth_epoch` を進めてセッションを切り、監査に残す）。
    `users.id` が同じなので、監査の `actor_id` と `account_uid`（C3 で埋まる）は続く。
  - 旧い `ui.{旧名}.*` のキーも同じトランザクションで新しい名前へ付け替える（C4 の移し替えの前に名前だけが
    変わると、候補なしで捨てられる）。0014 の前後どちらの DB でも動く形にする。
  - 形: 起動の引数で呼ぶ CLI（サーバーと Tauri の実行ファイルの両方。DB に触れる人の操作）を基本にする。
    Tauri に、止まったときの初回画面（そのアカウントのパスワードを確かめてから改名）を足すかは C0 で決める。
    ネットワーク越しの認証なしの口は作らない。
  - C2 の範囲に、`admin` を使う試験・fixture・e2e・demo・scaffold の生成物（`add-resource-rust.mjs`）の改名を含める。
  - 別案: 予約を**完全一致の `Admin` だけ**にする。既存の DB は止まらず、移行の口も fixture の改名も要らない。
    代わりに、一覧と監査に `admin`（人）と `Admin`（組み込み）が並び、目では見分けにくい（`kind`・`actor_id` では
    区別できる）。grant の固定 id の予約も完全一致に揃えるかを別に決める必要がある。
- **組み込みの行の名前の案**（オーナーの案、未確定。§10 の 14）: 上の本文は決定 3 のまま（`Admin`・大小無視の予約・
  移行の口）で書いてある。次の 2 つと比べ、C0 の ADR で決める。
  - **(a) 名前を小文字の `admin` にする**（`local`・`public` と同じ並び）。予約は大小無視なので、衝突する DB の範囲は
    `Admin` のときと同じで、移行の口も fixture の改名も要るまま。加えて、最初の管理者が `admin` だった DB では、改名の前の
    監査（人の `admin`。`actor_username` はスナップショットで、`actor_id` は NULL）と、改名の後の組み込みの `admin` が
    **同じ綴りで並ぶ**。`Admin` なら大小で違って見える。#778 の動機（同名と見分けられない）が、過去の監査で戻ってくる。
  - **(b) 表示は `Admin`、行の username はアカウントでは作れない内部名にする**（例 `builtin.admin`。表示は既にある
    `display_name` の列に置く）。`Admin`・`admin` は予約しない。最初の管理者が `admin` の DB は**衝突せず、止まらない**。
    移行の口も `admin` の fixture の改名も、この件では要らなくなる。
    - 作れない形か: `validate_username`（`users.rs:134-156`）が断るのは、trim 後の長さ（1〜32）と `.` だけ。`.` は
      **新規だけ**で断り、古いアカウントは `.` を含みうる（`users.rs:146-149` の注記）。通るのは初期設定（`:748`）と
      作成（`:1091`）の 2 か所で、試験・seed・直接の SQL は通らない。つまり「文字で絶対に作れない」とは言えない。
      守りは 2 段にする: 新規は `.` で作れない＋古い行は**内部名との完全一致だけ**を毎起動の検出で止める
      （当たる DB は実際上ほぼ無い）。組み込みかどうかの判定は、どの案でも名前ではなく `kind`。
    - 監査の actor: `actor_username` には内部名を書き、`actor_id` を入れる。名前しか出ない出力（CSV・ログ）でも
      人のアカウントと同じ綴りにならない。画面（ユーザー一覧・監査）は `kind`・`actor_id` を見て `Admin` と印を出す。
      人が `Admin`・`admin` という名前を持てても、表示の `Admin`（印つき）と行の内部名で見分けられる。
      表示名だけを書く形（`actor_username = 'Admin'`）は、同名のアカウントと見分けられなくなるので採らない。
    - 残るもの: grant の固定 id の予約（`public` など。決定 3 の後半）は別の話で、そちらに当たる DB のための
      移行の口は小さく残す。画面に内部名 → 表示の対応（i18n を含む）が要る。名前で監査を絞る下流は内部名に直す。
  - **推奨は (b)**。P1 の運用の問題（標準の `admin` の DB が全部止まる）を元から無くし、見分けを名前の予約ではなく
    `kind` に置ける。(b) を採らないなら、(a) ではなく今の本文（`Admin`＋大小無視＋移行の口）を推奨する。
    (a) は衝突を減らさず、過去の監査との見分けを悪くする。(b) を採る場合は、決定 3 の前半（`Admin` の予約）を変えることになる。
- **復元との関係**（レビューで追加）: 現行の復元は、起動時に予約のファイルを検証してから DB のファイルを
  置き換え（`backup.rs:711`・`731`・`784`）、その後で起動の検査に進む。予約名のアカウントを含むバックアップを
  復元すると、置き換えた後で止まり、起動できない DB が残る。そこで**候補の DB を先に調べる**:
  同じ検出を `validate_sqlite_file`（`backup.rs:269`）に足し、予約の時点（`stage_restore_from_*`）で拒む。
  起動時の適用でも置き換えの前にもう一度調べ、当たれば壊れたファイルと同じ扱い（適用せずに外し、今の DB で起動）にする。
  安全コピー（`pre-restore-*`）へ自動で戻す形は採らない（置き換えの前に止めれば要らない）。
  検出は、`kind` の列が無い（0014 より前の）候補では全部の行、ある候補では `kind = 'account'` の行だけを見る
  （組み込みの `Admin` の行を持つ正しいバックアップを拒まない）。

**破壊的変更と移行**: ユーザー一覧に `Admin` が 1 行増える。`Admin`・`public` など予約名のアカウントは
作れない。既にある DB は起動しない（上のエラー。移行の口で改名すれば起動する。標準の `admin` も当たる）。
Tauri の認証なしの監査の actor が `local` から `Admin` に変わる。ADR-0017 §3（自己削除のガード）・監査の項を改訂する。

**リスク（認証）**: 組み込みの行が「ログインできる管理者」になる経路を作らないこと。パスワードの
リセット・CSV の取り込み・リストア・権限の個別付与（0013）の各経路を C2 で 1 つずつ確かめ、試験に入れる。

**試験**: 禁止の操作が REST・Tauri の両方で拒まれ、denied の監査も対称（§1）。組み込みの行ではログイン
できない。最後の管理者のガードが人のアカウントだけを数える。新しい DB で初期設定ができる。予約名の大小無視。
予約名のアカウントを含むバックアップは予約の時点で拒まれ、起動時の適用でも今の DB が置き換わらない。
独立レビューで追加: 0014 済みの DB に後から入った予約名のアカウント（grant を後から足した場合を含む）で、次の起動が止まる。
`kind = 'account'` の `Admin` が居ても、組み込みの行があるとは判定しない。組み込みの行の INSERT は 2 回目が入らない。
移行の口: `admin` の DB が改名の後に起動し、`users.id`・監査・旧い `ui.*` が新しい名前で続く。予約名に当たらない行は改名できない。
帰属の規則: 印つきの grant・印なしの grant・Tauri の認証なしの 3 通りで、監査の actor が REST と Tauri で同じになる（§1）。
組み込みの行へのログインの失敗が、居ないユーザーと同じ経路（ダミーの検証）を通る。`change_password`・`reset_password` が
組み込みの行を変えない（SQL を直接呼んでも 0 行）。

### 4.4 #786 ui-settings の条件付きの書き込みと再送

**設計（サーバー）**:

- `ui_settings` の持ち主は文字列の列にする（§10 の 2）: アカウントは `acct:<users.id>`、
  grant は `grant:<kind>`（決定 5）、Tauri の認証なしは `local`。主キーは（持ち主, key）。
- **アカウントの行は外部キーで守る**（レビューで変更）: 別の列 `user_id`（NULL 可、
  `REFERENCES users(id) ON DELETE CASCADE`）を持ち、アカウントの行では必ず入れ、合成セッションの行では NULL
  （CHECK で持ち主の列と食い違わせない。形は C4 で確定）。「削除と同じトランザクションで消す」だけでは、
  削除の前に受け付けた PUT が削除の後に行を作れる（孤児の行。同じ `users.id` は再利用されないが、消えない）。
  外部キーなら、削除が先に確定すれば PUT が失敗し、PUT が先なら削除が一緒に消す。
  - 外部キーの違反は storage ではなく、セッションが無いときと同じ拒否にして返す。
  - SQLite は接続ごとに外部キーを有効にしていることを前提にせず、効いていることを試験で確かめる。
- **revision は数ではなく、書き込みのたびにサービス層で作る乱数の文字列**（独立レビューで変更。§10 の 19）。
  行が無いことは固定の `"0"` で表す。1 ずつ増やす数だと、バックアップの復元で巻き戻った後に、開いたままのタブの
  古い `ifRevision` が別の値の revision と偶然一致して上書きする。行を消すと 0 へ戻るのも同じ穴。乱数なら、
  復元の後・作り直しの後に書かれた行は別の値になる（取得の時点の値と revision は一緒に戻るので、それを見ていたタブは通ってよい）。
  別案の墓石（値 NULL で revision を進める）は削除の穴だけを塞ぎ、復元には別に世代の値が要るので採らない。
- GET は `{ value, revision }`（行が無ければ `value: null`・`revision: "0"`）。
- PUT は `{ value, ifRevision? }`。`ifRevision` があり、今の revision と違えば `conflict`（REST は 409）と
  現在の `{ value, revision }` を返す。`ifRevision: "0"` は「まだ無いこと」。成功すれば新しい revision を返す。
- **判定と書き込みは 1 文で行う**（レビューで変更）。PostgreSQL の既定の分離レベルでは、同じトランザクションで
  読んでから無条件に UPDATE しても、2 つが同じ revision を読んで両方通る。場合を分ける:
  - `ifRevision` が `"0"` 以外: `UPDATE ... SET revision = 新しい乱数 WHERE 持ち主・key・revision = ifRevision`。
    変わった行が 0 なら `conflict`。
  - `ifRevision: "0"`: `INSERT ... ON CONFLICT DO NOTHING`。入った行が 0 なら `conflict`
    （同時の INSERT は主キーで片方だけが入る）。
  - `conflict` のときだけ、後から現在の値を読んで返す（その間に消えていれば `value: null`・`revision: "0"`）。
- `ifRevision` を省いた PUT は無条件（設定の画面のように、最後の値が勝ってよい使い方のため）。
  `INSERT ... ON CONFLICT DO UPDATE SET revision = 新しい乱数` の 1 文。
- **消す口**（独立レビューで追加）: DELETE（`ifRevision?`。判定は PUT と同じく 1 文）。行を消し、以後の GET は
  `"0"` を返す。K4 の「reset で保存を消す」（§4.6）が使う。いまの provider には消す口が無い（`uiSettings.ts:46-51`）。
- Tauri のコマンドも同じ引数・同じ応答にする（§1）。
- **C4 に admin-core の http・tauri アダプタの最小の追従を含める**（独立レビューで変更）: C4 で Tauri の応答が
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
  - **応答だけが失われた書き込み**（レビューで追加。#793 の後は、切断しても書き込みは終わる）: 結果が分からない
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
独立レビューで追加: バックアップを取る → 書く → 復元、の後で、復元より後に得た `ifRevision` の PUT が `conflict` になる。
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

- C0（ADR の承認）→ C1（migration 0014、スキーマだけ）→ C2（#778）・C3（#790）→ C4（#786 サーバー）→ C5（provider）→
  C6（`createSavedSetting`）。C2 と C3 は同じファイル（`users.rs`・`audit.rs`・Tauri の `lib.rs`）に触れるので直列。
- 独立レビューで変更: 予約名の検出・移行の口・fixture の改名は C1 ではなく **C2**（§4.3）。C1 は 0014 と
  部分一意インデックスだけ。C4 は admin-core の http・tauri アダプタの最小の追従を含み、C4 の後も画面が動く。
  公開の provider の形が変わるのは C5（§4.4）。予約名の一覧と「固定 id → kind」の口は C0 で形を決め、C2 で入れ、C4 が使う。
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
| S1 | #793 の層・停止（受付を止めて待つ。超過は向きで分ける: 広げる変更は切り替えの失敗、狭める変更は止めたまま）・panic・切断の試験・ADR-0035 | `banto-server`・`src-tauri` | 挙動 | fable | 切断しても作成と監査が残る試験が通る。停止の試験（§4.5） |
| S2 | #793 handler の順序の点検と直し | `banto-server/routes`・テンプレートの `rest`・`src-tauri` | 挙動 | fable | 点検の表を PR に載せ、直した所に試験 |
| C1 | migration 0014（2 方言、**スキーマの追加だけ**。行を足さない・旧い `ui.*` を消さない。`kind = 'builtin'` の部分一意インデックスを含む） | テンプレートの `core`・`banto-admin-services` | **破壊的** | fable | 0014 の後も初期設定と ui-settings が今のまま動く試験（両方言）。`pnpm verify:architecture` rule 11 |
| C2 | #778 組み込みの行を入れる手順（数え方の直しと**同じ PR**）・禁止・予約名（一覧を渡す口）・毎起動の検出・復元の候補の事前検査・移行の口（改名）・帰属の印と監査の actor・`admin` を使う試験 / fixture / e2e / demo / scaffold の改名 | `banto-admin-services`・`banto-server`・`src-tauri`・テンプレート・`scripts` | **破壊的** | fable | §4.3 の試験。新しい DB で初期設定ができる。予約名を含むバックアップが置き換わらない。`admin` の DB が改名の後に起動する。両経路の対称 |
| C3 | #790 `account_uid` の埋め込みと作成時の採番・`accountId`・`sessionOwnerKey`・`actor_id` | `banto-admin-services`・`banto-server`・`src-tauri`・`admin-core`・テンプレート | **破壊的** | fable | §4.2 の試験（復元の回帰試験を含む）。持ち主つきの記憶の利用箇所を全部確認 |
| C4 | #786 サーバー（条件付きの PUT・DELETE・乱数の revision・外部キー・Tauri）。参照先の切り替えと、旧い `ui.*` の移し替え・**全部の**削除を**同じ PR** で。admin-core の http・tauri アダプタの最小の追従（公開の provider の形は据え置き） | `banto-admin-services`・`banto-server`・`src-tauri`・`admin-core`（アダプタだけ） | **破壊的** | fable | §4.4 の競合の試験（両方言、片方だけ成功）。削除と PUT の競合で行が残らない。§4.1 の移し替えの試験（捨てた後に同名を作っても渡らない）。旧い形の provider のまま画面が動く |
| C5 | #786 provider の置き換え（`remove` を含む）・`updateUiSetting`・同梱の実装・呼び手の追従 | `admin-core`・テンプレート | **破壊的** | fable | #707 の直列化の試験が新しい形で通る |
| C6 | `createSavedSetting` の再送・`merge`・`onSettled`・README | `admin-core` | 足すだけ | sonnet | 再送・停止・競合の単体テスト |
| T1 | #794 Toast と浮かぶ面の tint | `ui`・`grid-svelte` | 見た目 | sonnet | ダークで透けない。基準画像の再生成 |
| T2 | #795 色差の試験と最小の調整 | `theme` | 見た目 | fable | 試験が両テーマで通る。CVD の検査 |
| K1 | #792 `isOnScreen`（`docked`・`floating`・`autoHidden`・`flyoutPanel` から） | `dock-svelte` | 足すだけ | sonnet | 偽の 5 つと真の 3 つの単体テスト。README |
| K2 | #796 `cancelGesture` と自動の取り消し | `dock-svelte` | 挙動 | sonnet | 操作中の `replaceLayout` の単体テスト |
| K3 | #791 前半（`DockHost` と `ThreePaneDock` の両方に `onLayoutCommit`） | `dock-svelte`・テンプレート | 足すだけ | fable | §4.6 の試験。e2e（workspace-dock の保存） |
| #782 PR2〜PR8 | Issue の本文どおり | `dock-svelte` | PR ごとに判定（§9.2） | fable | 本文の各 PR の条件。PR6 で #780 を閉じる |
| K4 | #791 後半 | `dock-svelte`・テンプレート・scaffold | **破壊的** | fable | ダッシュボード・workspace-dock の保存が今と同じ（API 経由の表示切替・キーボード・タブの切り替えを含む）。scaffold の dry-run |
| F1 | #714 `file` 型（保留の持ち方・画面の検証・送信値から除く・1 欄まで・ui-demo の見本） | `forms`・ui-demo | union に追加 | fable | §4.12 の単体テスト。forms がほかのパッケージを import しない |
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

- **DB**: migration 0014 を取り込む。`Admin`（大小無視）や予約名のアカウントがある DB は起動しない。
  **最初の管理者を `admin` にした DB も当たる**（改名の口で名前を変えてから起動する。手順を書く）。
  そのようなバックアップは復元の予約で拒まれる。検出は毎回の起動で走る（grant を後から足したときも当たる）。
  - **0014 を当てた DB は旧い版へ戻せない**（旧い版は 0014 を知らず、移した後の `ui.*` は `settings` に無い）。
    上げる前にバックアップを取る。戻すときは、そのバックアップを旧い版で復元する。
  - 持ち主を決められない ui-settings は移らず、**捨てられる**（`local` という名前のアカウントがある DB の `ui.local.*`。
    grant の固定 id と同名のアカウントがある DB の `ui.{固定 id}.*`。現行は `ui.public.*` を同名のアカウントと
    閲覧公開が共有している、`routes/ui_settings.rs:31-36`）。移し替えは 1 回きりで、旧い `ui.*` の行は全部消える。
  - 派生アプリが grant を足している場合は、**C4 を含む版の最初の起動の前に**「固定 id → kind」の対応を渡す
    （予約名の一覧と同じ口。渡さないと、その grant の保存値は候補なしで捨てられる）。手順を upgrading に書く。
- **Identity**: `accountId`（`users.account_uid`）を載せる（Tauri の組み立て、REST の verifier）。載せないと
  持ち主つきの記憶が働かない。古い `account:` のキーの記憶は読まれない（一覧の記憶・最近のコマンド・
  ドックの配置は 1 回だけ既定に戻る）。
- **ユーザー一覧**: 組み込みの `Admin` が居る。消せない・変えられない。監査の actor に `actor_id`。
  `Admin` に帰属させる grant には `GrantSpec` の印を付ける（付けなければ今のまま固定 id）。Tauri の認証なしの
  監査の actor は `local` から `Admin` に変わる（監査を名前で絞っている所を直す）。
- **ui-settings**: `UiSettingsProvider` の `get` / `set` の形、REST・Tauri の応答の形が変わる。
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
- #793: Issue が挙げる industrial の `local_grant.rs:678` は別リポジトリで、ここでは開いていない。
- #793: 構成の「露出の向き」を比べる項目の全部（有効・bind・閲覧公開のほかにあるか）と、残った仕事を監査に書く形（S1）。
- #778: ~~前の版で username を変えられるか~~（独立レビューで確認: `UsersService` に改名の口は無い。移行の口を新しい版に置く、§4.3）。
  `users` を数える所の全部（C2）。`admin` を使う試験・fixture・e2e・demo の数と、改名後の名前（C2）。
  移行の口を Tauri の初回画面にも置くか、監査を名前（`local`）で絞っている所が下流にあるか（C0・D1）。
  内部名の案（§4.3 の b）を採る場合: `validate_username` を通らずに users の行を作る経路（CSV の取り込み・seed・派生アプリ）と、
  username の長さの制限がいつからあるか、画面が username をそのまま出している所（C0・C2）。
  固定値の `password_hash` がハッシュの検証で「不一致」になること、起動時の手順を派生アプリが呼び忘れない置き場（C2）。
- #790・#786: grant セッションの旧い ui-settings がどの名前で保存されているか（移し替えの候補の一覧、C4）。
  SQLite の外部キーが全部の接続で有効か（C4）。`ui.` で始まる全体設定が派生アプリにも無いか（下流は D1 で見る。C4）。
  PostgreSQL の advisory lock の鍵の決め方、サービス層を通らない INSERT の行の遅延埋め（C3）。
- #790: TS の `Identity` を自分で組み立てている所、`identity.id` を持ち主として使っている所の残り（C3）。
- #786: 「一時的な失敗」を見分ける kind（C6）。`settings` 表のバックアップ・リストアが `ui_settings` を含むか（C4）。
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

## 10. この計画で新しく置いた判断（オーナーに確認する）

C0 の ADR で確定する。推奨を書く。**クロスレビュー（PR #797）で変えた点**は 1・2・3・4・6・8 と、足した 10〜13。
このうち 1 と 10 は §2 の決定（2・6 と 1）の形を変えているので、あらためて確認する。
**独立レビュー（PR #797、2026-11-22）で変えた点**は、末尾に足した 14〜20（既存の 3・4・6 の形を変えるものは、
その項目を指して書く）。14・16・19 は §2 の決定（3・4・9）に関わるので、あらためて確認する。

1. **（レビューで変更。決定 2・6）** 持ち主のキーは `acct:<accountId>`、`accountId` はアカウントの作成時の乱数
   `users.account_uid`。`instance.id` と `Identity.instanceId` は置かない。理由: DB の中の `instance.id` は
   バックアップの復元で採番と一緒に巻き戻り、復元後に作った別人が同じキーを得る（§4.1・§4.2）。
   別案は「復元のたびに `instance.id` を替える」。全員の記憶が復元のたびに既定へ戻り、復元の経路ごとに
   替え忘れの余地が残るので採らない。
2. **（レビューで変更）** `ui_settings` の持ち主は文字列の列（`acct:<id>` / `grant:<kind>` / `local`）のまま、
   アカウントの行は `user_id` の**外部キー（`ON DELETE CASCADE`）で守る**。当初の推奨（外部キーを張らず、
   削除と同じトランザクションで消す）は、削除の前に受け付けた PUT が孤児の行を作れるのでやめる（§4.4）。
3. 移行で、持ち主を一意に決められない ui-settings の行は捨てる（推奨）。**（レビューで変更）** 候補に合成セッション
   （`local`・grant の固定 id）を入れる。同名のアカウントが居れば、個人にも端末共通にも渡さずに捨てる。居なければ
   端末共通の値として残す（§4.1）。`local` を予約名に足すかも諮る（足すと、既存の `local` のアカウントがある DB は
   起動時に止まる。推奨は足さない。新しい持ち主の表し方では衝突しない）。
4. `onLayoutCommit` の理由は `'user' | 'reset' | 'narrow-switch'`。保存値の復元（`restoreLayout`）では呼ばない（推奨）。
   **（レビューで変更）** `DockHost` にも置く（理由は `'user' | 'reset'`）。ダッシュボードの保存の移行（K4）に要る（§4.6）。
5. `REQUIRED_TABLES` に `ui_settings` を足さない（推奨。古いバックアップを拒まない）。
6. #793 の停止時に待つ上限と、panic の応答の kind（S1 の ADR-0035 で提案）。**（レビューで変更）** 上限を超えたら
   成功にせず、Tauri の再設定は失敗にして前の構成へ戻す。停止の合図の後の書き込みは 503（§4.5）。
7. §9.2 の各候補（PR ごとに諮る）。
8. #714: ファイルは列にせず既存の添付に揃える。新規は「作成の後にアップロード」で、サーバーの操作は足さない（推奨）。
   **（レビューで変更）** 欄の必須・件数は画面だけの制約で、**業務上の必須はサーバーで保証しない**と明記する。
   保証が要るアプリは別のサーバーの契約を自分で置く。`file` 型は 1 つのフォームに 1 欄まで（§4.12）。
9. #716: §4.13 の判断 1〜4（線引きは Issue の案、二重構造は案 C、既定の配置の配布は作らない、
   フィルタは期間の共有だけ）。**判断待ち**。
10. **（レビューで追加。決定 1）** migration 0014 はスキーマの追加だけにする。組み込みの行（C2）・`account_uid` の
    埋め込み（C3）・旧い `ui.*` の移し替えと削除（C4）は、呼び出し側を切り替えるのと同じ PR で、起動時の冪等な手順として
    入れる（§4.1 の「段階」）。スキーマの migration が 1 回なのは変わらない。別案はデータ用の migration 0015 を足す
    （あいまいさの判定を SQL の 2 方言で書くことになる）。
11. **（レビューで追加）** 組み込みの行の `password_hash` は NULL にせず、資格情報ではない固定値を置く
    （`NOT NULL` を外すには SQLite で表の作り直しが要る）。verifier は `kind` で先に拒む（§4.3）。
12. **（レビューで追加）** `updateUiSetting` の `apply` は冪等であることを契約にし、サーバーに操作 ID は持たない（§4.4）。
13. **（レビューで追加）** 予約名のアカウントを含むバックアップは、復元の予約と適用の前に候補の DB を調べて拒む。
    安全コピーへの自動の復帰は作らない（§4.3）。
14. **（独立レビューで変更。決定 3）** `Admin` の大小無視の予約は、最初の管理者を標準の `admin` にした DB を全部止める。
    組み込みの行の名前と予約の形を、次から選ぶ（§4.3。本文は「現行」で書いてある）。
    - 現行: `Admin`・大小無視の予約・起動時に止める（決定 3）＋**新しい版に改名の口**（起動の引数の CLI を基本に、Tauri の
      初回画面を足すかも諮る。`users.id` は変わらず、旧い `ui.*` も付け替える）。`admin` の fixture・demo の改名が要る。
    - 完全一致: 予約を `Admin` だけにする。既存の DB は止まらないが、`admin` と `Admin` が一覧と監査に並ぶ。
    - (a) 名前を小文字の `admin` にする（オーナーの案）: 衝突の範囲は現行と同じで、改名の口も要るまま。改名の前の監査の
      `admin`（人）と組み込みの `admin` が同じ綴りになる。
    - (b) 表示は `Admin`、行の username はアカウントでは作れない内部名（例 `builtin.admin`）にし、`Admin`・`admin` を予約しない
      （オーナーの案）: 最初の管理者が `admin` の DB は衝突せず止まらない。監査には内部名と `actor_id` を書き、画面は `kind` で
      `Admin` と印を出す。`.` は新規だけで断られるので、古い行は内部名との完全一致を毎起動の検出で止める。
    - **推奨は (b)**（決定 3 の前半を変える）。採らないなら現行。(a) は推奨しない。grant の固定 id の予約（決定 3 の後半）は
      どの案でも残り、そのための改名の口は小さく残す。
15. **（独立レビューで変更。10 の段階の形）** 予約名の検出は 0014 の前の 1 回ではなく**毎回の起動**で、`kind = 'account'` の行を見る。
    組み込みの行の有無は `kind = 'builtin'` で判定し、部分一意インデックスを 0014 に入れる。検出・予約・移行の口・fixture の改名は
    C1 ではなく C2 に置く。予約名の一覧（grant の固定 id → kind）を配線の層からサービス層へ渡す口を置く（推奨。§4.3）。
16. **（独立レビューで追加。決定 4）** `Admin` に帰属させるセッションは、`GrantSpec` の明示の印で決める（id・name から推測しない）。
    印なしの grant（`public` など）は今のまま。**Tauri の認証なし（`local`）も `Admin` に帰属させる**（推奨。監査の actor が `local` から
    変わる。持ち主のキーは `local` のまま）。別案は `local` の監査を変えない（§4.3）。
17. **（独立レビューで変更。6 の形）** 停止が上限を超えたときの巻き戻しは、広げる・同等の変更だけにする。狭める変更
    （無効化・閲覧公開の停止）は listener を戻さず、新しい構成を保存し、残った仕事を監査に残す（推奨。戻すと fail-open。§4.5）。
18. **（独立レビューで変更。4 と決定 11）** `onLayoutCommit` は「確定点で `serialize()` が前回の通知から変わっていたら」呼ぶ。
    除外（復元・途中・拒否）だけを列挙し、`'user'` は API 経由の変更も含む。`'reset'` は reset を始めた口が `replaceLayout` に渡す（推奨。§4.6）。
19. **（独立レビューで変更。決定 9）** ui-settings の revision は数ではなく、書き込みごとの乱数の文字列（無い行は `"0"`）にする。
    復元と削除で revision が巻き戻り、古い `ifRevision` が偶然一致するのを防ぐ（推奨）。別案は墓石（値 NULL で revision を進める。
    復元には効かない）。あわせて消す口（DELETE・provider の `remove`）を足し、C4 に admin-core のアダプタの最小の追従を含める（§4.4）。
20. **（独立レビューで変更。3 の形）** C4 の移し替えでは、`ui.` で始まる旧い行を、移した・捨てたを問わず同じトランザクションで
    全部消す（推奨。残すと、後から作った同名のアカウントや端末共通へ渡る）。移し替えは 1 回きりになり、派生アプリは先に
    「固定 id → kind」を渡す。0014 の後は旧い版へ戻せないことを注意に書く（§4.1・§8）。
