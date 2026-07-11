# パッケージ配布手順（M18 Phase C）

作成日: 2026-07-11。2026-07-12（M18 Phase C）に全面改訂: 配布方式を
「公開 npm レジストリ + crates.io」から「GitHub Packages（私設npm）+
Rust は git タグ参照」へ変更した。banto-industrial（別リポジトリ、
[industrial-plan.md](industrial-plan.md)）が本リポジトリの
`@banto/*` パッケージ/`banto-*` クレートを消費する前提条件。

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

## `@banto` スコープと GitHub Packages の制約（重要・未解決）

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

## 消費側の認証設定（publish 可能になった場合）

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

## 公開手順（publish 可能になった場合）

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
