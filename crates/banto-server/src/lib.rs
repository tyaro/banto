//! Banto server: embedded HTTP server for LAN browser access (spec §11).
//!
//! Resource-agnostic infrastructure only: auth/token management, CSRF
//! header enforcement, SSE event fan-out, static/SPA fallback serving, and
//! server lifecycle (bind/serve/graceful-shutdown). Anything that knows
//! about a specific resource (`items`, ...) or the frontend build's
//! on-disk location lives in the app crate (`apps/admin-template/core`),
//! which composes these pieces via [`auth::auth_routes`],
//! [`events::sse_route`], [`static_files::static_router`] and
//! [`response::ApiError`].
//!
//! Every router built here stays `Router<()>` (no shared `axum::State`):
//! handlers close over their state (`AuthState`, `broadcast::Sender`, ...)
//! instead, so routers from different modules merge without state-type
//! conflicts.

pub mod auth;
pub mod csrf;
pub mod events;
pub mod response;
pub mod server;
pub mod static_files;

pub use auth::{auth_routes, require_auth, AuthState, Identity};
pub use csrf::require_banto_client_header;
pub use events::{sse_route, ServerEvent};
pub use response::ApiError;
pub use server::{lan_urls, start, RunningServer, ServerConfig};
pub use static_files::{guess_mime, static_router, UiAssets};
