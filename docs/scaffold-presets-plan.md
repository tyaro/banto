# スキャフォールド・プリセット設計（P4-9、設計のみ）

作成日: 2026-07-19（improvement-plan-2026-07.md P4-9。**本書は設計のみ。
実装は P2-1 v2＝対話式スキャフォールドの土台ができてから別途**）
トラック: 保守者向け（トラックA）

## 0. 位置づけと本書のスコープ

P4-9 は「minimal / standard / full の3プリセットを生成できるようにする」
という ChatGPT レビュー由来のバックログ（improvement-plan §2）。P2-1
（`scripts/rename.mjs`、名称・識別子の一括書き換え）の発展形であり、
**コピー直後にオプション資産の採否をまとめて適用**する仕組みを指す。

本書は**設計の確定**までを行い、実装はしない。理由: (1) 規模 L、(2) 対話式
スキャフォールド（P2-1 v2）の CLI 土台に乗せるのが自然で、その土台自体が
未着手。設計を先に固めておけば、実装時に迷わず着手できる。

## 1. 前提の是正 — プリセットが動かせるのは「オプション資産」だけ

ChatGPT レビューの当初案は Banto の実構造と食い違うため、まず是正する。

- 当初案: `minimal = CRUD+forms+grid` / `standard = +auth+audit+backup` /
  `industrial = +scan+attachments+reports+LAN`。
- **問題**: auth+RBAC（M10）・監査ログ（M14）・設定基盤（M12）・
  CSV I/O（M15）・バックアップ（M17）は template-scope §2.2 で**コア
  （削除想定なし・常在）**と判定済み。「standard で auth を足す / minimal で
  auth が無い」は成立しない（auth は常にある）。LAN サーバ（`banto-server`）も
  コアで、既定は**設定でオプトイン無効**なだけ（コードは常在）。

したがってプリセットが実際に切り替えられるのは:

1. **§3 のオプション資産**（独立パッケージ + 削除可能デモ。README
   「オプション資産の削除」に手順あり）:
   `@banto/dock-svelte` / `@banto/charts` / Glass テーマ+vibrancy /
   コマンドパレット（M16）/ `@banto/attachments` / `@banto/report` /
   `@banto/scan-wedge`（現状レシピのみ・未配線）。
2. **設定の既定値**（コード削除ではなく初期設定）: LAN サーバの有効/無効、
   認証無効モード/自動ログイン（M11、既定 OFF）。

**コア（auth/RBAC/audit/settings/CSV/backup/shell）はどのプリセットでも
削除しない。** これは template-scope の分類をそのまま尊重する。

## 2. 命名の是正 — "industrial" は使わない

roadmap §5 / industrial-plan.md は、SCADA 系ドメイン機能（MQTT/タグストア/
定時実行/アラーム）を**別リポジトリ `banto-industrial`** に置くと決めている。
プリセット名に "industrial" を使うと、この別リポジトリのドメイン機能と
混同する。本設計では **`minimal` / `standard` / `full`** を採用する
（当初案の "industrial" は本設計の `full` に対応。真の産業ドメイン機能は
引き続き別リポジトリ）。

## 3. プリセット定義（提案。実装時に確定）

各プリセットが**残す**オプション資産（✓＝残す / ✗＝削除）。コアは全て常在。

| オプション資産（§3） | minimal | standard | full |
| --- | :---: | :---: | :---: |
| `@banto/charts` + ダッシュボードのチャートデモ | ✗ | ✓ | ✓ |
| `@banto/dock-svelte`（ダッシュボードのドッキング） | ✗ | ✓ | ✓ |
| コマンドパレット（Ctrl+K、M16） | ✗ | ✓ | ✓ |
| Glass テーマ + Windows vibrancy（M12） | ✗ | ✓ | ✓ |
| `@banto/attachments` + items 添付デモ（M20） | ✗ | ✗ | ✓ |
| `@banto/report` + 日報デモ（M19） | ✗ | ✗ | ✓ |
| `@banto/scan-wedge` レシピ配線（M21） | ✗ | ✗ | ✓※ |

設定の既定値（全プリセット共通の安全既定。プリセットでは変えない）:

- LAN サーバ: **既定 OFF**（攻撃面ゼロ。有効化は利用者が設定画面から）。
- 認証: **常に有効**。認証無効モード/自動ログイン（M11）はプリセットの
  既定にしない（セキュリティを弱めるため、利用者が明示オプトインする）。

補足:
- **`minimal`**: コアのみ。ダッシュボードは dock/charts を外し、固定レイアウトの
  スタットタイル羅列に置き換える（README「オプション資産の削除」の dock/charts
  手順どおり）。最も軽い「認証付き CRUD 管理画面」。
- **`standard`**: 「ダッシュボード体験」を持つ既定。dock+charts+コマンド
  パレット+Glass を残し、ドメイン寄りの extras（添付・帳票・スキャナ）は外す。
- **`full`**: 全オプション資産を配線。※ scan-wedge は現状テンプレート未配線
  （レシピのみ）なので、`full` で「配線する」なら README レシピの (b)
  `use:wedgeInput` を items 検索欄等に組み込む雛形を足す必要がある。実装時に
  「full でも scan-wedge は配線せずレシピ参照に留める」選択も可（要決定・§7）。

現テンプレートの出荷状態は dock+charts+コマンドパレット+Glass+attachments+
report が配線済み・scan-wedge 未配線なので、**`standard` と `full` の中間**。
実装時、テンプレート本体をどのプリセット状態で出荷するか（＝スキャフォールドが
「足す」方向を持つか「引く」方向だけか）を決める（§7）。

## 4. 仕組みの設計 — 「削除手順の自動実行」であって新機構ではない

**プリセット適用 = README「オプション資産の削除」に明文化済みの削除手順を、
選ばれなかった資産についてプログラムから実行するだけ。** runtime プラグイン
機構は作らない（template-scope §3.1 の決定を維持）。スキャフォールドは
**install-time（コピー直後の1回）**のツールであり、実行時の拡張点は
`initBanto({ resources })` のまま。

- CLI: P2-1 の `scripts/rename.mjs` のファイル編集エンジン（現在値を読んで
  置換・再実行安全・`--dry-run`）を再利用し、`--preset minimal|standard|full`
  を受ける **`scripts/scaffold.mjs`**（または rename.mjs の拡張）として実装。
  依存を足さない（Node 標準のみ、conventions §3 / ADR-0002）。
- 非対話を先に実装（スクリプタブル・テスト可能）、対話ラッパ
  （`pnpm create banto-app` 相当）は後段。
- 各資産の削除は**単一の「remover」関数**に閉じ、README の手順と1対1対応
  させる（`removeCharts()` / `removeDock()` / `removeGlass()` /
  `removeCommandPalette()` / `removeAttachments()` / `removeReport()`）。
  プリセットは「どの remover を呼ぶか」の集合にすぎない。
- **削除順序**: README §3 が「依存の少ない順」を明示している資産
  （attachments は5ステップ順）に従う。remover 間の順序依存
  （例: dashboard を触る charts/dock）も README の記述に合わせる。

## 5. 不変条件（実装が守るべきこと）

- **どのプリセットでもビルド・テストが緑。** これは §3 が各オプション資産に
  課した「削除しても他が壊れない」義務（template-scope §6 チェックリスト
  ②③）の帰結であり、プリセットはその義務に**ただ乗り**する。逆に言えば、
  新しいオプション資産を追加する PR は「削除手順の明文化」を怠ってはならず、
  怠るとプリセット機構が壊れる（§3 の義務がプリセットの前提）。
- **remover は冪等・`--dry-run` 対応**（rename.mjs と同じ規律）。パターンが
  見つからなければ黙って壊れず明示的に失敗する。
- **コアには触れない。** remover はオプション資産のファイル・配線・依存のみを
  対象にし、auth/audit/settings/backup/CSV/shell のコードには一切手を入れない。
- 依存追加なし（Node 標準のみ）。

## 6. 検証戦略（実装時）

- 各プリセットについて、クリーンコピー（`git archive`）→ `scaffold --preset X`
  → `pnpm install` / `pnpm check` / `pnpm build` / `cargo check` が緑、を
  CI か手動 e2e で確認（P2-1 の rename.mjs 検証と同じ手法）。
- `verify:architecture` は適用後も通ること（オプション削除で逆依存等が
  壊れないことの再確認）。
- 3プリセット × ビルド緑、を「プリセットの受け入れ条件」とする。

## 7. 実装時に決める未決事項

1. **テンプレート出荷状態と scaffold の方向**: 本体を `full` で出荷し
   scaffold は「引く」だけにするか、`standard` で出荷し `full` は「足す」も
   持つか。引くだけ（＝ full 出荷）が README §3 の削除手順とそのまま対応し
   実装が単純。
2. **scan-wedge を `full` で配線するか**: 配線する（items 検索欄に
   `use:wedgeInput` の雛形）か、レシピ参照に留めるか。
3. **対話 UI の範囲**: プリセット選択だけにするか、資産を個別トグルできる
   「カスタム」も出すか（remover が個別関数なので後者も低コスト）。
4. **リソース差し替え（items→自リソース）との関係**: プリセットは
   オプション資産の採否、リソース差し替えは P1-3 レシピ。両者は直交。
   scaffold で「デモ items を残す/最小化する」オプションを足すかは別途。
5. **`create-banto-app` 化**: 別リポジトリの npm パッケージにするか、
   本リポジトリ同梱スクリプトのままか（publishing.md の非公開方針との関係）。

## 8. まとめ

- プリセットは**§3 オプション資産の削除手順の自動実行**であり、コアや
  runtime 機構には手を入れない。命名は `minimal`/`standard`/`full`
  （"industrial" は別リポジトリと混同するため使わない）。
- 実装は P2-1 v2 の CLI 土台に乗せ、rename.mjs のエンジンと remover 関数群で
  構成する。依存追加なし。各プリセットのビルド緑を受け入れ条件にする。
- 本書は設計まで。実装着手時に §7 の未決事項を決めてから進める。
