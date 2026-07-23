#!/usr/bin/env node
/**
 * アーキテクチャ規約の機械検査（improvement-plan-2026-07.md P3-5）。
 * docs/conventions.md のうち「機械で検査可能な不変条件」を CI で強制する。
 * 依存を足さない文化（conventions §3）に従い Node 標準ライブラリのみ。
 *
 * 検査する規約（違反 = exit 1。各ルールの根拠は conventions.md の該当節）:
 *   1. §2 サービス層は tauri/axum を知らない
 *      … core/src（rest/ と bin/ を除く）と banto-{core,storage,attachments}
 *        に `use axum` / `use tauri` がないこと
 *   2. §4 パッケージ間 import ゼロ … packages/星/src に `from '@banto/...'` がない
 *   3. §5 パッケージはアプリ固有 import を持たない … 同上に `from '$lib...'` がない
 *   4. §7 {@html} は許可リストの2箇所のみ
 *   5. §9 コンポーネント CSS に生の色値を書かない
 *      … packages（theme を除く）の .svelte <style> ブロックに hex/rgb()/hsl()
 *        がない（コメントは除去してから検査。許可リストは理由付きで下記）
 *   6. §4 パッケージの dependencies / peerDependencies は空
 *   7. ドキュメント整合性: docs/・README・AGENTS・CLAUDE の `@banto/*` 参照が
 *      実在パッケージのみ（conventions の不変条件ではなくドキュメントと実装の
 *      ドリフト対策。実在しない `@banto/grid-core` 等の掲載を防ぐ）
 *   8. §1 REST/Tauri 両経路対称 … mutating 操作が両経路に存在するかを
 *      DUAL_PATH マニフェスト + 完全性チェックで担保（片側だけ足すのを捕捉）。
 *      maintainability-review-2026-07.md CR-1
 *   9. §6 セキュリティ不変条件（grep 可能なもの、CR-2）:
 *      NewAttachment に mime フィールド無し / settings_get·set は Admin 対称
 *
 * 許可リストへの追加は「設計判断としてコード内コメントで正当化されている」
 * ことを条件とし、理由をここに1行で書く（レビュー対象）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** conventions §7: {@html} を書いてよいファイル（全エスケープ済み出力のみ）。 */
const HTML_ALLOWLIST = new Set([
	// 自前エンジン renderHtml の出力のみ（html.ts が全 text/attribute をエスケープ）
	'packages/report/src/ReportView.svelte',
	// qrcode クレート生成の SVG（LAN 接続 QR）
	'apps/admin-template/src/routes/(app)/settings/+page.svelte'
]);

/** conventions §9: 生の色値を許可するファイルと、その根拠。 */
const RAW_COLOR_ALLOWLIST = new Map([
	// 印刷 CSS はテーマ非依存の白地・黒文字固定（帳票の再現性優先、
	// template-scope §3 / report-plan §3.4）
	['packages/report/src/ReportView.svelte', new Set(['#ffffff'])],
	// danger-solid 上の文字色は両モードとも固定白（--banto-on-solid はダークで
	// 暗転するため使えない — BantoGrid.svelte 内コメント / plan Appendix A.3）
	['packages/grid-svelte/src/BantoGrid.svelte', new Set(['#ffffff'])]
]);

let failures = 0;
const results = [];

function fail(rule, file, detail) {
	failures++;
	results.push(`  ✗ [${rule}] ${file}${detail ? ` — ${detail}` : ''}`);
}

function pass(rule, summary) {
	results.push(`  ✔ [${rule}] ${summary}`);
}

function* walk(dir, exts) {
	const abs = path.join(repoRoot, dir);
	if (!fs.existsSync(abs)) return;
	for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
		const rel = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.svelte-kit') continue;
			yield* walk(rel, exts);
		} else if (exts.some((ext) => entry.name.endsWith(ext))) {
			yield rel.split(path.sep).join('/');
		}
	}
}

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// --- 1. サービス層は tauri/axum を知らない（conventions §2） ----------------

{
	const rule = 'service-layer';
	let checked = 0;
	const dirs = [
		'apps/admin-template/core/src',
		'crates/banto-core/src',
		'crates/banto-storage/src',
		'crates/banto-attachments/src'
	];
	for (const dir of dirs) {
		for (const file of walk(dir, ['.rs'])) {
			// rest/ は REST の wiring 層（axum を使うのが仕事）、bin/ はサーバ起動。
			if (file.includes('/rest/') || file.includes('/bin/')) continue;
			checked++;
			const src = read(file);
			const match = src.match(/^\s*use (axum|tauri)\b/m);
			if (match) fail(rule, file, `\`use ${match[1]}\` はサービス層に持ち込まない`);
		}
	}
	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, `サービス層 ${checked} ファイルに axum/tauri 依存なし`);
}

// --- 2+3. パッケージの import 検査（conventions §4 / §5） --------------------

{
	let checked = 0;
	for (const file of walk('packages', ['.ts', '.svelte'])) {
		if (!file.includes('/src/')) continue;
		checked++;
		const src = read(file);
		if (/from\s+['"]@banto\//.test(src))
			fail('no-cross-package', file, 'パッケージ間 import は禁止（§4）');
		if (/from\s+['"]\$lib/.test(src))
			fail('no-app-import', file, 'アプリ固有 import は禁止（§5）— client 注入にする');
	}
	if (!results.some((r) => r.includes('[no-cross-package]')))
		pass('no-cross-package', `packages ${checked} ファイルに @banto/* import なし`);
	if (!results.some((r) => r.includes('[no-app-import]')))
		pass('no-app-import', `packages に $lib import なし`);
}

// --- 4. {@html} 許可リスト（conventions §7） ---------------------------------

{
	const rule = 'html-allowlist';
	let found = 0;
	for (const dir of ['packages', 'apps/admin-template/src']) {
		for (const file of walk(dir, ['.svelte'])) {
			if (!read(file).includes('{@html')) continue;
			found++;
			if (!HTML_ALLOWLIST.has(file))
				fail(
					rule,
					file,
					'{@html} の新規使用 — conventions §7 の条件を満たすならこのスクリプトの許可リストへ理由付きで追加'
				);
		}
	}
	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, `{@html} は許可済み ${found} 箇所のみ`);
}

// --- 5. 生の色値（conventions §9。theme パッケージは集約先なので対象外） ----

{
	const rule = 'raw-colors';
	let checkedBlocks = 0;
	for (const file of walk('packages', ['.svelte'])) {
		if (!file.includes('/src/') || file.startsWith('packages/theme/')) continue;
		const src = read(file);
		const allowed = RAW_COLOR_ALLOWLIST.get(file) ?? new Set();
		for (const block of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
			checkedBlocks++;
			const css = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
			for (const hit of css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)) {
				if (allowed.has(hit[0])) continue;
				fail(rule, file, `生の色値 \`${hit[0]}\` — --banto-* トークンを使う（§9）`);
			}
		}
	}
	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, `package コンポーネント ${checkedBlocks} <style> ブロックに未許可の生色値なし`);
}

// --- 6. パッケージの依存は空（conventions §4） -------------------------------

{
	const rule = 'empty-deps';
	for (const dir of fs.readdirSync(path.join(repoRoot, 'packages'))) {
		const rel = `packages/${dir}/package.json`;
		if (!fs.existsSync(path.join(repoRoot, rel))) continue;
		const pkg = JSON.parse(read(rel));
		for (const field of ['dependencies', 'peerDependencies']) {
			if (pkg[field] && Object.keys(pkg[field]).length > 0)
				fail(rule, rel, `${field} は空であること（§4）: ${Object.keys(pkg[field]).join(', ')}`);
		}
	}
	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, '全パッケージの dependencies/peerDependencies が空');
}

// --- 7. docs 内の @banto/* 参照は実在パッケージのみ（ドキュメント整合性） ----

{
	const rule = 'docs-package-refs';
	// 実在パッケージ名は packages/*/package.json から動的取得（追加/改名に自動追従）。
	const realPackages = new Set();
	for (const dir of fs.readdirSync(path.join(repoRoot, 'packages'))) {
		const rel = `packages/${dir}/package.json`;
		if (!fs.existsSync(path.join(repoRoot, rel))) continue;
		realPackages.add(JSON.parse(read(rel)).name);
	}
	// 「存在しないパッケージ」を意図的にスコープ付きで名指しする場合のみ許可（理由付き）。
	// 現状なし（作らないと決めた grid-core/dock-core はスコープ無しで書くこと）。
	const DOCS_PACKAGE_REF_ALLOWLIST = new Set([]);
	const docFiles = [
		'README.md',
		'README.en.md',
		'AGENTS.md',
		'CLAUDE.md',
		...walk('docs', ['.md'])
	];
	let checkedRefs = 0;
	for (const file of docFiles) {
		if (!fs.existsSync(path.join(repoRoot, file))) continue;
		const src = read(file);
		for (const m of src.matchAll(/@banto\/[a-z0-9-]+/g)) {
			const ref = m[0];
			checkedRefs++;
			if (realPackages.has(ref) || DOCS_PACKAGE_REF_ALLOWLIST.has(ref)) continue;
			fail(
				rule,
				file,
				`実在しないパッケージ参照 \`${ref}\` — packages/ に無い。存在しないことを述べたいならスコープ無し（例: \`grid-core\`）で書くか、意図的なら許可リストへ理由付きで追加`
			);
		}
	}
	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, `docs/README/AGENTS/CLAUDE の @banto/* 参照 ${checkedRefs} 件すべて実在`);
}

// --- 8. REST/Tauri 両経路対称（conventions §1、maintainability-review CR-1） ---
//
// このテンプレートの背骨の不変条件（§1）: mutating 操作は REST 経路と Tauri
// 経路の両方で同一の認可・監査を通す。AI が「片方の経路にだけ mutating
// コマンドを足す」ミスをしても、従来は落ちる検査が一つも無かった（しかも
// src-tauri はこのサンドボックスでコンパイルできず実行でも気づけない）。
//
// 自動対応は不可（REST ハンドラ名と Tauri コマンド名は食い違い、mutating でも
// desktop-only が多数、POST でも *_list は読み取り）。そこで下の DUAL_PATH
// マニフェストで対応を明示し、**完全性チェック**で自己強制する: 新しい
// コマンド/ルートを分類に足さない限り CI が落ちる → 片側追加を必ず捕捉する。
//
// アンカーは信頼できる2つの一次情報のみ:
//   - Tauri: src-tauri/src/lib.rs のトップレベル `#[tauri::command] fn 名`
//   - REST : rest/mod.rs モジュール doc の「Route table」（§1 が対応表と
//            指定する成果物。実ルート宣言との同期は下の doc-sync で担保）
//
// 分類はリポジトリ所有者が確認済み（maintainability-review-2026-07.md §3、
// 2026-07-21）。desktop-only / read の判断を変えるときはここを更新する。
{
	const rule = 'two-path-symmetry';

	// mutating な dual-path 操作: REST と Tauri の両方に存在しなければならない。
	// rest は "METHOD /path"（クエリ文字列は除く）。backups の復元系は経路が
	// 非対称（Tauri は stage→再起動適用、REST は from-upload/from-existing）
	// なので、2つの REST ルートを同一 Tauri コマンドに対応させる（所有者確認済み）。
	// `role` は期待するロール床（CR-6, 2026-07-22）。宣言した対だけロール床の
	// 対称も照合する（下記 (e)）。auth 系（公開 / 認証のみで resource ロール床が
	// 無い）は role を付けず、存在チェックのみ対象にする。
	const DUAL_PATH = [
		{ tauri: 'auth_setup', rest: 'POST /api/auth/setup' },
		{ tauri: 'auth_login', rest: 'POST /api/auth/login' },
		{ tauri: 'auth_logout', rest: 'POST /api/auth/logout' },
		{ tauri: 'auth_change_password', rest: 'POST /api/auth/change-password' },
		{ tauri: 'items_create', rest: 'POST /api/items', role: 'Editor' },
		{ tauri: 'items_update', rest: 'PUT /api/items/{id}', role: 'Editor' },
		{ tauri: 'items_delete', rest: 'DELETE /api/items/{id}', role: 'Editor' },
		{ tauri: 'items_import', rest: 'POST /api/items/import', role: 'Editor' },
		{ tauri: 'users_create', rest: 'POST /api/users', role: 'Admin' },
		{ tauri: 'users_update', rest: 'PUT /api/users/{id}', role: 'Admin' },
		{ tauri: 'users_delete', rest: 'DELETE /api/users/{id}', role: 'Admin' },
		{ tauri: 'users_reset_password', rest: 'POST /api/users/{id}/reset-password', role: 'Admin' },
		{ tauri: 'ui_settings_set', rest: 'PUT /api/ui-settings/{key}', role: 'Viewer' },
		{ tauri: 'audit_config_apply', rest: 'PUT /api/audit-log/config', role: 'Admin' },
		{ tauri: 'backups_create', rest: 'POST /api/backups', role: 'Admin' },
		{ tauri: 'backups_stage_restore', rest: 'POST /api/backups/restore', role: 'Admin' },
		{ tauri: 'backups_stage_restore', rest: 'POST /api/backups/{fileName}/restore', role: 'Admin' },
		{ tauri: 'backups_cancel_restore', rest: 'DELETE /api/backups/pending-restore', role: 'Admin' },
		{ tauri: 'attachments_upload', rest: 'POST /api/attachments', role: 'Editor' },
		{ tauri: 'attachments_delete', rest: 'DELETE /api/attachments/{id}', role: 'Editor' }
	];

	// ロール床を照合したい読み取り系の対（CR-6）。読み取りは rule 8 の存在対称の
	// 対象外（TAURI_READ/REST_READ）だが、ロール床の非対称は起こりうる — 実際
	// `audit_config_get`（Tauri=Viewer / REST=Admin）が非対称だった。
	const ROLE_READ = [
		{ tauri: 'audit_config_get', rest: 'GET /api/audit-log/config', role: 'Admin' },
		{ tauri: 'audit_log_list', rest: 'POST /api/audit-log/list', role: 'Admin' }
	];

	// desktop-only（OS/ローカル統合。REST を持たないのが正しい、§1 の対称対象外）。
	const DESKTOP_ONLY = new Set([
		'vibrancy_apply',
		'autologin_enable',
		'autologin_disable',
		'server_apply',
		'settings_set',
		'auth_config_apply',
		'panel_open',
		'backups_open_folder',
		'attachments_open_folder',
		'items_export_csv_to_folder'
	]);

	// 読み取り系（list/get/status。§1 により両経路とも監査せず、対称強制の対象外）。
	const TAURI_READ = new Set([
		'attachments_list',
		'attachments_read_body',
		'attachments_read_thumbnail',
		'audit_config_get',
		'audit_log_list',
		'auth_check',
		'auth_config_get',
		'auth_identity',
		'auth_status',
		'backups_list',
		'backups_pending',
		'items_get',
		'items_list',
		'ping',
		'server_status',
		'settings_get',
		'ui_settings_get',
		'users_list',
		'vibrancy_status'
	]);

	// 読み取り系 REST ルート（GET と、body を使うため POST の *_list）。
	const REST_READ = new Set([
		'GET /api/auth/status',
		'GET /api/auth/check',
		'GET /api/auth/identity',
		'GET /api/events',
		'GET /api/items/{id}',
		'GET /api/users',
		'GET /api/ui-settings/{key}',
		'GET /api/audit-log/config',
		'GET /api/backups',
		'GET /api/backups/{fileName}',
		'GET /api/backups/pending-restore',
		'GET /api/attachments/{id}/download',
		'GET /api/attachments/{id}/thumbnail',
		'POST /api/items/list',
		'POST /api/audit-log/list',
		'POST /api/attachments/list'
	]);

	// --- 一次情報のパース ---
	// Tauri: トップレベルのコマンド。tests は #[tauri::command] を付けないので混入しない。
	const tauriLib = 'apps/admin-template/src-tauri/src/lib.rs';
	const tauriCmds = new Set();
	if (fs.existsSync(path.join(repoRoot, tauriLib))) {
		const src = read(tauriLib);
		for (const m of src.matchAll(
			/#\[tauri::command\][^\n]*\n\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g
		))
			tauriCmds.add(m[1]);
	}

	// REST: rest/mod.rs の Route table（doc）。METHOD + path（クエリ除去）。
	const restRoutes = new Set();
	for (const line of read('apps/admin-template/core/src/rest/mod.rs').split('\n')) {
		const m = line.match(/^\/\/!\s*\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/);
		if (m) restRoutes.add(`${m[1]} ${m[2].split('?')[0].trim()}`);
	}

	// 実ルート宣言（doc-sync 用）: app rest/ + banto-server の .route("path")。
	// 存在確認だけなので test 由来の重複は無害（1件あれば足りる）。
	const declaredPaths = new Set();
	for (const dir of ['apps/admin-template/core/src/rest', 'crates/banto-server/src']) {
		for (const file of walk(dir, ['.rs'])) {
			for (const m of read(file).matchAll(/\.route\(\s*"([^"]+)"/g)) declaredPaths.add(m[1]);
		}
	}

	// --- チェック ---
	// (a) マニフェストの両端が実在すること。
	for (const { tauri, rest } of DUAL_PATH) {
		if (!tauriCmds.has(tauri))
			fail(rule, tauriLib, `dual-path 操作の Tauri コマンド \`${tauri}\` が見つからない`);
		if (!restRoutes.has(rest))
			fail(
				rule,
				'rest/mod.rs',
				`dual-path 操作の REST ルート \`${rest}\` が Route table に無い（片側だけ変更した可能性）`
			);
	}
	// (b) Tauri 完全性: 全コマンドが dual-path / desktop-only / read のいずれか。
	const dualTauri = new Set(DUAL_PATH.map((d) => d.tauri));
	for (const cmd of tauriCmds) {
		if (dualTauri.has(cmd) || DESKTOP_ONLY.has(cmd) || TAURI_READ.has(cmd)) continue;
		fail(
			rule,
			tauriLib,
			`未分類の Tauri コマンド \`${cmd}\` — REST とペアにして DUAL_PATH に足すか、desktop-only / read に分類（§1 両経路対称）`
		);
	}
	// (c) REST 完全性: 全ルートが dual-path / read のいずれか。
	const dualRest = new Set(DUAL_PATH.map((d) => d.rest));
	for (const route of restRoutes) {
		if (dualRest.has(route) || REST_READ.has(route)) continue;
		fail(
			rule,
			'rest/mod.rs',
			`未分類の REST ルート \`${route}\` — Tauri コマンドとペアにして DUAL_PATH に足すか REST_READ に分類（§1 両経路対称）`
		);
	}
	// (d) doc-sync: Route table の各 path が実際の .route() 宣言に存在すること。
	for (const route of restRoutes) {
		const p = route.split(' ')[1];
		if (!declaredPaths.has(p))
			fail(
				rule,
				'rest/mod.rs',
				`Route table の \`${p}\` に対応する .route() 宣言が見当たらない（doc と実装のドリフト）`
			);
	}

	// (e) ロール床の対称（CR-6, 2026-07-22 / maintainability-review CR-6）。
	// rule 8 の (a)〜(d) は「両経路に在るか」までで、**同じロール床か**は見ない
	// （＝ `audit_config_get` の Tauri=Viewer / REST=Admin 非対称を素通しした）。
	// ここは DUAL_PATH / ROLE_READ に宣言した期待ロールに対し、Tauri 実装
	// （`require_role(&state, Role::X, …)`。thin wrapper は `<cmd>_body` に委譲する
	// ため _body フォールバックを持つ）と REST 実装（その route を束ねる
	// `RoleGuard { min: Role::X }`。無ければ `require_auth` のみ = Viewer 床）の
	// 双方が宣言と一致するか照合する。`src-tauri` はコンパイルできないため静的解析。
	if (fs.existsSync(path.join(repoRoot, tauriLib))) {
		const libSrc = read(tauriLib);
		// Tauri: 全 async fn → その本体で最初に現れる require_role の Role。
		const tauriRoles = {};
		for (const seg of libSrc.split(/\basync fn /).slice(1)) {
			const nm = seg.match(/^(\w+)/);
			if (!nm) continue;
			const rm = seg.match(/require_role\(\s*&?\s*state\s*,\s*Role::(\w+)\s*,/);
			tauriRoles[nm[1]] = rm ? rm[1] : null;
		}
		const tauriRoleOf = (cmd) => tauriRoles[cmd] ?? tauriRoles[`${cmd}_body`] ?? null;

		// REST: "METHOD /path" → ロール床。各 `fn *_router` 本体（rustfmt 済みなので
		// 関数の閉じ括弧は行頭 `}`）から RoleGuard の min（無ければ require_auth=Auth）を取り、
		// その本体内の `.route("path", <verbs>(...))` の各メソッドに割り当てる。
		const restRouteRole = {};
		for (const file of walk('apps/admin-template/core/src/rest', ['.rs'])) {
			for (const fnM of read(file).matchAll(/\bfn \w+_router\b[\s\S]*?\n\}/g)) {
				const body = fnM[0];
				const minM = body.match(/min:\s*Role::(\w+)/);
				const role = minM ? minM[1] : /require_auth\b/.test(body) ? 'Auth' : 'Public';
				for (const chunk of body.split('.route(').slice(1)) {
					const pathM = chunk.match(/^\s*"([^"]+)"/);
					if (!pathM) continue;
					const p = pathM[1].split('?')[0].trim();
					const methodsSeg = chunk.split(/\.with_state|\.layer|\.route\(/)[0];
					for (const vm of methodsSeg.matchAll(/\b(get|post|put|delete)\s*\(/g))
						restRouteRole[`${vm[1].toUpperCase()} ${p}`] = role;
				}
			}
		}

		// `require_auth` のみ（RoleGuard 無し）は最下位ロール = Viewer 床と同値。
		const normRole = (r) => (r === 'Auth' ? 'Viewer' : r);
		const roleChecks = [...DUAL_PATH.filter((d) => d.role), ...ROLE_READ];
		for (const { tauri, rest, role } of roleChecks) {
			const want = normRole(role);
			const tr = tauriRoleOf(tauri);
			const rr = restRouteRole[rest] ?? null;
			if (normRole(tr) !== want || normRole(rr) !== want)
				fail(
					rule,
					tauriLib,
					`ロール床の非対称/不一致 \`${tauri}\` ⇔ \`${rest}\`: 期待=${role} / Tauri=${tr ?? '不明'} / REST=${rr ?? '不明'}（§1 両経路で同一の認可、CR-6）`
				);
		}
	}

	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(
			rule,
			`両経路対称: dual-path ${DUAL_PATH.length} 対（ロール床照合 ${DUAL_PATH.filter((d) => d.role).length} + read ${ROLE_READ.length}）+ Tauri ${tauriCmds.size} コマンド / REST ${restRoutes.size} ルートを分類済み`
		);
}

// --- 9. §6 セキュリティ不変条件（grep 可能なもの、CR-2） ------------------
//
// §6 の不変条件のうち、静的テキストで確実に・低誤検知で検査できるものだけを
// 機械化する（順序依存やセマンティックなもの＝body limit の順序・監査 detail に
// 秘密を入れない等はレビュー/テスト担保のまま）。
{
	const rule = 'security-invariants';

	// A) `NewAttachment` は mime フィールドを持たない。MIME はクライアント申告を
	//    受け取らず、`detect_mime`（image::guess_format のマジックバイト）でのみ
	//    判定する（§6）。mime フィールドの再導入 = 申告 MIME を受け取る退行。
	const attFile = 'crates/banto-attachments/src/lib.rs';
	const attSrc = read(attFile);
	const structM = attSrc.match(/pub struct NewAttachment\s*\{([^}]*)\}/);
	if (!structM)
		fail(rule, attFile, 'struct NewAttachment が見つからない（検査の前提が変わった — 検査を更新）');
	else if (/(^|[\s,])mime\s*:/.test(structM[1]))
		fail(
			rule,
			attFile,
			'NewAttachment に mime フィールド — クライアント申告 MIME は受け取らない（§6、判定は detect_mime のマジックバイトのみ）'
		);

	// B) `settings_get` と `settings_set` は同一ロール（Admin）でゲートする。
	//    「同一ストアでも権限の非対称を作らない」（§6）。任意 key を読めるのは
	//    書けるのと同格の権限。ui_settings（viewer 可・自名前空間）は別コマンドで
	//    対象外。
	const libFile = 'apps/admin-template/src-tauri/src/lib.rs';
	const libSrc = read(libFile);
	const settingsRoleOf = (fnName) => {
		const m = libSrc.match(
			new RegExp(
				`async fn ${fnName}\\b[\\s\\S]{0,600}?require_role\\(\\s*&state\\s*,\\s*Role::(\\w+)\\s*,\\s*"settings"`
			)
		);
		return m ? m[1] : null;
	};
	const getRole = settingsRoleOf('settings_get');
	const setRole = settingsRoleOf('settings_set');
	if (getRole !== 'Admin' || setRole !== 'Admin' || getRole !== setRole)
		fail(
			rule,
			libFile,
			`settings_get(${getRole ?? '不明'}) と settings_set(${setRole ?? '不明'}) は同一 Admin ゲートであること（§6 権限の非対称を作らない）`
		);

	if (!results.some((r) => r.includes(`[${rule}]`)))
		pass(rule, 'NewAttachment に mime 無し / settings_get·set は Admin 対称');
}

// --- 結果 -------------------------------------------------------------------

console.log('verify:architecture — docs/conventions.md の機械検査\n');
for (const line of results) console.log(line);
if (failures > 0) {
	console.error(
		`\n${failures} 件の違反。意図的な例外なら、正当化コメントをコードに書いた上で本スクリプトの許可リストに理由付きで追加してください。`
	);
	process.exit(1);
}
console.log('\nすべて通過');
