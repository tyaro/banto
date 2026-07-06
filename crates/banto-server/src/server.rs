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
        let server = axum::serve(listener, router.into_make_service());
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

/// URLs a LAN client could use to reach a server bound to `port` (spec
/// §11.4's access-URL display): always `http://127.0.0.1:{port}`, plus one
/// entry per non-loopback IPv4 interface. IPv6 is skipped for v1 (matches
/// the LAN-HTTP-only scope in spec §11.2).
pub fn lan_urls(port: u16) -> Vec<String> {
    let mut urls = vec![format!("http://127.0.0.1:{port}")];

    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for iface in interfaces {
            if iface.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(ipv4) = iface.ip() {
                urls.push(format!("http://{ipv4}:{port}"));
            }
        }
    }

    urls
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_urls_contains_loopback() {
        let urls = lan_urls(8721);
        assert!(urls.contains(&"http://127.0.0.1:8721".to_string()));
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
