import { describe, expect, it } from 'vitest';
import type { PermissionEntry } from '#lib/banto/authAdmin.js';
import {
	draftFromSaved,
	permissionDescription,
	permissionLabel,
	permissionsDirty,
	permissionsToSend,
	samePermissions,
	showPermissionsField,
	withPermission
} from './disabledPermissions';

/**
 * Issue #697 PR-2b: the pure logic behind the login-not-required mode's
 * permissions field (`SecuritySection.svelte`).
 */
const operate: PermissionEntry = {
	key: 'equipment.operate',
	labelKey: 'perm.operate',
	descriptionKey: 'perm.operate_desc'
};
const ack: PermissionEntry = {
	key: 'alarm.ack',
	labelKey: 'perm.ack',
	descriptionKey: 'perm.ack_desc'
};
const catalog = [operate, ack];

describe('showPermissionsField', () => {
	it('is shown only for a non-empty catalog (not loaded, empty or failed hide it)', () => {
		expect(showPermissionsField(null)).toBe(false);
		expect(showPermissionsField([])).toBe(false);
		expect(showPermissionsField(catalog)).toBe(true);
	});
});

describe('permissionLabel / permissionDescription', () => {
	it('uses the app message and falls back to the key itself', () => {
		const lookup = (k: string) => ({ 'perm.operate': '運転操作' })[k];
		expect(permissionLabel(operate, lookup)).toBe('運転操作');
		expect(permissionLabel(ack, lookup)).toBe('alarm.ack');
		expect(permissionLabel(ack, () => '')).toBe('alarm.ack');
		expect(permissionDescription(operate, lookup)).toBeUndefined();
		expect(permissionDescription(operate, () => '説明')).toBe('説明');
	});
});

describe('draftFromSaved / withPermission', () => {
	it('keeps only registered keys, in catalog order', () => {
		expect(draftFromSaved(['alarm.ack', 'old.gone', 'equipment.operate'], catalog)).toEqual([
			'equipment.operate',
			'alarm.ack'
		]);
		expect(draftFromSaved([], catalog)).toEqual([]);
	});

	it('toggles a key and keeps the catalog order; an unknown key is never added', () => {
		expect(withPermission([], catalog, 'alarm.ack', true)).toEqual(['alarm.ack']);
		expect(withPermission(['alarm.ack'], catalog, 'equipment.operate', true)).toEqual([
			'equipment.operate',
			'alarm.ack'
		]);
		expect(withPermission(['alarm.ack'], catalog, 'alarm.ack', false)).toEqual([]);
		expect(withPermission([], catalog, 'nope.unknown', true)).toEqual([]);
	});
});

describe('samePermissions', () => {
	it('compares as sets', () => {
		expect(samePermissions(['a.b', 'c.d'], ['c.d', 'a.b', 'a.b'])).toBe(true);
		expect(samePermissions(['a.b'], ['c.d'])).toBe(false);
		expect(samePermissions([], [])).toBe(true);
	});
});

describe('permissionsToSend / permissionsDirty', () => {
	it('sends nothing without a catalog (field hidden: the server leaves them alone)', () => {
		expect(permissionsToSend(['alarm.ack'], [], null)).toBeUndefined();
		expect(permissionsToSend([], ['alarm.ack'], [])).toBeUndefined();
		expect(permissionsDirty(['alarm.ack'], [], null)).toBe(false);
	});

	it('sends nothing when unchanged, even if an unregistered key is stored', () => {
		expect(permissionsToSend(['alarm.ack'], ['alarm.ack', 'old.gone'], catalog)).toBeUndefined();
		expect(permissionsDirty(['alarm.ack'], ['alarm.ack', 'old.gone'], catalog)).toBe(false);
	});

	it('sends the whole new set when changed, and [] when everything is cleared', () => {
		expect(permissionsToSend(['alarm.ack'], [], catalog)).toEqual(['alarm.ack']);
		expect(permissionsToSend([], ['alarm.ack'], catalog)).toEqual([]);
		expect(permissionsDirty([], ['alarm.ack'], catalog)).toBe(true);
	});
});
