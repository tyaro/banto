# ADR-0018: 汎用 UI 部品は新パッケージ `@banto/ui` へ段階的に切り出し、文言・アイコン・状態・操作は呼び出し側から注入する

> English: [0018-shared-ui-package.en.md](0018-shared-ui-package.en.md)

- 状態: Accepted（段階 1〜2 の判断事項）
- 日付: 2026-10-07
- 関連: Issue #220 / [conventions.md](../conventions.md) §4・§5・§9・§13・§14 /
  [ADR-0002](0002-minimal-dependencies.md)・[ADR-0005](0005-i18n-paraglide.md)・
  [ADR-0007](0007-derived-app-dev-optimizer-exclude.md)・[ADR-0008](0008-machine-check-stop-gate.md)・
  [ADR-0011](0011-git-tag-distribution.md) / [template-scope.md](../template-scope.md) §2.1・§3.1 /
  banto-industrial #381（Esc の層の約束）・T19 S2-c2（トーストの取り消しボタン）

## コンテキスト

`PageHeader`・`SurfaceCard` などの汎用部品は `apps/admin-template/src/lib/components/` にあり、
派生アプリはコピーして使う。コピーは改善・修正が各アプリへ伝わらない。実際に banto-industrial の
2 アプリ（banto-hub・chronogazer）は `CommandPalette`・`ToastHost` を別々の時点で写し、3 系統に
分かれている（下の棚卸し）。Issue #220 は、モノレポを保ったまま共通 UI を `packages/` の
パッケージとして共有することを提案した。オーナー計画（2026-10-07）は 4 段階:

- 段階 0（本 ADR）: 棚卸しと設計。コードは動かさない。
- 段階 1: 新パッケージに `components/ui/` の 7 部品（EmptyState・ErrorState・IconButton・
  LoadingState・PageHeader・StatusBadge・SurfaceCard）を移し、admin-template を利用側にする。
- 段階 2: メニュー部品（`components/menu/`）・CommandPalette・ToastHost。banto-industrial の
  写し（banto-hub の CommandPalette・ToastHost・Modal・Drawer と focusTrap・escLayering・
  focusRestore、chronogazer の CommandPalette・ToastHost）と突き合わせて 1 つにする。
- 段階 3: banto-industrial が新パッケージを使うよう移行する。

### 棚卸し（段階 1 の 7 部品、v5.1.0 + main 03c69d1）

| 部品           | 行  | アプリ外の import                | props / snippet                                   | 利用ファイル数 |
| -------------- | --- | -------------------------------- | ------------------------------------------------- | -------------- |
| `EmptyState`   | 64  | `@lucide/svelte`（Inbox）        | `icon?` `title` `description?` `action?`(snippet) | 3              |
| `ErrorState`   | 66  | `@lucide/svelte`（OctagonAlert） | `icon?` `title` `description?` `action?`(snippet) | 1              |
| `IconButton`   | 61  | なし                             | `label` `icon` `size?` `onclick`                  | 2（4 箇所）    |
| `LoadingState` | 91  | **`#lib/paraglide/messages.js`** | `label?` `lines?`                                 | 6              |
| `PageHeader`   | 68  | なし                             | `title` `description?` `actions?`(snippet)        | 8              |
| `StatusBadge`  | 87  | `@lucide/svelte`（5 アイコン）   | `variant` `label` `icon?`                         | 4              |
| `SurfaceCard`  | 83  | なし                             | `title?` `description?` `children` `footer?`      | 9              |

- **アプリ固有の import は `LoadingState` の Paraglide 1 つだけ**（既定の読み上げ文言
  `common.loading`）。`$app/*`・ストア・Tauri・`@banto/*` を import する部品は無い。
  `LoadingState` の既定文言に頼る呼び出しは `users/+page.svelte` の 1 箇所だけで、他の 5 箇所は
  `label` を渡している。
- **lucide に依存するのは 3 部品・7 アイコン**（Inbox・OctagonAlert・Circle・CircleCheck・
  TriangleAlert・CircleAlert・Info）。いずれも `icon` で差し替えられる既定値。banto-industrial の
  2 アプリは `@lucide/svelte` を依存に持たない。
- **キーボード・支援技術**: `IconButton` は `<button>` で `aria-label` と `title` に `label` を
  入れ、`:focus-visible` で `--banto-focus-ring`。`LoadingState` は `role="status"` +
  `aria-live="polite"` と視覚的に隠した文言、`prefers-reduced-motion` で点滅を止める。
  `ErrorState` は `role="alert"`。`StatusBadge` は色だけに頼らず常にアイコンを出す（`aria-hidden`）。
  `PageHeader` は `<h1>` と `view-transition-name: page-header`、`EmptyState`・`ErrorState`・
  `SurfaceCard` は `<h2>` を固定で出す。
- **使うトークン**（すべて `@banto/theme` に既存）: `--banto-text`・`-text-muted`・`-danger`・
  `-primary`・`-primary-hover`・`-surface`・`-surface-subtle`・`-surface-hover`・`-border`・
  `-radius-sm/md/lg`・`-shadow-sm`・`-control-height(-sm)`・`-focus-ring`・`-duration-fast`・
  `-ease-out`・`-backdrop`・`-{success,warning,danger}-tint(-text)`。生の色値は無い
  （`StatusBadge` の `info` は `color-mix()` でトークンから作る）。
- banto-industrial はこの 7 部品をどれも使っていない（banto-hub の設定画面は「template の
  `PageHeader` が無い」とコメントして見出しを持たない）。段階 1 の利益は admin-template の
  コピー面積の縮小と、派生アプリが新たに使えるようになることにある。

### 棚卸し（段階 2 の候補、3 系統）

| 部品                                 | admin-template | banto-hub   | chronogazer | 利用（テンプレ / hub / cg） |
| ------------------------------------ | -------------- | ----------- | ----------- | --------------------------- |
| `menu/`（Menu ほか 4 + context）     | 437 行         | -           | -           | Header のみ / - / -         |
| `CommandPalette`                     | 335 行         | 325 行      | 278 行      | 1 / 1 / 1                   |
| `ToastHost`                          | 132 行         | 104 行      | 77 行       | 1 / 1 / 1                   |
| `Modal` / `Drawer`                   | -              | 307 / 307   | -           | - / 4 ファイル / -          |
| focusTrap・focusRestore・escLayering | -              | 98・48・190 | -           | - / 10 ファイル / -         |

**メニュー部品**: `svelte` 以外を import しない（「共有パッケージへ昇格できるよう app 固有の
import を混ぜない」とコメント済み）。`popover="auto"`（トップレイヤー・外側クリックと Esc は
ブラウザが処理）+ `role="menu"`、ローヴィングフォーカス（↑↓・Home・End、Tab で閉じる）、
下に入らなければ上へ反転、スクロールで閉じる、閉じたらトリガーへフォーカスを戻す（他へ
フォーカスが移っていれば奪わない）。`MenuItem` は `aria-disabled`・`danger`。そのまま移せる。

**CommandPalette の 3 系統の違い**（共通部分: オーバーレイ + `role="dialog"` + combobox/listbox、
グループごとの見出し、↑↓・Enter、外側の pointerdown で閉じる、実行中は無効化、失敗は
admin-core の `notify`）:

- admin-template だけにある: Paraglide の文言 4 つ、**セッションの切り替わりで自分を閉じる**
  （#258、`currentSessionScope`/`isCurrentSessionScope`）、最近使ったコマンドをセッションごとに
  記録（`#lib/recentCommands`）、ビジュアルリフレッシュ後のトークン（`--banto-surface-overlay`・
  `--banto-radius-lg`・`--banto-shadow-lg`）と出現の動き（`@starting-style`）、選択行は
  `--banto-surface-hover`。
- banto-hub だけにある: **フォーカストラップ**（`attachFocusTrap`）、**閉じたら開いた元へ
  フォーカスを戻す**（`tick()` の後に生存判定し、駄目なら `header button` へ）、**Esc を window で
  受ける**（フォーカスがパレットの外にあっても閉じる）。文言は日本語の直書き、最近使った
  コマンドはセッションで分けない、選択行は primary の淡色（glass では `--banto-accent-gradient`）、
  影とオーバーレイは生の `rgba()`。
- chronogazer: admin-template の #258 以前・ビジュアルリフレッシュ以前の形に日本語の直書き。
  トラップ・フォーカスの戻し・window の Esc はどれも無い。
- 3 つとも `@banto/admin-core`（`searchCommands`・`PaletteCommand`・`notify`・`isProviderError`）と
  アプリの `#lib/commands`・`#lib/commandPalette.svelte` を import する。オーバーレイの背景は
  3 つとも `rgba(0, 0, 0, 0.35)`。

**ToastHost の 3 系統の違い**: admin-template は種類ごとの淡色背景（warning を含む）・右からの
出現・glass・閉じるボタンの `:focus-visible`・Paraglide の「閉じる」。banto-hub は**任意の
アクションボタン**（取り消し。ストアの `push` が `{ action, durationMs }` を受け、`id` を返す）、
日本語の直書き、旧スタイル（左の帯だけ・生の `rgba()` の影・warning の配色なし）。chronogazer は
banto-hub からアクションを除いた形。3 つともアプリの `#lib/toast.svelte` を import し、ストアの
形（`toasts`・`push`・`dismiss`）は共通。

**Modal / Drawer（banto-hub だけ）**: ロジックはほぼ同じで見た目だけ違う（中央・fade + scale・
既定 560px / 右・fade + fly・既定 480px）。props は `open`・`title`・`width`・
`closeOnOverlayClick`・`onclose`・`onRequestClose`（`false` で閉じない）・`dirty`（Esc と
オーバーレイでは閉じない。× は通す）・`onBlockedClose`・`focusFallback`・`children`。Esc・
オーバーレイ・× を 1 つの `requestClose` に通し、二重に閉じない（`closing` と
`data-layer-inactive`）、開く前のフォーカスを `$effect.pre` で覚えて `tick()` の後に戻す、
フォーカストラップ、Esc は手前の層があれば譲る（`hasVisibleLayerAbove`）。z-index は 900、
影とオーバーレイは生の `rgba()`、× の `aria-label` は日本語の直書き。`escLayering.ts` は層の
約束 7 項目と z-index の表を持ち、z-index は CSS の計算値から読む。admin-template にはモーダル層が
CommandPalette しかない。

### 設計を縛る既存の規約

- conventions §4（rule `empty-deps`・`no-cross-package`）: パッケージの `dependencies`/
  `peerDependencies` は空、パッケージ間の import は無い。`svelte` も宣言していない（消費側の
  解決に任せている）。今の `packages/*/src` が import する素の指定子は `svelte`・`svelte/*` だけ。
- conventions §5（rule `no-app-import`）: `#lib`/`$lib` を import しない。transport は注入する。
- conventions §9（rule `raw-colors`）: パッケージの `<style>` に生の色値を書かない。
- conventions §13 / ADR-0005: パッケージは Paraglide も辞書も持たず、文言はレイヤ①の注入で
  受け取る（既定値は今の日本語のまま。`defaultGridMessages` などと同じ形）。
- conventions §14 / ADR-0007: `.svelte.ts` を含むパッケージは `optimizeDeps.exclude` と外部利用
  fixture に載せる（rule `optimizedeps-svelte-source`・`external-consumer-fixture`）。`.svelte` と
  `.ts` だけなら対象外。
- `scripts/scaffold.test.mjs` の同期トリップワイヤ: 新しいパッケージはコア・資産・除外の
  どれかに登録しないと CI が落ちる。`scripts/check-versions.mjs` は `packages/*` を自動で拾う。

## 決定

**`packages/ui`（`@banto/ui`）を 1 つ新設し、段階 1〜3 の順に部品を移す。部品は文言・アイコン・
状態・操作を props / snippet / コールバックで受け取り、アプリのコード・ストア・`$app/*`・Tauri・
他の `@banto/*`・サードパーティのパッケージを import しない。** 段階ごとの中身は次のとおり
（段階 1・2 の判断事項は[オーナー決定（2026-10-07）](#オーナー決定2026-10-07)で確定済み。
Modal / Drawer と層の補助は段階 2 に入れない）。

### 1. パッケージの形（段階 1）

- `packages/ui/`: `package.json`（他のパッケージと同じ形。`version` は他と同じ、`files: ["src"]`、
  `exports` は `{ ".": { "svelte": "./src/index.ts", "default": "./src/index.ts" } }`、
  `dependencies`/`peerDependencies` は空、devDependencies は forms と同じ一式）・`tsconfig.json`・
  `svelte.config.js`・`vite.config.ts`（`svelte()` + `svelteTesting()`）・`README.md`・`src/`・`tests/`。
- `src/index.ts` が 7 部品と型（`StatusBadgeVariant`・`UiIconComponent`・`UiMessages`）と
  `defaultUiMessages` を名前付きで出す。サブパスの export は作らない。
- **`types` 条件は足さない**: 他のパッケージと同じく TS のソースを `svelte`/`default` が指し、
  消費側の `svelte-check`（外部利用 fixture を含む）はこれで型を解決できている。`types` 条件を
  足すなら全パッケージで揃える別の変更にする。
- 段階 1 の部品は `.svelte` と `.ts` だけで `.svelte.ts` を持たない。したがって
  `optimizeDeps.exclude` には**載せない**（rule `optimizedeps-svelte-source` が「余分」として落とす）。
  段階 2 で `.svelte.ts`（トーストのストアなど）を足したら、その同じ PR で exclude と fixture の両方に載せる
  （rule が漏れを落とす）。

### 2. 段階 1 の公開 API

今の props をそのまま公開 API にする（admin-template の呼び出しは import 文の差し替えだけで
済む）。足すのは次の 2 点だけ:

- **アイコン**: `icon` の型を `UiIconComponent`（`size?: number` と `aria-hidden` を受ける
  `Component`）にする。lucide の部品はそのまま渡せる。既定のアイコンは lucide の 7 アイコンの
  SVG を `src/icons/` に**同梱**する（ISC の表記をファイルに残す）。見た目は今と同じになる。
  同梱アイコンは公開しない（アイコン集にはしない）。
- **文言**: `LoadingState` の `label` の既定値を、パッケージの `defaultUiMessages.loading()`
  （`'読み込み中…'`）にする。admin-template は既定値に頼っていた 1 箇所でも
  `label={m['common.loading']()}` を渡す（英語表示で日本語が出ないように）。段階 2 で文言が
  増えたら、grid と同じく部品ごとに `messages?: UiMessages` を受ける。

`IconButton` に `disabled` などを足すのは段階 1 ではしない（公開 API を今の形で固め、拡張は
後の minor にする）。

### 3. CSS とテーマ

各部品の CSS は今と同じく Svelte のスコープ付き `<style>` に置き、`--banto-*` トークンだけを
使う。別の CSS ファイルは出さない。消費側は今と同じく `@banto/theme/css` を読み込む（無いと
トークンが解決されない）。これを README に書く。glass は `--banto-backdrop` がそのまま効く。

### 4. 依存の向き・コアとオプション

`@banto/ui` は**コア**（シェルの Header・Sidebar が使う）とし、template-scope §2.1 の表に行を
足し、`scripts/scaffold.test.mjs` の `CORE` に入れる。他の `@banto/*` を import しないので、
コア → オプションの逆依存は構造上起きない。

### 5. 機械検査・配布・scaffold・外部利用

- 既存の rule（`no-cross-package`・`no-app-import`・`raw-colors`・`empty-deps`・
  `docs-package-refs`）は `packages/` を走査するので、新しいパッケージにもそのまま効く。
- **rule を 1 つ足す**（ADR-0008 の 3 条件を満たすので台帳に追記する）: `packages/*/src` の
  素の import 指定子は `svelte`・`svelte/*` だけ。依存を宣言できない（`empty-deps`）のに
  `@lucide/svelte` などを import すると、モノレポでは admin-template の依存が巻き上げで見えて
  通り、依存を持たない派生アプリ（banto-industrial は lucide を持たない）でだけ壊れる。
  許可リストは要らない（今の違反はゼロ）。あわせて `no-app-import` に `$app/` と
  `@tauri-apps/` を足す案も同じ rule で拾える。
- `check-versions.mjs` は変更不要（`packages/*` を自動で拾う）。publishing.md の導入例と
  パッケージ一覧、conventions §14 の「`.svelte.ts` を持つパッケージ」の列挙（段階 1 では
  対象外であることを明記）を更新する。
- 外部利用 fixture: rule 上は必須ではない（`.svelte.ts` を持たない）が、Git 依存の
  `path:packages/ui` で入り、`svelte-check` と `vite build` を通ることを確かめるため、
  dependencies と `+page.svelte` の import に `@banto/ui` を足す（exclude には足さない）。
  これは**段階 1 の PR で足す**。ワークフロー `.github/workflows/external-consumer.yml` が
  install の前に fixture の ref を PR の head SHA に書き換えるので、タグを打つ前に Git の
  サブディレクトリ依存・`svelte-check`・Vite build を確かめられる。タグを打った後の
  ref 更新の PR（publishing.md の「タグを打ったら fixture の ref を上げる」）に残るのは、
  コミット済みの ref を新しいタグへ上げる作業だけ。
  fixture の lockfile は、ref を `@banto/ui` を含むタグに上げるその PR で解決される。
- 本 ADR が `@banto/ui` を名指しするため、段階 1 までのあいだ `verify-architecture.mjs` の
  `DOCS_PACKAGE_REF_ALLOWLIST` に理由付きで入れる。段階 1 でパッケージが実在したら外す。

### 6. テストと見た目の確認

- `packages/ui/tests/` に部品ごとの jsdom テスト（`@testing-library/svelte`）を置く:
  `IconButton` の `aria-label`/`title`、`StatusBadge` が全 variant でアイコンを出す、
  `LoadingState` の `role="status"` と既定・指定の文言、`ErrorState` の `role="alert"`、
  snippet の描画。
- DOM と CSS を変えないので、`e2e/visual`（ビジュアル回帰）と a11y（axe）の結果は変わらない
  見込み。Svelte のスコープ用クラス名のハッシュは変わるが画素は同じ。段階 1 の PR で
  ビジュアル回帰が通ることを確かめ、差分が出たらベースラインを更新せず原因を直す。
- **軽量なデモページを 1 枚作る**（オーナー決定 7）: admin-template に 7 部品の主要な状態を
  並べたページを置き、デモモードのときだけナビに出す（通常のナビは変えないので既存の
  ベースラインは動かない）。UI カタログ基盤は入れない。このページはビジュアル回帰の対象に
  加える（新しいベースラインを足す）。既存の画面では一部の状態しか出ないこと（#220 完了条件 3）、
  段階 2 の操作部品の確認にも使うことが理由。パッケージの README にも props と最小の例を書く。

### 7. 版と互換性

段階 1 は**追加だけ**（新パッケージ・admin-template の import の差し替え）で、既存の
`@banto/*` の公開 API を変えない。SemVer の minor に当たる。v6.0.0 は 2026-10-07 に公開済み
なので、段階 1 は **v6.1.0** に乗る（オーナー決定 5）。版とタグは他のパッケージと同じ（publishing.md）。派生アプリが admin-template から
写した `components/ui/` は、そのまま残しても動く（移行は任意。手順を upgrading.md に書く）。

### 8. 段階 2 の突き合わせ（2026-10-07 オーナー決定済み）

- **メニュー部品**: そのまま移す。`label` は今も呼び出し側が渡している。`popover` API を前提に
  したままにする（決定 12）。banto-hub の `TreeContextMenu` を `Menu` に寄せるのは段階 3。
- **CommandPalette**: パッケージには**表示と操作の部品**だけを置く。コマンドの一覧・検索関数・
  実行・閉じる要求・文言を受け取り（`items`、`search(query) => items`、`onExecute(item)`、
  `onClose()`、`messages`）、admin-core を import しない（型は構造的に `PaletteCommand` と
  合わせる）。セッションのスコープ（#258）・最近使ったコマンドの記録・`Ctrl+K` の配線・失敗の
  通知はアプリ側に残す。banto-hub の**フォーカストラップ・閉じたらフォーカスを戻す・window の
  Esc** は標準の振る舞いとして取り込む。見た目は admin-template の現行（トークン・動き・
  `--banto-surface-hover` の選択行）に揃える（決定 8）。
- **ToastHost**: パッケージには `ToastHost`（`store`・`messages` を受ける表示部品）と
  **`createToastStore()`**（runes の `.svelte.ts`。`toasts`・`push`・`dismiss`・自動で消す時間）を
  一緒に置く。banto-hub の**アクションボタン**（`action?: { label, onAction }`。2c で `onClick` から
  `onAction` に改名）を標準で持ち、
  見た目は admin-template の現行。アプリに残るのは、admin-core の `notify`（Notifier）をストアへ
  つなぐ配線だけ（例: admin-template の `setup.ts` の
  `notify: (kind, message) => toastStore.push(kind, message)`）（決定 9）。理由: 3 つのストア（admin-template 31 行・
  ChronoGazer 31 行・banto-hub 66 行）はほぼ同じで、違いはアクションボタンだけ。3 つの写しを
  残すのは #220 が無くそうとしている重複そのもので、代償は消費側ごとの `optimizeDeps.exclude` 1 行
  だけであり、既存の機械検査が漏れを落とす。
  **帰結**: `@banto/ui` が `.svelte.ts` を持つので、ストアを足す PR は同じ PR で `@banto/ui` を
  `optimizeDeps.exclude`（admin-template の vite 設定・scaffold・rule `optimizedeps-svelte-source`・
  conventions §14 の列挙）と外部利用 fixture の使用（ADR-0007、#478）に載せる。
- **Modal / Drawer と層の補助**（focusTrap・focusRestore・escLayering・drawerCloseGuard）:
  **段階 2 には入れない**。段階 3、または banto-industrial が必要としたときに扱う。オーナー注記:
  「後ほど banto 側に入れるかもしれないが、その時はその時で」（決定 10）。入れるときは
  banto-hub の契約（`onRequestClose`・`dirty`/`onBlockedClose`・`focusFallback`・二重に閉じない・
  層の約束）を全部持ち込み、z-index とオーバーレイの背景はトークンを使う。
- **テーマ**: オーバーレイの背景（3 系統とも `rgba(0, 0, 0, 0.35)`）は rule `raw-colors` に
  掛かるので、`@banto/theme` にトークン `--banto-scrim`（値は現行と同じ `rgb(0 0 0 / 0.35)`。
  light・dark・glass で共通）を足す。z-index は層のトークンにする: `--banto-z-header`（100）・
  `--banto-z-sidebar-scrim`（850）・`--banto-z-sidebar`（900）・`--banto-z-modal`（900。段階 3 の
  Modal / Drawer 用に予約）・`--banto-z-overlay`（1000。CommandPalette）・`--banto-z-toast`
  （1000）。値は今の直書きと同じで、見た目も重なり順も変えない（決定 11）。影は既存の
  `--banto-shadow-lg` に寄せる。

段階 2 の進み具合:

| 小段階 | 中身                                                                                 | 状態               |
| ------ | ------------------------------------------------------------------------------------ | ------------------ |
| 2a     | テーマのトークン（`--banto-scrim`・`--banto-z-*`）+ メニュー部品（`Menu` ほか 4 つ） | 済み（#361）       |
| 2b     | CommandPalette（表示と操作）                                                         | 済み（#363）       |
| 2c     | ToastHost + `createToastStore()`（アクションボタン込み。exclude・fixture も同じ PR） | 本 PR（Refs #220） |

2c で段階 2 は完了（Modal / Drawer と層の補助は決定 10 のとおり段階 3 以降）。

2b の公開 API（上の決定 8 を形にしたもの）: `CommandPalette` は `open`（bindable）・`items`・
`search?(query, items)`（省略時は `defaultCommandPaletteSearch` = `title`・`keywords` の部分一致、
並びは渡した順）・`recentIds?`（空の検索のとき先頭に「最近使ったもの」の見出しで出す。記録はアプリ）・
`onExecute(item)`（Promise を返せば終わるまで行を無効にし、その後に閉じる）・
`onClose?(reason)`（`'escape' | 'outside' | 'execute'`）・`focusFallback?`・`messages?`
（`UiMessages` の `commandPalette*`）を受ける。項目の型 `CommandPaletteItem`
（`id`・`title`・`group?`・`keywords?`・`icon?`・`disabled?`・`shortcut?`）は `PaletteCommand` と
構造的に合うので、admin-core の配列をそのまま渡せる。フォーカストラップ・フォーカスの戻し・window の
Esc（消費済みの Esc と手前の層には譲る）はパッケージ内部の補助（`overlayFocus.ts`、公開しない）で
持ち、banto-hub の層の印（`role="dialog"`・`role="menu"`・`data-esc-layer`・
`data-layer-inactive`）をそのまま読む。z-index が同じ層は文書順で後ろのものを手前とみなす
（CSS の描画順）。Modal / Drawer 用の層の補助を公開するのは引き続き段階 3（決定 10）。

2c の公開 API（決定 9 を形にしたもの）: `createToastStore(options?)`（`autoDismissMs`＝既定 4000、
`maxToasts`＝既定は無制限で、超えたら古いものから消す）が返す `ToastStore` は `toasts`・
`push(kind, message, options?)`・`dismiss(id)`。`push` は id を返し、`options` は
`action?: { label, onAction }`・`durationMs?`（`0`・負・`Infinity` は自動で消さない）・
`id?`（既に出ている id を渡すとその場で置き換えて時間を数え直す）。`kind` は
`'success' | 'error' | 'info' | 'warning'`（admin-core の `NotificationKind` と構造的に同じ）。アクションは
押すと呼び出し側の処理（例外でも）のあとで閉じ、閉じた後の再実行はしない。`ToastHost` は
`store` と `messages?`（`toastClose`）を受け、読み上げは 2 つの常設の領域に分ける
（`error`・`warning` は `role="alert"`、`success`・`info` は `role="status"`）。置き場所は CSS 変数
`--banto-toast-right`・`--banto-toast-bottom`（既定 `1rem`）。3 つの写しの違いは次のとおり揃えた:
見た目は admin-template（種類ごとの淡色・右からの出現・glass・`:focus-visible`・トークンの z-index
`--banto-z-toast`）、アクションは banto-hub（`data-testid="toast-action-<id>"` も継承。ボタンの見た目は
トーストの文字色の枠線で、淡色の背景のどれでも読める）、文言は `UiMessages.toastClose`、自動で消す時間は
admin-template の 4000ms。banto-hub・chronogazer の移行（段階 3）では `onClick` → `onAction`、
`id` が数値から文字列になる点に注意する。

### 9. 段階 3

banto-industrial が `@banto/ui` を含むタグへ上げ（v6.0.0 の #344 の移行も同時に要る）、
CommandPalette・ToastHost（2 アプリ）と、段階 2 に入れた場合は Modal・Drawer・層の補助
（banto-hub）を置き換える。banto-hub の `TreeContextMenu` を `Menu` に寄せるかは段階 3 で
個別に判断する。置き換えは banto-industrial 側の E2E（Drawer の誤爆クローズ・Esc の層など）で
確かめる。

## 検討した代替案

- **案A（採用）: 1 つの `@banto/ui` に段階的に移し、注入で受け取る**。利点: 既存の配布
  （Git タグ + サブディレクトリ）・版の検査・機械検査がそのまま使える。小さく始めて需要の
  ある部品から足せる。欠点: パッケージが 1 つ増え、scaffold・fixture・docs の同期点が増える。
- **案B（不採用）: `@banto/admin-core` に入れる**。admin-core はヘッドレス（`.svelte` の
  部品を持たない）で、表示部品を混ぜると責務が崩れる。
- **案C（不採用）: 部品群ごとに複数のパッケージ（状態表示・メニュー・オーバーレイ）**。
  パッケージごとに版・scaffold・fixture・docs の同期が要り、部品が小さいのに見合わない。
  将来オーバーレイ群が大きくなったら分ける。
- **案D（不採用）: lucide を `peerDependencies` にする**。conventions §4 の「依存は空」の例外に
  なり ADR が要るうえ、lucide を持たない派生アプリ（banto-industrial）に依存を足させる。
  同梱するのは 7 アイコン・数十行で、ADR-0002 の判断基準に照らして自前の方が安い。
- **案E（不採用）: 既定のアイコンを持たず `icon` を必須にする**。呼び出しが増え、
  `StatusBadge` の「色だけに頼らない」既定（variant ごとのアイコン）を各呼び出しが再現する
  ことになる。
- **案F（不採用）: コピーを続け、docs で同期を求める**。すでに 3 系統に分かれており
  （棚卸し）、同期は守られていない。
- **案G（範囲外）: 別リポジトリ・レジストリ公開・独立した版**。Issue #220 の再検討条件
  （担当・公開範囲・リリース周期が基盤から独立する）にまだ当たらない。ADR-0011 も維持する。

## 帰結

- `@banto/ui` の部品は、アプリのコード・ストア・`$app/*`・Tauri・他の `@banto/*`・
  サードパーティのパッケージを import しない（rule で検査）。文言は既定値付きの注入、
  アイコンは同梱の既定 + `icon` での差し替え、色と寸法はトークンだけ。
- 部品の props を変えるときは、`@banto/*` の公開 API の変更として SemVer と CHANGELOG の
  「消費側への注意」に従う（publishing.md）。
- 同梱した lucide のアイコンは、元の版と ISC の表記をファイルに残す。lucide 側の見た目の
  更新には追随しない（必要なら差し替える）。
- 段階 2c でトーストのストア（`.svelte.ts`）を足すと、`@banto/ui` は `optimizeDeps.exclude` と
  外部利用 fixture の対象になる（既存の rule が漏れを落とす。同じ PR で載せる）。
- 段階 1 の PR では admin-template の `components/ui/` を消す。派生アプリの写しは残しても
  動くので、移行は任意にし、upgrading.md に手順を書く。

## オーナー決定（2026-10-07）

段階 1 の判断事項（下の 1〜7）は次のとおり確定した。段階 2 の判断事項（8〜12）も同日に確定した。

1. **名前・位置付け**: `packages/ui` / `@banto/ui`、コア扱い（scaffold は触れない）を採用。
2. **既定のアイコン**: (a) lucide の 7 アイコンを ISC 表記付きで同梱。
3. **`LoadingState` の既定文言**: (a) パッケージ既定 + admin-template は全箇所で明示。
4. **公開 API**: 今の props で固める。
5. **版**: v6.1.0（v6.0.0 は 2026-10-07 公開済みなので、段階 1 は v6.1.0 に乗る）。
6. **機械検査**: 素の import を制限する rule を足す（コメントを除いて検査）。
7. **見本**: 軽量なデモページを 1 枚作る（admin-template に 7 部品の主要な状態を並べる。
   デモモードのときだけナビに出す。UI カタログ基盤は入れない。ビジュアル回帰の対象に加える。
   理由: #220 完了条件 3、既存画面では一部の状態しか出ない、段階 2 の操作部品の確認にも使う）。

段階 2 の判断事項（2026-10-07 追加）:

8. **CommandPalette**: パッケージは表示と操作だけを持つ。セッションのスコープ・最近使った項目・
   `Ctrl+K` の配線・通知はアプリに残す。banto-hub のフォーカストラップ・フォーカスの戻し・window の
   Esc を標準の振る舞いにする。選択行の見た目は admin-template に揃える。
9. **ToastHost**: banto-hub のアクションボタン（取り消しなど）を標準にする。**ストアも共通にし**、
   `@banto/ui` が `createToastStore()`（runes の `.svelte.ts`）を `ToastHost` と一緒に持つ
   （当初の「ストアはアプリ側」から同日に改めた）。アプリに残るのは `notify` からストアへの配線だけ。
   `.svelte.ts` が入るので、同じ PR で `optimizeDeps.exclude` と外部利用 fixture に載せる。
10. **Modal / Drawer と層の補助**: 段階 2 には入れない。段階 3、または banto-industrial が必要と
    したときに扱う（オーナー注記: 「後ほど banto 側に入れるかもしれないが、その時はその時で」）。
11. **テーマのトークン**: オーバーレイの背景（`--banto-scrim` など）と z-index の層をテーマの
    トークンにする。
12. **メニュー**: `popover` API を前提にしたままにする。banto-hub の `TreeContextMenu` を `Menu`
    に寄せるのは段階 3。

## オーナー判断事項

段階 1 の 1〜7、段階 2 の 8〜12 は上の「オーナー決定」で確定済み（経緯として残す）。

段階 1 に入る前に決めたこと:

1. **名前と位置付け**: `packages/ui` / `@banto/ui`、コア（scaffold は触れない）でよいか。
2. **既定のアイコン**: (a) lucide の 7 アイコンを同梱（推奨・見た目は不変）/ (b) 既定なし
   （`icon` 必須）/ (c) lucide を `peerDependencies`（§4 の例外 = 別 ADR）。
3. **`LoadingState` の既定文言**: (a) パッケージ既定 `'読み込み中…'` + admin-template は全箇所で
   明示（推奨）/ (b) `label` を必須にする。
4. **公開 API を今の props で固めるか**（`IconButton` の `disabled` などは後の minor）。
5. **版**: v6.1.0（v6.0.0 は 2026-10-07 に公開済みのため、段階 1 は v6.1.0 か
   その次に出せる minor に乗る）。
6. **新しい機械検査**: パッケージの素の import を `svelte`・`svelte/*` に限る rule
   （+ `$app/`・`@tauri-apps/`）を足すか（ADR-0008 の台帳に追記）。
7. **見本**: 新しいデモページを作らず、既存の画面 + パッケージの README で足りるとするか。
   → 決定: 軽量なデモページを 1 枚作る。

段階 2 に入る前に決めること（決定済み。内容は「オーナー決定」の 8〜12）:

8. **CommandPalette**: 表示と操作だけをパッケージに置き、セッションのスコープ・最近使った
   記録・`Ctrl+K`・通知はアプリ側に残すか。banto-hub のフォーカストラップ・フォーカスの
   戻し・window の Esc を標準にするか。選択行の見た目は admin-template に揃え、banto-hub の
   primary の淡色・glass のグラデーションは捨てるか（または option にするか）。
   → 決定: 推奨どおり（捨てる）。
9. **ToastHost**: banto-hub のアクションボタンを標準にするか。ストアを同梱するか
   （`.svelte.ts` → exclude・fixture の対象）、アプリ側に残すか。
   → 決定: アクションボタンは標準、ストアも `@banto/ui` に同梱する（exclude・fixture は同じ PR）。
10. **Modal / Drawer と層の補助**: 段階 2 に入れるか（admin-template に使う画面が無い）、
    banto-industrial の需要として段階 3 に回すか。入れる場合、banto-hub の契約を全部 option
    として持ち込むか、どれかを落とすか。
    → 決定: 段階 2 には入れない（段階 3 または需要のあるとき）。
11. **テーマのトークン**: オーバーレイの背景（`--banto-scrim` など）と z-index の層
    （1000 / 900 など）をトークンにするか。
    → 決定: トークンにする。
12. **メニュー**: `popover` API（Tauri の WebView2 / WebKitGTK を含む）を前提にしたままでよいか。
    banto-hub の `TreeContextMenu` を段階 3 で `Menu` に寄せるか。
    → 決定: `popover` 前提のまま。`TreeContextMenu` の整理は段階 3。
