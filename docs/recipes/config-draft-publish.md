# レシピ: 設定の下書き → 反映 → 元に戻す（Issue #938）

「装置のしきい値・ラインの設定」のように、**途中の状態を本番に見せず**、差分を見てから
一括で反映し、間違えたら前の版へ戻したい設定を持つアプリ向け。設計の根拠は
[design/config-draft-publish-design.md](../design/config-draft-publish-design.md)（保守者向け）。
ここは作る側の手順だけを書く。

テンプレートは**対象を 1 つも登録していない**（`GET /api/config` は `[]`、
`/api/config/{target}` は 404）。配線（migration・REST・Tauri のコマンド・権限の検査）は
済んでいるので、アプリは次の 4 つをする。

1. 対象を登録する
2. アプリの処理が本番の値を読む（読み口）
3. 画面を作る
4. 必要なら権限を差し替える

## 1. 対象の登録

`apps/admin-template/core/src/lib.rs` の `config_targets()` に足す（唯一の組み立て場所。
banto-serve と Tauri の両方がこの関数を通る）。

```rust
use serde_json::json;
use admin_template_core::config_drafts::{ConfigTarget, ConfigTargetRegistry};

pub fn config_targets() -> config_drafts::ConfigTargetRegistry {
    config_drafts::ConfigTargetRegistry::empty()
        .register(
            ConfigTarget::new(
                "plc.line1",                     // キー: 小文字・数字・_、. 区切り、64 バイトまで
                json!({ "limit": 1, "auth": { "token": "" } }), // 初期値: JSON のオブジェクト、256 KiB まで
                &["/auth/token"],                // 秘密のパス（JSON Pointer）。必須（無ければ &[]）
            )
            .expect("valid target")
            .with_validator(|value| { /* 純粋で速い関数だけ。I/O をしない */ Ok(()) }),
        )
        .expect("unique key")
}
```

- **初期値は最初の 1 回の種**。`open_config_drafts()` が起動時（migration の後）に
  `ensure_targets()` を呼び、行が無い対象に版 0 の本番を入れる。以後コードの初期値を
  変えても本番は変わらない（変更は必ず反映を通り、履歴に残る）。
- 秘密のパスの値は差分・監査に出ない。ただし**下書きと履歴は値を丸ごと保存する**ので、
  本物のパスワード・鍵は対象に入れない。
- 検証に失敗する下書きも**保存はできる**（書きかけを失わない。エラーは保存の応答に載る）が、
  反映はできない。
- 登録から外した対象の行は消えない（読めなくなるだけで、API は 404）。

## 2. アプリの読み口（本番だけを読む）

アプリの処理は `ConfigDraftsService`（`open_config_drafts()` が作る 1 つ）から**本番だけ**を読む。
下書きを返す関数とは名前で分かれている。

```rust
let published = service.published_as::<LineConfig>("plc.line1").await?;
// published.value / .version / .revision / .published_at は、同じ 1 行の 1 回の読み取り
```

- 値・版・revision は 1 回の読み取りから返る。revision を別に読まない（並行の反映で
  古い値と新しい revision が組み合わさる）。型に合わない値は `BantoError::Other`。
- **revision は値の識別子**であって、時刻でも大小のある番号でもない（反映のたびに作る乱数）。
  追いつく側は「いま採っている revision と違えば採る」だけを見る。
  **版の大小で比べない**: バックアップを復元すると版は戻るので、「いまより大きいときだけ
  採る」にすると、復元された本番をいつまでも採れない。
- 変更は `/api/events` の `resource_changed`（`resource` が `config:<対象>`）で来る。
  アプリの処理（プロセスの中）は同じ broadcast（`ServerEvent::ResourceChanged`）を受ける。
  **知らせは「すぐ読み直す合図」で、届くことを当てにしない**。追いつく処理は次の 4 つを全部持つ。
  1. 起動のときに読む
  2. 知らせで読む
  3. 受け手が遅れた（`Lagged`）・つなぎ直したら読む
  4. **周期でも revision を比べる**（知らせを全部落としても、周期 1 回ぶんの遅れで追いつく）
- 読み取りから適用までは**直列**に書く。読み取りを並べると、遅れて返った古い結果が新しい
  結果を上書きしうる。1 本の流れ（キューで 1 つずつ）にするか、始めた順の番号を付けて
  **最後に始めた読み取りの結果だけ**を採る。起動・つなぎ直し・遅れの後は、前の追跡の状態
  （持っていた revision・進行中の読み取り）を**捨ててから**読み直す。
- **DB が正常に応答した場合に追いつける**、という約束である。DB が応答しない間は読めず、
  応答が戻った最初の読み取り（周期）で追いつく。
- **反映の成功は、装置・処理への適用の成功ではない**。反映の応答・履歴・監査が言うのは
  「本番の JSON が変わった」まで。処理が実際に採った revision を見せたいアプリは、
  自分の状態として持って出す（banto にその欄は無い）。

```rust
// 骨子（周期は例。エラー処理は省く）
let mut rx = events.subscribe();
let mut current: Option<String> = None;            // 採っている revision
loop {
    let must_read = tokio::select! {
        ev = rx.recv() => match ev {
            Ok(ServerEvent::ResourceChanged { resource }) => resource == "config:plc.line1",
            Err(RecvError::Lagged(_)) => { current = None; true }   // 前の状態を捨てて読み直す
            Err(_) => break,
            _ => false,
        },
        _ = tick.tick() => true,                    // 周期の照合
    };
    if !must_read { continue; }
    let p = service.published_as::<LineConfig>("plc.line1").await?;
    if current.as_deref() != Some(&p.revision) {    // 版の大小ではなく revision の違い
        apply(p.value);
        current = Some(p.revision);
    }
}
```

## 3. 画面の作り方の要点

画面はアプリごとに作る（banto は読み口だけを足す）。`@banto/admin-core` の
`ConfigDraftsProvider`（`providers/configDrafts.ts`）を使う。

- ブラウザ・LAN は `createHttpConfigDrafts({ baseUrl, getToken })`、Tauri は
  `createTauriConfigDrafts({ invoke })`。どちらも口を 1 対 1 で呼ぶだけで、状態は持たない。
  デモの実装は無い。
- 画面の流れ: `get(target)` → `lockAcquire` → 編集して `draftPut` → `diff` を見る →
  `publish` → 間違えたら `historyList` から選んで `revert`。
- **クライアントが送る条件は revision だけ**（版の番号は送らない）。
  - `draftPut`・`draftDiscard` → `ifRevision`（下書きの revision。下書きが無ければ
    `CONFIG_DRAFT_ABSENT_REVISION` = `"0"`）。省略できない。
  - **最初の保存と `draftRebase` は `ifPublishedRevision` も**（画面が見た本番の revision）。
  - `publish` → `ifDraftRevision`（差分を確かめた下書きの revision）。
  - `revert` → `ifPublishedRevision`（画面が見ていた本番の revision）と `toVersion`。
- 衝突は `configDraftConflict(error)` で理由を取り出して出し分ける。

  | 理由                | 画面の動き                                                 |
  | ------------------- | ---------------------------------------------------------- |
  | `stale_base`        | 本番が進んでいる。`diff` を見せて `draftRebase` で取り直す |
  | `draft_changed`     | 誰かが保存した。`draft`（いまの下書き）で読み直す          |
  | `published_changed` | 本番が動いた。読み直す                                     |
  | `lock_held`         | 別の人が編集中。`lock.holderName` を出す                   |
  | `lock_required`     | ロックが切れた。取り直す（延長を再試行しない）             |

- **ロックの延長**: 期限（既定 5 分。`with_lock_ttl` で変えられる）の 1/3 ごとに
  `lockExtend(target, lease)`。画面を閉じるときは `lockRelease`。ほかの人のロックを
  外すのは `unlock(target, ifLease)`（下書きは残る）。
- **反映の知らせ**: `resource_changed` の `config:<対象>` を受けたら `get` で読み直す
  （自分の反映のときも同じ）。
- 差分の表示: 応答の `changes` は監査の差分と同じ形なので、
  `src/lib/resource/AuditChanges.svelte` に渡せる（パスがそのまま出る。見出しが欲しければ
  アプリで引き当てる）。admin-core に表示の部品は無い。
- 画面の文言・ルート・ナビはアプリが足す（テンプレートは画面を持たない）。

## 4. 権限の差し替え（`ConfigDraftsAccess`）

口は 4 つの役目（読む・編集・反映・解除）に分かれ、テンプレートの既定は**4 つとも admin**
（`rest::config_drafts_access()` が 1 つの値を返し、REST と Tauri が同じ値を使う）。
**「読む」は他の 3 つの必要条件**で、配線が自動で重ねる（読めない人に編集だけを許す組み合わせは作れない）。

「編集する人」と「反映する人」を分けるには、権限を登録して役目ごとに差し替える
（権限の登録は [add-permission.md](add-permission.md)）。

```rust
pub fn config_drafts_access() -> ConfigDraftsAccess {
    ConfigDraftsAccess {
        read: ConfigDraftsGate::Role(Role::Editor),
        edit: ConfigDraftsGate::Permission(perms::config_edit()),
        publish: ConfigDraftsGate::Permission(perms::config_publish()),
        unlock: ConfigDraftsGate::Role(Role::Admin),
    }
}
```

- **4 つとも書き出す**（`default()` や `..` の省略は、rule 8 が読めず落ちる）。
- Tauri 側は `src-tauri/src/lib.rs` の `require_config(state, ConfigDuty::X)` が同じ値を
  当てる。両経路のガードを別々に書く場所は無い。
- 権限のガードを使うなら `scripts/verify-architecture.mjs` の `PERMISSION_PAIRS` に対を足す。
  ロールの床は `DUAL_PATH`・`ROLE_READ` の config の行と一致させる（rule 8）。
- **[add-role.md](add-role.md) で足したロールを「読む」や役目に混ぜるときは、
  `scripts/lib/config-drafts-gates.mjs` の `ROLE_ORDER` にも足す**。順の分からないロール
  どうしを混ぜると、床を `A+B` と読んで宣言と一致せず、rule 8 が落ちる。
  add-role の手順で足したロールを設定の下書きのガードに使う場合の追加の 1 行である。
- v1 は**対象ごとには権限を分けない**（ルーター全体で 1 組）。

## 外すとき

使わないアプリは `pnpm scaffold --preset minimal|display` で自動で外れる
（`standard`・`full` は残す）。手動の手順は
[remove-optional-assets.md](remove-optional-assets.md)の「設定の下書き → 反映 → 元に戻す」の節。
