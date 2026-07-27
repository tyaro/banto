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
		/削除する資産: charts, dock, glass, commandPalette, attachments, report/
	);
});

test('--interactive --dry-run は custom（4）で資産ごとの残す/削除を pipe stdin から読む', () => {
	// charts/dock は残す(Y)、それ以外は削除する(n)。
	const res = run(['--interactive', '--dry-run'], '4\nY\nY\nn\nn\nn\nn\n');
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	assert.match(res.stdout, /削除する資産: glass, commandPalette, attachments, report/);
});

test('--interactive は確認で n を選ぶと変更せずに正常終了する', () => {
	const res = run(['--interactive'], '1\nn\n');
	assert.equal(res.status, 0, `非0終了:\n${res.stdout}\n${res.stderr}`);
	assert.match(res.stdout, /中止しました/);
	// --dry-run を付けていないため書き込みが走り得る経路だが、n で中止したので
	// 「適用しました」やファイル編集ログは出てこないはず。
	assert.doesNotMatch(res.stdout, /適用しました/);
});
