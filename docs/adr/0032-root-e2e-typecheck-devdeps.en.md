# ADR-0032: Add `@types/node`, `typescript` and `axe-core` to the root devDependencies to type-check e2e/ (an exception to ADR-0002)

> 日本語: [0032-root-e2e-typecheck-devdeps.md](0032-root-e2e-typecheck-devdeps.md)

- Status: Accepted
- Date: 2026-11-21
- Related: conventions §3 / [ADR-0002](0002-minimal-dependencies.en.md) /
  `e2e/tsconfig.json` / the `check:e2e` script in the root `package.json`

## Context

The TypeScript under `e2e/` (Playwright specs, visual tests, helpers) was outside
the root `check` (`pnpm --recursive --if-present check`), so it was never
type-checked. `e2e/tsconfig.json` declares `types: ["node", "@playwright/test"]`,
but the root has no `@types/node`, so `process`, `Buffer`, `node:fs` and the like
do not resolve. Also `e2e/visual/ui-overlays.spec.ts` imports `axe-core`
directly, but from the root it exists only as a transitive dependency of
`@axe-core/playwright`, which pnpm's strict node_modules does not resolve.

## Decision

Add the following three to the root devDependencies, and add
`pnpm check:e2e` (`tsc -p e2e/tsconfig.json --noEmit`) called from the root
`check`.

- `@types/node` `^24.0.0` — the major of the Node used by CI and developer
  machines (24: `.nvmrc`, `engines`, `setup-node`). Types only; no runtime effect.
- `typescript` `^6.0.0` — the same range every package already uses (one 6.0.3
  in the lockfile). No new package.
- `axe-core` `^4.14.0` — the version already in the lockfile (4.14.0), pulled in
  by `@axe-core/playwright`. No new package.

## Alternatives considered

- **A (adopted): add the three to the root and wire `check:e2e` into `check`.**
  The change only satisfies the preconditions for type-checking and affects no
  runtime code or artifact. The only new lockfile entries are `@types/node`
  (and `undici-types`).
- **B (rejected): leave e2e/ unchecked.** Type mistakes in specs (nonexistent
  fields, implicit `any`) surface only when tests run, so CI fails late.
- **C (rejected): give `e2e/` its own `package.json`.** One more workspace
  package, and more to handle in scaffold and `check-versions`. Too heavy for type-checking alone.
- **D (rejected): drop node from `types` and hand-write ambient declarations.**
  We would maintain Node API types ourselves, against ADR-0002's "minimize total
  maintenance cost".

## Consequences

- Added to the "exceptions on the adding side" in conventions §3.
- Scaffold keeps `e2e/` in every preset (display removes the visual etc. suites and
  swaps the smoke). The PR verifies that `check:e2e` passes on generated output too.
- When e2e gains a new direct import that is only a transitive dependency (like
  `axe-core`), declare it explicitly in the root devDependencies.
