//! Server -> client event delivery (spec §3.5 `EventProvider`, §11.3).
//!
//! Exactly two event kinds ship in v1: resource-change notifications (so a
//! connected browser's `createListResource`/`createShowResource` can
//! `invalidate` and refetch) and free-form server notices (surfaced via
//! `NotificationProvider`). Transport is Server-Sent Events; the spec notes
//! this can be upgraded to WebSocket later without changing the
//! `EventProvider` interface, so nothing here should assume one-way-only
//! beyond the SSE plumbing itself.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::Extension;
use axum::middleware;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::Router;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::auth::{require_auth, AuthState};

/// The two event kinds delivered to browser clients (spec §3.5). Serializes
/// as `{ "kind": "resource_changed", "resource": "items" }` /
/// `{ "kind": "notice", "level": "...", "message": "..." }`, matching the
/// `AppEvent` shape `packages/admin-core`'s `SseEventProvider` will parse in
/// Phase B.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServerEvent {
    ResourceChanged { resource: String },
    Notice { level: String, message: String },
}

async fn sse_handler(
    Extension(tx): Extension<broadcast::Sender<ServerEvent>>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let mut rx = tx.subscribe();
    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if let Ok(json) = serde_json::to_string(&event) {
                        yield Ok(Event::default().data(json));
                    }
                }
                // A slow client fell behind the broadcast buffer: skip the
                // gap rather than closing the connection.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                // Sender dropped (server shutting down): end the stream.
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

/// Build the `GET /api/events` SSE endpoint (spec §11.3), auth-required.
/// Each subscriber gets its own broadcast receiver, so one slow reader
/// cannot block delivery to the others.
pub fn sse_route(auth: AuthState, tx: broadcast::Sender<ServerEvent>) -> Router {
    Router::new()
        .route("/api/events", get(sse_handler))
        .layer(Extension(tx))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

// `require_auth` takes `State<AuthState>` via `from_fn_with_state`, which
// only requires `state: S` and does not force this router's own generic
// `State` type to be `AuthState` - so the router above stays `Router<()>`
// and merges cleanly with other routers that carry no state.
#[allow(dead_code)]
fn _assert_state_stays_unit(router: Router) -> Router<()> {
    router
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Identity;
    use axum::body::Body;
    use axum::http::{Request as HttpRequest, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn demo_auth() -> AuthState {
        AuthState::new(
            |u, p| u == "admin" && p == "admin",
            Identity {
                id: "admin".to_string(),
                name: "管理者".to_string(),
            },
        )
    }

    #[tokio::test]
    async fn sse_stream_delivers_broadcast_event() {
        let auth = demo_auth();
        let token = auth.login("admin", "admin").unwrap();
        let (tx, _rx) = broadcast::channel(16);
        let router = sse_route(auth, tx.clone());

        let response = router
            .oneshot(
                HttpRequest::get("/api/events")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("text/event-stream")
        );

        tx.send(ServerEvent::ResourceChanged {
            resource: "items".to_string(),
        })
        .unwrap();

        let mut body = response.into_body();
        let frame = tokio::time::timeout(Duration::from_secs(2), body.frame())
            .await
            .expect("timed out waiting for SSE frame")
            .expect("stream ended unexpectedly")
            .expect("frame error");
        let bytes = frame.into_data().expect("expected a data frame");
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("resource_changed"));
        assert!(text.contains("items"));
    }

    #[tokio::test]
    async fn sse_endpoint_requires_auth() {
        let auth = demo_auth();
        let (tx, _rx) = broadcast::channel(16);
        let router = sse_route(auth, tx);

        let response = router
            .oneshot(HttpRequest::get("/api/events").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
