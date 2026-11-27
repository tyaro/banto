# ADR-0037: pop-out のパネルの窓は、Tauri の plugin の crate `banto-tauri-panel` に置く

> English: [0037-tauri-panel-plugin.en.md](0037-tauri-panel-plugin.en.md)

- 状態: Accepted
- 日付: 2026-11-26（オーナー決定: crate の新設・純粋な部分の分離・TS の置き場）
- 関連: Issue #1006（下流: tyaro/banto-industrial#1281）/ spec §5.3 /
  [conventions.md](../conventions.md) §1・§3・§4・§6・§10 / [template-scope.md](../template-scope.md) §3 /
  [ADR-0002](0002-minimal-dependencies.md)・[ADR-0011](0011-git-tag-distribution.md)

## コンテキスト

`@banto/dock-svelte` には pop-out のボタンの口 `onPopOut` がある。押された後の Tauri の側（窓を開く・閉じた知らせ）は、
`apps/admin-template` の**写し用のコード**（`src/lib/banto/popout.ts` と `src-tauri/src/lib.rs` の `panel_open`）にしか無かった。

下流（banto-industrial の Hub）が、dock のパネルを 2 台目のモニタへ出したい。そこで要る振る舞いは、写しには無い:

- 位置・大きさをパネルの id ごとに覚え、次も同じ所に出す。モニタが外れて画面の外になるなら既定に戻す。
- メインの窓を閉じたら、パネルの窓も一緒に閉じる。

アプリごとに写すと、この振る舞いをそれぞれで作り直すことになる。再利用できる形で banto に置く。

制約:

- CI の headless の job は、tauri を含む crate をビルドできない（webkit2gtk が無い。ルートの `Cargo.toml` の `keyring` の注記と同じ）。
- 配布は git タグ（ADR-0011）。下流は `crates/*` を Git 依存で参照する。
- 依存は足さない（conventions §3、ADR-0002）。

## 決定

### 1. Rust の側は、新しい crate `crates/banto-tauri-panel`（Tauri v2 の plugin）に置く

アプリは `tauri::Builder` に `.plugin(banto_tauri_panel::init())` を足し、capability に `banto-tauri-panel:allow-open` と
`banto-tauri-panel:allow-list`（#1013 で追加）・`banto-tauri-panel:allow-close`（#1021 で追加）を足す。
plugin が持つもの:

- コマンド `open`（`plugin:banto-tauri-panel|open`、引数は `id` と `title`、省略可の `background`）。同じ id の窓が開いていれば前に出すだけ。
  `background`（`"#rrggbb"`。#1015 で追加）は、窓を作るときの背景色。ページが描かれるまでの約 2 秒、webview が既定の白に
  なるのを避ける。形は純粋な `parse_background` で検査し、違えばエラー（`validate_panel_id` と同じ扱い）。常に不透明にする
  （WebView2 は背景の alpha を 0 と 255 しか扱えない。`#rrggbbaa` は受けない）。`Builder::background` の既定があり、引数の
  値が優先。フロントは開くたびに今の画面の色を渡す（`createPanelPopOut` の `background`）ので、テーマの切り替えに追従する。
  すでに開いている窓の色は変えない。同じ `open` なので capability の追加は要らない。
  窓を作るとき、`title` を文書の題名にも入れる script を `initialization_script` で渡す（#1024。ページの script が
  動く前に走り、`<title>` を読み終えた時点で 1 回だけ置き換える。ページが後から付ける題名はそのまま通る。
  権限は増えない）。
  窓は**常に隠して作り、ページの読み込みが終わってから見せてフォーカスする**（#1024。`WebviewWindowBuilder::on_page_load`
  の `PageLoadEvent::Finished`）。開いてすぐ見せると、スクリーンリーダー（NVDA）が読み込み中の文書（「未定義」と URL）を
  読む。見せる条件は「置き終えた（覚えた位置 → 大きさを当てた。無ければすぐ）」かつ「読み込みが終わった、または
  待つのをやめた」で、見せるのは 1 回だけ。読み込みの知らせは別のスレッドから来て、置き終えるのと順が前後するので、
  判断は純粋な `Reveal`（`reveal` モジュール。3 つの合図 `Placed`・`Loaded`・`TimedOut` を受け、`true` を 1 回だけ返す）に
  置いた。ページがあとでもう一度 `Finished` を知らせても何もしない。知らせが来ない・失敗したときに窓が見えないままに
  ならないよう、`PanelConfig::reveal_timeout_ms`（既定 3000）だけ待って見せる（`0` は待たない。60000 を超える値は
  `validate` が断る）。隠れている間の移動・大きさの変更は、今までどおり記憶に入れない。
  **何を待って見せるかは `PanelConfig::reveal_on` で選ぶ**（#1024 の実機の結果から足した）。読み込みが終わった時点では、
  読み込みの後に自分で描くページ（SPA）の文書はまだ空で、そこで見せると NVDA は空の文書を「未定義」と URL で読む。
  `RevealOn::PageLoad`（既定）は上のとおり `Finished` で見せる（ページに何も求めない。今までのアプリはそのまま）。
  `RevealOn::Ready` は、**ページが「描けた」と知らせたとき**に見せる（`Finished` だけでは見せない）。知らせは Tauri の
  event `banto://panel-ready`（payload はパネルの id）で、ページが `@banto/admin-core` の `notifyPanelReady` で送る。
  コマンドにしなかったのは、権限を増やさないため（event の emit は `core:default` に含まれる。コマンドなら
  `allow-ready` をアプリの capability に足すことになる）。event は送り元の窓を運ばないので、誰の知らせかは payload の
  id で決める: plugin は窓を作る前に、その窓のための listener を 1 つ張り（先に張るので、知らせが先に来ることは無い）、
  自分の id を名乗る知らせだけを `Reveal` に渡す（合図 `Ready`。純粋な `ready_panel_id` が payload を検査する）。
  listener は窓の `Destroyed` で外し、窓を作れなかったときはその場で外す（残らない）。同じアプリの別の窓が他人の id を
  名乗れば見せられるが、起きるのは「窓が早く出る」だけで、capability に入っている自分のアプリの窓にしか送れない。
  どちらの選び方でも `reveal_timeout_ms` の逃げ道は効く（`Ready` でページが知らせないと、その時間まで窓が出ない）。
- コマンド `list`（`plugin:banto-tauri-panel|list`、引数なし。#1013 で追加）。今開いているパネルの窓の id を返す
  （plugin が作って、まだ閉じたのを見ていない窓）。
- コマンド `close`（`plugin:banto-tauri-panel|close`、引数は `id`。#1021 で追加）。その id の窓を閉じる（plugin が
  作った窓だけ。`destroy` なので、パネルの側は止められない）。窓を閉じたら `true`、窓が無ければ `false` を返す
  （無い id はエラーにしない。呼ぶ側が欲しいのは「窓が無いこと」）。閉じた窓の記憶と下の知らせは、利用者が閉じたときと同じ。
- 窓が無くなったら、メインの窓へ `banto://panel-closed`（payload はパネルの id）を出す。
- 位置・大きさを id ごとに覚える（既定は app の data dir の `panel-windows.json`）。画面の外なら既定の位置・大きさで開く。
- メインの窓が無くなったら、パネルの窓も閉じる（記憶は残す）。
- 設定（`banto_tauri_panel::Builder`）: ルートの形（既定 `panel/{id}`）、メインの窓のラベル（既定 `main`）、パネルの窓のラベルの接頭辞
  （既定 `panel-`）、既定と最小の大きさ、**記憶を切る**（`remember_geometry(false)`）、**一緒に閉じるのを切る**
  （`close_with_main(false)`）、記憶の保存先（`store_path`）、窓の既定の背景色（`background`）。題名は開くたびにフロントから渡す。
- plugin は**自分が作った窓（ラベル → id）だけ**を追跡し、前に出す・閉じた知らせ・記憶・メインと一緒に閉じる、の対象を
  それに限る。ラベルが接頭辞に合うだけの、アプリ自身の窓には触らない。設定は `PanelConfig::validate`（純粋）で
  検査し、空の接頭辞・不正な文字・空のメインのラベル・接頭辞で始まるメインのラベルは `setup` が `Err` を返して
  起動で止める（panic はしない）。

### 2. 規則のある部分は tauri に依存しない純粋なモジュールに分け、feature で切る

| 部分                                                                        | 中身                                                                                                                                                                                     | 確かめ方                                                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 純粋（`config`・`geometry`・`reveal`・`store`・`title`。std と serde だけ） | id の検査、ラベルとルートの組み立て、画面の外の判定、窓をいつ見せるか、文書の題名の script、記憶の JSON の読み書き（壊れたファイルは空として読む。書き込みは一時ファイルから置き換える） | 単体テスト。`ci.yml` の rust の job が `cargo test -p banto-tauri-panel --no-default-features` で走らせる |
| Tauri の配線（`plugin`。feature `tauri`、**既定で on**）                    | 窓・モニタ・イベントを Tauri に聞いて、値を純粋な部分に渡すだけ                                                                                                                          | コードレビュー、`tauri-check.yml`（ubuntu と windows でコンパイル・clippy）、実機の確認                   |

`tauri` を既定で on にするのは、アプリが依存を 1 行足すだけで使えるようにするため。headless でビルドする所
（`ci.yml` の該当の step と外部利用 fixture）だけが `--no-default-features`／`default-features = false` を書く。

### 3. パネルの id は ASCII の英数字と `-`・`_` だけ（64 文字まで）

id は webview から来て、窓のラベル・読み込むルート・記憶のファイルのキーになる。この文字だけを通すので、
ルートの形を変える（`../`・`?`・`#`）ことも、Tauri のラベルの規則を破ることもできない（conventions §6:
ユーザーの入力をパスに使わない）。ルートの形そのものは Rust の設定で決まり、フロントからは渡せない。

### 4. 位置・大きさは物理ピクセルで持ち、判定は「上の帯がどれかのモニタに乗っているか」

- 論理ピクセルは 1 つのモニタの倍率と組でしか意味を持たない。窓は別のモニタに戻るので、物理ピクセル
  （`outer_position`・`inner_size`・モニタの `position`・`size`）で持つ。
- 画面の中とみなすのは、窓の上の帯（高さ 32px。掴んで動かす所）が 1 つのモニタの中に縦に収まり、横に 100px 以上
  （窓がそれより狭ければ全部）乗っているとき。Windows の見えない枠のはみ出し（-8 前後）は 16px まで許す。
- 最小化・最大化・全画面・非表示の間は覚えない。0 に近い大きさや最小化の位置（-32000）は、覚えも戻しもしない。
- 記憶は 256 件まで。それを超える新しい id は覚えない（ファイルを際限なく大きくしない）。

### 5. TS の側は `@banto/admin-core` に置く

`openPanelWindow`・`listenPanelClosed`・`createPanelPopOut`（`packages/admin-core/src/panelWindow.ts`）。

- `isTauri`・`invoke`・`listen` は**注入**する。admin-core は `@tauri-apps/api` に依存しない（`events.ts`・`providers/tauri.ts` と同じ）。
- `createPanelPopOut` は dock に渡す `onPopOut` と、閉じた知らせで dock に戻す購読（`connect()`）を 1 つにまとめる。
  ブラウザでは `onPopOut` が `undefined` になる。**ブラウザでは `onPopOut` を渡さない（ボタンを出さない）**という
  `@banto/dock-svelte` との約束はそのまま。
- パネルを dock から外すのは、`connect()` の購読が成功したとわかってから。閉じた知らせが戻る唯一の道だから。
  登録の途中で pop-out が押されたら済むのを待つ。登録に失敗していたら何も外さず、`onError` に理由を渡す。待つ間や `detach` の間に `connect()` が止まったら窓を開かない（`detach` 済みなら `restore` で戻す）。
- **窓に出しているパネルの id を覚える**（#1013・#1014）。`detach` で dock から外した時から、`restore` で戻すまで。
  保存先は注入する（`storage: { load, save }`。テンプレートは利用者ごとの localStorage）。`connect()` のたびに plugin の
  `list` と突き合わせ、覚えているのに**窓が開いていない**パネルを `restore` する（窓に出したままメインの窓を閉じると、
  閉じた知らせを受ける相手がおらず、dock の保存には「閉じた」状態が残るため）。窓が開いているもの（メインの再読み込み・
  画面の出入り）は覚えに残し、閉じた知らせで戻す。
  - **`list` に失敗したら何も戻さず、`onListError` に理由を渡す**。確かめずに戻す案は退けた: 窓が開いたままのとき、
    画面に入るたびに同じパネルが dock と窓の両方に出る。戻さない側は、パネルが「窓に出している」扱いで残るので失われない
    （`focus` で窓が開き、その窓を閉じれば dock に戻る）。
  - メインの窓の `CloseRequested` で先に dock へ戻してから閉じる案は退けた: 強制終了・クラッシュでは走らず、
    戻した dock の保存（非同期）が終わる前に窓が閉じることもある。起動時の突き合わせは、どの終わり方でも効く。
  - **dock に戻したパネルの id は、戻した配置が保存できたとわかるまで `storage` に残す**（#1019）。配置の保存は別の
    部品（`@banto/dock-svelte` の `createDockLayoutStore`）が後から非同期に行い、失敗しうる。戻した時点で覚えを消すと、
    保存に失敗したとき、次の起動では provider の古い配置（パネルが閉じた状態）が勝ち、覚えも無いのでパネルがまた消える。
    `restore` の戻り値で受ける: 何も返さなければその場で忘れる（今までどおり。配置を保存しない dock 向け）、Promise を
    返せば `true`（または値なし）で解決するまで残す。`false`・reject・解決しないまま終わった場合は残り、次の
    `createPanelPopOut`（次の起動・次に画面へ入ったとき）がもう一度 `restore` する（これが再試行）。`isPoppedOut` は
    `restore` を呼ぶ前から `false`（dock にあるパネルを「窓に出している」と見せない）。保存を確かめた後は覚えが無いので、
    利用者がその後に閉じたパネルは戻らない。
    - admin-core は `@banto/dock-svelte` を import しない（conventions §4）ので、つなぐのはアプリ。配置ストアの `commit`
      は書き込みの結果（`'saved'`・`'unchanged'`・`'failed'`・`'dropped'`）の Promise を返す。テンプレートは
      `popout.ts` の `createLayoutSaveWatch` で「`restore` より後の報告が 1 つ保存できた」を `restore` の戻り値にする。
    - 退けた案: (a) `restore` が配置ストアの `commit` を自分で呼んで、その Promise を返す — 戻した配置を報告するのは
      `DockHost`（`onLayoutCommit`）で `restore` ではなく、二重の報告になる。(b) 配置ストアに `onSaved` の通知だけを足す —
      「どの報告の分が保存できたか」が分からず、戻す前から送信中だった書き込み（パネルを含まない配置）の成功で忘れて
      しまう。(c) admin-core の中で書き込みを再試行する — 保存先も配置も admin-core は知らない。(d) 次の起動で
      provider よりローカルの写しを優先する — 利用者ごと・端末をまたぐ保存の決まり（provider が正）を変えることになる。
    - 残る割り切り: 保存に失敗した後、利用者がパネルを閉じ、その保存も失敗したまま終わると、次の起動でパネルは戻る
      （保存できていない以上、どちらが意図かは分からない。失う側より戻す側に倒す）。`restore` しても配置が変わらない
      とき（読み込みに失敗して既定が出ていて、そこにパネルがある、など）は報告が出ないので、次に何かが保存できるまで
      覚えが残る。
  - **`closeWindows(ids?, { saved }?)` で、窓を閉じて `restore` せずに忘れる**（#1021）。dock が自分でパネルを取り戻す操作
    （配置を既定に戻す）では、窓に出していたパネルが窓と dock の二重になる。アプリはその操作が**適用された後で**呼ぶ
    （断られたら呼ばない）。閉じた（または窓が無かった）id は `isPoppedOut` を `false` にし、`storage` から消し、
    その窓の `banto://panel-closed` では `restore` しない（`close` が `true` を返した窓の知らせを 1 回だけ読み捨てる。
    答えより先に知らせが来た場合も同じ扱い。読み捨てる数は id ごとに数えるので、知らせが届く前に同じ id をもう一度
    閉じても — 窓がもう無くても、その間に出し直した窓を閉じても — 先の窓の分は残る）。**`saved` を渡すと、`storage`
    から消すのは「パネルが戻った配置を保存できた」と分かった後**（`restore` が返す Promise と同じ扱い・同じ理由: 保存済みの
    配置はそのパネルを含まず、リセットの保存は後から別に走って失敗しうる。確かめる前に消すと、保存の失敗や保存前の終了の
    後の起動でパネルがどこにも無くなる）。確かめられなかった id は次の `connect()` が `restore` する（読んだ配置に
    パネルがもうあれば `restore` は無害であること、が `restore` の条件）。`ids` を省くと覚えているパネル全部、渡すと覚えていない id も plugin に
    聞く（`storage` なしで再読み込みした後の窓も閉じられる）。
    - **閉じられなかった窓は、そのままにする**（`failed` に理由を返す。reject しない）: パネルは「窓に出している」扱いで
      覚えにも残り、あとでその窓が閉じれば通常どおり `restore` する（dock にもうあるパネルへの `restore` は無害で
      あること。`dock.open` はそう）。窓が実際に開いているので、表示メニューが「窓を前に出す」のままなのが正しい。
      退けた案: 失敗しても忘れる — 窓は開いたままなのに、次の `panel-closed` で「知らないパネル」として `restore`
      され、表示メニューからは窓に届かなくなる。
    - 開いている途中の窓（pop-out・`focus` の最中）は閉じない（`failed`）。plugin に聞いている間に同じパネルがまた
      窓に出されたら（id ごとの世代が進んでいたら）、忘れない。購読が止まったら、届かない知らせを待つ印は捨てる
      （残すと、次の窓の知らせを読み捨ててしまう）。
    - 退けた案: plugin の側で、`close` で閉じた窓の知らせを出さない — 「窓が無くなったら必ず知らせる」という plugin の
      決まりが崩れ、`listenPanelClosed` だけで窓の有無を追っているコードが取りこぼす。
  - `isPoppedOut(id)`・`subscribe(cb)`・`focus(content)` を持つ。dock から見ると窓に出したパネルは閉じたパネルと区別が
    つかないので、パネルの一覧（表示メニュー）はこれを見て「表示中」にし、選ばれたら窓を前に出す（dock に出すと二重になる）。
    `focus` は窓に出していないパネルには何もしない。変化の知らせは購読関数（admin-core は Svelte に依存しない）。
- `@banto/dock-svelte` は import しない（conventions §4）。`PanelWindowContent`（`id` と `title`）は、dock の
  `PanelContent` のうちこのモジュールが読む部分。

### 6. REST との対称（conventions §1）の対象にしない

`open`・`list`・`close` はデータを書かず、監査も無い。この PC の窓を開く・閉じるだけの desktop-only の操作で、REST の対は作らない
（テンプレートの旧 `panel_open` と同じ分類）。plugin のコマンドは `lib.rs` のトップレベルのコマンドではないので、
`verify:architecture` の rule 8 の走査には入らない。

### 7. 依存（conventions §3）

- 実行時: `tauri`（アプリが既に持つ）と `serde`・`serde_json`（workspace に既にある）。
- ビルド時: **`tauri-plugin`**（`build` feature。plugin の permission を生成する。Tauri の plugin の決まった作り）。
  `Cargo.lock` に増える crate は `tauri-plugin` 1 つで、その依存（`tauri-utils`・`anyhow`・`glob`・`plist`・`schemars`・
  `walkdir` など）は `tauri-build` の経路で既に入っている。feature `tauri` の内側（optional）なので、headless のビルドには入らない。
- 窓の位置を覚える既製の plugin（`tauri-plugin-window-state`）は引かない（下の案 C）。

## 検討した代替案

- **案 A（採用）**: 新しい crate（plugin）+ 純粋な部分を feature で分ける。
  利点: 下流は依存 1 行と `.plugin(...)` で使える。規則は headless の CI で試験できる。
  欠点: crate が 1 つ増える。Tauri の配線の振る舞いは CI では試験できない（コンパイルと clippy まで）。
- **案 B（不採用）**: テンプレートの写しを育てる（`panel_open` に記憶と一緒に閉じるを足す）。
  下流がそれぞれ写して作り直すことになる。Issue の出発点そのもの。
- **案 C（不採用）**: `tauri-plugin-window-state` を使う。
  既製だが、窓のラベル単位で全部の窓（メインも）を対象にし、「id ごと・パネルだけ」「画面の外なら既定に戻す」の決まりを
  こちらで持てない。閉じた知らせとメインと一緒に閉じることは別に要る。依存も増える（ADR-0002）。
  必要な部分は 200 行ほどで、エッジケースは画面の外の判定に集まり、そこは純粋な関数として試験できる。
- **案 D（不採用）**: 既存の crate（`banto-server` など）に入れる。
  tauri を知らない層に tauri が入る（conventions §2）。headless の job がその crate をビルドできなくなる。
- **案 E（不採用）**: plugin にせず、アプリの `invoke_handler` に載せる関数として配る。
  コマンドの登録・イベントの処理・状態の `manage` をアプリごとに書くことになり、配線の漏れ（メインを閉じたときの処理など）が
  起きやすい。plugin なら 1 行で全部が載る。permission の設定が 1 行要るのは plugin の側の欠点。
- **TS の置き場**: `@banto/dock-svelte` に置く案は退けた。dock は Tauri を知らないパッケージで、`invoke`・`listen` の注入の形は
  admin-core に既にある。dock を使わない画面からも窓を開ける。

## 帰結

- 公開 crate が 1 つ増える（6 個目）。版は workspace に揃う。外部利用 fixture は `default-features = false` で導入する
  （rule `external-consumer-fixture`）。
- Tauri の配線（`src/plugin.rs`）を変える PR は、実機で確かめる: 開く・前に出す・閉じて dock に戻る・位置と大きさが戻る・
  モニタを外すと既定に戻る・メインを閉じるとパネルも閉じる・出したままメインを閉じた次の起動で dock に戻る・
  出したままメインを再読み込みしても二重にならない。CI はコンパイルと clippy までしか見ない。
- plugin の名前（`banto-tauri-panel`）は、`Cargo.toml` の `links`・`PLUGIN_NAME`・admin-core の `PANEL_OPEN_COMMAND`・
  アプリの capability の 4 か所で同じでなければならない。変えるときは全部を同じ PR で変える（下流の capability も変わる）。
- `permissions/` は build が生成するファイルで、コミットしておく（Tauri の plugin の慣習。手で直さない）。コマンドを足したら
  `build.rs` の `COMMANDS` に足す。**コマンドを足すと、下流の capability に許可が 1 行増える**（`list` は v9.3.0 の後に
  足した。許可が無いアプリでは `list` が失敗し、上の「何も戻さない」側に倒れる。`close` も同じく後から足した。
  許可が無いアプリでは `close` が失敗し、`closeWindows` の `failed` に入って窓は開いたまま残る）。
- 記憶のファイルの形（`version` 1）を変えるときは `version` を上げる。古い版のファイルは空として読まれ、次の保存で置き換わる
  （記憶は便利のためのもので、失われても困らない）。
- dock を外すアプリは、`src-tauri` の依存・`.plugin(...)`・capability の行を手で外す
  （[remove-optional-assets](../recipes/remove-optional-assets.md)。`pnpm scaffold` は `src-tauri` を書き換えない）。
- パネルの窓で何を描くか、購読・認証のセッションを別の窓でどう持つかは、アプリの側に残る。
