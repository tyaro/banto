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
	 *   except the measured default's shares and today's titles (no structure change). A change of
	 *   `panels` that changes the structure goes through `replaceLayout` too (`syncPanels`).
	 * - Saving is the app's (plan §4.4, PR-5): pass the saved value as `initialLayout` (or restore
	 *   later with `restoreLayout`), and save `layoutSnapshot()` - not `dock.serialize()` - when
	 *   `dock.layout` changes.
	 * - Narrow (plan §4.5, §9 Q7): at a component width `<= narrowBreakpoint` (or `narrowOverride`)
	 *   the dock shows a temporary layout (`threePaneNarrowLayout`): the centre alone, the shown
	 *   sides in edge bands (their flyout is the drawer), everything else hidden. The layout to save
	 *   is kept aside meanwhile - `layoutSnapshot()` returns it, and changes made while narrow are
	 *   not saved - and comes back when the width does. Both switches go through `replaceLayout`
	 *   (`beforePanelChange` is asked for the panes it moves; the centre is `persistent`, so it is
	 *   never re-mounted); a refused switch keeps the current display until the next crossing. The
	 *   first measurement right after mount installs the narrow display directly (nothing mounted
	 *   has state yet).
	 * - `arrange={false}` (plan §4.5, §9 Q4: kiosk): `DockHost`'s `arrange`, and every method that
	 *   rearranges (`setVisible` / `toggle` / `leftOpen` / `rightOpen` writes / `float` / `dockBack`
	 *   / `move` / `resetLayout`) is refused with nothing changed; `viewMenuItems` is empty.
	 *   `restoreLayout` and the narrow switch still work (they show the saved layout, not the user's).
	 * - Touch: the title-bar and drop-guide buttons follow the density tokens of `@banto/theme`
	 *   (`--banto-dock-button-size`, `--banto-dock-guide-button-size`); nothing to pass here.
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
	import { autoHiddenPanelIds } from './core/autohide';
	import { collectPanelIds, structureKey } from './core/tree';
	import { adoptLayout, createDockState, forgetHomeSlots, type DockState } from './state.svelte';
	import {
		assertExtraPanelIds,
		defaultThreePaneDockMessages,
		isPaneShown,
		isThreePaneNarrow,
		reconcileThreePaneLayout,
		THREE_PANE_IDS,
		THREE_PANE_NARROW_BREAKPOINT,
		threePaneDockLayout,
		threePaneNarrowLayout,
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
		/** Narrow display at this component width (px) or below (plan §4.5). Default 900. */
		narrowBreakpoint?: number;
		/** `true` / `false` forces the narrow / wide display regardless of the width. */
		narrowOverride?: boolean;
		/** Output (bindable): the narrow display is shown now. Read-only for the app. */
		narrow?: boolean;
		/** `false` = the user cannot rearrange the layout (kiosk, plan §4.5 / §9 Q4; module doc). Default `true`. */
		arrange?: boolean;
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
		isStructureChangeDeferred,
		narrowBreakpoint = THREE_PANE_NARROW_BREAKPOINT,
		narrowOverride,
		narrow = $bindable(false),
		arrange = true
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

	// --- the narrow display's state (plan §4.5) ---
	/** The component's measured width (`null` until mounted). */
	let measuredWidth: number | null = $state(null);
	/** The narrow display is on screen (`dock.layout` is the temporary layout). */
	let narrowShown = $state(false);
	/**
	 * The layout to save and to go back to while `narrowShown`. Never rendered, but `$state.raw`: an
	 * app saving `layoutSnapshot()` from an effect on `dock.layout` sees it change too - a reset or
	 * restore while narrow replaces `dock.layout` first and this right after (PR #726 review).
	 */
	let wideLayout: DockLayout | null = $state.raw(null);
	/** `wideLayout` is the untouched default: measured again at the width it comes back at. */
	let wideIsDefault = false;
	/** The display last asked for (the newest wish; an older switch still being asked is `stale` when it differs). */
	let narrowWish: boolean | null = null;
	let narrowGen = 0;

	// --- the starting layout (before the first render, so nothing is mounted twice) ---
	/** The default layout this component installed and nobody changed yet (its shares are re-measured at mount). */
	let installedDefault: DockLayout | null = null;
	untrack(() => {
		const options = layoutOptions(0);
		let status: ThreePaneRestoreStatus | 'fresh';
		if (initialLayout === undefined && isEmpty(dock.layout)) {
			adoptLayout(dock, threePaneDockLayout(options));
			status = 'fresh';
		} else {
			const result = reconcileThreePaneLayout(initialLayout ?? dock.layout, options);
			adoptLayout(dock, result.layout);
			status = result.status;
		}
		if (status === 'fresh' || status === 'default') installedDefault = dock.layout;
		// Narrow forced from the start: shown before anything is mounted.
		if (narrowOverride === true) enterNarrowNow();
		writeOpen();
		onRestore?.(status);
	});

	// --- the narrow display (plan §4.5; its state is declared above the starting layout) ---

	const wantNarrow = $derived(narrowOverride ?? isThreePaneNarrow(measuredWidth, narrowBreakpoint));

	$effect.pre(() => {
		const value = narrowShown;
		untrack(() => {
			if (narrow !== value) narrow = value;
		});
	});

	function narrowOptions(shown?: readonly string[]) {
		const { width, height } = hostSize();
		return { panels: defs, shown, hostWidth: width, hostHeight: height };
	}

	/** Install the narrow display without asking (before / right at mount: nothing has state yet). */
	function enterNarrowNow(): void {
		wideIsDefault = installedDefault !== null && dock.layout === installedDefault;
		// As saved (#739 review): the floated panes' places do not outlive the narrow display.
		wideLayout = dock.savedLayout();
		// ... nor a closed one's, which the narrow display keeps floating (the kept shares do not count it).
		forgetHomeSlots(dock);
		installedDefault = null;
		adoptLayout(dock, threePaneNarrowLayout(wideLayout, narrowOptions()));
		narrowShown = true;
	}

	/** The wide layout to show again: the default measured now, or the kept one fitted to today's panes. */
	function wideTarget(): DockLayout {
		const { width, height } = hostSize();
		const options = layoutOptions(width, height);
		if (wideIsDefault || wideLayout === null) return threePaneDockLayout(options);
		return reconcileThreePaneLayout(wideLayout, options).layout;
	}

	/**
	 * Switch to the narrow / wide display through `DockHost.replaceLayout` (module doc). Applied only
	 * while it is still the newest wish and the layout it was built from is still there; `stale`
	 * (the structure changed meanwhile) is built again from the new layout.
	 */
	async function switchNarrow(want: boolean): Promise<void> {
		narrowWish = want;
		if (!host || want === narrowShown) return;
		const gen = ++narrowGen;
		const current = () => narrowWish === want && gen === narrowGen;
		let outcome: DockPanelChangeOutcome | 'invalid';
		if (want) {
			const base = dock.layout;
			// Kept as saved (#739 review): the floated panes' `homeSlot`s are dropped by the narrow
			// display, so the kept wide layout - saved by `layoutSnapshot` and shown again - must not
			// count them. Taken before the switch, while they are still there.
			const kept = dock.savedLayout();
			outcome = await host.replaceLayout(threePaneNarrowLayout(base, narrowOptions()), {
				focusPanel: CENTER,
				isCurrent: () => current() && dock.layout === base,
				// A closed floated pane stays floating in the narrow display, so its `homeSlot` would
				// survive and be counted again by the kept shares (#739 review): dropped in the same step.
				saved: true
			});
			if (outcome === 'applied') {
				wideLayout = kept;
				wideIsDefault = false;
				narrowShown = true;
			}
		} else {
			const kept = wideLayout;
			outcome = await host.replaceLayout(wideTarget(), {
				focusPanel: CENTER,
				isCurrent: () => current() && wideLayout === kept
			});
			if (outcome === 'applied') {
				wideLayout = null;
				wideIsDefault = false;
				narrowShown = false;
			}
		}
		if (outcome === 'disposed') return;
		writeOpen();
		if (outcome === 'stale' && gen === narrowGen && narrowWish !== null)
			void switchNarrow(narrowWish);
	}

	onMount(() => {
		// The default layout's shares come from the measured width (plan §4.1: px -> share).
		const { width, height } = hostSize();
		if (
			!narrowShown &&
			width > 0 &&
			installedDefault !== null &&
			dock.layout === installedDefault
		) {
			adoptLayout(dock, threePaneDockLayout(layoutOptions(width, height)));
			installedDefault = dock.layout;
		}
		measuredWidth = width > 0 ? width : null;
		// Narrow at the first measurement: installed directly (just mounted, nothing to lose).
		if (
			!narrowShown &&
			narrowOverride === undefined &&
			isThreePaneNarrow(measuredWidth, narrowBreakpoint)
		) {
			enterNarrowNow();
			writeOpen();
		}
		installedDefault = null;
		narrowWish = narrowShown;
		if (typeof ResizeObserver === 'undefined' || !rootEl) return;
		const observer = new ResizeObserver(() => {
			const w = rootEl?.clientWidth ?? 0;
			measuredWidth = w > 0 ? w : null;
		});
		observer.observe(rootEl);
		return () => observer.disconnect();
	});

	// The width (or `narrowOverride`) crossed the breakpoint: switch (declared after `onMount`, so the
	// first run sees its measurement).
	$effect(() => {
		const want = wantNarrow;
		const mounted = host;
		if (!mounted) return;
		untrack(() => {
			if (want !== narrowWish) void switchNarrow(want);
		});
	});

	// Today's panes and titles (a locale change renames them; an extra panel added / removed).
	$effect(() => {
		const options = layoutOptions(0);
		untrack(() => void syncPanels(options));
	});

	/** The newest `syncPanels` (an older one's outcome is not acted on). */
	let panelSync = 0;
	/**
	 * The layout the newest `syncPanels` wants (JSON; `null` = none it can name). A replacement still
	 * being asked is applied only while it is this one (PR #723 review): `panels` changed back while
	 * it waits (today's layout fits again) retires it, a newer sync to the same layout keeps it.
	 */
	let panelTarget: string | null = null;

	/**
	 * Fit `dock.layout` to today's panes (`reconcileThreePaneLayout`). Titles / icons only (the same
	 * structure) are written directly: nothing mounted changes. A structure change (an extra panel
	 * removed - its region gone, the tree around it re-joined - or added) goes through
	 * `DockHost.replaceLayout`, so `beforePanelChange` and the IME hold are honoured. Refused (or
	 * `invalid` / `disposed`): the layout stays as it is - a removed panel keeps its place, empty,
	 * until the next sync (the next change of `panels` or the messages) or `resetLayout` /
	 * `restoreLayout`. `stale` (the structure changed while it was asked): fitted again to the new
	 * layout. A newer sync while one is asked takes over: one to another layout - today's included,
	 * when `panels` changed back - makes the older one `stale` right before it would be applied.
	 */
	async function syncPanels(options: ThreePaneDockLayoutOptions): Promise<void> {
		const gen = ++panelSync;
		// Narrow: the kept wide layout follows today's panes too (not on screen: nothing to ask).
		if (narrowShown && wideLayout !== null && !wideIsDefault) {
			const kept = reconcileThreePaneLayout(wideLayout, options);
			if (kept.status !== 'default') wideLayout = kept.layout;
		}
		const result = reconcileThreePaneLayout(dock.layout, options);
		if (result.status === 'default') {
			panelTarget = null;
			return;
		}
		let next = result.layout;
		// Narrow: a pane new to the layout is docked by the reconcile beside the centre - the narrow
		// display has the centre docked alone (PR #726 review). Built again from the kept wide layout:
		// the panes shown now stay in their bands, a new one goes to its band when the kept layout
		// shows it, else to a closed window. Only while the narrow display is still on screen (a
		// switch back to wide replaces `dock.layout` before `narrowShown` follows).
		const wasNarrow = narrowShown;
		const present = new Set([
			...collectPanelIds(dock.layout.docked),
			...autoHiddenPanelIds(dock.layout),
			...dock.layout.floating.map((w) => w.id)
		]);
		const added = collectPanelIds(next.docked).filter((id) => !present.has(id));
		if (wasNarrow && dock.layout.docked?.type === 'panel' && added.length > 0) {
			const base = wideTarget();
			const ids = [THREE_PANE_IDS.left, THREE_PANE_IDS.right, ...panels.map((p) => p.id)];
			const shown = ids.filter(
				(id) => known(id) && isPaneShown(added.includes(id) ? base : dock.layout, id)
			);
			next = threePaneNarrowLayout(base, narrowOptions(shown));
		}
		const target = JSON.stringify(next);
		panelTarget = target;
		if (target === JSON.stringify(dock.layout)) return;
		if (!host || structureKey(next) === structureKey(dock.layout)) {
			adoptLayout(dock, next);
			return;
		}
		const outcome = await host.replaceLayout(next, {
			focusPanel: CENTER,
			// The display switched while it was asked: what it was built for is gone.
			isCurrent: () => panelTarget === target && narrowShown === wasNarrow
		});
		if (gen !== panelSync || outcome === 'disposed') return;
		writeOpen();
		if (outcome === 'stale') void syncPanels(layoutOptions(0));
	}

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
				wantOpen(THREE_PANE_IDS.left, wantLeft);
			}
			if (right && wantRight !== seen.right) {
				seen.right = wantRight;
				wantOpen(THREE_PANE_IDS.right, wantRight);
			}
		});
	});

	/** The app's newest `leftOpen` / `rightOpen`: asked when it differs from the screen, else it only retires an older request (`wanted`). */
	function wantOpen(id: string, open: boolean): void {
		if (open !== isVisible(id)) void setVisible(id, open);
		else wanted.set(id, open);
	}

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
	 * The newest visibility asked per pane (`setVisible`, `leftOpen` / `rightOpen`). A request still
	 * being asked is applied only while it is the newest wish (PR #723 review): the opposite asked
	 * meanwhile - even when the pane is already there and nothing new is asked - makes it `stale`.
	 */
	const wanted = new Map<string, boolean>();

	/**
	 * Show / hide a pane (`DockHost.setPanelVisible`): `refused` for the centre's hide, `unavailable`
	 * for an unknown id or before mount. A focus the hide dropped goes to the centre. Two calls for
	 * the same change while it is asked share the one request; a call for the opposite while it is
	 * asked makes it `stale` (the newest wins, even when it changes nothing).
	 */
	export async function setVisible(
		id: string,
		visible: boolean
	): Promise<DockPanelChangeOutcome | 'unavailable'> {
		if (!known(id) || !host) {
			writeOpen();
			return 'unavailable';
		}
		if (!arrange) {
			writeOpen();
			return 'refused';
		}
		wanted.set(id, visible);
		const wasInside = focusInside();
		const isCurrent = () => wanted.get(id) === visible;
		if (narrowShown && visible && id !== CENTER && !isVisible(id))
			return revealNarrow(id, isCurrent);
		const outcome = await host.setPanelVisible(id, visible, { isCurrent });
		if (outcome === 'disposed') return outcome;
		writeOpen();
		if (outcome === 'applied' && !visible) {
			await Promise.resolve();
			repairFocus(wasInside);
		}
		return outcome;
	}

	/**
	 * Narrow (plan §4.5): a hidden pane asked to show goes to its edge band and slides out (the
	 * flyout is the drawer), through `replaceLayout`; the other panes keep showing or hidden.
	 */
	async function revealNarrow(
		id: string,
		isCurrent: () => boolean
	): Promise<DockPanelChangeOutcome | 'unavailable'> {
		if (!host) return 'unavailable';
		const ids = [THREE_PANE_IDS.left, THREE_PANE_IDS.right, ...panels.map((p) => p.id)];
		const shown = [...ids.filter((x) => known(x) && isPaneShown(dock.layout, x)), id];
		const next = threePaneNarrowLayout(wideLayout ?? dock.layout, narrowOptions(shown));
		const outcome = await host.replaceLayout(next, {
			focusPanel: CENTER,
			isCurrent: () => isCurrent() && narrowShown
		});
		if (outcome === 'disposed') return outcome;
		if (outcome === 'applied') dock.openFlyout(id);
		writeOpen();
		return outcome === 'invalid' ? 'unavailable' : outcome;
	}

	/** A View menu checkbox: `toggle`, but - narrow - a pane in an edge band slides out (its drawer). */
	function choose(id: string): Promise<unknown> {
		if (narrowShown && arrange && host && dock.isAutoHidden(id)) return host.showPanel(id);
		return toggle(id);
	}

	/** `setVisible(id, !isVisible(id))`, read when called (a repeat while it is asked asks the same change). */
	export function toggle(id: string): Promise<DockPanelChangeOutcome | 'unavailable'> {
		return setVisible(id, !isVisible(id));
	}

	/** Move a pane (`DockHost.movePanel`, the "panel actions" menu's path). The centre never moves (`unavailable`). */
	export async function move(id: string, target: DockMoveTarget): Promise<DockMoveOutcome> {
		if (!known(id) || !host || !arrange) return 'unavailable';
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
		if (!known(id) || !host || !arrange) return Promise.resolve('unavailable');
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
	 * is asked makes it `stale`. A focus it dropped goes to the centre. Narrow: the kept layout
	 * becomes the default (shown when the width comes back) and the narrow display is built again
	 * from it. `refused` when `arrange` is `false`.
	 */
	export async function resetLayout(): Promise<DockPanelChangeOutcome | 'invalid' | 'unavailable'> {
		if (!host) return 'unavailable';
		if (!arrange) return 'refused';
		const { width, height } = hostSize();
		const next = threePaneDockLayout(layoutOptions(width, height));
		return install(next, true);
	}

	/**
	 * Show `next` as the wide layout (`resetLayout` / `restoreLayout`): replaced through
	 * `replaceLayout`, or - narrow - kept for later, with the narrow display built from it.
	 */
	async function install(
		next: DockLayout,
		isDefault: boolean
	): Promise<DockPanelChangeOutcome | 'invalid' | 'unavailable'> {
		if (!host) return 'unavailable';
		const wasNarrow = narrowShown;
		const shown = wasNarrow ? threePaneNarrowLayout(next, narrowOptions()) : next;
		const outcome = await host.replaceLayout(shown, {
			focusPanel: CENTER,
			// The display switched while it was asked: what it was built for is gone.
			isCurrent: () => narrowShown === wasNarrow,
			// A saved (or default) layout, not today's: the floated panes' places go in the same step
			// (#739 review). A live replacement (`syncPanels`) keeps them.
			saved: true
		});
		if (outcome === 'applied' && wasNarrow) {
			wideLayout = next;
			wideIsDefault = isDefault;
		}
		writeOpen();
		return outcome;
	}

	/**
	 * Restore a saved layout (`initialLayout`'s forms) after mount, e.g. once the app's settings
	 * arrived: reconciled with today's panes, then installed like `resetLayout` (also when
	 * `arrange` is `false`: it shows the saved layout, it does not rearrange).
	 */
	export async function restoreLayout(saved: unknown): Promise<{
		status: ThreePaneRestoreStatus;
		outcome: DockPanelChangeOutcome | 'invalid' | 'unavailable';
	}> {
		const { width, height } = hostSize();
		const result = reconcileThreePaneLayout(saved, layoutOptions(width, height));
		if (!host) return { status: result.status, outcome: 'unavailable' };
		const outcome = await install(result.layout, false);
		return { status: result.status, outcome };
	}

	/** The value to save now (plan §4.4): while narrow, the kept wide layout (the narrow display is never saved). */
	export function layoutSnapshot(): ThreePaneSavedLayout {
		// `savedLayout()`, not `layout`: the floated panes' places are not saved (#739 review).
		return threePaneSavedLayout(
			narrowShown && wideLayout !== null ? wideLayout : dock.savedLayout()
		);
	}

	/**
	 * Items of a View menu (plan §4.8): a checkbox per pane - left, right, then the extra panels; not
	 * the centre - checked from `dock.panels`, a separator, and "reset layout". Structurally
	 * `@banto/ui`'s `HeaderNavMenuItem[]`. Reactive (call it in a `$derived`). Narrow: choosing a
	 * pane in an edge band slides it out (a hidden one goes to its band first). Empty when
	 * `arrange` is `false` (plan §4.5: no View menu in a kiosk).
	 */
	export function viewMenuItems(labels: ThreePaneViewMenuLabels): ThreePaneViewMenuItem[] {
		if (!arrange) return [];
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
				onSelect: () => void choose(id)
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
		{arrange}
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
