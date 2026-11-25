//! Pins the parts of `banto-server`'s API that derived apps depend on, from
//! OUTSIDE the crate (an integration test is compiled as a separate crate).
//!
//! A unit test inside `src/` still compiles if an item is narrowed from `pub`
//! back to `pub(crate)`; this file does not. Each function here is
//! compile-only - it is never called - so it pins visibility and signature,
//! not behaviour (behaviour is covered by the unit tests in `src/auth/tests.rs`).

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

/// banto-industrial#505: a derived app's desktop shell that navigates its
/// Tauri webview to this server's HTTP UI widens `connect-src` with Tauri IPC
/// for loopback peers only, and its tests compare the window CSP against
/// `content_security_policy()`. Narrowing any of these must fail compilation.
fn security_headers_connect_src_api_is_public(router: axum::Router) -> axum::Router {
    use banto_server::{
        request_from_loopback_peer, with_security_headers_using, InvalidCspSource, SecurityHeaders,
        CONTENT_SECURITY_POLICY, TAURI_IPC_CONNECT_SRC,
    };
    let _: &str = CONTENT_SECURITY_POLICY;
    let config: Result<SecurityHeaders, InvalidCspSource> =
        SecurityHeaders::new().extra_connect_src(TAURI_IPC_CONNECT_SRC);
    let config = config
        .expect("static sources are valid")
        .extra_connect_src_when(request_from_loopback_peer);
    let _: String = config.content_security_policy();
    with_security_headers_using(router, config)
}

/// banto-industrial#505 follow-up (2026-10-06): the recommended selector also
/// requires a loopback request authority, so LAN viewers behind a
/// `Host`-preserving same-host reverse proxy keep the strict policy.
fn security_headers_loopback_local_selector_is_public(router: axum::Router) -> axum::Router {
    use banto_server::{
        request_is_loopback_local, with_security_headers_using, SecurityHeaders,
        TAURI_IPC_CONNECT_SRC,
    };
    let _: fn(&axum::extract::Request) -> bool = request_is_loopback_local;
    let config = SecurityHeaders::new()
        .extra_connect_src(TAURI_IPC_CONNECT_SRC)
        .expect("static sources are valid")
        .extra_connect_src_when(request_is_loopback_local);
    with_security_headers_using(router, config)
}

/// Issue #793 / ADR-0035: a caller that stops a listener and starts another
/// one (a derived app's own settings apply) has to see whether writes were
/// left running, wait for them, and tell which way the change moves the
/// exposure. Narrowing any of these must fail compilation.
async fn stop_outcome_and_exposure_api_is_public(server: banto_server::RunningServer) -> bool {
    use banto_server::{
        restoring_previous_stays_within, RemainingWrites, ServerExposure, StopOutcome,
        DETACHED_WRITES_STOP_TIMEOUT,
    };
    let outcome: StopOutcome = server
        .stop_waiting_writes_for(DETACHED_WRITES_STOP_TIMEOUT)
        .await;
    let remaining: Option<RemainingWrites> = outcome.remaining();
    if let Some(remaining) = remaining {
        let _: usize = remaining.count();
        let _: Vec<String> = remaining.operations();
        let _: bool = remaining.is_finished();
        let _: bool = remaining.wait(DETACHED_WRITES_STOP_TIMEOUT).await;
    }
    let requested = ServerExposure {
        listening: true,
        bind: "127.0.0.1".to_string(),
        viewer_public: false,
    };
    restoring_previous_stays_within(&ServerExposure::closed(), &requested)
}

/// Issue #947 (ADR-0035 §9): a derived app serves a listener of its own (a
/// TLS listener) through the same `serve`, on the budget of its plain
/// listener, and stops them together.
async fn serving_a_listener_of_the_apps_own_is_public<L>(
    listener: L,
    plain: banto_server::RunningServer,
    router: axum::Router,
) -> Result<Vec<banto_server::StopOutcome>, BantoError>
where
    L: axum::serve::Listener<Addr = std::net::SocketAddr>,
{
    let bound: banto_server::BoundServer<L> = banto_server::BoundServer::from_listener(listener)?;
    let _: std::net::SocketAddr = bound.local_addr();
    let own: banto_server::RunningServer =
        bound.with_write_budget(plain.write_budget()).serve(router);
    Ok(banto_server::RunningServer::stop_all([plain, own]).await)
}

/// ADR-0035 §7: an app that replaces its listener shares one write budget
/// over the generations.
fn write_budget_api_is_public(
    old: &banto_server::RunningServer,
    bound: banto_server::BoundServer,
) -> banto_server::BoundServer {
    let budget: banto_server::WriteBudget = old.write_budget();
    let _: usize = budget.running();
    let _: usize = banto_server::MAX_DETACHED_WRITES;
    bound.with_write_budget(budget)
}

/// Issue #935 (design `docs/design/sse-stream-design.md` §4.3): the
/// foundation of an app's own SSE stream. A derived app's handler takes an
/// `SseContext`, sets its conditions, and returns `sse_response`; the frames
/// come from a `watch` or a `broadcast`. Narrowing or re-shaping any of
/// these must fail compilation - in particular `sse_response` takes NO
/// `AuthState` (the context carries the one that authorized the request).
async fn sse_foundation_api_is_public(
    context: banto_server::SseContext,
    values: tokio::sync::watch::Receiver<Vec<f64>>,
    alarms: tokio::sync::broadcast::Receiver<String>,
    permission: banto_admin_services::permissions::PermissionKey,
) -> axum::response::Response {
    use banto_server::sse::{REVALIDATE_INTERVAL, REVALIDATE_TIMEOUT};
    use banto_server::{
        broadcast_frames, sse_response, watch_frames, InvalidSseEventName, SessionPermissions,
        SseContext, SseFrame,
    };
    use futures_util::{Stream, StreamExt};

    // The constants stay reachable on their pre-#935 path too.
    let _: std::time::Duration = REVALIDATE_INTERVAL;
    let _: std::time::Duration = banto_server::events::REVALIDATE_INTERVAL;
    let _: std::time::Duration = REVALIDATE_TIMEOUT;
    let _: std::time::Duration = banto_server::events::REVALIDATE_TIMEOUT;

    let json: Result<SseFrame, serde_json::Error> = SseFrame::json(&[1.0, 2.0]);
    let named: Result<SseFrame, InvalidSseEventName> = SseFrame::text("line").event("note");
    if let Err(InvalidSseEventName { name, reason }) = &named {
        let _: (&String, &&'static str) = (name, reason);
    }
    let _: bool = json.ok() == named.clone().ok();

    // `T` needs no `Clone` for a `watch`; the closures are `FnMut`.
    struct NotClone(f64);
    let (_tx, not_clone) = tokio::sync::watch::channel(NotClone(0.0));
    let mut sent = 0usize;
    let _ = watch_frames(not_clone, move |value: &NotClone| {
        sent += 1;
        SseFrame::json(&(value.0, sent)).ok()
    });

    fn is_send_stream<S: Stream<Item = SseFrame> + Send + 'static>(stream: S) -> S {
        stream
    }
    let values = is_send_stream(watch_frames(values, |values| {
        SseFrame::json(values).ok()?.event("values").ok()
    }));
    let alarms = is_send_stream(broadcast_frames(alarms, |alarm: &String| {
        SseFrame::text(alarm.as_str()).event("alarm").ok()
    }));

    let context: SseContext = context
        .counted_as_client()
        .require_permission(permission)
        .reauthorize_with(
            |session: &AuthenticatedSession, permissions: &SessionPermissions| {
                session.grant.is_none() && !permissions.is_empty()
            },
        );
    sse_response(
        context,
        futures_util::stream::select(values.boxed(), alarms.boxed()),
    )
}

/// `SseContext` is an extractor for any router state, so a handler can take
/// it next to `State<_>` / `Extension<_>`.
fn sse_context_is_an_extractor() -> axum::Router {
    async fn handler(
        context: banto_server::SseContext,
        axum::extract::State(_state): axum::extract::State<u8>,
    ) -> axum::response::Response {
        banto_server::sse_response(context, futures_util::stream::empty())
    }
    axum::Router::new()
        .route("/api/app/stream", axum::routing::get(handler))
        .with_state(0u8)
}
