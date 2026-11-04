import {CHANNELS, SURFACE_SIGNATURE, freeze} from './algebra.mts';
import type {Channel, GraphSort} from './algebra.mts';

export {CHANNELS as EFFECT_CHANNELS} from './algebra.mts';

export type EffectSort = Extract<GraphSort, 'surface' | 'scalar' | 'color'>;
export type SurfaceComponent = 'color' | 'slope' | Channel;
export type AtomOperator = `${Capitalize<EffectSort>}Atom`;
export type ChannelOperator = Capitalize<Channel>;
export type SurfaceEffectKind = 'coat' | 'bump' | 'relief' | 'mix';
export type SurfaceOperator = Capitalize<SurfaceEffectKind>;
export type ApplicationOperator = SurfaceOperator | ChannelOperator;
export type EffectOperator = AtomOperator | ApplicationOperator;

type AtomDefinition<S extends EffectSort = EffectSort> = Readonly<{
  result: S; inputs: readonly []; atom: true; kind?: never; ports?: never; channel?: never;
}>;
type SurfaceDefinition<K extends SurfaceEffectKind = SurfaceEffectKind> = Readonly<{
  kind: K; ports: readonly string[]; result: 'surface'; inputs: readonly EffectSort[];
  /** Each output component reads only that component of its surface inputs. */
  componentwise: true; atom?: never; channel?: never;
}>;
type ChannelDefinition<C extends Channel = Channel> = Readonly<{
  kind: 'channels'; channel: C; ports: readonly ['input', 'value']; result: 'surface';
  inputs: readonly ['surface', 'scalar']; atom?: never;
}>;
type EffectDefinitions = {
  readonly [S in EffectSort as `${Capitalize<S>}Atom`]: AtomDefinition<S>
} & {
  readonly [K in SurfaceEffectKind as Capitalize<K>]: SurfaceDefinition<K>
} & Readonly<Record<ChannelOperator, ChannelDefinition>>;
export type EffectDefinition = EffectDefinitions[EffectOperator];
export interface EffectRuleTerm {
  readonly op: ApplicationOperator;
  readonly args: readonly (EffectRuleTerm | string)[];
}
export interface EffectRule {
  readonly id: string;
  readonly variables: Readonly<Record<string, EffectSort>>;
  readonly left: EffectRuleTerm;
  readonly right: EffectRuleTerm;
}
export type EffectTermBody = {
  [O in AtomOperator]: Readonly<{op: O; source: string; args?: never}>
}[AtomOperator] | {
  [O in ApplicationOperator]: Readonly<{op: O; args: readonly string[]; source?: never}>
}[ApplicationOperator];
export type EffectTerm = EffectTermBody & Readonly<{id: string}>;
export type SurfaceObservation = Readonly<Record<SurfaceComponent, number>>;
export const SURFACE_COMPONENTS: readonly SurfaceComponent[] = Object.freeze(['color', 'slope', ...CHANNELS]);

/** Surface operations update independent components of the material record. */
export const SURFACE_EFFECTS = freeze({
  coat: {reads: ['color'], writes: ['color']},
  bump: {reads: ['slope'], writes: ['slope']},
  relief: {reads: ['slope'], writes: ['slope']},
  // A channels node writes only the members present in its values record.
  channels: {reads: [], writes: CHANNELS, selected: true},
} as const);

const atom = <S extends EffectSort>(result: S): AtomDefinition<S> => ({result, inputs: [], atom: true});
const operator = <K extends SurfaceEffectKind>(kind: K): SurfaceDefinition<K> => ({
  kind, ports: SURFACE_SIGNATURE[kind].portEntries.map(([name]) => name),
  result: SURFACE_SIGNATURE[kind].result, componentwise: true,
  // These four operations contain only surface, scalar and color input ports.
  inputs: SURFACE_SIGNATURE[kind].portEntries.map(([, port]) => port.sort as EffectSort),
});
const channelOperator = (channel: Channel): ChannelOperator =>
  (channel[0].toUpperCase() + channel.slice(1)) as ChannelOperator;

// CHANNELS enumerates every channel; this reflection preserves that closed key set.
const channelDefinitions = Object.fromEntries(CHANNELS.map(channel => [channelOperator(channel), {
  kind: 'channels', channel, ports: ['input', 'value'],
  result: SURFACE_SIGNATURE.channels.result,
  inputs: [SURFACE_SIGNATURE.channels.ports.input.sort, SURFACE_SIGNATURE.channels.ports.values.sort],
} as const])) as Record<ChannelOperator, ChannelDefinition>;

/**
 * A deliberately small optimization language. Non-surface fields remain opaque
 * source atoms, so independently editable values never become interchangeable.
 * Record channel updates become individual writes in the signature's order.
 */
export const EFFECT_OPERATORS: EffectDefinitions = freeze({
  SurfaceAtom: atom('surface'), ScalarAtom: atom('scalar'), ColorAtom: atom('color'),
  Coat: operator('coat'), Bump: operator('bump'), Relief: operator('relief'), Mix: operator('mix'),
  ...channelDefinitions,
});

export function isEffectOperator(value: unknown): value is EffectOperator {
  return typeof value === 'string' && Object.hasOwn(EFFECT_OPERATORS, value);
}
export function isAtomOperator(op: EffectOperator): op is AtomOperator { return EFFECT_OPERATORS[op].atom === true; }
export function isChannelOperator(op: EffectOperator): op is ChannelOperator { return EFFECT_OPERATORS[op].kind === 'channels'; }

const term = (op: ApplicationOperator, ...args: (EffectRuleTerm | string)[]): EffectRuleTerm => ({op, args});
const rule = (id: string, variables: Readonly<Record<string, EffectSort>>, left: EffectRuleTerm, right: EffectRuleTerm): EffectRule =>
  ({id, variables, left, right});
const independent: readonly (readonly [SurfaceOperator, Readonly<Record<string, EffectSort>>, readonly string[]])[] = [
  ['Coat', {c: 'color', m: 'scalar'}, ['c', 'm']],
  ['Bump', {h: 'scalar'}, ['h']],
  ['Relief', {k: 'scalar'}, ['k']],
];

/**
 * Exact product-record laws, expressed once as closed typed equations for an
 * external equality engine. They change neither scalar arithmetic grouping nor
 * the order of operations within any material component. The preferred order
 * has channel writes outermost, then coats, then the authored slope operations;
 * later CHANNELS entries are outermost among distinct writes.
 *
 * There is intentionally no rule for commuting coats, moving bump past relief,
 * merging bumps/scales, distributing mix, or reassociating floating-point fields.
 */
export const EXACT_EFFECT_RULES: readonly EffectRule[] = freeze([
  ...CHANNELS.map(channel => {
    const op = channelOperator(channel);
    return rule(`channel-${channel}-overwrite`, {s: 'surface', x: 'scalar', y: 'scalar'},
      term(op, term(op, 's', 'x'), 'y'), term(op, 's', 'y'));
  }),
  ...CHANNELS.flatMap((left, index) => CHANNELS.slice(index + 1).map(right => {
    const a = channelOperator(left), b = channelOperator(right);
    return rule(`channel-${left}-${right}-commute`, {s: 'surface', x: 'scalar', y: 'scalar'},
      term(a, term(b, 's', 'y'), 'x'), term(b, term(a, 's', 'x'), 'y'));
  })),
  ...CHANNELS.flatMap(channel => independent.map(([effect, variables, args]) => {
    const op = channelOperator(channel);
    return rule(`channel-${channel}-${effect.toLowerCase()}-commute`, {s: 'surface', x: 'scalar', ...variables},
      term(effect, term(op, 's', 'x'), ...args), term(op, term(effect, 's', ...args), 'x'));
  })),
  ...independent.slice(1).map(([effect, variables, args]) =>
    rule(`coat-${effect.toLowerCase()}-commute`, {s: 'surface', c: 'color', m: 'scalar', ...variables},
      term(effect, term('Coat', 's', 'c', 'm'), ...args), term('Coat', term(effect, 's', ...args), 'c', 'm'))),
]);

/** Object.fromEntries cannot express that the complete product was enumerated. */
const observation = (project: (component: SurfaceComponent) => number): SurfaceObservation =>
  Object.fromEntries(SURFACE_COMPONENTS.map(component => [component, project(component)])) as SurfaceObservation;

/**
 * Interpret a validated, topologically ordered term DAG as six exact symbolic
 * observations. A shared Map<string, number> interns both the source and a
 * proposed result: equal component IDs certify this product-record semantics.
 * This is an interpretation, not a second implementation of the rewrite rules.
 *
 * Atoms retain source identity. Clamps, mixes, differentials, additions and
 * scales retain their grouping; no numerical equality or current parameter
 * value is used. This certifies only the closed surface-effect language.
 */
export function projectSurfaceTerms(terms: readonly EffectTerm[], output: string, intern: Map<string, number>): SurfaceObservation {
  const surfaces = new Map<string, SurfaceObservation>(), fields = new Map<string, number>();
  const expression = (op: string, ...args: (string | number)[]): number => {
    const key = JSON.stringify([op, ...args]);
    let value = intern.get(key);
    if (value === undefined) { value = intern.size; intern.set(key, value); }
    return value;
  };
  const read = <T,>(values: ReadonlyMap<string, T>, id: string): T => {
    const value = values.get(id);
    if (value === undefined) throw new RangeError(`Surface term is not topologically available: ${id}.`);
    return value;
  };
  const field = (id: string) => read(fields, id);
  const surface = (id: string) => read(surfaces, id);
  for (const node of terms) {
    const operatorName = node.op;
    if (node.op === 'SurfaceAtom') {
      surfaces.set(node.id, observation(component => expression('surface-component', node.source, component)));
    } else if (node.op === 'ScalarAtom' || node.op === 'ColorAtom') {
      fields.set(node.id, expression(node.op, node.source));
    } else {
      const [input, a, b] = node.args;
      let result: SurfaceObservation;
      switch (node.op) {
        case 'Roughness': case 'Metalness': case 'Clearcoat': case 'Opacity':
          result = {...surface(input), [EFFECT_OPERATORS[node.op].channel]: expression('clamp-scalar', field(a))};
          break;
        case 'Coat': {
          const original = surface(input);
          result = {...original, color: expression('mix', original.color,
            expression('clamp-color', field(a)), expression('clamp-scalar', field(b)))};
          break;
        }
        case 'Bump': {
          const original = surface(input);
          result = {...original, slope: expression('add-slope', original.slope, expression('differential', field(a)))};
          break;
        }
        case 'Relief': {
          const original = surface(input);
          result = {...original, slope: expression('scale-slope', original.slope, field(a))};
          break;
        }
        case 'Mix': {
          const original = surface(input), other = surface(a), weight = expression('clamp-scalar', field(b));
          result = observation(component => expression('mix', original[component], other[component], weight));
          break;
        }
        default: throw new TypeError(`Unknown surface effect operator: ${operatorName}.`);
      }
      surfaces.set(node.id, result);
    }
  }
  if (fields.has(output)) throw new TypeError('Surface projection requires a surface root.');
  return Object.freeze(surface(output));
}
