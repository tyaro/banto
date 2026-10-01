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
use admin_template_core::audit::{AuditEntry, AuditLogList, AuditLogService};
use admin_template_core::backup::{BackupInfo, BackupService, PendingRestoreInfo};
use admin_template_core::db::init_db;
use admin_template_core::events::event_channel;
use admin_template_core::first_boot::seed_first_boot_settings;
// [scaffold:items] begin
use admin_template_core::items::{ImportResult, Item, ItemImportRow, ItemInput, ItemsService};
// [scaffold:items] end
use admin_template_core::rest::{api_router, user_auth_state, Services};
use admin_template_core::settings::{
    auth_server_combination_allowed, AuditSettings, AuthSettings, ServerSettings, SettingsService,
};
use admin_template_core::system_info::SystemInfoService;
#[cfg(feature = "system-metrics")]
use admin_template_core::system_metrics::SystemMetricsSampler;
use admin_template_core::users::{Role, UserIdentity, UserSummary, UsersService};
use banto_attachments::{AttachmentMeta, AttachmentsService, NewAttachment};
use banto_core::{BantoError, FieldError, ListParams, ListResult};
use banto_server::routes::{MetricsProbe, SystemInfo};
use banto_server::{
    bind as bind_listener, lan_urls_for_bind, static_router, with_security_headers, AuthState,
    BoundServer, RunningServer, ServerConfig, ServerEvent,
};
use qrcode::render::svg;
use qrcode::QrCode;
use serde::Serialize;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tokio::sync::{broadcast, Mutex as AsyncMutex};

/// App-wide state managed by Tauri (spec §10, §11).
struct AppState {
    // [scaffold:items] begin
    items: ItemsService,
    // [scaffold:items] end
    /// The webview window's own session identity, set by `auth_login`/
    /// `auth_setup` and cleared by `auth_logout` - all called directly via
    /// `invoke()`, never through `/api/auth/login`. `Some` means logged in;
    /// carrying the full `UserIdentity` (not just a bool) lets
    /// `auth_change_password` recover the current `username` without a
    /// second round trip. Issue #204: a [`DesktopSession`], so every place
    /// that establishes a session states which kind it is, and every read
    /// goes through [`current_session`].
    ///
    /// Issue #260 (docs/session-controller-design.md §5.3, I-11): wrapped in
    /// an [`AuthSlot`] with a write sequence, so a command that `.await`s
    /// between reading the slot and writing it (login's argon2 verify,
    /// logout's settings read) only writes when nothing re-bound the slot
    /// meanwhile ([`cas_session`]).
    auth: Mutex<AuthSlot>,
    /// The two slow `.await`s the session-changing commands make before
    /// they write [`AppState::auth`] (credential verification / first-user
    /// setup, and the auth-mode read), injected so tests can hold a command
    /// at that point and fix the completion order (design §8.3). Production
    /// wraps `users`/`settings` below ([`AuthIo::production`]).
    auth_io: AuthIo,
    /// Serializes "read the auth-mode settings, decide, act on the decision"
    /// (PR #264 re-review P2): [`auth_config_apply_body`] holds it from its
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
    auth_config_lock: AsyncMutex<()>,
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
    /// File/image attachments (spec `docs/attachments-plan.md` §3, M20 unit
    /// B): `banto_attachments::AttachmentsService` has no `tauri`/
    /// `ServerEvent` awareness by design (see that crate's module doc
    /// comment), so - unlike `items`, which broadcasts its own
    /// `ResourceChanged` internally - the `attachments_upload`/
    /// `attachments_delete` commands below broadcast on `events` themselves,
    /// mirroring `admin_template_core::rest`'s attachments handlers.
    attachments: AttachmentsService,
    /// `attachments/` directory the above service was constructed with
    /// (spec §3.3: `db_path.parent().join("attachments")`) - kept alongside
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

/// Result of `auth_login`/`auth_setup`. `superseded`/`seq` (Issue #260,
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
/// login/setup/config-apply installing a session, logout/settle clearing
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
/// `auth_setup`'s first-account creation. Not in design §8.3's sketch (which
/// names only the verifier and the auth-mode read): `auth_setup` awaits
/// `setup_first_user`, not `verify`, so S-18/S-19 need their own hold point.
type FirstUserSetup = Arc<dyn Fn(String, String, String) -> AuthFuture<UserIdentity> + Send + Sync>;
/// `auth_logout`'s auth-mode read (design §8.3 `AuthModeSource`).
type AuthModeSource = Arc<dyn Fn() -> AuthFuture<AuthSettings> + Send + Sync>;
/// `auth_config_apply`'s settings save. Not in design §8.3's sketch: injected
/// so a test can hold an apply right AFTER it saved (PR #264 re-review P2).
type AuthConfigSave = Arc<dyn Fn(AuthSettings) -> AuthFuture<()> + Send + Sync>;

/// See [`AppState::auth_io`].
struct AuthIo {
    verify: CredentialVerifier,
    setup_first_user: FirstUserSetup,
    auth_mode: AuthModeSource,
    save_auth_config: AuthConfigSave,
}

impl AuthIo {
    fn production(users: &UsersService, settings: &SettingsService) -> Self {
        let verify_users = users.clone();
        let setup_users = users.clone();
        let save_settings = settings.clone();
        let settings = settings.clone();
        Self {
            verify: Arc::new(move |username, password| {
                let users = verify_users.clone();
                Box::pin(async move { users.verify(&username, &password).await })
            }),
            setup_first_user: Arc::new(move |username, password, display_name| {
                let users = setup_users.clone();
                Box::pin(async move {
                    users
                        .setup_first_user(&username, &password, &display_name)
                        .await
                })
            }),
            auth_mode: Arc::new(move || {
                let settings = settings.clone();
                Box::pin(async move { settings.auth_config().await })
            }),
            save_auth_config: Arc::new(move |config| {
                let settings = save_settings.clone();
                Box::pin(async move { settings.set_auth_config(&config).await })
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatusResult {
    initialized: bool,
    /// Always `false` in the Tauri window (Issue #189,
    /// `docs/viewer-public-plan.md` §3.1-4, ADR-0012). 閲覧公開 is a property
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
    /// A `users` account (`auth_login`, `auth_setup`, autologin): bound to
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
    let (cached, seq_at_entry) = read_slot(state);
    let Some(cached) = cached else {
        return Ok(None);
    };
    let fresh = read_session_source(state, &cached).await?;
    Ok(match settle_session(state, &cached, fresh, seq_at_entry) {
        Settled::Settled { session, .. } => session,
        Settled::Stale { valid_now } => valid_now,
    })
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
    Stale { valid_now: Option<DesktopSession> },
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
        return Settled::Stale { valid_now };
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
async fn require_role(
    state: &AppState,
    min: Role,
    resource: &str,
) -> Result<UserIdentity, BantoError> {
    let current = current_session(state)
        .await?
        .map(|session| session.identity().clone());
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

/// Record a successful, actor-attributed audit event from a Tauri command
/// (spec M14) - the desktop counterpart to
/// `admin_template_core::rest::record_write` (conventions §1: both paths
/// record the SAME shape, so a helper on each side keeps them from drifting).
/// The REST helper re-resolves the actor from the request's bearer token; the
/// Tauri side already holds the caller's [`UserIdentity`] - from the
/// [`require_role`] guard that ran first, or the auth flow that just
/// established the session - so it is passed in directly. `origin` is always
/// `"tauri"` and `result` always `"ok"`.
///
/// The handlers whose entry does not fit this shape build their `AuditEntry`
/// by hand, exactly as their REST counterparts do: [`items_import_body`]'s
/// `ok`/`failed` result, [`auth_login`]'s `login_failed` (no [`UserIdentity`],
/// `result: "failed"`), [`auth_config_apply`]'s escape hatch (actor may be
/// absent), the `denied` entry in [`require_role`] itself, and the startup
/// `restore_applied` (no caller identity exists yet).
async fn record_ok(
    audit: &AuditLogService,
    actor: &UserIdentity,
    action: &str,
    resource: &str,
    entity_id: Option<&str>,
    detail: Option<serde_json::Value>,
) {
    audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action,
            resource,
            entity_id,
            detail,
            origin: "tauri",
            result: "ok",
        })
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
        Some(serde_json::json!({ "name": item.name })),
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
    let item = state.items.update(id, values).await?;
    record_ok(
        &state.audit,
        &actor,
        "update",
        "items",
        Some(&item.id.to_string()),
        Some(serde_json::json!({ "name": item.name })),
    )
    .await;
    Ok(item)
}

/// Body of [`items_delete`], split out (spec M14 pattern, see
/// [`items_import_body`]) so its authz + attachment-sweep + audit behavior is
/// testable with a plain `&AppState` in this crate's own `cargo test`.
async fn items_delete_body(state: &AppState, id: i64) -> Result<(), BantoError> {
    let actor = require_role(state, Role::Editor, "items").await?;
    state.items.delete(id).await?;
    // M20 unit C demo wiring (spec docs/attachments-plan.md §3.8): sweep up
    // any attachments left pointing at the now-deleted record. Best-effort,
    // same reasoning as the REST handler (admin-template-core's
    // `rest.rs::items_delete`) - a storage hiccup here must not turn an
    // already-successful item delete into a command error.
    let attachments_removed = match state
        .attachments
        .delete_for_record("items", &id.to_string())
        .await
    {
        Ok(count) => count,
        Err(err) => {
            eprintln!(
                "banto: item {id} の添付ファイル削除に失敗しました（item自体の削除は完了済み）: {err}"
            );
            0
        }
    };
    let detail = (attachments_removed > 0)
        .then(|| serde_json::json!({ "attachmentsRemoved": attachments_removed }));
    record_ok(
        &state.audit,
        &actor,
        "delete",
        "items",
        Some(&id.to_string()),
        detail,
    )
    .await;
    Ok(())
}

#[tauri::command]
async fn items_delete(state: State<'_, AppState>, id: i64) -> Result<(), BantoError> {
    items_delete_body(&state, id).await
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
    state
        .audit
        .record(AuditEntry {
            actor_username: Some(&actor.username),
            actor_role: Some(actor.role.as_str()),
            action: "import",
            resource: "items",
            entity_id: None,
            detail: Some(detail),
            origin: "tauri",
            result: result_tag,
        })
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

/// `GET`-ish command: has an account been created yet (spec §3.3/§8.2)? The
/// login page calls this first to decide between the first-run setup form
/// and the normal login form.
#[tauri::command]
async fn auth_status(state: State<'_, AppState>) -> Result<AuthStatusResult, BantoError> {
    Ok(AuthStatusResult {
        initialized: state.users.is_initialized().await?,
        // See `AuthStatusResult::viewer_public`: never true in this window.
        viewer_public: false,
    })
}

/// Create the very first account and log the webview session in as it
/// (spec §8.2). `BantoError::Validation` (bad username/short password)
/// propagates as `Err` so the frontend form store can field-map it;
/// "already initialized" (or any other non-validation failure) surfaces as
/// `Ok(LoginResult { success: false, .. })` instead, since that is an
/// expected/retryable outcome, not a form error.
///
/// Issue #260 (design §5.3, S-18/S-19): the session is installed only if no
/// other command re-bound the slot while the account was being created
/// ([`cas_session`] against the `seq` read before the first `.await`);
/// otherwise the account still exists but the result is `superseded`.
#[tauri::command]
async fn auth_setup(
    state: State<'_, AppState>,
    username: String,
    password: String,
    display_name: String,
) -> Result<LoginResult, BantoError> {
    setup_body(&state, username, password, display_name).await
}

/// Message for a `LoginResult { superseded: true }` (the credentials were
/// valid, but another session was established first).
const SUPERSEDED_LOGIN_MESSAGE: &str =
    "別のセッションが先に確定したため、このログインは適用されませんでした";

/// Body of [`auth_setup`] (testable with a plain `&AppState`, design §8.3).
/// Slot-clearing errors: none - every `Err` is returned before the slot is
/// written (the TS provider's revision relies on this, design I-19).
async fn setup_body(
    state: &AppState,
    username: String,
    password: String,
    display_name: String,
) -> Result<LoginResult, BantoError> {
    let (_, seq_at_entry) = read_slot(state);
    // Owner decision on #266 (S-95): in auth-disabled mode no account session
    // is ever installed. Checked on entry so no account is created for a
    // setup that could not sign in; checked again at the install below
    // (the mode can be switched on while the account is being created).
    if state.settings.auth_config().await?.disabled {
        return Ok(auth_disabled_login_result(state));
    }
    match (state.auth_io.setup_first_user)(username, password, display_name).await {
        Ok(identity) => {
            record_ok(&state.audit, &identity, "setup", "auth", None, None).await;
            install_account_unless_auth_disabled(state, seq_at_entry, identity).await
        }
        Err(err @ BantoError::Validation { .. }) => Err(err),
        Err(other) => Ok(LoginResult {
            success: false,
            error: Some(other.to_string()),
            superseded: false,
            seq: read_slot(state).1,
        }),
    }
}

/// `LoginResult.error` of a login/setup refused because auth-disabled mode is
/// on (S-95).
const AUTH_DISABLED_LOGIN_MESSAGE: &str =
    "ログイン不要モード中はアカウントでログインできません。設定で通常のログインに戻してください";

/// The refusal of a login/setup in auth-disabled mode (owner decision on
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

/// Install a verified login/setup session with [`cas_session`] and build the
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
            record_ok(&state.audit, &identity, "login", "auth", None, None).await;
            install_account_unless_auth_disabled(state, seq_at_entry, identity).await
        }
        None => {
            state
                .audit
                .record(AuditEntry {
                    // Bounded like the REST path (Issue #278): the name is
                    // caller-supplied and need not be a real account.
                    actor_username: Some(&admin_template_core::users::bound_username_for_audit(
                        &username,
                    )),
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
            session.identity(),
            "logout",
            "auth",
            None,
            None,
        )
        .await;
    }
    // Only `Installed` can happen here: with `seq` unchanged since the clear,
    // the slot is empty.
    record_local_rebind(&state.audit, &rebind).await;
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
#[tauri::command]
async fn auth_identity(state: State<'_, AppState>) -> Result<Option<Identity>, BantoError> {
    Ok(current_session(&state)
        .await?
        .as_ref()
        .map(|session| identity_from(session.identity())))
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
        } => AuthResolveResult {
            identity: session
                .as_ref()
                .map(|session| identity_from(session.identity())),
            kind: session.as_ref().map(session_kind),
            checked: seq_before,
            current: seq_after,
            stale: false,
        },
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
        &identity,
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
/// (used by [`auth_config_apply_body`] and [`logout_body`]), so they can
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
    }
}

/// Spec M14: auth-disabled mode still records a `login` for its synthetic
/// session, same as a normal login would - it is still "someone" starting to
/// use the app, just without a credential check.
async fn record_local_login(audit: &AuditLogService, identity: &UserIdentity) {
    record_ok(
        audit,
        identity,
        "login",
        "auth",
        None,
        Some(serde_json::json!({ "mode": "auth_disabled" })),
    )
    .await;
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
fn apply_mode_to_session(
    state: &AppState,
    previous: &AuthSettings,
    saved: &AuthSettings,
) -> (LocalRebind, Option<UserIdentity>) {
    if saved.disabled {
        let changed =
            (previous.disabled, previous.disabled_role) != (saved.disabled, saved.disabled_role);
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
    rebind: &LocalRebind,
    ended_local: Option<UserIdentity>,
) {
    record_local_rebind(audit, rebind).await;
    if let Some(local) = ended_local {
        record_ok(
            audit,
            &local,
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
async fn record_local_rebind(audit: &AuditLogService, outcome: &LocalRebind) {
    match outcome {
        LocalRebind::Installed(local) => record_local_login(audit, local).await,
        LocalRebind::Replaced { previous, local } => {
            record_ok(
                audit,
                previous,
                "logout",
                "auth",
                None,
                Some(serde_json::json!({ "reason": "auth_disabled" })),
            )
            .await;
            record_local_login(audit, local).await;
        }
        LocalRebind::Skipped | LocalRebind::RoleChanged | LocalRebind::Unchanged => {}
    }
}

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
///
/// BOOTSTRAP WINDOW (choiapp-feedback-2026-09 §5): while NO account exists
/// yet (`users.is_initialized() == false`), this command is also allowed
/// with no session at all - the first-run setup screen's
/// 「ログインなしで使い始める」path. This grants nothing [`auth_setup`] does
/// not already grant in the same state: with zero accounts, whoever sits at
/// the device can create the first admin unauthenticated anyway, so letting
/// that same person pick no-login mode instead is the same trust decision,
/// not a wider one. The window closes the moment the first account exists.
/// Enabling the mode re-binds the session to the same synthetic local
/// identity `run()`'s bootstrap would create on the next launch (and
/// records the same synthetic `login` entry), so the webview enters the app
/// without a restart - also when an account session was signed in: that
/// session is replaced (owner review of #266 P1, [`rebind_local_session`]),
/// so `auth.disabled == true` always goes with the synthetic session.
/// Body of [`auth_config_apply`] (spec M14 pattern) so its escape-hatch /
/// bootstrap-window authz (the actor may be `None`) + audit behavior is
/// testable with a plain `&AppState`.
async fn auth_config_apply_body(
    state: &AppState,
    disabled: bool,
    disabled_role: &str,
) -> Result<AuthSettings, BantoError> {
    // PR #264 re-review P2: held from the first settings read through the
    // save and the synthetic-session install below (see
    // `AppState::auth_config_lock`), so no other apply (or a logout's
    // re-read + install) can interleave with this decision.
    let _auth_config = state.auth_config_lock.lock().await;
    // Read through the injectable `auth_mode` (production: the same
    // `SettingsService::auth_config`) so tests can fix this command's order
    // against a concurrent logout (design §8.3).
    let currently_disabled = (state.auth_io.auth_mode)().await?.disabled;
    // Spec M14: the escape hatch and the bootstrap window (see this
    // command's doc comment) mean `require_role` may not run at all -
    // capture whatever actor identity exists directly in those cases, so
    // the audit entry below still has one when possible, instead of
    // skipping those paths' write entirely.
    let actor = if currently_disabled || !state.users.is_initialized().await? {
        // Audit label only (these two paths do not authorize by session).
        state
            .auth
            .lock()
            .expect("auth mutex poisoned")
            .session
            .as_ref()
            .map(|session| session.identity().clone())
    } else {
        Some(require_role(state, Role::Admin, "settings").await?)
    };

    // An unrecognized role string falls back to `admin` (same convention as
    // `SettingsService::auth_config`'s own read-time fallback) rather than
    // failing the whole command - a bad value here must never leave the app
    // unable to determine ANY role for the synthetic identity.
    let role = Role::from_str(disabled_role).unwrap_or(Role::Admin);

    let mut config = state.settings.auth_config().await?;
    // The settings before this apply (read under `auth_config_lock`, so no
    // other apply changes them meanwhile): a change of the mode's role while
    // the mode stays on always advances `seq` at the rebind below (S-98).
    let previous = config.clone();
    config.disabled = disabled;
    config.disabled_role = role;
    if let Err(err) = (state.auth_io.save_auth_config)(config.clone()).await {
        // Freshness audit of #266 (P2-3, S-104): the save is one transaction
        // (`SettingsService::set_auth_config`), but should any save fail
        // part-way, the session must still follow what IS stored: re-read
        // it and re-bind/end from that, then report the error.
        if let Ok(stored) = state.settings.auth_config().await {
            let (rebind, ended_local) = apply_mode_to_session(state, &previous, &stored);
            record_mode_session_change(&state.audit, &rebind, ended_local).await;
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
    let (rebind, ended_local) = apply_mode_to_session(state, &previous, &config);
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

    // The session change is recorded after the settings change it follows
    // from. Setup-skip flow (choiapp-feedback-2026-09 §5): from the
    // first-run screen there is no session, so this is the synthetic
    // `login` only; from the settings screen, the admin's session end
    // (`logout`, reason `auth_disabled`) and the synthetic `login`.
    record_mode_session_change(&state.audit, &rebind, ended_local).await;
    Ok(config)
}

#[tauri::command]
async fn auth_config_apply(
    state: State<'_, AppState>,
    disabled: bool,
    disabled_role: String,
) -> Result<AuthSettings, BantoError> {
    auth_config_apply_body(&state, disabled, &disabled_role).await
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

    keyring_store::set_password(username, password)?;

    // The same settings row as `auth_config_apply`: its read-modify-write
    // must not interleave with an apply's (a lost update of `disabled`).
    let auth_config_guard = state.auth_config_lock.lock().await;
    let mut config = state.settings.auth_config().await?;
    config.autologin_enabled = true;
    config.autologin_username = Some(username.to_string());
    state.settings.set_auth_config(&config).await?;
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

/// `server_status`/`server_apply`'s shared response shape - mirrors
/// `src/lib/banto/serverAdmin.ts::ServerStatus` field-for-field.
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
    viewer_public: bool,
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
    // Issue #216: scope the advertised URLs (and therefore the QR codes
    // below) to what `config.bind` actually listens on - a loopback bind
    // must not advertise a LAN URL nobody outside this PC can reach.
    let urls = lan_urls_for_bind(&config.bind, config.port);
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
        viewer_public: config.viewer_public,
        urls,
        qr_svgs,
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
    users: UsersService,
    settings: SettingsService,
    audit: AuditLogService,
    backup: BackupService,
    attachments: AttachmentsService,
    system_info: SystemInfoService,
    metrics: Option<MetricsProbe>,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
    bound: BoundServer,
) -> RunningServer {
    // `allow_setup: false` - the Tauri app's first-run setup goes through
    // the `auth_setup` command above (`invoke()`, no network involved), not
    // this REST endpoint. Only `banto-serve` (this repo's Tauri-free dev
    // vehicle) opts into `POST /api/auth/setup` via `BANTO_ALLOW_SETUP=1`.
    // `with_security_headers` (spec improvements §2.4) wraps LAST/outermost,
    // same as `banto-serve.rs`'s equivalent composition, so every response
    // this embedded server produces carries the baseline security headers.
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
    let router = with_security_headers(
        api_router(services, auth, events, false).merge(static_router::<FrontendAssets>()),
    );
    bound.serve(router)
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
/// `viewer_public` (Issue #189, `docs/viewer-public-plan.md` §3.1-4) is
/// persisted like the other three fields and otherwise ignored here: whether
/// LAN clients may mint a synthetic `viewer` session is decided per request
/// by `POST /api/auth/public-viewer`, which re-reads the setting, so a
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
/// dropped, nothing is saved, the previously running server is restarted from
/// the unchanged saved settings, and the command returns the error - so the
/// saved values and the live server never silently diverge. `enabled = false`
/// has no new listener (stop -> save). The attempt is audited as
/// `settings_change` / `result: "failed"` (`detail.saved: false`); a success
/// records the usual `ok` entry. Callers should re-read `server_status` after
/// an error (the frontend does).
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
    let actor = require_role(&state, Role::Admin, "settings").await?;
    let config = ServerSettings {
        enabled,
        bind,
        port,
        viewer_public,
    };

    // Held for the WHOLE apply: concurrent applies are serialized, and
    // `server_status` cannot observe the stopped-but-not-yet-restarted gap.
    let mut slot = state.server.lock().await;

    // The saved config is the one the rollback below restores, and what the
    // running listener (if any) was started from.
    let previous = state.settings.server_config().await?;
    // Refuse an illegal auth/LAN combination BEFORE anything is stopped.
    state.settings.validate_server_config(&config).await?;

    let was_running = slot.take();
    let had_running = was_running.is_some();
    if let Some(running) = was_running {
        running.stop().await;
    }

    // Serving on an already-bound listener cannot fail (the bind is the only
    // fallible step), so everything fallible happens BEFORE the listener is
    // reachable by a request.
    let launch = |bound: BoundServer| {
        let state = &state;
        async move {
            start_embedded_server(
                // [scaffold:items] begin
                state.items.clone(),
                // [scaffold:items] end
                state.users.clone(),
                state.settings.clone(),
                state.audit.clone(),
                state.backup.clone(),
                state.attachments.clone(),
                state.system_info.clone(),
                state.metrics.clone(),
                state.rest_auth.clone(),
                state.events.clone(),
                bound,
            )
            .await
        }
    };

    // Issue #287 / #294 review: bind -> save -> serve. The new settings are
    // saved only AFTER the new listener is bound (so a port in use fails
    // here, before anything is stored), and the listener only starts
    // answering requests AFTER the save. Without the last part, a request
    // (e.g. `POST /api/auth/public-viewer`, which reads the SAVED
    // `viewer_public`) could hit the new listener while the old values were
    // still stored. (Saving first - the oldest order - left the new values
    // stored while the old server was already gone whenever the bind failed.)
    let outcome: Result<Option<RunningServer>, BantoError> = async {
        let bound = if config.enabled {
            Some(
                bind_listener(ServerConfig {
                    bind: config.bind.clone(),
                    port: config.port,
                })
                .await?,
            )
        } else {
            None
        };
        // On error `bound` is dropped here, releasing the port.
        state.settings.set_server_config(&config).await?;
        if !config.viewer_public {
            // 閲覧公開 OFF: public viewer tokens minted earlier (rest_auth
            // outlives server restarts) must not keep working.
            state.rest_auth.revoke_public_viewer_tokens();
        }
        Ok(match bound {
            Some(bound) => Some(launch(bound).await),
            None => None,
        })
    }
    .await;

    match outcome {
        Ok(started) => {
            let running = started.is_some();
            *slot = started;
            record_ok(
                &state.audit,
                &actor,
                "settings_change",
                "settings",
                None,
                Some(serde_json::json!({
                    "serverEnabled": config.enabled,
                    "bind": config.bind,
                    "port": config.port,
                    "viewerPublic": config.viewer_public,
                })),
            )
            .await;
            Ok(build_status(&config, running))
        }
        Err(err) => {
            // Nothing was saved. Bring back the server that was running so
            // the live state matches the (unchanged) saved settings again.
            let mut restored = !had_running;
            if had_running {
                match bind_listener(ServerConfig {
                    bind: previous.bind.clone(),
                    port: previous.port,
                })
                .await
                {
                    Ok(bound) => {
                        *slot = Some(launch(bound).await);
                        restored = true;
                    }
                    Err(restore_err) => eprintln!(
                        "banto: LAN設定の適用に失敗し、旧設定でのサーバー再起動にも失敗しました: {restore_err}"
                    ),
                }
            }
            // The failed attempt is audited too (conventions §1: an applied
            // change and a refused/failed one both leave a record), with the
            // same `resource`/`action` as the success entry.
            let detail = serde_json::json!({
                "serverEnabled": config.enabled,
                "bind": config.bind,
                "port": config.port,
                "viewerPublic": config.viewer_public,
                "saved": false,
                "restoredPrevious": restored,
                "error": err.to_string(),
            });
            state
                .audit
                .record(AuditEntry {
                    actor_username: Some(&actor.username),
                    actor_role: Some(actor.role.as_str()),
                    action: "settings_change",
                    resource: "settings",
                    entity_id: None,
                    detail: Some(detail),
                    origin: "tauri",
                    result: "failed",
                })
                .await;
            Err(err)
        }
    }
}

/// `admin`-only, symmetric with `settings_set` below: the generic key/value
/// settings store holds privileged config (embedded-server enable/bind/port,
/// `auth.disabled`/`auth.disabled_role`, `auth.autologin.username`, audit
/// retention, and every user's `ui.{username}.*` namespace), so reading an
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

/// Body of [`settings_set`]. Freshness audit of #266 (P2-2, S-103): keys in
/// the `auth.` namespace are refused - they are written only by
/// [`auth_config_apply`] (which re-binds the session under
/// `auth_config_lock`, keeping `auth.disabled == true <=> AuthDisabledLocal`)
/// and the `autologin_*` commands. A raw write would bypass both.
async fn settings_set_body(
    state: &AppState,
    actor: &UserIdentity,
    key: String,
    value: String,
) -> Result<(), BantoError> {
    if SettingsService::is_auth_key(&key) {
        return Err(BantoError::BadRequest(format!(
            "設定 {key} はこのコマンドでは変更できません。認証モードは auth_config_apply（自動ログインは autologin_enable/autologin_disable）で変更してください"
        )));
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
) -> Result<UserIdentityResult, BantoError> {
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
        Some(serde_json::json!({ "username": identity.username, "role": identity.role })),
    )
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
    users_update_body(&state, id, &display_name, role).await
}

/// Body of [`users_update`] (spec M14 pattern, see [`users_create_body`]).
async fn users_update_body(
    state: &AppState,
    id: i64,
    display_name: &str,
    role: Role,
) -> Result<UserSummary, BantoError> {
    let actor = require_role(state, Role::Admin, "users").await?;
    let updated = state.users.update_user(id, display_name, role).await?;
    record_ok(
        &state.audit,
        &actor,
        "update",
        "users",
        Some(&id.to_string()),
        Some(serde_json::json!({ "role": updated.role })),
    )
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
#[tauri::command]
async fn users_delete(state: State<'_, AppState>, id: i64) -> Result<(), BantoError> {
    users_delete_body(&state, id).await
}

/// Body of [`users_delete`] (spec M14 pattern, see [`users_create_body`]).
async fn users_delete_body(state: &AppState, id: i64) -> Result<(), BantoError> {
    let acting = require_role(state, Role::Admin, "users").await?;
    state.users.delete_user(id, acting.id).await?;
    record_ok(
        &state.audit,
        &acting,
        "delete",
        "users",
        Some(&id.to_string()),
        None,
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
/// not** - same reasoning as the REST route (see its doc comment: pruning
/// inside a pinned boundary would expire every viewer generation at its
/// second block once the row cap is reached).
#[tauri::command]
async fn audit_log_list(
    state: State<'_, AppState>,
    params: ListParams,
    as_of_id: Option<i64>,
) -> Result<AuditLogList, BantoError> {
    require_role(&state, Role::Admin, "audit_log").await?;
    if as_of_id.is_none() {
        if let Ok(config) = state.settings.audit_config().await {
            let _ = state
                .audit
                .prune(config.retention_days, config.retention_rows)
                .await;
        }
    }
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
        None,
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

/// `viewer`+ (spec §3.5): every attachment for one record, newest first.
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

/// `viewer`+ (spec §3.5): raw thumbnail JPEG bytes, for the panel to wrap in
/// a `Blob`/object URL (the webview has no `<img src="tauri://...">` file
/// route to point at directly, same constraint `backups` documents for
/// downloads - spec §3.6). `NotFound` (-> the same error the frontend
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

/// `viewer`+ (spec §3.5): full attachment body, for in-panel image display
/// (object URL) - the Tauri-side counterpart to REST's `GET
/// /api/attachments/{id}/download`, which a browser can point an `<a
/// download>`/`<img>` at directly but the webview cannot (spec §3.6).
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

/// Decode a `%XX`-percent-encoded header value back to UTF-8 (spec §3.5:
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
/// (spec §3.5) - see [`percent_decode`]'s doc comment for why the decode
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

/// `editor`+ (spec §3.5): upload a new attachment.
///
/// Binary transfer: this command takes [`tauri::ipc::Request`] (spec §3.5's
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
/// adapter extracts the raw request (binary body + the three metadata headers)
/// - request-shaped parsing that cannot run outside a real invoke - and this
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
        Some(serde_json::json!({
            "fileName": meta.file_name,
            "sizeBytes": meta.size_bytes,
            "parentResource": meta.resource,
            "parentId": meta.resource_id,
        })),
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
    record_ok(
        &state.audit,
        &actor,
        "delete",
        "attachments",
        Some(&id.to_string()),
        Some(serde_json::json!({
            "fileName": meta.file_name,
            "sizeBytes": meta.size_bytes,
            "parentResource": meta.resource,
            "parentId": meta.resource_id,
        })),
    )
    .await;
    let _ = state.events.send(ServerEvent::ResourceChanged {
        resource: "attachments".to_string(),
    });
    Ok(())
}

/// `editor`+ (spec §3.5): delete one attachment.
#[tauri::command]
async fn attachments_delete(state: State<'_, AppState>, id: i64) -> Result<(), BantoError> {
    attachments_delete_body(&state, id).await
}

/// `editor`+ (spec §3.6): open the `attachments/` directory in the OS file
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
                BackupService::apply_pending_restore_at_startup(&db_path),
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
            let db =
                tauri::async_runtime::block_on(init_db(&db_path)).expect("init_db should succeed");

            let events = event_channel();
            // [scaffold:items] begin
            let items = ItemsService::new(db.clone()).with_events(events.clone());
            // [scaffold:items] end
            let users = UsersService::new(db.clone());
            let settings = SettingsService::new(db.clone());
            // D1-a (display-preset-plan.md, Issue #190 prep): seed
            // `FIRST_BOOT_SETTINGS` BEFORE the M11 bootstrap below reads
            // `settings.auth_config()`, so a display-preset app's seeded
            // `auth.disabled = true` (say) takes effect on the very first
            // launch rather than one launch late. No-op today: the const
            // ships empty.
            match tauri::async_runtime::block_on(seed_first_boot_settings(&settings)) {
                Ok(true) => println!("banto: 初回起動の既定設定を書き込みました"),
                Ok(false) => {}
                Err(err) => eprintln!("banto: 初回起動の既定設定の書き込みに失敗しました: {err}"),
            }
            let backup = BackupService::new(db_path.clone(), db.clone());
            // M20 attachments (spec docs/attachments-plan.md §3.3): same
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
            let rest_auth = user_auth_state(users.clone(), audit.clone());

            // Spec M17: record `restore_applied` now that a real
            // `AuditLogService` exists - `apply_pending_restore_at_startup`
            // itself cannot record this (it runs before any pool/audit
            // service exists at all). No caller identity exists at this
            // point either (nobody has logged in yet) - mirrors how the
            // auth-disabled bootstrap's synthetic `login` entry below has no
            // "real" actor either.
            if let Some(applied) = &applied_restore {
                tauri::async_runtime::block_on(audit.record(AuditEntry {
                    actor_username: None,
                    actor_role: None,
                    action: "restore_applied",
                    resource: "backups",
                    entity_id: None,
                    detail: Some(serde_json::json!({
                        "preRestoreBackupFileName": applied.pre_restore_backup_file_name,
                    })),
                    origin: "tauri",
                    result: "ok",
                }));
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
            let auth_config = tauri::async_runtime::block_on(settings.auth_config())
                .expect("auth_config should succeed");
            let initial_auth: Option<DesktopSession> = if auth_config.disabled {
                // The same synthetic identity and `login` entry as the
                // runtime install paths (`auth_config_apply_body` /
                // `logout_body`): `local_identity` / `record_local_login`.
                let local_identity = local_identity(auth_config.disabled_role);
                tauri::async_runtime::block_on(record_local_login(&audit, &local_identity));
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
                                        &identity,
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
            let initial_server = if server_config.enabled && !inconsistent_auth_and_server {
                let runtime_config = ServerConfig {
                    bind: server_config.bind.clone(),
                    port: server_config.port,
                };
                match tauri::async_runtime::block_on(bind_listener(runtime_config)) {
                    Ok(bound) => Some(tauri::async_runtime::block_on(start_embedded_server(
                    // [scaffold:items] begin
                    items.clone(),
                    // [scaffold:items] end
                    users.clone(),
                    settings.clone(),
                    audit.clone(),
                    backup.clone(),
                    attachments.clone(),
                    system_info.clone(),
                    metrics.clone(),
                    rest_auth.clone(),
                    events.clone(),
                    bound,
                    ))),
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
                // [scaffold:items] begin
                items,
                // [scaffold:items] end
                auth: Mutex::new(AuthSlot::new(initial_auth)),
                auth_io: AuthIo::production(&users, &settings),
                auth_config_lock: AsyncMutex::new(()),
                users,
                settings,
                events,
                rest_auth,
                server: AsyncMutex::new(initial_server),
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
            items_import,
            items_export_csv_to_folder,
            // [scaffold:items] end
            auth_status,
            auth_setup,
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
            system_info,
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
mod tests {
    use super::*;
    use std::path::PathBuf;

    impl AppState {
        /// Install `session` as if a session-changing command had written it
        /// (advancing `seq`, Issue #260 I-11).
        fn set_session_for_test(&self, session: Option<DesktopSession>) {
            let mut slot = self.auth.lock().expect("auth mutex poisoned");
            slot.session = session;
            slot.seq += 1;
        }
    }

    /// A minimal [`AppState`] over an in-memory DB, no running server, and a
    /// dummy REST verifier - just enough state to exercise command bodies
    /// (like [`change_own_password`]) that only touch the service handles.
    async fn app_state() -> AppState {
        let pool = admin_template_core::db::init_db_memory()
            .await
            .expect("init_db_memory");
        let events = event_channel();
        AppState {
            // [scaffold:items] begin
            items: ItemsService::new(pool.clone()).with_events(events.clone()),
            // [scaffold:items] end
            auth: Mutex::new(AuthSlot::default()),
            auth_config_lock: AsyncMutex::new(()),
            auth_io: AuthIo::production(
                &UsersService::new(pool.clone()),
                &SettingsService::new(pool.clone()),
            ),
            users: UsersService::new(pool.clone()),
            settings: SettingsService::new(pool.clone()),
            events,
            // Issue #204: the production wiring, so cross-transport tests
            // exercise the same session re-check the embedded server uses.
            rest_auth: user_auth_state(
                UsersService::new(pool.clone()),
                AuditLogService::new(pool.clone()),
            ),
            server: AsyncMutex::new(None),
            audit: AuditLogService::new(pool.clone()),
            backup: BackupService::new(
                PathBuf::from("unused-in-tests").join("admin-template.sqlite3"),
                pool.clone(),
            ),
            system_info: SystemInfoService::new(pool.clone()),
            // ADR-0013: no probe wired in this minimal test state - these
            // tests exercise command bodies that never touch `metrics`.
            metrics: None,
            attachments: AttachmentsService::new(
                pool,
                PathBuf::from("unused-in-tests").join("attachments"),
            ),
            attachments_dir: PathBuf::from("unused-in-tests").join("attachments"),
            exports_dir: PathBuf::from("unused-in-tests").join("exports"),
            started_at: std::time::Instant::now(),
        }
    }

    /// Like [`app_state`], but backed by a REAL on-disk db in a fresh temp
    /// directory rather than `:memory:` - required for the M17 backup tests
    /// below, since `BackupService::create`'s `VACUUM INTO` silently writes
    /// nothing when its source pool is `:memory:` (see
    /// `admin_template_core::backup`'s test module doc comment for the
    /// empirically-verified reason). The returned `TempDir` guard must be
    /// kept alive by the caller for as long as `AppState` is still in use.
    async fn app_state_with_tempdir() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state_in(&dir).await;
        (state, dir)
    }

    /// The [`AppState`] of [`app_state_with_tempdir`], over the DB file in
    /// `dir`. Every call opens its OWN pool on that file, so two states built
    /// from the same `dir` stand for two app processes sharing one database
    /// (Issue #204's cross-process session tests).
    async fn app_state_in(dir: &tempfile::TempDir) -> AppState {
        let db_path = dir.path().join("admin-template.sqlite3");
        let pool = admin_template_core::db::init_db(&db_path)
            .await
            .expect("init_db");
        let events = event_channel();
        AppState {
            // [scaffold:items] begin
            items: ItemsService::new(pool.clone()).with_events(events.clone()),
            // [scaffold:items] end
            auth: Mutex::new(AuthSlot::default()),
            auth_config_lock: AsyncMutex::new(()),
            auth_io: AuthIo::production(
                &UsersService::new(pool.clone()),
                &SettingsService::new(pool.clone()),
            ),
            users: UsersService::new(pool.clone()),
            settings: SettingsService::new(pool.clone()),
            events,
            // Issue #204: the production wiring, so cross-transport tests
            // exercise the same session re-check the embedded server uses.
            rest_auth: user_auth_state(
                UsersService::new(pool.clone()),
                AuditLogService::new(pool.clone()),
            ),
            server: AsyncMutex::new(None),
            audit: AuditLogService::new(pool.clone()),
            backup: BackupService::new(db_path, pool.clone()),
            system_info: SystemInfoService::new(pool.clone()),
            metrics: None,
            attachments: AttachmentsService::new(pool, dir.path().join("attachments")),
            attachments_dir: dir.path().join("attachments"),
            exports_dir: dir.path().join("exports"),
            started_at: std::time::Instant::now(),
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
        state.set_session_for_test(Some(DesktopSession::Account(owner)));

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
        assert_eq!(
            entry.entity_id.as_deref(),
            Some(owner_id.to_string().as_str())
        );
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
        state.set_session_for_test(Some(DesktopSession::Account(owner)));

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

    // [scaffold:items] begin
    // --- M15: CSV import -----------------------------------------------------
    //
    // D1-d/PR-D2: the whole M15 suite exercises `items_import_body`, so it is
    // items-only and travels with the `items` remover.

    /// `editor` can import; a mixed create+update batch succeeds and is
    /// recorded as exactly ONE `action: "import"` audit entry (spec M15:
    /// "件数サマリ付き1件記録"), with a `{created,updated}` summary detail
    /// and no `entityId`.
    #[tokio::test]
    async fn items_import_records_one_audit_entry_on_success() {
        let state = app_state().await;
        let editor = state
            .users
            .create_user("editor", "password123", "編集者", Role::Editor)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(editor)));

        let existing = state
            .items
            .create(ItemInput {
                name: "Existing".to_string(),
                price: 10,
                stock: 1,
            })
            .await
            .expect("seed create");

        let result = items_import_body(
            &state,
            vec![
                ItemImportRow {
                    id: Some(existing.id),
                    name: "Updated".to_string(),
                    price: 20,
                    stock: 2,
                },
                ItemImportRow {
                    id: None,
                    name: "Brand New".to_string(),
                    price: 30,
                    stock: 3,
                },
            ],
        )
        .await
        .expect("items_import_body should succeed");
        assert_eq!(result.created, 1);
        assert_eq!(result.updated, 1);
        assert!(result.errors.is_empty());

        let audit = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let entries: Vec<_> = audit.rows.iter().filter(|r| r.action == "import").collect();
        assert_eq!(
            entries.len(),
            1,
            "expected exactly one import entry, got {:?}",
            audit.rows
        );
        let entry = entries[0];
        assert_eq!(entry.actor_username.as_deref(), Some("editor"));
        assert_eq!(entry.actor_role.as_deref(), Some("editor"));
        assert_eq!(entry.resource, "items");
        assert_eq!(entry.entity_id, None);
        assert_eq!(entry.origin, "tauri");
        assert_eq!(entry.result, "ok");
        let detail: serde_json::Value =
            serde_json::from_str(entry.detail.as_deref().expect("detail should be set")).unwrap();
        assert_eq!(detail, serde_json::json!({ "created": 1, "updated": 1 }));
    }

    /// A per-row validation error rolls the whole batch back - including the
    /// otherwise-valid row in the same batch - and is recorded as a single
    /// `result: "failed"` entry summarizing the error count (spec M15).
    #[tokio::test]
    async fn items_import_validation_error_rolls_back_and_is_recorded_as_failed() {
        let state = app_state().await;
        let editor = state
            .users
            .create_user("editor", "password123", "編集者", Role::Editor)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(editor)));

        // `app_state()` is backed by `init_db_memory` (spec §12), which
        // seeds 1,000 demo rows - capture that baseline rather than
        // asserting an absolute `0` below, since this test cares about "did
        // the import add anything", not "is the table empty".
        let before = state
            .items
            .list(ListParams::default())
            .await
            .expect("list")
            .total_count;

        let result = items_import_body(
            &state,
            vec![
                ItemImportRow {
                    id: None,
                    name: "Valid".to_string(),
                    price: 10,
                    stock: 1,
                },
                ItemImportRow {
                    id: None,
                    name: "".to_string(), // fails validation
                    price: 1,
                    stock: 1,
                },
            ],
        )
        .await
        .expect("items_import_body should return Ok with row errors, not Err");
        assert_eq!(result.created, 0);
        assert_eq!(result.updated, 0);
        assert_eq!(result.errors.len(), 1);

        let list = state.items.list(ListParams::default()).await.expect("list");
        assert_eq!(
            list.total_count, before,
            "a rolled-back import must not leave partial rows"
        );

        let audit = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let entry = audit
            .rows
            .iter()
            .find(|r| r.action == "import")
            .unwrap_or_else(|| panic!("expected an import entry, got {:?}", audit.rows));
        assert_eq!(entry.result, "failed");
        assert_eq!(entry.actor_username.as_deref(), Some("editor"));
        let detail: serde_json::Value =
            serde_json::from_str(entry.detail.as_deref().expect("detail should be set")).unwrap();
        assert_eq!(detail, serde_json::json!({ "errorCount": 1 }));
    }

    /// `viewer` cannot import (spec M15: editor+ only, same `require_role`
    /// floor as `items_create`/`update`/`delete`).
    #[tokio::test]
    async fn viewer_cannot_import_items() {
        let state = app_state().await;
        let viewer = state
            .users
            .create_user("viewer", "password123", "閲覧者", Role::Viewer)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(viewer)));
        let before = state
            .items
            .list(ListParams::default())
            .await
            .expect("list")
            .total_count;

        let err = items_import_body(
            &state,
            vec![ItemImportRow {
                id: None,
                name: "Nope".to_string(),
                price: 1,
                stock: 1,
            }],
        )
        .await
        .unwrap_err();
        assert!(matches!(err, BantoError::Forbidden));

        let list = state.items.list(ListParams::default()).await.expect("list");
        assert_eq!(
            list.total_count, before,
            "a forbidden import must not touch the table"
        );
    }
    // [scaffold:items] end

    // --- M17: SQLite backup/restore -------------------------------------------

    /// `admin` can create a backup, and it is recorded as `action: "backup"`
    /// with `entityId` = the created file name (spec M17).
    #[tokio::test]
    async fn backups_create_records_a_backup_audit_entry() {
        let (state, _dir) = app_state_with_tempdir().await;
        let admin = state
            .users
            .create_user("admin", "password123", "管理者", Role::Admin)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(admin)));

        let info = backups_create_body(&state)
            .await
            .expect("backups_create_body should succeed");
        assert!(info.file_name.starts_with("banto-"));
        assert!(info.size_bytes > 0);

        let listed = state.backup.list().await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].file_name, info.file_name);

        let audit = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let entry = audit
            .rows
            .iter()
            .find(|r| r.action == "backup")
            .unwrap_or_else(|| panic!("expected a backup entry, got {:?}", audit.rows));
        assert_eq!(entry.actor_username.as_deref(), Some("admin"));
        assert_eq!(entry.resource, "backups");
        assert_eq!(entry.entity_id.as_deref(), Some(info.file_name.as_str()));
        assert_eq!(entry.origin, "tauri");
        assert_eq!(entry.result, "ok");
    }

    /// A `viewer` cannot create a backup (spec M17: "admin以外は全API 403"
    /// on the Tauri side too).
    #[tokio::test]
    async fn viewer_cannot_create_backups() {
        let (state, _dir) = app_state_with_tempdir().await;
        let viewer = state
            .users
            .create_user("viewer", "password123", "閲覧者", Role::Viewer)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(viewer)));

        let err = backups_create_body(&state).await.unwrap_err();
        assert!(matches!(err, BantoError::Forbidden));
        assert!(state.backup.list().await.unwrap().is_empty());
    }

    /// Stage a restore from an existing backup, then confirm it shows up as
    /// pending - the round trip `backups_create` -> `backups_stage_restore`
    /// -> `backups_pending` (spec M17), plus the `restore_staged` audit
    /// entry.
    #[tokio::test]
    async fn stage_restore_then_pending_reports_it() {
        let (state, _dir) = app_state_with_tempdir().await;
        let admin = state
            .users
            .create_user("admin", "password123", "管理者", Role::Admin)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(admin)));

        let info = backups_create_body(&state).await.expect("create");
        assert!(state.backup.pending_restore().await.is_none());

        backups_stage_restore_body(&state, &info.file_name)
            .await
            .expect("stage_restore should succeed");

        let pending = state
            .backup
            .pending_restore()
            .await
            .expect("should now be pending");
        assert!(pending.size_bytes > 0);

        let audit = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let entry = audit
            .rows
            .iter()
            .find(|r| r.action == "restore_staged")
            .unwrap_or_else(|| panic!("expected a restore_staged entry, got {:?}", audit.rows));
        assert_eq!(entry.actor_username.as_deref(), Some("admin"));
        assert_eq!(entry.resource, "backups");
        assert_eq!(entry.origin, "tauri");
        assert_eq!(entry.result, "ok");

        backups_cancel_restore_body(&state)
            .await
            .expect("cancel_restore should succeed");
        assert!(state.backup.pending_restore().await.is_none());

        let audit_after_cancel = state.audit.list(ListParams::default()).await.unwrap();
        assert!(
            audit_after_cancel
                .rows
                .iter()
                .any(|r| r.action == "restore_cancelled"),
            "expected a restore_cancelled entry, got {:?}",
            audit_after_cancel.rows
        );
    }

    // [scaffold:items] begin
    /// [`items_delete_body`] records one `delete`/`items` entry; with no
    /// attachments swept for the record, `detail` is `None` (M-review 2026-08
    /// M-5).
    #[tokio::test]
    async fn items_delete_is_recorded_as_delete() {
        let state = app_state().await;
        let editor = state
            .users
            .create_user("editor", "password123", "編集者", Role::Editor)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(editor)));
        let item = state
            .items
            .create(ItemInput {
                name: "Doomed".to_string(),
                price: 1,
                stock: 1,
            })
            .await
            .expect("seed item");

        items_delete_body(&state, item.id)
            .await
            .expect("delete should succeed");

        let audit = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let entry = audit
            .rows
            .iter()
            .find(|r| r.action == "delete" && r.resource == "items")
            .unwrap_or_else(|| panic!("expected a delete/items entry, got {:?}", audit.rows));
        assert_eq!(entry.actor_username.as_deref(), Some("editor"));
        assert_eq!(entry.actor_role.as_deref(), Some("editor"));
        assert_eq!(
            entry.entity_id.as_deref(),
            Some(item.id.to_string().as_str())
        );
        assert_eq!(entry.origin, "tauri");
        assert_eq!(entry.result, "ok");
        assert_eq!(entry.detail, None, "no attachments removed -> detail None");
    }
    // [scaffold:items] end

    /// [`auth_config_apply_body`]'s normal (non-escape-hatch) path records a
    /// `settings_change`/`settings` entry attributed to the admin, with an
    /// `{authDisabled}` detail (M-review 2026-08 M-5).
    #[tokio::test]
    async fn auth_config_apply_is_recorded_as_settings_change() {
        let state = app_state().await;
        let admin = state
            .users
            .setup_first_user("admin", "password123", "管理者")
            .await
            .expect("setup_first_user");
        state.set_session_for_test(Some(DesktopSession::Account(admin)));

        auth_config_apply_body(&state, true, "viewer")
            .await
            .expect("auth_config_apply should succeed");

        let audit = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let entry = audit
            .rows
            .iter()
            .find(|r| r.action == "settings_change" && r.resource == "settings")
            .unwrap_or_else(|| panic!("expected a settings_change entry, got {:?}", audit.rows));
        assert_eq!(entry.actor_username.as_deref(), Some("admin"));
        assert_eq!(entry.actor_role.as_deref(), Some("admin"));
        assert_eq!(entry.entity_id, None);
        assert_eq!(entry.origin, "tauri");
        assert_eq!(entry.result, "ok");
        let detail: serde_json::Value =
            serde_json::from_str(entry.detail.as_deref().expect("detail present"))
                .expect("detail is json");
        assert_eq!(detail, serde_json::json!({ "authDisabled": true }));
    }

    /// [`auth_config_apply_body`]'s bootstrap window (choiapp-feedback-2026-09
    /// §5): with ZERO accounts and no session, enabling no-login mode from
    /// the first-run setup screen succeeds, records the `settings_change`
    /// with no actor, synthesizes the same "local" session `run()`'s
    /// bootstrap would, and records its synthetic `login` entry.
    #[tokio::test]
    async fn auth_config_apply_bootstrap_window_enables_and_synthesizes_session() {
        let state = app_state().await;

        let config = auth_config_apply_body(&state, true, "admin")
            .await
            .expect("bootstrap-window apply should succeed with zero users");
        assert!(config.disabled);

        let session = state
            .auth
            .lock()
            .expect("auth mutex poisoned")
            .session
            .clone()
            .expect("a synthetic session should exist without a restart");
        let DesktopSession::AuthDisabledLocal(session) = session else {
            panic!("the bootstrap window must install the synthetic kind, got {session:?}");
        };
        assert_eq!(session.username, "local");
        assert_eq!(session.role, Role::Admin);

        let audit = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let change = audit
            .rows
            .iter()
            .find(|r| r.action == "settings_change" && r.resource == "settings")
            .unwrap_or_else(|| panic!("expected a settings_change entry, got {:?}", audit.rows));
        assert_eq!(change.actor_username, None, "nobody exists yet");
        let login = audit
            .rows
            .iter()
            .find(|r| r.action == "login" && r.resource == "auth")
            .unwrap_or_else(|| panic!("expected a synthetic login entry, got {:?}", audit.rows));
        assert_eq!(login.actor_username.as_deref(), Some("local"));
        let detail: serde_json::Value =
            serde_json::from_str(login.detail.as_deref().expect("detail present"))
                .expect("detail is json");
        assert_eq!(detail, serde_json::json!({ "mode": "auth_disabled" }));
    }

    /// The bootstrap window closes the moment the first account exists
    /// (choiapp-feedback-2026-09 §5): once initialized, a session-less call
    /// is `Unauthorized` again, exactly as before the window existed.
    #[tokio::test]
    async fn auth_config_apply_bootstrap_window_closes_once_initialized() {
        let state = app_state().await;
        state
            .users
            .setup_first_user("admin", "password123", "管理者")
            .await
            .expect("setup_first_user");

        let err = auth_config_apply_body(&state, true, "admin")
            .await
            .expect_err("a session-less apply must be rejected once initialized");
        assert!(matches!(err, BantoError::Unauthorized));
    }

    /// [`autologin_enable_body`] records a `settings_change`/`settings` entry
    /// with an `{autologinEnabled,username}` detail (M-review 2026-08 M-5).
    /// Installs the in-memory keyring first so `keyring_store::set_password`
    /// does not hit the OS secret service on a headless CI runner (the Linux
    /// leg has no D-Bus/secret-service).
    #[tokio::test]
    async fn autologin_enable_is_recorded_as_settings_change() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let state = app_state().await;
        let admin = state
            .users
            .setup_first_user("admin", "password123", "管理者")
            .await
            .expect("setup_first_user");
        state.set_session_for_test(Some(DesktopSession::Account(admin)));

        autologin_enable_body(&state, "admin", "password123")
            .await
            .expect("autologin_enable should succeed");

        let audit = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let entry = audit
            .rows
            .iter()
            .find(|r| r.action == "settings_change" && r.resource == "settings")
            .unwrap_or_else(|| panic!("expected a settings_change entry, got {:?}", audit.rows));
        assert_eq!(entry.actor_username.as_deref(), Some("admin"));
        assert_eq!(entry.entity_id, None);
        assert_eq!(entry.result, "ok");
        let detail: serde_json::Value =
            serde_json::from_str(entry.detail.as_deref().expect("detail present"))
                .expect("detail is json");
        assert_eq!(
            detail,
            serde_json::json!({ "autologinEnabled": true, "username": "admin" })
        );
    }

    /// [`autologin_disable_body`] records a `settings_change`/`settings` entry
    /// with an `{autologinEnabled:false}` detail (M-review 2026-08 M-5). No
    /// keyring is touched: with `autologin_username` unset the delete is
    /// skipped.
    #[tokio::test]
    async fn autologin_disable_is_recorded_as_settings_change() {
        let state = app_state().await;
        let admin = state
            .users
            .setup_first_user("admin", "password123", "管理者")
            .await
            .expect("setup_first_user");
        state.set_session_for_test(Some(DesktopSession::Account(admin)));

        autologin_disable_body(&state)
            .await
            .expect("autologin_disable should succeed");

        let audit = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let entry = audit
            .rows
            .iter()
            .find(|r| r.action == "settings_change" && r.resource == "settings")
            .unwrap_or_else(|| panic!("expected a settings_change entry, got {:?}", audit.rows));
        assert_eq!(entry.actor_username.as_deref(), Some("admin"));
        assert_eq!(entry.entity_id, None);
        assert_eq!(entry.result, "ok");
        let detail: serde_json::Value =
            serde_json::from_str(entry.detail.as_deref().expect("detail present"))
                .expect("detail is json");
        assert_eq!(detail, serde_json::json!({ "autologinEnabled": false }));
    }

    // --- M20: attachments command tests -----------------------------------
    // scaffold.mjs (`removeAttachmentsFromLibRs`) cuts this whole block for
    // the minimal/standard presets, exactly as it removes the attachments
    // commands themselves. These tests reference ONLY `attachments_*_body`
    // (also removed by scaffold), so nothing survives the cut - keep it that
    // way if you add more here.

    /// [`attachments_upload_body`] records a `create`/`attachments` entry with
    /// the `{fileName,sizeBytes,parentResource,parentId}` detail (M-review
    /// 2026-08 M-5). Uses a real temp attachments dir so the upload can write.
    #[tokio::test]
    async fn attachments_upload_is_recorded_as_create() {
        let (state, _dir) = app_state_with_tempdir().await;
        let editor = state
            .users
            .create_user("editor", "password123", "編集者", Role::Editor)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(editor)));

        let meta = attachments_upload_body(
            &state,
            "items".to_string(),
            "1".to_string(),
            "note.txt".to_string(),
            b"hello attachment".to_vec(),
        )
        .await
        .expect("upload should succeed");

        let audit = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let entry = audit
            .rows
            .iter()
            .find(|r| r.action == "create" && r.resource == "attachments")
            .unwrap_or_else(|| panic!("expected a create/attachments entry, got {:?}", audit.rows));
        assert_eq!(entry.actor_username.as_deref(), Some("editor"));
        assert_eq!(
            entry.entity_id.as_deref(),
            Some(meta.id.to_string().as_str())
        );
        assert_eq!(entry.origin, "tauri");
        assert_eq!(entry.result, "ok");
        let detail: serde_json::Value =
            serde_json::from_str(entry.detail.as_deref().expect("detail present"))
                .expect("detail is json");
        assert_eq!(
            detail,
            serde_json::json!({
                "fileName": "note.txt",
                "sizeBytes": 16,
                "parentResource": "items",
                "parentId": "1"
            })
        );
    }

    /// [`attachments_delete_body`] records a `delete`/`attachments` entry with
    /// the deleted meta's detail (M-review 2026-08 M-5). Seeds one attachment
    /// via [`attachments_upload_body`] (transitively exercising its happy
    /// path).
    #[tokio::test]
    async fn attachments_delete_is_recorded_as_delete() {
        let (state, _dir) = app_state_with_tempdir().await;
        let editor = state
            .users
            .create_user("editor", "password123", "編集者", Role::Editor)
            .await
            .expect("create_user");
        state.set_session_for_test(Some(DesktopSession::Account(editor)));
        let meta = attachments_upload_body(
            &state,
            "items".to_string(),
            "1".to_string(),
            "note.txt".to_string(),
            b"hello attachment".to_vec(),
        )
        .await
        .expect("seed upload");

        attachments_delete_body(&state, meta.id)
            .await
            .expect("delete should succeed");

        let audit = state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list");
        let entry = audit
            .rows
            .iter()
            .find(|r| r.action == "delete" && r.resource == "attachments")
            .unwrap_or_else(|| panic!("expected a delete/attachments entry, got {:?}", audit.rows));
        assert_eq!(
            entry.entity_id.as_deref(),
            Some(meta.id.to_string().as_str())
        );
        assert_eq!(entry.result, "ok");
        let detail: serde_json::Value =
            serde_json::from_str(entry.detail.as_deref().expect("detail present"))
                .expect("detail is json");
        assert_eq!(
            detail,
            serde_json::json!({
                "fileName": "note.txt",
                "sizeBytes": 16,
                "parentResource": "items",
                "parentId": "1"
            })
        );
    }
    // --- end M20 attachments command tests ---------------------------------

    // --- Issue #204: session revocation across transports and processes ----
    //
    // Two (or three) `AppState`s over ONE on-disk DB, each with its own pool,
    // stand for separate app processes. One of them also serves the REST
    // account routes (a real TCP server, driven with plain HTTP/1.1 so this
    // crate needs no HTTP client dependency).

    use banto_server::routes::{extra_auth_router, users_router};
    use banto_server::{auth_routes, start, LoginOutcome};

    const REVOCATION_PASSWORD: &str = "password123";

    #[derive(Clone, Copy, Debug)]
    enum AccountChange {
        Delete,
        Demote,
        PasswordChange,
        PasswordReset,
    }

    const ALL_CHANGES: [AccountChange; 4] = [
        AccountChange::Delete,
        AccountChange::Demote,
        AccountChange::PasswordChange,
        AccountChange::PasswordReset,
    ];

    /// `operator` (admin), `bystander` (editor, never affected) and `target`
    /// (admin, the account changed; its id is returned), in the DB behind
    /// `state`.
    async fn seed_revocation_accounts(state: &AppState) -> i64 {
        state
            .users
            .setup_first_user("operator", REVOCATION_PASSWORD, "操作者")
            .await
            .expect("setup_first_user");
        state
            .users
            .create_user("bystander", REVOCATION_PASSWORD, "無関係", Role::Editor)
            .await
            .expect("create bystander");
        state
            .users
            .create_user("target", REVOCATION_PASSWORD, "対象", Role::Admin)
            .await
            .expect("create target")
            .id
    }

    /// The webview session `auth_login` establishes (same verify + store).
    async fn desktop_login(state: &AppState, username: &str) {
        let user = state
            .users
            .verify(username, REVOCATION_PASSWORD)
            .await
            .unwrap()
            .expect("valid credentials");
        state.set_session_for_test(Some(DesktopSession::Account(user)));
    }

    /// A LAN session on `state`'s embedded-server auth state.
    async fn rest_token(state: &AppState, username: &str, remember: bool) -> String {
        match state
            .rest_auth
            .login_rate_limited(None, username, REVOCATION_PASSWORD, remember)
            .await
        {
            LoginOutcome::Success(token) => token,
            other => panic!("REST login of {username} failed: {other:?}"),
        }
    }

    /// The account routes of the embedded server, on an OS-picked port.
    async fn serve_account_routes(state: &AppState) -> RunningServer {
        let router = users_router(
            state.users.clone(),
            state.audit.clone(),
            state.rest_auth.clone(),
        )
        .merge(extra_auth_router(
            state.users.clone(),
            state.rest_auth.clone(),
            state.audit.clone(),
            false,
            state.settings.clone(),
            None,
        ))
        .merge(auth_routes(state.rest_auth.clone()));
        start(
            ServerConfig {
                bind: "127.0.0.1".to_string(),
                port: 0,
            },
            router,
        )
        .await
        .expect("start test server")
    }

    /// One HTTP/1.1 request; returns (status, raw body).
    async fn http(
        server: &RunningServer,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> (u16, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let addr = server.local_addr();
        let body = body.map(|value| value.to_string()).unwrap_or_default();
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\
             X-Banto-Client: banto\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\n",
            body.len()
        );
        if let Some(token) = token {
            request.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        request.push_str("\r\n");
        request.push_str(&body);
        let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
        stream.write_all(request.as_bytes()).await.expect("write");
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.expect("read");
        let text = String::from_utf8_lossy(&response).into_owned();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or_else(|| panic!("malformed response: {text}"));
        let body = text
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.to_string())
            .unwrap_or_default();
        (status, body)
    }

    async fn rest_session_is_live(server: &RunningServer, token: &str) -> bool {
        let (status, body) = http(server, "GET", "/api/auth/check", Some(token), None).await;
        assert_eq!(status, 200, "check: {body}");
        body.contains("true")
    }

    fn assert_unauthorized<T: std::fmt::Debug>(result: Result<T, BantoError>, what: &str) {
        match result {
            Err(BantoError::Unauthorized) => {}
            other => panic!("{what}: expected Unauthorized, got {other:?}"),
        }
    }

    /// The target's desktop session in `state` must be gone: guarded
    /// commands refuse it (the issue's scenario: creating an admin), and the
    /// cached session is cleared.
    async fn assert_desktop_session_ended(state: &AppState, change: AccountChange) {
        assert_unauthorized(
            users_create_body(
                state,
                "intruder",
                REVOCATION_PASSWORD,
                "侵入者",
                Role::Admin,
            )
            .await,
            &format!("{change:?}: users_create from the old desktop session"),
        );
        assert_unauthorized(
            require_role(state, Role::Viewer, "items").await,
            &format!("{change:?}: any role from the old desktop session"),
        );
        assert!(
            state
                .auth
                .lock()
                .expect("auth mutex poisoned")
                .session
                .is_none(),
            "{change:?}: the ended desktop session must be cleared"
        );
        assert!(state
            .users
            .get_by_username("intruder")
            .await
            .unwrap()
            .is_none());
    }

    /// The target's LAN sessions (regular + Remember me) must be refused.
    async fn assert_lan_sessions_ended(
        server: &RunningServer,
        tokens: [&str; 2],
        change: AccountChange,
    ) {
        for (label, token) in ["regular", "remember-me"].into_iter().zip(tokens) {
            let intruder = serde_json::json!({
                "username": format!("intruder-{label}"),
                "password": REVOCATION_PASSWORD,
                "displayName": "侵入者",
                "role": "admin",
            });
            let (status, _) = http(server, "POST", "/api/users", Some(token), Some(intruder)).await;
            assert_eq!(status, 401, "{change:?}: the {label} LAN session");
            assert!(
                !rest_session_is_live(server, token).await,
                "{change:?}: the {label} LAN session must report logged out"
            );
        }
    }

    /// A change made from a DESKTOP (Tauri command bodies) ends the
    /// account's desktop session in another process and its LAN sessions.
    #[tokio::test]
    async fn desktop_changes_end_the_accounts_other_desktop_and_lan_sessions() {
        for change in ALL_CHANGES {
            let dir = tempfile::tempdir().expect("tempdir");
            let operator_desktop = app_state_in(&dir).await;
            let target_desktop = app_state_in(&dir).await;
            let target_id = seed_revocation_accounts(&operator_desktop).await;
            desktop_login(&operator_desktop, "operator").await;
            desktop_login(&target_desktop, "target").await;
            let server = serve_account_routes(&operator_desktop).await;
            let target_regular = rest_token(&operator_desktop, "target", false).await;
            let target_remembered = rest_token(&operator_desktop, "target", true).await;
            let bystander = rest_token(&operator_desktop, "bystander", true).await;
            assert!(require_role(&target_desktop, Role::Admin, "users")
                .await
                .is_ok());
            assert!(rest_session_is_live(&server, &target_remembered).await);

            let self_service_desktop = match change {
                AccountChange::Delete => {
                    users_delete_body(&operator_desktop, target_id)
                        .await
                        .unwrap();
                    None
                }
                AccountChange::Demote => {
                    users_update_body(&operator_desktop, target_id, "対象", Role::Viewer)
                        .await
                        .unwrap();
                    None
                }
                AccountChange::PasswordReset => {
                    users_reset_password_body(&operator_desktop, target_id, "resetpassword1")
                        .await
                        .unwrap();
                    None
                }
                AccountChange::PasswordChange => {
                    // The target changes it from a THIRD desktop process.
                    let own = app_state_in(&dir).await;
                    desktop_login(&own, "target").await;
                    change_own_password(&own, REVOCATION_PASSWORD, "newpassword1")
                        .await
                        .unwrap();
                    Some(own)
                }
            };

            assert_desktop_session_ended(&target_desktop, change).await;
            assert_lan_sessions_ended(&server, [&target_regular, &target_remembered], change).await;
            assert!(
                require_role(&operator_desktop, Role::Admin, "users")
                    .await
                    .is_ok(),
                "{change:?}: the operator's desktop session must survive"
            );
            assert!(
                rest_session_is_live(&server, &bystander).await,
                "{change:?}: the bystander's LAN session must survive"
            );
            if let Some(own) = self_service_desktop {
                assert!(
                    require_role(&own, Role::Admin, "users").await.is_ok(),
                    "{change:?}: the desktop that changed the password keeps its session"
                );
            }
            server.stop().await;
        }
    }

    /// A change made over REST (the embedded LAN server) ends the account's
    /// desktop session - in another process - and its other LAN sessions.
    #[tokio::test]
    async fn lan_changes_end_the_accounts_desktop_and_other_lan_sessions() {
        for change in ALL_CHANGES {
            let dir = tempfile::tempdir().expect("tempdir");
            let host = app_state_in(&dir).await;
            let target_desktop = app_state_in(&dir).await;
            let target_id = seed_revocation_accounts(&host).await;
            desktop_login(&host, "bystander").await;
            desktop_login(&target_desktop, "target").await;
            let server = serve_account_routes(&host).await;
            let operator = rest_token(&host, "operator", false).await;
            let target_regular = rest_token(&host, "target", false).await;
            let target_remembered = rest_token(&host, "target", true).await;

            let survivor = match change {
                AccountChange::Delete => {
                    let path = format!("/api/users/{target_id}");
                    let (status, _) = http(&server, "DELETE", &path, Some(&operator), None).await;
                    assert_eq!(status, 204);
                    None
                }
                AccountChange::Demote => {
                    let path = format!("/api/users/{target_id}");
                    let body = serde_json::json!({ "displayName": "対象", "role": "viewer" });
                    let (status, _) =
                        http(&server, "PUT", &path, Some(&operator), Some(body)).await;
                    assert_eq!(status, 200);
                    None
                }
                AccountChange::PasswordReset => {
                    let path = format!("/api/users/{target_id}/reset-password");
                    let body = serde_json::json!({ "newPassword": "resetpassword1" });
                    let (status, _) =
                        http(&server, "POST", &path, Some(&operator), Some(body)).await;
                    assert_eq!(status, 200);
                    None
                }
                AccountChange::PasswordChange => {
                    let device = rest_token(&host, "target", false).await;
                    let body = serde_json::json!({
                        "currentPassword": REVOCATION_PASSWORD,
                        "newPassword": "newpassword1",
                    });
                    let (status, _) = http(
                        &server,
                        "POST",
                        "/api/auth/change-password",
                        Some(&device),
                        Some(body),
                    )
                    .await;
                    assert_eq!(status, 200);
                    Some(device)
                }
            };

            assert_desktop_session_ended(&target_desktop, change).await;
            assert_lan_sessions_ended(&server, [&target_regular, &target_remembered], change).await;
            assert!(
                require_role(&host, Role::Viewer, "items").await.is_ok(),
                "{change:?}: the bystander's desktop session must survive"
            );
            assert!(
                rest_session_is_live(&server, &operator).await,
                "{change:?}: the operator's LAN session must survive"
            );
            if let Some(device) = survivor {
                assert!(
                    rest_session_is_live(&server, &device).await,
                    "{change:?}: the LAN session that changed the password keeps working"
                );
            }
            server.stop().await;
        }
    }

    /// A display-name edit is not a revocation, and the desktop session
    /// picks up the new name from the DB (not the login-time copy).
    #[tokio::test]
    async fn desktop_session_follows_a_display_name_edit_without_ending() {
        let dir = tempfile::tempdir().expect("tempdir");
        let operator_desktop = app_state_in(&dir).await;
        let target_desktop = app_state_in(&dir).await;
        let target_id = seed_revocation_accounts(&operator_desktop).await;
        desktop_login(&operator_desktop, "operator").await;
        desktop_login(&target_desktop, "target").await;

        users_update_body(&operator_desktop, target_id, "対象（改名）", Role::Admin)
            .await
            .unwrap();

        let current = require_role(&target_desktop, Role::Admin, "users")
            .await
            .expect("the session survives");
        assert_eq!(current.display_name, "対象（改名）");
    }

    /// Review of #230: a check whose read was in flight while this session's
    /// own password change committed and re-bound it must not report it as
    /// ended. The read is "held" by running `current_session`'s two halves
    /// with the change in between: snapshot (epoch 0) -> change + re-bind
    /// (epoch 1) -> read (epoch 1) -> settle.
    #[tokio::test]
    async fn a_desktop_session_rebound_while_its_check_was_in_flight_stays_valid() {
        let dir = tempfile::tempdir().expect("tempdir");
        let changer = app_state_in(&dir).await;
        let other = app_state_in(&dir).await;
        seed_revocation_accounts(&changer).await;
        desktop_login(&changer, "target").await;
        desktop_login(&other, "target").await;
        let snapshot = |state: &AppState| {
            let (session, seq) = read_slot(state);
            (session.expect("a session"), seq)
        };
        let (changer_before, changer_seq) = snapshot(&changer);
        let (other_before, other_seq) = snapshot(&other);

        change_own_password(&changer, REVOCATION_PASSWORD, "newpassword1")
            .await
            .expect("password change");

        // Issue #260: the re-bind advanced the slot's `seq`, so the settle
        // writes nothing and reports `Stale`; the ordinary commands'
        // `current_session` still takes the re-bound session as valid.
        let fresh = read_session_source(&changer, &changer_before)
            .await
            .unwrap();
        match settle_session(&changer, &changer_before, fresh, changer_seq) {
            Settled::Stale {
                valid_now: Some(DesktopSession::Account(user)),
            } => assert_eq!(user.auth_epoch, 1),
            other => panic!("the re-bound session must stay valid, got {other:?}"),
        }
        assert!(require_role(&changer, Role::Admin, "users").await.is_ok());

        // The same interleaving for a session that was NOT re-bound: the
        // store's new epoch is not adopted on its behalf.
        let fresh = read_session_source(&other, &other_before).await.unwrap();
        assert!(matches!(
            settle_session(&other, &other_before, fresh, other_seq),
            Settled::Settled { session: None, .. }
        ));
        assert!(other
            .auth
            .lock()
            .expect("auth mutex poisoned")
            .session
            .is_none());
    }

    /// Re-creating a deleted account under the same username (a new row id,
    /// epoch 0 again) must not revive the old account's desktop session.
    #[tokio::test]
    async fn a_recreated_account_does_not_inherit_the_old_desktop_session() {
        let dir = tempfile::tempdir().expect("tempdir");
        let operator_desktop = app_state_in(&dir).await;
        let target_desktop = app_state_in(&dir).await;
        let target_id = seed_revocation_accounts(&operator_desktop).await;
        desktop_login(&operator_desktop, "operator").await;
        desktop_login(&target_desktop, "target").await;

        users_delete_body(&operator_desktop, target_id)
            .await
            .unwrap();
        users_create_body(
            &operator_desktop,
            "target",
            REVOCATION_PASSWORD,
            "別人",
            Role::Admin,
        )
        .await
        .unwrap();

        assert_unauthorized(
            require_role(&target_desktop, Role::Viewer, "items").await,
            "the old session of a re-created username",
        );
    }

    /// The synthetic auth-disabled session has no `users` row: it works with no
    /// accounts at all, and is checked against the mode instead.
    #[tokio::test]
    async fn the_auth_disabled_local_session_lives_only_while_the_mode_is_on() {
        let state = app_state().await;
        let enable = |disabled: bool| {
            let settings = state.settings.clone();
            async move {
                let config = settings.auth_config().await.unwrap();
                settings
                    .set_auth_config(&AuthSettings { disabled, ..config })
                    .await
                    .unwrap();
            }
        };
        enable(true).await;
        state.set_session_for_test(Some(DesktopSession::AuthDisabledLocal(UserIdentity {
            id: LOCAL_SESSION_ID,
            username: "local".to_string(),
            display_name: "ローカルユーザー".to_string(),
            role: Role::Admin,
            auth_epoch: 0,
        })));
        assert!(require_role(&state, Role::Admin, "settings").await.is_ok());

        // ...but only while auth-disabled mode is on: turning it off ends
        // the synthetic session on the next command.
        enable(false).await;
        assert_unauthorized(
            require_role(&state, Role::Viewer, "settings").await,
            "the local session after auth-disabled mode was turned off",
        );
        assert!(state
            .auth
            .lock()
            .expect("auth mutex poisoned")
            .session
            .is_none());
    }

    /// A `users` row that happens to have the synthetic session's display id
    /// (0) is still an account: validated, and revoked when it changes.
    #[tokio::test]
    async fn an_account_with_id_zero_is_still_revalidated() {
        let state = app_state().await;
        seed_revocation_accounts(&state).await;
        let mut user = state
            .users
            .verify("target", REVOCATION_PASSWORD)
            .await
            .unwrap()
            .unwrap();
        user.id = LOCAL_SESSION_ID;
        state.set_session_for_test(Some(DesktopSession::Account(user)));
        assert_unauthorized(
            require_role(&state, Role::Viewer, "items").await,
            "an account session whose id does not match its row",
        );
    }

    // --- Issue #260: the session slot's seq and compare-and-set ------------
    //
    // docs/session-controller-design.md §4.3/§8.3: the command BODIES are
    // driven with their slow `.await` (verify / first-user setup / auth-mode
    // read) held at an injected gate, so the completion order is fixed by
    // the test, not by the scheduler.

    use tokio::sync::oneshot;

    const SLOT_PASSWORD: &str = "password123";

    /// The test's end of a one-shot gate: `entered` resolves once the held
    /// command reached the injected `.await`; sending on `release` lets it
    /// continue.
    struct Hold {
        entered: oneshot::Receiver<()>,
        release: oneshot::Sender<()>,
    }

    type GateSlot = Arc<Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>>;

    fn gate() -> (GateSlot, Hold) {
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        (
            Arc::new(Mutex::new(Some((entered_tx, release_rx)))),
            Hold {
                entered: entered_rx,
                release: release_tx,
            },
        )
    }

    /// The FIRST caller through `gate` stops here until released; later
    /// callers pass straight through.
    async fn pass_gate(gate: &GateSlot) {
        let taken = gate.lock().expect("gate mutex").take();
        if let Some((entered, release)) = taken {
            let _ = entered.send(());
            let _ = release.await;
        }
    }

    /// Hold the first `auth_login` verification of `state`.
    fn hold_verify(state: &mut AppState) -> Hold {
        let (slot, hold) = gate();
        let users = state.users.clone();
        state.auth_io.verify = Arc::new(move |username, password| {
            let slot = slot.clone();
            let users = users.clone();
            Box::pin(async move {
                pass_gate(&slot).await;
                users.verify(&username, &password).await
            })
        });
        hold
    }

    /// Hold the first `auth_setup` account creation of `state`.
    fn hold_setup(state: &mut AppState) -> Hold {
        let (slot, hold) = gate();
        let users = state.users.clone();
        state.auth_io.setup_first_user = Arc::new(move |username, password, display_name| {
            let slot = slot.clone();
            let users = users.clone();
            Box::pin(async move {
                pass_gate(&slot).await;
                users
                    .setup_first_user(&username, &password, &display_name)
                    .await
            })
        });
        hold
    }

    /// Hold the first `auth_logout` auth-mode read of `state`.
    fn hold_auth_mode(state: &mut AppState) -> Hold {
        let (slot, hold) = gate();
        let settings = state.settings.clone();
        state.auth_io.auth_mode = Arc::new(move || {
            let slot = slot.clone();
            let settings = settings.clone();
            Box::pin(async move {
                pass_gate(&slot).await;
                settings.auth_config().await
            })
        });
        hold
    }

    /// Hold the `nth` (1-based) auth-mode read of `state` - whichever command
    /// makes it - either before the settings read (`after_read: false`, the
    /// held read sees what is stored when it is released) or after it
    /// (`true`, the held command carries the value read BEFORE the hold).
    fn hold_auth_mode_call(state: &mut AppState, nth: usize, after_read: bool) -> Hold {
        let (slot, hold) = gate();
        let settings = state.settings.clone();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        state.auth_io.auth_mode = Arc::new(move || {
            let (slot, settings, calls) = (slot.clone(), settings.clone(), calls.clone());
            Box::pin(async move {
                let this = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                if this != nth {
                    return settings.auth_config().await;
                }
                if after_read {
                    let config = settings.auth_config().await;
                    pass_gate(&slot).await;
                    config
                } else {
                    pass_gate(&slot).await;
                    settings.auth_config().await
                }
            })
        });
        hold
    }

    fn is_local(session: &Option<DesktopSession>) -> bool {
        matches!(session, Some(DesktopSession::AuthDisabledLocal(user)) if user.username == "local")
    }

    async fn audit_action_count(state: &AppState, action: &str) -> usize {
        state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list")
            .rows
            .iter()
            .filter(|row| row.action == action)
            .count()
    }

    /// Poll `$fut` until the command reaches its gate (it must not finish
    /// first).
    macro_rules! run_until_held {
        ($fut:expr, $hold:expr) => {{
            tokio::select! {
                biased;
                out = &mut $fut => panic!("finished before reaching the gate: {out:?}"),
                _ = &mut $hold.entered => {}
            }
        }};
    }

    fn is_account(session: &Option<DesktopSession>, username: &str) -> bool {
        matches!(session, Some(DesktopSession::Account(user)) if user.username == username)
    }

    /// S-16: a login whose verification is overtaken by a completed logout
    /// must not revive a session (design §1.3 order 1).
    #[tokio::test]
    async fn s16_a_slow_login_does_not_undo_a_completed_logout() {
        let mut state = app_state().await;
        state
            .users
            .setup_first_user("b", SLOT_PASSWORD, "B")
            .await
            .unwrap();
        let mut hold = hold_verify(&mut state);

        let login = login_body(&state, "b".to_string(), SLOT_PASSWORD.to_string());
        tokio::pin!(login);
        run_until_held!(login, hold);

        let logout = logout_body(&state).await.expect("logout");
        assert_eq!(logout.seq, 1, "a logout of no session still advances seq");
        hold.release.send(()).unwrap();
        let result = login.await.expect("login");

        assert!(!result.success);
        assert!(result.superseded);
        assert_eq!(result.seq, 1);
        assert_eq!(read_slot(&state), (None, 1));
        assert_eq!(audit_action_count(&state, "login").await, 1, "verified");
        assert_eq!(audit_action_count(&state, "logout").await, 0);
    }

    /// S-16 (wiring): the login must compare against the seq read BEFORE its
    /// first `.await` - any seq advance while it is held makes it superseded.
    #[tokio::test]
    async fn s16_login_reads_seq_before_its_first_await() {
        let mut state = app_state().await;
        state
            .users
            .setup_first_user("b", SLOT_PASSWORD, "B")
            .await
            .unwrap();
        let mut hold = hold_verify(&mut state);

        let login = login_body(&state, "b".to_string(), SLOT_PASSWORD.to_string());
        tokio::pin!(login);
        run_until_held!(login, hold);

        let (_, seq) = read_slot(&state);
        assert_eq!(cas_session(&state, seq, None), (true, seq + 1));
        hold.release.send(()).unwrap();
        let result = login.await.expect("login");

        assert!(result.superseded);
        assert_eq!(read_slot(&state), (None, seq + 1));
    }

    /// S-16 (control): the same login with nothing in between installs the
    /// session and advances seq; a failed login leaves the slot alone.
    #[tokio::test]
    async fn s16_an_uncontested_login_installs_and_advances_seq() {
        let state = app_state().await;
        state
            .users
            .setup_first_user("b", SLOT_PASSWORD, "B")
            .await
            .unwrap();

        let result = login_body(&state, "b".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");

        assert!(result.success);
        assert!(!result.superseded);
        assert_eq!(result.seq, 1);
        let (session, seq) = read_slot(&state);
        assert_eq!(seq, 1);
        assert!(is_account(&session, "b"));

        let failed = login_body(&state, "b".to_string(), "wrong-password".to_string())
            .await
            .expect("login");
        assert!(!failed.success);
        assert!(!failed.superseded);
        assert_eq!(failed.seq, 1, "a failed login does not touch the slot");
    }

    /// S-17: a logout whose settings read is overtaken by a completed login
    /// must not clear that login's session, and records no `logout`.
    #[tokio::test]
    async fn s17_a_slow_logout_does_not_clear_a_later_login() {
        let mut state = app_state().await;
        state
            .users
            .setup_first_user("b", SLOT_PASSWORD, "B")
            .await
            .unwrap();
        let mut hold = hold_auth_mode(&mut state);

        let logout = logout_body(&state);
        tokio::pin!(logout);
        run_until_held!(logout, hold);

        let login = login_body(&state, "b".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");
        assert!(login.success);
        hold.release.send(()).unwrap();
        let result = logout.await.expect("logout");

        assert_eq!(
            result.seq, login.seq,
            "the overtaken logout changes nothing"
        );
        let (session, seq) = read_slot(&state);
        assert_eq!(seq, login.seq);
        assert!(is_account(&session, "b"));
        assert_eq!(audit_action_count(&state, "logout").await, 0);
    }

    /// S-17 (wiring): the logout compares against the seq read before its
    /// first `.await` - a re-bind while it is held (even to the same
    /// account) keeps the session.
    #[tokio::test]
    async fn s17_logout_reads_seq_before_its_first_await() {
        let mut state = app_state().await;
        let a = state
            .users
            .setup_first_user("a", SLOT_PASSWORD, "A")
            .await
            .unwrap();
        state.set_session_for_test(Some(DesktopSession::Account(a.clone())));
        let mut hold = hold_auth_mode(&mut state);

        let logout = logout_body(&state);
        tokio::pin!(logout);
        run_until_held!(logout, hold);

        let (_, seq) = read_slot(&state);
        let rebound = Some(DesktopSession::Account(a));
        assert_eq!(cas_session(&state, seq, rebound.clone()), (true, seq + 1));
        hold.release.send(()).unwrap();
        let result = logout.await.expect("logout");

        assert_eq!(result.seq, seq + 1);
        assert_eq!(read_slot(&state), (rebound, seq + 1));
    }

    /// S-17 (control): an uncontested logout clears, advances seq, and is
    /// audited.
    #[tokio::test]
    async fn s17_an_uncontested_logout_clears_and_advances_seq() {
        let state = app_state().await;
        let a = state
            .users
            .setup_first_user("a", SLOT_PASSWORD, "A")
            .await
            .unwrap();
        state.set_session_for_test(Some(DesktopSession::Account(a)));

        let result = logout_body(&state).await.expect("logout");

        assert_eq!(result.seq, 2);
        assert_eq!(read_slot(&state), (None, 2));
        assert_eq!(audit_action_count(&state, "logout").await, 1);
    }

    /// S-18: `auth_setup` overtaken by a completed logout: the account is
    /// created, the session is not installed.
    #[tokio::test]
    async fn s18_a_slow_setup_does_not_undo_a_completed_logout() {
        let mut state = app_state().await;
        let mut hold = hold_setup(&mut state);

        let setup = setup_body(
            &state,
            "b".to_string(),
            SLOT_PASSWORD.to_string(),
            "B".to_string(),
        );
        tokio::pin!(setup);
        run_until_held!(setup, hold);

        logout_body(&state).await.expect("logout");
        hold.release.send(()).unwrap();
        let result = setup.await.expect("setup");

        assert!(!result.success);
        assert!(result.superseded);
        assert_eq!(read_slot(&state), (None, 1));
        assert!(state.users.is_initialized().await.unwrap());
        assert!(state.users.get_by_username("b").await.unwrap().is_some());
    }

    /// S-19: a logout overtaken by a completed `auth_setup` keeps the setup's
    /// session.
    #[tokio::test]
    async fn s19_a_slow_logout_does_not_clear_a_later_setup() {
        let mut state = app_state().await;
        let mut hold = hold_auth_mode(&mut state);

        let logout = logout_body(&state);
        tokio::pin!(logout);
        run_until_held!(logout, hold);

        let setup = setup_body(
            &state,
            "b".to_string(),
            SLOT_PASSWORD.to_string(),
            "B".to_string(),
        )
        .await
        .expect("setup");
        assert!(setup.success);
        hold.release.send(()).unwrap();
        let result = logout.await.expect("logout");

        assert_eq!(result.seq, setup.seq);
        assert!(is_account(&read_slot(&state).0, "b"));
    }

    /// S-54: re-resolving the same session - including after a display-name
    /// edit (a refresh of the same binding) - never advances seq.
    #[tokio::test]
    async fn s54_resolving_the_same_session_does_not_advance_seq() {
        let state = app_state().await;
        let a = state
            .users
            .setup_first_user("a", SLOT_PASSWORD, "A")
            .await
            .unwrap();
        let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");

        for _ in 0..3 {
            let answer = resolve_body(&state).await.expect("resolve");
            assert!(!answer.stale);
            assert_eq!((answer.checked, answer.current), (login.seq, login.seq));
            assert_eq!(answer.kind, Some("account"));
            assert_eq!(answer.identity.expect("active").name, "A");
        }

        state
            .users
            .update_user(a.id, "A（改名）", Role::Admin)
            .await
            .unwrap();
        let answer = resolve_body(&state).await.expect("resolve");
        assert!(!answer.stale);
        assert_eq!((answer.checked, answer.current), (login.seq, login.seq));
        assert_eq!(answer.identity.expect("still active").name, "A（改名）");
        assert_eq!(read_slot(&state).1, login.seq);
    }

    /// S-64: a role change advances `auth_epoch` (ADR-0014), so the next
    /// resolve reports no session and advances seq (the clear) - unlike the
    /// display-name refresh of S-54.
    #[tokio::test]
    async fn s64_a_role_change_resolves_to_none_and_advances_seq() {
        let state = app_state().await;
        state
            .users
            .setup_first_user("owner", SLOT_PASSWORD, "オーナー")
            .await
            .unwrap();
        let a = state
            .users
            .create_user("a", SLOT_PASSWORD, "A", Role::Editor)
            .await
            .unwrap();
        let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");
        assert!(resolve_body(&state).await.unwrap().identity.is_some());

        state
            .users
            .update_user(a.id, "A", Role::Viewer)
            .await
            .unwrap();
        let answer = resolve_body(&state).await.expect("resolve");

        assert!(!answer.stale);
        assert!(answer.identity.is_none(), "not the new role's session");
        assert_eq!(answer.kind, None);
        assert_eq!(answer.checked, login.seq);
        assert_eq!(answer.current, login.seq + 1, "this call cleared it");
        assert_eq!(read_slot(&state), (None, login.seq + 1));
    }

    /// S-77 (Rust half): a settle whose slot was re-bound after its entry
    /// read writes nothing and reports `Stale`; `auth_resolve` of no session
    /// answers `checked == current`.
    #[tokio::test]
    async fn s77_a_settle_overtaken_by_a_rebind_writes_nothing() {
        let state = app_state().await;
        let empty = resolve_body(&state).await.expect("resolve");
        assert!(empty.identity.is_none() && !empty.stale);
        assert_eq!((empty.checked, empty.current), (0, 0));

        let a = state
            .users
            .setup_first_user("a", SLOT_PASSWORD, "A")
            .await
            .unwrap();
        state.set_session_for_test(Some(DesktopSession::Account(a)));
        let (cached, seq_at_entry) = read_slot(&state);
        let cached = cached.unwrap();
        let fresh = read_session_source(&state, &cached).await.unwrap();
        // Another command re-binds the slot while the read was "in flight".
        assert!(cas_session(&state, seq_at_entry, None).0);

        assert!(matches!(
            settle_session(&state, &cached, fresh, seq_at_entry),
            Settled::Stale { valid_now: None }
        ));
        assert_eq!(read_slot(&state), (None, seq_at_entry + 1));
    }

    /// S-47 / S-67: auth-disabled mode's synthetic session resolves as
    /// `kind: "local"` with the mode's CURRENT role, and its logout is a
    /// no-op that does not advance seq.
    #[tokio::test]
    async fn s47_s67_the_auth_disabled_session_resolves_local_and_logout_keeps_seq() {
        let state = app_state().await;
        let set_mode = |role: Role| {
            let settings = state.settings.clone();
            async move {
                let config = settings.auth_config().await.unwrap();
                settings
                    .set_auth_config(&AuthSettings {
                        disabled: true,
                        disabled_role: role,
                        ..config
                    })
                    .await
                    .unwrap();
            }
        };
        set_mode(Role::Viewer).await;
        state.set_session_for_test(Some(DesktopSession::AuthDisabledLocal(UserIdentity {
            id: LOCAL_SESSION_ID,
            username: "local".to_string(),
            display_name: "ローカルユーザー".to_string(),
            role: Role::Viewer,
            auth_epoch: 0,
        })));
        let (_, seq) = read_slot(&state);

        let answer = resolve_body(&state).await.expect("resolve");
        assert_eq!(answer.kind, Some("local"));
        assert_eq!(answer.identity.expect("active").role, "viewer");
        set_mode(Role::Editor).await;
        let answer = resolve_body(&state).await.expect("resolve");
        assert_eq!(answer.kind, Some("local"));
        assert_eq!(answer.identity.expect("active").role, "editor");
        assert_eq!((answer.checked, answer.current), (seq, seq));

        let logout = logout_body(&state).await.expect("logout");
        assert_eq!(logout.seq, seq, "S-67: the no-op does not advance seq");
        assert!(read_slot(&state).0.is_some());
    }

    /// S-68: a self-service password change re-binds the session and
    /// advances seq; the result carries the new seq.
    #[tokio::test]
    async fn s68_change_password_rebinds_and_advances_seq() {
        let state = app_state().await;
        state
            .users
            .setup_first_user("a", SLOT_PASSWORD, "A")
            .await
            .unwrap();
        let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");

        let result = change_own_password(&state, SLOT_PASSWORD, "newpassword1")
            .await
            .expect("change password");

        assert_eq!(result.seq, login.seq + 1);
        let (session, seq) = read_slot(&state);
        assert_eq!(seq, result.seq);
        assert!(matches!(session, Some(DesktopSession::Account(ref u)) if u.auth_epoch == 1));
        let answer = resolve_body(&state).await.expect("resolve");
        assert_eq!((answer.checked, answer.current), (result.seq, result.seq));
        assert!(answer.identity.is_some());
    }

    /// Poll `$fut` (which must not finish) until `$cond` holds. The session
    /// DB runs on its own worker thread, so between polls this sleeps the
    /// test thread briefly to let that I/O complete.
    macro_rules! drive_until {
        ($fut:expr, $cond:expr) => {{
            let mut reached = false;
            for _ in 0..5_000 {
                if $cond {
                    reached = true;
                    break;
                }
                tokio::select! {
                    biased;
                    out = &mut $fut => panic!("finished early: {out:?}"),
                    _ = tokio::task::yield_now() => {}
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            assert!(reached, "the condition never held");
        }};
    }

    /// Poll `$fut` for a while and assert it is still pending (waiting on
    /// `auth_config_lock`).
    macro_rules! assert_stays_pending {
        ($fut:expr) => {{
            for _ in 0..30 {
                tokio::select! {
                    biased;
                    out = &mut $fut => panic!("expected to wait, but finished: {out:?}"),
                    _ = tokio::task::yield_now() => {}
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }};
    }

    /// Hold the first `auth_config_apply` of `state` right AFTER its settings
    /// save (the apply still holds `auth_config_lock`).
    fn hold_after_save(state: &mut AppState) -> Hold {
        let (slot, hold) = gate();
        let settings = state.settings.clone();
        state.auth_io.save_auth_config = Arc::new(move |config| {
            let (slot, settings) = (slot.clone(), settings.clone());
            Box::pin(async move {
                settings.set_auth_config(&config).await?;
                pass_gate(&slot).await;
                Ok(())
            })
        });
        hold
    }

    /// Auth-mode reads for a logout that races an `apply(true)`: the FIRST
    /// read returns what is stored (`disabled = false`) and then stores
    /// `disabled = true` - an apply(true) that completed right after it -
    /// and the SECOND read (the logout's post-clear re-read, under
    /// `auth_config_lock`) is held before reading. Later reads pass.
    fn mode_turned_on_after_first_read_and_reread_held(state: &mut AppState) -> Hold {
        let (slot, hold) = gate();
        let settings = state.settings.clone();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        state.auth_io.auth_mode = Arc::new(move || {
            let (slot, settings, calls) = (slot.clone(), settings.clone(), calls.clone());
            Box::pin(async move {
                match calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
                    0 => {
                        let config = settings.auth_config().await?;
                        settings
                            .set_auth_config(&AuthSettings {
                                disabled: true,
                                ..config.clone()
                            })
                            .await?;
                        Ok(config)
                    }
                    1 => {
                        pass_gate(&slot).await;
                        settings.auth_config().await
                    }
                    _ => settings.auth_config().await,
                }
            })
        });
        hold
    }

    /// S-67 / PR #264 review P1 (i): `auth_config_apply` starts (the slot
    /// empty - the first-run 「ログインなしで使い始める」), a logout clears the
    /// empty slot meanwhile (advancing `seq`, `disabled` still false), and
    /// only then does the apply save and reach its final lock. The install
    /// is conditioned on the slot being empty, NOT on `seq` being unchanged
    /// since the apply's entry - so the APPLY installs the synthetic session
    /// (asserted before the logout, waiting on `auth_config_lock` for its
    /// re-read, is polled again; its re-read then installs nothing).
    #[tokio::test]
    async fn s67_config_apply_installs_local_after_a_logout_advanced_seq() {
        let mut state = app_state().await;
        // Call 1 = the apply's `currently_disabled` read (held before it,
        // with `auth_config_lock` held).
        let mut hold = hold_auth_mode_call(&mut state, 1, false);

        let apply = auth_config_apply_body(&state, true, "admin");
        tokio::pin!(apply);
        run_until_held!(apply, hold);

        let logout = logout_body(&state);
        tokio::pin!(logout);
        drive_until!(logout, read_slot(&state) == (None, 1));
        assert_stays_pending!(logout);
        hold.release.send(()).unwrap();
        let config = apply.await.expect("apply");

        assert!(config.disabled);
        assert!(state.settings.auth_config().await.unwrap().disabled);
        let (session, seq) = read_slot(&state);
        assert!(is_local(&session), "the apply installed: {session:?}");
        assert_eq!(seq, 2, "the install advanced seq once");

        let result = logout.await.expect("logout");
        assert_eq!(result.seq, 2, "the logout's re-read did not install again");
        assert_eq!(read_slot(&state).1, 2);
        assert_eq!(audit_action_count(&state, "login").await, 1);
    }

    /// S-67 / PR #264 review P1 (ii), updated by the owner review of #266
    /// P1: a logout reads the OLD `disabled = false` and is held;
    /// `auth_config_apply` then switches the mode on while A's session is
    /// still there - and re-binds it to the synthetic session right away
    /// (`seq` + 1). The logout resumes: its compare-and-set no longer holds,
    /// so it changes nothing. Disabled mode never ends with no session, nor
    /// with A's.
    #[tokio::test]
    async fn s67_a_logout_that_read_the_old_mode_is_overtaken_by_the_apply_rebind() {
        let mut state = app_state().await;
        state
            .users
            .setup_first_user("a", SLOT_PASSWORD, "A")
            .await
            .unwrap();
        let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");
        assert!(login.success);
        // Call 1 = the logout's first mode read (held AFTER reading false).
        let mut hold = hold_auth_mode_call(&mut state, 1, true);

        let logout = logout_body(&state);
        tokio::pin!(logout);
        run_until_held!(logout, hold);

        let config = auth_config_apply_body(&state, true, "editor")
            .await
            .expect("apply");
        assert!(config.disabled);
        assert!(
            is_local(&read_slot(&state).0),
            "the apply re-bound A's session"
        );
        hold.release.send(()).unwrap();
        let result = logout.await.expect("logout");

        let (session, seq) = read_slot(&state);
        let Some(DesktopSession::AuthDisabledLocal(local)) = session else {
            panic!("expected the synthetic session: {session:?}")
        };
        assert_eq!(local.role, Role::Editor);
        assert_eq!(local.id, LOCAL_SESSION_ID);
        assert_eq!(
            seq,
            login.seq + 1,
            "the rebind only; the logout wrote nothing"
        );
        assert_eq!(result.seq, seq, "the logout reports the final seq");
        assert_eq!(
            audit_action_count(&state, "logout").await,
            1,
            "A's session end by the rebind (reason auth_disabled), none by the logout"
        );
        assert_eq!(
            audit_action_count(&state, "login").await,
            2,
            "A's login + one synthetic login"
        );
    }

    /// The audit rows for `action` (any order), as `(actor, detail)`.
    async fn audit_rows(state: &AppState, action: &str) -> Vec<(Option<String>, Option<String>)> {
        state
            .audit
            .list(ListParams::default())
            .await
            .expect("audit list")
            .rows
            .into_iter()
            .filter(|row| row.action == action)
            .map(|row| (row.actor_username, row.detail))
            .collect()
    }

    /// S-94 (owner review of #266 P1, design §5.3): an admin signed in with an
    /// account turns auth-disabled mode on from the settings screen. The
    /// apply re-binds the slot to the synthetic session with the new role in
    /// the same step as the save (`seq` + 1), and records the account's
    /// session end (`logout`, reason `auth_disabled`) and the synthetic
    /// `login`. `auth_resolve` then answers `kind: "local"` with that role -
    /// `auth.disabled == true` never goes with an account session.
    #[tokio::test]
    async fn s94_config_apply_true_rebinds_an_account_session_to_local() {
        let state = app_state().await;
        state
            .users
            .setup_first_user("admin", SLOT_PASSWORD, "Admin")
            .await
            .unwrap();
        let login = login_body(&state, "admin".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");
        assert!(login.success);
        assert!(is_account(&read_slot(&state).0, "admin"));

        let config = auth_config_apply_body(&state, true, "viewer")
            .await
            .expect("apply");
        assert!(config.disabled);

        let (session, seq) = read_slot(&state);
        let Some(DesktopSession::AuthDisabledLocal(local)) = session else {
            panic!("expected the synthetic session: {session:?}")
        };
        assert_eq!(local.role, Role::Viewer);
        assert_eq!(seq, login.seq + 1, "Account -> Local advances seq once");

        let logouts = audit_rows(&state, "logout").await;
        assert_eq!(logouts.len(), 1);
        assert_eq!(logouts[0].0.as_deref(), Some("admin"));
        let detail: serde_json::Value =
            serde_json::from_str(logouts[0].1.as_deref().expect("detail")).unwrap();
        assert_eq!(detail, serde_json::json!({ "reason": "auth_disabled" }));
        let logins = audit_rows(&state, "login").await;
        assert_eq!(logins.len(), 2, "the admin's login + the synthetic login");
        assert!(
            logins
                .iter()
                .any(|(actor, detail)| actor.as_deref() == Some("local")
                    && detail
                        .as_deref()
                        .is_some_and(|d| d.contains("auth_disabled"))),
            "{logins:?}"
        );
        assert_eq!(audit_action_count(&state, "settings_change").await, 1);

        let answer = resolve_body(&state).await.expect("resolve");
        assert_eq!(answer.kind, Some("local"));
        assert_eq!(answer.identity.expect("active").role, "viewer");
        assert_eq!((answer.checked, answer.current), (seq, seq));
    }

    /// S-94/S-96: applying `disabled = true` again while the synthetic
    /// session is already there: with the same role nothing is written and
    /// `seq` does not move; with another role the role is written and `seq`
    /// advances (an authorization-context change, re-review of #266 P1). No
    /// session audit either way (the apply's `settings_change` records it).
    #[tokio::test]
    async fn s96_config_apply_true_again_keeps_seq_for_the_same_role_and_advances_it_for_another() {
        let state = app_state().await;
        auth_config_apply_body(&state, true, "admin")
            .await
            .expect("first apply (bootstrap window)");
        let (session, seq) = read_slot(&state);
        assert!(is_local(&session));
        let logins = audit_action_count(&state, "login").await;

        auth_config_apply_body(&state, true, "admin")
            .await
            .expect("same apply");
        assert_eq!(
            read_slot(&state),
            (session, seq),
            "same role: nothing written"
        );

        auth_config_apply_body(&state, true, "editor")
            .await
            .expect("role change");
        let (session, seq_after) = read_slot(&state);
        assert_eq!(seq_after, seq + 1, "another role: seq advances");
        let Some(DesktopSession::AuthDisabledLocal(local)) = session else {
            panic!("{session:?}")
        };
        assert_eq!(local.role, Role::Editor);
        assert_eq!(audit_action_count(&state, "login").await, logins);
        assert_eq!(audit_action_count(&state, "logout").await, 0);
        assert_eq!(audit_action_count(&state, "settings_change").await, 3);
    }

    /// S-96 (re-review of #266 P1): an `auth_resolve` of Local(admin) reads
    /// the slot and the store (role admin) and is held; the role is changed
    /// to viewer meanwhile; the held resolve then settles. The role change
    /// advanced `seq`, so the settle is `Stale` and writes nothing - it does
    /// not put admin back over viewer - and the next resolve answers viewer.
    /// The steps are `resolve_body`'s own, run one by one (as in S-77).
    #[tokio::test]
    async fn s96_a_resolve_that_read_the_old_local_role_does_not_write_it_back() {
        let state = app_state().await;
        auth_config_apply_body(&state, true, "admin")
            .await
            .expect("bootstrap-window apply");

        // The old resolve: slot and store read (admin), then held.
        let (cached, seq_at_entry) = read_slot(&state);
        let cached = cached.expect("Local(admin)");
        let fresh = read_session_source(&state, &cached).await.unwrap();
        assert!(matches!(
            &fresh,
            Some(DesktopSession::AuthDisabledLocal(local)) if local.role == Role::Admin
        ));

        auth_config_apply_body(&state, true, "viewer")
            .await
            .expect("role change");
        assert_eq!(read_slot(&state).1, seq_at_entry + 1);

        assert!(matches!(
            settle_session(&state, &cached, fresh, seq_at_entry),
            Settled::Stale { .. }
        ));
        let Some(DesktopSession::AuthDisabledLocal(local)) = read_slot(&state).0 else {
            panic!("expected Local")
        };
        assert_eq!(local.role, Role::Viewer, "admin was not written back");

        let answer = resolve_body(&state).await.expect("resolve");
        assert!(!answer.stale);
        assert_eq!(answer.kind, Some("local"));
        assert_eq!(answer.identity.expect("active").role, "viewer");
    }

    /// S-103 (freshness audit of #266, P2-2): the generic `settings_set`
    /// refuses the `auth.` keys (only `auth_config_apply` / `autologin_*`
    /// write them, with the session re-bind); other keys still work.
    #[tokio::test]
    async fn s103_settings_set_refuses_auth_keys() {
        let state = app_state().await;
        state
            .users
            .setup_first_user("admin", SLOT_PASSWORD, "Admin")
            .await
            .unwrap();
        let admin = state.users.get_by_username("admin").await.unwrap().unwrap();
        state.set_session_for_test(Some(DesktopSession::Account(admin.clone())));
        let before = read_slot(&state);
        for key in [
            "auth.disabled",
            "auth.disabled_role",
            "auth.autologin.enabled",
        ] {
            let result =
                settings_set_body(&state, &admin, key.to_string(), "true".to_string()).await;
            assert!(
                matches!(result, Err(BantoError::BadRequest(_))),
                "{key}: {result:?}"
            );
        }
        assert!(!state.settings.auth_config().await.unwrap().disabled);
        assert_eq!(read_slot(&state), before);
        settings_set_body(
            &state,
            &admin,
            "audit.retention_days".to_string(),
            "30".to_string(),
        )
        .await
        .expect("a non-auth key");
    }

    /// Replace `auth_config_apply`'s save with one that stores only
    /// `auth.disabled` and then fails (a save interrupted part-way).
    fn save_fails_after_the_mode(state: &mut AppState) {
        let settings = state.settings.clone();
        state.auth_io.save_auth_config = Arc::new(move |config| {
            let settings = settings.clone();
            Box::pin(async move {
                settings
                    .set(
                        "auth.disabled",
                        if config.disabled { "true" } else { "false" },
                    )
                    .await?;
                Err(BantoError::Storage("disk full (test)".to_string()))
            })
        });
    }

    /// S-104 (freshness audit of #266, P2-3): a save that stored the mode and
    /// then failed still leaves the session following what is stored -
    /// apply(true) over an account session re-binds it to Local; apply(false)
    /// over Local ends it - and the error is reported.
    #[tokio::test]
    async fn s104_a_save_failing_part_way_still_rebinds_the_session_to_what_is_stored() {
        let mut state = app_state().await;
        state
            .users
            .setup_first_user("admin", SLOT_PASSWORD, "Admin")
            .await
            .unwrap();
        state.set_session_for_test(Some(DesktopSession::Account(
            state.users.get_by_username("admin").await.unwrap().unwrap(),
        )));
        save_fails_after_the_mode(&mut state);
        let (_, seq) = read_slot(&state);

        let result = auth_config_apply_body(&state, true, "admin").await;
        assert!(matches!(result, Err(BantoError::Storage(_))), "{result:?}");
        assert!(state.settings.auth_config().await.unwrap().disabled);
        let (session, seq_on) = read_slot(&state);
        assert!(is_local(&session), "follows disabled = true: {session:?}");
        assert_eq!(seq_on, seq + 1);

        let result = auth_config_apply_body(&state, false, "admin").await;
        assert!(result.is_err());
        assert!(!state.settings.auth_config().await.unwrap().disabled);
        assert_eq!(
            read_slot(&state),
            (None, seq_on + 1),
            "follows disabled = false"
        );
    }

    /// S-102 (freshness audit of #266, P3-2): a check that read Local(admin)
    /// and is overtaken by apply(true, viewer) reports, for the ordinary
    /// commands, the slot's CURRENT session (viewer) - not its older read.
    #[tokio::test]
    async fn s102_a_stale_settle_reports_the_slot_value_not_the_older_read() {
        let state = app_state().await;
        auth_config_apply_body(&state, true, "admin")
            .await
            .expect("enable (bootstrap window)");
        let (cached, seq_at_entry) = read_slot(&state);
        let cached = cached.expect("Local(admin)");
        let fresh = read_session_source(&state, &cached).await.unwrap();

        auth_config_apply_body(&state, true, "viewer")
            .await
            .expect("role change");

        let Settled::Stale {
            valid_now: Some(DesktopSession::AuthDisabledLocal(local)),
        } = settle_session(&state, &cached, fresh, seq_at_entry)
        else {
            panic!("expected Stale with the current Local session")
        };
        assert_eq!(local.role, Role::Viewer);
    }

    /// Hardening (freshness audit of #266, P2-2): `false -> true` advances
    /// `seq` even if the slot somehow already holds Local with that role.
    #[tokio::test]
    async fn s98_turning_the_mode_on_always_advances_seq() {
        let state = app_state().await;
        state.set_session_for_test(Some(DesktopSession::AuthDisabledLocal(local_identity(
            Role::Admin,
        ))));
        let (_, seq) = read_slot(&state);
        auth_config_apply_body(&state, true, "admin")
            .await
            .expect("enable");
        assert_eq!(read_slot(&state).1, seq + 1);
    }

    /// S-98 (re-review of #266 P1): between `auth_config_apply`'s save and
    /// its rebind, another `auth_resolve` (B) reads the new role from the
    /// store and refreshes the slot to it - without advancing `seq` (a
    /// settle's refresh never does, I-23). The rebind then finds the new role
    /// already there, but the role DID change in this apply (decided from
    /// the settings before the save), so it still advances `seq`. An even
    /// older resolve (A) that had read the old role therefore settles
    /// `Stale` and does not write admin back.
    #[tokio::test]
    async fn s98_a_role_change_advances_seq_even_if_a_settle_refreshed_the_slot_first() {
        let mut state = app_state().await;
        // Local(admin): the mode on with role admin, and its synthetic session.
        let config = state.settings.auth_config().await.unwrap();
        state
            .settings
            .set_auth_config(&AuthSettings {
                disabled: true,
                disabled_role: Role::Admin,
                ..config
            })
            .await
            .unwrap();
        state.set_session_for_test(Some(DesktopSession::AuthDisabledLocal(local_identity(
            Role::Admin,
        ))));
        let mut hold = hold_after_save(&mut state);

        // Resolve A: slot and store read (admin), then held.
        let (cached_a, seq_n) = read_slot(&state);
        let cached_a = cached_a.expect("Local(admin)");
        let fresh_a = read_session_source(&state, &cached_a).await.unwrap();

        // apply(true, viewer): held after its save, before its rebind.
        let apply = auth_config_apply_body(&state, true, "viewer");
        tokio::pin!(apply);
        run_until_held!(apply, hold);

        // Resolve B runs whole: it reads viewer from the store and refreshes.
        let b = resolve_body(&state).await.expect("resolve B");
        assert_eq!(b.identity.expect("active").role, "viewer");
        assert_eq!((b.checked, b.current), (seq_n, seq_n), "a refresh: no seq");
        assert_eq!(read_slot(&state).1, seq_n);

        hold.release.send(()).unwrap();
        apply.await.expect("apply");
        assert_eq!(
            read_slot(&state).1,
            seq_n + 1,
            "the role change advanced seq anyway"
        );

        assert!(matches!(
            settle_session(&state, &cached_a, fresh_a, seq_n),
            Settled::Stale { .. }
        ));
        let Some(DesktopSession::AuthDisabledLocal(local)) = read_slot(&state).0 else {
            panic!("expected Local")
        };
        assert_eq!(local.role, Role::Viewer, "admin was not written back");
    }

    /// S-99 (re-review of #266 P1): an `auth_resolve` that read Local(admin)
    /// and `disabled = true` is held; `auth_config_apply(false)` then ends the
    /// synthetic session in the same step as its save (`None`, `seq` + 1) and
    /// records its end (`logout`, reason `auth_enabled`). The held resolve
    /// settles `Stale` (it does not confirm `local` under `disabled = false`),
    /// and the next resolve answers `none`.
    #[tokio::test]
    async fn s99_config_apply_false_ends_local_at_once_and_an_old_resolve_is_stale() {
        let state = app_state().await;
        auth_config_apply_body(&state, true, "admin")
            .await
            .expect("enable (bootstrap window)");
        let (cached, seq_n) = read_slot(&state);
        let cached = cached.expect("Local(admin)");
        let fresh = read_session_source(&state, &cached).await.unwrap();
        assert!(fresh.is_some(), "read while the mode was on");

        auth_config_apply_body(&state, false, "admin")
            .await
            .expect("disable");
        assert_eq!(read_slot(&state), (None, seq_n + 1));
        let logouts = audit_rows(&state, "logout").await;
        assert_eq!(logouts.len(), 1);
        assert_eq!(logouts[0].0.as_deref(), Some("local"));
        let detail: serde_json::Value =
            serde_json::from_str(logouts[0].1.as_deref().expect("detail")).unwrap();
        assert_eq!(detail, serde_json::json!({ "reason": "auth_enabled" }));

        assert!(matches!(
            settle_session(&state, &cached, fresh, seq_n),
            Settled::Stale { .. }
        ));
        assert_eq!(read_slot(&state), (None, seq_n + 1));
        let answer = resolve_body(&state).await.expect("resolve");
        assert!(answer.identity.is_none());
        assert!(!answer.stale);
        assert_eq!((answer.checked, answer.current), (seq_n + 1, seq_n + 1));
    }

    /// S-99: re-saving `disabled = false` (the mode already off) touches
    /// nothing: `seq` unchanged, no session audit.
    #[tokio::test]
    async fn s99_config_apply_false_again_is_a_no_op_for_the_session() {
        let state = app_state().await;
        state
            .users
            .setup_first_user("admin", SLOT_PASSWORD, "Admin")
            .await
            .unwrap();
        let login = login_body(&state, "admin".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");
        assert!(login.success);
        let before = read_slot(&state);

        auth_config_apply_body(&state, false, "admin")
            .await
            .expect("re-save false");
        assert_eq!(read_slot(&state), before);
        assert!(is_account(&before.0, "admin"));
        assert_eq!(audit_action_count(&state, "logout").await, 0);
    }

    /// S-94/S-95: a login starts (reads `seq = N`) and is held in its
    /// password check; the mode is switched on meanwhile (the admin's account
    /// session re-bound to Local, `seq = N + 1`); the login then completes.
    /// Its install checks the mode under `auth_config_lock` and refuses - no
    /// account session in auth-disabled mode (and its compare-and-set would
    /// not hold either). The synthetic session stays; `seq` does not move.
    #[tokio::test]
    async fn s95_a_login_whose_check_was_overtaken_by_apply_true_is_refused() {
        let mut state = app_state().await;
        state
            .users
            .setup_first_user("admin", SLOT_PASSWORD, "Admin")
            .await
            .unwrap();
        state.set_session_for_test(Some(DesktopSession::Account(
            state.users.get_by_username("admin").await.unwrap().unwrap(),
        )));
        let (_, seq_before) = read_slot(&state);
        let mut hold = hold_verify(&mut state);

        let login = login_body(&state, "admin".to_string(), SLOT_PASSWORD.to_string());
        tokio::pin!(login);
        run_until_held!(login, hold);

        auth_config_apply_body(&state, true, "viewer")
            .await
            .expect("apply");
        assert_eq!(read_slot(&state).1, seq_before + 1);
        hold.release.send(()).unwrap();
        let result = login.await.expect("login");

        assert!(!result.success);
        assert!(!result.superseded, "refused by the mode, not a lost race");
        assert_eq!(result.error.as_deref(), Some(AUTH_DISABLED_LOGIN_MESSAGE));
        let (session, seq) = read_slot(&state);
        assert!(
            is_local(&session),
            "Local is not turned back into the account: {session:?}"
        );
        assert_eq!(seq, seq_before + 1);
        assert_eq!(result.seq, seq);
    }

    /// S-95: `auth_login` while auth-disabled mode is on is refused before the
    /// password check: the slot stays Local, `seq` does not move, and nothing
    /// is recorded (no credential was checked).
    #[tokio::test]
    async fn s95_login_in_auth_disabled_mode_is_refused_before_the_check() {
        let state = app_state().await;
        state
            .users
            .setup_first_user("admin", SLOT_PASSWORD, "Admin")
            .await
            .unwrap();
        state.set_session_for_test(Some(DesktopSession::Account(
            state.users.get_by_username("admin").await.unwrap().unwrap(),
        )));
        auth_config_apply_body(&state, true, "editor")
            .await
            .expect("apply");
        let before = read_slot(&state);
        let logins = audit_action_count(&state, "login").await;

        let result = login_body(&state, "admin".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");

        assert!(!result.success);
        assert!(!result.superseded);
        assert_eq!(result.error.as_deref(), Some(AUTH_DISABLED_LOGIN_MESSAGE));
        assert_eq!(result.seq, before.1);
        assert_eq!(read_slot(&state), before);
        assert!(is_local(&before.0));
        assert_eq!(audit_action_count(&state, "login").await, logins);
        assert_eq!(audit_action_count(&state, "login_failed").await, 0);
    }

    /// S-95: `auth_setup` while auth-disabled mode is on (the first-run
    /// 「ログインなしで使い始める」 already chosen) is refused on entry and
    /// creates no account.
    #[tokio::test]
    async fn s95_setup_in_auth_disabled_mode_creates_no_account() {
        let state = app_state().await;
        auth_config_apply_body(&state, true, "admin")
            .await
            .expect("bootstrap-window apply");
        let before = read_slot(&state);
        assert!(is_local(&before.0));

        let result = setup_body(
            &state,
            "b".to_string(),
            SLOT_PASSWORD.to_string(),
            "B".to_string(),
        )
        .await
        .expect("setup");

        assert!(!result.success);
        assert!(!result.superseded);
        assert_eq!(result.error.as_deref(), Some(AUTH_DISABLED_LOGIN_MESSAGE));
        assert_eq!(read_slot(&state), before);
        assert!(
            !state.users.is_initialized().await.unwrap(),
            "no account created"
        );
        assert_eq!(audit_action_count(&state, "setup").await, 0);
    }

    /// S-95: the mode is switched on (bootstrap window: no account yet, no
    /// session) while `auth_setup` is creating the first account. The account
    /// exists afterwards (created before the switch), but its session is not
    /// installed: the synthetic session stays, as with a superseded setup.
    #[tokio::test]
    async fn s95_a_setup_overtaken_by_apply_true_keeps_the_account_but_installs_nothing() {
        let mut state = app_state().await;
        let mut hold = hold_setup(&mut state);

        let setup = setup_body(
            &state,
            "b".to_string(),
            SLOT_PASSWORD.to_string(),
            "B".to_string(),
        );
        tokio::pin!(setup);
        run_until_held!(setup, hold);

        auth_config_apply_body(&state, true, "admin")
            .await
            .expect("bootstrap-window apply");
        let after_apply = read_slot(&state);
        assert!(is_local(&after_apply.0));
        hold.release.send(()).unwrap();
        let result = setup.await.expect("setup");

        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some(AUTH_DISABLED_LOGIN_MESSAGE));
        assert_eq!(read_slot(&state), after_apply);
        assert!(state.users.get_by_username("b").await.unwrap().is_some());
        assert_eq!(audit_action_count(&state, "setup").await, 1);
    }

    /// PR #264 review P1 / re-review P2: a logout whose first read saw
    /// `disabled = false` (and after which the mode was switched on) clears
    /// A and re-reads the mode under `auth_config_lock`; an
    /// `auth_config_apply(true)` started meanwhile waits for that lock. The
    /// logout installs the synthetic session, and the apply - seeing it -
    /// does not install again: one `seq` step, one synthetic `login`.
    #[tokio::test]
    async fn s67_config_apply_and_logout_install_local_only_once() {
        let mut state = app_state().await;
        state
            .users
            .setup_first_user("a", SLOT_PASSWORD, "A")
            .await
            .unwrap();
        let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");
        let mut hold = mode_turned_on_after_first_read_and_reread_held(&mut state);

        let logout = logout_body(&state);
        tokio::pin!(logout);
        run_until_held!(logout, hold);
        assert_eq!(read_slot(&state), (None, login.seq + 1), "A is cleared");

        let apply = auth_config_apply_body(&state, true, "admin");
        tokio::pin!(apply);
        assert_stays_pending!(apply);
        hold.release.send(()).unwrap();
        let result = logout.await.expect("logout");
        assert!(is_local(&read_slot(&state).0), "the logout installed");
        assert_eq!(result.seq, login.seq + 2);
        apply.await.expect("apply");

        let (session, seq) = read_slot(&state);
        assert!(is_local(&session), "{session:?}");
        assert_eq!(seq, login.seq + 2, "installed once");
        assert_eq!(
            audit_action_count(&state, "login").await,
            2,
            "A's login + one synthetic login"
        );
    }

    /// PR #264 re-review P2 (a): `apply(true)` has saved and is still inside
    /// its decision (held after the save, `auth_config_lock` held) when an
    /// `apply(false)` starts. The second apply waits for the first to finish
    /// - it cannot save `false` between the first one's save and its install
    /// - so the install is based on the value still stored, and the final
    /// `disabled = false` is saved after it. Since S-99 that `apply(false)`
    /// ends the local session itself, in the same step as its save.
    #[tokio::test]
    async fn config_apply_true_then_false_are_serialized_by_the_auth_config_lock() {
        let mut state = app_state().await;
        let mut hold = hold_after_save(&mut state);

        let apply_on = auth_config_apply_body(&state, true, "admin");
        tokio::pin!(apply_on);
        run_until_held!(apply_on, hold);

        let apply_off = auth_config_apply_body(&state, false, "admin");
        tokio::pin!(apply_off);
        assert_stays_pending!(apply_off);
        assert!(
            state.settings.auth_config().await.unwrap().disabled,
            "apply(false) is waiting: it has not saved"
        );
        assert_eq!(read_slot(&state), (None, 0));

        hold.release.send(()).unwrap();
        apply_on.await.expect("apply(true)");
        assert!(
            is_local(&read_slot(&state).0),
            "installed under disabled = true"
        );
        let config = apply_off.await.expect("apply(false)");

        assert!(!config.disabled);
        assert!(!state.settings.auth_config().await.unwrap().disabled);
        assert_eq!(read_slot(&state), (None, 2), "apply(false) ended it (S-99)");
        let answer = resolve_body(&state).await.expect("resolve");
        assert!(answer.identity.is_none());
        assert_eq!((answer.checked, answer.current), (2, 2));
        assert!(current_session(&state).await.unwrap().is_none());
    }

    /// PR #264 re-review P2 (b): a logout's post-clear re-read sees
    /// `disabled = true` and is held (under `auth_config_lock`); an
    /// `apply(false)` started then waits for the logout's install to finish
    /// before it saves. Final: `disabled = false`, and the local session the
    /// logout installed under `true` is ended by that `apply(false)` (S-99).
    #[tokio::test]
    async fn s67_a_logout_reread_and_a_later_apply_false_are_serialized() {
        let mut state = app_state().await;
        state
            .users
            .setup_first_user("a", SLOT_PASSWORD, "A")
            .await
            .unwrap();
        let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");
        let mut hold = mode_turned_on_after_first_read_and_reread_held(&mut state);

        let logout = logout_body(&state);
        tokio::pin!(logout);
        run_until_held!(logout, hold);

        let apply_off = auth_config_apply_body(&state, false, "admin");
        tokio::pin!(apply_off);
        assert_stays_pending!(apply_off);
        assert!(
            state.settings.auth_config().await.unwrap().disabled,
            "apply(false) is waiting: it has not saved"
        );
        hold.release.send(()).unwrap();
        let result = logout.await.expect("logout");
        assert!(
            is_local(&read_slot(&state).0),
            "installed under disabled = true"
        );
        assert_eq!(result.seq, login.seq + 2);
        apply_off.await.expect("apply(false)");

        assert!(!state.settings.auth_config().await.unwrap().disabled);
        assert_eq!(
            read_slot(&state),
            (None, login.seq + 3),
            "apply(false) ended it (S-99)"
        );
        let answer = resolve_body(&state).await.expect("resolve");
        assert!(answer.identity.is_none());
        assert_eq!(answer.current, answer.checked);
    }

    /// PR #264 review P1: a logout whose re-read of the mode fails still
    /// succeeds (the clear has happened) and installs nothing.
    #[tokio::test]
    async fn s67_a_logout_whose_mode_reread_fails_still_succeeds() {
        let mut state = app_state().await;
        let a = state
            .users
            .setup_first_user("a", SLOT_PASSWORD, "A")
            .await
            .unwrap();
        state.set_session_for_test(Some(DesktopSession::Account(a)));
        let settings = state.settings.clone();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        state.auth_io.auth_mode = Arc::new(move || {
            let (settings, calls) = (settings.clone(), calls.clone());
            Box::pin(async move {
                if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    settings.auth_config().await
                } else {
                    Err(BantoError::Storage("injected".to_string()))
                }
            })
        });

        let result = logout_body(&state).await.expect("logout still succeeds");

        assert_eq!(result.seq, 2);
        assert_eq!(read_slot(&state), (None, 2));
        assert_eq!(audit_action_count(&state, "logout").await, 1);
    }

    /// Supplementary (design §8.3, not order-fixing): login and logout
    /// started together, both having read seq before either proceeds past
    /// its injected `.await`, end in exactly one of the two consistent
    /// states.
    #[tokio::test]
    async fn concurrent_login_and_logout_end_in_one_of_two_consistent_states() {
        for _ in 0..3 {
            let mut state = app_state().await;
            state
                .users
                .setup_first_user("b", SLOT_PASSWORD, "B")
                .await
                .unwrap();
            let barrier = Arc::new(tokio::sync::Barrier::new(2));
            let (verify_barrier, users) = (barrier.clone(), state.users.clone());
            state.auth_io.verify = Arc::new(move |username, password| {
                let (barrier, users) = (verify_barrier.clone(), users.clone());
                Box::pin(async move {
                    barrier.wait().await;
                    users.verify(&username, &password).await
                })
            });
            let (mode_barrier, settings) = (barrier.clone(), state.settings.clone());
            // Only the logout's FIRST mode read meets the login at the
            // barrier - a logout that cleared re-reads the mode (PR #264
            // review P1), and that second read has no partner.
            let first_read = Arc::new(std::sync::atomic::AtomicBool::new(true));
            state.auth_io.auth_mode = Arc::new(move || {
                let (barrier, settings, first_read) =
                    (mode_barrier.clone(), settings.clone(), first_read.clone());
                Box::pin(async move {
                    if first_read.swap(false, std::sync::atomic::Ordering::SeqCst) {
                        barrier.wait().await;
                    }
                    settings.auth_config().await
                })
            });

            let (login, logout) = tokio::join!(
                login_body(&state, "b".to_string(), SLOT_PASSWORD.to_string()),
                logout_body(&state)
            );
            let (login, logout) = (login.unwrap(), logout.unwrap());
            match read_slot(&state).0 {
                None => assert!(login.superseded, "logged out, so the login was superseded"),
                Some(_) => {
                    assert!(login.success);
                    assert_eq!(logout.seq, login.seq, "the logout was a no-op");
                }
            }
        }
    }

    /// S-55 (Rust half): a password change from a session that was revoked
    /// meanwhile clears the slot (advancing `seq`) and THEN fails with
    /// `Unauthorized` - the one error kind returned after a slot write, which
    /// the TS provider therefore treats as "the revision may have changed".
    #[tokio::test]
    async fn s55_change_password_on_a_revoked_session_advances_seq_then_fails_unauthorized() {
        let state = app_state().await;
        state
            .users
            .setup_first_user("owner", SLOT_PASSWORD, "オーナー")
            .await
            .unwrap();
        let a = state
            .users
            .create_user("a", SLOT_PASSWORD, "A", Role::Editor)
            .await
            .unwrap();
        let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");
        state
            .users
            .update_user(a.id, "A", Role::Viewer)
            .await
            .unwrap();

        let result = change_own_password(&state, SLOT_PASSWORD, "newpassword1").await;

        assert!(
            matches!(result, Err(BantoError::Unauthorized)),
            "{result:?}"
        );
        assert_eq!(read_slot(&state), (None, login.seq + 1));
    }

    /// S-55 (Rust half): a wrong current password is a `Validation` error
    /// returned without touching the slot.
    #[tokio::test]
    async fn s55_change_password_with_a_wrong_current_password_leaves_seq() {
        let state = app_state().await;
        state
            .users
            .setup_first_user("a", SLOT_PASSWORD, "A")
            .await
            .unwrap();
        let login = login_body(&state, "a".to_string(), SLOT_PASSWORD.to_string())
            .await
            .expect("login");

        let result = change_own_password(&state, "wrong-password", "newpassword1").await;

        assert!(
            matches!(result, Err(BantoError::Validation { .. })),
            "{result:?}"
        );
        assert_eq!(read_slot(&state).1, login.seq);
        assert!(read_slot(&state).0.is_some());
    }
}
