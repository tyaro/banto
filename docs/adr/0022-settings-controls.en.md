# ADR-0022: Use underline navigation for settings categories and native selects with fixed labels

> Japanese: [0022-settings-controls.md](0022-settings-controls.md)

- Status: Accepted
- Date: 2026-11-03
- Related: [Issue #495](https://github.com/tyaro/banto/issues/495) /
  [conventions.md](../conventions.md) §3, §9, §13 /
  [choiapp-feedback-2026-09.md](../reviews/choiapp-feedback-2026-09.md) §3.2

## Context

Settings categories and select controls each had enclosing borders, and the shell and content repeated the page title.
The owner approved adopting the underline design tried on the settings pages.
We reduce enclosing borders while retaining Svelte 5, the existing themes, route navigation, and native selection behavior.

## Decision

- Use horizontal underline navigation for settings categories. Links wrap at narrow widths, and only the current link has an underline.
  Categories are separate pages, so retain `nav`, links, and `aria-current="page"`.
- Use native `select` controls with an always-visible fixed label, a subtle background, and a bottom border.
  Keep the browser/OS arrow and popup, including their keyboard and touch behavior.
- Show focus with a solid outline and disabled state with the existing dimming plus a dashed bottom border.
  In forced colors, remove inactive links' borders so the current underline remains distinct.
- Display the page title in the shell header. Retain a visually hidden `h1` in the settings content for assistive technology;
  visible content starts with the description and category navigation.
- Keep the implementation in the settings `+layout.svelte` and `.settings-page`-scoped `settings.css`.
  Use existing theme tokens for colors and dimensions. Add no libraries, fonts, or images.

## Alternatives considered

- **Retain bordered pill categories:** More enclosing borders also resemble the setting selection controls.
  Underlining the current page better separates navigation from content.
- **Make floating labels the default:** Long Japanese labels, autofill, empty values, and errors add state combinations.
  Adopt fixed labels that remain readable without moving them.
- **Replace native selects with custom comboboxes or an external UI library:** Native `select` is sufficient for the current options.
  Without a search or free-text requirement, avoid adding popup, focus, and assistive-technology maintenance.
  Carbon, shadcn/ui, and CodePen informed the investigation; no code, SVGs, or fonts are copied.

## Consequences

- Adoption covers settings categories and select controls. It does not automatically extend to `packages/forms`,
  `packages/grid-svelte`, all cards, or SCADA operator displays.
  Expand shared components through separate changes after checking their actual usage and states.
- Saving, permissions, unsaved-change guards, and REST/Tauri provider selection remain unchanged.
- Maintain checks for light/dark, standard/glass, standard/compact, Japanese/English, narrow widths,
  keyboard navigation, focus, disabled state, and forced colors. Maintain settings screenshots and axe scans.
- Native selection details vary by OS/browser. Chromium and stubbed IPC checks do not establish that native
  Tauri WebViews, touch interaction, or screen readers have been tested on a device.
