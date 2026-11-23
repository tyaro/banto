# ADR-0033: Add `fast-check` to the devDependencies of `@banto/dock-svelte` for property tests (an exception to ADR-0002)

> 日本語: [0033-dock-svelte-fast-check-devdep.md](0033-dock-svelte-fast-check-devdep.md)

- Status: Accepted
- Date: 2026-11-22 (the direction was decided on 2026-11-21, Issue #782)
- Related: conventions §3 / [ADR-0002](0002-minimal-dependencies.en.md) / Issue #782 /
  `packages/dock-svelte/tests/place-properties.test.ts` /
  `packages/dock-svelte/tests/fixtures/dock-properties.ts`

## Context

The bugs in the remembered docked place (`DockSlot`) of hidden and floated panes in
`@banto/dock-svelte` kept coming as "the shape or the sizes depend on the order the
panes are shown in" (#733, #739, #741, #743, #777, #780, #781). The tests list
layouts and steps one by one; nothing ran over trees and step sequences at large.
Issue #782 replaces this mechanism with a shadow tree, so the base that checks the
same properties before and after - over generated trees and steps - comes first
(PR1 of #782).

## Decision

Add `fast-check` (`^4.10.3`) to the devDependencies of `packages/dock-svelte`.

- Used by tests only. Nothing under `src/` imports it (`files` is `src` only, so it
  is in neither the published package nor a consumer's bundle).
- The lockfile gains two packages: `fast-check` and its only dependency, `pure-rand`.
- The property tests run with a fixed seed and a fixed number of cases (the same
  result every run; a few seconds added to CI).

## Alternatives considered

- **A (chosen): add `fast-check`.** Generation, shrinking (making a counterexample
  small) and replay by seed come together. One dependency, maintained for years.
- **B (rejected): write generation and shrinking ourselves.** A random generator and
  an exhaustive walk are easy; shrinking is the part that matters, and without it a
  counterexample is not readable. Our own shrinker is more test tooling to
  maintain, against ADR-0002's "minimize total maintenance cost".
- **C (rejected): widen the existing enumeration (`enumerateSequences` in
  `fixtures/visibility-sim.ts`).** It fits hide / show sequences over fixed layouts,
  but with tree shapes, sizes and moves in between (`dockExisting` /
  `dockExistingAtEdge`) there are too many combinations. The existing enumeration
  stays as it is.

## Consequences

- Added to the "exceptions on the adding side" in conventions §3.
- A property test in another package adds the same version range to that package's
  devDependencies (within this ADR; never a runtime dependency).
- A known failure is marked `it.fails` with its issue number and shrunk
  counterexample. vitest reports when it starts to pass; take the mark off then.
