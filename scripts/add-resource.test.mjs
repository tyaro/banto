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
import { MAX_IDENTIFIER_BYTES, normalizeSpec, singularOf } from './lib/add-resource-names.mjs';
import { restRs, serviceRs } from './lib/add-resource-rust.mjs';
import { resourceTs } from './lib/add-resource-frontend.mjs';

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
		{ name: 'customerName', type: 'text', required: true, max: 80, audit: true, title: true },
		{ name: 'quantity', type: 'number', required: true, min: 1, audit: true },
		{ name: 'weight', type: 'number' },
		{ name: 'shipped', type: 'checkbox' },
		{ name: 'dueDate', type: 'date' }
	]
};

const withField = (field) => () => normalizeSpec('orders', { fields: [field] });

// --- 名前とフィールド定義の検証 ---

test('リソース名は snake_case だけを受け付け、使えない名前は理由つきで断る', () => {
	for (const bad of ['Orders', 'purchase-orders', '1orders', 'orders_', '', 'a__b'])
		assert.throws(() => normalizeSpec(bad), AddResourceError, `"${bad}" が通った`);
	// テンプレートが使っている名前・予約語・生成するコードの変数名。
	assert.throws(() => normalizeSpec('items'), /既に使っています/);
	assert.throws(() => normalizeSpec('users'), /既に使っています/);
	assert.throws(() => normalizeSpec('type'), /予約語/);
	assert.throws(() => normalizeSpec('values'), /予約語|変数名/);
	assert.throws(() => normalizeSpec('between'), /予約語/);
	assert.throws(() => normalizeSpec('verbose'), /予約語/);
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
	assert.equal(spec.editField.name, 'customerName');
	// ラベルを書かなかった欄は列名から作る。
	assert.deepEqual(spec.fields[0].label, { ja: 'Customer Name', en: 'Customer Name' });
	assert.equal(singularOf('categories'), 'category');
	assert.equal(singularOf('boxes'), 'box');
	assert.equal(singularOf('stock'), 'stock');
});

test('フィールド定義の誤りは、欄の位置つきで断る', () => {
	assert.throws(withField({ name: 'customer_name', type: 'text' }), /fields\[0\]\.name/);
	assert.throws(withField({ name: 'id', type: 'number' }), /必ず付ける欄/);
	assert.throws(withField({ name: 'version', type: 'number' }), /必ず付ける欄/);
	assert.throws(withField({ name: 'order', type: 'text' }), /予約語/);
	// SQLite・PostgreSQL の予約語は、引用符なしで書く生成物が構文エラーになるので断る。
	for (const word of ['between', 'escape', 'autoincrement', 'analyse', 'verbose'])
		assert.throws(withField({ name: word, type: 'text' }), /予約語/, `"${word}" が通った`);
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

// --- 監査に残す欄（conventions §6: 既定で値を記録しない） ---

test('監査の detail に出るのは audit: true の欄だけで、name は title: true の欄だけ', () => {
	const fields = [
		{ name: 'customerName', type: 'text', audit: true, title: true },
		{ name: 'apiToken', type: 'text' },
		{ name: 'memo', type: 'textarea' },
		{ name: 'pinCode', type: 'number' },
		{ name: 'quantity', type: 'number', audit: true },
		{ name: 'flagged', type: 'checkbox' },
		{ name: 'birthDate', type: 'date' }
	];
	const spec = normalizeSpec('orders', { fields });
	assert.deepEqual(
		spec.fields.filter((field) => field.audit).map((field) => field.name),
		['customerName', 'quantity']
	);
	assert.equal(spec.titleField.name, 'customerName');

	const service = serviceRs(spec);
	// 許可リストは 1 か所（`order_audit_fields`）で、書いてあるのは audit: true の欄だけ。
	const allowList = service.match(
		/fn order_audit_fields\(order: &Order\)[^{]*\{([\s\S]*?)\n\}\n/
	)[1];
	assert.deepEqual(
		[...allowList.matchAll(/"(\w+)": order\.(\w+),/g)].map((m) => [m[1], m[2]]),
		[
			['customerName', 'customer_name'],
			['quantity', 'quantity']
		]
	);
	// 作成・更新・削除の 3 つとも、その許可リストだけから作る（行の全体を diff に渡さない）。
	assert.equal(service.match(/order_audit_fields\(/g).length, 1 + 4);
	assert.doesNotMatch(service, /serde_json::to_value\((before|after)\)/);
	for (const detail of ['create', 'update', 'delete'])
		assert.match(
			service,
			new RegExp(
				`pub fn order_${detail}_detail\\([^{]*\\{[\\s\\S]*?order_audit_fields[\\s\\S]*?"name": (order|after)\\.customer_name, "changes": changes`
			)
		);
	// 生成した Rust のテストが、監査対象外の値が 3 つの detail に出ないことを確かめる。
	assert.match(service, /fn audit_details_hold_only_the_fields_marked_for_audit\(\)/);
	assert.match(service, /let audited: \[&str; 2\] = \["customerName", "quantity"\];/);
	for (const hidden of ['api_token', 'memo'])
		for (const side of ['before', 'after'])
			assert.ok(service.includes(`"\\"audit-${side}-${hidden}\\"",`), `${side} ${hidden}`);
	assert.ok(!service.includes('"\\"audit-before-customer_name\\"",'), 'title の値は name に出る');

	// 何も付けなければ、値は 1 つも残らない（name も入れない）。
	const bare = normalizeSpec('orders', {
		fields: fields.map(({ name, type }) => ({ name, type }))
	});
	assert.equal(bare.titleField, null);
	const bareService = serviceRs(bare);
	assert.match(bareService, /let _ = order;\n {4}serde_json::json!\(\{\}\)/);
	assert.doesNotMatch(bareService, /"name": /);
	assert.match(bareService, /let audited: \[&str; 0\] = \[\];/);
	assert.match(bareService, /order_create_detail\(&before\), None::<&str>\)/);

	// title は text の欄に 1 つだけ。audit・title は真偽値。
	assert.throws(withField({ name: 'memo', type: 'textarea', title: true }), /title は text/);
	assert.throws(withField({ name: 'count', type: 'number', title: true }), /title は text/);
	assert.throws(withField({ name: 'note', type: 'text', audit: 'yes' }), /audit は true か false/);
	assert.throws(
		() =>
			normalizeSpec('orders', {
				fields: [
					{ name: 'code', type: 'text', title: true },
					{ name: 'label', type: 'text', title: true }
				]
			}),
		/"title" を付けられる欄は 1 つだけ/
	);
	// フィールド定義を渡さないときの既定（name だけ）は、生成器が決めた表示名なので残す。
	const fallback = normalizeSpec('orders');
	assert.equal(fallback.titleField.name, 'name');
	assert.equal(fallback.fields[0].audit, true);
});

// --- PostgreSQL の識別子の長さ ---

test('変換後のテーブル名・列名が 63 バイトを超えたら断る（PostgreSQL は黙って切り詰める）', () => {
	const fields = [{ name: 'note', type: 'text' }];
	assert.equal(MAX_IDENTIFIER_BYTES, 63);
	assert.equal(normalizeSpec('a'.repeat(63), { fields }).name.length, 63);
	assert.throws(() => normalizeSpec('a'.repeat(64), { fields }), /64 バイト.*上限（63 バイト）/);
	// 列名は snake_case にした後の長さで見る（camelCase の 62 文字が 64 バイトになる）。
	const camel = `${'a'.repeat(20)}B${'c'.repeat(20)}D${'e'.repeat(20)}`;
	assert.equal(camel.length, 62);
	assert.throws(withField({ name: camel, type: 'text' }), /64 バイト.*上限（63 バイト）/);
	const fits = normalizeSpec('orders', { fields: [{ name: camel.slice(0, 61), type: 'text' }] });
	assert.equal(fits.fields[0].column.length, 63);
	// 先頭 63 バイトが同じ 2 つの列（再レビューで通っていた定義）。
	assert.throws(
		() =>
			normalizeSpec('orders', {
				fields: [
					{ name: `${'a'.repeat(69)}x`, type: 'text' },
					{ name: `${'a'.repeat(69)}y`, type: 'text' }
				]
			}),
		/fields\[0\]\.name.*70 バイト/
	);
});

// --- 生成する名前どうしの衝突 ---

test('コンパイルできない Rust・TypeScript になる名前の重なりは、生成前に断る', () => {
	const fields = [{ name: 'note', type: 'text' }];
	// 行の型とサービスの型がどちらも ProductsService。
	assert.throws(
		() => normalizeSpec('products', { singular: 'products_service', fields }),
		/"ProductsService" が重なります（行の型 と サービスの型）/
	);
	assert.equal(normalizeSpec('products', { singular: 'product', fields }).rowType, 'Product');
	// 生成したコードが import・定義する型、prelude のトレイト（隠すと `.clone()` が解決できない）。
	for (const singular of ['write_state', 'delete_query', 'api_error', 'clone', 'serialize'])
		assert.throws(
			() => normalizeSpec('orders', { singular, fields }),
			/生成したコードが使う型と重なります/,
			`singular: ${singular}`
		);
	// リソース名・単数形が、生成した関数の呼ぶ関数やクレートを隠す。
	for (const name of ['get', 'post', 'middleware', 'record_write'])
		assert.throws(() => normalizeSpec(name, { fields }), /変数名と重なります/, name);
	assert.throws(() => normalizeSpec('logs', { singular: 'record_ok', fields }), /変数名と重なり/);
	for (const name of ['sqlx', 'serde_json', 'chrono'])
		assert.throws(() => normalizeSpec(name, { fields }), /クレートの名前と重なります/, name);
	// 検証の定数: text の code（max つき）と number の codeLen（max つき）は、どちらも MAX_CODE_LEN。
	assert.throws(
		() =>
			normalizeSpec('orders', {
				fields: [
					{ name: 'code', type: 'text', max: 8 },
					{ name: 'codeLen', type: 'number', max: 8 }
				]
			}),
		/"MAX_CODE_LEN" が重なります（欄 "code" と 欄 "codeLen"）/
	);
	assert.throws(
		withField({ name: 'safeInteger', type: 'number', max: 8 }),
		/"MAX_SAFE_INTEGER" が重なります/
	);
	// TypeScript: `define` だと定義の名前が import の defineResource と重なる。
	assert.throws(() => normalizeSpec('define', { fields }), /"defineResource" が重なります/);
});

test('Object.prototype の名前の欄（constructor など）でも、テストの値は自前のものを使う', () => {
	const spec = normalizeSpec('orders', {
		fields: [
			{ name: 'constructor', type: 'number', required: true },
			{ name: 'toString', type: 'text' },
			{ name: 'valueOf', type: 'checkbox' },
			{ name: 'hasOwnProperty', type: 'date' }
		]
	});
	const rest = restRs(spec);
	// 作成の本文と、更新の本文（最初の text の欄 toString だけを書き換える）。
	assert.ok(
		rest.includes(
			'json!({ "constructor": 1, "toString": "Sample", "valueOf": false, "hasOwnProperty": "2031-02-03" })'
		)
	);
	assert.ok(
		rest.includes(
			'json!({ "constructor": 1, "toString": "Changed", "valueOf": false, "hasOwnProperty": "2031-02-03" })'
		)
	);
	assert.doesNotMatch(rest, /function |\[native code\]/);
	assert.doesNotMatch(serviceRs(spec), /function |\[native code\]/);
});

// --- フォームとサービスの検証をそろえる ---

test('文字数・日付・整数の範囲は、フォーム（@banto/forms）と同じ意味で Rust 側も見る', () => {
	const spec = normalizeSpec('orders', {
		fields: [
			{ name: 'code', type: 'text', max: 1 },
			{ name: 'quantity', type: 'number', required: true },
			{ name: 'weight', type: 'number', min: 0 },
			{ name: 'dueDate', type: 'date' }
		]
	});
	const service = serviceRs(spec);
	const schema = resourceTs(spec);

	// 文字数: フォームは `str.trim().length`（UTF-16 の単位）。「𠮷」は 2。
	assert.match(service, /trimmed\.encode_utf16\(\)\.count\(\) > MAX_CODE_LEN/);
	assert.doesNotMatch(service, /chars\(\)\.count\(\)/);
	assert.equal('𠮷'.trim().length, 2);

	// 日付: 形だけでなく実在日（フォームの isIsoDate と同じ判定の banto_core::datetime）。
	assert.match(service, /if !banto_core::datetime::is_iso_date\(value\)/);
	assert.doesNotMatch(service, /\nfn is_iso_date/);
	// 生成したテストの「検証で落ちる入力」も、形は合っているが実在しない日。
	assert.match(
		serviceRs(normalizeSpec('orders', { fields: [{ name: 'dueDate', type: 'date' }] })),
		/input\.due_date = Some\("2031-02-30"\.to_string\(\)\);/
	);

	// 整数: 書かなかった側も ±(2^53−1)。Rust の定数とフォームの min/max が同じ値。
	assert.equal(spec.fields[1].min, Number.MIN_SAFE_INTEGER);
	assert.equal(spec.fields[1].max, Number.MAX_SAFE_INTEGER);
	assert.match(service, /const MIN_SAFE_INTEGER: i64 = -9_007_199_254_740_991;/);
	assert.match(service, /const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;/);
	assert.equal(-9_007_199_254_740_991, Number.MIN_SAFE_INTEGER);
	assert.equal(9_007_199_254_740_991, Number.MAX_SAFE_INTEGER);
	assert.match(service, /let value = input\.quantity;\s+if value < MIN_SAFE_INTEGER \{/);
	assert.match(service, /else if value > MAX_SAFE_INTEGER \{/);
	// 生成したテストは、上限の 1 つ上（2^53）が検証で落ちることを確かめる。
	assert.match(service, /input\.quantity = 9007199254740992;/);
	assert.match(service, /const MIN_WEIGHT: i64 = 0;/);
	assert.match(service, /if value < MIN_WEIGHT \{[\s\S]*?else if value > MAX_SAFE_INTEGER \{/);
	assert.match(
		schema,
		/name: 'quantity',[\s\S]*?min: Number\.MIN_SAFE_INTEGER,\n\t\t\tmax: Number\.MAX_SAFE_INTEGER,/
	);
	assert.match(schema, /name: 'weight',[\s\S]*?min: 0,\n\t\t\tmax: Number\.MAX_SAFE_INTEGER,/);
	// 範囲の外の min・max は断る（丸められた値が定数になるのを防ぐ）。
	assert.throws(
		withField({ name: 'count', type: 'number', max: 2 ** 53 }),
		/9007199254740991 の整数/
	);
	assert.throws(withField({ name: 'count', type: 'number', min: -(2 ** 53) }), /の整数で書いて/);
	assert.throws(withField({ name: 'count', type: 'number', max: 1.5 }), /の整数で書いて/);
	assert.equal(
		normalizeSpec('orders', { fields: [{ name: 'count', type: 'number', max: 2 ** 53 - 1 }] })
			.fields[0].max,
		Number.MAX_SAFE_INTEGER
	);
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
		// テンプレートに既にある名前（Tauri 側の関数・モジュール・AppResources の欄・定義）と
		// 重なるときも、理由を並べて止まる。
		assert.throws(
			() => planAddResource(dir, 'orders', ORDERS),
			(err) =>
				/生成する関数と同じ名前が既にあります（[^）]*orders_create_body/.test(err.message) &&
				/core\/src\/lib\.rs: モジュールか import の名前 `orders`/.test(err.message) &&
				/`AppResources` に `orders` の欄が既にあります/.test(err.message) &&
				/`ordersResource` が既にあります/.test(err.message)
		);

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
