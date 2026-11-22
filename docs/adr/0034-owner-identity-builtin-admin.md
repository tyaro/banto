# ADR-0034: 持ち主は再利用されない `accountId` で識別し、ログインなしの操作は組み込みの `admin` に帰属させ、初回セットアップを無くす（v8.0.0。互換不要・DB 作り直し）

> English: [0034-owner-identity-builtin-admin.en.md](0034-owner-identity-builtin-admin.en.md)

- 状態: Proposed（2026-11-22 起草。方針は同日のオーナー決定 1〜6・16〜19 と計画書 §10 の N1〜N6 で確定済み。
  この ADR で新しく決めた細目（決定 §3 の印の名前と載せる場所、§4 の予約名を渡す口、§7 の復旧の口）の承認待ち）
- 日付: 2026-11-22
- 関連: Issue #790・#778・#786 /
  [design/downstream-requests-2026-11-plan](../design/downstream-requests-2026-11-plan.md) §2・§4.1〜§4.4・§7（C0）・§10 /
  [ADR-0017](0017-credential-less-grant.md)（grant。本 ADR で §3・監査の項・ロックダウンの条件に追記する）/
  [ADR-0012](0012-lan-public-viewer-synthetic-session.md) / [ADR-0014](0014-account-bound-session-revocation.md) /
  [ADR-0031](0031-user-permissions-separate-axis.md) / conventions §1・§2・§6・§10・§11
- 対象コード: main `2a16f917`（v7.11.0 の後）。本文の `ファイル:行` はこの時点のもの

## コンテキスト

下流（banto-industrial）から 3 件の要望が来た。根は同じ所にある。

- **#790**: 持ち主を username で識別している所が 3 層にある（サーバーの `ui.{username}.{key}`、wire の
  `Identity.id`、画面の `account:${id}`。`packages/admin-core/src/sessionController.svelte.ts:207-217`）。
  username は再利用できるので、消したアカウントと同名で作り直した別人が、前の人の記憶（一覧の記憶・最近の
  コマンド・ドックの配置）を引き継ぐ。`users.id` は同じ DB の中では再利用されないが、DB を作り直すと 1 から
  数え直し、**バックアップの復元でも巻き戻る**（採番の履歴も DB の中にある）。
- **#778**: ログインなし（Tauri の `auth.disabled`、合成セッション `local`）と、管理者相当の grant の操作は、
  監査の actor が行を持たない固定の名前（`local` など）で残る。ユーザー一覧のどの行とも結び付かない。
- **#786**: ui-settings の条件付きの書き込み。保存先の表を作り直すので、持ち主の表し方を一緒に決める必要がある。

2026-11-22 にオーナーが前提を変えた（決定 16〜18）: **次のメジャー（v8.0.0）は互換不要で、DB は 1 から作り直す**。
既存の DB・既存のデータは読まない。組み込みのユーザーは小文字の `admin`。初回セットアップでユーザーもパスワードも
作らない。これで、既存の行への埋め込み・旧い保存の移し替え・既存の `Admin` / `admin` アカウントの検出と改名が
すべて要らなくなり、設計が小さくなった。この ADR はその決定と、計画書が「C0 の ADR で確定する」と残した細目を記録する。

## 決定

### 1. 持ち主の識別: `users.account_uid` と wire の `accountId`

- アカウントの作成時に、サービス層が 128 bit の乱数（OS の乱数源、文字列）を `users.account_uid` に入れる。
  一意制約。改名・ロールの変更では変えない。**秘密ではない**（認証にも認可にも使わない。記憶を仕切る名前）。
  アカウントの行では列の制約で必須、組み込みの行には持たせない（§2）。
- wire の `Identity`（`crates/banto-server/src/auth/session.rs:27`）に `accountId` を足す（REST の
  `/api/auth/identity`・ログインの応答、Tauri のコマンド）。アカウントのセッションでは `account_uid`。
  grant セッションと Tauri のログインなし（`local`）には載せない。
- 画面の `sessionOwnerKey`: `local` と grant の kind は今のまま。アカウントは **`acct:<accountId>`**。
  `accountId` が無ければ **`null`**（何とも一致しない。fail closed）。dev ビルドでは、account の kind で
  `null` を返したときに 1 回だけ警告する。
- **`Identity.id` は username のまま**（監査の主体・画面の表示・`acting_username` の呼び手を変えない）。
- `instance.id` と `Identity.instanceId` は置かない。DB の中の値は復元で採番と一緒に巻き戻り、復元後に作った
  別人が同じキーを得るため。
- サーバーの中で持ち主を指す所（`ui_settings`、監査の `actor_id`）は `users.id` を使う。同じ DB の行どうしは
  復元しても一緒に戻るので食い違わない。画面の側（ブラウザーの保存）は DB と一緒に戻らないので `account_uid` を使う。

### 2. 組み込みのユーザー `admin`

- 新しい DB には、migration が入れた行が最初から 1 つ居る: `username = 'admin'`（小文字）・`kind = 'builtin'`・
  `role = 'admin'`・`password_hash` は NULL・`account_uid` は NULL。
  - 列の CHECK で「`kind = 'builtin'` ⇔ `password_hash IS NULL`」「`kind = 'builtin'` ⇔ `account_uid IS NULL`」を守る。
  - 組み込みの行は 1 つだけ、を部分一意インデックス（`WHERE kind = 'builtin'`）で守る。
- **パスワードを持たず、ログインできない**。credential verifier は `kind = 'builtin'` を、ハッシュを見る前に拒む
  （列の CHECK と二重の守り）。拒むときも、居ないユーザーと同じダミーのハッシュ検証を回す（応答の時間で見分けさせない）。
  `admin` へのログインの試行は、居ないユーザーと同じ扱いで、REST のログイン試行の制限にそのまま掛かる。
- **改名・無効化・降格・パスワードの設定・削除をすべて禁じる**（サービス層で。conventions §2）。
  `change_password`・`reset_password` の SQL にも `kind = 'account'` を入れる。
- **最後の管理者のガード**（`ensure_admin_removal_allowed`、`crates/banto-admin-services/src/users.rs:313`）は
  組み込みの行を数えない（`role = 'admin' AND kind = 'account'`）。数えると、人の管理者を全部消せてしまう。
- 行の `role` は一覧の表示だけで、**認可の判定には使わない**。
- `users` を数える所（一覧・件数・CSV・バックアップの検証・最後の管理者のガード）は `kind = 'account'` を見る。
  **組み込みかどうかの判定は、どこでも名前ではなく `kind`**。
- 行にするのは `admin` だけ。`public` などほかの grant の固定 identity は行を作らない（§4 で予約名にする）。

### 3. ログインなしの操作の帰属: 明示の印 `audit_as_builtin_admin`

どのセッションを `admin` に帰属させるかは、id・name から推測しない（conventions §10）。配線の層が付ける印で決める。

- **印の名前（この ADR で確定）**: `GrantSpec`（`crates/banto-server/src/grant.rs:197`）に
  **`audit_as_builtin_admin: bool`** を足す。既定は `false`（`GrantSpec::new` が入れる）。
  名前に `audit` を入れるのは、効くのが**監査の帰属だけ**だと読めるようにするため（認可・ロール・持ち主のキーは変えない）。
- **載せる場所（この ADR で確定）**: 発行したセッションの `AuthenticatedSession`
  （`crates/banto-server/src/auth/session.rs:146`）に、同じ名前の `#[serde(skip)]` の欄として写す。
  計画書 §4.3 は「`SessionStamp` に写す」と書いたが、`SessionStamp`（`session.rs:53`）はアカウントの
  `account_id` と `auth_epoch` の組で、grant セッションでは `None`（`session.rs:137`）なので載せられない。
  印は wire に出さない（`Identity` の id・name・role と `kind` は変えない）。
- **監査を書く所は印だけを見る**。帰属を決める関数は 1 つにし、REST と Tauri の両方がそれを呼ぶ（conventions §1）。
  - 印つき: `actor_username = 'admin'`、`actor_id` = 組み込みの行の id（`kind = 'builtin'` で引く。名前でも
    固定の数でも引かない）。`actor_role` は**そのセッションの実際のロール**（viewer なら viewer）。
  - 印なしの grant（閲覧公開の `public` など）: 今のまま固定 id を書き、`actor_id` は NULL。
  - アカウント: `actor_username` は username、`actor_id` は `users.id`。
- **Tauri のログインなし（`local`）は `admin` に帰属させる**。Tauri の配線が、合成セッションに同じ意味の印を付ける
  （監査の actor は `local` から `admin` に変わる）。ui-settings の持ち主と `sessionOwnerKey` は `local` のまま
  （帰属は監査だけ）。
- 印を付けた grant に、ロールや `require_loopback_peer` の条件を banto は足さない（どの grant を `admin` の操作として
  残すかはアプリの判断）。管理者相当の grant の既定（loopback・小さい `max_sessions`）は ADR-0017 の帰結のまま。
- 監査の表に `actor_id`（NULL 可、外部キーなし。ユーザーを消しても監査は残す）を足す。`actor_username` の
  スナップショットは残す。

### 4. 予約名と、サービス層へ渡す口

- **予約するもの**: `admin` と、登録した grant の固定 id（`GrantSpec.identity.id`。テンプレートでは `public`、
  `grant.rs:83`）。アカウントの作成・改名で、**大小無視**で断る（`Admin`・`ADMIN` を作って見分けにくくするのを防ぐ）。
  比較は Rust の側で、両方を `to_lowercase()` して行う（`users.username` の一意制約は大小を区別するままで、
  DB の照合順序には頼らない）。`local` は予約しない（新しい持ち主の表し方では衝突しない）。
- **予約は見分けやすさのため**で、判定の根拠にしない（conventions §10 は変えない）。
- **渡す口（この ADR で確定）**: grant は派生アプリが足せる開いた集合で、サービス層は axum / tauri を知らない
  （conventions §2）。そこで:
  - `banto-admin-services` に、文字列の集合を包む小さい型 `ReservedUsernames` を置く。
  - `UsersService` に **`with_reserved_usernames(self, ReservedUsernames) -> Self`** を足す。既にある
    `with_permission_catalog`（`crates/banto-admin-services/src/users.rs:499`）と同じ、構築時の builder の形。
    `UsersService::new` の引数は変えない。
  - **`admin` はサービス層が自分で必ず予約する**（組み込みの行を知っているのはサービス層。配線が渡し忘れても外れない）。
    配線が渡すのは grant の固定 id だけ。
  - `GrantRegistry` に、登録済みの固定 id を列挙する読み取りの口を足す。配線の層（REST の `banto-serve` と
    Tauri の `lib.rs` の両方）が、それを `ReservedUsernames` に入れて渡す。
- **起動時の検査（N6）**: `UsersService` に、予約名と `kind = 'account'` の username を大小無視で照らす 1 文の検査を置き、
  両方の配線が起動時に呼ぶ。当たるのは「grant を後から足したら、その固定 id と同名のアカウントが既に居た」場合だけ。
  当たれば、名前と対処（そのアカウントを作り直すか、grant の固定 id を変える）を書いたエラーで**起動を止める**。
  改名の口は作らない。

### 5. 初回セットアップの撤去と、新しい DB の既定

- **初回セットアップでユーザーもパスワードも作らない**。新しい DB はユーザーを作らずに起動する。
- `auth.disabled` の既定を on に変える（キーが無いとき）。Tauri は起動すると合成セッション `local`
  （ロールは `auth.disabled_role`、既定 admin）でアプリに入る。ログインの画面も初回セットアップの画面も出ない。
- ユーザー管理が要る利用者だけが、ユーザー管理の画面からアカウントを作る。その操作の監査の actor は `admin`（§3）。
- 消すもの: `setup_first_user`・`is_initialized`（`users.rs:738`・`:706`）、REST の `POST /api/auth/setup`・
  `allow_setup`・status の `initialized`、Tauri の `auth_setup` と `auth_config_apply` の bootstrap の窓、
  画面の `setup` の分岐と `AuthProvider.setup`、`BANTO_ALLOW_SETUP`。「初期化済み」という状態そのものが無くなる
  （新しい DB は migration の後、いつでも使える）。

### 6. ロックダウンの条件と、安全の前提

- **安全の前提**（ADR-0017・spec M11 の考え方のまま）: ログインなしの間は、**その端末の前に居る人を信用する**。
  誰でも、合成セッションのロール（既定は admin）で操作できる。これが許されるのは、ログインなしの間は
  **LAN から書き込めない**から: 「`auth.disabled` かつ `server.enabled`」は閲覧公開（`viewer_public`）が on の
  ときだけ許す（`auth_server_combination_allowed`、`crates/banto-admin-services/src/settings.rs:237`。保存の両側と
  Tauri の起動時が同じ判定を使う）。開けられるのは読むだけの口。
  **既定がログインなしになるので、この組み合わせの規則が唯一の柵になる。緩めない**。
  LAN から操作させたい利用者は、先にアカウントを作ってロックダウンする。
- **アカウントが 0 の間の REST**: REST にログインなしの管理者のセッションは無い。ログインは必ず失敗し
  （アカウントが無い。組み込みは拒む）、初回セットアップの口も無いので、届くのは閲覧公開の読み取りと、
  派生アプリが足した grant だけ。認可の規則は両経路で同じ関数を通る（conventions §1）。
- **ロックダウン**（`auth.disabled` を off にする）は、**ログインできる管理者のアカウント
  （`kind = 'account' AND role = 'admin'`）が 1 つ以上あるときだけ**許す。無ければ `Validation` で断り、
  「先に管理者のアカウントを作ってください」と返す。
  - 判定と保存は同じロックの中で行い、ADR-0017 の流れ「保存 → 同じ関数の中で直後に grant の失効」の**手前**に判定を置く。
  - ロックダウンの後、ログインなしのセッションは失効する。grant の失効は ADR-0017 のまま: 発行の条件が
    ロックダウンで閉じる grant（派生アプリの試運転など）は、保存の直後に同じ関数の中で `revoke_grant_tokens(kind)` を呼ぶ。
- **最後の管理者のガードは、ログインなしの間も常に掛ける**（N5）。1 つ作った管理者は 0 に戻せないので、
  「判定の後・保存の前に最後の管理者が消える」競合が起きない。代わりに、ログインなしの間に作った最後の管理者は消せない。
- **ログイン必須なのに管理者のアカウントが 0 の DB**（アプリの操作では作れない。直接の編集だけ）は、起動時に
  明示のエラーで止める（N4）。黙ってログインなしへ戻さない（DB を書き換えられる人が認証を外せる形になる。fail-open）。

### 7. ヘッドレスの最初のアカウントと、復旧の口

- ヘッドレス（`banto-serve` だけ。PostgreSQL の運用・e2e）は Tauri のログインなしを持たないので、最初のアカウントを
  **DB に触れる人の CLI**（`banto-serve` の引数）で作る（N3）。ネットワーク越しの口にしない。
  監査は組み込みの `admin` の操作として残す。
  - パスワードは引数で受けない（プロセスの一覧とシェルの履歴に残る）。標準入力から読む。引数の細目は C2b で決める。
  - アカウントを作る処理そのものは `UsersService` の普通の作成を通す（検証・予約名・監査が同じ）。
- **復旧の口（この ADR で確定。N4 の残り）**: アカウントを作る CLI は **`banto-serve` だけ**に置く。
  **Tauri の実行ファイルには CLI を持たせない**。
  - ログイン必須なのに管理者が 0 の状態は、DB を直接書き換えたときにしか起きない。そこまで出来る人は、同じ DB を
    指して `banto-serve` の CLI を使える（SQLite のファイルでも PostgreSQL でも同じ）。バックアップの復元でも戻せる。
  - デスクトップの実行ファイルに「引数でアカウントを作る口」を足すと、認証を持つすべての配布物に、画面を通らない
    管理者の作成の口が増える。Windows の GUI の実行ファイルは標準入力・コンソールの扱いも別に要る。
  - 処理は core の関数 1 つにして `banto-serve` から呼ぶ。派生アプリが自分の実行ファイルに同じ口を足すことは妨げない。

### 8. grant セッションの ui-settings は kind をキーにする

- 保存先は新しい表 `ui_settings`。持ち主は文字列の列で、アカウントは `acct:<users.id>`、grant は
  **`grant:<kind>`**、Tauri のログインなしは `local`。grant のためにユーザーの行は作らない。
- 同じ kind の端末は設定を共有する（今の `ui.<identity.id>.*` と同じ性質。キーが固定 id から kind に変わる）。
  印つきの grant も `grant:<kind>` のまま（`admin` の持ち物にしない。帰属は監査だけ）。
- アカウントの行は別の列 `user_id` の外部キー（`ON DELETE CASCADE`）で守る。revision の形・条件付きの書き込みは
  #786 の範囲で、この ADR では決めない（計画書 §4.4）。

### 9. 互換不要・基準の作り直し

- **データの移行は無い**。既存の `0003_users.sql`・`0005_audit_log.sql` を新しい形に**書き換え**、
  `0014_ui_settings.sql`（表と、組み込みの `admin` の行の INSERT）を足す（SQLite・PostgreSQL の両方。rule 11 の
  対称は保つ）。ほかの 11 本とファイル名・連番は変えない。
- conventions §11 の「リリース済みの migration は追記のみ」を **1 回だけ**破る。`pnpm verify:migrations` には、
  タグ `v7.11.0` と比べるときにこの 4 ファイルの変更だけを許す、今回かぎりの許可を書く（C1）。
  v8.0.0 のタグの後は、また追記のみ。
- **旧版の DB・バックアップは読まずに、明示のエラーで断る**。
  - 起動: 0003 の本文が変わるので、sqlx が適用済みの checksum の不一致（`VersionMismatch`）で止まる。0014 は連番の
    最後なので、新しい migration が旧版の DB に当たる前に止まる。`db::run_migrations`
    （`apps/admin-template/core/src/db.rs`）がこれを「この DB は v8.0.0 より前の版のものです。読めません。
    DB を作り直してください」に写す。
  - 復元: 置き換えの**前**に断る。`REQUIRED_TABLES`（`crates/banto-admin-services/src/backup.rs:151`）に
    `ui_settings` を足す。旧版のバックアップは「必須の表が無い」で予約の時点に拒まれる。

## 検討した代替案

- **持ち主のキー**
  - **採用: アカウントごとの乱数 `account_uid`。** 復元にも作り直しにも強い。
  - 不採用: `users.id` をそのまま使う。DB の作り直しと復元で同じ値が別人に渡る。
  - 不採用: `instance.id` + `users.id`。`instance.id` を DB に置くと復元で一緒に巻き戻り、同じ穴が残る。
  - 不採用: `Identity.id` を username から替える。監査・表示・`acting_username` の呼び手が全部変わる。
- **組み込みのユーザー**（N1）
  - **採用: ログインできない行。ログインなしの操作の記録先だけ。初回セットアップも無くす。**
  - 不採用: パスワードでログインできる `admin`（初回セットアップでパスワードを決める）。既知の名前がパスワードの
    的になり、最後の管理者のガード・verifier・`password_hash` に組み込みの行のための分岐が要る。
  - 不採用: 名前を `Admin` や内部名 `builtin.admin` にする。決定 17 で小文字の `admin` に確定。
- **帰属の決め方**
  - **採用: `GrantSpec` の明示の印を、セッションに写す。**
  - 不採用: 固定 id やロールから推測する（「admin ロールの grant は `admin`」など）。conventions §10 に反し、
    派生アプリが grant を足すと黙って帰属が変わる。
  - 不採用: 印を `SessionStamp` に載せる。grant セッションは `SessionStamp` を持たない（§3）。
  - 不採用: 印の名前を `acts_as_builtin_admin` などにする。認可も変わるように読める。
- **予約名を渡す口**
  - **採用: `UsersService::with_reserved_usernames`（builder）。`admin` はサービス層が自分で予約。**
  - 不採用: `UsersService::new` の引数に足す。呼び手（試験を含む）を全部書き換える。渡し忘れは builder でも
    起きるが、`admin` だけは外れない形にしたので、残る穴は grant の固定 id の見分けにくさだけ。
  - 不採用: 作成・改名の操作ごとに一覧を引数で渡す。REST と Tauri の呼び手が別々に組み立てることになり、対称が崩れやすい。
  - 不採用: サービス層が `GrantRegistry` を読む。`banto-admin-services` が `banto-server` に依存する（conventions §2）。
- **migration の形**（N2）
  - **採用: 基準を作り直す（0003・0005 を書き換え、0014 を足す）。** 旧版の DB を sqlx が自分で断り、
    列の制約を最初から正しく置ける。
  - 不採用: 0014 を足すだけ。規約は破らないが、旧版の DB に 0014 がそのまま当たるので自前の検査が要り、
    SQLite の `ALTER TABLE` では `account_uid` を必須にできず、`password_hash` の `NOT NULL` も外せない。
  - 不採用: 全部を 1〜数本に畳み直す。scaffold・レシピ・README がファイル名を引いている所を全部直すことになる。
- **ヘッドレスの最初のアカウント**（N3）
  - **採用: DB に触れる人の CLI。**
  - 不採用: ループバックだけに出す管理者相当の grant をテンプレートに入れる。プロキシの後ろではループバックの
    条件が守りにならない（ADR-0017 §6）。
  - 不採用: `BANTO_ALLOW_SETUP` を残す。ネットワーク越しに最初の管理者を作れる口が残る。
- **ログイン必須で管理者が 0 の DB**（N4）
  - **採用: 起動を止める。復旧は `banto-serve` の CLI。**
  - 不採用: 黙ってログインなしへ戻す（fail-open）。
  - 不採用: Tauri の実行ファイルにも CLI を持たせる（§7）。

## 帰結

- **v8.0.0 は破壊的変更**。派生アプリは `0003_users.sql`・`0005_audit_log.sql` を差し替え、`0014_ui_settings.sql` を
  足し、**DB を作り直す**（移行の口は無い）。自分の migration を 0014 以降の番号で足している派生アプリは番号をずらす。
- `Identity` を自分で組み立てている派生アプリは `accountId` を載せる。載せないと持ち主のキーが `null` になり、
  持ち主つきの記憶が保存も復元もされない（黙って他人に渡すよりよい）。古い `account:` のキーの localStorage は残骸になる。
- 初回セットアップが無くなる（画面・REST の口・Tauri のコマンド・`AuthProvider.setup`・`BANTO_ALLOW_SETUP`）。
  新しい DB の既定がログインなしになる。ユーザー一覧に `admin` が 1 行居る。`admin`（大小無視）と grant の固定 id の
  アカウントは作れない。Tauri のログインなしの監査の actor が `local` から `admin` に変わる。
- **組み込みの行が「ログインできる管理者」になる経路を作らない**。パスワードのリセット・CSV の取り込み・リストア・
  権限の個別付与（ADR-0031）・自動ログインの各経路を、実装 PR で 1 つずつ確かめて試験に入れる。
- **LAN との組み合わせの規則が唯一の柵**。起動時・保存の両側・`banto-serve` の 3 か所で、ログインなしの間に
  REST から書き込めないことを試験で固定する。
- 監査の actor が `admin` の行は、Tauri のログインなしと、印つきの grant の両方から来る。どちらの経路かは
  actor からは分からない（`actor_role` は実際のロール）。
- grant を足す派生アプリは、`audit_as_builtin_admin` を付けるかを grant ごとに決め、固定 id が既存のアカウントの
  名前と当たらないことを確かめる（当たれば起動が止まる）。
- [ADR-0017](0017-credential-less-grant.md) に追記する（§3 の acting id、監査と ui-settings の項、ロックダウンの条件）。
- 実装は計画書 §7 の PR に分ける: C1（基準の作り直し・`account_uid` の採番・`kind` での数え直し）、
  C2（組み込みの行の保護・帰属の印・予約名）、C2b（初回セットアップの撤去・ロックダウンの条件・CLI）、
  C3（`accountId` を wire に載せる）、C4・C5（ui-settings）。この ADR が `Accepted` になるまで実装を始めない。
