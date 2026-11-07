/**
 * Chart axis labels follow the rem type tokens (theme-dimension-tokens.md
 * D9-b, PR-5 verification conditions): with (1) the root font size changed
 * from 14px to 20px and (2) `--banto-font-size-sm` overridden, the
 * end-anchored axis labels of every chart on the demo dashboard stay inside
 * their SVG (not clipped at the left edge) and the left margins grow with
 * the font. Both changes are applied AFTER the charts rendered, so this also
 * covers the runtime re-measure path (ResizeObserver on the measured label),
 * not just the first render. Assertion-only: no screenshots.
 *
 * Margins are capped (40% of the chart width, and a font-scaled absolute
 * cap) so the plot never collapses; a category label that still doesn't fit
 * is cut with an ellipsis and keeps its full text in a <title>, so "fits" here
 * means "never overflows the chart edge", and every cut label must be titled.
 */
import { expect, test, type Page } from '@playwright/test';
import { primeThemeAndAuth } from './theme';

interface LabelProbe {
	/** Smallest (label left edge - svg left edge) over all end-anchored labels, px. */
	minLeftGap: number;
	/**
	 * x attribute (innerLeft - gap) of the first left-axis label, keyed by the
	 * chart's position on the page (radar spoke labels excluded: no margin).
	 */
	anchors: Record<string, number>;
	/** Computed font size of the first end-anchored label, px. */
	fontSize: number;
	labels: number;
	/** Which label has `minLeftGap` (for the failure message). */
	worst: string;
	/** Labels cut with an ellipsis (margin at its cap) - each must carry the full text in a <title>. */
	truncated: number;
	untitled: number;
}

function probe(page: Page): Promise<LabelProbe> {
	return page.evaluate(() => {
		let minLeftGap = Infinity;
		let labels = 0;
		let fontSize = 0;
		let worst = '';
		let truncated = 0;
		let untitled = 0;
		const anchors: Record<string, number> = {};
		for (const [index, svg] of document
			.querySelectorAll<SVGSVGElement>('svg.chart-svg')
			.entries()) {
			const svgLeft = svg.getBoundingClientRect().left;
			const ends = [...svg.querySelectorAll<SVGTextElement>('text[text-anchor="end"]')].filter(
				// left-axis labels only (the last x tick is also end-anchored, at the right)
				(t) => Number(t.getAttribute('x')) < svg.getBoundingClientRect().width / 2
			);
			if (ends.length === 0) continue;
			if (!svg.closest('.banto-radarchart')) anchors[index] = Number(ends[0].getAttribute('x'));
			if (!fontSize) fontSize = parseFloat(getComputedStyle(ends[0]).fontSize);
			for (const t of ends) {
				labels++;
				if ((t.firstChild?.textContent ?? '').trim().endsWith('…')) {
					truncated++;
					if (!t.querySelector('title')?.textContent?.trim()) untitled++;
				}
				const gap = t.getBoundingClientRect().left - svgLeft;
				if (gap < minLeftGap) {
					minLeftGap = gap;
					worst = `${svg.closest('[class*="banto-"]')?.className} "${t.textContent?.trim()}" x=${t.getAttribute('x')}`;
				}
			}
		}
		return { minLeftGap, anchors, fontSize, labels, worst, truncated, untitled };
	});
}

const scenarios: { name: string; apply: (page: Page) => Promise<void>; fontSize: number }[] = [
	{
		name: '(1) root font size 20px',
		apply: (page) =>
			page.evaluate(() => {
				document.documentElement.style.fontSize = '20px';
			}),
		fontSize: 16 // sm = 0.8rem
	},
	{
		name: '(2) --banto-font-size-sm overridden to 1.25rem',
		apply: (page) =>
			page.evaluate(() => {
				document.documentElement.style.setProperty('--banto-font-size-sm', '1.25rem');
			}),
		fontSize: 17.5 // 1.25rem at the 14px root
	}
];

for (const scenario of scenarios) {
	test(`chart axis labels follow the type tokens: ${scenario.name}`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
		await page.goto('/dashboard');
		await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
		await expect(page.locator('svg.chart-svg').first()).toBeVisible();

		await expect.poll(async () => (await probe(page)).labels).toBeGreaterThan(0);
		const before = await probe(page);
		expect(before.fontSize).toBeCloseTo(11.2, 1);
		expect(before.minLeftGap).toBeGreaterThanOrEqual(-0.5);

		await scenario.apply(page);
		await expect
			.poll(async () => (await probe(page)).fontSize, { message: 'label font follows the token' })
			.toBeCloseTo(scenario.fontSize, 1);
		// Margins re-estimated from the measured size: the widest label fits ...
		await expect
			.poll(async () => (await probe(page)).minLeftGap, { message: 'a left axis label clipped' })
			.toBeGreaterThanOrEqual(-0.5)
			.catch(async (error) => {
				throw new Error(`${error}\nworst: ${(await probe(page)).worst}`);
			});
		// ... and at least one chart's left margin grew with the font.
		const after = await probe(page);
		expect(after.untitled, 'a cut label without its full text').toBe(0);
		const grown = Object.keys(before.anchors).filter(
			(key) => key in after.anchors && after.anchors[key] > before.anchors[key]
		);
		expect(grown.length).toBeGreaterThan(0);
	});
}
