import {
  materialGraph, graphTopology, nodeType, nodeReferences, GRAPH_LIMITS, freeze,
} from './graph.mts';
import {record, reference} from './algebra.mts';
import type {Channel, GraphNode, GraphNodeOf, GraphSort, NodeKind} from './algebra.mts';
import type {GraphInput, MaterialGraph, GraphCost} from './types.mts';
import {compileGraph} from './compile.mts';
import {structuralKey} from './intern.mts';
import {
  EFFECT_CHANNELS, EFFECT_OPERATORS, EXACT_EFFECT_RULES, SURFACE_COMPONENTS, projectSurfaceTerms,
  isEffectOperator, isAtomOperator, isChannelOperator,
} from './effects.mts';
import type {
  EffectOperator, AtomOperator, ChannelOperator, SurfaceOperator, SurfaceEffectKind,
  EffectDefinition, EffectRule, EffectTerm, EffectTermBody, EffectSort, SurfaceComponent,
} from './effects.mts';

export const OPTIMIZATION_VERSION = 1;
export const OPTIMIZATION_RULESET = 'surface-effects/1';
export const OPTIMIZATION_LIMITS = Object.freeze({terms: GRAPH_LIMITS.nodes * EFFECT_CHANNELS.length});

export interface OptimizationCandidate {
  readonly version: typeof OPTIMIZATION_VERSION;
  readonly ruleset: typeof OPTIMIZATION_RULESET;
  readonly terms: readonly EffectTerm[];
  readonly output: string;
  /** Engine metadata is informative; acceptance does not trust it. */
  readonly receipt?: Readonly<Record<string, unknown>>;
}
export interface OptimizationJob extends OptimizationCandidate {
  readonly operators: Readonly<Record<EffectOperator, EffectDefinition>>;
  readonly rules: readonly EffectRule[];
}
export interface OptimizationProof {
  readonly kind: 'surface-product/1';
  readonly equivalent: boolean;
  readonly components: readonly SurfaceComponent[];
  readonly changed: readonly SurfaceComponent[];
}
export interface OptimizationCost extends GraphCost {readonly liveNodes: number}
export type OptimizationResult = Readonly<{
  graph: MaterialGraph; before: OptimizationCost; proof: OptimizationProof;
}> & (
  | Readonly<{accepted: true; reason: 'improved'; after: OptimizationCost}>
  | Readonly<{accepted: false; reason: 'no-improvement' | 'cost-regression'; after: OptimizationCost}>
  | Readonly<{accepted: false; reason: 'graph-limit'; after?: never}>
);
type TermGraph = Pick<OptimizationCandidate, 'terms' | 'output'>;
type EffectNodeBody = {
  [K in SurfaceEffectKind | 'channels']: Omit<GraphNodeOf<K>, 'id'>
}[SurfaceEffectKind | 'channels'];

const surfaceOperators = new Map<NodeKind, SurfaceOperator>();
const channelOperators = new Map<Channel, ChannelOperator>();
const atomOperators = new Map<GraphSort, AtomOperator>();
// Reflect the closed registry; property names are precisely EffectOperator.
for (const op of Object.keys(EFFECT_OPERATORS) as EffectOperator[]) {
  if (isAtomOperator(op)) atomOperators.set(EFFECT_OPERATORS[op].result, op);
  else if (isChannelOperator(op)) channelOperators.set(EFFECT_OPERATORS[op].channel, op);
  else surfaceOperators.set(EFFECT_OPERATORS[op].kind, op);
}

/** Export structure only. Images, field expressions and editable values stay in the source graph. */
export function createOptimizationJob(input: GraphInput): OptimizationJob {
  const graph = materialGraph(input), topology = graphTopology(graph);
  const terms: EffectTerm[] = [], sources = new Map<string, string>(), common = new Map<string, string>();
  const emit = (body: EffectTermBody): string => {
    const key = JSON.stringify(body), existing = common.get(key);
    if (existing !== undefined) return existing;
    const id = `t${terms.length}`;
    terms.push({id, ...body});
    common.set(key, id);
    return id;
  };
  function visit(id: string): string {
    const existing = sources.get(id);
    if (existing !== undefined) return existing;
    const node = graph.nodes[topology.slots[id]];
    let result: string;
    if (node.kind === 'channels') {
      result = visit(node.input);
      for (const channel of EFFECT_CHANNELS) {
        const value = node.values[channel];
        if (value !== undefined) result = emit({op: channelOperators.get(channel)!, args: [result, visit(value)]});
      }
    } else {
      const op = surfaceOperators.get(node.kind);
      result = op === undefined
        ? emit({op: atomOperators.get(nodeType(node))!, source: id})
        : emit({op, args: nodeReferences<string>(node).map(({ref}) => visit(ref))});
    }
    sources.set(id, result);
    return result;
  }
  const output = visit(graph.output);
  return freeze({version: OPTIMIZATION_VERSION, ruleset: OPTIMIZATION_RULESET,
    operators: EFFECT_OPERATORS, rules: EXACT_EFFECT_RULES, terms, output});
}

/** Decode a closed typed DAG; extraction cannot introduce values, fields or resource policies. */
function candidateTerms(job: OptimizationJob, candidate: unknown): TermGraph {
  record(candidate, 'optimization candidate');
  if (candidate.version !== OPTIMIZATION_VERSION || candidate.ruleset !== OPTIMIZATION_RULESET) {
    throw new RangeError('Unsupported optimization version or ruleset.');
  }
  if (!Array.isArray(candidate.terms) || !candidate.terms.length || candidate.terms.length > OPTIMIZATION_LIMITS.terms) {
    throw new RangeError(`Optimization requires 1–${OPTIMIZATION_LIMITS.terms} terms.`);
  }
  const atoms = new Set(job.terms.filter(node => node.source !== undefined).map(node => `${node.op}:${node.source}`));
  const sorts = new Map<string, EffectSort>();
  const rawTerms: readonly unknown[] = candidate.terms;
  const terms = Array.from(rawTerms, (node): EffectTerm => {
    record(node, 'optimization term', ['id', 'op', 'source', 'args']);
    const id = reference(node.id, 'optimization term.id');
    if (sorts.has(id)) throw new RangeError(`Duplicate optimization term: ${id}.`);
    if (!isEffectOperator(node.op)) throw new TypeError('Unknown optimization operator.');
    const op = node.op, definition = EFFECT_OPERATORS[op];
    let term: EffectTerm;
    if (isAtomOperator(op)) {
      const source = reference(node.source, `${id}.source`);
      if (node.args !== undefined || !atoms.has(`${op}:${source}`)) {
        throw new TypeError(`Optimization atom must retain its source identity: ${id}.`);
      }
      term = {id, op, source};
    } else {
      if (node.source !== undefined || !Array.isArray(node.args) || node.args.length !== definition.inputs.length) {
        throw new TypeError(`Invalid optimization inputs: ${id}.`);
      }
      const rawArgs: readonly unknown[] = node.args;
      const args = Array.from(rawArgs, (value, index) => {
        const ref = reference(value, `${id}.args[${index}]`);
        if (sorts.get(ref) !== definition.inputs[index]) {
          throw new TypeError(`${id}.args[${index}] requires an earlier ${definition.inputs[index]} term.`);
        }
        return ref;
      });
      term = {id, op, args};
    }
    sorts.set(id, definition.result);
    return term;
  });
  const output = reference(candidate.output, 'optimization output');
  if (sorts.get(output) !== 'surface') throw new TypeError('Optimization output must be a surface term.');
  return {terms, output};
}

function proofFor(job: TermGraph, candidate: TermGraph): OptimizationProof {
  const intern = new Map<string, number>();
  const before = projectSurfaceTerms(job.terms, job.output, intern);
  const after = projectSurfaceTerms(candidate.terms, candidate.output, intern);
  const components = SURFACE_COMPONENTS;
  const changed = components.filter(component => before[component] !== after[component]);
  return Object.freeze({kind: 'surface-product/1', equivalent: changed.length === 0,
    components, changed: Object.freeze(changed)});
}

/** Exact symbolic observations, independent of egglog and of current editable values. */
export function verifyOptimization(input: GraphInput, candidate: OptimizationCandidate): OptimizationProof {
  const job = createOptimizationJob(input);
  return proofFor(job, candidateTerms(job, candidate));
}

function materialize(graph: MaterialGraph, candidate: TermGraph): MaterialGraph {
  const nodes = [...graph.nodes], byId = new Map(nodes.map(node => [node.id, node]));
  const common = new Map<string, string>();
  for (const node of nodes) {
    const key = structuralKey(node);
    if (key !== undefined) common.set(key, node.id);
  }
  const references = new Map<string, string>();
  let next = 0;
  function emit(body: EffectNodeBody): string {
    // Every reified effect is structural; editable source atoms are borrowed.
    const key = structuralKey(body)!, existing = common.get(key);
    if (existing !== undefined) return existing;
    while (byId.has(`opt${next}`)) next++;
    const id = `opt${next++}`, node: GraphNode = {id, ...body};
    nodes.push(node); byId.set(id, node); common.set(key, id);
    return id;
  }
  // Only root-reachable extraction terms become graph nodes. Extra diagnostic
  // terms cannot increase the execution plan or exhaust the document budget.
  const byTerm = new Map(candidate.terms.map(term => [term.id, term]));
  function visit(id: string): string {
    const existing = references.get(id);
    if (existing !== undefined) return existing;
    const term = byTerm.get(id)!;
    let ref: string;
    if (term.source !== undefined) ref = term.source;
    else {
      const args = term.args.map(visit);
      if (isChannelOperator(term.op)) {
        const input = byId.get(args[0])!;
        const values = {...(input.kind === 'channels' ? input.values : {}), [EFFECT_OPERATORS[term.op].channel]: args[1]};
        ref = emit({kind: 'channels', input: input.kind === 'channels' ? input.input : args[0],
          values: Object.fromEntries(EFFECT_CHANNELS.filter(channel => values[channel] !== undefined)
            .map(channel => [channel, values[channel]]))});
      } else {
        const definition = EFFECT_OPERATORS[term.op];
        // Candidate ports were decoded against this signature. Reification
        // cannot add a payload or choose a kind outside the four surface ops.
        ref = emit({kind: definition.kind, ...Object.fromEntries(definition.ports.map((port, index) => [port, args[index]]))} as EffectNodeBody);
      }
    }
    references.set(id, ref);
    return ref;
  }
  const output = visit(candidate.output);
  if (output === graph.output) return graph;
  const retained = new Set(graph.nodes.map(node => node.id));
  function retain(id: string): void {
    if (retained.has(id)) return;
    retained.add(id);
    for (const {ref} of nodeReferences<string>(byId.get(id)!)) retain(ref);
  }
  retain(output);
  // Source IDs and values remain available for patchGraph, including an override
  // that became dead. Compilation prunes that dead work from the execution DAG.
  return materialGraph({version: graph.version, nodes: nodes.filter(node => retained.has(node.id)), output});
}

function cost(graph: MaterialGraph): OptimizationCost {
  const plan = compileGraph(graph);
  return Object.freeze({...plan.cost, liveNodes: plan.nodes.length});
}

/** Check semantics, then accept only a strict Pareto improvement in compiled DAG cost. */
export function applyOptimization(input: GraphInput, candidate: OptimizationCandidate): OptimizationResult {
  const graph = materialGraph(input), job = createOptimizationJob(graph);
  const decoded = candidateTerms(job, candidate), proof = proofFor(job, decoded);
  if (!proof.equivalent) throw new TypeError(`Optimization changes surface components: ${proof.changed.join(', ')}.`);
  const before = cost(graph);
  let optimized: MaterialGraph;
  try { optimized = materialize(graph, decoded); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return Object.freeze({graph, accepted: false, reason: 'graph-limit', before, proof});
  }
  const after = cost(optimized), keys = Object.keys(before) as (keyof OptimizationCost)[];
  const regression = keys.some(key => after[key] > before[key]);
  const improvement = keys.some(key => after[key] < before[key]);
  const accepted = !regression && improvement;
  return accepted
    ? Object.freeze({graph: optimized, accepted: true, reason: 'improved', before, after, proof})
    : Object.freeze({graph, accepted: false, reason: regression ? 'cost-regression' : 'no-improvement', before, after, proof});
}
