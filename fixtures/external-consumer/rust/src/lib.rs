//! 外部利用 fixture（#271）: 公開対象の 5 crate を Git 依存で導入し、
//! 解決・ビルドできることだけを確かめる（API は使わない）。
pub use banto_admin_services;
pub use banto_attachments;
pub use banto_core;
pub use banto_server;
pub use banto_storage;
