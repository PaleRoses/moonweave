import type {BufferGeometry, Matrix4} from 'three';
import type {CoordinateEngine} from './engine.mts';

export interface CoordinateOptions {readonly matrix?: Matrix4}

/**
 * Bake a shared rest frame into geometry once. Later object or skin transforms do
 * not change the sampled material coordinates. The two source attributes stay intact.
 */
export function bindSurfaceCoordinates(THREE: CoordinateEngine, geometry: BufferGeometry, options: CoordinateOptions = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => key !== 'matrix')) {
    throw new TypeError('Surface coordinates accept only a matrix option.');
  }
  if (!THREE?.Matrix4 || !THREE?.Matrix3 || !THREE?.BufferAttribute || !THREE?.Vector3) {
    throw new TypeError('Pass the Three.js module namespace.');
  }
  if (!geometry?.getAttribute || !geometry?.setAttribute) throw new TypeError('Expected a BufferGeometry.');
  const matrix = options.matrix ?? new THREE.Matrix4();
  const elements = matrix.elements;
  if (!('isMatrix4' in matrix) || !matrix.isMatrix4 || !elements || elements.length !== 16 || !elements.every(Number.isFinite)) {
    throw new TypeError('matrix must be a finite Three.js Matrix4.');
  }
  if (elements[3] !== 0 || elements[7] !== 0 || elements[11] !== 0 || elements[15] !== 1) {
    throw new RangeError('Surface coordinates require an affine matrix.');
  }
  const determinant = matrix.determinant();
  if (!Number.isFinite(determinant) || determinant === 0) throw new RangeError('Surface coordinate matrix must be non-singular.');
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  if (!positions || !normals || positions.itemSize !== 3 || normals.itemSize !== 3 || positions.count !== normals.count) {
    throw new TypeError('Geometry needs matching vec3 position and normal attributes.');
  }
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const mappedPositions = new Float32Array(positions.count * 3), mappedNormals = new Float32Array(positions.count * 3);
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    p.fromBufferAttribute(positions, i).applyMatrix4(matrix);
    n.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix);
    const normalLength = Math.hypot(n.x, n.y, n.z);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)
        || !Number.isFinite(normalLength) || normalLength === 0) {
      throw new RangeError(`Non-finite coordinates or zero normal at vertex ${i}.`);
    }
    n.multiplyScalar(1 / normalLength);
    p.toArray(mappedPositions, i * 3);
    n.toArray(mappedNormals, i * 3);
    if (!Number.isFinite(mappedPositions[i * 3]) || !Number.isFinite(mappedPositions[i * 3 + 1])
        || !Number.isFinite(mappedPositions[i * 3 + 2])) {
      throw new RangeError(`Surface coordinates exceed float32 range at vertex ${i}.`);
    }
  }
  // Validation completes before either live attribute is replaced.
  const mappedPositionAttribute = new THREE.BufferAttribute(mappedPositions, 3);
  const mappedNormalAttribute = new THREE.BufferAttribute(mappedNormals, 3);
  geometry.setAttribute('aMoonweavePosition', mappedPositionAttribute);
  geometry.setAttribute('aMoonweaveNormal', mappedNormalAttribute);
  return geometry;
}
