//! Server lifecycle: bind, run, graceful-stop (spec §11.1, §11.4).

use axum::Router;
use banto_core::BantoError;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// Bind address + port for the embedded server (spec §11.2: bind address
/// and port are both configurable; default is localhost-only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub bind: String,
    pub port: u16,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1".to_string(),
            port: 8721,
        }
    }
}

/// A handle to a running server: its bound address, and a way to stop it.
pub struct RunningServer {
    local_addr: SocketAddr,
    shutdown_tx: Option<oneshot::Sender<()>>,
    join_handle: JoinHandle<()>,
}

impl RunningServer {
    /// The actual bound address (useful when `port: 0` asked the OS to pick
    /// a free port).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Signal graceful shutdown and wait for the server task to finish.
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        let _ = self.join_handle.await;
    }
}

/// Bind `config` and start serving `router` in a background task, with
/// graceful shutdown wired up. Binding failures (e.g. the port already
/// being in use) surface as `BantoError::Other` with a Japanese, readable
/// message (this crosses into user-facing settings-screen territory per
/// spec §11.4, so keep it friendly rather than a raw OS error).
pub async fn start(config: ServerConfig, router: Router) -> Result<RunningServer, BantoError> {
    let addr = format!("{}:{}", config.bind, config.port);
    let listener = TcpListener::bind(&addr).await.map_err(|err| {
        BantoError::Other(format!(
            "サーバの起動に失敗しました（{addr}）: {err}。ポート番号を変更するか、\
             他のプロセスがそのポートを使用していないか確認してください。"
        ))
    })?;
    let local_addr = listener
        .local_addr()
        .map_err(|err| BantoError::Other(err.to_string()))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let join_handle = tokio::spawn(async move {
        // `into_make_service_with_connect_info::<SocketAddr>()` (rather than
        // the plain `into_make_service()`) makes each connection's peer
        // address available to handlers via `ConnectInfo<SocketAddr>` - the
        // login rate limiter (`auth::login_handler`, spec §11.2) keys its
        // lockout on client IP + username. Handlers extract it as
        // `Option<ConnectInfo<..>>`, so this is purely additive: routers
        // served some other way still work, just with a username-only key.
        let server = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        );
        let graceful = server.with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(err) = graceful.await {
            eprintln!("banto-server: サーバエラー: {err}");
        }
    });

    Ok(RunningServer {
        local_addr,
        shutdown_tx: Some(shutdown_tx),
        join_handle,
    })
}

/// URLs a client could use to reach a server bound to `port`, assuming it
/// listens on every interface (`0.0.0.0`): always `http://127.0.0.1:{port}`,
/// plus one entry per non-loopback IPv4 interface. This is `lan_urls`'s
/// pre-#216 behavior, kept unchanged and under its original name.
///
/// **Exists only for source/binary compatibility with derived apps already
/// built against this signature** (`banto-server` is consumed by derived
/// apps via a git-tag/`path:` dependency - see `docs/publishing.md` - so
/// changing a `pub fn`'s signature breaks every such app's next build, not
/// just this repo's). New callers should use [`lan_urls_for_bind`] instead,
/// which is what this function now delegates to (hardcoding `"0.0.0.0"`) -
/// **this one reintroduces Issue #216's bug** for any server actually bound
/// to something else, because it cannot know the caller's real `bind`.
///
/// Deliberately not `#[deprecated]`: derived apps commonly build with
/// `-D warnings` (this repo's CI `rust` job does too), so marking this
/// deprecated would turn a routine dependency bump into a broken build for
/// every caller that has not yet migrated - that migration should be a
/// deliberate change a maintainer chooses to make, not a side effect of
/// picking up a patch release.
pub fn lan_urls(port: u16) -> Vec<String> {
    lan_urls_for_bind("0.0.0.0", port)
}

/// URLs a client could use to reach a server bound to `bind`:`port` (spec
/// §11.4's access-URL display; Issue #216). The set returned is scoped to
/// what `bind` actually listens on, so callers building "you can reach this
/// server at..." UI never advertise an address nothing is listening on:
///
/// - **loopback** (`127.0.0.1`, `::1`): only that loopback URL - a LAN URL
///   would be misleading since no other machine can reach it.
/// - **unspecified IPv4** (`0.0.0.0`): loopback plus one entry per
///   non-loopback IPv4 interface (unchanged from the original `lan_urls`
///   behavior - this is the "LAN公開" case).
/// - **unspecified IPv6** (`::`): the IPv4 set above, plus one entry per
///   non-loopback IPv6 interface (bracketed per RFC 3986). `ServerConfig`
///   does not currently produce a listener that actually binds `::` (see
///   `start`'s plain `{bind}:{port}` formatting, which is not IPv6-bracket
///   aware) - this arm exists so the pure classification is correct and
///   tested ahead of that being wired up, not because it is reachable today.
/// - **a specific address**: only that address's URL - binding to one NIC
///   means only that NIC's clients can connect, so nothing else is listed.
/// - anything `bind` fails to parse as an IP (defensive; the settings UI
///   only ever sends the addresses above): the raw `bind:port` string,
///   unchanged from today's behavior for an unrecognized value.
pub fn lan_urls_for_bind(bind: &str, port: u16) -> Vec<String> {
    use std::net::IpAddr;

    match bind.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) if v4.is_loopback() => vec![format!("http://{v4}:{port}")],
        Ok(IpAddr::V6(v6)) if v6.is_loopback() => vec![format!("http://[{v6}]:{port}")],
        Ok(IpAddr::V4(v4)) if v4.is_unspecified() => {
            let mut urls = vec![format!("http://127.0.0.1:{port}")];
            urls.extend(non_loopback_urls(port, false));
            urls
        }
        Ok(IpAddr::V6(v6)) if v6.is_unspecified() => {
            let mut urls = vec![
                format!("http://127.0.0.1:{port}"),
                format!("http://[::1]:{port}"),
            ];
            urls.extend(non_loopback_urls(port, true));
            urls
        }
        Ok(IpAddr::V4(v4)) => vec![format!("http://{v4}:{port}")],
        Ok(IpAddr::V6(v6)) => vec![format!("http://[{v6}]:{port}")],
        Err(_) => vec![format!("http://{bind}:{port}")],
    }
}

/// Non-loopback interface addresses as `http://` URLs: IPv4 always, IPv6
/// (bracketed) only when `include_v6` (only the `::` bind case wants it -
/// the `0.0.0.0` case stays IPv4-only, matching the original `lan_urls`).
fn non_loopback_urls(port: u16, include_v6: bool) -> Vec<String> {
    let mut urls = Vec::new();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for iface in interfaces {
            if iface.is_loopback() {
                continue;
            }
            match iface.ip() {
                std::net::IpAddr::V4(ipv4) => urls.push(format!("http://{ipv4}:{port}")),
                std::net::IpAddr::V6(ipv6) if include_v6 => {
                    urls.push(format!("http://[{ipv6}]:{port}"))
                }
                std::net::IpAddr::V6(_) => {}
            }
        }
    }
    urls
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_urls_for_bind_ipv4_loopback_bind_is_loopback_only() {
        // Issue #216: a loopback bind must never advertise a LAN URL - the
        // whole regression was this case falling through to the 0.0.0.0
        // (enumerate every interface) behavior instead.
        assert_eq!(
            lan_urls_for_bind("127.0.0.1", 8721),
            vec!["http://127.0.0.1:8721".to_string()]
        );
    }

    #[test]
    fn lan_urls_for_bind_ipv6_loopback_bind_is_loopback_only() {
        assert_eq!(
            lan_urls_for_bind("::1", 8721),
            vec!["http://[::1]:8721".to_string()]
        );
    }

    #[test]
    fn lan_urls_for_bind_ipv4_unspecified_bind_includes_loopback_and_lan_ipv4() {
        // 0.0.0.0: same shape as the original `lan_urls(port)` - loopback
        // first, then whatever non-loopback IPv4 interfaces this machine
        // has (0 or more; CI runners commonly have none besides loopback).
        let urls = lan_urls_for_bind("0.0.0.0", 8721);
        assert_eq!(urls[0], "http://127.0.0.1:8721");
        assert!(
            urls[1..].iter().all(|u| !u.contains("[")),
            "no IPv6 entries expected for an IPv4 unspecified bind: {urls:?}"
        );
    }

    #[test]
    fn lan_urls_for_bind_ipv6_unspecified_bind_includes_loopback_v4_v6_and_lan() {
        let urls = lan_urls_for_bind("::", 8721);
        assert_eq!(urls[0], "http://127.0.0.1:8721");
        assert_eq!(urls[1], "http://[::1]:8721");
    }

    #[test]
    fn lan_urls_for_bind_specific_ipv4_bind_is_that_address_only() {
        // Binding one NIC must not also list every other interface - only
        // that NIC's clients can actually reach this listener.
        assert_eq!(
            lan_urls_for_bind("192.168.1.50", 8721),
            vec!["http://192.168.1.50:8721".to_string()]
        );
    }

    #[test]
    fn lan_urls_for_bind_specific_ipv6_bind_is_that_address_only() {
        assert_eq!(
            lan_urls_for_bind("2001:db8::1", 8721),
            vec!["http://[2001:db8::1]:8721".to_string()]
        );
    }

    #[test]
    fn lan_urls_for_bind_unparseable_bind_falls_back_to_the_raw_string() {
        // Defensive only - the settings UI never sends a non-IP bind - but
        // must not panic, and must not silently claim LAN reachability for
        // something we could not classify.
        assert_eq!(
            lan_urls_for_bind("not-an-ip", 8721),
            vec!["http://not-an-ip:8721".to_string()]
        );
    }

    // --- Back-compat: `lan_urls(port)` (pre-#216 signature) --------------
    //
    // Owner review on PR #254: `lan_urls`'s signature must not change (it is
    // `pub` in a crate derived apps depend on via a git-tag/`path:`
    // dependency - a signature change breaks their build on the next
    // dependency bump, not just this repo). These pin its old, bind-agnostic
    // behavior so a future edit cannot silently fold it back into
    // `lan_urls_for_bind`'s signature or change what it returns.

    #[test]
    fn lan_urls_kept_for_compat_matches_its_pre_216_shape() {
        // Old callers get exactly the old shape: loopback first, then
        // non-loopback IPv4 interfaces - same as `lan_urls_for_bind("0.0.0.0", ..)`.
        let old = lan_urls(8721);
        let new = lan_urls_for_bind("0.0.0.0", 8721);
        assert_eq!(old, new);
        assert_eq!(old[0], "http://127.0.0.1:8721");
    }

    #[test]
    fn lan_urls_kept_for_compat_counter_proof_it_is_not_bind_aware() {
        // Documents the known limitation this compat shim carries forward:
        // unlike `lan_urls_for_bind`, `lan_urls(port)` has no way to learn
        // the caller's actual bind, so it cannot avoid Issue #216's bug for
        // a caller that is not actually listening on 0.0.0.0. A caller
        // bound to loopback must migrate to `lan_urls_for_bind` to get the
        // fix - this test fails if `lan_urls` is ever "fixed" to somehow
        // guess a narrower scope on its own (it can't, and shouldn't try).
        let old = lan_urls(8721);
        let loopback_scoped = lan_urls_for_bind("127.0.0.1", 8721);
        assert_ne!(
            old, loopback_scoped,
            "lan_urls(port) must keep behaving like a 0.0.0.0 bind, not a loopback one"
        );
    }

    #[tokio::test]
    async fn start_and_stop_a_minimal_router() {
        let router = Router::new().route("/", axum::routing::get(|| async { "ok" }));
        let server = start(
            ServerConfig {
                bind: "127.0.0.1".to_string(),
                port: 0, // let the OS pick a free port
            },
            router,
        )
        .await
        .expect("server should start");

        let addr = server.local_addr();
        let response = reqwest_get(addr).await;
        assert_eq!(response, "ok");

        server.stop().await;
    }

    /// Tiny hand-rolled GET so this test does not need an HTTP client
    /// dependency: connects with a plain TCP stream and reads the response.
    async fn reqwest_get(addr: SocketAddr) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(addr)
            .await
            .expect("connect should succeed");
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .expect("write should succeed");
        let mut buf = Vec::new();
        stream
            .read_to_end(&mut buf)
            .await
            .expect("read should succeed");
        let text = String::from_utf8_lossy(&buf);
        text.rsplit("\r\n\r\n").next().unwrap_or("").to_string()
    }
}
