<script lang="ts">
	/**
	 * Test-only pane (draftPane.test.ts): borrows a `FormDraft` and registers it
	 * with a `DraftCoordinator` from an `$effect`, the way a dock pane does on
	 * mount. The effect also writes to the draft (`seed`) - mutators must not
	 * make it re-run itself (conventions §8).
	 */
	import DraftNumberField from '../src/fields/DraftNumberField.svelte';
	import { draftSourceFrom, type FormDraft } from '../src/draft.svelte';
	import type { DraftCoordinator } from '../src/draftCoordinator.svelte';
	import type { FieldDef } from '../src/types';

	interface Props {
		draft: FormDraft;
		coordinator: DraftCoordinator;
		def: FieldDef;
		seed?: string;
		onEffect?: () => void;
	}

	let { draft, coordinator, def, seed, onEffect }: Props = $props();

	$effect(() => {
		onEffect?.();
		const unregister = coordinator.register(draftSourceFrom(draft, async () => true));
		if (seed !== undefined) draft.setRaw(def.name, seed);
		return unregister;
	});
</script>

<DraftNumberField {def} {draft} />
<output data-testid="state"
	>{coordinator.pending ? 'pending' : 'clean'}:{draft.dirty
		? 'dirty'
		: 'clean'}:{draft.revision}</output
>
