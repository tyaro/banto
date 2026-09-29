# ADR-0016: Give the front end's session one writer (SessionController), make the provider answer in one round trip, and write credentials only by compare-and-set

> 日本語: [0016-session-controller-single-writer.md](0016-session-controller-single-writer.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

- Status: Proposed (design PR; the implementation PRs move it to Accepted)
- Date: 2026-09-29
- Related: Issue #260, #255, #257, #259, #241, #204 / spec §3.3, §8.1 / conventions §10 /
  ADR-0014 (account-bound revocation) / ADR-0012 (synthetic viewer session) /
  design body: [docs/session-controller-design.md](../session-controller-design.md) (Japanese only)

## Context

PR #255 (#215: keeping list view state) went through six review rounds over asynchronous
races. Every finding in rounds 5 and 6 had the same shape - "a stale authentication answer
starts, ends or overwrites the current session" - and every fix was "capture the scope when
the request starts and compare it in the same continuation the answer arrives in, before
applying it". In `019f6e9` (main after #255) that comparison lives in four places
(`sessionGate.ts`, `sessionLifecycle.ts`, `sessionEnded.ts`, and the app's `sessionStore`).
The derived app banto-hub rebuilds the same comparison on its own in `sessionRecheck.ts`.

Two root causes (the design body §1 backs them with code):

1. Module singletons are written from inside SvelteKit `load`. SvelteKit discards the result
   of an overtaken navigation but cannot stop its side effects.
2. An `AuthProvider` answer does not say which credential it is about. `check()` and
   `getIdentity()` make separate round trips, and `check()` has the side effect of clearing
   the credential.

The owner also pointed out that the **Tauri Rust side** has the same shape, and the code
confirms it: `auth_login` (lines 646-647) and `auth_setup` (622-623) write `state.auth`
unconditionally after an `.await`, and `auth_logout` (690-691) clears it unconditionally
after an `.await`. "Login starts -> logout completes -> the slow login completes" revives
the Rust session; the reverse order erases a login that had already been confirmed. In the
same file, `auth_config_apply_body`, `change_own_password` and `settle_session` already
compare before writing.

Constraints:

- It must hold on both the REST and the Tauri path (ADR-0001). The REST server keeps a
  per-token map, so there is no shared single slot there; the single slots are the browser's
  token storage (#259) and Tauri's `state.auth`.
- The two derived apps (banto-industrial's chronogazer and banto-hub) are pinned to `v1.7.3`
  and should migrate once (plan A′).
- No new dependencies (ADR-0002), no new package.
- "Could not verify" is never evidence of "ended" (#204, a consequence of ADR-0014).

## Decision

1. **One writer.** Only `commit()` inside `SessionController` changes the front end's
   confirmed session state (`status`, `owner`, `generation`, `identity`, `kind`). The public
   entry points are four: `resolve()` (applying a verification), `adopt()` (an app-policy
   synthetic session), `end()`, and the suspension caused by a credential change. **Only the
   controller moves the confirmed state to its ended state**; disposing of credentials and
   revoking on the backend belong to the provider and the backend.
2. **Two different `resolve()`s.** `AuthProvider.resolve()` answers `none` /
   `active + identity` in one round trip and **rejects** when it cannot obtain an answer.
   `SessionController.resolve()` **never rejects**; it returns, for this request,
   `confirmed` / `unverified` / `superseded`. Callers do not infer the outcome from the shared
   snapshot's `lastError`.
3. **Freshness enforced by structure.** A provider answer may be committed only if the
   (controller transition count, credential revision) captured when the probe started still
   match at application time and no signal arrived after the probe started. The comparison and
   the `commit` happen in one continuation. Verification is single-flight with a wait deadline.
4. **Credential writes and clears are compare-and-set.** Both the HTTP provider's token
   storage (#259) and Tauri's `state.auth` (an `AuthSlot` with a `seq`) write only when the
   revision / seq read at the start of the operation still matches. Authentication operations
   (login / logout / setup / enterPublicViewer) are not queued behind the controller, their
   return values are not committed directly, and the session is confirmed by the following
   `resolve()`.
5. **A credential switch suspends.** As soon as a switch is known, the state becomes
   `unknown`, ownerless, `generation + 1`; a later failed verification does not fall back to
   the previous owner's active state. This is distinct from a transient failure with the same
   credential (which keeps the confirmed state).
6. **SvelteKit boundary.** The only side effect in `load` is `controller.resolve()`.
   `{#key generation}`, the public-viewer fallback and commissioning's `adopt()` are app-layer
   policies. The `enterPublicViewer` call leaves core's `sessionGate.ts`.
7. **Version.** #255 and this change ship together as **v2.0.0** (publishing.md: a change of
   meaning is a major). `establishSession` / `beginSession` / `endSession` /
   `resolveProtectedSession` / `confirmSessionEnded` are slated for removal (whether to keep
   delegating wrappers is the owner's call; design body §5.4, §9).

The invariants (I-1 to I-15), the race scenario tables (S-1 to S-45), the API sketch, the
migration and PR split, and the test design live in the design body. The implementation PRs
reference those numbers from test names.

## Alternatives considered

- **Option A (adopted): concentrate confirmation in a SessionController and add a
  one-round-trip `resolve()` plus compare-and-set to the provider.** Pros: one place compares,
  `load` loses its side effects, derived apps stop assembling authentication. The Rust side
  aligns with the shape it already has in `settle_session`. Cons: the public API changes
  meaning (major); the derived apps migrate once.
- **Option B (rejected): keep adding comparisons to the four existing places (#255
  continued).** Six rounds showed the gaps cannot be prevented structurally (split
  continuations, forgotten calls). Derived apps keep their own copies.
- **Option C (rejected): wrap `AuthProvider` in a `Proxy` to observe login / logout and write
  state there.** Tried and dropped in #255 rounds 2-3 (breaks class receivers and frozen
  objects; cannot see other tabs).
- **Option D (rejected): serialize every authentication operation through the controller's
  queue.** A slow login would block retry and logout, hurting safety and retryability. What is
  needed is not ordering but "never apply a stale answer", which compare-and-set gives.
- **Option E (rejected): use the Web Locks API for atomic `localStorage` updates.** Cross-tab
  compare-and-set is impossible in principle with storage alone, but the guarantee we want is
  "no tab keeps using the previous owner as active", and suspension on the storage event gives
  that. Browser support would also need checking. What is and is not guaranteed is written down
  in design body §4.6.
- **Option F (rejected): hold the Rust `Mutex` across `.await` to serialize.** Tauri commands
  run concurrently; holding the lock across awaits would also serialize `current_session`'s DB
  re-validation. The "compare and write under one lock" shape from PR #182 suffices and matches
  the three existing sites.

## Consequences

- Three implementation PRs (provider + backend / controller / admin-template wiring and
  v2.0.0), then one migration PR in banto-industrial that both migrates the two apps and moves
  their references to the final tag, after verifying on a candidate commit.
- Derived apps read `controller.snapshot` whole instead of assembling "check -> identity ->
  generation -> state"; role is derived from the identity.
- Any new verification path is demoted to `controller.signal()`. No new code outside the
  controller calls `check()` / `getIdentity()` and writes state (a review checkpoint).
- On the Rust side, every write to `state.auth` goes through `cas_session`, including in new
  commands.
- What is not guaranteed is documented: which of two simultaneous tabs wins, and requests sent
  in the milliseconds before the credential-change event is delivered.
- The compatibility behavior of collapsing failures into `null` is not kept as the standard of
  the new shared code.
