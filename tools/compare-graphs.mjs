/**
 * Finite observational comparisons for optimizer experiments.
 *
 * Fields use the production CPU interpreter. Surface observations use the
 * compiled graph's unlit record operations and explicitly supplied opaque paint
 * records. They do not evaluate facets, lighting, framebuffer color or GPU
 * rounding. A matching finite suite is evidence, never an equivalence proof.
 */
import {
  SURFACE_SIGNATURE, expressionGraph, graphExpression, materialGraph,
  createFieldSampler, compileGraph, patchGraph, foldGraph,
} from '../src/core.mjs';
import {fieldAlgebra, sampleField} from '../src/core/field-evaluate.mts';

const finish = ['roughness', 'metalness', 'clearcoat', 'opacity'];
const clamp = value => Math.max(0, Math.min(1, value));
const mix = (a, b, weight) => a * (1 - weight) + b * weight;
const vectorMix = (a, b, weight) => a.map((value, index) => mix(value, b[index], weight));

function memo(read) {
  const point = state => {
    if (!state.values.has(point)) state.values.set(point, read(state));
    return state.values.get(point);
  };
  return point;
}

function paintRecord(value, id) {
  if (!value || value.color?.length !== 3 || value.slope?.length !== 2
      || [...value.color, ...value.slope, ...finish.map(key => value[key])].some(x => !Number.isFinite(x))) {
    throw new TypeError(`Supply a complete finite opaque paint record for ${id}.`);
  }
  return Object.freeze({color: Object.freeze([...value.color]), slope: Object.freeze([...value.slope]),
    ...Object.fromEntries(finish.map(key => [key, value[key]]))});
}

function surfaceSampler(graph, root, paint) {
  const plan = compileGraph(root === graph.output ? graph : materialGraph({...graph, output: root}));
  const origins = new Map(plan.bindings.map(binding => [binding.nodeId, binding.sourceId]));
  const point = foldGraph({version: graph.version, nodes: plan.nodes, output: plan.output}, {
    ...fieldAlgebra,
    facets: () => undefined,
    paint: (_node, source) => {
      const id = origins.get(source.id), record = paintRecord(paint?.[id], id);
      return () => record;
    },
    material: node => memo(state => ({
      color: node.color(state).value.map(clamp), slope: [0, 0],
      roughness: .5, metalness: 0, clearcoat: 0, opacity: 1,
    })),
    coat: node => memo(state => {
      const input = node.input(state);
      return {...input, color: vectorMix(input.color, node.color(state).value.map(clamp), clamp(node.mask(state).value))};
    }),
    channels: node => memo(state => ({...node.input(state),
      ...Object.fromEntries(Object.entries(node.values).map(([key, field]) => [key, clamp(field(state).value)])),
    })),
    bump: node => memo(state => {
      const input = node.input(state), height = node.height(state);
      return {...input, slope: [input.slope[0] + height.dx, input.slope[1] + height.dy]};
    }),
    relief: node => memo(state => {
      const input = node.input(state), scale = node.scale(state).value;
      return {...input, slope: input.slope.map(value => value * scale)};
    }),
    mix: node => memo(state => {
      const a = node.a(state), b = node.b(state), weight = clamp(node.mask(state).value);
      return {color: vectorMix(a.color, b.color, weight), slope: vectorMix(a.slope, b.slope, weight),
        ...Object.fromEntries(finish.map(key => [key, mix(a[key], b[key], weight)]))};
    }),
  });
  return context => sampleField(point, context);
}

function sampler(graph, root, paint) {
  const node = graph.nodes.find(node => node.id === root);
  if (!node) throw new TypeError(`Unknown observation root: ${root}.`);
  const sort = SURFACE_SIGNATURE[node.kind].result;
  if (sort === 'surface') return {sort, sample: surfaceSampler(graph, root, paint)};
  if (!['scalar', 'color', 'domain'].includes(sort)) {
    throw new TypeError(`Graph comparisons observe scalar, color, domain or surface roots, received ${sort}.`);
  }
  return {sort, sample: createFieldSampler(graphExpression(graph, root))};
}

function components(sample, path = '') {
  if (typeof sample === 'number') {
    if (!Number.isFinite(sample)) throw new RangeError(`Observation ${path} is not finite.`);
    return [[path, sample]];
  }
  return Object.entries(sample).flatMap(([key, value]) => components(value, path ? `${path}.${key}` : key));
}

/**
 * Compare outputs, or explicit {before, after, label?} observation roots, across
 * independent patches of the original revisions and explicit sample contexts.
 * An observation string selects the same named root in both graphs. Patches use
 * the same source IDs on both sides. Numeric comparison is Object.is, including
 * signed zero; exceptions remain failures rather than matching observations.
 *
 * paint maps authored paint node IDs to {color:[r,g,b], slope:[dx,dy], roughness,
 * metalness, clearcoat, opacity}. These are opaque test inputs, not rendered paint.
 */
export function compareGraphs(beforeInput, afterInput, {
  contexts = [{}], patches = [{}], observations, paint,
} = {}) {
  const before = expressionGraph(beforeInput), after = expressionGraph(afterInput);
  const roots = observations ?? [{before: before.output, after: after.output, label: 'output'}];
  if (!contexts.length || !patches.length || !roots.length) throw new TypeError('Graph comparisons require observations, contexts and patches.');
  let samples = 0, count = 0, maxAbsoluteDifference = 0, differences = 0, counterexample;
  for (const [revision, patch] of patches.entries()) {
    const left = patchGraph(before, patch), right = patchGraph(after, patch);
    for (const observation of roots) {
      const spec = typeof observation === 'string' ? {before: observation, after: observation, label: observation} : observation;
      const a = sampler(left, spec.before, paint), b = sampler(right, spec.after, paint);
      if (a.sort !== b.sort) throw new TypeError(`Observation sorts differ: ${a.sort} and ${b.sort}.`);
      for (const [index, context] of contexts.entries()) {
        const actual = components(a.sample(context)), candidate = components(b.sample(context));
        if (actual.length !== candidate.length || actual.some(([key], index) => key !== candidate[index][0])) {
          throw new TypeError('Observation component shapes differ.');
        }
        samples++;
        for (const [component, [key, value]] of actual.entries()) {
          const next = candidate[component][1];
          count++;
          maxAbsoluteDifference = Math.max(maxAbsoluteDifference, Math.abs(value - next));
          if (Object.is(value, next)) continue;
          differences++;
          counterexample ??= {revision, context: index, observation: spec.label ?? `${spec.before}/${spec.after}`,
            component: key, before: value, after: next, patch: structuredClone(patch), sampleContext: structuredClone(context)};
        }
      }
    }
  }
  return {equal: differences === 0, evidence: 'finite-observations', revisions: patches.length,
    contexts: contexts.length, observations: roots.length, samples, components: count,
    differences, maxAbsoluteDifference, counterexample: counterexample ?? null,
    scope: 'CPU field values/differentials and unlit surface record operations with opaque supplied paint leaves; not a universal proof, facets evaluation or GPU comparison.'};
}
