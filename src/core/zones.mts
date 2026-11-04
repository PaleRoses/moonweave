import {CHANNELS, record, reference} from './algebra.mts';
import type {Channel, ColorExpression, ScalarExpression, SurfaceExpression} from './algebra.mts';
import {ownExpression, ownValue, scalar, surface} from './graph.mts';

export interface ZoneEffects {
  readonly color?: ColorExpression;
  readonly channels?: Readonly<Partial<Record<Channel, ScalarExpression | number>>>;
  readonly height?: ScalarExpression | number;
}

export interface ZoneApplication {
  readonly name: string;
  readonly coverage: ScalarExpression;
  readonly color?: ColorExpression;
  readonly channels?: Readonly<Partial<Record<Channel, ScalarExpression>>>;
  readonly height?: ScalarExpression;
}

const asScalar = (value: ScalarExpression | number): ScalarExpression =>
  typeof value === 'number' ? scalar.constant(value) : ownExpression(value);

/**
 * A graded application. Its name labels the application; named() owns graph IDs.
 * Coverage is expected in [0, 1], without implicit clamping. One snapshot retains
 * shared roots and descendants across coverage, color, channels and height.
 */
export function zone(name: string, mask: ScalarExpression | number, effects: ZoneEffects = {}): ZoneApplication {
  reference(name, 'zone name');
  record(effects, 'zone effects', ['color', 'channels', 'height']);
  if (effects.channels !== undefined) {
    record(effects.channels, 'zone channels', CHANNELS);
  }
  const owned = ownValue({mask, effects});
  const channels = owned.effects.channels;
  return Object.freeze({
    name,
    coverage: asScalar(owned.mask),
    ...(owned.effects.color === undefined ? {} : {color: ownExpression(owned.effects.color)}),
    ...(channels === undefined ? {} : {channels: Object.freeze(Object.fromEntries(CHANNELS
      .filter(key => Object.hasOwn(channels, key))
      .map(key => [key, asScalar(channels[key]!)])))}),
    ...(owned.effects.height === undefined ? {} : {height: asScalar(owned.effects.height)}),
  });
}

/**
 * Apply zones in authored order. Color and finish interpolate toward targets;
 * heights add D(m*h) = m*Dh + h*Dm, including the zone boundary's differential.
 * Earlier finish/relief survives unspecified channels; later targets win where
 * coverage is one. Empty applications preserve the exact input expression.
 */
export function applyZones(input: SurfaceExpression, zones: readonly ZoneApplication[]): SurfaceExpression {
  if (!Array.isArray(zones)) throw new TypeError('Zone applications must be an ordered array.');
  let current = input;
  for (const application of zones) {
    const {coverage: mask, color, channels, height} = application;
    if (color !== undefined) current = surface.coat(current, color, mask);
    if (channels !== undefined && Object.keys(channels).length) {
      current = surface.mix(current, surface.channels(current, channels), mask);
    }
    if (height !== undefined) current = surface.bump(current, scalar.multiply(mask, height));
  }
  return current;
}
