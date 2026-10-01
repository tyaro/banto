# 派生アプリの更新レシピ（Banto の新版を取り込む）

作成日: 2026-10-01（Issue #221）

Banto を使うアプリ（banto-industrial の banto-hub・chronogazer など）が、Banto の新しいリリースを取り込む
ための手順書。対象読者は**派生アプリの作者**。Banto 側のリリース手順ではない
（タグ運用は [publishing.md](publishing.md)「タグ運用規約」、配布方式の判断は
[ADR-0011](adr/0011-git-tag-distribution.md)）。

> 本書は日本語のみ。リリースごとの案内の雛形は [release-notes-template.md](release-notes-template.md)、
> 版ごとの実際の変更は [CHANGELOG.md](../CHANGELOG.md)。

## 1. 最初に知ること: 取り込み経路は 3 種類ある

Banto の成果物は更新の届き方が違う。リリースノートの項目も、この 3 つに分けて読む。

| 経路                      | 何が対象か                                                                                                                                                        | 更新の仕方                                                             | 派生側の独自変更との衝突                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| A. 依存（Git タグ）       | `@banto/*`（npm、`github:tyaro/banto#vX.Y.Z&path:packages/...`）と `banto-*` クレート（Cargo の `git` + `tag`）                                                   | タグを書き換えて install / build。API 追従があれば手で直す             | 起きない（実体は node_modules / cargo の checkout） |
| B. コピーしたテンプレート | `apps/admin-template` 配下（画面・ルート・`src/lib`・`core/`・`src-tauri/`・`messages/`・`e2e/`）と、付随する設定（`vite.config.ts`、コピーした `scripts/` など） | 派生側が**差分を読んで手で取り込む**。タグを上げても自動では変わらない | 起きる。派生側で変えた箇所は人が調整する            |
| C. DB・設定・配布資産     | DB マイグレーション（`apps/admin-template/core/migrations-{sqlite,postgres}/`。実体は B のファイルだが順序と戻し方が別）、設定キー、`tauri.conf.json`、配布物     | 変更がある版だけ。順序とバックアップは 4 節                            | -                                                   |

要点:

- **依存タグだけ上げても B は更新されない。** 例: v1.6.0 は設定画面の分割（B）だけの変更で、`@banto/*` と
  `banto-*` の実装は v1.5.0 と同一だった。タグ依存で v1.5.0 のまま留まっても差はない。
- 逆に、`@banto/*` の API が変わる版（例: v2.0.0）は、A の追従と、そのパッケージを使う B のコード
  （保護レイアウト・`session.svelte.ts` など）の書き換えが**セット**になる。A だけ上げると型エラーか実行時エラーになる。
- 自動マージや強制上書きの仕組みは**ない**。差分は人が読んで取り込む（取り込み漏れを防ぐ記録の取り方は 5 節）。
- ここで扱うのは**依存・コピー部分の更新**だけ。アプリ実行ファイルの自動更新（Tauri updater）は別の課題。

## 2. 標準の流れ

1. **リリースノートを読む。** [CHANGELOG.md](../CHANGELOG.md) の該当版の冒頭（「消費側への注意」・影響範囲）と、
   各項目の A / B / C の別を確認する。複数版を跨ぐなら、間の全版を読む（破壊的変更は 1 つの版にしか書かれない）。
2. **自分の基準版を確認する。** 派生リポジトリの同期記録（5 節）で、依存タグとテンプレートの同期元を別々に確認する。
3. **ブランチを切り、バックアップを取る**（4 節。DB・設定を触る版だけでなく、実機があるなら習慣にする）。
4. **A: 依存タグを更新する**（3.1）。まず**タグだけ**上げ、型検査・build が通る状態にする。
5. **B: テンプレートの変更を取り込む**（3.2）。該当しない版は飛ばす。
6. **C: 移行がある版は順序どおりに適用する**（4 節）。
7. **更新後の確認**（6 節）を、その版に関係する範囲で実施する。
8. **同期記録を更新する**（5 節）。一部だけ取り込んだなら、取り込んだ項目と見送った項目を残す。

**1 つの PR にまとめすぎない。** 依存タグの更新（A）とテンプレート取り込み（B）は、可能なら別コミット
（理想は別 PR）にする。壊れたときにどちらが原因か切り分けられる。

## 3. 経路別の手順

### 3.1 A: 共通パッケージ・クレートの更新

Banto の全 `@banto/*` と `banto-*` は**同じタグで揃える**（バージョンは統一されている。
[publishing.md](publishing.md)「バージョニング規約」）。npm と Rust のタグを別々の版にしない。

```sh
# 書き換え対象の洗い出し（派生リポジトリで。見つかった全部が対象）
grep -rn "tyaro/banto" --include=package.json --include=Cargo.toml . --exclude-dir=node_modules --exclude-dir=target

# npm: package.json の "@banto/admin-core": "github:tyaro/banto#v1.7.3&path:packages/admin-core" などを
# 新しいタグへ書き換えてから
pnpm install
pnpm check                  # 型検査（API 変更はここで落ちる）

# Rust: Cargo.toml の tag = "v1.7.3" を全て書き換えてから
cargo update -p banto-core  # 使っているクレート分。git 依存は tag の書き換えだけでは Cargo.lock が追従しない場合がある
cargo check --workspace
```

注意:

- 該当版の CHANGELOG に「削除した公開 API と移行先」のような表があれば、型エラーをその表で解消する。
- A の修正（不具合・セキュリティ）はタグを上げれば入る。B の修正は入らない（7 節）。
- Vite の `optimizeDeps.exclude` は、ソース配布の `.svelte.ts` を持つ `@banto/*`
  （admin-core・dock-svelte・forms・grid-svelte・tree-svelte）を**新しく使い始めるとき**に増やす。更新だけなら
  据え置きでよいが、版の注意に書かれていれば従う（[ADR-0007](adr/0007-derived-app-dev-optimizer-exclude.md)）。
  `pnpm check` と `pnpm build` はこの経路を通らないので、**`pnpm dev` で必ず画面を開く**（6 節）。

### 3.2 B: コピーしたテンプレート部分の取り込み

テンプレート側の変更は、同期元の版と新しい版の**差分**を見て、派生側へ適用する。

```sh
# banto を派生リポジトリの外にクローンしておく
git clone https://github.com/tyaro/banto.git ../banto-upstream && cd ../banto-upstream

# 同期元(vFROM)と取り込み先(vTO)の差分を、テンプレート部分に絞って確認
git diff --stat   vFROM vTO -- apps/admin-template e2e scripts
git diff          vFROM vTO -- apps/admin-template/src/routes
git log --oneline vFROM..vTO -- apps/admin-template e2e scripts   # 関連コミット・PR を拾う（記録に使う）
```

- 派生側で**ファイル名・クレート名を変えている場合**（`rename.mjs` による変更など）は、差分のパスを読み替える。
  何が置き換わるかは [README「1. コピーとリネーム」](../README.md#1-コピーとリネーム) を参照。
- 派生側で**削除済みの機能**（プリセットで外した `items`・attachments・users など）の差分は読み飛ばす。
- 派生側で**独自に変えたファイルと同じファイルが変わっている**ときは、機械適用せず手で突き合わせる。
  rename 済みのパスでは `git apply` が当たらないことが多く、手で移すほうが速い場合も多い。
- 見る場所: `src/routes/`、`src/lib/`、`core/src/`、`src-tauri/`、`messages/*.json`、`e2e/`、
  `vite.config.ts` / `svelte.config.js`、`package.json` の依存範囲。`scripts/scaffold.mjs` のアンカーが変わる版は、
  派生側で scaffold を再実行しない限り影響しない。
- 取り込み可否と関連 PR を同期記録に残す（5 節）。

## 4. DB・設定・配布資産の移行

テンプレートの DB マイグレーション（`apps/admin-template/core/migrations-{sqlite,postgres}/`）は
**アプリの起動時に自動適用**される（`sqlx::migrate!`、`core/src/db.rs`）。つまり**新しいバイナリを本番 DB で
最初に起動した時点で DB が進む**。ここが戻せなくなる境界。

**要否の判断**: リリースノートの C に「マイグレーション」「設定キー」「配布物」が書かれた版だけが対象。
`@banto/*` の更新だけの版（v1.6.0 など）は不要。

**順序（要対応の版）**:

1. **バックアップ**: SQLite は、アプリを止めて DB ファイル（`-wal`・`-shm` があればそれも）をコピーする
   （または設定画面のバックアップ節。SQLite 専用）。PostgreSQL は `pg_dump -Fc <db> > before-upgrade.dump`。
   設定ファイル、`tauri.conf.json`、配布物（インストーラ・同梱資産）も取っておく。
2. **コード（A と B）を先に完成させる。** 型検査・build・テストが通る状態にしてから DB に触る。
3. **マイグレーション SQL を取り込む**（B の一部）。sqlite・postgres の**両方言**に同じ番号で入れる
   （`verify-architecture` の rule 11 `migration-dialect-parity` が揃っているか検査する）。
   **適用済みのマイグレーションは編集しない**（sqlx が内容の不一致を検出して起動に失敗する）。
4. **検証用の DB コピーで起動して適用結果を確認**してから、本番に当てる。
5. 設定キー・`tauri.conf.json`（CSP など）・配布物の変更は、更新したアプリを起動した後で確認する。

**戻せる条件**: マイグレーションは**前進のみ**（down は無い）。戻すには「1 のバックアップを復元し、旧版のバイナリで
起動する」しかない。新版で一度でも書き込みが走ると、復元でその分は失われる。したがって
**戻せる境界は「新版を本番 DB で最初に起動するまで」**。リリースノートでは、マイグレーションの有無と、
戻せる条件を明記する。

## 5. 派生アプリの基準版の記録（同期記録）

派生リポジトリに、Banto のどの版を基準にしているかを**依存とコピーで別々に**残す。ツールは作らず、
派生リポジトリの README（または `docs/banto-sync.md`）に次の節を置いて手で更新する。

```markdown
## Banto 同期記録

| 対象                          | 基準                     | 備考                                                  |
| ----------------------------- | ------------------------ | ----------------------------------------------------- |
| 依存（`@banto/*`・`banto-*`） | タグ `v1.7.3`            | package.json と Cargo.toml の全てが同じタグ（確認日） |
| テンプレートの同期元          | タグ `v1.5.0`（`<sha>`） | `apps/admin-template` からコピーした日。rename 済み   |

### テンプレート取り込み状況（部分適用の記録）

| Banto 版 | 項目（関連 PR）                            | 状態   | 派生側の PR / メモ              |
| -------- | ------------------------------------------ | ------ | ------------------------------- |
| v1.6.0   | 設定画面のページ分割（#197・#198）         | 取込済 | #34。独自の節は connectivity へ |
| v1.7.3   | 一覧の並び（unique key）                   | 不要   | A のみ。B の変更なし            |
| v2.0.0   | SessionController 配線（#260・#264〜#266） | 一部   | #41。手順 1〜4 済み、5〜7 未    |
```

- **単一の基準版を「全部適用済み」と読まない。** 依存を v2.0.0 に上げても、テンプレートの同期元が v1.5.0 のままなら、
  v1.6.0 以降の B の変更は未取り込みの可能性がある。2 行を別に持つのはそのため。
- 部分適用（一部の画面だけ取り込む、特定の変更を見送る）は、下の表に**項目単位**で書く。状態は
  `取込済` / `一部` / `見送り` / `不要`（A のみ）の 4 種で足りる。見送りには理由を書く。
- 同期元の commit は `git rev-parse vX.Y.Z` で得られる。リリース版はタグで足りる。候補版（未リリースの
  commit）を検証・採用したときは commit を書く（8 節）。
- 全部を取り込み終えたら「テンプレートの同期元」の行を新しい版に更新する（途中は上げない）。

## 6. 更新後の確認

**その版に関係する範囲に絞る。** 毎回全画面を見る必要はない。リリースノートの「確認項目」を優先する。最低限は次の 4 つ。

1. `pnpm install --frozen-lockfile`・`pnpm check`・`pnpm build`（A の追従漏れ・型エラー）。
2. **`pnpm dev`（Vite の dev サーバ）でブラウザを開き、主要画面が描画されること。** `check`・`build` は dev の
   依存事前バンドルを通らないため、#150（`js_parse_error`／500）のような不具合は dev でしか出ない。
3. `cargo check` / `cargo test`（Rust の追従。PostgreSQL を使うテストは DB が要る）。
4. 変更に関係する操作（認証を触った版ならログイン・ログアウト・別タブの切り替え、設定画面を触った版なら各カテゴリの
   保存、など）。Tauri なら `pnpm tauri dev` でも一度。

## 7. セキュリティ修正の扱い

- Banto 側の修正は、リリースノートに**影響する利用形態**（LAN 公開・Tauri のみ・PostgreSQL 利用 など）と
  **推奨対応**を書く。派生側は、自分の利用形態が該当するかをまず判断する。
- **A の修正はタグを上げれば入る。B の修正は自動では入らない。** 修正が B のファイルにあるときは、リリースノートに
  「コピー側の取り込みが必要」と明記する。派生側は優先して取り込み、同期記録に残す。
- 修正だけを取り込みたいときは、全版の B を追わず、その修正のコミットだけを `git diff` / `cherry-pick` で適用し、
  同期記録を `一部` にする（残りは通常のタイミングで追う）。
- Banto の CI（`pnpm audit` / `cargo audit`）は Banto 自身の依存が対象。派生固有の依存は派生側の CI でも監査する。

## 8. 外部利用の互換性確認（Banto 側の検証と手順）

派生アプリの更新が成り立つことを、Banto 側でどこまで機械的に保証し、何を手順で補うか。

### 8.1 既存の CI が保証しているもの

| 経路                                                                    | 何を保証するか                                                                                     | 外部利用（Git 依存 + サブディレクトリ）を通るか |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [ci.yml](../.github/workflows/ci.yml)                                   | モノレポ内（`workspace:*`・`path` 依存）の lint・型検査・test・build・Rust・PostgreSQL・e2e・audit | いいえ（ソース直接参照）                        |
| [template-acceptance.yml](../.github/workflows/template-acceptance.yml) | コピー → rename → 型検査・cargo check、各プリセットの scaffold → build・cargo test                 | いいえ（コピー後も `workspace:*` のまま）       |
| [tauri-check.yml](../.github/workflows/tauri-check.yml)                 | `src-tauri` のビルド                                                                               | いいえ                                          |

つまり**「Git 依存 + `path:` で `@banto/*` を導入し、`pnpm dev` を起動する」経路は CI にない**。この経路は、
`files: ["src"]` による配布物の絞り込み、サブディレクトリの解決、node_modules 実体になったときの Vite の dev
事前バンドル（#150、ADR-0007）を含む。`pnpm build`・`pnpm check` では見つからない。

### 8.2 外部利用 fixture を CI に入れない判断（2026-10-01 時点）

次の理由で、**この時点では CI に fixture を足さない**。手順（8.3）で補い、CI 化は #271 で追跡する。

- Git 依存は**公開済みの ref**（タグ、または push 済みの commit）を取りに行く。PR の候補 commit は push 後にしか
  解決できず、リリースタグはリリース後にしか存在しない。「リリース前に壊れを止める」用途に素直に使えない
  （`git+file://` で代替する手もあるが、pnpm の `path:` との組み合わせは未検証）。
- dev 起動の検証には、fixture アプリ（`@banto/*` 5 種を import する最小の SvelteKit）・dev サーバ起動・
  ブラウザでの描画確認（Playwright）が要り、既存 CI に無理なく足せる規模を超える。
- github.com への clone というネットワーク依存が増え、他のジョブより flaky になりやすい。

### 8.3 候補 commit・リリースタグの検証手順（手動）

リリース前の候補 commit と、リリース後のタグを、同じ手順で確認する。

1. **最小 fixture を作る**（Banto リポジトリの外）。`pnpm create svelte` 等で SvelteKit + TypeScript の
   アプリを作り、`@banto/*` を Git 依存で入れる。`<ref>` は push 済みの候補 commit の SHA、またはリリースタグ。

   ```sh
   pnpm add "github:tyaro/banto#<ref>&path:packages/admin-core" \
            "github:tyaro/banto#<ref>&path:packages/dock-svelte" \
            "github:tyaro/banto#<ref>&path:packages/forms" \
            "github:tyaro/banto#<ref>&path:packages/grid-svelte" \
            "github:tyaro/banto#<ref>&path:packages/tree-svelte" \
            "github:tyaro/banto#<ref>&path:packages/theme"
   ```

2. 各パッケージを import した画面を作り、`vite.config.ts` に `optimizeDeps.exclude` を**入れた状態と入れない状態の
   両方**で `pnpm dev` を起動して開く（入れない状態が `js_parse_error` で落ちれば #150 の再現が生きている。
   入れた状態で描画されることが合格条件）。
3. `pnpm check`（型検査）・`pnpm build`。
4. Rust は fixture に `banto-core` / `banto-storage` / `banto-server` を `git = ..., tag = ...`（候補 commit は
   `rev = "<sha>"`）で入れ、`cargo check`。
5. 結果（ref・組み合わせ・成否）を PR または Issue に残す。

**確認する組み合わせ**（Banto の現行の基準。ルート `package.json`・`apps/admin-template/package.json`・CI）:

| 項目      | 範囲                                                    |
| --------- | ------------------------------------------------------- |
| Node.js   | `>=24`（CI は 24）                                      |
| pnpm      | 10.x（`packageManager: pnpm@10.33.0`）                  |
| Svelte    | `^5.57`（runes 前提）                                   |
| SvelteKit | `^2.70`                                                 |
| Vite      | `^8.3`                                                  |
| Rust      | stable（`dtolnay/rust-toolchain@stable`、edition 2021） |

組み合わせを変える版（Vite のメジャーなど）は、リリースノートにその旨を書き、fixture でも検証する。

### 8.4 役割分担と残る項目

- **Banto の CI**: 共通契約（モノレポ内のビルド・テスト・scaffold・セキュリティ監査）。
- **派生アプリの CI**: 各アプリ固有のテスト・画面・実機。Banto の CI へは集約しない。
- **手順で補う（8.3）**: 外部利用経路（Git 依存・dev 起動）。
- **未了（#271）**: 外部利用 fixture の CI 化。最小の fixture をリポジトリ内（例:
  `fixtures/external-consumer/`）に置き、リリースタグ作成後（`on: push: tags`）に Git 依存で導入 → dev 起動 →
  描画確認を行うジョブ。

## 9. 共通 UI のパッケージ化（#220）への適用

共通 UI を `@banto/*` のパッケージとして切り出す場合、**その UI は経路 B から A へ移る**。同じ案内の形で書ける。

- リリースノートでは、その UI を使っている派生アプリに「コピー済みのファイルを削除し、パッケージの import に
  置き換える」移行を B の項目として書く（v2.0.0 の SessionController のように A と B がセットになる）。
- 置き換えが済むまでは、同じ UI がコピー側と依存側に二重にある。同期記録の表で、**どの派生アプリがどちらを
  使っているか**（`コピー` / `パッケージ`）を持つ。
- 以降の修正は A を上げるだけで入る。コピー側が残っている間だけ B の取り込みが要る（7 節）。
- `.svelte.ts` を含むパッケージなら、`optimizeDeps.exclude` に加える案内を B の項目に必ず入れる（3.1）。

## 10. 具体例

### 例 1: v1.5.0 → v1.6.0（設定画面の分割。B のみ）

CHANGELOG の [1.6.0](../CHANGELOG.md) 冒頭のとおり、`@banto/*`・`banto-*` は版数が上がるだけで実装は v1.5.0 と
同一。**A は「タグを上げてもよいし、上げなくてもよい」。対象は B（テンプレートの設定画面）だけ。**

| 経路      | 項目                                                         | 取り込み                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A         | `@banto/*`・`banto-*`                                        | 不要（実装は同一）。揃えたければタグを 1.6.0 へ                                                                                                                                                                                                                               |
| B         | 設定画面（`apps/admin-template/src/routes/(app)/settings/`） | `+page.svelte`（1,812 行）を廃止し、`+layout.svelte`・`+layout.ts`・`categories.ts`・`shared.ts`・`settings.css`・`*Section.svelte` 5 本・カテゴリごとの `+page.svelte` / `+page.ts`・共有ストア 2 本（`authSettingsStore.svelte.ts`・`systemInfoStore.svelte.ts`）に置き換え |
| B         | `src/lib/session.svelte.ts`                                  | コメントの参照先のみ（機能変更なし）                                                                                                                                                                                                                                          |
| B         | `e2e/`（`tests/smoke.spec.ts`・`visual/*`）                  | 設定の URL が `/settings/<category>` になったため、シナリオと visual のエントリを更新                                                                                                                                                                                         |
| B（任意） | `scripts/scaffold.mjs`・`verify-architecture.mjs`            | scaffold を再実行する派生のみ。glass remover のアンカーが `AppearanceSection.svelte` へ                                                                                                                                                                                       |
| C         | DB・設定キー・配布資産                                       | 変更なし（マイグレーション不要）                                                                                                                                                                                                                                              |

派生側の調整箇所:

- **独自に設定画面へ項目を足している場合**: 旧 `+page.svelte` に足した節を、該当カテゴリの `*Section.svelte`
  （または新しいカテゴリの `+page.svelte` と `categories.ts` への登録）へ移す。v1.6.0 の主眼は「ルートを足す形で設定を
  拡張できる」こと。
- **設定へのリンク・ブックマーク**: `/settings` は先頭の可視カテゴリへ 307 リダイレクトされる。ディープリンクは
  `/settings/{appearance,account,connectivity,data,security}` を使う。

確認項目（この版に関係するものだけ）:

1. `pnpm check`・`pnpm build`・`pnpm dev`（`/settings` が先頭カテゴリに遷移して描画される）。
2. 5 カテゴリそれぞれで、設定の保存・読み込みが従来どおりできる。非可視カテゴリへ直接遷移しても先頭へ戻る。
3. 画面幅 1024px 以上（左レール）と未満（横タブ）の表示。
4. e2e の smoke・visual / a11y の settings 系（派生側にコピーしているなら）。
5. 同期記録に「設定画面のページ分割 取込済（PR 番号）」を書く。

### 例 2: v1.7.x → v2.0.0（SessionController。A と B がセット・破壊的変更）

v2.0.0 は admin-core の旧セッション API を削除し、`AuthProvider` の `resolve`・`credentialRevision`・
`onCredentialChanged` を必須にする**破壊的変更**。詳細な移行表と手順は CHANGELOG の
[Unreleased「SessionController 実装-3」](../CHANGELOG.md#unreleased)（版節に切り出された後は `[2.0.0]`）が正で、
ここには**取り込みの組み立て**だけを書く。設計は [session-controller-design.md](session-controller-design.md)、判断は
[ADR-0016](adr/0016-session-controller-single-writer.md)。

| 経路 | 項目                                                                                                                   | 取り込み                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A    | `@banto/admin-core` を v2.0.0 へ                                                                                       | 他の `@banto/*`・`banto-*` も同じタグへ。旧 API（`resolveProtectedSession` など）の呼び出しが型エラーになる             |
| A    | 自前の `AuthProvider`                                                                                                  | 3 メソッド必須（CHANGELOG の手順 7）。一時的に `adaptLegacyAuthProvider` で包める（移行 PR に「adapter 使用中」と明記） |
| B    | `src/lib/session.svelte.ts`、`(app)/+layout.ts`・`+layout.svelte`、ログイン・ログアウト、503 画面、`providers/demo.ts` | CHANGELOG の「派生アプリの移行の手順」1〜6。admin-template の同名ファイルが手本                                         |
| B    | Tauri 側（`src-tauri` の認証コマンド、設定の `auth.*` キー）                                                           | `settings_set` が `auth.` キーを拒否する等の挙動変更。派生が独自の認証コマンドを持つなら確認                            |
| C    | DB・設定                                                                                                               | マイグレーション不要（セッションはメモリのみ）。ログイン不要モードの挙動が変わるので、使っている運用は確認              |

進め方:

1. 先に**候補版のコミット参照で検証**する（`github:tyaro/banto#<sha>&path:...`、Cargo は `rev`）。8.3 の手順で
   最小 fixture でも確認しておくと切り分けやすい。その後に v2.0.0 のタグへ移す。
2. A を上げて型エラーを一覧にする。次に B を 1 つずつ（`session.svelte.ts` → `(app)/+layout.ts` → 保護レイアウト →
   ログアウト → 503 画面）取り込む。
3. 複数アプリ（banto-hub・chronogazer）がある場合は、**1 アプリずつ**移行する（同期記録もアプリごとに持つ）。

確認項目（認証に関係する範囲）:

1. `pnpm check`・`pnpm build`・`pnpm dev`。**demo 用の `AuthProvider` を持つアプリは、dev 起動で白画面にならないこと**
   （3 メソッドが無いと `initBanto` が `TypeError`）。
2. ログイン・ログアウト（ログアウト後に /login へ移る。確認できない場合はエラーが通知される）。
3. 別タブでのログイン・ログアウト（保護レイアウトの作り直し、ユーザー切り替えの通知）。
4. バックエンドを止めた状態の 503 画面と「再試行」。
5. ログイン不要モード（Tauri）を使うアプリは、有効・無効の切り替え。
6. 同期記録に、取り込んだ手順（1〜7）を書く。途中なら残りも書く。
