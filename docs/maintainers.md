# 保守者向けの手引き（運用・決まっていること・教訓）

トラックA（保守者向け）。不変条件は [conventions.md](conventions.md)、設計の経緯は
[design/](design/) と [adr/](adr/README.md)、ここには**日々の運用の手順**と、
**過去の作業で決まって後の前提になっていること**、**繰り返さないための教訓**を置く。
不変条件を足す場所ではない（足すなら conventions.md）。

## 1. PR とレビューの流れ

- PR は作業ごとに小さく分け、worktree で作業して PR の作成までを 1 つの担当が持つ。
  作成後は、レビュー・CI・Codex の指摘・visual 基準画像の再生成を取りまとめる人が引き取り、
  マージはオーナーの承認で行う。
- 「CI が通ったらマージ」と言われたときは、GitHub の自動マージ（スカッシュ）を設定する。
  必須でないチェックは待たない。ただし **External consumer（`external-consumer.yml`）は例外**。
  必須チェックではないが、普通の CI では見られないこと（Git 依存としての導入、dev での描画）を確かめる
  ゲートなので、packages や crates を変える PR では成功を確かめてからマージを承認する
  （実行中・失敗のときはマージしない）。自動マージを設定するときも、その成功を待ってから設定する。
  詳しくは [docs/upgrading.md §8.2](upgrading.md) と [AGENTS.md](../AGENTS.md) を正とする。
  手でマージするときは `--match-head-commit` に完全な SHA を渡す。
- main の必須チェックはリポジトリのルールで掛かっている（管理者権限でも飛ばせない）。
- **レビューは 3 か所を見る**。どれか 1 つだけでは取りこぼす。
  1. Codex の行コメント（`pulls/N/comments`）
  2. Codex のまとめ
  3. クロスレビュー（`issues/N/comments`。更新（push）のたびに再レビューが来る）
  - クロスレビューで判断を問われたら、自動マージを外してから確認する。
- レビュー指摘の修正は、実装した担当を再開せず、**要点だけを渡した新しい担当**に任せる
  （読んだ大きなファイルやビルドのログが文脈に積み上がり、消費が急に増えるため）。
  README 1 行のような小さい修正は取りまとめる側が worktree で直してよい。
  同じ worktree に 2 つの担当を同時に入れない。
- **マージの成否を確かめてからブランチを消す**。ネットワークの失敗でマージが通っていないのに head を消すと
  PR が閉じる（2026-11-19 に通信エラーで失敗したマージの後に head を消して起きた。同じ SHA で push し直して reopen すれば戻るが、CI が全部走り直す）。
  ブランチを消すのは、オーナーが後片付けを指示したとき、またはマージの承認とあわせて許されたときだけ。
  **マージの承認とは別の判断**で、担当が終わったことを理由に消さない。
- 積み上げた PR（base が別の PR のブランチ）は、下を squash でマージすると上が衝突する。
  上の base を main に付け替え、main を取り込んで（CHANGELOG は両方の節を残す）push する。
  base が main でない間は CI の一部が走らない。

## 2. CI の仕組み

ジョブの一覧と増減は `.github/workflows/ci.yml` が一次情報（AGENTS.md「ビルドと検証」）。
ここには運用で効く点だけを書く。

### 2.1 必須チェックと `changes` ジョブ

- PR の CI は `changes` ジョブが、検証した merge commit の base/head を artifact `ci-verified-base`
  （7 日保持）に記録する。前の全部成功した run の記録の base が今と一致し、差分が基準画像だけなら、
  e2e-visual 以外を飛ばす（#740。Rust は matrix のため中身だけ飛ばしてチェック名を保つ）。
  template-acceptance は範囲外。

### 2.2 Template acceptance

- Copy→rename・Scaffold 4 本は、対象パスが変わったときだけ走る。**対象外の packages だけの変更で走らないのは正常**
  （`packages/theme/**` は対象に入っている）。対象のパスは `.github/workflows/template-acceptance.yml` の `paths` を正とする。
- フロントのみの変更では scaffold.mjs の陳腐化が検出されない。構造を変えたら、4 プリセットの
  `pnpm scaffold --dry-run` で自分で確かめる。メッセージのキー名は scaffold.mjs が名前で一致させている。
  - `audit.*` は display プリセットが消すので、監査ログ画面の外では `resource.*` を使う。
  - 新しい items の migration は、scaffold の items 削除一覧に足す。
  - display は `[scaffold:items]` の区間で items のテストを消すので、items のテストや補助関数は区間の中に置く。
    dry-run が通っても、コピーでの `cargo test` で初めて落ちることがある。
  - minimal/standard は添付を外すとき `rest/mod.rs` の import を消すので、items の REST は完全な path で書く。

### 2.3 visual の基準画像

- 基準画像は **Linux でだけ**作る。`visual-baselines.yml` を dispatch して再生成する（ローカルでは作らない）。
  - 見た目が変わる PR は、**PR を作る前**に基準画像を作る。CI は `pull_request` と `main` への push でだけ起動し（`.github/workflows/ci.yml` の `on:`）、
    作業ブランチへの push だけでは走らないので、ブランチを push → `gh workflow run visual-baselines.yml --ref <branch> -f commit=true` →
    bot のコミットを待って PR を作る、とすると CI が 1 回で済む。委譲の指示にも書く。
  - ワークフローが走っている間は、そのブランチへ push しない（non-fast-forward で bot の push が落ちる）。
    修正はコミットまでにして、画像が載ってから取り込む。
  - 新しい e2e が 1 件でも落ちると、run は何もコミットしない。先に e2e を直す。
  - bot の push では CI が走らない。続けて自分で push するか、PR を閉じて開き直す。
- **揺らぎの扱い**: 再生成では、関係のない画像（dashboard-*・command-palette・chart-gallery・kiosk・ui-demo）が
  よく揺らぐ。意図した変化でないものは main の版に戻す。
  - 揺らぎと決める前に、**run をまたいで画素数を比べる**。run の中の試行ごとに数が違っても、
    run をまたいで同じなら本当の差分（#674・#700 の kiosk 375x812）。差分の画像で意図した変化かを見る。
  - dock-svelte の見た目を変えた PR では、dashboard（分析ワークスペース）と command-palette が変わる。
    command-palette は背景に dashboard が写るので、dashboard を変えた PR では本当の差分
    （戻さず、再生成の版を採る）。
  - ui-demo の見本を足すと、date/time/datetime picker の画像も変わる（同じページを撮るため）。
- ローカルの visual の e2e は既存のビルドを preview で配信するので、確かめる前に
  `pnpm --filter admin-template build` を回す（`BANTO_E2E_SERVERS=visual` でその spec だけ流せる）。
  `pnpm e2e` は webServer が起動しないことがある。その場合は CI の E2E で確認する。

### 2.4 e2e の書き方

- ポップオーバー・メニューを開くものは `toPass()` で待つ。ロケーターは `exact: true` を意識する。
- AppPath は全プリセットにあるルート（`/settings` など）を使う。
- smoke の page では `page.context().newPage()` が使えない（`browser.newContext()` を要求される）。
- e2e が「遷移の副作用」で通っていた不具合は、画面遷移をやめると表に出る。
  CI の trace（artifact `playwright-test-results`）の pageError と network で原因を絞れる。
- SvelteKit の shallow `replaceState` は `page.url` を更新しない（URL は `window.location` から作る）。

## 3. リリースの流れ

版の判定は [publishing.md「バージョニング規約」](publishing.md#バージョニング規約)、タグの規約は同
「タグ運用規約」。手順は次のとおり。

1. **準備 PR**: `[Unreleased]` の切り出しと版上げ。**タグは打たない**。
   - 次の版を決める前に、`git diff -U0 <前タグ> HEAD -- 'crates/*/src'` の `^-\s*pub` と
     `packages/*/src/index.ts` の削除された export を見る。
   - CHANGELOG の B 節（テンプレート）は、`git diff --stat vX.Y.Z HEAD -- apps/admin-template/src` で
     取り込むファイルを洗う（v7.6.0 で ShellMenubar・Header・dashboardMemo が漏れた）。
   - 公開の union に種類を足した版は、型エラーの注意に全部の union を挙げる。
   - 移行手順の「変更不要」は、どの経路の利用者に当てはまるかまで限る（例: `serialize()` → `hydrate()` なら不要だが、
     文字列を JSON として読んで `replaceLayout` に渡すなら `saved: true` が要る、#746）。
2. 準備 PR をマージ。
3. main の SHA で `external-consumer.yml` を dispatch する。
4. 緑ならタグ（軽量）を push する。タグの push の run も確かめる。
5. **後片付け PR**: `external-fixture-set-ref.mjs`、fixture の install、CHANGELOG の「検証した組み合わせ」。
6. GitHub リリース。本文は CHANGELOG の節、リンクは `blob/vX.Y.Z` の絶対 URL。

予定されている版番号を鵜呑みにせず、`[Unreleased]` の中身を規約に照らして major/minor を判定し直す。

## 4. 委譲と並行 PR の進め方

- 委譲の指示に書くこと: 決まったこと／取りまとめ側が置く既定（PR 本文で「要確認」に列挙させる）／
  検証の範囲／`pnpm format:check`／ファイルは必要な範囲だけ読むこと（grep で位置を探してから行範囲を読む）／
  ビルド・テストの出力は `tail`・`grep` で絞ること／テストは名前で絞り、全体は最後に 1 回。
- 並行して委譲するときは worktree を分ける。
  - ブランチの削除は、マージが済んだことを確かめ（§1）、オーナーが後片付けを指示したとき、またはマージの承認とあわせて
    許されたときに行う。マージの承認とは別の判断。
  - worktree は、次をすべて確かめてから通常の `git worktree remove` で消す。
    - マージ済みの PR の、専用の worktree である。push 済みでもマージしていない worktree は、
      個別に許可を得たときだけ消す。
    - 未保存の変更が無い（`git status --porcelain` が空）。
    - 固有のファイル（未追跡の成果物）が無い。`git status --porcelain` には git が無視するファイル
      （`.gitignore` の対象）が出ないので、`git status --porcelain --ignored` で別に確かめる。
      独自のメモや成果物が無く、残るのが再生成できるもの（`node_modules`・ビルド出力など）だけであること。
    - それを使っているプロセスが無い。掴んでいるプロセス（担当が起こした
      `vite preview`・`banto-serve`、待機中のコマンド）は止めてから。
  - locked のとき、または削除に失敗したときは、理由を確かめる。理由が分からなければ止めて、オーナーに相談する。
    `git worktree remove -f -f` は、理由が分かっていて上の条件を満たすときだけ。
    `Directory not empty` で止まっても git の登録は外れる。残ったフォルダを手で消すのは、中身を確かめて、
    再生成できるもの（`node_modules`・ビルド出力など）だけだと分かったときに限る。
  - 新しい worktree には `node_modules` が無い。`pnpm install --frozen-lockfile`（`--offline` 可）から始める。
  - 並行の担当はスクラッチ用のディレクトリを共有することがあり、同名のスクリプトが上書きされた。
    一時ファイルの名前は担当ごとに分ける。
- 同じ計画書の状態行や CHANGELOG の先頭を書き換えると、1 本マージするたびに残りが衝突する
  （両方の行を残して main を取り込む）。並行で委譲するときは、CHANGELOG・README を触る PR を 1 本に寄せる
  （#686・#687）。同じファイルの自動マージは、手元で該当テストと check を回してから push する。
- Rust を触ったら、push 前に `cargo fmt --all -- --check` も回す。
- 文書の機械置換では、`re.S`（DOTALL）の正規表現で本文を置換しない（誤って本文を消した例がある）。
  文字列の完全一致で置換する。CRLF の環境では `newline=''` で開く（CRLF が混ざると prettier が落ちる）。
- Issue 本文をシェルの heredoc で書くときは `<<'EOF'`（引用符つき）にする。引用符なしだと、バッククォートが
  コマンド置換される（#638 の本文が欠けた）。本文はファイルに書いてから `gh issue create --body-file` で渡す。

## 5. 決まっていること（後の作業の前提）

### 5.1 版番号

[publishing.md「バージョニング規約」](publishing.md#バージョニング規約)が正。

### 5.2 デザイントークン（#557）

[design/visual-refresh-design.md §2.4](design/visual-refresh-design.md) と
[design/theme-dimension-tokens.md](design/theme-dimension-tokens.md) が正。新しい CSS の書き方は
[conventions.md §9](conventions.md)（`--banto-font-size-*`・`--banto-border-width*`・`--banto-space-*`、
packages の CSS に生の色を書くと raw-colors で Frontend と Scaffold 4 本が落ちる）。

### 5.3 楽観ロック（#638・#651）

- 整数の `version` 列。送らなければ従来どおり上書きで、**判定は `version` の有無だけ**。
  kind は `conflict`（REST は 409＋`current`）。
- CSV 取り込みは上書き（`version` は +1）。衝突は監査に残さない。users で版を上げるのは表示名・ロールだけ。
- 状態を「残っているデータから推測」しない。InMemory の版管理は、テーブルのメタデータ `versioned` で持つ（#641）。
- 手本は [recipes/add-resource.md](recipes/add-resource.md) の version の節（`check_version`・`VERSION_BUMP`）。

### 5.4 dock-svelte と「表示」メニュー（#663・#694）

利用者向けの API と挙動は [packages/dock-svelte/README.md](../packages/dock-svelte/README.md)、3 ペインの計画は
[design/three-pane-dock-plan.md](design/three-pane-dock-plan.md) が正。ここには保守で前提になる決定だけを置く。

- ドッキング中のパネルを閉じて開き直すと、元のドッキング先へ戻す（前後・同じタブの組を覚える。無ければ浮動）。
  `dock.open` は浮動で開くまま（Tauri pop-out の戻りを守る）。
- 「表示」メニューはページが中身を渡し、シェルが置き場を決める（メニューバーが出ていればそこ、出ていなければ
  ページ見出しの「表示」ボタン。常に 1 か所）。チェックを外す＝✕ と同じ。
- 浮動ウィンドウの位置固定は錠（#699）。旧ピンの API・文言・JSON の `pinned` は非推奨の別名で、次の major で削除する。
  固定中は、移動・リサイズ・キーボード移動/リサイズ・ドラッグでの合流を止め、タブの出し入れ・閉じる・前面化は許す。
  clamp は効く。
- pane が組み替わると再マウントされる（Svelte は親を移せない）。確認（`beforePanelChange`。押し出される側 → 動かす pane の順）で守る。
  `persistent` の pane は木の外で 1 回だけ描き、DOM ごと移すので作り直さない。
- #694（オーナー決定、Visual Studio・GX Works3 に寄せる）:
  - ドッキングは、ボタンの上で離したときだけ（十字 32px・外周ボタン）。ボタンの外で離すと、区画の上でも浮動。
    端 25% の帯の判定は廃止。
  - 外周に落とすと根を包み、入る側の比率は 0.25（区画への分割は 0.5 のまま）。外周の分割も仕切りで大きさを変えられる。
  - ドロップ先の能力は `dropCenter` / `dropSplit`（タブの組は全員が許すときだけ）。自動で隠す能力は `autoHide`
    （既定 true、メイン区画も既定では隠せる）。
  - ピン＝自動で隠す。区画は縁の帯へ（縁はメイン区画から見た側）、帯のタブを押して引き出し、外を押す・Esc・
    フォーカスが外へ、で引っ込める（戻り先は帯のタブ）。引き出し・引っ込めは `beforePanelChange` に聞かない。
    木⇔帯の移動は kind `auto-hide`。引き出しの開閉で `structureRevision` が進む（待っている承認は stale）。
  - 引き出しの中で開いたモーダル（`aria-modal`）と背景では引っ込めない。ドッキングの層と引き出しの層は
    `isolation: isolate` で分けるが、モーダルが開いている間は外す（OverlayPanel はその場に fixed で描くため）。
- split の slot と元の場所（#721・#727・#733〜#736・#741）:
  - 入れ子の `outer` の深さ上限は `MAX_SLOT_DEPTH`=8。5 段以上の slot を含むレイアウトだけ `version: 3` で保存する
    （`core/layoutVersion.ts`。`DockLayout['version']` は `2 | 3`）。回帰比較の fixture は `tests/fixtures/slot-main.ts`。
  - validate は、矛盾した slot だけ捨てて読む（浮動は dockSlot なし、帯は root）。
  - 外したパネルの元の場所は `DockState` の非公開 Map（公開は `homeSlot(id)`、README 未記載）。足すのは `undockPanel` だけ。
    消すのは、setter（浮動でなくなった id）・`hydrate`・`reset`・`forgetHomeSlots`。
  - slot の `share` は「外したパネルも数えた split 全体の割合」（`size` は旧来の意味、`version` 不変）。
    setter は保留中の slot を前後で比べ、元の入れ物に戻らず消えた分を除く。`adoptLayout`（内部）は正規化しない。
  - ライブの置き換え（`syncPanels`・`saved` なしの `replaceLayout`）は setter で入れる。保存値は
    `reconcileThreePaneLayout` が、消えた隠れパネルの分を 1 回だけ除き、`adoptLayout` で入れる（#742）。
    `reconcileThreePaneLayout` の結果を live の layout に使って setter で書き戻すと、二重に引く（README 記載）。
  - 公開 API: `DockState.restoredAt`・`DockState.savedLayout()`・`restoreDockSlot` の第 5 引数 `hidden`・
    `DockHost.replaceLayout` の `saved` オプション。保存値は `saved: true` で入れる（`forgetHomeSlots` → `adoptLayout`）。
    3 ペインの保存は `layoutSnapshot()`（`savedLayout()`）を `dockLayoutStore` に渡す。

### 5.5 環境の分岐

環境の分岐（`getBantoMode`・`isTauri`）は配線の層（`setup.ts`）だけに置き、UI は能力
（例 `connectionMonitoring()`）を見る（AGENTS.md・[conventions.md §10](conventions.md)）。

## 6. 教訓

### 6.1 設計・委譲

- **保存されない内部状態に依存する値を保存値に入れない**。homeSlot がその例で、保存・読み込み・丸ごと置き換え・
  ライブの置き換えの各経路で食い違いが出た（#739 で Codex の P2 が 8 件、うち 1 件は自分の修正が入れた回帰）。
  設計の段階で「保存値とライブ値の境目」と全経路を洗い出してから委譲する。直すときは、ライブの置き換えと
  保存値の適用を区別できているかを先に確かめる。
- **推定・復元のロジック**（dock の slot など）は、最初から、旧実装の複製と並べた全列挙の比較テストを書かせる
  （#725 で Codex の P2 が 5 件続き、これで収束した。`tests/fixtures/slot-main.ts`）。確証が無いときは旧実装の振る舞いに倒す。
- Codex は同じ型の指摘を続けて出すので、委譲時に最初から見直させる。
  - ピッカー: 「クリックとフォーカスの一致」「端の値」。
  - charts: 「描画領域の下限を保証し、超える分はラベル側を切る」。
  - 非同期の読み書き: 「操作が重なったとき」。
  - フォーカス: 「論理 focus と DOM focus の一致」「ホストが移した focus を奪わない」。
  - dock-svelte の lifecycle: 「承認と適用の間に構造が変わる」「押し出される側の pane（前面のタブ・包まれる隣）に聞いたか」（#665 で P1・P2 が続いた）。
- 文書に挙動を書くときは、呼び出し側の引数だけでなく、呼ばれる側の分岐（例 `freeId` が元の id を使うか生成するか）まで確かめる（#686）。
- 「消える要素にフォーカスがあるとき」の移し先を最初から決める（#667・#673・#687）。
- Svelte の `$effect` で複数の状態を見るときは、短絡評価で読まれない状態が追跡から漏れるので、先に変数へ読む（#687）。
- popover（top layer）のメニューを開いたまま確認ダイアログ（OverlayPanel）を出すと、メニューが上に残って Esc・フォーカスを奪う（#667）。
  確認が要る操作では、メニューを閉じる。
- `isolation`・z-index で層を分けるときは、その場に `position: fixed` で描くモーダル（`@banto/ui` の OverlayPanel）が
  閉じ込められないかを見る（#700 のクロスレビュー）。重なりの順は jsdom で計算できないので、同じ形の HTML を実ブラウザで開き
  `elementFromPoint` で確かめる（`file://` ではスクリプトを読めないので、スクラッチを `python -m http.server` などで配信する）。
- 余白でも「中身の形から決まる置き場」は、トークンの段に丸めると切れる。`StatusBadge` は `nowrap` なので、
  狭い幅で長い文言を出す場所では折り返しを許す。
- 状態色の文字用トークンは色域の中で 4.6:1 以上（色域テストが見る）。ブランド色の既定や数字用フォントなど、
  見た目の方針は [design/visual-refresh-design.md](design/visual-refresh-design.md) の「#557 の取り決め」。

### 6.2 e2e と visual

- visual の失敗を揺らぎと決める前の確かめ方は §2.3。
- e2e の書き方は §2.4。

### 6.3 環境

- Windows のテストのファイル名は、大文字小文字だけの違いで衝突する。
- Windows で CHANGELOG 等を書き換えるときは、改行を保って書く（CRLF が混ざると prettier が落ちる）。
- 作業中に起こした `vite preview`・`banto-serve` や待機コマンドが worktree を掴んで消せないことがある。止めてから消す。
- 新しい worktree には `node_modules` が無い（§4）。

### 6.4 まだ追っているもの

見送り・保留の項目は [#756](https://github.com/tyaro/banto/issues/756)、実機で未確認の項目は
[#757](https://github.com/tyaro/banto/issues/757) に集約している。
