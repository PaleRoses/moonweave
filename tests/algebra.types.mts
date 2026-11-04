import {
  scalar, color, domain, facets, surface, inDomain, foldGraph, materialGraph,
  expressionGraph, graphExpression, parseExpressionGraph, serializeGraph, patchGraph, createFieldSampler, named, instantiate,
  type Algebra, type Vec3, type GraphNodeOf, type ImageResource,
  type DomainExpression, type ScalarExpression, type ColorExpression, type FacetExpression, type SurfaceExpression,
  type ExpressionGraph, type MaterialGraph, type ScalarEvaluation, type ColorEvaluation, type DomainSample, type GraphExpression,
} from '@moonweave/surfaces/core';

type Results = {image: ImageResource; domain: Vec3; scalar: number; color: Vec3; facets: string; surface: {sample: string}};
const algebra: Algebra<Results> = {
  image: node => node.resource,
  imageScalar: node => node.image.data[0],
  imageColor: node => [node.image.data[0], 0, 0],
  deposit: node => {node.color satisfies Vec3; node.mask satisfies number; return node.input;},
  coat: node => {node.color satisfies Vec3; node.mask satisfies number; return node.input;},
  transform: node => node.input ?? [0, 0, 0],
  constant: node => node.value,
  parameter: node => node.value,
  axis: node => (node.domain ?? [0, 0, 0])[{x: 0, y: 1, z: 2}[node.axis]],
  facing: node => node.direction[1],
  noise: node => node.seed,
  ramp: node => node.input,
  add: node => node.a + node.b,
  multiply: node => node.a * node.b,
  complement: node => 1 - node.input,
  color: node => node.value,
  colorMix: node => node.mask < .5 ? node.a : node.b,
  colorAdjust: node => {node.lightness satisfies number; node.chroma satisfies number; node.hue satisfies number; return node.input;},
  colorRamp: node => {node.colors satisfies readonly Vec3[]; return node.colors[0];},
  facets: node => `${node.domain?.[0] ?? 0}:${node.scale}`,
  paint: node => ({sample: node.field}),
  material: node => ({sample: node.color.join(',')}),
  mix: node => node.mask < .5 ? node.a : node.b,
  channels: node => {node.values.roughness satisfies number | undefined; return node.input;},
  relief: node => {node.scale satisfies number; return node.input;},
  bump: node => {node.height satisfies number; return node.input;},
};

const frame = domain.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1]);
inDomain(frame, frame) satisfies DomainExpression;
inDomain(scalar.axis(), frame) satisfies ScalarExpression;
inDomain(color.srgb('#346190'), frame) satisfies ColorExpression;
inDomain(facets(), frame) satisfies FacetExpression;
inDomain(surface.paint(), frame) satisfies SurfaceExpression;
foldGraph<Results>(materialGraph(surface.paint()), algebra).sample satisfies string;
foldGraph<Results>(materialGraph(surface.paint()), algebra, 'someNode') satisfies Results[keyof Results];

const scalarRoot = expressionGraph(named('gain', scalar.parameter(.3)));
const colorRoot = expressionGraph(color.srgb('#123456'));
const domainRoot = expressionGraph(frame);
const facetsRoot = expressionGraph(facets());
scalarRoot satisfies ExpressionGraph<'scalar'>;
colorRoot satisfies ExpressionGraph<'color'>;
domainRoot satisfies ExpressionGraph<'domain'>;
facetsRoot satisfies ExpressionGraph<'facets'>;
expressionGraph(surface.paint()) satisfies MaterialGraph;
expressionGraph('carapace') satisfies MaterialGraph;
patchGraph(scalarRoot, {gain: {value: .4}}) satisfies ExpressionGraph<'scalar'>;
patchGraph(named('gain', scalar.parameter(.3)), {gain: {value: .4}}) satisfies ExpressionGraph<'scalar'>;
parseExpressionGraph(serializeGraph(colorRoot)) satisfies ExpressionGraph;
graphExpression(scalarRoot) satisfies ScalarExpression;
graphExpression(colorRoot) satisfies ColorExpression;
graphExpression(domainRoot) satisfies DomainExpression;
graphExpression(facetsRoot) satisfies FacetExpression;
graphExpression(materialGraph(surface.paint())) satisfies SurfaceExpression;
graphExpression(scalarRoot).id satisfies string;
graphExpression(colorRoot, 'unknown') satisfies GraphExpression;
graphExpression(parseExpressionGraph(serializeGraph(colorRoot))) satisfies GraphExpression;
surface.bump(surface.material(graphExpression(colorRoot)), graphExpression(scalarRoot));
inDomain(graphExpression(scalarRoot), graphExpression(domainRoot));
foldGraph<Results>(scalarRoot, algebra) satisfies number;
foldGraph<Results>(colorRoot, algebra) satisfies Vec3;
foldGraph<Results>(domainRoot, algebra) satisfies Vec3;
foldGraph<Results>(facetsRoot, algebra) satisfies string;
createFieldSampler(scalarRoot)({position: [1, 2, 3]}) satisfies ScalarEvaluation;
createFieldSampler(colorRoot)() satisfies ColorEvaluation;
createFieldSampler(domainRoot)() satisfies DomainSample;
createFieldSampler(scalar.axis('x'))() satisfies ScalarEvaluation;
createFieldSampler(color.srgb('#123456'))() satisfies ColorEvaluation;
createFieldSampler(frame)() satisfies DomainSample;
instantiate(scalar.axis('x'), {prefix: 'wing'}) satisfies ScalarExpression;
instantiate(named('paint', surface.paint()), {prefix: 'wing'}).id satisfies string;
const lifted = surface.bump(surface.paint(), scalar.noise());
lifted.kind satisfies 'bump';
lifted.height satisfies ScalarExpression;
// @ts-expect-error Root sort is retained in normalized graph types.
scalarRoot satisfies MaterialGraph;
// @ts-expect-error Surface expressions have no CPU field sampler.
createFieldSampler(surface.paint());
// @ts-expect-error Instance scoping preserves the expression sort.
surface.material(instantiate(scalar.noise(), {prefix: 'wing'}));
// @ts-expect-error Bump heights are scalar fields.
surface.bump(surface.paint(), color.srgb('#123456'));
// @ts-expect-error Reification retains the stored root sort.
surface.material(graphExpression(scalarRoot));
// @ts-expect-error An explicit root ID may select another sort.
surface.material(graphExpression(colorRoot, 'unknown'));

const axis: GraphNodeOf<'axis'> = {id: 'height', kind: 'axis', axis: 'y'};
axis.axis satisfies 'x' | 'y' | 'z';
// @ts-expect-error A surface cannot be used as a coordinate frame.
inDomain(scalar.axis(), surface.paint());
// @ts-expect-error A paint requires a sampled-field reference.
const badPaint: GraphNodeOf<'paint'> = {id: 'bad', kind: 'paint', style: {}};
// @ts-expect-error Scalar ports are interpreted as numbers, not raw node IDs.
algebra.add({id: 'sum', kind: 'add', a: 'left', b: 2}, {id: 'sum', kind: 'add', a: 'left', b: 'right'});
// @ts-expect-error Surface mix receives surfaces, not facet strings.
algebra.mix({id: 'mix', kind: 'mix', a: 'sample', b: {sample: 'b'}, mask: .5}, {id: 'mix', kind: 'mix', a: 'a', b: 'b', mask: 'm'});
