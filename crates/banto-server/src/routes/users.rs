use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateUserRequest {
    username: String,
    password: String,
    display_name: String,
    role: Role,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateUserRequest {
    display_name: String,
    role: Role,
    /// Optimistic-lock check (Issue #651): the `version` the client read.
    /// Absent / `null` keeps the old last-write-wins update.
    #[serde(default)]
    version: Option<i64>,
    /// Issue #697 (user-permissions-plan §6): the account's permissions after
    /// the update, as keys. Absent / `null` leaves them unchanged (a client
    /// that does not know about permissions keeps working). A malformed or
    /// unregistered key is `422 validation` on `permissions`, nothing written.
    #[serde(default)]
    permissions: Option<Vec<String>>,
}

/// `DELETE /api/users/{id}?version=N` (Issue #651): the optional `version` is
/// the optimistic-lock check (a different stored version is a `409`
/// `conflict`, nothing deleted). A query string, not a body, since this route
/// had no body and some clients/proxies drop a DELETE body.
#[derive(Debug, Default, Deserialize)]
struct UsersDeleteQuery {
    version: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetPasswordRequest {
    new_password: String,
}

#[derive(Debug, Serialize)]
struct ResetPasswordResponse {
    success: bool,
}

/// State for the `/api/users/*` handlers: `UsersService` for the CRUD
/// itself, `AuthState` so `users_delete` can resolve the acting caller's
/// numeric row id from its bearer token (spec M10's self-deletion guard,
/// see `UsersService::delete_user`'s doc comment), and `AuditLogService`
/// (spec M14) so every mutation here records a `create`/`update`/
/// `password_reset`/`delete` entry once it has already succeeded.
#[derive(Clone)]
struct UsersAdminState {
    users: UsersService,
    audit: AuditLogService,
}

/// Resolve the [`UserIdentity`] of the account `session` belongs to - the
/// session `require_auth` validated for this request, not a second look at
/// the bearer token. `require_auth`/`require_role_at_least` have already
/// proven it valid and `admin`-roled by the time a `/api/users/*` handler
/// runs, so this should always succeed - `Unauthorized` here is a defensive
/// fallback (e.g. the account was deleted by another admin between the guard
/// and this read), not an expected path.
async fn acting_user(
    session: &AuthenticatedSession,
    users: &UsersService,
) -> Result<UserIdentity, BantoError> {
    users
        .get_by_username(&session.identity.id)
        .await?
        .ok_or(BantoError::Unauthorized)
}

/// One account on the wire with its stored permissions (Issue #697,
/// user-permissions-plan §6): `UserSummary & { permissions: string[] }`.
/// The `GET /api/users` rows and the `PUT /api/users/{id}` response, and the
/// Tauri `users_list` / `users_update` return the same shape (conventions
/// §1). A response-only wrapper, so [`UserSummary`] itself gets no field
/// (owner decision §8-7). `permissions` are the stored keys, sorted -
/// including ones the app no longer registers (the screen shows those as
/// unregistered). `#[non_exhaustive]`: build it with
/// [`UserWithPermissions::new`].
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct UserWithPermissions {
    #[serde(flatten)]
    pub user: UserSummary,
    pub permissions: Vec<PermissionKey>,
}

impl UserWithPermissions {
    pub fn new(user: UserSummary, permissions: Vec<PermissionKey>) -> Self {
        Self { user, permissions }
    }
}

/// Every account with its stored permissions (Issue #697): the body of
/// `GET /api/users` and the Tauri `users_list`. Two reads (the rows, then
/// every account's permissions at once).
pub async fn list_users_with_permissions(
    users: &UsersService,
) -> Result<Vec<UserWithPermissions>, BantoError> {
    let rows = users.list_users().await?;
    let mut held = users.permissions_by_user().await?;
    Ok(rows
        .into_iter()
        .map(|user| {
            let permissions = held.remove(&user.id).unwrap_or_default();
            UserWithPermissions::new(user, permissions)
        })
        .collect())
}

/// The registered permissions (Issue #697, user-permissions-plan §6): the
/// body of `GET /api/permissions` and the Tauri `permissions_catalog`, in
/// registration order. Empty for the template.
pub fn permission_catalog_entries(users: &UsersService) -> Vec<PermissionEntry> {
    users.permission_catalog().entries().to_vec()
}

async fn users_list(
    State(state): State<UsersAdminState>,
) -> Result<Json<Vec<UserWithPermissions>>, ApiError> {
    Ok(Json(list_users_with_permissions(&state.users).await?))
}

async fn users_create(
    State(state): State<UsersAdminState>,
    axum::Extension(actor): axum::Extension<AuditActor>,
    Json(body): Json<CreateUserRequest>,
) -> Result<Json<UserIdentityView>, ApiError> {
    let identity = state
        .users
        .create_user(
            &body.username,
            &body.password,
            &body.display_name,
            body.role,
        )
        .await?;
    record_write(
        &state.audit,
        &actor,
        "create",
        "users",
        Some(&identity.id.to_string()),
        Some(banto_admin_services::users::user_create_detail(&identity)),
    )
    .await;
    Ok(Json(identity.into()))
}

/// `PUT /api/users/{id}`. Issue #697: `permissions` (optional) is applied in
/// the same write as the display name and role (one version check, one
/// bump); the response is the row with its permissions
/// ([`UserWithPermissions`]). The granting admin recorded as `granted_by` is
/// the caller of THIS request - the audit actor of the session
/// `require_auth` validated (ADR-0034 section 3) - and
/// the permissions it writes are the account's stored state only: nothing
/// here touches any session (it still needs the admin floor of this router).
async fn users_update(
    State(state): State<UsersAdminState>,
    axum::Extension(actor): axum::Extension<AuditActor>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateUserRequest>,
) -> Result<Json<UserWithPermissions>, ApiError> {
    let permissions = body
        .permissions
        .as_deref()
        .map(PermissionKey::parse_all)
        .transpose()?;
    let outcome = state
        .users
        .update_user_with_permissions(
            id,
            &body.display_name,
            body.role,
            permissions.as_deref(),
            body.version,
            &actor.username,
        )
        .await?;
    record_write(
        &state.audit,
        &actor,
        "update",
        "users",
        Some(&id.to_string()),
        Some(
            banto_admin_services::users::user_update_detail_with_permissions(
                &outcome.previous,
                &outcome.updated,
                &outcome.permission_diff,
            ),
        ),
    )
    .await;
    Ok(Json(UserWithPermissions::new(
        outcome.updated,
        outcome.permissions,
    )))
}

async fn users_reset_password(
    State(state): State<UsersAdminState>,
    axum::Extension(actor): axum::Extension<AuditActor>,
    Path(id): Path<i64>,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<Json<ResetPasswordResponse>, ApiError> {
    state.users.reset_password(id, &body.new_password).await?;
    record_write(
        &state.audit,
        &actor,
        "password_reset",
        "users",
        Some(&id.to_string()),
        None,
    )
    .await;
    Ok(Json(ResetPasswordResponse { success: true }))
}

/// `DELETE /api/users/{id}`. The self-deletion guard needs the caller's own
/// row id ([`UsersService::delete_user`]); a grant session (ADR-0017 §3,
/// e.g. a derived app's admin-equivalent commissioning grant) has a fixed
/// identity and no row, so for it - and ONLY for it, judged by the
/// [`AuthenticatedSession`] `require_auth` validated for this request, never
/// by the identity's name - no acting id is passed. An account session whose
/// row cannot be resolved stays `Unauthorized` as before. The `admin` floor
/// (`require_role_at_least`) and "the last admin cannot be deleted" apply to
/// a grant session unchanged.
async fn users_delete(
    State(state): State<UsersAdminState>,
    axum::Extension(session): axum::Extension<AuthenticatedSession>,
    axum::Extension(actor): axum::Extension<AuditActor>,
    Path(id): Path<i64>,
    query: Result<axum::extract::Query<UsersDeleteQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<StatusCode, ApiError> {
    // A malformed `version` (`?version=abc`) answers the usual `ErrorBody`
    // (`bad_request`), not axum's plain-text rejection.
    let axum::extract::Query(query) =
        query.map_err(|err| BantoError::BadRequest(err.body_text()))?;
    let acting_id = if session.grant.is_some() {
        None
    } else {
        Some(acting_user(&session, &state.users).await?.id)
    };
    let removed = state
        .users
        .delete_user_checked_returning_previous(id, acting_id, query.version)
        .await?;
    record_write(
        &state.audit,
        &actor,
        "delete",
        "users",
        Some(&id.to_string()),
        Some(banto_admin_services::users::user_delete_detail(&removed)),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/permissions` (Issue #697, user-permissions-plan §6): the
/// permissions the app registered (`UsersService::permission_catalog`), in
/// registration order, for the admin screen's checkboxes. Empty for the
/// template. Admin only (it rides on this router's floor), like the Tauri
/// `permissions_catalog`.
async fn permissions_list(State(state): State<UsersAdminState>) -> Json<Vec<PermissionEntry>> {
    Json(permission_catalog_entries(&state.users))
}

/// `/api/users/*` (spec M10): `admin`-only account management. Guarded the
/// same way `items_write_router` is (`require_auth` then
/// `require_role_at_least`), just with `Role::Admin` as the floor. Also
/// serves `GET /api/permissions` (Issue #697) under the same floor.
pub fn users_router(users: UsersService, audit: AuditLogService, auth: AuthState) -> Router {
    let state = UsersAdminState {
        users,
        audit: audit.clone(),
    };
    Router::new()
        .route("/api/users", get(users_list).post(users_create))
        .route(
            "/api/users/{id}",
            axum::routing::put(users_update).delete(users_delete),
        )
        .route("/api/users/{id}/reset-password", post(users_reset_password))
        .route("/api/permissions", get(permissions_list))
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "users",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
