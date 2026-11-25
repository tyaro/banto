//! `/api/config/*`: edit a draft, publish it, go back to an earlier version
//! (Issue #938, config-draft-publish-design §4.8-§4.11; step S2 of §7).
//!
//! Pure wiring over [`ConfigDraftsService`]: the guards, the audit rows and
//! the events. The service knows none of them (conventions §2).
//!
//! ## Guards (design §4.9)
//!
//! Four duties, one [`ConfigDraftsGate`] each ([`ConfigDraftsAccess`]):
//!
//! | duty    | routes                                                      |
//! | ------- | ----------------------------------------------------------- |
//! | read    | list, state, diff, history                                  |
//! | edit    | lock acquire / extend / release, draft save / rebase / discard |
//! | publish | publish, revert                                             |
//! | unlock  | remove another editor's lock                                |
//!
//! **Read is a condition of the other three.** The edit and publish routes
//! answer with values (a conflict's `current.draft` is the draft as it is
//! now; a publish answers with the diff), so every route here is behind the
//! read gate FIRST, and the duty's own gate after it. [`config_drafts_router`]
//! stacks them itself - the app cannot leave the read gate out. A refusal is
//! `403 forbidden` plus one `denied` audit row (`resource: "config"`), from
//! whichever gate refused; a request without a session is `401` and is not
//! audited (conventions §1).
//!
//! ## Audit and events (design §4.8)
//!
//! | operation                       | audit (`resource: "config"`, `entity_id`: the target) | event                         |
//! | ------------------------------- | ------------------------------------------------------ | ----------------------------- |
//! | publish                         | `publish`, [`publish_audit_detail`]                    | [`config_changed_event`]      |
//! | revert                          | `revert`, the same                                     | the same                      |
//! | unlock                          | `unlock`, [`unlock_audit_detail`]                      | [`config_draft_changed_event`] |
//! | draft discard (a draft existed) | `discard`, [`discard_audit_detail`]                    | the same                      |
//! | draft save / rebase, lock acquire / extend / release | none (they do not change the published value; a save per keystroke would fill the log) | the same |
//!
//! The order in a handler is: the service call (the commit) -> the audit row
//! -> the event. The audit actor and the history row's "who" are the
//! snapshot the guard made (`Extension<AuditActor>`, conventions §1), never
//! looked up again after the write.
//!
//! An event says only WHICH target changed. `/api/events` also reaches
//! sessions that may not read the config (a public viewer), so neither the
//! actor nor a value is in it; who and from where is in the history (behind
//! the read gate).
//!
//! ## Both paths (conventions §1)
//!
//! The app that mounts this router adds the Tauri twins, the route table and
//! the `verify:architecture` rule 8 entries (design §7, S4). The twins call
//! the same service methods and the same detail / event functions as the
//! handlers here, so the two paths cannot record different rows.
//!
//! No route here raises the body limit: the layer that detaches writes
//! (ADR-0035) has received the whole body before the guards decide, so no
//! handler decides again (a config value is at most 256 KiB).

use super::*;
use axum::routing::put;
use axum::Extension;
use banto_admin_services::config_drafts::{
    discard_audit_detail, publish_audit_detail, unlock_audit_detail, ConfigDiff,
    ConfigDraftDiscarded, ConfigDraftSaved, ConfigDraftsService, ConfigEditor, ConfigHistoryDetail,
    ConfigHistoryEntry, ConfigLock, ConfigState, ConfigTargetSummary, PublishOutcome, PublishStamp,
};
use tokio::sync::broadcast;

use crate::ServerEvent;

/// The audit `resource` of every row written here, refusals included.
const RESOURCE: &str = "config";

/// How many history entries `GET /api/config/{target}/history` answers with
/// when `limit` is left out (the service caps a larger `limit` at
/// `MAX_CONFIG_HISTORY_PAGE`).
const DEFAULT_HISTORY_PAGE: u32 = 50;

/// What one duty asks of the session (design §4.9): a role floor
/// ([`RoleGuard`]) or a per-user permission ([`PermissionGuard`], Issue
/// #697).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigDraftsGate {
    /// The session's role is at least this.
    Role(Role),
    /// The session holds this permission (its role is not looked at).
    Permission(PermissionKey),
}

/// The four gates of [`config_drafts_router`] (design §4.9). One set for the
/// whole router - not per target.
///
/// `read` is also applied to the routes of the other three duties (see the
/// module doc): a session that may not read cannot edit, publish or unlock,
/// whatever those gates say.
///
/// ```
/// use banto_admin_services::permissions::PermissionKey;
/// use banto_admin_services::users::Role;
/// use banto_server::routes::{ConfigDraftsAccess, ConfigDraftsGate};
///
/// // The default: all four are `admin`.
/// assert_eq!(ConfigDraftsAccess::default().publish, ConfigDraftsGate::Role(Role::Admin));
///
/// // An app that separates "who edits" from "who publishes":
/// let access = ConfigDraftsAccess {
///     read: ConfigDraftsGate::Role(Role::Editor),
///     edit: ConfigDraftsGate::Permission(PermissionKey::parse("config.edit").unwrap()),
///     publish: ConfigDraftsGate::Permission(PermissionKey::parse("config.publish").unwrap()),
///     unlock: ConfigDraftsGate::Role(Role::Admin),
/// };
/// # let _ = access;
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigDraftsAccess {
    /// List, state, diff, history - and a condition of the three below.
    pub read: ConfigDraftsGate,
    /// Lock acquire / extend / release, draft save / rebase / discard.
    pub edit: ConfigDraftsGate,
    /// Publish, revert.
    pub publish: ConfigDraftsGate,
    /// Remove another editor's lock.
    pub unlock: ConfigDraftsGate,
}

impl Default for ConfigDraftsAccess {
    /// All four duties need the `admin` role.
    fn default() -> Self {
        Self {
            read: ConfigDraftsGate::Role(Role::Admin),
            edit: ConfigDraftsGate::Role(Role::Admin),
            publish: ConfigDraftsGate::Role(Role::Admin),
            unlock: ConfigDraftsGate::Role(Role::Admin),
        }
    }
}

/// The event after the PUBLISHED value of `target` changed (publish, revert):
/// `ResourceChanged { resource: "config:<target>" }`. The app's own code that
/// follows a target listens for this one (and reads
/// [`ConfigDraftsService::published`] again). The Tauri twins send the same.
pub fn config_changed_event(target: &str) -> ServerEvent {
    ServerEvent::ResourceChanged {
        resource: format!("config:{target}"),
    }
}

/// The event after the draft or the lock of `target` changed (everything an
/// editor does short of publishing):
/// `ResourceChanged { resource: "config-draft:<target>" }`. Only editing
/// screens care - they read the state again to show the holder and whether a
/// draft exists.
pub fn config_draft_changed_event(target: &str) -> ServerEvent {
    ServerEvent::ResourceChanged {
        resource: format!("config-draft:{target}"),
    }
}

#[derive(Clone)]
struct ConfigDraftsState {
    service: ConfigDraftsService,
    audit: AuditLogService,
    events: broadcast::Sender<ServerEvent>,
}

impl ConfigDraftsState {
    /// A send fails only when nobody listens.
    fn notify(&self, event: ServerEvent) {
        let _ = self.events.send(event);
    }
}

/// Who is editing, from the session `require_auth` authorized (the same rule
/// as the UI settings' owner, ADR-0034 §8) - never from the request:
///
/// - a grant session: `grant:<kind>`;
/// - an account session: `acct:<users.id>` (NOT the username: a new account
///   with a reused name must not hold the deleted account's lock);
/// - an account session without a stamp (an `AuthState` built without a
///   session lookup) has no account row to hold a lock: refused like a
///   request without a session (fail closed).
///
/// The name the other editors see is the session's id (the username, or a
/// grant's fixed id) - the same name the audit log and the history show.
/// This is not authorization (the guards decided that); it only tells lock
/// holders apart.
fn editor_of(session: &AuthenticatedSession) -> Result<ConfigEditor, BantoError> {
    let holder = match (&session.grant, session.stamp) {
        (Some(kind), _) => format!("grant:{}", kind.as_str()),
        (None, Some(stamp)) => format!("acct:{}", stamp.account_id),
        (None, None) => return Err(BantoError::Unauthorized),
    };
    Ok(ConfigEditor {
        holder,
        name: session.identity.id.clone(),
    })
}

/// "Who and from where" of a history row: the audit actor's snapshot, so the
/// history and the audit row name the same actor.
fn stamp_of<'a>(actor: &'a AuditActor, comment: Option<&'a str>) -> PublishStamp<'a> {
    PublishStamp {
        actor_username: &actor.username,
        actor_id: actor.id,
        actor_kind: &actor.kind,
        origin: "rest",
        comment,
    }
}

// --- read -------------------------------------------------------------------

/// `GET /api/config`: every target's summary (no values).
async fn config_list(
    State(state): State<ConfigDraftsState>,
) -> Result<Json<Vec<ConfigTargetSummary>>, ApiError> {
    Ok(Json(state.service.list().await?))
}

/// `GET /api/config/{target}`: published, draft and lock, from one read.
async fn config_get(
    State(state): State<ConfigDraftsState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(target): Path<String>,
) -> Result<Json<ConfigState>, ApiError> {
    let viewer = editor_of(&session)?;
    Ok(Json(state.service.state(&target, &viewer).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffQuery {
    /// Left out: published -> draft. A version: published -> that version
    /// (what a revert to it would change).
    #[serde(default)]
    to_version: Option<i64>,
}

/// `GET /api/config/{target}/diff[?toVersion=N]`.
async fn config_diff(
    State(state): State<ConfigDraftsState>,
    Path(target): Path<String>,
    Query(query): Query<DiffQuery>,
) -> Result<Json<ConfigDiff>, ApiError> {
    Ok(Json(state.service.diff(&target, query.to_version).await?))
}

#[derive(Debug, Deserialize)]
struct HistoryQuery {
    /// Only versions below this one (the page after the one that ended here).
    #[serde(default)]
    before: Option<i64>,
    #[serde(default)]
    limit: Option<u32>,
}

/// `GET /api/config/{target}/history[?before=N&limit=M]`: newest first, no
/// values.
async fn config_history_list(
    State(state): State<ConfigDraftsState>,
    Path(target): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Vec<ConfigHistoryEntry>>, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_HISTORY_PAGE);
    Ok(Json(
        state.service.history(&target, query.before, limit).await?,
    ))
}

/// `GET /api/config/{target}/history/{version}`: that version's value and
/// the diff from the version before it.
async fn config_history_get(
    State(state): State<ConfigDraftsState>,
    Path((target, version)): Path<(String, i64)>,
) -> Result<Json<ConfigHistoryDetail>, ApiError> {
    Ok(Json(state.service.history_entry(&target, version).await?))
}

// --- edit -------------------------------------------------------------------

/// `POST /api/config/{target}/lock`: take the lock (a new lease).
async fn config_lock_acquire(
    State(state): State<ConfigDraftsState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(target): Path<String>,
) -> Result<Json<ConfigLock>, ApiError> {
    let editor = editor_of(&session)?;
    let lock = state.service.lock_acquire(&target, &editor).await?;
    state.notify(config_draft_changed_event(&target));
    Ok(Json(lock))
}

#[derive(Debug, Deserialize)]
struct LockExtendRequest {
    lease: String,
}

/// `PUT /api/config/{target}/lock`: extend the caller's own lock of that
/// lease. After the expiry it is a conflict - never a new acquire.
async fn config_lock_extend(
    State(state): State<ConfigDraftsState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(target): Path<String>,
    Json(body): Json<LockExtendRequest>,
) -> Result<Json<ConfigLock>, ApiError> {
    let editor = editor_of(&session)?;
    let lock = state
        .service
        .lock_extend(&target, &editor, &body.lease)
        .await?;
    state.notify(config_draft_changed_event(&target));
    Ok(Json(lock))
}

/// `?lease=` of the lock's DELETE (a DELETE carries no body). Left out it is
/// empty, which the service refuses as a field error.
#[derive(Debug, Deserialize)]
struct LockReleaseQuery {
    #[serde(default)]
    lease: String,
}

/// `DELETE /api/config/{target}/lock?lease=`: give the caller's own lock of
/// that lease back.
async fn config_lock_release(
    State(state): State<ConfigDraftsState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(target): Path<String>,
    Query(query): Query<LockReleaseQuery>,
) -> Result<StatusCode, ApiError> {
    let editor = editor_of(&session)?;
    let removed = state
        .service
        .lock_release(&target, &editor, &query.lease)
        .await?;
    // A stale lease (an old tab's late release) removes nothing: 204 all the
    // same, but there is nothing to announce.
    if removed {
        state.notify(config_draft_changed_event(&target));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftPutRequest {
    value: serde_json::Value,
    /// The draft's revision the editor has; `"0"` = there is none yet.
    if_revision: String,
    /// The published revision the editor saw. Required for the first save.
    #[serde(default)]
    if_published_revision: Option<String>,
}

/// `PUT /api/config/{target}/draft`: save the draft (not audited).
async fn config_draft_put(
    State(state): State<ConfigDraftsState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(target): Path<String>,
    Json(body): Json<DraftPutRequest>,
) -> Result<Json<ConfigDraftSaved>, ApiError> {
    let editor = editor_of(&session)?;
    let saved = state
        .service
        .draft_put(
            &target,
            &editor,
            &body.value,
            &body.if_revision,
            body.if_published_revision.as_deref(),
        )
        .await?;
    state.notify(config_draft_changed_event(&target));
    Ok(Json(saved))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftRebaseRequest {
    if_revision: String,
    if_published_revision: String,
}

/// `POST /api/config/{target}/draft/rebase`: mark the draft as started from
/// the published version the editor has now seen (not audited).
async fn config_draft_rebase(
    State(state): State<ConfigDraftsState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(target): Path<String>,
    Json(body): Json<DraftRebaseRequest>,
) -> Result<Json<ConfigDraftSaved>, ApiError> {
    let editor = editor_of(&session)?;
    let saved = state
        .service
        .draft_rebase(
            &target,
            &editor,
            &body.if_revision,
            &body.if_published_revision,
        )
        .await?;
    state.notify(config_draft_changed_event(&target));
    Ok(Json(saved))
}

/// `?ifRevision=` of the draft's DELETE. Left out it is empty, which the
/// service refuses as a field error.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftDiscardQuery {
    #[serde(default)]
    if_revision: String,
}

/// `DELETE /api/config/{target}/draft?ifRevision=`: discard the draft.
/// Audited (`discard`) when a draft was discarded; a call that only
/// confirmed there is none (`ifRevision=0`) changes nothing and records
/// nothing.
async fn config_draft_discard(
    State(state): State<ConfigDraftsState>,
    Extension(session): Extension<AuthenticatedSession>,
    Extension(actor): Extension<AuditActor>,
    Path(target): Path<String>,
    Query(query): Query<DraftDiscardQuery>,
) -> Result<Json<ConfigDraftDiscarded>, ApiError> {
    let editor = editor_of(&session)?;
    let discarded = state
        .service
        .draft_discard(&target, &editor, &query.if_revision)
        .await?;
    if let Some(detail) = discard_audit_detail(&discarded) {
        record_write(
            &state.audit,
            &actor,
            "discard",
            RESOURCE,
            Some(&target),
            Some(detail),
        )
        .await;
        state.notify(config_draft_changed_event(&target));
    }
    Ok(Json(discarded))
}

// --- publish ----------------------------------------------------------------

/// The audit row and the event of a publish or a revert. The action is the
/// outcome's own kind, and the detail is the service's (masked, cut to the
/// audit limits) - the handler adds nothing of the request to it.
async fn record_published(
    state: &ConfigDraftsState,
    actor: &AuditActor,
    target: &str,
    outcome: &PublishOutcome,
) {
    record_write(
        &state.audit,
        actor,
        outcome.kind.as_str(),
        RESOURCE,
        Some(target),
        Some(publish_audit_detail(outcome)),
    )
    .await;
    state.notify(config_changed_event(target));
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishRequest {
    if_draft_revision: String,
    #[serde(default)]
    comment: Option<String>,
}

/// `POST /api/config/{target}/publish`: the draft becomes the published
/// value (one transaction in the service).
async fn config_publish(
    State(state): State<ConfigDraftsState>,
    Extension(session): Extension<AuthenticatedSession>,
    Extension(actor): Extension<AuditActor>,
    Path(target): Path<String>,
    Json(body): Json<PublishRequest>,
) -> Result<Json<PublishOutcome>, ApiError> {
    let editor = editor_of(&session)?;
    let outcome = state
        .service
        .publish(
            &target,
            &editor,
            &body.if_draft_revision,
            &stamp_of(&actor, body.comment.as_deref()),
        )
        .await?;
    record_published(&state, &actor, &target, &outcome).await;
    Ok(Json(outcome))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevertRequest {
    to_version: i64,
    if_published_revision: String,
    #[serde(default)]
    comment: Option<String>,
}

/// `POST /api/config/{target}/revert`: publish the value of an earlier
/// version again, as a new version.
async fn config_revert(
    State(state): State<ConfigDraftsState>,
    Extension(session): Extension<AuthenticatedSession>,
    Extension(actor): Extension<AuditActor>,
    Path(target): Path<String>,
    Json(body): Json<RevertRequest>,
) -> Result<Json<PublishOutcome>, ApiError> {
    let editor = editor_of(&session)?;
    let outcome = state
        .service
        .revert(
            &target,
            &editor,
            body.to_version,
            &body.if_published_revision,
            &stamp_of(&actor, body.comment.as_deref()),
        )
        .await?;
    record_published(&state, &actor, &target, &outcome).await;
    Ok(Json(outcome))
}

// --- unlock -----------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnlockRequest {
    /// The lease of the lock the screen showed: only that lock is removed.
    if_lease: String,
}

/// `POST /api/config/{target}/unlock`: remove the lock the caller saw,
/// whoever holds it. The draft stays.
async fn config_unlock(
    State(state): State<ConfigDraftsState>,
    Extension(actor): Extension<AuditActor>,
    Path(target): Path<String>,
    Json(body): Json<UnlockRequest>,
) -> Result<StatusCode, ApiError> {
    let removed = state
        .service
        .lock_force_release(&target, &body.if_lease)
        .await?;
    record_write(
        &state.audit,
        &actor,
        "unlock",
        RESOURCE,
        Some(&target),
        Some(unlock_audit_detail(&removed)),
    )
    .await;
    state.notify(config_draft_changed_event(&target));
    Ok(StatusCode::NO_CONTENT)
}

// --- the router -------------------------------------------------------------

/// Put `routes` behind `gate`: a refusal is `403` and a `denied` audit row
/// with `resource: "config"`.
fn gated(
    routes: Router<ConfigDraftsState>,
    gate: &ConfigDraftsGate,
    auth: &AuthState,
    audit: &AuditLogService,
) -> Router<ConfigDraftsState> {
    match gate {
        ConfigDraftsGate::Role(min) => routes.layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: *min,
                resource: RESOURCE,
                audit: audit.clone(),
            },
            require_role_at_least,
        )),
        ConfigDraftsGate::Permission(permission) => routes.layer(middleware::from_fn_with_state(
            PermissionGuard {
                auth: auth.clone(),
                permission: permission.clone(),
                resource: RESOURCE,
                audit: audit.clone(),
            },
            require_permission,
        )),
    }
}

/// `/api/config/*` (Issue #938, design §4.11). The app mounts it inside its
/// `/api` layers like the other routers of this module, hands it the
/// service it built at startup (targets registered,
/// [`ConfigDraftsService::ensure_targets`] called) and the `events` sender
/// `/api/events` is fed from.
///
/// The order of the layers is the contract (see the module doc):
/// `require_auth` -> the read gate -> the duty's own gate -> the handler.
pub fn config_drafts_router(
    service: ConfigDraftsService,
    access: ConfigDraftsAccess,
    audit: AuditLogService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
) -> Router {
    let state = ConfigDraftsState {
        service,
        audit: audit.clone(),
        events,
    };
    let read = Router::new()
        .route("/api/config", get(config_list))
        .route("/api/config/{target}", get(config_get))
        .route("/api/config/{target}/diff", get(config_diff))
        .route("/api/config/{target}/history", get(config_history_list))
        .route(
            "/api/config/{target}/history/{version}",
            get(config_history_get),
        );
    let edit = Router::new()
        .route(
            "/api/config/{target}/lock",
            post(config_lock_acquire)
                .put(config_lock_extend)
                .delete(config_lock_release),
        )
        .route(
            "/api/config/{target}/draft",
            put(config_draft_put).delete(config_draft_discard),
        )
        .route(
            "/api/config/{target}/draft/rebase",
            post(config_draft_rebase),
        );
    let publish = Router::new()
        .route("/api/config/{target}/publish", post(config_publish))
        .route("/api/config/{target}/revert", post(config_revert));
    let unlock = Router::new().route("/api/config/{target}/unlock", post(config_unlock));

    let all = read
        .merge(gated(edit, &access.edit, &auth, &audit))
        .merge(gated(publish, &access.publish, &auth, &audit))
        .merge(gated(unlock, &access.unlock, &auth, &audit));
    // The read gate is outside the duty gates: it decides first, for every
    // route.
    gated(all, &access.read, &auth, &audit)
        .with_state(state)
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

#[cfg(test)]
mod tests;
