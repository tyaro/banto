/**
 * Pure validation of a restored `DockLayout` (spec §5.1: layout JSON
 * serialize/restore; shared-primitives-upstream-plan §3.2, Issue #434).
 *
 * One function is shared by `DockState`'s constructor (object / string
 * initial value), `DockState.hydrate`, and any app that wants to inspect a
 * stored payload before adopting it. It never throws and never mutates its
 * input: on success it returns a v2 layout (a v1 payload is migrated with
 * `docked: null`, split `sizes` are repaired via `normalizeSizes`); on
 * failure it returns every issue found so the caller can reject the payload
 * as a whole instead of adopting part of it.
 *
 * Deliberately NOT checked: whether a panel id is known to the consumer's
 * registry. Unknown ids are kept as-is (the host component / consumer decides
 * at render time), which is a separate policy from structural validity.
 */
import { normalizeCollapsed, normalizeSizes } from './tree';
import type { DockAutoHidden, DockLayout, DockNode, FloatingWindow } from '../types';

export type DockLayoutIssueCode =
	| 'version'
	| 'shape'
	| 'duplicate-id'
	| 'non-finite'
	| 'non-positive-size'
	| 'split-sizes'
	| 'active-index';

export interface DockLayoutIssue {
	readonly code: DockLayoutIssueCode;
	/** Location of the offending value, e.g. `floating[2].width`, `docked.children[1]`. */
	readonly path: string;
}

export type DockLayoutValidation =
	| { readonly ok: true; readonly layout: DockLayout }
	| { readonly ok: false; readonly issues: readonly DockLayoutIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isIndex = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isIdList = (v: unknown): boolean =>
	Array.isArray(v) && v.length === Object.keys(v).length && v.every((s) => typeof s === 'string');

/** The optional remembered docked place of a closed window (#663, `DockSlot`). Its ids are hints, not checked against the tree. */
function isDockSlot(v: unknown): boolean {
	if (!isRecord(v)) return false;
	if (v.kind === 'root') return true;
	if (v.kind === 'tab') {
		return typeof v.groupId === 'string' && isIndex(v.index) && isIdList(v.anchors);
	}
	if (v.kind === 'split') {
		return (
			typeof v.splitId === 'string' &&
			(v.direction === 'row' || v.direction === 'column') &&
			isIndex(v.index) &&
			typeof v.neighborId === 'string' &&
			(v.side === 'before' || v.side === 'after') &&
			typeof v.size === 'number' &&
			Number.isFinite(v.size) &&
			v.size >= 0 &&
			v.size <= 1 &&
			isIdList(v.anchors)
		);
	}
	return false;
}

/**
 * The window's position lock was `pinned` before #694 PR-3 (the pin now means
 * auto-hide): an older JSON's `pinned: true` reads as `locked: true`, and the
 * deprecated field is dropped (a copy - the input is never mutated).
 */
function migrateLock(win: FloatingWindow): FloatingWindow {
	if (win.pinned === undefined) return win;
	const next: FloatingWindow = { ...win };
	if (next.pinned === true) next.locked = true;
	delete next.pinned;
	return next;
}

/**
 * Validate an untrusted value (parsed JSON or a caller-supplied object) as a
 * v1 or v2 `DockLayout`. Pure. A returned layout is safe to adopt wholesale.
 */
export function validateDockLayout(value: unknown): DockLayoutValidation {
	const issues: DockLayoutIssue[] = [];
	const add = (code: DockLayoutIssueCode, path: string): void => {
		issues.push({ code, path });
	};

	if (!isRecord(value)) {
		add('shape', '');
		return { ok: false, issues };
	}
	if (value.version !== 1 && value.version !== 2) {
		add('version', 'version');
		return { ok: false, issues };
	}

	// Floating windows and docked panels share one id space (types.ts); split
	// / tabs group ids are tracked in the same set so no two nodes collide.
	const seen = new Set<string>();
	const claimId = (id: string, path: string): void => {
		if (seen.has(id)) add('duplicate-id', path);
		else seen.add(id);
	};

	// Index every slot instead of `forEach`, which skips the holes of a sparse
	// array (`Array(1)`) and would let an empty slot through to the renderer.
	const eachSlot = (arr: unknown[], p: string, fn: (item: unknown, path: string) => void): void => {
		for (let i = 0; i < arr.length; i++) {
			const path = `${p}[${i}]`;
			if (!(i in arr)) add('shape', path);
			else fn(arr[i], path);
		}
	};

	const floating: FloatingWindow[] = [];
	if (!Array.isArray(value.floating)) {
		add('shape', 'floating');
	} else {
		eachSlot(value.floating, 'floating', (raw, p) => {
			if (!isRecord(raw)) return add('shape', p);
			if (typeof raw.id !== 'string' || raw.id === '') add('shape', `${p}.id`);
			else claimId(raw.id, `${p}.id`);
			if (typeof raw.title !== 'string') add('shape', `${p}.title`);
			if (raw.icon !== undefined && typeof raw.icon !== 'string') add('shape', `${p}.icon`);
			if (typeof raw.open !== 'boolean') add('shape', `${p}.open`);
			for (const key of ['x', 'y'] as const) {
				const n = raw[key];
				if (typeof n !== 'number') add('shape', `${p}.${key}`);
				else if (!Number.isFinite(n)) add('non-finite', `${p}.${key}`);
			}
			for (const key of ['width', 'height'] as const) {
				const n = raw[key];
				if (typeof n !== 'number') add('shape', `${p}.${key}`);
				else if (!Number.isFinite(n)) add('non-finite', `${p}.${key}`);
				else if (!(n > 0)) add('non-positive-size', `${p}.${key}`);
			}
			if (raw.locked !== undefined && typeof raw.locked !== 'boolean') add('shape', `${p}.locked`);
			if (raw.pinned !== undefined && typeof raw.pinned !== 'boolean') add('shape', `${p}.pinned`);
			if (raw.collapsed !== undefined && typeof raw.collapsed !== 'boolean')
				add('shape', `${p}.collapsed`);
			if (raw.dockSlot !== undefined && !isDockSlot(raw.dockSlot)) add('shape', `${p}.dockSlot`);
			floating.push(migrateLock(raw as unknown as FloatingWindow));
		});
	}

	// A caller-supplied object can contain itself; stop at the first revisit so
	// the validator never recurses forever (it must not throw for any input).
	const visited = new WeakSet<object>();
	const checkNode = (raw: unknown, p: string, inTabs: boolean): void => {
		if (!isRecord(raw)) return add('shape', p);
		if (visited.has(raw)) return add('shape', p);
		visited.add(raw);
		if (typeof raw.id !== 'string' || raw.id === '') add('shape', `${p}.id`);
		else claimId(raw.id, `${p}.id`);
		if (raw.type === 'panel') {
			if (typeof raw.title !== 'string') add('shape', `${p}.title`);
			if (raw.icon !== undefined && typeof raw.icon !== 'string') add('shape', `${p}.icon`);
			if (raw.collapsed !== undefined && typeof raw.collapsed !== 'boolean')
				add('shape', `${p}.collapsed`);
			return;
		}
		if (inTabs) return add('shape', `${p}.type`); // tab groups hold panels only
		if (raw.type === 'tabs') {
			if (raw.collapsed !== undefined && typeof raw.collapsed !== 'boolean')
				add('shape', `${p}.collapsed`);
			if (!Array.isArray(raw.children) || raw.children.length === 0) {
				return add('shape', `${p}.children`);
			}
			eachSlot(raw.children, `${p}.children`, (c, cp) => checkNode(c, cp, true));
			const n = raw.children.length;
			const active = raw.activeIndex;
			if (typeof active !== 'number' || !Number.isInteger(active) || active < 0 || active >= n) {
				add('active-index', `${p}.activeIndex`);
			}
			return;
		}
		if (raw.type === 'split') {
			if (raw.direction !== 'row' && raw.direction !== 'column') add('shape', `${p}.direction`);
			if (!Array.isArray(raw.children) || raw.children.length < 2) {
				return add('split-sizes', `${p}.children`);
			}
			eachSlot(raw.children, `${p}.children`, (c, cp) => checkNode(c, cp, false));
			const sizes = raw.sizes;
			if (!Array.isArray(sizes) || sizes.length !== raw.children.length) {
				return add('split-sizes', `${p}.sizes`);
			}
			let total = 0;
			let entriesOk = true;
			eachSlot(sizes, `${p}.sizes`, (s, sp) => {
				if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) {
					entriesOk = false;
					add('split-sizes', sp);
				} else total += s;
			});
			// Finite entries can still overflow when summed (`[1e308, 1e308]`),
			// which normalizeSizes would turn into an all-zero split.
			if (entriesOk && !Number.isFinite(total)) add('split-sizes', `${p}.sizes`);
			return;
		}
		add('shape', `${p}.type`);
	};

	let docked: DockNode | null = null;
	if (value.version === 2) {
		const rawDocked = value.docked;
		if (rawDocked === undefined) add('shape', 'docked');
		else if (rawDocked !== null) checkNode(rawDocked, 'docked', false);
		docked = (rawDocked ?? null) as DockNode | null;
	}

	// Regions auto-hidden to an edge band (#694 PR-3). Optional: an older layout has none.
	const autoHidden: DockAutoHidden[] = [];
	if (value.version === 2 && value.autoHidden !== undefined) {
		if (!Array.isArray(value.autoHidden)) add('shape', 'autoHidden');
		else {
			eachSlot(value.autoHidden, 'autoHidden', (raw, p) => {
				if (!isRecord(raw)) return add('shape', p);
				const node = raw.node;
				if (!isRecord(node) || (node.type !== 'panel' && node.type !== 'tabs'))
					add('shape', `${p}.node`);
				else checkNode(node, `${p}.node`, false);
				if (!EDGES.has(raw.edge)) add('shape', `${p}.edge`);
				if (!isDockSlot(raw.slot)) add('shape', `${p}.slot`);
				const size = raw.size;
				if (size !== undefined) {
					if (typeof size !== 'number') add('shape', `${p}.size`);
					else if (!Number.isFinite(size)) add('non-finite', `${p}.size`);
					else if (!(size > 0 && size <= 1)) add('non-positive-size', `${p}.size`);
				}
				// Normalized only after the whole payload validated (below), like the docked tree: a
				// malformed node (e.g. tabs without `children`) must reject, not throw.
				autoHidden.push(raw as unknown as DockAutoHidden);
			});
		}
	}

	if (issues.length > 0) return { ok: false, issues };
	// A band holds a region on its own: no `collapsed` flag (`normalizeCollapsed` drops a root's).
	for (let i = 0; i < autoHidden.length; i++)
		autoHidden[i] = {
			...autoHidden[i],
			node: normalizeCollapsed(autoHidden[i].node) as DockAutoHidden['node']
		};
	const layout: DockLayout = {
		version: 2,
		floating,
		docked: docked ? normalizeCollapsed(normalizeSizes(docked)) : null
	};
	if (autoHidden.length > 0) layout.autoHidden = autoHidden;
	return { ok: true, layout };
}

const EDGES = new Set<unknown>(['left', 'right', 'top', 'bottom']);
