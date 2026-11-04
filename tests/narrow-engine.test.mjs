import test from 'node:test';
import assert from 'node:assert/strict';
import * as modern from 'three';
import * as legacy from 'three-legacy';
import {facets, domain, scalar, color, image, surface, materialGraph} from '../src/core.mjs';
import {createPaintTextures, createTexturingSystem, bindSurfaceCoordinates} from '../src/three.mjs';

const pick = (module, keys) => Object.fromEntries(keys.map(key => [key, module[key]]));
const textureKeys = ['DataTexture', 'RGBAFormat', 'UnsignedByteType', 'RepeatWrapping', 'LinearFilter', 'LinearMipmapLinearFilter'];
const materialKeys = ['MeshPhysicalMaterial', 'Vector2', 'Vector3', 'Vector4', 'Matrix3', 'Matrix4', 'FrontSide', 'BackSide', 'DoubleSide',
  'FloatType', 'NearestFilter', 'ClampToEdgeWrapping'];
const coordinateKeys = ['Matrix4', 'Matrix3', 'BufferAttribute', 'Vector3'];
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

for (const THREE of [legacy, modern]) {
  test(`Three r${THREE.REVISION} works with only the declared engine capabilities`, () => {
    const textureEngine = {
      ...pick(THREE, textureKeys),
      ...('NoColorSpace' in THREE ? {NoColorSpace: THREE.NoColorSpace} : {LinearEncoding: THREE.LinearEncoding}),
    };
    const materialEngine = {...textureEngine, ...pick(THREE, materialKeys)};
    const coordinateEngine = pick(THREE, coordinateKeys);
    const fields = createPaintTextures(textureEngine, {
      topData: new Uint8Array(512 * 512 * 4), wallData: new Uint8Array(512 * 512 * 4),
    });
    const system = createTexturingSystem(materialEngine, {fields});
    assert.equal('WebGLRenderer' in materialEngine, false);
    const frame = domain.transform(identity), field = facets({domain: frame});
    const gain = scalar.parameter(.7);
    const graph = materialGraph(surface.mix(surface.paint(field), surface.paint(field, 'horn'),
      scalar.multiply(scalar.ramp(scalar.facing([0, 1, 0], frame), 0, 1), gain)));
    const handle = system.createMaterial(graph, {coordinates: 'attribute'});
    const shader = {...THREE.ShaderLib.physical, uniforms: {}};
    handle.material.onBeforeCompile(shader);
    for (const name of ['Vector2', 'Vector3', 'Vector4', 'Matrix3', 'Matrix4']) {
      assert(Object.values(shader.uniforms).some(uniform => uniform.value instanceof THREE[name]), `${name} was bound`);
    }
    const version = handle.material.version;
    handle.patch({[graph.nodes.find(node => node.kind === 'parameter').id]: {value: .4}});
    assert.equal(handle.material.version, version);

    const pixels = image.generate({width: 4, height: 2, channels: 1}, (u, v) => u * v);
    const mapped = scalar.image(pixels, {filter: 'anisotropic', address: 'zero'});
    const imageHandle = system.createMaterial(surface.bump(surface.material(color.image(pixels, {
      filter: 'anisotropic', address: 'zero',
    })), mapped));
    const imageShader = {...THREE.ShaderLib.physical, uniforms: {}};
    imageHandle.material.onBeforeCompile(imageShader);
    const uploaded = Object.values(imageShader.uniforms).find(uniform => uniform.value?.name === 'Moonweave image field')?.value;
    assert(uploaded?.isDataTexture, 'the precise declared engine supports image resources');
    assert.equal(uploaded.type, THREE.FloatType);
    assert.deepEqual(uploaded.mipmaps.map(level => [level.width, level.height]), [[4, 2], [2, 1], [1, 1]]);
    assert.equal(imageHandle.plan.cost.textureReads, 64);

    const geometry = new THREE.SphereGeometry(1, 8, 8);
    const original = geometry.getAttribute('position').getX(0);
    bindSurfaceCoordinates(coordinateEngine, geometry, {matrix: new THREE.Matrix4().makeTranslation(1, 2, 3)});
    assert(Math.abs(geometry.getAttribute('aMoonweavePosition').getX(0) - original - 1) < 1e-6);
    assert.equal(geometry.getAttribute('aMoonweaveNormal').count, geometry.getAttribute('normal').count);
    geometry.dispose();

    let released = 0;
    for (const texture of [fields.top, fields.wall]) texture.addEventListener('dispose', () => released++);
    system.dispose();
    assert.equal(fields.disposed, false, 'the borrowed texture owner keeps its lifetime');
    fields.dispose();
    assert.equal(released, 2);
  });
}
