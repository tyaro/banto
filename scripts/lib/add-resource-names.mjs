/**
 * `pnpm banto add resource` の名前の検証と、フィールド定義（JSON）の正規化。
 * ファイルは読み書きしない純関数だけを置く（テストは scripts/add-resource.test.mjs）。
 */

/** 生成を止める理由。CLI はこのメッセージだけを出して終わる（スタックは出さない）。 */
export class AddResourceError extends Error {
	constructor(message) {
		super(message);
		this.name = 'AddResourceError';
	}
}

const RUST_KEYWORDS = new Set(
	(
		'as break const continue crate else enum extern false fn for if impl in let loop match mod ' +
		'move mut pub ref return self static struct super trait true type unsafe use where while ' +
		'async await dyn abstract become box do final macro override priv typeof unsized virtual ' +
		'yield try gen'
	).split(' ')
);

// 列名・テーブル名にそのまま書けない SQL の予約語。SQLite の全キーワード
// （https://www.sqlite.org/lang_keywords.html）と PostgreSQL の予約語（付録 C の reserved と
// reserved (can be function or type)）の和集合。生成物は引用符で囲まず書くので、どちらの DB でも通る名前に絞る。
const SQL_RESERVED = new Set(
	(
		'abort action add after all alter always analyse analyze and any array as asc asymmetric ' +
		'attach authorization autoincrement before begin between binary both by cascade case ' +
		'cast check collate collation column commit concurrently conflict constraint create ' +
		'cross current current_catalog current_date current_role current_schema current_time ' +
		'current_timestamp current_user database default deferrable deferred delete desc detach ' +
		'distinct do drop each else end escape except exclude exclusive exists explain fail ' +
		'false fetch filter first following for foreign freeze from full generated glob grant ' +
		'group groups having if ignore ilike immediate in index indexed initially inner insert ' +
		'instead intersect into is isnull join key last lateral leading left like limit ' +
		'localtime localtimestamp match materialized natural no not nothing notnull null nulls ' +
		'of offset on only or order others outer over overlaps partition placing plan pragma ' +
		'preceding primary query raise range recursive references regexp reindex release rename ' +
		'replace restrict returning right rollback row rows savepoint select session_user set ' +
		'similar some symmetric system_user table tablesample temp temporary then ties to ' +
		'trailing transaction trigger true unbounded union unique update user using vacuum ' +
		'values variadic verbose view virtual when where window with without'
	).split(' ')
);

// テンプレートが既に使っている名前（モジュール・URL・監査の resource）。
// 引用符で囲んでも列名にできない、DB が内部で使う列名（PostgreSQL のシステム列と SQLite の行 id の別名）。
// 予約語とは別の集合（引用では避けられない）。
const DB_SYSTEM_COLUMNS = new Set([
	'tableoid',
	'xmin',
	'cmin',
	'xmax',
	'cmax',
	'ctid',
	'oid',
	'rowid',
	'_rowid_'
]);

const RESERVED_RESOURCE_NAMES = new Set([
	'assets',
	'attachment_wiring',
	'attachments',
	'audit',
	'audit_log',
	'auth',
	'backup',
	'backups',
	'db',
	'events',
	'first_boot',
	'items',
	'login_notice',
	'permissions',
	'reach_check',
	'resources',
	'rest',
	'settings',
	'system',
	'system_info',
	'system_metrics',
	'tests',
	'ui_settings',
	'users'
]);

// 生成した Rust が import する型・その場で定義する型（`WriteState`・`DeleteQuery`）・prelude の
// 型とトレイト。行の型・入力の型・サービスの型がこれと同じ名前だと、二重定義になるか、
// prelude のトレイトを隠して `.clone()` などが解決できなくなる。
const RESERVED_TYPE_NAMES = new Set([
	...(
		'ApiError AsMut AsRef AuditLogService AuthState Body Clone Copy Debug Default DeleteQuery ' +
		'Deserialize DoubleEndedIterator Drop Eq ExactSizeIterator Extend Fn FnMut FnOnce From ' +
		'FromIterator Future Identity Into IntoFuture IntoIterator Iterator Ord PartialEq ' +
		'PartialOrd Request RoleGuard Send Serialize ServiceExt SessionValidation Sized Sync ' +
		'ToOwned ToString TryFrom TryInto Unpin Value WriteState'
	).split(' '),
	'AppResources',
	'AppState',
	'BantoError',
	'Box',
	'ColumnMap',
	'Db',
	'Err',
	'FieldError',
	'HeaderMap',
	'Json',
	'ListParams',
	'ListResult',
	'None',
	'Ok',
	'Option',
	'Path',
	'Query',
	'QueryBuilder',
	'Result',
	'Role',
	'Router',
	'Self',
	'ServerEvent',
	'Some',
	'Sqlite',
	'State',
	'StatusCode',
	'String',
	'Vec'
]);

// 生成した Rust の関数が局所変数に使う名前と、その関数が呼ぶ関数の名前（リソース名・単数形も
// 局所変数になるので、`get`・`record_write` などを隠すと呼び出しが解決できなくなる）。
const RESERVED_LOCALS = new Set(
	(
		'actor after before body columns current dialect errors events get headers id input lock ' +
		'middleware missing not_found params pool post previous query record_ok record_write ' +
		'require_auth require_role require_role_at_least result router rows sql state today tx ' +
		'value values version'
	).split(' ')
);

// 生成した Rust がパスの先頭に書くクレートの名前（同じ名前のモジュールを作ると、クレートの
// ルートでそのパスがモジュールを指すようになる）。
const RESERVED_CRATES = new Set(
	(
		'admin_template_core alloc axum banto_admin_services banto_attachments banto_core ' +
		'banto_server banto_storage chrono core serde serde_json sqlx std tauri tokio tower'
	).split(' ')
);

// 生成したサービスのモジュールが固定の名前で持つ定数（欄から導く定数と重ねない）。
const FIXED_CONSTANTS = [
	'RESOURCE',
	'SELECT_ROWS',
	'SELECT_COUNT',
	'RETURNING',
	'VERSION_BUMP',
	'CONFLICT_MESSAGE',
	'MIN_SAFE_INTEGER',
	'MAX_SAFE_INTEGER'
];

// 生成したサービスのモジュールが固定の名前で持つ関数（単数形から導く関数と重ねない）。
const FIXED_FUNCTIONS = [
	'required_message',
	'min_message',
	'max_message',
	'max_length_message',
	'date_message',
	'optional_integer',
	'validate_input',
	'column_map',
	'check_version',
	'local_today'
];

// 生成した TypeScript の定義が import・定義する名前（`<camel>Schema`・`<camel>Resource` と重ねない）。
const FRONTEND_NAMES = ['Table2', 'm', 'defineResource', 'integerValidate'];

/**
 * PostgreSQL の識別子の上限（NAMEDATALEN - 1）。これより長い名前は黙って切り詰められ、
 * 先頭 63 バイトが同じ 2 つの列がぶつかる。SQLite に上限は無いが、両方言で同じ名前にする。
 */
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * number の欄が取れる範囲（±(2^53−1)）。フォームは値を JavaScript の number で持つので、
 * この外の整数は丸められてから届く。Rust の検証とフォームの min/max の両方をこの範囲にする。
 */
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;

/** 行の型が持つ固定の欄（フィールド定義には書けない名前）。 */
const BUILT_IN_FIELDS = new Set(['id', 'updatedAt', 'version']);

export const FIELD_TYPES = ['text', 'textarea', 'number', 'checkbox', 'date'];

const FIELD_KEYS = new Set(['name', 'type', 'required', 'min', 'max', 'label', 'audit', 'title']);
const SPEC_KEYS = new Set(['singular', 'label', 'description', 'fields']);

/**
 * フィールド定義を渡さないときの既定: 必須の `name`（80 文字まで）だけ。生成器が自分で決めた
 * 表示名の欄なので、監査に残し（`audit`）、監査の `detail.name` にも入れる（`title`）。
 * フィールド定義を渡したときは、どちらも書いた欄にしか付かない。
 */
export const DEFAULT_SPEC = {
	fields: [{ name: 'name', type: 'text', required: true, max: 80, audit: true, title: true }]
};

const byteLength = (text) => Buffer.byteLength(text, 'utf8');

/** 同じ名前が 2 回出たら、どれとどれが重なったかを添えて断る。 */
function assertDistinct(entries, what, hint) {
	const seen = new Map();
	for (const [identifier, origin] of entries) {
		if (seen.has(identifier))
			throw new AddResourceError(
				`${what} "${identifier}" が重なります（${seen.get(identifier)} と ${origin}）。${hint}`
			);
		seen.set(identifier, origin);
	}
}

export function snakeToPascal(snake) {
	return snake
		.split('_')
		.filter(Boolean)
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join('');
}

export function snakeToCamel(snake) {
	const pascal = snakeToPascal(snake);
	return pascal[0].toLowerCase() + pascal.slice(1);
}

export function camelToSnake(camel) {
	return camel.replace(/[A-Z]/g, (upper) => `_${upper.toLowerCase()}`);
}

function camelToPascal(camel) {
	return camel[0].toUpperCase() + camel.slice(1);
}

/** `orders` -> `order`、`categories` -> `category`。複数形でなければそのまま。 */
export function singularOf(name) {
	if (/ies$/.test(name) && name.length > 3) return `${name.slice(0, -3)}y`;
	if (/(ch|sh|ss|x|z)es$/.test(name)) return name.slice(0, -2);
	if (/s$/.test(name) && !/ss$/.test(name) && name.length > 1) return name.slice(0, -1);
	return name;
}

/** `purchase_orders` -> `Purchase Orders`（ラベルを書かなかったときの既定）。 */
function humanize(snake) {
	return snake
		.split('_')
		.filter(Boolean)
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join(' ');
}

/**
 * messages/*.json（inlang message format）に書き出す文字列の検査。`{` `}` は変数として解釈されるが、
 * 生成する呼び出し（`m['...']()`）は引数なしなので、入っていたら断る。書き出す文字列
 * （リソースの表示名・説明・各欄のラベル）は全部 localized() を通るので、ここだけで足りる。
 */
function assertMessageText(text, where) {
	if (/[{}]/.test(text))
		throw new AddResourceError(
			`${where} に波括弧 { } は使えません（メッセージでは変数の記号で、生成する呼び出しは引数を渡しません）。`
		);
	return text;
}

function localized(value, fallback, where) {
	const result = localizedRaw(value, fallback, where);
	assertMessageText(result.ja, `${where}（ja）`);
	assertMessageText(result.en, `${where}（en）`);
	return result;
}

function localizedRaw(value, fallback, where) {
	if (value === undefined) return { ja: fallback, en: fallback };
	if (typeof value === 'string' && value.trim() !== '') return { ja: value, en: value };
	if (
		value &&
		typeof value === 'object' &&
		typeof value.ja === 'string' &&
		typeof value.en === 'string' &&
		value.ja.trim() !== '' &&
		value.en.trim() !== ''
	)
		return { ja: value.ja, en: value.en };
	throw new AddResourceError(
		`${where} は空でない文字列か { "ja": "...", "en": "..." } で書いてください。`
	);
}

function checkBound(value, where) {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value))
		throw new AddResourceError(
			`${where} は ${MIN_SAFE_INTEGER}〜${MAX_SAFE_INTEGER} の整数で書いてください（今の値: ${JSON.stringify(value)}）。`
		);
	return value;
}

function normalizeField(raw, index) {
	const at = `fields[${index}]`;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		throw new AddResourceError(`${at} はオブジェクトで書いてください。`);
	for (const key of Object.keys(raw))
		if (!FIELD_KEYS.has(key))
			throw new AddResourceError(
				`${at} の "${key}" は使えません。使えるキー: ${[...FIELD_KEYS].join(', ')}。`
			);
	const { name, type } = raw;
	if (typeof name !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(name))
		throw new AddResourceError(
			`${at}.name は camelCase の英数字で書いてください（例: customerName。今の値: ${JSON.stringify(name)}）。`
		);
	if (BUILT_IN_FIELDS.has(name))
		throw new AddResourceError(
			`${at}.name の "${name}" は生成器が必ず付ける欄です（id・updatedAt・version）。定義から外してください。`
		);
	const column = camelToSnake(name);
	if (snakeToCamel(column) !== name)
		throw new AddResourceError(
			`${at}.name の "${name}" は列名（${column}）から元に戻せません。大文字の連続や数字の直後の大文字を避けてください。`
		);
	if (RUST_KEYWORDS.has(column) || SQL_RESERVED.has(column))
		throw new AddResourceError(
			`${at}.name の "${name}" は Rust か SQL の予約語なので列名にできません。別の名前にしてください。`
		);
	if (DB_SYSTEM_COLUMNS.has(column))
		throw new AddResourceError(
			`${at}.name の "${name}" は DB が内部で使う列名（${column}）なので列名にできません。別の名前にしてください。`
		);
	if (byteLength(column) > MAX_IDENTIFIER_BYTES)
		throw new AddResourceError(
			`${at}.name の "${name}" は列名（${column}）が ${byteLength(column)} バイトになり、PostgreSQL の識別子の上限（${MAX_IDENTIFIER_BYTES} バイト）を超えます。短い名前にしてください。`
		);
	if (!FIELD_TYPES.includes(type))
		throw new AddResourceError(
			`${at}.type の ${JSON.stringify(type)} は生成できません。生成できる型: ${FIELD_TYPES.join(', ')}。` +
				'select・reference などは、生成した後のコードに手で足してください。'
		);
	if (raw.required !== undefined && typeof raw.required !== 'boolean')
		throw new AddResourceError(`${at}.required は true か false で書いてください。`);
	const required = raw.required === true;
	for (const key of ['audit', 'title'])
		if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
			throw new AddResourceError(`${at}.${key} は true か false で書いてください。`);
	if (raw.title === true && type !== 'text')
		throw new AddResourceError(`${at}.title は text の欄にだけ付けられます。`);
	let min = checkBound(raw.min, `${at}.min`);
	let max = checkBound(raw.max, `${at}.max`);
	const isText = type === 'text' || type === 'textarea';
	if (type !== 'number' && min !== undefined)
		throw new AddResourceError(`${at}.min は number の欄にだけ書けます。`);
	if (type !== 'number' && !isText && max !== undefined)
		throw new AddResourceError(`${at}.max は number・text・textarea の欄にだけ書けます。`);
	if (isText && max !== undefined && max < 1)
		throw new AddResourceError(`${at}.max（文字数の上限）は 1 以上にしてください。`);
	if (min !== undefined && max !== undefined && min > max)
		throw new AddResourceError(`${at} の min が max より大きくなっています。`);
	if (type === 'checkbox' && required)
		throw new AddResourceError(`${at}: checkbox に required は付けられません。`);
	// number は、書かなくても安全な整数の範囲に収める（フォームと Rust の両方に同じ値が入る）。
	if (type === 'number') {
		min ??= MIN_SAFE_INTEGER;
		max ??= MAX_SAFE_INTEGER;
	}
	const upper = column.toUpperCase();
	return {
		name,
		column,
		pascal: camelToPascal(name),
		type,
		isText,
		required,
		min,
		max,
		/** 監査の detail に値を残すか（既定は残さない。conventions §6）。 */
		audit: raw.audit === true,
		/** 監査の `detail.name` に入れる欄か。 */
		title: raw.title === true,
		/** 生成する Rust の定数の名前（検証の上限・下限。書かなかった number の範囲は共通の定数）。 */
		constants: {
			...(isText && max !== undefined ? { maxLength: `MAX_${upper}_LEN` } : {}),
			...(type === 'number' && raw.min !== undefined ? { min: `MIN_${upper}` } : {}),
			...(type === 'number' && raw.max !== undefined ? { max: `MAX_${upper}` } : {})
		},
		label: localized(raw.label, humanize(column), `${at}.label`)
	};
}

/**
 * リソース名とフィールド定義を検証し、テンプレートが使う名前一式を返す。
 * 問題があれば AddResourceError（何も書く前に呼ぶ）。
 */
export function normalizeSpec(name, rawSpec = DEFAULT_SPEC) {
	if (typeof name !== 'string' || !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name))
		throw new AddResourceError(
			`リソース名は snake_case の英小文字・数字で書いてください（例: orders、purchase_orders。今の値: ${JSON.stringify(name)}）。`
		);
	if (name.startsWith('sqlite_'))
		throw new AddResourceError(
			`リソース名 "${name}" は "sqlite_" で始まるので使えません（SQLite が内部用に予約していて、テーブルとインデックスの名前に使うと migration が拒まれます）。`
		);
	if (RESERVED_RESOURCE_NAMES.has(name))
		throw new AddResourceError(`リソース名 "${name}" はテンプレートが既に使っています。`);
	if (RESERVED_CRATES.has(name))
		throw new AddResourceError(
			`リソース名 "${name}" は生成するコードが使うクレートの名前と重なります。別の名前にしてください。`
		);
	if (RUST_KEYWORDS.has(name) || SQL_RESERVED.has(name))
		throw new AddResourceError(
			`リソース名 "${name}" は Rust か SQL の予約語なので使えません（モジュール名とテーブル名になります）。`
		);
	if (RESERVED_LOCALS.has(name))
		throw new AddResourceError(
			`リソース名 "${name}" は生成するコードの変数名と重なります。別の名前にしてください。`
		);
	if (byteLength(name) > MAX_IDENTIFIER_BYTES)
		throw new AddResourceError(
			`リソース名 "${name}" は ${byteLength(name)} バイトで、PostgreSQL の識別子の上限（${MAX_IDENTIFIER_BYTES} バイト）を超えます（テーブル名になります）。短い名前にしてください。`
		);
	if (!rawSpec || typeof rawSpec !== 'object' || Array.isArray(rawSpec))
		throw new AddResourceError('フィールド定義は JSON のオブジェクトで書いてください。');
	for (const key of Object.keys(rawSpec))
		if (!SPEC_KEYS.has(key))
			throw new AddResourceError(
				`フィールド定義の "${key}" は使えません。使えるキー: ${[...SPEC_KEYS].join(', ')}。`
			);

	const singular = rawSpec.singular ?? singularOf(name);
	if (typeof singular !== 'string' || !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(singular))
		throw new AddResourceError('"singular" は snake_case の英小文字・数字で書いてください。');
	if (RUST_KEYWORDS.has(singular))
		throw new AddResourceError(
			`単数形 "${singular}" は Rust の予約語です。フィールド定義に "singular" を書いて別の名前にしてください。`
		);
	if (RESERVED_LOCALS.has(singular))
		throw new AddResourceError(
			`単数形 "${singular}" は生成するコードの変数名と重なります。フィールド定義に "singular" を書いて別の名前にしてください。`
		);
	const rowType = snakeToPascal(singular);
	const inputType = `${rowType}Input`;
	const serviceType = `${snakeToPascal(name)}Service`;
	const types = [
		[rowType, '行の型'],
		[inputType, '入力の型'],
		[serviceType, 'サービスの型']
	];
	for (const [type, role] of types)
		if (RESERVED_TYPE_NAMES.has(type))
			throw new AddResourceError(
				`${role}の名前 "${type}" は生成したコードが使う型と重なります。` +
					(type === serviceType
						? 'リソース名を変えてください。'
						: 'フィールド定義に "singular" を書いて別の名前にしてください。')
			);
	// 例: `products` に singular: "products_service" だと、行の型もサービスの型も ProductsService。
	assertDistinct(
		types,
		'生成する Rust の型の名前',
		'フィールド定義の "singular" を別の名前にしてください。'
	);
	assertDistinct(
		[
			...FIXED_FUNCTIONS.map((fn) => [fn, '生成するコードの関数']),
			...['audit_fields', 'create_detail', 'update_detail', 'delete_detail'].map((suffix) => [
				`${singular}_${suffix}`,
				'単数形から導く関数'
			])
		],
		'生成する Rust の関数の名前',
		'フィールド定義の "singular" を別の名前にしてください。'
	);
	const camel = snakeToCamel(name);
	assertDistinct(
		[
			...FRONTEND_NAMES.map((imported) => [imported, '生成するコードが使う名前']),
			[`${camel}Schema`, 'フォームの定義'],
			[`${camel}Resource`, 'リソースの定義']
		],
		'生成する TypeScript の名前',
		'リソース名を変えてください。'
	);

	if (!Array.isArray(rawSpec.fields) || rawSpec.fields.length === 0)
		throw new AddResourceError('"fields" に欄を 1 つ以上書いてください。');
	const fields = rawSpec.fields.map(normalizeField);
	const seen = new Set();
	for (const field of fields) {
		if (seen.has(field.column)) throw new AddResourceError(`欄 "${field.name}" が重なっています。`);
		seen.add(field.column);
	}
	// 例: text の `code`（max つき）と number の `codeLen`（max つき）は、どちらも MAX_CODE_LEN を作る。
	assertDistinct(
		[
			...FIXED_CONSTANTS.map((constant) => [constant, '生成するコードの定数']),
			...fields.flatMap((field) =>
				Object.values(field.constants).map((constant) => [constant, `欄 "${field.name}"`])
			)
		],
		'生成する Rust の定数の名前',
		'欄の名前を変えてください。'
	);
	const titles = fields.filter((field) => field.title);
	if (titles.length > 1)
		throw new AddResourceError(
			`"title" を付けられる欄は 1 つだけです（今は ${titles.map((field) => field.name).join('・')}）。`
		);

	const label = localized(rawSpec.label, humanize(name), '"label"');
	const description =
		rawSpec.description === undefined ? null : localized(rawSpec.description, '', '"description"');

	return {
		name,
		kebab: name.replace(/_/g, '-'),
		camel,
		singular,
		rowType,
		inputType,
		serviceType,
		label,
		description,
		fields,
		/** 監査の `detail.name` に入れる欄（`title: true` を付けた text。無ければ name を入れない）。 */
		titleField: titles[0] ?? null,
		/** 生成したテストが更新で書き換える欄（最初の text / textarea）。監査とは関係しない。 */
		editField: fields.find((field) => field.isText) ?? null
	};
}
