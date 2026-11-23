# ADR-0033: `@banto/dock-svelte` の性質テストのために devDependencies へ `fast-check` を足す（ADR-0002 の例外）

> English: [0033-dock-svelte-fast-check-devdep.en.md](0033-dock-svelte-fast-check-devdep.en.md)

- 状態: Accepted
- 日付: 2026-11-22（方針の決定は 2026-11-21、Issue #782）
- 関連: conventions §3 / [ADR-0002](0002-minimal-dependencies.md) / Issue #782 /
  `packages/dock-svelte/tests/place-properties.test.ts` /
  `packages/dock-svelte/tests/fixtures/dock-properties.ts`

## コンテキスト

`@banto/dock-svelte` の、隠れた・浮かせたパネルの「元の場所」（`DockSlot`）の不具合は、
戻す順で形や比率が変わるものが続いた（#733・#739・#741・#743・#777・#780・#781）。
テストは配置と手順を 1 件ずつ並べる形で、木と操作列を広く当たるものが無かった。
Issue #782 でこの仕組みを影の木に置き換えるにあたり、置き換えの前後で同じ性質が
成り立つことを、生成した木と操作列で確かめる土台を先に作る（#782 の PR1）。

## 決定

`packages/dock-svelte` の devDependencies に `fast-check`（`^4.10.3`）を足す。

- テストでだけ使う。`src/` からは import しない（`files` は `src` のみで、公開物にも
  利用者のバンドルにも入らない）。
- lockfile に増えるのは `fast-check` と、その唯一の依存 `pure-rand` の 2 つ。
- 性質テストはシードと件数を固定して走らせる（毎回同じ結果。CI の時間の増分は数秒）。

## 検討した代替案

- **案A（採用）: `fast-check` を足す。** 生成・縮小（反例を小さくする）・シードによる
  再現が揃っている。依存は 1 つだけで、長く保守されている。
- **案B（不採用）: 生成と縮小を自前で書く。** 乱数の生成器と全列挙は書けるが、
  反例の縮小が要で、ここが無いと見つけた反例を人が読める形にできない。自前の
  縮小はテストの道具の保守を増やし、ADR-0002 の「総保守コスト最小化」に反する。
- **案C（不採用）: 既存の全列挙（`fixtures/visibility-sim.ts` の `enumerateSequences`）を
  広げる。** 決まった配置の上の hide / show の列挙には向くが、木の形・比率・途中の
  移動（`dockExisting` / `dockExistingAtEdge`）まで含めると組み合わせが多すぎる。
  既存の列挙はそのまま残す。

## 帰結

- conventions §3 の「依存を足す側の例外」に本 ADR を追記する。
- 他のパッケージで性質テストを書くときは、そのパッケージの devDependencies に
  同じ版の指定で足す（本 ADR の範囲。実行時の依存にはしない）。
- 既知の失敗は `it.fails` で印を付け、Issue 番号と縮めた反例を残す。直ったら
  vitest が知らせるので、そのときに印を外す。
