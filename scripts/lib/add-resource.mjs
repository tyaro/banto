/**
 * `pnpm banto add resource <name>` の本体（Issue #715）: CRUD リソース 1 つ分の定型コードを
 * Rust 側まで生成する。手順は docs/recipes/add-resource.md、入口は scripts/banto.mjs。
 *
 * - 生成物は普通のコードとして残す。再生成・差分適用はしない（同じ名前でもう一度呼ぶと、
 *   既にあるファイルを見つけて止まる）。
 * - 既存のファイルへの差し込みは `[banto:add-resource:<slot>]` のコメント（アンカー）の位置に
 *   行う。**先に全部の差し込み先と新しいファイルを検査し、1 つでも問題があれば何も書かずに
 *   止める**（途中まで書いた状態を作らない）。
 * - 依存は足さない（conventions §3）。Node の標準モジュールだけで動く。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AddResourceError, DEFAULT_SPEC, normalizeSpec } from './add-resource-names.mjs';
import {
	migrationSql,
	restRs,
	routeTableRows,
	serviceRs,
	tauriCommands,
	tauriHandlers,
	tauriTests
} from './add-resource-rust.mjs';
import {
	detailPageSvelte,
	listPageSvelte,
	messageEntries,
	newPageSvelte,
	resourceTs
} from './add-resource-frontend.mjs';

export { AddResourceError, DEFAULT_SPEC };

const APP = 'apps/admin-template';
const CORE = `${APP}/core`;
const MIGRATION_DIRS = [`${CORE}/migrations-sqlite`, `${CORE}/migrations-postgres`];

const anchorText = (slot) => `[banto:add-resource:${slot}]`;

/**
 * アンカーの行の直前（`before`）か直後（`listAfter`）に `text` を差し込む。
 * `listAfter` は末尾カンマを付けない JS の配列用で、後ろに要素が続くときだけ最後の行に
 * カンマを足す（prettier の trailingComma: none に合わせる）。
 * アンカーが無い・2 つ以上あるときは problems に理由を足して元の内容を返す。
 */
export function insertAtAnchor(content, { file, slot, text, mode = 'before' }, problems) {
	const anchor = anchorText(slot);
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.split(eol);
	const hits = lines.flatMap((line, index) => (line.includes(anchor) ? [index] : []));
	if (hits.length !== 1) {
		problems.push(
			hits.length === 0
				? `${file}: アンカー \`// ${anchor}\` が見つかりません。`
				: `${file}: アンカー \`// ${anchor}\` が ${hits.length} か所にあります（1 か所だけにしてください）。`
		);
		return content;
	}
	const at = hits[0];
	const inserted = text.replace(/\n$/, '').split('\n');
	if (mode === 'listAfter') {
		const next = lines.slice(at + 1).find((line) => line.trim() !== '') ?? '';
		if (!/^\s*[\])]/.test(next)) inserted[inserted.length - 1] += ',';
		lines.splice(at + 1, 0, ...inserted);
	} else {
		lines.splice(at, 0, ...inserted);
	}
	return lines.join(eol);
}

/** JSON のメッセージ（1 階層のオブジェクト）の末尾にキーを足す。書式は元のまま保つ。 */
function appendMessages(content, entries, file, problems) {
	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		problems.push(`${file}: JSON として読めません（${err.message}）。`);
		return content;
	}
	const taken = entries.filter(([key]) => Object.hasOwn(parsed, key)).map(([key]) => key);
	if (taken.length > 0) {
		problems.push(`${file}: メッセージのキーが既にあります（${taken.join(', ')}）。`);
		return content;
	}
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const body = content.trimEnd();
	if (!body.endsWith('}')) {
		problems.push(`${file}: 末尾が \`}\` で終わっていません。`);
		return content;
	}
	const head = body.slice(0, -1).trimEnd();
	const added = entries
		.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
		.join(`,${eol}`);
	const separator = head.endsWith('{') ? '' : ',';
	return `${head}${separator}${eol}${added}${eol}}${eol}`;
}

/** 両方言の migration の最大の番号の次（4 桁）。 */
function nextMigrationNumber(root, problems) {
	let max = 0;
	for (const dir of MIGRATION_DIRS) {
		const full = path.join(root, dir);
		if (!fs.existsSync(full)) {
			problems.push(`${dir}: migration のディレクトリが見つかりません。`);
			continue;
		}
		for (const file of fs.readdirSync(full)) {
			const match = file.match(/^(\d+)_.*\.sql$/);
			if (match) max = Math.max(max, Number(match[1]));
		}
	}
	return String(max + 1).padStart(4, '0');
}

/**
 * 何を書くかを決める（まだ何も書かない）。問題が 1 つでもあれば、全部を並べた
 * AddResourceError を投げる。
 *
 * 返り値: `{ spec, created: [{ file, content }], edited: [{ file, content }] }`
 */
export function planAddResource(root, name, rawSpec = DEFAULT_SPEC) {
	const spec = normalizeSpec(name, rawSpec);
	const problems = [];
	const number = nextMigrationNumber(root, problems);

	const routes = `${APP}/src/routes/(app)/${spec.kebab}`;
	const created = [
		{
			file: `${MIGRATION_DIRS[0]}/${number}_${spec.name}.sql`,
			content: migrationSql(spec, 'sqlite')
		},
		{
			file: `${MIGRATION_DIRS[1]}/${number}_${spec.name}.sql`,
			content: migrationSql(spec, 'postgres')
		},
		{ file: `${CORE}/src/${spec.name}.rs`, content: serviceRs(spec) },
		{ file: `${CORE}/src/rest/${spec.name}.rs`, content: restRs(spec) },
		{ file: `${APP}/src/lib/banto/resources/${spec.camel}.ts`, content: resourceTs(spec) },
		{ file: `${routes}/+page.svelte`, content: listPageSvelte(spec) },
		{ file: `${routes}/[id]/+page.svelte`, content: detailPageSvelte(spec) },
		{ file: `${routes}/new/+page.svelte`, content: newPageSvelte(spec) }
	];
	for (const { file } of created)
		if (fs.existsSync(path.join(root, file)))
			problems.push(`${file}: 既にあります（生成器は既存のファイルを上書きしません）。`);
	if (fs.existsSync(path.join(root, routes)))
		problems.push(`${routes}: ルートのディレクトリが既にあります。`);
	// 番号が違っても、同じテーブルの migration があれば止める。
	for (const dir of MIGRATION_DIRS) {
		const full = path.join(root, dir);
		if (!fs.existsSync(full)) continue;
		for (const file of fs.readdirSync(full))
			if (new RegExp(`^\\d+_${spec.name}\\.sql$`).test(file))
				problems.push(`${dir}/${file}: 同じ名前の migration が既にあります。`);
	}

	const inserts = [
		{ file: `${CORE}/src/lib.rs`, slot: 'core-mod', text: `pub mod ${spec.name};` },
		{
			file: `${CORE}/src/resources.rs`,
			slot: 'resource-fields',
			text: `    pub ${spec.name}: crate::${spec.name}::${spec.serviceType},`
		},
		{
			file: `${CORE}/src/resources.rs`,
			slot: 'resource-init',
			text:
				`            ${spec.name}: crate::${spec.name}::${spec.serviceType}::new(db.clone())\n` +
				`                .with_events(events.clone()),`
		},
		{ file: `${CORE}/src/rest/mod.rs`, slot: 'route-table', text: routeTableRows(spec) },
		{ file: `${CORE}/src/rest/mod.rs`, slot: 'rest-mod', text: `mod ${spec.name};` },
		{
			file: `${CORE}/src/rest/mod.rs`,
			slot: 'rest-routers',
			text:
				`        .merge(${spec.name}::${spec.name}_router(\n` +
				`            resources.${spec.name}.clone(),\n` +
				`            audit.clone(),\n` +
				`            auth.clone(),\n` +
				`        ))`
		},
		{ file: `${APP}/src-tauri/src/lib.rs`, slot: 'tauri-commands', text: tauriCommands(spec) },
		{ file: `${APP}/src-tauri/src/lib.rs`, slot: 'tauri-handlers', text: tauriHandlers(spec) },
		{ file: `${APP}/src-tauri/src/tests.rs`, slot: 'tauri-tests', text: tauriTests(spec) },
		{
			file: 'scripts/verify-architecture.mjs',
			slot: 'dual-path',
			mode: 'listAfter',
			text: [
				`\t\t{ tauri: '${spec.name}_create', rest: 'POST /api/${spec.name}', role: 'Editor' },`,
				`\t\t{ tauri: '${spec.name}_update', rest: 'PUT /api/${spec.name}/{id}', role: 'Editor' },`,
				`\t\t{ tauri: '${spec.name}_delete', rest: 'DELETE /api/${spec.name}/{id}', role: 'Editor' }`
			].join('\n')
		},
		{
			file: 'scripts/verify-architecture.mjs',
			slot: 'tauri-read',
			mode: 'listAfter',
			text: `\t\t'${spec.name}_get',\n\t\t'${spec.name}_list'`
		},
		{
			file: 'scripts/verify-architecture.mjs',
			slot: 'rest-read',
			mode: 'listAfter',
			text: `\t\t'GET /api/${spec.name}/{id}',\n\t\t'POST /api/${spec.name}/list'`
		},
		{
			file: `${APP}/src/lib/banto/resources/index.ts`,
			slot: 'resource-imports',
			text: `import { ${spec.camel}Resource } from './${spec.camel}';`
		},
		{
			file: `${APP}/src/lib/banto/resources/index.ts`,
			slot: 'resource-list',
			text: `resources.push(${spec.camel}Resource);`
		}
	];

	// 既存のファイルは 1 回だけ読み、差し込みを順に重ねる。
	const contents = new Map();
	const load = (file) => {
		if (contents.has(file)) return contents.get(file);
		const full = path.join(root, file);
		if (!fs.existsSync(full)) {
			problems.push(`${file}: 差し込み先のファイルが見つかりません。`);
			contents.set(file, null);
			return null;
		}
		const content = fs.readFileSync(full, 'utf8');
		contents.set(file, content);
		return content;
	};
	// テンプレートに既にある名前と重なると、差し込んだ後にコンパイルできない（手で足した同名の
	// リソースや、テンプレートのヘルパー）。差し込む前の内容で調べる。
	const tauriLib = load(`${APP}/src-tauri/src/lib.rs`);
	if (tauriLib !== null) {
		// 生成する関数の名前は、生成物そのものから拾う（テンプレートを変えても食い違わない）。
		const functionNames = (text) => new Set([...text.matchAll(/\bfn (\w+)/g)].map((m) => m[1]));
		const existing = functionNames(tauriLib);
		const taken = [...functionNames(`${tauriCommands(spec)}\n${tauriTests(spec)}`)].filter((fn) =>
			existing.has(fn)
		);
		if (taken.length > 0)
			problems.push(
				`${APP}/src-tauri/src/lib.rs: 生成する関数と同じ名前が既にあります（${taken.join(', ')}）。`
			);
	}
	const alreadyNamed = (file, pattern, what) => {
		const content = load(file);
		if (content !== null && pattern.test(content)) problems.push(`${file}: ${what}`);
	};
	// `mod <name>` の宣言か、同じ名前の import（`use axum::middleware;` など）。
	const moduleTaken = new RegExp(
		`\\bmod ${spec.name}\\b|\\buse [^;]*(?:::|[{,\\s]|\\bas )${spec.name}\\s*[;,}]`
	);
	for (const file of [`${CORE}/src/lib.rs`, `${CORE}/src/rest/mod.rs`])
		alreadyNamed(file, moduleTaken, `モジュールか import の名前 \`${spec.name}\` が既にあります。`);
	alreadyNamed(
		`${CORE}/src/resources.rs`,
		new RegExp(`\\bpub ${spec.name}\\s*:`),
		`\`AppResources\` に \`${spec.name}\` の欄が既にあります。`
	);
	alreadyNamed(
		`${APP}/src/lib/banto/resources/index.ts`,
		new RegExp(`\\b${spec.camel}Resource\\b`),
		`\`${spec.camel}Resource\` が既にあります。`
	);
	for (const insert of inserts) {
		const content = load(insert.file);
		if (content === null) continue;
		contents.set(insert.file, insertAtAnchor(content, insert, problems));
	}
	for (const locale of ['ja', 'en']) {
		const file = `${APP}/messages/${locale}.json`;
		const content = load(file);
		if (content === null) continue;
		contents.set(file, appendMessages(content, messageEntries(spec, locale), file, problems));
	}

	if (problems.length > 0)
		throw new AddResourceError(
			`リソース "${name}" を生成できません。何も書いていません。\n` +
				problems.map((problem) => `  - ${problem}`).join('\n') +
				'\nアンカーのコメントは docs/recipes/add-resource.md の「生成器の差し込み先」を見て戻してください。'
		);

	const edited = [...contents].map(([file, content]) => ({ file, content }));
	return { spec, created, edited };
}

/** 計画を書き出す。計画の時点で検査は済んでいる。 */
export function applyPlan(root, plan) {
	for (const { file, content } of [...plan.created, ...plan.edited]) {
		const full = path.join(root, file);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
}

/**
 * 生成物を整形する（`cargo fmt` と prettier）。名前の長さで折り返しが変わるので、
 * テンプレートの側では合わせきらない。道具が無い・失敗したときは、止めずに
 * 手で実行するコマンドを返す。
 */
export function formatGenerated(root, plan) {
	const notes = [];
	const cargo = spawnSync('cargo', ['fmt', '--all'], { cwd: root, encoding: 'utf8' });
	if (cargo.error || cargo.status !== 0)
		notes.push('`cargo fmt --all` を実行できませんでした。手で実行してください。');

	const prettier = path.join(root, 'node_modules/prettier/bin/prettier.cjs');
	const targets = [...plan.created, ...plan.edited]
		.map(({ file }) => file)
		.filter((file) => /\.(ts|svelte|json|mjs)$/.test(file));
	if (!fs.existsSync(prettier)) {
		notes.push(
			'prettier が見つかりません（`pnpm install` の後で `pnpm format` を実行してください）。'
		);
	} else {
		const result = spawnSync(process.execPath, [prettier, '--write', ...targets], {
			cwd: root,
			encoding: 'utf8'
		});
		if (result.error || result.status !== 0)
			notes.push('prettier での整形に失敗しました。`pnpm format` を実行してください。');
	}
	return notes;
}

/** フィールド定義のファイル（JSON）を読む。 */
export function readSpecFile(file) {
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (err) {
		throw new AddResourceError(`フィールド定義 ${file} を読めません（${err.message}）。`);
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new AddResourceError(
			`フィールド定義 ${file} が JSON として読めません（${err.message}）。`
		);
	}
}
