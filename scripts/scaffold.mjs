#!/usr/bin/env node
/**
 * プリセット・スキャフォールド（improvement-plan-2026-07.md P4-9 /
 * docs/scaffold-presets-plan.md）。
 *
 * Banto をコピーした直後に、選んだプリセットで**不要なオプション資産を削除**
 * する。テンプレート本体は「全部入り（full）」で出荷され、スキャフォールドは
 * 「引く」だけ（＝資産を足すことは一切しない。plan §7.1 の ship-full/remove-only
 * 決定）。コア（auth/RBAC/audit/settings/backup/CSV/shell）には一切触れない。
 *
 * プリセット（✓＝残す / ✗＝削除。plan §3）:
 *   - minimal  … コアのみ（charts/dock/glass/commandPalette/attachments/report/tree を全削除）
 *   - standard … ダッシュボード体験を残す（attachments/report/tree を削除）
 *   - full     … 何も削除しない（検証のみ）
 *   ※ scan-wedge は現状レシピのみ・未配線なので scaffold は一切触れない（plan §3）。
 *
 * 各資産の削除は README「3. オプション資産の削除」の手順を 1 対 1 で自動化した
 * 単一の remover 関数に閉じる。プリセットは「どの remover を呼ぶか」の集合。
 * 編集エンジン（現在値を読んで置換・再実行安全・`--dry-run`・見つからない
 * パターンは明示的失敗）は rename.mjs と共有する scripts/lib/template-edit.mjs。
 * 依存は足さない（Node 標準のみ、conventions §3 / ADR-0002）。
 *
 * 使い方:
 *   node scripts/scaffold.mjs --preset minimal|standard|full [--dry-run]
 *   node scripts/scaffold.mjs --interactive|-i [--dry-run]
 *
 * `--interactive`（plan §7.3）は人間に対話でプリセット（または個別資産の
 * 残す/削除）を選ばせた上で、`--preset` と**全く同じ削除ロジック**
 * （`toRemove` の Set → ORDER に沿った remover 呼び出し）を実行する。
 * 依存を足さない文化に従い Node 標準の `node:readline/promises` のみを使う
 * （新規依存なし、conventions §3 / ADR-0002）。
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { createEditor, dropBlock, swap, cut, cutToEnd } from './lib/template-edit.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- 引数 -------------------------------------------------------------------

const PRESETS = {
	// 値 = 削除する資産の集合（残すものは書かない）。
	minimal: ['charts', 'dock', 'glass', 'commandPalette', 'attachments', 'report', 'tree'],
	standard: ['attachments', 'report', 'tree'],
	full: []
};

function usage(code) {
	console.log(
		'使い方: node scripts/scaffold.mjs --preset minimal|standard|full [--dry-run] [--strict]\n' +
			'       node scripts/scaffold.mjs --interactive|-i [--dry-run]\n' +
			'  minimal     … コアのみ（全オプション資産を削除）\n' +
			'  standard    … dock/charts/コマンドパレット/Glass を残し、添付・帳票・ツリーを削除\n' +
			'  full        … 何も削除しない（検証のみ）\n' +
			'  --interactive/-i … プリセット（または資産ごとの残す/削除）を対話で選ぶ。\n' +
			'                      --preset とは併用不可\n' +
			'  --strict    … pristine コピー専用: 「適用済み扱い」をアンカードリフトとして失敗にする\n' +
			'                （再実行安全性が消えるため通常運用では付けない。CI の受け入れ検査用）'
	);
	process.exit(code);
}

function fail(message) {
	console.error(`エラー: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const args = { dryRun: false, interactive: false, strict: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--preset') {
			args.preset = argv[++i];
			if (args.preset === undefined) fail('--preset に値がありません');
		} else if (arg === '--dry-run') args.dryRun = true;
		else if (arg === '--strict') args.strict = true;
		else if (arg === '--interactive' || arg === '-i') args.interactive = true;
		else if (arg === '--help' || arg === '-h') usage(0);
		else fail(`不明な引数: ${arg}`);
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.interactive && args.preset)
	fail('--interactive と --preset は同時に指定できません（どちらか一方を選んでください）');
if (args.interactive && args.strict)
	fail('--strict は --preset 専用です（CI の pristine コピー検査用。対話モードでは使えません）');
if (!args.interactive && !args.preset) usage(1);
if (args.preset && !Object.prototype.hasOwnProperty.call(PRESETS, args.preset))
	fail(
		`--preset は ${Object.keys(PRESETS).join(' / ')} のいずれかを指定してください: ${args.preset}`
	);

// --- 編集エンジン -----------------------------------------------------------

const editor = createEditor({ repoRoot, dryRun: args.dryRun, strict: args.strict });
const { editFile, removeFile, removeDir } = editor;

/** 連続領域を start..end（両端含む）で削除。短い一意アンカーで巨大ブロックを消す。 */
function cutRegion(rel, label, start, end) {
	editFile(rel, label, (s) => cut(s, start, end));
}
/** 1 ブロック（行や連続領域）を丸ごと削除（冪等・見つからなければ適用済み扱い）。 */
function drop(rel, label, block) {
	editFile(rel, label, (s) => dropBlock(s, block));
}
/** marker から EOF までを削除（末尾は単一改行に整える・冪等）。章末の付録ブロック向け。 */
function cutEnd(rel, label, marker) {
	editFile(rel, label, (s) => cutToEnd(s, marker));
}
/** from → to へ冪等に置換（どちらも無ければ失敗）。 */
function swapText(rel, label, from, to) {
	editFile(rel, label, (s) => swap(s, from, to));
}
/** apps/admin-template/package.json から workspace 依存 1 行を削除。 */
function removeAppDep(dep) {
	drop(APP_PKG, `dependency ${dep} を除去`, `    "${dep}": "workspace:*",\n`);
}

// --- パス定数 ---------------------------------------------------------------

const APP = 'apps/admin-template';
const APP_PKG = `${APP}/package.json`;
const DASH = `${APP}/src/routes/(app)/dashboard/+page.svelte`;
const DASH_LIB = `${APP}/src/lib/banto/dashboard.ts`;
const LAYOUT = `${APP}/src/routes/(app)/+layout.svelte`;
const HEADER = `${APP}/src/lib/components/Header.svelte`;
const SETTINGS = `${APP}/src/routes/(app)/settings/+page.svelte`;
const ITEMS = `${APP}/src/routes/(app)/items/+page.svelte`;
const ITEM_EDIT = `${APP}/src/routes/(app)/items/[id]/+page.svelte`;
const APP_CSS = `${APP}/src/app.css`;
const THEME_INDEX = 'packages/theme/src/index.ts';
const THEME_CSS = 'packages/theme/src/css/banto.css';
const VERIFY_ARCH = 'scripts/verify-architecture.mjs';
const REST_MOD = `${APP}/core/src/rest/mod.rs`;
const REST_ITEMS = `${APP}/core/src/rest/items.rs`;
const REST_TESTS = `${APP}/core/src/rest/tests.rs`;
const BANTO_SERVE = `${APP}/core/src/bin/banto-serve.rs`;
const LIB_RS = `${APP}/src-tauri/src/lib.rs`;
const WS_CARGO = 'Cargo.toml';
const CORE_CARGO = `${APP}/core/Cargo.toml`;
const TAURI_CARGO = `${APP}/src-tauri/Cargo.toml`;

// --- removers（README「3. オプション資産の削除」の 1 対 1 自動化） ----------

/**
 * `@banto/charts`（SVGチャート）。README ~270-275。
 * ダッシュボードのチャートデモ配線・DashboardPanel・@banto/charts 依存を外す。
 * `dashboard.ts` はスタットタイルが `computeStatTiles` を使うため残す（未使用の
 * 集計エクスポートはビルドを壊さない）。stat タイルの Sparkline のみ外す。
 *
 * ドリフト注意: dashboard/+page.svelte の チャート markup・見出し・派生を
 * 変えたら（特に #74 M24 で追加した StackedAreaChart/GanttChart セクション、
 * i18n キー化で可視文言が `m['...']()` になった箇所）このパターンも更新すること。
 * charts 除去後に dashboard/+page.svelte と dashboard.ts に `@banto/charts` 参照が
 * 一切残らないことが不変条件（残ると `Cannot find module '@banto/charts'` /
 * 未定義コンポーネント / 暗黙 any でチェックが赤くなる）。
 */
function removeCharts() {
	cutRegion(DASH, 'charts import 除去', `\timport {\n\t\tBarChart,`, `} from '@banto/charts';`);
	drop(
		DASH,
		'DashboardPanel import 除去',
		`\timport DashboardPanel from '$lib/components/DashboardPanel.svelte';\n`
	);
	// #74 M24: 積立エリア/ガントは dashboard.ts の集計に依存する。charts 除去後に
	// dashboard.ts から `@banto/charts`（GanttTask 型）参照が残らないよう、対応する
	// import・派生・markup をここで確実に外す。
	drop(DASH, 'M24 集計 import(categoryTrendByMonth)除去', `\t\tcategoryTrendByMonth,\n`);
	drop(DASH, 'M24 集計 import(inventorySchedule)除去', `\t\tinventorySchedule,\n`);
	drop(DASH, 'M24 型 import(MonthCategoryCount)除去', `\t\ttype MonthCategoryCount,\n`);
	drop(
		DASH,
		'M24 派生(categoryTrend/schedule)除去',
		`\t// M24 chart types (spec §6.1, roadmap.md M24): stacked area (積立エリア), Gantt.\n\tconst categoryTrend = $derived(categoryTrendByMonth(list.rows));\n\tconst schedule = $derived(inventorySchedule(list.rows));\n\n`
	);
	cutRegion(
		DASH,
		'formatGanttDate ヘルパ除去',
		`\t// UTC getters (not toLocaleDateString): the schedule's dates are UTC`,
		`\t};`
	);
	drop(
		DASH,
		'stat タイルの Sparkline 除去',
		`\t\t\t\t\t<Sparkline values={monthCounts.map((mc) => mc.count)} width={72} height={24} />\n`
	);
	cutRegion(DASH, 'チャートグリッド(トレンド系)除去', `\t\t<div class="chart-grid">`, `\t\t</div>`);
	drop(
		DASH,
		'チャート拡張見出し(v2)除去',
		`\t\t<h2 class="section-heading">{m['dashboard.chartsV2Heading']()}</h2>\n`
	);
	cutRegion(DASH, 'チャートグリッド(拡張)除去', `\t\t<div class="chart-grid">`, `\t\t</div>`);
	drop(
		DASH,
		'チャート拡張見出し(M24)除去',
		`\t\t<h2 class="section-heading">{m['dashboard.chartsM24Heading']()}</h2>\n`
	);
	cutRegion(DASH, 'チャートグリッド(M24)除去', `\t\t<div class="chart-grid">`, `\t\t</div>`);
	// dashboard.ts（stat タイル用に残すが M24 集計だけは `@banto/charts` の GanttTask に
	// 依存するので切り離す）。GanttTask import と M24 セクション（EOFまで）を外す。
	drop(
		DASH_LIB,
		'dashboard.ts: GanttTask import 除去',
		`import type { GanttTask } from '@banto/charts';\n`
	);
	cutEnd(DASH_LIB, 'dashboard.ts: M24 集計セクション(EOFまで)除去', `// --- M24 chart demo data`);
	removeFile(`${APP}/src/lib/components/DashboardPanel.svelte`, 'DashboardPanel.svelte 削除');
	removeAppDep('@banto/charts');
}

/**
 * `@banto/dock-svelte`（ダッシュボードのドッキング）。README ~263-268。
 * ダッシュボードの Dock 配線一式・panels.ts・popout.ts・@banto/dock-svelte 依存に
 * 加え、pop-out 先の `routes/panel/[id]`（panels.ts / DashboardPanel に依存）も削除。
 */
function removeDock() {
	cutRegion(DASH, 'dock import 除去', `\timport {\n\t\tDockHost,`, `} from '@banto/dock-svelte';`);
	swapText(DASH, 'lucide から LayoutGrid 除去', `LayoutGrid, JapaneseYen`, `JapaneseYen`);
	drop(DASH, 'panels import 除去', `\timport { PANEL_DEFS } from '$lib/banto/panels';\n`);
	drop(
		DASH,
		'setup(getUiSettings/isTauri) import 除去',
		`\timport { getUiSettings, isTauri } from '$lib/banto/setup';\n`
	);
	drop(
		DASH,
		'popout import 除去',
		`\timport { listenPanelClosed, openPanelWindow } from '$lib/banto/popout';\n`
	);
	cutRegion(
		DASH,
		'dock スクリプト一式除去',
		`\t/**\n\t * M8 dock demo (spec §5, @banto/dock-svelte):`,
		`\t\treturn listenPanelClosed((id) => dock.open(id));\n\t});`
	);
	cutRegion(
		DASH,
		'分析ワークスペース(dock)markup 除去',
		`\t\t<section class="workspace">`,
		`\t\t</section>`
	);
	cutRegion(
		DASH,
		'dockPanel snippet 除去',
		`{#snippet dockPanel(content: PanelContent)}`,
		`{/snippet}`
	);
	removeFile(`${APP}/src/lib/banto/panels.ts`, 'panels.ts 削除');
	removeFile(`${APP}/src/lib/banto/popout.ts`, 'popout.ts 削除');
	removeDir(`${APP}/src/routes/panel`, 'pop-out panel ルート削除');
	removeAppDep('@banto/dock-svelte');
}

/**
 * Glass テーマ + Windows vibrancy（M12）。README ~277-289。
 * banto-glass.css / ThemePreset の 'glass' / 設定画面のプリセット選択肢を外し、
 * 併せて本物のガラス感（Windows Acrylic）= vibrancy も外す。
 * src-tauri（lib.rs / Cargo）は本サンドボックスでは非コンパイル（コードレビュー担保）。
 */
function removeGlass() {
	// --- テーマパッケージ ---
	swapText(
		THEME_INDEX,
		"ThemePreset union から 'glass' 除去",
		`export type ThemePreset = 'standard' | 'glass';`,
		`export type ThemePreset = 'standard';`
	);
	swapText(
		THEME_INDEX,
		"isThemePreset から 'glass' 除去",
		`return value === 'standard' || value === 'glass';`,
		`return value === 'standard';`
	);
	drop(THEME_CSS, 'banto-glass.css の @import 除去', `@import './banto-glass.css';\n`);
	removeFile('packages/theme/src/css/banto-glass.css', 'banto-glass.css 削除');

	// --- 設定画面: プリセット選択肢 + vibrancy 配線 ---
	// ドリフト注意: i18n キー化で label が `m['settings.presetGlass']()` になった。
	// settings のプリセット選択肢 markup を変えたらこのパターンも更新すること
	// （残ると ThemePreset から 'glass' を外した後 `Type '"glass"' is not assignable
	// to type '"standard"'` でチェックが赤くなる）。
	drop(
		SETTINGS,
		'プリセット選択肢からガラス除去',
		`\t\t{ value: 'glass', label: m['settings.presetGlass']() }\n`
	);
	drop(
		SETTINGS,
		'vibrancy import 除去',
		`\timport { applyVibrancy, getVibrancyStatus, type VibrancyStatus } from '$lib/banto/vibrancy';\n`
	);
	drop(SETTINGS, 'Sparkles アイコン import 除去', `\t\tSparkles,\n`);
	cutRegion(
		SETTINGS,
		'vibrancy 状態/ロジック除去',
		`\t// --- M12: window vibrancy`,
		`\t\t\tapplyingVibrancy = false;\n\t\t}\n\t}`
	);
	cutRegion(
		SETTINGS,
		'ウィンドウ効果カード(markup)除去',
		`\t\t{#if tauri && isAdmin(sessionStore.role) && vibrancyStatus?.supported}`,
		`\t\t{/if}`
	);
	removeFile(`${APP}/src/lib/banto/vibrancy.ts`, 'vibrancy.ts 削除');
	// src-tauri（lib.rs / Cargo）は removeGlassSrcTauri() で別途実行（非コンパイル）。
}

/**
 * コマンドパレット（Ctrl+K、M16）。README ~290-297。
 * CommandPalette.svelte / commandPalette.svelte.ts / commands.ts を削除し、
 * (app)/+layout.svelte と Header.svelte からの参照を外す。
 */
function removeCommandPalette() {
	// layout: import・Ctrl+K・パレット描画
	drop(
		LAYOUT,
		'CommandPalette import 除去',
		`\timport CommandPalette from '$lib/components/CommandPalette.svelte';\n`
	);
	drop(
		LAYOUT,
		'commandPaletteStore import 除去',
		`\timport { commandPaletteStore } from '$lib/commandPalette.svelte';\n`
	);
	swapText(
		LAYOUT,
		'handleKeydown から Ctrl+K/パレット参照を除去',
		`\t\tif (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {\n\t\t\tevent.preventDefault();\n\t\t\tcommandPaletteStore.toggle();\n\t\t\treturn;\n\t\t}\n\t\tif (event.key === 'Escape' && overlayOpen && !commandPaletteStore.open) {\n\t\t\tcloseOverlay();\n\t\t}`,
		`\t\tif (event.key === 'Escape' && overlayOpen) {\n\t\t\tcloseOverlay();\n\t\t}`
	);
	drop(
		LAYOUT,
		'CommandPalette 描画除去',
		`{#if commandPaletteStore.open}\n\t<CommandPalette />\n{/if}\n\n`
	);

	// header: import・検索ピル/アイコンボタン
	drop(
		HEADER,
		'commandPaletteStore import 除去',
		`\timport { commandPaletteStore } from '$lib/commandPalette.svelte';\n`
	);
	swapText(
		HEADER,
		'lucide から Search 除去',
		`Menu as MenuIcon, Search, Settings`,
		`Menu as MenuIcon, Settings`
	);
	cutRegion(
		HEADER,
		'検索ピル/コマンドパレット起動ボタン除去',
		`\t<button type="button" class="search-pill" onclick={() => commandPaletteStore.show()}>`,
		`icon={Search}\n\t\t\tonclick={() => commandPaletteStore.show()}\n\t\t/>\n\t</div>`
	);

	removeFile(`${APP}/src/lib/components/CommandPalette.svelte`, 'CommandPalette.svelte 削除');
	removeFile(`${APP}/src/lib/commandPalette.svelte.ts`, 'commandPalette.svelte.ts 削除');
	removeFile(`${APP}/src/lib/commands.ts`, 'commands.ts 削除');
}

/**
 * 添付ファイル（`@banto/attachments` + items 添付デモ、M20）。README ~298-321。
 * README の 6 ステップ順（依存の少ない順）で外す。src-tauri（lib.rs / Cargo）は
 * 非コンパイル・コードレビュー担保。rest/tests.rs（`cargo test` 対象）も併せて
 * 更新し、全プリセットで `cargo test` が緑になるようにする。
 */
function removeAttachments() {
	// (1) フロント: items/[id] の AttachmentsPanel 配線 + 関連 import
	drop(
		ITEM_EDIT,
		'AttachmentsPanel import 除去',
		`\timport { AttachmentsPanel } from '@banto/attachments';\n`
	);
	drop(
		ITEM_EDIT,
		'isAttachmentsAvailable import 除去',
		`\timport { isAttachmentsAvailable } from '$lib/banto/attachmentsAdmin';\n`
	);
	drop(
		ITEM_EDIT,
		'attachmentsClient import 除去',
		`\timport { attachmentsClient } from '$lib/banto/attachmentsClient';\n`
	);
	cutRegion(
		ITEM_EDIT,
		'AttachmentsPanel markup 除去',
		`\t<!--\n\t\tM20 demo wiring`,
		`\t\t/>\n\t{/if}`
	);

	// (2) フロント: アプリ側クライアント/アダプタ
	removeFile(`${APP}/src/lib/banto/attachmentsClient.ts`, 'attachmentsClient.ts 削除');
	removeFile(`${APP}/src/lib/banto/attachmentsAdmin.ts`, 'attachmentsAdmin.ts 削除');

	// (3) バックエンド: REST ルータ + items からの delete_for_record / 依存
	//   rest/mod.rs
	cutRegion(
		REST_MOD,
		'rest: Route table の attachments 行除去（doc）',
		'//! | POST   | `/api/attachments/list`',
		'//! | DELETE | `/api/attachments/{id}` | -              | 204 (editor+)           |'
	);
	drop(
		REST_MOD,
		'rest: banto_attachments use 除去',
		`use banto_attachments::{AttachmentMeta, AttachmentsService, NewAttachment, MAX_ATTACHMENT_BYTES};\n`
	);
	drop(REST_MOD, 'rest: mod attachments 除去', `mod attachments;\n`);
	drop(REST_MOD, 'rest: use attachments_router 除去', `use attachments::attachments_router;\n`);
	cutRegion(
		REST_MOD,
		'rest: ATTACHMENT_BODY_LIMIT_SLACK_BYTES 除去',
		'/// Slack added on top of `banto_attachments::MAX_ATTACHMENT_BYTES` for',
		'const ATTACHMENT_BODY_LIMIT_SLACK_BYTES: usize = 1024 * 1024;'
	);
	drop(
		REST_MOD,
		'rest: api_router の attachments 引数除去',
		`    attachments: AttachmentsService,\n`
	);
	drop(
		REST_MOD,
		'rest: items_router への attachments 引数除去',
		`            attachments.clone(),\n`
	);
	drop(
		REST_MOD,
		'rest: attachments_router の合流除去',
		`        .merge(attachments_router(attachments, audit, auth.clone(), events))\n`
	);
	//   rest/items.rs（ItemsWriteState.attachments / 両 fn の引数 / delete_for_record）
	drop(
		REST_ITEMS,
		'rest/items: attachments フィールド/引数除去',
		`    attachments: AttachmentsService,\n`
	);
	drop(REST_ITEMS, 'rest/items: attachments 実引数除去', `        attachments,\n`);
	cutRegion(
		REST_ITEMS,
		'rest/items: items_delete の delete_for_record 除去',
		`    // M20 unit C demo wiring (attachments-plan §3.8): sweep up any attachments left`,
		`        (attachments_removed > 0).then(|| json!({ "attachmentsRemoved": attachments_removed }));`
	);
	swapText(
		REST_ITEMS,
		'rest/items: items_delete の detail を None に',
		`        Some(&id.to_string()),\n        detail,\n    )`,
		`        Some(&id.to_string()),\n        None,\n    )`
	);
	//   rest/tests.rs（cargo test 対象。api_router の attachments 引数除去に追随）
	removeAttachmentsFromRestTests();
	//   banto-serve.rs（AttachmentsService の構築 + api_router 実引数）
	drop(
		BANTO_SERVE,
		'banto-serve: AttachmentsService use 除去',
		`use banto_attachments::AttachmentsService;\n`
	);
	cutRegion(
		BANTO_SERVE,
		'banto-serve: AttachmentsService 構築除去',
		`    // M20 attachments (spec docs/attachments-plan.md §3.3): base_dir is the`,
		`    let attachments = AttachmentsService::new(db.clone(), attachments_base_dir);`
	);
	drop(
		BANTO_SERVE,
		'banto-serve: api_router の attachments 実引数除去',
		`            attachments,\n`
	);

	// (4) 依存: @banto/attachments + crates/banto-attachments を workspace から外す
	removeAppDep('@banto/attachments');
	drop(
		WS_CARGO,
		'workspace: members から banto-attachments 除去',
		`  "crates/banto-attachments",\n`
	);
	drop(
		WS_CARGO,
		'workspace: dependencies から banto-attachments 除去',
		`banto-attachments = { path = "crates/banto-attachments" }\n`
	);
	cutRegion(
		CORE_CARGO,
		'core: banto-attachments 依存除去',
		'# M20 attachments (spec docs/attachments-plan.md §3.1, unit B): `rest.rs`',
		'banto-attachments = { workspace = true }'
	);
	// postgres feature（V2 PR2）は banto-attachments/postgres を含む。依存を外した
	// 以上この参照も消さないと `feature includes banto-attachments/postgres, but
	// banto-attachments is not a dependency` で cargo が manifest 解析に失敗する。
	drop(
		CORE_CARGO,
		'core: postgres feature の banto-attachments 参照除去',
		`  "banto-attachments/postgres",\n`
	);
	cutRegion(
		TAURI_CARGO,
		'src-tauri: banto-attachments 依存除去',
		'# M20 attachments (spec docs/attachments-plan.md §3.1, unit B): `AppState`',
		'banto-attachments = { workspace = true }'
	);
	removeDir('crates/banto-attachments', 'crates/banto-attachments 削除');

	// (5) マイグレーション（他テーブルから参照されないため単独で外せる）。
	//     V2 で SQLite/Postgres の2系統に分かれたため両方から削除する。
	removeFile(
		`${APP}/core/migrations-sqlite/0006_attachments.sql`,
		'migrations-sqlite/0006_attachments.sql 削除'
	);
	removeFile(
		`${APP}/core/migrations-postgres/0006_attachments.sql`,
		'migrations-postgres/0006_attachments.sql 削除'
	);

	// (6) アーキテクチャ検査（pnpm verify:architecture）の attachments 参照を外す。
	//     rule 8 の DUAL_PATH/REST_READ/TAURI_READ/DESKTOP_ONLY と rule 9 の
	//     NewAttachment 検査（削除済みクレートを read するとクラッシュ）を除去。
	removeAttachmentsFromVerifyArch();

	// src-tauri lib.rs（非コンパイル・コードレビュー担保）
	removeAttachmentsFromLibRs();
}

/**
 * rest/tests.rs（`admin-template-core` の `cargo test` 対象）から attachments を外す。
 * `api_router` から attachments 引数が消えるのに追随しないと、削除済みクレート
 * `banto_attachments` を参照するテストがコンパイルできず `cargo test` が赤くなる。
 * 除去箇所は次のとおり（M20 ブロックは crate ごと消えるので丸ごと・他は false positive）:
 *   (a) 末尾の M20 attachments テストブロック（独自の実サービス+tempdir）を EOF まで。
 *   (b) `unused_attachments_service` ヘルパ + doc コメント。
 *   (c) 各ルータビルダの `unused_attachments_service(...)` 宣言（6箇所）。
 *   (d) backup ヘルパ（M17 テストで生存）の実 `AttachmentsService::new(...)` 宣言。
 *   (e) `api_router(...)` 実引数の `attachments,`（backup, と system_info, の間・両インデント）。
 * `PathBuf` import は `unused_backup_service` が使うため残す。
 */
function removeAttachmentsFromRestTests() {
	// (a) M20 テストブロックを丸ごと EOF まで削除（他の attachments, 参照より先に消す
	//     ことで、残る api_router 実引数がビルダの分だけになる）。
	cutEnd(
		REST_TESTS,
		'rest/tests: M20 attachments テストブロック（EOFまで）除去',
		'// --- M20: attachments'
	);
	// (b) unused_attachments_service ヘルパ + doc コメント（直前の空行ごと）を除去。
	drop(
		REST_TESTS,
		'rest/tests: unused_attachments_service ヘルパ除去',
		`\n/// An \`AttachmentsService\` for router helpers that never exercise\n/// \`/api/attachments/*\` - same "never actually written to" reasoning as\n/// [\`unused_backup_service\`]. Tests that DO exercise attachments use\n/// [\`router_with_role_tokens_and_attachments\`] instead, which points at\n/// a real, writable temp directory.\nfn unused_attachments_service(db: banto_storage::Db) -> AttachmentsService {\n    AttachmentsService::new(db, PathBuf::from("unused-in-tests").join("attachments"))\n}\n`
	);
	// (c) ビルダの unused_attachments_service 宣言（6箇所を dropBlock が一括除去）。
	drop(
		REST_TESTS,
		'rest/tests: unused_attachments_service 宣言除去',
		`    let attachments = unused_attachments_service(pool.clone());\n`
	);
	// (d) backup ヘルパの実 AttachmentsService 宣言（M17 テストで生き残るヘルパ内）。
	drop(
		REST_TESTS,
		'rest/tests: backup ヘルパの実 attachments 宣言除去',
		`    let attachments = AttachmentsService::new(db.clone(), dir.path().join("attachments"));\n`
	);
	// (e) api_router(...) 実引数の attachments を除去（backup, と system_info, の間・
	//     両インデント。system_info はコア機能なので残す＝アンカーに使う。swap は
	//     全出現を置換するので 12/8 スペースそれぞれ 1 回で足りる）。
	swapText(
		REST_TESTS,
		'rest/tests: api_router 実引数(attachments)除去（12スペース）',
		`            backup,\n            attachments,\n            system_info,`,
		`            backup,\n            system_info,`
	);
	swapText(
		REST_TESTS,
		'rest/tests: api_router 実引数(attachments)除去（8スペース）',
		`        backup,\n        attachments,\n        system_info,`,
		`        backup,\n        system_info,`
	);
}

/**
 * 帳票デモ（`@banto/report` + 日報デモ、M19）。README ~320-353。
 * DB/バックエンド配線を持たない最小デモなので、items ページの日報ボタン・
 * ルート/ライブラリ・@banto/report 依存 + print CSS だけで外せる。
 */
function removeReport() {
	swapText(
		ITEMS,
		'lucide から FileText 除去',
		`import { Download, FileText, Plus, Upload } from '@lucide/svelte';`,
		`import { Download, Plus, Upload } from '@lucide/svelte';`
	);
	cutRegion(
		ITEMS,
		'items ページの日報ボタン除去',
		`\t\t\t<!-- M19 report demo`,
		`\t\t\t\t{m['items.report']()}\n\t\t\t</button>`
	);
	removeDir(`${APP}/src/routes/(app)/items/report`, 'items/report ルート削除');
	removeDir(`${APP}/src/lib/banto/reports`, 'lib/banto/reports 削除');
	drop(
		APP_CSS,
		'app.css: @banto/report/print.css の @import 除去',
		`@import '@banto/report/print.css';\n`
	);
	cutRegion(
		APP_CSS,
		'app.css: 帳票用 @media print ブロック除去',
		`@media print {\n\tbody.banto-report-active`,
		`\tbody.banto-report-active .shell main {\n\t\tpadding: 0;\n\t}\n}`
	);
	removeAppDep('@banto/report');
}

// --- verify-architecture.mjs helper -----------------------------------------

function removeAttachmentsFromVerifyArch() {
	// rule 1: サービス層検査の対象ディレクトリ（削除済みでも walk は無害だが明示的に外す）
	drop(
		VERIFY_ARCH,
		'verify: 対象ディレクトリから banto-attachments/src 除去',
		`\t\t'crates/banto-attachments/src',\n`
	);
	// rule 8: 両経路対称マニフェストの attachments エントリ
	drop(
		VERIFY_ARCH,
		'verify: DUAL_PATH の attachments_upload 除去',
		`\t\t{ tauri: 'attachments_upload', rest: 'POST /api/attachments', role: 'Editor' },\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: DUAL_PATH の attachments_delete 除去',
		`\t\t{ tauri: 'attachments_delete', rest: 'DELETE /api/attachments/{id}', role: 'Editor' }\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: DESKTOP_ONLY の attachments_open_folder 除去',
		`\t\t'attachments_open_folder',\n`
	);
	drop(VERIFY_ARCH, 'verify: TAURI_READ の attachments_list 除去', `\t\t'attachments_list',\n`);
	drop(
		VERIFY_ARCH,
		'verify: TAURI_READ の attachments_read_body 除去',
		`\t\t'attachments_read_body',\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: TAURI_READ の attachments_read_thumbnail 除去',
		`\t\t'attachments_read_thumbnail',\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: REST_READ の attachments download 除去',
		`\t\t'GET /api/attachments/{id}/download',\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: REST_READ の attachments thumbnail 除去',
		`\t\t'GET /api/attachments/{id}/thumbnail',\n`
	);
	drop(
		VERIFY_ARCH,
		'verify: REST_READ の attachments list 除去',
		`\t\t'POST /api/attachments/list'\n`
	);
	// rule 9: NewAttachment の mime 検査（削除済みクレートを read するのでブロックごと外す）
	cutRegion(
		VERIFY_ARCH,
		'verify: rule9 の NewAttachment mime 検査除去',
		'\t// A) `NewAttachment` は mime フィールドを持たない。',
		"'NewAttachment に mime フィールド — クライアント申告 MIME は受け取らない（§6、判定は detect_mime のマジックバイトのみ）'\n\t\t);"
	);
}

// --- src-tauri lib.rs helpers（非コンパイル・コードレビュー担保） -----------

function removeAttachmentsFromLibRs() {
	drop(
		LIB_RS,
		'lib.rs: banto_attachments use 除去',
		`use banto_attachments::{AttachmentMeta, AttachmentsService, NewAttachment};\n`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: AppState の attachments/attachments_dir フィールド除去',
		`    /// File/image attachments (spec \`docs/attachments-plan.md\` §3, M20 unit`,
		`    attachments_dir: PathBuf,`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: items_delete の delete_for_record 除去',
		`    // M20 unit C demo wiring (spec docs/attachments-plan.md §3.8): sweep up`,
		`        .then(|| serde_json::json!({ "attachmentsRemoved": attachments_removed }));`
	);
	swapText(
		LIB_RS,
		'lib.rs: items_delete の detail を None に',
		`            entity_id: Some(&id.to_string()),\n            detail,\n            origin: "tauri",`,
		`            entity_id: Some(&id.to_string()),\n            detail: None,\n            origin: "tauri",`
	);
	drop(
		LIB_RS,
		'lib.rs: start_embedded_server の attachments 引数除去',
		`    attachments: AttachmentsService,\n`
	);
	// api_router 呼び出しの attachments 実引数（12スペースの裸 `attachments,`）。
	// 16スペースの AppState リテラル行の部分文字列にならないよう前後行込みで指定する
	// （backup, と、コアなので残る system_info, の間）。
	swapText(
		LIB_RS,
		'lib.rs: api_router 実引数(attachments)除去',
		`            backup,\n            attachments,\n            system_info,`,
		`            backup,\n            system_info,`
	);
	drop(
		LIB_RS,
		'lib.rs: server_apply の attachments 実引数除去',
		`                state.attachments.clone(),\n`
	);
	drop(
		LIB_RS,
		'lib.rs: setup の attachments 実引数除去',
		`                    attachments.clone(),\n`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: AppState 構築の attachments 除去',
		`            // M20 attachments (spec docs/attachments-plan.md §3.3): same`,
		`            let attachments = AttachmentsService::new(db.clone(), attachments_dir.clone());`
	);
	drop(
		LIB_RS,
		'lib.rs: AppState 構築リテラルの attachments/attachments_dir 除去',
		`                attachments,\n                attachments_dir,\n`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: attachments コマンド一式除去',
		`// --- M20: attachments --------------------------------------------------------`,
		`    #[cfg(not(target_os = "windows"))]\n    {\n        Ok(OpenFolderResult {\n            opened: false,\n            path,\n        })\n    }\n}`
	);
	drop(
		LIB_RS,
		'lib.rs: invoke_handler の attachments コマンド登録除去',
		`            attachments_list,\n            attachments_read_thumbnail,\n            attachments_read_body,\n            attachments_upload,\n            attachments_delete,\n            attachments_open_folder,\n`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: test app_state の attachments 除去',
		`            attachments: AttachmentsService::new(\n                pool,`,
		`            attachments_dir: PathBuf::from("unused-in-tests").join("attachments"),`
	);
	drop(
		LIB_RS,
		'lib.rs: test app_state_with_tempdir の attachments 除去',
		`            attachments: AttachmentsService::new(pool, dir.path().join("attachments")),\n            attachments_dir: dir.path().join("attachments"),\n`
	);
}

function removeVibrancyFromLibRs() {
	cutRegion(
		LIB_RS,
		'lib.rs: vibrancy 型/ヘルパ/コマンド除去',
		`/// Settings key for the desktop vibrancy toggle (spec M12): a GLOBAL`,
		`    Ok(VibrancyStatus { enabled, supported })\n}`
	);
	cutRegion(
		LIB_RS,
		'lib.rs: 起動時の vibrancy 再適用除去',
		`            // M12: re-apply the persisted vibrancy (Windows Acrylic) choice`,
		`                            "banto: メインウィンドウが見つからないため、起動時のAcrylic効果の適用をスキップしました"\n                        ),\n                    }\n                }\n            }`
	);
	drop(
		LIB_RS,
		'lib.rs: invoke_handler の vibrancy コマンド登録除去',
		`            vibrancy_apply,\n            vibrancy_status,\n`
	);
}

function removeWindowVibrancyDeps() {
	cutRegion(
		WS_CARGO,
		'workspace: window-vibrancy 依存除去',
		'# Desktop-only (spec M12 Glass theme): real window translucency (Windows',
		'window-vibrancy = "0.8"'
	);
	cutRegion(
		TAURI_CARGO,
		'src-tauri: window-vibrancy 依存除去',
		'# Real window translucency for the glass theme (spec M12): Windows Acrylic',
		'window-vibrancy = { workspace = true }'
	);
}

// removeGlass の src-tauri 部分を差し込む（上の関数定義後に本体を確定）。
function removeGlassSrcTauri() {
	removeVibrancyFromLibRs();
	removeWindowVibrancyDeps();
}

// --- tree（ツリービュー・デモ、M-review 2026-08）----------------------------
//
// README「オプション資産の削除」の「ツリーデモ」手順 1〜4 の 1 対 1 自動化。
// DB/バックエンド配線を持たない最小デモなので、フロントのみで完結する。
// packages/tree-svelte 本体は同梱のまま（他 remover と同方針: パッケージは
// 残しても他に影響しない）。

function removeTree() {
	const NAV = `${APP}/src/lib/navigation.ts`;
	const NAV_ICONS = `${APP}/src/lib/components/navIcons.ts`;
	const I18N = `${APP}/src/lib/banto/i18n.ts`;

	// (1) デモルートとサンプルデータ
	removeDir(`${APP}/src/routes/(app)/tree`, 'tree デモルート削除');
	removeFile(`${APP}/src/lib/banto/treeSample.ts`, 'treeSample.ts 削除');

	// (2) ナビゲーション（union とアイコンマップは型で連結しているため対で外す）
	swapText(
		NAV,
		'nav: NavIconKey union から tree 除去',
		`'dashboard' | 'items' | 'tree' | 'users'`,
		`'dashboard' | 'items' | 'users'`
	);
	swapText(
		NAV,
		'nav: NavLabelKey union から nav.tree 除去',
		`'nav.dashboard' | 'nav.items' | 'nav.tree' | 'nav.users'`,
		`'nav.dashboard' | 'nav.items' | 'nav.users'`
	);
	drop(
		NAV,
		'nav: navItems の /tree 行除去',
		`\t{ path: '/tree', labelKey: 'nav.tree', icon: 'tree' },\n`
	);
	swapText(
		NAV_ICONS,
		'navIcons: ListTree import 除去',
		`import { LayoutDashboard, Package, ListTree, Users, ScrollText, Settings } from '@lucide/svelte';`,
		`import { LayoutDashboard, Package, Users, ScrollText, Settings } from '@lucide/svelte';`
	);
	drop(NAV_ICONS, 'navIcons: tree エントリ除去', `\ttree: ListTree,\n`);

	// (3) i18n ブリッジ（treeMessages はファイル末尾の章なので EOF まで削除）と文言キー
	drop(
		I18N,
		'i18n: TreeMessages import 除去',
		`import type { TreeMessages } from '@banto/tree-svelte';\n`
	);
	cutEnd(I18N, 'i18n: treeMessages() 除去', '/**\n * `@banto/tree-svelte` `messages` prop:');
	cutRegion(
		`${APP}/messages/ja.json`,
		'messages/ja: nav.tree + tree.* キー除去',
		`,\n  "nav.tree": "ツリービュー"`,
		`"tree.demo.none": "（なし）"`
	);
	cutRegion(
		`${APP}/messages/en.json`,
		'messages/en: nav.tree + tree.* キー除去',
		`,\n  "nav.tree": "Tree view"`,
		`"tree.demo.none": "(none)"`
	);

	// (4) 依存
	removeAppDep('@banto/tree-svelte');
}

// --- 実行 -------------------------------------------------------------------

const REMOVERS = {
	charts: removeCharts,
	dock: removeDock,
	glass: () => {
		removeGlass();
		removeGlassSrcTauri();
	},
	commandPalette: removeCommandPalette,
	attachments: removeAttachments,
	report: removeReport,
	tree: removeTree
};

// README の資産並び順で実行（remover 間はテキスト領域が独立なので順序非依存だが、
// ドキュメントの記述順に合わせる）。
const ORDER = ['charts', 'dock', 'glass', 'commandPalette', 'attachments', 'report', 'tree'];

// --- 対話モード（--interactive/-i）-----------------------------------------
//
// ここで作るのは `toRemove`（削除する資産の Set）だけ。それ以降は --preset と
// 完全に同じ削除ループ・report・次のステップ表示を共有する（plan §7.3 の
// 「対話は入力を作るだけ、削除ロジックは単一」という要件）。

const PRESET_DESCRIPTIONS = {
	minimal: 'コアのみ（charts/dock/Glass/コマンドパレット/添付/帳票/ツリーを全削除）',
	standard: 'dock+charts+パレット+Glass 同梱（添付・帳票・ツリーを削除）',
	full: '全オプション同梱（何も削除しない）'
};

/**
 * readline インターフェースを 1 行ずつ読む `ask()` を作る。
 *
 * 注意: `rl.question()`（readline/promises 標準 API）は使わない。pipe された
 * 非 TTY stdin では「複数行が 1 チャンクで届く」→ readline が 'line' イベントを
 * 同期的に連続発火 → 2 問目以降の `question()` がリスナー登録前に流れた
 * 'line' を取りこぼして**永久に停止する**、という既知の挙動があるため
 * （このスクリプトの手動検証で再現・確認済み）。async イテレータ
 * （`rl[Symbol.asyncIterator]()`）はキューイングされるためこの問題が無く、
 * TTY・pipe どちらでも同じコードで安全に動く。モジュールは引き続き
 * `node:readline/promises` のみ（新規依存なし、conventions §3）。
 * 入力が尽きた（EOF）場合は `null` を返す。
 */
function makeAsk(rl) {
	const lines = rl[Symbol.asyncIterator]();
	return async function ask(query) {
		process.stdout.write(query);
		const { value, done } = await lines.next();
		return done ? null : value;
	};
}

/** EOF（入力が尽きた）を明示的な失敗として扱う。 */
function failOnEof(value) {
	if (value === null)
		fail('対話入力が途中で終了しました（EOF）。パイプ入力の行数を確認してください');
	return value;
}

async function promptPreset(ask) {
	console.log(
		'どのプリセットを適用しますか？\n' +
			`  1) minimal  … ${PRESET_DESCRIPTIONS.minimal}\n` +
			`  2) standard … ${PRESET_DESCRIPTIONS.standard}\n` +
			`  3) full     … ${PRESET_DESCRIPTIONS.full}\n` +
			'  4) custom   … 資産を個別に選ぶ'
	);
	const byNumber = { 1: 'minimal', 2: 'standard', 3: 'full', 4: 'custom' };
	const byName = new Set(['minimal', 'standard', 'full', 'custom']);
	for (;;) {
		const answer = failOnEof(await ask('番号または名前を入力してください [1-4]: ')).trim();
		if (byNumber[answer]) return byNumber[answer];
		if (byName.has(answer)) return answer;
		console.log(`入力が正しくありません: ${answer}`);
	}
}

/** [Y/n]（デフォルト Yes）を読む。空入力/y/yes は true、n/no は false。 */
async function promptYesDefaultYes(ask, question) {
	for (;;) {
		const answer = failOnEof(await ask(`${question} [Y/n]: `))
			.trim()
			.toLowerCase();
		if (answer === '' || answer === 'y' || answer === 'yes') return true;
		if (answer === 'n' || answer === 'no') return false;
		console.log(`入力が正しくありません: ${answer}`);
	}
}

/** [y/N]（デフォルト No）を読む。空入力/n/no は false、y/yes は true。 */
async function promptYesDefaultNo(ask, question) {
	for (;;) {
		const answer = failOnEof(await ask(`${question} [y/N]: `))
			.trim()
			.toLowerCase();
		if (answer === '' || answer === 'n' || answer === 'no') return false;
		if (answer === 'y' || answer === 'yes') return true;
		console.log(`入力が正しくありません: ${answer}`);
	}
}

async function promptCustomToRemove(ask) {
	const toRemove = new Set();
	console.log('資産ごとに残す/削除を選んでください（Enter で既定＝残す）:');
	for (const asset of ORDER) {
		const keep = await promptYesDefaultYes(ask, `  ${asset} を残しますか?`);
		if (!keep) toRemove.add(asset);
	}
	return toRemove;
}

/**
 * 対話フロー全体（プリセット選択 → 必要なら custom → 確認）を一つの
 * readline インターフェースで進める。pipe された stdin でも取りこぼしが
 * 起きないよう、途中で `createInterface` を作り直さない（`makeAsk` 参照）。
 * `--dry-run` のときは確認を省き、そのまま toRemove を返す（既存の
 * dry-run 経路＝変更を書かない、をそのまま通す）。
 */
async function resolveInteractive() {
	if (!process.stdin.isTTY) {
		// pipe された stdin でも行単位で読めるのでそのまま動くが、TTY が無い
		// 環境（CI 等）では対話の意図が伝わりにくいので一言添える。
		console.log(
			'（標準入力がターミナルではありません。パイプ入力で対話に応答します。\n' +
				'  自動化する場合は --preset を使ってください。）'
		);
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = makeAsk(rl);
	try {
		const choice = await promptPreset(ask);
		const toRemove =
			choice === 'custom' ? await promptCustomToRemove(ask) : new Set(PRESETS[choice]);

		console.log(
			toRemove.size === 0
				? '削除する資産: なし（full 相当。検証のみ）'
				: `削除する資産: ${ORDER.filter((a) => toRemove.has(a)).join(', ')}`
		);

		if (args.dryRun) return toRemove;

		const confirmed = await promptYesDefaultNo(ask, '適用しますか?');
		if (!confirmed) {
			console.log('中止しました（変更はありません）。');
			process.exit(0);
		}
		return toRemove;
	} finally {
		rl.close();
	}
}

async function main() {
	const toRemove = args.preset ? new Set(PRESETS[args.preset]) : await resolveInteractive();

	console.log(
		`${args.preset ? `プリセット '${args.preset}' を適用` : '選択した内容を適用'}${args.dryRun ? '（--dry-run: 変更しません）' : ''}\n` +
			(toRemove.size === 0
				? '  （full: 削除する資産はありません。検証のみ）\n'
				: `  削除する資産: ${ORDER.filter((a) => toRemove.has(a)).join(', ')}\n`)
	);

	for (const asset of ORDER) {
		if (!toRemove.has(asset)) continue;
		console.log(`# ${asset}`);
		REMOVERS[asset]();
	}

	if (editor.report(args.dryRun ? '\n--dry-run: 以下を適用します\n' : '\n適用しました\n')) {
		process.exit(1);
	}

	console.log(`
次のステップ:
  1. pnpm install（削除した依存の反映）
  2. 検証: pnpm --filter admin-template check / build / cargo check
  ${toRemove.size === 0 ? '' : '3. 削除で不活性になった未使用 CSS セレクタ等は警告として残ることがあります（ビルドは緑）。\n  '}注: src-tauri（lib.rs / Cargo）はこのサンドボックスではコンパイルできないため、
  そのコード整合はコードレビューで担保します（docs/conventions.md）。attachments の
  除去は apps/admin-template/core/src/rest/tests.rs にも及ぶため、全プリセットで
  \`cargo test -p admin-template-core\` は緑を維持します。`);
}

await main();
