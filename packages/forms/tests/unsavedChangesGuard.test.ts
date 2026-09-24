// @vitest-environment jsdom
/**
 * `guardUnsavedChanges` component wiring (spec §7, issue #214): guards join
 * the shared registry on mount and leave it on destroy, several guards on
 * one screen answer a navigation with ONE prompt, and a save in flight
 * counts as pending. `beforeNavigate` is a fake that records callbacks the
 * way SvelteKit does (every callback receives the same navigation object).
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GuardHarness from './GuardHarness.svelte';
import {
	hasUnsavedChanges,
	type LeaveNavigation,
	type UnsavedChangesGuard
} from '../src/unsavedChanges.svelte';

afterEach(cleanup);

function fakeRouter() {
	const callbacks: ((navigation: LeaveNavigation) => void)[] = [];
	return {
		beforeNavigate: (callback: (navigation: LeaveNavigation) => void) => {
			callbacks.push(callback);
		},
		/** Fire one navigation through every registered callback; returns whether it was cancelled. */
		navigate(type = 'link', to: string | null = '/elsewhere'): boolean {
			let cancelled = false;
			const navigation: LeaveNavigation = {
				type,
				from: { url: new URL('/here', 'http://app.test') },
				to: to ? { url: new URL(to, 'http://app.test') } : null,
				cancel: () => {
					cancelled = true;
				}
			};
			callbacks.forEach((callback) => callback(navigation));
			return cancelled;
		}
	};
}

describe('guardUnsavedChanges', () => {
	it('prompts once for two dirty guards and cancels on "stay"', () => {
		const router = fakeRouter();
		const confirm = vi.fn(() => false);
		const common = { beforeNavigate: router.beforeNavigate, confirm, message: 'discard?' };
		render(GuardHarness, { ...common, isDirty: () => true });
		render(GuardHarness, { ...common, isDirty: () => true });

		expect(router.navigate()).toBe(true);
		expect(confirm).toHaveBeenCalledOnce();
		expect(confirm).toHaveBeenCalledWith('discard?');
	});

	it('asks when only the second of two guards is dirty', () => {
		const router = fakeRouter();
		const confirm = vi.fn(() => false);
		const common = { beforeNavigate: router.beforeNavigate, confirm, message: 'discard?' };
		render(GuardHarness, { ...common, isDirty: () => false });
		render(GuardHarness, { ...common, isDirty: () => true });

		expect(router.navigate()).toBe(true);
		expect(confirm).toHaveBeenCalledOnce();
	});

	it('does not ask when every guard is clean', () => {
		const router = fakeRouter();
		const confirm = vi.fn(() => false);
		render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm,
			message: 'discard?',
			isDirty: () => false
		});

		expect(router.navigate()).toBe(false);
		expect(confirm).not.toHaveBeenCalled();
		expect(hasUnsavedChanges()).toBe(false);
	});

	it('treats a save in flight as pending', () => {
		const router = fakeRouter();
		const confirm = vi.fn(() => false);
		render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm,
			message: 'discard?',
			isDirty: () => false,
			isSaving: () => true
		});

		expect(hasUnsavedChanges()).toBe(true);
		expect(router.navigate()).toBe(true);
	});

	it('leaves the registry and reports disposed after unmount', () => {
		const router = fakeRouter();
		let guard!: UnsavedChangesGuard;
		const { unmount } = render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm: () => false,
			message: 'discard?',
			isDirty: () => true,
			onGuard: (g: UnsavedChangesGuard) => {
				guard = g;
			}
		});
		expect(hasUnsavedChanges()).toBe(true);
		expect(guard.pending).toBe(true);
		expect(guard.disposed).toBe(false);

		unmount();
		expect(hasUnsavedChanges()).toBe(false);
		expect(guard.disposed).toBe(true);
	});

	it('cancels an unload (native prompt) without calling confirm', () => {
		const router = fakeRouter();
		const confirm = vi.fn(() => true);
		render(GuardHarness, {
			beforeNavigate: router.beforeNavigate,
			confirm,
			message: 'discard?',
			isDirty: () => true
		});

		expect(router.navigate('leave', null)).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});
});
