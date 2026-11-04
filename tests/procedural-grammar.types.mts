import {
  scalar, color, domain, mask, facets, surface, materialGraph, named, inDomain, patchGraph, evaluateColor,
  type ColorExpression, type ColorEvaluation, type GraphNodeOf, type Algebra, type Vec3,
  type ColorSpace, type ColorInterpolation, type ColorRampStop, type PaintPalettePatch,
  type ColorAdjustOptions, type MaskIntervalOptions, type MaskChiselOptions, type ScalarExpression,
} from '@moonweave/surfaces/core';

const ink = named('ink', color.srgb('#284d58'));
ink.value satisfies Vec3;
color.linear([.1, .2, .3]).value satisfies Vec3;
const grain = named('grain', scalar.noise({seed: 9}));
grain.seed satisfies number;
const mixed = color.mix(ink, color.linear([1, 1, 1]), grain);
mixed satisfies ColorExpression;
const graph = materialGraph(surface.channels(surface.material(mixed), {roughness: grain}));
patchGraph(graph, {grain: {seed: 14}, ink: {value: [.2, .4, .7]}});
evaluateColor(graph, 'ink') satisfies ColorEvaluation;
inDomain(mixed, domain.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])) satisfies ColorExpression;

const colorNode: GraphNodeOf<'color'> = {id: 'ink', kind: 'color', value: [.1, .2, .3]};
const noiseNode: GraphNodeOf<'noise'> = {id: 'grain', kind: 'noise', seed: 4};
const materialNode: GraphNodeOf<'material'> = {id: 'body', kind: 'material', color: 'ink'};
colorNode.value satisfies Vec3;
noiseNode.domain satisfies string | undefined;
materialNode.color satisfies string;

const colors: Algebra<{color: Vec3; scalar: number}> = {
  imageScalar: () => 0,
  imageColor: () => [0, 0, 0],
  color: node => node.value,
  colorMix: node => node.mask < .5 ? node.a : node.b,
  colorAdjust: node => node.input,
  colorRamp: node => node.colors[0],
  noise: node => node.seed,
  constant: node => node.value,
  parameter: node => node.value,
  axis: () => 0,
  facing: () => 0,
  ramp: node => node.input,
  add: node => node.a + node.b,
  multiply: node => node.a * node.b,
  complement: node => 1 - node.input,
};
colors.colorMix({id: 'blend', kind: 'colorMix', a: [0, 0, 0], b: [1, 1, 1], mask: .5}, {id: 'blend', kind: 'colorMix', a: 'a', b: 'b', mask: 'weight'}) satisfies Vec3;

const stops = [[0, ink], [.4, mixed], [1, ink]] as const satisfies readonly ColorRampStop[];
const ramp = named('color_ramp', color.ramp(grain, stops, {space: 'oklab', interpolation: 'smoothstep'}));
ramp.space satisfies ColorSpace;
ramp.interpolation satisfies ColorInterpolation;
ramp.colors satisfies readonly ColorExpression[];
ramp.positions satisfies readonly number[];
const palette = {base: ramp, light: ink} satisfies PaintPalettePatch;
surface.paint('carapace', {palette}) satisfies import('@moonweave/surfaces/core').SurfaceExpression;
surface.paint(facets(), 'carapace', palette) satisfies import('@moonweave/surfaces/core').SurfaceExpression;
const rampNode: GraphNodeOf<'colorRamp'> = {
  id: 'color_ramp', kind: 'colorRamp', input: 'grain', colors: ['ink', 'mixed', 'ink'],
  positions: [0, .4, 1], space: 'oklab', interpolation: 'smoothstep',
};
rampNode.colors satisfies readonly string[];
declare const paintNode: GraphNodeOf<'paint'>;
paintNode.palette.base satisfies string;
patchGraph(graph, {color_ramp: {positions: [-1, .5, 2]}});
colors.colorRamp({
  id: 'color_ramp', kind: 'colorRamp', input: .5, colors: [[0, 0, 0], [1, 1, 1]],
  positions: [0, 1], space: 'linear-rgb', interpolation: 'linear',
}, {...rampNode, colors: ['ink', 'mixed'], positions: [0, 1]}) satisfies Vec3;

const adjustment = {lightness: -.12, chroma: grain, hue: scalar.parameter(25)} satisfies ColorAdjustOptions;
const adjusted = color.adjust(ink, adjustment);
adjusted.input satisfies ColorExpression;
adjusted.lightness satisfies ScalarExpression;
adjusted.chroma satisfies ScalarExpression;
adjusted.hue satisfies ScalarExpression;
color.oklab([.6, -.1, .2]).value satisfies Vec3;
color.oklch([.6, .2, 180]).value satisfies Vec3;
const adjustmentNode: GraphNodeOf<'colorAdjust'> = {
  id: 'adjusted', kind: 'colorAdjust', input: 'ink', lightness: 'offset', chroma: 'scale', hue: 'turn',
};
colors.colorAdjust({id: 'adjusted', kind: 'colorAdjust', input: [.2, .3, .4], lightness: -.1, chroma: 1.2, hue: 25}, adjustmentNode) satisfies Vec3;
const edge = {feather: .2} satisfies MaskIntervalOptions;
const mark = {domain: domain.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), feather: [.1, .2, .3]} satisfies MaskChiselOptions;
mask.interval(grain, 0, 1, edge) satisfies ScalarExpression;
mask.chisel(mark) satisfies ScalarExpression;

// @ts-expect-error An adjustment takes a color input.
color.adjust(grain);
// @ts-expect-error Adjustment controls are scalar fields, not colors.
color.adjust(ink, {hue: ink});
// @ts-expect-error OKLCH authoring coordinates have exactly three components.
color.oklch([.6, .2]);
// @ts-expect-error Adjustment references are structural.
patchGraph(graph, {adjusted: {hue: 'other'}});
// @ts-expect-error Interval inputs are scalar fields.
mask.interval(ink, 0, 1);
// @ts-expect-error Chisel frames are domain expressions.
mask.chisel({domain: ink});

// @ts-expect-error Colors have their own sort; scalar-to-color conversion is explicit.
surface.material(scalar.parameter(.5));
// @ts-expect-error A palette color cannot be used as a roughness scalar.
surface.channels(surface.material(ink), {roughness: ink});
// @ts-expect-error Mix ports are color expressions, not RGB tuples.
color.mix([0, 0, 0], ink, grain);
// @ts-expect-error A color node is not a coordinate domain.
scalar.noise({domain: ink});
// @ts-expect-error Colors require exactly three components.
color.linear([.1, .2]);
// @ts-expect-error References are structural, not editable value patches.
patchGraph(graph, {grain: {domain: 'frame'}});
// @ts-expect-error Color value arrays are immutable.
ink.value[0] = .8;
// @ts-expect-error Ramp colors are color expressions, not raw RGB tuples.
color.ramp(grain, [[0, [0, 0, 0]], [1, ink]]);
// @ts-expect-error An authored stop always has a numeric position.
color.ramp(grain, [['start', ink], [1, mixed]]);
// @ts-expect-error Paint palette inputs are color expressions, not scalar fields.
surface.paint('carapace', {palette: {base: grain}});
// @ts-expect-error Supported interpolation spaces are explicit.
color.mix(ink, mixed, grain, {space: 'srgb'});
// @ts-expect-error Ramp stop references are structural.
patchGraph(graph, {color_ramp: {colors: ['ink', 'mixed']}});
// @ts-expect-error Interpolation changes the program and is not a value edit.
patchGraph(graph, {color_ramp: {interpolation: 'constant'}});
// @ts-expect-error Color reference lists are immutable.
ramp.colors[0] = ink;
