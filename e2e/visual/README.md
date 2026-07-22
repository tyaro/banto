# Visual regression + axe-core (`visual` Playwright project)

Phase 0 of `docs/visual-refresh-plan.md` / §12 of
`docs/visual-refresh-design.md`. Separate from the `chromium` (M18 smoke)
project in `e2e/playwright.config.ts` - different `testDir`, different
`webServer` (plain `vite preview` in browser demo mode, not `banto-serve`),
never runs together with smoke.

## What's here

- `theme.ts` - shared helpers: the light/dark × standard/glass matrix and
  `primeTheme`/`primeThemeAndAuth`, which inject `localStorage`/
  `sessionStorage` via `addInitScript` before first paint (same keys
  `app.html`'s FOUC script and `setup.ts`'s demo `AuthProvider` read).
- `visual.spec.ts` - `expect(page).toHaveScreenshot()` baselines for login,
  dashboard, items, users, settings, and the command palette.
- `a11y.spec.ts` - `@axe-core/playwright` scans (`wcag2a`/`wcag2aa`) of
  dashboard, items, settings, and login.

## Running

```sh
# Build the static admin-template first - the `visual` project's webServer
# is `vite preview`, which serves apps/admin-template/build/.
pnpm --filter admin-template build

pnpm e2e:visual
```

`pnpm e2e` (the M18 smoke suite) never runs these specs - it's pinned to
`--project=chromium`. Conversely `pnpm e2e:visual` is pinned to
`--project=visual` and never runs `e2e/tests/smoke.spec.ts`.

## Updating baselines

After an intentional visual change, regenerate the baselines and review the
diff like any other source change:

```sh
pnpm --filter admin-template build
pnpm e2e:visual --update-snapshots
```

Re-run `pnpm e2e:visual` (without `--update-snapshots`) afterwards to
confirm the new baselines actually pass.

**Baseline images are OS-specific.** Playwright appends the platform to
each snapshot's filename (e.g. `...-linux.png`). This repo's baselines were
generated on Linux; running `--update-snapshots` on macOS or Windows adds
`-darwin`/`-win32` files alongside them rather than replacing them. Generate
baselines on Linux (matches CI) unless you specifically need another
platform's set.

Without a Linux box, dispatch `.github/workflows/visual-baselines.yml` on the
branch carrying the visual change: it regenerates the `-linux` baselines on
the same `ubuntu-latest` image CI uses, re-runs the suite against them to
prove they pass, and uploads them as an artifact. Dispatch it again with
`commit: true` to push the regenerated PNGs back to that branch.

## Notes

- Theme/preset are forced explicitly (`light`/`dark`, `standard`/`glass`) -
  never `system` - so screenshots never depend on the runner's OS color
  scheme. Density is always `standard`.
- Auth is bypassed via the same `sessionStorage` flag the demo
  `AuthProvider` sets on a real login (`banto.auth.demo`), not a UI login
  flow - faster and avoids adding an unrelated source of flakiness to pixel
  comparisons.
- No `waitForLoadState('networkidle')`: browser demo mode has no backend
  round trips (no SSE, no REST) to go idle on. Each test waits for a
  concrete visible element instead, plus a short fixed settle for chart/dock
  layout math (animations are already zeroed by `reducedMotion: 'reduce'`).
- The dock's default layout (docked monthly/priceBuckets panels + floating
  memo panel) is what a fresh `localStorage` always produces - these tests
  never touch a pre-existing dock layout.
