<!--
  Icon "eye" from Lucide (@lucide/svelte v1.77.0), bundled so @banto/forms needs no
  dependency (docs/adr/0018-shared-ui-package.md §2). Licensed under ISC (Lucide Icons and Contributors) and, for icons derived from Feather, MIT (Cole Bemis);
  see ./LICENSE. Markup is lucide's rendered output verbatim; not an icon set - not exported.
-->
<script lang="ts">
	let { size = 24 }: { size?: number } = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	class="lucide lucide-eye lucide-icon"
	aria-hidden="true"
	focusable="false"
>
	<path
		d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
	/>
	<circle cx="12" cy="12" r="3" />
</svg>
