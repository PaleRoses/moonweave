import type {ExpressionGraph} from './types.mts';

const INLINE_COMPONENTS = 16;
const COMPONENTS_PER_ROW = 64;

/**
 * Pretty structural JSON with bounded numeric rows. Resources keep every sample;
 * vectors stay inline, while image payloads avoid one editor line per component.
 * The caller owns validation. Keys and scalar values use standard JSON encoding.
 */
export function graphJSON(graph: ExpressionGraph): string {
  function write(value: unknown, indentation: string): string {
    const nested = indentation + '  ';
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      if (!items.length) return '[]';
      if (items.every(item => typeof item === 'number')) {
        if (items.length <= INLINE_COMPONENTS) return `[${items.map(item => JSON.stringify(item)).join(', ')}]`;
        const rows: string[] = [];
        for (let offset = 0; offset < items.length; offset += COMPONENTS_PER_ROW) {
          rows.push(nested + items.slice(offset, offset + COMPONENTS_PER_ROW).map(item => JSON.stringify(item)).join(', '));
        }
        return `[\n${rows.join(',\n')}\n${indentation}]`;
      }
      return `[\n${items.map(item => nested + write(item, nested)).join(',\n')}\n${indentation}]`;
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Readonly<Record<string, unknown>>).filter(([, item]) => item !== undefined);
      if (!entries.length) return '{}';
      return `{\n${entries.map(([key, item]) => `${nested}${JSON.stringify(key)}: ${write(item, nested)}`).join(',\n')}\n${indentation}}`;
    }
    return JSON.stringify(value);
  }
  return write(graph, '') + '\n';
}
