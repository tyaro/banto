//! Banto admin template — Tauri entry point.
//!
//! Thin `tauri::command` adapters only (spec §10): all real logic lives in
//! `admin-template-core` (`apps/admin-template/core`) and `banto-server`
//! (`crates/banto-server`), neither of which has a `tauri` dependency, so
//! both are exercised by plain `cargo test` in environments (e.g. CI
//! containers without webkit2gtk) that cannot build this crate. This file
//! CANNOT be compiled in that same environment - keep changes here small,
//! mechanical, and easy to eyeball-verify against the crates it wires
//! together.
//!
//! M6 Phase B (spec §11) adds the embedded LAN server's lifecycle to this
//! crate: `AppState` gains the settings service, the app-wide
//! resource-change broadcast channel, the embedded server's own auth state,
//! and a slot for the currently-running server (if LAN access is enabled).
//! `setup()` forwards every broadcast event onto the webview via Tauri's own
//! event system (`banto://event`) - this is `TauriEventProvider`'s other
//! half (`packages/admin-core/src/events.ts`) - and auto-starts the server
//! if it was left enabled on a previous run.

mod keyring_store;

use admin_template_core::assets::FrontendAssets;
use admin_template_core::audit::{AuditEntry, AuditLogEntry, AuditLogService};
use admin_template_core::db::init_db;
use admin_template_core::events::event_channel;
use admin_template_core::items::{Item, ItemInput, ItemsService};
use admin_template_core::rest::{api_router, audited_credential_verifier};
use admin_template_core::settings::{AuthSettings, ServerSettings, SettingsService};
use admin_template_core::users::{Role, UserIdentity, UserSummary, UsersService};
use banto_core::{BantoError, FieldError, ListParams, ListResult};
use banto_server::{
    lan_urls, start, static_router, AuthState, RunningServer, ServerConfig, ServerEvent,
};
use qrcode::render::svg;
use qrcode::QrCode;
use serde::Serialize;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tokio::sync::{broadcast, Mutex as AsyncMutex};

/// App-wide state managed by Tauri (spec §10, §11).
struct AppState {
    items: ItemsService,
    /// The webview window's own session identity, set by `auth_login`/
    /// `auth_setup` and cleared by `auth_logout` - all called directly via
    /// `invoke()`, never through `/api/auth/login`. `Some` means logged in;
    /// carrying the full `UserIdentity` (not just a bool) lets
    /// `auth_change_password` recover the current `username` without a
    /// second round trip.
    auth: Mutex<Option<UserIdentity>>,
    /// The local credential store (spec §8.2): argon2id-hashed accounts in
    /// the same SQLite settings DB as `settings` below. Shared with
    /// `rest_auth`'s verifier closure so the webview session and the
    /// embedded-server session always check the same accounts.
    users: UsersService,
    /// App settings (spec §12.1), including the embedded-server config
    /// (spec §11.2/§11.4's enabled/bind/port).
    settings: SettingsService,
    /// App-wide resource-change/notice broadcast (spec §3.5): every
    /// `ItemsService` mutation feeds this, and it is fanned out two ways -
    /// to the webview via the `banto://event` forwarding task spawned in
    /// `setup()`, and (only while the embedded server is running) to LAN
    /// browser clients via `GET /api/events` (`banto_server::sse_route`).
    events: broadcast::Sender<ServerEvent>,
    /// The embedded REST/SSE server's own bearer-token auth state
    /// (`banto_server::AuthState`). Deliberately a SEPARATE token space from
    /// `auth` above: the webview window never logs in through
    /// `/api/auth/login`, so a LAN browser client logging in does not
    /// implicitly authenticate the desktop window, and vice versa - each is
    /// its own session, over its own transport (both sessions ultimately
    /// check the same `users` credential store, though).
    rest_auth: AuthState,
    /// `Some` while LAN access is enabled and successfully bound; `None`
    /// otherwise (disabled, or a previous bind attempt failed - see
    /// `server_apply`).
    server: AsyncMutex<Option<RunningServer>>,
    /// Audit trail (spec M14): every mutating command below records a
    /// `create`/`update`/`delete`/`password_reset`/`settings_change`/
    /// `login`/`login_failed`/`logout`/`setup` entry here (`origin:
    /// "tauri"`) once it has already succeeded, and [`require_role`] records
    /// `denied` when an active session's role is too low. Shares the same
    /// pool as `items`/`users`/`settings` (all four are `Clone` handles onto
    /// the one on-disk SQLite DB, see `run()`'s `setup()`).
    audit: AuditLogService,
}

#[derive(Debug, Clone, Serialize)]
struct LoginResult {
    success: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct Identity {
    id: String,
    name: String,
    /// Spec M10 RBAC: the account's role, as its lowercase wire string (see
    /// `admin_template_core::users::Role::as_str`) - kept a plain `String`
    /// here rather than `Role` itself so this wire type does not need
    /// `Role: Deserialize` for a command return value that is only ever
    /// serialized outbound.
    role: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatusResult {
    initialized: bool,
}

fn identity_from(user: &UserIdentity) -> Identity {
    // Convention shared with `admin_template_core::rest` and `banto-serve`:
    // `Identity.id` is the account's `username` (not `UserIdentity.id`'s
    // numeric row id), so any layer holding only an `Identity` can still
    // recover "which account" for things like `change_password`.
    Identity {
        id: user.username.clone(),
        name: user.display_name.clone(),
        role: user.role.to_string(),
    }
}

/// Require an active webview session with at least role `min` (spec M10
/// RBAC), returning the caller's [`UserIdentity`] on success so callers that
/// also need "which account is this" (e.g. `users_delete`'s self-deletion
/// guard) do not have to re-lock `state.auth`. No session at all ->
/// `BantoError::Unauthorized` (401-equivalent); a session that exists but is
/// under-privileged -> `BantoError::Forbidden` (403-equivalent) - mirrors
/// `admin_template_core::rest`'s `require_auth` then `require_role_at_least`
/// distinction on the REST side.
///
/// `resource` (spec M14) tags the audit entry recorded when an
/// AUTHENTICATED session's role is too low - mirrors REST's
/// `RoleGuard`/`require_role_at_least`. The no-session (`Unauthorized`) case
/// is deliberately NOT recorded, same reasoning as the REST side: it means
/// there is nothing resembling a real user to attribute a denial to, not a
/// meaningful RBAC decision.
///
/// `async` (unlike its pre-M14 form) only to `.await` that audit write -
/// every call site is already inside an `async fn` Tauri command. The
/// `state.auth` lock is dropped (via the `identity` clone below) BEFORE the
/// `.await`, since `std::sync::MutexGuard` is `!Send` and holding one across
/// an await point would make the command's future `!Send` (which `tauri`
/// requires).
async fn require_role(state: &AppState, min: Role, resource: &str) -> Result<UserIdentity, BantoError> {
    let current = state.auth.lock().expect("auth mutex poisoned").clone();
    match current {
        Some(identity) if identity.role.at_least(min) => Ok(identity),
        Some(identity) => {
            state
                .audit
                .record(AuditEntry {
                    actor_username: Some(&identity.username),
                    actor_role: Some(identity.role.as_str()),
                    action: "denied",
                    resource,
                    entity_id: None,
                    detail: None,
                    origin: "tauri",
                    result: "denied",
                })
                .await;
            Err(BantoError::Forbidden)
        }
        None => Err(BantoError::Unauthorized),
    }
}

/// Smoke-test command used by the frontend to verify the bridge.
#[tauri::command]
fn ping() -> &'static str {
    concat!("banto ", env!("CARGO_PKG_VERSION"))
}

/// Read-only (spec M10 RBAC): any authenticated role (`viewer` and up), so
/// `require_role`'s floor is the least-privileged role.
#[tauri::command]
async fn items_list(
    state: State<'_, AppState>,
    params: ListParams,
) -> Result<ListResult<Item>, BantoError> {
    require_role(&state, Role::Viewer, "items").await?;
    state.items.list(params).await
}

#[tauri::command]
async fn items_get(state: State<'_, AppState>, id: i64) -> Result<Item, BantoError> {
    require_role(&state, Role::Viewer, "items").await?;
    state.items.get(id).await
}

#[tauri::command]
async fn items_create(state: State<'_, AppState>, values: ItemInput) -> Result<Item, BantoError> {
    let actor = require_role(&state, Role::Editor, "items").await?;
    let item = state.items.create(values).await?;
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action: "create",
            resource: "items",
            entity_id: Some(&item.id.to_string()),
            detail: Some(serde_json::json!({ "name": item.name })),
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(item)
}

#[tauri::command]
async fn items_update(
    state: State<'_, AppState>,
    id: i64,
    values: ItemInput,
) -> Result<Item, BantoError> {
    let actor = require_role(&state, Role::Editor, "items").await?;
    let item = state.items.update(id, values).await?;
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action: "update",
            resource: "items",
            entity_id: Some(&item.id.to_string()),
            detail: Some(serde_json::json!({ "name": item.name })),
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(item)
}

#[tauri::command]
async fn items_delete(state: State<'_, AppState>, id: i64) -> Result<(), BantoError> {
    let actor = require_role(&state, Role::Editor, "items").await?;
    state.items.delete(id).await?;
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action: "delete",
            resource: "items",
            entity_id: Some(&id.to_string()),
            detail: None,
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(())
}

/// `GET`-ish command: has an account been created yet (spec §3.3/§8.2)? The
/// login page calls this first to decide between the first-run setup form
/// and the normal login form.
#[tauri::command]
async fn auth_status(state: State<'_, AppState>) -> Result<AuthStatusResult, BantoError> {
    Ok(AuthStatusResult {
        initialized: state.users.is_initialized().await?,
    })
}

/// Create the very first account and log the webview session in as it
/// (spec §8.2). `BantoError::Validation` (bad username/short password)
/// propagates as `Err` so the frontend form store can field-map it;
/// "already initialized" (or any other non-validation failure) surfaces as
/// `Ok(LoginResult { success: false, .. })` instead, since that is an
/// expected/retryable outcome, not a form error.
#[tauri::command]
async fn auth_setup(
    state: State<'_, AppState>,
    username: String,
    password: String,
    display_name: String,
) -> Result<LoginResult, BantoError> {
    match state
        .users
        .setup_first_user(&username, &password, &display_name)
        .await
    {
        Ok(identity) => {
            state
                .audit
                .record(AuditEntry {
                    actor_username: Some(&identity.username),
                    actor_role: Some(identity.role.as_str()),
                    action: "setup",
                    resource: "auth",
                    entity_id: None,
                    detail: None,
                    origin: "tauri",
                    result: "ok",
                })
                .await;
            *state.auth.lock().expect("auth mutex poisoned") = Some(identity);
            Ok(LoginResult {
                success: true,
                error: None,
            })
        }
        Err(err @ BantoError::Validation { .. }) => Err(err),
        Err(other) => Ok(LoginResult {
            success: false,
            error: Some(other.to_string()),
        }),
    }
}

#[tauri::command]
async fn auth_login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<LoginResult, BantoError> {
    match state.users.verify(&username, &password).await? {
        Some(identity) => {
            state
                .audit
                .record(AuditEntry {
                    actor_username: Some(&identity.username),
                    actor_role: Some(identity.role.as_str()),
                    action: "login",
                    resource: "auth",
                    entity_id: None,
                    detail: None,
                    origin: "tauri",
                    result: "ok",
                })
                .await;
            *state.auth.lock().expect("auth mutex poisoned") = Some(identity);
            Ok(LoginResult {
                success: true,
                error: None,
            })
        }
        None => {
            state
                .audit
                .record(AuditEntry {
                    actor_username: Some(&username),
                    actor_role: None,
                    action: "login_failed",
                    resource: "auth",
                    entity_id: None,
                    detail: None,
                    origin: "tauri",
                    result: "failed",
                })
                .await;
            Ok(LoginResult {
                success: false,
                error: Some("ユーザー名またはパスワードが違います".to_string()),
            })
        }
    }
}

/// No-op while auth-disabled mode is on (spec M11): that mode has no login
/// screen to fall back to, so clearing `state.auth` here would strand the
/// webview with no session at all until the next app restart re-runs the
/// bootstrap in `run()`. Re-synthesizing the identity inline (instead of
/// just refusing to clear it) was considered and rejected as needlessly
/// complex for the same outcome - the simpler "logout does nothing in this
/// mode" reads clearly at the call site and matches auth-disabled mode's
/// framing as "this whole device is trusted, there is no session to log out
/// of". Spec M14: that no-op path deliberately records no `logout` entry
/// either - nothing actually changed.
#[tauri::command]
async fn auth_logout(state: State<'_, AppState>) -> Result<(), BantoError> {
    if state.settings.auth_config().await?.disabled {
        return Ok(());
    }
    let previous = state.auth.lock().expect("auth mutex poisoned").clone();
    *state.auth.lock().expect("auth mutex poisoned") = None;
    if let Some(identity) = previous {
        state
            .audit
            .record(AuditEntry {
                actor_username: Some(&identity.username),
                actor_role: Some(identity.role.as_str()),
                action: "logout",
                resource: "auth",
                entity_id: None,
                detail: None,
                origin: "tauri",
                result: "ok",
            })
            .await;
    }
    Ok(())
}

#[tauri::command]
fn auth_check(state: State<'_, AppState>) -> bool {
    state.auth.lock().expect("auth mutex poisoned").is_some()
}

#[tauri::command]
fn auth_identity(state: State<'_, AppState>) -> Option<Identity> {
    state
        .auth
        .lock()
        .expect("auth mutex poisoned")
        .as_ref()
        .map(identity_from)
}

/// Body of [`auth_change_password`], split out so the audit-recording
/// behavior (spec M14) is testable with a plain `&AppState` in this crate's
/// own `cargo test` - `tauri::State` cannot be constructed outside a running
/// tauri app, but it derefs to `&AppState`, so the command below is a
/// one-line adapter.
async fn change_own_password(
    state: &AppState,
    current_password: &str,
    new_password: &str,
) -> Result<(), BantoError> {
    let identity = {
        let guard = state.auth.lock().expect("auth mutex poisoned");
        match guard.as_ref() {
            Some(identity) => identity.clone(),
            None => return Err(BantoError::Unauthorized),
        }
    };
    state
        .users
        .change_password(&identity.username, current_password, new_password)
        .await?;
    // Spec M14: a self-service password change is a security event (it is
    // also what naturally invalidates an M11 autologin credential), so it IS
    // audited - actor and entity are both the caller. `detail` stays `None`:
    // neither the old nor the new password (nor any hash) may ever be
    // recorded.
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&identity.username),
            actor_role: Some(identity.role.as_str()),
            action: "password_change",
            resource: "users",
            entity_id: Some(&identity.id.to_string()),
            detail: None,
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(())
}

/// Requires an active webview session (spec §8.2): looks up the logged-in
/// account's `username` from `state.auth` rather than taking it as a
/// parameter, so a caller cannot change a DIFFERENT account's password just
/// by naming it.
#[tauri::command]
async fn auth_change_password(
    state: State<'_, AppState>,
    current_password: String,
    new_password: String,
) -> Result<(), BantoError> {
    change_own_password(&state, &current_password, &new_password).await
}

// --- M11: auth-disabled mode + desktop autologin ---------------------------

/// Current auth-mode settings (spec M11): any authenticated role may read
/// this (it only feeds a settings-screen display), and it never carries the
/// autologin password - `AuthSettings` itself has no such field (see its doc
/// comment in `admin_template_core::settings`).
#[tauri::command]
async fn auth_config_get(state: State<'_, AppState>) -> Result<AuthSettings, BantoError> {
    require_role(&state, Role::Viewer, "settings").await?;
    state.settings.auth_config().await
}

/// Toggle auth-disabled mode and its synthetic-identity role (spec M11).
///
/// Normally `admin`-only, like every other server/settings-mutating command
/// here. ESCAPE HATCH: while auth-disabled mode is CURRENTLY active, this
/// command is allowed regardless of the calling session's role. Reason: in
/// that mode the webview's only session is the synthetic identity `run()`'s
/// bootstrap manufactures from `disabled_role` (see that function) - if an
/// operator had configured `disabled_role` as something below `admin` (e.g.
/// `viewer`, for a kiosk), that synthetic session could never call this
/// command to turn auth back ON again, permanently locking the running app
/// out of re-enabling authentication short of editing the SQLite settings DB
/// by hand. Auth-disabled mode is already documented as "trust the whole
/// device" (spec M11), so not gating the one command that re-locks it down
/// behind a role that mode itself may have suppressed is consistent with
/// that trust model, not a weakening of it.
#[tauri::command]
async fn auth_config_apply(
    state: State<'_, AppState>,
    disabled: bool,
    disabled_role: String,
) -> Result<AuthSettings, BantoError> {
    let currently_disabled = state.settings.auth_config().await?.disabled;
    // Spec M14: the escape hatch means `require_role` may not run at all
    // (see this command's doc comment) - capture whatever actor identity
    // exists directly in that case, so the audit entry below still has one
    // when possible, instead of skipping the escape-hatch path's write
    // entirely.
    let actor = if currently_disabled {
        state.auth.lock().expect("auth mutex poisoned").clone()
    } else {
        Some(require_role(&state, Role::Admin, "settings").await?)
    };

    // An unrecognized role string falls back to `admin` (same convention as
    // `SettingsService::auth_config`'s own read-time fallback) rather than
    // failing the whole command - a bad value here must never leave the app
    // unable to determine ANY role for the synthetic identity.
    let role = Role::from_str(&disabled_role).unwrap_or(Role::Admin);

    let mut config = state.settings.auth_config().await?;
    config.disabled = disabled;
    config.disabled_role = role;
    state.settings.set_auth_config(&config).await?;
    state
        .audit
        .record(AuditEntry {
            actor_username: actor.as_ref().map(|i| i.username.as_str()),
            actor_role: actor.as_ref().map(|i| i.role.as_str()),
            action: "settings_change",
            resource: "settings",
            entity_id: None,
            detail: Some(serde_json::json!({ "authDisabled": disabled })),
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(config)
}

/// Enable desktop autologin for `username` (spec M11): verifies the
/// credentials against the same `UsersService` a normal login would (so a
/// caller cannot register autologin for an account/password it does not
/// actually know), stores the password in the OS keyring (never in the
/// settings DB - see `keyring_store`), and flips the setting on. `admin`-only,
/// same floor as every other server/settings-mutating command.
#[tauri::command]
async fn autologin_enable(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<(), BantoError> {
    let actor = require_role(&state, Role::Admin, "settings").await?;

    if state.users.verify(&username, &password).await?.is_none() {
        return Err(BantoError::Validation {
            field_errors: vec![FieldError {
                field: "password".to_string(),
                message: "ユーザー名またはパスワードが違います".to_string(),
            }],
        });
    }

    keyring_store::set_password(&username, &password)?;

    let mut config = state.settings.auth_config().await?;
    config.autologin_enabled = true;
    config.autologin_username = Some(username.clone());
    state.settings.set_auth_config(&config).await?;
    // Spec M14: the target `username` (never the password) is fine to
    // record - it identifies WHICH account autologin now applies to, no
    // different from `users_update`'s `role` detail.
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action: "settings_change",
            resource: "settings",
            entity_id: None,
            detail: Some(serde_json::json!({ "autologinEnabled": true, "username": username })),
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(())
}

/// Disable desktop autologin (spec M11): removes the stored credential from
/// the OS keyring (best-effort - a keyring delete failure is logged, not
/// propagated, so the setting is still turned off even if the OS store is,
/// say, already gone) and clears the setting.
#[tauri::command]
async fn autologin_disable(state: State<'_, AppState>) -> Result<(), BantoError> {
    let actor = require_role(&state, Role::Admin, "settings").await?;

    let mut config = state.settings.auth_config().await?;
    if let Some(username) = config.autologin_username.take() {
        if let Err(err) = keyring_store::delete_password(&username) {
            eprintln!("banto: 自動ログインの資格情報のキーリング削除に失敗しました: {err}");
        }
    }
    config.autologin_enabled = false;
    state.settings.set_auth_config(&config).await?;
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action: "settings_change",
            resource: "settings",
            entity_id: None,
            detail: Some(serde_json::json!({ "autologinEnabled": false })),
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(())
}

/// One LAN access URL plus its QR code, rendered as an inline SVG string
/// (spec §11.4).
#[derive(Debug, Clone, Serialize)]
struct QrSvgEntry {
    url: String,
    svg: String,
}

/// `server_status`/`server_apply`'s shared response shape - mirrors
/// `src/lib/banto/serverAdmin.ts::ServerStatus` field-for-field.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatusResult {
    enabled: bool,
    running: bool,
    bind: String,
    port: u16,
    urls: Vec<String>,
    qr_svgs: Vec<QrSvgEntry>,
}

/// Render `data` (a LAN access URL) as an inline SVG QR code (spec §11.4).
/// Falls back to an empty string on an encoding failure rather than
/// panicking - our inputs are short `http://host:port` strings well within
/// QR capacity, so this should not happen in practice, but this only feeds
/// a settings-screen `{@html}` display, not anything load-bearing.
fn qr_svg_for(data: &str) -> String {
    QrCode::new(data)
        .map(|code| code.render::<svg::Color>().min_dimensions(160, 160).build())
        .unwrap_or_default()
}

fn build_status(config: &ServerSettings, running: bool) -> ServerStatusResult {
    let urls = lan_urls(config.port);
    let qr_svgs = urls
        .iter()
        .map(|url| QrSvgEntry {
            url: url.clone(),
            svg: qr_svg_for(url),
        })
        .collect();
    ServerStatusResult {
        enabled: config.enabled,
        running,
        bind: config.bind.clone(),
        port: config.port,
        urls,
        qr_svgs,
    }
}

/// Build the full `/api/*` + static-asset router (spec §11.1) and start
/// listening. Shared by `setup()` (auto-start on launch if LAN access was
/// left enabled) and the `server_apply` command (spec §11.4's
/// 「保存して適用」button).
///
/// Deliberately never names the intermediate `axum::Router` type anywhere -
/// `axum` is not (and does not need to be) a direct dependency of this
/// crate purely to support this one function: Rust only requires a crate to
/// be listed in `[dependencies]` to *spell out* one of its types in source,
/// and the router value here only ever flows through an inferred `let`
/// binding on its way into `banto_server::start`.
async fn start_embedded_server(
    items: ItemsService,
    users: UsersService,
    settings: SettingsService,
    audit: AuditLogService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
    config: ServerConfig,
) -> Result<RunningServer, BantoError> {
    // `allow_setup: false` - the Tauri app's first-run setup goes through
    // the `auth_setup` command above (`invoke()`, no network involved), not
    // this REST endpoint. Only `banto-serve` (this repo's Tauri-free dev
    // vehicle) opts into `POST /api/auth/setup` via `BANTO_ALLOW_SETUP=1`.
    let router = api_router(items, users, settings, audit, auth, events, false)
        .merge(static_router::<FrontendAssets>());
    start(config, router).await
}

/// `GET`-ish command: current persisted settings + live running state (spec
/// §11.4's status line). `admin`-only (spec M10: "サーバ制御系 = admin").
#[tauri::command]
async fn server_status(state: State<'_, AppState>) -> Result<ServerStatusResult, BantoError> {
    require_role(&state, Role::Admin, "settings").await?;
    let config = state.settings.server_config().await?;
    let running = state.server.lock().await.is_some();
    Ok(build_status(&config, running))
}

/// Persist new settings, stop whatever is currently running, and start a
/// fresh instance if `enabled` (spec §11.4's 「保存して適用」button).
/// Stop-then-maybe-start unconditionally (rather than diffing old vs. new
/// config) keeps this simple to reason about, at the cost of a
/// no-op restart when the caller "changes" settings to the same values -
/// an acceptable trade for a settings-screen action a user triggers
/// explicitly and infrequently.
#[tauri::command]
async fn server_apply(
    state: State<'_, AppState>,
    enabled: bool,
    bind: String,
    port: u16,
) -> Result<ServerStatusResult, BantoError> {
    let actor = require_role(&state, Role::Admin, "settings").await?;
    let config = ServerSettings {
        enabled,
        bind,
        port,
    };
    state.settings.set_server_config(&config).await?;

    if let Some(running) = state.server.lock().await.take() {
        running.stop().await;
    }

    let started = if config.enabled {
        Some(
            start_embedded_server(
                state.items.clone(),
                state.users.clone(),
                state.settings.clone(),
                state.audit.clone(),
                state.rest_auth.clone(),
                state.events.clone(),
                ServerConfig {
                    bind: config.bind.clone(),
                    port: config.port,
                },
            )
            .await?,
        )
    } else {
        None
    };

    let running = started.is_some();
    *state.server.lock().await = started;
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action: "settings_change",
            resource: "settings",
            entity_id: None,
            detail: Some(serde_json::json!({
                "serverEnabled": config.enabled,
                "bind": config.bind,
                "port": config.port,
            })),
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(build_status(&config, running))
}

#[tauri::command]
async fn settings_get(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, BantoError> {
    state.settings.get(&key).await
}

/// `admin`-only (spec M10): writing settings (which include the embedded
/// server's enable/bind/port via `server_apply` and, generically, anything
/// else stored through this key/value command) is a privileged action.
#[tauri::command]
async fn settings_set(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), BantoError> {
    let actor = require_role(&state, Role::Admin, "settings").await?;
    state.settings.set(&key, &value).await?;
    // Spec M14: only the KEY is recorded, never the value - this is a
    // generic key/value store and the value could be anything, including
    // something sensitive a future setting might store here.
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action: "settings_change",
            resource: "settings",
            entity_id: None,
            detail: Some(serde_json::json!({ "key": key })),
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(())
}

// --- M12: per-user UI settings + window vibrancy ----------------------------

/// Read one of the calling user's OWN UI settings (spec M12
/// SettingsProvider migration: theme mode/preset, dock layout). Any
/// authenticated role - unlike `settings_get`/`settings_set` these only ever
/// touch keys namespaced under the caller's own username
/// (`SettingsService::ui_get`'s `ui.{username}.{key}` scheme), so no
/// privilege is involved. In auth-disabled mode (spec M11) the synthetic
/// session's username is `"local"`, so all UI settings share that one
/// namespace - consistent with that mode's "the whole device is one trusted
/// user" framing.
#[tauri::command]
async fn ui_settings_get(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, BantoError> {
    let identity = require_role(&state, Role::Viewer, "settings").await?;
    state.settings.ui_get(&identity.username, &key).await
}

/// Write one of the calling user's OWN UI settings (spec M12). Any
/// authenticated role - deliberately NOT `admin`-gated like `settings_set`,
/// see [`ui_settings_get`]'s doc comment. Spec M14: NOT audited, same
/// reasoning as the REST `/api/ui-settings/*` routes (see `rest.rs`'s module
/// doc comment) - this is each user's own theme/dock-layout preference, not
/// an admin-scoped "settings change".
#[tauri::command]
async fn ui_settings_set(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), BantoError> {
    let identity = require_role(&state, Role::Viewer, "settings").await?;
    state
        .settings
        .ui_set(&identity.username, &key, &value)
        .await
}

/// Settings key for the desktop vibrancy toggle (spec M12): a GLOBAL
/// setting ("true"/"false", default off), not a per-user `ui.*` one - it
/// changes the physical window every user of this desktop install shares.
const KEY_DESKTOP_VIBRANCY: &str = "desktop.vibrancy";

/// `vibrancy_status`'s response shape (spec M12): the persisted toggle
/// state plus whether this build can apply it at all (`supported` is `false`
/// on non-Windows, letting the settings screen hide/disable the toggle
/// instead of showing one that can only error).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VibrancyStatus {
    enabled: bool,
    supported: bool,
}

/// Apply or clear the Acrylic effect on `window` (Windows only, spec M12).
/// The `(18, 18, 18, 125)` tint keeps the blur legibly dark in both theme
/// modes without fully occluding the backdrop.
#[cfg(target_os = "windows")]
fn set_window_vibrancy(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), BantoError> {
    let result = if enabled {
        window_vibrancy::apply_acrylic(window, Some((18, 18, 18, 125)))
    } else {
        window_vibrancy::clear_acrylic(window)
    };
    result.map_err(|err| {
        BantoError::Other(format!(
            "ウィンドウのAcrylic効果の適用に失敗しました: {err}"
        ))
    })
}

/// Toggle real window translucency (Windows Acrylic) for the main window
/// and persist the choice (spec M12). `admin`-only, same floor as
/// `settings_set` (this writes a global setting). The setting is only
/// persisted AFTER the effect applied successfully - a machine that cannot
/// apply Acrylic (e.g. an old Windows 10 build) keeps its stored value
/// unchanged instead of persisting a state the window does not reflect.
/// Returns the applied state.
///
/// Non-Windows builds always fail with a clear message (Windows のみ, spec
/// M12/docs/roadmap.md §6) - the frontend avoids ever calling this there by
/// checking `vibrancy_status().supported` first.
#[tauri::command]
async fn vibrancy_apply(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<bool, BantoError> {
    let actor = require_role(&state, Role::Admin, "settings").await?;

    #[cfg(target_os = "windows")]
    {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| BantoError::Other("メインウィンドウが見つかりません".to_string()))?;
        set_window_vibrancy(&window, enabled)?;
        state
            .settings
            .set(KEY_DESKTOP_VIBRANCY, if enabled { "true" } else { "false" })
            .await?;
        state
            .audit
            .record(AuditEntry {
                actor_username: Some(&actor.username),
                actor_role: Some(actor.role.as_str()),
                action: "settings_change",
                resource: "settings",
                entity_id: None,
                detail: Some(serde_json::json!({ "vibrancyEnabled": enabled })),
                origin: "tauri",
                result: "ok",
            })
            .await;
        Ok(enabled)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, enabled, actor); // parameters only used on Windows
        Err(BantoError::Other(
            "この機能はWindowsでのみ利用できます".to_string(),
        ))
    }
}

/// Current vibrancy state (spec M12): any authenticated role (it only feeds
/// the settings screen's toggle display). Never errors on non-Windows -
/// `supported: false` (with `enabled: false`, regardless of any stored
/// value) is the signal the frontend uses to hide the toggle.
#[tauri::command]
async fn vibrancy_status(state: State<'_, AppState>) -> Result<VibrancyStatus, BantoError> {
    require_role(&state, Role::Viewer, "settings").await?;
    let supported = cfg!(target_os = "windows");
    let enabled = supported
        && state
            .settings
            .get(KEY_DESKTOP_VIBRANCY)
            .await?
            .map(|value| value == "true")
            .unwrap_or(false);
    Ok(VibrancyStatus { enabled, supported })
}

/// Wire shape returned by `users_create` (spec M10): everything
/// `UserIdentity` carries, `Serialize`d for the Tauri command boundary
/// (`UserIdentity` itself is not `Serialize` - see its doc comment in
/// `admin_template_core::users`). No `createdAt` (unlike [`UserSummary`],
/// which `users_list`/`users_update` return): `UsersService::create_user`
/// does not read it back from the DB, only the row it just inserted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserIdentityResult {
    id: i64,
    username: String,
    display_name: String,
    role: Role,
}

impl From<UserIdentity> for UserIdentityResult {
    fn from(identity: UserIdentity) -> Self {
        Self {
            id: identity.id,
            username: identity.username,
            display_name: identity.display_name,
            role: identity.role,
        }
    }
}

/// `admin`-only (spec M10): the user-management screen's account list.
#[tauri::command]
async fn users_list(state: State<'_, AppState>) -> Result<Vec<UserSummary>, BantoError> {
    require_role(&state, Role::Admin, "users").await?;
    state.users.list_users().await
}

/// `admin`-only (spec M10): create an additional account.
#[tauri::command]
async fn users_create(
    state: State<'_, AppState>,
    username: String,
    password: String,
    display_name: String,
    role: Role,
) -> Result<UserIdentityResult, BantoError> {
    let actor = require_role(&state, Role::Admin, "users").await?;
    let identity = state
        .users
        .create_user(&username, &password, &display_name, role)
        .await?;
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action: "create",
            resource: "users",
            entity_id: Some(&identity.id.to_string()),
            detail: Some(serde_json::json!({ "username": identity.username, "role": identity.role })),
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(identity.into())
}

/// `admin`-only (spec M10): update an account's display name/role. Refuses
/// to demote the last remaining `admin` (`UsersService::update_user`'s
/// guard).
#[tauri::command]
async fn users_update(
    state: State<'_, AppState>,
    id: i64,
    display_name: String,
    role: Role,
) -> Result<UserSummary, BantoError> {
    let actor = require_role(&state, Role::Admin, "users").await?;
    let updated = state.users.update_user(id, &display_name, role).await?;
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action: "update",
            resource: "users",
            entity_id: Some(&id.to_string()),
            detail: Some(serde_json::json!({ "role": updated.role })),
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(updated)
}

/// `admin`-only (spec M10): reset another account's password without
/// knowing its current one (unlike self-service `auth_change_password`).
#[tauri::command]
async fn users_reset_password(
    state: State<'_, AppState>,
    id: i64,
    new_password: String,
) -> Result<(), BantoError> {
    let actor = require_role(&state, Role::Admin, "users").await?;
    state.users.reset_password(id, &new_password).await?;
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action: "password_reset",
            resource: "users",
            entity_id: Some(&id.to_string()),
            detail: None,
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(())
}

/// `admin`-only (spec M10): delete an account. Refuses to delete the last
/// remaining `admin` or the caller's own account
/// (`UsersService::delete_user`'s guards) - the acting admin's id comes
/// from the session `require_role` just verified, not from an argument, so
/// a caller cannot spoof a different acting user.
#[tauri::command]
async fn users_delete(state: State<'_, AppState>, id: i64) -> Result<(), BantoError> {
    let acting = require_role(&state, Role::Admin, "users").await?;
    state.users.delete_user(id, acting.id).await?;
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&acting.username),
            actor_role: Some(acting.role.as_str()),
            action: "delete",
            resource: "users",
            entity_id: Some(&id.to_string()),
            detail: None,
            origin: "tauri",
            result: "ok",
        })
        .await;
    Ok(())
}

/// `admin`-only (spec M14): the audit-log viewer's filtered/sorted/
/// paginated read. Also opportunistically prunes first - same reasoning as
/// `admin_template_core::rest::audit_log_list` (see that function's doc
/// comment).
#[tauri::command]
async fn audit_log_list(
    state: State<'_, AppState>,
    params: ListParams,
) -> Result<ListResult<AuditLogEntry>, BantoError> {
    require_role(&state, Role::Admin, "audit_log").await?;
    if let Ok(config) = state.settings.audit_config().await {
        let _ = state
            .audit
            .prune(config.retention_days, config.retention_rows)
            .await;
    }
    state.audit.list(params).await
}

/// Pop a dock panel out into a REAL native window (spec §5.3 v2 - the
/// "ウィンドウ分離" mode the v1 doc comment left as a future extension
/// point). Thin by design: this is the ONLY Tauri-aware half of the pop-out
/// feature - everything else (deciding when to call it, restoring the panel
/// to the dock afterward) lives in testable frontend layers
/// (`packages/dock-svelte`, `apps/admin-template/src/lib/banto/popout.ts`).
///
/// One native window per panel id, labeled `panel-{id}` - calling this again
/// for an already-open panel just focuses the existing window instead of
/// opening a second one. `WebviewUrl::App("panel/{id}")` points at the
/// standalone `routes/panel/[id]` SvelteKit route (no sidebar/header shell,
/// its own auth check - see that route's doc comment), the SAME static
/// build the main window's webview loads (spec §8.1's `adapter-static` SPA
/// build).
///
/// On close (`WindowEvent::Destroyed`), emits `banto://panel-closed` to the
/// main window with the panel id so the dashboard can `dock.open(id)` it
/// back into view (`popout.ts::listenPanelClosed`) - the other half of this
/// round trip.
#[tauri::command]
async fn panel_open(app: tauri::AppHandle, id: String, title: String) -> Result<(), BantoError> {
    let label = format!("panel-{id}");

    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.set_focus();
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        &app,
        label.clone(),
        tauri::WebviewUrl::App(format!("panel/{id}").into()),
    )
    .title(title)
    .inner_size(560.0, 420.0)
    .min_inner_size(320.0, 240.0)
    .build()
    .map_err(|err| BantoError::Other(err.to_string()))?;

    // Cloned into the closure: `on_window_event`'s handler is `'static`, so
    // it cannot borrow `app`/`id` from this function's stack frame.
    let app_for_event = app.clone();
    let closed_id = id.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            // Best-effort: the main window may already be gone (app
            // shutting down) - nothing useful to do with an emit failure
            // here either way.
            let _ = app_for_event.emit_to("main", "banto://panel-closed", closed_id.clone());
        }
    });

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("resolve app data dir");
            std::fs::create_dir_all(&data_dir).expect("create app data dir");
            let db_path = data_dir.join("admin-template.sqlite3");

            // init_db takes a filesystem path (not a sqlite:// URL) so
            // Windows paths with drive letters/backslashes work unchanged.
            let pool =
                tauri::async_runtime::block_on(init_db(&db_path)).expect("init_db should succeed");

            let events = event_channel();
            let items = ItemsService::new(pool.clone()).with_events(events.clone());
            let users = UsersService::new(pool.clone());
            let settings = SettingsService::new(pool.clone());
            let audit = AuditLogService::new(pool);
            // Records `login`/`login_failed` audit entries (spec M14) from
            // inside the verifier itself - see
            // `admin_template_core::rest::audited_credential_verifier`'s doc
            // comment. This is the embedded LAN server's OWN session
            // (`origin: "rest"`) - the webview's session goes through
            // `auth_login` below instead.
            let rest_auth = AuthState::new(audited_credential_verifier(users.clone(), audit.clone()));

            // Startup prune (spec M14: "アプリ起動時に1回 + list実行時に軽く" -
            // see `audit_log_list`'s doc comment for why no dedicated
            // background task is needed beyond this plus that opportunistic
            // prune). Best-effort: a prune failure must never block startup.
            match tauri::async_runtime::block_on(settings.audit_config()) {
                Ok(config) => {
                    if let Err(err) = tauri::async_runtime::block_on(
                        audit.prune(config.retention_days, config.retention_rows),
                    ) {
                        eprintln!("banto: 起動時の監査ログの剪定に失敗しました: {err}");
                    }
                }
                Err(err) => eprintln!("banto: 監査ログの保持設定の読み取りに失敗しました: {err}"),
            }

            // Forward every resource-change/notice event onto the webview
            // (spec §3.5's TauriEventProvider side: the webview has no
            // network, so it cannot use the SSE endpoint a LAN browser
            // client uses - `banto://event` is the in-process equivalent,
            // fed by the SAME broadcast channel the REST server's SSE route
            // fans out to browsers while running).
            let app_handle = app.handle().clone();
            let mut events_rx = events.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events_rx.recv().await {
                        Ok(event) => {
                            let _ = app_handle.emit("banto://event", event);
                        }
                        // A slow/absent listener fell behind: skip the gap
                        // rather than tearing down the forwarding task.
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // M11 bootstrap: decide the webview's starting session before
            // anything else, in priority order -
            //   1. auth-disabled mode ("ログイン不要モード") - a synthetic
            //      identity, no login screen at all.
            //   2. desktop autologin - verify a keyring-stored credential
            //      against `users`, same as a normal login.
            //   3. neither - the ordinary login screen (`auth: None`).
            let auth_config = tauri::async_runtime::block_on(settings.auth_config())
                .expect("auth_config should succeed");
            let initial_auth: Option<UserIdentity> = if auth_config.disabled {
                // `id: 0` is not a real `users` row - nothing here ever looks
                // it up by id (no change-password/self-deletion flows apply
                // to a synthetic session), so there is no real row to alias.
                let local_identity = UserIdentity {
                    id: 0,
                    username: "local".to_string(),
                    display_name: "ローカルユーザー".to_string(),
                    role: auth_config.disabled_role,
                };
                // Spec M14: auth-disabled mode still records a `login` for
                // its synthetic session, same as a normal login would - it
                // is still "someone" starting to use the app, just without a
                // credential check.
                tauri::async_runtime::block_on(audit.record(AuditEntry {
                    actor_username: Some(&local_identity.username),
                    actor_role: Some(local_identity.role.as_str()),
                    action: "login",
                    resource: "auth",
                    entity_id: None,
                    detail: Some(serde_json::json!({ "mode": "auth_disabled" })),
                    origin: "tauri",
                    result: "ok",
                }));
                Some(local_identity)
            } else if auth_config.autologin_enabled {
                match &auth_config.autologin_username {
                    Some(username) => match keyring_store::get_password(username) {
                        Ok(password) => {
                            match tauri::async_runtime::block_on(users.verify(username, &password))
                            {
                                Ok(Some(identity)) => {
                                    tauri::async_runtime::block_on(audit.record(AuditEntry {
                                        actor_username: Some(&identity.username),
                                        actor_role: Some(identity.role.as_str()),
                                        action: "login",
                                        resource: "auth",
                                        entity_id: None,
                                        detail: Some(serde_json::json!({ "via": "autologin" })),
                                        origin: "tauri",
                                        result: "ok",
                                    }));
                                    Some(identity)
                                }
                                Ok(None) => {
                                    // Credentials no longer valid (e.g. the
                                    // password was changed since autologin
                                    // was set up) - spec M11: do NOT
                                    // auto-disable the setting, just fall
                                    // through to the login screen.
                                    eprintln!(
                                        "banto: 自動ログインの資格情報が無効です（パスワード変更等）。ログイン画面を表示します。"
                                    );
                                    tauri::async_runtime::block_on(audit.record(AuditEntry {
                                        actor_username: Some(username),
                                        actor_role: None,
                                        action: "login_failed",
                                        resource: "auth",
                                        entity_id: None,
                                        detail: Some(serde_json::json!({ "via": "autologin" })),
                                        origin: "tauri",
                                        result: "failed",
                                    }));
                                    None
                                }
                                Err(err) => {
                                    eprintln!("banto: 自動ログインの検証に失敗しました: {err}");
                                    tauri::async_runtime::block_on(audit.record(AuditEntry {
                                        actor_username: Some(username),
                                        actor_role: None,
                                        action: "login_failed",
                                        resource: "auth",
                                        entity_id: None,
                                        detail: Some(serde_json::json!({ "via": "autologin" })),
                                        origin: "tauri",
                                        result: "failed",
                                    }));
                                    None
                                }
                            }
                        }
                        Err(err) => {
                            // Keyring entry missing / backend unavailable -
                            // safe degrade to the login screen (spec M11).
                            eprintln!("banto: 自動ログインの資格情報の取得に失敗しました: {err}");
                            None
                        }
                    },
                    None => None,
                }
            } else {
                None
            };

            // If LAN access was left enabled on a previous run, start the
            // server immediately (spec §11.4) - from here on, the settings
            // screen only needs to *change* state via `server_apply`.
            //
            // Spec M11 exclusivity is enforced at write-time
            // (`SettingsService::set_server_config`/`set_auth_config`), but a
            // hand-edited settings DB could still leave both
            // `auth.disabled` and `server.enabled` set to `true` at once - if
            // so, refuse to auto-start the (would-be unauthenticated) LAN
            // server rather than trust a state the app itself would never
            // have written, and leave the inconsistency for the user to
            // resolve from the settings screen (this does NOT rewrite either
            // setting).
            let server_config = tauri::async_runtime::block_on(settings.server_config())
                .expect("server_config should succeed");
            let inconsistent_auth_and_server = auth_config.disabled && server_config.enabled;
            if inconsistent_auth_and_server {
                eprintln!(
                    "banto: 認証無効モードとLANアクセスが同時に有効な不整合な設定を検出したため、LANサーバーの自動起動をスキップしました。設定画面でどちらかを無効にしてください。"
                );
            }
            let initial_server = if server_config.enabled && !inconsistent_auth_and_server {
                let runtime_config = ServerConfig {
                    bind: server_config.bind.clone(),
                    port: server_config.port,
                };
                match tauri::async_runtime::block_on(start_embedded_server(
                    items.clone(),
                    users.clone(),
                    settings.clone(),
                    audit.clone(),
                    rest_auth.clone(),
                    events.clone(),
                    runtime_config,
                )) {
                    Ok(server) => Some(server),
                    Err(err) => {
                        // Non-fatal: the desktop app itself works fine with
                        // no LAN access; surface the failure (e.g. the
                        // persisted port now being in use) to the log only.
                        // The settings screen's `server_status` will report
                        // `running: false` and the user can pick a different
                        // port via `server_apply`.
                        eprintln!("banto: 起動時のLANアクセス開始に失敗しました: {err}");
                        None
                    }
                }
            } else {
                None
            };

            // M12: re-apply the persisted vibrancy (Windows Acrylic) choice
            // on launch. Best-effort by design - a failure (old Windows 10
            // build, missing window) must never block startup, so it is
            // logged and otherwise ignored; the settings screen's
            // `vibrancy_status`/`vibrancy_apply` remain the way to
            // observe/repair the state.
            #[cfg(target_os = "windows")]
            {
                let vibrancy_enabled = tauri::async_runtime::block_on(
                    settings.get(KEY_DESKTOP_VIBRANCY),
                )
                .unwrap_or_else(|err| {
                    eprintln!("banto: vibrancy設定の読み取りに失敗しました: {err}");
                    None
                })
                .map(|value| value == "true")
                .unwrap_or(false);
                if vibrancy_enabled {
                    match app.get_webview_window("main") {
                        Some(window) => {
                            if let Err(err) = set_window_vibrancy(&window, true) {
                                eprintln!(
                                    "banto: 起動時のウィンドウAcrylic効果の適用に失敗しました: {err}"
                                );
                            }
                        }
                        None => eprintln!(
                            "banto: メインウィンドウが見つからないため、起動時のAcrylic効果の適用をスキップしました"
                        ),
                    }
                }
            }

            app.manage(AppState {
                items,
                auth: Mutex::new(initial_auth),
                users,
                settings,
                events,
                rest_auth,
                server: AsyncMutex::new(initial_server),
                audit,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            items_list,
            items_get,
            items_create,
            items_update,
            items_delete,
            auth_status,
            auth_setup,
            auth_login,
            auth_logout,
            auth_check,
            auth_identity,
            auth_change_password,
            auth_config_get,
            auth_config_apply,
            autologin_enable,
            autologin_disable,
            server_status,
            server_apply,
            settings_get,
            settings_set,
            ui_settings_get,
            ui_settings_set,
            vibrancy_apply,
            vibrancy_status,
            users_list,
            users_create,
            users_update,
            users_reset_password,
            users_delete,
            audit_log_list,
            panel_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal [`AppState`] over an in-memory DB, no running server, and a
    /// dummy REST verifier - just enough state to exercise command bodies
    /// (like [`change_own_password`]) that only touch the service handles.
    async fn app_state() -> AppState {
        let pool = admin_template_core::db::init_db_memory()
            .await
            .expect("init_db_memory");
        let events = event_channel();
        AppState {
            items: ItemsService::new(pool.clone()).with_events(events.clone()),
            auth: Mutex::new(None),
            users: UsersService::new(pool.clone()),
            settings: SettingsService::new(pool.clone()),
            events,
            rest_auth: AuthState::new(|_u: String, _p: String| {
                Box::pin(async { None::<banto_server::Identity> })
            }),
            server: AsyncMutex::new(None),
            audit: AuditLogService::new(pool),
        }
    }

    /// Spec M14: the Tauri-side self-service password change must be
    /// recorded as `password_change` (actor = entity = the caller), and the
    /// entry's `detail` must never carry the password.
    #[tokio::test]
    async fn change_own_password_is_recorded_as_password_change() {
        let state = app_state().await;
        let owner = state
            .users
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .expect("setup_first_user");
        let owner_id = owner.id;
        *state.auth.lock().expect("auth mutex poisoned") = Some(owner);

        change_own_password(&state, "password123", "newpassword1")
            .await
            .expect("change_own_password should succeed");

        let result = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let entry = result
            .rows
            .iter()
            .find(|r| r.action == "password_change")
            .unwrap_or_else(|| panic!("expected a password_change entry, got {:?}", result.rows));
        assert_eq!(entry.actor_username.as_deref(), Some("owner"));
        assert_eq!(entry.actor_role.as_deref(), Some("admin"));
        assert_eq!(entry.resource, "users");
        assert_eq!(entry.entity_id.as_deref(), Some(owner_id.to_string().as_str()));
        assert_eq!(entry.origin, "tauri");
        assert_eq!(entry.result, "ok");
        assert_eq!(entry.detail, None, "detail must never carry the password");
    }

    /// A FAILED password change (wrong current password) must record
    /// nothing - only the success path is a completed security event.
    #[tokio::test]
    async fn failed_change_own_password_records_nothing() {
        let state = app_state().await;
        let owner = state
            .users
            .setup_first_user("owner", "password123", "オーナー")
            .await
            .expect("setup_first_user");
        *state.auth.lock().expect("auth mutex poisoned") = Some(owner);

        change_own_password(&state, "not-the-password", "newpassword1")
            .await
            .expect_err("wrong current password should fail");

        let result = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        assert!(
            result.rows.iter().all(|r| r.action != "password_change"),
            "a failed change must not be recorded as password_change: {:?}",
            result.rows
        );
    }
}
