import {
  createFieldSampler, scalar, color, domain, named, surface, materialGraph, zone,
  type FieldRoot, type FieldRoots, type FieldOutputs, type FieldSampler, type FieldSamples,
  type Vec3, type ScalarEvaluation, type ColorEvaluation, type DomainSample, type ScalarExpression,
} from '@moonweave/surfaces/core';

const frame = named('frame', domain.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
const mask = named('mask', scalar.axis('x', frame));
const pigment = named('pigment', color.mix(color.linear([.1, .2, .3]), color.linear([.4, .5, .6]), mask));
const graph = materialGraph(surface.channels(surface.material(pigment), {roughness: mask}));
const roots = {height: {id: 'mask', sort: 'scalar'}, ink: {id: 'pigment', sort: 'color'},
  space: {id: 'frame', sort: 'domain'}} as const satisfies FieldRoots;
roots.height satisfies FieldRoot<'scalar'>;
const sampler = createFieldSampler(graph, roots);
sampler satisfies FieldSampler<FieldOutputs<typeof roots>>;
const samples = sampler({position: [0, 0, 0]});
samples.height satisfies ScalarEvaluation;
samples.ink satisfies ColorEvaluation;
samples.space satisfies DomainSample;
samples.height.value satisfies number;
samples.ink.value satisfies Vec3;
samples.space.position satisfies Vec3;
samples.height satisfies FieldSamples['scalar'];
createFieldSampler(graph, {only: {id: 'mask', sort: 'scalar'}})().only.value satisfies number;
createFieldSampler(mask)().value satisfies number;
createFieldSampler(pigment)().value satisfies Vec3;
createFieldSampler(frame)().position satisfies Vec3;
zone('wash', mask, {height: mask, color: pigment, channels: {roughness: mask}}).coverage satisfies ScalarExpression;
// @ts-expect-error A color output remains a vector, not a scalar sample.
samples.ink.value satisfies number;
// @ts-expect-error Domain outputs have coordinates, not color/scalar values.
samples.space.value;
// @ts-expect-error The selected output names are exact.
samples.missing;
// @ts-expect-error Sampling does not support surface or image roots.
createFieldSampler(graph, {bad: {id: graph.output, sort: 'surface'}});
// @ts-expect-error Field selector IDs are strings.
createFieldSampler(graph, {bad: {id: 1, sort: 'scalar'}});
// @ts-expect-error Named output records are readonly.
samples.height = samples.height;
// @ts-expect-error Scalar samples remain scalar after composition.
samples.height.value = 0;
