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
pub mod users;

// Theme C PR-C1 (docs/template-scope.md §7 移行順 ①): the domain-agnostic
// settings/audit services moved to the shared `banto-admin-services` crate to
// shrink the surface a template adopter copy-maintains. Re-exported here so
// existing `crate::settings::*` / `crate::audit::*` paths (REST wiring,
// `src-tauri` commands, `bin/banto-serve.rs`, other services) resolve
// unchanged - the services' location changed, not the REST/Tauri exposure
// (conventions §1 両経路対称は不変).
pub use banto_admin_services::{audit, settings};
