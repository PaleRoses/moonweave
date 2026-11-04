import {CHANNELS, finite, record} from '../core/algebra.mts';
import type {Channel, DomainExpression, ImageExpression, ImageFilter, ImageResource, ScalarExpression, SurfaceExpression} from '../core/algebra.mts';
import {color, domain, image, ownExpression, ownValue, scalar, surface} from '../core/graph.mts';
import type {MarkBake} from './mark-raster.mts';

export interface MarkApplicationOptions {readonly domain?: DomainExpression; readonly filter?: ImageFilter}

/**
 * Lower one finite bake to the ordinary surface algebra. Associated channels
 * are filtered together with their independent coverage; no unpremultiplication
 * or second mask multiplication can create dark fringes or square the deposit.
 */
export function applyMarkBake(input: SurfaceExpression, bake: MarkBake, options: MarkApplicationOptions = {}): SurfaceExpression {
  record(options, 'mark application', ['domain', 'filter']);
  record(bake, 'mark bake', ['bounds', 'pigment', 'coverage', 'finishValues', 'finishCoverage',
    'opacityHeight', 'channels', 'hasHeight', 'stats']);
  if (!Array.isArray(bake.bounds) || bake.bounds.length !== 4) throw new TypeError('Mark bake requires four bounds.');
  const [x, y, right, top] = Array.from(bake.bounds, (value: unknown) => finite(value, 'mark bake bounds'));
  const width = right - x, height = top - y;
  if (width <= 0 || height <= 0) throw new RangeError('Mark bake bounds must have positive area.');
  if (!Array.isArray(bake.channels)) throw new TypeError('Mark finish channels must be an array.');
  for (const channel of bake.channels) if (!CHANNELS.includes(channel)) throw new TypeError('Invalid mark finish channel.');
  const selected: readonly Channel[] = bake.channels;
  if (typeof bake.hasHeight !== 'boolean') throw new TypeError('Mark bake hasHeight must be boolean.');
  const owned = ownValue({input, domain: options.domain}), source = ownExpression(owned.input);
  const resources = new Map<ImageResource, ImageExpression>();
  const resource = (raw: ImageResource, channels: 1 | 3): ImageExpression => {
    let node = resources.get(raw);
    if (!node) {node = image.data(raw); resources.set(raw, node);}
    if (node.resource.channels !== channels) throw new TypeError('Mark bake image has the wrong channel layout.');
    return node;
  };
  const rgb = resource(bake.pigment, 3), alpha = resource(bake.coverage, 1);
  const values = resource(bake.finishValues, 3), masks = resource(bake.finishCoverage, 3), extra = resource(bake.opacityHeight, 3);
  for (const node of resources.values()) if (node.resource.width !== rgb.resource.width || node.resource.height !== rgb.resource.height) throw new RangeError('Mark bake images must have matching dimensions.');
  // Statistics are evidence, not semantic data. A malformed/imported count must
  // never erase a nonempty application; the empty shortcut checks its fields.
  if (bake.stats?.dabs === 0 && alpha.resource.data.every(value => value === 0)
      && masks.resource.data.every(value => value === 0) && extra.resource.data.every(value => value === 0)) return source;
  const frame = domain.transform([1 / width, 0, 0, 0, 0, 1 / height, 0, 0, 0, 0, 1, 0,
    -x / width, -y / height, 0, 1], owned.domain);
  const sampling = {domain: frame, address: 'zero', filter: options.filter ?? 'anisotropic'} as const;
  const pigment = color.image(rgb, sampling);
  const coverage = scalar.image(alpha, sampling);
  const channels: Partial<Record<Channel, {value: ScalarExpression; coverage: ScalarExpression}>> = {};
  const component = {roughness: 'r', metalness: 'g', clearcoat: 'b'} as const;
  for (const channel of selected) {
    channels[channel] = channel === 'opacity'
      ? {value: scalar.image(extra, {...sampling, channel: 'r'}), coverage: scalar.image(extra, {...sampling, channel: 'g'})}
      : {value: scalar.image(values, {...sampling, channel: component[channel]}),
        coverage: scalar.image(masks, {...sampling, channel: component[channel]})};
  }
  const deposited = surface.deposit(source, pigment, coverage, channels);
  return bake.hasHeight ? surface.bump(deposited, scalar.image(extra, {...sampling, channel: 'b'})) : deposited;
}
