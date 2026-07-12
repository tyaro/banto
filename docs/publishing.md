# パッケージ配布手順（M18 Phase C）

作成日: 2026-07-11。2026-07-12（M18 Phase C）に全面改訂: 配布方式を
「公開 npm レジストリ + crates.io」から「GitHub Packages（私設npm）+
Rust は git タグ参照」へ変更した。banto-industrial（別リポジトリ、
[industrial-plan.md](industrial-plan.md)）が本リポジトリの
`@banto/*` パッケージ/`banto-*` クレートを消費する前提条件。

**同日再改訂（最終決定）**: GitHub の organization 名 `banto` が取得
不能と判明（既存アカウントが存在）したため、npm 側も**レジストリを
使わず git 依存（サブディレクトリ参照）で配布する**方式に確定した。
`@banto/*` のパッケージ名はそのまま維持できる。詳細は次節。

## 決定: npm パッケージも git 依存で配布する（2026-07-12）

消費側（banto-industrial 等）は pnpm の git 依存 + `path:` 指定で
`@banto/*` を導入する。レジストリ・`.npmrc`・トークン設定は不要
（private リポジトリへの git 認証のみ。ローカルは gh/資格情報
マネージャ、CI は checkout 用 PAT）:

```sh
# ブランチ/タグ + モノレポ内サブディレクトリを指定（動作検証済み 2026-07-12）
pnpm add "github:tyaro/banto#v0.1.0&path:packages/admin-core"
pnpm add "github:tyaro/banto#main&path:packages/theme"
```

- インストール結果はパッケージ名 `@banto/admin-core` のままで、
  中身は `files: ["src"]` に従い `src/` + `package.json` + `LICENSE` のみ
  （pnpm は git 依存でも pack 相当の `files` フィルタを通す — 実測確認済み。
  つまり本ドキュメント後半の `files`/`LICENSE` 整備はこの方式でも有効）
- 参照の固定は Rust クレートと同じ **git タグ**（`vX.Y.Z`、下記タグ運用
  規約を共用）。npm/Rust が同一タグで揃うのはむしろ管理が単純
- GitHub Packages 案は**棚上げ**（`publishConfig` は package.json に残すが
  不活性。将来、外部配布や複数消費者で semver range 解決が必要になったら
  再検討 — その時はスコープ改名の判断も同時に行う）

## 方針転換の背景

industrial-plan.md §2 の権利の建付け（banto は自社著作物として保持し、
案件アプリには利用許諾で提供する）に合わせ、`@banto/*` パッケージは
**公開 npm レジストリではなく GitHub Packages の private/restricted
レジストリ**へ配布する。そのため各 `packages/*/package.json` の
`license` は `MIT` から **`UNLICENSED`** に変更した（私設配布・権利留保。
リポジトリ本体・`admin-template` アプリ・ドキュメントのライセンスは
引き続きルート [LICENSE](../LICENSE)（MIT）のまま — テンプレートとしての
利用許諾はそちらが担う。`packages/*` の配布物だけが別扱いになる、という
非対称な状態であることに注意。将来ルートライセンスの扱いも見直す場合は
別途判断が要る）。

## 前提: ソース配布のまま

Banto の `@banto/*` パッケージは**モノレポ内でソース直接参照**
（`package.json` の `exports` が `./src/index.ts` を指す）で使われており、
これを崩さない。ビルド成果物（`dist`）は生成せず、`files` フィールドで
`src/`（+ 自動同梱される `package.json`/`LICENSE`）のみを配布物に含める。
理由:

- 実際の利用形態（テンプレートをコピーして使う）に最も合う
- `admin-template` 側の `workspace:*` 参照・Vite/SvelteKitのビルドが
  そのまま動き続ける（`dist` 切り替えによる二重管理を避ける）
- ビルドパイプライン（`@sveltejs/package` 導入等）を追加しない分、
  M18 のスコープ（配布可能化の最小限）に収まる

各パッケージの `package.json` に以下を追加済み:

```jsonc
{
  "license": "UNLICENSED",
  "files": ["src"],
  "publishConfig": {
    "registry": "https://npm.pkg.github.com",
    "access": "restricted"
  }
}
```

`files: ["src"]` により `tests/`・`svelte.config.js`・`vite.config.ts`・
`tsconfig.json`（消費側には不要な開発時専用ファイル）はパッケージから
除外される。各パッケージには専用の `LICENSE`（"All rights reserved" 文言）
も追加した — pnpm はワークスペース内パッケージに `LICENSE` が無いと
**ルートの `LICENSE`（MIT）を自動的にタルボールへコピーする**ため、これを
入れておかないと `license: "UNLICENSED"` と矛盾する MIT 全文が配布物に
混入する（`pnpm publish --dry-run` で実際に確認・修正済み）。

## `@banto` スコープと GitHub Packages の制約（記録・決着済み）

> **2026-07-12 決着**: 下記の選択肢 1（org `banto` 作成）は **GitHub 上で
> 名前が既に取得されており不可能**と判明。選択肢 2（改名）は影響過大、
> 3（publish しない）では banto-industrial 連携が塞がるため、
> **第4の方式 = git 依存 + `path:` 指定**（冒頭の決定節）を採用した。
> 以下は経緯の記録として残す。

**GitHub Packages の npm レジストリは、スコープ名が GitHub の
ユーザー/Organizationアカウント名と一致している必要がある**
（`@NAMESPACE/PACKAGE-NAME` の `NAMESPACE` が公開先アカウント名そのもの。
GitHub公式ドキュメント準拠）。本リポジトリの所有者は GitHub ユーザー
`tyaro`（`origin` = `https://github.com/tyaro/banto.git`）であり、
`banto` という名前の GitHub org/user は存在しない。

つまり**現状のパッケージ名 `@banto/*` のままでは GitHub Packages に
publish できない**（スコープに対応するアカウントが無く、認証・権限解決の
時点で失敗する）。`pnpm publish --dry-run` はレジストリ認証を行わない
検証（ローカルのファイル構成チェックのみ）のため全パッケージで成功するが、
実際の `pnpm publish`（dry-runなし）はここで失敗する見込み。

**対応方針は未決定・本ドキュメントでは実施しない**（影響が大きいため
判断のみ提示、リネームは行わない）。選択肢:

1. **GitHub Organization `banto` を新規作成**し、そちらの権限で publish
   する（リポジトリ自体は `tyaro/banto` のままでも、publish 先アカウントを
   org にすれば `@banto/*` の名前を維持できる）。org 作成・招待管理という
   運用コストが増える
2. **npmスコープを `@tyaro/*` にリネーム**する。パッケージ名の変更は
   `admin-template` 内の全 import（`@banto/admin-core` 等、数十ファイル）・
   `package.json` の依存関係名・banto-industrial 側の将来的な参照を含む
   広範囲な変更になるため影響が大きい
3. **当面 publish しない**（社内はモノレポ内 `workspace:*` 参照のまま、
   banto-industrial 側の連携が必要になった時点で 1 か 2 を選ぶ）

banto-industrial 連携が必要になった時点で、上記いずれかを選定すること。

## 消費側の認証設定（GitHub Packages 案を再開する場合のみ・現在不要）

GitHub Packages の restricted access パッケージを `pnpm add`/`npm install`
するには、消費側リポジトリに `.npmrc` で scope→registry のマッピングと
`GITHUB_TOKEN`（`read:packages` 権限）が要る:

```ini
# .npmrc（消費側リポジトリ、例: banto-industrial）
@banto:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

## バージョニング規約

- 全パッケージ `0.1.0` から開始（統一済み）。相互依存は無い
  （`admin-template` からの依存のみ、パッケージ間の依存関係はゼロ）ため
  依存順の publish 制約はない
- **0.x の間**: `minor` = 破壊的変更、`patch` = 追加・修正
  （SemVer の 1.0 未満の慣例に合わせる。`0.1.0` → `0.2.0` は破壊的変更、
  `0.1.0` → `0.1.1` は後方互換の修正/追加）
- 1.0 到達後の規約は 1.0 到達時に別途定める

## 公開手順（GitHub Packages 案を再開する場合のみ・現在不要）

```sh
cd packages/<name>
pnpm publish --no-git-checks   # dist を生成しない（ソース配布のため build 不要）
```

パッケージ間の依存が無いため公開順序に制約はない。CI での自動 publish は
M18 の非スコープ（初回は手動、roadmap.md M18 節）。

## Rust クレート: git タグ参照（crates.io へは発行しない）

`banto-core` / `banto-storage` / `banto-server` は **crates.io へ発行しない**。
理由は npm 側と同じ（私設配布・権利留保の方針、industrial-plan.md §2）。
消費側（banto-industrial 等）は `Cargo.toml` で **git タグ参照**する:

```toml
[dependencies]
banto-core = { git = "https://github.com/tyaro/banto.git", tag = "v0.1.0" }
banto-storage = { git = "https://github.com/tyaro/banto.git", tag = "v0.1.0", features = ["sqlite"] }
banto-server = { git = "https://github.com/tyaro/banto.git", tag = "v0.1.0" }
```

private リポジトリの場合、消費側の Cargo/Git 認証（SSH鍵 or
`GIT_ASKPASS`/資格情報マネージャ）が別途要る。

### タグ運用規約

- タグ形式は `vX.Y.Z`（`workspace.package.version`、ルート `Cargo.toml`
  と揃える。現状 `v0.1.0` から開始）
- **マイルストーンマージ毎にタグを打たない**。banto-industrial 等の
  消費側が固定参照する必要がある**破壊的変更時のみ**タグを更新する
  （trait シグネチャ変更・`ListParams`/エラー型の変更など、
  `banto-core`/`banto-storage`/`banto-server` の公開APIに影響する変更）
- タグは **npm 側（`@banto/*` の git 依存）と共用**（2026-07-12 決定節）。
  したがって `@banto/*` パッケージの公開APIの破壊的変更もタグ更新の
  対象になる
- 0.x の間の破壊的変更判定・バージョン番号の上げ方は npm 側と同じ規約
  （`minor` = 破壊的変更、`patch` = 追加・修正）を踏襲する
- タグは軽量タグ（`git tag v0.1.0`）で可。CHANGELOG は当面省略
  （consuming 側が少数のうちは git log で足りる。必要になれば追加）

`admin_template_core`/`src-tauri` はアプリ固有のためタグ参照の対象外
（`admin-template` は banto リポジトリそのものをクローンして使う前提）。

## 公開しない選択

社内テンプレートとして使い続ける、または `@banto` スコープ問題（上記）が
未解決の間は、上記は不要。`workspace:*` のソース参照のままで、
`pnpm --filter admin-template tauri dev` / `build` はそのまま動く。
Rust クレートも `path` 依存のまま本リポジトリ内で完結する。
