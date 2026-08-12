/**
 * デモ用のサンプルツリーデータ（`/tree` ページ専用、削除可能）。
 *
 * items の 1 万件シードと同じ扱いの「見本データ」= 実アプリでは DataProvider
 * から供給する想定なので、ラベルは日本語直書きでよい（生日本語の禁止は app 層
 * の `.svelte` のみが対象。`scripts/verify-architecture.mjs` の `raw-jp-in-app`
 * は `.svelte` だけを走査する）。ツリーの「装飾文言」（見出し・ヒント・列見出し）
 * は `+page.svelte` 側で Paraglide 経由に持つ。
 *
 * `@banto/tree-svelte` の TreeNode をそのまま使う（依存は package.json に追加済み）。
 */
import type { TreeNode } from '@banto/tree-svelte';

/** ファイルエクスプローラ / tree-grid デモのノードが持つ payload。 */
export interface FileData {
	/** 種別。列の表示は locale 依存にするため意味キーで保持する。 */
	kind: 'folder' | 'file';
	/** ファイルサイズ（KB）。フォルダは持たない。 */
	size?: number;
}

/**
 * ファイル/フォルダ階層。エクスプローラ・複数選択・tree-grid の 3 デモで共有する
 * （同じ木を素の選択・チェックボックス・列付きで見せると差分が分かりやすい）。
 */
export const explorerTree: TreeNode<FileData>[] = [
	{
		id: 'project',
		label: 'プロジェクト',
		data: { kind: 'folder' },
		children: [
			{
				id: 'docs',
				label: 'ドキュメント',
				data: { kind: 'folder' },
				children: [
					{ id: 'spec', label: '仕様書.md', data: { kind: 'file', size: 12 } },
					{ id: 'design-memo', label: '設計メモ.md', data: { kind: 'file', size: 8 } }
				]
			},
			{
				id: 'src',
				label: 'ソース',
				data: { kind: 'folder' },
				children: [
					{ id: 'main', label: 'main.ts', data: { kind: 'file', size: 4 } },
					{
						id: 'utils',
						label: 'ユーティリティ',
						data: { kind: 'folder' },
						children: [
							{ id: 'format', label: 'format.ts', data: { kind: 'file', size: 2 } },
							{ id: 'tree', label: 'tree.ts', data: { kind: 'file', size: 6 } }
						]
					}
				]
			},
			{ id: 'readme', label: 'README.md', data: { kind: 'file', size: 3 } }
		]
	}
];

/** TreeSelect（カテゴリ選択入力）デモ用の組織ツリー。 */
export const categoryTree: TreeNode[] = [
	{
		id: 'org',
		label: '組織',
		children: [
			{
				id: 'sales',
				label: '営業部',
				children: [
					{ id: 'sales-domestic', label: '国内営業' },
					{ id: 'sales-global', label: '海外営業' }
				]
			},
			{
				id: 'dev',
				label: '開発部',
				children: [
					{ id: 'dev-frontend', label: 'フロントエンド' },
					{ id: 'dev-backend', label: 'バックエンド' }
				]
			},
			{
				id: 'admin',
				label: '管理部',
				children: [
					{ id: 'admin-general', label: '総務' },
					{ id: 'admin-finance', label: '経理' }
				]
			}
		]
	}
];

/** 遅延読み込みデモのルート（`hasChildren` の枝を初回展開で取得する）。 */
export const lazyRoots: TreeNode[] = [
	{ id: 'lazy-root', label: 'リモートカテゴリ', hasChildren: true }
];

/**
 * 遅延読み込みの子取得（デモ）。実アプリでは `dataProvider.list(...)` に置き換える。
 * ネットワーク往復を模すため固定遅延を挟む（`Math.random`/`Date.now` は使わない=
 * 決定性を保つ。遅延は `setTimeout` のみ）。
 */
const LAZY_CHILDREN: Record<string, TreeNode[]> = {
	'lazy-root': [
		{ id: 'electronic', label: '電子部品', hasChildren: true },
		{ id: 'mechanical', label: '機械部品', hasChildren: true },
		{ id: 'consumable', label: '消耗品' }
	],
	electronic: [
		{ id: 'resistor', label: '抵抗器' },
		{ id: 'capacitor', label: 'コンデンサ' }
	],
	mechanical: [
		{ id: 'bearing', label: 'ベアリング' },
		{ id: 'gear', label: 'ギア' }
	]
};

export function loadLazyChildren(node: TreeNode): Promise<TreeNode[]> {
	return new Promise((resolve) => {
		setTimeout(() => resolve(LAZY_CHILDREN[node.id] ?? []), 400);
	});
}
