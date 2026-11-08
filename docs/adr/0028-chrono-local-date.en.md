# ADR-0028: Get the app's local date with `chrono` (`clock` only) (exception to ADR-0002)

> 日本語: [0028-chrono-local-date.md](0028-chrono-local-date.md)

- Status: Accepted
- Date: 2026-11-08
- Related: PR #533 / conventions §3 / [ADR-0002](0002-minimal-dependencies.en.md) /
  [docs/design/date-time-pickers.md](../design/date-time-pickers.md)

## Context

admin-template wrote `items.updated_at` with SQL expressions (SQLite `date('now')` = UTC,
PostgreSQL `CURRENT_DATE::text` = the DB server's time zone). Rows saved between
00:00 and 09:00 JST got the previous day's date and did not show up when filtering by
the date picker's "today" (the browser's local date).

With the owner we decided to compute the local date of the machine running the app
process in Rust and bind it into the SQL. A local date needs the time-zone offset,
which std does not provide: Windows needs the Win32 API and Unix needs `localtime_r` via FFI.

Constraint: conventions §3 / ADR-0002 name `chrono` / `time` as dependencies we do not add;
adding one is a design decision recorded in an ADR.

## Decision

**Add `chrono` (`default-features = false, features = ["clock"]`) to
`admin-template-core` and get the local date with `chrono::Local`.** Approved by the owner on 2026-11-08.

The scope is limited to this use (reading the local date/time). Date string conversion and
calendar arithmetic stay hand-written (`civil_from_days` etc.) and are not replaced by `chrono`.
It is not added to the shared crates (`banto-*`).

## Alternatives considered

- **A (chosen): add only `chrono`'s `clock` feature.**
  P1-5 criteria met: (1) time zones need per-OS FFI with many edge cases (the date/time domain);
  (2) `chrono` is mature and already used by `src-tauri`, so the effective lockfile and binary
  growth is close to zero; (3) it can be limited to `clock`. Downside: derived apps that copy
  the template get one more dependency in their core.
- **B (rejected): query `SELECT date('now','localtime')` from the in-process SQLite.**
  No new dependency, but on the PostgreSQL path it opens a `sqlite::memory:` connection just
  for the date, and the intent ("get the date") is hard to read from the code. Implemented once
  in PR #533 and reverted to A by the owner's decision.
- **C (rejected): hand-written FFI via `windows-sys` / `libc`.** Means maintaining per-OS
  `unsafe` code ourselves, against §3's goal of minimizing total maintenance cost.
- **D (rejected): just change the SQL to `date('now','localtime')`.** PostgreSQL still uses
  the DB server's time zone, so the dialects disagree.

## Consequences

- `items.updated_at` is the app's local date on both SQLite and PostgreSQL. Tests can pin the
  date with `ItemsService::with_today`.
- The `chrono` / `time` row of the conventions §3 table references this exception.
- To remove: if `chrono` is dropped, replace it with alternative B (in-process SQLite localtime).
