<script lang="ts">
	/**
	 * `@banto/ui` catalog page (Issue #220, ADR-0018 §6): the main states of
	 * the shared components on one screen, for review and as the visual
	 * regression target of the package (e2e/visual DIAGONAL_PAGES). Deliberately
	 * light - not a catalog framework.
	 *
	 * The sidebar / command-palette entry exists only in the demo build
	 * (`demoOnly` in navigation.ts); the route itself is reachable by URL in
	 * every build. All page chrome is Paraglide (`raw-jp-in-app`). Samples are
	 * static and deterministic (the only state is a click counter), so the
	 * screenshot never depends on timing; the skeleton pulse is stopped by
	 * `prefers-reduced-motion` (the visual project forces it).
	 *
	 * The Menu card (phase 2a), the DateInput card (date-time-pickers PR-1),
	 * the TimeInput card (PR-2), the BantoGrid date cell card (PR-4), the
	 * DateTimeInput card (PR-5), the DateRangeInput card and the grid's datetime
	 * column (PR-6), the DatePicker / DateRangePicker card (#910),
	 * the CommandPalette card (phase 2b), the
	 * Toast card (phase 2c), the Modal / Drawer card (phase 4) and the
	 * ConfirmDialog card (#556), the Tooltip card (#556) and the HeaderNav card's
	 * dropdowns (nav-menubar-plan PR-2) are closed /
	 * empty on load, so the screenshot shows only their triggers; opening,
	 * keyboard and focus behaviour are covered by the package's jsdom tests
	 * (and the open Modal / Drawer by the axe scan in e2e/visual/a11y.spec.ts),
	 * not by the visual suite. The Toast card pushes
	 * into the app's own store (shown by the root layout's ToastHost).
	 *
	 * Not in the API on purpose (ADR-0018 §2): `IconButton` has no `disabled`
	 * prop in phase 1, so no disabled sample.
	 */
	import {
		BantoForm,
		createFormStore,
		uploadPendingFiles,
		type FileFieldClient,
		type FileFieldMeta,
		type FormSchema,
		type ReferenceOption
	} from '@banto/forms';
	import {
		CommandPalette,
		DateInput,
		DatePicker,
		DateRangeInput,
		DateRangePicker,
		DateTimeInput,
		dayOfWeek,
		Drawer,
		EmptyState,
		ErrorState,
		HeaderNav,
		IconButton,
		LoadingState,
		Menu,
		MenuGroup,
		MenuItem,
		MenuSeparator,
		Modal,
		PageHeader,
		SegmentedControl,
		StatusBadge,
		SurfaceCard,
		Tabs,
		ThreePaneLayout,
		TimeInput,
		Tooltip,
		type CommandPaletteItem,
		type HeaderNavEntry,
		type SegmentedOption,
		type StatusBadgeVariant,
		type TabItem,
		type UiMessages
	} from '@banto/ui';
	import {
		ChartColumn,
		ChevronDown,
		ClipboardList,
		Copy,
		Factory,
		FilePlus,
		Gauge,
		House,
		Package,
		Pencil,
		Plus,
		RefreshCw,
		Save,
		SearchX,
		ServerCrash,
		Star,
		Trash2,
		Users,
		X
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { toastStore } from '#lib/toast.svelte.js';
	import { confirmAction } from '#lib/confirm.svelte.js';
	import { BantoGrid, columnsFromSchema, type CellEdit, type GridColumn } from '@banto/grid-svelte';
	import {
		columnValidationMessages,
		dateInputMessages,
		dateRangeInputMessages,
		dateRangePickerMessages,
		dateTimeInputMessages,
		fileFieldMessages,
		passwordInputMessages,
		formValidationMessages,
		gridMessages,
		referenceFieldMessages
	} from '#lib/banto/i18n.js';
	// [scaffold:touch-keys] begin
	import { PasswordInput } from '@banto/forms';
	// TouchKeysHost card (#937 T7, touch-keypad-design §4.2 b): the optional
	// `@banto/touch-keys-svelte`. The host normally sits once in the root layout
	// (docs/recipes/touch-keys.md); here it lives in the card and `resolve` limits it
	// to the card's own fields, so the other samples on this page keep their plain
	// inputs. The switch stands for the per-device setting behind `enabled`. The
	// keys are closed on load, so the screenshot shows only the fields.
	//
	// Grid wiring (#964 W1, grid-touch-edit-design §4.1 ⑤ / §5.1): the host is the
	// one place that knows both packages. `resolve` gives every grid cell editor
	// (the grid's public mark `data-grid-editor`) `openOnFocus`, so the tap that
	// starts the edit also opens the keys; `onconfirm` blurs that editor, which is
	// the grid's own commit-without-moving path. Neither package imports the other.
	// `pnpm scaffold` removes the two `[scaffold:touch-keys]` regions of this file.
	import {
		TouchKeysHost,
		touchKeys,
		type TouchKeysConfirmDetail,
		type TouchKeysOptions
	} from '@banto/touch-keys-svelte';
	import { touchKeysMessages } from '#lib/banto/touchKeysMessages.js';

	const touchKeysMessagesText = touchKeysMessages();
	let touchKeysOn = $state(true);
	let touchKeysCard = $state<HTMLElement>();
	let touchQty = $state<number | string>(12);
	let touchLot = $state('');
	let touchKana = $state('');
	let touchPassword = $state('');
	const isGridEditor = (input: HTMLInputElement): boolean =>
		input.closest('[data-grid-editor]') !== null;
	// `undefined` = infer from the field's attributes; `false` = no keys on this field.
	// A grid cell editor keeps the inferred kind and only gains `openOnFocus`.
	const touchKeysResolve = (input: HTMLInputElement): TouchKeysOptions | false | undefined => {
		if (!touchKeysCard?.contains(input)) return false;
		return isGridEditor(input) ? { openOnFocus: true } : undefined;
	};
	// The keys' confirm becomes the cell's commit: blur the grid editor only (a
	// blur on every field would close popups that close on focus loss, §5.1 E).
	const touchKeysConfirm = ({ input }: TouchKeysConfirmDetail): void => {
		if (isGridEditor(input)) input.blur();
	};

	// The grid of the card: quantity (number keypad) and lot (text keyboard).
	// A quantity over the stock is refused by the save, and the lot saves after a
	// short wait like a server would - both so the sample (and its e2e) shows what
	// the keys' confirm does when the save fails or is still running.
	interface TouchPick {
		code: string;
		qty: number;
		lot: string;
	}
	const TOUCH_PICK_STOCK = 500;
	const TOUCH_PICK_SAVE_MS = 800;
	let touchPicks = $state<TouchPick[]>([
		{ code: 'P-001', qty: 12, lot: 'L24A' },
		{ code: 'P-002', qty: 40, lot: 'L24B' },
		{ code: 'P-003', qty: 8, lot: '' }
	]);
	const touchPickColumns: GridColumn<TouchPick>[] = [
		{ id: 'code', header: m['uiDemo.touchKeys.gridCode'](), accessor: 'code', width: 120 },
		{
			id: 'qty',
			header: m['uiDemo.touchKeys.gridQty'](),
			accessor: 'qty',
			width: 140,
			align: 'right',
			editable: true,
			editor: 'number'
		},
		{
			id: 'lot',
			header: m['uiDemo.touchKeys.gridLot'](),
			accessor: 'lot',
			width: 180,
			editable: true
		}
	];
	async function saveTouchPick(edit: CellEdit<TouchPick>) {
		if (edit.field === 'qty' && typeof edit.value === 'number' && edit.value > TOUCH_PICK_STOCK) {
			throw new Error(m['uiDemo.touchKeys.gridOverStock']({ max: TOUCH_PICK_STOCK }));
		}
		if (edit.field === 'lot') {
			await new Promise((resolve) => setTimeout(resolve, TOUCH_PICK_SAVE_MS));
		}
		touchPicks = touchPicks.map((row) =>
			row.code === edit.rowId ? { ...row, [edit.field]: edit.value } : row
		);
	}
	// [scaffold:touch-keys] end

	// HeaderNav card (nav-menubar-plan PR-2): one set of entries drawn twice -
	// in a wide frame (groups, a badge) and a narrow one (entries moved into
	// "more"). The links point at in-page anchors so a click goes nowhere.
	// The "View" menu entry (#663) is pinned: it stays on the top row in the
	// narrow frame too. Its checkboxes flip demo-only state (no panels here).
	let headerNavPanels = $state({ log: true, properties: false });
	const headerNavEntries: HeaderNavEntry[] = $derived([
		{
			kind: 'link',
			id: 'home',
			href: '#ui-demo-nav',
			label: m['uiDemo.headerNav.home'](),
			icon: House,
			active: true
		},
		{
			kind: 'link',
			id: 'orders',
			href: '#ui-demo-nav',
			label: m['uiDemo.headerNav.orders'](),
			icon: ClipboardList,
			count: 3
		},
		{
			kind: 'group',
			id: 'plant',
			label: m['uiDemo.headerNav.plant'](),
			items: [
				{
					id: 'lines',
					href: '#ui-demo-nav',
					label: m['uiDemo.headerNav.lines'](),
					icon: Factory
				},
				{
					id: 'meters',
					href: '#ui-demo-nav',
					label: m['uiDemo.headerNav.meters'](),
					icon: Gauge,
					count: 2
				}
			]
		},
		{
			kind: 'link',
			id: 'stock',
			href: '#ui-demo-nav',
			label: m['uiDemo.headerNav.stock'](),
			icon: Package
		},
		{
			kind: 'link',
			id: 'reports',
			href: '#ui-demo-nav',
			label: m['uiDemo.headerNav.reports'](),
			icon: ChartColumn
		},
		{
			kind: 'menu',
			id: 'view',
			label: m['uiDemo.headerNav.view'](),
			items: [
				{
					kind: 'checkbox',
					id: 'log',
					label: m['uiDemo.headerNav.viewLog'](),
					checked: headerNavPanels.log,
					onSelect: () => (headerNavPanels.log = !headerNavPanels.log)
				},
				{
					kind: 'checkbox',
					id: 'properties',
					label: m['uiDemo.headerNav.viewProperties'](),
					checked: headerNavPanels.properties,
					onSelect: () => (headerNavPanels.properties = !headerNavPanels.properties)
				},
				{ kind: 'separator', id: 'sep' },
				{
					kind: 'action',
					id: 'reset',
					label: m['uiDemo.headerNav.viewReset'](),
					onSelect: () => (headerNavPanels = { log: true, properties: false })
				}
			]
		}
	]);
	const headerNavAdmin: HeaderNavEntry[] = $derived([
		{
			kind: 'group',
			id: 'admin',
			label: m['shell.adminHeading'](),
			items: [
				{
					id: 'users',
					href: '#ui-demo-nav',
					label: m['uiDemo.headerNav.users'](),
					icon: Users
				}
			]
		}
	]);
	const headerNavUpdates = (count: number) => m['shell.navUpdates']({ count });

	const variants: StatusBadgeVariant[] = ['neutral', 'success', 'warning', 'danger', 'info'];

	function variantLabel(variant: StatusBadgeVariant): string {
		switch (variant) {
			case 'neutral':
				return m['uiDemo.badge.neutral']();
			case 'success':
				return m['uiDemo.badge.success']();
			case 'warning':
				return m['uiDemo.badge.warning']();
			case 'danger':
				return m['uiDemo.badge.danger']();
			case 'info':
				return m['uiDemo.badge.info']();
		}
	}

	let clicks = $state(0);

	// Tabs / SegmentedControl / Tooltip (#556). The tooltip is closed on load,
	// so the screenshot shows only its trigger.
	const demoTabs: TabItem[] = [
		{ id: 'overview', label: m['uiDemo.tabs.overview']() },
		{ id: 'history', label: m['uiDemo.tabs.history']() },
		{ id: 'archived', label: m['uiDemo.tabs.archived'](), disabled: true }
	];
	let demoTab = $state('overview');

	// ThreePaneLayout (#631): the picked line names the target; a pick closes
	// the narrow drawer, as an app would.
	const threePaneLines = [
		{ id: 'line1', label: () => m['uiDemo.threePane.line1']() },
		{ id: 'line2', label: () => m['uiDemo.threePane.line2']() }
	];
	let threePaneLine = $state('line1');
	let threePaneDrawer = $state(false);
	const threePaneMessages: UiMessages = {
		threePaneLeft: () => m['uiDemo.threePane.tree'](),
		threePaneRight: () => m['uiDemo.threePane.detail'](),
		threePaneResizeLeft: () => m['uiDemo.threePane.treeWidth'](),
		threePaneResizeRight: () => m['uiDemo.threePane.detailWidth'](),
		overlayClose: () => m['common.close']()
	};
	type DemoView = 'list' | 'cards' | 'map';
	const demoViews: SegmentedOption<DemoView>[] = [
		{ value: 'list', label: m['uiDemo.segmented.list']() },
		{ value: 'cards', label: m['uiDemo.segmented.cards']() },
		{ value: 'map', label: m['uiDemo.segmented.map']() }
	];
	let demoView = $state<DemoView>('list');
	const demoViewLabel = $derived(demoViews.find((view) => view.value === demoView)?.label ?? '');
	let undone = $state(0);

	// Modal / Drawer card (phase 4): a modal, and a drawer whose note field
	// makes it dirty (Esc / backdrop blocked, × discards) and which can stack
	// a confirm modal on top - the Esc layering in one place.
	let modalOpen = $state(false);
	let drawerOpen = $state(false);
	let nestedOpen = $state(false);
	let drawerNote = $state('');
	let overlayClosed = $state(0);
	const overlayMessages = { overlayClose: () => m['common.close']() };

	function closeDrawer(): void {
		drawerOpen = false;
		nestedOpen = false;
		drawerNote = '';
		overlayClosed += 1;
	}
	let selected = $state<string | undefined>(undefined);

	// Context menu (#889): `Menu` without a trigger, opened at the pointer by
	// `openAt`. The segmented control picks where focus returns on close (the
	// right-clicked area, another element, nowhere) - e2e/visual/ui-overlays.spec.ts.
	type ContextReturn = 'origin' | 'other' | 'none';
	const contextReturns: SegmentedOption<ContextReturn>[] = [
		{ value: 'origin', label: m['uiDemo.contextMenu.returnOrigin']() },
		{ value: 'other', label: m['uiDemo.contextMenu.returnOther']() },
		{ value: 'none', label: m['uiDemo.contextMenu.returnNone']() }
	];
	let contextReturn = $state<ContextReturn>('origin');
	let contextMenu: ReturnType<typeof Menu> | undefined = $state();
	let contextOtherEl: HTMLButtonElement | undefined = $state();

	function openContextMenu(event: MouseEvent): void {
		event.preventDefault();
		(event.currentTarget as HTMLElement).focus();
		const point = { x: event.clientX, y: event.clientY };
		if (contextReturn === 'origin') contextMenu?.openAt(point);
		else
			contextMenu?.openAt(point, { returnFocus: contextReturn === 'none' ? null : contextOtherEl });
	}
	let colName = $state(true);
	let colUpdated = $state(false);

	// ConfirmDialog card (#556): the app's confirm store (shown by the root
	// layout's ConfirmHost), plain and with a name to type.
	let confirmAnswer = $state<boolean | null>(null);

	async function askPlain(): Promise<void> {
		confirmAnswer = await confirmAction({
			title: m['uiDemo.confirm.plainTitle'](),
			message: m['uiDemo.confirm.plainBody']()
		});
	}

	async function askTyped(): Promise<void> {
		const name = m['uiDemo.confirm.typedName']();
		confirmAnswer = await confirmAction({
			title: m['uiDemo.confirm.typedTitle'](),
			message: m['uiDemo.confirm.typedBody']({ name }),
			confirmLabel: m['common.delete'](),
			danger: true,
			requireText: name
		});
	}

	// DateInput card (date-time-pickers PR-1): fixed values and a fixed range
	// so the closed page is deterministic; the open calendar's screenshot
	// pins the clock (e2e/visual/visual.spec.ts). The package's text comes in
	// through `messages`, the month / weekday names from `Intl` with the
	// current Paraglide locale (§5.5).
	let dueDate = $state<string | null>('2026-11-07');
	let shipDate = $state<string | null>(null);
	const isWeekend = (date: string) => [0, 6].includes(dayOfWeek(date));
	const dateMessages = dateInputMessages();
	// Inside the sample Modal: a picker over a Modal, Esc closes the calendar
	// first and the Modal on the second press (date-time-pickers §8, PR-3).
	let modalDate = $state<string | null>(null);

	// TimeInput card (date-time-pickers PR-2): a 30-minute list without a step
	// (any minute can be typed, D8) and a 15-minute list inside office hours.
	// Fixed values, so the open list's screenshot is deterministic.
	let startTime = $state<string | null>('09:30');
	let meetingTime = $state<string | null>(null);
	// DateTimeInput card (date-time-pickers PR-5): one box, one dialog with the
	// calendar and the time list; the second sample bounds both and steps the
	// list. Fixed values, so the closed page is deterministic.
	let startsAt = $state<string | null>('2026-11-07T09:30');
	let visitAt = $state<string | null>(null);
	const dateTimeMessages = dateTimeInputMessages();
	// DateRangeInput card (date-time-pickers PR-6): a start and an end day in
	// one group; the second sample bounds both ends. Fixed values, so the
	// closed page is deterministic.
	let stayRange = $state<{ from: string | null; to: string | null }>({
		from: '2026-11-10',
		to: '2026-11-14'
	});
	let campaignRange = $state<{ from: string | null; to: string | null }>({ from: null, to: null });
	const dateRangeMessages = dateRangeInputMessages();
	// DatePicker / DateRangePicker card (#910): the extended calendar (two
	// months, a range picked in one calendar). Fixed values, so the closed
	// page is deterministic; the range crosses a month end.
	let bookingDate = $state<string | null>('2026-11-27');
	let lodgingRange = $state<{ from: string | null; to: string | null }>({
		from: '2026-11-28',
		to: '2026-12-03'
	});
	const dateRangePickerMessagesText = dateRangePickerMessages();
	// BantoForm card (#714): sections, two columns, help text and `visibleWhen`.
	// Labels are getters so they follow the locale (see resources/items.ts).
	const formDemoSchema: FormSchema = {
		columns: 2,
		sections: [
			{
				id: 'basic',
				get title() {
					return m['uiDemo.form.sectionBasic']();
				},
				get description() {
					return m['uiDemo.form.sectionBasicDesc']();
				}
			},
			{
				id: 'ship',
				get title() {
					return m['uiDemo.form.sectionShip']();
				}
			}
		],
		fields: [
			{
				name: 'name',
				get label() {
					return m['uiDemo.form.fieldName']();
				},
				get help() {
					return m['uiDemo.form.fieldNameHelp']();
				},
				type: 'text',
				required: true,
				max: 40,
				section: 'basic'
			},
			{
				name: 'code',
				get label() {
					return m['uiDemo.form.fieldCode']();
				},
				type: 'text',
				section: 'basic'
			},
			{
				name: 'qty',
				get label() {
					return m['uiDemo.form.fieldQty']();
				},
				type: 'number',
				min: 0,
				section: 'basic'
			},
			{
				name: 'memo',
				get label() {
					return m['uiDemo.form.fieldMemo']();
				},
				type: 'textarea',
				fullWidth: true,
				section: 'basic'
			},
			{
				name: 'gift',
				get label() {
					return m['uiDemo.form.fieldGift']();
				},
				type: 'checkbox',
				section: 'ship'
			},
			{
				name: 'wrap',
				get label() {
					return m['uiDemo.form.fieldWrap']();
				},
				get help() {
					return m['uiDemo.form.fieldWrapHelp']();
				},
				type: 'text',
				required: true,
				section: 'ship',
				visibleWhen: (values) => values.gift === true
			}
		]
	};
	const formDemoStore = createFormStore(formDemoSchema, undefined, formValidationMessages());
	let formDemoKeys = $state<string[] | null>(null);
	// BantoForm choice types (#714): radio, segmented, multiselect and a number
	// with a unit. The values caption below prints what onSubmit received.
	const choicesDemoSchema: FormSchema = {
		columns: 2,
		fields: [
			{
				name: 'speed',
				get label() {
					return m['uiDemo.choices.fieldSpeed']();
				},
				type: 'radio',
				options: [
					{
						value: 'normal',
						get label() {
							return m['uiDemo.choices.speedNormal']();
						}
					},
					{
						value: 'express',
						get label() {
							return m['uiDemo.choices.speedExpress']();
						}
					},
					{
						value: 'pickup',
						get label() {
							return m['uiDemo.choices.speedPickup']();
						}
					}
				],
				default: 'normal'
			},
			{
				name: 'size',
				get label() {
					return m['uiDemo.choices.fieldSize']();
				},
				type: 'radio',
				variant: 'segmented',
				options: [
					{ value: 's', label: 'S' },
					{ value: 'm', label: 'M' },
					{ value: 'l', label: 'L' }
				],
				default: 'm'
			},
			{
				name: 'extras',
				get label() {
					return m['uiDemo.choices.fieldExtras']();
				},
				get help() {
					return m['uiDemo.choices.fieldExtrasHelp']();
				},
				type: 'multiselect',
				required: true,
				fullWidth: true,
				options: [
					{
						value: 'card',
						get label() {
							return m['uiDemo.choices.extrasCard']();
						}
					},
					{
						value: 'manual',
						get label() {
							return m['uiDemo.choices.extrasManual']();
						}
					},
					{
						value: 'warranty',
						get label() {
							return m['uiDemo.choices.extrasWarranty']();
						}
					}
				]
			},
			{
				name: 'weight',
				get label() {
					return m['uiDemo.choices.fieldWeight']();
				},
				get help() {
					return m['uiDemo.choices.fieldWeightHelp']();
				},
				type: 'number',
				suffix: 'kg',
				min: 0
			},
			{
				name: 'price',
				get label() {
					return m['uiDemo.choices.fieldPrice']();
				},
				type: 'number',
				prefix: '¥',
				min: 0
			}
		]
	};
	const choicesDemoStore = createFormStore(choicesDemoSchema, undefined, formValidationMessages());
	let choicesDemoValues = $state<Record<string, unknown> | null>(null);
	// BantoForm reference type (#714): a combobox that searches as you type.
	// The rows are a local array, so the card needs no backend in any mode (an
	// app builds `search` / `resolve` from its DataProvider with
	// `referenceFrom`, src/lib/banto/reference.ts). Names are fixed sample data.
	const referenceDemoStaff: ReferenceOption[] = [
		{ value: 101, label: 'Aoki Sakura', description: 'Tokyo' },
		{ value: 102, label: 'Aoyama Ken', description: 'Osaka' },
		{ value: 103, label: 'Inoue Mei', description: 'Tokyo' },
		{ value: 104, label: 'Ito Haru', description: 'Nagoya' },
		{ value: 105, label: 'Sato Yui', description: 'Osaka' },
		{ value: 106, label: 'Suzuki Ren', description: 'Tokyo' }
	];
	const referenceDemoSource = {
		search: async (query: string) => {
			const term = query.toLowerCase();
			return referenceDemoStaff.filter((person) =>
				`${person.label} ${person.description ?? ''}`.toLowerCase().includes(term)
			);
		},
		resolve: async (value: string | number) =>
			referenceDemoStaff.find((person) => person.value === value) ?? null
	};
	const referenceDemoSchema: FormSchema = {
		columns: 2,
		fields: [
			{
				name: 'owner',
				get label() {
					return m['uiDemo.reference.fieldOwner']();
				},
				get help() {
					return m['uiDemo.reference.fieldOwnerHelp']();
				},
				type: 'reference',
				required: true,
				...referenceDemoSource
			},
			{
				name: 'deputy',
				get label() {
					return m['uiDemo.reference.fieldBackup']();
				},
				type: 'reference',
				default: 103,
				...referenceDemoSource
			}
		]
	};
	const referenceDemoStore = createFormStore(
		referenceDemoSchema,
		undefined,
		formValidationMessages()
	);
	let referenceDemoValues = $state<Record<string, unknown> | null>(null);
	// BantoForm file type (#714, plan §4.12). The "store" is a local array, so
	// the card needs no backend in any mode (an app passes its attachments
	// client, `attachmentsAdmin.ts`, as `file.client`). It takes 64 KB at most
	// while the field allows 1 MB: a rejection stricter than the screen.
	const FILE_DEMO_STORE_LIMIT = 64 * 1024;
	let fileDemoRows: FileFieldMeta[] = [];
	let fileDemoNextId = 1;
	const fileDemoClient: FileFieldClient = {
		list: async () => [...fileDemoRows],
		upload: async (_resource, _resourceId, file) => {
			if (file.size > FILE_DEMO_STORE_LIMIT) throw new Error(m['uiDemo.file.serverLimit']());
			const row = { id: fileDemoNextId++, fileName: file.name, sizeBytes: file.size };
			fileDemoRows = [...fileDemoRows, row];
			return row;
		},
		remove: async (id) => {
			fileDemoRows = fileDemoRows.filter((row) => row.id !== id);
		}
	};
	const fileDemoSchema: FormSchema = {
		fields: [
			{
				name: 'title',
				get label() {
					return m['uiDemo.file.fieldTitle']();
				},
				type: 'text'
			},
			{
				name: 'files',
				get label() {
					return m['uiDemo.file.fieldFiles']();
				},
				get help() {
					return m['uiDemo.file.fieldFilesHelp']();
				},
				type: 'file',
				file: {
					client: fileDemoClient,
					resource: 'ui-demo',
					accept: '.txt,.pdf,image/*',
					maxFileSize: 1024 * 1024,
					maxFiles: 3,
					confirmRemove: (message) => confirmAction({ title: message, danger: true })
				}
			}
		]
	};
	const fileDemoStore = createFormStore(fileDemoSchema, undefined, formValidationMessages());
	/** The record the card edits; `null` until "create" made one. */
	let fileDemoParentId = $state<number | null>(null);
	let fileDemoValues = $state<Record<string, unknown> | null>(null);
	let fileDemoOutcome = $state<{ uploaded: number; failed: number } | null>(null);
	async function submitFileDemo(values: Record<string, unknown>): Promise<void> {
		fileDemoValues = values;
		fileDemoStore.markClean();
		if (fileDemoParentId !== null) return;
		// "Create" succeeded: only now do the chosen files go to the new record.
		const id = 1;
		const outcome = await uploadPendingFiles(
			fileDemoSchema,
			fileDemoStore,
			id,
			fileFieldMessages()
		);
		fileDemoOutcome = { uploaded: outcome.uploaded.length, failed: outcome.failed.length };
		fileDemoParentId = id;
	}
	function resetFileDemo(): void {
		fileDemoRows = [];
		fileDemoParentId = null;
		fileDemoValues = null;
		fileDemoOutcome = null;
		fileDemoStore.reset();
	}
	// BantoGrid card (date-time-pickers PR-4): an editable date column gets
	// the DateInput the root layout injects (`provideCellEditors`); the range
	// comes from the schema (min / max, like the ship date above). Fixed
	// rows, so the closed page is deterministic; edits stay on this page.
	interface Shipment {
		code: string;
		due: string | null;
		shippedAt: string | null;
		late: boolean;
		progress: number;
		express: boolean;
	}
	let shipments = $state<Shipment[]>([
		{
			code: 'A-100',
			due: '2026-11-07',
			shippedAt: '2026-11-06T09:30',
			late: false,
			progress: 1,
			express: true
		},
		{ code: 'B-200', due: null, shippedAt: null, late: true, progress: 0.35, express: false },
		{
			code: 'C-300',
			due: '2026-11-20',
			shippedAt: '2026-11-19T15:00',
			late: false,
			progress: 0.7,
			express: false
		}
	]);
	const shipmentSchemaColumns = columnsFromSchema<Shipment>(
		{
			fields: [
				{ name: 'code', label: m['uiDemo.gridDate.code'](), type: 'text', readonly: true },
				{
					name: 'due',
					label: m['uiDemo.gridDate.due'](),
					type: 'date',
					min: '2026-11-02',
					max: '2026-11-27'
				},
				{
					name: 'shippedAt',
					label: m['uiDemo.gridDate.shippedAt'](),
					type: 'datetime',
					min: '2026-11-02T09:00',
					max: '2026-11-27T18:00'
				}
			]
		},
		{ messages: columnValidationMessages() }
	);
	// Built-in cell drawing (#713): a badge coloured by tone, a progress bar and
	// a boolean mark. Display only (not editable), so the page stays deterministic.
	// The code column is pinned to the left (#713): on a narrow card it stays
	// in place, after the checkbox column, while the others scroll sideways.
	const shipmentColumns: GridColumn<Shipment>[] = [
		...shipmentSchemaColumns.map((column): GridColumn<Shipment> =>
			column.id === 'code' ? { ...column, pinned: 'left' } : column
		),
		{
			id: 'state',
			header: m['uiDemo.gridDate.state'](),
			accessor: 'late',
			width: 110,
			renderer: 'badge',
			format: (v) => (v ? m['uiDemo.gridDate.stateLate']() : m['uiDemo.gridDate.stateOnTime']()),
			tone: (v) => (v ? 'danger' : 'success')
		},
		{
			id: 'progress',
			header: m['uiDemo.gridDate.progress'](),
			accessor: 'progress',
			width: 150,
			renderer: 'progress',
			tone: (v) => (typeof v === 'number' && v >= 1 ? 'success' : null)
		},
		{
			id: 'express',
			header: m['uiDemo.gridDate.express'](),
			accessor: 'express',
			width: 90,
			align: 'center',
			renderer: 'boolean'
		}
	];
	function saveShipment(edit: CellEdit<Shipment>) {
		shipments = shipments.map((row) =>
			row.code === edit.rowId ? { ...row, [edit.field]: edit.value } : row
		);
	}
	// Row selection (#713): the bulk bar's sample action only touches these
	// in-memory rows - a real page calls its own operation with the ids.
	let selectedShipments = $state<(string | number)[]>([]);
	function markExpress(ids: (string | number)[], clear: () => void) {
		shipments = shipments.map((row) => (ids.includes(row.code) ? { ...row, express: true } : row));
		clear();
	}
	const timeMessages: UiMessages = {
		timePickerOpen: () => m['timePicker.open'](),
		timePickerList: () => m['timePicker.list'](),
		timeFormatHint: () => m['timePicker.formatHint']()
	};

	// Static sample commands: two groups, an icon, a shortcut hint and a
	// disabled row. The palette's own text reuses the app's palette messages;
	// only the dialog label differs from the global (Ctrl+K) palette.
	let paletteOpen = $state(false);
	let executed = $state<string | undefined>(undefined);
	const paletteItems = $derived<CommandPaletteItem[]>([
		{
			id: 'create',
			title: m['uiDemo.palette.create'](),
			group: m['uiDemo.palette.groupFile'](),
			icon: FilePlus
		},
		{
			id: 'save',
			title: m['uiDemo.palette.save'](),
			group: m['uiDemo.palette.groupFile'](),
			icon: Save,
			shortcut: 'Ctrl+S'
		},
		{
			id: 'unavailable',
			title: m['uiDemo.palette.unavailable'](),
			group: m['uiDemo.palette.groupFile'](),
			disabled: true
		},
		{
			id: 'refresh',
			title: m['uiDemo.palette.refresh'](),
			group: m['uiDemo.palette.groupView'](),
			icon: RefreshCw
		}
	]);
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.uiDemo']()} description={m['uiDemo.intro']()}>
		{#snippet actions()}
			<button type="button" class="banto-btn banto-btn--secondary">{m['common.cancel']()}</button>
			<button type="button" class="banto-btn banto-btn--primary">{m['common.save']()}</button>
		{/snippet}
	</PageHeader>

	<SurfaceCard title="PageHeader" description={m['uiDemo.header.desc']()}>
		<!-- Extra headers on the same page: the real one above already owns
		     `view-transition-name: page-header`, and a duplicate name voids the
		     page transition - so the samples opt out of it. -->
		<div class="stack samples-header">
			<div class="sample">
				<span class="caption">{m['uiDemo.header.titleOnly']()}</span>
				<PageHeader title={m['uiDemo.header.sampleTitle']()} />
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.header.withDescription']()}</span>
				<PageHeader
					title={m['uiDemo.header.sampleTitle']()}
					description={m['uiDemo.header.sampleDescription']()}
				/>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.header.withActions']()}</span>
				<PageHeader
					title={m['uiDemo.header.sampleTitle']()}
					description={m['uiDemo.header.sampleDescription']()}
				>
					{#snippet actions()}
						<button type="button" class="banto-btn banto-btn--secondary">
							{m['common.cancel']()}
						</button>
						<button type="button" class="banto-btn banto-btn--primary">{m['common.save']()}</button>
					{/snippet}
				</PageHeader>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="SurfaceCard" description={m['uiDemo.card.desc']()}>
		<div class="grid">
			<div class="sample">
				<span class="caption">{m['uiDemo.card.titleOnly']()}</span>
				<SurfaceCard title={m['uiDemo.card.sampleTitle']()}>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
				</SurfaceCard>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.card.withDescription']()}</span>
				<SurfaceCard
					title={m['uiDemo.card.sampleTitle']()}
					description={m['uiDemo.card.sampleDescription']()}
				>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
				</SurfaceCard>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.card.bodyOnly']()}</span>
				<SurfaceCard>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
				</SurfaceCard>
			</div>
			{#each ['primary', 'default', 'subtle'] as const as tone (tone)}
				<div class="sample">
					<span class="caption">{m[`uiDemo.card.tone.${tone}`]()}</span>
					<SurfaceCard {tone} title={m['uiDemo.card.sampleTitle']()}>
						<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
					</SurfaceCard>
				</div>
			{/each}
			<div class="sample">
				<span class="caption">{m['uiDemo.card.withFooter']()}</span>
				<SurfaceCard title={m['uiDemo.card.sampleTitle']()}>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
					{#snippet footer()}
						<button type="button" class="banto-btn banto-btn--ghost">{m['common.cancel']()}</button>
						<button type="button" class="banto-btn banto-btn--primary">{m['common.save']()}</button>
					{/snippet}
				</SurfaceCard>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="StatusBadge" description={m['uiDemo.badge.desc']()}>
		<div class="row">
			{#each variants as variant (variant)}
				<StatusBadge {variant} label={variantLabel(variant)} />
			{/each}
		</div>
		<div class="row row--spaced">
			<span class="caption">{m['uiDemo.customIcon']()}</span>
			<StatusBadge variant="info" label={m['uiDemo.badge.customIconLabel']()} icon={Star} />
		</div>
	</SurfaceCard>

	<SurfaceCard title="IconButton" description={m['uiDemo.iconButton.desc']()}>
		<div class="row">
			<span class="caption">md</span>
			<IconButton label={m['common.close']()} icon={X} onclick={() => (clicks += 1)} />
			<span class="caption">sm</span>
			<IconButton label={m['common.close']()} icon={X} size="sm" onclick={() => (clicks += 1)} />
			<span class="caption">{m['uiDemo.customIcon']()}</span>
			<IconButton label={m['uiDemo.iconButton.add']()} icon={Plus} onclick={() => (clicks += 1)} />
			<span class="caption" data-testid="ui-demo-clicks">
				{m['uiDemo.iconButton.clicks']()}: {clicks}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="Menu" description={m['uiDemo.menu.desc']()}>
		<div class="row">
			<Menu label={m['uiDemo.menu.label']()} placement="bottom-start">
				{#snippet trigger(props)}
					<button {...props} type="button" class="banto-btn banto-btn--secondary">
						{m['uiDemo.menu.trigger']()}
						<ChevronDown size={14} aria-hidden="true" />
					</button>
				{/snippet}
				<MenuGroup label={m['uiDemo.menu.group']()}>
					<MenuItem
						icon={Pencil}
						label={m['uiDemo.menu.edit']()}
						onSelect={() => (selected = m['uiDemo.menu.edit']())}
					/>
					<MenuItem
						icon={Copy}
						label={m['uiDemo.menu.duplicate']()}
						onSelect={() => (selected = m['uiDemo.menu.duplicate']())}
					/>
					<MenuItem label={m['uiDemo.menu.unavailable']()} disabled onSelect={() => {}} />
				</MenuGroup>
				<MenuSeparator />
				<MenuGroup label={m['uiDemo.menu.colGroup']()}>
					<MenuItem
						kind="checkbox"
						checked={colName}
						label={m['uiDemo.menu.colName']()}
						onSelect={() => (colName = !colName)}
					/>
					<MenuItem
						kind="checkbox"
						checked={colUpdated}
						label={m['uiDemo.menu.colUpdated']()}
						onSelect={() => (colUpdated = !colUpdated)}
					/>
					<MenuItem
						kind="checkbox"
						checked={true}
						disabled
						title={m['uiDemo.menu.colLockedTitle']()}
						label={m['uiDemo.menu.colLocked']()}
						onSelect={() => {}}
					/>
				</MenuGroup>
				<MenuSeparator />
				<MenuItem
					icon={Trash2}
					label={m['uiDemo.menu.delete']()}
					danger
					onSelect={() => (selected = m['uiDemo.menu.delete']())}
				/>
			</Menu>
			<span class="caption" data-testid="ui-demo-menu-selected">
				{m['uiDemo.menu.selected']()}: {selected ?? m['uiDemo.menu.none']()}
			</span>
		</div>
		<div class="row row--spaced">
			<button
				type="button"
				class="context-area"
				data-testid="ui-demo-context-area"
				oncontextmenu={openContextMenu}
			>
				{m['uiDemo.contextMenu.area']()}
			</button>
			<SegmentedControl
				options={contextReturns}
				bind:value={contextReturn}
				name="ui-demo-context-return"
				label={m['uiDemo.contextMenu.returnLabel']()}
			/>
			<button type="button" bind:this={contextOtherEl} data-testid="ui-demo-context-other">
				{m['uiDemo.contextMenu.other']()}
			</button>
			<Menu bind:this={contextMenu} label={m['uiDemo.contextMenu.label']()}>
				<MenuItem
					label={m['uiDemo.menu.edit']()}
					onSelect={() => (selected = m['uiDemo.menu.edit']())}
				/>
				<MenuItem
					label={m['uiDemo.menu.duplicate']()}
					onSelect={() => (selected = m['uiDemo.menu.duplicate']())}
				/>
			</Menu>
		</div>
	</SurfaceCard>

	<SurfaceCard title="HeaderNav" description={m['uiDemo.headerNav.desc']()}>
		<div class="stack" id="ui-demo-nav">
			<div class="sample">
				<span class="caption">{m['uiDemo.headerNav.wide']()}</span>
				<div class="header-nav-frame">
					<HeaderNav
						entries={headerNavEntries}
						ariaLabel={m['uiDemo.headerNav.label']()}
						moreLabel={m['uiDemo.headerNav.more']()}
						updatesLabel={headerNavUpdates}
					/>
					<HeaderNav
						entries={headerNavAdmin}
						ariaLabel={m['uiDemo.headerNav.adminLabel']()}
						moreLabel={m['uiDemo.headerNav.more']()}
						updatesLabel={headerNavUpdates}
						overflow={false}
					/>
				</div>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.headerNav.narrow']()}</span>
				<div class="header-nav-frame header-nav-frame--narrow">
					<HeaderNav
						entries={headerNavEntries}
						ariaLabel={m['uiDemo.headerNav.narrowLabel']()}
						moreLabel={m['uiDemo.headerNav.more']()}
						updatesLabel={headerNavUpdates}
					/>
				</div>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="DateInput" description={m['uiDemo.date.desc']()}>
		<div class="grid">
			<div class="sample">
				<label class="caption" for="ui-demo-due-date">{m['uiDemo.date.label']()}</label>
				<DateInput
					id="ui-demo-due-date"
					bind:value={dueDate}
					locale={getLocale()}
					messages={dateMessages}
				/>
				<span class="caption" data-testid="ui-demo-due-date-value">
					{m['uiDemo.date.value']()}: {dueDate ?? m['uiDemo.date.empty']()}
				</span>
			</div>
			<div class="sample">
				<label class="caption" for="ui-demo-ship-date">{m['uiDemo.date.rangeLabel']()}</label>
				<DateInput
					id="ui-demo-ship-date"
					bind:value={shipDate}
					min="2026-11-02"
					max="2026-11-27"
					isDateDisabled={isWeekend}
					locale={getLocale()}
					messages={dateMessages}
				/>
				<span class="caption" data-testid="ui-demo-ship-date-value">
					{m['uiDemo.date.value']()}: {shipDate ?? m['uiDemo.date.empty']()}
				</span>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="TimeInput" description={m['uiDemo.time.desc']()}>
		<div class="grid">
			<div class="sample">
				<label class="caption" for="ui-demo-start-time">{m['uiDemo.time.label']()}</label>
				<TimeInput id="ui-demo-start-time" bind:value={startTime} messages={timeMessages} />
				<span class="caption" data-testid="ui-demo-start-time-value">
					{m['uiDemo.date.value']()}: {startTime ?? m['uiDemo.date.empty']()}
				</span>
			</div>
			<div class="sample">
				<label class="caption" for="ui-demo-meeting-time">{m['uiDemo.time.stepLabel']()}</label>
				<TimeInput
					id="ui-demo-meeting-time"
					bind:value={meetingTime}
					step={15}
					min="09:00"
					max="18:00"
					messages={timeMessages}
				/>
				<span class="caption" data-testid="ui-demo-meeting-time-value">
					{m['uiDemo.date.value']()}: {meetingTime ?? m['uiDemo.date.empty']()}
				</span>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="DateTimeInput" description={m['uiDemo.dateTime.desc']()}>
		<div class="grid">
			<div class="sample">
				<label class="caption" for="ui-demo-starts-at">{m['uiDemo.dateTime.label']()}</label>
				<DateTimeInput
					id="ui-demo-starts-at"
					bind:value={startsAt}
					locale={getLocale()}
					messages={dateTimeMessages}
				/>
				<span class="caption" data-testid="ui-demo-starts-at-value">
					{m['uiDemo.date.value']()}: {startsAt ?? m['uiDemo.date.empty']()}
				</span>
			</div>
			<div class="sample">
				<label class="caption" for="ui-demo-visit-at">{m['uiDemo.dateTime.rangeLabel']()}</label>
				<DateTimeInput
					id="ui-demo-visit-at"
					bind:value={visitAt}
					min="2026-11-02T09:00"
					max="2026-11-27T18:00"
					step={30}
					locale={getLocale()}
					messages={dateTimeMessages}
				/>
				<span class="caption" data-testid="ui-demo-visit-at-value">
					{m['uiDemo.date.value']()}: {visitAt ?? m['uiDemo.date.empty']()}
				</span>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="DateRangeInput" description={m['uiDemo.dateRange.desc']()}>
		<div class="grid">
			<div class="sample">
				<span class="caption" id="ui-demo-stay-label">{m['uiDemo.dateRange.label']()}</span>
				<DateRangeInput
					id="ui-demo-stay"
					labelledBy="ui-demo-stay-label"
					bind:value={stayRange}
					locale={getLocale()}
					messages={dateRangeMessages}
				/>
				<span class="caption" data-testid="ui-demo-stay-value">
					{m['uiDemo.date.value']()}: {stayRange.from ?? m['uiDemo.date.empty']()} – {stayRange.to ??
						m['uiDemo.date.empty']()}
				</span>
			</div>
			<div class="sample">
				<span class="caption" id="ui-demo-campaign-label">
					{m['uiDemo.dateRange.rangeLabel']()}
				</span>
				<DateRangeInput
					id="ui-demo-campaign"
					labelledBy="ui-demo-campaign-label"
					bind:value={campaignRange}
					min="2026-11-02"
					max="2026-11-27"
					isDateDisabled={isWeekend}
					locale={getLocale()}
					messages={dateRangeMessages}
				/>
				<span class="caption" data-testid="ui-demo-campaign-value">
					{m['uiDemo.date.value']()}: {campaignRange.from ?? m['uiDemo.date.empty']()} – {campaignRange.to ??
						m['uiDemo.date.empty']()}
				</span>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="BantoForm" description={m['uiDemo.form.desc']()}>
		<div data-testid="ui-demo-form">
			<BantoForm
				schema={formDemoSchema}
				store={formDemoStore}
				submitLabel={m['uiDemo.form.submit']()}
				onSubmit={(values) => {
					formDemoKeys = Object.keys(values);
				}}
			/>
		</div>
		<span class="caption" data-testid="ui-demo-form-submitted">
			{m['uiDemo.form.submitted']()}: {formDemoKeys
				? formDemoKeys.join(', ')
				: m['uiDemo.form.none']()}
		</span>
	</SurfaceCard>

	<SurfaceCard title="BantoForm" description={m['uiDemo.choices.desc']()}>
		<div data-testid="ui-demo-choices">
			<BantoForm
				schema={choicesDemoSchema}
				store={choicesDemoStore}
				submitLabel={m['uiDemo.form.submit']()}
				onSubmit={(values) => {
					choicesDemoValues = values;
				}}
			/>
		</div>
		<span class="caption">
			{m['uiDemo.choices.submitted']()}:
			<code data-testid="ui-demo-choices-values">
				{choicesDemoValues ? JSON.stringify(choicesDemoValues) : m['uiDemo.form.none']()}
			</code>
		</span>
	</SurfaceCard>

	<SurfaceCard title="BantoForm" description={m['uiDemo.reference.desc']()}>
		<div data-testid="ui-demo-reference">
			<BantoForm
				schema={referenceDemoSchema}
				store={referenceDemoStore}
				submitLabel={m['uiDemo.form.submit']()}
				referenceMessages={referenceFieldMessages()}
				onSubmit={(values) => {
					referenceDemoValues = values;
				}}
			/>
		</div>
		<span class="caption">
			{m['uiDemo.choices.submitted']()}:
			<code data-testid="ui-demo-reference-values">
				{referenceDemoValues ? JSON.stringify(referenceDemoValues) : m['uiDemo.form.none']()}
			</code>
		</span>
	</SurfaceCard>

	<SurfaceCard title="BantoForm" description={m['uiDemo.file.desc']()}>
		<div data-testid="ui-demo-file">
			<BantoForm
				schema={fileDemoSchema}
				store={fileDemoStore}
				submitLabel={fileDemoParentId === null
					? m['uiDemo.file.create']()
					: m['uiDemo.file.save']()}
				fileParentId={fileDemoParentId}
				fileMessages={fileFieldMessages()}
				passwordMessages={passwordInputMessages()}
				onSubmit={submitFileDemo}
			>
				<button type="button" class="banto-btn banto-btn--secondary" onclick={resetFileDemo}>
					{m['uiDemo.file.reset']()}
				</button>
			</BantoForm>
		</div>
		<span class="caption" data-testid="ui-demo-file-state">
			{fileDemoParentId === null
				? m['uiDemo.file.stateNew']()
				: m['uiDemo.file.stateEdit']({ id: fileDemoParentId })}
			{#if fileDemoOutcome}
				- {m['uiDemo.file.uploaded'](fileDemoOutcome)}
			{/if}
		</span>
		<span class="caption">
			{m['uiDemo.choices.submitted']()}:
			<code data-testid="ui-demo-file-values">
				{fileDemoValues ? JSON.stringify(fileDemoValues) : m['uiDemo.form.none']()}
			</code>
		</span>
	</SurfaceCard>

	<SurfaceCard title="CommandPalette" description={m['uiDemo.palette.desc']()}>
		<div class="row">
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => (paletteOpen = true)}
			>
				{m['uiDemo.palette.open']()}
			</button>
			<span class="caption" data-testid="ui-demo-palette-executed">
				{m['uiDemo.palette.executed']()}: {executed ?? m['uiDemo.menu.none']()}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="Modal / Drawer" description={m['uiDemo.overlay.desc']()}>
		<div class="row">
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				data-testid="ui-demo-open-modal"
				onclick={() => (modalOpen = true)}
			>
				{m['uiDemo.overlay.openModal']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				data-testid="ui-demo-open-drawer"
				onclick={() => (drawerOpen = true)}
			>
				{m['uiDemo.overlay.openDrawer']()}
			</button>
			<span class="caption" data-testid="ui-demo-overlay-closed">
				{m['uiDemo.overlay.closedCount']()}: {overlayClosed}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="ConfirmDialog" description={m['uiDemo.confirm.desc']()}>
		<div class="row">
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				data-testid="ui-demo-open-confirm"
				onclick={askPlain}
			>
				{m['uiDemo.confirm.openPlain']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				data-testid="ui-demo-open-confirm-typed"
				onclick={askTyped}
			>
				{m['uiDemo.confirm.openTyped']()}
			</button>
			<span class="caption" data-testid="ui-demo-confirm-answer">
				{m['uiDemo.confirm.answer']()}: {confirmAnswer === null
					? m['uiDemo.menu.none']()
					: confirmAnswer
						? m['uiDemo.confirm.answerYes']()
						: m['uiDemo.confirm.answerNo']()}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="Tabs" description={m['uiDemo.tabs.desc']()}>
		<Tabs tabs={demoTabs} bind:value={demoTab} label={m['uiDemo.tabs.label']()}>
			{#snippet panel(id)}
				<p class="body-text">
					{id === 'history' ? m['uiDemo.tabs.historyBody']() : m['uiDemo.tabs.overviewBody']()}
				</p>
			{/snippet}
		</Tabs>
	</SurfaceCard>

	<SurfaceCard title="ThreePaneLayout" description={m['uiDemo.threePane.desc']()}>
		<div class="three-pane-box">
			<ThreePaneLayout
				title={threePaneLines.find((line) => line.id === threePaneLine)?.label()}
				bind:leftDrawerOpen={threePaneDrawer}
				messages={threePaneMessages}
			>
				{#snippet left()}
					<ul class="three-pane-list">
						{#each threePaneLines as line (line.id)}
							<li>
								<button
									type="button"
									class="banto-btn banto-btn--ghost"
									aria-pressed={threePaneLine === line.id}
									onclick={() => {
										threePaneLine = line.id;
										threePaneDrawer = false;
									}}
								>
									{line.label()}
								</button>
							</li>
						{/each}
					</ul>
				{/snippet}
				{#snippet right()}
					<p class="body-text three-pane-text">{m['uiDemo.threePane.detailBody']()}</p>
				{/snippet}
				<p class="body-text three-pane-text">{m['uiDemo.threePane.body']()}</p>
			</ThreePaneLayout>
		</div>
	</SurfaceCard>

	<SurfaceCard title="SegmentedControl" description={m['uiDemo.segmented.desc']()}>
		<div class="row">
			<SegmentedControl
				options={demoViews}
				bind:value={demoView}
				name="ui-demo-view"
				label={m['uiDemo.segmented.label']()}
			/>
			<SegmentedControl
				options={demoViews}
				bind:value={demoView}
				name="ui-demo-view-sm"
				label={m['uiDemo.segmented.label']()}
				size="sm"
			/>
			<span class="caption" data-testid="ui-demo-segmented">
				{m['uiDemo.segmented.selected']()}: {demoViewLabel}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="Tooltip" description={m['uiDemo.tooltip.desc']()}>
		<div class="row">
			<Tooltip text={m['uiDemo.tooltip.text']()}>
				{#snippet children(trigger)}
					<button
						{...trigger}
						type="button"
						class="banto-btn banto-btn--secondary"
						data-testid="ui-demo-tooltip-trigger"
					>
						<Save size={16} aria-hidden="true" />
						{m['uiDemo.tooltip.trigger']()}
					</button>
				{/snippet}
			</Tooltip>
		</div>
	</SurfaceCard>

	<SurfaceCard title="ToastHost" description={m['uiDemo.toast.desc']()}>
		<div class="row">
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => toastStore.push('success', m['uiDemo.toast.messageSuccess']())}
			>
				{m['uiDemo.toast.success']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => toastStore.push('error', m['uiDemo.toast.messageError']())}
			>
				{m['uiDemo.toast.error']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => toastStore.push('info', m['uiDemo.toast.messageInfo']())}
			>
				{m['uiDemo.toast.info']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => toastStore.push('warning', m['uiDemo.toast.messageWarning']())}
			>
				{m['uiDemo.toast.warning']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() =>
					toastStore.push('info', m['uiDemo.toast.messageAction'](), {
						action: { label: m['uiDemo.toast.undo'](), onAction: () => (undone += 1) },
						durationMs: 8000
					})}
			>
				{m['uiDemo.toast.withAction']()}
			</button>
			<span class="caption" data-testid="ui-demo-toast-undone">
				{m['uiDemo.toast.undone']()}: {undone}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="EmptyState" description={m['uiDemo.empty.desc']()}>
		<div class="grid">
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.default']()}</span>
				<EmptyState
					title={m['uiDemo.empty.title']()}
					description={m['uiDemo.empty.description']()}
				/>
			</div>
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.customIcon']()} + action</span>
				<EmptyState
					icon={SearchX}
					title={m['uiDemo.empty.customTitle']()}
					description={m['uiDemo.empty.description']()}
				>
					{#snippet action()}
						<button type="button" class="banto-btn banto-btn--secondary">
							{m['common.reload']()}
						</button>
					{/snippet}
				</EmptyState>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="ErrorState" description={m['uiDemo.error.desc']()}>
		<div class="grid">
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.default']()}</span>
				<ErrorState
					title={m['uiDemo.error.title']()}
					description={m['uiDemo.error.description']()}
				/>
			</div>
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.customIcon']()} + action</span>
				<ErrorState
					icon={ServerCrash}
					title={m['uiDemo.error.customTitle']()}
					description={m['uiDemo.error.description']()}
				>
					{#snippet action()}
						<button type="button" class="banto-btn banto-btn--secondary">
							<RefreshCw size={14} aria-hidden="true" />
							{m['common.reload']()}
						</button>
					{/snippet}
				</ErrorState>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="LoadingState" description={m['uiDemo.loading.desc']()}>
		<div class="grid">
			<div class="sample sample--frame">
				<span class="caption">label = common.loading</span>
				<LoadingState label={m['common.loading']()} />
			</div>
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.loading.customLabel']()}</span>
				<LoadingState label={m['uiDemo.loading.customLabelText']()} />
			</div>
			<div class="sample sample--frame">
				<span class="caption">lines = 1</span>
				<LoadingState label={m['common.loading']()} lines={1} />
			</div>
			<div class="sample sample--frame">
				<span class="caption">lines = 5</span>
				<LoadingState label={m['common.loading']()} lines={5} />
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard
		title="BantoGrid + DateInput / DateTimeInput"
		description={m['uiDemo.gridDate.desc']()}
	>
		<div class="grid-sample" data-testid="ui-demo-grid-date">
			<BantoGrid
				rows={shipments}
				columns={shipmentColumns}
				getRowId={(row) => row.code}
				onCellEdit={saveShipment}
				messages={gridMessages()}
				selectable
				bind:selectedRowIds={selectedShipments}
			>
				{#snippet bulkActions({ ids, clear })}
					<button
						type="button"
						class="banto-btn banto-btn--secondary banto-btn--sm"
						onclick={() => markExpress(ids, clear)}
					>
						{m['uiDemo.gridDate.bulkExpress']()}
					</button>
				{/snippet}
			</BantoGrid>
		</div>
	</SurfaceCard>

	<!-- Last on the page on purpose: the cards above keep their place, so the
	     open-calendar screenshots of the simple pickers do not move. -->
	<!-- [scaffold:touch-keys] begin -->
	<SurfaceCard title="TouchKeysHost" description={m['uiDemo.touchKeys.desc']()}>
		<div class="stack" data-testid="ui-demo-touch-keys" bind:this={touchKeysCard}>
			<label class="banto-switch-field">
				<input
					type="checkbox"
					role="switch"
					class="banto-switch"
					data-testid="ui-demo-touch-keys-enabled"
					bind:checked={touchKeysOn}
				/>
				{m['uiDemo.touchKeys.enabled']()}
			</label>
			<div class="grid">
				<div class="sample">
					<label class="caption" for="ui-demo-touch-qty">{m['uiDemo.touchKeys.number']()}</label>
					<input
						id="ui-demo-touch-qty"
						class="banto-input"
						type="number"
						min="0"
						max="999"
						bind:value={touchQty}
					/>
					<span class="caption" data-testid="ui-demo-touch-qty-value">
						{m['uiDemo.date.value']()}: {touchQty}
					</span>
				</div>
				<div class="sample">
					<label class="caption" for="ui-demo-touch-lot">{m['uiDemo.touchKeys.alnum']()}</label>
					<input
						id="ui-demo-touch-lot"
						maxlength="12"
						class="banto-input"
						type="text"
						autocomplete="off"
						bind:value={touchLot}
						{@attach touchKeys({ kind: 'text', layouts: ['alnum'] })}
					/>
					<span class="caption" data-testid="ui-demo-touch-lot-value">
						{m['uiDemo.date.value']()}: {touchLot}
					</span>
				</div>
				<div class="sample">
					<label class="caption" for="ui-demo-touch-kana">{m['uiDemo.touchKeys.kana']()}</label>
					<input
						id="ui-demo-touch-kana"
						maxlength="12"
						class="banto-input"
						type="text"
						autocomplete="off"
						bind:value={touchKana}
						{@attach touchKeys({ kind: 'text', layouts: ['kana', 'alnum'] })}
					/>
					<span class="caption" data-testid="ui-demo-touch-kana-value">
						{m['uiDemo.date.value']()}: {touchKana}
					</span>
				</div>
				<div class="sample">
					<label class="caption" for="ui-demo-touch-password">
						{m['uiDemo.touchKeys.password']()}
					</label>
					<!-- The value itself is never shown: only its length (design §5.5). -->
					<!-- The eye button shows the typed value in the box itself (#944); the keys stay masked
					     until the box is reopened as a plain text box (touch-keys recipe). -->
					<PasswordInput
						id="ui-demo-touch-password"
						autocomplete="off"
						bind:value={touchPassword}
						messages={passwordInputMessages()}
					/>
					<span class="caption" data-testid="ui-demo-touch-password-length">
						{m['uiDemo.touchKeys.passwordLength']()}: {touchPassword.length}
					</span>
				</div>
			</div>
			<span class="caption">{m['uiDemo.touchKeys.gridCaption']()}</span>
			<div class="grid-sample" data-testid="ui-demo-touch-keys-grid">
				<BantoGrid
					rows={touchPicks}
					columns={touchPickColumns}
					getRowId={(row) => row.code}
					onCellEdit={saveTouchPick}
					messages={gridMessages()}
				/>
			</div>
		</div>
		<TouchKeysHost
			enabled={touchKeysOn}
			messages={touchKeysMessagesText}
			resolve={touchKeysResolve}
			onconfirm={touchKeysConfirm}
		/>
	</SurfaceCard>
	<!-- [scaffold:touch-keys] end -->
	<SurfaceCard title="DatePicker / DateRangePicker" description={m['uiDemo.picker.desc']()}>
		<div class="grid">
			<div class="sample">
				<label class="caption" for="ui-demo-booking-date">{m['uiDemo.picker.dateLabel']()}</label>
				<DatePicker
					id="ui-demo-booking-date"
					bind:value={bookingDate}
					locale={getLocale()}
					messages={dateMessages}
				/>
				<span class="caption" data-testid="ui-demo-booking-date-value">
					{m['uiDemo.date.value']()}: {bookingDate ?? m['uiDemo.date.empty']()}
				</span>
			</div>
			<div class="sample">
				<span class="caption" id="ui-demo-lodging-label">{m['uiDemo.picker.rangeLabel']()}</span>
				<DateRangePicker
					id="ui-demo-lodging"
					labelledBy="ui-demo-lodging-label"
					bind:value={lodgingRange}
					locale={getLocale()}
					messages={dateRangePickerMessagesText}
				/>
				<span class="caption" data-testid="ui-demo-lodging-value">
					{m['uiDemo.date.value']()}: {lodgingRange.from ?? m['uiDemo.date.empty']()} – {lodgingRange.to ??
						m['uiDemo.date.empty']()}
				</span>
			</div>
		</div>
	</SurfaceCard>
</div>

<!-- Outside the cards: under the glass preset SurfaceCard has a
     backdrop-filter, which would make it the containing block of the
     palette's (and the Modal / Drawer's) fixed overlay. -->
<Modal
	open={modalOpen}
	title={m['uiDemo.overlay.modalTitle']()}
	messages={overlayMessages}
	onclose={() => {
		modalOpen = false;
		overlayClosed += 1;
	}}
>
	<div class="stack">
		<p class="body-text">{m['uiDemo.overlay.modalBody']()}</p>
		<div class="field">
			<label class="caption" for="ui-demo-modal-date">{m['uiDemo.overlay.modalDate']()}</label>
			<DateInput
				id="ui-demo-modal-date"
				bind:value={modalDate}
				locale={getLocale()}
				messages={dateMessages}
			/>
		</div>
	</div>
</Modal>

<Drawer
	open={drawerOpen}
	title={m['uiDemo.overlay.drawerTitle']()}
	messages={overlayMessages}
	dirty={drawerNote !== ''}
	onBlockedClose={() => toastStore.push('info', m['uiDemo.overlay.blocked']())}
	onclose={closeDrawer}
>
	<div class="stack">
		<p class="body-text">{m['uiDemo.overlay.drawerBody']()}</p>
		<label class="field">
			<span class="caption">{m['uiDemo.overlay.drawerField']()}</span>
			<input class="banto-input" data-testid="ui-demo-drawer-note" bind:value={drawerNote} />
		</label>
		<div class="row">
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				data-testid="ui-demo-open-nested"
				onclick={() => (nestedOpen = true)}
			>
				{m['uiDemo.overlay.openNested']()}
			</button>
		</div>
	</div>
	<!-- Rendered inside the drawer's body on purpose: a nested layer with its
	     own z-index is "above" its parent (@banto/ui layering.ts). -->
	<Modal
		open={nestedOpen}
		title={m['uiDemo.overlay.nestedTitle']()}
		messages={overlayMessages}
		onclose={() => (nestedOpen = false)}
	>
		<p class="body-text">{m['uiDemo.overlay.nestedBody']()}</p>
	</Modal>
</Drawer>

<CommandPalette
	bind:open={paletteOpen}
	items={paletteItems}
	onExecute={(item) => {
		executed = item.title;
	}}
	messages={{
		commandPaletteLabel: () => m['uiDemo.palette.label'](),
		commandPalettePlaceholder: () => m['commandPalette.placeholder'](),
		commandPaletteListLabel: () => m['commandPalette.listLabel'](),
		commandPaletteEmpty: () => m['commandPalette.empty']()
	}}
/>

<style>
	/* The frame decides narrow by its own width: the box's corner narrows it. */
	.three-pane-box {
		height: 16rem;
		min-width: 12rem;
		max-width: 100%;
		overflow: hidden;
		resize: horizontal;
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.three-pane-list {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		margin: 0;
		padding: var(--banto-space-2);
		list-style: none;
	}

	.three-pane-text {
		margin: 0;
		padding: var(--banto-space-3);
	}

	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr));
		gap: var(--banto-space-4);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-3);
	}

	.row--spaced {
		margin-top: var(--banto-space-3);
	}

	.context-area {
		padding: var(--banto-space-3) var(--banto-space-4);
		border: var(--banto-border-width) dashed var(--banto-border);
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text-muted);
		font: inherit;
	}

	.sample {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
		min-width: 0;
	}

	/* The grid sample's frame (a part's shape, conventions §9): the grid
	   scrolls inside a fixed height; three rows and the header fit. */
	.grid-sample {
		height: 12rem;
	}

	.sample--frame {
		padding: var(--banto-space-3);
		border: var(--banto-border-width) dashed var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
	}

	.caption {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	/* HeaderNav samples: a header-like row (a part's shape, conventions §9);
	   the narrow one is cut short so entries move into "more". */
	.header-nav-frame {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		height: var(--banto-shell-header-height);
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface);
	}

	.header-nav-frame--narrow {
		max-width: 18rem;
	}

	.body-text {
		margin: 0;
		font-size: var(--banto-font-size-md);
	}

	/* Samples must not claim the page-level view-transition name (see the
	   comment above the PageHeader samples). */
	.samples-header :global(.page-header) {
		view-transition-name: none;
	}
</style>
