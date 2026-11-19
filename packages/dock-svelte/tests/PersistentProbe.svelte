<!--
	Test-only content for `DockHostPersistent.test.ts` (#663 ④): reports each mount
	through `onMounted`, and holds an input (focus) and a scroller (scroll offset).
-->
<script lang="ts">
	import { onMount } from 'svelte';

	let { id, title, onMounted }: { id: string; title: string; onMounted?: (id: string) => void } =
		$props();

	onMount(() => onMounted?.(id));
</script>

<div class="panel-body" data-probe={id}>
	{title}<input aria-label={`${title} input`} />
	<div class="scroller" data-scroller={id}></div>
</div>
