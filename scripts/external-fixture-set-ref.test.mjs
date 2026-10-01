/**
 * `scripts/external-fixture-set-ref.mjs` のテスト（#271）。
 * 依存を足さない（Node 標準の `node:test` のみ、conventions §3）。
 *
 * 方式: 実際の fixture の package.json / rust/Cargo.toml を一時ディレクトリへ
 * コピーして書き換え、すべての `@banto/*` と banto の `rev` が新しい ref になる
 * こと・それ以外が変わらないこと・不正な ref を拒むことを確かめる。実リポジトリは
 * 書き換えない。
 *
 * 実行: `node --test scripts/external-fixture-set-ref.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_DIR, isCommitSha, setFixtureRef } from './external-fixture-set-ref.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function copyFixture() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'banto-ext-fixture-'));
	for (const rel of ['package.json', 'rust/Cargo.toml']) {
		const dest = path.join(tmp, FIXTURE_DIR, rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(path.join(repoRoot, FIXTURE_DIR, rel), dest);
	}
	return tmp;
}

const SHA = '0123456789abcdef0123456789abcdef01234567';

/** fixture の Cargo.toml の banto の Git 依存の [キー(rev|tag), ref] の一覧。 */
function readCargoRefs(root) {
	const toml = fs.readFileSync(path.join(root, FIXTURE_DIR, 'rust/Cargo.toml'), 'utf8');
	return [...toml.matchAll(/tyaro\/banto\.git", (rev|tag) = "([^"]*)"/g)].map((m) => [m[1], m[2]]);
}

test('すべての @banto/* と banto の rev / tag を指定の ref に書き換える', () => {
	const tmp = copyFixture();
	try {
		const before = JSON.parse(
			fs.readFileSync(path.join(repoRoot, FIXTURE_DIR, 'package.json'), 'utf8')
		);
		const bantoDeps = Object.keys(before.dependencies).filter((d) => d.startsWith('@banto/'));

		const { npm, cargo } = setFixtureRef(SHA, { root: tmp });
		assert.equal(npm, bantoDeps.length);

		const after = JSON.parse(fs.readFileSync(path.join(tmp, FIXTURE_DIR, 'package.json'), 'utf8'));
		for (const dep of bantoDeps) {
			const pkg = dep.slice('@banto/'.length);
			assert.equal(after.dependencies[dep], `github:tyaro/banto#${SHA}&path:packages/${pkg}`);
		}
		// @banto/* 以外（devDependencies など）は変わらない。
		assert.deepEqual(after.devDependencies, before.devDependencies);

		// SHA → Cargo は `rev`（tag 行から SHA へ。commit してある既定値は tag）。
		const toml = readCargoRefs(tmp);
		assert.equal(toml.length, cargo);
		assert.ok(cargo >= 5, `banto の Git 依存が 5 crate 未満: ${cargo}`);
		assert.ok(toml.every(([key, ref]) => key === 'rev' && ref === SHA));

		// rev 行からタグへ: Cargo は `tag`、件数は同じ（往復できる）。
		const again = setFixtureRef('v1.2.3', { root: tmp });
		assert.deepEqual(again, { npm, cargo });
		assert.ok(readCargoRefs(tmp).every(([key, ref]) => key === 'tag' && ref === 'v1.2.3'));
		const back = JSON.parse(fs.readFileSync(path.join(tmp, FIXTURE_DIR, 'package.json'), 'utf8'));
		assert.equal(
			back.dependencies['@banto/admin-core'],
			'github:tyaro/banto#v1.2.3&path:packages/admin-core'
		);
		// features など同じ行の他のキーは残る。
		assert.match(
			fs.readFileSync(path.join(tmp, FIXTURE_DIR, 'rust/Cargo.toml'), 'utf8'),
			/^banto-storage = \{[^}\n]*tag = "v1\.2\.3", features = \["sqlite"\] \}/m
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('Cargo は 40 桁の hex なら rev、それ以外（タグ名）なら tag を書く', () => {
	assert.equal(isCommitSha(SHA), true);
	for (const notSha of ['v1.7.3', 'main', SHA.slice(0, 39), SHA.toUpperCase(), `${SHA}0`]) {
		assert.equal(isCommitSha(notSha), false, notSha);
	}
	const tmp = copyFixture();
	try {
		// 既定値（commit してある形）は消費側と同じ tag。
		assert.ok(readCargoRefs(tmp).every(([key]) => key === 'tag'));
		setFixtureRef('v9.9.9', { root: tmp });
		assert.ok(readCargoRefs(tmp).every(([key, ref]) => key === 'tag' && ref === 'v9.9.9'));
		setFixtureRef(SHA, { root: tmp });
		assert.ok(readCargoRefs(tmp).every(([key, ref]) => key === 'rev' && ref === SHA));
		setFixtureRef(SHA, { root: tmp });
		assert.ok(readCargoRefs(tmp).every(([key, ref]) => key === 'rev' && ref === SHA));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('package.json / Cargo.toml の構文を壊す ref は拒む', () => {
	const tmp = copyFixture();
	try {
		for (const bad of ['', 'a"b', 'a&path:x', 'a#b', '-x', 'a b']) {
			assert.throws(() => setFixtureRef(bad, { root: tmp }), /ref が不正/, bad);
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('置換対象が無ければ失敗する（fixture の形が変わったのを黙って通さない）', () => {
	const tmp = copyFixture();
	try {
		const pkgPath = path.join(tmp, FIXTURE_DIR, 'package.json');
		fs.writeFileSync(pkgPath, JSON.stringify({ name: 'x', dependencies: {} }));
		assert.throws(() => setFixtureRef(SHA, { root: tmp }), /github:tyaro\/banto/);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
