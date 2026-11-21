# ADR-0032: e2e/ の型検査のためにルートの devDependencies へ `@types/node`・`typescript`・`axe-core` を足す（ADR-0002 の例外）

> English: [0032-root-e2e-typecheck-devdeps.en.md](0032-root-e2e-typecheck-devdeps.en.md)

- 状態: Accepted
- 日付: 2026-11-21
- 関連: conventions §3 / [ADR-0002](0002-minimal-dependencies.md) /
  `e2e/tsconfig.json` / ルート `package.json` の `check:e2e`

## コンテキスト

`e2e/`（Playwright の spec・visual・補助）の TypeScript は、ルートの `check`
（`pnpm --recursive --if-present check`）の対象外で、型検査が一度も走っていな
かった。`e2e/tsconfig.json` は `types: ["node", "@playwright/test"]` と書くが、
ルートに `@types/node` が無く、`process`・`Buffer`・`node:fs` などの型が解決できない。
また `e2e/visual/ui-overlays.spec.ts` が `axe-core` を直接 import するが、
ルートからは `@axe-core/playwright` の推移的依存としてしか存在せず、pnpm の
厳密な node_modules からは解決できない。

## 決定

ルートの devDependencies に次の 3 つを足し、`pnpm check:e2e`
（`tsc -p e2e/tsconfig.json --noEmit`）を新設してルートの `check` から呼ぶ。

- `@types/node` `^24.0.0` — CI と作業機の Node（24。`.nvmrc`・`engines`・
  `setup-node`）のメジャーに合わせる。型だけで実行時の影響は無い。
- `typescript` `^6.0.0` — 各パッケージが既に持つ指定と同じ（lock は 6.0.3 の 1 つ）。
  新しいパッケージは増えない。
- `axe-core` `^4.14.0` — lockfile にある版（4.14.0）と同じ。`@axe-core/playwright`
  が既に引いており、新しいパッケージは増えない。

## 検討した代替案

- **案A（採用）: ルートに 3 つを足して `check:e2e` を `check` に繋ぐ。**
  差分は型検査が通る前提を満たすだけで、実行時のコード・成果物に影響しない。
  lockfile に新規で増えるのは `@types/node`（と `undici-types`）だけ。
- **案B（不採用）: `e2e/` を型検査しない（現状維持）。**
  spec の型の誤り（存在しないフィールド・`any` の暗黙化）がテストの実行まで
  見つからず、CI で最初に落ちるのが遅い。
- **案C（不採用）: `e2e/` に専用の `package.json` を作る。**
  ワークスペースのパッケージが 1 つ増え、scaffold・`check-versions` などの
  取り扱いが増える。型検査のためだけには重い。
- **案D（不採用）: `types` から node を外し、ambient 宣言を手書きする。**
  Node の API の型を自前で保守することになり、ADR-0002 の「総保守コスト最小化」に反する。

## 帰結

- conventions §3 の「依存を足す側の例外」に本 ADR を追記する。
- scaffold は preset を問わず `e2e/` を残す（display は visual などのスイートを消して
  smoke を差し替える）。生成物でも `check:e2e` が通ることを PR で確かめる。
- 今後、e2e に新しい直接の import（`axe-core` のような推移的依存）を足すときは、
  ルートの devDependencies に明示する。
