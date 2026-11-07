/**
 * Injected cell editors (date-time-pickers §5.8, D1-a / D3-a): the app hands
 * the grid the picker components, the grid never imports them (conventions
 * §4, shared-primitives-upstream-plan §2.1 - "the app connects the two"). The
 * counterpart of @banto/forms' `provideFieldInputs`.
 *
 * - `provideCellEditors({ date })` in a layout puts them in the component
 *   context for every `BantoGrid` below it; the `cellEditors` prop of one
 *   grid overrides it, per editor type.
 * - A type with no injected component keeps the native input
 *   (`<input type="date">`), so the grid used on its own still works (D3-a).
 *
 * `CellDateEditorProps` is a STRUCTURAL description of what the grid passes
 * - the subset of `@banto/ui`'s `DateInput` props it uses (§5.2), so
 * `DateInput` (or an app wrapper that adds `messages` / `locale`) fits as is.
 * The grid keeps its edit state machine (`BantoGrid.svelte`) and relies on
 * the component keeping §5.8's promises: keys inside its popover do not
 * propagate and Esc there closes only the popover; keys the text box handles
 * itself are `preventDefault`ed before `onkeydown`; `onblur` fires only when
 * focus leaves the whole component; `pointerdown` does not propagate out of
 * it (the grid also stops it on its own wrapper). The time / datetime
 * entries come with their field types (date-time-pickers PR-5).
 */
import { getContext, setContext, type Component } from 'svelte';

/** Props the grid passes to an injected date editor (a subset of `@banto/ui` `DateInput`'s, §5.2). */
export interface CellDateEditorProps {
	/** The draft as a day: canonical `YYYY-MM-DD`, or `null` while the text is not one. */
	value?: string | null;
	/** The component's committed value (the grid reads the text instead, `onTextInput`). */
	onValueChange?: (value: string | null) => void;
	/** The cell's draft text, owned by the grid. */
	text?: string;
	/** Every change of the typed text, including the canonical rewrite and a picked day. */
	onTextInput?: (text: string) => void;
	/** Accessible name of the text box (the column header). */
	label?: string;
	/** Extra ids for the text box's `aria-describedby` (the cell's edit error). */
	describedBy?: string;
	invalid?: boolean;
	/** True while the commit is being saved: the calendar must not open. */
	readonly?: boolean;
	/** Earliest day (canonical, inclusive): `GridColumn.editorMin`. */
	min?: string;
	/** Latest day (canonical, inclusive): `GridColumn.editorMax`. */
	max?: string;
	/** `GridColumn.isDateDisabled`. */
	isDateDisabled?: (date: string) => boolean;
	/** Keys from the text box, after the component handled its own (Enter commits the text first). */
	onkeydown?: (event: KeyboardEvent) => void;
	/** Focus left the whole component, after the text was committed. */
	onblur?: (event: FocusEvent) => void;
	/** The text box (bindable): where the grid puts and returns focus. */
	inputEl?: HTMLInputElement;
}

/** Components the grid renders instead of its native cell inputs, by editor type. */
export interface CellEditors {
	date?: Component<CellDateEditorProps>;
}

const CELL_EDITORS = Symbol('banto-grid-cell-editors');

/**
 * Provide the cell editors for every grid below the calling component (call
 * it during component initialisation, e.g. in a layout's `<script>`).
 * Returns what it set.
 */
export function provideCellEditors(editors: CellEditors): CellEditors {
	return setContext(CELL_EDITORS, editors);
}

/** The cell editors provided above the calling component (`{}` when none). Call during initialisation. */
export function getCellEditors(): CellEditors {
	return getContext<CellEditors | undefined>(CELL_EDITORS) ?? {};
}
