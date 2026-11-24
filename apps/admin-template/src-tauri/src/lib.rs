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

mod elevated_launch;
mod firewall_change;
mod firewall_status;
mod keyring_store;
mod leftover_writes;

use admin_template_core::assets::FrontendAssets;
use admin_template_core::attachment_wiring::{attachment_audit_detail, sweep_item_attachments};
use admin_template_core::audit::{
    ActorSession, AuditActor, AuditLogList, AuditLogService, ACTOR_KIND_ACCOUNT, ACTOR_KIND_LOCAL,
};
use admin_template_core::backup::{BackupInfo, BackupService, PendingRestoreInfo};
use admin_template_core::db::init_db;
use admin_template_core::events::event_channel;
use admin_template_core::first_boot::seed_first_boot_settings;
// [scaffold:items] begin
use admin_template_core::items::{ImportResult, Item, ItemImportRow, ItemInput, ItemsService};
// [scaffold:items] end
use admin_template_core::resources::AppResources;
use admin_template_core::rest::{api_router, resources_router, user_auth_state, Services};
use admin_template_core::settings::{
    auth_server_combination_allowed, AuditSettings, AuthSettings, ServerSettings, SettingsService,
};
use admin_template_core::system_info::SystemInfoService;
#[cfg(feature = "system-metrics")]
use admin_template_core::system_metrics::SystemMetricsSampler;
use admin_template_core::ui_settings::{UiSetting, UiSettingRevision, UiSettingsOwner};
use admin_template_core::users::{
    PermissionDiff, PermissionEntry, PermissionKey, Role, SessionPermissions, UserIdentity,
    UserIdentityView, UsersService,
};
use banto_attachments::{AttachmentMeta, AttachmentsService, NewAttachment};
use banto_core::{BantoError, FieldError, ListParams, ListResult};
use banto_server::routes::{
    list_users_with_permissions, permission_catalog_entries, record_as, record_denied_as,
    record_login_failed_as, record_write_as, MetricsProbe, SystemInfo, UserWithPermissions,
};
use banto_server::{
    bind as bind_listener, bind_with_port_fallback, bind_without_fallback, lan_addrs_for_bind,
    lan_urls_for_bind, reach_check_router, restoring_previous_stays_within, static_router,
    with_security_headers, AuthMode, AuthState, BoundServer, GrantKind, PortFallbackError,
    ReachCheckState, ReachCheckStatus, ReachIssue, ReachIssueError, ReachTarget, RunningServer,
    ServerConfig, ServerEvent, ServerExposure, WriteBudget,
};
use leftover_writes::LeftoverWrites;
use qrcode::render::svg;
use qrcode::QrCode;
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tokio::sync::{broadcast, Mutex as AsyncMutex};

/// App-wide state managed by Tauri (spec §10, §11).
struct AppState {
    /// A firewall change (UAC and the helper) is running in this process;
    /// overlapping requests answer `busy` ([`firewall_change::RunningGuard`],
    /// ADR-0021 decision 13). Separate from `server`, whose lock is not held
    /// while UAC waits.
    firewall_change_running: std::sync::atomic::AtomicBool,
    // [scaffold:items] begin
    items: ItemsService,
    // [scaffold:items] end
    /// The services of the resources added by `pnpm banto add resource`
    /// (`admin_template_core::resources`, empty in the template). The
    /// generated commands read `state.resources.<name>`; the embedded server
    /// gets a clone for `resources_router`.
    resources: AppResources,
    /// The webview window's own session identity, set by `auth_login`
    /// and cleared by `auth_logout` - all called directly via
    /// `invoke()`, never through `/api/auth/login`. `Some` means logged in;
    /// carrying the full `UserIdentity` (not just a bool) lets
    /// `auth_change_password` recover the current `username` without a
    /// second round trip. Issue #204: a [`DesktopSession`], so every place
    /// that establishes a session states which kind it is, and every read
    /// goes through [`current_session`].
    ///
    /// Issue #260 (docs/design/session-controller-design.md §5.3, I-11): wrapped in
    /// an [`AuthSlot`] with a write sequence, so a command that `.await`s
    /// between reading the slot and writing it (login's argon2 verify,
    /// logout's settings read) only writes when nothing re-bound the slot
    /// meanwhile ([`cas_session`]).
    auth: Mutex<AuthSlot>,
    /// The two slow `.await`s the session-changing commands make before
    /// they write [`AppState::auth`] (credential verification and the
    /// auth-mode read), injected so tests can hold a command
    /// at that point and fix the completion order (design §8.3). Production
    /// wraps `users`/`settings` below ([`AuthIo::production`]).
    auth_io: AuthIo,
    /// Serializes "read the auth-mode settings, decide, act on the decision"
    /// (PR #264 re-review P2): [`auth_config_apply_with_permissions_body`] holds it from its
    /// first settings read through the save and the synthetic-session
    /// install, [`logout_body`] holds it around its post-clear re-read and
    /// install, and the autologin toggles hold it around their
    /// read-modify-write of the same settings row. So the settings value an
    /// install was based on cannot be changed by another apply between the
    /// read and the install (an `apply(false)` completing while an
    /// `apply(true)` was still awaiting would otherwise let the latter
    /// install a local session under `disabled = false`).
    ///
    /// LOCK ORDER: `auth_config_lock` -> [`AppState::auth`]. `auth` is a
    /// std `Mutex` that is never held across an `.await`, so nothing can
    /// hold it while waiting for this lock - the reverse order cannot occur.
    ///
    /// LOCK ORDER (server side, #294 review): [`AppState::server`] ->
    /// `auth_config_lock`. `server_apply` saves the `server.*` settings (and
    /// revokes public viewer tokens) under this lock so it is serialized with
    /// the `auth.*` writers (the forbidden auth-disabled / LAN / not
    /// viewer-public combination cannot arise from a race). Auth-side code
    /// must never take `state.server`; if it ever has to, it must take it
    /// BEFORE this lock.
    auth_config_lock: AsyncMutex<()>,
    /// The id of the built-in `admin` row (ADR-0034 §3), read once at startup
    /// by `kind = 'builtin'` (`admin_template_core::startup::check`): the
    /// `actor_id` of what the no-login session does ([`session_actor`]). A
    /// restore swaps the database only across a restart, so it cannot go
    /// stale.
    builtin_admin_id: i64,
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
    /// The embedded LAN server's live state ([`ServerSlot`]): the running
    /// listener (if any), its generation, and what the last launch / apply
    /// reported. One lock for all of it, so `server_status` reads a
    /// consistent snapshot and `server_apply` replaces it as a whole
    /// (Issue #459).
    server: AsyncMutex<ServerSlot>,
    /// The LAN reach check's one-time-token store (Issue #219 stage 1,
    /// `docs/design/lan-reach-check-design.md`). One per process, shared by
    /// every listener's `POST /api/reach-check` router; memory only. Its
    /// generation follows [`ServerSlot::generation`] (starts at 0 like it):
    /// `server_apply` calls `begin_generation` with the bumped value under
    /// the `server` lock (lan-reach-check-design §3.5), and
    /// `reach_check_issue` issues under the same lock, so an issuance can
    /// never slip in after the revocation.
    reach_check: ReachCheckState,
    /// Audit trail (spec M14): every mutating command below records a
    /// `create`/`update`/`delete`/`password_reset`/`settings_change`/
    /// `login`/`login_failed`/`logout` entry here (`origin:
    /// "tauri"`) once it has already succeeded, and [`require_role`] records
    /// `denied` when an active session's role is too low. The successful,
    /// actor-attributed writes go through the [`record_ok`] helper (the
    /// desktop counterpart to REST's `record_write`, conventions §1); the few
    /// whose shape differs (import's `ok`/`failed`, `login_failed`, the
    /// escape-hatch config write, the startup `restore_applied`) build their
    /// entry by hand. Shares the same pool as `items`/`users`/`settings` (all
    /// four are `Clone` handles onto the one on-disk SQLite DB, see `run()`'s
    /// `setup()`).
    audit: AuditLogService,
    /// Backup/restore (spec M17): `VACUUM INTO` snapshots into `backups/`
    /// next to the DB file, plus the restore staging flow. Shares the same
    /// pool as `items`/`users`/`settings`/`audit` - only its `db_path` is
    /// unique to this service (needed to resolve `backups/` and
    /// `restore-pending.sqlite3`'s location, see `crate::backup`'s doc
    /// comment).
    backup: BackupService,
    /// File/image attachments (spec `docs/design/attachments-plan.md` §3, M20 unit
    /// B): `banto_attachments::AttachmentsService` has no `tauri`/
    /// `ServerEvent` awareness by design (see that crate's module doc
    /// comment), so - unlike `items`, which broadcasts its own
    /// `ResourceChanged` internally - the `attachments_upload`/
    /// `attachments_delete` commands below broadcast on `events` themselves,
    /// mirroring `admin_template_core::rest`'s attachments handlers.
    attachments: AttachmentsService,
    /// `attachments/` directory the above service was constructed with
    /// (attachments-plan §3.3: `db_path.parent().join("attachments")`) - kept alongside
    /// it purely for [`attachments_open_folder`], since
    /// `AttachmentsService` (unlike `BackupService::backups_dir_display`)
    /// exposes no accessor for its own `base_dir`.
    attachments_dir: PathBuf,
    /// `exports/` directory (sibling of `attachments/`/`backups/` under the
    /// app's data dir) - the desktop counterpart of the LAN browser's
    /// `<a download>` CSV export (finding⑤ Option A): `items_export_csv_to_folder`
    /// writes the exported file here and reveals it in the OS file explorer,
    /// same "no native save dialog in v1" fallback as
    /// `backups_open_folder`/`attachments_open_folder`.
    exports_dir: PathBuf,
    /// System diagnostics probe (M-review 2026-08 §2.4), backing the admin
    /// `system_info` command and its symmetric `GET /api/system/info` route.
    /// DB-only (dialect/latency/migration version/attachment size); the
    /// command folds in `app_version`/`uptime_secs`/`active_sessions`.
    system_info: SystemInfoService,
    /// CPU/memory probe (ADR-0013, Issue #185): `Some` when the
    /// `system-metrics` feature is on and the host platform is supported;
    /// `None` otherwise, in which case the `system_info` command reports
    /// `metrics: null` (same degrade path as the REST route). Built in
    /// `setup()` under `#[cfg(feature = "system-metrics")]`, and re-shared
    /// with the embedded server in [`start_embedded_server`] (cloning an
    /// `Arc` closure, not re-sampling).
    metrics: Option<MetricsProbe>,
    /// Process start, for the `system_info` command's `uptime_secs` (app
    /// uptime on the desktop path; captured first thing in `setup()`).
    started_at: std::time::Instant,
}

/// Result of `auth_login`. `superseded`/`seq` (Issue #260,
/// design §5.3/I-19): `superseded` is `true` when the credentials were
/// valid but another command re-bound the session slot while this one was
/// verifying, so the session was NOT installed ([`cas_session`]); `seq` is
/// the slot's write sequence after this command, so the frontend provider
/// can tell whether the session changed without a second round trip.
#[derive(Debug, Clone, Serialize)]
struct LoginResult {
    success: bool,
    error: Option<String>,
    superseded: bool,
    seq: u64,
}

/// Result of `auth_logout` (Issue #260): the slot's write sequence after the
/// command - unchanged when it did nothing (auth-disabled mode, or another
/// command re-bound the slot while the logout was reading settings).
#[derive(Debug, Clone, Serialize)]
struct LogoutResult {
    seq: u64,
}

/// Result of `auth_change_password` (Issue #260): the slot's write sequence
/// after the command - advanced when the session was re-bound to the new
/// `auth_epoch`.
#[derive(Debug, Clone, Serialize)]
struct ChangePasswordResult {
    seq: u64,
}

/// Result of `auth_resolve` (Issue #260, design §5.3): the whole session in
/// one round trip, tagged with which slot write it is about.
///
/// - `checked`: the slot's `seq` read before the first `.await` (the session
///   this answer validated);
/// - `current`: the `seq` after this call's own settle - `checked + 1` iff
///   this call cleared a revoked session, otherwise `checked`;
/// - `stale`: another command re-bound the slot while this call was reading
///   the store, so nothing was written and the answer is about nothing
///   current (the frontend provider rejects it and asks again).
#[derive(Debug, Clone, Serialize)]
struct AuthResolveResult {
    identity: Option<Identity>,
    /// `"account"` or `"local"` (auth-disabled mode's synthetic session);
    /// `None` when there is no session.
    kind: Option<&'static str>,
    checked: u64,
    current: u64,
    stale: bool,
}

/// The webview session slot (Issue #260, design §5.3, I-11).
///
/// `seq` advances on every write that is MEANT to change the binding -
/// login/config-apply installing a session, logout/settle clearing
/// one, `change_own_password` re-binding one - even when the value does not
/// change (a logout of `None` still advances it, so a login that started
/// before it can no longer install). It does NOT advance on a refresh of the
/// same binding (`settle_session` updating role/display name), nor on the
/// auth-disabled-mode logout no-op.
#[derive(Debug, Default)]
struct AuthSlot {
    session: Option<DesktopSession>,
    seq: u64,
}

impl AuthSlot {
    fn new(session: Option<DesktopSession>) -> Self {
        Self { session, seq: 0 }
    }
}

type AuthFuture<T> = futures_util::future::BoxFuture<'static, Result<T, BantoError>>;
/// `auth_login`'s credential check (design §8.3 `CredentialVerifier`).
type CredentialVerifier =
    Arc<dyn Fn(String, String) -> AuthFuture<Option<UserIdentity>> + Send + Sync>;
/// `auth_logout`'s auth-mode read (design §8.3 `AuthModeSource`).
type AuthModeSource = Arc<dyn Fn() -> AuthFuture<AuthSettings> + Send + Sync>;
/// `auth_config_apply`'s settings save. Not in design §8.3's sketch: injected
/// so a test can hold an apply right AFTER it saved (PR #264 re-review P2).
///
/// Takes the mode's permissions too (`None` = leave them): the mode, role and
/// permissions are written in ONE transaction (PR #703 review), so a failed
/// save changes none of them.
type AuthConfigSave =
    Arc<dyn Fn(AuthSettings, Option<Vec<PermissionKey>>) -> AuthFuture<()> + Send + Sync>;

/// A session's per-user permissions read ([`permissions_of_session`]).
/// Injected so a test can hold a command between its session check and the
/// end of its permissions read (ADR-0034 §6, cross-review of PR #862).
/// Handed the state's CURRENT services on every call (not captured ones).
type PermissionsSource = Arc<
    dyn Fn(UsersService, SettingsService, DesktopSession) -> AuthFuture<SessionPermissions>
        + Send
        + Sync,
>;

/// See [`AppState::auth_io`].
struct AuthIo {
    verify: CredentialVerifier,
    auth_mode: AuthModeSource,
    save_auth_config: AuthConfigSave,
    permissions: PermissionsSource,
}

impl AuthIo {
    fn production(users: &UsersService, settings: &SettingsService) -> Self {
        let verify_users = users.clone();
        let save_settings = settings.clone();
        let settings = settings.clone();
        Self {
            permissions: Arc::new(|users, settings, session| {
                Box::pin(async move { read_session_permissions(&users, &settings, &session).await })
            }),
            verify: Arc::new(move |username, password| {
                let users = verify_users.clone();
                Box::pin(async move { users.verify(&username, &password).await })
            }),
            auth_mode: Arc::new(move || {
                let settings = settings.clone();
                Box::pin(async move { settings.auth_config().await })
            }),
            save_auth_config: Arc::new(move |config, permissions| {
                let settings = save_settings.clone();
                Box::pin(async move {
                    settings
                        .set_auth_config_and_disabled_permissions(&config, permissions.as_deref())
                        .await
                })
            }),
        }
    }
}

/// Read the slot's `seq` (and session) under one lock. Session-changing
/// commands call this BEFORE their first `.await` (I-11).
fn read_slot(state: &AppState) -> (Option<DesktopSession>, u64) {
    let slot = state.auth.lock().expect("auth mutex poisoned");
    (slot.session.clone(), slot.seq)
}

/// Compare-and-set the session slot (design §5.3, I-7/I-11): under one lock,
/// write `next` and advance `seq` only when `seq` is still `expected_seq`.
/// Advances even when `next` equals the current value. Returns whether it
/// wrote, and the `seq` after the call.
fn cas_session(state: &AppState, expected_seq: u64, next: Option<DesktopSession>) -> (bool, u64) {
    let mut slot = state.auth.lock().expect("auth mutex poisoned");
    if slot.seq != expected_seq {
        return (false, slot.seq);
    }
    slot.session = next;
    slot.seq += 1;
    (true, slot.seq)
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
    /// Issue #697: the session's per-user permissions (registered keys
    /// only, sorted) - the same field as REST's `GET /api/auth/identity`.
    /// For the screen only; commands decide with [`require_permission`].
    permissions: SessionPermissions,
    /// ADR-0034 §1 / Issue #790: the account's never-reused
    /// `users.account_uid` - the same field as REST's
    /// `GET /api/auth/identity` (`banto_server::Identity::account_id`). The
    /// screen keys per-owner saved state on it (`acct:<accountId>`). Left out
    /// for the auth-disabled `local` session, which has no account behind it
    /// (its owner key is `local`).
    #[serde(rename = "accountId", skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatusResult {
    /// Always `false` in the Tauri window (Issue #189,
    /// `docs/design/viewer-public-plan.md` §3.1-4, ADR-0012). 閲覧公開 is a property
    /// of the LAN surface: it lets a BROWSER on the network obtain a
    /// synthetic `viewer` session over REST. Inside the desktop webview there
    /// is no such thing to enter - a login-free desktop is M11's
    /// auth-disabled mode (`auth_config_get`), whose synthetic session is
    /// already established before the frontend asks for `status`. Reported as
    /// a constant rather than omitted so the field's shape matches
    /// `GET /api/auth/status` and the frontend's `status()` never has to
    /// branch on which host it is running under.
    viewer_public: bool,
}

fn identity_from(user: &UserIdentity, permissions: SessionPermissions) -> Identity {
    // Convention shared with `admin_template_core::rest` and `banto-serve`:
    // `Identity.id` is the account's `username` (not `UserIdentity.id`'s
    // numeric row id), so any layer holding only an `Identity` can still
    // recover "which account" for things like `change_password`.
    Identity {
        id: user.username.clone(),
        name: user.display_name.clone(),
        role: user.role.to_string(),
        permissions,
        account_id: user.account_uid.clone(),
    }
}

/// The wire [`Identity`] of `session` with its per-user permissions read
/// now ([`permissions_of_session`]).
async fn identity_of(state: &AppState, session: &DesktopSession) -> Result<Identity, BantoError> {
    let permissions = permissions_of_session(state, session).await?;
    Ok(identity_from(session.identity(), permissions))
}

/// The per-user permissions `session` holds right now (Issue #697,
/// user-permissions-plan §5) - read from the store on every call, the Tauri
/// twin of what REST's `require_auth` reads per request:
///
/// - [`DesktopSession::Account`]: the account's stored permissions that the
///   catalog registers (`UsersService::session_permissions`, which reads
///   `UsersService::permissions_of`). They are not cached on the session, so
///   a grant or a revocation takes effect on the next command without
///   ending the session (no `auth_epoch` change).
/// - [`DesktopSession::AuthDisabledLocal`]: the mode's
///   `auth.disabled_permissions` (`SettingsService::auth_disabled_permissions`,
///   none by default) that the catalog registers.
async fn permissions_of_session(
    state: &AppState,
    session: &DesktopSession,
) -> Result<SessionPermissions, BantoError> {
    (state.auth_io.permissions)(state.users.clone(), state.settings.clone(), session.clone()).await
}

/// The production read behind [`permissions_of_session`]
/// ([`AuthIo::production`]).
async fn read_session_permissions(
    users: &UsersService,
    settings: &SettingsService,
    session: &DesktopSession,
) -> Result<SessionPermissions, BantoError> {
    match session {
        DesktopSession::Account(identity) => users.session_permissions(identity.id).await,
        DesktopSession::AuthDisabledLocal(_) => {
            let catalog = users.permission_catalog();
            if catalog.is_empty() {
                return Ok(SessionPermissions::none());
            }
            let stored = settings.auth_disabled_permissions().await?;
            Ok(SessionPermissions::new(catalog.effective(&stored)))
        }
    }
}

/// The current session AND the permissions it holds, as ONE authorization
/// (ADR-0034 §6; the Tauri twin of
/// `banto_server::AuthState::authenticate_with_permissions`).
///
/// [`current_session_at`] settles the session against the slot and hands
/// back the slot's `seq` AS OF THAT SETTLE, read under the settle's own lock
/// (never read afterwards: commands run on several threads, so an
/// `auth_config_apply` or a logout can re-bind the slot between the settle's
/// unlock and any later read, and an old session paired with the new `seq`
/// would pass the comparison below - Codex review of PR #862). Reading the
/// permissions awaits once more, and the same writers can complete in that
/// window. So that `seq` is compared again after the permissions were read:
/// every write that changes what the session is authorized as advances `seq`
/// (see [`settle_session`]), so an unchanged `seq` means the pair still
/// describes the slot.
///
/// If it moved, the answer is "no session" (`Ok(None)`), and the caller's
/// command fails `Unauthorized`. It is deliberately NOT decided again from
/// the slot as it is now (cross-review of PR #862): the slot may hold a
/// different subject by then, and a command that had not passed its guard
/// yet would run - and be audited - as a subject it was never sent by. The
/// client sends a new request. The first settle is held to the same rule
/// ([`OnStale::Refuse`]): a slot re-bound during the store read is "no
/// session" for a guard even when the slot's session has the same binding
/// again (the same account signed in anew, the mode turned off and on) - it
/// is a new session, not the one this command was sent in.
///
/// The guards go through here: [`require_permission`] and
/// [`session_permissions`]. What the screen shows is
/// [`displayed_session`]; `auth_resolve` reports the same window as `stale`
/// ([`resolve_body`]).
async fn authorized_session(
    state: &AppState,
) -> Result<Option<(DesktopSession, SessionPermissions)>, BantoError> {
    let Some((session, settled_seq)) = current_session_at(state, OnStale::Refuse).await? else {
        return Ok(None);
    };
    let permissions = permissions_of_session(state, &session).await?;
    if read_slot(state).1 != settled_seq {
        return Ok(None);
    }
    Ok(Some((session, permissions)))
}

/// The session and its permissions for DISPLAY (`auth_identity`): the same
/// one-snapshot rule as [`authorized_session`], but a slot re-bound during
/// the permissions read is simply read once more, so the screen is told
/// about the session the slot holds now rather than about none. Nothing is
/// authorized by this answer - never use it for a guard.
async fn displayed_session(
    state: &AppState,
) -> Result<Option<(DesktopSession, SessionPermissions)>, BantoError> {
    for _ in 0..2 {
        let Some((session, settled_seq)) = current_session_at(state, OnStale::Adopt).await? else {
            return Ok(None);
        };
        let permissions = permissions_of_session(state, &session).await?;
        if read_slot(state).1 == settled_seq {
            return Ok(Some((session, permissions)));
        }
    }
    Ok(None)
}

/// The current session ([`current_session`], re-validated) and the
/// per-user permissions it holds now (Issue #697, user-permissions-plan §5:
/// the Tauri read function for decisions finer than a command, e.g. per
/// equipment - REST's `Extension<SessionPermissions>`). `Ok(None)` = no
/// session.
#[allow(dead_code)] // The template registers no permission; derived apps call it.
async fn session_permissions(
    state: &AppState,
) -> Result<Option<(UserIdentity, SessionPermissions)>, BantoError> {
    Ok(authorized_session(state)
        .await?
        .map(|(session, permissions)| (session.identity().clone(), permissions)))
}

/// `UserIdentity.id` shown for the synthetic auth-disabled-mode ("local")
/// session (spec M11). Display only: whether a session is synthetic is the
/// [`DesktopSession`] variant, never this value (a `users` row could in
/// principle be inserted with id 0).
const LOCAL_SESSION_ID: i64 = 0;

/// The webview session (Issue #204). An enum rather than a bare
/// `UserIdentity` so there is no way to establish or read a session without
/// saying whether it belongs to a `users` account - and therefore how
/// [`current_session`] re-validates it.
#[derive(Debug, Clone, PartialEq)]
enum DesktopSession {
    /// A `users` account (`auth_login`, autologin): bound to
    /// the row's `id` + `auth_epoch` it was established with and
    /// re-validated against that row on every command.
    Account(UserIdentity),
    /// The synthetic identity of auth-disabled mode (spec M11). There is no
    /// account behind it; it is valid exactly while auth-disabled mode is ON,
    /// with that mode's CURRENT role - re-checked on every command too.
    AuthDisabledLocal(UserIdentity),
}

impl DesktopSession {
    fn identity(&self) -> &UserIdentity {
        match self {
            Self::Account(identity) | Self::AuthDisabledLocal(identity) => identity,
        }
    }
}

/// The webview session, re-validated on every command (Issue #204, the Tauri
/// twin of `banto_server::AuthState::authenticate`):
///
/// - no session -> `Ok(None)`;
/// - [`DesktopSession::Account`]: the `users` row is re-read. Account gone,
///   or a different row id (deleted and re-created under the same username)
///   or `auth_epoch` (role change, password change/reset - from EITHER
///   transport) than the session was established with -> the session is
///   cleared and `Ok(None)`; otherwise the account's CURRENT row (role
///   included), which is also written back to the cached session;
/// - [`DesktopSession::AuthDisabledLocal`]: auth-disabled mode is re-read.
///   Turned off -> cleared and `Ok(None)` (the login screen takes over);
///   otherwise the synthetic identity with the mode's CURRENT role.
///
/// A read failure is `Err` and leaves the session in place (a DB hiccup must
/// not log the user out), failing the command instead. The decision after
/// the read is [`settle_session`] (the session may have changed while the
/// read was in flight). The lock is never held across an `.await`.
///
/// Issue #260: when the slot was re-bound while the read was in flight
/// ([`Settled::Stale`]), nothing is written and this command decides on the
/// CURRENT session's binding (valid iff `fresh` reports exactly it) - the
/// same answer the pre-#260 `settle_session` gave in that case, so ordinary
/// commands keep their behavior; only `auth_resolve` reports the staleness.
async fn current_session(state: &AppState) -> Result<Option<DesktopSession>, BantoError> {
    Ok(current_session_at(state, OnStale::Adopt)
        .await?
        .map(|(session, _)| session))
}

/// What a check does when the slot was re-bound while its store read was in
/// flight ([`Settled::Stale`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OnStale {
    /// Take the slot's CURRENT session when its binding is what the read
    /// reports (the pre-#260 answer the ordinary commands keep, and what the
    /// screen is shown).
    Adopt,
    /// "No session": the permission guards ([`authorized_session`]). The
    /// slot's session was established after this command started, so the
    /// command is not authorized as it (cross-review of PR #862).
    Refuse,
}

/// [`settle_session`]'s outcome as the session a check goes on with and the
/// slot's `seq` that session was read at (one lock, one snapshot).
fn settled_pair(settled: Settled, on_stale: OnStale) -> Option<(DesktopSession, u64)> {
    match settled {
        Settled::Settled {
            session, seq_after, ..
        } => session.map(|session| (session, seq_after)),
        Settled::Stale { valid_now, seq_now } => match on_stale {
            OnStale::Adopt => valid_now.map(|session| (session, seq_now)),
            OnStale::Refuse => None,
        },
    }
}

/// [`current_session`] together with the slot's `seq` the answer is about:
/// both come from [`settle_session`]'s ONE lock, so the pair is a consistent
/// snapshot of the slot (the session IS what the slot held at that `seq`).
/// A caller that awaits afterwards compares this `seq` with the slot's to
/// learn whether its session is still the slot's ([`authorized_session`]).
async fn current_session_at(
    state: &AppState,
    on_stale: OnStale,
) -> Result<Option<(DesktopSession, u64)>, BantoError> {
    let (cached, seq_at_entry) = read_slot(state);
    let Some(cached) = cached else {
        return Ok(None);
    };
    let fresh = read_session_source(state, &cached).await?;
    Ok(settled_pair(
        settle_session(state, &cached, fresh, seq_at_entry),
        on_stale,
    ))
}

/// What the store says NOW about the session `cached` stands for: the
/// `users` row for an account session, or - for the synthetic session - the
/// synthetic identity with the mode's current role while auth-disabled mode
/// is on (`None` once it is off).
async fn read_session_source(
    state: &AppState,
    cached: &DesktopSession,
) -> Result<Option<DesktopSession>, BantoError> {
    Ok(match cached {
        DesktopSession::Account(session) => state
            .users
            .get_by_username(&session.username)
            .await?
            .map(DesktopSession::Account),
        DesktopSession::AuthDisabledLocal(session) => {
            let config = state.settings.auth_config().await?;
            config.disabled.then(|| {
                DesktopSession::AuthDisabledLocal(UserIdentity {
                    role: config.disabled_role,
                    ..session.clone()
                })
            })
        }
    })
}

/// Do `a` and `b` carry the same session binding: the same kind and, for an
/// account, the same row id and `auth_epoch`?
fn same_binding(a: &DesktopSession, b: &DesktopSession) -> bool {
    match (a, b) {
        (DesktopSession::Account(a), DesktopSession::Account(b)) => {
            a.id == b.id && a.auth_epoch == b.auth_epoch
        }
        (DesktopSession::AuthDisabledLocal(_), DesktopSession::AuthDisabledLocal(_)) => true,
        _ => false,
    }
}

/// Outcome of [`settle_session`] (Issue #260, design §5.3).
#[derive(Debug)]
enum Settled {
    /// The slot's `seq` moved since `seq_at_entry` (another command
    /// installed, cleared or re-bound the session while the store was being
    /// read). Nothing was written. `valid_now` is the CURRENT session (the
    /// slot's value, newer than `fresh`) if its own binding is exactly what
    /// `fresh` reports (e.g. a re-bind by `change_own_password` that `fresh`
    /// already reflects), for the
    /// ordinary commands' [`current_session`]; `auth_resolve` reports
    /// `stale` instead of using it.
    ///
    /// `seq_now` is the slot's `seq` under the same lock `valid_now` was read
    /// with (the pair is one snapshot of the slot).
    Stale {
        valid_now: Option<DesktopSession>,
        seq_now: u64,
    },
    /// The slot was not re-bound meanwhile, and was settled from `fresh`.
    /// `seq_after == seq_before + 1` iff this call cleared the session.
    Settled {
        session: Option<DesktopSession>,
        seq_before: u64,
        seq_after: u64,
    },
}

/// Decide on `fresh` (read with no lock held) against the session as it is
/// NOW, under one lock:
///
/// - if the slot's `seq` is no longer `seq_at_entry` (read together with
///   `cached`, before the store read), the session was re-bound meanwhile:
///   write nothing and return [`Settled::Stale`] (Issue #260, I-11/I-23);
/// - otherwise the slot still holds `cached`'s binding (only same-binding
///   refreshes, which do not move `seq`, can have happened). Valid iff that
///   binding is exactly what `fresh` reports: refreshed to `fresh` (current
///   role and name) WITHOUT advancing `seq`. Not valid (account gone,
///   re-keyed, `auth_epoch` advanced - role change included - or
///   auth-disabled mode turned off): cleared, advancing `seq`.
///
/// This never moves a session to the store's newest epoch on its behalf: a
/// session that was not itself re-bound still ends.
///
/// Why a refresh never writes an old answer back over a newer write: every
/// write to the slot that changes what the session is authorized as advances
/// `seq` - a (re-)bind, a clear, and (re-review of #266 P1, S-96) a role
/// change of the synthetic session by [`rebind_local_session`]. So an
/// unchanged `seq` means nothing was written since `cached`/`fresh` were
/// read, and `fresh` is at least as new as the slot. (An account's role
/// change advances its `auth_epoch`, so `fresh` is not the same binding and
/// the session is cleared instead.) The one thing a refresh can still put
/// back is an account's `display_name` (freshness audit of #266, P3-1): two
/// concurrent refreshes of the same binding do not move `seq`, so the one
/// that read the store first may write last. That is accepted: the name is
/// display only (authorization reads role/epoch, which a refresh cannot
/// rewind), and the next check refreshes it again; there is no version on
/// the name to compare.
fn settle_session(
    state: &AppState,
    cached: &DesktopSession,
    fresh: Option<DesktopSession>,
    seq_at_entry: u64,
) -> Settled {
    let mut slot = state.auth.lock().expect("auth mutex poisoned");
    let valid = match slot.session.as_ref() {
        Some(now) => fresh.filter(|fresh| same_binding(now, fresh)),
        None => None,
    };
    if slot.seq != seq_at_entry {
        // The slot was written after `fresh` was read, so the slot's own
        // value is the newer one: report IT (not `fresh`) when the binding
        // matches - e.g. a Local role changed by an apply after this read
        // (freshness audit of #266, P3-2, S-102).
        let valid_now = valid.and(slot.session.clone());
        return Settled::Stale {
            valid_now,
            seq_now: slot.seq,
        };
    }
    debug_assert!(slot
        .session
        .as_ref()
        .is_some_and(|now| same_binding(now, cached)));
    let seq_before = slot.seq;
    if valid.is_some() {
        slot.session = valid.clone();
    } else {
        slot.session = None;
        slot.seq += 1;
    }
    Settled::Settled {
        session: valid,
        seq_before,
        seq_after: slot.seq,
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
///
/// Issue #204: the session is re-validated against the `users` table first
/// ([`current_session`]) - the role checked (and the identity returned) is
/// the account's CURRENT one, and a deleted/re-keyed account's session is
/// ended (`Unauthorized`), exactly like REST's `require_auth` +
/// `RoleGuard`.
///
/// ADR-0034 §3: what comes back is a [`Caller`] - the identity plus the audit
/// actor of the session that was authorized, made ONCE here. The command
/// hands it to [`record_ok`]; a refusal is recorded with the same snapshot.
async fn require_role(state: &AppState, min: Role, resource: &str) -> Result<Caller, BantoError> {
    let Some(session) = current_session(state).await? else {
        return Err(BantoError::Unauthorized);
    };
    let caller = Caller::of(state, &session);
    if caller.identity.role.at_least(min) {
        return Ok(caller);
    }
    record_denied_as(&state.audit, &caller.actor, "tauri", resource, None).await;
    Err(BantoError::Forbidden)
}

/// The caller of a command, as [`require_role`] / [`require_permission`]
/// authorized it: the session's [`UserIdentity`] (read through `Deref`, so
/// `caller.username` / `caller.id` work as before) and the audit actor of
/// that session (ADR-0034 §3) - a snapshot, handed to [`record_ok`].
#[derive(Debug, Clone)]
struct Caller {
    identity: UserIdentity,
    actor: AuditActor,
    /// Whose UI settings this session reads and writes (ADR-0034 §8) - the
    /// Tauri twin of REST's `owner_of`: an account by its `users.id`, the
    /// no-login session as `local`. Decided from the session's VARIANT, like
    /// `actor` (conventions §10), and NOT the audit attribution: the no-login
    /// session's settings are `local`'s, not the built-in `admin`'s.
    ui_owner: UiSettingsOwner,
}

impl Caller {
    fn of(state: &AppState, session: &DesktopSession) -> Self {
        let identity = session.identity().clone();
        let ui_owner = match session {
            DesktopSession::Account(_) => UiSettingsOwner::Account(identity.id),
            DesktopSession::AuthDisabledLocal(_) => UiSettingsOwner::Local,
        };
        Self {
            identity,
            actor: session_actor(state.builtin_admin_id, session),
            ui_owner,
        }
    }
}

impl std::ops::Deref for Caller {
    type Target = UserIdentity;

    fn deref(&self) -> &UserIdentity {
        &self.identity
    }
}

impl AsRef<AuditActor> for Caller {
    fn as_ref(&self) -> &AuditActor {
        &self.actor
    }
}

/// Who the audit log attributes a desktop session's actions to (ADR-0034
/// §3) - the Tauri twin of `banto_server::AuthState::audit_actor`, through
/// the same rule ([`AuditActor::attribute`], conventions §1):
///
/// - an account: its username, `actor_id` = its `users.id`, kind `account`;
/// - the no-login session ([`DesktopSession::AuthDisabledLocal`]): the
///   built-in `admin`, `actor_id` = the built-in row's id, kind `local`. The
///   mark is the session's VARIANT - set by the wiring that installs it -
///   never its id or name (conventions §10). `actor_role` stays the mode's
///   role (a viewer stays `viewer`).
///
/// Only the audit attribution: the owner of UI settings and the session's
/// wire identity stay `local`.
fn session_actor(builtin_admin_id: i64, session: &DesktopSession) -> AuditActor {
    let identity = session.identity();
    let (account_id, kind, audit_as_builtin_admin) = match session {
        DesktopSession::Account(_) => (Some(identity.id), ACTOR_KIND_ACCOUNT, false),
        DesktopSession::AuthDisabledLocal(_) => (None, ACTOR_KIND_LOCAL, true),
    };
    AuditActor::attribute(
        ActorSession {
            username: &identity.username,
            account_id,
            role: identity.role.as_str(),
            kind,
            audit_as_builtin_admin,
        },
        Some(builtin_admin_id),
    )
}

/// [`session_actor`] of an account that is not (yet) the slot's session: a
/// login that just succeeded, an account session being replaced.
fn account_actor(identity: &UserIdentity) -> AuditActor {
    AuditActor::account(&identity.username, identity.id, identity.role.as_str())
}

/// Require an active webview session holding the per-user `permission`
/// (Issue #697, user-permissions-plan §5) - the Tauri twin of REST's
/// `PermissionGuard`/`require_permission` (conventions §1: same decision,
/// same audit, same error kinds). The role is not looked at: an admin without
/// the permission is refused, a viewer with it passes (call [`require_role`]
/// too when both are wanted). No session -> `Unauthorized`, not audited; a
/// session without the permission -> `Forbidden` plus a `denied` audit row
/// for `resource` (detail `None`, as for [`require_role`]). The session is
/// re-validated first ([`current_session`]) and its permissions are read
/// from the store on every call ([`permissions_of_session`]), so a revoked
/// one stops working on the next command. A permission the app's catalog
/// does not register is never held, so guarding with one refuses everybody.
/// For a decision finer than a command, use [`session_permissions`].
#[allow(dead_code)] // The template registers no permission (its catalog is empty), so no command uses it yet; derived apps do.
async fn require_permission(
    state: &AppState,
    permission: &PermissionKey,
    resource: &str,
) -> Result<Caller, BantoError> {
    let Some((session, permissions)) = authorized_session(state).await? else {
        return Err(BantoError::Unauthorized);
    };
    let caller = Caller::of(state, &session);
    if permissions.has(permission) {
        return Ok(caller);
    }
    record_denied_as(&state.audit, &caller.actor, "tauri", resource, None).await;
    Err(BantoError::Forbidden)
}

/// Record a successful, actor-attributed audit event from a Tauri command
/// (spec M14) - the desktop counterpart of REST's `record_write`, and like it
/// a thin wrapper over the shared `banto_server::routes::record_write_as`
/// (conventions §1: both paths write the SAME columns through the same
/// builder). `origin` is `"tauri"`, `result` `"ok"`.
///
/// `actor` is the snapshot of who was authorized (ADR-0034 §3): the
/// [`Caller`] [`require_role`] returned, or - in the auth flows, which run
/// before or without a guard - the [`AuditActor`] of the session being
/// established or ended ([`session_actor`] / [`account_actor`]).
///
/// The entries that are not a plain success go through the same shared
/// builders with their own shape, exactly as their REST counterparts do:
/// `record_as` ([`items_import_body`]'s `ok`/`failed`, a failed
/// `server_apply`, the firewall change's result), `record_login_failed_as`
/// (no actor), `record_denied_as` ([`require_role`] itself), and
/// `record_write_as` with no actor (the startup's `restore_applied`).
async fn record_ok(
    audit: &AuditLogService,
    actor: &impl AsRef<AuditActor>,
    action: &str,
    resource: &str,
    entity_id: Option<&str>,
    detail: Option<serde_json::Value>,
) {
    record_write_as(
        audit,
        Some(actor.as_ref()),
        "tauri",
        action,
        resource,
        entity_id,
        detail,
    )
    .await;
}

/// Smoke-test command used by the frontend to verify the bridge.
#[tauri::command]
fn ping() -> &'static str {
    concat!("banto ", env!("CARGO_PKG_VERSION"))
}

// [scaffold:items] begin
//
// D1-d (display-preset-plan.md, Issue #190 prep): the items_* command group
// (CRUD + import), contiguous so a future `display`/`items` remover can
// delete it with one `cutRegion` on these markers.

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
    record_ok(
        &state.audit,
        &actor,
        "create",
        "items",
        Some(&item.id.to_string()),
        Some(admin_template_core::items::item_create_detail(&item)),
    )
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
    let (previous, item) = state.items.update_returning_previous(id, values).await?;
    record_ok(
        &state.audit,
        &actor,
        "update",
        "items",
        Some(&item.id.to_string()),
        Some(admin_template_core::items::item_update_detail(
            &previous, &item,
        )),
    )
    .await;
    Ok(item)
}

/// Body of [`items_delete`], split out (spec M14 pattern, see
/// [`items_import_body`]) so its authz + attachment-sweep + audit behavior is
/// testable with a plain `&AppState` in this crate's own `cargo test`.
///
/// `version` (Issue #638) is the optimistic-lock check, the same as REST's
/// `DELETE /api/items/{id}?version=N`: a different stored version is a
/// `conflict` and nothing is deleted or audited; `None` deletes as before.
async fn items_delete_body(
    state: &AppState,
    id: i64,
    version: Option<i64>,
) -> Result<(), BantoError> {
    let actor = require_role(state, Role::Editor, "items").await?;
    let item = state.items.delete_returning_previous(id, version).await?;
    // M20 unit C demo wiring (spec docs/design/attachments-plan.md §3.8): sweep up
    // any attachments left pointing at the now-deleted record (best-effort).
    let sweep = sweep_item_attachments(&state.attachments, id).await;
    record_ok(
        &state.audit,
        &actor,
        "delete",
        "items",
        Some(&id.to_string()),
        Some(admin_template_core::items::item_delete_detail(&item, sweep)),
    )
    .await;
    Ok(())
}

#[tauri::command]
async fn items_delete(
    state: State<'_, AppState>,
    id: i64,
    version: Option<i64>,
) -> Result<(), BantoError> {
    items_delete_body(&state, id, version).await
}

/// Body of [`items_bulk_delete`], split out (spec M14 pattern, see
/// [`items_import_body`]) so its authz + attachment-sweep + audit behavior is
/// testable with a plain `&AppState`.
///
/// Issue #713: the Tauri twin of REST's `POST /api/items/bulk-delete`
/// (conventions section 1) - the same `editor` floor, the same
/// all-or-nothing [`ItemsService::bulk_delete`], and ONE
/// `action: "bulk_delete"` audit entry for the whole request (no
/// `entity_id`). A conflict (stale version, missing id)
/// deletes nothing and records nothing, like [`items_delete_body`].
async fn items_bulk_delete_body(
    state: &AppState,
    target: admin_template_core::items::BulkDeleteTarget,
) -> Result<admin_template_core::items::BulkDeleteResult, BantoError> {
    let actor = require_role(state, Role::Editor, "items").await?;
    let deleted = state.items.bulk_delete(&target).await?;
    // Bulk twin of the items_delete sweep (spec docs/design/attachments-plan.md §3.8):
    // remove the attachments left pointing at the now-deleted records (best-effort).
    let sweep = admin_template_core::attachment_wiring::sweep_items_attachments(
        &state.attachments,
        &deleted,
    )
    .await;
    let detail = admin_template_core::items::item_bulk_delete_detail(&target, &deleted, sweep);
    record_ok(
        &state.audit,
        &actor,
        "bulk_delete",
        "items",
        None,
        Some(detail),
    )
    .await;
    Ok(admin_template_core::items::BulkDeleteResult {
        deleted: deleted.len(),
    })
}

#[tauri::command]
async fn items_bulk_delete(
    state: State<'_, AppState>,
    target: admin_template_core::items::BulkDeleteTarget,
) -> Result<admin_template_core::items::BulkDeleteResult, BantoError> {
    items_bulk_delete_body(&state, target).await
}

/// Body of [`items_import`], split out the same way [`change_own_password`]
/// is (spec M14 pattern) so the audit-recording behavior is testable with a
/// plain `&AppState` in this crate's own `cargo test` - `tauri::State`
/// cannot be constructed outside a running tauri app, but it derefs to
/// `&AppState`, so the command below is a one-line adapter.
///
/// Unlike `items_create`/`update`/`delete` above, [`ItemsService::import`]
/// itself never fails on bad ROW data - an all-or-nothing rollback comes
/// back as `Ok(ImportResult)` with `errors` populated (spec M15 design
/// decision, see that method's doc comment) - so this always records
/// exactly one `action: "import"` entry: `result: "ok"` with a
/// `{created,updated}` summary when `errors` is empty, `result: "failed"`
/// with an `{errorCount}` summary when the batch was rolled back. It only
/// skips the write the way every other command here does: when the service
/// call returns `Err` outright (e.g. the row-count limit), which `?`
/// propagates before this function's audit code runs.
async fn items_import_body(
    state: &AppState,
    rows: Vec<ItemImportRow>,
) -> Result<ImportResult, BantoError> {
    let actor = require_role(state, Role::Editor, "items").await?;
    let result = state.items.import(rows).await?;
    let (result_tag, detail) = if result.errors.is_empty() {
        (
            "ok",
            serde_json::json!({ "created": result.created, "updated": result.updated }),
        )
    } else {
        (
            "failed",
            serde_json::json!({ "errorCount": result.errors.len() }),
        )
    };
    record_as(
        &state.audit,
        Some(&actor.actor),
        "tauri",
        "import",
        "items",
        None,
        Some(detail),
        result_tag,
    )
    .await;
    Ok(result)
}

#[tauri::command]
async fn items_import(
    state: State<'_, AppState>,
    rows: Vec<ItemImportRow>,
) -> Result<ImportResult, BantoError> {
    items_import_body(&state, rows).await
}
// [scaffold:items] end

// `pnpm banto add resource` writes each new resource's commands above this
// line (docs/recipes/add-resource.md): the Tauri twins of its REST routes,
// with the same role floor and the same audit entries (conventions section 1).
// [banto:add-resource:tauri-commands]

/// What the login page needs before any session exists. There is no
/// "initialized" in it (ADR-0034 §5): a new database is usable as soon as its
/// migrations have run - it starts in no-login mode, and accounts are created
/// from user management.
#[tauri::command]
async fn auth_status(_state: State<'_, AppState>) -> Result<AuthStatusResult, BantoError> {
    Ok(AuthStatusResult {
        // See `AuthStatusResult::viewer_public`: never true in this window.
        viewer_public: false,
    })
}

/// Message for a `LoginResult { superseded: true }` (the credentials were
/// valid, but another session was established first).
const SUPERSEDED_LOGIN_MESSAGE: &str =
    "別のセッションが先に確定したため、このログインは適用されませんでした";

/// `LoginResult.error` of a login refused because auth-disabled mode is
/// on (S-95). The same text the REST login answers with in that mode
/// (ADR-0034 §6; conventions §1).
const AUTH_DISABLED_LOGIN_MESSAGE: &str = banto_server::LOGIN_DISABLED_MESSAGE;

/// The refusal of a login in auth-disabled mode (owner decision on
/// #266, S-95): `success: false`, not `superseded` (no other session won a
/// race - the mode forbids it), nothing written, the current `seq`. An `Ok`
/// result rather than an `Err`, so the TS provider observes the unchanged
/// `seq` and reports nothing (I-19), and the login screen shows `error`.
fn auth_disabled_login_result(state: &AppState) -> LoginResult {
    LoginResult {
        success: false,
        error: Some(AUTH_DISABLED_LOGIN_MESSAGE.to_string()),
        superseded: false,
        seq: read_slot(state).1,
    }
}

/// Install a verified account session only while auth-disabled mode is off
/// (owner decision on #266, S-95): so that
/// `auth.disabled == true <=> DesktopSession::AuthDisabledLocal` holds
/// always. Under `auth_config_lock` (taken AFTER the password check, never
/// held across it), the mode is read and, if it is off, the session is
/// installed with the `seq` compare-and-set ([`install_login`]); if it is on,
/// nothing is written. `auth_config_apply(true)` re-binds under the same lock
/// right after its save, so the two cannot interleave: an apply first leaves
/// Local (this refuses), a login first leaves Account (the apply then
/// replaces it). A failed mode read is an `Err` returned before any slot
/// write (I-19). Lock order: `auth_config_lock` -> `state.auth`.
async fn install_account_unless_auth_disabled(
    state: &AppState,
    seq_at_entry: u64,
    identity: UserIdentity,
) -> Result<LoginResult, BantoError> {
    let _auth_config = state.auth_config_lock.lock().await;
    if state.settings.auth_config().await?.disabled {
        return Ok(auth_disabled_login_result(state));
    }
    Ok(install_login(
        state,
        seq_at_entry,
        DesktopSession::Account(identity),
    ))
}

/// Install a verified login session with [`cas_session`] and build the
/// command result: `superseded` when the slot was re-bound after
/// `seq_at_entry`.
fn install_login(state: &AppState, seq_at_entry: u64, session: DesktopSession) -> LoginResult {
    let (written, seq) = cas_session(state, seq_at_entry, Some(session));
    if written {
        LoginResult {
            success: true,
            error: None,
            superseded: false,
            seq,
        }
    } else {
        LoginResult {
            success: false,
            error: Some(SUPERSEDED_LOGIN_MESSAGE.to_string()),
            superseded: true,
            seq,
        }
    }
}

/// Issue #260 (design §5.3, S-16): the session is installed only if no other
/// command (a logout, another login) re-bound the slot while the password
/// was being verified. The `login` audit entry is still recorded at
/// verification success, before the install (design §1.7, decision 7).
#[tauri::command]
async fn auth_login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<LoginResult, BantoError> {
    login_body(&state, username, password).await
}

/// Body of [`auth_login`] (testable with a plain `&AppState`, design §8.3).
/// Slot-clearing errors: none - every `Err` is returned before the slot is
/// written (the TS provider's revision relies on this, design I-19).
async fn login_body(
    state: &AppState,
    username: String,
    password: String,
) -> Result<LoginResult, BantoError> {
    let (_, seq_at_entry) = read_slot(state);
    // Owner decision on #266 (S-95): refused in auth-disabled mode - before
    // the (slow) password check, which then records nothing; and again at
    // the install, after the check (see
    // [`install_account_unless_auth_disabled`]).
    if state.settings.auth_config().await?.disabled {
        return Ok(auth_disabled_login_result(state));
    }
    match (state.auth_io.verify)(username.clone(), password).await? {
        Some(identity) => {
            // Recorded at verification success, before the install decides
            // (design §1.7, decision 7) - as for a superseded login.
            record_ok(
                &state.audit,
                &account_actor(&identity),
                "login",
                "auth",
                None,
                None,
            )
            .await;
            install_account_unless_auth_disabled(state, seq_at_entry, identity).await
        }
        None => {
            // The same builder as the REST path: no actor, the tried name
            // bounded (Issue #278).
            record_login_failed_as(&state.audit, "tauri", &username, None).await;
            Ok(LoginResult {
                success: false,
                error: Some("ユーザー名またはパスワードが違います".to_string()),
                superseded: false,
                seq: read_slot(state).1,
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
///
/// Issue #260 (design §5.3, S-17/S-67): the slot is cleared only if no other
/// command re-bound it while the auth mode was being read ([`cas_session`]
/// against the `seq` read before the first `.await`, advancing `seq` even
/// when there was no session). A logout overtaken by a login leaves that
/// login's session in place and records no `logout`. The auth-disabled
/// no-op does not advance `seq`. A logout that cleared re-reads the mode
/// and, if auth-disabled mode was switched on meanwhile, installs the
/// synthetic session (PR #264 review P1, see [`logout_body`]). Either way
/// the result carries the `seq` after the command.
#[tauri::command]
async fn auth_logout(state: State<'_, AppState>) -> Result<LogoutResult, BantoError> {
    logout_body(&state).await
}

/// Body of [`auth_logout`] (testable with a plain `&AppState`, design §8.3).
/// Slot-clearing errors: none - every `Err` is returned before the slot is
/// written (the TS provider's revision relies on this, design I-19).
async fn logout_body(state: &AppState) -> Result<LogoutResult, BantoError> {
    let (previous, seq_at_entry) = read_slot(state);
    if (state.auth_io.auth_mode)().await?.disabled {
        return Ok(LogoutResult {
            seq: read_slot(state).1,
        });
    }
    let (written, mut seq) = cas_session(state, seq_at_entry, None);
    if !written {
        return Ok(LogoutResult { seq });
    }
    // PR #264 review P1: the mode read above may be stale - auth-disabled
    // mode can have been switched on before this clear. (Since the owner
    // review of #266 P1 an apply re-binds the session right after its save,
    // which moves `seq` so this clear would not have been written; the
    // re-read is kept as the defense for any path that saves the mode
    // without re-binding.) Re-read the mode and, if it is now disabled, install
    // the synthetic session - but only while the slot is still exactly what
    // this clear left (`seq` unchanged and empty), so a later login or a
    // config-apply that already installed it is never overwritten and the
    // synthetic session is never installed twice ([`rebind_local_session`]
    // with this clear's `seq`: an unchanged `seq` means the slot is still
    // the empty one this clear left).
    //
    // A failed re-read is NOT an error of this logout: the clear has
    // happened (and an `Err` after a slot write would break the TS
    // provider's "errors are returned before the slot is written" contract,
    // design I-19), so the logout reports success and installs nothing. The
    // gap is then filled by the next `auth_config_apply`, or by `run()`'s
    // bootstrap on the next launch.
    //
    // PR #264 re-review P2: the re-read and the install run under
    // `auth_config_lock`, so an `apply(false)` cannot complete between the
    // value read here and the install based on it. The FIRST read (the
    // auth-disabled no-op decision above) stays outside the lock: it writes
    // nothing on its own, and a stale "enabled" answer there is exactly what
    // this re-read corrects; a stale "disabled" answer only makes this
    // logout a no-op that the frontend re-resolves.
    let rebind = {
        let _auth_config = state.auth_config_lock.lock().await;
        match (state.auth_io.auth_mode)().await {
            Ok(config) if config.disabled => {
                let (rebind, seq_now) =
                    rebind_local_session(state, config.disabled_role, Some(seq), false);
                seq = seq_now;
                rebind
            }
            Ok(_) => LocalRebind::Skipped,
            Err(err) => {
                eprintln!("banto: ログアウト後の認証モードの再読み込みに失敗しました: {err}");
                LocalRebind::Skipped
            }
        }
    };
    if let Some(session) = previous {
        record_ok(
            &state.audit,
            &session_actor(state.builtin_admin_id, &session),
            "logout",
            "auth",
            None,
            None,
        )
        .await;
    }
    // Only `Installed` can happen here: with `seq` unchanged since the clear,
    // the slot is empty.
    record_local_rebind(&state.audit, state.builtin_admin_id, &rebind).await;
    Ok(LogoutResult { seq })
}

/// Issue #204: validated like every other command ([`current_session`]), so
/// a session ended by a change to its account reports "logged out" here
/// too, not just on the next guarded command.
#[tauri::command]
async fn auth_check(state: State<'_, AppState>) -> Result<bool, BantoError> {
    Ok(current_session(&state).await?.is_some())
}

/// Issue #204: the CURRENT identity (role/display name as stored now).
/// Issue #697: with its per-user `permissions`, read now.
#[tauri::command]
async fn auth_identity(state: State<'_, AppState>) -> Result<Option<Identity>, BantoError> {
    auth_identity_body(&state).await
}

/// Body of [`auth_identity`] (testable with a plain `&AppState`).
async fn auth_identity_body(state: &AppState) -> Result<Option<Identity>, BantoError> {
    // One snapshot to the end of the permissions read (ADR-0034 §6).
    Ok(displayed_session(state)
        .await?
        .map(|(session, permissions)| identity_from(session.identity(), permissions)))
}

/// Issue #260 (design §5.3): the frontend provider's `resolve()` - the
/// session, its kind, and which slot write the answer is about, in one round
/// trip. Validated like [`auth_identity`] (the account row / auth-disabled
/// mode is re-read, so role and display name are current), but the `seq` is
/// read BEFORE the store read and the settle happens under one lock:
/// `current == checked + 1` iff this call cleared a revoked session, and a
/// slot re-bound meanwhile is reported as `stale` with nothing written.
#[tauri::command]
async fn auth_resolve(state: State<'_, AppState>) -> Result<AuthResolveResult, BantoError> {
    resolve_body(&state).await
}

fn session_kind(session: &DesktopSession) -> &'static str {
    match session {
        DesktopSession::Account(_) => "account",
        DesktopSession::AuthDisabledLocal(_) => "local",
    }
}

/// Body of [`auth_resolve`] (testable with a plain `&AppState`, design §8.3).
/// Its `Ok` answer carries any clear it made (`current`); an `Err` is
/// returned before the slot is written.
async fn resolve_body(state: &AppState) -> Result<AuthResolveResult, BantoError> {
    let (cached, seq_at_entry) = read_slot(state);
    let Some(cached) = cached else {
        return Ok(AuthResolveResult {
            identity: None,
            kind: None,
            checked: seq_at_entry,
            current: seq_at_entry,
            stale: false,
        });
    };
    let fresh = read_session_source(state, &cached).await?;
    Ok(match settle_session(state, &cached, fresh, seq_at_entry) {
        Settled::Stale { .. } => AuthResolveResult {
            identity: None,
            kind: None,
            checked: seq_at_entry,
            current: read_slot(state).1,
            stale: true,
        },
        Settled::Settled {
            session,
            seq_before,
            seq_after,
        } => {
            // Issue #697: the permissions are read after the settle (they
            // are not part of the binding, so they do not move `seq`).
            let identity = match session.as_ref() {
                Some(session) => Some(identity_of(state, session).await?),
                None => None,
            };
            // ADR-0034 §6 (cross-review of PR #862): that read awaited, and
            // an apply / logout / login may have re-bound the slot meanwhile.
            // The answer would name a session that is no longer the slot's,
            // so it is reported `stale` like a re-bind during the store read
            // above (the provider resolves again).
            let seq_now = read_slot(state).1;
            if seq_now != seq_after {
                return Ok(AuthResolveResult {
                    identity: None,
                    kind: None,
                    checked: seq_at_entry,
                    current: seq_now,
                    stale: true,
                });
            }
            AuthResolveResult {
                identity,
                kind: session.as_ref().map(session_kind),
                checked: seq_before,
                current: seq_after,
                stale: false,
            }
        }
    })
}

/// Body of [`auth_change_password`], split out so the audit-recording
/// behavior (spec M14) is testable with a plain `&AppState` in this crate's
/// own `cargo test` - `tauri::State` cannot be constructed outside a running
/// tauri app, but it derefs to `&AppState`, so the command below is a
/// one-line adapter.
///
/// Issue #204: the session is validated first ([`current_session`]). The
/// change advances the account's `auth_epoch`, ending every session of it
/// (REST tokens on other devices included); this webview session is then
/// re-bound to the new epoch - it just proved the current password - unless
/// something else changed the account in between (then it ends too). Same
/// policy as REST's `/api/auth/change-password`.
///
/// Issue #260 (design §5.3, I-11, S-68): the re-bind is a write that changes
/// the binding, so it advances the slot's `seq`; the result carries the
/// `seq` after the command (unchanged when the re-bind did not happen).
///
/// Slot-clearing errors: ONLY `BantoError::Unauthorized` can be returned
/// after the slot was written - the session check at the start
/// ([`current_session`]) clears a revoked session (advancing `seq`) and this
/// then fails with `Unauthorized`. Every other `Err` (`Forbidden`, the
/// `Validation` of a wrong current password, storage errors) is returned
/// with the slot unwritten by this command. The TS provider's revision
/// relies on this split (design I-19).
async fn change_own_password(
    state: &AppState,
    current_password: &str,
    new_password: &str,
) -> Result<ChangePasswordResult, BantoError> {
    let identity = match current_session(state).await? {
        Some(DesktopSession::Account(identity)) => identity,
        // The synthetic auth-disabled session owns no credentials: never let
        // it change a real account that happens to be named "local".
        Some(DesktopSession::AuthDisabledLocal(_)) => return Err(BantoError::Forbidden),
        None => return Err(BantoError::Unauthorized),
    };
    let new_epoch = state
        .users
        .change_password(&identity.username, current_password, new_password)
        .await?;
    let seq = {
        let mut slot = state.auth.lock().expect("auth mutex poisoned");
        if new_epoch == identity.auth_epoch + 1 {
            let mut rebound = false;
            if let Some(DesktopSession::Account(session)) = slot.session.as_mut() {
                if session.id == identity.id && session.auth_epoch == identity.auth_epoch {
                    session.auth_epoch = new_epoch;
                    rebound = true;
                }
            }
            if rebound {
                slot.seq += 1;
            }
        }
        slot.seq
    };
    // Spec M14: a self-service password change is a security event (it is
    // also what naturally invalidates an M11 autologin credential), so it IS
    // audited - actor and entity are both the caller. `detail` stays `None`:
    // neither the old nor the new password (nor any hash) may ever be
    // recorded.
    record_ok(
        &state.audit,
        &account_actor(&identity),
        "password_change",
        "users",
        Some(&identity.id.to_string()),
        None,
    )
    .await;
    Ok(ChangePasswordResult { seq })
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
) -> Result<ChangePasswordResult, BantoError> {
    change_own_password(&state, &current_password, &new_password).await
}

// --- M11: auth-disabled mode + desktop autologin ---------------------------

/// The synthetic identity of auth-disabled mode (spec M11). The ONE
/// definition shared by `run()`'s bootstrap and [`rebind_local_session`]
/// (used by [`auth_config_apply_with_permissions_body`] and [`logout_body`]), so they can
/// never drift apart. `id: 0` is not a
/// real `users` row - nothing ever looks a synthetic session up by id (no
/// change-password/self-deletion flows apply to it), so there is no real
/// row to alias.
fn local_identity(role: Role) -> UserIdentity {
    UserIdentity {
        id: LOCAL_SESSION_ID,
        username: "local".to_string(),
        display_name: "ローカルユーザー".to_string(),
        role,
        auth_epoch: 0,
        // No account behind it: no `accountId` on the wire (ADR-0034 §1).
        account_uid: None,
    }
}

/// Spec M14: auth-disabled mode still records a `login` for its synthetic
/// session, same as a normal login would - it is still "someone" starting to
/// use the app, just without a credential check.
///
/// ADR-0034 §3: the actor is the built-in `admin` (`actor_kind` `local`),
/// like everything the no-login session does afterwards ([`session_actor`]).
async fn record_local_login(
    audit: &AuditLogService,
    builtin_admin_id: i64,
    identity: &UserIdentity,
) {
    record_ok(
        audit,
        &local_actor(builtin_admin_id, identity),
        "login",
        "auth",
        None,
        Some(serde_json::json!({ "mode": "auth_disabled" })),
    )
    .await;
}

/// [`session_actor`] of the no-login session whose identity is `local`.
fn local_actor(builtin_admin_id: i64, local: &UserIdentity) -> AuditActor {
    session_actor(
        builtin_admin_id,
        &DesktopSession::AuthDisabledLocal(local.clone()),
    )
}

/// What [`rebind_local_session`] did to the slot.
#[derive(Debug, Clone, PartialEq)]
enum LocalRebind {
    /// Nothing written: `expected_seq` was given and the slot had moved.
    Skipped,
    /// The slot was empty; the synthetic session was installed (`seq` + 1).
    Installed(UserIdentity),
    /// An account session was replaced by the synthetic one (`seq` + 1). The
    /// caller records the account's end and the synthetic `login`.
    Replaced {
        previous: UserIdentity,
        local: UserIdentity,
    },
    /// The synthetic session was there with another role: its role was
    /// changed (`seq` + 1 - an authorization-context change, re-review of
    /// #266 P1, S-96). No session audit (the `settings_change` records it).
    RoleChanged,
    /// The synthetic session was there with this role: nothing written,
    /// `seq` unchanged.
    Unchanged,
}

/// The auth-mode change's session rebind (Issue #260 実装-3, owner review of
/// #266 P1, design §5.3): make the slot hold the auth-disabled synthetic
/// session for `role`, under ONE lock, so that
/// `auth.disabled == true <=> DesktopSession::AuthDisabledLocal <=>
/// auth_resolve kind == "local"` holds as soon as the mode is saved:
///
/// - `None -> Local` and `Account(A) -> Local`: written, `seq` + 1 (a
///   binding change: a login that read the old `seq` can no longer install
///   over it, S-94);
/// - `Local(r) -> Local(r')` with `r != r'`: the role is written and `seq`
///   advances (re-review of #266 P1, S-96). [`same_binding`] treats every
///   synthetic session as one binding, so `seq` is the only thing that tells
///   an in-flight [`settle_session`] that the slot was written after it read
///   the store; without the advance, an `auth_resolve` that had read the old
///   role would write it back over the new one;
/// - `Local(r) -> Local(r)`: nothing written, `seq` unchanged - UNLESS
///   `role_changed` (S-98): the caller's own change of the mode's role,
///   decided from the settings BEFORE its save, not from the slot. Between
///   the save and this call, an `auth_resolve`/`current_session` that does
///   not take `auth_config_lock` can read the new role from the store and
///   refresh the slot to it ([`settle_session`] writes the role but never
///   advances `seq` - advancing there would break "`current != checked` iff
///   this call cleared", I-23). The slot then already holds the new role,
///   yet an even older settle that read the OLD role still sees the same
///   `seq`; so the role change is advanced here regardless of the slot. A
///   settle's refresh writes the role without advancing `seq`; telling
///   in-flight settles about a role change is this forced advance's job.
///
/// With `expected_seq` (the logout's re-read), nothing is written unless
/// `seq` is still that value (the slot is then exactly what the logout's
/// clear left: empty). The guard never lives across an `.await` (Copilot
/// review on PR #182). Returns the outcome and the `seq` after the call.
fn rebind_local_session(
    state: &AppState,
    role: Role,
    expected_seq: Option<u64>,
    role_changed: bool,
) -> (LocalRebind, u64) {
    let mut slot = state.auth.lock().expect("auth mutex poisoned");
    if expected_seq.is_some_and(|seq| seq != slot.seq) {
        return (LocalRebind::Skipped, slot.seq);
    }
    let (outcome, next) = match slot.session.as_ref() {
        Some(DesktopSession::AuthDisabledLocal(local)) if local.role == role && !role_changed => {
            return (LocalRebind::Unchanged, slot.seq);
        }
        Some(DesktopSession::AuthDisabledLocal(local)) => (
            LocalRebind::RoleChanged,
            UserIdentity {
                role,
                ..local.clone()
            },
        ),
        Some(DesktopSession::Account(previous)) => {
            let local = local_identity(role);
            (
                LocalRebind::Replaced {
                    previous: previous.clone(),
                    local: local.clone(),
                },
                local,
            )
        }
        None => {
            let local = local_identity(role);
            (LocalRebind::Installed(local.clone()), local)
        }
    };
    slot.session = Some(DesktopSession::AuthDisabledLocal(next));
    slot.seq += 1;
    (outcome, slot.seq)
}

/// Make the session follow a saved auth mode (`saved`), compared with the
/// mode before the save (`previous`) - synchronous, under `state.auth`'s
/// lock only (the caller holds `auth_config_lock`):
/// - mode on: [`rebind_local_session`], with `seq` forced to advance when
///   `(disabled, disabled_role)` changed in this save (S-98; freshness audit
///   of #266 P2-2: `false -> true` included, even if the slot already holds
///   Local);
/// - mode turned off (`true -> false`): [`end_local_session`] (S-99);
/// - mode off before and after: nothing.
///
/// The embedded server's account sessions follow the same saved mode in the
/// same step ([`apply_mode_to_rest_sessions`], ADR-0034 §6); the third value
/// is how many LAN account tokens that revoked.
fn apply_mode_to_session(
    state: &AppState,
    previous: &AuthSettings,
    saved: &AuthSettings,
    permissions_changed: bool,
) -> (LocalRebind, Option<UserIdentity>, usize) {
    let revoked = apply_mode_to_rest_sessions(&state.rest_auth, saved.disabled);
    let (rebind, ended_local) =
        apply_mode_to_webview_session(state, previous, saved, permissions_changed);
    (rebind, ended_local, revoked)
}

/// The [`AuthMode`] of the embedded server's `AuthState` for a stored
/// `auth.disabled`.
fn rest_auth_mode(disabled: bool) -> AuthMode {
    if disabled {
        AuthMode::NoLogin
    } else {
        AuthMode::LoginRequired
    }
}

/// Make the embedded server's account sessions follow a saved (or, at
/// startup, stored) auth mode (ADR-0034 §6): `AuthState::switch_auth_mode`
/// advances the mode's generation and revokes every LAN account token under
/// one lock, so a LAN login still verifying its password, or a LAN request
/// whose account lookup is still in flight, cannot issue or use a token of
/// the mode that just ended. While the mode is on, the embedded server
/// refuses account logins - the REST twin of
/// [`install_account_unless_auth_disabled`]. Synchronous; the caller holds
/// `auth_config_lock` and calls this right after the save, with no `.await`
/// in between ("persist, then revoke", ADR-0017 §2). Idempotent for an
/// unchanged mode. Grant sessions (閲覧公開) are not touched. Returns how many
/// account tokens were revoked.
fn apply_mode_to_rest_sessions(rest_auth: &AuthState, disabled: bool) -> usize {
    rest_auth.switch_auth_mode(rest_auth_mode(disabled))
}

/// The webview half of [`apply_mode_to_session`].
fn apply_mode_to_webview_session(
    state: &AppState,
    previous: &AuthSettings,
    saved: &AuthSettings,
    permissions_changed: bool,
) -> (LocalRebind, Option<UserIdentity>) {
    if saved.disabled {
        // Issue #697: a change of the mode's permissions is an
        // authorization-context change like a role change, so `seq` advances
        // for it too (the webview then re-reads the session's `permissions`).
        let changed = permissions_changed
            || (previous.disabled, previous.disabled_role) != (saved.disabled, saved.disabled_role);
        (
            rebind_local_session(state, saved.disabled_role, None, changed).0,
            None,
        )
    } else if previous.disabled {
        (LocalRebind::Skipped, end_local_session(state))
    } else {
        (LocalRebind::Skipped, None)
    }
}

/// Audit [`apply_mode_to_session`]'s outcome (spec M14): the rebind's
/// entries ([`record_local_rebind`]) and an ended synthetic session's
/// `logout` with `detail: { "reason": "auth_enabled" }` (told apart from a
/// user's logout, whose `detail` is empty).
async fn record_mode_session_change(
    audit: &AuditLogService,
    builtin_admin_id: i64,
    rebind: &LocalRebind,
    ended_local: Option<UserIdentity>,
) {
    record_local_rebind(audit, builtin_admin_id, rebind).await;
    if let Some(local) = ended_local {
        record_ok(
            audit,
            &local_actor(builtin_admin_id, &local),
            "logout",
            "auth",
            None,
            Some(serde_json::json!({ "reason": "auth_enabled" })),
        )
        .await;
    }
}

/// End the auth-disabled synthetic session because the mode was turned off
/// (re-review of #266 P1, S-99): under ONE lock, `Local -> None`, advancing
/// `seq`, returning the ended identity (the caller records its end). Anything
/// else is left alone: `None` has nothing to end, and an `Account` is not
/// the mode's session (with `auth.disabled == true <=> AuthDisabledLocal`
/// holding, the slot cannot hold one while the mode was on; were it there,
/// the account's own re-validation decides its fate).
fn end_local_session(state: &AppState) -> Option<UserIdentity> {
    let mut slot = state.auth.lock().expect("auth mutex poisoned");
    let Some(DesktopSession::AuthDisabledLocal(local)) = slot.session.as_ref() else {
        return None;
    };
    let local = local.clone();
    slot.session = None;
    slot.seq += 1;
    Some(local)
}

/// Audit what [`rebind_local_session`] did (spec M14): the synthetic
/// `login` for an install; for a replaced account, that account's session
/// end as `logout` with `detail: { "reason": "auth_disabled" }` (not a
/// logout the user asked for - the detail tells the two apart) and then the
/// synthetic `login`. A role change records nothing here (the synthetic
/// session goes on; the apply's `settings_change` records the change).
async fn record_local_rebind(
    audit: &AuditLogService,
    builtin_admin_id: i64,
    outcome: &LocalRebind,
) {
    match outcome {
        LocalRebind::Installed(local) => record_local_login(audit, builtin_admin_id, local).await,
        LocalRebind::Replaced { previous, local } => {
            record_ok(
                audit,
                &account_actor(previous),
                "logout",
                "auth",
                None,
                Some(serde_json::json!({ "reason": "auth_disabled" })),
            )
            .await;
            record_local_login(audit, builtin_admin_id, local).await;
        }
        LocalRebind::Skipped | LocalRebind::RoleChanged | LocalRebind::Unchanged => {}
    }
}

/// Current auth-mode settings (spec M11): any authenticated role may read
/// this (it only feeds a settings-screen display), and it never carries the
/// autologin password - `AuthSettings` itself has no such field (see its doc
/// comment in `admin_template_core::settings`).
#[tauri::command]
async fn auth_config_get(state: State<'_, AppState>) -> Result<AuthSettingsView, BantoError> {
    require_role(&state, Role::Viewer, "settings").await?;
    auth_settings_view(&state, state.settings.auth_config().await?).await
}

/// `settings` as the settings screen reads it: with the mode's permissions and
/// whether login could be required right now.
async fn auth_settings_view(
    state: &AppState,
    settings: AuthSettings,
) -> Result<AuthSettingsView, BantoError> {
    Ok(AuthSettingsView {
        settings,
        disabled_permissions: auth_disabled_permissions_view(state).await?,
        has_admin_account: state.users.has_admin().await?,
    })
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
///
/// There is no other way in without a session (ADR-0034 §5): a new database
/// starts in this mode, so the "no account yet" window this command once had
/// (for the first-run screen) is gone.
///
/// REQUIRING LOGIN (turning the mode off) needs an administrator account
/// that can log in (ADR-0034 §6): without one the save is refused with a
/// `Validation` on `disabled` ("create an administrator account first") and
/// nothing changes - not the settings, not the session, not the embedded
/// server's mode. The check is the save's own
/// (`SettingsService::set_auth_config`), so it runs under `auth_config_lock`
/// before `AuthState::switch_auth_mode`; the last administrator can never be
/// removed, so one that is there at the check is there at the save.
///
/// Enabling the mode re-binds the session to the same synthetic local
/// identity `run()`'s bootstrap would create on the next launch (and
/// records the same synthetic `login` entry), so the webview enters the app
/// without a restart - also when an account session was signed in: that
/// session is replaced (owner review of #266 P1, [`rebind_local_session`]),
/// so `auth.disabled == true` always goes with the synthetic session.
///
/// Body of [`auth_config_apply`] (spec M14 pattern) so its escape-hatch
/// authz (the actor may be `None`) + audit behavior is testable with a
/// plain `&AppState`.
///
/// Also carries the mode's permissions (Issue #697,
/// user-permissions-plan §8-4): `permissions` = the keys the synthetic
/// session holds, replacing `auth.disabled_permissions`; `None` leaves them
/// as they are (a client that does not know the field keeps working).
///
/// It rides on this command - not a command of its own - so the write is
/// under the same `auth_config_lock` and the same authz (admin, or the
/// escape hatch) as the role, and the session rebind
/// below sees one decision. Every requested key must be one the catalog
/// registers: validated BEFORE anything is written (`Validation` on
/// `permissions`, like a user's). A change is audited next to the role's:
/// the `settings_change` detail gets `authDisabledPermissions: { added,
/// removed }` (only when something changed).
async fn auth_config_apply_with_permissions_body(
    state: &AppState,
    disabled: bool,
    disabled_role: &str,
    permissions: Option<&[String]>,
) -> Result<AuthSettingsView, BantoError> {
    // PR #264 re-review P2: held from the first settings read through the
    // save and the synthetic-session install below (see
    // `AppState::auth_config_lock`), so no other apply (or a logout's
    // re-read + install) can interleave with this decision.
    let _auth_config = state.auth_config_lock.lock().await;
    // Read through the injectable `auth_mode` (production: the same
    // `SettingsService::auth_config`) so tests can fix this command's order
    // against a concurrent logout (design §8.3).
    let currently_disabled = (state.auth_io.auth_mode)().await?.disabled;
    // Spec M14: the escape hatch (see this command's doc comment) means
    // `require_role` may not run at all - capture whatever actor identity
    // exists directly in that case, so the audit entry below still has one
    // when possible, instead of skipping that path's write entirely.
    let actor = if currently_disabled {
        // Audit attribution only (this path does not authorize by
        // session): the actor of whatever session the slot holds.
        state
            .auth
            .lock()
            .expect("auth mutex poisoned")
            .session
            .as_ref()
            .map(|session| session_actor(state.builtin_admin_id, session))
    } else {
        Some(require_role(state, Role::Admin, "settings").await?.actor)
    };

    // An unrecognized role is refused, never turned into `admin` (ADR-0034
    // §5: the same stance as `SettingsService::auth_config`'s read). Nothing
    // has been written yet.
    let role = Role::from_str(disabled_role).map_err(|_| BantoError::Validation {
        field_errors: vec![banto_core::FieldError {
            field: "disabledRole".to_string(),
            message: "ロールは admin / editor / viewer のいずれかを指定してください".to_string(),
        }],
    })?;

    // Issue #697: validated after the authz above (a refused caller learns
    // nothing about the catalog) and before any write, so an unregistered
    // key leaves nothing half-saved.
    let catalog = state.users.permission_catalog();
    let requested = permissions.map(|raw| catalog.validate(raw)).transpose()?;
    let permissions_before: BTreeSet<PermissionKey> = state
        .settings
        .auth_disabled_permissions()
        .await?
        .into_iter()
        .collect();
    let permission_diff = requested
        .as_ref()
        .map(|after| PermissionDiff::between(&permissions_before, after))
        .unwrap_or_default();

    let mut config = state.settings.auth_config().await?;
    // The settings before this apply (read under `auth_config_lock`, so no
    // other apply changes them meanwhile): a change of the mode's role while
    // the mode stays on always advances `seq` at the rebind below (S-98).
    let previous = config.clone();
    config.disabled = disabled;
    config.disabled_role = role;
    // The mode, role and permissions are ONE transaction
    // (`SettingsService::set_auth_config_and_disabled_permissions`): either
    // all are stored or none is. So on failure nothing changed - including
    // the permissions - and the session is re-bound below from the stored
    // state with the permission change counted as "none" (no `seq` advance
    // for it; the role/mode change, if any, is still read back from storage).
    let save_result = (state.auth_io.save_auth_config)(
        config.clone(),
        requested
            .as_ref()
            .map(|keys| keys.iter().cloned().collect::<Vec<PermissionKey>>()),
    )
    .await;
    if let Err(err) = save_result {
        // Freshness audit of #266 (P2-3, S-104): the save is one transaction
        // (`SettingsService::set_auth_config`), but should any save fail
        // part-way, the session must still follow what IS stored: re-read
        // it and re-bind/end from that, then report the error.
        if let Ok(stored) = state.settings.auth_config().await {
            let (rebind, ended_local, _) = apply_mode_to_session(state, &previous, &stored, false);
            record_mode_session_change(&state.audit, state.builtin_admin_id, &rebind, ended_local)
                .await;
        }
        return Err(err);
    }
    // Owner review of #266 P1 (design §5.3, S-94): turning the mode on
    // re-binds the session to the synthetic one RIGHT after the save, with
    // no `.await` in between (still under `auth_config_lock`), so
    // `auth.disabled == true` is never observable together with an account
    // session. None -> Local and Account -> Local advance `seq` (a login
    // that started before can no longer install over it); Local -> Local
    // advances `seq` only when the role changes (S-96).
    //
    // Issue #260 (PR #264 review P1, kept): no "`seq` still the one read at
    // entry" condition - a logout that cleared the slot after this command
    // started would otherwise leave the mode with no session at all.
    // [`logout_body`] re-reads the mode after its clear for the other order;
    // both run under `auth_config_lock`, and the rebind is idempotent for
    // `Local`, so the synthetic session is never installed twice.
    //
    // Turning the mode OFF (re-review of #266 P1, S-99) ends the synthetic
    // session in the same step as the save (`Local -> None`, `seq` + 1), so
    // `auth.disabled == false` is never observable together with it - an
    // `auth_resolve` that had read `disabled = true` before the save then
    // settles `Stale` instead of confirming `local`. (This used to be left to
    // the next `auth_resolve`, on the grounds that the apply's answer carries
    // no `seq`; the frontend provider absorbs an unobserved `seq` advance
    // anyway - the catch-up of S-84.) Only on a `true -> false` change: a
    // re-save of `false` touches nothing.
    //
    // ADR-0034 §6: the same call switches the embedded server's auth mode
    // (generation + 1, every LAN account token revoked), so the LAN side
    // cannot observe the new stored mode together with a session of the old
    // one either.
    let (rebind, ended_local, revoked_sessions) =
        apply_mode_to_session(state, &previous, &config, !permission_diff.is_empty());
    record_write_as(
        &state.audit,
        actor.as_ref(),
        "tauri",
        "settings_change",
        "settings",
        None,
        Some(settings_change_detail(
            disabled,
            &permission_diff,
            revoked_sessions,
        )),
    )
    .await;

    // The session change is recorded after the settings change it follows
    // from: the admin's session end (`logout`, reason `auth_disabled`) and
    // the synthetic `login`.
    record_mode_session_change(&state.audit, state.builtin_admin_id, &rebind, ended_local).await;
    auth_settings_view(state, config).await
}

/// The `settings_change` audit detail of an auth-mode apply: `{ authDisabled }`,
/// plus `authDisabledPermissions: { added, removed }` when the mode's
/// permissions changed (Issue #697; the same `{ added, removed }` as a user's
/// `permissions` change), plus `revokedSessions: n` when the switch revoked
/// LAN account sessions (ADR-0034 §6; a count, like ADR-0017's
/// `revokedGrants`). Keys and counts only - never a secret.
fn settings_change_detail(
    disabled: bool,
    diff: &PermissionDiff,
    revoked_sessions: usize,
) -> serde_json::Value {
    let mut detail = serde_json::json!({ "authDisabled": disabled });
    if revoked_sessions > 0 {
        detail["revokedSessions"] = serde_json::json!(revoked_sessions);
    }
    if !diff.is_empty() {
        detail["authDisabledPermissions"] =
            serde_json::to_value(diff).unwrap_or(serde_json::Value::Null);
    }
    detail
}

/// `auth.disabled_permissions` as the settings screen shows it: the stored
/// keys the catalog registers (an unregistered leftover is not held - plan
/// §4 - and is dropped from the screen), sorted. Empty for the template.
async fn auth_disabled_permissions_view(state: &AppState) -> Result<Vec<String>, BantoError> {
    let catalog = state.users.permission_catalog();
    if catalog.is_empty() {
        return Ok(Vec::new());
    }
    let stored = state.settings.auth_disabled_permissions().await?;
    Ok(catalog
        .effective(&stored)
        .iter()
        .map(|key| key.as_str().to_string())
        .collect())
}

/// `auth_config_get` / `auth_config_apply`'s answer: [`AuthSettings`] plus
/// `disabledPermissions` (Issue #697). A response type of its own because
/// `AuthSettings` is built with struct literals by derived apps - a new field
/// there would break them (owner decision §8-7).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthSettingsView {
    #[serde(flatten)]
    settings: AuthSettings,
    disabled_permissions: Vec<String>,
    /// Whether an administrator account that can log in exists (ADR-0034 §6):
    /// what requiring login needs. For the screen only - it disables the
    /// switch and says why; the save decides again
    /// (`SettingsService::set_auth_config`).
    has_admin_account: bool,
}

/// `permissions` (Issue #697) = the keys the auth-disabled session holds;
/// omitted = unchanged. See [`auth_config_apply_with_permissions_body`].
#[tauri::command]
async fn auth_config_apply(
    state: State<'_, AppState>,
    disabled: bool,
    disabled_role: String,
    permissions: Option<Vec<String>>,
) -> Result<AuthSettingsView, BantoError> {
    auth_config_apply_with_permissions_body(
        &state,
        disabled,
        &disabled_role,
        permissions.as_deref(),
    )
    .await
}

/// Enable desktop autologin for `username` (spec M11): verifies the
/// credentials against the same `UsersService` a normal login would (so a
/// caller cannot register autologin for an account/password it does not
/// actually know), stores the password in the OS keyring (never in the
/// settings DB - see `keyring_store`), and flips the setting on. `admin`-only,
/// same floor as every other server/settings-mutating command.
/// Body of [`autologin_enable`] (spec M14 pattern) so its authz + keyring +
/// audit behavior is testable with a plain `&AppState` (the test installs an
/// in-memory keyring so `keyring_store::set_password` does not hit the OS
/// store on a headless runner).
async fn autologin_enable_body(
    state: &AppState,
    username: &str,
    password: &str,
) -> Result<(), BantoError> {
    let actor = require_role(state, Role::Admin, "settings").await?;

    if state.users.verify(username, password).await?.is_none() {
        return Err(BantoError::Validation {
            field_errors: vec![FieldError {
                field: "password".to_string(),
                message: "ユーザー名またはパスワードが違います".to_string(),
            }],
        });
    }

    // The same settings row as `auth_config_apply`: its read-modify-write
    // must not interleave with an apply's (a lost update of `disabled`).
    //
    // Order matters (S2 D): the OS keyring is an outside side effect that
    // no transaction can roll back, so everything that can fail BEFORE it
    // (the lock, the settings read) runs first, and a failed settings save
    // takes the credential back out. The keyring never keeps a credential
    // that the settings do not point at.
    let auth_config_guard = state.auth_config_lock.lock().await;
    let mut config = state.settings.auth_config().await?;
    let previous = config.autologin_username.clone();
    keyring_store::set_password(username, password)?;
    config.autologin_enabled = true;
    config.autologin_username = Some(username.to_string());
    if let Err(save_err) = state.settings.set_auth_config(&config).await {
        // Same username as before: the entry was already the settings'
        // credential (this call only refreshed it with the verified
        // password), so it stays. A different one is ours: remove it.
        if previous.as_deref() != Some(username) {
            if let Err(delete_err) = keyring_store::delete_password(username) {
                return Err(BantoError::Other(format!(
                    "{save_err}。さらに、キーリングに保存した資格情報の取り消しにも失敗しました（{delete_err}）。OS のキーリングから「{username}」の資格情報を手で削除してください"
                )));
            }
        }
        return Err(save_err);
    }
    // Switching the account: the previous username's credential is no
    // longer referenced. Best-effort like `autologin_disable_body` - the
    // settings are already saved, so a failure here is logged, not an error.
    // The lock is still held: releasing it first would let a concurrent
    // call switch back to `previous` and have this delete its fresh entry.
    if let Some(previous) = previous.as_deref().filter(|p| *p != username) {
        if let Err(err) = keyring_store::delete_password(previous) {
            eprintln!("banto: 前の自動ログインの資格情報のキーリング削除に失敗しました: {err}");
        }
    }
    drop(auth_config_guard);
    // Spec M14: the target `username` (never the password) is fine to
    // record - it identifies WHICH account autologin now applies to, no
    // different from `users_update`'s `role` detail.
    record_ok(
        &state.audit,
        &actor,
        "settings_change",
        "settings",
        None,
        Some(serde_json::json!({ "autologinEnabled": true, "username": username })),
    )
    .await;
    Ok(())
}

#[tauri::command]
async fn autologin_enable(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<(), BantoError> {
    autologin_enable_body(&state, &username, &password).await
}

/// Disable desktop autologin (spec M11): removes the stored credential from
/// the OS keyring (best-effort - a keyring delete failure is logged, not
/// propagated, so the setting is still turned off even if the OS store is,
/// say, already gone) and clears the setting.
/// Body of [`autologin_disable`] (spec M14 pattern) so its authz + audit
/// behavior is testable with a plain `&AppState`. No keyring is needed when
/// `autologin_username` is unset (the delete is skipped) and is best-effort
/// regardless.
async fn autologin_disable_body(state: &AppState) -> Result<(), BantoError> {
    let actor = require_role(state, Role::Admin, "settings").await?;

    // See `autologin_enable_body`: same row as `auth_config_apply`.
    let auth_config_guard = state.auth_config_lock.lock().await;
    let mut config = state.settings.auth_config().await?;
    if let Some(username) = config.autologin_username.take() {
        if let Err(err) = keyring_store::delete_password(&username) {
            eprintln!("banto: 自動ログインの資格情報のキーリング削除に失敗しました: {err}");
        }
    }
    config.autologin_enabled = false;
    state.settings.set_auth_config(&config).await?;
    drop(auth_config_guard);
    record_ok(
        &state.audit,
        &actor,
        "settings_change",
        "settings",
        None,
        Some(serde_json::json!({ "autologinEnabled": false })),
    )
    .await;
    Ok(())
}

#[tauri::command]
async fn autologin_disable(state: State<'_, AppState>) -> Result<(), BantoError> {
    autologin_disable_body(&state).await
}

/// One LAN access URL plus its QR code, rendered as an inline SVG string
/// (spec §11.4).
#[derive(Debug, Clone, Serialize)]
struct QrSvgEntry {
    url: String,
    svg: String,
}

/// The embedded LAN server's live state, behind `AppState::server` (Issue
/// #459). Everything `server_status` reports about the running server comes
/// from here - never from the saved `server.*` settings - and `server_apply`
/// changes it only while holding the lock, so a reader sees either the state
/// before an apply or the state after it, never a mix.
struct ServerSlot {
    /// `Some` while a listener is serving; `None` when LAN access is
    /// disabled, the launch-time bind failed, or an apply could not bring
    /// back the previous listener.
    live: Option<LiveServer>,
    /// Bumped every time `live` is replaced (a successful apply, or a failed
    /// one that stopped the old listener). Lets a caller that shows or copies
    /// the live values (e.g. a firewall guide) tell that they went stale and
    /// re-read them. Starts at 0 at launch; not persisted.
    generation: u64,
    /// What the launch-time auto-start had to do about a saved port that was
    /// in use ([`bind_saved_server_at_launch`]): `Some` until the next
    /// successful `server_apply`, reported by `server_status` so the frontend
    /// can tell the user (the text is built there, conventions §13).
    port_notice: Option<ServerPortNotice>,
    /// The last `server_apply` that failed after it had stopped the old
    /// listener, and what became of that listener. Cleared by a successful
    /// apply.
    apply_failure: Option<ServerApplyFailure>,
    /// Writes that listeners stopped by earlier applies had accepted and that
    /// were still running when the stop gave up waiting (Issue #793,
    /// ADR-0035). No listener is started for a new configuration while any
    /// of them runs.
    leftover_writes: LeftoverWrites,
    /// The room for new writes (ADR-0035 §7), shared by every listener this
    /// slot ever serves: writes a stopped listener left running still count
    /// against the listener that replaces it.
    write_budget: WriteBudget,
}

impl ServerSlot {
    fn new(live: Option<LiveServer>, port_notice: Option<ServerPortNotice>) -> Self {
        // The launch-time listener (if any) already has a budget: keep it.
        let write_budget = live
            .as_ref()
            .map(|live| live.server.write_budget())
            .unwrap_or_default();
        Self {
            live,
            generation: 0,
            port_notice,
            apply_failure: None,
            leftover_writes: LeftoverWrites::default(),
            write_budget,
        }
    }
}

/// A serving listener plus the bind address it was started from.
struct LiveServer {
    server: RunningServer,
    /// The bind address exactly as it was passed to the bind (e.g.
    /// `"0.0.0.0"`, `"[::1]"`), so a rollback re-binds the same thing. The
    /// status reports `server.local_addr()` instead - the address the
    /// listener actually has.
    bind: String,
}

impl LiveServer {
    fn new(server: RunningServer, bind: String) -> Self {
        Self { server, bind }
    }

    /// The address and port the listener is actually bound to.
    fn listener(&self) -> ServerListener {
        let addr = self.server.local_addr();
        ServerListener {
            bind: addr.ip().to_string(),
            port: addr.port(),
        }
    }
}

/// The bind address and port of the listener that is actually serving, from
/// its `local_addr` (Issue #459). Mirrors `serverAdmin.ts::ServerListener`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerListener {
    bind: String,
    port: u16,
}

/// A `server_apply` that failed after it had stopped the listener that was
/// running (Issue #459). Codes and values only - the frontend builds any text
/// (conventions §13). Mirrors `serverAdmin.ts::ServerApplyFailure`.
///
/// One case is not "nothing was saved" (Issue #793, ADR-0035):
/// `reason: WritesRemaining` with `previous: LeftClosed` is a NARROWING change
/// whose settings WERE saved; only the new listener was not started, because
/// writes of the stopped one are still running. Any other `reason` with
/// `previous: LeftClosed` is "closed, NOT saved": the narrowing change failed
/// (e.g. `SaveFailed`) while writes remained, so the previous listener was
/// not brought back either.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerApplyFailure {
    /// The settings the failed apply asked for (none of them were saved,
    /// except with `previous: LeftClosed` - see above).
    enabled: bool,
    bind: String,
    port: u16,
    reason: ServerApplyFailureReason,
    previous: PreviousServerOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ServerApplyFailureReason {
    /// The requested port was in use.
    PortInUse,
    /// The bind failed for another reason (address not available, ...).
    BindFailed,
    /// The new listener was bound but the settings could not be saved (a
    /// storage error, or the final auth/LAN re-validation refused them).
    SaveFailed,
    /// Writes accepted by the stopped listener (or by one stopped earlier)
    /// were still running after the wait, so no listener was started for the
    /// requested settings (Issue #793, ADR-0035).
    WritesRemaining,
}

/// What became of the listener that was running before a failed apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PreviousServerOutcome {
    /// Nothing was running before the apply.
    None,
    /// The previous listener was bound again on its old address and port.
    Restored,
    /// The previous listener could not be bound again: nothing is serving
    /// although the saved settings still say enabled.
    RestoreFailed,
    /// The previous listener was deliberately NOT brought back: the change
    /// narrows the exposure (server off, public viewing off, a narrower bind)
    /// and writes of the stopped listener remain, so the listener stays
    /// closed until the settings are applied again (Issue #793). Whether the
    /// settings were saved is told by `reason` (see [`ServerApplyFailure`]).
    LeftClosed,
}

/// `server_status`/`server_apply`'s shared response shape - mirrors
/// `src/lib/banto/serverAdmin.ts::ServerStatus` field-for-field.
///
/// Issue #459: `enabled`/`bind`/`port`/`viewer_public` are the SAVED settings
/// (what the next launch or the settings form starts from); `running`,
/// `live`, `urls` and `qr_svgs` describe the listener that is actually
/// serving. Both halves are read under the same `state.server` lock (all
/// `server.*` writes happen under it too), so they are one consistent
/// snapshot identified by `generation`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatusResult {
    enabled: bool,
    running: bool,
    bind: String,
    port: u16,
    /// 閲覧公開 (Issue #189): whether LAN clients may obtain a synthetic
    /// `viewer` session without logging in. Persisted alongside the other
    /// server settings and therefore reported (and applied) here, even though
    /// it only ever has an effect on the LAN surface, not in this window.
    /// It is read per request, so the saved value is also the live one.
    viewer_public: bool,
    /// The listener that is actually serving (`null` when nothing is).
    live: Option<ServerListener>,
    /// URLs (and their QR codes) for `live` - empty when nothing is serving.
    urls: Vec<String>,
    qr_svgs: Vec<QrSvgEntry>,
    /// [`ServerSlot::generation`] of this snapshot.
    generation: u64,
    /// What the launch-time auto-start did about a saved port that was in use
    /// (`null` when nothing happened, or after a successful `server_apply`).
    port_notice: Option<ServerPortNotice>,
    /// The last failed `server_apply` that stopped the old listener (`null`
    /// when there was none since the last successful apply).
    apply_failure: Option<ServerApplyFailure>,
    /// Issue #219: the absolute path of this desktop executable, for the
    /// settings screen's firewall information (`null` when the OS cannot
    /// tell, or the path is not valid UTF-8 and so cannot be shown or copied
    /// as is). Local information about this PC, so it travels only in this
    /// admin-gated response (`server_status`/`server_apply`) - there is no
    /// REST twin.
    executable_path: Option<String>,
    /// `std::env::consts::OS` of this desktop host (`"windows"`, `"macos"`,
    /// `"linux"`, ...): a code, not display text (conventions §13). The
    /// frontend shows the Windows firewall information only for `"windows"`.
    platform: &'static str,
    /// Issue #478: whether this build embeds the web UI that other devices
    /// get from the LAN listener (`admin_template_core::assets::UI_EMBEDDED`).
    /// When `false` the LAN page is a placeholder, so the settings screen
    /// shows no URL/QR/connection check.
    ui_embedded: bool,
    /// Issue #558: how many event streams (`GET /api/events`) are open on the
    /// live listener (0 when nothing is serving) - the header's "接続 n 台".
    /// One per browser tab or window, so the same device can count more than
    /// once. This window gets its events over IPC, never from the listener, so
    /// it is not counted (a browser opened on this PC is).
    sse_connections: usize,
}

/// [`ServerStatusResult::executable_path`]: `std::env::current_exe()` as a
/// UTF-8 string, or `None` when it cannot be read or is not UTF-8 (a lossy
/// conversion would show and copy a path that does not exist).
fn current_executable_path() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.into_os_string().into_string().ok())
}

/// What [`bind_saved_server_at_launch`] had to do because the SAVED port was
/// in use. Carries only codes and port numbers - the message is built by the
/// frontend from `messages/{en,ja}.json` (conventions §13), so this layer
/// holds no display text. Mirrors `serverAdmin.ts::ServerPortNotice`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ServerPortNotice {
    /// Started on `port` instead of `requested_port`. `saved`: whether
    /// `server.port` was updated to `port` (so the next launch uses it).
    #[serde(rename_all = "camelCase")]
    Fallback {
        requested_port: u16,
        port: u16,
        saved: bool,
    },
    /// `requested_port` was in use and no port up to `last_port` could be
    /// bound, so the server did not start. `all_in_use` is true when every
    /// candidate was in use, false when some failed for another reason (e.g.
    /// a port the OS reserves) - the text must not claim "all in use" then.
    #[serde(rename_all = "camelCase")]
    Exhausted {
        requested_port: u16,
        last_port: u16,
        all_in_use: bool,
    },
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

/// One status snapshot from the `saved` settings and the live `slot`. The
/// caller holds `state.server` (that is where `slot` comes from) and read
/// `saved` under it, so both describe the same moment (Issue #459).
fn build_status(saved: &ServerSettings, slot: &ServerSlot) -> ServerStatusResult {
    let live = slot.live.as_ref().map(LiveServer::listener);
    // Issue #216: scope the advertised URLs (and therefore the QR codes
    // below) to what the listener actually listens on - a loopback bind
    // must not advertise a LAN URL nobody outside this PC can reach. Issue
    // #459: from the live listener, never from the saved settings.
    let urls = live
        .as_ref()
        .map(|live| lan_urls_for_bind(&live.bind, live.port))
        .unwrap_or_default();
    let qr_svgs = urls
        .iter()
        .map(|url| QrSvgEntry {
            url: url.clone(),
            svg: qr_svg_for(url),
        })
        .collect();
    ServerStatusResult {
        enabled: saved.enabled,
        running: live.is_some(),
        bind: saved.bind.clone(),
        port: saved.port,
        viewer_public: saved.viewer_public,
        live,
        urls,
        qr_svgs,
        generation: slot.generation,
        port_notice: slot.port_notice.clone(),
        apply_failure: slot.apply_failure.clone(),
        executable_path: current_executable_path(),
        platform: std::env::consts::OS,
        ui_embedded: admin_template_core::assets::UI_EMBEDDED,
        sse_connections: slot
            .live
            .as_ref()
            .map_or(0, |live| live.server.sse_connections()),
    }
}

/// Build the full `/api/*` + static-asset router (spec §11.1) and start
/// serving on an already-[`bind`]-ed listener (infallible: the bind - the only
/// step that can fail - happened before, so callers can do work such as saving
/// settings between bind and serve; Issue #294 review). Shared by `setup()` (auto-start on launch if LAN access was
/// left enabled) and the `server_apply` command (spec §11.4's
/// 「保存して適用」button).
///
/// Deliberately never names the intermediate `axum::Router` type anywhere -
/// `axum` is not (and does not need to be) a direct dependency of this
/// crate purely to support this one function: Rust only requires a crate to
/// be listed in `[dependencies]` to *spell out* one of its types in source,
/// and the router value here only ever flows through an inferred `let`
/// binding on its way into `BoundServer::serve`.
// Keeps positional service params rather than taking a `Services` like the
// `api_router` it wraps (M-review 2026-08 M-13): its two call sites
// (`setup`/`server_apply`) construct these handles inline, so it assembles
// the `Services` for `api_router` locally in its body - threading a
// `Services` through this wrapper too would only add an assembly hop.
#[allow(clippy::too_many_arguments)]
async fn start_embedded_server(
    // [scaffold:items] begin
    items: ItemsService,
    // [scaffold:items] end
    resources: AppResources,
    users: UsersService,
    settings: SettingsService,
    audit: AuditLogService,
    backup: BackupService,
    attachments: AttachmentsService,
    system_info: SystemInfoService,
    metrics: Option<MetricsProbe>,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
    reach_check: ReachCheckState,
    generation: u64,
    bound: BoundServer,
) -> RunningServer {
    // `with_security_headers` (spec improvements §2.4) wraps LAST/outermost,
    // same as `banto-serve.rs`'s equivalent composition, so every response
    // this embedded server produces carries the baseline security headers.
    // The resources added by `pnpm banto add resource` (none in the template).
    let added_resources = resources_router(resources, audit.clone(), auth.clone());
    let services = Services {
        // [scaffold:items] begin
        items,
        // [scaffold:items] end
        users,
        settings,
        audit,
        backup,
        attachments,
        system_info,
        metrics,
    };
    // Issue #219 (`docs/design/lan-reach-check-design.md` §5.2): the one
    // unauthenticated reach-check route, bound to THIS listener's generation
    // and port. It is merged OUTSIDE `api_router` (whose CSRF layer covers
    // only the routes inside it), so it carries its own `X-Banto-Client`
    // check (`banto_server::reach_check`). `banto-serve` does not mount it
    // (no screen to issue tokens there).
    let port = bound.local_addr().port();
    let router = with_security_headers(
        api_router(services, auth, events)
            .merge(added_resources)
            .merge(reach_check_router(reach_check, generation, port))
            .merge(static_router::<FrontendAssets>()),
    );
    bound.serve(router)
}

/// `GET`-ish command: current persisted settings + live running state (spec
/// §11.4's status line). `admin`-only (spec M10: "サーバ制御系 = admin").
#[tauri::command]
async fn server_status(state: State<'_, AppState>) -> Result<ServerStatusResult, BantoError> {
    server_status_body(&state).await
}

/// Body of [`server_status`] over a plain `&AppState` (testable without a
/// Tauri `State`).
///
/// Issue #459: the lock is taken BEFORE the saved settings are read, and held
/// until the snapshot is built. Every `server.*` write happens under the same
/// lock (`server_apply`; the generic `settings_set` refuses the namespace;
/// the launch-time fallback runs before `AppState` exists), so the saved half
/// and the live half cannot come from different sides of an apply - and
/// neither can the four `server.*` keys `server_config` reads one by one.
async fn server_status_body(state: &AppState) -> Result<ServerStatusResult, BantoError> {
    require_role(state, Role::Admin, "settings").await?;
    let slot = state.server.lock().await;
    let saved = state.settings.server_config().await?;
    Ok(build_status(&saved, &slot))
}

/// `GET`-ish command (Issue #219, stage 1 / PR-B; spec §11.4): whether
/// Windows Defender Firewall has the rules the settings screen's
/// administrator commands create, read without elevation, and how they
/// compare with what those commands would create for the listener that is
/// serving now. `admin`-only like `server_status` (the response carries the
/// executable path); a read, so not audited; desktop-only - there is no REST
/// twin (the firewall is this PC's). The rule names come from this app's own
/// bundle identifier, never from the caller.
#[tauri::command]
async fn firewall_rule_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<firewall_status::FirewallRuleStatus, BantoError> {
    let identifier = app.config().identifier.clone();
    firewall_rule_status_body(&state, &identifier, firewall_status::probe).await
}

/// Body of [`firewall_rule_status`] with the read injected (`probe`), so the
/// gate and the snapshot are testable without Windows.
///
/// The comparison basis (live port, executable path) and its `generation`
/// come from one `state.server` snapshot, taken under the lock exactly like
/// `server_status`; the lock is released before the read, which may take
/// seconds, so an apply is never held up by it. The screen drops a result
/// whose `generation` is not the one it shows.
async fn firewall_rule_status_body(
    state: &AppState,
    identifier: &str,
    probe: fn(&firewall_status::RuleNames) -> Result<String, firewall_status::UnknownReason>,
) -> Result<firewall_status::FirewallRuleStatus, BantoError> {
    require_role(state, Role::Admin, "settings").await?;
    Ok(read_firewall_rule_status(state, identifier, probe).await)
}

/// The read of [`firewall_rule_status_body`] without its gate (also the
/// re-read `firewall_rule_change` ends with, ADR-0021 decision 11).
async fn read_firewall_rule_status(
    state: &AppState,
    identifier: &str,
    probe: fn(&firewall_status::RuleNames) -> Result<String, firewall_status::UnknownReason>,
) -> firewall_status::FirewallRuleStatus {
    let (generation, expected) = {
        let slot = state.server.lock().await;
        (
            slot.generation,
            firewall_status::FirewallExpectation {
                executable_path: current_executable_path(),
                port: slot.live.as_ref().map(|live| live.listener().port),
            },
        )
    };
    let outcome = match firewall_status::rule_names(identifier) {
        None => Err(firewall_status::UnknownReason::InvalidIdentifier),
        Some(names) => tokio::task::spawn_blocking(move || probe(&names))
            .await
            .unwrap_or(Err(firewall_status::UnknownReason::QueryFailed)),
    };
    firewall_status::evaluate(generation, expected, outcome)
}

/// Mutating, desktop-only command (Issue #219 stage 2, ADR-0021 E2): adds
/// (`allow`) or removes (`remove`) the one per-executable firewall rule by
/// starting the UAC-elevated helper next to this exe. `admin`-only, audited
/// as `firewall_change` (decision 12); no REST twin - the firewall is this
/// PC's (conventions §1's desktop-only exception, like `server_apply`).
/// `target` is what the confirmation screen showed (decision 13).
#[tauri::command]
async fn firewall_rule_change(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    operation: firewall_change::FirewallChangeOperation,
    target: firewall_change::FirewallChangeTarget,
) -> Result<firewall_change::FirewallChangeResult, BantoError> {
    let identifier = app.config().identifier.clone();
    firewall_rule_change_body(
        &state,
        &identifier,
        operation,
        &target,
        FirewallChangeDeps {
            check: firewall_change::check_before_elevation,
            launch: elevated_launch::run_elevated,
            probe: firewall_status::probe,
        },
    )
    .await
}

/// What [`firewall_rule_change_body`] calls out to, injected so the gate,
/// the comparisons and the audit are testable without Windows, UAC or a
/// real firewall.
struct FirewallChangeDeps {
    /// The pre-elevation placement check (decision 8): the helper to start,
    /// or a refusal code. Blocking.
    check: fn() -> Result<admin_template_fw_elev::placement::Placement, &'static str>,
    /// Starts the helper elevated and waits for its exit code. Blocking.
    launch: fn(&std::path::Path, &[&str]) -> Result<u32, elevated_launch::LaunchError>,
    /// Stage 1's read, for the re-read every result ends with.
    probe: fn(&firewall_status::RuleNames) -> Result<String, firewall_status::UnknownReason>,
}

/// Whether `target` is still what is there: this exe's path (as
/// `firewall_rule_status` reports it) and the server generation. The lock is
/// taken only for the comparison (decision 13: none is held while UAC waits).
async fn firewall_target_is_current(
    state: &AppState,
    target: &firewall_change::FirewallChangeTarget,
) -> bool {
    let generation = state.server.lock().await.generation;
    generation == target.generation && current_executable_path() == target.executable_path
}

/// Body of [`firewall_rule_change`] (ADR-0021 decisions 8, 11-13):
///
/// 1. `require_role(Admin)` first - nothing below runs for a lower role
///    (`denied` audited) or without a session (not audited).
/// 2. A guard against overlapping firewall changes in this process is
///    taken; if another is running, nothing starts and the answer is `busy`
///    (not audited, with the re-read). It is held to the final re-read.
/// 3. The pre-elevation placement check with the helper's own rule
///    ([`firewall_change::check_before_elevation`]), and the app identifier
///    against the helper's built-in one. A refusal starts nothing, shows no
///    UAC prompt, and is audited as `precondition` (decision 8).
/// 4. Just before starting, the confirmed `target` is compared with the
///    current one; a difference starts nothing and answers `targetChanged`
///    so the screen confirms again (not audited: nothing was attempted).
/// 5. The helper (the path the check accepted) is started and waited for
///    on a blocking thread, holding no lock.
/// 6. After it ended the target is compared again: a change makes the
///    result `stale`.
/// 7. The attempt is audited (`firewall_change`, `ok` only for done /
///    already), and every answer carries a fresh stage-1 read.
async fn firewall_rule_change_body(
    state: &AppState,
    identifier: &str,
    operation: firewall_change::FirewallChangeOperation,
    target: &firewall_change::FirewallChangeTarget,
    deps: FirewallChangeDeps,
) -> Result<firewall_change::FirewallChangeResult, BantoError> {
    use firewall_change::{Attempt, FirewallChangeResult};

    let actor = require_role(state, Role::Admin, "firewall").await?;
    let Some(_running) = firewall_change::RunningGuard::try_take(&state.firewall_change_running)
    else {
        let status = read_firewall_rule_status(state, identifier, deps.probe).await;
        return Ok(FirewallChangeResult::new(
            operation,
            Attempt::busy(),
            false,
            status,
        ));
    };
    let checked = if identifier != admin_template_fw_elev::IDENTIFIER {
        Err(firewall_change::REFUSAL_IDENTIFIER_MISMATCH)
    } else {
        tokio::task::spawn_blocking(deps.check)
            .await
            .unwrap_or(Err(firewall_change::REFUSAL_UNVERIFIABLE))
    };
    let (attempt, stale) = match checked {
        Err(code) => (Attempt::refused(code), false),
        Ok(placement) => {
            if !firewall_target_is_current(state, target).await {
                let status = read_firewall_rule_status(state, identifier, deps.probe).await;
                return Ok(FirewallChangeResult::new(
                    operation,
                    Attempt::target_changed(),
                    false,
                    status,
                ));
            }
            let helper = PathBuf::from(placement.helper_exe);
            let arg = operation.helper_operation().arg();
            let launch = deps.launch;
            let launched = tokio::task::spawn_blocking(move || launch(&helper, &[arg]))
                .await
                .ok();
            let stale = !firewall_target_is_current(state, target).await;
            (Attempt::launched(launched), stale)
        }
    };
    let entity_id = firewall_status::rule_names(identifier).map(|names| names.program);
    record_as(
        &state.audit,
        Some(&actor.actor),
        "tauri",
        "firewall_change",
        "firewall",
        entity_id.as_deref(),
        Some(attempt.audit_detail(operation, stale)),
        attempt.outcome.audit_result(),
    )
    .await;
    let status = read_firewall_rule_status(state, identifier, deps.probe).await;
    Ok(FirewallChangeResult::new(operation, attempt, stale, status))
}

/// Why `reach_check_issue` issued nothing (Issue #219 stage 1 / PR-C2,
/// lan-reach-check-design §3.5 / §5.1). Codes only - the screen builds the
/// text (conventions §13). Mirrors `serverAdmin.ts::ReachCheckRefusal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ReachCheckRefusal {
    /// Nothing is serving.
    NotListening,
    /// The listener's bind gives no URL at all (IPv6, unparseable).
    UnsupportedBind,
    /// The listener's URLs are all loopback (no other device can reach it).
    LoopbackOnly,
    /// `host` is not one of the live listener's non-loopback URL hosts.
    UnknownHost,
    /// The listener changed between the snapshot and the issuance.
    StaleGeneration,
    /// This PC's own addresses could not be enumerated (design §3.6).
    LocalAddressesUnavailable,
}

/// `reach_check_issue`'s response (lan-reach-check-design §5.1). `issued`
/// carries the one URL holding the token (after `#`, the fragment) and its QR
/// code; `refused` carries a code. Both name the server `generation` they were
/// judged against, so the screen can drop an answer for a listener it no
/// longer shows. Mirrors `serverAdmin.ts::ReachCheckIssueResult`.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum ReachCheckIssueResult {
    #[serde(rename_all = "camelCase")]
    Issued {
        generation: u64,
        issue_id: u64,
        /// `http://<host>:<port>/reach#t=<token>` - the token only in the
        /// fragment, so it never reaches a server log or a `Referer`.
        url: String,
        qr_svg: String,
        expires_in_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Refused {
        generation: u64,
        reason: ReachCheckRefusal,
    },
}

/// `Debug` hides the URL and the QR code: both hold the token (design §3.9 -
/// the token never reaches a log).
impl std::fmt::Debug for ReachCheckIssueResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Issued {
                generation,
                issue_id,
                expires_in_ms,
                ..
            } => f
                .debug_struct("Issued")
                .field("generation", generation)
                .field("issue_id", issue_id)
                .field("url", &"<redacted>")
                .field("qr_svg", &"<redacted>")
                .field("expires_in_ms", expires_in_ms)
                .finish(),
            Self::Refused { generation, reason } => f
                .debug_struct("Refused")
                .field("generation", generation)
                .field("reason", reason)
                .finish(),
        }
    }
}

/// The shape of [`lan_addrs_for_bind`] (the live listener's reachable
/// addresses), injectable in [`reach_check_issue_body`].
type LanAddrsFor = fn(&str) -> Vec<std::net::Ipv4Addr>;

/// Desktop-only command (Issue #219 stage 1 / PR-C2, lan-reach-check-design
/// §5.1): issue a one-time reach-check token for `host` - one of the live
/// listener's non-loopback URL hosts (`server_status`'s `urls`) - and return
/// the URL (token in the fragment) and its QR code for another device to
/// open. `admin`-only; a refused caller never touches the store (no token is
/// made). Not audited (design D8: memory only, nothing persistent changes),
/// and there is no REST twin - only this PC's administrator issues (classified
/// `DESKTOP_ONLY`, not read, because it makes a token).
#[tauri::command]
async fn reach_check_issue(
    state: State<'_, AppState>,
    host: String,
) -> Result<ReachCheckIssueResult, BantoError> {
    reach_check_issue_body(&state, &host, lan_addrs_for_bind, ReachCheckState::issue).await
}

/// Body of [`reach_check_issue`] with the address candidates (`lan_addrs`) and the
/// issuance (`issue`, which enumerates this PC's addresses) injected, so the
/// tests can use a LAN address and a peer that are not this machine's.
///
/// Design §3.5: the snapshot (`generation`, `live`) is read and the token is
/// issued under one `state.server` lock - the lock `server_apply` bumps the
/// generation and revokes under - so an issuance cannot land after a
/// revocation (the store also refuses a stale generation). The QR code is
/// rendered after the lock is released.
async fn reach_check_issue_body(
    state: &AppState,
    host: &str,
    lan_addrs: LanAddrsFor,
    issue: fn(&ReachCheckState, u64, ReachTarget) -> Result<ReachIssue, ReachIssueError>,
) -> Result<ReachCheckIssueResult, BantoError> {
    require_role(state, Role::Admin, "settings").await?;
    let (generation, port, issued) = {
        let slot = state.server.lock().await;
        let generation = slot.generation;
        let refused = |reason| Ok(ReachCheckIssueResult::Refused { generation, reason });
        let Some(live) = slot.live.as_ref().map(LiveServer::listener) else {
            return refused(ReachCheckRefusal::NotListening);
        };
        let addrs = lan_addrs(&live.bind);
        if addrs.is_empty() {
            return refused(ReachCheckRefusal::UnsupportedBind);
        }
        let candidates: Vec<String> = addrs
            .iter()
            .filter(|ip| !ip.is_loopback())
            .map(ToString::to_string)
            .collect();
        if candidates.is_empty() {
            return refused(ReachCheckRefusal::LoopbackOnly);
        }
        if !candidates.iter().any(|candidate| candidate == host) {
            return refused(ReachCheckRefusal::UnknownHost);
        }
        let target = ReachTarget {
            host: host.to_string(),
            port: live.port,
        };
        match issue(&state.reach_check, generation, target) {
            Ok(issued) => (generation, live.port, issued),
            Err(ReachIssueError::StaleGeneration) => {
                return refused(ReachCheckRefusal::StaleGeneration);
            }
            Err(ReachIssueError::LocalAddressesUnavailable) => {
                return refused(ReachCheckRefusal::LocalAddressesUnavailable);
            }
        }
    };
    let url = format!("http://{host}:{port}/reach#t={}", issued.token);
    let qr_svg = qr_svg_for(&url);
    Ok(ReachCheckIssueResult::Issued {
        generation,
        issue_id: issued.issue_id,
        url,
        qr_svg,
        expires_in_ms: issued.expires_in_ms,
    })
}

/// `GET`-ish command (Issue #219 stage 1 / PR-C2, lan-reach-check-design
/// §5.1): the reach check of the current listener generation - the last
/// issuance and its outcome, whether this PC itself opened the URL, and the
/// reaches from other devices (codes and values, no token). `admin`-only like
/// `server_status`; a read, so not audited; no REST twin.
#[tauri::command]
async fn reach_check_status(state: State<'_, AppState>) -> Result<ReachCheckStatus, BantoError> {
    reach_check_status_body(&state).await
}

/// Body of [`reach_check_status`] over a plain `&AppState`.
async fn reach_check_status_body(state: &AppState) -> Result<ReachCheckStatus, BantoError> {
    require_role(state, Role::Admin, "settings").await?;
    Ok(state.reach_check.status())
}

/// `GET`-ish command (M-review 2026-08 §2.4): admin-only system diagnostics
/// for the settings「システム情報」card. Symmetric with `GET /api/system/info`
/// (conventions §1) - both call `SystemInfoService::probe` and fold in the
/// same wiring-layer fields, so the wire shape ([`SystemInfo`]) is identical.
/// Read-only, so nothing is audited. `active_sessions` reports the embedded
/// LAN server's bearer-token count (`rest_auth`, the same space the REST route
/// counts), not the single desktop webview session; `uptime_secs` is this
/// desktop process's uptime.
#[tauri::command]
async fn system_info(state: State<'_, AppState>) -> Result<SystemInfo, BantoError> {
    require_role(&state, Role::Admin, "system").await?;
    let probe = state.system_info.probe().await?;

    // Symmetric with the REST handler (`banto_server::routes::system_info`,
    // ADR-0013): `sample()` is synchronous, blocking I/O, so it runs via
    // `spawn_blocking` rather than directly on this async command's thread,
    // even though Tauri commands run on tokio the same as the REST server.
    let metrics = match state.metrics.clone() {
        Some(probe_fn) => tokio::task::spawn_blocking(move || probe_fn())
            .await
            .map_err(|err| BantoError::Other(err.to_string()))?,
        None => None,
    };

    Ok(SystemInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        db_dialect: probe.dialect,
        db_latency_ms: probe.db_latency_ms,
        migration_version: probe.migration_version,
        uptime_secs: state.started_at.elapsed().as_secs(),
        active_sessions: state.rest_auth.session_count(),
        attachment_bytes: probe.attachment_bytes,
        metrics,
    })
}

/// Persist new settings, stop whatever is currently running, and start a
/// fresh instance if `enabled` (spec §11.4's 「保存して適用」button).
/// Stop-then-maybe-start unconditionally (rather than diffing old vs. new
/// config) keeps this simple to reason about, at the cost of a
/// no-op restart when the caller "changes" settings to the same values -
/// an acceptable trade for a settings-screen action a user triggers
/// explicitly and infrequently.
///
/// `viewer_public` (Issue #189, `docs/design/viewer-public-plan.md` §3.1-4) is
/// persisted like the other three fields and otherwise ignored here: whether
/// LAN clients may mint a synthetic `viewer` session is decided per request
/// by `POST /api/auth/grant/publicViewer`, whose condition re-reads the setting, so a
/// restart is not needed for it to take effect and this command does not have
/// to treat it as part of the listener's configuration. The
/// auth-disabled/LAN exclusivity it relaxes is validated in the service layer
/// (`SettingsService::set_server_config`, conventions §2), so an illegal
/// combination is refused (`validate_server_config`) before anything is
/// stopped or started.
///
/// Order and failure contract (Issues #287, #294 review): validate -> stop the
/// old server -> `bind` the new listener (a port in use surfaces here, nothing
/// saved yet) -> save the settings (one transaction, `set_many`) -> serve. The
/// new listener answers no request until the save is done, so nothing can
/// observe the new listener together with the old stored settings (e.g. mint a
/// public viewer token under a stale `viewer_public`). Serving a bound listener
/// cannot fail, so there is no state in which the settings are saved but the
/// server did not start. If the bind or the save fails, the listener is
/// dropped, nothing is saved, the previously running listener is bound again
/// on the address and port it actually had (Issue #459: from the live
/// listener, not from the saved settings), and the command returns the error
/// - so the saved values and the live server never silently diverge.
/// `enabled = false` has no new listener (stop -> save). The attempt is
/// audited as `settings_change` / `result: "failed"` (`detail.saved: false`);
/// a success records the usual `ok` entry. Callers should re-read
/// `server_status` after an error (the frontend does): it reports the failure
/// (`applyFailure`: port in use / other bind failure / save failure, and
/// whether the previous listener was restored) until the next successful
/// apply.
///
/// Issue #459: `state.server` is held for the WHOLE apply, including the
/// save, and the slot (listener, generation, notices) is replaced as a whole
/// before the lock is released; `server_status` reads the saved settings
/// under the same lock. A status read therefore sees the complete state
/// before or after an apply, never the old settings with the new listener.
///
/// Lock order (#294 review): `state.server` -> `auth_config_lock` (see
/// `AppState::auth_config_lock`). The final validation + save + token
/// revocation run under `auth_config_lock` ([`save_server_config_locked`]),
/// so they are serialized with `auth_config_apply` and the other `auth.*`
/// writers; the lock is NOT held while the old server stops or while binding.
///
/// When the saved `viewer_public` is OFF after a successful apply, every
/// outstanding public viewer token is revoked (`rest_auth` is shared across
/// restarts, so they would otherwise outlive the setting); real login
/// sessions are untouched.
#[tauri::command]
async fn server_apply(
    state: State<'_, AppState>,
    enabled: bool,
    bind: String,
    port: u16,
    viewer_public: bool,
) -> Result<ServerStatusResult, BantoError> {
    server_apply_body(&state, enabled, bind, port, viewer_public).await
}

/// Body of [`server_apply`] over a plain `&AppState` (spec M14 pattern), so
/// the whole apply - authorization, the bind -> save -> serve order, the
/// rollback and the audit - is testable without a Tauri `State`.
async fn server_apply_body(
    state: &AppState,
    enabled: bool,
    bind: String,
    port: u16,
    viewer_public: bool,
) -> Result<ServerStatusResult, BantoError> {
    let actor = require_role(state, Role::Admin, "settings").await?;
    let config = ServerSettings {
        enabled,
        bind,
        port,
        viewer_public,
    };

    // Held for the WHOLE apply (save included): concurrent applies are
    // serialized, and `server_status` cannot observe the
    // stopped-but-not-yet-restarted gap or the new settings with the old
    // listener (Issue #459).
    let mut slot = state.server.lock().await;

    // Refuse an illegal auth/LAN combination BEFORE anything is stopped.
    state.settings.validate_server_config(&config).await?;
    // What the listener that is about to stop was serving under (閲覧公開 is
    // read from the saved settings per request) - for the direction of the
    // change, should writes remain after the stop (Issue #793).
    let saved_before = state.settings.server_config().await?;

    // From here on the live state changes (Issue #459: a new generation),
    // whatever the outcome. Bumped before the first await that changes
    // anything, so even an apply abandoned part-way leaves a new generation.
    slot.generation += 1;
    // Issue #219 (lan-reach-check-design §3.5): the reach-check store follows
    // the listener generation under this same lock - the issued token and the
    // recorded results of the old listener are dropped whatever the outcome.
    // `generation` (below) is also what the new listener's router gets, on
    // success and when the previous listener is restored after a failure, so
    // a token issued afterwards matches the router that is serving.
    state.reach_check.begin_generation(slot.generation);
    // The rollback below restores the listener that is actually running - its
    // own bind address and port (Issue #459) - not the saved settings, which
    // may differ (e.g. a launch-time port fallback whose save failed).
    let stop_started = std::time::Instant::now();
    let previous = match slot.live.take() {
        Some(live) => {
            let previous = ServerConfig {
                bind: live.bind.clone(),
                port: live.server.local_addr().port(),
            };
            // Issue #793 / ADR-0035: the stop refuses new writes, waits for
            // the ones the listener accepted, and says so when some are still
            // running. They cannot be cancelled, so they are kept track of.
            let stopped = live.server.stop_waiting_writes_for(WRITES_STOP_WAIT).await;
            if let Some(remaining) = stopped.remaining() {
                slot.leftover_writes.add(remaining);
            }
            Some(previous)
        }
        None => None,
    };
    // Writes left behind by an EARLIER apply get the rest of the same wait
    // (all of it when nothing had to be stopped just now).
    let writes_done = slot
        .leftover_writes
        .wait(WRITES_STOP_WAIT.saturating_sub(stop_started.elapsed()))
        .await;
    let remaining_writes = (!writes_done).then(|| slot.leftover_writes.audit_detail());
    // With writes still running, no listener may start under the requested
    // settings: such a write could change state after the new configuration
    // took effect. Which way out is safe depends on the direction:
    // - the server is being turned off: nothing starts anyway - go on (save,
    //   stay closed), and put the remaining writes in the audit row;
    // - widening or equal: fail the switch, save nothing, bring the previous
    //   listener back (the rollback below) - the writes finish under the
    //   configuration that accepted them;
    // - narrowing: the previous listener must NOT come back (it would leave
    //   open what was just closed). Save, stay closed, ask to apply again.
    //
    // `may_restore` holds for EVERY failure below, not only the refusal: with
    // writes still running, a narrowing change (turning the server off
    // included) never brings the previous listener back - also when it is
    // the SAVE of the narrower settings that fails (review of PR #829).
    // Without remaining writes a failed apply restores as it always did.
    let may_restore = writes_done || {
        let previous_exposure = match &previous {
            Some(previous) => ServerExposure {
                listening: true,
                bind: previous.bind.clone(),
                viewer_public: saved_before.viewer_public,
            },
            None => ServerExposure::closed(),
        };
        let requested_exposure = if config.enabled {
            ServerExposure {
                listening: true,
                bind: config.bind.clone(),
                viewer_public: config.viewer_public,
            }
        } else {
            ServerExposure::closed()
        };
        restoring_previous_stays_within(&previous_exposure, &requested_exposure)
    };
    let writes_block = if writes_done || !config.enabled {
        None
    } else if may_restore {
        Some(WritesBlock::RefuseAndRestore)
    } else {
        Some(WritesBlock::SaveAndStayClosed)
    };

    // Serving on an already-bound listener cannot fail (the bind is the only
    // fallible step), so everything fallible happens BEFORE the listener is
    // reachable by a request.
    let generation = slot.generation;
    // Every listener of this slot counts its writes against the same budget
    // (ADR-0035 §7) - the new one, and the previous one when it is restored.
    let write_budget = &slot.write_budget.clone();
    let launch = |bound: BoundServer| {
        let bound = bound.with_write_budget(write_budget.clone());
        async move {
            start_embedded_server(
                // [scaffold:items] begin
                state.items.clone(),
                // [scaffold:items] end
                state.resources.clone(),
                state.users.clone(),
                state.settings.clone(),
                state.audit.clone(),
                state.backup.clone(),
                state.attachments.clone(),
                state.system_info.clone(),
                state.metrics.clone(),
                state.rest_auth.clone(),
                state.events.clone(),
                state.reach_check.clone(),
                generation,
                bound,
            )
            .await
        }
    };

    // Issue #287 / #294 review: bind -> save -> serve. The new settings are
    // saved only AFTER the new listener is bound (so a port in use fails
    // here, before anything is stored), and the listener only starts
    // answering requests AFTER the save. Without the last part, a request
    // (e.g. `POST /api/auth/grant/publicViewer`, which reads the SAVED
    // `viewer_public`) could hit the new listener while the old values were
    // still stored. (Saving first - the oldest order - left the new values
    // stored while the old server was already gone whenever the bind failed.)
    let outcome: Result<Option<LiveServer>, (ServerApplyFailureReason, BantoError)> = async {
        match writes_block {
            None => {}
            Some(WritesBlock::RefuseAndRestore) => {
                return Err((
                    ServerApplyFailureReason::WritesRemaining,
                    BantoError::Other(
                        "処理中の書き込みが残っているため、設定を切り替えられませんでした。\
                         設定は変更していません。少し待ってから、もう一度適用してください。"
                            .to_string(),
                    ),
                ));
            }
            Some(WritesBlock::SaveAndStayClosed) => {
                save_server_config_locked(state, &config)
                    .await
                    .map_err(|err| (ServerApplyFailureReason::SaveFailed, err))?;
                return Ok(None);
            }
        }
        let bound = if config.enabled {
            // No fallback port here (an explicit choice is never silently
            // changed), but a port in use is told apart for the status.
            let bound = bind_without_fallback(ServerConfig {
                bind: config.bind.clone(),
                port: config.port,
            })
            .await
            .map_err(|err| match err {
                PortFallbackError::Exhausted { error, .. } => {
                    (ServerApplyFailureReason::PortInUse, error)
                }
                PortFallbackError::Failed(error) => (ServerApplyFailureReason::BindFailed, error),
            })?;
            Some(bound)
        } else {
            None
        };
        // On error `bound` is dropped here, releasing the port.
        save_server_config_locked(state, &config)
            .await
            .map_err(|err| (ServerApplyFailureReason::SaveFailed, err))?;
        Ok(match bound {
            Some(bound) => Some(LiveServer::new(launch(bound).await, config.bind.clone())),
            None => None,
        })
    }
    .await;

    match outcome {
        Ok(started) => {
            // Saved, but no listener although the settings say enabled: the
            // narrowing change with writes still running (see above).
            let left_closed = config.enabled && started.is_none();
            slot.live = started;
            // The user's own settings now apply; a launch-time port notice
            // or an earlier failure no longer describes the live server.
            slot.port_notice = None;
            slot.apply_failure = left_closed.then(|| ServerApplyFailure {
                enabled: config.enabled,
                bind: config.bind.clone(),
                port: config.port,
                reason: ServerApplyFailureReason::WritesRemaining,
                previous: PreviousServerOutcome::LeftClosed,
            });
            let mut detail = serde_json::json!({
                "serverEnabled": config.enabled,
                "bind": config.bind,
                "port": config.port,
                "viewerPublic": config.viewer_public,
            });
            // Issue #793: writes of the stopped listener that were still
            // running when the settings were saved stay on record (how many,
            // and which as far as known).
            if let Some(remaining) = &remaining_writes {
                detail["remainingWrites"] = remaining.clone();
            }
            if left_closed {
                detail["listening"] = serde_json::json!(false);
            }
            record_ok(
                &state.audit,
                &actor,
                "settings_change",
                "settings",
                None,
                Some(detail),
            )
            .await;
            if left_closed {
                return Err(BantoError::Other(
                    "設定を保存し、サーバーを停止しました。処理中の書き込みが残っているため、\
                     新しい設定ではまだ起動していません。少し待ってから、もう一度適用してください。"
                        .to_string(),
                ));
            }
            // `config` is what was just saved, under this same lock.
            Ok(build_status(&config, &slot))
        }
        Err((reason, err)) => {
            // Nothing was saved. Bring back the listener that was running, on
            // the address and port it had - unless that would reopen what a
            // narrowing change was closing while writes remain (`may_restore`
            // above): then it stays closed, and the result says "closed, not
            // saved" (`reason` as it is, `previous: LeftClosed`).
            let outcome = match previous {
                None => PreviousServerOutcome::None,
                Some(_) if !may_restore => PreviousServerOutcome::LeftClosed,
                Some(previous) => {
                    let bind = previous.bind.clone();
                    match bind_listener(previous).await {
                        Ok(bound) => {
                            slot.live = Some(LiveServer::new(launch(bound).await, bind));
                            PreviousServerOutcome::Restored
                        }
                        Err(restore_err) => {
                            eprintln!(
                                "banto: LAN設定の適用に失敗し、旧設定でのサーバー再起動にも失敗しました: {restore_err}"
                            );
                            PreviousServerOutcome::RestoreFailed
                        }
                    }
                }
            };
            let left_closed = outcome == PreviousServerOutcome::LeftClosed;
            let restored = !left_closed && outcome != PreviousServerOutcome::RestoreFailed;
            let err = if left_closed {
                // The user sees this text: the settings are NOT the narrower
                // ones, and nothing is listening.
                BantoError::Other(format!(
                    "設定を保存できませんでした（{err}）。処理中の書き込みが残っているため、\
                     前の設定のサーバーは起動し直していません（停止したままです）。\
                     少し待ってから、もう一度適用してください。"
                ))
            } else {
                err
            };
            slot.apply_failure = Some(ServerApplyFailure {
                enabled: config.enabled,
                bind: config.bind.clone(),
                port: config.port,
                reason,
                previous: outcome,
            });
            // The failed attempt is audited too (conventions §1: an applied
            // change and a refused/failed one both leave a record), with the
            // same `resource`/`action` as the success entry.
            let mut detail = serde_json::json!({
                "serverEnabled": config.enabled,
                "bind": config.bind,
                "port": config.port,
                "viewerPublic": config.viewer_public,
                "saved": false,
                "restoredPrevious": restored,
                "error": err.to_string(),
            });
            if let Some(remaining) = &remaining_writes {
                detail["remainingWrites"] = remaining.clone();
            }
            if left_closed {
                detail["listening"] = serde_json::json!(false);
            }
            record_as(
                &state.audit,
                Some(&actor.actor),
                "tauri",
                "settings_change",
                "settings",
                None,
                Some(detail),
                "failed",
            )
            .await;
            Err(err)
        }
    }
}

/// What `server_apply` does when writes of a stopped listener are still
/// running and the requested settings need a listener (Issue #793, ADR-0035).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WritesBlock {
    /// Widening or equal change: fail, save nothing, restore the previous
    /// listener.
    RefuseAndRestore,
    /// Narrowing change: save, leave the listener closed.
    SaveAndStayClosed,
}

/// How long `server_apply` waits for the writes of the listener it stops
/// (ADR-0035). Short under test, where a write is held on purpose.
#[cfg(not(test))]
const WRITES_STOP_WAIT: std::time::Duration = banto_server::DETACHED_WRITES_STOP_TIMEOUT;
#[cfg(test)]
const WRITES_STOP_WAIT: std::time::Duration = std::time::Duration::from_millis(400);

/// Re-validate (inside `set_server_config`, which re-reads `auth.disabled`),
/// save the `server.*` settings and revoke public viewer tokens, all under
/// `auth_config_lock` so no `auth.*` write can interleave between the check
/// and the save (#294 review). Caller holds `state.server` (order: server ->
/// auth_config_lock).
async fn save_server_config_locked(
    state: &AppState,
    config: &ServerSettings,
) -> Result<(), BantoError> {
    let _auth_config = state.auth_config_lock.lock().await;
    state.settings.set_server_config(config).await?;
    if !config.viewer_public {
        // 閲覧公開 OFF: viewer-public grant tokens minted earlier (rest_auth
        // outlives server restarts) must not keep working. Order matters
        // (ADR-0017 §2): the closed condition is persisted above FIRST, then
        // the kind is revoked - an issuance that judged `true` before the
        // save is refused by the generation this advances.
        state
            .rest_auth
            .revoke_grant_tokens(&GrantKind::public_viewer());
    }
    Ok(())
}

/// Bind the SAVED server settings when the app launches (`setup()`'s
/// auto-start), stepping to a neighbouring port when the saved one is in use
/// (spec §11.4「ポート競合時の自動フォールバックと再表示」).
///
/// Launch only: `server_apply` keeps the plain bind, so a port the user has
/// just typed in is never silently changed (an in-use port is an error there).
/// Here the user did not ask for anything right now, and a server on the next
/// free port beats no server at all.
///
/// - The saved port is in use (`AddrInUse`, and only then): the ports right
///   behind it are tried in order (`banto_server::PORT_FALLBACK_SPAN`, never
///   past 65535; never port 0 or a random port - the range follows the saved
///   port, so it is not kept out of the OS's ephemeral range). The
///   bind address is never changed.
/// - Another port was chosen: `server.port` is saved as that port (bind ->
///   save -> serve, the same order as `server_apply`, Issue #294 review - the
///   listener answers nothing until the caller serves it), so the next launch
///   starts on it and other devices' bookmarks / QR codes keep working instead
///   of the port changing on every launch. A failed save does NOT stop the
///   server: it is logged, audited as `failed`, and reported (`saved: false`)
///   so the user can save a port from the settings screen.
/// - The change is audited like a settings change made by the system itself:
///   `settings_change` / `settings`, no actor (nobody is logged in yet - the
///   same shape as the startup `restore_applied` entry), `origin: "tauri"`,
///   `detail.reason: "portInUse"`.
/// - No candidate could be bound: no server, as before, and an `Exhausted`
///   notice saying the saved port was in use (`all_in_use` tells whether every
///   candidate was in use too, or some failed for another reason). Any other bind failure (permission,
///   address not available): no server, no notice, logged as before.
///
/// Called before `AppState` exists, while nothing else can write the
/// settings, so it does not take `auth_config_lock`.
async fn bind_saved_server_at_launch(
    settings: &SettingsService,
    audit: &AuditLogService,
    saved: &ServerSettings,
) -> (Option<BoundServer>, Option<ServerPortNotice>) {
    let bound = match bind_with_port_fallback(ServerConfig {
        bind: saved.bind.clone(),
        port: saved.port,
    })
    .await
    {
        Ok(bound) => bound,
        Err(PortFallbackError::Exhausted {
            requested,
            last_tried,
            error,
            unavailable,
        }) => {
            eprintln!(
                "banto: 起動時のLANアクセス開始に失敗しました（保存されたポート {requested} が使用中で、{last_tried} までに使えるポートがありませんでした）: {error}"
            );
            for (port, err) in &unavailable {
                eprintln!("banto: ポート {port} は使用中以外の理由で使えませんでした: {err}");
            }
            return (
                None,
                Some(ServerPortNotice::Exhausted {
                    requested_port: requested,
                    last_port: last_tried,
                    all_in_use: unavailable.is_empty(),
                }),
            );
        }
        Err(PortFallbackError::Failed(err)) => {
            // Non-fatal: the desktop app itself works fine with no LAN
            // access. The settings screen's `server_status` reports
            // `running: false` and the user can pick another port there.
            eprintln!("banto: 起動時のLANアクセス開始に失敗しました: {err}");
            return (None, None);
        }
    };

    let chosen = bound.local_addr().port();
    if chosen == saved.port {
        return (Some(bound), None);
    }

    let updated = ServerSettings {
        port: chosen,
        ..saved.clone()
    };
    let save_result = settings.set_server_config(&updated).await;
    let saved_ok = save_result.is_ok();
    let mut detail = serde_json::json!({
        "serverEnabled": updated.enabled,
        "bind": updated.bind,
        "previousPort": saved.port,
        "port": chosen,
        "viewerPublic": updated.viewer_public,
        "reason": "portInUse",
        "saved": saved_ok,
    });
    if let Err(err) = &save_result {
        eprintln!(
            "banto: 保存されたポート {} が使用中のため {chosen} で起動しましたが、新しいポートの保存に失敗しました: {err}",
            saved.port
        );
        detail["error"] = serde_json::Value::String(err.to_string());
    } else {
        eprintln!(
            "banto: 保存されたポート {} が使用中のため {chosen} で起動し、設定を更新しました",
            saved.port
        );
    }
    record_as(
        audit,
        None,
        "tauri",
        "settings_change",
        "settings",
        None,
        Some(detail),
        if saved_ok { "ok" } else { "failed" },
    )
    .await;
    (
        Some(bound),
        Some(ServerPortNotice::Fallback {
            requested_port: saved.port,
            port: chosen,
            saved: saved_ok,
        }),
    )
}

/// `admin`-only, symmetric with `settings_set` below: the generic key/value
/// settings store holds privileged config (embedded-server enable/bind/port,
/// `auth.disabled`/`auth.disabled_role`, `auth.autologin.username`, audit
/// retention), so reading an
/// arbitrary key is as privileged as writing one. Without this guard an
/// unauthenticated webview (the login screen is a real webview whose console
/// can `invoke`) could read any of those. UI settings for the current user
/// go through `ui_settings_get` (Viewer-gated, scoped to the caller's own
/// namespace) instead; this raw command is not called by the frontend.
#[tauri::command]
async fn settings_get(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, BantoError> {
    require_role(&state, Role::Admin, "settings").await?;
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
    settings_set_body(&state, &actor, key, value).await
}

/// The login screen may read this one public key before authentication.
#[tauri::command]
async fn login_notice_get(state: State<'_, AppState>) -> Result<String, BantoError> {
    state.settings.login_notice().await
}

/// Admin-only counterpart of REST PUT /api/login-notice. Audit the key only.
#[tauri::command]
async fn login_notice_set(
    state: State<'_, AppState>,
    notice: String,
) -> Result<String, BantoError> {
    login_notice_set_body(&state, &notice).await
}

async fn login_notice_set_body(state: &AppState, notice: &str) -> Result<String, BantoError> {
    let actor = require_role(state, Role::Admin, "settings").await?;
    let saved = state.settings.set_login_notice(notice).await?;
    record_ok(
        &state.audit,
        &actor,
        "settings_change",
        "settings",
        None,
        Some(serde_json::json!({ "key": "login.notice" })),
    )
    .await;
    Ok(saved)
}

/// Body of [`settings_set`]. Freshness audit of #266 (P2-2, S-103): keys in
/// the `auth.` namespace are refused - they are written only by
/// [`auth_config_apply`] (which re-binds the session under
/// `auth_config_lock`, keeping `auth.disabled == true <=> AuthDisabledLocal`)
/// and the `autologin_*` commands. A raw write would bypass both.
///
/// Likewise the `server.` namespace (Issue #459): it is written only by
/// [`server_apply`] (bind -> save -> serve under `state.server`) and the
/// launch-time port fallback. A raw write would change the saved settings
/// without touching the listener, outside the server lock. The refusal sits
/// here at the IPC entry, not in `SettingsService::set`, because the service's
/// own callers (`set_server_config`, first-boot seeding) must keep writing.
/// Like the `auth.` refusal it is a bad request, not a role denial, so it is
/// not audited (conventions §1: `denied` is recorded only for a role that is
/// too low).
async fn settings_set_body(
    state: &AppState,
    actor: &Caller,
    key: String,
    value: String,
) -> Result<(), BantoError> {
    if SettingsService::is_auth_key(&key) {
        return Err(BantoError::BadRequest(format!(
            "設定 {key} はこのコマンドでは変更できません。認証モードは auth_config_apply（自動ログインは autologin_enable/autologin_disable）で変更してください"
        )));
    }
    if SettingsService::is_server_key(&key) {
        return Err(BantoError::BadRequest(format!(
            "設定 {key} はこのコマンドでは変更できません。LANアクセスの設定は server_apply で変更してください"
        )));
    }
    if key == "login.notice" {
        return Err(BantoError::BadRequest(
            "ログイン画面のお知らせは login_notice_set で変更してください".to_string(),
        ));
    }
    state.settings.set(&key, &value).await?;
    // Spec M14: only the KEY is recorded, never the value - this is a
    // generic key/value store and the value could be anything, including
    // something sensitive a future setting might store here.
    record_ok(
        &state.audit,
        actor,
        "settings_change",
        "settings",
        None,
        Some(serde_json::json!({ "key": key })),
    )
    .await;
    Ok(())
}

// --- M12: per-user UI settings + window vibrancy ----------------------------

/// Read one of the calling session's OWN UI settings (spec M12, Issue #786:
/// theme mode/preset, dock layout). Any authenticated role - unlike
/// `settings_get`/`settings_set` these only ever touch the caller's own rows
/// of `ui_settings` (`Caller::ui_owner`: an account's by its `users.id`, the
/// no-login session's `local`), so no privilege is involved. Same answer as
/// REST's `GET /api/ui-settings/{key}`: `{ value, revision }`, with
/// `value: null` and `revision: "0"` when nothing is stored.
#[tauri::command]
async fn ui_settings_get(state: State<'_, AppState>, key: String) -> Result<UiSetting, BantoError> {
    ui_settings_get_body(&state, &key).await
}

/// Body of [`ui_settings_get`] (testable with a plain `&AppState`).
async fn ui_settings_get_body(state: &AppState, key: &str) -> Result<UiSetting, BantoError> {
    let caller = require_role(state, Role::Viewer, "settings").await?;
    state.settings.ui_get(&caller.ui_owner, key).await
}

/// Write one of the calling session's OWN UI settings (spec M12, Issue
/// #786). Same arguments and answer as REST's `PUT /api/ui-settings/{key}`
/// (conventions §1): `if_revision` (wire `ifRevision`) left out = last write
/// wins, `"0"` = only when nothing is stored, a revision = only while the row
/// still has it; the answer is `{ revision }`, and a failed condition is the
/// `conflict` error whose `current` is `{ value, revision }`. Any
/// authenticated role - deliberately NOT `admin`-gated like `settings_set`.
/// Spec M14: NOT audited, same reasoning as the REST routes (see `rest.rs`'s
/// module doc comment) - this is each owner's own theme/dock-layout
/// preference, not an admin-scoped "settings change".
#[tauri::command]
async fn ui_settings_set(
    state: State<'_, AppState>,
    key: String,
    value: String,
    if_revision: Option<String>,
) -> Result<UiSettingRevision, BantoError> {
    ui_settings_set_body(&state, &key, &value, if_revision.as_deref()).await
}

/// Body of [`ui_settings_set`] (testable with a plain `&AppState`).
async fn ui_settings_set_body(
    state: &AppState,
    key: &str,
    value: &str,
    if_revision: Option<&str>,
) -> Result<UiSettingRevision, BantoError> {
    let caller = require_role(state, Role::Viewer, "settings").await?;
    state
        .settings
        .ui_put(&caller.ui_owner, key, value, if_revision)
        .await
}

/// Delete one of the calling session's OWN UI settings (Issue #786) - the
/// Tauri twin of REST's `DELETE /api/ui-settings/{key}`: same `ifRevision`,
/// same answer (`{ revision: "0" }`), not audited.
#[tauri::command]
async fn ui_settings_delete(
    state: State<'_, AppState>,
    key: String,
    if_revision: Option<String>,
) -> Result<UiSettingRevision, BantoError> {
    ui_settings_delete_body(&state, &key, if_revision.as_deref()).await
}

/// Body of [`ui_settings_delete`] (testable with a plain `&AppState`).
async fn ui_settings_delete_body(
    state: &AppState,
    key: &str,
    if_revision: Option<&str>,
) -> Result<UiSettingRevision, BantoError> {
    let caller = require_role(state, Role::Viewer, "settings").await?;
    state
        .settings
        .ui_delete(&caller.ui_owner, key, if_revision)
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
        record_ok(
            &state.audit,
            &actor,
            "settings_change",
            "settings",
            None,
            Some(serde_json::json!({ "vibrancyEnabled": enabled })),
        )
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

/// `admin`-only (spec M10): the user-management screen's account list.
/// Issue #697: each row carries its stored `permissions`, the same shape as
/// REST's `GET /api/users` (`banto_server::routes::list_users_with_permissions`).
#[tauri::command]
async fn users_list(state: State<'_, AppState>) -> Result<Vec<UserWithPermissions>, BantoError> {
    users_list_body(&state).await
}

/// Body of [`users_list`].
async fn users_list_body(state: &AppState) -> Result<Vec<UserWithPermissions>, BantoError> {
    require_role(state, Role::Admin, "users").await?;
    list_users_with_permissions(&state.users).await
}

/// `admin`-only (Issue #697, user-permissions-plan §6): the permissions the
/// app registered, in registration order - REST's `GET /api/permissions`.
/// Empty for the template.
#[tauri::command]
async fn permissions_catalog(
    state: State<'_, AppState>,
) -> Result<Vec<PermissionEntry>, BantoError> {
    permissions_catalog_body(&state).await
}

/// Body of [`permissions_catalog`].
async fn permissions_catalog_body(state: &AppState) -> Result<Vec<PermissionEntry>, BantoError> {
    require_role(state, Role::Admin, "users").await?;
    Ok(permission_catalog_entries(&state.users))
}

/// `admin`-only (spec M10): create an additional account.
#[tauri::command]
async fn users_create(
    state: State<'_, AppState>,
    username: String,
    password: String,
    display_name: String,
    role: Role,
) -> Result<UserIdentityView, BantoError> {
    users_create_body(&state, &username, &password, &display_name, role).await
}

/// Body of [`users_create`] (spec M14 pattern) so its authz + audit behavior
/// is testable with a plain `&AppState` (Issue #204's session tests).
async fn users_create_body(
    state: &AppState,
    username: &str,
    password: &str,
    display_name: &str,
    role: Role,
) -> Result<UserIdentityView, BantoError> {
    let actor = require_role(state, Role::Admin, "users").await?;
    let identity = state
        .users
        .create_user(username, password, display_name, role)
        .await?;
    record_ok(
        &state.audit,
        &actor,
        "create",
        "users",
        Some(&identity.id.to_string()),
        Some(admin_template_core::users::user_create_detail(&identity)),
    )
    .await;
    Ok(identity.into())
}

/// `admin`-only (spec M10): update an account's display name/role. Refuses
/// to demote the last remaining `admin` (`UsersService::update_user`'s
/// guard).
///
/// `version` (Issue #651) is the optimistic-lock check, the same as REST's
/// `PUT /api/users/{id}` body field: a different stored version is a
/// `conflict` and nothing is written or audited; `None` overwrites as before.
///
/// `permissions` (Issue #697, the same optional field as REST's body): the
/// account's permissions after the update; `None` leaves them as they are.
/// Malformed / unregistered keys are `validation` on `permissions` (nothing
/// written); the change is in the same write, version check and audit row
/// as the rest of the update. Returns the row with its permissions, like
/// REST.
#[tauri::command]
async fn users_update(
    state: State<'_, AppState>,
    id: i64,
    display_name: String,
    role: Role,
    version: Option<i64>,
    permissions: Option<Vec<String>>,
) -> Result<UserWithPermissions, BantoError> {
    users_update_body(
        &state,
        id,
        &display_name,
        role,
        version,
        permissions.as_deref(),
    )
    .await
}

/// Body of [`users_update`] (spec M14 pattern, see [`users_create_body`]).
/// Issue #697: the `granted_by` of new permission rows is the admin of THIS
/// command (the audit actor of its re-read session, ADR-0034 §3 - the same
/// name the `update` row carries, as on REST), never anything the caller
/// sends.
async fn users_update_body(
    state: &AppState,
    id: i64,
    display_name: &str,
    role: Role,
    version: Option<i64>,
    permissions: Option<&[String]>,
) -> Result<UserWithPermissions, BantoError> {
    let actor = require_role(state, Role::Admin, "users").await?;
    let permissions = permissions.map(PermissionKey::parse_all).transpose()?;
    let outcome = state
        .users
        .update_user_with_permissions(
            id,
            display_name,
            role,
            permissions.as_deref(),
            version,
            &actor.actor.username,
        )
        .await?;
    record_ok(
        &state.audit,
        &actor,
        "update",
        "users",
        Some(&id.to_string()),
        Some(
            admin_template_core::users::user_update_detail_with_permissions(
                &outcome.previous,
                &outcome.updated,
                &outcome.permission_diff,
            ),
        ),
    )
    .await;
    Ok(UserWithPermissions::new(
        outcome.updated,
        outcome.permissions,
    ))
}

/// `admin`-only (spec M10): reset another account's password without
/// knowing its current one (unlike self-service `auth_change_password`).
#[tauri::command]
async fn users_reset_password(
    state: State<'_, AppState>,
    id: i64,
    new_password: String,
) -> Result<(), BantoError> {
    users_reset_password_body(&state, id, &new_password).await
}

/// Body of [`users_reset_password`] (spec M14 pattern, see
/// [`users_create_body`]).
async fn users_reset_password_body(
    state: &AppState,
    id: i64,
    new_password: &str,
) -> Result<(), BantoError> {
    let actor = require_role(state, Role::Admin, "users").await?;
    state.users.reset_password(id, new_password).await?;
    record_ok(
        &state.audit,
        &actor,
        "password_reset",
        "users",
        Some(&id.to_string()),
        None,
    )
    .await;
    Ok(())
}

/// `admin`-only (spec M10): delete an account. Refuses to delete the last
/// remaining `admin` or the caller's own account
/// (`UsersService::delete_user`'s guards) - the acting admin's id comes
/// from the session `require_role` just verified, not from an argument, so
/// a caller cannot spoof a different acting user.
///
/// `version` (Issue #651) is the optimistic-lock check, the same as REST's
/// `DELETE /api/users/{id}?version=N`: a different stored version is a
/// `conflict` and nothing is deleted or audited; `None` deletes as before.
#[tauri::command]
async fn users_delete(
    state: State<'_, AppState>,
    id: i64,
    version: Option<i64>,
) -> Result<(), BantoError> {
    users_delete_body(&state, id, version).await
}

/// Body of [`users_delete`] (spec M14 pattern, see [`users_create_body`]).
async fn users_delete_body(
    state: &AppState,
    id: i64,
    version: Option<i64>,
) -> Result<(), BantoError> {
    let acting = require_role(state, Role::Admin, "users").await?;
    let removed = state
        .users
        .delete_user_checked_returning_previous(id, Some(acting.id), version)
        .await?;
    record_ok(
        &state.audit,
        &acting,
        "delete",
        "users",
        Some(&id.to_string()),
        Some(admin_template_core::users::user_delete_detail(&removed)),
    )
    .await;
    Ok(())
}

/// `admin`-only (spec M14): the audit-log viewer's filtered/sorted/
/// paginated read, mirroring REST's `POST /api/audit-log/list?asOfId=`
/// (`banto_server::routes::audit_log_router`). `as_of_id` (the `asOfId`
/// argument, optional, Issue #248) is the snapshot boundary
/// (`AuditLogService::list_as_of`); the answer carries the boundary it used.
/// An unbounded read opportunistically prunes first; **a bounded read does
/// not** (see [`AuditLogService::prune_before_list`], shared with the REST route).
#[tauri::command]
async fn audit_log_list(
    state: State<'_, AppState>,
    params: ListParams,
    as_of_id: Option<i64>,
) -> Result<AuditLogList, BantoError> {
    require_role(&state, Role::Admin, "audit_log").await?;
    state
        .audit
        .prune_before_list(&state.settings, as_of_id)
        .await;
    state.audit.list_as_of(params, as_of_id).await
}

/// Current audit-log retention policy (spec M14 Phase B). `admin`-only, to
/// mirror REST's `GET /api/audit-log/config` (guarded by the same
/// `RoleGuard { min: Role::Admin }` as the rest of `audit_log_router`). The
/// two paths MUST require the same role floor (conventions §1) - unlike
/// `auth_config_get`, which is desktop-only (no REST counterpart) and so may
/// stay viewer-readable. This symmetry is enforced by `verify:architecture`
/// rule 8 role-floor (CR-6).
#[tauri::command]
async fn audit_config_get(state: State<'_, AppState>) -> Result<AuditSettings, BantoError> {
    require_role(&state, Role::Admin, "settings").await?;
    state.settings.audit_config().await
}

/// `admin`-only (spec M14 Phase B): persist a new retention policy. `None`
/// on either field means unlimited on that dimension
/// (`SettingsService::set_audit_config`/`normalize_retention`) - the
/// pruning itself still only runs opportunistically from `audit_log_list`/
/// `crate::rest::audit_log_list`, not from this command.
#[tauri::command]
async fn audit_config_apply(
    state: State<'_, AppState>,
    retention_days: Option<i64>,
    retention_rows: Option<i64>,
) -> Result<AuditSettings, BantoError> {
    let actor = require_role(&state, Role::Admin, "settings").await?;
    let config = AuditSettings {
        retention_days,
        retention_rows,
    };
    state.settings.set_audit_config(&config).await?;
    record_ok(
        &state.audit,
        &actor,
        "settings_change",
        "settings",
        None,
        Some(serde_json::json!({
            "retentionDays": config.retention_days,
            "retentionRows": config.retention_rows,
        })),
    )
    .await;
    // Re-read rather than echo `config` back directly: `set_audit_config`/
    // `audit_config` round-trip a non-positive value as `None` (spec:
    // "0以下は「無制限」" - see `normalize_retention`), so if the caller
    // passed e.g. `Some(0)` the echoed struct would show `Some(0)` while a
    // subsequent `audit_config_get` would show `None` for the same field.
    // Re-reading keeps this command's response identical to what every
    // other reader of the setting sees.
    state.settings.audit_config().await
}

// --- M17: SQLite backup/restore ---------------------------------------------

/// Body of [`backups_create`], split out the same way [`change_own_password`]/
/// [`items_import_body`] are (spec M14 pattern) so the audit-recording
/// behavior is testable with a plain `&AppState` in this crate's own `cargo
/// test` - `tauri::State` cannot be constructed outside a running tauri app.
async fn backups_create_body(state: &AppState) -> Result<BackupInfo, BantoError> {
    let actor = require_role(state, Role::Admin, "backups").await?;
    let info = state.backup.create().await?;
    record_ok(
        &state.audit,
        &actor,
        "backup",
        "backups",
        Some(&info.file_name),
        Some(serde_json::json!({ "sizeBytes": info.size_bytes })),
    )
    .await;
    Ok(info)
}

/// `admin`-only (spec M17): create a new backup (`VACUUM INTO`).
#[tauri::command]
async fn backups_create(state: State<'_, AppState>) -> Result<BackupInfo, BantoError> {
    backups_create_body(&state).await
}

/// `admin`-only (spec M17): list existing backups, newest first. Read-only,
/// so - like `backups_pending`/`server_status` - not audited.
#[tauri::command]
async fn backups_list(state: State<'_, AppState>) -> Result<Vec<BackupInfo>, BantoError> {
    require_role(&state, Role::Admin, "backups").await?;
    state.backup.list().await
}

/// `backups_open_folder`'s response shape (spec M17): `path` is always the
/// resolved `backups/` directory; `opened` tells the frontend whether an
/// actual file-explorer window was launched, so it can show a fallback
/// message (e.g. "このOSでは非対応です。手動で開いてください: {path}") on
/// platforms this command deliberately does not attempt to support.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenFolderResult {
    opened: bool,
    path: String,
}

/// `admin`-only (spec M17): open the `backups/` directory in the OS file
/// explorer. **Windows-only** by design (spec: "非Windowsはエラーでなく
/// no-op + その旨返す") - every other platform this workspace targets
/// (macOS/Linux, spec §6) gets `opened: false` instead of an `Err`, since
/// "please go look at a folder" is not worth failing the command over; the
/// frontend is expected to show `path` as a fallback instead. Not audited -
/// this only opens a window, it does not touch any data.
#[tauri::command]
async fn backups_open_folder(state: State<'_, AppState>) -> Result<OpenFolderResult, BantoError> {
    require_role(&state, Role::Admin, "backups").await?;
    let path = state.backup.backups_dir_display();

    #[cfg(target_os = "windows")]
    {
        // Best-effort: `explorer` returning a non-zero exit status (e.g. the
        // directory does not exist yet because no backup has ever been
        // created) is still reported as `opened: false` rather than an
        // `Err` - same non-fatal framing as every other OS in this command.
        let opened = std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .is_ok();
        Ok(OpenFolderResult { opened, path })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(OpenFolderResult {
            opened: false,
            path,
        })
    }
}

/// Body of [`backups_stage_restore`] (spec M14 split-function pattern, see
/// [`backups_create_body`]).
async fn backups_stage_restore_body(state: &AppState, file_name: &str) -> Result<(), BantoError> {
    let actor = require_role(state, Role::Admin, "backups").await?;
    state.backup.stage_restore_from_file(file_name).await?;
    record_ok(
        &state.audit,
        &actor,
        "restore_staged",
        "backups",
        // The backup file's real name, like `backups_create` and REST's
        // `POST /api/backups/{fileName}/restore` (conventions section 1:
        // the same audit row on both paths). It used to be `None` here.
        Some(file_name),
        Some(serde_json::json!({ "source": "existing", "fileName": file_name })),
    )
    .await;
    Ok(())
}

/// `admin`-only (spec M17): stage a restore from an existing backup already
/// in `backups/`.
#[tauri::command]
async fn backups_stage_restore(
    state: State<'_, AppState>,
    file_name: String,
) -> Result<(), BantoError> {
    backups_stage_restore_body(&state, &file_name).await
}

/// `admin`-only (spec M17): the currently-staged restore, if any. Read-only,
/// not audited.
#[tauri::command]
async fn backups_pending(
    state: State<'_, AppState>,
) -> Result<Option<PendingRestoreInfo>, BantoError> {
    require_role(&state, Role::Admin, "backups").await?;
    Ok(state.backup.pending_restore().await)
}

/// Body of [`backups_cancel_restore`] (spec M14 split-function pattern).
async fn backups_cancel_restore_body(state: &AppState) -> Result<(), BantoError> {
    let actor = require_role(state, Role::Admin, "backups").await?;
    state.backup.cancel_pending_restore().await?;
    record_ok(
        &state.audit,
        &actor,
        "restore_cancelled",
        "backups",
        None,
        None,
    )
    .await;
    Ok(())
}

/// `admin`-only (spec M17): cancel a staged restore.
#[tauri::command]
async fn backups_cancel_restore(state: State<'_, AppState>) -> Result<(), BantoError> {
    backups_cancel_restore_body(&state).await
}

// --- M20: attachments --------------------------------------------------------

/// `viewer`+ (attachments-plan §3.5): every attachment for one record, newest first.
#[tauri::command]
async fn attachments_list(
    state: State<'_, AppState>,
    resource: String,
    resource_id: String,
) -> Result<Vec<AttachmentMeta>, BantoError> {
    require_role(&state, Role::Viewer, "attachments").await?;
    state
        .attachments
        .list_for_record(&resource, &resource_id)
        .await
}

/// `viewer`+ (attachments-plan §3.5): raw thumbnail JPEG bytes, for the panel to wrap in
/// a `Blob`/object URL (the webview has no `<img src="tauri://...">` file
/// route to point at directly, same constraint `backups` documents for
/// downloads - attachments-plan §3.6). `NotFound` (-> the same error the frontend
/// already handles for a missing/never-generated thumbnail) covers both "no
/// such attachment" and "attachment has no thumbnail" - see
/// `AttachmentsService::read_thumbnail`'s doc comment.
#[tauri::command]
async fn attachments_read_thumbnail(
    state: State<'_, AppState>,
    id: i64,
) -> Result<tauri::ipc::Response, BantoError> {
    require_role(&state, Role::Viewer, "attachments").await?;
    // Raw Response for symmetry with `attachments_read_body` (thumbnails are
    // small, but the frontend then handles both reads with one ArrayBuffer
    // code path instead of a JSON number-array special case).
    let bytes = state.attachments.read_thumbnail(id).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// `viewer`+ (attachments-plan §3.5): full attachment body, for in-panel image display
/// (object URL) - the Tauri-side counterpart to REST's `GET
/// /api/attachments/{id}/download`, which a browser can point an `<a
/// download>`/`<img>` at directly but the webview cannot (attachments-plan §3.6).
///
/// Returns [`tauri::ipc::Response`] (raw bytes on the wire) rather than a
/// serialized `Vec<u8>`: a JSON number-array would balloon a 25MB body to
/// ~100MB of JSON to serialize and re-parse. The caller already holds the
/// `AttachmentMeta` (from `attachments_list`) for the `mime`/`fileName` it
/// needs to type the resulting `Blob`.
#[tauri::command]
async fn attachments_read_body(
    state: State<'_, AppState>,
    id: i64,
) -> Result<tauri::ipc::Response, BantoError> {
    require_role(&state, Role::Viewer, "attachments").await?;
    let (_meta, bytes) = state.attachments.read_body(id).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Decode a `%XX`-percent-encoded header value back to UTF-8 (attachments-plan §3.5:
/// [`attachments_upload`]'s metadata rides `http::HeaderValue`s, which -
/// unlike a JSON string - can only hold visible ASCII; the frontend
/// `encodeURIComponent`s `fileName`/etc. before setting them as headers, so
/// this is the matching decode step). No dependency added for this - same
/// "small fixed alphabet, a dozen lines of code" reasoning as
/// `admin_template_core::rest`'s RFC 5987 encoder. Any `%` not followed by
/// two hex digits, or a final byte sequence that is not valid UTF-8, is
/// treated as a malformed header value.
fn percent_decode(value: &str) -> Result<String, BantoError> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok());
            match hex {
                Some(byte) => {
                    out.push(byte);
                    i += 3;
                }
                None => {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| BantoError::Validation {
        field_errors: vec![FieldError {
            field: "header".to_string(),
            message: "ヘッダー値の文字コードが不正です".to_string(),
        }],
    })
}

/// Read one required, percent-encoded header off an upload [`Request`]
/// (attachments-plan §3.5) - see [`percent_decode`]'s doc comment for why the decode
/// step exists at all.
fn required_header_field(
    request: &tauri::ipc::Request<'_>,
    header_name: &str,
    field_name: &str,
) -> Result<String, BantoError> {
    let raw = request
        .headers()
        .get(header_name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BantoError::Validation {
            field_errors: vec![FieldError {
                field: field_name.to_string(),
                message: "必須項目です".to_string(),
            }],
        })?;
    percent_decode(raw)
}

/// `editor`+ (attachments-plan §3.5): upload a new attachment.
///
/// Binary transfer: this command takes [`tauri::ipc::Request`] (attachments-plan §3.5's
/// "第一候補") rather than a typed `contents: Vec<u8>` argument - the
/// frontend calls `invoke('attachments_upload', uint8ArrayBody, { headers
/// })`, which Tauri delivers here as `InvokeBody::Raw` (see
/// `tauri::ipc::Request::body`'s doc comment); `resource`/`resourceId`/
/// `fileName` ride alongside as percent-encoded headers rather than
/// ordinary command arguments because a `Raw` body has no JSON object for
/// per-argument extraction to key into (`tauri::ipc::CommandArg`'s
/// blanket impl errors out if a plain argument tries that against a `Raw`
/// body) - `Request`/`State` are the only two argument types this command
/// can mix, since both read from the invoke message directly rather than
/// keying into its JSON payload.
/// Body of [`attachments_upload`] (spec M14 pattern) so its authz + upload +
/// audit + event behavior is testable with a plain `&AppState`. The command
/// adapter extracts the raw request (binary body + the three metadata headers;
/// request-shaped parsing that cannot run outside a real invoke) and this
/// body does everything else. Authz therefore runs AFTER the adapter reads the
/// request shape; a denied caller is still recorded via [`require_role`], and
/// the parse is a cheap read of an already-received local IPC message.
async fn attachments_upload_body(
    state: &AppState,
    resource: String,
    resource_id: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<AttachmentMeta, BantoError> {
    let actor = require_role(state, Role::Editor, "attachments").await?;
    admin_template_core::attachment_wiring::validate_attachment_parent(
        &state.items,
        &resource,
        &resource_id,
    )
    .await?;
    let meta = state
        .attachments
        .upload(NewAttachment {
            resource,
            resource_id,
            file_name,
            created_by: Some(actor.username.clone()),
            bytes,
        })
        .await?;
    record_ok(
        &state.audit,
        &actor,
        "create",
        "attachments",
        Some(&meta.id.to_string()),
        Some(attachment_audit_detail(&meta)),
    )
    .await;
    let _ = state.events.send(ServerEvent::ResourceChanged {
        resource: "attachments".to_string(),
    });
    Ok(meta)
}

#[tauri::command]
async fn attachments_upload(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<AttachmentMeta, BantoError> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(BantoError::Validation {
                field_errors: vec![FieldError {
                    field: "file".to_string(),
                    message: "ファイルのバイナリボディが必要です".to_string(),
                }],
            });
        }
    };
    let resource = required_header_field(&request, "x-banto-resource", "resource")?;
    let resource_id = required_header_field(&request, "x-banto-resource-id", "resourceId")?;
    let file_name = required_header_field(&request, "x-banto-file-name", "fileName")?;
    attachments_upload_body(&state, resource, resource_id, file_name, bytes).await
}

/// Body of [`attachments_delete`] (spec M14 pattern) so its authz + delete +
/// audit + event behavior is testable with a plain `&AppState`.
async fn attachments_delete_body(state: &AppState, id: i64) -> Result<(), BantoError> {
    let actor = require_role(state, Role::Editor, "attachments").await?;
    let meta = state.attachments.delete(id).await?;
    let detail =
        admin_template_core::attachment_wiring::attachment_delete_audit_detail(&state.items, &meta)
            .await;
    record_ok(
        &state.audit,
        &actor,
        "delete",
        "attachments",
        Some(&id.to_string()),
        Some(detail),
    )
    .await;
    let _ = state.events.send(ServerEvent::ResourceChanged {
        resource: "attachments".to_string(),
    });
    Ok(())
}

/// `editor`+ (attachments-plan §3.5): delete one attachment.
#[tauri::command]
async fn attachments_delete(state: State<'_, AppState>, id: i64) -> Result<(), BantoError> {
    attachments_delete_body(&state, id).await
}

/// `editor`+ (attachments-plan §3.6): open the `attachments/` directory in the OS file
/// explorer - the same "no native save dialog in v1" fallback
/// `backups_open_folder` uses, gated at the attachments WRITE floor (rather
/// than `backups_open_folder`'s `admin`-only) since browsing the raw
/// on-disk files is an attachments-management action, not a full-database
/// one. **Windows-only** by design, see `backups_open_folder`'s doc comment
/// for the same non-fatal cross-platform framing (`opened: false` rather
/// than an `Err` on every other OS).
#[tauri::command]
async fn attachments_open_folder(
    state: State<'_, AppState>,
) -> Result<OpenFolderResult, BantoError> {
    require_role(&state, Role::Editor, "attachments").await?;
    let path = state.attachments_dir.display().to_string();

    #[cfg(target_os = "windows")]
    {
        let opened = std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .is_ok();
        Ok(OpenFolderResult { opened, path })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(OpenFolderResult {
            opened: false,
            path,
        })
    }
}

// [scaffold:items] begin
//
// D1-d: `items_export_csv_to_folder` is desktop-only CSV export - not
// contiguous with the items_* CRUD/import block above (it lives next to the
// other `*_open_folder` desktop commands), so it gets its own marker pair.

/// `viewer`+ (items list is Viewer-readable): write an exported CSV to the
/// app's `exports/` dir and open that folder in the OS file explorer - the desktop
/// counterpart of the LAN browser's `<a download>` (the same "no native save
/// dialog in v1" fallback `backups_open_folder`/`attachments_open_folder`
/// use). The CSV bytes are already client-visible data (the caller can see
/// the list), so this opens no new authz surface and is not audited, matching
/// the browser download. **Windows-only** reveal by design (see
/// `backups_open_folder`); non-Windows returns `opened:false`, not an error.
#[tauri::command]
async fn items_export_csv_to_folder(
    state: State<'_, AppState>,
    content: String,
    file_name: String,
) -> Result<OpenFolderResult, BantoError> {
    require_role(&state, Role::Viewer, "items").await?;
    // Sanitize: use ONLY the final path component, reject empty/traversal.
    let safe = std::path::Path::new(&file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| BantoError::Other("invalid file name".into()))?;
    // Self-heal: recreate `exports/` if it was removed since startup (user
    // deleted it, or a data dir predating this feature) so a missing folder
    // never silently drops the export - the "folder-missing fallback".
    std::fs::create_dir_all(&state.exports_dir).map_err(|e| BantoError::Other(e.to_string()))?;
    let file_path = state.exports_dir.join(safe);
    std::fs::write(&file_path, content.as_bytes()).map_err(|e| BantoError::Other(e.to_string()))?;
    let path = file_path.display().to_string();

    #[cfg(target_os = "windows")]
    {
        // Open the `exports/` folder in Explorer - the SAME invocation as
        // `backups_open_folder`/`attachments_open_folder` (a single
        // directory arg). `explorer /select,<file>` to reveal the file
        // pre-selected is unreliable here: Explorer's non-standard comma/space
        // command-line parsing (std's arg quoting splits `/select,` and the
        // path into two tokens) makes it pop a spurious "location unavailable"
        // dialog even when the file was written fine. `path` (the file) is
        // still returned for the non-Windows fallback message.
        let opened = std::process::Command::new("explorer")
            .arg(&state.exports_dir)
            .spawn()
            .is_ok();
        Ok(OpenFolderResult { opened, path })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(OpenFolderResult {
            opened: false,
            path,
        })
    }
}
// [scaffold:items] end

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

/// Stops a start that the setup closure refuses: one "起動できません" line on
/// stderr, then exit code 1, like `banto-serve`. Not `return Err(..)` from
/// `setup`: Tauri turns that into `panic!("Failed to setup app: ..")`.
fn exit_startup_refused(reason: impl std::fmt::Display) -> ! {
    eprintln!("banto: 起動できません: {reason}");
    std::process::exit(1);
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Process start, for the `system_info` command's `uptime_secs`
            // (M-review 2026-08 §2.4). Captured first thing so it reflects app
            // start, not the tail of the setup sequence below.
            let started_at = std::time::Instant::now();
            let data_dir = app.path().app_data_dir().expect("resolve app data dir");
            std::fs::create_dir_all(&data_dir).expect("create app data dir");
            let db_path = data_dir.join("admin-template.sqlite3");

            // Spec M17: apply any staged restore BEFORE `init_db`/the pool is
            // created - see `BackupService::apply_pending_restore_at_startup`'s
            // doc comment for why this must run first (no pool may exist yet
            // when a restore is applied). Best-effort at this top level: a
            // failure here must never prevent the desktop app from starting
            // at all - the current db (if any) is left untouched on error,
            // per that function's own per-step safety notes.
            let applied_restore = match tauri::async_runtime::block_on(
                // ADR-0034 §9: before anything is swapped, the candidate's
                // migration history is checked against this app's migrations
                // and the checks that stop a startup (`startup::check`) are
                // run on it - a refused candidate leaves the current
                // database in place.
                BackupService::apply_pending_restore_at_startup(
                    &db_path,
                    &admin_template_core::startup::sqlite_restore_manifest(
                        admin_template_core::startup::Wiring::Desktop,
                    ),
                ),
            ) {
                Ok(applied) => applied,
                Err(err) => {
                    eprintln!("banto: 起動時のリストア適用に失敗しました: {err}");
                    None
                }
            };

            // init_db takes a filesystem path (not a sqlite:// URL) so
            // Windows paths with drive letters/backslashes work unchanged.
            // V2 PR2: it returns a backend-agnostic `banto_storage::Db` handle
            // (SQLite-only in this PR); every service constructor takes `Db`.
            // A database that cannot be opened (a pre-v8 one among them) stops
            // the start with a "起動できません" message and exit code 1, like
            // `banto-serve`. Not `return Err(..)`: Tauri turns a failed setup
            // into `panic!("Failed to setup app: ..")` (Codex review of #919).
            let db = match tauri::async_runtime::block_on(init_db(&db_path)) {
                Ok(db) => db,
                Err(err) => {
                    exit_startup_refused(err);
                }
            };

            let events = event_channel();
            // [scaffold:items] begin
            let items = ItemsService::new(db.clone()).with_events(events.clone());
            // [scaffold:items] end
            let resources = AppResources::new(&db, &events);
            // Issue #697: the app's one catalog (`admin_template_core::
            // permission_catalog`, also used by `banto-serve`), so the
            // desktop commands and the embedded REST server judge alike.
            let settings = SettingsService::new(db.clone());
            // ADR-0034 §4: the grants' fixed ids are reserved as account
            // names (the built-in `admin` always is) - the same list
            // `banto-serve` passes.
            let users = UsersService::new(db.clone())
                .with_permission_catalog(admin_template_core::permission_catalog())
                .with_reserved_usernames(admin_template_core::startup::reserved_usernames(
                    &settings,
                ));
            // D1-a (display-preset-plan.md, Issue #190 prep): seed
            // `FIRST_BOOT_SETTINGS` BEFORE the M11 bootstrap below reads
            // `settings.auth_config()`, so a display-preset app's seeded
            // `auth.disabled = true` (say) takes effect on the very first
            // launch rather than one launch late. No-op today: the const
            // ships empty.
            //
            // A seed that could not be written STOPS the start (cross-review
            // of PR #865), as in `banto-serve`: going on would leave the
            // database unseeded and unmarked, and a later start would seed
            // over whatever was saved in between (a preset's
            // `auth.disabled = true` over a lock-down). The restore check
            // treats the same failure as "could not check".
            match tauri::async_runtime::block_on(seed_first_boot_settings(&settings)) {
                Ok(true) => println!("banto: 初回起動の既定設定を適用しました"),
                Ok(false) => {}
                Err(err) => {
                    exit_startup_refused(format_args!(
                        "初回起動の既定設定を書き込めませんでした: {err}"
                    ));
                }
            }
            // ADR-0034 §2/§4/§5/§6: the checks that stop a startup, after the
            // migrations and the seed - the same function `banto-serve`
            // calls, and the one a restore candidate goes through before the
            // swap (§9). A database that fails them is not repaired here:
            // the message names the cause and the remedy. That includes the
            // auth mode's keys (missing or unreadable: no local session is
            // made up from a default) and "login required with no
            // administrator account" (never put back into no-login mode).
            // `Wiring::Desktop`: unlike `banto-serve`, this app starts in
            // no-login mode without public viewing - its LAN server is
            // optional, and its autostart is decided further down.
            let started = match tauri::async_runtime::block_on(
                admin_template_core::startup::check(
                    &db,
                    admin_template_core::startup::Wiring::Desktop,
                ),
            ) {
                Ok(found) => found,
                Err(err) => {
                    exit_startup_refused(err);
                }
            };
            let builtin_admin_id = started.users.builtin_admin_id;
            let backup = BackupService::new(db_path.clone(), db.clone()).with_migrations(
                admin_template_core::startup::sqlite_restore_manifest(
                    admin_template_core::startup::Wiring::Desktop,
                ),
            );
            // M20 attachments (spec docs/design/attachments-plan.md §3.3): same
            // sibling-directory convention as `backups/` above, next to the
            // DB file inside the app's own data directory.
            let attachments_dir = data_dir.join("attachments");
            let attachments = AttachmentsService::new(db.clone(), attachments_dir.clone());
            // Desktop CSV export (finding⑤ Option A): same sibling-directory
            // convention as `attachments/`/`backups/` above.
            let exports_dir = data_dir.join("exports");
            std::fs::create_dir_all(&exports_dir).expect("create exports dir");
            // System diagnostics probe (M-review 2026-08 §2.4). Built before
            // `audit` moves `db`, same as the other services above.
            let system_info = SystemInfoService::new(db.clone());
            // CPU/memory probe (ADR-0013, Issue #185): built once, here,
            // same "share one stateful sampler" reasoning as `banto-serve`'s
            // main() - see `SystemMetricsSampler::sample`'s doc comment for
            // why. Type-erased to a `MetricsProbe` so `AppState`/`Services`
            // stay `sysinfo`-feature-agnostic.
            #[cfg(feature = "system-metrics")]
            let metrics: Option<MetricsProbe> = {
                let sampler = SystemMetricsSampler::new();
                Some(std::sync::Arc::new(move || sampler.sample()))
            };
            #[cfg(not(feature = "system-metrics"))]
            let metrics: Option<MetricsProbe> = None;
            let audit = AuditLogService::new(db);
            // Records `login`/`login_failed` audit entries (spec M14) from
            // inside the verifier itself - see
            // `admin_template_core::rest::audited_credential_verifier`'s doc
            // comment. This is the embedded LAN server's OWN session
            // (`origin: "rest"`) - the webview's session goes through
            // `auth_login` below instead.
            // Issue #204: also re-checks the account on every request, so
            // deleting/demoting/re-keying it (from this window or over REST)
            // ends its LAN sessions.
            // ADR-0034 §3: the built-in row's id is the `actor_id` of every
            // REST session marked `audit_as_builtin_admin`.
            let rest_auth = user_auth_state(users.clone(), audit.clone())
                .with_builtin_admin_id(builtin_admin_id);
            let reach_check = ReachCheckState::new();

            // Spec M17: record `restore_applied` now that a real
            // `AuditLogService` exists - `apply_pending_restore_at_startup`
            // itself cannot record this (it runs before any pool/audit
            // service exists at all). No caller identity exists at this
            // point either (nobody has logged in yet) - mirrors how the
            // auth-disabled bootstrap's synthetic `login` entry below has no
            // "real" actor either.
            if let Some(applied) = &applied_restore {
                tauri::async_runtime::block_on(record_write_as(
                    &audit,
                    None,
                    "tauri",
                    "restore_applied",
                    "backups",
                    None,
                    Some(serde_json::json!({
                        "preRestoreBackupFileName": applied.pre_restore_backup_file_name,
                    })),
                ));
            }

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
            // The mode is the one the startup check just read (strictly: a
            // missing or unreadable key stopped the start above).
            let auth_config = started.auth;
            // ADR-0034 §6: the embedded server's `AuthState` starts in the
            // stored mode (before any listener exists), and follows every
            // later switch through `apply_mode_to_session`.
            apply_mode_to_rest_sessions(&rest_auth, auth_config.disabled);
            let initial_auth: Option<DesktopSession> = if auth_config.disabled {
                // The same synthetic identity and `login` entry as the
                // runtime install paths (`auth_config_apply_body` /
                // `logout_body`): `local_identity` / `record_local_login`.
                let local_identity = local_identity(auth_config.disabled_role);
                tauri::async_runtime::block_on(record_local_login(
                    &audit,
                    builtin_admin_id,
                    &local_identity,
                ));
                Some(DesktopSession::AuthDisabledLocal(local_identity))
            } else if auth_config.autologin_enabled {
                match &auth_config.autologin_username {
                    Some(username) => match keyring_store::get_password(username) {
                        Ok(password) => {
                            match tauri::async_runtime::block_on(users.verify(username, &password))
                            {
                                Ok(Some(identity)) => {
                                    tauri::async_runtime::block_on(record_ok(
                                        &audit,
                                        &account_actor(&identity),
                                        "login",
                                        "auth",
                                        None,
                                        Some(serde_json::json!({ "via": "autologin" })),
                                    ));
                                    Some(DesktopSession::Account(identity))
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
                                    tauri::async_runtime::block_on(record_login_failed_as(
                                        &audit,
                                        "tauri",
                                        username,
                                        Some(serde_json::json!({ "via": "autologin" })),
                                    ));
                                    None
                                }
                                Err(err) => {
                                    eprintln!("banto: 自動ログインの検証に失敗しました: {err}");
                                    tauri::async_runtime::block_on(record_login_failed_as(
                                        &audit,
                                        "tauri",
                                        username,
                                        Some(serde_json::json!({ "via": "autologin" })),
                                    ));
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
            // `auth.disabled` and `server.enabled` set to `true` at once
            // without `server.viewer_public` (the one combination the guards
            // refuse, `auth_server_combination_allowed`, Issue #288) - if
            // so, refuse to auto-start the (would-be unauthenticated) LAN
            // server rather than trust a state the app itself would never
            // have written, and leave the inconsistency for the user to
            // resolve from the settings screen (this does NOT rewrite either
            // setting).
            let server_config = tauri::async_runtime::block_on(settings.server_config())
                .expect("server_config should succeed");
            // Same predicate the save-time guards use (Issue #288): 認証無効 + LAN
            // 有効 is only inconsistent WITHOUT 閲覧公開.
            let inconsistent_auth_and_server = !auth_server_combination_allowed(
                auth_config.disabled,
                server_config.enabled,
                server_config.viewer_public,
            );
            if inconsistent_auth_and_server {
                eprintln!(
                    "banto: 認証無効モードとLANアクセスが同時に有効な不整合な設定を検出したため、LANサーバーの自動起動をスキップしました。設定画面でどちらかを無効にしてください。"
                );
            }
            // A saved port that is now in use steps to a neighbouring one,
            // which is saved and reported (`bind_saved_server_at_launch`).
            let (initial_bound, initial_port_notice) =
                if server_config.enabled && !inconsistent_auth_and_server {
                    tauri::async_runtime::block_on(bind_saved_server_at_launch(
                        &settings,
                        &audit,
                        &server_config,
                    ))
                } else {
                    (None, None)
                };
            // `None` (disabled, skipped, or the bind failed - already logged by
            // `bind_saved_server_at_launch`) is non-fatal: the desktop app
            // works without LAN access, and `server_status` reports
            // `running: false` so the user can pick another port.
            let initial_server = initial_bound.map(|bound| {
                tauri::async_runtime::block_on(start_embedded_server(
                    // [scaffold:items] begin
                    items.clone(),
                    // [scaffold:items] end
                    resources.clone(),
                    users.clone(),
                    settings.clone(),
                    audit.clone(),
                    backup.clone(),
                    attachments.clone(),
                    system_info.clone(),
                    metrics.clone(),
                    rest_auth.clone(),
                    events.clone(),
                    reach_check.clone(),
                    // `ServerSlot::new` starts at generation 0.
                    0,
                    bound,
                ))
            });

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
                // [scaffold:items] begin
                items,
                // [scaffold:items] end
                resources,
                auth: Mutex::new(AuthSlot::new(initial_auth)),
                firewall_change_running: std::sync::atomic::AtomicBool::new(false),
                auth_io: AuthIo::production(&users, &settings),
                auth_config_lock: AsyncMutex::new(()),
                builtin_admin_id,
                users,
                settings,
                events,
                rest_auth,
                reach_check,
                // The launch bind never changes the bind address (only the
                // port may fall back), so the saved bind is what it used.
                server: AsyncMutex::new(ServerSlot::new(
                    initial_server
                        .map(|server| LiveServer::new(server, server_config.bind.clone())),
                    initial_port_notice,
                )),
                audit,
                backup,
                attachments,
                attachments_dir,
                exports_dir,
                system_info,
                metrics,
                started_at,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            // [scaffold:items] begin
            items_list,
            items_get,
            items_create,
            items_update,
            items_delete,
            items_bulk_delete,
            items_import,
            items_export_csv_to_folder,
            // [scaffold:items] end
            // [banto:add-resource:tauri-handlers]
            auth_status,
            auth_login,
            auth_logout,
            auth_check,
            auth_identity,
            auth_resolve,
            auth_change_password,
            auth_config_get,
            auth_config_apply,
            autologin_enable,
            autologin_disable,
            server_status,
            server_apply,
            firewall_rule_status,
            firewall_rule_change,
            reach_check_issue,
            reach_check_status,
            system_info,
            settings_get,
            settings_set,
            login_notice_get,
            login_notice_set,
            ui_settings_get,
            ui_settings_set,
            ui_settings_delete,
            vibrancy_apply,
            vibrancy_status,
            users_list,
            users_create,
            users_update,
            users_reset_password,
            permissions_catalog,
            users_delete,
            audit_log_list,
            audit_config_get,
            audit_config_apply,
            backups_create,
            backups_list,
            backups_open_folder,
            backups_stage_restore,
            backups_pending,
            backups_cancel_restore,
            attachments_list,
            attachments_read_thumbnail,
            attachments_read_body,
            attachments_upload,
            attachments_delete,
            attachments_open_folder,
            panel_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests;
