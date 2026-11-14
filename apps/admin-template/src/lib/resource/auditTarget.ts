/**
 * The link from an audit record to the record it is about (#597 stage 2):
 * the resource's list screen with `?id=<entityId>`, which opens that record in
 * the drawer (a narrow screen goes on to the detail page, as for any `?id=`).
 *
 * The resource name -> path map is the registered `resources` array itself (no
 * second table). `null` (no link) when the resource has no screen of its own
 * (users, attachments, ...), the record carries no entity id, or the action
 * was `delete` (the record is gone).
 *
 * `defs` defaults to the registered resources; tests pass their own so they
 * do not depend on which resources a scaffold preset keeps (display has none).
 */
import { resources } from '#lib/banto/resources/index.js';
import { resolveAppPath, type AppPath } from '#lib/appPath.js';

export type AuditTargetResource = { readonly name: string; readonly path: string };

export function auditTargetHref(
	resource: string,
	entityId: string | null | undefined,
	action: string,
	defs: readonly AuditTargetResource[] = resources
): string | null {
	if (action === 'delete') return null;
	if (entityId === null || entityId === undefined || entityId === '') return null;
	const def = defs.find((r) => r.name === resource);
	if (!def) return null;
	return `${resolveAppPath(def.path as AppPath)}?id=${encodeURIComponent(entityId)}`;
}
