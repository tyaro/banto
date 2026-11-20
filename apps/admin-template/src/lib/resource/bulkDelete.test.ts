import { describe, expect, it } from 'vitest';
import { runBulkDelete } from './bulkDelete';

describe('runBulkDelete', () => {
	it('deletes the ids one after another, never in parallel', async () => {
		const log: string[] = [];
		let running = 0;
		let maxRunning = 0;
		const result = await runBulkDelete([1, 2, 3], async (id) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			log.push(`start ${id}`);
			await new Promise((resolve) => setTimeout(resolve, 1));
			log.push(`end ${id}`);
			running--;
		});
		expect(maxRunning).toBe(1);
		expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
		expect(result).toEqual({ deleted: [1, 2, 3], failed: [] });
	});

	it('keeps going after a failure and reports the failed ids', async () => {
		const tried: number[] = [];
		const result = await runBulkDelete([1, 2, 3, 4], async (id) => {
			tried.push(id as number);
			if (id === 2 || id === 4) throw new Error('denied');
		});
		expect(tried).toEqual([1, 2, 3, 4]);
		expect(result).toEqual({ deleted: [1, 3], failed: [2, 4] });
	});

	it('reports everything as failed when every delete fails', async () => {
		const result = await runBulkDelete([1, 2], () => Promise.reject(new Error('x')));
		expect(result).toEqual({ deleted: [], failed: [1, 2] });
	});

	it('processes a duplicate id once and handles an empty list', async () => {
		const tried: number[] = [];
		const result = await runBulkDelete([5, 5], async (id) => void tried.push(id as number));
		expect(tried).toEqual([5]);
		expect(result.deleted).toEqual([5]);
		expect(await runBulkDelete([], async () => {})).toEqual({ deleted: [], failed: [] });
	});
});
