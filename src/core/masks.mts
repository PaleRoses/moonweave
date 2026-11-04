import type {ScalarExpression, DomainExpression, Vec3} from './algebra.mts';
export interface MaskIntervalOptions {readonly feather?: number}
export interface MaskChiselOptions {readonly domain?: DomainExpression; readonly feather?: number | Vec3}
import {finite, record, SURFACE_SIGNATURE} from './algebra.mts';
import {ownExpression, scalar} from './graph.mts';

/** Finite support with inward C1 edges; feather is measured in input units. */
function interval(input: ScalarExpression | number, low: number, high: number, options: MaskIntervalOptions = {}): ScalarExpression {
  record(options, 'interval mask options', ['feather']);
  low = finite(low, 'interval.low');
  high = finite(high, 'interval.high');
  if (high <= low) throw new RangeError('Interval high must exceed low.');
  const width = high - low;
  const feather = finite(options.feather === undefined ? width * .1 : options.feather, 'interval.feather');
  if (feather <= 0 || feather > width / 2) {
    throw new RangeError('Interval feather must be positive and no greater than half its width.');
  }
  // Share the grammar's representability contract at this authoring boundary.
  // There is no new runtime node, sampler or filtering policy.
  const edges = SURFACE_SIGNATURE.ramp.values.normalize;
  edges({low, high: low + feather});
  edges({low: high - feather, high});
  // Both edges observe one authored field, including raw named expressions.
  const field = typeof input === 'number' ? input : ownExpression(input);
  return scalar.multiply(scalar.ramp(field, low, low + feather),
    scalar.complement(scalar.ramp(field, high - feather, high)));
}

/** A [-1,1]³ chisel in its domain. Feather uses local units, per axis or shared. */
function chisel(options: MaskChiselOptions = {}): ScalarExpression {
  record(options, 'chisel mask options', ['domain', 'feather']);
  const feather = options.feather === undefined ? .2 : options.feather;
  const widths = typeof feather === 'number' ? [feather, feather, feather] : feather;
  if (!Array.isArray(widths) || widths.length !== 3) {
    throw new TypeError('Chisel feather must be a number or three axis widths.');
  }
  const domain = options.domain === undefined ? undefined : ownExpression(options.domain);
  const axes = (['x', 'y', 'z'] as const).map((axis, index) =>
    interval(scalar.axis(axis, domain), -1, 1, {feather: finite(widths[index], `chisel.feather[${index}]`)}));
  return scalar.multiply(scalar.multiply(axes[0], axes[1]), axes[2]);
}

/** Compositions of the scalar algebra; point masks do not imply pixel filtering. */
export const mask = Object.freeze({interval, chisel});
