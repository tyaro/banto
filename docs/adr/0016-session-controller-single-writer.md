# ADR-0016: フロントのセッションの確定は 1 つの書き手（SessionController）に寄せ、provider は 1 往復で答え、資格情報の書き込みは compare-and-set にする

> English: [0016-session-controller-single-writer.en.md](0016-session-controller-single-writer.en.md)

- 状態: Proposed（設計の PR。判断点はオーナーの決定済み 2026-09-29。実装の PR で Accepted にする）
- 日付: 2026-09-29
- 関連: Issue #260・#255・#257・#259・#241・#204 / spec §3.3・§8.1 / conventions §10 /
  ADR-0014（アカウントに結び付けた失効）/ ADR-0012（合成 viewer セッション）/
  設計の本文: [docs/session-controller-design.md](../session-controller-design.md)

## コンテキスト

PR #255（#215：一覧の状態の保持）は、非同期の競合をめぐってレビューが 6 往復した。
5〜6 回目の指摘はすべて「古い認証の応答が、今のセッションを開始・終了・上書きする」
形で、直し方は毎回「開始時の scope を覚えて、答えが返った同じ継続で照合してから
反映する」だった。`019f6e9`（#255 マージ後）のコードで、その照合は 4 か所に散っている
（`sessionGate.ts`・`sessionLifecycle.ts`・`sessionEnded.ts`・アプリの `sessionStore`）。
派生アプリの banto-hub は同じ照合を `sessionRecheck.ts` で独自に作り直している。

根本の原因は 2 つ（設計の本文 §1 でコードの事実を示した）:

1. SvelteKit の `load` の中からモジュールのシングルトンを書き換えている。追い越された
   navigation の副作用は SvelteKit には止められない。
2. `AuthProvider` の答えが「どの資格情報についての答えか」を持たない。`check()` と
   `getIdentity()` は別々に往復し、`check()` には資格情報を消す副作用がある。

さらに、オーナーの指摘で、**Tauri の Rust 側**にも同じ形があることをコードで確かめた:
`auth_login`（646-647 行）・`auth_setup`（622-623 行）は `.await` の後に `state.auth` を
無条件で書き、`auth_logout`（690-691 行）は `.await` の後に無条件で消す。
「ログイン開始 → ログアウト完了 → 遅いログイン完了」で Rust 側のセッションが復活し、
逆の順序では確定したログインが消える。同じファイルの `auth_config_apply_body`・
`change_own_password`・`settle_session` はすでに照合してから書いている。

制約:

- REST と Tauri の両経路に効く（ADR-0001）。REST のサーバ側はトークンごとの map で
  共有の 1 スロットは無い。1 スロットに当たるのは、ブラウザのトークン保存先（#259）と
  Tauri の `state.auth` の 2 つ。
- 派生アプリ 2 本（banto-industrial の chronogazer・banto-hub）は `v1.7.3` に固定されて
  いて、移行は 1 回で済ませたい（A′ 案）。
- 依存を足さない（ADR-0002）。別パッケージも作らない。
- 「取得できない」を「終了」の証拠にしない（#204、ADR-0014 の帰結）。

## 決定

1. **単一の書き手**: フロントの確定したセッションの状態（`status`・`owner`・`generation`・
   `identity`・`kind`）を変えるのは、`SessionController` 内部の `commit()` だけにする。
   公開の入口は `resolve()`（確認の適用）・`adopt()`（アプリの方針による合成セッション）・
   `end()`（終了）・資格情報の変化による保留の 4 つ。**終了の状態へ移すのは controller だけ**で、
   資格情報の破棄とバックエンドの失効の処理は provider とバックエンドが担う。
2. **2 種類の `resolve()` を書き分ける**: `AuthProvider.resolve()` は 1 往復で
   `none` / `active + identity` を答え、取得できないときは **reject する**。v2 の標準契約で
   **型で必須**にする。HTTP は**既存の `GET /api/auth/identity` を 1 回**呼ぶ（`require_auth` と
   同じ再検証を通る。`200` で identity → active、`200 null` / `401` → none、それ以外 → reject。
   トークンを送って none なら compare-and-set でそのトークンを消す）。`GET /api/auth/session` は
   新設しない。旧 provider（`check()`/`getIdentity()`）への対応は明示的な互換 adapter に分離し、
   保証する範囲・しない範囲を明記して、旧実装を黙って完全対応扱いしない。
   `SessionController.resolve()` は **reject せず**、呼び出し元が「今回の要求について」
   `confirmed` / `unverified` / `superseded` を区別できる結果を返す。共有スナップショットの
   `lastError` で判断させない。`superseded` を受けた `load` は今の generation を返さず、期限内に
   最新の確認に合流して**実際に確認できた** generation だけを返す（確認できなければ再試行画面）。
3. **鮮度の照合を構造で守る**: provider の答えは、問い合わせを始めた時点の（controller の
   遷移回数、資格情報の revision）が適用時点と同じで、かつ始めた後に signal が来ていないときだけ
   `commit` できる。照合と `commit` は同じ継続で行う。確認は single-flight とし、待機の期限を設ける。
   破棄した確認を出し直さないのは、画面からの待機要求も未処理の背景の確認の必要も無いときだけ
   （待機者の数だけで判断しない）。
4. **資格情報の書き込み・消去は compare-and-set**: HTTP provider のトークン保存（#259）も、
   Tauri の Rust 側 `state.auth`（seq 付きの `AuthSlot`）も、操作を始めたときの revision / seq と
   一致するときだけ書く。認証の操作（login / logout / setup / enterPublicViewer）は controller の
   待ち行列に入れず、操作の戻り値を直接 `commit` せず、その後の `resolve()` で確定する。
5. **資格情報の切り替えは保留に移す**: 切り替えを知った時点で `unknown`・owner なし・
   generation + 1 にし、その後の確認に失敗しても旧 owner の active には戻さない。
   同じ資格情報での一時的な失敗（確定状態を保つ）とは区別する。別タブでの切り替え（#257）の
   既定は「旧画面の操作を止める → 確認する → 別ユーザーへの変更が確認できたら通知して新しい権限で
   作り直す（未保存の入力は引き継がない）→ 確認できなければ再試行の状態に留める」で、この処理で
   共有のトークンを消さず、他のタブをログアウトさせない。再認証が要るアプリは「通知してログインへ
   移す」方針を注入できる。
6. **SvelteKit との境界**: `load` の副作用は `controller.resolve()` だけ。`{#key generation}` と
   公開閲覧への fallback・試運転の `adopt()` はアプリ層の方針として注入する。`adopt()` は派生アプリ
   固有の合成セッション（試運転）に限り、公開閲覧の fallback と Tauri のログイン不要モードは
   provider の `resolve()` が答える（Rust の `auth_identity` はそのたびにモードと権限を読み直す）。
   core の `sessionGate.ts` から `enterPublicViewer` の呼び出しを外す。
7. **版**: #255 とこの変更をまとめて **v2.0.0** にする（publishing.md：意味の変更はメジャー）。
   状態を更新する旧 API（`establishSession` / `beginSession` / `endSession` /
   `resolveProtectedSession` / `confirmSessionEnded` / `SessionChangedError` など）は**削除**する。
   参照・購読の API（`sessionGeneration` / `onSessionEnded` など）は残すが、独自の状態や確認処理は
   持たせず controller への委譲に統一する（設計の本文 §5.4）。
8. **監査**: `login_superseded` の記録は今回の必須要件から外す。今の `login` の監査は REST・Tauri
   とも「資格情報の検証に成功した」時点で記録している（設計の本文 §1.7）。Rust が世代の不一致で
   確定を拒否したことの観測は、必要になったら別のイベントとして後で足す。

不変条件の一覧（I-1〜I-15）、競合のシナリオの表（S-1〜S-45）、API の案、移行と実装の分割、
テストの設計は設計の本文に置く。実装の PR はその番号をテスト名から参照する。

## 検討した代替案

- **案A（採用）: SessionController に確定を寄せ、provider に 1 往復の `resolve()` と
  compare-and-set を足す。** 利点: 照合が 1 か所になり、`load` から副作用が消え、派生アプリが
  認証処理を組み立てなくてよい。Rust 側も同じ形（すでにある `settle_session` の形）に揃う。
  欠点: 公開 API の意味が変わりメジャーになる。派生アプリの移行が 1 回要る。
- **案B（不採用）: 今の 4 か所にそれぞれ照合を足し続ける（#255 の延長）。** 6 往復の実績が
  示すとおり、照合の抜けは構造では防げない（別の継続に分かれる・呼び忘れる）。派生アプリも
  同じ照合を自前で持ち続ける。
- **案C（不採用）: `AuthProvider` を `Proxy` で包んで login / logout を検知し、そこで状態を
  書く。** #255 の 2〜3 回目で試して退けた（クラス実装の receiver・凍結オブジェクトで壊れる。
  別タブの変化は見えない）。
- **案D（不採用）: 認証の操作もすべて controller の待ち行列に入れて直列化する。** 遅い
  ログインが詰まると再試行もログアウトもできず、安全性と再試行のしやすさを損なう。
  必要なのは順序の保証ではなく「古い答えを適用しないこと」なので、compare-and-set で足りる。
- **案E（不採用）: `localStorage` の原子的な更新に Web Locks API を使う。** タブ間の
  compare-and-set は原理的に必要だが、保証したいのは「旧 owner を active として使い続けない」
  ことで、それは storage イベントからの保留で足りる。対応ブラウザの確認も要り、この設計では
  採らない（保証する範囲・しない範囲を設計の本文 §4.6 に明記）。
- **案F（不採用）: Rust 側は `Mutex` を `.await` をまたいで保持して直列化する。** Tauri の
  コマンドは並行に走り、ロックを await にまたがせると `current_session` の再検証（DB 読み）
  まで直列になる。PR #182 で採った「1 つのロックの中で照合して書く」形（compare-and-set）で
  十分で、既存の 3 か所と揃う。
- **案G（不採用）: REST に `GET /api/auth/session`（check + identity を 1 応答に）を新設する。**
  既存の `GET /api/auth/identity` が `authenticated_session` → `AuthState::authenticate` で
  `require_auth` と同じ再検証を通し、失効を `200 null` で返すので、1 往復の要件をすでに満たす。
  既存ルートで満たせない具体的な要件が出たときに新設を判断する。
- **案H（不採用）: Tauri のログイン不要モードの合成 identity をアプリ側で `adopt()` する。**
  Rust が合成し、`auth_identity` がそのたびにモードと権限を読み直している。フロントで合成すると
  権限の変更を追えず、書き手が増える。
- **案I（不採用）: `superseded` を受けた `load` に今の generation を返す。** 確認していない結果が
  世代ゲートを通り、旧ユーザーのページデータが新しい世代に載る。最新の確認に合流して確認できた
  generation だけを返す（期限付き）。

## 帰結

- 実装の PR は 3 本（provider とバックエンド / controller / admin-template の配線と v2.0.0）に
  分け、候補版で派生アプリ 2 本を検証してから、正式版への参照の更新まで 1 本の移行 PR で行う。
- 派生アプリは「チェック → identity → 世代 → 状態」を組み立てず、`controller.snapshot` を
  丸ごと読む。役割の解釈（role）は identity から導く。
- 新しい確認の経路を足すときは、必ず `controller.signal()` の入口に格下げする。controller の外で
  `check()` / `getIdentity()` を呼んで状態を書くコードを増やさない（レビューの観点にする）。
- Rust 側で `state.auth` を書くときは `cas_session` を通す。新しいコマンドを足すときも同じ。
- 保証しないことを文書に残す: タブ間の同時操作でどちらが勝つか、切り替えのイベントが届くまでの
  ミリ秒の間に送られる要求。
- 互換のために「障害を `null` に潰す」挙動を、新しい共通処理の標準として残さない。
- 互換 adapter を使う派生アプリは、保証しない範囲（1 往復でない・`check()` の副作用・別タブの
  検知なし）を承知のうえで使い、移行 PR にその旨を書く。自前の provider は v2 で型エラーになる。
- 別タブの切り替えの処理は、どのアプリでも共有のトークンを消さない。ログアウトは利用者の操作か
  バックエンドの失効だけで起こる。
