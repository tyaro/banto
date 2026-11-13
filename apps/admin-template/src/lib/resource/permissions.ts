/**
 * Which operations of a resource the current role is offered (ADR-0030 §5).
 *
 * Pure and UI-agnostic. It only decides what the screens SHOW; authorization
 * stays with the server's `RoleGuard` and Tauri's `require_role`
 * (conventions §1). Operations that are not allowed are hidden, not disabled
 * (M10). A LAN viewer-public session has role `viewer`, so it is read-only
 * automatically.
 */
import type { ResourceDefinition } from '@banto/admin-core';
import { canWriteResources, type Role } from '#lib/permissions.js';

export interface ResourcePermissions {
	create: boolean;
	edit: boolean;
	delete: boolean;
	/** CSV import (a write). */
	import: boolean;
	/** CSV export (a read: only `capabilities.list` matters). */
	export: boolean;
}

/**
 * Write operations need the definition's capability AND `canWrite(role)`
 * (default `canWriteResources`); export is a read and only needs `list`.
 * `import` needs both `create` and `edit`: a CSV import inserts new rows AND
 * updates existing ones.
 */
export function resourcePermissions(
	definition: Pick<ResourceDefinition, 'capabilities'>,
	role: Role,
	canWrite: (role: Role) => boolean = canWriteResources
): ResourcePermissions {
	const caps = definition.capabilities ?? {};
	const writable = canWrite(role);
	return {
		create: writable && caps.create === true,
		edit: writable && caps.edit === true,
		delete: writable && caps.delete === true,
		import: writable && caps.create === true && caps.edit === true,
		export: caps.list === true
	};
}
