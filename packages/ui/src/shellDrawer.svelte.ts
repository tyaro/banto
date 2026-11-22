/**
 * The shell drawer's open state (#850). Svelte 5 runes, so a `.svelte.ts`
 * source (consumers list `@banto/ui` in `optimizeDeps.exclude`, ADR-0007).
 *
 * Whether the sidebar is a drawer right now is the caller's decision, passed
 * as a getter (`resolveShellNav(...).drawerMode`, or the app's own rule).
 * The state only opens and closes, and closes itself once `isDrawer()` turns
 * false so a drawer left open does not come back at the next narrow width.
 * What stays with the app: the DOM (backdrop, the `inert` / hidden drawer),
 * close-on-navigation and Escape, and where the focus goes.
 *
 * Call it while a component initialises (it registers an effect).
 */

export interface ShellDrawerOptions {
	/** True while the sidebar is shown as a drawer. Read reactively. */
	isDrawer: () => boolean;
}

export interface ShellDrawer {
	readonly open: boolean;
	/** Open or close. Opening is refused (stays closed) while `isDrawer()` is false. */
	toggle(): void;
	close(): void;
}

class ShellDrawerState implements ShellDrawer {
	#open = $state(false);
	readonly #isDrawer: () => boolean;

	constructor(isDrawer: () => boolean) {
		this.#isDrawer = isDrawer;
		$effect(() => {
			if (!this.#isDrawer()) this.#open = false;
		});
	}

	get open(): boolean {
		return this.#open;
	}

	toggle(): void {
		this.#open = this.#open ? false : this.#isDrawer();
	}

	close(): void {
		this.#open = false;
	}
}

export function createShellDrawer(options: ShellDrawerOptions): ShellDrawer {
	return new ShellDrawerState(options.isDrawer);
}
