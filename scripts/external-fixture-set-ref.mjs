#!/usr/bin/env node
/**
 * 外部利用 fixture（#271、fixtures/external-consumer/）の Git 依存の ref を書き換える。
 * 依存を足さない文化（conventions §3）に従い Node 標準ライブラリのみ。
 *
 * 使い方:
 *   node scripts/external-fixture-set-ref.mjs <ref>
 *
 * `<ref>` は push 済みの commit SHA（40 桁）かタグ（`v1.7.3` 等）。書き換えるのは:
 *   - fixtures/external-consumer/package.json の
 *     `github:tyaro/banto#<ref>&path:packages/<x>`（`@banto/*` すべて）
 *   - fixtures/external-consumer/rust/Cargo.toml の banto の Git 依存の
 *     `rev = "<sha>"`（ref が 40 桁の hex のとき）か `tag = "<name>"`（それ以外。
 *     派生アプリが実際に書く形）。既存の行が `rev`・`tag` のどちらでも置換する
 *
 * CI（.github/workflows/external-consumer.yml）は、PR・dispatch では検証する
 * commit の SHA で、タグの push ではタグ名で呼ぶ（消費側と同じタグ名での解決を
 * 確かめるため）。commit してある値は現行リリースタグ（`tag = "..."`）。書き換えた後の `pnpm install` は
 * `--no-frozen-lockfile` にする（ref が変わると lockfile は必ず古くなる。
 * 再解決されるのは `@banto/*` だけで、推移依存は lockfile のまま）。
 *
 * 置換が 1 件も起きなかったファイルがあれば失敗する（fixture の形が変わった
 * のに本スクリプトが追随していない、を黙って通さない）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** fixture のディレクトリ（リポジトリ根からの相対）。 */
export const FIXTURE_DIR = 'fixtures/external-consumer';

// ref に使ってよい文字（SHA・タグ・ブランチ名）。引用符や `&`・`#` を含む値で
// package.json / Cargo.toml の構文を壊さないため、許可する文字を絞る。
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** `github:tyaro/banto#<ref>&path:` の `<ref>` 部分。 */
const NPM_REF = /(github:tyaro\/banto#)[^&"]+(&path:)/g;
/**
 * banto の Git 依存の `rev = "<ref>"` / `tag = "<ref>"`（同じ行に banto の git URL が
 * あるものだけ）。キー（rev / tag）ごと置き換える。
 */
const CARGO_REF =
	/^(.*git = "https:\/\/github\.com\/tyaro\/banto\.git".*?)\b(?:rev|tag) = "[^"]*"/gm;

/** 40 桁の hex（commit SHA）なら Cargo は `rev`、それ以外（タグ名）は `tag`。 */
export const isCommitSha = (ref) => /^[0-9a-f]{40}$/.test(ref);

/**
 * 文字列中の ref を置換する。戻り値は置換後の文字列と件数。
 * @param {string} src
 * @param {RegExp} pattern
 * @param {string} ref
 */
function replaceRef(src, pattern, ref) {
	let count = 0;
	const out = src.replace(pattern, (_m, head, tail) => {
		count++;
		return `${head}${ref}${tail}`;
	});
	return { out, count };
}

/**
 * fixture の ref を書き換える。
 * @param {string} ref
 * @param {{ root?: string }} [options] root はテスト用（既定はこのリポジトリ）
 * @returns {{ npm: number, cargo: number }} 置換した件数
 */
export function setFixtureRef(ref, { root = repoRoot } = {}) {
	if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
		throw new Error(`ref が不正: ${JSON.stringify(ref)}（英数字・. _ / - のみ）`);
	}
	const pkgPath = path.join(root, FIXTURE_DIR, 'package.json');
	const cargoPath = path.join(root, FIXTURE_DIR, 'rust', 'Cargo.toml');

	const npm = replaceRef(fs.readFileSync(pkgPath, 'utf8'), NPM_REF, ref);
	if (npm.count === 0) throw new Error(`${pkgPath} に github:tyaro/banto#<ref>&path: が無い`);
	// 書き換え後も JSON として読めることを確かめてから書く。
	JSON.parse(npm.out);

	const cargoKey = isCommitSha(ref) ? 'rev' : 'tag';
	let cargoCount = 0;
	const cargoOut = fs.readFileSync(cargoPath, 'utf8').replace(CARGO_REF, (_m, head) => {
		cargoCount++;
		return `${head}${cargoKey} = "${ref}"`;
	});
	const cargo = { out: cargoOut, count: cargoCount };
	if (cargo.count === 0) throw new Error(`${cargoPath} に banto の rev / tag = "..." が無い`);

	fs.writeFileSync(pkgPath, npm.out);
	fs.writeFileSync(cargoPath, cargo.out);
	return { npm: npm.count, cargo: cargo.count };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const ref = process.argv[2];
	if (!ref || process.argv.length > 3) {
		console.error('使い方: node scripts/external-fixture-set-ref.mjs <ref>');
		process.exit(2);
	}
	try {
		const { npm, cargo } = setFixtureRef(ref);
		console.log(
			`external-consumer fixture の ref を ${ref} にした（npm ${npm} 件、Cargo ${cargo} 件）`
		);
	} catch (err) {
		console.error(`external-fixture-set-ref: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}
