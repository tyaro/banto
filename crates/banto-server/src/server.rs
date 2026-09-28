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
pub fn lan_urls(bind: &str, port: u16) -> Vec<String> {
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
    fn lan_urls_ipv4_loopback_bind_is_loopback_only() {
        // Issue #216: a loopback bind must never advertise a LAN URL - the
        // whole regression was this case falling through to the 0.0.0.0
        // (enumerate every interface) behavior instead.
        assert_eq!(
            lan_urls("127.0.0.1", 8721),
            vec!["http://127.0.0.1:8721".to_string()]
        );
    }

    #[test]
    fn lan_urls_ipv6_loopback_bind_is_loopback_only() {
        assert_eq!(lan_urls("::1", 8721), vec!["http://[::1]:8721".to_string()]);
    }

    #[test]
    fn lan_urls_ipv4_unspecified_bind_includes_loopback_and_lan_ipv4() {
        // 0.0.0.0: same shape as the original `lan_urls(port)` - loopback
        // first, then whatever non-loopback IPv4 interfaces this machine
        // has (0 or more; CI runners commonly have none besides loopback).
        let urls = lan_urls("0.0.0.0", 8721);
        assert_eq!(urls[0], "http://127.0.0.1:8721");
        assert!(
            urls[1..].iter().all(|u| !u.contains("[")),
            "no IPv6 entries expected for an IPv4 unspecified bind: {urls:?}"
        );
    }

    #[test]
    fn lan_urls_ipv6_unspecified_bind_includes_loopback_v4_v6_and_lan() {
        let urls = lan_urls("::", 8721);
        assert_eq!(urls[0], "http://127.0.0.1:8721");
        assert_eq!(urls[1], "http://[::1]:8721");
    }

    #[test]
    fn lan_urls_specific_ipv4_bind_is_that_address_only() {
        // Binding one NIC must not also list every other interface - only
        // that NIC's clients can actually reach this listener.
        assert_eq!(
            lan_urls("192.168.1.50", 8721),
            vec!["http://192.168.1.50:8721".to_string()]
        );
    }

    #[test]
    fn lan_urls_specific_ipv6_bind_is_that_address_only() {
        assert_eq!(
            lan_urls("2001:db8::1", 8721),
            vec!["http://[2001:db8::1]:8721".to_string()]
        );
    }

    #[test]
    fn lan_urls_unparseable_bind_falls_back_to_the_raw_string() {
        // Defensive only - the settings UI never sends a non-IP bind - but
        // must not panic, and must not silently claim LAN reachability for
        // something we could not classify.
        assert_eq!(
            lan_urls("not-an-ip", 8721),
            vec!["http://not-an-ip:8721".to_string()]
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
