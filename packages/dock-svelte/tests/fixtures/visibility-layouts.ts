// `panel-visibility.test.ts` などが共有する道具（#798 で総当たりを別ファイルに分けたときに寄せた）:
// 木の形（`shapeOf`）、レイアウトの集合 `L`、手順の実行（`runSteps`）、既定の配置つきの
// `DockState`（`dockWithDefault`、#782 PR5）。旧実装（main の slot）との比較は #782 PR7 で削った。
import type { DockState } from '../../src/state.svelte';
import { createDockState } from '../../src/state.svelte';
import type { DockLayout, DockNode } from '../../src/types';

export function counterMakeId(): () => string {
	let n = 0;
	return () => `gen-${n++}`;
}

export const panel = (id: string) => ({ type: 'panel' as const, id, title: id.toUpperCase() });

/**
 * The tree's shape (#721): kind, direction and child ids - not generated ids of splits / groups,
 * sizes or the active tab. A tab put back as a split's sibling does not match a tab group.
 */
export const shapeOf = (node: DockNode | null): unknown =>
	node === null
		? null
		: node.type === 'panel'
			? node.id
			: node.type === 'tabs'
				? { tabs: node.children.map((c) => c.id) }
				: { [node.direction]: node.children.map(shapeOf) };

const even = (n: number) => Array.from({ length: n }, () => 1 / n);
export const nested = (
	outer: 'row' | 'column',
	inner: string[],
	rest: string[],
	innerFirst = true,
	sameDirection = false
): DockNode => {
	const innerNode: DockNode = {
		type: 'split',
		id: 'in',
		direction: sameDirection ? outer : outer === 'row' ? 'column' : 'row',
		sizes: even(inner.length),
		children: inner.map(panel)
	};
	const children = innerFirst ? [innerNode, ...rest.map(panel)] : [...rest.map(panel), innerNode];
	return { type: 'split', id: 'out', direction: outer, sizes: even(children.length), children };
};

// The layouts of the checks below: split / tab group ids fixed, sizes even.
export const evenSizes = (n: number) => Array.from({ length: n }, () => 1 / n);
export const splitNode = (
	id: string,
	direction: 'row' | 'column',
	children: DockNode[]
): DockNode => ({
	type: 'split',
	id,
	direction,
	sizes: evenSizes(children.length),
	children
});
export const tabsNode = (id: string, ids: string[]): DockNode => ({
	type: 'tabs',
	id,
	activeIndex: 0,
	children: ids.map(panel)
});
/**
 * A state whose default layout (#782 PR5: where `show` docks a pane hidden from the dock) is the
 * layout it starts with.
 */
export const dockWithDefault = (initial: DockLayout | string, makeId?: () => string): DockState => {
	const dock = createDockState(initial, makeId);
	dock.defaultLayout = JSON.parse(JSON.stringify(dock.layout)) as DockLayout;
	return dock;
};
/**
 * `-x` hides x, `+x` shows it, `~x` floats it (`undockPanel`, #734), `^x` puts it back where it
 * was (`dockAtSlot` with its `homeSlot`, the panel menu's "back"), with `createDockState`.
 */
export const runSteps = (make: () => DockNode, steps: string[]): DockState => {
	const dock = dockWithDefault({ version: 4, floating: [], docked: make() }, counterMakeId());
	for (const step of steps) {
		const id = step.slice(1);
		if (step[0] === '-') dock.dismiss(id);
		else if (step[0] === '+') dock.show(id);
		else if (step[0] === '~') dock.undockPanel(id);
		else {
			dock.dockBack(id);
		}
	}
	return dock;
};

export const L = {
	'row[a,tabs[b,c],column[d,e]]': () =>
		splitNode('s', 'row', [
			panel('a'),
			tabsNode('t', ['b', 'c']),
			splitNode('in', 'column', [panel('d'), panel('e')])
		]),
	'row[a,column[b,c],d]': () =>
		splitNode('s', 'row', [
			panel('a'),
			splitNode('in', 'column', [panel('b'), panel('c')]),
			panel('d')
		]),
	'row[tabs[a,b],c,d]': () =>
		splitNode('s', 'row', [tabsNode('t', ['a', 'b']), panel('c'), panel('d')]),
	'row[row[a,b],p]': () =>
		splitNode('s', 'row', [splitNode('in', 'row', [panel('a'), panel('b')]), panel('p')]),
	'column[a,row[b,c],d]': () =>
		splitNode('s', 'column', [
			panel('a'),
			splitNode('in', 'row', [panel('b'), panel('c')]),
			panel('d')
		]),
	'row[a,b,c,d]': () => splitNode('s', 'row', ['a', 'b', 'c', 'd'].map(panel)),
	'row[column[a,b],c,d]': () =>
		splitNode('s', 'row', [
			splitNode('in', 'column', [panel('a'), panel('b')]),
			panel('c'),
			panel('d')
		]),
	'row[column[a,b,c],d]': () =>
		splitNode('s', 'row', [
			splitNode('in', 'column', [panel('a'), panel('b'), panel('c')]),
			panel('d')
		]),
	'row[a,column[b,row[c,d]]]': () =>
		splitNode('s', 'row', [
			panel('a'),
			splitNode('in', 'column', [panel('b'), splitNode('in2', 'row', [panel('c'), panel('d')])])
		]),
	'row[column[tabs[a,b],c],d]': () =>
		splitNode('s', 'row', [
			splitNode('in', 'column', [tabsNode('t', ['a', 'b']), panel('c')]),
			panel('d')
		]),
	'row[row[a,b],column[c,d]]': () =>
		splitNode('s', 'row', [
			splitNode('in', 'row', [panel('a'), panel('b')]),
			splitNode('in2', 'column', [panel('c'), panel('d')])
		]),
	'column[tabs[a,b,c],row[d,e]]': () =>
		splitNode('s', 'column', [
			tabsNode('t', ['a', 'b', 'c']),
			splitNode('in', 'row', [panel('d'), panel('e')])
		]),
	'row[tabs[a,b],column[c,d],e]': () =>
		splitNode('s', 'row', [
			tabsNode('t', ['a', 'b']),
			splitNode('in', 'column', [panel('c'), panel('d')]),
			panel('e')
		]),
	'column[row[a,tabs[b,c]],row[d,e]]': () =>
		splitNode('s', 'column', [
			splitNode('r1', 'row', [panel('a'), tabsNode('t', ['b', 'c'])]),
			splitNode('r2', 'row', [panel('d'), panel('e')])
		]),
	// #727: two outer siblings of an inner split.
	'column[row[a,b],c,d]': () =>
		splitNode('s', 'column', [
			splitNode('in', 'row', [panel('a'), panel('b')]),
			panel('c'),
			panel('d')
		]),
	// Codex P2 on #732: four splits deep (a slot's `outer` chain was cut here when `MAX_SLOT_DEPTH`
	// was 4).
	'column[row[a,column[row[b,c],d]],e]': () =>
		splitNode('s', 'column', [
			splitNode('r1', 'row', [
				panel('a'),
				splitNode('c1', 'column', [splitNode('r2', 'row', [panel('b'), panel('c')]), panel('d')])
			]),
			panel('e')
		]),
	// Codex P2 on #732 (the second one): tab groups inside a split inside a split.
	'row[b,c,column[tabs[d,e],tabs[f,g]]]': () =>
		splitNode('s', 'row', [
			panel('b'),
			panel('c'),
			splitNode('c1', 'column', [tabsNode('t1', ['d', 'e']), tabsNode('t2', ['f', 'g'])])
		]),
	'column[tabs[a,b],row[c,tabs[d,e]]]': () =>
		splitNode('s', 'column', [
			tabsNode('t1', ['a', 'b']),
			splitNode('r', 'row', [panel('c'), tabsNode('t2', ['d', 'e'])])
		]),
	'row[a,column[tabs[b,c],tabs[d,e]]]': () =>
		splitNode('s', 'row', [
			panel('a'),
			splitNode('c1', 'column', [tabsNode('t1', ['b', 'c']), tabsNode('t2', ['d', 'e'])])
		]),
	'row[a,column[b,row[tabs[c,d],e]]]': () =>
		splitNode('s', 'row', [
			panel('a'),
			splitNode('c1', 'column', [
				panel('b'),
				splitNode('r', 'row', [tabsNode('t1', ['c', 'd']), panel('e')])
			])
		]),
	'column[row[a,tabs[b,c]],tabs[d,e],f]': () =>
		splitNode('s', 'column', [
			splitNode('r', 'row', [panel('a'), tabsNode('t1', ['b', 'c'])]),
			tabsNode('t2', ['d', 'e']),
			panel('f')
		]),
	'row[column[tabs[a,b],c],column[d,tabs[e,f]]]': () =>
		splitNode('s', 'row', [
			splitNode('c1', 'column', [tabsNode('t1', ['a', 'b']), panel('c')]),
			splitNode('c2', 'column', [panel('d'), tabsNode('t2', ['e', 'f'])])
		]),
	// A tab group five containers deep (its last tab's `outer` chain was cut when `MAX_SLOT_DEPTH`
	// was 4, and the tab opened floating).
	'column[row[a,column[row[tabs[b,c],x],d]],e]': () =>
		splitNode('s', 'column', [
			splitNode('r1', 'row', [
				panel('a'),
				splitNode('c1', 'column', [
					splitNode('r2', 'row', [tabsNode('t', ['b', 'c']), panel('x')]),
					panel('d')
				])
			]),
			panel('e')
		]),
	// A tab group five containers deep the other way round (cut, too, when the limit was 4).
	'row[a,column[b,row[c,column[tabs[d,e],f]]]]': () =>
		splitNode('s', 'row', [
			panel('a'),
			splitNode('c1', 'column', [
				panel('b'),
				splitNode('r', 'row', [
					panel('c'),
					splitNode('c2', 'column', [tabsNode('t', ['d', 'e']), panel('f')])
				])
			])
		])
} satisfies Record<string, () => DockNode>;
