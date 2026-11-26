# レシピ: dock のパネルを OS の別ウィンドウへ出す（`banto-tauri-panel`）

作成日: 2026-11-26（#1006。トラックB＝アプリ作者向け）

Tauri のデスクトップ版で、dock のパネルを **OS の別ウィンドウ**（2 台目のモニタなど）へ出す。
Rust の側は Tauri v2 の plugin の crate `banto-tauri-panel`、フロントの側は `@banto/admin-core` の
`createPanelPopOut`。設計と判断は [ADR-0037](../adr/0037-tauri-panel-plugin.md)。

plugin がすること（アプリは書かなくてよい）:

- パネルの窓を開く。**同じ id の窓が開いていれば前に出すだけ**。
- 窓が閉じたら、メインの窓へ `banto://panel-closed`（payload はパネルの id）を出す。
- **位置・大きさをパネルの id ごとに覚える**。次に開くときは同じ所に出す。モニタが外れたなどで画面の外になるなら、
  既定の位置・大きさで開く。
- **メインの窓を閉じたら、パネルの窓も一緒に閉じる**（記憶は残る。次に起動したとき、パネルは dock に戻っている）。

アプリの側に残るもの: **パネルの窓で何を描くか**（ルートの中身）と、**別の窓で購読・認証のセッションをどう持つか**。

> テンプレート（`apps/admin-template`）は、ダッシュボードの dock でこの配線を済ませてある（`src/lib/banto/popout.ts`・
> `routes/(app)/dashboard/+page.svelte`・`routes/panel/[id]/`・`src-tauri`）。下は、自分のアプリの別の画面へ足すとき、
> またはテンプレートを写さずに作ったアプリで使うときの手順。
> **ブラウザ（LAN 配信）では使えない**。ブラウザでは dock に `onPopOut` を渡さない（ボタンが出ない）。`createPanelPopOut` が
> そうなるように作ってある。

## 1. Rust: 依存と plugin の登録

`src-tauri/Cargo.toml`（モノレポ内なら `{ workspace = true }`。本リポジトリ外からは
[consume-as-git-dependency.md](consume-as-git-dependency.md) と同じ git タグ参照）:

```toml
[dependencies]
banto-tauri-panel = { git = "https://github.com/tyaro/banto.git", tag = "vX.Y.Z" }
```

`src-tauri/src/lib.rs`:

```rust
tauri::Builder::default()
    .plugin(banto_tauri_panel::init())
    // ...
```

既定と違う所だけ、`Builder` で渡す:

```rust
.plugin(
    banto_tauri_panel::Builder::new()
        .route("tags/panel/{id}")      // パネルの窓のルート。{id} がパネルの id に置き換わる（既定 "panel/{id}"）
        .main_label("main")            // メインの窓のラベル（既定 "main"）
        .label_prefix("panel-")        // パネルの窓のラベルの接頭辞（既定 "panel-"）
        .default_size(560.0, 420.0)    // 既定の大きさ（論理ピクセル）
        .min_size(320.0, 240.0)        // 最小の大きさ
        .remember_geometry(true)       // false で位置・大きさを覚えない
        .close_with_main(true)         // false でメインを閉じてもパネルを残す
        // .store_path(dir.join("panel-windows.json"))  // 記憶の保存先（既定は app の data dir の panel-windows.json）
        .build(),
)
```

## 2. Tauri: capability

`src-tauri/capabilities/default.json` の `permissions` に、plugin のコマンドの許可を足す。パネルの窓が自分のコマンド
（データの取得など）を呼ぶなら、`windows` にパネルの窓のラベル（接頭辞 + `*`）も要る:

```jsonc
{
	"windows": ["main", "panel-*"],
	"permissions": ["core:default", "banto-tauri-panel:allow-open"]
}
```

許可を足し忘れると、窓を開く操作が「not allowed」で失敗する（`createPanelPopOut` はパネルを dock に戻し、`onError` を呼ぶ）。
閉じた知らせの購読（`connect()` の `listen`）が失敗したとき（event の許可が無いなど）は、パネルを dock から外さず、
`onError` に理由を渡す（戻す知らせが届かないので、外すとパネルの行き場がなくなる）。購読の登録が済む前に押されたときは、
済むのを待ってから進む。待っている間（や `detach` の間）に `connect()` が止まったら窓は開かず（`detach` 済みなら `restore` で戻す。`onError` は呼ばない）。

設定の誤りは起動時に分かる: 接頭辞が空、接頭辞が英数字・`-`・`_` 以外を含む、メインの窓のラベルが空または接頭辞で
始まる、のいずれかだと plugin の `setup` が `Err` を返し、アプリは理由つきで起動に失敗する（panic はしない）。
plugin は自分が作った窓だけを扱う: 同じ接頭辞のアプリ自身の窓があっても、前に出す・記憶する・メインと一緒に閉じる、の
どれの対象にもならない（その窓と同じラベルのパネルを開こうとすると、窓は作らずエラーを返す）。

## 3. フロント: パネルの窓のルート

plugin が開くのは、アプリの**同じフロントのビルド**の中のルート（既定 `panel/{id}`）。SvelteKit なら
`src/routes/panel/[id]/+page.svelte` を作り、`page.params.id` から描く中身を決める。
メインの窓とは別の文書なので、シェル（サイドバー・ヘッダ）は付けず、認証の確かめはこのルートが自分で行う
（テンプレートの `routes/panel/[id]/+page.svelte` が見本）。

**パネルの id は ASCII の英数字と `-`・`_`（64 文字まで）**。それ以外の id は plugin が断る
（id は窓のラベルとルートの一部になるため）。

## 4. フロント: dock に配線する

`@banto/admin-core` は `@tauri-apps/api` に依存しないので、`isTauri`・`invoke`・`listen` を渡す
（テンプレートでは `src/lib/banto/popout.ts` の `createAppPanelPopOut` が束ねている）:

```ts
import { invoke } from '@tauri-apps/api/core';
import { createPanelPopOut } from '@banto/admin-core';
import type { PanelContent } from '@banto/dock-svelte';
import { isTauri } from '#lib/banto/setup.js';

const popOut = createPanelPopOut<PanelContent>({
	isTauri,
	invoke,
	listen: async (event, cb) => (await import('@tauri-apps/api/event')).listen(event, cb),
	// 窓を開く前に、パネルを dock から外す。false を返すと取りやめ（窓は開かない）
	detach: async (content) => (await dockHost?.closePanel(content.id)) === 'applied',
	// 窓が閉じたら（開けなかったときも）、パネルを dock に戻す
	restore: (id) => dock.open(id)
});

// 閉じた知らせの購読。ブラウザでは何もしない
$effect(() => popOut.connect());
```

```svelte
<!-- ブラウザでは popOut.onPopOut が undefined なので、pop-out のボタンは出ない -->
<DockHost {dock} onPopOut={popOut.onPopOut} ... />
```

dock を使わない画面から窓を開くだけなら `openPanelWindow({ id, title }, { isTauri, invoke })`、閉じた知らせだけ聞くなら
`listenPanelClosed((id) => ..., { isTauri, listen })`。

## 5. 実機で確かめること

Tauri の配線は CI ではコンパイルまでしか見ない。出す前に、自分のアプリで確かめる:

1. pop-out のボタンでパネルが別の窓で開き、dock から消える。もう一度同じパネルを開く操作は、窓を前に出すだけ。
2. 窓を閉じると、パネルが dock に戻る。
3. 窓を動かして大きさを変え、閉じて開き直すと、同じ位置・大きさで開く。アプリを再起動した後も同じ。
4. 2 台目のモニタに置いて閉じ、モニタを外してから開くと、既定の位置・大きさで開く（画面の外に出ない）。
5. パネルの窓を開いたままメインの窓を閉じると、パネルの窓も閉じてアプリが終わる。次の起動ではパネルは dock にある。
6. ブラウザ（LAN 配信）では pop-out のボタンが出ない。

## 外すとき

dock ごと外すなら [remove-optional-assets.md](remove-optional-assets.md) の「`@banto/dock-svelte`」（`src-tauri` の
plugin の登録・依存・capability の行は手で外す）。
