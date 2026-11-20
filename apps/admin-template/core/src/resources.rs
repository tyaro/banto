//! Service handles of the resources added by `pnpm banto add resource`
//! (docs/recipes/add-resource.md, Issue #715).
//!
//! The generator writes one field per resource here, so the wiring that
//! already exists - `rest::resources_router`, `src-tauri`'s `AppState`, and
//! both test setups - reaches a new service without a new parameter at every
//! call site. The struct is empty until the first resource is added. A
//! resource written by hand may live here too, or follow `items` (its own
//! field in `rest::Services` / `AppState`); the two styles do not conflict.
//!
//! The `[banto:add-resource:...]` comments are the generator's insertion
//! points. It stops without writing anything when one is missing, so keep
//! them when editing this file.

use banto_server::ServerEvent;
use banto_storage::Db;
use tokio::sync::broadcast;

/// Cheap to clone, like the services it holds (a `Db` handle and an event
/// sender each).
#[derive(Clone)]
pub struct AppResources {
    // [banto:add-resource:resource-fields]
}

impl AppResources {
    /// Build every added resource's service over `db`, each announcing its
    /// writes on `events` (`ServerEvent::ResourceChanged`).
    pub fn new(db: &Db, events: &broadcast::Sender<ServerEvent>) -> Self {
        // Nothing reads these until the first resource is added.
        let _ = (db, events);
        Self {
            // [banto:add-resource:resource-init]
        }
    }
}
