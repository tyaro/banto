/**
 * The SessionController over the REAL Tauri provider (an `invoke` mock):
 * S-97 (re-review of #266 P1). `auth_config_apply(true, viewer)` re-binds
 * the synthetic session in Rust (`seq` N -> N+1, S-96) while an older
 * `auth_resolve` is in flight; that answer comes back `stale: true` with
 * `current = N+1`. The provider observes `current` before rejecting with
 * `StaleAnswerError` (I-23), so the controller's drift check holds the old
 * Local(admin) session (I-5) - and when the next confirmation fails, admin
 * does not stay active.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTauriAuthProvider } from '../src/providers/tauri';
import { createSessionController } from '../src/sessionController.svelte';
import { deferred, flush, makeScheduler } from './sessionHarness';

function scriptedInvoke() {
	const calls: { cmd: string; reply: ReturnType<typeof deferred<unknown>> }[] = [];
	const invoke = vi.fn((cmd: string) => {
		const reply = deferred<unknown>();
		calls.push({ cmd, reply });
		return reply.promise;
	});
	const resolves = () => calls.filter((call) => call.cmd === 'auth_resolve');
	return { invoke, resolves };
}

const localAdmin = (seq: number) => ({
	identity: { id: '0', name: 'ローカルユーザー', role: 'admin' },
	kind: 'local',
	checked: seq,
	current: seq,
	stale: false
});

describe('S-97: a stale auth_resolve after a Local role change (I-5, I-23)', () => {
	it('the stale answer’s `current` is observed, the old Local(admin) is held, and a failed re-confirmation leaves it unknown', async () => {
		const script = scriptedInvoke();
		const provider = createTauriAuthProvider({ invoke: script.invoke });
		const controller = createSessionController(provider, {
			scheduler: makeScheduler(),
			onNone: () => {},
			onActive: () => {}
		});

		const first = controller.resolve();
		// The first answer is about seq 5, which the provider had not observed:
		// discarded, the provider catches up, and the next probe confirms (S-84).
		script.resolves()[0].reply.resolve(localAdmin(5));
		await flush();
		expect(script.resolves()).toHaveLength(2);
		script.resolves()[1].reply.resolve(localAdmin(5));
		await expect(first).resolves.toMatchObject({ outcome: 'confirmed' });
		expect(controller.snapshot).toMatchObject({ status: 'active', kind: 'local' });
		expect(controller.snapshot.identity?.role).toBe('admin');
		const generation = controller.snapshot.generation;

		// An older auth_resolve is in flight while the role changes (seq 5 -> 6).
		const pending = controller.resolve();
		const stale = script.resolves().at(-1)!;
		stale.reply.resolve({ ...localAdmin(5), identity: null, current: 6, stale: true });
		await flush();

		expect(provider.credentialRevision()).toBe('6.0');
		expect(controller.snapshot).toMatchObject({
			status: 'unknown',
			owner: null,
			generation: generation + 1
		});
		await expect(pending).resolves.toMatchObject({ outcome: 'superseded' });

		// The background confirmation the hold started fails (IPC error).
		const background = script.resolves().at(-1)!;
		expect(background).not.toBe(stale);
		background.reply.reject({ kind: 'storage', message: 'database is locked' });
		await flush();

		expect(controller.snapshot.status).toBe('unknown');
		expect(controller.snapshot.identity).toBeNull();
		expect(controller.snapshot.verification.state).toBe('failed');
	});
});
