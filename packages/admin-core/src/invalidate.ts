/**
 * Tiny per-resource event bus so composables can invalidate cached
 * list/form state after mutations (spec §3.4).
 */
type Callback = () => void;

const subscribers = new Map<string, Set<Callback>>();

/** Subscribe to invalidation of `resource`. Returns an unsubscribe function. */
export function onInvalidate(resource: string, cb: Callback): () => void {
	let set = subscribers.get(resource);
	if (!set) {
		set = new Set();
		subscribers.set(resource, set);
	}
	set.add(cb);
	return () => {
		set.delete(cb);
		if (set.size === 0) subscribers.delete(resource);
	};
}

/** Notify all subscribers of `resource` (e.g. after a create/update/delete). */
export function invalidate(resource: string): void {
	subscribers.get(resource)?.forEach((cb) => cb());
}
