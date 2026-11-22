use super::*;
use axum::Extension;
use banto_admin_services::ui_settings::{UiSetting, UiSettingRevision, UiSettingsOwner};

/// `PUT /api/ui-settings/{key}` body (Issue #786, plan §4.4). `ifRevision`
/// left out = unconditional (the last write wins); `"0"` = only when nothing
/// is stored yet; a revision = only while the stored row still has it.
#[derive(Debug, Deserialize)]
struct UiSettingSetRequest {
    value: String,
    #[serde(rename = "ifRevision", default)]
    if_revision: Option<String>,
}

/// `DELETE /api/ui-settings/{key}?ifRevision=` (a query parameter: a DELETE
/// carries no body). Same meaning as [`UiSettingSetRequest::if_revision`].
#[derive(Debug, Deserialize)]
struct UiSettingDeleteQuery {
    #[serde(rename = "ifRevision", default)]
    if_revision: Option<String>,
}

/// Whose settings the request touches (ADR-0034 §8), from the session
/// `require_auth` authorized and put into the request's extensions - nothing
/// is looked up again, and nothing comes from the request itself:
///
/// - a grant session: its kind (`grant:<kind>`), also when its audit rows
///   are attributed to the built-in `admin`;
/// - an account session: the `users.id` it is bound to
///   ([`SessionStamp::account_id`]). NOT the username - a new account with a
///   reused name must not read the deleted account's values;
/// - an account session without a stamp (an `AuthState` built without a
///   session lookup - tests, a public-viewer-only server) has no account row
///   to own a value: refused like a request without a session (fail closed).
fn owner_of(session: &AuthenticatedSession) -> Result<UiSettingsOwner, BantoError> {
    if let Some(kind) = &session.grant {
        return Ok(UiSettingsOwner::Grant(kind.as_str().to_string()));
    }
    session
        .stamp
        .map(|stamp| UiSettingsOwner::Account(stamp.account_id))
        .ok_or(BantoError::Unauthorized)
}

/// `GET /api/ui-settings/{key}` -> `{ value, revision }` (`value: null`,
/// `revision: "0"` when nothing is stored).
async fn ui_settings_get(
    State(settings): State<SettingsService>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(key): Path<String>,
) -> Result<Json<UiSetting>, ApiError> {
    let owner = owner_of(&session)?;
    Ok(Json(settings.ui_get(&owner, &key).await?))
}

/// `PUT /api/ui-settings/{key}` -> `{ revision }`. A failed `ifRevision` is
/// `409` with the `conflict` error body, whose `current` is the stored
/// `{ value, revision }` now.
async fn ui_settings_set(
    State(settings): State<SettingsService>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(key): Path<String>,
    Json(body): Json<UiSettingSetRequest>,
) -> Result<Json<UiSettingRevision>, ApiError> {
    let owner = owner_of(&session)?;
    let revision = settings
        .ui_put(&owner, &key, &body.value, body.if_revision.as_deref())
        .await?;
    Ok(Json(revision))
}

/// `DELETE /api/ui-settings/{key}` -> `{ revision: "0" }`. Conflicts as for
/// the PUT.
async fn ui_settings_delete(
    State(settings): State<SettingsService>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(key): Path<String>,
    Query(query): Query<UiSettingDeleteQuery>,
) -> Result<Json<UiSettingRevision>, ApiError> {
    let owner = owner_of(&session)?;
    let revision = settings
        .ui_delete(&owner, &key, query.if_revision.as_deref())
        .await?;
    Ok(Json(revision))
}

/// `/api/ui-settings/*` (spec M12, Issue #786): `require_auth` only, no
/// [`require_role_at_least`] floor - see `admin-template-core::rest`'s
/// module doc comment for why (every route here only ever touches the
/// caller's OWN rows). Not audited (each owner's own screen memory).
pub fn ui_settings_router(settings: SettingsService, auth: AuthState) -> Router {
    Router::new()
        .route(
            "/api/ui-settings/{key}",
            get(ui_settings_get)
                .put(ui_settings_set)
                .delete(ui_settings_delete),
        )
        .with_state(settings)
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
