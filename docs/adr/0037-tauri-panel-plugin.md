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
`banto-tauri-panel:allow-list`（#1013 で追加）を足す。
plugin が持つもの:

- コマンド `open`（`plugin:banto-tauri-panel|open`、引数は `id` と `title`）。同じ id の窓が開いていれば前に出すだけ。
- コマンド `list`（`plugin:banto-tauri-panel|list`、引数なし。#1013 で追加）。今開いているパネルの窓の id を返す
  （plugin が作って、まだ閉じたのを見ていない窓）。
- 窓が無くなったら、メインの窓へ `banto://panel-closed`（payload はパネルの id）を出す。
- 位置・大きさを id ごとに覚える（既定は app の data dir の `panel-windows.json`）。画面の外なら既定の位置・大きさで開く。
- メインの窓が無くなったら、パネルの窓も閉じる（記憶は残す）。
- 設定（`banto_tauri_panel::Builder`）: ルートの形（既定 `panel/{id}`）、メインの窓のラベル（既定 `main`）、パネルの窓のラベルの接頭辞
  （既定 `panel-`）、既定と最小の大きさ、**記憶を切る**（`remember_geometry(false)`）、**一緒に閉じるのを切る**
  （`close_with_main(false)`）、記憶の保存先（`store_path`）。題名は開くたびにフロントから渡す。
- plugin は**自分が作った窓（ラベル → id）だけ**を追跡し、前に出す・閉じた知らせ・記憶・メインと一緒に閉じる、の対象を
  それに限る。ラベルが接頭辞に合うだけの、アプリ自身の窓には触らない。設定は `PanelConfig::validate`（純粋）で
  検査し、空の接頭辞・不正な文字・空のメインのラベル・接頭辞で始まるメインのラベルは `setup` が `Err` を返して
  起動で止める（panic はしない）。

### 2. 規則のある部分は tauri に依存しない純粋なモジュールに分け、feature で切る

| 部分                                                     | 中身                                                                                                                                              | 確かめ方                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 純粋（`config`・`geometry`・`store`。std と serde だけ） | id の検査、ラベルとルートの組み立て、画面の外の判定、記憶の JSON の読み書き（壊れたファイルは空として読む。書き込みは一時ファイルから置き換える） | 単体テスト。`ci.yml` の rust の job が `cargo test -p banto-tauri-panel --no-default-features` で走らせる |
| Tauri の配線（`plugin`。feature `tauri`、**既定で on**） | 窓・モニタ・イベントを Tauri に聞いて、値を純粋な部分に渡すだけ                                                                                   | コードレビュー、`tauri-check.yml`（ubuntu と windows でコンパイル・clippy）、実機の確認                   |

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
  - `isPoppedOut(id)`・`subscribe(cb)`・`focus(content)` を持つ。dock から見ると窓に出したパネルは閉じたパネルと区別が
    つかないので、パネルの一覧（表示メニュー）はこれを見て「表示中」にし、選ばれたら窓を前に出す（dock に出すと二重になる）。
    `focus` は窓に出していないパネルには何もしない。変化の知らせは購読関数（admin-core は Svelte に依存しない）。
- `@banto/dock-svelte` は import しない（conventions §4）。`PanelWindowContent`（`id` と `title`）は、dock の
  `PanelContent` のうちこのモジュールが読む部分。

### 6. REST との対称（conventions §1）の対象にしない

`open`・`list` はデータを書かず、監査も無い。この PC の窓を開くだけの desktop-only の操作で、REST の対は作らない
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
  足した。許可が無いアプリでは `list` が失敗し、上の「何も戻さない」側に倒れる）。
- 記憶のファイルの形（`version` 1）を変えるときは `version` を上げる。古い版のファイルは空として読まれ、次の保存で置き換わる
  （記憶は便利のためのもので、失われても困らない）。
- dock を外すアプリは、`src-tauri` の依存・`.plugin(...)`・capability の行を手で外す
  （[remove-optional-assets](../recipes/remove-optional-assets.md)。`pnpm scaffold` は `src-tauri` を書き換えない）。
- パネルの窓で何を描くか、購読・認証のセッションを別の窓でどう持つかは、アプリの側に残る。
