# ADR-0035: Writes are detached from the connection and run to completion, and a stop never reports success with writes left behind

> 日本語: [0035-detached-writes.md](0035-detached-writes.md)

- Status: Proposed (drafted 2026-11-22. The direction is settled by the owner's decision 8 of the same day and by
  items 6 and 17 in §10 of the plan. The details this ADR newly fixes - the upper bound of the wait at a stop, the
  shape of the panic and stopping responses, the bound on accepting new writes, and what the desktop does at
  exit - are listed under "Points to confirm with the owner")
- Date: 2026-11-22
- Related: Issue #793 / tyaro/banto-industrial#600 /
  [design/downstream-requests-2026-11-plan](../design/downstream-requests-2026-11-plan.md) §4.5, §7 (S1, S2), §10 items 6, 8, 17 /
  [ADR-0001](0001-rest-tauri-two-path-symmetry.en.md) (two-path symmetry) / [ADR-0002](0002-minimal-dependencies.en.md) /
  [ADR-0004](0004-server-logging-eprintln.en.md) / conventions §1, §3
- Code: `crates/banto-server/src/detach.rs`, `exposure.rs`, `server.rs` (`BoundServer::serve`, `RunningServer::stop`),
  `apps/admin-template/src-tauri/src/lib.rs` (`server_apply_body`), `leftover_writes.rs`

## Context

hyper 1.x closes the connection and drops the service future (the handler) when it reads the peer's FIN while the
response is pending. A handler that stacks side effects across `.await`s stops half-way there. banto's write
handlers await in the order "commit -> revoke sessions -> audit", so a client that goes away before the answer can
leave **an account that was created without its audit row**. The test in this PR
(`apps/admin-template/core/src/rest/tests/detach.rs`) reproduced both "created, not audited" and "not created"
when the layer was taken out.

Downstream (ChronoGazer in banto-industrial) avoided this by wrapping each handler in `run_detached`, which leaves
the handlers someone forgot to wrap. banto's own handlers were not wrapped.

## Decision

### 1. One layer, in `BoundServer::serve`

`BoundServer::serve` puts one hand-written layer (`detach::detach_writes`, `axum::middleware::from_fn_with_state`)
around the whole router, outermost. A **POST, PUT, PATCH or DELETE** request runs everything inside it (the CSRF
check, authentication, the role guard, the handler, the audit) in its own `tokio::spawn`ed task, and the connection
only waits for that task. When the connection goes away and the waiting side is dropped, the task still runs to the
end. GET, HEAD and SSE are unchanged.

- **No opt-out, and login is detached too** (owner decision 8). A derived app gets every write covered by being
  served through `serve`; there is nothing to forget.
- No new dependency (conventions §3; `tower-http` stays out).
- A router driven some other way (`oneshot`) does not get the layer (there is no connection to lose).
- A handler that wraps itself in `tokio::spawn` (downstream's `run_detached`) is unharmed - it just nests - and
  downstream can remove it from this version on.

**What is detached is a request that has been read.** A request cut off while its body is still arriving fails to
read, the handler ends on its own, and nothing happens.

### 2. Not idempotent

A client that disconnected does not know the outcome. An operation that takes effect twice when sent again (a
create) stays the responsibility of what always guarded it (a version, a unique constraint). The layer keeps no
operation id and detects no resend.

### 3. A panic is a 500

When the detached task panics (`JoinError`), the answer is **500** rather than a silently dropped connection, in
the existing error shape: `{"kind":"other","message":"処理の途中でエラーが起きました。状態を読み直してから、もう一度試してください。"}`
("read the state again, then retry" - how far it got is unknown). `METHOD path` and the cause go to `eprintln!`
(no `tracing`, ADR-0004). No new `kind`: the UI already handles a 500 `other`, and a new kind would touch both
`BantoError` and its TypeScript mirror.

### 4. Stop: refuse, count, wait with a bound, never report success with work left

A detached write keeps running even when the server task is aborted, so the stop has an order.

1. **Refuse new writes.** `stop()` first closes the layer's gate. A write that arrives afterwards (also on a
   connection that was already open) is not spawned and is answered **503** (`kind: other`), changing nothing. The
   gate check and the count are one step under a lock, so a write is either refused or counted and waited for by
   the stop. The listener closes through graceful shutdown as before.
2. Wait until no write is running, for at most **10 seconds** (`DETACHED_WRITES_STOP_TIMEOUT`). This runs
   **alongside** the 5 second wait for connections (`STOP_TIMEOUT`, Issue #283), so a stop takes 10 seconds at most.
3. **Past the bound, it is not a success.** `stop()` returns a `StopOutcome`: `Finished`, or
   `WritesRemaining(RemainingWrites)` (the current count, a list of `METHOD path` - no query string, bounded in
   length and number - and a way to wait for the end). The remaining writes are not aborted (aborting would cause
   the very half-done state this ADR prevents). It is also logged with `eprintln!`.
4. `stop_waiting_writes_for(limit)` exists for a caller that wants another bound.

The return type of `stop()` changes from `()` to `StopOutcome` (breaking; `server.stop().await;` still compiles).
It is not `#[must_use]`: many callers (tests, an exit path) need not look. A caller that starts another listener
afterwards must look (stated in the doc comment).

### 5. A reconfiguration is split by the direction of the exposure (plan §10 item 17)

Tauri's `server_apply` stops the old listener and starts one for the new configuration. Starting it while writes
remain would let a write of the old generation change state after the new configuration took effect. So with
writes remaining, **no listener is started for the requested configuration**, and the way out depends on the
direction.

| Change                                 | Examples                                             | Handling                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Widening or equal                      | another port, a wider bind, public viewing turned on | **The switch fails.** Nothing is saved or started, the previous listener is brought back (the existing rollback). The remaining writes finish under the configuration that accepted them. `applyFailure` is `writesRemaining` / `restored`                                                                                                                   |
| Server turned off                      | enabled -> disabled                                  | Saved, the listener stays closed. Returned as a **success** (the requested state holds). The remaining writes go into the audit row                                                                                                                                                                                                                          |
| Narrowing (a listener is still needed) | public viewing turned off, a narrower bind           | The previous listener is **not** brought back (that would leave open what was just closed). **Saved**, the listener stays closed, and the result is an error "saved and stopped, but writes remain - apply again". `applyFailure` is `writesRemaining` / `leftClosed`. The audit row is `ok` (it was saved) with `listening: false` and the remaining writes |

- The direction is the pure function `banto_server::restoring_previous_stays_within(previous, requested)`: true
  only when bringing the previous configuration back exposes nothing more than the requested one. It compares
  **whether a listener serves, the bind address, and public viewing** (`ServerSettings` has four fields -
  `enabled`, `bind`, `port`, `viewer_public` - and the port does not change the exposure). Binds compare as
  "loopback ⊂ one address ⊂ every address of that family"; what cannot be compared (a host name, two different
  addresses, `0.0.0.0` against `::`) counts as narrowing. **A change that widens one item and narrows another
  counts as narrowing.**
- **A narrowing change (turning the server off included) never brings the previous listener back, also when it
  fails part-way** (added by the review of PR #829). With writes remaining, a failure to **save** the narrower
  settings (a storage error, a refusal by the final re-validation) does not enter the common rollback: the listener
  stays closed. The result is "closed, not saved": `applyFailure` is the original reason (`saveFailed`, ...) /
  `leftClosed`, and the audit row is `failed` with `saved: false`, `restoredPrevious: false`, `listening: false`.
  `leftClosed` means "saved" only with the reason `writesRemaining`. A failure without remaining writes restores
  the previous listener as before.
- The remaining writes stay in the `ServerSlot` (`LeftoverWrites`). The next apply waits for them again, with the
  same bound, before it starts a listener, and refuses by the same rule when they are still running. They are
  still tracked after the previous listener was brought back.
- The audit `detail.remainingWrites` is `{count, operations}` (`count`: the exact total; `operations`: a list of
  `METHOD path`, at most 8 in all however many stopped listeners are tracked).
- A guarantee that "the old generation can no longer write" (fencing every write with a generation number) is not
  adopted: it would reach into the whole service layer.

### 6. Tauri commands need no layer

Tauri runs each async command as its own task (`InvokeResolver::respond_async` in `tauri` 2.12 calls
`async_runtime::spawn`; verified). A command's future is not dropped when the webview closes. This is a difference
of transport; the symmetry of authorization and audit (conventions §1) is unchanged.

### 7. Limits: only on accepting new writes, not on the duration of one

- **At most 256 writes run at once** (`MAX_DETACHED_WRITES`; changed by the cross-review of PR #829). Without the
  layer, the handlers running at once were bounded by the open connections. Once detached, the work of a client
  that sends and disconnects stays behind outside that number, so it is not the same. A write that arrives while
  the bound is reached is answered **503** (`kind: other`) without starting its handler, and logged with
  `eprintln!`. **A write that was accepted is never stopped.** 256 is set far above the usual concurrency of this
  kind of app (one write is short).
- **No limit on the duration of one write.** Cutting it short is exactly what this ADR prevents. A long write (a
  backup) keeps running after a disconnect and finishes. A write that never ends shows up as "remaining" at a stop.

### 8. Exit

- Headless (`banto-serve`): Ctrl-C calls `stop()`, which waits up to the bound; anything left is logged and the
  process ends.
- Desktop: exit does not stop the embedded server today (the process just goes away), and Tauri commands are in
  the same position, so this PR does not change it. A database transaction is either committed or rolled back, and
  nothing writes after the process is gone. Waiting before exit, if wanted, is to be decided separately and for
  commands too.

## Alternatives considered

- **A function `run_detached(label, work)` called by each handler** (downstream's current shape): handlers get
  forgotten. Rejected.
- **An opt-out (by method or path)**: nothing needs it today, and an opt-out is the same hole as a forgotten wrap.
  Rejected (decision 8).
- **Read the whole body in the layer, then detach**: buffers a body before authentication and makes the layer own
  a second size limit (the extractors have one). Rejected; a request cut off mid-body does nothing, which suffices.
- **Abort the writes that remain at a stop**: leaves them half-done. Rejected.
- **No limit on the number running at once** (the first draft): work left behind after a disconnect is outside
  the number of connections, so it was not "the same as before". Rejected (cross-review).
- **Wait without a bound**: a settings change and an exit become hostages of a write that never ends (the shape of
  Issue #283). Rejected.
- **Bring the previous listener back for a narrowing change too**: fail-open. Rejected (plan §10 item 17).
- **Fence every write with a generation number**: reaches into the whole service layer. Rejected.

## Consequences

- A write that was read finishes - create, revoke, audit - even when the client disconnects. Derived apps need to
  do nothing.
- Behaviour changes: (1) a disconnect no longer stops a write; (2) a panicking handler answers 500 instead of
  dropping the connection; (3) a write during a stop, or while the bound of 256 concurrent writes is reached, is answered 503; (4) `RunningServer::stop()` returns a
  `StopOutcome`; (5) the desktop's "apply LAN settings" can fail while writes remain (`writesRemaining`).
- The layer does not fix a handler whose internal order is wrong. The per-handler review (commit -> revoke ->
  audit, and that work running on under a revoked session does not write) is **S2** (plan §7).
- Tests: `crates/banto-server/tests/detach_writes.rs` (both steps run after a disconnect / a GET is still dropped /
  a panic is 500 / a stop waits for a running write / a write that does not end is reported as remaining), the unit
  tests in `detach.rs` (after the gate closed: 503 and the handler never runs) and `exposure.rs` (the direction;
  mixed changes count as narrowing), `apps/admin-template/core/src/rest/tests/detach.rs` (the real
  `POST /api/users`: account and audit row survive the disconnect),
  `apps/admin-template/src-tauri/src/tests/server_writes.rs` (both directions of a reconfiguration).

## Points to confirm with the owner

1. The **10 second** bound at a stop (alongside the 5 seconds for connections). Changing LAN settings during a long
   write such as a backup makes a widening change fail with "apply again".
2. Panic and stopping responses use `other` (500 / 503) rather than a new kind.
3. The bound of 256 concurrent writes (only new ones are refused) and no limit on the duration of one (§7).
4. A narrowing change that still needs a listener is saved and then returned as an **error** (`leftClosed`; the UI
   shows the error text).
5. Desktop exit stays as it is (§8).
