# 残作業一覧（2026-07-23 時点）

対象読者: **保守者 / 引き継ぐ AI エージェント**。全ドキュメントを横断して
「保留・未着手・オーナー判断待ち」を一覧化した索引。各項目は**一次情報の
ドキュメントへのポインタ**を持つ（詳細はそちらが正、本書は重複させない）。

> セッション状態のスナップショットは [handoff-2026-07-22.md](handoff-2026-07-22.md)、
> 恒久的な道案内は [AGENTS.md](../AGENTS.md)、不変条件は
> [conventions.md](conventions.md)。本書はそれらから抽出した「残っている作業」の索引。

---

## 0. 直近セッション（2026-07-23）で完了したもの（文脈）

`main` にマージ済み: P0 3件（#77/#78/#79）/ AD-6 レイヤ①（#81）/ AD-4（#82）/
PR-C Tauri CSP（#83）/ ⑤ デスクトップ CSV エクスポート（#84）/ AD-1・AD-2 README
採用性（#85）/ v0.1.1 マニフェスト整合（#86）。加えて **v0.1.1 GitHub Release 作成**・
**リポジトリの Template 化 + description/topics 付与**。実機 Windows で `tauri build`
が通ることも確認済み。⑥ embed-ui は仕様どおり（対応不要）。

---

## 1. 保留（実需ドリブン・トリガ待ち）

「必要になった実例が出たら着手」の方針（[maintainability-review §4.1](maintainability-review-2026-07.md)
の実需ドリブン文化）に従う項目。

| 項目 | 状態 | 一次情報 / 着手トリガ |
| --- | --- | --- |
| **i18n レイヤ②**（`t()`・ロケール store・provider 配線・言語切替 UI） | 設計温存・未着手 | [i18n-plan §4.1/§6.1](i18n-plan.md)。②着手前に未決5点（自前 vs ライブラリ / キー命名規約 / ブランド名翻訳 / 日本語一次 vs 英語一次 / conventions 新節） |
| **i18n レイヤ③**（`en.ts`/`ja.ts` 辞書・対象言語） | アプリ側 | [i18n-plan §1](i18n-plan.md)。各アプリが実需で追加 |
| **保守者 docs の英語化**（conventions / recipe / ADR） | 後回し | [i18n-plan §1](i18n-plan.md)（2026-07-22 オーナー決定「他の改修が落ち着いてから」） |
| **PostgreSQL リポジトリ実装**（`postgres.rs`） | feature 定義のみ・未実装 | [improvement-plan P4-5](improvement-plan-2026-07.md)、[ui-framework-spec §12.1](ui-framework-spec.md)。既定 SQLite 維持 |
| **コピー面積縮小**（`admin-template-core` → `banto-admin-services` 化 / Tauri コマンドのマクロ化） | 方針記録のみ・未実施 | [template-scope §7](template-scope.md)。トリガ: banto-industrial 要求 / 2本目アプリ / **外部採用者フィードバック**（AD-4 で追加済み） |
| **スキャフォールド・プリセット**（minimal/standard/full 生成） | 設計のみ完了・実装未着手 | [scaffold-presets-plan](scaffold-presets-plan.md)（P4-9）。P2-1 v2（対話式 CLI）の土台待ち |
| **AD-2 発展案**（ライブデモ公開 / 短尺 GIF） | 未着手（規模 M） | [adoption-plan AD-2](adoption-plan-2026-07.md)。最小案（スクショ）は #85 で完了 |
| **tracing 導入** | 保留（`eprintln!` 継続） | [ADR-0004](adr/0004-server-logging-eprintln.md) |
| **CR-3**（依存追加検出を crate/app に拡張） | 実需ドリブンで見送り | [maintainability-review §4.1](maintainability-review-2026-07.md) |
| **GitHub Packages 公開** | 棚上げ（`publishConfig` は残置） | [publishing](publishing.md) |
| **P4-6** improvements.md 履歴分離 / **改行コード正規化**（improvements §5.2） | 未着手 | [improvement-plan P4-6](improvement-plan-2026-07.md) |
| **P4-8** 実務寄りサンプルアプリ追加 | 4条件判定待ち | [improvement-plan P4-8](improvement-plan-2026-07.md) |

## 2. オーナー判断・手動作業（Web UI / 決めれば動く）

| 項目 | やること | 一次情報 |
| --- | --- | --- |
| **OG ソーシャル画像** | GitHub Settings → Social preview から手動アップロード（CLI 不可）。素材は `docs/assets/dashboard-*.png` 流用可 | AD-3 |
| **i18n レイヤ②着手可否** | §1 の未決5点を決める（既定は着手しない＝後回し、2026-07-23 オーナー指示） | [i18n-plan §6.1](i18n-plan.md) |
| **SECURITY.md / CONTRIBUTING** | **見送り確定**（2026-07-23 オーナー判断。必要になれば作成） | handoff §4.5 |
| **次リリースの版番号** | `[Unreleased]` を束ねる次リリースを 0.1.2（patch）か 0.2.0（minor）か決める | [publishing タグ運用規約](publishing.md) |

## 3. 次の正規リリース準備（0.1.2 / 0.2.0）

`main` は v0.1.1 から大きく先行（M19〜M24 + 2026-07-23 セッションの #77〜#86）。次リリース時に:

1. **CHANGELOG `[Unreleased]` の整理** — 現状 M19〜M24 は入っているが、**#77〜#86（P0・AD-6①・PR-C・CSV エクスポート・AD-1/2・版整合）が未追記**。リリース前に追記して束ねる。
2. マニフェスト版 bump（[check-versions.mjs](../scripts/check-versions.mjs) の正準集合）→ CHANGELOG に新版節を切る → タグ付け（`vX.Y.Z`）→ CR-7 **タグモード**で照合（`node scripts/check-versions.mjs --tag vX.Y.Z`）→ GitHub Release 作成。
3. `src-tauri` の署名・updater は「レシピ化・実需ドリブン」（テンプレは採用者の代わりに署名できない、handoff §7）。

## 4. 非スコープ確定（＝やらない方針。念のため）

外部 IdP（OIDC/SAML）・リソース/行単位の細粒度 ACL・ネイティブ .xlsx 生成・チャート
PNG エクスポート・スケジュールバックアップ・リストアのホットスワップ・改ざん防止監査
（署名チェーン）/SIEM 連携・リッチテキスト/3D/地図・DLL プラグイン機構・フロント WASM
（[template-scope §4.2](template-scope.md)）。MQTT / タグストア / 時系列収集等のドメイン
特化資産は **banto-industrial** 側（[industrial-plan](industrial-plan.md)）。

## 5. ドキュメント整合メモ（軽微・追随更新の候補）

- **spec §5「ウィンドウ分離（v2 以降・実装は後回し）」は既に実装済み**（`src-tauri` の
  `panel_open` コマンド + `popout.ts`）。[ui-framework-spec §5](ui-framework-spec.md) の
  「実装は後回し」記述が古い可能性 — 追随更新の候補。
