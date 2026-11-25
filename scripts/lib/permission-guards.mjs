/**
 * 権限のガードの両経路の対称（conventions §1、Issue #697 user-permissions-plan §5）。
 *
 * `scripts/verify-architecture.mjs` の rule 8（two-path-symmetry）が使う小さな純粋関数。
 * ロール床の照合（rule 8 (e)）と同じ考えで、ユーザーへ個別に付ける権限（permission）の
 * ガードが REST と Tauri で同じ権限を見ているかを静的に照合する。
 *
 * - Tauri: `src-tauri/src/lib.rs` の各 `async fn` の本体で最初に現れる
 *   `require_permission(&state, <式>, …)` の第 2 引数。
 * - REST: 各 `fn *_router` の本体の `PermissionGuard { … permission: <式>, … }` の式を、
 *   その本体の `.route("path", <verbs>(…))` の各メソッドに割り当てる。
 *
 * 式は空白と先頭の `&`、末尾の `.clone()` を除いて比べる。両経路で同じ定数
 * （例: `perms::EQUIPMENT_OPERATE`）を使えば一致する。マニフェスト（`PERMISSION_PAIRS`）に
 * 宣言した対が両経路とも宣言どおりか、そして**宣言していないガードが無いか**（片方の経路だけに
 * 権限のガードを足すミス）を返す。
 *
 * 依存を足さない文化（conventions §3）に従い Node 標準のみ（ここでは何も import しない）。
 */

/** `src` の `start` から、括弧の深さ 0 の `,` か閉じ括弧までの式を返す（文字列リテラル対応）。 */
function readArgument(src, start) {
	let depth = 0;
	let i = start;
	let inString = false;
	for (; i < src.length; i++) {
		const c = src[i];
		if (inString) {
			if (c === '\\') i++;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === '(' || c === '[' || c === '{') depth++;
		else if (c === ')' || c === ']' || c === '}') {
			if (depth === 0) break;
			depth--;
		} else if (c === ',' && depth === 0) break;
	}
	return src.slice(start, i);
}

/** 権限の式を比べられる形にする。 */
export function normalizePermissionExpr(expr) {
	return expr
		.replace(/\s+/g, '')
		.replace(/^&+/, '')
		.replace(/\.clone\(\)$/, '');
}

/**
 * Tauri: 関数名 → その本体で最初に現れる `require_permission(&state, <式>, …)` の式（正規化済み）。
 * 権限のガードを持たない関数は含めない。末尾の `#[cfg(test)] mod tests` はコマンドでは
 * ないので（`require_permission` そのものを試す）見ない。
 */
export function collectTauriPermissionGuards(libSrc) {
	const out = new Map();
	const commandSrc = libSrc.split(/\n#\[cfg\(test\)\]\s*\nmod tests \{/)[0];
	for (const seg of commandSrc.split(/\basync fn /).slice(1)) {
		const nm = seg.match(/^(\w+)/);
		if (!nm || nm[1] === 'require_permission') continue;
		const m = seg.match(/require_permission\(\s*&?\s*state\s*,\s*/);
		if (!m) continue;
		out.set(nm[1], normalizePermissionExpr(readArgument(seg, m.index + m[0].length)));
	}
	return out;
}

/**
 * REST: "METHOD /path" → その route を束ねる `PermissionGuard` の `permission` の式（正規化済み）。
 * `fn *_router` の本体（rustfmt 済みなので閉じ括弧は行頭 `}`）単位で見る。
 */
export function collectRestPermissionGuards(src) {
	const out = new Map();
	for (const fnM of src.matchAll(/\bfn \w+_router\b[\s\S]*?\n\}/g)) {
		const body = fnM[0];
		const guard = body.match(/PermissionGuard\s*\{[\s\S]*?\bpermission\s*:\s*/);
		if (!guard) continue;
		const permission = normalizePermissionExpr(readArgument(body, guard.index + guard[0].length));
		for (const chunk of body.split('.route(').slice(1)) {
			const pathM = chunk.match(/^\s*"([^"]+)"/);
			if (!pathM) continue;
			const p = pathM[1].split('?')[0].trim();
			const methodsSeg = chunk.split(/\.with_state|\.layer|\.route\(/)[0];
			for (const vm of methodsSeg.matchAll(/\b(get|post|put|delete|patch)\s*\(/g))
				out.set(`${vm[1].toUpperCase()} ${p}`, permission);
		}
	}
	return out;
}

/**
 * REST: 権限の層（`PermissionGuard`）の内側で `sse_response` を呼ぶのに、`SseContext` の
 * `require_permission` / `reauthorize_with` を呼んでいないハンドラー（Issue #935 S3、
 * docs/design/sse-stream-design.md §9）。層が見るのは配信を開く 1 回だけなので、これが無いと
 * 開いた後に権限を外しても配信が続く。
 *
 * 誤検出を出さないため、見るのは次の形だけ: 同じファイルの `fn *_router` の本体で、**最後の
 * `PermissionGuard` より前に**書かれた `.route("path", get(handler))`（`.layer` は前の route にだけ
 * 掛かる）の `handler` が、**同じファイルの** `async fn handler` で、本体に `sse_response(` を
 * 含み、`require_permission` も `reauthorize_with` も**どちらの語も含まない**もの。別のファイルや
 * 別の関数に作りを委ねるハンドラーは、見逃す側に倒れる（誤って落とさない）。
 * 返り値は `{ route, handler }` の配列（`route` は "METHOD /path"）。
 */
export function findSseHandlersWithoutPermission(src) {
	const out = [];
	for (const fnM of src.matchAll(/\bfn \w+_router\b[\s\S]*?\n\}/g)) {
		const body = fnM[0];
		const guards = [...body.matchAll(/PermissionGuard\s*\{/g)];
		if (guards.length === 0) continue;
		const guarded = body.slice(0, guards[guards.length - 1].index);
		for (const chunk of guarded.split('.route(').slice(1)) {
			const pathM = chunk.match(/^\s*"([^"]+)"/);
			if (!pathM) continue;
			const methodsSeg = chunk.split(/\.with_state|\.layer|\.route\(/)[0];
			for (const vm of methodsSeg.matchAll(/\b(get|post|put|delete|patch)\s*\(\s*([\w:]+)\s*\)/g)) {
				const handler = vm[2].split('::').pop();
				const fnDef = new RegExp(String.raw`\basync fn ${handler}\b[\s\S]*?\n\}`).exec(src);
				if (!fnDef) continue;
				const text = fnDef[0];
				if (
					/\bsse_response\s*\(/.test(text) &&
					!/\b(require_permission|reauthorize_with)\b/.test(text)
				)
					out.push({ route: `${vm[1].toUpperCase()} ${pathM[1].split('?')[0].trim()}`, handler });
			}
		}
	}
	return out;
}

/**
 * 照合。`pairs` は `{ tauri, rest, permission }` の配列（`permission` は正規化前の式でよい）。
 * `tauri` は Tauri コマンド名（`<cmd>_body` へ委譲していればその本体も見る）、`rest` は
 * "METHOD /path"。違反の説明文の配列を返す（空なら合格）。
 */
export function checkPermissionGuards({ tauriGuards, restGuards, pairs }) {
	const problems = [];
	const tauriOf = (cmd) => tauriGuards.get(cmd) ?? tauriGuards.get(`${cmd}_body`) ?? null;
	const declaredTauri = new Set();
	const declaredRest = new Set();
	for (const { tauri, rest, permission } of pairs) {
		const want = normalizePermissionExpr(permission);
		const t = tauriOf(tauri);
		const r = restGuards.get(rest) ?? null;
		declaredTauri.add(tauri).add(`${tauri}_body`);
		declaredRest.add(rest);
		if (t !== want || r !== want)
			problems.push(
				`権限のガードの非対称/不一致 \`${tauri}\` ⇔ \`${rest}\`: 期待=${want} / Tauri=${t ?? '無し'} / REST=${r ?? '無し'}（§1 両経路で同一の認可、Issue #697）`
			);
	}
	for (const [fn, permission] of tauriGuards) {
		if (!declaredTauri.has(fn))
			problems.push(
				`未宣言の権限のガード（Tauri）\`${fn}\`（${permission}）— REST の対と一緒に PERMISSION_PAIRS に足す（§1）`
			);
	}
	for (const [route, permission] of restGuards) {
		if (!declaredRest.has(route))
			problems.push(
				`未宣言の権限のガード（REST）\`${route}\`（${permission}）— Tauri の対と一緒に PERMISSION_PAIRS に足す（§1）`
			);
	}
	return problems;
}
