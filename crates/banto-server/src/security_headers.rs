//! Baseline security response headers (`docs/history/improvements.md` §2.4): CSP,
//! `nosniff`, frame-deny, `Referrer-Policy`. Applied uniformly to every
//! response - static UI assets and `/api/*` (JSON *and* SSE) alike - via a
//! single outermost layer, so a new route can never forget to opt in.
//!
//! Independent of [`crate::csrf::require_banto_client_header`] (rejects
//! requests missing a header) and [`crate::response::ApiError`] (shapes
//! error bodies): this layer only *appends* response headers after the
//! inner router has already produced a response, so it never touches
//! status/body and cannot conflict with either.
//!
//! # Widening `connect-src` (opt-in, optionally per request)
//!
//! [`with_security_headers`] always sends the strict
//! [`CONTENT_SECURITY_POLICY`]. An app whose *own* desktop shell navigates a
//! Tauri webview to this HTTP UI (e.g. banto-industrial's banto-hub shell
//! opening `http://127.0.0.1:<port>/status`) runs that page under the
//! *response* CSP, not the Tauri window CSP, so the page's Tauri IPC fetches
//! (`http://ipc.localhost/...`) are blocked by `connect-src 'self'` (Tauri
//! then falls back to `postMessage`, but every load logs violations). For
//! that case [`SecurityHeaders`] + [`with_security_headers_using`] add
//! sources to `connect-src` *only*, either for every response or only for
//! requests a selector accepts (e.g. [`request_from_loopback_peer`]). Every
//! other directive and header is identical to the strict default.
//!
//! ## Security impact of adding [`TAURI_IPC_CONNECT_SRC`]
//!
//! What `connect-src ipc: http://ipc.localhost` grants a page that is *not*
//! inside Tauri (an ordinary browser that happens to receive the widened
//! policy):
//!
//! - `ipc:` is a Tauri custom scheme. Browsers have no handler for it, so a
//!   `fetch("ipc://...")` fails before any network I/O: inert.
//! - `http://ipc.localhost` resolves (WHATWG URL / RFC 6761 `.localhost`) to
//!   the *viewer's own* loopback, port 80. The only new reach is "an injected
//!   script could `fetch`/`EventSource` to whatever listens on port 80 of the
//!   viewer's machine". It is not an off-host exfiltration channel, and CSP
//!   is defence in depth against an XSS that would already have to exist.
//!   Still non-zero (a local service on :80 could receive data), so the
//!   strict policy stays the default and the widening should be narrowed.
//!
//! Choosing *which* requests get it (the selector):
//!
//! - **Every response** (no selector): simplest, but LAN browsers get the
//!   widened policy too. Not recommended when the server listens on the LAN.
//! - **Loopback peer** ([`request_from_loopback_peer`], reads the
//!   `ConnectInfo<SocketAddr>` that [`crate::start`] /
//!   [`crate::BoundServer::serve`] always install): the peer address comes
//!   from the TCP connection, not from anything a remote page or link can
//!   set, so LAN browsers connecting *directly* keep the strict policy.
//!   Residual: a browser on the *same host* (also loopback) gets the
//!   widened policy - the `:80` reach above is then that host's own
//!   loopback, i.e. the machine already running this server. **This is the
//!   recommended selector for a desktop shell, as long as no same-host
//!   reverse proxy is in front (next point).**
//! - **Caveat - same-host reverse proxy**: if a reverse proxy on the same
//!   host forwards LAN traffic to this server over loopback (e.g. a TLS
//!   terminator per ADR-0003 that connects to `127.0.0.1:<port>`), *every*
//!   request arrives from a loopback peer, so [`request_from_loopback_peer`]
//!   widens `connect-src` for LAN browsers too: an injected script in a LAN
//!   viewer's page could then reach whatever listens on port 80 of *that
//!   viewer's own machine* (`http://ipc.localhost`; `ipc:` stays inert).
//!   The peer check cannot tell the proxy from the desktop shell, and
//!   forwarded headers (`X-Forwarded-For`, `Forwarded`) are client-settable
//!   unless the proxy overwrites them, so don't select on those either. In
//!   such a deployment either don't enable the widening at all (the shell
//!   still works via Tauri's `postMessage` fallback, only the CSP violation
//!   reports remain), or have the proxy connect to this server from a
//!   non-loopback address so that only the shell is a loopback peer.
//! - **Request headers / query / `Host`**: attacker-influenceable (a crafted
//!   link sets the query; `Host` follows the URL the victim opens), so a
//!   selector built on them lets a remote party pick the weaker policy for a
//!   victim. Don't.
//!
//! The selector only ever chooses between the strict policy and the widened
//! one: it can never make a response weaker than "strict + the configured
//! extra `connect-src` sources", nor touch the other directives or headers.

use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request};
use axum::http::{header, HeaderValue};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::Router;

use crate::grant::is_loopback_peer;

/// Content-Security-Policy for the embedded SvelteKit UI + REST/SSE API,
/// served over plain LAN HTTP (spec §11.2 - no TLS in v1). This is the
/// strict default every response gets unless [`SecurityHeaders`] widens
/// `connect-src`. Public so derived apps' tests can compare their Tauri
/// window CSP against it - prefer
/// [`SecurityHeaders::content_security_policy`] with
/// [`TAURI_IPC_CONNECT_SRC`] over string surgery on this value.
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
///   [`SecurityHeaders::extra_connect_src`] is the only way to widen it.
/// - `base-uri 'self'` / `form-action 'self'` / `frame-ancestors 'none'`:
///   this app has no legitimate cross-origin form target or `<base>` use,
///   and is never meant to be embedded in a frame.
///
/// Two-path symmetry (conventions.md §1): the Tauri desktop webview enforces
/// the *same* policy via `apps/admin-template/src-tauri/tauri.conf.json`'s
/// `app.security.csp`. The only intended delta there is `connect-src`, which
/// additionally allows Tauri IPC ([`TAURI_IPC_CONNECT_SRC`]) in place of
/// this LAN path's same-origin `fetch`/SSE. Keep the two in sync when either
/// changes: `scripts/verify-architecture.mjs` rule 12 (directive by
/// directive) and `apps/admin-template/core/tests/tauri_window_csp.rs`
/// (exact string, through this module's API) both fail on drift.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
     script-src 'self' 'unsafe-inline'; \
     style-src 'self' 'unsafe-inline'; \
     img-src 'self' data: blob:; \
     connect-src 'self'; \
     base-uri 'self'; \
     form-action 'self'; \
     frame-ancestors 'none'";

/// The `connect-src` sources Tauri IPC needs (the `ipc:` custom protocol,
/// and the `http://ipc.localhost` form WebView2 on Windows uses). This is
/// the delta between [`CONTENT_SECURITY_POLICY`] and a Tauri window CSP, and
/// the set a desktop shell that navigates to this server should pass to
/// [`SecurityHeaders::extra_connect_src`]. See the module docs for what it
/// grants an ordinary browser.
pub const TAURI_IPC_CONNECT_SRC: [&str; 2] = ["ipc:", "http://ipc.localhost"];

/// The `connect-src` directive as written in [`CONTENT_SECURITY_POLICY`];
/// extra sources are inserted right after it.
const CONNECT_SRC_DIRECTIVE: &str = "connect-src 'self'";

/// A `connect-src` source rejected by [`SecurityHeaders::extra_connect_src`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidCspSource {
    /// The rejected source, verbatim.
    pub source: String,
    /// Why it was rejected (English, for logs/panics).
    pub reason: &'static str,
}

impl fmt::Display for InvalidCspSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid connect-src source {:?}: {}",
            self.source, self.reason
        )
    }
}

impl std::error::Error for InvalidCspSource {}

/// One CSP source expression must be a single non-empty token of visible
/// ASCII without the directive separator `;` or the policy-list separator
/// `,`. Whitespace (would split into several sources), control characters
/// and non-ASCII (would break the header value) are rejected too. This is a
/// syntactic guard against directive/header injection, not a full CSP
/// grammar check.
fn validate_source(source: &str) -> Result<(), InvalidCspSource> {
    let reject = |reason| {
        Err(InvalidCspSource {
            source: source.to_owned(),
            reason,
        })
    };
    if source.is_empty() {
        return reject("empty");
    }
    for c in source.chars() {
        match c {
            ';' => return reject("contains ';' (directive separator)"),
            ',' => return reject("contains ',' (policy separator)"),
            c if c.is_whitespace() => return reject("contains whitespace"),
            c if c.is_control() => return reject("contains a control character"),
            c if !c.is_ascii_graphic() => return reject("contains a non-ASCII character"),
            _ => {}
        }
    }
    Ok(())
}

/// Decides, per request, whether the widened `connect-src` applies.
type ConnectSrcSelector = Arc<dyn Fn(&Request) -> bool + Send + Sync>;

/// Configuration for [`with_security_headers_using`]. `SecurityHeaders::new()`
/// (= `Default`) is exactly [`with_security_headers`]' strict policy; the
/// only thing it can change is `connect-src` (module docs: security impact
/// and which selector to use).
///
/// ```
/// use banto_server::security_headers::{
///     request_from_loopback_peer, SecurityHeaders, TAURI_IPC_CONNECT_SRC,
/// };
/// let headers = SecurityHeaders::new()
///     .extra_connect_src(TAURI_IPC_CONNECT_SRC)
///     .expect("static sources are valid")
///     .extra_connect_src_when(request_from_loopback_peer);
/// assert!(headers
///     .content_security_policy()
///     .contains("connect-src 'self' ipc: http://ipc.localhost;"));
/// ```
#[derive(Clone)]
pub struct SecurityHeaders {
    extra_connect_src: Vec<String>,
    selector: Option<ConnectSrcSelector>,
}

impl fmt::Debug for SecurityHeaders {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecurityHeaders")
            .field("extra_connect_src", &self.extra_connect_src)
            .field("per_request", &self.selector.is_some())
            .finish()
    }
}

impl Default for SecurityHeaders {
    fn default() -> Self {
        Self::new()
    }
}

impl SecurityHeaders {
    /// The strict default: [`CONTENT_SECURITY_POLICY`] on every response.
    pub fn new() -> Self {
        Self {
            extra_connect_src: Vec::new(),
            selector: None,
        }
    }

    /// Append `sources` to `connect-src` (after `'self'`, in the given order;
    /// a source already present is kept once). Validated here so a bad value
    /// fails at startup, never per request: on the first invalid source the
    /// whole call is rejected and nothing is added. Without
    /// [`Self::extra_connect_src_when`] the extra sources apply to every
    /// response.
    pub fn extra_connect_src<I, S>(mut self, sources: I) -> Result<Self, InvalidCspSource>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut added = Vec::new();
        for source in sources {
            let source = source.as_ref();
            validate_source(source)?;
            added.push(source.to_owned());
        }
        for source in added {
            if source != "'self'" && !self.extra_connect_src.contains(&source) {
                self.extra_connect_src.push(source);
            }
        }
        Ok(self)
    }

    /// Apply the extra `connect-src` sources only to responses whose request
    /// `selector` accepts (evaluated before the inner handler runs);
    /// everything else gets the strict [`CONTENT_SECURITY_POLICY`]. Replaces
    /// a previously set selector. Has no effect without
    /// [`Self::extra_connect_src`]. See the module docs for which request
    /// properties are safe to select on ([`request_from_loopback_peer`] is
    /// the recommended one).
    pub fn extra_connect_src_when<F>(mut self, selector: F) -> Self
    where
        F: Fn(&Request) -> bool + Send + Sync + 'static,
    {
        self.selector = Some(Arc::new(selector));
        self
    }

    /// The widened policy: [`CONTENT_SECURITY_POLICY`] with the extra
    /// `connect-src` sources inserted (identical to it when there are none).
    /// This is the exact header value sent when the extras apply, so derived
    /// apps' tests can compare their Tauri window CSP against
    /// `SecurityHeaders::new().extra_connect_src(TAURI_IPC_CONNECT_SRC)?
    /// .content_security_policy()`.
    pub fn content_security_policy(&self) -> String {
        if self.extra_connect_src.is_empty() {
            return CONTENT_SECURITY_POLICY.to_owned();
        }
        let widened = format!(
            "{CONNECT_SRC_DIRECTIVE} {}",
            self.extra_connect_src.join(" ")
        );
        CONTENT_SECURITY_POLICY.replacen(CONNECT_SRC_DIRECTIVE, &widened, 1)
    }
}

/// Selector for [`SecurityHeaders::extra_connect_src_when`]: `true` iff the
/// TCP peer is a loopback address (IPv4 `127/8`, `::1`, or IPv4-mapped
/// loopback - the same judgment as [`crate::is_loopback_peer`]), read from
/// the `ConnectInfo<SocketAddr>` extension that [`crate::start`] /
/// [`crate::BoundServer::serve`] install. Without that extension (a router
/// served some other way) it returns `false`, i.e. the strict policy - fail
/// closed.
///
/// "Loopback peer" means "the TCP connection came from this host", not "the
/// viewer is on this host": behind a reverse proxy on the same host every
/// request is a loopback peer, so LAN viewers get the widened policy too
/// (their own machine's `:80` becomes reachable from an injected script via
/// `http://ipc.localhost`). Don't rely on it in that deployment - leave the
/// widening off, or have the proxy connect from a non-loopback address (see
/// the module docs).
pub fn request_from_loopback_peer(req: &Request) -> bool {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|ConnectInfo(addr)| is_loopback_peer(*addr))
}

/// Precomputed, immutable header values the middleware chooses between.
struct ResolvedHeaders {
    strict_csp: HeaderValue,
    /// `None` = no extra sources configured (always strict).
    widened_csp: Option<HeaderValue>,
    selector: Option<ConnectSrcSelector>,
}

impl ResolvedHeaders {
    fn resolve(config: SecurityHeaders) -> Self {
        let widened_csp = (!config.extra_connect_src.is_empty()).then(|| {
            // Every source passed `validate_source` (visible ASCII only), so
            // the joined policy is always a valid header value.
            HeaderValue::from_str(&config.content_security_policy())
                .expect("validated CSP sources form a valid header value")
        });
        Self {
            strict_csp: HeaderValue::from_static(CONTENT_SECURITY_POLICY),
            widened_csp,
            selector: config.selector,
        }
    }

    fn csp_for(&self, req: &Request) -> HeaderValue {
        match (&self.widened_csp, &self.selector) {
            (Some(widened), None) => widened.clone(),
            (Some(widened), Some(selector)) if selector(req) => widened.clone(),
            _ => self.strict_csp.clone(),
        }
    }
}

/// Axum middleware body: attach the baseline security headers to every
/// outgoing response, regardless of route or content type. The CSP variant
/// is chosen from the request *before* the inner handler runs (which
/// consumes the request); the headers are added *after* (`next.run`), so it
/// never affects routing, auth, or CSRF decisions - it can only add headers
/// to whatever response was already produced (including a
/// `text/event-stream` SSE response, where these headers are simply inert
/// but harmless).
async fn add_security_headers(headers: Arc<ResolvedHeaders>, req: Request, next: Next) -> Response {
    let csp = headers.csp_for(&req);
    let mut response = next.run(req).await;
    let out = response.headers_mut();
    out.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    out.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    out.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    out.insert(header::CONTENT_SECURITY_POLICY, csp);
    response
}

/// Wrap `router` with the baseline security-header layer (spec
/// improvements §2.4), strict [`CONTENT_SECURITY_POLICY`] on every response
/// (= [`with_security_headers_using`] with `SecurityHeaders::new()`).
/// Callers should apply this LAST (outermost), after merging `/api/*` and
/// the static-asset fallback, so every response - static UI, JSON API, and
/// SSE alike - gets it; see `admin_template_core::rest::api_router`'s call
/// sites (`banto-serve.rs`, `src-tauri/src/lib.rs`) for the composition
/// order.
pub fn with_security_headers(router: Router) -> Router {
    with_security_headers_using(router, SecurityHeaders::new())
}

/// [`with_security_headers`] with a [`SecurityHeaders`] configuration (extra
/// `connect-src` sources, optionally only for requests a selector accepts).
/// Same placement rule: apply LAST (outermost). Header values are
/// precomputed here; the per-request cost is the selector call plus a
/// header-value clone.
pub fn with_security_headers_using(router: Router, config: SecurityHeaders) -> Router {
    let headers = Arc::new(ResolvedHeaders::resolve(config));
    router.layer(middleware::from_fn(move |req: Request, next: Next| {
        add_security_headers(headers.clone(), req, next)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request as HttpRequest, StatusCode};
    use axum::routing::get;
    use axum::Json;
    use std::collections::BTreeMap;
    use tower::ServiceExt;

    fn header_str(response: &Response, name: header::HeaderName) -> Option<&str> {
        response.headers().get(name).and_then(|v| v.to_str().ok())
    }

    /// The three non-CSP headers, which no configuration may change.
    fn expect_fixed_headers(response: &Response) {
        assert_eq!(
            header_str(response, header::X_CONTENT_TYPE_OPTIONS),
            Some("nosniff")
        );
        assert_eq!(header_str(response, header::X_FRAME_OPTIONS), Some("DENY"));
        assert_eq!(
            header_str(response, header::REFERRER_POLICY),
            Some("same-origin")
        );
    }

    fn expect_headers(response: &Response) {
        expect_fixed_headers(response);
        assert_eq!(
            header_str(response, header::CONTENT_SECURITY_POLICY),
            Some(CONTENT_SECURITY_POLICY)
        );
    }

    /// `"name a b; ..."` -> directive name -> sources (order kept).
    fn directives(csp: &str) -> BTreeMap<String, Vec<String>> {
        csp.split(';')
            .filter_map(|part| {
                let mut tokens = part.split_whitespace();
                let name = tokens.next()?;
                Some((name.to_owned(), tokens.map(str::to_owned).collect()))
            })
            .collect()
    }

    fn ipc_headers() -> SecurityHeaders {
        SecurityHeaders::new()
            .extra_connect_src(TAURI_IPC_CONNECT_SRC)
            .unwrap()
    }

    fn page_router(config: SecurityHeaders) -> Router {
        with_security_headers_using(
            Router::new().route(
                "/",
                get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<html></html>") }),
            ),
            config,
        )
    }

    /// `GET /`, optionally from `peer` (as `start`'s
    /// `into_make_service_with_connect_info` would record it).
    async fn get_page(router: Router, peer: Option<&str>) -> Response {
        let mut req = HttpRequest::get("/").body(Body::empty()).unwrap();
        if let Some(peer) = peer {
            let addr: SocketAddr = peer.parse().unwrap();
            req.extensions_mut().insert(ConnectInfo(addr));
        }
        let response = router.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response
    }

    fn csp_of(response: &Response) -> String {
        header_str(response, header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_owned()
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
            header_str(&response, header::CONTENT_TYPE),
            Some("text/event-stream")
        );
        expect_headers(&response);
    }

    /// `SecurityHeaders::new()` is exactly the strict default, from any peer.
    #[tokio::test]
    async fn default_config_is_the_strict_policy() {
        assert_eq!(
            SecurityHeaders::new().content_security_policy(),
            CONTENT_SECURITY_POLICY
        );
        for peer in [None, Some("127.0.0.1:50000"), Some("192.168.1.20:50000")] {
            expect_headers(&get_page(page_router(SecurityHeaders::default()), peer).await);
        }
    }

    /// Extra sources change `connect-src` only: every other directive and
    /// the three other headers are identical to the strict default.
    #[tokio::test]
    async fn extra_sources_widen_connect_src_only() {
        let response = get_page(page_router(ipc_headers()), Some("192.168.1.20:50000")).await;
        expect_fixed_headers(&response);
        let csp = csp_of(&response);
        assert_eq!(
            csp,
            CONTENT_SECURITY_POLICY.replace(
                "connect-src 'self';",
                "connect-src 'self' ipc: http://ipc.localhost;"
            )
        );
        let mut widened = directives(&csp);
        let mut strict = directives(CONTENT_SECURITY_POLICY);
        assert_eq!(
            widened.remove("connect-src").unwrap(),
            ["'self'", "ipc:", "http://ipc.localhost"]
        );
        strict.remove("connect-src").unwrap();
        assert_eq!(widened, strict);
        assert_eq!(ipc_headers().content_security_policy(), csp);
    }

    /// Repeated calls accumulate in order; duplicates and `'self'` are kept once.
    #[test]
    fn extra_sources_accumulate_without_duplicates() {
        let headers = SecurityHeaders::new()
            .extra_connect_src(["ipc:", "'self'", "ipc:"])
            .unwrap()
            .extra_connect_src(vec![String::from("http://ipc.localhost"), "ipc:".into()])
            .unwrap();
        assert_eq!(
            directives(&headers.content_security_policy())["connect-src"],
            ["'self'", "ipc:", "http://ipc.localhost"]
        );
        assert_eq!(
            headers.content_security_policy(),
            ipc_headers().content_security_policy()
        );
    }

    /// With the loopback selector, only loopback peers get the widened
    /// policy; LAN peers and requests without `ConnectInfo` stay strict.
    #[tokio::test]
    async fn loopback_selector_widens_only_for_loopback_peers() {
        let config = ipc_headers().extra_connect_src_when(request_from_loopback_peer);
        let widened = config.content_security_policy();
        for peer in ["127.0.0.1:50000", "127.8.9.10:1", "[::1]:50000"] {
            let response = get_page(page_router(config.clone()), Some(peer)).await;
            expect_fixed_headers(&response);
            assert_eq!(csp_of(&response), widened, "peer {peer}");
        }
        let mapped: SocketAddr = "[::ffff:127.0.0.1]:50000".parse().unwrap();
        let mut req = HttpRequest::get("/").body(Body::empty()).unwrap();
        req.extensions_mut().insert(ConnectInfo(mapped));
        assert!(request_from_loopback_peer(&req));

        for peer in [
            Some("192.168.1.20:50000"),
            Some("[::ffff:192.168.1.20]:50000"),
            Some("10.0.0.5:443"),
            None,
        ] {
            let response = get_page(page_router(config.clone()), peer).await;
            expect_headers(&response);
        }
    }

    /// An arbitrary selector is honoured both ways (and a selector without
    /// extra sources changes nothing).
    #[tokio::test]
    async fn selector_is_evaluated_per_request() {
        let never = ipc_headers().extra_connect_src_when(|_| false);
        expect_headers(&get_page(page_router(never), Some("127.0.0.1:1")).await);

        let by_path = ipc_headers().extra_connect_src_when(|req| req.uri().path() == "/");
        let response = get_page(page_router(by_path.clone()), None).await;
        assert_eq!(csp_of(&response), by_path.content_security_policy());

        let no_extras = SecurityHeaders::new().extra_connect_src_when(|_| true);
        expect_headers(&get_page(page_router(no_extras), Some("127.0.0.1:1")).await);
    }

    /// Through a real `start()`ed server: the `ConnectInfo` the selector
    /// reads is actually installed, so a loopback client gets the widened
    /// policy end to end.
    #[tokio::test]
    async fn loopback_selector_works_through_a_started_server() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let config = ipc_headers().extra_connect_src_when(request_from_loopback_peer);
        let widened = config.content_security_policy();
        let server = crate::start(
            crate::ServerConfig {
                bind: "127.0.0.1".to_string(),
                port: 0,
            },
            page_router(config),
        )
        .await
        .unwrap();
        let mut stream = tokio::net::TcpStream::connect(server.local_addr())
            .await
            .unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let raw = String::from_utf8_lossy(&raw).to_ascii_lowercase();
        assert!(
            raw.contains(&format!(
                "content-security-policy: {}",
                widened.to_ascii_lowercase()
            )),
            "{raw}"
        );
        server.stop().await;
    }

    /// Anything that could inject a directive, a policy, or break the header
    /// is rejected at construction, and nothing from the call is kept.
    #[test]
    fn invalid_sources_are_rejected() {
        for bad in [
            "",
            "https://a.example; script-src *",
            "https://a.example;",
            "https://a.example, script-src *",
            "ipc: http://ipc.localhost",
            "a\tb",
            "a\r\nX-Injected: 1",
            "a\u{0}",
            "a\u{7f}",
            "https://例え.jp",
        ] {
            let err = SecurityHeaders::new()
                .extra_connect_src([bad])
                .expect_err(bad);
            assert_eq!(err.source, bad);
            assert!(!err.to_string().is_empty());
        }
        // One bad source rejects the whole call.
        assert!(SecurityHeaders::new()
            .extra_connect_src(["ipc:", "bad;"])
            .is_err());
        // Ordinary source expressions are accepted.
        SecurityHeaders::new()
            .extra_connect_src([
                "ipc:",
                "http://ipc.localhost",
                "wss://*.example:443",
                "'none'",
            ])
            .unwrap();
    }
}
