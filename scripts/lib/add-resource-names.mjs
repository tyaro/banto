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

// 列名・テーブル名にそのまま書けない SQL の予約語（SQLite・PostgreSQL のどちらかで予約）。
const SQL_RESERVED = new Set(
	(
		'all analyse analyze and any array as asc asymmetric both by case cast check collate column ' +
		'constraint create current_date current_time current_timestamp current_user default ' +
		'deferrable delete desc distinct do drop else end except exists false fetch for foreign from ' +
		'grant group having in index initially insert intersect into is join key leading limit like ' +
		'not null offset on only or order placing primary references returning select session_user ' +
		'set some symmetric table then to trailing transaction true union unique update user using ' +
		'values variadic when where window with'
	).split(' ')
);

// テンプレートが既に使っている名前（モジュール・URL・監査の resource）。
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

// 生成した Rust が import する型と同じ名前の行の型は作れない。
const RESERVED_TYPE_NAMES = new Set([
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

// 生成した Rust の関数が局所変数に使う名前（リソース名・単数形も局所変数になる）。
const RESERVED_LOCALS = new Set(
	(
		'actor body columns current dialect errors events headers id input lock missing not_found ' +
		'params pool previous query result router rows sql state today tx value values version'
	).split(' ')
);

/** 行の型が持つ固定の欄（フィールド定義には書けない名前）。 */
const BUILT_IN_FIELDS = new Set(['id', 'updatedAt', 'version']);

export const FIELD_TYPES = ['text', 'textarea', 'number', 'checkbox', 'date'];

const FIELD_KEYS = new Set(['name', 'type', 'required', 'min', 'max', 'label']);
const SPEC_KEYS = new Set(['singular', 'label', 'description', 'fields']);

/** フィールド定義を渡さないときの既定: 必須の `name`（80 文字まで）だけ。 */
export const DEFAULT_SPEC = {
	fields: [{ name: 'name', type: 'text', required: true, max: 80 }]
};

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

function localized(value, fallback, where) {
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
			`${where} は整数で書いてください（今の値: ${JSON.stringify(value)}）。`
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
	if (!FIELD_TYPES.includes(type))
		throw new AddResourceError(
			`${at}.type の ${JSON.stringify(type)} は生成できません。生成できる型: ${FIELD_TYPES.join(', ')}。` +
				'select・reference などは、生成した後のコードに手で足してください。'
		);
	if (raw.required !== undefined && typeof raw.required !== 'boolean')
		throw new AddResourceError(`${at}.required は true か false で書いてください。`);
	const required = raw.required === true;
	const min = checkBound(raw.min, `${at}.min`);
	const max = checkBound(raw.max, `${at}.max`);
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
	return {
		name,
		column,
		pascal: camelToPascal(name),
		type,
		isText,
		required,
		min,
		max,
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
	if (RESERVED_RESOURCE_NAMES.has(name))
		throw new AddResourceError(`リソース名 "${name}" はテンプレートが既に使っています。`);
	if (RUST_KEYWORDS.has(name) || SQL_RESERVED.has(name))
		throw new AddResourceError(
			`リソース名 "${name}" は Rust か SQL の予約語なので使えません（モジュール名とテーブル名になります）。`
		);
	if (RESERVED_LOCALS.has(name))
		throw new AddResourceError(
			`リソース名 "${name}" は生成するコードの変数名と重なります。別の名前にしてください。`
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
	const serviceType = `${snakeToPascal(name)}Service`;
	if (RESERVED_TYPE_NAMES.has(rowType))
		throw new AddResourceError(
			`行の型の名前 "${rowType}" は生成したコードが使う型と重なります。フィールド定義に "singular" を書いて別の名前にしてください。`
		);

	if (!Array.isArray(rawSpec.fields) || rawSpec.fields.length === 0)
		throw new AddResourceError('"fields" に欄を 1 つ以上書いてください。');
	const fields = rawSpec.fields.map(normalizeField);
	const seen = new Set();
	for (const field of fields) {
		if (seen.has(field.column)) throw new AddResourceError(`欄 "${field.name}" が重なっています。`);
		seen.add(field.column);
	}

	const label = localized(rawSpec.label, humanize(name), '"label"');
	const description =
		rawSpec.description === undefined ? null : localized(rawSpec.description, '', '"description"');

	return {
		name,
		kebab: name.replace(/_/g, '-'),
		camel: snakeToCamel(name),
		singular,
		rowType,
		inputType: `${rowType}Input`,
		serviceType,
		label,
		description,
		fields,
		/** 監査の detail の `name` と、テストで書き換える欄（最初の text / textarea）。 */
		titleField: fields.find((field) => field.isText) ?? null
	};
}
