#!/usr/bin/env node
/**
 * 日付・時刻の文字列の決まり（`datetime-core.ts`）を 1 つの原本から各パッケージへ写す
 * （Issue #811）。
 *
 * パッケージどうしは import できない（conventions §4）ので、同じ解析と形式が
 * ui・forms・grid-svelte に手書きで複製され、試験で突き合わせていた。原本を
 * `packages/ui/src/datetime-core.ts` の 1 つに決め、ほかの 2 つは「生成物」の
 * 見出しを付けた写しにする。写しは git に入れる（公開するパッケージの `src` の一部で、
 * 消費側は生成の手順を持たない）。
 *
 *   node scripts/sync-datetime-core.mjs           写しを書き直す（`pnpm sync:datetime-core`）
 *   node scripts/sync-datetime-core.mjs --check   写しが原本と違えば exit 1（`pnpm check:datetime-core`、CI）
 *
 * 原本を直したら `pnpm sync:datetime-core` を走らせて、写しも同じコミットに入れる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE = 'packages/ui/src/datetime-core.ts';

export const COPIES = [
	'packages/forms/src/datetime-core.ts',
	'packages/grid-svelte/src/core/datetime-core.ts'
];

const BANNER = `// GENERATED - DO NOT EDIT. A copy of ${SOURCE}
// written by scripts/sync-datetime-core.mjs (Issue #811). Edit that file, then
// run \`pnpm sync:datetime-core\`; CI (\`pnpm check:datetime-core\`) fails when
// this copy differs.

`;

/** 改行は LF に揃えて比べる（Windows の作業ツリーが CRLF でも同じ結果にする）。 */
const normalize = (text) => text.replace(/\r\n/g, '\n');

/** 原本の本文から写しの本文を作る。 */
export function renderCopy(sourceText) {
	return BANNER + normalize(sourceText);
}

/**
 * `root` の下で写しを確かめる（`write` なら書き直す）。原本と違う（または無い）写しの
 * パスを返す。`write` のときは、書き直したパスを返す。
 */
export function syncDatetimeCore(root, { write }) {
	const expected = renderCopy(fs.readFileSync(path.join(root, SOURCE), 'utf8'));
	const stale = [];
	for (const rel of COPIES) {
		const file = path.join(root, rel);
		const actual = fs.existsSync(file) ? normalize(fs.readFileSync(file, 'utf8')) : null;
		if (actual === expected) continue;
		stale.push(rel);
		if (write) fs.writeFileSync(file, expected);
	}
	return stale;
}

function main() {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const check = process.argv.includes('--check');
	const stale = syncDatetimeCore(repoRoot, { write: !check });
	if (stale.length === 0) {
		console.log(`[sync-datetime-core] OK: 写し ${COPIES.length} 件は原本（${SOURCE}）と同じ。`);
		return;
	}
	if (check) {
		console.error(`[sync-datetime-core] 原本（${SOURCE}）と違う写しがある:`);
		for (const rel of stale) console.error(`  - ${rel}`);
		console.error(
			'写しは手で直さない。原本を直して `pnpm sync:datetime-core` を走らせ、写しも一緒にコミットする。'
		);
		process.exit(1);
	}
	for (const rel of stale) console.log(`[sync-datetime-core] 書き直した: ${rel}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
