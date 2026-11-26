//! The geometry memory: panel id -> [`PanelGeometry`], kept in one small JSON
//! file (ADR-0037). Pure std + serde_json - no Tauri type - so reading,
//! writing and the recovery from a broken file are unit-tested in CI's
//! headless build.
//!
//! The file is a convenience, never a source of truth: a missing, unreadable
//! or malformed file is the same as "nothing remembered", and a failed write
//! only loses the memory of that session. Nothing here returns an error the
//! app has to show.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::validate_panel_id;
use crate::geometry::PanelGeometry;

/// Format version written to the file. A file with another version is
/// ignored (read as empty) and overwritten on the next save.
const FILE_VERSION: u32 = 1;
/// Upper bound of remembered panels. Ids come from the webview; this keeps
/// the file from growing without limit. A new id past the bound is simply
/// not remembered.
pub const MAX_ENTRIES: usize = 256;

#[derive(Debug, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    panels: BTreeMap<String, PanelGeometry>,
}

/// In-memory copy of the geometry file plus its path.
#[derive(Debug)]
pub struct GeometryStore {
    path: PathBuf,
    panels: BTreeMap<String, PanelGeometry>,
    dirty: bool,
}

impl GeometryStore {
    /// Reads `path`. Anything that is not a well-formed file of the current
    /// version yields an empty store; entries with an invalid id or an
    /// implausible geometry are dropped.
    pub fn load(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let panels = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StoreFile>(&bytes).ok())
            .filter(|file| file.version == FILE_VERSION)
            .map(|file| {
                file.panels
                    .into_iter()
                    .filter(|(id, g)| validate_panel_id(id).is_ok() && g.is_plausible())
                    .take(MAX_ENTRIES)
                    .collect()
            })
            .unwrap_or_default();
        Self {
            path,
            panels,
            dirty: false,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn get(&self, id: &str) -> Option<PanelGeometry> {
        self.panels.get(id).copied()
    }

    /// Remembers `geometry` for `id` (in memory; [`Self::save`] writes it).
    /// Returns whether anything changed. An invalid id, an implausible
    /// geometry, or a new id past [`MAX_ENTRIES`] is ignored.
    pub fn set(&mut self, id: &str, geometry: PanelGeometry) -> bool {
        if validate_panel_id(id).is_err() || !geometry.is_plausible() {
            return false;
        }
        match self.panels.get(id) {
            Some(current) if *current == geometry => return false,
            None if self.panels.len() >= MAX_ENTRIES => return false,
            _ => {}
        }
        self.panels.insert(id.to_string(), geometry);
        self.dirty = true;
        true
    }

    /// Whether there is something [`Self::save`] has not written yet.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Writes the file if anything changed since the last load / save:
    /// creates the parent directory, writes a sibling temp file and renames
    /// it over the target, so a crash mid-write leaves the old file.
    pub fn save(&mut self) -> io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let file = StoreFile {
            version: FILE_VERSION,
            panels: self.panels.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(io::Error::other)?;
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, bytes)?;
        if let Err(err) = fs::rename(&tmp, &self.path) {
            let _ = fs::remove_file(&tmp);
            return Err(err);
        }
        self.dirty = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geom(x: i32) -> PanelGeometry {
        PanelGeometry {
            x,
            y: 20,
            width: 560,
            height: 420,
        }
    }

    #[test]
    fn missing_file_is_an_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = GeometryStore::load(dir.path().join("panel-windows.json"));
        assert_eq!(store.get("memo"), None);
        assert!(!store.is_dirty());
    }

    #[test]
    fn set_save_load_round_trips_and_creates_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("panel-windows.json");

        let mut store = GeometryStore::load(&path);
        assert!(store.set("memo", geom(10)));
        assert!(store.set("trend", geom(-1500)));
        assert!(store.is_dirty());
        store.save().unwrap();
        assert!(!store.is_dirty());

        let reloaded = GeometryStore::load(&path);
        assert_eq!(reloaded.get("memo"), Some(geom(10)));
        assert_eq!(reloaded.get("trend"), Some(geom(-1500)));
        assert_eq!(reloaded.path(), path.as_path());
        // No temp file is left behind.
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("panel-windows.json")]);
    }

    #[test]
    fn save_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("panel-windows.json");
        let mut store = GeometryStore::load(&path);
        store.set("memo", geom(10));
        store.save().unwrap();
        store.set("memo", geom(30));
        store.save().unwrap();
        assert_eq!(GeometryStore::load(&path).get("memo"), Some(geom(30)));
    }

    #[test]
    fn unchanged_value_is_not_dirty_and_save_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("panel-windows.json");
        let mut store = GeometryStore::load(&path);
        store.save().unwrap();
        assert!(!path.exists(), "nothing changed, nothing written");

        store.set("memo", geom(10));
        store.save().unwrap();
        assert!(!store.set("memo", geom(10)));
        assert!(!store.is_dirty());
    }

    #[test]
    fn malformed_or_foreign_files_are_read_as_empty_and_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("panel-windows.json");
        for content in [
            "not json",
            "[]",
            r#"{"version":2,"panels":{"memo":{"x":1,"y":2,"width":560,"height":420}}}"#,
            r#"{"version":1,"panels":{"memo":{"x":"1"}}}"#,
        ] {
            fs::write(&path, content).unwrap();
            let mut store = GeometryStore::load(&path);
            assert_eq!(store.get("memo"), None, "{content}");
            store.set("memo", geom(10));
            store.save().unwrap();
            assert_eq!(GeometryStore::load(&path).get("memo"), Some(geom(10)));
        }
    }

    #[test]
    fn bad_entries_in_a_file_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("panel-windows.json");
        fs::write(
            &path,
            r#"{"version":1,"panels":{
                "ok":{"x":1,"y":2,"width":560,"height":420},
                "../x":{"x":1,"y":2,"width":560,"height":420},
                "tiny":{"x":1,"y":2,"width":0,"height":0}
            }}"#,
        )
        .unwrap();
        let store = GeometryStore::load(&path);
        assert!(store.get("ok").is_some());
        assert_eq!(store.get("../x"), None);
        assert_eq!(store.get("tiny"), None);
    }

    #[test]
    fn invalid_ids_and_implausible_geometry_are_not_remembered() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = GeometryStore::load(dir.path().join("p.json"));
        assert!(!store.set("../x", geom(10)));
        assert!(!store.set(
            "memo",
            PanelGeometry {
                x: -32000,
                y: -32000,
                width: 560,
                height: 420
            }
        ));
        assert!(!store.is_dirty());
    }

    #[test]
    fn the_number_of_remembered_panels_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = GeometryStore::load(dir.path().join("p.json"));
        for i in 0..MAX_ENTRIES {
            assert!(store.set(&format!("p{i}"), geom(10)));
        }
        assert!(!store.set("one-more", geom(10)));
        assert_eq!(store.get("one-more"), None);
        // An id already remembered can still be updated.
        assert!(store.set("p0", geom(99)));
    }

    #[test]
    fn save_failure_keeps_the_store_dirty() {
        let dir = tempfile::tempdir().unwrap();
        // The target path is a directory: the rename cannot succeed.
        let path = dir.path().join("as-dir");
        fs::create_dir(&path).unwrap();
        let mut store = GeometryStore::load(&path);
        store.set("memo", geom(10));
        assert!(store.save().is_err());
        assert!(store.is_dirty());
    }
}
