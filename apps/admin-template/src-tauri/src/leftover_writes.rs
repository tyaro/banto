//! Writes that stopped listeners left running (Issue #793, ADR-0035).
//!
//! `RunningServer::stop` never aborts a write it accepted; when its wait runs
//! out it hands back a [`RemainingWrites`]. `server_apply` keeps those here
//! (in the `ServerSlot`, under the `state.server` lock) across applies, so a
//! later apply still knows that a write of an old listener is running and
//! does not start a listener for a new configuration next to it.

use banto_server::RemainingWrites;
use std::time::Duration;

/// How many operations [`LeftoverWrites::audit_detail`] lists at most, over
/// all stopped listeners together (the count stays exact).
const AUDIT_OPERATIONS_MAX: usize = 8;

/// The unfinished writes of every listener stopped so far.
#[derive(Default)]
pub(crate) struct LeftoverWrites(Vec<RemainingWrites>);

impl LeftoverWrites {
    /// Keep track of the writes one stop left running.
    pub(crate) fn add(&mut self, remaining: RemainingWrites) {
        self.0.push(remaining);
    }

    /// Waits until every tracked write is done, for at most `limit` in all,
    /// and forgets the listeners whose writes are done. `true` when none is
    /// left.
    pub(crate) async fn wait(&mut self, limit: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        for remaining in &self.0 {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            remaining.wait(left).await;
        }
        self.0.retain(|remaining| !remaining.is_finished());
        self.0.is_empty()
    }

    /// How many writes are running now.
    pub(crate) fn count(&self) -> usize {
        self.0.iter().map(RemainingWrites::count).sum()
    }

    /// For the audit detail of the apply that left them behind: how many (the
    /// exact total), and which (`METHOD path`) as far as known - at most
    /// [`AUDIT_OPERATIONS_MAX`] in all, however many listeners are tracked.
    pub(crate) fn audit_detail(&self) -> serde_json::Value {
        let operations: Vec<String> = self
            .0
            .iter()
            .flat_map(RemainingWrites::operations)
            .take(AUDIT_OPERATIONS_MAX)
            .collect();
        serde_json::json!({
            "count": self.count(),
            "operations": operations,
        })
    }
}
