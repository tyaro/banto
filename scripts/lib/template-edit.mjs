/**
 * テンプレート編集エンジン（improvement-plan-2026-07.md P2-1 / P4-9）。
 *
 * `scripts/rename.mjs`（名称・識別子の一括書き換え）と
 * `scripts/scaffold.mjs`（プリセット＝オプション資産の削除）が共有する、
 * 「現在値を読んでから書き換える・再実行安全・`--dry-run` 対応・見つからない
 * パターンは明示的に失敗」というファイル編集の規律をここに一本化する。
 * 依存を足さない文化（conventions §3 / ADR-0002）に従い Node 標準のみ。
 *
 * 契約（`edit` コールバックの戻り値）:
 *   - `null`      … 既に目的の状態（再実行・適用済み）。スキップとして報告。
 *   - `undefined` … 期待したパターンが見つからない。明示的な失敗として報告。
 *   - 文字列      … 書き換え後の新しい内容。
 *
 * `createEditor()` は変更ログ（`changes`）と失敗数（`failures`）を閉じ込めた
 * エディタを返す。呼び出し側は `report()` で結果を出力し、`failures > 0` なら
 * 非0終了する（テンプレートの構造が変わったことの検出）。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * `s` 中の `from` 全出現を `to` に置換。0件なら `undefined`（失敗）、
 * `from === to` なら `null`（適用済み）。
 */
export function replaceAll(s, from, to) {
	if (from === to) return null;
	if (!s.includes(from)) return undefined;
	return s.split(from).join(to);
}

/**
 * 削除系エディット向けの純関数: `block` を丸ごと取り除く。
 * `block` が既に無ければ `null`（適用済み＝再実行安全）を返す。削除は
 * `removeFile`/`removeDir` と同じく「既に消えていれば静かにスキップ」する冪等
 * 操作なので、見つからない＝適用済みとして扱う（`replaceAll` の「見つからない
 * ＝失敗」とは意図的に区別する）。
 */
export function dropBlock(s, block) {
	if (!s.includes(block)) return null;
	return s.split(block).join('');
}

/**
 * 削除系エディット向けの純関数: `start` から `end`（両端含む）までの連続領域を
 * 丸ごと取り除く。短い一意なアンカーだけで巨大なブロックを消せるので、資産の
 * 配線（章立てされた script/markup/CSS ブロック）除去に向く。
 * - `start` が無ければ `null`（適用済み＝再実行安全）。
 * - `start` はあるが `start` 以降に `end` が無ければ `undefined`（構造が
 *   変わった＝明示的失敗）。
 */
export function cut(s, start, end) {
	const i = s.indexOf(start);
	if (i === -1) return null;
	const j = s.indexOf(end, i + start.length);
	if (j === -1) return undefined;
	return s.slice(0, i) + s.slice(j + end.length);
}

/**
 * 削除系エディット向けの純関数: `marker` の最初の出現から**ファイル末尾まで**を
 * 丸ごと取り除く。ファイル末尾に付く章末セクション（独自の付録的ブロック）を
 * EOF ごと消すのに向く。結果は必ず単一の改行で終える（rustfmt/prettier 整合）。
 * - `marker` が無ければ `null`（適用済み＝再実行安全。`cut`/`dropBlock` と同じ
 *   「見つからない＝適用済み」規約。`replaceAll` の「見つからない＝失敗」とは
 *   意図的に区別する）。
 * - `marker` があれば、その手前までを残し末尾の空白を単一改行に整えて返す。
 */
export function cutToEnd(s, marker) {
	const i = s.indexOf(marker);
	if (i === -1) return null;
	return s.slice(0, i).replace(/\s+$/, '') + '\n';
}

/**
 * 変換系エディット向けの純関数: `from` を `to` に置換するが、**冪等**。
 * - `from` があれば置換（1回目）。
 * - `from` が無く `to` があれば `null`（適用済み・2回目以降）。
 * - どちらも無ければ `undefined`（構造が変わった＝明示的失敗）。
 * `to` は削除後に必ず現れる「置換後の目印」を含む文字列であること。
 */
export function swap(s, from, to) {
	if (s.includes(from)) return s.split(from).join(to);
	if (s.includes(to)) return null;
	return undefined;
}

/**
 * 変更ログと失敗数を閉じ込めたエディタを生成する。
 *
 * `strict` は「pristine なコピー上での適用」専用モード: 削除系の
 * 「見つからない＝適用済み（null）」と removeFile/removeDir の「既に無い」を
 * **失敗に昇格**する。出荷ツリーには全アンカーが必ず在るはずなので、null は
 * アンカードリフト（対象ファイル側の変更に scaffold が追随していない）の
 * 兆候になる。再実行安全性が要る通常運用では strict を付けないこと
 * （template-acceptance の presets ジョブが唯一の想定利用者）。
 * @param {{ repoRoot: string, dryRun?: boolean, strict?: boolean }} options
 */
export function createEditor({ repoRoot, dryRun = false, strict = false }) {
	/** 実行予定/実行済みの変更ログ（`--dry-run` 共用）。 */
	const changes = [];
	let failures = 0;

	/**
	 * `relPath` を読み、`edit(before)` の戻り値で書き換える（契約は本ファイル
	 * 冒頭のとおり）。`--dry-run` では書き込まない。
	 */
	function editFile(relPath, label, edit) {
		const abs = path.join(repoRoot, relPath);
		let before;
		try {
			before = fs.readFileSync(abs, 'utf8');
		} catch {
			console.error(`  ✗ ${relPath}: ${label} — ファイルが見つかりません`);
			failures++;
			return;
		}
		const result = edit(before);
		if (result === null) {
			if (strict) {
				// pristine コピーに「適用済み」は在り得ない = アンカードリフトの疑い。
				console.error(
					`  ✗ ${relPath}: ${label} — strict: 適用済み扱い（null）はアンカー不一致の疑い`
				);
				failures++;
				return;
			}
			// 既に目的の値（再実行）— スキップとして報告。
			changes.push(`  = ${relPath}: ${label}（変更なし・適用済み）`);
			return;
		}
		if (result === undefined) {
			console.error(
				`  ✗ ${relPath}: ${label} — 期待したパターンが見つかりません（構造が変わった可能性）`
			);
			failures++;
			return;
		}
		changes.push(`  ✔ ${relPath}: ${label}`);
		if (!dryRun) fs.writeFileSync(abs, result);
	}

	/** JSON ファイルの文字列フィールドを、整形を保ったまま書き換える。 */
	function jsonField(relPath, field, to) {
		editFile(relPath, `${field} → "${to}"`, (s) => {
			const current = JSON.parse(s)[field];
			if (typeof current !== 'string') return undefined;
			if (current === to) return null;
			return replaceAll(s, JSON.stringify(current), JSON.stringify(to));
		});
	}

	/**
	 * ファイルを冪等に削除する。既に無ければ静かにスキップ（適用済みとして
	 * 報告）。`--dry-run` では削除しない。
	 */
	function removeFile(relPath, label) {
		const abs = path.join(repoRoot, relPath);
		if (!fs.existsSync(abs)) {
			if (strict) {
				console.error(`  ✗ ${relPath}: ${label} — strict: 削除対象が存在しません`);
				failures++;
				return;
			}
			changes.push(`  = ${relPath}: ${label}（削除済み）`);
			return;
		}
		changes.push(`  ✔ ${relPath}: ${label}（ファイル削除）`);
		if (!dryRun) fs.rmSync(abs, { force: true });
	}

	/**
	 * ディレクトリを冪等に再帰削除する。既に無ければ静かにスキップ。
	 * `--dry-run` では削除しない。
	 */
	function removeDir(relPath, label) {
		const abs = path.join(repoRoot, relPath);
		if (!fs.existsSync(abs)) {
			if (strict) {
				console.error(`  ✗ ${relPath}: ${label} — strict: 削除対象が存在しません`);
				failures++;
				return;
			}
			changes.push(`  = ${relPath}: ${label}（削除済み）`);
			return;
		}
		changes.push(`  ✔ ${relPath}: ${label}（ディレクトリ削除）`);
		if (!dryRun) fs.rmSync(abs, { recursive: true, force: true });
	}

	/** 結果を標準出力へ。失敗があれば true を返す（呼び出し側で非0終了）。 */
	function report(header) {
		console.log(header);
		for (const line of changes) console.log(line);
		if (failures > 0) {
			console.error(
				`\n${failures} 件の編集が適用できませんでした。テンプレートの構造が変わった場合は本スクリプトも更新してください。`
			);
			return true;
		}
		return false;
	}

	return {
		changes,
		editFile,
		jsonField,
		removeFile,
		removeDir,
		report,
		get failures() {
			return failures;
		}
	};
}
