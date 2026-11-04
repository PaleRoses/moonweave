import type {GraphPatch, NodeValuePatch, StylePatch} from '@moonweave/surfaces/core';

type Patch = NodeValuePatch & {style?: StylePatch};
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
}
function mergeFields<A extends object, B extends object>(previous: A, next: B): A & B {
  return Object.entries(next).every(([key, value]) => Object.hasOwn(previous, key) && sameValue((previous as Record<string, unknown>)[key], value))
    ? previous as A & B : {...previous, ...next};
}
/** Last value per node/field wins; independent controls in one frame compose. */
export function mergeValueChanges<T extends object>(previous: T, next: NodeValuePatch): T & NodeValuePatch {
  if (!record(previous) || !record(next)) return next as T & NodeValuePatch;
  const a = (previous as Patch).style, b = (next as Patch).style;
  if (record(a) && record(b)) {
    const style = mergeFields(a, b);
    return mergeFields(previous, {...next, style});
  }
  return mergeFields(previous, next);
}
/** Share the same patch composition for pending frames and accepted gestures. */
export function mergeGraphChanges(previous: GraphPatch, next: GraphPatch): GraphPatch {
  let merged = previous;
  for (const [id, patch] of Object.entries(next)) {
    const current = Object.hasOwn(previous, id) ? previous[id] : undefined;
    const value = mergeValueChanges(current ?? {}, patch);
    if (value !== current) {
      if (merged === previous) merged = {...previous};
      Object.defineProperty(merged, id, {value, enumerable: true, configurable: true, writable: true});
    }
  }
  return merged;
}
/** Read only submitted fields from a validated node; keep normalized values sparse. */
export function readValueChanges<T extends object>(fields: T, node: object): T {
  const values = node as Record<string, unknown>;
  return Object.fromEntries(Object.entries(fields).map(([key, value]) =>
    [key, record(value) ? readValueChanges(value, values[key] as object) : values[key]],
  )) as T;
}

export interface FrameBatchOptions {
  request?: (callback: FrameRequestCallback) => number;
  cancel?: (id: number) => void;
  scheduled?: () => void;
}

export function createFrameBatch(commit: (changes: GraphPatch) => boolean | void, {
  request = requestAnimationFrame, cancel = cancelAnimationFrame, scheduled = () => {},
}: FrameBatchOptions = {}) {
  let pending: GraphPatch = {}, frame: number | null = null;
  function flush(): boolean | void {
    if (frame !== null) cancel(frame);
    frame = null;
    if (!Object.keys(pending).length) return;
    const changes = pending;
    pending = {};
    return commit(changes);
  }
  return Object.freeze({
    queue(changes: GraphPatch) {
      const next = mergeGraphChanges(pending, changes);
      if (next === pending) return;
      pending = next;
      if (frame === null) { frame = request(flush); scheduled(); }
    },
    value<T extends object>(id: string, node: T): T { return Object.hasOwn(pending, id) ? mergeValueChanges(node, pending[id]) : node; },
    flush,
    dispose() { if (frame !== null) cancel(frame); frame = null; pending = {}; },
  });
}
