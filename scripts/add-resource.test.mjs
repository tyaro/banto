/**
 * `pnpm banto add resource`（scripts/banto.mjs・scripts/lib/add-resource*.mjs）のテスト。
 * 依存を足さない（Node 標準の `node:test` のみ、conventions §3）。
 *
 * 実リポジトリは書き換えない。適用するテストは一時ディレクトリへのコピーで走らせる
 * （scaffold.test.mjs と同じ方式）。生成した Rust・フロントが実際にビルドできることは
 * ここでは見ない（`cargo test`・`pnpm check` の役目。docs/recipes/add-resource.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
	AddResourceError,
	applyPlan,
	insertAtAnchor,
	planAddResource
} from './lib/add-resource.mjs';
import { normalizeSpec, singularOf } from './lib/add-resource-names.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'apps/admin-template';

const SKIP = ['node_modules', '.git', 'target', '.svelte-kit', 'build', 'dist'];
const skip = (src) =>
	SKIP.some((s) => src === path.join(repoRoot, s) || src.includes(`${path.sep}${s}${path.sep}`)) ||
	src.includes('-snapshots');

function copyRepo() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'banto-add-resource-'));
	fs.cpSync(repoRoot, tmp, { recursive: true, filter: (src) => !skip(src) });
	return tmp;
}

function withCopy(run) {
	const dir = copyRepo();
	try {
		return run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

/** 生成器が触りうる場所の全ファイルの内容（「何も書いていない」の比較用）。 */
function snapshot(dir) {
	const files = new Map();
	const walk = (rel) => {
		for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
			const child = `${rel}/${entry.name}`;
			if (entry.isDirectory()) walk(child);
			else files.set(child, read(dir, child));
		}
	};
	walk(APP);
	walk('scripts');
	return files;
}

/** 今の migration の最大の番号に `offset` を足した 4 桁（テンプレートが migration を足しても崩れないように）。 */
function migrationNumber(dir, offset) {
	const numbers = fs
		.readdirSync(path.join(dir, `${APP}/core/migrations-sqlite`))
		.map((file) => Number(file.match(/^(\d+)_/)?.[1] ?? 0));
	return String(Math.max(...numbers) + offset).padStart(4, '0');
}

const ORDERS = {
	label: { ja: '注文', en: 'Orders' },
	fields: [
		{ name: 'customerName', type: 'text', required: true, max: 80 },
		{ name: 'quantity', type: 'number', required: true, min: 1 },
		{ name: 'weight', type: 'number' },
		{ name: 'shipped', type: 'checkbox' },
		{ name: 'dueDate', type: 'date' }
	]
};

// --- 名前とフィールド定義の検証 ---

test('リソース名は snake_case だけを受け付け、使えない名前は理由つきで断る', () => {
	for (const bad of ['Orders', 'purchase-orders', '1orders', 'orders_', '', 'a__b'])
		assert.throws(() => normalizeSpec(bad), AddResourceError, `"${bad}" が通った`);
	// テンプレートが使っている名前・予約語・生成するコードの変数名。
	assert.throws(() => normalizeSpec('items'), /既に使っています/);
	assert.throws(() => normalizeSpec('users'), /既に使っています/);
	assert.throws(() => normalizeSpec('type'), /予約語/);
	assert.throws(() => normalizeSpec('values'), /予約語|変数名/);
	// 単数形が予約語・既存の型と重なるときは "singular" を促す。
	assert.throws(() => normalizeSpec('types'), /"singular"/);
	assert.throws(() => normalizeSpec('roles'), /"singular"/);
	assert.equal(
		normalizeSpec('roles', { singular: 'job_role', fields: ORDERS.fields }).rowType,
		'JobRole'
	);
});

test('名前から型・パス・キーの名前を導く', () => {
	const spec = normalizeSpec('purchase_orders', ORDERS);
	assert.equal(spec.kebab, 'purchase-orders');
	assert.equal(spec.camel, 'purchaseOrders');
	assert.equal(spec.singular, 'purchase_order');
	assert.equal(spec.rowType, 'PurchaseOrder');
	assert.equal(spec.inputType, 'PurchaseOrderInput');
	assert.equal(spec.serviceType, 'PurchaseOrdersService');
	assert.deepEqual(
		spec.fields.map((field) => field.column),
		['customer_name', 'quantity', 'weight', 'shipped', 'due_date']
	);
	assert.equal(spec.titleField.name, 'customerName');
	// ラベルを書かなかった欄は列名から作る。
	assert.deepEqual(spec.fields[0].label, { ja: 'Customer Name', en: 'Customer Name' });
	assert.equal(singularOf('categories'), 'category');
	assert.equal(singularOf('boxes'), 'box');
	assert.equal(singularOf('stock'), 'stock');
});

test('フィールド定義の誤りは、欄の位置つきで断る', () => {
	const withField = (field) => () => normalizeSpec('orders', { fields: [field] });
	assert.throws(withField({ name: 'customer_name', type: 'text' }), /fields\[0\]\.name/);
	assert.throws(withField({ name: 'id', type: 'number' }), /必ず付ける欄/);
	assert.throws(withField({ name: 'version', type: 'number' }), /必ず付ける欄/);
	assert.throws(withField({ name: 'order', type: 'text' }), /予約語/);
	assert.throws(withField({ name: 'status', type: 'select' }), /生成できません/);
	assert.throws(withField({ name: 'note', type: 'text', min: 1 }), /min は number/);
	assert.throws(withField({ name: 'done', type: 'checkbox', required: true }), /checkbox/);
	assert.throws(withField({ name: 'count', type: 'number', min: 5, max: 1 }), /min が max/);
	assert.throws(
		withField({ name: 'count', type: 'number', options: [] }),
		/"options" は使えません/
	);
	assert.throws(() => normalizeSpec('orders', { fields: [] }), /1 つ以上/);
	assert.throws(
		() =>
			normalizeSpec('orders', {
				fields: [
					{ name: 'note', type: 'text' },
					{ name: 'note', type: 'textarea' }
				]
			}),
		/重なっています/
	);
	assert.throws(() => normalizeSpec('orders', { fields: ORDERS.fields, extra: 1 }), /"extra"/);
});

// --- アンカーへの差し込み ---

test('insertAtAnchor: before はアンカーの直前に、字下げごと差し込む', () => {
	const problems = [];
	const out = insertAtAnchor(
		'a\n    // [banto:add-resource:x]\nb\n',
		{ file: 'f', slot: 'x', text: '    one\n    two' },
		problems
	);
	assert.equal(out, 'a\n    one\n    two\n    // [banto:add-resource:x]\nb\n');
	assert.deepEqual(problems, []);
});

test('insertAtAnchor: listAfter は後ろに要素が続くときだけ末尾にカンマを足す', () => {
	const problems = [];
	const empty = insertAtAnchor(
		'[\n\t// [banto:add-resource:x]\n]);\n',
		{ file: 'f', slot: 'x', mode: 'listAfter', text: "\t'a',\n\t'b'" },
		problems
	);
	assert.equal(empty, "[\n\t// [banto:add-resource:x]\n\t'a',\n\t'b'\n]);\n");
	const followed = insertAtAnchor(
		"[\n\t// [banto:add-resource:x]\n\t'z'\n]\n",
		{ file: 'f', slot: 'x', mode: 'listAfter', text: "\t'a'" },
		problems
	);
	assert.equal(followed, "[\n\t// [banto:add-resource:x]\n\t'a',\n\t'z'\n]\n");
	assert.deepEqual(problems, []);
});

test('insertAtAnchor: アンカーが無い・2 つあるときは内容を変えず、理由を残す', () => {
	const problems = [];
	const none = 'a\nb\n';
	assert.equal(insertAtAnchor(none, { file: 'f.rs', slot: 'x', text: 't' }, problems), none);
	const twice = '// [banto:add-resource:x]\n// [banto:add-resource:x]\n';
	assert.equal(insertAtAnchor(twice, { file: 'g.rs', slot: 'x', text: 't' }, problems), twice);
	assert.equal(problems.length, 2);
	assert.match(problems[0], /f\.rs: アンカー .* が見つかりません/);
	assert.match(problems[1], /g\.rs: アンカー .* が 2 か所/);
});

test('insertAtAnchor: CRLF のファイルは CRLF のまま返す', () => {
	const out = insertAtAnchor(
		'a\r\n// [banto:add-resource:x]\r\n',
		{ file: 'f', slot: 'x', text: 'one\ntwo' },
		[]
	);
	assert.equal(out, 'a\r\none\r\ntwo\r\n// [banto:add-resource:x]\r\n');
});

// --- テンプレートのコピーへの生成 ---

test('テンプレートのコピーに生成し、2 つ目のリソースも続けて足せる', () => {
	withCopy((dir) => {
		const number = migrationNumber(dir, 1);
		const plan = planAddResource(dir, 'orders', ORDERS);
		assert.deepEqual(
			plan.created.map(({ file }) => file),
			[
				`${APP}/core/migrations-sqlite/${number}_orders.sql`,
				`${APP}/core/migrations-postgres/${number}_orders.sql`,
				`${APP}/core/src/orders.rs`,
				`${APP}/core/src/rest/orders.rs`,
				`${APP}/src/lib/banto/resources/orders.ts`,
				`${APP}/src/routes/(app)/orders/+page.svelte`,
				`${APP}/src/routes/(app)/orders/[id]/+page.svelte`,
				`${APP}/src/routes/(app)/orders/new/+page.svelte`
			]
		);
		assert.deepEqual(
			plan.edited.map(({ file }) => file).sort(),
			[
				`${APP}/core/src/lib.rs`,
				`${APP}/core/src/resources.rs`,
				`${APP}/core/src/rest/mod.rs`,
				`${APP}/messages/en.json`,
				`${APP}/messages/ja.json`,
				`${APP}/src-tauri/src/lib.rs`,
				`${APP}/src/lib/banto/resources/index.ts`,
				'scripts/verify-architecture.mjs'
			].sort()
		);
		// 計画しただけでは何も書かない。
		assert.equal(fs.existsSync(path.join(dir, `${APP}/core/src/orders.rs`)), false);

		applyPlan(dir, plan);

		// 両方言の migration は同じ名前で、型だけが違う（conventions §11）。
		const sqlite = read(dir, `${APP}/core/migrations-sqlite/${number}_orders.sql`);
		const postgres = read(dir, `${APP}/core/migrations-postgres/${number}_orders.sql`);
		assert.match(sqlite, /id INTEGER PRIMARY KEY AUTOINCREMENT/);
		assert.match(sqlite, /shipped INTEGER NOT NULL DEFAULT 0/);
		assert.match(sqlite, /weight INTEGER,/);
		assert.match(sqlite, /version INTEGER NOT NULL DEFAULT 1/);
		assert.match(postgres, /id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY/);
		assert.match(postgres, /shipped BOOLEAN NOT NULL DEFAULT FALSE/);
		assert.match(postgres, /quantity BIGINT NOT NULL/);
		assert.match(postgres, /version BIGINT NOT NULL DEFAULT 1/);

		// 両経路: REST は RoleGuard、Tauri は require_role で同じ床（editor）。denied のテストも両方に。
		const rest = read(dir, `${APP}/core/src/rest/orders.rs`);
		assert.match(rest, /min: Role::Editor/);
		assert.match(rest, /recorded_as_denied/);
		const tauri = read(dir, `${APP}/src-tauri/src/lib.rs`);
		for (const verb of ['list', 'get', 'create', 'update', 'delete'])
			assert.match(tauri, new RegExp(`#\\[tauri::command\\]\\nasync fn orders_${verb}\\(`));
		assert.match(tauri, /require_role\(state, Role::Editor, "orders"\)/);
		assert.match(tauri, /async fn orders_viewer_writes_are_forbidden_and_recorded_as_denied/);
		assert.match(tauri, /\n {12}orders_delete,\n {12}\/\/ \[banto:add-resource:tauri-handlers\]/);

		const restMod = read(dir, `${APP}/core/src/rest/mod.rs`);
		assert.match(restMod, /\/\/! \| DELETE \| `\/api\/orders\/\{id\}` \| - \| 204 \(editor\+\) \|/);
		assert.match(restMod, /\nmod orders;\n\/\/ \[banto:add-resource:rest-mod\]/);
		assert.match(restMod, /\.merge\(orders::orders_router\(/);
		assert.match(read(dir, `${APP}/core/src/lib.rs`), /\npub mod orders;\n/);
		assert.match(
			read(dir, `${APP}/core/src/resources.rs`),
			/pub orders: crate::orders::OrdersService,/
		);

		// verify-architecture の分類（片方の経路だけに足すと CI が落ちる仕組み）にも足す。
		const verify = read(dir, 'scripts/verify-architecture.mjs');
		assert.match(
			verify,
			/\{ tauri: 'orders_delete', rest: 'DELETE \/api\/orders\/\{id\}', role: 'Editor' \},\n/
		);
		assert.match(verify, /'orders_get',\n\t\t'orders_list',\n/);
		assert.match(verify, /'GET \/api\/orders\/\{id\}',\n\t\t'POST \/api\/orders\/list',\n/);

		// フロント: 定義・登録・メッセージ（ja・en）。ナビは定義の nav から導かれる。
		const index = read(dir, `${APP}/src/lib/banto/resources/index.ts`);
		assert.match(index, /import \{ ordersResource \} from '\.\/orders';/);
		assert.match(index, /resources\.push\(ordersResource\);/);
		const definition = read(dir, `${APP}/src/lib/banto/resources/orders.ts`);
		assert.match(definition, /name: 'orders',\n\tpath: '\/orders',/);
		assert.match(definition, /label: \(\) => m\['nav\.orders'\]\(\)/);
		for (const locale of ['ja', 'en']) {
			const messages = JSON.parse(read(dir, `${APP}/messages/${locale}.json`));
			assert.equal(messages['nav.orders'], locale === 'ja' ? '注文' : 'Orders');
			assert.equal(messages['orders.resourceLabel'], locale === 'ja' ? '注文' : 'Orders');
			assert.equal(messages['orders.fieldCustomerName'], 'Customer Name');
			assert.ok(messages['orders.fieldUpdatedAt']);
		}

		// 同じ名前でもう一度は、既にあるファイルを見つけて止まる。
		assert.throws(() => planAddResource(dir, 'orders', ORDERS), /既にあります/);

		// アンカーは残っているので、次のリソースを続けて足せる（番号は次へ）。
		const second = planAddResource(dir, 'invoices');
		assert.equal(
			second.created[0].file,
			`${APP}/core/migrations-sqlite/${migrationNumber(dir, 1)}_invoices.sql`
		);
		applyPlan(dir, second);
		const verifyAfter = read(dir, 'scripts/verify-architecture.mjs');
		assert.match(verifyAfter, /'invoices_get',\n\t\t'invoices_list',\n\t\t'orders_get',/);
		assert.match(
			read(dir, `${APP}/core/src/resources.rs`),
			/pub orders: [^\n]+\n {4}pub invoices: [^\n]+\n {4}\/\/ \[banto:add-resource:resource-fields\]/
		);
	});
});

test('アンカーが 1 つでも欠けていれば、全部の理由を出して何も書かない', () => {
	withCopy((dir) => {
		// 2 つのファイルからアンカーを消す（1 つ目で止まらず、両方を報告すること）。
		for (const [file, slot] of [
			[`${APP}/core/src/rest/mod.rs`, 'rest-routers'],
			[`${APP}/src-tauri/src/lib.rs`, 'tauri-handlers']
		]) {
			const full = path.join(dir, file);
			const before = fs.readFileSync(full, 'utf8');
			const after = before.replace(`[banto:add-resource:${slot}]`, '[removed]');
			assert.notEqual(after, before, `${file} に ${slot} のアンカーが無い`);
			fs.writeFileSync(full, after);
		}
		const before = snapshot(dir);

		assert.throws(
			() => planAddResource(dir, 'orders', ORDERS),
			(err) => {
				assert.ok(err instanceof AddResourceError);
				assert.match(err.message, /何も書いていません/);
				assert.match(err.message, /rest\/mod\.rs: アンカー .*rest-routers.* が見つかりません/);
				assert.match(err.message, /src-tauri\/src\/lib\.rs: アンカー .*tauri-handlers/);
				return true;
			}
		);
		assert.deepEqual(snapshot(dir), before, '止まったのにファイルが変わっている');

		// CLI も同じ理由を出して 1 で終わり、何も書かない。
		const res = spawnSync(
			process.execPath,
			[path.join(dir, 'scripts/banto.mjs'), 'add', 'resource', 'orders', '--no-format'],
			{ cwd: dir, encoding: 'utf8' }
		);
		assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
		assert.match(res.stderr, /何も書いていません/);
		assert.deepEqual(snapshot(dir), before, 'CLI が止まったのにファイルが変わっている');
	});
});

test('CLI: --dry-run は計画だけを出し、何も書かない。既定は name だけのリソース', () => {
	withCopy((dir) => {
		const before = snapshot(dir);
		const banto = path.join(dir, 'scripts/banto.mjs');
		const dry = spawnSync(process.execPath, [banto, 'add', 'resource', 'orders', '--dry-run'], {
			cwd: dir,
			encoding: 'utf8'
		});
		assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
		assert.match(dry.stdout, /作る予定: .*core\/src\/orders\.rs/);
		assert.match(dry.stdout, /何も書いていません/);
		assert.deepEqual(snapshot(dir), before);

		const bad = spawnSync(process.execPath, [banto, 'add', 'resource', 'Orders'], {
			cwd: dir,
			encoding: 'utf8'
		});
		assert.equal(bad.status, 1);
		assert.match(bad.stderr, /snake_case/);
		assert.deepEqual(snapshot(dir), before);

		const res = spawnSync(process.execPath, [banto, 'add', 'resource', 'orders', '--no-format'], {
			cwd: dir,
			encoding: 'utf8'
		});
		assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
		const service = read(dir, `${APP}/core/src/orders.rs`);
		assert.match(
			service,
			/pub struct OrderInput \{\n {4}#\[serde\(default\)\]\n {4}pub name: String,/
		);
		assert.match(service, /const MAX_NAME_LEN: usize = 80;/);
	});
});

test('scaffold のどのプリセットの後でも、全部のアンカーが残っていて生成できる', () => {
	for (const preset of ['minimal', 'standard', 'full', 'display']) {
		withCopy((dir) => {
			const res = spawnSync(
				process.execPath,
				[path.join(dir, 'scripts/scaffold.mjs'), '--preset', preset],
				{ cwd: dir, encoding: 'utf8' }
			);
			assert.equal(res.status, 0, `scaffold ${preset} が失敗:\n${res.stdout}\n${res.stderr}`);
			// display は items の migration（0001・0009・0011）を消すが、番号は最大の次のまま。
			const number = migrationNumber(dir, 1);
			const plan = planAddResource(dir, 'orders', ORDERS);
			assert.equal(
				plan.created[0].file,
				`${APP}/core/migrations-sqlite/${number}_orders.sql`,
				`${preset}: migration の番号`
			);
			applyPlan(dir, plan);
			if (preset === 'display')
				assert.equal(fs.existsSync(path.join(dir, `${APP}/core/src/items.rs`)), false);
			assert.match(
				read(dir, `${APP}/src/lib/banto/resources/index.ts`),
				/resources\.push\(ordersResource\);/
			);
		});
	}
});
