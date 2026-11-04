/*!
 * Spectral basis lifting and single-constant Kubelka–Munk mixing adapted from
 * Spectral.js 3.0.0, Copyright (c) 2025 Ronald van Wijnen, MIT License.
 * https://github.com/rvanwijnen/spectral.js/blob/3.0.0/spectral.js
 * Full notice: SPECTRAL-LICENSE.txt. Moonweave stores additive weighted K/S
 * moments, and uses a cancellation-free inverse. No display gamut mapping.
 */
import {color} from '../core/graph.mts';
import {record} from '../core/algebra.mts';
import {srgbToLinear} from '../core/color.mts';
import {BASE_SPECTRA, CIE_D65, XYZ_TO_RGB} from './spectral-data.mjs';

import type {Vec3, ColorExpression} from '../core/algebra.mts';

declare const pigmentQuantity: unique symbol;
export interface PigmentQuantity {
  readonly [pigmentQuantity]: true;
  readonly concentration: number;
  readonly weightedKS: readonly number[];
}
export interface PigmentOptions {readonly tintingStrength?: number}

const BANDS = 38;
const owned = new WeakSet<object>();
const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, value, i) => sum + value * b[i], 0);

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite nonnegative number.`);
  }
  return value;
}

function samples(value: ArrayLike<number>, length: number, label: string): number[] {
  if (value == null || value.length !== length) {
    throw new TypeError(`${label} requires ${length} samples.`);
  }
  return Array.from({length}, (_, index) => {
    const component = value[index];
    if (typeof component !== 'number' || !Number.isFinite(component) || component < 0 || component > 1) {
      throw new RangeError(`${label} samples must be finite values in [0,1].`);
    }
    return component;
  });
}

function quantity(concentration: number, weightedKS: number[]): PigmentQuantity {
  if (!Number.isFinite(concentration) || weightedKS.some(value => !Number.isFinite(value))) {
    throw new RangeError('Pigment concentration exceeds the finite numeric range.');
  }
  const result = Object.freeze({concentration, weightedKS: Object.freeze(weightedKS)}) as PigmentQuantity;
  owned.add(result);
  return result;
}

const zero = quantity(0, Array<number>(BANDS).fill(0));

function requireQuantity(value: PigmentQuantity): PigmentQuantity {
  if (!owned.has(value)) throw new TypeError('Expected an immutable quantity created by pigment.');
  return value;
}

function fromSpectrum(reflectance: readonly number[], options: PigmentOptions): PigmentQuantity {
  record(options, 'pigment options', ['tintingStrength']);
  const strength = nonnegative(options.tintingStrength === undefined ? 1 : options.tintingStrength,
    'Pigment tinting strength');
  if (strength === 0) return zero;
  const luminance = Math.max(Number.EPSILON, dot(CIE_D65[1], reflectance));
  const concentration = strength ** 2 * luminance;
  if (concentration === 0) throw new RangeError('Pigment concentration underflows the numeric range.');
  return quantity(concentration, reflectance.map(r => concentration * (1 - r) ** 2 / (2 * r)));
}

function linear(value: Vec3, options: PigmentOptions = {}): PigmentQuantity {
  const rgb = samples(value, 3, 'Linear pigment');
  const w = Math.min(...rgb), [red, green, blue] = rgb.map(channel => channel - w);
  const c = Math.min(green, blue), m = Math.min(red, blue), y = Math.min(red, green);
  const r = Math.max(0, Math.min(red - blue, red - green));
  const g = Math.max(0, Math.min(green - blue, green - red));
  const b = Math.max(0, Math.min(blue - green, blue - red));
  const reflectance = Array.from({length: BANDS}, (_, i) => Math.max(Number.EPSILON,
    w * BASE_SPECTRA.W[i] + c * BASE_SPECTRA.C[i] + m * BASE_SPECTRA.M[i]
    + y * BASE_SPECTRA.Y[i] + r * BASE_SPECTRA.R[i] + g * BASE_SPECTRA.G[i] + b * BASE_SPECTRA.B[i]));
  // The fitted white basis slightly exceeds 1 at some wavelengths. Preserve
  // upstream lifting here; the public measured-reflectance input remains [0,1].
  return fromSpectrum(reflectance, options);
}

function add(...quantities: readonly PigmentQuantity[]): PigmentQuantity {
  let total = 0, count = 0, single = zero;
  for (const value of quantities) {
    requireQuantity(value);
    if (value.concentration > 0) { total += value.concentration; single = value; count++; }
  }
  if (count === 0) return zero;
  if (count === 1) return single;
  const weightedKS = Array<number>(BANDS).fill(0);
  for (const value of quantities) {
    for (let i = 0; i < BANDS; i++) weightedKS[i] += value.weightedKS[i];
  }
  return quantity(total, weightedKS);
}

function scale(value: PigmentQuantity, amount: number): PigmentQuantity {
  requireQuantity(value);
  nonnegative(amount, 'Pigment amount');
  if (amount === 0 || value.concentration === 0) return zero;
  if (amount === 1) return value;
  const concentration = value.concentration * amount;
  if (concentration === 0) throw new RangeError('Pigment concentration underflows the numeric range.');
  return quantity(concentration, value.weightedKS.map(sample => sample * amount));
}

function mix(a: PigmentQuantity, b: PigmentQuantity, t: number): PigmentQuantity {
  nonnegative(t, 'Pigment mixture position');
  if (t > 1) throw new RangeError('Pigment mixture position must be in [0,1].');
  return add(scale(a, (1 - t) ** 2), scale(b, t ** 2));
}

function toLinear(value: PigmentQuantity): Vec3 {
  requireQuantity(value);
  if (value.concentration === 0) throw new RangeError('An empty pigment quantity has no color.');
  const reflectance = value.weightedKS.map(weighted => {
    const k = weighted / value.concentration;
    // Rationalize 1+k-sqrt(k*k+2*k): the original subtracts almost equal
    // numbers for dark samples. K/S stays bounded by the leaf spectra.
    return 1 / (1 + k + Math.sqrt(k * k + 2 * k));
  });
  const xyz = CIE_D65.map(row => dot(row, reflectance));
  return Object.freeze([dot(XYZ_TO_RGB[0], xyz), dot(XYZ_TO_RGB[1], xyz), dot(XYZ_TO_RGB[2], xyz)]);
}

/**
 * Authoring-time spectral quantities. add/scale operate on (C, Σ C·K/S),
 * preserving mixtures until projection. add() is the zero quantity.
 * mix uses Spectral.js's squared factors; it is not an associative operation.
 */
export const pigment = Object.freeze({
  srgb: (hex: string, options: PigmentOptions = {}) => linear(srgbToLinear(hex), options),
  linear,
  reflectance: (values: ArrayLike<number>, options: PigmentOptions = {}) => fromSpectrum(
    samples(values, BANDS, 'Pigment reflectance').map(value => Math.max(Number.EPSILON, value)), options),
  add,
  scale,
  mix,
  toLinear,
  color: (value: PigmentQuantity): Extract<ColorExpression, {kind: 'color'}> => color.linear(toLinear(value)),
});
