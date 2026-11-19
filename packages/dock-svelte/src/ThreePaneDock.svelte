<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { ThreePaneExtraPanelDef } from './threePane';

	/** A pane besides the three (three-pane-dock-plan §4.9): its definition and its content. */
	export interface ThreePaneExtraPanel extends ThreePaneExtraPanelDef {
		content: Snippet;
	}
</script>

<script lang="ts">
	/**
	 * The three-pane screen on a `DockHost` (#663 ④, docs/design/three-pane-dock-plan.md §4.1 /
	 * §4.2 / §4.4 / §4.7 / §4.8 / §4.9): the same `left` / `children` (centre) / `right` snippets as
	 * `@banto/ui`'s fixed `ThreePaneLayout`, as dock panes the user can float, re-dock, tab and
	 * auto-hide, plus the app's own extra panels (`panels`).
	 *
	 * - The centre is the main region: `persistent` (its DOM is never re-mounted by the dock, plan
	 *   §4.2 C) and its capabilities say no `close` / `move` / `undock` / `dropCenter` / `autoHide`
	 *   / `collapse`, whatever the app's `capabilities` say. A restored layout that hides it is
	 *   repaired (`reconcileThreePaneLayout`).
	 * - One state: whether a pane is shown is `dock.panels`' `visible`. `leftOpen` / `rightOpen`
	 *   mirror it (written back after every change); writing them asks for the change like
	 *   `setVisible`, and a refused change writes the real state back.
	 * - Every method goes through `DockHost` (`setPanelVisible` / `movePanel` / `replaceLayout`), so
	 *   `beforePanelChange` is asked; nothing here assigns `dock.layout` after the first render
	 *   except the measured default's shares and today's titles / panel set (no structure change of
	 *   a mounted pane).
	 * - Saving is the app's (plan §4.4, PR-5): pass the saved value as `initialLayout` (or restore
	 *   later with `restoreLayout`), and save `layoutSnapshot()` when `dock.layout` changes.
	 *
	 * Not yet (later PRs of the plan): the narrow display and `arrange={false}` (§4.5).
	 */
	import { onMount, untrack } from 'svelte';
	import DockHost from './DockHost.svelte';
	import type { GestureCancelReason, GestureKind } from './core/gesture.svelte';
	import type { ClampOptions } from './core/geometry';
	import type { DockPanelChange, DockPanelChangeOutcome } from './core/lifecycle';
	import {
		titleBarFocusTarget,
		type DockMoveOutcome,
		type DockMoveTarget
	} from './core/move.svelte';
	import type { DockCapabilities } from './core/policy';
	import { createDockState, type DockState } from './state.svelte';
	import {
		assertExtraPanelIds,
		defaultThreePaneDockMessages,
		reconcileThreePaneLayout,
		THREE_PANE_IDS,
		threePaneDockLayout,
		threePaneSavedLayout,
		type ThreePaneDockLayoutOptions,
		type ThreePaneDockMessages,
		type ThreePanePanels,
		type ThreePaneRestoreStatus,
		type ThreePaneSavedLayout,
		type ThreePaneViewMenuItem,
		type ThreePaneViewMenuLabels
	} from './threePane';
	import type { DockEdge, DockLayout, PanelContent } from './types';

	interface Props {
		/** Left pane (pick the target). Omitted = no left pane. */
		left?: Snippet;
		/** Right pane (the selected row's details). Omitted = no right pane. */
		right?: Snippet;
		/** The centre (the main region). */
		children: Snippet;
		/** The left pane is shown (bindable; the View menu's checkbox). Its value at mount is the default layout's. Default `true`. */
		leftOpen?: boolean;
		/** Same for the right pane. */
		rightOpen?: boolean;
		/** Default-layout width of the left pane in px (saved as a share). Default 280. */
		leftWidth?: number;
		/** Default-layout width of the right pane in px. Default 360. */
		rightWidth?: number;
		/** Panes besides the three (plan §4.9). An id equal to `left` / `center` / `right`, or used twice, throws. */
		panels?: ThreePaneExtraPanel[];
		/**
		 * The layout state (created when omitted; pass your own to watch `dock.layout` for saving).
		 * Read once: fixed for the component's lifetime, like `DockHost`'s.
		 */
		dock?: DockState;
		/**
		 * A saved layout to start from (`ThreePaneSavedLayout`, a bare `DockLayout`, or either as JSON
		 * text), reconciled with today's panes (`reconcileThreePaneLayout`). Read once, at mount.
		 * Omitted = `dock`'s layout when it has one, else the default layout.
		 */
		initialLayout?: unknown;
		/** Called once at mount with how the starting layout was obtained. */
		onRestore?: (status: ThreePaneRestoreStatus | 'fresh') => void;
		/** i18n layer 1 (conventions §13): `DockMessages` plus the panes' names. */
		messages?: Partial<ThreePaneDockMessages>;
		iconContent?: Snippet<[string]>;
		onPopOut?: (content: PanelContent) => void;
		clamp?: ClampOptions;
		/** Per-pane capabilities, passed to `DockHost`. The centre's are fixed (module doc). */
		capabilities?: (panelId: string) => DockCapabilities | undefined;
		canStartGesture?: (kind: GestureKind, panelId: string | null) => boolean;
		onGestureEnd?: (
			kind: GestureKind,
			outcome: 'commit' | 'cancel',
			reason?: GestureCancelReason
		) => void;
		isEscapeBlocked?: (activeLayer: HTMLElement | null) => boolean;
		beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
		keepMounted?: (panelId: string) => boolean;
		/** Panes kept by moving their DOM (`DockHost`'s `persistent`). The centre always is (plan §9 Q6). */
		persistent?: (panelId: string) => boolean;
		isStructureChangeDeferred?: () => boolean;
	}

	let {
		left,
		right,
		children,
		leftOpen = $bindable(true),
		rightOpen = $bindable(true),
		leftWidth,
		rightWidth,
		panels = [],
		dock: dockProp,
		initialLayout,
		onRestore,
		messages = {},
		iconContent,
		onPopOut,
		clamp,
		capabilities,
		canStartGesture,
		onGestureEnd,
		isEscapeBlocked,
		beforePanelChange,
		keepMounted,
		persistent,
		isStructureChangeDeferred
	}: Props = $props();

	// svelte-ignore state_referenced_locally
	const dock: DockState = dockProp ?? createDockState();
	const CENTER = THREE_PANE_IDS.center;
	/** The centre is the main region (plan §4.2 A, §4.7). */
	const CENTER_CAPS: DockCapabilities = {
		close: false,
		move: false,
		undock: false,
		dropCenter: false,
		autoHide: false,
		collapse: false
	};

	const t = $derived({ ...defaultThreePaneDockMessages, ...messages });

	/** Today's panes (throws for a reserved / duplicated extra id). */
	const defs = $derived.by((): ThreePanePanels => {
		const extra = panels.map(({ content: _content, ...def }) => def);
		assertExtraPanelIds(extra);
		return {
			left: left ? { title: t.threePaneLeft() } : null,
			center: { title: t.threePaneCenter() },
			right: right ? { title: t.threePaneRight() } : null,
			extra
		};
	});

	let rootEl: HTMLDivElement | undefined = $state();
	let host: ReturnType<typeof DockHost> | undefined = $state();

	// The default layout's open sides are the values at mount (`resetLayout` goes back to them).
	const defaultOpen = untrack(() => ({ left: leftOpen, right: rightOpen }));

	function layoutOptions(hostWidth: number, hostHeight?: number): ThreePaneDockLayoutOptions {
		return {
			hostWidth,
			hostHeight,
			leftWidth,
			rightWidth,
			panels: defs,
			leftOpen: defaultOpen.left,
			rightOpen: defaultOpen.right
		};
	}

	function hostSize(): { width: number; height: number } {
		return { width: rootEl?.clientWidth ?? 0, height: rootEl?.clientHeight ?? 0 };
	}

	const isEmpty = (l: DockLayout) =>
		l.docked === null && l.floating.length === 0 && (l.autoHidden?.length ?? 0) === 0;

	/** The `*Open` values last written or seen here: a different value is the app asking (declared before the first `writeOpen`). */
	const seen = { left: untrack(() => leftOpen), right: untrack(() => rightOpen) };

	// --- the starting layout (before the first render, so nothing is mounted twice) ---
	/** The default layout this component installed and nobody changed yet (its shares are re-measured at mount). */
	let installedDefault: DockLayout | null = null;
	untrack(() => {
		const options = layoutOptions(0);
		let status: ThreePaneRestoreStatus | 'fresh';
		if (initialLayout === undefined && isEmpty(dock.layout)) {
			dock.layout = threePaneDockLayout(options);
			status = 'fresh';
		} else {
			const result = reconcileThreePaneLayout(initialLayout ?? dock.layout, options);
			dock.layout = result.layout;
			status = result.status;
		}
		if (status === 'fresh' || status === 'default') installedDefault = dock.layout;
		writeOpen();
		onRestore?.(status);
	});

	onMount(() => {
		// The default layout's shares come from the measured width (plan §4.1: px -> share).
		const { width, height } = hostSize();
		if (width > 0 && installedDefault !== null && dock.layout === installedDefault) {
			dock.layout = threePaneDockLayout(layoutOptions(width, height));
		}
		installedDefault = null;
	});

	// Today's panes and titles (a locale change renames them; an extra panel added / removed).
	// Only titles and panes that are not mounted change, so nothing is asked.
	$effect(() => {
		const options = layoutOptions(0);
		untrack(() => {
			const result = reconcileThreePaneLayout(dock.layout, options);
			if (result.status === 'default') return;
			if (JSON.stringify(result.layout) !== JSON.stringify(dock.layout))
				dock.layout = result.layout;
		});
	});

	// --- leftOpen / rightOpen: one state with `dock.panels` (plan §4.1, `writeOpen` below) ---

	function writeOpen(): void {
		const l = isVisible(THREE_PANE_IDS.left);
		const r = isVisible(THREE_PANE_IDS.right);
		if (left) {
			seen.left = l;
			if (leftOpen !== l) leftOpen = l;
		}
		if (right) {
			seen.right = r;
			if (rightOpen !== r) rightOpen = r;
		}
	}

	// dock -> props.
	$effect(() => {
		// Read both before any branch (conventions §8).
		const panes = dock.panels;
		void panes;
		untrack(writeOpen);
	});

	// props -> dock: the app wrote `leftOpen` / `rightOpen`.
	$effect(() => {
		const wantLeft = leftOpen;
		const wantRight = rightOpen;
		untrack(() => {
			if (left && wantLeft !== seen.left) {
				seen.left = wantLeft;
				if (wantLeft !== isVisible(THREE_PANE_IDS.left))
					void setVisible(THREE_PANE_IDS.left, wantLeft);
			}
			if (right && wantRight !== seen.right) {
				seen.right = wantRight;
				if (wantRight !== isVisible(THREE_PANE_IDS.right))
					void setVisible(THREE_PANE_IDS.right, wantRight);
			}
		});
	});

	// --- DockHost wiring ---
	const paneCaps = (id: string): DockCapabilities | undefined =>
		id === CENTER ? { ...capabilities?.(id), ...CENTER_CAPS } : capabilities?.(id);
	const panePersistent = (id: string): boolean => id === CENTER || persistent?.(id) === true;

	/** Is `id` one of today's panes? */
	function known(id: string): boolean {
		if (id === THREE_PANE_IDS.left) return !!left;
		if (id === THREE_PANE_IDS.right) return !!right;
		return id === CENTER || panels.some((p) => p.id === id);
	}

	function titleOf(id: string): string {
		if (id === THREE_PANE_IDS.left) return t.threePaneLeft();
		if (id === THREE_PANE_IDS.right) return t.threePaneRight();
		if (id === CENTER) return t.threePaneCenter();
		return panels.find((p) => p.id === id)?.title ?? id;
	}

	/** The outer edge a pane goes to when its remembered place is gone (`dockBack`). */
	function homeEdge(id: string): DockEdge | null {
		if (id === THREE_PANE_IDS.left) return 'left';
		if (id === THREE_PANE_IDS.right) return 'right';
		const initial = panels.find((p) => p.id === id)?.initial;
		return typeof initial === 'object' ? initial.edge : null;
	}

	function focusInside(): boolean {
		const active = document.activeElement;
		return !!rootEl && !!active && rootEl.contains(active);
	}

	/** A focus the change dropped (it was inside, now on `<body>`) goes to the centre; one taken elsewhere stays. */
	function repairFocus(wasInside: boolean): void {
		if (!wasInside || !rootEl?.isConnected) return;
		const now = document.activeElement;
		if (now && now !== document.body) return;
		const hostEl = rootEl.querySelector<HTMLElement>('[data-dock-host]');
		if (hostEl) titleBarFocusTarget(hostEl, CENTER)?.focus();
	}

	// --- the API (plan §4.1): every change goes through DockHost and `beforePanelChange` ---

	/** Is the pane on screen (`dock.panels`' `visible`: docked, auto-hidden or an open window)? Reactive. */
	export function isVisible(id: string): boolean {
		return dock.panels.some((p) => p.id === id && p.visible);
	}

	/**
	 * Show / hide a pane (`DockHost.setPanelVisible`): `refused` for the centre's hide, `unavailable`
	 * for an unknown id or before mount. A focus the hide dropped goes to the centre. Two calls for
	 * the same change while it is asked share the one request.
	 */
	export async function setVisible(
		id: string,
		visible: boolean
	): Promise<DockPanelChangeOutcome | 'unavailable'> {
		if (!known(id) || !host) {
			writeOpen();
			return 'unavailable';
		}
		const wasInside = focusInside();
		const outcome = await host.setPanelVisible(id, visible);
		writeOpen();
		if (outcome === 'applied' && !visible) {
			await Promise.resolve();
			repairFocus(wasInside);
		}
		return outcome;
	}

	/** `setVisible(id, !isVisible(id))`, read when called (a repeat while it is asked asks the same change). */
	export function toggle(id: string): Promise<DockPanelChangeOutcome | 'unavailable'> {
		return setVisible(id, !isVisible(id));
	}

	/** Move a pane (`DockHost.movePanel`, the "panel actions" menu's path). The centre never moves (`unavailable`). */
	export async function move(id: string, target: DockMoveTarget): Promise<DockMoveOutcome> {
		if (!known(id) || !host) return 'unavailable';
		const outcome = await host.movePanel(id, target);
		writeOpen();
		return outcome;
	}

	/** Float a docked pane as a window (`move(id, { float: true })`). */
	export function float(id: string): Promise<DockMoveOutcome> {
		return move(id, { float: true });
	}

	/**
	 * Dock an open floating pane back: to where it was floated from (`{ back: true }`), or - when that
	 * place is gone or was never known (floated before this mount, #721: every pane of its container
	 * was taken out) - along its home edge (`left` / `right`, an extra panel's `initial` edge).
	 * `unavailable` (nothing changes) when the pane is not an open floating window or neither move is
	 * offered (an extra panel with no `initial` edge whose place is gone).
	 */
	export function dockBack(id: string): Promise<DockMoveOutcome> {
		if (!known(id) || !host) return Promise.resolve('unavailable');
		if (!dock.layout.floating.some((w) => w.id === id && w.open))
			return Promise.resolve('unavailable');
		if (host.canMovePanel(id, { back: true })) return move(id, { back: true });
		const edge = homeEdge(id);
		if (edge && host.canMovePanel(id, { edge })) return move(id, { edge });
		return Promise.resolve('unavailable');
	}

	/**
	 * Replace the layout with the default (plan §4.4, no confirm dialog - §9 Q3): every pane, its
	 * place, open state and lock, measured at today's width. Asked through `beforePanelChange` for
	 * every pane it takes off the screen or re-mounts (`DockHost.replaceLayout`); a change while it
	 * is asked makes it `stale`. A focus it dropped goes to the centre.
	 */
	export async function resetLayout(): Promise<DockPanelChangeOutcome | 'invalid' | 'unavailable'> {
		if (!host) return 'unavailable';
		const { width, height } = hostSize();
		const outcome = await host.replaceLayout(threePaneDockLayout(layoutOptions(width, height)), {
			focusPanel: CENTER
		});
		writeOpen();
		return outcome;
	}

	/**
	 * Restore a saved layout (`initialLayout`'s forms) after mount, e.g. once the app's settings
	 * arrived: reconciled with today's panes, then installed like `resetLayout`.
	 */
	export async function restoreLayout(saved: unknown): Promise<{
		status: ThreePaneRestoreStatus;
		outcome: DockPanelChangeOutcome | 'invalid' | 'unavailable';
	}> {
		const { width, height } = hostSize();
		const result = reconcileThreePaneLayout(saved, layoutOptions(width, height));
		if (!host) return { status: result.status, outcome: 'unavailable' };
		const outcome = await host.replaceLayout(result.layout, { focusPanel: CENTER });
		writeOpen();
		return { status: result.status, outcome };
	}

	/** The value to save now (plan §4.4). */
	export function layoutSnapshot(): ThreePaneSavedLayout {
		return threePaneSavedLayout(dock.layout);
	}

	/**
	 * Items of a View menu (plan §4.8): a checkbox per pane - left, right, then the extra panels; not
	 * the centre - checked from `dock.panels`, a separator, and "reset layout". Structurally
	 * `@banto/ui`'s `HeaderNavMenuItem[]`. Reactive (call it in a `$derived`).
	 */
	export function viewMenuItems(labels: ThreePaneViewMenuLabels): ThreePaneViewMenuItem[] {
		const ids = [
			...(left ? [THREE_PANE_IDS.left] : []),
			...(right ? [THREE_PANE_IDS.right] : []),
			...panels.map((p) => p.id)
		];
		return [
			...ids.map((id): ThreePaneViewMenuItem => ({
				kind: 'checkbox',
				id: `panel:${id}`,
				label: titleOf(id),
				checked: isVisible(id),
				onSelect: () => void toggle(id)
			})),
			{ kind: 'separator', id: 'separator' },
			{
				kind: 'action',
				id: 'reset-layout',
				label: labels.resetLayout,
				onSelect: () => void resetLayout()
			}
		];
	}
</script>

<div class="three-pane-dock" bind:this={rootEl}>
	<DockHost
		bind:this={host}
		{dock}
		{panel}
		{iconContent}
		{onPopOut}
		messages={t}
		{clamp}
		capabilities={paneCaps}
		{canStartGesture}
		{onGestureEnd}
		{isEscapeBlocked}
		{beforePanelChange}
		{keepMounted}
		persistent={panePersistent}
		{isStructureChangeDeferred}
	/>
</div>

{#snippet panel(content: PanelContent)}
	{#if content.id === THREE_PANE_IDS.left}
		{@render left?.()}
	{:else if content.id === CENTER}
		{@render children()}
	{:else if content.id === THREE_PANE_IDS.right}
		{@render right?.()}
	{:else}
		{@const extra = panels.find((p) => p.id === content.id)}
		{#if extra}{@render extra.content()}{/if}
	{/if}
{/snippet}

<style>
	.three-pane-dock {
		position: relative;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}
</style>
