<script lang="ts">
	import DatePicker from '../../src/DatePicker.svelte';

	interface Props {
		value?: string | null;
		min?: string;
		max?: string;
		isDateDisabled?: (date: string) => boolean;
		months?: 1 | 2;
		disabled?: boolean;
		readonly?: boolean;
		onValueChange?: (value: string | null) => void;
		onkeydown?: (event: KeyboardEvent) => void;
		onblur?: (event: FocusEvent) => void;
		/** Records bubbled keydown / pointerdown on an ancestor (a grid cell). */
		onHostKeydown?: (event: KeyboardEvent) => void;
		onHostPointerdown?: (event: PointerEvent) => void;
	}

	let { value = $bindable(null), onHostKeydown, onHostPointerdown, ...rest }: Props = $props();
</script>

<div
	data-testid="host"
	role="presentation"
	{@attach (node) => {
		const key = (event: Event) => onHostKeydown?.(event as KeyboardEvent);
		const pointer = (event: Event) => onHostPointerdown?.(event as PointerEvent);
		node.addEventListener('keydown', key);
		node.addEventListener('pointerdown', pointer);
		return () => {
			node.removeEventListener('keydown', key);
			node.removeEventListener('pointerdown', pointer);
		};
	}}
>
	<DatePicker bind:value label="Due date" {...rest} />
</div>
<button type="button">Outside</button>
<span data-testid="value">{value ?? 'null'}</span>
