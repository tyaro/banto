// @vitest-environment jsdom
//
// The request rules of `PanelLifecycle` (#432 review on PR #448): an async
// answer is checked against the structure GENERATION (`DockState.
// structureRevision`), not two keys - a structure that came back to the same
// shape is still stale; the IME hold is checked again when the answer arrives;
// a held request keeps the generation of the moment it was held; `remount` /
// `from` are re-described right before applying; requests to different
// destinations are told apart; dispose resolves every waiting request.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelLifecycle, type DockPanelChange } from '../src/core/lifecycle';
import { collectPanelIds, structureKey } from '../src/core/tree';
import { createDockState, type DockState } from '../src/state.svelte';
import type { DockLayout, DockTabGroupNode } from '../src/types';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const layout = (): DockLayout => ({
	version: 4,
	floating: [
		{ id: 'a', title: 'A', x: 40, y: 40, width: 320, height: 200, open: true },
		{ id: 'b', title: 'B', x: 500, y: 300, width: 300, height: 200, open: true }
	],
	docked: {
		type: 'tabs',
		id: 't',
		activeIndex: 0,
		children: [
			{ type: 'panel', id: 'x', title: 'X' },
			{ type: 'panel', id: 'y', title: 'Y' }
		]
	}
});

const winOf = (dock: DockState, id: string) => dock.layout.floating.find((w) => w.id === id)!;
const active = (dock: DockState) => (dock.layout.docked as DockTabGroupNode).activeIndex;

let detach: (() => void) | null = null;
afterEach(() => {
	detach?.();
	detach = null;
	document.body.innerHTML = '';
});

function setup(options: {
	hook?: (change: DockPanelChange) => boolean | Promise<boolean>;
	keepMounted?: (id: string) => boolean;
	deferred?: () => boolean;
}) {
	const dock = createDockState(layout());
	const lifecycle = new PanelLifecycle(dock, () => ({
		beforePanelChange: options.hook,
		keepMounted: options.keepMounted,
		isStructureChangeDeferred: options.deferred
	}));
	detach = lifecycle.attach();
	return { dock, lifecycle };
}

describe('structureRevision', () => {
	it('counts structure changes only, also ones that come back to the same shape', () => {
		const dock = createDockState(layout());
		const start = dock.structureRevision;
		dock.move('a', 10, 10, 1000, 600);
		dock.focus('a');
		dock.resize('a', 'se', 10, 10, 1000, 600);
		expect(dock.structureRevision).toBe(start);
		dock.close('a');
		dock.open('a');
		expect(dock.structureRevision).toBe(start + 2);
		dock.setActiveTab('t', 1);
		dock.setActiveTab('t', 0);
		expect(dock.structureRevision).toBe(start + 4);
		dock.layout = { ...dock.layout }; // same structure, new object
		expect(dock.structureRevision).toBe(start + 4);
	});
});

describe('the structure generation decides stale (review 2)', () => {
	it('close -> open (a re-mount) while a close waits: the old approval is stale', async () => {
		const answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook: () => answer.promise });
		const pending = lifecycle.close('a');
		dock.close('a');
		dock.open('a');
		expect(structureKey(dock.layout)).toBe(structureKey(layout())); // same shape again
		answer.resolve(true);
		expect(await pending).toBe('stale');
		expect(winOf(dock, 'a').open).toBe(true);
	});

	it('tab A -> B -> A while a tab switch waits: stale', async () => {
		const answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook: () => answer.promise });
		const pending = lifecycle.switchTab('t', 'y');
		dock.setActiveTab('t', 1);
		dock.setActiveTab('t', 0);
		answer.resolve(true);
		expect(await pending).toBe('stale');
		expect(active(dock)).toBe(0);
	});

	it('geometry, split sizes and z-order still do not count', async () => {
		const answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook: () => answer.promise });
		const pending = lifecycle.close('a');
		dock.move('a', 30, 30, 1000, 600);
		dock.focus('b');
		answer.resolve(true);
		expect(await pending).toBe('applied');
		expect(winOf(dock, 'a').open).toBe(false);
	});
});

describe('IME composition is checked again when the answer arrives (review 1)', () => {
	it('a composition that starts while the hook waits holds the approval until compositionend', async () => {
		const answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook: () => answer.promise });
		const input = document.body.appendChild(document.createElement('input'));
		const pending = lifecycle.close('a');
		input.focus();
		input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
		answer.resolve(true);
		await nextTask();
		expect(winOf(dock, 'a').open).toBe(true); // not torn down mid-composition
		input.dispatchEvent(new Event('compositionend', { bubbles: true }));
		await nextTask();
		expect(await pending).toBe('applied');
		expect(winOf(dock, 'a').open).toBe(false);
	});

	it('a custom predicate that turns true while waiting holds until resumeDeferred; a change meanwhile is stale', async () => {
		let deferring = false;
		const hook = vi.fn(() => answer.promise);
		let answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook, deferred: () => deferring });
		const pending = lifecycle.close('a');
		deferring = true;
		answer.resolve(true);
		await nextTask();
		expect(winOf(dock, 'a').open).toBe(true);
		dock.close('b');
		deferring = false;
		lifecycle.resumeDeferred();
		expect(await pending).toBe('stale');
		expect(winOf(dock, 'a').open).toBe(true);
		expect(hook).toHaveBeenCalledTimes(1); // the approval is not asked again

		answer = deferred<boolean>();
		const ok = lifecycle.close('a');
		deferring = true;
		answer.resolve(true);
		await nextTask();
		deferring = false;
		lifecycle.resumeDeferred();
		expect(await ok).toBe('applied');
	});
});

describe('a held request keeps the generation of the moment it was held (review 5)', () => {
	it('the app switches the tab while a tab switch is held: stale, the hook is not asked with an old from', async () => {
		let deferring = true;
		const hook = vi.fn(() => true);
		const { dock, lifecycle } = setup({ hook, deferred: () => deferring });
		const held = lifecycle.switchTab('t', 'y');
		dock.setActiveTab('t', 1);
		dock.setActiveTab('t', 0); // back to the same shape: still a change
		deferring = false;
		lifecycle.resumeDeferred();
		expect(await held).toBe('stale');
		expect(hook).not.toHaveBeenCalled();
		expect(active(dock)).toBe(0);
	});
});

describe('keepMounted is re-checked right before applying (review 4)', () => {
	it('a hide asked as remount: false is stale once keepMounted turned false', async () => {
		let keep = true;
		const answer = deferred<boolean>();
		const calls: DockPanelChange[] = [];
		const { dock, lifecycle } = setup({
			hook: (c) => (calls.push(c), answer.promise),
			keepMounted: () => keep
		});
		const pending = lifecycle.closeButton('a');
		expect(calls).toEqual([{ kind: 'hide', panelId: 'a', remount: false }]);
		keep = false;
		answer.resolve(true);
		expect(await pending).toBe('stale');
		expect(winOf(dock, 'a').open).toBe(true);
	});

	it('a tab switch asked as remount: true is stale once the from pane became keepMounted', async () => {
		let keep = false;
		const answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook: () => answer.promise, keepMounted: () => keep });
		const pending = lifecycle.switchTab('t', 'y');
		keep = true;
		answer.resolve(true);
		expect(await pending).toBe('stale');
		expect(active(dock)).toBe(0);
	});
});

describe('requests to different destinations are told apart (review 3)', () => {
	it('the same change with another target is asked on its own; the first approved applies, the other is stale', async () => {
		const answers = [deferred<boolean>(), deferred<boolean>()];
		const hook = vi.fn(() => answers[hook.mock.calls.length - 1].promise);
		const { dock, lifecycle } = setup({ hook });
		const applied: string[] = [];
		const change: DockPanelChange = { kind: 'dock', panelId: 'a', remount: true };
		const toX = lifecycle.request(change, () => applied.push('x'), { target: { to: 'x' } });
		const toY = lifecycle.request(
			change,
			() => {
				applied.push('y');
				dock.close('a'); // a structure change, as a real dock would make
			},
			{ target: { to: 'y' } }
		);
		const againY = lifecycle.request(change, () => applied.push('y2'), { target: { to: 'y' } });
		expect(hook).toHaveBeenCalledTimes(2);
		expect(againY).toBe(toY);
		answers[1].resolve(true);
		expect(await toY).toBe('applied');
		answers[0].resolve(true);
		expect(await toX).toBe('stale');
		expect(applied).toEqual(['y']);
	});
});

// PR #681 review (Codex P2): two placements whose first step is the same question to
// the same pane (same change, same target) are still different placements - each asks
// on its own; one approval is never used for the other, and the one approved second
// is stale once the first applied.
describe('placements whose first step is the same are told apart (#666)', () => {
	/** `a` put into the tab group t as its active tab: x is pushed out (a tab switch). */
	const preview = () => ({
		type: 'tabs' as const,
		id: 't',
		activeIndex: 2,
		children: [
			{ type: 'panel' as const, id: 'x', title: 'X' },
			{ type: 'panel' as const, id: 'y', title: 'Y' },
			{ type: 'panel' as const, id: 'a', title: 'A' }
		]
	});

	it('each is asked; the first approved applies, the other is stale', async () => {
		const answers: ((ok: boolean) => void)[] = [];
		const asked: DockPanelChange[] = [];
		const hook = (c: DockPanelChange) => {
			asked.push(c);
			return c.kind === 'tab-switch' ? new Promise<boolean>((r) => answers.push(r)) : true;
		};
		const { dock, lifecycle } = setup({ hook });
		const applied: string[] = [];
		const withDock = lifecycle.requestPlacement(
			'a',
			() => ({ kind: 'dock', panelId: 'a', remount: true }),
			preview,
			() => {
				applied.push('with-dock');
				dock.setActiveTab('t', 1); // a structure change, as a real placement would make
			},
			'T'
		);
		const without = lifecycle.requestPlacement(
			'a',
			() => null,
			preview,
			() => applied.push('without'),
			'T'
		);
		const again = lifecycle.requestPlacement(
			'a',
			() => null,
			preview,
			() => applied.push('again'),
			'T'
		);
		expect(again).toBe(without);
		expect(asked.map((c) => c.kind)).toEqual(['tab-switch', 'tab-switch']);
		answers[0](true);
		expect(await withDock).toBe('applied');
		expect(asked.map((c) => c.kind)).toEqual(['tab-switch', 'tab-switch', 'dock']);
		answers[1](true);
		expect(await without).toBe('stale');
		expect(applied).toEqual(['with-dock']);
	});
});

describe('dispose resolves every waiting request (review 6)', () => {
	it('a hook promise that never settles resolves disposed and lets go of apply', async () => {
		const apply = vi.fn();
		const { lifecycle } = setup({ hook: () => new Promise<boolean>(() => {}) });
		const close = lifecycle.close('a');
		const other = lifecycle.request({ kind: 'close', panelId: 'b' }, apply);
		lifecycle.dispose();
		expect(await close).toBe('disposed');
		expect(await other).toBe('disposed');
		expect(apply).not.toHaveBeenCalled();
		expect(await lifecycle.close('a')).toBe('disposed');
	});
});

describe('a late approval does not push out a newer held request (PR #448 re-review)', () => {
	function hookFor(answerA: Promise<boolean>) {
		return vi.fn((change: DockPanelChange) =>
			'panelId' in change && change.panelId === 'a' ? answerA : true
		);
	}

	it('a stale A approved late leaves the current held B in place, and B applies on resume', async () => {
		let deferring = false;
		const answerA = deferred<boolean>();
		const { dock, lifecycle } = setup({
			hook: hookFor(answerA.promise),
			deferred: () => deferring
		});
		const a = lifecycle.close('a');
		dock.setActiveTab('t', 1); // another structure change: A's request is now stale
		deferring = true;
		const b = lifecycle.close('b'); // held under the current generation
		answerA.resolve(true);
		expect(await a).toBe('stale');
		deferring = false;
		lifecycle.resumeDeferred();
		expect(await b).toBe('applied');
		expect(winOf(dock, 'b').open).toBe(false);
		expect(winOf(dock, 'a').open).toBe(true);
	});

	it('an older current approval arriving after a newer held request is the one superseded', async () => {
		let deferring = false;
		const answerA = deferred<boolean>();
		const { dock, lifecycle } = setup({
			hook: hookFor(answerA.promise),
			deferred: () => deferring
		});
		const a = lifecycle.close('a');
		deferring = true;
		const b = lifecycle.close('b');
		answerA.resolve(true);
		expect(await a).toBe('superseded');
		deferring = false;
		lifecycle.resumeDeferred();
		expect(await b).toBe('applied');
		expect(winOf(dock, 'a').open).toBe(true);
	});
});

// #682: taking a docked pane out of the tree (hide / close / undock) shrinks a
// split or tab group; the pane that is left is mounted again, so it is asked
// first (`reparent`, cause = the leaving pane), then the leaving pane itself.
describe('a pane leaving the docked tree asks the pane that is left (#682)', () => {
	const shrinking = (): DockLayout => ({
		version: 4,
		floating: [],
		docked: {
			type: 'split',
			id: 's',
			direction: 'row',
			sizes: [0.5, 0.5],
			children: [
				{
					type: 'tabs',
					id: 't',
					activeIndex: 0,
					children: [
						{ type: 'panel', id: 'x', title: 'X' },
						{ type: 'panel', id: 'y', title: 'Y' }
					]
				},
				{ type: 'panel', id: 'p', title: 'P' }
			]
		}
	});

	type Path = 'close' | 'hide' | 'undock';
	const paths: Path[] = ['close', 'hide', 'undock'];

	function make(
		options: Parameters<typeof setup>[0],
		initial: DockLayout = shrinking()
	): {
		dock: DockState;
		lifecycle: PanelLifecycle;
		run: (id: string, path: Path) => Promise<string>;
	} {
		const dock = createDockState(initial);
		const lifecycle = new PanelLifecycle(dock, () => ({
			beforePanelChange: options.hook,
			keepMounted: options.keepMounted,
			isStructureChangeDeferred: options.deferred
		}));
		detach = lifecycle.attach();
		const run = (id: string, path: Path): Promise<string> =>
			path === 'close'
				? lifecycle.close(id)
				: path === 'hide'
					? lifecycle.hide(id)
					: lifecycle.requestRemoval(
							id,
							() => ({ kind: 'undock', panelId: id, remount: true }),
							() => dock.undockPanel(id),
							'undock'
						);
		return { dock, lifecycle, run };
	}
	const ids = (dock: DockState) => collectPanelIds(dock.layout.docked);
	const label = (c: DockPanelChange) =>
		c.kind === 'reparent'
			? `reparent ${c.panelId}<-${c.cause}`
			: `${c.kind} ${'panelId' in c ? c.panelId : ''}`;

	describe.each(paths)('%s', (path) => {
		it('refused: only the left pane is asked, nothing changes', async () => {
			const calls: string[] = [];
			const { dock, run } = make({ hook: (c) => (calls.push(label(c)), false) });
			const before = dock.serialize();
			expect(await run('p', path)).toBe('refused');
			expect(calls).toEqual(['reparent x<-p']);
			expect(dock.serialize()).toBe(before);
		});

		it('allowed: the left pane first, the leaving pane last, then applied', async () => {
			const calls: string[] = [];
			const { dock, run } = make({ hook: (c) => (calls.push(label(c)), true) });
			expect(await run('p', path)).toBe('applied');
			expect(calls).toEqual(['reparent x<-p', `${path} p`]);
			expect(ids(dock)).toEqual(['x', 'y']);
		});

		it('the leaving pane refusing last changes nothing', async () => {
			const { dock, run } = make({ hook: (c) => c.kind === 'reparent' });
			const before = dock.serialize();
			expect(await run('p', path)).toBe('refused');
			expect(dock.serialize()).toBe(before);
		});

		it('held for IME composition, asked and applied after resume', async () => {
			let deferring = true;
			const calls: string[] = [];
			const { dock, lifecycle, run } = make({
				hook: (c) => (calls.push(label(c)), true),
				deferred: () => deferring
			});
			const pending = run('p', path);
			expect(calls).toEqual([]);
			expect(ids(dock)).toEqual(['x', 'y', 'p']);
			deferring = false;
			lifecycle.resumeDeferred();
			expect(await pending).toBe('applied');
			expect(calls).toEqual(['reparent x<-p', `${path} p`]);
			expect(ids(dock)).toEqual(['x', 'y']);
		});

		it('the structure changing while an answer is awaited is stale', async () => {
			const answer = deferred<boolean>();
			const { dock, run } = make({ hook: () => answer.promise });
			const pending = run('p', path);
			dock.setActiveTab('t', 1);
			answer.resolve(true);
			expect(await pending).toBe('stale');
			expect(ids(dock)).toEqual(['x', 'y', 'p']);
		});

		it('the leaving pane gone while waiting is stale', async () => {
			const answer = deferred<boolean>();
			const { dock, run } = make({ hook: () => answer.promise });
			const pending = run('p', path);
			dock.undockPanel('p');
			answer.resolve(true);
			expect(await pending).toBe('stale');
		});

		it('a split of three or more: nobody is mounted again, only the leaving pane is asked', async () => {
			const three: DockLayout = {
				version: 4,
				floating: [],
				docked: {
					type: 'split',
					id: 's',
					direction: 'row',
					sizes: [0.4, 0.3, 0.3],
					children: [
						{ type: 'panel', id: 'p', title: 'P' },
						{ type: 'panel', id: 'q', title: 'Q' },
						{ type: 'panel', id: 'r', title: 'R' }
					]
				}
			};
			const calls: string[] = [];
			const { dock, run } = make({ hook: (c) => (calls.push(label(c)), true) }, three);
			expect(await run('p', path)).toBe('applied');
			expect(calls).toEqual([`${path} p`]);
			expect(ids(dock)).toEqual(['q', 'r']);
		});

		it('a tab group of three or more: asked only about the leaving pane', async () => {
			const tabs: DockLayout = {
				version: 4,
				floating: [],
				docked: {
					type: 'tabs',
					id: 't',
					activeIndex: 0,
					children: [
						{ type: 'panel', id: 'x', title: 'X' },
						{ type: 'panel', id: 'y', title: 'Y' },
						{ type: 'panel', id: 'z', title: 'Z' }
					]
				}
			};
			const calls: string[] = [];
			const { run } = make(
				{ hook: (c) => (calls.push(label(c)), true), keepMounted: () => true },
				tabs
			);
			expect(await run('x', path)).toBe('applied');
			expect(calls).toEqual([`${path} x`]);
		});

		it('a tab group of two shrinks to a bare pane: a keepMounted left tab is asked, one that is not mounted is not', async () => {
			const pair: DockLayout = {
				version: 4,
				floating: [],
				docked: {
					type: 'tabs',
					id: 't',
					activeIndex: 0,
					children: [
						{ type: 'panel', id: 'x', title: 'X' },
						{ type: 'panel', id: 'y', title: 'Y' }
					]
				}
			};
			const kept: string[] = [];
			const a = make({ hook: (c) => (kept.push(label(c)), true), keepMounted: () => true }, pair);
			expect(await a.run('x', path)).toBe('applied');
			expect(kept).toEqual(['reparent y<-x', `${path} x`]);
			detach?.();
			const plain: string[] = [];
			const b = make({ hook: (c) => (plain.push(label(c)), true) }, pair);
			expect(await b.run('x', path)).toBe('applied');
			expect(plain).toEqual([`${path} x`]);
		});
	});

	it('a pane that is not docked keeps the old single request', async () => {
		const calls: string[] = [];
		const floatingOnly: DockLayout = {
			version: 4,
			floating: [{ id: 'a', title: 'A', x: 0, y: 0, width: 100, height: 100, open: true }],
			docked: null
		};
		const { run } = make({ hook: (c) => (calls.push(label(c)), true) }, floatingOnly);
		expect(await run('a', 'close')).toBe('applied');
		expect(calls).toEqual(['close a']);
	});
});

describe('replacements to different layouts are told apart (PR #723 review)', () => {
	/** The floating pane a docked on one side or the other of t: the same list of changes. */
	const sided = (side: 'left' | 'right'): DockLayout => {
		const a = { type: 'panel' as const, id: 'a', title: 'A' };
		const t = layout().docked!;
		return {
			version: 4,
			floating: layout().floating.filter((w) => w.id !== 'a'),
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.5, 0.5],
				children: side === 'left' ? [a, t] : [t, a]
			}
		};
	};

	it('each is asked; the first approved applies, the other is stale', async () => {
		const answers: ((ok: boolean) => void)[] = [];
		const asked: DockPanelChange[] = [];
		const hook = (c: DockPanelChange) => {
			asked.push(c);
			return new Promise<boolean>((r) => answers.push(r));
		};
		const { dock, lifecycle } = setup({ hook });
		const left = sided('left');
		const right = sided('right');
		const toLeft = lifecycle.requestReplace(
			() => left,
			(l) => (dock.layout = l)
		);
		const toRight = lifecycle.requestReplace(
			() => right,
			(l) => (dock.layout = l)
		);
		// The same replacement while it is asked shares the pending one.
		expect(
			lifecycle.requestReplace(
				() => sided('left'),
				(l) => (dock.layout = l)
			)
		).toBe(toLeft);
		expect(asked.length).toBe(2);
		expect(JSON.stringify(asked[0])).toBe(JSON.stringify(asked[1]));
		while (answers.length > 0) {
			answers.shift()!(true);
			await nextTask();
		}
		// Both approved: the one applied first wins, the other finds the structure changed.
		expect(await toLeft).toBe('applied');
		expect(await toRight).toBe('stale');
		expect(dock.layout.docked).toMatchObject({ children: [{ id: 'a' }, { id: 't' }] });
	});

	it('a preview that gives another layout later makes it stale', async () => {
		const answers: ((ok: boolean) => void)[] = [];
		const { dock, lifecycle } = setup({
			hook: () => new Promise<boolean>((r) => answers.push(r))
		});
		let next = sided('left');
		const before = structureKey(dock.layout);
		const outcome = lifecycle.requestReplace(
			() => next,
			(l) => (dock.layout = l)
		);
		next = sided('right');
		answers.splice(0).forEach((r) => r(true));
		expect(await outcome).toBe('stale');
		expect(structureKey(dock.layout)).toBe(before);
	});
});

describe('guarded: the caller retires a request it no longer wants (PR #723 re-review)', () => {
	it('a guard that turns false before the answer makes the request stale', async () => {
		const answer = deferred<boolean>();
		const { dock, lifecycle } = setup({ hook: () => answer.promise });
		let wanted = true;
		const close = lifecycle.guarded(
			() => wanted,
			() => lifecycle.close('a')
		);
		wanted = false;
		answer.resolve(true);
		expect(await close).toBe('stale');
		expect(winOf(dock, 'a').open).toBe(true);
	});

	it('every step of a sequence keeps the guard (requestReplace)', async () => {
		const answers: ((ok: boolean) => void)[] = [];
		const { dock, lifecycle } = setup({
			hook: () => new Promise<boolean>((r) => answers.push(r))
		});
		const next: DockLayout = { ...layout(), floating: [] };
		let wanted = true;
		const replace = lifecycle.guarded(
			() => wanted,
			() =>
				lifecycle.requestReplace(
					() => next,
					(l) => (dock.layout = l)
				)
		);
		await nextTask();
		answers.shift()!(true);
		await nextTask();
		// The second step (pane b) is asked; the caller gives up before its answer.
		expect(answers.length).toBe(1);
		wanted = false;
		answers.shift()!(true);
		expect(await replace).toBe('stale');
		expect(dock.layout.floating.map((w) => w.id)).toEqual(['a', 'b']);
	});

	it('a replacement with nothing to ask still honours the guard (PR #723 re-review 3)', async () => {
		const hook = vi.fn(() => true);
		const { dock, lifecycle } = setup({ hook });
		// Only a floating window's position differs: no pane is asked.
		const next: DockLayout = {
			...layout(),
			floating: layout().floating.map((w) => (w.id === 'a' ? { ...w, x: 200 } : w))
		};
		const outcome = lifecycle.guarded(
			() => false,
			() =>
				lifecycle.requestReplace(
					() => next,
					(l) => (dock.layout = l)
				)
		);
		expect(await outcome).toBe('stale');
		expect(hook).not.toHaveBeenCalled();
		expect(winOf(dock, 'a').x).toBe(40);
		// The same replacement still wanted applies without asking.
		const applied = lifecycle.guarded(
			() => true,
			() =>
				lifecycle.requestReplace(
					() => next,
					(l) => (dock.layout = l)
				)
		);
		expect(await applied).toBe('applied');
		expect(winOf(dock, 'a').x).toBe(200);
	});
});
