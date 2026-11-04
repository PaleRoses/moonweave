import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scalar, color, image, domain, surface, named, expressionGraph, materialGraph,
} from '../src/core.mjs';
import {compareGraphs} from '../tools/compare-graphs.mjs';

const contexts = [
  {position: [0, 0, 0], normal: [0, 0, 1], dx: [.125, .03125, 0], dy: [-.0625, .25, .125]},
  {position: [.37, .61, .125], normal: [.25, .5, 1], dx: [.125, .03125, 0], dy: [-.0625, .25, .125],
    normalDx: [.03125, -.0625, 0], normalDy: [0, .03125, .0625],
    footprint: {dx: [.5, .125, 0], dy: [-.015625, .0625, 0]}},
  {position: [-.125, 1.125, -.25], normal: [1, .125, -.25], dx: [1, .25, -.125], dy: [-.125, .5, .25],
    footprint: {dx: [2, .5, 0], dy: [0, 2, 0]}},
];
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('simulation compares value and differential components and retains a replayable counterexample', () => {
  const suite = structuredClone(contexts), original = structuredClone(suite);
  const result = compareGraphs(scalar.axis('x'), scalar.constant(0), {contexts: suite.slice(0, 1)});
  assert.equal(result.equal, false);
  assert.equal(result.counterexample.component, 'dx');
  assert.equal(result.counterexample.before, .125);
  assert.equal(result.counterexample.after, 0);
  assert.equal(result.components, 3);
  assert.equal(result.evidence, 'finite-observations');
  assert.match(result.scope, /not a universal proof/);
  assert.deepEqual(suite, original);
  suite[0].dx[0] = 2;
  assert.equal(result.counterexample.sampleContext.dx[0], .125);
});

test('simulation observes domain normals and explicit footprints independently of calculus directions', () => {
  const frame = named('frame', domain.transform(identity));
  const result = compareGraphs(frame, frame, {contexts});
  assert.equal(result.equal, true);
  assert.equal(result.components, 66); // 18 domain components; two six-component footprints.
  const matrix = [...identity]; matrix[0] = 2;
  const changed = compareGraphs(domain.transform(matrix), frame, {
    contexts: [{position: [0, 0, 0], footprint: {dx: [.25, 0, 0], dy: [0, .125, 0]}}],
  });
  assert.equal(changed.counterexample.component, 'footprint.dx.0');
  assert.equal(changed.maxAbsoluteDifference, .25);
});

test('simulation does not accept reassociation or cancelling nested floating complements', () => {
  const a = scalar.parameter(1e20), b = scalar.parameter(-1e20), c = scalar.parameter(1);
  const associativity = compareGraphs(scalar.add(scalar.add(a, b), c), scalar.add(a, scalar.add(b, c)));
  assert.equal(associativity.equal, false);
  assert.deepEqual([associativity.counterexample.before, associativity.counterexample.after], [1, 0]);
  const tiny = scalar.parameter(2 ** -60);
  const complement = compareGraphs(scalar.complement(scalar.complement(tiny)), tiny);
  assert.equal(complement.equal, false);
  assert.equal(complement.maxAbsoluteDifference, 2 ** -60);
});

test('simulation rejects filtering a correlated product after independently filtering its factors', () => {
  const packed = image.generate({width: 8, height: 8, channels: 3}, (_u, _v, x, y) => {
    const mask = (x + y) % 2;
    return [mask, mask * mask, mask];
  });
  const read = channel => scalar.image(packed, {channel, filter: 'trilinear', address: 'repeat'});
  const result = compareGraphs(read('g'), scalar.multiply(read('r'), read('b')), {
    contexts: [{position: [.37, .61, 0], dx: [.125, 0, 0], dy: [0, .25, 0],
      footprint: {dx: [1, 0, 0], dy: [0, 1, 0]}}],
  });
  assert.equal(result.equal, false);
  assert.deepEqual([result.counterexample.before, result.counterexample.after], [.5, .25]);
});

test('independent value edits refute merging currently equal editable leaves', () => {
  const before = expressionGraph(named('sum', scalar.add(
    named('left', scalar.parameter(.5)), named('right', scalar.parameter(.5)),
  )));
  const after = expressionGraph({...before,
    nodes: before.nodes.map(node => node.id === 'sum' ? {...node, b: 'left'} : node),
  });
  assert.equal(compareGraphs(before, after).equal, true);
  const result = compareGraphs(before, after, {patches: [{}, {right: {value: .25}}]});
  assert.equal(result.equal, false);
  assert.equal(result.counterexample.revision, 1);
  assert.deepEqual([result.counterexample.before, result.counterexample.after], [.75, 1]);
  assert.deepEqual(result.counterexample.patch, {right: {value: .25}});
});

test('surface output observations see finish, pigment and differential wiring across filtered edits', () => {
  const pixels = named('pixels', image.generate({width: 8, height: 4, channels: 3}, (u, v) => [u, v, u * v]));
  const frame = named('frame', domain.transform(identity));
  const height = named('height', scalar.multiply(named('depth', scalar.parameter(.125)),
    scalar.image(pixels, {domain: frame, channel: 'b', filter: 'anisotropic', address: 'zero'})));
  const pigment = color.image(pixels, {domain: frame, filter: 'trilinear', address: 'repeat'});
  const finish = named('finish', scalar.parameter(.4));
  const base = surface.bump(surface.material(color.linear([.1, .2, .3])), height);
  const before = materialGraph(surface.coat(surface.channels(base, {roughness: finish}), pigment, .6));
  const after = materialGraph(surface.channels(surface.coat(base, pigment, .6), {roughness: finish}));
  const matrix = [...identity]; matrix[0] = 1.5; matrix[5] = .75; matrix[12] = -.125;
  const result = compareGraphs(before, after, {contexts, patches: [
    {}, {finish: {value: -.5}}, {finish: {value: 1.5}, depth: {value: -.25}, frame: {matrix}},
  ]});
  assert.equal(result.equal, true);
  assert.equal(result.samples, 9);
  assert.equal(result.components, 81);
  const bad = materialGraph(surface.channels(surface.coat(base, pigment, .6), {metalness: finish}));
  const wrongLane = compareGraphs(before, bad, {contexts});
  assert.equal(wrongLane.equal, false);
  assert.equal(wrongLane.counterexample.component, 'roughness');
});

test('surface simulation requires explicit opaque paint values and does not invent a renderer', () => {
  const base = named('paint', surface.paint('carapace'));
  const field = scalar.axis('x'), tint = color.linear([1.4, -.2, .35]);
  const before = surface.relief(surface.coat(base, tint, .4), field);
  const after = surface.coat(surface.relief(base, field), tint, .4);
  assert.throws(() => compareGraphs(before, after, {contexts}), /opaque paint record for paint/);
  const paint = {paint: {color: [.2, .3, .4], slope: [-.125, .25],
    roughness: .6, metalness: .1, clearcoat: .3, opacity: .7}};
  const saved = structuredClone(paint);
  assert.equal(compareGraphs(before, after, {contexts, paint}).equal, true);
  assert.deepEqual(paint, saved);
  const noncommuting = compareGraphs(surface.relief(surface.bump(base, field), 2),
    surface.bump(surface.relief(base, 2), field), {contexts, paint});
  assert.equal(noncommuting.equal, false);
  assert.equal(noncommuting.counterexample.component, 'slope.0');
});

test('observations can retain an independently named shared branch and reveal an overridden edit', () => {
  const old = named('old', scalar.parameter(.2)), next = named('next', scalar.parameter(.7));
  const shared = named('shared', surface.channels(surface.material(color.linear([.2, .4, .6])), {roughness: old}));
  const before = materialGraph(named('original', surface.channels(shared, {roughness: next})));
  const after = materialGraph({...before, nodes: [...before.nodes,
    {id: 'optimized', kind: 'channels', input: before.nodes.find(node => node.kind === 'material').id,
      values: {roughness: 'next'}},
  ], output: 'optimized'});
  const result = compareGraphs(before, after, {contexts, patches: [{}, {old: {value: .9}}],
    observations: [{before: 'original', after: 'optimized', label: 'output'}, 'shared']});
  assert.equal(result.equal, true);
  assert.equal(result.samples, 12);
  const reveal = compareGraphs(before, after, {patches: [{old: {value: .9}}],
    observations: [{before: 'shared', after: 'optimized', label: 'reveal'}]});
  assert.equal(reveal.equal, false);
  assert.deepEqual([reveal.counterexample.before, reveal.counterexample.after], [.9, .7]);
});

test('empty suites, incompatible observations and evaluation failures cannot report equivalence', () => {
  assert.throws(() => compareGraphs(scalar.constant(1), scalar.constant(1), {contexts: []}), /require/);
  assert.throws(() => compareGraphs(scalar.constant(1), color.linear([1, 1, 1])), /sorts differ/);
  assert.throws(() => compareGraphs(scalar.axis('x'), scalar.axis('x'), {contexts: [{position: [NaN, 0, 0]}]}), /finite/);
});
