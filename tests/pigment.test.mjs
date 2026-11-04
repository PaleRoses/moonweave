import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pigment} from '../src/color/pigment.mts';
import {BASE_SPECTRA, CIE_D65, XYZ_TO_RGB} from '../src/color/spectral-data.mjs';
import {color, expressionGraph, serializeGraph, parseExpressionGraph} from '../src/core/graph.mts';
import {createFieldSampler} from '../src/core/evaluate.mts';

const close = (a, b, tolerance = 1e-12) => assert(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b)), `${a} differs from ${b}`);
const vectorsClose = (a, b, tolerance) => { assert.equal(a.length, b.length); a.forEach((value, i) => close(value, b[i], tolerance)); };
const quantitiesClose = (a, b) => { close(a.concentration, b.concentration); vectorsClose(a.weightedKS, b.weightedKS); };

test('spectral lifting and mixing match 70 independently executed upstream cases', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/spectral-3.json', import.meta.url), 'utf8'));
  const tableHash = createHash('sha256').update(JSON.stringify({BASE_SPECTRA, CIE_D65, XYZ_TO_RGB})).digest('hex');
  assert.equal(tableHash, fixture.provenance.tableSha256);
  assert.equal(fixture.cases.length, 70);
  for (const {a, b, strengthA, strengthB, t, linear} of fixture.cases) {
    const first = pigment.srgb(a, {tintingStrength: strengthA});
    const second = pigment.srgb(b, {tintingStrength: strengthB});
    vectorsClose(pigment.toLinear(pigment.mix(first, second, t)), linear);
  }
});

test('add and scale obey additive spectral quantity laws before projection', () => {
  const a = pigment.srgb('#4d91b4'), b = pigment.srgb('#d0a54b'), c = pigment.srgb('#e3ccd0');
  const zero = pigment.add();
  assert.equal(pigment.add(zero, a), a);
  assert.equal(pigment.add(a, zero), a);
  assert.equal(pigment.scale(a, 0), zero);
  assert.equal(pigment.scale(a, 1), a);
  quantitiesClose(pigment.add(a, b), pigment.add(b, a));
  quantitiesClose(pigment.add(pigment.add(a, b), c), pigment.add(a, pigment.add(b, c)));
  quantitiesClose(pigment.scale(pigment.add(a, b), .37), pigment.add(pigment.scale(a, .37), pigment.scale(b, .37)));
  quantitiesClose(pigment.scale(pigment.scale(a, .25), 3), pigment.scale(a, .75));
  quantitiesClose(pigment.scale(a, .2 + .7), pigment.add(pigment.scale(a, .2), pigment.scale(a, .7)));
  vectorsClose(pigment.toLinear(pigment.scale(pigment.add(a, b, c), 137)), pigment.toLinear(pigment.add(a, b, c)));
});

test('mixtures retain their quantities through grouping and differ from RGB reprojection', () => {
  const a = pigment.srgb('#315e79'), b = pigment.srgb('#dcc878'), c = pigment.srgb('#e6475a');
  const batch = pigment.add(pigment.scale(a, .4), pigment.scale(b, .6));
  const grouped = pigment.add(pigment.scale(batch, 2), c);
  const flat = pigment.add(pigment.scale(a, .8), pigment.scale(b, 1.2), c);
  vectorsClose(pigment.toLinear(grouped), pigment.toLinear(flat));
  const lossy = pigment.add(pigment.scale(pigment.linear(pigment.toLinear(batch)), 2), c);
  assert(pigment.toLinear(grouped).some((value, i) => Math.abs(value - pigment.toLinear(lossy)[i]) > .001));
});

test('quadratic blend is symmetric with a complemented parameter but not associative', () => {
  const a = pigment.srgb('#315e79'), b = pigment.srgb('#dcc878'), c = pigment.srgb('#e6475a');
  assert.equal(pigment.mix(a, b, 0), a);
  assert.equal(pigment.mix(a, b, 1), b);
  quantitiesClose(pigment.mix(a, b, .3), pigment.mix(b, a, .7));
  vectorsClose(pigment.toLinear(pigment.mix(a, a, .29)), pigment.toLinear(a));
  const left = pigment.toLinear(pigment.mix(pigment.mix(a, b, .5), c, .5));
  const right = pigment.toLinear(pigment.mix(a, pigment.mix(b, c, .5), .5));
  assert(left.some((value, i) => Math.abs(value - right[i]) > .01));
});

test('stable K/S inversion retains dark reflectance instead of cancellation to zero', () => {
  const black = pigment.reflectance(new Float64Array(38));
  const darkerThanDisplay = pigment.toLinear(black);
  assert(darkerThanDisplay.every(value => value > 0 && value < 3e-16));
  const white = pigment.toLinear(pigment.reflectance(Array(38).fill(1)));
  for (const reflectance of [Number.EPSILON, 1e-12, 1e-8, .01, .2, .999999]) {
    const actual = pigment.toLinear(pigment.reflectance(Array(38).fill(reflectance)));
    actual.forEach((value, i) => assert(Math.abs(value - white[i] * reflectance) <= reflectance * 1e-12));
  }
});

test('measured spectra are snapshotted and projected without gamut clipping', () => {
  const source = new Float64Array(38).fill(.3), quantity = pigment.reflectance(source);
  const original = pigment.toLinear(quantity);
  source.fill(.7);
  assert.deepEqual(pigment.toLinear(quantity), original);
  assert(Object.isFrozen(quantity));
  assert(Object.isFrozen(quantity.weightedKS));
  assert(Object.isFrozen(original));
  assert.throws(() => { quantity.weightedKS[0] = 42; }, TypeError);
  const narrowBand = pigment.reflectance(Array.from({length: 38}, (_, i) => i === 15 ? 1 : 0));
  assert(pigment.toLinear(narrowBand).some(component => component < 0));
});

test('pigment color projects once into the existing serializable Color expression', () => {
  const mixture = pigment.mix(pigment.srgb('#dcc878'), pigment.srgb('#315e79'), .5);
  const expression = pigment.color(mixture), graph = expressionGraph(expression);
  assert.equal(expression.kind, 'color');
  assert.equal(graph.nodes.length, 1);
  assert.deepEqual(expression, color.linear(pigment.toLinear(mixture)));
  assert.deepEqual(parseExpressionGraph(serializeGraph(graph)), graph);
  const sample = createFieldSampler(expression)();
  assert.deepEqual(sample.value, pigment.toLinear(mixture));
  assert.deepEqual(sample.dx, [0, 0, 0]);
  assert.deepEqual(sample.dy, [0, 0, 0]);
});

test('empty pigment is an additive identity and has no implicit color', () => {
  const zero = pigment.add(), a = pigment.srgb('#315e79');
  assert.equal(pigment.srgb('#315e79', {tintingStrength: 0}), zero);
  assert.equal(pigment.add(zero, zero), zero);
  assert.equal(pigment.scale(zero, 23), zero);
  assert.equal(pigment.mix(zero, a, 0), zero);
  assert.equal(zero.concentration, 0);
  assert(zero.weightedKS.every(value => value === 0));
  assert.throws(() => pigment.toLinear(zero), /empty pigment/);
  assert.throws(() => pigment.color(zero), /empty pigment/);
});

test('authoring rejects invalid spectra, weights and forged mutable quantities at the boundary', () => {
  const a = pigment.srgb('#315e79');
  for (const value of [[.3, .4], [.3, , .4], [-.1, .4, .5], [1.1, .4, .5], [NaN, .4, .5]]) {
    assert.throws(() => pigment.linear(value), /samples/);
  }
  assert.throws(() => pigment.srgb('#abc'), /six-digit hex/);
  assert.throws(() => pigment.reflectance(Array(37).fill(.5)), /38 samples/);
  assert.throws(() => pigment.reflectance(Array(38).fill(Infinity)), /finite values/);
  assert.throws(() => pigment.reflectance(Array(38).fill(1.01)), /\[0,1\]/);
  for (const tintingStrength of [-1, null, NaN, Infinity]) {
    assert.throws(() => pigment.srgb('#315e79', {tintingStrength}), /tinting strength/);
  }
  assert.throws(() => pigment.srgb('#315e79', {strength: 2}), /Unknown pigment options/);
  for (const amount of [-1, NaN, Infinity]) assert.throws(() => pigment.scale(a, amount), /Pigment amount/);
  for (const position of [-.1, 1.1, NaN]) assert.throws(() => pigment.mix(a, a, position), /mixture position/);
  assert.throws(() => pigment.add({...a}), /immutable quantity/);
  assert.throws(() => pigment.toLinear({concentration: 1, weightedKS: Array(38).fill(0)}), /immutable quantity/);
  assert.throws(() => pigment.scale(a, Number.MAX_VALUE), /finite numeric range/);
  assert.throws(() => pigment.srgb('#315e79', {tintingStrength: Number.MIN_VALUE}), /underflows/);
  assert.throws(() => pigment.scale(a, Number.MIN_VALUE), /underflows/);
});
