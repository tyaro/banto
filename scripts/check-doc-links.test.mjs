/**
 * `scripts/check-doc-links.mjs` のテスト。依存を足さない（Node 標準の `node:test` のみ）。
 * 実行: `node --test scripts/check-doc-links.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	EXCLUDED_MD,
	extractTargets,
	findBrokenLinks,
	listBantoOnly,
	listMarkdownFiles,
	normalizeTarget,
	resolveTarget,
	stripCode
} from './check-doc-links.mjs';

/** 仮想のファイル群に対して検査する。 */
function check(files, existing) {
	const set = new Set(existing);
	return findBrokenLinks(Object.keys(files), {
		exists: (p) => set.has(p),
		read: (f) => files[f]
	});
}

test('インライン・画像・参照定義の target を拾う', () => {
	assert.deepEqual(extractTargets('see [a](a.md) and ![b](img/b.png)'), ['a.md', 'img/b.png']);
	assert.deepEqual(extractTargets('[ref]: ./c.md'), ['./c.md']);
});

test('<...> とタイトルに対応する', () => {
	assert.deepEqual(extractTargets('[a](<my doc.md>)'), ['my doc.md']);
	assert.deepEqual(extractTargets('[a](a.md "title")'), ['a.md']);
	assert.deepEqual(extractTargets("[a](<x y.md> 'title')"), ['x y.md']);
});

test('http・mailto・# だけは飛ばし、#anchor と :行番号は外す', () => {
	assert.equal(normalizeTarget('https://example.com/a'), null);
	assert.equal(normalizeTarget('mailto:a@example.com'), null);
	assert.equal(normalizeTarget('#top'), null);
	assert.equal(normalizeTarget('a.md#sec'), 'a.md');
	assert.equal(normalizeTarget('foo.ts:42'), 'foo.ts');
	assert.equal(normalizeTarget('my%20doc.md'), 'my doc.md');
});

test('先頭 / はルートから、それ以外はファイルの場所から辿る', () => {
	assert.equal(resolveTarget('docs/a.md', '../README.md'), 'README.md');
	assert.equal(resolveTarget('docs/a.md', 'b.md'), 'docs/b.md');
	assert.equal(resolveTarget('docs/a.md', '/crates/x.rs'), 'crates/x.rs');
});

test('コードフェンスとインラインコードの中は見ない（行番号は保つ）', () => {
	const lines = stripCode('a\n```\n[x](no.md)\n```\n`[y](no2.md)` [z](z.md)');
	assert.equal(lines.length, 5);
	assert.deepEqual(extractTargets(lines[2]), []);
	assert.deepEqual(extractTargets(lines[4]), ['z.md']);
});

test('実在しないリンクを file:line と target で報告する', () => {
	const broken = check({ 'docs/a.md': 'ok [b](b.md)\n\nbad [c](c.md#x)\n', 'docs/b.md': '' }, [
		'docs/a.md',
		'docs/b.md'
	]);
	assert.deepEqual(broken, [{ file: 'docs/a.md', line: 3, target: 'c.md#x' }]);
});

test('リポジトリの外へ出るリンクは壊れている扱い', () => {
	const broken = check({ 'a.md': '[x](../outside.md)' }, ['a.md']);
	assert.equal(broken.length, 1);
});

test('帳票の DSL（reports/*.md）は対象外で、README の正規表現にも掛からない', () => {
	assert.ok(EXCLUDED_MD.test('apps/admin-template/src/lib/banto/reports/daily.md'));
	assert.ok(!EXCLUDED_MD.test('apps/admin-template/src/lib/banto/reports/sub/x.md'));
	const broken = check(
		{ 'apps/admin-template/src/lib/banto/reports/daily.md': '[x](nope.md)' },
		[]
	);
	assert.deepEqual(broken, []);
});

test('scaffold が消す banto 本体専用の path を指すリンクは、派生先（全部無い）でだけ許す', () => {
	const files = {
		'docs/a.md':
			'[w](../.github/workflows/external-consumer.yml) [f](../fixtures/external-consumer/)'
	};
	const bantoOnly = ['fixtures/external-consumer', '.github/workflows/external-consumer.yml'];
	const run = (existing) =>
		findBrokenLinks(Object.keys(files), {
			exists: (p) => new Set(existing).has(p),
			read: (f) => files[f],
			bantoOnly
		});
	// 派生先: 一覧が全部無いので、どちらも許す。
	assert.deepEqual(run(['docs/a.md']), []);
	// 本体: 一覧のどれかが在る。在るものは通り、消えたもの（workflow）は本当のリンク切れ。
	const broken = run(['docs/a.md', 'fixtures/external-consumer']);
	assert.deepEqual(
		broken.map((b) => b.target),
		['../.github/workflows/external-consumer.yml']
	);
});

test('listBantoOnly は scaffold の一覧を返す', () => {
	const list = listBantoOnly();
	assert.ok(list.includes('fixtures/external-consumer'));
	assert.ok(list.every((p) => !p.endsWith('/')));
});

test('日本語のファイル名の Markdown も git ls-files から正しく取れる（-z）', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclinks-'));
	try {
		const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
		git('init', '-q');
		fs.writeFileSync(path.join(dir, '日本語の文書.md'), '# x\n');
		fs.writeFileSync(path.join(dir, 'plain.md'), '# y\n');
		git('add', '-A');
		assert.deepEqual(listMarkdownFiles(dir).sort(), ['plain.md', '日本語の文書.md'].sort());
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
