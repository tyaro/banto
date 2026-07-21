# CLAUDE.md

このリポジトリの道案内は [AGENTS.md](AGENTS.md) に集約している（ドリフトを避けるため
一本化）。作業を始める前に必ず AGENTS.md を読むこと。

要点だけ再掲:

- ドキュメントは2トラック — **保守者向け = `docs/`**（特に
  [docs/conventions.md](docs/conventions.md) の不変条件）、**アプリ作者向け = [README](README.md)**。
- 破ってはいけない不変条件（両経路対称 / サービス層非依存 / 依存を足さない /
  逆依存禁止 / セキュリティ / トークンのみ）は
  [docs/conventions.md](docs/conventions.md) に全文。
- 検証: `pnpm check` / `cargo test` / `pnpm e2e` / `cargo audit`。
  `src-tauri` はこのサンドボックスではコンパイル不可（コードレビューで担保）。
