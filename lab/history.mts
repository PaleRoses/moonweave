import type {MaterialGraph} from '@moonweave/surfaces/core';

export interface DocumentSnapshot {
  readonly graph: MaterialGraph;
  readonly baseline: MaterialGraph;
  readonly selectedPaint: string | null;
  readonly selectedBlend: string | null;
}
export interface HistoryEntry {
  readonly before: DocumentSnapshot;
  readonly after: DocumentSnapshot;
  readonly label: string;
}
export interface DocumentHistory {
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
}
export const EMPTY_HISTORY: DocumentHistory = {past: [], future: []};
const HISTORY_LIMIT = 100;

/** Graphs share immutable nodes; history never serializes or clones their contents. */
export function recordHistory(history: DocumentHistory, before: DocumentSnapshot, after: DocumentSnapshot, label: string): DocumentHistory {
  if (before.graph === after.graph && before.baseline === after.baseline) return history;
  return {past: [...history.past.slice(-(HISTORY_LIMIT - 1)), {before, after, label}], future: []};
}

export function stepHistory(history: DocumentHistory, direction: 'undo' | 'redo'): {history: DocumentHistory; document: DocumentSnapshot} | null {
  const source = direction === 'undo' ? history.past : history.future;
  const entry = source.at(-1);
  if (!entry) return null;
  return direction === 'undo'
    ? {history: {past: history.past.slice(0, -1), future: [...history.future, entry]}, document: entry.before}
    : {history: {past: [...history.past, entry], future: history.future.slice(0, -1)}, document: entry.after};
}
