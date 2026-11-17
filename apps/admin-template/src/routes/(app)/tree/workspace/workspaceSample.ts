/**
 * `/tree/workspace` の見本データ（削除可能）。`/tree` デモの treeSample.ts と同じ扱いで、
 * 実アプリでは DataProvider から供給する想定の置き換え対象。ライン > 設備の 2 階層と、
 * 設備ごとの点検記録・設定。ラベルは見本データなので日本語直書きでよい（`raw-jp-in-app` は
 * `.svelte` だけが対象）。画面の装飾文言は Paraglide。
 */
import type { TreeNode } from '@banto/tree-svelte';

export type WorkspaceResult = 'ok' | 'warn' | 'ng';

export interface WorkspaceRow {
	id: string;
	/** 行の出どころの設備（ラインを選んだときに区別できる）。 */
	equipmentLabel: string;
	at: string;
	item: string;
	value: string;
	result: WorkspaceResult;
}

export interface WorkspaceSettings {
	displayName: string;
	threshold: number;
	notify: boolean;
}

export interface WorkspaceNodeData {
	kind: 'line' | 'equipment';
}

interface Equipment {
	id: string;
	label: string;
	rows: [at: string, item: string, value: string, result: WorkspaceResult][];
}

interface Line {
	id: string;
	label: string;
	equipment: Equipment[];
}

const LINES: Line[] = [
	{
		id: 'line-a',
		label: '第1ライン',
		equipment: [
			{
				id: 'line-a-press',
				label: 'プレス機',
				rows: [
					['09:00', '油圧', '21.4 MPa', 'ok'],
					['10:00', '油温', '48 ℃', 'ok'],
					['11:00', '振動', '3.9 mm/s', 'warn'],
					['12:00', 'ストローク', '120 mm', 'ok']
				]
			},
			{
				id: 'line-a-weld',
				label: '溶接機',
				rows: [
					['09:10', '電流', '182 A', 'ok'],
					['10:10', 'ワイヤ残量', '12 %', 'warn']
				]
			},
			{
				id: 'line-a-paint',
				label: '塗装炉',
				rows: [
					['09:20', '炉内温度', '181 ℃', 'ok'],
					['10:20', '炉内温度', '199 ℃', 'ng'],
					['11:20', '排気風量', '8.2 m3/min', 'ok']
				]
			}
		]
	},
	{
		id: 'line-b',
		label: '第2ライン',
		equipment: [
			{
				id: 'line-b-cnc',
				label: 'CNC 旋盤',
				rows: [
					['09:30', '主軸回転', '3200 rpm', 'ok'],
					['10:30', '切削油', '64 %', 'ok'],
					['11:30', '主軸温度', '58 ℃', 'warn']
				]
			},
			{
				id: 'line-b-robot',
				label: '搬送ロボット',
				rows: [['09:40', 'バッテリー', '71 %', 'ok']]
			}
		]
	}
];

function rowsOf(equipment: Equipment): WorkspaceRow[] {
	return equipment.rows.map(([at, item, value, result], index) => ({
		id: `${equipment.id}-${index + 1}`,
		equipmentLabel: equipment.label,
		at,
		item,
		value,
		result
	}));
}

/** ツリーの見本（2 階層）。 */
export const workspaceNodes: TreeNode<WorkspaceNodeData>[] = LINES.map((line) => ({
	id: line.id,
	label: line.label,
	data: { kind: 'line' },
	children: line.equipment.map((equipment) => ({
		id: equipment.id,
		label: equipment.label,
		data: { kind: 'equipment' }
	}))
}));

const equipmentById = new Map(LINES.flatMap((line) => line.equipment).map((e) => [e.id, e]));
const lineById = new Map(LINES.map((line) => [line.id, line]));

/** 対象の表示名（ツリーのラベル）。 */
export function targetLabel(id: string): string | null {
	return equipmentById.get(id)?.label ?? lineById.get(id)?.label ?? null;
}

export function hasWorkspaceTarget(id: string): boolean {
	return equipmentById.has(id) || lineById.has(id);
}

/** 対象の点検記録。ラインは配下の設備すべて、設備は自分の分。 */
export function workspaceRows(targetId: string): WorkspaceRow[] {
	const equipment = equipmentById.get(targetId);
	if (equipment) return rowsOf(equipment);
	const line = lineById.get(targetId);
	return line ? line.equipment.flatMap(rowsOf) : [];
}

export function hasWorkspaceRow(targetId: string, rowId: string): boolean {
	return workspaceRows(targetId).some((row) => row.id === rowId);
}

export function findWorkspaceRow(targetId: string, rowId: string): WorkspaceRow | null {
	return workspaceRows(targetId).find((row) => row.id === rowId) ?? null;
}

/** ツリーのバッジに出す件数と最悪の判定。 */
export function targetSummary(targetId: string): { count: number; worst: WorkspaceResult } {
	const rows = workspaceRows(targetId);
	const worst: WorkspaceResult = rows.some((r) => r.result === 'ng')
		? 'ng'
		: rows.some((r) => r.result === 'warn')
			? 'warn'
			: 'ok';
	return { count: rows.length, worst };
}

/** 対象の保存済み設定の初期値。 */
export function initialSettings(targetId: string): WorkspaceSettings {
	return {
		displayName: targetLabel(targetId) ?? '',
		threshold: lineById.has(targetId) ? 80 : 60,
		notify: true
	};
}

export function settingsEqual(a: WorkspaceSettings, b: WorkspaceSettings): boolean {
	return a.displayName === b.displayName && a.threshold === b.threshold && a.notify === b.notify;
}
