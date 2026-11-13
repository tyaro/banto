# 日報（{{ date }}）

商品総数は **{{ totalCount | number }}件**、在庫合計は **{{ stockTotal | number }}個**、平均価格は **{{ avgPrice | yen }}** です。在庫僅少（在庫{{ lowStockThreshold }}個未満）の商品は **{{ lowStockCount | number }}件** あります。

## カテゴリ別集計

| カテゴリ | 件数 | 在庫合計 |
|---|---:|---:|
{{#each categories}}
| {{ category }} | {{ count | number }}件 | {{ stock | number }}個 |
{{/each}}

---

{{#if lowStock}}
## 在庫僅少一覧

| 商品名 | 在庫 |
|---|---:|
{{#each lowStock}}
| {{ name }} | {{ stock | number }}個 |
{{/each}}
{{/if}}
