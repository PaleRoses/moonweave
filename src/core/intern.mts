import {SURFACE_SIGNATURE} from './algebra.mts';
import type {NodeKind, NodeLike} from './algebra.mts';

const keys = Object.fromEntries(Object.entries(SURFACE_SIGNATURE).map(([kind, definition]) => [
  kind, definition.values.keys.length ? undefined : definition.keys.filter(key => key !== 'id'),
])) as Readonly<Record<NodeKind, readonly string[] | undefined>>;
type PortKind = (typeof SURFACE_SIGNATURE)[NodeKind]['portEntries'][number][1]['kind'];
const ports = Object.fromEntries(Object.entries(SURFACE_SIGNATURE).map(([kind, definition]) => [
  kind, Object.fromEntries(definition.portEntries.map(([key, port]) => [key, port.kind])),
])) as Readonly<Record<NodeKind, Readonly<Partial<Record<string, PortKind>>>>>;

/** Exact key for normalized structure. Editable source identities never merge. */
export function structuralKey(node: NodeLike, reference?: (id: string) => string | number): string | undefined {
  const fields = keys[node.kind];
  if (!fields) return undefined;
  if (!reference) return JSON.stringify(fields.map(key => node[key]));
  const inputs = ports[node.kind];
  return JSON.stringify(fields.map(key => {
    const value = node[key];
    if (value === undefined) return value;
    switch (inputs[key]) {
      case 'input': return reference(value as string);
      case 'record': return Object.fromEntries(Object.entries(value as Readonly<Record<string, string>>)
        .map(([member, id]) => [member, reference(id)]));
      case 'list': return (value as readonly string[]).map(reference);
      default: return value;
    }
  }));
}
