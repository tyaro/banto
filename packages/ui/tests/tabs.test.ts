// @vitest-environment jsdom
/**
 * @banto/ui Tabs and SegmentedControl (Issue #556): the ARIA wiring of the
 * tabs (tablist / tab / tabpanel, aria-selected, aria-controls), the roving
 * tabindex and arrow / Home / End keys (mirrored in RTL, disabled tabs
 * skipped, manual activation), and the segmented control's native radios in
 * a named radiogroup. The look is the theme's CSS and the visual suite's.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SegmentedControl, type SegmentedOption, type TabItem } from '../src/index';
import CustomIcon from './fixtures/CustomIcon.svelte';
import TabsHarness from './fixtures/TabsHarness.svelte';

afterEach(cleanup);

const TABS: TabItem[] = [
	{ id: 'a', label: 'Alpha' },
	{ id: 'b', label: 'Beta' },
	{ id: 'c', label: 'Gamma' }
];

describe('Tabs', () => {
	it('wires tablist / tab / tabpanel and shows only the selected panel', () => {
		render(TabsHarness, { tabs: TABS });
		const list = screen.getByRole('tablist', { name: 'Sections' });
		const tabs = screen.getAllByRole('tab');
		expect(tabs).toHaveLength(3);
		expect(list.contains(tabs[0])).toBe(true);
		// Default: the first enabled tab.
		expect(tabs[0].getAttribute('aria-selected')).toBe('true');
		expect(tabs[1].getAttribute('aria-selected')).toBe('false');
		const panel = screen.getByRole('tabpanel');
		expect(panel.id).toBe(tabs[0].getAttribute('aria-controls'));
		expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id);
		expect(panel.textContent).toContain('Panel a');
		// Every tab's aria-controls resolves, the hidden panels are empty.
		for (const tab of tabs) {
			const controlled = document.getElementById(tab.getAttribute('aria-controls') ?? '');
			expect(controlled?.getAttribute('role')).toBe('tabpanel');
		}
		expect(screen.queryByText('Panel b')).toBeNull();
	});

	it('writes the fallback tab back to the bound value without onchange', async () => {
		const onchange = vi.fn();
		const view = render(TabsHarness, { tabs: TABS, onchange });
		// No value yet: the first enabled tab is shown and bound.
		expect(screen.getByTestId('value').textContent).toBe('a');
		// The selected tab becomes disabled: the next shown tab is bound.
		await view.rerender({ tabs: [{ ...TABS[0], disabled: true }, TABS[1], TABS[2]], onchange });
		expect(screen.getByRole('tabpanel').textContent).toContain('Panel b');
		expect(screen.getByTestId('value').textContent).toBe('b');
		expect(onchange).not.toHaveBeenCalled();
	});

	it('keeps one tab in the Tab order (the selected one)', () => {
		render(TabsHarness, { tabs: TABS, value: 'b' });
		const tabs = screen.getAllByRole('tab');
		expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
	});

	it('selects on click and reports the new id', async () => {
		const onchange = vi.fn();
		render(TabsHarness, { tabs: TABS, onchange });
		await fireEvent.click(screen.getByRole('tab', { name: 'Gamma' }));
		expect(onchange).toHaveBeenCalledWith('c');
		expect(screen.getByTestId('value').textContent).toBe('c');
		expect(screen.getByRole('tabpanel').textContent).toContain('Panel c');
	});

	it('moves and selects with the arrow keys, wrapping, and Home / End', async () => {
		render(TabsHarness, { tabs: TABS });
		const [alpha, beta, gamma] = screen.getAllByRole('tab');
		alpha.focus();
		await fireEvent.keyDown(alpha, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(beta);
		expect(beta.getAttribute('aria-selected')).toBe('true');
		await fireEvent.keyDown(beta, { key: 'End' });
		expect(document.activeElement).toBe(gamma);
		await fireEvent.keyDown(gamma, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(alpha);
		await fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(gamma);
		await fireEvent.keyDown(gamma, { key: 'Home' });
		expect(document.activeElement).toBe(alpha);
		expect(screen.getByTestId('value').textContent).toBe('a');
	});

	it('mirrors the arrow keys when the tablist is right-to-left', async () => {
		render(TabsHarness, { tabs: TABS });
		screen.getByRole('tablist').style.direction = 'rtl';
		const [alpha, beta] = screen.getAllByRole('tab');
		alpha.focus();
		await fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(beta);
	});

	it('skips a disabled tab and never selects it', async () => {
		render(TabsHarness, {
			tabs: [TABS[0], { ...TABS[1], disabled: true }, TABS[2]]
		});
		const [alpha, beta, gamma] = screen.getAllByRole('tab');
		expect(beta.getAttribute('aria-disabled')).toBe('true');
		alpha.focus();
		await fireEvent.keyDown(alpha, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(gamma);
		await fireEvent.click(beta);
		expect(beta.getAttribute('aria-selected')).toBe('false');
		expect(screen.getByTestId('value').textContent).toBe('c');
	});

	it('manual activation moves focus only; Enter / click selects', async () => {
		render(TabsHarness, { tabs: TABS, activation: 'manual' });
		const [alpha, beta] = screen.getAllByRole('tab');
		alpha.focus();
		await fireEvent.keyDown(alpha, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(beta);
		expect(beta.getAttribute('aria-selected')).toBe('false');
		expect(beta.getAttribute('tabindex')).toBe('0');
		// A native button turns Enter into a click.
		await fireEvent.click(beta);
		expect(beta.getAttribute('aria-selected')).toBe('true');
	});
});

describe('Tabs keepMounted', () => {
	it('draws the unselected panels (hidden) only with keepMounted', () => {
		const view = render(TabsHarness, { tabs: TABS, keepMounted: true });
		const panels = view.container.querySelectorAll<HTMLElement>('[role="tabpanel"]');
		expect(panels.length).toBe(TABS.length);
		expect(panels[0].hidden).toBe(false);
		expect(panels[1].hidden).toBe(true);
		expect(panels[1].textContent).toContain(`Panel ${TABS[1].id}`);
	});

	it('leaves unselected panels empty by default', () => {
		const view = render(TabsHarness, { tabs: TABS });
		const panels = view.container.querySelectorAll<HTMLElement>('[role="tabpanel"]');
		expect(panels[1].hidden).toBe(true);
		expect(panels[1].textContent?.trim()).toBe('');
	});
});

describe('Tabs hideSingleTab (#659)', () => {
	const ONE: TabItem[] = [{ id: 'a', label: 'Alpha' }];

	it('draws no tablist / tab and a plain panel for a single tab', () => {
		const { container } = render(TabsHarness, { tabs: ONE, hideSingleTab: true });
		expect(screen.queryByRole('tablist')).toBeNull();
		expect(screen.queryByRole('tab')).toBeNull();
		expect(screen.queryByRole('tabpanel')).toBeNull();
		const panel = container.querySelector('.banto-tabs__panel');
		expect(panel).not.toBeNull();
		for (const attr of ['role', 'tabindex', 'id', 'aria-labelledby', 'hidden']) {
			expect(panel?.hasAttribute(attr)).toBe(false);
		}
		expect(panel?.textContent).toContain('Panel a');
		expect(screen.getByTestId('value').textContent).toBe('a');
	});

	it('keeps the usual markup for a single tab without hideSingleTab', () => {
		render(TabsHarness, { tabs: ONE });
		expect(screen.getByRole('tablist')).toBeTruthy();
		expect(screen.getAllByRole('tab')).toHaveLength(1);
		expect(screen.getByRole('tabpanel').getAttribute('tabindex')).toBe('0');
	});

	it('keeps the usual markup for two or more tabs with hideSingleTab', () => {
		render(TabsHarness, { tabs: TABS, hideSingleTab: true });
		expect(screen.getByRole('tablist')).toBeTruthy();
		expect(screen.getAllByRole('tab')).toHaveLength(3);
		expect(screen.getByRole('tabpanel').getAttribute('tabindex')).toBe('0');
	});

	it('switches when the tabs go from two to one and back', async () => {
		const view = render(TabsHarness, { tabs: TABS.slice(0, 2), hideSingleTab: true });
		expect(screen.getByRole('tablist')).toBeTruthy();
		await view.rerender({ tabs: [TABS[1]], hideSingleTab: true });
		expect(screen.queryByRole('tablist')).toBeNull();
		expect(screen.getByTestId('value').textContent).toBe('b');
		expect(view.container.querySelector('.banto-tabs__panel')?.textContent).toContain('Panel b');
		await view.rerender({ tabs: TABS.slice(0, 2), hideSingleTab: true });
		expect(screen.getAllByRole('tab')).toHaveLength(2);
	});

	it('keeps the remaining panel element and its content across 2 -> 1 -> 2', async () => {
		const two = TABS.slice(0, 2);
		const view = render(TabsHarness, { tabs: two, hideSingleTab: true });
		const panel = view.container.querySelector('.banto-tabs__panel:not([hidden])');
		const input = screen.getByTestId('field-a') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'typed' } });
		await view.rerender({ tabs: [TABS[0]], hideSingleTab: true });
		expect(view.container.querySelector('.banto-tabs__panel')).toBe(panel);
		expect(screen.getByTestId('field-a')).toBe(input);
		expect(input.value).toBe('typed');
		await view.rerender({ tabs: two, hideSingleTab: true });
		expect(view.container.querySelector('.banto-tabs__panel:not([hidden])')).toBe(panel);
		expect(screen.getByTestId('field-a')).toBe(input);
		expect(input.value).toBe('typed');
	});

	it('keeps a lone disabled tab hidden and unrendered', () => {
		const { container } = render(TabsHarness, {
			tabs: [{ id: 'x', label: 'X', disabled: true }],
			hideSingleTab: true
		});
		const panel = container.querySelector('.banto-tabs__panel');
		expect(panel?.hasAttribute('hidden')).toBe(true);
		expect(screen.queryByText('Panel x')).toBeNull();
	});
});

describe('SegmentedControl', () => {
	const OPTIONS: SegmentedOption<'s' | 'c'>[] = [
		{ value: 's', label: 'Standard', icon: CustomIcon },
		{ value: 'c', label: 'Compact' }
	];

	it('is a named radiogroup of native radios sharing a name', () => {
		render(SegmentedControl, { options: OPTIONS, value: 'c', name: 'density', label: 'Density' });
		const group = screen.getByRole('radiogroup', { name: 'Density' });
		const radios = screen.getAllByRole('radio') as HTMLInputElement[];
		expect(radios).toHaveLength(2);
		expect(radios.every((radio) => group.contains(radio) && radio.name === 'density')).toBe(true);
		expect(screen.getByRole('radio', { name: 'Compact' })).toHaveProperty('checked', true);
		expect(screen.getByRole('radio', { name: 'Standard' })).toHaveProperty('checked', false);
		expect(screen.getByTestId('custom-icon').getAttribute('aria-hidden')).toBe('true');
	});

	it('can be named by a visible heading', () => {
		const heading = document.createElement('h4');
		heading.id = 'heading';
		heading.textContent = 'Dock position';
		document.body.append(heading);
		render(SegmentedControl, { options: OPTIONS, name: 'pos', labelledby: 'heading' });
		expect(screen.getByRole('radiogroup', { name: 'Dock position' })).toBeTruthy();
		heading.remove();
	});

	it('reports the choice the user made', async () => {
		const onchange = vi.fn();
		render(SegmentedControl, { options: OPTIONS, value: 's', name: 'd', label: 'D', onchange });
		await fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
		expect(onchange).toHaveBeenCalledWith('c');
		expect(screen.getByRole('radio', { name: 'Compact' })).toHaveProperty('checked', true);
	});

	it('disables every segment when asked', () => {
		render(SegmentedControl, { options: OPTIONS, name: 'd', label: 'D', disabled: true });
		const radios = screen.getAllByRole('radio') as HTMLInputElement[];
		expect(radios.every((radio) => radio.disabled)).toBe(true);
	});
});
