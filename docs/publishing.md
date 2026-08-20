# パッケージ配布手順（M18 Phase C）

作成日: 2026-07-11。2026-07-12（M18 Phase C）に全面改訂: 配布方式を
「公開 npm レジストリ + crates.io」から「npm も Rust も **git タグ参照**」へ
変更した。banto-industrial（別リポジトリ、
[industrial-plan.md](industrial-plan.md)）が本リポジトリの
`@banto/*` パッケージ/`banto-*` クレートを消費する前提条件。

> 決着済みの経緯（UNLICENSED 化と取り消し・GitHub Packages 案の棚上げ・
> `@banto` スコープ制約・再開時の手順）は
> [history/publishing-github-packages-2026-07.md](history/publishing-github-packages-2026-07.md)
> に切り出した。本書は現行の規範のみを保持する。

## 決定: npm パッケージも git 依存で配布する（2026-07-12）

GitHub の organization 名 `banto` が取得不能（既存アカウントが存在）のため、
npm 側も**レジストリを使わず git 依存（サブディレクトリ参照）で配布する**。
`@banto/*` のパッケージ名はそのまま維持できる。消費側（banto-industrial 等）は
pnpm の git 依存 + `path:` 指定で導入する。レジストリ・`.npmrc`・トークン設定は
不要（private リポジトリへの git 認証のみ。ローカルは gh/資格情報マネージャ、
CI は checkout 用 PAT）:

```sh
# ブランチ/タグ + モノレポ内サブディレクトリを指定（機構は 2026-07-12 に動作検証済み）
pnpm add "github:tyaro/banto#v1.3.0&path:packages/admin-core"
pnpm add "github:tyaro/banto#main&path:packages/theme"
```

- インストール結果はパッケージ名 `@banto/admin-core` のままで、
  中身は `files: ["src"]` に従い `src/` + `package.json` + `LICENSE` のみ
  （pnpm は git 依存でも pack 相当の `files` フィルタを通す — 実測確認済み。
  `LICENSE` はルートの MIT を pnpm が自動同梱する）
- 参照の固定は Rust クレートと同じ **git タグ**（`vX.Y.Z`、下記タグ運用
  規約を共用）。npm/Rust が同一タグで揃うのはむしろ管理が単純
- GitHub Packages 案は**棚上げ**（`publishConfig` は package.json に残すが
  不活性。将来、外部配布や複数消費者で semver range 解決が必要になったら
  再検討 — その時はスコープ改名の判断も同時に行う。経緯と再開手順は上記
  history 文書）

## 消費実績と消費側の手順

2026-07-13、別リポジトリが本リポジトリの `v0.1.1` を実際に消費し、npm git
依存（`&path:` 指定）・Rust git タグ依存とも `pnpm install`/`cargo check`/
`cargo test --workspace` が通ることを確認した。この配布形態は動作する。

**消費側で必要になる作業の一覧は README の
[「4. 別リポジトリから git 依存として消費する場合」](../README.md#4-別リポジトリから-git-依存として消費する場合)**
にまとめてある（npm/Rust の依存書き換え、`[workspace.package].repository`、
lint 設定の持ち込み、e2e スイートの移植など）。消費者はアプリ作者なので、
手順そのものはトラックB（README）側が正となる。

このとき最初に踏んだ罠が2点あり、どちらも既に本体で手当て済み:

- **ソース配布パッケージが Vite の依存事前バンドルで壊れる**（issue #150）→
  テンプレートの `apps/admin-template/vite.config.ts` に
  `optimizeDeps.exclude` を同梱して解決。判断の経緯は
  [ADR-0007](adr/0007-derived-app-dev-optimizer-exclude.md)。なお
  「`packages/*/package.json` に `svelte` フィールドを足せば自動除外される」
  という案は**採らない** — `svelte` export condition は既に付いており、
  ADR-0007 の調査どおり、それこそが `vite-plugin-svelte` に
  「Svelte ライブラリなので事前バンドルしてよい」と判断させる原因側だった。
- **同一DBに対する `sqlx::migrate!` の二重使用**（`_sqlx_migrations` が
  DB 全体で1つしか無いことによるバージョン衝突）→ README
  「2. デモコンテンツ（`items`）を自リソースに差し替える」の注記を参照。

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

**消費側 dev の注意（issue #150 / [ADR-0007](adr/0007-derived-app-dev-optimizer-exclude.md)）**:
ソース配布された `.svelte.ts`（runes モジュール）は、派生アプリでは node_modules
実体になり、Vite dev の依存オプティマイザが preprocess せず `svelte.compileModule`
に渡すため `import type` 等で 500 になる。消費アプリの Vite 設定で当該 `@banto/*` を
`optimizeDeps.exclude` する必要がある（テンプレートは `apps/admin-template/vite.config.ts`
で設定済み。`.svelte.ts` を持つのは admin-core/dock-svelte/forms/grid-svelte/tree-svelte）。
`pnpm build`（`isBuild` で prebundle 無効）と `pnpm check`（Vite 非経由）はこの経路を
通らないため無影響。従来この配布検証は `pnpm publish --dry-run`（pack 構成）までで、
dev optimizer 経路は含まれていなかった。

各パッケージの `package.json` の現行設定:

```jsonc
{
  "license": "MIT", // リポジトリ全体でルート LICENSE（MIT）に統一
  "files": ["src"],
  "publishConfig": {
    // GitHub Packages 案の名残（不活性のまま残置）
    "registry": "https://npm.pkg.github.com",
    "access": "restricted"
  }
}
```

`files: ["src"]` により `tests/`・`svelte.config.js`・`vite.config.ts`・
`tsconfig.json`（消費側には不要な開発時専用ファイル）はパッケージから
除外される。package-local の `LICENSE` は置かない（pnpm がルートの
MIT を自動同梱する。UNLICENSED 期に置いていた経緯は history 文書）。

## バージョニング規約

- 現行バージョンは **v1.3.0**（全 `@banto/*` パッケージ・`banto-*` クレート・
  `tauri.conf.json`・git タグで統一）。バージョンとタグの整合は
  `pnpm check:versions`（CR-7、`scripts/check-versions.mjs`）が機械検査する
- 相互依存は無い（`admin-template` からの依存のみ、パッケージ間の依存関係は
  ゼロ）ため依存順の publish 制約はない
- **0.x の間（〜0.1.2、履歴）**: `minor` = 破壊的変更、`patch` = 追加・修正
  （SemVer の 1.0 未満の慣例）
- **1.0.0 以降（現行）**: 標準の SemVer。`major` = 破壊的変更、
  `minor` = 後方互換の機能追加、`patch` = 後方互換の修正。v1.0.0 は v1
  スコープ（仕様 M0〜M9 + roadmap M10〜M24）完了に伴う**安定版宣言**として
  発行した（0.1.2 からの破壊的変更はなし。2026-07-28）

## Rust クレート: git タグ参照（crates.io へは発行しない）

`banto-core` / `banto-storage` / `banto-server` / `banto-admin-services` /
`banto-attachments` は **crates.io へ発行しない**。
理由は npm 側と同じ（私設配布・権利留保の方針、industrial-plan.md §2）。
消費側（banto-industrial 等）は `Cargo.toml` で **git タグ参照**する:

```toml
[dependencies]
banto-core = { git = "https://github.com/tyaro/banto.git", tag = "v1.3.0" }
banto-storage = { git = "https://github.com/tyaro/banto.git", tag = "v1.3.0", features = ["sqlite"] }
banto-server = { git = "https://github.com/tyaro/banto.git", tag = "v1.3.0" }
```

private リポジトリの場合、消費側の Cargo/Git 認証（SSH鍵 or
`GIT_ASKPASS`/資格情報マネージャ）が別途要る。

### タグ運用規約

- タグ形式は `vX.Y.Z`（`workspace.package.version`、ルート `Cargo.toml`
  と揃える。現行 `v1.3.0`）。タグとマニフェストの整合は
  `pnpm check:versions --tag` が機械検査する（CR-7）
- **マイルストーンマージ毎にタグを打たない**。banto-industrial 等の
  消費側が固定参照する必要がある**破壊的変更時のみ**タグを更新する
  （trait シグネチャ変更・`ListParams`/エラー型の変更など、
  `banto-core`/`banto-storage`/`banto-server`/`banto-admin-services` の
  公開APIに影響する変更）
- タグは **npm 側（`@banto/*` の git 依存）と共用**（2026-07-12 決定節）。
  したがって `@banto/*` パッケージの公開APIの破壊的変更もタグ更新の
  対象になる
- 破壊的変更判定・バージョン番号の上げ方は npm 側と同じ規約（上記
  「バージョニング規約」）を踏襲する
- タグは軽量タグ（`git tag v1.3.0`）で可。変更履歴は
  [CHANGELOG.md](../CHANGELOG.md) で手動管理する（PR ごとに `[Unreleased]` へ
  追記 → リリース時に版節へ切り出し）

`admin_template_core`/`src-tauri` はアプリ固有のためタグ参照の対象外
（`admin-template` は banto リポジトリそのものをクローンして使う前提）。

## 公開しない選択

社内テンプレートとして使い続ける間は、上記の消費側設定は不要。
`workspace:*` のソース参照のままで、`pnpm --filter admin-template tauri dev` /
`build` はそのまま動く。Rust クレートも `path` 依存のまま本リポジトリ内で
完結する。
