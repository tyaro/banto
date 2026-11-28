/**
 * Issue #1055 guard: no focusable control inside a live region.
 *
 * A modal marks everything outside it `inert` and leaves only live regions
 * (`role="status"`, `role="alert"`, `aria-live`) reachable so announcements
 * still work. A control inside such a region would stay clickable behind the
 * modal, so a region holds the sentence only and its controls are siblings.
 *
 * Static check over the .svelte sources: it parses each file and looks for a
 * focusable element (button, link with href, form control, summary, anything
 * with a tabindex) among the descendants of a live-region element, through
 * `{#if}` / `{#each}` / `{#snippet}` blocks. It does not follow where a
 * snippet is rendered (`{@render}`), so a live region that holds a
 * `{@render}` fails unless its file is listed in RENDER_ALLOWED (reviewed by
 * hand). Components (`<Foo />`) are not followed either - keep those out of
 * regions by hand.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === 'paraglide' || name.startsWith('.')) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...svelteFiles(path));
		else if (name.endsWith('.svelte')) out.push(path);
	}
	return out;
}

const roots = [join(repoRoot, 'apps/admin-template/src')];
for (const pkg of readdirSync(join(repoRoot, 'packages'))) {
	const src = join(repoRoot, 'packages', pkg, 'src');
	try {
		if (statSync(src).isDirectory()) roots.push(src);
	} catch {
		// no src dir
	}
}

/**
 * Known and accepted: the picker's heading is `aria-live="polite"` and holds the button that
 * opens the year / month view. The heading belongs to the picker's own open dialog (itself the
 * topmost layer), and its tests pin the heading as the live region, so it stays as is.
 * Each entry is a file and the reason; do not add to this list for a notice or a banner.
 */
const ALLOWED = new Set(['packages/ui/src/CalendarPeriodView.svelte']);

/**
 * Known gap: live regions that render a snippet (`{@render}`), whose controls this check cannot
 * see. Each is to be made safe in the later stage of #1055 by marking the controls inside
 * `inert` individually, so it is not rewritten here.
 * - ToastHost: `role="status"` / `role="alert"` groups render `toastItem`, which holds the
 *   action and close buttons.
 * - MonthCalendar: the heading `aria-live="polite"` renders `headingButton` (year / month button).
 * - ErrorState: the `role="alert"` box renders the caller's `action` snippet (usually a button).
 * - LanReachCheckPanel: the `role="status"` box renders `issuedUrl`, which holds a button.
 * - FirewallRuleStatusPanel: the `role="status"` box renders `ruleStatus`, which holds text only
 *   (checked by hand; listed because the check cannot tell).
 * Do not add to this list for a notice or a banner; split the controls out instead.
 */
const RENDER_ALLOWED = new Set([
	'packages/ui/src/ToastHost.svelte',
	'packages/ui/src/MonthCalendar.svelte',
	'apps/admin-template/src/routes/(app)/settings/FirewallRuleStatusPanel.svelte'
]);

// The compiler's AST is loosely typed here on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const FOCUSABLE_TAGS = new Set(['button', 'select', 'textarea', 'summary']);
const LIVE_ROLES = new Set(['status', 'alert', 'log']);

function attr(node: Node, name: string): { present: boolean; text: string | null } {
	const a = (node.attributes ?? []).find((x: Node) => x.type === 'Attribute' && x.name === name);
	if (!a) return { present: false, text: null };
	if (a.value === true) return { present: true, text: '' };
	const parts = Array.isArray(a.value) ? a.value : [a.value];
	if (parts.every((p: Node) => p.type === 'Text')) {
		return { present: true, text: parts.map((p: Node) => p.data).join('') };
	}
	return { present: true, text: null };
}

function isLiveRegion(node: Node): boolean {
	if (node.type !== 'RegularElement') return false;
	const role = attr(node, 'role').text;
	if (role !== null && LIVE_ROLES.has(role)) return true;
	const live = attr(node, 'aria-live').text;
	return live === 'polite' || live === 'assertive';
}

function isFocusable(node: Node): boolean {
	if (node.type !== 'RegularElement') return false;
	if (FOCUSABLE_TAGS.has(node.name)) return true;
	if (node.name === 'a' && attr(node, 'href').present) return true;
	if (node.name === 'input' && attr(node, 'type').text !== 'hidden') return true;
	const tabindex = attr(node, 'tabindex');
	return tabindex.present && tabindex.text !== '-1';
}

function children(node: Node): Node[] {
	const out: Node[] = [];
	for (const key of [
		'fragment',
		'body',
		'consequent',
		'alternate',
		'fallback',
		'pending',
		'then',
		'catch'
	]) {
		const v = node[key];
		if (!v) continue;
		if (Array.isArray(v)) out.push(...v);
		else if (v.nodes) out.push(...v.nodes);
		else out.push(v);
	}
	if (node.nodes) out.push(...node.nodes);
	return out;
}

function findFocusable(node: Node): string[] {
	const hits: string[] = [];
	for (const child of children(node)) {
		if (isFocusable(child)) hits.push(child.name);
		hits.push(...findFocusable(child));
	}
	return hits;
}

function hasRender(node: Node): boolean {
	return children(node).some((c) => c.type === 'RenderTag' || hasRender(c));
}

/** Live regions that render a snippet; the controls inside are invisible to this check. */
function renderingRegions(source: string): string[] {
	const ast = parse(source, { modern: true });
	const found: string[] = [];
	const walk = (node: Node) => {
		if (isLiveRegion(node) && hasRender(node)) {
			found.push(`<${node.name}> at offset ${node.start} renders a snippet`);
		}
		for (const child of children(node)) walk(child);
	};
	walk(ast.fragment);
	return found;
}

function violations(source: string): string[] {
	const ast = parse(source, { modern: true });
	const found: string[] = [];
	const walk = (node: Node) => {
		if (isLiveRegion(node)) {
			const hits = findFocusable(node);
			if (hits.length > 0) {
				found.push(`<${node.name}> at offset ${node.start} holds <${hits.join('>, <')}>`);
			}
		}
		for (const child of children(node)) walk(child);
	};
	walk(ast.fragment);
	return found;
}

describe('live regions hold no controls (Issue #1055)', () => {
	it('detects a control inside a live region (self-check)', () => {
		expect(
			violations('<div role="status">{#if a}<p>x</p><button>go</button>{/if}</div>')
		).toHaveLength(1);
		expect(violations('<p aria-live="polite">x</p><button>go</button>')).toHaveLength(0);
		expect(violations('<span role="alert"><a href="/x">x</a></span>')).toHaveLength(1);
	});

	it('detects a live region that renders a snippet (self-check)', () => {
		expect(
			renderingRegions('<div role="status">{#each a as t}{@render item(t)}{/each}</div>')
		).toHaveLength(1);
		expect(renderingRegions('<div>{@render item(1)}</div><p role="status">x</p>')).toHaveLength(0);
	});

	it('lets only the listed files render a snippet inside a live region', () => {
		const all: string[] = [];
		for (const root of roots) {
			for (const file of svelteFiles(root)) {
				const rel = relative(repoRoot, file).replaceAll('\\', '/');
				if (ALLOWED.has(rel) || RENDER_ALLOWED.has(rel)) continue;
				for (const v of renderingRegions(readFileSync(file, 'utf8'))) all.push(`${rel}: ${v}`);
			}
		}
		expect(all).toEqual([]);
	});

	it('keeps RENDER_ALLOWED honest (each file still renders a snippet in a region)', () => {
		for (const rel of RENDER_ALLOWED) {
			expect(renderingRegions(readFileSync(join(repoRoot, rel), 'utf8')).length).toBeGreaterThan(0);
		}
	});

	it('finds no focusable element inside role=status / role=alert / aria-live in the sources', () => {
		const all: string[] = [];
		for (const root of roots) {
			for (const file of svelteFiles(root)) {
				const rel = relative(repoRoot, file).replaceAll('\\', '/');
				if (ALLOWED.has(rel)) continue;
				for (const v of violations(readFileSync(file, 'utf8'))) all.push(`${rel}: ${v}`);
			}
		}
		expect(all).toEqual([]);
	});
});
