import {inverseLinear, nodeType} from './algebra.mts';
import type {GraphNode, GraphNodeOf, NodeKindOf, ImageResource} from './algebra.mts';
import {imageChannelRange} from './resources.mts';

type Range = readonly [number, number];
type RangeNode = Extract<GraphNode, {kind: NodeKindOf<'scalar' | 'surface'>}>;
interface RangeInputs {
  a?: Range;
  b?: Range;
  x?: Range;
  mask?: Range;
  image?: ImageResource;
}

/** One latest result per compiled slot, owned by that topology's compiler. */
export type AnalysisEntry =
  | ({kind: 'range'; key: GraphNode | number | boolean; result: Range} & RangeInputs)
  | {kind: 'domain'; key: GraphNodeOf<'transform'>; input?: readonly number[]; result: readonly number[]};

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (x: number, low: number, high: number) => {
  const t = clamp((x - low) / (high - low));
  return t * t * (3 - 2 * t);
};

/** Analyze one scalar interval or surface opacity; ports have already been sorted. */
function interval(node: RangeNode, {a, b, x, mask, image}: RangeInputs): Range {
  switch (node.kind) {
    case 'imageScalar': {
      const range = imageChannelRange(image!, node.channel);
      return node.address === 'zero' ? [Math.min(0, range[0]), Math.max(0, range[1])] : range;
    }
    case 'constant': case 'parameter': return [node.value, node.value];
    case 'axis': return [-Infinity, Infinity];
    case 'facing': return [node.absolute ? 0 : -1, 1];
    case 'noise': return [0, 1];
    case 'ramp': return [smooth(x![0], node.low, node.high), smooth(x![1], node.low, node.high)];
    case 'complement': return [1 - x![1], 1 - x![0]];
    case 'add': {
      const lo = a![0] + b![0], hi = a![1] + b![1];
      return [Number.isNaN(lo) ? -Infinity : lo, Number.isNaN(hi) ? Infinity : hi];
    }
    case 'multiply': {
      const product = (left: number, right: number) => left === 0 || right === 0 ? 0 : left * right;
      const products = [
        product(a![0], b![0]), product(a![0], b![1]),
        product(a![1], b![0]), product(a![1], b![1]),
      ];
      return [Math.min(...products), Math.max(...products)];
    }
    case 'paint': return [node.style.opacity, node.style.opacity];
    case 'material': return [1, 1];
    case 'mix': {
      const weight = mask!.map(clamp);
      const lower = weight.map(w => (1 - w) * a![0] + w * b![0]);
      const upper = weight.map(w => (1 - w) * a![1] + w * b![1]);
      return [Math.min(...lower), Math.max(...upper)];
    }
    case 'channels': return node.values.opacity ? [clamp(mask![0]), clamp(mask![1])] : x!;
    case 'deposit': {
      if (node.opacity === undefined) return x!;
      const [low, high] = b!.map(clamp);
      const over = (value: number, coverage: number, prior: number) => Math.max(0, Math.min(coverage, value)) + (1 - coverage) * prior;
      // Monotone in value/prior; piecewise linear in coverage, with its only
      // interior maximum where coverage reaches the associated opacity.
      return [Math.min(over(a![0], low, x![0]), over(a![0], high, x![0])),
        Math.max(over(a![1], low, x![1]), over(a![1], high, x![1]),
          over(a![1], Math.max(low, Math.min(high, a![1])), x![1]))];
    }
    case 'relief': case 'bump': case 'coat': return x!;
  }
}

/**
 * Validate domain chains and derive scalar/opacity ranges in topological order.
 * The caller supplies a fixed-slot memo: an edit replaces its entry, so this
 * module owns no registry, invalidation protocol or chain of graph revisions.
 */
export function analyzeGraph(nodes: readonly GraphNode[], output: string, cache: (AnalysisEntry | undefined)[]) {
  const ranges: Record<string, Range> = {};
  const results: Record<string, Range> = Object.create(null);
  const matrices: Record<string, readonly number[]> = Object.create(null);
  const images: Record<string, ImageResource> = Object.create(null);
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index], previous = cache[index];
    switch (node.kind) {
      case 'facets': case 'color': case 'colorMix': case 'colorAdjust': case 'colorRamp': case 'imageColor': continue;
      case 'image':
        images[node.id] = node.resource;
        continue;
      case 'transform': {
        const input = node.input ? matrices[node.input] : undefined;
        if (previous?.kind === 'domain' && previous.key === node && previous.input === input) {
          matrices[node.id] = previous.result;
          continue;
        }
        let matrix = node.matrix;
        if (input) {
          matrix = Array.from({length: 16}, (_, index) => {
            const row = index % 4, column = Math.floor(index / 4);
            return [0, 1, 2, 3].reduce((sum, k) => sum + node.matrix[k * 4 + row] * input[column * 4 + k], 0);
          });
        }
        const rounded = matrix.map(Math.fround);
        if (!rounded.every(Number.isFinite)) {
          throw new RangeError(`Composed domain ${node.id} exceeds float32 range.`);
        }
        try {
          inverseLinear(rounded);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new RangeError(`Composed domain ${node.id} is not safely invertible: ${reason}`);
        }
        matrices[node.id] = matrix;
        cache[index] = {kind: 'domain', key: node, input, result: matrix};
        continue;
      }
    }
    const a = 'a' in node ? results[node.a] : node.kind === 'deposit' && node.opacity !== undefined ? results[node.opacity] : undefined;
    const b = 'b' in node ? results[node.b] : node.kind === 'deposit' && node.opacityMask !== undefined ? results[node.opacityMask] : undefined;
    const x = 'input' in node ? results[node.input] : undefined;
    const image = node.kind === 'imageScalar' ? images[node.image] : undefined;
    const mask = 'mask' in node && node.kind !== 'deposit' ? results[node.mask]
      : node.kind === 'channels' && node.values.opacity ? results[node.values.opacity] : undefined;
    // Only opacity affects a paint's range; only its structural mode affects facing.
    const key = node.kind === 'paint' ? node.style.opacity : node.kind === 'facing' ? node.absolute : node;
    let result: Range;
    if (previous?.kind === 'range' && previous.key === key
        && previous.a === a && previous.b === b && previous.x === x
        && previous.mask === mask && previous.image === image) {
      result = previous.result;
    } else {
      result = interval(node, {a, b, x, mask, image});
      if (nodeType(node) === 'scalar'
          && (result.some(value => Number.isFinite(value) && !Number.isFinite(Math.fround(value)))
            || ((node.kind === 'add' || node.kind === 'multiply')
              && [...a!, ...b!].every(Number.isFinite) && !result.every(Number.isFinite)))) {
        throw new RangeError(`Scalar ${node.id} exceeds the float32 range.`);
      }
      // One latest entry per canonical slot, with no previous graph or plan chain.
      cache[index] = {kind: 'range', key, a, b, x, mask, image, result};
    }
    results[node.id] = result;
    if (nodeType(node) === 'scalar') ranges[node.id] = result;
  }
  return {ranges, opacityRange: results[output]};
}
