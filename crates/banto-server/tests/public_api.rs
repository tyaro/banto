//! Pins the parts of `banto-server`'s API that derived apps depend on, from
//! OUTSIDE the crate (an integration test is compiled as a separate crate).
//!
//! A unit test inside `src/` still compiles if an item is narrowed from `pub`
//! back to `pub(crate)`; this file does not. Each function here is
//! compile-only - it is never called - so it pins visibility and signature,
//! not behaviour (behaviour is covered by the unit tests in `src/auth.rs`).

#![allow(dead_code)]

use banto_core::BantoError;
use banto_server::{AuthState, AuthenticatedSession};

/// Issue #239: `AuthState::revalidate` is public so a derived app's own
/// long-lived stream (banto-industrial#430) can re-check a session without
/// sliding its idle window. Reverting it to `pub(crate)` must fail this
/// test's compilation.
async fn revalidate_is_public(
    auth: &AuthState,
    token: &str,
) -> Result<Option<AuthenticatedSession>, BantoError> {
    auth.revalidate(token).await
}
