# レシピ: LAN アクセス（組み込み Web サーバ、M6）の運用

作成日: 2026-10-08（README「LANアクセス」から切り出し。トラックB＝アプリ作者向け）

デフォルトは無効（`invoke()`専用、攻撃面ゼロ）。設定画面から有効化すると、
同一LAN内の他端末のブラウザから同じ管理画面をREST API + SSEで利用できる
（仕様 §11）。本書は有効化・閲覧公開・開発用バイナリ・セキュリティ注意・
TLS 終端・PWA の運用手順をまとめる。構成図は
[architecture-overview.md §2](../architecture-overview.md)、起動・ログイン・閲覧公開の
フローは [architecture-flows.md](../architecture-flows.md)。

## 有効化手順

1. デスクトップアプリの設定画面 →「LANアクセス（組み込みWebサーバ）」で
   トグルをON、バインドアドレス（`0.0.0.0`でLAN公開）・ポート番号を設定し
   「保存して適用」。
2. 表示されたURL/QRコードから、同一LAN内の他端末のブラウザでアクセスし、
   初回起動時（Tauriウィンドウまたはこのブラウザ自身）に作成した
   管理者アカウントでログイン。まだアカウントがなければ初回セットアップ
   画面が表示される。

## 閲覧公開（ログイン無しで LAN から閲覧を許可）

表示専用アプリ（アンドン・常設ダッシュボード・展示デモ）向けに、LAN 上の
端末が**ログイン無しで閲覧画面と読み取り API だけ**を使える「閲覧公開」を
用意している（Issue #189、[ADR-0012](../adr/0012-lan-public-viewer-synthetic-session.md)）。
設定画面「サーバ・接続」→「ログイン無しで LAN から閲覧を許可する（閲覧公開）」
を ON にして「保存して適用」。

- LAN のブラウザは `/dashboard` を開くだけで **`viewer` ロールの合成
  セッション**（ユーザー名 `public`）に入る。このセッションは
  `POST /api/auth/grant/publicViewer` で受け取る（資格情報なしのセッション発行
  「grant」の 1 種類目、[ADR-0017](../adr/0017-credential-less-grant.md)）。ヘッダの「ログイン」から通常の
  アカウントでログインすれば編集系 UI に切り替わる。
- 書き込み（作成・更新・削除・インポート）は従来どおりログイン必須。合成
  セッションからの書き込みは REST が 403 で拒否し `denied` として監査する。
- 公開される画面は `src/lib/navigation.ts` の `publicViewer: true` を付けた
  項目だけ（テンプレート既定は dashboard と items）。データ面の境界は RBAC
  の `viewer` ロールそのもの（viewer に見せたくない読み取りは閲覧公開ではなく
  ロール床で絞る）。
- ログイン不要モード（M11）と LAN アクセスは閲覧公開 ON のときだけ併用できる
  （書き込みはデスクトップだけ、閲覧は LAN 全体、が表示専用アプリの標準形。
  手順は [no-login-app.md](no-login-app.md)）。
- **LAN 上の誰でも閲覧できる**設定なので、下記「セキュリティ注意」の信頼できる
  LAN 限定の前提はそのまま。

## `banto-serve`（Tauri不要の開発用バイナリ）

```sh
pnpm --filter admin-template build   # apps/admin-template/build を生成
cargo run -p admin-template-core --bin banto-serve --features embed-ui
```

Tauriを起動せずにREST + 静的配信のフルスタックを試せる（`--features
embed-ui`を省略すると組み込みのプレースホルダページを返す）。環境変数:

| 環境変数                | 既定                    | 内容                                                                                                                                                                                                                    |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `8721`                  | 待ち受けポート                                                                                                                                                                                                          |
| `BANTO_BIND`            | `0.0.0.0`               | バインドアドレス                                                                                                                                                                                                        |
| `BANTO_DB`              | `./banto-dev.sqlite3`   | DB。`postgres://` URL にすると PostgreSQL 経路（[database-backup.md](database-backup.md)）                                                                                                                              |
| `BANTO_ATTACHMENTS_DIR` | （SQLite では使わない） | `BANTO_DB` が PostgreSQL のとき**必須**。添付ファイルの保存先の親ディレクトリで、DB ごとに `pg_<ホスト>_<ポート>_<DB名>_<ハッシュ>` のサブディレクトリを作る。SQLite では使わず、添付は DB ファイルの隣の `attachments` |
| `BANTO_VIEWER_PUBLIC=1` | 未設定                  | 起動時に閲覧公開を ON に seed する。e2e とローカル確認用                                                                                                                                                                |
| `BANTO_ALLOW_SETUP=1`   | 未設定（403）           | `POST /api/auth/setup`（初回セットアップ）を有効にする。dev/e2e 用（`e2e/playwright.config.ts`）                                                                                                                        |

詳細（PostgreSQL は `--features postgres` でのビルドが必要、`BANTO_VIEWER_PUBLIC` は
設定を永続化するので外しても OFF に戻らない等）は
`apps/admin-template/core/src/bin/banto-serve.rs` 冒頭の doc コメントが一次情報。

## `embed-ui` フィーチャー

- `admin-template-core`はデフォルトでフロントエンドを埋め込まない
  （プレースホルダページのみ）。`pnpm --filter admin-template build`で
  フロントをビルドしてから`--features embed-ui`を付けて再ビルドすると、
  実際のSvelteKitビルドが埋め込まれる。
- src-tauri（デスクトップアプリ本体）も同名のパススルーfeatureを持つ:
  `tauri build --features embed-ui`（または`cargo build -p admin-template
--features embed-ui`）を指定しないと、LANアクセス経由のブラウザには
  プレースホルダページしか返らない（Tauriウィンドウ自体の表示には影響
  しない — Webview は常にバンドルされた実フロントを表示する）。

## セキュリティ注意

> ⚠️ **LANサーバ機能は標準ではHTTP（平文）です。** ログイン情報・セッション
> トークン・業務データが暗号化されずにネットワークを流れます。公衆Wi-Fi・
> ゲストネットワーク・信頼できない端末が混在するネットワークでは有効化
> しないでください。拠点をまたぐ利用やVPN外での利用が必要な場合は、下記の
> リバースプロキシでTLS終端してください。

- v1は「信頼できるLAN内でのHTTP + トークン認証」という割り切り。TLSは
  未実装（v2以降で検討、[ADR-0003](../adr/0003-tls-via-reverse-proxy.md)）。
  **信頼できるLAN以外では有効化しないこと。**
  HTTPのみのため、ログイン情報やセッショントークンは平文でLAN内を流れる。
- 認証はargon2id資格情報ストア + 初回セットアップ実装済み
  （`crates/banto-admin-services/src/users.rs`。固定パスワードのデモ実装
  ではない）。セッショントークンは絶対8時間/アイドル1時間で自動失効し、
  ログインは5回連続失敗で60秒ロックアウトされる（いずれも
  `banto-server`の`TokenPolicy`/`RateLimitPolicy`で変更可能）。
  Tauriウィンドウのセッションと LANブラウザ側（REST/SSE）のセッションは
  独立したトークン空間。
- セッショントークンはインメモリ保持のため、**サーバ（デスクトップアプリ/
  常駐プロセス）を再起動すると全セッションが失われ、再ログインが必要**になる。
  「ログイン状態を保持（Remember me）」の30日/7日は無停止運用時の上限であり、
  端末を毎日再起動する運用ではその都度セッションが切れる（v1 の受容済み仕様。
  [roadmap.md](../roadmap.md) の未決事項一覧を参照）。

## 同時書き込みとSQLite（WAL）

デスクトップアプリと組み込みサーバは**同一プロセス内で動き、単一の
SQLite コネクションプールを共有する**（Tauriコマンドと REST ハンドラは
同じ `ItemsService` 等 = 同じプールへの `Clone` ハンドルを使う）。したがって
Tauriウィンドウからの書き込みと LANブラウザからの書き込みは**その1つの
プールでシリアライズ**され、プロセスをまたぐ書き込み競合は起きない。DBは
**WAL モード**（`crates/banto-storage/src/sqlite.rs`）で開くため、読み取りは
書き込みをブロックせず、複数の LAN クライアントが同時に閲覧しても問題ない
（SQLite の WAL は「同時に多数の読み取り + 1つの書き込み」を許す）。

注意: 同じ SQLite ファイルに**別プロセスから同時アクセスしない**こと
（例: 稼働中のアプリと並行して 2つ目の `banto-serve` や外部ツールを同じ
DB に向ける）。WAL が保証するのは単一ライタまでで、別プロセスの2つ目の
ライタは `SQLITE_BUSY` を招きうる。バックアップ/リストアはこのシリアライズ
の一部として同一プロセス内で扱う（M17、`VACUUM INTO`。
[database-backup.md](database-backup.md)）。

## リバースプロキシでのTLS終端（Caddy 例）

TLSが必要な環境では、Banto自体はHTTPのまま `127.0.0.1` バインドに絞り、
前段のリバースプロキシでTLSを終端する（[ADR-0003](../adr/0003-tls-via-reverse-proxy.md)）。
[Caddy](https://caddyserver.com/) なら自己署名/内部CA証明書の自動発行込みで
以下の数行で済む:

```
# Caddyfile — https://<このマシンのホスト名>:8443 で待ち受けて Banto へ転送
{
	local_certs   # 内部CAで自動発行（社内CA/正規証明書があればこのブロックは不要）
}

:8443 {
	reverse_proxy 127.0.0.1:8721
}
```

設定画面のバインドアドレスは `127.0.0.1 のみ` にする（`0.0.0.0` のままだと
プロキシを迂回した平文HTTPでも届いてしまう）。

注意: プロキシ経由では、Bantoから見た接続元が全部プロキシのIP
（127.0.0.1）になるため、ログインレート制限の per-IP 次元
（`banto-server` の `RateLimitPolicy.max_ip_failures`、既定20回/60秒）が
**全クライアント合算**で発火するようになる。クライアント台数が多い環境では
しきい値を引き上げるか、per-account 次元（既定5回）だけに頼る設定を検討
する（`X-Forwarded-For` の信頼はv1では未実装 — 偽装可能なヘッダを無条件に
信じないための割り切り）。

### プロキシ越しの grant（資格情報なしのセッション発行）の運用ルール

資格情報なしのセッション発行（grant、[ADR-0017 §6](../adr/0017-credential-less-grant.md)）を
プロキシ越しに使う場合の運用ルール（Banto が技術的に強制できるものではない。
同一ホストのプロキシの後ろでは接続元がすべてループバックに見えるため、
`require_loopback_peer` は何も守らない）:

- 外部公開（プロキシから外へ出す）の前に、管理者相当の grant（派生アプリの
  試運転など）はロックダウンしておく。
- 再試運転の間も `/api/auth/grant/{kind}` をプロキシから外部へ公開しない
  （プロキシ側でそのパスを遮断するか、試運転中はプロキシを止める）。

プロキシが `Host` を書き換える設定や共有キャッシュを前段に置く構成での CSP の注意は
[conventions.md §6](../conventions.md)（`request_is_loopback_local` の項）。

## PWA（ホーム画面に追加 / インストール）

LANブラウザ配信は Web マニフェスト（`static/manifest.webmanifest` + アイコン）
を同梱しており、ブラウザから「ホーム画面に追加」/「インストール」でアプリの
ように起動できる（工場のタブレット等での常用向け）。オフライン対応（Service
Worker）は入れていない。**ただしブラウザはセキュアコンテキストでしかインストールを
提供しない** — 標準の平文HTTP LAN 配信では機能せず、上記のTLSリバースプロキシ
配下・`localhost`・GitHub Pages デモ（HTTPS）でのみインストール可能になる。
アプリ名を変えるときは [`rename.mjs`](../../scripts/rename.mjs) が manifest の
`name`/`short_name` も追随させる（アイコン画像は差し替えが必要 — rename が
触らない資産。[rename.md](rename.md)）。
