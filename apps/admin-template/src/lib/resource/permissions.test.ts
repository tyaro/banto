import { describe, expect, it } from 'vitest';
import type { Role } from '#lib/permissions.js';
import { resourcePermissions } from './permissions';

const ALL = { list: true, create: true, edit: true, delete: true };

describe('resourcePermissions', () => {
	it.each<Role>(['admin', 'editor'])('%s gets every operation the capabilities allow', (role) => {
		expect(resourcePermissions({ capabilities: ALL }, role)).toEqual({
			create: true,
			edit: true,
			delete: true,
			import: true,
			export: true
		});
	});

	it('viewer can only export', () => {
		expect(resourcePermissions({ capabilities: ALL }, 'viewer')).toEqual({
			create: false,
			edit: false,
			delete: false,
			import: false,
			export: true
		});
	});

	it('hides operations the definition does not have', () => {
		expect(resourcePermissions({ capabilities: { list: true, edit: true } }, 'admin')).toEqual({
			create: false,
			edit: true,
			delete: false,
			import: false,
			export: true
		});
	});

	it('export looks only at capabilities.list', () => {
		expect(resourcePermissions({ capabilities: { create: true } }, 'admin').export).toBe(false);
		expect(resourcePermissions({ capabilities: { list: true } }, 'viewer').export).toBe(true);
		expect(resourcePermissions({ capabilities: { list: false } }, 'admin').export).toBe(false);
	});

	it('no capabilities means nothing is offered', () => {
		expect(resourcePermissions({}, 'admin')).toEqual({
			create: false,
			edit: false,
			delete: false,
			import: false,
			export: false
		});
	});

	it('honours a custom canWrite', () => {
		const adminOnly = (role: Role) => role === 'admin';
		expect(resourcePermissions({ capabilities: ALL }, 'editor', adminOnly).create).toBe(false);
		expect(resourcePermissions({ capabilities: ALL }, 'admin', adminOnly).create).toBe(true);
	});
});
