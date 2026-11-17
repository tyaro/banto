<script lang="ts">
	import { ThreePaneLayout, type UiMessages } from '../../src/index';

	let {
		leftWidth = $bindable(280),
		rightWidth = $bindable(360),
		leftCollapsed = $bindable(false),
		rightCollapsed = $bindable(false),
		leftDrawerOpen = $bindable(false),
		rightDrawerOpen = $bindable(false),
		narrow = $bindable(false),
		leftOpen = $bindable(true),
		rightOpen = $bindable(true),
		leftToggleEl = $bindable(),
		rightToggleEl = $bindable(),
		leftDrawerModal,
		rightDrawerModal,
		narrowOverride,
		onToggle,
		leftMinWidth,
		leftMaxWidth,
		rightMinWidth,
		rightMaxWidth,
		centerMinWidth,
		narrowBreakpoint,
		resizeStep,
		title = 'Line 1',
		withTitleSnippet = false,
		messages
	}: {
		leftWidth?: number;
		rightWidth?: number;
		leftCollapsed?: boolean;
		rightCollapsed?: boolean;
		leftDrawerOpen?: boolean;
		rightDrawerOpen?: boolean;
		narrow?: boolean;
		leftOpen?: boolean;
		rightOpen?: boolean;
		leftToggleEl?: HTMLElement;
		rightToggleEl?: HTMLElement;
		leftDrawerModal?: boolean;
		rightDrawerModal?: boolean;
		narrowOverride?: boolean;
		onToggle?: (side: 'left' | 'right', open: boolean) => void;
		leftMinWidth?: number;
		leftMaxWidth?: number;
		rightMinWidth?: number;
		rightMaxWidth?: number;
		centerMinWidth?: number;
		narrowBreakpoint?: number;
		resizeStep?: number;
		title?: string;
		withTitleSnippet?: boolean;
		messages?: UiMessages;
	} = $props();
</script>

<button type="button">Outside</button>
<ThreePaneLayout
	bind:leftWidth
	bind:rightWidth
	bind:leftCollapsed
	bind:rightCollapsed
	bind:leftDrawerOpen
	bind:rightDrawerOpen
	bind:narrow
	bind:leftOpen
	bind:rightOpen
	bind:leftToggleEl
	bind:rightToggleEl
	{leftDrawerModal}
	{rightDrawerModal}
	{narrowOverride}
	{onToggle}
	{leftMinWidth}
	{leftMaxWidth}
	{rightMinWidth}
	{rightMaxWidth}
	{centerMinWidth}
	{narrowBreakpoint}
	{resizeStep}
	{title}
	titleContent={withTitleSnippet ? titleSnippet : undefined}
	{messages}
>
	{#snippet left()}
		<button type="button">Node A</button>
		<button type="button" onclick={() => (leftDrawerOpen = false)}>Pick B</button>
	{/snippet}
	{#snippet right()}
		<button type="button">Detail</button>
	{/snippet}
	<button type="button">Body</button>
</ThreePaneLayout>
{#snippet titleSnippet()}<strong>Snippet title</strong>{/snippet}
<output data-testid="state"
	>{JSON.stringify({
		leftWidth,
		rightWidth,
		leftCollapsed,
		rightCollapsed,
		leftDrawerOpen,
		rightDrawerOpen,
		narrow,
		leftOpen,
		rightOpen
	})}</output
>
<output
	data-testid="toggles"
	data-left={leftToggleEl?.getAttribute('aria-controls') ?? ''}
	data-right={rightToggleEl?.getAttribute('aria-controls') ?? ''}
></output>
