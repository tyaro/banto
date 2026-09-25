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

- fix(admin-core): 失効したセッションで、SSE（`/api/events`）が再試行を続け、
  `/api/auth/check` の `200 false` でもトークンが残る問題を修正（#241）。
  - `check()`（`createHttpAuthProvider`）は、`401` に加えて `200 false`（失効が
    確認できた）でも保存しているトークンを消す（Remember me の localStorage も）。
    消すのは確認したトークンがまだ保存されているときだけ（確認中に新しくログイン
    したトークンは消さない）。`500`・到達不能では従来どおり消さずに reject する。
  - SSE のクライアントは、再接続が `401` なら、そのトークンでの再試行をやめ、
    別のトークン（再ログイン）が現れるまで要求しない。`500`・到達不能・
    ストリームの終了は従来どおり 3 秒ごとに再試行する。
  - `connectEvents` は SSE の `401` を受けると `check()` で確認し（ここで
    トークンが消える）、`false` のときだけ新しい `onSessionEnded` の購読者に
    知らせる。SSE は失効したトークンごとに 1 回だけ知らせ、同時の確認は 1 回に
    まとまるので、通知は確認 1 回につき 1 回。画面の遷移で失効に気付いた経路は
    ルートガードが自分でログイン画面へ移し、トークンの消去は確認したトークンに
    限るので、2 つの経路が互いを巻き戻さない。応答しない `check()` は 10 秒で
    あきらめる（照合できない扱い。通知しない）。
  - **派生アプリ**: タグを上げるだけで、再試行の停止とトークンの消去は効く。
    **開いている画面をログイン画面へ移すには、保護ルートのレイアウトに
    `onSessionEnded` の購読を 1 行足す**（admin-template は
    `routes/(app)/+layout.svelte` の
    `$effect(() => onSessionEnded(() => void invalidateAll()));`）。ルートガード
    （`resolveProtectedSession`）が再実行され、ログイン画面（公開閲覧が ON なら
    閲覧者セッション）へ移る。足さない場合も、次の画面遷移でログイン画面へ移る。
    `EventProvider` を自前で実装している場合、`subscribe` の第 2 引数
    （`EventSubscriptionHooks`、任意）は無視してかまわない。
  - E2E: 別のブラウザで Remember me ログインした閲覧者の画面が、管理者による
    パスワードのリセットのあとログイン画面へ移り、トークンが消え、SSE の再試行が
    止まることを確かめるシナリオ 13b を追加。

## [1.7.1] - 2026-09-25

**v1.7.1 — グリッドの初回クリック取りこぼしの修正と、`AuthState::revalidate` の公開。破壊的変更は無い。**
v1.7.0 から上げるだけで直り、`@banto/grid-svelte` を使っている派生アプリの
追従作業は不要。`revalidate` の公開は可視性を広げるだけの追加で、派生アプリは
自前の長時間ストリームの再検証に使える（使わなければ変更不要）。

- feat(banto-server): `AuthState::revalidate` を `pub` にした（#239）。
  `authenticate` と同じ照合（再バインドの扱いを含む）をしつつ、無操作期限
  （idle）のタイマーを延ばさない再検証で、`/api/events` の定期再検証
  （#231）が使っているのと同じもの。派生アプリが自前の長時間ストリーム
  （banto-industrial の `/api/tag-stream`・`/api/v1/stream`、
  banto-industrial#430）で同様の再検証をできるようにするための公開。破壊的
  変更ではない（既存の可視性を広げるだけ）。

- fix(grid): グリッドの下端が画面の外に出ているとき（画面を開いた直後に多い）、
  行をクリックするとセルは選択されるのに `onRowClick` が呼ばれない問題を修正
  （#236）。セルの `pointerdown` でグリッドにフォーカスを移す際、グリッドを
  見せようとページがスクロールし、ボタンを離した位置が別の要素になって `click` が
  セルに届いていなかった。フォーカスの移動を `preventScroll` にした（キー操作での
  選択移動のスクロールは従来どおり）。v1.6.0 以前からある挙動で、#222〜#227 の
  変更は原因ではない。単体テスト（読み込み直後・再取得中のクリック）と、ユーザー
  一覧を開いた直後のクリックで編集パネルが開く E2E を追加。

## [1.7.0] - 2026-09-24

**v1.7.0 — セッション失効・添付ストレージの堅牢化とグリッド操作の安定化リリース。**
v1.6.0（2026-09-14）以降の PR #222〜#234（12 件、#204/#205/#206/#207/#208/#209/
#210/#211/#212/#213/#214/#231）をまとめる。

**破壊的変更（派生アプリはタグを上げる前に確認）**:

- **`banto_server::AuthState` の全コンストラクタ（`new`/`with_policy`/
  `with_policies`）が `SessionValidation` を必須引数に取るようになった**（#204）。
  タグを上げると既存の呼び出しはコンパイルエラーになる。**実アカウントを持つ
  アプリでは、アカウントと照合する `SessionValidation::Lookup` を組み込む。**
  `SessionValidation::DisabledNoRevocation` はアカウントの保存先を持たない
  テスト・公開閲覧専用サーバ向けで、削除・降格・パスワード変更によるセッション
  失効は行われない（コンパイルエラーを消すためだけに選ばないこと）。移行手順は
  下記 #204 の項目に手順 1〜6 で記載。
- **PostgreSQL では環境変数 `BANTO_ATTACHMENTS_DIR` が必須になった**（#208）。
  未設定だと `banto-serve` は起動しない（作業ディレクトリ基準の既定値は廃止）。
  SQLite は変更なし。移行手順（旧保存先からのコピー）は下記 #208 の項目に記載。

- feat(forms/settings): 保存型の画面で未保存の変更を示し、保存せずに離れようとしたら
  確認する（#214、P2）。対象は商品の新規作成・詳細、設定の「サーバ・接続」
  「セキュリティ」と「アカウント」のパスワード変更。未保存の間は保存ボタンの横に
  「未保存の変更があります」を出し、商品フォームには「一覧へ戻る」（＝取り消し）、
  設定には「変更を取り消す」を足した。「サーバ・接続」「セキュリティ」には、
  「保存して適用」を押すまで反映されない（外観・言語はすぐ反映される）ことを短く書いた。
  確認は既存の削除確認と同じ `window.confirm`。再読み込み・タブを閉じるは
  ブラウザ標準の確認、Tauri のウィンドウを閉じるときも確認する（未保存の間だけ
  close-requested を購読。capability に `core:window:allow-destroy` を追加）。
  変更なし・値を元に戻した・保存に成功した・取り消した後は確認しない。保存中の
  離脱は確認し、離脱後に保存が終わっても元の画面へ引き戻さない。ログイン画面への
  移動（ログアウト・セッション失効）は確認しない。ドラフトの復元はしない（保存先・
  古いドラフト・複数タブの扱いが要るため、確認のみ）。

  **`@banto/forms` の追加 API**（破壊的変更なし）: `guardUnsavedChanges(options)`
  （コンポーネント初期化中に呼ぶ）、`hasUnsavedChanges()`（リアクティブ。どれか
  1 つでも未保存なら `true`）、`UnsavedChangesNotice`（未保存マーカー）、
  `FormStore.markClean()`（今の値を「保存済み」にする）。判定表は純関数
  `decideLeave` / `runLeaveCheck` で公開。パッケージは SvelteKit に依存しないため、
  `beforeNavigate` は呼び出し側が渡す。同じ画面に複数のガードがあっても、確認は
  1 回だけ出る。`guard.canAutoNavigate` は、離脱を承認して遷移中の間（遷移先の
  読み込み中を含む）とアンマウント後に `false` になり、遷移が中止・失敗すると
  `true` に戻る。保存後の自動遷移はこれを見て行う（`guard.leaving` /
  `guard.disposed` も個別に読める）。

  **保存済みの値を読み込んで下書きと比べる画面**（「サーバ・接続」「セキュリティ」）は、
  保存済みの値が取れるまで入力と保存を無効にし、取得に失敗したら「再読み込み」を出す。
  取得前の下書きは比べる相手がないため、編集を許すと未保存として検知できない。
  派生アプリで同じ作りの画面を守るときも、同じようにすること。

  **派生アプリでの使い方**（タグを上げたあと、保存型の画面ごとに）:

  ```ts
  import { beforeNavigate, goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { guardUnsavedChanges } from '@banto/forms';

  const guard = guardUnsavedChanges({
  	isDirty: () => store.isDirty, // 自前の下書きなら「下書き !== 保存済みの値」
  	isSaving: () => saving, // 保存中も離脱を確認する
  	beforeNavigate,
  	message: () => '保存していない変更があります。変更を破棄してこの画面から移動しますか？',
  	isForced: (nav) => nav.to?.url.pathname === `${base}/login` // ログアウト等は確認しない
  });

  // 保存に成功したら、移動の前に「未保存でない」状態にする（保存中フラグも先に下ろす。
  // 立ったままだと、この goto にも確認が出る）
  store.markClean(); // FormStore の場合。自前の下書きは保存済みの値に揃える
  // 利用者が別の画面を選んだあと（遷移先の読み込み中も含む）は、保存後の自動遷移をしない
  if (guard.canAutoNavigate) await goto(`${base}/list`);
  ```

  マーカーは `<UnsavedChangesNotice pending={guard.pending} label="未保存の変更があります" />`。
  admin-template では `$lib/unsavedChanges.ts` が `beforeNavigate`・文言・
  `isForced` を束ねた薄い包みなので、これを写して使うのが早い。Tauri の
  ウィンドウ終了も確認するなら、`$lib/banto/windowCloseGuard.ts` と
  `(app)/+layout.svelte` の `$effect`（`hasUnsavedChanges()` が `true` の間だけ
  `guardWindowClose` を登録）を写し、capability に `core:window:allow-destroy`
  を足す（close-requested を JS で購読すると、閉じる処理を JS の `destroy()` が
  行うため。足さないと未保存の間はウィンドウが閉じられなくなる）。

- fix(attachments): `BANTO_DB` が PostgreSQL の接続 URL のときも、その文字列を
  ファイルパスとみなして添付の保存先を作っていた問題を修正（#208、P2）。同じ
  サーバーの別の DB（`…/banto_a` と `…/banto_b`）が同じ保存先を共有して、
  id が同じ添付の本体を上書きしていた。パスワードを変えると保存先が変わって
  既存の添付を見失い、保存先のパスには接続の資格情報が入っていた。
  - **PostgreSQL では新しい環境変数 `BANTO_ATTACHMENTS_DIR` が必須**。その下に
    DB ごとのサブディレクトリ `pg_<ホスト>_<ポート>_<DB名>_<ハッシュ16桁>` を作る
    （ユーザー名・パスワードは含めない。変えても保存先は変わらない。ホスト名の
    書き方 `localhost`/`127.0.0.1`、ポート、DB 名を変えると別の保存先になる）。
    **未指定なら `banto-serve` は起動しない**（作業ディレクトリ基準の既定値は
    作らない）。**SQLite は変更なし**（DB ファイルの隣の `attachments`。
    `BANTO_ATTACHMENTS_DIR` は使わず、設定されていれば警告だけ出す）。
  - **本体を上書きしない**: 本体は `create_new` で書き、同じ id のファイルが
    既にあればアップロードを失敗させる（行も残さない）。
  - `banto-serve` の起動ログ（`DB at …`）と、`postgres` feature 無しで PostgreSQL
    URL を渡したときのエラーから、接続の資格情報を除いた（`db::display_target`）。
    形が曖昧な URL（資格情報にエスケープされていない `?`/`#`/`/`/`@` がある等）や、
    スキームの誤った接続文字列は、入力を含まない固定の表記（`postgres://<redacted>` /
    `<redacted>`）で表示する。
  - 追加 API（`banto-attachments`）: `base_dir_for_target` / `postgres_storage_key` /
    `sqlite_base_dir` / `legacy_base_dir`、`AttachmentsService::import_legacy_files`
    と `LegacyImportReport`。`admin-template-core`: `db::display_target`。既存の
    API の変更は無い。

  **移行手順**（PostgreSQL で `banto-serve` を動かしていた場合。SQLite は不要）:
  1. 添付の保存先にするディレクトリを決め、`BANTO_ATTACHMENTS_DIR` に設定する
     （絶対パスを推奨。相対パスは作業ディレクトリ基準になる）。
  2. **これまでと同じ作業ディレクトリ・同じ `BANTO_DB`** で起動する。起動時に、
     旧保存先（作業ディレクトリ下の、接続 URL から作られた `postgres:` /
     `postgresql:` で始まるディレクトリ）から、その DB の添付を新しい保存先へ
     **コピー**する。各ファイルは DB に記録した sha256 と照合し、一致したものだけ
     移す（旧保存先は複数の DB で共有されていたため、別の DB のファイルや上書き
     されたファイルは移さない）。旧保存先のファイルは成功しても失敗しても**消さない**。
     コピーは処理ごとに一意な一時ファイルに書いてからハードリンクで確定するので、
     複数のプロセスが同時に移行しても、既存のファイルを上書きせず、書きかけの
     ファイルも残さない（ハードリンクが使えないファイルシステムでは「失敗」に数え、
     旧保存先に残す）。新しい保存先に既にある本体も sha256 を照合し、DB の値と
     違えば上書きせずに警告として数える。結果は件数でログに出る。移せなかった分
     （サムネイルだけ欠けた分も含む）は、原因を直して再起動すれば再試行される
     （移行済みの分は飛ばす）。旧保存先は**いまの** `BANTO_DB` から求めるので、
     以前ユーザー名やパスワードを変えていて旧保存先が複数あるときは、古いほうの
     中身をいまの旧保存先へコピー（上書きしない）してから再起動する。
  3. 同じ接続先の DB をすべて起動し終え、添付が開けることを確かめたら、旧保存先の
     ディレクトリを手で消す（ディレクトリ名に接続の資格情報が入っている）。
     「別の DB のファイル」が残った添付は、#208 の上書きですでに本体が失われて
     いる可能性がある。
  - **派生アプリ**（`banto-attachments` をタグで使い、自前で `AttachmentsService::new`
    を呼ぶアプリ）: PostgreSQL で動かすなら、保存先を `base_dir_for_target` で
    求め、旧保存先がある場合は `import_legacy_files` を起動時に呼ぶ（`banto-serve.rs`
    の該当箇所が手本）。SQLite だけなら対応は不要。

- fix(auth): ユーザーの削除・降格・パスワード変更・パスワードリセットで既存の
  セッションが失効しなかった問題を修正（#204、P1）。`users.auth_epoch`（認証の世代、
  migration `0007`）を追加し、セッションを確立時の「行 id + 世代」に結び付けて、
  REST（`require_auth`）と Tauri（`require_role`）の両経路で**要求ごとに DB と照合**
  する。アカウントが無い・世代が違えば失効（401）、一致すれば DB の今のロールで
  認可する。変更はどちらの経路から行っても、他方の経路・別プロセス・Remember me の
  セッションにも効く。自分のパスワード変更では、変更した当のセッションだけ残る
  （[ADR-0014](docs/adr/0014-account-bound-session-revocation.md)、conventions §6）。
  **Rust API の破壊的変更（タグを上げると必ずコンパイルエラーになる）**:
  `banto_server::AuthState` のすべてのコンストラクタ（`new`/`with_policy`/
  `with_policies`）が `SessionValidation` を**必須の引数**に取る（既定値は無い）。
  `SessionValidation::Lookup`（アカウントと照合する。実アカウントでは唯一の選択肢）か、
  `SessionValidation::DisabledNoRevocation`（照合しない＝従来の挙動。アカウントの
  保存先を持たないテスト・公開閲覧専用サーバのためだけ）を名前で選ぶ。ほかに
  `banto_admin_services::users::UserIdentity` に `auth_epoch` を追加、
  `UsersService::change_password` が新しい世代（`i64`）を返す、
  `banto_server::LoginOutcome` に `Unavailable` を追加（`POST /api/auth/login` が
  503 を返し得る）。`/api/auth/{check,identity}` は照合中の DB エラーを 500 で
  返す。

  **フロントエンド（`@banto/admin-core`）の挙動変更**: `AuthProvider.check()` は、
  セッションが無効と**確認できたとき**（トークン無し・`401`・`200 false`）だけ
  `false` を返し、サーバーが照合できなかったとき（`500`・接続不能）は
  `ProviderError` で**reject** する（従来は `false`。一時的な DB エラーで
  ログイン画面へ飛ぶ・閲覧公開 ON なら閲覧者トークンで元のトークンを上書きする、
  が起きていた）。保護ルートの判断は新しい `resolveProtectedSession(auth)` に
  まとめた（`'session' | 'publicViewer' | 'login'` を返し、照合できなければ
  reject。reject 時は `status()`・`enterPublicViewer()` を呼ばず、トークンにも
  触れない）。admin-template の `(app)/+layout.ts` は reject を 503 のエラー画面
  （新設の `routes/+error.svelte`、再試行ボタン付き）にし、`panel/[id]` は
  「確認できませんでした」を表示する。Tauri の `auth_check` も DB エラーは
  `Err`（reject）で、同じ区別になる。

  **派生アプリの移行手順**（`banto-server` をタグで使い、`users` テーブル・
  サービス・`src-tauri` を自前で持つアプリ）: タグを上げると `AuthState::new(verifier)`
  などの呼び出しが**コンパイルエラー**になる。そこで、**照合を組み込む**（手順 1〜5）
  か、**明示的に無効化する**（`SessionValidation::DisabledNoRevocation` を渡す。
  失効は起きないまま。実アカウントを持つアプリでは選ばない）かを選ぶ。

  1. **マイグレーション**: 両方の方言に 1 本ずつ足す（既存の行は 0 で始まる。
     セッションはメモリにしか無いので既存セッションの移行は不要）。
     SQLite: `ALTER TABLE users ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;`
     / PostgreSQL: `ALTER TABLE users ADD COLUMN auth_epoch BIGINT NOT NULL DEFAULT 0;`
  2. **ユーザーサービス**（自前の `users.rs` を持つ場合。`banto_admin_services` の
     `UsersService` を使うなら不要）: `UserIdentity` に `auth_epoch` を持たせ、
     `verify`・`get_by_username` の `SELECT` と作成時の `RETURNING` で読む。
     ロール変更（`auth_epoch = auth_epoch + CASE WHEN role = ? THEN 0 ELSE 1 END`）・
     パスワード変更・パスワードリセットの **`UPDATE` と同じ文で**増やす。
     パスワード変更は `RETURNING auth_epoch` で新しい世代を返す。
  3. **REST の `AuthState`**: `AuthState::new(verifier, SessionValidation::lookup(lookup))`
     にする。`lookup` はユーザー名から `SessionAccount { identity（今のロール）,
stamp: SessionStamp { account_id: 行 id, auth_epoch } }` を返す（無ければ
     `Ok(None)`、DB エラーは `Err`。ログイン時は入力どおりのユーザー名で呼ばれるので、
     ユーザー名を正規化する検証関数なら lookup も同じ正規化をする）。
     `banto_admin_services::UsersService` なら
     `banto_server::routes::user_auth_state(users, audit)` で済む。テストで固定の
     検証関数を使う箇所は `SessionValidation::DisabledNoRevocation` でよい。
  4. **REST のハンドラ**: `require_auth` の**外**でトークンから本人を引く箇所
     （自前の `change-password` など）は `auth.identity_for(token)` をやめ、
     `auth.authenticate(token).await?` を使う。`require_auth` の後ろの
     `identity_for`・自前のロールガードはそのままでよい（照合のたびに今の値へ
     書き戻される。ガードは `req.extensions()` の `AuthenticatedSession` も読める）。
     初期セットアップで作ったアカウントをそのままログインさせる箇所は
     `issue_token` を `issue_account_token(SessionAccount { .. }, false)` に替える
     （世代の無いトークンは拒否される）。自分のパスワード変更の後、そのセッションを
     残すなら `new_epoch == stamp.auth_epoch + 1` のときだけ
     `auth.rotate_session_epoch(token, stamp, new_epoch)` を呼ぶ。
  5. **`src-tauri`**（banto の型では強制できないので、ここは移行手順どおりに行う）:
     ウィンドウのセッションを `Mutex<Option<UserIdentity>>` から admin-template の
     `DesktopSession`（`Account` / `AuthDisabledLocal` の enum）に替える。こうすると
     セッションを作る箇所・読む箇所がすべてコンパイルエラーになり、種類の選択と
     照合の通し忘れを型で拾える。`require_role` の先頭で `current_session` を通し、
     `Account` は `users.get_by_username` で読み直して行 id と `auth_epoch` が
     一致しなければキャッシュを消して `Unauthorized`、一致すれば**読み直した値**
     （今のロール）で判定する。`AuthDisabledLocal` はログイン不要モードが今も ON かを
     読み直す（OFF なら消す）。合成セッションを `id == 0` のような値で判定しない。
     キャッシュの書き換えは、読む前の値と比べてから行う。`auth_check`・
     `auth_identity` も同じ照合を通す `async` コマンドにし、`change_own_password` は
     新しい世代へキャッシュを付け替える（合成セッションからは `Forbidden`）。
     admin-template の `DesktopSession` / `current_session` / `require_role` /
     `change_own_password`（`apps/admin-template/src-tauri/src/lib.rs`）をそのまま
     写せる。組み込みサーバの `rest_auth` も手順 3 の状態で作る。
  6. **フロントのルートガード**（`@banto/admin-core` を更新すると `check()` が
     reject し得るようになる）: `(app)/+layout.ts` をコピーして持っている場合は、
     `check()` → `status()` → `enterPublicViewer()` の手書きの分岐を
     `resolveProtectedSession(getAuthProvider())` に置き換え、reject は
     `/login` への遷移にも閲覧者への切り替えにもせず、エラー画面と再試行にする
     （admin-template の `(app)/+layout.ts` と `routes/+error.svelte`、メッセージ
     キー `app.sessionCheckFailed.*`・`app.error.*` を写せる）。そのままでも
     reject は SvelteKit の既定のエラー画面になり、トークンは消えない。
     `check()` を直接呼ぶ他の画面（admin-template では `panel/[id]`）も reject を
     「未ログイン」と区別する。

- fix(auth): 失効したセッションで開いたままの SSE（`/api/events`）が通知を受け
  続けた問題を修正（#231、#204 の既知の制約）。開いているストリームは keepalive と
  同じ 15 秒（`banto_server::events::REVALIDATE_INTERVAL`）ごとにセッションを
  照合し直し、アカウントの削除・降格・パスワード変更/リセット・ログアウト・期限切れで
  失効していればストリームを終える（失効から最大 1 間隔）。DB が照合に答えられない
  ときは終えず、次の間隔で照合し直す（#204 の「照合できないときはセッションを残す」）。
  照合は 5 秒（`REVALIDATE_TIMEOUT`）で打ち切り、打ち切りも同じ扱い。次の照合は
  前の照合が終わってから 1 間隔後なので、照合が遅くても通知の配信は止まらない。
  照合中に自分のパスワード変更で付け替えられたセッションは、要求と同じ判断で残る。
  この照合はセッションの無操作期限（idle）を延ばさない（開いたタブが無操作の
  セッションを生かし続けない）。公開閲覧のセッションと
  `SessionValidation::DisabledNoRevocation` は DB を読まず、アカウントの変更では
  終わらない（トークン自体が終わったときだけ終わる）。照合するのは
  `SessionValidation::Lookup` のアカウントのセッションで、開いているストリーム 1 本
  につき 15 秒に 1 回の索引読み。**派生アプリの対応は不要**（`sse_route` の
  シグネチャは同じ。フロントの `createSseEventProvider` は、終わったストリームを
  従来どおり再接続し、失効したトークンは `401` になる）
  （[ADR-0014](docs/adr/0014-account-bound-session-revocation.md)）。

- fix(users): 管理者の同時降格・削除で管理者が0人になる競合を修正（#207）。
  SQLite・PostgreSQLの両方で判定から更新までをDBトランザクションで保護し、
  最後の管理者への変更を拒否する。REST・Tauri共通のユーザーサービスに適用。

- fix(auth-ui): username が `public` の通常アカウントを公開閲覧セッションと
  誤判定する問題を修正（#209）。トークン発行元が返す `publicViewer` 属性で区別し、
  通常アカウントは自身のロールで操作できる。合成セッションのパスワード変更も
  同名アカウントの有無によらず拒否する。サーバー・admin-core の型と、派生側に
  コピーした session store の変更を合わせて取り込む必要がある。

- test(grid): 絞り込み入力の矢印・Tab・Enterをセル操作から分離する既存修正
  （PR #224）に、専用の回帰検証を追加（#213）。入力・条件選択の標準キー操作と
  条件適用を保護し、文字カーソル・フォーカス移動はブラウザーE2Eでも確認する。

- fix(users-ui): ユーザーの保存待ち中に選択を切り替えても、古い応答が現在の
  編集対象を戻さないよう修正（#206）。同じユーザーを選び直した場合や新しい入力も
  保護し、パスワードリセットの応答も後続の選択へ反映しない。削除成功時は
  同じユーザーを選び直していても編集パネルを閉じ、別ユーザーの選択と入力は維持する。

- fix(grid): インライン編集を行IDに結び付け、一覧の再取得・並べ替え・前方行の削除で
  入力が別レコードへ保存される問題を修正（#205）。編集対象が一覧から消えた場合は
  編集を中止する。保存待ち中にクリックした別セルの選択は維持し、サーバー表示の
  編集対象検索は取得済み行に限定する。クライアント・サーバー表示とグループ化、
  遅延保存中の選択、疎配列の回帰テストを追加。
- fix(grid): 保存待ち中に別の編集を始めた際、先行保存の成功・失敗で新しい入力が
  消去・上書きされる問題を修正（#210）。保存結果と確定後の移動を編集セッションに
  結び付け、同じセルを開き直した場合も古い応答が干渉しないようにする。
- fix(grid): 非編集時のTab/Shift+Tabでフォーカスがグリッド内に閉じ込められる
  問題を修正（#211）。ブラウザー標準の順序で見出しボタン・行リンクを経て
  グリッド外へ移動できるようにする。セル間移動は矢印キーを使い、編集中の
  Tab/Shift+Tabによる確定・左右移動は維持する。
  移動先の見出し・絞り込み・行リンクのキー操作が選択セルの編集や移動に
  奪われないよう、セル操作をグリッド本体からのキーイベントに限定する。
- fix(grid): Enter・Tabでの編集確定やEscapeでの取消後にフォーカスが外れ、
  キーボードだけで連続操作できない問題を修正（#212）。保存待ち中に他の要素へ
  移動した場合や新しい編集を始めた場合は、そのフォーカスと選択を維持する。
  商品の更新APIが返した行を次の編集へ反映し、一覧再取得が遅れても異なる列の
  連続保存で直前の変更を古い値に戻さない。
  サーバー一覧の再取得結果はまとめて切り替え、途中の空配列で編集・選択が
  解除されることを防ぐ。旧世代の行と新しい取得結果は混在させない。

## [1.6.0] - 2026-09-14

**v1.6.0 — 設定画面のページ分割。** v1.5.0（同日）以降の PR #197・#198 をまとめる。
変更は app 層（`apps/admin-template`）のみで、**`@banto/*` パッケージと `banto-*`
クレートは版数が 1.6.0 に上がるだけで実装内容は v1.5.0 と同一**（公開 API の
変更なし。タグ参照で消費している側に追従作業は無く、v1.5.0 のまま留まっても
差は無い。テンプレートを再同期する派生アプリだけが対象）。後方互換の機能追加の
ため minor。

- 設定画面をカテゴリごとのルート `/settings/{appearance,account,connectivity,data,security}`
  に分割（共通レイアウトに sticky の左レール / 狭い画面は横タブ、`/settings` と
  非可視カテゴリは先頭の可視カテゴリへリダイレクト）。派生アプリは「ルートを足す」
  形で設定を拡張できる。段階 1（section コンポーネント分割、挙動不変）を経て実施
  （[docs/choiapp-feedback-2026-09.md §3.1/§3.2](docs/choiapp-feedback-2026-09.md)）。

- refactor(settings): 設定画面をカテゴリごとの section コンポーネントに分割
  （`AppearanceSection` / `AccountSection` / `ConnectivitySection` /
  `DataSection` / `SecuritySection` + `settings.css` + 共有ストア 2 本。
  `+page.svelte` 1,812 行 → 約 110 行）。挙動・DOM・e2e/visual は不変
  （`main` の outerHTML 比較で `settings-page` クラス追加とコンポーネント境界の
  コメントノード以外に差分なし）。scaffold の glass remover の anchor を
  `AppearanceSection.svelte` に追従（4 プリセット `--dry-run --strict` 通過）。
  ページ分割（カテゴリごとのルート化）の前段
  （[docs/choiapp-feedback-2026-09.md §3.1](docs/choiapp-feedback-2026-09.md)）。
- feat(settings): 設定画面の5カテゴリ（外観・言語/アカウント/サーバ・接続/
  データ管理/セキュリティ）を実ルート（`/settings/{appearance,account,
connectivity,data,security}`）に分割。`/settings` は先頭の可視カテゴリへ
  307 redirect、非可視カテゴリへの直接遷移も同様に先頭へ redirect（挙動:
  URL 構造が変わる - ブックマーク/ディープリンクは新しいパスを使うこと）。
  カテゴリナビは ≥1024px で左レール（sticky）・それ未満で横タブ。
  section コンポーネント/`settings.css`/ストアは移動なし。e2e smoke
  シナリオ 11 と visual/a11y の settings 系エントリを更新
  （[docs/choiapp-feedback-2026-09.md §3.2](docs/choiapp-feedback-2026-09.md)）。

## [1.5.0] - 2026-09-14

**v1.5.0 — 「表示専用アプリを配れる」リリース。** v1.4.0（2026-08-29）以降に
main へ積まれた PR #182〜#184・#191〜#195 と dependabot 更新をまとめる。
**JSON ワイヤは項目追加のみ**（`GET /api/auth/status` の `viewerPublic`、
`SystemInfo.metrics`）で既定挙動は不変だが、**Rust 消費側にはソース互換の
破壊がある**（下記「消費側への注意」の 4 点。いずれもテンプレートからコピーした
`src-tauri/src/lib.rs` / `core/src/rest/mod.rs` が直接触る箇所）。公開 API の
削除・改名は無く、v1.4.0（sqlx 0.9 移行）と同じくオーナー判断で **minor** とする
（1.x 系では「消費側の追従作業を CHANGELOG のリード文に明記した上で minor」
を運用とする。docs/publishing.md「バージョニング規約」参照）。主な内容:

- **閲覧公開モード**（#189、ADR-0012）: LAN 端末がログイン無しで `viewer` 固定の
  合成セッションを得て閲覧できる。書き込みは常にログイン必須。
- **CPU/メモリ使用率の共通 API**（#185、ADR-0013）: `sysinfo` を feature
  `system-metrics` 限定で採用。下流アプリは自前の `sysinfo` 実装を
  `SystemMetricsSampler` に寄せ替えられる。
- **`pnpm scaffold --preset display`**（#190）: items 雛形・管理画面・
  ダッシュボードを外し、ログイン不要 + 閲覧公開 + キオスク表示を初期状態にする
  表示専用アプリ向けプリセット。本体側にはキオスク表示トグル・初回起動 seed 機構・
  `banto.i18n` opt-out が既定 OFF で入る。
- チョイアプリ・フィードバック対応（#182〜#184）: 固定シェル・設定カテゴリ・
  ナビバッジ・「ログインなしで使い始める」。

**消費側への注意（Rust、v1.4.0 → v1.5.0 の追従作業）:**

- `banto_admin_services::settings::ServerSettings` に `viewer_public: bool` が増えた。
  構造体リテラルで組み立てている箇所（テンプレートの `server_apply`）は
  `viewer_public` を足すか `..Default::default()` を使う。
- `banto_server::routes::SystemInfo` に `metrics: Option<SystemMetrics>` が増えた。
  Tauri 側の `system_info` コマンドで組み立てている箇所は `metrics: None`（または
  `system-metrics` feature の `SystemMetricsSampler` で取得した値）を足す。
- `banto_server::routes::extra_auth_router(users, auth, audit, allow_setup)` が
  `(…, allow_setup, settings: SettingsService, status_extras: Option<AuthStatusExtras>)`
  になった。テンプレートどおり `settings.clone()` と `None` を渡す。
- `banto_server::routes::system_info_router(service, auth, audit)` が
  `(…, audit, metrics: Option<MetricsProbe>)` になった。`None` で従来どおり。
- `sysinfo` は Windows で `windows` 0.62 系を引く（`src-tauri` の 0.61 系と並存）。
  不要なら `system-metrics` feature を `default` から外す（README「オプション資産の
  削除」）。

- feat(scaffold): `pnpm scaffold --preset display`（#190、PR-D2、
  [docs/display-preset-plan.md](docs/display-preset-plan.md) §3.2）— カンバン/常設
  ダッシュボード/展示デモ向けの**表示専用アプリ**を1コマンドで作れるようにした。
  `minimal` の7資産に加えて、新 remover **`items`**（デモリソース一式: サービス層・
  REST・Tauri コマンド・マイグレーション・画面・ナビ・文言・`verify-architecture` の
  マニフェスト行）、**`adminPages`**（users / audit-log の**画面のみ**。サービス層・
  REST・Tauri は escape hatch として残す）、**`dashboard`**（`/dashboard` を外し
  ホームを `/monitor` へ）を削除し、唯一の「足す」工程 **`displayDefaults`** が
  `/monitor` ページ雛形（`$effect` + 世代トークンのポーリング例）・ナビ項目
  （`publicViewer: true`）と、PR-D1 で本体に入れたトグルの既定値の反転
  （`FIRST_BOOT_SETTINGS` = 認証無効 + 閲覧公開 + LAN 有効 / `KIOSK_DEFAULT` /
  `banto.i18n = "raw"`）を適用する。e2e は items/users 前提のスイート
  （`tests/smoke.spec.ts` の全シナリオ・`tests-public-viewer/`・`visual/`）を
  シナリオ1本（未ログインの `/` が `/monitor` に着く）に差し替える。
  `template-acceptance.yml` の `presets` matrix に `display` を追加。
  `template-scope.md` §3 は `items` を「デモリソース（display で削除可）」に再分類。
- fix(scaffold): attachments remover が `core/src/rest/tests.rs` を
  「M20 章から EOF まで」削っていたため、その後に追記された閲覧公開スイート
  （Issue #189）まで巻き添えで消えていたのを修正（終端マーカーで範囲を閉じた）。
  `minimal` / `standard` プリセットの `cargo test -p admin-template-core` に
  閲覧公開の 6 テストが戻る。
- feat(shell/scaffold): `--preset display`（#190）の準備 PR-D1 — テンプレート本体に
  既定 OFF のトグルを足す（[docs/display-preset-plan.md](docs/display-preset-plan.md)
  §2「display が足すものは先に本体のトグルにする」）。①初回起動 seed 機構
  `admin_template_core::first_boot::FIRST_BOOT_SETTINGS`（既定は空。`settings`
  テーブルが空のときだけ書き込む。`banto-serve` / Tauri 起動時に M11 の判定より前に
  実行）、②キオスク表示トグル（UI 設定 `shell.kiosk`。ON でサイドバー折り畳み既定・
  ヘッダーコンパクト（`--banto-shell-header-height-compact`）・全画面ボタン
  （ブラウザ Fullscreen API / Tauri `setFullscreen`、capability
  `core:window:allow-set-fullscreen` を追加）。設定画面「外観・言語」に追加、
  visual スペック 1 枚追加 — ベースラインは `visual-baselines.yml` で生成）、
  ③`apps/admin-template/package.json` の `banto.i18n = "keys" | "raw"`
  （`raw` で `raw-jp-in-app` と `check-i18n-nonempty` を理由付きでスキップ、
  conventions §13）、④items デモ区画に `// [scaffold:items] begin/end` マーカー
  （`rest/tests.rs` の items テストを 1 ブロックに集約。挙動不変、テスト件数不変）。
  付随: コマンドパレット remover の Header.svelte anchor をキオスク分岐に追従
  （3 プリセットの `--dry-run --strict` で確認）。

- feat(auth): 閲覧公開モード（viewer-public、#189）— 「認証を外す」を書き込み軸
  （従来の M11、デスクトップ限定）と閲覧公開軸（新設）に分けた。
  `server.viewerPublic` を ON にすると LAN クライアントは
  `POST /api/auth/public-viewer` で **`viewer` 固定の合成セッション**
  （ユーザー名 `public`、同時 256 まで・古い順に失効）を得てログイン無しで
  閲覧でき、`GET /api/auth/status` が `viewerPublic` を返す（アプリ固有
  フィールドを足す `AuthStatusExtras` フックも追加）。「認証無効 + LAN 有効」の
  排他は閲覧公開 ON のときだけ緩む（両方向のバリデーション）。フロントは
  `(app)` のゲートが合成セッションを透過的に取得し、`NavItem.publicViewer`
  の許可リスト（既定 dashboard / items）で画面を絞り、ヘッダは「ログイン」
  ボタンに切り替わる。書き込みは合成セッションから常に 403 + `denied` 監査。
  設計は [docs/viewer-public-plan.md](docs/viewer-public-plan.md)、方式選定は
  [ADR-0012](docs/adr/0012-lan-public-viewer-synthetic-session.md)、
  手順は [docs/recipes/no-login-app.md](docs/recipes/no-login-app.md)。
  `banto-serve` は `BANTO_VIEWER_PUBLIC=1` で seed 可。e2e に
  `public-viewer` プロジェクト（別ポートの 2 本目の banto-serve）を追加。

- feat(system-info): System Info カードに CPU/メモリ（ホスト total/used・
  スワップ・プロセス RSS・CPU%・論理コア数）を追加（Issue #185、
  [ADR-0013](docs/adr/0013-sysinfo-system-metrics-feature.md)）。`sysinfo`
  （`default-features = false, features = ["system"]`）を `banto-admin-services`
  の opt-in feature `system-metrics` に限定して採用 - conventions §3
  「依存を足す側の例外」の2件目（Paraglide/ADR-0005 に続く）。
  `banto_server::routes::SystemInfo` に `metrics: Option<SystemMetrics>` が
  増えるのみで既存フィールドは不変（後方互換、REST/Tauri 対称は維持）。
  テンプレート側（`admin-template-core`/`src-tauri`）は既定でこの feature を
  有効化（README「オプション資産の削除」に外し方）。実測バイナリ増分:
  `admin-template-core --bin banto-serve` の release ビルド（`embed-ui` 無し）
  で 8,996,864 → 9,048,576 bytes（+51,712 bytes、約 +50.5 KiB、+0.6%）。

- ci(visual): スクリーンショット比較の許容を比率から絶対値へ
  （`maxDiffPixelRatio: 0.001` → `maxDiffPixels: 250`）。比率は fullPage の総画素
  基準だったため縦長ページほど検知が甘く（dashboard 約4,700px / items 約1,300px）、
  実測 568〜828px のヘッダチップ追加が全ページで見逃されていた
  （[docs/choiapp-feedback-2026-09.md §6](docs/choiapp-feedback-2026-09.md)）。
  同一環境の再描画差分は 0px のため 250 はアンチエイリアス用のバッファ。
  以後 Playwright/Chromium/ランナー更新で描画が変わるとスイートは赤くなる
  （意図した挙動。差分確認後に `visual-baselines.yml` で再生成する）。

- ci(visual): ベースライン再生成を `--update-snapshots=all` に変更し、通過中の
  スナップショットも必ず作り直すようにした。既定の `changed` モードは失敗した
  分しか書き換えないため、`maxDiffPixelRatio`（0.001）に収まる小さな変更は
  ベースラインが古いまま残り、ズレが蓄積していた（実例: 2026-09 のヘッダ
  ステータスチップは dashboard/items/users で可視だったが許容内で通過し、
  ベースラインは存在しないヘッダを写したままだった）。許容量が fullPage の
  総画素比であることに由来する検知限界も `e2e/visual/README.md` に明記。

- feat(shell/settings): チョイアプリ・フィードバック対応
  （[docs/choiapp-feedback-2026-09.md](docs/choiapp-feedback-2026-09.md)）—
  ①ヘッダ/サイドバーを sticky 化（本文スクロールから独立）、②設定ページを
  5カテゴリ節 + カテゴリジャンプナビに再編（旧 Danger zone は解体し
  データ管理/セキュリティへ、警告色は `.danger-card` で維持）、③サイドバーの
  未確認更新バッジ（`NavItem.badgeResource` + `$lib/navBadges.svelte.ts`、
  smoke シナリオ 13 で SSE 実経路を検証）とヘッダのステータスチップ
  （デモ/ロール）を追加、④初回セットアップ画面（Tauri）に
  「ログインなしで使い始める」を追加 — `auth_config_apply` にユーザー0人の
  ブートストラップ窓を開け、synthetic session をその場で合成して再起動なしで
  M11 ログイン不要モードに入れる（オーナー承認済み、手順は
  [docs/recipes/no-login-app.md](docs/recipes/no-login-app.md)）。ログイン
  不要モードはチョイアプリの常態のためヘッダにチップは出さない（オーナー
  決定）。付随して `StatusBadge` info 変種のコントラスト不足（4.1:1）を
  `--banto-primary-hover` で修正。

## [1.4.0] - 2026-08-29

**v1.4.0 — `sqlx` 0.8→0.9 移行を主とするリリース。** オーナー判断により
**minor** とするが、消費側にとっては破壊的変更を含む: `banto_storage::connect_sqlite`/
`connect_postgres` の戻り値・`storage_error`/`not_found` が受ける `sqlx::Error` は
sqlx 0.9 の型になるため、消費側（banto-industrial 等）は同じ sqlx 0.9 系へ追従する
必要がある。スキーマ・SQL 文の意味・公開 API の形自体は変更なし。また sqlx 0.9 は
**rustc 1.94.0 以上**を要求するため、消費側のツールチェーンにも影響する。

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
- **UI 宣言境界と Discussions 運用の ADR 化 + チャート性能ベンチ**。UI 宣言は
  スキーマ駆動の漸進拡張・追加レンダラは REST
  クライアント境界と決めた判断を ADR-0009 に、Discussions を決定前検討専用と
  する運用を ADR-0010 に記録。roadmap §3 のバックログを「チャート性能
  エスカレーション梯子」（SVG 実測→サーバ側間引き→Canvas→WebGL→ネイティブ
  候補ウォッチ）へ拡張し、template-scope §4.2 に非スコープ2行（クロス
  レンダラ共通ウィジェット DSL / 画面エディタ）、conventions §12 に
  Discussion 参照の文法行を追加。`packages/charts/tests/trend.bench.ts` を
  新設し、ルートの `pnpm bench` を recursive 化した。
- **初期ルールの棚卸し（ADR-0011 + トリガー修正 + PG バックアップ案内）**。
  ADR-0011（git タグ配布）を新設して publishing.md の失効理由を修正し、
  roadmap §3 に実需の供給源3系統（外部採用者/banto-industrial/メンテナ実案件）
  の明示と、判断昇格の記録ルール・12ヶ月時限の運用則を追加した。
  template-scope には i18n 辞書層の反転記録（§4.3/§5）と §7 の2026-08 現況を
  追記し、maintenance-review-2026-08 §2.4 に反転プロトコルと「条件付き判断の
  棚卸し」の定型節を追加した。README（ja/en）に PostgreSQL のバックアップ
  運用（`pg_dump`/`pg_restore`）を案内し、設定画面のバックアップ節も
  PostgreSQL 利用時の出し分け表示に対応した。
- **AI 対話による機能作成の設計方向を記録**。タグ定義・トレンドグループ構成・
  帳票テンプレートをシリアライズ可能な DB データとして持ち、AI アシスタント
  （claude CLI サイドカー + MCP → REST）が対話で作成できるようにする設計方向を
  industrial-plan §5 に追記した（宣言データの範囲 = 対話で作れる範囲、
  ADR-0009 の境界と同一線）。

### 変更

- **`sqlx` を 0.8 系から 0.9 系へ移行**。banto-industrial 側の 0.9 移行が
  `banto-storage` の 0.8 固定でブロックされていたための追従。
  `QueryBuilder<'a, DB>` のライフタイム引数削除（`QueryBuilder<DB>`）に
  伴う内部シグネチャ変更と、`sqlx::query`/`query_as`/`query_scalar` が
  `impl SqlSafeStr` を要求するようになったことに伴う `sqlx::AssertSqlSafe`
  ラップ（動的に組み立てる SQL 文のうち、埋め込む断片が `Dialect`
  由来のプレースホルダ／内部定数のみで外部入力を含まないことを確認した
  箇所のみ）を追加。**破壊的変更**: `banto_storage::connect_sqlite`/
  `connect_postgres` の戻り値・`storage_error`/`not_found` が受ける
  `sqlx::Error` は sqlx 0.9 の型になる（消費側の追従が必要）。
  スキーマ・SQL 文の意味・公開 API の形は変更なし。
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

[unreleased]: https://github.com/tyaro/banto/compare/v1.7.1...HEAD
[1.7.1]: https://github.com/tyaro/banto/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/tyaro/banto/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/tyaro/banto/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/tyaro/banto/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/tyaro/banto/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/tyaro/banto/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/tyaro/banto/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/tyaro/banto/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tyaro/banto/compare/v0.1.2...v1.0.0
[0.1.2]: https://github.com/tyaro/banto/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/tyaro/banto/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tyaro/banto/releases/tag/v0.1.0
