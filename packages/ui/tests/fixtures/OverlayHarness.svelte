<script lang="ts">
	// Test harness: an opener for a Drawer (or a Modal, `kind`), an element
	// outside, a Modal nested inside the Drawer's body (the "Modal over Drawer"
	// stack), and an optional CommandPalette over everything. The parent owns
	// `open` like a real caller: `onclose` sets it to false (unless `keepOpen`,
	// a parent that decides not to close).
	import { CommandPalette, Drawer, Menu, MenuItem, Modal, type UiMessages } from '../../src/index';

	let {
		kind = 'drawer',
		title = 'Edit',
		width,
		closeOnOverlayClick,
		onRequestClose,
		onclose,
		keepOpen = false,
		dirty,
		onBlockedClose,
		focusFallback,
		messages,
		innerMenu = false
	}: {
		kind?: 'drawer' | 'modal';
		title?: string;
		width?: string;
		closeOnOverlayClick?: boolean;
		onRequestClose?: () => boolean;
		onclose?: () => void;
		keepOpen?: boolean;
		dirty?: boolean;
		onBlockedClose?: () => void;
		focusFallback?: () => HTMLElement | null;
		messages?: UiMessages;
		innerMenu?: boolean;
	} = $props();

	let open = $state(false);
	let nestedOpen = $state(false);
	let paletteOpen = $state(false);
	const Overlay = $derived(kind === 'drawer' ? Drawer : Modal);
</script>

<button type="button" data-testid="opener" onclick={() => (open = true)}>Open</button>
<button type="button" data-testid="outside">Outside</button>
<Menu label="Outside menu">
	{#snippet trigger(props)}
		<button {...props} type="button" data-testid="menu-trigger">Menu</button>
	{/snippet}
	<MenuItem label="Outside item" onSelect={() => {}} />
</Menu>
<span data-testid="state">{open ? 'open' : 'closed'}</span>
<span data-testid="nested-state">{nestedOpen ? 'open' : 'closed'}</span>

<Overlay
	{open}
	{title}
	{width}
	{closeOnOverlayClick}
	{onRequestClose}
	{dirty}
	{onBlockedClose}
	{focusFallback}
	{messages}
	onclose={() => {
		onclose?.();
		if (!keepOpen) open = false;
	}}
>
	<input data-testid="field" />
	<button type="button" data-testid="open-nested" onclick={() => (nestedOpen = true)}>
		Nested
	</button>
	<button type="button" data-testid="open-palette" onclick={() => (paletteOpen = true)}>
		Palette
	</button>
	{#if innerMenu}
		<Menu label="Inner menu">
			{#snippet trigger(props)}
				<button {...props} type="button" data-testid="inner-menu-trigger">Inner</button>
			{/snippet}
			<MenuItem label="Inner item" onSelect={() => {}} />
		</Menu>
	{/if}
	<Modal open={nestedOpen} title="Confirm" onclose={() => (nestedOpen = false)}>
		<button type="button" data-testid="nested-ok">OK</button>
	</Modal>
</Overlay>

<CommandPalette
	bind:open={paletteOpen}
	items={[{ id: 'a', title: 'Alpha' }]}
	onExecute={() => {}}
/>
