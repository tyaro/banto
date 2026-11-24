//! A pre-v8 database is refused with one message and exit code 1, not a panic
//! (Issue #918, found in the v8 pre-release check #757).

use std::process::Command;

use sqlx::Connection;

/// The checksum v7.11.0 recorded for migration 3 (`0003_users.sql`), the same
/// value `db.rs` uses to recognise a pre-v8 database.
const V7_USERS_CHECKSUM_SQLITE: &str =
    "25f4a5973321cc81959ce2f2e211df45acdfa0d0e9db30db155dd3ac62a36b00b82edbf393ac250b4867e2a30e1b1240";

#[tokio::test]
async fn pre_v8_database_stops_with_exit_code_1_and_a_clean_message() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.db");
    // A current database whose migration 3 looks like v7.11.0's.
    let db = admin_template_core::db::init_db(&path).await.unwrap();
    drop(db);
    {
        let mut conn = sqlx::SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        let checksum: Vec<u8> = (0..V7_USERS_CHECKSUM_SQLITE.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&V7_USERS_CHECKSUM_SQLITE[i..i + 2], 16).unwrap())
            .collect();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = 3")
            .bind(checksum)
            .execute(&mut conn)
            .await
            .unwrap();
    }

    let output = Command::new(env!("CARGO_BIN_EXE_banto-serve"))
        .env("BANTO_DB", &path)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
    assert!(stderr.contains("起動できません"), "stderr: {stderr}");
    assert!(stderr.contains("v8.0.0 より前の版"), "stderr: {stderr}");
    assert!(!stderr.contains("panicked"), "stderr: {stderr}");
}
