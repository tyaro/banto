# ADR-0035: Writes are detached from the connection and run to completion, and a stop never reports success with writes left behind

> 日本語: [0035-detached-writes.md](0035-detached-writes.md)

- Status: Accepted (2026-11-22. The direction is the owner's decision 8 of the same day and items 6 and 17 in §10
  of the plan. The details this ADR newly fixes - the upper bound of the wait at a stop, the shape of the panic and
  stopping responses, the bound on accepting new writes, and what the desktop does at exit - were confirmed by the
  owner the same day as recommended; see "Owner decisions")
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
4. `stop_waiting_writes_for(limit)` exists for a caller that wants another bound. A caller that also wants to choose the bound on the connection wait has the public `stop_within(connections, writes)` (#980).

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
- **The room is shared across listener generations** (`WriteBudget`; added by the re-review of PR #829). The gate
  of a stop, and each generation's own count and drain, stay per listener; only the room for new writes is shared.
  Writes a stopped listener left running keep their places until they finish. When a switch is refused and the
  previous configuration is brought back, the restored listener can start only what is left, and a place comes
  back when an old write finishes. Take it with `RunningServer::write_budget()` and hand it to the next listener
  with `BoundServer::with_write_budget()` (the template keeps one in its `ServerSlot`). A listener that is given
  none has a budget of its own. Tauri commands do not pass the layer, so they are outside this budget (§6).
- **The body is received before a place is taken** (follow-up to the review of PR #829). The layer first receives
  a write's body itself (up to `BUFFERED_BODY_MAX_BYTES` = 2 MiB, the same as axum's default `DefaultBodyLimit`),
  and only then takes a place and starts the handler. A client that sends the headers and stalls holds no place
  and starts no handler (it costs its own connection, as without the layer, and the bytes it sent). This wait has
  two bounds (added by the review of PR #833). **Time**: when the body is not complete within `BODY_RECEIVE_LIMIT`
  (30 seconds, from the headers to the end of the body - the whole reception, not the gap between pieces) the
  request is answered **408**. That is a limit on a body that has not arrived, and it applies only before the
  handler starts (consistent with "no limit on the duration of one write" below). **Memory**: the bodies being
  received are held before anything checked who sent them, so together they hold at most
  `RECEIVING_BODIES_MAX_BYTES` (64 MiB; shared across generations through the `WriteBudget`). Bytes are counted as
  they arrive (not as declared); a write whose next piece does not fit is answered **503** without starting its
  handler. The bytes are given back when the body is complete and its write has taken a place, or when the wait
  ends any other way (disconnect, time up, refusal). A write without a body uses none of this. While stopping, or
  while every place is taken, a write is refused before its body is waited for. Authentication and the role guard
  are inside the router (in the spawned task), so for a body of at most 2 MiB they now come after the body (the
  layer is outermost so that authorization and audit are part of what is detached; the budget above bounds that
  memory). Keeping the budget full takes sending 64 MiB every 30 seconds, and it comes back when that stops. **This 64 MiB bounds the bytes of bodies the layer holds before they are complete,
  without authentication; it is not a bound on the process's real memory use** (a note from the review of PR #833).
  It counts only the bytes the layer has gathered into its `Vec`, and gives them back when the write takes a place and
  its handler starts. The handler then holds that body, so real memory can exceed 64 MiB (up to 256 places x 2 MiB,
  about 512 MiB, is held separately by writes that are running). It also does not count the spare capacity a growing
  `Vec` may have beyond the bytes received, the receive buffers of hyper and the OS, or the head of a body over 2 MiB
  that is passed on to the handler. A body over 2 MiB (declared, or found to be while reading; an uploaded backup) is
  not held in memory by the layer and is streamed to the handler as before. Such a write takes its place before
  its body, so only **16** of the 256 (`MAX_STREAMED_WRITES`) may be of that kind: a stalled large upload can only
  keep other large uploads out (remaining weakness: those 16 can be held without authentication where a route
  reads a large body before authenticating; the template's large-body route is refused by `RoleGuard` before the
  body). Tauri commands read no HTTP body, so they are outside this (§6).
- **No limit on the duration of one write.** Cutting it short is exactly what this ADR prevents. A long write (a
  backup) keeps running after a disconnect and finishes. A write that never ends shows up as "remaining" at a stop.

### 8. Exit

- Headless (`banto-serve`): Ctrl-C calls `stop()`, which waits up to the bound; anything left is logged and the
  process ends.
- Desktop: exit does not stop the embedded server today (the process just goes away), and Tauri commands are in
  the same position, so this PR does not change it. A database transaction is either committed or rolled back, and
  nothing writes after the process is gone. Waiting before exit, if wanted, is to be decided separately and for
  commands too.

### 9. A listener the app made itself goes through `serve` too (Issue #947, added 2026-11-25)

The layer of §1 is only installed inside `serve`. When the same router is handed straight to `axum::serve` on an
`axum::serve::Listener` of the app's own (a listener that does the TLS handshake in `accept` - the loopback TLS
listener of banto-industrial's Hub), the writes that arrive there are not detached and no stop counts them. So
**`serve` takes any listener**.

- **The entry point**: `BoundServer::from_listener(listener)` (`L: axum::serve::Listener<Addr = SocketAddr>`). It
  returns a `BoundServer<L>` whose `serve(router)` runs **the very same code** as for the listener `bind` makes: the
  detaching layer, the stop gate, the count (`StopOutcome`), the stop signal and the SSE connection count (`sse.rs`),
  and `ConnectInfo<SocketAddr>` (the peer the listener returned from `accept`). `BoundServer` became
  `BoundServer<L = TcpListener>`; the bare type name `BoundServer` still means the plain listener (existing callers
  do not change).
- **One `RunningServer` per listener.** The gate, the list of running writes and the stop are per listener; only the
  room for new writes (the `WriteBudget` of §7) is shared by all listeners of the app (pass the first listener's
  `write_budget()` to the others, and to the next generation of a replaced one, with `with_write_budget`). A TLS
  listener is stopped and rebuilt on its own when its certificate is renewed or revoked, which is exactly the
  "shared over generations" shape of §7. While one is being replaced, the gate of the other stays open and its
  writes stay detached. Writes left running by a stopped generation keep their share of the budget until they
  finish and show up in that generation's `StopOutcome`.
- **Stopping them together**: `RunningServer::stop_all(servers)` (`stop_all_waiting_writes_for` for another writes bound, `stop_all_within(servers, connections, writes)` to choose both, #980).
  It keeps the order of §4 over all listeners: **every gate is closed first** (from then on none of them starts a
  write), then they are waited for side by side. The wait is that of the slowest one (10 seconds at most), not the
  sum. One result per listener, in the order given. Calling `stop()` on one after the other lets the later
  listeners accept writes while the first is waited for, and adds the waits up.
- **A stop requested from outside (a revoked certificate)**: `RunningServer::stop_handle()` returns a `StopHandle`
  that can be cloned, and its `request_stop()` is **synchronous and does not wait** (callable from a watcher thread
  or anywhere else that neither owns the `RunningServer` nor can `.await`; added in the cross review of PR #950).
  It does what the first step of `stop()` does: the write gate is closed by the time it returns (a later write,
  also one on a connection that is still open, is answered 503 and does not start), the listener is told to stop
  accepting and the open connections are told to end (the listener closes when the serve task runs next).
  **Writes already accepted are not stopped.** It may be called any number of times and cannot be undone.
  Finishing the stop (waiting for the remaining writes and reporting them) is still the owner's `stop()` /
  `stop_all()`. Cutting open connections on the spot stays the job of the app's `Io` (below). A `StopHandle` does
  not keep a listener alive (dropping the `RunningServer` stops it even while handles remain).
- **Whether it is serving**: `RunningServer::is_serving()` (read-only) is true only while no stop was requested AND
  the task that accepts connections is running (added in the re-review of PR #950). It is false from the moment a
  stop is requested. False without a request means the accept task ended on its own (a panic in the `accept` of the
  app's own listener, for instance). An operation that changes something inside a listener without stopping it (an
  ordinary certificate renewal that swaps the certificate behind the same socket) is outside banto and leaves the
  `RunningServer` as it is; reading this before and after lets the app refuse to report such a swap as done on a
  listener that stopped or raced with a revocation. A listener is rebuilt only for a revocation or a real
  re-creation.
- **Writes left by an earlier generation stay with the app**: `stop_all` waits only for the listeners it is given.
  The `RemainingWrites` of a `StopOutcome::WritesRemaining` returned when a listener was replaced is kept by the
  app until it reports `is_finished()`; at the final stop the app waits for those too, against the same deadline
  (`RemainingWrites::wait`), or reports them as unfinished. All `Finished` for the listeners given does not by
  itself mean "no write is running". The check over all generations is that `WriteBudget::running()` of the shared
  budget is 0.
- **How far the promise reaches**: "nothing to forget to wrap" (§1) covers **every listener served through
  `serve`**. The layer itself (`detach_writes`, `DetachedWrites`) stays private, so `serve` is the only way to
  install it and there is no way to install it wrongly. The only way out of the promise is to hand the router
  straight to `axum::serve` or the like (banto cannot prevent that; the docs say not to).
- **What stays with the app**: the TLS handshake, cutting open connections at once when a certificate is revoked
  (the wrapper around `Io`), and the decision to rebuild a listener. `stop()` waits up to 5 seconds for the
  connections and then aborts the serve task, but does not guarantee that the sockets left are closed at that point
  (as before). A connection that must be cut at once is cut by the app's `Io`.
- The peer address must be a `SocketAddr` (the login rate limit and the loopback checks read
  `ConnectInfo<SocketAddr>`). Listeners with another address type, such as Unix sockets, are out of scope.

## Alternatives considered

- **Make the layer public** (`DetachedWrites` and a function that installs the layer on a router; option 2 of
  Issue #947): the caller would install the layer, share the gate and close-then-wait at a stop by itself, so a
  forgotten install or a forgotten close remains (the hole §1 closed for "wrap every handler" reopens per
  listener). `ConnectInfo`, the stop signal and the SSE connection count would need wiring of their own. Rejected.
- **Add and remove listeners on one `RunningServer`** (another shape of option 1 of Issue #947): with one shared
  gate, the gate cannot be closed while only the TLS listener is stopped and rebuilt, so "count and wait for that
  generation's writes" is not possible. With a gate per listener inside it, it rebuilds a `RunningServer` per
  listener within one type. Rejected (one per listener, sharing the budget; §9).
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
  - **Outcome of S2 (2026-11-22)**: the rules are in conventions §1. Authorization is decided when the guards
    pass, and a write that passed runs to the end (revocation takes effect from the next request). The exception
    is a handler that waits on the client after its guards: a route that accepts a body over 2 MiB (streamed to
    the handler, §7) decides again once the body is in (`routes::recheck_role_at_least`; added to the backup
    upload, the attachment upload and the items bulk import - not by body size: on such a route a small body is
    decided again the same way). The raised limit (`DefaultBodyLimit`) goes on that route alone, never on the
    whole router. The second decision settles the token's presence, expiry and stamp under one lock after the
    account lookup (`AuthState::settle_lookup`). REST's `record_write`, which looks the audit actor up again after the write, is fixed in C2
    (ADR-0034 §3).
- Tests: `crates/banto-server/tests/detach_writes.rs` (both steps run after a disconnect / a GET is still dropped /
  a panic is 500 / a stop waits for a running write / a write that does not end is reported as remaining / §9: a
  write on a listener of the app's own is detached and has `ConnectInfo` / stopping two listeners together waits
  for the writes of both / a write left running is reported by the listener it came in on / while one listener is
  replaced the other's writes stay detached / the budget is shared across listeners), the unit test in `server.rs`
  (`stop_all` closes every gate before it waits / a `StopHandle` does not keep a dropped listener serving /
  `is_serving` turns false when the accept task ends on its own, and at once after a requested stop), in the
  same `detach_writes.rs`: after a stop requested from outside neither a connection nor a write is accepted / a
  write detached before the request runs to the end / writes left by an earlier generation are not in the results
  of `stop_all`, the unit
  tests in `detach.rs` (after the gate closed: 503 and the handler never runs) and `exposure.rs` (the direction;
  mixed changes count as narrowing), `apps/admin-template/core/src/rest/tests/detach.rs` (the real
  `POST /api/users`: account and audit row survive the disconnect),
  `apps/admin-template/src-tauri/src/tests/server_writes.rs` (both directions of a reconfiguration).

## Owner decisions (2026-11-22, all five as recommended)

1. The **10 second** bound at a stop (alongside the 5 seconds for connections). Changing LAN settings during a long
   write such as a backup makes a widening change fail with "apply again".
2. Panic and stopping responses use `other` (500 / 503) rather than a new kind.
3. The bound of 256 concurrent writes (only new ones are refused) and no limit on the duration of one (§7).
4. A narrowing change that still needs a listener is saved and then returned as an **error** (`leftClosed`; the UI
   shows the error text).
5. Desktop exit stays as it is (§8).
