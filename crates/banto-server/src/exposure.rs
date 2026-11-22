//! Which way a change of the listener's configuration moves its exposure
//! (Issue #793, ADR-0035).
//!
//! When a listener is stopped to apply new settings and writes it accepted
//! are still running ([`crate::StopOutcome::WritesRemaining`]), the caller
//! has two ways out, and which one is safe depends on the direction of the
//! change:
//!
//! - **widening or equal** (another port, a wider bind, public viewing turned
//!   on): fail the switch and bring the previous listener back. The remaining
//!   writes finish under the configuration that accepted them.
//! - **narrowing** (server disabled, public viewing turned off, a narrower
//!   bind): the previous listener must NOT come back - that would leave open
//!   exactly what the user just closed (fail-open).
//!
//! [`restoring_previous_stays_within`] is that decision as a pure function,
//! so it can be tested here although the apply itself lives in the app's
//! Tauri layer. A change that widens one thing and narrows another counts as
//! narrowing (never restore).

use std::net::IpAddr;

/// What a listener configuration exposes. The port is not part of it: a
/// different port reaches the same clients.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerExposure {
    /// Whether a listener serves at all.
    pub listening: bool,
    /// The bind address as configured (`"127.0.0.1"`, `"0.0.0.0"`, `"[::1]"`,
    /// ...). Ignored when `listening` is false.
    pub bind: String,
    /// Whether clients may get a `viewer` session without logging in
    /// (閲覧公開). Ignored when `listening` is false.
    pub viewer_public: bool,
}

impl ServerExposure {
    /// Nothing is served.
    pub fn closed() -> Self {
        Self {
            listening: false,
            bind: String::new(),
            viewer_public: false,
        }
    }
}

/// How far a bind address reaches, when it can be told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BindReach {
    /// This machine only.
    Loopback,
    /// One specific non-loopback address.
    Address(IpAddr),
    /// Every address of one family (`0.0.0.0`, `::`).
    Unspecified { v6: bool },
}

fn bind_reach(bind: &str) -> Option<BindReach> {
    let trimmed = bind.trim();
    let bare = trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(trimmed);
    let ip: IpAddr = bare.parse().ok()?;
    Some(if ip.is_loopback() {
        BindReach::Loopback
    } else if ip.is_unspecified() {
        BindReach::Unspecified { v6: ip.is_ipv6() }
    } else {
        BindReach::Address(ip)
    })
}

/// Whether everything reachable through `previous` is also reachable through
/// `requested`. Anything that cannot be told (a host name, two different
/// addresses, `0.0.0.0` against `::`) is "no".
fn bind_within(previous: &str, requested: &str) -> bool {
    if previous.trim() == requested.trim() {
        return true;
    }
    match (bind_reach(previous), bind_reach(requested)) {
        (Some(previous), Some(requested)) => match (previous, requested) {
            // Loopback is the least exposure there is.
            (BindReach::Loopback, _) => true,
            (BindReach::Address(a), BindReach::Address(b)) => a == b,
            (BindReach::Address(address), BindReach::Unspecified { v6 }) => address.is_ipv6() == v6,
            (BindReach::Unspecified { v6: a }, BindReach::Unspecified { v6: b }) => a == b,
            (BindReach::Address(_) | BindReach::Unspecified { .. }, BindReach::Loopback)
            | (BindReach::Unspecified { .. }, BindReach::Address(_)) => false,
        },
        _ => false,
    }
}

/// Whether bringing `previous` back exposes nothing more than `requested`
/// asked for - the only case in which a failed switch may restore the
/// previous listener (see the module doc).
///
/// `true` for a widening or equal change, `false` as soon as one item
/// (listening at all, the bind address, public viewing) is narrower in
/// `requested` than in `previous` - also when another item widens.
pub fn restoring_previous_stays_within(
    previous: &ServerExposure,
    requested: &ServerExposure,
) -> bool {
    if !previous.listening {
        // Nothing to bring back: staying closed exposes nothing.
        return true;
    }
    if !requested.listening {
        return false;
    }
    if previous.viewer_public && !requested.viewer_public {
        return false;
    }
    bind_within(&previous.bind, &requested.bind)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(bind: &str, viewer_public: bool) -> ServerExposure {
        ServerExposure {
            listening: true,
            bind: bind.to_string(),
            viewer_public,
        }
    }

    #[test]
    fn equal_and_widening_changes_may_restore() {
        // Equal (only the port differs - not part of the exposure).
        assert!(restoring_previous_stays_within(
            &open("127.0.0.1", false),
            &open("127.0.0.1", false)
        ));
        // A wider bind.
        assert!(restoring_previous_stays_within(
            &open("127.0.0.1", false),
            &open("0.0.0.0", false)
        ));
        assert!(restoring_previous_stays_within(
            &open("192.168.1.5", false),
            &open("0.0.0.0", false)
        ));
        assert!(restoring_previous_stays_within(
            &open("[::1]", false),
            &open("::", false)
        ));
        // Public viewing turned on.
        assert!(restoring_previous_stays_within(
            &open("0.0.0.0", false),
            &open("0.0.0.0", true)
        ));
        // Nothing was listening: "restoring" leaves it closed.
        assert!(restoring_previous_stays_within(
            &ServerExposure::closed(),
            &open("0.0.0.0", true)
        ));
        assert!(restoring_previous_stays_within(
            &ServerExposure::closed(),
            &ServerExposure::closed()
        ));
    }

    #[test]
    fn narrowing_changes_must_not_restore() {
        // Server disabled.
        assert!(!restoring_previous_stays_within(
            &open("127.0.0.1", false),
            &ServerExposure::closed()
        ));
        // Public viewing turned off.
        assert!(!restoring_previous_stays_within(
            &open("0.0.0.0", true),
            &open("0.0.0.0", false)
        ));
        // A narrower bind.
        assert!(!restoring_previous_stays_within(
            &open("0.0.0.0", false),
            &open("127.0.0.1", false)
        ));
        assert!(!restoring_previous_stays_within(
            &open("0.0.0.0", false),
            &open("192.168.1.5", false)
        ));
        assert!(!restoring_previous_stays_within(
            &open("192.168.1.5", false),
            &open("127.0.0.1", false)
        ));
    }

    #[test]
    fn a_mixed_change_counts_as_narrowing() {
        // Wider bind, but public viewing turned off.
        assert!(!restoring_previous_stays_within(
            &open("127.0.0.1", true),
            &open("0.0.0.0", false)
        ));
        // Public viewing turned on, but a narrower bind.
        assert!(!restoring_previous_stays_within(
            &open("0.0.0.0", false),
            &open("127.0.0.1", true)
        ));
    }

    #[test]
    fn what_cannot_be_compared_counts_as_narrowing() {
        // Two different addresses.
        assert!(!restoring_previous_stays_within(
            &open("192.168.1.5", false),
            &open("10.0.0.5", false)
        ));
        // Different families of "every address".
        assert!(!restoring_previous_stays_within(
            &open("0.0.0.0", false),
            &open("::", false)
        ));
        assert!(!restoring_previous_stays_within(
            &open("192.168.1.5", false),
            &open("::", false)
        ));
        // A host name is only "within" itself.
        assert!(!restoring_previous_stays_within(
            &open("localhost", false),
            &open("0.0.0.0", false)
        ));
        assert!(restoring_previous_stays_within(
            &open("localhost", false),
            &open("localhost", true)
        ));
    }
}
