/**
 * 設定の下書き → 反映 → 元に戻す（Issue #938）のガードを、両経路で照合するための読み取り
 * （conventions §1、docs/design/config-draft-publish-design.md §4.9 の「S4 の前提」）。
 *
 * `scripts/verify-architecture.mjs` の rule 8（two-path-symmetry）が使う小さな純粋関数。
 * `/api/config/*` のルーター（`banto_server::routes::config_drafts_router`）は、ロールの床を
 * 本体に書かない。床は、アプリの配線が渡す `ConfigDraftsAccess { read, edit, publish, unlock }`
 * で決まる。rule 8 (e) は `fn *_router` の本体の `min: Role::X` しか読めないので、そのままだと
 * 「`require_auth` だけ＝Viewer の床」と読んでしまう。ここで次の 3 つを読んで、口ごとの床と権限に直す。
 *
 * - **ガード**: アプリの配線の `ConfigDraftsAccess { .. }` のリテラル（4 つの欄を全部書き出した物。
 *   `ConfigDraftsAccess::default()` は読めないので使わない）。欄は
 *   `ConfigDraftsGate::Role(Role::X)` か `ConfigDraftsGate::Permission(<式>)`。
 * - **REST の口の役目**: `fn config_drafts_router` の本体の `let read|edit|publish|unlock = Router::new()…`
 *   に並ぶ `.route("path", <verbs>(…))`。
 * - **Tauri のコマンドの役目**: 各 `async fn` の本体で最初に現れる `require_config(state, ConfigDuty::X)`。
 *
 * 「読む」のガードは、ほかの 3 つの役目の口にも重なる（ルーターが自分で重ねる。Tauri は
 * `require_config` が重ねる）。そこで口の床は「読む」と役目のガードの高い方になる。
 *
 * 依存を足さない文化（conventions §3）に従い Node 標準のみ。
 */
import { normalizePermissionExpr, readArgument } from './permission-guards.mjs';

/** 役目（design §4.9）。`ConfigDraftsAccess` の欄の名前と同じ。 */
export const CONFIG_DUTIES = ['read', 'edit', 'publish', 'unlock'];

/** テンプレートのロールの順（低い → 高い）。足したロールは、ここに無ければ比べられない。 */
const ROLE_ORDER = ['Viewer', 'Editor', 'Admin'];

/** 行頭が `//` のコメント行を消す（doc コメントの中の見本を、実物と取り違えないため）。 */
function stripLineComments(src) {
	return src.replace(/^[\t ]*\/\/.*$/gm, '');
}

/**
 * アプリの配線の `ConfigDraftsAccess { .. }` のリテラルを読む。
 *
 * 戻り値:
 * - リテラルが無い → `null`（このアプリは配線していない）
 * - 読めた → `{ gates: { read, edit, publish, unlock } }`。各ガードは
 *   `{ kind: 'role', role }` か `{ kind: 'permission', permission }`（式は正規化済み）
 * - 読めない → `{ error }`（欄が足りない・`..` で残りを省いた・値が 2 つの形のどちらでもない・
 *   リテラルが 2 つ以上あって中身が違う）
 *
 * 型の定義（`struct ConfigDraftsAccess {`）、`impl .. for ConfigDraftsAccess {`、戻り値の型
 * （`-> ConfigDraftsAccess {`）はリテラルではないので飛ばす。
 */
export function parseConfigDraftsAccess(src) {
	const code = stripLineComments(src);
	const found = [];
	for (const m of code.matchAll(/\bConfigDraftsAccess\s*\{/g)) {
		const before = code.slice(0, m.index).trimEnd();
		if (/(?:\bstruct|\bfor|->)$/.test(before)) continue;
		const start = m.index + m[0].length;
		// 閉じ括弧まで（`readArgument` は深さ 0 の `,` で止まるので、欄を 1 つずつ読む）。
		const gates = {};
		let pos = start;
		let error = null;
		for (;;) {
			const field = readArgument(code, pos);
			const text = field.trim();
			if (text !== '') {
				if (text.startsWith('..')) {
					error =
						'`..` で残りの欄を省いている（4 つの役目を全部書き出す。省くと既定の admin と読めない）';
					break;
				}
				const colon = text.indexOf(':');
				const name = colon < 0 ? text : text.slice(0, colon).trim();
				const value = colon < 0 ? '' : text.slice(colon + 1).trim();
				if (!CONFIG_DUTIES.includes(name)) {
					error = `知らない欄 \`${name}\``;
					break;
				}
				const role = value.match(/^ConfigDraftsGate::Role\(\s*Role::(\w+)\s*,?\s*\)$/);
				const permission = value.match(/^ConfigDraftsGate::Permission\(([\s\S]+)\)$/);
				if (role) gates[name] = { kind: 'role', role: role[1] };
				else if (permission)
					gates[name] = {
						kind: 'permission',
						permission: normalizePermissionExpr(permission[1].replace(/,\s*$/, ''))
					};
				else {
					error = `\`${name}\` の値を読めない（\`ConfigDraftsGate::Role(Role::X)\` か \`ConfigDraftsGate::Permission(<式>)\` をその場に書く）: ${value.replace(/\s+/g, ' ')}`;
					break;
				}
			}
			pos += field.length;
			if (code[pos] !== ',') break;
			pos += 1;
		}
		if (!error) {
			const missing = CONFIG_DUTIES.filter((duty) => !gates[duty]);
			if (missing.length > 0) error = `欄が足りない: ${missing.join(', ')}`;
		}
		found.push(error ? { error } : { gates });
	}
	if (found.length === 0) return null;
	const broken = found.find((f) => f.error);
	if (broken) return { error: `ConfigDraftsAccess のリテラルを読めない: ${broken.error}` };
	const first = JSON.stringify(found[0].gates);
	if (found.some((f) => JSON.stringify(f.gates) !== first))
		return {
			error:
				'ConfigDraftsAccess のリテラルが 2 つ以上あって中身が違う（両経路が同じ 1 つの値を使う形にする）'
		};
	return { gates: found[0].gates };
}

/**
 * REST: "METHOD /path" → 役目。`fn config_drafts_router` の本体（rustfmt 済みなので閉じ括弧は
 * 行頭 `}`）の `let <役目> = Router::new()…;` ごとに `.route("path", <verbs>(…))` を拾う。
 */
export function collectConfigDraftsRouteDuties(routerSrc) {
	const out = new Map();
	const fn = routerSrc.match(/\bfn config_drafts_router\b[\s\S]*?\n\}/);
	if (!fn) return out;
	for (const m of fn[0].matchAll(
		/\blet (read|edit|publish|unlock) = Router::new\(\)([\s\S]*?);/g
	)) {
		for (const chunk of m[2].split('.route(').slice(1)) {
			const pathM = chunk.match(/^\s*"([^"]+)"/);
			if (!pathM) continue;
			const p = pathM[1].split('?')[0].trim();
			for (const vm of chunk.matchAll(/\b(get|post|put|delete|patch)\s*\(/g))
				out.set(`${vm[1].toUpperCase()} ${p}`, m[1]);
		}
	}
	return out;
}

/**
 * Tauri: 関数名 → その本体で最初に現れる `require_config(state, ConfigDuty::X)` の役目（小文字）。
 * `require_config` そのものと、末尾の `#[cfg(test)] mod tests` は見ない。コメント行も見ない。
 */
export function collectTauriConfigDuties(libSrc) {
	const out = new Map();
	const commandSrc = stripLineComments(libSrc.split(/\n#\[cfg\(test\)\]\s*\nmod tests \{/)[0]);
	for (const seg of commandSrc.split(/\basync fn /).slice(1)) {
		const nm = seg.match(/^(\w+)/);
		if (!nm || nm[1] === 'require_config') continue;
		const m = seg.match(/\brequire_config\(\s*&?\s*state\s*,\s*ConfigDuty::(\w+)/);
		if (m) out.set(nm[1], m[1].toLowerCase());
	}
	return out;
}

/** ガード 1 つのロールの床。権限のガードはロールを見ないので `Auth`（＝セッションがあればよい）。 */
function gateRole(gate) {
	return gate.kind === 'role' ? gate.role : 'Auth';
}

/**
 * 役目の口のロールの床: 「読む」のガードと役目のガードの高い方。比べられないロールどうし
 * （`ROLE_ORDER` に無い物）は `A+B` を返す（宣言と一致しないので、照合で必ず表に出る）。
 */
export function configDutyRole(gates, duty) {
	const a = gateRole(gates.read);
	const b = gateRole(gates[duty]);
	if (a === b || b === 'Auth') return a;
	if (a === 'Auth') return b;
	const [ia, ib] = [ROLE_ORDER.indexOf(a), ROLE_ORDER.indexOf(b)];
	if (ia < 0 || ib < 0) return `${a}+${b}`;
	return ia >= ib ? a : b;
}

/**
 * 役目の口の権限（`PERMISSION_PAIRS` に宣言する式）: 役目のガードが権限ならその式、
 * そうでなく「読む」が権限ならその式、どちらもロールなら `null`。
 * （両方が権限で式が違うときは、役目の方を宣言する。「読む」の方は読み取りの口の対で見る。）
 */
export function configDutyPermission(gates, duty) {
	if (gates[duty].kind === 'permission') return gates[duty].permission;
	if (gates.read.kind === 'permission') return gates.read.permission;
	return null;
}

/**
 * rule 8 に足す照合の材料をまとめる。
 *
 * - `appSources`: アプリの配線のソース（テストを除く。`ConfigDraftsAccess { .. }` を探す先）
 * - `routerSrc`: `crates/banto-server/src/routes/config_drafts.rs`（無ければ空文字）
 * - `libSrc`: `src-tauri/src/lib.rs`
 * - `pairs`: `{ tauri, rest }` の配列（`DUAL_PATH` と `ROLE_READ`）
 * - `routes`: Route table に載っている "METHOD /path" の集合
 *
 * 戻り値: `{ problems, restRoles, tauriRoles, restPermissions, tauriPermissions }`。
 * `restRoles`・`tauriRoles` は (e) のロールの床へ、`*Permissions` は (f) の権限のガードへ上書きで足す。
 * 配線していないアプリ（リテラルも、Route table の行も、コマンドも無い）では全部が空。
 */
export function collectConfigDraftsGates({ appSources, routerSrc, libSrc, pairs, routes }) {
	const result = {
		problems: [],
		restRoles: new Map(),
		tauriRoles: new Map(),
		restPermissions: new Map(),
		tauriPermissions: new Map()
	};
	const routeDuties = collectConfigDraftsRouteDuties(routerSrc);
	const tauriDuties = collectTauriConfigDuties(libSrc);
	const mounted = [...routeDuties.keys()].filter((route) => routes.has(route));

	const parsed = appSources.map(parseConfigDraftsAccess).filter((access) => access !== null);
	const broken = parsed.find((access) => access.error);
	if (broken) {
		result.problems.push(broken.error);
		return result;
	}
	if (parsed.length === 0) {
		if (mounted.length > 0 || tauriDuties.size > 0)
			result.problems.push(
				'`/api/config/*` か `config_*` のコマンドがあるのに、アプリの配線に `ConfigDraftsAccess { read: .., edit: .., publish: .., unlock: .. }` のリテラルが無い（`ConfigDraftsAccess::default()` は読めない。4 つとも書き出す。config-draft-publish-design §4.9）'
			);
		return result;
	}
	const first = JSON.stringify(parsed[0].gates);
	if (parsed.some((access) => JSON.stringify(access.gates) !== first)) {
		result.problems.push(
			'ConfigDraftsAccess のリテラルが 2 つ以上あって中身が違う（両経路が同じ 1 つの値を使う形にする）'
		);
		return result;
	}
	const { gates } = parsed[0];

	for (const [route, duty] of routeDuties) {
		result.restRoles.set(route, configDutyRole(gates, duty));
		const permission = configDutyPermission(gates, duty);
		if (permission !== null) result.restPermissions.set(route, permission);
	}
	for (const [fn, duty] of tauriDuties) {
		if (!CONFIG_DUTIES.includes(duty)) {
			result.problems.push(`\`${fn}\` の \`ConfigDuty\` を読めない: ${duty}`);
			continue;
		}
		result.tauriRoles.set(fn, configDutyRole(gates, duty));
		const permission = configDutyPermission(gates, duty);
		if (permission !== null) result.tauriPermissions.set(fn, permission);
	}

	// 対の両端が同じ役目であること。ロールの床が 4 つとも同じ（テンプレートの既定）だと、
	// 床の照合だけでは「反映のコマンドが編集のガードで通る」ずれを拾えない。
	const tauriDutyOf = (cmd) => tauriDuties.get(cmd) ?? tauriDuties.get(`${cmd}_body`) ?? null;
	for (const { tauri, rest } of pairs) {
		const restDuty = routeDuties.get(rest);
		const tauriDuty = tauriDutyOf(tauri);
		if (restDuty === undefined && tauriDuty === null) continue;
		if (restDuty !== tauriDuty)
			result.problems.push(
				`設定の下書きの役目の非対称 \`${tauri}\` ⇔ \`${rest}\`: Tauri=${tauriDuty ?? '無し'} / REST=${restDuty ?? '無し'}（両経路で同じ役目のガードを通す。config-draft-publish-design §4.9）`
			);
	}
	return result;
}
