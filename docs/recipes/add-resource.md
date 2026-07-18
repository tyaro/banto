# レシピ: CRUD リソースを追加する（items を手本にする正式手順）

作成日: 2026-07-18（improvement-plan-2026-07.md P1-3。spec §14 の
「ルート導出方式」の決着に伴う成果物）

対象読者: **アプリ作者（トラックB）と、テンプレート保守者・AI エージェント
（トラックA）の両方**。新しい CRUD リソース（例: `customers`）を追加する
とき、または同梱デモの `items` を自リソースに差し替えるときの唯一の正式
手順。AI にリソース追加を委譲するときは、本レシピをそのまま指示に使う。

## 方式の決定（2026-07-18）

リソースのページは**動的ルート `[resource]` による自動導出ではなく、
`items` のルート一式をコピーして書き換える**方式を正式な規約とする
（spec §14 の未決事項を決着）。理由: テンプレートの「すべては削除可能・
コピーして理解できる」方針（template-scope §1）と整合し、動的ルート化は
利用者が読み解けない魔法を増やすため。

## チェックリスト（実施順）

Rust 側 → フロント側の順に進める。各ステップの「手本」列のファイルを
コピーして書き換えるのが最短。

| #   | ステップ                                                                                                                                  | 手本（items の実装）                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | マイグレーション追加（連番 SQL、conventions §11）                                                                                         | `apps/admin-template/core/migrations/0001_items.sql`                                                     |
| 2   | サービス層追加（Clone + BantoError + sqlx、tauri/axum 非依存。`column_map()` でソート/フィルタ列をホワイトリスト化 — conventions §2, §6） | `apps/admin-template/core/src/items.rs`                                                                  |
| 3   | REST ルート追加（`RoleGuard` + `record_write` で認可・監査 — conventions §1）                                                             | `apps/admin-template/core/src/rest/items.rs`（コピーして `rest/<yours>.rs` を作り `rest/mod.rs` に登録） |
| 4   | Tauri コマンド追加（`require_role` + `audit.record(...)` — REST と**同一の**認可・監査）                                                  | `apps/admin-template/src-tauri/src/lib.rs` の `items_*` コマンドと `AppState.items`                      |
| 5   | **両経路の認可対称テスト**（許可ロールの成功 + denied の記録、REST/Tauri 双方。読み取り系は監査しない — conventions §1）                  | `rest/tests.rs` / 各サービスの `#[cfg(test)]`                                                            |
| 6   | 監査イベントの確認（mutating 操作すべてが `record_write`/`audit.record` を通ること。detail に秘密を入れない — conventions §6）            | 同上                                                                                                     |
| 7   | フロント: リソース定義 + スキーマ登録（`resources/<yours>.ts` を作り `resources/index.ts` の配列に追加）                                  | `apps/admin-template/src/lib/banto/resources/items.ts`・同 `resources/index.ts`                          |
| 8   | フロント: ページ・ナビ追加（一覧/詳細/新規のルートをコピー、`navigation.ts` にエントリ）                                                  | `apps/admin-template/src/routes/(app)/items/`・`src/lib/navigation.ts`                                   |
| 9   | （必要なら）ダッシュボードパネル・CSV インポート・E2E スモーク1本                                                                         | `src/lib/banto/dashboard.ts`・`itemsAdmin.ts`・`e2e/tests/smoke.spec.ts`                                 |

ブラウザ単体デモ（InMemory）にも出したい場合は
`src/lib/banto/sampleData.ts` に生成データを足す（任意。デモに出さない
機能は conventions §10 の「demo は明示拒否」に従う）。

## 検証

```bash
pnpm check     # フロント lint/型
cargo test     # サービス層 + REST のテスト（:memory: SQLite）
pnpm e2e       # スモーク（banto-serve 起動、E2E を足した場合）
```

`src-tauri` はサンドボックス環境ではコンパイルできないことがある
（AGENTS.md）。その場合、ステップ4はコードレビュー + 週次の Tauri CI
（improvement-plan P3-2）で担保し、完了報告に「未実行の検証」として明記
する（AGENTS.md「Definition of Done」）。

## やってはいけないこと（conventions.md の該当節）

- 片方の経路（REST or Tauri）だけにコマンドを足す（§1）
- サービス層に axum/tauri/RBAC を持ち込む（§2）
- フロント由来のフィールド名を `ColumnMap` を通さず SQL に使う（§6）
- 監査 detail にパスワード・トークンを入れる（§6）
- コンポーネント CSS に生の色値を書く（§9）

## items を削除する場合

自リソースへの差し替えが済んだら、上表の「手本」列のファイル一式が
削除対象になる（逆向きに辿ればよい）。`attachments` の items デモ配線を
使っている場合は README「オプション資産の削除」の手順が先。
