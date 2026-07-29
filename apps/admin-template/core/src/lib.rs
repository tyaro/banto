//! admin-template's domain/service layer (spec §10). Kept tauri-free so it
//! is testable without the src-tauri crate (which cannot be built in every
//! environment, e.g. CI containers without webkit2gtk). Thin
//! `tauri::command` adapters in `src-tauri` call into this crate; the same
//! services back the embedded REST server in M6.

pub mod assets;
pub mod backup;
pub mod db;
pub mod events;
pub mod items;
pub mod rest;

// Theme C (docs/template-scope.md §7): the domain-agnostic services moved to
// the shared `banto-admin-services` crate to shrink the surface a template
// adopter copy-maintains. PR-C1 移行順 ① moved settings/audit; PR-C2 移行順 ②
// moved `users` (`UsersService`, M10 RBAC). Re-exported here so existing
// `crate::{settings,audit,users}::*` paths - REST wiring, `src-tauri`
// commands, `bin/banto-serve.rs`, other services, and
// `admin_template_core::users::{UsersService, Role, ...}` - resolve unchanged:
// the services' location changed, not the REST/Tauri exposure (conventions §1
// 両経路対称は不変).
pub use banto_admin_services::{audit, settings, users};
