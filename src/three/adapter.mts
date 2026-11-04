import type {DataTexture, MeshPhysicalMaterial, Side, Vector2, Vector3, Vector4, Matrix3, Matrix4} from 'three';
import type {GraphInput, GraphPatch, MaterialGraph, GraphPlan, NodeValuePatch} from '../core/types.mts';
import type {ImageResource, SurfaceRecipe, SurfacePatch, SurfacePreset, GraphExpression, ColorExpression} from '../core/algebra.mts';
import type {TexturingEngine} from './engine.mts';
import type {PaintTextures} from './textures.mts';
import type {UniformBinding} from './uniforms.mts';

export interface MaterialConfig {
  readonly coordinates?: 'local' | 'attribute';
  readonly side?: Side;
  readonly transparent?: boolean;
}
/** Recursive lifecycle handle owned by this adapter, not a second API declaration. */
export interface MaterialHandle {
  readonly material: MeshPhysicalMaterial;
  readonly graph: MaterialGraph;
  readonly plan: GraphPlan;
  readonly recipe: SurfaceRecipe | null;
  readonly disposed: boolean;
  setGraph(next: GraphInput): MaterialHandle;
  patch(changes: GraphPatch): MaterialHandle;
  update(patch: SurfacePatch | SurfacePreset): MaterialHandle;
  dispose(): void;
}
export type TexturingOptions =
  | {readonly fields?: never; readonly resolution?: 512 | 1024; readonly seed?: number; readonly anisotropy?: number}
  | {readonly fields: PaintTextures; readonly resolution?: never; readonly seed?: never; readonly anisotropy?: never};
export type TexturingSystem = ReturnType<typeof createTexturingSystem>;
type ArrayUniform = Vector2 | Vector3 | Vector4 | Matrix3 | Matrix4;
type Uniforms = Record<string, {value: number | ArrayUniform | DataTexture | null}>;
interface PreparedMaterial {readonly plan: GraphPlan; readonly recipe: SurfaceRecipe | null; readonly values: UniformBinding[]}

import {createPaintTextures} from './textures.mts';
import {createImageTextures} from './images.mts';
import {PAINT_LAYOUT} from '../paint/data.mts';
import {compileGraph} from '../core/compile.mts';
import {patchGraph, facets, named, surface} from '../core/graph.mts';
import {normalizeSurfaceRecipe, patchSurfaceRecipe, PALETTE_KEYS} from '../core/recipe.mts';
import {nodeUniformValues} from './uniforms.mts';
import {patchTexturingShader, validateSurfaceShaderPlan, TEXTURING_SHADER_VERSION} from './shader.mjs';

function optionsRecord<T>(input: T, keys: readonly string[], label: string): asserts input is T & Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new TypeError(`Unknown ${label} option: ${key}.`);
}

const classes = {vec2: 'Vector2', vec3: 'Vector3', vec4: 'Vector4', mat3: 'Matrix3', mat4: 'Matrix4'} as const;
const scalarBinding = (binding: UniformBinding): binding is Extract<UniformBinding, {type: 'float' | 'uint'}> =>
  binding.type === 'float' || binding.type === 'uint';

function uniformBindings(THREE: TexturingEngine, values: readonly UniformBinding[], images: ReadonlyMap<ImageResource, DataTexture>): Uniforms {
  return Object.fromEntries(values.map(binding => [binding.name, {
    value: binding.type === 'sampler2D' ? images.get(binding.value)!
      : scalarBinding(binding) ? binding.value : new THREE[classes[binding.type]]().fromArray(binding.value),
  }]));
}

function writeBindings(uniforms: Uniforms, values: readonly UniformBinding[], images: ReadonlyMap<ImageResource, DataTexture>) {
  for (const binding of values) {
    if (binding.type === 'sampler2D') uniforms[binding.name].value = images.get(binding.value)!;
    else if (scalarBinding(binding)) uniforms[binding.name].value = binding.value;
    else (uniforms[binding.name].value as ArrayUniform).fromArray(binding.value);
  }
}

function isGraph(input: GraphInput | SurfacePatch): input is Exclude<GraphInput, SurfacePreset> {
  return !!input && typeof input === 'object'
    && ['kind', 'nodes', 'output'].some(key => Object.hasOwn(input, key));
}

/**
 * The only mutable material boundary: an engine-injected resource owner compiles
 * immutable graphs, owns its materials, and shares one explicit pair of atlases.
 */
export function createTexturingSystem(THREE: TexturingEngine, options: TexturingOptions = {}) {
  if (!THREE?.MeshPhysicalMaterial || Object.values(classes).some(name => !THREE?.[name])) {
    throw new TypeError('Pass the Three.js module namespace.');
  }
  optionsRecord(options, ['fields', 'resolution', 'seed', 'anisotropy'], 'texturing system');
  const owned = options.fields === undefined;
  if (!owned && ['resolution', 'seed', 'anisotropy'].some(key => Object.hasOwn(options, key))) {
    throw new TypeError('Configure borrowed fields at their owner, not on the texturing system.');
  }
  const fields = options.fields === undefined ? createPaintTextures(THREE, {
    resolution: options.resolution ?? 512,
    seed: options.seed ?? 29031,
    anisotropy: options.anisotropy ?? 1,
  }) : options.fields;
  if (!fields || typeof fields.ensure !== 'function' || typeof fields.dispose !== 'function'
      || !Number.isFinite(fields.resolution) || fields.resolution <= 0 || fields.layout !== PAINT_LAYOUT) {
    throw new TypeError('fields must be a paint texture owner with the current atlas layout.');
  }
  const handles = new Set<MaterialHandle>();
  const imageTextures = createImageTextures(THREE);
  let disposed = false;
  function alive() {
    if (disposed) throw new Error('Moonweave texturing system is disposed.');
    if (fields.disposed) throw new Error('Moonweave paint fields are disposed.');
  }

  function createMaterial(input: GraphInput | SurfacePatch = 'moonstone', config: MaterialConfig = {}): MaterialHandle {
    alive();
    optionsRecord(config, ['coordinates', 'side', 'transparent'], 'material');
    const coordinates = config.coordinates ?? 'local';
    if (!['local', 'attribute'].includes(coordinates)) throw new RangeError('coordinates must be local or attribute.');
    const side = config.side ?? THREE.DoubleSide;
    if (![THREE.FrontSide, THREE.BackSide, THREE.DoubleSide].includes(side)) throw new RangeError('side must be a Three.js side constant.');
    const transparent = config.transparent ?? false;
    if (typeof transparent !== 'boolean') throw new TypeError('transparent must be boolean.');

    let current: PreparedMaterial;
    let images = new Map<ImageResource, DataTexture>();
    function releaseImages(resources: Iterable<ImageResource>): unknown[] {
      const failures = [];
      for (const resource of resources) {
        try { imageTextures.release(resource); } catch (error) { failures.push(error); }
      }
      return failures;
    }
    function acquireImages(plan: GraphPlan) {
      const next = new Map<ImageResource, DataTexture>(), acquired: ImageResource[] = [];
      try {
        for (const node of plan.nodes) if (node.kind === 'image' && !next.has(node.resource)) {
          let texture = images.get(node.resource);
          if (!texture) {
            texture = imageTextures.acquire(node.resource);
            acquired.push(node.resource);
          }
          next.set(node.resource, texture);
        }
        return next;
      } catch (error) {
        const failures = releaseImages(acquired);
        if (failures.length) throw new AggregateError([error, ...failures], 'Image acquisition and cleanup failed.');
        throw error;
      }
    }
    function prepare(nextInput: GraphInput, recipe: SurfaceRecipe | null = null): PreparedMaterial {
      const plan = compileGraph(nextInput);
      if (plan === current?.plan) return recipe === current.recipe ? current : {plan, recipe, values: []};
      const sharedStructure = plan.structure === current?.plan.structure;
      if (!sharedStructure) validateSurfaceShaderPlan(plan);
      if (plan.opacityRange[0] < 1 && !transparent) {
        throw new RangeError('Graph opacity below 1 requires material config transparent:true.');
      }
      const values: UniformBinding[] = [];
      for (const binding of plan.bindings) {
        const node = plan.nodes[binding.index];
        const previous = sharedStructure ? current.plan.nodes[binding.index] : undefined;
        if (node !== previous) values.push(...nodeUniformValues(node, previous));
      }
      return {plan, recipe, values};
    }

    const graphInput = isGraph(input);
    const recipe = graphInput ? null : normalizeSurfaceRecipe(input);
    current = prepare(graphInput ? input : surface.paint(recipe!), recipe);
    const uniforms = uniformBindings(THREE, current.values.filter(binding => binding.type !== 'sampler2D'), images);
    function textureBindings(plan: GraphPlan): Uniforms {
      if (!plan.cost.paintSamples || uniforms.uMwTop) return {};
      const textures = fields.ensure();
      if (!textures?.top?.isTexture || !textures?.wall?.isTexture) {
        throw new TypeError('Paint fields must provide both Three.js data textures.');
      }
      return {
        uMwTop: {value: textures.top}, uMwWall: {value: textures.wall},
        uMwResolution: {value: fields.resolution},
      };
    }
    Object.assign(uniforms, textureBindings(current.plan));
    images = acquireImages(current.plan);
    Object.assign(uniforms, uniformBindings(THREE, current.values.filter(binding => binding.type === 'sampler2D'), images));
    // The graph supplies material channel values. Keep shader features stable
    // across numeric edits, including a clearcoat strength crossing zero.
    const material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 1, metalness: 1, clearcoat: 1,
      clearcoatRoughness: 0.4, opacity: 1, side, transparent, depthWrite: !transparent,
    });
    material.name = 'Moonweave surface graph';
    const legacyMaterial = material as MeshPhysicalMaterial & {extensions?: Record<string, boolean>};
    legacyMaterial.extensions = {...legacyMaterial.extensions, derivatives: true};
    const cacheKey = () => `${TEXTURING_SHADER_VERSION}:${coordinates}:${current.plan.programKey}`;
    let programKey = cacheKey();
    let released = false;
    function liveHandle() {
      alive();
      if (released) throw new Error('Moonweave material handle is disposed.');
    }
    function commit(candidate: PreparedMaterial): MaterialHandle {
      if (candidate === current) return handle;
      const changed = candidate.plan.programKey !== current.plan.programKey;
      const textures = changed ? textureBindings(candidate.plan) : {};
      const nextImages = changed || candidate.values.some(binding => binding.type === 'sampler2D')
        ? acquireImages(candidate.plan) : images;
      if (changed) {
        const missing = candidate.values.filter(binding => !Object.hasOwn(uniforms, binding.name));
        const additions = uniformBindings(THREE, missing, nextImages);
        // Acquire only the resources used by the live plan, before mutating
        // bindings. A failed acquisition leaves the current material intact.
        Object.assign(uniforms, additions, textures);
      }
      // Three may revisit an already cached program without calling onBeforeCompile.
      // Keep typed slots stable across topology changes, and include all previous
      // slots in each new compilation's dictionary. Canonical IDs bound this pool.
      writeBindings(uniforms, candidate.values, nextImages);
      const removed: ImageResource[] = [];
      if (nextImages !== images) {
        for (const [resource, texture] of images) if (!nextImages.has(resource)) {
          // Cached shader slots may survive topology changes; dead slots must
          // not retain disposed textures or previous image revisions.
          for (const uniform of Object.values(uniforms)) if (uniform.value === texture) uniform.value = null;
          removed.push(resource);
        }
        images = nextImages;
      }
      current = candidate;
      if (changed) {
        programKey = cacheKey();
        material.needsUpdate = true;
      }
      // Disposal listeners are application code. Finish the accepted state
      // transition before releasing old resources, and attempt every release.
      const failures = releaseImages(removed);
      if (failures.length) throw new AggregateError(failures, 'Graph applied; previous image cleanup failed.');
      return handle;
    }
    material.onBeforeCompile = shader => {
      liveHandle();
      patchTexturingShader(shader, uniforms, coordinates, current.plan);
    };
    // Both hooks read the current plan; replacing a graph cannot retain a stale closure.
    material.customProgramCacheKey = () => programKey;
    material.clone = () => {
      throw new Error('Clone Moonweave graphs with system.createMaterial(handle.graph); Material.clone does not retain shader hooks.');
    };
    const handle: MaterialHandle = {
      material,
      get recipe() { return current.recipe; },
      get graph() { return current.plan.graph; },
      get plan() { return current.plan; },
      get disposed() { return released; },
      setGraph(next: GraphInput) {
        liveHandle();
        return commit(prepare(next));
      },
      patch(changes: GraphPatch) {
        liveHandle();
        return commit(prepare(patchGraph(current.plan.graph, changes)));
      },
      update(patch: SurfacePatch | SurfacePreset) {
        liveHandle();
        if (!current.recipe && typeof patch !== 'string') {
          throw new TypeError('Graph material updates use setGraph(next); update accepts a preset name or a canonical recipe patch.');
        }
        const next = current.recipe ? patchSurfaceRecipe(current.recipe, patch) : normalizeSurfaceRecipe(patch);
        if (current.recipe) {
          const paint = current.plan.graph.nodes.find(node => node.kind === 'paint')!;
          const before = current.recipe.palette, after = next.palette;
          const samePalette = PALETTE_KEYS.every(role => before[role] === after[role]);
          const authoredId = (value: GraphExpression) => (value as GraphExpression & {readonly id?: string}).id;
          // Literal edits can share the existing topology only while authored
          // names and the palette's sharing relation remain unchanged.
          const literalEdit = PALETTE_KEYS.every(role => before[role].kind === 'color'
            && after[role].kind === 'color' && authoredId(before[role]) === authoredId(after[role])
            && PALETTE_KEYS.every(other => (before[role] === before[other]) === (after[role] === after[other])));
          if (samePalette || literalEdit) {
            const changes: Record<string, NodeValuePatch> = {[paint.field]: next.mapping, [paint.id]: {style: next.style}};
            if (!samePalette) for (const role of PALETTE_KEYS) {
              changes[paint.palette[role]] = {value: (after[role] as Extract<ColorExpression, {kind: 'color'}>).value};
            }
            return commit(prepare(patchGraph(current.plan.graph, changes), next));
          }
          // A new palette expression is a structural edit. Retain stable field
          // and paint IDs; graph construction owns the new shared color DAG.
          const field = named(paint.field, facets(next.mapping));
          return commit(prepare(named(paint.id, surface.paint(field, next.style, next.palette)), next));
        }
        return commit(prepare(surface.paint(next), next));
      },
      dispose() {
        if (released) return;
        released = true;
        handles.delete(handle);
        // Three's cached programs can retain these slot objects after disposal.
        // Drop this handle's texture references without touching other borrowers.
        for (const uniform of Object.values(uniforms)) if (uniform.value !== null && typeof uniform.value === 'object' && 'isTexture' in uniform.value) uniform.value = null;
        const failures = releaseImages(images.keys());
        images.clear();
        try { material.dispose(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Material cleanup completed with resource errors.');
      },
    };
    handles.add(handle);
    return Object.freeze(handle);
  }

  return Object.freeze({
    fields,
    get disposed() { return disposed; },
    createMaterial,
    dispose() {
      if (disposed) return;
      disposed = true;
      const failures = [];
      for (const handle of [...handles]) {
        try { handle.dispose(); } catch (error) { failures.push(error); }
      }
      if (owned) {
        try { fields.dispose(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Moonweave cleanup completed with resource errors.');
    },
  });
}
