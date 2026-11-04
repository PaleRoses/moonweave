import test from 'node:test';
import assert from 'node:assert/strict';
import * as Effect from 'effect/Effect';
import {createGraphicsSession, graphicsMessage} from '../lab/graphics-session.ts';

// Event/factory doubles exercise lifecycle ordering and fault classification.
// These checks do not create a GPU context or establish browser rendering support.
class CanvasDouble extends EventTarget {
  constructor({context = {lost: false, isContextLost() {return this.lost;}}, reason, contextError} = {}) {
    super(); this.context = context; this.reason = reason; this.contextError = contextError; this.requests = [];
  }
  getContext(name, attributes) {
    this.requests.push({name, attributes});
    if (this.reason) {
      const event = new Event('webglcontextcreationerror');
      Object.defineProperty(event, 'statusMessage', {value: this.reason});
      this.dispatchEvent(event);
    }
    if (this.contextError) throw this.contextError;
    return this.context;
  }
  lose() {
    this.context.lost = true;
    const event = new Event('webglcontextlost', {cancelable: true});
    this.dispatchEvent(event); return event;
  }
  restore() {
    this.context.lost = false;
    this.dispatchEvent(new Event('webglcontextrestored'));
  }
}

function fixture(options = {}) {
  const canvas = new CanvasDouble(options), renderers = [], profiles = [], events = [], changes = [];
  let session;
  session = createGraphicsSession({
    canvas,
    createRenderer(context) {
      if (options.createError) throw options.createError;
      const renderer = {
        id: renderers.length + 1, debug: {}, renders: [], disposals: 0, releases: 0,
        getContext: () => context,
        render(scene, camera) {
          this.renders.push({scene, camera}); events.push(`render:${this.id}`);
          options.render?.(this, scene, camera);
        },
        dispose() {
          this.disposals++; events.push(`dispose:${this.id}`);
          canvas.removeEventListener('webglcontextrestored', restored);
          options.disposeRenderer?.(this);
        },
      };
      const restored = () => {events.push(`engine-restored:${renderer.id}`); options.engineRestored?.(renderer);};
      canvas.addEventListener('webglcontextrestored', restored);
      renderers.push(renderer); events.push(`create:${renderer.id}`);
      return renderer;
    },
    prepare(renderer, profile) {
      return Effect.acquireRelease(
        Effect.sync(() => {
          profiles.push(profile); events.push(`prepare:${renderer.id}:${profile}`);
          options.prepare?.(renderer, profile);
          return renderer;
        }),
        current => Effect.sync(() => {
          current.releases++; events.push(`release:${current.id}`);
          options.release?.(current);
        }),
      ).pipe(Effect.asVoid);
    },
    onChange(state) {changes.push({...state, canRender: session?.canRender});},
  });
  return {session, canvas, renderers, profiles, events, changes};
}

function shaderFailure(renderer) {
  const gl = {
    getProgramInfoLog: () => 'link diagnostic',
    getShaderInfoLog: shader => `${shader} diagnostic`,
  };
  renderer.debug.onShaderError(gl, 'program', 'vertex', 'fragment');
}

test('a denied WebGL2 context records the browser reason and does not construct a renderer', () => {
  const f = fixture({context: null, reason: 'WebGL2 blocked by this environment'});
  assert.equal(f.session.state.status, 'idle');
  assert.equal(f.session.start(), false);
  assert.equal(f.session.state.status, 'unavailable'); assert.equal(f.session.state.phase, 'context');
  assert.equal(f.session.state.creationMessage, 'WebGL2 blocked by this environment');
  assert.equal(f.renderers.length, 0); assert.equal(f.profiles.length, 0);
  assert.equal(f.session.available, false); assert.equal(f.session.canRender, false);
  assert.equal(f.session.render({}, {}), false);
  assert.equal(f.canvas.requests.length, 1); assert.equal(f.canvas.requests[0].name, 'webgl2');
  assert.match(graphicsMessage(f.session.state).message, /could not obtain WebGL2/);
  f.session.dispose();
});

test('availability starts after a successful first frame and repeated renders reuse the renderer', () => {
  const f = fixture(), scene = {surface: 'preserved'}, camera = {view: 'preserved'};
  assert.equal(f.session.start(), true);
  assert.equal(f.session.state.status, 'starting'); assert.equal(f.session.state.phase, 'first-frame');
  assert.equal(f.session.available, false); assert.equal(f.session.canRender, true);
  assert.equal(f.changes.find(state => state.phase === 'context').canRender, false);
  const generation = f.session.generation;
  for (let i = 0; i < 5; i++) assert.equal(f.session.render(scene, camera), true);
  assert.equal(f.session.state.status, 'ready'); assert.equal(f.session.available, true);
  assert.equal(f.session.generation, generation); assert.equal(f.renderers.length, 1);
  assert.deepEqual(f.profiles, ['standard']); assert.equal(f.canvas.requests.length, 1);
  for (const call of f.renderers[0].renders) {assert.equal(call.scene, scene); assert.equal(call.camera, camera);}
  f.session.dispose();
  assert.equal(f.renderers[0].releases, 1); assert.equal(f.renderers[0].disposals, 1);
});

for (const [phase, options] of [
  ['context', {contextError: new Error('context API failed')}],
  ['renderer', {createError: new Error('renderer setup bug')}],
  ['prepare', {prepare() {throw new Error('environment setup bug');}}],
]) {
  test(`${phase} initialization failure retains its actual failure boundary`, () => {
    const f = fixture(options);
    assert.equal(f.session.start(), false);
    assert.equal(f.session.state.status, phase === 'context' ? 'unavailable' : 'failed');
    assert.equal(f.session.state.phase, phase);
    assert.equal(f.session.canRender, false); assert.equal(f.session.render({}, {}), false);
    if (phase !== 'context') assert.match(graphicsMessage(f.session.state).message, /WebGL2 was available/);
    f.session.dispose();
    for (const renderer of f.renderers) assert.equal(renderer.disposals, 1);
  });
}

for (const phase of ['prepare', 'render']) {
  test(`shader diagnostics during ${phase} are reported as shader failures`, () => {
    const f = fixture({[phase]: renderer => shaderFailure(renderer)});
    if (phase === 'prepare') assert.equal(f.session.start(), false);
    else {assert.equal(f.session.start(), true); assert.equal(f.session.render({}, {}), false);}
    assert.equal(f.session.state.status, 'failed'); assert.equal(f.session.state.phase, 'shader');
    assert.deepEqual(f.session.state.error.logs, {program: 'link diagnostic', vertex: 'vertex diagnostic', fragment: 'fragment diagnostic'});
    assert.equal(f.session.available, false); assert.equal(f.session.render({}, {}), false);
    assert.match(graphicsMessage(f.session.state).title, /shader failed/);
    f.session.dispose();
  });
}

test('a render exception closes the render/capture gate until an explicit retry', () => {
  let broken = false;
  const f = fixture({render() {if (broken) throw new Error('draw bug');}});
  f.session.start(); assert.equal(f.session.render({}, {}), true);
  const generation = f.session.generation;
  broken = true; assert.equal(f.session.render({}, {}), false);
  assert.equal(f.session.state.status, 'failed'); assert.equal(f.session.state.phase, 'render');
  assert.equal(f.session.state.error.message, 'draw bug'); assert(f.session.generation > generation);
  assert.equal(f.session.available, false); assert.equal(f.session.canRender, false);
  assert.equal(f.session.render({}, {}), false); assert.equal(f.renderers[0].renders.length, 2);
  broken = false; assert.equal(f.session.start(), true); assert.equal(f.session.render({}, {}), true);
  assert.equal(f.renderers[0].releases, 1); assert.equal(f.renderers[0].disposals, 1);
  f.session.dispose();
});

test('loss blocks rendering and restoration rebuilds after all event listeners while retaining scene data', async () => {
  const f = fixture(), scene = {material: {graph: 'accepted graph'}}, camera = {position: [1, 2, 3]};
  f.session.start(); f.session.render(scene, camera);
  const before = f.session.generation, event = f.canvas.lose();
  assert.equal(event.defaultPrevented, true); assert.equal(f.session.state.status, 'lost');
  assert.equal(f.session.available, false); assert.equal(f.session.canRender, false);
  assert.equal(f.session.render(scene, camera), false); assert.equal(f.renderers[0].renders.length, 1);
  assert(f.session.generation > before);
  assert.equal(f.session.start('reduced'), false); assert.equal(f.session.state.profile, 'reduced');
  assert.equal(f.renderers.length, 1);
  f.canvas.addEventListener('webglcontextrestored', () => f.events.push('last-restored-listener'));
  f.canvas.restore();
  assert.equal(f.renderers.length, 1); assert.equal(f.session.state.status, 'lost');
  assert(f.events.includes('engine-restored:1')); assert(f.events.includes('last-restored-listener'));
  await Promise.resolve();
  assert.equal(f.renderers.length, 2); assert.deepEqual(f.profiles, ['standard', 'reduced']);
  assert(f.events.indexOf('create:2') > f.events.indexOf('last-restored-listener'));
  assert.equal(f.renderers[0].releases, 1); assert.equal(f.renderers[0].disposals, 1);
  assert.equal(f.session.state.status, 'starting'); assert.equal(f.session.available, false);
  assert.equal(f.session.render(scene, camera), true);
  assert.equal(f.renderers[1].renders[0].scene, scene); assert.equal(f.renderers[1].renders[0].camera, camera);
  assert.equal(f.session.available, true); f.session.dispose();
});

test('a context lost during a render is not accepted as a successful frame', () => {
  const f = fixture({render(renderer) {renderer.getContext().lost = true;}});
  f.session.start(); assert.equal(f.session.render({}, {}), false);
  assert.equal(f.session.state.status, 'lost'); assert.equal(f.session.available, false);
  assert.equal(f.session.render({}, {}), false); assert.equal(f.renderers[0].renders.length, 1);
  f.session.dispose();
});

test('disposal invalidates a queued restoration and removes the context listeners', async () => {
  const f = fixture(); f.session.start(); f.session.render({}, {});
  f.canvas.lose(); f.canvas.restore();
  f.session.dispose(); const generation = f.session.generation, count = f.changes.length;
  await Promise.resolve();
  assert.equal(f.renderers.length, 1); assert.equal(f.renderers[0].releases, 1); assert.equal(f.renderers[0].disposals, 1);
  assert.equal(f.session.state.status, 'disposed'); assert.equal(f.session.available, false);
  assert.equal(f.session.canRender, false); assert.equal(f.session.render({}, {}), false); assert.equal(f.session.start(), false);
  const event = f.canvas.lose(); f.canvas.restore(); await Promise.resolve();
  assert.equal(event.defaultPrevented, false); assert.equal(f.changes.length, count); assert.equal(f.session.generation, generation);
  f.session.dispose(); assert.equal(f.renderers[0].disposals, 1);
});

test('explicit profile retries release previous resources and the selected profile remains the default', () => {
  const f = fixture();
  f.session.start(); f.session.render({}, {});
  f.session.start('reduced'); f.session.render({}, {});
  f.session.start(); f.session.render({}, {});
  assert.deepEqual(f.profiles, ['standard', 'reduced', 'reduced']);
  assert.equal(f.renderers.length, 3); assert.equal(f.session.state.profile, 'reduced');
  for (const renderer of f.renderers.slice(0, 2)) {assert.equal(renderer.releases, 1); assert.equal(renderer.disposals, 1);}
  assert(f.events.indexOf('create:2') > f.events.indexOf('dispose:1'));
  assert(f.events.indexOf('create:3') > f.events.indexOf('dispose:2'));
  f.session.dispose();
});

test('retry cleanup failures dispose the renderer and are not labeled as unavailable WebGL', () => {
  const f = fixture({release(renderer) {if (renderer.id === 1) throw new Error('environment cleanup failed');}});
  f.session.start(); f.session.render({}, {});
  assert.equal(f.session.start('reduced'), false);
  assert.equal(f.session.state.status, 'failed'); assert.equal(f.session.state.phase, 'release');
  assert.equal(f.renderers[0].releases, 1); assert.equal(f.renderers[0].disposals, 1);
  assert.equal(f.session.renderer, null); assert.equal(f.session.canRender, false);
  assert.equal(f.session.start(), true); assert.equal(f.session.state.profile, 'reduced');
  f.session.dispose();
});

test('a disposal error still leaves the session terminal and cannot revive released resources', () => {
  const f = fixture({release() {throw new Error('environment cleanup failed');}});
  f.session.start(); f.session.render({}, {});
  assert.throws(() => f.session.dispose(), /environment cleanup failed/);
  assert.equal(f.renderers[0].releases, 1); assert.equal(f.renderers[0].disposals, 1); assert.equal(f.session.renderer, null);
  assert.equal(f.session.state.status, 'disposed'); assert.equal(f.session.canRender, false); assert.equal(f.session.available, false);
  assert.equal(f.session.render({}, {}), false); assert.equal(f.session.start(), false);
  assert.doesNotThrow(() => f.session.dispose());
});
