# @banto/forms

Banto のスキーマ駆動フォーム。定義オブジェクト（`FormSchema`）から
入力 UI・バリデーション・状態管理を自動生成する（spec §7）。text/
textarea/number/date/select/checkbox/password の各フィールド
コンポーネントを同梱する。

## 使用例

```svelte
<script lang="ts">
	import { BantoForm, createFormStore, type FormSchema } from '@banto/forms';

	const schema: FormSchema = {
		fields: [{ name: 'name', label: '商品名', type: 'text', required: true }]
	};
	const store = createFormStore(schema);

	async function handleSubmit(values: Record<string, unknown>) {
		console.log(values);
	}
</script>

<BantoForm {schema} {store} onSubmit={handleSubmit} />
```

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（コアパッケージのためオプション側への依存も持たない、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/ui-framework-spec.md §7](../../docs/ui-framework-spec.md)（汎用フォーム仕様）
