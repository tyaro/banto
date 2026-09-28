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
  flight. An answer whose **count or deletion epoch (`deletionEpoch`)**
  differs from the generation's first under the same boundary is not written
  and the generation stops reading (expired). The generation is not restarted
  automatically; `refresh()` (the page's "Reload") starts a new one.
- **The boundary alone does not fix the set** (added after the #256 review).
  The set inside it shrinks through deletions (retention) and, on
  PostgreSQL, grows when **a writer that allocated a lower `id` commits
  late** (`IDENTITY` hands out ids outside transactions). A per-request
  `REPEATABLE READ` only makes one answer consistent. A late commit plus a
  deletion of the same size keeps the count while the set changes, so the
  count alone misses it (rows repeat, e.g. `[5,3,3,2]`). The server therefore
  keeps a **deletion epoch**: when retention pruning deletes rows it advances
  `audit.deletion_epoch` in `settings` in the same transaction, and the list
  reads it in the same read transaction as the rows and the count. The client
  compares both with the generation's first answer:

  | What happened inside the boundary       | Count   | Deletion epoch | Detected by    |
  | --------------------------------------- | ------- | -------------- | -------------- |
  | Late commit only                        | up      | same           | count          |
  | Deletion only                           | down    | advanced       | both           |
  | Late commit + deletion of the same size | same    | advanced       | deletion epoch |
  | Late commit + larger/smaller deletion   | changed | advanced       | both           |

  SQLite writes one at a time, so a row below the boundary never commits late
  there (the count alone would do), but it runs the same mechanism. Rows are
  assumed to be deleted only by `prune` (restoring a backup replaces the whole
  database and restarts).

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
- For the deletion epoch (#256 review), other ways of detecting the change:
  - **Return `SUM(id)` (or a set hash) inside the boundary with the count
    (rejected).** Needs no change on the write side and costs about the same
    as the count (same scan). But detection is probabilistic: two late
    commits and two deletions with equal id sums slip through (e.g. `{2,5}`
    in, `{3,4}` out). A hash collides less, but there is no set hash that is
    cheap in SQL and identical in both dialects.
  - **`(max(id), count, min(id))` (rejected).** Row-cap deletion is oldest
    first, so `min(id)` usually moves, but not when no deleted row is inside
    the filter, nor for day-based deletion (`ts` order and `id` order are not
    guaranteed to match). A filtered `min(id)` needs the same scan as the
    count.
  - **A deletion epoch (chosen).** Costs one `settings` row update when a
    prune deleted rows (in the prune's transaction) and one primary-key read
    per list. With `prune` as the only deletion path it misses nothing (table
    above). No migration (`settings` is a Banto base table).
- **D (rejected): fix the reduced copy per page** (banto-industrial #427 keeps
  `blockCache.ts` as a duplicate plus a sync test). Template users would copy
  it for every list of this kind, and a copy is exactly what #248 found left
  unfixed.

## Consequences

- A new list that changes without events uses `SnapshotListResource`, and its
  server side follows conventions §6 (one read transaction, count inside the
  boundary, `id` monotonic without reuse, anything that deletes rows
  advances the deletion epoch in the same transaction, no deleting side
  effect on a bounded read, unchanged result without `asOfId`). A list with
  deletions on a database that commits writes concurrently must return
  `deletionEpoch`.
- Keep `WindowedListResource` and `SnapshotListResource` aligned on failures,
  recovery and time limits; when fixing one, check the other (shared pieces
  are in `blockFetch.ts`).
- While the boundary is pinned the page does not show new records by itself.
  Keep "Reload" always available (also while loading; in-flight requests are
  aborted).
- On PostgreSQL a writer that allocated a lower `id` and commits late raises
  the count under the same boundary. That is treated as an expiry too
  (re-reading is correct). When a deletion offsets the count, the deletion
  epoch still expires the generation.
