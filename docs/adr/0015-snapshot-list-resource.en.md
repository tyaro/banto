# ADR-0015: Read lists that change without events through a separate bounded (`asOfId`) class, `SnapshotListResource`, with an injected fetcher

> 日本語: [0015-snapshot-list-resource.md](0015-snapshot-list-resource.md)

- Status: Accepted
- Date: 2026-09-29
- Related: Issue #248, #243 (PR #246) / spec §4.1 / conventions §6 /
  banto-industrial #410, #427, #428, #448, #463, #464 (earlier instances of the same fix)

## Context

The admin-template audit-log page did not use `WindowedListResource`; it kept a
reduced copy (`AuditLogWindow`) inside the page. The audit log sits outside
`DataProvider` for the same reason as `usersAdmin.ts` (its own wire shape and
Tauri command names), and `WindowedListResource` assumed `getDataProvider()`.
#243 fixed `WindowedListResource`, but the copy kept the same defects
(reproduced by running a verbatim copy of the old class):

1. Failures were only toasts: "not read yet", "failed" and "0 rows" looked the
   same, and there was no way to retry.
2. With a visible range of `{0, 0}` (after a failed first fetch, or after a
   filter matched 0 rows) no request was made, so the page could not recover.
3. A request that never answered had no time limit; `loading` stayed up.
4. Rows come and go between fetches. The audit log grows without
   `invalidate()` and shrinks through retention pruning. Without a boundary,
   blocks duplicate or skip rows at their edges (3 new rows made the first 3
   rows of the next block repeat the end of the previous one).

1-3 are fixed by letting `WindowedListResource` take an injected fetcher (the
issue's option A). 4 needs a per-generation snapshot boundary (option B, the
owner's decision).

## Decision

- Add a **separate class** to `@banto/admin-core`, `SnapshotListResource`
  (`createSnapshotListResource(fetcher, options)`, `snapshot.svelte.ts`). It
  **takes an injected fetcher**; `DataProvider.getList` is unchanged.
- The boundary `asOfId` returned by a generation's first answer is pinned and
  sent with every later block. Until it is known, only one request is in
  flight. An answer whose count differs under the same boundary is not
  written and the generation stops reading (expired). The generation is not
  restarted automatically; `refresh()` (the page's "Reload") starts a new one.
- Failures per block, recovery from `{0, 0}`, the time limit and dropping
  answers from another generation follow the same promises as
  `WindowedListResource` (#243). The small shared pieces (array-length check,
  timeout message, conversion to `ProviderError`) live in `blockFetch.ts`.
- The server (the audit-log list) accepts an optional `asOfId` and returns the
  boundary it used; a bounded read does not run retention pruning. The
  server-side rules live in [conventions §6](../conventions.en.md).

## Alternatives considered

- **A (chosen): a separate class with an injected fetcher.** Leaves
  `WindowedListResource` and every CRUD screen using it untouched (#212's
  keep-the-old-rows-while-refreshing, #243's promises). Lists that need a
  boundary are few and have dedicated APIs, so injection is natural.
  Downside: the block-loading decisions live in two classes (small pieces
  are shared; what to fetch, accept and stop is not).
- **B (rejected): add fetcher injection and a boundary option to
  `WindowedListResource`.** One class, but a bounded list requests
  differently (one request until the boundary is known, stop on a count
  change, no automatic re-read), so every option adds branches to a state
  machine that went through two review rounds in #246. And
  `WindowedListResource` assumes `invalidate()` re-fetches automatically
  (`refresh()` swaps in the new data while keeping the old one shown), which
  is a different meaning of `refresh()` than "no events, the user starts a
  new generation".
- **C (rejected): add `asOfId` to `DataProvider.getList` (optional argument,
  optional response field) and use it from `WindowedListResource`.**
  Compatible, but every provider - InMemory, Tauri, HTTP and any a derived
  app wrote - would have to decide whether to honour the boundary or silently
  ignore it. An ignored boundary cannot be told apart from an expiry, and CRUD
  lists that need no boundary would pay for it.
- **D (rejected): fix the reduced copy per page** (banto-industrial #427 keeps
  `blockCache.ts` as a duplicate plus a sync test). Template users would copy
  it for every list of this kind, and a copy is exactly what #248 found left
  unfixed.

## Consequences

- A new list that changes without events uses `SnapshotListResource`, and its
  server side follows conventions §6 (one read transaction, count inside the
  boundary, `id` monotonic without reuse, no deleting side effect on a
  bounded read, unchanged result without `asOfId`).
- Keep `WindowedListResource` and `SnapshotListResource` aligned on failures,
  recovery and time limits; when fixing one, check the other (shared pieces
  are in `blockFetch.ts`).
- While the boundary is pinned the page does not show new records by itself.
  Keep "Reload" always available (also while loading; in-flight requests are
  aborted).
- On PostgreSQL a writer that allocated a lower `id` and commits late raises
  the count under the same boundary. That is treated as an expiry too
  (re-reading is correct).
