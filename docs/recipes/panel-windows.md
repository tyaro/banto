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
- **メインの窓を閉じたら、パネルの窓も一緒に閉じる**（位置・大きさの記憶は残る）。
- **今開いているパネルの窓の id を答える**（コマンド `list`）。`createPanelPopOut` が、窓に出していたパネルを次の起動で
  dock に戻すのに使う（下の 4.）。

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

`src-tauri/capabilities/default.json` の `permissions` に、plugin のコマンドの許可を足す（`open`・`list`・`close` の 3 つ）。
パネルの窓が自分のコマンド（データの取得など）を呼ぶなら、`windows` にパネルの窓のラベル（接頭辞 + `*`）も要る:

```jsonc
{
	"windows": ["main", "panel-*"],
	"permissions": [
		"core:default",
		"banto-tauri-panel:allow-open",
		"banto-tauri-panel:allow-list",
		"banto-tauri-panel:allow-close"
	]
}
```

`allow-open` を足し忘れると、窓を開く操作が「not allowed」で失敗する（`createPanelPopOut` はパネルを dock に戻し、`onError` を呼ぶ）。
`allow-list` を足し忘れると（v9.3.0 から上げたアプリは足す）、**窓に出したままアプリを閉じたパネルが、次の起動で dock に
戻らない**（`onListError` に理由が渡る。パネルは「窓に出している」扱いのまま残るので、表示メニューなどから `focus` すれば
窓が開き、その窓を閉じれば dock に戻る）。
`allow-close` を足し忘れると（v9.3.0 から上げたアプリは足す）、**窓に出している間に dock の配置を既定に戻しても、窓が
閉じない**（`closeWindows` の `failed` に理由が入る。パネルは窓と dock の両方に出て、「窓に出している」扱いのまま残る。
窓を手で閉じれば片づく）。
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

**文書の題名（`<title>`）は、窓の題名（`open` の `title`）と同じ文字列にする**（テンプレートは
`<svelte:head><title>{def?.title ?? id}</title></svelte:head>`）。plugin は、ページの script が動く前に文書の題名を
窓の題名にしておく（#1024。スクリーンリーダーは窓を開いた直後に文書を読むので、何もしないと `app.html` の固定の
題名が読まれる）。ページが後から別の題名を付ければそちらが残るが、同じ文字列にしておけば読まれる名前が途中で
変わらない。

**`app.html` の `%sveltekit.body%` を包む `<div>` には `role="presentation"` を付ける**（テンプレートの `app.html`
が見本。#1024）。Svelte は click などの listener をこの要素にまとめて付け、Chromium は click の listener を持つ要素を
「クリック可能」として公開する。付けないと、NVDA はどの窓でも最初のランドマークの前で「クリック可能」と読む
（パネルの窓に限らない）。

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
	// 窓が閉じたら（開けなかったときも）、パネルを dock に戻す。dock の配置を保存しているなら、
	// 「戻した配置が保存できた」の Promise を返す（下の「戻した配置が保存できるまで覚えておく」）
	restore: (id) => dock.open(id),
	// 窓に出しているパネルの id の覚え（次の起動まで残す所）。キーは dock ごと・利用者ごとに分ける
	storage: {
		load: () => JSON.parse(localStorage.getItem('myapp.dock.popout') ?? '[]'),
		save: (ids) => localStorage.setItem('myapp.dock.popout', JSON.stringify(ids))
	},
	// 開いている窓を plugin に聞けなかった（capability に allow-list が無い、など）
	onListError: (error) => console.error(error)
});

// 閉じた知らせの購読と、窓が無くなっているパネルを dock に戻す突き合わせ。ブラウザでは何もしない
$effect(() => popOut.connect());
```

**窓に出しているパネルを覚える**（`storage`）: pop-out はパネルを dock から外すので、dock の保存には「閉じた」状態が入る。
窓に出したままメインの窓を閉じると、閉じた知らせを受ける相手がいないので、覚えが無ければ次の起動でパネルが dock にも
窓にも無い。`storage` を渡すと、`connect()` が覚えている id を plugin の `list` と突き合わせ、**窓が開いていないもの**を
`restore` で dock に戻す（窓が開いているもの＝メインの再読み込みや画面の出入りは、そのまま。窓を閉じたときに戻る）。

- `connect()` は、**保存した dock のレイアウトを読み終えてから**呼ぶ。先に呼ぶと、戻したパネルが後から読んだ
  レイアウトで上書きされる（テンプレートのダッシュボードは `dockLayout.load()` の完了を待つ）。
- `connect()` を dock の mount に結び付けない。狭い画面などで `DockHost` を外している間も、閉じた窓のパネルは
  戻す必要がある。`DockHost` が無い間は `onLayoutCommit` が来ないので、`restore` の中で自分で保存する
  （テンプレートは `if (!dockHost) void reportLayout(dock.layout, 'user')`）。
- `list` に失敗したら何も戻さない（`onListError`）。確かめずに戻すと、窓が開いたままのとき（再読み込み・画面の出入り）に
  同じパネルが dock と窓の両方に出るため。

**戻した配置が保存できるまで覚えておく**（#1019。dock の配置を provider に保存しているアプリ）: パネルを dock に
戻しても、その配置の保存（`createDockLayoutStore` なら 500ms 後の書き込み）が失敗すると、次の起動では provider の
古い配置（パネルが閉じた状態）が読まれる。そのとき覚えが消えていると、パネルはまた dock に無くなる。`restore` が
**Promise を返す**と、`true`（または値なし）で解決するまで id を `storage` に残し、解決しなかった・`false`・reject の
ときは次の `connect()`（次の起動・次に画面へ入ったとき）がもう一度 `restore` する。`isPoppedOut` は戻した時点で
`false` になる（残るのは覚えだけ）。保存できた後は覚えが消えるので、利用者がその後に閉じたパネルは戻らない。

**配置を既定に戻すとき**（#1021。`closeWindows`）: 既定の配置に戻す・保存した配置を読み直す、のように **dock が
パネルを自分で取り戻す操作**では、窓に出していたパネルが窓と dock の両方に出る。その操作が**適用された後で**
`popOut.closeWindows()` を呼ぶと、窓を閉じ、覚えから消し、`restore` は呼ばない（その窓の閉じた知らせでも呼ばない。
知らせが届く前に同じ id をもう一度閉じても同じ）。
操作が断られたとき（`beforePanelChange` で取り消した、など）は呼ばない — パネルは窓にだけあるままでよい。

**配置を保存しているなら `saved` を渡す**。保存済みの配置は、窓に出した時点からそのパネルを含まない。リセットの保存が
失敗した・保存の前にアプリが終わったときに覚えが先に消えていると、次の起動で古い配置が読まれ、パネルがどこにも無くなる。
`saved`（`restore` の戻り値と同じ「パネルが戻った配置を保存できた」の Promise）を渡すと、窓はすぐ閉じるが、id は
それが `false` 以外で解決するまで `storage` に残り、解決しなかった・`false`・reject のときは次の `connect()` が
そのパネルを `restore` する（読んだ配置にもうパネルがあれば、`dock.open(id)` は何もしない）。`saved` は**配置を
差し替える前に**取る（差し替えの報告より後に取ると、その報告の保存を数えられない）。

```ts
const saved = saves.next(); // createLayoutSaveWatch（下）。配置を保存しない dock では要らない
const outcome = await dockHost.replaceLayout(defaultLayout(), { saved: true, commit: 'reset' });
if (outcome === 'applied') {
	// ids なし = 窓に出しているパネル全部。id を渡すと、覚えていない窓（storage なしで再読み込みした後など）も閉じる
	const { failed } = await popOut.closeWindows(
		PANELS.map((p) => p.id),
		{ saved }
	);
	if (failed.length > 0) console.error('closing the panel windows failed', failed);
}
```

閉じられなかった窓（capability に `allow-close` が無い、など）は `failed` に入り、パネルは「窓に出している」扱いの
まま残る（`closeWindows` は reject しない）。その窓をあとで閉じると `restore` が呼ばれるので、`restore` は dock に
もうあるパネルに対して無害にしておく（`dock.open(id)` は、ドッキング済みの id には何もしない）。

`createDockLayoutStore` の `commit` は、その報告がどうなったかの Promise を返す（`'saved'`・`'unchanged'`・
`'failed'`・`'dropped'`。reject しない）。報告するのは `DockHost` で `restore` ではないので、全部の報告を 1 か所に
通して、「`restore` より後の報告が保存できた」を待つ。テンプレートの `createLayoutSaveWatch`（`popout.ts`。
30 行ほどなので写してよい）がそれをする:

```ts
const layoutSaves = createLayoutSaveWatch();
const reportLayout: typeof dockLayout.commit = (layout, reason) => {
	const outcome = dockLayout.commit(layout, reason);
	layoutSaves.track(outcome); // 全部の報告を、報告した順に渡す
	return outcome;
};
// <DockHost {dock} onLayoutCommit={reportLayout} ... />

restore: (id) => {
	const saved = layoutSaves.next(); // dock を変える前に取る（これより後の報告だけを数える）
	dock.open(id);
	if (!dockHost) void reportLayout(dock.layout, 'user'); // DockHost が無い間は自分で報告する
	return saved; // 保存できたら true。失敗の間は解決しない（＝覚えたまま）
};
```

- 「後の報告」に限るのは、戻す前から送信中だった書き込み（パネルを含まない配置）の成功で忘れないため。
- 後の報告なら**どれでもよい**のは、書き込みが配置の全体を運ぶため。失敗の後でも、次に保存できた時点の配置が
  provider に入る（利用者がそのときまでにパネルを閉じていれば、閉じた配置が入り、次の起動でも閉じている）。
- 書き込みの再試行はしない。失敗したら覚えが残り、次の起動（次に画面へ入ったとき）に戻し直して書き直す。
- 配置を保存しない dock は今までどおり `restore: (id) => dock.open(id)`（何も返さない＝その場で忘れる）でよい。

**窓に出しているパネルを「表示中」として扱う**: dock から見ると、窓に出したパネルは閉じたパネルと区別がつかない。
パネルの一覧（表示メニューなど）を持つ画面は、`popOut.isPoppedOut(id)` が真のパネルを**チェック付き**で出し、選ばれたら
dock に出さずに `popOut.focus({ id, title })` で**窓を前に出す**（dock に出すと、窓と dock の二重になる）。
`isPoppedOut` の変化は `popOut.subscribe(cb)` で知らせる。Svelte 5 なら `svelte/reactivity` の `createSubscriber` で包む
（テンプレートの `createAppPanelPopOut` は包んだ `isPoppedOut` を返す）:

```ts
import { createSubscriber } from 'svelte/reactivity';

const track = createSubscriber((update) => popOut.subscribe(update));
const isPoppedOut = (id: string) => (track(), popOut.isPoppedOut(id));
```

```svelte
<!-- ブラウザでは popOut.onPopOut が undefined なので、pop-out のボタンは出ない -->
<DockHost {dock} onPopOut={popOut.onPopOut} ... />
```

**窓の背景色**（#1015）: 窓を開いてからページが描かれるまでの約 2 秒、webview は既定の白で、ダークテーマでは目立つ。
`createPanelPopOut`（と `openPanelWindow`）の `background: () => string | undefined` に、**今の画面の背景色を
`#rrggbb` で返す関数**を渡すと、窓はその色で作られる（開くたびに呼ぶので、テーマの切り替えに追従する。`undefined` なら
渡さず、plugin の既定のまま）。テンプレートは `createAppPanelPopOut` が `readPageBackground`（`body` → `html` の
背景色。`oklch()` の色は canvas で変換する）を渡している。plugin 側の既定は `Builder::new().background("#1e1e2e")`
（引数が無い呼び出しだけに効く。`#rrggbb` 以外は起動時にエラー）。**パネルの窓の HTML も、CSS が届くまで背景が付く**
ようにしておく（テンプレートの `app.html` の `<style>`: 白い窓を作り直した直後は、webview の背景ではなくページの
背景が見えるため）。透明度は渡せない（WebView2 は背景の alpha を 0 と 255 しか扱わないので、plugin は常に不透明）。

dock を使わない画面から窓を開くだけなら `openPanelWindow({ id, title }, { isTauri, invoke })`、閉じた知らせだけ聞くなら
`listenPanelClosed((id) => ..., { isTauri, listen })`、今開いている窓の id は `listPanelWindows({ isTauri, invoke })`、窓を閉じるだけなら `closePanelWindow(id, { isTauri, invoke })`
（`createPanelPopOut` で出したパネルの窓は、覚えも片づける `popOut.closeWindows` で閉じる）。

## 5. 実機で確かめること

Tauri の配線は CI ではコンパイルまでしか見ない。出す前に、自分のアプリで確かめる:

1. pop-out のボタンでパネルが別の窓で開き、dock から消える。もう一度同じパネルを開く操作は、窓を前に出すだけ。
2. 窓を閉じると、パネルが dock に戻る。
3. 窓を動かして大きさを変え、閉じて開き直すと、同じ位置・大きさで開く。アプリを再起動した後も同じ。
4. 2 台目のモニタに置いて閉じ、モニタを外してから開くと、既定の位置・大きさで開く（画面の外に出ない）。
5. パネルの窓を開いたままメインの窓を閉じると、パネルの窓も閉じてアプリが終わる。次の起動ではパネルは dock にある
   （`storage` を渡し、capability に `banto-tauri-panel:allow-list` があるとき。出していた浮動の窓の位置に戻る）。
   もう一度終了して起動しても dock にある（戻した結果が dock の保存に入っている）。
6. パネルを窓に出したままメインの窓を再読み込みする（または別の画面へ行って戻る）と、窓は開いたままで、dock には
   同じパネルが出ない。そのあと窓を閉じると dock に戻る。
7. 窓に出しているパネルは、表示メニュー（パネルの一覧）でチェックが付いている。選ぶと窓が前に出るだけで、dock には
   出ない。
8. パネルを窓に出したまま、dock の配置を既定に戻す（テンプレートは表示メニューの「レイアウトを既定に戻す」）と、
   その窓が閉じ、パネルは dock の既定の場所に 1 つだけ出る（capability に `banto-tauri-panel:allow-close` があるとき）。
   表示メニューのチェックは付いたままで、選ぶと dock の側が閉じる（窓を前に出す扱いに戻らない）。再起動しても
   窓は開かず、パネルは dock に 1 つ。未適用の入力があって戻すのを取り消したときは、窓は閉じない。
9. ブラウザ（LAN 配信）では pop-out のボタンが出ない。
10. ダークテーマで、パネルを窓に出す。窓の中が白く光らず、最初から暗い背景で開く（#1015）。テーマを切り替えてから
    別のパネルを出すと、その色で開く。
11. スクリーンリーダー（NVDA など）を動かして窓を開くと、文書がパネルの名前で読まれる（`app.html` の固定の題名で
    読まれない）。窓の中を読み進めたとき、押せない見出しの前で「クリック可能」と読まれない。

## 外すとき

dock ごと外すなら [remove-optional-assets.md](remove-optional-assets.md) の「`@banto/dock-svelte`」（`src-tauri` の
plugin の登録・依存・capability の行は手で外す）。
