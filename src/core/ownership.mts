// A construction proof shared by expression, recipe and resource boundaries.
// Frozen caller objects are still copied; only values owned here are borrowed.
const owned = new WeakSet<object>();

export const isOwned = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && owned.has(value);

/** Register a boundary-created, deeply immutable value without copying it. */
export function ownFrozen<T extends object>(value: T): T {
  owned.add(value);
  return value;
}

/** Snapshot one authoring value, preserving sharing across all of its roots. */
export function ownValue<T>(value: T): T {
  const snapshots = new Map<object, object>();
  function snapshot(value: unknown): unknown {
    if (!value || typeof value !== 'object' || owned.has(value)) return value;
    if (snapshots.has(value)) return snapshots.get(value);
    // Missing trailing elements must not turn malformed tuples into valid ones.
    const copy = (Array.isArray(value) ? new Array(value.length) : {}) as Record<string, unknown>;
    snapshots.set(value, copy);
    for (const [key, item] of Object.entries(value)) copy[key] = snapshot(item);
    return copy;
  }
  const result = snapshot(value) as T;
  for (const copy of snapshots.values()) ownFrozen(Object.freeze(copy));
  return result;
}
