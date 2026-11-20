<script lang="ts">
	/**
	 * Host for row-selection.test.ts (#713): binds `selectedRowIds` and
	 * `allMatchingSelected` the way an app does, so a test can write them from
	 * outside and read what the grid wrote back. (testing-library's `rerender`
	 * resets every prop the grid wrote locally, so it cannot stand in for a
	 * bound host.)
	 */
	import type { ComponentProps } from 'svelte';
	import BantoGrid from '../src/BantoGrid.svelte';

	interface Row {
		id: number;
		name: string;
		price: number;
	}

	let { ...rest }: ComponentProps<typeof BantoGrid<Row>> = $props();

	let selected = $state<(string | number)[]>([]);
	let allMatching = $state(false);

	export function getSelected(): (string | number)[] {
		return [...selected];
	}
	export function setSelected(ids: (string | number)[]) {
		selected = ids;
	}
	export function getAllMatching(): boolean {
		return allMatching;
	}
	export function setAllMatching(value: boolean) {
		allMatching = value;
	}
</script>

<BantoGrid {...rest} bind:selectedRowIds={selected} bind:allMatchingSelected={allMatching} />
