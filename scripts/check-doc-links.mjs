#!/usr/bin/env node
/**
 * Markdown の相対リンクの実在を確かめる（docs だけの PR の軽い検査にも使う）。
 * 依存を足さない（Node 標準のみ、conventions §3）。
 *
 * 対象: `git ls-files '*.md'` のうち、帳票の DSL（apps/admin-template/src/lib/banto/reports/*.md。
 * アプリが `?raw` で import する）を除いたもの。
 * 拾うもの: `[x](target)`・`![x](target)`・参照定義 `[x]: target`。コードフェンスと
 * インラインコードの中は見ない。http: / https: / mailto: / `#` だけは飛ばす。
 * `#anchor` と末尾の `:行番号` は外してパスだけを見る。先頭が `/` ならリポジトリの
 * ルートから、それ以外はファイルのある場所から辿る。
 *
 * 派生アプリ（scaffold 後）では、scaffold が全プリセットで消す banto 本体専用の path
 * （`scaffold.mjs --list-banto-only`。fixtures/external-consumer 等）が全部無い。その
 * path を指すリンクは壊れている扱いにしない（一覧は scaffold が持つ唯一のもの）。
 *
 * 実行: `node scripts/check-doc-links.mjs`（壊れていれば exit 1）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 検査しない Markdown（帳票の DSL）。 */
export const EXCLUDED_MD = /^apps\/admin-template\/src\/lib\/banto\/reports\/[^/]+\.md$/;

/**
 * 意図的に実在しない target の許可リスト。キーは「リポジトリのルートからの path」
 * （解決後）、値は理由。
 */
export const ALLOWLIST = new Map([
	// 例: ['docs/STATUS.md', 'git で追跡しない引き継ぎメモへの言及']
	// 以下は CHANGELOG・docs/history の「当時の記録」が指す、今は無い文書・移動したファイル。
	// 記録は書き換えないので、リンク先の側を許可する。
	['docs/session-controller-design.md', 'CHANGELOG の過去の版の記述。削除済みの文書'],
	['docs/choiapp-feedback-2026-09.md', 'CHANGELOG の過去の版の記述。削除済みの文書'],
	['docs/display-preset-plan.md', 'CHANGELOG の過去の版の記述。削除済みの文書'],
	['docs/viewer-public-plan.md', 'CHANGELOG の過去の版の記述。削除済みの文書'],
	['docs/maintenance-review-2026-08.md', 'CHANGELOG の過去の版の記述。削除済みの文書'],
	['docs/feature-review-2026-08.md', 'CHANGELOG の過去の版の記述。削除済みの文書'],
	['docs/maintainability-review-2026-07.md', 'CHANGELOG の過去の版の記述。削除済みの文書'],
	['docs/scaffold-presets-plan.md', 'CHANGELOG の過去の版の記述。削除済みの文書'],
	['crates/banto-server/src/auth.rs', 'docs/history の当時の記録。今は routes/auth.rs へ移動済み']
]);

/** コードフェンスの中の行は空にし、インラインコードは空白に置き換える（行番号を保つ）。 */
export function stripCode(text) {
	let fence = null;
	return text.split(/\r?\n/).map((line) => {
		const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^\s*[`~]+\s*$/.test(line)) {
				fence = null;
			}
			return '';
		}
		if (m) {
			fence = m[1];
			return '';
		}
		return line.replace(/(`+)[^`]*?\1/g, (s) => ' '.repeat(s.length));
	});
}

/** 1 行の中のリンク target を取り出す。 */
export function extractTargets(line) {
	const targets = [];
	const inline = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
	for (const m of line.matchAll(inline)) targets.push(m[1]);
	const def = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
	if (def) targets.push(def[1]);
	return targets.map((t) => (t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t));
}

/** target を実ファイルを指す path に正規化する。確かめる対象でなければ null。 */
export function normalizeTarget(raw) {
	let t = raw.trim();
	if (!t || t.startsWith('#')) return null;
	if (/^(https?:|mailto:)/i.test(t)) return null;
	t = t.replace(/[#?].*$/, '');
	t = t.replace(/:\d+(?::\d+)?$/, '');
	if (!t) return null;
	try {
		t = decodeURIComponent(t);
	} catch {
		// 不正なエスケープはそのまま見る（実在しなければ報告される）
	}
	return t;
}

/** 解決後の path（ルート相対、/ 区切り）。 */
export function resolveTarget(fromFile, target) {
	const abs = target.startsWith('/')
		? path.join(ROOT, target)
		: path.resolve(ROOT, path.dirname(fromFile), target);
	return path.relative(ROOT, abs).split(path.sep).join('/');
}

/** scaffold が消す banto 本体専用の path（ルート相対）。 */
export function listBantoOnly() {
	const res = spawnSync(
		process.execPath,
		[path.join(ROOT, 'scripts/scaffold.mjs'), '--list-banto-only'],
		{
			cwd: ROOT,
			encoding: 'utf8'
		}
	);
	if (res.status !== 0)
		throw new Error(`scaffold --list-banto-only が失敗しました:\n${res.stderr}`);
	return res.stdout.split(/\r?\n/).filter(Boolean);
}

/** resolved が、消えた banto 本体専用の path（またはその下）か。 */
function isRemovedBantoOnly(resolved, bantoOnly) {
	return bantoOnly.some((p) => resolved === p || resolved.startsWith(`${p}/`));
}

export function findBrokenLinks(
	files,
	{ exists = (p) => fs.existsSync(path.join(ROOT, p)), read, bantoOnly = [] } = {}
) {
	// 一覧の path が 1 つでも在れば banto 本体（そこで消えていたら本当のリンク切れ）。
	const derived = bantoOnly.length > 0 && bantoOnly.every((p) => !exists(p));
	const broken = [];
	for (const file of files) {
		if (EXCLUDED_MD.test(file)) continue;
		const text = read ? read(file) : fs.readFileSync(path.join(ROOT, file), 'utf8');
		stripCode(text).forEach((line, i) => {
			for (const raw of extractTargets(line)) {
				const t = normalizeTarget(raw);
				if (t === null) continue;
				const resolved = resolveTarget(file, t);
				if (resolved.startsWith('..')) {
					broken.push({ file, line: i + 1, target: raw });
					continue;
				}
				if (ALLOWLIST.has(resolved) || exists(resolved)) continue;
				if (derived && isRemovedBantoOnly(resolved, bantoOnly)) continue;
				broken.push({ file, line: i + 1, target: raw });
			}
		});
	}
	return broken;
}

/** git の追跡している Markdown。-z: 既定では日本語などのファイル名がクォートされるので NUL 区切りで読む。 */
export function listMarkdownFiles(cwd = ROOT) {
	return execFileSync('git', ['ls-files', '-z', '*.md'], { cwd, encoding: 'utf8' })
		.split('\0')
		.filter(Boolean);
}

function main() {
	const files = listMarkdownFiles();
	const broken = findBrokenLinks(files, { bantoOnly: listBantoOnly() });
	if (broken.length === 0) {
		console.log(`[check-doc-links] OK: ${files.length} ファイルのリンクを確かめた。`);
		return;
	}
	for (const b of broken) console.error(`${b.file}:${b.line}  リンク切れ: ${b.target}`);
	console.error(`[check-doc-links] ${broken.length} 件のリンク切れ。`);
	process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
