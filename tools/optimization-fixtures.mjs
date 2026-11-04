/** Modular surface programs exercising overwrite elimination and retained DAG work. */
import {color, domain, image, materialGraph, named, scalar, surface} from '../src/core.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const replacement = image.generate({width: 5, height: 3, channels: 3}, (u, v) =>
  [.125 + u * v, 1 - u, v * v]).resource;
const smallReplacement = image.data({width: 1, height: 1, channels: 3, data: [.2, .65, -.25]}).resource;
const editedFrame = [1.5, .25, 0, 0, -.125, .75, 0, 0, 0, 0, 1, 0, -.125, .0625, 0, 1];

function fixture(id, label, {sharedImage = false, sharedBranch = false} = {}) {
  const atlas = named('roughAtlas', image.generate({width: 32, height: 16, channels: 3}, (u, v) => {
    const mark = .5 + .35 * Math.sin(12 * Math.PI * u) * Math.cos(8 * Math.PI * v);
    return [mark, .12 + .65 * u, .08 + .7 * v * (.5 + .5 * Math.sin(4 * Math.PI * u))];
  }));
  const frame = named('roughFrame', domain.transform(identity));
  const sample = {domain: frame, address: 'zero', filter: 'anisotropic'};
  const oldGain = named('oldGain', scalar.parameter(.5));
  const oldBias = named('oldBias', scalar.parameter(.1));
  const oldRoughness = named('moduleRoughness', scalar.add(
    scalar.multiply(oldGain, scalar.image(atlas, {...sample, channel: 'r'})), oldBias,
  ));
  const base = named('base', surface.paint('carapace'));
  const module = named('module', surface.channels(base, {roughness: oldRoughness}));
  const pigment = named('pigment', sharedImage ? color.image(atlas, sample) : color.srgb('#375f8c'));
  const coverage = named('coverage', scalar.parameter(.65));
  const depth = named('depth', scalar.parameter(.003));
  const height = named('height', scalar.multiply(depth, sharedImage
    ? scalar.image(atlas, {...sample, channel: 'b'})
    : named('grain', scalar.noise({seed: 23}))));
  const decoration = named('decoration', surface.bump(surface.coat(module, pigment, coverage), height));
  const creatureRoughness = named('creatureRoughness', scalar.parameter(.5));
  const glaze = named('glaze', scalar.parameter(.22));
  const left = named('left', surface.channels(decoration, {roughness: creatureRoughness, clearcoat: glaze}));
  const right = sharedBranch ? named('right', surface.coat(module, color.srgb('#c6a16a'),
    named('rightCoverage', scalar.parameter(.35)))) : undefined;
  const graph = materialGraph(sharedBranch
    ? surface.mix(left, right, named('branchWeight', scalar.parameter(.4))) : left);
  const patches = [
    {},
    {oldGain: {value: 0}, creatureRoughness: {value: 0}},
    {oldGain: {value: 1.25}, oldBias: {value: -.3}, creatureRoughness: {value: .83},
      depth: {value: -.002}, coverage: {value: .9}, glaze: {value: .05}},
    {roughAtlas: {resource: replacement}, roughFrame: {matrix: editedFrame},
      creatureRoughness: {value: 1}, ...(sharedBranch ? {branchWeight: {value: 0}} : {})},
    {roughAtlas: {resource: smallReplacement}, oldGain: {value: -.5}, oldBias: {value: .7},
      depth: {value: .005}, ...(sharedBranch ? {branchWeight: {value: 1}, rightCoverage: {value: .8}} : {})},
  ];
  const paint = {base: {color: [.27, .44, .35], slope: [.03, -.02],
    roughness: .58, metalness: .08, clearcoat: .12, opacity: 1}};
  return {id, label, graph, patches, paint,
    observations: ['moduleRoughness', 'module', 'decoration', 'left', ...(sharedBranch ? ['right'] : [])],
    expected: {imageRetained: sharedImage || sharedBranch, strictImprovement: !sharedBranch}};
}

export function optimizationFixtures() {
  return [
    fixture('independent', 'An independent anisotropic finish overridden across coat and bump'),
    fixture('shared-image', 'The same atlas remains live for pigment and height', {sharedImage: true}),
    fixture('shared-branch', 'A mixed branch still consumes the shared module finish', {sharedBranch: true}),
  ];
}

/** Boundary, footprint and directional-derivative choices are independent. */
export function optimizationContexts() {
  const positions = [[-.125, .4375, .25], [0, 0, 0], [.03125, .0625, -.125], [.37, .61, .25],
    [.5, .5, 0], [.96875, .9375, .125], [1, 1, 0], [1.125, .4375, -.25], [4, -3, .5]];
  const footprints = [undefined, {dx: [0, 0, 0], dy: [0, 0, 0]},
    {dx: [.25, .0625, 0], dy: [-.015625, .0625, 0]},
    {dx: [2, .125, 0], dy: [.00390625, .0078125, 0]},
    {dx: [4, 1, 0], dy: [-.25, 4, 0]}];
  return positions.flatMap((position, index) => footprints.map(footprint => ({
    position, normal: [.25 + .125 * (index % 3), 1, -.25 + .125 * (index % 2)],
    dx: [.03125, .015625, -.0078125], dy: [-.015625, .0625, .03125],
    normalDx: [.125, -.03125, .0625], normalDy: [.03125, .0625, -.125],
    ...(footprint === undefined ? {} : {footprint}),
  })));
}
