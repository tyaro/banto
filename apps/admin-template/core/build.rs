// `sqlx::migrate!`（db.rs・テスト）は migration の SQL をマクロ展開時に
// 埋め込むが、安定版の sqlx は migration ファイルの変更をビルドの依存として
// 追跡しない。SQL だけを変えた増分ビルドが古い本文を埋め込まないよう、
// ディレクトリ単位で再実行を指示する（sqlx の公式の案内。新規ファイルの追加も
// ディレクトリの変更として検知される）。Issue #340。
fn main() {
    println!("cargo:rerun-if-changed=migrations-sqlite");
    println!("cargo:rerun-if-changed=migrations-postgres");
}
