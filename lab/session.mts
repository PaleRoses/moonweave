import {GRAPH_LIMITS, materialGraph} from '@moonweave/surfaces/core';
import type {MaterialGraph} from '@moonweave/surfaces/core';
import type {EditorSession} from './editor';

export const SESSION_KEY = 'moonweave.atelier.session';
const SESSION_LIMIT = GRAPH_LIMITS.jsonBytes * 3 + 2048;
export type SaveStatus = 'idle' | 'pending' | 'saved' | 'unavailable';
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;

export function encodeSession(session: EditorSession): string {
  const originals = new Map(session.baseline.nodes.map(node => [node.id, node]));
  const graph = session.graph === session.baseline ? null : {
    ...session.graph,
    nodes: session.graph.nodes.map(node => originals.get(node.id) === node ? node.id : node),
  };
  const source = JSON.stringify({...session, version: 2, graph});
  if (source.length > SESSION_LIMIT) throw new RangeError('Session is too large to save.');
  return source;
}

/** A reference borrows one owned baseline node; the normal graph decoder validates the result. */
function restoreCurrentGraph(value: unknown, baseline: MaterialGraph): MaterialGraph {
  if (value === null) return baseline;
  if (!value || typeof value !== 'object' || !('nodes' in value) || !Array.isArray(value.nodes)) {
    throw new TypeError('Saved graph is invalid.');
  }
  if (value.nodes.length > GRAPH_LIMITS.nodes) throw new RangeError('Saved graph exceeds the node limit.');
  const originals = new Map(baseline.nodes.map(node => [node.id, node]));
  const nodes = value.nodes.map((node: unknown) => {
    if (typeof node !== 'string') return node;
    const original = originals.get(node);
    if (!original) throw new TypeError(`Saved graph references an unknown baseline node: ${node}.`);
    return original;
  });
  return materialGraph({...value, nodes});
}

export function decodeSession(source: string, accept: (graph: MaterialGraph) => void = () => {}): EditorSession {
  if (source.length > SESSION_LIMIT) throw new RangeError('Saved session is too large.');
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== 'object' || !('version' in value) || (value.version !== 1 && value.version !== 2)) {
    throw new TypeError('Saved session has an unsupported format.');
  }
  const data = value as Record<string, unknown>;
  // The graph decoder validates persisted JSON before it becomes editor state.
  let graph: MaterialGraph, baseline: MaterialGraph;
  if (data.version === 1) {
    graph = materialGraph(data.graph);
    baseline = data.baseline === null ? graph : materialGraph(data.baseline);
    if (baseline !== graph) {
      // Version 1 copied both documents. Recover unchanged same-ID records once
      // after normalization; distinct IDs and changed values stay independent.
      const originals = new Map(baseline.nodes.map(node => [node.id, node]));
      const nodes = graph.nodes.map(node => {
        const original = originals.get(node.id);
        return original && JSON.stringify(node) === JSON.stringify(original) ? original : node;
      });
      graph = materialGraph({...graph, nodes});
    }
  } else {
    baseline = materialGraph(data.baseline);
    graph = restoreCurrentGraph(data.graph, baseline);
  }
  accept(graph);
  if (baseline !== graph) accept(baseline);
  if (data.sourceDraft !== null && typeof data.sourceDraft !== 'string') {
    throw new TypeError('Saved source draft is invalid.');
  }
  return {
    graph, baseline,
    selectedPaint: typeof data.selectedPaint === 'string' ? data.selectedPaint : null,
    selectedBlend: typeof data.selectedBlend === 'string' ? data.selectedBlend : null,
    tab: data.tab === 'paint' ? 'paint' : 'compose',
    sourceDraft: data.sourceDraft,
    sourceOpen: data.sourceOpen === true,
  };
}

interface SessionOptions {
  storage?: () => StoragePort;
  accept?: (graph: MaterialGraph) => void;
  request?: (save: () => void) => number;
  cancel?: (id: number) => void;
  status?: (status: SaveStatus) => void;
}

/** Keep immutable references while editing; serialization happens only at a save boundary. */
export function createSessionStore({
  storage = () => localStorage, accept,
  request = save => window.setTimeout(save, 400), cancel = id => window.clearTimeout(id),
  status = () => {},
}: SessionOptions = {}) {
  let pending: EditorSession | null = null, timer: number | null = null, closed = false;
  function flush(): boolean {
    if (timer !== null) { cancel(timer); timer = null; }
    if (!pending) return true;
    try {
      const source = encodeSession(pending);
      storage().setItem(SESSION_KEY, source);
      pending = null; status('saved'); return true;
    } catch { status('unavailable'); return false; }
  }
  return {
    load(): EditorSession | undefined {
      try {
        const source = storage().getItem(SESSION_KEY);
        if (source === null) return;
        const session = decodeSession(source, accept);
        status('saved'); return session;
      } catch { status('unavailable'); return; }
    },
    schedule(session: EditorSession) {
      if (closed) return;
      pending = session;
      if (timer !== null) cancel(timer);
      timer = request(flush); status('pending');
    },
    flush,
    dispose() { flush(); closed = true; pending = null; },
  };
}
