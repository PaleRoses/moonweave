import {materialGraph, surface, color} from '@moonweave/surfaces/core';
import {createOptimizationJob, verifyOptimization, applyOptimization,
  type OptimizationJob, type OptimizationCandidate, type OptimizationResult, type SurfaceComponent} from '@moonweave/surfaces/optimize';

const graph = materialGraph(surface.material(color.srgb('#d8cabc')));
const job: OptimizationJob = createOptimizationJob(graph);
const candidate: OptimizationCandidate = job;
const components: readonly SurfaceComponent[] = verifyOptimization(graph, candidate).changed;
const result = applyOptimization(graph, candidate);
const nodes: number | undefined = result.after?.liveNodes;
void components; void nodes;
// @ts-expect-error unsupported optimization ruleset
const incorrect: OptimizationCandidate = {...job, ruleset: 'all-real-arithmetic'};
// @ts-expect-error scalar atoms need a source identity
const atom: OptimizationCandidate = {...job, terms: [{id: 'x', op: 'ScalarAtom', args: []}]};
void incorrect; void atom;

// Successful extraction always has measured output costs.
if (result.accepted) {
  const acceptedNodes: number = result.after.liveNodes;
  void acceptedNodes;
}
if (result.reason === 'graph-limit') {
  const unavailable: undefined = result.after;
  void unavailable;
}
// @ts-expect-error accepted and reason describe one outcome, not independent flags
const inconsistent: OptimizationResult = {...result, accepted: false, reason: 'improved'};
void inconsistent;
