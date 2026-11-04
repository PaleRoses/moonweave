import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as Current from 'three';
import * as Legacy from 'three-legacy';
import {createTexturingSystem, bindSurfaceCoordinates} from '../src/three.mjs';
import {createPaintTextures} from '../src/three/textures.mts';
import {surface, scalar, color, facets, domain, named, materialGraph, compileGraph} from '../src/core.mjs';
import {graphUniformValues} from '../src/three/uniforms.mts';
import {generateSurfaceShader, patchTexturingShader} from '../src/three/shader.mjs';

const bytes = {topData: new Uint8Array(512 * 512 * 4), wallData: new Uint8Array(512 * 512 * 4)};
const copy = value => JSON.parse(JSON.stringify(value));
const freshShader = THREE => ({
  vertexShader: THREE.ShaderLib.physical.vertexShader,
  fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  uniforms: {},
});
const shaderFor = (THREE, handle) => {const shader = freshShader(THREE); handle.material.onBeforeCompile(shader); return shader;};
const uniformValue = value => typeof value === 'number' ? value : value.toArray();

function fixture(THREE) {
  const fields = createPaintTextures(THREE, bytes);
  const system = createTexturingSystem(THREE, {fields});
  return {fields, system, dispose() {system.dispose(); fields.dispose();}};
}

function layered() {
  const frame = domain.transform([1, .2, 0, 0, .4, .8, 0, 0, 0, 0, 1.3, 0, .3, -.1, .2, 1]);
  const field = facets({domain: frame, scale: .3});
  return surface.mix(surface.paint(field, 'carapace'), surface.paint(field, 'horn'),
    scalar.multiply(scalar.ramp(scalar.facing([0, -1, .1], frame), -.25, .65), scalar.parameter(.8)));
}

for (const THREE of [Legacy, Current]) {
  test(`r${THREE.REVISION}: value patches leave unrelated uniform groups and derived work untouched`, () => {
    let vectorWrites = 0;
    const host = {...THREE};
    for (const name of ['Vector2', 'Vector3', 'Vector4', 'Matrix3', 'Matrix4']) {
      host[name] = class extends THREE[name] {
        fromArray(...args) {vectorWrites++; return super.fromArray(...args);}
      };
    }
    const f = fixture(host), handle = f.system.createMaterial({version: 1, nodes: [
      {id: 'skinField', kind: 'facets', scale: .3},
      {id: 'skin', kind: 'paint', field: 'skinField', style: 'carapace'},
      {id: 'pale', kind: 'paint', field: 'skinField', style: 'horn'},
      {id: 'strength', kind: 'parameter', value: .5},
      {id: 'result', kind: 'mix', a: 'skin', b: 'pale', mask: 'strength'},
    ], output: 'result'});
    const shader = shaderFor(THREE, handle), original = handle.plan;
    const key = handle.material.customProgramCacheKey(), version = handle.material.version;
    const slots = {...shader.uniforms};
    function observe(action) {
      const parse = Number.parseInt, cos = Math.cos, sin = Math.sin, imul = Math.imul;
      let colorDecodes = 0, trigCalls = 0, hashMixes = 0; vectorWrites = 0;
      Number.parseInt = (...args) => {colorDecodes++; return parse(...args);};
      Math.cos = value => {trigCalls++; return cos(value);};
      Math.sin = value => {trigCalls++; return sin(value);};
      Math.imul = (...args) => {hashMixes++; return imul(...args);};
      try {action();} finally {Number.parseInt = parse; Math.cos = cos; Math.sin = sin; Math.imul = imul;}
      return {colorDecodes, trigCalls, hashMixes, vectorWrites};
    }
    const noDerivation = {colorDecodes: 0, trigCalls: 0, hashMixes: 0};
    assert.deepEqual(observe(() => {
      assert.equal(handle.patch({strength: {value: .72}}), handle);
    }), {...noDerivation, vectorWrites: 0});
    assert.equal(handle.plan.structure, original.structure);
    assert.equal(handle.plan.bindings, original.bindings);
    const parameter = handle.plan.bindings.find(binding => binding.sourceId === 'strength');
    for (let i = 0; i < handle.plan.nodes.length; i++) {
      if (i === parameter.index) assert.notEqual(handle.plan.nodes[i], original.nodes[i]);
      else assert.equal(handle.plan.nodes[i], original.nodes[i]);
    }
    const binding = graphUniformValues(handle.plan).find(value => value.id === parameter.nodeId);
    assert.equal(shader.uniforms[binding.name].value, .72);
    assert.deepEqual(observe(() => handle.patch({skin: {style: {roughness: .32}}})), {...noDerivation, vectorWrites: 1});
    assert.deepEqual(observe(() => handle.patch({skinField: {scale: .8}})), {...noDerivation, vectorWrites: 0});
    assert.deepEqual(observe(() => handle.patch({skinField: {stretch: [2, 1, 1]}})), {...noDerivation, vectorWrites: 1});
    assert.deepEqual(observe(() => handle.patch({skin: {style: {contrast: .32, relief: .2}}})), {...noDerivation, vectorWrites: 2});
    const baseId = handle.graph.nodes.find(node => node.id === 'skin').palette.base;
    const nextBase = color.srgb('#123456').value;
    assert.deepEqual(observe(() => handle.patch({[baseId]: {value: nextBase}})), {...noDerivation, vectorWrites: 1});
    const rotation = observe(() => handle.patch({skinField: {rotation: 23}}));
    assert(rotation.trigCalls > 0);
    assert.deepEqual({...rotation, trigCalls: 0}, {...noDerivation, vectorWrites: 1});
    const seed = observe(() => handle.patch({skinField: {seed: 88}}));
    assert(seed.hashMixes > 0);
    assert.deepEqual({...seed, hashMixes: 0}, {...noDerivation, vectorWrites: 1});
    for (const binding of graphUniformValues(handle.plan)) {
      assert.deepEqual(uniformValue(shader.uniforms[binding.name].value), binding.value);
    }
    assert.equal(handle.plan.cost.paintSamples, 1);
    assert.equal(handle.material.customProgramCacheKey(), key); assert.equal(handle.material.version, version);
    for (const [name, slot] of Object.entries(slots)) assert.equal(shader.uniforms[name], slot);
    const settled = handle.plan;
    assert.deepEqual(observe(() => {
      handle.setGraph(handle.graph);
      handle.patch({});
      handle.patch({strength: {value: .72}});
    }), {...noDerivation, vectorWrites: 0});
    assert.equal(handle.plan, settled);
    f.dispose();
  });

  test(`r${THREE.REVISION}: value patches reject invalid opacity and topology without changing live state`, () => {
    const f = fixture(THREE), handle = f.system.createMaterial(layered());
    const shader = shaderFor(THREE, handle), graph = handle.graph, plan = handle.plan;
    const paint = graph.nodes.find(node => node.kind === 'paint');
    const ramp = graph.nodes.find(node => node.kind === 'ramp');
    const facet = graph.nodes.find(node => node.kind === 'facets');
    const before = graphUniformValues(plan), version = handle.material.version;
    for (const changes of [
      {[paint.id]: {style: {opacity: .2}}},
      {[ramp.id]: {high: -100}},
      {[facet.id]: {domain: 'anotherFrame'}},
      {missingNode: {value: .3}},
      {[paint.id]: {style: {roughness: .5}}, [ramp.id]: {high: -100}},
    ]) assert.throws(() => handle.patch(changes));
    assert.equal(handle.plan, plan); assert.equal(handle.graph, graph); assert.equal(handle.material.version, version);
    for (const binding of before) assert.deepEqual(uniformValue(shader.uniforms[binding.name].value), binding.value);
    f.dispose();
  });

  test(`r${THREE.REVISION}: editing an unreachable value updates the document without touching uniforms`, () => {
    const f = fixture(THREE), graph = copy(materialGraph(surface.paint('horn')));
    graph.nodes.push({id: 'unused', kind: 'parameter', value: .2});
    const handle = f.system.createMaterial(graph), original = handle.plan, shader = shaderFor(THREE, handle);
    const before = graphUniformValues(original), version = handle.material.version;
    handle.patch({unused: {value: .9}});
    assert.equal(handle.graph.nodes.find(node => node.id === 'unused').value, .9);
    assert.equal(handle.plan.structure, original.structure);
    handle.plan.nodes.forEach((node, i) => assert.equal(node, original.nodes[i]));
    assert.equal(handle.material.version, version);
    for (const binding of before) assert.deepEqual(uniformValue(shader.uniforms[binding.name].value), binding.value);
    f.dispose();
  });

  test(`r${THREE.REVISION}: shadowed channel values perform no uniform writes and surviving values remain editable`, () => {
    const inner = named('inner', surface.channels(surface.paint('horn'), {roughness: named('hidden', scalar.parameter(.2))}));
    const outer = surface.channels(inner, {roughness: named('visible', scalar.parameter(.7))});
    const f = fixture(THREE), handle = f.system.createMaterial(outer), shader = shaderFor(THREE, handle);
    const original = handle.plan, key = handle.material.customProgramCacheKey(), version = handle.material.version;
    assert(!original.bindings.some(binding => binding.sourceId === 'hidden'));
    let writes = 0;
    for (const binding of graphUniformValues(original)) {
      const slot = shader.uniforms[binding.name];
      if (binding.type === 'float') {
        let value = slot.value;
        Object.defineProperty(slot, 'value', {get: () => value, set: next => {writes++; value = next;}});
      } else {
        const fromArray = slot.value.fromArray;
        slot.value.fromArray = function (...args) {writes++; return fromArray.apply(this, args);};
      }
    }
    handle.patch({hidden: {value: .9}});
    assert.equal(writes, 0);
    assert.equal(handle.graph.nodes.find(node => node.id === 'hidden').value, .9);
    assert.equal(handle.plan.structure, original.structure);
    handle.plan.nodes.forEach((node, index) => assert.equal(node, original.nodes[index]));

    handle.patch({visible: {value: .4}});
    assert.equal(writes, 1);
    const parameter = handle.plan.bindings.find(binding => binding.sourceId === 'visible');
    const binding = graphUniformValues(handle.plan).find(binding => binding.id === parameter.nodeId);
    assert.equal(shader.uniforms[binding.name].value, .4);
    assert.equal(handle.material.customProgramCacheKey(), key);assert.equal(handle.material.version, version);

    handle.setGraph({...handle.graph, output: 'inner'});
    assert(handle.plan.bindings.some(binding => binding.sourceId === 'hidden'));
    assert.equal(shader.uniforms[binding.name].value, .9);
    f.dispose();
  });

  test(`r${THREE.REVISION}: explicit shared sampling compiles once and uniform edits preserve live objects`, () => {
    const f = fixture(THREE), handle = f.system.createMaterial(layered());
    const other = f.system.createMaterial(layered());
    const shader = shaderFor(THREE, handle), otherShader = shaderFor(THREE, other);
    const beforeKey = handle.material.customProgramCacheKey(), beforeVersion = handle.material.version;
    const beforeMaterial = handle.material, beforeTextures = f.fields.ensure();
    const slots = Object.fromEntries(Object.entries(shader.uniforms).map(([key, value]) => [key, {slot: value, value: value.value}]));
    const oldOtherValues = graphUniformValues(other.plan);
    const changed = copy(handle.graph);
    changed.nodes.find(n => n.kind === 'facets').scale = .72;
    changed.nodes.find(n => n.kind === 'transform').matrix[12] = .82;
    changed.nodes.find(n => n.kind === 'facing').direction = [1, -.2, 0];
    changed.nodes.find(n => n.kind === 'ramp').high = 1.2;
    changed.nodes.find(n => n.kind === 'parameter').value = .2;
    const paint = changed.nodes.find(n => n.kind === 'paint');
    changed.nodes.find(n => n.id === paint.palette.base).value = color.srgb('#808080').value;
    paint.style.clearcoat = 0;
    assert.equal(handle.setGraph(changed), handle);
    assert.equal(handle.material, beforeMaterial);
    assert.equal(handle.material.version, beforeVersion);
    assert.equal(handle.material.customProgramCacheKey(), beforeKey);
    assert.equal(f.fields.ensure(), beforeTextures);
    assert.equal(handle.plan.cost.paintSamples, 1);
    assert.equal(handle.plan.cost.textureReads, 4);
    assert.equal(f.fields.stats.builds.length, 1);
    for (const binding of graphUniformValues(handle.plan)) {
      assert.equal(shader.uniforms[binding.name], slots[binding.name].slot);
      if (binding.type !== 'float') assert.equal(shader.uniforms[binding.name].value, slots[binding.name].value);
      assert.deepEqual(uniformValue(shader.uniforms[binding.name].value), binding.value);
    }
    for (const binding of oldOtherValues) {
      assert.deepEqual(uniformValue(otherShader.uniforms[binding.name].value), binding.value);
      assert.notEqual(otherShader.uniforms[binding.name], shader.uniforms[binding.name]);
    }
    const generated = generateSurfaceShader(handle.plan);
    assert.equal((generated.evaluate.match(/= mwSample\(/g) ?? []).length, 1);
    assert.equal((generated.evaluate.match(/= mwPaint\(/g) ?? []).length, 2);
    assert.equal((generated.declarations.match(/texture2D\(/g) ?? []).length, 4);
    assert(Object.isFrozen(handle.graph) && Object.isFrozen(handle.plan));
    assert.equal(handle.recipe, null);
    f.dispose();
  });

  test(`r${THREE.REVISION}: topology changes and cached A→B→A returns use current uniform bindings`, () => {
    const f = fixture(THREE), handle = f.system.createMaterial(layered());
    // Mirrors Three's documented material-program cache boundary: a cached key
    // skips onBeforeCompile and retains the most recently compiled dictionary.
    const cached = new Set(); let currentUniforms, compiles = 0;
    function renderBindings() {
      const key = handle.material.customProgramCacheKey();
      if (!cached.has(key)) {cached.add(key); currentUniforms = shaderFor(THREE, handle).uniforms; compiles++;}
      for (const binding of graphUniformValues(handle.plan)) {
        assert(currentUniforms[binding.name], `Cached program missing ${binding.name}`);
        assert.deepEqual(uniformValue(currentUniforms[binding.name].value), binding.value);
      }
    }
    const graphA = handle.graph, keyA = handle.material.customProgramCacheKey(), version = handle.material.version;
    renderBindings();
    // B has fewer nodes: returning A must still supply all of A's old slots.
    handle.setGraph(surface.channels(surface.paint('velvet'), {roughness: scalar.add(scalar.axis('x'), .2)}));
    const keyB = handle.material.customProgramCacheKey();
    assert.notEqual(keyB, keyA); assert.equal(handle.material.version, version + 1);
    renderBindings();
    const changedA = copy(graphA);
    changedA.nodes.find(n => n.kind === 'parameter').value = .17;
    const changedPaint = changedA.nodes.find(n => n.kind === 'paint');
    changedA.nodes.find(n => n.id === changedPaint.palette.base).value = color.srgb('#234567').value;
    handle.setGraph(changedA);
    assert.equal(handle.material.customProgramCacheKey(), keyA);
    assert.equal(handle.material.version, version + 2);
    renderBindings(); assert.equal(compiles, 2);
    // Editing a non-folded literal also changes generated code and cache key.
    handle.setGraph(surface.channels(surface.paint('velvet'), {roughness: scalar.add(scalar.axis('x'), .3)}));
    assert.notEqual(handle.material.customProgramCacheKey(), keyB);
    assert.equal(handle.material.version, version + 3);
    renderBindings(); assert.equal(compiles, 3);
    f.dispose();
  });

  test(`r${THREE.REVISION}: canonical recipes lower to graphs and presets remain numeric edits`, () => {
    const f = fixture(THREE), handle = f.system.createMaterial('moonstone');
    const shader = shaderFor(THREE, handle), key = handle.material.customProgramCacheKey(), version = handle.material.version;
    assert.equal(handle.plan.nodes.filter(n => n.kind === 'facets').length, 1);
    assert.equal(handle.plan.nodes.filter(n => n.kind === 'paint').length, 1);
    assert.equal(handle.material.roughness, 1); assert.equal(handle.material.metalness, 1); assert.equal(handle.material.opacity, 1);
    handle.update({palette: {base: color.srgb('#808080')}, style: {clearcoat: 0, roughness: .3}});
    assert.deepEqual(handle.recipe.palette.base.value, color.srgb('#808080').value);
    const paint = handle.plan.nodes.find(n => n.kind === 'paint');
    const baseBinding = graphUniformValues(handle.plan).find(binding => binding.id === paint.palette.base && binding.field === 'value');
    const channel = shader.uniforms[baseBinding.name].value.x;
    assert(Math.abs(channel - .21586050011389926) < 1e-12);
    handle.update('carapace');
    assert.equal(handle.material.version, version);
    assert.equal(handle.material.customProgramCacheKey(), key);
    assert.equal(handle.material.clearcoat, 1);
    assert.throws(() => handle.material.clone(), /createMaterial/);
    handle.setGraph(layered()); assert.equal(handle.recipe, null);
    assert.throws(() => handle.update({style: {roughness: .6}}), /setGraph/);
    handle.update('horn'); assert(handle.recipe); assert.equal(handle.plan.cost.paintSamples, 1);
    f.dispose();
  });

  test(`r${THREE.REVISION}: invalid graphs and opacity changes cannot partially mutate a live material`, () => {
    const f = fixture(THREE), handle = f.system.createMaterial(layered());
    const shader = shaderFor(THREE, handle);
    const before = {graph: handle.graph, plan: handle.plan, key: handle.material.customProgramCacheKey(), version: handle.material.version,
      values: graphUniformValues(handle.plan)};
    const bad = copy(handle.graph); bad.nodes.find(n => n.kind === 'ramp').high = -100;
    const opacity = copy(handle.graph); opacity.nodes.find(n => n.kind === 'paint').style.opacity = .7;
    for (const graph of [bad, opacity]) assert.throws(() => handle.setGraph(graph));
    assert.equal(handle.graph, before.graph); assert.equal(handle.plan, before.plan);
    assert.equal(handle.material.customProgramCacheKey(), before.key); assert.equal(handle.material.version, before.version);
    for (const binding of before.values) assert.deepEqual(uniformValue(shader.uniforms[binding.name].value), binding.value);
    const field = facets();
    const opaqueEndpoint = materialGraph(surface.mix(surface.paint(field), surface.paint(field, {opacity: .2}), scalar.parameter(0)));
    const endpointHandle = f.system.createMaterial(opaqueEndpoint);
    const moved = copy(opaqueEndpoint); moved.nodes.find(n => n.kind === 'parameter').value = .1;
    assert.throws(() => endpointHandle.setGraph(moved), /transparent/);
    const transparent = f.system.createMaterial(opaqueEndpoint, {transparent: true});
    transparent.setGraph(moved);
    assert.equal(transparent.material.depthWrite, false);
    assert.equal(transparent.plan.opacityRange[0], .92);
    f.dispose();
  });

  test(`r${THREE.REVISION}: different uniform types at the same canonical node stay isolated in both topology orders`, () => {
    const graphA = surface.mix(surface.paint('horn'), surface.paint('carapace'), scalar.parameter(.5));
    const graphB = surface.channels(surface.paint('horn'), {roughness: scalar.facing([0, 0, 1])});
    // In A, n2.direction is a facet vec2; in B it is a facing vec3.
    for (const [first, second] of [[graphA, graphB], [graphB, graphA]]) {
      const f = fixture(THREE), handle = f.system.createMaterial(first);
      const firstShader = shaderFor(THREE, handle);
      const firstBindings = graphUniformValues(handle.plan);
      handle.setGraph(second);
      const secondShader = shaderFor(THREE, handle);
      for (const binding of graphUniformValues(handle.plan)) {
        assert.deepEqual(uniformValue(secondShader.uniforms[binding.name].value), binding.value);
      }
      handle.setGraph(first);
      for (const binding of firstBindings) {
        assert.equal(firstShader.uniforms[binding.name], secondShader.uniforms[binding.name]);
        assert.deepEqual(uniformValue(secondShader.uniforms[binding.name].value), binding.value);
      }
      f.dispose();
    }
  });

  test(`r${THREE.REVISION}: shader anchors support both coordinate frames and fail atomically`, () => {
    const f = fixture(THREE);
    for (const coordinates of ['local', 'attribute']) {
      const handle = f.system.createMaterial(layered(), {coordinates});
      const shader = shaderFor(THREE, handle);
      assert(shader.vertexShader.includes(`vMoonweavePosition = ${coordinates === 'local' ? 'position' : 'aMoonweavePosition'}`));
      assert(shader.fragmentShader.indexOf('MoonweaveSurface mwSurface = moonweaveGraph();') < shader.fragmentShader.indexOf('#include <clipping_planes_fragment>'));
      const broken = freshShader(THREE);
      broken.fragmentShader = broken.fragmentShader.replace('#include <metalnessmap_fragment>', 'unsupported chunk');
      const snapshot = {...broken};
      assert.throws(() => patchTexturingShader(broken, {unexpected: {value: 1}}, coordinates, handle.plan), /exactly one/);
      assert.equal(broken.vertexShader, snapshot.vertexShader); assert.equal(broken.fragmentShader, snapshot.fragmentShader);
      assert.deepEqual(broken.uniforms, {});
    }
    f.dispose();
  });

  test(`r${THREE.REVISION}: affine domain uniforms use the inverse transpose`, () => {
    const matrix = new THREE.Matrix4().set(2, .7, 0, .2, 0, 1, .3, -.1, .4, 0, .5, 2, 0, 0, 0, 1);
    const plan = compileGraph(surface.paint('horn', {domain: domain.transform(matrix.elements)}));
    const actual = graphUniformValues(plan).find(binding => binding.name.endsWith('_normalMatrix')).value;
    const expected = new THREE.Matrix3().getNormalMatrix(matrix).elements;
    actual.forEach((value, i) => assert(Math.abs(value - expected[i]) < 1e-12));
  });

  test(`r${THREE.REVISION}: rest-coordinate binding preserves sources and commits only validated attributes`, () => {
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(new Float32Array([1, 2, 3, -1, 0, 2]), 3);
    const normal = new THREE.BufferAttribute(new Float32Array([1, 1, 0, 0, 0, 1]), 3);
    geometry.setAttribute('position', position); geometry.setAttribute('normal', normal);
    geometry.setIndex([0, 1]); const index = geometry.index;
    const matrix = new THREE.Matrix4().set(2, .5, 0, 1, 0, 3, 0, -2, 0, 0, .5, .3, 0, 0, 0, 1);
    assert.equal(bindSurfaceCoordinates(THREE, geometry, {matrix}), geometry);
    const mapped = geometry.getAttribute('aMoonweavePosition'), mappedNormal = geometry.getAttribute('aMoonweaveNormal');
    assert.equal(geometry.getAttribute('position'), position); assert.equal(geometry.getAttribute('normal'), normal); assert.equal(geometry.index, index);
    for (let i = 0; i < 2; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix);
      const n = new THREE.Vector3().fromBufferAttribute(normal, i).applyMatrix3(new THREE.Matrix3().getNormalMatrix(matrix)).normalize();
      assert.deepEqual([...mapped.array.slice(i * 3, i * 3 + 3)], p.toArray().map(Math.fround));
      assert.deepEqual([...mappedNormal.array.slice(i * 3, i * 3 + 3)], n.toArray().map(Math.fround));
    }
    normal.setXYZ(1, 0, 0, 0);
    assert.throws(() => bindSurfaceCoordinates(THREE, geometry, {matrix}), /zero normal/);
    assert.equal(geometry.getAttribute('aMoonweavePosition'), mapped); assert.equal(geometry.getAttribute('aMoonweaveNormal'), mappedNormal);
    geometry.dispose();
  });
}

test('graph validation and explicit shader budgets run before any texture or material allocation', () => {
  let textures = 0, materials = 0;
  class CountedTexture extends Current.DataTexture {constructor(...args) {super(...args); textures++;}}
  class CountedMaterial extends Current.MeshPhysicalMaterial {constructor(...args) {super(...args); materials++;}}
  const system = createTexturingSystem({...Current, DataTexture: CountedTexture, MeshPhysicalMaterial: CountedMaterial});
  assert.equal(system.fields.top, null);
  assert.throws(() => system.createMaterial({nodes: [], output: 'bad', version: 1}));
  assert.throws(() => system.createMaterial({style: {opacity: .5}}), /transparent/);
  let tooManyFields = surface.paint();
  for (let i = 0; i < 8; i++) tooManyFields = surface.mix(tooManyFields, surface.paint(), scalar.parameter(.5));
  assert.throws(() => system.createMaterial(tooManyFields), /8 facet fields/);
  const shared = facets(); let tooManyPaints = surface.paint(shared);
  for (let i = 0; i < 16; i++) tooManyPaints = surface.mix(tooManyPaints, surface.paint(shared), scalar.parameter(.5));
  assert.throws(() => system.createMaterial(tooManyPaints), /16 paint styles/);
  assert.equal(textures, 0); assert.equal(materials, 0); assert.equal(system.fields.bytes, 0);
  system.dispose();
});

test('resource ownership survives listener errors, borrowers and repeated handle disposal', () => {
  const f = fixture(Current), pair = f.fields.ensure(); let materialDisposals = 0, textureDisposals = 0;
  for (const texture of [pair.top, pair.wall]) texture.addEventListener('dispose', () => textureDisposals++);
  const handles = Array.from({length: 20}, (_, i) => f.system.createMaterial(i % 2 ? 'horn' : 'moonstone'));
  for (const handle of handles) handle.material.addEventListener('dispose', () => materialDisposals++);
  handles[0].material.addEventListener('dispose', () => {throw new Error('material disposal listener');});
  assert.throws(() => f.system.dispose(), error => error instanceof AggregateError && error.errors.length === 1);
  assert.equal(materialDisposals, 20); assert.equal(textureDisposals, 0); assert(!f.fields.disposed);
  assert(handles.every(h => h.disposed)); assert(f.system.disposed);
  assert.doesNotThrow(() => f.system.dispose()); assert.doesNotThrow(() => handles[0].dispose());
  assert.throws(() => handles[1].setGraph(surface.paint()), /disposed/);
  f.fields.dispose(); assert.equal(textureDisposals, 2);
  const owned = createTexturingSystem(Current), a = owned.createMaterial(), b = owned.createMaterial();
  a.material.addEventListener('dispose', () => {throw new Error('owned material listener');});
  let bDisposed = false; b.material.addEventListener('dispose', () => {bDisposed = true;});
  assert.throws(() => owned.dispose(), AggregateError);
  assert(bDisposed && owned.fields.disposed && a.disposed && b.disposed);
  assert.doesNotThrow(() => owned.dispose());
});

test('pure core never imports the mutable engine adapter or shader injector', () => {
  const visited = new Set();
  function visit(url) {
    if (visited.has(url.href)) return; visited.add(url.href);
    const source = readFileSync(url, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert(match[1].startsWith('.'), `Unexpected external core dependency: ${match[1]}`);
      visit(new URL(match[1], url));
    }
  }
  visit(new URL('../src/core.mjs', import.meta.url));
  for (const name of visited) assert.doesNotMatch(name, /\/three\//);
});
