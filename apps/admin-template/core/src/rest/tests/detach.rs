//! Issue #793 / ADR-0035: a write keeps going when its client disconnects -
//! here with the real `users` route, over a real socket (`oneshot` has no
//! connection to drop). The layer itself and the stop are tested in
//! `banto-server` (`tests/detach_writes.rs`).

use super::*;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// The client sends `POST /api/users` and closes the connection without
/// reading the answer. The account AND its audit row must both be there
/// afterwards. Before the layer, hyper dropped the handler at the disconnect:
/// depending on the moment, no account, or an account without its audit row
/// (this test then fails with one or the other).
#[tokio::test]
async fn user_create_and_its_audit_row_survive_a_client_disconnect() {
    let (router, admin, _editor, _viewer) = router_with_role_tokens().await;
    // Tells the test when the whole request has been read, so the disconnect
    // lands while the handler is running (a request cut off while its body is
    // still arriving just fails to parse, and nothing happens).
    let (request_read, mut request_was_read) = tokio::sync::mpsc::unbounded_channel::<()>();
    let served = router.clone().layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let request_read = request_read.clone();
            async move {
                let (parts, body) = request.into_parts();
                let bytes = axum::body::to_bytes(body, 1 << 20).await.expect("body");
                let _ = request_read.send(());
                next.run(HttpRequest::from_parts(parts, Body::from(bytes)))
                    .await
            }
        },
    ));
    let server = banto_server::start(
        banto_server::ServerConfig {
            bind: "127.0.0.1".to_string(),
            port: 0,
        },
        served,
    )
    .await
    .expect("start");

    let body = json!({
        "username": "leftearly",
        "password": "password123",
        "displayName": "Left Early",
        "role": "editor"
    })
    .to_string();
    let request = format!(
        "POST /api/users HTTP/1.1\r\nHost: localhost\r\n{}: {}\r\nAuthorization: Bearer {admin}\r\n\
         content-type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        CLIENT_HEADER.0,
        CLIENT_HEADER.1,
        body.len(),
    );
    let mut stream = tokio::net::TcpStream::connect(server.local_addr())
        .await
        .expect("connect");
    stream.write_all(request.as_bytes()).await.expect("write");
    // Everything from here on - authentication, the password hash, the
    // insert, the audit row - runs after the client is gone.
    request_was_read.recv().await.expect("request read");
    drop(stream);

    // Both are read through the same services the listener serves.
    let mut found = (false, false);
    for _ in 0..200 {
        let users = body_json(
            router
                .clone()
                .oneshot(get_auth("/api/users", &admin))
                .await
                .unwrap(),
        )
        .await;
        let created = users
            .as_array()
            .unwrap()
            .iter()
            .any(|user| user["username"] == "leftearly");
        let audited = audit_rows_via_rest(&router, &admin)
            .await
            .iter()
            .any(|row| {
                row["action"] == "create" && row["resource"] == "users" && row["result"] == "ok"
            });
        found = (created, audited);
        if created && audited {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        found,
        (true, true),
        "(account created, audit row written) after the client disconnected"
    );

    assert!(matches!(
        server.stop().await,
        banto_server::StopOutcome::Finished
    ));
}
