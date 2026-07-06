//! Static asset serving / SPA fallback (spec §11.1).
//!
//! The embedded SvelteKit build is injected via the [`UiAssets`] trait so
//! this crate never depends on `rust-embed` (or the `embed-ui` feature)
//! directly - the concrete embedding lives in `admin-template-core::assets`,
//! which is the only crate that knows the frontend build's location on
//! disk. This keeps `banto-server` resource/app-agnostic.

use std::borrow::Cow;

use axum::body::Body;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

/// Injection point for embedded frontend assets. Implementors are
/// zero-sized types (the data lives in a `rust-embed`-generated `static`, or
/// a hardcoded placeholder) so `get` is an associated function, not a
/// method - no instance needs to be constructed or stored in router state.
pub trait UiAssets {
    /// Look up `path` (no leading slash, e.g. `"index.html"`,
    /// `"_app/immutable/chunks/foo.js"`). Returns the MIME type and file
    /// bytes if present.
    fn get(path: &str) -> Option<(String, Cow<'static, [u8]>)>;
}

/// Basic MIME mapping by file extension (spec §11.1). Kept intentionally
/// small: only the extensions a SvelteKit static build produces.
pub fn guess_mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext.to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "json" => "application/json",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn respond(mime: String, bytes: Cow<'static, [u8]>) -> Response {
    (
        [(header::CONTENT_TYPE, mime)],
        Body::from(bytes.into_owned()),
    )
        .into_response()
}

async fn serve_asset<A: UiAssets>(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let lookup = if path.is_empty() { "index.html" } else { path };

    if let Some((mime, bytes)) = A::get(lookup) {
        return respond(mime, bytes);
    }

    // SPA fallback: any unknown non-`/api` path (e.g. `/items/42`, a
    // client-side route) serves `index.html` so SvelteKit's router can take
    // over client-side.
    if let Some((mime, bytes)) = A::get("index.html") {
        return respond(mime, bytes);
    }

    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// Build a fallback router serving embedded assets (or, with `A` being the
/// placeholder impl, a single built-in page) for any path not otherwise
/// routed. Mount this *after* the `/api/*` routes so those take priority.
pub fn static_router<A: UiAssets + Send + Sync + 'static>() -> Router {
    Router::new().fallback(get(serve_asset::<A>))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeAssets;

    impl UiAssets for FakeAssets {
        fn get(path: &str) -> Option<(String, Cow<'static, [u8]>)> {
            match path {
                "index.html" => Some((
                    "text/html; charset=utf-8".to_string(),
                    Cow::Borrowed(b"<html>index</html>"),
                )),
                "app.js" => Some((
                    guess_mime("app.js").to_string(),
                    Cow::Borrowed(b"console.log(1)"),
                )),
                _ => None,
            }
        }
    }

    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    #[tokio::test]
    async fn unknown_spa_route_serves_index_html() {
        let router = static_router::<FakeAssets>();
        let response = router
            .oneshot(HttpRequest::get("/items/42").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("index"));
    }

    #[tokio::test]
    async fn known_asset_gets_correct_mime() {
        let router = static_router::<FakeAssets>();
        let response = router
            .oneshot(HttpRequest::get("/app.js").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("text/javascript; charset=utf-8")
        );
    }

    #[test]
    fn mime_mapping_covers_expected_extensions() {
        assert_eq!(guess_mime("index.html"), "text/html; charset=utf-8");
        assert_eq!(guess_mime("app.js"), "text/javascript; charset=utf-8");
        assert_eq!(guess_mime("style.css"), "text/css; charset=utf-8");
        assert_eq!(guess_mime("logo.svg"), "image/svg+xml");
        assert_eq!(guess_mime("logo.png"), "image/png");
        assert_eq!(guess_mime("favicon.ico"), "image/x-icon");
        assert_eq!(guess_mime("manifest.json"), "application/json");
        assert_eq!(guess_mime("font.woff2"), "font/woff2");
        assert_eq!(guess_mime("unknown.bin"), "application/octet-stream");
    }
}
