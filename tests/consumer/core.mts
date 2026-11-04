import {createOptimizationJob, applyOptimization, type OptimizationCandidate} from '@moonweave/surfaces/optimize';
import {
  surface, facets, scalar, color, mask, domain, image, zone, applyZones, pigment as spectral, coverage as coverageAlgebra, named, materialGraph, patchGraph, compileGraph, foldGraph, evaluateColor,
  expressionGraph, graphExpression, parseExpressionGraph, serializeGraph, createFieldSampler, instantiate, inspectGraph,
  type Algebra, type GraphNodeOf, type ScalarExpression, type ColorExpression,
  type ColorEvaluation, type Vec3, type ImageExpression, type ImageFilter, type PixelFootprint, type NodeValuePatch, type ColorSpace,
  type ColorInterpolation, type ColorRampStop, type PaintPalettePatch,
  type ExpressionGraph, type ScalarEvaluation, type ColorAdjustOptions, type MaskIntervalOptions, type MaskChiselOptions,
} from '@moonweave/surfaces/core';

// This fixture is checked before any Three runtime or types are installed.
// ES2022 is its only lib: the core has no browser or renderer type dependency.
const strength = named('strength', scalar.parameter(.7));
strength satisfies ScalarExpression;
strength.id satisfies 'strength';
const graph = materialGraph(surface.channels(surface.paint(facets()), {roughness: strength}));
const edited = patchGraph(graph, {strength: {value: .4}});
compileGraph(edited).cost.textureReads satisfies number;
const inspected=inspectGraph(edited);
inspected.nodes[inspected.output].sources satisfies readonly string[];
inspected.edges[0].source satisfies number;
compileGraph(edited).structure.sourceNodes.strength satisfies string | null;
({style: {roughness: .6}} satisfies NodeValuePatch);
({value: [.2, .4, .6]} satisfies NodeValuePatch);
({id: 'height', kind: 'axis', axis: 'y'} satisfies GraphNodeOf<'axis'>);

type Results = {domain: number; scalar: number; facets: number; surface: number};
declare const algebra: Algebra<Results>;
foldGraph<Results>(graph, algebra) satisfies number;

const grain = named('grain', scalar.noise({seed: 0xffffffff}));
grain.seed satisfies number;
const dark = named('dark', color.srgb('#284d58'));
dark.value satisfies Vec3;
const pigment = named('pigment', color.mix(dark, color.linear([.6, .8, .9]), grain));
pigment satisfies ColorExpression;
const procedural = materialGraph(surface.channels(surface.material(pigment), {roughness: grain}));
compileGraph(procedural).cost.proceduralSamples satisfies number;
evaluateColor(procedural, 'pigment', {position: [.37, -.21, .68], dx: [.01, 0, 0]}) satisfies ColorEvaluation;
patchGraph(procedural, {grain: {seed: 41}, dark: {value: [.1, .2, .3]}});
({id: 'dark', kind: 'color', value: [.1, .2, .3]} satisfies GraphNodeOf<'color'>);
({id: 'grain', kind: 'noise', seed: 41} satisfies GraphNodeOf<'noise'>);
({id: 'skin', kind: 'material', color: 'pigment'} satisfies GraphNodeOf<'material'>);
declare const colorAlgebra: Algebra<{color: Vec3; scalar: number}>;
colorAlgebra.colorMix(
  {id: 'mix', kind: 'colorMix', a: [0, 0, 0], b: [1, 1, 1], mask: .5},
  {id: 'mix', kind: 'colorMix', a: 'a', b: 'b', mask: 'm'},
) satisfies Vec3;

const stops = [[0, dark], [.5, pigment], [1, color.linear([1.2, -.2, .3])]] as const satisfies readonly ColorRampStop[];
const ramp = named('ramp', color.ramp(grain, stops, {space: 'oklab', interpolation: 'smoothstep'}));
ramp.space satisfies ColorSpace;
ramp.interpolation satisfies ColorInterpolation;
ramp.colors satisfies readonly ColorExpression[];
const palette = {base: ramp, shadow: dark} satisfies PaintPalettePatch;
const painted = materialGraph(surface.paint(facets(), 'carapace', palette));
patchGraph(painted, {ramp: {positions: [-1, .25, 2]}});
surface.paint('carapace', {palette});
color.mix(dark, ramp, grain, {space: 'oklab'});
({id: 'ramp', kind: 'colorRamp', input: 'grain', colors: ['dark', 'pigment'], positions: [0, 1],
  space: 'linear-rgb', interpolation: 'constant'} satisfies GraphNodeOf<'colorRamp'>);

const fieldGraph = expressionGraph(grain);
fieldGraph satisfies ExpressionGraph<'scalar'>;
createFieldSampler(fieldGraph)({position: [.2, .3, .4]}) satisfies ScalarEvaluation;
patchGraph(fieldGraph, {grain: {seed: 41}}) satisfies ExpressionGraph<'scalar'>;
parseExpressionGraph(serializeGraph(fieldGraph)) satisfies ExpressionGraph;
graphExpression(fieldGraph) satisfies ScalarExpression;
surface.bump(surface.material(graphExpression(expressionGraph(dark))),
  instantiate(graphExpression(fieldGraph), {prefix: 'restored'}));
const scoped = instantiate(surface.bump(surface.paint(facets()), scalar.multiply(grain, .05)), {
  prefix: 'wing', shared: [grain],
});
materialGraph(scoped);
({id: 'detail', kind: 'bump', input: 'skin', height: 'grain'} satisfies GraphNodeOf<'bump'>);

const adjustment = {lightness: -.1, chroma: grain, hue: scalar.parameter(35)} satisfies ColorAdjustOptions;
const adjusted = named('adjusted', color.adjust(color.oklch([.6, .12, 215]), adjustment));
adjusted satisfies ColorExpression;
adjusted.lightness satisfies ScalarExpression;
color.oklab([.6, -.1, .1]).value satisfies Vec3;
const adjustmentNode = {id: 'adjusted', kind: 'colorAdjust', input: 'dark', lightness: 'offset', chroma: 'gain', hue: 'turn'} satisfies GraphNodeOf<'colorAdjust'>;
colorAlgebra.colorAdjust({id: 'adjusted', kind: 'colorAdjust', input: [.2, .3, .4], lightness: -.1, chroma: 1.2, hue: 25}, adjustmentNode) satisfies Vec3;
const feather = {feather: .15} satisfies MaskIntervalOptions;
const shape = {domain: domain.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), feather: [.1, .2, .3]} satisfies MaskChiselOptions;
mask.interval(grain, .1, .8, feather) satisfies ScalarExpression;
const coverage = mask.chisel(shape);
surface.bump(surface.material(adjusted), coverage);
createFieldSampler(coverage)({position: [.2, .3, .4]}) satisfies ScalarEvaluation;

// @ts-expect-error A scalar cannot be used as a surface.
surface.mix(strength, surface.paint(), .5);
// @ts-expect-error Value patches cannot replace graph references.
patchGraph(graph, {paint: {field: 'otherField'}});
// @ts-expect-error Parameters are numeric.
scalar.parameter('0.4');
// @ts-expect-error A scalar is not a color field.
surface.material(grain);
// @ts-expect-error Finish channels require scalar fields, not color fields.
surface.channels(surface.material(dark), {roughness: dark});
// @ts-expect-error Colors have exactly three components.
color.linear([.1, .2]);
// @ts-expect-error Palette fields cannot receive scalar values.
surface.paint(facets(), 'carapace', {base: grain});
// @ts-expect-error Stop positions are editable, but stop references are structural.
patchGraph(painted, {ramp: {colors: ['dark', 'pigment']}});
// @ts-expect-error Perceptual controls take scalar fields.
color.adjust(dark, {chroma: dark});
// @ts-expect-error Masks cannot take colors as scalar inputs.
mask.interval(dark, 0, 1);

// LLM-authored resources and applications survive source-free package consumption.
const pixels = named('pixels', image.generate({width: 4, height: 4, channels: 1}, (u, v) => u * v));
pixels satisfies ImageExpression;
const stamp = scalar.image(pixels, {address: 'repeat', channel: 'g'});
const filteredStamp = scalar.image(pixels, {address: 'zero', filter: 'anisotropic', channel: 'g'});
filteredStamp.filter satisfies ImageFilter | undefined;
const footprint = {dx: [.08, .01, 0], dy: [.01, .02, 0]} satisfies PixelFootprint;
createFieldSampler(filteredStamp)({position: [.2, .4, 0], dx: [1, 0, 0], footprint}) satisfies ScalarEvaluation;
color.image(pixels, {filter: 'trilinear', address: 'zero'}) satisfies ColorExpression;
const pigmentTable = image.generate({width: 16, height: 1, channels: 3}, (_u, _v, x) =>
  spectral.toLinear(spectral.mix(spectral.srgb('#dcc878'), spectral.srgb('#315e79'), x / 15)));
const pigmentField = color.image(pigmentTable);
const applications = [zone('wash', stamp, {color: pigmentField, height: .004, channels: {roughness: .7}})];
const applied = applyZones(surface.paint(), applications);
compileGraph(applied);
expressionGraph(pixels) satisfies ExpressionGraph<'image'>;
graphExpression(expressionGraph(pixels)) satisfies ImageExpression;
createFieldSampler(stamp)({position: [.2, .4, 0]}) satisfies ScalarEvaluation;
surface.coat(applied, pigmentField, coverageAlgebra.intersect(stamp, .5));
// @ts-expect-error Image resources need an explicit color/scalar sampling operation.
surface.material(pixels);
// @ts-expect-error Scalar image samples require image resources.
scalar.image(pigmentField);
// @ts-expect-error Three-channel procedural resources require RGB samples.
image.generate({width: 4, height: 1, channels: 3}, () => .2);
// @ts-expect-error Zone pigment is a Color expression, not a numeric tuple.
zone('bad', stamp, {color: [.1, .2, .3]});
// @ts-expect-error Filtering policies use the defined image-filter vocabulary.
scalar.image(pixels, {filter: 'bicubic'});
// @ts-expect-error Footprints are vectors in the three-dimensional source domain.
createFieldSampler(filteredStamp)({footprint: {dx: [.1, .2], dy: [.2, .1]}});
// @ts-expect-error Filter policy is structural, not an editable uniform value.
patchGraph(expressionGraph(named('sample', filteredStamp)), {sample: {filter: 'linear'}});

const optimizationSource = materialGraph(surface.material(color.srgb('#d0b89c')));
const optimizationCandidate: OptimizationCandidate = createOptimizationJob(optimizationSource);
const optimizationResult = applyOptimization(optimizationSource, optimizationCandidate);
const optimizedGraph = optimizationResult.graph;
compileGraph(optimizedGraph);

// Generic source-owned types remain intact after declaration-only packaging.
import {
  toWorkingColor, convertColor, displayColor, markProgram, compileMarkProgram, bakeMarks, applyMarkBake,
  type TaggedColor, type MarkProgram, type MarkBake, type FieldOutputs,
} from '@moonweave/surfaces/core';
const tagged = {space: 'srgb', coords: [.6, .4, .2]} as const satisfies TaggedColor<'srgb'>;
convertColor(tagged, 'oklab') satisfies TaggedColor<'oklab'>;
displayColor(tagged, 'display-p3') satisfies TaggedColor<'display-p3'>;
const marks: MarkProgram = markProgram({brushes: {ink: {mask: pixels.resource}}, marks: [
  {kind: 'dab', brush: 'ink', color: toWorkingColor(tagged), transform: [1, 0, 0, 1, 0, 0]},
]});
const bake: MarkBake = bakeMarks(marks, {width: 8, height: 8});
compileMarkProgram(marks).bake({width: 8, height: 8}) satisfies MarkBake;
materialGraph(applyMarkBake(surface.material(dark), bake));
const samples = createFieldSampler(procedural, {noise: {id: 'grain', sort: 'scalar'}, pigment: {id: 'pigment', sort: 'color'}})();
samples.noise satisfies ScalarEvaluation;
samples.pigment satisfies ColorEvaluation;
samples satisfies FieldOutputs<{noise: {id: 'grain'; sort: 'scalar'}; pigment: {id: 'pigment'; sort: 'color'}}>;
// @ts-expect-error Tagged coordinate triples retain their dimension.
toWorkingColor({space: 'srgb', coords: [.2, .3]});
// @ts-expect-error Display output is an explicit supported RGB target.
displayColor(tagged, 'oklab');
// @ts-expect-error Marks apply to surfaces.
applyMarkBake(dark, bake);
