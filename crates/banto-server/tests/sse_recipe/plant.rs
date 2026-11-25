use axum::response::Response;
use axum::routing::get;
use axum::{middleware, Extension, Router};
use banto_admin_services::audit::AuditLogService;
use banto_admin_services::permissions::PermissionKey;
use banto_server::routes::{require_permission, PermissionGuard};
use banto_server::{require_auth, sse_response, watch_frames, AuthState, SseContext, SseFrame};
use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

/// この配信を見る権限。層とハンドラーで同じ定数を使う（名前を 2 回書かない）。
pub const PLANT_VIEW: &str = "plant.view";

fn plant_view() -> PermissionKey {
    PermissionKey::parse(PLANT_VIEW).expect("a well-formed key")
}

/// 配信する値 1 件。`made_at` は作る側が入れる「作った印」（ミリ秒の時刻）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub made_at: u64,
    pub value: f64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 値を読む処理（アプリのもの。ここでは見本の代わりの固定値）。
async fn read_sensor() -> Option<f64> {
    Some(20.5)
}

/// 値を作る側。周期ごとに、値が同じでも `send_replace` する。
/// 読めなかった周期は送らない（止まったことを、新しい値が来ないことで見せる）。
/// チャネルの初期値は「値なし」（`None`）。最初の読み取りが成功するまで、
/// 作り物の値と今の時刻の印を配信しない。
pub fn spawn_producer(period: Duration) -> watch::Sender<Option<Reading>> {
    let (tx, _) = watch::channel(None);
    let sender = tx.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(period);
        loop {
            tick.tick().await;
            if let Some(value) = read_sensor().await {
                sender.send_replace(Some(Reading {
                    made_at: now_ms(),
                    value,
                }));
            }
        }
    });
    tx
}

async fn plant_stream(
    context: SseContext,
    Extension(values): Extension<watch::Sender<Option<Reading>>>,
) -> Response {
    let frames = watch_frames(values.subscribe(), |reading| {
        // 値がまだ無い間（最初の読み取りの前）は送らない。
        SseFrame::json(reading.as_ref()?).ok()?.event("values").ok()
    });
    // 開いた後も権限を読み直す（外れたら次の確かめ直しで閉じる）。
    // この画面は /api/events を開かないので、接続 n 台に数える。
    sse_response(
        context.require_permission(plant_view()).counted_as_client(),
        frames,
    )
}

pub fn plant_router(
    values: watch::Sender<Option<Reading>>,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/plant/stream", get(plant_stream))
        .layer(Extension(values))
        // 開くときの拒否を監査（`denied`）に残すための層。開いた後は見ない。
        .layer(middleware::from_fn_with_state(
            PermissionGuard {
                auth: auth.clone(),
                permission: plant_view(),
                resource: "plant",
                audit,
            },
            require_permission,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
