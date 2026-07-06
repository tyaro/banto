//! Standalone dev server for the embedded-server milestone (spec §11): runs
//! the full REST + static stack WITHOUT Tauri, so it can be exercised in
//! any environment - including this repo's containers, which cannot build
//! the `src-tauri` crate because they lack webkit2gtk. This is also a
//! user-facing way to preview LAN mode before the settings-screen toggle
//! (Phase B) wires it into the Tauri app itself.
//!
//! This binary always builds (bins cannot be feature-gated the way a
//! library module can); whether it serves the real frontend or the
//! built-in placeholder page depends on the `embed-ui` feature on
//! `admin_template_core::assets::FrontendAssets`, which is applied
//! internally - this file does not need its own `#[cfg(feature = ...)]`.
//!
//! ```text
//! pnpm --filter admin-template build   # produces apps/admin-template/build
//! cargo run -p admin-template-core --bin banto-serve --features embed-ui
//! ```
//!
//! (Omit `--features embed-ui` to serve the built-in placeholder page
//! instead of the real frontend build - useful for exercising the REST API
//! alone.)
//!
//! Env vars: `PORT` (default `8721`), `BANTO_BIND` (default `0.0.0.0`, so
//! the LAN-access URLs printed at startup are actually reachable - the
//! Tauri app's default of `127.0.0.1`-only is a setting applied at the
//! settings-screen layer, Phase B, not a property of this dev vehicle),
//! `BANTO_DB` (default `./banto-dev.sqlite3`).

use admin_template_core::assets::FrontendAssets;
use admin_template_core::db::init_db;
use admin_template_core::events::event_channel;
use admin_template_core::items::ItemsService;
use admin_template_core::rest::api_router;
use banto_server::{lan_urls, start, static_router, AuthState, Identity, ServerConfig};

const DEFAULT_PORT: u16 = 8721;
const DEFAULT_BIND: &str = "0.0.0.0";
const DEFAULT_DB_PATH: &str = "./banto-dev.sqlite3";

/// Demo credential check (admin/admin) - same placeholder as
/// `src-tauri`'s `auth_login` command; both will move to a real
/// credential store together (spec §8.2's TODO).
fn check_demo_credentials(username: &str, password: &str) -> bool {
    username == "admin" && password == "admin"
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let bind = std::env::var("BANTO_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let db_path = std::env::var("BANTO_DB").unwrap_or_else(|_| DEFAULT_DB_PATH.to_string());

    let pool = init_db(&db_path).await.expect("init_db should succeed");

    let events = event_channel();
    let items = ItemsService::new(pool).with_events(events.clone());
    let auth = AuthState::new(
        check_demo_credentials,
        Identity {
            id: "admin".to_string(),
            name: "管理者".to_string(),
        },
    );

    let app = api_router(items, auth, events).merge(static_router::<FrontendAssets>());

    let server = start(ServerConfig { bind, port }, app)
        .await
        .expect("server should start");

    println!("banto-serve: DB at {db_path}");
    println!("banto-serve: listening at:");
    for url in lan_urls(server.local_addr().port()) {
        println!("  {url}");
    }
    println!("banto-serve: demo login is admin / admin");
    println!("banto-serve: press Ctrl-C to stop");

    tokio::signal::ctrl_c()
        .await
        .expect("failed to listen for ctrl-c");
    println!("banto-serve: shutting down");
    server.stop().await;
}
