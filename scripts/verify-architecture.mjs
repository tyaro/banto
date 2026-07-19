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
