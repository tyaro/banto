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

## 下線型表示を選ぶ（次リリース、ADR-0024）

`BantoForm` に `appearance="underline"` を渡すと、対応版の `@banto/theme/css` の共有スタイルを使う。
forms と theme は同じ対応版へ更新し、アプリで theme CSS を読み込む。
省略または `appearance="default"` は従来の枠型表示。背景は両表示・直接利用とも既定で透明（ADR-0025）。
新しい依存・パッケージ間 import はない。

```svelte
<BantoForm {schema} {store} onSubmit={handleSubmit} appearance="underline" />
```

下線型では、すべての項目名を入力の上に固定して全文の高さを確保する。
text / password / number / select / date / textarea が対象で、checkbox はネイティブの形を使う。
checkbox の寸法は `--banto-checkbox-size`（既定・fallback とも `1.1rem`）で列表示メニューと揃える。
Space 操作・readonly の disabled fallback・送信対象の扱いは維持する（ADR-0026）。
placeholder・日付のネイティブ UI・textarea の4行と縦リサイズを維持し、浮動ラベルにはしない。
`FieldDef` や送信データ、検証・エラー関連付け、readonly / disabled の扱いは変わらない。
下線型の操作欄は折り返し、送信ボタンと直下の `.banto-btn` は文字に応じて高さが伸びる。

8種類の field は任意の `class` をネイティブ要素へ渡せる。checkbox を除く field で直接共通スタイルを使うときは、
実際の `label.banto-field.banto-field--stacked` 内に field（`class="banto-field-control"`）、
`span.banto-field-label` の順で置く。エラーは label 外へ描画し、ID・ARIA は呼び出し側で関連付ける。
`DraftNumberField` も class を受け取るが、`BantoForm` の number は従来の `NumberField` を使う。

## ラベル・エラー・読み取り専用（Issue #495）

`BantoForm` はフォームごとに入力とエラーの DOM ID を生成し、ラベルの `for` と
入力の `aria-describedby` を対応させる。同じスキーマを複数表示しても ID が重複しない。
エラーが消えると参照も外れる。`FieldDef.name` と store のキー・送信データは変わらない。
DOM の参照は項目名の `#id` ではなく、ラベルやフォーム内の要素から行う。

各 field 部品を直接使う場合、既定の ID は従来どおり `def.name`。任意の `id` と
`aria-describedby` も渡せる。補足・エラー要素の描画とその ID の一意性は呼び出し側が管理する。

- text / password / textarea / number / date と `DraftNumberField` の `def.readonly` は、
  ネイティブの readonly 属性を使う。フォーカス可能で、テキスト入力では値を選択できる。
- `disabled` は別の状態で、送信中などの操作を無効にするときに使う。
- select / checkbox はネイティブ readonly がないため、`def.readonly` でも従来どおり disabled にする。
- readonly / disabled の field は入力・変更・blur の callback を呼ばない。
  `DraftNumberField` は raw の更新・blur / Enter での確定・`onCommit` も行わない。
  編集途中から切り替えた場合も draft の値・未完成文字列・エラーを保つ。
- readonly 値は従来どおり検証・送信対象。store / draft の API による更新は可能で、
  UI の readonly は認可やデータの書き込み禁止を保証するものではない。

各 field のフォーカス枠は、通常のテーマの影に加えて透明な outline を持つ。
forced-colors で影が無効になってもシステム色の outline が残る。

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

「同じページ」の判定は既定でパス・クエリが同じ移動（hash だけの違いを含む）。
URL のクエリに画面の状態を持つページ（`?target=&tab=` を `goto` で書き換える
3 ペインの型など）は、`isSamePage: isSamePath` を渡すと、パスが同じならクエリが
違っても確認を出さない（コンポーネントは作り直されず下書きが残るため）。戻る・
進むにも効く。再読み込み・タブを閉じるは判定に関わらずブラウザ標準の確認。
自前の判定は `(from: URL, to: URL) => boolean` で渡せる。

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
	// - dock / undock / move-docked / reparent / tab-switch / hide: coordinator.capture([panelId]) して進める（確認しない）
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
  成功したときだけ `markApplied(snapshot)`。送る値は `snapshot.submitValues`（`visibleWhen` で隠れた欄のキーを除く）。baseline になるのは**適用を始めた時点の
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

## 日付の入力と注入（date-time-pickers PR-3）

`type: 'date'` の値は `YYYY-MM-DD`（実在の日）か、空なら **`null`**（`''` ではない。
[docs/design/date-time-pickers.md](../../docs/design/date-time-pickers.md) D6）。

- **検証**: `validateField` は正規の形でない値を `dateInvalid` にする。`min` / `max` は正規の文字列で、両端を含む
  （`min: '2026-11-02'`）。`isDateDisabled(date)` が `true` の日は `dateDisabled`。順は必須 → 形式 → 範囲 →
  無効日 → `validate`。`min` / `max` は型ごとに読み、型に合わない側の値（date の数値など）は無視する。
- **ピッカーの注入**: forms は `@banto/ui` を import しない（docs/conventions.md §4）。アプリが部品を渡す。

  ```svelte
  <!-- +layout.svelte: 下のすべての BantoForm / DraftDateField に効く -->
  <script lang="ts">
  	import { provideFieldInputs } from '@banto/forms';
  	import FormDateInput from '#lib/components/FormDateInput.svelte'; // DateInput + messages + locale

  	provideFieldInputs({ date: FormDateInput });
  </script>
  ```

  フォームごとに替えるときは `<BantoForm fieldInputs={{ date: OtherInput }} … />`（型ごとに context より優先）。
  渡される props は `DateFieldInputProps`（`@banto/ui` の `DateInput` の props の一部）。注入が無ければネイティブの
  `<input type="date">` のまま。

- **FormStore の経路**（`BantoForm`）: 打った文字列はそのまま値に入り、blur・Enter で部品が正規の形に直す。
  解析できない文字列は値のまま残って形式のエラーになる（古い日付が黙って送信されない）。検証（`touch`）は
  フォーカスが部品全体（入力欄・ボタン・カレンダー）から出たときだけ走る。
- **FormDraft の経路**（`DraftDateField`）: 打った文字列は `draft.raw` に入り、`commit` が寛容な形（`2026/11/7`・
  全角・`11/7` は今年）を `YYYY-MM-DD` に直して検証する。カレンダーで選んだ日はすぐに確定する。
- `appearance="underline"` のフォームでも、注入した部品は自分の枠のまま（下線にならない）。ラベルは上に並ぶ。

## 時刻・日時の型（date-time-pickers PR-5）

`type: 'time'` の値は `HH:mm`（00:00〜23:59）、`type: 'datetime'` は `YYYY-MM-DDTHH:mm`（タイムゾーンを持たない
壁時計の時刻、[設計書](../../docs/design/date-time-pickers.md) D4）。空は date と同じく `null`。

- **検証**: 形式 → `min` / `max`（正規の文字列、両端を含む）→（datetime のみ）`isDateDisabled`（値の日で判定）→
  `step`（分。0:00 からの刻みに合うか。省略・正でない整数なら検査しない）。文言は `ValidationMessages` の任意の
  `timeInvalid` / `timeMin` / `timeMax` / `timeStep` / `dateTimeInvalid` / `dateTimeMin` / `dateTimeMax`
  （datetime の `min` / `max` は空白区切りで文言に渡す）。Rust の `banto_core::datetime` が同じ規則・同じ既定の文言。
- **ピッカーの注入**: `provideFieldInputs({ date, time, datetime })`。渡される props は `TimeFieldInputProps` /
  `DateTimeFieldInputProps`（`@banto/ui` の `TimeInput` / `DateTimeInput` の props の一部。`step` も渡る）。注入が無ければ
  ネイティブの `<input type="time">` / `<input type="datetime-local">`（`step` は秒に直して渡す）。
- **経路**: `BantoForm`（FormStore）も `DraftDateField`（FormDraft。`def.type` に合う部品を使う）も date と同じ流れ。
  `FormDraft.commit` は `930` → `09:30`、`2026/11/7 9:30` → `2026-11-07T09:30` に直す。秒付き・`24:00`・日付だけの
  datetime は形式のエラー。datetime の入力欄は空白区切り（`2026-11-07 09:30`）で見せる。

## 配置: セクション・列・表示条件・ヘルプ文（Issue #714）

すべて省略可能で、今の 1 列の定義はそのまま動く。`fields` は平らな配列のままで、
セクションは欄の `section`（セクションの `id`）で結ぶ。

```ts
const schema: FormSchema = {
	columns: 2, // 既定の列数（1〜3）。セクションの `columns` が優先
	sections: [
		{ id: 'basic', title: '基本情報', description: '必須の項目を先に置く。' },
		{ id: 'ship', title: '配送', columns: 1 }
	],
	fields: [
		{
			name: 'name',
			label: '名称',
			type: 'text',
			required: true,
			section: 'basic',
			help: '40 文字まで。'
		},
		{ name: 'memo', label: 'メモ', type: 'textarea', section: 'basic', fullWidth: true },
		{ name: 'gift', label: 'ギフト包装', type: 'checkbox', section: 'ship' },
		{
			name: 'wrap',
			label: '包装メッセージ',
			type: 'text',
			required: true,
			section: 'ship',
			visibleWhen: (values) => values.gift === true
		}
	]
};
```

- **見出し**: セクションは `fieldset` + `legend` で、`description` は `aria-describedby` で結ぶ。描画の順は「セクションを持たない欄 →
  `sections` の順」。`section` が知らない id の欄はセクション無し扱い。表示する欄が無いセクションは見出しごと消える。
- **列**: フォーム自身の幅に対する container query（ドロワーの中でも効く）。36rem 未満は 1 列、36rem 以上で 2 列、54rem 以上で
  3 列。`fullWidth: true` の欄は 1 行を使う。DOM の順がそのまま読み上げとタブの順なので、列の都合で欄を並べ替えない。
- **`visibleWhen(values)`**: false の間、欄は描画されず、検証（`required` を含む）にも送信の値にも入らない。
  `onSubmit` には `store.submitValues`（隠れた欄のキーだけを除いた値。欄に無いキーは残る）が渡る。
  入力した値は消さずに `store.values` に残るので、再び表示されれば戻る（`isDirty` は値全体で見るため、隠した後も変更ありのまま）。
  更新で隠れたキーが「送られなかった」ことをサーバーがどう扱うか（無視か、空にするか）は `DataProvider` 側で確かめる。
  draft も同じで、`draftSourceFrom` の `apply` に渡る値（`snapshotForApply().submitValues`）は隠れた欄のキーを除く。
  `values`・`raw`・baseline（dirty の比較）は全体のまま。
  フォーカスのある欄が隠れたときは、画面の表示順（セクションを含む）で直前の見える欄、無ければ後ろの欄へ移す。
  disabled などでフォーカスできない欄は飛ばし、どれも無ければ送信ボタンへ移す（`focusCandidateNames`）。
- **`help`**: 欄の下に出し、入力欄が `aria-describedby` で指す。エラーも出ているときは「ヘルプ → エラー」の順で両方を指す。

純関数（`isFieldVisible`・`submitValuesOf`・`layoutOf` など）は `layout.ts` にあり、Svelte なしで使える。

## 選択肢の型と単位つきの数値（Issue #714）

```ts
const options = [
	{ value: 'normal', label: '通常' },
	{ value: 'express', label: 'お急ぎ' }
];
const schema: FormSchema = {
	fields: [
		{ name: 'speed', label: '配送方法', type: 'radio', options, default: 'normal' },
		{ name: 'size', label: 'サイズ', type: 'radio', variant: 'segmented', options: sizes },
		{ name: 'extras', label: '同梱物', type: 'multiselect', options: extras, required: true },
		{ name: 'weight', label: '重量', type: 'number', suffix: 'kg' },
		{ name: 'price', label: '価格', type: 'number', prefix: '¥' }
	]
};
```

- **`radio`**: `options` から作る単一選択。値は select と同じ（未選択は `''`、`options` に無い値を弾かないのも同じ）。
  `fieldset`（`role="radiogroup"`）+ `legend`（欄の label）の中にネイティブの radio を並べるので、矢印キーの移動はブラウザに任せる。
  `required` は未選択をエラーにする。
- **`variant: 'segmented'`**: 同じ radio をボタンの並びとして描く（型は増やさない）。入力は不可視のまま各ボタンに重なり、
  フォーカス・矢印キー・読み上げの名前（「L、ラジオボタン」）はそのまま。選んだ区画は塗りに加えて太字とチェックの印でも示す。
- **`multiselect`**: checkbox の群（`fieldset` + `legend`）。値は `options` の順の配列で、空は `[]`。
  `required` は「1 つ以上」。combobox 型の複数選択は無い。
  選択肢の値は型つき（`===`）で比べるので `1` と `'1'` は別の選択肢。文字列だけを受ける経路（draft の raw など）では表記が同じ型違いを区別できず、`options` の最初に一致したものを使う。
- **単位 `prefix` / `suffix`（number のみ）**: 入力の前後に文字を出すだけで、値は数値のまま。桁区切りなどの書式は付けない。
  文字は `aria-hidden` にして label の名前に混ぜず、入力欄の `aria-describedby` に「単位 → ヘルプ → エラー」の順で足す。
  `DraftNumberField` でも同じ。
- **群の型と `BantoForm`**: 群の型は自分で `fieldset` + `legend` を描くので、`BantoForm` は label を足さない
  （`appearance="underline"` でも枠型の見た目）。欄の `id`（`visibleWhen` で隠れたときのフォーカスの退避先）は最初の入力に付き、
  `aria-describedby`（ヘルプ・エラー）と、radio の `aria-invalid` は fieldset に付く。単体の `RadioField` / `MultiselectField` も同じ props。
- **grid**: `columnsFromSchema` は radio を select と同じに（ラベル表示・select のセルエディタ）、multiselect を表示専用（ラベルを「、」でつなぐ）にする。
- **消費側の注意**: `FieldType` の union が広がるので、網羅 switch をしている利用側は型エラーになる。

## 参照選択（Issue #714）

ほかのリソースのレコードを、検索して選ぶ欄（combobox）。**値は id だけ**で、表示名は欄が持つ。
forms はデータの契約を持たず、候補と表示名は欄の定義に渡す 2 つの関数から得る。

```ts
import type { FormSchema, ReferenceOption } from '@banto/forms';

const schema: FormSchema = {
	fields: [
		{
			name: 'ownerId',
			label: '担当者',
			type: 'reference',
			required: true,
			// 打った文字の候補。query が '' のとき（↓ で開いたとき）は、最初の数件を返す。
			search: async (query, signal): Promise<ReferenceOption[]> => {
				const res = await fetch(`/api/users?search=${encodeURIComponent(query)}`, { signal });
				const users: { id: number; name: string; dept: string }[] = await res.json();
				return users.map((u) => ({ value: u.id, label: u.name, description: u.dept }));
			},
			// 保存された値（id）の表示名。レコードが無ければ null。
			resolve: async (value, signal) => {
				const res = await fetch(`/api/users/${value}`, { signal });
				if (res.status === 404) return null;
				const u = await res.json();
				return { value: u.id, label: u.name };
			}
		}
	]
};
```

テンプレート（admin-template）には、`DataProvider` からこの 2 つを作る補助 `referenceFrom` がある
（`src/lib/banto/reference.ts`。`search` は `getList` のクイック検索、`resolve` は `getOne`）。

```ts
import { getDataProvider } from '@banto/admin-core';
import { referenceFrom } from '#lib/banto/reference.js';

{ name: 'ownerId', label: '担当者', type: 'reference',
  ...referenceFrom(getDataProvider, 'users', { labelOf: (u: User) => u.name, descriptionOf: (u) => u.dept }) }
```

- **値**: `ReferenceOption.value`（`string | number`）がそのまま入る（`2` と `'2'` は別のもの）。未選択は `null`。
  `required` は「値があること」（`0` は値）。
- **値が変わるのは 2 つのときだけ**: 候補から選んだとき（Enter・クリック）と、入力を消して欄を出たとき（`null` になる）。
  打った文字だけでは値は変わらない。選ばずに欄を出ると、入力は今の値の表示名に戻る。
- **表示名**: 初期値や外から変わった値は `resolve` で引く。引けるまでと、引けないとき（`null`・失敗）は、値をそのまま出す。
  選んだ直後は候補の `label` を使い、`resolve` は呼ばない。
- **キー操作**（WAI-ARIA APG の combobox + listbox、リストの自動補完）: 打つと開く。↓（Alt+↓）で開く、↑↓ で候補を移る（端で止まる）、
  Enter で決める、Alt+↑ で閉じる。**Esc は開いた一覧を閉じ（打った文字は残る）、もう一度押すと入力を今の値の表示名に戻す**。
  Tab は決めずに出る。一覧が開いている間の Enter はフォームを送信しない。閉じているときの Enter は、入力を確定（消してあれば `null`）してから送信に進む。
  打っただけでは候補はアクティブにならない（↑↓ かポインタで移る）。
- **a11y**: 入力欄が `role="combobox"`（`aria-autocomplete="list"`・`aria-expanded`・`aria-controls`・`aria-activedescendant`）で、
  フォーカスは入力欄に残る。候補は `role="option"`（アクティブなものが `aria-selected="true"`）。一覧の中は何もフォーカスを取らないので、
  ポインタで押しても入力欄は blur せず、クリックで選べる。listbox は候補があるときだけ置く（`aria-expanded` もそのときだけ `true`）。
  検索中・0 件・失敗のときは、同じ枠に文だけを出す。
- **非同期**: 入力は `REFERENCE_SEARCH_DEBOUNCE_MS`（250ms）だけ待ってから検索する（単体の `ReferenceField` は `debounceMs` で変えられる）。
  新しい入力・閉じる・欄の破棄で、前の検索の `signal` を abort する。`search` が `signal` を見なくても、古い応答は捨てる（新しい応答を上書きしない）。
  IME の変換中は検索せず、確定したときに検索する。
- **状態の表示と読み上げ**: 検索中・0 件・失敗は一覧の中に出し、同じ文を `role="status"`（`aria-live="polite"`）で読み上げる。候補が届くと件数を読み上げる。
  文言は `BantoForm` の `referenceMessages`（単体では `messages`）で差し替える。型は `ReferenceFieldMessages`
  （`loading`・`noResults(query)`・`resultCount(count)`・`searchFailed(error)`・`listLabel(def)`）。`searchFailed` は reject の値を受け取るので、原因ごとに文を変えられる。
- **一覧の位置**: `popover="manual"` で最前面に出すので、ドロワーやスクロールする枠に切られない。入力欄と同じ幅で下に出し、下に入らず上のほうが広ければ上に出す。
  スクロールやリサイズでは入力欄に付いて動く。高さは `--banto-reference-list-max-height`（既定 `16em`）まで。
  開いている間は `data-esc-layer` を持ち、Esc を消費するので、外側のドロワーやモーダルは閉じない。
- **`appearance="underline"`**: 入力欄は下線の見た目になる。label は入力欄を包まず、隣に置く（日付の注入と同じ。一覧の文字が名前に混ざらないようにするため）。
- **draft**: `FormDraft` は参照の raw の文字を値として解釈しない（空白だけなら `null`、それ以外は値を変えない）。値は `setValue` で入れる。
  draft 用の欄のコンポーネントは無い。
- **grid**: `columnsFromSchema` は参照の型を表示専用にし、値（id）をそのまま出す（`resolve` は非同期なので、セルの `format` からは呼べない）。
  名前を出すときは、行やアプリがすでに持っている名前を `overrides[name].format` で渡す。
- **消費側の注意**: `FieldType` の union に `'reference'` が増えるので、網羅 switch をしている利用側は型エラーになる。

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
