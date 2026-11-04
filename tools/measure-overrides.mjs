import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as THREE from 'three';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [baselineArgument, reportArgument] = process.argv.slice(2);
if (!baselineArgument || !reportArgument) {
  throw new Error('Usage: node tools/measure-overrides.mjs <baseline-dir> <output-report.json>');
}
const baseline = resolve(baselineArgument), output = resolve(reportArgument);
assert.notEqual(baseline, root, 'The baseline must be a separate source checkout.');
const digest = text => ({bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex')});

async function load(directory) {
  const [core, adapter, manifest] = await Promise.all([
    import(pathToFileURL(resolve(directory, 'src/core.mjs')).href),
    import(pathToFileURL(resolve(directory, 'src/three.mjs')).href),
    readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  return {core, adapter, version: manifest.version, directory: relative(root, directory) || '.'};
}

const [before, after] = await Promise.all([load(baseline), load(root)]);
const {surface, scalar, named, materialGraph, serializeGraph} = after.core;
const paint = surface.paint(), shadow = named('shadow', scalar.parameter(.2));
const ramp = named('shadow-ramp', scalar.ramp(scalar.axis('x'), 0, 1));
const metal = named('metal', scalar.parameter(.5)), rough = named('rough', scalar.parameter(.5));
const alpha = named('alpha', scalar.parameter(1));
const inner = named('inner', surface.channels(paint, {
  roughness: scalar.multiply(ramp, shadow), metalness: metal, opacity: shadow,
}));
const nested = surface.channels(surface.channels(inner, {roughness: rough, clearcoat: .3}), {opacity: alpha});
const flat = surface.channels(paint, {roughness: rough, metalness: metal, clearcoat: .3, opacity: alpha});
// Each checkout parses the exact same JSON bytes through its own public boundary.
const serialized = serializeGraph(materialGraph(nested));
const flatSerialized = serializeGraph(materialGraph(flat));

function measure(api) {
  const graph = api.core.parseGraph(serialized), plan = api.core.compileGraph(graph);
  assert.equal(api.core.serializeGraph(graph), serialized);
  const flatPlan = api.core.compileGraph(api.core.parseGraph(flatSerialized));
  const canonicalEquivalent = plan.programKey === flatPlan.programKey;
  if (api === after) {
    assert(canonicalEquivalent, 'Nested and flat overrides must share a program.');
    assert.deepEqual(plan.nodes, flatPlan.nodes);
  }
  // Real Three material/shader objects, without a renderer or a GPU timing claim.
  const fields = api.adapter.createPaintTextures(THREE, {
    topData: new Uint8Array(512 * 512 * 4), wallData: new Uint8Array(512 * 512 * 4),
  });
  const system = api.adapter.createTexturingSystem(THREE, {fields});
  try {
    const handle = system.createMaterial(graph);
    const shader = {
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {},
    };
    handle.material.onBeforeCompile(shader);
    const graphFunction = shader.fragmentShader.match(/MoonweaveSurface moonweaveGraph\(\) \{[\s\S]*?\n\}/)?.[0];
    assert(graphFunction, 'The emitted shader must contain its graph evaluation function.');
    let writes = 0;
    for (const slot of Object.values(shader.uniforms)) {
      let value = slot.value;
      if (typeof value?.fromArray === 'function') {
        const fromArray = value.fromArray;
        value.fromArray = function (...args) {writes++; return fromArray.apply(this, args);};
      }
      Object.defineProperty(slot, 'value', {get: () => value, set: next => {writes++; value = next;}});
    }
    const programKey = handle.material.customProgramCacheKey(), materialVersion = handle.material.version;
    handle.patch({shadow: {value: .9}, 'shadow-ramp': {high: 2}});
    assert.equal(handle.material.customProgramCacheKey(), programKey);
    assert.equal(handle.material.version, materialVersion);
    if (api === after) assert.equal(writes, 0, 'Shadowed value edits must not write uniforms.');
    return {
      version: api.version, sourceDirectory: api.directory,
      liveNodes: plan.nodes.length, editableBindings: plan.bindings.length, cost: plan.cost,
      nestedEqualsFlat: canonicalEquivalent, hiddenEditUniformWrites: writes,
      programKey: digest(plan.programKey), graphEvaluationGLSL: digest(graphFunction),
      vertexShader: digest(shader.vertexShader), fragmentShader: digest(shader.fragmentShader),
    };
  } finally {
    system.dispose();
    fields.dispose();
  }
}

const report = {
  schema: 1, fixture: 'Three adjacent finish overrides, with a fully shadowed ramp/product field.',
  graph: {...digest(serialized), document: JSON.parse(serialized)},
  engine: {name: 'three', revision: THREE.REVISION},
  before: measure(before), after: measure(after),
  scope: 'Structural plan, emitted GLSL and JavaScript uniform writes. No GPU compilation, rendering or timing measured.',
};
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({report: relative(root, output), before: report.before, after: report.after}, null, 2));
