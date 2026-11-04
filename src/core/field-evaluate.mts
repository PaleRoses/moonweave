import {finite, inverseLinear, record, FLOAT32_MAX} from './algebra.mts';
import type {Algebra, Vec3, ImageResource, ImageAddress, ImageFilter} from './algebra.mts';
import {sampleNoise} from './noise.mts';
import {mixColorSamples, adjustColorSample, rampInterval} from './color-sample.mts';
import {hueRadians} from './color.mts';
import {sampleImage} from './resources.mts';
import {sampleFilteredImage} from './image-filter.mts';

/** Pixel-sized displacement vectors, independent of calculus directions. */
export interface PixelFootprint {readonly dx: Vec3; readonly dy: Vec3}

export interface SampleContext {
  position?: Vec3;
  normal?: Vec3;
  dx?: Vec3;
  dy?: Vec3;
  normalDx?: Vec3;
  normalDy?: Vec3;
  footprint?: PixelFootprint;
}

export interface DomainSample {
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly dx: Vec3;
  readonly dy: Vec3;
  readonly normalDx: Vec3;
  readonly normalDy: Vec3;
  readonly footprint?: PixelFootprint;
}

export interface ScalarSample {readonly value: number; readonly dx: number; readonly dy: number}
export interface ColorSample {readonly value: Vec3; readonly dx: Vec3; readonly dy: Vec3}
type FieldSample = DomainSample | ScalarSample | ColorSample;
interface SampleState {
  readonly base: DomainSample;
  readonly values: Map<Point<FieldSample>, FieldSample>;
}
export type Point<T> = (state: SampleState) => T;
export type FieldInterpretation = {image: ImageResource; domain: Point<DomainSample>; scalar: Point<ScalarSample>; color: Point<ColorSample>};

const zero: Vec3 = Object.freeze([0, 0, 0]);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const axes = {x: 0, y: 1, z: 2} as const;
const rootDomain: Point<DomainSample> = state => state.base;

function vector(input: Vec3, name: string): Vec3 {
  if (!Array.isArray(input) || input.length !== 3) throw new TypeError(`${name} must contain three numbers.`);
  return Array.from(input, value => finite(value, name)) as unknown as Vec3;
}

function linear(matrix: readonly number[], value: Vec3): Vec3 {
  return [
    matrix[0] * value[0] + matrix[4] * value[1] + matrix[8] * value[2],
    matrix[1] * value[0] + matrix[5] * value[1] + matrix[9] * value[2],
    matrix[2] * value[0] + matrix[6] * value[1] + matrix[10] * value[2],
  ];
}

function normalAndDerivatives(value: Vec3, dx: Vec3, dy: Vec3): Pick<DomainSample, 'normal' | 'normalDx' | 'normalDy'> {
  const length = Math.hypot(...value);
  if (!Number.isFinite(length) || length < 1e-20) throw new RangeError('Sample normal must be finite and nonzero.');
  const normal = value.map(component => component / length) as unknown as Vec3;
  const derivative = (delta: Vec3): Vec3 => delta.map((component, index) =>
    (component - normal[index] * dot(normal, delta)) / length) as unknown as Vec3;
  return {normal, normalDx: derivative(dx), normalDy: derivative(dy)};
}

function checked(sample: ScalarSample): ScalarSample {
  finite(sample.value, 'evaluated scalar', FLOAT32_MAX);
  finite(sample.dx, 'evaluated scalar', FLOAT32_MAX);
  finite(sample.dy, 'evaluated scalar', FLOAT32_MAX);
  return sample;
}

function checkedColor(sample: ColorSample): ColorSample {
  for (const components of [sample.value, sample.dx, sample.dy]) {
    for (const value of components) finite(value, 'evaluated color', FLOAT32_MAX);
  }
  return sample;
}

/** Sample data is copied and checked at the evaluation boundary, never retained. */
export function sampleDomain(context: SampleContext = {}): DomainSample {
  let footprint: PixelFootprint | undefined;
  if (context.footprint !== undefined) {
    record(context.footprint, 'sample footprint', ['dx', 'dy']);
    footprint = {dx: vector(context.footprint.dx, 'footprint dx'),
      dy: vector(context.footprint.dy, 'footprint dy')};
  }
  return {
    position: vector(context.position ?? zero, 'sample position'),
    dx: vector(context.dx ?? zero, 'sample dx'),
    dy: vector(context.dy ?? zero, 'sample dy'),
    ...normalAndDerivatives(vector(context.normal ?? [0, 1, 0], 'sample normal'),
      vector(context.normalDx ?? zero, 'normal dx'), vector(context.normalDy ?? zero, 'normal dy')),
    ...(footprint === undefined ? {} : {footprint}),
  };
}

/** A point function computes a shared expression at most once per sample. */
function memo<T extends FieldSample>(sample: Point<T>): Point<T> {
  const point: Point<T> = state => {
    const previous = state.values.get(point);
    if (previous !== undefined) return previous as T;
    const value = sample(state);
    state.values.set(point, value);
    return value;
  };
  return point;
}

/** Preparation owns specialization and shared image reconstructions. */
export function createFieldAlgebra(): Algebra<FieldInterpretation> {
  const literalValues = new WeakMap<Point<ScalarSample>, number>();
  const imagePoints = new WeakMap<ImageResource,
    WeakMap<Point<DomainSample>, Partial<Record<`${ImageAddress}:${ImageFilter}`, Point<ColorSample>>>>>();

  function constant(value: number, literal = false): Point<ScalarSample> {
    const sample = Object.freeze({value, dx: 0, dy: 0});
    const point = () => sample;
    if (literal) literalValues.set(point, value);
    return point;
  }

  /**
   * Share an immutable image/frame/address reconstruction across typed readers.
   * Weak caches retain prepared functions only; values live in the sample's memo.
   * Each projection checks its own result so unused channels do not add failures.
   */
  function imagePoint(image: ImageResource, frame: Point<DomainSample> | undefined, address: ImageAddress,
      filter: ImageFilter = 'linear'): Point<ColorSample> {
    const domain = frame ?? rootDomain;
    let domains = imagePoints.get(image);
    if (!domains) imagePoints.set(image, domains = new WeakMap());
    let points = domains.get(domain);
    if (!points) domains.set(domain, points = {});
    const key = `${address}:${filter}` as const;
    let point = points[key];
    if (!point) {
      point = memo(state => {
        const frame = domain(state);
        const uv = [frame.position[0], frame.position[1]] as const;
        const footprint = frame.footprint ? {
          dx: [frame.footprint.dx[0], frame.footprint.dx[1]],
          dy: [frame.footprint.dy[0], frame.footprint.dy[1]],
        } as const : undefined;
        const sample = filter === 'linear' ? sampleImage(image, uv, address)
          : sampleFilteredImage(image, uv, address, filter, footprint);
        return {value: sample.value as unknown as Vec3,
          dx: sample.du.map((d: number, i: number) => d * frame.dx[0] + sample.dv[i] * frame.dx[1]) as unknown as Vec3,
          dy: sample.du.map((d: number, i: number) => d * frame.dy[0] + sample.dv[i] * frame.dy[1]) as unknown as Vec3};
      });
      points[key] = point;
    }
    return point;
  }

  /**
   * Interpret the graph once into point functions. Port dispatch, scalar literals
   * and inverse matrices are resolved here; only sampling remains in the closures.
   */
  return {
    image: node => node.resource,
    imageScalar: node => {
      const sample = imagePoint(node.image, node.domain, node.address, node.filter), i = {r: 0, g: 1, b: 2}[node.channel];
      return memo(state => {
        const value = sample(state);
        return checked({value: value.value[i], dx: value.dx[i], dy: value.dy[i]});
      });
    },
    imageColor: node => {
      const sample = imagePoint(node.image, node.domain, node.address, node.filter);
      return memo(state => checkedColor(sample(state)));
    },
    constant: node => constant(node.value, true),
    parameter: node => constant(node.value),
    color: node => {
      const sample = Object.freeze({value: node.value, dx: zero, dy: zero});
      return () => sample;
    },
    colorMix: node => node.a === node.b ? node.a : memo(state => {
      const mask = node.mask(state);
      if (mask.value <= 0) return node.a(state);
      if (mask.value >= 1) return node.b(state);
      return checkedColor(mixColorSamples(node.a(state), node.b(state), mask, node.space));
    }),
    colorAdjust: node => {
      const hue = literalValues.get(node.hue);
      if (literalValues.get(node.lightness) === 0 && literalValues.get(node.chroma) === 1
          && hue !== undefined && hueRadians(hue) === 0) return node.input;
      return memo(state => checkedColor(adjustColorSample(
        node.input(state), node.lightness(state), node.chroma(state), node.hue(state),
      )));
    },
    colorRamp: node => node.colors.every(point => point === node.colors[0]) ? node.colors[0] : memo(state => {
      const input = node.input(state);
      const interval = rampInterval(input.value, node.positions, node.interpolation);
      const first = node.colors[interval.a](state);
      if (interval.a === interval.b) return first;
      return checkedColor(mixColorSamples(first, node.colors[interval.b](state), {
        value: interval.weight,
        dx: input.dx * interval.derivative,
        dy: input.dy * interval.derivative,
      }, node.space));
    }),
    noise: node => memo(state => {
      const frame = node.domain ? node.domain(state) : state.base;
      const sample = sampleNoise(frame.position, node.seed);
      return checked({value: sample.value, dx: dot(sample.gradient, frame.dx), dy: dot(sample.gradient, frame.dy)});
    }),
    axis: node => {
      const axis = axes[node.axis];
      return memo(state => {
        const frame = node.domain ? node.domain(state) : state.base;
        return checked({value: frame.position[axis], dx: frame.dx[axis], dy: frame.dy[axis]});
      });
    },
    facing: node => memo(state => {
      const frame = node.domain ? node.domain(state) : state.base, value = dot(frame.normal, node.direction);
      const sign = node.absolute ? Math.sign(value) : 1;
      return checked({
        value: node.absolute ? Math.abs(value) : value,
        dx: dot(frame.normalDx, node.direction) * sign,
        dy: dot(frame.normalDy, node.direction) * sign,
      });
    }),
    ramp: node => memo(state => {
      const value = node.input(state), t = Math.max(0, Math.min(1, (value.value - node.low) / (node.high - node.low)));
      const gradient = 6 * t * (1 - t) / (node.high - node.low);
      return checked({value: t * t * (3 - 2 * t), dx: gradient * value.dx, dy: gradient * value.dy});
    }),
    complement: node => {
      const literal = literalValues.get(node.input);
      if (literal !== undefined) return constant(finite(1 - literal, 'folded complement', FLOAT32_MAX), true);
      return memo(state => {
        const value = node.input(state);
        return checked({value: 1 - value.value, dx: -value.dx, dy: -value.dy});
      });
    },
    add: node => {
      const a = literalValues.get(node.a), b = literalValues.get(node.b);
      if (a !== undefined && b !== undefined) return constant(finite(a + b, 'folded sum', FLOAT32_MAX), true);
      if (a === 0) return node.b;
      if (b === 0) return node.a;
      return memo(state => {
        const a = node.a(state), b = node.b(state);
        return checked({value: a.value + b.value, dx: a.dx + b.dx, dy: a.dy + b.dy});
      });
    },
    multiply: node => {
      const a = literalValues.get(node.a), b = literalValues.get(node.b);
      if (a !== undefined && b !== undefined) return constant(finite(a * b, 'folded product', FLOAT32_MAX), true);
      // Match structural annihilation in the compiler. A parameter currently at
      // zero is still editable, and a varying zero may have a nonzero tangent.
      if (a === 0 || b === 0) return constant(0, true);
      if (a === 1) return node.b;
      if (b === 1) return node.a;
      return memo(state => {
        const a = node.a(state), b = node.b(state);
        return checked({
          value: a.value * b.value,
          dx: a.dx * b.value + a.value * b.dx,
          dy: a.dy * b.value + a.value * b.dy,
        });
      });
    },
    transform: node => {
      const matrix = node.matrix;
      const normalMatrix = inverseLinear(matrix);
      const transpose = (value: Vec3): Vec3 => [
        normalMatrix[0] * value[0] + normalMatrix[1] * value[1] + normalMatrix[2] * value[2],
        normalMatrix[3] * value[0] + normalMatrix[4] * value[1] + normalMatrix[5] * value[2],
        normalMatrix[6] * value[0] + normalMatrix[7] * value[1] + normalMatrix[8] * value[2],
      ];
      return memo(state => {
        const parent = node.input ? node.input(state) : state.base;
        const position = linear(matrix, parent.position).map((value, index) =>
          finite(value + matrix[12 + index], 'transformed position', FLOAT32_MAX)) as unknown as Vec3;
        const frame: DomainSample = {
          position, dx: linear(matrix, parent.dx), dy: linear(matrix, parent.dy),
          ...normalAndDerivatives(transpose(parent.normal), transpose(parent.normalDx), transpose(parent.normalDy)),
        };
        for (const values of Object.values(frame)) for (const value of values) finite(value, 'transformed differential', FLOAT32_MAX);
        if (!parent.footprint) return frame;
        const footprint = {dx: linear(matrix, parent.footprint.dx), dy: linear(matrix, parent.footprint.dy)};
        for (const values of Object.values(footprint)) for (const value of values) finite(value, 'transformed footprint', FLOAT32_MAX);
        return {...frame, footprint};
      });
    },
  };
}

/** Ordinary graph folds may use the same interpreter without owning preparation. */
export const fieldAlgebra = createFieldAlgebra();

export function sampleField<T>(point: Point<T>, context: SampleContext = {}): T {
  return point({base: sampleDomain(context), values: new Map()});
}
