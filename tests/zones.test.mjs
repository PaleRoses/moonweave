import test from 'node:test';
import assert from 'node:assert/strict';
import {coverage} from '../src/core/coverage.mts';
import {zone, applyZones} from '../src/core/zones.mts';
import {
  scalar, color, surface, named, instantiate, expressionGraph, materialGraph,
  graphExpression, compileGraph, serializeGraph, parseGraph, createFieldSampler,
  evaluateScalar, patchGraph,
} from '../src/core.mjs';

const close = (actual, expected, tolerance = 1e-12) =>
  assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const value = expression => createFieldSampler(expression)().value;

test('bounded coverages obey soft intersection, union and subtraction rather than Boolean idempotence', () => {
  assert.equal(value(coverage.intersect(.5, .5)), .25);
  assert.equal(value(coverage.union(.5, .5)), .75);
  assert.equal(value(coverage.subtract(.5, .5)), .25);
  for (const a of [0, 1e-18, .13, .5, .91, 1]) {
    assert.equal(value(coverage.union(a, 0)), a);
    assert.equal(value(coverage.union(0, a)), a);
    assert.equal(value(coverage.intersect(a, 1)), a);
    assert.equal(value(coverage.intersect(a, 0)), 0);
    for (const b of [0, .2, .67, 1]) {
      const sum = value(coverage.union(a, b)), product = value(coverage.intersect(a, b));
      assert(sum >= 0 && sum <= 1);
      assert(product >= 0 && product <= 1);
      close(sum, 1 - (1 - a) * (1 - b));
      close(sum, value(coverage.union(b, a)));
      close(product, value(coverage.intersect(b, a)));
      close(value(coverage.subtract(a, b)), a * (1 - b));
      for (const c of [.01, .43, 1]) {
        close(value(coverage.union(coverage.union(a, b), c)), value(coverage.union(a, coverage.union(b, c))));
        close(value(coverage.intersect(coverage.intersect(a, b), c)), value(coverage.intersect(a, coverage.intersect(b, c))));
      }
    }
  }
});

test('coverage composition carries every input differential and has no hidden remapping', () => {
  const a = scalar.ramp(scalar.axis('x')), b = scalar.ramp(scalar.axis('y'));
  const context = {position: [.25, .6, 0], dx: [1, 0, 0], dy: [0, 1, 0]};
  const A = createFieldSampler(a)(context), B = createFieldSampler(b)(context);
  const expected = {
    union: [A.value + (1 - A.value) * B.value, (1 - B.value) * A.dx, (1 - A.value) * B.dy],
    intersect: [A.value * B.value, B.value * A.dx, A.value * B.dy],
    subtract: [A.value * (1 - B.value), (1 - B.value) * A.dx, -A.value * B.dy],
  };
  for (const [operation, components] of Object.entries(expected)) {
    const sample = createFieldSampler(coverage[operation](a, b))(context);
    for (const [index, key] of ['value', 'dx', 'dy'].entries()) close(sample[key], components[index]);
  }
  const complement = createFieldSampler(coverage.complement(a))(context);
  close(complement.value, 1 - A.value);
  close(complement.dx, -A.dx);
  assert.equal(value(coverage.union(.2, 0)), .2);
  // Bounded inputs are the documented precondition; this is not a clamp API.
  assert.equal(value(coverage.complement(2)), -1);
});

test('zone application has an exact empty identity and ordered concatenation', () => {
  const base = surface.paint('carapace');
  assert.equal(applyZones(base, []), base);
  assert.equal(applyZones(base, [zone('unused', .4)]), base);
  const first = zone('oxide', scalar.ramp(scalar.axis('y'), -.4, .7), {
    color: color.srgb('#517e70'), channels: {roughness: .8},
  });
  const second = zone('edge', scalar.ramp(scalar.axis('x'), -.2, .3), {
    color: color.srgb('#d9bd86'), height: .05,
  });
  const direct = applyZones(base, [first, second]);
  const composed = applyZones(applyZones(base, [first]), [second]);
  assert.equal(serializeGraph(direct), serializeGraph(composed));
  assert.equal(compileGraph(direct).programKey, compileGraph(composed).programKey);
  assert.notEqual(compileGraph(direct).programKey, compileGraph(applyZones(base, [second, first])).programKey);
  assert.equal(compileGraph(direct).cost.paintSamples, 1);
  assert.equal(compileGraph(direct).cost.textureReads, 4);
});

test('zone height includes the boundary product term even when the deposited height is uniform', () => {
  const x = scalar.axis('x'), y = scalar.axis('y'), mask = scalar.ramp(x);
  const base = surface.paint();
  const graph = materialGraph(applyZones(base, [zone('raised', mask, {height: scalar.multiply(x, y)})]));
  const height = graph.nodes.at(-1).height;
  const context = {position: [.25, .6, 0], dx: [1, 0, 0], dy: [0, 1, 0]};
  const sample = evaluateScalar(graph, height, context);
  close(sample.value, .0234375);
  close(sample.dx, .2625);
  close(sample.dy, .0390625);
  assert.notEqual(sample.dx, .15625 * .6);
  const uniform = materialGraph(applyZones(base, [zone('raised', mask, {height: .2})]));
  assert.equal(compileGraph(uniform).nodes.filter(node => node.kind === 'bump').length, 1);
  close(evaluateScalar(uniform, uniform.nodes.at(-1).height, context).dx, .225);
});

test('application labels preserve explicit graph names and one shared mask through instancing', () => {
  const gain = named('gain', scalar.parameter(.6));
  const shared = named('region', scalar.multiply(scalar.ramp(scalar.axis('y')), gain));
  const first = zone('patina', shared, {color: color.srgb('#4a8175')});
  const second = zone('wear', shared, {channels: {metalness: .7}});
  const expression = applyZones(surface.paint(), [first, second]);
  const graph = materialGraph(expression);
  assert.equal(graph.nodes.filter(node => node.id === 'gain').length, 1);
  assert.equal(graph.nodes.filter(node => node.kind === 'ramp').length, 1);
  assert.equal(first.coverage, shared);
  assert.equal(second.coverage, shared);
  assert.equal(first.name, 'patina');
  assert.equal(second.name, 'wear');
  assert(graph.nodes.some(node => node.id === 'region'));
  assert(!graph.nodes.some(node => node.id === 'patina' || node.id === 'wear'));
  const restored = graphExpression(parseGraph(serializeGraph(graph)));
  const prefixed = materialGraph(instantiate(restored, {prefix: 'shell'}));
  for (const id of ['gain', 'region']) assert(prefixed.nodes.some(node => node.id === `shell_${id}`));
  assert.equal(serializeGraph(restored), serializeGraph(graph));
  const edited = patchGraph(graph, {gain: {value: .9}});
  assert.equal(compileGraph(graph).structure, compileGraph(edited).structure);
  close(evaluateScalar(edited, 'region', {position: [0, .5, 0]}).value, .45);
});

test('one zone snapshot preserves raw roots and descendants across every effect', () => {
  const gain = {id: 'gain', kind: 'parameter', value: .4};
  const shared = {id: 'region', kind: 'multiply', a: {kind: 'axis', axis: 'x'}, b: gain};
  const rawColor = {kind: 'colorMix', a: {kind: 'color', value: [.1, .2, .3]},
    b: {kind: 'color', value: [.5, .6, .7]}, mask: gain};
  const effects = {color: rawColor, height: shared,
    channels: {roughness: shared, metalness: {kind: 'complement', input: gain}}};
  const application = zone('wash', shared, effects);
  assert.equal(application.coverage, application.height);
  assert.equal(application.coverage, application.channels.roughness);
  assert.equal(application.coverage.b, application.color.mask);
  assert.equal(application.coverage.b, application.channels.metalness.input);
  assert.equal(application.coverage.id, 'region');
  assert(Object.isFrozen(application.coverage.b));
  assert(Object.isFrozen(application.color.a.value));
  assert(!Object.isFrozen(effects));
  assert(!Object.isFrozen(shared));
  assert(!Object.isFrozen(gain));
  gain.value = .9;
  shared.a.axis = 'y';
  rawColor.a.value[0] = .9;
  effects.channels.roughness = 0;
  const graph = materialGraph(applyZones(surface.material(color.linear([.3, .4, .5])), [application]));
  assert.equal(graph.nodes.filter(node => node.id === 'gain').length, 1);
  assert.equal(graph.nodes.filter(node => node.id === 'region').length, 1);
  assert.equal(evaluateScalar(graph, 'region', {position: [.5, 0, 0]}).value, .2);
  assert.equal(evaluateScalar(patchGraph(graph, {gain: {value: .6}}), 'region', {position: [.5, 0, 0]}).value, .3);
  assert.equal(application.color.a.value[0], .1);
  assert.equal(application.channels.roughness, application.coverage);
});

test('unnamed raw editable roots remain one control wherever the zone uses them', () => {
  const raw = {kind: 'parameter', value: .2};
  const application = zone('deposit', raw, {height: raw, channels: {roughness: raw}});
  assert.equal(application.coverage, application.height);
  assert.equal(application.coverage, application.channels.roughness);
  assert.equal(application.coverage.id, undefined);
  assert.notEqual(application.coverage, raw);
  const graph = materialGraph(applyZones(surface.material(color.linear([.3, .4, .5])), [application]));
  assert.equal(graph.nodes.filter(node => node.kind === 'parameter').length, 1);
});

test('zone ownership snapshots author data while borrowing already-owned graph expressions', () => {
  const rawColor = {kind: 'color', value: [.1, .2, .3]};
  const rawHeight = {kind: 'parameter', value: .05};
  const shared = named('shared', scalar.parameter(.4));
  const values = {roughness: shared};
  const effects = {color: rawColor, channels: values, height: rawHeight};
  const application = zone('testZone', shared, effects);
  assert(Object.isFrozen(application));
  assert(Object.isFrozen(application.channels));
  assert.equal(application.channels.roughness, shared);
  assert.equal(Object.isFrozen(effects), false);
  assert.equal(Object.isFrozen(values), false);
  assert.equal(Object.isFrozen(rawColor.value), false);
  assert.equal(Object.isFrozen(rawHeight), false);
  rawColor.value[0] = .9;
  rawHeight.value = 7;
  values.roughness = 0;
  assert.deepEqual(application.color.value, [.1, .2, .3]);
  assert.equal(application.height.value, .05);
  assert.equal(application.channels.roughness, shared);
  const graph = expressionGraph(applyZones(surface.material(color.linear([.3, .4, .5])), [application]));
  assert.equal(graph.nodes.filter(node => node.id === 'shared').length, 1);
});

test('literal absent zones specialize away while editable zero coverage remains live', () => {
  const base = surface.paint(), baseline = compileGraph(base);
  const effects = {color: color.srgb('#c2af7c'), channels: {metalness: .8}, height: scalar.axis('x')};
  const absent = compileGraph(applyZones(base, [zone('absent', 0, effects)]));
  assert.equal(absent.programKey, baseline.programKey);
  assert.deepEqual(absent.cost, baseline.cost);
  const graph = materialGraph(applyZones(base, [zone('deposit', named('amount', scalar.parameter(0)), effects)]));
  const before = compileGraph(graph), after = compileGraph(patchGraph(graph, {amount: {value: .7}}));
  assert.equal(before.structure, after.structure);
  assert.equal(before.programKey, after.programKey);
  assert(before.nodes.some(node => node.kind === 'coat'));
  assert(before.nodes.some(node => node.kind === 'bump'));
});

test('zone boundaries reject misspelled effect channels and malformed application lists', () => {
  assert.throws(() => zone('invalid name', .5), /node ID/);
  assert.throws(() => zone('valid', .5, {roughness: .2}), /Unknown zone effects property/);
  assert.throws(() => zone('valid', .5, {channels: {metallic: .2}}), /Unknown zone channels property/);
  assert.throws(() => applyZones(surface.paint(), {}), /ordered array/);
  const application = zone('coat', 1, {color: color.srgb('#203040')});
  for (const applications of [new Array(1), [application, , application], [application, undefined]]) {
    assert.throws(() => applyZones(surface.paint(), applications), TypeError);
  }
});
