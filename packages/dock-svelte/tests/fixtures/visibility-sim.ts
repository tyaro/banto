// The shape of a docked tree, for the tests that compare where panes ended up (#721). The model of
// `dismiss` / `show` on slots that lived here went with `core/slot.ts` (#782 PR8c): the walks of
// `split-sizes.test.ts` run `createDockState` itself.
import type { DockNode } from '../../src/types';

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
