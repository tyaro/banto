/**
 * `scripts/scaffold.mjs` の軽量テスト（scaffold-presets-plan §7.3）。
 * 依存を足さない（Node 標準の `node:test` のみ、conventions §3）。
 *
 * 対話モード（`--interactive`）は人間向けの UX なので厚くテストしない。
 * ここでは「入力を作る」部分だけを、pipe された stdin で実プロセスを起動して
 * 軽く確認する。`--dry-run` を必ず併用するため実リポジトリには一切書き込まない
 * （removers はファイルを読むだけなので実 repoRoot に対して実行して安全）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scaffold = path.join(repoRoot, 'scripts/scaffold.mjs');

function run(args, input) {
	return spawnSync(process.execPath, [scaffold, ...args], {
		cwd: repoRoot,
		encoding: 'utf8',
		input
	});
}

test('--preset bogus は非0終了する（ガード）', () => {
	const res = run(['--preset', 'bogus'], '');
	assert.notEqual(res.status, 0, 'bogus プリセットが成功してしまった');
	assert.match(res.stderr, /エラー/);
});

test('--interactive と --preset の併用はエラー', () => {
	const res = run(['--interactive', '--preset', 'minimal'], '');
	assert.notEqual(res.status, 0);
	assert.match(res.stderr, /同時に指定できません/);
});

test('--interactive --dry-run はプリセット選択（1=minimal）を pipe stdin から読み、計画を表示する', () => {
	const res = run(['--interactive', '--dry-run'], '1\n');
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	assert.match(
		res.stdout,
		/削除する資産: charts, dock, glass, commandPalette, attachments, report, tree/
	);
});

test('--interactive --dry-run は custom（4）で資産ごとの残す/削除を pipe stdin から読む', () => {
	// charts/dock は残す(Y)、それ以外（glass/commandPalette/attachments/report/tree）は削除する(n)。
	const res = run(['--interactive', '--dry-run'], '4\nY\nY\nn\nn\nn\nn\nn\n');
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	assert.match(res.stdout, /削除する資産: glass, commandPalette, attachments, report, tree/);
});

test('--interactive は確認で n を選ぶと変更せずに正常終了する', () => {
	const res = run(['--interactive'], '1\nn\n');
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	assert.match(res.stdout, /中止しました/);
	// --dry-run を付けていないため書き込みが走り得る経路だが、n で中止したので
	// 「適用しました」やファイル編集ログは出てこないはず。
	assert.doesNotMatch(res.stdout, /適用しました/);
});

test('--strict と --interactive の併用はエラー', () => {
	const res = run(['--interactive', '--strict'], '');
	assert.notEqual(res.status, 0);
	assert.match(res.stderr, /--strict は --preset 専用/);
});

// packages/ と scaffold の同期トリップワイヤ（maintenance-review-2026-08 H-1 の再発防止）。
// 新しいパッケージを足したら、(a) remover を書いて ORDER に登録する、
// (b) コア扱いにする、(c) 「scaffold は触れない」除外として本テストに理由付きで
// 追記する、のいずれかを明示的に選ばない限り CI が落ちる。
// tree（#143-144 追加時）が scaffold から漏れて minimal でもデモが残った実例への対策。
test('packages/ の全パッケージが scaffold の判断（remover / コア / 除外）に登録されている', async () => {
	const fs = await import('node:fs');
	// コア（常在。scaffold は触れない前提のパッケージ）
	const CORE = new Set(['admin-core', 'forms', 'theme', 'grid-svelte']);
	// 資産 → 対応パッケージ（アプリ内資産のみの glass/commandPalette はパッケージ無し）
	const ASSET_PACKAGES = new Set(['charts', 'dock-svelte', 'attachments', 'report', 'tree-svelte']);
	// 意図的な除外（レシピのみ・未配線。scaffold.mjs 冒頭 doc と plan §3 の決定）
	const EXCLUDED = new Set(['scan-wedge']);

	const source = fs.readFileSync(path.join(repoRoot, 'scripts/scaffold.mjs'), 'utf8');
	const dirs = fs
		.readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
	for (const dir of dirs) {
		assert.ok(
			CORE.has(dir) || ASSET_PACKAGES.has(dir) || EXCLUDED.has(dir),
			`packages/${dir} が scaffold の判断に未登録です。remover を追加して ORDER に登録するか、` +
				`本テストの CORE / EXCLUDED に理由付きで追記してください（scaffold-presets-plan §5）`
		);
		// 資産パッケージは remover 側の実在も確認（テスト表と scaffold 本体の両建てドリフト防止）
		if (ASSET_PACKAGES.has(dir)) {
			const asset = dir.replace(/-svelte$/, '').replace(/^dock$/, 'dock');
			assert.match(
				source,
				new RegExp(`\\b${asset}: remove`),
				`scripts/scaffold.mjs の REMOVERS に '${asset}' が見つかりません（packages/${dir} 用）`
			);
		}
	}
});
