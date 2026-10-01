<script lang="ts">
	// サブパス export（`@banto/theme/css`）も Git 依存 + path: で解決できることを確かめる。
	import '@banto/theme/css';

	let { children } = $props();
</script>

{@render children()}
