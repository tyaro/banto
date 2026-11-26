//! The writes of an app over all the generations of its listeners
//! (Issue #981, ADR-0035 §9).
//!
//! An app that stops and replaces listeners - a TLS listener rebuilt for each
//! renewed or revoked certificate - has, at its final stop, more to account
//! for than the listeners that are running then: a generation it stopped
//! earlier may have left writes running ([`StopOutcome::WritesRemaining`]),
//! and a generation that is being built at that very moment must not come up
//! with an open gate. [`WriteLedger`] keeps that account, so the app does not
//! write it itself.

use crate::detach::{StopOutcome, WriteBudget};
use crate::server::{RunningServer, StopHandle, STOP_TIMEOUT};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::time::Instant;

/// The account of an app's writes over every generation of its listeners
/// (Issue #981, ADR-0035 §9): the shared [`WriteBudget`], the gate of each
/// listener entered in it, the writes that stopped listeners left running,
/// and a latch that says the app's final stop has begun.
///
/// Cloneable; all clones are the same ledger. Make one per app, serve every
/// listener - every generation of it - with
/// [`BoundServer::with_write_ledger`](crate::BoundServer::with_write_ledger),
/// and make the final stop with [`Self::stop_all_until`]:
///
/// ```no_run
/// # async fn demo(
/// #     plain: banto_server::BoundServer,
/// #     router: axum::Router,
/// # ) {
/// use banto_server::WriteLedger;
/// use std::time::Duration;
///
/// let ledger = WriteLedger::new();
/// let plain = plain.with_write_ledger(&ledger).serve(router);
/// // ... the TLS listener is served the same way, and so is each listener
/// // that replaces it; the replaced one is stopped with `stop()` as before.
///
/// let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
/// let outcome = ledger.stop_all_until([plain], deadline).await;
/// if outcome.running > 0 {
///     eprintln!("still writing: {}", outcome.remaining.join(", "));
/// }
/// # }
/// ```
///
/// Stopping one generation to replace it stays what it was
/// ([`RunningServer::stop`] and its siblings, on that listener alone). The
/// ledger only takes over what spans generations.
///
/// It does not grow with the number of generations: a listener leaves the
/// ledger once it is stopped (or dropped) and its writes are done.
#[derive(Clone, Default)]
pub struct WriteLedger(Arc<Inner>);

#[derive(Default)]
struct Inner {
    budget: WriteBudget,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Set by [`WriteLedger::close_all`], never cleared.
    closed: bool,
    /// One per listener that is serving, being stopped, or stopped with
    /// writes still running. A handle does not keep its listener serving.
    listeners: Vec<StopHandle>,
}

impl State {
    /// Drops the listeners that have nothing left to account for: the
    /// [`RunningServer`] is gone and no write of it is running.
    fn sweep(&mut self) {
        self.listeners.retain(|listener| {
            if !listener.listener_gone() {
                return true;
            }
            // Gone by a stop: the gate is closed already. Gone by a plain
            // drop: its connections are winding down, but its gate was never
            // closed - close it, so that the count read next cannot go up
            // again after the listener left the ledger.
            listener.writes().close();
            listener.writes().count() > 0
        });
    }
}

impl WriteLedger {
    /// A ledger with a budget of its own.
    pub fn new() -> Self {
        Self::default()
    }

    /// A ledger over a budget that exists already - for an app that has
    /// listeners counting against it ([`RunningServer::write_budget`]) before
    /// it makes the ledger. Listeners that share the budget without being
    /// entered in the ledger are counted in [`LedgerOutcome::running`], but
    /// the ledger cannot close their gates or name their writes.
    pub fn from_budget(budget: WriteBudget) -> Self {
        Self(Arc::new(Inner {
            budget,
            state: Mutex::default(),
        }))
    }

    /// The budget every listener in this ledger counts against.
    /// [`WriteBudget::running`] of it is the number of writes running over
    /// all generations.
    pub fn budget(&self) -> WriteBudget {
        self.0.budget.clone()
    }

    /// Whether [`Self::close_all`] was called: a listener entered from now on
    /// comes up stopped.
    pub fn is_closed(&self) -> bool {
        self.state().closed
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // Nothing that can panic runs under the lock; the list stays
        // consistent either way.
        self.0
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Enters one listener (from `BoundServer::serve`). The latch is read and
    /// the listener is added under ONE lock, the same one
    /// [`Self::close_all`] sets the latch and walks the list under: a
    /// listener is either in the list `close_all` walks, or sees the latch
    /// here. No gate stays open past `close_all`.
    pub(crate) fn register(&self, listener: StopHandle) {
        let mut state = self.state();
        state.sweep();
        if state.closed {
            listener.request_stop();
        }
        state.listeners.push(listener);
    }

    /// Begins the stop of everything, and returns at once: requests the stop
    /// of every listener in the ledger ([`StopHandle::request_stop`] - its
    /// gate is closed before this returns, its connections are told to end)
    /// and latches, so that a listener entered LATER - one that was being
    /// rebuilt while this ran - comes up with its stop requested instead of
    /// serving. Plain (non-async) and callable from any thread, any number of
    /// times. There is no way to undo it.
    ///
    /// Accepted writes are not stopped. Wait for them, and finish the stop of
    /// the listeners, with [`Self::stop_all_until`].
    pub fn close_all(&self) {
        let mut state = self.state();
        state.closed = true;
        state.sweep();
        for listener in &state.listeners {
            listener.request_stop();
        }
    }

    /// `METHOD path` of the writes running now on the listeners of this
    /// ledger, generation by generation (each generation lists a bounded
    /// number, like [`RemainingWrites::operations`](crate::RemainingWrites::operations)).
    fn running_operations(&self) -> Vec<String> {
        let mut state = self.state();
        state.sweep();
        state
            .listeners
            .iter()
            .flat_map(|listener| listener.writes().operations())
            .collect()
    }

    /// The app's final stop: stops `servers` and waits, until `deadline`, for
    /// every write of every generation.
    ///
    /// 1. [`Self::close_all`]: no listener of the ledger starts a write from
    ///    here on, also not one that is entered later.
    /// 2. The listeners given are stopped side by side, in the order of
    ///    [`RunningServer::stop_all_within`]. Their connections are waited
    ///    for until `deadline`, but for 5 seconds at most (the bound of
    ///    [`RunningServer::stop`]); their writes until `deadline`.
    /// 3. Until `deadline`, it waits for the shared budget to report no
    ///    running write ([`WriteBudget::running`] is 0).
    ///
    /// Step 3 is what covers the earlier generations, and it deliberately
    /// does not wait on a list of them taken at the start: a generation that
    /// is stopped WHILE this runs (a revoked one, whose own stop does not
    /// wait for its writes at all) would be missing from such a list, and
    /// the app would go on to close its database under a running write. The
    /// budget counts every write of every generation, whenever its listener
    /// was stopped.
    ///
    /// A `deadline` that has passed is not an error: nothing is waited for
    /// (a listener whose connections are still open has its task aborted at
    /// once), and the result says what is running.
    ///
    /// `servers` are the listeners that are running now - normally all of
    /// them in this ledger. A listener of the ledger that is neither given
    /// here nor stopped by its owner has its stop requested (step 1) but is
    /// not waited for beyond its writes. `servers` may be empty.
    pub async fn stop_all_until(
        &self,
        servers: impl IntoIterator<Item = RunningServer>,
        deadline: Instant,
    ) -> LedgerOutcome {
        self.close_all();
        let left = deadline.saturating_duration_since(Instant::now());
        let servers = RunningServer::stop_all_within(servers, STOP_TIMEOUT.min(left), left).await;
        self.0.budget.wait_idle_until(deadline).await;
        // The names first: a write that finishes in between is then missing
        // from the names rather than from the count.
        let remaining = self.running_operations();
        LedgerOutcome {
            servers,
            running: self.0.budget.running(),
            remaining,
        }
    }
}

impl std::fmt::Debug for WriteLedger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (closed, listeners) = {
            let state = self.state();
            (state.closed, state.listeners.len())
        };
        f.debug_struct("WriteLedger")
            .field("closed", &closed)
            .field("listeners", &listeners)
            .field("running", &self.0.budget.running())
            .finish()
    }
}

/// What [`WriteLedger::stop_all_until`] found at its deadline.
#[derive(Debug)]
#[non_exhaustive]
pub struct LedgerOutcome {
    /// One result per listener given, in the order given - what
    /// [`RunningServer::stop_all_within`] returns. A `WritesRemaining` here
    /// was true when that listener's stop ended; `running` below is read
    /// later.
    pub servers: Vec<StopOutcome>,
    /// The writes still running under the ledger's budget
    /// ([`WriteBudget::running`]), over all generations. 0: every write is
    /// done, and - the gates being closed - none will start.
    pub running: usize,
    /// `METHOD path` of the writes still running on the listeners of the
    /// ledger, for a log or an audit detail. Bounded per generation;
    /// `running` is the exact number.
    pub remaining: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{bind, ServerConfig};
    use axum::Router;
    use std::time::Duration;

    fn local() -> ServerConfig {
        ServerConfig {
            bind: "127.0.0.1".to_string(),
            port: 0,
        }
    }

    async fn serve_in(ledger: &WriteLedger) -> RunningServer {
        bind(local())
            .await
            .expect("bind")
            .with_write_ledger(ledger)
            .serve(Router::new())
    }

    fn listeners(ledger: &WriteLedger) -> usize {
        let mut state = ledger.state();
        state.sweep();
        state.listeners.len()
    }

    #[tokio::test]
    async fn stopped_generations_leave_the_ledger_once_their_writes_are_done() {
        let ledger = WriteLedger::new();
        for _ in 0..3 {
            let server = serve_in(&ledger).await;
            assert_eq!(listeners(&ledger), 1, "only the one that is serving");
            assert!(matches!(server.stop().await, StopOutcome::Finished));
        }
        assert_eq!(listeners(&ledger), 0);

        // One that left a write stays exactly until the write is done.
        let server = serve_in(&ledger).await;
        let write = server.hold_write_for_test("POST /left").expect("accepted");
        let left = server.stop_within(Duration::ZERO, Duration::ZERO).await;
        assert!(matches!(left, StopOutcome::WritesRemaining(_)));
        assert_eq!(listeners(&ledger), 1);
        drop(write);
        assert_eq!(listeners(&ledger), 0);
    }

    #[tokio::test]
    async fn a_listener_in_a_ledger_counts_against_the_ledgers_budget_only() {
        let ledger = WriteLedger::new();
        let other = WriteBudget::default();
        let server = bind(local())
            .await
            .expect("bind")
            .with_write_ledger(&ledger)
            .with_write_budget(other.clone())
            .serve(Router::new());
        let write = server.hold_write_for_test("POST /w").expect("accepted");
        assert_eq!(ledger.budget().running(), 1);
        assert_eq!(other.running(), 0);
        drop(write);
        server.stop().await;
    }

    #[tokio::test]
    async fn the_budget_wait_ends_when_the_last_write_gives_its_place_back() {
        let ledger = WriteLedger::new();
        let server = serve_in(&ledger).await;
        let first = server.hold_write_for_test("POST /a").expect("accepted");
        let second = server.hold_write_for_test("POST /b").expect("accepted");
        let budget = ledger.budget();
        let past = Instant::now();
        assert!(!budget.wait_idle_until(past).await, "two are running");

        let waiting = {
            let budget = budget.clone();
            tokio::spawn(async move {
                budget
                    .wait_idle_until(Instant::now() + Duration::from_secs(30))
                    .await
            })
        };
        drop(first);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished(), "one is still running");
        drop(second);
        assert!(waiting.await.expect("join"));
        assert!(budget.wait_idle_until(past).await, "idle is seen at once");
        server.stop().await;
    }
}
