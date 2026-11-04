import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {BufferGeometry, MeshStandardMaterial} from 'three';
import {renderers} from './fixtures/stage-three.mjs';

const stageURL = new URL('../lab/stage.ts', import.meta.url).href;
const rendererDoubleURL = new URL('./fixtures/stage-three.mjs', import.meta.url).href;
const hooks = registerHooks({resolve(specifier, context, nextResolve) {
  return specifier === 'three' && context.parentURL === stageURL
    ? {url: rendererDoubleURL, shortCircuit: true}
    : nextResolve(specifier, context);
}});
const {createStage} = await import(stageURL);
hooks.deregister();

// BufferGeometry IDs count real constructions, including geometry that is
// subsequently disposed. These checks exercise no GPU implementation.
function geometryCounter() {
  const marker = new BufferGeometry(), id = marker.id;
  marker.dispose();
  return id;
}

function browserDouble() {
  const frames = new Map(), document = new EventTarget();
  let nextFrame = 0;
  document.hidden = false;
  document.defaultView = {
    devicePixelRatio: 1, performance,
    requestAnimationFrame(callback) {const id = ++nextFrame; frames.set(id, callback); return id;},
    cancelAnimationFrame(id) {frames.delete(id);},
    navigator: {userAgent: 'Stage lifecycle test'},
  };
  const canvas = new EventTarget();
  canvas.ownerDocument = document; canvas.style = {}; canvas.blocked = true;
  const context = {lost: false, isContextLost() {return this.lost;}};
  canvas.getContext = () => canvas.blocked ? null : context;
  return {
    canvas, context, viewport: {clientWidth: 640, clientHeight: 480},
    draw() {const pending = [...frames.values()]; frames.clear(); for (const frame of pending) frame(16);},
    lose() {context.lost = true; canvas.dispatchEvent(new Event('webglcontextlost', {cancelable: true}));},
    restore() {context.lost = false; canvas.dispatchEvent(new Event('webglcontextrestored'));},
  };
}

function observe(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const observers = [];
  class ResizeObserver {
    constructor() {this.disconnected = false; observers.push(this);}
    observe() {}
    disconnect() {this.disconnected = true;}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {configurable: true, value: ResizeObserver});
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  });
  return observers;
}

test('blocked WebGL builds no geometry or material atlas, including offline selection changes', t => {
  const observers = observe(t), browser = browserDouble(), states = [];
  let materials = 0;
  const before = geometryCounter(), rendererCount = renderers.length;
  const stage = createStage({...browser, version: 'test', onChange: value => states.push(value),
    prepareMaterial() {materials++; throw new Error('must not allocate an atlas');},
  });
  assert.equal(stage.state.graphics.status, 'unavailable');
  assert.equal(stage.snapshot().triangles, 0);
  stage.selectSpecimen('horn'); stage.selectSpecimen('sphere'); stage.resetView();
  assert.equal(stage.state.specimen, 'sphere');
  assert.equal(geometryCounter(), before + 1);
  assert.equal(materials, 0); assert.equal(renderers.length, rendererCount);
  stage.dispose(); stage.dispose();
  assert.equal(stage.state.graphics.status, 'disposed');
  assert(observers.every(observer => observer.disconnected));
});

test('a successful retry builds the latest selection once and keeps scene geometry across renderer retries', async t => {
  observe(t);
  const browser = browserDouble(), material = new MeshStandardMaterial();
  let materialRequests = 0, materialDisposals = 0;
  material.addEventListener('dispose', () => materialDisposals++);
  const stage = createStage({...browser, version: 'test', onChange() {},
    prepareMaterial() {materialRequests++; return material;},
  });
  stage.selectSpecimen('horn'); stage.selectSpecimen('sphere');
  const before = geometryCounter();
  browser.canvas.blocked = false;
  assert.equal(stage.retry('reduced'), true);
  browser.draw();
  assert.equal(stage.available, true); assert.equal(stage.state.specimen, 'sphere');
  assert.equal(geometryCounter(), before + 3, 'only one floor and the latest sphere are constructed');
  assert.equal(materialRequests, 1);
  const firstRenderer = renderers.at(-1), scene = firstRenderer.scenes[0];
  const firstGroup = scene.children.find(object => object.isGroup);
  const floor = scene.children.find(object => object.isMesh);
  assert.equal(firstGroup.children.length, 1);
  let oldGeometryDisposals = 0, floorDisposals = 0;
  firstGroup.children[0].geometry.addEventListener('dispose', () => oldGeometryDisposals++);
  floor.geometry.addEventListener('dispose', () => floorDisposals++);

  const retryStart = geometryCounter();
  stage.selectSpecimen('sphere');
  assert.equal(stage.retry('reduced'), true); browser.draw();
  assert.equal(geometryCounter(), retryStart + 1);
  assert.equal(firstRenderer.disposals, 1);
  assert.equal(renderers.at(-1).scenes[0], scene);
  assert.equal(scene.children.find(object => object.isGroup), firstGroup);
  assert.equal(oldGeometryDisposals, 0); assert.equal(floorDisposals, 0);

  const lostStart = geometryCounter();
  browser.lose(); stage.selectSpecimen('horn'); stage.selectSpecimen('joined');
  assert.equal(stage.state.graphics.status, 'lost');
  assert.equal(stage.state.specimen, 'joined');
  assert.equal(geometryCounter(), lostStart + 1, 'selection during loss stores intent without constructing geometry');
  browser.restore(); await Promise.resolve(); browser.draw();
  assert.equal(stage.available, true);
  const joinedGroup = scene.children.find(object => object.isGroup);
  assert.notEqual(joinedGroup, firstGroup); assert.equal(joinedGroup.children.length, 2);
  assert.equal(oldGeometryDisposals, 1); assert.equal(floorDisposals, 0);
  let joinedDisposals = 0;
  for (const mesh of joinedGroup.children) mesh.geometry.addEventListener('dispose', () => joinedDisposals++);
  stage.dispose(); stage.dispose();
  assert.equal(joinedDisposals, 2); assert.equal(floorDisposals, 1);
  assert.equal(materialDisposals, 0, 'the stage borrows its painted material');
  material.dispose();
});
