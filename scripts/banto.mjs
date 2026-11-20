#!/usr/bin/env node
/**
 * `pnpm banto <command>`: テンプレートにコードを足す道具の入口（Issue #715）。
 * 今あるのは `add resource` だけ。本体は scripts/lib/add-resource.mjs、
 * 手順は docs/recipes/add-resource.md。
 *
 *   pnpm banto add resource <name> [--fields <file.json>] [--dry-run] [--no-format]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	AddResourceError,
	applyPlan,
	formatGenerated,
	planAddResource,
	readSpecFile
} from './lib/add-resource.mjs';

const USAGE = `使い方:
  pnpm banto add resource <name> [--fields <file.json>] [--dry-run] [--no-format]

  <name>       リソース名（snake_case の複数形。例: orders、purchase_orders）。
               テーブル名・URL（/api/<name>）・Tauri コマンド（<name>_list など）になる。
  --fields     フィールド定義（JSON）。省くと、必須の name（80 文字まで）だけのリソース。
  --dry-run    何を書くかだけを出し、何も書かない。
  --no-format  生成の後の整形（cargo fmt・prettier）をしない。

フィールド定義の書式と、生成するファイルは docs/recipes/add-resource.md にある。`;

function parseArgs(argv) {
	const options = { fields: null, dryRun: false, format: true, positional: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--dry-run') options.dryRun = true;
		else if (arg === '--no-format') options.format = false;
		else if (arg === '--fields') {
			options.fields = argv[++i];
			if (!options.fields) throw new AddResourceError('--fields にファイルを指定してください。');
		} else if (arg.startsWith('--fields=')) options.fields = arg.slice('--fields='.length);
		else if (arg === '--help' || arg === '-h') options.help = true;
		else if (arg.startsWith('-')) throw new AddResourceError(`知らないオプションです: ${arg}`);
		else options.positional.push(arg);
	}
	return options;
}

function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const options = parseArgs(process.argv.slice(2));
	const [command, kind, name, ...rest] = options.positional;
	if (options.help || command === undefined) {
		console.log(USAGE);
		return;
	}
	if (command !== 'add' || kind !== 'resource' || !name || rest.length > 0)
		throw new AddResourceError(`コマンドを読めません。\n\n${USAGE}`);

	// --fields の相対パスは、コマンドを打った場所（pnpm は INIT_CWD に残す）から読む。
	const cwd = process.env.INIT_CWD ?? process.cwd();
	const rawSpec = options.fields ? readSpecFile(path.resolve(cwd, options.fields)) : undefined;
	const plan = planAddResource(root, name, rawSpec);

	const verb = options.dryRun ? '作る予定' : '作成';
	if (!options.dryRun) applyPlan(root, plan);
	for (const { file } of plan.created) console.log(`  ${verb}: ${file}`);
	for (const { file } of plan.edited)
		console.log(`  ${options.dryRun ? '足す予定' : '追記'}: ${file}`);

	if (options.dryRun) {
		console.log('\n--dry-run のため、何も書いていません。');
		return;
	}
	const notes = options.format ? formatGenerated(root, plan) : [];
	for (const note of notes) console.log(`  注意: ${note}`);
	console.log(`
リソース "${name}" を生成しました。生成物は普通のコードです（この後は手で直します）。
次にすること:
  1. 文言を直す: apps/admin-template/messages/ja.json・en.json の ${plan.spec.camel}.* と nav.${plan.spec.camel}
  2. 確かめる:   cargo test / pnpm check / pnpm verify:architecture
  3. 手順の残り（CSV 取込・一括削除・デモのデータなど）は docs/recipes/add-resource.md`);
}

try {
	main();
} catch (err) {
	if (err instanceof AddResourceError) {
		console.error(err.message);
		process.exit(1);
	}
	throw err;
}
