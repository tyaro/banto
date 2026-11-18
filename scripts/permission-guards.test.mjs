/**
 * 権限のガードの両経路の対称（scripts/lib/permission-guards.mjs、verify-architecture の
 * rule 8、Issue #697）のテスト。テンプレートは権限を登録しないので、実物のガードはまだ無い。
 * ここで「広げ方」が働くことを、派生アプリの形を模した入力で確かめる。
 * 依存を足さない（Node 標準の `node:test` のみ、conventions §3）。
 *
 * 実行: `node --test scripts/permission-guards.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	checkPermissionGuards,
	collectRestPermissionGuards,
	collectTauriPermissionGuards,
	normalizePermissionExpr
} from './lib/permission-guards.mjs';

const TAURI = `
#[tauri::command]
async fn equipment_start(state: State<'_, AppState>, id: i64) -> Result<(), BantoError> {
    equipment_start_body(&state, id).await
}

async fn equipment_start_body(state: &AppState, id: i64) -> Result<(), BantoError> {
    let actor = require_permission(state, &perms::EQUIPMENT_OPERATE, "equipment").await?;
    Ok(())
}

#[tauri::command]
async fn alarm_ack(state: State<'_, AppState>) -> Result<(), BantoError> {
    require_permission(
        &state,
        &PermissionKey::parse("alarm.ack").unwrap(),
        "alarms",
    )
    .await?;
    Ok(())
}

async fn require_permission(state: &AppState, permission: &PermissionKey, resource: &str) {}
`;

const REST = `
pub fn equipment_router(audit: AuditLogService, auth: AuthState) -> Router {
    Router::new()
        .route("/api/equipment/{id}/start", post(start))
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            PermissionGuard {
                auth: auth.clone(),
                permission: perms::EQUIPMENT_OPERATE.clone(),
                resource: "equipment",
                audit,
            },
            require_permission,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

pub fn alarms_router(audit: AuditLogService, auth: AuthState) -> Router {
    Router::new()
        .route("/api/alarms/ack", post(ack))
        .layer(middleware::from_fn_with_state(
            PermissionGuard {
                auth: auth.clone(),
                permission: PermissionKey::parse("alarm.ack").unwrap(),
                resource: "alarms",
                audit,
            },
            require_permission,
        ))
}

pub fn items_router(auth: AuthState) -> Router {
    Router::new().route("/api/items", get(list)).layer(middleware::from_fn_with_state(auth, require_auth))
}
`;

const PAIRS = [
	{
		tauri: 'equipment_start',
		rest: 'POST /api/equipment/{id}/start',
		permission: 'perms::EQUIPMENT_OPERATE'
	},
	{
		tauri: 'alarm_ack',
		rest: 'POST /api/alarms/ack',
		permission: 'PermissionKey::parse("alarm.ack").unwrap()'
	}
];

test('式の正規化: 空白・先頭の & ・末尾の .clone() を除く', () => {
	assert.equal(normalizePermissionExpr(' &perms::X .clone()'), 'perms::X');
	assert.equal(normalizePermissionExpr('&&\n  perms::X'), 'perms::X');
});

test('Tauri: 本体の require_permission の第 2 引数を拾う（複数行・入れ子の括弧・_body）', () => {
	const g = collectTauriPermissionGuards(TAURI);
	assert.deepEqual([...g.entries()].sort(), [
		['alarm_ack', 'PermissionKey::parse("alarm.ack").unwrap()'],
		['equipment_start_body', 'perms::EQUIPMENT_OPERATE']
	]);
});

test('Tauri: 末尾の #[cfg(test)] mod tests の中の呼び出しはガードとして数えない', () => {
	const src = `${TAURI}\n#[cfg(test)]\nmod tests {\n    async fn a_test() {\n        require_permission(&state, &operate, "x").await.unwrap();\n    }\n}\n`;
	assert.deepEqual([...collectTauriPermissionGuards(src).keys()].sort(), [
		'alarm_ack',
		'equipment_start_body'
	]);
});

test('REST: PermissionGuard の permission をそのルータの route に割り当て、ガードの無いルータは含めない', () => {
	const g = collectRestPermissionGuards(REST);
	assert.deepEqual([...g.entries()].sort(), [
		['POST /api/alarms/ack', 'PermissionKey::parse("alarm.ack").unwrap()'],
		['POST /api/equipment/{id}/start', 'perms::EQUIPMENT_OPERATE']
	]);
});

test('対称なら違反なし（_body への委譲も追う）', () => {
	const problems = checkPermissionGuards({
		tauriGuards: collectTauriPermissionGuards(TAURI),
		restGuards: collectRestPermissionGuards(REST),
		pairs: PAIRS
	});
	assert.deepEqual(problems, []);
});

test('違反: 片方の経路で別の権限を見ている', () => {
	const problems = checkPermissionGuards({
		tauriGuards: collectTauriPermissionGuards(
			TAURI.replace('perms::EQUIPMENT_OPERATE', 'perms::ALARM_ACK')
		),
		restGuards: collectRestPermissionGuards(REST),
		pairs: PAIRS
	});
	assert.equal(problems.length, 1);
	assert.match(
		problems[0],
		/equipment_start.*Tauri=perms::ALARM_ACK.*REST=perms::EQUIPMENT_OPERATE/
	);
});

test('違反: 片方の経路にだけガードがある（宣言済みの対の欠け）', () => {
	const problems = checkPermissionGuards({
		tauriGuards: collectTauriPermissionGuards(TAURI),
		restGuards: collectRestPermissionGuards(REST.replace(/pub fn alarms_router[\s\S]*?\n\}/, '')),
		pairs: PAIRS
	});
	assert.equal(problems.length, 1);
	assert.match(problems[0], /alarm_ack.*REST=無し/);
});

test('違反: マニフェストに無いガード（片方の経路だけに足したミス）', () => {
	const problems = checkPermissionGuards({
		tauriGuards: collectTauriPermissionGuards(TAURI),
		restGuards: collectRestPermissionGuards(REST),
		pairs: [PAIRS[0]]
	});
	assert.equal(problems.length, 2);
	assert.ok(problems.some((p) => /未宣言の権限のガード（Tauri）`alarm_ack`/.test(p)));
	assert.ok(problems.some((p) => /未宣言の権限のガード（REST）`POST \/api\/alarms\/ack`/.test(p)));
});

test('ガードが 1 つも無い（テンプレートの今の姿）なら違反なし', () => {
	assert.deepEqual(
		checkPermissionGuards({
			tauriGuards: collectTauriPermissionGuards('async fn require_permission(state: &AppState) {}'),
			restGuards: collectRestPermissionGuards('pub fn users_router() -> Router {\n}'),
			pairs: []
		}),
		[]
	);
});
