use super::*;

// --- M17: SQLite backup/restore ---------------------------------------------

/// Request-body size cap for `POST /api/backups/restore` (spec M17: "サイズ
/// 上限（例256MB）を設ける"). Applied via `DefaultBodyLimit` on
/// [`backups_router`] - axum's own built-in default is 2MB
/// (`axum::extract::DefaultBodyLimit`), far too small for an uploaded DB
/// backup.
const MAX_RESTORE_UPLOAD_BYTES: usize = 256 * 1024 * 1024;

/// State for the `/api/backups/*` handlers (spec M17): `BackupService` for
/// the operation itself, plus `AuditLogService`/`AuthState` so
/// `backups_create_handler`/`backups_restore_from_upload`/
/// `backups_restore_from_existing`/`backups_cancel_pending` can each record
/// their own audit entry once the underlying service call has already
/// succeeded (same pattern as `ItemsWriteState`/`UsersAdminState`). Read
/// handlers (`backups_list`/`backups_download`/`backups_pending_status`)
/// also take this state (rather than a narrower read-only one) purely to
/// avoid a second near-identical struct - they simply never touch `audit`.
#[derive(Clone)]
struct BackupsState {
    backup: BackupService,
    audit: AuditLogService,
    auth: AuthState,
}

async fn backups_create_handler(
    State(state): State<BackupsState>,
    headers: HeaderMap,
) -> Result<Json<BackupInfo>, ApiError> {
    let info = state.backup.create().await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "backup",
        "backups",
        Some(&info.file_name),
        Some(json!({ "sizeBytes": info.size_bytes })),
    )
    .await;
    Ok(Json(info))
}

async fn backups_list_handler(
    State(state): State<BackupsState>,
) -> Result<Json<Vec<BackupInfo>>, ApiError> {
    Ok(Json(state.backup.list().await?))
}

/// `GET /api/backups/{fileName}` (spec M17): LAN download. Not audited -
/// same "read routes are never audited" convention as everywhere else (see
/// this module's doc comment).
async fn backups_download_handler(
    State(state): State<BackupsState>,
    Path(file_name): Path<String>,
) -> Result<Response, ApiError> {
    let bytes = state.backup.read(&file_name).await?;
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "application/octet-stream")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{file_name}\""),
        )
        .body(axum::body::Body::from(bytes))
        .map_err(|err| ApiError(BantoError::Other(err.to_string())))?;
    Ok(response)
}

#[derive(Debug, Deserialize)]
struct RestoreUploadQuery {
    #[serde(rename = "fileName")]
    file_name: Option<String>,
}

/// `POST /api/backups/restore?fileName=` (spec M17): stage a restore from a
/// raw uploaded file. `fileName` (if present) is ONLY ever used for the
/// audit `detail` - the uploaded bytes are always staged under
/// `BackupService`'s own fixed `restore-pending.sqlite3` name, never under
/// the client-supplied name (see this module's doc comment).
async fn backups_restore_from_upload(
    State(state): State<BackupsState>,
    headers: HeaderMap,
    Query(query): Query<RestoreUploadQuery>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    // Issue #793 S2: the guards decided when the head of the request came
    // in; the upload itself (up to 256 MB, streamed) may have taken any
    // length of time since. Decide again before staging - an admin removed
    // or demoted meanwhile must not get a restore staged by finishing an
    // upload it had left open.
    let session = recheck_role_at_least(
        &state.auth,
        &state.audit,
        &headers,
        Role::Admin,
        "backups",
        json!({ "method": "POST", "path": "/api/backups/restore" }),
    )
    .await?;
    state.backup.stage_restore_from_bytes(&body).await?;
    // `entity_id` stays `None` here on purpose: the canonical rule is
    // "entity_id = the backup file's real name" (like `backups_create` /
    // restore-from-existing on BOTH paths), and an upload has no real backup
    // file identity - the client-supplied display name is untrusted and only
    // ever recorded inside `detail` (maintenance-review-2026-08 §5.3 M-15).
    record_write_as(
        &state.audit,
        Some(AuditActor::from(&session.identity)),
        "rest",
        "restore_staged",
        "backups",
        None,
        Some(json!({ "source": "upload", "fileName": query.file_name })),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/backups/{fileName}/restore` (spec M17): stage a restore from
/// an existing backup already in `backups/`.
async fn backups_restore_from_existing(
    State(state): State<BackupsState>,
    headers: HeaderMap,
    Path(file_name): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.backup.stage_restore_from_file(&file_name).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "restore_staged",
        "backups",
        Some(&file_name),
        Some(json!({ "source": "existing", "fileName": file_name })),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn backups_pending_status(
    State(state): State<BackupsState>,
) -> Json<Option<PendingRestoreInfo>> {
    Json(state.backup.pending_restore().await)
}

async fn backups_cancel_pending(
    State(state): State<BackupsState>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    state.backup.cancel_pending_restore().await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "restore_cancelled",
        "backups",
        None,
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `/api/backups/*` (spec M17): `admin`-only, guarded the same way
/// `users_router`/`audit_log_router` are. `DefaultBodyLimit::max` raises the
/// upload route's body cap from axum's 2MB default to
/// `MAX_RESTORE_UPLOAD_BYTES` - on that route alone: a route that accepts a
/// body over 2 MiB must decide the role again once the body is in (Issue
/// #793 S2, conventions section 1; `backups_restore_from_upload` does), so
/// the raised cap is not spread over the router.
pub fn backups_router(backup: BackupService, audit: AuditLogService, auth: AuthState) -> Router {
    let state = BackupsState {
        backup,
        audit: audit.clone(),
        auth: auth.clone(),
    };
    Router::new()
        .route(
            "/api/backups",
            post(backups_create_handler).get(backups_list_handler),
        )
        .route(
            "/api/backups/restore",
            post(backups_restore_from_upload).layer(axum::extract::DefaultBodyLimit::max(
                MAX_RESTORE_UPLOAD_BYTES,
            )),
        )
        .route(
            "/api/backups/pending-restore",
            get(backups_pending_status).delete(backups_cancel_pending),
        )
        .route("/api/backups/{fileName}", get(backups_download_handler))
        .route(
            "/api/backups/{fileName}/restore",
            post(backups_restore_from_existing),
        )
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "backups",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
