# Changelog

このリポジトリの注目すべき変更を記録する。フォーマットは
[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠する。
バージョン番号はタグ運用規約（[docs/publishing.md](docs/publishing.md)
「タグ運用規約」節）に従う。**1.0.0（安定版）以降は SemVer 準拠**
（`major` = 破壊的変更 / `minor` = 機能追加 / `patch` = 修正）。0.x 系は
`minor` = 破壊的変更 / `patch` = 追加・修正で運用していた。バージョンタグ
導入前の M0〜M9 はマイルストーン単位で、M10以降はマイルストーン + PR番号
単位で記録し、コミット単位までは分解しない。

**運用規約**:

- PR ごとに `[Unreleased]` へ変更点を1行追記する。
- リリース（バージョンタグの更新）のタイミングで `[Unreleased]`
  の内容を新しいバージョン節に切り出し、日付を入れる。
- 配布方式はgitタグ参照（npm/crates.ioレジストリへは公開しない、
  [docs/publishing.md](docs/publishing.md)）のため、Changesets 等の
  自動生成ツールは導入しない。本ファイルは手動運用を継続する
  （publishing.md「タグ運用規約」に以前あった「CHANGELOGは当面省略」の
  記述は本ファイルの新設により本節に置き換え）。

## [Unreleased]

消費側への注意（破壊的。次のメジャー v8.0.0 に入る。詳細は下の各項目と [docs/upgrading.md](docs/upgrading.md) 4.2 節）:

- **Node の基準を 24 から 26 に上げる（#837 を置き換える）。** Node 26 は 2026-10-28 から Active LTS。派生アプリ（ルートの `package.json` を取り込む場合）は Node 26 が必要になる: `engines.node` を `>=26`、`.nvmrc` を `26`、devDependencies の `@types/node` を `^26.0.0`、CI の `setup-node` の `node-version` を `26` にする。取り込まなければ今までどおり。
- **基準の作り直し: DB を作り直す（#790・#778・#786 の C1、[ADR-0034](docs/adr/0034-owner-identity-builtin-admin.md) 決定 §9）。** `core/migrations-{sqlite,postgres}/0003_users.sql`・`0005_audit_log.sql` を差し替え、`0014_ui_settings.sql` を足す（自分の migration を 0014 以降で足しているなら番号をずらす）。v7.11.0 以前の DB は起動時に「この DB は v8.0.0 より前の版のものです。読めません。DB を作り直してください」で止まり、旧版のバックアップはリストアの予約で断られる。データの移行は無い。
  - 新しい DB には組み込みのユーザー `admin`（`users.kind = 'builtin'`）が 1 行居る。ログイン・変更・削除はできない。`admin` という username のアカウントは作れないので、試験・fixture で作っているなら別の名前にする。`UserSummary` に `kind`（`'account'` / `'builtin'`）が増えた（Rust の構造体と wire の両方）。
  - `users` へ直接 INSERT しているコード・試験は `account_uid`（一意の文字列）を入れる（無いと CHECK で失敗）。アカウントは `kind = 'account'` で数える。
  - 配線: `BackupService::new(..).with_migrations(db::sqlite_migration_manifest())` と、`BackupService::apply_pending_restore_at_startup(&db_path, &db::sqlite_migration_manifest())`（引数が増えた）。渡さない `BackupService` はリストアの予約を断る。
  - 初回の seed（`FIRST_BOOT_SETTINGS`）は「`settings` が空のとき」ではなく、新しい DB の最初の起動で 1 回だけ書かれる（印は `settings` の `first_boot.seeded`）。`settings` に行があることを「seed 済み」の代わりに使っていたコードは直す。
- **監査の主体・予約名・起動時の検査（#807・#778 の C2、[ADR-0034](docs/adr/0034-owner-identity-builtin-admin.md) 決定 §2〜§4・§9）。** C1 の後に作った DB も、`0005_audit_log.sql` に列 `actor_kind` が増えたので作り直す。派生アプリが書き換える所は [docs/upgrading.md](docs/upgrading.md) 4.2 節の「監査の主体・予約名・起動時の検査」にまとめた。要点:
  - REST の handler: `record_write(&audit, &auth, &headers, ..)` は無くなった。`axum::Extension(actor): axum::Extension<AuditActor>` を引数に取り、`record_write(&audit, &actor, ..)` と呼ぶ。`actor_identity` は消えた。`AuditActor` は所有の型（`username`・`id`・`role`・`kind`）になり、`record_write_as` / `record_denied_as` は参照で受ける（`record_denied_as` の `detail` は `Option`）。`AuditEntry` に `actor_id`・`actor_kind` が増えた（直に組み立てている所は `AuditEntry::by` か `record_as` へ）。
  - Tauri のコマンド: `require_role` / `require_permission` の戻り値が `UserIdentity` から `Caller` に変わった（`Deref` で欄はそのまま読める。`&UserIdentity` を受ける関数へは `&caller.identity`）。`AppState` に `builtin_admin_id` が増えた。
  - ログインなし（`local`）の監査の actor が `local` から `admin` に変わった（`actorId` は組み込みの行の id、`actorKind` は `local`）。監査の行と wire に `actorId`・`actorKind` が増えた。
  - `GrantSpec` に `audit_as_builtin_admin`（既定 `false`）が増えた。構造体リテラルで組み立てている所は欄を足す。
  - `admin`（大小無視）と grant の固定 id（テンプレートでは `public`）のアカウントは作れない。配線は `UsersService::with_reserved_usernames(startup::reserved_usernames(&settings))`、起動時に `startup::check(&db)`、リストアには `startup::sqlite_restore_manifest()` を渡す。予約名と同じ名前のアカウントがある DB（grant を後から足したとき）は起動が止まる。
- **dock-svelte: 消したパネルは既定の位置に出る。`dockSlot` を廃止（#782 PR5、破壊的・挙動の変更）。** ドックから隠した・閉じた pane（✕・`hidePanel` / `closePanel`・「表示」メニュー・帯の pane の ✕）を出し直すと、隠した場所ではなく**既定のレイアウトでの位置**に出る（既定の木の並びでいちばん近い、今ドックにある兄弟の隣 → 既定の側の外周 → 浮動）。幅は隠す直前の比率 1 つだけを覚える。浮かせた pane の「元の場所に戻す」と、端の帯からの戻しは今までどおり元の場所。派生アプリが直す所:
  - **`DockHost` を直に使うアプリは `dock.defaultLayout = <既定の DockLayout>` を入れる**（`createDockState` の直後。読むのは `docked` だけ、保存されないのでマウントのたびに入れる。既定の木の分割・タブの組の id は重ならない固定の値に）。入れないと、ドックから隠した pane は浮動で開く。`ThreePaneDock` は自分で入れるので何もしなくてよい（左右を開くと必ず中央の隣に出る。初期が `hidden` / `floating` の追加パネルは、ドックへ入れてから隠しても浮動で開く）。
  - 型 `FloatingWindow` から `dockSlot` が消え、`dockShare?: number`（ドックから隠した印と、隠す直前の比率）が増えた。`dockSlot` を読み書きしているコード・試験の fixture は直す。保存済みの layout の `dockSlot` は読まずに捨てる（layout は読める。その pane は浮動で開く）。データの移行は無い。
  - `dock.panels[].placement` の `'docked'` は「ドックにある、または隠れていて既定の位置がある」になった。`DockState.savedLayout()` は `layout` そのものを返す（`dockSlot` の `share` の補正が無くなった）。`reconcileThreePaneLayout` は隠れたパネルの `share` を直さない（持たない）。`DockState.shownTree(id)`（`show` がドックへ出すときの木）と `placeAtDefault` / `dockShareOf` / `hasDefaultPlace` を公開。
  - 既定の配置から隠しただけなら、どの順で出し直しても既定と同じ形になる（比率まで戻るのは隠した逆の順のとき）。pane を動かした後は、出し直す順で形が変わることがある。
  - 浮かせた pane の「元の場所」は、隠れている pane を数えなくなった（隠れた pane は場所を持たない）: `row[a, b, c]` で b を隠し、a を浮かせ、b を出し、a を元の場所へ戻すと `row[b, a, c]`（前は `row[a, b, c]`）。
  - 見た目の基準画像・E2E で「閉じて開くと元の場所に戻る」を見ているアプリは確かめ直す。
- **charts・theme（見た目の変化、#851）:** `MAX_CHART_SERIES` が 8 から 16 になり、9 本目以降の系列は「8 番の色に固定」から `--banto-chart-9`〜`16` の色に変わる（17 本目以降は 16 番に固定。折り返さない。`PieChart` の 9 切れ目以降と、`colorIndex` を渡していない `GanttChart` の 9 行目以降も同じ）。8 本以下のグラフは変わらない。`MAX_CHART_SERIES` を系列の数の上限として使っているコードは値が変わる。`seriesColorVar` の戻り値は、9〜16 番では `var(--banto-chart-N, var(--banto-chart-8))`（fallback 付き）になるので、文字列を比べたり解析したりしているコードは直す。`--banto-chart-1〜8` を自分のテーマで上書きしているアプリは 9〜16 も定義する（無いスロットは 8 番の色で描かれる。banto の CSS も読んでいれば banto の既定の 9〜16 になる）。9〜16 は 1〜8 より保証が弱い（正常色覚で 1〜16 のどの 2 つも OKLab 0.06 以上・面に 3:1 以上だけ。色覚シミュレーションと状態色との距離は保証しない）ので、9 本以上のグラフは凡例・線種・マーカーを併用する。

### Added

- **attachments:** `AttachmentsPanel` に任意の props `canSave?: () => boolean` を足した（足すだけの変更。#714）。ダウンロードの保存を始める直前に呼び、`false` なら保存せず object URL を解放する。テンプレートの `ItemAttachments` は、マウント時のセッションが生きているかを渡す。
- **template:** items の新規作成にファイル欄（`file` 型）を配線した（#714 の 4、F2。`Closes #714`）。選んだファイルは保存のあとで新しいレコードの添付へ上がり、上がらなかったものは編集画面に理由つきで引き継いで「再試行」できる（`ResourceDetail` が `uploadPendingFiles` を呼ぶ。引き継ぎは `lib/resource/pendingUploads.ts`）。既存レコードの編集は従来どおり添付パネル。添付を外すプリセットでは欄と import が `[scaffold:attachments]` の印で消える。
- **charts:** `@banto/charts/testing` を足す（#852）。jsdom に無い幅・`ResizeObserver` の差し替えを入れて戻す `installChartDom()` と、描画の待ち合わせ `flushChart()`。試験ランナーを import しない。charts 自身の DOM の試験を載せ替え、外部利用 fixture が Git 依存の経路でサブパスを読む試験を足した。README に vitest の設定と例。`installChartDom()` は入れている間の 2 回目の呼び出しを明示のエラーで断る（重ねると戻す順で差し替えが残るため）。足すだけ。
- **forms:** `file` 型を足した（#714 の 4、[計画 §4.12](docs/design/downstream-requests-2026-11-plan.md) の F1）。ファイルはレコードの列にせず、フィールド定義の `file.client`（`list`・`upload`・`remove`。`@banto/attachments` の `AttachmentsClient` をそのまま渡せる構造的な型）だけを通す。forms は通信の契約を持たず、新しい mutating 操作も足さない。`BantoForm` の `fileParentId` があれば（編集）選んだらすぐアップロード・削除もすぐ、無ければ（新規）選んだファイルを値の中で保留し、作成の成功の後に `uploadPendingFiles(schema, store, id)` で順に送る（断られたファイルは理由つきで欄に残り、再試行できる）。`file` 型の値は送信値（`submitValues`・`submitValuesOf`）に入らない。保留がある間は `isDirty` が真。`required`・`accept`・`maxFileSize`・`maxFiles` は**画面だけ**の確認で、業務上の必須は保証しない（README）。1 つのフォームに `file` は 1 欄までで、2 欄目は `createFormStore` が例外を投げる。`FormDraft` は `file` 欄を受けない。`FormStore.messages`、`ValidationMessages` の `fileTooLarge`・`fileTypeNotAccepted`・`fileTooMany`、`FileField`・`FileFieldMessages`・`assertFormSchema` などを公開。ui-demo に見本。テンプレートの items への配線は次の PR（F2）。 消費側への注意: 公開の union `FieldType`（と grid-svelte の鏡 `SchemaFieldType`）に `'file'` が増えるので、網羅 switch をしている利用側は型エラーになる。`columnsFromSchema` は `file` 欄を列にしない。`ValidationMessages`・`FileFieldMessages` を自前の辞書で組んでいるアプリは、新しいキー（テンプレートの `validation.file*`・`fileField.*`）を足すと文言を差し替えられる（足さなければ日本語の既定）。
- **dock-svelte:** `DockState.isOnScreen(id)`（reactive）と `dock.panels[].onScreen` を足した。畳んだ区画の中・タブの裏・引き出していない帯の pane・タイトルバーへ畳んだ浮動・閉じた窓を偽にする。`isVisible` は「閉じていない」の意味のまま（doc を直しただけ、改名なし）。`DockPanelInfo` に `onScreen` が増える（#792）。 消費側への注意: `DockPanelInfo.onScreen` は必須の `boolean` なので、アプリ側で `DockPanelInfo` を自前で組み立てている箇所（テストのモックなど）は型エラーになる。`onScreen` を足す。また `dock.panels` は `flyoutPanel` の開閉でも作り直されるようになった（引き出した帯の pane の `onScreen` が変わるため。ほかの pane の行は値が同じでも参照が変わる）。
- **dock-svelte:** `DockHost` と `ThreePaneDock` に、保存してよい配置が確定したことを知らせる prop `onLayoutCommit` を足した（#791 の前半）。`DockHost` は `(layout, reason: 'user' | 'reset')`、`ThreePaneDock` は `(saved: ThreePaneSavedLayout, reason: 'user' | 'reset' | 'narrow-switch')`。確定点（操作の終わり、操作中でないときの変更の次の tick）で、保存する値が前回の通知・復元から変わっていたら 1 回呼ぶ。ドラッグの途中、拒否・`stale`、復元（`restoreLayout`、`commit` なしの `replaceLayout`）では呼ばない。`resetLayout` は `'reset'` で 1 回届き、消費側は保存を消すかを選べる。`DockHost.replaceLayout` の options に `commit`（通知する理由）と `applied`（配置を入れたのと同じステップで呼ぶ）を足した。同じ配置への `replaceLayout` が承認待ちの間に重なったとき、待っている 1 件を共有するのは `commit`・`saved` が同じで `applied`・`isCurrent` を渡していない呼び出しだけになった（違えば別々に聞き、適用されなかったほうは `stale`。`ThreePaneDock` の `resetLayout`・`restoreLayout` は後から頼んだほうが残る）。`onLayoutCommit`・`applied` が投げた例外は `reportError` で報告し、`onGestureEnd` と `replaceLayout` の完了は止めない。型 `DockLayoutCommitReason`・`ThreePaneLayoutCommitReason` を公開。あわせて `ThreePaneDock` は、狭い ⇄ 広いの切り替えと狭い表示での `resetLayout` / `restoreLayout` の控えを、配置を入れるのと同じステップで確定するようにした: フォーカスが枠の中にあるときに `layoutSnapshot()` が確定前の値（狭い表示の木）を返す瞬間が無くなる。テンプレートの `/tree/workspace-dock` の自動保存をこの口に載せ替えた（保存の部品のパッケージ化は後半）。
- **dock-svelte:** `DockHost.cancelGesture(): boolean` を足した。進行中の操作（ドラッグ・リサイズ・仕切りの移動）を取り消し、対象を元に戻す。取り消したら `true`、無ければ `false` で何も起こらない。`onGestureEnd` へは `'cancel'` と理由 `'api'` で届く。`arrange` を一瞬 `false` にする回り道が要らなくなる（#796）。

### Changed

- **dock-svelte（破壊的・挙動の変更）:** ドックから隠した pane の出し直しを「覚えた元の場所（`dockSlot`）」から「既定のレイアウトでの位置」に変えた（#782 PR5、Issue #782 の 2026-11-22 の方針変更の 1〜5・7・9）。`DockState.defaultLayout`（保存しない任意の欄）と純関数 `core/defaultPlace.ts`（`placeAtDefault`）を足し、`dismiss` は戻り先を取らずに影の木からも外す（閉じた窓には `dockShare` = 隠す直前の比率だけ）。`show`・`showPlacement`・`showTabSwitch`・`DockHost.showPanel` の事前の問い合わせは同じ 1 つの計算（`DockState.shownTree`）を読む。`ThreePaneDock` は左右とも開いた形の既定を渡す。浮動からの「元の場所に戻す」（`undockPanel` / `dockAtSlot`）と帯からの戻しは slot のまま。`FloatingWindow.dockSlot` を型と保存から外した（`dockShare` は `0 <= n <= 1`。古い JSON の `dockSlot` は読まずに捨てる。layout の `version` は 2 | 3 のまま: 帯の `slot` が深いときだけ 3）。影の木の追従の中の例外は握りつぶさず `reportError` で報告する。テンプレートの `/dashboard` は既定の配置を `dock.defaultLayout` に入れる。試験: 戻す順の可換性などの性質（`slot-properties.test.ts` を書き直し、`default-place.test.ts` を新設）。hide × show の総当たり（`panel-visibility-exhaustive-*` の 6 本）と旧実装 `slot-main.ts` との比較を削った。消費側への注意は上の一覧。
- **admin-template:** ロールの型 `'admin' | 'editor' | 'viewer'` を `#lib/permissions.ts` の `Role` に統一し、`usersAdmin.ts` の `Role` と `authAdmin.ts` の `AuthDisabledRole` を無くした（#819。挙動の変更なし）
- **theme（見た目の変化）:** 先頭 4 系列（`--banto-chart-1`〜`-4`）と状態色（`--banto-warning`・`-danger`・`-success`）の色差の下限（OKLab 0.09、正常色覚）を試験にし、ダークの `--banto-chart-2` を `#f48815` → `#ed770e` に変えた（#795）。warning との距離が 0.052 → 0.092。ライトは通っていたので変えていない（最小 0.110）。消費側への注意: ダークのグラフの 2 本目の橙が少し暗く赤寄りになる。見た目の基準画像を持つアプリは撮り直す。5 番目以降の系列と、色覚シミュレーションでの状態色との距離は保証しない（状態色をグラフに描くときは破線・印・ラベルを併用する）。
- **theme・charts（見た目の変化）:** 系列色を 16 枠にした（#851、[計画 §4.14](docs/design/downstream-requests-2026-11-plan.md)）。`--banto-chart-9`〜`16` を足した（ライト `#a67c00` `#d81b60` `#3b82c4` `#5c940d` `#b5179e` `#343a40` `#c4472a` `#7d8794`、ダーク `#d9c23a` `#ff6fa5` `#7fb5f0` `#a6d44a` `#e87ce0` `#c9ced4` `#ff8a65` `#8a97a6`。banto-industrial の `--bi-chart-9〜16` の値のまま）。`@banto/charts` の `MAX_CHART_SERIES` を 16 にし、`seriesColorVar` は 9〜16 番を `var(--banto-chart-N, var(--banto-chart-8))` で返す（9〜16 を持たないテーマでは 8 番の色 = これまでと同じ見た目）。`inlineCssVarRefs`（SVG の書き出し）は fallback 付きの `var()` を解決する。1〜8 の値と検査は変えていない。`chart-palette.test.ts` に「1〜16 のどの 2 つも正常色覚で OKLab 0.06 以上」「9〜16 は面に 3:1 以上」を足した（実測の最小はライト 0.092・ダーク 0.076、面との比は 3.64:1・4.78:1）。色覚シミュレーションでの距離（最小 0.008）と状態色との距離は保証しない。値と実測は [visual-refresh-plan.md](docs/design/visual-refresh-plan.md) の付録 A.3a、使い方は `packages/charts/README.md`。
- **Node の基準を 24 から 26 に上げた（#837 を置き換える）。** `.nvmrc`・ルートの `engines.node`（`>=26`）・`@types/node`（`^26.0.0`。ルートと `fixtures/external-consumer`）・全 workflow の `node-version`・README / `docs/upgrading.md` / `docs/recipes/windows-setup.md` の前提表記を 26 にした。
- **dock-svelte・grid-svelte・theme:** primary の文字（DockedTree・DockWindow の選択・開閉、BantoGrid の一括選択・開閉記号、HeaderCell の並べ替え・絞り込み表示）を `--banto-primary-text` に移した。ダークでコントラストが上がる（#808）。`--banto-surface-muted`（`--banto-surface-subtle` と同値）を theme に足し、Tree の件数バッジが未定義の変数でなく定義済みの面を参照するようにした。消費側が `.disclosure`・`.sort-arrow` などの色を自前の CSS で上書きしていれば、そちらが優先される
- **基準の作り直し（破壊的。#790・#778・#786 の C1、ADR-0034）。** `users` に `kind`・`account_uid`（アカウントの作成時にサービス層が採番する 128 bit の乱数）を足し `password_hash` を NULL 可に、`audit_log` に `actor_id` を足した（`0003`・`0005` の書き換え、2 方言）。`0014_ui_settings.sql` が表 `ui_settings` と組み込みのユーザー `admin` の行を入れる。組み込みの行はログインの照合・件数・`has_admin`・最後の管理者のガードから外れ、更新・パスワードの設定・権限の付与・削除はサービス層が断る（ユーザー一覧だけが読み取り専用の 1 行として返す）。旧版の DB は起動時に明示のエラーで断り、リストアの候補は必須の表（`ui_settings` を追加）に加えて migration の履歴（版と checksum）を予約と適用の直前に確かめる。初回の seed の条件を「`settings` が空」から「seed 済みの印（`first_boot.seeded`）が無い」に直した。`pnpm verify:migrations` は、タグ `v7.11.0` と比べるときだけこの 4 ファイルの変更を許す。
- **`banto-admin-services`・`banto-server`・テンプレート: 監査の主体を認可時のスナップショットにし、組み込みの `admin` への帰属・予約名・起動時の検査を足した（破壊的。#807・#778 の C2、[ADR-0034](docs/adr/0034-owner-identity-builtin-admin.md) 決定 §2〜§4・§9）。** (1) ガード（REST の `require_auth`、Tauri の `require_role`）が、通したセッションから監査の主体 `AuditActor`（`actor_username`・`actor_id`・`actor_role`・`actor_kind`）を 1 回だけ作り、成功の監査にも拒否の監査にも同じものを渡す。書き込みの後に bearer から引き直さないので、書き込みの間にセッションが終わっても監査に主体が残る（#793 の S2 からの持ち越し。`#[ignore]` で置いてあった再現の試験を有効にした）。(2) auth フローを含む `AuditEntry` の直組みを、共有の `record_as` / `record_write_as` / `record_denied_as` / `record_login_failed_as` に置き換えた（#807。REST と Tauri が同じ関数を通る）。(3) 誰に帰属させるかは `AuditActor::attribute` の 1 か所で決める。見るのは配線が付けた印だけ: `GrantSpec.audit_as_builtin_admin`（既定 off。`TokenRecord` → `AuthenticatedSession` の `#[serde(skip)]` の欄へ写す。wire には出ない）と、Tauri のログインなしのセッション。印つきは `actor_username = 'admin'`・`actor_id` = 組み込みの行の id（配線が起動時に `kind = 'builtin'` で 1 回引く）、`actor_role` はそのセッションの実際のロール。経路は `actor_kind`（`account` / `local` / `grant:<kind>`。wire は `actorKind`）に残す。監査ログの画面の詳細に「セッションの種類」を足した。(4) 予約名: `admin` はサービス層が自前で、grant の固定 id は配線が `UsersService::with_reserved_usernames(ReservedUsernames)` で渡し、アカウントの作成を大小無視で断る（`GrantRegistry::identity_ids` を足した）。(5) 起動時の検査 `UsersService::check_startup`（組み込みの行がちょうど 1 つ・予約名と同じ名前のアカウントが無い）を REST と Tauri の両方の配線が呼び（`admin_template_core::startup::check`）、当たれば名前と対処を書いたエラーで起動を止める。**同じ関数をリストアの候補にも掛ける**（`MigrationManifest::with_candidate_check`。予約のときと適用の直前。作業用のコピーに migration を当ててから検査し、断ったら元の DB は変わらない）。起動時の検査は、組み込みの行の名前（小文字の `admin`）とロール（`admin`）も確かめる。候補を**検査できなかった**とき（作業用のコピーを作れない・読めない）は候補の不正とは分け、予約のファイルも元の DB も残して次の起動で確かめ直す（`CandidateVerdict`）。(6) 組み込みの行への更新・削除・パスワードの設定の拒否を、500（`other`）から 403（`forbidden`）に変えた。(7) e2e の管理者名 `public`（smoke・公開閲覧）を `e2e-admin` に変えた（予約名になったため）。
- **CI: e2e の「長いエラーの折り返し・キー操作」（`grid-long-errors.spec.ts`）の不安定さを直した（#831）。** パネルでの `End` / `Home` を、前のキースクロールが終わる前に押すと落ちることがあったので、`PageDown`（#798）と同じく、押すのを poll の中に入れた。テストだけの変更で、`src/`・公開 API の変更なし。
- **`banto-server`: 書き込みを接続の切断から切り離して最後まで走らせる（#793、[ADR-0035](docs/adr/0035-detached-writes.md)）。** `BoundServer::serve`（`start` も）が router 全体に層を 1 つ掛け、POST・PUT・PATCH・DELETE の要求を別のタスクで走らせる。クライアントが応答を待たずに切れても、作成・セッションの失効・監査まで終わる（これまでは hyper が handler を途中で捨て、「アカウントは作られたのに監査が無い」が起きえた）。ログインも含み、除外の口は無い。冪等にはしない（切れたクライアントは結果を知らない。再送で二重に効く操作は、version や一意制約で守る）。handler の panic は接続の切断ではなく 500（`kind: other`、「状態を読み直してから、もう一度試してください」）になる。`RunningServer::stop()` は、まず新しい書き込みを 503 で断り、走っている書き込みを上限つき（10 秒、`DETACHED_WRITES_STOP_TIMEOUT`）で待ち、残っていれば `StopOutcome::WritesRemaining` を返す（成功にしない。残った書き込みは中断しない）。デスクトップの「LAN 設定の適用」は、書き込みが残っているときは求められた構成の listener を起動せず、露出の向きで分ける: 広げる・同等の変更（ポート、bind を広げる、閲覧公開を始める）は切り替えの失敗（保存せず、前の listener を戻す。`applyFailure.reason` は `writesRemaining`）、サーバーの無効化は保存して閉じたまま成功、狭める変更（閲覧公開の停止、bind を狭める）は保存して listener を閉じたままエラーで返す（`previous` は `leftClosed`。もう一度適用すると起動する）。書き込みが残っているときは、狭める変更が保存の失敗で終わっても前の listener を戻さない（`reason` は `saveFailed`、`previous` は `leftClosed` = 閉じたまま・保存されていない）。同時に走る書き込みは 256 件まで（`MAX_DETACHED_WRITES`）で、達している間の新しい書き込みは 503（受理済みは止めない）。この枠（`WriteBudget`）は listener の世代をまたいで共有でき、テンプレートのデスクトップは共有する（止めた listener に残った書き込みも枠に数える。自前で listener を入れ替える派生アプリは `RunningServer::write_budget()` を `BoundServer::with_write_budget()` へ渡す）。残った書き込みは監査の `detail.remainingWrites` に残る。向きの判定は `banto_server::restoring_previous_stays_within`。handler ごとの順序の点検は別の PR（S2）。消費側への注意: (1) **`RunningServer::stop()` の戻り値が `()` から `StopOutcome` になった**（`server.stop().await;` はそのまま通る。止めた後に別の listener を起動する呼び手は、結果を見ること）。(2) 派生アプリは `serve` を通るだけで全書き込みに掛かる。handler を自前で `tokio::spawn` して包んでいる所（banto-industrial の `run_detached`）は外せる（残しても害は無い）。(3) 切断で書き込みが止まることに頼っていた処理があれば、止まらなくなる。長い書き込みは切断の後も走り続ける。(4) `serverAdmin.ts` の `ServerApplyFailure` の `reason` に `'writesRemaining'`、`previous` に `'leftClosed'` が増えた（`leftClosed` で設定が保存されているのは、`reason` が `writesRemaining` のときだけ）。網羅の `switch` を書いている派生アプリは枝を足す。
- **`banto-server`: 書き込みは、本文を受け取ってから同時実行の枠を取る（#793、ADR-0035 §7。PR #829 のレビュー指摘の続き）。** 上の層は、書き込みの本文を先に受け取り（2 MiB まで = `BUFFERED_BODY_MAX_BYTES`。axum の本文の上限の既定と同じ）、届き終えてから 256 件の枠を取って handler を始める。ヘッダーだけ送って本文を止める接続（未認証でも開ける）が枠を占めて、正しい書き込みがすべて 503 になることを防ぐ。本文が 30 秒（`BODY_RECEIVE_LIMIT`。受信の全体）で届き終えなければ 408 で断る（handler が始まる前にだけ効く。始まった handler は止めない）。受け取り中の本文の合計は 64 MiB まで（`RECEIVING_BODIES_MAX_BYTES`。`WriteBudget::receiving_bytes()` で読める）で、入らない書き込みは 503。停止中・枠が埋まっているときは本文を待たずに断る。2 MiB を超える本文（バックアップのアップロード）は今までどおり handler に流し、その種の書き込みは同時に 16 件まで（`MAX_STREAMED_WRITES`。超えた分は 503）。消費側への注意: 2 MiB 以下の本文の書き込みは、認可で断られる要求でも本文が届き終えてから handler が走る。
- **`banto-server`・テンプレート: 書き込みの handler の順序（確定 → 失効 → 監査）を点検し、3 点を直した（#793 の S2、[ADR-0035](docs/adr/0035-detached-writes.md)、conventions §1）。** (1) 2 MiB を超える本文を受け付けるルート（`POST /api/backups/restore`・`POST /api/attachments`・`POST /api/items/import`）は、本文を受け取り終えた所でもう一度認可する（`banto_server::routes::recheck_role_at_least` を追加）。これまでは、ガードを通った後に本文を開いたままにし、アカウントが削除・降格された後で送り終えても、復元の予約・添付の保存・一括インポートができた。待ちの間にセッションが終わっていれば 401、ロールが足りなくなっていれば 403（`denied` の監査つき）で、何も書かない。この 3 つのルートでは、本文の大きさで分けず、ストリームでない小さい本文も統一して照合し直す（成功の監査は、照合し直したセッションの主体で書く）。本文の上限（`DefaultBodyLimit`）を上げるのは、この 3 つのルートだけにした: これまでルーター全体に掛かっていたので、`/api/items`（作成・更新・一括削除）・`DELETE /api/attachments/{id}`・`/api/backups` のほかのルートは、2 MiB を超える本文を 413 で断るようになる（正規の要求はこの大きさにならない）。あわせて `AuthState::authenticate`・`revalidate` は、アカウントの照合の後に、トークンの存在・期限・stamp を 1 つのロックの下で確定する: 照合の間にログアウト・期限切れ・失効したトークンは、その要求から未認証になる（これまでは、その 1 回だけ通りえた）。本人のパスワード変更で結び直されたトークンは、これまでどおり有効。(2) REST の `POST /api/auth/change-password` の監査の `entity_id` を、確定の後の読み直しではなく、認可したセッションの id から取る（変更の直後にアカウントが消える・DB が答えないと `entity_id` が空になった）。(3) Tauri の `backups_stage_restore` の監査の `entity_id` を、REST の `POST /api/backups/{fileName}/restore` と同じバックアップのファイル名にした（これまで `None`。conventions §1 の「両経路で同じ監査」）。点検で分かった残り: REST の `record_write` は書き込みの後に bearer から主体を引き直すので、書き込みの間にセッションが終わると監査の主体が空になる（C2 で、ガードのスナップショットを渡す形に直す。ADR-0034 §3）。消費側への注意: (a) 2 MiB を超える本文を受け付けるルート（`DefaultBodyLimit` を上げたルート。アップロード、一括インポート）を持つ派生アプリは、上限をそのルートの `MethodRouter` にだけ掛け（`post(handler).layer(DefaultBodyLimit::max(..))`）、本文を受け取った後に `recheck_role_at_least` を呼ぶ（権限のガードを使っている経路は、同じ位置で `AuthState::authenticate` と `session_permissions` を呼び直す）。(b) 監査の `restore_staged`（origin `tauri`）の `entityId` が `null` からファイル名に変わる。
- **`@banto/dock-svelte`: 影の木の純関数 `core/shadow.ts` を足した（#782 の PR2）。** 隠れた・浮かせたパネルの「元の場所」を、墓石つきの全体木 S で持つための型と操作（見える木への射影、隠す・戻すの印、取り除き、`dockExisting` / 外周への移動、リサイズの書き戻し）と、その単体テスト・性質テスト（`tests/shadow.test.ts`。シードと件数は固定）。まだどこからも使っておらず、`index.ts` からも出していない。挙動・公開 API・保存形式の変更なし。
- **`@banto/dock-svelte`（内部）: 影の木と保存の形（見える木 + `dockSlot`）を行き来する純関数 `deflateShadow` / `inflateShadow` を `core/shadow.ts` に足した（#782 の PR3）。** deflate は影の木 S から、見える木と墓石ごとの `DockSlot`（S の中の場所と取り分。今の `DockSlot` の形のまま）を作る。inflate は見える木と slot の集まりから S を組み直す（畳まれて消えた split・タブの組も ID ごと作り直す。場所が当てはまらないパネルは「場所なし」として返す）。単体テスト・性質テスト（往復で S が保たれる、どんな slot でも射影は見える木のまま、比率 0 の約束、ほかのパネルを隠す・戻すで slot が変わらない）と、旧実装（main の slot）との総当たりの比較（`tests/panel-visibility-exhaustive-shadow.test.ts`。既存の総当たりの道具を流用）を足した。今の `slot.ts` が書いた slot を読む境界は、今の復元に合わせてある（全部のタブが外に出た組の取り分は最後に渡した slot のもの、`neighborId` がいまある split・タブの組を指すなら目印が空でもその隣、split・タブの組の中の位置はいま見えている隣・目印が先で `index` は後、1 枚だけのタブの組は組のまま）。まだどこからも使っておらず、`index.ts` からも出していない。挙動・公開 API・保存形式の変更なし。
- **`@banto/dock-svelte`（内部）: `DockState` が影の木 S を配置の横に並べて持つようにした（#782 の PR4）。** `layout` への代入のたびに、S を同じ変化に追従させ、S の射影が `layout.docked` と同じになるように保つ（隠す・浮かせるは墓石の印、戻すは印を外す、ドッキングと外周への移動は S の上の同じ操作、リサイズ・タブの切り替えと並べ替え・帯の印・タイトルは見える木から S へ書き戻す（`writeShadowView`）。丸ごとの置き換え・帯への自動で隠す・S と結果が違う操作では、見える木と slot から S を組み直す）。S はまだ何にも読まれておらず、隠す・戻す・移動は今までどおり slot で決まる。テスト（`tests/shadow-parallel.test.ts`）で、どの手順の後も「S の射影 = `layout.docked`」と、隠す・浮かせる・戻すだけの手順と墓石の無い移動では S の上の操作だけで同じ木になることを確かめる。#845（列のパネルを全部浮かせて戻すと隣の比率が戻らない）を既知の失敗として `tests/split-sizes.test.ts` に固定した。挙動・公開 API・保存形式の変更なし。
- **dock-svelte（挙動の変化）:** `DockHost.replaceLayout`（`ThreePaneDock` の `resetLayout` / `restoreLayout` を含む）は、不正でない置き換えなら、`beforePanelChange` に聞く前に進行中の操作を自動で取り消す。消費側への注意: 操作中に `replaceLayout` / `resetLayout` を呼ぶと、操作は確定せず `onGestureEnd(kind, 'cancel', 'api')` で閉じる。置き換えが拒否（`refused`）・`stale` になっても、取り消した操作は戻らない。`invalid` のときは取り消さない。さらに、`replaceLayout` が処理中（`beforePanelChange` の承認待ちを含む）の間は新しい操作（ドラッグ・リサイズ・仕切り）が始まらず、置き換えの結果が返るまで続く（承認待ちの間に始めた操作の pointerup や Esc が新しい配置を上書きしないため。並行して複数あれば最後の 1 件が返るまで）（#796）。
- **ui:** `ToastHost` の success・error・warning の背景を、不透明な `--banto-surface-overlay` の上に tint を重ねる形にした。ダークの tint は半透明なので、下の画面が透けて通知が読みにくかった。theme のトークンは変えていない。`BantoGrid` の固定列（行・セルの状態色の層つき）は元から不透明で、`ConnectionBanner`・`UnsavedChangesNotice` は浮かぶ面でないので変更なし（#794、#808 の ToastHost の色の分）。
- **ci:** `visual-baselines.yml` を `visual.spec.ts` だけの再生成・確認にし、Rust のビルドをやめ、`commit` の既定を true にした。1 回の dispatch で済む（#798）。
- **ci:** e2e の visual を、画像を撮る spec だけの project `visual`（workers 2）と、残りの機能・axe の project `visual-ui`（並列 workers 4、`pnpm e2e:visual-ui`）に分け、CI の E2E (visual + axe-core) を速くした。撮る spec は `playwright.config.ts` の `SNAPSHOT_SPECS` に足す（#798）。
- E2E（#798）: `BANTO_E2E_SERVERS` に `smoke`（:8799）と `public-viewer`（:8798）を足し、CI の E2E ジョブの smoke・viewer-public の各 step で必要な banto-serve だけを立てる（使わない 2 本目を立てない）。smoke の固定 wait は、時間経過そのものを見る scenario 13b の 7 秒（「その後は何も起きない」の確認）と、同じ性質の 500ms・300ms を例外として残した。
- **ci:** `visual.spec.ts` のログインとダッシュボードの基準画像を、ほかの画面と同じ対角の 2 組（light-standard と dark-glass）にした。24 枚から 12 枚になり、visual の実行が短くなる（#798）。
- **CI: `@banto/dock-svelte` の総当たりテストを別ファイルに分け、深さを環境変数 `DOCK_EXHAUSTIVE` で切り替えるようにした（#798 PR-d）。** `panel-visibility.test.ts` の総当たり（隠す順 × 戻す順・手順の全列挙・乱数の手順）を `panel-visibility-exhaustive-*.test.ts` に移し（共有の道具は `tests/fixtures/`）、`DOCK_EXHAUSTIVE=1` のときだけ全部の深さ・件数で走る。未設定（手元の既定）は浅く、CI は dock-svelte を触る PR と main の push で全部、触らない PR は浅い既定（`ci.yml` の `changes` の出力 `dock`）。テストと CI だけの変更で、`src/`・公開 API・保存形式の変更なし。

### Fixed

- **template:** items の添付パネル（`ItemAttachments`）のアップロードも、`ResourceDetail` の `file` 欄と同じセッションの確認（`uploadWhile` / `guardUpload`）を通すようにした（#714）。送信の途中でログアウトや別ユーザーへの切り替えが起きても、古いセッションの資格では送らない。

## [7.11.0] - 2026-11-22

**v7.11.0 — `pnpm banto add resource` による CRUD リソースの生成（#715 E-2）とテンプレートの `AppResources`・`rest::resources_router`、`@banto/grid-svelte` の行の右クリックの口 `onRowContextMenu`（#784）、`@banto/dock-svelte` の隠れたパネルを戻す位置・比率の修正（#743・#777・#781）と据え置き pane のスクロール位置の復元（#768）、`pnpm check` への `e2e/` の型検査の追加（#774）。** 版の種類: minor（新しい機能の追加が主）。`crates/*/src` の `pub` と `packages/*/src/index.ts` の export の削除・改名は無い（`v7.10.0` との差分で確認）。公開の union への種類の追加も無い。実行時に見た目や動きが変わるのは、グリッドの Tab で入った直後の矢印キー、dock の「元の場所」へ戻す配置・比率、据え置き pane のスクロール位置の 3 点（下の「消費側への注意」）で、いずれも直す方向の変更なので minor とする。migration なし。

消費側への注意（ソース互換・挙動。いずれも下の各項目に詳細）:

- 派生アプリのルート `package.json`（`pnpm check`）: ルートの `check` が `check:e2e`（`tsc -p e2e/tsconfig.json --noEmit`）も走らせるようになり、ルートの devDependencies に `@types/node`（`^24.0.0`）・`typescript`（`^6.0.0`）・`axe-core`（`^4.14.0`）が増えた（#774、[ADR-0032](docs/adr/0032-root-e2e-typecheck-devdeps.md)）。`e2e/` を持つ派生アプリがルートの `package.json` と `e2e/tsconfig.json` を取り込むときは、`check:e2e` と 3 つの devDependency を一緒に写す（型だけで実行時の影響は無い）。取り込まなければ今までどおり。
- 追加（`pnpm banto add resource`、#715）: ルートの `package.json` に `banto` スクリプト（`scripts/banto.mjs`）と `e2e:add-resource` が増えた。テンプレートに `AppResources`（`core/src/resources.rs`）と `rest::resources_router` が入り、`banto-serve` と `src-tauri` の `start_embedded_server` は `api_router` の隣に `resources_router` を merge し、`AppState` は `resources` を持つ。生成器は既存のファイルの `[banto:add-resource:<slot>]` のコメント（アンカー）の位置に追記し、1 つでも欠けていれば何も書かずに止まる。したがってテンプレートを取り込んで改造している派生アプリで生成器を使うなら、アンカーを含むファイルを写す。テンプレートの `core/src/lib.rs`・`core/src/resources.rs`・`core/src/rest/mod.rs`・`src-tauri/src/lib.rs`・`src/lib/banto/resources/index.ts` と、ルートの `scripts/verify-architecture.mjs`（`dual-path`・`tauri-read`・`rest-read` の 3 つ。v7.10.0 の検査スクリプトのままだと生成器はこの 3 つの欠落で止まる）。あわせて `src/lib/appPath.ts` の変更も写す。派生側でこれらのファイルを書き換えているなら、ファイルを上書きせず、アンカーの行を対応する箇所へ移す。使わないなら何も要らない（テンプレートのままでは `AppResources` は空で、挙動は変わらない）。
- 型（追加のみ・任意）: `@banto/grid-svelte` の `BantoGrid` に省略可能な prop `onRowContextMenu(row, { x, y })`（#784）。渡さなければ今までと同じ。
- 挙動（`@banto/grid-svelte`、`onRowContextMenu` を渡さないグリッドにも効く）: ポインター操作なしで Tab で入った（アクティブなセルがまだ無い）グリッドでは、矢印キー・Home・End・PageUp・PageDown の最初の 1 回が、見えている最初のデータ行の先頭列をアクティブにする（その 1 回は移動しない。以前は、一度セルをクリックするまでキーで何も起きなかった）。アクティブなセルが無い状態でキーを押しても何も起きないことを前提にしたテスト・利用側の処理がある場合は確かめる。
- 挙動（`@banto/dock-svelte`、隠れたパネルの「元の場所」）: (1) #781・#777 — 外周へ移した（`dockExistingAtEdge`）パネルは、隠れたパネルを戻す順・入れ子の深さによらず外周に残る。消えた split の子を外周へ移したとき、その隣に隠れていたパネルは、移したパネルの側ではなく split に残ったパネルの隣へ戻る（`row[a, b, c]` で `a` を隠し、`b` を下の外周へ移して `a` を戻すと `column[row[a, c], b]`。以前は `row[a, column[c, b]]`）。この配置を前提にしたテスト・保存した layout の期待値は更新する。(2) #743 — 同じ split のドッキング中のパネルが離れたとき、隠れたパネル・浮かせたパネルの元の場所の `share` からその分を除く（`row[extra .2, right .3, center .5]` で `right` を隠し、`extra` を外して `right` を戻すと、以前は 0.3 / 0.7、今は 0.375 / 0.625）。(3) #768 — 据え置き（`persistent`）の pane のスクロール位置（本体と中身の縦・横）は、組み替えとタブの切り替えのあとも戻る。タブの組では pane ごとに持ち、一度もスクロールしていない pane のタブを表にすると先頭になる（前に表にあったタブの位置は引き継がない）。いずれも公開 API・保存形式・`version` の変更は無く、利用側の変更は要らない。
- テンプレート（B）: 取り込むなら次のファイルを写す（`apps/admin-template/` 以下）。`src/lib/appPath.ts`（`resolve` の union の上限を避ける型の絞り込み。リソースを足してルートが 26 を超えると `pnpm check` が落ちる）、`src/lib/banto/resources/index.ts`、`core/src/lib.rs`・`core/src/resources.rs`・`core/src/rest/mod.rs`（`resources_router`）・`core/src/bin/banto-serve.rs`・`src-tauri/src/lib.rs`（`AppResources` の配線）。画面（`src/` の `.svelte`・`messages/`）の変更は無い。

### Added

- **`pnpm banto add resource <name>`: CRUD リソース 1 つ分の定型コードを Rust 側まで生成する（#715 E-2）。** 両方言のマイグレーション（番号は今の最大の次）、サービス、REST、Tauri コマンド、両経路の対称テスト（denied を含む）、監査の detail、ResourcePage の定義とルート 3 本、メッセージのキー（ja・en）、ナビの項目を書く。入力は JSON のフィールド定義（`--fields`。省くと必須の `name` だけ）で、`text`・`textarea`・`number`・`checkbox`・`date` の欄を作れる。版（`version` 列）による楽観ロックは既定で付く。**監査の detail に値が残るのは、定義で `audit: true` を付けた欄だけ**（既定は残さない。`detail.name` は `title: true` を付けた text の欄だけ）で、生成したテストが付けていない欄の値が出ないことを確かめる。フォームと Rust の検証は同じ意味にそろえてある（文字数は UTF-16 の単位、日付は実在日、整数は ±(2^53−1)）。PostgreSQL の識別子の上限（63 バイト）を超える名前、予約語、生成する名前どうしやテンプレートの既存の名前との重なりは、何も書く前に断る。生成物は普通のコードで、再生成・差分の適用はしない。既存のファイルへの追記は `[banto:add-resource:<slot>]` のコメントの位置に行い、1 つでも欠けていれば何も書かずに止まる。`pnpm scaffold` のどのプリセットの後でも使える。使い方は [docs/recipes/add-resource.md](docs/recipes/add-resource.md)「生成器で足す」。依存は足していない（Node の標準モジュールのみ）。生成→ビルドは CI（template-acceptance の `Generate resource → check`）が毎回確かめる: フィクスチャ（`scripts/fixtures/add-resource/orders.json`）で生成したコピーが `verify:architecture`・`pnpm check`・`cargo test`（core と src-tauri）を通り、そのまま Playwright（`pnpm e2e:add-resource`、`e2e/tests-add-resource/`）で、初回セットアップ → ナビから orders の一覧 → フォームで 1 件作成 → 一覧にその行、まで通る。
- **テンプレート: 生成したリソースのサービスを入れる `AppResources`（`core/src/resources.rs`）と `rest::resources_router`。** 新しいリソースが `rest::Services`・`AppState` と、その呼び出し側に欄を足さずに済むようにした。`banto-serve` と `src-tauri` の `start_embedded_server` は `api_router` の隣に `resources_router` を merge し、`AppState` は `resources` を持つ。テンプレートのままでは空で、挙動は変わらない。
- **`@banto/grid-svelte`: `BantoGrid` に行の右クリックの口 `onRowContextMenu(row, { x, y })` を足す（#784）。** `BantoTree` の `onContextMenu` と同じ扱いで、渡したときだけブラウザの既定のメニューを抑え、右クリックのほか `ContextMenu` キー・Shift+F10 でも呼ぶ（位置はアクティブなセルの左端・下端）。フォーカスはコールバックの前にクリックしたセルへ移り、行の選択は変えない。グループ見出し・読み込み中の行・セルの編集中は呼ばない。行はそのまま渡す（選択中の全行を対象にするかは呼び出し側）。編集中は、注入したエディタ全体（カレンダーのボタン・ポップオーバーも）の右クリックを素通しにする。あわせて、ポインター操作なしで Tab で入った（アクティブなセルがまだ無い）グリッドでは、矢印キー・Home・End・PageUp・PageDown（と、`onRowContextMenu` を渡したときの `ContextMenu` キー・Shift+F10）の最初の 1 回が、見えている最初のデータ行の先頭列をアクティブにする（その 1 回は移動しない）。`onRowContextMenu` を渡さないグリッドにも効く。

- **`e2e/` の TypeScript を `pnpm check` で型検査する。** ルートに `check:e2e`（`tsc -p e2e/tsconfig.json --noEmit`）を足して `check` から呼び、そのためにルートの devDependencies へ `@types/node`（`^24.0.0`）・`typescript`・`axe-core` を足した（[ADR-0032](docs/adr/0032-root-e2e-typecheck-devdeps.md)。型だけで実行時の影響なし）。`e2e/playwright.config.ts` の `selectWebServers` は型を明示した（挙動は同じ）。display プリセットの scaffold は、型検査で見つかった残骸（`e2e/demo` と、消した定数を参照する `selectWebServers` の対応表）を一緒に外すようにした。消費側への注意: 派生アプリのルート `package.json` にも `check:e2e` と上記 3 つの devDependency が入る。

- **`@banto/dock-svelte`: 隠れた・浮かせたパネルの「元の場所」の性質テストを足した（#782 の PR1）。** 生成した木（パネル 3〜7 枚、split 1〜3 段、タブの組）と操作列（隠す・浮かせる・`dockExisting`・`dockExistingAtEdge`・戻す・保存と読み込み）で、戻す順によらないこと・往復で元に戻ること・外周へ移したパネルが根の直下に残ること・比率の保存（#743・#739）・保存の往復を確かめる（`tests/slot-properties.test.ts`。シードと件数は固定）。そのために devDependencies へ `fast-check` を足した（[ADR-0033](docs/adr/0033-dock-svelte-fast-check-devdep.md)。テストだけで使い、公開物にも利用者のバンドルにも入らない）。いまの実装で成り立たない性質（#780 など）は「既知の失敗」として印を付けてある。実装（`src/`）の変更なし、公開 API・保存形式の変更なし。

### Fixed

- **`@banto/dock-svelte`: 外周へ移したパネルが、隠れたパネルを戻す順によっては内側の split に戻ってしまうのを直した（#777）。** `column[row[a, b, c], d, e]` で `a`・`b`・`e` を隠し、`c` を `dockExistingAtEdge` で外周へ移してから `e → a → b` の順に戻すと、`c` が外周ではなく column の中（`d` の隣）に入っていた。消えた row の最後の 1 つ（`c`）は、外側の split（column）の slot — `e` 自身の slot と、`a`・`b` の slot の `outer` — でも row の代わりの目印になっていて、#743 の修正は row の段の slot からしか名前を外していなかった。外周へ移したときは、外側の split の段からも外す（隣が `c` だった slot は、消えた row の id を隣に持つ）。どの順で戻しても `c` は外周のまま、`a`・`b` は 0.4 / 0.6。`dockExisting` で別の split やタブの組へ入れる場合は変えていない。公開 API の追加・削除なし、保存形式の変更なし、migration なし。
- **`@banto/dock-svelte`: 外周へ移したパネルが、入れ子の深い配置では、隠れたパネルを戻すと内側の split に戻ってしまうのを直した（#781）。** `row[column[row[a, b, c], d], e, f]` で `a`・`b`・`e`・`f` を隠し、`c` を `dockExistingAtEdge` で右の外周へ移してから全部を戻すと、戻す順によらず `row[row[column[row[a, b], d], c], e, f]` になり、`c` が外周ではなく内側に入っていた。#777 は「消えた split の最後の 1 つ」と、そのすぐ外側の split の段だけを見ていたが、さらに外側の split の slot（`e`・`f` の slot）は、`c` を「`c` が入っていた子（`d` が残っている column）のパネルの 1 つ」として目印に持っていて、戻すときに外周の新しい split ごと包んでいた。内側に消えた split が無い配置（`row[column[c, d], e, f]` で `e`・`f` を隠す）でも同じだった。外周へ移したパネルは元のどの split にも居ないので、どの段の split の slot からも名前を外す（残りの目印 — 上の例では `d` — が場所を示す）。どの順で戻しても `c` は外周のまま、残りは元の比率（`a`・`b` は 0.4 / 0.6）。**挙動の変更**: 消えた split の子を外周へ移したとき、その隣に隠れていたパネルは、移したパネルの側ではなく split に残ったパネルの隣へ戻る（`row[a, b, c]` で `a` を隠し、`b` を下の外周へ移して `a` を戻すと `column[row[a, c], b]`。これまでは `row[a, column[c, b]]` で、`b` が外周から外れていた）。`dockExisting` で別の split やタブの組へ入れる場合は変えていない。公開 API の追加・削除なし、保存形式の変更なし、migration なし。
- **`@banto/dock-svelte`: ドッキング中のパネルが、隠れたパネルと同じ split を離れると、隠れたパネルの `share` にその分が残り、戻したときの比率がずれるのを直した（#743）。** `row[extra .2, right .3, center .5]` で `right` を隠し、ドッキング中の `extra` を `ThreePaneDock` の `panels` から外して `right` を戻すと 0.3 / 0.7 だった。正しくは 0.375 / 0.625（離れたパネルは分母に数えず、その分は残る全員 — 見えているパネルと隠れているパネル — に比例で配る）。#741 は木の外にある（浮かせた・隠した）パネルが無くなる場合で、こちらは木に入っているパネルが離れる場合。**挙動の変更**: 隠れたパネル（閉じた浮動の `dockSlot`）と浮かせたパネルの「元の場所」の控え（`homeSlot`）の `share` は、同じ split のドッキング中のパネルが次のどれかで離れたときに、その分を除いた値になる — 今の配置から作った置き換え（`ThreePaneDock` の `panels` の変更、`saved` を付けない `DockHost.replaceLayout`、`dock.layout = ...`）で外す・置き換える、`dockExisting`（ドラッグのドロップ・`movePanel`）で別の split やタブの組へ入れる、`dockExistingAtEdge` で外周へ出す。入れ子の split で外側の split を離れる場合（slot の `outer` の段）と、隠したあと 1 つだけ残っていたパネルが離れる場合（split 自体はもう木に無い）も同じ — 外すときだけでなく、`dockExisting` / `dockExistingAtEdge` で別の場所へ移すときも離れた扱いになり、隠れたパネルは移した先のパネルの周りではなく、split が元あった場所へ戻る（その split の slot は、移したパネルを目印に持たなくなる）。1 回の代入で、隠れたパネルが元の split に戻り、別のドッキング中のパネルが離れるときも、別々に行ったときと同じ値になる。次は変えていない（テストで固定）: 同じ split の中での並べ替え（2 つだけの split を同じ向きに並べ直す場合を含む）、仕切りの移動、split に新しく入るパネル、パネルを隠す・浮かせる（自分の割合を持ったまま）と元の場所へ戻す、浮かせたパネルを元の split の別の位置へドッキングし直す（#741）、`hydrate` / `reset`。離れたパネルの代わりに、それが最後の 1 つだった入れ物（タブの組・内側の split）を覚えている隠れたパネルが場所を持つときも変えない。帯へ自動で隠す（`autoHideRegion`）も変えていない: 帯のパネルは元の場所を覚えていて `size` で戻るので（帯の slot は `share` を持たない、#739）、離れた扱いにすると「兄弟を隠す → 自動で隠す → 帯から戻す → 兄弟を戻す」で元の比率に戻らなくなる。公開 API の追加・削除なし、保存形式の変更なし、migration なし。
- **`@banto/dock-svelte`: 据え置き（`persistent`）の pane のスクロール位置が、組み替えやタブの切り替えで先頭に戻るのを直した（#768）。** pane の本体（dock が持つスクロールする枠）と、中身の側でスクロールしている要素の縦・横の位置を、受け皿が作り直されうる更新の直前に読み、更新の後に書き戻す（`float` / `dockBack` / `move` / `resetLayout` / hide → show / 自動で隠す・戻す / タブの切り替え / 畳む・開く。`moveBefore` の有無によらない）。これまでは `scroll` イベントで控えた値だけを、中身を移したときにだけ戻していたので、(1) タブを裏へ回して表へ戻したとき（中身は移らない。しかもタブの組は本体を 1 つ共有するので、表のタブのスクロールが裏の pane の控えを上書きしていた）、(2) スクロールした直後で `scroll` イベントがまだ出ていないときの組み替え、で位置を失っていた。タブの組では位置を pane ごとに持つ（一度もスクロールしていない pane は先頭で、前に表にあったタブの位置を引き継がない）。控えは pane の id ごとに `DockHost` が持ち、layout には入らない（保存の形・`version` は変わらない）。公開の口は足していない（利用者の側で控える必要がない）。据え置きでない pane は今までどおり（作り直すので位置は残らない）。
- **テンプレート: ルートが増えると `resolveAppPath` が型エラーになるのを直した。** `resolve()` に `Path` の union をそのまま渡していたため、TypeScript が union の引数を照合する上限（25）を、リソースを 1 つ（ルート 3 本）足すと超えていた（テンプレートは 23 個。26 個で `pnpm check` が落ちるのを確かめた）。pathname を取る形に絞ってから呼ぶ。実行時の挙動は同じ。
- **scaffold: ガラス（vibrancy）を外すプリセット（minimal / display）で、生成後の `pnpm lint` が落ちるのを直した。** 設定の `AppearanceSection.svelte` に、消したロジックだけが使っていた import（`toastStore`・`errorMessage`・`tauri`）が残り、`--max-warnings=0` の未使用警告になっていた。import も一緒に消し、`scaffold.test.mjs` で消し残しを検査する。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `548de749`、`workflow_dispatch`）: [run 44973227338](https://github.com/tyaro/banto/actions/runs/44973227338)（success）。
  - タグの push（`v7.11.0`、main の `548de749`）: [run 44973351791](https://github.com/tyaro/banto/actions/runs/44973351791)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。

    | 項目               | 版                              |
    | ------------------ | ------------------------------- |
    | Node.js            | 24.22.3                         |
    | pnpm               | 10.33.0                         |
    | Svelte             | 5.57.3                          |
    | SvelteKit          | 3.2.0                           |
    | Vite               | 8.3.8                           |
    | vite-plugin-svelte | 7.3.1                           |
    | TypeScript         | 6.0.3                           |
    | Rust               | 1.100.0（0ef1bc386 2026-11-09） |

  - 出所: Node.js は `node: v24.22.3`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、Rust は `Setup Rust toolchain` の `rustc 1.100.0`。

## [7.10.0] - 2026-11-21

**v7.10.0 — `@banto/grid-svelte` のセルの描き方・行選択と一括操作・左端の列の固定（#713 C-3）、一覧の一括削除の API とテンプレートの配線（#713）、`@banto/forms` のフォームの配置・欄の型の追加・参照選択の欄（#714 C-2）、`@banto/dock-svelte` の据え置き pane の組み替えでフォーカスを失わない修正（#763）。** 版の種類: minor（docs/publishing.md「バージョニング規約」の運用上の例外、オーナー判断）。`crates/*/src` の `pub` と `packages/*/src/index.ts` の export の削除・改名は無い（`v7.9.0` との差分で確認。`index.ts` は追加のみ）。公開の union に種類を足し、メッセージのキーを足したので、既存のコードが型エラーになりうる（下の「消費側への注意」）。実行時の値が変わるのは新しい機能を使ったときだけ（`radio` / `multiselect` / `reference` の欄、`visibleWhen`、`renderer` / `tone` / `selectable` / `pinned` を付けた列、`deleteMany`）なので、追従の手順を明記して minor とする。migration なし。

消費側への注意（ソース互換・挙動。いずれも下の各項目に詳細）:

- 型（union が広がった）: `@banto/forms` の `FieldType` に `'radio'` / `'multiselect'` / `'reference'`、`@banto/grid-svelte` の `SchemaFieldType`（`columnsFromSchema` が受ける構造的な写し）に同じ 3 種類。`FieldType` / `SchemaFieldType` を網羅 switch（`never` で締める）している・`Record<FieldType, …>` の形で全種類を持つ利用側は型エラー（3 つの分岐を足す）。値が配列（`multiselect`）や `null`（`reference`）になる欄が生まれるので、`store.values` / `onSubmit` の値を欄の型で決め打ちしている箇所も確かめる。いずれもスキーマにその型を書いたときだけ実行時に現れる。
- 型（キーが増えた）: `ValidationMessages` に `visibilityUnsettled`、`@banto/grid-svelte` の `GridMessages` に `pinColumn` / `unpinColumn` / `booleanTrue` / `booleanFalse` / `selectRowLabel` / `selectAllRows` / `selectAllLoadedRows` / `selectionStatus` / `selectAllMatching` / `allMatchingStatus` / `selectionClear` / `bulkBarLabel`。どちらも省略可能（既定の文言あり）なので、`Partial` のまま渡す利用側は変更不要。`Required<ValidationMessages>` / `Required<GridMessages>` を使う利用側は、足されたキーを埋める。
- 型（追加のみ）: `FieldDef` に `variant` / `prefix` / `suffix` / `section` / `fullWidth` / `visibleWhen` / `help` / `search` / `resolve`、`FormSchema` に `sections` / `columns`、`GridColumn` に `renderer` / `progressMax` / `href` / `tone` / `pinned`、`DataProvider` に省略可能な `deleteMany`（Tauri の provider が呼ぶコマンド `${resource}_bulk_delete` は、使う場合だけ Rust 側に要る）。すべて省略可能で、既存の定義はそのまま動く。
- 挙動: `BantoForm` の `onSubmit` に渡る値は、`visibleWhen` を使う欄があるときだけ `store.values` と異なる（隠れた欄のキーが無い）。グリッドの行選択・列の固定・`renderer` は付けたときだけ有効（既定は off）。
- `@banto/dock-svelte`: 新しい公開 API `isDockRearranging(node)`。据え置き（`persistent`）の pane を組み替えるとき、中のフォーカス中の入力欄に出ていた `blur`（blur で確定するフォームの誤った確定）を、`Element.moveBefore()` のある環境（Chromium 133 以降など）では出さないようにした（#763）。その環境ではアプリ側の変更は要らない。`moveBefore` の無い環境（古い WebView2 など）では、今までどおり blur が出てからフォーカスが戻る。blur で値を確定するアプリは、blur のハンドラで `isDockRearranging(event.target)` が true のときは確定しないようにする（どちらの環境でも害は無いので、入れておくのが安全）。
- テンプレート（B）: 取り込むなら次のファイルを写す（`apps/admin-template/src/` 以下）。`lib/banto/i18n.ts`（`resource.bulkDelete*` ほかのキー）、`lib/banto/reference.ts`（`referenceFrom`）、`lib/banto/resources/items.ts`（`bulkDelete: true`）、`lib/resource/bulkDelete.ts`、`lib/resource/listViews.ts`（保存ビューの `pinned`）、`lib/resource/types.ts`、`lib/resource/ResourceListPage.svelte`、`lib/resource/ResourceClientGrid.svelte`、`lib/resource/ResourceServerGrid.svelte`、`lib/resource/ResourceDetail.svelte`、`routes/(app)/ui-demo/+page.svelte`（デモ）。文言は `apps/admin-template/messages/ja.json`・`en.json`。一括削除はバックエンドも要る（写さずに `bulkDelete: true` だけを入れると、HTTP の provider は常に `deleteMany` を持つので操作は出るが、`POST /api/items/bulk-delete` が無く 404/405 で失敗する）: `apps/admin-template/core/src/items.rs`（一括削除のサービス）・`core/src/attachment_wiring.rs`（`sweep_items_attachments`）・`core/src/rest/items.rs` と `core/src/rest/mod.rs`（REST の経路）・`src-tauri/src/lib.rs`（`items_bulk_delete` のコマンド）。ほかにテスト（`reference.test.ts`・`bulkDelete.test.ts`・`listViews.test.ts`・`core/src/rest/tests.rs`・`core/tests/pg_smoke.rs`）。

### Added

- `@banto/grid-svelte` の列に組み込みの描き方 `renderer: 'badge' | 'progress' | 'boolean' | 'link'`（`progressMax`・`href` 付き）と、条件つき書式 `tone: (value, row) => 'success' | 'warning' | 'danger' | 'info' | 'neutral' | null`（#713 C-3 の 1 つ目の PR）。解決は `core/cellView.ts` の純関数（`resolveCellView` / `resolveCellPresentation` / `resolveTone` / `safeHref`）、色はテーマの状態色トークンのみ。優先順位は `render` > `cell` > `renderer` > 素の文字。`link` だけ編集不可（他は `editable` に従う）。コピー・CSV は従来どおり生の値。boolean の読み上げは `messages.booleanTrue` / `booleanFalse`（既定は「はい」「いいえ」）。ui-demo のグリッドに状態（badge + tone）・進捗・速達の列を追加（visual の基準画像が変わる）。型: `Required<GridMessages>` を使う利用側は 2 キー分の型エラー。
- `@banto/grid-svelte` の `BantoGrid` に行選択と一括操作バー（#713 C-3 の 2 つ目の PR。既定は off）。`selectable` で先頭にチェックボックスの列とヘッダーの全選択、1 件以上を選ぶとグリッドの下にバー（件数・選択解除・`bulkActions` snippet に `{ ids, clear }`）。選択は `selectedRowIds`（bindable、`getRowId` の値の配列）と `onSelectionChange` で受け取り、`GridState`（保存ビュー）には入らない。全選択の対象は client モードが一覧の全行（絞り込み後）、server モードが読み込み済みの行だけで、ヘッダーのチェックボックスの名前とツールチップに出る。見えなくなった行の選択は外す（client: 一覧から消えた行、server: グリッドの絞り込みが変わったら全部）。アクティブなセルで Space を押すと行の選択を切り替える（リンク・ボタンを持つセルとグループ見出しを除く。`selectable` のグリッドでは Space は `onRowClick` を呼ばず、行を開くのは Enter）。行の選択状態はチェックボックスで伝え（`aria-selected` はセルの範囲選択のまま）、件数は `role="status"` で読む。判定は `core/rowSelection.ts` の純関数（`selectAllState` / `toggleRowId` / `toggleAll` / `retainSelected`）。一括の API は足していない（バーは id を渡すだけ）。ui-demo のグリッドに選択と「速達にする」の例を追加（visual の基準画像が変わる）。型: `Required<GridMessages>` を使う利用側は 6 キー分（`selectRowLabel` / `selectAllRows` / `selectAllLoadedRows` / `selectionStatus` / `selectionClear` / `bulkBarLabel`）の型エラー。
- `@banto/grid-svelte` に左端の列の固定（#713 C-3 の 3 つ目の PR。既定は off）。列に `pinned: 'left'` を付けると、その列は固定していない列より常に左に出て、横スクロールしても残る（`position: sticky`）。`selectable` のチェックボックスの列は、固定した列が表示されているあいだ一緒に固定される。境界の影は、横スクロールが 0 より大きいときだけ固定した最後の列の右端に出る（`@banto/theme` の新しいトークン `--banto-grid-pinned-shadow`。forced-colors では線）。`pinned` は `hidden` と同じく初期値で、以後は `GridState` が持つ（`pinned: string[]`・`isPinned`・`setColumnPinned`・`toggleColumnPinned`・`pinnedCount`）。`serialize()` は `pinned` を書き出し、`hydrate()` は `pinned` の無い古い保存内容をそのまま受け付ける（列の定義の `pinned` が効く）。列のドラッグは自分の区画（固定 / 固定でない）の中だけで、`moveColumn` も同じ制約。固定した列の幅がグリッドの幅から 120px を引いた分を超えるときは、収まらない後ろの固定列から固定をやめる。キーボードでアクティブなセルが動くときは、固定した列の下に隠れないようにスクロールする。グループ見出しの中身は、固定した列があるあいだ左端に留まる。判定は `core/pinning.ts` の純関数（`partitionPinned` / `fitPinnedCount` / `pinnedOffsets` / `clampDropIndex` / `moveInOrder` / `scrollLeftToReveal`）。固定を切り替える UI は足していない（`ColumnsMenu` は従来どおり表示 / 非表示だけ。messages の追加も無い）。列ドラッグの挿入位置の線をヘッダーと固定した列の上に出すようにした（`z-index`。これまではヘッダーの下に隠れていた）。ui-demo のグリッドで出荷番号の列を固定（visual の基準画像が変わりうる）。消費側への注意: `GridState.serialize()` の出力に `pinned` が増える（保存内容を自前で厳密に検証している利用側は要対応）。`orderedColumns` / `allColumns` は固定した列を先頭に返す（何も固定しなければ従来と同じ）。`rowClass` で行に付けた独自の背景は固定したセルには出ない。
- テンプレートの items の一覧に、選んだ行をまとめて削除する例を配線（#713）。**出すのは次の 3 つがそろう一覧だけ**: リソース定義の `bulkDelete: true`（新しい省略可能な項目。items だけ true）、provider の `deleteMany`、削除の権限（`resourcePermissions` の `delete`）。そろわない一覧には `selectable` も一括操作バーも出ない（HTTP と Tauri の provider はどのリソースにも `deleteMany` を返すので、メソッドの有無だけではリソースの対応を判断しない）。確認ダイアログに件数を出し、実行は **`DataProvider.deleteMany` を 1 回だけ**呼ぶ（全件成功か全件失敗か。1 件ずつの削除はやめた）。成功は「N件を削除しました」で選択を空にして再読み込み、衝突は「ほかで変更されたため削除できませんでした。再読み込みしてください」で選択を残し、再読み込みが終わったら選択に残る読み込み済みの行の version を控え直す（もう一度押せば新しい version で送る。衝突の後だけで、他人の変更が画面に届いただけのときは控えを変えない。窓の外の行は控えのまま）、受け付けられなかった（`bad_request`）ときはサーバーの文を出さず「削除の要求が受け付けられませんでした。選び直してください」だけ、上限（1,000 件）超えは確認を出さずに「一度に削除できるのは1,000件までです。絞り込んでください」。送る `version` は**行を選んだ時点**で控える（`onSelectionChange`。server モードで読み込みの窓から外れた行も、版つきで送る。自分のセル編集で進んだ版は追う。控えられなかった行があれば送らない）。server モードは grid の `selectAllMatching` を付け、「該当する全件」のときは確認の前に一覧の条件（グリッドの絞り込み・並び・画面の検索語）で `getList` をページングして id と `version` を集め、集めた件数を確認に出して、その id で消す。確認の前にセッション（`currentSessionScope`）を控え、送る直前に比べて、替わっていれば（画面が破棄されていても）送らない。検索語か読み込みモードが変わったら選択を空にする。判断は `lib/resource/bulkDelete.ts` の純関数（`bulkDeleteOffered`・`updateVersionCapture`・`collectMatchingItems`・`captureSendGuard`・`bulkDeleteFailureOf`・流れ全体の `runBulkDelete`）。`ResourceClientGrid` / `ResourceServerGrid` が `selectable`・`selectedRowIds`（bindable）・`onSelectionChange`・`bulkActions`（server は `selectAllMatching` も）を BantoGrid へ通す。messages は `resource.bulkDelete*` の 10 キー。`@banto/admin-core` の InMemory の provider に `deleteMany` を実装（#753 と同じ契約: id だけ・全件成功か全件失敗か・`version` の照合・0 件と重複と 1,000 件超えは `bad_request`・行が無いときは `current` の無い `conflict`）。デモでも一括削除が動く。e2e（demo）を追加、smoke の e2e の Tab の並びをチェックボックスの列に合わせた（visual の基準画像が変わる: items の一覧にチェックボックスの列）。
- items の一括削除の API（#713。UI の配線は別の PR）。`@banto/admin-core` の `DataProvider` に省略可能なメソッド `deleteMany?(resource, target, options?)` を追加（型 `DeleteManyTarget` / `DeleteManyItem` / `DeleteManyResult` / `DeleteManyOptions`）。`target` は `{ kind: 'ids', items: [{ id, version? }] }`、戻り値は `{ deleted }`（絞り込んだ全件を消すときは、利用側が `getList` で id と `version` を取ってから id で消す。条件と件数だけで消す方式は、確認の後に行が入れ替わっても件数が同じなら通ってしまうので持たない）。http の provider は `POST /api/{resource}/bulk-delete`、tauri の provider は `${resource}_bulk_delete`（引数 `target`）を呼ぶ。InMemory の provider も同じ契約で持つ（上の項目）。HTTP と Tauri の provider はどのリソースにも `deleteMany` を返すので、呼ぶ側は `provider.deleteMany` の有無に加えて、リソースの対応を明示して判定する（テンプレートはリソース定義の `bulkDelete: true`）。テンプレートは items に両経路を実装（`POST /api/items/bulk-delete` と `items_bulk_delete`、どちらも editor 以上）。1 つのトランザクションで全件成功か全件失敗: 1 件でも `version` が違う・既に無いと、何も消さずに 409 `conflict`（`current` は食い違った行）。上限は 1 回 1,000 件（`MAX_BULK_DELETE_ROWS`）で、超過・0 件・id の重複は 400 `bad_request`。監査は 1 回の一括削除につき 1 行（`action: "bulk_delete"`、detail は `mode`・`count`・`ids`（先頭 100 件、超えたら `idsTruncated`））。衝突は監査しない（1 件の削除と同じ）。`resource_changed` は 1 回。添付は消した行の分をまとめて掃除する。消費側への注意: `DataProvider` を自前で実装・ラップしている利用側は、型エラーにはならないが、メソッドを足す・転送するまで `deleteMany` は `undefined` のまま。`pnpm scaffold` の attachments・items の除去は新しいコードに追随済み。手順は docs/recipes/add-resource.md「一括削除」。
- `@banto/grid-svelte` の行選択に、server モードの「該当する全件を選択」（#713）。**opt-in**: `selectAllMatching`（既定 false）を付けたグリッドだけに出る（付けないと、ボタンは出ず `allMatchingSelected` も常に false で、一括処理が `ids` しか見ない既存の画面と食い違わない）。付けたら、全件モードの処理は `ids` ではなく条件で行う責任を利用側が持つ。`canSelectAllMatching` の入力に `enabled` が増える。読み込み済みの行がすべて選ばれていて `totalRows` がその数より多いとき、一括操作バーに「該当する全 M 件を選択」のボタンが出る。押すと全件モードに入り、バーは「該当する全 M 件を選択中」になり、読み込み済みの行とあとから読み込まれた行をすべて選択済みとして描く。`bulkActions` の snippet は `{ ids, clear }` に加えて `allMatching`・`matchingCount`（server モードでは `totalRows`）を受け取り、`allMatchingSelected`（bindable。読むためのもの）でも分かる。全件モードの `ids` / `selectedRowIds` は入ったときの読み込み済みの id のままなので、一括処理は絞り込みの条件（`GridState.filters` と、利用側がグリッドの外で持つ検索語）で行う。全件モードは、行やヘッダーのチェックボックスを外す・グリッドの絞り込みが変わる・`clear()`・利用側が `allMatchingSelected = false` にする（`selectable` が外れる・client モードになるときも）で抜け、選択は空になる。利用側が `selectedRowIds` を書き換えたときは全件モードだけを抜け、書いた値はそのまま残る（「全件から数件を外す」は無い）。`onSelectionChange` は全件モードに入ったときにも呼ばれる（`ids` は同じ）。判定は `core/rowSelection.ts` の純関数（`canSelectAllMatching` / `sameRowIds` / `allMatchingVerdict`）。読み上げは、入ったときに「該当する全M件を選択中」、抜けたときに残った件数（空なら「選択なし」）。client モードは変わらない。テンプレートは `messages/{en,ja}.json` と `gridMessages()` に文言を足しただけで、`ResourceListPage` にはまだ配線していない。消費側への注意: `GridMessages` に `selectAllMatching(count)`・`allMatchingStatus(count)` が増える（`Required<GridMessages>` で全キーを埋めている利用側は型エラーになるので 2 つ足す。`Partial` で渡している利用側は日本語の既定になる）。`GridBulkActionsContext` に必須のフィールド `allMatching`・`matchingCount` が増える（この型の値を自分で組み立てているテストなどは要対応）。一括操作バーの要素が `tabindex="-1"` を持つ（ボタンが消えたときのフォーカスの受け皿）。
- `@banto/grid-svelte` の `ColumnsMenu` に、列ごとの「左端に固定 / 固定を解除」の切り替え（#713）。各行の右のピンのボタンが `GridState.toggleColumnPinned` を呼ぶ。状態は `aria-pressed`、名前は固定中も同じ（`messages.pinColumn(header)`、既定「〇〇を左端に固定」）、ツールチップは固定中だけ `messages.unpinColumn(header)`（既定「〇〇の固定を解除」）。メニューは固定した列を先頭に並べるので、切り替えた行は動く（フォーカスは押したボタンに残す）。`GridState` と `BantoGrid` は変えていない。消費側への注意: `GridMessages` にキー `pinColumn`・`unpinColumn` が増えた（`Required<GridMessages>` を使う利用側は型エラー。`Partial` で渡している利用側は既定の日本語が出る）。`ColumnsMenu` を使っている画面には、何もしなくてもピンのボタンが出る（メニューの幅が 1 ボタン分広がる）。
- テンプレートの一覧の列メニューに「左端に固定」を追加し、自分の保存ビューが固定した列を覚えるようにした（#713）。列メニューは 2 つのグループ（「表示する列」・「左端に固定」）になり、どちらも `menuitemcheckbox`（選んでも閉じない）。保存ビュー（`listViews.ts` の `ListViewContent` / `SavedListView`）に省略可能な `pinned?: string[]` を足した。ビューを適用すると固定も置き換わる。`pinned` の無いビュー（これまでに保存したビューと、定義の `list.views`）は、列の定義の `pinned` に戻す（新しい `definitionPinned(columns)`。`viewForFields` に第 3 引数 `defaultPinned` を足した）。保存した値の版（`version: 1`）は変えていない。セッション内の復元（sessionStorage の並び順・絞り込み）は、列の表示と同じく固定を含まない。**派生アプリへの注意**: `ResourceListPage.svelte`・`listViews.ts`・`resource/types.ts`（コメントのみ）・`banto/i18n.ts` の差分を取り込む。辞書キーを 4 つ追加（`grid.pinColumn`・`grid.unpinColumn`・`resource.columnsShowGroup`・`resource.columnsPinGroup`）し、`resource.viewSaveHint` の文言を変えた（「列の固定」も保存すると書いた）。列メニューの項目を `menuitemcheckbox` で数えている E2E は、グループで絞る（`e2e/visual/columns-checkbox.spec.ts` を合わせた）。
- `@banto/forms` のフォームの配置（#714 C-2 の 1 つ目の PR。すべて省略可能で、今の 1 列の定義はそのまま動く）。(1) セクション見出し: `FormSchema.sections`（`{ id, title, description?, columns? }`）と `FieldDef.section`（セクションの id）。`fields` は平らなままなので、store・検証・グリッド列の読み方は変わらない。描画はセクションを持たない欄が先、その後 `sections` の順で、見出しは `fieldset` + `legend`（説明は `aria-describedby`）。知らない id の欄はセクション無し扱い。全欄が隠れたセクションは見出しごと消える。(2) 列: `FormSchema.columns` と `FormSection.columns`（1〜3。セクション > フォーム > 1）、`FieldDef.fullWidth`（1 行を使う）。フォーム自身の幅に対する container query で、36rem 未満は 1 列、36rem 以上で 2 列、54rem 以上で 3 列。DOM の順がそのまま読み上げとタブの順。(3) `FieldDef.visibleWhen?: (values) => boolean`: 隠れた欄は描画せず、検証（`required` 含む）から外し、送信の値から除く。`BantoForm` の `onSubmit` には新しい `FormStore.submitValues`（隠れた欄のキーだけを除く。欄に無いキーは残す）が渡る。入力済みの値は消さずに残す（再び出れば戻る。`isDirty`・ドラフトの比較は値全体のまま）。隠れた欄のエラーは消える。フォーカスが隠れた欄にあったときは、画面の表示順（セクションを含む）で直前の見える欄、なければ後ろの欄へ移し、disabled などでフォーカスできない欄は飛ばす（どれも無ければ送信ボタン）。`validateAll`・`FormDraft.commitAll` は隠れた欄を飛ばし、`draftSourceFrom` の `apply` に渡る値（`FormDraftSnapshot.submitValues`）も隠れた欄のキーを除く（`values`・`raw`・baseline は全体のまま）。表示の条件が循環して隠す欄が定まらないときは、`commitAll` は何も確定せずに false を返し、その欄に新しいメッセージ `ValidationMessages.visibilityUnsettled` を付ける。(4) `FieldDef.help?: string`: 欄の下に出し、入力欄の `aria-describedby` で指す（エラーもあるときは「ヘルプ エラー」の順で両方）。判定は Svelte の外の純関数（`layout.ts`: `isFieldVisible` / `hiddenFieldNames` / `submitValuesOf` / `resolveColumns` / `layoutOf` / `focusCandidateNames`、`index.ts` から export）。`FieldType` の種類は増やしていない。ResourcePage のフォーム（`ResourceDetail` は定義の `schema` を `BantoForm` に渡す）はそのまま使える。ui-demo に BantoForm のカードを追加（visual の基準画像が変わる）、e2e（demo）を追加。消費側への注意: `ValidationMessages` に `visibilityUnsettled` を足した（`Required<ValidationMessages>` で型エラー）。`onSubmit` に渡る値は、`visibleWhen` を使う欄があるときだけ `store.values` と異なる（隠れた欄のキーが無い）。更新で隠れた欄の値を消したい場合は、`DataProvider` 側が「送られなかったキー」をどう扱うかを確かめる。
- `@banto/forms` の欄の型の追加（#714 C-2 の 2 つ目の PR）。(1) `FieldType` に `'radio'` と `'multiselect'`。`radio` は `options` から作る単一選択で、値は select と同じ（未選択は `''`）。`fieldset`（`role="radiogroup"`）+ `legend` の中にネイティブの radio を並べるので、矢印キーの移動はブラウザに任せる。`FieldDef.variant: 'segmented'` を付けると、同じ radio をボタンの並びとして描く（入力は不可視のまま同じ位置に残り、フォーカスと読み上げの名前を担う。選んだ区画は塗りだけでなく太字とチェックの印でも示す）。segmented を別の型にしなかったのは、公開の union に足す種類を増やさず、値・検証・グリッドの扱いを radio と共有できるため。`multiselect` は checkbox の群で、値は `options` の順の配列（空は `[]`）、`required` は「1 つ以上」。(2) `FieldDef.prefix?` / `suffix?`: number の入力の前後に出す文字（`kg`・`¥` など）。表示だけで値は数値のまま。`aria-hidden` にして label の名前に混ぜず、入力欄の `aria-describedby`（単位、ヘルプ、エラーの順）で読み上げる。(3) 群の型は自分で `fieldset` + `legend` を描くので、`BantoForm` は label を足さない（`appearance="underline"` でも枠型の見た目）。`id`（フォーカスの退避先）は最初の入力に付き、`aria-describedby` と `aria-invalid`（radio）は fieldset に付く。新しいコンポーネント `RadioField`・`MultiselectField` を export。`FormStore` / `FormDraft` の既定値は multiselect が `[]`、`validateField` は空の配列を空と見なす。`FormDraft` は radio を select と同じに解釈する（配列は `setValue` で直接）。options に無い値を弾かないのは select と同じ。(4) `@banto/grid-svelte`: `SchemaFieldType` に同じ 2 種類を足した。`columnsFromSchema` は radio を select と同じ（ラベル表示・select のセルエディタ）、multiselect を表示専用（ラベルを「、」でつないだ文字列）にする。ui-demo に BantoForm の選択肢のカードを追加（visual の基準画像が変わる）、e2e（demo）を追加。消費側への注意: `FieldType` の union が広がったので、`FieldType` を網羅 switch している利用側は型エラーになる（`radio` / `multiselect` の分岐を足す）。`SchemaFieldType`（`columnsFromSchema` が受ける構造的な写し）も同様。`FieldDef` に `variant`・`prefix`・`suffix` が増える（省略可能）。値が配列になる欄が生まれるので、`store.values` や `onSubmit` の値を欄の型で決め打ちしている箇所は確かめる。
- `@banto/forms` の参照選択の欄（#714 C-2 の 3 つ目の PR）。**`DataProvider` の契約は広げない**: 検索は欄の定義に渡す。(1) `FieldType` に `'reference'`。`FieldDef.search?(query, signal)`（打った文字の候補。`''` は最初の数件）と `FieldDef.resolve?(value, signal)`（保存された値の表示名。無ければ `null`）、型 `ReferenceOption`（`{ value: string | number; label; description? }`）を追加。store に入るのは値（id）だけで、型を保つ（`2` と `'2'` は別のもの）。未選択は `null`、`required` は「値があること」。(2) 新しいコンポーネント `ReferenceField`: WAI-ARIA APG の combobox + listbox（`aria-autocomplete="list"`・`aria-expanded`・`aria-controls`・`aria-activedescendant`、候補は `role="option"` + `aria-selected`）。フォーカスは入力欄に残り、一覧は何もフォーカスを取らないので、ポインタで押しても blur せずに選べる。↑↓ で移り（端で止まる）、Enter で決め、Tab は決めずに出る。Esc は開いた一覧を閉じ、もう一度押すと入力を今の値の表示名に戻す。一覧が開いている間の Enter はフォームを送信しない。値が変わるのは、候補から選んだときと、入力を消して欄を出たとき（`null`）だけで、打った文字だけでは変わらない。(3) 非同期: 入力は `REFERENCE_SEARCH_DEBOUNCE_MS`（250ms、export。`ReferenceField` の `debounceMs` で変えられる）だけ待つ。前の検索は `signal` を abort し、`signal` を見ない `search` の古い応答も捨てる（パッケージ内の request owner を使う）。検索中・0 件・失敗は一覧の中と `role="status"` で伝え、文言は `BantoForm` の新しい prop `referenceMessages`（型 `ReferenceFieldMessages`、`searchFailed(error)` は reject の値を受け取る）で差し替える。初期値・外から変わった値は `resolve` で表示名を引き、引けないときは値をそのまま出す。(4) 一覧は `popover="manual"` で最前面に出し、入力欄に付いて動く（位置決めは forms の中に持つ。`@banto/ui` は import しない）。`data-esc-layer` を持ち Esc を消費するので、外側のドロワーは閉じない。(5) `FormStore` / `FormDraft` の既定値は `null`。`FormDraft` は参照の raw の文字を値として解釈しない（空白だけなら `null`、それ以外は値を変えない）。(6) `@banto/grid-svelte`: `SchemaFieldType` に `'reference'`。`columnsFromSchema` は表示専用にして値（id）をそのまま出す（`resolve` は非同期なのでセルからは呼べない。名前は `overrides[name].format` で渡す）。(7) テンプレート: `src/lib/banto/reference.ts` の `referenceFrom(provider, resource, { labelOf, idOf?, descriptionOf?, limit?, sort?, filters? })` が `DataProvider` から `{ search, resolve }` を作る（`search` は `getList` のクイック検索 `ListParams.search`、`resolve` は `getOne`、無いレコードは `null`。パレットのレコード検索でも使える形）。`i18n.ts` に `referenceFieldMessages()`、辞書に `reference.*`（6 キー）と `uiDemo.reference.*`（4 キー）を追加し、`ResourceDetail` が `referenceMessages` を渡す。ui-demo に参照選択のカードを追加（visual の基準画像が変わる）、e2e（demo）を追加。消費側への注意: `FieldType` の union が広がったので、`FieldType` を網羅 switch している利用側は型エラーになる（`reference` の分岐を足す）。`SchemaFieldType` も同様。`FieldDef` に `search`・`resolve` が増える（省略可能）。値が `null` や数値になる欄が生まれるので、`store.values` や `onSubmit` の値を文字列と決め打ちしている箇所は確かめる。派生アプリは `messages/*.json`・`i18n.ts`・`ResourceDetail.svelte` の差分を取り込み、`reference.ts` を足すこと。

### Fixed

- `@banto/dock-svelte`: 据え置き（`persistent`）の pane を組み替える（`float` / `dockBack` / `move` のタブ化 / `resetLayout` など）と、中でフォーカス中の入力欄に `blur` → `focusout` → `focus` → `focusin` が出て、blur で確定するフォームが誤って確定されていたのを直した（#763）。Svelte が古い受け皿を文書から外すのが、中身を移す teardown より先だったため。`Element.moveBefore()` のある環境（Chromium 133 以降）では、木を更新する直前（`snapshot()`）にフォーカスのある中身を host の中の待避場所へ `moveBefore` で移し、新しい受け皿へも `moveBefore` で移すので、フォーカス・選択が残り blur は出ない。待避するのは受け皿が作り直されうる更新（木の構造・開閉・畳み・選択中のタブの変化）だけで、別の浮動 window の移動・リサイズや分割の境界のドラッグでは編集中の pane を動かさない。`iframe` が読み直されないのは実際に `moveBefore` で移せた移動（＝フォーカスのある pane）に限る（それ以外の pane は今までどおり `appendChild` で、読み直される）。`moveBefore` の無い環境は今までどおり（`appendChild`、blur のあとフォーカスを戻す）で、その blur を見分ける関数 `isDockRearranging(node)` を公開 API に追加した（組み替えの直前からフォーカスを戻し終えるまで `true`。Shadow DOM の中の node は host をたどる。`null` / `undefined` は `false`。README「据え置き」）。host の DOM に空の要素 `.persistent-transit` が 1 つ増える（表示は変わらない）。実ブラウザの回帰試験は `e2e/demo/dock-persistent-focus.spec.ts`。

### ドキュメント

- `@banto/grid-svelte` の README に、セルへ小さな折れ線（sparkline）を描く例を追加（#713）。Issue の「sparkline は snippet の見本で済ませるか別に決める」への答え: **組み込みの `renderer` にはせず、列の `render`（snippet）から `@banto/charts` の `Sparkline` を描く見本で示す**（grid-svelte を charts に依存させないため。conventions §4）。コードの変更は無い。
- 保守者向けの手引き `docs/maintainers.md` を追加（PR・レビュー・CI・リリース・委譲の運用、dock-svelte と楽観ロックで決まっていること、教訓。AGENTS.md から案内）。`docs/publishing.md` に切り出し前の確認（公開 API の削除の見方）を、`docs/design/visual-refresh-design.md` に #557 の運用上の取り決めを足した。見送り項目の追跡は #756、実機で未検証の項目の追跡は #757。コードの変更なし。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `9caa238c`、`workflow_dispatch`）: [run 44817789378](https://github.com/tyaro/banto/actions/runs/44817789378)（success）。
  - タグの push（`v7.10.0`、main の `9caa238c`）: [run 44818061626](https://github.com/tyaro/banto/actions/runs/44818061626)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。

    | 項目               | 版                              |
    | ------------------ | ------------------------------- |
    | Node.js            | 24.22.3                         |
    | pnpm               | 10.33.0                         |
    | Svelte             | 5.57.3                          |
    | SvelteKit          | 3.2.0                           |
    | Vite               | 8.3.8                           |
    | vite-plugin-svelte | 7.3.1                           |
    | TypeScript         | 6.0.3                           |
    | Rust               | 1.100.0（0ef1bc386 2026-11-09） |

  - 出所: Node.js は `node: v24.22.3`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、Rust は `Setup Rust toolchain` の `rustc 1.100.0`。

## [7.9.0] - 2026-11-20

**v7.9.0 — `@banto/dock-svelte` の dock の拡張（`ThreePaneDock`・据え置き pane・キーボード移動・隠した pane の元の位置の復元。#663 段階 ④、#721・#727・#733・#734・#735・#736・#741）とコマンドパレットの非同期の提供元（#711）、テンプレートの dock 配線。** 版の種類: minor（docs/publishing.md「バージョニング規約」の運用上の例外、オーナー判断）。`crates/*/src` の `pub` と `packages/*/src/index.ts` の export の削除・改名は無いが、既存の型を広げた変更（`DockPanelChange` の `remount` の `true` → `boolean`、`DockLayout['version']` の `2` → `2 | 3`）とキーの追加で、既存のコードが型エラーになりうる。実行時の値が変わるのは新しい機能を使ったときだけ（`remount: false` は `persistent` の pane だけ、`version: 3` は 5 段以上の slot を含むレイアウトを保存したときだけ）なので、下の「消費側への注意」に追従の手順を明記して minor とする。migration なし。

消費側への注意（ソース互換・挙動。いずれも下の各項目に詳細）:

- 型: `DockMessages` にキーが増えた（`Required<DockMessages>` を使う利用側は型エラー）。`DockCapabilities` に `collapse` が増えた（`Required<DockCapabilities>` を使う利用側は型エラー）。`DockPanelChange` の `remount` の型が `true` から `boolean` に広がった。`DockLayout['version']` が `2 | 3` になった（`version` で分岐しているコードは 3 の分岐を足す）。
- 保存形式: 5 段以上の slot を含むレイアウトは `version: 3` で保存され、v7.8.0 以前では読めず既定に戻る。浅いレイアウトは今までどおり `version: 2`。
- レイアウトをオブジェクトのまま保存しているアプリは、`dock.layout` ではなく `DockState.savedLayout()` を保存する。保存した値を `DockHost.replaceLayout` で入れるときは `saved: true` を渡す（`serialize()` → `hydrate()` で戻すアプリは変更不要）。
- テンプレート（B）: ダッシュボードの localStorage のキーが利用者ごと（`banto.dock.dashboard:<owner>`）に変わり、古い固定キー `banto.dock.dashboard` は読まずに消される（設定 `UiSettingsProvider` の `dock.dashboard` の保存値はそのまま）。

### Added

- `@banto/dock-svelte` の `DockHost` に `persistent?: (panelId) => boolean`（据え置き、#663 段階 ④ PR-1）。その pane の中身は木の外で 1 回だけ描き、受け皿へ DOM ごと移すので、undock / dock・外周へのドッキング・周りの組み替え・自動で隠す・タブの切替で作り直さない（フォーカスと scroll 位置は移したあとに戻す。`iframe` は読み直される）。`keepMounted` を兼ねる。`DockPanelChange` の `dock` / `undock` / `move-docked` / `auto-hide` / `reparent` の `remount` の型を `true` から `boolean` に広げた（`persistent` の pane は `false`）。
- `@banto/dock-svelte`: キーボードだけでパネルを動かせるように（#663 段階 ④ PR-2）。タイトルバーの「パネルの操作」メニュー（外周・タブ・隣へ分割・浮かせる・元の場所へ）と `DockHost.movePanel`、結果の `aria-live` の読み上げ。ドラッグと同じ capabilities・`dropCenter`/`dropSplit`・`beforePanelChange` を通り、承認待ちの間に移動できなくなったら適用しない。`DockMessages` にキーを追加（`Required<DockMessages>` を使う利用側は型エラー）。同じ split から続けて隠した・浮かせた pane は、どの順で戻しても元の並びに戻る（`DockSlot` の split に任意の `otherAnchors` を追加）。
- `@banto/dock-svelte` に 3 ペインを dock に並べる部品 `ThreePaneDock`（#663 段階 ④ PR-3）。中央（`children`）は据え置きのメイン区画（閉じない・畳まない・自動で隠さない・浮かせない）、`leftOpen`/`rightOpen` は「表示」メニューのチェックと同じ状態、操作の口（`setVisible`・`toggle`・`float`・`dockBack`・`move`・`resetLayout`・`restoreLayout`・`layoutSnapshot`・`viewMenuItems`）はすべて `beforePanelChange` を通る。追加パネル（`panels`）。純関数 `threePaneDockLayout`・`reconcileThreePaneLayout`・`threePaneSavedLayout`。保存値の中央がタブの組にいるときは組から抜いて隣に置く（中央だけの組は中央 1 枚に戻す）。`panels` の変更で構造が変わるときも `beforePanelChange` を通す。承認待ちの `panels` の変更・`leftOpen`/`rightOpen`・`setVisible` は、最新の要求と違えば（今の配置のままでよい要求も含めて）適用の直前に `stale` になる。`DockHost` に `replaceLayout`（行き先のレイアウトが違う置き換えは別々に聞く。置き換え先から消える据え置きの pane は既存の `close` で聞く）・`canMovePanel`、`replaceLayout`・`setPanelVisible` に任意の `isCurrent`（適用の直前に読み直し、`false` なら `stale`）、`DockCapabilities` に `collapse` を追加（`Required<DockCapabilities>` を使う利用側は型エラー）。アプリへの配線はまだ無い。
- `@banto/admin-core`: コマンドパレットに「入力から候補を非同期に返す提供元」の口（#711、洗練案 B-5）。型 `PaletteSource`（`id`・`group`・`visible`・`search(query, signal)`）と、入力の間引き（既定 200ms）・提供元ごとの件数の上限（既定 5）・古い要求の中断と結果の破棄（`createRequestOwner`）・提供元ごとの状態（`pending` / `ready` / `error`）を持つ `createPaletteSourceSearch`。遅い・失敗した提供元は自分の組にだけ印を出し、ほかの候補は待たせない。`@banto/ui` の `CommandPalette` に `onQueryChange`（任意）を追加。同じ検索語のまま候補が増減しても選択は維持し（消えたときだけ先頭の有効項目へ）、検索語が変わったときだけ先頭に戻す。
- テンプレート（B. コピーしたテンプレート）: コマンドパレットでレコードを探して開ける（#711）。リソースごとに「一覧の絞り込み検索（`getList` の `search`）」の提供元を自動で作り（`lib/recordSearch.ts`）、選ぶと一覧の右ドロワー（`?id=`）で詳細を開く。空入力では利用者ごとの「最近開いたレコード」（`lib/resource/recentRecords.ts`、10 件）を出す。`capabilities.list` のあるリソースで、ナビ（`navSections()`）に出る利用者にだけ出す（LAN の閲覧公開セッションも同じ）。レコードの表示名は `AppResourceDefinition.recordTitle`（省略時は `name`・`title`・`label`、なければ `#id`）。ヘッダーの検索欄の全体検索は対象外。scaffold のコマンドパレットの削除に `recordSearch.ts` とテストを足した。
- `@banto/dock-svelte` の `ThreePaneDock` に狭い表示と組み替え不可（#663 段階 ④ PR-4）。幅が `narrowBreakpoint`（既定 900）以下か `narrowOverride` のとき、保存済みの配置に触れずに一時のレイアウト（中央だけ・見えていた左右は端の帯・ほかは隠す。純関数 `threePaneNarrowLayout`）で表示し、幅が戻れば元に戻す。狭い表示のあいだの操作は保存せず、`layoutSnapshot()` は控えた配置を返す（保存は `dock.serialize()` でなく `layoutSnapshot()` で）。切り替えは `beforePanelChange` を通り、中央は作り直さない。出力 `narrow`。`arrange={false}`（キオスク）で、`setVisible`・`toggle`・`leftOpen`/`rightOpen` の書き込み・`float`・`dockBack`・`move`・`resetLayout` を拒否し、`viewMenuItems` は空。`DockHost` に `arrange`（`false` で全 capability を `false` 扱い、分割線・浮動 window の移動とリサイズ・折りたたみ・ロック・ピンで戻すを止める。実行中に切ると承認待ちの変更は `stale`）、`PanelLifecycle.invalidatePending`。touch 密度で dock のドロップのガイドのボタンを大きく: `@banto/theme` の touch 密度に `--banto-dock-guide-button-size`、`readGuideSizing`、`guideButtonSize` に任意の最小値、`edgeButtons` に任意の大きさ、`CrossOptions` に `size`/`min`。アプリへの配線はまだ無い。
- テンプレート（B. コピーしたテンプレート）: 3 ペインの画面を dock に載せた見本 `/tree/workspace-dock`（#663 段階 ④ PR-6）。`/tree/workspace` の部品（`Workspace*.svelte`）をそのまま `ThreePaneDock` に載せ、左右のペインの切り離し・ドッキング・タブ化、中央（作業タブ）は組み替えで作り直さない。「表示」メニュー（`viewMenuItems()`、既定へ戻す）とツールバーのボタン（`toggle`・`float`・`dockBack`、押された状態は `leftOpen`/`rightOpen`）、レイアウトは利用者・画面ごとに保存（`layoutSnapshot()` を `dockLayoutStore` に渡す。`threePaneLayoutTarget.ts` が橋渡し）、900px 以下は狭い表示、kiosk は `arrange={false}`。未保存の設定の確認は `/tree/workspace` と同じで、パネルの操作では出ない。`/tree` の索引にリンクカード、文言キー `tree.workspaceDock.*`、e2e（`e2e/visual/three-pane-workspace-dock.spec.ts`）と visual の spec。scaffold の dock の削除にこのルート・リンクカード・文言キーを足した。基準画像は `visual-baselines.yml` の dispatch で生成する。
- ドキュメント: 3 ペインを dock に並べるレシピ `docs/recipes/three-pane-dock.md`（#663 段階 ④ PR-7）。`ThreePaneLayout` との使い分け、`leftOpen`/`rightOpen`・「表示」メニュー・`resetLayout`、レイアウトの保存（`layoutSnapshot()` を `dockLayoutStore` へ）、狭い表示・`arrange={false}`・touch、中央の据え置き（`iframe` は読み直す）、キーボード移動、scaffold での外し方。README の recipe 索引と `three-pane-screen.md` から辿れる。設計書 `three-pane-dock-plan.md` は「完了」（PR-8 は作らない）

### Changed

- テンプレート（B. コピーしたテンプレート）: ダッシュボードのレイアウトの保存を `src/lib/banto/dockLayoutStore.svelte.ts` に出し、保存値を利用者とセッションに結び付けた（#663 段階 ④ PR-5、three-pane-dock-plan §4.4）。localStorage の写しは確定した利用者のキー `banto.dock.dashboard:<owner>`（`account:<id>`・`local`・`publicViewer` など）でだけ読み書きし、利用者が確定していなければ使わない。古い固定キー `banto.dock.dashboard` は読まずに消す。設定（`UiSettingsProvider` の `dock.dashboard`）の読み込み結果・debounce 中の書き込み・unmount の flush は、取得した時点のセッション（`currentSessionScope()`）が替わっていれば捨てる。設定が空・エラー・壊れた値のときは写しではなく既定の配置に戻す（以前は写しを残した）。既定の配置・読み込んだ配置は設定へ書き戻さない。scaffold の dock の削除にこのファイルとテストを足した。

### Fixed

- テンプレート（B. コピーしたテンプレート）: dock 自身の文言（タイトルバーのボタン・「パネルの操作」メニュー・読み上げ）が en ロケールでも日本語のままだったのを、paraglide に配線した（#729）。`lib/banto/dockMessages.ts`（`DockMessages` の全キーを `dock.*` から作る関数。ページ固有のキーは引数で足す）を `/dashboard` と `/tree/workspace-dock` の両方で使う。ja の文言は `defaultDockMessages` と同一（見た目は変わらない）。scaffold の dock の削除に `dockMessages.ts`・テスト・`dock.*` キーを足した。
- テンプレート（B. コピーしたテンプレート）: ツリーの件数バッジの文字色を、浮動ウィンドウの中でも 4.5:1 を満たすトークンに替えた（#730）。
- `@banto/dock-svelte`: 木の外にある（浮かせた・隠した）パネルを、今の配置から作った置き換えが無くすと、残る隠れたパネルの `share` にその分が残り、戻したときの比率がずれた（#741。`row[extra .2, right .3, center .5]` で `extra` を浮かせ、`right` を隠し、`ThreePaneDock` の `panels` から `extra` を外して `right` を戻すと 0.3 / 0.7。正しくは 0.375 / 0.625）。`ThreePaneDock` の `panels` の変更と、`saved` を付けない `DockHost.replaceLayout` は、`dock.layout = ...` と同じ経路で入れる（控えは残し、無くなったパネルの分を除く）。**挙動の変更**: `reconcileThreePaneLayout` は、隠れているパネルを知らない id として捨てるとき、残る隠れたパネルの `share` からその分を除いて返す（`initialLayout` / `restoreLayout` / 狭い表示の間に控えた配置に効く）。`ThreePaneDock` は、使い回した `DockState` に `initialLayout` を入れるとき、また狭い表示から広い表示へ戻すとき、浮かせたパネルの「元の場所」の控えを捨てる（保存値を入れるのと同じ扱い）。浮かせたパネルを元の split の別の位置へドッキングし直す場合は、隠れたパネルが split 全体に対する自分の割合で戻る今の動きを仕様としてテストで固定した（コードの変更なし）。
- `@banto/dock-svelte`: 同じ split から何枚か隠して（浮かせて）戻すと、戻す順しだいで split の大きさが元に戻らなかった（#733。`row[a,b,c]` を 1/3 ずつで `a`・`b` を隠し、`a` → `b` の順に戻すと 0.17 / 0.50 / 0.33）。split の slot に任意の `share`（隠したパネルも数えた split 全体の中での割合、0 より大きく 1 以下）を足して覚え、戻すときはまだ外にあるパネルの割合を空けて配分する。`size` の意味（取った時点の split の中の割合）と `version` の規則は変えない。`share` の無い slot（このリリースより前に保存したもの、またはそれと同じ split に数えられるもの）は今までどおり `size` で戻すので、古い JSON で戻った手順はそのまま戻る。前のリリースは `share` を読み飛ばして `size` で戻す。浮かせたパネルの元の場所（`homeSlot`）は保存しないので、`serialize()` はそれを数えない `share` に直して書く（メモリ上の layout はそのまま）。隠した（浮かせた）パネルが元の場所を覚えていなくなったとき、元の入れ物（または空の木）に戻ったのでなければ（`open` / `toggle` で浮動のまま開いた、別のパネルのタブへドッキングした、自動で隠す帯へ移った、消えた、`layout = ...` で `dockSlot` を外した など、経路によらず）、そのパネルの割合を数えない `share` に、残る閉じた窓と浮かせたままのパネルの slot を直す（戻す順によらず同じ大きさになる。`hydrate` / `reset` / `DockHost.replaceLayout` など layout を丸ごと置き換える経路は、受け取った slot をそのまま使う）。同じ値をオブジェクトで返す `DockState.savedLayout()` を追加し、`ThreePaneDock` の `layoutSnapshot()` もこれを使う。layout をオブジェクトのまま保存しているアプリは `dock.layout` ではなく `savedLayout()` を保存する。保存した値を `DockHost.replaceLayout` で入れるときは新しいオプション `saved: true` を渡す（浮かせたパネルの「元の場所に戻す」の控えを、入れるのと同時に捨てる。`ThreePaneDock` の `restoreLayout` / `resetLayout` はこれを使う）。`DockState` に `restoredAt(id, slot)`（その場所に戻した木を返すだけの純粋な問い合わせ）、`restoreDockSlot` に任意の第 5 引数 `hidden` を追加。
- `@banto/dock-svelte`: `validateDockLayout` が、中身の矛盾した slot（`anchors` の重複・自分の id が `anchors` / `neighborId` / `otherAnchors` に混じる・tab slot の `index` が `anchors` の数を超える。入れ子の `outer` の中も）を通していた（#736）。レイアウトは拒まず、その slot だけを捨てて「元の場所を覚えていない」として読む（浮動 window は `dockSlot` なしで浮動のまま、端の帯の `slot` は `root` になる）。版の規則は変えない。README の `dockSlot` の段落に「slot は 4 段まで」を添えた。
- `@banto/dock-svelte`: タブの組・split のパネルを全部外す（隠す・浮かせる）と、戻す順しだいで元の位置に戻れなかった（#721）。最後の 1 枚は先に外したパネルの slot から入れ物を組み立て直して覚え、入れ物とその隣がすべて木に無いときは入れ物自体の場所に戻す。保存形式は `DockSlot` の tab / split に任意の `outer`（split か root の slot）を足しただけで `version` は 2 のまま、`outer` の無い古い JSON は従来どおり読める。
- `@banto/dock-svelte`: 入れ子の split で、隠す・戻す順によっては全部戻しても元の木の形に戻らなかった（#727・#721 の残り）。内側のパネルを外側の兄弟より先に隠す（`column[row[a,b], c]` で `a` → `c`）、全部隠す、外側の兄弟が 2 枚（`column[row[a,b], c, d]`）の場合。戻すときは目印のパネルだけでなく、同じ側のパネルだけでできた入れ物ごと包む。隠すときは、消えた入れ物に属する隠れたパネルも目印に数え、`outer` を入れ子にして外側の入れ物の場所も覚える（slot 自身を含めて最大 8 段。`DockSlot` の形は変えず、古い JSON は従来どおり読める）。5 段以上の slot を含むレイアウトは `version: 3` で保存し、それより前の版では読めない（その利用者のレイアウトは既定に戻る）。浅いレイアウトは今までどおり `version: 2` で、`version: 2` の JSON の slot は今までどおり 4 段まで受ける。型の注意: `DockLayout['version']` は `2 | 3` になったので、`version` で分岐しているコードは 3 の分岐を足す。
- `@banto/dock-svelte`: 同じ入れ物から浮かせたパネルと隠したパネルが混ざると、戻す順しだいで元の位置に戻れなかった（#734）。また、API（`DockState.dockPanel` など）で直接ドッキングしてから外すと、「元の場所に戻す」が前の場所を指すことがあった（#735）。浮かせたパネルの元の場所を `DragController` から `DockState` に移し（新しい `DockState.homeSlot(id)`。保存はしない）、隠すときも浮かせるときも、隠したパネルと浮かせたパネルの両方を数える。元の場所は、どの経路でもパネルが浮動ウィンドウでなくなった時点で忘れる。挙動の変更: `DockState.undockPanel` を直接呼んで浮かせたパネルにも、メニューの「元の場所に戻す」（`movePanel(id, { back: true })`）が出る。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `c017882a`、`workflow_dispatch`）: [run 44610524176](https://github.com/tyaro/banto/actions/runs/44610524176)（success）。
  - タグの push（`v7.9.0`、main の `c017882a`）: [run 44610943716](https://github.com/tyaro/banto/actions/runs/44610943716)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。

    | 項目               | 版                              |
    | ------------------ | ------------------------------- |
    | Node.js            | 24.22.2                         |
    | pnpm               | 10.33.0                         |
    | Svelte             | 5.57.3                          |
    | SvelteKit          | 3.2.0                           |
    | Vite               | 8.3.8                           |
    | vite-plugin-svelte | 7.3.1                           |
    | TypeScript         | 6.0.3                           |
    | Rust               | 1.100.0（0ef1bc386 2026-11-09） |

  - 出所: Node.js は `node: v24.22.2`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、Rust は `Setup Rust toolchain` の `rustc 1.100.0`。

## [7.8.0] - 2026-11-19

**v7.8.0 — `@banto/admin-core` の UiSettings のプロバイダ（HTTP・Tauri）の書き込みをキーごとに直列化（#707、PR #708）。** 版の種類: minor（後方互換の機能追加）。理由: `TauriUiSettingsOptions` に省略可能な `getSessionRevision` を足した。`crates/*/src` の `pub` の削除と `packages/*/src/index.ts` の export の削除は無い（`v7.7.0` との差分で確認）。migration なし。

派生アプリへの影響: 型エラーにはならない。ただし Tauri の派生アプリは `createTauriUiSettings({ invoke, getSessionRevision: () => authProvider.credentialRevision() })` を渡すこと（渡さないと、利用者の切替をまたいで控えた値が送られうる）。テンプレートの `apps/admin-template/src/lib/banto/setup.ts` を取り込むなら、その変更（`getSessionRevision` の受け渡し）を取り込む（`setup.ts` のみ変更）。

挙動の変更（消費側への注意）: `set` は送信中があれば最後の値だけを後で送り、間の値に置き換えられた `set` は送らずに resolve する。HTTP はトークンが替わった・無い書き込みを送らずに `ProviderError`（kind `unauthorized`）で reject する（従来の 401 と同じ結果）。`get` はそのキーの書き込みが済むまで待つ。

### Fixed

- `@banto/admin-core` の `createHttpUiSettings` / `createTauriUiSettings` の `set` をキーごとに直列化（#707）。送信中の書き込みは 1 本だけにし、送信中に来た値は最後の 1 つだけ控えて送り（間の値は送らない）、`get` はそのキーの書き込みが済むまで待つ。HTTP は、受け付け時と送信直前でトークンが違えば送らずに捨てる。Tauri は `createTauriUiSettings` に `getSessionRevision`（省略可。テンプレートは `authProvider.credentialRevision()` を渡す）を渡すと、セッションが替わったとき控えた書き込みを捨てる。セッションが替わった・トークンが無い書き込みは、送らずに `unauthorized` で reject する（従来の 401 と同じ結果。`createSavedSetting` は保存済みにしない）。派生アプリは `createTauriUiSettings` に `getSessionRevision: () => authProvider.credentialRevision()` を渡すこと。export の削除・改名は無い（型は `TauriUiSettingsOptions` に省略可能な `getSessionRevision` を足しただけ）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `8e76b322`、`workflow_dispatch`）: [run 44446534428](https://github.com/tyaro/banto/actions/runs/44446534428)（success）。
  - タグの push（`v7.8.0`、main の `8e76b322`）: [run 44446751890](https://github.com/tyaro/banto/actions/runs/44446751890)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。ただし Node.js だけは、タグの前の run の `npm`（Git deps → dev + Playwright → check → build）ジョブが 24.22.3、ほかのジョブは 24.22.2（タグの push の run は全ジョブ 24.22.2）。

    | 項目               | 版                                |
    | ------------------ | --------------------------------- |
    | Node.js            | 24.22.2（一部のジョブは 24.22.3） |
    | pnpm               | 10.33.0                           |
    | Svelte             | 5.57.3                            |
    | SvelteKit          | 3.2.0                             |
    | Vite               | 8.3.8                             |
    | vite-plugin-svelte | 7.3.1                             |
    | TypeScript         | 6.0.3                             |
    | Rust               | 1.100.0（0ef1bc386 2026-11-09）   |

  - 出所: Node.js は `node: v24.22.2`（タグの前の run の `npm` ジョブは `node: v24.22.3`）、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、Rust は `Setup Rust toolchain` の `rustc 1.100.0`。

## [7.7.0] - 2026-11-19

**v7.7.0 — `@banto/dock-svelte` のドッキング操作の作り直し（#694: 外周へのドッキング、十字のガイドとボタンの上で離したときだけドッキング、位置固定を錠へ、ピン = 区画を自動で隠す）、ロールとは別にユーザーへ個別に付ける権限（#697: `user_permissions`・migration 0013・管理画面・ログイン不要モードの入口・recipe と ADR-0031）、テーマを試せる `/theme-lab`（#690）、グリッドの行高の密度への追従（#692）。** 版の種類: minor（機能追加と追加の migration。公開 API の削除・改名は無い）。理由: `crates/*/src` の `pub` の削除と `packages/*/src/index.ts` の export の削除は無い（`packages/dock-svelte/src/index.ts` の export は移動しただけで消えていない。`isPinned` / `setPinned` / `FloatingWindow.pinned` / `messages.pinWindow` / `unpinWindow` は非推奨の別名として残り、旧名のまま動く）。公開の型へのフィールド追加（`DockPanelChange` の `auto-hide`、`DockMessages` のキー）はソース互換の破壊になりうるが、規約の運用上の例外（docs/publishing.md「バージョニング規約」）により minor + 消費側への注意とした。migration 0013 は新しい表を足すだけで、既存の列・行を変えない（追加の migration = minor + 適用手順の注意）。
派生アプリへの影響: 依存のタグを `v7.6.0` から `v7.7.0` に上げて型エラーになりうるのは、公開の union に足した種類を網羅検査しているアプリ（`DockPanelChange` の `auto-hide`。分岐を足せば通る）と、`Required<DockMessages>` を自前で全部埋めているアプリ（増えたキーを足す）。下の A. 消費側への注意 1・2。

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v7.6.0` → `v7.7.0`（npm と Rust を同じタグに）。API の削除・改名は無い。追加: dock-svelte（外周ドッキング・十字のガイド・錠・自動で隠す・`DockPanelChange` の `auto-hide`・`DockMessages` のキー）、grid-svelte（行高の追従）、`banto-admin-services`・`banto-server`（権限の型・関数・ガード）。ドラッグの既定の挙動と、ピンの意味が変わる。visual の基準画像の再生成が要る。 |
| B. コピーしたテンプレート        | あり | `/theme-lab` ページ、ユーザー管理の権限の欄、設定 > セキュリティの権限の欄、`authAdmin.ts`・`usersAdmin.ts`、`permission_catalog()`、Tauri の `permissions_catalog` ほか、辞書。取り込みは任意（下の B）。権限を登録しなければ見た目も判定も変わらない。                                                                                                                        |
| C. DB・設定・配布資産            | あり | **migration 0013（`user_permissions` 表、SQLite・PostgreSQL）が増える**。起動時に自動適用。設定キー `auth.disabled_permissions` の追加。応答 JSON に `permissions`・`disabledPermissions` が増える。`tauri.conf.json` は版数のみ。`.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続。                                                                                   |

### A. 共通パッケージ・クレート

- 対象: `@banto/dock-svelte`・`@banto/grid-svelte`・`banto-admin-services`・`banto-server`（ほかのパッケージ・クレートは版数のみ）。
- 更新: `v7.6.0` → `v7.7.0`（npm と Rust を同じタグに）。
- 追加 API（いずれも任意。権限は登録しなければ判定も見た目も変わらない）:
  - dock-svelte: 外周ドッキング（`dockPanelAtEdge` ほか）、十字のガイドとボタン（`crossButtons` ほか）、能力 `dropCenter`・`dropSplit`・`autoHide`、錠（`isLocked` / `setLocked`・`FloatingWindow.locked`）、自動で隠す（`autoHidden`・`autoHidePanel` / `pinPanel` ほか）、`DockPanelChange` の `auto-hide`、文言 `lockWindow` / `unlockWindow` / `autoHidePane` / `pinPane` / `autoHideBand`。
  - grid-svelte: `BantoGrid` の行高がテーマの密度（`--banto-grid-row-height`）に追従する。`GridState.rowHeightFixed`・`followThemeRowHeight(px)`（`rowHeight` は以前から読み取り専用で、getter に変わっただけ）。
  - banto-admin-services: `permissions` モジュール（`PermissionKey`・`PermissionCatalog`・`SessionPermissions` ほか）、`UsersService` と `SettingsService` の権限の関数。banto-server: `PermissionGuard` / `require_permission`、`AuthState::with_permission_reader` ほか。既存の公開の型にフィールドは足していない（構造体リテラルで組み立てているコードもそのままコンパイルできる）。
- 挙動の変化:
  - **ドラッグ**: 区画の上でも**ボタン（十字・外周）の上で離したときだけドッキング**する。ボタンの外で離すと浮動になる（docked の pane は undock。`undock: false` なら何も起きない）。以前は端 25% の帯・中央付近へ落とせばドッキングしたので、その操作はボタンへ落とすように変わる。キーボードだけでドッキングする口は無い。
  - **ピンの意味**: 浮動 window の「位置と大きさの固定」は錠（🔓／🔒）に替わり、ピン（📌）はドッキング中の区画を**自動で隠す**ボタンになった。位置固定の API は `isLocked` / `setLocked` / `locked`。旧名の `isPinned` / `setPinned` / `FloatingWindow.pinned` / `messages.pinWindow` / `unpinWindow` は非推奨の別名で、動く（次の major で消す）。`setPinned` は「位置固定」のままで、自動で隠すものではない。
  - 保存の形: 固定した window は `locked: true` で書き出す（古い JSON の `pinned: true` は `locked: true` として読む）。この版の JSON を古い版で読むと、固定は外れ、隠した区画（`autoHidden`）は消えて読まれる（読み込みは失敗しない。`version` は 2 のまま）。
- 移行注意（ソース互換の破壊）: 公開の型にフィールド・種類を足した。`DockPanelChange` の `auto-hide`、`DockMessages` のキー（下の 1・2）。
- 消費側への注意（確かめるもの）:
  1. **`DockPanelChange` を `switch (change.kind)` で網羅しているアプリ**（`never` への代入など）: `{ kind: 'auto-hide'; panelId; to: 'band' | 'tree'; remount: true }` の分岐を足す（区画の中で中身を描いている pane が、自動で隠す・戻すで作り直されることを表す。`capture` して進めればよい）。
  2. **`Required<DockMessages>` を自前で全部埋めているアプリ**: 増えたキー `lockWindow` / `unlockWindow` / `autoHidePane` / `pinPane` / `autoHideBand` を足す。
  3. **`beforePanelChange` を渡しているアプリ**: 外周ドッキングで包まれて作り直される pane の `reparent` を先に聞く。自動で隠す・戻すときは `auto-hide` を聞く（引き出す・引っ込めるは聞かない）。
  4. **`setPinned` / `isPinned` を位置固定の意味で使っているアプリ**: 動くが非推奨。`setLocked` / `isLocked` に替える。「ピン = 自動で隠す」の入口は `autoHidePanel` / `pinPanel`。
  5. **ドラッグでのドッキングを前提にした E2E・手順**: ボタンの上で離す操作に直す。
  6. **`rowHeight` を渡していない `BantoGrid` / `GridState`**: 行の高さがテーマの密度に追従する（compact 32px・touch 52px）。これまでどおり 36px に固定したいときは、prop か option で `rowHeight` を渡す。
  7. **visual の基準画像（Linux で生成）**: dashboard（分析ワークスペース）と command-palette を写すものは再生成が要る（下の「更新後の確認」）。
- 依存を上げずに留まれるか: できる（`v7.6.0` のタグに固定したまま使える）。

### B. コピーしたテンプレート

- 変更あり（取り込みは任意。取り込まなくても動く。権限を登録しなければ、取り込んでも欄は出ない）:
  - ユーザー管理の編集パネルの権限の欄（カタログが空なら出ない）、設定 > セキュリティの「ログイン不要モードの権限」の欄、型 `UserPermission`・`PermissionEntry`（`lib/banto/authAdmin.ts`）、`listPermissionCatalog`（`usersAdmin.ts`）、`sessionStore.hasPermission`、監査ログの `permissions` の追加・削除の表示、辞書（`common.permissions`・`users.permissions*`・`resource.changesAdded` / `changesRemoved`）。
  - `admin_template_core::permission_catalog()`（空のカタログ。banto-serve と Tauri の両方が呼ぶ）、`src-tauri/src/lib.rs` の `permissions_catalog`・`users_update` / `auth_config_apply` の `permissions?`・`require_permission`・`session_permissions`。
  - デモビルドのページ `/theme-lab`（`themeLab.ts`・`ThemeLabCharts.svelte`、`navigation.ts` の `demoOnly`）。
  - ダッシュボードの初回の既定配置の判定（帯にだけ pane がある保存済みの配置を空と見なさない）。
- 取り込む手順: ① 依存を `v7.7.0` に上げる。② 権限を使う派生アプリは [add-permission](docs/recipes/add-permission.md) の手順（カタログに登録、message key を辞書に足す、`PermissionGuard`・`require_permission` を両経路に置く）。使わないなら上の差分の取り込みは任意。③ ユーザー管理を外している（display）派生アプリは `routes/(app)/users/` ごと外れているので権限の欄は要らない（型 `UserPermission`・`PermissionEntry` は `authAdmin.ts` に 1 か所なので残る）。④ scaffold を使う派生アプリは `scripts/scaffold.mjs` を取り込み（`/theme-lab` のチャート部分の印と remover が変わった）、4 プリセットの `pnpm scaffold --dry-run` を通す。⑤ visual の基準画像を再生成する。
- 詳しい手順と確認項目は [upgrading.md の例 7](docs/upgrading.md)。

### C. DB・設定・配布資産

- マイグレーション: **0013 `user_permissions`（SQLite・PostgreSQL の両方）が増える**。新しい表を足すだけで、既存の列・行は変えない（`users` の削除で `ON DELETE CASCADE`）。起動時に自動適用される。**戻せる条件**: マイグレーションは前進のみ（down は無い）。戻すには、適用前のバックアップを復元し、旧版のバイナリで起動する。戻せる境界は「新版を本番 DB で最初に起動するまで」（[upgrading.md 4 節](docs/upgrading.md)）。0013 より前のバックアップを戻しても、起動時に表ができる。本番 DB の前に、検証用のコピーで起動して 0013 が当たることを確かめる。
- 応答の形（JSON、フィールドの追加のみ。古いクライアントは読み飛ばす）: `GET /api/users`・`PUT /api/users/{id}`・`GET /api/auth/identity`、Tauri の `users_list`・`users_update`・`auth_identity`・`auth_resolve` の応答に `permissions`。Tauri の `auth_config_get` / `auth_config_apply` の応答に `disabledPermissions`（登録済みのキーだけ。Rust の `AuthSettings` は変えず、応答用の別の型）。新しい口: `GET /api/permissions`（Admin）、`PUT /api/users/{id}` の `permissions?`、Tauri の `permissions_catalog`。
- 設定キー: `auth.disabled_permissions`（ログイン不要モードの権限。既定は無し）。`tauri.conf.json` は版数のみ。
- 配布物: 変更なし。
- 依存監査: `.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続（下の「セキュリティ」）。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm verify:architecture`（rule 8 に権限のガードの対が加わる）/ `pnpm dev`（画面が描画される）。`DockPanelChange` を switch で網羅しているアプリは `auto-hide` を足してから型検査を通す。
2. dock-svelte を使う画面: ドラッグ中に十字・外周のボタンが出て、ボタンの上で離したときだけドッキングし、外で離すと浮動になること。錠で位置が固定されること。区画のピンで帯へ畳まれ、帯のタブで引き出せること。
3. 権限を登録したアプリは、ユーザー編集で付け外しでき、持たないユーザー（Admin を含む）の操作が 403 になり、監査に `permissions` の追加・削除と `denied` が残ること。
4. 起動時に migration 0013 が当たること（検証用のコピーで）。
5. visual の基準画像（Linux で生成）の再生成が要る: dashboard・command-palette（基準画像は Linux で生成する。作業機に Docker / WSL が無ければ visual-baselines の workflow を dispatch して再生成）。
6. scaffold を使う派生アプリは、4 プリセットの `pnpm scaffold --dry-run` が通ること。

### セキュリティ

- **RUSTSEC-2026-0459**（libsqlite3-sys 0.30.1 の同梱 SQLite）の `.cargo/audit.toml` での一時的な除外は、この版でも継続している。理由: sqlx 0.9.0 が libsqlite3-sys 0.39 以上を受け付けない。外す合図は、libsqlite3-sys 0.39 以上を許す sqlx のリリース（`cargo update -p libsqlite3-sys` で除外を外す）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `f20d380c`、`workflow_dispatch`）: [run 44435942415](https://github.com/tyaro/banto/actions/runs/44435942415)（success）。
  - タグの push（`v7.7.0`、main の `f20d380c`）: [run 44436663408](https://github.com/tyaro/banto/actions/runs/44436663408)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。ただし Node.js だけは、タグの push の run の `npm`（Git deps → dev + Playwright → check → build）ジョブが 24.22.3、ほかのジョブは 24.22.2。

    | 項目               | 版                                |
    | ------------------ | --------------------------------- |
    | Node.js            | 24.22.2（一部のジョブは 24.22.3） |
    | pnpm               | 10.33.0                           |
    | Svelte             | 5.57.3                            |
    | SvelteKit          | 3.2.0                             |
    | Vite               | 8.3.8                             |
    | vite-plugin-svelte | 7.3.1                             |
    | TypeScript         | 6.0.3                             |
    | Rust               | 1.100.0（0ef1bc386 2026-11-09）   |

  - 出所: Node.js は `node: v24.22.2`（タグの push の run の `npm` ジョブは `node: v24.22.3`）、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、Rust は `Setup Rust toolchain` の `rustc 1.100.0`。

### 変更の一覧

#### 追加: テーマを試せるページ `/theme-lab`（#690、洗練案 E-3）

- デモビルドのサイドバー・コマンドパレットの「見本」グループに「テーマを試す」を追加した（`navigation.ts` の `demoOnly`。`/ui-demo`・`/chart-gallery` と同じ扱いで、URL ならどのビルドでも開ける）。ブランド色相（`--banto-brand-hue`、スライダーと数値）・角丸（`--banto-radius-sm/md/lg` を一緒に動かす）・密度（標準・compact・touch）・フォント（OS 同梱のスタック数種。フォントは同梱しない）・ライト／ダークを動かすと、ページ内のプレビュー領域（入れ子の `data-theme` の要素）だけに効く。シェルは変わらず、状態は保存しない（再読み込みで既定に戻る）。
- プレビューにはボタン・StatusBadge・入力とピッカー・SurfaceCard・ToastHost・BantoGrid の小さな表・チャート（カテゴリ 8 色の円、連続／発散スケールのヒートマップ）を並べる。既定から変えた変数だけを `:root { … }` の CSS にして書き出し、コピーとファイル保存ができる。選んだ色相とテーマで、primary や状態色の文字のコントラスト比を出し、4.5:1 を割ると注意を出す。
- 書き出す CSS・コントラスト比は `src/lib/themeLab.ts` の純関数（単体テスト `themeLab.test.ts`。定数が `banto.css` とずれたら落ちる）。vitest の `css.include` に `banto.css` を足した（`?raw` で読むため）。
- scaffold: チャートの部分だけを `ThemeLabCharts.svelte` に分け、`--preset minimal` / `display`（charts を外す）では、そのファイル・ページの import と節（`[scaffold:charts]` の印）・`themeLab.charts.*` を外す。ページ本体は残る。`DemoNavIconKey`・`DemoNavLabelKey` に `theme-lab` の語が増えたので、charts の remover の置換元の文字列を合わせた（派生側で `scripts/scaffold.mjs` を使うなら、更新時に合わせて取り込む）。

#### 修正: グリッドの行高が密度に追従する（#692）

- `@banto/grid-svelte`: `BantoGrid` の行高がテーマの密度（`--banto-grid-row-height`: standard 36px／compact 32px／touch 52px）に追従するようにした（#692）。これまでは `GridState.rowHeight`（既定 36）を構築時に固定していたため、compact・touch でも行は 36px のままだった。`rowHeight`（prop または `GridState` の option）を渡したときは今までどおり固定。`GridState` に `rowHeightFixed` と `followThemeRowHeight(px)` を足し、`rowHeight` は読み取り専用の getter（反応的）になった。アプリの items・監査ログの表は、compact・touch で行の高さが変わる
- `/theme-lab`: プレビューの表に `rowHeight` を渡して密度ごとに作り直す回避（#691）を外した。表はプレビューの密度に追従する

#### 追加: dock の外周へのドッキング（#694 PR-1）

- `@banto/dock-svelte`: パネルを host の四辺の外周のボタン（PR-2 で帯からボタンに替えた。下の節）へドラッグして落とすと、docked の木全体を新しい分割で包み、その側に全高／全幅で入るようにした。入る pane は host の 1/4（`EDGE_DOCK_RATIO` = 0.25。分割の比率は左・上なら `[0.25, 0.75]`、右・下なら `[0.75, 0.25]`）、根が同じ向きの分割でも常に包む。外周の当たり判定は区画の当たり判定より先に効く。docked が空（またはドラッグ中の pane だけ）のときは今までどおり。`beforePanelChange` は包まれて作り直される pane の `reparent` を先に、最後に動かす pane の `dock` / `move-docked` を聞く（変更の種類は増やしていない）。
- 公開 API の追加: `DockState.dockPanelAtEdge(id, edge)` / `dockExistingAtEdge(id, edge)`、木の操作 `dockPanelAtEdge` と定数 `EDGE_DOCK_RATIO`、当たり判定 `computeEdgeDrop` / `edgeButtons`、型 `DockEdge`。

#### 変更: dock の十字のガイドと、ドロップ先の能力（#694 PR-2）

- `@banto/dock-svelte`: ドラッグ中、指している docked の区画の真ん中に十字のボタン（中央・左・右・上・下）、host の四辺の真ん中に外周のボタンを出し、**ボタンの上で離したときだけ**ドッキングするようにした。ボタンの上にいる間は入る場所の枠（区画の全体か半分、外周は host の 1/4）を出す。ボタンは 32px 角・間隔 4px、区画・host の縁から 8px 内側。小さい区画では縮め、16px を下回るなら出さない。外周のボタンと重なる十字のボタンは出さない（外周が勝つ）。ボタンはドラッグ中だけ描かれ、`pointer-events: none`・`aria-hidden`（当たり判定は幾何で行う）。キーボードだけでドッキングする口は無い。
- **既定の挙動の変化**: これまでの「区画の端 25% の帯へ落とすと分割、残りは中央（タブ化）」はやめた。区画の上でもボタンの外で離すと浮動になる（浮動 window はその位置へ動き、docked の pane は undock。`undock: false` なら何も起きない）。これまで区画の上ならどこで離してもドッキングしていたので、端や中央付近へ落としていた操作は、ボタンへ落とすように変わる。浮動 window の上・畳んだ区画の帯の上・自分のいる区画の中央の扱いは今までどおり。
- pane の能力（`capabilities`）に、ドロップ先としての `dropCenter`（十字の中央 = タブとして入れる）と `dropSplit`（上下左右 = 横に分割で入れる）を足した（既定は `true`）。`false` ならそのボタンを出さない。タブの組は、中の pane がすべて許すときだけ出す。外周のボタンには効かない。`DockCapabilities` の省略可能なフィールドを足しただけなので、既存のコードはそのまま通る。
- 公開 API の追加: 十字の配置と当たり判定 `crossButtons` / `guideButtonSize` / `hitGuideButton`、定数 `GUIDE_BUTTON_SIZE` / `GUIDE_BUTTON_GAP` / `GUIDE_BUTTON_MIN` / `GUIDE_INSET`、型 `GuideButton` / `CrossOptions`、`dropRegionRect` の第 3 引数（比率。既定 0.5）。`computeDropRegion` は使われなくなったが、互換のために export を残す。
- 見た目: ドラッグ中の見た目（十字・外周のボタン、外周の枠が 1/4）だけが変わる。ドラッグの外の見た目は変わらない。

#### 変更: dock の浮動 window の位置固定を錠のアイコンに（#694 PR-3a）

- `@banto/dock-svelte`: 浮動 window のタイトルバーの「位置と大きさの固定」のボタンを、ピン（📌）から錠（🔓／🔒、class `lock-btn`）に替えた。ピンは次の PR-3b で「自動で隠す」（ドッキング中の区画）の意味になる（VS・GX Works3 と同じ。オーナー決定の案 A。#663 の「ピンは浮動 window のタイトルバーだけ」はこれで置き換わる）。挙動は変わらない。
- 公開 API の追加: `DockState.isLocked(id)` / `setLocked(id, locked)`、`FloatingWindow.locked?`、文言 `messages.lockWindow` / `unlockWindow`。
- **非推奨（次の major で消す）**: `DockState.isPinned` / `setPinned`（`isLocked` / `setLocked` の別名になった）、`FloatingWindow.pinned`（もう書き出さない。古い JSON の `pinned: true` は `validateDockLayout`・`hydrate` が `locked: true` として読む）、`messages.pinWindow` / `unpinWindow`（`lockWindow` / `unlockWindow` を渡さないときだけ使う）。
- 保存の形: 固定した window は `pinned: true` ではなく `locked: true` で書き出す。この版の JSON を古い版で読むと、固定は外れて読まれる（`version` は 2 のまま、読み込みは失敗しない）。

#### 追加: dock の区画を自動で隠す（ピン、#694 PR-3b）

- `@banto/dock-svelte`: ドッキング中の区画（panel 1 つ、またはタブの組）の見出しにピン（📌）を出し、押すとその区画を木から抜いて host の縁の帯に入れるようにした（VS・GX Works3 の「自動的に隠す」）。入る縁は、メイン区画（`close`・`move`・`undock` がすべて `false` の pane の区画。無ければ木の中心）から見た区画の側（分割の比で測る）。左右の帯は縦書き、上下は横書き。帯のある縁の分、木は内側に寄る。
- 帯のタブを押すと、その pane を縁から木の上に重ねて引き出す（フォーカスは中へ）。もう一度押す・外を押す・Esc・フォーカスが外へ出る、で引っ込め、フォーカスが中にあったら帯のタブへ戻す。top layer（開いている `dialog`・`[popover]`）と、表示中のモーダルの層（`role="dialog"`／`"alertdialog"` かつ `aria-modal="true"`。`@banto/ui` の Modal・ConfirmDialog。その背景を押すのも含む）の中のクリック・フォーカス・Esc では引っ込めない（引き出しの中から開いた確認で引っ込めない）。モーダルでない浮動 window へ移るのは外。引き出した pane のピンを押すと元の場所（`showPanel` と同じ記憶）へ戻る。場所が無くなっていたら、その縁へ外周ドッキングで入る。
- 中身: 引き出している pane と `keepMounted` の pane だけを描く（`keepMounted` は引っ込めても残る）。ほかは引き出すたびに作り直す。引き出す・引っ込めるは `beforePanelChange` に聞かない。
- `beforePanelChange`: 木から帯へ・帯から木へは、押し出される pane の `reparent` を先に、区画の中で中身を描いている pane を新しい種類 `{ kind: 'auto-hide'; panelId; to: 'band' | 'tree'; remount: true }` で聞く。承認と適用の間に構造が変わったら `stale`。引き出す・引っ込めるも構造の世代を進めるので、待つ間に引っ込めて開き直した（中身が作り直された）場合も `stale`（`DockState.structureRevision` は引き出しの開閉でも上がる）。
- 能力 `capabilities` に `autoHide`（既定 `true`。`false` でピンを出さない。タブの組は中の pane がすべて許すときだけ）を足した。
- 保存: `DockLayout.autoHidden?: DockAutoHidden[]`（区画・縁・元の場所・引き出す大きさ）。空なら書き出さない。古い JSON はそのまま読める（`version` は 2 のまま）。`validateDockLayout` で形と id の重複を確かめる。この版で隠した区画を含む JSON を古い版で読むと、その区画は消えて読まれる（読み込みは失敗しない）。
- 公開 API の追加: `DockState.autoHidden` / `isAutoHidden` / `autoHideRegion` / `restoreAutoHidden` / `previewRestoreAutoHidden` / `flyoutPanel` / `openFlyout` / `closeFlyout`、`DockHost` の `autoHidePanel(id)` / `pinPanel(id)`、純関数 `autoHideEdge` / `mainRegionId` / `regionOf` / `removeRegion` / `captureRegionSlot` / `restoreRegionSlot`、定数 `AUTO_HIDE_FLYOUT_RATIO`、型 `DockAutoHidden` / `DockRegion` / `AutoHideOptions`、`DockPanelInfo.autoHidden?`、文言 `messages.autoHidePane` / `pinPane` / `autoHideBand`。`dockPanelAtEdge` はタブの組も受け取る（引数の型を広げた）。
- アプリ: ダッシュボードの初回の既定配置の判定で、帯にだけ pane がある保存済みの配置を空と見なさないようにした。
- 見た目: ドッキング中の区画の見出しにピンのボタンが増える。dashboard（分析ワークスペース）と command-palette の visual の基準画像の再生成が要る（Linux で再生成する）。
- **型エラーの注意（派生アプリ）**: 公開の union に種類を足した — `DockPanelChange` に `auto-hide`（PR-3b）。`switch (change.kind)` を網羅検査（`never` への代入など）しているアプリは分岐を足せば通る。また、`DockMessages` を `Required<DockMessages>` として自前で全部埋めているアプリは、増えたキー（`lockWindow` / `unlockWindow`（PR-3a）、`autoHidePane` / `pinPane` / `autoHideBand`（PR-3b））を足す必要がある。

#### 追加: ロールとは別に、ユーザーへ個別に付ける権限（#697 PR-1 サーバー）

- **権限（permission）**: `equipment.operate` のようなキーを、管理者がアカウントごとに付け外しできるようにした。ロール（`viewer < editor < admin`）とは独立に判定し、Admin でも付けていなければ持たない。語彙はアプリが起動時に登録する（`PermissionCatalog`）。テンプレートは何も登録しない（`admin_template_core::permission_catalog()` は空。banto-serve と Tauri の両方がこの 1 つの関数を呼ぶ）。
- DB: migration 0013 `user_permissions`（SQLite・PostgreSQL。`users` の削除で `ON DELETE CASCADE`）。0013 より前のバックアップを戻しても、起動時の migration で表ができる。
- `banto-admin-services`: `permissions` モジュール（`PermissionKey`・`PermissionCatalog`・`PermissionEntry`・`PermissionDiff`・`SessionPermissions`）。`UsersService` に `with_permission_catalog`・`permission_catalog`・`permissions_of`・`permissions_by_user`・`session_permissions`・`set_permissions`・`update_user_with_permissions`（戻り値 `UserUpdate`）。監査の detail は新しい関数 `user_update_detail_with_permissions`（`changes` に `{ field: "permissions", added, removed }`）。`SettingsService` に `auth_disabled_permissions`・`set_auth_disabled_permissions`（キー `auth.disabled_permissions`、ログイン不要モードの権限。既定は無し）。
- `banto-server`: `AuthState::with_permission_reader`・`AuthState::session_permissions`、型 `PermissionReader`、`SessionPermissions` の再公開。`require_auth` がアカウントのセッションの権限を要求ごとに読み、リクエストの extension に入れる（`Extension<SessionPermissions>` で取り出せる）。閲覧公開（grant）のセッションは常に権限なし。ガード `PermissionGuard` / `require_permission`（拒否は 403 `forbidden` と `denied` の監査。ロールの拒否と同じ形）。`routes::user_auth_state` は権限の読み出しも入れる（`routes::user_permission_reader`）。`routes::UserWithPermissions`・`list_users_with_permissions`・`permission_catalog_entries`。
- REST: `GET /api/permissions`（Admin）。`PUT /api/users/{id}` の body に `permissions?: string[]`（省略で変えない。付け外しで `version` +1。未登録・形の違うキーは 422 `validation`）。`GET /api/users` の各行と `PUT` の応答、`GET /api/auth/identity` に `permissions` が増えた（JSON のフィールドの追加）。`POST /api/users` では権限を付けない。
- Tauri: `permissions_catalog`（Admin）、`users_update` の `permissions?`、`users_list`・`users_update`・`auth_identity`・`auth_resolve` の応答に `permissions`。`require_permission(state, permission, resource)` と `session_permissions(state)`（コマンドのたびに DB から読む）。
- `verify:architecture` rule 8: 権限のガードの対（`PERMISSION_PAIRS`）を両経路で照合する。`permissions_catalog` ↔ `GET /api/permissions` を登録した。
- **既存の公開の型は変えていない**: `Identity`・`UserIdentity`・`UserSummary`・`AuthSettings`・`SessionAccount`・`SessionLookup`・`AuthenticatedSession` などにフィールドを足していない。権限は別の型（`SessionPermissions`・応答用の `UserWithPermissions`）で持つ。既存の関数・トレイトのシグネチャも変えていない（追加だけ）。構造体リテラルで組み立てている派生アプリもそのままコンパイルできる。

#### 追加: ユーザーへ個別に付ける権限の管理画面（#697 PR-2a）

- ユーザー管理画面の編集パネルに、アプリが登録した権限（カタログ）のチェックボックスを並べる欄を足した。**カタログが空なら欄ごと出さない**（テンプレートは何も登録しないので、汎用テンプレートの見た目は変わらない）。一覧の列には出さない。作成のフォームには出さない（作った後に編集から付ける）。
- 表示名・説明は、アプリが登録した message key で引く。見つからなければキーそのもの（説明は出さない）。カタログから外れたが持っているキーは「未登録」と出し、外せる（送り返せば残る、外して保存すれば消える）。付け外しは、変えたときだけ `permissions` を送る。競合（409）のときは、権限の欄を一覧の読み直しが終わるまで無効にし、古い選択で上書きしない。
- クライアント: `usersAdmin.ts` に `listPermissionCatalog()`（REST `GET /api/permissions`・Tauri `permissions_catalog`）、`updateUser` の `permissions?`、`permissionRows` / `permissionsToSend` などの純関数。`sessionStore.permissions` / `hasPermission(key)`（セッションの `permissions`。画面の出し分け用で、判定はサーバー。`Identity.permissions` が無ければ空）。
- 監査ログ: ユーザー更新の `changes` の `{ field: 'permissions', added, removed }` を、変更前後の欄ではなく「追加 / 削除」として表示する（監査ログ画面と履歴の一覧）。文言 `common.permissions`・`users.permissions*`・`resource.changesAdded` / `changesRemoved` を ja / en に足した。
- scaffold: 新しい欄は `routes/(app)/users/` の下とすでに外れる `usersAdmin.ts` だけに置いた（display で一緒に外れる）。`common.*`・`resource.*` は display でも残る。
- 対象外: `auth.disabledPermissions`（ログイン不要モードの権限）の画面・コマンドは PR-2b。README・recipe は PR-3。

#### 追加: ログイン不要モードの権限の入口（#697 PR-2b）

- 設定 > セキュリティの「起動時のロール」の下に、ログイン不要モードで持つ権限を選ぶ欄を足した（アプリが権限を登録しているときだけ表示。既定は権限なし）。
- Tauri の `auth_config_apply` に省略可の `permissions` を足した（省略で変えない。未登録のキーは 422 `validation`）。`auth_config_get` / `auth_config_apply` の応答に `disabledPermissions`（登録済みのキーだけ）が増える（Rust の `AuthSettings` には足さず、応答用の別の型）。デスクトップ専用の入口なので、REST の入口は無い。
- モード・ロール・権限は 1 つのトランザクションで保存し、保存の直後にセッションを切り替える（`SettingsService::set_auth_config_and_disabled_permissions` を追加。`set_auth_config` はそれを権限なしで呼ぶ）。権限だけの変更でもセッションの `seq` を進める。
- 監査: 設定変更（`settings_change`）の detail に、変わったときだけ `authDisabledPermissions: { added, removed }` を足す。
- クライアント: 型 `UserPermission`・`PermissionEntry` は `authAdmin.ts` に 1 か所で定義し（display プリセットでも残る）、`usersAdmin.ts` は再 export する。

#### 追加: ユーザーへ個別に付ける権限の文書（#697 PR-3）

- recipe [add-permission](docs/recipes/add-permission.md)（権限を足す手順。ロールか権限かの判断を add-role と相互に記載）、[ADR-0031](docs/adr/0031-user-permissions-separate-axis.md)、README の入口、[upgrading](docs/upgrading.md) の例 7（migration 0013・応答の `disabledPermissions` / `permissions` の追加）。コードの変更なし。

## [7.6.0] - 2026-11-18

**v7.6.0 — `@banto/dock-svelte` のドッキングできるフローティングパネル（#663 ①〜③: 表示メニュー用の一覧・表示/非表示の口と元の場所への復帰、ピン、浮動 window と docked 区画の折りたたみ）、`beforePanelChange` の穴埋め（#666・#682 の `reparent`）、`@banto/ui` のメニュー周り（HeaderNav の `kind: 'menu'`、`closeOpenMenus`、Modal 等がメニューを閉じる、popover の横の clamp、ショートカットの `blockOnMenu`・`mod: 'either'`、`MenuItem` の `shortcut`）、`@banto/forms` の `isSamePage`。** 版の種類: minor（機能追加。公開 API の削除・改名は無い）。理由: `crates/*/src` の `pub` の削除と `packages/*/src/index.ts` の export の削除は無い（追加だけ）。Rust・DB（migration）の変更は無い。
派生アプリへの影響: 依存のタグを `v7.5.0` から `v7.6.0` に上げて型エラーになりうるのは、公開の union に足した種類を網羅検査しているアプリ（`DockPanelChange` の `reparent`、`HeaderNavEntry` の `kind: 'menu'`。分岐を足せば通る。下の A. 消費側への注意 1）。公開 API の削除・改名を伴わない追加によるソース互換の破壊なので、規約の運用上の例外（docs/publishing.md「バージョニング規約」）により minor とした。

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v7.5.0` → `v7.6.0`（npm と Rust を同じタグに）。API の削除・改名は無い。追加: dock-svelte（`DockState.panels`・表示/非表示の口・ピン・折りたたみ・`DockPanelChange` の `reparent`）、ui（HeaderNav の `kind: 'menu'`、`closeOpenMenus`、`blockOnMenu`・`mod: 'either'`、`MenuItem` の `shortcut`）、forms（`isSamePage`）。`beforePanelChange` の呼ばれる回数と種類が増える。visual の基準画像の再生成が要る。 |
| B. コピーしたテンプレート        | あり | ダッシュボードの道具帯を「表示」メニューに置き換え（`#lib/pageViewMenu.svelte.ts`・`PageViewMenu.svelte` の追加、文言キーの追加と削除）、`settlePrompt.svelte.ts` の `closeOpenMenus` を `@banto/ui` へ移した。取り込みは任意（下の B）。                                                                                                                                                                       |
| C. DB・設定・配布資産            | なし | migration の追加は無い。`tauri.conf.json` は版数のみ。`.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続。                                                                                                                                                                                                                                                                                               |

### A. 共通パッケージ・クレート

- 対象: `@banto/dock-svelte`・`@banto/ui`・`@banto/forms`（ほかのパッケージ・クレートは版数のみ）。
- 更新: `v7.5.0` → `v7.6.0`（npm と Rust を同じタグに）。
- 追加 API（いずれも任意。渡さなければ既定の挙動は維持）:
  - dock-svelte: `DockState.panels`（全 pane の一覧）と表示・非表示の口、ドックから隠した pane の元の場所への復帰、浮動 window のピン、浮動 window と docked 区画の折りたたみ、`DockPanelChange` の `reparent`。
  - ui: `HeaderNav` の `{ kind: 'menu', ... }` 項目、`closeOpenMenus(root?, except?)`、`CommandSpec.blockOnMenu?`・`mod: 'either'`、`MenuItem` の `shortcut?` / `platform?`。
  - forms: `guardUnsavedChanges` の `isSamePage` と `isSamePath`。
- 挙動の修正: Modal / Drawer / ConfirmDialog を開くと開いていたメニューを閉じる。狭い viewport で popover の左端が画面外へ出ない。dock-svelte の API（`setPinned`）で固定したとき移動／サイズ変更ボタンにあった DOM フォーカスをピンのボタンへ移す。
- 移行注意（ソース互換の破壊）: 公開の union の種類を網羅して扱っているアプリ（switch の網羅検査など）は、新しい種類を足さないと型エラーになる: `DockPanelChange` の `reparent`、`HeaderNavEntry` の `kind: 'menu'`（下の 1）。
- 消費側への注意（確かめるもの）:
  1. **公開の union を網羅して扱っているアプリ**: `DockPanelChange` には `{ kind: 'reparent'; panelId; cause; remount: true }` の分岐を足す（動かしていないのに親が変わって pane が作り直されることを表すので、`capture` して進めればよい）。`HeaderNavEntry` を `link` / `group` で網羅していたコードには `kind: 'menu'`（操作を並べるメニュー）の分岐を足す。
  2. **`beforePanelChange` を渡しているアプリ**: ドロップ・undock・✕・非表示・`showPanel` で呼ばれる回数と種類が増える（#681・#683。動かす pane だけでなく、押し出される pane・作り直される残りの pane にも聞く）。新しくできるタブの組への `tab-switch` の `groupId` は仮の id のことがあるので、それで組を引かない（dock-svelte の README、#686）。
  3. **visual の基準画像（Linux で生成）**: dock の浮動 window・docked 区画・ダッシュボード・ui-demo を写すものは再生成が要る（下の「更新後の確認」）。
- 依存を上げずに留まれるか: できる（`v7.5.0` のタグに固定したまま使える）。

### B. コピーしたテンプレート

- 変更あり（取り込みは任意。取り込まないと、テンプレートのダッシュボードは旧来の道具帯のまま動く）:
  - ダッシュボードの pane の開閉を、道具帯から「表示」メニューへ置き換えた（#663 ①-C）。`#lib/pageViewMenu.svelte.ts`（`(app)/+layout.svelte` が context で持つ）と `PageViewMenu.svelte` を追加。文言キー `dashboard.viewMenu` / `dashboard.resetLayout` / `shell.pageMenuNav` を追加し、`dashboard.dockToolbarAria` / `dashboard.dockedAlwaysVisible` / `dashboard.reset` を削除。
  - `settlePrompt.svelte.ts` の `closeOpenMenus` を `@banto/ui` へ移した（#670）。テンプレート側の定義は消えた。
- 取り込む手順: ① 依存を `v7.6.0` に上げる。② 上の新規ファイル 2 本と、次の差分をコピーする: `(app)/+layout.svelte`・ダッシュボードの画面・`settlePrompt.svelte.ts`、**`lib/components/ShellMenubar.svelte`（必須。メニューバーに「表示」を描く。新しい layout はメニューバー表示中にページ側のボタンを出さないので、これを取り込まないと表示・非表示の入口が無くなる）**、`lib/components/Header.svelte`（幅が 900px をまたいだときのフォーカスの受け渡しを host に任せる）、`lib/banto/dashboardMemo.svelte.ts`（`reparent` を受ける）。③ 辞書（ja / en）の文言キーを追加・削除する。④ `settlePrompt` から自前の `closeOpenMenus` を使っていた箇所は `@banto/ui` の import に替える。⑤ visual の基準画像を再生成する。
- 独自にダッシュボードの道具帯や `closeOpenMenus` を改造しているアプリは、差分を見て手で合わせる。

### C. DB・設定・配布資産

- マイグレーション: 追加なし。
- 設定キー・`tauri.conf.json`: 設定キーの追加は無い。`tauri.conf.json` は版数のみ。
- 配布物: 変更なし。
- 依存監査: `.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続（下の「セキュリティ」）。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画される）。`DockPanelChange` を switch で網羅しているアプリは `reparent` を足してから型検査を通す。
2. `beforePanelChange` を渡している画面: ドロップ・undock・✕・非表示・`showPanel` で期待どおりに聞かれること（呼ばれる回数が増えて二重確認にならないか）。
3. dock-svelte を使う画面: 浮動 window のピン・折りたたみ、docked 区画の折りたたみ、表示メニューからの表示・非表示と元の場所への復帰を実際に操作して確かめる。メニューを開いたまま Modal / Drawer を開くとメニューが閉じること。
4. visual の基準画像（Linux で生成）の再生成が要る: dock の浮動 window・docked 区画・ダッシュボード・ui-demo を写すもの（基準画像は Linux で生成する。作業機に Docker / WSL が無ければ visual-baselines の workflow を dispatch して再生成）。

### セキュリティ

- **RUSTSEC-2026-0459**（libsqlite3-sys 0.30.1 の同梱 SQLite）の `.cargo/audit.toml` での一時的な除外は、この版でも継続している。理由: sqlx 0.9.0 が libsqlite3-sys 0.39 以上を受け付けない。外す合図は、libsqlite3-sys 0.39 以上を許す sqlx のリリース（`cargo update -p libsqlite3-sys` で除外を外す）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `54a577c2`、`workflow_dispatch`）: [run 44289534097](https://github.com/tyaro/banto/actions/runs/44289534097)（success）。
  - タグの push（`v7.6.0`、main の `54a577c2`）: [run 44289992439](https://github.com/tyaro/banto/actions/runs/44289992439)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。

    | 項目               | 版                              |
    | ------------------ | ------------------------------- |
    | Node.js            | 24.22.2                         |
    | pnpm               | 10.33.0                         |
    | Svelte             | 5.57.3                          |
    | SvelteKit          | 3.2.0                           |
    | Vite               | 8.3.8                           |
    | vite-plugin-svelte | 7.3.1                           |
    | TypeScript         | 6.0.3                           |
    | Rust               | 1.100.0（0ef1bc386 2026-11-09） |

  - 出所: Node.js は `node: v24.22.2`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、Rust は `Setup Rust toolchain` の `rustc 1.100.0`。

### 変更の一覧

#### 修正: dock-svelte の浮動ウィンドウで、API（`setPinned`）で固定したとき移動／サイズ変更ボタンにあった DOM フォーカスをピンのボタンへ移す（#685）

- #673（折りたたみ）と同じ `$effect.pre` に統合。ほかの場所にあるフォーカスは動かさない。

#### 修正: dock-svelte のドロップで押し出される pane にも `beforePanelChange` を聞く（#666）

- docked の木へのドロップ（dock / move-docked）と `showPanel` で元の場所へ戻すとき、動かす pane だけでなく、変わってしまうほかの docked の pane にも先に聞くようにした。タブの組へ落とすと選択中から外れるタブは `tab-switch`、新しい分割（単独の pane の真ん中へ落としたときは新しいタブの組）に包まれて作り直される pane（と、動かして分割が 1 つに縮むときに残って作り直される pane）は新しい reason `reparent`（`remount: true`。Svelte の部品は別の親へ移せないので `keepMounted` でも作り直される）。木の順に 1 つずつ聞き、最初の拒否で何も変えずに止め、最後に動かす pane 自身に聞く。答えは 1 つの判断として、最初に聞いたときの構造が適用まで変わらないことを確かめる（変わったら `stale`）。IME 変換中はタブのクリックと同じく保留して `resumeDeferredChange` で再開する。`beforePanelChange` を渡しているアプリは、ドロップで呼ばれる回数と種類が増える

#### 修正: dock-svelte で docked の pane を抜くと残る pane が作り直されるとき、残る側にも聞く（#682）

- undock（ドッキング中の pane を浮動へ出すドロップ）・✕（`closePanel` / `hidePanel` / `setPanelVisible(false)`）で、分割やタブの組が 1 枚に縮み、残る pane が作り直される（`keepMounted` でも同じ）ときは、先にその pane の `reparent`（`cause` = 抜かれる pane の id）を聞き、最後に抜かれる pane 自身の `undock` / `hide` / `close` を聞く。どれかが拒否なら何も変えない。3 枚以上の分割・タブの組から 1 枚抜くなど、残る pane が作り直されないときは従来どおり抜かれる pane だけ。`beforePanelChange` を渡しているアプリは、これらの操作で呼ばれる回数と種類が増える

#### 追加（minor）: dock-svelte の `DockPanelChange` に `reparent`（#666）

- `{ kind: 'reparent'; panelId; cause; remount: true }` を追加した（公開 API の追加）。動かしていないのに親が変わって作り直される docked の pane に使う。`panelId` = 作り直される pane、`cause` = その変化を起こした、動かしている pane の id。`kind` を網羅して扱っているアプリは `reparent` を足す（`dock` / `undock` / `move-docked` と同じく `capture` して進めればよい）。

#### 追加（minor）: ui の `closeOpenMenus(root?, except?)`（#670）

- 開いている `Menu`（`role="menu"` の popover）を閉じる口を `@banto/ui` から公開した。`root`（既定は document）の下の menu を `hidePopover()` し、閉じたものを返す。`except` の中の menu は閉じない。admin-template の `settlePrompt.svelte.ts` にあった同名の関数はこちらへ移し（テンプレート側の定義は消した）、HeaderNav の menu 項目を閉じるループも同じ関数に寄せた。

#### 修正: Modal / Drawer / ConfirmDialog を開くと、開いていたメニューを閉じる（#670）

- メニューは top layer の popover でモーダルの scrim より上に残り、`layering.ts` ではメニューとモーダルがお互いを「上」と判定して Esc が噛み合わなかった。モーダル層（Modal・Drawer・ConfirmDialog）が開く瞬間に、開いているメニューを閉じる約束にした（層の判定は変えていない。モーダルの中のメニューと、開いた後に開くメニューは対象外）。フォーカスがメニュー項目にあったときは、閉じるときの復帰先をメニューのトリガーにする。

#### 追加（minor）: forms の `guardUnsavedChanges` に `isSamePage` の口（#675）

- `guardUnsavedChanges({ ..., isSamePage?: (from: URL, to: URL) => boolean })` と `isSamePath(from, to)`（パスが同じならクエリが違っても同じページ）を追加。クエリに画面の状態を持つページで、クエリだけが変わる `goto`・戻る・進むに未保存の確認を出さない。`isApprovedExit` にも判定関数を渡せる。既定（パス+クエリ一致）と、再読み込み・タブを閉じるの扱いは従来どおり

#### 修正（patch）: 狭い viewport で Menu などの popover の左端が画面外へ出る（#668）

- `anchoredPopover` の横の補正を、左端が必ず `ANCHORED_POPOVER_GAP` 以上になる形に直した（popover が viewport より広いときは右側へはみ出す）。Menu / HeaderNav / DateInput / DateTimeInput / TimeInput / Tooltip に効く。Menu の `min-width` / `max-width` は `100vw - 2 * var(--banto-space-1)` を超えないようにした

#### 追加（minor）: ui のショートカットに `blockOnMenu` と `mod: 'either'`（#669）

- `CommandSpec.blockOnMenu?`（既定 `true`）。`false` の command はメニューが見えていても止まらない（モーダルの層は今までどおり止める）。`createShortcutDispatcher({ mod?: 'platform' | 'either' })`（既定 `'platform'`）。`'either'` は `Mod` を Ctrl・Meta のどちらでも一致させ、両方押しは一致させない。`ShortcutModMode` 型と `matchShortcut` の第 4 引数を追加

#### 追加（minor）: ui の `MenuItem` にショートカット表示（#671）

- `MenuItem` に `shortcut?`（`'Mod+Z'` 形式、`CommandSpec` と同じ）、`platform?`（省略時は初回描画を `'other'`、マウント後に `detectShortcutPlatform()`。SSR と hydration が一致する）、`ariaKeyShortcuts?`（`aria-keyshortcuts` を明示。自動変換より優先）を追加。label の右に keycap テキスト（`formatShortcut`、`aria-hidden`）を出し、アクセシブル名は label のまま、`aria-keyshortcuts` に WAI-ARIA 形式で入れる。変換用に `toAriaKeyShortcuts(shortcut, platform)` を export（`?` `%` `/` `+` など配列依存の記号キーは `undefined` を返し属性を省く）。表示のみでキーの処理はしない

#### 追加（minor）: dock-svelte のドッキング中の区画を帯に畳む（#663 ③-B）

- 分割の子になっている区画（panel または tab グループ）の見出しの折りたたみのボタン（▾／▸）で、column の split では横帯、row の split では縦帯に畳み、もう一度押すと戻る。`DockPanelNode.collapsed?` / `DockTabGroupNode.collapsed?` と `dock.isDockedCollapsed(nodeId)` / `dock.canCollapseDocked(nodeId)` / `dock.setDockedCollapsed(nodeId, collapsed)` を追加し、レイアウトの JSON に保存・復元する（`version` は 2 のまま、古い JSON はそのまま読める）。空いた場所は開いている区画に今の比のまま分け（`sizes` は書き換えない）、畳んだ区画に接する divider は動かせない。最後に開いている区画と木の単独の区画は畳めない。畳んでいる間、中身は破棄せず隠し（`hidden` + `inert`）、フォーカスは折りたたみのボタンへ移る。`show` / `showPanel` / `setPanelVisible(true)` は畳んだ区画を展開する。ラベルは `messages.collapsePane` / `expandPane`。docked の pane を写す visual の基準画像は再生成が要る

#### 追加（minor）: dock-svelte の浮動 window の折りたたみ（#663 ③-A）

- 浮動 window のタイトルバーの折りたたみのボタン（▾／▸）で、タイトルバーだけに畳み、もう一度押すと元の大きさに戻る。`FloatingWindow.collapsed?` と `dock.isCollapsed(id)` / `dock.setCollapsed(id, collapsed)` を追加し、レイアウトの JSON に保存・復元する（`version` は 2 のまま、古い JSON はそのまま読める）。畳んでいる間、中身は破棄せず隠し（`hidden` + `inert`）、リサイズ（ハンドル・キーボードのモード・`dock.resize`）は止まる。本体の中にフォーカスがあれば折りたたみのボタンへ移す。ラベルは `messages.collapseWindow` / `expandWindow`。visual の基準画像（浮動 window を写すもの）は再生成が要る

#### 追加（minor）: dock-svelte の浮動 window にピン（位置と大きさの固定）（#663 ②）

- 浮動 window のタイトルバーのピンのボタンで、位置と大きさを固定できる（ドラッグ・リサイズ・キーボード操作が止まる）。`FloatingWindow.pinned?` と `dock.isPinned(id)` / `dock.setPinned(id, pinned)` を追加し、レイアウトの JSON に保存・復元する（`version` は 2 のまま、古い JSON はそのまま読める）。ラベルは `messages.pinWindow` / `unpinWindow`

#### 変更: テンプレートのダッシュボードの pane の開閉を「表示」メニューへ（#663 ①-C）

- admin-template のダッシュボードの「分析ワークスペース」の上にあったツールバー（pane ごとの開閉ボタンと「リセット」）を外し、「表示」メニューに置き換えた。pane ごとのチェックボックス（入れる = `showPanel` で、ドックから隠した pane は元の場所に戻る。外す = ✕ と同じ経路）と「レイアウトを既定に戻す」を並べる。メニューバーが出ている間（`menubar` レイアウト・幅 900px 超・入りきる）はヘッダーのメニューバーの「表示」に、それ以外（サイドバー・ドック、900px 以下、入りきらずドロワーに代わっているとき）はページ見出しの横の「表示」ボタンになり、いつも 1 か所にだけある。ページがシェルへメニューを渡す汎用の口として `#lib/pageViewMenu.svelte.ts`（`(app)/+layout.svelte` が context で持つ）と `PageViewMenu.svelte` を足した。文言キー: `dashboard.viewMenu` / `dashboard.resetLayout` / `shell.pageMenuNav` を足し、使わなくなった `dashboard.dockToolbarAria` / `dashboard.dockedAlwaysVisible` / `dashboard.reset` を消した。visual の基準画像（ダッシュボードを写すもの）は再生成が要る。

#### 追加（minor）: dock-svelte に表示メニュー用の一覧と表示・非表示の口、ドックから隠した pane の元の場所への復帰（#663 ①-A）

- `@banto/dock-svelte` に追加: `DockState.panels`（reactive。全 pane の `{ id, title, icon?, placement, visible }` を id を初めて見た順に）・`DockState.show` / `showPlacement` / `showTabSwitch` / `dismiss` / `isVisible`、`DockHost` の `showPanel(id)` と `setPanelVisible(id, visible)`（外す = ✕ と同じく `keepMounted` は hide・それ以外は close で `beforePanelChange` に聞く。`capabilities` の `close: false` は `refused`）、純関数 `captureDockSlot` / `restoreDockSlot`、型 `DockPanelInfo` / `DockSlot`。docked の pane を ✕・`hidePanel`・`closePanel` で隠すと、閉じた浮動 window に元の場所（タブグループと位置、または分割の側と割合）を `FloatingWindow.dockSlot` として覚え、`showPanel` / `dock.show` でそこへ戻す（場所が消えていれば浮動で開く。タブグループへ選択中のタブとして戻すときは、それまで選択中だった pane からの `tab-switch` としてタブのクリックと同じく先に聞き、IME 変換中は待つ）。`dockSlot` は任意のプロパティで layout の `version` は 2 のまま（古い JSON はそのまま読める）。`dock.isOpen` / `open` / `close` は従来どおり浮動 window だけを見る（`open` はドックから隠した pane を浮動で開き、覚えた場所を捨てる）。修正: `dock.ensureWindow` が docked の id を浮動として重複して足していた。

#### 追加（minor）: ui の HeaderNav に操作を並べるメニューの項目（#663 ①-B）

- `@banto/ui` の `HeaderNav` に、操作を並べるメニューの項目 `{ kind: 'menu', id, label, items: HeaderNavMenuItem[] }` を足した（#663 ①-B。デスクトップのアプリの「表示」メニューの土台）。項目は `action`・`checkbox`（`menuitemcheckbox`。選んでも閉じない）・`separator` で、ui の `Menu` / `MenuItem` で描く。メニューの項目は「その他」へ移らず上段に残る（`fitCount` に任意の `pinned` を足した）。型 `HeaderNavMenuItem` と `headerNavEntryPinned` を公開。既存の `link` / `group` の挙動は変わらない。ui-demo の HeaderNav の見本に「表示」メニューを足した（visual の基準画像 `ui-demo` は再生成が要る）。

## [7.5.0] - 2026-11-18

**v7.5.0 — `@banto/ui` の `ThreePaneLayout` を外から扱う 5 つの口（#655）と、`Tabs` の `hideSingleTab`（#659）。下流（banto-industrial）からの要請に応える追加。** 版の種類: minor（機能追加。公開 API の削除・改名は無い）。理由: `crates/*/src` の `pub` の削除と `packages/*/src/index.ts` の export の削除は無い（追加だけ）。追加の口はすべて任意で、渡さなければ見た目・挙動は変わらない。Rust・DB・テンプレートの変更は無い。
派生アプリへの影響: 依存のタグを `v7.4.0` から `v7.5.0` に上げるだけなら、コンパイルエラーになる変更は無い。

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v7.4.0` → `v7.5.0`（npm と Rust を同じタグに）。API の削除・改名は無い。追加のみ（`ThreePaneLayout` の `onToggle`・`leftToggleEl`/`rightToggleEl`・`leftOpen`/`rightOpen`・`leftDrawerModal`/`rightDrawerModal`・`narrowOverride`・スクリムの `data-three-pane-scrim`、`Tabs` の `hideSingleTab`）。Rust のクレートは版数のみ。 |
| B. コピーしたテンプレート        | なし | テンプレートの画面・辞書・`src-tauri` の変更は無い（版数のみ）。                                                                                                                                                                                                                                                                 |
| C. DB・設定・配布資産            | なし | migration の追加は無い。`tauri.conf.json` は版数のみ。`.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続。                                                                                                                                                                                                                |

### A. 共通パッケージ・クレート

- 対象: `@banto/ui`（ほかのパッケージ・クレートは版数のみ）。
- 更新: `v7.4.0` → `v7.5.0`（npm と Rust を同じタグに）。
- 追加 API（いずれも任意。既定の挙動は維持）:
  - `ThreePaneLayout`: `onToggle`、`leftToggleEl` / `rightToggleEl`（bindable、読むだけ）、`leftOpen` / `rightOpen`（既定 `true`、bindable）、`leftDrawerModal` / `rightDrawerModal`（既定 `true`）、`narrowOverride`、スクリムの `data-three-pane-scrim`。
  - `Tabs`: `hideSingleTab`（既定 `false`）。
- 移行注意（ソース互換の破壊）: 無い。
- 消費側への注意（型エラーにはならないが、確かめるもの）:
  1. **ThreePaneLayout の回避を外すとき**: 外から帯のボタンを探す・スクリムを当てる・Esc を横取りするなどの回避を入れていた場合は、新しい口に置き換えてから回避を外す（両方を残すと二重に動く）。非モーダルのドロワー（`*DrawerModal=false`）では、`*Open=false` で閉じたときのフォーカスの戻し先はアプリが決める。
  2. **`hideSingleTab` に置き換えるとき**: タブ列を CSS で隠していた回避（例: `.view-tabs.single`）を外す。無効のタブもタブの数に入る。2 つ以上のときは何も変わらない。
- 依存を上げずに留まれるか: できる（`v7.4.0` のタグに固定したまま使える）。

### B. コピーしたテンプレート

- 変更なし（`package.json`・`tauri.conf.json` の版数のみ）。取り込みは不要。

### C. DB・設定・配布資産

- マイグレーション: 追加なし。
- 設定キー・`tauri.conf.json`: 設定キーの追加は無い。`tauri.conf.json` は版数のみ。
- 配布物: 変更なし。
- 依存監査: `.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続（下の「セキュリティ」）。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画される）。
2. `ThreePaneLayout`・`Tabs` を使う画面: 新しい口を渡さない限り、見た目・挙動は変わらないこと。回避を新しい口に置き換えた画面は、帯のボタン・狭い幅のドロワー（開閉・Esc・フォーカス）・タブ 1 つのときの表示を実際に操作して確かめる。
3. visual の基準画像（Linux で生成）の再生成が要る変更は無い見込み（どちらも既定で見た目が変わらない）。

### セキュリティ

- **RUSTSEC-2026-0459**（libsqlite3-sys 0.30.1 の同梱 SQLite）の `.cargo/audit.toml` での一時的な除外は、この版でも継続している。理由: sqlx 0.9.0 が libsqlite3-sys 0.39 以上を受け付けない。外す合図は、libsqlite3-sys 0.39 以上を許す sqlx のリリース（`cargo update -p libsqlite3-sys` で除外を外す）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `a8b311a6`、`workflow_dispatch`）: [run 44211880793](https://github.com/tyaro/banto/actions/runs/44211880793)（success）。
  - タグの push（`v7.5.0`、main の `a8b311a6`）: [run 44212084975](https://github.com/tyaro/banto/actions/runs/44212084975)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。

    | 項目               | 版                              |
    | ------------------ | ------------------------------- |
    | Node.js            | 24.22.2                         |
    | pnpm               | 10.33.0                         |
    | Svelte             | 5.57.3                          |
    | SvelteKit          | 3.2.0                           |
    | Vite               | 8.3.8                           |
    | vite-plugin-svelte | 7.3.1                           |
    | TypeScript         | 6.0.3                           |
    | Rust               | 1.100.0（0ef1bc386 2026-11-09） |

  - 出所: Node.js は `node: v24.22.2`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、Rust は `Setup Rust toolchain` の `rustc 1.100.0`。

### 変更の一覧

#### 追加（minor）: Tabs に hideSingleTab（#659）

- `@banto/ui` の `Tabs` に任意の `hideSingleTab?: boolean`（既定 `false`）を追加。`true` でタブが 1 つ（無効のタブも数に入れる）のとき、`role="tablist"` を描かず、パネルは同じ要素のまま `role`・`id`・`aria-labelledby`・`tabindex` だけを外す（空の枠に Tab で止まらない。タブの数が変わっても中身は作り直さない。無効な唯一のタブは従来どおり隠れ、既定（`keepMounted` なし）では中身も描かない）。`value`・`onchange` は従来どおり。2 つ以上では何も変わらない。

#### 追加（minor）: ThreePaneLayout を外から扱う 5 つの口（#655、#631 のフォロー）

- `@banto/ui` の `ThreePaneLayout` に追加（すべて任意。渡さなければ見た目・挙動は変わらない）:
  - `onToggle?: (side, open) => void`（帯のボタンで状態を変える直前に同期で呼ぶ。`open` は押した後の値）と、`leftToggleEl` / `rightToggleEl`（bindable、読むだけの出力。無いときは `undefined`）。
  - `leftOpen` / `rightOpen`（既定 `true`、bindable）。`false` でそのペインと帯のボタンを出さない（中身はアンマウント）。`leftCollapsed` / `rightCollapsed`（畳む＝中身は保つ）は変えない。出さない間は、そのペインのドロワーの開閉状態も閉じに戻る。
  - `leftDrawerModal` / `rightDrawerModal`（既定 `true`）。`false` で狭い幅のドロワーが非モーダルになる（中央は `inert` にならず、スクリムも出ず、開いてもフォーカスを奪わない。Esc で閉じるのはフォーカスがドロワーの中にあるときだけで、window では拾わない（中央のセル編集・検索欄の Esc でドロワーまで閉じない）。同時に 1 つは同じ）。
  - スクリムに `data-three-pane-scrim`（外から当ててよい属性として README に公開の約束。`role="presentation"` のまま）。
  - `narrowOverride?: boolean`。指定すると測った枠の幅より優先して狭い／広いを決める（`bind:narrow` も従う）。
- 消費側への注意: 型 `ThreePaneLayoutProps` に任意のプロパティが増えただけで、既存の呼び出しはそのまま動く。

## [7.4.0] - 2026-11-18

**v7.4.0 — users の楽観ロック（migration 0012・衝突のトースト）、`BantoTree`（`@banto/tree-svelte`）の 3 つの口（`selectionFollowsFocus`・`emptyChildren`・`data-depth`）。** 版の種類: minor（機能追加。公開 API の削除・改名は無い）。理由: `crates/*/src` の `pub` の削除と `packages/*/src/index.ts` の export の削除は無い（追加だけ）。ソース互換を壊しうる変更は 3 つあり、いずれも [docs/publishing.md](docs/publishing.md)「バージョニング規約」の運用上の例外（移行手順を「消費側への注意」に明記して minor）に当てはめた。(1) `banto_admin_services::users::UserSummary` に `version` フィールドが増えた（構造体リテラルで作るコードに影響）。(2) テンプレート（`src-tauri`）の `users_update_body`・`users_delete_body` に引数が増えた（公開パッケージ・クレートではない）。(3) migration 0012 は `users.version` 列の追加だけ（既存の行は書き換えない。前例 v1.7.0・v6.5.0・v7.2.0・v7.3.0）。
派生アプリへの影響: 依存のタグを `v7.3.0` から `v7.4.0` に上げるだけなら、`banto_admin_services::users::UserSummary` を構造体リテラルで作る・網羅的に分解するコードと、`UsersService` を使う派生アプリ（`users.version` 列が要る）を除き、コンパイルエラーになる変更は無い。コピーしたテンプレートを取り込む場合は、migration 0012、辞書のキー（追加 2 キー）、ユーザー管理画面の衝突の扱い、`users_update_body`・`users_delete_body` の引数が中心になる。`BantoTree` の追加の口は任意で、渡さなければ見た目・挙動は変わらない。

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v7.3.0` → `v7.4.0`（npm と Rust を同じタグに）。API の削除・改名は無い。追加のみ（`BantoTree` の `selectionFollowsFocus`・`emptyChildren`・`TreeEmptyContext`・`data-depth`、`UsersService` の `*_checked_returning_previous`、REST の `version`）。`UserSummary` の `version` は構造体リテラルに影響する。 |
| B. コピーしたテンプレート        | あり | ユーザー管理画面の楽観ロックの配線（衝突のトースト）、`usersAdmin.ts`、辞書のキー（追加 2・削除 0）、migration 0012、`src-tauri` の `users_update_body`・`users_delete_body`。取り込みは任意。                                                                                                               |
| C. DB・設定・配布資産            | あり | migration 0012（`users.version` 列の追加。SQLite・PostgreSQL）。`tauri.conf.json` は版数のみ。`.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続。                                                                                                                                                    |

### A. 共通パッケージ・クレート

- 対象: `@banto/tree-svelte`・`banto-admin-services`・`banto-server`。
- 更新: `v7.3.0` → `v7.4.0`（npm と Rust を同じタグに）。
- 追加 API（いずれも任意。既定の挙動は維持）:
  - `@banto/tree-svelte`: `BantoTree` の `selectionFollowsFocus`・`emptyChildren`、型 `TreeEmptyContext`、各行の `data-depth`。
  - `banto-admin-services`: `UsersService::update_user_checked_returning_previous`・`delete_user_checked_returning_previous`、`UserSummary.version`。
  - `banto-server`: `PUT /api/users/{id}` の任意の `version`、`DELETE /api/users/{id}?version=N`。
- 移行注意（ソース互換の破壊）:
  1. **`UserSummary.version`**: `banto_admin_services::users::UserSummary` を構造体リテラルで作る・網羅的に分解するコードは `version` を足す（型検査で気づける）。TS 側の `UserSummary`（`usersAdmin.ts`、テンプレート）も同じ。
  2. **`users_update_body`・`users_delete_body` の引数 `version: Option<i64>`**（テンプレートの `src-tauri`。公開パッケージ・クレートではない）: 呼ぶ側は `None` を渡す。
- 消費側への注意（型エラーにはならないが、確かめるもの）:
  1. **migration 0012（`users.version`）**: `UsersService` を使う派生アプリは、先に `users.version` 列を足す（足さないと `list_users` などの SELECT が失敗する）。SQLite: `ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1;` PostgreSQL: `ALTER TABLE users ADD COLUMN version BIGINT NOT NULL DEFAULT 1;`（テンプレートの `core/migrations-*/0012_users_version.sql` と同じ）。
  2. **`version` を送らなければ従来どおり上書き**になる（`update_user`・`delete_user`・`*_returning_previous` のシグネチャは変えていない。楽観ロックは画面の配線を取り込んだ場合に働く）。
  3. **`BantoTree` の既定は変わらない**（`selectionFollowsFocus` の既定は `true`、`emptyChildren` を渡さなければ従来どおり）。行に `data-depth` が付くので、行の属性を完全一致で比べるテスト・スナップショットがあれば足す。
- 依存を上げずに留まれるか: できる（`v7.3.0` のタグに固定したまま使える）。

### B. コピーしたテンプレート

- 対象ファイル・ルート: `src/routes/(app)/users/+page.svelte`・`src/lib/banto/usersAdmin.ts`（衝突の扱いとトースト）、`core/src/rest/mod.rs`、`src-tauri/src/lib.rs`（`users_update`・`users_delete`・`users_update_body`・`users_delete_body`）、`messages/*.json`、`core/migrations-*/0012_users_version.sql`。
- 関連 PR・コミット: #651、#653。
- 手で取り込む変更（辞書のキー。**`messages/*.json` の差分をまとめて取り込む**。v7.3.0 の `ja.json` との比較では、削除は 0 キー、追加は 2 キー（`users.conflictNotSaved`・`users.conflictNotDeleted`。1089 → 1091）、値の書き換えは 0 キー。`en.json` も同じ結果）。
- 手で取り込む変更（そのほか）:
  - migration 0012（SQLite・PostgreSQL）を適用する。
  - ユーザー管理画面の衝突の扱い（保存の衝突はフォームを相手の最新値に戻してトースト、削除の衝突は一覧を読み直してトースト）。
  - `src-tauri` の `users_update`・`users_delete` に任意の `version` を通す。
- 派生側の独自変更と衝突しやすい箇所: ユーザー管理画面・`usersAdmin.ts`・`messages/*.json`・`src-tauri/src/lib.rs`。
- 取り込まなくても動くか: 動く見込み。A のタグを `v7.4.0` に上げるだけなら、テンプレートの取り込みは不要。ただし A の「移行注意」は A のタグに伴う。Git 依存での導入は下の「検証した組み合わせ」で確かめた（テンプレートを取り込まない派生アプリそのものでの確認は未実施）。
- 手本: 上記の `apps/admin-template/` のファイル。

### C. DB・設定・配布資産

- マイグレーション: 0012（`users.version` 列の追加。SQLite・PostgreSQL。既存の行は書き換えない。適用は起動時に自動）。コピーしたテンプレートと、`UsersService` を使う派生アプリが適用する。
- 設定キー・`tauri.conf.json`: 設定キーの追加は無い。`tauri.conf.json` は版数のみ。
- 配布物: 変更なし。
- 依存監査: `.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続（下の「セキュリティ」）。
- 戻せる条件: 新版を本番 DB で最初に起動するまで（以降はバックアップの復元）。migration 0012 を適用した DB は `_sqlx_migrations` に 12 が残り、0011 までしか持たない v7.3.0 のバイナリは起動時の migration の検証で拒否する見込み（0011 のときと同じ仕組みからの見込みで、未検証）なので、タグを戻すだけでは戻らない。起動前に DB のバックアップを取り、戻すときは [upgrading.md §4](docs/upgrading.md#4-db設定配布資産の移行) のとおり更新前のバックアップを復元する。
- 順序: A・B を先に完成 → 検証用 DB で migration 0012 を適用 → 本番。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画される）。
2. 辞書のキー（`messages/*.json`）の取りこぼしが無いこと（追加の 2 キーが画面に生のキーで出ない）。
3. Rust: `cargo check` / `cargo test`。migration 0012 の適用後、ユーザー管理で表示名・ロールを更新すると `version` が進むこと。同じユーザーを 2 か所で編集したとき、後から保存した側（保存・削除とも）に衝突のトーストが出ること。
4. `BantoTree` を使う画面: 新しい口（`selectionFollowsFocus`・`emptyChildren`）を渡さない限り、見た目・挙動は変わらないこと。
5. visual の基準画像（Linux で生成）の再生成が要る変更は無い見込み（`BantoTree` は既定で見た目が変わらず、users の楽観ロックは衝突時のトーストだけ）。違えば `visual-baselines.yml` を dispatch して再生成する。
6. scaffold を使う派生アプリは、4 プリセットの `pnpm scaffold --dry-run` が通ること（`usersAdmin.test.ts` の削除を scaffold に足した）。

### セキュリティ

- **RUSTSEC-2026-0459**（libsqlite3-sys 0.30.1 の同梱 SQLite）の `.cargo/audit.toml` での一時的な除外は、この版でも継続している。理由: sqlx 0.9.0 が libsqlite3-sys 0.39 以上を受け付けず、今は上げられない。見直しの条件: libsqlite3-sys 0.39 以上を許す sqlx のリリースが出たら `cargo update -p libsqlite3-sys` で上げ、除外を外す。派生アプリの `cargo audit` でも同じ警告が出る。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `b8b12b91`、`workflow_dispatch`）: [run 44195068546](https://github.com/tyaro/banto/actions/runs/44195068546)（success）。
  - タグの push（`v7.4.0`、main の `b8b12b91`）: [run 44195947297](https://github.com/tyaro/banto/actions/runs/44195947297)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。

    | 項目               | 版                              |
    | ------------------ | ------------------------------- |
    | Node.js            | 24.22.2                         |
    | pnpm               | 10.33.0                         |
    | Svelte             | 5.57.3                          |
    | SvelteKit          | 3.2.0                           |
    | Vite               | 8.3.8                           |
    | vite-plugin-svelte | 7.3.1                           |
    | TypeScript         | 6.0.3                           |
    | Rust               | 1.100.0（0ef1bc386 2026-11-09） |

  - 出所: Node.js は `node: v24.22.2`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、Rust は `Setup Rust toolchain` の `rustc 1.100.0`。

### 変更の一覧

#### 追加（minor）: BantoTree の 3 つの口（#653、#631 のフォロー）

- `@banto/tree-svelte` の `BantoTree` に追加（既定は従来どおりで、渡さなければ見た目・挙動は変わらない）:
  - `selectionFollowsFocus?: boolean`（既定 `true`）。単一選択で `false` にすると、上下・Home・End などの移動キーはフォーカスだけを動かし `onSelectionChange` を呼ばない。Space・Enter・クリックで選ぶ（Enter は選んだうえで従来の開閉・`onActivate` も行う）。`multi`・`none` は変わらない。
  - `emptyChildren?: Snippet<[TreeNode, TreeEmptyContext]>`。`children` が空配列の枝を開いたときの案内行。渡したときだけその枝に開閉の三角が付く。案内行は上下キーを素通りし、選択・チェックの対象にならず、`aria-disabled` の `treeitem`（`aria-level` は枝 + 1）。遅延読み込みの枝は読み込み完了後に 0 件のときだけ空とみなす。型 `TreeEmptyContext`（`{ depth }`）を export。
  - 各行に `data-depth`（0 始まり。`aria-level` - 1）を付け、外から当ててよい属性として公開の約束にした（README に記載）。案内行にも `data-depth` と `data-empty-children` が付く。

#### 追加（minor）: users の楽観ロック（#651、#638 の続き）

- **migration 0012（`users.version`）**: `ALTER TABLE users ADD COLUMN version`（SQLite `INTEGER NOT NULL DEFAULT 1`／PostgreSQL `BIGINT NOT NULL DEFAULT 1`）。既存の行を書き換えない列の追加なので minor（前例 0007 の `auth_epoch`・0011）。
- `banto_admin_services::users::UserSummary` に `version: i64` が増えた。表示名・ロールの更新（`update_user*`）が版を +1 する。パスワードの変更・リセットは版を上げない（`auth_epoch` だけが動く）。
- 版を受ける口は新関数 `UsersService::update_user_checked_returning_previous(id, display_name, role, expected_version)` と `delete_user_checked_returning_previous(id, acting_user_id, expected_version)`。`update_user`・`delete_user`・`*_returning_previous` のシグネチャは変えない（版なし＝従来どおり上書き）。期待する版が違えば `BantoError::Conflict`（`current` は相手の最新の `UserSummary`）。衝突は監査に残さない。
- REST: `PUT /api/users/{id}` の本文に任意の `version`、`DELETE /api/users/{id}?version=N`（不正は 400）。Tauri の `users_update`・`users_delete` に任意の `version`。
- テンプレートの画面: ユーザー管理で、保存の衝突はフォームを相手の最新値に戻してトースト、削除の衝突は一覧を読み直してトースト（辞書に `users.conflictNotSaved`・`users.conflictNotDeleted`）。基準の版は「フォームを開いた時点（または直近の保存成功）の版」で、一覧の読み直しでは動かない。
- 消費側への注意:
  1. `banto_admin_services::users::UsersService` を使う派生アプリは、先に `users.version` 列を足す（足さないと `list_users` などの SELECT が失敗する）。SQLite: `ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1;` PostgreSQL: `ALTER TABLE users ADD COLUMN version BIGINT NOT NULL DEFAULT 1;`（テンプレートの `core/migrations-*/0012_users_version.sql` と同じ）。
  2. `UserSummary` を構造体リテラルで作る・網羅的に分解するコードは `version` を足す（型検査で気づける）。TS 側の `UserSummary`（`usersAdmin.ts`）も同じ。
  3. `users_update_body`・`users_delete_body`（テンプレートの `src-tauri`）の引数に `version: Option<i64>` が増えた。呼ぶ側は `None` を渡す。

## [7.3.0] - 2026-11-17

**v7.3.0 — items の楽観ロック（migration 0011・新しいエラー種別 `conflict`・衝突のダイアログ）、LAN ブラウザの切断の検出と帯（`admin-core` の接続状態・タイムアウト）、3 つ目の表示密度 `touch` とキオスクの dashboard、3 ペインの枠 `ThreePaneLayout`（`@banto/ui`）・`BantoTree` の拡張、`MenuItem` のチェックボックス、監査の主体を受ける `record_write_as` / `record_denied_as`。** 版の種類: minor（機能追加。公開 API の削除・改名は無い）。理由: `crates/*/src` の `pub` の削除と `packages/*/src/index.ts` の export の削除は無い（追加だけ）。ソース互換を壊す変更は 4 つあり、いずれも [docs/publishing.md](docs/publishing.md)「バージョニング規約」の運用上の例外（移行手順を「消費側への注意」に明記して minor）に当てはめた。(1) `ThemeDensity` に `'touch'` が増えた。(2) エラー種別 `conflict`（Rust の `BantoError::Conflict`・TS の `ErrorBody`）が増えた。(3) `ItemsService::delete_returning_previous` に引数が、`ItemInput.version` にフィールドが増えた。(4) migration 0011 は `items.version` 列の追加だけの追加（既存の行は書き換えない。前例 v1.7.0・v6.5.0・v7.2.0）。
派生アプリへの影響: git 依存のタグを `v7.2.0` から `v7.3.0` に上げるだけなら、`ErrorBody` / `BantoError` / `ThemeDensity` を網羅的に扱う箇所と、テンプレート（`admin_template_core`）の `ItemsService`・`ItemInput` を使う箇所を除き、コンパイルエラーになる変更は無い。items の楽観ロックを使うには migration 0011 が要る。コピーしたテンプレートを取り込む場合は、migration 0011、辞書のキー（追加 87 キー・削除 2 キー）、`ResourceListPage.svelte` の列メニュー、楽観ロックの配線、切断の帯が中心になる。

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v7.2.0` → `v7.3.0`（npm と Rust を同じタグに）。API の削除・改名は無い。追加のみ（`ThreePaneLayout`・`MenuItem kind="checkbox"`・`BantoTree` の `label` ほか・`ThemeDensity` の `'touch'`・接続状態のストア・`CellEdit.baseRow`・`record_write_as`）。エラー種別 `conflict` と `ThemeDensity` の `'touch'` は網羅的な分岐に影響する。 |
| B. コピーしたテンプレート        | あり | 楽観ロックの配線、切断の帯、列メニューの置き換え、3 ペインの見本、touch 密度、辞書のキー（追加 87・削除 2）、migration 0011。取り込みは任意。                                                                                                                                                                                          |
| C. DB・設定・配布資産            | あり | migration 0011（`items.version` 列の追加。SQLite・PostgreSQL）。`tauri.conf.json` は版数のみ。`.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続。                                                                                                                                                                              |

### A. 共通パッケージ・クレート

- 対象: `@banto/ui`・`@banto/theme`・`@banto/charts`・`@banto/grid-svelte`・`@banto/admin-core`・`@banto/dock-svelte`・`@banto/tree-svelte`・`banto-core`・`banto-server`。
- 更新: `v7.2.0` → `v7.3.0`（npm と Rust を同じタグに）。
- 追加 API（いずれも任意。既定の挙動は維持）:
  - `@banto/ui`: `ThreePaneLayout` 一式（`ThreePaneLayoutProps`・`PaneFitInput`・`clampPaneWidth` / `fitPaneWidths` / `paneMaxWidth` / `isNarrowWidth`・`THREE_PANE_DEFAULTS`・`UiMessages` の 4 キー）、`MenuItem` の `kind?: 'radio' | 'checkbox'`・`title?`、`SurfaceCard` の `tone`。
  - `@banto/theme`: 表示密度 `touch`（`ThemeDensity` に `'touch'`）、`--banto-font-size-3xl`・`--banto-dock-button-size`・`--banto-tree-toggle-size`・`--banto-card-*`。
  - `@banto/tree-svelte`: `BantoTree` の任意の prop 3 つ（`label` ほか）。
  - `@banto/admin-core`: 切断の判別・タイムアウト・接続状態（`isNetworkError`・`createConnectionMonitor`・`timeoutMs`・`onRequestResult` ほか）、楽観ロック（`DeleteOneOptions`・`createFormResource` の `handlesConflict`・`conflictOf`・`FormConflict` ほか）、`createFormResource` の `submitErrorMessage`。
  - `@banto/grid-svelte`: `CellEdit.baseRow`。
  - `banto-server`: `routes::{AuditActor, record_write_as, record_denied_as}`。
  - `banto-core`: エラー種別 `BantoError::Conflict`。
- 移行注意（ソース互換の破壊）:
  1. **エラー種別 `conflict`**: Rust の `BantoError`・`ErrorBody` に `Conflict` が、TS の `ErrorBody` に `kind: 'conflict'` が増えた。網羅的な `match`・`switch (body.kind)` に `conflict` を足す。自前の `ERROR_KINDS` の Set があれば `'conflict'` を足す（無いと `other` に落ちる）。
  2. **`ThemeDensity` の `'touch'`**: `ThemeDensity` を網羅的な `switch` で扱うなら `'touch'` の分岐を足す（型検査で気づける）。`app.html` の first-paint スクリプトを持つ派生アプリは `touch` を通す（`density === 'compact' || density === 'touch'`）。
  3. **`ItemsService::delete_returning_previous` の引数 `expected_version: Option<i64>`、`ItemInput.version`**（テンプレートの `admin_template_core`。公開パッケージ・クレートではない）: `ItemInput` を構造体リテラルで作るなら `version: None` を足し、`delete_returning_previous` の呼び出しに `None` を渡す。
- 消費側への注意（型エラーにはならないが、確かめるもの）:
  1. **データ要求の `fetch` の init に `signal` が付くようになった**（`createHttpDataProvider` の `timeoutMs`、既定 20 秒）。init を完全一致で比べるテストは `signal: expect.any(AbortSignal)` を足す。
  2. **`CellEdit` に任意の `baseRow` が増えた**（grid-svelte。インライン編集で編集を開いた時点の行）。完全一致で比べるテストは `baseRow` を足す。
  3. **`DataProvider.deleteOne` の第 3 引数 `options?: DeleteOneOptions`**: 自前の `DataProvider` 実装はそのまま動く（引数の追加は任意）。
  4. **`version` を送らなければ従来どおり上書き**になる（楽観ロックは画面の配線を取り込んだ場合に働く）。
  5. **migration 0011（`items.version`）**: 共通クレートだけを更新する派生アプリでも、`Item.version` を使うなら先に列を追加する。
  6. **コンパクト密度の余白トークン `--banto-space-3`〜`-6` が 1 段下の値になった**（見た目の変更）。
- 依存を上げずに留まれるか: できる（`v7.2.0` のタグに固定したまま使える）。

### B. コピーしたテンプレート

- 対象ファイル・ルート: `ResourceListPage.svelte`（列メニューを `Menu`＋`MenuItem kind="checkbox"` に置き換え）、items の詳細フォーム・一覧のセル編集・範囲貼り付け・削除（楽観ロックの配線と衝突のダイアログ）、切断の帯（`server` モードのみ）、`/tree/workspace`（3 ペインの見本）、`core/src` の items・`messages/*.json`、`core/migrations-*/0011_items_version.sql`、`app.html` の first-paint スクリプト。
- 関連 PR・コミット: #638（PR-1・PR-2）、#637（PR-1・PR-2）、#631、#624、#623、#646、#647。
- 手で取り込む変更（辞書のキー。**`messages/*.json` の差分をまとめて取り込む**。v7.2.0 の `ja.json` との比較では、削除は 2 キー（`resource.groupByLabel`・`settings.running`。どちらも未使用）、追加は 87 キー（1004 → 1089）、値の書き換えは 0 キー。`en.json` も同じ結果）。自分の画面で削った 2 キーを使っているなら、自分の辞書に残す。
- 手で取り込む変更（そのほか）:
  - migration 0011（SQLite・PostgreSQL）を適用する。
  - **`ResourceListPage.svelte` の差分を取り込む**（列メニュー。`role=menu`＋`menuitemcheckbox`。grid-svelte の `ColumnsMenu` は公開部品のまま）。
  - items の楽観ロックの配線（手順は [docs/recipes/add-resource.md](docs/recipes/add-resource.md)「楽観ロック」）。
  - 切断の帯（手順は [docs/recipes/lan-access.md](docs/recipes/lan-access.md)）。
  - 表示密度 `touch`（設定の「表示密度」）。
- 派生側の独自変更と衝突しやすい箇所: `ResourceListPage.svelte`・items の詳細フォーム・`messages/*.json`・`core/src` の items・`app.html`。
- 取り込まなくても動くか: 動く見込み。A のタグを `v7.3.0` に上げるだけなら、テンプレートの取り込みは不要。ただし A の「移行注意」は A のタグに伴う。Git 依存での導入は下の「検証した組み合わせ」で確かめた（テンプレートを取り込まない派生アプリそのものでの確認は未実施）。
- 手本: 上記の `apps/admin-template/` のファイル。

### C. DB・設定・配布資産

- マイグレーション: 0011（`items.version` 列の追加。SQLite・PostgreSQL。既存の行は書き換えない。適用は起動時に自動）。コピーしたテンプレートと、`Item.version` を使う派生アプリが適用する。
- 設定キー・`tauri.conf.json`: 設定キーの追加は無い。`tauri.conf.json` は版数のみ。
- 配布物: 変更なし。
- 依存監査: `.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続（下の「セキュリティ」）。
- 戻せる条件: 新版を本番 DB で最初に起動するまで（以降はバックアップの復元）。migration 0011 を適用した DB は `_sqlx_migrations` に 11 が残り、0010 までしか持たない v7.2.0 のバイナリは起動時の migration の検証で拒否する見込みなので、タグを戻すだけでは戻らない。起動前に DB のバックアップを取り、戻すときは [upgrading.md §4](docs/upgrading.md#4-db設定配布資産の移行) のとおり更新前のバックアップを復元する。
- 順序: A・B を先に完成 → 検証用 DB で migration 0011 を適用 → 本番。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画される）。
2. 辞書のキー（`messages/*.json`）の取りこぼしが無いこと（画面に生のキーが出ない）。設定の「表示密度」で「タッチ」を選べること。
3. visual の基準画像（Linux で生成）の更新が要るか。この版では `/tree/workspace`・コンパクト密度の dashboard（`LineChart` の x 軸）・キオスクの dashboard・一覧の「列」メニュー（`e2e/visual/columns-checkbox.spec.ts`）が対象。
4. Rust: `cargo check` / `cargo test`。migration 0011 の適用後、items の更新が `version` を進めること。同じ行を 2 か所で編集したとき、後から保存した側に衝突のダイアログが出ること。
5. scaffold を使う派生アプリは、4 プリセットの `pnpm scaffold --dry-run` が通ること。

### セキュリティ

- **RUSTSEC-2026-0459**（libsqlite3-sys 0.30.1 の同梱 SQLite）の `.cargo/audit.toml` での一時的な除外は、この版でも継続している。理由: sqlx 0.9.0 が libsqlite3-sys 0.39 以上を受け付けず、今は上げられない。見直しの条件: libsqlite3-sys 0.39 以上を許す sqlx のリリースが出たら `cargo update -p libsqlite3-sys` で上げ、除外を外す。派生アプリの `cargo audit` でも同じ警告が出る。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `ffffe2ed`、`workflow_dispatch`）: [run 44100460025](https://github.com/tyaro/banto/actions/runs/44100460025)（success）。
  - タグの push（`v7.3.0`、main の `ffffe2ed`）: [run 44100746626](https://github.com/tyaro/banto/actions/runs/44100746626)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。

    | 項目               | 版                              |
    | ------------------ | ------------------------------- |
    | Node.js            | 24.22.2                         |
    | pnpm               | 10.33.0                         |
    | Svelte             | 5.57.3                          |
    | SvelteKit          | 3.2.0                           |
    | Vite               | 8.3.8                           |
    | vite-plugin-svelte | 7.3.1                           |
    | TypeScript         | 6.0.3                           |
    | Rust               | 1.100.0（0ef1bc386 2026-11-09） |

  - 出所: Node.js は `node: v24.22.2`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、Rust は `Setup Rust toolchain` の `rustc 1.100.0`。

### 変更の一覧

- **banto-server**: 監査の記録に、主体と `origin` を引数で受ける公開関数を追加（#647。**公開 API の追加（minor）**、既存の挙動は不変）。`routes::{AuditActor { username, role }, record_write_as, record_denied_as}`。`record_write_as(audit, actor: Option<AuditActor>, origin, action, resource, entity_id, detail)` は `result = "ok"` の行を書き、API キー・MCP など、セッションの bearer ではない主体や REST 以外の経路から使える（`actor` が `None` なら主体の列は NULL）。`record_denied_as(audit, actor, origin, resource, detail)` は `require_role_at_least` が書く `denied` 行（`action = "denied"`・`entity_id` 無し・`result = "denied"`）と同じ形。既存の `record_write` は `record_write_as(…, "rest", …)` の薄い包みに、`require_role_at_least` は `record_denied_as` 経由にしたので、書かれる行の各列は従来と同じ。
- **ui**: 閉じた `Menu` の中で、選択中の `MenuItem` のチェックの印（`visibility: visible`）が見えないまま残り、メニューの下にある要素のクリックを横取りする不具合を修正（印を `visibility: inherit` に）。項目の多いチェックボックスのメニュー（一覧の「列」）で、閉じた後にグリッドの先頭行を押せなくなっていた。あわせて、`Menu` の矢印・Home・End のフォーカス移動を項目の現在の DOM 順にした（キー付き each で項目が並べ替わると、マウント順のままずれていた。列を並べ替えた後の「列」メニュー）。
- **admin-template**: 一覧画面の「列」を `@banto/ui` の `Menu`＋`MenuItem kind="checkbox"` に置き換えた（`ResourceListPage.svelte`。grid-svelte の `ColumnsMenu` は公開部品のまま変えておらず、テンプレートが使わなくなっただけ）。**派生アプリへの注意**: `ResourceListPage.svelte` の差分を取り込む。列メニューは `role=menu`＋`menuitemcheckbox` になり、選んでも閉じない（件数 `3/5` の表示、最後の 1 列の無効化と理由の `title`、client/server で列の一覧が切り替わる動作は従来どおり）。辞書キーの追加なし。`e2e/visual/columns-checkbox.spec.ts` を新しい形に合わせて書き換えた（native checkbox の寸法の確認は外れた）。
- **ui**: `MenuItem` にチェックボックスの形を追加（`kind?: 'radio' | 'checkbox'`・`title?: string`。**公開 API の追加（minor）**、既定の動きは不変）。`kind="checkbox"` かつ `checked` 指定で `role="menuitemcheckbox"`＋`aria-checked`、選んでもメニューを閉じず（`onSelect()` のみ・フォーカスはその項目に残る）、radio と普通の項目は従来どおり閉じる。`title` は button の `title` に出る（無効な項目の理由など）。ui-demo の Menu の見本に例を追加。
- **admin-template**: 使われていない辞書のキー `resource.groupByLabel`（#576 で「表示」メニューの `resource.groupByMenu` に置き換わった）と `settings.running`（接続の状態の文言を bind ごとに分けたときから未使用）を `messages/ja.json`・`en.json` から消した。画面の見た目・動きは不変。派生アプリが自分の画面でこれらのキーを使っていれば、自分の辞書に残すこと。ADR 索引の「ADR 化候補」から、ADR-0030 で記録済みの「リソースのルートを動的化しない」の項を外した（ADR-0030 の決定どおり）。

- **admin-template / admin-core / grid-svelte**: items の楽観ロックを画面に配線（#638 PR-2。**公開 API の追加（minor）**、省略時の動きは不変）。詳細フォームと一覧のセル編集・範囲貼り付けが行の `version` を送り、削除も `deleteOne(…, { version })`。保存が衝突したら、詳細フォームは差分のダイアログ（相手が変えた欄の「相手の値／あなたの値」、「相手の値を採る／自分の値で上書き／項目ごとに選ぶ」。送り直しは相手の `version` で、また衝突すれば再表示）、一覧はその行を最新値に戻して「他の人が変更したため保存しませんでした」（貼り付けは件数）、削除は「他の人が変更したため削除しませんでした」と知らせて最新値を表示。一覧のセル編集が送る `version` は編集を開いた時点の行のもの（SSE の再取得で他人の新しい版が届いても、その版では送らない）で、自分の保存の成功で進んだ版だけを追う（連続のセル編集・貼り付けは衝突しない）。grid-svelte: `CellEdit` に任意の `baseRow`（インライン編集で、編集を開いた時点の行。`row` は従来どおりコミット時に読み直した行。完全一致で比べるテストは `baseRow` を足す）。admin-core: `createFormResource` の `handlesConflict`、`SubmitResult` の失敗に任意の `conflict`、`FormResource.lastError`・`remove(options?)`、`conflictOf(err)`・型 `FormConflict`。新規文言 `resource.conflict*`（ja/en）。手順は [docs/recipes/add-resource.md](docs/recipes/add-resource.md)「楽観ロック」。Refs #638
- **admin-template / banto-core / banto-server / admin-core**: items に楽観ロックを追加（#638 PR-1。**minor**。消費側への注意あり）。migration `0011_items_version.sql`（sqlite・postgres。`items.version` 列の追加のみで既存の行は書き換えない。適用は起動時に自動）。`Item.version`（作成時 1、更新ごとに +1。CSV 取り込みは上書きのまま +1）、`ItemInput.version`（任意）と `DELETE /api/items/{id}?version=N`・Tauri `items_delete` の任意の `version` で比べ、違えば新しいエラー種別 `conflict`（REST 409、`{ kind: "conflict", message, current }`。`current` は相手の最新のレコード）。**`version` を送らなければ従来どおり上書き**（画面の配線と衝突のダイアログは下の PR-2）。衝突した更新・削除は監査に残さない（ほかの失敗と同じ）。監査の差分に `version` は出さない。`DataProvider.deleteOne` に任意の第 3 引数 `options?: DeleteOneOptions`（`{ version? }`）、InMemory も同じ規則。**消費側への注意**: Rust の `BantoError`・`ErrorBody` に `Conflict` が、TS の `ErrorBody` に `kind: 'conflict'` が増えたので、網羅的な `match`・`switch (body.kind)` に `conflict` を足す。自前で `ERROR_KINDS` の Set を持つなら `'conflict'` を足す（無いと `other` に落ちる）。自前の `DataProvider` 実装はそのまま動く（引数の追加は任意）。`ItemsService::delete_returning_previous` に引数 `expected_version: Option<i64>` が増え、`ItemInput` を構造体リテラルで作るなら `version: None` を足す。

- **admin-template / admin-core**: LAN ブラウザ（`server` モードのみ）に切断の帯を追加（#637 PR-2）。ヘッダー直下に「サーバーに接続できません。再接続しています…」/「ネットワークに接続されていません」＋「再読み込みすると、編集中の内容は消えます」＋「再試行」（セッション確認を 1 回）。復帰（応答・SSE の再接続・`online`）で帯が消え「再接続しました」を 1 回。画面の読み直しは SSE の再接続のときは二重にせず、要求・`online` のときだけ `invalidateAll` を 1 回（連続復帰はクールダウンで間引く）。切断で保存が失敗したときはフォームの入力・グリッドの編集中の値を残し、トーストを「接続できないため保存できませんでした。接続が戻ったら、もう一度保存してください。」に分ける（それ以外の失敗の文言は不変）。Tauri・デモでは出ない。**公開 API の追加（minor）**: `createFormResource(resource, id, { submitErrorMessage })`・型 `FormResourceOptions`（省略時の動きは不変）。新規文言 `connection.*`（ja/en）。手順は [docs/recipes/lan-access.md](docs/recipes/lan-access.md)。同時編集の検出は #638。Refs #637
- **admin-core**: 切断の判別・タイムアウト・接続状態のストアを追加（#637 PR-1。**公開 API の追加（minor）**、既存の kind・文言は不変）。`ProviderError` に任意の `networkFailure`（`'network' | 'timeout'`）と判定関数 `isNetworkError(e)`（`ErrorBody` の kind は増やさない）。`createHttpDataProvider` に `timeoutMs`（既定 `DEFAULT_REQUEST_TIMEOUT_MS` = 20 秒、本文の読み込みまで含む、`0` で無効）と `onRequestResult`（`HttpRequestResult`。4xx/5xx も「応答あり」）、`createHttpAuthProvider` に `resolveTimeoutMs`（既定 0）と `onRequestResult`（`resolve()` だけ）。`EventSubscriptionHooks.onDisconnected`（開いていた SSE を失ったとき 1 回）と `connectEvents(provider, { connection })`。`createConnectionMonitor()`（`online | reconnecting | offline`・最後の失敗と成功の時刻・`recoveries`・`onRecovered`。SSE の切断・連続 2 回のネットワーク失敗・`offline` イベントで切断、応答・SSE の復帰で復帰、古い要求の結果は捨てる。判定は純関数 `nextConnectionState`・`connectionStatusOf`）。ポーリングはしない。注意: データ要求の `fetch` の init に `signal` が付くようになった（init を完全一致で比べるテストは `signal: expect.any(AbortSignal)` を足す）。画面の帯と配線は PR-2。Refs #637
- **admin-template**: 3 ペインの見本 `/tree/workspace` の枠を画面の高さいっぱいにし（シェルの縦の余りを表す private な CSS 変数 `--banto-shell-main-block-inset` をページが引いて高さを決め、枠は残りを埋める。ドックの位置・kiosk・900px 以下に追随。下限 26rem）、右ペインに見出し（h2）を追加した（#631。**公開 API は変えない（patch）**）。`/tree/workspace` の visual 基準画像（Linux）の再生成が要る
- **admin-template / tree-svelte**: 3 ペインの画面の型の見本 `/tree/workspace` を追加（#631 PR③。`/tree` デモに含まれ、ツリーデモと一緒に scaffold で消える。**アプリ層のデモなので公開 API は変えない（patch）**）。左ツリー（バッジ・右クリックメニュー）・中央の固定タブ「一覧」「設定」・右の行詳細。選んだ対象・タブ・行を URL（`?target=&tab=&row=`、対象は push・タブと行は replace）に持ち、設定が未保存のときはタブの切り替え・別の対象・戻る/進む・別ページへの遷移で確認ダイアログを出す（キャンセルでツリーの強調・タブ・フォーカスも元に戻る）。各ペインの中身は枠に依存しない独立した部品。手順は [docs/recipes/three-pane-screen.md](docs/recipes/three-pane-screen.md)。あわせて `BantoTree` に任意の `selection` prop を追加（ホスト主導の選択。**公開 API の追加（minor）**、省略時の動きは不変）。`/tree/workspace` の visual 基準画像（Linux）の追加が要る
- **tree-svelte**: `BantoTree` に任意の prop を 3 つ追加（#631 PR②、banto-hub の `TreeView` から還元。**公開 API の追加（minor）**、既存の動きは不変）。`label`（`Snippet<[node, TreeLabelContext]>`。ラベルの見た目だけを差し替えてバッジを描ける。アクセシブル名は `node.label` のまま。編集中は入力欄、tree-grid は先頭列に効く）、`onContextMenu(node, {x, y})`（マウス右クリック・ContextMenu キー・Shift+F10 で通知。指定時だけ既定メニューを抑止。選択は動かさず、フォーカスだけ行へ移す）、`autoExpandNewRoots`（既定 false。初回と後から増えたルートを一度だけ展開し、ユーザーが閉じたルートは `nodes` の差し替えで再び開かない）。型 `TreeLabelContext` を追加。`/tree` デモに使用例を追加。
- **theme / dock / tree**: touch 密度で固定の小さい操作部品が育たず押しにくい問題を修正（#624）。dock の窓ボタン（22px / 20px）とツリーの開閉ボタン（20px）を `--banto-control-height-sm`（40px）に、dock のタイトルバーを 40px にした（新トークン `--banto-dock-button-size`・`--banto-tree-toggle-size`・touch 密度でのみ設定。標準・コンパクトは不変）。ロゴ（26px）は装飾のため据え置き。
- **theme**: 3 つ目の表示密度 `touch`（タッチ。`data-banto-density='touch'`）を追加（#624 PR-1）。操作高 `--banto-control-height` 48px（`-lg` 52px・`-sm` 40px）、グリッド行高 52px・ヘッダ 56px、root の文字サイズ 16px（rem の型スケールごと上がる。`space-*` の値は変えないが rem なので連れて約 14% 大きくなる）、シェルのヘッダ 56px・ランチャー項目 48px。**公開 API の追加（minor）**: `ThemeDensity` が `'standard' | 'compact' | 'touch'` になる。`ThemeDensity` を網羅的な `switch` で扱う派生アプリは `'touch'` の分岐の追加が要る（型検査で気づける）。`isThemeDensity('touch')` は真になり、設定の「表示密度」に「タッチ」が増える。派生アプリが `app.html` の first-paint スクリプトを持つなら `touch` を通す（`density === 'compact' || density === 'touch'`）。
- **charts**: 横向き `BarChart` の値軸の目盛り（`100,000` など）が、文字が大きいとき（touch 密度・キオスクの狭い幅）に重なる不具合を修正。原点（先頭）と末尾のラベルは残し、間を等間隔に間引く（グリッド線は全 tick のまま）。`ScatterChart` は右端の x 目盛り（`¥250` など）が右余白 16px 固定で欠けていたので、末尾ラベルの幅から右余白を決める。
- **dashboard / theme**: キオスク表示（`settings.kiosk`）で dashboard の KPI を大きくする（#624 PR-2。数字 48px・ラベル 16px・アイコン 56px、タイルの最小幅 280px。375px では数字を 9vw に縮める）。`@banto/theme` に文字サイズのトークン `--banto-font-size-3xl`（48px）を追加（公開 API の追加）。キオスクの dashboard の visual 基準画像（Linux）は再生成が要る
- **charts**: `LineChart` の x 軸で、末尾（右端寄せ）のラベルと手前のラベルが重なる不具合を修正。ラベルの推定幅で重なりを判定し、末尾を残して手前の目盛りを間引く（純関数 `dropCollidingTicks`）。コンパクト密度の dashboard の visual 基準画像（Linux）は再生成が要る
- **charts**: 文字が大きいとき（touch 密度）に x 軸の末尾ラベルが右端で欠ける不具合を修正（#624）。`Histogram`・`GanttChart` は右余白を末尾の目盛りラベルの幅から決める（既定の 16px 以上、`margins.right` の指定は下回らない）。縦向き `BarChart`（積み上げ・グループ含む）のカテゴリラベルは、多いか文字が大きく重なるとき先頭と末尾を残して間引く（棒とグリッド線は全カテゴリのまま。純関数 `thinCategoryLabels`）。visual 基準画像（Linux）は再生成が要る

- **theme**: コンパクト密度（`data-banto-density='compact'`）で余白トークン `--banto-space-3`〜`--banto-space-6` を 1 段下の値にした（#623 PR-1。D3 を案 a に変更。文字の段は変えない）。見た目の変更で公開 API は変わらない。`MenuItem` のチェック枠は余白トークンから `1rem` へ（標準密度では見た目不変）
- **ui**: 3 ペインの枠 `ThreePaneLayout` を追加（#631 PR-1。**公開 API の追加（minor）**: `ThreePaneLayout`・型 `ThreePaneLayoutProps`・`PaneFitInput`・純関数 `clampPaneWidth` / `fitPaneWidths` / `paneMaxWidth` / `isNarrowWidth`・`THREE_PANE_DEFAULTS`、`UiMessages` のキー `threePaneLeft` / `threePaneRight` / `threePaneResizeLeft` / `threePaneResizeRight`）。左（対象の選択）・中央（帯に左右の開閉ボタンと対象名）・右（選んだ行の詳細）をスニペットで受け、広い幅では左右を畳め、境界（`role="separator"`）をドラッグか ←→・Home・End で幅を変える（幅は bindable、中央の最小幅を守って左右が縮む）。枠自身の幅が 900px 以下（`narrowBreakpoint`）では左右がドロワー（Esc・背景のクリックで閉じ、フォーカスは開いたボタンへ戻る）。ui-demo に見本を追加。
- **ui**: `SurfaceCard` に `tone`（`primary` / `default` / `subtle`、既定は従来の見た目）を追加し、カードの面を 3 段に（トークン `--banto-card-*`、dashboard の KPI 行・主役チャート・標準カードへ適用）（#623 PR-2）

## [7.2.0] - 2026-11-17

**v7.2.0 — ナビの「メニューバー」表示（`@banto/ui` の `HeaderNav`、テンプレートの `ShellMenubar`・ナビのグループ）、レコード履歴の充実（添付の追加・削除、`items`・`users` の create/delete と `users` の update の差分）、ログイン画面の接続先・版・お知らせ、監査表への生成列と索引（migration 0010）。** 版の種類: minor（機能追加。公開 API の削除・改名は無い）。理由: `crates/*/src` の `pub` の削除と `packages/*/src/index.ts` の export の削除は無い（追加は `@banto/ui` の `HeaderNav` 一式ほか）。監査 `detail` の形の追加（`changes`・`parentResource`・`parentId`）と汎用 `SettingsService::set` / `set_many` の `login.notice` 拒否は、追加または運用上の挙動変更で、[docs/publishing.md](docs/publishing.md)「バージョニング規約」の運用上の例外（移行手順を「消費側への注意」に明記して minor）に当たる。migration 0010 は既存の列・行を変えない追加（生成列と索引）で、同じ規約の「DB の migration の扱い」により minor（前例 v1.7.0・v6.5.0。旧版へ戻すには更新前のバックアップの復元が要る点は C 節の「戻せる条件」）。既存のデータを書き換える・消す変更は無い。
派生アプリへの影響: git 依存のタグを `v7.1.0` から `v7.2.0` に上げるだけなら、コンパイルエラーになる変更は無い。ただし監査の新フィルタ（`recordResource`・`recordId`）を使うには `audit_log` の生成列と索引（migration 0010）が要る。`users` の `update` の監査 `detail` を読む処理、`login.notice` を汎用の設定 API で書く処理があれば確かめる。コピーしたテンプレートを取り込む場合は、migration 0010、辞書のキー（追加 38 キー・書き換え 1 キー）、メニューバー表示の配線が中心になる。

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v7.1.0` → `v7.2.0`（npm と Rust を同じタグに）。API の削除・改名は無い。追加のみ（`HeaderNav`・`LauncherItem.separatorBefore`・`--banto-shell-menubar-*`・`SettingsService` のお知らせ操作・`DockHost.iconContent`・`UsersService::update_user_returning_previous` / `delete_user_returning_previous`・監査一覧の `recordResource` / `recordId` フィルタ）。監査 `detail` の形と `login.notice` の扱いに注意（下の「消費側への注意」） |
| B. コピーしたテンプレート        | あり | メニューバー表示（`ShellMenubar`・ナビのグループ）、レコード履歴の添付・create/delete・users の差分、ログイン画面のお知らせ、glass の調整、辞書のキー（追加 38・書き換え 1）、migration 0010。取り込みは任意（メニューバーは選ばなければ見た目は変わらない）                                                                                                                                                                            |
| C. DB・設定・配布資産            | あり | migration 0010（監査表の生成列 `record_resource`・`record_id` と複合索引。PostgreSQL は既存の監査表を書き直す）。設定キー `login.notice` が増えた（汎用の設定 API では書けない）。`tauri.conf.json` は版数のみ。`.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続                                                                                                                                                               |

### A. 共通パッケージ・クレート

- 対象: `@banto/ui`・`@banto/theme`・`@banto/charts`・`@banto/grid-svelte`・`@banto/admin-core`・`@banto/attachments`・`@banto/report`・`@banto/dock-svelte`・`@banto/tree-svelte`・`banto-core`・`banto-storage`・`banto-admin-services`・`banto-server`。
- 更新: `v7.1.0` → `v7.2.0`（npm と Rust を同じタグに）。
- 追加 API（いずれも任意。既定の挙動は維持）:
  - `@banto/ui`: `HeaderNav`・`headerNav*`（`fitCount`・`headerNavTopRowTarget` など）・`HeaderNavLink`・`HeaderNavEntry`、`LauncherItem.separatorBefore`。
  - `@banto/theme`: `--banto-shell-menubar-*`（5 トークン）。
  - `@banto/dock-svelte`: `DockHost.iconContent`（保存済みのアイコン文字列をアプリ側で描く任意の snippet。省略時は従来どおり文字のまま）。
  - `banto-admin-services`: `SettingsService` のお知らせ操作、`UsersService::update_user_returning_previous`・`delete_user_returning_previous`、users の detail 生成関数（`users::user_update_detail` ほか）、監査一覧の `recordResource`・`recordId` フィルタ。
  - テンプレート（B）の `admin_template_core`: `ItemsService::delete_returning_previous`（公開パッケージ・クレートではない）。
- 移行注意（ソース互換の破壊）: 無い。
- 消費側への注意（型エラーにはならないが、確かめるもの）:
  1. **監査 `detail` の最上位 `parentResource`・`parentId` が全リソースで予約キーになった**（関連レコード用。どちらも文字列で記録する）。自前の監査 `detail` でこの名前を別の意味で使っていれば改める。
  2. **`users` の `update` の監査 `detail` の形**: `{ role }` から `{ username, role, changes: [{ field, before, after }] }` になった（`role` は残す）。`detail` を機械で読む処理があれば `changes`・`username` が増えた点を確かめる。
  3. **items・users の create/delete の監査 `detail` に `changes` が増えた**（create は `before: null`、delete は `after: null`。既存の `name`／`username`／`role`・`attachmentsRemoved` は維持。古い記録は従来のまま）。`users` の資格情報・認証状態、生成 ID・時刻は記録しない。ユーザー削除後も表示名は監査ログの保持ポリシーで整理されるまで残る。
  4. **migration 0010（監査表の生成列と索引）**: 共通クレートだけを更新する派生アプリでも、新フィルタ（`recordResource`・`recordId`）を使う前に `audit_log` へ生成列 `record_resource`・`record_id` と索引を追加する（DDL は [SQLite](apps/admin-template/core/migrations-sqlite/0010_audit_record_scope.sql) / [PostgreSQL](apps/admin-template/core/migrations-postgres/0010_audit_record_scope.sql)）。PostgreSQL は生成列の追加で既存の監査表を書き直すので、監査行が多いと起動時の migration に時間がかかる（メンテナンス時間内に適用する）。PostgreSQL の監査 INSERT は、以後も生成列の JSON 抽出関数を 1 行 2 回呼ぶ費用がかかる。
  5. **汎用の `SettingsService::set` / `set_many` で `login.notice` を書くと拒否される**。お知らせは専用の公開 GET と admin 限定 PUT（REST・Tauri の両経路）で扱う。監査には設定キーだけを記録する。
  6. **添付アップロードの対象を実在する `items` に限った**（テンプレート）: 未対応リソースは 400、存在しない親は 404、成功監査行は作らない。派生アプリが添付先を増やす場合は共通の親検証を拡張する。
- 依存を上げずに留まれるか: できる（`v7.1.0` のタグに固定したまま使える）。

### B. コピーしたテンプレート

- 対象ファイル・ルート: `ShellMenubar.svelte`（新規）・`Header.svelte`・`(app)/+layout.svelte`・`Sidebar.svelte`・`ShellLauncher.svelte`・`navigation.ts`・`resource/types.ts`・`commands.ts`・`settings.svelte.ts`・`AppearanceSection.svelte`、`loginBrand.ts`・ログイン画面、レコードの履歴タブ（`lib/resource/`）・`auditChanges.ts`、添付のアップロード・`items`・`users` の監査 detail（`core/src`）、`messages/*.json`、`core/migrations-*/0010_audit_record_scope.sql`。
- 関連 PR・コミット: nav-menubar 計画（#616〜#620）、#597 の続き（#606・#607・#608）、#609（#610）。
- 手で取り込む変更（辞書のキー。**`messages/*.json` の差分をまとめて取り込む**。v7.1.0 の `ja.json` との比較では、削除は 0 キー、追加は 38 キー（966 → 1004）、値の書き換えは 1 キー `settings.navLayoutDesc`（3 択の説明）。`en.json` は見ていない）。
- 手で取り込む変更（そのほか）:
  - migration 0010（SQLite・PostgreSQL）を適用する。
  - メニューバー表示（`NavLayout` の `'menubar'`・`ShellMenubar`・`Header`・`(app)/+layout`）。使わない派生アプリは、`ShellMenubar.svelte` と参照する分岐をまとめて取り込まない（[upgrading.md 例 6](docs/upgrading.md)）。
  - ナビのグループ（`NavGroupKey`・`NavItem.group`・`ResourceNav.group`・`navBarEntries()`）。
  - レコードの履歴タブ（添付・create/delete・users の差分）と、`items` の添付アップロードの親検証。
  - ログイン画面の接続先・アプリ版・お知らせ（`loginBrand.ts`、お知らせの公開 GET と admin 限定 PUT）。
- 派生側の独自変更と衝突しやすい箇所: `Header.svelte`・`(app)/+layout.svelte`・`Sidebar.svelte`・`messages/*.json`・`core/src` の audit・attachments・users・items・settings。
- 取り込まなくても動くか: 動く見込み。A のタグを `v7.2.0` に上げるだけなら、テンプレートの取り込みは不要（既定はサイドバーのまま）。Git 依存での導入は下の「検証した組み合わせ」で確かめた（テンプレートを取り込まない派生アプリそのものでの確認は未実施）。
- 手本: 上記の `apps/admin-template/` のファイル。

### C. DB・設定・配布資産

- マイグレーション: 0010（`audit_log` の生成列 `record_resource`・`record_id` と複合索引。SQLite・PostgreSQL）。コピーしたテンプレートと、新フィルタを使う派生アプリが適用する。PostgreSQL は既存の監査表を書き直す。
- 設定キー・`tauri.conf.json`: 設定キー `login.notice` が増えた（ログイン画面のお知らせ。汎用の設定 API では書けない）。`tauri.conf.json` は版数のみ。
- 配布物: 変更なし。
- 依存監査: `.cargo/audit.toml` の RUSTSEC-2026-0459 の一時除外は継続（下の「セキュリティ」）。
- 戻せる条件: 新版を本番 DB で最初に起動するまで（以降はバックアップの復元）。migration 0010 を適用した DB は `_sqlx_migrations` に 10 が残り、0009 までしか持たない v7.1.0 のバイナリは起動時の migration の検証で拒否するので、タグを戻すだけでは戻らない。起動前に DB のバックアップを取り、戻すときは [upgrading.md §4](docs/upgrading.md#4-db設定配布資産の移行) のとおり更新前のバックアップを復元する（更新後に書いたデータは失われる）。
- 順序: A・B を先に完成 → 検証用 DB で migration 0010 を適用 → 本番（PostgreSQL はメンテナンス時間内）。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画される）。
2. 辞書のキー（`messages/*.json`）の取りこぼしが無いこと（画面に生のキーが出ない）。設定の「外観」で 3 つの表示を切り替えられること。visual の基準画像の更新が要るか。
3. Rust: `cargo check` / `cargo test`。migration 0010 の適用後、レコードの履歴タブに添付の追加・削除が出ること。
4. scaffold を使う派生アプリは、4 プリセットの `pnpm scaffold --dry-run` が通ること。

### セキュリティ

- **RUSTSEC-2026-0459**（libsqlite3-sys 0.30.1 の同梱 SQLite）の `.cargo/audit.toml` での一時的な除外は、この版でも継続している。理由: sqlx 0.9.0 が libsqlite3-sys 0.39 以上を受け付けず、今は上げられない。見直しの条件: libsqlite3-sys 0.39 以上を許す sqlx のリリースが出たら `cargo update -p libsqlite3-sys` で上げ、除外を外す。派生アプリの `cargo audit` でも同じ警告が出る（banto の `.cargo/audit.toml` は派生アプリに届かない）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `5cf8406c`、`workflow_dispatch`）: [run 43900312103](https://github.com/tyaro/banto/actions/runs/43900312103)（success）。
  - タグの push（`v7.2.0`、main の `5cf8406c`）: [run 43901229771](https://github.com/tyaro/banto/actions/runs/43901229771)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。

    | 項目               | 版                              |
    | ------------------ | ------------------------------- |
    | Node.js            | 24.22.2                         |
    | pnpm               | 10.33.0                         |
    | Svelte             | 5.57.3                          |
    | SvelteKit          | 3.2.0                           |
    | Vite               | 8.3.8                           |
    | vite-plugin-svelte | 7.3.1                           |
    | TypeScript         | 6.0.3                           |
    | Rust               | 1.100.0（0ef1bc386 2026-11-09） |

  - 出所: Node.js は `node: v24.22.2`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、Rust は `Setup Rust toolchain` の `rustc 1.100.0`。

### 変更の一覧

- 共通パッケージ（A）: ナビの「メニューバー表示」の部品（nav-menubar 計画 PR-2・PR-5。PR #617・#618）。`@banto/ui` に `HeaderNav`（ヘッダーに並べるリンク列。グループのドロップダウン、入りきらない項目の「その他」、未読バッジ、矢印・Home / End での移動）と、その純粋関数（`fitCount`・`headerNavTopRowTarget` など `headerNav*`）・型（`HeaderNavLink`・`HeaderNavEntry`）を追加。`LauncherItem` に任意の `separatorBefore`（`LauncherBar` が項目の前に区切り線を描く）を追加。`@banto/theme` に `--banto-shell-menubar-*` のトークン 5 つ（余白・項目の間隔・下線の太さ・ページ名の最大幅・ドロップダウンの最小幅）を追加。いずれも追加のみで、使わなければ従来どおり。
- テンプレート（B）: ナビの「メニューバー」表示（nav-menubar 計画。PR #616・#617・#618・#619）。設定の「外観」の表示形式に 3 つ目の `'menubar'`（ヘッダーに主要ナビを並べる。ユーザーごと。保存先は既存の `shell.navLayout` で、サーバー・DB の変更なし）。`ShellMenubar.svelte` の新設、`Header.svelte`・`(app)/+layout.svelte` の分岐（900px 以下と、メニューバーが入りきらないときはサイドバーをドロワーとして使う）。ナビの項目をまとめる `NavItem.group` / `ResourceNav.group`（`NavGroupKey`、`navBarEntries()`。デモ専用の 2 項目に「見本」グループ）。サイドバーはグループを見出しに、ドックは区切り線にする。コマンドパレットのナビ項目の `keywords` にグループ名を追加。辞書に `settings.navLayoutMenubar`・`shell.navMore`・`shell.openCommandPaletteWithShortcut`・`nav.group.demo` を追加し、`settings.navLayoutDesc` を 3 択の説明に書き直した。既定は従来どおりサイドバーで、選ばなければ見た目は変わらない。
- テンプレート（B）／共通クレート（A）: #609（A-3・A-5・B-7）。glass の固定ヘッダーとランチャーの透け・ぼかしを調整し、分析ワークスペースの絵文字を保存済み Dock 配置にも追従する線アイコンに変更。ログイン画面に接続先・アプリ版・管理者のお知らせを表示し、ブランドのロゴ・背景・コピーを `loginBrand.ts` に集約。お知らせは専用の公開 GET と admin 限定 PUT を REST/Tauri 双経路に追加し、監査には設定キーだけを記録する。汎用の `SettingsService::set` / `set_many` から `login.notice` を書くことは拒否する。公開 API の追加（`SettingsService` のお知らせ操作、`DockHost.iconContent`）のため minor。
- テンプレート（B）／共通クレート（A）: レコードの履歴タブに添付ファイルの追加・削除も表示する。既存の添付監査 detail の `parentResource`・`parentId` を履歴検索に使い、監査行自身の `resource: attachments`・`entityId` は維持する。親キーのある行の履歴検索先 `recordResource`・`recordId` は親に切り替わる。添付自身を探す場合は従来の `resource`・`entityId` フィルタを使う。監査一覧の `recordResource`・`recordId` フィルタを追加（公開 API の追加＝minor）。監査 detail の最上位 `parentResource`・`parentId` は全リソースで関連レコード用の予約キーになり、どちらも文字列で記録する。migration 0010 で SQLite・PostgreSQL の監査表に記録先の生成列と複合インデックスを追加し、既存行・新規行を同じ対象に絞る。**共通クレートだけを更新する派生アプリでも、新フィルタを使う前に `audit_log` へ生成列 `record_resource`・`record_id` と索引を追加する必要がある**（DDL は [SQLite](apps/admin-template/core/migrations-sqlite/0010_audit_record_scope.sql) / [PostgreSQL](apps/admin-template/core/migrations-postgres/0010_audit_record_scope.sql)）。テンプレートを取り込む場合は migration 0010 も適用する。PostgreSQL は生成列の追加時に既存の監査表を書き直すため、監査行が多い場合は起動時の migration に時間がかかる。運用環境ではメンテナンス時間内に適用する。
  テンプレートの添付アップロードは、実在する `items` レコードに限る。未対応リソースは 400、存在しない親は 404 とし、成功監査行を作らない。派生アプリが添付先を増やす場合は共通の親検証を拡張する。既存の添付データや監査行は移行時に遡及検証しない。旧版の添付を削除するときに親が無効なら、削除監査には親キーを付けない。旧版で任意の親を指定して作られた監査行は移行後もその親の履歴に出る可能性があるため、疑わしい行は元の `resource`・`entity_id` と照合する。PostgreSQL の監査 INSERT には、以後も生成列の JSON 抽出関数を1行2回呼ぶ費用がかかる。
- テンプレート（B）／共通クレート（A）: `items`・`users` の create/delete の監査 `detail` に、公開可能な業務値を `changes`（create は `before: null`、delete は `after: null`）として記録し、監査ログ詳細とレコード履歴に表示する。REST・Tauri は同じ生成関数を使い、削除した行は `DELETE ... RETURNING` で取得する。`users` の資格情報・認証状態、生成 ID・時刻は記録しない。既存の `name`／`username`／`role` と `attachmentsRemoved` は維持。公開 API に `ItemsService::delete_returning_previous`、`UsersService::delete_user_returning_previous` と detail 生成関数を追加（minor）。古い記録は従来の表示のまま。ユーザー削除後も表示名は監査ログの保持ポリシーで整理されるまで残るため、個人名を使う場合はバックアップを含めた保持方針を確認する。
- テンプレート（B）／共通クレート（A）: `users` の `update` の監査にも差分を記録して表示する（#597 の続き）。監査 `detail` は `{ role }` から `{ username, role, changes: [{ field, before, after }] }` になった（`role` は従来の読み手のため残す。`username` は対象を示す。変わった欄だけ・変化が無ければ `changes` は空配列・`id`・`username`・`createdAt` は除く）。差分は `audit::diff::diff_changes` で作り、秘密の欄名（`password`・`passwordHash`・`authEpoch`）は将来欄が増えたときの防御としてマスクに挙げた。公開 API の追加: `banto-admin-services` の `UsersService::update_user_returning_previous`（同じ書き込みトランザクションの guard の SELECT で旧行を読み、`(旧, 新)` を返す。追加の読み取りは無い。最後の admin を外せない判定と `auth_epoch` の扱いは `update_user` のまま。`update_user` はシグネチャを変えず、これを呼んで新しい行だけ返す）と、REST・Tauri が共有する `users::user_update_detail`（`admin_template_core::users::user_update_detail` からも使える）。フロントは `lib/resource/auditChanges.ts` が `users` の欄名（表示名・ロール）とロールの値（管理者・編集者・閲覧者）を既存のメッセージ（`common.displayName`・`common.role`・`role.*`）で表示する。`detail` の形が変わるので、`users` の `update` の監査 `detail` を読む派生アプリは `changes`・`username` が増えた点に注意（既存の `role` は変わらない）。

## [7.1.0] - 2026-11-14

**v7.1.0 — 一覧・詳細の画面の共通化（`ResourceListPage`・`ResourceDetail`、ADR-0030）、一覧のクイック検索・保存ビュー・絞り込みチップ、行のドロワーと履歴タブ、監査ログの更新差分、`@banto/ui` の `Button`・`ConfirmDialog`・`Tabs`、配色（OKLCH）と文字スケールの見直し。** 版の種類: minor（機能追加。公開 API の削除・改名は無い）。理由: `crates/*/src` の `pub` の削除と `packages/*/src/index.ts` の export の削除は無い。メッセージキーの移動・削除は ADR-0030 の決定で minor 扱い。items の `update` の監査 `detail` に `changes` が増えたのは追加。`ListParams` への `search` の追加は、[docs/publishing.md](docs/publishing.md)「バージョニング規約」の 1.x 系の例外（フィールド追加は「消費側への注意」に明記して minor）。
派生アプリへの影響: git 依存のタグを `v7.0.0` から `v7.1.0` に上げると、Rust で `ListParams { .. }` を全フィールド列挙で組み立てているコードと、`append_where` で件数を数えているサービスが追従を要する。コピーしたテンプレートを取り込む場合は、辞書のキーの移動・削除と、一覧のルートの差し替えが中心になる。マイグレーションの追加は無い。

| 経路                             | 影響         | 内容                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり         | `v7.0.0` → `v7.1.0`（npm と Rust を同じタグに）。API の削除・改名は無い。`ListParams` のフィールド追加（#578）は全フィールド列挙の構造体リテラルをコンパイルエラーにする（規約の例外で minor。下の「移行注意」）。ほかに見た目（文字サイズ・配色・チャートの色）の変更がある。追加 API 多数。下の「消費側への注意」 |
| B. コピーしたテンプレート        | あり         | 一覧・詳細の共通部品（`lib/resource/`）への切り出し、辞書のキーの移動・削除（`items.*` → `resource.*` ほか）、ドロワー・履歴タブ・保存ビュー・クイック検索、監査ログの差分、LAN 共有の画面、アイコン。取り込みは任意                                                                                                |
| C. DB・設定・配布資産            | アイコンのみ | migration の追加なし。設定キー・`tauri.conf.json`（版数のみ）は変更なし。配布物はアプリのアイコンの画像だけが変わる（`src-tauri/icons/`、#586）。`.cargo/audit.toml` に RUSTSEC-2026-0459 の一時除外が入った                                                                                                        |

### A. 共通パッケージ・クレート

- 対象: `@banto/ui`・`@banto/theme`・`@banto/charts`・`@banto/grid-svelte`・`@banto/admin-core`・`@banto/attachments`・`@banto/report`・`@banto/dock-svelte`・`@banto/tree-svelte`・`banto-core`・`banto-storage`・`banto-admin-services`・`banto-server`。
- 更新: `v7.0.0` → `v7.1.0`（npm と Rust を同じタグに）。
- 追加 API（いずれも任意。既定の挙動は維持）:
  - `@banto/ui`: `Button`・`ConfirmDialog`・`Tabs`（任意の `keepMounted`）・`SegmentedControl`・`Tooltip`・`MenuItem` の任意の `checked`。
  - `@banto/grid-svelte`: `FilterChips`・`searchRows`・`searchableColumns`。
  - `@banto/admin-core`: `ListParams.search`・`InMemorySeed.searchFields`・`isListViewSnapshot`。
  - `banto-core`: `ListParams.search`・`ListParams::search_term()`。
  - `banto-storage`: `ColumnMap::text_column`・`text_columns()`・`list_query::{sqlite,postgres}::append_list_where`。
  - `banto-admin-services`: `audit::diff::diff_changes`。
  - `@banto/theme`: 役割ベースの配色トークン（`--banto-brand-hue` など）、`--banto-font-size-2xl`、`.banto-btn`（`app.css` から移した）。
- 移行注意（ソース互換の破壊。API の削除・改名は無いので docs/publishing.md「バージョニング規約」の例外で minor）:
  1. **`banto-core`: `ListParams` にフィールド `search` が増えた**（#578）。**`ListParams { .. }` を全フィールド列挙で組み立てているコードはコンパイルエラーになる**ので、`search: None`（か `..Default::default()`）を足す。`append_where` は filters だけを書く（search は入らない）ので、`apply_list_params` の横で件数の `COUNT(*)` を `append_where` で数えているサービスは `append_list_where` に替える（替えないと検索中の件数が合わない）。クイック検索を効かせたいリソースは `column_map()` の文字列の列を `text_column` で登録する。
- 消費側への注意（型エラーにはならないが、確かめるもの）:
  1. **文字スケールの変更**（#557 の 1）: `--banto-font-size-xs`〜`xl` の値が変わり（`xl` は 24.5px → 20px）、旧 `xl` の振り分けが変わった。Gauge の値と dashboard の KPI の値は `2xl`（28px）へ、ログインの見出し・ブランド名は `xl` のまま（20px）。独自に `--banto-font-size-*` を上書きしている派生アプリは値を見直す。visual の基準画像の更新が要る。
  2. **配色・チャートの色の変更**（#557 の 2・3、#581）: 色の値が変わる。`--banto-primary` だけを上書きしている派生アプリは塗りの色も変わる。`SEQ_RAMP` を hex として読んでいた派生アプリは `getComputedStyle` の値を使う。visual の基準画像の更新が要る。
  3. **`.banto-btn` の CSS を `@banto/theme` へ移した**。`app.css` で `.banto-btn` を自前で上書きしている派生アプリは読み込み順を確認する。
  4. **`@banto/admin-core`: `ResourceDefinition.icon` を非推奨にした**（ADR-0030 §5。画面は読まない。削除はしていない）。ナビのアイコンはアプリ層の `nav.icon`（`AppResourceDefinition`）を使う。
  5. **監査ログの `detail` の形**（#598）: items の `update` の `detail` が `{ name, changes: [{ field, before, after }] }` になった（`name` は残る）。`detail` を機械で読む処理があれば確かめる。create・delete・users などは変えていない。
  6. メッセージ: `@banto/grid-svelte`・`@banto/charts`・`@banto/attachments`・`@banto/report`・`@banto/dock-svelte`・`@banto/tree-svelte` は、`messages` を後から差し替えても文言が追従するようになった（#600〜#603）。`@banto/ui` の `Tooltip`、`@banto/admin-core` の `createSseEventProvider`、`@banto/charts` の `sequentialColor`・`divergingColor` の修正も入った（挙動が直るもの）。
- 依存を上げずに留まれるか: できる（`v7.0.0` のタグに固定したまま使える）。

### B. コピーしたテンプレート

- 対象ファイル・ルート: `apps/admin-template/src/lib/resource/`（`ResourceListPage`・`ResourceDetail`・`ResourceServerGrid`・`ResourceClientGrid`・履歴タブ・CSV 取込）、`resources/items.ts`、items の一覧・詳細のルート、`routes/(app)/audit-log/`、`routes/(app)/dashboard/`、`/chart-gallery`、`routes/(app)/settings/`（LAN 共有）、`app.css`、`messages/*.json`、アプリのアイコン（`static/`・`src-tauri/icons/`）、`core/src` の items・audit まわり（`items::item_update_detail`・`column_map()`）。
- 関連 PR・コミット: ADR-0030（#566〜#572）、#555（#576〜#579）、#556（#573〜#575）、#557（#580・#583・#584・#587）、#558（#588）、#591（#592・#593・#596）、#597（#598・#599）。個々の番号は下の「変更の一覧」。
- 手で取り込む変更（辞書のキーの移動・削除。**`messages/*.json` の差分をまとめて取り込む**。v7.0.0 の `ja.json` との比較では、削除は 78 キー（うち `items.*` が 53）、追加は 214 キー）:
  - `items.*` → `resource.*` の移動（値は同じ）: 一覧の操作（`viewMenu`・`modeToggleAria`・`modeClient`・`modeServer`・`groupByLabel`・`groupByClientOnly`・`groupNone`・`exportCsv`・`exported*`・`create`・`colActions`・`rowCount` など）、詳細・新規作成（`notFoundTitle`・`notFoundDesc`・`deleteConfirm`）、CSV 取込（`importCsv` から `importSucceeded` まで）。移動は計 40 キーを超える。
  - 削除: `items.createTitle`・`items.editTitle`（`resource.createTitle`・`resource.editTitle` を使う）、`items.loadError`・`items.loadErrorDesc`・`items.note`、`dashboard.aboutSummary`（注釈ドロワーに移した）、使わなくなった `resource.importRunning`・`resource.exporting`・`backup.creating`・`settings.reachIssuing`（`Button loading` に替えた）、`resource.open`（`resource.openRecord` に替えた）。dashboard のチャート見本の文言は `chartGallery.*` へ移った。
  - 替え: `items.importUpdateNote` → `resource.importUpdateNote`（`{columns}` を取る）、`items.demoImportUnavailable` → `resource.importUnavailable`、`items.filterExcludedNotice` → `resource.filterExcludedNotice`（`{resource}` を取る）。
  - 形が変わる: `dashboard.statLowStock` は `{threshold}` を取る（キー名は同じ）。
- 手で取り込む変更（そのほか）:
  - クラス名 `items-row-last-opened` → `resource-row-last-opened`（独自の CSS・テストが参照していれば追従する）。
  - `ResourceListPage` の `actions` snippet は「…」メニュー（`role="menu"`）の中に描かれる。`<button>` ではなく `@banto/ui` の `MenuItem` を渡す（#576。items の日報も `MenuItem` に替えた）。
  - 一覧の「開く」列はリンク（`a.cell-link`）からボタンに替わった。`getByRole('link', { name: '開く' })` で行を開いているテスト・e2e は直す。
  - items の `column_map()` の `text_column` と、件数のクエリの `append_list_where`（`core/src`）。
  - 監査ログ: `audit/diff.rs`・`ItemsService::update_returning_previous`・`AuditChanges.svelte`・`lib/resource/auditTarget.ts` の差し替え。
- 派生側の独自変更と衝突しやすい箇所: items の一覧・詳細のルート、`resources/items.ts`、`messages/*.json`、`app.css`、dashboard、settings の接続カテゴリ、`core/src` の items・audit。
- 取り込まなくても動くか: 動く見込み。A のタグを `v7.1.0` に上げるだけなら、テンプレートの取り込みは不要。ただし A の「移行注意」1（`ListParams`・`append_where`）と「消費側への注意」1・2（見た目）は A のタグに伴う。Git 依存での導入は下の「検証した組み合わせ」で確かめた（テンプレートを取り込まない派生アプリそのものでの確認は未実施）。
- 手本: 上記の `apps/admin-template/` のファイル。

### C. DB・設定・配布資産

- マイグレーション: 不要（追加なし）。
- 設定キー・`tauri.conf.json`: 変更なし（`tauri.conf.json` は版数のみ）。
- 配布物: アプリのアイコンの画像だけが変わる（`src-tauri/icons/`。#586）。派生アプリが独自のアイコンを使っていれば影響しない。
- 依存監査: `.cargo/audit.toml` で RUSTSEC-2026-0459（libsqlite3-sys の同梱 SQLite）を、理由と見直しの条件をつけて一時的に除外している（下の「セキュリティ」）。
- 戻せる条件: DB の変更が無いので、タグを戻せば戻る。
- 順序: A・B を先に完成 → 検証用 DB で起動 → 本番。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画される）。
2. 辞書のキー（`messages/*.json`）の取りこぼしが無いこと（画面に生のキーが出ない）。visual の基準画像の更新が要るか。
3. Rust: `cargo check` / `cargo test`（`ListParams` の組み立てと件数のクエリ）。

### セキュリティ

- **RUSTSEC-2026-0459**（libsqlite3-sys 0.30.1 の同梱 SQLite）を `.cargo/audit.toml` で一時的に除外している。理由: sqlx 0.9.0 が libsqlite3-sys 0.39 以上を受け付けず、今は上げられない。見直しの条件: libsqlite3-sys 0.39 以上を許す sqlx のリリースが出たら `cargo update -p libsqlite3-sys` で上げ、除外を外す。派生アプリの `cargo audit` でも同じ警告が出る（banto の `.cargo/audit.toml` は派生アプリに届かない）。同じ理由で除外するか、sqlx の更新を待つ。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `c3158c1`、`workflow_dispatch`）: [run 43606765436](https://github.com/tyaro/banto/actions/runs/43606765436)（success）。
  - タグの push（`v7.1.0`、main の `c3158c1`）: [run 43606988779](https://github.com/tyaro/banto/actions/runs/43606988779)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。

    | 項目               | 版                              |
    | ------------------ | ------------------------------- |
    | Node.js            | 24.22.2                         |
    | pnpm               | 10.33.0                         |
    | Svelte             | 5.57.3                          |
    | SvelteKit          | 3.1.1                           |
    | Vite               | 8.3.6                           |
    | vite-plugin-svelte | 7.3.1                           |
    | TypeScript         | 6.0.3                           |
    | Rust               | 1.100.0（0ef1bc386 2026-11-09） |

  - 出所: Node.js は `node: v24.22.2`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.100.0`。

### 変更の一覧

- テンプレート（B）: 監査ログ画面の詳細に「対象を開く」リンクを足した（#597 の段 2）。選んだ記録の `resource`・`entityId` から、その resource の一覧画面を `?id=<entityId>` 付きで開く（ドロワーでそのレコードが開く。狭い画面は従来どおり詳細ページへ進む）。resource 名→パスは登録済みの `resources` から引く（対応表は持たない）。`delete` の記録・画面の無い resource（users・attachments など）・`entityId` の無い記録にはリンクを出さない。純関数は新しい `lib/resource/auditTarget.ts`、メッセージは `audit.openTarget`（en/ja）。派生アプリは `lib/resource/auditTarget.ts`・`routes/(app)/audit-log/+page.svelte`・メッセージの差分を取り込むこと。Closes #597
- テンプレート（B）／共通クレート（A）: 監査ログに更新の差分を記録して表示する（#597 の段 1）。`items` の `update` の監査 `detail` を `{ name, changes: [{ field, before, after }] }` にした（変わった欄だけ・`updatedAt` と `id` は除く・変化が無ければ `changes` は空配列・文字列は 200 文字で切って末尾に `…`）。差分は `banto-admin-services` の `audit::diff::diff_changes`（マスクする欄名を必須の引数で受け、マスクした欄は `{ field, masked: true }` だけを残す）で作り、REST と Tauri が `admin_template_core::items::item_update_detail` を共有する。`ItemsService::update_returning_previous` を足した（同じトランザクションで旧行を読んで `(旧, 新)` を返す。`update` は従来どおり）。監査ログ画面の詳細は `changes` があれば「欄・変更前・変更後」の表（`AuditChanges.svelte`）、なければ従来の JSON。ドロワーの履歴タブも変わった欄を出す（`resource.changes*`）。**消費側への注意**: `items` の `update` の `detail` に `changes` が増えた（`name` は残る）。`detail` を機械で読む処理があれば確かめる。create・delete・users などは変えていない。コピー済みのアプリは `audit/diff.rs` と `ItemsService` の差し替えを取り込む。
- テンプレート（B）: 監査ログ画面（`routes/(app)/audit-log/+page.svelte`）が URL の `?resource=<名前>&entityId=<id>` を読み、グリッドの `resource`・`entityId` 列の絞り込みを一致（`eq`、ドロワーの履歴タブと同じ一致の仕方。id 1 で 10・100 が混ざらない）で当てて、最初の取得から絞り込んで開くようにした。片方だけでも効く。空・200 文字超・制御文字を含む値は無視する（絞り込みなし）。当てたあと（`?view=` と同じ）URL からこの 2 つを消すので、利用者が絞り込みを外してもリロードで戻らない。画面を開いたまま同じ画面への新しいリンクが来たときも当て直す（古い読み込みは `setParams` で打ち切る）。ドロワーの履歴タブの「監査ログで全部見る」のリンクに `resource` と `entityId` を付けた（URL エンコード）。クエリを読む純関数は新しい `lib/banto/auditLogQuery.ts`。辞書のキーの追加なし。`entityId` 列も絞り込めるようにした（`resource` 列と同じ文字列の絞り込み。URL から当てた絞り込みが見えて外せる）。派生アプリは `lib/banto/auditLogQuery.ts`・`routes/(app)/audit-log/+page.svelte`・`lib/resource/ResourceHistory.svelte` の差分を取り込むこと。Refs #591
- テンプレート（B）: 一覧のドロワーに「このレコードの履歴」タブを足した（#591 の段 2）。`admin` のとき（かつブラウザだけのデモ以外のとき）だけ、ドロワーに `@banto/ui` の `Tabs`（「詳細」「履歴」）を出す。「履歴」は監査ログをそのリソース名（`resource`）とレコードの id（`entityId`）で絞った一覧（`FilterOp::Eq`、新しい順、最新 50 件。時刻・アクション・ユーザー・結果・経路）で、新しい `lib/resource/ResourceHistory.svelte`（純関数と読み込み `recordHistory.ts`）が描く。API は既存の `listAuditLog`（バックエンドの変更なし）。タブを開いたときに読み込み、前後の行へ移ると読み直し、古い応答は捨てる。取得に失敗したときはエラー表示と「再読み込み」。監査ログ画面があるプリセットでは「監査ログで全部見る」のリンクを出す（絞り込みは引き継がない。この版のうちに #596（上の行）で `resource`・`entityId` を引き継ぐようにした）。フォームは「履歴」を見ている間も残す（未保存の入力が消えない）。`admin` 以外・新規作成・詳細ページ（`/<path>/[id]`）には出さない。差分表は C-5 の範囲。消費側への注意: 辞書のキー `resource.tabsLabel`・`resource.detailTab`・`resource.historyTab` と `resource.history*`（読み込み・空・エラー・表の見出し・アクション/結果/経路の名前など 21 個）を足した（`audit.*` は display プリセットが消すので使わない）。派生アプリは `messages/*.json`・`lib/resource/`（`ResourceListPage.svelte`・`ResourceHistory.svelte`・`recordHistory.ts`）の差分を取り込むこと。visual の基準画像（admin のドロワーを撮っているもの）に影響しうる。Closes #591
- 共通パッケージ（A）: `@banto/ui` の `Tabs` に任意の `keepMounted`（既定 `false`）を足した。`true` のとき、選ばれていないタブのパネルにも `panel` snippet を描く（パネル要素は今までどおり `hidden`）ので、パネルの中のフォームが別のタブを見ている間も残る。隠れたパネルの重い中身を遅延させるかは、snippet の中でタブを見て呼び出し側が決める。既定のままなら挙動は変わらない。テンプレートのドロワーは、フォームを「詳細」パネルの中に置いてこれを使う（支援技術にタブと内容の対応が伝わる）。
- テンプレート（B）: 一覧（`ResourceListPage`）の行から詳細を右の `Drawer` で開くようにした（#591 の段 1、design-ux-review-2026-11 B-3）。行の先頭の「開く」リンクの列をやめ、同じ列（id `open`・見出し「操作」）に小さな開くボタン（`IconButton`。名前は「ID n を開く」）を置いた。ボタン・read-only のグリッドの行のクリック・read-only のセルのダブルクリックで、一覧を残したまま右のドロワーに `ResourceDetail`（フォームと添付パネル）を出す。URL に `?id=<id>` を付け（`replaceState` なので履歴は増えない）、`?id=` 付きで開くとドロワーが開いた状態になり、閉じると消す（`?view=` と共存）。ドロワーのヘッダーに前の行・次の行（ドロワーの中にフォーカスがあるときの Alt+↑ / Alt+↓。`<select>` の上では効かない）と「ページで開く」（`/<path>/[id]`）を置いた。前後は一覧の今の並び・絞り込みの順で、グリッドが持っている行の中（server の読み込みは読み込み済みの行、client のグループ化では開いているグループの行）。端・一覧に無い行では押せない。768px 未満ではドロワーを使わず詳細ページへ移る。未保存の変更（保存中を含む）があるときに閉じる・前後へ移ると、画面内の確認（`confirmAction`）で破棄を確かめる。「ページで開く」と `?id=` を変える遷移は、従来の未保存の確認（`window.confirm`）を通る。保存してもドロワーは開いたまま（一覧は従来どおり読み直す）、削除すると閉じる。保存した行が絞り込みから外れたときの通知（#215）はドロワーの保存でも出る。#215 の最後に開いた行の印はドロワーで開いた行・前後へ移った先に付く。詳細ページ（`items/[id]`）と新規作成ページは残す。`ResourceDetail` に任意の `onClose`（「一覧へ戻る」を「閉じる」ボタンにし、カードの枠を外す）・`onSaved`・`onDeleted` と `hasPendingChanges()` を、`ResourceListPage` に `detailAfter` snippet を足した。items の添付パネルの配線は `routes/(app)/items/ItemAttachments.svelte` にまとめ、詳細ページと一覧（`detailAfter`）から使う（`scaffold.mjs` の `removeAttachments` を追従）。共通パッケージ（A）: `@banto/grid-svelte` の `GridColumn` に `render`（セルの中身を描く snippet。`cell` と同じく編集できない列になり、アクティブなセルで Enter / Space を押すと中の最初のボタンかリンクを押す）を、`BantoGrid` に `adjacentRow(rowId, delta)`（画面の並びで前後の行。server は読み込み済みの行だけ）を足した。`@banto/ui` の `IconButton` に `disabled`、`Modal` / `Drawer`（`OverlayProps`）に `headerActions`（見出しと × の間に置く操作）を足した。消費側への注意: 辞書のキー `resource.open` を消し、`resource.openRecord`・`resource.drawerTitle`・`resource.previousRecord`・`resource.nextRecord`・`resource.openFullPage`・`resource.discardTitle`・`resource.discardMessage` を足した。一覧の「開く」列はリンク（`a.cell-link`）からボタンに替わった（`getByRole('link', { name: '開く' })` で行を開いていたテストは、ボタンかドロワーを見るように直すこと）。`resourceColumns(definition)` は「開く」列を返さなくなった（第 2 引数に snippet を渡したときだけ足す）。visual の基準画像（items の一覧）の再生成が要る。派生アプリは `messages/*.json`・`lib/resource/`・items のルート（`+page.svelte`・`[id]/+page.svelte`・`ItemAttachments.svelte`）の差分を取り込むこと。Refs #591
- テンプレート（B）: LAN 共有を「共有する」ボタン 1 つと 3 ステップにまとめた（#558、design-ux-review-2026-11 D-2）。settings の接続カテゴリは、共有していないときは「共有する」（LAN を有効にし、待受がこの PC のみ・IPv4 以外なら `0.0.0.0` にして、従来の「保存して適用」と同じ経路で適用する。選んである LAN のアドレスはそのまま。未保存の変更・ログイン不要モードで閲覧公開がオフ・Web UI を同梱しないビルドのときは押せず、理由を出す）、共有中は ① 最初の LAN の URL と QR コード → ② 別の端末からの接続確認（既存の `LanReachCheckPanel`）の結果を緑／赤で → ③ 届かなかったとき（確認が期限切れ）の直し方 1 つ（Windows ファイアウォールに規則が無く、この画面から許可できるなら既存の許可の確認画面を開くボタン、許可できないならファイアウォールの情報へ、規則がある・Windows 以外なら同じネットワークの確認）を出す。閲覧公開・LAN の有効化・待受アドレス・ポート・全 URL・ファイアウォールの情報と規則の状態は「詳しく」（`<details>`、既定は閉じる）に畳んだ（消していない）。ヘッダーに「LAN 共有中・接続 n 台」を常設した（デスクトップの画面で admin のときだけ。クリックで接続カテゴリへ。`server_status` を 10 秒ごとに読み直し、設定の適用の直後にも読み直す。LAN のブラウザには出さない）。`connectivityScope.ts` を `routes/(app)/settings/` から `lib/banto/` へ移した（ヘッダーと共有の判定を揃えるため。中身は同じ）。辞書に `shell.lanSharing`・`shell.lanSharingConnections`・`shell.lanSharingOpenSettings`・`settings.shareIntro`・`settings.shareButton`・`settings.shareOn`・`settings.shareStepUrl`・`settings.shareStepUrlDesc`・`settings.shareStepReach`・`settings.shareVerdictOk`・`settings.shareVerdictNg`・`settings.shareVerdictWaiting`・`settings.shareVerdictUnknown`・`settings.shareStepFix`・`settings.shareFixFirewallAllow`・`settings.shareFixFirewallAllowButton`・`settings.shareFixFirewallInfo`・`settings.shareFixFirewallInfoButton`・`settings.shareFixNetwork`・`settings.shareBlockedAuth`・`settings.shareBlockedUnsaved`・`settings.lanDetails` を足した。`server_status`／`server_apply` の応答に `sseConnections`（稼働中の待受に開いているイベントストリームの数）を足した（src-tauri）。共通パッケージ（A）: `banto-server` の `RunningServer` に `sse_connections()` を足した。`BoundServer::serve` が待受ごとのカウンタを各要求に渡し、`GET /api/events` のストリーム 1 本ごとに数える（ストリームが持つガードが落ちたときに減る。クライアントの切断・セッションの再検証での終了・イベントの送り手が閉じたとき・サーバーの停止のどれでも減る）。同じ端末の複数のタブは別々に数える。デスクトップの画面は IPC でイベントを受けるので数えない。`serve` 以外で動かすルーター（テストの `oneshot` など）では数えない。派生アプリは `messages/*.json`・`src/lib/banto/`（`lanShare.svelte.ts`・`connectivityScope.ts`・`serverAdmin.ts`）・`Header.svelte`・`routes/(app)/settings/` の差分と、src-tauri の `ServerStatusResult` を取り込むこと。Closes #558
- 共通パッケージ（A）: チャートの配色を色覚の違いで検証して組み直した（#557 の 3）。カテゴリ 8 色 `--banto-chart-1`〜`-8` の値をライト / ダークとも変えた（ライト `#1a469d` `#da7306` `#6a3961` `#58a175` `#8d1920` `#117c72` `#8c69cd` `#915f21`、ダーク `#407aea` `#f48815` `#a7719d` `#75b992` `#de401b` `#3df4ef` `#ca99ef` `#fed48d`。スロットの順に青・橙・赤紫・緑・赤・青緑・紫・黄土。旧配色の系列 2 と 4 がどちらも緑だった問題を解消）。正常色覚と 1 型・2 型・3 型の色覚シミュレーション（Machado 2009）のそれぞれで、隣り合う系列の OKLab 距離の最小はライト 0.119 / ダーク 0.127（旧 0.076 / 0.029）、全ペアの最小は 0.106 / 0.124（旧 0.032 / 0.016）。各色は面（ダークは raised も）に 3:1 以上（旧ライトは 2.17:1 の色があった）。チャートの色は固定で、`--banto-brand-hue` に追従しない。新トークン `--banto-chart-seq-1`〜`-7`（sequential、単色相の青。ライトは旧 `SEQ_RAMP` と同じ値で明→暗、ダークは暗→明）と `--banto-chart-div-1`〜`-7`（diverging、青 ← 中立（段 4）→ 橙）を足した。`@banto/charts` の `SEQ_RAMP` は生の hex から `var(--banto-chart-seq-N)` の参照に替えた（ヒートマップがダークで暗→明のランプになる。SVG 書き出しは解決済みの色を埋め込むので変わらない）。`DIV_RAMP`・`divergingColor(value, min, mid, max, ramp?)`・`SEQ_STEPS`・`DIV_STEPS` を足した（diverging を使う部品はまだ無い）。theme に `tests/chart-palette.test.ts`（色差・コントラスト・ランプの単調性を banto.css の値から確かめる）を足した。消費側への注意: チャートの色が変わる（visual の基準画像の更新が要る）。`SEQ_RAMP` の要素を hex として読んでいた（色を計算していた）派生アプリは、`getComputedStyle` で解決した値を使うこと。`--banto-chart-*` を上書きしている派生アプリは、そのまま上書きが効く。Closes #557
- 共通パッケージ（A）: 配色を OKLCH の役割ベースに組み直した（ニュートラル 12 段 + ブランド 1 色 + 状態 4 色。#557 の 2）。新トークン `--banto-brand-hue`（数値、既定 `258`）・`--banto-neutral-1`〜`-12`（ライト / ダークで同じ段の明るさを反転）・`--banto-brand-accent`（色相 +40。`--banto-accent-gradient` の終点）・`--banto-info` / `--banto-info-tint` / `--banto-info-tint-text`。既存のトークン名は変えず、値だけを変えた: `--banto-bg`・`--banto-surface*`・`--banto-border*`・`--banto-text*` はニュートラルの段を参照し、`--banto-primary*`（`-hover`・`-text`・`-solid`・`-solid-hover`）とアクセントのグラデーション（生の紫 `#7c3aed` をやめた）・フォーカスの輪・glass の背景の光とサーフェスは `--banto-brand-hue` に追従する。primary は `#2563eb` から `oklch(0.5 0.17 258)`（`#145ec1` 相当。少し藍に寄せて彩度を抑えた青、白に 6.1:1）、ダークは `oklch(0.66 0.15 258)`（`#5492ec` 相当）。danger / warning / success は OKLCH に置き換えたうえでほぼ同じ見た目（色相は固定でブランドに追従しない）。ダークの danger の tint-text を明るくした（`#f87171` → `#fe8a88` 相当。raised の上の 18% の地で 4.0:1 → 4.5:1）。glass プリセット（`banto-glass.css`）の生の色はニュートラルの段とブランドのトークンを参照する形にした（半透明の白の境界と緑の光だけ固定）。チャートの色・文字サイズは変えていない。消費側への注意: 色の値が変わる（visual の基準画像の更新が要る）。`:root { --banto-brand-hue: 150; }` の 1 行で自社の色に変えられる（`:root` に置くこと）。`--banto-primary-solid` / `-hover` は `--banto-primary` / `-hover` を参照するようになったので、`--banto-primary` だけを上書きしている派生アプリは塗りの色も変わる。トークンの値を上書きしている派生アプリは見直すこと。追加の直し（レビュー対応）: (1) 役割のトークン（`--banto-bg`・`--banto-surface*`・`--banto-border*`・`--banto-text*`・`--banto-primary*`・`--banto-on-solid`・`--banto-brand-accent`・`--banto-accent-gradient`・`--banto-focus-ring`・tint・dock・launcher の面など、段や他の色を参照するもの）を `:root, [data-theme]` で宣言し、`data-theme` を付けた要素の上でも段から計算し直す（入れ子のダークで役割の値がライトのまま残る問題）。(2) `@property --banto-brand-hue`（`<number>`）を登録した。**`--banto-brand-hue` は単位なしの数値で書く（`150`。`150deg` を付けない）**。単位付きだと既定の 258 に戻る。(3) `@banto/charts` の SVG 書き出しで、`oklch()` / `color()` / `color-mix()` の色を `rgb()` / `rgba()` に変換して埋め込む（canvas 経由。canvas が無い環境では値をそのまま通す）。上の「`oklch(...)` のまま書き出される」注意は解消。(4) theme パッケージに vitest を足し、ブランドの色がどの色相（0〜359 を 1 度刻み）でも 4.5:1 以上かを `banto.css` の値から確かめるテストを追加した（色の値は変えていない）。Refs #557
- 共通パッケージ（A）: 文字サイズのトークンを底上げした（最小 12px。#557 の 1）。`--banto-font-size-xs` / `sm` / `md` / `base` / `lg` / `xl` を 12 / 13 / 14 / 14 / 16 / 20px（`rem` で `0.8572` / `0.9286` / `1` / `1` / `1.1429` / `1.4286`）にし、新トークン `--banto-font-size-2xl`（28px・display と大きな KPI の数値用）を足した。root は 14px のまま。トークン名は変えていない。`xs` は 9.8px → 12px、`sm` は 11.2px → 13px、`md` は 12.25px → 14px（本文と同じ大きさ）、`lg` は 15.75px → 16px、`xl` は 24.5px → 20px と変わる。`xl` を大きな数値に使っていた `@banto/charts` の Gauge の値は `2xl` に移した。`@banto/charts` の Radar の軸ラベルに `font-variant-numeric: tabular-nums` を足した（グリッドのセル・KPI の値・ほかのチャートの軸ラベルは既に tabular-nums）。theme の `.banto-field` の浮いたラベル（入力済み・フォーカス中の input と select）を `md` から `xs`（12px）にした（`md` が 14px になり、狭い幅・文字 200% で 2 行に折れて値に重なるため）。`@banto/ui` の MonthCalendar（日付ピッカーのカレンダー）の月の見出しは、狭い幅では縮んで単語の区切りで折り返す（前後のボタンを枠の外へ押し出さない。通常の文字サイズでは見た目は変わらない）。テンプレート（B）: dashboard の KPI の値を `2xl` へ（ログインの見出し・ブランド名は `xl` のまま 20px）。消費側への注意: 文字サイズのトークンの値が変わるので、トークンを使う画面は文字が大きくなる（visual の基準画像の更新が要る。行・ボタンの高さは変えていない）。独自に `--banto-font-size-*` を上書きしている派生アプリは値を見直すこと。数字・英字用フォントの同梱はしない（`system-ui` のまま）。Refs #557
- テンプレート（B）: 一覧（`ResourceListPage`）に保存ビューを足した。ツールバーの検索欄の隣の「ビュー」メニューに、リソース定義の既定のビュー（`AppResourceDefinition` の `list.views`、型 `ResourceListView`: `id`・`label`・任意の `sort`・`filters`・`search`）と自分の保存ビューを並べ、選ぶと今の絞り込み・並び順・検索語を置き換える（両方のグリッドに当て、それぞれ列の無い項目は落とす。チップ・検索欄も追従し、server は取り直す）。今の表示と同じビューにはチェックが付く。「今の表示を保存…」（名前を入れる Modal。同じ名前は上書き、1 リソース 50 件まで）と保存ビューの削除（`confirmAction` で確認）は、利用者ごとの UI 設定（`UiSettingsProvider`、キー `list.views.<リソース名>`、サーバーでは `ui.{username}.list.views.<リソース名>`）に保存する。個人用だけで、閲覧公開などの grant のセッションでは「保存」を出さない（既定のビューは使える）。列の表示・読み込み方はビューに含めない。`<一覧のパス>?view=<id>` で既定のビュー・保存ビューのどちらでも開け、当てた後は URL から `view` を消す（未知の id はトーストで知らせて無視）。items に既定のビュー `low-stock`（在庫 50 未満・在庫の少ない順）を足し、dashboard の「在庫僅少」タイルを `/items?view=low-stock` へのリンクにした。閾値 50 は `resources/items.ts` の `LOW_STOCK_THRESHOLD` の 1 か所にまとめ（dashboard の集計・日報・既定のビューが使う）、日報のテンプレートは `{{ lowStockThreshold }}` を使う。辞書に `resource.savedViewsMenu`・`resource.viewsPreset`・`resource.viewsSaved`・`resource.viewSave`・`resource.viewSaveTitle`・`resource.viewSaveHint`・`resource.viewName`・`resource.viewSaved`・`resource.viewSaveFailed`・`resource.viewLimit`・`resource.viewDeleteGroup`・`resource.viewDeleteItem`・`resource.viewDeleteTitle`・`resource.viewDeleteMessage`・`resource.viewDeleted`・`resource.viewDeleteFailed`・`resource.viewNotFound`・`items.viewLowStock`・`dashboard.statLowStockOpen` を足し、`dashboard.statLowStock` の値を `{threshold}` を取る形に変えた（キー名は同じ）。共通パッケージ（A）: `@banto/admin-core` に `isListViewSnapshot(value)`（`loadListViewState` と同じ形の検査）を足した。派生アプリは `messages/*.json`・`lib/resource/`・`resources/items.ts`・dashboard と日報の差分を取り込むこと。Closes #555
- 共通パッケージ（A）: 一覧のクイック検索を足した。`banto-core` の `ListParams` に任意の `search`（文字列。省略時は `None`、JSON では省くと従来どおり）を足し、`ListParams::search_term()`（前後の空白を除いた語。空・空白だけは `None`）を足した。`banto-storage` の `ColumnMap` に `text_column(field, sql_column)`（`column` と同じ登録に加え、クイック検索の対象の文字列列として印を付ける）と `text_columns()` を足し、`list_query::{sqlite,postgres}` に `append_list_where(builder, columns, params)`（filters と search の両方の `WHERE`）を足した。`apply_list_params` は search も効かせる。検索は `text_column` の列のどれかに語を含む行（大文字小文字を無視、`%`・`_`・`\` は文字どおり、値はバインド。`contains` と同じ `LOWER(CAST(.. AS TEXT)) LIKE`）で、filters とは AND、列どうしは OR。`text_column` が 1 つも無いリソースで空でない語を送ると、どの行にも当たらない（黙って全件を返さない）。`@banto/admin-core` の `ListParams` 型に `search?: string`、`InMemorySeed` に `searchFields?: string[]`（既定は、どれかの行で文字列を持つフィールドすべて）、`WindowedParams`・`ListViewSnapshot`・`SnapshotListRequest` に `search?: string` を足した（windowed・snapshot の一覧は設定されたときだけ `search` を送る）。`@banto/grid-svelte` に `searchRows(rows, search, columns)`・`searchableColumns(columns)`（`filterType` が text の列）を足した。3 つの実装（SQL・InMemory・grid の client）は共通の fixture `crates/banto-storage/testdata/list-search-parity.json` で同じ結果になることを確かめる。消費側への注意: `ListParams` にフィールドが増えたので、Rust で `ListParams { .. }` を全フィールド列挙で組み立てているコードは `search: None`（か `..Default::default()`）を足すこと。`append_where` は従来どおり filters だけを書く（search は入らない）ので、`apply_list_params` の横で件数の `COUNT(*)` を `append_where` で数えているサービスは `append_list_where` に替えないと、検索中の件数が合わない。クイック検索を効かせたいリソースは `column_map()` の文字列の列を `text_column` で登録すること（`column` のままなら検索の対象にならない）。テンプレート（B）: items の `column_map()` は `name`、audit の `column_map()` は `ts` と `id` 以外の文字列の列を `text_column` にし、件数のクエリを `append_list_where` に替えた。一覧（`ResourceListPage`）のツールバーの先頭に検索欄（`type="search"`、ラベル付き、入力の約 300ms 後に反映）を置いた。server の読み込みは `search` を付けて 1 行目から取り直し、先頭へ戻す。client の読み込みは手元で `searchRows` で絞る。語は一覧の状態（sessionStorage）に両モード共通で保存し、戻ったときに戻す。フィルタチップには出さない。CSV 出力にも語を渡す。デモの InMemory の items は `searchFields: ['name']`（`scaffold.mjs` の置き換えを追従）。辞書に `resource.searchLabel`・`resource.searchPlaceholder` を足した。派生アプリは `messages/*.json`・`lib/resource/`・`lib/banto/setup.ts`・`core/src/items.rs` の差分を取り込むこと。Refs #555
- 共通パッケージ（A）: `@banto/grid-svelte` に `FilterChips` を足した。`GridState.filters` の各フィルタを「列見出し 演算子 値」のチップで並べ（`role="group"`）、各チップの × で `removeFilter`、2 件以上のときだけ「すべて解除」で `clearFilters` する。0 件なら何も描画しない。チップ本体はクリックしても何も起きない。`onEmpty` は最後のチップが消えた（または「すべて解除」した）あとに呼ばれ、ページが focus を置き直すのに使う。任意の `onchange` は × や「すべて解除」で `filters` が変わるたびに呼ばれ、server モードのページが取得し直すのに使う（BantoGrid が知らせるのは見出しの操作だけのため）。日付列（`date` / `datetime`）の範囲は、排他的な上限ではなく選んだ最後の日で表示する。`GridMessages` に任意キー `filterChipsLabel`・`filterChipRemove`（引数: 列見出し）・`filterChipsClearAll`・`filterChipIsNull`・`filterChipNotNull`・`filterChipIn`・`filterChipRangeSeparator` を足した（既定値は日本語。派生アプリは `messages` の bridge に足すと翻訳できる。足さなくても壊れない）。
- テンプレート（B）: 一覧（`ResourceListPage`）のグリッドの上、ツールバーの下に `FilterChips` を置き、そのとき表示中のモード（client / server）の GridState の適用中フィルタを並べた。`gridMessages()`（`lib/banto/i18n.ts`）と `messages/{ja,en}.json` に `grid.filterChip*` の 7 キーを足した。
- テンプレート（B）: 一覧（`ResourceListPage`）のツールバーを整理した。見えたまま残るのは「新規作成」だけで、グループ化は「表示」メニューの中のラジオ（client の読み込みのときだけ選べる）へ、CSV 出力・CSV 取込・`actions` の項目は新しい「…」メニューへ移した。列メニューは「表示」の隣のボタンのまま。CSV 出力中は「…」のボタンにスピナーを出す。取込ボタンの title（取込のルール）は無くなった（ルールは確認パネルと注釈に出る）。派生アプリへの注意: `actions` snippet の中身は「…」メニュー（`role="menu"`）の中に描かれるので、`<button>` ではなく `@banto/ui` の `MenuItem` を渡すこと（items の日報も `MenuItem` に替えた）。辞書に `resource.moreMenu`・`resource.groupByMenu` を足した。派生アプリは `messages/*.json`・`ResourceListPage.svelte`・items の一覧のルートの差分を取り込むこと。Refs #555
- 共通パッケージ（A）: `@banto/ui` に `Tabs`（`role="tablist"`/`tab`/`tabpanel`、`aria-selected`・`aria-controls`、ロービングフォーカス・←→・Home/End、RTL では←→を入れ替え、無効なタブは飛ばす、`activation` は automatic/manual）、`SegmentedControl`（中身はネイティブの `input type="radio"`、外枠は `role="radiogroup"` で `label` か `labelledby` で名前を付ける、`size`・`disabled`）、`Tooltip`（ホバーとキーボードのフォーカスで短い遅延のあと出る、吹き出しへポインタを移しても消えない、Esc で閉じる（キーは消費しない）、`role="tooltip"` + 既定で `aria-describedby`、`popover="manual"` で最前面に出し画面端では上・内側へ逃げる、forced-colors 対応）を足した。型 `TabItem`・`SegmentedOption`・`TooltipTriggerProps` を公開した。`IconButton` は `title` 属性をやめ、`label` を `Tooltip` で出す（アクセシブルネームは従来どおり `aria-label`。名前と同じ文を二度読ませないため `aria-describedby` は付けない）。`@banto/theme` に共通クラス `.banto-tabs`（見た目は `.banto-section-nav` に合わせた）・`.banto-tabs__panel`・`.banto-segmented`（`--sm`・`__option`・`__input`）を足した。`.banto-section-nav` はページのリンク用として残す。消費側への注意: `IconButton` の `title` を前提にしたテスト（`getByTitle` など）は `aria-label` か `role="tooltip"` を見るように直すこと。テンプレート（B）: 設定の外観の「表示密度」と「ドックの位置」を `SegmentedControl` に替えた（radiogroup の名前・ラジオの名前・`name`・保存の挙動は同じ。テーマのプリセットとナビの配置は見本の絵つきなので従来のまま）。ui-demo に Tabs・SegmentedControl・Tooltip の見本を置き、辞書に `uiDemo.tabs.*`・`uiDemo.segmented.*`・`uiDemo.tooltip.*` を足し、`uiDemo.iconButton.desc` の値を変えた。派生アプリは `messages/*.json`・`AppearanceSection.svelte` の差分を取り込むこと。Closes #556
- 共通パッケージ（A）: `@banto/ui` に `Button`（`variant`・`size`・`icon`・`type`・`disabled`・`loading`）を足した。`loading` は文言を差し替えず、同じ場所にスピナーを重ねて幅を保ち、`aria-busy` で押せなくする。`ConfirmDialog` の確認・取消のボタンもこの部品に替え、見た目の複製 CSS を消した。派生アプリへの注意: `.banto-btn` / `--primary` / `--secondary` / `--ghost` / `--danger` / `:focus-visible` / `:disabled` の CSS を `apps/admin-template/src/app.css` から `@banto/theme`（`banto.css`）へ移した（クラス名と見た目は同じ。危険の文字色は `--banto-on-danger-solid`）。`--sm`・`--loading`・`__spinner` を足した。`app.css` の `.banto-btn` を自前で上書きしている派生アプリは、読み込み順を確認すること。テンプレート（B）: 処理中表示のあるボタン（取込の実行・CSV 出力・バックアップ作成・設定の保存・ユーザーの保存/削除/パスワード再設定・ログインなど）を `<Button loading>` に替えた。消費側への注意: 使わなくなった辞書のキー `resource.importRunning`・`resource.exporting`・`backup.creating`・`settings.reachIssuing` を消した。Refs #556
- 共通パッケージ（A）: `@banto/ui` に `ConfirmDialog`（`window.confirm` の置き換え。Modal と同じ下地で `role="alertdialog"`、`danger`、任意の `requireText`＝一致するまで確認ボタンを押せない）と、`await confirm()` で使う `createConfirmStore()` + `ConfirmHost`（toast と同じ形）を足した。`UiMessages` に任意の `confirmOk`・`confirmCancel`・`confirmTypeToConfirm` を足し、Esc の層（`LAYER_SELECTOR`）に `[role="alertdialog"]` を含めた。`@banto/theme` に `--banto-on-danger-solid`（危険の色の上の文字。白）を足した。自前のテーマを使う派生アプリは、この変数を定義すること（ConfirmDialog の危険のボタンの文字色。§9 により部品は代わりの値を持たない）。確認の入力の照合は NFC にそろえ、前後の空白を無視する。`@banto/attachments` の `AttachmentsPanel` に任意の `confirmDelete`（既定は従来どおり `window.confirm`）を足した。テンプレート（B）: 行・ユーザー・添付の削除、DB のリストア、ログイン不要モードの有効化の確認を、ルートのレイアウトの `ConfirmHost` に替えた（`lib/confirm.svelte.ts` の `confirmAction`）。ユーザーの削除はユーザー名、リストアはバックアップのファイル名の入力を求める。未保存の確認とウィンドウを閉じるときの確認は同期で答えが要るので `window.confirm` のまま。辞書に `common.confirmOk`・`common.deleteConfirmTitle`・`common.typeToConfirm`・`users.deleteConfirmTitle`・`backup.restoreConfirmTitle`・`backup.restoreConfirmSubmit`・`settings.authDisableConfirmTitle`・`settings.authDisableConfirmSubmit`・`uiDemo.confirm.*` を足した。派生アプリは `messages/*.json`・ルートのレイアウト・各画面の差分を取り込むこと。Refs #556
- テンプレート（B）: CSV 取込を app 層の共通部品へ移し、リソース定義の `csv.import`（`run`・`rules`・任意の `available`・`required`・`preview`・`idType`）で出すようにした。`ResourceListPage` は `csv.import` があり `resourcePermissions` の `import`（`create` かつ `edit`）があるときだけ取込ボタンと確認パネル（新しい `lib/resource/ResourceImportPanel.svelte`、純関数は `lib/resource/csvImport.ts`。items のルートの `importPreview.ts` は汎用化してここへ移した）を出し、取込ボタンの title と確認パネルに `rules` を出す。取込の実行は定義から関数で渡す（items は `itemsAdmin.ts` の `importItems` を `toItemImportRow` で包む。`DataProvider` に取込の口は足さない）。必須列と確認表の列は既定でスキーマの `required` の欄、`idType: 'string'` で文字列の id を扱える。`run` が一部だけ反映して返したときは一覧を読み直し、反映した件数を確認パネルに出して同じファイルの再実行を止める。CSV の値の変換エラーの文言を辞書から出すようにした（英語の画面で日本語が出ていた）。段 4 の一時的な差し込み口 `csvImport` を消した（`beforeGrid` は残す）。items の一覧のルートは日報ボタンだけになった（`scaffold.mjs` の `removeReport` を追従）。消費側への注意: 辞書のキー `items.importCsv`・`importMissingRequired`・`importFailedShort`・`importNeedsReview`・`importReady`・`importMissingRequiredDetail`・`importSummary`・`importPreviewShown`・`importPreviewCaption`・`importPreviewLine`・`importPreviewKind`・`importKindCreate`・`importKindUpdate`・`importIgnored`・`importErrorLine`・`importMore`・`importServerRollback`・`importRunning`・`importRun`・`csvEmpty`・`importIdInvalid`・`importFailedCount`・`importSucceeded` を `resource.*` へ移し（値は同じ）、`items.demoImportUnavailable` を `resource.importUnavailable` に、`items.importUpdateNote` を `resource.importUpdateNote`（`{columns}` を取り、商品に固有の言い回しをやめた）に替え、`resource.importConvertError`・`resource.importPartialCount`・`resource.importServerPartial`・`resource.listSeparator` を足した。`items.importRules` は items に固有の文言として残す。派生アプリは `messages/*.json`・items の一覧のルート・`resources/items.ts` の差分を取り込むこと。ADR-0030 段 5、Refs #554
- テンプレート（B）: items の一覧の画面を、app 層の共通部品 `lib/resource/ResourceListPage.svelte`（`<ResourceListPage resource={…}>`）に切り出した。見出し・「表示」メニュー（読み込み方）・グループ化・列メニュー・CSV 出力・新規作成・デモの注釈・権限による出し分け・2 つのグリッド（`ItemsServerGrid`・`ItemsClientGrid` を汎用化して `lib/resource/ResourceServerGrid`・`ResourceClientGrid` へ移した）・#215 の復元・セルの編集と保存キュー（`rowSaveQueue.ts` も移した）を持つ。リソース定義（`AppResourceDefinition`）に `description`・`list`（`loadModes`・`columns`・`groupBy`・`client`）・`csv.export`・`demoNotes` を足した。`loadModes` の既定は server だけ（items は両方）。日報ボタンは items のルートから `actions` snippet で差し込み、`[scaffold:report]` の印で囲む（`scaffold.mjs` の `removeReport` を追従）。CSV 取込は段 5 まで items のルートの snippet に残す。行の印のクラスは `items-row-last-opened` から `resource-row-last-opened` に変えた。消費側への注意: 辞書のキー `items.viewMenu`・`modeToggleAria`・`modeClient`・`modeServer`・`groupByLabel`・`groupByClientOnly`・`groupNone`・`exportCsv`・`exporting`・`exported`・`exportedToPath`・`exportedToPathClosed`・`create`・`colActions`・`open`・`rowCount`・`updatedCount`・`skippedCells`・`loadTimeout`・`malformedResult` を `resource.*` へ移し（値は同じ）、`items.filterExcludedNotice` を `resource.filterExcludedNotice`（`{resource}` を取る）に替え、`items.loadError`・`items.loadErrorDesc` を消して `resource.loadError`・`resource.loadErrorDesc` を使い、`resource.loadingData` を足した（`items.loadingData` はダッシュボードが使うので残す）。派生アプリは `messages/*.json`・items の一覧のルート・`resources/items.ts` の差分を取り込むこと。ADR-0030 段 4、Refs #554
- テンプレート（B）: items の新規作成・編集の画面を、app 層の共通部品 `lib/resource/ResourceDetail.svelte`（`<ResourceDetail resource={…} id={…}>`。`id` が `null` なら新規）に切り出し、`items/new`・`items/[id]` のルートは見出しと部品を置くだけにした。添付パネルは `[id]` のルートから `after` snippet で差し込み、`[scaffold:attachments]` の印で囲む。削除ボタンと保存は `resourcePermissions` に従う（viewer は新規作成の画面でも保存できない）。`verify:architecture` に rule `resource-no-optional`（`lib/resource/` はオプションの資産を import しない、conventions §4）を足した。消費側への注意: 辞書のキー `items.createTitle`・`items.editTitle` を消して `resource.createTitle`・`resource.editTitle` を使い、`items.notFoundTitle`・`items.notFoundDesc`・`items.deleteConfirm` を `resource.*` へ移し、`resource.loadError`・`resource.loadErrorDesc` を足した（値は同じ。`items.loadError`・`items.loadErrorDesc` は一覧が使うので残す）。派生アプリは `messages/*.json` と items の 2 ルートの差分を取り込むこと。ADR-0030 段 3、Refs #554
- テンプレート（B）: 画面に直接出ていた開発者向けの解説（items の操作説明、dashboard の「このデモについて」）を、デモビルドだけで開ける注釈ドロワー（PageHeader 右の「?」）にまとめる。本番ビルドでは出さない。CSV インポートの規則（編集者以上のみ・id 列ありは更新／なしは新規・1 件でもエラーがあると全体を取り消す）は、インポートの確認パネルとボタンの説明に短く出す（デモ・本番とも）。Refs #553（4 段目）
- テンプレート（B）: items のツールバーから「クライアント / サーバー」の切り替えを外し、「表示」ボタンのメニューで「全件を読み込む（グループ化できる）」「少しずつ読み込む（大量データ向け）」から選ぶ形にした。機能・モードごとの状態の保存は変えていない。`items.modeClient` / `items.modeServer` / `items.modeToggleAria` の値を変え、`items.viewMenu` を足した（この版のうちに `resource.modeClient` / `resource.modeServer` / `resource.modeToggleAria` / `resource.viewMenu` へ移した。取り込みは上の B の「辞書のキーの移動」に従い `messages/*.json` をまとめて取り込む）。派生アプリは `+page.svelte` の `.mode-toggle` の差分を取り込むこと。共通パッケージ（A）: `@banto/ui` の `MenuItem` に任意の `checked` prop を足した（指定すると `role="menuitemradio"` + `aria-checked` + チェック表示。未指定なら従来どおり、後方互換）。#553
- テンプレート（B）: `/dashboard` を製品らしい画面に寄せるため、チャートの見本（複合・ヒートマップ・ゲージ・レーダー・積立エリア・ガント）を新しいデモ専用ルート `/chart-gallery`（ナビ名「チャート見本」。ナビはデモビルドだけ、URL では全ビルドで開ける）へ移した。ダッシュボードにはスタットタイル・主要なチャート・分析ワークスペースが残る。文言は `chartGallery.*` キーへ移し、`scripts/scaffold.mjs` の charts 除去と `docs/recipes/remove-optional-assets.md` を追従させた（#553）。
- 共通パッケージ（A）: `@banto/dock-svelte`・`@banto/tree-svelte` の `messages` を後から差し替えても文言が変わらない不具合を直した。`DockedTree`・`DockWindow`・`BantoTree`・`TreeSelect` が初期化時に 1 回だけ既定の文言と合成していたため、ロケール切替などで親が `messages` を渡し直しても追従しなかった。`$derived` で合成し直すようにした（`TreeSelect` は既定の `placeholder`・`selectedCount` を挟んだ順序のまま）。公開 API は変わらない。
- 共通パッケージ（A）: `@banto/charts` の `messages` を後から差し替えても文言が変わらない不具合を直した。`BoxPlot`・`Gauge`・`Histogram`・`LineChart`・`ParetoChart`・`StackedAreaChart`・`GanttChart` と内部の `ChartContainer` が初期化時に 1 回だけ既定の文言と合成していたため、ロケール切替などで親が `messages` を渡し直しても追従しなかった。`$derived` で合成し直すようにした。公開 API は変わらない。
- 共通パッケージ（A）: `@banto/attachments`・`@banto/report` の `messages` を後から差し替えても文言が変わらない不具合を直した。`AttachmentsPanel`・`ReportView` が初期化時に 1 回だけ既定の文言と合成していたため、ロケール切替などで親が `messages` を渡し直しても追従しなかった。`$derived` で合成し直すようにした（`@banto/grid-svelte` と同じ形）。公開 API は変わらない。
- 共通パッケージ（A）: `@banto/grid-svelte` の `messages` を後から差し替えても文言が変わらない不具合を直した。`BantoGrid`・`HeaderCell`・`FilterPopover`・`FilterChips`・`ColumnsMenu` が初期化時に 1 回だけ既定の文言と合成していたため、ロケール切替などで親が `messages` を渡し直しても追従しなかった。`$derived` で合成し直すようにした。公開 API は変わらない。
- テンプレート（B）: `apps/admin-template` の `pnpm test` の前に paraglide を再生成する（`pretest`）ようにした。scaffold 後のコピーなど、生成物が古いまま vitest を回すと `navigation.test.ts` が `m[item.labelKey] is not a function` で落ちていた。あわせて受け入れ CI（`template-acceptance.yml`）の 4 プリセットで単体テストも回す。
- 共通パッケージ（A）: `@banto/ui` の `Tooltip` で、フォーカス中のトリガーが消える（キーボードでフォーカスしたボタンを持つオーバーレイを Esc で閉じる、など）と、ブラウザが同期で出す `blur` の中で状態を書き換えて Svelte の `state_unsafe_mutation` が起き、画面が更新されなくなっていたのを直した（#591 のレビューで発見）。
- 共通パッケージ（A）: `@banto/admin-core` の `createSseEventProvider` で、開いているイベントストリームがあるタブでログインする（閲覧公開の閲覧者セッションから実アカウントへ、など）と、ストリームが前のトークンのまま開き続け、新しいセッションの失効（パスワード再設定・権限の変更・削除）が届かず閲覧者・ログイン画面へ切り替わらなかったのを直した。ストリームを開いている間も `getToken()` を `tokenWaitDelayMs` ごとに見て、別の（null でない）トークンに替わったらすぐ新しいトークンで開き直す。トークンが消えた（null）ときは従来どおり（サーバーの再検証でストリームが閉じたあとの再接続で `onTokenCleared`）。ページを読み込み直さずにログインした LAN のブラウザが対象（#591 の e2e で発見）。
- テーマ（A）: ダークの `--banto-danger-tint-text` を `oklch(0.76 0.14 22)` から `oklch(0.78 0.12 22)` に直した（#581）。自身の 18% の `-tint` を bg / surface / raised に重ねた面で、ブランド色相の全域のうち raised で 4.49:1 と 4.5:1 に届かなかった（最悪 4.74:1 に改善）。ライト・ダークの `-tint-text` 4 色 x `-tint` の検査（4.6:1 以上、色域内）を `contrast.test.ts` に追加。ダークの visual 基準画像の再生成が要る。
- テーマ（A）: 状態色の文字用トークンのコントラスト不足を直した（#557 の ② の要確認）。`--banto-warning` / `--banto-success` / `--banto-info`（ライト）と `--banto-danger`（ライト・ダーク）を、そのテーマの bg / surface / raised の上で（ブランドの色相 0〜359 のどれでも）4.6:1 以上、かつ sRGB の色域の中に収めた（色相は据え置き。色域の外の色はブラウザによって描き方が違い、コントラストがずれるため）: ライト warning `oklch(0.666 0.157 58)` → `oklch(0.555 0.132 58)`（`#aa5c02`、暗い橙）、success `oklch(0.627 0.17 149)` → `oklch(0.525 0.148 149)`（`#008035`）、info `oklch(0.55 0.105 235)` → `oklch(0.54 0.105 235)`（`#1c77a3`）、danger `oklch(0.577 0.215 27)` → `oklch(0.572 0.215 27)`（bg 上で 4.498:1 とわずかに足りなかった。`-solid` は据え置き）、ダーク danger `oklch(0.637 0.208 25)` → `oklch(0.69 0.199 25)`（`#ff5c59`、raised 上 3.8 → 4.7:1）。`contrast.test.ts` に状態色 × 面のコントラストと、状態色が色域の中にあることのテストを追加した。**visual の基準画像の再生成が要る。** これらのトークンを上書きしている派生アプリは、同じ基準（4.5:1・色域の中）で見直すこと。
- 共通パッケージ（A）: `@banto/charts` の `sequentialColor` と `divergingColor` が、値や範囲（`min`・`mid`・`max`）に `NaN` や `±Infinity` を渡すと `undefined` を返していた（戻り値の型は `string`）のを、空文字 `''` を返すように直した（空のランプと同じ扱い。呼び出し側はその印を描かずに飛ばす）。`±Infinity` の値は以前は端の段に丸められていたが、これも `''` になる。値も範囲もすべて有限でも差が `Number.MAX_VALUE` を超える巨大な範囲（例 `-1e308`〜`1e308`）で比率が `NaN` になっていたのも、差がはみ出すときだけ半分ずつ取って直した（小さな範囲の非正規数の差は 0 に潰さない）。`Heatmap` は有限でない値をもとから落としているので見た目は変わらない。
- テンプレート（B）: 画面の文言から開発者向けの内部用語（マイルストーン番号・パッケージ名・型名・仕様の節番号・通信方式）を取り除いた。`messages/ja.json`・`en.json` の 12 キーの値だけを変え、キー名は変えていない（#553）。
- テンプレート（B）: アプリのアイコン（`static/favicon.svg`・`icon-192.png`・`icon-512.png`・`icon-512-maskable.png`、`src-tauri/icons/icon.png`・`icon.ico`）の青を、旧 primary の `#2563eb` から新しい primary の `#145ec1`（`oklch(0.5 0.17 258)`。#557 の 2 で `theme-color`・manifest は変えていた）に塗り替えた。提灯の濃い青も同じだけ動かした（`#1e3a8a` → `#11326d`）。絵柄は変えていない。自社のアイコンに差し替えている派生アプリは影響しない。
- 依存監査: `.cargo/audit.toml` で RUSTSEC-2026-0459（libsqlite3-sys 0.30.1 の同梱 SQLite）を、理由と見直しの条件をつけて一時的に除外した。sqlx 0.9.0 が libsqlite3-sys 0.39 以上を受け付けないため。sqlx の次のリリースで外す。

## [7.0.0] - 2026-11-09

**v7.0.0 — 日付・時刻ピッカー（`DateInput`・`TimeInput`・`DateTimeInput`）と期間の絞り込み（`FilterOp` の `between`）の追加、CSS の寸法トークン（`--banto-space-*` など）への移行、内部の単純化。** 版の種類: major（破壊的）。理由: 公開 API の削除（`banto-server` の `PortFallbackError::into_error`、#549）と、date の空値の意味変更（`''` から `null`。`@banto/forms`・`@banto/grid-svelte`）。[docs/publishing.md](docs/publishing.md)「バージョニング規約」。
派生アプリへの影響: git 依存のタグを `v6.10.0` から `v7.0.0` に上げると、`PortFallbackError::into_error` を呼ぶコード・date の空を `''` と見ているコード・`FilterOp` を網羅する `match`／`switch` と自前の `DataProvider` が追従を要する。コピーしたテンプレートの取り込みは任意の変更が多い。マイグレーション `0009` が増える。

| 経路                             | 影響 | 内容                                                                                                                                                                                                                       |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.10.0` → `v7.0.0`（npm と Rust を同じタグに）。**破壊的変更 4 件**（`into_error` の削除、date の空値 2 件、`FilterOp::Between`）と、その他の挙動変更。追加 API 多数。下の「移行注意」                                   |
| B. コピーしたテンプレート        | あり | CSS の寸法トークン化、日付・時刻ピッカーの注入（ルートのレイアウト）、items の更新日の期間絞り込み、添付の共通化（`core/src/rest/attachments.rs`・`attachment_wiring`）、`items.updated_at` のローカル日付。取り込みは任意 |
| C. DB・設定・配布資産            | あり | migration `0009_items_updated_at_index.sql`（sqlite・postgres）が増える。`tauri.conf.json` は版数のみ                                                                                                                      |

### A. 共通パッケージ・クレート

- 対象: `@banto/ui`・`@banto/forms`・`@banto/grid-svelte`・`@banto/admin-core`・`@banto/theme`・`@banto/charts`・`@banto/dock-svelte`・`@banto/report`・`@banto/attachments`・`@banto/tree-svelte`、`banto-core`・`banto-storage`・`banto-server`・`banto-attachments`・`banto-admin-services`（いずれも実装変更あり）。他のパッケージ・クレートは版数のみ。
- 更新: `v6.10.0` → `v7.0.0`（npm と Rust を同じタグに）。
- 追加 API（いずれも任意。既定の挙動は維持）:
  - `@banto/ui`: `DateInput`・`TimeInput`・`DateTimeInput`・`DateRangeInput`。
  - `@banto/forms`・`@banto/grid-svelte`: 日付・時刻・日時のピッカーの注入（`provideFieldInputs`・`provideCellEditors`、`BantoForm` の `fieldInputs`・`BantoGrid` の `cellEditors`）、型 `'time'`・`'datetime'`。
  - `banto-core`: `datetime::validate_date`・`validate_time`・`validate_datetime`。
  - `banto-server`: `lan_addrs_for_bind`。
  - 任意のメッセージ: `GridMessages` の `filterRangeLabel`・`filterRangeStart`・`filterRangeEnd`・`filterRangeInvalid`・`filterRangeOrder`、`UiMessages` の `dateRangeStart`・`dateRangeEnd`・`dateTimePicker*`・`dateTimeFormatHint`、`ValidationMessages`／`ColumnValidationMessages` の `date*`・`time*`・`dateTime*`（bridge を持つ派生アプリは対応する。既定は日本語で、未指定でも動く）。
- 移行注意（破壊的変更。値の意味が変わるもの、またはコンパイルが止まるもの）:
  1. **`banto-server`: `PortFallbackError::into_error` を削除**（#549）。呼んでいる場合は `PortFallbackError` を `match` して `error` を取り出す（`Exhausted { error, .. }` と `Failed(error)` の 2 つ）。
  2. **`@banto/forms`: 空の日付が `''` から `null` に**。`DateField` が入力を消したとき `onInput(null)` を呼ぶ。`createFormStore`／`createFormDraft` の初期値（`default` の無い date）が `null`。`FormDraft.commit` が空の date を `null` で確定する。`values` の date を `=== ''` や `.length` で見ている箇所は `null` も空として扱い、Rust の入力の型が `String` なら `Option<String>` にする（[docs/upgrading.md](docs/upgrading.md)「日付のフィールド」）。
  3. **`@banto/grid-svelte`: date のセルの空が `''` から `null` に、日付でない文字列は入らなくなる**。セルを空にして確定・空のセルの貼り付け・CSV の空の欄で、`onCellEdit`／`onRangePaste`／`convertCsvRow` の値が `null` になる。`parseCellInput(raw, 'date')` は `YYYY-MM-DD` に正規化し、不正な文字列は失敗にする。受け取る側は 2 と同じに直す（[docs/upgrading.md](docs/upgrading.md)「グリッドの日付のセル」）。
  4. **`banto-core`: `FilterOp::Between` を追加**。`#[non_exhaustive]` ではないため、`FilterOp` を網羅する `match` はコンパイルが止まり、自前の `DataProvider` は `between` の対応が要る。TS の `FilterOp`（`@banto/grid-svelte`・`@banto/admin-core`）にも `'between'` が増えるので、`switch` で網羅している箇所も足す。値は `[from | null, to | null]` の半開区間（[docs/upgrading.md](docs/upgrading.md)「期間の絞り込み」）。
- その他の挙動変更（どれも型エラーにはならない）:
  - `columnsFromSchema` が date・datetime の列を既定で絞り込み可にする（見出しに ▾ が出る。出したくない列は `overrides` で `{ filterable: false }`）。date・time・datetime の列の並べ替えが `localeCompare` から文字列の大小になる（正規の形なら順は同じ）。
  - `GridMessages` の `filterRange*`・`UiMessages` の `dateRange*` などの任意メッセージの追加。多言語化している派生アプリは辞書と bridge に足す。
  - 新規ユーザー名に `.` を使えなくなる（#544）。初回セットアップ・ユーザー追加が `username` のフィールドエラーで拒否する。既存の `.` 入りのアカウントはそのまま使える。
  - `banto-core` が `chrono`（`default-features = false`）に依存する（#545、[ADR-0029](docs/adr/0029-chrono-datetime-formatting.md)）。
  - 寸法トークンへの移行（`--banto-space-*`・`--banto-font-size-*`・`--banto-border-width`）で、共通パッケージの余白が最大約 2.1px（グリッドの集計チップなど）、文字サイズが最大約 2.1px（`@banto/charts` の Gauge の値。ほかは約 1.1px 以内）動く箇所がある。コピーしたテンプレートの画面では、文字サイズが最大約 3.5px（ログインの見出し）動く。`@banto/charts` は文字がトークンと root の文字サイズに追従し、軸ラベルの幅の見積もりが変わるため、root の文字サイズを大きくした環境では左右の余白が変わる。
  - `pnpm verify:architecture` に rule `raw-dimensions`（文字サイズと枠線幅の生値の検査）が増え、scaffold で配られる。生の寸法を書いている派生アプリは検査で止まり得る。
- 依存を上げずに留まれるか: できる（`v6.10.0` のタグに固定したまま使える）。

### B. コピーしたテンプレート

- 対象ファイル・ルート: `apps/admin-template/src/` の CSS（`app.css`、`routes/(app)/settings/settings.css`、items・users・audit-log・tree・dashboard・`ui-demo`・ログイン・サイドバー・ヘッダー・シェルの各画面）の寸法トークン化、ルートの `+layout.svelte`（`FormDateInput`・`FormTimeInput`・`FormDateTimeInput`・`CellDateInput`・`CellTimeInput`・`CellDateTimeInput`・`FilterDateRangeInput` の注入。`src/lib/components/`）、items の一覧（`items/+page.svelte`・`ItemsServerGrid.svelte`・`itemRow.ts`）の更新日の期間絞り込み、`apps/admin-template/core/src/rest/attachments.rs` と `attachment_wiring`（`admin-template-core`）、`items.updated_at` を書く `ItemsService`（`admin-template-core` に `chrono` の依存が増える）、`messages/ja.json`・`en.json` と `src/lib/i18n.ts`（新しい文言の bridge）。
- 関連 PR・コミット: date-time-pickers（PR-3〜6）、#533（`items.updated_at` をローカル日付で書く。[ADR-0028](docs/adr/0028-chrono-local-date.md)）、#536（索引）、#546・#547（添付の共通化と scaffold）、寸法トークン化（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) §6 の PR-2〜6）。個々の番号は下の「変更の一覧」。
- 手で取り込む変更: 日付・時刻ピッカーの注入は、ルートの `+layout.svelte` で `provideFieldInputs`・`provideCellEditors` を渡す（手順は [docs/upgrading.md](docs/upgrading.md) の「日付のフィールド」から「期間の絞り込み」）。取り込むと date の項目の見た目が変わる。寸法トークン化は CSS の置き換えのみ（API・DOM は不変）。`items.updated_at` のローカル日付は `ItemsService` と `admin-template-core` の `chrono` の依存を取り込む。
- 派生側の独自変更と衝突しやすい箇所: ルートの `+layout.svelte`、`i18n.ts` の bridge、items の一覧と更新日の列、`settings.css`、`core/src/rest/` の添付まわり。
- 取り込まなくても動くか: 動く見込み。ただし A のタグを `v7.0.0` に上げる場合、A の移行注意 2・3（date の空が `null`）は、受け取る側のコード（コピー済みの items の保存・Rust の入力の型）が `''` 前提なら直しが要る。注入を取り込まなければ date はネイティブの入力のまま動く。添付の共通化と `updated_at` の変更は A のタグと独立。組み合わせの確認は未実施（「検証した組み合わせ」参照）。
- 手本: 上記の `apps/admin-template/` のファイル。

### C. DB・設定・配布資産

- マイグレーション: 要。`0009_items_updated_at_index.sql`（sqlite・postgres。`apps/admin-template/core/migrations-*`）。`items.updated_at` の索引で、適用は起動時に自動。自前の date・datetime の列で期間の絞り込みを速くするなら、PostgreSQL は同じ式の索引を足す（TEXT の列に限る。[docs/upgrading.md](docs/upgrading.md)「期間の絞り込み」）。
- `updated_at` の基準: 「サーバーの UTC／DB の TZ」から「アプリのローカル日付」に変わる。既存の行は書き換えない。保存形式（TEXT の `YYYY-MM-DD`）は変わらない。
- 戻せる条件: 新版を本番 DB で最初に起動するまで（以降はバックアップの復元）。起動前に DB のバックアップを取る。
- 設定キー・`tauri.conf.json`・配布物: 変更なし（`tauri.conf.json` は版数のみ）。
- 順序: A・B を先に完成 → 検証用 DB で起動 → 本番。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画される）。
2. date の空の扱い（フォームの保存・グリッドのセル編集・CSV・Rust の入力の型）、`FilterOp` を網羅する箇所と自前の `DataProvider`、`PortFallbackError` を呼ぶ箇所、チャートと余白の見た目、items の更新日の期間絞り込み。
3. Rust: `cargo check` / `cargo test`。

### セキュリティ

- なし。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `27004fe`、`workflow_dispatch`）: [run 42548031485](https://github.com/tyaro/banto/actions/runs/42548031485)（success）。
  - タグの push（`v7.0.0`、main の `27004fe`）: [run 42548288844](https://github.com/tyaro/banto/actions/runs/42548288844)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.22.2                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.3                         |
    | SvelteKit          | 3.1.1                          |
    | Vite               | 8.3.6                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.1（58cf8f9c3 2026-10-13） |

  - 出所: Node.js は `node: v24.22.2`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.1`。

### 変更の一覧

- feat(ui, grid-svelte, admin-core, banto-core, banto-storage): 期間の絞り込みを追加（[date-time-pickers.md](docs/design/date-time-pickers.md) §5.9・§6 の PR-6）。`@banto/ui` に `DateRangeInput`（開始日・終了日の 2 つの `DateInput` を `role="group"` でまとめる）。`FilterOp` に `between`（値は `[from | null, to | null]`、半開区間 `from <= v < to` を文字列で比べる。TS の grid・admin-core の InMemory・Rust の `banto_core`／`banto-storage` の SQLite・PostgreSQL で同じ規則、共通ケース `crates/banto-storage/testdata/filter-between-parity.json`。PostgreSQL は `COLLATE "C"`）。`FilterType` に `date`・`datetime` を足し、FilterPopover はその列で両端を含む日を見せて終了日の翌日を送る（`dateRangeToBetween` の 1 か所）。注入は `provideCellEditors({ dateRange })`、無ければネイティブの日付入力 2 つ。**`columnsFromSchema` は date・datetime の列を既定で絞り込みできるようにし、date・time・datetime の列の並べ替え・比較を文字列の大小にする**（見出しの見た目が変わる）。保存した状態の復元で形の崩れた `between` を捨てる。FilterPopover への貼り付けがセルの範囲の貼り付けに取られていたのを直す。admin-template は items の更新日で期間の絞り込み（e2e）。派生アプリは [docs/upgrading.md](docs/upgrading.md)「期間の絞り込み」。
- feat(ui, forms, grid-svelte, banto-core): 時刻・日時の型を追加（[date-time-pickers.md](docs/design/date-time-pickers.md) §6 の PR-5）。`@banto/ui` に日時の入力 `DateTimeInput`（入力欄 1 つ ＋ カレンダーと時刻の一覧を並べたダイアログ 1 枚。日を選ぶと時刻の一覧へ移り、時刻を選ぶと値が決まって閉じる。`min`／`max`・`isDateDisabled`・`step`）と日時の純粋関数（`parseDateTimeText`・`parseIsoDateTime`・`isIsoDateTime`・`formatDateTimeText`・`joinDateTime`）を追加。値は**タイムゾーンを持たない壁時計の時刻** `YYYY-MM-DDTHH:mm` か `null` で、入力欄の表示は空白区切り（`2026-11-07 09:30`）。`UiMessages` に任意の `dateTimePickerOpen`・`dateTimePickerChange`・`dateTimePickerDialog`・`dateTimeFormatHint`。カレンダー部分は内部の `MonthCalendar.svelte` に切り出して `DateInput` と共有（`DateInput` の挙動は不変）。`@banto/forms` の `FieldType` と `@banto/grid-svelte` の `SchemaFieldType`・`CellEditorType` に `'time' | 'datetime'` を追加（鏡像）。`FieldDef`／`SchemaField` に任意の `step`（分）、`GridColumn` に任意の `editorStep`。注入の口に `time`・`datetime` を追加（`provideFieldInputs`／`provideCellEditors`、props は `TimeFieldInputProps`・`DateTimeFieldInputProps`・`CellTimeEditorProps`・`CellDateTimeEditorProps`）。注入が無ければネイティブの `time`／`datetime-local`。検証（形式・`min`／`max`・datetime の `isDateDisabled`・`step`）を forms・grid・`parseCellInput`（セルの確定・貼り付け・CSV）に date と同じ規則で追加（`ValidationMessages`／`ColumnValidationMessages` に任意の `timeInvalid`・`timeMin`・`timeMax`・`timeStep`・`dateTimeInvalid`・`dateTimeMin`・`dateTimeMax`、既定は日本語）。空は `null`、秒付き・`24:00`・日付だけは失敗、年を省いた日時はセルで打ったときだけ。`columnsFromSchema` の datetime の列は空白区切りで表示する。`banto-core` に検証関数（`banto_core::datetime` の `is_iso_date`・`is_iso_time`・`is_iso_datetime`・`is_on_time_step`・`validate_date`・`validate_time`・`validate_datetime`。正規の形だけを受け付け、既定の文言は TS と同じ）を追加し、境界値の表 `crates/banto-core/tests/datetime-cases.json` を Rust と TS の両方のテストで回す。admin-template はルートのレイアウトで `TimeInput`・`DateTimeInput` も注入し、ui-demo に `DateTimeInput` の見本を置いた。派生アプリへの影響: 追加のみ（既存の型の挙動は変わらない）。時刻・日時の列を足すときは DB を TEXT にし、Rust の入力の検証から `banto_core::datetime` を呼ぶ（[docs/upgrading.md](docs/upgrading.md)「時刻・日時の型」）。
- feat(grid-svelte): `@banto/grid-svelte` の date のセル編集に日付ピッカーの注入の口を追加（`provideCellEditors({ date })` の context と `BantoGrid` の `cellEditors` prop。prop が型ごとに優先し、注入が無ければネイティブの入力のまま。渡す props は `CellDateEditorProps`）。注入した部品はセル編集の状態遷移をそのまま使い、カレンダーで日を選んでも下書きに入るだけで確定しない（Enter・Tab・セルの外を押すと確定）、Esc の 1 回目はカレンダーを閉じ 2 回目で編集を取り消す、ボタンや日をマウスで押しても確定も編集欄の消失も起きない（`relinquishFocus` の判定を部品全体に広げた）。`parseCellInput` の date が素通しをやめ、寛容な形（`2026/11/7`・全角など）を `YYYY-MM-DD` に直し、空は `null`、実在しない日・別の順・時刻付きは失敗にする（年を省いた `11/7` はセルで打ったときだけ今年として受け付け、貼り付けと CSV では失敗）。セルの確定・貼り付け・CSV 取り込み（`convertCsvRow`）に効く。`columnsFromSchema` の date の列に forms と同じ形式・`min`／`max`・`isDateDisabled` の検証を追加（`SchemaField` に `isDateDisabled`、`ColumnValidationMessages` に任意の `dateInvalid`・`dateMin`・`dateMax`・`dateDisabled`、既定は日本語）。`GridColumn` に任意の `editorMin`・`editorMax`・`isDateDisabled`（カレンダーの範囲と無効日）を追加。admin-template はルートのレイアウトで `@banto/ui` の `DateInput` を注入し、ui-demo に日付の列を持つグリッドの見本を置いた（[date-time-pickers.md](docs/design/date-time-pickers.md) §6 の PR-4）。**派生アプリへの影響: date のセルの空が `''` から `null` に変わり、今まで素通しで入っていた日付でない文字列は入らなくなる**。移行は [docs/upgrading.md](docs/upgrading.md)「グリッドの日付のセル」。
- feat(forms): `@banto/forms` の date 型に日付ピッカーの注入の口を追加（`provideFieldInputs({ date })` の context と `BantoForm` の `fieldInputs` prop。prop が型ごとに優先し、注入が無ければネイティブの入力のまま）、`FormDraft` 用の `DraftDateField` を追加。`validateField` に date の形式（`YYYY-MM-DD` の実在の日）・`min`／`max`（`FieldDef` の `min`／`max` を `number | string\|number | string` に広げ、date は正規の文字列で読む）・`isDateDisabled` の検証を追加（`ValidationMessages` に任意の `dateInvalid`・`dateMin`・`dateMax`・`dateDisabled`、既定は日本語）。`FormDraft.commit` は寛容な日付の文字列を `YYYY-MM-DD` に直す。admin-template はルートのレイアウトで `@banto/ui` の `DateInput` を注入し、ui-demo の Modal にも日付の入力を置いた（[date-time-pickers.md](docs/design/date-time-pickers.md) §6 の PR-3）。`@banto/grid-svelte` の `SchemaField` の `min`／`max` も鏡像として `number | string\|number | string` に広げた（数値の範囲だけを読む）。**派生アプリへの影響: 空の日付が `''` から `null` に変わる**（`DateField` の `onInput`・`createFormStore`／`createFormDraft` の初期値・`FormDraft.commit`）。移行は [docs/upgrading.md](docs/upgrading.md)「日付のフィールド」。
- feat(ui): `@banto/ui` に時刻の入力 `TimeInput`（直接打てる入力欄 ＋ 時刻の一覧。APG の combobox ＋ listbox で、一覧を開いてもフォーカスは入力欄のまま `aria-activedescendant` で項目を指す。`step`（分）を指定すると一覧はその刻み、省略すると 30 分刻みで手入力は任意の分を受け付ける。`min`／`max` の外の時刻は一覧で選べない）と、時刻の純粋関数（`parseTimeText`・`parseIsoTime`・`timeOptions`・`isOnTimeStep`・`nearestTime` など、`datetime.ts`）を追加。値は `HH:mm`（24 時間）か `null` で、表示はロケールによらず `HH:mm`。`UiMessages` に任意の文言 `timePickerOpen`・`timePickerList`・`timeFormatHint` を追加（既定は日本語）。ポップオーバーの中だけをスクロールする処理を内部モジュール（`anchoredPopover.ts` の `revealInPopover`）へ移して `DateInput` と共有（`DateInput` の挙動は不変）。ui-demo に見本を掲載し、一覧を開いた状態の基準画像を追加（[date-time-pickers.md](docs/design/date-time-pickers.md) §6 の PR-2）。派生アプリへの影響: 追加のみ。forms・grid に時刻の型はまだ無く、つなぎ込みは PR-5。
- feat(ui): `@banto/ui` に日付の入力 `DateInput`（直接打てる入力欄 ＋ 横のボタンで開くカレンダー。APG の Date Picker Dialog に沿ったキー操作・`min`／`max`・`isDateDisabled`・`Intl` による月名・曜日名・`locale`／`weekStartsOn`）と、解析・暦の純粋関数（`parseDateText`・`addMonths`・`monthGrid` など、`datetime.ts`）を追加。値は `YYYY-MM-DD` か `null`。`UiMessages` に任意の文言 `datePickerOpen`・`datePickerChange`・`datePickerDialog`・`datePickerPrevMonth`・`datePickerNextMonth`・`datePickerPrevYear`・`datePickerNextYear`・`datePickerToday`・`datePickerClear`・`dateFormatHint` を追加（既定は日本語）。`Menu` の位置決めを内部モジュール（`anchoredPopover.ts`）へ切り出して共有（`Menu` の挙動は不変）。ui-demo に見本を掲載し、カレンダーを開いた状態の基準画像を追加（[date-time-pickers.md](docs/design/date-time-pickers.md) §6 の PR-1）。派生アプリへの影響: 追加のみ。forms・grid の date 型は今までどおりネイティブの入力で、つなぎ込みは後の PR。
- fix(theme, ui): テーマ `glass` で、日付・時刻ピッカー（DateInput / TimeInput / DateTimeInput / DateRangeInput）や Menu・FilterPopover・ColumnsMenu・TreeSelect・OverlayPanel・CommandPalette・Toast など浮く面の背景が半透明で、下のページの文字が透けて読みにくかった。`--banto-surface-overlay` を glass では不透明（明 `#ffffff` / 暗 `#262a31`）に固定（文字とのコントラストは明 16.9:1・暗 12.0:1）。ドックのランチャーバーの地は `surface-overlay` の 50% なので、glass では以前より少しだけ濃くなる（標準テーマと同じ見え方）。あわせて、面の上に置く primary の文字色のトークン `--banto-primary-text`（明 `#2563eb`・暗 `#60a5fa`）を足し、ピッカーの「クリア」「今日」や選択中の値の色を `--banto-primary` から替えた（暗い面 `#262a31` で 3.91:1 だったのが 5.67:1 になり、axe の color-contrast を満たす。標準テーマの暗い配色にあった同じ不足も直る）。
- fix(ui): `TimeInput`・`DateTimeInput` の時刻一覧を、値が空のとき先頭の 00:00 ではなく今の時刻に最も近い項目（刻みに合わせ、min / max の範囲に収める）を指してスクロールして開くようにした（値は変えない。値があるときは従来どおり選択中の項目へ。[date-time-pickers.md](docs/design/date-time-pickers.md) §5.4）。「今」は端末の時計。
- fix(admin-template): `items.updated_at` を、アプリのプロセスが動く PC のローカル日付（Rust の `chrono::Local`、`YYYY-MM-DD`）で書くよう修正（PR #533）。これまでは SQL 式（SQLite の `date('now')` = UTC、PostgreSQL の `CURRENT_DATE::text` = DB サーバーの TZ）で書いていたため、日本時間 0〜9 時に保存した行が前日の日付になり、ピッカーの「今日」での期間絞り込みに出なかった。日付は SQL にパラメータで束縛し、`ItemsService::with_today` でテストから固定できる。派生アプリへの影響: `updated_at` の基準が「サーバーの UTC／DB の TZ」から「アプリのローカル日付」に変わる（意図した挙動変更）。既存の行は書き換えない。`admin-template-core` に `chrono`（`clock` のみ）が依存として増える（ADR-0002 の例外、[ADR-0028](docs/adr/0028-chrono-local-date.md)）。保存形式（TEXT の `YYYY-MM-DD`）は変わらない。
- fix(admin-core, banto-storage): InMemory の DataProvider の `lt`/`lte`/`gt`/`gte` が日付・日時の文字列を `Date.parse` で比べ、SQL（TEXT の文字列比較。PostgreSQL は `COLLATE "C"`）と食い違っていた（日付は UTC・日時はローカル解釈で、混ざると順序がずれる）のを、両方が数値でない文字列同士は符号単位順の文字列比較にそろえた。数値の比較は変えない。共通 fixture `filter-between-parity.json` に `compare` を足し、SQLite・PostgreSQL・InMemory で突き合わせる。
- fix(ui, grid-svelte): grid のセル編集の日付・時刻部品を行に収める。`.cell-editor-host` が `--banto-control-height` を行の内側（既定 36px の行は下罫線を引いた 35px）に上書きし、`--banto-time-input-width`・`--banto-datetime-input-width` も `100%` にしてセル幅に広げる。3 つの幅の変数を公開の調整点として文書化し、幅 320px・文字 200% の e2e（`e2e/visual/date-picker-narrow.spec.ts`）を追加
- fix(users): 新しく作るアカウントのユーザー名に `.` を使えないようにする（初回セットアップ・ユーザー追加が `username` のフィールドエラーで拒否する）。利用者ごとの UI 設定のキー `ui.{username}.{key}` が `.` 入りの名前で他の利用者のキーと衝突し得たため。キーの形式は変えない。この制限より前に作られた `.` 入りのアカウントはそのまま使える（ログイン・編集・削除・パスワード変更は変わらない）が、UI 設定のキーが衝突し得る点は残る
- fix(scaffold): 添付を外すプリセット（minimal / standard / display）が `apps/admin-template/core/src/rest/attachments.rs` を消さず、`mod attachments;` だけ消えて「コンパイル対象外・削除済みの `crate::attachment_wiring` を参照する」孤児ファイルが残っていたのを修正。あわせて `rest/mod.rs` に残って unused import 警告（`-D warnings` で失敗）になっていた 5 件（`Bytes`・`Query`・`Response`・`BantoError`・`Deserialize`）を外す。`scaffold.test.mjs` に回帰テスト、`remove-optional-assets.md` の添付の手動手順にファイル削除と import 整理を追記。
- perf(admin-template): 期間の絞り込み `between` の PostgreSQL の式 `CAST(列 AS TEXT) COLLATE "C"` に合わせた索引を `items.updated_at` に追加（migration `0009_items_updated_at_index.sql`、SQLite は通常の索引）。`pg_smoke` で `EXPLAIN` により使われることを確認。scaffold は items を外すとき 0009 も外す。派生アプリ向けの注意は [docs/upgrading.md](docs/upgrading.md)「期間の絞り込み」。（#536）
- refactor(charts): `@banto/charts` の CSS の生の寸法（文字サイズ 25 宣言すべて・余白 12・枠線幅 2）を `--banto-font-size-*` / `--banto-space-*` / `--banto-border-width` へ置き換え（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) §6 の PR-5）。SVG の軸・凡例の文字は `10px`・`11px` → `xs`・`sm`、Tooltip・GanttChart の項目名の `12px` と空状態の `0.85rem` → `md`、Gauge の値の `1.6rem` → `xl`。**挙動の変化**: チャートの文字が root の文字サイズとトークンの上書きに追従するようになったので、軸ラベルの幅の見積もり（`core/labels.ts`）に、描画したラベルの計算済みの文字サイズを渡すようにした（D9。読めない SSR・テストでは従来どおり 11px）。root の文字サイズを大きくした環境やトークンを上書きした派生アプリで、長い軸ラベルが切れず左右の余白が広がる。あわせて、余白を固定値（左 48px・Pareto の右 40px）で持っていた縦の `BarChart`・`BoxPlot`・`Histogram`・`ParetoChart` も既定の余白を下限として目盛りの幅に合わせて広がり（`margins` を渡したときはその値のまま）、`RadarChart` は周囲のラベルの余白を文字サイズに比例させ、左右のラベルが収まる半径に抑える（`core/radar.ts` に `labelFitRadius` を追加。index からは出さない）。見積もりの余白の上限（既定 140px）も、11px 基準で文字サイズに比例する（`max` を渡したときはその値）。標準の 14px でも、見積もりが既定の余白を超える目盛り（例: 縦の棒グラフの `100,000`）では余白が数 px 広がる。丸めにより文字サイズが最大約 0.35px（Gauge の値は 2.1px）、余白が最大約 1.4px 動く。左右の余白は、測ったコンテナの幅が分かるときはそれぞれ幅の 40% で止まる（狭い幅で描画域が潰れないように。横の `BarChart`・`Heatmap`・`GanttChart` と縦の 4 グラフにも適用）。上限に当たってもなお収まらない項目名（横の `BarChart`・`Heatmap` の縦軸・`GanttChart` のタスク名・`RadarChart` の周囲のラベル。`RadarChart` の半径は使える大きさの半分を下限にする）は、末尾を「…」で切り、全文を SVG の `<title>` に入れる。線の太さ・ドット・色見本の大きさなどの部品の形は対象外。公開 API: props は変えない。`leftMarginFor`・`rightMarginForLastTick` の options に省略可能な `totalWidth` を追加（`leftMarginForTicks` と同じ 40% の上限。省略時は従来どおり）。`truncateLabel` を `core/labels.ts` に追加（index からは出さない）。`leftMarginFor` の丸めを四捨五入から切り上げに変更（余白を決めたラベルが切られないように。1px 未満の差）。
- refactor(admin-template): ログイン・サイドバー・ヘッダー・起動スプラッシュ・エラー画面・シェルの本文領域（`(app)/+layout`）・`ui-demo`・`app.css` の CSS の生の寸法（余白 64 値・文字サイズ 17・枠線幅 12）を `--banto-space-*` / `--banto-font-size-*` / `--banto-border-width` へ置き換え（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) §6 の PR-6d。これで admin-template の画面の移行は完了、残りは機械検査 D8）。派生アプリへの影響: 丸めにより余白が最大約 2.1px、文字サイズが最大約 3.5px（ログインの見出し `1.5rem` → `xl`）動く箇所がある。サイドバーの幅・アイコン／ロゴ・件数バッジ・強調の縁・1px の区切り線・ログインのカード幅は対象外。API・DOM は変えない。
- refactor(admin-template): ダッシュボード（`dashboard/+page.svelte`、`DashboardPanel`、`DashboardMemoField`、別窓の `panel/[id]`）の CSS の生の寸法（余白 33 宣言・文字サイズ 17・枠線幅 6）を `--banto-space-*` / `--banto-font-size-*` / `--banto-border-width` へ置き換え（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) §6 の PR-6c）。派生アプリへの影響: 丸めにより余白が最大約 1.4px、文字サイズが最大約 2.1px（KPI の値の `1.6rem` → `xl`）動く箇所がある。グリッドの列幅・カードの最小寸法・アイコン・パネルの高さ・999px 角丸は対象外。API・DOM は変えない。
- refactor(admin-template): 一覧・詳細画面（items の一覧・グリッド 2 種・`[id]`・`new`・`report`、users、audit-log、tree、`DraftSettleDialog`）の CSS の生の寸法（余白 59 宣言・文字サイズ 25・枠線幅 10）を `--banto-space-*` / `--banto-font-size-*` / `--banto-border-width` へ置き換え（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) §6 の PR-6b）。`@banto/theme` に本文の大きさのトークン `--banto-font-size-base`（`1rem`。追加のみ・後方互換）を足し、設定画面のカード見出しの `font-size: 1rem` もこれへ置き換えた。派生アプリへの影響: 丸めにより余白が最大約 1.4px、文字サイズが最大約 1.05px（audit-log の詳細見出しの `0.95rem`）動く箇所がある。強調の縁（3px）・列幅・max-width・視覚的に隠す要素（sr-only）の寸法は対象外。API・DOM は変えない。
- refactor(admin-template): 設定画面（`apps/admin-template/src/routes/(app)/settings/settings.css`）の CSS の生の寸法（余白 54 宣言・文字サイズ 18・枠線幅 11）を `--banto-space-*` / `--banto-font-size-*` / `--banto-border-width(-strong)` へ置き換え（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) §6 の PR-6 のうち設定画面）。派生アプリへの影響: 丸めにより余白が最大約 1.4px、文字サイズが最大約 0.7px 動く箇所がある。外観プレビューの中の寸法（80×48 などの大きさ・内側の余白）・列幅・`max-width`・本文サイズの `1rem` は対象外。API・DOM は変えない。
- refactor(dock-svelte, report, attachments): `@banto/dock-svelte`・`@banto/report`・`@banto/attachments` の CSS の生の寸法（余白 25 宣言・文字サイズ 18・枠線幅 11）を `--banto-space-*` / `--banto-font-size-*` / `--banto-border-width(-strong)` へ置き換え（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) §6 の PR-4）。派生アプリへの影響: 丸めにより余白が最大約 1.4px、文字サイズが最大約 1.1px 動く箇所がある。リサイズハンドル・アイコンの大きさ・列幅などの部品の形と、印刷用の CSS（`print.css`・`@page` の余白・用紙の幅。mm / pt / em 単位で紙面基準）は対象外。API・DOM は変えない。
- refactor(grid-svelte, forms, tree-svelte): `@banto/grid-svelte`・`@banto/forms`・`@banto/tree-svelte` の CSS の生の寸法（余白 47 宣言・文字サイズ 19・枠線幅 27）を `--banto-space-*` / `--banto-font-size-*` / `--banto-border-width(-strong)` へ置き換え（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) §6 の PR-3）。派生アプリへの影響: 丸めにより余白が最大約 2.1px（グリッドの集計チップなどの `0.1rem`。ほかは約 1.4px 以内）、文字サイズは最大約 0.7px 動く箇所がある。列幅・アイコンの大きさ・区切り線などの部品の形は対象外。API・DOM は変えない。
- refactor(ui): `@banto/ui` の CSS の生の寸法（余白 70・文字サイズ 17・枠線幅 14）を `--banto-space-*` / `--banto-font-size-*` / `--banto-border-width` へ置き換え（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) §6 の PR-2）。派生アプリへの影響: 丸めにより余白が最大約 1.4px（`LauncherBar` の `top` など）、文字サイズは最大約 0.7px 動く箇所がある。API・DOM は変えない。
- refactor(core): 手書きの日付変換（Howard Hinnant の `civil_from_days` の 3 コピー: `banto-attachments`・`banto-admin-services` の `backup.rs`・app の `core/src/db.rs`）を `chrono`（`default-features = false`、feature なし。`banto-core` が依存）に置き換え、`banto_core::datetime` の `iso_datetime_from_system_time` / `iso8601_utc_from_system_time` / `iso_date_from_days_since_epoch` の 1 か所にまとめた。DB に保存する形式・ファイル名の形式・エポック前や小数秒の扱いは変えない。範囲外の値（バックアップの mtime など）は panic せずエポックにする。`Cargo.lock` に新しい crate は増えない。派生アプリへの影響: `banto-core` が `chrono` に依存する。理由と代替案は [ADR-0029](docs/adr/0029-chrono-datetime-formatting.md)、conventions §3 の表を更新。
- refactor(core): REST と Tauri に重複していた処理を共通化した。item 削除時の添付の掃除と監査 detail（`sweep_item_attachments`）・添付の監査 detail（`attachment_audit_detail`）は `admin-template-core` の `attachment_wiring` へ、監査ログ一覧の前の保持期間削除は `AuditLogService::prune_before_list` へまとめた。挙動は変えない。派生アプリへの影響: 添付を手で外す場合は `attachment_wiring.rs` も消す（[remove-optional-assets.md](docs/recipes/remove-optional-assets.md)、`pnpm scaffold` は対応済み）。
- refactor(server): LAN 到達先のアドレスを返す `banto_server::lan_addrs_for_bind` を追加し、`lan_urls_for_bind` はそれを URL に整形するだけにした（シグネチャと返り値は変えない）。`users_create` の応答型は REST と Tauri で `banto_admin_services::users::UserIdentityView` にまとめた（JSON の形は変えない）。
- refactor(server): 使われていなかった `PortFallbackError::into_error` を削除した。派生アプリへの影響: 呼んでいる場合は `PortFallbackError` を `match` して `error` を取り出す（`Exhausted { error, .. }` と `Failed(error)`）。
- refactor(ui,grid): `@banto/ui` の DateInput / DateTimeInput / DateRangeInput / TimeInput に 4 つ並んでいた「`pointerdown` を root から外へ出さない」`$effect` を、内部の `stopPointerdown`（`{@attach}`、ネイティブ listener のまま）にまとめた。`@banto/grid-svelte` の `core/dateRange.ts` にあった `isLeapYear` / `daysInMonth` / `pad` の複製を `core/date.ts` の共有に寄せ、`@banto/ui` の未使用だった `endOfMonth`（package 外へ export していない）を削除した。挙動と公開 API は変えない。
- chore(verify): verify-architecture に文字サイズと枠線幅の生値を検査する rule `raw-dimensions` を追加（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) §7 D8、conventions §9）。`packages/*/src` と `apps/admin-template/src` の `<style>`・`.css` で `font-size`・`font`・`border` 系・`outline` 系の幅に生の絶対値があると落ちる（余白は見ない。例外は `RAW_DIMENSION_ALLOWLIST` に理由つき）。残っていた `@banto/ui` の `font-size: 1rem` 6 件・`panel/[id]` の `1px`・display 雛形の `1rem`/`0.9rem` をトークンへ（ずれは雛形の 0.35px のみ）。派生アプリへの影響: verify-architecture は scaffold でそのまま配られるので、派生アプリが `pnpm verify:architecture` を回すと自分の `packages/` と `apps/admin-template/src` に足した CSS も同じ検査に掛かる（scaffold 直後の 4 プリセットは通ることを確認済み）。新しく書く CSS は `--banto-font-size-*`・`--banto-border-width*` で書き、部品の形などの例外は許可リストへ足す。

## [6.10.0] - 2026-11-05

**v6.10.0 — グリッド・フォーム・設定画面のアクセシビリティ修正と、共通の入力スタイル（`@banto/theme` の opt-in クラス、`BantoForm` の `appearance="underline"`）の追加。** 版の種類: minor（機能追加。公開 API の削除・改名なし。挙動変更は下の「移行注意」を参照。[docs/publishing.md](docs/publishing.md)「バージョニング規約」）。
派生アプリへの影響: git 依存のタグは `v6.9.1` から `v6.10.0` に上げられるが、`BantoForm` の入力 ID・入力の既定背景・グリッドのセルエラー表示は挙動が変わるため、該当する画面の確認が要る。コピーしたテンプレートは、設定画面・ログイン・ユーザー管理・商品作成などの取り込みが任意で可能。

| 経路                             | 影響         | 内容                                                                                                                                                                      |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり         | `v6.9.1` → `v6.10.0`（npm と Rust を同じタグに）。追加 API あり、公開 API の削除・改名なし。挙動変更（入力 ID・既定背景・セルエラー・optional message）は下の「移行注意」 |
| B. コピーしたテンプレート        | あり（任意） | 設定画面・ログイン・ユーザー管理・商品作成/編集・メッセージ辞書・CSS・ファイアウォール補助プログラム（`elev`）の変更。取り込まなくても動く                                |
| C. DB・設定・配布資産            | なし         | マイグレーション、`tauri.conf.json`（版数以外）、設定キーの変更は無い                                                                                                     |

### A. 共通パッケージ・クレート

- 対象: `@banto/grid-svelte`・`@banto/forms`・`@banto/theme`・`@banto/ui`（実装変更あり）、`banto-admin-services`（`sysinfo` 0.40 対応。公開 API は不変）。他のパッケージ・クレートは版数と `svelte` の範囲（`^5.57.3`）のみ。
- 更新: `v6.9.1` → `v6.10.0`（npm と Rust を同じタグに）。
- 追加 API（いずれも任意。既定の挙動は維持）:
  - `@banto/forms`: 型 `FormAppearance`（`'default' | 'underline'`）、`BantoForm` の `appearance` プロパティ（既定 `'default'`）、8 種類の field コンポーネントの `id`・`aria-describedby`・`class` プロパティ（`id` 未指定なら従来どおり項目名）。
  - `@banto/ui`: `PageHeader` の `hideTitle`（見出しを読み上げ用に残し、表示は非表示にする）。
  - `@banto/theme/css`: opt-in クラス `.banto-field`（`-control`・`-label`・`--stacked`）、`.banto-switch-field`、`.banto-section-nav`。
  - `@banto/grid-svelte`: 任意の messages `filterAppliedDescription`・`filterOperatorLabel`・`filterValueLabel`・`inlineEditErrorLabel`・`inlineEditErrorHint`。
- 移行注意（消費側に影響する挙動変更。どれも型エラーにはならない）:
  1. **`BantoForm` 内部の入力 ID**: 入力の `id` が項目名（`def.name`）から、フォームごとに一意な生成 ID に変わる。`document.getElementById(項目名)` や `#項目名` のセレクタで入力を参照しているテストやスクリプトは、ラベル経由（`getByLabel` など）に置き換える（#498）。なお readonly のテキスト系項目は `disabled` ではなくネイティブの `readonly` になる（select・checkbox は従来どおり `disabled`）。
  2. **入力・ネイティブ select の既定背景が透明になる**: `@banto/forms` の各 field の背景が不透明な塗りから `transparent` になる。不透明な背景を前提にした画面は、親の背景との重なりで読みにくくならないか確認する（[ADR-0025](docs/adr/0025-transparent-control-backgrounds.md)、#502）。
  3. **グリッドのセルエラー**: `BantoGrid` が `.banto-grid-frame` の wrapper を持つようになり、セルエラーは表の可視範囲に収まるキーボード読み取り可能な領域で表示される。エラー中の Tab はエラー領域へ移動し（再送信しない）、再試行は Enter で行う。`.banto-grid` の直下構造やエラー中の Tab に依存する CSS・テストは見直す（[ADR-0027](docs/adr/0027-grid-error-reader.md)、#505・#507・#508）。
  4. **optional message の追加**: `@banto/grid-svelte` の messages に上記 5 件を追加した（既定の日本語文言あり。未指定でも動く）。多言語化している派生アプリは辞書に追加する（#505・#506・#508・#509）。
- 依存を上げずに留まれるか: できる（`v6.9.1` のまま使える）。

### B. コピーしたテンプレート

- 対象: `apps/admin-template/src/routes/(app)/settings/`（`+layout.svelte`・各 `*Section.svelte`・`LanReachCheckPanel.svelte`・`settings.css`）、`login/+page.svelte`、`(app)/users`・`items`・`items/new`・`items/[id]`・`audit-log`・`dashboard`・`tree`・`ui-demo`、`src/lib/`（`Header.svelte`・`navigation.ts`・`i18n.ts`）、`src/app.css`、`messages/ja.json`・`en.json`（`grid.*` の追加ほか）、`elev/src/powershell.rs`・`rules.rs`、`src-tauri/src/firewall_status.rs`、`e2e/`。
- 関連 Issue・PR: Issue #495、PR #496、#497、#499〜#511。
- 手で取り込む変更: 設定画面の下線型入力・ナビゲーション・スイッチ（[ADR-0022](docs/adr/0022-settings-controls.md)、[ADR-0023](docs/adr/0023-shared-control-styles.md)）、`BantoForm appearance="underline"`（[ADR-0024](docs/adr/0024-schema-form-appearance.md)）、透明な入力背景（ADR-0025）、共通のスイッチ・checkbox（[ADR-0026](docs/adr/0026-shared-boolean-controls.md)）、グリッドのエラー読み取り（ADR-0027）。ファイアウォール支援の段階 1 は、識別子検証・ルール名・PowerShell 変換を段階 2 の `elev` の関数に共有した（#511）。外から見える挙動は変えない。
- 派生側の独自変更と衝突しやすい箇所: 設定画面の各セクションとその CSS、ログイン画面の入力、`app.css` の入力スタイル、`elev` と `firewall_status.rs`。
- 取り込まなくても動くか: 動く（A の移行注意 1〜3 の確認は要る）。
- 手本: 上記の `apps/admin-template/` のファイル。

### C. DB・設定・配布資産

- マイグレーション: 不要。
- 設定キー・`tauri.conf.json`・配布物: 変更なし（`tauri.conf.json` は版数のみ）。
- 戻せる条件: DB・設定は変わらないため、タグを戻すだけで戻せる。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画される）。
2. `BantoForm` の入力を ID で参照している箇所、入力の背景を前提にした画面、グリッドのセル編集エラーの表示と Enter での再試行、設定の各カテゴリの表示と保存。
3. Rust: `cargo check` / `cargo test`。

### セキュリティ

- なし。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `0acaa5b`、`workflow_dispatch`）: [run 41876322896](https://github.com/tyaro/banto/actions/runs/41876322896)（success）。
  - タグの push（`v6.10.0`、main の `0acaa5b`）: [run 41879665011](https://github.com/tyaro/banto/actions/runs/41879665011)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。Node.js は npm のジョブも diagnostic のジョブも同じ版だった。

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.22.1                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.3                         |
    | SvelteKit          | 3.1.0                          |
    | Vite               | 8.3.5                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.1（58cf8f9c3 2026-10-13） |

  - 出所: Node.js は `node: v24.22.1`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.3` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.1`。

### 変更点

- **refactor(firewall):** 段階 1（読み取り）の識別子検証・グループ名・プログラムルール名・PowerShell 単一引用符・`-EncodedCommand` 変換を、段階 2 の helper（`admin-template-fw-elev`）の関数へ一本化した。段階 1 が段階 2 のルールを見つけられる条件をコメントの約束ではなくコンパイルで保つ。移動のみで挙動・Tauri コマンド・TS 側は変えない。

- **refactor(grid):** `BantoGrid` のセルエディタ（select / checkbox / text・number・date）のテンプレートを `CellEditor.svelte` へ切り出した。DOM・属性・挙動は変えず、編集の状態遷移・キー/blur 処理・フォーカス処理は `BantoGrid` に残す。公開 API は変えない。

- **fix(grid):** 適用済みフィルタに二重下線と列固有の説明を追加。強制配色でも色以外の印を残し、ボタン幅と開閉・条件適用・フォーカス処理を維持する。説明は optional message 経由で日英へ対応（#495）。

- **fix(grid):** 長いセルエラーを表の可視範囲に収め、折返し・上下切替・領域内スクロールで全文を読めるようにした。scrollport と editor DOM を保ち、Tab でエラー参照、領域の Shift+Tab / Escape で入力へ戻る。エラー中の再試行は Enter とし、読み直しによる再送信を防ぐ。新しい wrapper とメッセージの移行注意を記載（#495、ADR-0027）。

- **fix(grid):** セル編集で変換中（`isComposing` / `keyCode 229`）・処理済みのキーによる保存・取消・移動を防ぐ。フィルタの Enter / Escape にも229互換判定を追加。通常キーと pending 抑止・blur 確定・編集セッションは維持する（#495）。

- **fix(grid):** フィルタの条件・値へ個別の名前を追加し、展開状態・dialog 参照・開閉フォーカスを整えた。同じボタンで閉じ、内部の Escape・適用・クリア後は元へ戻り、外クリックではフォーカスを奪わない。グリッド・見出し・フィルタに実線フォーカス、強制配色の選択範囲に破線枠を追加（#495）。
- **fix(grid):** 数値フィルタを空にして適用すると `NaN` の条件が残る不具合を修正。数値の `0` は維持し、空欄は既存の仕様どおり条件解除として扱う。

- **fix(grid):** セル editor の入力名・検証状態・エラー関連付けを追加し、保存待ちを編集中セルの `aria-busy` で示す。エラー ID はグリッドごとに一意とし、checkbox editor の寸法を共通トークンへ揃えた。編集・保存・選択・フォーカス処理は維持する（#495）。

- **feat(theme):** 設定のスイッチを theme CSS の opt-in class に共通化。native 状態・ラベル・Space 操作を保ち、forced-colors でもトラック・丸・フォーカスを識別できるようにした（#495、ADR-0026）。
- **style(forms):** フォームと列表示メニューの native checkbox の寸法・実線フォーカス・無効状態を統一。最後の表示列のロックや readonly の扱いは維持する。
- **fix(ui):** 設定全カテゴリの320px・文字200%表示に対応。カード幅、ボタン高さ、長いラベル、QR、ファイアウォール情報の折返しとヘッダーの省略表示を調整。列表示メニューが表ヘッダーの背面へ隠れる問題も修正した。

- **fix(settings):** 現在のパスワードだけが入力・自動入力された場合に未保存の変更と表示しない。新パスワードまたは確認欄の入力を未保存として保護し、失敗・破棄・保存中のガードは維持する。

- **style(ui):** シェル内のページは内容側の重複タイトルを非表示にする。`PageHeader hideTitle` で読み上げ用の見出しと説明・操作を残し、商品作成・編集のタイトルはシェルへ表示する。部品単独の既定表示は維持する。

- **style(forms):** 入力・ネイティブ select の既定背景を透明にし、hover / readonly でも塗りを加えない。共通下線型、`appearance="default"`、各 field の直接利用、従来の `.banto-input` が対象。枠・下線・フォーカス・文字色・無効状態の減光や破線は維持する（#495、ADR-0025）。

- **feat(forms):** `BantoForm` に任意の `appearance="underline"` を追加し、対応版 theme の共通スタイルを商品・ユーザー管理のフォームで採用した。ラベルは上に固定し、checkbox と既定表示は維持する。各 field の `class` 転送、固定ラベルでの date / textarea 対応も追加。値・検証・送信・エラー関連付けは変わらない（#495、ADR-0024）。

- **refactor(login):** ログイン・初回セットアップの入力を theme の共通スタイルへ移行し、長いパスワード項目名は入力の上に表示する。フォーム全体のエラーを alert として通知し、認証処理・自動入力用属性・LAN のログイン保持条件は維持する（#495）。

- **refactor(theme):** 設定で採用した下線型入力・浮動ラベル・ページナビを `@banto/theme/css` の opt-in クラスとして共有し、設定画面を移行した。app.css / Tailwind なしでも利用でき、長いラベルには通常フローで上に表示する形式を用意した。既存フォームの既定表示・SCADA 側の採用範囲は維持する（#495、ADR-0023）。

- **fix(forms):** `BantoForm` のラベル・入力・エラーをフォームごとに一意な ID で関連付けた。内部の入力 ID は項目名から生成 ID に変わるため、DOM 参照はラベル経由へ移行する。各 field の直接利用では既定 ID を維持し、任意の `id`・`aria-describedby` を追加した。テキスト系の readonly を disabled から分離し、読み取り専用欄の blur や数値ドラフトの確定が状態を変えないようにした。select / checkbox の disabled 表示と、readonly 値の検証・送信は維持する。forced-colors でもフォーカス枠が残るようにした（#495）。

- **chore(deps):** Svelte・Paraglide・Lucide・typescript-eslint を更新し、外部利用 fixture の Svelte 範囲と lockfile を管理アプリに揃えた（#494）。
- **chore(deps):** `uuid` を 1.28.0 から 1.29.0 に更新した（#492）。
- **ci:** `taiki-e/install-action` を 2.88.0 のコミット SHA に更新した（#491）。

- **ui:** 設定カテゴリの下線型ナビゲーションと、移動型ラベル・下線付きのテキスト系入力およびネイティブ select を設定画面の正式デザインとして採用した（#495、[ADR-0022](docs/adr/0022-settings-controls.md)）。
- **ui:** 設定画面でヘッダーと重複していた内容側のタイトルを非表示にし、説明文とカテゴリナビゲーションから始まる構成にした。読み上げ用のページ見出しは維持した。

- **chore(deps):** `sysinfo` を 0.39.6 から 0.40.1 に更新し、初期化 API の `Result` 化に対応した。初期化できない場合はアプリの起動を止めず、従来の `metrics: null` に退避する。公開 API、CPU の更新間隔、`system` feature 限定を維持する（#493）。

## [6.9.1] - 2026-10-26

**v6.9.1 — RustSec の依存監査で検出された `ctutils` の脆弱性を修正し、既存の Dependabot 更新を取り込む。** 版の種類: patch（公開 API・アプリの機能・DB スキーマの変更なし。後方互換）。
派生アプリへの影響: git 依存のタグを `v6.9.0` から `v6.9.1` に上げられる。テンプレートをコピーして使う場合、依存と CI の更新は必要に応じて取り込む。

| 経路                             | 影響         | 内容                                                                                                                        |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり（任意） | npm と Rust の git 依存を同じ `v6.9.1` タグへ更新できる。公開 API は変わらない                                              |
| B. コピーしたテンプレート        | あり（任意） | `Cargo.lock`・`pnpm-lock.yaml`・Vite の範囲指定・GitHub Actions の更新を取り込める。`Cargo.lock` の更新は脆弱性の修正に必要 |
| C. DB・設定・配布資産            | なし         | マイグレーション、設定キー、配布形式の変更は無い                                                                            |

### 変更点

- **security:** `ctutils` 0.4.2 → 0.4.4。`digest` 0.11.3 を経由する依存に対し、[RUSTSEC-2026-0385](https://rustsec.org/advisories/RUSTSEC-2026-0385) の修正を `Cargo.lock` に取り込んだ（#487、#488、#489）。
- **chore(deps):** npm の minor/patch グループ（Vite 8.3.5 など）と Cargo の minor/patch グループ（Tokio、Tauri など）を更新した。外部 consumer fixture の Vite 範囲と lockfile も管理アプリと一致させた（#488、#489）。
- **ci:** `Swatinem/rust-cache` と `taiki-e/install-action` を更新した（#487）。

### 消費側への注意

- 公開 API・DB スキーマ・設定キーの変更は無い。git 依存を使う派生アプリは、更新する場合に npm と Rust のタグを一緒に `v6.9.1` へ上げる。
- テンプレートをコピーした派生アプリには、今回の lockfile と CI の更新を必要に応じて取り込む。特に `Cargo.lock` の `ctutils` 0.4.4 は依存監査の修正に必要。

## [6.9.0] - 2026-10-22

**v6.9.0 — LAN 公開のファイアウォール支援（#219。状態の確認・別の端末からの到達確認・昇格の補助プログラムによる許可と解除）と、Windows のインストーラの既定を perMachine にして補助プログラムを同梱。** 版の種類: minor（機能追加。後方互換。公開 API の削除・改名なし）。
中身は 3 つ: (1) ファイアウォール支援の段階 1（設定 > サーバ・接続の情報・「Windows ファイアウォールの状態」・「別の端末からの接続確認」。#459 ほか）、(2) 段階 2（昇格の補助プログラム `admin-template-fw-elev` による「ファイアウォールで許可する」「許可を外す」。[ADR-0021](docs/adr/0021-firewall-elevated-helper.md)）と、そのための **Windows のインストーラの既定の perMachine 化・補助プログラムの同梱**、(3) 配布用ビルドへの LAN の Web UI の埋め込み（`tauri:build:windows` に `--features embed-ui`、#478）と、適用状態・Program Files の外のコピーの表示の見直し（#479〜#482）。
派生アプリへの影響: タグを上げるだけで動く（経路 A は追加のみ）。ただしテンプレートを写している派生アプリは、**インストーラの既定が perMachine になり補助プログラムを同梱した**ので、コピー部分（`tauri.conf.json`・`src-tauri/tauri.fw-elev.conf.json`・`scripts/build-fw-elev.mjs`・`apps/admin-template/elev`・NSIS のフック・設定画面ほか）の取り込みが要る。取り込まなければ従来どおり動くが、ファイアウォール支援は使えない。手順と既存の per-user のインストールからの移り方は [docs/upgrading.md §4.1](docs/upgrading.md#41-windows-のインストール形態が-permachine-に変わる219-段階-2)。

| 経路                             | 影響         | 内容                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり（任意） | `v6.8.0` → `v6.9.0`（npm と Rust を同じタグに）。追加のみ: `banto-server` の `reach_check` モジュール（到達確認の保管所と口）・`bind_without_fallback`、`@banto/theme` の寸法トークン（`--banto-space-*`・`--banto-font-size-*`・`--banto-border-width*`）。既存の API・挙動は変わらない                                                                |
| B. コピーしたテンプレート        | あり（任意） | ファイアウォール支援の設定画面・Tauri コマンド（`firewall_rule_status`・`firewall_rule_change`・`reach_check_*`）・`/reach` ページ・`apps/admin-template/elev`・`tauri.conf.json` の `installMode: "perMachine"`・`tauri.fw-elev.conf.json`・`scripts/build-fw-elev.mjs`・`windows/fw-elev-hooks.nsh`・`server_status` の項目追加。取り込まなくても動く |
| C. DB・設定・配布資産            | あり（配布） | DB のマイグレーションは無い。インストーラの既定が perMachine に変わる（インストール先が Program Files、インストール時に UAC。データは `%APPDATA%\<identifier>\` のまま）。配布用ビルドは `tauri:build:windows`（NSIS のみ）                                                                                                                             |

### A. 共通パッケージ・クレート

- 対象: `banto-server`（`reach_check` の追加・`bind_without_fallback` の追加）、`@banto/theme`（寸法トークンの追加）。他は版数のみ。
- 更新: `v6.8.0` → `v6.9.0`（npm と Rust を同じタグに）。
- 追従: なし（追加のみ。削除・改名した API は無い）。`reach_check_router` はテンプレートの Tauri 組み込みサーバーにだけ載せる（`banto-serve` には載せない）。
- 依存を上げずに留まれるか: できる。

### B. コピーしたテンプレート

- 対象: `apps/admin-template/` の設定 > サーバ・接続（ファイアウォールの情報・状態・許可と解除・別の端末からの接続確認）、`/reach`、`src-tauri`（コマンド・昇格の起動のモジュール・`tauri.conf.json`・`tauri.fw-elev.conf.json`・`windows/fw-elev-hooks.nsh`）、`elev`（`admin-template-fw-elev`）、`scripts/build-fw-elev.mjs`・`scripts/rename.mjs`、CI の該当ジョブ。
- 関連 PR: #219 の各 PR（段階 1 の PR-A・PR-B・PR-C1〜C3、段階 2 の E1〜E4）、#459、#478、#481、#482。
- 手で取り込む変更: 手順は [docs/upgrading.md §4.1](docs/upgrading.md#41-windows-のインストール形態が-permachine-に変わる219-段階-2)。配布用ビルドは `pnpm --filter <app> tauri:build:windows` に切り替え、`server_status` の必須項目 `uiEmbedded` を画面側が読むようにする。
- 派生側の独自変更と衝突しやすい箇所: 設定 > サーバ・接続の画面、`tauri.conf.json` の `bundle`、インストーラの独自のフック。
- 取り込まなくても動くか: 動く（ファイアウォール支援が無いだけ）。ただしインストール形態を変えないなら per-user のままになり、段階 2 は使えない。
- 手本: `apps/admin-template/` の上記ファイル。

### C. DB・設定・配布資産

- マイグレーション: 不要。
- 戻せる条件: DB・設定は変わらない。インストール形態の移り方・戻し方は upgrading.md §4.1。
- 設定キー・`tauri.conf.json`・配布物: `bundle.windows.nsis.installMode` が `"perMachine"`、補助プログラムが本体 exe の隣に入る。`settings_set` は `server.` で始まるキーを拒否する（書き込みは `server_apply` だけ）。
- 順序: A・B を先に完成 → 検証用の環境でインストール・アンインストール（UAC とルールの解除を含む）→ 配布。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画される）。
2. 設定 > サーバ・接続の表示、「ファイアウォールで許可する」「許可を外す」、別の端末からの接続確認、perMachine のインストーラのインストール・アンインストール。
3. Rust: `cargo check` / `cargo test`。

### セキュリティ

- なし。昇格の補助プログラムは本体 exe の隣の固定名だけを起動し、Program Files の外のコピーでは UAC を出さずに止める（[ADR-0021](docs/adr/0021-firewall-elevated-helper.md)）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `workflow_dispatch` し、タグの push でも `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグの前（main の `1bd12fe`、`workflow_dispatch`）: [run 39761779831](https://github.com/tyaro/banto/actions/runs/39761779831)（success）。
  - タグの push（`v6.9.0`、main の `1bd12fe`）: [run 39762214432](https://github.com/tyaro/banto/actions/runs/39762214432)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。Node.js はジョブで違う（`node-version: 24` で最新の 24.x を引くため）: npm のジョブが 24.21.0、diagnostic のジョブが 24.22.0。

    | 項目               | 版                                 |
    | ------------------ | ---------------------------------- |
    | Node.js            | 24.21.0（diagnostic のみ 24.22.0） |
    | pnpm               | 10.33.0                            |
    | Svelte             | 5.57.2                             |
    | SvelteKit          | 3.1.0                              |
    | Vite               | 8.3.4                              |
    | vite-plugin-svelte | 7.3.1                              |
    | TypeScript         | 6.0.3                              |
    | Rust               | 1.99.1（58cf8f9c3 2026-10-13）     |

  - 出所: Node.js は `node: v24.21.0`・`node: v24.22.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.2` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.1`。

### Added

- 設定 > サーバ・接続に「ファイアウォールの許可に必要な情報」を追加した（#219 段階 1 の PR-A、Windows のみ・昇格なし）。稼働中のサーバーの値（`live`）から、実行ファイルの絶対パス・受信・TCP・待ち受け中のポート・プライベート・LocalSubnet を表示・コピーでき、管理者向けの `New-NetFirewallRule`（実行ファイル単位とポート単位の 2 形。ルール名は Tauri の `identifier`、文字列は単一引用符のリテラルにエスケープ）をコピーできる。同じ名前のルールが既にあるときは、コマンドは何も変えずに警告を出して止まる（既存のルールを消したり書き換えたりしない）。コピーの直前に状態を読み直し、適用や新しい読み直しの後に届いた古い応答は表示にもコピーにも使わない。停止中・loopback のみのときは不要と表示する。`server_status`（admin 専用）に省略可能な項目 `executablePath`・`platform` を足した（REST は変更なし）。
- 設定 > サーバ・接続のファイアウォールの欄に「Windows ファイアウォールの状態」を追加した（#219 段階 1 の PR-B、Windows のみ・昇格なし・読み取りだけ）。決まった名前のルール（`<identifier>.lan.tcp.program` / `.port`）ごとに「ルール無し」「あり（期待どおり）」「あり（期待と違う: 項目と値）」「確認できない（理由）」を出し、ルールがあることと LAN から接続できることは別だと明記する。新しい Tauri コマンド `firewall_rule_status`（admin 専用・読み取り・REST なし）は、Windows PowerShell に固定のスクリプトを `-EncodedCommand` で渡して読み、同じ `server_status` の snapshot（`generation`）の実行ファイル・待ち受け中のポートと照合する。照合するのは ActiveStore のその名前のルールで、`EnforcementStatus` が `Full` のときだけ「適用されている」とし、ほかの値は「存在するが適用されていない（理由）」、読めない・未知の値は「適用状態は不明」と分ける。出どころは `-TracePolicyStore` で読み、種別（グループポリシー・MDM・Dynamic など）ごとに添え、取れなければ「出どころ不明」とする。ローカルのルールが無い・値が違うときもそれを添える。コマンドが無い・読み込めないときは「ルール無し」ではなく「確認できない」にする。古い応答や、失敗した再確認の前の結果は表示しない。
- 別の端末からの接続確認（LAN の到達確認）の保管所と口を `banto-server` に追加した（#219 段階 1 の PR-C1、UI なし）。新しいモジュール `reach_check`（`ReachCheckState`・`reach_check_router` ほか、公開 API は追加のみ）は、管理者の画面が発行する使い捨てのトークン（`uuid` v4・期限 5 分・1 回限り・同時に 1 つ・定数時間の比較・待受の世代と `Host` に結び付け）を照合し、別の端末から届いたことをメモリにだけ記録する。未認証の口 `POST /api/reach-check` はセッションを発行せず `{ "result": "<コード>" }` だけを返し、接続元はソケットの値だけで判定し（`X-Forwarded-For` は読まない）、このPC自身（loopback・自分のアドレス）は記録も消費もせず、失敗した照合は接続元 IP ごとに回数制限する（1 分 10 回で 429）。発行も到達も監査しない。テンプレートの Tauri 組み込みサーバーにだけ載せる（`banto-serve` には載せない）。発行のコマンドと画面は後続（PR-C2・PR-C3）で、それまでこの口は常に `unusable` を返す。派生アプリへの影響: 追加のみ（既存の API・挙動は変わらない）。
- 到達確認の Tauri コマンドを追加した（#219 段階 1 の PR-C2、画面は後続の PR-C3）。`reach_check_issue({ host })`（admin 専用・desktop-only・REST なし）は、稼働中の listener の loopback 以外の URL の host に対してトークンを発行し、`{ status: "issued", generation, issueId, url, qrSvg, expiresInMs }`（トークンは `url` の `#t=` の後ろだけ）を返す。発行しないとき（停止中・loopback のみ・IPv6 などの bind・候補に無い host・世代の不一致・自分のアドレスを列挙できない）は `{ status: "refused", generation, reason }` のコードを返す。`reach_check_status()`（admin 専用・読み取り）は最後の発行・このPC自身からのアクセス・別の端末からの記録を返す。`server_apply` は世代を進めるとき（成功時も、適用に失敗して元の listener を戻すときも）同じロックの中で保管所の世代も進め、発行済みのトークンと記録を捨てる。発行も到達も監査しない。
- 設定 > サーバ・接続に「別の端末からの接続確認」の欄と、端末側のページ `/reach` を追加した（#219 段階 1 の PR-C3。ファイアウォールの欄とは別の欄で、Windows 以外でも出る）。稼働中の待受の LAN の URL の候補から選んで確認用の URL と QR を発行し、確認待ちの間だけ 2 秒おきに `reach_check_status` を読み直して、未確認・確認待ち（残り時間）・このPC自身・確認済み（時刻・接続元 IP・使った URL と「その時点・その端末」の注記）・古い（1 時間）・期限切れ（届かないとは断定せず、ネットワーク・ファイアウォール・ベンダー製品・AP の端末間の分離を案内）・読めない（「未確認」にしない）を出し分ける。古い応答や別の世代の応答は出さず、待受が変わったら表示を捨てて読み直す。`/reach` は `(app)` の外（認証の guard の外）で、`#t=` のトークンを読んだらすぐ `history.replaceState` で URL から消し、`X-Banto-Client` 付きの `POST /api/reach-check` の結果コードだけを短い文言（en / ja）で出す。ログイン・セッションは作らない。手順と保証すること・しないことは `docs/recipes/lan-access.md`。
- `@banto/theme` に汎用の寸法トークンを追加した（[theme-dimension-tokens.md](docs/design/theme-dimension-tokens.md) の PR-1、追加のみ・後方互換）。余白の段階 `--banto-space-1`〜`-8`、文字サイズの段階 `--banto-font-size-xs`/`sm`/`md`/`lg`/`xl`（本文は root の `1rem` を継承）、枠線幅 `--banto-border-width`（1px）/`--banto-border-width-strong`（2px）。密度では切り替えない。消費側はまだ使っておらず画面は変わらない。conventions §9 に「寸法」の範囲と例外を明記した。
- ファイアウォールの許可を昇格して行う補助プログラムの crate `apps/admin-template/elev`（`admin-template-fw-elev`、bin + lib）を追加した（#219 段階 2 の E1、[ADR-0021](docs/adr/0021-firewall-elevated-helper.md)。まだどこからも起動されず、画面・インストーラは変わらない）。受ける引数は操作名 1 つ（`firewall-allow` / `firewall-remove` / `firewall-status`）だけで、終了コード 0/1/2/3/4/5/64 で結果を返す。identifier はビルド時の定数（`tauri.conf.json` と一致をテストで確かめる）、ルールは本体 exe 単位の 1 本（受信・許可・TCP・ポート指定なし・Private・LocalSubnet）で、同じ名前でも中身が一つでも違えば「競合」として変えない。helper と隣の本体 exe とそこから Program Files（既知のフォルダ）までの各フォルダを、ハンドルを開いてから所有者・書き込み系の ACE・reparse point で検査し、通らなければ何もせず「前提が無い」で止まる（この判定は lib の純関数で、本体の昇格前の検査からも使う）。ファイアウォールの操作は System32 の Windows PowerShell に固定のスクリプトを `-EncodedCommand` で渡し、環境を作り直して行う。`requireAdministrator` のマニフェストは bin にだけ埋め込む。依存は `windows-sys`・`embed-resource` を直接の依存に足した（どちらも `Cargo.lock` に既にある版で、ビルドに入る crate は増えない）。CI の rust ジョブ（ubuntu / windows）の check・clippy・test の対象にこの crate を足した。
- 昇格の起動のモジュールと Tauri のコマンド `firewall_rule_change({ operation: "allow" | "remove", target: { executablePath, generation } })` を追加した（#219 段階 2 の E2、[ADR-0021](docs/adr/0021-firewall-elevated-helper.md)。画面は後続の E3）。admin 専用・desktop-only・REST なし。昇格を求める前に helper の lib と同じ配置の判定（`placement::check_placement`）を本体側でも行い、通らなければ helper を起動せず UAC も出さずに「前提が無い」を返す。確認画面に出した対象（本体 exe のパスとサーバーの generation）を起動の直前と helper の終了後に照合し、起動前に違えば起動せず再確認を求め（`targetChanged`）、終了後に違えば `stale` にする。UAC の待ちの間はロックを持たない。helper は本体 exe の隣の固定名だけを `ShellExecuteExW` の `runas` で起動し（banto-industrial の `launch.rs` を還元）、UAC の取消（1223）・終了コードを結果のコードにし、どの結果でも段階 1 の読み取りで読み直して返す（終了コード 0 は `done` で、「接続できる」とは言わない）。監査の action `firewall_change`（resource `firewall`）を新設し、成功・失敗・UAC の取消を記録する（監査ログの画面の表示名も追加）。`src-tauri` の依存に helper の lib と `windows-sys`（`Cargo.lock` に既にある 0.61.2、起動のモジュール用の feature だけ）を足した。
- 設定 > サーバ・接続の「Windows ファイアウォールの状態」に、段階 2 の「ファイアウォールで許可する」「許可を外す」を追加した（#219 段階 2 の E3、[ADR-0021](docs/adr/0021-firewall-elevated-helper.md)。admin・デスクトップのみ）。ルールが無ければ許可、あれば解除、状態を読めなければ両方を出す。押すと確認画面に決定 1 の 2 文（全 TCP ポートをプライベート ネットワークから許可する／ローカル サブネットは複数のアダプター・VPN のサブネットを含みうる）、対象の実行ファイルとルール名、この後に UAC が出ることを出し、承認で表示していた `expected.executablePath` と `generation` を付けて `firewall_rule_change` を呼ぶ。待っている間はボタンを止めて UAC 待ちと表示し、結果のコードごとの文言（en / ja）と、結果に付いて返る読み直しで状態の表示を更新する。完了でも「接続できる」とは言わず、到達確認へ案内する。前提が無いときは理由と段階 1 のコマンドへ案内する。

### Changed

- **Windows のインストーラの既定を perMachine にし、ファイアウォールの helper を同梱した**（#219 段階 2 の E4、[ADR-0021](docs/adr/0021-firewall-elevated-helper.md) 決定 2・3・7・8）。`tauri.conf.json` の `bundle.windows.nsis.installMode` を `"perMachine"` にしたので、インストール先が Program Files に変わり、インストール時に UAC が出る（データは `%APPDATA%\<identifier>\` のまま）。インストーラは `pnpm --filter admin-template tauri:build:windows`（`tauri build --config src-tauri/tauri.fw-elev.conf.json`）で作る: その `beforeBuildCommand` が `scripts/build-fw-elev.mjs` で helper を先にビルドし、Tauri の `externalBin` として本体 exe の隣に `admin-template-fw-elev.exe` の固定名で置く（素の `tauri build`・`tauri dev`・`cargo check` は helper を要求しない）。この設定は `bundle.targets` を `["nsis"]` に絞る: ルールを外すアンインストールのフックは NSIS にしか無く、MSI ではアンインストール後もルールが残るので、段階 2 では MSI に対応しない。NSIS の PREUNINSTALL のフック（`src-tauri/windows/fw-elev-hooks.nsh`）が所有するルールだけを外し（フックは先に Tauri の「アプリが動いていれば閉じる」確認を行うので、そこで取り消してもルールは残る。起動するのはインストール先の helper ではなく、ビルド時にアンインストーラへ埋め込んで `$PLUGINSDIR` に展開した写しで、helper に足した `firewall-remove-installed <インストール先>` で Program Files の下の本体 exe の自分のルールだけを外す。インストール先の helper の exe だけが一般利用者に書き換えられる場合に、それを管理者として動かさないため）、外せなくてもアンインストールは止めずにルール名（`<identifier>.lan.tcp.program`）と手で外す方法を表示する（インストール時にはルールを作らない。Tauri の更新ではルールを残す）。`scripts/rename.mjs` が helper の `IDENTIFIER` を `--identifier` に追随させるようにした。CI: tauri-check（Windows）で helper を externalBin の場所へ置いてその設定で `cargo check`、template-acceptance でリネーム後の helper のテストを回す。**派生アプリへの影響**: 既存の per-user のインストールからの移り方、portable・per-user では段階 2 が使えず段階 1 の案内になることは [docs/upgrading.md §4.1](docs/upgrading.md#41-windows-のインストール形態が-permachine-に変わる219-段階-2)。
- 設定 > サーバ・接続の「Windows ファイアウォールの状態」で、ルールの中身が一致して適用状態（`EnforcementStatus`）だけが `Full` でないとき（例: 他社ファイアウォールが有効で `CategoryOff`）、「違う項目」ではなく「あり（内容は期待どおり。ただし Windows ファイアウォールとしては適用されていません）」の見出しを出すようにした（#481、#479）。`CategoryOff` のときは接続確認へ案内する。見出しは警告の色にした（#484）。
- Program Files の外のコピー（per-user・ポータブル・移動したコピー）で「ファイアウォールで許可する」を押したとき、拒否の理由を「補助プログラムが無い」ではなく「Program Files の下にない」にした（#482、#480）。UAC を出さずに止める判断は変わらない。

### Fixed

- **配布用の Windows ビルド（`pnpm --filter admin-template tauri:build:windows`）に LAN 向けの Web UI が入らなかったのを直した**（#478）。`--features embed-ui` を付けたので、別端末が `http://<PC>:<port>/` を開くと実際の画面が出る。`server_status` に `uiEmbedded`（必須）を足し、UI が埋め込まれていないビルド（素の `tauri build`・`tauri dev`）では設定画面が URL・QR・「別の端末からの接続確認」を出さず、確認できない旨だけを出す。
- 内蔵サーバー（LAN アクセス）の `server_status` が、保存した設定と稼働中のサーバーの値を混ぜて返し得たのを直した（#459、#219 の監査）。汎用の `settings_set` は `server.` で始まるキーを拒否し（書き込みは `server_apply` だけ）、status は保存値（`enabled`・`bind`・`port`・`viewerPublic`、フォームの初期値）と、実際の listener の値（`live` の bind・port、`urls`・`qrSvgs`）を同じロックの中で読んだ 1 つの snapshot として返す。新しい省略可能な項目 `generation`（適用のたびに変わる）・`applyFailure`（ポート使用中・bind の失敗・保存の失敗と、元のサーバーを戻せたか）を足した。`server_apply` の失敗時は、保存値ではなく稼働していた listener のアドレスとポートで戻す。`banto-server` に、ポート使用中をほかの失敗と分けて返す `bind_without_fallback` を追加（追加のみ）。

## [6.8.0] - 2026-10-21

**v6.8.0 — サイドバーの代わりに選べるドック（ランチャー）、temp-scada からの共有部品の還元、シェルと設定の UI の見直し。** 版の種類: minor（機能追加。後方互換。公開 API の削除・改名なし）。
中身は 3 つ: (1) ドック（ランチャー。画面の上下左右に置ける。#421〜#431・#456）、(2) 共有部品の還元（#432〜#438 の計画。`@banto/admin-core` の `createRequestOwner`・`createSavedSetting`、`@banto/dock-svelte` の表示用の補正・`capabilities`・pane の lifecycle・キーボード操作と hook、`@banto/forms` の `FormDraft` / `DraftCoordinator`、`@banto/ui` のショートカットの dispatcher・操作の持ち主の整理、新しいオプションのパッケージ `@banto/image-assets`。#439〜#454）、(3) シェルと設定の UI の変更（設定のカテゴリを内容の上へ #455、サイドバーの折りたたみボタンをロゴの左へ #457、配色モードの切替をヘッダーへ #458）と、内蔵サーバーの起動時のポートの自動選択（#460）。
派生アプリへの影響: タグを上げるだけで動く。ただし `@banto/dock-svelte` の挙動の変化（下の「消費側への注意」）を確かめる。新しい部品・ドック・UI の変更は、使うとき・写すときだけ取り込む（取り込みの組み立ては [docs/upgrading.md](docs/upgrading.md) の例 5）。

| 経路                             | 影響         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 依存（`@banto/*`・`banto-*`） | あり（確認） | `v6.7.2` → `v6.8.0`（npm と Rust を同じタグに）。追加のみ: `@banto/ui` の `LauncherBar`・`magnifyScale`・`CommandSpec`・`createShortcutDispatcher` など（#423・#426・#456・#444）、`@banto/theme` の `--banto-shell-launcher-*`・`--banto-z-launcher` などのトークン、`@banto/admin-core` の `createRequestOwner`・`createSavedSetting`（#441・#442）、`@banto/forms` の `createFormDraft`・`createDraftCoordinator`・`DraftNumberField`（#447）、`@banto/dock-svelte` の `clamp`・`capabilities`・`beforePanelChange`・`keepMounted`・キーボード操作（#443・#446・#448）、`banto-server` の `bind_with_port_fallback`・`PortFallbackError`・`PORT_FALLBACK_SPAN`（#460）。新しいオプションのパッケージ `@banto/image-assets`（#451〜#453。使うアプリだけ依存に足し、`optimizeDeps.exclude` に加える）。**`@banto/dock-svelte` は挙動が変わる箇所がある**（復元 layout の検証と `hydrate` の戻り値 #440、操作の確定 / 取消 #445、IME 変換中の構造変更の保留 #448） |
| B. コピーしたテンプレート        | あり（任意） | 取り込まなくても動く。写すなら: ドック（`ShellLauncher.svelte`・設定ストアの `shell.navLayout` / `shell.launcherOpacity` / `shell.launcherPosition`・外観設定の「ナビゲーション」カード・`(app)/+layout.svelte` と Header。#424・#426・#456）、ダッシュボードのメモ pane の draft 化（#449）、Ctrl+K / Ctrl+S の shortcut dispatcher への配線（`#lib/shortcuts.ts`、#450）、設定のカテゴリの横並び（#455）、ロゴの左の折りたたみボタン（#457）、ヘッダーの配色の切替と外観設定の配色カードの撤去（#458）、起動時のポートの自動選択（`src-tauri/src/lib.rs`・`serverPortNotice.ts`、#460）。それぞれ文言キーの追加・削除を伴う                                                                                                                                                                                                                                                                                                                                      |
| C. DB・設定・配布資産            | なし         | DB のマイグレーションは無い。ユーザーごとの設定キー（`shell.*`・`dashboard.memo`）の追加のみで、未保存のユーザーは既定（サイドバー・静的なメモ）。#460 を取り込んだアプリは、保存したポートが使用中のとき起動時に選んだポートを `server.port` に保存する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 消費側への注意

- 既定のナビゲーションは `NAV_LAYOUT_DEFAULT = 'sidebar'` のままで、ドックを選ばなければ見た目は変わらない。ドックを取り込む派生アプリは `@banto/ui`・`@banto/theme` を v6.8.0 にそろえること（`LauncherBar` とトークンが無いと動かない）。
- **`@banto/dock-svelte` の復元 layout の検証**（#440）: `DockState` の `hydrate` と constructor の初期値が、不正な layout（重複 ID・`x=1e999`・`width=-1`・`height=0` など）を拒否して現行 layout を変えない（constructor は空の layout で始める）。従来は通っていた壊れた保存データが読めなくなる（正常な v1 / v2 は従来どおり）。`hydrate` の戻り値が `void` → `boolean`（採用されたか）。戻り値を使わない呼び出しはそのまま動く。
- **`@banto/dock-svelte` の操作の確定と取消**（#445）: ドラッグは、操作を始めた pointer の `pointerup` でだけ確定する。resize・divider も Esc・`pointercancel`・`lostpointercapture`・window の `blur` などで取り消される（取消は対象の window / split だけを戻す）。これらのイベントに依存した独自の操作やテストは見直す。
- **`@banto/dock-svelte` の IME 変換中の構造変更の保留**（#448）: props を渡さなくても、`DockHost` は IME 変換中にドラッグを始めず、dock / undock / タブの切り替えなどの構造変更を `compositionend` まで保留する（見た目は変わらない）。
- `@banto/image-assets` は `.svelte.ts` を含むので、使うアプリは `vite.config.ts` の `optimizeDeps.exclude` に加える（足さないと dev が 500 になる。`pnpm build` / `pnpm check` では気づけない）。
- テンプレートを写すアプリ向け: 配色モード（ライト / ダーク / システム）のカードを外観設定から外し、ヘッダーの太陽 / 月のボタンにした（#458。保存値の形は変えない。文言キー `settings.modeLight` / `modeDark` / `modeSystem` を消し、`shell.switchToDarkMode` / `shell.switchToLightMode` を足した）。設定のカテゴリの切替は内容の上の横並びに、サイドバーの折りたたみボタンはロゴの左に移った（#455・#457）。visual の基準画像を持つ派生アプリは再生成が要る。
- テンプレートを写すアプリ向け: 内蔵サーバーを起動時に自動で始めるとき、保存したポートが使用中なら +1〜+19 の範囲の空きポートで起動し、そのポートを `server.port` に保存して管理者にトーストで知らせる（監査は `settings_change`、`detail.reason: "portInUse"`）（#460）。固定のポートを前提にした運用（ファイアウォールの許可・ブックマーク）は見直す。設定画面の「保存して適用」は従来どおり自動で選ばない。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: 今回はタグを打つ前の main の SHA での `workflow_dispatch` はしていない。代わりにリリース PR の head の `pull_request` の run と、タグの push の run で `external-consumer.yml` を確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - リリース PR の head（`release/v6.8.0` の `35134f5`、`pull_request`）: [run 39587964047](https://github.com/tyaro/banto/actions/runs/39587964047)（success）。
  - タグの push（`v6.8.0`、main の `85cb860`）: [run 39588604443](https://github.com/tyaro/banto/actions/runs/39588604443)（success）。
  - 2 つの run の版は、Node.js 以外は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）。Node.js は run とジョブで違う（`node-version: 24` で最新の 24.x を引くため）: リリース PR の run は 2 ジョブとも 24.21.0、タグの push の run は npm のジョブが 24.21.0、diagnostic のジョブが 24.22.0。

    | 項目               | 版                                        |
    | ------------------ | ----------------------------------------- |
    | Node.js            | 24.21.0（タグの diagnostic のみ 24.22.0） |
    | pnpm               | 10.33.0                                   |
    | Svelte             | 5.57.2                                    |
    | SvelteKit          | 3.1.0                                     |
    | Vite               | 8.3.4                                     |
    | vite-plugin-svelte | 7.3.1                                     |
    | TypeScript         | 6.0.3                                     |
    | Rust               | 1.99.1（58cf8f9c3 2026-10-13）            |

  - 出所: Node.js は `node: v24.21.0`・`node: v24.22.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.2` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.1`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### Added

- `@banto/ui` にドック風のランチャー `LauncherBar`（グループごとの `<nav>`・近いアイコンほど大きくなる拡大・Esc で閉じるツールチップ・900px 以下のタブバー）と `magnifyScale` / `LauncherItem` などの型を追加し、`@banto/theme` に `--banto-shell-launcher-*`・`--banto-z-launcher` のトークンを追加した（シェルへの配線は次の PR。nav-launcher-plan.md PR-2、ADR-0018 §11）（#423）。
- 設定の「外観」に「ナビゲーション」カードを追加し、サイドバーの代わりに画面下のドック（`LauncherBar` を配線した `ShellLauncher`）を選べるようにした。ユーザーごとに保存し（`shell.navLayout` / `shell.launcherOpacity`、未保存のユーザーは既定のサイドバー）、ドックの不透明度をスライダー（40〜100%）とプレビューで調整できる。既定は `NAV_LAYOUT_DEFAULT = 'sidebar'`。ドック表示中はトーストをバーの上に上げる（`@banto/theme` に `--banto-shell-launcher-tabbar-reserve` を追加）（nav-launcher-plan.md PR-3）（#424）。
- ドックを画面の左右にも置けるようにした（`LauncherBar` の `position` に `'left' | 'right'`、設定の「ドックの位置」下 / 左 / 右、`shell.launcherPosition`。900px 以下はどの位置でも下端のタブバー。`@banto/theme` に `--banto-shell-launcher-tooltip-max-width` を追加）。あわせて、ダッシュボードの浮き窓（`role="dialog"`）が出ているとツールチップが Esc で閉じなかったのを直した（nav-launcher-plan.md PR-4）（#426）。
- ドックを画面の上にも置けるようにした（`LauncherBar` の `position` に `'top'`、設定の「ドックの位置」上 / 下 / 左 / 右、保存値 `shell.launcherPosition` は既存の `bottom` / `left` / `right` もそのまま読める）。上のバーはヘッダーの下に出し（`@banto/theme` に `--banto-shell-launcher-inset-top` を追加し、シェルがヘッダーの高さを入れる）、拡大とツールチップは下向き。900px 以下はほかの位置と同じく下端のタブバー（nav-launcher-plan.md PR-6）（#456）。
- 900px 以下のドック（タブバー）は、透け具合の設定にかかわらず不透明度 85% を下限にし、ラベルを読みやすくした（`--banto-shell-launcher-tabbar-opacity-min`、#428）。
- ドックの設計と段取りを `docs/design/nav-launcher-plan.md` にまとめた（#421）。
- `@banto/admin-core` に、古い非同期結果を捨てて一時資源を一度だけ解放する `createRequestOwner`（`begin` / `invalidate` / `dispose` / `busy`、要求ごとの `signal`・`isCurrent`・`hold`・`adopt`・`finish`）と、他パッケージが同じ契約を流すための契約の表（`tests/contracts/request-owner.json`）を追加した。`ListResource` の要求番号をこれに置き換えた（挙動の変更なし。shared-primitives-upstream-plan PR-3、#436）（#441）。
- `@banto/dock-svelte` に、host の縮小でも浮動 window を操作できるようにする表示用の補正と、consumer が渡す方針を追加した（#434、計画書 PR-2）。`DockHost` に `clamp`（最小寸法・`minVisible`・狭い host での `narrowHost: 'overflow' | 'fit'`）と `capabilities`（pane ごとの `close` / `move` / `undock`）を追加し、純関数 `displayWindowGeometry` と型 `DockCapabilities` を export。host の寸法が変わっても保存した希望の x / y / width / height は書き換えない（描くときだけ補正。move / resize は描いている位置から始まり、結果が新しい希望になる）。`DockState.move` / `resize` に任意の `clamp` 引数、README に書き込み失敗時の約束（保存済み snapshot を更新しない）を追記した（#443）。
- `@banto/admin-core` に、UI 設定の現在値と保存に成功した snapshot を分ける `createSavedSetting`（`current` / `saved` / `saving` / `error` / `dirty`、明示保存と即時保存、保存は直列・合流、失敗しても編集中の値と前の保存値を保つ、破損・未知の version は `parse` / `fallback` へ委譲）を追加した。既存の `UiSettingsProvider` の上に乗る helper で、既存の画面は変えない（shared-primitives-upstream-plan PR-6、#437）（#442）。
- `@banto/ui` に操作の定義 `CommandSpec` とショートカットの保護・dispatcher（`shouldHandleShortcut` / `createShortcutDispatcher`、IME 変換中・`defaultPrevented`・`repeat`・入力欄・モーダルな層とメニューでは受けない、`ownerLayer`・実行直前の `enabled` の再確認・`preventDefaultWhenDisabled`）、キーの `parseShortcut` / `matchShortcut` / `formatShortcut`（`Mod` = Ctrl / macOS は Meta）と、`aria-modal="true"` の層だけを見る `hasVisibleModalLayer`（非モーダルの浮動 window では止めない）を追加した。`@banto/admin-core` の `PaletteCommand` に任意の `enabled` / `checked` / `shortcut` を足した（アプリへの配線は PR-11。shared-primitives-upstream-plan PR-7、#435）（#444）。
- `@banto/dock-svelte` にキーボード操作と操作の hook を追加した（#433、計画書 PR-5）。divider は WAI-ARIA の Window Splitter（フォーカスでき、矢印・Shift・Home / End で動かし、`aria-valuenow` などを持つ）、タブは矢印・Home / End で選ぶ（roving tabindex）、浮動 window はタイトルバーのボタンで移動 / サイズ変更のモードに入り、矢印・Shift で動かして Enter で確定、Esc で取消。`DockHost` に `canStartGesture` / `onGestureEnd` / `isEscapeBlocked(activeLayer)` の props と型 `DockGestureKind` / `DockCancelReason`、`messages` に `moveWindow` / `resizeWindow` を足した。ダッシュボードは `isEscapeBlocked` に `@banto/ui` の層の判定をつなぎ、浮動 window を開いたままの divider の操作も Esc で戻る（#446）。
- `@banto/forms` に、pane より長生きする未適用入力 `createFormDraft`（生の入力文字列・確定・適用を始めた時点の snapshot を成功後だけ baseline にする `snapshotForApply` / `markApplied`）と、複数フォームを 1 回の確認で適用 / 破棄 / キャンセルする `createDraftCoordinator`（`register` / `capture` と再登録での `restore`、`settle` の `'applied'` / `'discarded'` / `'dirty-again'` / `'stale'` など、`guardUnsavedChanges` の登録簿への接続）、`draftSourceFrom`、生の文字列を残す `DraftNumberField` を追加した。適用中に対象が変わった結果は admin-core と同じ契約の内部実装で捨て、`request-owner.json` の表を forms のテストでも流す。既存の `FormStore`・`guardUnsavedChanges`・`NumberField` は変えない（shared-primitives-upstream-plan PR-8、#432）（#447）。
- `@banto/dock-svelte` に pane の lifecycle を追加した（#432、計画書 PR-9）。`DockHost` の `beforePanelChange(change)`（dock / undock / move-docked / tab-switch / hide / close の前に聞き、`true` のときだけ変える。非同期の答えは、待つあいだに layout の構造が一度でも変わったら（`DockState.structureRevision` の世代で見るので、同じ形に戻っても）・`keepMounted` が変わって変更の中身が変わったら・IME 変換中に返ったら変換が終わるまで持ち、unmount したら答え待ちの要求もすぐに `disposed` を返す。同じ要求の重複除去は変更と行き先（ドロップ先）が同じときだけ）、`keepMounted(panelId)`（表示していないタブ・hide した浮動 window の中身を `hidden` + `inert` で同じ DOM のまま残す）、`isStructureChangeDeferred()`（省略時は IME 変換中。変換中はドラッグを始めず、構造変更を `compositionend` まで保留する）と、`hidePanel` / `closePanel` / `resumeDeferredChange`、型 `DockPanelChange` / `DockPanelChangeOutcome` と `structureKey`・`DockState.structureRevision`。`keepMounted` の pane では ✕ が hide（中身を保つ）になり、中身を捨てるのは `closePanel`（D4-a）。props を渡さないアプリで変わるのは、IME 変換中のドラッグと構造変更の保留だけ（見た目は変わらない。アプリへの配線は PR-10）（#448）。
- テンプレートのダッシュボードのメモ pane を、未適用の入力を持てる入力欄にした（#432、計画書 PR-10）。draft と `DraftCoordinator` はページが持ち、dock / undock / タブの切替では入力と未保存の状態が残る。✕・ツールバーでの close と pop-out は「保存して閉じる / 破棄して閉じる / キャンセル」を聞き（`@banto/ui` の `Modal`）、保存の待機中に入力があれば閉じずに残す。保存先は UI 設定（`dashboard.memo`、REST / Tauri / デモの各 provider）。未保存のままの画面離脱は既存の確認を出す。コピーして使っている派生アプリ（経路 B）は `dashboard/+page.svelte` と新しいファイル（`#lib/banto/dashboardMemo.svelte.ts`・`settlePrompt.svelte.ts`、`DashboardMemoField.svelte`・`DraftSettleDialog.svelte`）、文言キー `dashboard.memo*` を取り込めば同じ配線になる（取り込まなければ従来どおり静的なメモ）（#449）。
- テンプレートのキー操作を `@banto/ui` の shortcut dispatcher につないだ（#435、計画書 PR-11）。Ctrl+K / Cmd+K は `#lib/shortcuts.ts` の command になり、パレットを開いたまま検索欄で閉じられるのは同じで、ほかの Modal・Drawer・メニューが出ている間と IME 変換中は開かない。ダッシュボードのメモは Ctrl+S / Cmd+S で保存する（入力欄の中でも。保存ボタンと同じ command・同じ直列の保存で、保存するものが無いときもブラウザの「ページを保存」は出さない。ほかのページの Ctrl+S はブラウザのまま）。ヘッダーの検索ピルの鍵帽は OS に合わせて `Ctrl+K` / `⌘K` と出す。コピーして使っている派生アプリ（経路 B）は `#lib/shortcuts.ts`（新規）・`(app)/+layout.svelte`・`Header.svelte`・`dashboard/+page.svelte`・`dashboardMemo.svelte.ts`・`DashboardMemoField.svelte` と文言キー `common.withShortcut` を取り込めば同じ配線になる（#450）。
- 新しいオプションのパッケージ `@banto/image-assets`（`packages/image-assets`）の骨格を追加した（#438、計画書 PR-12、[ADR-0020](docs/adr/0020-image-assets-package.md)）。ブラウザ側の画像の原本・取込検査・object URL の寿命のための部品で、この PR では形式（`IMAGE_FORMATS`）、consumer が必ず渡す上限の型と検証（`ImageImportLimits`・`validateImageImportLimits`。既定値は持たない）、文言を持たないエラーコード（`ImageAssetError` の `code` と `detail`）だけを公開する。依存は空で、テンプレートのアプリには配線しない（scaffold は触れない。template-scope §3 の行と削除手順を足した）。取込の検査と hash は PR-13、原本と URL の寿命は PR-14（#451）。
- `@banto/image-assets` に取込の検査と hash を追加した（#438、計画書 PR-13）。`inspectImageHeader`（decode 前に bytes から PNG / JPEG の形式・寸法・画素数を読み、consumer の上限と照らす。壊れた・切り詰めた入力も `ImageAssetError` で返す）、`verifyDecodedImage`（ブラウザで decode して寸法がヘッダと一致するか確かめる。decoder は注入でき、既定は `createImageBitmap`）、両方と hash を順に通す `inspectImage`、`sha256Hex`（`crypto.subtle` が無い平文 HTTP では自前の SHA-256 に落ち、同じ値。D11）。プログレッシブと CMYK の JPEG は受け入れ、APNG・ロスレス / 算術符号化の JPEG は `unsupported-format`（#452）。
- `@banto/image-assets` に原本の store を追加した（#438、計画書 PR-14）。`createImageStore({ maxTotalBytes })`（総容量は必須、超えると `store-full`）が `add()` で取込の検査を通した原本を不変の `Blob` として保持し、SHA-256 で重複排除する。object URL は原本ごとに共有して最後の `release()` で revoke し（`acquireUrl`）、`pin` / `collect` / `delete` / `dispose` は pin 中・URL 貸出中の原本を消さない（dispose 後は最後の解除で消える）。処理中の add は admin-core の `createRequestOwner` と同じ契約の内部の写しが持ち（同じ `key` の新しい add・`cancel`・`dispose` で失効し、`null` を返す）、admin-core の契約の表を自分のテストで流す。エラーコードに `unknown-asset`・`store-disposed` を足した。`.svelte.ts` を持つようになったので、使うアプリは `optimizeDeps.exclude` に足す（外部利用 fixture には足した）（#453）。
- 配色モード（ライト / ダーク）の切替をヘッダーの太陽 / 月のアイコンボタンへ移した。表示中の配色の反対を示し、押すと反対の配色に固定する（初期は OS に従う。保存値の形は変えない）。設定画面（外観・言語）のテーマのカードから配色モードの 3 枚を外し、プリセットと表示密度を残した。不要になった `settings.modeLight` / `modeDark` / `modeSystem` を消し、`shell.switchToDarkMode` / `shell.switchToLightMode` を足した。visual の基準画像の再生成が要る（Linux で `visual-baselines.yml` を dispatch）（#458）。
- 内蔵サーバー（LAN アクセス）を起動時に自動で始めるとき、保存したポートが使用中なら、すぐ後ろの決まった範囲（+1〜+19、65535 まで）から空いているポートを選んで起動し、そのポートを `server.port` に保存して管理者にトーストで知らせるようにした（監査は操作者なしの `settings_change`、`detail.reason: "portInUse"`）。`banto-server` に `bind_with_port_fallback`・`PortFallbackError`・`PORT_FALLBACK_SPAN` を追加し、`server_status` の応答に `portNotice` を足した。設定画面の「保存して適用」は従来どおり自動で選ばない（#460）。
- docs: 共有部品の還元（#432〜#438）の完了を文書に反映した（計画書 PR-15）。`docs/upgrading.md` に例 5（派生アプリの取り込み手順。破壊的変更は無いが、dock の復元 layout の検証とドラッグの確定に挙動の変化がある点、`@banto/image-assets` の `optimizeDeps.exclude`）、レシピ `docs/recipes/image-assets.md`（画像の取り込みと表示）を足し、計画書の状態行・§5.1 を「実装完了（v6.8.0 のリリース待ち）」に更新した。コードの変更なし（#454）。

### Changed

- 設定画面のカテゴリ切り替えを、広い画面でも左の縦レールではなく内容の上の横並び（ピル型）にした。サイドバーと合わせて内容の幅が狭くなるのを避ける（visual の基準画像の再生成が要る）（#455）。
- サイドバーの折りたたみボタンを、ヘッダー左端からサイドバー最上段のロゴの左へ移した（900px 超）。最上段は `[ボタン][ロゴ] Banto` で、折りたたむとボタンだけが同じ位置に残り（ロゴは隠れる）、同じ場所をもう一度押せば戻る。900px 以下はこれまでどおりヘッダーのボタンでドロワーを開閉し、ドックのレイアウトでは出さない。visual の基準画像（サイドバー・ヘッダーを含むもの）は再生成が要る（#457）。
- サイドバーの折りたたみボタンを、サイドバー下端からヘッダーの左端へ移した。900px 以下のハンバーガーと 1 つのボタンに統合し（900px 超は折りたたみ、以下はドロワーの開閉）、`aria-expanded` / `aria-controls` を付けた。`IconButton` に `expanded` / `controls` を追加（#431）。
- サイドバーの表示項目の絞り込み（RBAC・閲覧公開の許可リスト）を `navSections()` に切り出し（挙動の変更なし、nav-launcher-plan PR-1）（#422）

### Fixed

- `@banto/dock-svelte` の復元 layout を検証するようにした（#434、計画書 PR-1）。`DockState` の `hydrate`（JSON）と constructor の初期値（文字列・オブジェクト）が、version・構造・panel / node ID の一意性・有限の座標・正の寸法・split の `sizes`・tabs の `activeIndex` を全体として検証し、不正（`x=1e999`・`width=-1`・`height=0`・重複 ID など）なら拒否して現行 layout を変えない（constructor は空の layout で始める）。`hydrate` の戻り値を `void` → `boolean`（採用されたか）にし、検証の純関数 `validateDockLayout` と型を追加。**挙動の変化**: 従来は通っていた不正な layout が拒否される。正常な v1 / v2 は従来どおり読める。host 縮小時の到達性・能力指定は PR-2。（#440）
- `@banto/dock-svelte` のドラッグ・resize・divider・開始閾値の追跡を 1 つの操作の持ち主にまとめた（#433、計画書 PR-4）。**挙動の変化**: 操作を始めた pointer の `pointerup` でだけ確定し、別の pointer の `pointerup` ではドラッグが確定しなくなった。resize・divider も Esc（ほかの層が `preventDefault` 済みなら譲り、受けたら `preventDefault`）・`pointercancel`・`lostpointercapture`・window の `blur`・タブが隠れたとき・`DockHost` の unmount で取り消され（resize は対象の window の位置と寸法、divider は対象の split の比率だけを戻し、操作中のアプリの変更は残す）、listener が残らない。確定の直前に host の寸法を測り直す。浮動 window は `focusin` でも前面に来て、前面化は `z-index` で行い DOM（Tab）の順を変えない。公開 API の変更なし（keyboard 操作と hook は PR-5）（#445）。
- scaffold の dock の除去（`removeDock`）が、#446 で足した `#lib/banto/dockEscape.ts` とそのテスト・ダッシュボードの import を外していなかったのを直した（dock を外すプリセットで、使われない import と呼び出し元の無いファイルが残っていた）（#450）。
- 閲覧公開（LAN）セッションの Ctrl+K コマンドパレットが、開けない画面（許可リスト外）まで一覧に出していたのを直した。ナビゲーションのコマンドもサイドバー・ドックと同じ `navSections()` で絞る（ADR-0012）（#425）。
- `@banto/ui` の `Menu` で、項目がトリガーの上下の可用高を超えると下端が画面外に残り届かなかったのを直した。広い側の可用高（余白・枠線込み）に高さを抑えて中をスクロールし（`overscroll-behavior: contain`）、メニュー自身のスクロールでは閉じない（外側のスクロールでは従来どおり閉じる）。あわせて、開いた瞬間は項目がまだ不可視のためフォーカスが項目へ移らず、ブラウザでは開いた後の ↑↓・Home・End が効かなかったのを直した（#427、#430）。

## [6.7.2] - 2026-10-20

**v6.7.2 — 保守のみのリリース（CI の高速化、テストの安定化、内部の整理）。** 版の種類: patch（挙動の変更なし。公開 API の変更なし。後方互換）。
派生アプリへの影響: タグを上げるだけ。

| 経路                             | 影響         | 内容                                                                                                                                                                                                                                       |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 依存（`@banto/*`・`banto-*`） | なし         | `v6.7.1` → `v6.7.2`（npm と Rust を同じタグに）。公開 API は変わらない。banto-server の `auth` はモジュールに分けたが `banto_server::auth::…` の名前はそのまま                                                                             |
| B. コピーしたテンプレート        | あり（任意） | `apps/admin-template/src/lib/banto/` の `attachmentsAdmin.ts`・`backupsAdmin.ts`・`itemsAdmin.ts`・`systemAdmin.ts` の内部の fetch ラッパを `httpRequest(path, init: HttpInit)` にそろえた。送る要求は同じで、取り込まなくても動く（#414） |
| C. DB・設定・配布資産            | なし         | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                    |

### 消費側への注意

- 公開 API・挙動の変更は無い（保守のみ）。タグを上げるだけで済む。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `ea6a602`、`workflow_dispatch`）: [run 39377708546](https://github.com/tyaro/banto/actions/runs/39377708546)（success）。
  - タグの push（`v6.7.2`）: [run 39377903663](https://github.com/tyaro/banto/actions/runs/39377903663)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.22.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.2                         |
    | SvelteKit          | 3.1.0                          |
    | Vite               | 8.3.4                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.1（58cf8f9c3 2026-10-13） |

  - 出所: Node.js は `node: v24.22.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.2` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.1`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- CI の E2E のうち visual + axe-core を別ジョブ `E2E (visual + axe-core)` に分け、`BANTO_E2E_SERVERS=visual` で `vite preview` だけを起動できるようにして E2E を速くした（#410）。CI のみの変更で、公開 API と手元の `pnpm e2e*` の挙動は変わらない。
- 監査の保留ファイルのテスト 2 件が、Windows CI で `sync_all` を含む経過時間の上限で不安定に落ちるのを直した（#399、#401）。公開 API の変更は無い。
- CI の Rust のビルドを速くするため、ワークフロー（`ci.yml`・`tauri-check.yml`）でデバッグ情報を行番号だけにした（`CARGO_PROFILE_DEV_DEBUG=line-tables-only`、#408）。CI のみの変更で、公開 API の変更は無い。
- CI と手元の `cargo test` を速くするため、dev/test プロファイルで依存の argon2・blake2 だけを opt-level 3 でビルドするようにした（`rest::tests` が Windows CI で 79 秒だったのが数秒に。#409）。公開 API の変更は無い（release と利用アプリには影響しない）。
- `banto-server` の `auth.rs` をモジュールに分けた（#415）。コードの移動のみで、`banto_server::auth::…` の名前と挙動は変わらない。
- `apps/admin-template/src/lib/banto/` の `attachmentsAdmin.ts`・`backupsAdmin.ts`・`itemsAdmin.ts`・`systemAdmin.ts` の内部の fetch ラッパを `httpRequest(path, init: HttpInit)` にそろえた（#414）。送る要求は同じで、公開 API の変更は無い。
- eslint を `--max-warnings=0` で走らせるようにした（#413）。警告も CI を落とす。
- scaffold-acceptance-paths の検査（rule 14）を足し、template-acceptance の `paths` を追加した（#417）。
- conventions と ADR-0008 に追記した（#412）。
- Windows で不安定だった監査のテストを直した（#416）。
- 保守レビューの記録を追加・更新した（#411・#418）。
- npm の devDependencies を更新した（#405・#407、dependabot。fixture の範囲を揃えた）。
- `Cargo.lock` を更新した（#403）。
- CI の action を更新した（#402）。

## [6.7.1] - 2026-10-15

**v6.7.1 — `isTauri()` が `location.origin` も見るようにし、サービスへ navigate した Tauri の窓を server 経路にした（#396）。版の種類: patch（修正のみ。公開 API の変更は無い。後方互換）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B は `environment.ts` を写している場合に取り込むと直る（任意）。経路 C は変更なし。**

| 経路                             | 影響         | 内容                                                                                                                                                                                                     |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | なし         | `v6.7.0` → `v6.7.1`（npm と Rust を同じタグに）。タグを上げるだけで、`optimizeDeps.exclude` の変更は不要。`isTauri()` は `admin-template` のコードで `@banto/*` には無いため、依存の差し替えでは直らない |
| B. コピーしたテンプレート        | あり（任意） | `environment.ts` の `isTauri()` に origin の判定を取り込むと直る（下の注意）。取り込まなければ従来どおり                                                                                                 |
| C. DB・設定・配布資産            | なし         | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                  |

### 消費側への注意

- 公開 API は変わらない（修正のみ）。`isTauri()` は、Tauri 自身の origin（`http://tauri.localhost`・`https://tauri.localhost`・`tauri://localhost`、開発ビルドのみ `tauri.conf.json` の `build.devUrl` の origin）でないときは false を返すようになった。シェルが WebView をローカルのサービス（`http://127.0.0.1:<port>/`）へ navigate する構成では、その窓が server 経路を使う。
- `environment.ts` を写して使っている派生（経路 B）は、純関数 `isTauriOrigin(origin, devOrigin?)` と `TAURI_ORIGINS`・`TAURI_DEV_ORIGIN` を取り込むことを推奨する。シェルが自前のサービスへ navigate しない派生は、取り込んでも挙動は変わらない。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `a3a1d37`、`workflow_dispatch`）: [run 38610452739](https://github.com/tyaro/banto/actions/runs/38610452739)（success）。
  - タグの push（`v6.7.1`）: [run 38610678688](https://github.com/tyaro/banto/actions/runs/38610678688)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.2                         |
    | SvelteKit          | 3.0.1                          |
    | Vite               | 8.3.4                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.2` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 修正

- `isTauri()`（`apps/admin-template/src/lib/banto/environment.ts`）が `__TAURI_INTERNALS__` の有無だけでなく `location.origin` も見るようにした
  （#396）。Tauri のシェルが WebView をローカルのサービス（`http://127.0.0.1:<port>/`）へ navigate すると、Tauri はその窓にも
  `__TAURI_INTERNALS__` を注入するため、以前は invoke の経路を選んで壊れていた。Tauri 自身の origin（`http://tauri.localhost`・
  `https://tauri.localhost`・`tauri://localhost`、開発ビルドのみ `tauri.conf.json` の `build.devUrl` の origin）のときだけ true になる。
  純関数 `isTauriOrigin(origin, devOrigin?)` と定数 `TAURI_ORIGINS`・`TAURI_DEV_ORIGIN` を足した。
  派生アプリへの影響: `environment.ts` を写している経路 B・C の派生は同じ直しを取り込む。シェルが自前のサービスへ navigate しない派生は挙動が変わらない。

## [6.7.0] - 2026-10-11

**v6.7.0 — `@banto/ui` に `Modal`・`Drawer` と、Esc・フォーカスの層の補助（`layering.ts`）を足した（ADR-0018 段階 4）。`CommandPalette` も同じ補助を使う。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                 |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.6.0` → `v6.7.0`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。`Modal`・`Drawer`・層の補助を使わなければ挙動は変わらない（`CommandPalette` の振る舞いも同じ） |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                                                             |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                              |

### 消費側への注意

- 既存の公開 API は変わらない（追加のみ）。`CommandPalette` の Esc・フォーカスの扱いは共通の補助に移ったが、振る舞いは同じ（配置されていない層を手前の層と数えなくなった、という端の違いだけ）。
- 自前の Modal・Drawer やフォーカスの閉じ込めの写しを持つアプリは、`@banto/ui` の `Modal`・`Drawer`・`hasVisibleLayerAbove` などに置き換えられる（props は banto-industrial の banto-hub と同じ。`LAYER_ABOVE_SELECTOR` → `LAYER_SELECTOR`、`DrawerCloseSource` → `OverlayCloseSource`）。面は `--banto-surface-overlay`、z は `--banto-z-modal`。
- 開発用の依存を更新した（Playwright 1.64、Svelte 5.57.2、SvelteKit 3.0.1、Vite 8.3.3、jsdom 30.1.2 など）。external-consumer の fixture の版の範囲も admin-template に揃えた。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `1ffe507`、`workflow_dispatch`）: [run 38131322412](https://github.com/tyaro/banto/actions/runs/38131322412)（success）。
  - タグの push（`v6.7.0`）: [run 38131442603](https://github.com/tyaro/banto/actions/runs/38131442603)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.2                         |
    | SvelteKit          | 3.0.1                          |
    | Vite               | 8.3.4                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.2` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加

- `@banto/ui`: `Modal`（中央）・`Drawer`（右端）と、Esc・フォーカスの層の補助（`hasVisibleLayerAbove`・`hasVisibleMenuLayer`・`attachFocusTrap`・`focusablesIn`・`restoreFocus`・`canRestoreFocusTo`・`effectiveZIndex`・`isCloseAllowed` と `LAYER_*`・`FOCUSABLE_SELECTOR`、型 `ModalProps`・`DrawerProps`・`OverlayProps`・`OverlayCloseSource`）を追加（ADR-0018 段階 4、2026-10-11 オーナー決定。追加のみ。後方互換）。banto-industrial の banto-hub の部品の props（`open`・`title`・`width`・`closeOnOverlayClick`・`onclose`・`onRequestClose`・`dirty`・`onBlockedClose`・`focusFallback`）をそのまま持ち、× の名前は `UiMessages.overlayClose`（既定 `'閉じる'`）。重なりは `--banto-z-modal`、背景は `--banto-scrim`。派生アプリへの影響: 経路 A はタグを上げるだけ（`@banto/ui` は既に `optimizeDeps.exclude` の対象で、変更は不要）。経路 B・C は変更なし。
- `@banto/ui`: `CommandPalette` の Esc・フォーカスの扱いは、`Modal`・`Drawer` と同じ 1 つの補助（`layering.ts`。段階 2b の内部の `overlayFocus.ts` を置き換えた）を使うようにした。パレットの振る舞いは変わらない（違いは、レイアウトされていない層・`display: none` の中の層を手前の層と数えなくなったことだけ）。admin-template の `/ui-demo` に `Modal`・`Drawer` の見本を足した。

## [6.6.0] - 2026-10-10

**v6.6.0 — `banto-admin-services` の監査に、記録の失敗と保留（spool）の警告行をアプリ自前のログへ流す `with_log_sink` / `with_shared_log_sink` と型 `AuditLogSink` を足した（ADR-0019、tyaro/banto-industrial#437 の続き）。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                          |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.5.0` → `v6.6.0`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。`with_log_sink` / `with_shared_log_sink` を呼ばなければ挙動は変わらない |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                                      |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                       |

### 消費側への注意

- 既存の公開 API は変わらない（追加のみ）。`with_log_sink` / `with_shared_log_sink` を呼ばない `AuditLogService` は v6.5.0 と同じく `eprintln!` に出す（文言も同じ）。
- 標準エラー出力がどこにも届かない構成（Windows サービスなど）では、`with_log_sink(|line| ...)` でアプリのログに流す。1 つの sink を複数のサービスで共有するときは `AuditLogSink`（`Arc`）を `with_shared_log_sink` に渡す。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `4da9930`、`workflow_dispatch`）: [run 38038323977](https://github.com/tyaro/banto/actions/runs/38038323977)（success）。
  - タグの push（`v6.6.0`）: [run 38038425290](https://github.com/tyaro/banto/actions/runs/38038425290)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加

- `banto-admin-services`: `AuditLogService::with_log_sink`（クロージャ）・`with_shared_log_sink`（共有済みの `Arc`）と型 `AuditLogSink` を追加（追加のみ。後方互換）。`record` の失敗と保留（spool）の警告行を、既定の `eprintln!` の代わりにアプリ自前のログへ流せる（標準エラー出力を持たない Windows サービス向け。`with_spool` の前後どちらでも可。呼ばなければ従来どおり `eprintln!`、文言も同じ。ADR-0019）。

## [6.5.0] - 2026-10-10

**v6.5.0 — `@banto/charts` の `LineChart` にツールチップ専用の書式 `formatTooltip` を足した（#376）。`banto-admin-services` に、DB に書けない監査を保留ファイルに退避し、復旧後に 1 回だけ流し込む保留（spool）を足した（tyaro/banto-industrial#437、ADR-0019）。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 C は、監査の保留を使うアプリだけ migration 0008 の取り込みが必要。経路 B は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                            |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.4.0` → `v6.5.0`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。`formatTooltip`・`with_spool` を使わなければ挙動は変わらない                                                              |
| B. コピーしたテンプレート        | なし | 変更なし（admin-template の配線は変えていない）                                                                                                                                                                 |
| C. DB・設定・配布資産            | あり | DB のマイグレーション `0008_audit_log_pending_id.sql`（SQLite・PostgreSQL）を追加。**監査の保留（`with_spool`）を使うアプリは取り込む必要がある**。使わないアプリは取り込まなくても動く（取り込んでも害はない） |

### 消費側への注意

- 既存の公開 API は変わらない（追加のみ）。`formatTooltip` を指定しない `LineChart`、`with_spool` を呼ばない `AuditLogService`（`record` / `try_record`）は v6.4.0 と同じ。
- `with_spool` を使うときは、migration `0008_audit_log_pending_id.sql` を自分の migrations にそのまま写してから使う（`audit_log.pending_id` が無いと、保留を付けた `record` の INSERT が失敗し続け、すべて保留に回る）。起動時（migration の後）に `flush_spool()` を 1 回呼び、`spawn_spool_flusher()` のハンドルを持って終了時に止める。保留の状態は `spool_backlog()` で見られる。
- 保留ファイルには監査の内容（ユーザー名・操作の要約）が残る。データディレクトリと同じ権限で守る（ADR-0019）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `c8b5d34`、`workflow_dispatch`）: [run 38010407324](https://github.com/tyaro/banto/actions/runs/38010407324)（success）。
  - タグの push（`v6.5.0`）: [run 38010538144](https://github.com/tyaro/banto/actions/runs/38010538144)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加

- `@banto/charts`: `LineChart` に任意の `formatTooltip?: (value, series, index) => string` を追加した。ツールチップの値の書式だけを、系列の情報（`id` / `label` / `axis`）とデータの添字を受け取って系列ごとに変えられる。縦軸の目盛と余白の自動計算には使わず、有限の値にだけ呼ばれる（非有限は従来どおり `-`）。bit と数値のタグが混ざったグループでツールチップの bit だけを `True` / `False` にしたり、縦軸を `False` / `True` だけにしたままツールチップでは区間の中点も出したりするためのもの（tyaro/banto#376、tyaro/banto-industrial#551）。指定しなければ描画は従来と同じ（`formatY`、右の軸の系列は `formatYRight`）。
- `banto-admin-services`: DB に書けない監査を保留ファイルに退避し、復旧後に 1 回だけ `audit_log` へ流し込む保留（spool）を追加した（tyaro/banto-industrial#437、[ADR-0019](docs/adr/0019-audit-spool.md)）。`AuditLogService::new(db).with_spool(dir, SpoolConfig::default())?` で有効にすると、`record` は書く前に `pending_id`（UUIDv4）と `ts` を決め、INSERT が失敗するか 3 秒（`SpoolConfig::timeout`）で応答しなければ、その 1 件を `<dir>/<pending_id>.json` に書いて戻る（要求を待たせない。タイムアウトした INSERT は取り消さない）。流し込みは `flush_spool()`（起動時にアプリが呼ぶ）・`record` の成功（保留があるとき、または保留ディレクトリを `flush_interval` のあいだ読んでいないとき）・`spawn_spool_flusher()` の定期実行（既定 30 秒。自分の保留が 0 件でも毎回ディレクトリを読むので、同じディレクトリを使う別のプロセスが残した分も拾う）で行い、`ON CONFLICT (pending_id) DO NOTHING` なので、遅れて完了した INSERT と流し込みが重なっても、複数のプロセスが流し込んでも 1 行になる。流し込んだ行は `detail.spooled = true`、`ts` は `record` を呼んだ時刻（保持期間の削除はこの `ts` で判定するので、古い行は流し込みの直後に消え得る）。保留は既定で 10,000 件まで（超えた分は捨てて `spool_backlog().dropped` に数える）、状態は `spool_backlog()` で見られる。`try_record` は保留しない。**DB のマイグレーション `0008_audit_log_pending_id.sql`（`audit_log.pending_id` と一意インデックス、SQLite・PostgreSQL の両方）を追加した（経路 C）。保留を使うアプリはこれを取り込む必要がある。** `with_spool` を呼ばなければ `record` は従来と同じで、マイグレーションを取り込まなくても動く。

## [6.4.0] - 2026-10-09

**v6.4.0 — `@banto/charts` の `LineChart` に、左の縦軸の範囲に必ず含める値を指定する `includeY` を足した（tyaro/banto-industrial#554）。版の種類: minor（追加のみ。後方互換。指定しなければ描画は変わらない）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                            |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.3.2` → `v6.4.0`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。`includeY` を使わなければ描画は変わらない |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                        |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                         |

### 消費側への注意

- 既存の `@banto/*` の公開 API は変わらない（追加のみ）。`includeY` を指定しない `LineChart` の描画は v6.3.2 と同じ。
- `includeY` は左の軸の目盛の範囲だけを広げる。データ点・ツールチップ・凡例・系列は増えず、データが無いチャートは空表示のまま。右の軸には効かない。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `d972480`、`workflow_dispatch`）: [run 37946218576](https://github.com/tyaro/banto/actions/runs/37946218576)（success）。
  - タグの push（`v6.4.0`）: [run 37952598880](https://github.com/tyaro/banto/actions/runs/37952598880)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加

- `@banto/charts`: `LineChart` に任意の `includeY?: readonly number[]` を追加した。左の縦軸の範囲に必ず含める値を指定でき、左の軸の系列のデータの範囲との和集合で目盛を決める（データが無ければ指定値だけ。非有限の値は無視する）。ビット（0/1）のタグだけの推移で、見えている値が 0.5 の 1 点だけのときに目盛が 0.2〜0.8 になり、0 と 1 しか書かない書式で目盛がすべて空になる問題を、偽のデータ点を入れずに避けるためのもの（tyaro/banto-industrial#554）。データ点・ツールチップ・凡例・系列は増えず、データが無いチャートの空表示も変わらない。指定しなければ描画は従来と同じ。右の軸には効かない。

## [6.3.2] - 2026-10-09

**v6.3.2 — `@banto/charts` の `LineChart` / `ComboChart` / `StackedAreaChart` / `ScatterChart` の左の余白が、左の軸の目盛の文字の幅に合わせて自動で広がるようにした（長い目盛が左で見切れていたのを直した）。版の種類: patch（修正のみ。公開 API の変更は無い）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                           |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.3.1` → `v6.3.2`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。目盛が長いチャートの左の余白が広がる（配線の変更は不要） |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                       |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                        |

### 消費側への注意

- 公開 API は変わらない（修正のみ）。`margins.left` は引き続き指定でき、最小値として扱われる。
- 目盛が左の余白に収まっていたチャートの描画は変わらない。ただし文字幅は推定で見積もるため、6 文字の目盛を持つチャートは余白が約 1px 広がることがある。スナップショットテストや画素比較をしているアプリは、この差を確認する。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `a25b233`、`workflow_dispatch`）: [run 37927931064](https://github.com/tyaro/banto/actions/runs/37927931064)（success）。
  - タグの push（`v6.3.2`）: [run 37928088362](https://github.com/tyaro/banto/actions/runs/37928088362)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Done in ... using pnpm v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 修正

- `@banto/charts`: `LineChart` / `ComboChart` / `StackedAreaChart` / `ScatterChart` の左の余白が、左の軸の目盛（`formatY` を通した後）の文字の幅に合わせて自動で広がるようにした。これまで 48px 固定で、`800,000,000` のような長い目盛が左で見切れていた（tyaro/banto-industrial#550）。余白は左の軸の目盛の幅に合わせて広がるが、上限は 140px とチャート幅の 40% のうち小さい方（巨大な目盛でプロットが消えないようにする）。`LineChart` の右の軸にも同じ上限を付けた。目盛が収まっていたチャートの描画は変わらない（ただし 6 文字の目盛は、文字幅を推定で見積もるため約 1px 広がることがある）。呼び出し側の `margins.left` は最小値として扱う。

## [6.3.1] - 2026-10-09

**v6.3.1 — `banto_server::static_files::static_router` が、どの API ルートにも一致しなかった `/api`・`/api/...` の要求を、SPA の HTML（200）ではなく JSON の 404 で返すようにした。版の種類: patch（修正のみ。公開 API の変更は無い。ただし 1 点、見える挙動が変わる: 存在しない `/api/...` の応答が 200 の HTML から 404 の JSON になる）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                           |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.3.0` → `v6.3.1`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要。**見える挙動が 1 点変わる**: 存在しない `/api/...` を呼ぶと、200 の HTML ではなく 404 の JSON が返る（配線の変更は不要） |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                                                                                       |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                        |

### 消費側への注意

- 公開 API は変わらない（修正のみ）。`static_router` を merge しているアプリは、配線の変更なしで反映される。
- **存在しない API パスを呼んでいた画面・クライアントは、応答が変わる**: 従来は 200 の HTML（SPA の `index.html`）が返り、JSON として読もうとして別の場所で失敗していた。今後は 404 の JSON（`{"kind":"not_found","resource":"api","id":"<パス>"}`）が返る。404 を前提にしていなかった呼び出し側は、エラー処理を確認する。`/apiary` など `/api/` で始まらないパスと画面のルートは従来どおり `index.html`。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `8841504`、`workflow_dispatch`）: [run 37896295455](https://github.com/tyaro/banto/actions/runs/37896295455)（success）。
  - タグの push（`v6.3.1`）: [run 37896660250](https://github.com/tyaro/banto/actions/runs/37896660250)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 修正

- `banto_server::static_files::static_router` が、どの API ルートにも一致しなかった `/api`・`/api/...` の要求を SPA のフォールバック（`index.html` を 200 で返す）に落とさず、JSON の 404（`{"kind":"not_found","resource":"api","id":"<パス>"}`）で返すようにした。どのメソッドでも同じ。`/apiary` など `/api/` で始まらないパスと画面のルートは従来どおり `index.html`。派生アプリへの影響: 存在しない `/api/...` が 200 の HTML ではなく 404 になる（`static_router` を merge しているアプリは配線の変更なしで反映される）。banto-industrial#547

## [6.3.0] - 2026-10-08

**v6.3.0 — `@banto/charts` の欠測・開放端しきい値・値なしの表示を足した（#369）: `LineChart` の `gaps`（欠測で線を分ける）、開放端を持てる `OpenThresholdBand`（`bands` のクリップ）、`Gauge` の `value: number | null` と下側しきい値 `warningLow` / `dangerLow`、文字 `messages.gaugeNoValue`。docs のみの変更として ADR-0018 の段階 3 の記録（#367）と README の再構成（#368）を含む。版の種類: minor（追加のみ。後方互換。ただし 1 点、既定の見た目が変わる: プロット領域の外だけのバンドは描かなくなる）。
派生アプリへの影響: 経路 A はタグを上げるだけ（`.svelte.ts` の追加は無く、`optimizeDeps.exclude` の変更は不要）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.2.0` → `v6.3.0`（npm と Rust を同じタグに）。`optimizeDeps.exclude` の変更は不要（charts に `.svelte.ts` は無い）。**既定の見た目が 1 点変わる**: `LineChart` の `bands` のうち、y 軸の範囲の外だけにあるバンドは、描かれなくなる（領域内に収まる有限のバンドは変わらない） |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                                                                                                                                                        |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                                                         |

### 消費側への注意

- 既存の `@banto/*` の公開 API は変わらない（追加のみ）。`Gauge` の `value` の型が `number | null` に広がるが、`number` を渡す既存の呼び出しはそのまま動く。
- **`LineChart` の `bands` は、プロット領域にクリップされる**。y 軸の範囲の外にあるバンドは描かれなくなる（範囲にまたがるバンドは範囲内だけが描かれ、はみ出さない）。バンドを軸の範囲の外に置いて見せていた画面は、軸の範囲を広げるか、開放端（`from` / `to` に `null`）で書き直す。
- docs のみの変更: ADR-0018 の段階 3 の記録（#367）、README の再構成（#368）。コード・公開 API への影響は無い。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `be031a4`、`workflow_dispatch`）: [run 37755291733](https://github.com/tyaro/banto/actions/runs/37755291733)（success）。
  - タグの push（`v6.3.0`）: [run 37755468457](https://github.com/tyaro/banto/actions/runs/37755468457)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（どちらの run も runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加（minor、追加のみ）

- feat(charts): `LineChart` に `gaps?: 'join' | 'break'`（既定 `'join'` = 従来どおり）を足した。`'break'` は欠測（null / undefined / NaN。数値化の前に欠測として扱い、0 にはしない）で線とエリアを別の部分パスに分け、欠測をまたいでつながない。軸の範囲とツールチップも欠測を無視する。`'join'`（既定）の値の扱い（`null` は従来どおり 0）は変えていない。純関数 `linePathSegments` / `areaPathSegments` を公開
- feat(charts): `LineChart` の `bands` を `OpenThresholdBand`（`from`/`to` が `number | null`）にし、null・非有限（±Infinity を含む。順序より前に位置で決める: `from` は下端、`to` は上端）を開放端（プロット端まで）として扱い、バンドをプロット領域にクリップする。領域内に収まる有限のバンドの出力は変わらない（領域外だけのバンドは描かなくなる）。純関数 `resolveBand` を公開
- feat(charts): `Gauge` の `value` を `number | null` にした。null・非有限は値の弧を描かず「—」を表示する（文字は `messages.gaugeNoValue`）。`GaugeThresholds` に下側のしきい値 `warningLow` / `dangerLow`（`value <=` で着色）を足した。上側の `warning` / `danger` は変わらない

## [6.2.0] - 2026-10-08

**v6.2.0 — `@banto/ui` の段階 2（#220）: メニュー部品（`Menu`・`MenuGroup`・`MenuItem`・`MenuSeparator`、#361）、フォーカストラップ・フォーカス復帰・window の Esc を備えた `CommandPalette`（#363）、トーストのストア `createToastStore()` と、アクション付きボタンを持つ `ToastHost`（#364）、テーマのトークン `--banto-scrim` と z-index の層（#361）を足した。[ADR-0018](docs/adr/0018-shared-ui-package.md) の段階 1・2 の決定を Accepted にした。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A は `@banto/ui` を使っているなら **Vite の `optimizeDeps.exclude` に `'@banto/ui'` を足す必要がある**（`@banto/ui` が初めて `.svelte.ts` を持つ。[ADR-0007](docs/adr/0007-derived-app-dev-optimizer-exclude.md)・#478）。経路 B は admin-template から写したメニュー・CommandPalette・トーストを `@banto/ui` からの import に替えられる。経路 C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                           |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v6.1.0` → `v6.2.0`（npm と Rust を同じタグに）。**`@banto/ui` を使う派生アプリは Vite の `optimizeDeps.exclude` に `'@banto/ui'` を足す**（必須。足さないと `pnpm dev` が 500 になる）。既存の `@banto/*` の公開 API は変わらない（追加のみ） |
| B. コピーしたテンプレート        | 任意 | admin-template のメニュー・CommandPalette・トーストの写しは `@banto/ui` から import できる。直書きのオーバーレイの値はトークンに置き換えられる。トーストの id は文字列で、アクションの prop は `onAction`                                      |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                        |

### 消費側への注意

- 既存の `@banto/*` の公開 API は変わらない（追加のみ）。
- **`@banto/ui` を使う派生アプリは、Vite の `optimizeDeps.exclude` に `'@banto/ui'` を足す**（`toast.svelte.ts` のため。トーストを使わなくても同じ。[ADR-0007](docs/adr/0007-derived-app-dev-optimizer-exclude.md)、[docs/upgrading.md](docs/upgrading.md) 3.1）。`pnpm build` と `pnpm check` ではこの漏れは分からない。`pnpm dev` で画面を開いて確かめる。
- 経路 B の写しは、取り込むなら `@banto/ui` から import し、トークン（`--banto-scrim`・`--banto-z-*`）で直書きを置き換える。トーストの id は数値から文字列、アクションの prop は `onClick` から `onAction`。詳細は下の「追加」の各項と [docs/upgrading.md](docs/upgrading.md) 3.2。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `021c71e`、`workflow_dispatch`）: [run 37706871381](https://github.com/tyaro/banto/actions/runs/37706871381)（success）。
  - タグの push（`v6.2.0`）: [run 37707052116](https://github.com/tyaro/banto/actions/runs/37707052116)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（どちらの run も runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加（minor、追加のみ）

- feat(ui): メニュー部品（`Menu`・`MenuGroup`・`MenuItem`・`MenuSeparator`）を admin-template の `components/menu/` から `@banto/ui` へ移した（#220 段階 2a、[ADR-0018](docs/adr/0018-shared-ui-package.md)）。DOM・CSS・props は変えていない（`MenuItem` の `icon` の型だけ `UiIconComponent` にした。lucide の部品はそのまま渡せる）。admin-template の `Header` は `@banto/ui` から import し、`components/menu/` は削除した。jsdom テストを足し、`/ui-demo` に Menu の見本を足した（開いていない状態のトリガーだけが画面に出る）。
- feat(theme): オーバーレイのスクリムと z-index の層のトークンを足した（#220 段階 2a）。`--banto-scrim`（`rgb(0 0 0 / 0.35)`。light・dark・glass で共通）と `--banto-z-header`（100）・`--banto-z-sidebar-scrim`（850）・`--banto-z-sidebar`（900）・`--banto-z-modal`（900。Modal / Drawer 用の予約）・`--banto-z-overlay`（1000）・`--banto-z-toast`（1000）。admin-template の直書き（`rgba(0, 0, 0, 0.35)` と z-index）をトークンに置き換えた。値は同じで、見た目も重なり順も変わらない。
  - 消費側への注意: 既存の `@banto/*` の公開 API は変わらない（追加のみ）。**経路 A**: `@banto/ui` を使っていれば、更新だけでメニュー部品が使える。トークンは `@banto/theme/css` を読み込んでいれば自動で入る。**経路 B**: admin-template から写した `components/menu/`（5 ファイル）はそのまま残しても動く。取り込むなら `@banto/ui` から import して写しを消す（[docs/upgrading.md](docs/upgrading.md) 3.2）。生の `rgba()` や z-index の直書きがあれば、新しいトークンへ置き換えられる（任意）。
- feat(ui): コマンドパレットの表示と操作を `@banto/ui` の `CommandPalette` にした（#220 段階 2b、[ADR-0018](docs/adr/0018-shared-ui-package.md) §8・決定 8）。props は `open`（bindable）・`items`・`search?`・`recentIds?`・`onExecute`・`onClose?`・`focusFallback?`・`messages?`。項目の型 `CommandPaletteItem` は admin-core の `PaletteCommand` と構造的に合う。既定の検索 `defaultCommandPaletteSearch` と、文言 `UiMessages` の `commandPalette*`（既定は日本語）を足した。banto-hub（banto-industrial #381）のフォーカストラップ・閉じたら開いた元へフォーカスを戻す・window で受ける Esc（消費済みの Esc と手前の層には譲る）を標準の振る舞いにした。見た目は admin-template の現行のまま。admin-template の `CommandPalette.svelte` は、コマンドの一覧・`searchCommands`・セッションのスコープ（#258）・最近使った記録・通知・Paraglide の文言だけを持つ包みになった。jsdom テストを足し、`/ui-demo` にコマンドパレットの見本（開くボタン）を足した。
  - 利用者に見える違い（admin-template）: 開いている間 Tab がパレットの外へ出ない。閉じると開く前にフォーカスがあった要素（ヘッダーの検索ボタンなど）へフォーカスが戻る（これまでは `<body>` に落ちていた）。フォーカスがパレットの外にあっても Esc で閉じる。それ以外の見た目・並び・操作は同じ。
  - 消費側への注意: 既存の `@banto/*` の公開 API は変わらない（追加のみ）。**経路 A**: `@banto/ui` を使っていれば、更新だけで `CommandPalette` が使える（CommandPalette 自体は `.svelte.ts` を持たないが、同じ v6.2.0 のトーストのストア（#364）で `optimizeDeps.exclude` への `@banto/ui` の追加が必要になった。上の「消費側への注意」を参照）。オーバーレイは `position: fixed` なので、`backdrop-filter` などを持つ要素の外に置く。**経路 B**: 写した `CommandPalette.svelte` はそのまま残しても動く。取り込むなら admin-template の新しい包みを差分として当てる（[docs/upgrading.md](docs/upgrading.md) 3.2）。banto-industrial の写しは段階 3 で置き換える。

- feat(ui): トーストのストアと表示を `@banto/ui` に移した（#220 段階 2c、[ADR-0018](docs/adr/0018-shared-ui-package.md) §8・決定 9。**段階 2 が完了**）。`createToastStore({ autoDismissMs?, maxToasts? })`（runes の `.svelte.ts`）と `ToastHost`（`store`・`messages?`）。`push(kind, message, options?)` は id を返し、`options` は `action?: { label, onAction }`（banto-hub の取り消しボタンを標準にした。`onClick` から改名）・`durationMs?`（既定 4000。`0`・負・`Infinity` は消さない）・`id?`（既存の id は置き換え）。アクションは押すと処理のあとで（例外でも）閉じ、閉じた後は呼ばない。`kind` は `success`・`error`・`info`・`warning`（admin-core の `NotificationKind` と構造的に同じ）。文言は `UiMessages.toastClose`、置き場所は CSS 変数 `--banto-toast-right`・`--banto-toast-bottom`、重なりは `--banto-z-toast`。admin-template の `toast.svelte.ts` は `createToastStore()` の 1 行、`ToastHost.svelte` は `@banto/ui` の薄い包み（Paraglide の「閉じる」）になり、`setup.ts` の `notify` の配線と各画面の `toastStore.push(...)` は変わらない。jsdom テスト（自動で消す時間・置き換え・上限・アクション・読み上げの領域）を足し、`/ui-demo` にトーストの見本（種類ごとのボタンとアクション付き）を足した。
  - 利用者に見える違い（admin-template）: 読み上げが 2 つの常設の領域に分かれた（`error`・`warning` は `role="alert"`、`success`・`info` は `role="status"`。以前は常設の 1 つの `role="status"`）。時間切れ前に閉じたトーストのタイマーは止まる。見た目・出現位置・4000ms は同じ。
  - **消費側への注意（`optimizeDeps.exclude`）**: `@banto/ui` が初めて `.svelte.ts`（`toast.svelte.ts`）を持つ。**`@banto/ui` を使う派生アプリは、Vite の `optimizeDeps.exclude` に `'@banto/ui'` を足す**（足さないと `pnpm dev` の依存オプティマイザが `import type` で 500 になる。[ADR-0007](docs/adr/0007-derived-app-dev-optimizer-exclude.md)、[docs/upgrading.md](docs/upgrading.md) 3.1）。トーストを使わなくても同じ。admin-template の `vite.config.ts`・外部利用 fixture・scaffold（`@banto/ui` は常に残るので `tree-svelte` を外すときの消し方を行ごとにした）・`verify:architecture` の rule `optimizedeps-svelte-source` を同じ変更で更新した。`pnpm build` と `pnpm check` ではこの漏れは分からない。**`pnpm dev` で画面を開いて確かめる。**
  - 消費側への注意: 既存の `@banto/*` の公開 API は変わらない（追加のみ）。**経路 A**: `@banto/ui` を使っていれば、更新と exclude の 1 行でトーストが使える。**経路 B**: 写した `toast.svelte.ts`・`ToastHost.svelte` はそのまま残しても動く。取り込むなら admin-template の薄い版に替え、exclude を足す（[docs/upgrading.md](docs/upgrading.md) 3.2）。banto-industrial の写し（banto-hub・chronogazer）は段階 3 で置き換える（`onClick` → `onAction`、id が数値から文字列）。外部利用 fixture は、v6.2.0 のタグを打つまで（`v6.1.0` に `createToastStore` が無いため）タグの経路だけ落ちていた。v6.2.0 で解消する。

## [6.1.0] - 2026-10-07

**v6.1.0 — 新パッケージ `@banto/ui`（`packages/ui`）を追加し、admin-template の汎用 UI 部品 7 つをそこへ移した（#220 段階 1。`/ui-demo` 見本ページと、`verify:architecture` の rule `package-bare-imports` を含む）。[ADR-0018](docs/adr/0018-shared-ui-package.md) の段階 1 を Accepted にした。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A は `@banto/ui` を任意の追加依存として足せる。経路 B は admin-template から写した `components/ui/` を `@banto/ui` からの import に替えられる（見本ページの取り込みも任意）。経路 C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                  |
| -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | 任意 | `v6.0.0` → `v6.1.0`（npm と Rust を同じタグに）。新パッケージ `@banto/ui` を任意の追加依存として足せる（既存の `@banto/*` の公開 API は変わらない）   |
| B. コピーしたテンプレート        | 任意 | admin-template のコピーは `components/ui/` を `@banto/ui` から import するように替えられる（`LoadingState` の `label` は明示する）。`/ui-demo` は任意 |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                               |

### 消費側への注意

- 既存の `@banto/*` の公開 API は変わらない。`@banto/ui` を使うときは Git 依存で足す（`.svelte.ts` を持たないので `optimizeDeps.exclude` は増やさない）。詳細は下の「追加」の項と [docs/upgrading.md](docs/upgrading.md) 3.2。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `f8418fa`、`workflow_dispatch`）: [run 37619255296](https://github.com/tyaro/banto/actions/runs/37619255296)（success）。
  - タグの push（`v6.1.0`）: [run 37622287549](https://github.com/tyaro/banto/actions/runs/37622287549)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（どちらの run も runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 追加（minor、追加のみ）

- feat(ui): 新パッケージ `@banto/ui`（`packages/ui`）を追加し、admin-template の `components/ui/` にあった汎用 UI 部品 7 つ（EmptyState・ErrorState・IconButton・LoadingState・PageHeader・StatusBadge・SurfaceCard）を移した（#220 段階 1、[ADR-0018](docs/adr/0018-shared-ui-package.md)）。DOM・CSS・props は変えていない。依存は空で、既定のアイコン（lucide の 7 つ）は ISC 表記付きで同梱し、`icon` の型は `UiIconComponent`（lucide の部品もそのまま渡せる）。`LoadingState` の `label` の既定はパッケージの `defaultUiMessages.loading()`（日本語）。admin-template は `@banto/ui` から import し（`components/ui/` は削除）、`LoadingState` の `label` を全箇所で明示する。`/ui-demo` に 7 部品の主要な状態を並べた見本ページを足した（ナビには `VITE_BANTO_DEMO=1` のビルドのときだけ出る。ビジュアル回帰の対象）。`verify:architecture` に rule `package-bare-imports`（`packages/*/src` の素の import は `svelte`・`svelte/*` だけ）を足した。外部利用 fixture に `@banto/ui` を足した。
  - 消費側への注意: 既存の `@banto/*` の公開 API は変わらない。**経路 A**: `@banto/ui` は任意の追加依存（使うなら Git 依存で足す。`.svelte.ts` を持たないので `optimizeDeps.exclude` は増やさない）。**経路 B**: admin-template から写した `components/ui/` はそのまま残しても動く。取り込むなら `@banto/ui` から import し、`LoadingState` の `label` を明示する（[docs/upgrading.md](docs/upgrading.md) 3.2）。

### その他

- docs(adr): 共通 UI 部品を新パッケージ `@banto/ui`（`packages/ui`）に切り出す設計を [ADR-0018](docs/adr/0018-shared-ui-package.md)（段階 1 の判断は 2026-10-07 にオーナー決定で Accepted。段階 2 は未決）として記録した（#220 段階 0）。admin-template の `components/ui/` の 7 部品と、段階 2 の候補（メニュー部品・CommandPalette・ToastHost、banto-industrial の写しとの違い）の棚卸し、公開 API・アイコンの同梱・文言の注入・検査と配布の更新・オーナー判断事項を含む。コードは動かしていない。ADR が名指しする `@banto/ui` を、段階 1 まで `verify-architecture.mjs` の `DOCS_PACKAGE_REF_ALLOWLIST` に入れた。`docs/template-scope.md` §2.1 に提案中の注記を足した。

## [6.0.0] - 2026-10-07

**v6.0.0 — `WindowedListResource` の失敗を、`SnapshotListResource` と同じ形（`failures`・`messages`・`notify`）に変え、2 つのリソースのエラーの型を共通の `ListBlockError` にした（#344。破壊的変更）。あわせて、`tauri-check` への clippy の追加（#346）、`apps/admin-template/core/build.rs` の `rerun-if-changed`（#340）、`industrial-plan` の history 化（#312）。版の種類: major（`WindowedListResource` の `error`・`failedBlocks` の削除と、`SnapshotListError` などの改名）。
派生アプリへの影響: 経路 A は `WindowedListResource` の `error`・`failedBlocks` と、改名した 4 つの型・関数を使っている箇所を置き換える。経路 B は商品一覧のサーバーモードなどコピー済みの利用箇所と `core/build.rs` の取り込みが要る。経路 C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v5.1.0` → `v6.0.0`（npm と Rust を同じタグに）。`WindowedListResource` の `error`・`failedBlocks` を削除（`failures`・`messages`・`notify` に置き換え）。`SnapshotListError`・`isSnapshotListError`・`SnapshotListFailureCode`・`SnapshotListErrorFailure` を `ListBlockError`・`isListBlockError`・`ListBlockFailureCode`・`ListBlockErrorFailure` に改名（互換用の別名なし） |
| B. コピーしたテンプレート        | あり | 商品一覧のサーバーモード（`ItemsServerGrid.svelte`。`messages` と新しい Paraglide キー `items.loadTimeout`・`items.malformedResult`）、`apps/admin-template/core/build.rs`（#340。migration の `rerun-if-changed`）。詳細は下の「その他」の各項                                                                                                                                 |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                                                                                                                                                         |

### 消費側への注意

- 移行の手順書（docs/upgrading.md の例）は v6.0.0 では用意しない。後方互換も保たない（オーナー決定 2026-10-07）。下の「その他」の `WindowedListResource` の項（削除・名前の変更・追加・置き換え先）に従う。banto-industrial は、テストの `isSnapshotListError` を `isListBlockError` に替えるだけで済む。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `bb4bd76`、`workflow_dispatch`）: [run 37577202472](https://github.com/tyaro/banto/actions/runs/37577202472)（success）。
  - タグの push（`v6.0.0`）: [run 37577385697](https://github.com/tyaro/banto/actions/runs/37577385697)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（タグ前の run では runner に入っていた 1.98.1 から更新された後の版。タグの push の run では更新済みで変更なし）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- docs(layout): `docs/industrial-plan.md` を `docs/history/industrial-plan.md` へ移動した（#312 の industrial-plan の history 化）。2026-07-12 時点の初期構想で、banto-industrial の現行の計画は別リポジトリ側（`docs/plan.md`）が持つため、状態行を「履歴」に確定した。banto 側の現行の境界は `docs/template-scope.md` §5 末尾、配布方針は `docs/publishing.md` を参照する。ファイル名は不変なので `industrial-plan.md §2` のようなラベル参照はそのまま有効。参照は同じ PR で新パスに更新済み。過去の節に書かれた旧パスは書き換えない。GitHub 上の旧 blob リンクは追従しない（スタブは置かない）。`.prettierignore` に `docs/history/industrial-plan.md` を追加（移動前と同じく整形対象外）。旧 → 新の対応表:

  | 旧                        | 新                                |
  | ------------------------- | --------------------------------- |
  | `docs/industrial-plan.md` | `docs/history/industrial-plan.md` |

- admin-template の src-tauri の doc コメントが Rust 1.98 の clippy（`doc_lazy_continuation`）に掛かるのを直し、`tauri-check` に `cargo clippy -p admin-template` を足した（#346）。

- fix(admin-template): `apps/admin-template/core` に `build.rs` を足し、`migrations-sqlite`・`migrations-postgres` に `cargo:rerun-if-changed` を出すようにした（#340）。安定版の `sqlx::migrate!` は既存の migration ファイルを `include_str!` で追跡するが、新しい migration ファイルの追加は検知しないため、migration を足しただけの増分ビルドがそれを含まないバイナリを作りうる状態だった。リリース済みの migration ファイルは変えていない（`verify:migrations` 通過）。`sqlx::migrate!` を使う crate は、このリポジトリではこの crate だけ。
  - 派生アプリへの影響: 経路 B は、admin-template の `core` をコピーしたアプリ（banto-industrial など）は `apps/admin-template/core/build.rs` もコピーし、自分の migration のディレクトリ名に合わせる（banto-industrial は `Migrator::dangerous_set_table_name` で独自の migration のディレクトリを使うので、そのディレクトリを `rerun-if-changed` に書く）。scaffold の各プリセットは `core` を残すので `build.rs` も残る。経路 A・C は変更なし。

- feat(admin-core, admin-template)!: **破壊的変更（v6.0.0 で出す）** `WindowedListResource` の失敗を、`SnapshotListResource`（#342）と同じ形にした。種類（コード）で見分けられ、文言を差し替えられ、トーストを止められ、全ブロック分を見られる（#344、[ADR-0015 の追記](docs/adr/0015-snapshot-list-resource.md)）。あわせて、2 つのリソースのエラーの型を共通の名前 `ListBlockError` にした。オーナー決定（2026-10-07）により後方互換は保たず、互換用の別名は残さない。移行の手順書は用意しない（下の置き換え先に従う）。
  - 削除: `WindowedListResource` の `error`（最新の失敗 1 件）と `failedBlocks`。
  - 名前の変更（`SnapshotListResource` の型。中身は同じ）: `SnapshotListError` → `ListBlockError`（`name` も `'ListBlockError'`）、`isSnapshotListError` → `isListBlockError`、`SnapshotListFailureCode` → `ListBlockFailureCode`、`SnapshotListErrorFailure` → `ListBlockErrorFailure`。`SnapshotListFailure`・`SnapshotListExpiredFailure`・`SnapshotListMessages`・`defaultSnapshotListMessages` は名前も中身も変えていない（`SnapshotListMessages` は `ListBlockMessages` を拡張する形にした）。
  - 追加（`WindowedListResource` の状態）: `failures: readonly ListBlockErrorFailure[]`。ブロック順・ブロックごとに 1 件で、`{ block, kind: 'error', code, error }`。消える条件は従来の `failedBlocks` と同じ（そのブロックの取得の成功、`setParams()`）。`refresh()` の間も残り、取り直しが済むと成功なら消え、失敗なら新しい失敗に置き換わる。`refresh()` が表示中の行を世代が落ち着くまで保つ挙動（#212）は変えていない（`failures` は落ち着く前にも更新される）。
  - 追加（`WindowedListResource` のオプション）: `messages`（`timeout(ms)`・`malformed()`。リソースが自分で作る失敗の文言。既定は今の英語の文言。関数が投げたら既定の文言）、`notify`（`true` が既定、`false`、または `ListBlockErrorFailure` を受ける述語。投げた述語は `false` 扱い）。
  - 追加（型・値）: `ListBlockMessages`（`timeout`・`malformed`）と `defaultListBlockMessages`、`ListBlockNotify`（`notify` の型）。
  - 挙動の変更（`WindowedListResource`）: `getList` が投げた `ProviderError` は同じオブジェクトのまま `failures` に入る（`code: 'request'`。これまでも同じオブジェクトだった）。`ProviderError` でない値（`getDataProvider()` が投げた場合も）は、これまでの `ProviderError` の代わりに `ListBlockError('request')` に包む（`message` は従来どおり `String(thrown)`、投げた値は `cause`）。期限切れ・応答の形の不正は `ListBlockError`（`code` が `'timeout'`・`'malformed'`）になる（既定の `message` は従来と同じ）。`getList` が投げた `ListBlockError` は自分の `code` のまま入る。`WindowedListResource` が自分で `'boundaryMismatch'` を作ることは無い。
  - 共通の型にした理由: 2 つのリソースは同じ「ブロックの失敗」を出すので、アプリは `isListBlockError()` と `code` の 1 つの見分け方でどちらの失敗も扱える。`requestFailure`（投げた値の扱い）・文言の解決・`notify` の判定は `blockFetch.ts` の 1 か所に寄せた（`SnapshotListResource` にあった実装を共有にした）。`WindowedListError` を別に作ると、同じ形のクラス・型・判定関数が 2 組になり、`ProviderError` を投げ分けるデータソース（同じ取得関数を両方で使う場合など）で `code` の保ち方が食い違う。
  - admin-template: 商品一覧のサーバーモード（`ItemsServerGrid.svelte`）は `messages` に Paraglide の文言（新しいキー `items.loadTimeout`・`items.malformedResult`、ja/en）を渡し、読み込み失敗の帯を `failures` が空でないときに出す（以前は `error`。トーストの文言が英語の固定文だった）。
  - 派生アプリへの影響: 経路 A は `WindowedListResource` の `failedBlocks`・`error` と、名前を変えた 4 つ（`SnapshotListError`・`isSnapshotListError`・`SnapshotListFailureCode`・`SnapshotListErrorFailure`）を使っている箇所がコンパイルエラーになるので、`failures`・`ListBlockError`・`isListBlockError`・`ListBlockFailureCode`・`ListBlockErrorFailure` に置き換える（`error.name === 'SnapshotListError'` で見分けている箇所はコンパイルエラーにならないので検索して直す）。banto-industrial は `WindowedListResource` を使っておらず、名前の変更の影響は `isSnapshotListError` → `isListBlockError`（banto-hub と ChronoGazer のテスト 3 ファイル）だけ（`SnapshotListMessages`・`SnapshotListFailure` はそのまま）。経路 B は商品一覧（`src/routes/(app)/items/ItemsServerGrid.svelte`）と `messages/{ja,en}.json` の 2 キーを写す。経路 C は変更なし（DB・設定の変更は無い）。

## [5.1.0] - 2026-10-07

**v5.1.0 — banto-server の CSP の `connect-src` を広げる選び方に、接続元と要求の宛先（authority）の両方がループバックの要求だけを選ぶ `request_is_loopback_local` を足した（#349、banto-industrial#505 の続き）。同じホストのリバースプロキシ配下でも、アプリ自身のデスクトップシェルの要求だけを広げられる。版の種類: minor（追加のみ。後方互換）。
派生アプリへの影響: 経路 A は任意（自分のデスクトップシェルが自分の HTTP の画面を開くアプリは、`extra_connect_src_when` の選び方を `request_is_loopback_local` に替えることを推奨）。経路 B・C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | 任意 | `v5.0.0` → `v5.1.0`（npm と Rust を同じタグに）。`banto-server` に `request_is_loopback_local` を追加（追加のみ）。banto-hub などは `extra_connect_src_when(request_from_loopback_peer)` を `extra_connect_src_when(request_is_loopback_local)` に替える（同じホストのプロキシ配下でも LAN の閲覧者は厳格なままになる） |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                                                                                                                                                                                                |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                                                                                                 |

### 消費側への注意

- `request_is_loopback_local` は、プロキシが `Host` を上流のアドレスに書き換える設定では効かない（Caddy の `header_up Host {upstream_hostport}` など）。詳細は下の「その他」の安全性の項。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `076c6a7`、`workflow_dispatch`）: [run 37497619879](https://github.com/tyaro/banto/actions/runs/37497619879)（success）。
  - タグの push（`v5.1.0`）: [run 37497813180](https://github.com/tyaro/banto/actions/runs/37497813180)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- feat(banto-server): セキュリティヘッダーの CSP の `connect-src` を広げる選び方に、接続元と要求の宛先（authority）の両方がループバックの要求だけを選ぶ `request_is_loopback_local` を足した（banto-industrial#505 の続き、2026-10-06 オーナー決定）。版の種類: minor（追加のみ。後方互換。v5.1.0 で出す）。v5.0.0 の `request_from_loopback_peer` だけでは、banto-hub の運用手引きが勧める同じホストの Caddy（`reverse_proxy 127.0.0.1:8722`）の配下ですべての要求の接続元がループバックになり、LAN の閲覧者への応答も広がっていた。
  - 追加: `request_is_loopback_local(&Request) -> bool`。`request_from_loopback_peer` が真で、かつ宛先が `127.0.0.0/8`・`[::1]`・IPv4 射影のループバック（`[::ffff:127.0.0.1]`）の IP リテラルか `localhost`（大文字小文字は区別しない）のときだけ真。宛先は `Host` ヘッダーと URI の authority（HTTP/2 の `:authority`、HTTP/1.1 の絶対形式）から読み、片方だけならそれ、両方あれば一致（大文字小文字は区別しない）が条件で、食い違い・どちらも無い・`Host` が複数・解釈できない（ポートが空や数字以外、閉じていない `[`、userinfo など）は偽（厳格なまま）。`localhost.`（末尾のドット）と `*.localhost` は受け付けない（シェルは自分が bind したアドレスへ移るので要らず、受け付ける名前が増えるほどプロキシ経由の要求がローカルに見える道が増えるため）。`X-Forwarded-Host`・`Forwarded` は見ない。`request_from_loopback_peer` はそのまま残す。
  - 安全性: `Host` は相手が決められるので、それだけで広げる理由にはしない。接続元のループバックとの AND なら狭める方向にしか働かない。ブラウザは移った URL から `Host` を付けるので、`Host` を保つ同じホストのプロキシ（Caddy の既定）経由の LAN の閲覧者は公開名や LAN のアドレスを出して厳格なまま、デスクトップシェルは `http://127.0.0.1:<port>` へ移るので広がる。`Host` を偽る相手は、自分が受け取る応答の CSP を変えるだけ（ただし共有キャッシュが `Host` をまたいで応答を使い回さない前提。下の「共有キャッシュ」を参照）。残る注意: プロキシが `Host` を上流のアドレスに書き換える設定（Caddy の `header_up Host {upstream_hostport}`、nginx の既定の `proxy_set_header Host $proxy_host` で `proxy_pass` が `127.0.0.1`・`localhost` を指す場合）では効かないので、`Host` を保つ（nginx は `proxy_set_header Host $host`）か、広げる設定を入れないか、プロキシで CSP を上書きする。共有キャッシュ: nginx の `proxy_cache`＋`proxy_cache_valid` を明示的に有効にし、公開名とループバックの `Host` を同じ location で受けると、既定の `proxy_cache_key`（`$scheme$proxy_host$request_uri`）は受け取った `Host` を含まないので、`Host: 127.0.0.1` 向けに広がった応答が公開名の閲覧者へ返りうる（banto の静的 HTML は `Cache-Control`・`Vary` を付けない）。共有キャッシュを前段に置かないか、受け取った `Host` ごとに分ける（`proxy_cache_key` に `$host` を含める）。公開側では想定外の `Host` を拒否するか、プロキシで CSP を厳格な値に上書きする（nginx のキャッシュは既定で無効、Caddy の標準構成は影響なし）。詳しくは `security_headers.rs` 冒頭の doc と spec §11.2。
  - 派生アプリへの影響: 経路 A は、自分のデスクトップシェルが自分の HTTP の画面を開くアプリ（banto-industrial の banto-hub など）で `extra_connect_src_when(request_from_loopback_peer)` を `extra_connect_src_when(request_is_loopback_local)` に替える（同じホストのプロキシ配下でも LAN の閲覧者は厳格なままになる）。シェルが `127.0.0.1`・`[::1]`・`localhost` 以外の名前（例: LAN の IP）で自分の画面を開く場合は広がらないので、ループバックのアドレスで開く。経路 B・C は変更なし。

## [5.0.0] - 2026-10-06

**v5.0.0 — `SnapshotListResource` の失敗を、種類（コード）で見分けられ、文言を差し替えられ、トーストを止められ、全ブロック分を見られる形に変えた（#342。破壊的変更）。あわせて、banto-server の CSP の `connect-src` の拡張（#345）、`BASE_PATH` 付きビルドのナビの修正（#332）、docs の `design/`・`reviews/` への移動（#312）、外部利用 fixture の前提の記載（#337）、CI の `verify:migrations`（#339 P1）。版の種類: major（`SnapshotListResource` の `error`・`failedBlocks`・`SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE` の削除）。
派生アプリへの影響: 経路 A は `SnapshotListResource` を使っている箇所を `failures`・`code`・`messages` に置き換える。経路 B は監査ログ画面などコピー済みの利用箇所の取り込みが要る。経路 C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                             |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v4.0.0` → `v5.0.0`（npm と Rust を同じタグに）。`SnapshotListResource` の `error`・`failedBlocks`・`SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE` を削除（`failures`・`messages`・`notify` に置き換え）。`banto-server` に `with_security_headers_using` など（追加のみ） |
| B. コピーしたテンプレート        | あり | 監査ログ画面（`SnapshotListResource` の利用箇所。`messages` と新しい Paraglide キー）、`BASE_PATH` のナビの修正（#332）、CSP の照合テスト `core/tests/tauri_window_csp.rs`（#345）。詳細は下の「その他」の各項                                                   |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                                          |

### 消費側への注意

- 移行の手順書（docs/upgrading.md の例）は v5.0.0 では用意しない（オーナー決定 2026-10-06）。下の「変更」の `SnapshotListResource` の項（削除・追加・置き換え先）に従う。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `3419112`、`workflow_dispatch`）: [run 37397240508](https://github.com/tyaro/banto/actions/runs/37397240508)（success）。
  - タグの push（`v5.0.0`）: [run 37397380175](https://github.com/tyaro/banto/actions/runs/37397380175)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- feat(banto-server): セキュリティヘッダーの CSP の `connect-src` を、要求ごとに広げられるようにした（banto-industrial#505、2026-10-06 オーナー決定）。アプリ自身のデスクトップシェルが Tauri の WebView でこのサーバーの HTTP の画面へ移ると、その画面には窓の CSP ではなく応答の CSP（`connect-src 'self'`）が掛かり、Tauri IPC（`http://ipc.localhost`）の fetch が止められる（banto-industrial の banto-hub シェルの `/status` で、読み込みのたびに違反が 2 件出ていた。Tauri が postMessage に切り替えるので動作はしていた）。既定の `with_security_headers` は変えていない。
  - 追加: `with_security_headers_using(router, SecurityHeaders)`。`SecurityHeaders::new()` が既定の厳格な CSP で、`extra_connect_src(sources)` で connect-src に足す（`Result<_, InvalidCspSource>`。空・`;`・`,`・空白・制御文字・ASCII 以外は組み立ての時点で拒む）。`extra_connect_src_when(selector)` を付けると、選ばれた要求の応答にだけ足す（付けなければすべての応答）。広げられるのは connect-src だけで、ほかのディレクティブと 3 つのヘッダーは変わらない。
  - 追加: `request_from_loopback_peer`（TCP の接続元がループバックかを `ConnectInfo<SocketAddr>` から見る選び方。無ければ厳格なまま）、`TAURI_IPC_CONNECT_SRC`（`ipc:`・`http://ipc.localhost`）、`CONTENT_SECURITY_POLICY` を公開し、`SecurityHeaders::content_security_policy()` で広げた後の値をそのまま取れるようにした（窓の CSP と比べるテストで、文字列の置き換えが要らない）。
  - 安全性: 普通のブラウザが広げた CSP を受け取っても、`ipc:` は扱えない scheme なので何も起きず、`http://ipc.localhost` は閲覧者自身のループバックの 80 番（http）と 443 番（https。CSP では http の source が https にも一致し、省略した port は接続先 scheme の既定 port に一致する）を指すだけ（外部への持ち出し先にはならない）。それでも LAN のブラウザは厳格なままにするため、`request_from_loopback_peer` で選ぶのを推奨する。リクエストのヘッダー・クエリ・`Host` は相手が決められるので選ぶ材料にしない。詳しくは `security_headers.rs` 冒頭の doc と spec §11.2。
  - admin-template: 窓の CSP（`src-tauri/tauri.conf.json`）を、上の API で作った「応答の CSP ＋ Tauri IPC」と文字列で照合するテスト `core/tests/tauri_window_csp.rs` を足した（`verify-architecture.mjs` rule 12 のディレクティブ単位の検査はそのまま）。admin-template 自身のサーバーの組み立ては変えていない（窓は Tauri のアセットを表示し、HTTP の画面へは移らないため）。
  - 派生アプリへの影響: 経路 A は不要（既定は同じ）。自分のデスクトップシェルが自分の HTTP の画面を開くアプリ（banto-industrial の banto-hub など）は、`with_security_headers(app)` を `with_security_headers_using(app, SecurityHeaders::new().extra_connect_src(TAURI_IPC_CONNECT_SRC)?.extra_connect_src_when(request_from_loopback_peer))` に替える。窓の CSP を比べるテストは、`connect-src 'self'` の置き換えをやめて `content_security_policy()` を使える。注意: 同じホストのリバースプロキシ（ADR-0003 の TLS 終端など）がループバック経由でこのサーバーへつなぐ構成では、すべての要求の接続元がループバックになるので、`request_from_loopback_peer` は LAN のブラウザへの応答も広げてしまう（LAN の閲覧者の画面に注入されたスクリプトから、その閲覧者自身の端末の 80 番（http）と 443 番（https。理由は上と同じ）に届くようになる）。その構成では広げる設定を入れない（シェルは postMessage で動き、残るのは CSP の違反の報告だけ）か、プロキシがループバック以外のアドレスからつなぐようにする。`X-Forwarded-For` などの転送ヘッダーで選ぶのも、プロキシが上書きしない限り相手が決められるので不可。経路 B は、admin-template の CSP の照合テストを写すなら `core/tests/tauri_window_csp.rs` をコピーする。経路 C は変更なし（DB・設定の変更は無い）。

- feat(admin-core, admin-template)!: **破壊的変更（v5.0.0 で出す）** `SnapshotListResource` の失敗を、種類（コード）で見分けられ、文言を差し替えられ、トーストを止められ、全ブロック分を見られる形にした（#342、[ADR-0015 の追記](docs/adr/0015-snapshot-list-resource.md)）。オーナー決定（2026-10-06）により後方互換は保たず、互換用の別名は残さない。`WindowedListResource` は変えていない（同じ形にそろえるのは別 Issue。既定の英語の文言は `blockFetch.ts` で共有した）。
  - 削除: `SnapshotListResource` の `error`（最新の失敗 1 件）と `failedBlocks`、定数 `SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE`。
  - 追加（状態）: `failures: readonly SnapshotListFailure[]`。ブロック順・ブロックごとに 1 件で、`{ block, kind: 'error', code, error }` か `{ block, kind: 'expired' }`。消える条件は従来の `failedBlocks` と同じ（そのブロックの取得の成功、`setParams()`、縮んだ件数の外）。`expired`（今の世代が止まっている）は残した。
  - 追加（型・値）: `SnapshotListFailureCode`（`'request'`・`'timeout'`・`'boundaryMismatch'`・`'malformed'`）、`SnapshotListError`（`ProviderError` の派生、`code` を持つ）と `isSnapshotListError`、`SnapshotListFailure`・`SnapshotListErrorFailure`・`SnapshotListExpiredFailure`、`SnapshotListMessages` と `defaultSnapshotListMessages`。
  - 追加（オプション）: `messages`（`timeout(ms)`・`boundaryMismatch()`・`malformed()`。リソースが自分で作る失敗の文言。関数で受け取り、既定は今の英語の文言。関数が投げたら既定の文言）、`notify`（`true` が既定、`false`、または `SnapshotListErrorFailure` を受ける述語。投げた述語は `false` 扱い。失効は従来どおり通知しない）。
  - 挙動の変更: 取得関数が投げた `ProviderError` は同じオブジェクトのまま `failures` に入る（`code: 'request'`。アプリの派生クラスの情報が残る）。`ProviderError` でない値は、これまでの `ProviderError` の代わりに `SnapshotListError('request')` に包む（`message` は従来どおり `String(thrown)`、投げた値は `cause`）。期限切れ・境界の食い違い・応答の形の不正は `SnapshotListError`（`code` 付き）になる（既定の `message` は従来と同じ）。取得関数が投げた `SnapshotListError` は自分の `code` のまま入る。
  - admin-template: 監査ログ画面は `messages` に Paraglide の文言（新しいキー `audit.loadTimeout`・`audit.boundaryMismatch`・`audit.malformedResult`、ja/en）を渡し、失敗の表示を `failures` の最も前のブロックの `'error'` から出す（以前は英語の固定文がそのまま出ていた）。
  - 派生アプリへの影響: 経路 A は `failedBlocks`・`error`・`SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE` を使っている箇所がコンパイルエラーになるので、`failures`・`code`・`messages` に置き換える（文言のための期限の二重掛けや文字列比較は要らなくなる）。経路 B は監査ログ画面（`src/routes/(app)/audit-log/+page.svelte`）と `messages/{ja,en}.json` の 3 キーを写す。経路 C は変更なし（DB・設定の変更は無い）。

- fix(admin-template): `BASE_PATH`（Pages のデモ）を付けたビルドでも、サイドバーの選択表示・ページ見出し・ナビのバッジが合うようにする（#332）。base を含まない表のパス（`/dashboard`）と base 込みの `page.url.pathname`（`/banto/dashboard`）を直接比べていたため、デモでは一致しなかった。比較を `isPathActive(path, pathname)`（新設 `src/lib/appPath.ts`、`navigation.ts` が再エクスポート）に一本化し、表のパスを `resolveAppPath()` で base 込みにしてから比べる（公開ビューアのガード・設定カテゴリの選択も同じ関数に寄せた）。base が空なら従来と同じ挙動。派生アプリへの影響: 経路 A は不要。経路 B は `navigation.ts` / `Sidebar.svelte` / `navBadges.svelte.ts` をコピーしているなら、新設の `appPath.ts` も一緒にコピーする（`base` を使わない派生アプリでは挙動は変わらない）。
- docs(fixture): 外部利用 fixture の `pnpm check` は、ルートで `pnpm install` 済みでないと `playwright.config.ts` の `@playwright/test` を解決できず失敗する（CI は先にルートを入れるので通る）。前提を docs/upgrading.md 8.3 と fixture の tsconfig.json に明記した。fixture に `@playwright/test` は足さない（2 つ入ると Playwright が二重読み込みで落ちるため）。
- docs(layout): 設計文書 8 本を `docs/` 直下から `docs/design/` へ移動した（#312 の design/ への移動。ファイル名は不変なので `attachments-plan §3.7` のようなラベル参照はそのまま有効）。コード・scripts・CI・docs 内の参照は同じ PR で新パスに更新済み。ただしリリース済みの migration（`apps/admin-template/core/migrations-sqlite/0006_attachments.sql` と `migrations-postgres/0006_attachments.sql`）のコメントは旧パス `docs/attachments-plan.md` のまま残す。SQLx は migration 本文をコメント込みで checksum して DB に記録するため、コメント 1 行の書き換えでも v4.0.0 以前に作った DB が `VersionMismatch(6)` で起動しなくなる。旧パスの残存検索ではこの 2 ファイルを既知の例外として扱う（リリース済み migration の書き換えは新設の `pnpm verify:migrations` が CI で検出する）。過去の節に書かれた旧パスは書き換えない。GitHub 上の旧 blob リンクは追従しない（スタブは置かない）。`.prettierignore` に `docs/design/*.md` を追加（移動前と同じく整形対象外）。旧 → 新の対応表:

  | 旧パス                              | 新パス                                     |
  | ----------------------------------- | ------------------------------------------ |
  | `docs/attachments-plan.md`          | `docs/design/attachments-plan.md`          |
  | `docs/display-preset-plan.md`       | `docs/design/display-preset-plan.md`       |
  | `docs/report-plan.md`               | `docs/design/report-plan.md`               |
  | `docs/scaffold-presets-plan.md`     | `docs/design/scaffold-presets-plan.md`     |
  | `docs/session-controller-design.md` | `docs/design/session-controller-design.md` |
  | `docs/viewer-public-plan.md`        | `docs/design/viewer-public-plan.md`        |
  | `docs/visual-refresh-design.md`     | `docs/design/visual-refresh-design.md`     |
  | `docs/visual-refresh-plan.md`       | `docs/design/visual-refresh-plan.md`       |

- docs(layout): レビュー・調査記録 4 本を `docs/` 直下から `docs/reviews/` へ移動した（#312 の reviews/ への移動。ファイル名は不変なので `M-review 2026-08 §2.1`・`CR-N`・`AD-N`・`choiapp-feedback-2026-09 §3.2` のようなラベル参照はそのまま有効）。コード・scripts・CI・docs 内の参照は同じ PR で新パスに更新済み。過去の節に書かれた旧パスは書き換えない。GitHub 上の旧 blob リンクは追従しない（スタブは置かない）。`.prettierignore` に `docs/reviews/*.md` を追加（移動前と同じく整形対象外）。旧 → 新の対応表:

  | 旧パス                                   | 新パス                                           |
  | ---------------------------------------- | ------------------------------------------------ |
  | `docs/choiapp-feedback-2026-09.md`       | `docs/reviews/choiapp-feedback-2026-09.md`       |
  | `docs/feature-review-2026-08.md`         | `docs/reviews/feature-review-2026-08.md`         |
  | `docs/maintainability-review-2026-07.md` | `docs/reviews/maintainability-review-2026-07.md` |
  | `docs/maintenance-review-2026-08.md`     | `docs/reviews/maintenance-review-2026-08.md`     |

## [4.0.0] - 2026-10-05

**v4.0.0 — SvelteKit 3（`@sveltejs/kit` 3・`@sveltejs/adapter-static` 4）と TypeScript 6（`^6.0.0`）への移行（#325）、配線①のナビゲーション待ちの修正（#326）、docs の誤った spec 参照の修正（#312 PR-B）。版の種類: major（破壊的変更。`@banto/*` の中身は変わらないが、peer の前提が SvelteKit 3・TypeScript 6 に変わる）。
派生アプリへの影響: 経路 A は依存の範囲（`@sveltejs/kit` ^3・`@sveltejs/adapter-static` ^4・`typescript` ^6.0.0）を合わせる。経路 B はコピーしたテンプレートを SvelteKit 3 の形に移す作業が要る（`npx sv migrate sveltekit-3 --tasks all --confirm` の後に写すもの、見直すものがある。下の「消費側への注意」と docs/upgrading.md の例 4）。経路 C は変更なし。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v3.0.1` → `v4.0.0`（npm と Rust を同じタグに）。`@banto/*` の中身は変わらない（theme の `./css` の型の追加を除く）が、peer の前提が変わる: `@sveltejs/kit` ^3・`@sveltejs/adapter-static` ^4・`typescript` ^6.0.0（7 は kit 3 の対象外）。Rust（`banto-*`）は版数のみ                                                                                                        |
| B. コピーしたテンプレート        | あり | `vite.config.ts`（`svelte.config.js` を廃止して設定を移す）・`tsconfig.json`・`package.json` の `imports`（`#lib`。拡張子必須）・`navigation.ts` の `AppPath` / `resolveAppPath`・`(app)/+layout.ts` の閲覧公開のガード。自動移行の `resolve('')`・`.slice(1)` を見直す。#326 の `navigationSettled.svelte.ts` と配線①。`@banto/theme/css` の `declare module` はもう要らない |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                                                                                                                                                                                                       |

### 消費側への注意

- 経路 A・B とも SvelteKit 3 への移行が前提になる。手順は [docs/upgrading.md](docs/upgrading.md) の「例 4（v3.0.x → v4.0.0）」（経路 A/B/C、`sv migrate sveltekit-3` の後に写すもの、自動移行の `resolve('')`・`.slice(1)` の見直し）に従う。
- SvelteKit 2 に留まる派生アプリは v3.0.x のままにする（v4.0.0 の `@banto/*` は kit 3 を前提にする）。#326 の修正だけが欲しい場合は、経路 B の `navigationSettled.svelte.ts` と配線①の写しを v3.0.1 のまま取り込める（詳細は「修正」の #326 の項）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `4df169c`、`workflow_dispatch`）: [run 37272937503](https://github.com/tyaro/banto/actions/runs/37272937503)（success）。
  - タグの push（`v4.0.0`）: [run 37273113295](https://github.com/tyaro/banto/actions/runs/37273113295)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 3.0.0                          |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | TypeScript         | 6.0.3                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte・TypeScript は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`（runner に入っていた 1.98.1 から更新された後の版）。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- docs: コード内のコメントにある誤った `spec §3.x` 参照（実体は `attachments-plan` / `report-plan` の節）を
  `attachments-plan §N` / `report-plan §N` に修正した（Rust・TS・Svelte・CSS・e2e のコメントのみ、動作変更なし、#312 PR-B）
- docs: SvelteKit 3 の形に合わせた（#325 PR3）。conventions §5 の機械検査の対象を `#lib`（旧 `$lib`）に、§13 の例を `#lib/paraglide/messages.js` にし、現役の docs・README・コード内のコメントの `$lib` を `#lib` にした（`docs/history/` と ADR・設計記録の当時の記述は凍結のまま）。`docs/architecture-flows.md` の再 load を `refreshAll()` に。`docs/upgrading.md` に v3 → v4 の移行手順（例 4。経路 A/B/C、`sv migrate sveltekit-3` の後に写すもの、自動移行の `resolve('')`・`.slice(1)` の見直し）と、確認する組み合わせに SvelteKit `^3.0`・TypeScript `^6.0` を足した

### 変更

- feat(admin-template)!: **破壊的変更** テンプレートを SvelteKit 3（`@sveltejs/kit` 3.0・`@sveltejs/adapter-static` 4.0）と TypeScript 6（`^6.0.0` に固定。7 は kit 3 の対象外）に上げた（#325 PR1）。`svelte.config.js` を廃止して設定を `vite.config.ts` の `sveltekit({...})` に移し、`$lib` を `#lib`（package.json の `imports`。拡張子が必須）に、`base` を `resolve()` に置き換えた。ナビ・設定カテゴリの表の `path` は `AppPath`（`` `/${Path}` ``）で型付けし、URL にするときは `resolveAppPath()`（`src/lib/navigation.ts`）を通す。自動移行（`sv migrate sveltekit-3`）が閲覧公開のガード（`(app)/+layout.ts`）を `resolve('')`（kit 3 では `base + '/'`）で書き換え、全画面が最初の項目へ戻される（その項目自身でリダイレクトのループ）不具合は直し、単体（`guard.test.ts`）と E2E（public-viewer）で押さえた。非推奨の `invalidateAll`・`error(status, { message })` は #325 PR3 で置き換えた（下の項）。
  - 派生アプリへの影響: **経路 A** の `@banto/*`・`banto-*` は、この項では中身の変更なし（packages の devDependency の `typescript` だけ。theme の型の追加は下の #325 PR3 の項）。**経路 B** はコピーしたテンプレートを kit 3 の形に移す: `npx sv migrate sveltekit-3 --tasks all` を流したうえで、この版の `vite.config.ts`・`tsconfig.json`・`package.json` の `imports`・`navigation.ts` の `AppPath` / `resolveAppPath`・`(app)/+layout.ts` の閲覧公開のガードを写す。自動移行が入れる `resolve('')` や ``resolve(`${path}`.slice(1))`` は必ず見直す。TS 6 は副作用 import を検査するが、`@banto/theme/css` の型は theme が持つようになった（下の #325 PR3 の項）ので、TS から `import '@banto/theme/css'` していても宣言は要らない（v3.x に合わせて自前で置いた `declare module '@banto/theme/css'` は外してよい）。経路 C（DB・設定）は変更なし。
- feat(theme): `@banto/theme/css` の型を theme 自身に持たせた（#325 PR3）。`./css` の export に `types` 条件（`src/css/banto.css.d.ts`、`export {};` だけの空のモジュール）を先頭で足し、`default` は従来どおり CSS。TypeScript 6 の副作用 import の検査（`noUncheckedSideEffectImports`）に対して、利用する側が `declare module` を足さずに `import '@banto/theme/css'` できる。架空の default export やクラス名の型は作らない（実行時の挙動は変えない）。型の解決は `moduleResolution: "bundler"`（kit 3 の `$app/tsconfig` の既定）が前提。外部利用 fixture の `src/ambient.d.ts` は外した（既定状態の fixture は v4.0.0 のタグ後に ref を上げるまでローカルの check が通らない。docs/publishing.md）。
  - 派生アプリへの影響: **経路 A**（theme をタグで上げるだけ。自前の `declare module '@banto/theme/css'` は残っていても害はなく、外してよい）。
- refactor(admin-template): kit 3 で非推奨になった API を置き換えた（#325 PR3）。`$app/navigation` の `invalidateAll()` → `refreshAll()`（`routes/+layout.svelte` の起動待ちのやり直し、`routes/+error.svelte` の「再試行」、`(app)/+layout.svelte` の配線①、`settings/SecuritySection.svelte` の認証設定の保存後）、`error(status, { message, …})` → `error(status, message, { … })`（`#lib/banto/startupGate.ts`・`(app)/+layout.ts`）。kit 3.0 の `refreshAll()` は `invalidateAll()` と同じ `_invalidate()` を通り、違いは `page.state` を消さないことだけ（テンプレートは shallow routing を使わない）。`error()` が投げる本体（`{ status, message, startupPending? }`）も同じ。#326 の `isNavigationSettled()` と #321 の起動待ちのやり直しの条件はそのまま。`@banto/admin-core` の同名の `invalidateAll()`（一覧の再取得の通知）は SvelteKit の API ではないので変えていない。
  - 派生アプリへの影響: **経路 B のみ**。コピーしたテンプレートで同じ置き換えをする（`invalidateAll` は import と呼び出しの名前を変えるだけ。shallow routing の `page.state` を使っている派生アプリは、`refreshAll()` では消えなくなる点だけ確かめる）。
- ci: SvelteKit 3 への移行に合わせた（#325 PR3）。`external-consumer.yml` の PR の paths から廃止した `apps/admin-template/svelte.config.js` を外し（`vite.config.ts` は既に対象）、`deploy-demo.yml` のコメントの `svelte.config.js` を `vite.config.ts` に。`ci.yml` の audit ジョブにあった cookie 0.6.0（GHSA-pxg6-pf52-xh8x、#282）の据え置きの記録を外した: kit 3 で cookie 2.0.1 になり、`pnpm audit`（全依存）は 0 件（2026-10-05 確認）

### 修正

- fix(scripts): scaffold の削除パターン・display の置き換えを SvelteKit 3 の書き方（`#lib`、`.ts` の import は `.js` 付き、`resolve()`）に合わせ、削除パターンが見つからないときに黙って「適用済み」にせず失敗するようにした（初回の適用のみ。工程の印が既に消えている再実行は従来どおり冪等。#325 PR2）。経路 B（scaffold を再実行する派生のみ）。
- fix(admin-template): ナビゲーションの途中でセッションの世代が変わると（別のタブでのログイン・Remember me の切り替え、バックグラウンドで確定した失効など）、移動が失われ、その後の未保存の変更の確認が効かなくなる問題を修正（#326、#321 の続き）。`(app)/+layout.svelte` の配線①（世代が変わったら `invalidateAll()` で確定し直す）がナビゲーションの途中に当たると、SvelteKit 2.70 はそのナビゲーションを途中で終わらせ（URL は元の画面のまま）、内部の「ナビゲーション中」の印を残すため、次のナビゲーションで `beforeNavigate` が呼ばれなかった。配線①は、ナビゲーションが終わるまで（最初のナビゲーションの `afterNavigate` の後、かつ `navigating.to === null`）やり直しを待つ。この判定は新しい `src/lib/banto/navigationSettled.svelte.ts` にまとめ、#321 のルートのレイアウトのやり直しと共有する。世代が変わったら確定し直す本来の動き・ログアウト中（`isLeavingForLogin()`）の抑止は従来どおり。SvelteKit 側の同じ現象は [sveltejs/kit#17114](https://github.com/sveltejs/kit/issues/17114)（3 系の開発版で修正。2.70 には入っていない）。E2E: smoke `13j`（項目の画面から一覧への移動を止めている間に別のタブでログインし直す → 移動が完了し、未保存の確認が出る）。単体: `src/lib/banto/navigationSettled.test.ts`。
  - 派生アプリへの影響: **経路 B のみ**（A の `@banto/*`・`banto-*` と C の DB・設定は変更なし）。配線①をコピーしている派生アプリ（banto-industrial など）は、この修正の入った版の admin-template から次を写す: `src/lib/banto/navigationSettled.svelte.ts`（新規）、`src/routes/+layout.svelte`（`trackFirstNavigation()` の呼び出しと、起動待ちのやり直しの条件を `isNavigationSettled()` に）、`src/routes/(app)/+layout.svelte`（配線①の `$effect` に `if (!isNavigationSettled()) return;`）。#321 を取り込んでいない派生アプリも、ルートのレイアウトで `trackFirstNavigation()` を 1 回呼ぶ（配線①の判定に最初のナビゲーションの終わりが要るため）。

## [3.0.1] - 2026-10-05

**v3.0.1 — 保護画面を直接開いたときのスプラッシュと再接続の修正（#321）と依存の更新。版の種類: patch（後方互換の修正のみ。公開 API の追加・削除・改名は無い）。
派生アプリへの影響: 経路 A はタグの更新だけで済む。保護ルートのガードで `await bantoReady` している派生アプリは、コピーしたテンプレートの 5 ファイルの取り込みが要る（経路 B）。DB・設定の変更は無い。**

| 経路                             | 影響 | 内容                                                                                                                                                                                           |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v3.0.0` → `v3.0.1`（npm と Rust を同じタグに）。版数のみ（API 変更なし）。tauri 2.12.1（#318）など依存の更新は workspace 内で完結する                                                         |
| B. コピーしたテンプレート        | あり | #321: `src/lib/banto/startupGate.ts`（新規）・`setup.ts`・`app.d.ts`・`routes/+layout.svelte`・`routes/(app)/+layout.ts`。保護ルートの子の load は `await parent()` してから provider に触れる |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                                                        |

### 消費側への注意

- 経路 A はタグを上げるだけでよい。経路 B は、保護ルートのガードで `await bantoReady` している派生アプリだけが対象（詳細は「修正」の #321 の項）。取り込まなくても動くが、サーバーに届かない間に保護画面を直接開くと真っ白のままになる従来の挙動が残る。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `7eea5bc`、`workflow_dispatch`）: [run 37245443236](https://github.com/tyaro/banto/actions/runs/37245443236)（success）。
  - タグの push（`v3.0.1`）: [run 37245561619](https://github.com/tyaro/banto/actions/runs/37245561619)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 2.70.3                         |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他

- **chore(security)（依存監査・JavaScript 側）**: lockfile の変更なし（依存追加・overrides なし）。2026-10-04 時点の `pnpm audit` は low 1 件（cookie 0.6.0、GHSA-pxg6-pf52-xh8x）のみ、`pnpm audit --prod` は 0 件、informational は 0 件。issue 時点の high 2 / moderate 1（brace-expansion 5.0.9）は main で既に 5.0.12 に更新済み（9cb0f5d）。残る cookie は開発依存（@sveltejs/kit 2.70.3 の `cookie ^0.6.0`。adapter-static の配布物に含まれる経路は確認していない）で、0.7.0 以降へは @sveltejs/kit 3.0.0（`cookie ^2.0.1`、typescript ^6 を peer に要求）への移行が必要なため据え置き。根拠と再検討条件は `.github/workflows/ci.yml` の audit ジョブのコメントに記録。dependabot #320（npm-minor-patch 8 件）は @sveltejs/kit・cookie を含まないため、この件とは重複せず、解消にも寄与しない（#282）。
- docs: 文書整理の第 1 弾（#312 PR-A）。`.cargo/audit.toml`・`.gitattributes`・`.githooks/pre-commit` と
  `docs/history/improvements.md` に残っていた旧パス・壊れた相対リンクを修正し、industrial-plan・maintenance-review
  の状態行を実態に合わせ、AGENTS（ja/en）に文書の寿命ルール、roadmap §7 に状態行更新の 1 行を追加。

- chore(deps): 依存の更新。tauri 2.12.1（#318、cargo minor-patch）、taiki-e/install-action（#319）、npm の minor-patch 8 件（#320）。

### 修正

- fix(admin-template): ログインが必要な画面（`(app)` の配下）を直接開いたとき、サーバーに届かない間は真っ白のままで再接続もできなかった問題を修正（#321、#286 の続き）。ガードの `load` が `await bantoReady` で起動判定を待ち、初回の load が終わらないため SvelteKit がルートのレイアウト（スプラッシュ）も描かなかった。ガードは起動判定を待たず、終わっていなければ provider にもセッションにも触れる前に起動待ちの印付きの 503（`startupGate.ts` の `deferUntilStarted`、`App.Error.startupPending`）を投げる。子の load はすべて `await parent()` なので、保護画面の load とコンポーネントは起動判定とセッションの確定より前に動かない。ルートのレイアウトはこの印のあいだエラー画面ではなくスプラッシュ（「起動中…」→「サーバーに接続できません」＋再接続）を出し、起動判定が終わり、その印を出したナビゲーションが終わってから `invalidateAll()` でガードをやり直す（同じ URL が開く。ナビゲーションの途中でやり直すと SvelteKit 2.70 の `beforeNavigate` が以後呼ばれなくなり、未保存の変更の確認が効かなくなるため）。demo への誤判定（#286）・Tauri・demo ビルド・閲覧公開の grant・セッション確認の 503 の再試行は従来どおり。E2E: smoke `13a2`・public-viewer `2a`（`/api` を止めて保護画面を直接開く → 再接続 → その画面に入る）。
  - 派生アプリへの影響: **経路 B のみ**（A の `@banto/*`・`banto-*` と C の DB・設定は変更なし。`resolveStartupTarget`/`startupState` の API も変えていない）。保護ルートのガードで `await bantoReady` している派生アプリは、この修正の入った版（v3.0.0 の次）の admin-template から次を写す: `src/lib/banto/startupGate.ts`（新規）、`src/lib/banto/setup.ts`（`isBantoReady()`）、`src/app.d.ts`（`App.Error.startupPending`）、`src/routes/+layout.svelte`（スプラッシュの継続とやり直し）、`src/routes/(app)/+layout.ts`（`await bantoReady` を `deferUntilStarted(isBantoReady(), …)` に）。保護ルートの子の load は `await parent()` してから provider・セッションに触れること（テンプレートはすべてそうなっている）。単体テストは `src/lib/banto/startupGate.test.ts`・`src/routes/(app)/guard.test.ts`。

## [3.0.0] - 2026-10-04

**v3.0.0 — 資格情報なしのセッション発行を grant に一本化（ADR-0017）。版の種類: major（破壊的変更。閲覧公開専用の API・URL・フィールドと `SessionController.adopt()`/`end()` を削除し、互換用のラッパ・エイリアスは残さない）。
派生アプリへの影響: 経路 A（`@banto/admin-core`・`banto-server`・`banto-admin-services`）の追従と、それを呼ぶ経路 B（コピーした `rest.rs`・保護レイアウト・ログイン画面・e2e）の書き換えがセット。A だけ上げると型エラーになる。DB の移行は無い。**

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v2.1.1` → `v3.0.0`（npm と Rust を同じタグに）。`banto-server`（grant の型・ルーター・`AuthState`/`AuthenticatedSession` の変更）、`banto-admin-services`（`delete_user` の引数・`has_admin`）、`@banto/admin-core`（`grantFallback`・`enterGrant`・`Identity.kind`、`adopt()`/`end()` の削除）。他は版数のみ                                                        |
| B. コピーしたテンプレート        | あり | `apps/admin-template/core/src/rest/mod.rs`（`GrantRegistry` の組み立てと `extra_auth_router` の新シグネチャ）、`src-tauri/src/lib.rs`（`revoke_grant_tokens`・`delete_user`）、`src/routes/(app)/+layout.ts`・`src/routes/login/+page.svelte`・`src/lib/session.svelte.ts`、`e2e/`、`scripts/verify-architecture.mjs`。手本は v3.0.0 の admin-template の同名ファイル |
| C. DB・設定・配布資産            | なし | マイグレーション・設定キーの追加は無い（`server.viewer_public` は従来どおり閲覧公開の条件として使う）                                                                                                                                                                                                                                                                 |

### A. 共通パッケージ・クレート — 削除した公開 API と移行先（ADR-0017「削除するもの」）

| 削除                                                                                    | 置き換え                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/public-viewer`                                                          | `POST /api/auth/grant/publicViewer`（`grant_router`。未登録の kind は 404、条件 false・peer 不可・世代不一致は 403）                                                                            |
| `GET /api/auth/status` の `viewerPublic`                                                | `grants: { publicViewer: bool, … }`（`GrantRegistry::availability(peer)`。status と発行で同じ判定）                                                                                             |
| `GET /api/auth/identity` の `publicViewer`                                              | `kind`（`"publicViewer"` / アプリの kind / `"account"`）                                                                                                                                        |
| `AuthenticatedSession.public_viewer: bool`                                              | `AuthenticatedSession.grant: Option<GrantKind>`                                                                                                                                                 |
| `AuthState::issue_public_viewer_token()` / `revoke_public_viewer_tokens()`              | `grant_generation(&kind)` → 判定 → `issue_grant_token(&GrantSpec, GrantGeneration) -> Option<String>` / `revoke_grant_tokens(&GrantKind) -> usize`（世代で直列化。「条件の保存 → revoke」の順） |
| `MAX_PUBLIC_VIEWER_SESSIONS`                                                            | `GrantSpec.max_sessions`（既定 `DEFAULT_GRANT_MAX_SESSIONS` = 256、kind ごとの FIFO）                                                                                                           |
| `extra_auth_router(users, auth, audit, allow_setup, settings, extras)`                  | `extra_auth_router(users, auth, audit, allow_setup, Arc<GrantRegistry>, extras)`（`grant_router` を内包。テンプレートは `GrantSpec::public_viewer(settings)` を登録）                           |
| `UsersService::delete_user(id, acting_user_id: i64)`                                    | `delete_user(id, acting_user_id: Option<i64>)`（`None` は検証済み grant セッションだけ。最後の admin 禁止は維持）。追加: `UsersService::has_admin()`                                            |
| `publicViewerFallback(controller, provider, ticket)` / `DEFAULT_PUBLIC_VIEWER_RETRIES`  | `grantFallback(controller, provider, ticket, { kind: 'publicViewer', available?, maxRetries? })` / `DEFAULT_GRANT_RETRIES`                                                                      |
| `AuthProvider.enterPublicViewer(options?)` / `status().viewerPublic`                    | `enterGrant(kind, options?)` / `status().grants`（HTTP provider は無ければ `{}`）                                                                                                               |
| `Identity.publicViewer` / TS `PUBLIC_VIEWER_ID`                                         | `Identity.kind`（発行元の印。`kindOfResolvedAuth` は `identity.kind` を最優先）                                                                                                                 |
| `sessionOwnerKey` の `public-viewer` と adopt の `${kind}:${id}`                        | grant kind 単独のキー（`publicViewer`・`commissioning`。保存状態の owner が 1 回変わる）                                                                                                        |
| `SessionController.adopt()` / `end()`、epoch だけの `SessionTicket`、「adopt 中」の分岐 | `grantFallback` + provider の答え（S-42 の経路）。`ticket()` は常に `{ epoch, revision }`                                                                                                       |
| `verify-architecture` rule 8 `REST_ONLY` の `POST /api/auth/public-viewer`              | `POST /api/auth/grant/{kind}`                                                                                                                                                                   |

- 追加（Rust、`banto-server`）: `grant` モジュール — `GrantKind`（`[A-Za-z][A-Za-z0-9_-]{0,31}`、`account`/`local` は予約語）・`GrantSpec`（固定 identity・要求ごとの条件・`max_sessions`・`policy`・`require_loopback_peer`）・`GrantRegistry`（登録時に予約語・重複・`max_sessions == 0` を拒否、`availability(peer)`）・`grant_router`・`GrantGeneration`・`is_loopback_peer`。grant セッションはアカウント照合（ADR-0014）を飛ばし、`change-password` を拒否し、SSE の再検証は `revoke_grant_tokens` の後の次の再検証でストリームを閉じる。peer 不明は拒否（status では `false`、発行では 403）。IPv4 射影 IPv6 の loopback も loopback に数える。
- 追加（TS、`@banto/admin-core`）: `grantFallback`・`DEFAULT_GRANT_RETRIES`・`GrantFallbackOptions`・`GrantStatus`、`AuthProvider.enterGrant`。
- 競合テスト（ADR の必須項目）: `auth.rs` の `an_issuance_parked_before_the_insert_loses_to_a_revocation_that_completed_meanwhile`（閲覧公開・任意 kind）、`grant.rs` の `an_issuance_parked_between_the_judgment_and_the_insert_loses_to_a_revocation`（実ルート）。
- 派生アプリの移行手順: [docs/upgrading.md 例 3](docs/upgrading.md#例-3-v21x--v300grant-への一本化a-と-b-がセット破壊的変更)（経路 A/B/C の組み立て）、[ADR-0017「v3.0.0 への移行手順」](docs/adr/0017-credential-less-grant.md)（banto-hub・chronogazer の書き換え箇所）。試運転を grant にする派生アプリは `require_loopback_peer: true`・小さい `max_sessions` を既定にし、同一ホストのリバースプロキシ配下の運用条件（ADR-0017 §6 の 2 点）を導入手順に書く。

### 消費側への注意

- A だけ上げると型エラーになる（削除した API を B のコピーが呼ぶ）。A と B を同じ作業で終え、`docs/upgrading.md` の例 3 の順（A → B → 検証用 DB で起動 → 本番）で進める。DB の移行は無いので、戻すときは依存タグと B のコピーを戻せばよい。
- 閲覧公開（`publicViewer`）を使わない派生アプリも、`SessionController.adopt()`/`end()` を呼んでいれば追従が要る（`grantFallback` + provider の答えへ）。
- 保存状態の `owner` が 1 回変わる（`sessionOwnerKey` の形が変わるため）。初回起動で「別のユーザーでログインされました」が出ないかを確認する。

### セキュリティ（v3.0.0）

- あり。認証なしで通る要求が `POST /api/auth/grant/{kind}` の 1 本に縮み、派生アプリの独自の認証迂回を無くせる（ADR-0017）。影響する利用形態: LAN 公開・閲覧公開・派生アプリの試運転。修正は A（`banto-server`）と B（コピーした `rest.rs`）の両方。admin 相当の grant を `require_loopback_peer: false` で LAN bind に載せない（注意点 2）。リバースプロキシ配下では peer が常にプロキシなので、外部公開の前にロックダウンし、`/api/auth/grant/{kind}` をプロキシから外へ出さない（README「リバースプロキシでのTLS終端」）。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `f0dcece`、`workflow_dispatch`）: [run 37133897926](https://github.com/tyaro/banto/actions/runs/37133897926)（success）。
  - タグの push（`v3.0.0`）: [run 37134004905](https://github.com/tyaro/banto/actions/runs/37134004905)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 2.70.3                         |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### ドキュメント

- docs(adr): ADR-0017「資格情報なしのセッション発行は grant に一本化し、閲覧公開を 1 種類目・派生アプリの試運転を 2 種類目にする」を追加（2026-10-02 オーナー決定、2026-10-03 のレビュー #313 で細目を決定し、後方互換を捨てて **v3.0.0（major）** で一本化する形に改訂。実装は v3.0.0 の PR）。閲覧公開専用の API・URL・フィールド（`/api/auth/public-viewer`、`viewerPublic`、`identity.publicViewer`、`issue_public_viewer_token` など）と `SessionController.adopt()`/`end()` を v3.0.0 で削除し、移行手順を ADR に記載、session-controller-design.md §4.7・§6.2・I-13・I-21 と viewer-public-plan.md に注記。

## [2.1.1] - 2026-10-02

**v2.1.1 — 試運転セッションへの切り替えで誤通知が出る問題（#308）の修正。版の種類: patch（後方互換の修正のみ。公開 API の追加・削除・改名は無い）。
派生アプリへの影響: `@banto/admin-core` を取り込めば解消する。コピーしたテンプレートや DB・設定の変更は無い。**

| 経路                             | 影響 | 内容                                                                                                                                                   |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v2.1.0` → `v2.1.1`（npm と Rust を同じタグに）。`@banto/admin-core` のみ後方互換の修正（#308、`SessionController` の owner 変化の判定）。他は版数のみ |
| B. コピーしたテンプレート        | なし | 変更なし                                                                                                                                               |
| C. DB・設定・配布資産            | なし | 変更なし（DB のマイグレーション・設定キーの追加は無い）                                                                                                |

### 消費側への注意

- banto-hub など `adopt` で commissioning（試運転）を使う派生アプリは、経路 A（`@banto/admin-core` を v2.1.1 に）だけで取り込める。`ownerChange.ts` などコピー側の変更は不要。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `34e65bd`、`workflow_dispatch`）: [run 37005359727](https://github.com/tyaro/banto/actions/runs/37005359727)（success）。
  - タグの push（`v2.1.1`）: [run 37005850859](https://github.com/tyaro/banto/actions/runs/37005850859)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 2.70.3                         |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### 修正

- fix(admin-core): 試運転（`kind: 'commissioning'`、アプリが `adopt()` で確定する合成セッション）への切り替えで「別のユーザーでログインされました」が出ないようにした（#308、S-108。#291 の続き）。`SessionController` は owner の変化を比べる対象を `kind === 'account'` の active だけにした（v2.1.0 までは `publicViewer` と `local` だけを列挙して除外していた）。`account` 以外の active（`publicViewer`・`local`・`commissioning`・今後増える kind）は `pendingOwnerChange` を立てず、最後の具体的な owner も更新しない。`kind` を持たない provider の答えは従来どおり `account` として比べる。本物の別ユーザーへの切り替え（account A → account B）は従来どおり通知する。派生アプリ（banto-industrial の banto-hub など）への取り込み: 経路 A のみ（`@banto/admin-core` を新しいタグへ。`ownerChange.ts` などコピー側の変更は不要）。経路 B の変更は無い。DB・設定の移行なし。

## [2.1.0] - 2026-10-02

**v2.1.0 — レビュー起票分（#277〜#291）の修正とセキュリティ強化。版の種類: minor（後方互換の公開 API 追加 + 消費側に影響する挙動変更）。
派生アプリへの影響: 依存タグの更新だけでも取り込める修正が大半。ただし（1）バックアップの保存先が変わる（#280）、（2）静的ホスティングでデモを公開するアプリはビルド時の設定を推奨（#286）、（3）Excel 向け CSV は opt-in の指定を推奨（#281）。DB の移行は無い。**
公開 API の追加（`toCsv` の `formulaSafe`、`@banto/admin-core` の `invalidateAll`・`InvalidateReason`、`banto_server::bind`・`BoundServer`・`AuthState::revoke_public_viewer_tokens`、`banto_admin_services::settings::auth_server_combination_allowed`・`validate_server_config`・`users::bound_username_for_audit`）はすべて後方互換。
バックアップの保存先の変更（#280）は API の削除・改名を伴わない運用上の挙動変更なので、[publishing.md のバージョニング規約](docs/publishing.md#バージョニング規約)に今回明文化した「2.x 以降の運用上の変更」に従い、消費側の移行手順（下の「消費側への注意」）を明記した上で `minor` とする（旧ファイルは削除せず残るため、手動で移せば失われない）。

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v2.0.0` → `v2.1.0`（npm と Rust を同じタグに）。`@banto/admin-core`（`invalidateAll`・`InvalidateReason`・購読コールバックの `reason`、`kind: 'local'` を owner の変化の判定から除外）、`@banto/grid-svelte`（`toCsv` の `formulaSafe`）、`banto-server`（SSE 中の `stop()`、`bind`・`BoundServer`、`AuthState::revoke_public_viewer_tokens`）、`banto-admin-services`（初回セットアップ・ログインのスロットル・監査・バックアップ・設定の検証）、`banto-attachments`（サムネイル更新失敗）は後方互換の追加・修正。他は版数のみ |
| B. コピーしたテンプレート        | あり | 起動時の判定（`environment.ts`・`startup.ts`・`StartupSplash.svelte`・`+layout.svelte`、#286）、items 画面（CSV 出力・行単位の保存の直列化・詳細間の遷移、#281・#284・#290）、ナビのバッジ（`navBadges`、#289）、設定の LAN 適用（`serverAdmin.ts`・`ConnectivitySection.svelte`・`src-tauri` の `server_apply`、#287・#288・#294）、`src-tauri` のログイン失敗の監査（`login_body`、#278）。いずれも取り込まなくても動くが、取り込むと修正が入る（セキュリティ関連は推奨）                                                      |
| C. DB・設定・配布資産            | あり | DB のマイグレーションは無い（SQLite・PostgreSQL とも）。設定キーの追加は無い。**SQLite のバックアップ・リストア予約の保存先が変わる（#280。依存タグの更新で入り、旧配置のファイルは自動では引き継がれないので手動で移す）**。デモ配信のビルドは `VITE_BANTO_DEMO=1` を推奨（#286）。`src-tauri/Cargo.toml` にテスト用の dev-dependency（`sqlx`）が増えた（既にグラフ内）                                                                                                                                                         |

### 消費側への注意（必ず確認）

1. **バックアップの保存先が変わった（#280、経路 A・C。本体は `banto-admin-services` の `backup.rs` のみで、コピー側の本番コードの変更は無い）。** SQLite のバックアップ・適用前の安全バックアップ・リストア予約は、DB ファイルごとの
   `<DBの親フォルダ>/backups/<DBファイル名>/`（予約は同ディレクトリの `restore-pending.sqlite3`）へ分離した。**旧共有領域**（`backups/` 直下の `*.sqlite3`・
   親フォルダ直下の `restore-pending.sqlite3`）の既存バックアップ・予約は、所属 DB を判断できないため**一覧に出ず、取得できず、自動適用もされない**
   （削除もしない。起動時に stderr へ警告）。引き続き使うバックアップは新ディレクトリへ**手動で移す**こと。
   手順は [README「SQLite バックアップの保存先」](README.md)。暫定回避策として DB ごとに親フォルダを分ける運用も有効。PostgreSQL は従来どおりバックアップ非対応。
2. **静的ホスティング（GitHub Pages 等）でデモを公開する派生アプリは、ビルド時に `VITE_BANTO_DEMO=1` を設定することを推奨**（#286、経路 B）。
   未設定でも静的ホストの明確な 404 応答で従来どおり demo になる。一方、Tauri・LAN 配信のビルドでは、接続失敗を demo とみなさなくなった（「サーバーに接続できません」画面で再試行する）。
   本リポジトリの `deploy-demo.yml` は設定済み。
3. **Excel 向けの CSV を出力する派生アプリは `toCsv(..., { formulaSafe: true })` を推奨**（#281、経路 A・B。`formulaSafe` は A。items のエクスポートでの有効化は B で、admin-template では有効化済み）。
   既定の出力は不変。再インポート（`parseCsv`）では先頭の `'` が値に残る。Windows 11 + Microsoft 365 の Excel で、数式が評価されず文字列として開かれることを確認済み（#303）。Excel で開くと先頭の `'` はセルに表示されたまま残る。
4. **invalidate の購読コールバックに `(resource, reason)` が渡るようになった**（#289・#297、経路 A）。既存の引数なしコールバックは互換（そのまま動く）。
   ナビの未読バッジ・通知を `onInvalidate` で自作している場合は、`reason === 'resync'`（SSE 再接続後の再取得）を無視すること
   （実変更なしの再接続でバッジが増えるのを防ぐ）。admin-template の `navBadges.noteInvalidation` が手本。
5. **#291（ログイン不要モードの有効化・役割変更で「別のユーザーでログインされました」が出る）は `@banto/admin-core` を上げるだけで取り込める**（経路 A のみ。`ownerChange.ts` などコピー側の変更は不要、経路 B・C の変更は無い）。
6. **セキュリティ修正（#277・#278・#279・#280・#281・#283）は下の「セキュリティ」を参照。** #277・#279・#280・#283 は経路 A（`banto-*` を同じタグに。#280 は加えて C の手動移行）で入る。#278 は A に加え、`src-tauri` の `login_body`（失敗ログインの `actor_username` の切り詰め）が B。
   REST と Tauri の両方を持つアプリは、`src-tauri` の `login_body` のコピー側も確認すること。
7. **LAN 設定の適用**（#287・#288・#294、経路 A・B。#283 の SSE 中の停止は A のみ）: `banto_server::start` は互換のまま、`bind` / `BoundServer::serve` を足した。デスクトップの `server_apply` を自前で持つ派生アプリは、
   「新 listener の bind 成功 → 設定保存 → serve 開始」の順に取り込むこと（失敗時に保存値・実稼働・表示が食い違わない）。認証無効 + LAN 有効 + 閲覧公開の許可判定は
   `auth_server_combination_allowed` に一本化したので、独自に同じ判定を書いている場合はこれへ寄せる。
8. 経路 A の更新で依存の lockfile も更新するとよい（`devalue`・`brace-expansion` の修正版、`event-listener`・`spin`。#282・#295）。

### A. 共通パッケージ・クレート

- 対象:
  - `@banto/admin-core`: `invalidateAll()` と型 `InvalidateReason` を追加・export（#289）。購読コールバックが `(resource, reason)` を受ける（既存の引数なしは互換、#297）。
    `createSseEventProvider` の購読フックに `onReconnected` を追加（#289）。`SessionController` は `kind === 'local'` を owner の変化の判定から外す（#291）。
  - `@banto/grid-svelte`: `toCsv` に opt-in の `formulaSafe`（#281）。
  - `banto-server`: `bind` / `BoundServer` の追加（`start` は互換、#294）、`AuthState::revoke_public_viewer_tokens`、SSE 接続中でも完了する `RunningServer::stop()`（#283）、未認証ログアウトの監査抑止（#278）、ログインの同時検証の上限（#279）。
  - `banto-admin-services`: `settings::auth_server_combination_allowed`・`validate_server_config`（#288・#294）、`users::bound_username_for_audit`（#278）、初回セットアップの原子化（#277）、バックアップの保存先の分離（#280、挙動の変更）。
  - `banto-attachments`: サムネイルの `has_thumbnail` 更新失敗を補助処理の失敗として扱う（#285）。
  - 他の `@banto/*`（attachments・charts・dock-svelte・forms・report・scan-wedge・theme・tree-svelte）と `banto-core`・`banto-storage` は版数のみ。
- 更新: `v2.0.0` → `v2.1.0`（npm と Rust を同じタグに）。
- 追従: 型エラーになる変更は無い。追従が要るのは上の「消費側への注意」1（C の手動移行）・4・7。
- 依存を上げずに留まれるか: できる（`v2.0.0` に固定したままなら従来どおり動く。ただしセキュリティ修正は入らない）。

### B. コピーしたテンプレート

- 対象ファイル・ルート:
  - 起動: `apps/admin-template/src/lib/banto/environment.ts`（`probeBackend`・`isDemoBuild`）・`startup.ts`・`startupState.svelte.ts`・`setup.ts`、`src/lib/components/StartupSplash.svelte`、`src/routes/+layout.svelte`、`messages/{ja,en}.json`（`app.startup.*`）（#286）。
  - items: `src/routes/(app)/items/+page.svelte`・`ItemsClientGrid.svelte`・`ItemsServerGrid.svelte`・`rowSaveQueue.ts`・`[id]/+page.svelte`、`src/routes/(app)/+layout.svelte`（`{#key}` に params、#290）。
  - ナビのバッジ: `src/lib/navBadges.svelte.ts`（#289）。
  - 設定の LAN 適用: `src/lib/banto/serverAdmin.ts`・`src/routes/(app)/settings/ConnectivitySection.svelte`（#287）、`src-tauri/src/lib.rs`（`server_apply`・`start_embedded_server`・`login_body`、#278・#287・#288・#294。#277・#279・#280・#283・#285 の `src-tauri` 側はテストのみで本番コードの変更は無い）。
- 関連 PR: #299（#286）、#298（#284）、#303（#281）、#300（#290）、#297（#289）、#296（#291。テンプレートの変更なし）、#294（#287・#288。#283 は A のみ）、#292（#277）、#293（#278・#279）、#302（#280）、#301（#285）。
- 手で取り込む変更: 上の「消費側への注意」2・3・4・6（`login_body`）・7。
- 派生側の独自変更と衝突しやすい箇所: `src-tauri` の `login_body`・`server_apply`、起動時の demo 判定（`isEmbeddedServer` の独自利用）、`onInvalidate` で作ったバッジ。
- 取り込まなくても動くか: 動く（A だけ上げても動く。ただし B 側のセキュリティ関連（#278 の `src-tauri` の `login_body`・#281 の items の CSV）の修正は入らない）。
- 手本: admin-template の同名ファイル。

### C. DB・設定・配布資産

- マイグレーション: 不要（スキーマの変更は無い。SQLite・PostgreSQL とも）。
- 追加された設定キー: なし。
- 戻せる条件: DB に変更が無いので、依存タグとコピー部分を戻せば戻せる。ただし #280 の新構成で作成したバックアップは新ディレクトリにあるため、旧構成へ戻すと見えない。
- 設定キー・配布物: SQLite のバックアップ・リストア予約の保存先が変わる（#280）。デモ配信のビルドに `VITE_BANTO_DEMO=1` を設定（#286）。配布する `tauri.conf.json` の変更は版数のみ。
- 順序: A・B を先に完成 → 検証用 DB で起動（旧バックアップがある場合は stderr の警告を確認して手動で移す）→ 本番。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（画面が描画されること。静的デモを公開するアプリは `VITE_BANTO_DEMO=1` を付けたビルドで demo が出ること）。
2. バックアップ: 作成・一覧・取得・リストア予約が新ディレクトリで動くこと。旧配置のファイルが残っていれば移すこと。
3. Excel 向け CSV: 先頭が `=` `+` `-` `@` の文字列を含むデータで、出力の先頭に `'` が付くこと。
4. LAN 設定: 設定画面で LAN を有効・無効にし、失敗時に表示が実際の状態と一致すること。
5. Rust: `cargo check` / `cargo test`。

### セキュリティ

アプリ固有のコードには、既知の CVE を直接修正する変更はない。一方、依存関係では公開 advisory への更新を含む（`devalue` の GHSA-j22f-vq7h-c4qm / GHSA-mcm9-63f2-9j32 / GHSA-x5rw-q4pp-hg5g、`brace-expansion`、`event-listener` の RUSTSEC-2026-0221 等。#295・#282/#305。下の「依存の脆弱性」）。アプリ固有のコードでは、レビューで見つかった次の問題を修正した。LAN 公開・複数ユーザー・同じフォルダに複数 DB を置く運用のアプリは更新を推奨する。

- 初回セットアップの並行実行で複数の admin が作られる問題（#277。経路 A。`UsersService::setup_first_user` の空確認と INSERT を DB 側で原子化）。
- 未認証リクエストによる監査ログの増幅（#278。経路 A・B（`src-tauri` の `login_body`）。有効なセッションを終えない `POST /api/auth/logout` は記録しない、失敗ログインの `actor_username` は 32 文字で切り詰める）。
- 並行ログインが失敗確定前のスロットルを通過する問題（#279。経路 A。試行枠の事前予約と、IP 単位 4・全体 8 の同時検証数の上限）。
- 同じフォルダの複数 SQLite DB でバックアップ・リストア予約が共有され、他 DB のバックアップの閲覧や他 DB の次回起動での適用が起き得た問題（#280。経路 A・C。保存先を DB ごとに分離。**消費側への注意 1**）。
- Excel 向け CSV エクスポートの数式（CSV）インジェクション（#281。経路 A・B。`formulaSafe` は A、items のエクスポートでの有効化は B。**消費側への注意 3**）。
- SSE 接続が開いたままだと LAN サーバーの停止が終わらない問題（#283。可用性。経路 A）。
- 依存の脆弱性: `devalue` の high 3 件ほか・`brace-expansion`（#282・#295）、`event-listener`（RUSTSEC-2026-0221）・`spin`（yanked）（#282）。派生アプリは自分の lockfile でも更新するとよい。
- 推奨: A を上げ、B のうち #278（`login_body`）・#281（items の CSV）を取り込み、#280 は C の手動移行を行う。A だけ上げても、コピー済みのテンプレートの部分（B）の修正は入らない。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `463a097`、`workflow_dispatch`）: [run 36987799449](https://github.com/tyaro/banto/actions/runs/36987799449)（success）。
  - タグの push（`v2.1.0`）: [run 36989197884](https://github.com/tyaro/banto/actions/runs/36989197884)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 2.70.3                         |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### Fixed

- fix(auth): 初回セットアップ（`UsersService::setup_first_user`）の並行実行で複数の admin が作られる問題を修正（#277）。空確認と INSERT を DB 側で原子的にした（SQLite は条件付き単一 INSERT、PostgreSQL は `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE` + 条件付き INSERT）。負けた側は従来どおり「既に初期化されています」を返し、REST/Tauri とも成功監査・セッション発行は起きない。DB マイグレーション不要。
- fix(audit): 未認証リクエストによる監査ログの増幅を防止（#278）。有効なセッションを終えない `POST /api/auth/logout` は監査に記録しない。失敗ログインの `actor_username` は作成時の長さ上限（32 文字）まで切り詰め（末尾 `…`、REST・Tauri 共通）、上限超の username は DB を引かずダミー検証のみ行う。`banto_admin_services::users::bound_username_for_audit` を追加。
- fix(auth): 並行ログインが失敗確定前のスロットルを通過する問題を修正（#279）。verifier を await する前に試行枠を原子的に予約し、処理中の試行も失敗件数と同様にしきい値判定へ数える。IP 単位（4）・全体（8）の同時検証数上限を追加（超過は即時 `RateLimited`）。argon2 の検証は blocking プールで実行。
- fix(backup)（保存先の変更・消費側への注意）: 同一フォルダに複数の SQLite DB を置くと `backups/` と `restore-pending.sqlite3` が共有され、一方のバックアップが他方から一覧・取得でき、一方のリストア予約が他方の次回起動で適用され得た不具合を修正した（#280）。バックアップ・適用前の安全バックアップ・リストア予約を DB ファイルごとの `<親>/backups/<DBファイル名>/`（予約は `<親>/backups/<DBファイル名>/restore-pending.sqlite3`）へ分離し、作成・一覧・取得・予約・状態取得・取消・起動時適用の全てが `scope_dir` の1関数でディレクトリを解決する（REST / Tauri 共通。認可・denied・監査は不変）。**既存配置からの移行**: 旧共有領域（`backups/` 直下の `*.sqlite3`・親フォルダ直下の `restore-pending.sqlite3`）は所属 DB を判断できないため、一覧に出さず・取得させず・自動適用せず（削除もしない）、起動時に stderr へ警告する。必要なバックアップは新ディレクトリへ手動で移動すること（詳細は README「SQLite バックアップの保存先」）。暫定回避策は DB ごとに親フォルダを分けること。PostgreSQL は従来どおりバックアップ非対応。
- fix(security): items の Excel 向け CSV エクスポートで、利用者入力の文字列が数式として評価され得た問題（CSV インジェクション）に対処した（#281）。`@banto/grid-svelte` の `toCsv` に opt-in の `formulaSafe: true` を追加し、**文字列値**の先頭が `=` `+` `-` `@`・TAB・CR・LF・全角 `＝` `＋` `－` `＠` のとき先頭に `'` を付ける（数値・真偽値・null・ヘッダーは対象外）。既定の `toCsv` の出力は不変。items のエクスポート（REST / Tauri / demo 共通の `handleExport`。LAN ダウンロードと Tauri のフォルダ保存は同じ `csv` 文字列を使う）で有効化。注意: 再インポート（`parseCsv`）では先頭 `'` が値に残る。全ての CSV 利用方法に安全な方式ではなく Excel 系ソフト向けの緩和策。Windows 11 + Microsoft 365 の Excel で確認済み（既定出力は `HasFormula=True`、`formulaSafe` では `HasFormula=False`。#303 のコメント）。
- LAN サーバーのライフサイクル修正（#283 / #288 / #287）:
  - `banto-server`: SSE 接続が開いたままでも `RunningServer::stop()` が完了する（サーバ停止シグナルを SSE ストリームへ伝え、安全網として5秒で待ちを打ち切りタスクを中断）。公開 API の変更なし。
  - `banto-admin-services`: 認証無効/LAN 有効/閲覧公開の許可判定を `auth_server_combination_allowed` に一本化し、保存時（`set_server_config`/`set_auth_config`）と起動時で共有（閲覧公開ありの構成が再起動後も LAN 起動する）。`set_server_config` の4キー保存を1トランザクション化し、保存せず検証だけ行う `validate_server_config` を追加。
  - デスクトップ `server_apply`: 新サーバーの bind 成功を確認 → 設定保存 → serve 開始の順で適用し（保存完了までは新 listener がリクエストを受け付けない。`banto-server` に `bind` / `BoundServer::serve` を追加、`start` は互換）、失敗時は未保存のまま旧サーバーを復帰して失敗を監査（`settings_change` / `failed`）。閲覧公開を OFF にする適用の成功時は発行済みの公開閲覧トークンを失効（`AuthState::revoke_public_viewer_tokens`）。最終検証・保存・トークン失効は `auth_config_lock` の下で行い（ロック順は `state.server` → `auth_config_lock`）、認証設定の変更との並行実行で禁止組合せが成立しないようにした。設定画面は失敗後に実際の状態を再取得する（失敗が `[object Object]` と表示される問題の修正を含む、#287）。
- fix(startup): 起動時の一時的な API 接続失敗で実データ用画面が demo モードになる問題を修正（#286）。配信形態と通信状態を分離した: Tauri は従来どおり、意図したデモは `VITE_BANTO_DEMO=1` ビルド（GitHub Pages ワークフローで設定）または静的ホストの明確な 404 応答、実サーバー配信は Banto の応答で判定する。ネットワーク例外・timeout（`PROBE_TIMEOUT_MS`=5s）・Banto 形式でない 5xx（プロキシの HTML 503 等）は demo にせず、上限付き自動再試行（2 回）の後「サーバーに接続できません」画面（再接続ボタン）で待機し、復旧後は実データ provider で初期化する。`environment.ts` に `probeBackend` / `isDemoBuild`、`startup.ts`（純粋な解決ロジック）、`StartupSplash.svelte`、i18n キー `app.startup.*` を追加。派生アプリで Pages 等へ静的デモを公開する場合はビルド時に `VITE_BANTO_DEMO=1` を設定すること。
- fix(admin-core): 変更通知 SSE が切れて再接続した後、切断中に他端末が更新したデータが次の変更通知まで古いまま残る問題を修正（#289）。`createSseEventProvider` の購読フックに `onReconnected`（切断後の再接続成功ごとに1回。初回接続・401/トークン消失/再ログイン後の最初の接続・接続中にトークンが変わった場合は呼ばない）を追加し、`connectEvents` がこれを受けて購読中の全リソースを `resource_changed` と同じ経路で1回ずつ再取得（`invalidateAll()` を新設・export）。セッション終了（`none`）後は再取得しない。サーバー側の履歴再送はしない。`SnapshotListResource` は invalidate 購読を持たないため境界は変わらない。再同期は `invalidate(resource, 'resync')`（新型 `InvalidateReason`、既定 `'change'`、購読コールバックは `(resource, reason)` を受ける）で流し、アプリ層のナビ未読バッジ（`navBadges.noteInvalidation`）は `'resync'` を数えない（実変更なしの再接続でバッジが増えない）。派生アプリで `onInvalidate` を使いバッジ・通知を自作している場合は `reason === 'resync'` を無視すること。
- fix(admin-core): ログイン不要モード（`kind: 'local'` の合成セッション）の有効化・役割の変更で「別のユーザーでログインされました」が出ないようにした（#291、S-107）。`SessionController` は `kind === 'local'` の active を、公開閲覧（S-93）と同じく owner の変化の判定の対象外にし、最後の具体的な owner も更新しない。本物の別ユーザーへの切り替えは従来どおり通知する。派生アプリへの取り込み: 経路 A（`@banto/admin-core` を新しいタグへ。`ownerChange.ts` などコピー側の変更は不要）。経路 B の変更は無い。DB・設定の移行なし。
- fix(items): 商品詳細から別の商品詳細へクライアント遷移（`/items/2` → `/items/1` など同一ルート内の移動）すると、URL だけが切り替わり、フォーム・添付・保存先 ID が直前の商品のまま残り、誤った商品へ保存され得た不具合を修正した（#290）。SvelteKit は同一ルートの別パラメータ間でページコンポーネントを再利用する（`params` が更新されるだけ）ため、`(app)/+layout.svelte` の `{#key}` にルート params を含めて ID ごとにページを作り直す（旧 ID の load 応答は破棄され、未保存変更ガードも従来どおり働く）。回帰 e2e smoke 3f を追加。
- fix(items): 同じ行へ続けて貼り付け/inline 編集すると、後続の保存が古い行スナップショットから全列を送り、先行保存の列を巻き戻す問題を修正（#284）。保存を行 id ごとの直列キュー（`rowSaveQueue.ts`）に集約し、実際の送信直前に直前の確定値へ今回の変更列だけを合成する。失敗した保存は自分の呼び出し元にのみ伝わり、後続は確定値を基に続行する。client / server グリッド共通（ページ側ハンドラ）。
- fix(attachments): 画像添付の本体・メタデータ保存後にサムネイルの `has_thumbnail` DB 更新だけが失敗すると upload 全体がエラーになり、保存済みの添付が残ったまま REST / Tauri の成功監査・変更通知が抜ける問題を修正（#285）。この更新失敗はサムネイルのファイル書込失敗と同じく補助処理の失敗として扱い、警告ログ + 生成済みサムネイルの best-effort 削除のうえ `has_thumbnail = false` で成功を返す（SQLite / PostgreSQL 共通）。本体保存失敗時の行削除クリーンアップは従来どおり。DB マイグレーション不要。

### その他の変更

- chore(deps): `pnpm audit --prod --audit-level high` が新規公開の advisory（devalue の high 3件・moderate 2・low 1）で落ちていたため、ルート `pnpm-lock.yaml` の推移的依存 devalue を 5.9.4（修正版 5.9.3 以降）、brace-expansion を修正版へ更新した（lockfile のみ。`package.json` の変更・overrides の追加は無し。上流 svelte / @sveltejs/kit の範囲内で解決）。派生アプリへの影響なし。#282 の一部（#295）。
- chore(security)（依存監査・Rust 側）: lockfile のみ更新（依存追加なし）— `event-listener` 5.4.1→5.4.2（RUSTSEC-2026-0221 解消、`concurrent-queue` を除去）、`spin` 0.9.8→0.9.9（yanked 解消）。`.cargo/audit.toml` から、依存グラフに存在しなくなった RUSTSEC-2023-0071（rsa）の除外を削除。残存除外は quick-xml 0.39.4（RUSTSEC-2026-0194/0195、plist 1.9.0 が `^0.39.2` で固定、開発者管理の plist のみ処理）。除外なしの警告は glib 0.18.5（unsound）・proc-macro-error 1.0.4（unmaintained）の2件で、いずれも Linux の tauri→gtk 0.18 経由の上流制約（`cargo audit` は警告では失敗しない）。JS 側は `pnpm audit --prod` 0件、開発依存は cookie 0.6.0（low、@sveltejs/kit の上流待ち）のみ（#282、#305）。
- test(admin-template): `systemInfoStore` のテストを import-once にして、負荷時のタイムアウトを解消（#304）。
- docs(publishing): バージョニング規約に「2.x 以降の運用上の変更」を追記した。API の削除・改名を伴わない運用上の挙動変更は、移行手順を「消費側への注意」に明記した上でオーナー判断で `minor` としてよい（v2.1.0 の #280 に適用。#306）。

## [2.0.0] - 2026-10-01

**v2.0.0 — セッション確定の単一書き手化（SessionController）。版の種類: major（破壊的）。
派生アプリへの影響: 依存タグの更新だけでは済まない。旧セッション API の削除と `AuthProvider` の契約変更（A）に加え、
コピー済みのログインガード・ログアウト・503 画面などの取り込み（B）が必要。DB の移行は無い。**
詳細は下の「SessionController 実装-3」の節（削除した公開 API と移行先・挙動の互換性が変わる変更・派生アプリの移行の手順）と、
[upgrading.md 例 2](docs/upgrading.md#例-2-v17x--v200sessioncontroller-a-と-b-がセット破壊的変更)。

| 経路                             | 影響 | 内容                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 依存（`@banto/*`・`banto-*`） | あり | `v1.7.3` → `v2.0.0`（npm と Rust を同じタグに）。`@banto/admin-core` は破壊的変更（旧セッション API の削除、`AuthProvider` の `resolve`・`credentialRevision`・`onCredentialChanged` が必須）と一覧状態の保持 API の追加（#215）。`banto-server`・`banto-admin-services` は後方互換の追加・修正（#216 `lan_urls_for_bind`、#248 監査ログのスナップショット取得 `list_as_of`）。他は版数のみ |
| B. コピーしたテンプレート        | あり | `session.svelte.ts`、`(app)/+layout.ts`・`+layout.svelte`、ログイン・ログアウト、503 画面、`providers/demo.ts`、`src-tauri` の認証コマンド（#260・#264〜#266）。一覧の状態の保持（#215・#255）、LAN 接続先 URL の bind に応じた案内（#216）、監査ログ画面のスナップショット取得（#248）、items の CSV 取込プレビュー（#218）、パレット・ヘッダー検索（#258・#217）                          |
| C. DB・設定・配布資産            | あり | DB のマイグレーションは無い（既存の DB をそのまま使える）。設定キー `audit.deletion_epoch` の追加（#248。保持期間で削除したときに書かれ、無ければ 0 として扱う）。認証設定の更新経路の変更（`settings_set` の `auth.` キー拒否、`set_auth_config` の 4 キーを 1 トランザクションで書く）。Tauri のログイン不要モードの有効化・解除でセッションの挙動が変わる                                |

### A. 共通パッケージ・クレート

- 対象:
  - `@banto/admin-core`: 破壊的変更（SessionController、#260）。一覧の状態を保持する API の追加（#215・#255）。
  - `banto-server`: 後方互換の追加。`lan_urls_for_bind(bind, port)`（#216。bind に合う LAN の接続先 URL を返す。旧 `lan_urls(port)` は残るが、bind に合わない URL を案内しうるので `lan_urls_for_bind` へ移ることを推奨）。監査ログの一覧に `?asOfId=`（#248）。
  - `banto-admin-services`: 後方互換の追加。`AuditLogService::list_as_of`・`AuditLogList`・削除の epoch（設定キー `audit.deletion_epoch`。スキーマの変更は無い）（#248）。`SettingsService::is_auth_key`。
  - 他の `@banto/*`（attachments・charts・dock-svelte・forms・grid-svelte・report・scan-wedge・theme・tree-svelte）と `banto-core`・`banto-storage`・`banto-attachments` は版数のみ（charts・grid-svelte はテストの変更だけ）。
- 更新: `v1.7.3` → `v2.0.0`（npm と Rust を同じタグに）。
- 追従: 旧 API（`resolveProtectedSession`・`establishSession`・`beginSession`・`endSession`・`confirmSessionEnded` など）の
  呼び出しが型エラーになる。移行先は下の「削除した公開 API と移行先」の表。`AuthProvider` は `resolve`・`credentialRevision`・
  `onCredentialChanged` が必須（`initBanto`・`createSessionController` は欠けていると `TypeError`）。
  一時的に `adaptLegacyAuthProvider(...)` で包める（移行 PR に「adapter 使用中」と明記）。
- 依存を上げずに留まれるか: できる（`v1.7.3` に固定したままなら従来どおり動く。ただし #255 の一覧状態の所有者照合などの恩恵は受けられない）。

### B. コピーしたテンプレート

- 対象ファイル・ルート: `apps/admin-template/src/lib/session.svelte.ts`・`src/routes/(app)/+layout.ts`・`+layout.svelte`・
  ログイン・ログアウト（`Header.svelte`・コマンドパレット）・503 画面・`providers/demo.ts`、`src-tauri`（認証コマンド）、
  items の CSV 取込、コマンドパレット、ヘッダーの検索表示。一覧画面の状態の保持（#215・#255）、設定の接続先 URL の表示と `src-tauri` の `server_status`（#216）、監査ログ画面（#248）。
- 関連 PR: #260（#264・#265・#266）、#215（#255）、#216（#254）、#248（#256）、#218、#258・#217。
- 手で取り込む変更: 下の「派生アプリの移行の手順」1〜7。
- 派生側の独自変更と衝突しやすい箇所: 自前の `AuthProvider`（手順 7）、独自のセッション再確認（banto-hub の `sessionRecheck.ts` など）、
  独自の認証コマンドを持つ `src-tauri`（`settings_set` が `auth.` キーを拒否する）。
- 取り込まなくても動くか: 動かない（A を上げると旧 API を使うコピー済みコードが型エラーになる）。
- 手本: admin-template の同名ファイル。

### C. DB・設定・配布資産

- マイグレーション: 不要（スキーマの変更は無い）。
- 追加された設定キー: `audit.deletion_epoch`（#248。監査ログの保持期間による削除の世代。既存の settings テーブルに保存し、保持期間で削除したときに書かれる。無ければ 0 として扱う）。
- 戻せる条件: DB に変更が無いので、依存タグとコピー部分を戻せば戻せる。
- 設定キー・配布物: Tauri の設定画面でログイン不要モードを有効にすると、管理者のアカウントのセッションがその場でローカルユーザーに
  置き換わり、解除するとローカルユーザーのセッションが終わる（監査ログに `logout` が残る）。ログイン不要モード中の `auth_login`・`auth_setup`
  は拒否する。汎用の `settings_set` は `auth.` で始まるキーを拒否する（認証モードは `auth_config_apply`、自動ログインは
  `autologin_enable`／`autologin_disable`）。`set_auth_config` は 4 つのキーを 1 トランザクションで書く。
- 順序: A・B を先に完成 → 検証用 DB で起動 → 本番。

### 更新後の確認（この版に関係する範囲）

1. `pnpm check` / `pnpm build` / `pnpm dev`（demo 用の `AuthProvider` を持つアプリは白画面にならないこと）。
2. ログイン・ログアウト（ログアウト後に /login へ移る）、別タブでのログイン・ログアウト、503 画面の「再試行」。
3. Tauri: 設定画面のログイン不要モードの有効化・解除、役割の変更。
4. Rust: `cargo check` / `cargo test`。

### セキュリティ

公表済みの脆弱性の修正は無い。ただし、利用者の切り替え（同じブラウザ・同じ端末での別ユーザーのログイン）で情報が分離されない問題の修正を含むので、複数の利用者が同じ端末を使うアプリは更新を推奨する。

- 影響する利用形態: 同じブラウザや同じ端末で、複数のユーザーがログインする運用（共有 PC、Remember me、公開閲覧と併用する構成）。
- 前のユーザーの一覧の状態（並び・絞り込み）が、次のユーザーに残らないようにした（#255。経路 A と B）。
- 別のタブでユーザーが切り替わったら、このタブも保留して確認し直す。前のユーザーの表示が残らない（#257。経路 A と B）。
- 公開閲覧のトークンの発行が、応答待ちの間に済んだ別のログインのトークンを上書きしないようにした（#259。経路 A）。
- コマンドパレットの「最近使った項目」をユーザーごとに分けた。開いたままユーザーが切り替わったらパレットを閉じる（#258。経路 B）。
- Tauri: 汎用の `settings_set` は `auth.` で始まるキーを拒否する。ログイン不要モードの間は `auth_login`・`auth_setup` でアカウントのセッションを作らない（経路 B の `src-tauri`）。
- 推奨: A と B の両方を取り込む。A だけ上げても、コピー済みのテンプレートの部分（B）の修正は入らない。

### 検証した組み合わせ

- 外部利用（Git 依存 + dev 起動）の検証: タグを打つ前に main の SHA で `external-consumer.yml` を `workflow_dispatch` し、
  タグの push の run でも確認した。[upgrading.md 8.3](docs/upgrading.md#83-候補-commitリリースタグの検証手順)。
  - タグ前（main の `dc61fc1`、`workflow_dispatch`）: [run 36873119458](https://github.com/tyaro/banto/actions/runs/36873119458)（success）。
  - タグの push（`v2.0.0`、`check-versions --tag`）: [run 36873338314](https://github.com/tyaro/banto/actions/runs/36873338314)（success）。
  - 2 つの run の版は同じ（ubuntu-latest、ログの install 行と toolchain 行から取った）:

    | 項目               | 版                             |
    | ------------------ | ------------------------------ |
    | Node.js            | 24.21.0                        |
    | pnpm               | 10.33.0                        |
    | Svelte             | 5.57.1                         |
    | SvelteKit          | 2.70.3                         |
    | Vite               | 8.3.1                          |
    | vite-plugin-svelte | 7.3.1                          |
    | Rust               | 1.99.0（b940084d7 2026-09-28） |

  - 出所: Node.js は `node: v24.21.0`、pnpm は `Successfully updated pnpm to v10.33.0`、Svelte・SvelteKit・Vite・vite-plugin-svelte は fixture の `pnpm install` の出力（`+ svelte 5.57.1` など）、
    Rust は `Setup Rust toolchain` の `rustc 1.99.0`。step summary の表はログに出ないため、同じ値を持つこれらの行を読んだ。

### その他の変更

- chore(deps): tauri 2.11.5 → 2.12.0・tauri-build・thiserror 2.0.21・window-vibrancy 0.8.1（Cargo の minor-patch グループ、#267）。
- 外部利用 fixture の CI（#271）、items の CSV 取込プレビュー（#218）、コマンドパレットの最近使った項目のユーザー別化（#258）・
  ヘッダー検索の文言（#217）。詳細は以降の項目。

- ci(release): 外部利用 fixture を CI 化した（#271）。`fixtures/external-consumer/`（最小の SvelteKit と最小の crate）に
  `@banto/*` を `github:tyaro/banto#<sha>&path:packages/<x>`、`banto-*` を `git` + `rev` で導入し、
  `.github/workflows/external-consumer.yml` が `vite dev` をブラウザ（Playwright）で開いて描画を確かめたうえで
  `pnpm check`・`pnpm build`・`cargo check`（`--all-features` も）を流す。PR は head SHA（同じリポジトリのブランチ
  だけ、`packages/**`・`crates/**` 等を変えたとき）、`workflow_dispatch`、リリースタグの push で走る。
  `optimizeDeps.exclude` を外した診断ジョブ（成功条件にしない）が #150 の再現の有無を step summary に残す。
  対象の一覧（`.svelte.ts` を持つパッケージ・`crates/*`）は `verify:architecture` の rule
  `external-consumer-fixture` が workspace から洗い出して fixture と突き合わせる。ref の書き換えは
  `scripts/external-fixture-set-ref.mjs`。`docs/upgrading.md` §8、`docs/publishing.md`（タグを打つ前に main の SHA
  で workflow_dispatch する。`crates/*` = 公開、`apps/*` = 対象外）、ADR-0007 の検証限界を更新。SSR ありの構成は
  検証対象外。
- fix(admin-template): コマンドパレットの「最近使った項目」をユーザーごとに分けた（#258）。保存時に所有者
  （`sessionOwnerKey`）を記録し、今のユーザーと一致するときだけ読み出す（一覧の状態 `listViewState` と同じ規則。
  owner が null のときは読み書きしない）。旧形式（所有者なし）の履歴は読み出し時に破棄する。ログアウト確定で消し、
  別ユーザー確定で他人の履歴を消す。
- fix(admin-template): ヘッダーの「検索…」を「画面・操作を検索」（英語 "Search pages & actions"）に改め、
  パレットの placeholder・アイコンボタンのラベル・title も用語を揃えた（#217）。Ctrl K の表示は維持。
  visual のスクリーンショット基準（Linux）はヘッダー文言の変更に合わせて再生成した。
- feat(admin-template): items の CSV 取込の確認パネルに、実行前に先頭10行（`IMPORT_PREVIEW_ROW_LIMIT`）の
  プレビュー表（新規/更新・ID・商品名・価格・在庫）と「全N行中 先頭M行を表示」「K件は既存レコードの更新」の
  表示を追加（#218）。表と送信は同じ検証済み行から作る（`importPreview.ts`）。新規/更新は文字ラベルで区別。
  変更前後の比較は、既存値を追加通信なしに得られないため見送り。
- feat(admin-core, admin-template)!: SessionController 実装-3（#260、**v2.0.0 の破壊的変更**。
  [docs/session-controller-design.md](docs/session-controller-design.md) §5.4・§6.1・§6.2、
  [ADR-0016](docs/adr/0016-session-controller-single-writer.md) は Accepted）。セッションの状態（誰がログインして
  いるか）を書くのは SessionController だけになり、状態を書く旧 API を削除した。admin-template は §6.1 の形に
  配線し直した。**下の「削除した公開 API と移行先」「挙動の互換性が変わる変更」「派生アプリの移行の手順」を参照。**
  - **削除した公開 API と移行先**（§5.4）:

    | 削除した名前                                                                                         | 移行先                                                                                                                                                                                                                     |
    | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `resolveProtectedSession`・`ProtectedSessionOutcome`                                                 | `resolveSettled(getSessionController())` → `unverified` は 503、`confirmed` の `none` だけ（公開閲覧があるなら）`publicViewerFallback(controller, provider, result.ticket)` → その `unverified` も 503、`none` なら /login |
    | `establishSession`                                                                                   | `resolveSettled(controller)`。identity・role は `controller.snapshot` から読む（`load` でストアに書かない）                                                                                                                |
    | `beginSession`・`endSession`                                                                         | 画面からは呼ばない。ログイン・ログアウトの後は `resolveSettled()` で確定する（I-10）。アプリ独自の合成セッション（試運転など）だけ `adopt(identity, kind, ticket)`・`end(reason, ticket)`                                  |
    | `confirmSessionEnded`・`createSessionEndConfirmation`・`SessionEndOutcome`・`SessionEndConfirmation` | `getSessionController().signal(reason)`（同期。確認と退避は controller の中）。`connectEvents` は内部でこれを呼ぶ                                                                                                          |
    | `MAX_STALE_RETRIES`                                                                                  | `createSessionController(provider, { maxStaleRetries })`（既定 3）                                                                                                                                                         |
    | `SessionChangedError`（投げる側）                                                                    | もう投げない。`unverified` の `error` に同名のエラーとして入る（`SessionChangedError` の export は残した）                                                                                                                 |
    | `AuthProvider.check`・`AuthProvider.getIdentity`                                                     | 契約から削除（`LegacyAuthProvider` と `adaptLegacyAuthProvider` にだけ残る）。HTTP・Tauri の provider からも削除。答えは `resolve()` の 1 往復                                                                             |

    残した名前: `onSessionEnded`（`subscribe` の上の薄い関数）、`sessionGeneration`・`currentSessionScope`・
    `isCurrentSessionScope`・`isSessionEstablished`（既定の controller の読み取り）、`sessionOwnerKey`。
    `StandardAuthProvider` は `AuthProvider` と同じ型の別名として残した。

  - **挙動の互換性が変わる変更（要対応の可能性あり）**:
    - `AuthProvider` の `resolve`・`credentialRevision`・`onCredentialChanged` は**型で必須**。v1.8 の `initBanto` は
      3 つの無い provider を黙って互換 adapter で包んでいたが、v2.0.0 では `initBanto`・`createSessionController` が
      **`TypeError`** にする（何も置き換えない）。包むならアプリが `adaptLegacyAuthProvider(...)` を明示する。
    - 「確認できない」は reject ではなく `unverified`（`resolveSettled`・`publicViewerFallback` は reject しない）。
      `resolveProtectedSession` の reject（→ 503）に頼っていたガードは `outcome === 'unverified'` を先に処理する。
    - 公開閲覧の方針（`publicViewerFallback`）は、ticket の後に現れたトークンが確認で `none` に戻るたびに方針を
      やり直す（既定 3 回＝最大 4 回）。上限に達したら最後の確定した `none` を返す（/login へ）。旧
      `resolveProtectedSession` は同じ状況で `SessionChangedError` を投げていた（503 だった）。戻り値の型は
      `superseded` を含まない `ResolveResult` に狭めた。
    - **ログアウト**: `logout()` の後に `endSession()` を呼ばず、`resolveSettled()` の確定が `none` のときだけ /login へ
      移る。その間に別タブのログインが確定していれば（S-51）画面は新しいユーザーで作り直され、/login へは行かない。
    - `connectEvents` の失効の確認（`401`・他タブでのトークン消去）は**既定の controller（`getSessionController()`）宛てに
      `signal()` する**背景の確認になり、**`connectEvents` の購読解除では止まらない**（確定すれば止まる。退避は 1 秒から倍々で 30 秒まで、probe の期限 10 秒）。
    - **`sessionEndUnheard` の期待の変化**（実装-2 からの継続、v2.0.0 で確定）: 保護レイアウトの mount 前に確定した
      終了は、再確認（再 probe）ではなく「`onSessionEnded` を購読した時点で `none` なら非同期に 1 回通知」で届く（S-34）。
      `onSessionEnded` は `none` への**遷移**だけを通知し、none を経ない切り替え（別タブのログイン A → unknown → B）は
      通知しない。保護レイアウトの再 load は generation の照合（配線①）で行う。
    - admin-template: `(app)/+layout.ts` はストアに書かない（`sessionStore.load()` は削除。`sessionStore` の
      identity・role・publicViewer・authDisabled は `controller.snapshot` からの `$derived`、`authDisabled` は
      `snapshot.kind === 'local'`＝ Tauri の `auth_resolve` の答え。`auth_config_get` の別読みはしない、S-61）。
      保護レイアウトは 3 本の配線（① generation の照合 → `invalidateAll()`、② 未処理のユーザーの変更
      `pendingOwnerChange` → 通知して `acknowledgeOwnerChange()`、③ 再 load の `unverified` → 503）。②の方針は
      `$lib/banto/ownerChange.ts` の `OWNER_CHANGE_POLICY`（既定 `'rebuild'`＝通知だけ、`'relogin'`＝通知して /login）。
      どちらも共有のトークンは消さない（I-17）。
    - admin-template: 503 画面の「再試行」は `location.reload()` ではなく `invalidateAll()`（controller を維持した画面内の
      再読込。503 の間に確定したユーザーの変更は、再試行で保護レイアウトが mount したときに通知される、S-81。ページ全体の
      再読込では保証しない）。確認できない間は、別タブで切り替わった後も 503 のまま自動では戻らない（S-36・S-60）。
    - admin-template: ログイン・初回セットアップが `superseded`（別のログイン・ログアウトが先に確定）なら、エラーではなく
      「別のセッションが先に確定しました」を通知して /dashboard へ移る（ガードが今の資格情報で確定する）。
    - admin-template: ログアウトが /login に届かなかったとき（`logoutAndLeave` の戻り値 `'stayed'`＝ログインしたまま、
      `'unverified'`＝確認できない）はエラーのトーストで知らせる。`logoutAndLeave` は投げ直さず、戻り値
      `'left' | 'stayed' | 'unverified'` を返す（引数は `(goToLogin, { notify?, provider?, controller? })`）。
    - 公開閲覧から自分でログインした（同じタブ・別タブ）ときは「ユーザーの変更」として扱わない（通知も
      `'relogin'` も出ない、S-93）。
    - **Tauri: 設定画面でログイン不要モードを有効にすると、管理者のアカウントのセッションはその場でローカルユーザー
      （合成セッション）に置き換わる**（#266 オーナーレビュー P1、S-94）。以前はスロットが空のときだけ合成セッションを
      入れていたので、設定は「ログイン不要」なのにアカウントのセッションが残り、`sessionStore.authDisabled` が偽のままだった
      （ログアウトのメニューやパスワード変更欄が残る）。`auth.disabled == true` ⇔ 合成セッション ⇔ `auth_resolve` の
      `kind == "local"` ⇔ `sessionStore.authDisabled` が常に成り立つ。監査ログには `settings_change` に続けて、置き換えた
      アカウントの `logout`（`detail: { "reason": "auth_disabled" }`＝利用者の操作ではない終了）と合成の `login` が残る。
      その間に始まっていたログインは合成セッションを戻さない。
      ログイン不要モードのまま役割（`disabled_role`）だけを変えたときも、合成セッションの役割を書き換えて `seq` を進める
      （古い `auth_resolve` が前の役割を書き戻さない、S-96）。同じ役割の再適用は何も変えない。
      逆に**認証を再び有効にすると（ログイン不要モードを解除）、ローカルユーザーのセッションはその場で終了する**（S-99。以前は
      次の確認まで残っていた）。監査ログには合成ユーザーの `logout`（`detail: { "reason": "auth_enabled" }`）が残り、画面は
      ログイン画面へ移る。
    - **Tauri: 汎用の `settings_set` は `auth.` で始まるキーを拒否する**（BadRequest。認証モードは `auth_config_apply`、自動ログインは
      `autologin_enable`／`autologin_disable` で変える。S-103）。`set_auth_config` は 4 つのキーを 1 トランザクションで書く（S-104）。
    - HTTP provider: `changePassword` が `401` を受けたら、送ったトークンを消して資格情報の変化を通知する（S-106）。`resolve()` は
      答えが届いた時点で保存されているトークンが送ったものと違えば、古いトークンについての答えとして捨てる（S-105）。
    - **Tauri: ログイン不要モード中の `auth_login`／`auth_setup` は拒否する**（#266 オーナー決定、S-95）。
      `LoginResult { success: false, superseded: false, error: "ログイン不要モード中はアカウントでログインできません…" }`
      を返し、スロットも `seq` も変えない（provider は revision を進めず通知しない。ログイン画面はエラーを出す）。入口で
      モードが有効なら検証・アカウントの作成の前に拒否し（監査なし、setup はアカウントを作らない）、検証・作成の後にも
      `auth_config_lock` の中で読み直して、有効になっていれば設置しない（監査は従来どおり検証成功の `login`／作成の `setup`
      が残る）。これで `auth.disabled == true` ⇔ 合成セッション ⇔ `sessionStore.authDisabled` が例外なく成り立つ。
    - admin-template: demo provider（`demo.ts`）は標準の provider（メモリ上の revision、`login`/`logout` で revision を
      進めて通知）。パネルの別ウィンドウ（`routes/panel/[id]`）は `check()` の代わりに `resolveSettled()` で確認する。
  - **派生アプリの移行の手順**（§6.2。banto-industrial の 2 アプリは候補版のコミット参照で検証してから v2.0.0 へ）:
    1. `session.svelte.ts` の `load()` を削除し、identity・role・authDisabled を `getSessionController().snapshot` からの
       `$derived` にする。
    2. `(app)/+layout.ts` を §6.1 の形にする（`resolveSettled` → `unverified` は 503 → `none` は（公開閲覧があれば
       `publicViewerFallback`）/login）。返す generation は、その `load` で確認できたものだけ。
    3. 保護レイアウトに配線①（`controller.snapshot.generation` と `data.sessionGeneration` の照合 → `invalidateAll()`）と
       配線②（`pendingOwnerChange` の通知と `acknowledgeOwnerChange()`）を入れる。`onSessionEnded` だけでは none を経ない
       切り替えを拾えない。
    4. ログアウトは `await provider.logout(); const r = await resolveSettled(controller, { cause: 'signal' });` →
       `r` が `confirmed` かつ `none` のときだけ /login。ログアウトと /login への遷移の間は配線①の `invalidateAll()` を
       止める（`invalidateAll()` が遷移に勝つ競合）。`end()` は呼ばない。
    5. 503 画面の「再試行」を `invalidateAll()` にする。
       任意: ログイン・初回セットアップが `superseded` を返したら、エラーではなく通知して /dashboard へ移す
       （admin-template の `routes/login/+page.svelte` を参照）。
    6. 独自の再確認（banto-hub の `sessionRecheck.ts`）は `controller.signal(...)` と `resolveSettled(...)` に置き換え、
       試運転は `adopt`/`end` の policy runner にする（§6.2）。
    7. **自前の `AuthProvider` を持つ場合**: v2 の `AuthProvider` は `resolve`・`credentialRevision`・
       `onCredentialChanged` が必須なので型エラーになる。(a) 3 つを実装する（推奨。HTTP なら `GET /api/auth/identity`
       を 1 回、`none` で送ったトークンを compare-and-set で消し、答えの `current` で運ぶ。自分の書き込みと別タブの
       `storage` イベントで revision を進めて通知する）、または (b) 一時的に `adaptLegacyAuthProvider(...)` で包む
       （別タブの切り替えの検知・compare-and-set・1 往復は保証されない。§5.2 の表。移行 PR に「adapter 使用中」と明記）。
       メモリ上の demo 用 provider なら admin-template の `src/lib/banto/providers/demo.ts`（標準の 3 つ、revision と通知）を
       手本にできる（banto-industrial では chronogazer の `setup.ts` の `demoAuthProvider` が該当し、放置すると型エラーのうえ
       demo 起動時に `initBanto` の `TypeError` で白画面になる）。
       `getAuthProvider().getIdentity()`／`check()` を直接呼んでいる箇所（banto-hub・chronogazer の `session.svelte.ts`）は、
       `getSessionController().snapshot`（`$derived`）か `resolveSettled(controller)` に置き換える。
       adapter で包んだ provider の `logout()` は、旧 `check()` が `false` を返す状態にすること（ログアウトの確定は
       その後の `resolve()` が行う）。
- feat(admin-core, admin-template): SessionController 実装-2（#260、controller。
  [docs/session-controller-design.md](docs/session-controller-design.md) §5.1・§7.1）。
  **追加 API**: `createSessionController(provider, deps?)`・`getSessionController()`（`initBanto` が
  `authProvider` に結び付ける既定の controller。`resolve`/`credentialRevision`/`onCredentialChanged` を
  持たない provider は `adaptLegacyAuthProvider` で包む）・`resolveSettled(controller, { cause?, deadlineMs? })`・
  `publicViewerFallback(controller, provider, ticket, { maxRetries? })`・`DEFAULT_PUBLIC_VIEWER_RETRIES`・
  `SessionTimeoutError`・`SessionProviderMissingError`、型 `SessionController`・`SessionControllerDeps`・
  `SessionResolveOptions`・`SessionSnapshot`・`SessionTicket`・`ResolveResult`。controller は状態を書く唯一の
  場所で（`commit`）、`resolve()` は reject せず `confirmed`/`unverified`/`superseded` を返し、同時の確認は
  1 本にまとめ（single-flight）、答えは失敗も含めて同じ鮮度の条件で採否を決める。
  **委譲化**: `establishSession`・`beginSession`・`endSession`・`resolveProtectedSession`・
  `confirmSessionEnded`・`createSessionEndConfirmation`・`onSessionEnded`・`sessionGeneration`・
  `currentSessionScope`・`isCurrentSessionScope`・`isSessionEstablished`・`sessionOwnerKey` は既定の controller
  への委譲になった（公開名・呼び方は同じ。v2.0.0 で状態を書く旧 API は削除予定）。**挙動の変化**:
  セッションの確認は `check()` + `getIdentity()` の 2 往復ではなく `AuthProvider.resolve()` の 1 往復
  （HTTP は `GET /api/auth/identity`、Tauri は `auth_resolve`）。`resolveProtectedSession` は発行した公開閲覧の
  セッションも controller で確定する。確認には期限（10 秒）があり、超えたら「確認できない」（再試行画面）。
  別タブのログイン・ログアウト（共有の Remember me トークンの `storage` イベント）で、このタブの active な
  セッションは保留（unknown）になり、確認し直す。**`sessionEndUnheard` の期待の変更**: 保護レイアウトの
  mount 前に確定した終了は、再確認（再 probe）ではなく「購読した時点で `none` なら非同期に 1 回通知」で
  届く（S-34）。`onSessionEnded` は `none` への**遷移**だけを通知する（すでに `none` のときの再確認では通知しない）。
  **admin-template**: `(app)/+layout.svelte` の `onSessionEnded(() => invalidateAll())` を、generation の照合
  （`snapshot.generation !== data.sessionGeneration` なら `invalidateAll()`、同じ generation に二重に出さない）に
  置き換えた（配線①。none を経ない切り替え S-79・同じユーザーの再ログイン S-80 でも画面を作り直す）。ログアウト
  （`Header.svelte`・コマンドパレット）は `logout()` → `endSession()` → `/login` の順で、その間は配線①が再 load しない
  （再 load が公開閲覧を発行して遷移を上書きしないように）。`endSession()` はログアウトの前に取った ticket が
  current のときだけ呼ぶ（その間に別タブのログインなどで確定したセッションを終わらせない）。`initBanto` を**別の** `authProvider` で
  呼び直すと、それまでのセッションは保留（unknown）になり新しい provider で確認し直す（同じ provider なら何もしない）。
  **派生アプリへの申し送り**: 保護レイアウトに配線①（`getSessionController().snapshot.generation` と `load` が
  返した generation の照合 → `invalidateAll()`）を入れること。`onSessionEnded` だけでは、別タブのログインなど
  unknown → active（none を経ない）の切り替えで世代ゲートが画面を隠したままになる。
- feat(admin-core, admin-template): SessionController 実装-1（#260、provider とバックエンド。
  [docs/session-controller-design.md](docs/session-controller-design.md) §7.1）。
  **追加 API**（すべて追加。v1.x では任意）: `AuthProvider.resolve({ signal })`（1 往復で
  `{ status, checked, current, identity?, kind? }` を返す）・`credentialRevision()`・
  `onCredentialChanged(listener)`、型 `CredentialRevision`・`ResolvedAuth`・`SessionKind`・
  `AuthOperationResult`・`LegacyAuthProvider`・`StandardAuthProvider`・`TauriAuthProviderOptions`
  （`opPendingTimeoutMs`）、`StaleAnswerError`/`isStaleAnswerError`、互換 adapter
  `adaptLegacyAuthProvider`/`ADAPTER_REVISION`。`login`/`setup` の戻り値に `superseded?` を追加。
  **変更**: `AuthProvider.enterPublicViewer` は `(options?: { expectRevision? }) =>
Promise<{ success, superseded? }>` になった（旧 `Promise<boolean>`。`resolveProtectedSession` は
  `.success` で判定し、`superseded` なら確認し直す）。HTTP provider は `resolve()` で
  `GET /api/auth/identity` を 1 回だけ呼び（`200 null`/`401` はそのトークンを compare-and-set で
  消す）、`login`/`setup`/`logout`/`enterPublicViewer` のトークンの書き込みを開始時の revision との
  compare-and-set にした（#259。追い越された書き込みは何もしない。`logout` の要求は開始時の
  トークンで送る）。別タブの `storage` イベント（`storageKey` のもの）で revision を進めて通知する。
  **Tauri コマンドの戻り値の変更**（`createTauriAuthProvider` が吸収）: `auth_login`/`auth_setup` の
  `LoginResult` に `superseded`・`seq`、`auth_logout` は `()` から `LogoutResult { seq }`、
  `auth_change_password` は `()` から `ChangePasswordResult { seq }`。`auth_resolve` を追加
  （`{ identity, kind, checked, current, stale }`）。Rust の `state.auth` は `AuthSlot { session, seq }`
  になり、`auth_login`/`auth_setup`/`auth_logout` は入口で読んだ `seq` との compare-and-set で書く
  （遅いログインが完了済みのログアウトを取り消す・遅いログアウトが後のログインを消す、を防ぐ。
  S-16〜S-19）。REST のルートは変えていない。
- chore(deps): 開発依存の vitest を 4.1 から 5.0 へ更新（10 パッケージ/アプリ、dependabot #203 を置き換え）。
  Vitest 5 でモジュールレベルの `bench()` が廃止されたため、`packages/charts/tests/trend.bench.ts` と
  `packages/grid-svelte/tests/virtual.bench.ts` を `bench` フィクスチャ（`test()` の中で使う）へ移行し、
  `bench` スクリプトに `--reporter=verbose` を足して結果表を表示する。利用側の API・版は変わらない。
- docs: 全体構成図とフロー図を追加（`docs/architecture-overview.md` /
  `docs/architecture-flows.md`）。デスクトップと LAN の二形態、レイヤ、
  機能マップ、パッケージ依存、認証・初回起動・開発3経路・add-resource の
  層対応を Mermaid で俯瞰。README / AGENTS からリンク。
- docs(admin-core): セッションの確定を 1 か所（SessionController）に寄せる設計
  （#260）。ADR-0016（Proposed）と設計の本文
  [docs/session-controller-design.md](docs/session-controller-design.md)
  （不変条件 I-1〜I-24・競合のシナリオ S-1〜S-83・generation の数え方の表・API の
  案・実装の分割・テストの設計）。Tauri の Rust 側で `.await` の後に `state.auth` を無条件で書いている
  箇所（`auth_login`・`auth_setup`・`auth_logout`）を特定した。判断点はオーナーの決定
  （2026-09-29）を反映済み（旧 API は削除、`AuthProvider.resolve` 必須、
  `GET /api/auth/session` は新設せず `GET /api/auth/identity` を 1 回、`superseded` の
  `load` は確認できた世代だけを返す、#257 の既定の流れ）。同日のレビュー 10 件も
  反映済み（ticket の原則 I-18、ログアウトは `resolve()` で確定、`seq` は結び付きを
  変える操作でだけ進める、操作の応答で revision を確定して通知、失敗も同じ鮮度の
  照合、Rust のテストはコマンド本体で順序を固定）。統合修正 19 項目（3 回目の
  オーナーレビュー 5 件 ＋ 独立レビュー ＋ 第三者の補足）も反映済み: provider の
  `resolve()` は `{ status, checked, current, identity?, kind? }` を返し中の消去は
  通知しない、provider は標準（3 つ必須）と互換 adapter の 2 階層、adopt 中の ticket は
  epoch だけ、generation は (status, owner, kind) が変わったときだけ +1、画面の再確認は
  レイアウトの `$effect` の generation 照合に統一。4 回目のレビュー（Astra 6 件 ＋
  独立の再レビュー）も反映済み: 保留に移すのは active かつ adopt 中でないときだけ、
  Tauri の revision は不透明な `(observedSeq, local)` の組で `settle_session` は
  `seq_at_entry` と一致しなければ何も書かず stale、policy runner は期限・上限で
  `unverified` かつ `guard`/`recheck` の 2 mode、abort の規則は「採用できないことが
  確定した probe は必ず abort」の 1 つ。5 回目のレビュー（6 件）も反映済み: stale な
  答え（Rust の stale、pending の操作をまたいだ答え）は待たずに `StaleAnswerError` で捨て
  新しい probe で確認し直す（操作の pending には期限）、配線①（generation の照合）は
  実装-2 に前倒し、未処理の owner の変更は `pendingOwnerChange` として同値の再確認で
  上書きしない、policy runner の絶対期限を通常の確認にも引き継ぐ、revision の公開型は
  すべて `CredentialRevision`。6 回目のレビュー（3 件 ＋ オーナーの決定）も反映済み: stale の
  判定は「答えが届いた時点で未完了の状態を変える操作があるか」（開始の前後を問わない）、
  未処理のユーザーの変更は unknown・同じユーザーの再確認で保持し none の確定で破棄、
  503 画面の「再試行」は controller を維持した `invalidateAll()` に変える（ページ全体の
  再読込では通知を保証しない）。**実装時の挙動の変更の予告**: 旧
  `sessionEnded.ts` の「unheard の再確認」は再 probe をやめ、`onSessionEnded` が
  購読した時点で `none` なら非同期に 1 回通知する形に変わる（`sessionEndUnheard` の
  テストの期待は「購読時に none なら 1 回通知」に）。コードの変更は無い。
- feat(admin-core, admin-template)（**挙動の互換性が変わる変更を含む** —
  下の「挙動の互換性が変わる変更」と「派生アプリの移行の手順」を参照）:
  一覧→詳細→保存/戻る→一覧の往復で
  絞り込み・並び順・直前に開いた行を復元する（#215）。一覧を絞り込んで
  複数行を順に確認・修正する操作で、1件保存するたびに一覧条件が
  リセットされ作業対象を探し直す必要があった。
  - 保存先は `sessionStorage`（同一タブ・同一セッションの作業文脈。列設定の
    保存は対象外 — #168 の範囲）。各エントリは**所有者（ログイン中の
    アカウント、または公開閲覧者）付き**で書き、**確定した今の所有者と
    一致するときだけ**復元する。別タブで Remember me のユーザーが切り替わった
    後の再読み込み・公開閲覧者への自動移行・同じタブでの別ユーザーの
    ログインのいずれでも、前のユーザーの検索語・並び順・強調行は出ない。
    所有者が確定しない（`getIdentity()` が `null`・id なし）ときは保存も
    復元もしない（fail closed）。
  - 画面や保存中の処理は、作られたときの**セッションの世代**を持ち、世代が
    変わった後（セッション終了・所有者の変更。同じアカウントの再ログインも
    新しい世代）は書き込めない。admin-template の `(app)/+layout.svelte` は
    世代が変わるとページを作り直す（SvelteKit は load を再実行してもページを
    作り直さないため、旧セッションの GridState・強調行・通知・未保存の入力が
    次のセッションに残っていた）。
  - 編集結果が絞り込み条件から外れた場合はフィルタを解除せず、「商品 #{id}
    は現在の絞り込み条件に当てはまりません」と説明する通知を表示
    （`items.filterExcludedNotice`）。クライアントモードの判定はグリッドと
    同じ派生行（`itemRow.ts` の `toItemRow()`）で行う。直前に開いた行は
    `rowClass`（`items-row-last-opened`）で強調表示。
  - 副次的なバグ修正: `ItemsServerGrid`（サーバーモード）は `GridState` を
    外部から事前設定しても `WindowedListResource.params` が既定値のまま最初の
    取得を行っていたため、復元した条件が取得に効いていなかった。マウント時に
    `windowed.setParams()` で同期する。
  - **派生アプリへの影響（API の追加）**: `@banto/admin-core` に次を追加。
    - 一覧状態: `saveListViewState`/`loadListViewState`/`clearListViewState`/
      `clearAllListViewState`、`saveActiveListMode`/`loadActiveListMode`、
      `saveLastOpenedId`/`loadLastOpenedId`、`noteLastEditedRecord`/
      `takeLastEditedRecord`、型 `ListViewSnapshot`/`LastEditedRecord`。
      `clear*` 以外は**第1引数に `SessionScope` を取る**。
    - セッションの所有者と世代: `establishSession(auth, apply?)`（identity を
      取得し、今のセッションについての応答だと確かめたのと同じ継続で
      `beginSession` と `apply(identity)` を行い、確立した `scope` を返す。古い
      応答は捨てる）/`beginSession(identity)`/`endSession()`、
      `SessionChangedError`/`MAX_STALE_RETRIES`、`currentSessionScope()`/
      `isCurrentSessionScope(scope)`/`sessionGeneration()`/
      `isSessionEstablished()`/`sessionOwnerKey()`、型 `SessionScope`。
    - `initBanto` は `AuthProvider` を**ラップしない**（`getAuthProvider()` は
      渡したオブジェクトそのものを返す。main と同じ）。
  - **挙動の互換性が変わる変更（要対応の可能性あり）**:
    1. **`AuthProvider.getIdentity()` の約束の変更**: `null` を返すのは
       「セッションがない（トークンなし・`401`）か、identity の概念がない」
       ときだけ。サーバーの失敗（`500`）や通信の失敗など、**取得できない
       ときは reject** する（`check()` と同じ分け方。`provider.ts` の doc）。
    2. **HTTP provider（`createHttpAuthProvider`）の `getIdentity()`** は、
       これまで通信の例外・非 2xx をすべて `null` にしていたが、**`401` 以外の
       失敗で `ProviderError` を投げて reject する**ようになった（Tauri
       provider は元から reject）。
    3. **`resolveProtectedSession`** は、`check()` 中にセッションが変わり続けた
       とき（`MAX_STALE_RETRIES` 回）に **`SessionChangedError` で reject
       しうる**。また、セッション無効が確定したときに `endSession()` を呼び、
       `check()` の `false` が確認中に変わった前のセッションについての答えなら
       終了せずに今のセッションを確かめ直す。`confirmSessionEnded` も同じく
       確定したときに `endSession()` を呼び、前のセッションへの `false` では
       終了・通知しない（戻り値の種類は従来どおり）。
    4. **`beginSession(null)`**（所有者を持たないセッション）は、世代を進めて
       保存・復元を止めるが、**他の所有者の保存分は消さない**（消すのは具体的な
       新しい所有者が確定したときと `endSession()` だけ）。
    5. **admin-template**: identity の取得だけが失敗したとき、従来は閲覧者
       扱いの画面になっていたが、**ガードの再試行画面**（「ログイン状態を
       確認できませんでした」、`check()` の失敗と同じ #204 の扱い）になる。
       セッションの所有者・世代・一覧状態は変わらず、再試行で同じ identity が
       確かめられればそのまま復元される。
  - **派生アプリの移行の手順**:
    - `getAuthProvider().getIdentity()` を自前の sessionStore やガードで直接
      呼んでいるアプリは、**reject を受け止める**（ガードの再試行画面に
      つなぐ。admin-template の `(app)/+layout.ts` が `sessionStore.load()` を
      `try` で囲んで `error(503, …)` にしている形を写す）か、
      **`establishSession(getAuthProvider(), apply)` に移す**。reject を
      受け止めないと、identity のエンドポイントが一時的に失敗しただけで
      未処理の例外になる。
    - `resolveProtectedSession` を呼ぶガードは、既存の reject と同じく
      `SessionChangedError` も「確認できない」として扱う（admin-template の
      ガードは変更不要）。
    - 独自の `AuthProvider` は、取得できないときに `null` ではなく reject
      するよう直すことを推奨（`null` のままでも動くが、その間は所有者なしの
      扱いになり、一覧状態の保存・復元が止まり、画面も作り直される）。
    - 一覧状態を使う場合は、ガードで `establishSession`、ログアウト成功後に
      `endSession()`、一覧・詳細ページは生成時に `currentSessionScope()` を
      取って各 API に渡し、画面の作り直しは `(app)/+layout.ts`/
      `+layout.svelte` の配線を写す。手順は
      [docs/recipes/add-resource.md](docs/recipes/add-resource.md)「一覧の
      絞り込み・並び順の保持」。`establishSession`（または `beginSession`）を
      呼ばないアプリでは、一覧状態は保存も復元もされない（安全側に倒れる）。
    - **依存の版だけを先に上げない**こと。上の対応を含む追従の PR として
      上げる。
    - 版の上げ方（メジャーにするか段階的に移行するか）は**リリースのときに
      判断する**（この変更では版を変えていない）。
    - セッション管理（sessionStore・ガード・レイアウトの世代ゲート）の
      共通化は tyaro/banto#260 で扱う。
  - テスト: `packages/admin-core/tests/listViewState.test.ts`（所有者の照合・
    古い世代からの書き込み拒否・形の検証ほか）、`registry.test.ts`（凍結した・
    クラスの・`this` を共有する `AuthProvider` をそのまま保持）、
    `sessionGate.test.ts`/`sessionEnded.test.ts`。E2E はシナリオ 3c〜3e・6・
    6a（同じブラウザの2タブで Remember me のユーザーを切り替え、元のタブを
    再読み込み）と公開閲覧シナリオ 7（失効 → 公開閲覧者 → 並べ替え → 往復）。
  - 経緯: レビュー 2〜3 回目の対応では認証の各経路（`AuthProvider` の
    `Proxy` ラップ・ガード・失効確定）で**消す**方式だったが、経路の見落とし
    （別タブでの切り替え・作り直されない画面からの再保存）と凍結した
    `AuthProvider` での `TypeError` が続いたため、4 回目で上記の
    **所有者で照合する**方式に切り替えた（#255）。5 回目では、scope を始める・
    終わらせる認証の非同期応答（identity の取得・`check()`）も、開始時の
    世代・対象と照合してから適用するようにした（旧セッションへの遅れた応答で
    新しいセッションの所有者・保存状態・画面が失われていた）。6 回目では、
    応答が今のセッションについてのものかの確認と、その適用（`endSession`・
    identity の記録）を間に await を挟まない同じ継続で行うようにし、identity
    を一時的に取れないことを「所有者なし」と区別した。
- fix(admin-template, banto-server): バインドアドレス（`config.bind`）に
  合わないLAN URL・QRを表示する問題を修正（#216）。127.0.0.1（または
  `::1`）にバインドしたまま「LANアクセスを有効にする」を保存・適用しても、
  設定画面が非loopbackのLAN URLと最初のLAN用QRを案内していた——他端末は
  そのURLへ接続できないため、利用者が原因を切り分けにくかった。
  **派生アプリへの影響**: `server_status`/`server_apply`（Tauri コマンド）
  と `banto-serve` の起動時ログが返す/出力する URL 一覧・QR は、これからは
  `bind` に実際に合うものだけになる（形状は変わらず、値のみ補正 —
  loopback bind なら loopback URL のみ、`0.0.0.0` なら従来どおり
  loopback + 非loopback IPv4、特定 IP ならその IP のみ）。この一覧を
  「常にLAN到達可能」という前提で読んでいた派生アプリは読み直しが必要。
  **`banto_server::lan_urls_for_bind` を追加**（`(bind: &str, port: u16) ->
Vec<String>` の純関数）。**派生アプリで `lan_urls(port)` を使って URL を
  案内しているなら、bind を渡す新しい関数に切り替えないと、同じ誤案内が
  残る** — `lan_urls(port)` は互換性のため旧シグネチャ・旧挙動（常に
  `0.0.0.0` 相当）のまま残しており、公開関数の型は変えていない
  （`banto-server` は git タグ/`path:` 依存で消費されるため、シグネチャ
  変更だけで派生アプリのビルドが壊れる。`#[deprecated]` も付けていない —
  派生アプリの多くが `-D warnings` でビルドしており、依存更新だけで
  ビルドが壊れるのを避けるため）。
  - bind の種類（loopback IPv4 / `0.0.0.0` / 特定 IPv4）ごとに URL 集合を
    切り替える（**IPv6 の待受は当面、案内の対象外** — オーナー判断、
    2026-09-29。詳細は本項末尾）。回帰テストを bind の表で追加
    （カウンタープルーフで旧実装への揺り戻しが落ちることも確認済み）。旧
    `lan_urls(port)` の挙動が変わっていないことのテストと、その反証も
    追加。
  - 設定画面（`ConnectivitySection.svelte`）は状態表示を「このPC内で稼働中」
    「同じネットワークの端末から接続できる設定で稼働中」に分け、
    ファイアウォール等による到達性は保証しない旨の注記を追加。バインド
    選択肢の文言を「このPCのみ（127.0.0.1）」「同じネットワークの端末
    （0.0.0.0）」に変更（初期値は変更なし）。判定はプレーンな純関数
    `connectivityScope`（`connectivityScope.ts`）に切り出し、vitest で
    表テスト + カウンタープルーフを追加。
  - `banto-serve`（LANサーバ単体起動バイナリ）の起動時ログも同じ
    修正の対象（`BANTO_BIND` をloopbackに上書きした場合に誤ってLAN URLを
    印字していた）。
  - オーナーレビュー対応（2026-09-28）: 状態表示とQR選択のloopback判定が
    ずれていた問題を修正。`127.0.0.2`（`127.0.0.0/8` のうち代表アドレス
    以外）は状態表示では`'lan'`扱いのまま、QRは`!url.includes('127.0.0.1')`
    という部分文字列一致で選んでいたため、loopbackのURLをLAN用QRに選んで
    しまっていた。`localhost`/`::1` は逆に状態は`'local'`なのにQRは表示
    されていた。`connectivityScope.ts` に単一の loopback 判定
    （`isLoopbackHost` — IPv4 `127.0.0.0/8` 全域・IPv6 loopback・
    `localhost` を正しく判定）を用意し、状態表示（`connectivityScope`）と
    QR選択（`pickPrimaryLanUrl`）の両方がそれを使うようにした（判断: バック
    エンドに loopback フラグを追加する案も検討したが、入力はフロント側で
    完結して判定できるため、状態のJSONは変更していない）。表テスト + 反証
    (旧実装に戻すと落ちる) を追加。
  - オーナーレビュー対応（2026-09-28）: `lan_urls(port)` の互換テストが
    実機のNIC構成に依存していた問題を修正。インターフェース列挙とURL
    組み立てを分離し、固定fixtureでテストするように変更（反証も追加）。
  - オーナーレビュー対応（2026-09-28、3巡目）: 角括弧付きのIPv6ワイルド
    カード（`bind = "[::]"`）を正規化せずURLを組み立てていた問題を修正。
    `start`のリスナーはこの値を有効な待受アドレスとして受け付けるが、
    `"[::]".parse::<IpAddr>()`は失敗するため未知の文字列扱いのfallbackに
    落ち、`["http://[::]:8721"]`という未指定アドレスそのものを返して
    いた（未指定アドレスは接続先に使えない、RFC 4291 §2.5.2）。
    `banto_server::server`に`parse_bind`を追加し、パース前の前後空白
    除去・`[...]`除去・IPv4マップ済みIPv6アドレス（`::ffff:127.0.0.1`等）
    のIPv4への正規化を行うようにした（この正規化自体は以降も残る —
    IPv4マップ済みIPv6アドレスはIPv4として扱われる）。
  - **オーナー判断（2026-09-29、4巡目レビュー後）: IPv6の待受は当面、
    接続先URL・QRの案内対象から外した。** 3巡目の修正でIPv6のwildcard
    （`::`）にloopback + 非loopback IPv4・IPv6の両方を案内するように
    したところ、4巡目のレビューで実装のバグが2件見つかった:
    (1) `start`は`IPV6_V6ONLY=0`を設定しないため、Windowsでは`::`バインド
    がIPv4接続を受け付けず、IPv4のURLを案内すると誤案内になる。
    (2) ゾーンIDの無いリンクローカルIPv6（`fe80::/10`）はどの経路からも
    実際には接続できず、NIC列挙からQRに選ばれてしまう経路があった。
    IPv6を正しく案内し続けるには待受側のdual-stack対応など追加の設計判断
    が要ること、かつこのアプリはIPv6経路を他に何もサポートしていないこと
    から、IPv6固有の案内ロジックを都度直し続けるより「IPv6には今は案内
    しない」方針に倒した方が単純で安全と判断した。
    - `banto_server::lan_urls_for_bind`はIPv4のみを案内する
      （loopback・`0.0.0.0`・特定IPv4）。bindがIPv6（loopback・wildcard・
      特定アドレスいずれも）または解析できない文字列のときはURLを一切
      返さない（生の文字列をそのままURLにしていた旧fallbackも廃止 —
      接続先として使えないURLを案内しないため）。IPv6のNIC列挙・
      dual-stack案内・リンクローカル除外の実装は削除し、コードを縮小。
    - 画面側（`connectivityScope.ts`）も`isLoopbackHost`/
      `isUnspecifiedHost`/`pickPrimaryLanUrl`をIPv4専用に単純化し、
      新設の`isIpv4Bind`でIPv6バインドを判定して「IPv6の待受は接続先の
      案内対象外」という専用の状態文言・注記を表示し、URL一覧・QRは
      出さないようにした（初期値は変更なし）。
    - 固定fixtureの表テスト・反証（Rust・フロント双方）をIPv4専用の設計に
      合わせて全面的に更新。

- fix(admin-core, banto-admin-services, banto-server, admin-template): 監査ログ画面の
  縮小コピー（`AuditLogWindow`）に残っていた #243 と同じ欠陥を直し、ブロックの合間の
  行の増減で重複・欠落しないよう**境界（`asOfId`）付きのブロック読み込み**を入れる
  （#248、[ADR-0015](docs/adr/0015-snapshot-list-resource.md)）。**派生アプリへの影響:
  API の破壊的変更は無い（追加のみ）。ただし監査ログ画面と Tauri の `audit_log_list`
  コマンドは組で更新すること**（新しい画面は応答の `asOfId` を必須とする）。
  - `@banto/admin-core`（追加）: `SnapshotListResource` / `createSnapshotListResource(fetcher,
options)` / `SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE` と型 `SnapshotListFetcher` /
    `SnapshotListRequest` / `SnapshotListResult` / `CreateSnapshotListResourceOptions`。
    取得関数を注入で受け取り（`DataProvider.getList` は変えない）、世代の最初の応答の
    境界を後続のブロックに渡す。境界が決まるまで要求は 1 本だけ。同じ境界の総件数が
    変わったら失効（`expired`）として続きを読まず、`refresh()` で新しい世代にする。
    失敗はブロック単位（`failedBlocks` / `error`）、`{0, 0}` からも回復、応答しない
    要求は `requestTimeoutMs`（既定 30 秒）で失敗にして `AbortSignal` を中断、新しい
    世代は処理中の要求を中断し、世代の違う応答は捨てる。`totalCount` は未取得のあいだ
    `null`（「未取得」「取得失敗」「正常な 0 件」を区別できる）。応答の任意の
    `deletionEpoch` が世代の最初と違っても失効にする。`WindowedListResource`
    の公開 API・挙動は変えていない（内部の小さい判断を `blockFetch.ts` へ共有化）。
  - `banto-admin-services`（追加）: `AuditLogService::list_as_of(params, as_of_id)` と
    `AuditLogList`（`rows` / `totalCount` + `asOfId`）。境界の決定・行・件数を 1 つの
    読み取りトランザクションで行う（PostgreSQL は `REPEATABLE READ, READ ONLY`）。
    `list(params)` の型と結果は従来どおり。並びは `ColumnMap` の一意キー `id` で
    一意（同じ時刻の行も `id` の順。SQLite / PostgreSQL の両方でテスト）。
    **削除の世代**（`AuditLogList::deletion_epoch` / `deletionEpoch`、定数
    `DELETION_EPOCH_KEY` = `settings` の `audit.deletion_epoch`）: `prune` は削除を
    1 つのトランザクションで行い、行を消したときは同じトランザクションで世代を
    1 進める（行数の上限の削除は件数を数える `SELECT` と削除を 1 つの文にまとめた）。
    一覧は行・件数と同じ読み取りトランザクションでそれを読んで返す。PostgreSQL で
    小さい `id` の遅れたコミットと同じ件数の削除が重なっても、件数は同じまま集合が
    入れ替わったことを検出できる（#256 レビュー）。マイグレーションは不要。
  - `banto-server`: `POST /api/audit-log/list` が任意の `?asOfId=` を受け取り、応答に
    `asOfId` と `deletionEpoch` を足す（`rows` / `totalCount` は従来どおり）。**`asOfId` 付きの取得では
    保持期間の削除を走らせない**（上限に張り付くと 2 ブロック目以降がいつも失効する
    ため。banto-industrial #448 / #464 と同じ）。不正な `asOfId` は 400 `bad_request`。
    admin 限定は変えていない。
  - admin-template: Tauri の `audit_log_list` に任意の `asOfId` 引数（REST と同じ
    挙動）。`listAuditLog(params, asOfId?, signal?)` は `AuditLogList` を返す。監査ログ
    画面は `createSnapshotListResource` に置き換え、読み込み失敗の表示・常に押せる
    「再読み込み」・失効の説明・「未取得」「取得失敗」「0 件」の出し分けを追加
    （i18n キー 7 件を ja / en に追加）。
  - banto-industrial（chronogazer / banto-hub）: 自前の `AuditLogService` と
    `blockCache.ts` を持ち、banto の監査ログ API・`AuditLogService` は使っていない
    ため影響なし。`auditBlocks.ts` の失効判定も件数だけに頼っているが、どちらも
    SQLite（書き込みが 1 本ずつで遅れたコミットが無い）なので実害は無い。
    PostgreSQL に移すときは削除の世代が要る。`@banto/admin-core` を上げたあと、`blockCache.ts` /
    `auditBlocks.ts` を `SnapshotListResource` に置き換えるかは任意。

## [1.7.3] - 2026-09-28

**v1.7.3 — 一覧のページングの重複・欠落を直す修正。派生アプリへの影響: 一覧の並びが変わりうる（API の破壊的変更は無い）。**
`banto-storage` の `ORDER BY` に一意キー（既定 `id`）を足すようになり、
`LIMIT`/`OFFSET` を使う一覧で同じ値の行が多い列でも重複・欠落しなくなる。
並べ替えの指定が無いときは一意キーの昇順（従来と同じ向き）。InMemory の
`DataProvider` と grid の client sort も同じ規則にそろえた。追加 API:
`ColumnMap::unique_key` / `without_unique_key` / `unique_key_column`、
`WindowedListResource` の `failedBlocks` / `requestTimeoutMs`。あわせて、
`systemInfoStore.available` がモジュール読み込み時に固定される不具合の
修正と、Dependabot 依存更新を含む。

- 依存更新（Dependabot・#200/#201/#202）: pnpm/action-setup / taiki-e/install-action
  / uuid / npm minor-patch グループ（@playwright/test・eslint・prettier・
  typescript-eslint・vite・jsdom・@lucide/svelte・@inlang/paraglide-js・
  @inlang/plugin-m-function-matcher）。
- fix(admin-template): `systemInfoStore.available` がモジュール読み込み時に
  1 回だけ判定され、`bantoReady` がモードを `'server'` にする前に評価される
  と `false` のまま固定される問題を修正（#244）。System Info のカードが
  出ず、読み込みの effect も走らなかった（E2E 11a がモジュール評価順次第で
  落ちる原因）。`available` をゲッターにして読むたびに再評価する。回帰
  テストを追加（`systemInfoStore.test.ts`、admin-template に vitest 一式を
  新設）。
- fix(banto-storage, admin-core): 一覧のページングで行が重複・欠落する問題と、
  `WindowedListResource` が失敗から回復できなくなる問題を修正（#243）。
  **派生アプリへの影響: 一覧の並びが変わりうる**（API の破壊的変更は無い）。
  - `banto-storage`: `append_order_by`（`apply_list_params`）は `ORDER BY` の
    最後に一意キーを、最後の並べ替えと同じ向きで足す（すでにその列で並べて
    いれば足さない）。並べ替えの指定が無ければ一意キーの昇順で並べる（従来は
    `ORDER BY` 無し。SQLite の rowid 順・InMemory の挿入順と同じ向き）。同じ値の
    行が多い列で `LIMIT`/`OFFSET` を使うと、PostgreSQL では実際にブロック間で
    重複・欠落していた（3000 行・3 値の列で 771 行）。
  - 一意キーは既定で `ColumnMap` に登録された `id`。**`id` が一意でない
    `ColumnMap` は `.without_unique_key()` で外す**か、別の列を
    `.unique_key("field")` で宣言する（追加 API。`unique_key_column()` で確認
    できる）。`id` を登録していない `ColumnMap` は従来どおり（一意キー無し）。
  - `WindowedListResource`: 失敗をブロック単位で持つ（追加: `failedBlocks`。
    `error` はまだ回復していない最新の失敗で、別のブロックの成功では消えない。
    `setParams()` で消え、`refresh()` では再取得が成功するまで残る）。取得世代に
    総件数がまだ無い間は、表示範囲が `{0, 0}` でも先頭ブロックを取りに行く
    （最初の取得の失敗や 0 件の後に、`refresh()`・通知・絞り込みの解除が要求を
    出さなかった）。`setParams()` は最後の範囲を自分で取り直す（呼び出し側の
    `ensureRange()` はその要求に合流する）。`ensureRange()` の Promise は、範囲に
    かかる処理中のブロックの完了も待つ。応答しない要求は `requestTimeoutMs`
    （追加オプション、既定 `DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS` = 30 秒）で
    失敗にし、`loading` が降りなくなることを防ぐ。
  - 取得の合間の行の増減による `OFFSET` のずれ（世代のスナップショット境界）は
    `DataProvider.getList` の API 変更を伴うため入れていない。一般の CRUD 画面は
    SSE の `invalidate` で取り直される。
  - admin-template: `ItemsServerGrid` に読み込み失敗の表示と「再読み込み」を追加。
  - **並びの決まりを JS 側にもそろえた**（レビュー対応）: InMemory の
    `DataProvider` は同順位の行を `idField`（既定 `id`）で最後の並べ替えと同じ
    向きに並べ、並べ替えが無ければ `idField` の昇順で返す（従来は挿入順）。
    grid の client sort（`sortRows`）も同順位の行を行の `id`（無ければ新しい
    第 4 引数 `getRowId`。`BantoGrid` は自分の `getRowId` を渡す）で同じ向きに
    並べる（従来は元の配列の順。並べ替えが無いときは従来どおり配列の順）。
    SQL・InMemory・grid の 3 つが共通の fixture
    （`crates/banto-storage/testdata/list-order-parity.json`）で一致を確かめる。
    **派生アプリへの影響: クライアントモード・InMemory でも、同じ値の行の並びが
    変わりうる**（降順では `id` の大きい行が先）。未知の列の並べ替え（SQL は
    `ColumnMap` に無い列、grid は列定義に無い列、InMemory はどの行にも無い
    フィールド）は、向きを決める前に 3 つとも除く。
  - `WindowedListResource`（レビュー対応）: `getList` が同期的に throw しても、
    処理中の記録が残って `loading` が降りなくなることは無い（記録を先に作って
    から要求を始め、同期の throw は reject した Promise として扱う）。通知
    （`notifier`）の throw や、形の崩れた応答（`rows` が配列でない・`totalCount`
    が 0 以上の整数でない・`totalCount` や書き込み先の末尾が配列の長さの上限
    `2 ** 32 - 1` を超える）もそのブロックの失敗として扱い、状態を取り残さない
    （公開する `totalCount` は常に配列の長さとして有効な値に保つ）。

## [1.7.2] - 2026-09-26

**v1.7.2 — セッション失効（強制ログアウト・パスワード変更・降格）を、開いている画面に即座に伝える修正。破壊的変更は無い。**
`admin-core` の `EventProvider`（SSE）が、失効したセッションで再試行を止め、
`/api/auth/check` の `200 false` でもトークンを消すようになった。**開いている
画面をログイン画面へ移すには、保護ルートのレイアウトに `onSessionEnded` の
購読を 1 行足す**必要がある（下記参照）。足さない場合も、失効したセッションでの
API はサーバーが `401` で拒否するので認可は破られないが、画面への反映は次に
ルートガードが再評価されるとき（再読み込みや明示的な `invalidateAll()` など）に
なる。同じレイアウトの中の通常の画面遷移だけでは、ログイン画面へ移ることは
保証されない（SvelteKit はレイアウトの `load` を再実行しない場合がある）。

- fix(admin-core): 失効したセッションで、SSE（`/api/events`）が再試行を続け、
  `/api/auth/check` の `200 false` でもトークンが残る問題を修正（#241）。
  - `check()`（`createHttpAuthProvider`）は、`401` に加えて `200 false`（失効が
    確認できた）でも保存しているトークンを消す（Remember me の localStorage も）。
    消すのは確認したトークンがまだ保存されているときだけ（確認中に新しくログイン
    したトークンは消さない）。`500`・到達不能では従来どおり消さずに reject する。
  - SSE のクライアントは、再接続が `401` なら、そのトークンでの再試行をやめ、
    別のトークン（再ログイン）が現れるまで要求しない。`500`・到達不能・
    ストリームの終了は従来どおり 3 秒ごとに再試行する。
  - `connectEvents` は SSE の `401` を受けると `check()` で確認し（ここで
    トークンが消える）、`false` のときだけ新しい `onSessionEnded` の購読者に
    知らせる。SSE は失効したトークン・消えたトークンごとに 1 回だけ知らせ、重なった
    確認は、先に通知したあとなら通知しないので、同じ失効の通知は 1 回。確認の
    途中で届いた新しい知らせは、その確認の結果（`valid` を含む）では打ち消さず
    もう一度確認する（#242 の再レビュー対応）。画面の遷移で失効に気付いた経路は
    ルートガードが自分でログイン画面へ移し、トークンの消去は確認したトークンに
    限るので、2 つの経路が互いを巻き戻さない。
  - 確認が照合できない（`500`・到達不能・10 秒応答なし）ときは、失効した
    トークンでの SSE の再送は止めたまま、確認だけを 1 秒から倍々（上限 30 秒）の
    間隔で再試行する（`createSessionEndConfirmation`）。10 秒を過ぎて届いた
    `200 false` はトークンを消し、次の再試行がトークン無しで（要求を送らずに）
    失効を確定して知らせる。`confirmSessionEnded` の戻り値は
    `'ended' | 'valid' | 'unknown'`。
  - 別のタブが Remember me の共有トークン（localStorage）を先に消した場合:
    SSE は再接続のときに「使っていたトークンが消えた」ことを検知し
    （`EventSubscriptionHooks.onTokenCleared`）、同じ確認に渡すので、後のタブも
    ログイン画面へ移る。初回のログイン前の待機と、新しいログインによる置き換えは
    これに当たらない。
  - 購読者がいないとき（最初の保護ルートの読み込み中・ログイン画面）に確定した
    失効は覚えておき、次に `onSessionEnded` を購読したときに `check()` で確認し
    直してから知らせる（#242 の 3 回目のレビュー対応）。確認し直すので、その間に
    新しくログインしていれば古い失効では追い出さない。購読の呼び出しの中では
    購読者を呼ばない（`$effect` の中から購読してよい）。
  - **派生アプリ**: タグを上げるだけで、再試行の停止とトークンの消去は効く。
    **開いている画面をログイン画面へ移すには、保護ルートのレイアウトに
    `onSessionEnded` の購読を 1 行足す**（admin-template は
    `routes/(app)/+layout.svelte` の
    `$effect(() => onSessionEnded(() => void invalidateAll()));`）。ルートガード
    （`resolveProtectedSession`）が再実行され、ログイン画面（公開閲覧が ON なら
    閲覧者セッション）へ移る。足さない場合、画面への反映は次にルートガードが
    再評価されるとき（再読み込みや明示的な `invalidateAll()` など）になり、同じ
    レイアウトの中の通常の画面遷移だけではログイン画面へ移ることは保証されない
    （失効したセッションでの API は、サーバーが `401` で拒否する）。
    `EventProvider` を自前で実装している場合、`subscribe` の第 2 引数
    （`EventSubscriptionHooks`、任意）は無視してかまわない。`connectEvents` の
    戻り値の関数は、購読の解除と一緒に確認の再試行も止める。
  - E2E: 別のブラウザで Remember me ログインした閲覧者の画面が、管理者による
    パスワードのリセットのあとログイン画面へ移り、トークンが消え、SSE の再試行が
    止まることを確かめるシナリオ 13b と、同じブラウザの 2 つのタブで Remember me の
    トークンを共有し、片方が消したあと両方がログイン画面へ移ることを確かめる
    シナリオ 13c、最初の保護ルートの読み込み中（レイアウトが購読を始める前）に
    失効が確定してもログイン画面へ移ることを確かめるシナリオ 13d を追加。

## [1.7.1] - 2026-09-25

**v1.7.1 — グリッドの初回クリック取りこぼしの修正と、`AuthState::revalidate` の公開。破壊的変更は無い。**
v1.7.0 から上げるだけで直り、`@banto/grid-svelte` を使っている派生アプリの
追従作業は不要。`revalidate` の公開は可視性を広げるだけの追加で、派生アプリは
自前の長時間ストリームの再検証に使える（使わなければ変更不要）。

- feat(banto-server): `AuthState::revalidate` を `pub` にした（#239）。
  `authenticate` と同じ照合（再バインドの扱いを含む）をしつつ、無操作期限
  （idle）のタイマーを延ばさない再検証で、`/api/events` の定期再検証
  （#231）が使っているのと同じもの。派生アプリが自前の長時間ストリーム
  （banto-industrial の `/api/tag-stream`・`/api/v1/stream`、
  banto-industrial#430）で同様の再検証をできるようにするための公開。破壊的
  変更ではない（既存の可視性を広げるだけ）。

- fix(grid): グリッドの下端が画面の外に出ているとき（画面を開いた直後に多い）、
  行をクリックするとセルは選択されるのに `onRowClick` が呼ばれない問題を修正
  （#236）。セルの `pointerdown` でグリッドにフォーカスを移す際、グリッドを
  見せようとページがスクロールし、ボタンを離した位置が別の要素になって `click` が
  セルに届いていなかった。フォーカスの移動を `preventScroll` にした（キー操作での
  選択移動のスクロールは従来どおり）。v1.6.0 以前からある挙動で、#222〜#227 の
  変更は原因ではない。単体テスト（読み込み直後・再取得中のクリック）と、ユーザー
  一覧を開いた直後のクリックで編集パネルが開く E2E を追加。

## [1.7.0] - 2026-09-24

**v1.7.0 — セッション失効・添付ストレージの堅牢化とグリッド操作の安定化リリース。**
v1.6.0（2026-09-14）以降の PR #222〜#234（12 件、#204/#205/#206/#207/#208/#209/
#210/#211/#212/#213/#214/#231）をまとめる。

**破壊的変更（派生アプリはタグを上げる前に確認）**:

- **`banto_server::AuthState` の全コンストラクタ（`new`/`with_policy`/
  `with_policies`）が `SessionValidation` を必須引数に取るようになった**（#204）。
  タグを上げると既存の呼び出しはコンパイルエラーになる。**実アカウントを持つ
  アプリでは、アカウントと照合する `SessionValidation::Lookup` を組み込む。**
  `SessionValidation::DisabledNoRevocation` はアカウントの保存先を持たない
  テスト・公開閲覧専用サーバ向けで、削除・降格・パスワード変更によるセッション
  失効は行われない（コンパイルエラーを消すためだけに選ばないこと）。移行手順は
  下記 #204 の項目に手順 1〜6 で記載。
- **PostgreSQL では環境変数 `BANTO_ATTACHMENTS_DIR` が必須になった**（#208）。
  未設定だと `banto-serve` は起動しない（作業ディレクトリ基準の既定値は廃止）。
  SQLite は変更なし。移行手順（旧保存先からのコピー）は下記 #208 の項目に記載。

- feat(forms/settings): 保存型の画面で未保存の変更を示し、保存せずに離れようとしたら
  確認する（#214、P2）。対象は商品の新規作成・詳細、設定の「サーバ・接続」
  「セキュリティ」と「アカウント」のパスワード変更。未保存の間は保存ボタンの横に
  「未保存の変更があります」を出し、商品フォームには「一覧へ戻る」（＝取り消し）、
  設定には「変更を取り消す」を足した。「サーバ・接続」「セキュリティ」には、
  「保存して適用」を押すまで反映されない（外観・言語はすぐ反映される）ことを短く書いた。
  確認は既存の削除確認と同じ `window.confirm`。再読み込み・タブを閉じるは
  ブラウザ標準の確認、Tauri のウィンドウを閉じるときも確認する（未保存の間だけ
  close-requested を購読。capability に `core:window:allow-destroy` を追加）。
  変更なし・値を元に戻した・保存に成功した・取り消した後は確認しない。保存中の
  離脱は確認し、離脱後に保存が終わっても元の画面へ引き戻さない。ログイン画面への
  移動（ログアウト・セッション失効）は確認しない。ドラフトの復元はしない（保存先・
  古いドラフト・複数タブの扱いが要るため、確認のみ）。

  **`@banto/forms` の追加 API**（破壊的変更なし）: `guardUnsavedChanges(options)`
  （コンポーネント初期化中に呼ぶ）、`hasUnsavedChanges()`（リアクティブ。どれか
  1 つでも未保存なら `true`）、`UnsavedChangesNotice`（未保存マーカー）、
  `FormStore.markClean()`（今の値を「保存済み」にする）。判定表は純関数
  `decideLeave` / `runLeaveCheck` で公開。パッケージは SvelteKit に依存しないため、
  `beforeNavigate` は呼び出し側が渡す。同じ画面に複数のガードがあっても、確認は
  1 回だけ出る。`guard.canAutoNavigate` は、離脱を承認して遷移中の間（遷移先の
  読み込み中を含む）とアンマウント後に `false` になり、遷移が中止・失敗すると
  `true` に戻る。保存後の自動遷移はこれを見て行う（`guard.leaving` /
  `guard.disposed` も個別に読める）。

  **保存済みの値を読み込んで下書きと比べる画面**（「サーバ・接続」「セキュリティ」）は、
  保存済みの値が取れるまで入力と保存を無効にし、取得に失敗したら「再読み込み」を出す。
  取得前の下書きは比べる相手がないため、編集を許すと未保存として検知できない。
  派生アプリで同じ作りの画面を守るときも、同じようにすること。

  **派生アプリでの使い方**（タグを上げたあと、保存型の画面ごとに）:

  ```ts
  import { beforeNavigate, goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { guardUnsavedChanges } from '@banto/forms';

  const guard = guardUnsavedChanges({
  	isDirty: () => store.isDirty, // 自前の下書きなら「下書き !== 保存済みの値」
  	isSaving: () => saving, // 保存中も離脱を確認する
  	beforeNavigate,
  	message: () => '保存していない変更があります。変更を破棄してこの画面から移動しますか？',
  	isForced: (nav) => nav.to?.url.pathname === `${base}/login` // ログアウト等は確認しない
  });

  // 保存に成功したら、移動の前に「未保存でない」状態にする（保存中フラグも先に下ろす。
  // 立ったままだと、この goto にも確認が出る）
  store.markClean(); // FormStore の場合。自前の下書きは保存済みの値に揃える
  // 利用者が別の画面を選んだあと（遷移先の読み込み中も含む）は、保存後の自動遷移をしない
  if (guard.canAutoNavigate) await goto(`${base}/list`);
  ```

  マーカーは `<UnsavedChangesNotice pending={guard.pending} label="未保存の変更があります" />`。
  admin-template では `$lib/unsavedChanges.ts` が `beforeNavigate`・文言・
  `isForced` を束ねた薄い包みなので、これを写して使うのが早い。Tauri の
  ウィンドウ終了も確認するなら、`$lib/banto/windowCloseGuard.ts` と
  `(app)/+layout.svelte` の `$effect`（`hasUnsavedChanges()` が `true` の間だけ
  `guardWindowClose` を登録）を写し、capability に `core:window:allow-destroy`
  を足す（close-requested を JS で購読すると、閉じる処理を JS の `destroy()` が
  行うため。足さないと未保存の間はウィンドウが閉じられなくなる）。

- fix(attachments): `BANTO_DB` が PostgreSQL の接続 URL のときも、その文字列を
  ファイルパスとみなして添付の保存先を作っていた問題を修正（#208、P2）。同じ
  サーバーの別の DB（`…/banto_a` と `…/banto_b`）が同じ保存先を共有して、
  id が同じ添付の本体を上書きしていた。パスワードを変えると保存先が変わって
  既存の添付を見失い、保存先のパスには接続の資格情報が入っていた。
  - **PostgreSQL では新しい環境変数 `BANTO_ATTACHMENTS_DIR` が必須**。その下に
    DB ごとのサブディレクトリ `pg_<ホスト>_<ポート>_<DB名>_<ハッシュ16桁>` を作る
    （ユーザー名・パスワードは含めない。変えても保存先は変わらない。ホスト名の
    書き方 `localhost`/`127.0.0.1`、ポート、DB 名を変えると別の保存先になる）。
    **未指定なら `banto-serve` は起動しない**（作業ディレクトリ基準の既定値は
    作らない）。**SQLite は変更なし**（DB ファイルの隣の `attachments`。
    `BANTO_ATTACHMENTS_DIR` は使わず、設定されていれば警告だけ出す）。
  - **本体を上書きしない**: 本体は `create_new` で書き、同じ id のファイルが
    既にあればアップロードを失敗させる（行も残さない）。
  - `banto-serve` の起動ログ（`DB at …`）と、`postgres` feature 無しで PostgreSQL
    URL を渡したときのエラーから、接続の資格情報を除いた（`db::display_target`）。
    形が曖昧な URL（資格情報にエスケープされていない `?`/`#`/`/`/`@` がある等）や、
    スキームの誤った接続文字列は、入力を含まない固定の表記（`postgres://<redacted>` /
    `<redacted>`）で表示する。
  - 追加 API（`banto-attachments`）: `base_dir_for_target` / `postgres_storage_key` /
    `sqlite_base_dir` / `legacy_base_dir`、`AttachmentsService::import_legacy_files`
    と `LegacyImportReport`。`admin-template-core`: `db::display_target`。既存の
    API の変更は無い。

  **移行手順**（PostgreSQL で `banto-serve` を動かしていた場合。SQLite は不要）:
  1. 添付の保存先にするディレクトリを決め、`BANTO_ATTACHMENTS_DIR` に設定する
     （絶対パスを推奨。相対パスは作業ディレクトリ基準になる）。
  2. **これまでと同じ作業ディレクトリ・同じ `BANTO_DB`** で起動する。起動時に、
     旧保存先（作業ディレクトリ下の、接続 URL から作られた `postgres:` /
     `postgresql:` で始まるディレクトリ）から、その DB の添付を新しい保存先へ
     **コピー**する。各ファイルは DB に記録した sha256 と照合し、一致したものだけ
     移す（旧保存先は複数の DB で共有されていたため、別の DB のファイルや上書き
     されたファイルは移さない）。旧保存先のファイルは成功しても失敗しても**消さない**。
     コピーは処理ごとに一意な一時ファイルに書いてからハードリンクで確定するので、
     複数のプロセスが同時に移行しても、既存のファイルを上書きせず、書きかけの
     ファイルも残さない（ハードリンクが使えないファイルシステムでは「失敗」に数え、
     旧保存先に残す）。新しい保存先に既にある本体も sha256 を照合し、DB の値と
     違えば上書きせずに警告として数える。結果は件数でログに出る。移せなかった分
     （サムネイルだけ欠けた分も含む）は、原因を直して再起動すれば再試行される
     （移行済みの分は飛ばす）。旧保存先は**いまの** `BANTO_DB` から求めるので、
     以前ユーザー名やパスワードを変えていて旧保存先が複数あるときは、古いほうの
     中身をいまの旧保存先へコピー（上書きしない）してから再起動する。
  3. 同じ接続先の DB をすべて起動し終え、添付が開けることを確かめたら、旧保存先の
     ディレクトリを手で消す（ディレクトリ名に接続の資格情報が入っている）。
     「別の DB のファイル」が残った添付は、#208 の上書きですでに本体が失われて
     いる可能性がある。
  - **派生アプリ**（`banto-attachments` をタグで使い、自前で `AttachmentsService::new`
    を呼ぶアプリ）: PostgreSQL で動かすなら、保存先を `base_dir_for_target` で
    求め、旧保存先がある場合は `import_legacy_files` を起動時に呼ぶ（`banto-serve.rs`
    の該当箇所が手本）。SQLite だけなら対応は不要。

- fix(auth): ユーザーの削除・降格・パスワード変更・パスワードリセットで既存の
  セッションが失効しなかった問題を修正（#204、P1）。`users.auth_epoch`（認証の世代、
  migration `0007`）を追加し、セッションを確立時の「行 id + 世代」に結び付けて、
  REST（`require_auth`）と Tauri（`require_role`）の両経路で**要求ごとに DB と照合**
  する。アカウントが無い・世代が違えば失効（401）、一致すれば DB の今のロールで
  認可する。変更はどちらの経路から行っても、他方の経路・別プロセス・Remember me の
  セッションにも効く。自分のパスワード変更では、変更した当のセッションだけ残る
  （[ADR-0014](docs/adr/0014-account-bound-session-revocation.md)、conventions §6）。
  **Rust API の破壊的変更（タグを上げると必ずコンパイルエラーになる）**:
  `banto_server::AuthState` のすべてのコンストラクタ（`new`/`with_policy`/
  `with_policies`）が `SessionValidation` を**必須の引数**に取る（既定値は無い）。
  `SessionValidation::Lookup`（アカウントと照合する。実アカウントでは唯一の選択肢）か、
  `SessionValidation::DisabledNoRevocation`（照合しない＝従来の挙動。アカウントの
  保存先を持たないテスト・公開閲覧専用サーバのためだけ）を名前で選ぶ。ほかに
  `banto_admin_services::users::UserIdentity` に `auth_epoch` を追加、
  `UsersService::change_password` が新しい世代（`i64`）を返す、
  `banto_server::LoginOutcome` に `Unavailable` を追加（`POST /api/auth/login` が
  503 を返し得る）。`/api/auth/{check,identity}` は照合中の DB エラーを 500 で
  返す。

  **フロントエンド（`@banto/admin-core`）の挙動変更**: `AuthProvider.check()` は、
  セッションが無効と**確認できたとき**（トークン無し・`401`・`200 false`）だけ
  `false` を返し、サーバーが照合できなかったとき（`500`・接続不能）は
  `ProviderError` で**reject** する（従来は `false`。一時的な DB エラーで
  ログイン画面へ飛ぶ・閲覧公開 ON なら閲覧者トークンで元のトークンを上書きする、
  が起きていた）。保護ルートの判断は新しい `resolveProtectedSession(auth)` に
  まとめた（`'session' | 'publicViewer' | 'login'` を返し、照合できなければ
  reject。reject 時は `status()`・`enterPublicViewer()` を呼ばず、トークンにも
  触れない）。admin-template の `(app)/+layout.ts` は reject を 503 のエラー画面
  （新設の `routes/+error.svelte`、再試行ボタン付き）にし、`panel/[id]` は
  「確認できませんでした」を表示する。Tauri の `auth_check` も DB エラーは
  `Err`（reject）で、同じ区別になる。

  **派生アプリの移行手順**（`banto-server` をタグで使い、`users` テーブル・
  サービス・`src-tauri` を自前で持つアプリ）: タグを上げると `AuthState::new(verifier)`
  などの呼び出しが**コンパイルエラー**になる。そこで、**照合を組み込む**（手順 1〜5）
  か、**明示的に無効化する**（`SessionValidation::DisabledNoRevocation` を渡す。
  失効は起きないまま。実アカウントを持つアプリでは選ばない）かを選ぶ。

  1. **マイグレーション**: 両方の方言に 1 本ずつ足す（既存の行は 0 で始まる。
     セッションはメモリにしか無いので既存セッションの移行は不要）。
     SQLite: `ALTER TABLE users ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;`
     / PostgreSQL: `ALTER TABLE users ADD COLUMN auth_epoch BIGINT NOT NULL DEFAULT 0;`
  2. **ユーザーサービス**（自前の `users.rs` を持つ場合。`banto_admin_services` の
     `UsersService` を使うなら不要）: `UserIdentity` に `auth_epoch` を持たせ、
     `verify`・`get_by_username` の `SELECT` と作成時の `RETURNING` で読む。
     ロール変更（`auth_epoch = auth_epoch + CASE WHEN role = ? THEN 0 ELSE 1 END`）・
     パスワード変更・パスワードリセットの **`UPDATE` と同じ文で**増やす。
     パスワード変更は `RETURNING auth_epoch` で新しい世代を返す。
  3. **REST の `AuthState`**: `AuthState::new(verifier, SessionValidation::lookup(lookup))`
     にする。`lookup` はユーザー名から `SessionAccount { identity（今のロール）,
stamp: SessionStamp { account_id: 行 id, auth_epoch } }` を返す（無ければ
     `Ok(None)`、DB エラーは `Err`。ログイン時は入力どおりのユーザー名で呼ばれるので、
     ユーザー名を正規化する検証関数なら lookup も同じ正規化をする）。
     `banto_admin_services::UsersService` なら
     `banto_server::routes::user_auth_state(users, audit)` で済む。テストで固定の
     検証関数を使う箇所は `SessionValidation::DisabledNoRevocation` でよい。
  4. **REST のハンドラ**: `require_auth` の**外**でトークンから本人を引く箇所
     （自前の `change-password` など）は `auth.identity_for(token)` をやめ、
     `auth.authenticate(token).await?` を使う。`require_auth` の後ろの
     `identity_for`・自前のロールガードはそのままでよい（照合のたびに今の値へ
     書き戻される。ガードは `req.extensions()` の `AuthenticatedSession` も読める）。
     初期セットアップで作ったアカウントをそのままログインさせる箇所は
     `issue_token` を `issue_account_token(SessionAccount { .. }, false)` に替える
     （世代の無いトークンは拒否される）。自分のパスワード変更の後、そのセッションを
     残すなら `new_epoch == stamp.auth_epoch + 1` のときだけ
     `auth.rotate_session_epoch(token, stamp, new_epoch)` を呼ぶ。
  5. **`src-tauri`**（banto の型では強制できないので、ここは移行手順どおりに行う）:
     ウィンドウのセッションを `Mutex<Option<UserIdentity>>` から admin-template の
     `DesktopSession`（`Account` / `AuthDisabledLocal` の enum）に替える。こうすると
     セッションを作る箇所・読む箇所がすべてコンパイルエラーになり、種類の選択と
     照合の通し忘れを型で拾える。`require_role` の先頭で `current_session` を通し、
     `Account` は `users.get_by_username` で読み直して行 id と `auth_epoch` が
     一致しなければキャッシュを消して `Unauthorized`、一致すれば**読み直した値**
     （今のロール）で判定する。`AuthDisabledLocal` はログイン不要モードが今も ON かを
     読み直す（OFF なら消す）。合成セッションを `id == 0` のような値で判定しない。
     キャッシュの書き換えは、読む前の値と比べてから行う。`auth_check`・
     `auth_identity` も同じ照合を通す `async` コマンドにし、`change_own_password` は
     新しい世代へキャッシュを付け替える（合成セッションからは `Forbidden`）。
     admin-template の `DesktopSession` / `current_session` / `require_role` /
     `change_own_password`（`apps/admin-template/src-tauri/src/lib.rs`）をそのまま
     写せる。組み込みサーバの `rest_auth` も手順 3 の状態で作る。
  6. **フロントのルートガード**（`@banto/admin-core` を更新すると `check()` が
     reject し得るようになる）: `(app)/+layout.ts` をコピーして持っている場合は、
     `check()` → `status()` → `enterPublicViewer()` の手書きの分岐を
     `resolveProtectedSession(getAuthProvider())` に置き換え、reject は
     `/login` への遷移にも閲覧者への切り替えにもせず、エラー画面と再試行にする
     （admin-template の `(app)/+layout.ts` と `routes/+error.svelte`、メッセージ
     キー `app.sessionCheckFailed.*`・`app.error.*` を写せる）。そのままでも
     reject は SvelteKit の既定のエラー画面になり、トークンは消えない。
     `check()` を直接呼ぶ他の画面（admin-template では `panel/[id]`）も reject を
     「未ログイン」と区別する。

- fix(auth): 失効したセッションで開いたままの SSE（`/api/events`）が通知を受け
  続けた問題を修正（#231、#204 の既知の制約）。開いているストリームは keepalive と
  同じ 15 秒（`banto_server::events::REVALIDATE_INTERVAL`）ごとにセッションを
  照合し直し、アカウントの削除・降格・パスワード変更/リセット・ログアウト・期限切れで
  失効していればストリームを終える（失効から最大 1 間隔）。DB が照合に答えられない
  ときは終えず、次の間隔で照合し直す（#204 の「照合できないときはセッションを残す」）。
  照合は 5 秒（`REVALIDATE_TIMEOUT`）で打ち切り、打ち切りも同じ扱い。次の照合は
  前の照合が終わってから 1 間隔後なので、照合が遅くても通知の配信は止まらない。
  照合中に自分のパスワード変更で付け替えられたセッションは、要求と同じ判断で残る。
  この照合はセッションの無操作期限（idle）を延ばさない（開いたタブが無操作の
  セッションを生かし続けない）。公開閲覧のセッションと
  `SessionValidation::DisabledNoRevocation` は DB を読まず、アカウントの変更では
  終わらない（トークン自体が終わったときだけ終わる）。照合するのは
  `SessionValidation::Lookup` のアカウントのセッションで、開いているストリーム 1 本
  につき 15 秒に 1 回の索引読み。**派生アプリの対応は不要**（`sse_route` の
  シグネチャは同じ。フロントの `createSseEventProvider` は、終わったストリームを
  従来どおり再接続し、失効したトークンは `401` になる）
  （[ADR-0014](docs/adr/0014-account-bound-session-revocation.md)）。

- fix(users): 管理者の同時降格・削除で管理者が0人になる競合を修正（#207）。
  SQLite・PostgreSQLの両方で判定から更新までをDBトランザクションで保護し、
  最後の管理者への変更を拒否する。REST・Tauri共通のユーザーサービスに適用。

- fix(auth-ui): username が `public` の通常アカウントを公開閲覧セッションと
  誤判定する問題を修正（#209）。トークン発行元が返す `publicViewer` 属性で区別し、
  通常アカウントは自身のロールで操作できる。合成セッションのパスワード変更も
  同名アカウントの有無によらず拒否する。サーバー・admin-core の型と、派生側に
  コピーした session store の変更を合わせて取り込む必要がある。

- test(grid): 絞り込み入力の矢印・Tab・Enterをセル操作から分離する既存修正
  （PR #224）に、専用の回帰検証を追加（#213）。入力・条件選択の標準キー操作と
  条件適用を保護し、文字カーソル・フォーカス移動はブラウザーE2Eでも確認する。

- fix(users-ui): ユーザーの保存待ち中に選択を切り替えても、古い応答が現在の
  編集対象を戻さないよう修正（#206）。同じユーザーを選び直した場合や新しい入力も
  保護し、パスワードリセットの応答も後続の選択へ反映しない。削除成功時は
  同じユーザーを選び直していても編集パネルを閉じ、別ユーザーの選択と入力は維持する。

- fix(grid): インライン編集を行IDに結び付け、一覧の再取得・並べ替え・前方行の削除で
  入力が別レコードへ保存される問題を修正（#205）。編集対象が一覧から消えた場合は
  編集を中止する。保存待ち中にクリックした別セルの選択は維持し、サーバー表示の
  編集対象検索は取得済み行に限定する。クライアント・サーバー表示とグループ化、
  遅延保存中の選択、疎配列の回帰テストを追加。
- fix(grid): 保存待ち中に別の編集を始めた際、先行保存の成功・失敗で新しい入力が
  消去・上書きされる問題を修正（#210）。保存結果と確定後の移動を編集セッションに
  結び付け、同じセルを開き直した場合も古い応答が干渉しないようにする。
- fix(grid): 非編集時のTab/Shift+Tabでフォーカスがグリッド内に閉じ込められる
  問題を修正（#211）。ブラウザー標準の順序で見出しボタン・行リンクを経て
  グリッド外へ移動できるようにする。セル間移動は矢印キーを使い、編集中の
  Tab/Shift+Tabによる確定・左右移動は維持する。
  移動先の見出し・絞り込み・行リンクのキー操作が選択セルの編集や移動に
  奪われないよう、セル操作をグリッド本体からのキーイベントに限定する。
- fix(grid): Enter・Tabでの編集確定やEscapeでの取消後にフォーカスが外れ、
  キーボードだけで連続操作できない問題を修正（#212）。保存待ち中に他の要素へ
  移動した場合や新しい編集を始めた場合は、そのフォーカスと選択を維持する。
  商品の更新APIが返した行を次の編集へ反映し、一覧再取得が遅れても異なる列の
  連続保存で直前の変更を古い値に戻さない。
  サーバー一覧の再取得結果はまとめて切り替え、途中の空配列で編集・選択が
  解除されることを防ぐ。旧世代の行と新しい取得結果は混在させない。

## [1.6.0] - 2026-09-14

**v1.6.0 — 設定画面のページ分割。** v1.5.0（同日）以降の PR #197・#198 をまとめる。
変更は app 層（`apps/admin-template`）のみで、**`@banto/*` パッケージと `banto-*`
クレートは版数が 1.6.0 に上がるだけで実装内容は v1.5.0 と同一**（公開 API の
変更なし。タグ参照で消費している側に追従作業は無く、v1.5.0 のまま留まっても
差は無い。テンプレートを再同期する派生アプリだけが対象）。後方互換の機能追加の
ため minor。

- 設定画面をカテゴリごとのルート `/settings/{appearance,account,connectivity,data,security}`
  に分割（共通レイアウトに sticky の左レール / 狭い画面は横タブ、`/settings` と
  非可視カテゴリは先頭の可視カテゴリへリダイレクト）。派生アプリは「ルートを足す」
  形で設定を拡張できる。段階 1（section コンポーネント分割、挙動不変）を経て実施
  （[docs/choiapp-feedback-2026-09.md §3.1/§3.2](docs/choiapp-feedback-2026-09.md)）。

- refactor(settings): 設定画面をカテゴリごとの section コンポーネントに分割
  （`AppearanceSection` / `AccountSection` / `ConnectivitySection` /
  `DataSection` / `SecuritySection` + `settings.css` + 共有ストア 2 本。
  `+page.svelte` 1,812 行 → 約 110 行）。挙動・DOM・e2e/visual は不変
  （`main` の outerHTML 比較で `settings-page` クラス追加とコンポーネント境界の
  コメントノード以外に差分なし）。scaffold の glass remover の anchor を
  `AppearanceSection.svelte` に追従（4 プリセット `--dry-run --strict` 通過）。
  ページ分割（カテゴリごとのルート化）の前段
  （[docs/choiapp-feedback-2026-09.md §3.1](docs/choiapp-feedback-2026-09.md)）。
- feat(settings): 設定画面の5カテゴリ（外観・言語/アカウント/サーバ・接続/
  データ管理/セキュリティ）を実ルート（`/settings/{appearance,account,
connectivity,data,security}`）に分割。`/settings` は先頭の可視カテゴリへ
  307 redirect、非可視カテゴリへの直接遷移も同様に先頭へ redirect（挙動:
  URL 構造が変わる - ブックマーク/ディープリンクは新しいパスを使うこと）。
  カテゴリナビは ≥1024px で左レール（sticky）・それ未満で横タブ。
  section コンポーネント/`settings.css`/ストアは移動なし。e2e smoke
  シナリオ 11 と visual/a11y の settings 系エントリを更新
  （[docs/choiapp-feedback-2026-09.md §3.2](docs/choiapp-feedback-2026-09.md)）。

## [1.5.0] - 2026-09-14

**v1.5.0 — 「表示専用アプリを配れる」リリース。** v1.4.0（2026-08-29）以降に
main へ積まれた PR #182〜#184・#191〜#195 と dependabot 更新をまとめる。
**JSON ワイヤは項目追加のみ**（`GET /api/auth/status` の `viewerPublic`、
`SystemInfo.metrics`）で既定挙動は不変だが、**Rust 消費側にはソース互換の
破壊がある**（下記「消費側への注意」の 4 点。いずれもテンプレートからコピーした
`src-tauri/src/lib.rs` / `core/src/rest/mod.rs` が直接触る箇所）。公開 API の
削除・改名は無く、v1.4.0（sqlx 0.9 移行）と同じくオーナー判断で **minor** とする
（1.x 系では「消費側の追従作業を CHANGELOG のリード文に明記した上で minor」
を運用とする。docs/publishing.md「バージョニング規約」参照）。主な内容:

- **閲覧公開モード**（#189、ADR-0012）: LAN 端末がログイン無しで `viewer` 固定の
  合成セッションを得て閲覧できる。書き込みは常にログイン必須。
- **CPU/メモリ使用率の共通 API**（#185、ADR-0013）: `sysinfo` を feature
  `system-metrics` 限定で採用。下流アプリは自前の `sysinfo` 実装を
  `SystemMetricsSampler` に寄せ替えられる。
- **`pnpm scaffold --preset display`**（#190）: items 雛形・管理画面・
  ダッシュボードを外し、ログイン不要 + 閲覧公開 + キオスク表示を初期状態にする
  表示専用アプリ向けプリセット。本体側にはキオスク表示トグル・初回起動 seed 機構・
  `banto.i18n` opt-out が既定 OFF で入る。
- チョイアプリ・フィードバック対応（#182〜#184）: 固定シェル・設定カテゴリ・
  ナビバッジ・「ログインなしで使い始める」。

**消費側への注意（Rust、v1.4.0 → v1.5.0 の追従作業）:**

- `banto_admin_services::settings::ServerSettings` に `viewer_public: bool` が増えた。
  構造体リテラルで組み立てている箇所（テンプレートの `server_apply`）は
  `viewer_public` を足すか `..Default::default()` を使う。
- `banto_server::routes::SystemInfo` に `metrics: Option<SystemMetrics>` が増えた。
  Tauri 側の `system_info` コマンドで組み立てている箇所は `metrics: None`（または
  `system-metrics` feature の `SystemMetricsSampler` で取得した値）を足す。
- `banto_server::routes::extra_auth_router(users, auth, audit, allow_setup)` が
  `(…, allow_setup, settings: SettingsService, status_extras: Option<AuthStatusExtras>)`
  になった。テンプレートどおり `settings.clone()` と `None` を渡す。
- `banto_server::routes::system_info_router(service, auth, audit)` が
  `(…, audit, metrics: Option<MetricsProbe>)` になった。`None` で従来どおり。
- `sysinfo` は Windows で `windows` 0.62 系を引く（`src-tauri` の 0.61 系と並存）。
  不要なら `system-metrics` feature を `default` から外す（README「オプション資産の
  削除」）。

- feat(scaffold): `pnpm scaffold --preset display`（#190、PR-D2、
  [docs/display-preset-plan.md](docs/display-preset-plan.md) §3.2）— カンバン/常設
  ダッシュボード/展示デモ向けの**表示専用アプリ**を1コマンドで作れるようにした。
  `minimal` の7資産に加えて、新 remover **`items`**（デモリソース一式: サービス層・
  REST・Tauri コマンド・マイグレーション・画面・ナビ・文言・`verify-architecture` の
  マニフェスト行）、**`adminPages`**（users / audit-log の**画面のみ**。サービス層・
  REST・Tauri は escape hatch として残す）、**`dashboard`**（`/dashboard` を外し
  ホームを `/monitor` へ）を削除し、唯一の「足す」工程 **`displayDefaults`** が
  `/monitor` ページ雛形（`$effect` + 世代トークンのポーリング例）・ナビ項目
  （`publicViewer: true`）と、PR-D1 で本体に入れたトグルの既定値の反転
  （`FIRST_BOOT_SETTINGS` = 認証無効 + 閲覧公開 + LAN 有効 / `KIOSK_DEFAULT` /
  `banto.i18n = "raw"`）を適用する。e2e は items/users 前提のスイート
  （`tests/smoke.spec.ts` の全シナリオ・`tests-public-viewer/`・`visual/`）を
  シナリオ1本（未ログインの `/` が `/monitor` に着く）に差し替える。
  `template-acceptance.yml` の `presets` matrix に `display` を追加。
  `template-scope.md` §3 は `items` を「デモリソース（display で削除可）」に再分類。
- fix(scaffold): attachments remover が `core/src/rest/tests.rs` を
  「M20 章から EOF まで」削っていたため、その後に追記された閲覧公開スイート
  （Issue #189）まで巻き添えで消えていたのを修正（終端マーカーで範囲を閉じた）。
  `minimal` / `standard` プリセットの `cargo test -p admin-template-core` に
  閲覧公開の 6 テストが戻る。
- feat(shell/scaffold): `--preset display`（#190）の準備 PR-D1 — テンプレート本体に
  既定 OFF のトグルを足す（[docs/display-preset-plan.md](docs/display-preset-plan.md)
  §2「display が足すものは先に本体のトグルにする」）。①初回起動 seed 機構
  `admin_template_core::first_boot::FIRST_BOOT_SETTINGS`（既定は空。`settings`
  テーブルが空のときだけ書き込む。`banto-serve` / Tauri 起動時に M11 の判定より前に
  実行）、②キオスク表示トグル（UI 設定 `shell.kiosk`。ON でサイドバー折り畳み既定・
  ヘッダーコンパクト（`--banto-shell-header-height-compact`）・全画面ボタン
  （ブラウザ Fullscreen API / Tauri `setFullscreen`、capability
  `core:window:allow-set-fullscreen` を追加）。設定画面「外観・言語」に追加、
  visual スペック 1 枚追加 — ベースラインは `visual-baselines.yml` で生成）、
  ③`apps/admin-template/package.json` の `banto.i18n = "keys" | "raw"`
  （`raw` で `raw-jp-in-app` と `check-i18n-nonempty` を理由付きでスキップ、
  conventions §13）、④items デモ区画に `// [scaffold:items] begin/end` マーカー
  （`rest/tests.rs` の items テストを 1 ブロックに集約。挙動不変、テスト件数不変）。
  付随: コマンドパレット remover の Header.svelte anchor をキオスク分岐に追従
  （3 プリセットの `--dry-run --strict` で確認）。

- feat(auth): 閲覧公開モード（viewer-public、#189）— 「認証を外す」を書き込み軸
  （従来の M11、デスクトップ限定）と閲覧公開軸（新設）に分けた。
  `server.viewerPublic` を ON にすると LAN クライアントは
  `POST /api/auth/public-viewer` で **`viewer` 固定の合成セッション**
  （ユーザー名 `public`、同時 256 まで・古い順に失効）を得てログイン無しで
  閲覧でき、`GET /api/auth/status` が `viewerPublic` を返す（アプリ固有
  フィールドを足す `AuthStatusExtras` フックも追加）。「認証無効 + LAN 有効」の
  排他は閲覧公開 ON のときだけ緩む（両方向のバリデーション）。フロントは
  `(app)` のゲートが合成セッションを透過的に取得し、`NavItem.publicViewer`
  の許可リスト（既定 dashboard / items）で画面を絞り、ヘッダは「ログイン」
  ボタンに切り替わる。書き込みは合成セッションから常に 403 + `denied` 監査。
  設計は [docs/viewer-public-plan.md](docs/viewer-public-plan.md)、方式選定は
  [ADR-0012](docs/adr/0012-lan-public-viewer-synthetic-session.md)、
  手順は [docs/recipes/no-login-app.md](docs/recipes/no-login-app.md)。
  `banto-serve` は `BANTO_VIEWER_PUBLIC=1` で seed 可。e2e に
  `public-viewer` プロジェクト（別ポートの 2 本目の banto-serve）を追加。

- feat(system-info): System Info カードに CPU/メモリ（ホスト total/used・
  スワップ・プロセス RSS・CPU%・論理コア数）を追加（Issue #185、
  [ADR-0013](docs/adr/0013-sysinfo-system-metrics-feature.md)）。`sysinfo`
  （`default-features = false, features = ["system"]`）を `banto-admin-services`
  の opt-in feature `system-metrics` に限定して採用 - conventions §3
  「依存を足す側の例外」の2件目（Paraglide/ADR-0005 に続く）。
  `banto_server::routes::SystemInfo` に `metrics: Option<SystemMetrics>` が
  増えるのみで既存フィールドは不変（後方互換、REST/Tauri 対称は維持）。
  テンプレート側（`admin-template-core`/`src-tauri`）は既定でこの feature を
  有効化（README「オプション資産の削除」に外し方）。実測バイナリ増分:
  `admin-template-core --bin banto-serve` の release ビルド（`embed-ui` 無し）
  で 8,996,864 → 9,048,576 bytes（+51,712 bytes、約 +50.5 KiB、+0.6%）。

- ci(visual): スクリーンショット比較の許容を比率から絶対値へ
  （`maxDiffPixelRatio: 0.001` → `maxDiffPixels: 250`）。比率は fullPage の総画素
  基準だったため縦長ページほど検知が甘く（dashboard 約4,700px / items 約1,300px）、
  実測 568〜828px のヘッダチップ追加が全ページで見逃されていた
  （[docs/choiapp-feedback-2026-09.md §6](docs/choiapp-feedback-2026-09.md)）。
  同一環境の再描画差分は 0px のため 250 はアンチエイリアス用のバッファ。
  以後 Playwright/Chromium/ランナー更新で描画が変わるとスイートは赤くなる
  （意図した挙動。差分確認後に `visual-baselines.yml` で再生成する）。

- ci(visual): ベースライン再生成を `--update-snapshots=all` に変更し、通過中の
  スナップショットも必ず作り直すようにした。既定の `changed` モードは失敗した
  分しか書き換えないため、`maxDiffPixelRatio`（0.001）に収まる小さな変更は
  ベースラインが古いまま残り、ズレが蓄積していた（実例: 2026-09 のヘッダ
  ステータスチップは dashboard/items/users で可視だったが許容内で通過し、
  ベースラインは存在しないヘッダを写したままだった）。許容量が fullPage の
  総画素比であることに由来する検知限界も `e2e/visual/README.md` に明記。

- feat(shell/settings): チョイアプリ・フィードバック対応
  （[docs/choiapp-feedback-2026-09.md](docs/choiapp-feedback-2026-09.md)）—
  ①ヘッダ/サイドバーを sticky 化（本文スクロールから独立）、②設定ページを
  5カテゴリ節 + カテゴリジャンプナビに再編（旧 Danger zone は解体し
  データ管理/セキュリティへ、警告色は `.danger-card` で維持）、③サイドバーの
  未確認更新バッジ（`NavItem.badgeResource` + `$lib/navBadges.svelte.ts`、
  smoke シナリオ 13 で SSE 実経路を検証）とヘッダのステータスチップ
  （デモ/ロール）を追加、④初回セットアップ画面（Tauri）に
  「ログインなしで使い始める」を追加 — `auth_config_apply` にユーザー0人の
  ブートストラップ窓を開け、synthetic session をその場で合成して再起動なしで
  M11 ログイン不要モードに入れる（オーナー承認済み、手順は
  [docs/recipes/no-login-app.md](docs/recipes/no-login-app.md)）。ログイン
  不要モードはチョイアプリの常態のためヘッダにチップは出さない（オーナー
  決定）。付随して `StatusBadge` info 変種のコントラスト不足（4.1:1）を
  `--banto-primary-hover` で修正。

## [1.4.0] - 2026-08-29

**v1.4.0 — `sqlx` 0.8→0.9 移行を主とするリリース。** オーナー判断により
**minor** とするが、消費側にとっては破壊的変更を含む: `banto_storage::connect_sqlite`/
`connect_postgres` の戻り値・`storage_error`/`not_found` が受ける `sqlx::Error` は
sqlx 0.9 の型になるため、消費側（banto-industrial 等）は同じ sqlx 0.9 系へ追従する
必要がある。スキーマ・SQL 文の意味・公開 API の形自体は変更なし。また sqlx 0.9 は
**rustc 1.94.0 以上**を要求するため、消費側のツールチェーンにも影響する。

### 追加

- **グリッドの列表示/非表示（列マネージャー UI）**（issue #168、spec §4.4）。
  `GridColumn.hidden` で「定義は持つが既定では出さない」列を表現でき、
  `GridState` が `setColumnHidden` / `toggleColumnHidden` / `isHidden` /
  `allColumns` で表示状態を所有する（`orderedColumns` は可視列のみを返すため、
  セル選択やコピー&ペーストの列インデックスも自動的に追随する）。切り替え UI は
  新コンポーネント `ColumnsMenu`（ページ側ツールバーに置く。BantoGrid のヘッダ行は
  可視列幅から `grid-template-columns` を組むため、ヘッダ内には入れない）。
  admin-template の商品ページのツールバーに配線済み。
- **`columnsFromSchema` の `order` オプション**（issue #168）。一覧の列順を
  スキーマの定義順（＝フォームの入力順）から切り離して指定できる。列の既定非表示は
  `overrides: { code: { hidden: true } }` で表現する。
- **UI 宣言境界と Discussions 運用の ADR 化 + チャート性能ベンチ**。UI 宣言は
  スキーマ駆動の漸進拡張・追加レンダラは REST
  クライアント境界と決めた判断を ADR-0009 に、Discussions を決定前検討専用と
  する運用を ADR-0010 に記録。roadmap §3 のバックログを「チャート性能
  エスカレーション梯子」（SVG 実測→サーバ側間引き→Canvas→WebGL→ネイティブ
  候補ウォッチ）へ拡張し、template-scope §4.2 に非スコープ2行（クロス
  レンダラ共通ウィジェット DSL / 画面エディタ）、conventions §12 に
  Discussion 参照の文法行を追加。`packages/charts/tests/trend.bench.ts` を
  新設し、ルートの `pnpm bench` を recursive 化した。
- **初期ルールの棚卸し（ADR-0011 + トリガー修正 + PG バックアップ案内）**。
  ADR-0011（git タグ配布）を新設して publishing.md の失効理由を修正し、
  roadmap §3 に実需の供給源3系統（外部採用者/banto-industrial/メンテナ実案件）
  の明示と、判断昇格の記録ルール・12ヶ月時限の運用則を追加した。
  template-scope には i18n 辞書層の反転記録（§4.3/§5）と §7 の2026-08 現況を
  追記し、maintenance-review-2026-08 §2.4 に反転プロトコルと「条件付き判断の
  棚卸し」の定型節を追加した。README（ja/en）に PostgreSQL のバックアップ
  運用（`pg_dump`/`pg_restore`）を案内し、設定画面のバックアップ節も
  PostgreSQL 利用時の出し分け表示に対応した。
- **AI 対話による機能作成の設計方向を記録**。タグ定義・トレンドグループ構成・
  帳票テンプレートをシリアライズ可能な DB データとして持ち、AI アシスタント
  （claude CLI サイドカー + MCP → REST）が対話で作成できるようにする設計方向を
  industrial-plan §5 に追記した（宣言データの範囲 = 対話で作れる範囲、
  ADR-0009 の境界と同一線）。

### 変更

- **`sqlx` を 0.8 系から 0.9 系へ移行**。banto-industrial 側の 0.9 移行が
  `banto-storage` の 0.8 固定でブロックされていたための追従。
  `QueryBuilder<'a, DB>` のライフタイム引数削除（`QueryBuilder<DB>`）に
  伴う内部シグネチャ変更と、`sqlx::query`/`query_as`/`query_scalar` が
  `impl SqlSafeStr` を要求するようになったことに伴う `sqlx::AssertSqlSafe`
  ラップ（動的に組み立てる SQL 文のうち、埋め込む断片が `Dialect`
  由来のプレースホルダ／内部定数のみで外部入力を含まないことを確認した
  箇所のみ）を追加。**破壊的変更**: `banto_storage::connect_sqlite`/
  `connect_postgres` の戻り値・`storage_error`/`not_found` が受ける
  `sqlx::Error` は sqlx 0.9 の型になる（消費側の追従が必要）。
  スキーマ・SQL 文の意味・公開 API の形は変更なし。
- **`SerializedGridState` に `hidden: string[]` を追加（破壊的）**。
  `GridState.serialize()` の出力に列の表示状態が含まれるようになり、
  `hydrate()` は `hidden` を持たない旧ペイロードを**受け付けない**（不正な
  ペイロードと同じく無視され、レイアウトは既定値のまま）。永続化した
  グリッドレイアウトを持つ派生アプリは、保存済みの値が一度リセットされる。

### 修正

- **`items` デモを削除した派生アプリでバックアップをリストアできない問題を修正**。
  リストア検証の `REQUIRED_TABLES` を Banto 基盤所有の `settings` / `users` /
  `audit_log` に限定し、派生アプリが差し替え・削除するドメインテーブルを必須条件から
  除外した。ドメインテーブル無しの有効な Banto DB を受理する回帰テストを追加。

## [1.3.0] - 2026-08-20

**v1.3.0 — 保守レビュー 2026-08 の反映テーマ。** 新機能の追加は無く、
maintenance-review 2026-08 で洗い出した修正・対称性是正・テスト増強・
機械検査の追加が中心。**後方互換**（既存の公開 API は削除・改名とも無し、
依存追加ゼロ）のため minor リリース。以下は v1.2.0 以降のマージ分。

なお、クライアントから見えるステータスコードが2箇所変わる（不正な
フィルタ入力が 500 → 400、items import の大きなペイロードが 413 → 422）。
いずれも誤ったレスポンスの是正だが、ステータスコードで分岐している消費側は
確認すること。また `banto-core` の `BantoError` に `BadRequest`
バリアントが増えたため、この enum を網羅 `match` している消費側は
追随が必要（`ErrorBody` 経由で扱っている場合は影響なし）。

### 修正

- **Postgres で数値カラムへの `contains`/`starts_with` フィルタが 500 になるバグを修正**
  （maintenance-review PR-5 / H-3）。`list_query` の LIKE が `LOWER(<数値カラム>)` を
  生成し、Postgres の `lower()` は text 専用のため実行時エラー（500）になっていた
  （SQLite は動的型で暗黙変換するため既存テストが素通り）。`LOWER(CAST(col AS TEXT))`
  に変更（text カラムでは no-op、両バックエンド一致）。SQLite 回帰テスト + 実 Postgres の
  `postgres_tests`（LIKE/数値バインド/NULLS LAST、storage-postgres CI）を新設。
- **items import に明示 body limit を追加し 413 でなく 422 を返す**（maintenance-review
  PR-5 / M-14）。仕様上有効な最大行数のペイロードが axum 既定 2MB に先に当たり 413 で
  落ち得たのを、`items_write_router` に `DefaultBodyLimit::max(MAX_IMPORT_ROWS *
IMPORT_BODY_LIMIT_BYTES_PER_ROW)`（10MiB）を層付けして service 層の行数チェック
  （422）へ到達させる。境界テスト1本（修正を外すと 413 で落ちる回帰ガード）。

- **派生アプリの `pnpm dev` が `.svelte.ts` で 500 になる問題を修正**（issue #150 /
  [ADR-0007](docs/adr/0007-derived-app-dev-optimizer-exclude.md)）。`@banto/*` は
  ソース配布（`.svelte.ts` を生で出荷）のため、git 依存で node_modules 化した派生
  アプリでは Vite 8 dev の依存オプティマイザ（Rolldown）が preprocess せず
  `svelte.compileModule` に渡し `import type` 等で「Unexpected token」→ 500 になって
  いた（`pnpm build`/`check` は成功）。`apps/admin-template/vite.config.ts` の
  `optimizeDeps.exclude` に `.svelte.ts` を持つ5パッケージ（admin-core / dock-svelte /
  forms / grid-svelte / tree-svelte）を列挙して回避。テンプレート本体は workspace
  symlink 解決で元々 prebundle されないため no-op。列挙漏れの再発を
  `verify:architecture`（新 rule `optimizedeps-svelte-source`）で機械検査。
  publishing.md / conventions §14 に不変条件を明文化。

- **両経路の監査記録の非対称を是正**（maintenance-review PR-4 / H-4・M-15）。
  `audit-log/config` の denied 監査が REST=`resource:"audit_log"` /
  Tauri=`resource:"settings"` と食い違い、REST 内でも成功時（`settings`）と
  denied が不一致だった不変条件1違反を是正: REST の `audit_log_router` を
  list（`audit_log`）と config（`settings`）の2ガードに分割し、成功・denied・
  両経路すべてを `settings` に統一（`audit-log/list` は `audit_log` 維持）。
  両ガードの resource タグを `rest/tests.rs` でピン留め。backups restore の
  `entity_id` を canonical 化（対象ファイルの実名。upload は実体名が無いため
  `None`）。conventions §1 に監査 canonical 形状（resource / entity_id /
  denied detail 非対称 / 429 login 非記録）を明文化（ja/en）。
- **クライアント起因の不正入力を 500 でなく 400 で返す**（maintenance-review
  PR-4 / M-4）。`BantoError::BadRequest`（→ HTTP 400）を新設し、`list_query` の
  未知フィルタ列・不正なフィルタ値・`in` の非配列など5箇所を `Other`（500）から
  移行。`ErrorBody` に `bad_request` kind を追加し、フロント（`errors.ts` +
  全 `ERROR_KINDS`）とワイヤ形状パリティテスト（`error.rs`）を追随。サーバ
  エラー監視がクライアント起因の 500 で汚染されなくなる。

### 変更

- **`api_router` の10位置引数を `Services` 構造体へ集約**（maintenance-review M-13）。
  `api_router(items, users, …, auth, events, allow_setup)` を
  `api_router(services, auth, events, allow_setup)` に変更し、7つのサービスハンドル
  （items/users/settings/audit/backup/attachments/system_info）を `rest::Services`
  に束ねた。アプリ作者がサービスを足すコストが「位置引数を全呼び出し箇所へ波及」から
  「構造体フィールド1つ」に下がり、scaffold の attachments 除去も位置依存スロットから
  名前付きフィールドの除去になった。呼び出し箇所（`bin/banto-serve` / `src-tauri` の
  `start_embedded_server` / `rest::tests` の各ルータヘルパ）を追随。振る舞いの変更なし。
- **Tauri 側の監査記録に `record_ok` ヘルパーを導入**（maintenance-review M-1）。
  `src-tauri/lib.rs` の手書き `AuditEntry` 31箇所のうち、成功・アクター付き書き込み
  24箇所を REST の `record_write` に対応する `record_ok(&audit, &actor, action,
resource, entity_id, detail)` へ集約（`origin: "tauri"` / `result: "ok"` を固定）。
  両経路が各サイドのヘルパー経由になり、監査記録の形状ドリフト（conventions §1）を
  抑止。形状が異なる7箇所（import の ok/failed、login_failed、認証無効モードの
  エスケープハッチ書き込み、起動時 restore_applied、denied）は REST 同様に手書きのまま。
  振る舞いの変更なし（着手前提の両経路 detail 一致は maintenance-review §5.3 で実測済み）。

- **`record_write` の `entity_id` を `Option<&str>` に**（maintenance-review
  PR-4 / M-2）。entity_id を持たない mutating ハンドラ4箇所（audit config /
  backups restore-upload・cancel）が手書き `AuditEntry` を複製していたのを
  `record_write` ヘルパーに集約。

- **scaffold にツリーデモの remover を追加**（maintenance-review PR-3 / H-1）。
  v1.2.0 で追加された `@banto/tree-svelte` + `/tree` デモが scaffold 未登録で、
  minimal プリセットでもツリーデモが残っていた（#122 と同型のプリセット定義
  ドリフト）。README の手動4ステップを 1 対 1 で `removeTree()` 化し
  minimal / standard へ登録。`packages/` と scaffold の判断（remover / コア /
  除外）の同期を `scaffold.test.mjs` のトリップワイヤで機械検査化。
- **scaffold のアンカードリフト対策**（maintenance-review PR-3 / H-2）:
  (a) `verify-architecture.mjs` 対象ディレクトリ除去アンカーのカンマ欠落で
  dropBlock が無音スキップしていた実バグを修正。(b) `template-edit.mjs` に
  `--strict` モードを追加（pristine コピーでは「適用済み扱い」= アンカー不一致
  として失敗）し、template-acceptance の presets ジョブで有効化。
  (c) template-acceptance の paths トリガに scaffold のアンカー対象
  （アプリ側ファイル群）を追加 — アプリ側 PR でアンカーが壊れても週次まで
  潜伏せず毎 PR で検出される。

### テスト

- **Tauri の6コマンドを `_body` 分割し監査記録テストを追加**（maintenance-review PR-5 /
  M-5）。items_delete / auth_config_apply / autologin_enable / autologin_disable /
  attachments_upload / attachments_delete を `<cmd>_body(&AppState, …)` に切り出し（1行
  アダプタ）、各 body の監査エントリ（actor/action/resource/detail）を検証。attachments
  テストは scaffold で minimal/standard から除去（cutRegion 1本追加）。
- **pg_smoke に import の round-trip + rollback を追加**（maintenance-review PR-5 /
  M-12）。未実行だった `import_apply_postgres` の commit / rollback 両ブランチを実 Postgres で検証。
- **dock-svelte にドラッグ移動・フロート化のコンポーネントテストを追加**
  （maintenance-review PR-5 / M-8）。grid/tree の @testing-library/svelte + jsdom
  パターンを流用（devDeps + svelteTesting プラグイン追加）。

### 機械検査

- **機械検査を足すかの判断基準を [ADR-0008](docs/adr/0008-machine-check-stop-gate.md)
  に昇格し、rule を2本追加**（maintenance-review PR-7）。maintainability-review §4.1 が
  口伝で持っていた「打ち止め3条件」（背骨 / 静かに壊れる / AI が壊しうる を全て満たす）を
  ADR 化し、保守レビューの9案を選別（採用2・見送り2・却下5。全採否を ADR の台帳に記録）。
  採用分を `verify-architecture.mjs` に実装:
  - **rule 11 `migration-dialect-parity`**: `migrations-{sqlite,postgres}/` のファイル名/
    連番が1対1（片系統だけ足すと PG は smoke CI のみのため静かに欠落。中身の型差は §11 の
    意図的分岐でレビュー担保）。
  - **rule 12 `csp-two-definitions`**: `security_headers.rs` の const と `tauri.conf.json` の
    `app.security.csp` を connect-src の IPC 差分を除きディレクティブ単位で照合（cross-check
    テスト無し + src-tauri 非コンパイルのため片方だけ緩む退行を静かに見逃していた）。
    conventions §6/§11 に機械検査済みの旨を追記。両 rule とも意図的破壊で fail することを実測確認。

### ドキュメント

- **README の利用パッケージ別レシピ3節を `docs/recipes/` へ切り出し**
  （maintenance-review PR-6）。scan-wedge / 通知（トースト）/ tree-svelte の各節
  （計約240行）を `docs/recipes/{scan-wedge,notifications,tree-svelte}.md` へ移し、
  README には紹介 + リンクのスタブを残した（README は「コピー→リネーム→差し替え→
  削除→配信」の背骨に集中。節アンカーへの被参照ゼロを実測して切り出し）。
  欠落していた `packages/tree-svelte/README.md` を新設（他9パッケージと同形式）。
- **`docs/recipes/add-role.md`（ja/en）を新設**（feature-review-2026-08 §2.6 の宿題）。
  RBAC ロール追加のチェックリスト（Role enum → DB CHECK → 両経路の認可床 → rule 8 →
  フロント選択 UI/i18n → 対称テスト）。add-resource.md の姉妹編。AGENTS（ja/en）の
  「タスク別の入り口」に add-role とレシピ群を索引追加。
- **ui-framework-spec の §14/§15 に決着を追記**（maintenance-review PR-6）。§14 の
  解決済み未決2件（ドッキング初期スコープ→M7/M8 段階リリース、REST エラー
  フォーマット→ErrorBody + response.rs のステータス写像。バージョニングは未導入と明記）
  に [x] と決着先を記入。§15 に M0〜M9 完了印と「M10 以降は roadmap」の誘導。
  ヘッダを v0.7 → v0.8。

- 保守レビュー 2026-08（ドキュメント整理統合の実測プラン + 保守性再点検）を
  [docs/maintenance-review-2026-08.md](docs/maintenance-review-2026-08.md) に追加（#148）。
- 消失文書への参照46箇所を実在参照へ修復（#149、maintenance-review PR-1）:
  i18n-plan 参照を conventions §13 / ADR-0005 へ、CR-6/CR-7/AD 系の定義を
  maintainability-review §7 追補へ、spec §6.4「チャートデザインルール」新設、
  `spec §3.7/3.8` → `attachments-plan §3.7/3.8` 正規化、conventions §12 に
  参照文法表。Cargo.lock の v1.2.0 追随も同 PR。
- 追随更新とアーカイブ（maintenance-review PR-2）: review-2026-07-29 /
  improvements / improvement-plan-2026-07 を `docs/history/` へ凍結移動し、
  現役バックログを roadmap §3 に一本化。publishing.md の決着済み経緯を
  `docs/history/publishing-github-packages-2026-07.md` へ切り出し。
  visual-refresh plan/design・scaffold-presets-plan の状態ヘッダを実装済みに
  更新（§7 未決事項の決定結果を追記）。AGENTS.md の CI 記述・オプション一覧・
  不変条件要約（§13）を実態化しレビュー記録の索引を新設。conventions
  §1/§3/§4/§6/§9 のピンポイント追随（CR-6 後の rule 8・CSP 2定義同期・app 層
  生値の例外規約ほか、en 同時）。README の壊れた箇条書き修復 + システム情報
  カード追記、README.en にライブデモ URL と要約宣言。CHANGELOG v1.2.0 節に
  PR 番号を対応付け、版比較リンクを新設。

## [1.2.0] - 2026-08-12

**v1.2.0 — UI / デモ拡充テーマ。** ツリービュー（新規オプションパッケージ
`@banto/tree-svelte` + 削除可能なデモ配線）、システム情報カード + バージョン表示、
PWA（installable-only）、通知 `warning` 種別 + サーバ発通知（`Notice`）レシピ、
積立棒グラフのデモを追加。**いずれも後方互換（追加的で破壊的変更なし。既存の
公開 API・両経路の挙動は不変、依存追加ゼロ）** のため minor リリース。以下は
v1.1.0 以降のマージ分。

### Added

- **積立棒グラフのデモを追加**（#145、`@banto/charts` の `BarChart` stacked）。ダッシュボードに
  「カテゴリ別在庫（価格帯積立）」パネルを追加し、上位カテゴリの在庫を価格帯(低/中/高)で
  積み上げる（集計は `dashboard.ts` の `stockByCategoryPriceBand`、純関数・壁時計非依存）。
  これで README が挙げる全14チャート種が Pages ライブデモで実際に描画される（従来は積立が
  `StackedAreaChart` のみで、棒の stacked バリアントだけデモ未掲載だった）。
- **ツリービュー `@banto/tree-svelte`**（#143 パッケージ + #144 デモ配線。新規オプションパッケージ、利用者要望）。
  依存ゼロのヘッドレスコア（`core/` の純関数: 可視行フラット化・move/reparent・
  三状態チェック計算・リネーム patch、全て単体テスト済み）+ 薄い Svelte 5 (Runes)
  UI。`BantoTree` は展開/折りたたみ・単一/複数選択・三状態チェックボックス・
  遅延読み込み・ドラッグ並べ替え/親子変更・インライン名前変更に対応し、`columns`
  で階層データグリッド（tree-grid）化。`TreeSelect` はポップオーバー型の選択入力
  （`popover="auto"` でトップレイヤ + light-dismiss）。**依存追加ゼロ・パッケージ間
  import なし**（`@banto/grid-svelte`/`forms` の型は構造ミラーで非 import）。
  テンプレート本体には**削除可能なデモ配線**付き（サイドバー「ツリービュー」=
  `/tree` デモページ。ライブデモでも到達可。サンプルデータ `treeSample.ts`・
  `treeMessages()` ブリッジ・`nav.tree`/`tree.*` 文言を含む）。ナビ追加に伴い
  サイドバーが写る認証ページのビジュアル回帰ベースラインを再生成
  （`.github/workflows/visual-baselines.yml`）。テスト 37 件（コア/状態/コンポーネント）。
- **システム情報カード + バージョン表示**（#140、M-review 2026-08 §2.4「縮小版⑤」）。
  設定画面に admin 専用の「システム情報」カードを追加し、稼働中バージョン・
  マイグレーション版・DB 方言/レイテンシ・稼働時間・アクティブ LAN セッション数・
  添付ファイル容量を表示する。バックエンドは新サービス
  `banto_admin_services::system_info::SystemInfoService`（DB 専用・transport 非依存、
  best-effort 項目は None に劣化）と、両経路対称な `GET /api/system/info`（admin、
  読み取りのため非監査）+ Tauri `system_info` コマンド。`AuthState::session_count()`
  を追加。**依存追加ゼロ**（`std::time::Instant` でレイテンシ/稼働時間、既存 sqlx で
  クエリ）。従来 UI のどこにも出ていなかったバージョンをこのカードで可視化。
  なお CI の rust ジョブ（check/clippy/test）に欠落していた `-p banto-admin-services`
  を追加した（theme C でのクレート追加時からの漏れ）。
- **PWA（installable-only）**（#141、M-review 2026-08 §2.8）。LAN ブラウザ配信に
  Web マニフェスト（`static/manifest.webmanifest`）+ アイコン（192/512/512-maskable、
  提灯モチーフ）を同梱し、「ホーム画面に追加」/インストールでアプリのように起動可能に。
  `app.html` に manifest link・apple-touch-icon・theme-color・apple-mobile-web-app
  メタを追加。埋め込み LAN サーバが `.webmanifest` を正しく配信するよう
  `banto-server` の `guess_mime` に `application/manifest+json` arm を追加。
  Service Worker（オフライン）は非対応。**依存追加ゼロ**（アイコンはコミット済み静的
  アセット）。ブラウザはセキュアコンテキストでのみインストールを提供するため、標準の
  平文 HTTP LAN では機能せず HTTPS/localhost/TLS リバースプロキシ配下が前提
  （ADR-0003）。`rename.mjs` が manifest の name/short_name も追随。
- **通知に `warning` 種別を追加 + サーバ発通知（`ServerEvent::Notice`）のレシピ化**
  （#142、M-review 2026-08 §2.5 の「無料部分」）。`@banto/admin-core` の `NotificationKind`
  を `success`/`error`/`info` に **`warning`** を加えた4種に拡張（後方互換な union
  拡張。`events.ts` の `notice` レベル照合と `ToastHost` の `.toast.warning`
  スタイル（warning トークン）を追加）。既に配線済みだが未使用だった
  `ServerEvent::Notice { level, message }` の**発火例**を `banto-server` の doc
  コメント（doctest）+ SSE 配信テストで示し、README に「通知（トースト）」レシピ節
  （自タブ `notify('warning', …)` / 全クライアント一斉 `ServerEvent::Notice`
  ブロードキャスト）を追加。永続通知センターは引き続き非スコープ（§2.5）。**依存追加ゼロ**。

### ドキュメント

- 外部AIレビュー（ChatGPT）の機能スコープ提案を実測で検証・取捨した棚卸しを
  [docs/feature-review-2026-08.md](docs/feature-review-2026-08.md) に追加（#139）。
  roadmap §3 v2 バックログに **API Token / Service Account**（既存ロール紐付け設計）
  を追加し、updater / バックアップアーカイブへ設計上の但し書き参照を付した
  （実装は伴わない実需ドリブンのバックログ整理）。

## [1.1.0] - 2026-07-30

**v1.1.0 — V2 拡張テーマ（PostgreSQL アプリ全体対応 / i18n レイヤ② / コピー面積
縮小）を完了。** [roadmap.md](docs/roadmap.md) §3 の v2 バックログ3テーマを実装。
いずれも**後方互換**（既定は SQLite・表示ロケールは日本語のまま挙動 byte 等価、
移設したサービスは再エクスポートで旧パス保持）のため minor リリース。以下は
v1.0.0 以降のマージ分。

### Added

- **テーマA: PostgreSQL アプリ全体対応**（#106–#109）。サービス層を
  `sqlx::SqlitePool` から `banto_storage::Db`（enum ディスパッチ）へ抽象化し、
  `Dialect` で SQL 方言差（プレースホルダ・日付関数）を吸収。マイグレーションを
  `migrations-sqlite/` + `migrations-postgres/` に方言分割し、`db::init_db_from_target`
  が `BANTO_DB=postgres://…` で PostgreSQL 経路を選択（既定は SQLite で無改変）。
  CI に実 `postgres:16` で app 層 CRUD を検証する `app-postgres` スモークを追加。
  backup/restore は SQLite 専用として維持（Postgres ハンドルは明示エラー）。
- **テーマB: i18n レイヤ②**（#110–#113, #75, [ADR-0005](docs/adr/0005-i18n-paraglide.md)）。
  UI 多言語化ランタイムに **Paraglide JS (inlang)** を採用（ADR-0002 の意図的例外）。
  app 層の可視文言を全キー化（`messages/{en,ja}.json`・英語一次）、設定画面に
  言語切替 UI、ロケール解決/永続化を `locale.ts`（既存 provider 層に相乗り）。
  既定表示は日本語で視覚回帰ゼロ。conventions §13 +「app 層に生の日本語リテラルなし」
  の機械検査 `raw-jp-in-app` を追加。visual ベースライン手動再生成ワークフロー
  `visual-baselines.yml` を追加。
- M24 デモ配線（#74）: `@banto/charts` の積立エリア/ガントをダッシュボードデモに追加。
- 保守者向け中核ドキュメントの英語版（#119）: `conventions.en.md` / `AGENTS.en.md` /
  `recipes/add-resource.en.md` / ADR 各 `.en.md`（日本語一次・英語追随）。

### Changed

- **テーマC: コピー面積縮小**（#114–#117）。テンプレート採用者がコピー保守する
  汎用サービス層を新クレート **`banto-admin-services`**（settings/audit/rbac/users/backup）
  へ、汎用 REST ルータ（auth/users/audit/backups/ui_settings）を **`banto-server::routes`**
  へ移設（約4,700行）。`admin-template-core` は再エクスポートで旧パスを保持し
  REST/Tauri wiring は無改修、両経路対称（rule 8）は移設前と数値一致。依存方向
  `admin-template-core → banto-server → banto-admin-services → banto-storage → banto-core`。
  `items.rs`（デモ固有）は据え置き。
- ドキュメント整合（#118）: V2 リファクタ後の canonical ドキュメント/コード doc
  コメントを実装に合わせて更新（マイグレーションパス・DB 対応状況・クレート一覧・
  移設サービスの所在・`SqlitePool`→`Db`）。
- 依存更新（Dependabot・#47/#50/#55/#57/#59/#96/#97/#105）: vite / vite-plugin-svelte /
  sha2 / npm・cargo minor-patch グループ / GitHub Actions 各種。

### Fixed

リリース前のテンプレート実用性レビュー（`docs/review-2026-07-29.md`）で発見した所見に対応。

- **[出荷ブロッカー] i18n ビルドの CDN 依存 + fail-open**（#121）。inlang/Paraglide の
  コンパイル時プラグインが `project.inlang/settings.json` で jsdelivr CDN URL 参照になっており
  （lockfile 外・毎ビルド取得）、取得失敗時に空カタログを exit 0 で出力（fail-open）→ 実行時に
  画面が落ちる問題を修正。プラグインを devDependency（コンパイル時のみ・実行時依存ゼロ）として
  ローカル化、`scripts/check-i18n-nonempty.mjs` で「メッセージ0件なら異常終了」する fail-closed
  ガードを追加、CI に CDN 遮断ビルドの `i18n-offline` ジョブを追加。閉域網/社内プロキシ（README の
  ターゲット）でのビルド再現性を確保。
- **Tauri コマンドのテストがどの CI でも実行されていなかった**（#122）。`tauri-check.yml` に
  `cargo test -p admin-template` を追加（`cargo check` だけで実行されていなかった 8 テストが
  走るように。両経路対称の認可/監査の実行検証が復活）。
- **`scaffold.mjs` のプリセット除去パターンのドリフト**（#122）。#74（M24 デモ配線）と i18n
  キー化で `removeCharts`/`removeGlass`/report ボタン除去のアンカーが陳腐化し、`--preset
minimal`/`standard` が失敗していたのを現行コードに追随させて修正（3プリセットで
  scaffold→check 緑）。`template-acceptance` がフロントのみの変更で起動しないため潜在していた。
- scaffold をユーザー導線に露出（#122）: `pnpm scaffold` スクリプト + README（日英）/AGENTS
  （日英）に導線。e2e の `afterAll` を `page?.close()` 化、README にセッション再起動消失の注記。

## [1.0.0] - 2026-07-28

**v1.0.0 — 安定版リリース。** 仕様 M0〜M9 + ロードマップ M10〜M24 までの
汎用管理画面テンプレートとしての機能が出そろい、v1 スコープを完了。以降の
拡張テーマ（PostgreSQL アプリ全体対応 / i18n レイヤ②③ / コピー面積縮小）は
[roadmap.md](docs/roadmap.md) §3「v2 / 将来構想バックログ」に集約。0.1.2 からの
差分は破壊的変更なし（安定版としての昇格）。以下は 0.1.2 以降のマージ分。

- feat (P4-5): `banto-storage` に PostgreSQL 接続ヘルパ `postgres.rs`（`connect`、
  接続プール、feature `postgres`）を追加。`list_query` の Postgres 対応（既存）
  と合わせて storage クレートが Postgres 接続可能に（接続のみ）。アプリ層
  （`apps/admin-template/core`）は仕様どおり SQLite 専任のまま（§12.1/§548）。
  CI に `postgres:16` サービスコンテナで実接続する `storage-postgres` ジョブを追加
- feat (P4-9): プリセット・スキャフォールダ `scripts/scaffold.mjs`
  （`--preset minimal|standard|full`）を追加。コピー直後にプリセットで不要な
  オプション資産（charts / dock / Glass+vibrancy / コマンドパレット / 添付 /
  帳票）を README「オプション資産の削除」手順どおりに削除する（ship-full /
  remove-only、コアは非対象）。rename.mjs のファイル編集エンジンを
  `scripts/lib/template-edit.mjs` に共有抽出。`template-acceptance.yml` に
  3プリセット × ビルド緑（scaffold → install → check/build/cargo check /
  verify:architecture）の受け入れマトリクスを追加（依存追加なし）
- fix (P4-9, follow-up #94): `scaffold.mjs` の attachments 除去を
  `apps/admin-template/core/src/rest/tests.rs` にも適用し、全プリセットで
  `cargo test` が緑になるよう修正（従来は minimal/standard で削除済みクレート
  参照によりテストがコンパイル不能だった）。`template-edit.mjs` に章末ブロックを
  EOF ごと消す冪等ヘルパ `cutToEnd` を追加。`template-acceptance.yml` の
  presets マトリクスを `cargo check` → `cargo test` に強化
- feat (scaffold-presets-plan §7.3): `scripts/scaffold.mjs` に `--interactive`
  （`-i`）を追加。プリセット（minimal/standard/full）または資産ごとの
  残す/削除を対話で選ばせた上で、`--preset` と全く同じ削除ロジック・確認表示
  を実行する（`--preset` の非対話動作はバイト単位で不変）。依存追加なし
  （`node:readline/promises` のみ、conventions §3）。pipe された非 TTY stdin
  でも `question()` の既知の取りこぼしを避けるため async イテレータで
  1行ずつ読む方式を採用し、軽量テスト `scripts/scaffold.test.mjs` から
  駆動できるようにした
- feat (#89, AD-2): **GitHub Pages ライブデモを公開**（<https://tyaro.github.io/banto/>、
  InMemory デモ・admin/admin）。アプリを **base-path 対応**にし（`$app/paths` の
  `base` を全内部遷移へ付与。`BASE_PATH` 既定 `''` で Tauri/LAN ビルドは完全不変）、
  `deploy-demo.yml` ワークフロー（`BASE_PATH=/banto` ビルド → deploy-pages）を追加。
  README 冒頭にライブデモリンクを追加
- docs (#90, AD-3): OG ソーシャルプレビュー画像 `docs/assets/og-image.png` を追加
- ci (#91): `deploy-demo.yml` の Pages アクションを Node 24 版へ bump（Node 20 deprecation 解消）
- ci (#92): 全ワークフローの `checkout` / `setup-node` を Node 24（v7）へ bump（Node 20 警告解消）
- ci (#99): `pnpm/action-setup` を v6 へ bump（最後の Node 20 警告を解消）
- docs (#101): `ui-framework-spec.md` §5.3 ウィンドウ分離を「実装済み」に追随更新
  （`panel_open` の real `WebviewWindow` + `popout.ts`、`isTauri()` ガードで両経路対称）
- docs (#102, P4-6): `improvements.md` の履歴分離を完了。解決済み4項目（P3-3/P4-1/
  P4-2/P4-3）を `docs/history/improvements-archive.md` へ移設しスタブ化
- docs (#103): `roadmap.md` §3「v2 / 将来構想バックログ」を新設し大物残項目
  （PostgreSQL 全体対応 / i18n ②③ / コピー面積縮小）を隔離。**v1（M0〜M24）スコープ完了**を宣言

## [0.1.2] - 2026-07-23

- fix (#77, CR-6): `audit_config_get` の両経路ロールを Admin に統一（Tauri が
  Viewer・REST が Admin という看板不変条件「両経路対称」の実バグを修正）。
  `verify:architecture` rule 8 に**ロール床照合**（`require_role`/`RoleGuard` の
  期待ロールを DUAL_PATH/ROLE_READ 宣言と静的照合）を追加
- docs/tooling (#78, CR-7): ドキュメントと実装の整合を是正（チャート14種・
  scan-wedge 記述・`pnpm check` 説明、scan-wedge を tsc 化）+ **バージョン整合検査**
  `check:versions`（全マニフェスト version の相互一致 / タグモードでタグ名照合）を追加
- ci (#79, AD-5): テンプレート受け入れ CI（copy→rename→check）+ `rename.mjs` の
  統合テスト（Node 標準 `node:test`）を追加
- i18n (#81, AD-6 レイヤ①): `@banto/*` 全パッケージの可視文言を**注入対応化**。
  現行日本語をデフォルトに残した `messages` props / メッセージ引数で上書き可能にし
  （`forms/validate.ts` の既存パターンを横展開）、辞書・`t()`・依存追加なし・
  byte-identical・後方互換。②仕組み・③辞書・docs 英語化は実需ドリブンで保留
- docs (#82, AD-4): template-scope §7 コピー面積縮小の着手トリガに「外部採用者
  フィードバック」を追加
- fix (#83, PR-C): Tauri デスクトップ Webview に **CSP を設定**（`app.security.csp` を
  null → LAN 側 `security_headers.rs` と対称。差分は `connect-src` の Tauri IPC のみ）。
  実機 Windows のビルド + スモークで確認。app.html インラインスクリプトは SvelteKit
  ブートストラップのビルド毎ハッシュ変動のため `'unsafe-inline'` を踏襲（LAN と同じ）
- fix (#84): デスクトップの CSV エクスポートを `exports/` フォルダ書き出し +
  フォルダを開く方式に（WebView2 が保存ダイアログを出さない問題。backup と同じ
  流儀・依存追加なし。Tauri コマンド `items_export_csv_to_folder`、`DESKTOP_ONLY` 分類）
- docs (#85, AD-1/AD-2): README に「対象読者 / 非対象」ポジショニング宣言と
  スクリーンショット3枚（`docs/assets/`）を追加（採用者向け導線）
- chore (#86, CR-7): 全マニフェストの version を **0.1.1 に整合**（既存 v0.1.1 タグ /
  CHANGELOG [0.1.1] とのドリフトを解消）

- M24: `@banto/charts` に **積立エリア（`StackedAreaChart`）** と
  **ガントチャート（`GanttChart`）** を追加（全14種）。積立棒は従来どおり
  `BarChart` の `stacked`。積立エリアは既存 `core/stack.ts` を再利用し、境界間
  バンドの新規純関数 `bandAreaPath` で塗る（`LineChart` のズーム/第2Y軸と
  衝突するため専用コンポーネント）。ガントは純関数 `core/gantt.ts`
  （`toMs`/`ganttDomain`/`ganttLayout`）+ 時間軸バー・進捗・「今日」マーカー
  （依存線は非スコープ）。日付は `formatDate` 委譲で日付ライブラリ非同梱
  （依存を足さない）。ユニットテスト14件追加、生色値なし。ダッシュボードデモ
  への配線は visual baseline 再生成が要るため別 PR（roadmap M24）

- docs: 保守性コードレビューの不変条件機械検査化を **CR-1 / CR-2 で打ち止め**と
  決定し、理由を maintainability-review-2026-07.md §4.1 に記録。機械検査の3条件
  （背骨 / 静かに壊れる / AI が無自覚に壊す）に照らし、CR-4 は不採用、CR-5 は
  機会的、CR-3 は実需ドリブンで見送り。ガードレール自体が保守負担・偽の安心感に
  なる手前で止める判断

- ci: `verify:architecture` に rule 9「§6 セキュリティ不変条件」を追加（CR-2）。
  §6 のうち静的テキストで低誤検知に検査できる2件を機械化: (A) `NewAttachment` に
  `mime` フィールドが無い（クライアント申告 MIME を受け取らず、判定は
  `detect_mime` のマジックバイトのみ）、(B) `settings_get`/`settings_set` が同一
  Admin ゲート（「同一ストアでも権限の非対称を作らない」）。順序依存・
  セマンティックな項目（body limit の順序・監査 detail に秘密を入れない等）は
  レビュー/テスト担保のまま。conventions §6 の該当2箇所を [機械検査済み] に更新

- ci: `verify:architecture` に rule 8「REST/Tauri 両経路対称」を追加（CR-1、
  conventions §1）。このテンプレートの背骨の不変条件でありながら従来は機械検査が
  無く、AI が mutating 操作を片方の経路にだけ足しても落ちる検査が無かった
  （`src-tauri` は非コンパイル環境で実行検証も不可）。`DUAL_PATH` マニフェスト
  （20対、所有者確認済み分類）+ 完全性チェックで、未分類の Tauri コマンド /
  REST ルート追加を CI で捕捉する。アンカーは Tauri コマンド定義と
  `rest/mod.rs` の Route table（実 `.route()` 宣言との doc-sync 併設）。依存追加
  なし。conventions §1 を [機械検査済み] に更新

- docs: 保守性コードレビュー（Rustサービス+サーバ層、AI中心保守が前提）の所見と
  不変条件の機械検査化ロードマップ（CR-1〜CR-5）を
  [maintainability-review-2026-07.md](docs/maintainability-review-2026-07.md) に
  記録。人間の保守性とAI保守性の分岐点を整理し、conventions.md のうち機械検査に
  落ちていない不変条件（特に §1 両経路対称）を優先的に検査化する方針。
  improvement-plan-2026-07.md から参照

- ci/docs: `verify:architecture` に「ドキュメント整合性」ルール（rule 7）を追加。
  `docs/`・README・AGENTS・CLAUDE 内の `@banto/*` 参照が実在パッケージのみで
  あることを機械検査し、実在しない `@banto/grid-core` 等の掲載（今回修正した
  ドリフト）を CI で防ぐ。実在パッケージ名は `packages/*/package.json` から
  動的取得するため追加/改名に自動追従。依存追加なし（Node 標準のみ）

- docs: ドキュメントと実装の不整合を修正。(1) ui-framework-spec §2.1 の対象
  パッケージ表から実在しない `@banto/grid-core`/`@banto/dock-core` を除去し、
  ヘッドレスロジックは各 `-svelte` パッケージ内 `src/core/` に内包（§14 決着）と
  明記。(2) 同表の `banto-storage` の PostgreSQL 記述を実装状況（v1 は SQLite
  のみ、postgres は feature 定義止まり — §12.1 注記）に整合。(3) v1後追加の
  オプション拡張パッケージ（report/attachments/scan-wedge、M19〜21）への参照を
  追記。(4) AGENTS.md/CLAUDE.md の E2E 検証コマンドを実在しない
  `pnpm -C apps/admin-template test:e2e` から実際の `pnpm e2e` に修正。
  (5) template-scope のクレート化計画表に、`rest.rs` が P3-1 で `rest/` へ
  分割済みである旨を反映

- P4-9: スキャフォールド・プリセット（`minimal`/`standard`/`full`）の**設計を
  確定**（[docs/scaffold-presets-plan.md](docs/scaffold-presets-plan.md)、設計のみ・
  実装は P2-1 v2 の後）。プリセットは §3 オプション資産の削除手順の自動実行で
  あり、コア（auth/audit/settings/backup/CSV/shell）や runtime 機構には触れない。
  ChatGPT レビュー当初案の "industrial"（別リポジトリ `banto-industrial` と混同）を
  避け命名を是正。remover 関数群 + rename.mjs のエンジン再利用・依存追加なしで
  構成し、各プリセットのビルド緑を受け入れ条件にする方針を明記

- docs: v2 検討事項の決着とドキュメント棚卸し。TLS 本体（組み込み rustls）と
  サーバログ（`tracing`）は、いずれも conventions §3 が退けた依存追加のため
  実装ではなく ADR で決定を記録（[ADR-0003](docs/adr/0003-tls-via-reverse-proxy.md)
  リバースプロキシ終端を正式・組み込み TLS は保留、
  [ADR-0004](docs/adr/0004-server-logging-eprintln.md) `eprintln!` 継続・
  `tracing` は保留）。あわせて improvements.md の「まとめ」から完了済み項目
  （Dependabot/コンポーネントテスト）を除去、改行正規化を実質完了（CRLF 0件）と
  確認、spec §6.1/§6.3 の陳腐化した「v2以降」注記（複合/レーダー/ヒートマップ/
  ゲージ・SVGエクスポート＝M13/M22 で実装済み）を訂正

- P4-2: 仮想スクロールの計測ベンチを追加（`@banto/grid-svelte`、
  `pnpm bench`）。per-frame 処理（`computeWindow` + 可視ウィンドウ slice）が
  総行数に依存しないこと（10k/100k でほぼ同一）を実証し、sort/filter の
  総行数依存コストも計測。vitest bench でホットパスを計測する方式（ブラウザ
  FPS ではなく決定的・CI 非ゲート・依存追加なし）。代表結果はベンチ冒頭に常設

- P4-3: README LAN 節に「同時書き込みとSQLite（WAL）」節を追加。
  デスクトップ + 組み込みサーバは同一プロセス・単一プール共有で書き込みが
  シリアライズされ、DB は WAL モードで開くこと（別プロセスからの同時
  アクセスは避けるべき点も）を明記

- P4-7: ADR（Architecture Decision Record）を `docs/adr/` に導入。README
  （ドキュメント3分類の役割分担: コードコメント / conventions.md / ADR）+
  テンプレート + 最初の ADR 2件（0001 REST/Tauri 二経路対称、0002 依存
  最小化）。ADR は「退けた代替案とその理由」に絞り、conventions.md 冒頭
  から参照。既存判断のバックフィルは一括せず次に触れる時に1件ずつ起こす

- P4-1: `FilterPopover` の dismiss 挙動テストを追加（`@banto/grid-svelte`、
  9件）。実装精査の結果 Tab 巡回型フォーカストラップではなく「Escape /
  外側 pointerdown で閉じる」dismiss 型と判明したため、その実挙動
  （dialog 意味論・apply/clear/Enter 含む）を固定。improvements.md §8 の
  記述も実態に訂正

- fix(backup): `BackupService::create` の `created_at` を、生成した
  ファイルの mtime（`list()` と同一の取得源）から算出するよう修正。
  従来は `datetime('now')` 由来で、`VACUUM INTO` が秒境界をまたぐと
  create と list で最大1秒ずれる不整合があり、Windows で決定論的に
  `create_then_list_then_read_round_trips` を落としていた（P3-3 の CI で
  顕在化）
- P3-3: Svelte コンポーネントテストを導入（`@banto/forms` の `BantoForm`・
  `@banto/grid-svelte` の `BantoGrid` にマウント+基本操作テストを各5件）。
  `@testing-library/svelte` + `jsdom` を両パッケージの devDependencies に
  追加し、component テストのみ `// @vitest-environment jsdom` で opt-in
  （純ロジックテストの環境は不変、dependencies/peerDependencies は空を維持）
- P3-6/P4-4: CI の全サードパーティ Action をコミット SHA に固定し
  （checkout/pnpm-action-setup/setup-node/rust-cache/upload-artifact/
  install-action/github-script の7種。`dtolnay/rust-toolchain@stable` は
  ref がツールチェーン選択を兼ねる仕様のため意図的に非固定）、Dependabot
  （`.github/dependabot.yml`、github-actions/npm/cargo をグループ化週次）を
  導入して追従を自動化
- P4-6: `docs/improvements.md` を「未解決課題の調査記録」に絞り、対応済み
  項目の実装記録を `docs/history/improvements-archive.md` へ分離
  （各項目にスタブ + アーカイブリンクを残し追跡可能に）
- P3-5: アーキテクチャ規約の機械検査 `pnpm verify:architecture` を新設し
  CI の frontend ジョブで強制（サービス層の tauri/axum 非依存・パッケージ間
  import ゼロ・`$lib` import 禁止・`{@html}`/生色値の理由付き許可リスト・
  依存空の6ルール。conventions.md に [機械検査済み] 注記）。charts の
  ズームリセットボタンの生 box-shadow をトークン化
- P2-2: 英語版 README（`README.en.md`、1ページ要約）を追加
- P2-3: 全9パッケージに README を追加（役割・最小コード例・依存ゼロ方針・
  git サブディレクトリ依存での消費方法）
- P2-1: テンプレート初期化スクリプト `scripts/rename.mjs` を新設
  （`--name`/`--title`/`--identifier`/`--repo` で package.json×2・
  `--filter` 参照・tauri.conf.json・ブランド表示・E2E アサーション・
  リポジトリ URL を一括書き換え。Node 標準ライブラリのみ・`--dry-run`
  対応・再実行安全。README「コピーとリネーム」をスクリプト前提に改訂）
- M23: スキーマ→グリッド列の自動導出 `columnsFromSchema` を
  `@banto/grid-svelte` に追加（フォームと同一ルール・同一メッセージの
  バリデータ込み。items 一覧を導出ベースへ書き換え、仕様 §3.1 の
  「スキーマを1つ書けば一覧と編集フォームが両方生える」を実装）
- refactor: `rest.rs`（4,069行）をリソース別モジュールへ分割
  （`rest/mod.rs` = ルート表 doc + 共有ガード + `api_router`、
  `rest/{items,users,auth,ui_settings,audit,backups,attachments}.rs`、
  テストは `rest/tests.rs`。公開 API（`api_router` /
  `audited_credential_verifier`）のパスは不変。improvement-plan P3-1）
- refactor: `setup.ts` を分割し、リソース定義を `resources/items.ts` +
  `resources/index.ts` へ、環境判定を `environment.ts` へ、デモ認証を
  `providers/demo.ts` へ分離（既存の公開エクスポートは `setup.ts` から
  re-export され後方互換。improvement-plan P3-4）
- ci: Tauri compile check ワークフロー `tauri-check.yml` を新設
  （`cargo check -p admin-template` を ubuntu/windows で、Tauri側を触る
  PR/main push + 週次スケジュールで実行。週次失敗時は Issue 自動起票。
  improvement-plan P3-2）
- docs: 改善計画フェーズ1（README 5分クイックスタート・SQLite期待値明記・
  リソース追加レシピ `docs/recipes/add-resource.md` 新設・LAN HTTP警告 +
  Caddy TLS終端例・依存判断基準・AGENTS.md Definition of Done・roadmap
  M23候補登録）
- fix(e2e): vite preview を 127.0.0.1 に明示バインドし、CIのE2Eジョブが
  恒常失敗していた webServer タイムアウトを解消（webServer stdout の
  パイプ化も恒久化）(#37)
- docs: AIレビュー統合の改善計画 `docs/improvement-plan-2026-07.md` を
  新設し、E2E障害の事後記録を improvements.md §4.1 に追記 (#36, #38)
- M18: 基盤整備の残ギャップ解消（M18 完了。CIのRustジョブへ
  `banto-attachments` 追加、E2E visual regression + axe-coreジョブ追加、
  全9パッケージの `publish --dry-run` 確認、template-scope.md §6の
  チェック消込）(#32)
- M19: 帳票/印刷 `@banto/report`（MDテンプレート + データバインド +
  印刷CSS + items日報デモ）(#31)
- M21: バーコード/QR wedge入力検出 `@banto/scan-wedge`（キーボード
  ウェッジ検出ヘッドレスコア + Svelteアクション、テンプレート本体には
  未配線・レシピのみ）(#30)
- M20: 添付ファイル/画像管理 `banto-attachments` + `@banto/attachments`
  （アップロード/サムネイル/一覧 + REST/Tauri/監査ログ配線 + items
  デモ配線）(#29)
- docs: M19〜M21の提供形態を「パッケージ + 削除可能デモ + レシピ」方式に
  決定 (#28)
- a11y: dock-svelte/grid-svelteの既知アクセシビリティ2件を改修し、
  axe-coreスキャンの除外リストを撤去（8スキャン全通過）(#27)
- M22: ビジュアルリフレッシュ検証基盤（Playwright visual regression +
  axe-core、Phase 0）を追加しM22をroadmapに登録 (#26)
- M22: ビジュアルリフレッシュ実装（実装単位1〜6。Modern Operations
  Console化 — トークン拡張・密度軸・共通UI・アイコン統一・シェル刷新・
  View Transitions）(#25)
- docs: メニュー一式を計画へ追記し、実装レベルの設計書
  （visual-refresh-design.md）を新規作成 (#24)
- docs: visual-refresh-plan をレビュー反映で改訂 (#23)

## [0.1.1] - 2026-07-12

- chore: リポジトリ公開化に向けて全パッケージのライセンス表記をMITに
  統一（`packages/*/package.json` の `license` を `UNLICENSED` から
  `MIT` へ戻し、パッケージ個別の `LICENSE` ファイルを削除）(#22)
- docs: パッケージ配布方式をgitサブディレクトリ依存に確定（`@banto`
  スコープがGitHub Packagesで使えないと判明したため、GitHub Packages案は
  棚上げ）(#21)

## [0.1.0] - 2026-07-12

最初のタグ付きリリース。M0〜M18の累積。

**M0〜M9**（[ui-framework-spec.md](docs/ui-framework-spec.md) §15。
バージョンタグ導入前のためPR番号なし、1行要約）:

- M0: モノレポ + テンプレートアプリの骨格（SvelteKit + Tauri v2 +
  シェルレイアウト + ルーティング + テーマ切替/設定画面）
- M1: グリッドコア（クライアントモード、仮想スクロール、ソート/フィルタ、
  列リサイズ/並び替え）
- M2: `admin-core`（リソース定義・`DataProvider`/`AuthProvider`・
  コンポーザブル）+ スキーマ駆動フォーム + CRUDページ雛形（グリッド+
  フォーム+Rustサービス層+sqlxリポジトリ貫通）+ 認証/ログイン雛形
- M3: グリッド セル編集・範囲選択・コピー&ペースト
- M4: チャートv1（折れ線/棒/円/散布図/スパークライン）+
  ダッシュボードページ
- M5: グリッド サーバーモード（`getList`経由のTauri連携）、グルーピング
- M6: 組み込みWebサーバ（サービス層のREST公開、静的配信、
  `HttpDataProvider`、認証のREST対応+CSRF、`SettingsProvider`抽象、
  SSEイベント配信、設定画面トグル+URL/QR表示）
- M7: ドッキングレイアウト（フローティングウィンドウのみ）
- M8: ドッキング（分割・タブ化・スナップ）+ ダッシュボードへの統合
- M9: テーマ層の整理、MITライセンス、npm公開準備、テンプレートの
  ドキュメント整備

補足（M9〜M10のあいだ、2026-07-08、マイルストーン番号なし）: CI導入
（GitHub Actions）、リポジトリを `my-template` から `banto` へ改名、
セッション有効期限・ログインレート制限の実装、Node 24 LTS対応
（[improvements.md](docs/history/improvements.md) §0/§1/§2.1/§2.2/§3.2）。

**M10〜M18**（[roadmap.md](docs/roadmap.md)、PR番号付き）:

- M10（#11）: ユーザー管理UI + RBAC（admin/editor/viewerの3ロール）
- M11（#12）: 自動ログイン（ログイン不要モード + デスクトップkeyring
  自動ログイン + LAN Remember me）
- M12（#13）: Glassテーマプリセット + SettingsProvider移行（UI設定を
  localStorageからSQLite設定DBへ）
- M13（#14）: チャート拡張（ズーム/パン・十字カーソル・しきい値バンド・
  第2Y軸・ストリーミング更新 + ヒストグラム/パレート図/箱ひげ図）
- M14（#15）: 監査ログ（`audit_log`テーブル・サービス層記録点・
  保持ポリシー・閲覧ページ）
- M15（#16）: CSV/Excelエクスポート・インポート（RFC 4180準拠コア +
  バルクインポートAPI + itemsページUI）
- M16（#17）: コマンドパレット（Ctrl+K、ナビ定義からの自動導出 +
  RBAC連動）
- M17（#18）: SQLiteバックアップ/リストア（`VACUUM INTO` +
  ステージング方式リストア）
- M18（#20）: 基盤整備 Phase A〜C（lint/format基盤・Playwrightスモーク
  E2E・パッケージ配布可能化）— 残ギャップは `[Unreleased]` の #32 で解消

[unreleased]: https://github.com/tyaro/banto/compare/v6.9.1...HEAD
[6.10.0]: https://github.com/tyaro/banto/compare/v6.9.1...v6.10.0
[6.9.1]: https://github.com/tyaro/banto/compare/v6.9.0...v6.9.1
[6.9.0]: https://github.com/tyaro/banto/compare/v6.8.0...v6.9.0
[6.8.0]: https://github.com/tyaro/banto/compare/v6.7.2...v6.8.0
[6.7.2]: https://github.com/tyaro/banto/compare/v6.7.1...v6.7.2
[6.7.1]: https://github.com/tyaro/banto/compare/v6.7.0...v6.7.1
[6.7.0]: https://github.com/tyaro/banto/compare/v6.6.0...v6.7.0
[6.6.0]: https://github.com/tyaro/banto/compare/v6.5.0...v6.6.0
[6.5.0]: https://github.com/tyaro/banto/compare/v6.4.0...v6.5.0
[6.4.0]: https://github.com/tyaro/banto/compare/v6.3.2...v6.4.0
[6.3.2]: https://github.com/tyaro/banto/compare/v6.3.1...v6.3.2
[6.3.1]: https://github.com/tyaro/banto/compare/v6.3.0...v6.3.1
[6.3.0]: https://github.com/tyaro/banto/compare/v6.2.0...v6.3.0
[6.2.0]: https://github.com/tyaro/banto/compare/v6.1.0...v6.2.0
[6.1.0]: https://github.com/tyaro/banto/compare/v6.0.0...v6.1.0
[6.0.0]: https://github.com/tyaro/banto/compare/v5.1.0...v6.0.0
[5.1.0]: https://github.com/tyaro/banto/compare/v5.0.0...v5.1.0
[5.0.0]: https://github.com/tyaro/banto/compare/v4.0.0...v5.0.0
[4.0.0]: https://github.com/tyaro/banto/compare/v3.0.1...v4.0.0
[3.0.1]: https://github.com/tyaro/banto/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/tyaro/banto/compare/v2.1.1...v3.0.0
[2.1.1]: https://github.com/tyaro/banto/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/tyaro/banto/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/tyaro/banto/compare/v1.7.3...v2.0.0
[1.7.3]: https://github.com/tyaro/banto/compare/v1.7.2...v1.7.3
[1.7.2]: https://github.com/tyaro/banto/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/tyaro/banto/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/tyaro/banto/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/tyaro/banto/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/tyaro/banto/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/tyaro/banto/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/tyaro/banto/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/tyaro/banto/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/tyaro/banto/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tyaro/banto/compare/v0.1.2...v1.0.0
[0.1.2]: https://github.com/tyaro/banto/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/tyaro/banto/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tyaro/banto/releases/tag/v0.1.0
