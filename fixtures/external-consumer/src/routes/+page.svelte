<script lang="ts">
	// 外部利用 fixture（#271）の本体。`.svelte.ts` をソース配布する 6 パッケージを
	// それぞれ import し、ブラウザがモジュールグラフを最後まで読み込めたことを
	// `data-testid="banto-loaded"` の描画で示す。#150 が再現すると、dev の依存
	// オプティマイザがここで import する `.svelte.ts` を js_parse_error にし、
	// このマーカーは描画されない（SvelteKit のクライアント側 500 画面になる）。
	//
	// import するのは、現行リリースタグ（v1.7.3）と main の両方にある export だけ
	// （存在の確認だけをする）。fixture が特定の版の API に縛られないようにするため。
	// 例外: `@banto/ui` の `createToastStore` / `ToastHost`（#220 段階 2c）は v6.1.0 には無い。
	// 次のリリースタグが切られるまで、タグの経路（v6.1.0 を依存にする）はここで落ちる。
	// SHA の経路（PR・main）は通る。
	// 新しく `.svelte.ts` を持つパッケージを足したら、ここに import を 1 行足す
	// （verify:architecture の rule `external-consumer-fixture` が漏れを落とす）。
	import { createListResource } from '@banto/admin-core';
	import { createDockState } from '@banto/dock-svelte';
	import { BantoForm, createFormStore } from '@banto/forms';
	import { BantoGrid, GridState } from '@banto/grid-svelte';
	import { BantoTree, TreeState } from '@banto/tree-svelte';
	import { resolveTheme } from '@banto/theme';
	// @banto/ui（#220）は `createToastStore()`（段階 2c）が `.svelte.ts` なので 6 つ目の
	// exclude 対象。Git 依存（path:）で入り、dev・svelte-check・vite build がストアと
	// ToastHost を通ることを確かめるため、ストアを作って実際に描画する。
	import { PageHeader, StatusBadge, ToastHost, createToastStore } from '@banto/ui';

	const toastStore = createToastStore();
	toastStore.push('info', 'toast', { durationMs: 0 });

	const loaded = [
		typeof createListResource,
		typeof createDockState,
		typeof createFormStore,
		typeof BantoForm,
		typeof GridState,
		typeof BantoGrid,
		typeof TreeState,
		typeof BantoTree,
		typeof createToastStore,
		resolveTheme('light')
	].join(',');
</script>

<p data-testid="banto-loaded">{loaded}</p>
<PageHeader title="external consumer" />
<StatusBadge variant="success" label="ok" />
<ToastHost store={toastStore} />
