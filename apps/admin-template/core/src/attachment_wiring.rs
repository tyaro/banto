//! Attachment-related wiring shared by the REST handlers (`crate::rest`) and
//! the Tauri commands (`src-tauri`), so both paths produce the same audit
//! `detail` (conventions §1). This builds audit details, so it lives here in
//! the wiring layer and not in `banto_attachments` (conventions §2);
//! authorization and the `record_write`/`record_ok` calls stay on each path.

use banto_attachments::{AttachmentMeta, AttachmentsService};
use serde_json::{json, Value};

/// Audit `detail` of an attachment `create`/`delete` entry.
pub fn attachment_audit_detail(meta: &AttachmentMeta) -> Value {
    json!({
        "fileName": meta.file_name,
        "sizeBytes": meta.size_bytes,
        "parentResource": meta.resource,
        "parentId": meta.resource_id,
    })
}

/// Removes the attachments left pointing at the just-deleted item `id` and
/// returns the audit `detail` of its `delete` entry (`None` when nothing was
/// removed).
///
/// Best-effort (`docs/design/attachments-plan.md` §3.8): a storage hiccup here
/// must not turn an already-successful item delete into an error (the item is
/// gone either way; a stray attachment row is a cleanup nit, not data loss), so
/// a failure is logged and counts as zero removed.
pub async fn sweep_item_attachments(attachments: &AttachmentsService, id: i64) -> Option<Value> {
    let attachments_removed = match attachments
        .delete_for_record("items", &id.to_string())
        .await
    {
        Ok(count) => count,
        Err(err) => {
            eprintln!(
                "banto: item {id} の添付ファイル削除に失敗しました（item自体の削除は完了済み）: {err}"
            );
            0
        }
    };
    (attachments_removed > 0).then(|| json!({ "attachmentsRemoved": attachments_removed }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use banto_attachments::NewAttachment;
    use banto_storage::Db;

    #[tokio::test]
    async fn sweep_reports_the_removed_count_and_none_when_nothing_was_removed() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::migrate_memory().await.unwrap();
        let attachments = AttachmentsService::new(db, dir.path().join("attachments"));
        attachments
            .upload(NewAttachment {
                resource: "items".to_string(),
                resource_id: "7".to_string(),
                file_name: "notes.txt".to_string(),
                created_by: None,
                bytes: b"hello attachment".to_vec(),
            })
            .await
            .unwrap();

        assert_eq!(
            sweep_item_attachments(&attachments, 7).await,
            Some(json!({ "attachmentsRemoved": 1 }))
        );
        assert_eq!(sweep_item_attachments(&attachments, 7).await, None);
    }

    #[tokio::test]
    async fn sweep_failure_counts_as_nothing_removed() {
        let dir = tempfile::tempdir().unwrap();
        // No migrations, so the `attachments` table is missing and the sweep fails.
        let db = Db::connect_sqlite_memory().await.unwrap();
        let attachments = AttachmentsService::new(db, dir.path().join("attachments"));

        assert_eq!(sweep_item_attachments(&attachments, 7).await, None);
    }
}
