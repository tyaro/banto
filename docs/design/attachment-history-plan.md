# 添付操作をレコード履歴に含める計画

状態: 実装済み（CI 検証待ち、2026-11-15）
最終検証日: 2026-11-15（SQLite / REST / フロント。PostgreSQL はコンパイル、Tauri は CI 待ち）

## 目的と範囲

親レコードの履歴タブに、そのレコードへ添付したファイルの追加・削除を時系列で表示する。
既存の添付監査行は `resource: "attachments"`、`entity_id: 添付 ID` のままにし、
監査 detail の `parentResource`・`parentId` を親レコードへの関連付けとして読む。
これらのキーは既に REST と Tauri の共通関数で記録されているため、既存の監査行も対象になる。
別の親レコードの添付操作は含めない。denied 行も監査 detail に親キーが揃う場合は
その親の履歴に出る。現行の添付 denied 行には親キーがない。

## 設計

- 監査一覧に履歴専用のフィルタ `recordResource`・`recordId` を追加する。通常の
  `resource`・`entityId` フィルタと画面表示は維持する。
- migration 0010 で `audit_log` に `record_resource`・`record_id` の生成列と複合
  インデックスを追加する。detail に文字列の `parentResource` と文字列・数値の
  `parentId` が揃えば親を記録先とし、なければ監査行自身の `resource`・`entity_id`
  を使う。不正な JSON は直接の対象として扱う。既存行も migration 時に算出し、
  新規・spool からの行も INSERT 時に算出する。PostgreSQL の安全な JSON 抽出は
  migration 内の immutable 関数にまとめる。
- フィルタの値は SQL にバインドする。記録先を絞る履歴・監査一覧のクエリは
  複合インデックスを使い、読み取りごとの detail 全件解析を避ける。
- 履歴のページング・並び順・件数は既存の `list_as_of` の単一読み取りトランザクション
  とスナップショット境界を使う。フロントで 2 つの一覧を結合しない。
- 履歴行では別リソースの操作と分かるよう、監査行の `resource` を操作名に添える。
  表示は汎用にし、コア UI から添付パッケージへ依存させない。
- 「監査ログで全部見る」のリンクも `recordResource`・`recordId` で絞る。
  監査一覧には記録先を示す非表示列を置き、適用中のフィルタ名と値を確認・解除できる。
  従来の `resource`・`entityId` URL フィルタは引き続き受け付ける。
- 添付 detail の追加キーを検索契約にするため、このキーを変える場合は履歴の
  クエリも同時に変更する。最上位の `parentResource`・`parentId` は全リソースで
  予約し、別の意味では組にして使わない（conventions §1）。ファイル名などの値は
  検索条件に使わない。

## 検証

- サービスのテストで同じ親の items 行と添付 create/delete 行が並び、別の親・
  添付自身の ID だけでは混入しないことを確認する。古い direct 行も残す。
- REST と Tauri の既存の監査書き込みテストで、添付の親情報と denied を確認する。
- `recordHistoryParams` と画面のテストで新フィルタと別リソース表示を確認する。
- SQLite・PostgreSQL の両方で migration・クエリを確認し、scaffold 4 プリセットを受け入れる。
