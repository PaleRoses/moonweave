import test from 'node:test';
import assert from 'node:assert/strict';
import {scalar, color, domain, named, createFieldSampler} from '../src/core.mjs';

const close = (actual, expected, tolerance = 2e-6) =>
  assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('constant-color samples cannot mutate default contexts in another sampler', () => {
  const pigment = createFieldSampler(color.srgb('#123456'));
  const sample = pigment();
  assert.equal(Object.isFrozen(sample), true);
  for (const vector of [sample.value, sample.dx, sample.dy]) {
    assert.equal(Object.isFrozen(vector), true);
    assert.throws(() => { vector[0] = 9; }, TypeError);
  }
  assert.deepEqual(createFieldSampler(scalar.axis('x'))(), {value: 0, dx: 0, dy: 0});
  assert.deepEqual(pigment().dx, [0, 0, 0]);
  assert.deepEqual(pigment().dy, [0, 0, 0]);
});

test('literal annihilation agrees with the compiler without sampling an overflowing branch', () => {
  const x = scalar.axis('x'), overflow = scalar.multiply(x, x);
  const zeros = [scalar.constant(0), scalar.add(2, -2), scalar.complement(1), scalar.multiply(0, 5)];
  for (const zero of zeros) for (const height of [scalar.multiply(zero, overflow), scalar.multiply(overflow, zero)]) {
    assert.deepEqual(createFieldSampler(height)({position: [1e20, 0, 0], dx: [1, 0, 0]}),
      {value: 0, dx: 0, dy: 0});
  }
});

test('current zero parameters and zero-valued varying fields retain their demand and tangents', () => {
  const x = scalar.axis('x');
  assert.throws(() => createFieldSampler(scalar.multiply(scalar.parameter(0), scalar.multiply(x, x)))({
    position: [1e20, 0, 0],
  }), /evaluated scalar/);
  const sample = createFieldSampler(scalar.multiply(x, scalar.parameter(3)))({
    position: [0, .25, 0], dx: [.5, 0, 0], dy: [-.25, 0, 0],
  });
  assert.deepEqual(sample, {value: 0, dx: 1.5, dy: -.75});
});

test('a varying height mask contributes its full product derivative', () => {
  const x = scalar.axis('x'), y = scalar.axis('y');
  const height = scalar.multiply(scalar.ramp(y, 0, 1), scalar.multiply(x, x));
  const sample = createFieldSampler(height)({position: [.5, .5, 0], dx: [1, 0, 0], dy: [0, 1, 0]});
  assert.deepEqual(sample, {value: .125, dx: .5, dy: .375});
  // Modulating the already-derived x² slope would have no y derivative.
  assert.notEqual(sample.dy, 0);
});

test('composed height tangents agree with finite differences of transformed fields', () => {
  const frame = domain.transform([
    1.5, .25, 0, 0, -.125, .75, .25, 0, .25, 0, 1.25, 0, .125, -.25, .375, 1,
  ]);
  const grain = scalar.noise({seed: 37, domain: frame});
  const height = scalar.multiply(named('amplitude', scalar.parameter(.125)), scalar.add(
    scalar.multiply(scalar.ramp(scalar.axis('y', frame), -.75, .75), grain),
    scalar.multiply(.2, scalar.facing([-.5, .25, 1], frame)),
  ));
  const sample = createFieldSampler(height);
  const context = {
    position: [.125, -.25, .375], normal: [.25, .875, -.125],
    dx: [.03125, -.0625, .015625], dy: [-.015625, .03125, .0625],
    normalDx: [.015625, -.03125, .0625], normalDy: [-.03125, .015625, .03125],
  };
  const result = sample(context), epsilon = 1e-4;
  for (const axis of ['x', 'y']) {
    const displaced = sign => sample({
      position: context.position.map((value, index) => value + sign * epsilon * context[`d${axis}`][index]),
      normal: context.normal.map((value, index) => value + sign * epsilon * context[`normalD${axis}`][index]),
    }).value;
    close(result[`d${axis}`], (displaced(1) - displaced(-1)) / (2 * epsilon));
  }
});

test('height addition and constant offsets obey differential linearity', () => {
  const first = scalar.multiply(.125, scalar.noise({seed: 17}));
  const second = scalar.multiply(scalar.axis('x'), scalar.axis('y'));
  const a = createFieldSampler(first), b = createFieldSampler(second);
  const sum = createFieldSampler(scalar.add(first, second));
  const shifted = createFieldSampler(scalar.add(scalar.add(first, second), scalar.parameter(7)));
  for (const position of [[.125, -.25, .375], [-.375, .3125, -.625], [1.25, -1.5, 2.375]]) {
    const context = {position, dx: [.03125, -.0625, .015625], dy: [-.015625, .03125, .0625]};
    const left = a(context), right = b(context), combined = sum(context), offset = shifted(context);
    for (const axis of ['dx', 'dy']) {
      assert.equal(combined[axis], left[axis] + right[axis]);
      assert.equal(offset[axis], combined[axis]);
    }
  }
});
