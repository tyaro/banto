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

test('--interactive --dry-run は custom（5）で資産ごとの残す/削除を pipe stdin から読む', () => {
	// charts/dock は残す(Y)、それ以外（glass/commandPalette/attachments/report/tree）は削除する(n)。
	// custom で聞かれるのは**オプション資産7種だけ**（display の items/画面削除は
	// 一括適用なので個別トグルの対象外 — scaffold.mjs の `CUSTOM_TOGGLEABLE`）。
	const res = run(['--interactive', '--dry-run'], '5\nY\nY\nn\nn\nn\nn\nn\n');
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	assert.match(res.stdout, /削除する資産: glass, commandPalette, attachments, report, tree/);
});

test('--interactive --dry-run は display（4）を選べる', () => {
	const res = run(['--interactive', '--dry-run'], '4\n');
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	assert.match(res.stdout, /足す工程: displayDefaults/);
});

test('--interactive は確認で n を選ぶと変更せずに正常終了する', () => {
	const res = run(['--interactive'], '1\nn\n');
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	assert.match(res.stdout, /中止しました/);
	// --dry-run を付けていないため書き込みが走り得る経路だが、n で中止したので
	// 「適用しました」やファイル編集ログは出てこないはず。
	assert.doesNotMatch(res.stdout, /適用しました/);
});

// display プリセット（docs/display-preset-plan.md §3.2、Issue #190）の計画テスト。
// `--dry-run --strict` は「pristine な出荷ツリーで全アンカーが一致すること」の
// 機械検査そのものなので、アンカーがドリフトすればここで落ちる（
// template-acceptance.yml の presets ジョブが実際に適用する前の軽量ガード）。
test('--preset display --dry-run --strict が全アンカー一致で通り、削除と追加の両方を計画する', () => {
	const res = run(['--preset', 'display', '--dry-run', '--strict'], '');
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	// minimal の7資産 + display 固有の3 remover、そして唯一の「足す」工程。
	assert.match(
		res.stdout,
		/削除する資産: charts, dock, glass, commandPalette, attachments, report, tree, items, adminPages, dashboard/
	);
	assert.match(res.stdout, /足す工程: displayDefaults/);
	// display の「足す」側の要（plan §3.2）。どれが欠けても表示専用アプリとして
	// 起動しないので、計画に出ていることをキーとなる4点で確かめる。
	assert.match(res.stdout, /monitor ページ配置/);
	assert.match(res.stdout, /FIRST_BOOT_SETTINGS に display の既定を設定/);
	assert.match(res.stdout, /KIOSK_DEFAULT を true に/);
	assert.match(res.stdout, /banto\.i18n を raw に/);
});

test('--preset minimal|standard|full|display は --dry-run --strict で全て通る', () => {
	for (const preset of ['minimal', 'standard', 'full', 'display']) {
		const res = run(['--preset', preset, '--dry-run', '--strict'], '');
		assert.equal(
			res.status,
			0,
			`preset ${preset} が --strict で失敗:\n${res.stdout}\n${res.stderr}`
		);
	}
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

// PRESETS / ORDER / REMOVERS の三者一致（display で工程が3倍に増えたので、
// 「ORDER に載せ忘れた工程は黙って実行されない」事故を機械で止める）。
// `--dry-run` の計画出力を一次情報にする（scaffold.mjs を import せずに済む —
// あのモジュールはトップレベルで引数を解析し process.exit するため）。
test('各プリセットの全工程が ORDER に載っていて、計画出力に現れる', () => {
	const EXPECTED = {
		minimal: ['charts', 'dock', 'glass', 'commandPalette', 'attachments', 'report', 'tree'],
		standard: ['attachments', 'report', 'tree'],
		full: [],
		display: [
			'charts',
			'dock',
			'glass',
			'commandPalette',
			'attachments',
			'report',
			'tree',
			'items',
			'adminPages',
			'dashboard',
			'displayDefaults'
		]
	};
	for (const [preset, steps] of Object.entries(EXPECTED)) {
		const res = run(['--preset', preset, '--dry-run'], '');
		assert.equal(res.status, 0, `preset ${preset} が失敗:\n${res.stdout}\n${res.stderr}`);
		for (const step of steps)
			assert.ok(
				res.stdout.includes(`\n# ${step}\n`),
				`preset ${preset} の計画に工程 '${step}' が出ていません（ORDER への登録漏れ？）`
			);
		if (steps.length === 0) assert.match(res.stdout, /削除する資産: なし/);
	}
});
