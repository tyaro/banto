//! Baseline security response headers (`docs/improvements.md` §2.4): CSP,
//! `nosniff`, frame-deny, `Referrer-Policy`. Applied uniformly to every
//! response - static UI assets and `/api/*` (JSON *and* SSE) alike - via a
//! single outermost layer, so a new route can never forget to opt in.
//!
//! Independent of [`crate::csrf::require_banto_client_header`] (rejects
//! requests missing a header) and [`crate::response::ApiError`] (shapes
//! error bodies): this layer only *appends* response headers after the
//! inner router has already produced a response, so it never touches
//! status/body and cannot conflict with either.

use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::Router;

/// Content-Security-Policy for the embedded SvelteKit UI + REST/SSE API,
/// served over plain LAN HTTP (spec §11.2 - no TLS in v1).
///
/// - `script-src 'self' 'unsafe-inline'`: `'unsafe-inline'` is required by
///   `apps/admin-template/src/app.html`'s inline first-paint theme script
///   (sets `data-theme`/`data-banto-preset`/`data-banto-density` from
///   `localStorage` before CSS loads, to avoid a flash of the wrong
///   theme). Nonce/hash-based CSP for this one script is a future
///   hardening step (would need the nonce threaded through SvelteKit's
///   `%sveltekit.head%` templating, or the script hashed and pinned).
/// - `style-src 'self' 'unsafe-inline'`: Svelte compiles component styles
///   to inline `<style>` blocks / `style="..."` attributes at runtime
///   (e.g. `app.html`'s own `style="display: contents"`); blocking inline
///   styles would break the compiled UI wholesale.
/// - `img-src 'self' data: blob:`: `data:` covers inline report
///   noise-background/icon assets embedded as data URIs; `blob:` covers
///   attachment thumbnail `URL.createObjectURL(...)` previews. Both are
///   existing product features (not new surface opened by this policy).
/// - `connect-src 'self'`: same-origin `fetch()` (REST) and `EventSource`
///   (`GET /api/events` SSE) both need this; nothing else is contacted.
/// - `base-uri 'self'` / `form-action 'self'` / `frame-ancestors 'none'`:
///   this app has no legitimate cross-origin form target or `<base>` use,
///   and is never meant to be embedded in a frame.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
     script-src 'self' 'unsafe-inline'; \
     style-src 'self' 'unsafe-inline'; \
     img-src 'self' data: blob:; \
     connect-src 'self'; \
     base-uri 'self'; \
     form-action 'self'; \
     frame-ancestors 'none'";

/// Axum middleware: attach the fixed set of baseline security headers to
/// every outgoing response, regardless of route or content type. Runs
/// *after* the inner handler (`next.run`), so it never affects routing,
/// auth, or CSRF decisions - it can only add headers to whatever response
/// was already produced (including a `text/event-stream` SSE response,
/// where these headers are simply inert but harmless).
async fn add_security_headers(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    response
}

/// Wrap `router` with the baseline security-header layer (spec
/// improvements §2.4). Callers should apply this LAST (outermost), after
/// merging `/api/*` and the static-asset fallback, so every response -
/// static UI, JSON API, and SSE alike - gets it; see
/// `admin_template_core::rest::api_router`'s call sites
/// (`banto-serve.rs`, `src-tauri/src/lib.rs`) for the composition order.
pub fn with_security_headers(router: Router) -> Router {
    router.layer(middleware::from_fn(add_security_headers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request as HttpRequest, StatusCode};
    use axum::routing::get;
    use axum::Json;
    use tower::ServiceExt;

    fn expect_headers(response: &Response) {
        assert_eq!(
            response
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .and_then(|v| v.to_str().ok()),
            Some("nosniff")
        );
        assert_eq!(
            response
                .headers()
                .get(header::X_FRAME_OPTIONS)
                .and_then(|v| v.to_str().ok()),
            Some("DENY")
        );
        assert_eq!(
            response
                .headers()
                .get(header::REFERRER_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some("same-origin")
        );
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some(CONTENT_SECURITY_POLICY)
        );
    }

    /// A static-page-shaped route (plain HTML, like `static_files::serve_asset`)
    /// gets all four headers.
    #[tokio::test]
    async fn static_page_response_gets_security_headers() {
        let router = with_security_headers(Router::new().route(
            "/",
            get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<html></html>") }),
        ));
        let response = router
            .oneshot(HttpRequest::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        expect_headers(&response);
    }

    /// A JSON `/api/*`-shaped route also gets all four headers.
    #[tokio::test]
    async fn api_json_response_gets_security_headers() {
        let router = with_security_headers(Router::new().route(
            "/api/ping",
            get(|| async { Json(serde_json::json!({"ok": true})) }),
        ));
        let response = router
            .oneshot(HttpRequest::get("/api/ping").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        expect_headers(&response);
    }

    /// An `text/event-stream`-shaped route (standing in for `events::sse_route`)
    /// still gets the headers without breaking its content type.
    #[tokio::test]
    async fn sse_shaped_response_gets_security_headers() {
        let router = with_security_headers(Router::new().route(
            "/api/events",
            get(|| async { ([(header::CONTENT_TYPE, "text/event-stream")], "") }),
        ));
        let response = router
            .oneshot(HttpRequest::get("/api/events").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("text/event-stream")
        );
        expect_headers(&response);
    }
}
