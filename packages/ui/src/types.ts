import type { Component } from 'svelte';

export type StatusBadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Shape of an icon component accepted by the `icon` props. Any Svelte
 * component taking `size` and `aria-hidden` fits - lucide's components are
 * assignable as-is, so callers keep passing `@lucide/svelte` icons without
 * this package depending on it (docs/adr/0018-shared-ui-package.md §2).
 */
export type UiIconComponent = Component<{
	size?: number;
	'aria-hidden'?: 'true' | 'false' | boolean;
}>;

/** One tab of `Tabs` (#556). */
export interface TabItem {
	/** Unique within the tablist; also the `value` when the tab is selected. */
	id: string;
	label: string;
	/** Drawn before the label; decorative (`aria-hidden`). */
	icon?: UiIconComponent;
	/** Announced but never selected, and skipped by the arrow keys. */
	disabled?: boolean;
}

/**
 * What `Tooltip` hands its `children` snippet to spread on the trigger
 * element (#556): an attachment (under a symbol key) that wires hover / focus,
 * and `aria-describedby` unless the tooltip was told not to describe.
 */
export interface TooltipTriggerProps {
	'aria-describedby'?: string;
	[attachment: symbol]: (element: HTMLElement) => void | (() => void);
}

/** One segment of `SegmentedControl` (#556). */
export interface SegmentedOption<T extends string = string> {
	value: T;
	label: string;
	/** Drawn before the label; decorative (`aria-hidden`). */
	icon?: UiIconComponent;
	disabled?: boolean;
}
