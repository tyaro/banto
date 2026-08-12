use super::*;

use banto_admin_services::system_info::SystemInfoService;

// --- System Info (M-review 2026-08 §2.4「縮小版⑤」) --------------------------

/// Admin-only system diagnostics payload (`GET /api/system/info`). Read-only,
/// so it is never audited (conventions §1). `camelCase` on the wire to match
/// the frontend `SystemInfo` interface and the symmetric `system_info` Tauri
/// command's serialized shape.
///
/// The DB-derived fields come from [`SystemInfoService::probe`]; the rest are
/// assembled by this wiring layer: `app_version` is the compiled-in Banto
/// version (uniform across the workspace's `version.workspace = true` crates),
/// `uptime_secs` is measured from server start, and `active_sessions` is the
/// LAN bearer-token count (see the field docs).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// Compiled-in Banto version (`env!("CARGO_PKG_VERSION")`).
    pub app_version: &'static str,
    /// SQL dialect of the live DB handle: `"sqlite"` or `"postgres"`.
    pub db_dialect: &'static str,
    /// Round-trip latency of a `SELECT 1` probe, in milliseconds.
    pub db_latency_ms: f64,
    /// Highest applied migration version, or `null` if unreadable.
    pub migration_version: Option<i64>,
    /// Seconds since this server started serving (router build time).
    pub uptime_secs: u64,
    /// Active LAN bearer sessions (see [`AuthState::session_count`] - an upper
    /// bound; expired-but-not-yet-swept tokens are still counted). This counts
    /// the embedded/LAN server's tokens, not the desktop webview session.
    pub active_sessions: usize,
    /// Total logical attachment size in bytes, or `null` when the optional
    /// attachments feature is absent / unreadable.
    pub attachment_bytes: Option<i64>,
}

/// State for the `/api/system/info` handler: the DB-probe service, the
/// [`AuthState`] whose live token count is reported, and the server-start
/// [`Instant`](std::time::Instant) uptime is measured from.
#[derive(Clone)]
struct SystemInfoState {
    service: SystemInfoService,
    auth: AuthState,
    started_at: std::time::Instant,
}

/// `GET /api/system/info` (admin-only): assemble the diagnostics payload.
/// Read-only - records nothing (conventions §1). A DB that cannot answer the
/// liveness probe surfaces as an error; the best-effort fields degrade to
/// `null` inside [`SystemInfoService::probe`].
async fn system_info(State(state): State<SystemInfoState>) -> Result<Json<SystemInfo>, ApiError> {
    let probe = state.service.probe().await?;
    Ok(Json(SystemInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        db_dialect: probe.dialect,
        db_latency_ms: probe.db_latency_ms,
        migration_version: probe.migration_version,
        uptime_secs: state.started_at.elapsed().as_secs(),
        active_sessions: state.auth.session_count(),
        attachment_bytes: probe.attachment_bytes,
    }))
}

/// `/api/system/info` (M-review 2026-08 §2.4): `admin`-only, guarded the same
/// way `audit_log_router`/`users_router` are (`require_auth` then
/// `require_role_at_least` at the `Admin` floor). `uptime_secs` is measured
/// from this router's construction, which for both vehicles is server start
/// (`banto-serve` main / the embedded LAN server's `start_embedded_server`).
///
/// Needs an [`AuditLogService`] handle purely so [`RoleGuard`] can record a
/// denial when a non-admin hits the route; the read handler itself audits
/// nothing.
pub fn system_info_router(
    service: SystemInfoService,
    auth: AuthState,
    audit: AuditLogService,
) -> Router {
    let state = SystemInfoState {
        service,
        auth: auth.clone(),
        started_at: std::time::Instant::now(),
    };
    Router::new()
        .route("/api/system/info", get(system_info))
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "system",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
