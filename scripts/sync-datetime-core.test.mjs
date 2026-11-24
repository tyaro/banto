/**
 * `sync-datetime-core.mjs`（Issue #811）: 写しを作る・違いを見つける・書き直す。
 * 一時ディレクトリに原本だけを置いて確かめる（リポジトリの実物は `--check` が見る）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { COPIES, SOURCE, renderCopy, syncDatetimeCore } from './sync-datetime-core.mjs';

function tempRepo(sourceText) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-datetime-core-'));
	for (const rel of [SOURCE, ...COPIES]) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	}
	fs.writeFileSync(path.join(root, SOURCE), sourceText);
	return root;
}

test('写しは見出し + 原本の本文（改行は LF）', () => {
	const copy = renderCopy('export const A = 1;\r\nexport const B = 2;\r\n');
	assert.match(copy, /^\/\/ GENERATED - DO NOT EDIT\./);
	assert.ok(copy.endsWith('\n\nexport const A = 1;\nexport const B = 2;\n'));
	assert.ok(!copy.includes('\r'));
});

test('写しが無い・違うと check が見つけ、write が直す', (t) => {
	const root = tempRepo('export const A = 1;\n');
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	// 無い: check は全部を挙げ、何も書かない。
	assert.deepEqual(syncDatetimeCore(root, { write: false }), COPIES);
	assert.ok(!fs.existsSync(path.join(root, COPIES[0])));

	// 書く → 同じになる。
	assert.deepEqual(syncDatetimeCore(root, { write: true }), COPIES);
	assert.deepEqual(syncDatetimeCore(root, { write: false }), []);

	// 写しを手で直すと見つかる（その 1 件だけ）。
	fs.appendFileSync(path.join(root, COPIES[1]), 'export const C = 3;\n');
	assert.deepEqual(syncDatetimeCore(root, { write: false }), [COPIES[1]]);

	// 原本を直すと全部が古くなる。
	fs.writeFileSync(path.join(root, SOURCE), 'export const A = 2;\n');
	assert.deepEqual(syncDatetimeCore(root, { write: false }), COPIES);
});

test('CRLF の作業ツリーの写しも同じとみなす', (t) => {
	const root = tempRepo('export const A = 1;\n');
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	syncDatetimeCore(root, { write: true });
	for (const rel of COPIES) {
		const file = path.join(root, rel);
		fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
	}
	assert.deepEqual(syncDatetimeCore(root, { write: false }), []);
});
