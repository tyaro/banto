# ADR-0036: On-screen keys for touch panels live in a new optional package, `@banto/touch-keys-svelte`

> 日本語: [0036-touch-keys-package.md](0036-touch-keys-package.md)

- Status: Accepted
- Date: 2026-11-25 (owner decision: the 17 items of [design §18](../design/touch-keypad-design.md), all as recommended)
- Related: Issue #937 / [touch-keypad-design.md](../design/touch-keypad-design.md) §0, §4, §15, §17 /
  [conventions.md](../conventions.md) §3, §4, §5, §13 / [template-scope.md](../template-scope.md) §1, §3, §3.1 /
  [ADR-0018](0018-shared-ui-package.md), [ADR-0020](0020-image-assets-package.md)

## Context

On touch-panel terminals (kiosks, shop-floor screens) the OS keyboard is missing, too large, or unsuited to
business input. We want an on-screen number keypad and text keyboard that safely write to an input (Issue #937).
`@banto/ui` is **core** (template-scope §2.1, not meant to be deleted) and must not carry weakly cross-cutting parts.

## Decision

### 1. A new optional package, `@banto/touch-keys-svelte` (`packages/touch-keys-svelte`)

- Not added to `@banto/ui`. Removing it is deleting one folder. The name follows `dock-svelte` / `tree-svelte` / `grid-svelte`.
- `dependencies` / `peerDependencies` are empty; bare imports are only `svelte`, `svelte/*` and relative paths
  (conventions §4, §5). `@banto/ui` cannot be imported, so the layering contract is met through DOM markers (design §4.1).
- Strings come as a bundle of functions, `TouchKeysMessages` (Japanese defaults), via `messages`; no dictionary and no Paraglide (conventions §13).
- Key size is the component CSS variable `--banto-touch-key-size` (default 48px); not added to theme (design §10).

### 2. Wired into the template app as one card on `/ui-demo` only

**Up to T5 it was not wired** (recipe-only: the app did not depend on it, scaffold never touched it and no baseline
images changed; design §4.2 a). Once the API had settled, **T7 (2026-11-25, owner decision) took design §4.2 b**:

- The wiring is one card on `/ui-demo`. **No host in the root layout** (nothing always-on enters the shell; design
  §4.2 c stays rejected). The host sits inside the card and `resolve` limits it to the card's own fields.
- admin-template depends on `@banto/touch-keys-svelte`. `pnpm scaffold` removes the card and its wiring in
  `minimal`, `standard` and `display`; only `full` keeps it (the package itself stays). The only baseline images
  that change are the `ui-demo` ones.
- The removal steps are in [remove-optional-assets](../recipes/remove-optional-assets.md) and the template-scope §3
  row (conventions §4).

### 3. External-consumer fixture (rule `external-consumer-fixture`)

The fixture ref is the latest tag (v8.0.0), which does not contain this package. T1 is **free of `.svelte.ts`**
(plain `.ts` functions and `.svelte` only), so the rule does not apply (owner decision, 2026-11-25). When a later
step (T2 onward) needs `.svelte.ts`, follow ADR-0020 §6 (add the fixture dependency, import and
`optimizeDeps.exclude` in the same PR; how to handle the ref lacking the package is decided in that PR).

### 4. Stages

T1 (this ADR, registration, pure number functions, the `NumberKeypad` display) -> T2 (host and `touchKeys`) ->
T3 (text keyboard) -> T4 (kana) -> T5 (recipe) -> T7 (the `/ui-demo` card, item 2 above). Scope is in design §15.
T6 (grid) is a separate design.

## Consequences

- One more `@banto/*` package (the 13th). The version is kept in step with the others (`check:versions`).
- If it stays at a single consumer, revisit keeping it optional (same signal as image-assets).
