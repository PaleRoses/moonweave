import * as THREE from 'three';
import {mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';
import {bindSurfaceCoordinates} from '@moonweave/surfaces/three';

/** @type {import('@moonweave/surfaces/three').CoordinateEngine} */
const coordinateEngine = {
  Matrix4: THREE.Matrix4, Matrix3: THREE.Matrix3,
  BufferAttribute: THREE.BufferAttribute, Vector3: THREE.Vector3,
};

/** Geometry belongs to the atelier, never to the material library. */
function surface(uCount, vCount, sample) {
  const positions = [], indices = [];
  for (let j = 0; j <= vCount; j++) {
    for (let i = 0; i <= uCount; i++) positions.push(...sample(i / uCount, j / vCount));
  }
  for (let j = 0; j < vCount; j++) for (let i = 0; i < uCount; i++) {
    const a = j * (uCount + 1) + i, b = a + uCount + 1;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  // Weld the angular seam and collapsed poles before averaging normals. A
  // duplicated pole otherwise leaves isolated zero-area triangles with no normal.
  const welded = mergeVertices(geometry, 1e-7);
  geometry.dispose();
  welded.computeVertexNormals();
  return welded;
}

function shellGeometry() {
  return surface(96, 64, (u, v) => {
    const a = u * Math.PI * 2, t = v * Math.PI;
    const breadth = Math.pow(Math.sin(t), .68) * (1.02 - v * .24);
    const keel = 1 + .085 * Math.cos(5 * a) * Math.sin(t) ** 2;
    return [Math.cos(a) * breadth * keel, (v - .5) * 3.65,
      Math.sin(a) * breadth * .69 * keel + .2 * Math.sin(t * 1.3)];
  });
}

function hornGeometry() {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-.85, -1.48, 0), new THREE.Vector3(-.77, -.42, .08),
    new THREE.Vector3(-.14, .65, -.04), new THREE.Vector3(.85, 1.24, -.15),
    new THREE.Vector3(1.3, 2.02, -.28),
  ]);
  const frames = curve.computeFrenetFrames(120, false);
  return surface(64, 120, (u, v) => {
    const p = curve.getPointAt(v), f = Math.min(120, Math.round(v * 120));
    const a = u * Math.PI * 2 + v * 1.8;
    const radius = .58 * (1 - v) ** .78 + .003;
    const fluting = 1 + .055 * Math.cos(7 * a + v * 11) * (1 - v);
    p.addScaledVector(frames.normals[f], Math.cos(a) * radius * fluting);
    p.addScaledVector(frames.binormals[f], Math.sin(a) * radius * fluting);
    return p.toArray();
  });
}

function membraneGeometry() {
  return surface(100, 56, (u, v) => {
    const x = (u - .5) * 4.1, y = (v - .5) * 2.9;
    const gathered = Math.sin(u * Math.PI) ** .4;
    const folds = Math.sin(u * Math.PI * 5.6 + v * 1.1) * (.12 + .26 * v);
    return [x, y * (.72 + .28 * gathered), folds + .26 * Math.sin(v * Math.PI) + .12 * x * x];
  });
}

const SPECIMENS = Object.freeze({
  shell: {label: 'Carapace', subtitle: 'Curved plates · one continuous field', number: '01'},
  horn: {label: 'Swept horn', subtitle: 'Elongated form · directional pigment', number: '02'},
  membrane: {label: 'Membrane', subtitle: 'Gathered folds · paint in the rest pose', number: '03'},
  joined: {label: 'Joined forms', subtitle: 'Two meshes · a shared texture frame', number: '04'},
  sphere: {label: 'Sphere', subtitle: 'Neutral form · inspect the surface', number: '05'},
});

function createSpecimen(kind, material) {
  if (!Object.hasOwn(SPECIMENS, kind)) throw new RangeError('Unknown specimen.');
  const group = new THREE.Group();
  const add = (geometry, position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0]) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.fromArray(position); mesh.scale.fromArray(scale); mesh.rotation.set(...rotation);
    mesh.updateMatrix();
    bindSurfaceCoordinates(coordinateEngine, geometry, {matrix: mesh.matrix});
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  if (kind === 'shell') {
    add(shellGeometry(), [0, .12, .22], [1.05, 1, 1]);
    add(shellGeometry(), [-.85, -.24, -.1], [.56, .78, .72], [0, -.42, -.26]);
    add(shellGeometry(), [.85, -.24, -.1], [.56, .78, .72], [0, .42, .26]);
  } else if (kind === 'horn') {
    add(hornGeometry());
  } else if (kind === 'membrane') {
    add(membraneGeometry(), [0, .15, 0], [1, 1, 1], [0, .16, 0]);
  } else if (kind === 'joined') {
    // Both halves derive from the same sphere. Baked receiver coordinates meet
    // exactly at the meridian even though each half has a different local frame.
    const radius = 1.55;
    for (let half = 0; half < 2; half++) {
      const geometry = new THREE.SphereGeometry(radius, 64, 64, half * Math.PI, Math.PI);
      const offset = half ? .6 : -.6;
      geometry.translate(-offset, 0, 0);
      add(geometry, [offset, .05, 0]);
    }
  } else {
    add(new THREE.SphereGeometry(1.55, 96, 64), [0, .05, 0]);
  }
  const geometries = group.children.map(mesh => mesh.geometry);
  let disposed = false;
  return {
    group, kind,
    get triangles() { return geometries.reduce((sum, g) => sum + g.index.count / 3, 0); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const geometry of geometries) geometry.dispose();
      group.removeFromParent();
    },
  };
}

export {SPECIMENS, createSpecimen};
