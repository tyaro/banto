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
		// 別の画面を選んだあと（遷移先の読み込み中も含む）は、自動で一覧へ戻らない
		if (guard.canAutoNavigate) await goto('/list');
	}
</script>

<BantoForm {schema} {store} onSubmit={handleSubmit}>
	<UnsavedChangesNotice pending={guard.pending} label="未保存の変更があります" />
</BantoForm>
```

同じ画面に複数のガードがあっても確認は 1 回。`hasUnsavedChanges()` はどれか
1 つでも未保存なら `true` を返すリアクティブな関数で、ルーターを通らない終了
（Tauri のウィンドウを閉じる等）の判定に使う。

## pane より長生きする draft と複数フォームの適用（issue #432）

ドックの pane は dock / undock で中身が作り直される。未適用の入力を残すには、
pane の外（ページや controller）で `createFormDraft` を作り、pane は mount のたびに
借りる。`DraftCoordinator` は複数のフォームの適用 / 破棄 / キャンセルを 1 回の確認で
まとめ、登録は `guardUnsavedChanges` の登録簿にもつながる（ルーターの離脱・
`hasUnsavedChanges()` が同じ draft を見る。確認は 1 つの navigation に 1 回のまま）。
設計は [shared-primitives-upstream-plan §3.5](../../docs/design/shared-primitives-upstream-plan.md)。

```svelte
<!-- ページ（pane より長生きする側） -->
<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import {
		createDraftCoordinator,
		createFormDraft,
		draftSourceFrom,
		guardUnsavedChanges
	} from '@banto/forms';

	const coordinator = createDraftCoordinator({ message: () => m.unsaved_drafts() });
	const memo = createFormDraft({ key: 'memo', schema, initial: loaded });
	// FormDraft の登録は draft の寿命（ページ）に合わせる。pane の effect で登録すると、
	// keepMounted なしの hide / tab-switch で pane が消えた dirty な draft が pending でも
	// settle の対象でもなくなり、離脱時に未適用の入力を失う
	$effect(() => coordinator.register(draftSourceFrom(memo, (values) => save(values))));
	// ルーターの離脱でも確認するなら、画面のどこかで guard を mount しておく
	guardUnsavedChanges({
		isDirty: () => coordinator.pending,
		isSaving: () => coordinator.settling,
		beforeNavigate,
		message: () => m.unsaved_drafts()
	});

	// dock の lifecycle（@banto/dock-svelte 側）とのつなぎ方は遷移ごとに分ける:
	// - dock / undock / move-docked / tab-switch / hide: coordinator.capture([panelId]) して進める（確認しない）
	// - close: settle の結果が 'clean' / 'applied' / 'discarded' のときだけ閉じる
	async function canClose(panelId: string): Promise<boolean> {
		const result = await coordinator.settle([panelId], (dirtyKeys) =>
			askApplyDiscardCancel(dirtyKeys)
		);
		return result === 'clean' || result === 'applied' || result === 'discarded';
	}
</script>
```

```svelte
<!-- pane（mount のたびに作り直される側）: 欄を描くだけ。source の登録・解除はしない -->
<script lang="ts">
	import { DraftNumberField } from '@banto/forms';

	let { draft } = $props();
</script>

<DraftNumberField def={qtyField} {draft} />
```

- **適用**: `draftSourceFrom` の `apply` は、全欄を確定 → `snapshotForApply()` → 送信 →
  成功したときだけ `markApplied(snapshot)`。baseline になるのは**適用を始めた時点の
  snapshot** で、適用の待機中に打った入力は dirty のまま残る。自前で書くときも同じ順で。
- **`settle` の結果**: `'applied'` / `'discarded'` は「解決した時点で対象がすべて clean」。
  待機中に入力があれば `'dirty-again'`、適用の失敗は `'failed'`、待機中に対象が
  入れ替わった（再登録・登録解除・同じ key の別の settle・dispose）ら `'stale'`。
  中身を捨ててよいのは `'clean'` / `'applied'` / `'discarded'` のときだけ。
- **登録の寿命**: `FormDraft` の source は**ページ（draft の寿命）で**登録し、pane の mount /
  unmount では消さない。非表示のままページを離れても pending で、`settle([key])` の対象になる。
- **自作フォーム**: pane と一緒に生きて消える状態を持つ `DraftSource`（`isDirty` / `apply` /
  `discard` と `capture` / `restore`）は pane の effect で `register` し、BantoForm にしなくてよい。`capture([key])` で
  取ったものは、同じ key の次の `register` で `restore` に渡る（rebind）。
- **数値欄**: `DraftNumberField` は `type="text"` + `inputmode="decimal"` で、`1e` のような
  未完成の文字列も draft に残す（確定は blur / Enter）。スピンボタンは無い。
  既存の `NumberField`（`type="number"`）は変わらない。
- 文言（`message`・検証の `messages.notANumber`）は解決済みの文字列で渡す。

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
