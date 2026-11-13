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
