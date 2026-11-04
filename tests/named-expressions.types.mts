import {
  named, scalar, color, domain, facets, surface, inDomain, materialGraph, patchGraph,
  type ScalarExpression, type DomainExpression, type FacetExpression, type SurfaceExpression,
  type NodeValuePatch, type FacetMapping, type StylePatch, type Vec3, type ImageResource,
} from '@moonweave/surfaces/core';

const strength = named('strength', scalar.parameter(.7));
strength.id satisfies 'strength';
strength satisfies ScalarExpression;
const renamed = named('other_strength', strength);
renamed.id satisfies 'other_strength';
if (renamed.kind === 'parameter') renamed.value satisfies number;
const frame = named('frame', domain.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
frame satisfies DomainExpression;
const field = named('field', facets({domain: frame}));
field satisfies FacetExpression;
const paint = named('paint', surface.paint(field, {}, {base: named('base_color', color.srgb('#abcdef'))}));
paint satisfies SurfaceExpression;
const moved = inDomain(paint, frame);
moved.id satisfies 'paint';
const graph = materialGraph(surface.channels(paint, {metalness: strength}));
patchGraph(graph, {strength: {value: .5}, field: {scale: .2}, paint: {style: {roughness: .4}}, base_color: {value: [.2, .4, .6]}});

// Existing value patches stay assignable as the grammar gains typed color values.
type PriorPatch = Readonly<{value?: number}> | Readonly<{direction?: Vec3}>
  | Readonly<{low?: number; high?: number}> | Readonly<{matrix?: readonly number[]}>
  | Readonly<Partial<FacetMapping>> | Readonly<{style?: StylePatch}>;
declare const previous: PriorPatch, derived: NodeValuePatch;
previous satisfies NodeValuePatch;
derived satisfies PriorPatch | Readonly<{value?: Vec3}> | Readonly<{seed?: number}> | Readonly<{positions?: readonly number[]}> | Readonly<{resource?: ImageResource}>;
({direction: [0, 1, 0]} satisfies NodeValuePatch);
({low: -.4, high: .6} satisfies NodeValuePatch);
({matrix: [1, 0, 0, 0]} satisfies NodeValuePatch);
({style: {roughness: .4}} satisfies NodeValuePatch);
// @ts-expect-error Names are strings.
named(12, strength);
// @ts-expect-error Named expressions are data, not callbacks.
named('callback', () => strength);
// @ts-expect-error Naming preserves sorts; a scalar is not a surface.
surface.mix(strength, paint, .5);
// @ts-expect-error Naming cannot make a surface into a domain.
inDomain(paint, named('wrong_frame', paint));
// @ts-expect-error Value patches cannot replace references.
({field: 'different'} satisfies NodeValuePatch);
// @ts-expect-error Axis selection is structural.
({axis: 'x'} satisfies NodeValuePatch);
// @ts-expect-error Facing mode is structural.
({absolute: true} satisfies NodeValuePatch);
// @ts-expect-error Parameter values remain numeric.
({value: '0.5'} satisfies NodeValuePatch);
// @ts-expect-error Palette is a graph input, never a parallel numeric-style property.
({style: {palette: {base: 123}}} satisfies NodeValuePatch);
