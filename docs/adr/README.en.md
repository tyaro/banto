# Architecture Decision Records (ADR)

> The Japanese [`README.md`](README.md) is the source of truth; this English version follows it. If they diverge, the Japanese wins.

Created: 2026-07-19 (improvement-plan-2026-07.md P4-7)

This directory records Banto's **foundational design decisions**, including the
comparison of alternatives. It is a Track A (maintainer-facing) asset; if you
hard-fork, you may delete all of `docs/` ("everything is deletable" policy).

## Why ADRs — the three categories of documentation

Banto's "why we write it this way" is split by role across three places. **Do
not write the same "why" in two places** (to avoid the sync cost on changes).

| Place                                      | What to write                                                                                                                 | Example                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Code comments**                          | Local reasons that only make sense at that spot, on that line                                                                 | "revoke the object URL in `finally`" / "wrap this effect in untrack"                                        |
| **[conventions.md](../conventions.en.md)** | Cross-project **invariants** (rules that break things if not upheld)                                                          | "both paths symmetric" / "the service layer knows nothing of axum/tauri" / "raw color values are forbidden" |
| **ADR (this directory)**                   | **Design decisions where alternatives were compared and one was chosen** (the still-valid "why Z, and why X/Y were rejected") | "why two paths" / "why dependency minimization"                                                             |

Whereas conventions.md is the "**rules** (what to uphold)," the ADR records the
"**decisions** (why that rule was chosen, and why the other options were
discarded)." The decision behind each invariant in conventions.md can, if a
corresponding ADR exists, be traced from there.

## Operation

- **Do not backfill in bulk.** Turning an existing decision into an ADR is
  raised one at a time, at the moment you next touch that decision (revisit it,
  or add a related feature). The "ADR candidates" below are an unstarted
  backlog.
- When you make a new foundational decision (one with alternatives, tipped in
  one direction), write one ADR at that moment.
- File name: `NNNN-kebab-title.md` (sequential number). The format is
  [0000-template.md](0000-template.en.md).
- Status is `Accepted` / `Superseded by ADR-NNNN` / `Deprecated`. **Do not
  rewrite a past ADR; when overturning one, supersede it with a new ADR**
  (retaining the history of decisions is the value of ADRs).

## Index

| #                                                    | Title                                                                                              | Status   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| [0001](0001-rest-tauri-two-path-symmetry.en.md)      | Make REST and Tauri two peer paths and route a single service layer symmetrically through both     | Accepted |
| [0002](0002-minimal-dependencies.en.md)              | Add no dependencies and make in-house implementation the default (minimize total maintenance cost) | Accepted |
| [0003](0003-tls-via-reverse-proxy.en.md)             | Officially support LAN TLS via reverse-proxy termination and defer built-in TLS                    | Accepted |
| [0004](0004-server-logging-eprintln.en.md)           | Set `eprintln!` as the default for server logging and defer `tracing`                              | Accepted |
| [0005](0005-i18n-paraglide.en.md)                    | Adopt Paraglide JS as the UI i18n runtime (an exception to ADR-0002)                               | Accepted |
| [0006](0006-docs-in-repo-projects-status-only.en.md) | Consolidate knowledge docs in-repo and confine GitHub Projects to ephemeral status only            | Accepted |

## ADR candidates (unstarted; do not backfill)

Raise one at a time when you next touch the decision (P4-7):

- Why make SQLite the default and defer PostgreSQL (spec §12.1 / P4-5)
- Why the Provider approach (absorbing the three environments Tauri/HTTP/InMemory) (spec §11.1)
- Why not build a runtime plugin mechanism in a "copy-type template"
  (template-scope §3.1)
- Why distribute via git dependencies rather than publishing to npm/crates.io
  (publishing.md)
- Why we did not make resource routes dynamic but chose "a convention of copying
  items" (recipes/add-resource.en.md, spec §14 resolution)
