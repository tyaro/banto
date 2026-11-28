# 下流の追従メモ（版ごと）

> 本書は日本語のみ（[upgrading.md](upgrading.md) と同じく英訳なし）。

## 対象読者と位置づけ

- **読者**: banto-industrial・temp-scada など、banto の派生アプリの保守者。
- **位置づけ**: 版ごとの正は [CHANGELOG.md](../CHANGELOG.md) の「消費側への注意」と
  [upgrading.md](upgrading.md)。本書には、**特定の下流に固有の注意・確かめ方・置き換えられる
  自前実装**を版ごとに残す（CHANGELOG に書くほど一般的でないもの、または宛先がはっきりしているもの）。
- **更新の決まり**: リリースのたびに、その版の節を足す（新しい版が上）。下流へ伝え終えたかどうかの
  状態は書かない。

## v10.0.0

CHANGELOG [10.0.0] の移行の手順・消費側への注意 13 項目と、upgrading の例 17 を正とする。以下は下流向けの補足。

- **#1027 の `app.html` の「読み込み中」**と、それを消すルート layout・`hooks.server.ts` も下流に取り込む
  （CHANGELOG に案内あり）。
- **capability**: `banto-tauri-panel:allow-list`・`banto-tauri-panel:allow-close` を足す。
- **dock**: `DockLayoutStore` を自前で実装・モックしていれば `commit` の戻り値を Promise にする。
  `createPanelPopOut` に `storage` を渡し、`connect()` は dock のレイアウトを読み終えてから呼ぶ。
  #1060: dock に `overlayInset`。
- **#1029（二重起動の防止）**: デスクトップ版は同じ版の二重起動を防ぎ、データフォルダの DB を排他にする。
  コピーしたテンプレートは `instance_guard.rs` を写し、`run()` の最初に plugin を登録する。旧版とは排他が
  効かないので、旧版を全部止めてから上げる。
- **#1059 → banto-industrial の Hub**: Modal・Drawer・CommandPalette が開いている間、外側は `inert` になり、
  トーストのボタン（「取り消し」など）も押せない。Hub の `/tags` の削除は 6 秒の猶予の取り消しをトーストにだけ
  出すので、猶予中にパレットを開いたままにすると取り消せない。版を上げるときに、試験用のタグで次の 3 つを
  確かめる: パレットを開かない／期限内に閉じる／期限を越えて開いたままにする。そして猶予中の取り消しを保証する
  形（猶予中はモーダルを開かせない／タイマーを止める／最前面から取り消せる）にする
  （tyaro の指摘 #1059 issuecomment-7232451014）。
- **#1057**: 知らせの要素の中に操作部を置かない。ConnectionBanner・StartupSplash・`+error`・ErrorState などを
  写した下流は写し直す。

## v9.3.0

- **→ banto-industrial#1281**: `banto-tauri-panel`（git 依存 `tag = "v9.3.0"`）と `createPanelPopOut` で配線する
  （レシピ `docs/recipes/panel-windows.md`、upgrading 例 16）。パネル id は ASCII 英数字と `-`・`_` の 64 文字まで。

## v9.2.0

- CHANGELOG [9.2.0] の「消費側への注意」: `isUsersAdminAvailable` → `isUsersAdminWritable`、
  `users.unavailable*`・`audit.unavailable*` キーの削除、空の一覧のボタン名、`computeDropRegion` の非推奨。

## v9.1.1

- **→ temp-scada**（#986）: 日本語の題名・標準／touch 密度で、dock の各タブの選択と ⋯・✕ を確かめる。
  dock のタブを写す visual の基準画像は変わりうる。

## v9.1.0

- **banto-industrial**: 自前の `ListenerWrites`・`RunningHub::shutdown_and_report` と 5 秒の受け入れを、
  `WriteLedger`（`stop_all_until`）と `stop_within` に置き換えられる（#980・#981）。
  `LedgerOutcome::running == 0` は、枠だけを共有する未登録の listener を別に止めていなければ、
  DB を閉じる根拠にならない。
- **#944**: パスワード欄の隣に表示・非表示のボタンが並ぶので、`getByLabel('パスワード')` は
  `{ exact: true }` にする。下線の検査はラッパーに対して行う（CHANGELOG [9.1.0] の移行の手順 2）。

## v9.0.0

- PR #972 本文の「下流への影響」8 点。
- **#939 → temp-scada**: `ThreePaneDock` の `defaultPlaces` で `pinDesignerDefaultPlaces` を置き換えられる。
- **#947 → banto-industrial**（PR #950、`BoundServer::from_listener`）: 通常の証明書更新は listener を作り直さず
  acceptor を差し替える。作り直すのは失効と本当の再作成だけ（PR #950 本文の移る手順）。
  v9.1.0 の #980・#981 で 5 秒の受け入れと `ListenerWrites` を置き換えられる（v9.1.0 の節）。

## v8.x 以前・版によらないもの

- v8 の分は CHANGELOG [8.0.0] の「消費側への注意」と upgrading、
  [docs/reviews/downstream-usability-d1-2026-11.md](reviews/downstream-usability-d1-2026-11.md) §6。
- **#925（v8.0.0）**: 自前の `Cargo.lock` を持つ下流は `libsqlite3-sys` が自動では上がらない
  （CHANGELOG [8.0.0] に案内あり）。
- **banto-industrial#1333（キオスク表示の窓の部品）は banto に入れない**（2026-11-26 オーナー判断、コメント済み）。
