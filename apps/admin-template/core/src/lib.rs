//! admin-template's domain/service layer (spec §10). Kept tauri-free so it
//! is testable without the src-tauri crate (which cannot be built in every
//! environment, e.g. CI containers without webkit2gtk). Thin
//! `tauri::command` adapters in `src-tauri` call into this crate; the same
//! services back the embedded REST server in M6.

pub mod assets;
pub mod attachment_wiring;
pub mod db;
pub mod events;
pub mod first_account;
pub mod first_boot;
// [scaffold:items] begin
pub mod items;
// [scaffold:items] end
// `pnpm banto add resource` declares each new resource's module above this
// line (docs/recipes/add-resource.md).
// [banto:add-resource:core-mod]
pub mod resources;
pub mod rest;
pub mod startup;

// Theme C (docs/template-scope.md §7): the domain-agnostic services moved to
// the shared `banto-admin-services` crate to shrink the surface a template
// adopter copy-maintains. PR-C1 移行順 ① moved settings/audit; PR-C2 移行順 ②
// moved `users` (`UsersService`, M10 RBAC); PR-C3 移行順 ③ moved `backup`
// (`BackupService`, M17, SQLite-only). Re-exported here so existing
// `crate::{settings,audit,users,backup}::*` paths - REST wiring, `src-tauri`
// commands, `bin/banto-serve.rs` (startup `apply_pending_restore_at_startup`),
// other services, and `admin_template_core::users::{UsersService, Role, ...}` -
// resolve unchanged: the services' location changed, not the REST/Tauri
// exposure (conventions §1 両経路対称は不変).
pub use banto_admin_services::{audit, backup, settings, system_info, system_metrics, users};

/// The permissions this app registers (Issue #697, user-permissions-plan
/// §3-3 / §8-2): the vocabulary of per-user permissions an admin can grant,
/// separate from the role. The template registers none, so the admin screen
/// shows no permission field and every permission guard refuses. A derived
/// app registers its own here, e.g.
/// `PermissionCatalog::empty().register("equipment.operate", "perm.equipment_operate", "perm.equipment_operate_desc")?`,
/// and every `UsersService` of the app (the REST server and the desktop
/// app) is built with it (`UsersService::new(db).with_permission_catalog(...)`),
/// so both paths judge with the same catalog (conventions §1).
pub fn permission_catalog() -> users::PermissionCatalog {
    users::PermissionCatalog::empty()
}
