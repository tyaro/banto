//! Banto admin services (docs/template-scope.md §7, theme C PR-C1): the
//! domain-agnostic (`items`-free) slice of what used to live entirely in
//! `admin-template-core`'s service layer. Moving it here shrinks the surface
//! a template adopter has to copy-and-maintain: this crate is a normal
//! workspace dependency (`admin-template-core` depends ON it, like it already
//! depends on `banto-storage`), not code the adopter owns.
//!
//! PR-C1 moved the two most self-contained services (settings, audit) plus
//! the shared RBAC [`Role`] vocabulary they need (`SettingsService`'s
//! `AuthSettings.disabled_role` is a `Role`). PR-C2 (§7 移行順 ②) adds
//! [`users`] (`UsersService`, M10 RBAC), the RBAC-central service with the
//! most REST/Tauri test coverage. It uses the same [`Role`], which was left
//! in place in [`rbac`] and re-exported from [`users`] (minimal churn - the
//! type did not need to move again now that both live in this crate).
//! `backup` and the REST router move in later PRs.
//!
//! Like every Banto service (conventions §2), the services here take a
//! `banto_storage::Db` handle, return `Result<_, banto_core::BantoError>`,
//! and know nothing about `axum`/`tauri`/RBAC/HTTP - authorization, audit,
//! and event notification are added by the REST/Tauri wiring layer in
//! `admin-template-core`. This crate deliberately does NOT depend on `axum`
//! or `tauri` (verified by `scripts/verify-architecture.mjs` rule 1).
//!
//! Table ownership stays with the app (conventions §11): this crate owns no
//! migrations. `settings`/`audit_log` DDL lives in `admin-template-core`'s
//! `migrations-{sqlite,postgres}/`; the unit tests here re-state the same
//! `CREATE TABLE` inline (see each module's test helper), the same pattern
//! `banto-attachments` uses to avoid a backwards dependency on the app crate.

pub mod audit;
pub mod rbac;
pub mod settings;
pub mod users;

pub use rbac::Role;
