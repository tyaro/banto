use axum::extract::State;
use axum::middleware;
use axum::routing::{get, put};
use axum::{Json, Router};
use banto_server::routes::AuditActor;
use banto_server::routes::{record_write, require_role_at_least, RoleGuard};
use banto_server::{require_auth, ApiError, AuthState};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::audit::AuditLogService;
use crate::settings::SettingsService;
use crate::users::Role;

#[derive(Clone)]
struct LoginNoticeState {
    settings: SettingsService,
    audit: AuditLogService,
}

#[derive(Serialize, Deserialize)]
struct LoginNoticeBody {
    notice: String,
}

/// The one public settings key read by the login screen. No arbitrary key input.
async fn login_notice_get(
    State(state): State<LoginNoticeState>,
) -> Result<Json<LoginNoticeBody>, ApiError> {
    Ok(Json(LoginNoticeBody {
        notice: state.settings.login_notice().await?,
    }))
}

async fn login_notice_set(
    State(state): State<LoginNoticeState>,
    axum::Extension(actor): axum::Extension<AuditActor>,
    Json(body): Json<LoginNoticeBody>,
) -> Result<Json<LoginNoticeBody>, ApiError> {
    let notice = state.settings.set_login_notice(&body.notice).await?;
    record_write(
        &state.audit,
        &actor,
        "settings_change",
        "settings",
        None,
        Some(json!({ "key": "login.notice" })),
    )
    .await;
    Ok(Json(LoginNoticeBody { notice }))
}

pub fn login_notice_router(
    settings: SettingsService,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    let state = LoginNoticeState {
        settings,
        audit: audit.clone(),
    };
    let public = Router::new()
        .route("/api/login-notice", get(login_notice_get))
        .with_state(state.clone());
    let admin = Router::new()
        .route("/api/login-notice", put(login_notice_set))
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "settings",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth));
    public.merge(admin)
}
