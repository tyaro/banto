<script lang="ts">
	// Test harness: checkbox items (one checked, one unchecked, one disabled
	// with a title), a radio item and a plain item inside one Menu.
	import { Menu, MenuItem } from '../../src/index';

	let {
		onColA,
		onColB,
		onColLocked,
		onRadio,
		onPlain
	}: {
		onColA: () => void;
		onColB: () => void;
		onColLocked: () => void;
		onRadio: () => void;
		onPlain: () => void;
	} = $props();
</script>

<Menu label="Columns">
	{#snippet trigger(props)}
		<button {...props} type="button">Open</button>
	{/snippet}
	<MenuItem label="Col A" kind="checkbox" checked={true} onSelect={onColA} />
	<MenuItem label="Col B" kind="checkbox" checked={false} onSelect={onColB} />
	<MenuItem
		label="Col Locked"
		kind="checkbox"
		checked={true}
		disabled
		title="Last column cannot be hidden"
		onSelect={onColLocked}
	/>
	<MenuItem label="Radio" checked={true} onSelect={onRadio} />
	<MenuItem label="Plain" onSelect={onPlain} />
</Menu>
