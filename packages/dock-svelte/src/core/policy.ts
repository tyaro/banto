/**
 * Consumer-supplied policy for a `DockHost` (spec §5.2, shared-primitives-
 * upstream-plan §3.2, #434): the clamp options used to keep floating windows
 * reachable, and per-pane capabilities (may it be closed / moved / floated, what may be
 * dropped onto it).
 * `DockHost` publishes it through Svelte context so `DockWindow`, `DockedTree`
 * and the `DragController` read the same values without prop-drilling. No
 * runes here - the getters read the host's props, which are reactive.
 */
import { getContext, setContext } from 'svelte';
import type { ClampOptions } from './geometry';

/**
 * What the UI offers for one pane. Every field defaults to `true`; return
 * `false` to withhold it (e.g. an app's central canvas pane:
 * `{ close: false, move: false }`).
 *
 * These are affordances of the dock UI, not an access-control layer: a
 * programmatic `dock.close(id)` / `dock.move(...)` still works, so an app
 * that must hard-protect a pane also guards its own callers.
 */
export interface DockCapabilities {
	/** Render the close button (✕). `false` hides it. */
	close?: boolean;
	/** Allow user drag of the pane (floating title bar, docked title bar / tab): no move, no re-dock. Resizing a floating window is unaffected. */
	move?: boolean;
	/** Allow a docked pane to be floated or popped out: drop onto free space is ignored (the pane stays docked) and the pop-out button is hidden. Re-docking within the tree is governed by `move`. */
	undock?: boolean;
	/**
	 * As a drop TARGET (#694 PR-2): offer the centre button of the cross guide on this pane, i.e. let
	 * a dragged pane join it as a tab. `false` hides that button (e.g. the main region). On a tab group
	 * the button shows only when every pane in it allows it.
	 */
	dropCenter?: boolean;
	/**
	 * As a drop TARGET (#694 PR-2): offer the up / down / left / right buttons of the cross guide on
	 * this pane, i.e. let a dragged pane split it. `false` hides the four (the host's outer-edge buttons
	 * are not affected). On a tab group the buttons show only when every pane in it allows it.
	 */
	dropSplit?: boolean;
	/**
	 * Offer the pin button on the docked region holding this pane (#694 PR-3): unpinning it
	 * auto-hides the region to a band on the host's edge. `false` hides the button (e.g. the
	 * main region). On a tab group the button shows only when every pane in it allows it.
	 */
	autoHide?: boolean;
}

export interface DockPolicy {
	readonly clamp: ClampOptions | undefined;
	readonly capabilities: ((panelId: string) => DockCapabilities | undefined) | undefined;
}

const NO_POLICY: DockPolicy = { clamp: undefined, capabilities: undefined };

export function resolveCapabilities(
	policy: DockPolicy,
	panelId: string
): Required<DockCapabilities> {
	const c = policy.capabilities?.(panelId);
	return {
		close: c?.close ?? true,
		move: c?.move ?? true,
		undock: c?.undock ?? true,
		dropCenter: c?.dropCenter ?? true,
		dropSplit: c?.dropSplit ?? true,
		autoHide: c?.autoHide ?? true
	};
}

/**
 * Is `panelId` part of the MAIN region (#694 PR-3: the band a region auto-hides to is
 * chosen relative to it)? A pane the app made immovable: `close`, `move` and `undock`
 * all `false`.
 */
export function isMainPane(policy: DockPolicy, panelId: string): boolean {
	const c = resolveCapabilities(policy, panelId);
	return !c.close && !c.move && !c.undock;
}

const POLICY_KEY = Symbol('banto-dock-policy');

/** Called once by `DockHost` during initialization. */
export function setDockPolicy(policy: DockPolicy): void {
	setContext(POLICY_KEY, policy);
}

/** Must be called during a descendant component's initialization. Outside a `DockHost` tree it returns an empty policy (all defaults). */
export function getDockPolicy(): DockPolicy {
	return getContext<DockPolicy | undefined>(POLICY_KEY) ?? NO_POLICY;
}
