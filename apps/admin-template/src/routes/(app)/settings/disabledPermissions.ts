/**
 * ログイン不要モードのセッションが持つ権限（Issue #697 PR-2b、user-permissions-plan §8-4）の
 * 設定欄の純粋ロジック（`SecuritySection.svelte` から使う。DOM を持たないのでテストできる）。
 *
 * 欄の出し分け・下書きの正規化・保存時に送る値の決定だけを持つ。権限の語彙はアプリが
 * 登録したカタログ（`permissions_catalog`）で、テンプレートは何も登録しないので欄は出ない。
 */
import type { PermissionEntry, UserPermission } from '#lib/banto/usersAdmin.js';

/** カタログがあるときだけ欄を出す（空・未取得・取得失敗では出さない = テンプレートの見た目は変わらない）。 */
export function showPermissionsField(catalog: readonly PermissionEntry[] | null): boolean {
	return catalog !== null && catalog.length > 0;
}

/**
 * 表示名。アプリが登録した message key を `lookup` で引き、無ければ（未翻訳・キー違い）
 * 権限のキーそのものを出す。`lookup` は message key -> 文言（無ければ undefined）。
 */
export function permissionLabel(
	entry: PermissionEntry,
	lookup: (messageKey: string) => string | undefined
): string {
	return lookup(entry.labelKey) || entry.key;
}

/** 説明文（`descriptionKey` を引く。無ければ undefined = 出さない）。 */
export function permissionDescription(
	entry: PermissionEntry,
	lookup: (messageKey: string) => string | undefined
): string | undefined {
	return lookup(entry.descriptionKey) || undefined;
}

/**
 * 保存済みの権限を下書きにする: カタログに登録されているものだけを、カタログの並びで。
 * 登録を外された鍵（サーバーは持っていないものとして扱う）は下書きに入れない。入れると保存が
 * 未登録の鍵として 422 になるため。
 */
export function draftFromSaved(
	saved: readonly UserPermission[],
	catalog: readonly PermissionEntry[]
): UserPermission[] {
	const held = new Set(saved);
	return catalog.filter((entry) => held.has(entry.key)).map((entry) => entry.key);
}

/** `key` を付け外しした下書き（カタログの並びを保つ。カタログに無い鍵は付けない）。 */
export function withPermission(
	draft: readonly UserPermission[],
	catalog: readonly PermissionEntry[],
	key: UserPermission,
	on: boolean
): UserPermission[] {
	const next = new Set(draft);
	if (on) next.add(key);
	else next.delete(key);
	return catalog.filter((entry) => next.has(entry.key)).map((entry) => entry.key);
}

/** 2 つの権限の集合は同じか（順序と重複は見ない）。 */
export function samePermissions(
	a: readonly UserPermission[],
	b: readonly UserPermission[]
): boolean {
	const left = new Set(a);
	const right = new Set(b);
	if (left.size !== right.size) return false;
	for (const key of left) if (!right.has(key)) return false;
	return true;
}

/**
 * 保存で `applyAuthSettings` の `permissions` に渡す値。カタログが無い（欄が出ていない）か、
 * 保存済みと同じなら `undefined`（= 送らない = サーバー側は変えない）。送らない側に倒すのは、
 * 触っていないのに登録を外された鍵を消したり、欄が見えない Admin 以外のセッション
 * （escape hatch）が権限を書き換えたりしないため。
 */
export function permissionsToSend(
	draft: readonly UserPermission[],
	saved: readonly UserPermission[],
	catalog: readonly PermissionEntry[] | null
): UserPermission[] | undefined {
	if (!showPermissionsField(catalog)) return undefined;
	const effective = draftFromSaved(saved, catalog as readonly PermissionEntry[]);
	return samePermissions(draft, effective) ? undefined : [...draft];
}

/** 下書きが保存済みと違うか（未保存の印・「破棄」ボタン用。欄が出ていなければ常に false）。 */
export function permissionsDirty(
	draft: readonly UserPermission[],
	saved: readonly UserPermission[],
	catalog: readonly PermissionEntry[] | null
): boolean {
	return permissionsToSend(draft, saved, catalog) !== undefined;
}
