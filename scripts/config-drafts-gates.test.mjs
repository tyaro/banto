/**
 * 設定の下書き（Issue #938）のガードの読み取り（scripts/lib/config-drafts-gates.mjs、
 * verify-architecture の rule 8）のテスト。テンプレートの実物（4 つの役目とも admin）に加えて、
 * 派生アプリの形（役目ごとに違うロール・権限）を、実物を書き換えた入力で確かめる。
 * 依存を足さない（Node 標準の `node:test` のみ、conventions §3）。
 *
 * 実行: `node --test scripts/config-drafts-gates.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
	collectConfigDraftsGates,
	collectConfigDraftsRouteDuties,
	collectTauriConfigDuties,
	configDutyPermission,
	configDutyRole,
	parseConfigDraftsAccess
} from './lib/config-drafts-gates.mjs';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const REST_MOD = read('apps/admin-template/core/src/rest/mod.rs');
const ROUTER = read('crates/banto-server/src/routes/config_drafts.rs');
const LIB = read('apps/admin-template/src-tauri/src/lib.rs');

/** verify-architecture の `DUAL_PATH`・`ROLE_READ` の config の行（対の形だけ）。 */
const PAIRS = [
	{ tauri: 'config_list', rest: 'GET /api/config' },
	{ tauri: 'config_get', rest: 'GET /api/config/{target}' },
	{ tauri: 'config_diff', rest: 'GET /api/config/{target}/diff' },
	{ tauri: 'config_history_list', rest: 'GET /api/config/{target}/history' },
	{ tauri: 'config_history_get', rest: 'GET /api/config/{target}/history/{version}' },
	{ tauri: 'config_lock_acquire', rest: 'POST /api/config/{target}/lock' },
	{ tauri: 'config_lock_extend', rest: 'PUT /api/config/{target}/lock' },
	{ tauri: 'config_lock_release', rest: 'DELETE /api/config/{target}/lock' },
	{ tauri: 'config_draft_put', rest: 'PUT /api/config/{target}/draft' },
	{ tauri: 'config_draft_rebase', rest: 'POST /api/config/{target}/draft/rebase' },
	{ tauri: 'config_draft_discard', rest: 'DELETE /api/config/{target}/draft' },
	{ tauri: 'config_publish', rest: 'POST /api/config/{target}/publish' },
	{ tauri: 'config_revert', rest: 'POST /api/config/{target}/revert' },
	{ tauri: 'config_unlock', rest: 'POST /api/config/{target}/unlock' }
];
const ROUTES = new Set(PAIRS.map((pair) => pair.rest));

// scaffold の minimal・display は配線を外す。実物を読む試験は、そのコピーでは飛ばす。
const wired = /\bfn config_drafts_access\b/.test(REST_MOD);
const onTemplate = { skip: wired ? false : 'このコピーは設定の下書きを配線していない' };

const collect = (overrides = {}) =>
	collectConfigDraftsGates({
		appSources: [REST_MOD],
		routerSrc: ROUTER,
		libSrc: LIB,
		pairs: PAIRS,
		routes: ROUTES,
		...overrides
	});

/** 実物の配線のリテラルの 1 欄を書き換える（1 か所だけ当たることを確かめる）。 */
function withGate(duty, gate) {
	const from = `${duty}: ConfigDraftsGate::Role(Role::Admin),`;
	assert.equal(REST_MOD.split(from).length, 2, `rest/mod.rs に \`${from}\` が 1 つだけある`);
	return REST_MOD.replace(from, `${duty}: ${gate},`);
}

test('テンプレートの実物: 4 つの役目とも admin と読める', onTemplate, () => {
	const access = parseConfigDraftsAccess(REST_MOD);
	assert.deepEqual(access, {
		gates: {
			read: { kind: 'role', role: 'Admin' },
			edit: { kind: 'role', role: 'Admin' },
			publish: { kind: 'role', role: 'Admin' },
			unlock: { kind: 'role', role: 'Admin' }
		}
	});
});

test(
	'テンプレートの実物: REST の 14 の口と Tauri の 14 のコマンドの役目が対で一致する',
	onTemplate,
	() => {
		const routeDuties = collectConfigDraftsRouteDuties(ROUTER);
		assert.equal(routeDuties.size, 14);
		assert.equal(routeDuties.get('GET /api/config'), 'read');
		assert.equal(routeDuties.get('DELETE /api/config/{target}/lock'), 'edit');
		assert.equal(routeDuties.get('POST /api/config/{target}/draft/rebase'), 'edit');
		assert.equal(routeDuties.get('POST /api/config/{target}/revert'), 'publish');
		assert.equal(routeDuties.get('POST /api/config/{target}/unlock'), 'unlock');

		const tauriDuties = collectTauriConfigDuties(LIB);
		assert.equal(tauriDuties.size, 14, [...tauriDuties.keys()].join(', '));
		assert.equal(tauriDuties.get('config_publish_body'), 'publish');
		// コメントの中の見本・ガードの関数そのものは拾わない。
		assert.equal(tauriDuties.has('require_config'), false);
		assert.equal(tauriDuties.has('require_config_gate'), false);

		const result = collect();
		assert.deepEqual(result.problems, []);
		assert.equal(result.restRoles.size, 14);
		assert.equal(result.tauriRoles.size, 14);
		for (const role of [...result.restRoles.values(), ...result.tauriRoles.values()])
			assert.equal(role, 'Admin');
		assert.equal(result.restPermissions.size, 0);
		assert.equal(result.tauriPermissions.size, 0);
	}
);

test('口の床は「読む」と役目のガードの高い方', () => {
	const gates = {
		read: { kind: 'role', role: 'Viewer' },
		edit: { kind: 'role', role: 'Editor' },
		publish: { kind: 'role', role: 'Admin' },
		unlock: { kind: 'permission', permission: 'perms::config_unlock()' }
	};
	assert.equal(configDutyRole(gates, 'read'), 'Viewer');
	assert.equal(configDutyRole(gates, 'edit'), 'Editor');
	assert.equal(configDutyRole(gates, 'publish'), 'Admin');
	// 権限のガードはロールを見ないので、床は「読む」のまま。
	assert.equal(configDutyRole(gates, 'unlock'), 'Viewer');
	assert.equal(configDutyPermission(gates, 'unlock'), 'perms::config_unlock()');
	assert.equal(configDutyPermission(gates, 'edit'), null);

	// 「読む」の方が高ければ、役目のガードが低くても「読む」の床になる。
	const readHigher = { ...gates, read: { kind: 'role', role: 'Admin' } };
	assert.equal(configDutyRole(readHigher, 'edit'), 'Admin');
	// 「読む」が権限なら、ロールのガードの口にもその権限が掛かる。
	const readPermission = { ...gates, read: { kind: 'permission', permission: 'perms::READ' } };
	assert.equal(configDutyRole(readPermission, 'read'), 'Auth');
	assert.equal(configDutyRole(readPermission, 'edit'), 'Editor');
	assert.equal(configDutyPermission(readPermission, 'edit'), 'perms::READ');
	assert.equal(configDutyPermission(readPermission, 'unlock'), 'perms::config_unlock()');
	// 順の分からないロールどうしは、宣言と一致しない値にする。
	const unknown = { ...gates, read: { kind: 'role', role: 'Operator' } };
	assert.equal(configDutyRole(unknown, 'publish'), 'Operator+Admin');
});

test('派生アプリの形: ガードを差し替えると、両経路の床と権限が同じに変わる', onTemplate, () => {
	const src = withGate('read', 'ConfigDraftsGate::Role(Role::Viewer)')
		.replace(
			'publish: ConfigDraftsGate::Role(Role::Admin),',
			'publish: ConfigDraftsGate::Permission(perms::config_publish().clone()),'
		)
		.replace(
			'edit: ConfigDraftsGate::Role(Role::Admin),',
			'edit: ConfigDraftsGate::Role(Role::Editor),'
		);
	const result = collect({ appSources: [src] });
	assert.deepEqual(result.problems, []);
	assert.equal(result.restRoles.get('GET /api/config'), 'Viewer');
	assert.equal(result.tauriRoles.get('config_list_body'), 'Viewer');
	assert.equal(result.restRoles.get('PUT /api/config/{target}/draft'), 'Editor');
	assert.equal(result.tauriRoles.get('config_draft_put_body'), 'Editor');
	assert.equal(result.restRoles.get('POST /api/config/{target}/unlock'), 'Admin');
	assert.equal(result.tauriRoles.get('config_unlock_body'), 'Admin');
	// 権限のガードの口: 床は「読む」、権限は両経路で同じ式（正規化済み）。
	assert.equal(result.restRoles.get('POST /api/config/{target}/publish'), 'Viewer');
	assert.deepEqual(
		[...result.restPermissions],
		[
			['POST /api/config/{target}/publish', 'perms::config_publish()'],
			['POST /api/config/{target}/revert', 'perms::config_publish()']
		]
	);
	assert.deepEqual(
		[...result.tauriPermissions],
		[
			['config_publish_body', 'perms::config_publish()'],
			['config_revert_body', 'perms::config_publish()']
		]
	);
});

test('コマンドの役目が REST の口と違えば落ちる（床が同じでも）', onTemplate, () => {
	const from = 'let caller = require_config(state, ConfigDuty::Publish).await?;';
	assert.equal(LIB.split(from).length, 3, '反映と元に戻すの 2 か所');
	const lib = LIB.replace(from, 'let caller = require_config(state, ConfigDuty::Edit).await?;');
	const result = collect({ libSrc: lib });
	assert.equal(result.problems.length, 1);
	assert.match(result.problems[0], /`config_publish` ⇔ `POST \/api\/config\/\{target\}\/publish`/);
	assert.match(result.problems[0], /Tauri=edit \/ REST=publish/);
});

test('ガードを通さないコマンド・対の片方だけが config の対は落ちる', onTemplate, () => {
	const lib = LIB.replace(
		'require_config(state, ConfigDuty::Unlock)',
		'require_role(state, Role::Admin, CONFIG_RESOURCE)'
	);
	const result = collect({ libSrc: lib });
	assert.equal(result.problems.length, 1);
	assert.match(result.problems[0], /`config_unlock`.*Tauri=無し \/ REST=unlock/);
});

test('リテラルを読めない形は、理由つきで落ちる', () => {
	const literal = (body) => `
pub fn config_drafts_access() -> ConfigDraftsAccess {
    ConfigDraftsAccess {
${body}
    }
}
`;
	const all = [
		'        read: ConfigDraftsGate::Role(Role::Admin),',
		'        edit: ConfigDraftsGate::Role(Role::Admin),',
		'        publish: ConfigDraftsGate::Role(Role::Admin),',
		'        unlock: ConfigDraftsGate::Role(Role::Admin),'
	];
	assert.ok(parseConfigDraftsAccess(literal(all.join('\n'))).gates);
	// 残りを既定で埋める形。
	assert.match(
		parseConfigDraftsAccess(literal([all[0], '        ..ConfigDraftsAccess::default()'].join('\n')))
			.error,
		/`\.\.` で残りの欄を省いている/
	);
	// 欄が足りない（構文としては通らないが、読み取りが黙って通さないこと）。
	assert.match(parseConfigDraftsAccess(literal(all.slice(0, 3).join('\n'))).error, /unlock/);
	// 値をその場に書かない（変数・関数の呼び出し）。
	assert.match(
		parseConfigDraftsAccess(literal(['        read: read_gate(),', ...all.slice(1)].join('\n')))
			.error,
		/`read` の値を読めない/
	);
	// 中身の違うリテラルが 2 つ。
	assert.match(
		parseConfigDraftsAccess(
			literal(all.join('\n')) + literal(all.join('\n').replace('Role::Admin', 'Role::Viewer'))
		).error,
		/2 つ以上/
	);
	// リテラルではない物（型の定義・impl・戻り値の型・コメントの中の見本）だけなら「無い」。
	assert.equal(
		parseConfigDraftsAccess(`
pub struct ConfigDraftsAccess {
    pub read: ConfigDraftsGate,
}
impl Default for ConfigDraftsAccess {
    fn default() -> Self {
        Self { read: ConfigDraftsGate::Role(Role::Admin) }
    }
}
/// let access = ConfigDraftsAccess { read: ConfigDraftsGate::Role(Role::Editor) };
pub fn access() -> ConfigDraftsAccess {
    ConfigDraftsAccess::default()
}
`),
		null
	);
});

test('配線があるのにリテラルが無ければ落ち、配線が無ければ何も言わない', onTemplate, () => {
	const noLiteral =
		'pub fn config_drafts_access() -> ConfigDraftsAccess {\n    ConfigDraftsAccess::default()\n}\n';
	const missing = collect({ appSources: [noLiteral] });
	assert.equal(missing.problems.length, 1);
	assert.match(missing.problems[0], /リテラルが無い/);

	// scaffold の minimal・display の後: Route table に行が無く、コマンドも無い。
	const removed = collect({
		appSources: [''],
		libSrc: 'async fn ping_body(state: &AppState) {}\n',
		pairs: [{ tauri: 'users_create', rest: 'POST /api/users' }],
		routes: new Set(['POST /api/users'])
	});
	assert.deepEqual(removed.problems, []);
	assert.equal(removed.restRoles.size, 0);
	assert.equal(removed.tauriRoles.size, 0);
});
