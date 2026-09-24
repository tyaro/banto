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

## 未保存の変更の確認（issue #214）

保存型の画面では、`guardUnsavedChanges` をコンポーネントの初期化中に呼ぶと、
未保存のまま別の画面へ移ろうとしたときに確認を出す（再読み込み・タブを閉じる
ときはブラウザ標準の確認）。このパッケージは SvelteKit に依存しないため、
`beforeNavigate` は呼び出し側が渡す。

```svelte
<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import {
		BantoForm,
		UnsavedChangesNotice,
		createFormStore,
		guardUnsavedChanges
	} from '@banto/forms';

	const store = createFormStore(schema);
	let saving = $state(false);
	const guard = guardUnsavedChanges({
		isDirty: () => store.isDirty,
		isSaving: () => saving,
		beforeNavigate,
		message: () => '保存していない変更があります。変更を破棄して移動しますか？',
		isForced: (nav) => nav.to?.url.pathname === '/login'
	});

	async function handleSubmit(values: Record<string, unknown>) {
		saving = true;
		try {
			await save(values);
		} finally {
			saving = false; // 保存中のままだと、次の goto でも確認が出る
		}
		store.markClean(); // 移動の前に「保存済み」にする（確認を出さない）
		if (!guard.disposed) await goto('/list'); // 離脱済みなら引き戻さない
	}
</script>

<BantoForm {schema} {store} onSubmit={handleSubmit}>
	<UnsavedChangesNotice pending={guard.pending} label="未保存の変更があります" />
</BantoForm>
```

同じ画面に複数のガードがあっても確認は 1 回。`hasUnsavedChanges()` はどれか
1 つでも未保存なら `true` を返すリアクティブな関数で、ルーターを通らない終了
（Tauri のウィンドウを閉じる等）の判定に使う。

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
