# Banto

Banto is a full-stack admin framework/template for **Tauri v2 + SvelteKit**
(Svelte 5 runes). It pairs a refine-like headless core with a custom data
grid, schema-driven forms, charts, and a docking layout. The backend is Rust
(axum + sqlx SQLite). It runs as a desktop app, and — via an embedded web
server — can serve the same UI to browsers on the local network. The name
comes from _banto_, the senior clerk who ran an Edo-period merchant house on
the owner's behalf.

## Features

- **Data grid** (`@banto/grid-svelte`): virtual scrolling, multi-column sort,
  column filters, column resize/reorder, Excel-like cell editing, range
  selection, copy & paste, client and server modes, grouping with
  aggregation. Columns can be **auto-derived from a form schema**
  (`columnsFromSchema`, M23, validation included — write one schema and get
  both the list view and the form).
- **Schema-driven forms** (`@banto/forms`): input UI, validation, and state
  management generated from a definition object.
- **Charts** (`@banto/charts`): dependency-free SVG charts, 14 types in
  total — line/area, bar (incl. stacked), pie/donut, scatter, sparkline,
  combo (bar + line), radar, heatmap, gauge, SPC charts (histogram, Pareto,
  box plot), stacked area, and Gantt.
- **Docking layout** (`@banto/dock-svelte`): floating windows, split/tab
  panes, drag-to-rearrange with snapping, layout persisted as JSON.
- **Refine-like headless core** (`@banto/admin-core`): resource definitions,
  `DataProvider`/`AuthProvider` abstractions, `createListResource`/
  `createFormResource` composables. Defaults to Tauri `invoke()` (local
  Rust), swappable for InMemory or HTTP.
- **Embedded web server** (`banto-server`): opt-in; once enabled, other
  devices on the same LAN can use the same admin UI in a browser over
  REST + SSE.
- **Auth, RBAC, and user management**: argon2id credential store with
  first-run setup, three roles (admin/editor/viewer), a user management
  screen, and identical permission checks across both the REST and Tauri
  paths.
- **Audit log**, a settings framework (`SettingsProvider`), and an
  auto-login / no-login mode.
- **CSV/Excel import & export**, a command palette (Ctrl+K), and SQLite
  backup/restore.
- **v1 supports SQLite only** — PostgreSQL support in `banto-storage` exists
  only as a feature flag and is not yet implemented.
- Optional, removable extension packages: reporting/print
  (`@banto/report`), attachment/image management (`@banto/attachments`),
  and barcode/QR scanner input (`@banto/scan-wedge`) — each ships with demo
  wiring that can be deleted.

## Quick start

Requirements: Node 24+ / pnpm 10+ (Rust too, only if running as a Tauri
desktop app).

```sh
git clone https://github.com/tyaro/banto.git my-app
cd my-app
pnpm install
pnpm dev        # http://localhost:1420 (standalone browser demo, log in as admin / admin)
```

Once it's running, there are three files to edit next (see
[docs/recipes/add-resource.md](docs/recipes/add-resource.md) for the full
walkthrough):

1. `apps/admin-template/src/lib/banto/resources/items.ts` — resource
   definition and schema
2. `apps/admin-template/core/migrations/0001_items.sql` — table definition
3. `apps/admin-template/core/src/items.rs` — service layer (CRUD)

To turn this template into your own app (rename identifiers, replace the
demo resource, drop unused packages), run the rename script:

```sh
node scripts/rename.mjs \
  --name my-app \
  --title "My App" \
  --identifier com.example.myapp \
  --repo https://github.com/me/my-app   # optional
# add --dry-run to preview the changes first
```

## Requirements

- Node 24+
- pnpm 10+
- Rust (only needed to build/run the Tauri desktop app)

## Security note

The LAN server is plain HTTP by default — enable it only on trusted
networks. See the Japanese README for the TLS reverse-proxy recipe
(Caddy example under "LANアクセス").

---

Full documentation is in Japanese: see [README.md](README.md). Maintainer
docs live under [docs/](docs/), AI agent guide in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
