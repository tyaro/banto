# npm パッケージの公開手順

Banto の `@banto/*` パッケージは、現在**モノレポ内でソース直接参照**
（`package.json` の `exports` が `./src/index.ts` を指す）で使われています。
これは実際の利用形態（テンプレートをコピーして使う）に最適で、ビルド成果物を
持たないぶん軽量です。

将来これらを **npm レジストリに公開**したくなったときのために、各パッケージを
「ソース参照」から「配布可能なビルド済みパッケージ」に切り替える手順をまとめます。
公開しない限り、以下の作業は不要です。

## 前提

- ライセンスは MIT（ルート `LICENSE`、各 `package.json` の `"license": "MIT"`）。
- npm スコープ `@banto` の公開権限（`npm login` 済み、`@banto` org への publish 権限）。

## パッケージごとに必要な変更

各 `packages/*/package.json` に以下を追加する（`theme` は CSS 主体なので
ビルドは軽い。`grid-svelte`/`charts`/`forms`/`dock-svelte` は Svelte
コンポーネントを含むため `@sveltejs/package` を使う。`admin-core` は
`.svelte`/`.svelte.ts` のみで `.svelte` コンポーネントを含まないため、
`svelte-package` でも `tsc` ベースでもよい）。

### 1. ビルド生成物を出す

Svelte を含むパッケージ（推奨: `@sveltejs/package`）:

```jsonc
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "svelte": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "svelte": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "sideEffects": ["**/*.css"],
  "scripts": {
    "build": "svelte-package -o dist",
    "prepublishOnly": "pnpm build"
  },
  "devDependencies": {
    "@sveltejs/package": "^2.0.0"
  }
}
```

`admin-core`（Svelte コンポーネントなし、ロジックのみ）は `vite build` の
ライブラリモード + `vite-plugin-dts`、または `tsc` で `dist` を出す。

`theme` は `src/index.ts` を `tsc`/`vite` でビルドし、CSS は `dist` にコピー。

### 2. `svelte`/`default`/`types` の条件付き exports

上記のように `exports` を **`dist`** 指向へ切り替える。開発時のソース参照
（`./src/index.ts`）は、モノレポ内の `admin-template` が `workspace:*` で
参照している間はそのままでも動くが、公開版は `dist` を指す必要がある。
（開発と公開で二重定義したい場合は `publishConfig.exports` で上書きする。）

### 3. バージョニング

- 現状すべて `0.1.0`。公開前に [Changesets](https://github.com/changesets/changesets)
  等でバージョン管理を導入するのが安全（相互依存があるため）。
- 依存順に publish する（下記）。

## 公開順（パッケージ間依存）

`admin-template` から見た依存関係上、**葉から順に**公開する:

1. `@banto/theme`（他に依存しない）
2. `@banto/grid-svelte`, `@banto/charts`, `@banto/forms`, `@banto/dock-svelte`
   （theme の CSS 変数に依存するが npm 依存としては独立。相互依存なし）
3. `@banto/admin-core`（UI 非依存。ただし利用側は上記 UI と併用）

各パッケージで:

```sh
cd packages/<name>
pnpm build          # dist を生成
npm publish --access public   # スコープ付きは --access public が必要
```

## Rust クレート（crates.io）

`banto-core` / `banto-storage` / `banto-server` は現状 path 依存で参照。
crates.io へ公開する場合は、各 `Cargo.toml` の path 依存を version 依存に
切り替え、`banto-core` → `banto-storage` → `banto-server` の順で
`cargo publish` する。`admin-template-core`/`src-tauri` はアプリ固有なので
公開対象外。

## 公開しない選択

社内テンプレートとして使い続ける場合、上記は不要。`workspace:*` の
ソース参照のままで、`pnpm --filter admin-template tauri dev` / `build` は
そのまま動く。
