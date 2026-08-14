# AGENTS.md — Banto で作業する AI エージェント向けの道案内

> English: [AGENTS.en.md](AGENTS.en.md)

Banto（番頭）は **Tauri デスクトップ + LAN ブラウザ配信の二形態で動く汎用管理画面
テンプレート**。Rust（axum + sqlx。SQLite 既定・PostgreSQL 対応）バックエンドと SvelteKit（Svelte 5 runes）
フロントのモノレポ。利用者はこれをコピーして個別アプリを作る。

このファイルは「どのタスクで何を読むか」の索引。中身の規約は各ドキュメントにある。

## ドキュメントは2トラック

読者が違うので分けている。**自分のタスクがどちらかを最初に見極める。**

- **トラックA（保守者向け）= `docs/`**: テンプレート自体を保守・機能拡張する人向け。
  不変条件・スコープ判定・実装計画・配布規約。
  - [docs/conventions.md](docs/conventions.md) — 変えてはいけない不変条件（**最重要**）
  - [docs/ui-framework-spec.md](docs/ui-framework-spec.md) — 仕様書（`spec §` の参照先）
  - [docs/roadmap.md](docs/roadmap.md) — マイルストーン計画と §7 実施プロセス
  - [docs/template-scope.md](docs/template-scope.md) — 何を入れる/入れない、削除可能性の判定
  - [docs/publishing.md](docs/publishing.md) — 配布（git tag / `path:` 依存）
  - `docs/*-plan.md` — 個別機能の実装計画（attachments/report/visual-refresh 等。
    実装完了後もコードが `§` 参照する現役仕様アンカー）
  - **調査・レビュー記録**:
    [docs/maintenance-review-2026-08.md](docs/maintenance-review-2026-08.md)
    （最新の棚卸し + 整理統合プラン）、
    [docs/feature-review-2026-08.md](docs/feature-review-2026-08.md)（通称
    M-review 2026-08）、
    [docs/maintainability-review-2026-07.md](docs/maintainability-review-2026-07.md)
    （CR 番号体系の定義元）。
    **対応が完了して凍結した文書は [docs/history/](docs/history/) へ移す**
    （移動前にコード被参照を `rg` で確認 — conventions §12 の文法表参照）
- **トラックB（アプリ作者向け）= [README](README.md)**: このテンプレートから自分の
  アプリを作る人向け。リネーム・デモ差し替え・オプション削除・スキャナ入力レシピ・
  Windows セットアップ。

## タスク別の入り口

- **CRUD リソースを追加する / items を差し替える** →
  [docs/recipes/add-resource.md](docs/recipes/add-resource.md)（チェックリスト形式の正式手順）。
- **RBAC ロールを追加する（admin/editor/viewer に足す）** →
  [docs/recipes/add-role.md](docs/recipes/add-role.md)。
- **利用パッケージをアプリへ組み込む**（scan-wedge / 通知トースト / tree-svelte）→
  [docs/recipes/](docs/recipes/)（README から切り出したトラックB レシピ群）。
- **オプション資産を一括で外す（dock/charts/glass/コマンドパレット/添付/帳票/ツリー）** →
  `pnpm scaffold --preset minimal|standard|full`（`--interactive` / `--dry-run` あり。
  手動手順は README「オプション資産の削除」）。scan-wedge はレシピのみ・未配線の
  ため scaffold は触れない。
- **機能を追加/変更する** → まず [docs/conventions.md](docs/conventions.md) の不変条件を
  読み、[template-scope.md §6](docs/template-scope.md#6-今後の運用ルールと宿題) の
  チェックリストで是非を判断。実装計画は `docs/*-plan.md` に倣う。
- **バグ修正/リファクタ** → [docs/conventions.md](docs/conventions.md) の該当節を確認
  （特にセキュリティ不変条件・逆依存禁止・両経路対称）。
- **「使い方」を説明する/導入手順を直す** → トラックB（README）。
- **仕様の意図を知りたい** → `docs/ui-framework-spec.md`（doc コメントの `spec §N` が指す先）。
- **設計判断の「なぜ・代替案」を知りたい/残したい** → [docs/adr/](docs/adr/README.md)。
  「なぜ」の置き場は3分類（コードコメント / conventions.md / ADR）。代替案を
  比較して倒した判断は ADR に書く（規約本文は conventions.md、局所理由はコード内）。

## 絶対に破ってはいけない不変条件（詳細は conventions.md）

1. mutating 操作は **REST と Tauri の両経路で同一の認可 + 同一の監査**を通す。
2. **サービス層は tauri/axum/RBAC/HTTP 非依存**（Clone + BantoError + sqlx）。認可・監査は
   wiring 層が付ける。
3. **依存を足さない**（chrono/time/tower-http/multipart/tracing/markdown 等は自前実装）。
   引きたくなったら設計判断として議論。
4. **コア → オプションの逆依存禁止**。オプション同梱時は削除手順を明文化。
5. セキュリティ: MIME はマジックバイト判定・**ファイルパスにユーザー入力を使わない**・
   argon2 の前にスロットル・**監査 detail に秘密を入れない**・SQL 列は ColumnMap
   ホワイトリスト経由のみ・`{@html}` は自前生成の全エスケープ済み出力のみ。
6. UI は `--banto-*` トークンのみ（生値は theme に集約）。**UI 文言もキー経由**
   （conventions §13、CI の raw-jp-in-app 検査対象）。provider 分岐は
   tauri/server/demo の3種で provider 層に閉じる。

## ビルドと検証

```bash
pnpm check          # フロントの型検査（各パッケージ svelte-check / tsc）。
                    # lint は pnpm lint、build は pnpm build が別（CI frontend
                    # ジョブは lint→verify:architecture→check:versions→format→
                    # check→test→build を順に回す）
cargo test          # Rust ワークスペース全テスト
pnpm e2e            # Playwright スモーク（e2e/playwright.config.ts、banto-serve 起動）
cargo audit         # 依存監査（.cargo/audit.toml の ignore 付き）
```

注意: `src-tauri` はこのサンドボックスでは webkit2gtk 不在によりコンパイル不可。
Tauri コマンド側の変更はコードレビュー + `tauri-check.yml`（Tauri 側/依存
グラフを触る PR と main push、および週次スケジュールで
`cargo check -p admin-template` + `cargo test -p admin-template` を
ubuntu/windows で実行）で担保する。
CI は `.github/workflows/ci.yml` の各ジョブ（frontend / i18n-offline / rust /
storage-postgres / app-postgres / e2e / audit）に加えて、週次+トリガ型の
`template-acceptance.yml`（copy→rename→check + scaffold 3プリセットの受け入れ）、
`visual-baselines.yml`（Linux visual ベースライン再生成、dispatch）、
`deploy-demo.yml`（GitHub Pages ライブデモ配信）が回る。ジョブの増減は
ci.yml を一次情報とする。

## Definition of Done（委譲タスクの完了報告様式）

変更を完了したら、以下を必ず報告する（roadmap §7 のレビュー工程の入力になる）:

- **触れた不変条件**: conventions.md のどの節に関わる変更か（なければ「なし」）
- **REST / Tauri 双方への影響**: mutating 操作を触った場合、両経路 + denied を
  ペアで実装・テストしたか（conventions §1）
- **追加・更新したテスト**: ファイルとテスト名
- **実行した検証コマンドと結果**: `pnpm check` / `cargo test` / `pnpm e2e` 等
- **実行できなかった検証**: src-tauri のコンパイル等、環境制約で飛ばしたもの
- **ドキュメント更新の有無**: README / docs / CHANGELOG への反映

## 進め方（roadmap §7）

司令塔が設計を固め、タスク分割し、調査/実装を委譲、成果物をレビューして
`pnpm check` / `cargo test` / CI で検証、マイルストーンごとに PR を作成してマージ
（CI ゲート必須）。詳細は [docs/roadmap.md §7](docs/roadmap.md#7-実施プロセス)。
